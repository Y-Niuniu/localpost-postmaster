import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SUPPORTED_VERSION, createMailTools } from './dsh-mail-tools.mjs';
import { CHILD_REFUSED, GUARD_UNAVAILABLE, createMailTurnGuard } from './mail-turn-guard.mjs';
import { bind, createSessionStore } from './session-binding.mjs';
import { createMailbox, envelopeDigest } from './mailbox.mjs';
import { dispatchLetter } from './letter-claims.mjs';
import { removeTree } from './temp-tree.mjs';
import { createTurnHost, gate, recordingTool } from './fixtures/turn-host.mjs';

/*
 * C2: the mail-turn guard over real turn semantics (fixtures/turn-host.mjs models the host from its source, line by line).
 * Every case counts tool bodies at the dispatch boundary: "denied" means no body ran, and "released" is checked against
 * the causal chain message.id -> claimed turn -> that turn's turn/end.
 */

const TMP = path.resolve(import.meta.dirname, '..', '.localpost-tmp', 'mail-turn-guard');
const created = [];
async function scratch(name) {
  const dir = path.join(TMP, name + '-' + Math.random().toString(16).slice(2, 8));
  await fs.mkdir(dir, { recursive: true });
  created.push(dir);
  return dir;
}
test.after(async () => { for (const dir of created) await removeTree(dir); await removeTree(TMP); });

const SESSION = Object.freeze({ host: 'local', id: 'chat-A', cwd: 'C:/work/A' });
const DECOYS = Object.freeze(['pwsh', 'read', 'write', 'subagent', 'subagent_fork', 'localpost_check', 'dev_reload_package', 'run_code',
  'mcp__linkdigest__digest_url']);
