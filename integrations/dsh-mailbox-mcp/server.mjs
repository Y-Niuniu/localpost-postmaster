#!/usr/bin/env node
// LocalPost 邮局 MCP Server —— 让任何支持 MCP 的 agent（Antigravity / VS Code 系 / Claude Desktop…）
// 直接收发信件，不需要知道文件路径。
//
// 协议：MCP over stdio，newline-delimited JSON-RPC 2.0（零依赖）
// 规矩唯一源：C:/AI_ASSIST/.mailbox/README.md（本服务器只实现内核语义：信封校验 + 投递 + 归档）
//
// 用法（在 mcp_config.json 里）：
//   "postmaster": { "command": "node", "args": ["C:/AI_ASSIST/tools/dsh-mailbox-mcp/server.mjs"] }

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.MAILBOX_ROOT || 'C:/AI_ASSIST/.mailbox';
const AGENTS_DIR = path.join(ROOT, 'agents');
const ATTACH_DIR = path.join(ROOT, 'attachments');
const PROTOCOL_FALLBACK = '2024-11-05';
// 共享受控 API（内核同名模块）：投递必须走它，才会写 runtime/arrivals 到达记录 + 拿写锁。
// 2026-10-05 前的实现是直接 fs.writeFileSync 写 inbox —— 那样投出的信没有到达记录，
// 生产 receiver 只能判 manual/no_arrival_record ⇒ 永远不唤醒收件聊天。此改动即修这一条。
const SHARED_API = process.env.LOCALPOST_MAILBOX_API || path.join(ROOT, 'mailbox.mjs');
let sharedApiPromise = null;
function sharedApi() {
  if (sharedApiPromise === null) sharedApiPromise = import(pathToFileURL(SHARED_API).href);
  return sharedApiPromise;
}

const REQUIRED = ['id', 'thread_id', 'from', 'to', 'type', 'subject', 'body', 'budget', 'created_at'];
const TYPES = ['task', 'result', 'ping'];
const BUDGETS = ['urgent', 'standard', 'high', 'free'];
const BODY_SOFT_LIMIT = 200;

const log = (...a) => process.stderr.write('[mailbox-mcp] ' + a.join(' ') + '\n');
const nowIso = () => new Date().toISOString();

function agentDir(agent) {
  const safe = String(agent || '').trim();
  if (!/^[a-z0-9_-]{1,32}$/i.test(safe)) throw new Error(`非法 agent 名: ${agent}`);
  return path.join(AGENTS_DIR, safe);
}
function inbox(agent) { return path.join(agentDir(agent), 'inbox'); }
function archiveDir(agent) { return path.join(agentDir(agent), 'archive'); }
function ensureAgent(agent) {
  for (const d of ['inbox', 'outbox', 'archive']) fs.mkdirSync(path.join(agentDir(agent), d), { recursive: true });
}

/**
 * 身份绑定（2026-10-05 修 codex 评审 P1-1 的第二半；2026-10-06 补 GPT 复审的身份项）。
 * 旧实现完全采用工具参数里的 agent/env.from ⇒ 任何会话都能以别的身份读信/回执。
 * 现在：
 *   - 绑定来源 = `LOCALPOST_IDENTITY` 或 `MAILBOX_IDENTITY`（**两个名字都认**，兼容共享入口的约定）；
 *   - 绑定后该进程**只能用这一个身份**，参数里给别的身份直接报错；
 *   - 未绑定 = 兼容模式（agent 参数即身份），但**会往 stderr 打警告**；
 *     要 fail-closed 就在 MCP 配置里额外设 `LOCALPOST_REQUIRE_IDENTITY=1`（未绑定则拒绝启动）。
 * 注意：默认不 fail-closed 是刻意的取舍 —— 若宿主没把 env 传进来，fail-closed 会让整个邮局 MCP 不可用
 * （GPT 复审也指出"尚未证明常驻进程重启加载"）。严格模式留给确认 env 生效之后再开。
 * MCP 配置示例："env": { "MAILBOX_ROOT": "C:/AI_ASSIST/.mailbox", "LOCALPOST_IDENTITY": "gemini" }
 */
