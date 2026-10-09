import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSessionStore, bind, bindingIdentity } from './session-binding.mjs';
import {
  reserve, reserveIn, beginDispatch, beginDispatchIn, settle, settleIn, dispatchLetter, claimManual, complete,
  resolveUncertain, requestMode, requestModeIn, switchMode, recoverClaims, occupancy, rotationDue, takeOverIn,
} from './letter-claims.mjs';
import { auditState } from './rotation.mjs';
import { envelopeDigest } from './mailbox.mjs';
import { createFakeHost } from './fixtures/fake-session-host.mjs';
import { removeTreeSync } from './temp-tree.mjs';

const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/letter-claims');
const AUTHORITY = { scope: 'analysis-reply', source: 'policy:test' };
const OWNER = { generation: 1, session: 'session-1' };
async function setup(t, { identity = 'codex', mode = 'auto', capacity = 50, root } = {}) {
  if (!root) {
    fs.mkdirSync(tempRoot, { recursive: true });
    root = fs.mkdtempSync(path.join(tempRoot, 'case-'));
    const created = root;
    t.after(() => removeTreeSync(created));
  }
  const store = createSessionStore({ root });
  await bind(store, identity, { session: { host: 'fake', id: 'session-1' }, mode, capacity, authority: AUTHORITY, source: 'user:explicit-bind' });
  return { root, store, host: createFakeHost({ root }) };
}
const mail = id => ({ id, digest: envelopeDigest({ id, thread_id: id, from: 'dsh', to: 'codex', type: 'task', subject: 'Analyze', body: 'Please analyze', budget: 'standard', created_at: '2026-10-02T00:00:00.000Z' }) });
// Bulk setup through the same pure transitions the wrappers use: reserve → dispatching → accepted.
const acceptMany = (store, count) => store.update('codex', state => {
  for (let i = 1; i <= count; i++) {
    const letter = mail(`letter-${i}`), at = store.at(), token = `bulk-${i}`;
    assert.equal(reserveIn(state, letter, at).ok, true);
    assert.equal(beginDispatchIn(state, letter.id, { token }, at).ok, true);
    assert.equal(settleIn(state, letter.id, { token, outcome: 'accepted' }, at).ok, true);
  }
});

test('49/50/51: the 50th acceptance makes rotation due and the 51st letter stays queued', async t => {
  const { store, host } = await setup(t);
  await acceptMany(store, 49);
  let state = await store.read('codex');
  assert.deepEqual([occupancy(state).settled, rotationDue(state)], [49, false]);
  const fiftieth = await dispatchLetter(store, 'codex', mail('letter-50'), host);
  assert.equal(fiftieth.claim.status, 'accepted');
  state = await store.read('codex');
  assert.deepEqual([occupancy(state).settled, rotationDue(state)], [50, true]);
  const fiftyFirst = await dispatchLetter(store, 'codex', mail('letter-51'), host);
  assert.deepEqual([fiftyFirst.ok, fiftyFirst.reason], [false, 'capacity_full']);
  state = await store.read('codex');
  assert.equal(Object.hasOwn(state.claims, 'letter-51'), false, 'not claimed: it stays in the queue for the next generation');
  assert.deepEqual(host.state().submits.map(x => x.letter), ['letter-50']);
  assert.equal(host.state().submits[0].key, 'codex:letter-50:g1');
  assert.deepEqual(auditState(state), []);
});

test('an in-flight 50th reservation blocks the 51st; an explicit host rejection releases it', async t => {
  const { store, host } = await setup(t);
  await acceptMany(store, 49);
  assert.equal((await reserve(store, 'codex', mail('letter-50'))).ok, true);
  assert.equal((await reserve(store, 'codex', mail('letter-51'))).reason, 'capacity_full');
  host.behavior.submit = 'reject';
  const rejected = await dispatchLetter(store, 'codex', mail('letter-50'), host);
  assert.deepEqual([rejected.claim.status, rejected.claim.reason], ['released', 'host_rejected']);
  assert.equal(rotationDue(await store.read('codex')), false);
  host.behavior.submit = 'accept';
  assert.equal((await dispatchLetter(store, 'codex', mail('letter-51'), host)).claim.status, 'accepted');
  assert.equal((await dispatchLetter(store, 'codex', mail('letter-50'), host)).reason, 'capacity_full', 'a released letter competes for capacity like any other');
});

