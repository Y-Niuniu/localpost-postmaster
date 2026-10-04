/**
 * LocalPost 局长外壳 · 离线自测（改完插件先跑这个，别拿真宿主当调试器）
 * 用法: node test/selftest.mjs
 *
 * 覆盖：工具注册形状 / **localpost_check 入口拒绝（零锁、零读写信箱账本状态、零冒泡、零日志）** /
 *       定时器新告警冒泡（ntfy 真发到本地假服务器，入口停用不影响后台定时器）/
 *       error 级是否走 toast 分支 / 冷却去重 / 告警消失后状态清理 / dry-run 同样被入口拒绝 /
 *       入口拒绝与内核无关（内核缺失也拒绝且不抛异常）/ 单例守卫（防重复冒泡）/ 不改写内核账本
 * 说明：toast 分支在受限沙箱里会以 spawn EPERM 失败，属预期；宿主机内应为「toast 已弹出」。
 */
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const MAILBOX = process.env.LOCALPOST_MAILBOX || 'C:/AI_ASSIST/.mailbox'
const KERNEL = join(MAILBOX, 'postmaster.mjs')
const initialSourceLedger = existsSync(join(MAILBOX, 'ledger.json')) ? readFileSync(join(MAILBOX, 'ledger.json'), 'utf8') : null
const TMP = join(tmpdir(), 'localpost-selftest')
const FIXTURE = join(TMP, 'mailbox')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -> ' + detail : ''))
}
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()

function envelope(id, budget, msAgo, extra) {
  return Object.assign({
    id, thread_id: 'th-' + id, from: 'dsh', to: 'opencode', type: 'task',
    subject: '自测 ' + id, body: '正文', budget, created_at: iso(msAgo),
  }, extra || {})
}

function writeEnvelope(name, env) {
  mkdirSync(join(FIXTURE, 'agents', env.to, 'inbox'), { recursive: true })
  writeFileSync(join(FIXTURE, 'agents', env.to, 'inbox', name), JSON.stringify(env, null, 2))
}

/* ---- 假 ntfy 服务器：记录收到的推送 ---- */
const pushed = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    try { pushed.push(JSON.parse(body)) } catch { pushed.push({ raw: body }) }
    res.statusCode = 200
    res.end('{"ok":true}')
  })
})
await new Promise((r) => server.listen(8899, '127.0.0.1', r))

/* ---- 假 ctx：捕获工具注册与定时器，其余照直调用 ---- */
let toolDef = null
let startupFn = null
let intervalFn = null
const logs = []
const ctx = {
  logger: { info: (m) => logs.push('info ' + m), warn: (m) => logs.push('warn ' + m) },
  effect(fn) { return fn() },
  on() { return () => {} },
  setTimeout(fn) { startupFn = fn; return () => {} },
  setInterval(fn) { intervalFn = fn; return () => {} },
  tools: { register(def) { toolDef = def; return () => { toolDef = null } } },
}

/* ---- 清场 + 造 fixture ---- */
rmSync(TMP, { recursive: true, force: true })
mkdirSync(FIXTURE, { recursive: true })
writeEnvelope('task-1.json', envelope('task-1', 'standard', 3 * 3600e3)) // 3h > 120min 阈值 -> overdue warn

const mod = await import(PLUGIN)
const stateFile = join(TMP, 'state.json')
const logFile = join(TMP, 'plugin.log')
mod.apply(ctx, {
  root: FIXTURE,
  kernelPath: KERNEL,
  intervalMinutes: 999,
  startupDelayMs: 0,
  cooldownHours: 12,
  ntfyEnabled: true,
  ntfyServer: 'http://127.0.0.1:8899',
  ntfyTopic: 'selftest',
  toastEnabled: true,
  stateFile,
  logFile,
})

/* ---- 1. 注册形状 ---- */
check('导出了 name / inject / apply（含接线所需的 commands 与 agents）', mod.name === '@dsh-external/dsh-localpost-postmaster' &&
  Array.isArray(mod.inject) && mod.inject.includes('tools') && mod.inject.includes('timer') &&
  mod.inject.includes('commands') && mod.inject.includes('agents') &&
  typeof mod.apply === 'function', JSON.stringify(mod.inject))
check('隔离验收入口默认关闭（未注册任何命令）', logs.some(line => String(line).includes('隔离验收入口未启用')),
  logs.filter(line => String(line).includes('隔离验收入口')).join(' | '))
check('注册了 localpost_check 工具', !!toolDef && toolDef.name === 'localpost_check',
  toolDef ? toolDef.description : '未注册')
