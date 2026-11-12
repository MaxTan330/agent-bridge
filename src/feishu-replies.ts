/** CardKit 流式生命周期、富文本降级、Markdown 分片与续发去重。 */
import { createHash } from 'node:crypto';
import { DeliveryError } from './delivery-error.ts';
import type { Inbound, TaskReply } from './types.ts';
import { TaskState, TaskLimits } from './task.ts';

const id = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
// Do not interpret model-produced text as Feishu mention recipients.
const markdown = (text: string) => text.replace(/<(?=\/?at\b)/gi, '&lt;');
/** 富文本 post 消息体；内部转义 at 标签防止模型文本 @人。 */
export function richPost(text: string): string {
  return JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: markdown(text) }]] } });
}
/** 卡片正文元素 id；此处定义与 feishu.ts 的内容更新共用，两处必须一致。 */
export const ContentElementId = 'content';
/** 流式卡片初始 card_json；正文经 cardElement.content 增量写入。 */
export function streamCard(): string {
  return JSON.stringify({ schema: '2.0', config: { streaming_mode: true,
    summary: { content: '…' }, streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 1 } } },
    body: { elements: [{ tag: 'markdown', element_id: ContentElementId, content: '' }] } });
}
/**
 * 将回复按每片最多 3,000 个 Unicode 码点切分，优先在后半段的换行处断开。
 * 跨段代码围栏先补闭合、下一片再重新打开（含语言标记）；
 * 切点若紧跟“行内反引号/波浪线后缀”会前移，避免重开的围栏被误当作闭合。
 * 这不是完整 Markdown 语法树切分：极长表格或行内标记跨段可能影响渲染格式。
 */
export function splitReply(text: string): string[] {
  const chars = Array.from(text); const chunks: string[] = [];
  let offset = 0; let fence: { marker: string; language: string } | undefined;
  while (offset < chars.length) {
    const prefix = fence ? `${fence.marker}${fence.language}\n` : '';
    let end = Math.min(offset + 3000, chars.length);
    if (end < chars.length) {
      const boundary = chars.slice(offset, end).lastIndexOf('\n');
      if (boundary >= 1500) end = offset + boundary + 1;
      // Keep an inline fence-like suffix with a preceding source character.
      // Otherwise reopening a code block could turn that suffix into a closing fence.
      if (chars[end - 1] !== '\n' && /^ {0,3}(`{3,}|~{3,})/.test(chars.slice(end, end + 7).join(''))) {
        let safe = end - 1;
        while (safe > offset && /[ `~]/.test(chars[safe])) safe--;
        if (safe > offset && chars[safe] !== '\n') end = safe;
      }
    }
    const part = chars.slice(offset, end).join('');
    const lines = part.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (index === 0 && offset > 0 && chars[offset - 1] !== '\n') continue;
      const line = lines[index];
      const match = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
      if (!match) continue;
      if (fence) {
        if (match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length && !match[2].trim()) fence = undefined;
      } else if (match[1].length <= 64 && match[2].length <= 64) {
        fence = { marker: match[1], language: match[2] };
      }
    }
    chunks.push(prefix + part + (fence ? `\n${fence.marker}` : ''));
    offset = end;
  }
  return chunks;
}

/** 渠道侧的原语操作，由 feishu.ts 绑定到飞书 API；此处只编排生命周期。 */
export type ReplyTransport = {
  /** 创建流式卡片，返回 card_id。 */
  create(signal?: AbortSignal): Promise<string>;
  /** 发送卡片引用消息，返回消息 id；uuid 稳定以支持幂等重试。 */
  reply(message: Inbound, card: string, uuid: string, signal?: AbortSignal): Promise<string>;
  /** 写入卡片正文；sequence 必须单调递增。 */
  update(card: string, text: string, sequence: number, uuid: string, signal?: AbortSignal): Promise<void>;
  /** 关闭流式状态并写入摘要（最多 100 码点）。 */
  close(card: string, text: string, sequence: number, uuid: string, signal?: AbortSignal): Promise<void>;
  /** 发送富文本分片；uuid 稳定以支持幂等重试。 */
  post(message: Inbound, text: string, uuid: string, signal?: AbortSignal): Promise<void>;
};
/** 单个任务回复的渠道侧状态；仅存在于当前任务内存，不跨重启。 */
type ReplyState = {
  /** 已创建的卡片 id。 */
  card?: string;
  /** 卡片引用消息的 message_id。 */
  message?: string;
  /** 卡片操作序号，单调递增。 */
  sequence: number;
  /** 平台已确认写入卡片的正文。 */
  accepted: string;
  /** 已降级为富文本，不再尝试任何卡片操作。 */
  fallback: boolean;
  /** 卡片流式状态已关闭。 */
  closed: boolean;
  /** 已确认送达的富文本分片 uuid；失败续发从未确认分片继续。 */
  posted: Set<string>;
};

