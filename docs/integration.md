# Staged LocalPost integration

This branch is a delivery artifact, not a production deployment. dsh is the sole
main integrator. Keep the authoritative mailbox operations in
`C:/AI_ASSIST/.mailbox/README.md`; do not copy its rules into agent instructions.

## Files and migration

- `localpost/postmaster.mjs`: replacement kernel, alongside `fs-safe.mjs`.
- `localpost/gc.mjs` + `localpost-gc.ps1`: safe collector; preview by default;
  apply requires an explicit switch. Existing scheduled calls without that switch
  stop deleting. Use the tested bundled pwsh rather than changing machine policy.
- `localpost/mailbox.mjs` + `mcp-server.mjs`: common publisher and seven MCP tools.
  Set `MAILBOX_ROOT` and bind `MAILBOX_IDENTITY=codex` (or dsh per process).
  Unbound identity is administrator mode, unsuitable for auto-processing: the MCP
  server refuses to start unbound unless `MAILBOX_ADMIN=1` is set explicitly.
  If a terminal reply is published but archiving the original fails, the tool
  reports `REPLIED_ARCHIVE_PENDING` (已回执但待归档) instead of a plain failure;
  over MCP this is `isError` with a JSON body (`status: partial_failure`,
  `reply_delivered: true`, `archive_pending`, `retry_action: mailbox_reply`).
  Retry only the identical `mailbox_reply` (same `reply_to`, `reply_id` and content). For a letter in the claim
  ledger the reply's completion intent is immutable, so `mailbox_archive` or a different reply is refused with
  `COMPLETION_INTENT_CONFLICT`; invalid reply input fails before any intent is recorded.
  `MAILBOX_TOOLS` (comma list) restricts the tools a deployment exposes, enforced on
  call as well as in `tools/list`; unknown or empty lists refuse to start. Manual use
  keeps all seven; an automated reader should not get `mailbox_send`.
- `localpost/fs-safe.mjs` `atomicWrite`: a replacing rename that Windows refuses
  transiently (`EPERM`/`EACCES`/`EBUSY`) is retried a bounded number of times (~1.3 s),
  then fails loudly; callers still serialize writers per target with leases.
- `localpost/receiver.mjs` + `receiver-cli.mjs`: watch + 30-second repair scans and
  metadata-only durable queues in `runtime/queues`. Empty polling calls no model.
- `localpost/dsh-adapter.mjs`: injectable rc.2 contract, disabled without verified
  focus and durable idempotent acceptance. Fake tests are not live-host evidence.

Deploy the modules together, back up current production files first, preserve
private notification configuration, stop writers during migration, run isolated
tests, then run the new kernel in dry-run before replacing production. Existing
ledger replied statuses are intentionally monotonic: review/rebuild the ledger
from envelopes to eliminate historical false completions before auto enablement.
Update the unique README's nonterminal-result instructions in the same migration.

`node scripts/test.mjs` runs new module tests and the older 40-check plugin test.
All test temp directories are inside this worktree. No npm install is needed.

## Reception-only usage (explicit enablement)

```
node localpost/receiver-cli.mjs status --root C:/AI_ASSIST/.mailbox --agent codex
node localpost/receiver-cli.mjs receive --root C:/AI_ASSIST/.mailbox --agent codex --allow-from dsh --enable
```

The receive command above is a deployment instruction, not a command already run.
Its first initialization snapshots historical IDs under the common publish lock;
pre-existing letters are retained and skipped. New legacy direct-file messages
without a trusted publication-time focus are durable `unbound` entries, not routed
using scan-time focus. A trusted publisher supplies the route out of band; the
envelope cannot declare authority or a desktop destination.

Accepted runtime work stays submitted until a matching explicit result exists.
Uncertain dispatch is never blindly retried; a matching result may reconcile it.
Result messages cannot be replied to with another result. Analysis-only automatic
permission does not authorize code/file implementation.

## Remaining live-host prerequisites

