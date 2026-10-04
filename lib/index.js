/**
 * @dsh-external/dsh-localpost-postmaster — LocalPost 局长外壳（子项目②）
 * ------------------------------------------------------------------
 * 外壳只做三件事，不含任何业务逻辑：
 *   1. 每 N 分钟（默认 15）调一次内核 runOnce，纯定时器、零 token；
 *   2. 有告警就冒泡：通道 A = ntfy 推送，通道 D = Windows 桌面 toast（仅 error 级）；
 *   3. 注册 localpost_check 工具，让对话里可以「查一下信箱」。
 *
 * 硬约束（来自承接文档，踩了会返工）：
 *   - 不 spawn 内核：同语言同运行时，直接 import（`file://` 动态 import）。
 *   - 不写 ledger.json / alerts.json：唯一写者是内核，插件只读。
 *   - 默认不开 LLM 循环：定时器 + 读文件 = 零 token。
 *   - 插件崩溃不影响内核：内核同时挂在 Windows 计划任务上独立运行。
 *
 * 零依赖实现（不 import 任何 npm 包）：本机没有 dsh 源码 checkout，tsc 构建路径走不通；
 * 纯 JS 直挂 lib/ 反而更少出错面，也让热重载更快。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildDigest, pushNtfy, readState, selectFresh, showToast, writeState } from './notify.js'

import { allowFromConfig, createIsolatedWiring } from '../localpost/dsh-wiring.mjs'

export const name = '@dsh-external/dsh-localpost-postmaster'
/** tools = 手动工具注册；timer = 随 fiber 自动销毁的定时器 */
export const inject = ['tools', 'timer', 'commands', 'agents']

const DEFAULT_ROOT = 'C:/AI_ASSIST/.mailbox'
/**
 * 通知凭据不进源码（2026-09-13 修）。
 * ntfyTopic 是私人推送信道名：硬编码在源码里 = 把信道抄进仓库，而且源码默认开启就意味着
 * "克隆这个目录的人自动往我的信道推"。同机 ntfy-notify.mjs 早就是这个范式
 * （其注释原文："模块本身不含任何硬编码的个人 topic / 机器名"），这里对齐它。
 *
 * 取值优先级（后者覆盖前者）：
 *   1. DEFAULTS                              —— 全空 / 默认关
 *   2. <root>/postmaster.config.json 的 notify 段  —— 私人 topic 放这里
 *   3. loader row 的 config                   —— 想临时覆盖再写这里
 */
const NOTIFY_CONFIG_FILE = 'postmaster.config.json'
const DEFAULTS = {
  root: DEFAULT_ROOT,
  kernelPath: DEFAULT_ROOT + '/postmaster.mjs',
  intervalMinutes: 15,
  startupDelayMs: 3000,
  cooldownHours: 12,
  selfFailThreshold: 3,
  ntfyEnabled: false,
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: '',
  toastEnabled: true,
  toastScriptPath: '',
  stateFile: '',
  logFile: '',
}
/** 插件日志超过此大小转 .1（与内核的日志轮转同款做法） */
const LOG_ROTATE_BYTES = 262144
/** 单例守卫的全局键（Symbol.for：跨模块实例共享同一把锁） */
const INSTANCE_KEY = Symbol.for('dsh.localpost-postmaster.active')

function errText(e) {
  return e && e.message ? String(e.message) : String(e)
}

function boolOf(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false
  return fallback
}

function numOf(value, fallback, min) {
  const n = Number(value)
  return Number.isFinite(n) && n >= min ? n : fallback
}