test('concurrent reservations at 49 admit exactly one, and a burst never overbooks', async t => {
  const { root, store } = await setup(t);
  await acceptMany(store, 49);
  const other = createSessionStore({ root });
  const pair = await Promise.all([reserve(store, 'codex', mail('race-a')), reserve(other, 'codex', mail('race-b'))]);
  assert.equal(pair.filter(x => x.ok).length, 1);
  assert.equal(pair.find(x => !x.ok).reason, 'capacity_full');
  const small = await setup(t, { identity: 'opencode', capacity: 5, root });
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => reserve(i % 2 ? small.store : other, 'opencode', mail(`burst-${i}`))));
  assert.equal(burst.filter(x => x.ok).length, 5);
  assert.ok(burst.filter(x => !x.ok).every(x => x.reason === 'capacity_full'));
  assert.equal(occupancy(await store.read('opencode')).total, 5);
});

test('id + digest deduplicates: repeats never count twice and a changed digest is a conflict', async t => {
  const { store, host } = await setup(t, { capacity: 3 });
  const letter = mail('dup');
  assert.equal((await reserve(store, 'codex', letter)).ok, true);
  assert.equal((await reserve(store, 'codex', letter)).reused, true);
  assert.equal(occupancy(await store.read('codex')).total, 1);
  assert.equal((await dispatchLetter(store, 'codex', letter, host)).claim.status, 'accepted');
  assert.equal((await dispatchLetter(store, 'codex', letter, host)).reason, 'duplicate');
  assert.equal((await complete(store, 'codex', 'dup', OWNER)).claim.status, 'done');
  assert.equal((await reserve(store, 'codex', letter)).reason, 'duplicate');
  assert.equal((await reserve(store, 'codex', { id: 'dup', digest: 'a'.repeat(64) })).reason, 'digest_conflict');
  const state = await store.read('codex');
  assert.deepEqual([state.claims.dup.digest, state.claims.dup.status, occupancy(state).settled], [letter.digest, 'done', 1]);
  assert.equal(host.state().submits.length, 1);
});

test('uncertain acceptance is isolated, never redispatched, and closed only by its owner or an operator', async t => {
  const { store, host } = await setup(t);
  host.behavior.submit = 'throw';
  const first = await dispatchLetter(store, 'codex', mail('unsure'), host);
  assert.deepEqual([first.claim.status, first.claim.reason], ['needs_reconcile', 'dispatch_uncertain']);
  host.behavior.submit = 'accept';
  assert.equal((await dispatchLetter(store, 'codex', mail('unsure'), host)).reason, 'needs_reconcile');
  assert.equal(host.state().submits.filter(x => x.letter === 'unsure').length, 1);
  assert.equal((await complete(store, 'codex', 'unsure', { generation: 1, session: 'intruder' })).reason, 'not_owner');
  assert.equal((await complete(store, 'codex', 'unsure', OWNER)).claim.status, 'done');

  host.behavior.submit = 'throw';
  await dispatchLetter(store, 'codex', mail('lost'), host);
  const { version } = (await store.read('codex')).claims.lost;
  assert.equal((await resolveUncertain(store, 'codex', 'lost', { outcome: 'requeue', expectedVersion: version - 1 })).reason, 'version_conflict');
  assert.equal((await resolveUncertain(store, 'codex', 'lost', { outcome: 'requeue', expectedVersion: version })).claim.status, 'released');
  host.behavior.submit = 'accept';
  assert.equal((await dispatchLetter(store, 'codex', mail('lost'), host)).claim.status, 'accepted');
  assert.equal(host.state().submits.filter(x => x.letter === 'lost').length, 2, 'only an operator requeue leads to a second delivery');
});

test('a late host outcome for an isolated attempt is kept as evidence only', async t => {
  const { store } = await setup(t);
  await reserve(store, 'codex', mail('late'));
  const begun = await beginDispatch(store, 'codex', 'late');
  assert.equal(begun.ok, true);
  // Its dispatcher died here; the next actor finds the attempt in flight and isolates it.
  assert.deepEqual((await store.withActor('codex', () => recoverClaims(store, 'codex'))).isolated, ['late']);
  const late = await settle(store, 'codex', 'late', { token: begun.token, outcome: 'accepted' });
  assert.deepEqual([late.ok, late.reason], [false, 'stale_attempt']);
  const claim = (await store.read('codex')).claims.late;
  assert.deepEqual([claim.status, claim.reason, claim.late.outcome], ['needs_reconcile', 'dispatch_interrupted', 'accepted']);
  assert.equal((await settle(store, 'codex', 'late', { token: 'forged', outcome: 'failed' })).reason, 'stale_attempt');
});

