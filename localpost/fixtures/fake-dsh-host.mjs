/**
 * 自动派发 T1 契约测试用的假 DSH 宿主（落盘版：崩溃的子进程和恢复它的父进程看到同一个宿主）。
 *
 * 它模拟三件**真实 DSH rc.2 都没有**的宿主能力 —— 这个文件只用于测试契约，绝不随产品发布，
 * 也不能拿来证明真实宿主已经具备这些能力：
 *   confirmBindAction(action)   用户在聊天 A 里执行「绑定为 LocalPost 收信聊天」后，宿主确认这个动作
 *   describeThread(threadId)    宿主此刻看到的聊天：所在宿主、工作目录、是否在线
 *   ctx.agents.get(id).followup 只给在线聊天提供；投递记录落盘，测试据此数唤醒次数
 */
import fs from 'node:fs';
import path from 'node:path';

export function createFakeDshHost({ root, hostId = 'local', capabilities = { chatBinding: true } } = {}) {
  const file = path.join(root, 'fake-dsh-host.json');
  const load = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { threads: {}, actions: {}, followups: [] }; throw error; }
  };
  const save = data => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2)); fs.renameSync(`${file}.tmp`, file); };
  const change = mutate => { const data = load(); mutate(data); save(data); };
  return {
    hostId, capabilities, state: load,
    openThread(threadId, cwd) { change(data => { data.threads[threadId] = { cwd, online: true }; }); },
    setOnline(threadId, online) { change(data => { data.threads[threadId].online = online; }); },
    // 'lost'：followup 送达了（记录在案），但回包丢了 —— 对「至多一次」最不利的情形。
    breakFollowups(mode) { change(data => { data.followupFault = mode; }); },
    // 用户在聊天里点了「绑定」：宿主记下这个动作，并把它交给 LocalPost 去确认。
    userBindAction(threadId) {
      const data = load();
      const actionId = `action-${Object.keys(data.actions).length + 1}`;
      data.actions[actionId] = { threadId, cwd: data.threads[threadId].cwd };
      save(data);
      return { actionId, hostId, threadId, cwd: data.threads[threadId].cwd };
    },
    async confirmBindAction(action) {
      const recorded = load().actions[action?.actionId];
      if (!recorded) return { confirmed: false };
      return { confirmed: true, actionId: action.actionId, hostId, threadId: recorded.threadId, cwd: recorded.cwd };
    },
    async describeThread(threadId) {
      const thread = load().threads[threadId];
      return thread ? { hostId, threadId, cwd: thread.cwd, online: thread.online } : { hostId, threadId, online: false };
    },
    ctx: {
      agents: {
        get(threadId) {
          const thread = load().threads[threadId];
          if (!thread?.online) return undefined;
          return {
            async followup(message) {
              change(data => { data.followups.push({ threadId, id: message.id, role: message.role, source: message.source, text: message.content[0].text }); });
              if (load().followupFault === 'lost') throw new Error('connection lost after the followup was queued');
            },
          };
        },
      },
    },
    followups: () => load().followups,
  };
}
