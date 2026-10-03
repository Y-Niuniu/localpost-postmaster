import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { COMMANDS, chatSessionOf, createDshHostBridge } from './dsh-host-bridge.mjs';
import { createSessionStore } from './session-binding.mjs';
import { arrivalRoute, createBindingProvider } from './binding-provider.mjs';
import { removeTree } from './temp-tree.mjs';

const roots = [];
async function scratch(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-bridge-' + name + '-'));
  roots.push(dir);
  return dir;
}
test.after(async () => { for (const dir of roots) await removeTree(dir); });

function fakeHost({ version = '0.2.0-rc.2', agents = new Map(), commands = true } = {}) {
  const definitions = [];
  const ctx = {};
  if (commands) ctx.commands = { register: definition => { definitions.push(definition); return () => {}; } };
  ctx.agents = { get: id => agents.get(id) };
  return { ctx, definitions, agents };
}
const liveAgent = (id, cwd) => ({ session: { id, cwd }, status: 'running', followup: async () => {} });
const find = (definitions, name) => definitions.find(entry => entry.name === name);

async function bridgeFor(name, options = {}) {
  const root = await scratch(name);
  const store = createSessionStore({ root, waitMs: 500 });
  const host = fakeHost(options);
  const bridge = createDshHostBridge({ ctx: host.ctx, runtimeVersion: options.version ?? '0.2.0-rc.2', store, identity: 'dsh', ...options.extra });
  return { root, store, host, bridge };
}

test('the bridge refuses to look trustworthy when the host cannot supply a chat identity', async () => {
  const noCommands = await bridgeFor('nocmd', { commands: false });
  assert.equal(noCommands.bridge.capabilities.chatBinding, false);
  assert.throws(() => noCommands.bridge.registerCommands(), { code: 'command_registry_unavailable' });

  const wrongVersion = await bridgeFor('badver', { version: '0.1.5-rc.1' });
  assert.equal(wrongVersion.bridge.capabilities.chatBinding, false);

  const good = await bridgeFor('good');
  assert.equal(good.bridge.capabilities.chatBinding, true);
  assert.deepEqual(good.bridge.diagnostics().reasons, []);
});

test('reading a chat identity needs both the session id and an absolute workspace from the host', () => {
  assert.deepEqual(chatSessionOf({ agent: { session: { id: 'a', cwd: 'C:/w' } } }), { id: 'a', cwd: 'C:/w' });
  assert.equal(chatSessionOf({ agent: { session: { id: 'a' } } }), null);
  assert.equal(chatSessionOf({ agent: { session: { cwd: 'C:/w' } } }), null);
  assert.equal(chatSessionOf({ agent: {} }), null);
  assert.equal(chatSessionOf({}), null);
});

test('every command takes no input, so nothing about a binding is model-controllable', async () => {
  const { bridge, host } = await bridgeFor('noinput');
  bridge.registerCommands();
  assert.equal(host.definitions.length, 3);
  for (const definition of host.definitions) {
    assert.equal(definition.input, undefined, definition.name + ' must take no input');
    assert.equal(definition.recordInput, false, definition.name + ' must not record its input');
  }
  assert.deepEqual(host.definitions.map(entry => entry.name).sort(), [COMMANDS.bind, COMMANDS.status, COMMANDS.unbind].sort());
});

test('binding happens only from the chat the host hands to the handler, and it is attested', async () => {
  const { bridge, host, store } = await bridgeFor('bind');
  bridge.registerCommands();
  const result = await find(host.definitions, COMMANDS.bind).handler({ agent: liveAgent('chat-A', 'C:/work/A') });
  assert.equal(result.kind, 'success');
  const state = await store.read('dsh');
  assert.equal(state.binding.mode, 'auto');
  assert.equal(state.binding.session.id, 'chat-A');
  assert.equal(state.binding.session.cwd, 'C:/work/A');
  assert.equal(state.binding.attestation.kind, 'chat-action');
  assert.match(state.binding.source, /^chat-action:/);
  assert.deepEqual(arrivalRoute(state).route.threadId, 'chat-A');
});

test('a chat whose identity or workspace the host cannot attest is refused, and nothing is written', async () => {
  const { bridge, host, store } = await bridgeFor('noident');
  bridge.registerCommands();
  const result = await find(host.definitions, COMMANDS.bind).handler({ agent: { session: { id: 'chat-X' } } });
  assert.equal(result.kind, 'error');
  assert.equal(await store.read('dsh'), null);
});

