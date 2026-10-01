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
export function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) ||
      relative.split(/[\\/]/).some(x => x === '..')) throw new Error('Path escapes mailbox root');
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (!inside(base, target)) throw new Error('Path escapes mailbox root');
  const realBase = fs.existsSync(base) ? fs.realpathSync.native(base) : base;
  let cursor = base;
  for (const segment of path.relative(base, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      fs.lstatSync(cursor);
      if (!inside(realBase, fs.realpathSync.native(cursor))) throw new Error('Linked path escapes mailbox root');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
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
    await fsp.rename(temporary, file);
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
async function readOwner(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; return { invalid: true }; }
}
async function unlinkOwned(file, token) {
  const current = await readOwner(file);
  if (current?.token === token) await fsp.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
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
    if (error.code !== 'EEXIST') throw error;
    return null;
  }
}
const busy = reason => ({ acquired: false, reason, release: async () => {} });

export async function acquireLease(root, { name = '.postmaster.lock', staleMs = 300000, now = Date.now() } = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid lease name');
  await fsp.mkdir(root, { recursive: true });
  const file = safePath(root, name);
  const owner = await createOwner(file, now);
  if (owner) return owner;
  const previous = await readOwner(file);
  const stale = x => {
    const started = typeof x?.started_at === 'number' ? x.started_at : Date.parse(x?.started_at);
    return x && !x.invalid && Number.isFinite(started) && Number(now) - started > staleMs && dead(x.pid);
  };
  if (!stale(previous)) return busy(previous?.invalid ? 'invalid_owner_needs_reconcile' : 'busy');
  // Serialize stale recovery. A live owner is never stolen, even beyond its TTL.
  const gateFile = safePath(root, `${name}.reclaim`);
  const gate = await createOwner(gateFile, now);
  if (!gate) return busy('recovery_busy_needs_reconcile');
  try {
    const current = await readOwner(file);
    if (current && !stale(current)) return busy('busy');
    if (current) await fsp.unlink(file);
    return await createOwner(file, now) || busy('busy');
  } finally { await gate.release(); }
}