function strOf(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/**
 * 读 <root>/postmaster.config.json —— localpost 子系统的单一配置源（内核与插件都读它）。
 *   · 顶层 intervalMinutes → 定时器间隔（插件读；内核不做调度）
 *   · notify 段           → 通知通道（私人 ntfy topic 在这里，不在源码里）
 * 文件缺失 / JSON 坏 / 段落类型不对 —— 一律当作"没配"，绝不阻断插件启动。
 */
function loadFileConfig(root) {
  try {
    const p = join(root, NOTIFY_CONFIG_FILE)
    if (!statSync(p).isFile()) return {}
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 配置兜底：没有 Config schema（零依赖），所以这里自己容错，任何脏值都退回默认 */
function normalizeConfig(raw, fileCfg) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const file = fileCfg && typeof fileCfg === 'object' ? fileCfg : {}
  const f = file.notify && typeof file.notify === 'object' ? file.notify : {}
  const c = Object.assign({}, DEFAULTS, r)
  /* 优先级一律 row config > 配置文件 > DEFAULTS */
  const pickTop = (key) => (r[key] === undefined || r[key] === null || r[key] === '' ? file[key] : r[key])
  const pick = (key) => (r[key] === undefined || r[key] === null || r[key] === '' ? f[key] : r[key])
  c.root = strOf(r.root, DEFAULTS.root)
  c.kernelPath = strOf(r.kernelPath, DEFAULTS.kernelPath)
  /* 间隔单一来源：以前这里只认 row config，而 postmaster.config.json 里那个
     scanIntervalMinutes 是谁都不读的死键 —— 改配置文件没效果，_note 却在说"改数字不用改代码"。
     现在两者同名同源（intervalMinutes 在配置文件顶层）。 */
  c.intervalMinutes = numOf(pickTop('intervalMinutes'), DEFAULTS.intervalMinutes, 0.05)
  c.startupDelayMs = numOf(r.startupDelayMs, DEFAULTS.startupDelayMs, 0)
  c.cooldownHours = numOf(r.cooldownHours, DEFAULTS.cooldownHours, 0)
  c.selfFailThreshold = Math.max(1, Math.round(numOf(r.selfFailThreshold, DEFAULTS.selfFailThreshold, 1)))
  c.ntfyEnabled = boolOf(pick('ntfyEnabled'), DEFAULTS.ntfyEnabled)
  c.ntfyServer = strOf(pick('ntfyServer'), DEFAULTS.ntfyServer)
  c.ntfyTopic = strOf(pick('ntfyTopic'), DEFAULTS.ntfyTopic)
  c.toastEnabled = boolOf(pick('toastEnabled'), DEFAULTS.toastEnabled)
  c.toastScriptPath = strOf(r.toastScriptPath, DEFAULTS.toastScriptPath)
  c.stateFile = strOf(r.stateFile, DEFAULTS.stateFile)
  c.logFile = strOf(r.logFile, DEFAULTS.logFile)
  return c
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig, loadFileConfig(strOf(rawConfig && rawConfig.root, DEFAULTS.root)))
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const baseDir = join(dshHome, 'localpost-postmaster')
  const stateFile = config.stateFile || join(baseDir, 'state.json')
  const logFile = config.logFile || join(baseDir, 'plugin.log')
  const toastScript = config.toastScriptPath ||
    fileURLToPath(new URL('../assets/toast.ps1', import.meta.url))

  let kernelModule = null
  let consecutiveFailures = 0
  let lastSelfAlertAt = 0
  let running = false
  let disposed = false
  const timerDisposers = []

  /* ---- 单例守卫 ----
   * 热重载可能让 apply 跑第二次、bundle 装配与运行时注入也可能同时命中同一个插件；
   * 两个实例 = 两份定时器 = 同一告警弹两次。冒泡类插件绝不能重复响，
   * 所以新实例一律先把上一个实例停掉（跨模块实例共享，靠 Symbol.for + globalThis）。 */
  const instance = {
    stop(reason) {
      if (disposed) return
      disposed = true
      for (const d of timerDisposers) { try { d() } catch { /* 已销毁 */ } }
      try { if (globalThis[INSTANCE_KEY] === instance) delete globalThis[INSTANCE_KEY] } catch { /* 忽略 */ }
      log('warn', '实例已停止（' + reason + '）——同一时刻只允许一个实例在跑')
    },
  }
  const previous = globalThis[INSTANCE_KEY]
  if (previous && previous !== instance && typeof previous.stop === 'function') {
    try { previous.stop('被新实例接管') } catch { /* 旧实例已停 */ }
  }
  globalThis[INSTANCE_KEY] = instance

  /** 插件自己的日志（内核的 postmaster.log 由内核独占，不掺和） */
  function log(level, message) {
    const line = new Date().toISOString() + '  ' + level + '  ' + message
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      try {
        if (statSync(logFile).size > LOG_ROTATE_BYTES) renameSync(logFile, logFile + '.1')
      } catch { /* 文件不存在，无需轮转 */ }
      appendFileSync(logFile, line + '\n', 'utf8')
    } catch { /* 日志失败绝不冒泡成插件故障 */ }
    if (level === 'error') ctx.logger?.warn?.('[localpost] ' + message)
    else ctx.logger?.info?.('[localpost] ' + message)
  }

  /** 惰性加载内核：失败就丢掉缓存，下一轮重试（内核被换掉/暂时不可读都能自愈） */
  async function loadKernel() {
    if (kernelModule) return kernelModule
    kernelModule = await import(pathToFileURL(config.kernelPath).href)
    return kernelModule
  }

  /** 人话报告优先复用内核的 formatReport（CLI 与工具输出同一份措辞，零重复） */
  async function report(result, verbose) {
    try {
      const kernel = await loadKernel()
      if (typeof kernel.formatReport === 'function') return kernel.formatReport(result, { verbose: !!verbose })
    } catch { /* 落到 JSON 兜底 */ }
    return JSON.stringify(result && result.alerts ? result.alerts : result, null, 2)
  }

  /** 双通道冒泡；返回成功送达的通道数（0 = 全失败，调用方据此决定不推进冷却状态） */
  async function bubble(alerts) {
    if (disposed) return 0
    const digest = buildDigest(alerts)
    let sent = 0
    if (config.ntfyEnabled && config.ntfyTopic) {
      try {
        await pushNtfy({
          server: config.ntfyServer, topic: config.ntfyTopic,
          title: digest.title, message: digest.message,
          priority: digest.priority, tags: digest.tags,
        })
        sent += 1
        log('info', 'ntfy 已推送: ' + digest.title)
      } catch (e) {
        log('warn', 'ntfy 推送失败: ' + errText(e))
      }
    }
    if (config.toastEnabled && digest.worst === 'error') {
      try {
        await showToast(toastScript, digest.title, digest.toastBody)
        sent += 1
        log('info', 'toast 已弹出: ' + digest.title)
      } catch (e) {
        log('warn', 'toast 失败: ' + errText(e))
      }
    } else if (config.toastEnabled) {
      log('info', 'toast 跳过（最高严重度 ' + digest.worst + '，仅 error 级弹窗）')
    }
    return sent
  }

  /** 插件自身故障：连续 N 轮才响一次，任一轮成功即归零（"没消息"≠"没告警"） */
  async function noteFailure(message, opts) {
    consecutiveFailures += 1
    log('error', '连续失败 ' + consecutiveFailures + ' 次：' + message)
    const silent = opts && (opts.notify === 'suppress' || opts.notify === 'none')
    const cooled = Date.now() - lastSelfAlertAt > config.cooldownHours * 3600000
    if (!silent && consecutiveFailures >= config.selfFailThreshold && cooled) {
      lastSelfAlertAt = Date.now()
      const title = 'LocalPost 局长 · 插件故障'
      const body = '连续 ' + consecutiveFailures + ' 轮跑不起来：' + message
      try {
        if (config.ntfyEnabled && config.ntfyTopic) {
          await pushNtfy({
            server: config.ntfyServer, topic: config.ntfyTopic,
            title, message: body, priority: 4, tags: ['rotating_light', 'warning'],
          })
        }
      } catch (e) {
        log('warn', '故障 ntfy 失败: ' + errText(e))
      }
      try {
        if (config.toastEnabled) await showToast(toastScript, title, body.slice(0, 180))
      } catch (e) {
        log('warn', '故障 toast 失败: ' + errText(e))
      }
    }
    return { ok: false, error: message, failures: consecutiveFailures }
  }

  /**
   * 跑一轮内核 + 决定要不要冒泡。
   * @param opts.dryRun 只预览（内核不写盘，插件也不动状态、不冒泡）
   * @param opts.notify 'bubble' 定时器路径 | 'suppress' 手动路径（对话里已回报，只推进冷却） | 'none'
   */
  async function executeRun(opts) {
    const o = opts || {}
    if (disposed) return { ok: true, held: true }
    if (running) {
      log('info', 'skip(' + (o.reason || 'timer') + ')：上一轮仍在运行')
      return { ok: true, held: true }
    }
    running = true
    try {
      let result
      try {
        const kernel = await loadKernel()
        result = await kernel.runOnce(o.dryRun ? { root: config.root, dryRun: true } : { root: config.root })
      } catch (e) {
        kernelModule = null
        return await noteFailure('内核调用失败: ' + errText(e), o)
      }
      if (!result) return await noteFailure('内核返回空结果', o)
      if (result.exit_code === 2) return await noteFailure('内核运行失败: ' + (result.error || '未知错误'), o)
      consecutiveFailures = 0

      const alerts = result.alerts && Array.isArray(result.alerts.alerts) ? result.alerts.alerts : []
      let fresh = []
      let nextState = null
      if (!result.skipped && !o.dryRun) {
        const now = Date.now()
        const picked = selectFresh(alerts, readState(stateFile), config.cooldownHours * 3600000, now)
        fresh = picked.fresh
        nextState = picked.next
      }

      log('info', 'run(' + (o.reason || 'timer') + ') 退出码=' + result.exit_code +
        ' 告警=' + alerts.length + ' 新告警=' + fresh.length +
        (result.skipped ? ' [运行锁跳过]' : '') + (o.dryRun ? ' [dry-run]' : ''))

      if (o.dryRun || result.skipped || !fresh.length) {
        // 本轮没东西要冒泡也要落盘：把「已消失的告警键」清掉，
        // 否则那条告警日后重现会被当成「还在冷却里」而静默吞掉。
        if (!o.dryRun && !result.skipped) writeState(stateFile, nextState)
        return { ok: true, result, alerts, fresh }
      }

      if (o.notify === 'suppress') {
        writeState(stateFile, nextState)
        log('info', '手动检查：' + fresh.length + ' 条已在对话内回报，抑制冒泡')
        return { ok: true, result, alerts, fresh }
      }

      const sent = await bubble(fresh)
      if (sent > 0) writeState(stateFile, nextState)
      else log('warn', '两个通道都没送出去，冷却状态不推进（下一轮重试）')
      return { ok: true, result, alerts, fresh, sent }
    } finally {
      running = false
    }
  }

  /** localpost_check：真跑一轮 + 对话里回报；本轮告警视作"已告知"，不再弹窗 */
  async function manualCheck(args) {
    const dryRun = !!(args && args.dry_run)
    const verbose = !!(args && args.verbose)
    const out = await executeRun({
      dryRun,
      notify: dryRun ? 'none' : 'suppress',
      reason: 'manual',
    })
    if (!out.ok) {
      return '❌ LocalPost 局长跑不起来：' + out.error +
        '\n内核: ' + config.kernelPath + '\n插件日志: ' + logFile
    }
    if (out.held) return 'LocalPost 局长：跳过本轮（上一轮仍在运行，未重复对账）'
    const text = await report(out.result, verbose)
    const tail = dryRun
      ? '（dry-run 预览：未写盘、未推进账本、未冒泡）'
      : '（本轮 ' + out.fresh.length + ' 条告警已在对话内回报，不再弹窗；之后新出现的告警仍会冒泡）'
    return text + '\n' + tail
  }

  /* ------------------------- 对外暴露：工具 ------------------------- */

  ctx.effect(() => ctx.tools.register({
    name: 'localpost_check',
    description: '跑一轮 LocalPost 局长对账：查信箱里超时未回执的任务、坏信、附件缺失。',
    parameters: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean', description: '只预览不写盘（默认 false）' },
        verbose: { type: 'boolean', description: '附账本明细（默认 false）' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      return await manualCheck(args)
    },
  }), 'dsh-localpost-postmaster: localpost_check')

  /* ------------------------- 定时器（随 fiber 销毁） ------------------------- */

  timerDisposers.push(
    ctx.setTimeout(() => {
      void executeRun({ notify: 'bubble', reason: 'startup' })
    }, config.startupDelayMs),
    ctx.setInterval(() => {
      void executeRun({ notify: 'bubble', reason: 'timer' })
    }, Math.max(3000, Math.round(config.intervalMinutes * 60000))),
  )
  ctx.on?.('dispose', () => instance.stop('fiber 销毁'))

  /* ------------------- 隔离 E 验收入口（默认关闭，随 fiber 销毁） ------------------- */
  // 只有显式 eAcceptance.enabled === true 且 root 恰为隔离根时才注册命令与工具；
  // 生产 .mailbox 根及其任何子路径一律拒绝，默认行为与未接线前完全一致。
  ctx.effect(() => {
    let wiring
    try {
      // Row config first, then an explicit environment opt-in: either way the default is off, and the
      // wiring itself still refuses anything but the isolated root.
        const row = rawConfig && typeof rawConfig.eAcceptance === 'object' && rawConfig.eAcceptance !== null ? rawConfig.eAcceptance : {}
        const pick = (fromRow, envName) => typeof fromRow === 'string' && fromRow !== '' ? fromRow : process.env[envName]
      wiring = createIsolatedWiring({
        ctx,
        config: {
          enabled: row.enabled === true || process.env.DSH_LOCALPOST_E_ENABLED === '1',
          root: pick(row.root, 'DSH_LOCALPOST_E_ROOT'),
          // The exact senders the isolated receiver may wake. Split only - nothing trimmed or dropped - so a blank or
          // padded entry reaches the wiring's strict check and refuses it; an empty list is refused as well.
          allowFrom: allowFromConfig(pick(row.allowFrom, 'DSH_LOCALPOST_E_ALLOW_FROM')),
          scanIntervalMs: Number(pick(row.scanIntervalMs, 'DSH_LOCALPOST_E_SCAN_MS') ?? 30000),
          debounceMs: Number(pick(row.debounceMs, 'DSH_LOCALPOST_E_DEBOUNCE_MS') ?? 250),
        },
        runtimeVersion: pick(rawConfig && rawConfig.runtimeVersion, 'DSH_LOCALPOST_E_RUNTIME'),
        versionEvidence: pick(rawConfig && rawConfig.versionEvidence, 'DSH_LOCALPOST_E_EVIDENCE'),
      })
    } catch (error) {
      log('error', '隔离验收入口构建失败（未注册任何能力）：' + errText(error))
      return () => {}
    }
    if (!wiring.enabled) {
      log('info', '隔离验收入口未启用（' + wiring.reason + (wiring.detail ? '：' + wiring.detail : '') + '）')
      return () => {}
    }
    log('info', '隔离验收入口已就绪：status=' + wiring.status + ' root=' + wiring.parts.root +
      ' 命令=' + wiring.parts.bridge.capabilities.commandRegistry + ' tools=' + wiring.parts.tools.names.join(','))
    // Cordis rc.2 awaits this Promise. The wiring releases every registration even when stopping the receiver fails;
    // that failure is reported here rather than lost.
    return async () => {
      await wiring.dispose()
      const failure = wiring.parts.receiver.status().shutdownError
      if (failure) log('error', '隔离验收入口卸载时停止 receiver 失败（注册已全部释放）：' + failure)
    }
  }, 'dsh-localpost-postmaster: isolated E entry')

  log('info', '插件就绪：root=' + config.root + ' 间隔=' + config.intervalMinutes + ' 分钟' +
    ' ntfy=' + (config.ntfyEnabled ? 'on' : 'off') + ' toast=' + (config.toastEnabled ? 'on(error级)' : 'off') +
    ' 冷却=' + config.cooldownHours + 'h')
}
