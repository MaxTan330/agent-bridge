import { createInterface } from 'node:readline';

const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
let capabilities, setup, prompt;
let options = [
  {
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'a',
    options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }],
  },
  {
    id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low',
    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
  },
];

createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  const ok = result => send({ id: m.id, result });

  if (m.method === 'initialize') {
    capabilities = m.params.clientCapabilities;
    ok({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      _meta: { steering: { supported: process.env.CLAUDE_CONFIG_DIR !== 'unsupported' } },
    });
  }
  if (m.method === 'session/new' || m.method === 'session/load') {
    setup = m.params;
    update('wrong', {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'wrong', description: 'wrong' }],
    });
    update('native', {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'compact', description: 'Compact' }],
    });
    update('native', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'history' } });
    ok({
      sessionId: 'native',
      modes: {
        currentModeId: 'default',
        availableModes: [{ id: 'bypassPermissions', name: 'Bypass' }, { id: 'plan', name: 'Plan' }],
      },
      configOptions: options,
    });
  }
  if (m.method === 'session/set_mode') {
    update('native', {
      sessionUpdate: 'config_option_update',
      configOptions: [...options, {
        id: 'mode', name: 'Mode', type: 'select', currentValue: m.params.modeId,
        options: [{ value: 'plan', name: 'Plan' }, { value: 'bypassPermissions', name: 'Bypass' }],
      }],
    });
    update('wrong', { sessionUpdate: 'current_mode_update', currentModeId: 'default' });
    if (process.env.CLAUDE_CONFIG_DIR === 'fallback') {
      update('native', { sessionUpdate: 'current_mode_update', currentModeId: 'default' });
    }
    ok({});
  }
  if (m.method === 'session/set_config_option') {
    options = options.map(o => o.id === m.params.configId ? { ...o, currentValue: m.params.value } : o);
    ok({ configOptions: options });
  }
  if (m.method === '_session/steering') {
    if (m.params._meta.steering.idleBehavior !== 'promptRequired') throw Error('unsafe steering');
    if (m.params.prompt[0].text === 'hang') return;
    ok({ outcome: m.params.prompt[0].text === 'idle' ? 'promptRequired' : 'injected' });
  }
  if (m.method === 'session/prompt') {
    prompt = m.id;
    const text = m.params.prompt[0].text;
    if (text === 'mode-change') {
      update('native', { sessionUpdate: 'current_mode_update', currentModeId: 'default' });
    }
    if (text === 'question') {
      send({
        id: 'question', method: 'elicitation/create',
        params: {
          sessionId: 'native', mode: 'form', message: 'Choose',
          requestedSchema: { type: 'object', properties: { choice: { type: 'string' } } },
        },
      });
      return;
    }
    update('wrong', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrong' } });
    update('native', { sessionUpdate: 'plan', entries: [] });
    update('native', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: JSON.stringify({ capabilities, setup, options, blocks: m.params.prompt }) },
    });
    ok({ stopReason: 'end_turn' });
  }
  if (m.id === 'question') {
    update('native', {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(m.result) },
    });
    send({ id: prompt, result: { stopReason: 'end_turn' } });
  }
});
