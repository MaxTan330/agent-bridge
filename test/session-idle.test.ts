import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Bridge } from '../src/bridge.ts';
import { Store } from '../src/store.ts';
import { baseConfigSchema } from '../src/config.ts';
import type { Inbound, Runtime } from '../src/types.ts';

const idle = 4 * 60 * 60 * 1000;
const message: Inbound = { account: 'a', chat: 'c', thread: 't', user: 'u', id: '1', text: 'work' };

test('session idle default is four hours', () => {
  assert.equal(baseConfigSchema.parse({ WORKSPACE_ROOT: '.' }).SESSION_IDLE_TIMEOUT_MS, idle);
});

test('session expiry survives restart and does not delete task results', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
  const path = join(mkdtempSync(join(tmpdir(), 'bridge-idle-')), 'test.db');
  let db = new Store(path);
  try {
    db.saveSession('key', 'old'); db.accept('task', 'key', 'message'); db.complete('task', 'completed', 'answer');
    db.close(); t.mock.timers.tick(idle - 1); db = new Store(path);
    assert.equal(db.session('key'), 'old');
    t.mock.timers.tick(1); assert.equal(db.session('key'), undefined);
    assert.equal(db.latestResult('key')!.text, 'answer');
  } finally { db.close(); t.mock.timers.reset(); }
});

test('legacy sessions without freshness timestamps are safely retired', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'bridge-legacy-')), 'test.db');
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, acp TEXT NOT NULL); INSERT INTO sessions VALUES ('key','legacy');");
  legacy.close();
  const db = new Store(path);
  try {
    assert.equal(db.session('key'), undefined);
    db.saveSession('key', 'fresh'); assert.equal(db.session('key'), 'fresh');
  } finally { db.close(); }
});

function fixture() {
  const db = new Store(':memory:'); const opened: (string | undefined)[] = []; let stops = 0;
  const runtime: Runtime = { async open(old) { opened.push(old); return old ?? `s-${opened.length}`; },
    async prompt() { return 'end_turn'; }, async cancel() {}, async stop() { stops++; } };
  const bridge = new Bridge(db, runtime, { async send() {} },
    { users: ['u'], admins: [], workspace: 'w', taskTimeout: idle * 2, cancelGrace: 10 });
  return { db, runtime, bridge, opened, stops: () => stops };
}

test('idle process is reclaimed at four hours, status does not refresh reuse, next task starts fresh', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1700000000000 });
  const f = fixture();
  try {
    await f.bridge.handle(message);
    t.mock.timers.tick(idle - 1); await nextTurn(); assert.equal(f.stops(), 0);
    await f.bridge.handle({ ...message, id: 'status', text: '/status' });
    t.mock.timers.tick(1); await nextTurn(); assert.equal(f.stops(), 1);
    assert.equal(f.db.session(f.bridge.key(message)), undefined);
    await f.bridge.handle({ ...message, id: '2' });
    assert.deepEqual(f.opened, [undefined, undefined]);
  } finally { await f.bridge.stop(); f.db.close(); t.mock.timers.reset(); }
});

test('continuous work reuses the session and idle timing starts after long execution finishes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1700000000000 });
  const f = fixture(); let finish!: () => void;
  try {
    await f.bridge.handle(message);
    t.mock.timers.tick(idle - 1); await nextTurn();
    f.runtime.prompt = async () => { await new Promise<void>(resolve => { finish = resolve; }); return 'end_turn'; };
    const run = f.bridge.handle({ ...message, id: 'long' }); await nextTurn();
    t.mock.timers.tick(idle + 1); await nextTurn(); assert.equal(f.stops(), 0);
    finish(); await run;
    f.runtime.prompt = async () => 'end_turn';
    await f.bridge.handle({ ...message, id: 'after-long' });
    assert.deepEqual(f.opened, [undefined, 's-1', 's-1']);
  } finally { finish?.(); await f.bridge.stop(); f.db.close(); t.mock.timers.reset(); }
});

test('new work waits for in-flight idle cleanup before starting runtime', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1700000000000 });
  const f = fixture(); let release!: () => void;
  try {
    await f.bridge.handle(message);
    f.runtime.stop = async () => { await new Promise<void>(resolve => { release = resolve; }); };
    t.mock.timers.tick(idle); await nextTurn();
    const next = f.bridge.handle({ ...message, id: '2' }); await nextTurn();
    assert.equal(f.opened.length, 1);
    release(); await next; assert.equal(f.opened.length, 2);
  } finally { release?.(); f.runtime.stop = async () => {}; await f.bridge.stop(); f.db.close(); t.mock.timers.reset(); }
});

test('cancelling the last queued task during its acknowledgement still schedules idle cleanup', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1700000000000 });
  const f = fixture(); let finish!: () => void; let releaseAck!: () => void;
  f.runtime.prompt = async () => { await new Promise<void>(resolve => { finish = resolve; }); return 'end_turn'; };
  const ack = new Promise<void>(resolve => { releaseAck = resolve; });
  f.bridge.channel.send = async (_m, text) => { if (text.includes('已加入队列')) await ack; };
  try {
    const first = f.bridge.handle(message); await nextTurn();
    const queued = f.bridge.handle({ ...message, id: 'queued' });
    finish(); await first;
    assert.equal(f.bridge.active, undefined);
    await f.bridge.handle({ ...message, id: 'clear', text: '/cancel all' });
    releaseAck(); await queued;
    t.mock.timers.tick(idle); await nextTurn();
    assert.equal(f.stops(), 1); assert.equal(f.opened.length, 1);
  } finally { finish?.(); releaseAck(); await f.bridge.stop(); f.db.close(); t.mock.timers.reset(); }
});