test('a hand-made action is never trusted; repeats are refused and a rebind mints its own action', async () => {
  const { bridge, host, store } = await bridgeFor('actions');
  bridge.registerCommands();
  // Nothing a model could pass looks like an action: unknown, empty and blank ids all fail.
  assert.equal((await bridge.confirmBindAction({ actionId: 'forged', hostId: 'local', threadId: 'chat-A', cwd: 'C:/work/A' })).confirmed, false);
  assert.equal((await bridge.confirmBindAction({})).confirmed, false);
  assert.equal((await bridge.confirmBindAction({ actionId: '', hostId: 'local', threadId: '', cwd: '' })).confirmed, false);
  const first = await find(host.definitions, COMMANDS.bind).handler({ agent: liveAgent('chat-A', 'C:/work/A') });
  assert.equal(first.kind, 'success');
  const one = (await store.read('dsh')).binding.source;
  assert.match(one, /^chat-action:[0-9a-f-]{36}$/);
  const repeat = await find(host.definitions, COMMANDS.bind).handler({ agent: liveAgent('chat-A', 'C:/work/A') });
  assert.equal(repeat.kind, 'error', 'repeating the same bind must be refused, not silently re-attested');
  const moved = await find(host.definitions, COMMANDS.bind).handler({ agent: liveAgent('chat-B', 'C:/work/B') });
  // A second bind is refused by the store (already_bound). Moving the mail chat to another chat therefore has
  // NO path today: it is not a rebind, it must be an operational change with its own contract. Recorded as a gap.
  assert.equal(moved.kind, 'error', 'rebinding to another chat is not supported yet');
  const state = await store.read('dsh');
  assert.equal(state.binding.session.id, 'chat-A', 'a refused rebind must leave the original binding untouched');
  assert.equal(state.binding.source, one);
});

test('describeThread reports online only for a live agent that still reports the same workspace', async () => {
  const { bridge, host } = await bridgeFor('describe');
  host.agents.set('chat-A', liveAgent('chat-A', 'C:/work/A'));
  host.agents.set('chat-B', { session: { id: 'chat-B' } });
  assert.deepEqual(await bridge.describeThread('chat-A'), { hostId: 'local', threadId: 'chat-A', cwd: 'C:/work/A', online: true });
  assert.equal((await bridge.describeThread('chat-B')).online, false);
  assert.equal((await bridge.describeThread('gone')).online, false);
  assert.equal((await bridge.describeThread('')).online, false);
});

test('the provider stays untrusted until the bridge can attest, and verifies the bound chat through it', async () => {
  const { bridge, host, store } = await bridgeFor('provider');
  bridge.registerCommands();
  const provider = createBindingProvider({ store, identity: 'dsh', host: bridge });
  assert.equal(provider.trusted, true);
  await find(host.definitions, COMMANDS.bind).handler({ agent: liveAgent('chat-A', 'C:/work/A') });
  const state = await store.read('dsh');
  const route = arrivalRoute(state).route;
  const resolved = await provider.resolve(route);
  assert.equal(resolved.ok, true);
  host.agents.set('chat-A', liveAgent('chat-A', 'C:/work/A'));
  assert.equal(await provider.verifyBinding(resolved.target), true);
  host.agents.delete('chat-A');
  assert.equal(await provider.verifyBinding(resolved.target), false, 'an offline chat must fail closed');
});

test('unbind turns automatic routing off and leaves the mail for manual reading', async () => {
  const { bridge, host, store } = await bridgeFor('unbind');
  bridge.registerCommands();
  await find(host.definitions, COMMANDS.bind).handler({ agent: liveAgent('chat-A', 'C:/work/A') });
  const result = await find(host.definitions, COMMANDS.unbind).handler({});
  assert.equal(result.kind, 'success');
  const state = await store.read('dsh');
  assert.equal(state.binding.mode, 'manual');
  assert.deepEqual(arrivalRoute(state), { route: null, reason: 'binding_manual' });
});

test('status reports the binding without claiming more than the host can prove', async () => {
  const { bridge, host } = await bridgeFor('status');
  bridge.registerCommands();
  const empty = await find(host.definitions, COMMANDS.status).handler({});
  assert.equal(empty.kind, 'error');
  await find(host.definitions, COMMANDS.bind).handler({ agent: liveAgent('chat-A', 'C:/work/A') });
  const shown = await find(host.definitions, COMMANDS.status).handler({});
  assert.equal(shown.kind, 'success');
  assert.match(shown.text, /mode=auto/);
  assert.match(shown.text, /chat=chat-A/);
  assert.match(shown.text, /attested=true/);
});
