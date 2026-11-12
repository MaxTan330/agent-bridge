import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.ts';
import { Store } from '../src/store.ts';
import type { Inbound, Runtime } from '../src/types.ts';

const message: Inbound = { account: 'a', chat: 'c', thread: 't', user: 'u', id: 'first', text: 'first' };
function fixture(queueLimit = 20) {
  const db = new Store(':memory:');
  const sent: { message: Inbound; text: string }[] = []; const prompts: string[] = [];
  const sessions: (string | undefined)[] = [];
  let finish: (reason: string) => void = () => {};
  let reject: (error: Error) => void = () => {};
  let concurrent = 0; let maxConcurrent = 0;
  const runtime: Runtime = {
    async open(old) { sessions.push(old); return old ?? `s-${sessions.length}`; },
    async prompt(_session, text) {
      prompts.push(text); maxConcurrent = Math.max(maxConcurrent, ++concurrent);
      try { return await new Promise<string>((resolve, fail) => { finish = resolve; reject = fail; }); }
      finally { concurrent--; }
    },
    async cancel() { finish('cancelled'); }, async stop() { finish('cancelled'); },
  };
  const bridge = new Bridge(db, runtime, { async send(m, text) { sent.push({ message: m, text }); } },
    { users: ['u', 'v', 'admin'], admins: ['admin'], workspace: 'w', taskTimeout: 10000, cancelGrace: 10, queueLimit });
  const queued = () => db.db.prepare("SELECT id FROM tasks WHERE status='queued' ORDER BY rowid").all() as { id: string }[];
  return { db, bridge, runtime, sent, prompts, sessions, queued, maxConcurrent: () => maxConcurrent,
    finish: () => finish('end_turn'), fail: () => reject(new Error('fixture failure')),
    async close() { await bridge.stop(); db.close(); } };
}

test('busy messages execute FIFO once after cleanup, preserving session context', async () => {
  const f = fixture(); const first = f.bridge.handle(message);
  try {
    await nextTurn();
    await f.bridge.handle({ ...message, id: 'second', text: 'second' });
    await f.bridge.handle({ ...message, id: 'second', text: 'second' });
    await f.bridge.handle({ ...message, id: 'third', text: 'third' });
    assert.equal(f.queued().length, 2); assert.deepEqual(f.prompts, ['first']);
    assert.equal(f.sent.filter(s => s.text.includes('已加入队列')).length, 2);
    f.finish(); await first; await nextTurn();
    assert.deepEqual(f.prompts, ['first', 'second']);
    const secondDone = f.bridge.active!.done; f.finish(); await secondDone; await nextTurn();
    assert.deepEqual(f.prompts, ['first', 'second', 'third']);
    const thirdDone = f.bridge.active!.done; f.finish(); await thirdDone;
    assert.equal(f.maxConcurrent(), 1); assert.equal(f.bridge.active, undefined);
    assert.deepEqual(f.sessions, [undefined, 's-1', 's-1']);
  } finally { await f.close(); }
});

test('queue visibility and individual cancellation stay in account/chat/thread and owner scope', async () => {
  const f = fixture(); void f.bridge.handle(message);
  try {
    await nextTurn();
    await f.bridge.handle({ ...message, id: 'private', text: 'private queued task' });
    const id = f.queued()[0].id;
    for (const [i, override] of [{ user: 'v' }, { user: 'admin', thread: 'other' }, { account: 'other' }, { chat: 'other' }].entries()) {
      await f.bridge.handle({ ...message, ...override, id: `list-${i}`, text: '/queue' });
      assert.doesNotMatch(f.sent.at(-1)!.text, /private queued task/);
      await f.bridge.handle({ ...message, ...override, id: `cancel-${i}`, text: `/cancel ${id}` });
      assert.equal(f.queued().length, 1);
    }
    await f.bridge.handle({ ...message, id: 'status', text: '/status' });
    assert.match(f.sent.at(-1)!.text, /排队/);
    await f.bridge.handle({ ...message, user: 'admin', id: 'admin-list', text: '/queue' });
    assert.match(f.sent.at(-1)!.text, /private queued task/);
    await f.bridge.handle({ ...message, id: 'owner-cancel', text: `/cancel ${id}` });
    assert.equal(f.db.taskStatus(id), 'cancelled'); assert.equal(f.queued().length, 0);
    assert.deepEqual(f.prompts, ['first']);
  } finally { await f.close(); }
});

