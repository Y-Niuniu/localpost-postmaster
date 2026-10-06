#!/usr/bin/env node
/**
 * LocalPost 局长内核 (Postmaster Kernel) v0.1.0
 * ------------------------------------------------------------------
 * 对账器：读信箱文件 -> 推进账本 -> 产出告警。
 * 零依赖 / 零常驻 / 信封只读 / 幂等可重跑。
 *
 * 用法:
 *   node postmaster.mjs              体检报告（人话）
 *   node postmaster.mjs --json       机器可读结果（内容与 alerts.json 相同）
 *   node postmaster.mjs --dry-run    只预览，不写任何文件
 *   node postmaster.mjs --rebuild    强制从信封重建账本
 *   node postmaster.mjs --verbose    附账本明细
 *   node postmaster.mjs --help       帮助
 *
 * 退出码: 0 无告警 | 1 有告警 | 2 运行失败
 *
 * 插件复用（不必 spawn 子进程）:
 *   import { runOnce, readAlerts, loadConfig } from 'file:///C:/AI_ASSIST/.mailbox/postmaster.mjs'
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireLease, atomicWrite, assertId } from './fs-safe.mjs'

export const KERNEL_VERSION = '0.1.0'
const ALERTS_SCHEMA = 'localpost-alerts-v1'
const LEDGER_SCHEMA = 'localpost-ledger-v0.2'

/* 注意（2026-09-13 清理，别再往这里加"看起来能配"的死键）：
 *   本内核**不做调度** —— 定时由两条腿负责：dsh 插件（15 分钟） + Windows 计划任务。
 *   所以这里不再声明 scanIntervalMinutes：它以前只声明、从不被任何代码读，
 *   改了没效果，而真正生效的是插件从 <root>/postmaster.config.json 顶层读的 intervalMinutes
 *   （同一个文件，同名同源）。
 *   同理删掉 ignoreTypes：ping 在下面主循环里是**结构性跳过**（见 `e.type === 'ping'` 那行），
 *   不是可配置的忽略名单 —— 留着只会让人以为改它有用。
 */
export const DEFAULT_CONFIG = {
  schema: 'localpost-postmaster-config-v1',
  timeouts: { urgent: 15, standard: 120, high: 120, free: 1440 },
  defaultTimeoutMinutes: 120,
  escalateMultiplier: 4,
  lockStaleMinutes: 5,
  logRotateBytes: 1048576,
  bodySoftLimit: 200,
}

const REQUIRED_FIELDS = ['id', 'thread_id', 'from', 'to', 'type', 'subject', 'body', 'budget', 'created_at']
const VALID_TYPES = ['task', 'result', 'ping']
const VALID_BUDGETS = ['free', 'standard', 'high', 'urgent']
const FOLDERS = ['inbox', 'outbox', 'archive']

export function isTerminalResult(env) {
  return env && env.type === 'result' && (env.outcome === undefined ||
    ['completed', 'failed', 'rejected', 'cancelled'].includes(env.outcome))
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

function kernelRoot() { return path.dirname(fileURLToPath(import.meta.url)) }
function isoOf(d) { return new Date(d).toISOString() }
function pad(n) { return String(n).padStart(2, '0') }
function fmtLocal(d) {
  const t = new Date(d)
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) + ' ' +
    pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds())
}
function relOf(root, full) { return path.relative(root, full).split(path.sep).join('/') }

