/**
 * 轮换核心测试用的假宿主（落盘版）：会话表、建会话调用、投递记录都写在信箱根下的一个 JSON 文件里。
 * 落盘是为了让「崩溃的子进程」和「恢复它的父进程」看到**同一个宿主**——
 * 例如「宿主已建好候选会话、回包没记进日志」这个崩溃点，父进程恢复时必须能在宿主里查到它，
 * 才能证明恢复不会建出第二个会话。
 *
 * 行为开关 behavior（测试可随时改同一个对象）：
 *   create  'ok' | 'fail'（宿主明确说没建）| 'throw'（没建、回包也丢了）| 'throw-after'（建了、回包丢了）
 *   lookup  'ok' | 'throw'
 *   verify  'ok' | 'wrong-identity' | 'wrong-digest' | 'no-tools' | 'throw'
 *   retire  'ok' | 'throw'
 *   submit  'accept' | 'reject'（宿主明确没收）| 'throw'（收了、回包丢了 —— 对「至多一次」最不利的情形）
 *   lookupAuthoritative  默认 true；false = 宿主「查不到」不能证明「确实没建」
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function createFakeHost({ root, behavior = {} } = {}) {
  const file = path.join(root, 'fake-host.json');
  const load = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { sessions: {}, created: [], submits: [] }; throw error; }
  };
  const save = data => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2)); fs.renameSync(`${file}.tmp`, file); };
  const mode = name => behavior[name] ?? 'ok';
  return {
    behavior,
    capabilities: { get lookupAuthoritative() { return behavior.lookupAuthoritative !== false; } },
    state: load,
    seed(id, details) { const data = load(); data.sessions[id] = { ...details, retired: false }; save(data); },
    async createSession({ id, identity, generation, handoff }) {
      if (mode('create') === 'fail') return { created: false, definitive: true, reason: 'host refused' };
      if (mode('create') === 'throw') throw new Error('host timed out before creating the session');
      const data = load();
      if (!Object.hasOwn(data.sessions, id)) data.sessions[id] = { identity, generation, handoff, retired: false };
      data.created.push(id);
      save(data);
      if (mode('create') === 'throw-after') throw new Error('host created the session but the reply was lost');
      return { created: true, session: { host: 'fake', id } };
    },
    async findSession(id) {
      if (mode('lookup') === 'throw') throw new Error('host lookup unavailable');
      return { exists: Object.hasOwn(load().sessions, id) };
    },
    async verifySession(id) {
      if (mode('verify') === 'throw') throw new Error('host verification unavailable');
      const sessions = load().sessions;
      if (!Object.hasOwn(sessions, id)) return {};
      const session = sessions[id];
      // 新会话首个回合「读交接文件并回出摘要」：按文件此刻的字节计算。
      let digest = null;
      try { digest = createHash('sha256').update(fs.readFileSync(path.join(root, session.handoff.file))).digest('hex'); } catch {}
      return {
        identity: mode('verify') === 'wrong-identity' ? 'someone-else' : session.identity,
        generation: session.generation,
        handoffDigest: mode('verify') === 'wrong-digest' ? 'f'.repeat(64) : digest,
        tools: mode('verify') !== 'no-tools',
        crossIdentityRejected: true,
      };
    },
    async retireSession(id) {
      if (mode('retire') === 'throw') throw new Error('host retire unavailable');
      const data = load();
      if (Object.hasOwn(data.sessions, id)) data.sessions[id].retired = true;
      save(data);
    },
    async submit({ session, letter, key }) {
      const outcome = behavior.submit ?? 'accept';
      const data = load();
      data.submits.push({ session: session.id, letter: letter.id, key, outcome });
      save(data);
      if (outcome === 'reject') return { accepted: false, definitive: true };
      if (outcome === 'throw') throw new Error('host accepted the letter but the receipt was lost');
      return { accepted: true, receipt: `receipt-${data.submits.length}` };
    },
  };
}
