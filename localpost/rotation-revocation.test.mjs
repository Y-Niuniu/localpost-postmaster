import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSessionStore, bind } from './session-binding.mjs';
import { dispatchLetter, claimManual, complete, switchMode, resolveUncertain } from './letter-claims.mjs';
import { createRotation, candidateSessionId, deriveAlerts, auditState } from './rotation.mjs';
import { envelopeDigest } from './mailbox.mjs';
import { createFakeHost } from './fixtures/fake-session-host.mjs';
import { removeTreeSync } from './temp-tree.mjs';

// P0 gate (codex 2026-10-03): a letter the old session already accepted may change owner only after the host proves
// the old session lost it (revocation barrier), and reaches the new session only after the old one is retired.
const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/rotation-revocation');
const AUTHORITY = { scope: 'analysis-reply', source: 'policy:test' };
const OLD = { generation: 1, session: 'session-1' };
const NEXT = candidateSessionId('codex', 2, 1);
const NEW = { generation: 2, session: NEXT };
const CWD = 'C:/work/project-a';
const mail = id => ({ id, digest: envelopeDigest({ id, thread_id: id, from: 'dsh', to: 'codex', type: 'task', subject: 'Analyze',
  body: 'Please analyze', budget: 'standard', created_at: '2026-10-03T00:00:00.000Z' }) });
const view = claim => [claim.status, claim.reason, claim.owner.generation, claim.owner.session];

/** Generation 1 at capacity 5: two letters done, two accepted and still in the old session's hands, one uncertain. */
async function scenario(t, { mode = 'auto', behavior = {} } = {}) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(root));
  const store = createSessionStore({ root });
  const host = createFakeHost({ root, behavior });
  host.seed('session-1', { identity: 'codex', generation: 1, cwd: CWD, authority: AUTHORITY });
  await bind(store, 'codex', { session: { host: 'fake', id: 'session-1', cwd: CWD }, mode: 'auto', capacity: 5, authority: AUTHORITY, source: 'user:explicit-bind' });
  for (const id of ['done-1', 'done-2', 'open-1', 'open-2']) assert.equal((await dispatchLetter(store, 'codex', mail(id), host)).claim.status, 'accepted');
  for (const id of ['done-1', 'done-2']) await complete(store, 'codex', id, OLD);
  host.behavior.submit = 'throw';
  assert.equal((await dispatchLetter(store, 'codex', mail('unsure'), host)).claim.status, 'needs_reconcile');
  delete host.behavior.submit;
  if (mode === 'manual') assert.equal((await switchMode(store, 'codex', 'manual')).ok, true);
  return { root, store, host, rotation: createRotation({ store, host }) };
}
async function runUntil(rotation, state) {
  for (let step; (step = await rotation.run('codex', { steps: 1 })).progressed;) if (step.state === state) return step;
  throw new Error('rotation never reached ' + state);
}

test('without a provable revocation barrier, accepted letters stay pinned to the old generation and never move', async t => {
  for (const behavior of [{ revocationBarrier: false }, { revoke: 'refuse' }, { revoke: 'throw' }, { revoke: 'wrong-session' }]) {
    await t.test(JSON.stringify(behavior), async t => {
      const { store, host, rotation } = await scenario(t, { behavior });
      assert.equal((await rotation.beginIfDue('codex')).ok, true);
      assert.equal((await rotation.run('codex')).done, true, 'the rotation itself still completes for new mail');
      const state = await store.read('codex');
      assert.equal(state.rotations[1].revocation.proven, false);
      assert.deepEqual(state.rotations[1].transfer, { transferred: [], carried: [], pinned: ['open-1', 'open-2'] });
      for (const id of ['open-1', 'open-2']) assert.deepEqual(view(state.claims[id]), ['needs_reconcile', 'revocation_unproven', 1, 'session-1']);
      assert.equal((await dispatchLetter(store, 'codex', mail('open-1'), host)).reason, 'needs_reconcile', 'never redelivered to the new session');
      assert.equal(host.state().submits.filter(x => x.letter === 'open-1').length, 1, 'the old session got it once, nobody else');
      // The old session's own result still closes its letter; the new session cannot.
      assert.equal((await complete(store, 'codex', 'open-1', NEW)).reason, 'not_owner');
      assert.equal((await complete(store, 'codex', 'open-1', OLD)).claim.status, 'done');
      // New mail flows to the new generation regardless.
      assert.equal((await dispatchLetter(store, 'codex', mail('fresh'), host)).claim.owner.generation, 2);
      assert.deepEqual(auditState(await store.read('codex')), []);
    });
  }
});

