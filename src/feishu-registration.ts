/** 飞书官方设备授权注册（createOnly）与机器人身份查询；二维码终端字符与 SVG 渲染。 */
import * as lark from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';
import { SetupError, type SetupServices } from './bootstrap.ts';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DefaultFeishuAppName } from './config.ts';

export function renderQRCode(url: string): string {
  const { modules } = QRCode.create(url, { errorCorrectionLevel: 'L' });
  const size = modules.size + 8;
  const dark = (x: number, y: number) => x >= 4 && y >= 4 && x < size - 4 && y < size - 4 && modules.get(y - 4, x - 4);
  const rows: string[] = [];
  // 整格模块降低日志字体半格错位的影响；每行独立设色，避免日志分行后丢失颜色状态。
  // 黑格也保留实心字形：查看器剥离 ANSI 时仍有字符图案，不会整张变成空格。
  const white = '\x1b[30;107m'; const black = '\x1b[30;40m'; const reset = '\x1b[0m';
  for (let y = 0; y < size; y++) {
    let row = white; let previousDark = false;
    for (let x = 0; x < size; x++) {
      const isDark = !!dark(x, y);
      if (isDark !== previousDark) row += isDark ? black : white;
      row += isDark ? '██' : '  ';
      previousDark = isDark;
    }
    rows.push(row + reset);
  }
  return rows.join('\n');
}

export function renderQRCodeSVG(url: string): string {
  const { modules } = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const size = modules.size + 8;
  let path = '';
  for (let y = 0; y < modules.size; y++) for (let x = 0; x < modules.size; x++) {
    if (modules.get(y, x)) path += `M${x + 4} ${y + 4}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="512" height="512" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${path}" fill="black"/></svg>`;
}

export function createSetupServices(write: (text: string) => void,
  dependencies: { register?: typeof lark.registerApp; fetch?: typeof fetch; qrCodePath?: string; appName?: string } = {}): SetupServices {
  const request = dependencies.fetch ?? fetch;
  async function api(path: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const response = await request(`https://open.feishu.cn/open-apis${path}`, { ...init, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
      if (!response.ok) throw new SetupError(`飞书身份查询 HTTP ${response.status}；已保存的应用凭据会在重启时复用。`);
      const body = await response.json() as Record<string, unknown>;
      if (!body || body.code !== 0) throw new SetupError(`飞书身份查询失败（code=${typeof body?.code === 'number' ? body.code : 'unknown'}），请检查应用发布状态和机器人能力。`);
      return body;
    } catch (error) {
      if (error instanceof SetupError) throw error;
      throw new SetupError('飞书身份查询中断或网络失败；已保存的应用凭据会在重启时复用。');
    }
  }
  return {
    async register(parentSignal) {
      const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000);
      signal.throwIfAborted();
      // registerApp has no HTTP-instance option. Scope cancellation to its two official endpoints.
      const interceptor = lark.defaultHttpInstance.interceptors.request.use(config => {
        if (/^https:\/\/accounts\.(feishu\.cn|larksuite\.com)\/oauth\/v1\/app\/registration$/.test(config.url ?? '')) {
          config.signal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
          config.timeout = 15000; config.maxRedirects = 0;
        }
        return config;
      });
      try {
        return await (dependencies.register ?? lark.registerApp)({
          source: 'agent-bridge', signal, createOnly: true,
          appPreset: { name: dependencies.appName?.trim() || DefaultFeishuAppName, desc: '飞书中的项目开发助手' },
          addons: { preset: false,
            scopes: { tenant: ['im:message:send_as_bot', 'im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message.reactions:write_only', 'cardkit:card:write'] },
            events: { items: { tenant: ['im.message.receive_v1'] } },
          },
          onQRCodeReady(info) {
            signal.throwIfAborted();
            write(`首次启动：请使用飞书完成绑定（${info.expireIn} 秒内有效）。\n授权链接：${info.url}\n`);
            if (dependencies.qrCodePath) {
              try {
                mkdirSync(dirname(dependencies.qrCodePath), { recursive: true });
                writeFileSync(dependencies.qrCodePath, renderQRCodeSVG(info.url), { mode: 0o600 });
                write(`清晰二维码图片：${dependencies.qrCodePath}（绑定结束后删除）。\n`);
              } catch { write('二维码图片未能保存，请使用上方授权链接。\n'); }
            }
            write(`二维码较宽，请展开日志区域，关闭时间戳和自动换行：\n${renderQRCode(info.url)}\n日志扫码不清晰时请使用上方授权链接或二维码图片。\n`);
          },
        });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (signal.aborted || code === 'abort') throw new SetupError('飞书扫码已取消或超时，重启服务后可重新扫码。');
        if (code === 'expired_token') throw new SetupError('飞书二维码已过期，请重启服务重新扫码。');
        if (code === 'access_denied') throw new SetupError('飞书授权被拒绝，请重启服务后重新授权。');
        throw new SetupError('飞书扫码注册失败，请检查网络和租户创建应用权限后重启。');
      } finally {
        lark.defaultHttpInstance.interceptors.request.eject(interceptor);
        if (dependencies.qrCodePath) {
          try { rmSync(dependencies.qrCodePath, { force: true }); } catch { /* Do not mask registration outcome. */ }
        }
      }
    },
    async botIdentity(appId, secret, signal) {
      signal?.throwIfAborted();
      const token = await api('/auth/v3/tenant_access_token/internal', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: appId, app_secret: secret }) }, signal);
      if (typeof token.tenant_access_token !== 'string' || !token.tenant_access_token) throw new SetupError('飞书未返回有效应用访问令牌。');
      const result = await api('/bot/v3/info', { headers: { Authorization: `Bearer ${token.tenant_access_token}` } }, signal);
      const bot = result.bot as { open_id?: unknown } | undefined;
      if (typeof bot?.open_id !== 'string' || !bot.open_id) throw new SetupError('飞书未返回机器人 open_id，请确认机器人能力已启用且应用已发布。');
      return bot.open_id;
    },
  };
}
