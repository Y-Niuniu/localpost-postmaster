/**
 * A turn-level model of the installed DSH host (0.2.0-rc.2), for the mail-turn guard's deterministic cancel, unload and
 * child-session tests. It is a test fixture, never shipped, and proves nothing about a real host by itself: every
 * mechanism below reproduces a piece of host source that was read for this purpose (extracted modules in
 * work/b-host-guard-evidence, vendored packages in work/b-probe/vendor), and names it.
 *
 *   fibers    cordis Fiber.effect / _unload (@deepseek-ai/cordis lib/index.js:1168-1278, :1371-1391): a fiber's effects
 *             are disposed concurrently at unload, newest first (DisposableList.clear reverses, :22-26), each after one
 *             microtask; a disposer may be async and the unload awaits it.
 *   scopes    dsh-scope createScope (:296-306): every agent gets its own scope fiber, so a registration made through
 *             agent.ctx belongs to the agent, not to the plugin that made it.
 *   events    cordis EventsService.dispatch (:258-264) through dsh-scope scopeTarget (:327-338): an untagged listener hears
 *             every scope, a tagged one only its own key. Agents are not scope-linked to each other (host-subagent.js and
 *             host-agent.js import scopeTarget only), so a parent's tagged listener does not hear its children.
 *   tools     dsh-tools ToolRuntime: guardReason asks the global guards, then the caller's own scope layer
 *             (host-tools.js:2928-2936); a denial becomes an error result and is never dispatched (:3241-3257); a call
 *             let through resolves its definition again and only then runs the body (:3307-3310).
 *   turns     dsh-agent-loop ReactLoopAgent: followup queues next-turn (:806-808); a turn claims one next-turn message
 *             and emits agent/inbox/claimed { message, turn, agent } (:103-110; dsh-agent agentEvents :335-356);
 *             each call appends tool/call before its guard runs (:578-583); abort stops new starts and drains the
 *             started calls before the step returns (:618-645); turn/end is appended in turn()'s finally (:1025-1033);
 *             after an aborted turn the driver goes idle, pending input waits for the next wake (:887-901);
 *             cancel(cause, { keepInbox }) (:815-821); whenIdle (:870-875); inbox.remove discards and emits
 *             agent/inbox/discarded (:145-150, :204-206).
 *   sessions  Session.append publishes session/event synchronously, on the carrier of the scope that entered the
 *             session - the agent (dsh-session :1458-1498, :1707-1716).
 *   agents    AgentRegistry get / isOwnedBy (host-agent.js:594-607); announce runs the serial agent/created dispatch and
 *             a listener failure rejects the creation (:572-588), which rolls the new agent back.
 *
 * The model of a turn is a script: `agent.model = async turn => { ... await turn.step([...calls]) ... }`. A call may
 * carry `hold` (a promise its body awaits), so a test controls exactly when an in-flight tool settles.
 */

const tick = () => new Promise(resolve => setImmediate(resolve));

function createFiber(label) {
  const effects = [];
  const fiber = {
    label, active: true,
    effect(dispose) {
      if (!fiber.active) throw new Error('cannot create effect on inactive context (' + label + ')');
      let done = false;
      const wrapper = () => {
        if (done) return undefined;
        done = true;
        const at = effects.indexOf(wrapper);
        if (at >= 0) effects.splice(at, 1);
        return dispose();
      };
      effects.push(wrapper);
      return wrapper;
    },
    /** cordis Fiber._unload: every effect at once, newest first, each after one microtask; awaits async disposers. */
    async unload() {
      fiber.active = false;
      const all = effects.splice(0).reverse();
      await Promise.all(all.map(async dispose => { await Promise.resolve(); await dispose(); }));
    },
    effects,
  };
  return fiber;
}

