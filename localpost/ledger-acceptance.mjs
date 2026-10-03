import { assertId } from './fs-safe.mjs';
import { dispatchLetter } from './letter-claims.mjs';

/**
 * Durable, idempotent acceptance for automatic delivery, kept in the identity's claim ledger (letter-claims.mjs) -
 * the same ledger the manual consumer and the rotation use, not a second state machine.
 * Key `<identity>:<letter id>`. Before the host is touched the ledger is written ahead (reserved → dispatching); the
 * acceptance is recorded only after the host confirmed it. A crash or a lost confirmation leaves the letter
 * `dispatching`, which the next actor isolates as needs_reconcile: it is never retried and never reported as delivered.
 *
 * What this guarantees, and what it does not: one wake-up on the normal path; at most one when anything is uncertain;
 * deduplication across process restarts. It is NOT exactly-once: DSH's followup() gives no receipt that survives a
 * crash, so a wake-up whose confirmation was lost stays uncertain until the owner's result or an operator closes it.
 */
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const sameTarget = (session, generation, target) => session.id === target?.threadId && session.host === target?.hostId &&
  (session.cwd ?? null) === (target?.cwd ?? null) && generation === target?.generation;
const receiptOf = (identity, claim, extra = {}) =>
  ({ accepted: true, durable: true, receipt: `ledger:${identity}:${claim.letter}:g${claim.owner.generation}`, ...extra });

export function createLedgerAcceptance({ store, identity } = {}) {
  assertId(identity);
  if (!store) throw new Error('Ledger acceptance needs the identity session store');
  return {
    durable: true,
    idempotent: true,
    /**
     * `target` is where the binding provider resolved this letter to; the ledger owner of the attempt must be exactly it.
     * `enqueue` wakes the session; it throws { code: 'client_unavailable' } when the session is not live (nothing sent).
     */
    async acceptOnce({ key, target, messageReference, digest } = {}, enqueue) {
      assertId(messageReference?.id);
      if (messageReference.agent !== identity || key !== `${identity}:${messageReference.id}` || typeof enqueue !== 'function')
        throw failure('acceptance_contract_invalid', 'The acceptance key must name this identity and letter');
      let mismatch = false;
      const result = await dispatchLetter(store, identity, { id: messageReference.id, digest }, {
        async submit({ session, key: attemptKey }) {
          const generation = Number(/:g(\d+)$/.exec(attemptKey)?.[1]);
          if (!sameTarget(session, generation, target)) { mismatch = true; return { accepted: false, definitive: true }; }
          try { await enqueue(); return { accepted: true }; }
          catch (error) { if (error?.code === 'client_unavailable') return { accepted: false, definitive: true }; throw error; }
        },
      });
      if (result.skipped) throw failure('acceptance_busy', 'Another actor is working on this identity; nothing was sent');
      const { claim } = result;
      if (result.ok) {
        if (claim.status === 'accepted') return receiptOf(identity, claim);
        if (claim.status === 'released')
          throw mismatch ? failure('binding_changed', 'The ledger owner is no longer the resolved target; nothing was sent')
            : failure('client_unavailable', 'The bound session is not live; nothing was sent');
        throw failure('acceptance_uncertain', 'Acceptance could not be confirmed; the letter needs reconciliation');
      }
      // Already accepted by exactly this target: the same key never wakes the session again, even after a restart.
      if (result.reason === 'duplicate' && ['accepted', 'done'].includes(claim?.status) &&
          claim.owner.session === target?.threadId && claim.owner.generation === target?.generation)
        return receiptOf(identity, claim, { deduplicated: true });
      if (['needs_reconcile', 'stale_attempt'].includes(result.reason))
        throw failure('acceptance_uncertain', 'An earlier acceptance is uncertain and is never retried', { reason: result.reason });
      throw failure('acceptance_refused', `The ledger refused this letter: ${result.reason}`, { reason: result.reason });
    },
  };
}
