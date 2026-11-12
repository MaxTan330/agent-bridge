import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { AcpRuntime } from '../src/runtime.ts';

test('real stdio transports initialize, session, text and permission', async () => {
  const rt = new AcpRuntime(process.cwd(), fileURLToPath(new URL('./fixture-agent.mjs', import.meta.url)));
  let text = ''; let approvals = 0;
  try {
    const session = await rt.open(undefined, chunk => { text += chunk; }, async () => {
      approvals++; return { outcome: { outcome: 'selected', optionId: 'yes' } };
    });
    assert.equal(session, 'fixture');
    assert.equal(await rt.prompt(session, 'hello'), 'end_turn');
    assert.equal(text, 'hello from agent'); assert.equal(approvals, 1);
    text = '';
    assert.equal(await rt.open(session, chunk => { text += chunk; }, async () => ({ outcome: { outcome: 'cancelled' } })), session);
    assert.equal(text, '');
    assert.equal(await rt.prompt(session, 'hello again'), 'end_turn');
    assert.equal(text, 'hello from agent');
  } finally { await rt.stop(); }
});

const fixture = fileURLToPath(new URL('./fixture-agent.mjs', import.meta.url));
const permission = async () => ({ outcome: { outcome: 'cancelled' as const } });

test('adapter fallback to interactive mode blocks the prompt for both new and resumed sessions', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = 'fixture-mode-fallback';
  const rt = new AcpRuntime(process.cwd(), fixture);
  try {
    for (const old of [undefined, 'fixture']) {
      await assert.rejects(rt.open(old, () => {}, permission), /not confirmed/);
      await assert.rejects(rt.prompt('fixture', 'go'), /not ready/);
    }
  } finally {
    await rt.stop();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test('adapter process and new/load session use the selected project instead of bridge cwd', async () => {
  const project = realpathSync(fileURLToPath(new URL('../scripts', import.meta.url)));
  assert.notEqual(project, process.cwd());
  const rt = new AcpRuntime(project, fixture);
  try {
    for (const old of [undefined, 'fixture']) {
      let text = '';
      const session = await rt.open(old, chunk => { text += chunk; }, permission);
      await rt.prompt(session, 'working-directory');
      const actual = JSON.parse(text);
      assert.equal(actual.cwd, project);
      assert.equal(actual.sessionCwd, project);
    }
  } finally { await rt.stop(); }
});

for (const old of [undefined, 'fixture']) {
  test(`noninteractive mode failure blocks prompts (${old ? 'load' : 'new'})`, async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = 'fixture-mode-failure';
    const rt = new AcpRuntime(process.cwd(), fixture);
    try {
      await assert.rejects(rt.open(old, () => {}, permission), /Mode rejected/);
      await assert.rejects(rt.prompt('fixture', 'hello'), /not connected|not ready/i);
    } finally {
      await rt.stop();
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
}

test('stop shares cleanup and resets across two lifecycles', async () => {
  const rt = new AcpRuntime(process.cwd(), fixture);
  await rt.stop(); // Empty cleanup must not poison subsequent cleanup.
  for (let round = 0; round < 2; round++) {
    await rt.open(undefined, () => {}, permission);
    const first = rt.stop();
    assert.equal(rt.stop(), first);
    await first;
    assert.equal(rt.process, undefined);
  }
});

test('runtime forwards deployment model, registry, proxy and locale variables without unrelated secrets', async () => {
  const values = {
    http_proxy: 'http://localhost:1234', https_proxy: 'http://localhost:1235', all_proxy: 'socks5://localhost:1236', no_proxy: 'localhost',
    LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai', npm_config_registry: 'https://registry.npmmirror.com',
    ANTHROPIC_BASE_URL: 'https://gateway.example.com', ANTHROPIC_AUTH_TOKEN: 'fixture-bearer', ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_MODEL: 'fixture-main', ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-sonnet',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'fixture-opus', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-haiku',
    CLAUDE_CODE_SUBAGENT_MODEL: 'fixture-subagent', CLAUDE_CONFIG_DIR: 'fixture-config',
    FEISHU_APP_SECRET: 'do-not-forward', NPM_TOKEN: 'do-not-forward', UNRELATED_SECRET: 'do-not-forward',
  };
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  const rt = new AcpRuntime(process.cwd(), fixture);
  let text = '';
  try {
    const session = await rt.open(undefined, chunk => { text += chunk; }, permission);
    await rt.prompt(session, 'environment');
    const actual = JSON.parse(text);
    for (const [key, value] of Object.entries(values)) {
      if (value === 'do-not-forward') assert.equal(actual[key], undefined);
      else assert.equal(actual[key] ?? actual[key.toUpperCase()], value, key);
    }
  } finally {
    await rt.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('runtime omits a blank gateway so Claude can resolve its own route', async () => {
  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = '   ';
  const rt = new AcpRuntime(process.cwd(), fixture);
  let text = '';
  try {
    const session = await rt.open(undefined, chunk => { text += chunk; }, permission);
    await rt.prompt(session, 'environment');
    assert.equal(JSON.parse(text).ANTHROPIC_BASE_URL, undefined);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous;
    await rt.stop();
  }
});

test('open waits for cleanup and a cancelled queued open never spawns', async () => {
  let release!: () => void;
  class ControlledRuntime extends AcpRuntime {
    protected override async terminate(child: NonNullable<AcpRuntime['process']>) {
      await new Promise<void>(resolve => { release = resolve; });
      await super.terminate(child);
    }
  }
  const rt = new ControlledRuntime(process.cwd(), fixture);
  await rt.open(undefined, () => {}, permission);
  const previousChild = rt.process;
  const stop = rt.stop();
  await Promise.resolve();
  const controller = new AbortController();
  const opening = rt.open(undefined, () => {}, permission, controller.signal);
  const rejected = assert.rejects(opening, /abort/i);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(rt.process, previousChild);
  controller.abort();
  release();
  await stop;
  await rejected;
  assert.equal(rt.process, undefined);
});

test('failed cleanup is shared and can be retried on the next lifecycle', async () => {
  class FailingRuntime extends AcpRuntime {
    fail = true;
    protected override async terminate(child: NonNullable<AcpRuntime['process']>) {
      await super.terminate(child);
      if (this.fail) { this.fail = false; throw new Error('cleanup fixture failure'); }
    }
  }
  const rt = new FailingRuntime(process.cwd(), fixture);
  await rt.open(undefined, () => {}, permission);
  const stop = rt.stop();
  assert.equal(rt.stop(), stop);
  await assert.rejects(stop, /cleanup fixture failure/);
  try {
    await rt.open(undefined, () => {}, permission);
  } finally { await rt.stop(); }
});

test('missing noninteractive mode capability fails closed', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = 'fixture-no-modes';
  const rt = new AcpRuntime(process.cwd(), fixture);
  try {
    await assert.rejects(rt.open(undefined, () => {}, permission), /mode unavailable/);
    await assert.rejects(rt.prompt('fixture', 'hello'), /not ready/);
  } finally {
    await rt.stop();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test('abort during initialize closes the connection and cleans up', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = 'fixture-initialize-hang';
  const rt = new AcpRuntime(process.cwd(), fixture);
  const controller = new AbortController();
  try {
    const opening = rt.open(undefined, () => {}, permission, controller.signal);
    const rejected = assert.rejects(opening);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(rt.process);
    controller.abort();
    await rejected;
    assert.equal(rt.process, undefined);
    assert.equal(rt.connection, undefined);
  } finally {
    await rt.stop();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});


test('failed termination retains process for a real cleanup retry', async () => {
  class RetryRuntime extends AcpRuntime {
    attempts = 0;
    protected override async terminate(child: NonNullable<AcpRuntime['process']>) {
      if (++this.attempts === 1) throw new Error('EPERM fixture');
      await super.terminate(child);
    }
  }
  const rt = new RetryRuntime(process.cwd(), fixture);
  await rt.open(undefined, () => {}, permission);
  const child = rt.process;
  try {
    await assert.rejects(rt.stop(), /EPERM fixture/);
    assert.equal(rt.process, child);
    await rt.stop();
    assert.equal(rt.attempts, 2);
    assert.equal(rt.process, undefined);
  } finally { child?.kill(); await rt.stop(); }
});

class GroupRuntime extends AcpRuntime {
  protected override useProcessGroups = true;
  protected override terminationGraceMs = 1;
  protected override terminationTimeoutMs = 25;
  signals: Array<NodeJS.Signals | 0> = [];
  alive = true;
  error?: Error;
  protected override signalProcess(_child: NonNullable<AcpRuntime['process']>, signal: NodeJS.Signals | 0) {
    this.signals.push(signal);
    if (this.error) throw this.error;
    return this.alive;
  }
  constructor() {
    super(process.cwd(), fixture);
    this.process = { pid: 123, exitCode: 0, signalCode: null } as NonNullable<AcpRuntime['process']>;
  }
}

test('POSIX cleanup waits for group disappearance after leader exit and SIGKILL', async () => {
  const rt = new GroupRuntime();
  const stop = rt.stop();
  let settled = false;
  void stop.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(rt.signals.includes('SIGKILL'));
  assert.equal(settled, false);
  rt.alive = false;
  await stop;
  assert.equal(rt.process, undefined);
});

test('POSIX cleanup times out without losing the group and retries', async () => {
  const rt = new GroupRuntime();
  await assert.rejects(rt.stop(), /termination timed out/);
  assert.ok(rt.process);
  rt.alive = false;
  await rt.stop();
  assert.equal(rt.process, undefined);
});

test('cleanup propagates permission failures and retains the process', async () => {
  const rt = new GroupRuntime();
  rt.error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  await assert.rejects(rt.stop(), /operation not permitted/);
  assert.ok(rt.process);
  rt.error = undefined;
  rt.alive = false;
  await rt.stop();
});


test('Windows cleanup waits for observed leader exit after forced kill', async () => {
  class WindowsRuntime extends GroupRuntime {
    protected override useProcessGroups = false;
    protected override terminationTimeoutMs = 200;
  }
  const rt = new WindowsRuntime();
  rt.process!.exitCode = null;
  const stop = rt.stop();
  let settled = false;
  void stop.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(rt.signals.includes('SIGKILL'));
  assert.equal(settled, false);
  rt.process!.signalCode = 'SIGKILL';
  await stop;
  assert.equal(rt.process, undefined);
});

test('Windows cleanup times out if exit is never observed', async () => {
  class WindowsRuntime extends GroupRuntime { protected override useProcessGroups = false; }
  const rt = new WindowsRuntime();
  rt.process!.exitCode = null;
  await assert.rejects(rt.stop(), /termination timed out/);
  assert.ok(rt.process);
  rt.process!.exitCode = 0;
  await rt.stop();
});

test('failed spawn without a PID clears runtime state', async () => {
  const rt = new AcpRuntime(process.cwd(), fixture);
  rt.process = { pid: undefined, exitCode: null, signalCode: null } as NonNullable<AcpRuntime['process']>;
  await rt.stop();
  assert.equal(rt.process, undefined);
});
