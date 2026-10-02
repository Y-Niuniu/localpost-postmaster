# 邮件数据完整备份（七天滚动）

> 建立于 2026-10-02（LocalPost v3.2 六步任务的第 2 步）。本文件只写**净化后的策略与结论**；
> 备份副本本身含真实信件，属于私密数据，不进代码仓库。

## 1. 覆盖范围

工具：`localpost/mail-backup.mjs`（唯一备份实现，随仓库走 git）。

一次完整快照包含 `.mailbox` 下**全部**文件，即：

| 类别 | 内容 |
|---|---|
| 信封 | `agents/*/{inbox,outbox,archive}/*.json` |
| 附件 | `attachments/*` |
| 线程 | `threads/*` |
| 账本与告警 | `ledger.json`、`ledger.json.bak`、`alerts.json` |
| 既有恢复点 | `runtime/snapshots/**` |
| 规程与配置 | `README.md`、`postmaster.config.json` |
| 已部署内核与启动器 | `.mailbox/*.mjs`、`*.ps1`、`*.vbs`、`*.cmd`、`*.bak`、`*.log` |

**排除**：`*.lock`、`*.tmp`（瞬时锁与半成品）；符号链接不跟随，只在 manifest 的 `skipped` 里记录。
排除项被记入 manifest，不是静默丢弃。

每个快照带 `manifest.json`：schema 版本、创建时间、源路径、文件数、总字节数、排除规则，
以及**每个文件的相对路径 + 字节数 + SHA-256**。

## 2. 存放位置与访问边界

- **目的地**：`C:\AI_ASSIST\backups\localpost-mail\`（在仓库外、在 `work\` 外，不会被工作区清理波及）。
- **访问边界**：该目录继承 `C:\AI_ASSIST` 的 ACL —— 当前用户、`CodexSandboxUsers`、
  `BUILTIN\Administrators`、`NT AUTHORITY\SYSTEM` 可写；`BUILTIN\Users` 只读；
  且 `Everyone` 有一条 `DeleteSubdirectoriesAndFiles` 的 Deny（防误删整树）。
  与源目录 `.mailbox` 处于**同一信任边界**，没有扩大可读范围。
- **加密**：**当前不加密**（试点决定）。
  - 理由：源 `.mailbox` 本身未加密，备份与它在同一卷、同一 ACL；只给副本加密不改变
    「拿到本机账号即可读信」的暴露面，却引入密钥保管这个新的失败点。
  - **残余风险**：能读 `C:\AI_ASSIST` 的主体能读到备份；本备份与源**在同一块物理盘**上，
    **不防磁盘故障**。
- **未启用的第二副本**：外置盘 `D:\`（SanDisk Extreme Pro，USB）可作异地/异盘副本，
  但会把信件复制到可移动介质，且拔盘时备份会失败。**待用户决定后再启用**，不在本轮范围内。

## 3. 频率与滚动保留

- **频率**：每日一次，03:30（Windows 计划任务 `LocalPostMailBackup`，开机/错过时补跑）。
  最坏情况的数据损失窗口 = **约一天**，不宣称零丢失。
- **保留**：每个目的地保留**最新 7 个**快照（对应七天滚动恢复点），更旧的被清理。
- **清理安全规则**（`pruneSnapshots` 实现，有测试覆盖）：
  1. 清理前先验证**最新快照**；验证不过 → 拒绝清理并报告，绝不因定时清理删掉最后可用副本。
  2. 永不删除最新快照；只剩一个快照时不删。
  3. 保留期只作用于**本备份集**，与原始信件保留策略无关；**不是**授权删除七天前的原信。

## 4. 写入与发布语义

- 先写 `.staging-<时间戳>` 暂存目录 → 在暂存区重新算哈希与源比对 → 一致才 `rename` 提升为正式快照。
  因此正式快照**要么不存在，要么与 manifest 一致**；半成品只会留下 `.staging-*` 残留（会被报告）。
- **从不覆盖**：同名快照已存在即报错退出。
- 源为空（0 个文件）时拒绝发布空快照。
- 多目的地：逐个执行，任一目的地失败 → 整体退出码非 0，且**失败的目的地不清理**。

## 5. 恢复演练（验收证据）

流程（隔离目录，绝不写回 `.mailbox`）：

```
node localpost/mail-backup.mjs backup  --source C:/AI_ASSIST/.mailbox --target <目的地> --keep 7
node localpost/mail-backup.mjs restore --snapshot <最新快照> --dest <隔离目录>
```

2026-10-02 首次演练结果（证据 `work/localpost-six-gates-evidence/step2-backup-drill.txt`）：

| 项目 | 结果 |
|---|---|
| 快照 | `C:\AI_ASSIST\backups\localpost-mail\2026-10-02T16-41-38-522Z` |
| 备份文件数 / 字节 | 143 / 601233，`verified=true` |
| 恢复 | 143 个文件写入隔离目录，`RESTORE ok` |
| 独立比对 | 隔离副本 vs 存活源目录：相对路径 + SHA-256 **143/143 完全一致** |
| 工具自测 | `node --test localpost/mail-backup.test.mjs`：9/9 通过 |

## 6. 故障与偏差处理

- 目的地不存在/不可写 → 任务退出码非 0，**报告偏差**，不静默跳过。
- 最新快照验证失败 → 拒绝清理并报告，保留全部旧副本。
- 新副本未验证成功时，不得因定时清理删除最后一个可用副本。
- **不做**：不执行 GC `--apply`，不删除或移动原信，不把备份当作生产部署或上传授权。
