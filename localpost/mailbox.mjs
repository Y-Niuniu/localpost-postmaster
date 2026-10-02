import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { acquireLease, atomicWrite, assertId, safePath } from './fs-safe.mjs';

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
  async function deliverUnlocked(envelope, { route } = {}) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('invalid envelope');
    for (const key of ['route', 'route_snapshot', 'threadId', 'cwd', 'hostId', 'focusRevision', 'publishedAt', 'scope'])
      if (Object.hasOwn(envelope, key)) throw new Error('envelope cannot declare trusted route: ' + key);
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
    if (route) {
      if (typeof route.threadId !== 'string' || !route.threadId || typeof route.hostId !== 'string' || !route.hostId ||
          typeof route.cwd !== 'string' || !path.isAbsolute(route.cwd) ||
          !['string', 'number'].includes(typeof route.focusRevision) ||
          (typeof route.focusRevision === 'number' && !Number.isFinite(route.focusRevision)) ||
          !Number.isFinite(Date.parse(route.publishedAt)) || (route.scope !== undefined && route.scope !== 'analysis-reply'))
        throw new Error('invalid trusted route snapshot');
      const routeFile = safePath(root, path.join('runtime', 'routes', envelope.id + '.json'));
      const digest = envelopeDigest(envelope);
      const existingRoute = readJson(routeFile);
      if (existingRoute) {
        if (existingRoute.envelopeDigest !== digest) throw new Error('orphan route content conflict; needs reconcile');
      } else {
        await atomicWrite(routeFile, JSON.stringify({ threadId: route.threadId, cwd: route.cwd, hostId: route.hostId,
          focusRevision: route.focusRevision, publishedAt: route.publishedAt, scope: 'analysis-reply',
          messageId: envelope.id, from: envelope.from, to: envelope.to, envelopeDigest: digest }, null, 2) + '\n');
      }
    }
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
  async function archive(agent, id) { return locked(() => archiveUnlocked(agent, id)); }
  async function reply(agent, input) {
    own(agent);
    const options = JSON.parse(JSON.stringify(input));
    assertId(options.reply_to);
    if (typeof options.body !== 'string' || !options.body.trim()) throw new Error('reply body is required');
    const outcome = options.outcome ?? 'completed';
    if (!['completed', 'needs_authorization', 'failed'].includes(outcome)) throw new Error('invalid reply outcome');
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
  return { deliver, inbox, read, reply, archive, roster };
}
