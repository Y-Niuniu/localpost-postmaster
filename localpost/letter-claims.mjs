import { randomUUID } from 'node:crypto';
import { assertId } from './fs-safe.mjs';
import { MODES, isBinding } from './session-binding.mjs';

/**
 * The per-letter owner ledger, shared by the manual and the automatic consumer of an identity.
 * A claim names the single owner of a letter (generation + session) and where its delivery stands:
 *   reserved → dispatching → accepted → completing → done
 *   completing       write-ahead record of the owner's reply/archive, written before anything is published: a crash
 *                    after publishing leaves it here (never accepted again), the owner's retry finishes it, and a
 *                    rotation never moves it
 *   released         the host said "not received" (or an operator requeued it): may be reserved again
 *   needs_reconcile  uncertain: pinned to its generation, never redelivered on a guess, closed only by
 *                    that generation's own result or by an operator
 * Capacity counts the distinct letters (id + digest) a generation's session holds or may hold:
 * in flight and uncertain ones included, so a session is short of a letter rather than over the limit.
 * Callers claim only letters that will enter a model's context; mail a system answers itself never gets here.
 * The *In functions are pure transitions on a state document; the wrappers run them under the state lock.
 */
const DIGEST = /^[a-f0-9]{64}$/;

export const claimOf = (state, id) => Object.hasOwn(state.claims, id) ? state.claims[id] : undefined;

export function occupancy(state, generation = state.binding.generation) {
  const count = { reserved: 0, dispatching: 0, accepted: 0, completing: 0, done: 0, needs_reconcile: 0 };
  for (const claim of Object.values(state.claims))
    if (claim.owner.generation === generation && Object.hasOwn(count, claim.status)) count[claim.status]++;
  const settled = count.accepted + count.completing + count.done + count.needs_reconcile;
  return { generation, capacity: state.binding.capacity, ...count, settled, total: settled + count.reserved + count.dispatching };
}
// Capacity is the only automatic rotation trigger besides context telemetry. Elapsed time never is.
export const rotationDue = state => occupancy(state).settled >= state.binding.capacity;

function move(claim, status, at, extra = {}) {
  delete claim.reason;
  Object.assign(claim, extra, { status, version: claim.version + 1, updated_at: at });
  claim.history.push({ status, generation: claim.owner.generation, at });
  return claim;
}
const ownerOf = binding => ({ generation: binding.generation, session: binding.session.id });
const refusal = claim => ({ ok: false, reason: claim.status === 'needs_reconcile' ? 'needs_reconcile' : 'duplicate', claim });
function admit(state, { id, digest }) {
  assertId(id);
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new Error('A claim needs the envelope sha256 digest');
  const claim = claimOf(state, id);
  if (state.binding.state !== 'active') return { ok: false, reason: 'frozen' };
  if (claim && claim.digest !== digest) return { ok: false, reason: 'digest_conflict', claim };
  return { ok: true, claim };
}
function open(state, { id, digest }) {
  if (occupancy(state).total >= state.binding.capacity) return { ok: false, reason: 'capacity_full' };
  const claim = claimOf(state, id) ?? (state.claims[id] = { letter: id, digest, version: 0, transfers: 0, attempts: 0, history: [] });
  claim.owner = ownerOf(state.binding);
  return { ok: true, claim };
}

export function reserveIn(state, letter, at) {
  const checked = admit(state, letter);
  if (!checked.ok) return checked;
  const { binding } = state, { claim } = checked;
  if (binding.mode !== 'auto') return { ok: false, reason: 'mode_manual' };
  if (claim?.status === 'reserved') return { ok: true, reused: true, claim };
  if (claim && claim.status !== 'released') return refusal(claim);
  const opened = open(state, letter);
  return opened.ok ? { ok: true, claim: move(opened.claim, 'reserved', at) } : opened;
}

export function beginDispatchIn(state, id, { token, expectedVersion } = {}, at) {
  const { binding } = state, claim = claimOf(state, id);
  if (!claim) return { ok: false, reason: 'not_claimed' };
  if (binding.state !== 'active') return { ok: false, reason: 'frozen', claim };
  if (binding.mode !== 'auto') return { ok: false, reason: 'mode_manual', claim };
  if (claim.status !== 'reserved' || claim.owner.generation !== binding.generation || claim.owner.session !== binding.session.id)
    return { ok: false, reason: 'not_reserved', claim };
  if (claim.hold) return { ok: false, reason: 'held', claim };
  if (expectedVersion !== undefined && claim.version !== expectedVersion) return { ok: false, reason: 'version_conflict', claim };
  claim.attempts += 1;
  move(claim, 'dispatching', at, { attempt: { token, at } });
  return { ok: true, token, generation: binding.generation, session: { ...binding.session }, claim };
}

