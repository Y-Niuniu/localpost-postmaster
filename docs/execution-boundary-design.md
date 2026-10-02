# 第 3 步设计：可信执行边界（代码/数据分离的 A 方案 + 受保护 bootstrap）

> 2026-10-02 · **只读调查 + 设计，不含任何实施**。实施（UAC / ACL / 搬文件 / 改 profile）需用户明确批准。
> 依据：codex 复审 `codex-boundary-backup-review-20261002.md` 的 §第 3 步架构建议。

## 1. 实测：完整代码依赖闭包

结论：**零 npm 依赖**。全部代码只 import `node:` 内置模块与同级相对文件，
没有 `node_modules`、没有 SDK、没有原生模块。这对 A 方案极其有利——受保护包不需要任何包管理器介入。

| 模块 | 依赖 |
|---|---|
| `fs-safe.mjs` | 仅 `node:`（叶子） |
| `postmaster.mjs` | `./fs-safe.mjs` |
| `mailbox.mjs` | `./fs-safe.mjs` |
| `mcp-server.mjs` | `./mailbox.mjs`、`./fs-safe.mjs` |
| `mcp-launch.mjs` | 无 import（以子进程方式拉起 server，并过滤环境变量） |
| `gc.mjs` | `./fs-safe.mjs`、`./postmaster.mjs` |
| `receiver.mjs` | `./fs-safe.mjs`、`./postmaster.mjs`、`./mailbox.mjs` |
| `receiver-cli.mjs` | `./receiver.mjs` |
| `mail-backup.mjs` | `./fs-safe.mjs` |
| 插件 `lib/index.js` | `node:` + `./notify.js`；**动态** `await import(pathToFileURL(config.kernelPath))` |
| 插件 `lib/notify.js` | `node:` |

**要点 1**：`fs-safe.mjs` 被 5 个模块依赖 → 不能单独搬走。
**要点 2**：插件用可写配置 `config.kernelPath` 动态载入内核 → **这是一个可被改写的入口指针**，
只要插件本身可写，受保护内核也可以被指回一份可写副本。**边界要闭合，插件必须一起受保护。**

## 2. 实测：DSH 的装配能力（回答 codex 的三问）

### 2.1 patch 层与优先级（源码实测）

`dsh` 的 profile boot 层序（源码注释原文语气）：

1. **bundle 层**：按 `dsh.profile.bundles` 顺序，每个插件包自带 `cordis.patch.yml`
2. **profile 自己的** `cordis.patch.yml`
3. **`--patch <file>` overlay**（`bin.js` 有该选项，可重复：`dsh --profile tui --patch ./extra.yml`）
4. telemetry 开关

另有一层：**home 级 patch `$DSH_HOME/cordis.patch.yml`**，注释写明
"applied over every profile's own layer"（覆盖每个 profile 自己的层）。

### 2.2 DSH_HOME 可重定位

`DSH_HOME` 环境变量决定 dsh home（`resolveDshHome()`）。但注意 home 里同时有
`.credentials.yaml`、`sessions/`、`settings` 等**运行时写入**内容与凭据
→ **不能把整个 home 做成管理员专属**，否则 dsh 自己写不了会话。
所以"受保护"只能做到**逐文件**级别，不能靠整体迁移 home。

### 2.3 插件是 node_modules junction 装配

`profiles/<name>/node_modules/@scope/<plugin>` 指向用户可写的插件目录，每个包自带
`cordis.patch.yml` 作为 bundle 层。**也就是说：插件代码与它的 bundle patch 都在用户可写区。**

### 2.4 三个"没有"（关键词全库搜索为空）

| 能力 | 实测结果 |
|---|---|
| machine-level overlay | **无** |
| immutable / sealed MCP registration | **无** |
| read-only / frozen profile | **无** |

**结论：DSH 不提供任何"不可变注册"原语。**
所以 codex 说的"若不支持，设计一个受保护 bootstrap"是唯一可行路线。

## 3. A 方案的落地形态（设计）

### 3.1 受保护代码包

- 位置：管理员可写、普通用户只读的目录（具体盘符/路径待用户批准后定；**不含 `D:`**，用户已明确 D: 是游戏盘）。
- 内容：**整个 8 模块闭包**（不拆开搬），加插件 `lib/index.js` + `lib/notify.js`。
- 版本化：目录名带版本（如 `.../localpost-code-<sha 前 12 位>/`），**原子切换**（新版本部署完再切指针，旧版本保留以便回退）。