test('manual and auto share one ledger: one consumer at a time, and a mode switch freezes, drains and swaps by CAS', async t => {
  const { store, host } = await setup(t);
  const shared = mail('shared');
  // Racing for the same letter in auto mode: only the automatic consumer may take it.
  const [manual, automatic] = await Promise.all([claimManual(store, 'codex', { ...shared, session: 'session-1' }), dispatchLetter(store, 'codex', shared, host)]);
  assert.equal(manual.reason, 'mode_auto');
  assert.equal(automatic.claim.status, 'accepted');
  await reserve(store, 'codex', mail('waiting'));
  await reserve(store, 'codex', mail('inflight'));
  await beginDispatch(store, 'codex', 'inflight');
  const { version } = (await store.read('codex')).binding;
  assert.equal((await requestMode(store, 'codex', 'manual', { expectedVersion: version - 1 })).reason, 'version_conflict');
  assert.equal((await requestMode(store, 'codex', 'manual', { expectedVersion: version })).ok, true);
  // Frozen for the switch: neither consumer may take new mail.
  assert.equal((await reserve(store, 'codex', mail('during'))).reason, 'frozen');
  assert.equal((await claimManual(store, 'codex', { ...mail('during'), session: 'session-1' })).reason, 'frozen');
  assert.equal((await beginDispatch(store, 'codex', 'waiting')).reason, 'frozen');
  assert.equal((await switchMode(store, 'codex', 'manual')).ok, true);
  let state = await store.read('codex');
  assert.deepEqual([state.binding.mode, state.binding.state, state.binding.version], ['manual', 'active', version + 2]);
  assert.deepEqual([state.claims.inflight.status, state.claims.inflight.reason], ['needs_reconcile', 'dispatch_interrupted']);
  // The reservation made under auto stays in the same ledger; only the bound session may now take it.
  assert.equal((await claimManual(store, 'codex', { ...mail('waiting'), session: 'someone-else' })).reason, 'not_bound_session');
  const [taken, refused] = await Promise.all([claimManual(store, 'codex', { ...mail('waiting'), session: 'session-1' }), dispatchLetter(store, 'codex', mail('waiting'), host)]);
  assert.equal(taken.claim.status, 'accepted');
  assert.equal(refused.reason, 'mode_manual');
  assert.equal((await claimManual(store, 'codex', { ...shared, session: 'session-1' })).reused, true, 'already its own letter: not counted again');
  assert.deepEqual(host.state().submits.map(x => x.letter), ['shared']);
  state = await store.read('codex');
  assert.deepEqual([occupancy(state).accepted, occupancy(state).needs_reconcile], [2, 1]);
  assert.deepEqual(auditState(state), []);
});

test('a pending mode switch is finished by the next actor after a crash', async t => {
  const { store, host } = await setup(t);
  assert.equal((await requestMode(store, 'codex', 'manual')).ok, true);
  assert.equal((await dispatchLetter(store, 'codex', mail('after-crash'), host)).reason, 'mode_manual');
  assert.deepEqual([(await store.read('codex')).binding.mode, (await store.read('codex')).binding.state], ['manual', 'active']);
  assert.equal(host.state().submits.length, 0);
});

test('prototype-named letter ids are ordinary ledger keys', async t => {
  const { store, host } = await setup(t);
  for (const id of ['constructor', 'toString', 'hasOwnProperty']) assert.equal((await dispatchLetter(store, 'codex', mail(id), host)).claim.status, 'accepted');
  const state = await store.read('codex');
  assert.equal(occupancy(state).accepted, 3);
  assert.equal((await complete(store, 'codex', 'valueOf', OWNER)).reason, 'not_claimed');
});