export function createTurnHost() {
  const hooks = [];
  const layers = new Map();                                   // scope key (undefined = global) -> { tools: Map, guards: [] }
  const registry = new Map();                                 // agent id -> { agent, owner }
  const bodyRuns = [];
  const layerOf = key => { if (!layers.has(key)) layers.set(key, { tools: new Map(), guards: [] }); return layers.get(key); };

  const dispatch = (key, name) => hooks.filter(hook => hook.name === name && (hook.tag === undefined || hook.tag === key));
  const emit = (key, name, ...args) => { for (const hook of dispatch(key, name)) hook.listener(...args); };
  async function serial(key, name, ...args) { for (const hook of dispatch(key, name)) await hook.listener(...args); }

  function context(fiber, tag) {
    const ctx = {
      fiber, tag,
      on(name, listener) {
        const hook = { name, listener, tag };
        hooks.push(hook);
        return fiber.effect(() => { const at = hooks.indexOf(hook); if (at >= 0) hooks.splice(at, 1); });
      },
      tools: {
        register(definition) {
          const layer = layerOf(tag);
          if (layer.tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`);
          layer.tools.set(definition.name, definition);
          return fiber.effect(() => { if (layer.tools.get(definition.name) === definition) layer.tools.delete(definition.name); });
        },
        get: (name, scope) => tools.get(name, scope),
        guard(check) {
          const layer = layerOf(tag);
          layer.guards.push(check);
          return fiber.effect(() => { const at = layer.guards.indexOf(check); if (at >= 0) layer.guards.splice(at, 1); });
        },
      },
      agents,
    };
    return ctx;
  }

  const tools = {
    get(name, scope) {
      const own = scope === undefined ? undefined : layers.get(scope);
      if (own?.tools.has(name)) return own.tools.get(name);
      return layers.get(undefined)?.tools.get(name);
    },
    guardReason(exec) {
      for (const check of [...(layers.get(undefined)?.guards ?? [])]) { const reason = check(exec); if (reason !== undefined) return reason; }
      if (exec.agent === undefined) return undefined;
      for (const check of [...(layers.get(exec.agent)?.guards ?? [])]) { const reason = check(exec); if (reason !== undefined) return reason; }
      return undefined;
    },
    /** prepare -> guard -> (deny | dispatch: resolve again, run the body). */
    async execute(exec) {
      await Promise.resolve();                                // the async tools/pre-execute waterfall before the guard
      const reason = tools.guardReason(exec);
      if (reason !== undefined) return { denied: true, isError: true, text: 'Error: ' + reason };
      const tool = tools.get(exec.name, exec.agent);
      if (tool === undefined) return { unknown: true, isError: true, text: 'UNKNOWN_TOOL ' + exec.name };
      bodyRuns.push({ name: exec.name, agent: exec.agent?.id });
      try { return { isError: false, value: await tool.execute(exec.arguments, exec) }; }
      catch (error) { return { isError: true, error, text: String(error?.message ?? error) }; }
    },
  };

  const agents = {
    get: id => registry.get(id)?.agent,
    isOwnedBy: (id, owner) => registry.get(id)?.owner === owner,
    list: () => [...registry.values()].map(entry => entry.agent),
    /** Create, enter and announce an agent; a failing agent/created listener rolls the creation back. */
    async create({ id, cwd = 'C:/work/' + id, owner } = {}) {
      const agent = new TurnAgent(id, cwd);
      registry.set(id, { agent, owner });
      try { await serial(agent, 'agent/created', { agent, source: 'fresh' }); }
      catch (error) { registry.delete(id); await agent.fiber.unload(); throw error; }
      return agent;
    },
  };

  let callCounter = 0;
  class TurnAgent {
    constructor(id, cwd) {
      this.id = id;
      this.fiber = createFiber('agent ' + id);
      this.ctx = context(this.fiber, this);
      this.log = [];
      const agent = this;
      this.session = {
        id, header: { cwd },
        append(type, data) {
          const event = Object.freeze({ type, seq: agent.log.length, data });
          agent.log.push(event);
          emit(agent, 'session/event', agent.session, event);
          return event;
        },
      };
      this.queue = { 'next-turn': [], 'next-step': [] };
      this.inbox = {
        get nextTurn() { return [...agent.queue['next-turn']]; },
        get nextStep() { return [...agent.queue['next-step']]; },
        get hasPending() { return agent.queue['next-turn'].length > 0 || agent.queue['next-step'].length > 0; },
        remove(messageId) {
          for (const target of ['next-turn', 'next-step']) {
            const at = agent.queue[target].findIndex(message => message.id === messageId);
            if (at >= 0) { const [message] = agent.queue[target].splice(at, 1); emit(agent, 'agent/inbox/discarded', { message, agent }); return true; }
          }
          return false;
        },
        clear() { for (const target of ['next-step', 'next-turn']) for (const message of agent.queue[target].splice(0)) emit(agent, 'agent/inbox/discarded', { message, agent }); },
      };
      this.phase = { kind: 'idle', lastTurn: 0 };
      this.activityDone = Promise.resolve();
      this.model = async () => {};
    }
    get status() { return this.phase.kind === 'idle' ? 'idle' : 'running'; }
    followup(message) { this.send(message, 'next-turn'); }
    steer(message) { this.send(message, 'next-step'); }
    send(message, target) {
      if (this.queue['next-turn'].concat(this.queue['next-step']).some(pending => pending.id === message.id)) throw new Error(`message "${message.id}" is already pending`);
      this.queue[target].push(message);
      this.wake();
    }
    cancel(cause, options = {}) {
      if (!options.keepInbox) this.inbox.clear();
      if (this.phase.kind !== 'idle') this.phase.abort.abort(cause);
    }
    wake() {
      if (this.phase.kind !== 'idle') return;
      let resolve;
      this.activityDone = new Promise(r => { resolve = r; });
      this.phase = { kind: 'running', abort: new AbortController(), turn: this.phase.lastTurn };
      (async () => {
        try { while (await this.turn()); }
        catch { /* an aborted or failed turn ends the drive */ }
        finally { this.phase = { kind: 'idle', lastTurn: this.phase.turn }; resolve(); }
      })();
    }
    async whenIdle() { let activity; do await (activity = this.activityDone); while (activity !== this.activityDone); }
    async turn() {
      const phase = this.phase;
      const { signal } = phase.abort;
      signal.throwIfAborted();
      const turn = phase.turn + 1;
      this.session.append('turn/start', { turn });
      phase.turn = turn;
      let ends = { kind: 'completed' };
      try {
        await tick();                                         // pre-step assembly
        const claimed = this.queue['next-step'].splice(0);
        claimed.push(...this.queue['next-turn'].splice(0, 1));
        for (const message of claimed) emit(this, 'agent/inbox/claimed', { message, turn, agent: this });
        for (const message of claimed) this.session.append('user/message', message);
        signal.throwIfAborted();
        await this.model({ turn, claimed, signal, step: calls => this.step(turn, calls, signal) });
        signal.throwIfAborted();
      } catch (error) {
        ends = signal.aborted ? { kind: 'aborted', reason: { kind: signal.reason?.kind ?? 'user' } } : { kind: 'error', message: String(error?.message ?? error) };
        throw error;
      } finally {
        this.session.append('turn/end', { turn, reason: ends });
      }
      if (!this.inbox.hasPending) return false;
      phase.abort = new AbortController();
      return true;
    }
    /** One step's calls, started in order; abort stops further starts and drains what started (runGroup). */
    async step(turn, calls, signal) {
      const results = new Array(calls.length);
      const inFlight = [];
      for (let index = 0; index < calls.length; index++) {
        if (signal.aborted) { results[index] = { skipped: true, isError: true, text: 'Error: tool call aborted before dispatch' }; continue; }
        const call = calls[index];
        const callId = 'call-' + (++callCounter);
        this.session.append('tool/call', { turn, callId, name: call.name });
        const exec = { callId, rootCallId: callId, name: call.name, arguments: call.args ?? {}, agent: this, signal, hold: call.hold };
        inFlight.push(tools.execute(exec).then(result => { results[index] = result; this.session.append('tool/result', { turn, callId, isError: result.isError }); }));
        if (call.wait !== false) await inFlight[inFlight.length - 1];
      }
      await Promise.allSettled(inFlight);
      signal.throwIfAborted();
      return results;
    }
  }

  const root = createFiber('root');
  return {
    tools, agents, bodyRuns, emit,
    hooks: () => hooks.map(hook => ({ name: hook.name, tag: hook.tag === undefined ? 'global' : hook.tag.id })),
    guardsOn: agent => [...(layers.get(agent)?.guards ?? [])].length,
    globalGuards: () => [...(layers.get(undefined)?.guards ?? [])].length,
    /** A plugin: its own fiber and untagged context. unload() is cordis Fiber._unload for that fiber. */
    plugin(label) { const fiber = createFiber('plugin ' + label); return { fiber, ctx: context(fiber, undefined), unload: () => fiber.unload() }; },
    root: context(root, undefined),
    runsOf: name => bodyRuns.filter(run => run.name === name).length,
  };
}

/** A tool definition whose body records every run and may wait on the call's `hold`. */
export function recordingTool(name, ran = []) {
  return {
    name, description: 'test tool ' + name, parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) { ran.push(name); if (exec?.hold) await exec.hold; return name + ' ran'; },
  };
}

/** A promise a test settles by hand: the in-flight body of a tool. */
export function gate() {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open: () => open() };
}
