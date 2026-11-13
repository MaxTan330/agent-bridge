/** 有界的运行时事件投影；不保存工具输入、输出、凭据或模型思考。 */
import type { RuntimeEvent } from './types.ts';
import { basename, isAbsolute, relative, resolve, sep, win32 } from 'node:path';

export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 240) => typeof value === 'string' ? Array.from(value).slice(0, max).join('') : '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
type Tool = { title: string; status: string; files: Set<string> };

export class AgentState {
  private readonly workspace?: string;
  constructor(workspace?: string) { this.workspace = workspace; }
  tools = new Map<string, Tool>();
  title?: string;
  private diffFiles = new Set<string>();
  private commands: { name: string; description: string }[] = [];
  private plan: { content: string; status: string }[] = [];
  private usage?: { used: number; size: number; amount?: number; currency: string };
  private capabilities?: { steering: boolean; image: boolean };
  private options: { id: string; name: string; value: string; values: string[] }[] = [];
  apply(event: RuntimeEvent) {
    if (event.type === 'capabilities') { this.capabilities = { steering: event.steering, image: event.image }; return; }
    if (event.type === 'config') { this.config(event.options); return; }
    const u = event.update;
    switch (u.sessionUpdate) {
      case 'session_info_update':
        if (typeof u.title === 'string') this.title = text(u.title.replace(/\s+/g, ' ').trim(), 120);
        break;
      case 'available_commands_update':
        this.commands = list(u.availableCommands).slice(0, 100).map(object).map(c => ({ name: text(c.name, 80), description: text(c.description) })); break;
      case 'config_option_update': this.config(list(u.configOptions)); break;
      case 'tool_call': case 'tool_call_update': {
        const id = text(u.toolCallId, 200); if (!id) return;
        const previous = this.tools.get(id);
        this.tools.delete(id);
        const status = text(u.status, 50) || previous?.status || 'pending';
        const files = previous?.files ?? new Set<string>();
        for (const raw of list(u.content)) {
          if (files.size >= 20) break;
          const item = object(raw);
          if (item.type !== 'diff' || typeof item.path !== 'string') continue;
          const name = this.displayPath(item.path);
          if (name) files.add(name);
        }
        if (status === 'completed') for (const name of files) {
          if (this.diffFiles.size >= 20) break;
          this.diffFiles.add(name);
        }
        this.tools.set(id, { title: text(u.title) || previous?.title || '工具', status, files });
        while (this.tools.size > 30) this.tools.delete(this.tools.keys().next().value!);
        break;
      }
      case 'plan': this.plan = list(u.entries).slice(0, 50).map(object).map(e => ({ content: text(e.content), status: text(e.status, 40) })); break;
      case 'usage_update': {
        if (typeof u.used !== 'number' || typeof u.size !== 'number' || !Number.isFinite(u.used) || !Number.isFinite(u.size)) return;
        const cost = object(u.cost);
        this.usage = { used: u.used, size: u.size, amount: typeof cost.amount === 'number' && Number.isFinite(cost.amount) ? cost.amount : undefined, currency: text(cost.currency, 12) };
        break;
      }
    }
  }
  private displayPath(path: string) {
    let name = basename(path.replace(/\\/g, '/'));
    if (this.workspace && !(win32.isAbsolute(path) && !isAbsolute(path))) {
      const rel = relative(this.workspace, resolve(this.workspace, path));
      if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) name = rel.split(sep).join('/');
    }
    return text(name.replace(/[\x00-\x1f\x7f]/g, ''), 240);
  }
  changeSummary() {
    return this.diffFiles.size ? `ACP 报告的文件变更（最多 20 项）：\n${[...this.diffFiles].map(name => `- ${name}`).join('\n')}` : '';
  }
  private config(values: unknown[]) {
    this.options = values.slice(0, 30).map(object).map(o => ({ id: text(o.id, 80), name: text(o.name, 80), value: text(o.currentValue, 120),
      values: list(o.options).flatMap(item => { const v = object(item); return Array.isArray(v.options) ? v.options : [v]; }).slice(0, 50).map(object).map(v => text(v.value, 100)).filter(Boolean) }));
  }
  commandsText() { return this.commands.length ? this.commands.map(c => `/${c.name.replace(/^\//, '')} — ${c.description}`).join('\n') : '尚未收到当前会话的 Claude 命令列表；先运行一次任务。'; }
  toolsText() { return this.tools.size ? [...this.tools.values()].slice(-10).map(t => `${t.title}：${t.status}`).join('\n') : '尚未收到工具执行事件。'; }
  brief() { const t = [...this.tools.values()].at(-1); return t ? `最近工具：${t.title}（${t.status}）` : ''; }
  planText() { return this.plan.length ? this.plan.map(e => `[${e.status}] ${e.content}`).join('\n') : '尚未收到任务计划事件。'; }
  usageText() { const u = this.usage; return u ? `运行时报告的上下文：${u.used} / ${u.size}${u.amount === undefined ? '' : `\n运行时费用估算：${u.amount} ${u.currency}（以服务商账单为准）`}` : '尚未收到运行时用量数据。'; }
  capabilitiesText() { return this.capabilities ? `steering：${this.capabilities.steering ? '支持' : '不支持'}\n图片输入协议：${this.capabilities.image ? '支持' : '不支持'}\n以上为运行时协商结果，渠道入口支持情况见 /help。` : '尚未与 Claude 协商能力；先运行一次任务。'; }
  configText() { return this.options.length ? this.options.map(o => `${o.name || o.id} (${o.id})：${o.value}\n可选：${o.values.join(', ') || '未提供'}`).join('\n\n') : '尚未收到可用配置选项。'; }
}
