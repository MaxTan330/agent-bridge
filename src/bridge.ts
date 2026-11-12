import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import type { Store } from './store.ts';
import type { Channel, Inbound, Runtime, TaskReply } from './types.ts';
import { bounded } from './timeout.ts';
import { errorFacts, type DiagnosticLogger } from './diagnostics.ts';
import { isRetryableDelivery } from './delivery-error.ts';
import { AgentFeatures } from './agent-features.ts';
import { nativeCommand } from './commands.ts';
import { AttachmentError } from './attachments.ts';
import { ChatCommand, DeliveryState, isControlCommand, StopReason, incompleteReasonText, TaskState, TaskPhase, TaskPhaseLabel, TaskLimits, elapsedText } from './task.ts';

/** 任务编排核心：用户鉴权、命令、单任务互斥与 FIFO 队列、会话、进度和取消。 */

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
  /** 全局等待队列容量；不包括正在执行的任务。 */
  queueLimit?: number;
  /** auto 仅长任务通知；background 总是先回执；stream 显示 Typing 与流式正文。 */
  replyMode?: 'auto' | 'background' | 'stream';
  /** auto 模式等待多久后发送一次后台通知。 */
  backgroundNoticeMs?: number;
  /** 会话及空闲 Adapter 的闲置回收期限，默认四小时。 */
  sessionIdleMs?: number;
};
type Queued = { id: string; message: Inbound; acknowledgement: Promise<boolean> };
/** 一个活动任务的内存状态；active 存在即独占全局工作区（单实例单任务）。 */
type Active = {
  id: string;
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
  /** 模型执行结束后 resolve；cancel 宽限据此计时。 */
  executionDone: Promise<void>;
  /** cancel() 的清理 Promise；重复取消共享同一轮清理。 */
  cancellation?: Promise<void>;
  runtimeCleanup?: Promise<void>;
};
export class Bridge {
  db: Store; runtime: Runtime; channel: Channel; options: Options; log: DiagnosticLogger;
  private features: AgentFeatures;
  active?: Active;
  private delivering = new Set<Active>();
  private queue: Queued[] = [];
  private queueCleanup: Promise<void> = Promise.resolve();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private idleCleanup: Promise<void> = Promise.resolve();
  stopping = false;
  constructor(db: Store, runtime: Runtime, channel: Channel, options: Options, log: DiagnosticLogger = pino({ enabled: false })) {
    this.db = db; this.runtime = runtime; this.options = options;
    this.channel = channel; this.log = log;
    this.features = new AgentFeatures(db, runtime, { key: m => this.key(m), send: (m, text) => this.send(m, text),
      busy: key => !!(this.active && this.key(this.active.message) === key) || this.queue.some(entry => this.key(entry.message) === key) });
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
  private canManage(m: Inbound, task: Inbound) {
    return task.account === m.account && task.chat === m.chat && task.thread === m.thread
      && (task.user === m.user || this.options.admins.includes(m.user));
  }
  private queueText(m: Inbound) {
    const visible = this.queue.flatMap((entry, index) => this.canManage(m, entry.message)
      ? [`${entry.id}（前方 ${index + (this.active ? 1 : 0)} 项）\n${entry.message.text.replace(/\s+/g, ' ').slice(0, 80)}`] : []);
    return visible.length ? `当前会话排队任务：\n${visible.join('\n\n')}\n\n/cancel <任务编号> 取消指定任务；/cancel all 清空本人当前会话的队列。`
      : '当前会话没有可查看的排队任务。';
  }
  private async cancelQueued(m: Inbound, target: string) {
    const selected = this.queue.filter(entry => target === 'all'
      ? this.key(entry.message) === this.key(m)
      : entry.id === target && this.canManage(m, entry.message));
    if (!selected.length) { await this.send(m, '没有匹配的可取消任务。使用 /status 查看当前任务，或使用 /queue 查看排队任务。'); return; }
    let count = 0;
    try {
      for (const entry of selected) {
        this.db.complete(entry.id, TaskState.Cancelled, '排队任务已取消，未执行。');
        this.queue.splice(this.queue.indexOf(entry), 1); count++;
      }
    } catch (error) {
      this.report(error, 'cancel-queue');
      await this.send(m, `已取消 ${count} 项，剩余排队任务取消失败，请重试。`); return;
    }
    this.startNext(); this.scheduleIdleCleanup();
    await this.send(m, `已取消 ${count} 项排队任务。正在执行的任务不受影响。`);
  }
  private async interruptQueue(text: string) {
    const pending = this.queue.splice(0);
    // 所有等待项先同步退出队列并落盘，再执行网络通知。
    for (const entry of pending) {
      try { this.db.complete(entry.id, TaskState.Interrupted, text); }
      catch (error) { this.report(error, 'interrupt-queue', entry.id); }
    }
    await Promise.all(pending.map(async entry => {
      await entry.acknowledgement;
      await this.result(entry.message, entry.id, text);
    }));
  }
  private startNext() {
    if (this.stopping || this.active || !this.queue.length) return;
    const next = this.queue[0];
    try { this.db.startQueued(next.id); }
    catch (error) {
      this.report(error, 'start-queued', next.id); this.stopping = true;
      this.queueCleanup = this.interruptQueue('队列启动失败，服务已停止接收任务；排队任务已中断，请检查服务后重新发送。'); return;
    }
    this.queue.shift();
    // execute 在第一个 await 前设置 active，后续消息无法抢占 FIFO 队列。
    void this.execute(next.message, next.id, next.acknowledgement).catch(error => {
      this.report(error, 'queued-execution', next.id); this.stopping = true;
      this.queueCleanup = this.interruptQueue('任务调度异常，排队任务已中断，请检查服务后重新发送。');
    });
  }
  private scheduleIdleCleanup() {
    clearTimeout(this.idleTimer);
    if (this.stopping || this.active || this.queue.length) return;
    const idleMs = this.options.sessionIdleMs ?? TaskLimits.SessionIdleTimeoutMs;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.stopping || this.active || this.queue.length) return;
      this.idleCleanup = (async () => {
        // 在异步进程清理前过期映射，避免删除随后新任务保存的会话。
        this.db.expireSessions(idleMs);
        await this.runtime.stop();
      })().catch(error => { this.report(error, 'idle-cleanup'); this.stopping = true; });
    }, idleMs);
    this.idleTimer.unref?.();
  }
  private statusText(m: Inbound): string {
    const active = this.active && this.canManage(m, this.active.message) ? this.active
      : Array.from(this.delivering).findLast(task => this.canManage(m, task.message));
    if (!active) return this.active ? '当前会话没有正在执行的任务，工作区正忙。' : '当前会话没有正在执行的任务。';
    const now = Date.now();
    return [
      `当前任务：${TaskPhaseLabel[active.phase]}`,
      `任务编号：${active.id}`,
      `已运行：${elapsedText(now - active.startedAt)}`,
      `执行时限：${elapsedText(this.options.taskTimeout)}`,
      active.lastOutputAt === undefined ? '暂未收到文字进展。' : `最近文本输出：${elapsedText(now - active.lastOutputAt)}前`,
      this.features.brief(this.key(active.message)),
    ].filter(Boolean).join('\n');
  }
  async handle(m: Inbound) {
    if (this.stopping || !this.options.users.includes(m.user)) return;
    // ── 鉴权与去重：控制命令独立去重，普通任务在入队/接纳事务中去重 ──
    const messageKey = JSON.stringify(['feishu', m.account, m.id]);
    const control = m.rejection || isControlCommand(m.text);
    if (control) {
      try { if (!this.db.claim(messageKey)) return; } catch (error) { this.report(error, 'claim'); return; }
      if (m.rejection) { await this.send(m, m.rejection); return; }
      if (nativeCommand(m.text)) {
        try { await this.features.handle(m); }
        catch (error) { this.report(error, 'native-command'); await this.send(m, '命令处理失败，请检查服务后重试。'); }
        return;
      }
      if (m.text === ChatCommand.Status) {
        const queued = this.queue.filter(entry => this.canManage(m, entry.message)).length;
        await this.send(m, this.statusText(m) + (queued ? `\n\n当前会话有 ${queued} 项排队任务，使用 /queue 查看和取消。` : '')); return;
      }
      if (m.text === ChatCommand.Queue) { await this.send(m, this.queueText(m)); return; }
      if (/^\/cancel\s/.test(m.text)) {
        const target = m.text.slice(ChatCommand.Cancel.length).trim();
        const active = this.active;
        if (active?.id === target && this.canManage(m, active.message)) await this.cancel();
        else await this.cancelQueued(m, target);
        return;
      }
      if (m.text === ChatCommand.Cancel) {
        const a = this.active;
        if (a && this.canManage(m, a.message)) await this.cancel();
        else await this.send(m, '没有可取消的本人任务。');
        return;
      }
      if (m.text === ChatCommand.Result || /^\/result\s/.test(m.text)) {
        try {
          const session = this.key(m);
          const target = m.text.slice(ChatCommand.Result.length).trim();
          const result = !target || target === 'failed'
            ? this.db.latestResult(session, target === 'failed' ? DeliveryState.Failed : undefined)
            : this.db.resultForTask(session, target);
          if (result) await this.result(m, result.task, result.text);
          else await this.send(m, '当前会话尚无可取回的结果。');
        } catch (error) { this.report(error, 'read-result'); await this.send(m, '结果暂时无法读取，请稍后重试。'); }
        return;
      }
      if (m.text === ChatCommand.New) {
        if ((this.active && this.key(this.active.message) === this.key(m)) || this.queue.some(entry => this.key(entry.message) === this.key(m))) {
          await this.send(m, '当前会话有执行中或排队任务，请等待完成，或用 /cancel 和 /cancel all 取消后再重置。'); return;
        }
        try { this.db.forget(this.key(m)); this.features.clear(this.key(m)); await this.send(m, '下一条消息将创建新会话。'); }
        catch (error) { this.report(error, 'reset-session'); await this.send(m, '会话重置失败，请稍后重试。'); }
        return;
      }
    }
    if (this.active || this.queue.length) {
      if (this.queue.length >= (this.options.queueLimit ?? TaskLimits.MaxQueuedTasks)) {
        try { if (!this.db.claim(messageKey)) return; } catch (error) { this.report(error, 'claim'); return; }
        await this.send(m, '等待队列已满，本条消息未接收。请用 /queue 查看、取消不需要的排队任务后重新发送。'); return;
      }
      const id = randomUUID();
      try { if (!this.db.accept(id, this.key(m), messageKey, TaskState.Queued)) return; }
      catch (error) { this.report(error, 'enqueue', id); await this.send(m, '任务未加入队列，请稍后重新发送。'); return; }
      const ahead = this.queue.length + (this.active ? 1 : 0);
      const message = { ...m };
      const acknowledgement = Promise.resolve().then(() => this.send(message,
        `已加入队列，前方 ${ahead} 项任务，轮到后自动执行，无需重发。\n任务编号：${id}\n/queue 查看队列；/cancel ${id} 取消本项。`));
      this.queue.push({ id, message, acknowledgement });
      await acknowledgement; return;
    }
    // ── 接纳新任务：去重与 running 任务同事务落库；此后到 active 赋值之间无 await，
    //    同步 SQLite 保证事件循环不交错，单任务互斥因此成立 ──
    const id = randomUUID();
    try { if (!this.db.accept(id, this.key(m), messageKey)) return; }
    catch (error) { this.report(error, 'accept-task', id); await this.send(m, '任务未创建，请稍后重新发送。'); return; }
    return this.execute(m, id);
  }
  private async execute(m: Inbound, id: string, queuedAcknowledgement?: Promise<boolean>) {
    clearTimeout(this.idleTimer); this.idleTimer = undefined;
    let done!: () => void; let executionDone!: () => void;
    // active 持有工作区，直到运行时清理和终态落盘。
    const a: Active = { id, message: m, cancelled: false, opening: new AbortController(),
      startedAt: Date.now(), phase: TaskPhase.Starting,
      done: new Promise<void>(r => { done = r; }), executionDone: new Promise<void>(r => { executionDone = r; }) };
    this.active = a;
    const mode = this.options.replyMode ?? 'auto';
    const background = mode !== 'stream';
    // 回执与模型启动并行；最终结果等待回执结束，避免完成通知排在回执之前。
    let feedbackReady = !queuedAcknowledgement;
    let executionEnded = false;
    const queueFeedback = queuedAcknowledgement?.then(() => { feedbackReady = true; }) ?? Promise.resolve();
    let accepted = queueFeedback;
    const acknowledge = () => {
      accepted = queueFeedback.then(async () => {
        if (queuedAcknowledgement && (executionEnded || a.cancelled)) return;
        await this.deliver(signal => this.channel.send(m,
          `已接收，任务正在后台执行，完成后会通知你。\n任务编号：${id}\n/status 查看进度；/cancel ${id} 取消本项。`, signal), false,
        Math.min(this.options.deliveryTimeout ?? TaskLimits.FeedbackTimeoutMs, TaskLimits.FeedbackTimeoutMs));
      });
    };
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    if (mode === 'background') acknowledge();
    else if (mode === 'auto') noticeTimer = setTimeout(acknowledge, this.options.backgroundNoticeMs ?? TaskLimits.BackgroundNoticeDelayMs);
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
    const typing = !background && this.channel.startTyping ? this.deliver(async signal => {
      reaction = await this.channel.startTyping!(m, signal);
    }, false, Math.min(this.options.deliveryTimeout ?? TaskLimits.FeedbackTimeoutMs, TaskLimits.FeedbackTimeoutMs)) : Promise.resolve(true);
    const progress = background ? undefined : setInterval(() => {
      if (!feedbackReady || !pending || sending || a.cancelled) return;
      const text = pending; pending = ''; sending = true;
      progressDelivery = this.taskReply(m, { id, state: TaskState.Running, text, note }).then(() => {}).finally(() => { sending = false; });
    }, TaskLimits.ProgressIntervalMs);
    // 这是包含初始化的总执行时限；长时间无文字输出不会单独触发取消。
    const deadline = setTimeout(() => { void this.cancel().catch(error => this.report(error, 'timeout-cancel', id)); }, this.options.taskTimeout);
    let status: TaskReply['state'] = TaskState.Failed; let result = '任务失败，未自动重试。请检查运行环境或使用 /new 后重试。';
    let featureRun: ReturnType<AgentFeatures['begin']> | undefined;
    this.log.info({ task: id, stage: TaskState.Running }, 'Task started');
    // ── 执行：恢复或新建会话 → 免审批模式 → 一次 prompt；文本增量经回调进入 output ──
    try {
      await this.idleCleanup;
      if (this.stopping) throw new Error('Service stopped during idle cleanup');
      a.opening.signal.throwIfAborted();
      if (m.attachment && !this.channel.prepare) throw new Error('Attachment input unavailable');
      const attachments = m.attachment ? await bounded(this.channel.prepare!(m,
        AbortSignal.any([a.opening.signal, AbortSignal.timeout(30000)])), 30000) : undefined;
      a.opening.signal.throwIfAborted();
      const old = this.db.session(this.key(m), this.options.sessionIdleMs ?? TaskLimits.SessionIdleTimeoutMs);
      featureRun = this.features.begin(m);
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
      }, a.opening.signal, featureRun.hooks);
      if (a.cancelled) throw new Error('cancelled');
      this.db.saveSession(this.key(m), a.session);
      if (old && old !== a.session) note = '原会话无法恢复，已创建新会话。';
      if (a.cancelled) throw new Error('cancelled');
      a.phase = TaskPhase.Executing;
      featureRun.attach(a.session);
      const reason = await this.runtime.prompt(a.session, m.text, attachments);
      a.cancelled ||= reason === StopReason.Cancelled;
      status = a.cancelled ? TaskState.Cancelled : reason === StopReason.EndTurn ? TaskState.Completed : TaskState.Failed;
      result = snapshot() || (a.cancelled ? '任务已取消。' : '没有文本输出。');
      if (a.cancelled && output) result += '\n\n（任务已取消，以上为部分输出。）';
      if (status === TaskState.Failed) {
        const explanation = incompleteReasonText(reason);
        result = output ? `${snapshot()}\n\n（${explanation}以上为部分输出。）` : explanation;
      }
    } catch (error) {
      // 取消、超时与执行异常在此统一收敛为终态与用户可读文本。
      this.report(error, 'execute', id);
      status = a.cancelled ? TaskState.Cancelled : TaskState.Failed;
      if (a.cancelled) result = '任务已取消或超时。';
      else if (error instanceof AttachmentError) result = error.message;
    } finally {
      // 进程清理和结果落盘后交接工作区，飞书投递独立收尾。
      clearTimeout(deadline); clearInterval(progress); clearTimeout(noticeTimer);
      executionEnded = true;
      featureRun?.end();
      executionDone();
      try {
        if (a.cancelled || status === TaskState.Failed) await this.stopRuntime(a);
      } catch (error) {
        this.report(error, 'cleanup', id); this.stopping = true;
        status = TaskState.Failed; result = '运行进程清理失败，服务已停止接收新任务，请检查服务。';
      }
      try { this.db.complete(id, status, result); } catch (error) { this.report(error, 'save-result', id); }
      if (a.session) {
        try { this.db.touchSession(this.key(m), a.session); } catch (error) { this.report(error, 'touch-session', id); }
      }
      a.phase = TaskPhase.Delivering;
      this.delivering.add(a);
      this.active = undefined;
      if (this.stopping && this.queue.length) {
        this.queueCleanup = this.interruptQueue('服务已停止接收任务，排队任务已中断且未执行，请恢复服务后重新发送。');
      }
      this.startNext(); this.scheduleIdleCleanup();
      try {
        await accepted;
        await progressDelivery;
        await this.result(m, id, result, status, note);
      } finally {
        if (this.channel.forgetTask) await this.deliver(async () => { await this.channel.forgetTask!(m, id); }, false, TaskLimits.FeedbackTimeoutMs);
        await typing;
        if (reaction && this.channel.stopTyping) await this.deliver(signal => this.channel.stopTyping!(m, reaction!, signal), false, Math.min(this.options.deliveryTimeout ?? TaskLimits.FeedbackTimeoutMs, TaskLimits.FeedbackTimeoutMs));
        this.log.info({ task: id, status }, 'Task finished');
        this.delivering.delete(a);
        done();
      }
    }
  }
  private stopRuntime(task: Active) {
    return task.runtimeCleanup ??= Promise.resolve().then(() => this.runtime.stop());
  }
  /** 取消当前任务：置取消标记、中止启动、通知 Agent；宽限后仍未结束则强制停止进程。
   *  重复调用共享同一轮清理。 */
  async cancel() {
    const a = this.active; if (!a) return;
    if (a.cancellation) return a.cancellation;
    a.phase = TaskPhase.Cancelling;
    a.cancelled = true; a.opening.abort();
    this.features.cancel(this.key(a.message));
    a.cancellation = (async () => {
      if (a.session) void this.runtime.cancel(a.session).catch(error => this.report(error, 'acp-cancel'));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([a.executionDone, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.cancelGrace); })]);
      clearTimeout(timer);
      if (this.active === a) await this.stopRuntime(a);
    })();
    return a.cancellation;
  }
  /** 停机入口：取消任务、终止 Adapter，并等待活动任务完整收尾（含最终投递）。 */
  async stop() {
    this.stopping = true;
    clearTimeout(this.idleTimer); this.idleTimer = undefined;
    const pending = this.interruptQueue('服务停止，排队任务已中断且未执行，请恢复服务后重新发送。');
    const tasks = Array.from(this.delivering, task => task.done);
    if (this.active) tasks.push(this.active.done);
    try {
      try { await this.cancel(); }
      catch (error) { this.report(error, 'shutdown-cancel'); }
      await this.idleCleanup;
      await this.runtime.stop();
    } finally {
      await Promise.all([pending, ...tasks]);
      await this.queueCleanup;
    }
  }
}
