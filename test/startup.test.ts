import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('--version prints the package version without configuration or registration', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/main.ts', import.meta.url)), '--version'], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal(run.stdout.trim(), pkg.version);
});

test('fresh --check works without a gateway and writes no credentials', () => {
  const data = mkdtempSync(join(tmpdir(), 'bridge-startup-'));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/main.ts', import.meta.url)), '--check'], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WORKSPACE_ROOT: data,
      DATABASE_PATH: join(data, 'bridge.db') },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /Feishu binding required/);
  assert.equal(existsSync(join(data, 'feishu-binding.json')), false);
  assert.equal(existsSync(join(data, 'bridge.db')), false);
});

test('invalid model config fails before QR registration starts', () => {
  const data = mkdtempSync(join(tmpdir(), 'bridge-startup-'));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WORKSPACE_ROOT: data, DATABASE_PATH: join(data, 'bridge.db'), ANTHROPIC_BASE_URL: 'not-a-url' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(run.status, 1); assert.match(run.stdout, /ANTHROPIC_BASE_URL/);
  assert.equal(existsSync(join(data, 'feishu-binding.json')), false);
});

test('terminal connection failure after readiness shuts down the application with a nonzero exit', () => {
  const data = mkdtempSync(join(tmpdir(), 'bridge-startup-'));
  const feishu = new URL('../src/feishu.ts', import.meta.url).href;
  const main = new URL('../src/main.ts', import.meta.url).href;
  // Replace only the channel's network entry point; run real main/Store/Bridge cleanup.
  const source = `import { Feishu } from ${JSON.stringify(feishu)};
    Feishu.prototype.start = async function (_handle, options) {
      setImmediate(() => options.onFatal());
    };
    await import(${JSON.stringify(main)});`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WORKSPACE_ROOT: data,
      DATABASE_PATH: join(data, 'bridge.db'), ANTHROPIC_BASE_URL: 'https://gateway.example.invalid',
      FEISHU_APP_ID: 'cli_0123456789abcdef', FEISHU_APP_SECRET: 'fixture', FEISHU_BOT_OPEN_ID: 'bot', ALLOWED_USERS: 'u' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(run.status, 1, run.error?.message ?? run.stderr + run.stdout);
  assert.match(run.stdout, /AgentBridge started/); assert.match(run.stdout, /AgentBridge stopped/);
});
