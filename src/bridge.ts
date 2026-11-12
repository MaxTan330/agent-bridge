import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import type { Store } from './store.ts';
import type { Channel, Inbound, Runtime, TaskReply } from './types.ts';
import { bounded } from './timeout.ts';
import { errorFacts, type DiagnosticLogger } from './diagnostics.ts';
import { isRetryableDelivery } from './delivery-error.ts';
import { ChatCommand, isControlCommand, StopReason, TaskState, TaskPhase, TaskPhaseLabel, TaskLimits, elapsedText } from './task.ts';

/** 任务编排核心：用户鉴权、命令、全局任务互斥、会话映射、进度、结果与取消。 */

/** Bridge 行为配置；时间字段均为毫秒。 */
type Options = {
  /** 白名单用户 open_id 列表；非白名单消息直接忽略。 */
  users: string[];
  /** 管理员 open_id 列表；可取消同聊天内任务并查看他人任务状态。 */
  admins: string[];
  /** 会话键中的工作区绝对路径维度。 */
  workspace: string;
  /** 任务总执行时限（含会话初始化），到点强制取消。 */
  taskTimeout: number;
  /** 取消后等待执行自然结束的宽限；超时强制停止进程。 */
  cancelGrace: number;
  /** 单次投递的总窗口；缺省 15 秒。 */
  deliveryTimeout?: number;
};
/** 一个活动任务的内存状态；active 存在即独占全局工作区（单实例单任务）。 */
type Active = {
  message: Inbound;
  /** 已请求取消；执行与进度路径据此尽快收敛。 */
  cancelled: boolean;
  /** 当前 ACP 会话 ID；open 成功后可用。 */
  session?: string;
  /** 启动阶段的取消信号；open 各协议步骤与后续检查共用。 */
  opening: AbortController;
  startedAt: number;
  /** 最近一次文本增量时间；仅用于 /status 展示，不代表工具心跳。 */
  lastOutputAt?: number;
  phase: TaskPhase;
  /** 整个任务（含结果投递与清理）完成后 resolve；stop() 等待它。 */
  done: Promise<void>;
  /** 仅执行阶段（不含结果投递）完成后 resolve；cancel 宽限据此计时。 */
  executionDone: Promise<void>;
  /** cancel() 的清理 Promise；重复取消共享同一轮清理。 */
  cancellation?: Promise<void>;
};
export class Bridge {
  db: Store; runtime: Runtime; channel: Channel; options: Options; log: DiagnosticLogger;
  active?: Active;
  stopping = false;
  constructor(db: Store, runtime: Runtime, channel: Channel, options: Options, log: DiagnosticLogger = pino({ enabled: false })) {
    this.db = db; this.runtime = runtime; this.options = options;
    this.channel = channel; this.log = log;
  }
  /** 会话键：应用+聊天+话题+用户+工作区；不同用户/话题不共享 Agent 会话。 */
  key(m: Inbound) { return JSON.stringify(['feishu', m.account, m.chat, m.thread, m.user, this.options.workspace]); }
  private report(error: unknown, stage: string, task?: string) { this.log.error({ ...errorFacts(error), stage, task }, 'Bridge operation failed'); }
  /** 在 timeout 总窗口内执行一次投递；retry 时对可恢复错误最多共尝试 3 次（退避 250ms×2ⁿ）。
   *  失败只记录并返回 false，不向上抛——投递失败不得影响任务终态。 */
  private async deliver(operation: (signal: AbortSignal) => Promise<void>, retry = false, limit?: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = limit ?? this.options.deliveryTimeout ?? 15000;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      await bounded((async () => {
        for (let attempt = 0; ; attempt++) {
          controller.signal.throwIfAborted();
          try { await operation(controller.signal); return; }
          catch (error) {
            if (!retry || attempt >= 2 || controller.signal.aborted || !isRetryableDelivery(error)) throw error;
            await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
          }
        }
      })(), timeout);
      return true;
    } catch (error) { this.report(error, 'delivery'); return false; }
    finally { controller.abort(); clearTimeout(timer); }
  }
  /** 发送富文本；retry 时对可恢复错误重试。 */
  private send(m: Inbound, text: string, retry = false) {
    return this.deliver(signal => this.channel.send(m, text, signal), retry);
  }
  /** 发送任务回复（流式卡片或降级富文本）；渠道无 task 能力时退回 send。 */
  private taskReply(m: Inbound, reply: TaskReply, retry = false) {
    return this.deliver(signal => this.channel.task
      ? this.channel.task(m, reply, signal) : this.channel.send(m, reply.text, signal), retry);
  }
  /** 投递最终结果（或 /result 取回）并记录投递状态；送达与否不影响已落盘的终态。 */
  private async result(m: Inbound, task: string, text: string, state?: TaskReply['state'], note?: string) {
    // The channel owns fallback and chunk deduplication; sending again here could repeat accepted chunks.
    const sent = state ? await this.taskReply(m, { id: task, state, text, note }, true) : await this.send(m, text, true);
    try { this.db.delivered(task, sent); } catch (error) { this.report(error, 'delivery-state', task); }
  }
  private statusText(m: Inbound): string {
    const active = this.active;
    if (!active) return '当前会话没有正在执行的任务。';
    // 状态不能泄露其他使用者的任务。管理员也仅能查看当前应用、聊天与话题。
    const sameConversation = active.message.account === m.account && active.message.chat === m.chat && active.message.thread === m.thread;
    if (!sameConversation || (active.message.user !== m.user && !this.options.admins.includes(m.user))) {
      return '当前会话没有正在执行的任务，工作区正忙。';
    }
    const now = Date.now();
    return [
      `当前任务：${TaskPhaseLabel[active.phase]}`,
      `已运行：${elapsedText(now - active.startedAt)}`,
      `执行时限：${elapsedText(this.options.taskTimeout)}`,
      active.lastOutputAt === undefined ? '暂未收到文字进展。' : `最近文本输出：${elapsedText(now - active.lastOutputAt)}前`,
    ].join('\n');
  }
  async handle(m: Inbound) {
    if (this.stopping || !this.options.users.includes(m.user)) return;
    // ── 鉴权与去重：控制命令与忙时响应也各自消费去重键，重复事件不重复回复 ──
    const messageKey = JSON.stringify(['feishu', m.account, m.id]);
    const control = m.rejection || isControlCommand(m.text);
    if (control || this.active) {
      try { if (!this.db.claim(messageKey)) return; } catch (error) { this.report(error, 'claim'); return; }
      if (m.rejection) { await this.send(m, m.rejection); return; }
      if (m.text === ChatCommand.Status) { await this.send(m, this.statusText(m)); return; }
      if (m.text === ChatCommand.Cancel) {
        const a = this.active;
        if (a && a.message.chat === m.chat && (a.message.user === m.user || this.options.admins.includes(m.user))) await this.cancel();
        else await this.send(m, '没有可取消的本人任务。');
        return;
      }
      if (m.text === ChatCommand.Result) {
        try {
          const result = this.db.latestResult(this.key(m));
          if (result) await this.result(m, result.task, result.text);
          else await this.send(m, '当前会话尚无可取回的结果。');
        } catch (error) { this.report(error, 'read-result'); await this.send(m, '结果暂时无法读取，请稍后重试。'); }
        return;
      }
      if (this.active) { await this.send(m, '工作区忙，请等待当前任务完成后重新发送。'); return; }
      if (m.text === ChatCommand.New) {
        try { this.db.forget(this.key(m)); await this.send(m, '下一条消息将创建新会话。'); }
        catch (error) { this.report(error, 'reset-session'); await this.send(m, '会话重置失败，请稍后重试。'); }
        return;
      }
    }
    // ── 接纳新任务：去重与 running 任务同事务落库；此后到 active 赋值之间无 await，
    //    同步 SQLite 保证事件循环不交错，单任务互斥因此成立 ──
    const id = randomUUID();
    try { if (!this.db.accept(id, this.key(m), messageKey)) return; }
    catch (error) { this.report(error, 'accept-task', id); await this.send(m, '任务未创建，请稍后重新发送。'); return; }
    let done!: () => void; let executionDone!: () => void;
    // active 跨越执行、保存和投递全过程，只有清理结束才释放工作区。
    const a: Active = { message: m, cancelled: false, opening: new AbortController(),
      startedAt: Date.now(), phase: TaskPhase.Starting,
      done: new Promise<void>(r => { done = r; }), executionDone: new Promise<void>(r => { executionDone = r; }) };
    this.active = a;
    // 流式输出协议的闭包变量：
    let output = '';                          // 已累计的正文，仅保留末尾 24,000 码点
    let pending = '';                         // 待下一次进度投递的完整快照
    let truncated = false;                    // 累计输出曾超限，最终结果前加截断说明
    let note: string | undefined;             // 附注（如原会话无法恢复，已新建）
    let reaction: string | undefined;         // Typing 表情 id，任务结束后移除
    let progressDelivery = Promise.resolve(); // 最近一次进度投递；终态投递前等待其完成
    let sending = false;                      // 进度投递进行中，防止并发更新同一卡片
    // ── 反馈与流式骨架：Typing 与模型启动并行；进度 250ms 合并一次；deadline 兜底 ──
    const snapshot = () => (truncated ? `（回复过长，以下保留末尾 ${TaskLimits.OutputCodePoints} 字符。）\n\n` : '') + output;
    const typing = this.channel.startTyping ? this.deliver(async signal => {
      reaction = await this.channel.startTyping!(m, signal);
    }, false, Math.min(this.options.deliveryTimeout ?? TaskLimits.FeedbackTimeoutMs, TaskLimits.FeedbackTimeoutMs)) : Promise.resolve(true);
    const progress = setInterval(() => {
      if (!pending || sending || a.cancelled) return;
      const text = pending; pending = ''; sending = true;
      progressDelivery = this.taskReply(m, { id, state: TaskState.Running, text, note }).then(() => {}).finally(() => { sending = false; });
    }, TaskLimits.ProgressIntervalMs);
    // 这是包含初始化的总执行时限；长时间无文字输出不会单独触发取消。
    const deadline = setTimeout(() => { void this.cancel().catch(error => this.report(error, 'timeout-cancel', id)); }, this.options.taskTimeout);
    let status: TaskReply['state'] = TaskState.Failed; let result = '任务失败，未自动重试。请检查运行环境或使用 /new 后重试。';
    this.log.info({ task: id, stage: TaskState.Running }, 'Task started');
    // ── 执行：恢复或新建会话 → 免审批模式 → 一次 prompt；文本增量经回调进入 output ──
    try {
      a.opening.signal.throwIfAborted();
      const old = this.db.session(this.key(m));
      a.session = await this.runtime.open(old, text => {
        if (text) a.lastOutputAt = Date.now();
        const characters = Array.from(output + text);
        truncated ||= characters.length > TaskLimits.OutputCodePoints;
        output = characters.slice(-TaskLimits.OutputCodePoints).join(''); pending = snapshot();
      }, async () => {
        if (a.cancelled || this.active !== a) return { outcome: { outcome: 'cancelled' } };
        // bypassPermissions is established before prompt; unexpected requests must not wait on chat.
        this.log.warn({ task: id, stage: 'unexpected-permission' }, 'Unexpected permission request in noninteractive mode');
        return { outcome: { outcome: 'cancelled' } };
      }, a.opening.signal);
      if (a.cancelled) throw new Error('cancelled');
      this.db.saveSession(this.key(m), a.session);
      if (old && old !== a.session) note = '原会话无法恢复，已创建新会话。';
      if (a.cancelled) throw new Error('cancelled');
      a.phase = TaskPhase.Executing;
      const reason = await this.runtime.prompt(a.session, m.text);
      a.cancelled ||= reason === StopReason.Cancelled;
      status = a.cancelled ? TaskState.Cancelled : TaskState.Completed;
      result = snapshot() || (a.cancelled ? '任务已取消。' : '没有文本输出。');
      if (a.cancelled && output) result += '\n\n（任务已取消，以上为部分输出。）';
    } catch (error) {
      // 取消、超时与执行异常在此统一收敛为终态与用户可读文本。
      this.report(error, 'execute', id);
      status = a.cancelled ? TaskState.Cancelled : TaskState.Failed;
      if (a.cancelled) result = '任务已取消或超时。';
    } finally {
      // ── 终态流水线：进程清理 → 结果落盘 → 等待在途进度 → 投递 → 释放工作区；顺序不可调换 ──
      clearTimeout(deadline); clearInterval(progress);
      try {
        if (a.cancelled || status === TaskState.Failed) await this.runtime.stop();
      } catch (error) {
        this.report(error, 'cleanup', id); this.stopping = true;
        status = TaskState.Failed; result = '运行进程清理失败，服务已停止接收新任务，请检查服务。';
      } finally { executionDone(); }
      try {
        a.phase = TaskPhase.Delivering;
        try { this.db.complete(id, status, result); } catch (error) { this.report(error, 'save-result', id); }
        await progressDelivery;
        await this.result(m, id, result, status, note);
      } finally {
        if (this.channel.forgetTask) await this.deliver(async () => { await this.channel.forgetTask!(m, id); }, false, TaskLimits.FeedbackTimeoutMs);
        await typing;
        if (reaction && this.channel.stopTyping) await this.deliver(signal => this.channel.stopTyping!(m, reaction!, signal), false, Math.min(this.options.deliveryTimeout ?? TaskLimits.FeedbackTimeoutMs, TaskLimits.FeedbackTimeoutMs));
        this.log.info({ task: id, status }, 'Task finished');
        this.active = undefined; done();
      }
    }
  }
  /** 取消当前任务：置取消标记、中止启动、通知 Agent；宽限后仍未结束则强制停止进程。
   *  重复调用共享同一轮清理。 */
  async cancel() {
    const a = this.active; if (!a) return;
    if (a.cancellation) return a.cancellation;
    // 执行已结束时，取消只能触发资源清理，不能把已保存结果的投递阶段改成取消中。
    if (a.phase !== TaskPhase.Delivering) a.phase = TaskPhase.Cancelling;
    a.cancelled = true; a.opening.abort();
    a.cancellation = (async () => {
      if (a.session) void this.runtime.cancel(a.session).catch(error => this.report(error, 'acp-cancel'));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([a.executionDone, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.cancelGrace); })]);
      clearTimeout(timer);
      // handle() also awaits this shared Runtime cleanup before releasing the lock.
      if (this.active === a) await this.runtime.stop();
    })();
    return a.cancellation;
  }
  /** 停机入口：取消任务、终止 Adapter，并等待活动任务完整收尾（含最终投递）。 */
  async stop() {
    this.stopping = true;
    const active = this.active;
    await this.cancel(); await this.runtime.stop();
    await active?.done;
  }
}
