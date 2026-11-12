import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import pino from 'pino';
import { Feishu, normalizeInbound } from '../src/feishu.ts';

const event = (type: string, content: unknown) => ({
  sender: { sender_type: 'user', sender_id: { open_id: 'u' } },
  message: {
    message_id: 'm', chat_id: 'c', chat_type: 'p2p', message_type: type,
    content: JSON.stringify(content),
  },
});
const input = (type = 'file') => normalizeInbound(
  event(type, type === 'image' ? { image_key: 'key' } : { file_key: 'key', file_name: 'note.txt' }),
  'app', 'bot',
)!;
const channel = () => new Feishu('app', 'secret', 'bot', pino({ level: 'silent' }));

function mock(f: Feishu, stream: Readable) {
  f.client.im.messageResource.get = async p => {
    assert.deepEqual(p, {
      path: { message_id: 'm', file_key: 'key' },
      params: { type: input().attachment!.type },
    });
    return { getReadableStream: () => stream, writeFile: async () => {}, headers: {} };
  };
}

test('attachment normalization retains metadata only', () => {
  assert.deepEqual(input().attachment, { type: 'file', key: 'key', name: 'note.txt' });
  assert.deepEqual(input('image').attachment, { type: 'image', key: 'key' });
  assert.ok(normalizeInbound(event('audio', {}), 'app', 'bot')?.rejection);
});

test('UTF8 file prepared in memory through SDK resource method', async () => {
  const f = channel();
  mock(f, Readable.from([Buffer.from('hello 世界')]));
  assert.deepEqual(await f.prepare(input(), new AbortController().signal), [
    { type: 'text', text: 'Attached file: note.txt\n\nhello 世界' },
  ]);
});

for (const [name, data] of [
  ['invalid UTF8', Buffer.from([255])],
  ['binary', Buffer.from([0, 1, 2])],
  ['oversized', Buffer.alloc(256 * 1024 + 1, 65)],
] as const) test(`rejects ${name}`, async () => {
  const f = channel();
  const stream = Readable.from([data]);
  mock(f, stream);
  await assert.rejects(f.prepare(input(), new AbortController().signal));
  assert.equal(stream.destroyed, true);
});

test('abort interrupts stalled stream and destroys it', async () => {
  const f = channel();
  const stream = new PassThrough();
  mock(f, stream);
  const abort = new AbortController();
  const pending = f.prepare(input(), abort.signal);
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(pending);
  assert.equal(stream.destroyed, true);
});

test('image uses magic bytes and rejects unsupported or oversized data', async () => {
  for (const data of [
    Buffer.from('not an image'),
    Buffer.alloc(5 * 1024 * 1024 + 1),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  ]) {
    const f = channel();
    f.client.im.messageResource.get = async () => ({
      getReadableStream: () => Readable.from([data]), writeFile: async () => {}, headers: {},
    });
    if (data.length === 8) {
      assert.deepEqual(await f.prepare(input('image'), new AbortController().signal), [
        { type: 'image', data: data.toString('base64'), mimeType: 'image/png' },
      ]);
    } else {
      await assert.rejects(f.prepare(input('image'), new AbortController().signal));
    }
  }
});

test('custom HTTP transport preserves download headers and stream', async () => {
  const f = channel();
  const stream = Readable.from([Buffer.from('hello')]);
  f.http.defaults.adapter = async config => ({
    config, data: stream, headers: { 'content-type': 'text/plain' }, status: 200, statusText: 'OK',
  });
  (f.client as any).tokenManager.getTenantAccessToken = async () => 'token';
  assert.deepEqual(await f.prepare(input(), new AbortController().signal), [
    { type: 'text', text: 'Attached file: note.txt\n\nhello' },
  ]);
});

test('stream limits count multiple chunks and accept exact boundary', async () => {
  for (const length of [256 * 1024, 256 * 1024 + 1]) {
    const f = channel();
    const stream = Readable.from([Buffer.alloc(128 * 1024, 65), Buffer.alloc(length - 128 * 1024, 65)]);
    mock(f, stream);
    if (length === 256 * 1024) {
      assert.ok((await f.prepare(input(), new AbortController().signal))[0]);
    } else {
      await assert.rejects(f.prepare(input(), new AbortController().signal), /256 KiB/);
    }
    assert.equal(stream.destroyed, true);
  }
});

test('pre-aborted preparation avoids request and late abort destroys obtained stream', async () => {
  const f = channel();
  const abort = new AbortController();
  abort.abort();
  f.client.im.messageResource.get = async () => { throw Error('must not download'); };
  await assert.rejects(f.prepare(input(), abort.signal), { name: 'AbortError' });
  const stream = new PassThrough();
  const late = new AbortController();
  f.client.im.messageResource.get = async () => {
    late.abort();
    return { getReadableStream: () => stream, writeFile: async () => {}, headers: {} };
  };
  await assert.rejects(f.prepare(input(), late.signal), { name: 'AbortError' });
  assert.equal(stream.destroyed, true);
});

test('download transport receives cancellation and sanitizes errors', async () => {
  const f = channel();
  const abort = new AbortController();
  f.http.defaults.adapter = async config => {
    assert.equal(config.signal, abort.signal);
    throw Error('secret response body');
  };
  (f.client as any).tokenManager.getTenantAccessToken = async () => 'token';
  await assert.rejects(f.prepare(input(), abort.signal), error =>
    error instanceof Error && error.message.includes('权限') && !error.message.includes('secret'));
});

test('known image signatures use actual content MIME and metadata cannot bypass group mentions', async () => {
  for (const [data, mimeType] of [
    [Buffer.from([255, 216, 255]), 'image/jpeg'],
    [Buffer.from('GIF89a'), 'image/gif'],
    [Buffer.from('RIFF0000WEBP'), 'image/webp'],
  ] as const) {
    const f = channel();
    f.client.im.messageResource.get = async () => ({
      getReadableStream: () => Readable.from([data]), writeFile: async () => {}, headers: {},
    });
    const [block] = await f.prepare(input('image'), new AbortController().signal);
    assert.equal(block.type, 'image');
    if (block.type === 'image') assert.equal(block.mimeType, mimeType);
  }
  const raw = event('image', { image_key: 'key' });
  raw.message.chat_type = 'group';
  assert.equal(normalizeInbound(raw, 'app', 'bot'), undefined);
  assert.ok(normalizeInbound(event('file', { file_key: 3 }), 'app', 'bot')?.rejection);
});
