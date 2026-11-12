import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

test('locked Claude adapter negotiates ACP on Node 26 without model calls', async () => {
  const entry = join(dirname(createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/package.json')), 'dist/index.js');
  const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, windowsHide: true });
  child.stderr.resume();
  const connection = client().connect(ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!)));
  child.on('error', e => connection.close(e));
  child.on('exit', () => connection.close());
  try {
    const result = await connection.agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
      { cancellationSignal: AbortSignal.timeout(10000), stopWaitingOnCancel: true });
    assert.equal(result.protocolVersion, PROTOCOL_VERSION);
    assert.equal(typeof result.agentCapabilities, 'object');
  } finally { connection.close(); child.kill(); }
});
