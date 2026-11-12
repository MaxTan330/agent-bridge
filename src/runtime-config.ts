/** 部署者提供的原生运行时配置；拒绝未知字段且不在错误中泄露凭据。 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { RuntimeOptions } from './types.ts';

const pair = z.object({ name: z.string().min(1), value: z.string() }).strict();
const name = z.string().min(1).max(100);
const remote = { name, url: z.string().url().regex(/^https?:\/\//), headers: z.array(pair).max(100).default([]) };
const server = z.union([
  z.object({ type: z.literal('http'), ...remote }).strict(),
  z.object({ type: z.literal('sse'), ...remote }).strict(),
  z.object({ name, command: z.string().min(1), args: z.array(z.string()).max(100).default([]), env: z.array(pair).max(100).default([]) }).strict(),
]);
const schema = z.object({
  mcpServers: z.array(server).max(20).refine(items => new Set(items.map(item => item.name)).size === items.length, 'Duplicate MCP name').optional(),
  maxTurns: z.number().int().positive().max(10000).optional(),
  maxBudgetUsd: z.number().positive().max(100000).optional(),
}).strict();

export function loadRuntimeConfig(path: string | undefined, workspace: string): RuntimeOptions {
  if (!path?.trim()) return {};
  try {
    const absolute = resolve(workspace, path);
    if (!statSync(absolute).isFile() || statSync(absolute).size > 65536) throw new Error();
    return schema.parse(JSON.parse(readFileSync(absolute, 'utf8')));
  } catch { throw new Error('Invalid Claude runtime configuration; check file path and supported fields'); }
}
