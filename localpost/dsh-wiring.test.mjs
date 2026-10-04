import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as W from './dsh-wiring.mjs';
import { ISOLATED_ROOT, PRODUCTION_ROOT, WIRING_STATUS, createIsolatedWiring } from './dsh-wiring.mjs';
import { COMMANDS, SUPPORTED_VERSION } from './dsh-host-bridge.mjs';
import { TOOL_NAMES } from './dsh-mail-tools.mjs';
import { removeTreeSync } from './temp-tree.mjs';

const E = Object.freeze({ start: 'localpost-e-start', stop: 'localpost-e-stop', status: 'localpost-e-status' });
const EVIDENCE = 'precheck:app.asar package.json 0.2.0-rc.2';

// The canonical acceptance root must leave this file exactly as it came in (codex R3 P0-3): every enabled wiring below
// runs on its own temporary root with a fake receiver. The canonical root is only read, here and in the last test.
function treeSnapshot(root) {
  if (!fs.existsSync(root)) return 'absent';
  const entries = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) { entries.push(['dir', path.relative(root, full)]); walk(full); }
      else entries.push(['file', path.relative(root, full), stat.size, createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
    }
  })(root);
  return entries;
}
const canonicalBefore = treeSnapshot(ISOLATED_ROOT);

const TMP = path.resolve(import.meta.dirname, '../.localpost-tmp/dsh-wiring');
/** A unique isolated root per test, removed by that test only (never the shared TMP parent). */
function rootFor(t) {
  fs.mkdirSync(TMP, { recursive: true });
  const root = fs.mkdtempSync(path.join(TMP, 'case-'));
  t.after(() => removeTreeSync(root));
  return root;
}

/**
 * The host registries with the shapes and failure modes of the installed host: a name registered twice in one layer
 * throws, find(agent, name) resolves the effective definition for that agent (a scoped shadow wins), and the knobs
 * below inject a failing lookup or a failing registration.
 */
function fakeCtx() {
  const host = { commands: [], tools: [], guards: [], listeners: [], owners: new Map(), agents: new Map(), findThrows: null, failRegister: null, shadow: null };
  const register = (list, kind) => definition => {
    if (list.some(entry => entry.name === definition.name)) throw new Error(`${kind} "${definition.name}" is already registered`);
    if (host.failRegister === definition.name) throw new Error('registry refused ' + definition.name);
    list.push(definition);
    return () => { const at = list.indexOf(definition); if (at >= 0) list.splice(at, 1); };
  };
  host.ctx = {
    agents: { get: id => host.agents.get(id), isOwnedBy: (id, owner) => host.owners.get(id) === owner },
    // Plain-context listeners (the child barrier listens to agent/created); each returns its exact disposer.
    on: (name, listener) => {
      const entry = { name, listener };
      host.listeners.push(entry);
      return () => { const at = host.listeners.indexOf(entry); if (at >= 0) host.listeners.splice(at, 1); };
    },
    commands: {
      register: register(host.commands, 'command'),
      find: (agent, name) => {
        if (host.findThrows === name) throw new Error('lookup exploded');
        if (host.shadow && agent === host.shadow.agent && name === host.shadow.name) return host.shadow.definition;
        return host.commands.find(entry => entry.name === name);
      },
    },
    tools: {
      register: register(host.tools, 'tool'),
      get: name => host.tools.find(entry => entry.name === name),
      guard: check => { host.guards.push(check); return () => { const at = host.guards.indexOf(check); if (at >= 0) host.guards.splice(at, 1); }; },
    },
  };
  return host;
}
const counts = host => [host.commands.length, host.tools.length, host.guards.length];