check('工具 output 形状合法（register 的硬性校验）',
  !!toolDef && toolDef.output && typeof toolDef.output.render === 'function' &&
  toolDef.output.schema && toolDef.output.schema.type === 'string')
check('工具 parameters 是 JSON Schema（object + 两个布尔参数）',
  !!toolDef && toolDef.parameters.type === 'object' &&
  toolDef.parameters.properties.dry_run.type === 'boolean' &&
  toolDef.parameters.properties.verbose.type === 'boolean')
check('挂上了启动检查与周期定时器', typeof startupFn === 'function' && typeof intervalFn === 'function')

/* ---- 2. localpost_check 入口拒绝：不取锁、不读写信箱/账本/状态、不冒泡、不追加日志 ---- */
const logBefore2 = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
const manual = await toolDef.execute({})
const stateOf = () => JSON.parse(readFileSync(stateFile, 'utf8')).notified
const K1 = 'overdue|task-1|agents/opencode/inbox/task-1.json|'
check('入口拒绝：返回停用说明，不再返回对账报告',
  manual.includes('已停用') && manual.includes('入口无条件拒绝') && !manual.includes('超时'),
  manual.split('\n')[0])
check('入口拒绝：不写冷却状态（stateFile 仍未创建）', !existsSync(stateFile), 'exists=' + existsSync(stateFile))
check('入口拒绝：不取根锁、不落账本/告警',
  !existsSync(join(FIXTURE, '.postmaster.lock')) && !existsSync(join(FIXTURE, 'ledger.json')) &&
  !existsSync(join(FIXTURE, 'alerts.json')) && !existsSync(join(FIXTURE, 'postmaster.log')),
  '锁=' + existsSync(join(FIXTURE, '.postmaster.lock')) + ' 账本=' + existsSync(join(FIXTURE, 'ledger.json')))
check('入口拒绝：不冒泡', pushed.length === 0, 'pushed=' + pushed.length)
check('入口拒绝：不追加插件日志',
  (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '') === logBefore2)
check('入口拒绝：逐个列出真实可用的原生工具（不含 localpost_check / localpost_e_*）',
  manual.includes('localpost_status') && manual.includes('localpost_inbox') && manual.includes('localpost_read') &&
  manual.includes('localpost_reply') && manual.includes('localpost_archive') && !manual.includes('localpost_e_'),
  manual.split('\n')[2])

/* ---- 3. 定时器路径不受入口停用影响：后台照跑、真·新告警照常冒泡 ---- */
writeEnvelope('task-2.json', envelope('task-2', 'free', 10 * 60e3)) // free 阈值 1440min -> 未超时
await intervalFn()
await new Promise((r) => setTimeout(r, 500))
check('入口停用不影响后台定时器：新告警照常冒泡（task-1 overdue）',
  pushed.length === 1 && pushed[0].message.includes('task-1'), 'pushed=' + pushed.length)
check('定时器路径照常写冷却状态', existsSync(stateFile) && stateOf()[K1] !== undefined,
  Object.keys(existsSync(stateFile) ? stateOf() : {}).join(', '))

/* ---- 3b. 定时器路径：真·新告警 -> 冒泡（warn 级：只 ntfy，不 toast） ---- */
writeEnvelope('task-3.json', envelope('task-3', 'urgent', 40 * 60e3)) // urgent 阈值 15min -> overdue
await intervalFn()
await new Promise((r) => setTimeout(r, 500))
check('定时器路径推送了 ntfy', pushed.length === 2, JSON.stringify(pushed[1] || {}).slice(0, 160))
check('汇总文案含告警条数与要点', pushed.length === 2 && /LocalPost 局长 · \d+ 条告警/.test(pushed[1].title) &&
  pushed[1].message.includes('task-3'), pushed.length > 1 ? pushed[1].title + ' | ' + pushed[1].message.split('\n')[0] : '')
check('warn 级不弹 toast（仅 error 级）', !readFileSync(logFile, 'utf8').includes('toast 已弹出'))

/* ---- 4. 冷却：同一告警再跑不重复响 ---- */
await intervalFn()
await new Promise((r) => setTimeout(r, 300))
check('冷却生效：第二次跑不重复推送', pushed.length === 2, 'pushed=' + pushed.length)

