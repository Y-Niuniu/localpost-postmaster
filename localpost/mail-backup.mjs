import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { safePath } from './fs-safe.mjs'

// Full mail-data backup with a verifiable manifest, an isolated restore drill,
// and a rolling retention that never removes the last usable restore point.
//
// Design notes (2026-10-02, LocalPost v3.2 step 2):
//   - A snapshot is built in a staging directory, re-hashed there, and only then
//     promoted with a single rename, so a promoted snapshot either does not
//     exist or matches its manifest.
//   - Nothing is ever overwritten: a colliding snapshot name is an error.
//   - Pruning runs only after the newest snapshot verifies, and never deletes
//     the newest snapshot nor the last remaining one.
//   - No file content is printed; only paths, counts and hashes.

export const SCHEMA = 'localpost-mail-backup-v1'
const STAGING_PREFIX = '.staging-'
const MANIFEST = 'manifest.json'

function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function isExcluded(relative) {
  const name = path.posix.basename(relative).toLowerCase()
  return name.endsWith('.lock') || name.endsWith('.tmp')
}

async function sha256File(file) {
  const hash = createHash('sha256')
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(1 << 20)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/** Walk a tree and return sorted {path, bytes, sha256} entries plus skipped links. */
export async function hashTree(root) {
  const files = []
  const skipped = []
  async function walk(dir, prefix) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name
      const absolute = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) { skipped.push({ path: relative, reason: 'symbolic link' }); continue }
      if (entry.isDirectory()) { await walk(absolute, relative); continue }
      if (!entry.isFile()) { skipped.push({ path: relative, reason: 'not a regular file' }); continue }
      if (isExcluded(relative)) { skipped.push({ path: relative, reason: 'excluded pattern' }); continue }
      files.push({ path: relative, bytes: (await fs.stat(absolute)).size, sha256: await sha256File(absolute) })
    }
  }
  await walk(root, '')
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, skipped }
}

function compareTrees(expected, actual) {
  const differences = []
  const expectedMap = new Map(expected.map((x) => [x.path, x]))
  const actualMap = new Map(actual.map((x) => [x.path, x]))
  for (const item of expected) {
    const other = actualMap.get(item.path)
    if (!other) { differences.push({ path: item.path, reason: 'missing' }); continue }
    if (other.sha256 !== item.sha256) differences.push({ path: item.path, reason: 'content mismatch' })
    else if (other.bytes !== item.bytes) differences.push({ path: item.path, reason: 'size mismatch' })
  }
  for (const item of actual) {
    if (!expectedMap.has(item.path)) differences.push({ path: item.path, reason: 'unexpected extra file' })
  }
  return differences
}

async function copyTree(source, destination, files) {
  for (const item of files) {
    const from = safePath(source, item.path)
    const to = path.join(destination, ...item.path.split('/'))
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.copyFile(from, to)
  }
}