/** A receiver that touches nothing and counts what the wiring asks of it. */
function fakeReceiver({ startFails = false, stopFails = false } = {}) {
  const seen = { construct: 0, start: 0, stop: 0, watchers: 0, options: null };
  const factory = options => {
    seen.construct += 1;
    seen.options = options;
    let watching = false;
    return {
      async start() { seen.start += 1; if (!watching) { watching = true; seen.watchers += 1; } if (startFails) throw new Error('scan failed'); },
      async stop() { seen.stop += 1; if (watching) { watching = false; seen.watchers -= 1; } if (stopFails) throw new Error('stop failed'); },
      diagnostics: () => ({ running: watching, dispatchEnabled: false, lastError: undefined }),
    };
  };
  return { factory, seen };
}

/** An enabled wiring on its own temporary isolated root with a fake receiver. */
function build(t, host, { config = {}, receiver = fakeReceiver(), runtimeVersion = SUPPORTED_VERSION, versionEvidence = EVIDENCE, root, drainTimeoutMs } = {}) {
  const isolatedRoot = root ?? rootFor(t);
  const wiring = createIsolatedWiring({
    ctx: host.ctx, runtimeVersion, versionEvidence, isolatedRoot, receiverFactory: receiver.factory,
    ...(drainTimeoutMs === undefined ? {} : { drainTimeoutMs }),
    config: { enabled: true, root: isolatedRoot, allowFrom: ['codex'], scanIntervalMs: 60000, debounceMs: 60, ...config },
  });
  return { wiring, receiver, root: isolatedRoot };
}

/** A chat agent with its own scope (tools.guard / on), a session, an inbox and cancel / whenIdle, recording what is asked of it. */
function scopedAgent(id, order = []) {
  const listeners = [];
  const guards = [];
  const queue = [];
  const fire = (name, ...args) => { for (const entry of [...listeners]) if (entry.name === name) entry.listener(...args); };
  const agent = {
    id, session: { id, header: { cwd: 'C:/work/' + id } }, guards, listeners, queue, fire,
    ctx: {
      tools: { guard: check => { guards.push(check); return () => { const at = guards.indexOf(check); if (at >= 0) guards.splice(at, 1); }; } },
      on: (name, listener) => { const entry = { name, listener }; listeners.push(entry); return () => { const at = listeners.indexOf(entry); if (at >= 0) listeners.splice(at, 1); }; },
    },
    inbox: {
      get nextTurn() { return queue.map(messageId => ({ id: messageId })); }, nextStep: [],
      remove(messageId) { const at = queue.indexOf(messageId); if (at < 0) return false; queue.splice(at, 1); fire('agent/inbox/discarded', { message: { id: messageId }, agent }); return true; },
    },
    cancel(cause, options) { order.push('cancel:' + cause.kind + (options?.keepInbox ? ':keepInbox' : '')); },
    async whenIdle() {},
  };
  return agent;
}
const chat = (host, id, cwd) => { const agent = { session: { id, header: { cwd } } }; host.agents.set(id, agent); return agent; };
const run = (host, name, agent) => host.commands.find(entry => entry.name === name).handler({ agent });

/* ------------------------------------------------------------------ gates before anything is built */

test('without an explicit switch nothing is registered at all: the default is production-safe', () => {
  const host = fakeCtx();
  const bare = createIsolatedWiring({ ctx: host.ctx, runtimeVersion: SUPPORTED_VERSION, versionEvidence: EVIDENCE });
  assert.deepEqual([bare.enabled, bare.reason], [false, 'disabled_by_default']);
  bare.dispose();
  for (const config of [{}, { enabled: false }, { enabled: false, root: ISOLATED_ROOT }]) {
    const wiring = createIsolatedWiring({ ctx: host.ctx, config, runtimeVersion: SUPPORTED_VERSION, versionEvidence: EVIDENCE });
    assert.deepEqual([wiring.enabled, wiring.reason, wiring.status], [false, 'disabled_by_default', WIRING_STATUS]);
    assert.deepEqual(counts(host), [0, 0, 0]);
    wiring.dispose();
  }
});

