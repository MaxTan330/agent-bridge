import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { Feishu, normalizeInbound, normalizeMessage } from '../src/feishu.ts';
import { DeliveryError, isRetryableDelivery } from '../src/delivery-error.ts';
import type { Inbound } from '../src/types.ts';
const m: Inbound = { account: 'app', id: 'm', chat: 'c', thread: '', user: 'u', text: 'hello' };
const event = (text = 'hello', type = 'text', chat = 'p2p', bot = 'bot') => ({
  sender: { sender_type: 'user', sender_id: { open_id: 'u' } },
  message: { message_id: 'm', chat_id: 'c', chat_type: chat, message_type: type,
    content: JSON.stringify({ text }), mentions: [{ key: '@_user_1', id: { open_id: bot } }] },
});
const channel = () => new Feishu('app', 'secret', 'bot', pino({ level: 'silent' }));

test('progress and final answer update one shared card in the original thread', async () => {
  const f = channel(); const sent: any[] = []; const patched: any[] = []; const settings: any[] = [];
  f.client.cardkit.v1.card.create = async p => {
    assert.equal(p.data.type, 'card_json'); assert.equal(JSON.parse(p.data.data).config.streaming_mode, true);
    return { code: 0, data: { card_id: 'entity' } };
  };
  f.client.im.message.reply = async p => { sent.push(p); return { code: 0, data: { message_id: 'card' } }; };
  f.client.cardkit.v1.cardElement.content = async p => { patched.push(p); return { code: 0 }; };
  f.client.cardkit.v1.card.settings = async p => { settings.push(p); return { code: 0 }; };
  const message = { ...m, thread: 'thread' };
  await f.task(message, { id: 'task', state: 'running', text: 'first' });
  await f.task(message, { id: 'task', state: 'running', text: 'first second' });
  await f.task(message, { id: 'task', state: 'completed', text: '# Answer' });
  assert.equal(sent.length, 1); assert.equal(sent[0].data.reply_in_thread, true);
  assert.equal(sent[0].data.msg_type, 'interactive'); assert.equal(patched.length, 3);
  assert.deepEqual(JSON.parse(sent[0].data.content), { type: 'card', data: { card_id: 'entity' } });
  assert.ok(patched.every(p => p.path.card_id === 'entity' && p.path.element_id === 'content'));
  assert.equal(patched.at(-1).data.content, '# Answer');
  assert.deepEqual(patched.map(p => p.data.sequence), [1, 2, 3]);
  assert.equal(settings[0].data.sequence, 4);
  assert.equal(JSON.parse(settings[0].data.settings).config.streaming_mode, false);
  await f.forgetTask(message, 'task'); assert.equal(settings.length, 1);
});

test('an uncertain first card send retries the same UUID and initial payload before applying final text', async () => {
  const f = channel(); const sent: any[] = []; const patched: any[] = [];
  f.client.cardkit.v1.card.create = async () => ({ code: 0, data: { card_id: 'entity' } });
  f.client.cardkit.v1.card.settings = async () => ({ code: 0 });
  f.client.im.message.reply = async p => {
    sent.push(p);
    if (sent.length === 1) throw Object.assign(new Error('network'), { code: 'ECONNRESET' });
    return { code: 0, data: { message_id: 'card' } };
  };
  f.client.cardkit.v1.cardElement.content = async p => { patched.push(p); return { code: 0 }; };
  await assert.rejects(f.task(m, { id: 'task', state: 'running', text: 'preview' }));
  await f.task(m, { id: 'task', state: 'completed', text: 'answer' });
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(patched[0].data.content, 'answer');
});

test('typing uses a reaction on the user message and removes only that reaction', async () => {
  const f = channel(); const calls: any[] = [];
  f.client.im.messageReaction.create = async p => { calls.push(p); return { code: 0, data: { reaction_id: 'reaction' } }; };
  f.client.im.messageReaction.delete = async p => { calls.push(p); return { code: 0 }; };
  const id = await f.startTyping(m);
  await f.stopTyping(m, id!);
  assert.deepEqual(calls[0], { path: { message_id: m.id }, data: { reaction_type: { emoji_type: 'Typing' } } });
  assert.deepEqual(calls[1], { path: { message_id: m.id, reaction_id: 'reaction' } });
});

