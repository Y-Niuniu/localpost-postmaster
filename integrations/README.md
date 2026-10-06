# integrations —— 邮局外部集成（wrapper 与三个唤醒桥）的规范副本

> 这些文件的**生产位置在用户配置目录**（不在本仓库），所以它们的改动此前不随仓库形成可重放提交 ——
> codex/GPT 源码评审两次点名这个交付纪律缺口（"用户目录桥及非 Git wrapper 的此次修补仍未随规范仓库形成统一可重放提交"）。
> 本目录即为该缺口的补交：**仓库内保存逐字节副本 + 哈希 + 部署路径 + 回退方法**。
>
> ⚠️ 本目录是**副本**，不是运行位置；改动请改生产位置，再回抄到这里并更新下表哈希（或反过来：先改这里、再拷到生产位置 —— 两种都行，但必须保持两边一致）。

## 一、dsh-mailbox-mcp（旧 MCP wrapper = Antigravity 的实际入口）

| 仓库副本 | 生产位置 | 说明 |
|---|---|---|
| `dsh-mailbox-mcp/server.mjs` | `C:/AI_ASSIST/tools/dsh-mailbox-mcp/server.mjs`（**生产即该文件**，无拷贝步骤） | 零依赖 MCP over stdio；投递/回执/归档/读信**全部走共享内核**；身份绑定 `LOCALPOST_IDENTITY`/`MAILBOX_IDENTITY` + 可选 `LOCALPOST_REQUIRE_IDENTITY=1`（fail-closed）；错误回包含结构化字段并做明确转换 |
| `dsh-mailbox-mcp/SNAPSHOTS.md` | 同目录 | 改前快照来源/hash/复现/回退（诚实标注：`snapshots/` 里的 pre 件是**重建内容**，其哈希非历史哈希） |
| `dsh-mailbox-mcp/snapshots/server.mjs.pre-p1-1-20261005` | 同目录 | P1-1 之前的版本（重建件，296 行 / 13375 B） |

**现行哈希**（回抄时请同步更新）：

| 角色 | SHA256 | 大小 |
|---|---|---|
| 现行 wrapper（含二轮校准：wrapper 转换 + 启动行身份状态） | `82ECC3BF0CD1EC01D0FC11F0883F6D0F8EBC60A72CD21F40A1E710CAB7728F11` | 18608 B |
| 改前（P1-1 之前，重建件） | `B9BFE5F32F0DA1B23B9900852E85A606C2098BFD36C092050BC2C1CFA7E63903` | 13375 B |

## 二、bridges（三个"叫醒外部客户端"的桥）

| 桥 | 仓库副本 | 生产位置 | 唤醒机制 |
|---|---|---|---|
| **gemini / Antigravity** | `bridges/gemini/{wake.mjs,config.json,sidecar.json}` | `~/.gemini/config/sidecars/localpost-gemini-wake/`（宿主 `builtin: schedule`，每分钟一次） | `agentapi send-message <人工指定的会话id> <提示>`；状态语义：baseline/skip/sent/dryRun/failed/**indeterminate 挂起**/exhausted |
| **claude** | `bridges/claude/{claude-check.mjs,claude-wake.mjs,config.json}` | `~/.claude/localpost-wake/`；hooks 在 `~/.claude/settings.json` | `Stop`+`asyncRewake`（exit 2 唤醒）+ `UserPromptSubmit`（注入事实）+ 后台守望（`claude-wake.mjs`，原子排他锁、PID 存活优先、续租、失锁即停） |
| **codex** | `bridges/codex/{codex-check.mjs,config.json,codex-hook.cmd,hooks.json}` | `~/.codex/localpost-wake/`；hook 在 `~/.codex/hooks.json` | `Stop` hook → `{decision:'block',reason}` 让 codex 继续处理；`.cmd` 包装（**纯 ASCII**，先留 launched 痕迹再调绝对路径 node） |