/* ---- 5. 升级：改成严重超时（>4x 阈值）应再次响，并走 toast 分支 ---- */
writeEnvelope('task-1.json', envelope('task-1', 'standard', 10 * 3600e3)) // 600min > 480min -> error
await intervalFn()
await new Promise((r) => setTimeout(r, 2500))
const logText = readFileSync(logFile, 'utf8')
check('严重度升级到 error 时再次冒泡', pushed.length === 3, 'pushed=' + pushed.length)
check('error 级触发了 toast 分支（沙箱内 EPERM 属预期，宿主机内应为「已弹出」）',
  logText.includes('toast 已弹出') || logText.includes('toast 失败'),
  (logText.split('\n').filter((l) => l.includes('toast')).pop() || '').slice(0, 140))

/* ---- 6. 入口拒绝对 dry-run 同样生效：不写盘、不冒泡、不动状态、不追加日志 ---- */
const before = readFileSync(stateFile, 'utf8')
const logBefore6 = readFileSync(logFile, 'utf8')
const dry = await toolDef.execute({ dry_run: true })
check('dry-run 也被入口拒绝（不进入内核）', dry.includes('已停用'), dry.split('\n')[0])
check('入口拒绝不动冷却状态', readFileSync(stateFile, 'utf8') === before)
check('入口拒绝不新增推送', pushed.length === 3, 'pushed=' + pushed.length)
check('入口拒绝不追加插件日志', readFileSync(logFile, 'utf8') === logBefore6)

/* ---- 7. 坏信：error 级 + 独立键（不受冷却影响） ---- */
writeFileSync(join(FIXTURE, 'agents', 'opencode', 'inbox', 'broken.json'), '{ 这不是 JSON')
await intervalFn()
await new Promise((r) => setTimeout(r, 2500))
check('坏信被判为告警并冒泡', pushed.length === 4 && pushed[3].message.includes('坏信'),
  pushed.length > 3 ? pushed[3].message.split('\n')[0] : 'pushed=' + pushed.length)

/* ---- 7b. 状态清理：告警消失（收到回执）后旧键必须被删掉 ---- */
writeEnvelope('task-1.result.json', Object.assign(
  envelope('task-1.result', 'standard', 60e3), { type: 'result', reply_to: 'task-1', from: 'opencode', to: 'dsh', thread_id: 'th-task-1', outcome: 'completed' }))
await intervalFn()
await new Promise((r) => setTimeout(r, 300))
check('告警消失后冷却键被清理（下次再超时会重新响）', stateOf()[K1] === undefined,
  Object.keys(stateOf()).join(', '))

/* ---- 8. 入口拒绝与内核无关：内核路径不存在也照样拒绝、不抛异常、不尝试加载内核 ---- */
const mod2 = await import(PLUGIN + '?v=2')
let tool2 = null
const ctx2 = Object.assign({}, ctx, { tools: { register(def) { tool2 = def; return () => {} } } })
mod2.apply(ctx2, {
  root: FIXTURE, kernelPath: 'C:/AI_ASSIST/temp/不存在的内核.mjs', intervalMinutes: 999,
  ntfyEnabled: false, toastEnabled: false, stateFile: join(TMP, 'state2.json'), logFile: join(TMP, 'log2.log'),
})
const broken = await tool2.execute({})
check('入口拒绝不依赖内核（内核缺失也返回同一拒绝，不出现「跑不起来」）',
  broken.includes('已停用') && !broken.includes('跑不起来'), broken.split('\n')[0])

/* ---- 9. 单例守卫：新实例接管后，旧实例的定时器必须闭嘴（防重复冒泡） ---- */
const pushedBefore = pushed.length
writeEnvelope('task-9.json', envelope('task-9', 'urgent', 60 * 60e3)) // urgent 阈值 15min -> overdue
await intervalFn()
await new Promise((r) => setTimeout(r, 400))
check('单例守卫：旧实例被接管后不再冒泡', pushed.length === pushedBefore,
  'pushed=' + pushed.length + '（接管前 ' + pushedBefore + '）')
check('单例守卫：旧实例停摆在日志里留痕',
  readFileSync(logFile, 'utf8').includes('实例已停止'),
  (readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('实例已停止')).pop() || '').slice(0, 120))

/* ---- 9b. 交付层补充断言（agent/opencode · base_rev 8aceea3） ---- */
const notify = await import(new URL('../lib/notify.js', import.meta.url).href)

