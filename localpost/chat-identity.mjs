import { assertId } from './fs-safe.mjs';

/**
 * Which LocalPost identity a host-attested chat speaks for, when one DSH host serves several identities.
 *
 * The identity is never an argument: it follows from the bindings the user made with human commands. A chat speaks for
 * an identity when that identity's binding names it - as the current session, as a session a rotation moved away from
 * (it may still own letters of its generation) or as a rotation candidate. Membership is matched on host and chat id
 * only, so a chat cannot step out of an identity by presenting another workspace; the exact checks that follow it (the
 * bound chat, the letter owner) still compare the workspace as well.
 *
 *   exactly one identity names the chat    -> that identity
 *   none                                   -> the host's primary identity (what every DSH chat was before identities)
 *   more than one, or a binding unreadable -> refused: a chat speaks for one identity at most, and the binding that cannot
 *                                             be read might be the one that names it
 */

// A further identity names commands (`/localpost-<identity>-bind`) and a mailbox directory, so it must satisfy the host's
// command names (/^[a-z][a-z0-9_-]*$/) and the mailbox's agent names (at most 32 characters) at once.
export const IDENTITY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

const failure = (code, message) => Object.assign(new Error(message), { code });
const sameChat = (session, caller) => session?.host === caller?.host && session?.id === caller?.session;

/** Every session an identity's binding names: the current one, and those its rotations moved from or towards. */
export function lineageSessions(state) {
  const sessions = [state.binding.session];
  for (const journal of Object.values(state.rotations ?? {})) {
    if (journal?.from) sessions.push(journal.from);
    if (journal?.candidate?.session) sessions.push(journal.candidate.session);
  }
  return sessions;
}

/** True when the binding state (null = never bound) names the calling chat anywhere in its lineage. */
export function namesChat(state, caller) {
  return state !== null && state !== undefined && lineageSessions(state).some(session => sameChat(session, caller));
}

/**
 * @param {{store: {read: (identity: string) => Promise<object|null>}, primary: string, identities: string[]}} input
 *   store the shared session store; primary the host's own identity; identities the further identities it serves.
 */
export function createChatIdentity({ store, primary, identities = [] } = {}) {
  assertId(primary);
  identities.forEach(assertId);
  const all = Object.freeze([primary, ...identities]);

  /** The identities whose binding names this chat. An unreadable binding refuses the whole question. */
  async function claimants(caller) {
    const found = [];
    for (const identity of all) {
      let state;
      try { state = await store.read(identity); }
      catch (error) {
        throw failure('IDENTITY_UNRESOLVED', `the binding of ${identity} cannot be read (${String(error?.message ?? error)}), `
          + 'so it is unknown which identity this chat speaks for; an operator must reconcile it first');
      }
      if (namesChat(state, caller)) found.push(identity);
    }
    return found;
  }

  return Object.freeze({
    identities: all,
    /** The one identity this chat speaks for; the primary when no binding names it. */
    async identityOf(caller) {
      const found = await claimants(caller);
      if (found.length > 1) {
        throw failure('IDENTITY_AMBIGUOUS', `this chat is named by the bindings of ${found.join(', ')}; a chat speaks for one `
          + 'identity only, so nothing is served until an operator reconciles the bindings');
      }
      return found[0] ?? primary;
    },
    /** Another identity this chat already speaks for, or null: binding it as `identity` must not make it speak for two. */
    async otherIdentityOf(caller, identity) {
      return (await claimants(caller)).find(other => other !== identity) ?? null;
    },
  });
}
