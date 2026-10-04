import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MAIL_TURN_DENY_PREFIX, SUPPORTED_VERSION, TOOL_NAMES, createMailTools, mailTurnReason } from './dsh-mail-tools.mjs';
import { bind, createSessionStore } from './session-binding.mjs';
import { createMailbox, envelopeDigest } from './mailbox.mjs';
import { dispatchLetter } from './letter-claims.mjs';
import { removeTree } from './temp-tree.mjs';
import { GATE, LOOKALIKES, REVIEW_NAMED, UNKNOWN } from './fixtures/mail-turn-gate.mjs';

/*
 * C1: the tool policy of an automatic mail turn is exactly the five LocalPost tools this bridge registered.
 * The negative table below is the gate; the legacy b-probe prefix policy fails it, the exact policy passes it,
 * and the five real tools still finish a letter behind it (positive control: "deny everything" is not a fix).
 */

const TMP = path.resolve(import.meta.dirname, '..', '.localpost-tmp', 'mail-turn-allowlist');
const created = [];
async function scratch(name) {
  const dir = path.join(TMP, name + '-' + Math.random().toString(16).slice(2, 8));
  await fs.mkdir(dir, { recursive: true });
  created.push(dir);
  return dir;
}
test.after(async () => { for (const dir of created) await removeTree(dir); await removeTree(TMP); });

const SESSION = Object.freeze({ host: 'local', id: 'chat-A', cwd: 'C:/work/A' });
const chatAgent = (id, cwd = SESSION.cwd) => ({ session: { id, header: { cwd } }, status: 'running' });
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };

/**
 * A tool registry with the installed host's dispatch order (dsh-tools of 0.2.0-rc.2, as extracted to
 * work/b-host-guard-evidence/host-tools.js): register keys a definition by its own name (:2878-2886) and a scoped
 * registration shadows the global one (get = view(scope).visible, :2959-2997); guards are asked in registration order
 * and the first string denies (:2921-2936); a denied call becomes an error result and is never dispatched
 * (:3241-3257); a let-through call resolves its definition AGAIN at dispatch and only then runs the body (:3307-3310).
 * A per-agent restriction takes an inherited name out of that agent's view (tools.restrict, :2895-2910, :2970-2973).
 * Every body run is counted here, at the point the host sets bodyInvoked, so "denied" is measured as "no body ran".
 */
