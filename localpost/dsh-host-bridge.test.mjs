import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COMMANDS, chatSessionOf, createDshHostBridge } from './dsh-host-bridge.mjs';
import { createSessionStore } from './session-binding.mjs';
import { arrivalRoute, createBindingProvider } from './binding-provider.mjs';
import { removeTree } from './temp-tree.mjs';
import { acquireLease } from './fs-safe.mjs';

// Codex R2: tests must not depend on the system temp dir (its EPERM/realpath behaviour made runs flaky).
const TMP = path.resolve(import.meta.dirname, '..', '.localpost-tmp', 'dsh-host-bridge');
const created = [];
async function scratch(name) {
  const dir = path.join(TMP, name + '-' + Math.random().toString(16).slice(2, 8));
  await fs.mkdir(dir, { recursive: true });
  created.push(dir);
  return dir;
}
test.after(async () => { for (const dir of created) await removeTree(dir); await removeTree(TMP); });

// Every chat agent a test builds is live in the registry, which is what command attestation checks.
const live = new Map();
function fakeHost({ version = '0.2.0-rc.2', agents = live, commands = true, failOn = 0, existing = null, unregister = false } = {}) {
  const definitions = [];
  const released = [];
  const ctx = {};
  if (commands) {
    ctx.commands = {
      register: definition => {
        if (failOn && definitions.length + 1 === failOn) throw new Error('registry refused');
        definitions.push(definition);
        // unregister: like the real host, the disposer removes exactly this definition (older tests only record it).
        const dispose = () => {
          released.push(definition.name);
          if (unregister) { const at = definitions.indexOf(definition); if (at >= 0) definitions.splice(at, 1); }
        };
        return dispose;
      },
      // Like the real host: find resolves the effective definition for an agent, which is the one just registered.
      find: (agent, name) => (existing === null ? definitions.find(entry => entry.name === name) : (name === existing.name ? existing : undefined)),
    };
  }
  if (agents !== null) ctx.agents = { get: id => agents.get(id) };
  return { ctx, definitions, released, agents };
}
const chatAgent = (id, cwd = 'C:/work/A') => {
  const agent = { session: { id, header: { cwd } }, status: 'running', followup: async () => {} };
  live.set(id, agent);
  return agent;
};
const find = (definitions, name) => definitions.find(entry => entry.name === name);

async function bridgeFor(name, options = {}) {
  const root = await scratch(name);
  const store = createSessionStore({ root, waitMs: 500 });
  const host = fakeHost(options);
  const bridge = createDshHostBridge({ ctx: host.ctx, runtimeVersion: options.version ?? '0.2.0-rc.2', store, identity: 'dsh', ...options.extra });
  return { root, store, host, bridge };
}

test('an untrusted host registers nothing, writes nothing, and confirms nothing', async () => {
  for (const options of [{ commands: false }, { version: '0.1.5-rc.1' }, { agents: null }]) {
    const { bridge, host, store } = await bridgeFor('gate', options);
    assert.equal(bridge.capabilities.chatBinding, false);
    const registered = bridge.registerCommands();
    assert.equal(registered.ok, false);
    assert.equal(registered.reason, 'host_cannot_attest');
    assert.equal(host.definitions.length, 0, 'no command may be registered on an untrusted host');
    assert.equal(await store.read('dsh'), null, 'nothing may be written on an untrusted host');
    const confirmed = await bridge.confirmBindAction({ actionId: 'x', hostId: 'local', threadId: 'a', cwd: 'C:/w' });
    assert.deepEqual(confirmed, { confirmed: false, reason: 'host_untrusted' });
  }
});

test('diagnostics name every reason a binding cannot be trusted', async () => {
  const bad = await bridgeFor('reasons', { version: '0.1.5-rc.1' });
  const reasons = bad.bridge.diagnostics().reasons;
  assert.ok(reasons.includes('runtime_version_mismatch'), 'a version mismatch must be reported, not filtered out');
  const noLookup = await bridgeFor('reasons2');
  delete noLookup.host.ctx.agents;
  const second = createDshHostBridge({ ctx: noLookup.host.ctx, runtimeVersion: '0.2.0-rc.2', store: noLookup.store, identity: 'dsh' });
  assert.deepEqual(second.diagnostics().reasons, ['live_agent_lookup_unavailable']);
  const good = await bridgeFor('reasons3');
  assert.deepEqual(good.bridge.diagnostics().reasons, []);
});