Codex current visible chat and same-desktop control transport have NOT been
verified. DSH followup semantics are source-verified but not exercised live.
Neither focus nor cross-crash durable acceptance is supplied by this branch.
Do not enable dispatch by setting capability flags without implementing and
testing those boundaries. Do not silently substitute a fixed/recent chat.

Live acceptance must demonstrate A-to-B switching, next-whole-turn scheduling,
closed-client retention, duplicate hints, and lost acknowledgements in a harmless
test chat. Native daemon startup, cold resume, automation, and production model
calls are not part of this delivery.

Path checks catch ordinary traversal/junction escapes and receiver root changes;
they are not an OS-level defense against a malicious local process replacing
directories between validation and I/O. Trusted root ACLs remain necessary.
Malformed/abandoned recovery gates require explicit inspection, not blind removal.

## 修订后的集成顺序（2026-10-01，按 codex 审核意见调整）

先前把 A–E 并列其实不准确：**派发禁用**与**派发启用**是两条不同的门槛。
可靠性升级不需要等真机验收，而**启用自动派发**必须先过验收。

| 序 | 动作 | 前置 | 生产影响 | 现状 |
|---|---|---|---|---|
| A | 交付代码可接纳（`faed812` + 本轮修订） | 审计通过 | 无（仅分支） | 已审计通过；dsh 合并为集成库 main `19f447f`，2026-10-02 快进到规范库 |
| B | 协议更新：非终态回执不结束任务 / 读信不授予实施权限 | 草稿评审 | 无（草稿在仓库里） | 草稿见 `docs/protocol-needs-authorization-draft.md`，**未写入生产 README**。注意：2026-10-02 部署的新内核已经按草稿处理 `outcome`（`needs_authorization` 不结束任务），评审前不要用这个值 |
| C | 生产账本重建 | **先停所有写入口并等在途轮次结束**，再做不可覆盖快照并校验，保留六条历史记录摘要 | 写生产 `ledger.json` | **2026-10-02 已执行**，记录见 `docs/migration-ledger-rebuild.md` 第 0 节 |
| C+D | 账本迁移与内核部署**同批**执行（避免中间态） | 停写、备份、dry-run 一致 | 生产内核 | **2026-10-02 已同批执行** |
| D | 可靠性模块升级（watcher/队列/修复/锁/保留），**派发保持禁用** | 配套文件齐全、配置保留、可回滚 | 生产内核 | **2026-10-02 已部署**：内核与配套文件就位，GC 改为只预览；receiver / MCP server 未启动；派发仍禁用 |
| E | 真机验收：焦点绑定、整轮调度、关闭保留、重复事件、丢确认 | 隔离测试会话 | 无（只验收） | 清单见 `docs/live-acceptance.md`，**全部未运行** |
| 末 | **启用自动派发** | E 全部通过 | 会真实唤醒模型 | 未启用，适配器仍 disabled |

### D 的配套检查（升级时逐项核对）

- 随内核一起部署的配套文件：`fs-safe.mjs`、`mailbox.mjs`、`mcp-server.mjs`、`receiver.mjs` / `receiver-cli.mjs`、`gc.mjs` + `localpost-gc.ps1`（`gc.mjs` 的 `--apply` 语义与旧计划任务不同，见下）
- **配置保留**：`postmaster.config.json` 原样沿用（含私人 ntfy topic / toast 开关），新内核不得改动 notify 段
- **回滚**：迁移前快照（`migrate.mjs`）+ 内核文件备份；回滚 = 按 `migration-ledger-rebuild.md` 第 3 节停写
  （两个计划任务 + 退出 dsh + 暂停投信，并等在途轮次结束）→ 新内核文件仍在位时 `restore --apply`
  （其 `.postmaster.lock` 只对新内核有效，旧内核不认）→ 换回旧内核文件 → 恢复写入口，dsh 最后启动
  （插件在进程内缓存内核模块）；以 `migrate.mjs` 退出码判断成败（见 `migration-ledger-rebuild.md` 第 5 节）
- 旧计划任务若不带 `--apply`，升级后行为从「删除」变为「只预览」——这是**有意的安全变化**，需在迁移时一并确认计划任务参数