const SETTLED_AS = { accepted: 'accepted', failed: 'released', uncertain: 'needs_reconcile' };
export function settleIn(state, id, { token, outcome, error } = {}, at) {
  if (!Object.hasOwn(SETTLED_AS, outcome)) throw new Error('A dispatch outcome is accepted, failed or uncertain');
  const claim = claimOf(state, id);
  if (!claim || claim.attempt?.token !== token) return { ok: false, reason: 'stale_attempt' };
  if (claim.status !== 'dispatching') {
    // The attempt was isolated meanwhile: the host's late word is evidence for reconciliation, not a resolution.
    if (claim.status === 'needs_reconcile' && !claim.late) Object.assign(claim, { late: { outcome, at }, version: claim.version + 1 });
    return { ok: false, reason: 'stale_attempt', claim };
  }
  const extra = outcome === 'failed' ? { reason: 'host_rejected' }
    : outcome === 'uncertain' ? { reason: 'dispatch_uncertain', ...(error ? { error: String(error) } : {}) } : {};
  return { ok: true, claim: move(claim, SETTLED_AS[outcome], at, extra) };
}

/** A manual consumer takes a letter into its own context: only the bound session, only in manual mode. */
export function claimManualIn(state, { id, digest, session }, at) {
  const checked = admit(state, { id, digest });
  if (!checked.ok) return checked;
  const { binding } = state, { claim } = checked;
  if (binding.mode !== 'manual') return { ok: false, reason: 'mode_auto' };
  if (session !== binding.session.id) return { ok: false, reason: 'not_bound_session' };
  if (claim?.hold) return { ok: false, reason: 'held', claim };
  const mine = claim?.owner.generation === binding.generation && claim.owner.session === session;
  if (mine && claim.status === 'accepted') return { ok: true, reused: true, claim };
  if (mine && claim.status === 'reserved') return { ok: true, claim: move(claim, 'accepted', at) };
  if (claim && claim.status !== 'released') return refusal(claim);
  const opened = open(state, { id, digest });
  return opened.ok ? { ok: true, claim: move(opened.claim, 'accepted', at) } : opened;
}

/**
 * The owner's terminal result closes a letter; an uncertain one can be closed this way only by its pinned generation.
 * A late result from the generation a letter was transferred away from is kept as reconciliation evidence, never as a
 * completion: two sessions can never both finish one letter.
 */
export function completeIn(state, id, { generation, session } = {}, at) {
  const claim = claimOf(state, id);
  if (!claim) return { ok: false, reason: 'not_claimed' };
  if (claim.owner.generation !== generation || claim.owner.session !== session) {
    if (claim.transferred_from?.generation === generation && claim.transferred_from.session === session) {
      claim.late_results = [...(claim.late_results ?? []), { generation, session, at }];
      claim.version += 1;
      return { ok: false, reason: 'not_owner', evidence: true, claim };
    }
    return { ok: false, reason: 'not_owner', claim };
  }
  if (claim.status === 'done') return { ok: true, reused: true, claim };
  if (!['accepted', 'completing', 'needs_reconcile'].includes(claim.status)) return { ok: false, reason: 'not_accepted', claim };
  return { ok: true, claim: move(claim, 'done', at) };
}

/**
 * Write-ahead step of the owner's reply or archive (mailbox.mjs), persisted before anything is published.
 * The claim stays `completing` until the publication is followed by completeIn, so a crash in between can neither
 * return the letter to `accepted` nor let a rotation move it. The intent is immutable: only the very same operation with
 * the same content (result id + digest) may finish or repeat it - also once the letter is done, or was pinned by a
 * rotation mid-completion. Anything else, and a letter closed without a recorded intent, is a conflict.
 */
export function beginCompletionIn(state, id, { generation, session } = {}, { op, result, digest } = {}, at) {
  if (!['reply', 'archive'].includes(op)) throw new Error('A completion is a reply or an archive');
  const claim = claimOf(state, id);
  if (!claim) return { ok: false, reason: 'not_claimed' };
  if (claim.owner.generation !== generation || claim.owner.session !== session) return { ok: false, reason: 'not_owner', claim };
  const interrupted = claim.status === 'needs_reconcile' && claim.reason === 'completion_interrupted';
  if (['completing', 'done'].includes(claim.status) || interrupted) {
    const recorded = claim.completion;
    const same = recorded !== undefined && recorded.op === op && (recorded.result ?? null) === (result ?? null) &&
      (recorded.digest ?? null) === (digest ?? null);
    if (!same) return { ok: false, reason: 'completion_intent_conflict', claim };
    return interrupted ? { ok: true, claim: move(claim, 'completing', at) } : { ok: true, reused: true, claim };
  }
  if (!['accepted', 'needs_reconcile'].includes(claim.status)) return { ok: false, reason: 'not_accepted', claim };
  const completion = { op, ...(result ? { result } : {}), ...(digest ? { digest } : {}), from: claim.status,
    ...(claim.reason ? { reason: claim.reason } : {}), at };
  return { ok: true, claim: move(claim, 'completing', at, { completion }) };
}

