import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSetupServices, renderQRCode } from '../src/feishu-registration.ts';
import * as lark from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('registration requests messaging, reactions and CardKit permissions', async () => {
  const output: string[] = [];
  const service = createSetupServices(text => output.push(text), {
    async register(options) {
      assert.equal(options.createOnly, true);
      assert.equal(options.appPreset?.name, 'AgentBridge');
      assert.equal(options.addons?.preset, false);
      assert.deepEqual(options.addons?.scopes?.tenant, ['im:message:send_as_bot', 'im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message.reactions:write_only', 'cardkit:card:write']);
      assert.deepEqual(options.addons?.events?.items?.tenant, ['im.message.receive_v1']);
      options.onQRCodeReady({ url: 'https://accounts.feishu.cn/verify?code=fixture', expireIn: 600 });
      return { client_id: 'cli_app', client_secret: 'never-log-this' };
    },
  });
  await service.register();
  assert.match(output.join(''), /accounts.feishu.cn/);
  assert.match(output.join(''), /[▀▄█]/);
  assert.doesNotMatch(output.join(''), /never-log-this/);
});

test('registration uses the configured application name', async () => {
  let requestedName: string | undefined;
  const service = createSetupServices(() => {}, { appName: '项目助手',
    async register(options) {
      requestedName = options.appPreset?.name;
      return { client_id: 'cli_app', client_secret: 'fixture-secret' };
    },
  });
  await service.register(); assert.equal(requestedName, '项目助手');
});

test('identity discovery obtains a tenant token and reads the bot without logging credentials', async () => {
  const requests: Array<{url:string;init?:RequestInit}> = [];
  const service = createSetupServices(() => {}, { fetch: async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json(requests.length === 1 ? { code: 0, tenant_access_token: 'fixture-token' } : { code: 0, bot: { open_id: 'ou_bot' } });
  } });
  assert.equal(await service.botIdentity('cli_app', 'secret'), 'ou_bot');
  assert.equal(requests[0].url, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
  assert.deepEqual(JSON.parse(requests[0].init!.body as string), { app_id: 'cli_app', app_secret: 'secret' });
  assert.equal(requests[1].url, 'https://open.feishu.cn/open-apis/bot/v3/info');
  assert.equal(new Headers(requests[1].init!.headers).get('Authorization'), 'Bearer fixture-token');
  assert.ok(requests.every(r => r.init?.signal && r.init.redirect === 'error'));
});

test('HTTP and API errors are sanitized and do not produce a usable identity', async () => {
  for (const response of [Response.json({ code: 99, msg: 'secret response' }), new Response('secret response', { status: 403 })]) {
    const service = createSetupServices(() => {}, { fetch: async () => response });
    await assert.rejects(service.botIdentity('app', 'secret'), error => {
      assert.doesNotMatch(String(error), /secret/); return true;
    });
  }
});

test('expired or rejected scans fail with actionable messages, without secrets', async () => {
  for (const code of ['expired_token', 'access_denied', 'unknown']) {
    const service = createSetupServices(() => {}, { register: async () => { throw { code, description: 'secret payload' }; } });
    await assert.rejects(service.register(), error => { assert.doesNotMatch(String(error), /secret/); return true; });
  }
});

test('pre-cancelled registration performs no request and cannot render a late QR code', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const service = createSetupServices(() => { throw new Error('unexpected QR'); }, { register: async () => { calls++; throw new Error('unexpected call'); } });
  await assert.rejects(service.register(controller.signal)); assert.equal(calls, 0);
});

test('log QR uses whole modules, explicit colors and four white modules of quiet zone', () => {
  const url = 'https://accounts.feishu.cn/verify?code=test';
  const { modules } = QRCode.create(url, { errorCorrectionLevel: 'L' });
  const qr = renderQRCode(url);
  assert.equal(qr, renderQRCode(url));
  assert.doesNotMatch(qr, /[▀▄]/);
  const rows = qr.split('\n');
  assert.equal(rows.length, modules.size + 8);
  for (const [y, row] of rows.entries()) {
    assert.ok(row.startsWith('\x1b[30;107m')); assert.ok(row.endsWith('\x1b[0m'));
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    assert.equal(plain.length, 2 * (modules.size + 8));
    for (let x = 0; x < modules.size + 8; x++) {
      const dark = x >= 4 && y >= 4 && x < modules.size + 4 && y < modules.size + 4 && modules.get(y - 4, x - 4);
      assert.equal(plain.slice(2 * x, 2 * x + 2), dark ? '██' : '  ');
    }
  }
});

test('registration writes a black-on-white SVG while pending and removes it on completion or failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-qr-'));
  const qrCodePath = join(dir, 'qr.svg');
  try {
    for (const fail of [false, true]) {
      const service = createSetupServices(() => {}, { qrCodePath, async register(options) {
        options.onQRCodeReady({ url: 'https://accounts.feishu.cn/verify?code=fixture', expireIn: 600 });
        const svg = readFileSync(qrCodePath, 'utf8');
        assert.match(svg, /fill="white"/); assert.match(svg, /fill="black"/);
        assert.match(svg, /viewBox=/); assert.doesNotMatch(svg, /verify\?code/);
        if (fail) throw { code: 'expired_token' };
        return { client_id: 'cli_app', client_secret: 'secret' };
      } });
      if (fail) await assert.rejects(service.register()); else await service.register();
      assert.equal(existsSync(qrCodePath), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real SDK registration receives cancellable bounded HTTP requests including the initial request', async () => {
  const previous = lark.defaultHttpInstance.defaults.adapter;
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let calls = 0;
  lark.defaultHttpInstance.defaults.adapter = async config => {
    calls++;
    assert.equal(config.timeout, 15000); assert.equal(config.maxRedirects, 0); assert.ok(config.signal);
    ready();
    return new Promise((_, reject) => {
      config.signal!.addEventListener!('abort', () => reject(new Error('request cancelled')), { once: true });
    });
  };
  try {
    const request = createSetupServices(() => { throw new Error('unexpected QR'); }).register(controller.signal);
    const rejected = assert.rejects(request, /取消|超时/);
    await started; controller.abort(); await rejected; assert.equal(calls, 1);
  } finally { controller.abort(); lark.defaultHttpInstance.defaults.adapter = previous; }
});
