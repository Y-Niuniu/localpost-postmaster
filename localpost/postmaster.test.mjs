/**
 * LocalPost 局长内核 · 测试
 * 运行: node .mailbox/postmaster.test.mjs
 * 用 Node 内置测试器（零依赖）。测行为，不测实现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runOnce, reconcile, readAlerts, loadConfig, validateEnvelope, isTerminalResult, KERNEL_VERSION } from './postmaster.mjs'
import { removeTreeSync } from './temp-tree.mjs'

// 2026-10-06：本文件的 makeRoot 此前**不清理**临时根 ⇒ 每次跑全套都在系统 temp（或被 runner 改指到
// .localpost-tmp/suite）里留下 localpost-test-* 目录。现在逐个登记并在 after 钩子收口。
const createdRoots = []
async function makeRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'localpost-test-'))
  createdRoots.push(root)
  await fsp.mkdir(path.join(root, 'agents'), { recursive: true })
  await fsp.mkdir(path.join(root, 'attachments'), { recursive: true })
  return root
}
test.after(() => { for (const dir of createdRoots) removeTreeSync(dir) })

async function put(root, agent, folder, name, content) {
  const dir = path.join(root, 'agents', agent, folder)
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fsp.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8')
  return file
}

function env(over) {
  return Object.assign({
    id: 'task-1', thread_id: 'th-1', from: 'dsh', to: 'opencode', type: 'task',
    subject: '测试任务', body: '正文', budget: 'standard', created_at: new Date().toISOString(),
  }, over || {})
}

function resultOf(taskId, over) {
  return env(Object.assign({
    id: taskId + '.result', type: 'result', reply_to: taskId,
    from: 'opencode', to: 'dsh', created_at: new Date().toISOString(),
  }, over || {}))
}

function minutesAgo(m) { return new Date(Date.now() - m * 60000).toISOString() }
async function exists(p) { try { await fsp.access(p); return true } catch { return false } }
async function writeLedger(root, envelopes) {
  await fsp.writeFile(path.join(root, 'ledger.json'),
    JSON.stringify({ schema: 'localpost-ledger-v0.2', envelopes: envelopes }, null, 2), 'utf8')
}

test('内核版本号可读', () => { assert.match(KERNEL_VERSION, /^\d+\.\d+\.\d+$/) })

test('信封校验：缺字段报错，完整信封通过', () => {
  assert.equal(validateEnvelope(env()).ok, true)
  const bad = validateEnvelope({ id: 'x' })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.length >= 8)
  assert.equal(validateEnvelope(env({ budget: '瞎写' })).ok, false)
  assert.equal(validateEnvelope(env({ created_at: '不是时间' })).ok, false)
})

test('已回执的任务不产生告警、退出码 0', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'archive', 'task-1.json', env({ created_at: minutesAgo(500) }))
  await put(root, 'dsh', 'archive', 'task-1.result.json', resultOf('task-1', { created_at: minutesAgo(495) }))
  const r = await runOnce({ root })
  assert.equal(r.exit_code, 0)
  assert.equal(r.alerts.alerts.length, 0)
  assert.equal(r.ledger_summary.replied, 1)
})

test('未超时的任务是 sent 状态，不算告警', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'inbox', 'task-1.json', env({ created_at: minutesAgo(10) }))
  const r = await runOnce({ root })
  assert.equal(r.exit_code, 0)
  assert.equal(r.ledger_summary.sent, 1)
  assert.equal(r.alerts.alerts.length, 0)
})

test('超时的任务产生 warn 告警、退出码 1', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'inbox', 'task-1.json', env({ created_at: minutesAgo(180) }))
  const r = await runOnce({ root })
  assert.equal(r.exit_code, 1)
  const a = r.alerts.alerts[0]
  assert.equal(a.kind, 'overdue')
  assert.equal(a.severity, 'warn')
  assert.equal(a.timeout_minutes, 120)
  assert.ok(a.age_minutes >= 179 && a.age_minutes <= 181)
  assert.equal(r.ledger_summary.overdue, 1)
})

test('严重超时升级为 error（超过阈值 x4）', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'inbox', 'task-1.json', env({ created_at: minutesAgo(600) }))
  const r = await runOnce({ root })
  assert.equal(r.alerts.alerts[0].severity, 'error')
})

test('urgent 档用 15 分钟阈值', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'inbox', 'task-1.json', env({ budget: 'urgent', created_at: minutesAgo(30) }))
  const r = await runOnce({ root })
  assert.equal(r.alerts.alerts[0].timeout_minutes, 15)
})

test('坏信不中断整轮：坏信报错，正常信照常记账', async () => {
  const root = await makeRoot()
  await put(root, 'dsh', 'inbox', 'broken.json', '{ 这不是 JSON')
  await put(root, 'dsh', 'inbox', 'incomplete.json', JSON.stringify({ id: 'x', type: 'task' }))
  await put(root, 'opencode', 'archive', 'task-1.json', env({ created_at: minutesAgo(400) }))
  await put(root, 'dsh', 'archive', 'task-1.result.json', resultOf('task-1'))
  const r = await runOnce({ root })
  assert.equal(r.alerts.scan.malformed, 2)
  assert.equal(r.ledger_summary.replied, 1)
  assert.equal(r.alerts.alerts.filter((a) => a.kind === 'malformed').length, 2)
  assert.equal(r.exit_code, 1)
})

test('附件缺失报 warn；附件存在则安静', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'inbox', 'task-1.json', env({ created_at: minutesAgo(5), attachments: ['有.txt'] }))
  await fsp.writeFile(path.join(root, 'attachments', '有.txt'), 'hi', 'utf8')
  const ok = await runOnce({ root })
  assert.equal(ok.alerts.alerts.filter((a) => a.kind === 'missing_attachment').length, 0)

  await put(root, 'opencode', 'inbox', 'task-2.json', env({ id: 'task-2', created_at: minutesAgo(5), attachments: ['没有.txt'] }))
  const bad = await runOnce({ root })
  const miss = bad.alerts.alerts.filter((a) => a.kind === 'missing_attachment')
  assert.equal(miss.length, 1)
  assert.equal(miss[0].attachment, '没有.txt')
})

test('账本丢失时自动重建，旧账本另存 .bak', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'archive', 'task-1.json', env({ created_at: minutesAgo(10) }))
  const r1 = await runOnce({ root })
  assert.equal(r1.rebuilt, false)
  assert.equal(r1.initialized, true)
  assert.equal(await exists(path.join(root, 'ledger.json')), true)

  await fsp.unlink(path.join(root, 'ledger.json'))
  const r2 = await runOnce({ root })
  assert.equal(r2.rebuilt, false)
  assert.equal(r2.initialized, true)
  assert.equal(r2.ledger_summary.total, 1)
  assert.equal(r2.exit_code, 0)

  const r3 = await runOnce({ root })
  assert.equal(r3.rebuilt, false)
  assert.equal(await exists(path.join(root, 'ledger.json.bak')), true)
})

test('账本损坏时重建并备份 .bak', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'archive', 'task-1.json', env({ created_at: minutesAgo(10) }))
  await fsp.writeFile(path.join(root, 'ledger.json'), '{ 坏掉的账本', 'utf8')
  const r = await runOnce({ root })
  assert.equal(r.rebuilt, true)
  assert.equal(r.ledger_summary.total, 1)
  assert.equal(await exists(path.join(root, 'ledger.json.bak')), true)
})

test('状态只前进不回退：账本记 replied，即使信件被清掉也不退回超时', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'archive', 'task-1.json', env({ created_at: minutesAgo(500) }))
  await writeLedger(root, { 'task-1': { status: 'replied', type: 'task', from: 'dsh', to: 'opencode', sent_at: minutesAgo(500) } })
  const r = await runOnce({ root })
  assert.equal(r.ledger_summary.replied, 1)
  assert.equal(r.alerts.alerts.filter((a) => a.kind === 'overdue').length, 0)
  assert.equal(r.exit_code, 0)
})

test('--rebuild 从信封重建账本：粘滞的假 replied 恢复真实状态，真实完成不受影响', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'archive', 'task-1.json', env({ created_at: minutesAgo(500) }))
  await writeLedger(root, { 'task-1': { status: 'replied', type: 'task', from: 'dsh', to: 'opencode', sent_at: minutesAgo(500), replied_at: minutesAgo(490), reply_envelope: 'task-1.result' } })
  const sticky = await runOnce({ root })
  assert.equal(sticky.ledger_summary.replied, 1)
  assert.equal(sticky.alerts.alerts.filter((a) => a.kind === 'overdue').length, 0)
  const rebuilt = await runOnce({ root, rebuild: true })
  assert.equal(rebuilt.rebuilt, true)
  assert.equal(rebuilt.ledger_summary.replied, 0)
  assert.equal(rebuilt.ledger_summary.overdue, 1)
  assert.equal(rebuilt.alerts.alerts.filter((a) => a.kind === 'overdue').length, 1)
  assert.equal(rebuilt.exit_code, 1)
  await put(root, 'dsh', 'archive', 'task-1.result.json', resultOf('task-1', { created_at: minutesAgo(495) }))
  const again = await runOnce({ root, rebuild: true })
  assert.equal(again.ledger_summary.replied, 1)
  assert.equal(again.alerts.alerts.length, 0)
  assert.equal(again.exit_code, 0)
})

test('账本有记录但信封已消失 → envelope_missing 告警', async () => {
  const root = await makeRoot()
  await writeLedger(root, { 'ghost-1': { status: 'sent', type: 'task', from: 'a', to: 'b', sent_at: minutesAgo(200) } })
  const r = await runOnce({ root })
  const g = r.alerts.alerts.filter((a) => a.kind === 'envelope_missing')
  assert.equal(g.length, 1)
  assert.equal(g[0].id, 'ghost-1')
  assert.equal(r.exit_code, 1)
})

test('dry-run 不写任何文件', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'inbox', 'task-1.json', env({ created_at: minutesAgo(5) }))
  const r = await runOnce({ root, dryRun: true })
  assert.equal(r.dry_run, true)
  assert.equal(await exists(path.join(root, 'ledger.json')), false)
  assert.equal(await exists(path.join(root, 'alerts.json')), false)
  assert.equal(await exists(path.join(root, '.postmaster.lock')), false)
  assert.equal(await exists(path.join(root, 'postmaster.log')), false)
})

test('运行锁：新鲜的锁会让本轮跳过', async () => {
  const root = await makeRoot()
  await fsp.writeFile(path.join(root, '.postmaster.lock'),
    JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }), 'utf8')
  const r = await runOnce({ root })
  assert.equal(r.skipped, true)
  assert.equal(r.exit_code, 0)
  assert.equal(await exists(path.join(root, 'ledger.json')), false)
})

test('陈旧的锁（超过 5 分钟）不阻塞本轮', async () => {
  const root = await makeRoot()
  await fsp.writeFile(path.join(root, '.postmaster.lock'),
    JSON.stringify({ pid: 999999, started_at: minutesAgo(30) }), 'utf8')
  const r = await runOnce({ root })
  assert.equal(r.skipped, false)
})

test('正文超 200 字只记软警告，不算坏信', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'inbox', 'task-1.json', env({ body: 'x'.repeat(300), created_at: minutesAgo(5) }))
  const r = await runOnce({ root })
  assert.equal(r.alerts.scan.warnings, 1)
  assert.equal(r.alerts.scan.malformed, 0)
  assert.equal(r.exit_code, 0)
})

test('输出契约：alerts.json 字段齐全，readAlerts 能读回', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'inbox', 'task-1.json', env({ created_at: minutesAgo(200) }))
  await runOnce({ root })
  const a = await readAlerts({ root })
  assert.equal(a.schema, 'localpost-alerts-v1')
  assert.equal(typeof a.generated_at, 'string')
  assert.equal(a.scan.tasks, 1)
  const x = a.alerts[0]
  for (const f of ['id', 'kind', 'severity', 'age_minutes', 'from', 'to', 'budget', 'subject', 'count']) {
    assert.ok(Object.prototype.hasOwnProperty.call(x, f), '缺字段 ' + f)
  }
  assert.equal(await readAlerts({ root: path.join(root, '不存在') }), null)
})

test('配置文件可覆盖默认阈值', async () => {
  const root = await makeRoot()
  await fsp.writeFile(path.join(root, 'postmaster.config.json'),
    JSON.stringify({ timeouts: { standard: 5 } }), 'utf8')
  const cfg = await loadConfig({ root })
  assert.equal(cfg.timeouts.standard, 5)
  assert.equal(cfg.timeouts.urgent, 15)
  await put(root, 'opencode', 'inbox', 'task-1.json', env({ created_at: minutesAgo(30) }))
  const r = await runOnce({ root })
  assert.equal(r.alerts.alerts[0].timeout_minutes, 5)
})

test('回执须来自任务收件方、回到发件方且属于原线程', () => {
  const task = env({ created_at: minutesAgo(500) })
  const wrong = resultOf(task.id, { from: 'intruder' })
  const r = reconcile({
    scan: { envelopes: [
      { env: task, agent: task.to, folder: 'inbox', path: 'task.json' },
      { env: wrong, agent: task.from, folder: 'inbox', path: 'wrong.result.json' },
    ], malformed: [], agents: ['dsh', 'opencode'], attachmentsOnDisk: [] },
    ledger: { envelopes: {} }, config: { timeouts: { standard: 120 }, escalateMultiplier: 4 },
  })
  assert.equal(r.ledger.envelopes[task.id].status, 'overdue')
  assert.ok(r.alerts.some((a) => a.kind === 'invalid_reply'))
})

function reconcileItems(items) {
  return reconcile({
    scan: { envelopes: items.map((e) => ({ env: e, agent: e.to, folder: 'inbox', path: e.id + '.json' })),
      malformed: [], agents: ['dsh', 'opencode'], attachmentsOnDisk: [] },
    ledger: { envelopes: {} }, config: { timeouts: { standard: 120 }, escalateMultiplier: 4 },
  })
}

test('等待授权回复不结束任务，完成结果优先于较新的等待授权回复', () => {
  const task = env({ created_at: minutesAgo(500) })
  const waiting = resultOf(task.id, { id: 'task-1.waiting', outcome: 'needs_authorization' })
  const pending = reconcileItems([task, waiting])
  assert.equal(pending.ledger.envelopes[task.id].status, 'awaiting_authorization')
  const completed = resultOf(task.id, { outcome: 'completed', created_at: minutesAgo(2) })
  const done = reconcileItems([task, completed, waiting])
  assert.equal(done.ledger.envelopes[task.id].status, 'replied')
  assert.equal(done.ledger.envelopes[task.id].reply_envelope, completed.id)
})

test('等待授权只认信封顶层 outcome：正文写「需要授权」但缺 outcome 仍是终态', () => {
  const task = env({ created_at: minutesAgo(500) })
  const bodyOnly = resultOf(task.id, { body: '需要用户授权才能继续' })
  assert.equal(isTerminalResult(bodyOnly), true)
  const closed = reconcileItems([task, bodyOnly]).ledger.envelopes[task.id]
  assert.equal(closed.status, 'replied')
  assert.equal(closed.outcome, 'completed')
  const flagged = resultOf(task.id, { id: 'task-1.result.auth-1', body: '需要用户授权才能继续', outcome: 'needs_authorization' })
  assert.equal(isTerminalResult(flagged), false)
  assert.equal(reconcileItems([task, flagged]).ledger.envelopes[task.id].status, 'awaiting_authorization')
  for (const outcome of ['completed', 'failed', 'rejected', 'cancelled']) assert.equal(isTerminalResult(resultOf(task.id, { outcome })), true)
  assert.equal(validateEnvelope(resultOf(task.id, { outcome: '需要授权' })).ok, false)
})

test('同 ID 相同信封只计一次，不同正文隔离并明确告警', () => {
  const task = env({ created_at: minutesAgo(500) })
  const same = reconcileItems([task, { ...task }])
  assert.equal(same.alerts.filter((a) => a.kind === 'overdue').length, 1)
  assert.equal(same.ledger.envelopes[task.id].overdue_count, 1)
  const conflict = reconcileItems([task, { ...task, body: '不同的内容' }])
  assert.ok(conflict.alerts.some((a) => a.kind === 'id_conflict'))
  assert.equal(conflict.ledger.envelopes[task.id], undefined)
})

test('并发对账只有一个有效写入者', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'inbox', 'task-1.json', env({ created_at: minutesAgo(1) }))
  const runs = await Promise.all(Array.from({ length: 8 }, () => runOnce({ root })))
  assert.equal(runs.filter((r) => !r.skipped).length, 1)
  assert.ok(runs.every((r) => r.exit_code === 0))
})

test('错误告警优先排序，持久日志记录实际退出码', async () => {
  const root = await makeRoot()
  await put(root, 'opencode', 'inbox', 'task-1.json', env({ created_at: minutesAgo(600), attachments: ['missing.txt'] }))
  const r = await runOnce({ root })
  assert.equal(r.alerts.alerts[0].severity, 'error')
  assert.equal(r.exit_code, 1)
  assert.match(await fsp.readFile(path.join(root, 'postmaster.log'), 'utf8'), /退出码=1/)
})
