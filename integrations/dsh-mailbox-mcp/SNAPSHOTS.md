# dsh-mailbox-mcp 源码快照与哈希（GPT 两轮复审点名的交付纪律）

> 本目录**不是 Git 仓库**（单文件目录），所以没有历史提交可 diff。GPT 复审两次指出：
> "旧 MCP 没有完整改前快照……后续应保存确切源码快照/哈希和测试证据，避免只凭 38/38 宣称所有边界通过。"
> 本文件即对该条的补交。

## 当前文件与快照

| 角色 | 文件 | SHA256 | 大小 | 行数 |
|---|---|---|---|---|
| **改前**（P1-1 之前） | `snapshots/server.mjs.pre-p1-1-20261005` | `B9BFE5F32F0DA1B23B9900852E85A606C2098BFD36C092050BC2C1CFA7E63903` | 13375 B | 296 |
| **现行**（P1-1 + GPT 二轮修复后） | `server.mjs` | `3D25A47B67912C28B90E6EFE4D61AEC5FE86B85904B42F52D193FD7DD67FE901` | 17628 B | 341 |

差异规模：`113 insertions(+), 68 deletions(-)`（`git diff --no-index` 统计；本目录无 git 历史，用该命令即可复现）。

```powershell
# 复现差异
git diff --no-index tools/dsh-mailbox-mcp/snapshots/server.mjs.pre-p1-1-20261005 tools/dsh-mailbox-mcp/server.mjs
```

## 改前快照的来源与诚实说明

- 该快照是**重建件**：逐段取自 2026-10-05 20:19–20:21 会话中对当时磁盘文件的读取（三段落：1–70、71–170、171–296 行），
  拼接还原。语法已验证（`node --check` 通过，需临时改名为 `.mjs` 才能被 node 识别扩展名）。
- 它是"**P1-1 之前**"的状态：投递已走共享内核（改前那轮），但**回执/归档仍手拼 + renameSync**、**无身份绑定**、
  **读取直接拼路径**、**stdin 关闭即 exit**。
- 它的 SHA256 是**重建内容的哈希**，不是任何历史文件的历史哈希 —— 请当作"可 diff / 可回退的改前内容"，而不是取证级原件。
- **更早一代**（投递也直接 `fs.writeFileSync` 写 inbox，没有到达记录）**没有任何快照，已不可恢复**；
  其行为只在该轮的改动注释里留了描述（见 `server.mjs` 顶部 `SHARED_API` 注释）。

## 关键差异点（自动化核对）

| 符号 | 改前 | 现行 | 说明 |
|---|---|---|---|
| `identityFor` | 0 | 6 | 身份绑定（`LOCALPOST_IDENTITY` / `MAILBOX_IDENTITY` + 可选 fail-closed） |
| `LOCALPOST_IDENTITY` | 0 | 5 | 同上 |
| `box.reply` | 0 | 1 | 回执收敛到共享内核（outcome / reply_id / base_rev / 原子归档） |
| `box.archive` | 0 | 1 | 归档收敛到共享内核 |
| `assertSafeId` | 0 | 2 | 读信 id 校验（堵路径穿越） |
| `REPLIED_ARCHIVE_PENDING` | 0 | 2 | 结构化故障透传（部分完成不再被压成纯文本） |
| `chain.finally` | 0 | 1 | stdin 关闭前等待串行链收口 |

复现命令：

```powershell
node --check server.mjs
foreach ($p in 'identityFor','LOCALPOST_IDENTITY','box.reply','box.archive','assertSafeId','REPLIED_ARCHIVE_PENDING','chain.finally') {
  '{0,-26} pre={1} post={2}' -f $p, (Select-String -Path snapshots/server.mjs.pre-p1-1-20261005 -Pattern $p -SimpleMatch).Count, (Select-String -Path server.mjs -Pattern $p -SimpleMatch).Count
}
```

## 测试证据（与本目录改动绑定）

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `work/scripts/test-mailbox-mcp-reply.mjs` | 终态回执+归档 / 非终态独立 reply_id+不归档+outcome / 身份绑定 / 非法 outcome / stdin 收口 | 9/9 |
| `work/scripts/test-gpt-review-fixes.mjs` | GPT 8 反例（含 **MCP 路径穿越**、结构化故障字段、身份 fail-closed 开关） | 19/19（含两个 checker 与 gemini/锁） |
| `work/scripts/smoke-mcp-production.mjs` | 生产信箱**只读**冒烟（roster / README / 读自己 / 拒读他人 / stderr 干净） | 5/5 |

## 回退方法

```powershell
# 回到"P1-1 之前"（会失去身份绑定、内核对齐回执、路径穿越防护、结构化故障）
Copy-Item tools/dsh-mailbox-mcp/snapshots/server.mjs.pre-p1-1-20261005 tools/dsh-mailbox-mcp/server.mjs -Force
# 注意：撤回后 Antigravity 的 MCP 配置里 LOCALPOST_IDENTITY 仍在，但旧代码不认它 ⇒ 无绑定（兼容模式）
```

> ⚠️ 另有 `server.mjs.bak-20261005-2035`：**它是改后生成的**，不是改前快照，保留仅为过程记录；以本目录 `snapshots/` 为准。
