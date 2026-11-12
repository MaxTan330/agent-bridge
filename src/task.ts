/** 任务领域值集中定义；as const 对象 + 派生联合类型（不用 enum 关键字），
 *  兼容 Node 原生 TypeScript 的可擦除语法与 tsconfig 的 erasableSyntaxOnly。 */
export const TaskState = {
  Running: 'running', Completed: 'completed', Failed: 'failed', Cancelled: 'cancelled', Interrupted: 'interrupted',
} as const;
export type TaskState = typeof TaskState[keyof typeof TaskState];
export type TaskTerminalState = Exclude<TaskState, typeof TaskState.Running>;
export type TaskReplyState = Exclude<TaskState, typeof TaskState.Interrupted>;

/** 内存中的执行阶段比持久化终态更细，用于 /status，不表示进度百分比。 */
export const TaskPhase = {
  Starting: 'starting', Executing: 'executing', Cancelling: 'cancelling', Delivering: 'delivering',
} as const;
export type TaskPhase = typeof TaskPhase[keyof typeof TaskPhase];
export const TaskPhaseLabel: Record<TaskPhase, string> = {
  [TaskPhase.Starting]: '准备中', [TaskPhase.Executing]: '执行中',
  [TaskPhase.Cancelling]: '取消中', [TaskPhase.Delivering]: '结果发送与清理中',
};

/** 执行成功与结果送达独立记录，避免发送失败触发重复执行。 */
export const DeliveryState = { Pending: 'pending', Sent: 'sent', Failed: 'failed' } as const;
export type DeliveryState = typeof DeliveryState[keyof typeof DeliveryState];

/** ACP prompt 的 stopReason；Bridge 只需区分取消与其余结束原因。 */
export const StopReason = { Cancelled: 'cancelled' } as const;

export const ChatCommand = { Cancel: '/cancel', New: '/new', Result: '/result', Status: '/status' } as const;
const controlCommands = new Set<string>(Object.values(ChatCommand));
export const isControlCommand = (text: string): boolean => controlCommands.has(text);

export const TaskLimits = {
  DefaultTimeoutMs: 2 * 60 * 60 * 1000,
  MaxTimeoutMs: 24 * 60 * 60 * 1000,
  OutputCodePoints: 24000,
  ProgressIntervalMs: 250,
  FeedbackTimeoutMs: 3000,
} as const;

/** 仅展示实际经过时间，不从文字输出频率推断工具是否卡住。 */
export function elapsedText(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${Math.floor(seconds / 60)} 分钟 ${seconds % 60} 秒`;
}
