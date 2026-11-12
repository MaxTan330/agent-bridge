import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Bridge } from '../src/bridge.ts';
import { Store } from '../src/store.ts';
import { baseConfigSchema } from '../src/config.ts';
import type { Runtime, Inbound } from '../src/types.ts';

const message: Inbound = { account: 'a', chat: 'c', thread: '', user: 'u', id: 'm', text: 'long work' };

test('auto reply defaults to five seconds and supports a ten-second override', () => {
  assert.equal(baseConfigSchema.parse({ WORKSPACE_ROOT: '.' }).TASK_REPLY_MODE, 'auto');
  assert.equal(baseConfigSchema.parse({ WORKSPACE_ROOT: '.' }).TASK_BACKGROUND_NOTICE_MS, 5000);
  assert.equal(baseConfigSchema.parse({ WORKSPACE_ROOT: '.', TASK_BACKGROUND_NOTICE_MS: '10000' }).TASK_BACKGROUND_NOTICE_MS, 10000);
  assert.equal(baseConfigSchema.parse({ WORKSPACE_ROOT: '.', TASK_REPLY_MODE: 'stream' }).TASK_REPLY_MODE, 'stream');
  assert.equal(baseConfigSchema.safeParse({ WORKSPACE_ROOT: '.', TASK_REPLY_MODE: 'invalid' }).success, false);
});

test('background tasks acknowledge before startup finishes, show no typing/stream, then notify result', async () => {
  const db = new Store(':memory:'); const events: string[] = [];
  let releaseOpen!: () => void; let finish!: () => void;
  const opening = new Promise<void>(resolve => { releaseOpen = resolve; });
  let progress!: (text: string) => void;
  const runtime: Runtime = {
    async open(_old, cb) { progress = cb; await opening; return 's'; },
    async prompt() { progress('answer'); await new Promise<void>(resolve => { finish = resolve; }); return 'end_turn'; },
    async stop() { finish?.(); }, async cancel() { finish?.(); },
  };
  const b = new Bridge(db, runtime, {
    async send(_m, text) { events.push(text); },
    async startTyping() { assert.fail('Background task must not show continuous typing'); },
    async task(_m, reply) { events.push(reply.state); assert.equal(reply.text, 'answer'); },
  }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 10000, cancelGrace: 10, replyMode: 'background' });
  const run = b.handle(message);
  try {
    await nextTurn(); assert.match(events[0], /已接收/); assert.match(events[0], /后台/);
    releaseOpen(); await nextTurn();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(events.length, 1);
    await b.handle({ ...message, id: 'status', text: '/status' });
    assert.match(events.at(-1)!, /执行中/);
    finish(); await run; assert.equal(events.at(-1), 'completed');
    assert.equal(db.latestResult(b.key(message))!.text, 'answer');
  } finally { releaseOpen(); finish?.(); await b.stop(); db.close(); }
});

test('slow acknowledgement does not delay execution and final result follows bounded feedback', async () => {
  const db = new Store(':memory:'); let prompts = 0; let finals = 0; let acknowledgements = 0;
  const runtime: Runtime = { async open() { return 's'; }, async prompt() { prompts++; return 'end_turn'; }, async cancel() {}, async stop() {} };
  const b = new Bridge(db, runtime, {
    async send() { acknowledgements++; await new Promise(() => {}); },
    async task() { finals++; },
  }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 10, deliveryTimeout: 30, replyMode: 'background' });
  const run = b.handle(message);
  try {
    await nextTurn(); assert.equal(prompts, 1); assert.equal(acknowledgements, 1);
    await run; assert.equal(finals, 1); assert.equal(b.active, undefined);
  } finally { await b.stop(); db.close(); }
});

for (const [duration, noticeDelay] of [[4999, undefined], [5000, undefined], [9999, 10000], [10000, 10000]] as const) {
  test(`auto mode handles ${duration}ms task with ${noticeDelay ?? 5000}ms notice threshold`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1700000000000 });
    const db = new Store(':memory:'); const events: string[] = []; let finish!: () => void;
    const runtime: Runtime = { async open() { return 's'; },
      async prompt() { await new Promise<void>(resolve => { finish = resolve; }); return 'end_turn'; },
      async cancel() { finish(); }, async stop() { finish?.(); } };
    const b = new Bridge(db, runtime, {
      async send(_m, text) { assert.match(text, /后台/); events.push('notice'); },
      async startTyping() { assert.fail('Auto mode must not show continuous typing'); },
      async task(_m, reply) { assert.equal(reply.state, 'completed'); events.push('result'); },
    }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 60000, cancelGrace: 10, backgroundNoticeMs: noticeDelay });
    const run = b.handle(message);
    try {
      await nextTurn(); assert.deepEqual(events, []);
      t.mock.timers.tick(duration); await nextTurn();
      const slow = duration >= (noticeDelay ?? 5000);
      assert.deepEqual(events, slow ? ['notice'] : []);
      finish(); await run;
      t.mock.timers.tick(15000); await nextTurn();
      assert.deepEqual(events, slow ? ['notice', 'result'] : ['result']);
    } finally { finish?.(); await b.stop(); db.close(); t.mock.timers.reset(); }
  });
}