test('a proven barrier moves each letter by CAS but holds it from the new session until the old one is retired', async t => {
  const { store, host, rotation } = await scenario(t);
  assert.equal((await rotation.beginIfDue('codex')).ok, true);
  await runUntil(rotation, 'switched');
  let state = await store.read('codex');
  assert.deepEqual(state.rotations[1].revocation, { proven: true, barrier: `barrier:session-1:g1`, letters: ['open-1', 'open-2'] });
  assert.deepEqual(host.state().sessions['session-1'].revoked, { generation: 1, letters: ['open-1', 'open-2'] });
  for (const id of ['open-1', 'open-2']) {
    assert.deepEqual([...view(state.claims[id]), state.claims[id].hold], ['reserved', 'transferred', 2, NEXT, 'retire']);
    assert.deepEqual(state.claims[id].transferred_from, OLD);
  }
  assert.equal((await dispatchLetter(store, 'codex', mail('open-1'), host)).reason, 'held', 'not before the old session is retired');
  assert.equal(host.state().submits.filter(x => x.letter === 'open-1').length, 1);
  assert.deepEqual(auditState(state), [], 'a hold is legitimate while the rotation is switched');
  assert.equal((await rotation.run('codex')).done, true);
  state = await store.read('codex');
  assert.equal(state.rotations[1].state, 'retired');
  assert.equal(state.claims['open-1'].hold, undefined);
  assert.deepEqual(state.rotations[1].released, ['open-1', 'open-2']);
  assert.deepEqual(view((await dispatchLetter(store, 'codex', mail('open-1'), host)).claim), ['accepted', undefined, 2, NEXT]);
  assert.deepEqual(auditState(await store.read('codex')), []);
});

test('in manual mode a held letter cannot be taken by the new session either', async t => {
  const { store, rotation } = await scenario(t, { mode: 'manual' });
  assert.equal((await rotation.begin('codex', { reason: 'operator' })).ok, true);
  await runUntil(rotation, 'switched');
  const held = await claimManual(store, 'codex', { id: 'open-1', digest: mail('open-1').digest, session: NEXT });
  assert.deepEqual([held.ok, held.reason], [false, 'held']);
  assert.equal((await rotation.run('codex')).done, true);
  assert.equal((await claimManual(store, 'codex', { id: 'open-1', digest: mail('open-1').digest, session: NEXT })).claim.status, 'accepted');
});

