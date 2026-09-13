/**
 * LocalPost 局长外壳 · 离线自测（改完插件先跑这个，别拿真宿主当调试器）
 * 用法: node test/selftest.mjs
 *
 * 覆盖：工具注册形状 / 手动查（suppress）/ 定时器新告警冒泡（ntfy 真发到本地假服务器）/
 *       error 级是否走 toast 分支 / 冷却去重 / 告警消失后状态清理 / dry-run 不写盘 /
 *       内核缺失时的报错文案 / 单例守卫（防重复冒泡）/ 不改写内核账本
 * 说明：toast 分支在受限沙箱里会以 spawn EPERM 失败，属预期；宿主机内应为「toast 已弹出」。
 */
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const MAILBOX = process.env.LOCALPOST_MAILBOX || 'C:/AI_ASSIST/.mailbox'
const KERNEL = join(MAILBOX, 'postmaster.mjs')
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
  mkdirSync(join(FIXTURE, 'agents', 'opencode', 'inbox'), { recursive: true })
  writeFileSync(join(FIXTURE, 'agents', 'opencode', 'inbox', name), JSON.stringify(env, null, 2))
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
check('导出了 name / inject / apply', mod.name === '@dsh-external/dsh-localpost-postmaster' &&
  Array.isArray(mod.inject) && mod.inject.includes('tools') && mod.inject.includes('timer') &&
  typeof mod.apply === 'function', JSON.stringify(mod.inject))
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

/* ---- 2. 手动查（suppress：对话内回报，不弹窗，但算「已告知」） ---- */
const manual = await toolDef.execute({})
const stateOf = () => JSON.parse(readFileSync(stateFile, 'utf8')).notified
const K1 = 'overdue|task-1|agents/opencode/inbox/task-1.json|'
check('手动查返回人话报告（含超时结论）', manual.includes('超时') && manual.includes('task-1'),
  manual.split('\n')[0])
check('手动查抑制冒泡（本轮不推 ntfy）', pushed.length === 0, 'pushed=' + pushed.length)
check('手动查把本轮告警记为「已告知」（冷却状态落盘）', existsSync(stateFile) && stateOf()[K1] !== undefined,
  Object.keys(existsSync(stateFile) ? stateOf() : {}).join(', '))
check('手动查后在报告尾部说明「已回报、不再弹窗」', manual.includes('已在对话内回报'))

/* ---- 3. 定时器路径：同一告警不该重复响（手动查过 = 已告知） ---- */
writeEnvelope('task-2.json', envelope('task-2', 'free', 10 * 60e3)) // free 阈值 1440min -> 未超时
await intervalFn()
await new Promise((r) => setTimeout(r, 300))
check('定时器路径：手动查过的告警不重复响', pushed.length === 0, 'pushed=' + pushed.length)

/* ---- 3b. 定时器路径：真·新告警 -> 冒泡（warn 级：只 ntfy，不 toast） ---- */
writeEnvelope('task-3.json', envelope('task-3', 'urgent', 40 * 60e3)) // urgent 阈值 15min -> overdue
await intervalFn()
await new Promise((r) => setTimeout(r, 500))
check('定时器路径推送了 ntfy', pushed.length === 1, JSON.stringify(pushed[0] || {}).slice(0, 160))
check('汇总文案含告警条数与要点', pushed.length === 1 && /LocalPost 局长 · \d+ 条告警/.test(pushed[0].title) &&
  pushed[0].message.includes('task-3'), pushed.length ? pushed[0].title + ' | ' + pushed[0].message.split('\n')[0] : '')
check('warn 级不弹 toast（仅 error 级）', !readFileSync(logFile, 'utf8').includes('toast 已弹出'))

/* ---- 4. 冷却：同一告警再跑不重复响 ---- */
await intervalFn()
await new Promise((r) => setTimeout(r, 300))
check('冷却生效：第二次跑不重复推送', pushed.length === 1, 'pushed=' + pushed.length)