// ① alertKey 稳定性：同一封问题信跨轮必须得到同一个键 —— 键变了 = 冷却失效 = 每轮重复弹窗
const alertA = { kind: 'overdue', id: 'task-x', path: 'agents/opencode/inbox/task-x.json', attachment: '' }
const keyFirst = notify.alertKey(alertA)
check('alertKey 稳定：同内容告警跨轮同键',
  notify.alertKey(Object.assign({}, alertA)) === keyFirst &&
  keyFirst === 'overdue|task-x|agents/opencode/inbox/task-x.json|', keyFirst)
check('alertKey 区分：kind 或 id 变了必须换键',
  notify.alertKey(Object.assign({}, alertA, { id: 'task-y' })) !== keyFirst &&
  notify.alertKey(Object.assign({}, alertA, { kind: 'malformed' })) !== keyFirst)
check('alertKey 容错：缺字段/空值返占位而非 undefined',
  notify.alertKey({}) === '?|||' && notify.alertKey(null) === '?|||', notify.alertKey({}))

// ② selectFresh 的 12h 冷却边界：判定必须是「严格超过」，恰好 12h 仍算冷却中
const COOL = 12 * 3600e3
const T0 = Date.parse('2026-09-13T00:00:00.000Z')
const KB = 'overdue|task-b|agents/opencode/inbox/task-b.json|'
const alertB = { kind: 'overdue', id: 'task-b', path: 'agents/opencode/inbox/task-b.json', severity: 'warn' }
const stateB = { schema: 'localpost-notify-v1', notified: { [KB]: { at: new Date(T0).toISOString(), severity: 'warn' } } }
check('12h 冷却边界：恰好 12h 仍静默（严格超过才重提）',
  notify.selectFresh([alertB], stateB, COOL, T0 + COOL).fresh.length === 0)
check('12h 冷却边界：超过 1ms 即重提',
  notify.selectFresh([alertB], stateB, COOL, T0 + COOL + 1).fresh.length === 1)

/* ---- 9c. readState 容错与 selectFresh 状态清理（agent/opencode · base_rev ebbddfd） ---- */
const safeReadState = (file) => {
  try { return { threw: false, state: notify.readState(file) } } catch (e) { return { threw: true, error: String(e) } }
}
const isEmptyState = (r) => !r.threw && !!r.state && !!r.state.notified && Object.keys(r.state.notified).length === 0

const rMissing = safeReadState(join(TMP, 'state-missing.json'))
check('readState 容错：文件不存在 → 空状态且不抛异常', isEmptyState(rMissing),
  rMissing.threw ? '抛异常: ' + rMissing.error : JSON.stringify(rMissing.state.notified))

const badJsonFile = join(TMP, 'state-bad-json.json')
writeFileSync(badJsonFile, '{ 这不是 JSON', 'utf8')
const rBadJson = safeReadState(badJsonFile)
check('readState 容错：非法 JSON → 空状态且不抛异常', isEmptyState(rBadJson),
  rBadJson.threw ? '抛异常: ' + rBadJson.error : JSON.stringify(rBadJson.state.notified))

const badShapeFile = join(TMP, 'state-bad-shape.json')
writeFileSync(badShapeFile, JSON.stringify({ hello: 1 }), 'utf8')
const rBadShape = safeReadState(badShapeFile)
check('readState 容错：JSON 合法但结构不对（缺 notified）→ 退回空状态', isEmptyState(rBadShape),
  rBadShape.threw ? '抛异常: ' + rBadShape.error : JSON.stringify(rBadShape.state.notified))

const K_RESOLVED = 'overdue|task-resolved|agents/opencode/inbox/task-resolved.json|'
const stateResolved = { schema: 'localpost-plugin-state-v1', notified: { [K_RESOLVED]: { at: new Date(T0).toISOString(), severity: 'warn' } } }
const rResolved = notify.selectFresh([alertB], stateResolved, COOL, T0)
check('selectFresh 清理：告警已解决（本轮不存在）→ 旧键被删',
  !(K_RESOLVED in rResolved.next.notified), Object.keys(rResolved.next.notified).join(', '))

const K_ZOMBIE = 'overdue|task-zombie|agents/opencode/inbox/task-zombie.json|'
const zombieAlert = { kind: 'overdue', id: 'task-zombie', path: 'agents/opencode/inbox/task-zombie.json', severity: 'warn' }
const zombieState = { schema: 'localpost-plugin-state-v1', notified: { [K_ZOMBIE]: { at: new Date(T0 - 31 * 24 * 3600e3).toISOString(), severity: 'warn' } } }
const rZombie = notify.selectFresh([zombieAlert], zombieState, 365 * 24 * 3600e3, T0)
check('selectFresh 清理：超 30 天保留期的僵尸键被删（本轮仍存在、冷却极大）',
  !(K_ZOMBIE in rZombie.next.notified), Object.keys(rZombie.next.notified).join(', '))