test('the production mailbox root is refused, including anything under it, and so is any root but the isolated one', () => {
  const host = fakeCtx();
  const receiver = fakeReceiver();
  const attempt = root => createIsolatedWiring({ ctx: host.ctx, runtimeVersion: SUPPORTED_VERSION, versionEvidence: EVIDENCE,
    receiverFactory: receiver.factory, config: { enabled: true, root, allowFrom: ['codex'] } });
  for (const root of [PRODUCTION_ROOT, PRODUCTION_ROOT.toLowerCase(), PRODUCTION_ROOT + '/agents/dsh/inbox'])
    assert.deepEqual([attempt(root).enabled, attempt(root).reason], [false, 'production_root_refused'], root);
  for (const [root, reason] of [['C:/AI_ASSIST/work/localpost-e-test-other', 'root_not_isolated'], ['C:/AI_ASSIST/work', 'root_not_isolated'],
    ['C:/AI_ASSIST/.mailbox-e', 'root_not_isolated'], ['', 'root_invalid'], ['relative/root', 'root_not_isolated']])
    assert.deepEqual([attempt(root).enabled, attempt(root).reason], [false, reason], root);
  assert.deepEqual(counts(host), [0, 0, 0]);
  assert.equal(receiver.seen.construct, 0, 'a refused root never builds a receiver');
});

test('the runtime version, the recorded pre-check and the host capabilities all gate the wiring', t => {
  assert.equal(build(t, fakeCtx(), { runtimeVersion: '0.1.5-rc.1' }).wiring.reason, 'runtime_version_mismatch');
  for (const evidence of [null, '', '   ']) assert.equal(build(t, fakeCtx(), { versionEvidence: evidence }).wiring.reason, 'version_evidence_missing');
  const noGuard = fakeCtx();
  delete noGuard.ctx.tools.guard;
  assert.equal(build(t, noGuard).wiring.enabled, false);
  assert.deepEqual(counts(noGuard), [0, 0, 0], 'a refused wiring leaves every registry untouched');
  const noAgents = fakeCtx();
  delete noAgents.ctx.agents;
  assert.equal(build(t, noAgents).wiring.enabled, false);
  assert.deepEqual(counts(noAgents), [0, 0, 0]);
  const noFind = fakeCtx();
  delete noFind.ctx.commands.find;
  assert.equal(build(t, noFind).wiring.reason, 'e_lookup_unavailable', 'without commands.find the E commands cannot be guarded');
  assert.deepEqual(counts(noFind), [0, 0, 0]);
});

test('allowFrom: every entry must be a safe identifier, checked before anything is registered; nothing is silently dropped', t => {
  for (const [allowFrom, reason] of [
    [undefined, 'allow_from_required'], [[], 'allow_from_required'],
    [['codex', ''], 'allow_from_invalid'], [['', '  '], 'allow_from_invalid'], [[' codex'], 'allow_from_invalid'],
    [['codex', '../dsh'], 'allow_from_invalid'], [['codex', 1], 'allow_from_invalid'], ['codex', 'allow_from_invalid'],
  ]) {
    const host = fakeCtx();
    const { wiring, receiver } = build(t, host, { config: { allowFrom } });
    assert.deepEqual([wiring.enabled, wiring.reason], [false, reason], JSON.stringify(allowFrom));
    assert.deepEqual(counts(host), [0, 0, 0]);
    assert.equal(receiver.seen.construct, 0);
  }
  const host = fakeCtx();
  const { wiring, receiver } = build(t, host, { config: { allowFrom: ['codex', 'dsh'] } });
  assert.equal(wiring.enabled, true);
  assert.deepEqual(receiver.seen.options.allowFrom, ['codex', 'dsh']);
  wiring.dispose();
});

test('the environment list is parsed strictly: blank or padded entries reach validation instead of being dropped', () => {
  assert.equal(typeof W.allowFromConfig, 'function', 'the parser lib/index.js uses is exported for testing');
  assert.deepEqual(W.allowFromConfig(undefined), []);
  assert.deepEqual(W.allowFromConfig(''), []);
  assert.deepEqual(W.allowFromConfig('codex,dsh'), ['codex', 'dsh']);
  assert.deepEqual(W.allowFromConfig('codex,,dsh'), ['codex', '', 'dsh']);
  assert.deepEqual(W.allowFromConfig('codex, dsh'), ['codex', ' dsh']);
});

