/** 用户输入请求独立于任务队列；只接受所属会话的显式回答。 */
import { randomUUID } from 'node:crypto';
import type { AgentQuestion, QuestionAnswer } from './types.ts';
import { object } from './agent-state.ts';

type Pending = { key: string; question: AgentQuestion; settle(answer: QuestionAnswer): void };
const values = (schema: Record<string, unknown>): unknown[] | undefined => {
  if (Array.isArray(schema.enum)) return schema.enum;
  const variants = schema.oneOf ?? schema.anyOf;
  return Array.isArray(variants) ? variants.map(v => object(v).const) : undefined;
};
function valid(value: unknown, s: Record<string, unknown>): boolean {
  const choices = values(s); if (choices && !choices.includes(value)) return false;
  if (s.type === 'string' || (!s.type && choices)) {
    if (typeof value !== 'string') return false;
    if (typeof s.minLength === 'number' && Array.from(value).length < s.minLength) return false;
    if (typeof s.maxLength === 'number' && Array.from(value).length > s.maxLength) return false;
    return true;
  }
  if (s.type === 'boolean') return typeof value === 'boolean';
  if (s.type === 'number' || s.type === 'integer') return typeof value === 'number' && Number.isFinite(value)
    && (s.type !== 'integer' || Number.isInteger(value))
    && (typeof s.minimum !== 'number' || value >= s.minimum) && (typeof s.maximum !== 'number' || value <= s.maximum);
  if (s.type === 'array') return Array.isArray(value) && value.every(v => typeof v === 'string' && valid(v, { type: 'string', ...object(s.items) }))
    && (typeof s.minItems !== 'number' || value.length >= s.minItems) && (typeof s.maxItems !== 'number' || value.length <= s.maxItems)
    && (!s.uniqueItems || new Set(value).size === value.length);
  return false;
}
function supported(s: Record<string, unknown>): boolean {
  // Fail closed on constraints this chat form renderer cannot validate.
  if (s.pattern || s.format || s.not || s.allOf || s.$ref || s.exclusiveMinimum !== undefined || s.exclusiveMaximum !== undefined || s.multipleOf !== undefined) return false;
  if (s.type === 'array') return supported({ type: 'string', ...object(s.items) });
  return ['string', 'number', 'integer', 'boolean'].includes(String(s.type)) || (!s.type && !!values(s));
}
function render(question: AgentQuestion, id: string) {
  const fields = Object.entries(question.requestedSchema.properties).map(([key, raw]) => {
    const s = object(raw); const choiceSchema = s.type === 'array' ? object(s.items) : s;
    const choices = values(choiceSchema); const variants = choiceSchema.oneOf ?? choiceSchema.anyOf;
    const details = Array.isArray(variants) ? variants.map(object).map(v => `${String(v.const)}${v.title && v.title !== v.const ? `（${v.title}）` : ''}${v.description ? `：${v.description}` : ''}`).join('\n') : choices?.join(' / ');
    return `${key}：${String(s.title ?? s.type ?? '')}${s.description ? `\n${s.description}` : ''}${details ? `\n选项：\n${details}` : ''}${question.requestedSchema.required?.includes(key) ? '\n必填' : ''}`;
  }).join('\n\n');
  return `Claude 需要你回答：${question.message}\n\n${fields}\n\n/answer ${id} <回答或 JSON 对象>\n/skip ${id} 跳过；/questions 重新查看。等待上限 10 分钟，任务总时限仍生效。`;
}
export class Interactions {
  private pending = new Map<string, Pending>();
  count(key: string) { return [...this.pending.values()].filter(p => p.key === key).length; }
  text(key: string) { return [...this.pending.entries()].filter(([, p]) => p.key === key).map(([id, p]) => render(p.question, id)).join('\n\n') || '当前没有等待回答的问题。'; }
  ask(key: string, question: AgentQuestion, signal: AbortSignal | undefined, notify: (text: string) => Promise<boolean>): Promise<QuestionAnswer> {
    const entries = Object.entries(question.requestedSchema.properties);
    if (signal?.aborted || this.pending.size >= 8 || entries.length > 20 || !entries.length || JSON.stringify(question).length > 32000 || entries.some(([k, s]) => ['__proto__', 'constructor', 'prototype'].includes(k) || !supported(object(s)))) return Promise.resolve({ action: 'cancel' });
    const id = randomUUID();
    return new Promise(resolve => {
      const abort = () => settle({ action: 'cancel' });
      const timer = setTimeout(abort, 10 * 60 * 1000); timer.unref?.();
      const settle = (answer: QuestionAnswer) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(answer);
      };
      this.pending.set(id, { key, question, settle });
      signal?.addEventListener('abort', abort, { once: true });
      void notify(render(question, id)).then(ok => { if (!ok) abort(); }, abort);
    });
  }
  answer(key: string, id: string, input: string) {
    const p = this.pending.get(id); if (!p || p.key !== key) return '问题不存在、已过期或无权回答。';
    try {
      const properties = p.question.requestedSchema.properties;
      const fields = Object.keys(properties).filter(k => !k.endsWith('_custom'));
      let content: Record<string, unknown>;
      if (input.trim().startsWith('{')) content = object(JSON.parse(input));
      else if (fields.length === 1) {
        const k = fields[0]; const s = object(properties[k]);
        content = { [k]: s.type === 'boolean' || s.type === 'number' || s.type === 'integer' || s.type === 'array' ? JSON.parse(input) : input };
      } else return '回答无效：多个字段请使用 JSON 对象。';
      if ((p.question.requestedSchema.required ?? []).some(k => !Object.hasOwn(content, k))
        || Object.entries(content).some(([k, v]) => !Object.hasOwn(properties, k) || !valid(v, object(properties[k])))) return '回答无效：请检查必填字段、类型和选项；问题仍在等待。';
      p.settle({ action: 'accept', content: content as NonNullable<QuestionAnswer['content']> }); return '回答已提交，Claude 将继续处理。';
    } catch { return '回答无效：请使用合法的回答或 JSON 对象；问题仍在等待。'; }
  }
  skip(key: string, id: string) {
    const p = this.pending.get(id); if (!p || p.key !== key) return '问题不存在、已过期或无权回答。';
    p.settle({ action: 'decline' }); return '已跳过该问题。';
  }
  cancel(key: string) { for (const p of [...this.pending.values()]) if (p.key === key) p.settle({ action: 'cancel' }); }
}