test('the trusted host gets exactly three argument-free commands that are not logged', async () => {
  const { bridge, host } = await bridgeFor('register');
  const registered = bridge.registerCommands();
  assert.equal(registered.ok, true);
  assert.equal(host.definitions.length, 3);
  for (const definition of host.definitions) {
    assert.equal(definition.input, undefined, definition.name + ' must take no input');
    assert.equal(definition.recordInput, false, definition.name + ' must not record input');
  }
  assert.deepEqual(host.definitions.map(entry => entry.name).sort(), [COMMANDS.bind, COMMANDS.status, COMMANDS.unbind].sort());
  assert.equal(bridge.registerCommands().existing, true, 'registering twice must not duplicate');
  assert.equal(host.definitions.length, 3);
});

test('a taken command name and a mid-way registry failure both leave zero commands registered', async () => {
  const taken = await bridgeFor('taken', { existing: { name: COMMANDS.bind } });
  const refused = taken.bridge.registerCommands();
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'command_name_taken');
  assert.equal(taken.host.definitions.length, 0);

  const partial = await bridgeFor('partial', { failOn: 2 });
  const failed = partial.bridge.registerCommands();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'registration_failed');
  assert.deepEqual(partial.host.released, [COMMANDS.bind], 'the first registration must be released when a later one fails');
});

test('a chat identity needs the session id and an absolute workspace from the host', () => {
  assert.deepEqual(chatSessionOf({ agent: chatAgent('a', 'C:/w') }), { id: 'a', cwd: 'C:/w' });
  assert.equal(chatSessionOf({ agent: { session: { id: 'a', header: { cwd: 'relative/w' } } } }), null, 'a relative workspace is not bindable');
  assert.equal(chatSessionOf({ agent: { session: { id: 'a', header: {} } } }), null);
  assert.equal(chatSessionOf({ agent: { session: { id: 'a', cwd: 'C:/w' } } }), null, 'the workspace lives in the session header, not at the top level');
  assert.equal(chatSessionOf({}), null);
});

test('binding comes only from the chat the host hands to the handler, and repeating it changes nothing', async () => {
  const { bridge, host, store } = await bridgeFor('bind');
  bridge.registerCommands();
  const bind = find(host.definitions, COMMANDS.bind);
  assert.equal((await bind.handler({})).kind, 'error', 'no host chat means no binding');
  assert.equal(await store.read('dsh'), null);

  const first = await bind.handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  assert.equal(first.kind, 'success');
  const one = await store.read('dsh');
  assert.equal(one.binding.mode, 'auto');
  assert.deepEqual([one.binding.session.id, one.binding.session.cwd], ['chat-A', 'C:/work/A']);
  assert.match(one.binding.source, /^chat-action:[0-9a-f-]{36}$/);

  const repeat = await bind.handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  assert.equal(repeat.kind, 'success', 'repeating the same bind is an idempotent success');
  const two = await store.read('dsh');
  assert.equal(two.binding.source, one.binding.source, 'a repeat must not change source');
  assert.equal(two.binding.generation, one.binding.generation);
  assert.deepEqual(two.binding.attestation, one.binding.attestation);

  const moved = await bind.handler({ agent: chatAgent('chat-B', 'C:/work/B') });
  assert.equal(moved.kind, 'error', 'T1 cannot move a binding to another chat');
  assert.match(moved.text, /another chat/);
  assert.equal((await store.read('dsh')).binding.session.id, 'chat-A');
});

test('a forged or stale bind action is refused, and so is a chat the host does not know', async () => {
  const { bridge, host } = await bridgeFor('forge');
  bridge.registerCommands();
  assert.equal((await bridge.confirmBindAction({ actionId: 'forged', hostId: 'local', threadId: 'chat-A', cwd: 'C:/work/A' })).confirmed, false);
  assert.equal((await bridge.confirmBindAction({})).confirmed, false);
  assert.equal((await bridge.confirmBindAction({ actionId: '', hostId: '', threadId: '', cwd: '' })).confirmed, false);
  const result = await find(host.definitions, COMMANDS.bind).handler({ agent: { session: { id: 'chat-A' } } });
  assert.equal(result.kind, 'error');
});

