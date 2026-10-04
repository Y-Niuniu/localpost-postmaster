import test from 'node:test';
import assert from 'node:assert/strict';
import { ISOLATED_ROOT, PRODUCTION_ROOT, WIRING_STATUS, createIsolatedWiring } from './dsh-wiring.mjs';
import { COMMANDS, SUPPORTED_VERSION } from './dsh-host-bridge.mjs';
import { TOOL_NAMES } from './dsh-mail-tools.mjs';

/** The two registries with the shapes the installed host exposes, plus a live agent map. */
function fakeCtx() {
  const commands = [];
  const tools = [];
  const guards = [];
  const agents = new Map();
  return {
    commands, tools, guards, agents,
    ctx: {
      agents: { get: id => agents.get(id) },
      commands: {
        register: definition => { commands.push(definition); return () => { const at = commands.indexOf(definition); if (at >= 0) commands.splice(at, 1); }; },
        find: (agent, name) => commands.find(entry => entry.name === name),
      },
      tools: {
        register: definition => { tools.push(definition); return () => { const at = tools.indexOf(definition); if (at >= 0) tools.splice(at, 1); }; },
        get: (name, scope) => tools.find(entry => entry.name === name),
        guard: check => { guards.push(check); return () => { const at = guards.indexOf(check); if (at >= 0) guards.splice(at, 1); }; },
      },
    },
  };
}
const enabled = (extra = {}) => ({ enabled: true, root: ISOLATED_ROOT, ...extra });
const build = (host, config = enabled(), runtimeVersion = SUPPORTED_VERSION) =>
  createIsolatedWiring({ ctx: host.ctx, config, runtimeVersion });

test('without an explicit switch nothing is registered at all: the default is production-safe', () => {
  const host = fakeCtx();
  // No configuration at all is its own case: it must behave exactly like an explicit false.
  const bare = createIsolatedWiring({ ctx: host.ctx, runtimeVersion: SUPPORTED_VERSION });
  assert.equal(bare.enabled, false);
  assert.equal(bare.reason, 'disabled_by_default');
  bare.dispose();
  for (const config of [{}, { enabled: false }, { enabled: false, root: ISOLATED_ROOT }]) {
    const wiring = build(host, config);
    assert.equal(wiring.enabled, false);
    assert.equal(wiring.reason, 'disabled_by_default');
    assert.equal(wiring.status, WIRING_STATUS);
    assert.equal(host.commands.length, 0);
    assert.equal(host.tools.length, 0);
    assert.equal(host.guards.length, 0);
    wiring.dispose();   // a disabled wiring must still be safe to dispose
  }
});

test('the production mailbox root is refused, including anything under it', () => {
  const host = fakeCtx();
  for (const root of [PRODUCTION_ROOT, PRODUCTION_ROOT.toLowerCase(), PRODUCTION_ROOT + '/agents/dsh/inbox']) {
    const wiring = build(host, enabled({ root }));
    assert.equal(wiring.enabled, false, root + ' must be refused');
    assert.equal(wiring.reason, 'production_root_refused');
    assert.deepEqual([host.commands.length, host.tools.length, host.guards.length], [0, 0, 0]);
  }
});

test('only the isolated root is accepted: other, empty and relative roots fail closed', () => {
  const host = fakeCtx();
  for (const [root, reason] of [
    ['C:/AI_ASSIST/work/localpost-e-test-other', 'root_not_isolated'],
    ['C:/AI_ASSIST/work', 'root_not_isolated'],
    ['C:/AI_ASSIST/.mailbox-e', 'root_not_isolated'],
    ['', 'root_invalid'],
    ['relative/root', 'root_not_isolated'],
  ]) {
    const wiring = build(host, enabled({ root }));
    assert.equal(wiring.enabled, false, root + ' must be refused');
    assert.equal(wiring.reason, reason, root);
    assert.equal(host.commands.length + host.tools.length + host.guards.length, 0);
  }
});

