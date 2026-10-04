/**
 * The negative gate of the mail-turn allowlist: names a model or a plugin could put in front of an automatic mail
 * turn. None of them is one of the five LocalPost mail tools, and none of them may reach a tool body.
 * Shared by localpost/mail-turn-allowlist.test.mjs and scripts/mail-turn-red-green.mjs, so the test and the red/green
 * evidence run judge one and the same list.
 */
export const LOOKALIKES = Object.freeze([
  'localpost_check', 'localpost_shell', 'localpost_delete_all', 'localpost_send_extra_ok_but_fake', 'localpost_send', 'localpost_',
  'localpost', 'localpostX', 'xlocalpost_read',
  'LOCALPOST_READ', 'Localpost_Read', 'localpost_READ', 'LocalPost_archive',
  'localpost_read_', 'localpost_readx', 'localpost_read2', 'localpost_inbox_all', 'localpost_reply.', 'localpost_archive-now',
  'localpost_read ', ' localpost_read', 'localpost_read\n', 'localpost_read\t', 'localpost_read\u0000', 'localpost_read​',
  '​localpost_read', 'ｌocalpost_read', 'localpost-read', 'localpost.read', 'localpost__read',
  'mcp__localpost__localpost_read', 'mcp__localpost__mailbox_reply', 'mcp__localpost__mailbox_archive',
  '',
]);
export const BUILTIN = Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'notebook_edit', 'pwsh', 'shell', 'bash', 'sh']);
export const MANAGEMENT = Object.freeze(['dev_plugin_status', 'dev_uninject_plugin', 'dev_reload_package', 'dev_injected_list',
  'dev_clear_routes', 'dev_inject_plugin', 'dev_fix_patch', 'dev_install_package']);
export const DELEGATION = Object.freeze(['subagent', 'subagent_fork', 'workflow', 'send_message', 'interrupt_agent', 'list_agents']);
export const PTC = Object.freeze(['run_code']);
export const MCP = Object.freeze(['mcp__linkdigest__digest_url', 'mcp_localpost_read']);
export const UNKNOWN = Object.freeze(['b_probe_nonexistent_tool', 'totally_made_up_tool_zzz']);
export const GATE = Object.freeze([...LOOKALIKES, ...BUILTIN, ...MANAGEMENT, ...DELEGATION, ...PTC, ...MCP, ...UNKNOWN]);
/** The names the review named explicitly (codex-claude-mail-guard-task-20261004.md, C1 item 2). */
export const REVIEW_NAMED = Object.freeze(['localpost_check', 'localpost_shell', 'localpost_delete_all', 'localpost_send_extra_ok_but_fake']);
