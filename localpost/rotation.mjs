import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { atomicWrite, assertId, safePath } from './fs-safe.mjs';
import { ROTATION_STATES } from './session-binding.mjs';
import { occupancy, rotationDue, isolateInterruptedIn, transferForSwitchIn, recoverClaims } from './letter-claims.mjs';

export { ROTATION_STATES };

/**
 * Rotation of one identity from generation g to g+1, journaled in rotations[g]:
 *   active → frozen → drained → handoff_written → candidate_created → verified → switched → retired
 * Each arrow is one persisted write and a crash resumes from the last one. A failing step records a
 * visible failure and stops: plain retries happen on the next run; an unprovable or rejected candidate and
 * a binding changed behind the rotation wait for an operator. Nothing here guesses a session: the candidate
 * id derives from (identity, generation, attempt), so a retry cannot create a second session.
 * The handoff only describes state. Letters change owner solely by the per-letter CAS at the switch, and
 * authority is copied from the trusted binding record, never read from the handoff.
 *
 * Host adapter (all asynchronous; a throw means "outcome unknown"):
 *   createSession({ id, identity, generation, handoff }) → { created: true, session? } | { created: false, definitive: true }
 *   findSession(id) → { exists }      capabilities.lookupAuthoritative: is "absent" proof that it was never created?
 *   verifySession(id, expected) → { identity, generation, handoffDigest, tools, crossIdentityRejected }
 *   retireSession(id)                  optional, best effort: the ledger stops all mail to the old session anyway
 */
const REASONS = ['capacity', 'context', 'operator'];
const sha256 = text => createHash('sha256').update(text).digest('hex');

export function candidateSessionId(identity, generation, attempt) {
  assertId(identity);
  const hex = [...sha256(`localpost-rotation:${identity}:${generation}:${attempt}`).slice(0, 32)];
  hex[12] = '8'; // UUIDv8: deterministic, application-defined
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16); // RFC 4122 variant
  const id = hex.join('');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export const openRotation = state => Object.values(state.rotations).find(journal => journal.state !== 'retired');

function beginIn(state, { reason, expectedVersion }, at) {
  const { binding } = state, current = openRotation(state);
  if (current) return current.generation === binding.generation ? { ok: true, existing: true, journal: current } : { ok: false, reason: 'previous_rotation_unfinished' };
  if (binding.state === 'frozen') return { ok: false, reason: 'mode_switch_pending' };
  if (expectedVersion !== undefined && binding.version !== expectedVersion) return { ok: false, reason: 'version_conflict', version: binding.version };
  Object.assign(binding, { state: 'frozen', frozen: { for: 'rotation', generation: binding.generation, at }, version: binding.version + 1 });
  const journal = state.rotations[binding.generation] = {
    generation: binding.generation, next: binding.generation + 1, reason, from: { ...binding.session }, binding_version: binding.version,
    state: 'frozen', history: [{ state: 'active', at: binding.since }, { state: 'frozen', at }],
    handoff: null, candidate: null, abandoned: [], failure: null,
  };
  return { ok: true, journal };
}

function handoffFacts(state, generation) {
  const own = Object.values(state.claims).filter(claim => claim.owner.generation === generation).sort((a, b) => a.letter.localeCompare(b.letter));
  const having = status => own.filter(claim => claim.status === status);
  return {
    unfinished: having('accepted').map(({ letter, digest, version }) => ({ id: letter, digest, version })),
    carried: having('reserved').map(({ letter, digest }) => ({ id: letter, digest })),
    needs_reconcile: having('needs_reconcile').map(({ letter, digest, reason }) => ({ id: letter, digest, reason })),
  };
}
const composeHandoff = (state, journal, notes, at, cause) => ({
  schema: 'localpost-handoff-v1', identity: state.identity,
  from_generation: journal.generation, to_generation: journal.next, from_session: journal.from.id,
  written_at: at, mechanical: notes === null, ...(cause ? { cause } : {}),
  ownership: 'descriptive_only: a letter changes owner only by the ledger CAS at the switch, never by this document',
  authority: { ...state.binding.authority, implementation: 'not_granted_by_handoff' },
  ...handoffFacts(state, journal.generation),
  notes_untrusted: notes,
});

