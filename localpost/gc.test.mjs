import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { runGc } from './gc.mjs'

const now = Date.parse('2026-10-01T12:00:00Z')
const old = new Date(now - 40 * 86400000)
const envelope = (id, over = {}) => ({ id, thread_id: 'thread-1', from: 'a', to: 'b', type: 'task',
  subject: 'test', body: 'test', budget: 'standard', created_at: old.toISOString(), ...over })
async function fixture() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'localpost-gc-'))
}
async function put(root, relative, content) {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
  await fs.utimes(file, old, old)
  return file
}
async function exists(file) { try { await fs.access(file); return true } catch { return false } }

test('GC 只删除超保留期且有匹配终态的归档，未完成信和附件保留', async () => {
  const root = await fixture()
  const unread = await put(root, 'agents/b/inbox/unread.json', envelope('unread', { attachments: ['needed.txt'] }))
  const outbox = await put(root, 'agents/a/outbox/out.json', envelope('out'))
  const pending = await put(root, 'agents/b/archive/pending.json', envelope('pending'))
  const done = await put(root, 'agents/b/archive/done.json', envelope('done'))
  const result = await put(root, 'agents/a/archive/done.result.json', envelope('done.result',
    { type: 'result', reply_to: 'done', from: 'b', to: 'a', outcome: 'completed' }))
  const needed = await put(root, 'attachments/needed.txt', 'needed')
  const orphan = await put(root, 'attachments/orphan.txt', 'orphan')
  const r = await runGc({ root, now, days: 30, dryRun: false })
  assert.equal(r.errors.length, 0)
  assert.equal(await exists(done), false)
  assert.equal(await exists(result), false)
  assert.equal(await exists(orphan), false)
  for (const file of [unread, outbox, pending, needed]) assert.equal(await exists(file), true)
})

test('dry-run 完全不写文件，也不创建不存在的根目录', async () => {
  const root = await fixture()
  const orphan = await put(root, 'attachments/orphan.txt', 'orphan')
  const before = await fs.readdir(root, { recursive: true })
  const r = await runGc({ root, now })
  assert.deepEqual(r.deleted, [])
  assert.ok(r.candidates.includes('attachments/orphan.txt'))
  assert.deepEqual(await fs.readdir(root, { recursive: true }), before)
  assert.equal(await fs.readFile(orphan, 'utf8'), 'orphan')
  const missing = path.join(root, 'not-created')
  await runGc({ root: missing, now })
  assert.equal(await exists(missing), false)
})

test('等待授权与未知信封保留；无法知道附件引用时不删除孤儿附件', async () => {
  const root = await fixture()
  const task = await put(root, 'agents/b/archive/pending.json', envelope('pending'))
  const reply = await put(root, 'agents/a/archive/pending.waiting.json', envelope('pending.waiting',
    { type: 'result', reply_to: 'pending', from: 'b', to: 'a', outcome: 'needs_authorization' }))
  const unknown = await put(root, 'agents/b/inbox/broken.json', '{broken')
  const orphan = await put(root, 'attachments/maybe-needed.txt', 'data')
  const r = await runGc({ root, now, dryRun: false })
  assert.ok(r.errors.length > 0)
  for (const file of [task, reply, unknown, orphan]) assert.equal(await exists(file), true)
})

test('保留期从终态完成时间算，旧任务最近才完成不可立即删除', async () => {
  const root = await fixture()
  const task = await put(root, 'agents/b/archive/done.json', envelope('done'))
  const result = await put(root, 'agents/a/archive/done.result.json', envelope('done.result',
    { type: 'result', reply_to: 'done', from: 'b', to: 'a', created_at: new Date(now).toISOString() }))
  const r = await runGc({ root, now, dryRun: false })
  assert.deepEqual(r.deleted, [])
  assert.equal(await exists(task), true)
  assert.equal(await exists(result), true)
})

test('附件引用按实际安全路径比较，./ 与 Windows 大小写不能使在用附件被删除', async () => {
  const root = await fixture()
  const spelling = process.platform === 'win32' ? './NEEDED.TXT' : './needed.txt'
  await put(root, 'agents/b/inbox/pending.json', envelope('pending', { attachments: [spelling] }))
  const needed = await put(root, 'attachments/needed.txt', 'needed')
  const r = await runGc({ root, now, dryRun: false })
  assert.equal(r.errors.length, 0)
  assert.equal(await exists(needed), true)
})

test('PowerShell wrapper 的 WhatIf 只预览且不写 GC 日志', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture()
  const orphan = await put(root, 'attachments/orphan.txt', 'orphan')
  const before = await fs.readdir(root, { recursive: true })
  const script = fileURLToPath(new URL('./localpost-gc.ps1', import.meta.url))
  const { stdout } = await promisify(execFile)(process.env.LOCALPOST_PWSH || 'pwsh.exe',
    ['-NoProfile', '-File', script, '-Root', root, '-WhatIf'])
  assert.equal(JSON.parse(stdout).dryRun, true)
  assert.deepEqual(await fs.readdir(root, { recursive: true }), before)
  assert.equal(await exists(orphan), true)
})

test('dry-run 列出归档删除后才成为孤儿的附件，与实际清理计划一致', async () => {
  const root = await fixture()
  await put(root, 'agents/b/archive/done.json', envelope('done', { attachments: ['done.txt'] }))
  await put(root, 'agents/a/archive/done.result.json', envelope('done.result',
    { type: 'result', reply_to: 'done', from: 'b', to: 'a' }))
  const attachment = await put(root, 'attachments/done.txt', 'done')
  const preview = await runGc({ root, now })
  assert.ok(preview.candidates.includes('attachments/done.txt'))
  assert.equal(await exists(attachment), true)
})
