import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COMMANDS, chatSessionOf, createDshHostBridge } from './dsh-host-bridge.mjs';
import { createSessionStore } from './session-binding.mjs';
import { arrivalRoute, attestedNow, createBindingProvider } from './binding-provider.mjs';
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

// A switch retries while a dispatch holds the actor lease; tests keep that window short unless they measure it.
const QUICK = Object.freeze({ busyRetries: 5, busyPauseMs: 10 });
async function bridgeFor(name, options = {}) {
  const root = await scratch(name);
  const store = createSessionStore({ root, waitMs: 500 });
  const host = fakeHost(options);
  const bridge = createDshHostBridge({ ctx: host.ctx, runtimeVersion: options.version ?? '0.2.0-rc.2', store, identity: 'dsh', ...QUICK, ...options.extra });
  return { root, store, host, bridge };
}
const DIGEST = 'a'.repeat(64);
/** Puts a letter into the ledger as the chat that owns it would have left it. */
const claimAs = (store, id, status, session) => store.update('dsh', state => {
  state.claims[id] = { letter: id, digest: DIGEST, version: 1, transfers: 0, attempts: 1, history: [], status,
    owner: { generation: state.binding.generation, session } };
});

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
  assert.deepEqual(host.definitions.map(entry => entry.name).sort(), ['localpost-bind', 'localpost-status', 'localpost-unbind']);
  assert.deepEqual(Object.values(COMMANDS).sort(), ['localpost-bind', 'localpost-status', 'localpost-unbind'], 'no fourth command (auto-arm is gone)');
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
  assert.match(repeat.text, /本来就是/);
  const two = await store.read('dsh');
  assert.equal(two.binding.source, one.binding.source, 'a repeat must not change source');
  assert.equal(two.binding.generation, one.binding.generation);
  assert.equal(two.binding.version, one.binding.version, 'a repeat must not move the CAS version');
  assert.deepEqual(two.binding.attestation, one.binding.attestation);
});

// 2026-10-09：用户在新聊天里说「把收信切到这里」（或敲 /localpost-bind）就该切过去 —— 以前这里只会报
// "T1 cannot move a binding between chats"，唯一的办法是手工挪走 runtime/sessions/dsh.json。
test('bind in another chat moves the mail there: a fresh, attested, automatic binding that remembers the one it replaced', async () => {
  const { bridge, host, store } = await bridgeFor('takeover');
  bridge.registerCommands();
  const bind = find(host.definitions, COMMANDS.bind);
  await bind.handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  await find(host.definitions, COMMANDS.unbind).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  const before = await store.read('dsh');

  const moved = await bind.handler({ agent: chatAgent('chat-B', 'C:/work/B') });
  assert.equal(moved.kind, 'success', moved.text);
  assert.match(moved.text, /chat-A/);
  const after = await store.read('dsh');
  assert.deepEqual(after.binding.session, { host: 'local', id: 'chat-B', cwd: 'C:/work/B' });
  assert.deepEqual([after.binding.mode, after.binding.state, after.binding.generation], ['auto', 'active', 1]);
  assert.ok(after.binding.version > before.binding.version, 'the CAS version keeps moving forward');
  assert.notEqual(after.binding.attestation.actionId, before.binding.attestation.actionId, 'B attests with its own action');
  assert.equal(after.binding.attestation.threadId, 'chat-B');
  assert.match(after.binding.source, /^chat-action:[0-9a-f-]{36}$/);
  assert.deepEqual(after.binding.replaced.map(entry => [entry.session.id, entry.attestation]), [['chat-A', before.binding.attestation.actionId]]);
  assert.equal(attestedNow(after), true, 'the new binding is attested by the chat action that made it');
  assert.equal(arrivalRoute(after).route.threadId, 'chat-B', 'new mail is routed to B');
});

