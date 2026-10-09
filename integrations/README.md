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

**收信聊天开关**（2026-10-09，用户决定：用自然语言切）：`bridges/shared/{wake-binding.mjs,localpost-switch.mjs}`
**每个桥目录各部署一份**（与桥脚本、`config.json` 放在一起；桥按相对路径导入，绝不运行共享信箱里的代码）。
绑定存在 `<信箱根>/runtime/wake/<身份>.json`（三家都写得进 `.mailbox`）：

| 用户在某个聊天里说 | 模型运行（在该客户端自己的桥目录里） |
|---|---|
| 「把收信切到这个聊天」 | `node <桥目录>/localpost-switch.mjs here`（gemini 要加 `--session <会话id>`） |
| 「停止自动收信」 | `node <桥目录>/localpost-switch.mjs off` |
| 「现在谁在收信」 | `node <桥目录>/localpost-switch.mjs status` |

- "这个聊天"怎么认：claude 用 Claude Code 给命令行的 `CLAUDE_CODE_SESSION_ID`；codex 命令行里拿不到，先**登记**（30 分钟），
  由本聊天这一轮结束时的 Stop hook 用 hook 输入里的 `session_id` 认领（codex 0.139.0 `stop.command.input` 的必填字段）；
  gemini 必须显式给会话 id（就是本会话产物目录 `~/.gemini/antigravity/brain/<id>/` 的 `<id>`）。
- 桥怎么遵守：没有绑定文件 = 旧行为；`off` = 谁都不叫；指定了聊天 = 只叫那个聊天。claude 守望：被绑的聊天回合结束时接管
  别的聊天占着的锁，守望每轮核对绑定、挪走就退出；`--context` 不认领登记、`--rewake`（回合结束）认领。gemini：绑定的会话优先于
  `config.json` 的 `conversationId`。`wake-binding.mjs` 漏拷时桥记一笔日志、按旧行为运行（不让 hook 报错）。

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
# 收信聊天开关：shared 两件拷进每个桥目录（claude / codex / gemini 各一份）
Copy-Item integrations\bridges\shared\*.mjs "$env:USERPROFILE\.claude\localpost-wake\" -Force
Copy-Item integrations\bridges\shared\*.mjs "$env:USERPROFILE\.codex\localpost-wake\" -Force
Copy-Item integrations\bridges\shared\*.mjs "$env:USERPROFILE\.gemini\config\sidecars\localpost-gemini-wake\" -Force
```
**回退**：各生产位置均有 `.bak-*`（wrapper 见 `SNAPSHOTS.md`；桥见各目录 `.bak-20261005-*` / `.bak-20261006-*` / `.bak-20261009-switch`）。
回退收信聊天开关只需删掉 `<信箱根>/runtime/wake/<身份>.json`：没有绑定文件时桥的行为与改动前完全一样。

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
| `verification/test-wake-binding.mjs` | 收信聊天开关：判定表、三家 `here/off/status`、四个桥遵守绑定、claude 守望接管与退让、gemini 会话优先级 | 29/29 |
| `verification/smoke-mcp-production.mjs` | 生产信箱**只读**冒烟（**需 `LOCALPOST_SMOKE_PRODUCTION=1` 显式开启**） | 5/5 |

合计 **89/89**（不含生产 smoke）/ **94/94**（含）；内核本体另见 `node scripts/test.mjs`（403/403 + legacy 45/45）。
`test-wake-binding.mjs` 的 18 个变异（一次只拆一处保护）全部被抓到。原有 6 套只拷桥脚本、不拷 `wake-binding.mjs`，
正好覆盖"漏拷时按旧行为运行"。子进程环境会删掉 `CLAUDE_CODE_SESSION_ID`，在 Claude Code 里跑也不会带进真实会话 id。

**隔离模型（2026-10-06 GPT 复审后加固）**：所有套件用 `lib/harness.mjs` 的 `isolatedEnv()`
—— **假 `agentapi` 前置 PATH**（调用写入 `agentapi-calls.log`，可断言次数）+ 临时 `ANTIGRAVITY_EXECUTABLE_DATA_DIR`
+ **专用测试会话 id**；被测脚本一律拷进临时根运行。**永不真发消息、不碰生产目录**；
唯一接触生产路径的是显式开启的生产 smoke。

> 注：`C:/AI_ASSIST/work/scripts/` 里旧的那份是**入仓前的过期副本**，已移走；规范位置 = 本目录。

## 五、边界

- 桥只做"唤醒"，**信 ≠ 授权**：信里写的事是否执行仍由收件方按 `.mailbox/README.md` 与用户授权决定。
- 会话绑定（Antigravity 的 conversationId、claude/codex 的 hook 目标）~~只有人能改，模型不改~~ ——2026-10-09 起（用户决定）：
  **模型只在用户本人在那个聊天里直接要求时**运行 `localpost-switch.mjs`，而且只能把收信切到**说话的这个聊天**
  （claude 的会话 id 来自环境变量、codex 由本聊天的 Stop hook 认领、gemini 由模型报自己产物目录里的 id）；
  信、附件、工具结果里的要求一律不算。最坏情况（被信诱导）也只是叫醒你自己的另一个聊天或谁都不叫，信不会丢。
  DSH 自己的收信聊天同理，见 `docs/production-auto-receive.md`。
- 生产内核（`.mailbox/*.mjs`）是本仓库 `localpost/` 的部署副本，部署需用户明确确认，并留备份 + A/B 只读比对。