test('scan interval and debounce bounds fail closed on both sides', t => {
  for (const [extra, reason] of [
    [{ scanIntervalMs: 999 }, 'scan_interval_invalid'], [{ scanIntervalMs: 3600001 }, 'scan_interval_invalid'],
    [{ scanIntervalMs: Number.NaN }, 'scan_interval_invalid'], [{ scanIntervalMs: '30000' }, 'scan_interval_invalid'], [{ scanIntervalMs: 1500.5 }, 'scan_interval_invalid'],
    [{ debounceMs: 49 }, 'debounce_invalid'], [{ debounceMs: 600001 }, 'debounce_invalid'], [{ debounceMs: Number.NaN }, 'debounce_invalid'],
  ]) {
    const host = fakeCtx();
    const { wiring } = build(t, host, { config: extra });
    assert.deepEqual([wiring.enabled, wiring.reason], [false, reason], JSON.stringify(extra));
    assert.deepEqual(counts(host), [0, 0, 0]);
  }
  for (const extra of [{ scanIntervalMs: 1000, debounceMs: 50 }, { scanIntervalMs: 3600000, debounceMs: 600000 }]) {
    const { wiring } = build(t, fakeCtx(), { config: extra });
    assert.equal(wiring.enabled, true, JSON.stringify(extra));
    wiring.dispose();
  }
});

test('a malformed config object cannot enable the wiring', () => {
  const host = fakeCtx();
  for (const config of [null, 'yes', 42, [], { enabled: 'true', root: ISOLATED_ROOT }, { enabled: 1, root: ISOLATED_ROOT }]) {
    const wiring = createIsolatedWiring({ ctx: host.ctx, config, runtimeVersion: SUPPORTED_VERSION, versionEvidence: EVIDENCE });
    assert.equal(wiring.enabled, false, JSON.stringify(config) + ' must not enable anything');
  }
  assert.deepEqual(counts(host), [0, 0, 0]);
});

/* ------------------------------------------------------------------ registration is one transaction */

test('an enabled wiring registers the base commands, the E commands, the tools and the guard, all argument-free', t => {
  const host = fakeCtx();
  const { wiring, receiver } = build(t, host);
  assert.deepEqual([wiring.enabled, wiring.status], [true, WIRING_STATUS]);
  const names = host.commands.map(entry => entry.name).sort();
  assert.deepEqual(names, [COMMANDS.bind, COMMANDS.status, COMMANDS.unbind, E.start, E.stop, E.status].sort());
  for (const definition of host.commands) assert.deepEqual([definition.input, definition.recordInput], [undefined, false], definition.name);
  assert.deepEqual(host.tools.map(entry => entry.name).sort(), [...TOOL_NAMES].sort());
  assert.equal(host.tools.some(entry => /start|dispatch|enable/.test(entry.name)), false, 'no model-callable tool may start dispatch');
  assert.equal(host.guards.length, 1);
  assert.equal(receiver.seen.construct, 1, 'the receiver is built once, before any registration');
  assert.deepEqual([receiver.seen.start, wiring.parts.receiver.status().running], [0, false], 'loading starts nothing');
  wiring.dispose();
});

test('an E command name already taken registers nothing at all, and a retry succeeds once it is free', async t => {
  const host = fakeCtx();
  const squatter = { name: E.stop, description: 'someone else', handler: async () => ({ kind: 'success', text: 'other' }) };
  const release = host.ctx.commands.register(squatter);
  const { wiring } = build(t, host);
  assert.deepEqual([wiring.enabled, wiring.reason], [false, 'e_command_name_taken']);
  assert.deepEqual(counts(host), [1, 0, 0], 'only the pre-existing command remains');
  release();
  const retry = build(t, host).wiring;
  assert.equal(retry.enabled, true);
  await retry.dispose();
  assert.deepEqual(counts(host), [0, 0, 0]);
});

