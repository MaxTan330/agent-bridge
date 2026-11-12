import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.ts';
import { Store } from '../src/store.ts';
import type { Runtime, Inbound } from '../src/types.ts';

test('fast replies show only the answer, with typing feedback cleaned up and no approval card', async () => {
  const db = new Store(':memory:'); const events: string[] = [];
  let update: (text: string) => void = () => {};
  const runtime: Runtime = {
    async open(_old, cb, permission) {
      update = cb;
      // A misbehaving adapter cannot leave a noninteractive run waiting on an approval card.
      const response = await permission({ sessionId: 's', toolCall: { toolCallId: 'tool', title: 'unexpected' }, options: [{ kind: 'allow_once', optionId: 'yes', name: 'yes' }] });
      assert.equal(response.outcome.outcome, 'cancelled');
      return 's';
    },
    async prompt() { update('# Answer\n- done'); return 'end_turn'; }, async stop() {}, async cancel() {},
  };
  const bridge = new Bridge(db, runtime, {
    async send() { assert.fail('No separate text notification expected'); },
    async startTyping() { events.push('typing'); return 'reaction'; },
    async task(_m, reply) { events.push(reply.state); assert.equal(reply.text, '# Answer\n- done'); },
    async stopTyping(_m, id) { assert.equal(id, 'reaction'); events.push('stop-typing'); },
    forgetTask() { events.push('forget'); },
  }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 10 });
  await bridge.handle({ account: 'a', chat: 'c', thread: '', user: 'u', id: 'm', text: 'go' });
  assert.deepEqual(events, ['typing', 'completed', 'forget', 'stop-typing']);
  db.close();
});

test('final card waits for in-flight progress and replaces it without a second reply', async () => {
  const db = new Store(':memory:'); let update: (text: string) => void = () => {};
  let finish!: () => void; let releaseProgress!: () => void; let sawProgress!: () => void;
  const progressStarted = new Promise<void>(r => { sawProgress = r; });
  const events: string[] = [];
  const runtime: Runtime = { async open(_old, cb) { update = cb; return 's'; },
    async prompt() { update('preview'); await new Promise<void>(r => { finish = r; }); update(' answer'); return 'end_turn'; },
    async cancel() {}, async stop() {},
  };
  const bridge = new Bridge(db, runtime, {
    async send() { assert.fail('No stage messages'); },
    async task(_m, reply) {
      events.push(reply.state);
      if (reply.state === 'running') { sawProgress(); await new Promise<void>(r => { releaseProgress = r; }); }
      else assert.equal(reply.text, 'preview answer');
    },
  }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 10000, cancelGrace: 10 });
  const run = bridge.handle({ account: 'a', chat: 'c', thread: '', user: 'u', id: 'm', text: 'go' });
  await progressStarted; finish(); await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(events, ['running']); releaseProgress(); await run;
  assert.deepEqual(events, ['running', 'completed']); db.close();
});

for (const outcome of ['failed', 'cancelled'] as const) {
  test(`typing feedback is removed when execution is ${outcome}`, async () => {
    const db = new Store(':memory:'); let removed = 0;
    const runtime: Runtime = { async open() { return 's'; },
      async prompt() { if (outcome === 'failed') throw new Error('fixture'); return 'cancelled'; },
      async cancel() {}, async stop() {},
    };
    const bridge = new Bridge(db, runtime, {
      async send() { assert.fail('No status text'); },
      async startTyping() { return 'typing'; }, async stopTyping() { removed++; },
      async task(_m, reply) { assert.equal(reply.state, outcome); },
    }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 10 });
    await bridge.handle({ account: 'a', chat: 'c', thread: '', user: 'u', id: 'm', text: 'go' });
    assert.equal(removed, 1); assert.equal(bridge.active, undefined); db.close();
  });
}

