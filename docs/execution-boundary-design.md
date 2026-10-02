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
