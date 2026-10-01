import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireLease, safePath } from './fs-safe.mjs'
import { isTerminalResult, validateEnvelope } from './postmaster.mjs'

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
async function listing(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
async function snapshot(root, errors) {
  const records = []
  let unknownReferences = false
  try {
    for (const agent of await listing(safePath(root, 'agents'))) {
      if (agent.isSymbolicLink()) {
        unknownReferences = true
        errors.push({ path: `agents/${agent.name}`, reason: 'Linked agent directory; preserve unknown references' })
        continue
      }
      if (!agent.isDirectory()) continue
      for (const folder of ['inbox', 'outbox', 'archive']) {
        const dir = safePath(root, `agents/${agent.name}/${folder}`)
        for (const item of await listing(dir)) {
          if (!item.name.toLowerCase().endsWith('.json')) continue
          const relative = `agents/${agent.name}/${folder}/${item.name}`
          try {
            const file = safePath(root, relative)
            if (!(await fs.lstat(file)).isFile()) throw new Error('Envelope is not a regular file')
            const raw = await fs.readFile(file, 'utf8')
            const env = JSON.parse(raw)
            if (!validateEnvelope(env).ok) throw new Error('Invalid envelope; preserve unknown references')
            for (const attachment of env.attachments || []) safePath(root, `attachments/${attachment}`)
            records.push({ file, relative, env, raw, agent: agent.name, folder, stat: await fs.stat(file) })
          } catch (error) {
            unknownReferences = true
            errors.push({ path: relative, reason: error.message })
          }
        }
      }
    }
  } catch (error) {
    unknownReferences = true
    errors.push({ path: 'agents', reason: error.message })
  }
  return { records, unknownReferences }
}

export async function runGc({ root, days = 30, dryRun = true, now = Date.now() } = {}) {
  if (!root || !Number.isFinite(days) || days < 30 || !Number.isFinite(Number(now)))
    throw new Error('GC requires an explicit root and retention of at least 30 days')
  root = path.resolve(root)
  const result = { dryRun, candidates: [], deleted: [], errors: [], skipped: false }
  let lease
  if (!dryRun) {
    lease = await acquireLease(root, { name: '.mailbox-write.lock', now: Number(now) })
    if (!lease.acquired) return { ...result, skipped: true, reason: lease.reason }
  }
  try {
    const cutoff = Number(now) - days * 86400000
    const initial = await snapshot(root, result.errors)
    const grouped = new Map()
    for (const record of initial.records) {
      const group = grouped.get(record.env.id) || []
      group.push(record)
      grouped.set(record.env.id, group)
    }
    const conflicts = new Set([...grouped].filter(([, group]) =>
      group.some((item) => canonical(item.env) !== canonical(group[0].env))).map(([id]) => id))
    for (const id of conflicts) result.errors.push({ id, reason: 'Conflicting ID; preserved' })
    const matches = []
    for (const task of initial.records.filter((r) => r.env.type === 'task' && !conflicts.has(r.env.id))) {
      for (const reply of initial.records) {
        const e = reply.env
        if (!isTerminalResult(e) || conflicts.has(e.id) || e.reply_to !== task.env.id ||
            e.thread_id !== task.env.thread_id || e.from !== task.env.to || e.to !== task.env.from ||
            reply.agent !== task.env.from || !['inbox', 'archive'].includes(reply.folder)) continue
        matches.push({ task, reply })
      }
    }
    const candidates = new Map()
    for (const { task, reply } of matches) {
      const completedAt = Date.parse(reply.env.created_at)
      for (const record of [task, reply]) {
        if (record.folder === 'archive' && Math.max(record.stat.mtimeMs,
          Date.parse(record.env.created_at), completedAt) < cutoff) candidates.set(record.file, record)
      }
    }
    for (const record of candidates.values()) {
      result.candidates.push(record.relative)
      if (!dryRun) {
        try {
          if (await fs.readFile(safePath(root, record.relative), 'utf8') !== record.raw)
            throw new Error('Envelope changed during collection; preserved')
          await fs.unlink(record.file)
          result.deleted.push(record.relative)
        } catch (error) { result.errors.push({ path: record.relative, reason: error.message }) }
      }
    }
    // Recheck all surviving references before deleting any attachment.
    const current = await snapshot(root, result.errors)
    if (!initial.unknownReferences && !current.unknownReferences && conflicts.size === 0) {
      const pathKey = (file) => process.platform === 'win32' ? file.toLowerCase() : file
      const realKey = async (file) => {
        try { return pathKey(await fs.realpath(file)) }
        catch (error) { if (error.code === 'ENOENT') return pathKey(file); throw error }
      }
      const surviving = current.records.filter((record) => !dryRun || !candidates.has(record.file))
      const references = new Set(await Promise.all(surviving.flatMap((record) => record.env.attachments || [])
        .map((attachment) => realKey(safePath(root, `attachments/${attachment}`)))))
      for (const item of await listing(safePath(root, 'attachments'))) {
        if (!item.isFile()) continue
        const relative = `attachments/${item.name}`
        const file = safePath(root, relative)
        if (references.has(await realKey(file))) continue
        if ((await fs.stat(file)).mtimeMs >= cutoff) continue
        result.candidates.push(relative)
        if (!dryRun) { await fs.unlink(file); result.deleted.push(relative) }
      }
    }
    return result
  } finally { if (lease?.acquired) await lease.release() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
  runGc({ root: value('--root'), days: value('--days') === undefined ? 30 : Number(value('--days')),
    dryRun: !args.includes('--apply') }).then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    process.exitCode = result.errors.length || result.skipped ? 1 : 0
  }).catch((error) => { console.error(error.message); process.exitCode = 2 })
}