/* ---- 5. 升级：改成严重超时（>4x 阈值）应再次响，并走 toast 分支 ---- */
writeEnvelope('task-1.json', envelope('task-1', 'standard', 10 * 3600e3)) // 600min > 480min -> error
await intervalFn()
await new Promise((r) => setTimeout(r, 2500))
const logText = readFileSync(logFile, 'utf8')
check('严重度升级到 error 时再次冒泡', pushed.length === 2, 'pushed=' + pushed.length)
check('error 级触发了 toast 分支（沙箱内 EPERM 属预期，宿主机内应为「已弹出」）',
  logText.includes('toast 已弹出') || logText.includes('toast 失败'),
  (logText.split('\n').filter((l) => l.includes('toast')).pop() || '').slice(0, 140))

/* ---- 6. dry-run：不写盘、不冒泡、不改状态 ---- */
const before = readFileSync(stateFile, 'utf8')
const dry = await toolDef.execute({ dry_run: true })
check('dry-run 报告标注预览', dry.includes('dry-run 预览'), dry.split('\n')[0])
check('dry-run 不动冷却状态', readFileSync(stateFile, 'utf8') === before)
check('dry-run 不新增推送', pushed.length === 2, 'pushed=' + pushed.length)

/* ---- 7. 坏信：error 级 + 独立键（不受冷却影响） ---- */
writeFileSync(join(FIXTURE, 'agents', 'opencode', 'inbox', 'broken.json'), '{ 这不是 JSON')
await intervalFn()
await new Promise((r) => setTimeout(r, 2500))
check('坏信被判为告警并冒泡', pushed.length === 3 && pushed[2].message.includes('坏信'),
  pushed.length > 2 ? pushed[2].message.split('\n')[0] : 'pushed=' + pushed.length)

/* ---- 7b. 状态清理：告警消失（收到回执）后旧键必须被删掉 ---- */
writeEnvelope('task-1.result.json', Object.assign(
  envelope('task-1-result', 'standard', 60e3), { type: 'result', reply_to: 'task-1' }))
await intervalFn()
await new Promise((r) => setTimeout(r, 300))
check('告警消失后冷却键被清理（下次再超时会重新响）', stateOf()[K1] === undefined,
  Object.keys(stateOf()).join(', '))

/* ---- 8. 内核缺失：不崩、给出可诊断文案 ---- */
const mod2 = await import(PLUGIN + '?v=2')
let tool2 = null
const ctx2 = Object.assign({}, ctx, { tools: { register(def) { tool2 = def; return () => {} } } })
mod2.apply(ctx2, {
  root: FIXTURE, kernelPath: 'C:/AI_ASSIST/temp/不存在的内核.mjs', intervalMinutes: 999,
  ntfyEnabled: false, toastEnabled: false, stateFile: join(TMP, 'state2.json'), logFile: join(TMP, 'log2.log'),
})
const broken = await tool2.execute({})
check('内核缺失时工具返回可诊断错误（不抛异常）',
  broken.includes('跑不起来') && broken.includes('不存在的内核.mjs'), broken.split('\n')[0])

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

/* ---- 10. 确认没碰内核的地盘 ---- */
const ledger = (() => { try { return JSON.parse(readFileSync(join(MAILBOX, 'ledger.json'), 'utf8')) } catch { return null } })()
check('内核 ledger.json 未被插件改写（唯一写者约束）', !!ledger && typeof ledger.envelopes === 'object',
  '条目=' + (ledger ? Object.keys(ledger.envelopes).length : '账本不可读'))

server.close()
const failed = results.filter((r) => !r.ok)
console.log('\n===== 自测小结: ' + (results.length - failed.length) + '/' + results.length + ' 通过 =====')
if (failed.length) {
  console.log('失败项:')
  for (const f of failed) console.log('  - ' + f.name + '  ' + (f.detail || ''))
  process.exitCode = 1
}
