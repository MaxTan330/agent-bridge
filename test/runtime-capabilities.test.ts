import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AcpRuntime } from '../src/runtime.ts';

const fixture = fileURLToPath(new URL('./fixture-capabilities.mjs', import.meta.url));
const permission = async () => ({ outcome: { outcome: 'cancelled' as const } });

test('native setup forwards scoped commands, config preferences, plan mode and MCP', async () => {
  const rt = new AcpRuntime(process.cwd(), fixture, {
    maxTurns: 12, maxBudgetUsd: 3.5,
    mcpServers: [{ name: 'local', command: 'node', args: [], env: [] }],
  });
  const events: any[] = [];
  let text = '';
  try {
    const s = await rt.open(undefined, c => text += c, permission, undefined, {
      mode: 'plan', model: 'b', effort: 'high', onEvent: e => events.push(e),
    });
    assert.equal(text, '');
    assert.ok(events.some(e => e.type === 'capabilities' && e.steering));
    assert.ok(events.some(e => e.update?.availableCommands?.[0]?.name === 'compact'));
    assert.ok(!JSON.stringify(events).includes('wrong'));
    await rt.prompt(s, 'inspect');
    const result = JSON.parse(text);
    assert.deepEqual(result.options.map((o: any) => o.currentValue), ['b', 'high']);
    assert.equal(result.setup.mcpServers[0].name, 'local');
    assert.equal(result.setup._meta.claudeCode.options.maxTurns, 12);
    assert.equal(result.setup._meta.claudeCode.options.maxBudgetUsd, 3.5);
    assert.equal(result.capabilities.elicitation, undefined);
    assert.ok(events.some(e => e.update?.sessionUpdate === 'plan'));
  } finally {
    await rt.stop();
  }
});

test('steering uses advertised extension and returns native outcome', async () => {
  const rt = new AcpRuntime(process.cwd(), fixture);
  try {
    const s = await rt.open(undefined, () => {}, permission);
    assert.equal(await rt.steer(s, 'go'), 'injected');
    assert.equal(await rt.steer(s, 'idle'), 'promptRequired');
  } finally {
    await rt.stop();
  }
});

test('invalid preferences fail before prompt', async () => {
  const rt = new AcpRuntime(process.cwd(), fixture);
  try {
    await assert.rejects(
      rt.open(undefined, () => {}, permission, undefined, { model: 'missing' }),
      /model.*unavailable/i,
    );
  } finally {
    await rt.stop();
  }
});

test('form elicitation is advertised and answered by hook', async () => {
  const rt = new AcpRuntime(process.cwd(), fixture);
  let text = '';
  try {
    const s = await rt.open(undefined, c => text += c, permission, undefined, {
      onQuestion: async (q, signal) => {
        assert.equal(q.message, 'Choose');
        assert.equal(signal?.aborted, false);
        return { action: 'accept', content: { choice: 'yes' } };
      },
    });
    await rt.prompt(s, 'question');
    assert.deepEqual(JSON.parse(text), { action: 'accept', content: { choice: 'yes' } });
  } finally {
    await rt.stop();
  }
});

for (const scenario of ['unsupported', 'fallback']) test(`native ${scenario} fails closed`, async () => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = scenario;
  const rt = new AcpRuntime(process.cwd(), fixture);
  try {
    if (scenario === 'fallback') {
      await assert.rejects(rt.open(undefined, () => {}, permission, undefined, { mode: 'plan' }), /not confirmed/);
    } else {
      const session = await rt.open(undefined, () => {}, permission);
      await assert.rejects(rt.steer(session, 'go'), /unavailable/);
    }
  } finally {
    await rt.stop();
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

for (const old of [undefined, 'native']) test(`native attribution disabled on ${old ? 'load' : 'new'}`, async () => {
  const rt = new AcpRuntime(process.cwd(), fixture);
  let text = '';
  try {
    const s = await rt.open(old, c => text += c, permission);
    await rt.prompt(s, 'inspect');
    const options = JSON.parse(text).setup._meta.claudeCode.options;
    assert.deepEqual(options.settings.attribution, { commit: '', pr: '', sessionUrl: false });
    assert.equal(options.settingSources, undefined);
    assert.equal(options.settings.includeCoAuthoredBy, false);
  } finally {
    await rt.stop();
  }
});

test('cancel aborts an outstanding user question', async () => {
  const rt = new AcpRuntime(process.cwd(), fixture);
  let signal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>(resolve => started = resolve);
  try {
    const s = await rt.open(undefined, () => {}, permission, undefined, {
      onQuestion: async (_q, sig) => {
        signal = sig;
        started();
        return new Promise(() => {});
      },
    });
    const prompt = rt.prompt(s, 'question');
    await ready;
    await rt.cancel(s);
    assert.equal(signal?.aborted, true);
    await prompt;
  } finally {
    await rt.stop();
  }
});

test('stop cancels outstanding steering without a prompt fallback', async () => {
  const rt = new AcpRuntime(process.cwd(), fixture);
  try {
    const s = await rt.open(undefined, () => {}, permission);
    const steering = rt.steer(s, 'hang');
    const rejected = assert.rejects(steering);
    await rt.stop();
    await rejected;
  } finally {
    await rt.stop();
  }
});

test('unexpected live mode transition rejects the active prompt', async () => {
  const rt = new AcpRuntime(process.cwd(), fixture);
  try {
    const s = await rt.open(undefined, () => {}, permission);
    await assert.rejects(rt.prompt(s, 'mode-change'), /mode.*changed/i);
    await assert.rejects(rt.prompt(s, 'again'), /not ready/);
  } finally {
    await rt.stop();
  }
});

test('images and file text are forwarded as ACP blocks', async () => {
  const rt = new AcpRuntime(process.cwd(), fixture);
  let text = '';
  try {
    const s = await rt.open(undefined, c => text += c, permission);
    const blocks = [
      { type: 'image' as const, data: 'abc', mimeType: 'image/png' },
      { type: 'text' as const, text: 'file' },
    ];
    await rt.prompt(s, 'inspect', blocks);
    assert.deepEqual(JSON.parse(text).blocks, [{ type: 'text', text: 'inspect' }, ...blocks]);
  } finally {
    await rt.stop();
  }
});

test('old adapters reject images before prompt', async () => {
  const rt = new AcpRuntime(process.cwd(), fileURLToPath(new URL('./fixture-agent.mjs', import.meta.url)));
  try {
    const s = await rt.open(undefined, () => {}, permission);
    await assert.rejects(rt.prompt(s, 'inspect', [{ type: 'image', data: 'abc', mimeType: 'image/png' }]), /image.*unavailable/i);
  } finally {
    await rt.stop();
  }
});

test('mode config notification remains latest after ACK', async () => {
  const rt = new AcpRuntime(process.cwd(), fixture);
  const configs: any[] = [];
  try {
    await rt.open(undefined, () => {}, permission, undefined, {
      mode: 'plan',
      onEvent: e => {
        if (e.type === 'config') configs.push(e.options);
      },
    });
    assert.equal(configs.at(-1).find((o: any) => o.id === 'mode')?.currentValue, 'plan');
  } finally {
    await rt.stop();
  }
});