test('a lookup that throws for an E name fails closed before anything is registered', t => {
  const host = fakeCtx();
  host.findThrows = E.status;
  const { wiring } = build(t, host);
  assert.deepEqual([wiring.enabled, wiring.reason], [false, 'e_lookup_failed']);
  assert.deepEqual(counts(host), [0, 0, 0]);
  host.findThrows = null;
  const retry = build(t, host).wiring;
  assert.equal(retry.enabled, true);
  retry.dispose();
});

for (const name of [E.start, E.stop, E.status]) {
  test(`registration failing at ${name} rolls back every earlier registration, and a retry succeeds`, async t => {
    const host = fakeCtx();
    host.failRegister = name;
    const { wiring } = build(t, host);
    assert.deepEqual([wiring.enabled, wiring.reason], [false, 'registration_failed']);
    assert.deepEqual(counts(host), [0, 0, 0], 'E commands, tools, base commands and guard were all released');
    assert.deepEqual(host.listeners, [], 'and so was the child barrier');
    host.failRegister = null;
    const retry = build(t, host).wiring;
    assert.equal(retry.enabled, true);
    await retry.dispose();
    assert.deepEqual(counts(host), [0, 0, 0]);
  });
}

test('a second wiring on the same host is refused and leaves the first one complete', t => {
  const host = fakeCtx();
  const first = build(t, host).wiring;
  const before = counts(host);
  const second = build(t, host).wiring;
  assert.equal(second.enabled, false);
  assert.deepEqual(counts(host), before, 'the refused wiring did not disturb the first');
  first.dispose();
});

test('a stale dispose cannot release its successor', async t => {
  const host = fakeCtx();
  const first = build(t, host).wiring;
  await first.dispose();
  const second = build(t, host);
  assert.equal(second.wiring.enabled, true);
  const full = counts(host);
  await first.dispose();
  assert.deepEqual(counts(host), full, 'the successor keeps every registration');
  const a = chat(host, 'chat-A', 'C:/work/A');
  assert.equal((await run(host, COMMANDS.bind, a)).kind, 'success');
  assert.equal((await run(host, E.status, a)).kind, 'success', 'and its E commands still work');
  await second.wiring.dispose();
  assert.deepEqual(counts(host), [0, 0, 0]);
});

/* ------------------------------------------------------------------ the E commands, invoked for real */

/** A wiring with chat A bound (attested, automatic) and chat B attested but not bound. */
async function boundWorld(t, receiver = fakeReceiver()) {
  const host = fakeCtx();
  const { wiring } = build(t, host, { receiver });
  const a = chat(host, 'chat-A', 'C:/work/A');
  const b = chat(host, 'chat-B', 'C:/work/B');
  assert.equal((await run(host, COMMANDS.bind, a)).kind, 'success');
  return { host, wiring, receiver, a, b, store: wiring.parts.store };
}

test('the bound chat starts, inspects and stops the one receiver; other chats and unproven callers are refused', async t => {
  const { host, wiring, receiver, a, b } = await boundWorld(t);
  for (const name of [E.start, E.stop, E.status]) {
    assert.equal((await run(host, name, b)).kind, 'error', name + ' from an unbound chat');
    assert.equal((await host.commands.find(entry => entry.name === name).handler({})).kind, 'error', name + ' without a caller');
  }
  assert.deepEqual([receiver.seen.start, receiver.seen.stop], [0, 0], 'refused calls touched nothing');
  assert.equal((await run(host, E.start, a)).kind, 'success');
  assert.match((await run(host, E.status, a)).text, /"running":true/);
  assert.equal((await run(host, E.stop, a)).kind, 'success');
  assert.deepEqual([receiver.seen.start, receiver.seen.stop, receiver.seen.watchers], [1, 1, 0]);
  await wiring.dispose();
});