test('mail that arrived under the replaced binding and was never delivered follows the move; a hand-made rebind captures nothing', async () => {
  const { root, bridge, host, store } = await bridgeFor('takeover-route');
  bridge.registerCommands();
  const bind = find(host.definitions, COMMANDS.bind);
  await bind.handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  const underA = arrivalRoute(await store.read('dsh')).route;
  const provider = createBindingProvider({ store, identity: 'dsh', host: bridge });
  assert.equal((await provider.resolve(underA)).target.threadId, 'chat-A');

  await bind.handler({ agent: chatAgent('chat-B', 'C:/work/B') });
  const followed = await provider.resolve(underA);
  assert.equal(followed.ok, true, JSON.stringify(followed));
  assert.deepEqual([followed.target.threadId, followed.target.cwd, followed.target.generation], ['chat-B', 'C:/work/B', 1]);
  assert.equal(await provider.verifyBinding(followed.target), true, 'B is online, attested and automatic: the letter goes there');

  // Removing the record by hand and binding afresh is not a takeover: it never captures mail that arrived before it.
  const underB = arrivalRoute(await store.read('dsh')).route;
  await fs.rm(path.join(root, 'runtime', 'sessions', 'dsh.json'));
  await bind.handler({ agent: chatAgent('chat-C', 'C:/work/C') });
  assert.deepEqual(await provider.resolve(underB), { ok: false, reason: 'binding_changed' });
});

test('letters the old chat has not finished stop the move until the user forces it; forced, they become the new chat\'s', async () => {
  const { bridge, host, store } = await bridgeFor('takeover-unfinished');
  bridge.registerCommands();
  const bind = find(host.definitions, COMMANDS.bind);
  await bind.handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  await claimAs(store, 'l-accepted', 'accepted', 'chat-A');
  await claimAs(store, 'l-uncertain', 'needs_reconcile', 'chat-A');
  await claimAs(store, 'l-done', 'done', 'chat-A');
  await claimAs(store, 'l-reserved', 'reserved', 'chat-A');
  const before = await store.read('dsh');

  const refused = await bind.handler({ agent: chatAgent('chat-B', 'C:/work/B') });
  assert.equal(refused.kind, 'error');
  assert.match(refused.text, /l-accepted/);
  assert.match(refused.text, /l-uncertain/);
  assert.doesNotMatch(refused.text, /l-done|l-reserved/, 'settled letters and reservations that never reached A do not block');
  assert.match(refused.text, /强制/, 'the refusal says how to go ahead');
  assert.deepEqual((await store.read('dsh')).binding, before.binding, 'a refused move changes nothing');

  const b = { host: 'local', session: 'chat-B', cwd: 'C:/work/B' };
  live.set('chat-B', chatAgent('chat-B', 'C:/work/B'));
  const forced = await bridge.bindHere(b, { force: true, via: 'request' });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.deepEqual(forced.moved.sort(), ['l-accepted', 'l-uncertain']);
  const after = await store.read('dsh');
  assert.equal(after.binding.session.id, 'chat-B');
  assert.equal(after.binding.authority.source, 'policy:user-request-in-chat', 'a request made in plain language is recorded as such');
  assert.deepEqual(Object.keys(after.claims).sort(), ['l-accepted', 'l-uncertain'], 'settled history and stray reservations are dropped');
  for (const id of ['l-accepted', 'l-uncertain']) {
    const claim = after.claims[id];
    assert.deepEqual([claim.status, claim.owner.session, claim.owner.generation, claim.taken_over_from.session], ['accepted', 'chat-B', 1, 'chat-A']);
  }
});