/** Operator reconciliation of an uncertain letter; the operator must name the version they looked at. */
export function resolveUncertainIn(state, id, { outcome, expectedVersion } = {}, at) {
  if (!['done', 'requeue'].includes(outcome)) throw new Error('An operator resolves an uncertain letter as done or requeue');
  const claim = claimOf(state, id);
  if (claim?.status !== 'needs_reconcile') return { ok: false, reason: 'not_uncertain', claim };
  if (claim.version !== expectedVersion) return { ok: false, reason: 'version_conflict', claim };
  return { ok: true, claim: move(claim, outcome === 'done' ? 'done' : 'released', at, { reason: `operator_${outcome}` }) };
}

/** Only an actor-lease holder may call this: every dispatch it finds in flight belongs to a dead actor. */
export function isolateInterruptedIn(state, at, generation) {
  const isolated = [];
  for (const claim of Object.values(state.claims))
    if (claim.status === 'dispatching' && (generation === undefined || claim.owner.generation === generation))
      isolated.push(move(claim, 'needs_reconcile', at, { reason: 'dispatch_interrupted' }).letter);
  return isolated;
}

/**
 * Ownership moves at the switch, letter by letter, each checked against its current status and owner.
 * Reservations that never reached the old session carry over without counting as a transfer.
 * An accepted but unfinished letter is in the old session's hands, so it moves only when the host has proven
 * (`revoked`) that the old session finished its turn and lost the letter; without that proof it stays pinned to
 * its generation for reconciliation. A moved letter goes to the new session once (maxTransfers), and stays held
 * until the host retires the old session (releaseHoldsIn / pinTransfersIn). The handoff text plays no part.
 */
export function transferForSwitchIn(state, from, to, { maxTransfers = 1, revoked = false } = {}, at) {
  const moved = { transferred: [], carried: [], pinned: [] };
  for (const claim of Object.values(state.claims)) {
    if (claim.owner.generation !== from) continue;
    if (claim.status === 'reserved') {
      claim.owner = { ...to };
      moved.carried.push(move(claim, 'reserved', at, { reason: 'carried' }).letter);
    } else if (claim.status === 'accepted' && revoked && claim.transfers < maxTransfers) {
      Object.assign(claim, { transferred_from: { ...claim.owner }, owner: { ...to }, transfers: claim.transfers + 1, hold: 'retire' });
      moved.transferred.push(move(claim, 'reserved', at, { reason: 'transferred' }).letter);
    } else if (['accepted', 'dispatching', 'completing'].includes(claim.status)) {
      // A completion in progress (or cut short by a crash) has already published, or is publishing, the owner's answer.
      const reason = claim.status === 'dispatching' ? 'dispatch_interrupted' : claim.status === 'completing' ? 'completion_interrupted'
        : revoked ? 'transfer_limit' : 'revocation_unproven';
      moved.pinned.push(move(claim, 'needs_reconcile', at, { reason }).letter);
    }
  }
  return moved;
}

/** The host retired the old session: letters moved away from it may now reach their new owner. */
export function releaseHoldsIn(state, letters, at) {
  const released = [];
  for (const id of letters) {
    const claim = claimOf(state, id);
    if (claim?.hold !== 'retire') continue;
    delete claim.hold;
    released.push(move(claim, claim.status, at, { reason: 'hold_released' }).letter);
  }
  return released;
}

/**
 * The old session could not be retired, so it may still act on letters it already had: each held letter goes back
 * to the owner it was moved from, pinned for reconciliation, and never reaches the new session.
 */
export function pinTransfersIn(state, letters, at) {
  const pinned = [];
  for (const id of letters) {
    const claim = claimOf(state, id);
    if (claim?.hold !== 'retire' || !claim.transferred_from) continue;
    delete claim.hold;
    claim.owner = { ...claim.transferred_from };
    pinned.push(move(claim, 'needs_reconcile', at, { reason: 'retire_unconfirmed' }).letter);
  }
  return pinned;
}

