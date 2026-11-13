import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Bridge } from '../src/bridge.ts';
import { Store } from '../src/store.ts';
import type { Inbound, Runtime, RuntimeHooks } from '../src/types.ts';

const message: Inbound = { account: 'a', chat: 'c', thread: 't', user: 'u', id: 'work', text: 'work' };
function fixture() {
  const db = new Store(':memory:'); const sent: string[] = []; const steered: string[] = [];
  let hooks: RuntimeHooks; let finish!: () => void; let prompts = 0;
  const runtime: Runtime = { async open(_old, _text, _permission, _signal, h) {
    hooks = h!; h?.onEvent?.({ type: 'capabilities', steering: true, image: true });
    h?.onEvent?.({ type: 'update', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review' }] } });
    return 'native';
  }, async prompt() { prompts++; await new Promise<void>(r => { finish = r; }); return 'end_turn'; },
  async steer(_session, text) { steered.push(text); return 'injected'; }, async cancel() { finish?.(); }, async stop() { finish?.(); } };
  const bridge = new Bridge(db, runtime, { async send(_m, text) { sent.push(text); } }, { users: ['u', 'v'], admins: [], workspace: 'w', taskTimeout: 10000, cancelGrace: 10, queueLimit: 1 });
  let counter = 0;
  return { db, bridge, sent, runtime, steered, hooks: () => hooks, prompts: () => prompts,
    command: (text: string, user = 'u') => bridge.handle({ ...message, id: `cmd-${++counter}`, text, user }),
    finish: () => finish(), async close() { await bridge.stop(); db.close(); } };
}

test('ACP metadata survives in task results and owner-scoped session history', async () => {
  const f = fixture(); const running = f.bridge.handle(message);
  try {
    await nextTurn();
    f.hooks().onEvent?.({ type: 'update', update: { sessionUpdate: 'session_info_update', title: '修复构建' } });
    f.hooks().onEvent?.({ type: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', content: [
      { type: 'diff', path: '/private/project/build.ts', oldText: 'private-content', newText: 'new-content' },
    ] } });
    f.finish(); await running;
    await f.command('/result');
    assert.match(f.sent.at(-1)!, /build\.ts/);
    assert.doesNotMatch(f.sent.at(-1)!, /\/private|private-content|new-content/);
    await f.command('/resume native');
    await f.command('/sessions');
    assert.match(f.sent.at(-1)!, /修复构建/);
    await f.command('/sessions', 'v');
    assert.doesNotMatch(f.sent.at(-1)!, /修复构建/);
  } finally { await f.close(); }
});

test('native queries and steering bypass full queue while preserving owner isolation', async () => {
  const f = fixture(); const running = f.bridge.handle(message);
  try {
    await nextTurn(); await f.command('queued');
    await f.command('/commands'); assert.match(f.sent.at(-1)!, /\/review/);
    await f.command('/commands', 'v'); assert.doesNotMatch(f.sent.at(-1)!, /\/review/);
    await f.command('/steer do not commit', 'v'); assert.equal(f.steered.length, 0);
    await f.command('/steer do not commit'); assert.deepEqual(f.steered, ['do not commit']);
    assert.equal(f.prompts(), 1);
    f.hooks().onEvent?.({ type: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Test suite', status: 'in_progress' } });
    await f.command('/status'); assert.match(f.sent.at(-1)!, /Test suite/);
    await f.command('/cancel all'); f.finish(); await running;
    await f.command('/steer too late'); assert.equal(f.steered.length, 1);
  } finally { await f.close(); }
});

test('answer resumes only the owning pending question and task cancellation releases it', async () => {
  const f = fixture(); const running = f.bridge.handle(message);
  try {
    await nextTurn();
    const answer = f.hooks().onQuestion!({ sessionId: 'native', message: 'Choose', requestedSchema: { type: 'object', properties: { value: { type: 'string' } } } });
    await nextTurn(); const id = /\/answer ([\w-]+)/.exec(f.sent.at(-1)!)![1];
    await f.command(`/answer ${id} hello`, 'v'); assert.match(f.sent.at(-1)!, /无权|不存在/);
    await f.command(`/answer ${id} hello`); assert.deepEqual(await answer, { action: 'accept', content: { value: 'hello' } });
    const abandoned = f.hooks().onQuestion!({ sessionId: 'native', message: 'Again', requestedSchema: { type: 'object', properties: { value: { type: 'string' } } } });
    await f.command('/cancel'); await running; assert.deepEqual(await abandoned, { action: 'cancel' });
  } finally { await f.close(); }
});

test('history and preferences persist but cannot select another owner session', () => {
  const db = new Store(':memory:');
  try {
    db.saveSession('owner', 'mine'); db.saveSession('other', 'secret'); db.forget('owner');
    assert.equal(db.resumeSession('owner', 'secret'), false);
    assert.equal(db.resumeSession('owner', 'mine'), true); assert.equal(db.session('owner'), 'mine');
    assert.deepEqual(db.sessionHistory('owner').map(s => s.acp), ['mine']);
    db.setPreference('owner', 'mode', 'plan'); assert.equal(db.preferences('owner').mode, 'plan');
  } finally { db.close(); }
});

test('attachments are prepared only when authorized work executes, never for rejected or cancelled queued work', async () => {
  const f = fixture(); const prepared: string[] = []; const blocks: unknown[] = [];
  f.bridge.channel.prepare = async (m, signal) => { signal.throwIfAborted(); prepared.push(m.id); return [{ type: 'text', text: 'log contents' }]; };
  const prompt = f.runtime.prompt;
  f.runtime.prompt = async (session, text, attachments) => { blocks.push(attachments); return prompt(session, text); };
  const attachment = { type: 'file' as const, key: 'resource', name: 'test.log' };
  try {
    await f.bridge.handle({ ...message, id: 'unauthorized', user: 'stranger', attachment });
    assert.deepEqual(prepared, []);
    const run = f.bridge.handle({ ...message, attachment }); await nextTurn();
    assert.deepEqual(prepared, ['work']); assert.deepEqual(blocks, [[{ type: 'text', text: 'log contents' }]]);
    await f.bridge.handle({ ...message, id: 'queued-file', attachment });
    await f.command('/cancel all'); f.finish(); await run;
    assert.deepEqual(prepared, ['work']);
  } finally { await f.close(); }
});