test('a shadowed E command refuses and leaves the receiver alone', async t => {
  const { host, wiring, receiver, a } = await boundWorld(t);
  host.shadow = { agent: a, name: E.start, definition: { name: E.start, description: 'scoped shadow', handler: async () => ({ kind: 'success', text: 'shadow' }) } };
  const answer = await run(host, E.start, a);
  assert.equal(answer.kind, 'error');
  assert.match(answer.text, /shadow/);
  assert.equal(receiver.seen.start, 0, 'no receiver was started');
  host.shadow = null;
  await wiring.dispose();
});

test('start needs an active automatic binding; stop and status stay available to the bound chat and to the chat that started it', async t => {
  const { host, wiring, receiver, a, b, store } = await boundWorld(t);
  assert.equal((await run(host, COMMANDS.unbind, a)).kind, 'success', 'binding switched to manual');
  assert.equal((await run(host, E.start, a)).kind, 'error', 'no start under a manual binding');
  assert.equal(receiver.seen.start, 0);
  assert.equal((await run(host, E.status, a)).kind, 'success', 'the bound chat may still inspect');
  await store.update('dsh', state => { state.binding.mode = 'auto'; state.binding.version += 1; });
  assert.equal((await run(host, E.start, a)).kind, 'success');
  // The binding record disappears while running (an operator removed it): the chat that started it can still stop it.
  fs.rmSync(path.join(wiring.parts.root, 'runtime', 'sessions', 'dsh.json'));
  assert.equal((await run(host, E.stop, b)).kind, 'error', 'a chat that neither is bound nor started it cannot stop it');
  assert.equal((await run(host, E.status, a)).kind, 'success');
  assert.equal((await run(host, E.stop, a)).kind, 'success');
  assert.equal(receiver.seen.watchers, 0);
  await wiring.dispose();
});

/* ------------------------------------------------------------------ receiver lifecycle and error paths */

test('repeated and concurrent starts build one receiver and start it once', async t => {
  const { host, wiring, receiver, a } = await boundWorld(t);
  await Promise.all([run(host, E.start, a), run(host, E.start, a), wiring.parts.receiver.start()]);
  await run(host, E.start, a);
  assert.deepEqual([receiver.seen.construct, receiver.seen.start, receiver.seen.watchers], [1, 1, 1]);
  await wiring.dispose();
});

test('dispose while running stops the receiver, then releases every registration; a second dispose is a no-op', async t => {
  const { host, wiring, receiver, a } = await boundWorld(t);
  await run(host, E.start, a);
  await wiring.dispose();
  assert.deepEqual([receiver.seen.stop, receiver.seen.watchers], [1, 0]);
  assert.deepEqual(counts(host), [0, 0, 0]);
  assert.deepEqual([wiring.parts.receiver.status().running, wiring.parts.receiver.status().disposed], [false, true]);
  await wiring.dispose();
  assert.equal(receiver.seen.stop, 1);
  assert.equal((await wiring.parts.receiver.start()).running, false, 'nothing starts after dispose');
});

test('a stop that throws during dispose still releases every registration and keeps the error for diagnosis', async t => {
  const { host, wiring, a } = await boundWorld(t, fakeReceiver({ stopFails: true }));
  await run(host, E.start, a);
  await wiring.dispose();
  assert.deepEqual(counts(host), [0, 0, 0], 'no half-unloaded wiring');
  assert.match(String(wiring.parts.receiver.status().shutdownError), /stop failed/);
});

test('a start that fails is not reported running, cleans up after itself, and leaves stop and dispose safe', async t => {
  const { host, wiring, receiver, a } = await boundWorld(t, fakeReceiver({ startFails: true }));
  const answer = await run(host, E.start, a);
  assert.equal(answer.kind, 'error');
  assert.equal(wiring.parts.receiver.status().running, false);
  assert.equal(receiver.seen.watchers, 0, 'the half-started watcher was closed');
  assert.match(String(wiring.parts.receiver.status().lastStartError), /scan failed/);
  assert.equal((await run(host, E.stop, a)).kind, 'success');
  await wiring.dispose();
  assert.deepEqual(counts(host), [0, 0, 0]);
});