const until = async (condition, label) => {
  for (let i = 0; i < 500; i++) { if (condition()) return; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error('timed out waiting for ' + label);
};
const results = list => list.map(result => (result.denied ? 'denied' : result.skipped ? 'skipped' : result.isError ? 'error' : 'ok'));
const isRelay = message => message?.source?.kind === 'plugin:localpost';

/** A real mailbox whose take() can be held at a gate: an allowed call that stays in flight as long as the test wants. */
function holdable(mailbox) {
  const state = { gate: null, taking: 0, taken: 0 };
  return {
    state,
    inbox: (...args) => mailbox.inbox(...args),
    async take(...args) { state.taking += 1; if (state.gate) await state.gate.promise; state.taken += 1; return mailbox.take(...args); },
    reply: (...args) => mailbox.reply(...args),
    archive: (...args) => mailbox.archive(...args),
  };
}

/**
 * Chat A bound in automatic mode with one letter the automatic consumer has delivered to it (owned by A), the real five
 * mail tools registered by the "localpost" plugin, decoy tools registered globally by another plugin (so any call the
 * guard let through WOULD run a body), the mail-turn guard, and the child barrier registered as the wiring registers it.
 */
async function world(name, { drainFirst = true } = {}) {
  const root = await scratch(name);
  const store = createSessionStore({ root, waitMs: 2000 });
  await bind(store, 'dsh', {
    session: SESSION, mode: 'auto', capacity: 50, authority: { scope: 'analysis-reply', source: 'policy:test' }, source: 'e2e',
    attestation: { actionId: 'a1', hostId: SESSION.host, threadId: SESSION.id, cwd: SESSION.cwd },
  });
  await createMailbox({ root, identity: 'codex' })
    .deliver({ id: 'l1', from: 'codex', to: 'dsh', type: 'task', subject: 'please handle', body: 'do the thing' });
  const envelope = JSON.parse(await fs.readFile(path.join(root, 'agents', 'dsh', 'inbox', 'l1.json'), 'utf8'));
  assert.equal((await dispatchLetter(store, 'dsh', { id: 'l1', digest: envelopeDigest(envelope) }, { submit: async () => ({ accepted: true }) })).ok, true);
  const mailbox = holdable(createMailbox({ root, identity: 'dsh' }));

  const host = createTurnHost();
  const A = await host.agents.create({ id: SESSION.id, cwd: SESSION.cwd });
  const ran = [];
  const other = host.plugin('other');
  for (const tool of DECOYS) other.ctx.tools.register(recordingTool(tool, ran));

  const plugin = host.plugin('localpost');
  const drained = { report: null };
  let guard;
  // The plugin's own async drain effect is registered BEFORE its registrations, as lib/index.js:370 does (the outer
  // effect's wrapper exists before its callback registers anything), so a cordis unload disposes it LAST of all.
  if (drainFirst) plugin.fiber.effect(async () => { drained.report = await guard.drain({ timeoutMs: drained.timeoutMs ?? 2000 }); });
  const mail = createMailTools({ ctx: plugin.ctx, mailbox, store, identity: 'dsh', runtimeVersion: SUPPORTED_VERSION });
  assert.equal(mail.register().ok, true);
  guard = createMailTurnGuard({ policy: exec => mail.mailTurnReason(exec), agents: host.agents });
  plugin.ctx.on('agent/created', payload => {
    const refusal = guard.childRefusal(payload?.agent);
    if (refusal !== undefined) throw Object.assign(new Error('LocalPost: ' + refusal), { code: CHILD_REFUSED });
  });
  // What the adapter does inside its acceptance callback (dsh-adapter.mjs): arm, then enqueue - no await in between.
  const relay = agent => {
    const message = Object.freeze({ id: randomUUID(), role: 'user', source: Object.freeze({ kind: 'plugin:localpost', form: 'relay' }),
      content: [{ type: 'text', text: 'LocalPost agent mail relay: letter l1' }] });
    const armament = guard.arm(agent, message.id);
    agent.followup(message);
    return { message, armament };
  };
  const human = (agent, id = 'human-' + randomUUID()) => { agent.followup({ id, role: 'user', content: [{ type: 'text', text: 'hi' }] }); return id; };
  const denies = (agent, name = 'pwsh') => host.tools.guardReason({ name, agent, callId: 'probe' });
  return { root, host, A, ran, plugin, guard, mail, mailbox, relay, human, denies, drained };
}

/** The turn in A's log that claimed `id` (its user/message lies between that turn's turn/start and turn/end). */
function turnOf(agent, id) {
  let turn = null;
  for (const event of agent.log) {
    if (event.type === 'turn/start') turn = event.data.turn;
    if (event.type === 'user/message' && event.data.id === id) return turn;
  }
  return null;
}

test('the causal chain: armed before the enqueue, active from the claim, released by exactly that turn\'s end', async () => {
  const { host, A, ran, relay, human, denies } = await world('causal');
  const seen = [];
  A.model = async turn => {
    if (turn.claimed.some(isRelay)) {
      seen.push(results(await turn.step([
        { name: 'localpost_read', args: { id: 'l1' } }, { name: 'pwsh' }, { name: 'subagent' }, { name: 'localpost_check' },
        { name: 'run_code' }, { name: 'mcp__linkdigest__digest_url' }, { name: 'dev_reload_package' },
        { name: 'localpost_reply', args: { id: 'l1', outcome: 'completed', body: 'handled' } },
      ])));
    } else seen.push(results(await turn.step([{ name: 'pwsh' }])));
  };
  const { message, armament } = relay(A);
  assert.equal(armament.state, 'pending');
  assert.equal(denies(A), undefined, 'armed but not yet claimed: nothing is restricted');
  await A.whenIdle();
  assert.deepEqual(seen, [['ok', 'denied', 'denied', 'denied', 'denied', 'denied', 'denied', 'ok']]);
  assert.deepEqual(ran, [], 'no decoy body ran inside the mail turn');
  assert.deepEqual(host.bodyRuns.map(run => run.name), ['localpost_read', 'localpost_reply']);
  assert.equal(armament.turn, turnOf(A, message.id), 'the armament knows the turn that claimed its message');
  assert.equal(armament.releasedBy, 'turn-end:completed');
  assert.equal(host.guardsOn(A), 0, 'the guard left chat A with its turn');
  assert.deepEqual(host.hooks().filter(hook => hook.tag === SESSION.id), [], 'and so did its listeners');
  // The next human turn is not restricted.
  human(A);
  await A.whenIdle();
  assert.deepEqual(seen[1], ['ok']);
  assert.deepEqual(ran, ['pwsh']);
});

test('a relay queued behind a busy human turn restricts nothing until its own turn claims it', async () => {
  const { A, ran, relay, human, denies } = await world('queued');
  const hold = gate();
  const seen = [];
  A.model = async turn => {
    if (turn.claimed.some(isRelay)) { seen.push(['mail', ...results(await turn.step([{ name: 'pwsh' }, { name: 'localpost_status' }]))]); return; }
    seen.push(['human', ...results(await turn.step([{ name: 'pwsh', hold: hold.promise }]))]);
    seen.push(['human', ...results(await turn.step([{ name: 'write' }]))]);   // after the relay was armed and queued
  };
  human(A);
  await until(() => ran.length === 1, 'the human turn holding pwsh');
  const { armament } = relay(A);
  assert.equal(armament.state, 'pending');
  assert.equal(denies(A), undefined);
  hold.open();
  await A.whenIdle();
  assert.deepEqual(seen, [['human', 'ok'], ['human', 'ok'], ['mail', 'denied', 'ok']]);
  assert.deepEqual(ran, ['pwsh', 'write']);
  assert.equal(armament.releasedBy, 'turn-end:completed');
});

test('a relay discarded before any turn claims it is released without ever restricting', async () => {
  const { A, ran, relay, human } = await world('discarded');
  const hold = gate();
  A.model = async turn => { await turn.step([{ name: 'pwsh', hold: hold.promise }]); };
  human(A);
  await until(() => ran.length === 1, 'the human turn');
  const { message, armament } = relay(A);
  A.cancel({ kind: 'user' });                                // the user cancels and clears the inbox
  assert.equal(armament.releasedBy, 'discarded-before-claim');
  hold.open();
  await A.whenIdle();
  assert.equal(turnOf(A, message.id), null, 'the relay never opened a turn');
  assert.deepEqual(ran, ['pwsh']);
});

test('cancel is not the end: before, during and after the drain of an in-flight call', async () => {
  const { host, A, ran, relay, denies, mailbox } = await world('cancel');
  const order = [];
  mailbox.state.gate = gate();
  A.model = async turn => {
    if (!turn.claimed.some(isRelay)) return;
    // The allowed read stays in flight; an unauthorized call starts alongside it.
    order.push(...results(await turn.step([{ name: 'localpost_read', args: { id: 'l1' }, wait: false }, { name: 'pwsh' }])));
  };
  const { armament } = relay(A);
  armament.released.then(() => order.push('released'));
  await until(() => mailbox.state.taking === 1, 'the read body in flight');
  await until(() => host.bodyRuns.length === 1 && A.log.some(event => event.type === 'tool/result'), 'the denied pwsh');
  assert.match(denies(A), /localpost-mail-turn/, 'before cancel: denying');
  A.cancel({ kind: 'user' }, { keepInbox: true });
  assert.equal(armament.state, 'active', 'cancel() returned, the turn has not ended');
  assert.match(denies(A), /localpost-mail-turn/, 'during the drain: still denying');
  assert.equal(host.guardsOn(A), 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(armament.state, 'active', 'an in-flight body keeps the turn open, however long');
  order.push('body-released');
  mailbox.state.gate.open();
  await A.whenIdle();
  assert.equal(armament.releasedBy, 'turn-end:aborted');
  assert.deepEqual(order.filter(item => item === 'released' || item === 'body-released'), ['body-released', 'released'],
    'released only after the in-flight body settled and the turn ended');
  assert.equal(mailbox.state.taken, 1, 'the in-flight read finished: cancellation drains, it does not abandon');
  assert.deepEqual(ran, [], 'the unauthorized call never ran');
  assert.equal(denies(A), undefined, 'after the turn ended: nothing restricted');
});

test('unload during a mail turn: the plugin goes, the guard on the chat stays until that turn has ended', async () => {
  const { host, A, ran, relay, human, denies, mailbox, plugin, drained } = await world('unload');
  mailbox.state.gate = gate();
  A.model = async turn => {
    if (turn.claimed.some(isRelay)) await turn.step([{ name: 'localpost_read', args: { id: 'l1' } }]);
  };
  const { message, armament } = relay(A);
  await until(() => mailbox.state.taking === 1, 'the read body in flight');
  const queued = human(A);                                    // the user's input, queued behind the mail turn
  const unloading = plugin.unload();                          // cordis: every plugin effect at once, newest first
  await until(() => host.globalGuards() === 0, 'the plugin-owned registrations disposed');
  assert.equal(host.tools.get('localpost_read'), undefined, 'the plugin\'s tools are gone');
  assert.equal(host.guardsOn(A), 1, 'the armament lives on chat A\'s scope, not on the plugin');
  assert.match(denies(A), /localpost-mail-turn/, 'the still-running mail turn reaches no other tool');
  assert.match(denies(A, 'localpost_read'), /^localpost-mail-turn: "localpost_read" is not visible to this caller/, 'nor, with the plugin gone, the five');
  mailbox.state.gate.open();
  await unloading;
  assert.deepEqual(drained.report.held, []);
  assert.deepEqual(drained.report.released.map(item => [item.messageId, item.releasedBy]), [[message.id, 'turn-end:aborted']]);
  assert.deepEqual(drained.report.steps.map(step => step.step), ['cancelled']);
  assert.deepEqual(drained.report.idle.map(item => item.idle), [true]);
  assert.equal(armament.state, 'released');
  assert.deepEqual(A.inbox.nextTurn.map(item => item.id), [queued], 'the user\'s queued input survived the drain');
  assert.deepEqual(ran, []);
});

test('red/green: a plugin-owned guard is gone before the drain ends; the armament is not', async () => {
  const host = createTurnHost();
  const A = await host.agents.create({ id: 'chat-A' });
  const ran = [];
  host.plugin('other').ctx.tools.register(recordingTool('slow', ran));    // an allowed call that stays in flight
  const plugin = host.plugin('localpost');
  const drainGate = gate();
  plugin.fiber.effect(async () => { await drainGate.promise; });          // the plugin's drain, still running
  // The pre-C2 pattern: the protection registered through the plugin's own context.
  plugin.ctx.tools.guard(exec => (exec.agent === A && exec.name === 'pwsh' ? 'plugin-owned guard' : undefined));
  const guard = createMailTurnGuard({ policy: exec => (exec.name === 'pwsh' ? 'armament guard' : undefined), agents: host.agents });
  const armament = guard.arm(A, 'm1');
  const hold = gate();
  A.model = async turn => { if (turn.claimed.some(message => message.id === 'm1')) await turn.step([{ name: 'slow', hold: hold.promise }]); };
  A.followup({ id: 'm1', role: 'user', content: [] });
  await until(() => ran.length === 1, 'the slow call in flight');
  assert.equal(host.tools.guardReason({ name: 'pwsh', agent: A }), 'plugin-owned guard', 'before unload both stand; the global one answers first');
  const unloading = plugin.unload();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.globalGuards(), 0, 'RED: the plugin-owned guard vanished while the plugin\'s drain was still pending');
  assert.equal(host.tools.guardReason({ name: 'pwsh', agent: A }), 'armament guard', 'GREEN: the armament on the chat still denies');
  drainGate.open();
  await unloading;
  assert.equal(armament.state, 'active', 'unloading the plugin did not release it either');
  hold.open();
  await A.whenIdle();
  assert.equal(armament.releasedBy, 'turn-end:completed');
});

test('a drain that runs out of time keeps the guard standing, reports it, and the turn releases it later', async () => {
  const { host, A, ran, relay, denies, mailbox, plugin, drained } = await world('stuck');
  drained.timeoutMs = 40;
  mailbox.state.gate = gate();
  A.model = async turn => { if (turn.claimed.some(isRelay)) await turn.step([{ name: 'localpost_read', args: { id: 'l1' } }]); };
  const { message, armament } = relay(A);
  await until(() => mailbox.state.taking === 1, 'the stuck read');
  await plugin.unload();
  assert.deepEqual(drained.report.released, []);
  assert.deepEqual(drained.report.held.map(item => [item.messageId, item.state]), [[message.id, 'active']]);
  assert.match(drained.report.held[0].held, /not drained within 40ms/);
  assert.equal(host.guardsOn(A), 1, 'the plugin is fully unloaded and chat A is still guarded');
  assert.match(denies(A), /localpost-mail-turn/);
  mailbox.state.gate.open();
  await A.whenIdle();
  assert.equal(armament.releasedBy, 'turn-end:aborted', 'released by its own turn, not by the timeout');
  assert.equal(host.guardsOn(A), 0);
  assert.deepEqual(ran, []);
});

test('unload while the relay is still queued withdraws it; the human turn in progress is not touched', async () => {
  const { A, ran, relay, human, plugin, drained } = await world('withdraw');
  const hold = gate();
  const seen = [];
  A.model = async turn => {
    seen.push(...results(await turn.step([{ name: 'pwsh', hold: hold.promise }])));
    seen.push(...results(await turn.step([{ name: 'write' }])));
  };
  human(A);
  await until(() => ran.length === 1, 'the human turn');
  const { message, armament } = relay(A);
  await plugin.unload();
  assert.equal(armament.releasedBy, 'discarded-before-claim');
  assert.deepEqual(drained.report.steps.map(step => step.step), ['removed-from-inbox']);
  hold.open();
  await A.whenIdle();
  assert.deepEqual(seen, ['ok', 'ok'], 'the human turn ran on, unrestricted');
  assert.equal(turnOf(A, message.id), null, 'the withdrawn relay never opened a turn');
  assert.deepEqual(ran, ['pwsh', 'write']);
});

test('only that turn\'s end releases: other chats, other turns, other messages and the clock do not', async () => {
  const { host, A, relay, denies, mailbox } = await world('only-causal');
  const B = await host.agents.create({ id: 'chat-B' });
  mailbox.state.gate = gate();
  A.model = async turn => { if (turn.claimed.some(isRelay)) await turn.step([{ name: 'localpost_read', args: { id: 'l1' } }]); };
  const { armament } = relay(A);
  await until(() => mailbox.state.taking === 1, 'the mail turn in flight');
  const turn = armament.turn;
  B.followup({ id: 'b-1', role: 'user', content: [] });
  await B.whenIdle();                                         // chat B's turn with the same number ends
  assert.ok(B.log.some(event => event.type === 'turn/end' && event.data.turn === turn));
  host.emit(A, 'session/event', B.session, { type: 'turn/end', data: { turn } });          // B's session, A's channel
  host.emit(A, 'session/event', A.session, { type: 'turn/end', data: { turn: turn + 1 } }); // another turn of A
  host.emit(A, 'agent/inbox/claimed', { message: { id: 'someone-else' }, turn: turn + 1, agent: A });
  host.emit(A, 'agent/inbox/discarded', { message: { id: armament.messageId }, agent: A });  // a discard after the claim
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(armament.state, 'active');
  assert.match(denies(A), /localpost-mail-turn/);
  mailbox.state.gate.open();
  await A.whenIdle();
  assert.equal(armament.releasedBy, 'turn-end:completed');
});

test('P3: a mail turn cannot create a child agent at the real creation entry; children outside it are not covered', async () => {
  const { host, A, ran, relay, mailbox } = await world('children');
  // Outside a mail turn a child of A is created normally, and its own calls run unrestricted (scope note).
  const before = await host.agents.create({ id: 'child-before', owner: A });
  assert.equal(host.agents.get('child-before'), before);
  mailbox.state.gate = gate();
  const seen = [];
  A.model = async turn => {
    if (!turn.claimed.some(isRelay)) return;
    seen.push(...results(await turn.step([{ name: 'subagent' }, { name: 'subagent_fork' }])));   // the model's spawn tools
    await turn.step([{ name: 'localpost_read', args: { id: 'l1' } }]);
  };
  const { armament } = relay(A);
  await until(() => mailbox.state.taking === 1, 'the mail turn');
  assert.deepEqual(seen, ['denied', 'denied'], 'the spawn tools never reach their bodies');
  // The creation entry itself refuses a child of A while its mail turn runs: the serial agent/created dispatch rejects.
  await assert.rejects(host.agents.create({ id: 'child-during', owner: A }), { code: CHILD_REFUSED });
  assert.equal(host.agents.get('child-during'), undefined, 'the refused child was rolled back');
  // Another chat may still create children.
  const B = await host.agents.create({ id: 'chat-B' });
  assert.ok(await host.agents.create({ id: 'child-of-b', owner: B }));
  // A child that existed before the mail turn keeps running unrestricted (not covered: it cannot hear from A's turn).
  before.model = async turn => { await turn.step([{ name: 'pwsh' }]); };
  before.followup({ id: 'c-1', role: 'user', content: [] });
  await before.whenIdle();
  assert.deepEqual(ran, ['pwsh']);
  mailbox.state.gate.open();
  await A.whenIdle();
  assert.equal(armament.state, 'released');
  assert.ok(await host.agents.create({ id: 'child-after', owner: A }), 'after the turn A may create children again');
});

test('two relays: each restricts only its own turn, in order', async () => {
  const { A, ran, relay } = await world('two');
  const seen = [];
  A.model = async turn => { seen.push([turn.claimed.map(message => (isRelay(message) ? 'relay' : 'human')).join(), ...results(await turn.step([{ name: 'pwsh' }]))]); };
  const hold = gate();
  const first = A.model;
  A.model = async turn => { if (seen.length === 0) await turn.step([{ name: 'read', hold: hold.promise }]); return first(turn); };
  A.followup({ id: 'human-1', role: 'user', content: [] });
  await until(() => ran.length === 1, 'the human turn');
  const one = relay(A);
  const two = relay(A);
  assert.deepEqual([one.armament.state, two.armament.state], ['pending', 'pending']);
  hold.open();
  await A.whenIdle();
  assert.deepEqual(seen, [['human', 'ok'], ['relay', 'denied'], ['relay', 'denied']]);
  assert.deepEqual([one.armament.turn, two.armament.turn], [2, 3]);
  assert.deepEqual([one.armament.releasedBy, two.armament.releasedBy], ['turn-end:completed', 'turn-end:completed']);
  assert.deepEqual(ran, ['read', 'pwsh']);
});

test('an armament is never half-made: a failing registration leaves nothing behind and refuses the relay', async () => {
  const host = createTurnHost();
  const A = await host.agents.create({ id: 'chat-A' });
  const guard = createMailTurnGuard({ policy: () => 'deny', agents: host.agents });
  const hooksBefore = host.hooks().length;
  const on = A.ctx.on;
  let calls = 0;
  A.ctx.on = (name, listener) => { calls += 1; if (calls === 3) throw new Error('listener table full'); return on(name, listener); };
  assert.throws(() => guard.arm(A, 'm1'), { code: GUARD_UNAVAILABLE });
  assert.equal(host.guardsOn(A), 0);
  assert.equal(host.hooks().length, hooksBefore);
  assert.deepEqual(guard.status().armaments, []);
  for (const agent of [undefined, {}, { ctx: {}, session: {} }, { ctx: { tools: { guard() {} }, on() {} } }])
    assert.throws(() => guard.arm(agent, 'm2'), { code: GUARD_UNAVAILABLE });
  assert.throws(() => guard.arm(A, ''), { code: GUARD_UNAVAILABLE });
});

test('a failing policy denies; the guard never throws into the host and never admits by accident', async () => {
  const host = createTurnHost();
  const A = await host.agents.create({ id: 'chat-A' });
  const guard = createMailTurnGuard({ policy: () => { throw new Error('policy exploded'); }, agents: host.agents });
  const armament = guard.arm(A, 'm1');
  const hold = gate();
  const seen = [];
  A.model = async turn => { await hold.promise; seen.push(...results(await turn.step([{ name: 'pwsh' }]))); };
  A.followup({ id: 'm1', role: 'user', content: [] });
  await until(() => armament.state === 'active', 'the claim');
  assert.match(host.tools.guardReason({ name: 'pwsh', agent: A }), /the policy failed \(policy exploded\)/);
  hold.open();
  await A.whenIdle();
  assert.deepEqual(seen, ['denied']);
  assert.equal(armament.state, 'released');
});