### 3.2 数据根

- `C:\AI_ASSIST\.mailbox` 只保留**数据**：`agents/`、`attachments/`、`threads/`、`ledger.json`、
  `alerts.json`、`runtime/`、锁、`README.md`、`postmaster.config.json`。
- 代码通过**显式 data-root** 访问数据根。现有实现已支持（`LOCALPOST_MAILBOX` 环境变量 / 插件 config root），
  迁移只需把入口参数指向数据根，**不改业务行为**。
- **不得从数据根动态加载代码**（即：数据根里不再有可执行的 `.mjs` 被 import）。

### 3.3 插件与启动链必须钉死

- 插件不能再位于用户可写区；否则 `config.kernelPath` 可被改回可写副本 → 边界被绕过。
- 因此 profile 里指向插件的注册项（bundle/insert）必须指向受保护包。
- 这一步会与 DSH 的"插件用 junction 装配"习惯冲突，需要在实施时由用户批准改 profile 装配方式。

## 4. 受保护 bootstrap（设计，三个强度级别）

因为 DSH 没有 immutable registration，只能"启动时校验 + 漂移即拒绝启动"：

| 级别 | 做法 | 强度 | 代价 |
|---|---|---|---|
| **L1 只读校验** | 受保护的 wrapper：启动 dsh 前比对"预期注册项 + 受保护入口 + 插件路径"的哈希；漂移则**拒绝启动并报警** | 中（不改 DSH 行为） | 必须始终经 wrapper 启动；wrapper 自身必须受保护 |
| **L2 校验 + 强制注入** | 在 L1 基础上用 `--patch <受保护 overlay>` 覆盖注册项，使可写层无法篡改生效配置 | 较高 | 需要启动路径能传 CLI 参数（**桌面版能否传参未验证**）；overlay 与 profile 层的相对优先级需再确认 |
| **L3 校验 + 逐文件 ACL** | 把 profile/home 的 `cordis.patch.yml` 做成 admin-only 可写 | 最高 | **会与 DSH 的插件管理冲突**（GUI 装/卸插件要写这些文件） |

**已实测到的 L3 冲突证据**：profile 目录里有 `.plugin-manager/` 目录，以及多个
`cordis.patch.yml.bak-*`（`bak-experiment-20261002`、`bak-my-assist-20260929`、`bak-prefixfix-20260929`）
→ 说明**存在程序化写入该文件的路径**，锁死它可能让插件管理功能报错。

**可用的干净槽位**：`$DSH_HOME/cordis.patch.yml` 目前**只有 3 行、内容是 `[]`**（空列表），
且按注释覆盖所有 profile。它理论上是最干净的"受保护注册位"。**但**：
它是否会被 DSH 自己重写，**尚未验证**（列在 §6 待查）。

## 5. 迁移与回退（设计级）

**迁移顺序**（每一步都要可回退）：

1. 停写：暂停 `LocalPostPostmaster`、`LocalPostGC`、`LocalPostMailBackup`，退出 dsh，确认无 receiver 写者。
2. 备份前像：现有 `.mailbox` 全部代码 + profile patch + home patch（记录 SHA-256、ACL、重解析点）。
3. 建立受保护代码包（新路径，旧文件**一个都不动**）。
4. 部署代码包 + 校验哈希。
5. 改插件 `kernelPath` 与 profile 注册项，指向受保护包。
6. 启动校验 + 专用测试信（读/回复/归档/跨身份拒绝/幂等）。
7. **观察期**：确认 dsh 正常、无漂移告警。

**回退**：把 `kernelPath` 与注册项指回 `.mailbox` 的旧副本即可。
**关键约束：观察期结束前，`.mailbox` 里的旧代码副本一律不删** —— 它们就是回退路径。

## 6. 只读调查可继续（不需要批准）

1. 验证 DSH 是否**自己重写** `$DSH_HOME/cordis.patch.yml`（改一个字节观察？不行——那属于写入。
   改为：读源码找写入点 + 监控 mtime）。
