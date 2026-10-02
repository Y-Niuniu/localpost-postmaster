# 生产账本重建迁移方案（2026-10-02 已执行）

对象：`C:/AI_ASSIST/.mailbox/ledger.json`（schema `localpost-ledger-v0.2`，kernel `0.1.0`）
快照时的 SHA-256：`aea128220632e7a317de069c02a231abdf62d1db9615ea6a5221990dcf72b9b5`
第 1–6 节是执行前写的方案与证据，原文保留（上面这个哈希是 10/1 写方案时的值）。实际执行情况见第 0 节。

## 0. 执行记录（2026-10-02）

执行方式：用户本人运行 claude 写的闸门脚本。claude 的权限系统不允许它自己停计划任务、写生产。
脚本先在 3 份生产副本上完整跑通，回滚也演练过。

| 项 | 值 |
|---|---|
| 停写 | 09:21 用户停用 `LocalPostPostmaster` / `LocalPostGC`；dsh 未运行；无在途进程，无锁 |
| 执行 | 09:21:52–09:22:00（本地时间），每一步闸门都通过 |
| 快照 | `runtime/snapshots/2026-10-02T08-21-56-362Z-pre-ledger-rebuild`，verify 两次 `ok:true`；六条摘要存在同名的 `.six-records.md` |
| 迁移前 SHA-256 | ledger `0faeff73b43bc664…`，alerts `a28c832a884b0d03…`，config `9f0abd4711a9a522…`（迁移后 config 未变） |
| 比对 | 旧内核当时的视图 vs 新内核重建：告警一致（`overdue:dsh-20260930-003`）；记录 18 → 12，移除的正好是第 2 节那六条，无新增，无状态变化 |
| 部署 | `postmaster.mjs` + `fs-safe` / `mailbox` / `mcp-server` / `receiver` / `receiver-cli` / `gc.mjs` + 新 `localpost-gc.ps1`，与规范库 `19f447f` 逐字节一致 |
| 备份 | `postmaster.mjs.pre-20261001.bak`（20866 B）、`localpost-gc.ps1.pre-20261001.bak`（2380 B） |
| GC | 换成新 wrapper，计划任务参数不变（不带 `-Apply`）→ **只预览，不删除**；原位 `-WhatIf` 预览 exit 0，0 个候选 |
| 恢复 | 09:24 用户恢复两个任务，并手动触发一轮：新内核经计划任务调用链首次正式运行，exit 1（1 条告警），无残留锁 |
| 未启动 | receiver / MCP server 只是文件就位，没有任何东西启动它们；自动派发仍禁用 |

回滚（如需要）：按第 3 节停写 → 在新内核仍在位时 `restore --snapshot runtime/snapshots/2026-10-02T08-21-56-362Z-pre-ledger-rebuild`（先预览，再 `--apply`）
→ 把两个 `.pre-20261001.bak` 拷回原名 → 按第 3 节「恢复写入口」恢复。

## 1. 为什么需要迁移

现状 10 条记录里有 6 条 `status: replied`，但它们引用的任务信封与回执文件都已不在信箱里。
内核的 `replied` 是**单调**的（`postmaster.mjs`：`else if (prev.status === 'replied') status = 'replied'`），
所以这 6 条会永久停留，且不会被超时告警重新发现。

## 2. 六条记录的准确性质：**缺少证据**，不是「已证实错误」

| id | from → to | subject | sent_at | replied_at | 账本声称的回执路径 | 该文件现状 |
|---|---|---|---|---|---|---|
| pilot-20260905-001 | dsh → opencode | 试点:读附件并一句话总结回执 | 2026-09-05T06:48:25.658Z | 2026-09-05T06:51:00.000Z | agents/dsh/archive/pilot-20260905-001.result.json | 不存在 |
| pilot-20260905-002 | opencode → dsh | 反向试点 | 2026-09-05T07:00:00.000Z | 2026-09-05T06:51:08.926Z | agents/opencode/archive/pilot-20260905-002.result.json | 不存在 |
| demo-20260906-001 | dsh → opencode | 通信演示:自报家门并确认协议 | 2026-09-06T08:29:39.103Z | 2026-09-06T08:31:46.071Z | agents/dsh/archive/demo-20260906-001.result.json | 不存在 |
| opencode-20260906-001 | opencode → dsh | opencode 待命:演示回执已投递,请求确认 | 2026-09-06T08:33:15.684Z | 2026-09-06T08:33:40.454Z | agents/opencode/archive/opencode-20260906-001.result.json | 不存在 |
| dsh-20260912-001 | dsh → opencode | 回执测试：报出你读到的 KERNEL_VERSION + 你的运行环境 | 2026-09-12T05:13:08.199Z | 2026-09-12T05:13:57.267Z | agents/dsh/archive/dsh-20260912-001.result.json | 不存在 |
| dsh-20260913-001 | dsh → opencode | 交付物层试点：worktree 内补 5 条断言并 commit | 2026-09-13T10:31:36.686Z | 2026-09-13T10:33:11.323Z | agents/dsh/inbox/dsh-20260913-001.result.json | 不存在 |