**共同判据**（三个 check 脚本一致，对齐内核 `postmaster.mjs:235-249`）：
1. `task`/`ping`（`result` 永不提醒）；
2. 发件人在白名单；
3. **已有"有效"非终态回执** ⇒ 静默（`type==='result'` ∧ `reply_to` 匹配 ∧ `from===信.to` ∧ `to===信.from` ∧ 同 `thread_id` ∧ 所在信箱 owner===信.from ∧ 目录∈{inbox,archive}；**不按文件名匹配**，兼容自定义 `reply_id`）；终态回执优先；
4. 提醒上限后进入**冷却**（`reminderCooldownHours`，默认 6h）而非永久静默，状态留 `manualReview`/`heldSince`。

## 三、部署与回退

**部署**（生产位置）：
```powershell
# wrapper（生产即该文件，改完即生效；Antigravity 需重启才重新加载）
Copy-Item integrations\dsh-mailbox-mcp\server.mjs C:\AI_ASSIST\tools\dsh-mailbox-mcp\server.mjs -Force
# 三个桥（示例：codex）
Copy-Item integrations\bridges\codex\* "$env:USERPROFILE\.codex\localpost-wake\" -Force
Copy-Item integrations\bridges\codex\hooks.json "$env:USERPROFILE\.codex\hooks.json" -Force
```
**回退**：各生产位置均有 `.bak-*`（wrapper 见 `SNAPSHOTS.md`；桥见各目录 `.bak-20261005-*` / `.bak-20261006-*`）。

## 四、验证证据（**已入仓、可从仓库重跑**）

套件位于 `integrations/verification/`（含夹具助手 `lib/harness.mjs`），**被测源码取自本仓库**
（`integrations/bridges/*`、`integrations/dsh-mailbox-mcp/server.mjs`、`localpost/`），克隆仓库即可复现：

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `verification/test-gpt-review-fixes.mjs` | GPT 两轮 8 反例 + 结构化解包三条 + 身份 fail-closed | 21/21 |
| `verification/test-checkers-gates.mjs` | 两个 checker × 四道闸门 + 终态优先 + 冷却恢复 | 14/14 |
| `verification/test-gemini-wake-state.mjs` | 状态机 + **调用次数断言**（成功恰好 1 次 / 上限 3 次 / 其余 0 次） | 9/9 |
| `verification/test-claude-wake-lock.mjs` | 活守望不接管、死持有者接管、退出不删他人锁 | 3/3 |
| `verification/test-mailbox-mcp-reply.mjs` | 回执收敛内核 + 身份 + stdin 收口 + 非法 outcome | 9/9 |
| `verification/test-codex-check.mjs` | codex checker 基础判据 | 4/4 |
| `verification/smoke-mcp-production.mjs` | 生产信箱**只读**冒烟（**需 `LOCALPOST_SMOKE_PRODUCTION=1` 显式开启**） | 5/5 |

合计 **60/60**（不含生产 smoke）/ **65/65**（含）；内核本体另见 `node scripts/test.mjs`（383/383 + legacy 45/45）。

**隔离模型（2026-10-06 GPT 复审后加固）**：所有套件用 `lib/harness.mjs` 的 `isolatedEnv()`
—— **假 `agentapi` 前置 PATH**（调用写入 `agentapi-calls.log`，可断言次数）+ 临时 `ANTIGRAVITY_EXECUTABLE_DATA_DIR`
+ **专用测试会话 id**；被测脚本一律拷进临时根运行。**永不真发消息、不碰生产目录**；
唯一接触生产路径的是显式开启的生产 smoke。

> 注：`C:/AI_ASSIST/work/scripts/` 里旧的那份是**入仓前的过期副本**，已移走；规范位置 = 本目录。

## 五、边界

- 桥只做"唤醒"，**信 ≠ 授权**：信里写的事是否执行仍由收件方按 `.mailbox/README.md` 与用户授权决定。
- 会话绑定（Antigravity 的 conversationId、claude/codex 的 hook 目标）**只有人能改**，模型不改。
- 生产内核（`.mailbox/*.mjs`）是本仓库 `localpost/` 的部署副本，部署需用户明确确认，并留备份 + A/B 只读比对。