test('cancelled partial output explicitly says it was cancelled without a state header', async () => {
  const db = new Store(':memory:'); let update: (text: string) => void = () => {}; let answer = '';
  const runtime: Runtime = {
    async open(_old, cb) { update = cb; return 's'; },
    async prompt() { update('partial answer'); return 'cancelled'; }, async stop() {}, async cancel() {},
  };
  const b = new Bridge(db, runtime, {
    async send() {}, async task(_m, reply) { answer = reply.text; },
  }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 10 });
  await b.handle({ account: 'a', chat: 'c', thread: '', user: 'u', id: 'partial-cancel', text: 'go' });
  assert.match(answer, /partial answer/); assert.match(answer, /已取消/); db.close();
});

test('failed task insert rolls back claim and permits a later retry', async () => {
  const db = new Store(':memory:'); let prompts = 0;
  const rt: Runtime = { async open() { return 's'; }, async prompt() { prompts++; return 'end_turn'; }, async cancel() {}, async stop() {} };
  const b = new Bridge(db, rt, { async send() {} },
    { users: ['u'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 10 });
  const m = { account: 'a', chat: 'c', thread: '', user: 'u', id: 'dbfail', text: 'go' };
  db.db.exec("CREATE TRIGGER fail_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await b.handle(m);
  assert.equal(b.active, undefined);
  assert.equal(db.db.prepare('SELECT count(*) n FROM messages').get()?.n, 0);
  db.db.exec('DROP TRIGGER fail_task');
  await b.handle(m); assert.equal(prompts, 1);
  await b.stop(); db.close();
});

test('graceful cancellation cleans background work before releasing lock', async () => {
  const db = new Store(':memory:'); let end: () => void = () => {}; let alive = true;
  const rt: Runtime = {
    async open() { return 's'; }, async prompt() { await new Promise<void>(r => { end = r; }); return 'cancelled'; },
    async cancel() { end(); }, async stop() { await new Promise(r => setTimeout(r, 20)); alive = false; },
  };
  const b = new Bridge(db, rt, { async send() {} },
    { users: ['u'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 100 });
  const run = b.handle({ account: 'a', chat: 'c', thread: '', user: 'u', id: 'cancel-bg', text: 'go' });
  await new Promise(r => setTimeout(r, 10));
  const cancelling = b.cancel();
  await run; assert.equal(alive, false); assert.equal(b.active, undefined);
  await cancelling; db.close();
});

test('failed final delivery persists result and /result retrieves without replaying prompt', async () => {
  const db = new Store(':memory:'); let update: (s: string) => void = () => {}; let prompts = 0; let fail = true;
  const sent: string[] = [];
  const rt: Runtime = { async open(_old, cb) { update = cb; return 's'; }, async prompt() { prompts++; update('retained answer'); return 'end_turn'; }, async cancel() {}, async stop() {} };
  const b = new Bridge(db, rt, {
    async send(_m, text) { if (fail) throw new Error('permanent transport error'); sent.push(text); },
  }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 10 });
  const m = { account: 'a', chat: 'c', thread: '', user: 'u', id: 'delivery', text: 'go' };
  await b.handle(m); assert.equal(prompts, 1);
  assert.match(db.latestResult(b.key(m))!.text, /retained answer/);
  fail = false;
  await b.handle({ ...m, id: 'result', text: '/result' });
  assert.equal(prompts, 1); assert.match(sent.at(-1)!, /retained answer/);
  db.close();
});

test('rejected input gets feedback only after authorization and never starts runtime', async () => {
  const db = new Store(':memory:'); let opens = 0; const replies: string[] = [];
  const rt: Runtime = { async open() { opens++; return 's'; }, async prompt() { return 'end_turn'; }, async cancel() {}, async stop() {} };
  const b = new Bridge(db, rt, { async send(_m, text) { replies.push(text); } },
    { users: ['u'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 10 });
  const m = { account:'a', chat:'c', thread:'', user:'u', id:'long-input', text:'', rejection:'输入过长，请拆分。' };
  await b.handle({...m,user:'other'}); assert.equal(replies.length,0);
  await b.handle(m); assert.equal(replies.length,1); assert.equal(opens,0); db.close();
});

test('final delivery retries transient failures without rerunning the agent', async () => {
  const db = new Store(':memory:'); let attempts = 0; let prompts = 0;
  const rt: Runtime = { async open() { return 's'; }, async prompt() { prompts++; return 'end_turn'; }, async cancel() {}, async stop() {} };
  const b = new Bridge(db, rt, {
    async send(_m, text) {
      if (++attempts < 3) throw Object.assign(new Error('network'), { code: 'ECONNRESET' });
    },
  }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 2000, cancelGrace: 10 });
  const m = { account:'a', chat:'c', thread:'', user:'u', id:'retry-result', text:'go' };
  await b.handle(m); assert.equal(prompts, 1); assert.equal(attempts, 3);
  assert.equal(db.latestResult(b.key(m))?.delivery, 'sent'); db.close();
});

test('cleanup failure stops new task acceptance and still releases shutdown waiters', async () => {
  const db = new Store(':memory:'); let prompts = 0;
  const rt: Runtime = { async open() { return 's'; }, async prompt() { prompts++; throw new Error('crash'); }, async cancel() {}, async stop() { throw new Error('cannot kill'); } };
  const b = new Bridge(db, rt, { async send() {} },
    { users:['u'],admins:[],workspace:'w',taskTimeout:1000,cancelGrace:10 });
  const m={account:'a',chat:'c',thread:'',user:'u',id:'cleanup-fail',text:'go'};
  await b.handle(m); assert.equal(b.active, undefined); assert.equal(b.stopping, true);
  await b.handle({...m,id:'next'}); assert.equal(prompts,1); db.close();
});

test('bridge rejects unauthorized users, deduplicates and isolates user sessions', async () => {
  const db = new Store(':memory:');
  const sent: string[] = []; let prompts = 0; let sessions = 0;
  const runtime: Runtime = {
    async open(old) { return old ?? `s${++sessions}`; },
    async prompt() { prompts++; return 'done'; }, async cancel() {}, async stop() {},
  };
  const b = new Bridge(db, runtime,
    { async send(_m, text) { sent.push(text); } },
    { users: ['u', 'v'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 10 });
  const m: Inbound = { account: 'a', chat: 'c', thread: '', user: 'u', id: '1', text: 'hello' };
  await b.handle({ ...m, user: 'intruder' }); assert.equal(prompts, 0);
  await b.handle(m); await b.handle(m); assert.equal(prompts, 1);
  await b.handle({ ...m, id: '2' }); assert.equal(sessions, 1);
  await b.handle({ ...m, id: '3', user: 'v' }); assert.equal(sessions, 2);
  db.close();
});

test('busy workspace rejects new task; only owner can cancel', async () => {
  const db = new Store(':memory:'); let end: () => void = () => {}; let cancelled = 0;
  const runtime: Runtime = {
    async open() { return 'session'; },
    async prompt() { await new Promise<void>(r => { end = r; }); return 'cancelled'; },
    async cancel() { cancelled++; end(); }, async stop() { end(); },
  };
  const sent: string[] = [];
  const b = new Bridge(db, runtime,
    { async send(_m, text) { sent.push(text); } },
    { users: ['u', 'v'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 10 });
  const m: Inbound = { account: 'a', chat: 'c', thread: '', user: 'u', id: '1', text: 'go' };
  const active = b.handle(m);
  await new Promise(r => setTimeout(r, 10));
  await b.handle({ ...m, id: '2', text: 'busy' });
  assert.ok(sent.some(s => s.includes('忙')));
  await b.handle({ ...m, id: '3', user: 'v', text: '/cancel' }); assert.equal(cancelled, 0);
  await b.handle({ ...m, id: '4', text: '/cancel' });
  await active; assert.equal(cancelled, 1);
  db.close();
});

test('task timeout forcibly stops unresponsive runtime and releases workspace', async () => {
  const db = new Store(':memory:'); let rejectPrompt: (e: Error) => void = () => {}; let stopped = 0;
  const runtime: Runtime = {
    async open() { return 's'; },
    async prompt() { return new Promise<string>((_, reject) => { rejectPrompt = reject; }); },
    async cancel() {}, async stop() { stopped++; rejectPrompt(new Error('closed')); },
  };
  const b = new Bridge(db, runtime,
    { async send() {} },
    { users: ['u'], admins: [], workspace: 'w', taskTimeout: 20, cancelGrace: 10 });
  await b.handle({ account: 'a', chat: 'c', thread: '', user: 'u', id: 'timeout', text: 'go' });
  assert.ok(stopped > 0); assert.equal(b.active, undefined);
  assert.equal(db.db.prepare('SELECT status FROM tasks').get()?.status, 'cancelled');
  db.close();
});

test('bounded output marks truncation and retains final answer after long streaming progress', async () => {
  const db = new Store(':memory:'); const sent: string[] = []; let update: (s: string) => void = () => {};
  const runtime: Runtime = {
    async open(_old, onUpdate) { update = onUpdate; return 's'; },
    async prompt() { update('x'.repeat(25000)); update('FINAL ANSWER'); return 'end_turn'; },
    async cancel() {}, async stop() {},
  };
  const b = new Bridge(db, runtime,
    { async send(_m, text) { sent.push(text); } },
    { users: ['u'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 10 });
  await b.handle({ account: 'a', chat: 'c', thread: '', user: 'u', id: 'long', text: 'go' });
  assert.ok(sent.at(-1)?.endsWith('FINAL ANSWER'));
  assert.ok(sent.at(-1)?.startsWith('（回复过长，以下保留末尾 24000 字符。）'));
  db.close();
});

test('streaming keeps cumulative content and final replies retain more than 12000 characters', async () => {
  const db = new Store(':memory:'); let update: (s: string) => void = () => {};
  let preview = ''; let answer = '';
  let progressed!: () => void;
  const progress = new Promise<void>(resolve => { progressed = resolve; });
  const first = 'START' + '中'.repeat(5000); const last = '末'.repeat(10000) + 'END';
  const runtime: Runtime = {
    async open(_old, cb) { update = cb; return 's'; },
    async prompt() { update(first); await progress; update(last); return 'end_turn'; },
    async stop() {}, async cancel() {},
  };
  const b = new Bridge(db, runtime, {
    async send() { assert.fail('No duplicate text reply'); },
    async task(_m, reply) {
      if (reply.state === 'running') { preview = reply.text; progressed(); }
      else answer = reply.text;
    },
  }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 5000, cancelGrace: 10 });
  const m = { account: 'a', chat: 'c', thread: '', user: 'u', id: 'full', text: 'go' };
  await b.handle(m);
  assert.equal(preview, first); assert.equal(answer, first + last);
  assert.equal(db.latestResult(b.key(m))?.text, first + last); db.close();
});

test('slow typing reaction does not delay runtime startup and is still removed', async () => {
  const db = new Store(':memory:'); let release!: () => void; let removed = false;
  let typingSignal: AbortSignal | undefined; let openedBeforeTimeout = false;
  const runtime: Runtime = {
    async open() { openedBeforeTimeout = !typingSignal?.aborted; release(); return 's'; }, async prompt() { return 'end_turn'; }, async stop() {}, async cancel() {},
  };
  const b = new Bridge(db, runtime, {
    async send() {},
    async startTyping(_m, signal) { typingSignal = signal; await new Promise<void>(r => { release = r; }); return 'reaction'; },
    async stopTyping() { removed = true; },
  }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 1000, cancelGrace: 10, deliveryTimeout: 50 });
  await b.handle({ account: 'a', chat: 'c', thread: '', user: 'u', id: 'typing', text: 'go' });
  assert.equal(openedBeforeTimeout, true); assert.equal(removed, true); db.close();
});

test('hanging channel cannot retain workspace lock or block shutdown forever', async () => {
  const db = new Store(':memory:'); let opens = 0;
  const runtime: Runtime = {
    async open() { opens++; return 's'; }, async prompt() { return 'end_turn'; }, async cancel() {}, async stop() {},
  };
  const b = new Bridge(db, runtime,
    { async send() { await new Promise(() => {}); } },
    { users: ['u'], admins: [], workspace: 'w', taskTimeout: 10, cancelGrace: 5, deliveryTimeout: 20 });
  await b.handle({ account: 'a', chat: 'c', thread: '', user: 'u', id: 'hang', text: 'go' });
  assert.equal(b.active, undefined); assert.equal(opens, 1);
  await b.stop(); db.close();
});
