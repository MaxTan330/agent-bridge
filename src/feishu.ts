/** 飞书渠道：消息归一化、长连接事件、卡片回调、回复分片与 HTTP 请求取消。 */
import * as lark from '@larksuiteoapi/node-sdk';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DeliveryError, deliveryFailure, apiDeliveryFailure } from './delivery-error.ts';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Channel, Inbound, TaskReply } from './types.ts';
import { ContentElementId, FeishuReplies, richPost, streamCard } from './feishu-replies.ts';
import { errorFacts } from './diagnostics.ts';

const eventSchema = z.object({
  sender: z.object({ sender_type: z.literal('user'), sender_id: z.object({ open_id: z.string().min(1) }) }),
  message: z.object({ message_id: z.string(), chat_id: z.string(), thread_id: z.string().optional(),
    chat_type: z.enum(['p2p', 'group']), message_type: z.string(), content: z.string(),
    mentions: z.array(z.object({ key: z.string(), id: z.object({ open_id: z.string().optional() }) })).optional(),
  }),
});
/** 飞书回复消息类型：interactive 为卡片引用，post 为富文本。 */
const MsgType = { Card: 'interactive', Post: 'post' } as const;
/**
 * 将飞书消息事件归一化为 Inbound：不符合接入规则（非用户发送、群聊未 @机器人）
 * 返回 undefined；白名单用户的超长/非文本输入返回带 rejection 的消息，
 * 由 Bridge 回复提示而不执行。仅文本消息能进入任务。
 */
export function normalizeInbound(raw: unknown, account: string, bot: string): Inbound | undefined {
  const parsed = eventSchema.safeParse(raw); if (!parsed.success) return;
  const { sender, message: m } = parsed.data;
  const mentions = (m.mentions ?? []).filter(x => x.id.open_id === bot);
  if (m.chat_type === 'group' && !mentions.length) return;
  const base = { account, chat: m.chat_id, thread: m.thread_id ?? '', user: sender.sender_id.open_id, id: m.message_id, text: '' };
  if (m.message_type !== 'text') return { ...base, rejection: '暂不支持非文本消息，请发送文本指令。' };
  const tooLong = () => ({ ...base, rejection: '消息过长，请拆分为不超过 16000 字符的文本后重试。' });
  // 长度上限按移除 mention 之前的原始文本计算，避免移除后恰好达标。
  if (m.content.length > 64000) return tooLong();
  try {
    let text = z.object({ text: z.string() }).parse(JSON.parse(m.content)).text;
    if (text.length > 16000) return tooLong();
    for (const mention of mentions) text = text.replaceAll(mention.key, '');
    text = text.trim(); if (!text) return;
    return { account, chat: m.chat_id, thread: m.thread_id ?? '', user: sender.sender_id.open_id, id: m.message_id, text };
  } catch { return; }
}
export function normalizeMessage(raw: unknown, account: string, bot: string): Inbound | undefined {
  const message = normalizeInbound(raw, account, bot);
  return message?.rejection ? undefined : message;
}

