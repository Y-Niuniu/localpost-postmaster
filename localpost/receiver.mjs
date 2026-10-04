import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { acquireLease, atomicWrite, assertId, safePath } from './fs-safe.mjs';
import { validateEnvelope, isTerminalResult } from './postmaster.mjs';
import { envelopeDigest } from './mailbox.mjs';

const digest = envelopeDigest;
// A dispatch that failed with one of these sent nothing: the letter waits for a later scan. Anything else is uncertain.
const PENDING = { binding_unverified: 'binding_unverified', client_unavailable: 'client_closed', binding_frozen: 'binding_frozen', acceptance_busy: 'acceptance_busy' };
const SOFT_REFUSALS = new Set(['mode_manual', 'frozen', 'capacity_full', 'held']);
function afterFailure(error) {
  if (Object.hasOwn(PENDING, error?.code)) return { state: 'queued', reason: PENDING[error.code] };
  if (error?.code === 'acceptance_refused' && SOFT_REFUSALS.has(error.reason)) return { state: 'queued', reason: error.reason };
  // The arrival route no longer leads to a bound chat (for example the user rebound to another one): never redirect it.
  if (['binding_changed', 'delivery_binding_invalid'].includes(error?.code)) return { state: 'needs_reconcile', reason: 'route_unresolvable', detail: error.reason ?? error.code };
  return { state: 'needs_reconcile', reason: 'dispatch_uncertain', error: error?.message };
}
const json = async file => {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

// Receiver records transport facts only. It never writes ledger or business files.
export function createReceiver({ root, agent, allowFrom = [], adapter, now = () => Date.now(), scanIntervalMs = 30000, debounceMs = 300, watch = fs.watch } = {}) {
  assertId(agent); allowFrom.forEach(assertId);
  root = path.resolve(root);
  let ancestor = root;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const pinnedRoot = path.resolve(fs.realpathSync.native(ancestor), path.relative(ancestor, root));
  const checked = relative => {
    if (fs.existsSync(root) && fs.realpathSync.native(root).toLowerCase() !== pinnedRoot.toLowerCase()) throw new Error('Configured mailbox root changed; needs reconciliation');
    return safePath(root, relative);
  };
  const stateFile = () => checked(`runtime/queues/${agent}.json`);
  const inbox = () => checked(`agents/${agent}/inbox`);
  let watcher, interval, debounce, stopped = true;
  const active = new Set();
  const capabilities = adapter?.capabilities || {};
  const verifiedAdapter = capabilities.trustedBinding === true && capabilities.wholeTurn === true &&
    capabilities.sourceIsRelay === true && capabilities.dispatchIdempotent === true;

  // Where a letter goes was fixed when it was delivered: the controlled delivery records the recipient's binding in the
  // same write-lock section that publishes the letter (mailbox.mjs). No envelope, sender, attachment, scan time or later
  // binding decides it, and a letter without that record (written into the inbox by hand) is never dispatched.
  async function arrival(env, hash) {
    if (env.type === 'result') return { state: 'manual', reason: 'result' }; // results are read by people, never relayed
    const record = await json(checked(`runtime/arrivals/${agent}/${env.id}.json`));
    if (!record) return { state: 'manual', reason: 'no_arrival_record' };
    if (record.id !== env.id || record.to !== agent || record.digest !== hash) return { state: 'needs_reconcile', reason: 'arrival_record_conflict' };
    if (!record.route) return { state: 'manual', reason: record.reason ?? 'arrived_without_route' };
    return { state: 'queued', route: { ...record.route, arrivedAt: record.arrivedAt } };
  }

  async function scanOnce() {
    const lease = await acquireLease(root, { name: `.receiver-${agent}.lock`, now: now() });
    if (!lease.acquired) return { skipped: true, reason: lease.reason };
    try {
      let state = await json(stateFile());
      if (!state) {
        const publication = await acquireLease(root, { name: '.mailbox-write.lock', now: now() });
        if (!publication.acquired) return { skipped: true, reason: publication.reason };
        try {
          let baseline;
          try { baseline = (await fsp.readdir(inbox())).filter(x => x.endsWith('.json')).map(x => x.slice(0, -5)); }
          catch (error) { if (error.code === 'ENOENT') baseline = []; else throw error; }
          state = { schema: 1, agent, enabledAt: new Date(now()).toISOString(), historicalIds: baseline, entries: {}, errors: [] };
          await atomicWrite(stateFile(), JSON.stringify(state, null, 2) + '\n');
        } finally { await publication.release(); }
      }
      if (state.schema !== 1 || state.agent !== agent || !state.entries) throw new Error('Receiver state requires reconciliation');
      state.errors = [];
      for (const item of Object.values(state.entries)) {
        if (item.state === 'dispatching') { item.state = 'needs_reconcile'; item.reason = 'dispatch_interrupted'; }
      }
      let names;
      try { names = await fsp.readdir(inbox()); }
      catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
      const found = [];
      for (const name of names.filter(x => x.endsWith('.json')).sort()) {
        try {
          const env = await json(safePath(root, `agents/${agent}/inbox/${name}`));
          if (!env) continue;
          const valid = validateEnvelope(env);
          if (!valid.ok) throw new Error('Invalid envelope');
          assertId(env.id); assertId(env.thread_id); assertId(env.from); assertId(env.to);
          if (env.to !== agent || name !== `${env.id}.json`) throw new Error('Envelope destination or filename mismatch');
          if (env.attachments) for (const attachment of env.attachments) safePath(root, `attachments/${attachment}`);
          found.push(env);
        } catch (error) { state.errors.push({ file: name, code: error.code || 'invalid_envelope', message: error.message }); }
      }
      found.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      for (const env of found) {
        const hash = digest(env);
        let item = Object.hasOwn(state.entries, env.id) ? state.entries[env.id] : undefined;
        if (item) {
          if (item.hash !== hash) { item.state = 'needs_reconcile'; item.reason = 'id_content_conflict'; }
          continue;
        }
        item = state.entries[env.id] = { id: env.id, thread: env.thread_id, from: env.from, type: env.type, hash, receivedAt: new Date(now()).toISOString() };
        if (state.historicalIds?.includes(env.id)) { item.state = 'historical'; continue; }
        if (!allowFrom.includes(env.from)) { item.state = 'denied'; item.reason = 'sender_not_allowed'; continue; }
        Object.assign(item, await arrival(env, hash));
      }
      for (const item of Object.values(state.entries)) {
        const uncertainDispatch = item.state === 'needs_reconcile' && ['dispatch_interrupted', 'dispatch_uncertain'].includes(item.reason);
        if (!['task', 'ping'].includes(item.type) || (!['queued', 'submitted', 'awaiting_authorization'].includes(item.state) && !uncertainDispatch)) continue;
        const replies = [];
        for (const bucket of ['inbox', 'archive']) {
          const dir = safePath(root, `agents/${item.from}/${bucket}`);
          let files;
          try { files = await fsp.readdir(dir); }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          for (const name of files.filter(x => x.endsWith('.json'))) {
            try {
              const result = await json(safePath(root, `agents/${item.from}/${bucket}/${name}`));
              if (!validateEnvelope(result).ok || result.type !== 'result' || result.reply_to !== item.id ||
                  result.from !== agent || result.to !== item.from || result.thread_id !== item.thread || name !== `${result.id}.json`) continue;
              replies.push(result);
            } catch (error) {
              state.errors.push({ file: `${item.from}/${bucket}/${name}`, code: error.code || 'invalid_reply', message: error.message });
            }
          }
        }
        const terminal = replies.filter(isTerminalResult).sort((a,b) => b.created_at.localeCompare(a.created_at))[0];
        if (terminal) { item.state = terminal.outcome === 'failed' ? 'failed' : 'completed'; item.resultId = terminal.id; delete item.reason; delete item.error; }
        else if (replies.some(x => x.outcome === 'needs_authorization')) item.state = 'awaiting_authorization';
      }
      // Persist before contacting a runtime. A crash cannot silently lose reception.
      state.updatedAt = new Date(now()).toISOString();
      await atomicWrite(stateFile(), JSON.stringify(state, null, 2) + '\n');
      if (verifiedAdapter) {
        for (const item of Object.values(state.entries).filter(x => x.state === 'queued')) {
          if (!allowFrom.includes(item.from)) { item.state = 'denied'; item.reason = 'sender_permission_revoked'; continue; }
          item.state = 'dispatching'; delete item.reason; delete item.detail; delete item.error;
          await atomicWrite(stateFile(), JSON.stringify(state, null, 2) + '\n');
          try {
            const receipt = await adapter.submit({
              route: item.route, digest: item.hash, idempotencyKey: `${agent}:${item.id}`,
              source: { kind: 'plugin', plugin: 'localpost', form: 'relay' }, scope: 'analysis-reply',
              messageReference: { agent, id: item.id }, after: 'whole-turn',
            });
            if (!receipt?.accepted) throw new Error('Runtime did not confirm durable acceptance');
            item.state = 'submitted'; item.receipt = receipt.receipt; item.submittedAt = new Date(now()).toISOString();
          } catch (error) { Object.assign(item, afterFailure(error)); }
          await atomicWrite(stateFile(), JSON.stringify(state, null, 2) + '\n');
        }
      } else for (const item of Object.values(state.entries).filter(x => x.state === 'queued')) item.reason = 'runtime_capabilities_unverified';
      await atomicWrite(stateFile(), JSON.stringify(state, null, 2) + '\n');
      return state;
    } finally { await lease.release(); }
  }

  function scan() {
    const pending = scanOnce(); active.add(pending);
    pending.then(() => active.delete(pending), () => active.delete(pending));
    return pending;
  }

  const hint = () => {
    if (stopped) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => { void scan().catch(onError); }, debounceMs);
  };
  let lastError;
  const onError = error => { lastError = { at: new Date(now()).toISOString(), message: error.message }; };
  // start() and stop() run one at a time. start() waits twice (the inbox directory, the first scan); a stop() arriving in
  // between runs after it and tears down what it opened, so nothing is scheduled once stop() has returned, and two
  // concurrent starts open one watcher, not two.
  let lifecycle = Promise.resolve();
  const serially = task => {
    const next = lifecycle.then(task, task);
    lifecycle = next.catch(() => {});
    return next;
  };
  return {
    scan,
    snapshot: () => json(stateFile()),
    diagnostics: () => ({ running: !stopped, dispatchEnabled: verifiedAdapter, lastError }),
    start() {
      return serially(async () => {
        if (!stopped) return;
        await fsp.mkdir(inbox(), { recursive: true });
        stopped = false;
        try { watcher = watch(inbox(), hint); watcher.on('error', onError); }
        catch (error) { onError(error); }
        await scan();
        interval = setInterval(() => { void scan().catch(onError); }, scanIntervalMs);
      });
    },
    /**
     * Stops for good even when a step fails. New scheduling ends first (the flag silences watcher hints, both timers are
     * cleared), then the watcher is closed, then scans already running are awaited; a close failure is reported only after
     * all of that. The watcher reference is dropped before closing, so a repeated stop touches nothing and throws nothing.
     * Clearing a timer or awaiting allSettled cannot throw, so closing the watcher is the one step that can fail.
     */
    stop() {
      return serially(async () => {
        stopped = true;
        clearInterval(interval); interval = undefined;
        clearTimeout(debounce); debounce = undefined;
        const closing = watcher;
        watcher = undefined;
        let failure = null;
        try { closing?.close(); } catch (error) { failure = error; }
        await Promise.allSettled([...active]);
        if (failure !== null) throw failure;
      });
    },
  };
}