2. 验证**桌面版**（`DeepSeek Harness.exe`）启动路径能否传 `--patch` / 设置 `DSH_HOME`
   （读桌面启动器 `.dsh/desktop-launcher` 与快捷方式参数）。
3. 确认当前 `dsh-mailbox-mcp` 进程的**注册来源**（所有 `cordis.patch.yml` 都没匹配到它）。
4. 确认 home patch 与 `--patch` overlay 的**精确相对优先级**（读 `dsh-app-boot` 的组装顺序）。

## 7. 需要用户/ codex 定的

1. 受保护包放哪个路径（**不能用 D:**）。
2. 采用 L1 / L2 / L3 哪一级（或先 L1 观察、再升级）。
3. 是否接受"以后必须经 wrapper 启动 dsh"。
4. 是否接受为保护而调整 profile 的插件装配方式。

## 8. 顺带发现（与边界同源，本步不处理）

profile 的 `cordis.patch.yml` 里含**明文 API key**（第三方视觉服务的 key），
而该文件位于用户可写、可读区。这意味着：任何以用户身份运行的进程都能读到它。
**值不记录在任何文档/信件中**；建议作为独立事项处理（例如迁到凭据文件或环境变量）。

## 9. 只读调查补充结论（2026-10-02 19:24）

### 9.1 启动路径实测

| 对象 | 实测 |
|---|---|
| 开始菜单快捷方式 | `DeepSeek Harness.lnk` → **直接指向 `DeepSeek Harness.exe`，Arguments 为空**，WorkingDir = 安装目录 |
| `.dsh/desktop-launcher/launcher.ps1` | **由 `dsh-desktop-launcher` 自动生成**（首行注释注明）；逻辑 = 先探测 `http://127.0.0.1:3000`，起一个 WPF 启动动画，再用 `dsh` CLI 启动 |
| `install-shortcut.ps1` | 同目录，负责装快捷方式 |

**对 bootstrap 的含义**：

1. 桌面版常用入口（快捷方式 → EXE）**当前不传任何参数**，也就无法从它注入 `--patch`
   或 `DSH_HOME`。要让 dsh 带上受保护 overlay，需要**替换/包裹启动入口**（快捷方式指向 wrapper）。
2. `launcher.ps1` 调的是 `dsh` CLI → **那里技术上可以传参数**，
   但它是**生成物**，手改会在重新生成时被覆盖 → **不能当作受保护 bootstrap 的落点**，
   除非改的是生成它的插件（那又是用户可写区）。

**结论**：L2（`--patch` 强制注入）要求"启动路径可传参 + 该路径本身受保护"；
在本机现状下这两条**都不天然成立**，需要用户决定是否改变启动方式（例如让快捷方式指向一个
管理员可写的 wrapper）。这属于"改变你的日常启动习惯"，必须用户拍板。

### 9.2 仍未查清的（保持只读）

- `$DSH_HOME/cordis.patch.yml` 是否会被 DSH 自己重写（决定它能否当受保护注册位）。
- 当前 `dsh-mailbox-mcp` 进程的注册来源：**扫遍所有 `cordis.patch.yml` 与 profile package.json
  都没有匹配**，说明它来自别处（插件自带配置 / 运行时注入 / 环境变量），需继续查。
- home patch 与 `--patch` overlay 的精确相对优先级。

## 10. 用户决定（2026-10-02 19:50）：A 方案的两条实施手段都被否决

用户原话（要点）：

- 「**我不能接受这个用另另一个东西打开**」→ **拒绝改成经 wrapper 启动 dsh**。
- 「**为保护和调整插件装配的方式，我不能接受**」→ **拒绝为保护而调整插件装配方式**。
- 同时提问：「受保护代码包放哪个路径，是要做什么的？为什么要保护？」

**后果（诚实结论）**：

| 方案 | 状态 |
|---|---|
| **A（提权部署 / 受保护代码包）** | ❌ 不可实施 —— 它**必须**同时改动启动入口与插件装配，两条都被否决 |
| **L1 只读校验 bootstrap** | ❌ 同样依赖「经 wrapper 启动」，被否决 |
| **L2（--patch 强制注入）** | ❌ 需要启动路径可传参，被否决 |
| **L3（逐文件 ACL 锁配置）** | ❌ 会与插件管理冲突，且属于「调整装配」，被否决 |
| **B（原位收紧 ACL）** | 🟡 未否决，但需重新划定范围（见下） |
| **C（书面接受当前风险）** | 🟡 手段被否决后实际上只剩这条；需用户明确书面接受 |