const BOUND_IDENTITY = (process.env.LOCALPOST_IDENTITY || process.env.MAILBOX_IDENTITY || '').trim() || null;
const REQUIRE_IDENTITY = /^(1|true|yes)$/i.test(process.env.LOCALPOST_REQUIRE_IDENTITY || '');
if (!BOUND_IDENTITY) {
  const msg = '未绑定身份（LOCALPOST_IDENTITY / MAILBOX_IDENTITY 均未设置）—— 兼容模式：agent 参数即身份；'
    + '要 fail-closed 请设 LOCALPOST_REQUIRE_IDENTITY=1';
  if (REQUIRE_IDENTITY) { process.stderr.write('[mailbox-mcp] fatal: ' + msg + '\n'); process.exit(2); }
  process.stderr.write('[mailbox-mcp] warn: ' + msg + '\n');
}
function identityFor(agent) {
  const a = String(agent ?? '').trim();
  if (BOUND_IDENTITY) {
    if (a && a !== BOUND_IDENTITY) throw new Error(`身份绑定：本进程只允许身份 ${BOUND_IDENTITY}（收到 ${a}）。请去掉 agent 参数或改用正确身份。`);
    return BOUND_IDENTITY;
  }
  return a;
}

function validateEnvelope(env) {
  const missing = REQUIRED.filter(k => env[k] === undefined || env[k] === null || String(env[k]).trim() === '');
  if (missing.length) throw new Error(`信封缺必填字段: ${missing.join(', ')}`);
  if (!TYPES.includes(env.type)) throw new Error(`type 必须是 ${TYPES.join('|')}`);
  if (!BUDGETS.includes(env.budget)) throw new Error(`budget 必须是 ${BUDGETS.join('|')}`);
  return true;
}

async function deliver(env) {
  validateEnvelope(env);
  // 身份检查放在任何文件操作之前（fix P1-4 附带项：旧实现先 ensureAgent(to) 建目录，
  // 越权请求也会先在内核外产生目录写入）。
  const identity = identityFor(env.from);
  const warnings = [];
  if (String(env.body).length > BODY_SOFT_LIMIT) warnings.push(`body ${String(env.body).length} 字，超过软上限 ${BODY_SOFT_LIMIT}（大内容请走 attachments）`);
  for (const a of (env.attachments || [])) {
    if (!fs.existsSync(path.join(ATTACH_DIR, a))) warnings.push(`附件不存在: ${a}`);
  }
  // 走共享受控 API：拿写锁 + 建目录 + 按收件人绑定写 runtime/arrivals 到达记录（自动唤醒的前提）。
  const { createMailbox } = await sharedApi();
  const box = createMailbox({ root: ROOT, identity });
  const result = await box.deliver(env);
  return {
    delivered_to: result.delivered_to,
    warnings: [...warnings, ...(result.warnings || [])],
    ...(result.idempotent ? { idempotent: true } : {}),
    arrival_recorded: true,
  };
}

/** 列表也走共享内核：不再自己拼路径（内核 inbox() 用 safePath 校验 + 只列该身份的目录）。 */
async function listInbox(agent) {
  const identity = identityFor(agent);
  const { createMailbox } = await sharedApi();
  const box = createMailbox({ root: ROOT, identity });
  return (box.inbox(identity) || []).map((j) => ({
    file: j.file, id: j.id, thread_id: j.thread_id, from: j.from, type: j.type,
    subject: j.subject, budget: j.budget, created_at: j.created_at,
    body: String(j.body || '').slice(0, 300),
    attachments: j.attachments || [],
    ...(j.error ? { error: j.error } : {}),
  }));
}

/**
 * 读信走共享内核 + 先按内核同一规则校验 id。
 * fix P1-4：旧实现把 id 直接拼进路径 ⇒ `../../dsh/inbox/victim` 可以穿越出自己身份的信箱，
 * 身份绑定形同虚设。内核 assertId 为 /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/（不允许分隔符），
 * 且 box.read 内部还有 safePath 兜底；附件解析也改用内核的 attachments_resolved。
 */
function assertSafeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) {
    throw new Error(`非法信件 id（只允许字母数字与 . _ -，须以字母数字开头）: ${String(id).slice(0, 60)}`);
  }
  return id;
}

async function readLetter(agent, id) {
  const identity = identityFor(agent);
  assertSafeId(id);
  const { createMailbox } = await sharedApi();
  const box = createMailbox({ root: ROOT, identity });
  const out = box.read(identity, id);
  if (!out || !out.envelope) throw new Error(`找不到信: ${id}`);
  return { envelope: out.envelope, attachments_resolved: out.attachments_resolved };
}