test('the runtime version and the host capabilities both gate the wiring', () => {
  const wrongVersion = build(fakeCtx(), enabled(), '0.1.5-rc.1');
  assert.equal(wrongVersion.enabled, false);
  assert.equal(wrongVersion.reason, 'runtime_version_mismatch');

  const noTools = fakeCtx();
  delete noTools.ctx.tools.guard;
  const refused = build(noTools);
  assert.equal(refused.enabled, false);
  assert.match(refused.reason, /^tools_/);
  assert.equal(noTools.commands.length, 0, 'a refused wiring leaves the command registry untouched');

  const noAgents = fakeCtx();
  delete noAgents.ctx.agents;
  assert.equal(build(noAgents).enabled, false);
  assert.equal(noAgents.tools.length + noAgents.commands.length, 0);
});

test('an enabled wiring on the isolated root registers the commands, the tools and the guard', () => {
  const host = fakeCtx();
  const wiring = build(host);
  assert.equal(wiring.enabled, true);
  assert.equal(wiring.status, WIRING_STATUS);
  assert.deepEqual(host.commands.map(entry => entry.name).sort(), [COMMANDS.bind, COMMANDS.status, COMMANDS.unbind].sort());
  assert.deepEqual(host.tools.map(entry => entry.name).sort(), [...TOOL_NAMES].sort());
  assert.equal(host.guards.length, 1, 'the shadow guard must be registered with the tools');
  for (const definition of host.commands) assert.equal(definition.recordInput, false);
  // path.resolve returns native separators; compare slash-normalised so Windows and POSIX agree.
  assert.equal(wiring.parts.root.replaceAll(String.fromCharCode(92), '/').toLowerCase(), ISOLATED_ROOT.toLowerCase());
  assert.equal(wiring.parts.receiverFactory, undefined, 'live E must not start from loading the plugin');
  wiring.dispose();
});

test('a second wiring on the same host is refused and leaves the first one working', () => {
  const host = fakeCtx();
  const first = build(host);
  assert.equal(first.enabled, true);
  const second = build(host);
  assert.equal(second.enabled, false, 'a colliding registration must fail closed');
  assert.match(second.reason, /^commands_/);
  assert.equal(host.tools.length, TOOL_NAMES.length, 'the refused wiring must not disturb the first');
  assert.equal(host.guards.length, 1);
  first.dispose();
});

test('a dispose releases everything, is idempotent, and allows a fresh wiring afterwards', () => {
  const host = fakeCtx();
  const first = build(host);
  first.dispose();
  first.dispose();   // idempotent
  assert.deepEqual([host.commands.length, host.tools.length, host.guards.length], [0, 0, 0], 'no commands, tools or guard may survive a dispose');
  const again = build(host);
  assert.equal(again.enabled, true, 'a hot reload after dispose must be able to register again');
  assert.equal(host.tools.length, TOOL_NAMES.length);
  again.dispose();
  assert.deepEqual([host.commands.length, host.tools.length, host.guards.length], [0, 0, 0]);
});

test('the wired adapter reports its own capabilities instead of claiming they are verified', () => {
  const host = fakeCtx();
  const wiring = build(host);
  const diagnostics = wiring.parts.diagnostics();
  assert.equal(diagnostics.runtimeVersion, SUPPORTED_VERSION);
  assert.equal(typeof diagnostics.dispatchEnabled, 'boolean');
  const capabilities = wiring.parts.capabilities;
  assert.equal(capabilities.runtimeVersion, true);
  assert.equal(capabilities.toolRegistry, true);
  assert.equal(capabilities.toolLookup, true);
  assert.equal(capabilities.toolGuard, true);
  assert.equal(capabilities.liveAgentLookup, true);
  wiring.dispose();
});

test('a malformed config object cannot enable the wiring', () => {
  const host = fakeCtx();
  for (const config of [null, 'yes', 42, [], { enabled: 'true', root: ISOLATED_ROOT }, { enabled: 1, root: ISOLATED_ROOT }]) {
    const wiring = build(host, config);
    assert.equal(wiring.enabled, false, JSON.stringify(config) + ' must not enable anything');
    assert.equal(host.commands.length + host.tools.length + host.guards.length, 0);
  }
});