export function createRotation({ store, host, handoffWriter, maxTransfers = 1 } = {}) {
  if (!store || !host) throw new Error('A rotation needs a session store and a host adapter');

  // One guarded write: it acts only while the journal is still in the state this step started from.
  const step = (identity, generation, from, change) => store.update(identity, state => {
    const journal = Object.hasOwn(state.rotations, generation) ? state.rotations[generation] : undefined;
    if (journal?.state !== from) return { progressed: false, reason: 'journal_moved', state: journal?.state };
    const at = store.at(), outcome = change(state, journal, at) ?? {};
    if (outcome.failure) {
      journal.failure = { step: from, ...outcome.failure, at };
      return { progressed: false, failed: true, halted: outcome.failure.needs === 'operator', state: from, failure: journal.failure };
    }
    journal.failure = null;
    if (outcome.to) { journal.state = outcome.to; journal.history.push({ state: outcome.to, at }); }
    return { progressed: true, state: journal.state, ...outcome.detail };
  });
  const fail = (identity, generation, from, code, needs, error) => step(identity, generation, from, () =>
    ({ failure: { code, needs, ...(error ? { message: String(error.message ?? error) } : {}) } }));
  const journalOf = async (identity, generation) => (await store.read(identity)).rotations[generation];

  async function publishHandoff(identity, generation, notes, cause) {
    const state = await store.read(identity);
    const file = `runtime/handoffs/${identity}/g${generation}.json`;
    const text = JSON.stringify(composeHandoff(state, state.rotations[generation], notes, store.at(), cause), null, 2) + '\n';
    await atomicWrite(safePath(store.root, file), text);
    return { file, digest: sha256(text), mechanical: notes === null, rewrites: 0 };
  }
  async function writeHandoff(identity, state, journal) {
    let notes = null;
    if (handoffWriter) {
      try { notes = await handoffWriter({ identity, generation: journal.generation, session: { ...journal.from }, facts: handoffFacts(state, journal.generation) }); }
      catch { notes = null; } // the old session cannot write: the ledger supplies a mechanical handoff
    }
    if (typeof notes !== 'string' || !notes.trim()) notes = null;
    const handoff = await publishHandoff(identity, journal.generation, notes);
    return step(identity, journal.generation, 'drained', (draft, j) => { j.handoff = handoff; return { to: 'handoff_written' }; });
  }
  // A summary that no longer matches its recorded digest is replaced by a mechanical one before anyone relies on it.
  async function ensureHandoff(identity, generation) {
    const journal = await journalOf(identity, generation);
    let text = null;
    try { text = await fsp.readFile(safePath(store.root, journal.handoff.file), 'utf8'); } catch {}
    if (text !== null && sha256(text) === journal.handoff.digest) return { ok: true, handoff: journal.handoff };
    const fresh = await publishHandoff(identity, generation, null, 'handoff_corrupt');
    const recorded = await step(identity, generation, journal.state, (draft, j) => {
      j.handoff = { ...fresh, rewrites: j.handoff.rewrites + 1, replaced: [...(j.handoff.replaced ?? []), j.handoff.digest] };
    });
    return recorded.progressed ? { ok: true, handoff: (await journalOf(identity, generation)).handoff } : { ok: false, result: recorded };
  }

  const markCreated = (identity, generation, id, session) => step(identity, generation, 'handoff_written', (draft, j) => {
    if (j.candidate?.id !== id || (session && session.id !== id)) return { failure: { code: 'candidate_mismatch', needs: 'operator' } };
    j.candidate.status = 'created';
    j.candidate.session = { host: session?.host ?? j.from.host, id };
    return { to: 'candidate_created' };
  });
  // The host is asked, never assumed: found → created; absent → create again only if "absent" is authoritative (null).
  async function lookupCandidate(identity, generation, id, cause) {
    let found;
    try { found = await host.findSession(id); }
    catch (error) { return fail(identity, generation, 'handoff_written', 'candidate_lookup_failed', 'retry', error); }
    if (found?.exists === true) return markCreated(identity, generation, id, found.session);
    if (host.capabilities?.lookupAuthoritative === true) return null;
    return fail(identity, generation, 'handoff_written', 'candidate_uncertain', 'operator', cause ?? 'the host cannot prove the candidate was never created');
  }
  async function createCandidate(identity, journal) {
    const g = journal.generation;
    let { candidate } = journal, resumed = candidate?.status === 'requested';
    if (!candidate || candidate.status === 'refused') {
      const attempt = candidate?.attempt ?? journal.abandoned.length + 1;
      candidate = { id: candidateSessionId(identity, journal.next, attempt), attempt, status: 'requested' };
      const requested = await step(identity, g, 'handoff_written', (draft, j, at) => { j.candidate = { ...candidate, at }; });
      if (!requested.progressed) return requested;
    }
    const checked = await ensureHandoff(identity, g);
    if (!checked.ok) return checked.result;
    if (resumed) {
      // An earlier request may or may not have reached the host.
      const known = await lookupCandidate(identity, g, candidate.id);
      if (known) return known;
    }
    let created;
    try {
      created = await host.createSession({ id: candidate.id, identity, generation: journal.next,
        handoff: { file: checked.handoff.file, digest: checked.handoff.digest } });
    } catch (error) {
      return await lookupCandidate(identity, g, candidate.id, error) ?? fail(identity, g, 'handoff_written', 'candidate_create_uncertain', 'retry', error);
    }
    if (created?.created === true) return markCreated(identity, g, candidate.id, created.session);
    if (created?.created === false && created.definitive === true) return step(identity, g, 'handoff_written', (draft, j) => {
      j.candidate.status = 'refused'; // nothing was created: the same id is safe to request again
      return { failure: { code: 'candidate_create_failed', needs: 'retry', message: String(created.reason ?? 'host refused') } };
    });
    return await lookupCandidate(identity, g, candidate.id) ?? fail(identity, g, 'handoff_written', 'candidate_create_uncertain', 'retry');
  }

  async function verifyCandidate(identity, journal) {
    const g = journal.generation;
    const checked = await ensureHandoff(identity, g);
    if (!checked.ok) return checked.result;
    const expected = { identity, generation: journal.next, handoffDigest: checked.handoff.digest };
    let echo;
    try { echo = await host.verifySession(journal.candidate.id, expected); }
    catch (error) { return fail(identity, g, 'candidate_created', 'verify_unavailable', 'retry', error); }
    const verified = echo?.identity === expected.identity && echo.generation === expected.generation &&
      echo.handoffDigest === expected.handoffDigest && echo.tools === true && echo.crossIdentityRejected === true;
    return step(identity, g, 'candidate_created', (draft, j) => {
      if (!verified) { j.candidate.status = 'rejected'; return { failure: { code: 'verification_failed', needs: 'operator' } }; }
      j.candidate.status = 'verified';
      return { to: 'verified' };
    });
  }

  const switchOver = (identity, journal) => step(identity, journal.generation, 'verified', (state, j, at) => {
    const { binding } = state;
    if (binding.generation !== j.generation || binding.state !== 'frozen' || binding.frozen?.for !== 'rotation' ||
        binding.version !== j.binding_version || binding.session.id !== j.from.id)
      return { failure: { code: 'switch_conflict', needs: 'operator', message: 'the binding changed while the rotation was in progress' } };
    const session = j.candidate.session;
    const transfer = transferForSwitchIn(state, j.generation, { generation: j.next, session: session.id }, { maxTransfers }, at);
    Object.assign(binding, { version: binding.version + 1, generation: j.next, session: { ...session }, state: 'active', frozen: null,
      source: `rotation:${state.identity}:g${j.generation}`, since: at });
    state.context = null;
    j.transfer = transfer;
    return { to: 'switched', detail: transfer };
  });

  async function retire(identity, journal) {
    let retired = 'not_supported', error;
    if (typeof host.retireSession === 'function') {
      try { await host.retireSession(journal.from.id); retired = true; }
      catch (cause) { retired = false; error = String(cause.message ?? cause); }
    }
    return step(identity, journal.generation, 'switched', (draft, j) => {
      j.host_retired = retired;
      if (error) j.retire_error = error;
      return { to: 'retired' };
    });
  }

  async function advance(identity) {
    const state = await store.read(identity);
    if (!state) return { progressed: false, reason: 'unbound' };
    const journal = openRotation(state);
    if (!journal) return { progressed: false, done: true };
    if (journal.failure?.needs === 'operator') return { progressed: false, halted: true, state: journal.state, failure: journal.failure };
    const g = journal.generation;
    switch (journal.state) {
      case 'frozen': return step(identity, g, 'frozen', (draft, j, at) => ({ to: 'drained', detail: { isolated: isolateInterruptedIn(draft, at, g) } }));
      case 'drained': return writeHandoff(identity, state, journal);
      case 'handoff_written': return createCandidate(identity, journal);
      case 'candidate_created': return verifyCandidate(identity, journal);
      case 'verified': return switchOver(identity, journal);
      case 'switched': return retire(identity, journal);
      default: return { progressed: false, halted: true, reason: 'unknown_rotation_state', state: journal.state };
    }
  }

  return {
    begin(identity, { reason, expectedVersion } = {}) {
      if (!REASONS.includes(reason)) throw new Error('A rotation reason is capacity, context or operator');
      return store.update(identity, state => beginIn(state, { reason, expectedVersion }, store.at()));
    },
    beginIfDue: identity => store.update(identity, state => rotationDue(state) ? beginIn(state, { reason: 'capacity' }, store.at()) : { ok: false, reason: 'not_due' }),
    /** Drives the open rotation (after crash recovery) until it finishes, fails, or runs `steps` steps. */
    run(identity, { steps = 32 } = {}) {
      return store.withActor(identity, async () => {
        await recoverClaims(store, identity);
        let result = { progressed: false };
        for (let i = 0; i < steps; i++) {
          result = await advance(identity);
          if (!result.progressed) break;
        }
        return result;
      });
    },
    /** Operator decision after an unprovable or rejected candidate: abandon it and derive the next attempt's id. */
    retryCandidate: identity => store.update(identity, state => {
      const journal = openRotation(state);
      if (!journal?.candidate || !['handoff_written', 'candidate_created'].includes(journal.state) || journal.failure?.needs !== 'operator' ||
          !['requested', 'rejected'].includes(journal.candidate.status)) return { ok: false, reason: 'no_candidate_awaiting_operator' };
      const at = store.at();
      journal.abandoned.push({ id: journal.candidate.id, attempt: journal.candidate.attempt, status: journal.candidate.status, at });
      Object.assign(journal, { candidate: null, failure: null });
      if (journal.state === 'candidate_created') {
        journal.state = 'handoff_written';
        journal.history.push({ state: 'handoff_written', at, by: 'operator_retry' });
      }
      return { ok: true, attempt: journal.abandoned.length + 1 };
    }),
  };
}