test('describeThread answers online only for the very session we asked about', async () => {
  const { bridge, host } = await bridgeFor('describe');
  host.agents.set('chat-A', chatAgent('chat-A', 'C:/work/A'));
  host.agents.set('mismatch', chatAgent('other-id', 'C:/work/B'));
  host.agents.set('relative', chatAgent('relative', 'somewhere'));
  assert.deepEqual(await bridge.describeThread('chat-A'), { hostId: 'local', threadId: 'chat-A', cwd: 'C:/work/A', online: true });
  assert.equal((await bridge.describeThread('mismatch')).online, false, 'a live agent whose session id differs is not this chat');
  assert.equal((await bridge.describeThread('relative')).online, false);
  assert.equal((await bridge.describeThread('gone')).online, false);
  assert.equal((await bridge.describeThread('')).online, false);
});

test('the provider trusts the bridge only when it can attest, and verifies the bound chat through it', async () => {
  const { bridge, host, store } = await bridgeFor('provider');
  bridge.registerCommands();
  const provider = createBindingProvider({ store, identity: 'dsh', host: bridge });
  assert.equal(provider.trusted, true);
  await find(host.definitions, COMMANDS.bind).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  const route = arrivalRoute(await store.read('dsh')).route;
  const resolved = await provider.resolve(route);
  assert.equal(resolved.ok, true);
  host.agents.set('chat-A', chatAgent('chat-A', 'C:/work/A'));
  assert.equal(await provider.verifyBinding(resolved.target), true);
  host.agents.set('chat-A', chatAgent('chat-A', 'C:/other-workspace'));
  assert.equal(await provider.verifyBinding(resolved.target), false, 'a workspace change must fail closed');
  host.agents.delete('chat-A');
  assert.equal(await provider.verifyBinding(resolved.target), false, 'an offline chat must fail closed');
});

test('unbind works only from the bound chat and only stops routing for new mail', async () => {
  const { bridge, host, store } = await bridgeFor('unbind');
  bridge.registerCommands();
  await find(host.definitions, COMMANDS.bind).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  const wrongChat = await find(host.definitions, COMMANDS.unbind).handler({ agent: chatAgent('chat-B', 'C:/work/B') });
  assert.equal(wrongChat.kind, 'error');
  assert.match(wrongChat.text, /only the currently bound chat/);
  assert.equal((await store.read('dsh')).binding.mode, 'auto', 'a refused unbind must change nothing');

  const ok = await find(host.definitions, COMMANDS.unbind).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  assert.equal(ok.kind, 'success');
  assert.match(ok.text, /NEW mail/);
  const state = await store.read('dsh');
  assert.equal(state.binding.mode, 'manual');
  assert.deepEqual(arrivalRoute(state), { route: null, reason: 'binding_manual' });
});

test('unbind goes through the mode switch protocol: never under an in-flight dispatch, and the binding version moves', async () => {
  const { root, bridge, host, store } = await bridgeFor('unbind-protocol');
  bridge.registerCommands();
  const a = chatAgent('chat-A', 'C:/work/A');
  await find(host.definitions, COMMANDS.bind).handler({ agent: a });
  const before = (await store.read('dsh')).binding.version;
  // The receiver dispatching mail holds the identity's actor lease; switching modes under it is what the protocol forbids.
  const lease = await acquireLease(root, { name: '.session-actor-dsh.lock' });
  const busy = await find(host.definitions, COMMANDS.unbind).handler({ agent: a });
  assert.equal(busy.kind, 'error');
  assert.equal((await store.read('dsh')).binding.mode, 'auto', 'nothing changed while a dispatch may be in flight');
  await lease.release();
  const ok = await find(host.definitions, COMMANDS.unbind).handler({ agent: a });
  assert.equal(ok.kind, 'success');
  const { binding } = await store.read('dsh');
  assert.deepEqual([binding.mode, binding.state], ['manual', 'active']);
  assert.ok(binding.version > before, 'the CAS version moved with the mode');
});

