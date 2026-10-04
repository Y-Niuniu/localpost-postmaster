/**
 * The mail-turn guard: an automatic mail turn may reach only the five LocalPost tools, from the moment the bound
 * chat claims the relay message until that same turn has ended - and the protection outlives this plugin.
 *
 * One relay message = one armament, made on the TARGET AGENT'S OWN SCOPE (agent.ctx) before the message is enqueued:
 *   guard      agent.ctx.tools.guard(...)                   a scoped guard, consulted only for that agent's calls
 *   claimed    agent.ctx.on('agent/inbox/claimed')          { message, turn, agent }: message.id -> the turn it opens
 *   turn end   agent.ctx.on('session/event')                'turn/end' of exactly that turn, in that agent's session
 *   discarded  agent.ctx.on('agent/inbox/discarded')        the message left the inbox before any turn claimed it
 * Everything registered through agent.ctx is an effect of the agent's scope fiber, not of this plugin (dsh-scope
 * createScope mints its own fiber; ScopedLayers.effect and EventsService.register take ownership from the calling
 * context). Unloading this plugin therefore cannot take the protection with it - unlike a plugin-owned guard, which
 * cordis Fiber._unload disposes concurrently with, and in practice before, the plugin's own async drain.
 *
 * Release follows the causal chain only: the claimed turn's own turn/end, or the message leaving the inbox unclaimed.
 * The host appends turn/end in turn()'s finally, after the step's tool scheduler has drained every started call
 * (dsh-agent-loop runGroup: abort stops new starts and awaits the in-flight dispatches), so that turn/end is the
 * activity barrier for the turn's tools, cancelled or not. Nothing else releases an armament: not an idle agent, not a
 * timeout, not a binding generation, not receiver.stop, not this plugin unloading. drain() cancels and waits, but a
 * drain that runs out of time leaves the armament standing - still denying - and reports it.
 */
export const GUARD_UNAVAILABLE = 'guard_unavailable';
export const CHILD_REFUSED = 'mail_turn_child_refused';
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const errorText = error => String(error?.message ?? error);

/**
 * @param {{policy: (exec: object) => (string|undefined), agents?: {isOwnedBy?: Function}}} input
 *   policy  the mail-turn tool policy (createMailTools().mailTurnReason): a reason denies, undefined admits.
 *   agents  the host agent registry, for the child-creation barrier (isOwnedBy).
 */