test('a failing receiver stop is reported to the caller and kept in status; the receiver decides whether it still runs', async t => {
  const { host, wiring, receiver, a } = await boundWorld(t, fakeReceiver({ stopFails: true }));
  assert.equal((await run(host, E.start, a)).kind, 'success');
  const answer = await run(host, E.stop, a);
  assert.equal(answer.kind, 'error');
  assert.match(answer.text, /stop failed/);
  const status = wiring.parts.receiver.status();
  assert.deepEqual([status.running, status.lastStopError], [false, 'stop failed'], 'the receiver stopped despite the error, and the error is kept');
  assert.equal(receiver.seen.watchers, 0);
  await wiring.dispose();
  assert.deepEqual(counts(host), [0, 0, 0]);
});

test('when a failed start cannot be cleaned up either, both failures are reported and kept', async t => {
  const { host, wiring, a } = await boundWorld(t, fakeReceiver({ startFails: true, stopFails: true }));
  const answer = await run(host, E.start, a);
  assert.equal(answer.kind, 'error');
  assert.match(answer.text, /scan failed/);
  assert.match(answer.text, /stop failed/, 'the cleanup failure is not dropped');
  const status = wiring.parts.receiver.status();
  assert.deepEqual([status.running, status.lastStartError, status.lastStopError], [false, 'scan failed', 'stop failed']);
  await wiring.dispose();
  assert.deepEqual(counts(host), [0, 0, 0]);
});

test('the receiver is built on the validated isolated root with the validated inputs', t => {
  const host = fakeCtx();
  const { wiring, receiver, root } = build(t, host, { config: { allowFrom: ['codex'], scanIntervalMs: 1000, debounceMs: 50 } });
  const { options } = receiver.seen;
  assert.equal(path.resolve(options.root).toLowerCase(), path.resolve(root).toLowerCase());
  assert.deepEqual([options.agent, options.allowFrom, options.scanIntervalMs, options.debounceMs], ['dsh', ['codex'], 1000, 50]);
  assert.equal(typeof options.adapter?.submit, 'function');
  wiring.dispose();
});

test('the wired adapter reports its own capabilities instead of claiming they are verified', t => {
  const { wiring } = build(t, fakeCtx());
  assert.equal(wiring.parts.diagnostics().runtimeVersion, SUPPORTED_VERSION);
  assert.equal(typeof wiring.parts.diagnostics().dispatchEnabled, 'boolean');
  const capabilities = wiring.parts.capabilities;
  assert.deepEqual([capabilities.runtimeVersion, capabilities.toolRegistry, capabilities.toolLookup, capabilities.toolGuard, capabilities.liveAgentLookup],
    [true, true, true, true, true]);
  wiring.dispose();
});

/* ------------------------------------------------------------------ the mail-turn guard in the wiring (C2) */

test('without agent creation events or ownership the mail-turn guard cannot be complete, so nothing is wired', t => {
  for (const [label, strip] of [['no ctx.on', host => { delete host.ctx.on; }], ['no agents.isOwnedBy', host => { delete host.ctx.agents.isOwnedBy; }]]) {
    const host = fakeCtx();
    strip(host);
    const { wiring, receiver } = build(t, host);
    assert.deepEqual([wiring.enabled, wiring.reason], [false, 'mail_turn_barrier_unavailable'], label);
    assert.deepEqual(counts(host), [0, 0, 0], label);
    assert.deepEqual(host.listeners, [], label);
    assert.equal(receiver.seen.construct, 0, label + ': nothing was built');
  }
});