async function exists(target) {
  try { await fs.lstat(target); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

/** Read and structurally check a manifest. */
export async function readManifest(snapshot) {
  const raw = await fs.readFile(path.join(snapshot, MANIFEST), 'utf8')
  const manifest = JSON.parse(raw)
  if (manifest.schema !== SCHEMA) throw new Error('Unsupported manifest schema: ' + String(manifest.schema))
  if (!Array.isArray(manifest.files)) throw new Error('Manifest has no file list')
  return manifest
}

/** Re-hash a snapshot in place and compare it with its own manifest. */
export async function verifySnapshot(snapshot) {
  const manifest = await readManifest(snapshot)
  const expected = manifest.files.map((x) => ({ path: x.path, bytes: x.bytes, sha256: x.sha256 }))
  const { files, skipped } = await hashTree(snapshot)
  const actual = files.filter((x) => x.path !== MANIFEST)
  const differences = compareTrees(expected, actual)
  return {
    ok: differences.length === 0,
    snapshot,
    createdAt: manifest.created_at,
    expected: expected.length,
    actual: actual.length,
    differences,
    skipped: skipped.filter((x) => x.path !== MANIFEST),
  }
}

/** Build one full snapshot of a mailbox into a target directory. */
export async function backupMailbox({ source, target, now = new Date(), label }) {
  const createdAt = now.toISOString()
  const name = label || stamp(now)
  const final = path.join(target, name)
  const staging = path.join(target, STAGING_PREFIX + name)
  if (await exists(final)) throw new Error('Snapshot already exists, refusing to overwrite: ' + final)
  await fs.mkdir(target, { recursive: true })
  const { files, skipped } = await hashTree(source)
  if (files.length === 0) throw new Error('Source has no files to back up: ' + source)
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  try {
    await copyTree(source, staging, files)
    const staged = await hashTree(staging)
    const stagedFiles = staged.files.filter((x) => x.path !== MANIFEST)
    const differences = compareTrees(files, stagedFiles)
    if (differences.length) {
      throw new Error('Staged copy does not match source: ' + JSON.stringify(differences.slice(0, 5)))
    }
    const manifest = {
      schema: SCHEMA,
      created_at: createdAt,
      source: source.split(path.sep).join('/'),
      file_count: files.length,
      total_bytes: files.reduce((sum, x) => sum + x.bytes, 0),
      excluded: ['*.lock', '*.tmp'],
      skipped,
      files,
    }
    await fs.writeFile(path.join(staging, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    await fs.rename(staging, final)
    const verification = await verifySnapshot(final)
    return { snapshot: final, name, createdAt, fileCount: files.length, totalBytes: manifest.total_bytes, skipped, verification }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true })
    throw error
  }
}

/** Copy a snapshot back out into an isolated directory and prove it matches. */
export async function restoreSnapshot({ snapshot, dest }) {
  const manifest = await readManifest(snapshot)
  if (await exists(dest)) throw new Error('Restore destination already exists, refusing to overwrite: ' + dest)
  await fs.mkdir(dest, { recursive: true })
  const files = manifest.files.map((x) => ({ path: x.path, bytes: x.bytes, sha256: x.sha256 }))
  await copyTree(snapshot, dest, files)
  const { files: restored } = await hashTree(dest)
  const differences = compareTrees(files, restored)
  return { ok: differences.length === 0, dest, restored: restored.length, differences }
}

/** List snapshots newest-first; staging leftovers are reported separately. */
export async function listSnapshots(target) {
  let entries = []
  try { entries = await fs.readdir(target, { withFileTypes: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const snapshots = []
  const incomplete = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith(STAGING_PREFIX)) { incomplete.push(entry.name); continue }
    const dir = path.join(target, entry.name)
    try {
      const manifest = await readManifest(dir)
      snapshots.push({ name: entry.name, dir, createdAt: manifest.created_at, fileCount: manifest.file_count })
    } catch { incomplete.push(entry.name) }
  }
  snapshots.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  return { snapshots, incomplete }
}

/**
 * Roll a target back to the newest 'keep' verified snapshots.
 * Refuses to prune anything unless the newest snapshot verifies.
 */
export async function pruneSnapshots({ target, keep = 7 }) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a positive integer')
  const { snapshots, incomplete } = await listSnapshots(target)
  if (snapshots.length === 0) return { removed: [], kept: [], skipped: true, reason: 'no snapshots', incomplete }
  const newest = await verifySnapshot(snapshots[0].dir)
  if (!newest.ok) {
    return { removed: [], kept: snapshots.map((x) => x.name), skipped: true, reason: 'newest snapshot failed verification; refusing to prune', incomplete }
  }
  const removed = []
  for (const snapshot of snapshots.slice(keep)) {
    await fs.rm(snapshot.dir, { recursive: true, force: true })
    removed.push(snapshot.name)
  }
  return { removed, kept: snapshots.slice(0, keep).map((x) => x.name), skipped: false, incomplete }
}

function parseArguments(rest) {
  const options = { targets: [] }
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (token === '--source') options.source = rest[++index]
    else if (token === '--target') options.targets.push(rest[++index])
    else if (token === '--snapshot') options.snapshot = rest[++index]
    else if (token === '--dest') options.dest = rest[++index]
    else if (token === '--keep') options.keep = Number(rest[++index])
    else throw new Error('Unknown argument: ' + token)
  }
  return options
}

async function main(argv) {
  const [command, ...rest] = argv
  const options = parseArguments(rest)
  const source = path.resolve(options.source || process.env.LOCALPOST_MAILBOX || 'C:/AI_ASSIST/.mailbox')
  if (command === 'backup') {
    if (!options.targets.length) throw new Error('backup needs at least one --target')
    const keep = options.keep ?? 7
    let failed = 0
    for (const target of options.targets) {
      const resolved = path.resolve(target)
      try {
        const result = await backupMailbox({ source, target: resolved })
        const prune = await pruneSnapshots({ target: resolved, keep })
        console.log('BACKUP ok ' + result.snapshot)
        console.log('  files=' + result.fileCount + ' bytes=' + result.totalBytes + ' verified=' + result.verification.ok)
        if (result.skipped.length) console.log('  skipped=' + result.skipped.length + ' ' + JSON.stringify(result.skipped.slice(0, 5)))
        console.log('  kept=' + prune.kept.length + ' removed=' + (prune.removed.length ? prune.removed.join(',') : 'none') + (prune.skipped ? ' (prune skipped: ' + prune.reason + ')' : ''))
      } catch (error) {
        failed += 1
        console.log('BACKUP failed ' + resolved + ': ' + error.message)
      }
    }
    process.exitCode = failed ? 1 : 0
    return
  }
  if (command === 'verify') {
    if (!options.snapshot) throw new Error('verify needs --snapshot')
    const result = await verifySnapshot(path.resolve(options.snapshot))
    console.log((result.ok ? 'VERIFY ok ' : 'VERIFY failed ') + result.snapshot + ' files=' + result.actual + '/' + result.expected)
    if (!result.ok) console.log(JSON.stringify(result.differences.slice(0, 10), null, 2))
    process.exitCode = result.ok ? 0 : 1
    return
  }
  if (command === 'restore') {
    if (!options.snapshot || !options.dest) throw new Error('restore needs --snapshot and --dest')
    const result = await restoreSnapshot({ snapshot: path.resolve(options.snapshot), dest: path.resolve(options.dest) })
    console.log((result.ok ? 'RESTORE ok ' : 'RESTORE failed ') + result.dest + ' files=' + result.restored)
    if (!result.ok) console.log(JSON.stringify(result.differences.slice(0, 10), null, 2))
    process.exitCode = result.ok ? 0 : 1
    return
  }
  if (command === 'prune') {
    if (!options.targets.length) throw new Error('prune needs at least one --target')
    for (const target of options.targets) {
      const resolved = path.resolve(target)
      const result = await pruneSnapshots({ target: resolved, keep: options.keep ?? 7 })
      console.log('PRUNE ' + resolved + ' kept=' + result.kept.length + ' removed=' + (result.removed.length ? result.removed.join(',') : 'none') + (result.skipped ? ' skipped: ' + result.reason : ''))
    }
    return
  }
  if (command === 'status') {
    if (!options.targets.length) throw new Error('status needs at least one --target')
    for (const target of options.targets) {
      const resolved = path.resolve(target)
      const { snapshots, incomplete } = await listSnapshots(resolved)
      console.log('STATUS ' + resolved + ' snapshots=' + snapshots.length + (incomplete.length ? ' incomplete=' + incomplete.join(',') : ''))
      for (const snapshot of snapshots) console.log('  ' + snapshot.name + ' files=' + snapshot.fileCount + ' created=' + snapshot.createdAt)
    }
    return
  }
  throw new Error('Usage: mail-backup.mjs <backup|verify|restore|prune|status> [options]')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error('mail-backup: ' + error.message); process.exitCode = 2 })
}
