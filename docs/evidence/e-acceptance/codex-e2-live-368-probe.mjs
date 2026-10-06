import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMailbox } from '../../tools/dsh-localpost-postmaster/localpost/mailbox.mjs';

const root = 'C:/AI_ASSIST/work/localpost-e-test';
const repo = 'C:/AI_ASSIST/tools/dsh-localpost-postmaster';
const expectedHead = '3684e84e908801f3088ddaad37d3939b4eb3990e';
const expectedChat = 'session-16854214-d220-4ecc-8e57-65fa5df3fbcd';
const id = 'mcptest-e2-368-9bf8f0ac-5626-4c59-86cb-c6792a49e11a';
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== expectedHead || git('status', '--porcelain') !== '') throw new Error('Runtime baseline or worktree mismatch; nothing delivered');
if (fs.realpathSync(root).toLowerCase() !== path.resolve(root).toLowerCase()) throw new Error('Test root is not canonical');
if (!fs.lstatSync(path.join(root, '.e-acceptance')).isFile()) throw new Error('Missing acceptance marker');
const state = JSON.parse(fs.readFileSync(path.join(root, 'runtime/sessions/dsh.json'), 'utf8'));
if (state.binding?.session?.id !== expectedChat || state.binding?.session?.host !== 'local' || state.binding?.session?.cwd !== 'C:\\AI_ASSIST' || state.binding.mode !== 'auto' || state.binding.state !== 'active' || state.binding.authority?.scope !== 'analysis-reply') throw new Error('Binding mismatch; nothing delivered');
for (const agent of ['dsh', 'codex']) for (const bucket of ['inbox', 'outbox', 'archive']) {
  if (fs.existsSync(path.join(root, 'agents', agent, bucket, id + '.json'))) throw new Error('Probe already exists; do not redeliver');
}
if (fs.existsSync(path.join(root, 'runtime/arrivals/dsh', id + '.json')) || Object.hasOwn(state.claims ?? {}, id)) throw new Error('Probe has prior state; do not redeliver');
const envelope = {
  id, thread_id: id, from: 'codex', to: 'dsh', type: 'task',
  subject: '隔离 E2：3684e84 真实自动收信验收',
  body: '本信仅用于隔离收信验收。请通过当前聊天的原生 localpost_read/localpost_reply 阅读并回执“收到隔离 E2 测试信”，outcome=completed。不得改代码、生产配置或权限，不得读取生产信箱或自行重投。',
  budget: 'standard', created_at: new Date().toISOString(),
};
console.log('BASELINE=' + expectedHead);
console.log('BOUND_CHAT=' + expectedChat);
console.log('DELIVER=' + JSON.stringify(await createMailbox({ root, identity: 'codex' }).deliver(envelope)));
