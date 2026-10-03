import fsp from 'node:fs/promises';
import path from 'node:path';
import { acquireLease, atomicWrite, assertId, safePath } from './fs-safe.mjs';

/**
 * One state document per identity, `runtime/sessions/<identity>.json`:
 *   binding    the single source of truth for which session receives this identity's mail
 *              (generation + session + mode + capacity + trusted authority), versioned for CAS;
 *   claims     the per-letter owner ledger (letter-claims.mjs);
 *   rotations  one journal per rotated-out generation (rotation.mjs);
 *   context    context-pressure samples of the current session (context-trigger.mjs).
 * Every change is read-check-write under the identity's state lock and lands as one atomic write,
 * so a crash leaves the previous or the next document, never a mix of both.
 * Work that talks to a host additionally holds the identity's actor lease, which makes any
 * in-flight record found by the next actor provably interrupted.
 */
export const STATE_SCHEMA = 'localpost-session-state-v1';
export const MODES = Object.freeze(['manual', 'auto']);
export const CLAIM_STATUSES = Object.freeze(['reserved', 'dispatching', 'accepted', 'completing', 'done', 'released', 'needs_reconcile']);
export const ROTATION_STATES = Object.freeze(['active', 'frozen', 'drained', 'handoff_written', 'candidate_created', 'verified', 'switched', 'retired']);
// The only scope a binding can carry. Implementation authority is never part of a binding or a handoff.
export const ANALYSIS_REPLY = 'analysis-reply';

/**
 * What makes a binding THIS binding, for compare-and-swap. A version alone is not enough: when the record is removed and a
 * chat binds afresh, the new binding starts at the same version (ABA). So the identity also names the generation, the
 * session (host, id, workspace), when it was bound and the attested bind action.
 */
export const bindingIdentity = binding => ({
  version: binding.version, generation: binding.generation,
  session: { host: binding.session.host, id: binding.session.id, cwd: binding.session.cwd ?? null },
  since: binding.since ?? null, attestation: binding.attestation?.actionId ?? null,
});
export function isBinding(binding, expected) {
  const now = bindingIdentity(binding);
  return now.version === expected?.version && now.generation === expected.generation && now.session.host === expected.session?.host &&
    now.session.id === expected.session?.id && now.session.cwd === (expected.session?.cwd ?? null) &&
    now.since === (expected.since ?? null) && now.attestation === (expected.attestation ?? null);
}

const failure = (code, message) => Object.assign(new Error(message), { code });
const text = value => typeof value === 'string' && value.trim() !== '';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const validSession = session => record(session) && text(session.host) && text(session.id) && (session.cwd === undefined || text(session.cwd));
const validClaim = (id, claim) => record(claim) && claim.letter === id && typeof claim.digest === 'string' &&
  CLAIM_STATUSES.includes(claim.status) && Number.isSafeInteger(claim.version) && Number.isSafeInteger(claim.owner?.generation) &&
  text(claim.owner.session) && Array.isArray(claim.history);
const validJournal = (key, journal) => record(journal) && String(journal.generation) === key &&
  ROTATION_STATES.includes(journal.state) && validSession(journal.from) && Array.isArray(journal.history);
// The host's confirmation of the user's explicit bind action in one chat (binding-provider.mjs).
const validAttestation = a => a === undefined || (record(a) && a.kind === 'chat-action' &&
  [a.actionId, a.hostId, a.threadId, a.cwd, a.at].every(text));

// Windows refuses to open a lock file while its holder is deleting it: acquireLease then throws EPERM/EACCES/EBUSY
// or reports an invalid owner (reproduced under contention, 2026-10-02). Those refusals are transient, so callers
// below retry them within a bound and report the last reason as it is; nothing is ever stolen or assumed.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function tryLease(root, options) {
  try { return await acquireLease(root, options); }
  catch (error) { if (TRANSIENT.has(error.code)) return { acquired: false, reason: `transient_${error.code}` }; throw error; }
}
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

export function validateState(state, identity) {
  const binding = state?.binding;
  const valid = record(state) && state.schema === STATE_SCHEMA && state.identity === identity && Number.isSafeInteger(state.revision) &&
    record(binding) && Number.isSafeInteger(binding.version) && binding.version >= 1 &&
    Number.isSafeInteger(binding.generation) && binding.generation >= 1 && MODES.includes(binding.mode) &&
    ['active', 'frozen'].includes(binding.state) && Number.isSafeInteger(binding.capacity) && binding.capacity >= 1 &&
    validSession(binding.session) && binding.authority?.scope === ANALYSIS_REPLY && validAttestation(binding.attestation) &&
    record(state.claims) && Object.entries(state.claims).every(([id, claim]) => validClaim(id, claim)) &&
    record(state.rotations) && Object.entries(state.rotations).every(([key, journal]) => validJournal(key, journal));
  if (!valid) throw failure('STATE_NEEDS_RECONCILE', `Session state for ${identity} is invalid and needs reconciliation`);
  return state;
}

