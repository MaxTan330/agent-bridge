import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Bridge } from '../src/bridge.ts';
import { Store } from '../src/store.ts';
import type { Inbound, Runtime, TaskReply } from '../src/types.ts';

const message: Inbound = { account: 'a', chat: 'c', thread: '', user: 'u', id: 'first', text: 'work' };
const cases = [
  ['end_turn', 'completed', undefined],
  ['cancelled', 'cancelled', /取消/],
  ['max_turn_requests', 'failed', /执行限制/],
  ['max_tokens', 'failed', /输出长度上限/],
  ['refusal', 'failed', /拒绝/],
  ['future-private-reason', 'failed', /未正常完成/],
] as const;

for (const [reason, expected, explanation] of cases) {
  for (const output of ['', '已完成第一步，后续尚未执行。']) {
    test(`${reason} with ${output ? 'partial output' : 'no output'} persists and delivers the correct terminal state`, async () => {
      const db = new Store(':memory:'); const replies: TaskReply[] = []; const sent: string[] = [];
      let progress = (_text: string) => {}; let stops = 0; let prompts = 0;
      const runtime: Runtime = {
        async open(_old, update) { progress = update; return 's'; },
        async prompt() { prompts++; if (output) progress(output); return reason; },
        async cancel() {}, async stop() { stops++; },
      };
      const bridge = new Bridge(db, runtime, {
        async send(_m, text) { sent.push(text); }, async task(_m, reply) { replies.push(reply); },
      }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 10 });
      try {
        await bridge.handle(message);
        const stored = db.latestResult(bridge.key(message))!;
        assert.equal(db.taskStatus(stored.task), expected);
        assert.equal(replies[0].state, expected); assert.equal(replies[0].text, stored.text);
        assert.equal(stops, expected === 'completed' ? 0 : 1);
        if (output) assert.ok(stored.text.includes(output));
        if (explanation) assert.match(stored.text, explanation);
        if (expected === 'failed' && output) assert.match(stored.text, /部分输出/);
        if (expected === 'completed') assert.equal(stored.text, output || '没有文本输出。');
        assert.doesNotMatch(stored.text, /max_turn_requests|max_tokens|future-private-reason/);
        await bridge.handle({ ...message, id: 'result', text: '/result' });
        assert.equal(sent.at(-1), stored.text); assert.equal(prompts, 1);
      } finally { await bridge.stop(); db.close(); }
    });
  }
}

test('limited task finishes process cleanup before the next queued task starts', async () => {
  const db = new Store(':memory:'); const prompts: string[] = [];
  let finish!: () => void; let releaseCleanup!: () => void;
  const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const runtime: Runtime = {
    async open() { return 's'; }, async prompt(_s, text) {
      prompts.push(text);
      if (text === 'work') { await new Promise<void>(resolve => { finish = resolve; }); return 'max_turn_requests'; }
      return 'end_turn';
    }, async cancel() { finish?.(); }, async stop() { await cleanup; },
  };
  const bridge = new Bridge(db, runtime, { async send() {} }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 10000, cancelGrace: 10 });
  try {
    const first = bridge.handle(message); await nextTurn();
    await bridge.handle({ ...message, id: 'second', text: 'next' });
    finish(); await nextTurn(); assert.deepEqual(prompts, ['work']);
    releaseCleanup(); await first; await nextTurn(); assert.deepEqual(prompts, ['work', 'next']);
    await bridge.active?.done;
    assert.deepEqual(db.db.prepare('SELECT status FROM tasks ORDER BY rowid').all().map(row => row.status), ['failed', 'completed']);
  } finally { finish?.(); releaseCleanup(); await bridge.stop(); db.close(); }
});

test('explicit cancellation wins even when the runtime subsequently returns a limit reason', async () => {
  const db = new Store(':memory:'); let finish!: () => void;
  const runtime: Runtime = { async open() { return 's'; }, async prompt() { await new Promise<void>(resolve => { finish = resolve; }); return 'max_tokens'; },
    async cancel() { finish(); }, async stop() {} };
  const bridge = new Bridge(db, runtime, { async send() {} }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 10 });
  try {
    const run = bridge.handle(message); await nextTurn();
    await bridge.handle({ ...message, id: 'cancel', text: '/cancel' }); await run;
    const result = db.latestResult(bridge.key(message))!;
    assert.equal(db.taskStatus(result.task), 'cancelled'); assert.match(result.text, /取消/);
  } finally { finish?.(); await bridge.stop(); db.close(); }
});
