import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseConfigSchema, configSchema } from '../src/config.ts';
test('application name is optional, trims whitespace and keeps the default for blank values', () => {
  const valid = { WORKSPACE_ROOT: '.', ANTHROPIC_BASE_URL: 'https://gateway.example.com' };
  for (const name of [undefined, '', '   ']) {
    assert.equal(baseConfigSchema.parse({ ...valid, FEISHU_APP_NAME: name }).FEISHU_APP_NAME, 'AgentBridge');
  }
  assert.equal(baseConfigSchema.parse({ ...valid, FEISHU_APP_NAME: ' 项目助手 ' }).FEISHU_APP_NAME, '项目助手');
});
test('long tasks default to two hours and accept overrides up to one day', () => {
  const valid = { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 's', FEISHU_BOT_OPEN_ID: 'b', ALLOWED_USERS: 'u', WORKSPACE_ROOT: '.', ANTHROPIC_BASE_URL: 'https://gateway.example.com' };
  assert.equal(configSchema.parse(valid).TASK_TIMEOUT_MS, 7200000);
  assert.equal(configSchema.parse({ ...valid, TASK_TIMEOUT_MS: '10800000' }).TASK_TIMEOUT_MS, 10800000);
  for (const value of ['0', '86400001', 'NaN']) assert.equal(configSchema.safeParse({ ...valid, TASK_TIMEOUT_MS: value }).success, false);
});
test('configuration fails closed for empty allowlist and invalid limits', () => {
  const valid = { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 's', FEISHU_BOT_OPEN_ID: 'b', ALLOWED_USERS: ' u , v ', WORKSPACE_ROOT: '.', ANTHROPIC_BASE_URL: 'https://gateway.example.com' };
  assert.deepEqual(configSchema.parse(valid).ALLOWED_USERS, ['u', 'v']);
  assert.deepEqual(configSchema.parse(valid).ADMIN_USERS, []);
  assert.equal(configSchema.safeParse({ ...valid, ALLOWED_USERS: ' , ' }).success, false);
  assert.equal(configSchema.safeParse({ ...valid, TASK_TIMEOUT_MS: '-1' }).success, false);
});

test('gateway is optional and validates a configured HTTP(S) URL', () => {
  const required = { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 's', FEISHU_BOT_OPEN_ID: 'b', ALLOWED_USERS: 'u', WORKSPACE_ROOT: '.' };
  for (const value of [undefined, '', '   ']) {
    assert.equal(configSchema.parse({ ...required, ANTHROPIC_BASE_URL: value }).ANTHROPIC_BASE_URL, undefined);
  }
  for (const value of ['not-a-url', 'file:///tmp/gateway']) {
    assert.equal(configSchema.safeParse({ ...required, ANTHROPIC_BASE_URL: value }).success, false, String(value));
  }
  for (const value of ['https://gateway.example.com/anthropic', 'http://gateway:8080']) {
    assert.equal(configSchema.parse({ ...required, ANTHROPIC_BASE_URL: ' ' + value + ' ' }).ANTHROPIC_BASE_URL, value);
  }
});