test('cancel all clears only caller queue; cancel current continues the next task', async () => {
  const f = fixture(); const first = f.bridge.handle(message);
  try {
    await nextTurn();
    await f.bridge.handle({ ...message, id: 'own', text: 'own queued' });
    await f.bridge.handle({ ...message, user: 'v', id: 'other', text: 'other queued' });
    await f.bridge.handle({ ...message, id: 'clear', text: '/cancel all' });
    assert.equal(f.queued().length, 1);
    await f.bridge.handle({ ...message, id: 'cancel-current', text: '/cancel' });
    await first; await nextTurn();
    assert.deepEqual(f.prompts, ['first', 'other queued']);
    const done = f.bridge.active!.done; f.finish(); await done;
  } finally { await f.close(); }
});

test('queue limit and admission failure do not create phantom or duplicate work', async () => {
  const f = fixture(1); void f.bridge.handle(message);
  try {
    await nextTurn();
    const task = f.db.task;
    f.db.task = () => { throw new Error('disk failure'); };
    await f.bridge.handle({ ...message, id: 'retry', text: 'retry' });
    assert.equal(f.queued().length, 0);
    f.db.task = task;
    await f.bridge.handle({ ...message, id: 'retry', text: 'retry' });
    assert.equal(f.queued().length, 1);
    await f.bridge.handle({ ...message, id: 'full', text: 'overflow' });
    assert.match(f.sent.at(-1)!.text, /队列已满/); assert.equal(f.queued().length, 1);
    await f.bridge.handle({ ...message, id: 'new', text: '/new' });
    assert.match(f.sent.at(-1)!.text, /取消|完成/);
    assert.equal(f.queued().length, 1);
  } finally { await f.close(); }
});

test('control commands bypass a full queue without becoming model tasks', async () => {
  const f = fixture(1); const first = f.bridge.handle(message);
  try {
    await nextTurn();
    await f.bridge.handle({ ...message, id: 'pending', text: 'pending work' });
    for (const [text, response] of [
      ['/status', /当前任务/], ['/queue', /pending work/],
      ['/result', /尚无可取回的结果/], ['/new', /执行中或排队任务/],
    ] as const) {
      await f.bridge.handle({ ...message, id: text, text });
      assert.match(f.sent.at(-1)!.text, response);
      assert.equal(f.queued().length, 1);
    }
    await f.bridge.handle({ ...message, id: 'cancel-running', text: '/cancel' });
    await first; await nextTurn();
    assert.deepEqual(f.prompts, ['first', 'pending work']);
    await f.bridge.handle({ ...message, id: 'pending-again', text: 'another pending' });
    await f.bridge.handle({ ...message, id: 'clear', text: '/cancel all' });
    assert.equal(f.queued().length, 0);
    assert.deepEqual(f.prompts, ['first', 'pending work']);
  } finally { await f.close(); }
});

test('execution failure drains queue but failed process cleanup interrupts it', async () => {
  for (const cleanupFails of [false, true]) {
    const f = fixture(); const first = f.bridge.handle(message);
    try {
      await nextTurn();
      await f.bridge.handle({ ...message, id: 'next', text: 'next' });
      const id = f.queued()[0].id;
      if (cleanupFails) f.runtime.stop = async () => { throw new Error('process still alive'); };
      f.fail(); await first; await nextTurn();
      if (cleanupFails) {
        assert.equal(f.bridge.stopping, true); assert.equal(f.db.taskStatus(id), 'interrupted');
        assert.deepEqual(f.prompts, ['first']);
      } else {
        assert.deepEqual(f.prompts, ['first', 'next']);
        const done = f.bridge.active!.done; f.finish(); await done;
      }
    } finally { f.runtime.stop = async () => {}; await f.close(); }
  }
});

test('stopping interrupts queued requests with retrievable results without starting them', async () => {
  const f = fixture(); void f.bridge.handle(message);
  try {
    await nextTurn(); await f.bridge.handle({ ...message, id: 'queued', text: 'queued' });
    const id = f.queued()[0].id;
    await f.bridge.stop();
    assert.deepEqual(f.prompts, ['first']); assert.equal(f.db.taskStatus(id), 'interrupted');
    assert.match(f.db.db.prepare('SELECT text FROM results WHERE task=?').get(id)!.text as string, /中断/);
  } finally { f.db.close(); }
});

