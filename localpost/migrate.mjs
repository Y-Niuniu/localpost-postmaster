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
 * - snapshot 目录名 = runtime/snapshots/<UTC 时间戳>-<label>，用排他 mkdir 原子创建：
 *   同名（含同毫秒并发）只有一个调用成功，其余明确报错，**绝不覆盖**。
 * - manifest.json 按**原始字节**记录每个受管文件的 present/bytes/SHA-256 与当时的信封清单（含逐封 SHA-256）。
 * - verify 先严格校验 manifest 结构（封闭 schema：缺字段、多字段、类型不符都算失败），再逐字节校验副本。
 * - restore 默认只预览；--apply 才写回，写前先过同一套校验，失败则拒绝；只写回已校验过的那份字节。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquireLease, atomicWrite, safePath } from './fs-safe.mjs';

export const SNAPSHOT_SCHEMA = 'localpost-migration-snapshot-v1';
const MANAGED = ['ledger.json', 'alerts.json', 'postmaster.config.json'];
const MANIFEST_FIELDS = ['schema', 'root', 'label', 'created_at', 'managed', 'envelopes'];
const SNAPSHOT_ROOT = 'runtime/snapshots';
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENVELOPE_PATH = /^agents\/[^/\\]+\/(?:inbox|outbox|archive)\/[^/\\]+$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function listing(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function stamp(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

// 一律按原始字节读写：bytes/sha256 必须描述磁盘上的真实字节。
// 按 utf8 解码再编码会把非 UTF-8 字节替换成 U+FFFD，快照、校验、恢复就都不再保真。
async function readBytes(file) {
  try { return await fsp.readFile(file); }
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
        const bytes = await fsp.readFile(safePath(root, relative));
        inventory.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
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

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactly = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function managedEntryProblem(entry) {
  if (!isRecord(entry) || !MANAGED.includes(entry.name)) return 'unknown managed entry';
  if (entry.present === false) return hasExactly(entry, ['name', 'present']) ? null : 'absent entry must not carry other fields';
  if (entry.present !== true) return 'present must be a boolean';
  if (!hasExactly(entry, ['name', 'present', 'bytes', 'sha256'])) return 'present entry must have exactly name/present/bytes/sha256';
  if (!isCount(entry.bytes)) return 'bytes must be a non-negative integer';
  return isDigest(entry.sha256) ? null : 'sha256 must be 64 lowercase hex characters';
}

function envelopeEntryProblem(entry) {
  if (!isRecord(entry) || !hasExactly(entry, ['path', 'bytes', 'sha256'])) return 'entry must have exactly path/bytes/sha256';
  if (typeof entry.path !== 'string' || !ENVELOPE_PATH.test(entry.path) || !entry.path.toLowerCase().endsWith('.json')) return 'invalid envelope path';
  if (!isCount(entry.bytes)) return 'bytes must be a non-negative integer';
  return isDigest(entry.sha256) ? null : 'sha256 must be 64 lowercase hex characters';
}

// manifest 只由本工具生成，结构是封闭的：缺字段、多字段、类型不符、受管清单不全，一律视为被改动。
function manifestProblems(manifest) {
  if (!isRecord(manifest)) return ['manifest is not a JSON object'];
  const problems = [];
  if (!hasExactly(manifest, MANIFEST_FIELDS)) problems.push('manifest must have exactly ' + MANIFEST_FIELDS.join('/'));
  if (manifest.schema !== SNAPSHOT_SCHEMA) problems.push('unsupported schema');
  if (typeof manifest.root !== 'string' || !path.isAbsolute(manifest.root)) problems.push('root must be an absolute path');
  if (typeof manifest.label !== 'string' || !LABEL.test(manifest.label)) problems.push('invalid label');
  const created = typeof manifest.created_at === 'string' ? Date.parse(manifest.created_at) : NaN;
  if (!Number.isFinite(created) || new Date(created).toISOString() !== manifest.created_at) problems.push('created_at must be a canonical ISO timestamp');
  if (!Array.isArray(manifest.managed)) problems.push('managed must be an array');
  else {
    manifest.managed.forEach((entry, index) => {
      const problem = managedEntryProblem(entry);
      if (problem) problems.push(`managed[${index}]: ${problem}`);
    });
    const names = manifest.managed.map((entry) => entry?.name);
    if (names.length !== MANAGED.length || !MANAGED.every((name) => names.includes(name)))
      problems.push('managed must list each of ' + MANAGED.join('/') + ' exactly once');
  }
  if (!Array.isArray(manifest.envelopes)) problems.push('envelopes must be an array');
  else {
    manifest.envelopes.forEach((entry, index) => {
      const problem = envelopeEntryProblem(entry);
      if (problem) problems.push(`envelopes[${index}]: ${problem}`);
    });
    if (new Set(manifest.envelopes.map((entry) => entry?.path)).size !== manifest.envelopes.length) problems.push('duplicate envelope path');
  }
  return problems;
}

// verify 与 restore 共用这一次判定：manifest 只读一次，副本只读一次。
// restore 写回的就是这里校验过的字节 —— 不存在「校验的是一份、写回的是另一份」的窗口。
async function inspectSnapshot(root, snapshot) {
  const dir = safePath(root, snapshot);
  const manifest = await readManifest(dir);
  const problems = manifestProblems(manifest).map((reason) => ({ name: 'manifest.json', reason }));
  const copies = new Map();
  if (problems.length) return { manifest, copies, problems };
  for (const entry of manifest.managed) {
    const bytes = await readBytes(path.join(dir, entry.name));
    if (!entry.present) {
      if (bytes !== null) problems.push({ name: entry.name, reason: 'manifest says absent but a copy exists' });
      continue;
    }
    if (bytes === null) problems.push({ name: entry.name, reason: 'copy missing' });
    else if (sha256(bytes) !== entry.sha256) problems.push({ name: entry.name, reason: 'content hash mismatch' });
    else if (bytes.length !== entry.bytes) problems.push({ name: entry.name, reason: 'byte length mismatch' });
    else copies.set(entry.name, bytes);
  }
  return { manifest, copies, problems };
}

function summarize(snapshot, { manifest, problems }) {
  const count = (key) => (Array.isArray(manifest?.[key]) ? manifest[key].length : 0);
  return { ok: problems.length === 0, path: snapshot, created_at: manifest?.created_at, files: count('managed'), envelopes: count('envelopes'), problems };
}

// 独立、不可覆盖：快照目录用排他 mkdir 原子创建，同名（含同毫秒并发）只有一个调用能建成，
// 其余拿到 EEXIST 直接报错。不能先 existsSync 再 mkdir：两步之间有竞态窗口，
// 而 recursive mkdir 遇到已存在的目录不报错 —— 并发者会互相覆盖副本与 manifest。
export async function createSnapshot({ root, label = 'pre-migration', now = Date.now() } = {}) {
  if (!root) throw new Error('Snapshot requires an explicit mailbox root');
  if (typeof label !== 'string' || !LABEL.test(label)) throw new Error('Invalid snapshot label');
  root = path.resolve(root);
  const relative = `${SNAPSHOT_ROOT}/${stamp(now)}-${label}`;
  const dir = safePath(root, relative);
  await fsp.mkdir(path.dirname(dir), { recursive: true });
  try { await fsp.mkdir(dir); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Snapshot already exists; refusing to overwrite: ' + relative);
    throw error;
  }
  const files = [];
  for (const name of MANAGED) {
    const bytes = await readBytes(safePath(root, name));
    if (bytes === null) { files.push({ name, present: false }); continue; }
    await atomicWrite(path.join(dir, name), bytes);
    files.push({ name, present: true, bytes: bytes.length, sha256: sha256(bytes) });
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

// 校验快照自身：manifest 结构是否完好、受管副本是否还在、字节与哈希是否与 manifest 一致。
export async function verifySnapshot({ root, snapshot } = {}) {
  if (!root || !snapshot) throw new Error('verify requires root and snapshot');
  return summarize(snapshot, await inspectSnapshot(path.resolve(root), snapshot));
}

// 默认预览；apply 才写回。写回前必须通过与 verify 相同的校验，且整个写回持有信箱写锁。
export async function restoreSnapshot({ root, snapshot, apply = false, now = Date.now() } = {}) {
  if (!root || !snapshot) throw new Error('restore requires root and snapshot');
  root = path.resolve(root);
  const inspection = await inspectSnapshot(root, snapshot);
  const verified = summarize(snapshot, inspection);
  if (!verified.ok) throw new Error('Snapshot failed integrity check; refusing to restore');
  const { manifest, copies } = inspection;
  const plan = [];
  for (const entry of manifest.managed) {
    if (!entry.present) { plan.push({ name: entry.name, action: 'skip-absent-at-snapshot-time' }); continue; }
    const current = await readBytes(safePath(root, entry.name));
    plan.push({ name: entry.name, action: current === null ? 'create' : current.equals(copies.get(entry.name)) ? 'unchanged' : 'overwrite', sha256: entry.sha256 });
  }
  const result = { dry_run: !apply, path: snapshot, verified, plan, restored: [] };
  if (!apply) return result;
  const lease = await acquireLease(root, { name: '.mailbox-write.lock', now: Number(now) });
  if (!lease.acquired) return { ...result, skipped: true, reason: lease.reason };
  try {
    const kept = manifest.managed.filter((entry) => entry.present);
    for (const entry of kept) {
      await atomicWrite(safePath(root, entry.name), copies.get(entry.name));
      result.restored.push(entry.name);
    }
    // 写回后两件事都要验：(a) 快照自身仍完整；(b) 目标文件字节等于清单哈希。
    result.after = await verifySnapshot({ root, snapshot });
    const mismatches = [];
    for (const entry of kept) {
      const bytes = await readBytes(safePath(root, entry.name));
      if (bytes === null || sha256(bytes) !== entry.sha256) mismatches.push(entry.name);
    }
    result.targetVerified = { ok: mismatches.length === 0, checked: kept.length, mismatches };
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