function registryHost(agents = new Map()) {
  const global = new Map();
  const scoped = new Map();
  const restricted = new Map();
  const guards = [];
  const bodyRuns = [];
  let calls = 0;
  const layerFor = scope => {
    if (scope === undefined) return global;
    if (!scoped.has(scope)) scoped.set(scope, new Map());
    return scoped.get(scope);
  };
  const insert = (layer, definition) => {
    if (layer.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`);
    layer.set(definition.name, definition);
    return () => { if (layer.get(definition.name) === definition) layer.delete(definition.name); };
  };
  const tools = {
    register: definition => insert(global, definition),
    get: (name, scope) => {
      const own = scope === undefined ? undefined : scoped.get(scope);
      if (own?.has(name)) return own.get(name);
      return restricted.get(scope)?.has(name) ? undefined : global.get(name);
    },
    guard: check => { guards.push(check); return () => { const at = guards.indexOf(check); if (at >= 0) guards.splice(at, 1); }; },
  };
  async function execute(name, agent, args = {}) {
    calls += 1;
    const exec = { token: Symbol('exec'), callId: 'call-' + calls, rootCallId: 'call-' + calls, name, signal: new AbortController().signal,
      ...(agent === undefined ? {} : { agent }), arguments: Object.freeze({ ...args }) };
    let reason;
    for (const check of [...guards]) { reason = check(exec); if (reason !== undefined) break; }
    if (reason !== undefined) return { denied: true, isError: true, text: 'Error: ' + reason };
    const tool = tools.get(name, agent);
    if (tool === undefined) return { unknown: true, isError: true, text: 'UNKNOWN_TOOL ' + name };
    bodyRuns.push({ name, definition: tool });
    try { return { isError: false, value: await tool.execute(exec.arguments, exec) }; }
    catch (error) { return { isError: true, error, text: String(error?.message ?? error) }; }
  }
  return {
    ctx: { tools, agents: { get: id => agents.get(id) } },
    agents, guards, bodyRuns, execute,
    registerScoped: (agent, definition) => insert(layerFor(agent), definition),
    restrict: (agent, names) => restricted.set(agent, new Set(names)),
    runsOf: name => bodyRuns.filter(run => run.name === name).length,
  };
}

/** A definition another plugin could register under any name; its body records every run. */
function decoy(name, ran) {
  return {
    name, description: 'decoy ' + name, parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() { ran.push(name); return 'decoy body ran: ' + name; },
  };
}

/** A real mailbox bound to chat A, one letter from codex delivered, the five tools mounted behind the allowlist. */
async function mounted(name, { mode = 'manual', letter = 'l1' } = {}) {
  const root = await scratch(name);
  const store = createSessionStore({ root, waitMs: 2000 });
  await bind(store, 'dsh', {
    session: SESSION, mode, capacity: 50, authority: { scope: 'analysis-reply', source: 'policy:test' }, source: 'e2e',
    attestation: { actionId: 'a1', hostId: SESSION.host, threadId: SESSION.id, cwd: SESSION.cwd },
  });
  await createMailbox({ root, identity: 'codex' })
    .deliver({ id: letter, from: 'codex', to: 'dsh', type: 'task', subject: 'please handle', body: 'do the thing' });
  const mailbox = createMailbox({ root, identity: 'dsh' });
  const agent = chatAgent(SESSION.id);
  const host = registryHost(new Map([[SESSION.id, agent]]));
  const mail = createMailTools({ ctx: host.ctx, mailbox, store, identity: 'dsh', runtimeVersion: SUPPORTED_VERSION });
  const registered = mail.register();
  assert.equal(registered.ok, true, 'the five tools must register on a capable host');
  // What C2 scopes to the claimed automatic turn; here it simply stands for "this call is inside one".
  const disposeAllowlist = host.ctx.tools.guard(exec => mail.mailTurnReason(exec));
  return { root, store, mailbox, letter, host, mail, agent, registered, disposeAllowlist };
}

/*
 * The policy this replaces, verbatim: work/b-probe/probe-plugin/lib/policy.mjs:14 and :56
 * (sha256 708f7c2c419dc2ed0af4a074ec22b01bbd06eea54126b51e77edcf5a219ec2b0, 3220 bytes; that file is historical
 * evidence and is not modified). It admitted every name that merely starts with "localpost_".
 */
const LEGACY_ALLOWLIST_PATTERN = /^localpost_/;
const NAME_LAYER = /is not one of the five LocalPost mail tools/;
const legacyReason = exec => {
  const name = typeof exec?.name === 'string' ? exec.name : '';
  return name !== '' && LEGACY_ALLOWLIST_PATTERN.test(name) ? undefined : 'b-probe-default-deny: ' + name;
};

test('the gate never names one of the five, and the bridge registers exactly the five the allowlist admits', async () => {
  for (const name of GATE) assert.equal(TOOL_NAMES.includes(name), false, JSON.stringify(name) + ' must not be a real mail tool');
  assert.equal(new Set(GATE).size, GATE.length, 'the gate has no duplicate names');
  const { host, mail, agent } = await mounted('names');
  // The registry key is the definition's own name (host-tools.js:2878-2886), so this IS the host's registry for them.
  assert.deepEqual(TOOL_NAMES.filter(name => host.ctx.tools.get(name) !== undefined), [...TOOL_NAMES]);
  for (const name of TOOL_NAMES) assert.equal(mail.mailTurnReason({ name, agent }), undefined, name + ' is admitted');
});

test('positive control, manual binding: behind the allowlist the five tools read, reply terminally and archive', async () => {
  const { root, letter, host, agent } = await mounted('manual');
  const status = await host.execute('localpost_status', agent);
  assert.equal(status.isError, false, status.text);
  assert.match(status.value, /mode=manual/);
  assert.match((await host.execute('localpost_inbox', agent)).value, new RegExp(letter));
  const read = await host.execute('localpost_read', agent, { id: letter });
  assert.equal(read.isError, false, read.text);
  assert.match(read.value, /do the thing/);
  const reply = await host.execute('localpost_reply', agent, { id: letter, outcome: 'completed', body: 'handled' });
  assert.equal(reply.isError, false, reply.text);
  assert.equal(JSON.parse(reply.value).outcome, 'completed');
  const archive = await host.execute('localpost_archive', agent, { id: letter });
  assert.equal(archive.isError, false, archive.text);
  assert.equal(JSON.parse(archive.value).archived, letter);

  const published = (await fs.readdir(path.join(root, 'agents', 'codex', 'inbox'))).filter(file => file.endsWith('.json'));
  assert.equal(published.length, 1, 'exactly one result letter');
  const result = JSON.parse(await fs.readFile(path.join(root, 'agents', 'codex', 'inbox', published[0]), 'utf8'));
  assert.deepEqual([result.reply_to, result.outcome], [letter, 'completed']);
  assert.equal(await exists(path.join(root, 'agents', 'dsh', 'archive', letter + '.json')), true);
  assert.deepEqual(host.bodyRuns.map(run => run.name),
    ['localpost_status', 'localpost_inbox', 'localpost_read', 'localpost_reply', 'localpost_archive'], 'each real body ran once, nothing else ran');
});

test('positive control, automatic binding: letters the automatic consumer delivered are finished by their owner chat', async () => {
  const { root, store, letter, host, agent } = await mounted('auto', { mode: 'auto' });
  await createMailbox({ root, identity: 'codex' })
    .deliver({ id: 'l2', from: 'codex', to: 'dsh', type: 'ping', subject: 'fyi', body: 'nothing to answer' });
  // The real reserve -> dispatching -> settle path, with a host that accepted the relay: each claim is now owned by chat A.
  for (const id of [letter, 'l2']) {
    const envelope = JSON.parse(await fs.readFile(path.join(root, 'agents', 'dsh', 'inbox', id + '.json'), 'utf8'));
    const dispatched = await dispatchLetter(store, 'dsh', { id, digest: envelopeDigest(envelope) }, { submit: async () => ({ accepted: true }) });
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
    assert.equal(dispatched.claim.status, 'accepted');
  }

  // l1: read -> terminal reply, which archives the original.
  const read = await host.execute('localpost_read', agent, { id: letter });
  assert.equal(read.isError, false, read.text);
  assert.match(read.value, /do the thing/);
  const reply = await host.execute('localpost_reply', agent, { id: letter, outcome: 'completed', body: 'handled automatically' });
  assert.equal(reply.isError, false, reply.text);
  assert.deepEqual([JSON.parse(reply.value).outcome, JSON.parse(reply.value).archived], ['completed', letter]);
  assert.equal(await exists(path.join(root, 'agents', 'dsh', 'archive', letter + '.json')), true);
  // The allowlist only decides which bodies are reachable; their own rules still hold behind it: the reply's completion
  // intent is immutable, so an archive cannot replace it (mailbox.mjs R4).
  const late = await host.execute('localpost_archive', agent, { id: letter });
  assert.equal(late.isError, true);
  assert.equal(late.error?.code, 'COMPLETION_INTENT_CONFLICT', late.text);

  // l2: read -> archive.
  assert.equal((await host.execute('localpost_read', agent, { id: 'l2' })).isError, false);
  const archive = await host.execute('localpost_archive', agent, { id: 'l2' });
  assert.equal(archive.isError, false, archive.text);
  assert.equal(JSON.parse(archive.value).archived, 'l2');
  assert.equal(await exists(path.join(root, 'agents', 'dsh', 'archive', 'l2.json')), true);
  assert.equal(await exists(path.join(root, 'agents', 'dsh', 'inbox', 'l2.json')), false);
  assert.deepEqual(host.bodyRuns.map(run => run.name),
    ['localpost_read', 'localpost_reply', 'localpost_archive', 'localpost_read', 'localpost_archive']);
});

test('every name outside the five is denied by the allowlist before any body runs, registered or not', async () => {
  const { root, letter, host, agent } = await mounted('gate');
  const ran = [];
  for (const name of GATE) if (!UNKNOWN.includes(name)) host.ctx.tools.register(decoy(name, ran));
  for (const name of GATE) {
    const outcome = await host.execute(name, agent, { id: letter, command: 'Remove-Item -Recurse C:\\' });
    assert.equal(outcome.denied, true, JSON.stringify(name) + ' must be denied, got ' + JSON.stringify(outcome));
    assert.ok(outcome.text.startsWith('Error: ' + MAIL_TURN_DENY_PREFIX), JSON.stringify(name) + ' must be denied by the mail-turn allowlist: ' + outcome.text);
    // Denied by NAME, not merely because nothing of ours is registered under it.
    assert.match(outcome.text, NAME_LAYER, JSON.stringify(name) + ' must be denied at the name layer');
  }
  assert.deepEqual(ran, [], 'no decoy body may run');
  assert.deepEqual(host.bodyRuns, [], 'the host invoked no tool body at all');
  assert.equal(await exists(path.join(root, 'agents', 'dsh', 'inbox', letter + '.json')), true, 'the letter is untouched');
});

test('red/green: the legacy prefix policy fails the same gate, the exact allowlist passes it', async () => {
  const { host, mail, agent } = await mounted('red-green');
  const legacyAdmits = GATE.filter(name => legacyReason({ name, agent }) === undefined);
  const exactAdmits = GATE.filter(name => mail.mailTurnReason({ name, agent }) === undefined);
  // Red: everything that merely starts with "localpost_" got through, the four names of the review among them.
  assert.deepEqual(legacyAdmits, GATE.filter(name => name.startsWith('localpost_')));
  for (const name of REVIEW_NAMED) assert.ok(legacyAdmits.includes(name), name + ' is admitted by the legacy prefix');
  // Green: nothing in the gate gets through the exact allowlist.
  assert.deepEqual(exactAdmits, []);

  // The same contrast end to end, counted at the body: swap the allowlist for the legacy guard on a second host.
  const ranLegacy = [];
  const legacyHost = registryHost(host.agents);
  for (const name of LOOKALIKES) if (name !== '') legacyHost.ctx.tools.register(decoy(name, ranLegacy));
  legacyHost.ctx.tools.guard(legacyReason);
  for (const name of LOOKALIKES) await legacyHost.execute(name, agent);
  assert.ok(['localpost_check', 'localpost_shell', 'localpost_delete_all'].every(name => ranLegacy.includes(name)), 'red: under the prefix these bodies RAN');

  const ranExact = [];
  for (const name of LOOKALIKES) if (name !== '') host.ctx.tools.register(decoy(name, ranExact));
  for (const name of LOOKALIKES) await host.execute(name, agent);
  assert.deepEqual(ranExact, [], 'green: under the exact allowlist no body ran');
});

test('the name layer stands on its own: a lookalike is denied even where a registration would vouch for it', () => {
  // A bridge that registered MORE than the five (a future localpost_send, say) must not widen the allowlist: hand the
  // pure decision a registry and an identity map that vouch for every lookalike, and only the name check is left.
  const odd = [new String('localpost_read'), { toString: () => 'localpost_read' }, ['localpost_read']];
  const keys = [...LOOKALIKES.filter(name => name !== ''), ...odd];
  const vouched = new Map(keys.map(key => [key, { name: String(key) }]));
  const tools = { get: key => vouched.get(key) };
  const ours = new Map(keys.map(key => [key, new Set([vouched.get(key)])]));
  const agent = chatAgent(SESSION.id);
  for (const name of keys) {
    const reason = mailTurnReason(tools, ours, { name, agent });
    assert.ok(typeof reason === 'string', JSON.stringify(String(name)) + ' must be denied although the registry vouches for it');
    assert.match(reason, NAME_LAYER, JSON.stringify(String(name)) + ' must be denied by name');
  }
  // The same registry vouching for a real name admits it: the check above is the name layer, not a broken registry.
  const real = { name: 'localpost_read' };
  assert.equal(mailTurnReason({ get: () => real }, new Map([['localpost_read', new Set([real])]]), { name: 'localpost_read', agent }), undefined);
});

test('the five names prove nothing by themselves: a definition this bridge did not register is denied', async () => {
  const { host, mail, agent, registered } = await mounted('identity');
  const ran = [];
  // A scoped shadow of a real name, visible to chat A only (a scoped registration shadows the global one).
  host.registerScoped(agent, decoy('localpost_read', ran));
  assert.match(mail.mailTurnReason({ name: 'localpost_read', agent }), /did not register \(shadowed or replaced\)/);
  const other = chatAgent('chat-B', 'C:/work/B');
  assert.equal(mail.mailTurnReason({ name: 'localpost_read', agent: other }), undefined, 'a chat without the shadow still resolves ours');
  // Defence in depth: even with the bridge's own shadow guard gone, the allowlist alone denies the shadow end to end.
  host.guards.splice(0, 1);
  const shadowed = await host.execute('localpost_read', agent, { id: 'l1' });
  assert.equal(shadowed.denied, true);
  assert.ok(shadowed.text.startsWith('Error: ' + MAIL_TURN_DENY_PREFIX), shadowed.text);
  assert.deepEqual(ran, [], 'the shadow body never ran');

  // Registered, but restricted out of this caller's view: there is no definition of ours for it to reach.
  const restrictedChat = chatAgent('chat-R', 'C:/work/R');
  host.restrict(restrictedChat, ['localpost_reply']);
  assert.match(mail.mailTurnReason({ name: 'localpost_reply', agent: restrictedChat }), /is not visible to this caller/);
  assert.equal(mail.mailTurnReason({ name: 'localpost_read', agent: restrictedChat }), undefined, 'its other tools still resolve to ours');

  // After the bridge released its tools, a same-named registration by anyone else is not ours either.
  registered.dispose();
  for (const name of TOOL_NAMES) assert.match(mail.mailTurnReason({ name, agent: other }), /not registered by the LocalPost bridge/);
  host.ctx.tools.register(decoy('localpost_inbox', ran));
  const replaced = await host.execute('localpost_inbox', other);
  assert.equal(replaced.denied, true);
  assert.match(replaced.text, /not registered by the LocalPost bridge/);
  assert.deepEqual(ran, [], 'the replacement body never ran');
});

test('before registration and after release every call is denied; a fresh registration is admitted again', async () => {
  const root = await scratch('lifecycle');
  const store = createSessionStore({ root, waitMs: 2000 });
  const agent = chatAgent(SESSION.id);
  const host = registryHost(new Map([[SESSION.id, agent]]));
  const mail = createMailTools({ ctx: host.ctx, mailbox: createMailbox({ root, identity: 'dsh' }), store, identity: 'dsh', runtimeVersion: SUPPORTED_VERSION });
  for (const name of TOOL_NAMES) assert.match(mail.mailTurnReason({ name, agent }), /not registered by the LocalPost bridge/, 'before: ' + name);
  const first = mail.register();
  for (const name of TOOL_NAMES) assert.equal(mail.mailTurnReason({ name, agent }), undefined, 'registered: ' + name);
  first.dispose();
  for (const name of TOOL_NAMES) assert.match(mail.mailTurnReason({ name, agent }), /not registered by the LocalPost bridge/, 'released: ' + name);
  const second = mail.register();
  assert.equal(second.ok, true);
  for (const name of TOOL_NAMES) assert.equal(mail.mailTurnReason({ name, agent }), undefined, 're-registered: ' + name);
  first.dispose();                                          // a stale release never touches the successor
  for (const name of TOOL_NAMES) assert.equal(mail.mailTurnReason({ name, agent }), undefined, 'after stale release: ' + name);

  // An incapable host registers nothing, so its allowlist admits nothing.
  const incapable = createMailTools({ ctx: { agents: host.ctx.agents }, mailbox: createMailbox({ root, identity: 'dsh' }), store, identity: 'dsh',
    runtimeVersion: SUPPORTED_VERSION });
  assert.equal(incapable.register().ok, false);
  for (const name of TOOL_NAMES) assert.match(incapable.mailTurnReason({ name, agent }), new RegExp('^' + MAIL_TURN_DENY_PREFIX));
});

test('the decision is total and fail-closed: odd names, hostile executions and a failing lookup are denials, never throws', async () => {
  const { host, mail, agent } = await mounted('total');
  const deniedFor = exec => {
    let reason;
    assert.doesNotThrow(() => { reason = mail.mailTurnReason(exec); });
    return typeof reason === 'string' && reason.startsWith(MAIL_TURN_DENY_PREFIX);
  };
  for (const name of [undefined, null, 0, 123, true, Symbol('localpost_read'), ['localpost_read'], { toString: () => 'localpost_read' },
    new String('localpost_read')]) {
    assert.ok(deniedFor({ name, agent }), 'non-string name ' + String(typeof name) + ' must be denied');
    assert.match(mail.mailTurnReason({ name, agent }), NAME_LAYER, 'a non-string name is refused by name, never coerced');
  }
  assert.ok(deniedFor(undefined), 'no execution');
  assert.ok(deniedFor(null), 'null execution');
  assert.ok(deniedFor(Object.defineProperty({}, 'name', { get() { throw new Error('boom'); } })), 'throwing name accessor');
  assert.ok(deniedFor(Object.defineProperty({ name: 'localpost_read' }, 'agent', { get() { throw new Error('boom'); } })), 'throwing agent accessor');
  // The name is read once: an accessor that answers a real name first and something else later cannot split the decision.
  let reads = 0;
  const flipping = Object.defineProperty({ agent }, 'name', { get() { reads += 1; return reads === 1 ? 'localpost_read' : 'pwsh'; } });
  assert.equal(mail.mailTurnReason(flipping), undefined);
  assert.equal(reads, 1, 'exec.name is read exactly once');
  // A lookup that throws is a denial (the pure function with a registry that explodes).
  const ours = new Map([['localpost_read', new Set([host.ctx.tools.get('localpost_read')])]]);
  const exploding = { get() { throw new Error('lookup exploded'); } };
  assert.match(mailTurnReason(exploding, ours, { name: 'localpost_read', agent }), /could not be checked \(lookup exploded\)/);
  assert.match(mailTurnReason(undefined, ours, { name: 'localpost_read', agent }), /could not be checked/);
  // A reason never echoes a long name in full.
  const long = 'x'.repeat(5000);
  assert.ok(mail.mailTurnReason({ name: long, agent }).length < 400);
});