test('a failed retire fails closed: transferred letters go back to their original owner, pinned, never to the new session', async t => {
  const { store, host, rotation } = await scenario(t, { behavior: { retire: 'throw' } });
  assert.equal((await rotation.beginIfDue('codex')).ok, true);
  const halted = await rotation.run('codex');
  assert.deepEqual([halted.halted, halted.failure?.code, halted.state], [true, 'retire_unconfirmed', 'switched']);
  const state = await store.read('codex');
  assert.equal(state.rotations[1].state, 'switched', 'never reported as safely retired');
  assert.equal(state.rotations[1].host_retired, false);
  for (const id of ['open-1', 'open-2']) {
    assert.deepEqual(view(state.claims[id]), ['needs_reconcile', 'retire_unconfirmed', 1, 'session-1']);
    assert.equal(state.claims[id].hold, undefined);
  }
  assert.ok(deriveAlerts(state).some(alert => alert.level === 'error' && alert.kind === 'rotation_retire_unconfirmed'));
  assert.equal((await dispatchLetter(store, 'codex', mail('open-1'), host)).reason, 'needs_reconcile');
  assert.equal(host.state().submits.filter(x => x.session === NEXT && x.letter.startsWith('open-')).length, 0, 'the new session got none of them');
  // The new generation keeps receiving new mail; another rotation waits for the operator.
  assert.equal((await dispatchLetter(store, 'codex', mail('fresh'), host)).claim.owner.generation, 2);
  assert.equal((await rotation.begin('codex', { reason: 'operator' })).reason, 'previous_rotation_unfinished');
  assert.deepEqual(auditState(state), []);
  // An operator who has made sure the old session is gone closes the rotation; the letters stay for reconciliation.
  assert.equal((await rotation.confirmRetired('codex')).ok, true);
  const after = await store.read('codex');
  assert.deepEqual([after.rotations[1].state, after.rotations[1].host_retired], ['retired', 'operator']);
  assert.equal(after.claims['open-1'].status, 'needs_reconcile');
  assert.equal((await resolveUncertain(store, 'codex', 'open-1', { outcome: 'done', expectedVersion: after.claims['open-1'].version })).ok, true);
});

test('a late result from the old generation is evidence only and never completes a letter the new owner holds', async t => {
  const { store, host, rotation } = await scenario(t);
  assert.equal((await rotation.beginIfDue('codex')).ok, true);
  assert.equal((await rotation.run('codex')).done, true);
  const late = await complete(store, 'codex', 'open-1', OLD);
  assert.deepEqual([late.ok, late.reason, late.evidence], [false, 'not_owner', true]);
  let claim = (await store.read('codex')).claims['open-1'];
  assert.deepEqual(claim.late_results.map(x => [x.generation, x.session]), [[1, 'session-1']]);
  assert.equal(claim.status, 'reserved');
  assert.equal((await dispatchLetter(store, 'codex', mail('open-1'), host)).claim.status, 'accepted');
  assert.equal((await complete(store, 'codex', 'open-1', NEW)).claim.status, 'done');
  assert.equal((await complete(store, 'codex', 'open-1', OLD)).reason, 'not_owner', 'still no second completion');
  claim = (await store.read('codex')).claims['open-1'];
  assert.equal(claim.history.filter(entry => entry.status === 'done').length, 1);
});

test('candidate verification compares exact host, workspace, session, authority and handoff values, not boolean echoes', async t => {
  for (const verify of ['wrong-session', 'wrong-host', 'wrong-cwd', 'wrong-authority', 'boolean-tools', 'no-tools']) {
    await t.test(verify, async t => {
      const { store, rotation } = await scenario(t, { behavior: { verify } });
      assert.equal((await rotation.beginIfDue('codex')).ok, true);
      const halted = await rotation.run('codex');
      assert.deepEqual([halted.halted, halted.failure?.code], [true, 'verification_failed']);
      const state = await store.read('codex');
      assert.deepEqual([state.binding.generation, state.binding.session.id, state.rotations[1].state], [1, 'session-1', 'candidate_created']);
      assert.equal(state.claims['open-1'].owner.generation, 1, 'nothing moved to an unverified candidate');
    });
  }
});

test('the verified candidate carries the old binding workspace, and the host was told the exact authority', async t => {
  const { store, host, rotation } = await scenario(t);
  assert.equal((await rotation.beginIfDue('codex')).ok, true);
  assert.equal((await rotation.run('codex')).done, true);
  const state = await store.read('codex');
  assert.deepEqual(state.binding.session, { host: 'fake', id: NEXT, cwd: CWD });
  assert.deepEqual(host.state().sessions[NEXT].authority, AUTHORITY);
  assert.equal(host.state().sessions[NEXT].cwd, CWD);
});