/** Alerts are derived from the state, never stored beside it: fixing the state clears them. */
export function deriveAlerts(state) {
  const alerts = [];
  for (const journal of Object.values(state.rotations)) {
    if (journal.failure) alerts.push({ level: journal.failure.needs === 'operator' ? 'error' : 'warn', kind: `rotation_${journal.failure.code}`, generation: journal.generation, step: journal.failure.step });
    // Notes about the most recent rotation stay visible until the next one.
    if (journal.state !== 'retired' || journal.next === state.binding.generation) {
      if (journal.handoff?.rewrites > 0) alerts.push({ level: 'warn', kind: 'handoff_regenerated', generation: journal.generation });
      if (journal.host_retired === false) alerts.push({ level: 'warn', kind: 'host_retire_failed', generation: journal.generation, session: journal.from.id });
    }
  }
  for (const claim of Object.values(state.claims))
    if (claim.status === 'needs_reconcile') alerts.push({ level: claim.reason === 'transfer_limit' ? 'error' : 'warn', kind: 'needs_reconcile', id: claim.letter, generation: claim.owner.generation, reason: claim.reason });
  if (rotationDue(state) && !openRotation(state)) alerts.push({ level: 'warn', kind: 'rotation_due', generation: state.binding.generation });
  return alerts;
}

