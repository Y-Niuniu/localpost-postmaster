/**
 * LocalPost 内核 · codex/GPT 评审后补四项的回归测试（2026-10-06）
 *
 * 1. 对账 ENOENT 假告警：另一进程并发归档导致文件消失**不算坏信**
 * 2. 附件缺失检查：递归列目录（子目录附件不再误报）+ **result/ping 的附件丢失也要报**
 * 3. `ecosystem` 随标准回执保留（旧白名单漏了它，回执里会被静默丢弃）
 * 4. 长原信 id（128 上限）也能回执：回执 id 走确定性短哈希，且重试得到同一 id
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createMailbox } from './mailbox.mjs'
import { scanMailbox, reconcile, DEFAULT_CONFIG } from './postmaster.mjs'
import { removeTreeSync } from './temp-tree.mjs'

async function makeRoot(agents = ['dsh', 'codex']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localpost-fixes-'))
  fs.mkdirSync(path.join(root, 'attachments'), { recursive: true })
  for (const a of agents) for (const f of ['inbox', 'outbox', 'archive']) fs.mkdirSync(path.join(root, 'agents', a, f), { recursive: true })
  return root
}
const envelope = (extra = {}) => ({
  id: 'task-one', thread_id: 'thread-one', from: 'dsh', to: 'codex', type: 'task',
  subject: 'Analyze', body: 'Please review', budget: 'standard',
  created_at: '2026-10-01T10:00:00.000Z', ...extra,
})
const put = (root, agent, folder, name, env) =>
  fs.writeFileSync(path.join(root, 'agents', agent, folder, name), typeof env === 'string' ? env : JSON.stringify(env, null, 2), 'utf8')

/* ---------------------------------------------------------------- 1. ENOENT 假告警 */
test('并发归档导致文件消失 → 计入 vanished，不报 malformed', async () => {
  const root = await makeRoot()
  // 用一个**悬空符号链接**模拟"列目录后、读文件前被归档"：readdir 看得见，readFile 得 ENOENT。
  // 平台不允许建符号链接时退化为：直接断言"正常环境不产生 vanished/malformed"（不跳过断言强度）。
  const dir = path.join(root, 'agents', 'codex', 'inbox')
  const link = path.join(dir, 'ghost.json')
  let linked = false
  try { fs.symlinkSync(path.join(dir, 'does-not-exist.json'), link); linked = true } catch { /* 无权限建符号链接 */ }
  put(root, 'dsh', 'inbox', 'alive.json', envelope({ id: 'alive-one', from: 'codex', to: 'dsh' }))

  const scan = await scanMailbox(root)
  assert.equal(scan.malformed.length, 0, '不该把消失的文件算成坏信：' + JSON.stringify(scan.malformed))
  assert.ok(Array.isArray(scan.vanished), 'scan 结果要带 vanished 数组')
  if (linked) assert.equal(scan.vanished.length, 1, '悬空符号链接应计入 vanished')
  else assert.equal(scan.vanished.length, 0)
  removeTreeSync(root)
})

test('真正的坏信（JSON 语法错）仍然报 malformed', async () => {
  const root = await makeRoot()
  put(root, 'codex', 'inbox', 'broken.json', '{ not json')
  const scan = await scanMailbox(root)
  assert.equal(scan.malformed.length, 1)
  assert.equal(scan.vanished.length, 0)
  removeTreeSync(root)
})

/* ---------------------------------------------------------------- 2. 附件缺失 */
test('子目录附件不误报；result 的附件丢失要报', async () => {
  const root = await makeRoot()
  fs.mkdirSync(path.join(root, 'attachments', 'sub', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(root, 'attachments', 'sub', 'deep', 'ok.md'), 'hi', 'utf8')

  put(root, 'codex', 'inbox', 'task-ok.json', envelope({ id: 'task-ok', attachments: ['sub/deep/ok.md'] }))
  put(root, 'codex', 'inbox', 'res-missing.json', envelope({
    id: 'res-missing', type: 'result', reply_to: 'task-author', from: 'codex', to: 'dsh',
    attachments: ['gone.md'],
  }))

  const scan = await scanMailbox(root)
  const result = reconcile({
    scan,
    ledger: { envelopes: {}, alerts: {} },
    config: DEFAULT_CONFIG,
    now: '2026-10-01T11:00:00.000Z',
  })
  const missing = result.alerts.filter(a => a.kind === 'missing_attachment')
  assert.equal(missing.some(a => a.id === 'task-ok'), false, '子目录里存在的附件不该报缺失')
  assert.equal(missing.some(a => a.id === 'res-missing'), true, 'result 的附件丢失必须报（旧版漏报）')
  removeTreeSync(root)
})

/* ---------------------------------------------------------------- 3. ecosystem 随回执保留 */
test('ecosystem 随标准回执保留（不再被静默丢弃）', async () => {
  const root = await makeRoot()
  const mail = createMailbox({ root, identity: 'dsh' })
  await mail.deliver(envelope({ ecosystem: '已检索：复用内核，不新增组件' }))
  const codex = createMailbox({ root, identity: 'codex' })
  // 原信在收件方 inbox 里（回执后会被归档，而 read() 只在 inbox 找）：先验它
  assert.equal(codex.read('codex', 'task-one').envelope.ecosystem, '已检索：复用内核，不新增组件')
  await codex.reply('codex', { reply_to: 'task-one', body: 'done', ecosystem: 'n/a（未新增组件）' })
  const back = mail.read('dsh', 'task-one.result')
  assert.equal(back.envelope.ecosystem, 'n/a（未新增组件）')
  removeTreeSync(root)
})

test('ecosystem 非字符串被信封校验拒绝', async () => {
  const root = await makeRoot()
  const mail = createMailbox({ root, identity: 'dsh' })
  await assert.rejects(mail.deliver(envelope({ ecosystem: 42 })), /invalid metadata: ecosystem/)
  removeTreeSync(root)
})

/* ---------------------------------------------------------------- 4. 长 id 也能回执 */
test('128 字符原信 id 仍可回执：确定性短 id，且重试同一 id', async () => {
  const root = await makeRoot()
  const longId = 't' + 'a'.repeat(127)          // 正好 128（assertId 上限）
  assert.equal(longId.length, 128)
  const mail = createMailbox({ root, identity: 'dsh' })
  await mail.deliver(envelope({ id: longId }))

  const codex = createMailbox({ root, identity: 'codex' })
  const first = await codex.reply('codex', { reply_to: longId, body: 'ok' })
  const replyId = first.id ?? first.delivered_to?.split(/[\\/]/).pop()?.replace(/\.json$/, '')
  assert.ok(replyId, '回执应返回 id')
  assert.ok(replyId.length <= 128, `回执 id 必须 ≤128，实际 ${replyId.length}`)
  assert.match(replyId, /\.result$/)
  assert.match(replyId, /-[0-9a-f]{8}\.result$/, '超长时应带确定性短哈希')

  // 重试同一封回执：id 必须一致（幂等），不能变成"同信两回执"
  const retry = await codex.reply('codex', { reply_to: longId, body: 'ok' })
  const retryId = retry.id ?? retry.delivered_to?.split(/[\\/]/).pop()?.replace(/\.json$/, '')
  assert.equal(retryId, replyId)
  assert.equal(mail.inbox('dsh').filter(x => x.type === 'result').length, 1)
  removeTreeSync(root)
})

