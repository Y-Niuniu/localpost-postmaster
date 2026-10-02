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

/** Parse a manifest created_at into epoch ms, or null when unusable. */
function parseCreatedAt(value) {
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * List snapshots, newest first **by manifest created_at** - never by directory
 * name, which is attacker-controlled text. Entries whose age cannot be
 * established are returned last and flagged, not hidden.
 */
export async function listSnapshots(target) {
  let entries = []
  try { entries = await fs.readdir(target, { withFileTypes: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const snapshots = []
  const staging = []
  const unreadable = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith(STAGING_PREFIX)) { staging.push(entry.name); continue }
    const dir = path.join(target, entry.name)
    try {
      const manifest = await readManifest(dir)
      const createdAt = manifest.created_at
      snapshots.push({ name: entry.name, dir, createdAt, time: parseCreatedAt(createdAt), usableTime: parseCreatedAt(createdAt) !== null, fileCount: manifest.file_count })
    } catch (error) {
      unreadable.push({ name: entry.name, reason: error.message })
    }
  }
  snapshots.sort((a, b) => {
    if (a.usableTime && b.usableTime && a.time !== b.time) return b.time - a.time
    if (a.usableTime !== b.usableTime) return a.usableTime ? -1 : 1
    return a.name < b.name ? 1 : a.name > b.name ? -1 : 0
  })
  return { snapshots, staging, unreadable }
}

export const RETENTION_DAYS_DEFAULT = 7
const DAY_MS = 24 * 60 * 60 * 1000
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000

/**
 * Keep every complete snapshot inside the retention window and always keep the
 * newest verified one.
 *
 * The window is measured from each manifest's own created_at, ordered by that
 * same value - the directory name is never trusted for age. A snapshot whose
 * age cannot be established (unreadable, invalid or future created_at) is never
 * deleted; it is reported as an anomaly for manual handling.
 *
 * Boundary rule: a snapshot created exactly at the cutoff instant is inside the
 * window and is kept. If no snapshot has a usable created_at, pruning refuses
 * to run at all rather than guess.
 */
export async function pruneSnapshots({ target, retentionDays = RETENTION_DAYS_DEFAULT, now = new Date() }) {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new Error('retentionDays must be a non-negative number')
  const { snapshots, staging, unreadable } = await listSnapshots(target)
  const report = { removed: [], kept: [], anomalies: [], staging, unreadable, skipped: false, reason: null }
  if (snapshots.length === 0) { report.skipped = true; report.reason = 'no snapshots'; return report }
  const aged = snapshots.filter((x) => x.usableTime)
  if (aged.length === 0) {
    report.skipped = true
    report.reason = 'no snapshot has a usable created_at; refusing to prune'
    report.kept = snapshots.map((x) => x.name)
    for (const snapshot of snapshots) report.anomalies.push({ name: snapshot.name, reason: 'invalid created_at; kept for manual handling' })
    return report
  }
  const newest = await verifySnapshot(aged[0].dir)
  if (!newest.ok) {
    report.skipped = true
    report.reason = 'newest snapshot failed verification; refusing to prune'
    report.kept = snapshots.map((x) => x.name)
    return report
  }
  const cutoff = now.getTime() - retentionDays * DAY_MS
  const futureLimit = now.getTime() + FUTURE_TOLERANCE_MS
  const removable = []
  for (const [index, snapshot] of aged.entries()) {
    const isNewest = index === 0
    if (snapshot.time > futureLimit) {
      report.anomalies.push({ name: snapshot.name, reason: 'created_at is in the future; kept for manual handling' })
      report.kept.push(snapshot.name)
      continue
    }
    if (isNewest || snapshot.time >= cutoff) { report.kept.push(snapshot.name); continue }
    removable.push(snapshot)
  }
  for (const snapshot of snapshots) {
    if (snapshot.usableTime) continue
    report.anomalies.push({ name: snapshot.name, reason: 'invalid created_at; kept for manual handling' })
    report.kept.push(snapshot.name)
  }
  for (const snapshot of removable) {
    await fs.rm(snapshot.dir, { recursive: true, force: true })
    report.removed.push(snapshot.name)
  }
  if (report.removed.length === 0) report.reason = 'nothing outside the retention window'
  return report
}

function parseArguments(rest) {
  const options = { targets: [] }
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (token === '--source') options.source = rest[++index]
    else if (token === '--target') options.targets.push(rest[++index])
    else if (token === '--snapshot') options.snapshot = rest[++index]
    else if (token === '--dest') options.dest = rest[++index]
    else if (token === '--retention-days') options.retentionDays = Number(rest[++index])
    else throw new Error('Unknown argument: ' + token)
  }
  return options
}

function describePrune(prune) {
  const parts = ['kept=' + prune.kept.length, 'removed=' + (prune.removed.length ? prune.removed.join(',') : 'none')]
  if (prune.skipped) parts.push('prune skipped: ' + prune.reason)
  else if (prune.reason) parts.push('note: ' + prune.reason)
  if (prune.staging.length) parts.push('staging=' + prune.staging.join(','))
  if (prune.unreadable.length) parts.push('unreadable=' + prune.unreadable.map((x) => x.name).join(','))
  for (const anomaly of prune.anomalies) parts.push('anomaly[' + anomaly.name + ']: ' + anomaly.reason)
  return parts.join(' ')
}

async function main(argv) {
  const [command, ...rest] = argv
  const options = parseArguments(rest)
  const source = path.resolve(options.source || process.env.LOCALPOST_MAILBOX || 'C:/AI_ASSIST/.mailbox')
  const retentionDays = options.retentionDays ?? RETENTION_DAYS_DEFAULT
  if (command === 'backup') {
    if (!options.targets.length) throw new Error('backup needs at least one --target')
    let failed = 0
    for (const target of options.targets) {
      const resolved = path.resolve(target)
      try {
        const result = await backupMailbox({ source, target: resolved })
        const prune = await pruneSnapshots({ target: resolved, retentionDays })
        console.log('BACKUP ok ' + result.snapshot)
        console.log('  files=' + result.fileCount + ' bytes=' + result.totalBytes + ' verified=' + result.verification.ok)
        if (result.skipped.length) console.log('  skipped=' + result.skipped.length + ' ' + JSON.stringify(result.skipped.slice(0, 5)))
        console.log('  retention-days=' + retentionDays + ' ' + describePrune(prune))
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
      const result = await pruneSnapshots({ target: resolved, retentionDays })
      console.log('PRUNE ' + resolved + ' retention-days=' + retentionDays + ' ' + describePrune(result))
    }
    return
  }
  if (command === 'status') {
    if (!options.targets.length) throw new Error('status needs at least one --target')
    for (const target of options.targets) {
      const resolved = path.resolve(target)
      const { snapshots, staging, unreadable } = await listSnapshots(resolved)
      console.log('STATUS ' + resolved + ' snapshots=' + snapshots.length + ' staging=' + staging.length + ' unreadable=' + unreadable.length)
      for (const snapshot of snapshots) console.log('  ' + snapshot.name + ' files=' + snapshot.fileCount + ' created=' + snapshot.createdAt)
      for (const item of unreadable) console.log('  UNREADABLE ' + item.name + ': ' + item.reason)
    }
    return
  }
  throw new Error('Usage: mail-backup.mjs <backup|verify|restore|prune|status> [options]')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error('mail-backup: ' + error.message); process.exitCode = 2 })
}
