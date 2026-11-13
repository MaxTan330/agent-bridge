/** 原生能力的应用层：状态查询、会话偏好、引导与交互，不拥有任务调度权。 */
import { AgentState } from './agent-state.ts';
import { Interactions } from './interactions.ts';
import { nativeCommand, NativeHelp } from './commands.ts';
import type { Store } from './store.ts';
import type { Inbound, Runtime, RuntimeHooks } from './types.ts';

type Ports = { workspace: string; key(m: Inbound): string; busy(key: string): boolean; send(m: Inbound, text: string): Promise<boolean> };
type Run = { key: string; state: AgentState; session?: string; executing: boolean; steering: boolean; abort: AbortController };
export class AgentFeatures {
  private states = new Map<string, AgentState>();
  private current?: Run;
  readonly interactions = new Interactions();
  db: Store; runtime: Runtime; ports: Ports;
  constructor(db: Store, runtime: Runtime, ports: Ports) { this.db = db; this.runtime = runtime; this.ports = ports; }
  state(key: string) { return this.states.get(key); }
  clear(key: string) { this.states.delete(key); }
  begin(m: Inbound) {
    const key = this.ports.key(m); const state = new AgentState(this.ports.workspace);
    const run: Run = { key, state, executing: false, steering: false, abort: new AbortController() };
    this.current = run; this.states.delete(key); this.states.set(key, state);
    while (this.states.size > 128) this.states.delete(this.states.keys().next().value!);
    const hooks: RuntimeHooks = { ...this.db.preferences(key),
      onEvent: event => { if (this.current === run && !run.abort.signal.aborted) state.apply(event); },
      onQuestion: async (question, signal) => {
        if (this.current !== run || !run.executing || run.session !== question.sessionId) return { action: 'cancel' };
        return this.interactions.ask(key, question, signal ? AbortSignal.any([signal, run.abort.signal]) : run.abort.signal,
          text => this.ports.send(m, text));
      },
    };
    return { hooks, state,
      attach: (session: string) => { run.session = session; run.executing = true; },
      end: () => { run.executing = false; run.abort.abort(); this.interactions.cancel(key); if (this.current === run) this.current = undefined; },
    };
  }
  cancel(key: string) { if (this.current?.key === key) { this.current.executing = false; this.current.abort.abort(); } this.interactions.cancel(key); }
  brief(key: string) {
    return [this.state(key)?.brief(), this.interactions.count(key) ? `等待回答：${this.interactions.count(key)} 项，使用 /questions 查看。` : ''].filter(Boolean).join('\n');
  }
  async handle(m: Inbound): Promise<boolean> {
    const command = nativeCommand(m.text); if (!command) return false;
    const { name, argument } = command; const key = this.ports.key(m); const state = this.state(key) ?? new AgentState();
    const reply = (text: string) => this.ports.send(m, text);
    switch (name) {
      case 'help': await reply(NativeHelp); break;
      case 'commands': await reply(state.commandsText()); break;
      case 'tools': await reply(state.toolsText()); break;
      case 'plan': await reply(state.planText()); break;
      case 'usage': await reply(state.usageText()); break;
      case 'capabilities': await reply(state.capabilitiesText()); break;
      case 'config': await reply(`下次任务偏好：${JSON.stringify(this.db.preferences(key))}\n\n最近协商的配置：\n${state.configText()}`); break;
      case 'questions': await reply(this.interactions.text(key)); break;
      case 'answer': {
        const match = /^(\S+)\s+([\s\S]+)$/.exec(argument);
        await reply(match ? this.interactions.answer(key, match[1], match[2]) : '用法：/answer <问题编号> <回答或 JSON>'); break;
      }
      case 'skip': await reply(this.interactions.skip(key, argument)); break;
      case 'steer': {
        const run = this.current;
        if (!argument) { await reply('用法：/steer <补充要求>'); break; }
        if (!run || run.key !== key || !run.executing || !run.session) { await reply('当前没有可引导的本人执行中任务；此条未作为新任务提交。'); break; }
        if (!this.runtime.steer) { await reply('当前运行时未提供任务引导；此条未发送。'); break; }
        if (run.steering) { await reply('上一条引导仍在确认中，请等待后再发送。'); break; }
        run.steering = true;
        try {
          const result = await this.runtime.steer(run.session, argument);
          await reply(result === 'injected' ? '补充要求已交给当前任务。' : '当前轮次已结束，补充要求未执行；请作为普通消息重新发送。');
        } catch { await reply('任务引导未确认，可能不受支持或连接异常。未自动重试或入队；请先查看 /status 和最终结果。'); }
        finally { run.steering = false; }
        break;
      }
      case 'sessions': {
        const sessions = this.db.sessionHistory(key);
        await reply(sessions.length ? sessions.map(s => `${s.title ? `${s.title}\n` : ''}${s.acp} — ${s.at ? new Date(s.at).toISOString() : '旧会话'}`).join('\n\n') + '\n\n/resume <会话编号> 选择下次恢复；仅列最近 20 项。' : '当前会话没有可恢复的历史记录。'); break;
      }
      case 'resume':
        if (this.ports.busy(key)) { await reply('当前会话有执行中或排队任务，请完成或取消后切换。'); break; }
        if (this.db.resumeSession(key, argument)) { this.clear(key); await reply('已选择历史会话，下次任务尝试恢复；历史不可用时会创建新会话。'); }
        else await reply('会话不存在或不属于本人当前聊天和话题。');
        break;
      case 'mode': case 'model': case 'effort': {
        if (!argument) { await reply(`当前偏好：${JSON.stringify(this.db.preferences(key))}；/config 查看原生可选项。`); break; }
        if (this.ports.busy(key)) { await reply('当前会话有执行中或排队任务，请完成或取消后修改配置。'); break; }
        const value = argument === 'default' ? undefined : name === 'mode' && argument === 'execute' ? 'bypassPermissions' : argument;
        if (name === 'mode' && !['plan', 'bypassPermissions', undefined].includes(value)) { await reply('用法：/mode plan 或 /mode execute'); break; }
        if (value && (value.length > 160 || /\s/.test(value))) { await reply('配置值无效，请使用 /config 中的单个选项值。'); break; }
        this.db.setPreference(key, name, value); await reply('已保存下次任务偏好；启动时按 Claude 实际能力校验，不支持时不会执行任务。'); break;
      }
    }
    return true;
  }
}