async function readTextFile(file) {
  try { return await fsp.readFile(file, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function readJsonFile(file) {
  const text = await readTextFile(file)
  if (text === null) return { ok: false, missing: true, error: '文件不存在' }
  try { return { ok: true, value: JSON.parse(text) } }
  catch (e) { return { ok: false, error: 'JSON 解析失败: ' + e.message } }
}
async function backupIfExists(src, dst) {
  const text = await readTextFile(src)
  if (text === null) return false
  await atomicWrite(dst, text)
  return true
}

/* ------------------------- 配置 / 读取 ------------------------- */

export async function loadConfig(opts) {
  const root = path.resolve((opts && opts.root) || kernelRoot())
  const parsed = await readJsonFile(path.join(root, 'postmaster.config.json'))
  const user = parsed.ok && parsed.value && typeof parsed.value === 'object' ? parsed.value : {}
  const cfg = Object.assign({}, DEFAULT_CONFIG, user)
  cfg.timeouts = Object.assign({}, DEFAULT_CONFIG.timeouts, user.timeouts || {})
  return cfg
}

export async function readAlerts(opts) {
  const root = path.resolve((opts && opts.root) || kernelRoot())
  const parsed = await readJsonFile(path.join(root, 'alerts.json'))
  return parsed.ok ? parsed.value : null
}

/* ------------------------- 信封校验 ------------------------- */

export function validateEnvelope(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return { ok: false, errors: ['不是 JSON 对象'] }
  const errors = []
  for (const f of REQUIRED_FIELDS) {
    if (typeof env[f] !== 'string' || !env[f]) errors.push('缺字段或不是字符串 ' + f)
  }
  for (const f of ['id', 'from', 'to']) {
    try { assertId(env[f]) } catch { errors.push(f + ' 不是安全标识符') }
  }
  if (env.reply_to !== undefined) { try { assertId(env.reply_to) } catch { errors.push('reply_to 不是安全标识符') } }
  if (env.outcome !== undefined && !['completed', 'failed', 'rejected', 'cancelled', 'needs_authorization'].includes(env.outcome))
    errors.push('outcome 非法')
  if (env.type && VALID_TYPES.indexOf(env.type) < 0) errors.push('type 非法: ' + env.type)
  if (env.budget && VALID_BUDGETS.indexOf(env.budget) < 0) errors.push('budget 非法: ' + env.budget)
  if (env.created_at && Number.isNaN(Date.parse(env.created_at))) errors.push('created_at 不是合法时间')
  if (env.attachments !== undefined && !Array.isArray(env.attachments)) errors.push('attachments 必须是数组')
  if (Array.isArray(env.attachments) && env.attachments.some((item) => typeof item !== 'string' || !item))
    errors.push('attachments 必须仅含非空字符串')
  return { ok: errors.length === 0, errors: errors }
}

/* ------------------------- 扫描 ------------------------- */

export async function scanMailbox(root) {
  const base = path.join(root, 'agents')
  const envelopes = []
  const malformed = []
  const vanished = []
  const agents = []
  let agentDirs = []
  try {
    agentDirs = (await fsp.readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (error) { if (error.code !== 'ENOENT') throw error; agentDirs = [] }
  for (const agent of agentDirs.sort()) {
    agents.push(agent)
    for (const folder of FOLDERS) {
      const dir = path.join(base, agent, folder)
      let files = []
      try { files = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.json')) }
      catch (error) { if (error.code !== 'ENOENT') throw error; continue }
      for (const f of files.sort()) {
        const full = path.join(dir, f)
        const rel = relOf(root, full)
        const parsed = await readJsonFile(full)
        if (!parsed.ok) {
          // 另一进程恰好在这两步之间归档/GC 了这封信：**不是坏信**。
          // 旧版会把它计成 malformed 并告警（对账锁与邮箱写锁不同，正常并发即可产生假告警）。
          if (parsed.missing) { vanished.push({ path: rel, agent: agent, folder: folder }); continue }
          malformed.push({ path: rel, reason: parsed.error }); continue
        }
        const v = validateEnvelope(parsed.value)
        if (!v.ok) { malformed.push({ path: rel, reason: v.errors.join('; ') }); continue }
        envelopes.push({ path: rel, full: full, agent: agent, folder: folder, env: parsed.value })
      }
    }
  }
  let attachmentsOnDisk = []
  try { attachmentsOnDisk = await listFilesRecursive(path.join(root, 'attachments')) }
  catch (error) { if (error.code !== 'ENOENT') throw error; attachmentsOnDisk = [] }
  return {
    envelopes: envelopes, malformed: malformed, vanished: vanished, agents: agents,
    attachmentsOnDisk: attachmentsOnDisk,
    attachmentSet: new Set(attachmentsOnDisk),   // 便于 O(1) 判断"附件是否在盘上"
  }
}

/** 递归列出目录下的**文件**相对路径（用 / 分隔）；只列顶层会误报"子目录附件缺失"。 */
async function listFilesRecursive(dir, prefix = '') {
  const out = []
  let entries = []
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return out; throw error }
  for (const d of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? prefix + '/' + d.name : d.name
    if (d.isDirectory()) out.push(...await listFilesRecursive(path.join(dir, d.name), rel))
    else if (d.isFile()) out.push(rel)
  }
  return out
}

/* ------------------------- 账本 ------------------------- */

async function loadLedger(root) {
  const parsed = await readJsonFile(path.join(root, 'ledger.json'))
  if (parsed.ok && parsed.value && typeof parsed.value === 'object' &&
      parsed.value.envelopes && typeof parsed.value.envelopes === 'object') {
    return { ledger: parsed.value, rebuilt: false, initialized: false, error: null }
  }
  const empty = { schema: LEDGER_SCHEMA, envelopes: {} }
  if (parsed.missing) {
    return { ledger: empty, rebuilt: false, initialized: true, error: '账本不存在（首次运行，已初始化）' }
  }
  return { ledger: empty, rebuilt: true, initialized: false, error: '账本损坏：' + (parsed.error || '结构不合法') }
}

function summarizeLedger(ledger) {
  const names = Object.keys(ledger.envelopes || {})
  const s = { total: names.length, replied: 0, overdue: 0, sent: 0, awaiting_authorization: 0 }
  for (const n of names) {
    const st = ledger.envelopes[n].status
    if (st === 'replied') s.replied++
    else if (st === 'overdue') s.overdue++
    else if (st === 'sent') s.sent++
    else if (st === 'awaiting_authorization') s.awaiting_authorization++
  }
  return s
}

/* ------------------------- 对账 ------------------------- */

export function reconcile(input) {
  const scan = input.scan
  const ledger = input.ledger
  const config = input.config
  const now = input.now ? new Date(input.now) : new Date()
  const nowMs = now.getTime()
  if (!ledger.envelopes || typeof ledger.envelopes !== 'object') ledger.envelopes = {}
  const entries = ledger.envelopes
  const alerts = []
  const stats = {
    envelopes: scan.envelopes.length, tasks: 0, results: 0, pings: 0,
    malformed: scan.malformed.length, warnings: 0, agents: scan.agents.slice(),
  }

  const grouped = new Map()
  for (const item of scan.envelopes) {
    const group = grouped.get(item.env.id) || []
    group.push(item)
    grouped.set(item.env.id, group)
  }
  const envelopes = []
  for (const [id, group] of grouped) {
    if (group.some((item) => canonical(item.env) !== canonical(group[0].env))) {
      alerts.push({ id, kind: 'id_conflict', severity: 'error', path: group[0].path,
        reason: '相同 ID 出现不同信封内容', paths: group.map((item) => item.path) })
    } else {
      // Prefer a delivered copy over outbox when identical copies coexist.
      envelopes.push(group.find((item) => item.agent === item.env.to &&
        ['inbox', 'archive'].includes(item.folder)) || group[0])
    }
  }

  const resultsByReplyTo = new Map()
  const waitingByReplyTo = new Map()
  const tasksById = new Map(envelopes.filter((x) => x.env.type === 'task').map((x) => [x.env.id, x.env]))
  for (const item of envelopes) {
    const e = item.env
    if (e.type !== 'result' || !e.reply_to) continue
    const task = tasksById.get(e.reply_to)
    if (task && (e.from !== task.to || e.to !== task.from || e.thread_id !== task.thread_id ||
        item.agent !== task.from || !['inbox', 'archive'].includes(item.folder))) {
      alerts.push({ id: e.id, kind: 'invalid_reply', severity: 'error', path: item.path,
        reason: '回执双方、线程或投递位置不匹配原任务' })
      continue
    }
    if (!isTerminalResult(e)) {
      if (e.outcome === 'needs_authorization') waitingByReplyTo.set(e.reply_to, e)
      continue
    }
    const t = Date.parse(e.created_at) || 0
    const prev = resultsByReplyTo.get(e.reply_to)
    if (!prev || t >= prev.t) resultsByReplyTo.set(e.reply_to, { env: e, t: t, path: item.path })
  }

  const seenTaskIds = new Set()
  for (const item of envelopes) {
    const e = item.env
    if (e.type === 'result') { stats.results++; continue }
    if (e.type === 'ping') { stats.pings++; continue }
    stats.tasks++
    seenTaskIds.add(e.id)
    const prev = entries[e.id] || {}
    const sentMs = Date.parse(e.created_at)
    const timeoutMinutes = (config.timeouts && config.timeouts[e.budget]) || config.defaultTimeoutMinutes
    const ageMinutes = Math.max(0, (nowMs - sentMs) / 60000)
    const reply = resultsByReplyTo.get(e.id)

    let status
    if (reply) status = 'replied'
    else if (prev.status === 'replied') status = 'replied'
    else if (waitingByReplyTo.has(e.id)) status = 'awaiting_authorization'
    else if (ageMinutes > timeoutMinutes) status = 'overdue'
    else status = 'sent'

    const entry = Object.assign({}, prev, {
      status: status, type: 'task', from: e.from, to: e.to, budget: e.budget,
      subject: e.subject, thread_id: e.thread_id, sent_at: isoOf(sentMs),
      timeout_minutes: timeoutMinutes, path: item.path, updated_at: isoOf(now),
    })

    if (reply) {
      entry.replied_at = isoOf(reply.t || nowMs)
      entry.reply_envelope = reply.env.id
      entry.reply_path = reply.path
      entry.outcome = reply.env.outcome || 'completed'
      entry.overdue_count = 0
      delete entry.first_seen_overdue_at
    } else if (status === 'overdue') {
      if (!entry.first_seen_overdue_at) entry.first_seen_overdue_at = isoOf(now)
      entry.overdue_count = (Number(prev.overdue_count) || 0) + 1
      alerts.push({
        id: e.id, kind: 'overdue',
        severity: ageMinutes > timeoutMinutes * config.escalateMultiplier ? 'error' : 'warn',
        age_minutes: Math.round(ageMinutes), timeout_minutes: timeoutMinutes,
        from: e.from, to: e.to, budget: e.budget, subject: e.subject,
        since: entry.sent_at, first_seen: entry.first_seen_overdue_at,
        count: entry.overdue_count, path: item.path,
      })
    }
    entries[e.id] = entry

    if (typeof e.body === 'string' && e.body.length > config.bodySoftLimit) stats.warnings++
  }

  // 附件缺失检查独立成一遍（旧版写在 task 分支里 ⇒ result/ping 的附件丢失漏报；且只列顶层目录 ⇒ 子目录附件误报）。
  for (const item of envelopes) {
    const e = item.env
    const refs = Array.isArray(e.attachments) ? e.attachments : []
    for (const a of refs) {
      const key = String(a).replace(/\\/g, '/')
      if (scan.attachmentSet.has(key)) continue
      const ageMinutes = Math.max(0, (nowMs - (Date.parse(e.created_at) || 0)) / 60000)
      alerts.push({
        id: e.id, kind: 'missing_attachment', severity: 'warn', path: item.path,
        attachment: a, age_minutes: Math.round(ageMinutes), from: e.from, to: e.to,
        subject: e.subject, first_seen: isoOf(now),
      })
    }
  }

  for (const m of scan.malformed) {
    alerts.push({
      id: null, kind: 'malformed', severity: 'error', path: m.path, reason: m.reason,
      age_minutes: null, from: null, to: null, first_seen: isoOf(now),
    })
  }

  for (const id of Object.keys(entries)) {
    if (seenTaskIds.has(id)) continue
    const entry = entries[id]
    if (entry.type === 'task' && ['sent', 'overdue', 'awaiting_authorization'].includes(entry.status)) {
      alerts.push({
        id: id, kind: 'envelope_missing', severity: 'warn', path: entry.path || null,
        age_minutes: null, from: entry.from || null, to: entry.to || null,
        budget: entry.budget || null, subject: entry.subject || null, since: entry.sent_at || null,
        first_seen: isoOf(now),
        note: '账本有该任务记录，但信封已不在盘上（可能被 GC 清理或被人手动移动）',
      })
    }
  }

  const rank = { error: 0, warn: 1, info: 2 }
  const kindRank = { overdue: 0, envelope_missing: 1, missing_attachment: 2, malformed: 3 }
  alerts.sort((a, b) => {
    const s = (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9)
    if (s !== 0) return s
    const k = (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9)
    if (k !== 0) return k
    return (b.age_minutes || 0) - (a.age_minutes || 0)
  })

  return { ledger: ledger, alerts: alerts, stats: stats }
}

/* ------------------------- 运行锁 / 日志 ------------------------- */

function buildLogLines(result, now) {
  const stamp = fmtLocal(now)
  const a = result.alerts
  const s = a.scan
  const lines = [stamp + '  run   信封=' + s.envelopes + ' 任务=' + s.tasks + ' 坏信=' + s.malformed +
    ' 告警=' + a.alerts.length + ' 退出码=' + result.exit_code + (result.rebuilt ? ' [账本重建]' : '')]
  for (const x of a.alerts) {
    if (x.first_seen === a.generated_at) {
      lines.push(stamp + '  new   ' + x.kind + '  ' + (x.id || x.path || '') + '  [' + x.severity + ']')
    }
  }
  return lines
}

async function appendLog(root, config, lines) {
  if (!lines.length) return
  const file = path.join(root, 'postmaster.log')
  try {
    const st = await fsp.stat(file)
    if (st.size > config.logRotateBytes) await fsp.rename(file, file + '.1')
  } catch { /* 文件不存在，无需轮转 */ }
  await fsp.appendFile(file, lines.join('\n') + '\n', 'utf8')
}

/* ------------------------- 主流程 ------------------------- */

export async function runOnce(opts) {
  const o = opts || {}
  const root = path.resolve(o.root || kernelRoot())
  const config = o.config || (await loadConfig({ root: root }))
  const now = o.now ? new Date(o.now) : new Date()
  const dryRun = !!o.dryRun
  const result = {
    kernel: KERNEL_VERSION, root: root, generated_at: isoOf(now), dry_run: dryRun,
    skipped: false, rebuilt: false, initialized: false, exit_code: 0, alerts: null, ledger_summary: null,
    error: null, log: [],
  }
  let lease = null
  try {
    if (!dryRun) {
      const lock = await acquireLease(root, { staleMs: config.lockStaleMinutes * 60000, now: now.getTime() })
      if (!lock.acquired) {
        result.skipped = true
        result.log.push(lock.reason)
        return result
      }
      lease = lock
    }
    const scan = await scanMailbox(root)
    const loaded = o.rebuild
      ? { ledger: { schema: LEDGER_SCHEMA, envelopes: {} }, rebuilt: true, initialized: false, error: '按 --rebuild 要求重建' }
      : await loadLedger(root)
    result.rebuilt = loaded.rebuilt
    result.initialized = !!loaded.initialized
    if (loaded.rebuilt) result.log.push('账本：' + loaded.error)

    const rec = reconcile({ scan: scan, ledger: loaded.ledger, config: config, now: now })
    const payload = { schema: ALERTS_SCHEMA, generated_at: isoOf(now), scan: rec.stats, alerts: rec.alerts }
    result.alerts = payload
    result.ledger_summary = summarizeLedger(rec.ledger)
    result.exit_code = rec.alerts.length > 0 ? 1 : 0
    if (o.verbose) result.ledger_detail = rec.ledger.envelopes

    if (!dryRun) {
      await backupIfExists(path.join(root, 'ledger.json'), path.join(root, 'ledger.json.bak'))
      const outLedger = Object.assign({}, rec.ledger, {
        schema: LEDGER_SCHEMA, updated_at: isoOf(now), kernel: KERNEL_VERSION,
      })
      await atomicWrite(path.join(root, 'ledger.json'), JSON.stringify(outLedger, null, 2) + '\n')
      await atomicWrite(path.join(root, 'alerts.json'), JSON.stringify(payload, null, 2) + '\n')
      await appendLog(root, config, buildLogLines(result, now))
    }
  } catch (e) {
    result.error = (e && e.message) ? e.message : String(e)
    result.exit_code = 2
  } finally {
    if (lease) await lease.release()
  }
  return result
}

/* ------------------------- 报告 ------------------------- */

function describeAlert(x) {
  if (x.kind === 'overdue') return '[超时/' + x.severity + '] ' + x.id + '  ' + x.from + ' → ' + x.to + '  已等 ' + x.age_minutes + ' 分钟（阈值 ' + x.timeout_minutes + '）' + (x.subject ? '  · ' + x.subject : '')
  if (x.kind === 'malformed') return '[坏信] ' + x.path + '  ' + x.reason
  if (x.kind === 'missing_attachment') return '[附件缺失] ' + x.path + ' 引用了不存在的附件 ' + x.attachment
  if (x.kind === 'envelope_missing') return '[信件消失] ' + x.id + ' 账本有记录但信封不在盘上（可能被 GC 清理）'
  return '[' + x.kind + '] ' + JSON.stringify(x)
}

export function formatReport(result, opts) {
  const o = opts || {}
  const lines = []
  if (result.skipped) return 'LocalPost 局长 · 跳过本轮（' + result.log.join('；') + '）'
  if (!result.alerts) return '❌ LocalPost 局长运行失败: ' + (result.error || '未知错误')
  const a = result.alerts
  const s = a.scan
  lines.push('LocalPost 局长 · ' + fmtLocal(a.generated_at) + (result.dry_run ? '    [dry-run 预览 · 未写盘]' : ''))
  lines.push('信箱 ' + (s.agents.length ? s.agents.join(', ') : '（无）') + ' · 扫描 ' + s.envelopes + ' 封' +
    '（task ' + s.tasks + ' / result ' + s.results + ' / ping ' + s.pings + '）· 坏信 ' + s.malformed + ' · 正文超限 ' + s.warnings)
  if (result.ledger_summary) {
    const L = result.ledger_summary
    lines.push('账本 ' + L.total + ' 条：已回执 ' + L.replied + ' / 超时 ' + L.overdue + ' / 在途 ' + L.sent)
  }
  if (!a.alerts.length) {
    lines.push('✅ 无告警：所有任务都已回执，或仍在超时窗口内')
  } else {
    lines.push('⚠️  ' + a.alerts.length + ' 条告警：')
    for (const x of a.alerts) lines.push('   ' + describeAlert(x))
  }
  if (o.verbose && result.ledger_detail) {
    lines.push('--- 账本明细 ---')
    for (const id of Object.keys(result.ledger_detail)) {
      const e = result.ledger_detail[id]
      lines.push('   ' + id + '  [' + e.status + ']  ' + (e.from || '?') + ' → ' + (e.to || '?') + '  ' + (e.sent_at || ''))
    }
  }
  lines.push('退出码 ' + result.exit_code + (result.rebuilt ? ' · 账本已重建' : '') +
    (result.initialized ? ' · 账本已初始化' : '') + (result.log.length ? ' · ' + result.log.join('；') : ''))
  return lines.join('\n')
}

/* ------------------------- CLI ------------------------- */

const HELP_TEXT = [
  'LocalPost 局长内核 v' + KERNEL_VERSION,
  '',
  '用法: node postmaster.mjs [选项]',
  '  --json      输出机器可读结果（与 alerts.json 内容一致）',
  '  --dry-run   只预览，不写任何文件',
  '  --rebuild   强制从信封重建账本',
  '  --verbose   附账本明细',
  '  --root DIR  指定信箱根目录（默认 = 本文件所在目录）',
  '  --help      显示帮助',
  '',
  '退出码: 0 无告警 | 1 有告警 | 2 运行失败',
].join('\n')

function parseArgs(argv) {
  const out = { json: false, dryRun: false, rebuild: false, verbose: false, help: false, root: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--dry-run' || a === '--dryrun') out.dryRun = true
    else if (a === '--rebuild') out.rebuild = true
    else if (a === '--verbose' || a === '-v') out.verbose = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--root') out.root = argv[++i]
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { process.stdout.write(HELP_TEXT + '\n'); return 0 }
  const result = await runOnce({ root: args.root || undefined, dryRun: args.dryRun, rebuild: args.rebuild, verbose: args.verbose })
  if (args.json) {
    const payload = result.alerts || { schema: ALERTS_SCHEMA, skipped: result.skipped, error: result.error, exit_code: result.exit_code }
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  } else {
    process.stdout.write(formatReport(result, { verbose: args.verbose }) + '\n')
  }
  return result.exit_code
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code })
    .catch((e) => { console.error('局长运行失败: ' + (e && e.message ? e.message : e)); process.exitCode = 2 })
}