export function requestModeIn(state, mode, { expectedVersion, expectedBinding } = {}, at) {
  if (!MODES.includes(mode)) throw new Error('Mode must be manual or auto');
  const { binding } = state;
  // A caller that proved one particular binding switches that binding or nothing: checked first, before any write - also a
  // fresh binding at the same version (ABA) or a pending switch of another binding is left untouched.
  if (expectedBinding !== undefined && !isBinding(binding, expectedBinding)) return { ok: false, reason: 'binding_conflict' };
  if (binding.state === 'frozen') {
    if (binding.frozen?.for === 'mode') return binding.frozen.mode === mode ? { ok: true, existing: true } : { ok: false, reason: 'mode_switch_pending' };
    return { ok: false, reason: 'rotation_in_progress' };
  }
  if (Object.values(state.rotations).some(journal => journal.state !== 'retired')) return { ok: false, reason: 'rotation_in_progress' };
  if (expectedVersion !== undefined && binding.version !== expectedVersion) return { ok: false, reason: 'version_conflict', version: binding.version };
  if (binding.mode === mode) return { ok: true, unchanged: true };
  Object.assign(binding, { state: 'frozen', frozen: { for: 'mode', mode, at }, version: binding.version + 1 });
  return { ok: true, binding };
}

export function completeModeIn(state, at) {
  const { binding } = state;
  if (binding.state !== 'frozen' || binding.frozen?.for !== 'mode') return { ok: false, reason: 'no_mode_switch' };
  const isolated = isolateInterruptedIn(state, at, binding.generation);
  Object.assign(binding, { mode: binding.frozen.mode, state: 'active', frozen: null, version: binding.version + 1 });
  return { ok: true, binding, isolated };
}

export const reserve = (store, identity, letter) => store.update(identity, state => reserveIn(state, letter, store.at()));
export const beginDispatch = (store, identity, id, { expectedVersion } = {}) =>
  store.update(identity, state => beginDispatchIn(state, id, { token: randomUUID(), expectedVersion }, store.at()));
export const settle = (store, identity, id, outcome) => store.update(identity, state => settleIn(state, id, outcome, store.at()));
export const claimManual = (store, identity, request) => store.update(identity, state => claimManualIn(state, request, store.at()));
export const complete = (store, identity, id, owner) => store.update(identity, state => completeIn(state, id, owner, store.at()));
export const beginCompletion = (store, identity, id, owner, intent) =>
  store.update(identity, state => beginCompletionIn(state, id, owner, intent, store.at()));
export const resolveUncertain = (store, identity, id, decision) => store.update(identity, state => resolveUncertainIn(state, id, decision, store.at()));
export const requestMode = (store, identity, mode, options) => store.update(identity, state => requestModeIn(state, mode, options, store.at()));

/** Run by a fresh actor-lease holder: isolates dead in-flight dispatches and finishes a pending mode switch. */
export const recoverClaims = (store, identity) => store.update(identity, state => {
  const at = store.at();
  if (state.binding.state === 'frozen' && state.binding.frozen?.for === 'mode') return completeModeIn(state, at);
  return { ok: true, isolated: isolateInterruptedIn(state, at) };
});

/** Manual ⇄ auto goes through freeze → drain → CAS, under the actor lease so no dispatch is in flight. */
export function switchMode(store, identity, mode, options = {}) {
  return store.withActor(identity, async () => {
    const requested = await requestMode(store, identity, mode, options);
    return !requested.ok || requested.unchanged ? requested : recoverClaims(store, identity);
  });
}

/**
 * Reserve → write-ahead `dispatching` → host.submit → settle, all under the actor lease.
 * host.submit must answer { accepted: true }, or { accepted: false, definitive: true }, or throw; anything else
 * is uncertain and isolates the letter rather than retrying it (at most one wake-up per letter and generation).
 * The idempotency key names the generation, so a transferred letter is not deduplicated away from its new session.
 */
export function dispatchLetter(store, identity, letter, host) {
  return store.withActor(identity, async () => {
    await recoverClaims(store, identity);
    const reserved = await reserve(store, identity, letter);
    if (!reserved.ok) return reserved;
    const begun = await beginDispatch(store, identity, letter.id, { expectedVersion: reserved.claim.version });
    if (!begun.ok) return begun;
    let outcome = 'uncertain', error;
    try {
      const receipt = await host.submit({ identity, session: begun.session, letter: { id: letter.id, digest: letter.digest },
        key: `${identity}:${letter.id}:g${begun.generation}` });
      if (receipt?.accepted === true) outcome = 'accepted';
      else if (receipt?.accepted === false && receipt.definitive === true) outcome = 'failed';
    } catch (cause) { error = cause.message; }
    return settle(store, identity, letter.id, { token: begun.token, outcome, error });
  });
}