/**
 * 回执 / 归档统一走共享受控 API（2026-10-05 修 codex 评审 P1-1）。
 * 旧实现手拼 `<id>.result` 信封再 renameSync 归档：没有 outcome 语义（发不出 needs_authorization
 * 的"等待授权"回执，缺 outcome 会被内核按历史兼容算终态）、没有 reply_id/base_rev 契约、
 * 归档与投递不在同一把写锁里，且重试会因 created_at 变化产生同 ID 不同内容冲突。
 * 现在内核负责：非终态回执自动取独立 reply_id（<id>.result.<uuid>）、终态回执发布后原子归档、
 * 归档失败显式报 REPLIED_ARCHIVE_PENDING（不会被糊成"回复失败"）。
 */
async function replyTo(agent, reply) {
  const identity = identityFor(agent);
  const { createMailbox } = await sharedApi();
  const box = createMailbox({ root: ROOT, identity });
  const input = { reply_to: reply.reply_to, body: reply.body };
  // 留成可选，避免"显式 undefined"污染内核的信封校验
  for (const k of ['outcome', 'reply_id', 'subject', 'commit', 'base_rev', 'test', 'attachments']) {
    if (reply[k] !== undefined) input[k] = reply[k];
  }
  const out = await box.reply(identity, input);
  return { ...out, via: 'shared-kernel' };
}

async function archiveLetter(agent, id) {
  const identity = identityFor(agent);
  const { createMailbox } = await sharedApi();
  const box = createMailbox({ root: ROOT, identity });
  const out = await box.archive(identity, id);
  return { ...out, via: 'shared-kernel' };
}

function roster() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR).filter(n => fs.statSync(path.join(AGENTS_DIR, n)).isDirectory()).map(n => ({
    agent: n,
    inbox: fs.existsSync(inbox(n)) ? fs.readdirSync(inbox(n)).filter(f => f.endsWith('.json')).length : 0,
    archive: fs.existsSync(archiveDir(n)) ? fs.readdirSync(archiveDir(n)).filter(f => f.endsWith('.json')).length : 0,
  }));
}

// ---------------- MCP ----------------
const TOOLS = [
  {
    name: 'mailbox_rules',
    description: '返回邮局操作规矩的唯一源路径与要点。任何邮局操作前应先读它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mailbox_roster',
    description: '列出邮局里已注册的 agent 及各自 inbox/archive 的未处理数量。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mailbox_inbox',
    description: '查看某个 agent 的收件箱（不改变任何状态）。',
    inputSchema: { type: 'object', properties: { agent: { type: 'string', description: '你的 agent 名（= 信箱目录名）' } }, required: ['agent'], additionalProperties: false },
  },
  {
    name: 'mailbox_read',
    description: '读一封信的完整内容，含附件（文本附件内联，二进制只给路径）。',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, id: { type: 'string' } }, required: ['agent', 'id'], additionalProperties: false },
  },
  {
    name: 'mailbox_send',
    description: '投递一封新信。信封必须含 9 个必填字段；正文软上限 200 字，大内容走 attachments。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' },
        type: { type: 'string', enum: TYPES },
        subject: { type: 'string' }, body: { type: 'string' },
        budget: { type: 'string', enum: BUDGETS, description: '默认 standard' },
        thread_id: { type: 'string', description: '不填则用 id' },
        id: { type: 'string', description: '不填则自动生成 <from>-<日期>-<序号>' },
        attachments: { type: 'array', items: { type: 'string' }, description: '.mailbox/attachments/ 下的相对文件名' },
      },
      required: ['from', 'to', 'type', 'subject', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'mailbox_reply',
    description: '回复一封信：自动生成 result 信封投回原发件人，并把原信移进自己的 archive/。'
      + 'outcome=completed（默认）表示处理完成；needs_authorization 表示"已读、需用户授权后才能执行"——'
      + '这种非终态回执**不会归档原信**（原信留在 inbox 等你获授权后继续），内核会自动给它一个独立 reply_id。',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: '你自己（收件方）；进程若设了 LOCALPOST_IDENTITY 可省略' },
        reply_to: { type: 'string', description: '原信 id' },
        body: { type: 'string', description: '结果，≤200 字' },
        outcome: { type: 'string', enum: ['completed', 'needs_authorization', 'failed'], description: '默认 completed' },
        reply_id: { type: 'string', description: '可选：显式指定回执 id（非终态回执必须与 <原信id>.result 不同）' },
        subject: { type: 'string' },
        commit: { type: 'string', description: '（代码任务）commit 号' },
        base_rev: { type: 'string', description: '（代码任务）基线版本' },
        test: { type: 'string', description: '（代码任务）验收命令 + 结果' },
        attachments: { type: 'array', items: { type: 'string' } },
      },
      required: ['reply_to', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'mailbox_archive',
    description: '把一封信从 inbox 移到自己的 archive/（已处理完但不需回执时用，如 ping）。',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, id: { type: 'string' } }, required: ['agent', 'id'], additionalProperties: false },
  },
];

