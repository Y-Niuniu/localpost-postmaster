# LocalPost v3.2 六步任务 — 进度与交接（dsh → claude）

- 交接时间：2026-10-02 约 18:05（Europe/London）
- 授权来源：用户在 Codex 聊天里指示把六步交给 dsh，一件件串行执行。
  任务信 `codex-20261002-dsh-localpost-six-gates`，附件 `codex-dsh-six-gates-20261002.md`（`.mailbox/attachments/`）。
- 交接原因：用户报告 dsh 会话不稳定/反复重启，要求写进度并交给 Claude 接手。
- **dsh 已停止对生产做进一步改动。**

## 一、总状态

| 步骤 | 状态 |
|---|---|
| 1 整合已审核提交 | ✅ 完成并验收 |
| 2 七天滚动完整邮件备份 | 🟡 备份本体完成并演练通过；**自动化计划任务未建**（见 §三） |
| 3 可信执行边界（提权） | ⬜ 未开始（涉及 UAC，需用户实机确认） |
| 4 纠正里程碑标签 | ⬜ 未开始 |
| 5 按 manifest 部署生产 | ⬜ 未开始（需用户批准） |
| 6 两轮宿主退出验收 | ⬜ 未开始 |

规范库：`C:\AI_ASSIST\tools\dsh-localpost-postmaster`（无 remote）。
**当前 main = `baf4880f6a404d2b6b4f8d4a6f458bded2eeb5b9`**，工作区干净。

## 二、第 1 步（完成）

从 Claude worktree（`C:\AI_ASSIST\work\localpost-claude` 的 `agent/claude-localpost-fix`）快进整合到规范库 main：

```
fb3ec71 ──> af4bd58 ──> 94e3223 ──> 9f5c98c      (fast-forward, 保留被审核的原始 SHA)
```

- 差异 = 10 个文件、+769/−40，仅启动层 + 测试 + 文档，无夹带改动。
- 测试：**134/134 模块 + 40/40 插件，exit 0，fail 0，skipped 0**。
- 证据：`docs/evidence/step1-tests-full.txt`。

## 三、第 2 步（备份本体完成；自动化缺一环）

新增（提交 `baf4880`）：

- `localpost/mail-backup.mjs` — 唯一备份实现。暂存目录 → 重新哈希比对 → `rename` 提升；
  每个快照带 `manifest.json`（逐文件相对路径 + 字节数 + SHA-256）；同名快照拒绝覆盖；
  源为空拒绝发布；多目的地逐个执行，失败的目的地不清理。
  清理（`prune`）只在**最新快照验证通过**后才执行，永不删最新、永不删最后一个，默认保留 7 个。
- `localpost/mail-backup.test.mjs` — 9 条测试（含篡改检测、清理安全规则、暂存残留识别）。
- `docs/mail-backup.md` — 覆盖范围、目的地、ACL、加密决定、频率、保留、故障处理。
- 全量测试：**143/143 模块 + 40/40 插件，exit 0**。证据 `step2-full-suite.txt`、`step2-backup-tests.txt`。

已建立的真实备份与演练：

| 项目 | 结果 |
|---|---|
| 快照 | `C:\AI_ASSIST\backups\localpost-mail\2026-10-02T16-41-38-522Z` |
| 内容 | 143 文件 / 601233 字节，`verified=true` |
| 恢复演练 | 隔离目录恢复 143 文件，`RESTORE ok` |
| 独立比对 | 副本 vs 存活源：相对路径 + SHA-256 **143/143 完全一致** |
| 证据 | `step2-backup-drill.txt` |

**已部署到生产的三个新文件**（部署前均不存在，均属新增、无覆盖）：

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `.mailbox\mail-backup.mjs` | 13573 | `840E27D71484DB0C0CF7238BCC00F041B71CB0136FFFF3279CC5326639967657` |
| `.mailbox\localpost-mailbackup.ps1` | 793 | `896E9E1FA7E67909CD572688689E9D6591ACDA04E910CD3B4E4240DCA568799E` |
| `.mailbox\localpost-mailbackup-hidden.vbs` | 457 | `53E2186BFDDD6DD8471E3EA0CCF27CF82A46D377673814ABAB40F8338029A226` |

