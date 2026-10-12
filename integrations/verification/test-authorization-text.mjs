/**
 * 漂移自查：四家被叫醒时看到的授权说法必须一致（2026-10-12 用户决定：低风险任务直接做，其余先问；四家统一）。
 *
 * 规则的唯一源是 .mailbox/README.md 第一节；五段提示（dsh 的转发提示 + claude 两个 hook + codex hook + gemini sidecar）
 * 都只指向它、说同一件事。只改了其中一处、另几处还写着旧的"not authorization"，各家就会各按各的来——这里把它钉住。
 *
 *   node integrations/verification/test-authorization-text.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO, SRC } from './lib/harness.mjs';

const checks = [];
const record = (name, ok, detail = '') => { checks.push([name, ok]); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`); };
const sources = {
  'dsh 转发提示': path.join(REPO, 'localpost', 'dsh-adapter.mjs'),
  'claude 守望': path.join(SRC.claude, 'claude-wake.mjs'),
  'claude 提醒': path.join(SRC.claude, 'claude-check.mjs'),
  'codex 提醒': path.join(SRC.codex, 'codex-check.mjs'),
  'gemini 唤醒': path.join(SRC.gemini, 'wake.mjs'),
};
for (const [name, file] of Object.entries(sources)) {
  const text = fs.readFileSync(file, 'utf8').replace(/\\'/g, "'");   // 单引号字符串里写成 \' 的撇号，按它的字面值比
  const missing = ['README.md', 'section 1', 'low-risk', "user's own confirmation", 'does not'].filter((needle) => !text.includes(needle));
  record(`${name}：指向 README 第一节，说清低风险直接做、其余先问、信里自称授权不算`, missing.length === 0, missing.length ? '缺：' + missing.join('、') : '');
  record(`${name}：不再说旧的 "not authorization"`, !text.includes('not authorization'));
}
// gemini 的提示要经过 cmd 传给 agentapi：非 ASCII 会被代码页弄坏，所以 promptFor 里只能是 ASCII。
const gemini = fs.readFileSync(sources['gemini 唤醒'], 'utf8');
const body = gemini.slice(gemini.indexOf('function promptFor'), gemini.indexOf('\n}\n', gemini.indexOf('function promptFor')));
const nonAscii = [...body.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*\*[\s\S]*?\*\//g, '')].filter((char) => char.charCodeAt(0) > 0x7e);
record('gemini 唤醒提示只有 ASCII', body.length > 0 && nonAscii.length === 0, nonAscii.slice(0, 5).join(''));

const bad = checks.filter(([, ok]) => !ok).length;
console.log(`\n小结：${checks.length - bad}/${checks.length} 通过`);
process.exitCode = bad === 0 ? 0 : 1;