**措辞纪律（重要）**：这 6 条只能表述为「账本声称已回执，但缺少可核验的信封证据」——
**不能**表述为「已证实是假完成」。旧账本的 `reply_path` 恰好记录了当时确实写入过某个回执文件，
只是这些文件后来被删除/归档清理掉了。缺少证据 ≠ 证明为假。

（补充观察：`pilot-20260905-001` 的 `reply` 字段是 `null`，与其他 5 条不同；含义未确认，不作为结论。）

## 3. 迁移前必须做的事（硬性前置，**严格按顺序**）

顺序：**停所有写入口 → 等在途写入结束并确认 → snapshot → verify → 保存历史摘要 → dry-run / 迁移**。
停写靠操作保证，锁只是第二道防线（见本节末）：`snapshot` 不持任何锁，锁对生产当前的旧内核也无效。

1. **停掉所有写入口**（缺一个都不算停写）：

   | 写入口 | 怎么停 |
   |---|---|
   | 内核计划任务 `LocalPostPostmaster` | `Disable-ScheduledTask -TaskName LocalPostPostmaster` |
   | GC 计划任务 `LocalPostGC` | `Disable-ScheduledTask -TaskName LocalPostGC` |
   | dsh 的 LocalPost 插件：启动后跑一轮、之后每 `intervalMinutes`（默认 15）分钟一轮，外加手动 `localpost_check`（`lib/index.js` 定时器段），在 dsh 进程内直接 import 内核跑 `runOnce` | **完全退出 dsh**（TUI / web / 桌面端）。插件由 profile bundles 自动装配，没有单独开关；**只停计划任务停不住它** |
   | 投信 / 回执 / 归档的写者：各 agent 会话、`mailbox.mjs`，以及已部署的 receiver / MCP server | 结束或暂停所有 agent 会话，确认没有人正在投信 |

2. **等在途写入结束，并确认已暂停**（停掉入口不会中断已经开始的轮次）：
   - `Get-ScheduledTask -TaskName LocalPostPostmaster, LocalPostGC` → 两个都是 `Disabled`
   - `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'postmaster|localpost-gc|gc\.mjs' }` → 无输出
   - `C:/AI_ASSIST/.mailbox/` 下没有 `.postmaster.lock`、`.mailbox-write.lock`。如果有，说明还有轮次在跑，或者是上次异常退出留下的锁：
     **先查清楚是哪一种，不要直接删**
3. **独立、不可覆盖的迁移前快照**：`node localpost/migrate.mjs snapshot --root C:/AI_ASSIST/.mailbox --label pre-ledger-rebuild`
   - 目录名 = `runtime/snapshots/<UTC 时间戳>-<label>`，用排他 mkdir 原子创建：同名（含同毫秒并发）只有一个成功，其余**明确报错、不覆盖**
   - 按**原始字节**记录 `ledger.json` / `alerts.json` / `postmaster.config.json` 的 present/bytes/SHA-256 与当时的信封清单
   - 快照不持锁，**多个文件是否属于同一时刻完全靠第 1–2 步保证**；它不是在线快照，不能在写入口开着时用
   - **不要**依赖运行期内核每轮覆盖的 `ledger.json.bak`：它只是当轮安全副本，一次覆盖就没证据了
4. **校验快照**：`node localpost/migrate.mjs verify --root C:/AI_ASSIST/.mailbox --snapshot runtime/snapshots/<目录>` → 必须 `ok: true`
   - verify 先严格校验 manifest 结构（封闭 schema：空对象、缺字段、多字段、类型不符都判失败），再逐字节比对副本；没有 `manifest.json` 的目录是未完成的快照，verify 直接报错
   - verify 证明副本与 manifest 一致，**不证明**各文件属于同一时刻（那是第 1–2 步的责任）
5. **保留六条历史记录摘要**：把第 2 节表格（或等价的 JSON 摘要）随快照一起归档，**不要**只留重建后的账本
6. 进入第 4 节：先 `--dry-run` 核对，再 `--rebuild`

