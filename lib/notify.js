/**
 * LocalPost 局长外壳 · 通知与冷却记忆
 * ------------------------------------------------------------------
 * 通道 A：ntfy 推送（JSON publish —— 中文标题走 JSON 体，绕开 HTTP header 编码坑）
 * 通道 D：Windows 桌面 toast（powershell -File assets/toast.ps1，隐藏窗口）
 * 冷却：state.json 记录每条告警键的 lastNotifiedAt / lastSeverity
 *
 * 铁律：本模块只写自己的 state 文件，绝不碰 .mailbox 下的 ledger.json / alerts.json。
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const STATE_SCHEMA = 'localpost-plugin-state-v1'
/** Windows PowerShell 5.1（toast 的 WinRT 调用在 5.1 上最稳） */
const PS51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
/** 僵尸状态键的保留上限：超过就不必再记 */
const STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 }

/* ------------------------- 状态（冷却记忆） ------------------------- */

/** 一条告警的稳定身份键：kind + id/path + 附件名（同一封问题信跨轮保持同键） */
export function alertKey(alert) {
  const a = alert || {}
  return [a.kind || '?', a.id || '', a.path || '', a.attachment || ''].join('|')
}

/** 读状态文件；任何异常都退回空状态（插件绝不因状态损坏而停摆） */
export function readState(file) {
  const empty = { schema: STATE_SCHEMA, notified: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.notified && typeof parsed.notified === 'object') {
      return { schema: STATE_SCHEMA, notified: parsed.notified }
    }
  } catch { /* 不存在/损坏 → 空状态（等价于「全部当新告警」，最坏情况只是多响一次） */ }
  return empty
}

/** 原子写状态（先 .tmp 再 rename），失败静默 —— 状态丢失不会影响内核 */
export function writeState(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 选出「本轮该冒泡」的告警，并算出下一版状态。
 * 规则：① 从没通知过 → 新告警，响；② 严重度升到 error → 升级，响；
 *      ③ 距上次通知超过冷却期 → 重提，响；④ 其余静默（但记住最新严重度）。
 * 清理：本轮不存在的键（= 已解决）与超过 30 天的僵尸键一律删掉。
 * @returns {{ fresh: object[], next: { schema: string, notified: Record<string, {at: string, severity: string}> } }}
 */
export function selectFresh(alerts, state, cooldownMs, now) {
  const notified = Object.assign({}, (state && state.notified) || {})
  const present = new Set()
  const fresh = []
  for (const alert of alerts || []) {
    const key = alertKey(alert)
    present.add(key)
    const severity = alert.severity || 'info'
    const prev = notified[key]
    if (!prev) {
      fresh.push(alert)
      notified[key] = { at: new Date(now).toISOString(), severity }
      continue
    }
    const escalated = prev.severity !== 'error' && severity === 'error'
    const cooled = now - (Date.parse(prev.at) || 0) > cooldownMs
    if (escalated || cooled) {
      fresh.push(alert)
      notified[key] = { at: new Date(now).toISOString(), severity }
    } else {
      notified[key] = { at: prev.at, severity }
    }
  }
  for (const key of Object.keys(notified)) {
    if (!present.has(key) || now - (Date.parse(notified[key].at) || 0) > STATE_RETENTION_MS) delete notified[key]
  }
  return { fresh, next: { schema: STATE_SCHEMA, updated_at: new Date(now).toISOString(), notified } }
}

/* ------------------------- 文案 ------------------------- */

/** 一条告警的人话 */
export function describe(alert) {
  const a = alert || {}
  if (a.kind === 'overdue') {
    return `超时 ${a.age_minutes} 分（阈值 ${a.timeout_minutes}）· ${a.from} → ${a.to} · ${a.id}` +
      (a.subject ? ' · ' + a.subject : '')
  }
  if (a.kind === 'malformed') return `坏信 ${a.path} · ${a.reason}`
  if (a.kind === 'missing_attachment') return `附件缺失 ${a.path} · 引用了不存在的 ${a.attachment}`
  if (a.kind === 'envelope_missing') {
    return `信件消失 ${a.id} · ${a.from} → ${a.to}（账本有记录、信封已不在盘上）`
  }
  return `${a.kind || '告警'} ${a.id || a.path || ''}`
}

/** 每轮一条汇总：标题 + 最多 3 条要点 + 余量 */
export function buildDigest(alerts) {
  const sorted = (alerts || []).slice().sort((x, y) =>
    ((SEVERITY_RANK[x.severity] ?? 9) - (SEVERITY_RANK[y.severity] ?? 9)) ||
    ((y.age_minutes || 0) - (x.age_minutes || 0)))
  const errors = sorted.filter((a) => a.severity === 'error').length
  const worst = sorted.length ? (sorted[0].severity || 'info') : 'info'
  const title = `LocalPost 局长 · ${sorted.length} 条告警` + (errors ? `（${errors} 条严重）` : '')
  const lines = sorted.slice(0, 3).map((a, i) => `${i + 1}. [${a.severity || 'info'}] ${describe(a)}`)
  if (sorted.length > 3) lines.push(`…还有 ${sorted.length - 3} 条（详见 .mailbox/alerts.json）`)
  return {
    title,
    message: lines.join('\n'),
    toastBody: lines[0] || title,
    worst,
    count: sorted.length,
    errors,
    priority: worst === 'error' ? 4 : worst === 'warn' ? 3 : 2,
    tags: worst === 'error' ? ['rotating_light', 'mailbox'] : ['warning', 'mailbox'],
  }
}

/* ------------------------- 通道 A：ntfy ------------------------- */

/**
 * ntfy 推送（JSON publish）。服务器根路径 + JSON 体，标题/正文全走 JSON，中文无编码问题。
 * @throws 网络失败或非 2xx 时抛错（调用方决定是否重试）
 */
export async function pushNtfy(opts) {
  const o = opts || {}
  if (!o.topic) throw new Error('ntfy topic 未配置')
  const url = String(o.server || 'https://ntfy.sh').replace(/\/+$/, '') + '/'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: o.topic,
      title: o.title,
      message: o.message,
      priority: o.priority,
      tags: o.tags,
    }),
    signal: AbortSignal.timeout(o.timeoutMs || 8000),
  })
  if (!res.ok) throw new Error('ntfy HTTP ' + res.status)
  return true
}

/* ------------------------- 通道 D：桌面 toast ------------------------- */

/**
 * 弹一条 Windows 桌面通知（powershell -File 外部脚本，非内联脚本 —— 规避杀软 PDM）。
 * 脚本自身会打印 TOAST_OK / TOAST_FAIL，两者都作为判定依据。
 * @throws 进程失败、超时或脚本自报失败时抛错
 */
export function showToast(scriptPath, title, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!scriptPath || !existsSync(scriptPath)) {
      reject(new Error('toast 脚本不存在: ' + String(scriptPath)))
      return
    }
    const exe = existsSync(PS51) ? PS51 : 'powershell.exe'
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        '-Title', String(title || ''), '-Body', String(body || '')],
      { windowsHide: true, timeout: timeoutMs || 15000 },
      (err, stdout, stderr) => {
        const out = String(stdout || '')
        if (err) {
          reject(new Error('toast 进程失败: ' + (err.message || String(err)) +
            (stderr ? ' | ' + String(stderr).trim().slice(0, 200) : '')))
          return
        }
        if (out.includes('TOAST_FAIL')) { reject(new Error(out.trim().slice(0, 200))); return }
        resolve(true)
      },
    )
  })
}