export function createSessionStore({ root, now = () => Date.now(), staleMs = 60000, waitMs = 5000 } = {}) {
  if (!root) throw new Error('session store root is required');
  root = path.resolve(root);
  const file = identity => safePath(root, `runtime/sessions/${assertId(identity)}.json`);
  const at = () => new Date(now()).toISOString();

  async function read(identity) {
    let raw;
    try { raw = await fsp.readFile(file(identity), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let state;
    try { state = JSON.parse(raw); }
    catch { throw failure('STATE_NEEDS_RECONCILE', `Session state for ${identity} is not JSON and needs reconciliation`); }
    return validateState(state, identity);
  }
  async function locked(identity, operation) {
    const started = Date.now();
    for (;;) {
      const lease = await tryLease(root, { name: `.session-${identity}.lock`, staleMs, now: now() });
      if (lease.acquired) { try { return await operation(); } finally { await lease.release(); } }
      if (Date.now() - started > waitMs) throw failure('LOCK_UNAVAILABLE', `Session state lock unavailable: ${lease.reason}`);
      await pause();
    }
  }
  async function persist(identity, previous, next) {
    next.revision = (previous?.revision ?? 0) + 1;
    next.updated_at = at();
    validateState(next, identity);
    await atomicWrite(file(identity), JSON.stringify(next, null, 2) + '\n');
  }

  return {
    root, now, at, read,
    // mutate(draft) must be synchronous and must not talk to a host; the draft is written only if it changed.
    update(identity, mutate) {
      assertId(identity);
      return locked(identity, async () => {
        const current = await read(identity);
        if (!current) return { ok: false, reason: 'unbound' };
        const draft = structuredClone(current);
        const result = mutate(draft);
        if (JSON.stringify(draft) !== JSON.stringify(current)) await persist(identity, current, draft);
        return result;
      });
    },
    create(identity, build) {
      assertId(identity);
      return locked(identity, async () => {
        const current = await read(identity);
        if (current) return { created: false, state: current };
        const state = build();
        await persist(identity, null, state);
        return { created: true, state };
      });
    },
    // A live actor is skipped at once, never waited on (the next scan tries again); a lease caught mid-release is retried briefly.
    async withActor(identity, operation) {
      assertId(identity);
      const started = Date.now();
      for (;;) {
        const lease = await tryLease(root, { name: `.session-actor-${identity}.lock`, staleMs, now: now() });
        if (lease.acquired) { try { return await operation(); } finally { await lease.release(); } }
        if (lease.reason === 'busy' || Date.now() - started > 250) return { ok: false, skipped: true, reason: `actor_${lease.reason}` };
        await pause();
      }
    },
  };
}

/** The explicit, user-made binding of an identity to one session. Repeating it verbatim is a no-op; anything else is a conflict. */
export async function bind(store, identity, { session, mode = 'manual', capacity = 50, authority, source, attestation } = {}) {
  assertId(identity);
  if (!validSession(session)) throw new Error('A binding needs an explicit session { host, id }');
  if (!MODES.includes(mode)) throw new Error('Binding mode must be manual or auto');
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Binding capacity must be a positive integer');
  if (authority?.scope !== ANALYSIS_REPLY || !text(authority.source)) throw new Error('Binding authority must be the trusted analysis-reply policy');
  if (!text(source)) throw new Error('A binding must record who made it');
  const created = await store.create(identity, () => {
    const since = store.at();
    return {
      schema: STATE_SCHEMA, identity, revision: 0,
      binding: { version: 1, generation: 1, session: { ...session }, mode, state: 'active', frozen: null, capacity,
        authority: { scope: authority.scope, source: authority.source }, source, since,
        ...(attestation ? { attestation: { kind: 'chat-action', ...attestation, at: since } } : {}) },
      claims: {}, context: null, rotations: {},
    };
  });
  const { binding } = created.state;
  if (created.created) return { ok: true, binding };
  const same = binding.generation === 1 && binding.session.host === session.host && binding.session.id === session.id &&
    binding.session.cwd === session.cwd && binding.mode === mode && binding.capacity === capacity &&
    binding.authority.source === authority.source && binding.source === source;
  return same ? { ok: true, existing: true, binding } : { ok: false, reason: 'already_bound', binding };
}