test('normalization rejects oversized and unsupported input without executing partial text', () => {
  assert.equal(normalizeInbound(event('a'.repeat(16001)), 'app', 'bot')?.text, '');
  assert.match(normalizeInbound(event('a'.repeat(16001)), 'app', 'bot')!.rejection!, /拆分/);
  assert.match(normalizeInbound(event('', 'image'), 'app', 'bot')!.rejection!, /文本/);
  assert.equal(normalizeMessage(event('', 'image'), 'app', 'bot'), undefined);
  assert.equal(normalizeMessage(event('a'.repeat(16001)), 'app', 'bot'), undefined);
  assert.equal(normalizeInbound(event('', 'image', 'group', 'other'), 'app', 'bot'), undefined);
  assert.equal(normalizeMessage(event('@_user_1 hello', 'text', 'group'), 'app', 'bot')?.text, 'hello');
  const bad = event(); bad.message.content = 'invalid';
  assert.equal(normalizeInbound(bad, 'app', 'bot'), undefined);
  assert.equal(normalizeMessage(event('a'.repeat(16000)), 'app', 'bot')?.text.length, 16000);
});
test('chunk retry preserves UUID and changes UUID with message/account/content', async () => {
  const f = channel(); const sent: any[] = [];
  f.client.im.message.reply = async p => { sent.push(p); return { code: 0 }; };
  await f.send(m, 'x'.repeat(6001)); await f.send(m, 'x'.repeat(6001));
  assert.deepEqual(sent.slice(0, 3).map(x => x.data.uuid), sent.slice(3).map(x => x.data.uuid));
  assert.equal(new Set(sent.slice(0, 3).map(x => x.data.uuid)).size, 3);
  assert.equal(sent.map(x => JSON.parse(x.data.content).zh_cn.content[0][0].text).slice(0, 3).join(''), 'x'.repeat(6001));
  await f.send(m, 'y'.repeat(6001)); await f.send({ ...m, account: 'other' }, 'x'.repeat(6001));
  await f.send({ ...m, id: 'other' }, 'x'.repeat(6001));
  assert.equal(new Set([sent[0], sent[6], sent[9], sent[12]].map(x => x.data.uuid)).size, 4);
});
test('abort between chunks stops delivery', async () => {
  const f = channel(); let calls = 0; const controller = new AbortController();
  f.client.im.message.reply = async () => { calls++; controller.abort(); return { code: 0 }; };
  await assert.rejects(f.send(m, 'x'.repeat(6000), controller.signal)); assert.equal(calls, 1);
});
test('transport receives real abort signal and stops remaining chunks', async () => {
  const f = channel(); f.client.disableTokenCache = true;
  const controller = new AbortController(); let calls = 0;
  f.http.defaults.adapter = async config => {
    calls++; assert.equal(config.signal, controller.signal);
    return await new Promise((_resolve, reject) => {
      config.signal!.addEventListener!('abort', () => reject(Object.assign(new Error('secret'), { code: 'ERR_CANCELED' })));
      controller.abort();
    });
  };
  await assert.rejects(f.send(m, 'x'.repeat(6000), controller.signal), e => e instanceof DeliveryError && !isRetryableDelivery(e));
  assert.equal(calls, 1);
});
test('delivery classification retries only explicit transient failures', () => {
  for (const error of [{ code: 'ECONNRESET' }, { code: 'EAI_AGAIN' }, { response: { status: 429 } },
    { response: { status: 503 } }, { response: { status: 400, data: { code: 230020 } } },
    new DeliveryError('api', true, 99991400)]) assert.equal(isRetryableDelivery(error), true);
  for (const error of [new Error('secret'), { code: 'ERR_CANCELED' }, { code: 'ECONNABORTED' },
    { response: { status: 403 } }, { response: { status: 400, data: { code: 230027 } } }])
    assert.equal(isRetryableDelivery(error), false);
});
test('API rate limit is retryable, permission error and timeout are permanent and sanitized', async () => {
  const f = channel(); let calls = 0;
  for (const [code, retryable] of [[230020, true], [99991400, true], [230027, false]] as const) {
    f.client.im.message.reply = async () => { calls++; return { code, msg: 'secret credential' }; };
    const before = calls;
    await assert.rejects(f.send(m, 'x'.repeat(6000)), e => e instanceof DeliveryError &&
      isRetryableDelivery(e) === retryable && !e.message.includes('secret'));
    assert.equal(calls - before, 1);
  }
  f.client.im.message.reply = async () => { calls++; throw Object.assign(new Error('credential'), { code: 'ECONNABORTED' }); };
  const before = calls;
  await assert.rejects(f.send(m, 'x'.repeat(6000)), e => e instanceof DeliveryError && !isRetryableDelivery(e));
  assert.equal(calls - before, 1);
});
test('parallel requests retain their own transport signals and separate instances', async () => {
  const f = channel(); const g = channel(); f.client.disableTokenCache = true;
  assert.notEqual(f.http, g.http);
  const a = new AbortController(); const b = new AbortController(); const signals: unknown[] = [];
  f.http.defaults.adapter = async config => {
    signals.push(config.signal);
    return { data: { code: 0 }, status: 200, statusText: 'OK', headers: {}, config };
  };
  await Promise.all([f.send(m, 'a', a.signal), f.send(m, 'b', b.signal)]);
  assert.deepEqual(signals, [a.signal, b.signal]);
});
test('chunks preserve emoji at a UTF-16 boundary', async () => {
  const f = channel(); const chunks: string[] = [];
  f.client.im.message.reply = async p => { chunks.push(JSON.parse(p.data.content).zh_cn.content[0][0].text); return { code: 0 }; };
  const text = 'x'.repeat(2999) + '😀end';
  await f.send(m, text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(x => x.isWellFormed()));
});
test('untrusted senders and group input without bot mention remain ignored', () => {
  const e = event('a'.repeat(16001)); e.sender.sender_type = 'bot';
  assert.equal(normalizeInbound(e, 'app', 'bot'), undefined);
  assert.equal(normalizeInbound(event('a'.repeat(16001), 'text', 'group', 'other'), 'app', 'bot'), undefined);
});
