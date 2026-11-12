import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFeishu, SetupError, type SetupServices } from '../src/bootstrap.ts';

const location = () => join(mkdtempSync(join(tmpdir(), 'bridge-setup-')), 'binding.json');
const result = { client_id: 'cli_app', client_secret: 'fixture-secret', user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' as const } };
const services = (overrides: Partial<SetupServices> = {}): SetupServices => ({
  async register() { return result; }, async botIdentity() { return 'ou_bot'; }, ...overrides,
});

test('first scan saves credentials before lookup and binds only the scanning user', async () => {
  const path = location();
  const resolved = await resolveFeishu({}, { path }, services({ async botIdentity(appId, secret) {
    assert.equal(appId, result.client_id); assert.equal(secret, result.client_secret);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).appSecret, secret);
    return 'ou_bot';
  } }));
  assert.deepEqual(resolved, { FEISHU_APP_ID: 'cli_app', FEISHU_APP_SECRET: 'fixture-secret', FEISHU_BOT_OPEN_ID: 'ou_bot', ALLOWED_USERS: 'ou_owner' });
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('restart reuses completed binding without registration or HTTP requests', async () => {
  const path = location(); await resolveFeishu({}, { path }, services());
  const unexpected = async () => { throw new Error('unexpected external operation'); };
  const resolved = await resolveFeishu({}, { path }, services({ register: unexpected, botIdentity: unexpected }));
  assert.equal(resolved?.ALLOWED_USERS, 'ou_owner');
});

test('failed bot lookup preserves registration and resumes on next start', async () => {
  const path = location(); let registrations = 0;
  const register = async () => { registrations++; return result; };
  await assert.rejects(resolveFeishu({}, { path }, services({ register, async botIdentity() { throw new Error('network'); } })));
  await resolveFeishu({}, { path }, services({ register }));
  assert.equal(registrations, 1);
});

test('missing scan identity is persisted but never opens the allowlist; explicit owner can recover', async () => {
  const path = location(); let registrations = 0;
  const register = async () => { registrations++; return { ...result, user_info: undefined }; };
  await assert.rejects(resolveFeishu({}, { path }, services({ register })), SetupError);
  assert.ok(existsSync(path));
  const config = await resolveFeishu({ ALLOWED_USERS: 'ou_manual' }, { path }, services({ register }));
  assert.equal(config?.ALLOWED_USERS, 'ou_manual'); assert.equal(registrations, 1);
});

test('corrupted binding fails closed without creating a replacement application', async () => {
  const path = location(); writeFileSync(path, '{broken');
  let registrations = 0;
  await assert.rejects(resolveFeishu({}, { path }, services({ async register() { registrations++; return result; } })), SetupError);
  assert.equal(registrations, 0);
});

test('manual credentials must be complete and cannot inherit a saved owner from another app', async () => {
  const path = location(); await resolveFeishu({}, { path }, services());
  await assert.rejects(resolveFeishu({ FEISHU_APP_ID: 'cli_other', FEISHU_APP_SECRET: 'secret' }, { path }, services()), SetupError);
  const manual = { FEISHU_APP_ID: 'cli_other', FEISHU_APP_SECRET: 'secret', FEISHU_BOT_OPEN_ID: 'ou_otherbot', ALLOWED_USERS: 'ou_other' };
  assert.deepEqual(await resolveFeishu(manual, { path }, services()), manual);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).appId, 'cli_app');
});

test('check-only startup neither registers nor resolves pending bot identity', async () => {
  const path = location();
  const unexpected = async () => { throw new Error('unexpected external operation'); };
  const deps = services({ register: unexpected, botIdentity: unexpected });
  assert.equal(await resolveFeishu({}, { path, checkOnly: true }, deps), undefined);
  assert.equal(existsSync(path), false);
  writeFileSync(path, JSON.stringify({ version: 1, appId: 'cli_app', appSecret: 'secret', ownerOpenId: 'ou_owner', brand: 'feishu' }));
  assert.equal(await resolveFeishu({}, { path, checkOnly: true }, deps), undefined);
});

test('cancelled startup does not register or write binding', async () => {
  const path = location(); const controller = new AbortController(); controller.abort();
  let registrations = 0;
  await assert.rejects(resolveFeishu({}, { path, signal: controller.signal }, services({ async register() { registrations++; return result; } })));
  assert.equal(registrations, 0); assert.equal(existsSync(path), false);
});

test('Lark tenant is retained but rejected rather than sending credentials to Feishu endpoints', async () => {
  const path = location(); let lookups = 0;
  await assert.rejects(resolveFeishu({}, { path }, services({ async register() { return { ...result, user_info: { open_id: 'ou_owner', tenant_brand: 'lark' } }; }, async botIdentity() { lookups++; return 'ou_bot'; } })), SetupError);
  assert.equal(lookups, 0); assert.ok(existsSync(path));
});