**B 的范围必须收窄才不伤功能**：不能整目录收紧数据根——Codex 沙箱要往
`agents/codex/**` 写信、dsh 沙箱要处理信件，**把数据目录锁死会直接让邮局瘫痪**。
可行形态是**只对服务代码文件**（`*.mjs` / `*.ps1` / `*.vbs`）收紧写权限，数据目录与信件维持现状。
即便如此，它**挡不住同 token 的进程**（用户自己启动的 agent），按 codex 的定性只能算「人工试点的临时缓解」。

**仍然成立的硬约束**：A 不可实施 ⇒「可信执行边界」这条前置条件无法以 A 形态满足
⇒ **自动派发 / receiver 启用应继续保持禁用**。
第 5 步（MCP 注册 + 服务部署）与第 3 步的边界是两件事：注册本身可用，
但它意味着让模型获得对信箱的**写权限**，是否接受需用户单独表态。


## 11. 用户决定（2026-10-02 21:05）：走 C（书面接受当前风险），不做 B+

用户原话要点：

- 「走 C（书面记录你接受当前风险）」
- 「你们改坏了修就是了，反正我把代码先放在云上」

**因此**：

- **不做 B+**：不建受保护代码包、不搬文件、不提权、不改任何启动器或计划任务。
- 第 3 步以 **C = 书面接受当前风险** 收口。
- 用户对「agent 可能改坏」的态度是**「改坏了修就行」** —— 这是知情选择，记录在案。
- **自动派发当前保持关闭**（**不是**长期禁用）。启用须依次通过三道门槛：T1 E 验收 → T2 用户批准试点 → T3 生产启用。口径见 `docs/rotation-decisions.md`。

### 11.1 同时完成：代码建立远端（消除「无远端」残余风险）

- 私有仓库：`https://github.com/Y-Niuniu/localpost-postmaster`（**private**，账号 **Y-Niuniu**）。
- 已推送并**逐项核对**：6 个分支 + 4 个标签，**10 个 ref 的 SHA 与本地完全相同**。
- 意义：代码不再只有本机一份 → codex 门禁第 6 条点名的「当前仓库无 remote」残余风险**已闭合**。
- **仍未闭合**：信件数据（`.mailbox` 的信/附件/账本）**仍然只有本机一份**，备份也未出机器。
  这是**当前最大的单点风险**，需用户另行决定。

### 11.2 遗留：提交作者名

仓库里有 **24 个提交的作者名是 `YidingNiu <1654828488@qq.com>`**（历史遗留，非本轮产生）。
**未改写历史** —— 改写会使所有已被审核/被引用的 SHA 失效（codex 的验收结论、两个里程碑标签、
release manifest 全部作废）。已向用户说明并等待其决定；新提交一律以 `dsh <dsh@local>` 署名。


## 12. 用户决定（2026-10-02 21:10）：作者名保持原样；信件数据暂不做异地副本

用户原话要点：

- 「不要紧」→ **提交作者名 YidingNiu 保持原样**，不重写历史。
- 「暂时没必要，我只是本科生，信坏了就删了再写呗」→ **信件数据暂不做异机/云端副本**；
  用户明确接受「硬盘坏了信就没了」这一风险。

**因此**：

- **不做历史重写** —— 保护已被 codex 验收的 SHA、两个里程碑标签与 release manifest。
- 信件数据的单点风险 = **用户已知情接受**，不再是待办；日后若想加副本，另行决定。
- 既有备份方案（7 天滚动、仅本机 C:）**继续有效，不做变更**。

### 12.1 第 3 步相关抉择全部闭环

| 抉择 | 结果 |
|---|---|
| 可信执行边界 | **C**（书面接受当前风险） |
| 受保护代码包（B+） | **不做** |
| 自动派发 / receiver | **当前保持关闭**（非长期禁用；三道门槛见 `docs/rotation-decisions.md`） |
| 代码异地副本 | **已建立**（GitHub 私有，逐项核对一致） |
| 信件数据异地副本 | **暂不做**（用户知情接受） |
| 历史提交作者名 | **保持原样**（不重写历史） |