**恢复写入口**（迁移或回滚完成后）：先 `Get-ScheduledTask -TaskName LocalPostPostmaster, LocalPostGC | Enable-ScheduledTask`，**最后**再启动 dsh。
（`Enable-` / `Disable-ScheduledTask` 的 `-TaskName` 只收一个名字，两个一起操作要像这样走管道。2026-10-02 实测：直接传两个名字会报参数转换错误。）
插件会把已加载的内核模块缓存在 dsh 进程里（`lib/index.js` 的 `loadKernel`），换过内核文件之后，只有重新启动的 dsh 才会加载磁盘上的新版本。

**锁的作用范围（第二道防线，不能代替停写）**：
- `restore --apply` 写回期间同时持 `.postmaster.lock`（与**新内核**轮次互斥：新内核 `runOnce` 持同名租约）和
  `.mailbox-write.lock`（与 `mailbox.mjs` 投递/回执/归档、`gc.mjs`、receiver 首次初始化互斥）；任一被占即整体跳过（`skipped: true`，退出码 1）
- **锁对生产当前的旧内核无效**（2026-10-01 用旧内核副本实测）：旧内核把新租约里数字型的 `started_at` 解析成 NaN，
  照常运行，并在结束时删掉 `.postmaster.lock`；旧内核自己的锁也是非排他的先读后写；按 README 直接写文件的 agent 不走任何锁

## 4. 重建本身（`--rebuild`）

`postmaster.mjs` 的 `--rebuild` 用「扫描到的信封 + 有效终态回执」从零推导账本。
dry-run 实测（新内核，只读）：

| | 记录数 | replied | overdue | sent | 告警 |
|---|---|---|---|---|---|
| 当前账本 | 10 | 6 | 3 | 1 | 3 条 overdue |
| 重建后 | 4 | 0 | 3 | 1 | **同样 3 条 overdue** |

即：重建**不影响告警行为**，只是把 3 条在途任务按信封重新判定（`dsh-20260930-002/003/004` 保持 overdue，
`codex-20261001-localpost-handoff-cbbe93e` 保持 sent），并让 6 条无证据记录不再出现在账本里。

重建**不能**证明什么：它不能证明那 6 条当时没有回执；它只是不再假设它们已完成。

## 5. 可验证的恢复路径

1. `node localpost/migrate.mjs restore --root C:/AI_ASSIST/.mailbox --snapshot runtime/snapshots/<目录>` → 只预览
   （逐文件列出 `create / overwrite / unchanged`，**不写盘**）
2. 确认预览符合预期后加 `--apply`；写回前会先过与 `verify` 相同的校验，manifest 或副本被改动过则拒绝恢复（退出码 2）；
   只写回通过校验的那份字节；写回期间持 `.postmaster.lock` + `.mailbox-write.lock`，被占则跳过（退出码 1，可重试）
3. 写回后工具会再做快照自校验与目标文件哈希校验，任一不符 → 结果 `ok: false`、退出码 1；
   另外应对内核跑一次 `--dry-run`，确认告警集合与迁移前一致
4. 恢复后再次运行 `verify`，并比对 `ledger.json` 的 SHA-256 是否等于快照 manifest 里记录的迁移前值
5. 回滚顺序：按第 3 节第 1–2 步停写并确认（两个计划任务 + 退出 dsh + 暂停投信，等在途轮次结束）
   → 在**新内核文件仍在位**时 `restore --apply`（锁才对内核有效）→ 再换回旧内核文件
   → 按第 3 节「恢复写入口」恢复（dsh **最后**启动，才会加载换回的旧内核）

退出码约定（`migrate.mjs`）：0 = 成功；1 = verify 发现问题，或 restore 未完成（跳过 / 写回后校验不符）；2 = 报错或拒绝恢复。
**判断成败以退出码为准**，不要只看是否有输出。

## 6. 未做 / 未验证

- 2026-10-02 已在生产执行 snapshot / verify / rebuild 和内核部署（见第 0 节）；**restore 从未在生产执行过**，只在生产副本上演练过
- 第 3 节的停/启计划任务命令已由用户在生产执行过（2026-10-02）
- 快照与恢复逻辑除生产这一次 snapshot 外，只在隔离测试（`localpost/migrate.test.mjs`，12 项，含同名并发、29 个 manifest 篡改子用例、与新内核轮次的锁互斥、CLI 退出码）和副本演练中验证过
- 六条记录的「当时是否真的收到过回执」无法从现有证据判定，保持为未解决事项
