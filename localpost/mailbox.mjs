import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { acquireLease, atomicWrite, assertId, safePath } from './fs-safe.mjs';
import { createSessionStore } from './session-binding.mjs';
import { claimOf, claimManual, complete, beginCompletion } from './letter-claims.mjs';
import { arrivalRoute } from './binding-provider.mjs';

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const envelopeDigest = envelope => createHash('sha256').update(canonical(envelope)).digest('hex');
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function listFiles(dir) {
  try { return fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function createMailbox({ root, identity } = {}) {
  if (!root) throw new Error('mailbox root is required');
  root = path.resolve(root);
  const agentName = value => {
    if (typeof value !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(value)) throw new Error('invalid agent identity: ' + value);
    return value;
  };
  if (identity !== undefined) agentName(identity);
  const own = agent => { agentName(agent); if (identity && agent !== identity) throw new Error('configured identity does not own mailbox: ' + agent); };
  const fileFor = (agent, bucket, id) => { agentName(agent); assertId(id); return safePath(root, path.join('agents', agent, bucket, id + '.json')); };
  const agents = () => listFiles(safePath(root, 'agents')).filter(name => /^[a-z0-9_-]{1,32}$/i.test(name) && fs.statSync(safePath(root, path.join('agents', name))).isDirectory());
  async function locked(operation) {
    const started = Date.now();
    while (true) {
      const lease = await acquireLease(root, { name: '.mailbox-write.lock', staleMs: 60000 });
      if (lease.acquired) { try { return await operation(); } finally { await lease.release(); } }
      if (lease.reason !== 'busy' || Date.now() - started > 5000) throw new Error('mailbox write lock unavailable: ' + lease.reason);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  function findId(id) {
    assertId(id);
    const found = [];
    for (const agent of agents()) for (const bucket of ['inbox', 'archive', 'outbox']) {
      const file = fileFor(agent, bucket, id);
      const envelope = readJson(file);
      if (envelope) found.push({ file, envelope, bucket });
    }
    return found;
  }
  function inbox(agent) {
    own(agent);
    const dir = safePath(root, path.join('agents', agent, 'inbox'));
    let files;
    try { files = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return files.filter(f => f.endsWith('.json')).sort().map(f => {
      try { return { file: f, ...readJson(safePath(root, path.join('agents', agent, 'inbox', f))) }; }
      catch (error) { if (error instanceof SyntaxError) return { file: f, error: 'invalid JSON: ' + error.message }; throw error; }
    });
  }
  function read(agent, id) {
    own(agent);
    const envelope = readJson(fileFor(agent, 'inbox', id));
    if (!envelope) throw new Error('letter not found: ' + id);
    const attachments_resolved = (envelope.attachments || []).map(name => {
      const file = safePath(safePath(root, 'attachments'), name);
      let stat;
      try { stat = fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') return { name, missing: true }; throw error; }
      if (!stat.isFile()) throw new Error('attachment is not a file: ' + name);
      const out = { name, bytes: stat.size };
      if (stat.size <= 200000 && /\.(md|txt|json|csv|ya?ml)$/i.test(name)) out.content = fs.readFileSync(file, 'utf8');
      else out.note = 'Binary or large attachment: ' + file;
      return out;
    });
    return { envelope, attachments_resolved };
  }
  // Once an identity is bound (runtime/sessions/<agent>.json), a letter that arrived with an automatic route (its
  // arrival record, written by deliverUnlocked) has one owner at a time, recorded in the claim ledger the automatic
  // receiver uses too (letter-claims.mjs). Every other letter - results, mail to an unbound identity, mail that arrived
  // in manual mode or was written into an inbox by hand - belongs to the manual consumer and never enters the ledger.
  const sessions = createSessionStore({ root });
  const arrivalFile = (agent, id) => { agentName(agent); assertId(id); return safePath(root, path.join('runtime', 'arrivals', agent, id + '.json')); };
  const refused = (id, reason) => Object.assign(new Error(`letter ${id} cannot be taken: ${reason}`), { code: 'LETTER_CLAIMED', reason });
  const OWNED = new Set(['accepted', 'completing', 'done', 'needs_reconcile']);
  /**
   * Fixes a new letter's arrival route before the letter becomes visible, in the write-lock section that publishes it:
   * whatever a rebinding or the receiver does later, the letter keeps the route its recipient had at delivery.
   * Only task and ping mail to a bound identity gets a record. A crash before the letter itself is written leaves a
   * record without a letter, which the next delivery of that id replaces.
   */
  async function recordArrival(envelope) {
    if (envelope.type === 'result') return;
    let arrival;
    try { const state = await sessions.read(envelope.to); arrival = state && arrivalRoute(state); }
    catch (error) { if (error.code !== 'STATE_NEEDS_RECONCILE') throw error; arrival = { route: null, reason: 'binding_unreadable' }; }
    if (!arrival) return;
    const file = arrivalFile(envelope.to, envelope.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await atomicWrite(file, JSON.stringify({ schema: 'localpost-arrival-v1', id: envelope.id, to: envelope.to, digest: envelopeDigest(envelope),
      arrivedAt: new Date().toISOString(), route: arrival.route, ...(arrival.reason ? { reason: arrival.reason } : {}) }, null, 2) + '\n');
  }
  /** The arrival route recorded at delivery; null leaves the letter to the manual consumer. */
  function arrivalOf(agent, envelope, digest) {
    const record = readJson(arrivalFile(agent, envelope.id));
    if (!record) return null;
    if (record.id !== envelope.id || record.to !== agent || record.digest !== digest)
      throw Object.assign(new Error(`letter ${envelope.id} does not match its arrival record and needs reconciliation`), { code: 'ARRIVAL_CONFLICT' });
    return record.route ?? null;
  }
  /**
   * Only the host can say which chat is calling: DSH hands native tools the calling agent (execution.agent), while its
   * MCP client forwards nothing but the tool name and arguments. The caller therefore comes from trusted in-process
   * code, never from tool arguments, and a letter that has an owner is worked on by that owner alone.
   */
  function proveOwner(state, owner, caller, id) {
    if (typeof caller?.host !== 'string' || !caller.host || typeof caller.session !== 'string' || !caller.session)
      throw Object.assign(new Error(`CALLER_UNVERIFIED: letter ${id} has an owner in the claim ledger and nothing proves which chat is calling`), { code: 'CALLER_UNVERIFIED' });
    const host = owner.generation === state.binding.generation ? state.binding.session.host : state.rotations[owner.generation]?.from.host;
    if (caller.session !== owner.session || caller.host !== host)
      throw Object.assign(new Error(`NOT_LETTER_OWNER: letter ${id} belongs to another chat of this identity`), { code: 'NOT_LETTER_OWNER' });
  }
  /** The ledger owner the caller works on this letter as, or null for a letter outside the ledger; anything else throws. */
  async function takeLetter(agent, envelope, caller) {
    const state = await sessions.read(agent);
    if (!state) return null;
    const { binding } = state, digest = envelopeDigest(envelope), claim = claimOf(state, envelope.id);
    if (claim && claim.digest !== digest) throw refused(envelope.id, 'digest_conflict');
    const held = claim !== undefined && claim.status !== 'released';
    if (held && OWNED.has(claim.status)) { proveOwner(state, claim.owner, caller, envelope.id); return claim.owner; }
    if (!held && !arrivalOf(agent, envelope, digest)) return null;
    if (binding.mode === 'auto') {
      // Automatic mode: the letter waits for, or is in, delivery to its session; nobody takes it by hand.
      throw Object.assign(new Error(`letter ${envelope.id} belongs to the automatic consumer and was not delivered to this session`), { code: 'CLAIMED_BY_AUTO' });
    }
    // Manual mode: the bound session, proven by the host, takes it into the shared ledger.
    proveOwner(state, { generation: binding.generation, session: binding.session.id }, caller, envelope.id);
    const taken = await claimManual(sessions, agent, { id: envelope.id, digest, session: caller.session });
    if (!taken.ok) throw refused(envelope.id, taken.reason);
    return taken.claim.owner;
  }
  // A reply or archive by the owner is written ahead in the ledger (`completing`) before anything is published, and that
  // intent is immutable (letter-claims.mjs): a retry must be the same operation with the same content.
  async function beginCompletionFor(agent, id, owner, intent) {
    const begun = await beginCompletion(sessions, agent, id, owner, intent);
    if (begun.ok) return;
    if (begun.reason === 'completion_intent_conflict') throw Object.assign(new Error(`COMPLETION_INTENT_CONFLICT: letter ${id} is being, `
      + 'or was, completed by another operation or with other content; only the identical retry may finish it'), { code: 'COMPLETION_INTENT_CONFLICT' });
    throw refused(id, begun.reason);
  }
  // What a terminal reply says (its id is compared separately), without the timestamp: the same reply retried has the same digest.
  const replyDigest = (options, outcome) => {
    const content = { outcome, body: options.body };
    for (const key of ['subject', 'commit', 'base_rev', 'test', 'attachments']) if (options[key] !== undefined) content[key] = options[key];
    return envelopeDigest(content);
  };
  /** read() for a consumer that takes the letter into its context: goes through the claim ledger first. */
  async function take(agent, id, { caller } = {}) {
    own(agent);
    const envelope = readJson(fileFor(agent, 'inbox', id));
    if (!envelope) throw new Error('letter not found: ' + id);
    await takeLetter(agent, envelope, caller);
    return read(agent, id);
  }
  async function deliverUnlocked(envelope, { route } = {}) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('invalid envelope');
    for (const key of ['route', 'route_snapshot', 'threadId', 'cwd', 'hostId', 'focusRevision', 'bindingRevision', 'publishedAt', 'scope'])
      if (Object.hasOwn(envelope, key)) throw new Error('envelope cannot declare trusted route: ' + key);
    // Where a letter goes is captured by the receiver from the explicit binding when it first sees it; nobody else sets it.
    if (route !== undefined) throw new Error('a route cannot be set at delivery: the receiver captures it from the explicit binding');
    envelope = JSON.parse(JSON.stringify(envelope));
    if (envelope.id === undefined) envelope.id = randomUUID();
    assertId(envelope.id);
    if (envelope.thread_id === undefined) envelope.thread_id = envelope.id;
    if (envelope.budget === undefined) envelope.budget = 'standard';
    const found = findId(envelope.id);
    if (envelope.created_at === undefined) envelope.created_at = found[0]?.envelope.created_at || new Date().toISOString();
    if (identity && envelope.from !== identity) throw new Error('configured sender identity mismatch');
    agentName(envelope.from); agentName(envelope.to); assertId(envelope.thread_id);
    for (const key of ['subject', 'body', 'created_at']) if (typeof envelope[key] !== 'string' || !envelope[key].trim()) throw new Error('missing string field: ' + key);
    if (!['task', 'result', 'ping'].includes(envelope.type)) throw new Error('invalid envelope type');
    if (!['urgent', 'standard', 'high', 'free'].includes(envelope.budget)) throw new Error('invalid envelope budget');
    if (!Number.isFinite(Date.parse(envelope.created_at))) throw new Error('invalid created_at');
    if (envelope.reply_to !== undefined) assertId(envelope.reply_to);
    if (envelope.outcome !== undefined && !['completed', 'needs_authorization', 'failed'].includes(envelope.outcome)) throw new Error('invalid outcome');
    for (const key of ['commit', 'base_rev', 'test']) if (envelope[key] !== undefined && typeof envelope[key] !== 'string') throw new Error('invalid metadata: ' + key);
    if (envelope.attachments !== undefined && !Array.isArray(envelope.attachments)) throw new Error('attachments must be an array');
    const warnings = envelope.body.length > 200 ? ['body exceeds 200 character soft limit; use attachments'] : [];
    for (const attachment of envelope.attachments || []) {
      const file = safePath(safePath(root, 'attachments'), attachment);
      try { if (!fs.statSync(file).isFile()) throw new Error('attachment is not a file'); }
      catch (error) { if (error.code === 'ENOENT') warnings.push('missing attachment: ' + attachment); else throw error; }
    }
    const target = fileFor(envelope.to, 'inbox', envelope.id);
    if (found.length) {
      if (found.some(existing => canonical(existing.envelope) !== canonical(envelope))) throw new Error('message ID content conflict: ' + envelope.id);
      const delivered = found.find(existing => existing.bucket !== 'outbox');
      if (delivered) return { id: envelope.id, delivered_to: delivered.file, idempotent: true, warnings };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await recordArrival(envelope);
    await atomicWrite(target, JSON.stringify(envelope, null, 2) + '\n');
    return { id: envelope.id, delivered_to: target, idempotent: false, warnings };
  }
  async function deliver(envelope, options) {
    const snapshot = JSON.parse(JSON.stringify(envelope));
    const routing = options === undefined ? undefined : JSON.parse(JSON.stringify(options));
    return locked(() => deliverUnlocked(snapshot, routing));
  }
  function archiveUnlocked(agent, id) {
    own(agent);
    const source = fileFor(agent, 'inbox', id);
    const destination = fileFor(agent, 'archive', id);
    const input = readJson(source);
    const existing = readJson(destination);
    if (!input && !existing) throw new Error('letter not found: ' + id);
    if (existing) {
      if (input && canonical(input) !== canonical(existing)) throw new Error('archive content conflict: ' + id);
      if (input) fs.unlinkSync(source);
      return { archived: id, idempotent: true };
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    return { archived: id, idempotent: false };
  }
  async function archive(agent, id, { caller } = {}) {
    own(agent);
    // After a crash the letter may already be archived: its claim is still found, and the owner's retry finishes it.
    const envelope = readJson(fileFor(agent, 'inbox', id)) ?? readJson(fileFor(agent, 'archive', id));
    const owner = envelope ? await takeLetter(agent, envelope, caller) : null;
    if (owner) await beginCompletionFor(agent, id, owner, { op: 'archive' });
    const archived = await locked(() => archiveUnlocked(agent, id));
    if (owner) archived.ledger = ledgerOutcome(await complete(sessions, agent, id, owner));
    return archived;
  }
  const ledgerOutcome = completed => (completed.ok ? 'done' : completed.reason);
  async function reply(agent, input, { caller } = {}) {
    own(agent);
    const options = JSON.parse(JSON.stringify(input));
    assertId(options.reply_to);
    if (options.reply_id !== undefined) assertId(options.reply_id);
    if (typeof options.body !== 'string' || !options.body.trim()) throw new Error('reply body is required');
    const outcome = options.outcome ?? 'completed';
    if (!['completed', 'needs_authorization', 'failed'].includes(outcome)) throw new Error('invalid reply outcome');
    // Take the letter in the shared claim ledger, and write a terminal completion ahead, before any result is published.
    // After a crash the original may already be archived: the owner's retry still finds its claim and finishes it.
    const original = readJson(fileFor(agent, 'inbox', options.reply_to)) ?? readJson(fileFor(agent, 'archive', options.reply_to));
    const owner = original ? await takeLetter(agent, original, caller) : null;
    const terminal = outcome !== 'needs_authorization';
    if (owner && terminal) {
      const result = options.reply_id ?? `${options.reply_to}.result`;
      await beginCompletionFor(agent, options.reply_to, owner, { op: 'reply', result, digest: replyDigest(options, outcome) });
    }
    const replied = await publishReply(agent, options, outcome);
    if (owner && terminal) replied.ledger = ledgerOutcome(await complete(sessions, agent, options.reply_to, owner));
    return replied;
  }
  function publishReply(agent, options, outcome) {
    return locked(async () => {
      const pending = readJson(fileFor(agent, 'inbox', options.reply_to));
      const source = pending || readJson(fileFor(agent, 'archive', options.reply_to));
      if (!source) throw new Error('original letter not found: ' + options.reply_to);
      if (source.to !== agent || source.type === 'result') throw new Error('invalid original letter or reply loop');
      const terminal = outcome !== 'needs_authorization';
      const id = options.reply_id ?? (terminal ? `${source.id}.result` : `${source.id}.result.${randomUUID()}`);
      assertId(id);
      if (!terminal && id === `${source.id}.result`) throw new Error('nonterminal reply requires an independent reply ID');
      const previous = findId(id);
      if (!pending && !previous.length) throw new Error('archived task cannot create a new reply');
      const envelope = { id, thread_id: source.thread_id, from: agent, to: source.from,
        type: 'result', subject: options.subject ?? `回执: ${source.subject}`, body: options.body,
        budget: source.budget, created_at: previous[0]?.envelope.created_at || new Date().toISOString(),
        reply_to: source.id, outcome };
      for (const key of ['commit', 'base_rev', 'test', 'attachments']) if (options[key] !== undefined) envelope[key] = options[key];
      const result = await deliverUnlocked(envelope);
      if (terminal) {
        // The result is already public here; an archive failure must not read as "reply failed".
        try { Object.assign(result, archiveUnlocked(agent, source.id), { idempotent: result.idempotent }); }
        catch (error) {
          const fault = new Error(`replied but archive pending (已回执但待归档): result ${id} was delivered; `
            + `original ${source.id} was not archived (${error.message}). After an authorized operator fixes access, `
            + 'retry the same mailbox_reply or mailbox_archive to finish.', { cause: error });
          fault.code = 'REPLIED_ARCHIVE_PENDING';
          fault.reply = { ...result, id, outcome };
          fault.pending = source.id;
          throw fault;
        }
      }
      return { ...result, id, outcome };
    });
  }
  function roster() {
    return agents().sort().map(agent => ({ agent,
      inbox: listFiles(safePath(root, path.join('agents', agent, 'inbox'))).filter(f => f.endsWith('.json')).length,
      archive: listFiles(safePath(root, path.join('agents', agent, 'archive'))).filter(f => f.endsWith('.json')).length,
    }));
  }
  return { deliver, inbox, read, take, reply, archive, roster };
}