/* ---- 11. 单一配置源：<root>/postmaster.config.json（2026-09-13 加固）----
 * 私人 ntfy topic 与定时器间隔都从配置文件读，源码 DEFAULTS 里只有空/关。
 * 这一段就是「别把私人 topic 抄回源码」的机器判据 —— 谁抄回去、什么时候抄的，这里会红。
 * 同时锁住内核侧的两个死键，防止有人再把"看起来能配"的开关加回 DEFAULT_CONFIG。 */
function readyLineOf(fileCfg) {
  const suffix = Math.random().toString(36).slice(2)
  const root = join(TMP, 'cfgroot-' + suffix)
  mkdirSync(root, { recursive: true })
  if (fileCfg) writeFileSync(join(root, 'postmaster.config.json'), JSON.stringify(fileCfg))
  const seen = []
  const ctx2 = {
    logger: { info: (m) => seen.push(m), warn: (m) => seen.push(m) },
    effect(fn) { return fn() },
    on() { return () => {} },
    setTimeout() { return () => {} },   // 故意不触发首轮 run：本段只验配置解析
    setInterval() { return () => {} },
    tools: { register() { return () => {} } },
  }
  mod.apply(ctx2, {
    root, kernelPath: join(root, 'no-such-kernel.mjs'), startupDelayMs: 0,
    // 显式给 fixture 的 state/log：不给就会落到真实用户目录（DSH_HOME 未设置时 = ~/.dsh/localpost-postmaster），
    // 这正是 2026-10-04 复审指出的日志外溢缺陷；回归门禁见 localpost/test-isolation.test.mjs。
    stateFile: join(TMP, 'cfgroot-' + suffix + '-state.json'),
    logFile: join(TMP, 'cfgroot-' + suffix + '-plugin.log'),
  })
  return (seen.join('\n').split('\n').filter((l) => l.includes('插件就绪')).pop() || '')
}

const lineWithCfg = readyLineOf({
  intervalMinutes: 7,
  notify: { ntfyEnabled: true, ntfyServer: 'http://127.0.0.1:8899', ntfyTopic: 't-from-config-file' },
})
check('配置文件：notify.ntfyEnabled 被读到 -> ntfy=on', lineWithCfg.includes('ntfy=on'), lineWithCfg.slice(-58))
check('配置文件：顶层 intervalMinutes 被读到 -> 间隔=7', lineWithCfg.includes('间隔=7'), lineWithCfg.slice(-58))

const lineNoCfg = readyLineOf(null)
check('无配置文件时回到源码默认（ntfy=off 且 间隔=15）',
  lineNoCfg.includes('ntfy=off') && lineNoCfg.includes('间隔=15'), lineNoCfg.slice(-58))

const libSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8') +
  readFileSync(new URL('../lib/notify.js', import.meta.url), 'utf8')
check('lib/ 下没有任何非空 ntfyTopic 字面量（私人 topic 不许抄回源码）',
  !/ntfyTopic:\s*'[^']+'/.test(libSrc),
  (libSrc.match(/ntfyTopic:\s*'[^']*'/) || ['无 ntfyTopic 字面量'])[0])

const kernelSrc = readFileSync(KERNEL, 'utf8')
const defBlock = (kernelSrc.match(/export const DEFAULT_CONFIG = \{[\s\S]*?\n\}/) || [''])[0]
check('内核 DEFAULT_CONFIG 里没有"声明了没人读"的死键（scanIntervalMinutes / ignoreTypes）',
  !!defBlock && !/scanIntervalMinutes|ignoreTypes/.test(defBlock),
  defBlock.replace(/\s+/g, ' ').slice(0, 76))

/* ---- 12. 确认没碰内核的地盘 ---- */
const finalSourceLedger = existsSync(join(MAILBOX, 'ledger.json')) ? readFileSync(join(MAILBOX, 'ledger.json'), 'utf8') : null
check('插件只运行fixture内核，源目录ledger字节未改变', finalSourceLedger === initialSourceLedger)

server.close()
const failed = results.filter((r) => !r.ok)
console.log('\n===== 自测小结: ' + (results.length - failed.length) + '/' + results.length + ' 通过 =====')
if (failed.length) {
  console.log('失败项:')
  for (const f of failed) console.log('  - ' + f.name + '  ' + (f.detail || ''))
  process.exitCode = 1
}