test('a mode switch for a proven binding identity switches that binding or nothing, checked before any write (ABA-safe)', () => {
  const at = '2026-10-03T00:00:00.000Z';
  const binding = { version: 1, generation: 1, session: { host: 'local', id: 'chat-A', cwd: 'C:/work/A' }, since: at,
    attestation: { kind: 'chat-action', actionId: 'a1' }, mode: 'auto', state: 'active', frozen: null, capacity: 50 };
  const proven = bindingIdentity(binding);
  // One field different at a time, so every part of the identity is shown to matter on its own.
  for (const replaced of [
    { since: '2026-10-03T00:00:01.000Z' },                                     // bound afresh later, at the same version
    { attestation: { kind: 'chat-action', actionId: 'a2' } },                  // bound afresh within the same millisecond
    { session: { host: 'other-host', id: 'chat-A', cwd: 'C:/work/A' } },       // another host
    { session: { host: 'local', id: 'chat-B', cwd: 'C:/work/A' } },            // another chat
    { session: { host: 'local', id: 'chat-A', cwd: 'C:/work/elsewhere' } },    // another workspace
    { generation: 2 },                                                         // another generation
    { version: 5 },                                                            // the same binding, modes switched since
    { state: 'frozen', frozen: { for: 'mode', mode: 'manual', at }, attestation: { kind: 'chat-action', actionId: 'a2' } }, // another's pending switch
  ]) {
    const state = { binding: { ...binding, ...replaced }, rotations: {}, claims: {} };
    const before = structuredClone(state);
    assert.deepEqual(requestModeIn(state, 'manual', { expectedBinding: proven }, at), { ok: false, reason: 'binding_conflict' }, JSON.stringify(replaced));
    assert.deepEqual(state, before, 'zero change for ' + JSON.stringify(replaced));
  }
  const state = { binding: { ...binding }, rotations: {}, claims: {} };
  assert.equal(requestModeIn(state, 'manual', { expectedBinding: proven }, at).ok, true, 'the proven binding itself is switched');
  assert.deepEqual([state.binding.state, state.binding.frozen.mode], ['frozen', 'manual']);
});

/* ------------------------------------------------------------------ takeover (2026-10-09): moving the mail to another chat */

const TAKEOVER_AT = '2026-10-09T00:00:00.000Z';
const takeoverState = (overrides = {}) => ({
  binding: { version: 3, generation: 1, session: { host: 'local', id: 'chat-A', cwd: 'C:/work/A' }, since: '2026-10-06T00:00:00.000Z',
    attestation: { kind: 'chat-action', actionId: 'a1' }, mode: 'manual', state: 'active', frozen: null, capacity: 50,
    authority: { scope: 'analysis-reply', source: 'policy:test' }, source: 'chat-action:a1', ...overrides },
  claims: {}, rotations: {}, context: { samples: 1 },
});
const takeoverRequest = (state, extra = {}) => ({
  session: { host: 'local', id: 'chat-B', cwd: 'C:/work/B' }, attestation: { actionId: 'b1', hostId: 'local', threadId: 'chat-B', cwd: 'C:/work/B' },
  source: 'chat-action:b1', authority: { scope: 'analysis-reply', source: 'policy:user-request-in-chat' },
  expectedBinding: bindingIdentity(state.binding), ...extra,
});

test('takeover replaces the binding with a fresh attested one for the new chat and remembers the one it replaced', () => {
  const state = takeoverState();
  const result = takeOverIn(state, takeoverRequest(state), TAKEOVER_AT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.previous, { session: { host: 'local', id: 'chat-A', cwd: 'C:/work/A' }, since: '2026-10-06T00:00:00.000Z', attestation: 'a1' });
  const { binding } = state;
  assert.deepEqual([binding.version, binding.generation, binding.mode, binding.state, binding.frozen], [4, 1, 'auto', 'active', null]);
  assert.deepEqual(binding.session, { host: 'local', id: 'chat-B', cwd: 'C:/work/B' });
  assert.deepEqual(binding.attestation, { kind: 'chat-action', actionId: 'b1', hostId: 'local', threadId: 'chat-B', cwd: 'C:/work/B', at: TAKEOVER_AT });
  assert.deepEqual([binding.since, binding.source, binding.capacity, binding.authority.source], [TAKEOVER_AT, 'chat-action:b1', 50, 'policy:user-request-in-chat']);
  assert.deepEqual(binding.replaced, [{ ...result.previous, until: TAKEOVER_AT }]);
  assert.deepEqual([state.rotations, state.context], [{}, null], 'the old chat\'s rotation journals and context samples do not carry over');
  // A second takeover keeps the whole chain, so mail from either replaced binding still follows.
  takeOverIn(state, takeoverRequest(state, { session: { host: 'local', id: 'chat-C', cwd: 'C:/work/C' }, attestation: { actionId: 'c1', hostId: 'local', threadId: 'chat-C', cwd: 'C:/work/C' }, source: 'chat-action:c1' }), TAKEOVER_AT);
  assert.deepEqual(state.binding.replaced.map(entry => entry.attestation), ['a1', 'b1']);
});