test('restart marks persisted queued work interrupted and never replays it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'bridge-queue-')), 'test.db');
  let db = new Store(path);
  db.accept('queued', 'session', 'message', 'queued'); db.close();
  db = new Store(path);
  try {
    assert.equal(db.taskStatus('queued'), 'interrupted');
    assert.match(db.latestResult('session')!.text, /中断/);
    assert.equal(db.claim('message'), false);
  } finally { db.close(); }
});

test('queue waits for final delivery and cannot be overtaken by a later arrival', async () => {
  const f = fixture();
  let releaseDelivery!: () => void;
  const delivery = new Promise<void>(resolve => { releaseDelivery = resolve; });
  f.bridge.channel.task = async m => { if (m.id === 'first') await delivery; };
  const first = f.bridge.handle(message);
  try {
    await nextTurn(); await f.bridge.handle({ ...message, id: 'second', text: 'second' });
    f.finish(); await nextTurn(); assert.deepEqual(f.prompts, ['first']);
    await f.bridge.handle({ ...message, id: 'third', text: 'third' });
    releaseDelivery(); await first; await nextTurn();
    assert.deepEqual(f.prompts, ['first', 'second']);
    const second = f.bridge.active!.done; f.finish(); await second; await nextTurn();
    assert.deepEqual(f.prompts, ['first', 'second', 'third']);
  } finally { releaseDelivery(); await f.close(); }
});

test('shutdown during enqueue acknowledgement cannot start or resurrect queued work', async () => {
  const f = fixture(); let releaseAck!: () => void;
  const ack = new Promise<void>(resolve => { releaseAck = resolve; });
  const send = f.bridge.channel.send;
  f.bridge.channel.send = async (m, text, signal) => {
    if (text.includes('已加入队列')) await ack;
    await send(m, text, signal);
  };
  const first = f.bridge.handle(message);
  try {
    await nextTurn();
    const queued = f.bridge.handle({ ...message, id: 'queued', text: 'queued' });
    const id = f.queued()[0].id;
    f.finish(); await first;
    assert.equal(f.bridge.active, undefined);
    await f.bridge.stop(); releaseAck(); await queued; await nextTurn();
    assert.deepEqual(f.prompts, ['first']); assert.equal(f.db.taskStatus(id), 'interrupted');
  } finally { releaseAck(); await f.close(); }
});

test('database failure while starting queued task stops dispatch and records interruption', async () => {
  const f = fixture(); const first = f.bridge.handle(message);
  try {
    await nextTurn(); await f.bridge.handle({ ...message, id: 'queued', text: 'queued' });
    const id = f.queued()[0].id;
    f.db.startQueued = () => { throw new Error('storage unavailable'); };
    f.finish(); await first; await nextTurn();
    assert.equal(f.bridge.stopping, true); assert.equal(f.db.taskStatus(id), 'interrupted');
    assert.deepEqual(f.prompts, ['first']);
  } finally { await f.close(); }
});

test('result recovers later-completed answer even when a newer queued task was cancelled', async () => {
  const f = fixture();
  f.bridge.channel.task = async () => { throw new Error('final delivery failed'); };
  const first = f.bridge.handle(message);
  try {
    await nextTurn();
    const runningId = f.db.db.prepare("SELECT id FROM tasks WHERE status='running'").get()!.id;
    await f.bridge.handle({ ...message, id: 'queued', text: 'queued' });
    await f.bridge.handle({ ...message, id: 'cancel-queued', text: '/cancel all' });
    f.finish(); await first;
    const result = f.db.latestResult(f.bridge.key(message))!;
    assert.equal(result.task, runningId);
    assert.equal(result.delivery, 'failed');
    await f.bridge.handle({ ...message, id: 'recover', text: '/result' });
    assert.equal(f.sent.at(-1)!.text, '没有文本输出。');
    assert.equal(f.db.latestResult(f.bridge.key(message))!.delivery, 'sent');
  } finally { await f.close(); }
});
