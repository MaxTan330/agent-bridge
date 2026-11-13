import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentState } from '../src/agent-state.ts';
import { resolve } from 'node:path';

test('change summaries require completed tools and distinguish same-named project files', () => {
  const workspace = resolve('project');
  const state = new AgentState(workspace);
  const preview = (toolCallId: string, path: string) => state.apply({ type: 'update', update: {
    sessionUpdate: 'tool_call', toolCallId, status: 'pending', content: [{ type: 'diff', path }],
  } });
  const finish = (toolCallId: string, status: string) => state.apply({ type: 'update', update: {
    sessionUpdate: 'tool_call_update', toolCallId, status,
  } });
  preview('failed', 'discarded.ts');
  preview('source', resolve(workspace, 'src/config.ts'));
  preview('test', 'test/config.ts');
  preview('outside', resolve(workspace, '../private/notes.txt'));
  assert.equal(state.changeSummary(), '');
  finish('failed', 'failed');
  finish('source', 'completed'); finish('test', 'completed'); finish('outside', 'completed');
  assert.match(state.changeSummary(), /src\/config\.ts/);
  assert.match(state.changeSummary(), /test\/config\.ts/);
  assert.match(state.changeSummary(), /- notes\.txt/);
  assert.doesNotMatch(state.changeSummary(), /discarded|private/);
});

test('agent state merges partial tool updates and renders actual plan and usage', () => {
  const state = new AgentState();
  state.apply({ type: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Run tests', status: 'in_progress', rawInput: { secret: 'hidden' } } });
  state.apply({ type: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' } });
  assert.match(state.toolsText(), /Run tests.*completed/);
  assert.doesNotMatch(JSON.stringify(state), /hidden/);
  state.apply({ type: 'update', update: { sessionUpdate: 'plan', entries: [{ content: 'Verify', status: 'in_progress', priority: 'high' }] } });
  assert.match(state.planText(), /Verify/);
  state.apply({ type: 'update', update: { sessionUpdate: 'usage_update', used: 120, size: 1000, cost: { amount: 0.2, currency: 'USD' } } });
  assert.match(state.usageText(), /120.*1000/);
});

test('commands and configuration are discovered, not invented, and lists are bounded', () => {
  const state = new AgentState();
  assert.match(state.commandsText(), /尚未/);
  state.apply({ type: 'update', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review project' }] } });
  assert.match(state.commandsText(), /\/review/);
  state.apply({ type: 'capabilities', steering: true, image: false });
  assert.match(state.capabilitiesText(), /steering.*支持/);
  for (let i = 0; i < 150; i++) state.apply({ type: 'update', update: { sessionUpdate: 'tool_call', toolCallId: String(i), title: `Tool ${i}` } });
  assert.ok(state.tools.size <= 30);
  assert.match(state.toolsText(), /Tool 149/);
});