**⚠ 缺口：Windows 计划任务 `LocalPostMailBackup` 没有创建。**
所以现在**没有自动备份**：只有一个手动快照，七天滚动尚未成立。
三份文件在没有任务的情况下是**惰性的**，不影响局长运行。

## 四、未回的信（需要处理）

| 信件 | 内容 |
|---|---|
| `codex-20261002-dsh-localpost-six-gates` | 六步任务本体 |
| `codex-20261002-mail-backup-retention-7d` | 用户定：完整备份滚动保留 **7 天**（替换 7日+8周+6月），要求更新方案并回执 |
| `dsh-20261002-005.result` | codex 对 v3.1 的复审：五处已落实、README 已修；新发现两点（见 §六） |

## 五、回滚（每项都独立可逆）

1. 三个新文件：`Remove-Item .mailbox\mail-backup.mjs, .mailbox\localpost-mailbackup.ps1, .mailbox\localpost-mailbackup-hidden.vbs`。
   删除即回到部署前状态（无任务，无其他引用）。
2. 备份数据：`C:\AI_ASSIST\backups\localpost-mail\` 整目录可删；删除不影响 `.mailbox` 源。
3. 演练残留：`docs/evidence/restore-drill\`（信件副本，验收后可删）。
4. 代码：`git reset --hard 9f5c98c` 可丢掉 `baf4880`（纯新增，丢也不影响既有功能）。
5. 生产三文件（mailbox/mcp-server/fs-safe）**本轮没有动**，仍是旧版。

## 六、codex 复审里的两个新发现（第 4/5 步要用）

1. **工具名写错**：本机实际注册名是 `mcp__localpost__mailbox_*`；v3.1 §三.2 写的 `localpost__mailbox_*` 不对。
   以实际 `tools/list` 为准。
2. **两个里程碑标签都指错了**：`milestone/eac20c9-migration` 与 `milestone/721e6ef-controlled-write`
   都指向 `fb3ec71`（方案文档提交），两者都是 annotated tag。
   第 4 步要求：**不删、不动旧标签**，新建名字不嵌短 SHA 的准确标签
   （如 `milestone/migration` → `eac20c9bc637d8c900284da8eb58dfe4f05bb015`；
   `milestone/controlled-write` → `721e6ef4b5d21a338c4631d53c942fb90c117b8b`）。
   规范库 `docs/releases.md` 已写好方案与核对命令。
3. 环境实施方式仍是硬骨头：本机 `buildChildEnv()` 是「父环境 + 敏感名过滤」，**不是严格白名单**；
   `dsh-subprocess` 过滤规则为 `/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_` 前缀，其余父环境默认传递。
   所以「有敏感名过滤」≠「只剩允许表」。需要能落地的允许表实现方式。

## 七、用户仍需拍板的决定

1. 是否启用**外置盘 `D:\`（SanDisk Extreme Pro，USB）第二副本**？（异盘才防磁盘故障；拔盘时备份会失败）
2. 备份是否**加密**？当前决定不加密（与源同盘同 ACL，加密只增加密钥保管失败点），残余风险已写入 `docs/mail-backup.md`。
3. 是否批准第 3 步提权到「仅 Administrators/SYSTEM 可写」位置（**需要用户在实机确认 UAC**）。
4. 是否批准第 5 步的生产部署 + MCP 注册 + 重启 dsh。

## 八、稳定性备注（未经证实，勿当结论）

- 2026-10-02 17:43–17:44 观察到 dsh 进程组重启；当时 dsh 正在跑完整测试套件（`node scripts/test.mjs`，
  会启动大量 node 子进程、弹 toast、写 `.localpost-tmp`）并同时做恢复演练。
- **因果未证实**。已知插件自测只跑 fixture 内核（源目录 ledger 字节未变，有断言）。
- 建议：接手后先在**独立终端**跑套件、不要在 dsh 会话内并行跑重型循环；若仍复现，按 `diagnose` 流程抓进程/内存证据。

## 九、证据文件清单（`C:\AI_ASSIST\docs\evidence\`）

`step1-tests-full.txt`、`step1-tests.txt`（截断版）、`step2-full-suite.txt`、`step2-backup-tests.txt`、
`step2-backup-drill.txt`、`smoke\`、`restore-drill\`、`parts\`（组装用的分片，可删）。

## 十、用户决定（2026-10-02 17:45 · dsh 记录）

1. **不启用 D: 第二副本** —— 用户原话：「d 盘不要副本，专门打游戏的不参与生产」。
   `D:\` 是游戏盘、不参与生产，不得写入生产数据或备份（本会话也没有写过）。
   备份**只有 C: 一份**、与源同盘；不做磁盘故障防护这一残余风险已写入
   `docs/mail-backup.md` §2.1。要异地保护需另行决定。
2. **第 3 步「提权」仍未获授权** —— 用户问的是「提权是什么」，属概念询问，**不是批准**。
   需先用大白话讲清「做什么 / 代价 / 备选方案」，再等用户表态。
3. **第 5 步改由用户自己执行** —— 用户原话：「5等写好了我会自己做」。
   因此第 5 步的交付物是**一份用户可照做的 runbook**（大白话步骤 + 可复制命令 +
   每步验收 + 出错回退），由用户亲手执行，而不是 agent 代为部署。

补充提交：`a79106e`（把决定 1 写进 `docs/mail-backup.md`，并标注自动备份任务尚未创建）。

## 十一、第 2 步已补齐（2026-10-02 18:06 · dsh）

用户指示「你先继续」（claude 额度用尽），dsh 继续执行，已补上第 2 步最后一个缺口：

- **计划任务 `LocalPostMailBackup` 已创建**：每日 03:30、`StartWhenAvailable`（错过补跑）、
  `MultipleInstances IgnoreNew`、当前用户交互身份（与 `LocalPostGC` 同款 principal），
  动作 = wscript 调用 `.mailbox/localpost-mailbackup-hidden.vbs`（无窗口）。
- **端到端验证通过**：手动触发 → `LastTaskResult=0`，新快照 `2026-10-02T17-04-38-398Z`
  发布并自校验 `149/149`，无 `.staging-*` 残留。
- **部署文件哈希以本表为准**（VBS 中途修过一次，§三 里的 VBS 哈希已作废）：

| 文件 | SHA-256 |
|---|---|
| `.mailbox/mail-backup.mjs` | `840E27D71484DB0C0CF7238BCC00F041B71CB0136FFFF3279CC5326639967657` |
| `.mailbox/localpost-mailbackup.ps1` | `896E9E1FA7E67909CD572688689E9D6591ACDA04E910CD3B4E4240DCA568799E` |
| `.mailbox/localpost-mailbackup-hidden.vbs` | `F0BEAC1EBEB68F6C3BC8118DA283B086196F5519B6BCA68E8D4F09207858B88F` |

- **踩过的坑（后人别再踩）**：用 TypeScript 模板字符串生成含 Windows 路径的脚本时，单反斜杠会被
  当转义符吃掉（`\A` `\.` `\l`），路径变成 `C:AI_ASSIST.mailbox...`；症状是 wscript 报
  `800A0409 未结束的字符串常量`、退出码 `-196608`，任务 `LastTaskResult=4294770688`。
  最终改用**正斜杠路径**，彻底消除转义风险。
- 保留现状：目前 4 个快照都是同一天的（手动 1 + 排障/验证 3）；「七天滚动」要等每日任务
  连续跑几天才真正成立。`prune` 按数量保留最新 7 个。

## 十二、codex 复审后的修订与协议修复（2026-10-02 19:25 · dsh）

### 用户指示
用户："你先继续claude没额度了"（Claude 额度用尽，dsh 继续）。

### 第 2 步修订（commit 87e810c）
- **保留语义从"7 份"改为"7×24 小时时间窗口"**：按每个快照 manifest 的 `created_at` 排序与判龄，
  **绝不按目录名**；参数改为 `--retention-days 7`（`--keep` 已移除）。
- 保守规则：非法/未来 `created_at` 与 manifest 不可读的快照**一律不删**，只报 anomaly；
  全部无可用 `created_at` 时**拒绝清理**。
- 单测 18/18（覆盖同日多份、跨日、恰好边界、未来/非法时间、最新损坏、manifest 不可读）。
  测试抓到我两个真实缺陷：① 曾按目录名排序取"最新"；② 未来时间若恰为最新则不被标记。
- 语义实证：同日 9 个快照 → `kept=9 removed=none`（旧逻辑会删 2 个）。
- 完整套件：**152/152 模块 + 40/40 插件 exit 0**（干净重跑）。
- **如实记录一次瞬时失败**：并发跑 9 次备份时出现
  `mailbox write lock unavailable: invalid_owner_needs_reconcile`，干净重跑未复现，因果未证实。
- 隔离恢复演练：生产最新快照 → 159 文件恢复，独立比对副本 vs 源 **0 差异**。

### 计划任务独立复核
codex 的 `schtasks /Query /TN LocalPostMailBackup` 报"找不到路径"——**是缺前导反斜杠**。
`/TN "\LocalPostMailBackup"` 命中。宿主记录：TaskPath `\`、State Ready、
LastRunTime 2026-10-02 19:17:10、**LastTaskResult=0**、NextRunTime 2026-10-03 03:30、
StartWhenAvailable True、任务文件 4008 字节。

### 协议事故修复（ID 复用）
- `dsh-20261002-006/007` 与今天更早的 Outlook 邮件线程归档信同 ID → `id_conflict`（局长报 error）。
- 已用**全新 ID 重发**：`009`（进度报告）、`010`（7 天保留回执，终态改判 **failed**，因为结论已被否决）。
- 两封撞号信已**移出 codex 信箱**，保存在 `docs/evidence/void-id-conflict/`（未删除，留证据）。
- 修复后局长告警回到 **1 条**（那条是 2026-09-30 的旧超时，与本任务无关）。

### 部署文件哈希（以本表为准，第 2 步相关）
| 文件 | 字节 | SHA-256 |
|---|---|---|
| `.mailbox/mail-backup.mjs` | 16755 | `B714A000C9D49860012033E90D5C631542011E32FD69D4B967C345613B3C9124` |
| `.mailbox/localpost-mailbackup.ps1` | 818 | `D4FF38BEC2B51D5CB599AD5A3FC96077F28D14E23705E417566EA089B85C2754` |
| `.mailbox/localpost-mailbackup-hidden.vbs` | 546 | `F0BEAC1EBEB68F6C3BC8118DA283B086196F5519B6BCA68E8D4F09207858B88F` |

### codex 对第 3 步的架构意见（本次复审给出）
- 不建议 C；B 只可作人工试点临时缓解，不能当最终边界。
- 长期仍走 A，但**必须先做"代码与可写数据分离"**：受保护代码包（launcher/server/mailbox API/fs-safe
  及全部运行时依赖）放管理员可写位置、可版本化原子切换；`.mailbox` 只存数据，通过显式 data-root 访问，
  不得从数据根动态加载代码；插件与启动链必须固定到受保护包，否则边界不闭合。
- profile 冲突：不要粗暴锁死日常可变 profile；先查 DSH 是否支持 machine-level overlay /
  immutable MCP registration / 独立 profile；不支持则设计受保护 bootstrap，启动时校验注册项与入口，漂移 fail closed。
- **下一步只限设计与只读调查**；UAC/ACL/移动生产文件/改 profile 需用户明确批准。

### 未完成
第 3 步（设计+只读）、第 5 步（用户亲自执行的 runbook）、第 6 步（两轮宿主退出验收）。
**六步主任务未完成，不得声称完成。**
