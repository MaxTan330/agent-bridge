import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntimeConfig } from '../src/runtime-config.ts';

test('runtime config accepts explicit native MCP and budget settings without reading a file by default', () => {
  assert.deepEqual(loadRuntimeConfig(undefined, '.'), {});
  const dir = mkdtempSync(join(tmpdir(), 'native-config-'));
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ mcpServers: [{ type: 'http', name: 'docs', url: 'https://example.test/mcp', headers: [] }], maxTurns: 40, maxBudgetUsd: 5 }));
  const config = loadRuntimeConfig('runtime.json', dir);
  assert.equal(config.mcpServers?.[0].name, 'docs'); assert.equal(config.maxTurns, 40);
});

test('invalid runtime config fails without exposing credential contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-config-')); const path = join(dir, 'runtime.json');
  for (const data of ['{"secret":"do-not-log"', JSON.stringify({ maxTurns: -1 }), JSON.stringify({ settings: { permissions: { allow: ['*'] } } }), JSON.stringify({ mcpServers: [{ type: 'http', name: 'bad', url: 'file:///secret', headers: [] }] })]) {
    writeFileSync(path, data);
    assert.throws(() => loadRuntimeConfig(path, dir), error => error instanceof Error && /Invalid Claude runtime configuration/.test(error.message) && !error.message.includes('do-not-log'));
  }
});
