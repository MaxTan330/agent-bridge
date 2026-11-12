import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
let prompt;
let safe = false;
let sessionCwd;
let clientInfo;
const modes = { currentModeId: 'acceptEdits', availableModes: [{ id: 'bypassPermissions', name: 'Bypass permissions' }, { id: 'acceptEdits', name: 'Accept edits' }] };
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  const fail = message => send({ id: m.id, error: { code: -32602, message } });
  if (m.method === 'initialize' && process.env.CLAUDE_CONFIG_DIR === 'fixture-initialize-hang') return;
  if (m.method === 'initialize') {
    clientInfo = m.params.clientInfo;
    send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
  if (m.method === 'session/new' || m.method === 'session/load') {
    sessionCwd = m.params.cwd;
    if (m.params._meta?.claudeCode?.options?.allowDangerouslySkipPermissions !== true) return fail('Missing bypass enablement');
    send({ id: m.id, result: { ...(m.method === 'session/new' ? { sessionId: 'fixture' } : {}), modes: process.env.CLAUDE_CONFIG_DIR === 'fixture-no-modes' ? undefined : modes } });
  }
  if (m.method === 'session/set_mode') {
    if (process.env.CLAUDE_CONFIG_DIR === 'fixture-mode-failure') return fail('Mode rejected');
    if (m.params.modeId !== 'bypassPermissions') return fail('Not bypass mode');
    if (process.env.CLAUDE_CONFIG_DIR === 'fixture-mode-fallback') send({ method: 'session/update', params: { sessionId: 'fixture', update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' } } });
    safe = true;
    send({ id: m.id, result: {} });
  }
  if (m.method === 'session/prompt') {
    if (!safe) return fail('Prompt before bypass mode');
    prompt = m.id;
    const input = m.params.prompt[0].text;
    const text = input === 'environment' ? JSON.stringify(process.env)
      : input === 'working-directory' ? JSON.stringify({ cwd: process.cwd(), sessionCwd })
      : input === 'client-info' ? JSON.stringify(clientInfo) : 'hello from agent';
    send({ method: 'session/update', params: { sessionId: 'fixture', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    send({ id: 'approval', method: 'session/request_permission', params: { sessionId: 'fixture', toolCall: { toolCallId: 'tool', title: 'Test' }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] } });
  }
  if (m.id === 'approval') send({ id: prompt, result: { stopReason: 'end_turn' } });
});
