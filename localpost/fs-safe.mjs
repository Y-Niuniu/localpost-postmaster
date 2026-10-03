import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function assertId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value))
    throw new Error('Invalid LocalPost identifier');
  return value;
}

const inside = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

// Validate existing ancestors too: lexical containment alone does not stop junctions.
// GetFinalPathNameByHandle can return the \\\\?\\ (or \\\\?\\UNC\\) spelling of a path it resolved
// while another process was creating or unlinking that entry. Comparing that spelling against a
// plain DOS path made ordinary lock contention look like a junction escape, so normalise first.
const normalizeFinal = value => value.startsWith('\\\\?\\UNC\\') ? '\\\\' + value.slice(8)
  : value.startsWith('\\\\?\\') ? value.slice(4) : value;

export function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) ||
      relative.split(/[\\/]/).some(x => x === '..')) throw new Error('Path escapes mailbox root');
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (!inside(base, target)) throw new Error('Path escapes mailbox root');
  const realBase = fs.existsSync(base) ? normalizeFinal(fs.realpathSync.native(base)) : base;
  let cursor = base;
  for (const segment of path.relative(base, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      // Only reparse points (symlinks and junctions) can redirect outside the root. Re-resolving
      // ordinary files proved unreliable while another process was creating or unlinking them
      // (Windows returned the \\? volume form and occasional EBADF), which turned normal lock
      // contention into a bogus "escapes root" failure. Reparse points are still validated.
      if (fs.lstatSync(cursor).isSymbolicLink() &&
          !inside(realBase, normalizeFinal(fs.realpathSync.native(cursor)))) {
        throw new Error('Linked path escapes mailbox root');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

// Windows briefly refuses a replacing rename while another writer, a scanner or an indexer holds the
// target. Retry only those refusals, a bounded number of times (about 1.3 s in total), then fail loudly.
const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
export const RENAME_ATTEMPTS = 8;
async function renameReplacing(from, to) {
  for (let attempt = 1; ; attempt++) {
    try { return await fsp.rename(from, to); }
    catch (error) {
      if (!TRANSIENT_RENAME.has(error.code) || attempt >= RENAME_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, 5 * 2 ** attempt));
    }
  }
}

export async function atomicWrite(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fsp.open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    await renameReplacing(temporary, file);
  } finally {
    if (handle) await handle.close();
    await fsp.rm(temporary, { force: true });
  }
}

function dead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
const TRANSIENT_LEASE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
// A lock file that stays empty means its creator died between the exclusive create and the
// owner write. Past this grace period that is a real fault, not a busy lock.
export const EMPTY_LOCK_GRACE_MS = 5000;
const RELEASE_ATTEMPTS = 5;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isTransientLeaseError = error => Boolean(error) && TRANSIENT_LEASE_ERRORS.has(error.code);
async function readOwner(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    // A lock file that exists but is still empty is being written right now - not corrupt.
    if (raw.trim() === '') {
      const stats = await fsp.stat(file).catch(() => null);
      return { transient: true, empty: true, emptySince: stats ? stats.mtimeMs : 0 };
    }
    return JSON.parse(raw);
  }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    // Windows keeps a freshly unlinked lock in "delete pending" for a moment. A transient
    // EPERM/EACCES/EBUSY says nothing about the owner's validity, so it must never be
    // reported as a corrupt lock (that misreport made concurrent sends look like failures).
    if (isTransientLeaseError(error)) return { transient: true };
    return { invalid: true };
  }
}
async function unlinkOwned(file, token) {
  let lastError;
  for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt += 1) {
    try {
      const current = await readOwner(file);
      // A transient read (or an empty file still being written) says nothing about the owner, so
      // retry briefly - but never report success: silently skipping the unlink leaks a lock that
      // its still-live owner can never reclaim.
      if (current?.transient) {
        lastError = Object.assign(new Error('transient lock read during release'), { code: 'EBUSY' });
        await sleep(attempt * 10);
        continue;
      }
      if (current?.token === token) await fsp.unlink(file);
      return { released: true };
    } catch (error) {
      if (error.code === 'ENOENT') return { released: true };
      if (!isTransientLeaseError(error)) throw error;
      lastError = error;
      await sleep(attempt * 10);
    }
  }
  throw Object.assign(new Error('Lease release could not be confirmed: ' + (lastError?.code || 'transient')), { code: 'LEASE_RELEASE_UNCERTAIN' });
}
async function createOwner(file, now) {
  const token = randomUUID();
  let handle;
  try {
    handle = await fsp.open(file, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ token, pid: process.pid, started_at: Number(now) }), 'utf8');
    await handle.sync(); await handle.close(); handle = undefined;
    return { acquired: true, reason: 'acquired', release: () => unlinkOwned(file, token) };
  } catch (error) {
    if (handle) { await handle.close(); await unlinkOwned(file, token); }
    if (error.code === 'EEXIST' || isTransientLeaseError(error)) return null;
    throw error;
  }
}
const busy = reason => ({ acquired: false, reason, release: async () => {} });

export async function acquireLease(root, { name = '.postmaster.lock', staleMs = 300000, now = Date.now() } = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid lease name');
  await fsp.mkdir(root, { recursive: true });
  let file;
  try { file = safePath(root, name); }
  catch (error) { if (isTransientLeaseError(error)) return busy('busy'); throw error; }
  const owner = await createOwner(file, now);
  if (owner) return owner;
  const previous = await readOwner(file);
  const stale = x => {
    const started = typeof x?.started_at === 'number' ? x.started_at : Date.parse(x?.started_at);
    return x && !x.invalid && Number.isFinite(started) && Number(now) - started > staleMs && dead(x.pid);
  };
  if (!stale(previous)) {
    const emptyFor = previous?.empty ? Number(now) - Number(previous.emptySince || 0) : 0;
    if (previous?.empty && emptyFor > EMPTY_LOCK_GRACE_MS) return busy('invalid_owner_needs_reconcile');
    return busy(previous?.invalid ? 'invalid_owner_needs_reconcile' : 'busy');
  }
  // Serialize stale recovery. A live owner is never stolen, even beyond its TTL.
  let gateFile;
  try { gateFile = safePath(root, `${name}.reclaim`); }
  catch (error) { if (isTransientLeaseError(error)) return busy('busy'); throw error; }
  const gate = await createOwner(gateFile, now);
  if (!gate) return busy('recovery_busy_needs_reconcile');
  try {
    const current = await readOwner(file);
    if (current && !stale(current)) return busy('busy');
    if (current) await fsp.unlink(file);
  } finally { await gate.release(); }
  // Create the new main lock only after the gate is released. If the release throws, this actor has
  // not created a main lock yet, so it never strands one that it owns but holds no lease for.
  // From here it is an ordinary exclusive create: whoever gets there first wins, the rest are busy.
  return await createOwner(file, now) || busy('busy');
}