test('a move waits for a dispatch in flight instead of asking the human to try again', async () => {
  const { root, bridge, host, store } = await bridgeFor('takeover-busy', { extra: { busyRetries: 100, busyPauseMs: 10 } });
  bridge.registerCommands();
  await find(host.definitions, COMMANDS.bind).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  const lease = await acquireLease(root, { name: '.session-actor-dsh.lock' });
  const pending = find(host.definitions, COMMANDS.bind).handler({ agent: chatAgent('chat-B', 'C:/work/B') });
  await new Promise(resolve => setTimeout(resolve, 80));
  await lease.release();
  const moved = await pending;
  assert.equal(moved.kind, 'success', moved.text);
  assert.equal((await store.read('dsh')).binding.session.id, 'chat-B');
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

// 2026-10-09：停止自动收信可以在任何聊天里说（以前只认被绑的那个聊天，用户在别的聊天里怎么说都没用）。
// 它只把新信留在收件箱，绑定原地不动；不能被没证明身份的调用者触发。
test('unbind from any attested chat stops routing for new mail and leaves the binding where it is', async () => {
  const { bridge, host, store } = await bridgeFor('unbind');
  bridge.registerCommands();
  await find(host.definitions, COMMANDS.bind).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  const unproven = await find(host.definitions, COMMANDS.unbind).handler({ agent: { session: { id: 'chat-B', header: { cwd: 'C:/work/B' } } } });
  assert.equal(unproven.kind, 'error', 'an agent the live registry does not hand back changes nothing');
  assert.equal((await store.read('dsh')).binding.mode, 'auto');

  const fromB = await find(host.definitions, COMMANDS.unbind).handler({ agent: chatAgent('chat-B', 'C:/work/B') });
  assert.equal(fromB.kind, 'success', fromB.text);
  assert.match(fromB.text, /已停止/);
  const state = await store.read('dsh');
  assert.deepEqual([state.binding.mode, state.binding.state, state.binding.session.id], ['manual', 'active', 'chat-A']);
  assert.deepEqual(arrivalRoute(state), { route: null, reason: 'binding_manual' });

  const again = await find(host.definitions, COMMANDS.unbind).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  assert.equal(again.kind, 'success');
  assert.match(again.text, /本来就是关的/);
  assert.equal((await store.read('dsh')).binding.version, state.binding.version, 'an idempotent unbind does not move the CAS version');
});

test('unbind of an identity that was never bound says there is nothing to stop and writes nothing', async () => {
  const { bridge, host, store } = await bridgeFor('unbind-unbound');
  bridge.registerCommands();
  const out = await find(host.definitions, COMMANDS.unbind).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  assert.equal(out.kind, 'success');
  assert.match(out.text, /还没有收信聊天/);
  assert.equal(await store.read('dsh'), null);
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

// 2026-10-06 的死结（unbind 之后没有命令能回到 auto）当时靠 /localpost-auto-arm 解；现在 bind 本身就是回程：
// 在原聊天里再敲一次 /localpost-bind（或说「把收信切到这里」）只改 mode，不动 generation / session / attestation。
test('bind in the bound chat turns automatic routing back on without moving or rotating anything', async () => {
  const { bridge, host, store } = await bridgeFor('rearm');
  bridge.registerCommands();
  const a = chatAgent('chat-A', 'C:/work/A');
  await find(host.definitions, COMMANDS.bind).handler({ agent: a });
  const paused = await find(host.definitions, COMMANDS.unbind).handler({ agent: a });
  assert.ok(paused.text.includes('/' + COMMANDS.bind), 'the unbind names the way back: ' + paused.text);
  const before = await store.read('dsh');
  assert.equal(before.binding.mode, 'manual');

  const ok = await find(host.definitions, COMMANDS.bind).handler({ agent: a });
  assert.equal(ok.kind, 'success', ok.text);
  assert.match(ok.text, /已恢复/);
  const after = await store.read('dsh');
  assert.equal(after.binding.mode, 'auto');
  assert.equal(after.binding.generation, before.binding.generation, 're-arming must not rotate the generation');
  assert.deepEqual(after.binding.session, before.binding.session, 're-arming must not move the chat');
  assert.deepEqual(after.binding.attestation, before.binding.attestation, 're-arming must not re-attest');
  assert.equal(after.binding.replaced, undefined, 're-arming replaces nothing');
  assert.ok(after.binding.version > before.binding.version, 'the mode switch moves the CAS version');
  assert.notEqual(arrivalRoute(after).reason, 'binding_manual', 'new mail is routable again');
});

test('the host is told after every switch that lands, so the receiver can start at once', async () => {
  const changes = [];
  const { bridge, host } = await bridgeFor('on-change', { extra: { onChange: identity => changes.push(identity) } });
  bridge.registerCommands();
  const bind = find(host.definitions, COMMANDS.bind);
  await bind.handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  await find(host.definitions, COMMANDS.unbind).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  await bind.handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  await bind.handler({ agent: chatAgent('chat-B', 'C:/work/B') });
  assert.deepEqual(changes, ['dsh', 'dsh', 'dsh'], 'bound, re-armed, moved - and nothing for the unbind');
});

// A concurrent change between the unbind's read and its write - a rotation, or the record replaced at the very same version
// (ABA, codex R6) - must never be overwritten with the stale copy: the CAS refuses it, the unbind reads again and pauses
// the binding as it is NOW. Before 2026-10-09 such an unbind gave up, because only the bound chat could unbind.
test('a binding that moves under an unbind is read again: the pause lands on it as it is now, never on a stale copy', async () => {
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
  const bridge = createDshHostBridge({ ctx: host.ctx, runtimeVersion: '0.2.0-rc.2', store, identity: 'dsh', ...QUICK });
  bridge.registerCommands();
  const a = chatAgent('chat-A', 'C:/work/A');
  await find(host.definitions, COMMANDS.bind).handler({ agent: a });
  let moved;
  swap = async () => {
    await real.update('dsh', state => {
      Object.assign(state.binding, { session: { host: 'local', id: 'chat-B', cwd: 'C:/work/B' },
        generation: state.binding.generation + 1, version: state.binding.version + 2 });
    });
    moved = structuredClone((await real.read('dsh')).binding);
  };
  const answer = await find(host.definitions, COMMANDS.unbind).handler({ agent: a });
  assert.equal(answer.kind, 'success', answer.text);
  const { binding } = await real.read('dsh');
  assert.deepEqual([binding.session.id, binding.generation, binding.mode], ['chat-B', moved.generation, 'manual'], 'B was paused, not overwritten by A');
  assert.equal(binding.version, moved.version + 2, 'the switch started from B\'s version (freeze + complete)');
});

for (const [label, chat, cwd] of [['another chat', 'chat-B', 'C:/work/B'], ['the same chat bound afresh', 'chat-A', 'C:/work/A']]) {
  test(`after an equal-version replacement by ${label} (ABA) the unbind pauses the successor and keeps every field of it`, async () => {
    const root = await scratch('unbind-aba');
    const real = createSessionStore({ root, waitMs: 500 });
    let swap = null;
    const store = { ...real, read: async identity => {
      const snapshot = await real.read(identity);
      if (swap) { const run = swap; swap = null; await run(); }
      return snapshot;
    } };
    const host = fakeHost();
    const bridge = createDshHostBridge({ ctx: host.ctx, runtimeVersion: '0.2.0-rc.2', store, identity: 'dsh', ...QUICK });
    bridge.registerCommands();
    const a = chatAgent('chat-A', 'C:/work/A');
    await find(host.definitions, COMMANDS.bind).handler({ agent: a });
    const checked = (await real.read('dsh')).binding;
    let successor;
    swap = async () => {
      await fs.rm(path.join(root, 'runtime', 'sessions', 'dsh.json'));
      assert.equal((await find(host.definitions, COMMANDS.bind).handler({ agent: chatAgent(chat, cwd) })).kind, 'success');
      successor = structuredClone((await real.read('dsh')).binding);
    };
    const answer = await find(host.definitions, COMMANDS.unbind).handler({ agent: a });
    assert.equal(answer.kind, 'success', answer.text);
    assert.equal(successor.version, checked.version, 'a real ABA: the successor carries the version the unbind was checked against');
    const { binding } = await real.read('dsh');
    assert.deepEqual({ ...binding, mode: successor.mode, version: successor.version }, successor, 'only mode and version changed');
    assert.deepEqual([binding.mode, binding.version], ['manual', successor.version + 2]);
  });
}

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

test('status tells any proven chat who receives the mail, and tells an unproven caller nothing', async () => {
  const { bridge, host } = await bridgeFor('status');
  bridge.registerCommands();
  const status = find(host.definitions, COMMANDS.status);
  assert.equal((await status.handler({})).kind, 'error');
  assert.match((await status.handler({ agent: chatAgent('chat-A', 'C:/work/A') })).text, /dsh：还没有收信聊天/);
  await find(host.definitions, COMMANDS.bind).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  // A caller the host cannot prove learns nothing about the binding.
  const substituted = await status.handler({ agent: { session: { id: 'chat-A', header: { cwd: 'C:/work/A' } } } });
  assert.equal(substituted.kind, 'error', 'an agent the live registry does not hand back must not read the binding');
  assert.doesNotMatch(substituted.text, /chat-A/);
  const here = await status.handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  assert.equal(here.kind, 'success');
  assert.match(here.text, /收信聊天 = 这个聊天（chat-A）/);
  assert.match(here.text, /自动收信：开/);
  const elsewhere = await status.handler({ agent: chatAgent('chat-B', 'C:/work/B') });
  assert.match(elsewhere.text, /收信聊天 = 另一个聊天（chat-A，目录 C:\/work\/A）/);
  // Same chat id, another workspace: not the bound chat.
  assert.match((await status.handler({ agent: chatAgent('chat-A', 'C:/work/ELSEWHERE') })).text, /另一个聊天/);
  await find(host.definitions, COMMANDS.unbind).handler({ agent: chatAgent('chat-A', 'C:/work/A') });
  assert.match((await status.handler({ agent: chatAgent('chat-A', 'C:/work/A') })).text, /自动收信：关/);
});
