import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeishuReplies, splitReply, streamCard, richPost, type ReplyTransport } from '../src/feishu-replies.ts';
import { apiDeliveryFailure } from '../src/delivery-error.ts';
const message = { account: 'app', id: 'm', chat: 'c', thread: 'thread', user: 'u', text: 'hello' };
function fixture() {
  const calls: Array<{ op: string; [key: string]: unknown }> = [];
  const transport: ReplyTransport = {
    async create() { calls.push({ op: 'create' }); return 'card'; },
    async reply(_m, card, uuid) { calls.push({ op: 'reply', card, uuid }); return 'message'; },
    async update(card, text, sequence) { calls.push({ op: 'update', card, text, sequence }); },
    async close(card, text, sequence) { calls.push({ op: 'close', card, text, sequence }); },
    async post(_m, text, uuid) { calls.push({ op: 'post', text, uuid }); },
  };
  return { calls, transport, replies: new FeishuReplies(transport, () => {}) };
}
test('native stream uses cumulative content, closes once, and has no task header or collapsed panel', async () => {
  const { calls, replies } = fixture();
  await replies.task(message, { id: 't', state: 'running', text: 'hello' });
  await replies.task(message, { id: 't', state: 'running', text: 'hello world' });
  await replies.task(message, { id: 't', state: 'completed', text: 'hello world!' });
  await replies.task(message, { id: 't', state: 'completed', text: 'hello world!' });
  assert.deepEqual(calls.map(c => c.op), ['create', 'reply', 'update', 'update', 'update', 'close']);
  assert.deepEqual(calls.filter(c => c.sequence).map(c => c.sequence), [1, 2, 3, 4]);
  const card = JSON.parse(streamCard());
  assert.equal(card.config.streaming_mode, true); assert.equal(card.header, undefined);
  assert.equal(card.body.elements[0].element_id, 'content');
  assert.doesNotMatch(streamCard(), /collapsible_panel|正在处理|回复/);
});
test('unavailable CardKit falls back to rich posts only at final, without repeated creation', async () => {
  const { replies, transport, calls } = fixture(); let creates = 0;
  transport.create = async () => { creates++; throw new Error('permission'); };
  await replies.task(message, { id: 't', state: 'running', text: 'draft' });
  await replies.task(message, { id: 't', state: 'completed', text: 'answer' });
  assert.equal(creates, 1); assert.deepEqual(calls.map(c => c.op), ['post']);
  assert.equal(calls[0].text, 'answer');
});
test('uncertain card reply retries the same card reference and UUID', async () => {
  const { replies, transport, calls } = fixture(); const send = transport.reply; let attempts = 0;
  transport.reply = async (...args) => { const id = await send(...args); if (++attempts === 1) throw new Error('network'); return id; };
  await assert.rejects(replies.task(message, { id: 't', state: 'running', text: 'draft' }));
  await replies.task(message, { id: 't', state: 'completed', text: 'answer' });
  assert.equal(calls.filter(c => c.op === 'create').length, 1);
  assert.deepEqual(calls.filter(c => c.op === 'reply')[0], calls.filter(c => c.op === 'reply')[1]);
});

test('definitely rejected card references fall back to rich posts', async () => {
  const { replies, transport, calls } = fixture(); let attempts = 0;
  transport.reply = async () => { attempts++; throw apiDeliveryFailure(230099); };
  await replies.task(message, { id: 't', state: 'running', text: 'draft' });
  await replies.task(message, { id: 't', state: 'completed', text: 'answer' });
  assert.equal(attempts, 1); assert.equal(calls.at(-1)?.op, 'post'); assert.equal(calls.at(-1)?.text, 'answer');
});

test('rate-limited card references retain their card and do not create a fallback post', async () => {
  const { replies, transport, calls } = fixture();
  transport.reply = async () => { throw apiDeliveryFailure(230020); };
  await assert.rejects(replies.task(message, { id: 't', state: 'completed', text: 'answer' }));
  assert.deepEqual(calls.map(c => c.op), ['create']);
});
test('rejected final content closes the stale preview and delivers the answer as a post', async () => {
  const { replies, transport, calls } = fixture();
  await replies.task(message, { id: 't', state: 'running', text: 'draft' });
  transport.update = async () => { throw new Error('update rejected'); };
  await replies.task(message, { id: 't', state: 'completed', text: 'answer' });
  assert.equal(calls.find(c => c.op === 'close')?.text, 'draft');
  assert.equal(calls.at(-1)?.text, 'answer'); assert.equal(calls.at(-1)?.op, 'post');
});
test('long replies keep the beginning and end, and confirmed continuation posts are not repeated', async () => {
  const { replies, transport, calls } = fixture(); const post = transport.post; let attempts = 0;
  transport.post = async (...args) => { if (++attempts === 2) throw new Error('network'); await post(...args); };
  const text = 'START' + '中'.repeat(10000) + 'END';
  await assert.rejects(replies.task(message, { id: 't', state: 'completed', text }));
  await replies.task(message, { id: 't', state: 'completed', text });
  const delivered = calls.filter(c => c.op === 'update' || c.op === 'post').map(c => c.text).join('');
  assert.equal(delivered, text); assert.equal(calls.filter(c => c.op === 'close').length, 1);
});
test('closing failure does not duplicate an already accepted answer', async () => {
  const { replies, transport, calls } = fixture(); transport.close = async () => { throw new Error('close failed'); };
  await replies.task(message, { id: 't', state: 'completed', text: 'answer' });
  assert.equal(calls.filter(c => c.op === 'post').length, 0);
  await replies.forget(message, 't');
});
test('Markdown chunks preserve fenced code, Unicode and byte limits without truncation', () => {
  const chunks = splitReply('```ts\n' + 'const x = "😀";\n'.repeat(600) + '```\nEND');
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join('').split('const x').length - 1, 600);
  for (const chunk of chunks) {
    assert.ok(chunk.isWellFormed()); assert.ok(Buffer.byteLength(richPost(chunk)) < 28000);
    assert.equal((chunk.match(/^```/gm) ?? []).length % 2, 0);
  }
  assert.ok(chunks.at(-1)?.endsWith('END'));
});

test('a continued code line cannot turn inline backticks into a closing fence', () => {
  const chunks = splitReply('```raw\n' + 'x'.repeat(2993) + '```\n' + 'y'.repeat(100) + '\n```');
  assert.equal(chunks.length, 2);
  assert.match(chunks[1], /^```raw\nx+```\ny/);
  assert.equal((chunks[1].match(/^```/gm) ?? []).length, 2);
  assert.equal(chunks.join('').split('x').length - 1, 2993);
});

test('a long-running task still delivers its final answer after the remote stream expires', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
  const { replies, transport, calls } = fixture();
  const startedAt = Date.now(); const update = transport.update;
  transport.update = async (...args) => {
    // Simulate a remote card rejecting writes after a long silent tool execution.
    if (Date.now() - startedAt >= 3600000) throw apiDeliveryFailure(200850);
    await update(...args);
  };
  try {
    await replies.task(message, { id: 'long', state: 'running', text: 'starting' });
    t.mock.timers.tick(3600000);
    const answer = 'FINAL' + '中'.repeat(7000) + 'END';
    await replies.task(message, { id: 'long', state: 'completed', text: answer });
    assert.equal(calls.filter(c => c.op === 'post').map(c => c.text).join(''), answer);
    assert.equal(calls.filter(c => c.op === 'create').length, 1);
    assert.equal(calls.filter(c => c.op === 'close').length, 1);
    await replies.forget(message, 'long');
  } finally { t.mock.timers.reset(); }
});