export class Feishu implements Channel {
  client: lark.Client; ws: lark.WSClient; appId: string; bot: string; log: Logger;
  readonly http = lark.defaultHttpInstance.create({ timeout: 10000 });
  private readonly signals = new AsyncLocalStorage<AbortSignal | undefined>();
  private closed = true;
  private pendingStart?: { resolve(): void; reject(error: Error): void };
  private onFatal?: () => void;
  private readonly replies: FeishuReplies;
  constructor(appId: string, appSecret: string, bot: string, log: Logger) {
    this.appId = appId; this.bot = bot; this.log = log;
    this.http.interceptors.request.use(config => {
      const signal = this.signals.getStore();
      signal?.throwIfAborted();
      if (signal) config.signal = signal;
      return config;
    });
    this.http.interceptors.response.use(response => response.data);
    // A custom logger prevents the SDK's `fatal || info` fallback from logging credentials.
    const silent = () => {};
    // The response interceptor above unwraps AxiosResponse to the SDK's body-only contract.
    const httpInstance = this.http as unknown as NonNullable<ConstructorParameters<typeof lark.Client>[0]['httpInstance']>;
    const options = { appId, appSecret, httpInstance, loggerLevel: lark.LoggerLevel.fatal,
      logger: { error: silent, warn: silent, info: silent, debug: silent, trace: silent } };
    this.client = new lark.Client(options);
    this.replies = new FeishuReplies({
      create: async signal => {
        const response = await this.cardApi(signal, () => this.client.cardkit.v1.card.create({
          data: { type: 'card_json', data: streamCard() },
        }));
        if (!response.data?.card_id) throw new DeliveryError('missing_card_id', false);
        return response.data.card_id;
      },
      reply: async (message, card, uuid, signal) => {
        const messageId = await this.reply(message, MsgType.Card, JSON.stringify({ type: 'card', data: { card_id: card } }), uuid, signal);
        if (!messageId) throw new DeliveryError('missing_card_message_id', false);
        return messageId;
      },
      update: async (card, content, sequence, uuid, signal) => {
        await this.cardApi(signal, () => this.client.cardkit.v1.cardElement.content({
          path: { card_id: card, element_id: ContentElementId }, data: { content, sequence, uuid },
        }));
      },
      close: async (card, text, sequence, uuid, signal) => {
        await this.cardApi(signal, () => this.client.cardkit.v1.card.settings({ path: { card_id: card },
          data: { sequence, uuid, settings: JSON.stringify({ config: { streaming_mode: false,
            summary: { content: Array.from(text).slice(0, 100).join('') || '回复已结束' } } }) },
        }));
      },
      post: async (message, text, uuid, signal) => { await this.reply(message, MsgType.Post, richPost(text), uuid, signal); },
    }, (stage, error) => this.log.warn({ ...errorFacts(error), stage }, 'Feishu streaming degraded'));
    this.ws = new lark.WSClient({ ...options,
      onReady: () => {
        if (this.closed) return;
        this.pendingStart?.resolve(); this.pendingStart = undefined;
      },
      onError: () => this.connectionFailed(),
      onReconnecting: () => { if (!this.closed) this.log.warn('Feishu reconnecting'); },
      onReconnected: () => { if (!this.closed) this.log.info('Feishu reconnected'); },
    });
  }
  private connectionFailed() {
    if (this.closed) return;
    const pending = this.pendingStart; this.pendingStart = undefined;
    const fatal = this.onFatal;
    this.stop();
    // SDK errors may contain response bodies or credentials; report only the stage.
    this.log.error({ stage: 'feishu-connection' }, 'Feishu connection failed');
    if (pending) pending.reject(new Error('Feishu connection failed'));
    else fatal?.();
  }
  async start(handle: (m: Inbound) => Promise<void>,
    options: { onFatal?: () => void; timeoutMs?: number } = {}) {
    if (!this.closed) throw new Error('Feishu already started');
    if (!/^cli_[0-9a-fA-F]{16}$/.test(this.appId)) throw new Error('Invalid Feishu app ID');
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': data => {
        const m = normalizeInbound(data, this.appId, this.bot);
        if (m) void handle(m).catch(() => this.log.error({ messageId: m.id }, 'message handling failed'));
        return {};
      },
    });
    this.closed = false; this.onFatal = options.onFatal;
    const ready = new Promise<void>((resolve, reject) => { this.pendingStart = { resolve, reject }; });
    const deadline = setTimeout(() => this.connectionFailed(), options.timeoutMs ?? 30000);
    try {
      void this.ws.start({ eventDispatcher: dispatcher }).catch(() => this.connectionFailed());
      await ready;
    } finally { clearTimeout(deadline); }
  }
  stop() {
    this.closed = true; this.onFatal = undefined;
    this.pendingStart?.reject(new Error('Feishu connection stopped')); this.pendingStart = undefined;
    this.ws.close({ force: true });
  }
  /** 发送回复消息；uuid 由内容派生，重试时平台幂等去重。话题内消息保持话题回复。 */
  private async reply(m: Inbound, type: string, content: string, uuid: string, signal?: AbortSignal) {
    try {
      signal?.throwIfAborted();
      const response = await this.signals.run(signal, () => this.client.im.message.reply({ path: { message_id: m.id },
        data: { msg_type: type, content, uuid, reply_in_thread: !!m.thread } }));
      signal?.throwIfAborted();
      if (response.code !== 0) throw apiDeliveryFailure(response.code);
      return response.data?.message_id;
    } catch (error) { throw deliveryFailure(error); }
  }
  private async cardApi<T extends { code?: number }>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    try {
      signal?.throwIfAborted();
      const response = await this.signals.run(signal, operation);
      signal?.throwIfAborted();
      if (response.code !== 0) throw apiDeliveryFailure(response.code);
      return response;
    } catch (error) { throw deliveryFailure(error); }
  }
  forgetTask(m: Inbound, id: string) { return this.replies.forget(m, id); }
  task(m: Inbound, reply: TaskReply, signal?: AbortSignal) { return this.replies.task(m, reply, signal); }
  async startTyping(m: Inbound, signal?: AbortSignal): Promise<string | undefined> {
    try {
      signal?.throwIfAborted();
      const response = await this.signals.run(signal, () => this.client.im.messageReaction.create({
        path: { message_id: m.id }, data: { reaction_type: { emoji_type: 'Typing' } },
      }));
      if (response.code !== 0) throw apiDeliveryFailure(response.code);
      const id = response.data?.reaction_id;
      if (signal?.aborted && id) await this.stopTyping(m, id, AbortSignal.timeout(3000));
      signal?.throwIfAborted();
      return id;
    } catch (error) { throw deliveryFailure(error); }
  }
  async stopTyping(m: Inbound, reaction: string, signal?: AbortSignal) {
    try {
      signal?.throwIfAborted();
      const response = await this.signals.run(signal, () => this.client.im.messageReaction.delete({
        path: { message_id: m.id, reaction_id: reaction },
      }));
      if (response.code !== 0) throw apiDeliveryFailure(response.code);
    } catch (error) { throw deliveryFailure(error); }
  }
  send(m: Inbound, text: string, signal?: AbortSignal) { return this.replies.send(m, text, signal); }
}
