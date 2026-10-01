# 生产账本重建迁移方案（未执行 · 待授权）

对象：`C:/AI_ASSIST/.mailbox/ledger.json`（schema `localpost-ledger-v0.2`，kernel `0.1.0`）
快照时的 SHA-256：`aea128220632e7a317de069c02a231abdf62d1db9615ea6a5221990dcf72b9b5`
本文件只描述方案与证据。**本任务没有对生产做任何写入。**

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

## 3. 迁移前必须做的事（硬性前置）

1. **独立、不可覆盖的迁移前快照**：`node localpost/migrate.mjs snapshot --root C:/AI_ASSIST/.mailbox --label pre-ledger-rebuild`
   - 目录名 = `runtime/snapshots/<UTC 时间戳>-<label>`，用排他 mkdir 原子创建：同名（含同毫秒并发）只有一个成功，其余**明确报错、不覆盖**
   - 按**原始字节**记录 `ledger.json` / `alerts.json` / `postmaster.config.json` 的 present/bytes/SHA-256 与当时的信封清单
   - **不要**依赖运行期内核每轮覆盖的 `ledger.json.bak`：它只是当轮安全副本，一次覆盖就没证据了
2. **校验快照**：`node localpost/migrate.mjs verify --root C:/AI_ASSIST/.mailbox --snapshot runtime/snapshots/<目录>` → 必须 `ok: true`
   - verify 先严格校验 manifest 结构（封闭 schema：空对象、缺字段、多字段、类型不符都判失败），再逐字节比对副本；没有 `manifest.json` 的目录是未完成的快照，verify 直接报错
3. **保留六条历史记录摘要**：把第 2 节表格（或等价的 JSON 摘要）随快照一起归档，**不要**只留重建后的账本
4. **停写（以操作为准，锁只是第二道防线）**：
   - `snapshot` 不持任何锁
   - `restore --apply` 写回期间同时持 `.postmaster.lock`（与**新内核**轮次互斥：新内核 `runOnce` 持同名租约）和
     `.mailbox-write.lock`（与 `mailbox.mjs` 投递/回执/归档、`gc.mjs`、receiver 首次初始化互斥）；任一被占即整体跳过（`skipped: true`，退出码 1）
   - **锁对生产当前的旧内核无效**（2026-10-01 用旧内核副本实测）：旧内核把新租约里数字型的 `started_at` 解析成 NaN，
     照常运行，并在结束时删掉 `.postmaster.lock`；按 README 直接写文件的 agent 也不走任何锁
   → 快照与写回前**必须**先停掉内核计划任务，并确认没有 agent 正在投信

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
4. 恢复后再次运行 `verify`，并比对 `ledger.json` 的 SHA-256 是否等于第 1 节记录的迁移前值
5. 回滚顺序：先停计划任务 → 在**新内核文件仍在位**时 `restore --apply`（锁才对内核有效）→ 再换回旧内核文件 → 恢复计划任务

退出码约定（`migrate.mjs`）：0 = 成功；1 = verify 发现问题，或 restore 未完成（跳过 / 写回后校验不符）；2 = 报错或拒绝恢复。
**判断成败以退出码为准**，不要只看是否有输出。

## 6. 未做 / 未验证

- 本任务未在生产执行 snapshot / rebuild / restore 中的任何一步（生产文件哈希未变）
- 快照与恢复逻辑只在隔离测试（`localpost/migrate.test.mjs`，12 项，含同名并发、29 个 manifest 篡改子用例、与新内核轮次的锁互斥、CLI 退出码）中验证过；未在生产信箱实跑过 `snapshot` 写盘
- 六条记录的「当时是否真的收到过回执」无法从现有证据判定，保持为未解决事项
