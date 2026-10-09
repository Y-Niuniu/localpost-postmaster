import { assertId } from './fs-safe.mjs';
import { ANALYSIS_REPLY, bind } from './session-binding.mjs';
import { takeOver } from './letter-claims.mjs';

/**
 * Explicit binding of an identity's automatic mail to one host chat. It replaces the old "trusted focus":
 * DSH has no API for "the chat the user is looking at", and nothing here guesses a latest, visible or
 * recently modified chat. A binding exists only because the user ran the bind action inside chat A and the
 * host confirmed that very action; it is kept in the identity's session state (session-binding.mjs).
 *
 * Host contract (asynchronous; without it the provider is not trusted and automatic dispatch stays disabled).
 * The installed DSH rc.2 provides none of it - see docs/rotation-decisions.md §3:
 *   capabilities.chatBinding === true
 *   confirmBindAction(action) → { confirmed: true, actionId, hostId, threadId, cwd }   the user's action in chat A
 *   describeThread(threadId)  → { hostId, threadId, cwd, online }                       what the host sees now
 */
const failure = (code, message) => Object.assign(new Error(message), { code });
const text = value => typeof value === 'string' && value.trim() !== '';
const sameSession = (a, b) => a?.host === b?.host && a?.id === b?.id && (a?.cwd ?? null) === (b?.cwd ?? null);

/** The host's confirmation of every value of the user's action, or the refusal to return instead. */
async function confirmAction(host, action) {
  if (host?.capabilities?.chatBinding !== true || typeof host.confirmBindAction !== 'function') return { ok: false, reason: 'host_cannot_attest' };
  let confirmed;
  try { confirmed = await host.confirmBindAction(action); }
  catch (error) { return { ok: false, reason: 'attestation_unavailable', message: String(error.message ?? error) }; }
  const exact = confirmed?.confirmed === true && [action?.actionId, action?.hostId, action?.threadId, action?.cwd].every(text) &&
    confirmed.actionId === action.actionId && confirmed.hostId === action.hostId &&
    confirmed.threadId === action.threadId && confirmed.cwd === action.cwd;
  return exact ? { ok: true } : { ok: false, reason: 'attestation_mismatch' };
}

/** Binds `identity` to the chat in which the user performed `action`; the host must confirm every value of it. */
export async function bindFromChatAction(store, identity, { host, action, capacity = 50, authority } = {}) {
  assertId(identity);
  const confirmed = await confirmAction(host, action);
  if (!confirmed.ok) return confirmed;
  return bind(store, identity, {
    session: { host: action.hostId, id: action.threadId, cwd: action.cwd }, mode: 'auto', capacity, authority,
    source: `chat-action:${action.actionId}`,
    attestation: { actionId: action.actionId, hostId: action.hostId, threadId: action.threadId, cwd: action.cwd },
  });
}

/**
 * Moves `identity`'s mail to the chat in which the user performed `action` (letter-claims.mjs takeOverIn), when it is bound
 * to another chat now. `expectedBinding` names the binding the caller saw: if it moved since, nothing changes.
 * `force` also moves letters the old chat has not finished. A live actor answers `{ skipped: true }`: try again shortly.
 */
export async function takeOverFromChatAction(store, identity, { host, action, authority, expectedBinding, force = false } = {}) {
  assertId(identity);
  if (authority?.scope !== ANALYSIS_REPLY || !text(authority.source)) throw new Error('Binding authority must be the trusted analysis-reply policy');
  const confirmed = await confirmAction(host, action);
  if (!confirmed.ok) return confirmed;
  return takeOver(store, identity, {
    session: { host: action.hostId, id: action.threadId, cwd: action.cwd }, authority, source: `chat-action:${action.actionId}`,
    attestation: { actionId: action.actionId, hostId: action.hostId, threadId: action.threadId, cwd: action.cwd },
    expectedBinding, force,
  });
}

/**
 * The current binding is attested when its generation goes back, rotation by verified rotation, to the
 * generation-1 session the user's chat action named. A record edited by hand breaks that chain.
 */
