/** 进程环境配置校验。完整 Schema 的飞书字段在绑定解析（bootstrap.ts）完成后才可用，
 *  启动早期先用 baseConfigSchema 校验网关与工作区。 */
import { z } from 'zod';
import { TaskLimits } from './task.ts';
import { DefaultDataRetentionMs } from './store.ts';
export const DefaultFeishuAppName = 'AgentBridge';
/** 逗号分隔的 open_id 列表；空白项被忽略。 */
const list = z.string().transform(s => s.split(',').map(x => x.trim()).filter(Boolean));
export const configSchema = z.object({
  FEISHU_APP_ID: z.string().min(1), FEISHU_APP_SECRET: z.string().min(1), FEISHU_BOT_OPEN_ID: z.string().min(1),
  // 仅作为首次扫码创建的名称建议；已有绑定不会因配置变化被重命名或重建。
  FEISHU_APP_NAME: z.string().trim().transform(name => name || DefaultFeishuAppName).default(DefaultFeishuAppName),
  // 首次扫码确认页是否提供“选择已有应用”入口；默认仅创建新应用，避免误改已有机器人。
  FEISHU_SELECT_EXISTING_APP: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  ANTHROPIC_BASE_URL: z.preprocess(
    value => typeof value === 'string' ? value.trim() || undefined : value,
    z.string().url().regex(/^https?:\/\//, 'Expected an HTTP(S) model gateway URL').optional(),
  ),
  ALLOWED_USERS: list.refine(a => a.length > 0, 'At least one allowed user required'),
  ADMIN_USERS: list.default([]),
  WORKSPACE_ROOT: z.string().min(1), WORKSPACE_PROJECT: z.string().default('.'),
  TASK_REPLY_MODE: z.enum(['auto', 'background', 'stream']).default('auto'),
  TASK_BACKGROUND_NOTICE_MS: z.coerce.number().int().min(1000).max(60000).default(TaskLimits.BackgroundNoticeDelayMs),
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().min(60000).max(7 * 24 * 60 * 60 * 1000).default(TaskLimits.SessionIdleTimeoutMs),
  CLAUDE_RUNTIME_CONFIG: z.string().trim().optional(),
  DATABASE_PATH: z.string().default('data/agentbridge.db'),
  // 启动时清理更早的去重、任务、结果与会话历史行；范围一天至一年。
  DATA_RETENTION_MS: z.coerce.number().int().min(24 * 60 * 60 * 1000).max(365 * 24 * 60 * 60 * 1000).default(DefaultDataRetentionMs),
  TASK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(TaskLimits.MaxTimeoutMs).default(TaskLimits.DefaultTimeoutMs),
  CANCEL_GRACE_MS: z.coerce.number().int().min(100).max(30000).default(5000),
});

/** 绑定解析前可校验的子集；飞书应用字段与使用者白名单来自扫码绑定或手动配置。 */
export const baseConfigSchema = configSchema.omit({ FEISHU_APP_ID: true, FEISHU_APP_SECRET: true, FEISHU_BOT_OPEN_ID: true, ALLOWED_USERS: true });
