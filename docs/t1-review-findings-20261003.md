# T1 审查记录：Claude 分支（codex 2026-10-03）

> **来源与性质**：本文件是 **codex 审查结论的存档**（由用户转述，codex 当时已接近额度上限）。
> codex 声明该轮**严格只读**：未归档信件、未改文件、未启用派发；`git diff --check` 干净；
> 且**为遵守"不修改文件"未运行**会写入 `.localpost-tmp` 的测试。
> **本记录未经我方独立复现**——行号与结论均按 codex 原文转录，供后续接手者第一时间使用。

## 结论

**不建议合并 `1571970..6e50dd4`。** 生产派发虽仍关闭，但实现本身还有 **3 个 P0**。

## P0（阻断合并）

### P0-1：不是"到达时绑定"，而是"首次扫描时绑定"

- 位置：`localpost/receiver.mjs:81-100` —— 扫描到信**之后**才调用 `captureBinding()`。
- 后果：若 receiver 停机、扫描延迟，或在 debounce 期间由聊天 A 重绑到 B，
  这封**已经到达**的信会被**错误派给 B**。
- 正确语义（见 `docs/rotation-decisions.md` §3）：**每封信第一次被接收时**固化到达路由快照，
  之后的重绑**只影响新信**。

### P0-2：claim 没有验证"实际调用聊天"

- 位置：`localpost/mailbox.mjs:81-93` 只验证**账本 owner**；`localpost/mcp-server.mjs:73-76` 只传 `agent/id`，
  **没有宿主证明的 caller thread/generation**。
- 后果：**同一 `MAILBOX_IDENTITY` 下的其他聊天**可以读取、回复或归档已经派给聊天 A 的信
  ⇒ 人工/自动**单消费者门禁可被绕过**。

### P0-3：回复/归档与 claim 完成不是崩溃原子操作

- 位置：`localpost/mailbox.mjs:163-169, 180-184, 203-206` —— 先发布回执或归档，**后**把 claim 标成 `done`。
- 后果：两步之间崩溃后，重试看到原信**已不在 inbox**，会**跳过 `complete()`**；
  claim **永久停在 `accepted`**，轮换后可能**再次派给新会话**。

## P1

- `localpost/rotation.mjs:203-211, 225-233`：只检查撤权响应的 `session`、`generation` 和**非空 barrier**，
  **没有验证 barrier 确实绑定当前 letter 集合**；陈旧或错误缓存的 barrier 也可能被接受。
- 自动模式下 receiver **不派发 result**，而 `mailbox.archive()` 又会对**无 claim 的 result**
  在 `localpost/mailbox.mjs:87-90` 抛 `CLAIMED_BY_AUTO` ⇒ **结果信无法按协议归档**。

## codex 要求的修复（5 项）

1. **投递落盘与 route snapshot 同一受控事务**（消灭 P0-1 的窗口）。
2. **MCP 调用注入不可伪造的 caller session/generation**（消灭 P0-2）。
3. **reply/archive 与 claim completion 的可恢复事务日志**（消灭 P0-3）。
4. **barrier 绑定排序后的 letter 集合摘要**（修 P1-1）。
5. **对应测试**：跨进程崩溃 + 双调用者回归。

## 与 P0 门禁的关系

codex 另有一份 T1 追加门禁（`codex-20261003-auto-t1-p0-integrator-gate`）：
自动转移前必须有**可验证的宿主 barrier / 租约撤销**证明旧会话已失去该信处理权；
否则 `accepted`/不确定信固定为原 generation 的 `needs_reconcile`；
`retireSession` 失败必须 fail closed。该门禁与本文件的 P0 **必须一起通过**，否则自动派发继续关闭。
（清单已并入 `docs/host-capability-report.md` §七.2。）

## 当前状态

- **codex 与 Claude 当前均无额度**；本记录来自用户转述，属**未完成审查**的存档。
- 该分支尚未合并；main 仍为 `7338e92`（宿主报告 + 修正）。
- **生产自动派发、receiver、真实宿主接点仍未启用。**
- 接手者应先**独立复现**上述 P0（尤其 P0-1 与 P0-3 的崩溃窗口），再决定修复方案。
