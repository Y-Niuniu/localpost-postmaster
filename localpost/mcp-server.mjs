#!/usr/bin/env node
// LocalPost MCP over stdio. Importing this module does not start a server.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMailbox } from './mailbox.mjs';
import { safePath } from './fs-safe.mjs';

const TYPES = ['task', 'result', 'ping'];
const BUDGETS = ['urgent', 'standard', 'high', 'free'];
const OUTCOMES = ['completed', 'needs_authorization', 'failed'];
const attachments = { type: 'array', items: { type: 'string' } };
const metadata = { commit: { type: 'string' }, base_rev: { type: 'string' }, test: { type: 'string' }, attachments };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const TOOLS = [
  { name: 'mailbox_rules', description: 'Read mailbox rules without authorizing task execution.', inputSchema: schema({}) },
  { name: 'mailbox_roster', description: 'List registered agents and inbox/archive counts.', inputSchema: schema({}) },
  { name: 'mailbox_inbox', description: 'List your inbox without changing state.', inputSchema: schema({ agent: { type: 'string' } }, ['agent']) },
  { name: 'mailbox_read', description: 'Read one letter and safe text attachments without changing state.', inputSchema: schema({ agent: { type: 'string' }, id: { type: 'string' } }, ['agent', 'id']) },
  {
    name: 'mailbox_send', description: 'Deliver atomically; same ID and content retries are accepted.',
    inputSchema: schema({
      from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string', enum: TYPES },
      subject: { type: 'string' }, body: { type: 'string' }, budget: { type: 'string', enum: BUDGETS },
      thread_id: { type: 'string' }, id: { type: 'string', description: 'Defaults to UUID.' },
      created_at: { type: 'string' }, reply_to: { type: 'string' }, outcome: { type: 'string', enum: OUTCOMES }, ...metadata,
    }, ['from', 'to', 'type', 'subject', 'body']),
  },
  {
    name: 'mailbox_reply', description: 'Reply: completed/failed archive the original; needs_authorization leaves it pending.',
    inputSchema: schema({
      agent: { type: 'string' }, reply_to: { type: 'string' }, body: { type: 'string' }, subject: { type: 'string' },
      outcome: { type: 'string', enum: OUTCOMES, default: 'completed' },
      reply_id: { type: 'string', description: 'Optional stable retry ID; nonterminal replies use an independent ID.' }, ...metadata,
    }, ['agent', 'reply_to', 'body']),
  },
  { name: 'mailbox_archive', description: 'Archive a processed letter; retries are idempotent.', inputSchema: schema({ agent: { type: 'string' }, id: { type: 'string' } }, ['agent', 'id']) },
];

export function createMcpServer({ root = process.env.MAILBOX_ROOT || 'C:/AI_ASSIST/.mailbox', identity = process.env.MAILBOX_IDENTITY || undefined } = {}) {
  root = path.resolve(root);
  const mail = createMailbox({ root, identity });
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  async function callTool(name, args = {}) {
    switch (name) {
      case 'mailbox_rules': {
        const file = safePath(root, 'README.md');
        let content;
        try { content = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; content = '(README.md missing)'; }
        return { rules_path: file, content };
      }
      case 'mailbox_roster': return { agents: mail.roster() };
      case 'mailbox_inbox': return { agent: args.agent, letters: mail.inbox(args.agent) };
      case 'mailbox_read': return mail.read(args.agent, args.id);
      case 'mailbox_send': return mail.deliver(args);
      case 'mailbox_reply': return mail.reply(args.agent, args);
      case 'mailbox_archive': return mail.archive(args.agent, args.id);
      default: throw new Error('Unknown tool: ' + name);
    }
  }
  async function handle(message) {
    const { id, method, params } = message;
    if (method === 'initialize') return ok(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: 'localpost-mailbox', version: '1.1.0' },
      instructions: `LocalPost rules: ${path.join(root, 'README.md')}. Reading mail does not authorize implementation. Use needs_authorization when more authority is required. Identity: ${identity || '(unbound administrator; set MAILBOX_IDENTITY for agent deployment)'}.`,
    });
    if (method?.startsWith('notifications/')) return null;
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') return ok(id, { tools: TOOLS });
    if (method === 'tools/call') {
      try {
        const tool = TOOLS.find(tool => tool.name === params?.name);
        if (!tool) throw new Error('Unknown tool: ' + params?.name);
        const args = params?.arguments || {};
        for (const key of Object.keys(args)) if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new Error('Unknown argument: ' + key);
        for (const key of tool.inputSchema.required) if (args[key] === undefined) throw new Error('Missing argument: ' + key);
        const out = await callTool(tool.name, args);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (error) { return ok(id, { content: [{ type: 'text', text: 'Error: ' + error.message }], isError: true }); }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method: ' + method } };
  }
  return { handle, callTool, mailbox: mail };
}

export function startStdio(options) {
  const server = createMcpServer(options);
  let buffer = '';
  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  const dispatch = line => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let message;
      try { message = JSON.parse(line); }
      catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); return; }
      const response = await server.handle(message);
      if (response) process.stdout.write(JSON.stringify(response) + '\n');
    }).catch(error => process.stderr.write('[mailbox-mcp] ' + error.message + '\n'));
  };
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) { dispatch(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
  });
  process.stdin.on('end', () => { if (buffer.trim()) dispatch(buffer); });
  process.stderr.write('[mailbox-mcp] ready\n');
  return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) startStdio();