function ok(id, result) { return { jsonrpc: '2.0', id, result }; }
function err(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function callTool(name, args = {}) {
  switch (name) {
    case 'mailbox_rules': {
      const p = path.join(ROOT, 'README.md');
      const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '(README.md 不存在)';
      return { rules_path: p.replace(/\//g, '\\'), content: text };
    }
    case 'mailbox_roster': return { agents: roster() };
    case 'mailbox_inbox': return { agent: args.agent, letters: await listInbox(args.agent) };
    case 'mailbox_read': return await readLetter(args.agent, args.id);
    case 'mailbox_send': {
      const seq = String(Date.now()).slice(-6);
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const id = args.id || `${args.from}-${stamp}-${seq}`;
      const env = {
        id, thread_id: args.thread_id || id, from: args.from, to: args.to, type: args.type,
        subject: args.subject, body: args.body, budget: args.budget || 'standard',
        created_at: nowIso(),
      };
      if (args.attachments) env.attachments = args.attachments;
      return await deliver(env);
    }
    case 'mailbox_reply': return await replyTo(args.agent, args);
    case 'mailbox_archive': return archiveLetter(args.agent, args.id);
    default: throw new Error(`未知工具: ${name}`);
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL_FALLBACK,
      capabilities: { tools: {} },
      serverInfo: { name: 'localpost-mailbox', version: '1.0.0' },
      instructions: `这是本地 LocalPost 邮局。规矩唯一源：${path.join(ROOT, 'README.md').replace(/\//g, '\\')}。
会话开始请：mailbox_inbox({agent:"<你的名字>"}) 查看来信；处理完用 mailbox_reply 回执（自动归档原信）；
task 必须在超时窗口内回执，否则邮局的局长进程会记账并告警。`,
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const out = await callTool(name, args);
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      // 结构化故障透传（2026-10-06 二轮校准，GPT 保留项 1）：
      // 真实内核 `mailbox.mjs` 的 REPLIED_ARCHIVE_PENDING 只带 **code / reply / pending / cause**，
      // 并不带 reply_delivered/archive_pending/retry_action。所以：
      //   ① 只原样透传内核真实存在的字段（不凭空造字段）；
      //   ② 需要稳定布尔语义时，由 **wrapper 明确转换**（下面这段），调用方不必去猜 code 字符串。
      const payload = { error: e.message };
      for (const k of ['code', 'reply', 'pending', 'retry_action', 'reply_delivered', 'archive_pending', 'cause']) {
        if (e[k] === undefined) continue;
        payload[k] = k === 'cause' ? String(e[k]?.message ?? e[k]) : e[k];
      }
      if (e.code === 'REPLIED_ARCHIVE_PENDING') {
        // 明确转换：内核语义"回执已投递、原信待归档" ⇒ 调用方可直接读的布尔字段 + 重试指引。
        payload.reply_delivered = true;
        payload.archive_pending = true;
        payload.retry_action = payload.retry_action ?? 'retry the identical mailbox_reply (same reply_to/reply_id/body) after access is fixed';
      }
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true });
    }
  }
  return err(id, -32601, `未实现的方法: ${method}`);
}

let buf = '';
let chain = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  // 投递改走异步受控 API（写到达记录），因此按收到顺序串行处理，避免并发写同一封信。
  chain = chain.then(async () => {
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { log('JSON 解析失败: ' + e.message); continue; }
      const res = await handle(msg);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    }
  }).catch(e => log('处理失败: ' + (e?.stack || e)));
});
// stdin 结束：必须等串行链收口再退出（旧实现直接 exit(0)，最后一条异步回复可能被腰斩）。
process.stdin.on('end', () => { chain.finally(() => process.exit(0)); });
process.on('uncaughtException', e => log('未捕获异常: ' + e.stack));
// 启动行带上身份状态：这样宿主（Antigravity 等）重启后，能从它的 MCP stderr 里**直接确认**
// "新代码已加载 + 身份 env 已生效"——GPT 二轮指出"重启后身份是否生效本轮未验证"，这条是留给它的验证入口。
log(`就绪 · mailbox=${ROOT} · 身份=${BOUND_IDENTITY ? '绑定 ' + BOUND_IDENTITY : '未绑定（兼容模式：agent 参数即身份；要 fail-closed 请设 LOCALPOST_REQUIRE_IDENTITY=1）'}`);