test('unbind is a CAS on the binding the caller proved: a rotation in between fails it and leaves the new binding alone', async () => {
  const root = await scratch('unbind-race');
  const real = createSessionStore({ root, waitMs: 500 });
  let swap = null;
  // Deterministic race: the unbind's read gets A's snapshot, then - before the switch - the binding moves to B.
  const store = { ...real, read: async identity => {
    const snapshot = await real.read(identity);
    if (swap) { const run = swap; swap = null; await run(); }
    return snapshot;
  } };
  const host = fakeHost();
  const bridge = createDshHostBridge({ ctx: host.ctx, runtimeVersion: '0.2.0-rc.2', store, identity: 'dsh' });
  bridge.registerCommands();
  const a = chatAgent('chat-A', 'C:/work/A');
  await find(host.definitions, COMMANDS.bind).handler({ agent: a });
  swap = () => real.update('dsh', state => {
    Object.assign(state.binding, { session: { host: 'local', id: 'chat-B', cwd: 'C:/work/B' },
      generation: state.binding.generation + 1, version: state.binding.version + 2 });
  });
  const answer = await find(host.definitions, COMMANDS.unbind).handler({ agent: a });
  assert.equal(answer.kind, 'error', 'A no longer owns the binding it proved');
  const { binding } = await real.read('dsh');
  assert.deepEqual([binding.session.id, binding.mode], ['chat-B', 'auto'], 'B keeps automatic routing');
});

test('after an equal-version replacement (ABA) the unbind never reports success for a binding the caller did not prove', async () => {
  const root = await scratch('unbind-aba');
  const real = createSessionStore({ root, waitMs: 500 });
  let swap = null;
  const store = { ...real, read: async identity => {
    const snapshot = await real.read(identity);
    if (swap) { const run = swap; swap = null; await run(); }
    return snapshot;
  } };
  const host = fakeHost();
  const bridge = createDshHostBridge({ ctx: host.ctx, runtimeVersion: '0.2.0-rc.2', store, identity: 'dsh' });
  bridge.registerCommands();
  await find(host.definitions, COMMANDS.bind).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  // The binding record is removed and chat B binds afresh: a new binding starts at the same version, which a version CAS
  // cannot tell apart (known limit, see the R6 report). The final check must still refuse to call this a success.
  swap = async () => {
    await fs.rm(path.join(root, 'runtime', 'sessions', 'dsh.json'));
    assert.equal((await find(host.definitions, COMMANDS.bind).handler({ agent: chatAgent('chat-B', 'C:/work/B') })).kind, 'success');
  };
  const answer = await find(host.definitions, COMMANDS.unbind).handler({ agent: live.get('chat-A') });
  assert.equal(answer.kind, 'error');
});

test('a stale command disposer releases only its own registration: the successor stays registered and usable', async () => {
  const { bridge, host } = await bridgeFor('stale-command-dispose', { unregister: true });
  const first = bridge.registerCommands();
  first.dispose();
  const second = bridge.registerCommands();
  assert.equal(second.ok, true);
  first.dispose();                                   // late or repeated release of R1
  assert.deepEqual(host.definitions.map(entry => entry.name).sort(), Object.values(COMMANDS).sort(), 'R2 is still registered');
  const again = bridge.registerCommands();
  assert.deepEqual([again.ok, again.existing], [true, true], 'R2 is still the current registration, not a name conflict');
  const bound = await find(host.definitions, COMMANDS.bind).handler({ agent: chatAgent('chat-S', 'C:/work/S') });
  assert.equal(bound.kind, 'success', 'and its commands still work');
});

test('status reports the binding without claiming more than the host can prove', async () => {
  const { bridge, host } = await bridgeFor('status');
  bridge.registerCommands();
  assert.equal((await find(host.definitions, COMMANDS.status).handler({})).kind, 'error');
  await find(host.definitions, COMMANDS.bind).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  // A caller the host cannot prove learns nothing about the binding.
  const substituted = await find(host.definitions, COMMANDS.status).handler({ agent: { session: { id: 'chat-A', header: { cwd: 'C:/work/A' } } } });
  assert.equal(substituted.kind, 'error', 'an agent the live registry does not hand back must not read the binding');
  // The live agent of the bound chat may.
  const shown = await find(host.definitions, COMMANDS.status).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  assert.equal(shown.kind, 'success');
  assert.match(shown.text, /mode=auto/);
  assert.match(shown.text, /chat=chat-A/);
  assert.match(shown.text, /attested=true/);
  // Same chat id, another workspace: not the bound chat.
  const drifted = await find(host.definitions, COMMANDS.status).handler({ agent: chatAgent('chat-A', 'C:/work/ELSEWHERE') });
  assert.equal(drifted.kind, 'error', 'workspace drift must not read the binding');
});
