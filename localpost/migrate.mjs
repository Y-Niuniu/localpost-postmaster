/**
 * LocalPost 迁移快照工具
 *
 * 目的：迁移（rebuild / 部署 / 内核替换）之前的证据必须**独立、不可覆盖、可校验、可恢复**。
 * 运行期内核每轮滚动覆盖 ledger.json.bak —— 那只是当轮安全副本，
 * **不能**当作唯一历史证据（覆盖一次，证据就没了）。
 *
 * 用法：
 *   node localpost/migrate.mjs snapshot --root <信箱根> [--label pre-migration]
 *   node localpost/migrate.mjs list     --root <信箱根>
 *   node localpost/migrate.mjs verify   --root <信箱根> --snapshot <相对路径>
 *   node localpost/migrate.mjs restore  --root <信箱根> --snapshot <相对路径> [--apply]
 *
 * 语义：
 * - snapshot 目录名 = runtime/snapshots/<UTC 时间戳>-<label>；已存在则**拒绝覆盖**并报错。
 * - manifest.json 记录每个受管文件的 SHA-256 与当时的信封清单（含逐封 SHA-256）。
 * - verify 只校验快照自身完整性（是否被改动/被截断）。
 * - restore 默认只预览；--apply 才写回，写前先校验完整性，被篡改则拒绝。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquireLease, atomicWrite, safePath } from './fs-safe.mjs';

export const SNAPSHOT_SCHEMA = 'localpost-migration-snapshot-v1';
const MANAGED = ['ledger.json', 'alerts.json', 'postmaster.config.json'];
const SNAPSHOT_ROOT = 'runtime/snapshots';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

async function listing(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function stamp(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

async function readManaged(root, name) {
  try { return await fsp.readFile(safePath(root, name), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function envelopeInventory(root) {
  const inventory = [];
  for (const agent of await listing(safePath(root, 'agents'))) {
    if (!agent.isDirectory()) continue;
    for (const folder of ['inbox', 'outbox', 'archive']) {
      for (const item of await listing(safePath(root, `agents/${agent.name}/${folder}`))) {
        if (!item.isFile() || !item.name.toLowerCase().endsWith('.json')) continue;
        const relative = `agents/${agent.name}/${folder}/${item.name}`;
        const text = await fsp.readFile(safePath(root, relative), 'utf8');
        inventory.push({ path: relative, bytes: Buffer.byteLength(text), sha256: sha256(text) });
      }
    }
  }
  return inventory.sort((a, b) => a.path.localeCompare(b.path));
}

function readManifest(dir) {
  return fsp.readFile(path.join(dir, 'manifest.json'), 'utf8').then(JSON.parse).catch((error) => {
    throw new Error('Snapshot manifest is missing or unreadable: ' + error.message);
  });
}

// 独立、不可覆盖：同 label 同毫秒才可能撞名，撞了就拒绝而不是覆盖。
export async function createSnapshot({ root, label = 'pre-migration', now = Date.now() } = {}) {
  if (!root) throw new Error('Snapshot requires an explicit mailbox root');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(label)) throw new Error('Invalid snapshot label');
  root = path.resolve(root);
  const relative = `${SNAPSHOT_ROOT}/${stamp(now)}-${label}`;
  const dir = safePath(root, relative);
  if (fs.existsSync(dir)) throw new Error('Snapshot already exists; refusing to overwrite: ' + relative);
  await fsp.mkdir(dir, { recursive: true });
  const files = [];
  for (const name of MANAGED) {
    const text = await readManaged(root, name);
    if (text === null) { files.push({ name, present: false }); continue; }
    await atomicWrite(path.join(dir, name), text);
    files.push({ name, present: true, bytes: Buffer.byteLength(text), sha256: sha256(text) });
  }
  const manifest = {
    schema: SNAPSHOT_SCHEMA, root, label, created_at: new Date(now).toISOString(),
    managed: files, envelopes: await envelopeInventory(root),
  };
  await atomicWrite(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { path: relative, dir, manifest };
}

export async function listSnapshots({ root } = {}) {
  if (!root) throw new Error('Snapshot listing requires an explicit mailbox root');
  root = path.resolve(root);
  const items = [];
  for (const entry of await listing(safePath(root, SNAPSHOT_ROOT))) {
    if (!entry.isDirectory()) continue;
    const relative = `${SNAPSHOT_ROOT}/${entry.name}`;
    try { items.push({ path: relative, label: (await readManifest(safePath(root, relative))).label }); }
    catch (error) { items.push({ path: relative, label: null, error: error.message }); }
  }
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

// 校验快照自身：受管文件是否还在、字节与哈希是否与 manifest 一致。
export async function verifySnapshot({ root, snapshot } = {}) {
  if (!root || !snapshot) throw new Error('verify requires root and snapshot');
  root = path.resolve(root);
  const dir = safePath(root, snapshot);
  const manifest = await readManifest(dir);
  const problems = [];
  for (const entry of manifest.managed || []) {
    const text = await fsp.readFile(path.join(dir, entry.name), 'utf8').catch(() => null);
    if (!entry.present) {
      if (text !== null) problems.push({ name: entry.name, reason: 'manifest says absent but a copy exists' });
      continue;
    }
    if (text === null) { problems.push({ name: entry.name, reason: 'copy missing' }); continue; }
    if (sha256(text) !== entry.sha256) problems.push({ name: entry.name, reason: 'content hash mismatch' });
    else if (Buffer.byteLength(text) !== entry.bytes) problems.push({ name: entry.name, reason: 'byte length mismatch' });
  }
  return { ok: problems.length === 0, path: snapshot, created_at: manifest.created_at, files: (manifest.managed || []).length, envelopes: (manifest.envelopes || []).length, problems };
}

// 默认预览；apply 才写回。写回前必须自校验，且整个写回持有信箱写锁。
export async function restoreSnapshot({ root, snapshot, apply = false, now = Date.now() } = {}) {
  if (!root || !snapshot) throw new Error('restore requires root and snapshot');
  root = path.resolve(root);
  const dir = safePath(root, snapshot);
  const manifest = await readManifest(dir);
  const verified = await verifySnapshot({ root, snapshot });
  if (!verified.ok) throw new Error('Snapshot failed integrity check; refusing to restore');
  const plan = [];
  for (const entry of manifest.managed || []) {
    if (!entry.present) { plan.push({ name: entry.name, action: 'skip-absent-at-snapshot-time' }); continue; }
    const copy = await fsp.readFile(path.join(dir, entry.name), 'utf8');
    const current = await readManaged(root, entry.name);
    plan.push({ name: entry.name, action: current === null ? 'create' : current === copy ? 'unchanged' : 'overwrite', sha256: entry.sha256 });
  }
  const result = { dry_run: !apply, path: snapshot, verified, plan, restored: [] };
  if (!apply) return result;
  const lease = await acquireLease(root, { name: '.mailbox-write.lock', now: Number(now) });
  if (!lease.acquired) return { ...result, skipped: true, reason: lease.reason };
  try {
    for (const entry of manifest.managed || []) {
      if (!entry.present) continue;
      await atomicWrite(safePath(root, entry.name), await fsp.readFile(path.join(dir, entry.name), 'utf8'));
      result.restored.push(entry.name);
    }
    // 写回后两件事都要验：(a) 快照自身仍完整；(b) 目标文件字节等于清单哈希。
    result.after = await verifySnapshot({ root, snapshot });
    const mismatches = [];
    for (const entry of manifest.managed || []) {
      if (!entry.present) continue;
      const text = await readManaged(root, entry.name);
      if (text === null || sha256(text) !== entry.sha256) mismatches.push(entry.name);
    }
    result.targetVerified = { ok: mismatches.length === 0, checked: (manifest.managed || []).filter((x) => x.present).length, mismatches };
    return result;
  } finally { await lease.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const root = value('--root');
  const command = args[0];
  const run = async () => {
    if (command === 'snapshot') return createSnapshot({ root, label: value('--label') || 'pre-migration' });
    if (command === 'list') return listSnapshots({ root });
    if (command === 'verify') return verifySnapshot({ root, snapshot: value('--snapshot') });
    if (command === 'restore') return restoreSnapshot({ root, snapshot: value('--snapshot'), apply: args.includes('--apply') });
    throw new Error('Usage: migrate.mjs snapshot|list|verify|restore --root <root> [--label x] [--snapshot rel] [--apply]');
  };
  run().then((out) => { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); process.exitCode = out && out.ok === false ? 1 : 0; })
    .catch((error) => { console.error(error.message); process.exitCode = 2; });
}
