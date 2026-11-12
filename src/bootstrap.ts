/** 飞书绑定解析：手动配置与扫码绑定二选一；凭据持久化与恢复规则见 docs/design.md。 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export class SetupError extends Error {
  constructor(message: string) { super(message); this.name = 'SetupError'; }
}
const bindingSchema = z.object({
  version: z.literal(1), appId: z.string().min(1), appSecret: z.string().min(1),
  brand: z.enum(['feishu', 'lark']), ownerOpenId: z.string().min(1).optional(), botOpenId: z.string().min(1).optional(),
});
type Binding = z.infer<typeof bindingSchema>;
export type Registration = { client_id: string; client_secret: string; user_info?: { open_id?: string; tenant_brand?: 'feishu' | 'lark' } };
export type SetupServices = {
  register(signal?: AbortSignal): Promise<Registration>;
  botIdentity(appId: string, secret: string, signal?: AbortSignal): Promise<string>;
};
export type FeishuConfig = { FEISHU_APP_ID: string; FEISHU_APP_SECRET: string; FEISHU_BOT_OPEN_ID: string; ALLOWED_USERS: string };

function readBinding(path: string): Binding | undefined {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  try { return bindingSchema.parse(JSON.parse(text)); }
  catch { throw new SetupError('飞书绑定文件损坏或版本不受支持，请恢复该文件；不会自动创建新应用。'); }
}
function saveBinding(path: string, binding: Binding) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(binding), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** 解析飞书应用凭据与允许使用者：任一手动应用字段即选择手动模式（必须完整）；
 *  否则读取绑定文件，缺失时经官方设备授权扫码创建。checkOnly 只读不写、不发网络请求。 */
export async function resolveFeishu(env: NodeJS.ProcessEnv,
  options: { path: string; checkOnly?: boolean; signal?: AbortSignal }, services: SetupServices): Promise<FeishuConfig | undefined> {
  const present = (key: string) => env[key]?.trim() || undefined;
  const allowed = present('ALLOWED_USERS');
  const validUsers = (users?: string) => !!users?.split(',').some(x => x.trim());
  options.signal?.throwIfAborted();
  // Any manual app field selects manual mode; never mix credentials with a saved owner.
  if (['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BOT_OPEN_ID'].some(present)) {
    if (!present('FEISHU_APP_ID') || !present('FEISHU_APP_SECRET') || !present('FEISHU_BOT_OPEN_ID') || !validUsers(allowed)) {
      throw new SetupError('手动飞书配置不完整：需同时设置 App ID、App Secret、Bot open_id 和 ALLOWED_USERS；扫码模式请移除这三个应用字段。');
    }
    return { FEISHU_APP_ID: env.FEISHU_APP_ID!, FEISHU_APP_SECRET: env.FEISHU_APP_SECRET!, FEISHU_BOT_OPEN_ID: env.FEISHU_BOT_OPEN_ID!, ALLOWED_USERS: allowed! };
  }
  let binding = readBinding(options.path);
  if (!binding) {
    if (options.checkOnly) return;
    // Verify the local state directory can be written before creating a remote application.
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    const probe = `${options.path}.${randomUUID()}.probe`;
    writeFileSync(probe, '', { flag: 'wx', mode: 0o600 }); unlinkSync(probe);
    const registered = await services.register(options.signal);
    const parsed = bindingSchema.safeParse({ version: 1, appId: registered.client_id, appSecret: registered.client_secret,
      brand: registered.user_info?.tenant_brand ?? 'feishu', ownerOpenId: registered.user_info?.open_id || undefined });
    if (!parsed.success) throw new SetupError('飞书未返回有效应用凭据，绑定未完成。');
    binding = parsed.data;
    // Preserve credentials even if subsequent discovery fails or startup is cancelled.
    saveBinding(options.path, binding);
  }
  options.signal?.throwIfAborted();
  if (binding.brand !== 'feishu') throw new SetupError('当前仅支持飞书租户，不支持 Lark；已保留绑定文件，不会重建应用。');
  const users = allowed ?? binding.ownerOpenId;
  if (!validUsers(users)) throw new SetupError('飞书未返回扫码用户身份，请显式配置 ALLOWED_USERS 后重启；不会允许任意用户绑定。');
  if (!binding.botOpenId) {
    if (options.checkOnly) return;
    const botOpenId = await services.botIdentity(binding.appId, binding.appSecret, options.signal);
    if (!botOpenId.trim()) throw new SetupError('未获取到机器人 open_id，请检查应用的机器人能力。');
    binding = { ...binding, botOpenId };
    saveBinding(options.path, binding);
  }
  return { FEISHU_APP_ID: binding.appId, FEISHU_APP_SECRET: binding.appSecret,
    FEISHU_BOT_OPEN_ID: binding.botOpenId!, ALLOWED_USERS: users! };
}