/** Invariants every test (and any operator) can check after any crash or recovery; [] means consistent. */
export function auditState(state) {
  const problems = [], { binding } = state, journals = Object.values(state.rotations);
  const sessionOf = new Map(journals.map(journal => [journal.generation, journal.from.id]));
  sessionOf.set(binding.generation, binding.session.id);
  if (occupancy(state).total > binding.capacity) problems.push('capacity_exceeded');
  const open = journals.filter(journal => journal.state !== 'retired');
  if (open.length > 1) problems.push('several_open_rotations');
  if (binding.frozen?.for === 'rotation' && open[0]?.generation !== binding.generation) problems.push('frozen_without_rotation');
  if (new Set(journals.map(journal => journal.candidate?.id).filter(Boolean)).size !== journals.filter(journal => journal.candidate).length) problems.push('candidate_reused');
  for (const claim of Object.values(state.claims)) {
    const { generation, session } = claim.owner;
    if (generation > binding.generation) problems.push(`future_owner:${claim.letter}`);
    else if (sessionOf.get(generation) !== session) problems.push(`owner_session_mismatch:${claim.letter}`);
    if (['reserved', 'dispatching', 'accepted'].includes(claim.status) && generation !== binding.generation) problems.push(`stale_owner:${claim.letter}`);
  }
  return problems;
}