test('takeover changes nothing when the binding moved since the caller looked, or a rotation is under way', () => {
  for (const [label, overrides, rotations, reason] of [
    ['another chat bound afresh at the same version (ABA)', { since: '2026-10-08T00:00:00.000Z', attestation: { kind: 'chat-action', actionId: 'a2' } }, {}, 'binding_conflict'],
    ['the binding was switched since', { version: 5 }, {}, 'binding_conflict'],
    ['a rotation freeze', { state: 'frozen', frozen: { for: 'rotation', at: TAKEOVER_AT } }, {}, 'rotation_in_progress'],
    ['an unfinished rotation journal', {}, { 1: { generation: 1, state: 'drained', from: { host: 'local', id: 'chat-A' }, history: [] } }, 'rotation_in_progress'],
  ]) {
    const seen = takeoverState();
    const state = takeoverState(overrides);
    state.rotations = rotations;
    const before = structuredClone(state);
    const request = takeoverRequest(seen);
    assert.deepEqual(takeOverIn(state, request, TAKEOVER_AT), { ok: false, reason }, label);
    assert.deepEqual(state, before, 'zero change: ' + label);
  }
  // A pending mode switch is no obstacle: the new binding is automatic anyway.
  const pending = takeoverState({ state: 'frozen', frozen: { for: 'mode', mode: 'auto', at: TAKEOVER_AT } });
  assert.equal(takeOverIn(pending, takeoverRequest(pending), TAKEOVER_AT).ok, true);
  assert.deepEqual([pending.binding.state, pending.binding.frozen, pending.binding.mode], ['active', null, 'auto']);
});

test('takeover: letters the old chat may still be working on block it; forced, they are the new chat\'s, settled history is dropped', () => {
  const claim = (letter, status) => ({ letter, digest: 'b'.repeat(64), version: 2, transfers: 0, attempts: 1, history: [], status,
    owner: { generation: 1, session: 'chat-A' }, completion: status === 'completing' ? { op: 'reply' } : undefined });
  const fill = state => {
    for (const [id, status] of [['l-dispatching', 'dispatching'], ['l-accepted', 'accepted'], ['l-completing', 'completing'], ['l-uncertain', 'needs_reconcile'],
      ['l-done', 'done'], ['l-released', 'released'], ['l-reserved', 'reserved']]) state.claims[id] = claim(id, status);
    return state;
  };
  const blocked = fill(takeoverState());
  const before = structuredClone(blocked);
  const refused = takeOverIn(blocked, takeoverRequest(blocked), TAKEOVER_AT);
  assert.deepEqual([refused.ok, refused.reason, [...refused.letters].sort()], [false, 'unfinished_letters', ['l-accepted', 'l-completing', 'l-dispatching', 'l-uncertain']]);
  assert.deepEqual(blocked, before, 'zero change while unfinished letters block it');

  const forced = fill(takeoverState());
  const moved = takeOverIn(forced, takeoverRequest(forced, { force: true }), TAKEOVER_AT);
  assert.deepEqual([...moved.moved].sort(), ['l-accepted', 'l-completing', 'l-dispatching', 'l-uncertain']);
  assert.deepEqual(Object.keys(forced.claims).sort(), ['l-accepted', 'l-completing', 'l-dispatching', 'l-uncertain'], 'done, released and stray reservations are dropped');
  for (const entry of Object.values(forced.claims)) {
    assert.deepEqual([entry.status, entry.owner, entry.taken_over_from, entry.transfers, entry.version, entry.reason],
      ['accepted', { generation: 1, session: 'chat-B' }, { generation: 1, session: 'chat-A' }, 1, 3, 'taken_over'], entry.letter);
    assert.equal(Object.hasOwn(entry, 'completion'), false, 'the old chat\'s completion intent does not bind the new chat');
    assert.deepEqual(entry.history.at(-1), { status: 'accepted', generation: 1, at: TAKEOVER_AT });
  }
});
