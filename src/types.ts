/** 跨模块共享的核心契约：规范化入站消息、回复渠道接口与 ACP 运行时接口。
 *  依赖一律构造函数注入，接口集中在此以便测试以替身实现。 */
import type { RequestPermissionRequest, RequestPermissionResponse, McpServer } from '@agentclientprotocol/sdk';
import type { TaskReplyState } from './task.ts';

/** 进入 Bridge 的规范化消息，由 feishu.ts 从平台事件归一化产生。 */
export interface Inbound {
  /** 飞书 App ID；参与消息去重键与会话键。 */
  account: string;
  /** 飞书 chat_id。 */
  chat: string;
  /** 话题 id；非话题消息使用空字符串，保证会话键始终可拼装。 */
  thread: string;
  /** 发送者 open_id，白名单鉴权依据。 */
  user: string;
  /** 飞书 message_id；用于去重、表情反馈与回复定位。 */
  id: string;
  /** 去除 mention 占位后的指令文本；控制命令（/cancel 等）原样进入。 */
  text: string;
  /** 非空表示输入被拒绝：仅以该文案回复用户，绝不进入 Agent 执行。 */
  rejection?: string;
  attachment?: { type: 'image' | 'file'; key: string; name?: string };
}

/** 任务回复；state 为运行态时是流式进度，为终态时 text 是最终结果。 */
export interface TaskReply {
  /** 任务 ID，同时是渠道侧流式卡片状态的键。 */
  id: string;
  state: TaskReplyState;
  text: string;
  /** 附注（如原会话无法恢复），拼在最终文本之后投递。 */
  note?: string;
}

/** Bridge 对消息渠道的依赖；生产实现见 feishu.ts，测试以内联替身满足。 */
export type PromptAttachment = { type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string };
export interface Channel {
  prepare?(message: Inbound, signal: AbortSignal): Promise<PromptAttachment[]>;
  /** 发送富文本消息（自动分片）；signal 中止后停止发送剩余分片。 */
  send(message: Inbound, text: string, signal?: AbortSignal): Promise<void>;
  /** 流式任务回复；实现负责 CardKit 卡片生命周期与富文本降级。 */
  task?(message: Inbound, reply: TaskReply, signal?: AbortSignal): Promise<void>;
  /** 任务结束后清理渠道侧状态（如关闭未完成的流式卡片）。 */
  forgetTask?(message: Inbound, id: string): void | Promise<void>;
  /** 在用户原消息上添加 Typing 表情，返回表情 id 供移除。 */
  startTyping?(message: Inbound, signal?: AbortSignal): Promise<string | undefined>;
  /** 移除 startTyping 返回的表情。 */
  stopTyping?(message: Inbound, reaction: string, signal?: AbortSignal): Promise<void>;
}

/** Bridge 对 ACP 运行时的依赖；生产实现见 runtime.ts，测试以替身满足。 */
export type RuntimeEvent = { type: 'capabilities'; steering: boolean; image: boolean; [key: string]: unknown }
  | { type: 'update'; update: Record<string, unknown> } | { type: 'config'; options: unknown[] };
export interface AgentQuestion { sessionId: string; message: string; requestedSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }
export interface QuestionAnswer { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> }
export interface RuntimeHooks {
  onEvent?: (event: RuntimeEvent) => void;
  onQuestion?: (question: AgentQuestion, signal?: AbortSignal) => Promise<QuestionAnswer>;
  mode?: 'plan' | 'bypassPermissions'; model?: string; effort?: string;
}
export interface RuntimeOptions { mcpServers?: McpServer[]; maxTurns?: number; maxBudgetUsd?: number }
export interface Runtime {
  /**
   * 启动 Adapter 进程并建立免审批会话，返回 session ID。
   * @param oldSessionId 上一轮持久化的会话 ID；存在且 Agent 支持时优先恢复
   * @param onProgress 收到 Agent 文本增量时回调，用于流式进度
   * @param onPermission 免审批模式下只会收到意外请求；返回 cancelled 即终止任务
   * @param signal 取消信号；中止启动各协议步骤并触发进程清理
   */
  open(oldSessionId: string | undefined, onProgress: (text: string) => void,
    onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>, signal?: AbortSignal, hooks?: RuntimeHooks): Promise<string>;
  steer?(session: string, text: string): Promise<'injected' | 'promptRequired'>;
  /** 在已建立会话上执行一轮 prompt，等整轮结束并返回 stopReason。 */
  prompt(session: string, text: string, attachments?: PromptAttachment[]): Promise<string>;
  /** 通知 Agent 取消当前执行；不等待确认，超时由 stop() 强制清理兜底。 */
  cancel(session: string): Promise<void>;
  /** 终止 Adapter 及其进程组；可重入，清理失败时保留句柄供再次调用。 */
  stop(): Promise<void>;
}