export function attestedNow(state) {
  const { binding } = state;
  let generation = binding.generation, session = binding.session;
  while (generation > 1) {
    const journal = state.rotations[generation - 1];
    if (!journal || journal.next !== generation || !['switched', 'retired'].includes(journal.state) ||
        journal.candidate?.status !== 'verified' || journal.candidate.session?.id !== session.id) return false;
    session = journal.from;
    generation -= 1;
  }
  const a = binding.attestation;
  return a?.kind === 'chat-action' && sameSession({ host: a.hostId, id: a.threadId, cwd: a.cwd }, session);
}

/**
 * The arrival route a letter keeps for good: the binding as it stands when the letter is delivered. The controlled
 * delivery records it in the same write-lock section that publishes the letter (mailbox.mjs), so a later rebinding
 * reaches only later mail. Only an attested automatic binding routes mail (a rotation in progress included: the
 * route follows its lineage); anything else leaves the letter with the manual consumer. The host is asked at dispatch.
 */
export function arrivalRoute(state) {
  const { binding } = state;
  if (binding.mode !== 'auto') return { route: null, reason: 'binding_manual' };
  if (!attestedNow(state)) return { route: null, reason: 'binding_unattested' };
  if (!text(binding.session.cwd)) return { route: null, reason: 'binding_incomplete' };
  return { route: Object.freeze({ identity: state.identity, hostId: binding.session.host, threadId: binding.session.id, cwd: binding.session.cwd,
    generation: binding.generation, bindingRevision: binding.version, boundAt: binding.since, attestation: binding.attestation.actionId }) };
}

export function createBindingProvider({ store, identity, host } = {}) {
  assertId(identity);
  const trusted = host?.capabilities?.chatBinding === true && typeof host.describeThread === 'function';
  const current = async () => {
    const state = await store.read(identity);
    if (!state) throw failure('binding_missing', `${identity} has no explicit binding`);
    return state;
  };
  return {
    trusted,
    /**
     * Where a letter that arrived under `route` goes now: the same binding, its successor by completed rotations, or the
     * binding that took it over at the user's request (takeOverIn remembers the bind action of every binding it replaced).
     * Any other change of the session - the record removed and bound afresh - never captures mail that arrived before it.
     */
    async resolve(route) {
      if (route?.identity !== identity || !Number.isSafeInteger(route.generation) || route.generation < 1 ||
          ![route.hostId, route.threadId, route.cwd].every(text)) return { ok: false, reason: 'route_invalid' };
      const state = await store.read(identity);
      if (!state) return { ok: false, reason: 'unbound' };
      const { binding } = state;
      const current = () => ({ identity, hostId: binding.session.host, threadId: binding.session.id, cwd: binding.session.cwd, generation: binding.generation });
      if (text(route.attestation) && (binding.replaced ?? []).some(entry => entry?.attestation === route.attestation)) {
        if (binding.state !== 'active') return { ok: false, reason: 'binding_frozen' };
        return { ok: true, target: current() };
      }
      if (route.generation > binding.generation) return { ok: false, reason: 'route_from_future' };
      let generation = route.generation, session = { host: route.hostId, id: route.threadId, cwd: route.cwd };
      while (generation < binding.generation) {
        const journal = state.rotations[generation];
        if (!journal || !sameSession(journal.from, session) || !['switched', 'retired'].includes(journal.state) ||
            journal.candidate?.status !== 'verified') return { ok: false, reason: 'route_lineage_broken' };
        session = journal.candidate.session;
        generation = journal.next;
      }
      if (!sameSession(binding.session, session)) return { ok: false, reason: 'binding_changed' };
      if (binding.state !== 'active') return { ok: false, reason: 'binding_frozen' };
      return { ok: true, target: current() };
    },
    /** True only if the binding still names exactly this chat and the host sees it online, on this host, in this workspace. */
    async verifyBinding(target) {
      if (!trusted) return false;
      let state;
      try { state = await current(); } catch { return false; }
      const { binding } = state;
      if (binding.state !== 'active' || binding.mode !== 'auto' || binding.generation !== target?.generation ||
          !sameSession(binding.session, { host: target.hostId, id: target.threadId, cwd: target.cwd }) || !attestedNow(state)) return false;
      let seen;
      try { seen = await host.describeThread(target.threadId); } catch { return false; }
      return seen?.online === true && seen.hostId === target.hostId && seen.threadId === target.threadId && seen.cwd === target.cwd;
    },
  };
}
