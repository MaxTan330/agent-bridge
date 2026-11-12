/** 入口：校验配置和项目路径、组装实例、启动飞书长连接、响应退出信号。 */
import { pino } from 'pino';
import { baseConfigSchema, configSchema } from './config.ts';
import { workspacePath } from './workspace.ts';
import { Store } from './store.ts';
import { AcpRuntime } from './runtime.ts';
import { loadRuntimeConfig } from './runtime-config.ts';
import { Feishu } from './feishu.ts';
import { Bridge } from './bridge.ts';
import { accessSync } from 'node:fs';
import { errorFacts } from './diagnostics.ts';
import { dirname, join } from 'node:path';
import { resolveFeishu, SetupError } from './bootstrap.ts';
import { createSetupServices } from './feishu-registration.ts';
import { version } from './version.ts';

const log = pino();
async function main() {
  if (process.argv.includes('--version')) { console.log(version); return; }
  // 先校验基础配置（网关、工作区、超时）；飞书字段待绑定解析后由完整 Schema 二次校验。
  const parsed = baseConfigSchema.safeParse(process.env);
  if (!parsed.success) { log.error({ fields: parsed.error.issues.map(i => i.path.join('.')) }, 'Invalid configuration'); process.exitCode = 1; return; }
  const base = parsed.data;
  const cwd = workspacePath(base.WORKSPACE_ROOT, base.WORKSPACE_PROJECT);
  const runtime = new AcpRuntime(cwd, undefined, loadRuntimeConfig(base.CLAUDE_RUNTIME_CONFIG, cwd));
  accessSync(runtime.entry);
  const startup = new AbortController();
  let cleanup = async () => {};
  let closing = false;
  const stop = async () => {
    if (closing) return; closing = true;
    startup.abort(); await cleanup(); log.info('AgentBridge stopped');
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop().catch(error => { log.error({ ...errorFacts(error), stage: 'shutdown' }, 'Shutdown failed'); process.exitCode = 1; }); });
  try {
    const checkOnly = process.argv.includes('--check');
    const binding = await resolveFeishu(process.env, { path: join(dirname(base.DATABASE_PATH), 'feishu-binding.json'), checkOnly, signal: startup.signal },
      createSetupServices(text => process.stdout.write(text), {
        qrCodePath: join(dirname(base.DATABASE_PATH), 'feishu-qr.svg'), appName: base.FEISHU_APP_NAME,
        selectExistingApp: base.FEISHU_SELECT_EXISTING_APP,
      }));
    startup.signal.throwIfAborted();
    if (checkOnly) {
      log.info('Configuration and runtime dependency check passed');
      if (!binding) log.info('Feishu binding required on first normal startup; no network requests made');
      return;
    }
    const c = configSchema.parse({ ...process.env, ...binding });
    const db = new Store(c.DATABASE_PATH, c.DATA_RETENTION_MS);
    cleanup = async () => { await runtime.stop(); db.close(); };
    const channel = new Feishu(c.FEISHU_APP_ID, c.FEISHU_APP_SECRET, c.FEISHU_BOT_OPEN_ID, log);
    const bridge = new Bridge(db, runtime, channel, {
      users: c.ALLOWED_USERS, admins: c.ADMIN_USERS, workspace: cwd, taskTimeout: c.TASK_TIMEOUT_MS, cancelGrace: c.CANCEL_GRACE_MS,
      replyMode: c.TASK_REPLY_MODE,
      backgroundNoticeMs: c.TASK_BACKGROUND_NOTICE_MS,
      sessionIdleMs: c.SESSION_IDLE_TIMEOUT_MS,
    }, log);
    cleanup = async () => { channel.stop(); await bridge.stop(); db.close(); };
    await channel.start(m => bridge.handle(m), { onFatal: () => {
      process.exitCode = 1;
      void stop().catch(error => { log.error({ ...errorFacts(error), stage: 'shutdown' }, 'Shutdown failed'); });
    } });
    startup.signal.throwIfAborted();
    log.info({ version }, 'AgentBridge started');
  } catch (error) {
    if (closing && startup.signal.aborted) return;
    await stop(); throw error;
  }
}
main().catch(error => {
  log.error({ ...errorFacts(error), stage: 'startup' }, error instanceof SetupError ? error.message : 'Startup failed; verify configuration, workspace and network');
  process.exitCode = 1;
});