export class FeishuReplies {
  // accepted 只记录平台确认写入的正文；fallback 后不能用本地最新文本冒充已送达。
  // posted 保存已确认分片，避免长回复中途失败后从头重复发送。
  private readonly tasks = new Map<string, ReplyState>();
  private transport: ReplyTransport;
  private warn: (stage: string, error: unknown) => void;
  constructor(transport: ReplyTransport, warn: (stage: string, error: unknown) => void) {
    this.transport = transport; this.warn = warn;
  }
  private key(m: Inbound, task: string) { return JSON.stringify([m.account, m.chat, m.id, task]); }
  private async close(state: ReplyState, signal?: AbortSignal) {
    if (!state.card || !state.message || state.closed) return;
    const sequence = ++state.sequence;
    try {
      await this.transport.close(state.card, state.accepted, sequence, id(state.card, 'close', sequence), signal);
      state.closed = true;
    } catch (error) { this.warn('stream-close', error); }
  }
  async forget(m: Inbound, task: string) {
    const key = this.key(m, task); const state = this.tasks.get(key);
    try { if (state) await this.close(state, AbortSignal.timeout(TaskLimits.FeedbackTimeoutMs)); }
    finally { this.tasks.delete(key); }
  }
  private async posts(m: Inbound, text: string, chunks: string[], start: number, signal?: AbortSignal, state?: ReplyState) {
    for (let index = start; index < chunks.length; index++) {
      signal?.throwIfAborted();
      const uuid = id(m.account, m.id, 'post', text, index);
      if (state?.posted.has(uuid)) continue;
      await this.transport.post(m, chunks[index], uuid, signal);
      state?.posted.add(uuid);
    }
  }
  /** 发送富文本（控制回复、/result 取回等非任务路径）。 */
  async send(m: Inbound, text: string, signal?: AbortSignal) {
    await this.posts(m, text, splitReply(text), 0, signal);
  }
  /** 投递一次任务回复：进度只更新卡片首片；终态关闭卡片并续发剩余分片。
   *  阶梯：创建卡片 → 发送引用 → 写正文；任一步失败按错误类别降级或抛出。 */
  async task(m: Inbound, reply: TaskReply, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const key = this.key(m, reply.id);
    let state = this.tasks.get(key);
    if (!state) {
      state = { sequence: 0, accepted: '', fallback: false, closed: false, posted: new Set() };
      this.tasks.set(key, state);
    }
    const final = reply.state !== TaskState.Running;
    const text = [reply.text, reply.note].filter(Boolean).join('\n\n');
    const chunks = splitReply(text);
    if (!chunks.length) return;
    if (!state.fallback && !state.card) {
      try { state.card = await this.transport.create(signal); }
      catch (error) {
        signal?.throwIfAborted(); state.fallback = true; this.warn('stream-create', error);
      }
    }
    if (!state.fallback && state.card && !state.message) {
      // An uncertain send must retry the same card reference and UUID, not create another visible reply.
      try { state.message = await this.transport.reply(m, state.card, id(key, 'card'), signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof DeliveryError) || error.category !== 'api' || error.retryable) throw error;
        state.fallback = true; this.warn('stream-reply', error);
      }
    }
    if (!state.fallback && !state.closed && state.card && state.accepted !== chunks[0]) {
      const sequence = ++state.sequence;
      try {
        await this.transport.update(state.card, markdown(chunks[0]), sequence, id(state.card, 'update', sequence), signal);
        state.accepted = chunks[0];
      } catch (error) {
        // 长任务可能遇到远端流式状态过期；仅降级消息渠道，不取消执行中的 Claude。
        signal?.throwIfAborted(); state.fallback = true; this.warn('stream-update', error);
      }
    }
    if (final) {
      await this.close(state, signal);
      // Only an accepted first chunk may replace the first rich-post chunk.
      await this.posts(m, text, chunks, state.fallback ? 0 : 1, signal, state);
    }
  }
}
