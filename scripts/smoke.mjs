import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'dist/index.cjs');
const version = spawnSync(process.execPath, [entry, '--version'], {
  cwd: tmpdir(), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, encoding: 'utf8', timeout: 15000,
});
assert.equal(version.status, 0, version.error?.message ?? version.stdout + version.stderr);
assert.equal(version.stdout.trim(), JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version);
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  FEISHU_APP_ID: 'smoke-app', FEISHU_APP_SECRET: 'smoke-secret', FEISHU_BOT_OPEN_ID: 'smoke-bot',
  ALLOWED_USERS: 'smoke-user', WORKSPACE_ROOT: root,
  ANTHROPIC_BASE_URL: 'https://gateway.example.invalid',
};
const result = spawnSync(process.execPath, [entry, '--check'], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /Configuration and runtime dependency check passed/);
const fresh = mkdtempSync(resolve(tmpdir(), 'bridge-bundle-'));
const firstStart = spawnSync(process.execPath, [entry, '--check'], { cwd: root, env: {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WORKSPACE_ROOT: fresh,
  DATABASE_PATH: resolve(fresh, 'bridge.db'), ANTHROPIC_BASE_URL: '',
}, encoding: 'utf8', timeout: 15000 });
assert.equal(firstStart.status, 0, firstStart.error?.message ?? `${firstStart.stdout}\n${firstStart.stderr}`);
assert.match(firstStart.stdout, /Feishu binding required/);
assert.equal(existsSync(resolve(fresh, 'feishu-binding.json')), false);
console.log('Bundled entry, imports, configuration and external adapter resolution passed. No network or model calls.');