test('an enabled wiring dispatches only through the mail-turn guard and listens for agent creation', async t => {
  const host = fakeCtx();
  const { wiring } = build(t, host);
  assert.equal(wiring.parts.capabilities.adapter.mailTurnGuard, true);
  assert.ok(wiring.decisions.includes('child_barrier_registered'));
  assert.deepEqual(host.listeners.map(entry => entry.name), ['agent/created']);
  assert.deepEqual(wiring.parts.receiver.status().mailTurnGuard, { draining: false, armaments: [] });
  await wiring.dispose();
  assert.deepEqual(host.listeners, [], 'the barrier goes with the wiring');
});

test('the child barrier refuses a child of a chat inside a mail turn, and only then', async t => {
  const host = fakeCtx();
  const { wiring } = build(t, host);
  const guard = wiring.parts.mailTurnGuard;
  const barrier = host.listeners.find(entry => entry.name === 'agent/created').listener;
  const a = scopedAgent('chat-A');
  host.owners.set('child-1', a);
  guard.arm(a, 'm1');
  assert.doesNotThrow(() => barrier({ agent: { id: 'child-1' } }), 'armed but not claimed: not a mail turn yet');
  a.fire('agent/inbox/claimed', { message: { id: 'm1' }, turn: 3, agent: a });
  assert.throws(() => barrier({ agent: { id: 'child-1' }, source: 'fresh' }), { code: 'mail_turn_child_refused' });
  assert.doesNotThrow(() => barrier({ agent: { id: 'someone-else' } }), 'a child of another chat');
  a.fire('session/event', a.session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });
  assert.doesNotThrow(() => barrier({ agent: { id: 'child-1' } }), 'the mail turn has ended');
  await wiring.dispose();
});

test('unload: stop the receiver, then drain - a running mail turn is cancelled and stays guarded until its own end', async t => {
  const host = fakeCtx();
  const order = [];
  const counted = fakeReceiver();
  const receiver = { seen: counted.seen, factory: options => {
    const built = counted.factory(options);
    const stop = built.stop;
    built.stop = async () => { order.push('receiver.stop'); return stop(); };
    return built;
  } };
  const { wiring } = build(t, host, { receiver, drainTimeoutMs: 30 });
  await wiring.parts.receiver.start();
  const guard = wiring.parts.mailTurnGuard;
  const a = scopedAgent('chat-A', order);
  guard.arm(a, 'm-running');
  a.fire('agent/inbox/claimed', { message: { id: 'm-running' }, turn: 7, agent: a });
  guard.arm(a, 'm-queued');
  a.queue.push('m-queued');
  await wiring.dispose();
  assert.deepEqual(order, ['receiver.stop', 'cancel:hook:keepInbox'], 'first no new relay, then the running turn is cancelled, the user\'s input kept');
  const status = wiring.parts.receiver.status();
  assert.deepEqual(status.lastDrain.released.map(item => [item.messageId, item.releasedBy]), [['m-queued', 'discarded-before-claim']]);
  assert.deepEqual(status.lastDrain.held.map(item => [item.messageId, item.turn]), [['m-running', 7]]);
  assert.match(String(status.shutdownError), /mail turns still guarded after unload: m-running@turn 7/);
  assert.deepEqual(counts(host), [0, 0, 0], 'every plugin registration is released regardless');
  assert.deepEqual(host.listeners, []);
  assert.equal(a.guards.length, 1, 'but the chat keeps its guard: the turn has not ended');
  assert.throws(() => guard.arm(a, 'late'), { code: 'guard_unavailable' }, 'and nothing new is armed');
  // Its own turn/end - nothing else - releases it, plugin gone or not.
  a.fire('session/event', a.session, { type: 'turn/end', data: { turn: 7, reason: { kind: 'aborted' } } });
  assert.equal(a.guards.length, 0);
  assert.deepEqual(wiring.parts.receiver.status().mailTurnGuard.armaments, []);
});

/* ------------------------------------------------------------------ last: the canonical root is untouched */

test('the canonical E acceptance root is byte-for-byte what it was before these tests ran', () => {
  assert.deepEqual(treeSnapshot(ISOLATED_ROOT), canonicalBefore);
});
