import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { Feishu } from '../src/feishu.ts';

const create = () => new Feishu('cli_0123456789abcdef', 'fixture-secret', 'bot', pino({ enabled: false }));
const hooks = (f: Feishu) => f.ws as unknown as { onReady(): void; onError(error: Error): void };

test('real SDK credential rejection fails startup without exposing its payload', async () => {
  const f = create();
  f.http.defaults.adapter = async config => ({ data: { code: 1000040340, msg: 'fixture-secret', data: {} },
    status: 200, statusText: 'OK', headers: {}, config });
  try {
    await assert.rejects(f.start(async () => {}), error => {
      assert.match(String(error), /connection/i); assert.doesNotMatch(String(error), /fixture-secret/); return true;
    });
  } finally { f.stop(); }
});

test('startup waits for readiness and a later fatal error closes the channel exactly once', async () => {
  const f = create(); let ready = false; let failures = 0;
  f.ws.start = async () => {};
  try {
    const started = f.start(async () => {}, { onFatal: () => { failures++; } }).then(() => { ready = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(ready, false);
    hooks(f).onReady(); await started; assert.equal(ready, true);
    hooks(f).onError(new Error('secret')); hooks(f).onError(new Error('secret'));
    assert.equal(failures, 1); assert.equal(f.ws.getConnectionStatus().state, 'idle');
  } finally { f.stop(); }
});

test('startup has a deadline and late readiness cannot revive it', async () => {
  const f = create(); f.ws.start = async () => {};
  try {
    await assert.rejects(f.start(async () => {}, { timeoutMs: 20 }), /connection/i);
    hooks(f).onReady(); assert.equal(f.ws.getConnectionStatus().state, 'idle');
  } finally { f.stop(); }
});

test('stop settles an in-flight startup without reporting a fatal error', async () => {
  const f = create(); let failures = 0; f.ws.start = async () => {};
  const started = f.start(async () => {}, { onFatal: () => { failures++; } });
  const rejected = assert.rejects(started, /stopped/i);
  f.stop(); await rejected; assert.equal(failures, 0);
});

test('invalid app ID fails before starting the SDK', async () => {
  const f = new Feishu('invalid', 'secret', 'bot', pino({ enabled: false })); let calls = 0;
  f.ws.start = async () => { calls++; };
  try { await assert.rejects(f.start(async () => {}), /app id/i); assert.equal(calls, 0); }
  finally { f.stop(); }
});