export function createMailTurnGuard({ policy, agents } = {}) {
  if (typeof policy !== 'function') throw new TypeError('The mail-turn guard needs the mail-turn tool policy');
  const armaments = new Set();
  let closed = false;

  /** Whether an agent offers everything an armament is made of; no armament is ever half-made. */
  function capable(agent) {
    const ctx = agent?.ctx;
    return typeof ctx?.tools?.guard === 'function' && typeof ctx?.on === 'function' && agent?.session !== undefined && agent?.session !== null;
  }

  /**
   * Arm the guard for one relay message on its target agent. Must run BEFORE the message is enqueued: the claim that
   * opens the turn can only follow the enqueue. Throws guard_unavailable - with nothing left registered - when the
   * guard cannot be put in place, so the caller must not enqueue.
   */
  function arm(agent, messageId) {
    if (closed) throw failure(GUARD_UNAVAILABLE, 'The mail-turn guard is draining; no new relay is armed');
    if (typeof messageId !== 'string' || messageId === '') throw failure(GUARD_UNAVAILABLE, 'A relay needs its message id to be guarded');
    if (!capable(agent)) throw failure(GUARD_UNAVAILABLE, 'The target agent offers no scoped guard and lifecycle events; the relay is not guarded');
    const disposers = [];
    let settle;
    const armament = {
      agent, messageId, state: 'pending', turn: null, releasedBy: null, held: null,
      released: new Promise(resolve => { settle = resolve; }),
    };
    armament.release = by => {
      if (armament.state === 'released') return;
      armament.state = 'released';
      armament.releasedBy = by;
      armament.held = null;
      armaments.delete(armament);
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose(); } catch (error) { armament.releaseError ??= errorText(error); }
      }
      settle(by);
    };
    const scope = agent.ctx;
    try {
      // The guard first: no listener may ever activate an armament that has no guard behind it.
      const guard = scope.tools.guard(exec => {
        if (armament.state !== 'active') return undefined;
        try { return policy(exec); }
        catch (error) { return 'localpost-mail-turn: the policy failed (' + errorText(error).slice(0, 120) + '). Denied before dispatch.'; }
      });
      disposers.push(typeof guard === 'function' ? guard : () => {});
      disposers.push(scope.on('agent/inbox/claimed', payload => {
        if (armament.state !== 'pending' || payload?.message?.id !== messageId) return;
        if (payload?.agent !== undefined && payload.agent !== agent) return;
        armament.turn = payload?.turn;
        armament.state = 'active';
      }));
      disposers.push(scope.on('agent/inbox/discarded', payload => {
        if (armament.state === 'pending' && payload?.message?.id === messageId) armament.release('discarded-before-claim');
      }));
      disposers.push(scope.on('session/event', (session, event) => {
        if (armament.state !== 'active' || session !== agent.session || event?.type !== 'turn/end') return;
        if (event?.data?.turn === armament.turn) armament.release('turn-end:' + String(event?.data?.reason?.kind ?? 'unknown'));
      }));
    } catch (error) {
      for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch { /* best effort: nothing was enqueued */ } }
      throw failure(GUARD_UNAVAILABLE, 'The mail-turn guard could not be put in place: ' + errorText(error), { cause: error });
    }
    armaments.add(armament);
    return armament;
  }

  /** After an enqueue that failed: release the armament only when its message is provably not waiting in the inbox. */
  function settleUnenqueued(armament) {
    if (armament?.state === 'pending' && !inboxHolds(armament.agent, armament.messageId)) armament.release('never-enqueued');
  }

  /**
   * The child-creation barrier (for the host's serial `agent/created`): the reason a new agent must not be created, or
   * undefined. A runtime child of an agent inside an armed mail turn is refused, at the real creation entry.
   */
  function childRefusal(child) {
    if (typeof child?.id !== 'string') return undefined;
    for (const armament of armaments) {
      if (armament.state !== 'active') continue;
      let owned;
      try { owned = agents?.isOwnedBy?.(child.id, armament.agent) === true; }
      catch { owned = true; }                                 // an unreadable ownership is not "not a child"
      if (owned) return 'an automatic mail turn may not create child agents (relay ' + armament.messageId + ', turn ' + String(armament.turn) + ')';
    }
    return undefined;
  }

  /**
   * Stop arming, then bring every live armament to its end: a relay still waiting in the inbox is removed (the
   * discard releases it); a claimed turn is cancelled with the user's queued input kept, and released by its own
   * turn/end. Waits up to timeoutMs for those releases, then for the cancelled agents to go idle. Whatever is still
   * standing stays standing - denying - and is listed under `held`; it releases itself when its turn ends.
   * Never calls a guard disposer to make the report look good.
   */
  async function drain({ timeoutMs = 10000, reason = 'localpost-unload' } = {}) {
    closed = true;
    const live = [...armaments];
    const steps = [];
    const cancelled = new Set();
    for (const armament of live) {
      const { agent, messageId } = armament;
      if (armament.state === 'pending') {
        let removed = false;
        try { removed = agent.inbox?.remove?.(messageId) === true; }
        catch (error) { steps.push({ messageId, step: 'remove-failed', error: errorText(error) }); }
        settleUnenqueued(armament);                           // not removed, not waiting, never claimed: never enqueued
        steps.push({ messageId, step: removed ? 'removed-from-inbox' : 'not-removed', state: armament.state });
      } else if (armament.state === 'active') {
        // Still active = its turn has not ended, so that turn is the agent's running turn: this cancel cannot hit another.
        try {
          agent.cancel({ kind: 'hook', reason }, { keepInbox: true });
          cancelled.add(agent);
          steps.push({ messageId, step: 'cancelled', turn: armament.turn });
        } catch (error) { steps.push({ messageId, step: 'cancel-failed', turn: armament.turn, error: errorText(error) }); }
      }
    }
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const remaining = () => Math.max(0, deadline - Date.now());
    await withTimeout(Promise.all(live.map(armament => armament.released)), remaining());
    const idle = [];
    for (const agent of cancelled) {
      if (typeof agent.whenIdle !== 'function') { idle.push({ agent: agentId(agent), idle: 'unknown' }); continue; }
      idle.push({ agent: agentId(agent), idle: (await withTimeout(agent.whenIdle().then(() => true), remaining())) === true });
    }
    const held = live.filter(armament => armament.state !== 'released');
    for (const armament of held) armament.held = 'not drained within ' + String(timeoutMs) + 'ms; the guard stays until its turn ends';
    return Object.freeze({
      released: live.filter(armament => armament.state === 'released').map(describe),
      held: held.map(describe),
      steps, idle,
    });
  }

  function inboxHolds(agent, messageId) {
    try {
      const pending = [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])];
      return pending.some(message => message?.id === messageId);
    } catch { return true; }                                  // unreadable: it may still be there
  }
  const agentId = agent => agent?.id ?? agent?.session?.id ?? null;
  const describe = armament => Object.freeze({ messageId: armament.messageId, agent: agentId(armament.agent), state: armament.state,
    turn: armament.turn, releasedBy: armament.releasedBy, ...(armament.held ? { held: armament.held } : {}),
    ...(armament.releaseError ? { releaseError: armament.releaseError } : {}) });

  return Object.freeze({
    capable, arm, settleUnenqueued, childRefusal, drain,
    status: () => Object.freeze({ draining: closed, armaments: [...armaments].map(describe) }),
  });
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), ms); })])
    .finally(() => clearTimeout(timer));
}
