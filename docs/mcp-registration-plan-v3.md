# 方案 v3：给 dsh 注册 LocalPost 信箱 MCP（取代 v2；待用户批准，未执行）

v2 见 `.mailbox/attachments/claude-dsh-mcp-registration-plan-v2-20261002.md`。
v3 按 codex 审核 `codex-review-ad1a428-20261002.md`「启用方案 v2：部署前须改」六条修订。
**本方案不是部署授权**；每一步写操作都要用户在聊天里批准。

> **v3.1 修订（2026-10-02，按 codex 对 v3 的审核）**：① §一.4 纠正日志证据（`postmaster.log` 不带 plugin 来源，
> 改用 `plugin.log` + PID/入口/哈希/行为证据）；② §一.1 明确"日志静默 + 无锁"不足以证明无使用者；
> ③ 新增 §一.6 调度恢复与失败路径（按 enabled/disabled 设置恢复，回退失败则保持停写）；
> ④ §二.2 最小环境改为"落实并核对实际继承变量"；⑤ 新增 §五 发布清单与回滚证据链。
>
> **v3.2 修订（2026-10-02，claude，按 GPT 对 `af4bd58` 的审核）**：① 注册入口改为受控启动层 `mcp-launch.mjs`，
> 部署、备份、回退、发布清单从三个文件改为四个；② §二.1 的 env 增加 `NODE_OPTIONS: ''`、`OPENSSL_CONF: ''`，
> 由 dsh 在建进程前覆盖为空（实测两者都会让 node 在启动层代码之前加载外部代码）；③ §一.4 / §三 的证据改为两层进程，
> 由 server 自报实际收到的变量名；④ §三 新增孤儿进程检查；⑤ §二.4 可信代码核查扩到部署目录与四个文件的 ACL、重解析点和替换权限。
> 启动层的说明与实测见 `docs/mcp-launch.md`。

## 相对 v2 的六处修订（codex 意见 → 本方案做法）

| # | codex 要求 | v3 做法 |
|---|---|---|
| 1 | 明确停掉两个任务**及相关写者**，不能靠"避开运行时刻" | §一.1 改为**必须停**：退出 dsh + 禁用两个计划任务 + 等在途结束 + 确认无使用者/租约 |
| 2 | 按**新进程**核对，不是文件哈希 | §一.4 增加"新进程加载证据"（插件轮次日志 / MCP 进程启动日志），哈希只作辅助 |
| 3 | **不要用 roster 证明绑定身份** | §三.1 改为看 `initialize` 返回的 identity 说明 + 做**跨身份负向请求** |
| 4 | 连接失败必须**可见并阻断依赖能力** | §二.3 明确：工具缺失 = 故障告警，**不许**悄悄退回直接写文件 |
| 5 | 可信代码核查（防模型改写、最小环境） | §二.4 新增：脚本与依赖固定、文件权限、最小 env、token 不保证覆盖 ACL、失败不自动改 ACL |
| 6 | 协议修订归唯一源 | 已由 dsh 写入 `.mailbox/README.md` §2 / §3.1 / §3.2 / §5（见该文件）；本方案不复制协议正文 |

## 前置条件

1. **集成完成**：本轮修订提交进 main 且规范库同步到同一提交（三库一致）。
2. **用户批准**（可合并为一次）：① 部署四份服务文件；② 注册 MCP 并重启 dsh。
3. **现场状态现查**，不沿用旧数字：dsh 收件箱积压、有无 dsh / receiver / MCP 进程、有无残留锁。

## 一、部署服务文件（`mailbox.mjs`、`mcp-server.mjs`、`fs-safe.mjs`、`mcp-launch.mjs`）

四个文件**必须整体一起部署**：前三个属同一依赖图；`mcp-launch.mjs` 是注册入口，它只启动**同目录**的 `mcp-server.mjs`，
所以必须和它放在同一目录。

### 1. 停写（**必须停，不是"避开时刻"**）

`fs-safe.mjs` 被内核、GC、MCP、receiver 以及任何直接 import 投信的脚本共享，所以：

1. **退出 dsh**（插件经内核间接 import `fs-safe.mjs`；dsh 活着就停不干净）
2. **禁用** `LocalPostPostmaster` 与 `LocalPostGC`（先记录原始 State）。
   ⚠️ **不能**用"部署不在它每 15 分钟运行时进行"替代 —— 错过补跑、手动触发、别的调用者都可能撞上
3. **等在途结束**：`.mailbox` 日志静默、`.postmaster.lock` / `.mailbox-write.lock` 均不存在
   —— ⚠️ 但**日志静默 + 无锁不足以证明没有闲置使用者**（例如空转的 import 进程），必须另行确认
4. **确认并停止/暂停所有使用者**：正在跑的 MCP 进程（启动层 `mcp-launch.mjs` 与 server `mcp-server.mjs` 两层）、receiver、agent 用 node 直接调 `mailbox.mjs` 投信；
   并确认没有在途任务（这是必须**主动确认**的一步，不是"看起来没人用"）
5. **部署窗口内不投信**

### 2. 备份精确前像

四份服务文件 + desktop profile 的 `cordis.patch.yml`：记录路径、SHA-256、时间，备份名**不可覆盖**。
`mcp-launch.mjs` 首次部署时生产上没有前像，记为「新增」（回退 = 删除它）。

### 3. 整体替换 + 逐文件比对

四份文件一次性替换（`mcp-launch.mjs` 为新增），逐个与规范库比对 SHA-256（**只作辅助证据**）。

### 4. 新进程加载证据（v3.1 按 codex 意见纠正）

文件哈希**不能**证明旧进程已切换；**`postmaster.log` 也不能** —— 它的 run 行**不带 plugin 来源**，
无法区分「Windows 计划任务」与「dsh 插件」跑的轮次。

正确的证据链（逐项记录）：

| 证据 | 位置 / 内容 |
|---|---|
| 插件日志 | `DSH_HOME/localpost-postmaster/plugin.log`（可能被 config 的 `logFile` 覆盖）；源码写的启动行是 `run(startup)` |
| 进程身份 | 新 DSH PID 与启动时间；两层 MCP 进程（dsh → node `mcp-launch.mjs` → node `mcp-server.mjs`）各自的 PID 与启动时间。server 的 PID 见启动层的 `[mcp-launch] server pid=… entry=…` 一行 |
| 实际入口 | 启动层 `.mailbox/mcp-launch.mjs`；server `.mailbox/mcp-server.mjs`（以启动层报告行里的 `entry=` 为准） |
| 实收环境 | server 自报的 `[mailbox-mcp] env names: …` 一行（只有名字）：必须是允许表的子集，见 §二.2 |
| 代码身份 | 目标文件 SHA-256 + 目标 commit |
| 行为验证 | `initialize` 的身份说明、跨身份拒绝、以及一项**新行为**测试 |

⚠️ MCP 的 `[mailbox-mcp] ready` **只证明启动，不证明版本**。
⚠️ 记录证据时**不要**打印完整环境或带 token 的命令行。

### 5. 不需要重建账本

内核本身未改动，**不重建账本、不重做迁移**。

### 6. 调度恢复与失败路径（v3.1 新增，codex 要求）

**记录的是设置值，不是瞬时状态**：记下两个任务部署前的 `enabled/disabled`（**不要**拿 Running 状态当恢复配置）。

- **成功路径**：先验证新服务/内核确实在工作（§一.4 证据链），**然后**才恢复原本 enabled 的任务；
  原本 disabled 的**保持 disabled**，不要"顺便打开"
- **失败路径**：停服务 → 恢复三份文件并删除新增的 `mcp-launch.mjs` **+ 撤销本次 profile 补丁** → **校验恢复后哈希** → 再恢复原调度
- **回退验证也失败时**：**保持停写并报告**，不允许在半部署状态下自动重启/自动恢复调度

## 二、注册 MCP

### 1. 配置追加（v3.2：入口改为启动层，env 新增三项）

`~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加：

```yaml
# LocalPost 信箱 MCP（身份绑定 dsh，人工模式，7 个工具）。回退：删掉这一整段 insert，重启 dsh。
- insert:
    - id: localpost-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: localpost
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'
        args:
          - 'C:/AI_ASSIST/.mailbox/mcp-launch.mjs'
        env:
          MAILBOX_ROOT: 'C:/AI_ASSIST/.mailbox'
          MAILBOX_IDENTITY: dsh
          MAILBOX_ADMIN: '0'
          # 由 dsh 在建进程前覆盖为空：这两个变量会让 node 在启动层代码之前加载外部代码（实测，见 docs/mcp-launch.md）。
          # 不为空时启动层拒绝启动（退出码 2）。
          NODE_OPTIONS: ''
          OPENSSL_CONF: ''
          # 启动层写 server 的 pid 和入口，server 自报实际收到的变量名（只写名字）。验收时必须开，之后可以常开。
          MAILBOX_ENV_REPORT: '1'
        failOnStartupError: false
```

- **入口是启动层 `mcp-launch.mjs`**（v3.2）。直接指向 `mcp-server.mjs` 会绕过启动层，server 就会拿到 dsh 过滤后的完整环境
- `NODE_OPTIONS` / `OPENSSL_CONF` 要用全大写写在 env 里：实测父环境里即使有小写的 `node_options`，这里全大写的空值也会生效
  （测试覆盖；原因据 Node 的实现是同名变量只保留按排序最靠前的一个，见 `docs/mcp-launch.md` §三.4）
- 只用 `dsh-mcp-client` 已有配置项，不臆造字段（`env` 是已有字段；dsh 的 `buildChildEnv` 是 `{...过滤后的父环境, ...config.env}`，npm 版与桌面版相同）
- 人工模式**不设** `MAILBOX_TOOLS`（保留 `mailbox_send`）。
  ⚠️ 注意：**显式设成空字符串会 fail closed（退出 2）**，不是"回到默认"—— 本轮已修（v2 时代的 fail-open 已消除）
- 将来开放自动处理时，另起一个设了 `MAILBOX_TOOLS`（**不含 `mailbox_send`**）的部署
- 追加后用 js-yaml 校验：只新增一项，其余不变

### 2. 最小环境（v3.2：由启动层落实，分两层如实写）

YAML 里写的几项 **不等于** 其它继承变量已被移除：dsh 只按名字过滤，启动层仍会收到 dsh 过滤后的完整环境。v3.2 的做法：

1. **server 这一层**：启动层只按允许表把变量交给 server —— `SystemRoot` + `MAILBOX_ROOT` / `MAILBOX_IDENTITY` /
   `MAILBOX_ADMIN` / `MAILBOX_TOOLS` / `MAILBOX_ENV_REPORT`（名字不区分大小写；实测 `SystemRoot` 是 node 能启动的唯一必需系统变量）。
   测试覆盖了能绕过 dsh 过滤的探针，以及 Node 在 Windows 上会把 PATH 等变量补回子进程的路径
2. **启动层这一层**：它的环境由 dsh 决定。`NODE_OPTIONS`、`OPENSSL_CONF` 会让 node 在启动层代码之前加载外部代码，
   必须由 dsh 覆盖为空（§二.1）；启动层再查一遍，不为空就拒绝启动。**这只能事后发现**，已经执行的预加载收不回来。
   其它 Node 启动期变量本轮没有逐一实测；要彻底消除这一类，只能换成不受 Node 环境影响的启动边界（待用户决定，见 `docs/mcp-launch.md`）
3. **真实宿主上以 server 自报为准**：dsh 的 MCP 日志里那行 `[mailbox-mcp] env names: …` 必须是允许表的子集，
   **出现表外名字就停止接入**，不能拿“核对过”当“已经剔除”；静态核查不能代替这一步。**不读取、不回显任何秘密值**
4. 只使用客户端**已支持**的配置项，不臆造字段
5. 核对人工模式的 **`MAILBOX_TOOLS` 最终继承状态**：人工端如不设，应确认"未设置"确实成立（启动层只转交 dsh 给它的值，不会凭空添加）；
   自动端必须**显式限制**（且不含 `mailbox_send`）。经过启动层后，取值和权限语义不变（已测）
6. 记住本轮修过的行为：**显式空串 = fail closed（退出 2）**，不是"回到默认"；经过启动层后仍然如此（已测）

### 3. 连接失败必须可见且阻断依赖能力

`failOnStartupError: false` 只保证 dsh 能启动。**工具缺失 = 故障**，必须告警；依赖该服务的自动能力保持禁用；
**不允许**悄悄退回"直接写文件"的老路。

### 4. 可信代码核查（codex 要求）

- 脚本路径与依赖**固定**（入口 `C:/AI_ASSIST/.mailbox/mcp-launch.mjs`，它只启动同目录的 `mcp-server.mjs` 及其同目录模块），不被模型改写
- 部署前只读核对并记录（v3.2）：
  - `.mailbox` 目录和四个文件的 ACL：谁能写，谁能删除或改名（替换文件需要目录上的删除/改名权限）；模型不得有改写或替换权限
  - 四个文件和所在目录都**不是**重解析点（符号链接、junction 等）
  - 命令示例：`Get-Acl <路径> | Format-List`；`(Get-Item <路径> -Force).Attributes -band [IO.FileAttributes]::ReparsePoint`，期望结果为 0
- 用户 token **不保证**能 override 显式拒绝的 ACL；真实操作失败时**不自动改 ACL**，只报告
- 部分失败的故障注入只在**副本**上做，不在生产制造

## 三、验证顺序

1. **身份绑定证据（不是 roster）**：
   - 读 `initialize` 返回的 `instructions`，确认其中 identity 为 `dsh`
   - 做**跨身份负向请求**（例如以 dsh 身份去归档/读取别人的信）必须被拒
   - `mailbox_roster` 只作辅助（它只列 agents 与数量，**不是**绑定证据）
2. **环境证据（v3.2）**：dsh 的 MCP 日志里，server 自报的 `[mailbox-mcp] env names: …` 是允许表的子集，
   启动层 `[mcp-launch] server pid=… entry=…` 的入口是 `.mailbox/mcp-server.mjs`。**出现表外名字就停止接入**
3. **只读**：工具列表出现 `mcp__localpost__mailbox_*`（宿主按 `mcp__<serverName>__<tool>` 注册，以真实宿主的工具列表为准）；调 `mailbox_rules` 能读到唯一源
4. **隔离测试信**：claude 用专门 thread 投 `mcptest-` 前缀的 task 给 dsh，验证：
   - 正向：`mailbox_reply`（completed）自动归档原信；`mailbox_archive` 重复调用幂等
   - 反向：归档 claude 的信被拒；逃逸 id 被拒
   - 部分失败：**生产不做**，以单元测试为准（已覆盖）
5. **孤儿进程检查（v3.2）**：正常退出 dsh 后查一次，在任务管理器里强制结束 dsh 后再查一次：
   `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -match 'mcp-(launch|server)\.mjs' | Select-Object ProcessId, CommandLine`
   （命令行里只有脚本路径，不含秘密）。期望无输出；**有残留就停止接入**，报告后再定。
   仓库测试只覆盖 Node 宿主，真实 dsh 以这一步为准
6. **最后才处理积压**：只归档 dsh **读过并向用户汇报过**的信，不按"共 N 封"盲搬

## 四、回退

1. 先停 MCP 与相关使用者（退出 dsh）
2. 只删掉本次追加的 `insert` 段；若期间无人改配置可恢复前像，**别人后来加的配置必须保留**
3. 服务文件恢复前像（同样先停写；首次部署新增的 `mcp-launch.mjs` 直接删除），重启
4. **不回退信件/回执/队列，不删已发出的回执**

## 不在本方案范围内

- receiver 试点、自动派发、GC `--apply`：均未获批
- 注册本 MCP **不等于** E 已通过，也**不等于**自动派发获批

## 五、发布清单与回滚证据链（v3.1 新增）

**一次部署 = 一个 release ID**，必须记录：

| 项 | 内容 |
|---|---|
| release ID | 日期 + 目标 commit（如 `rel-20261002-721e6ef`） |
| 源 commit | 规范库 main 的完整 SHA |
| 目标路径 | 四份服务文件（`mcp-launch.mjs` 首次为新增）+ 本次 profile 补丁 |
| before/after 哈希 | 每个文件的前像（新增的记为“无”）与替换后的 SHA-256 |
| 前像位置 | **不可覆盖**名（含时间戳），并记录其自身哈希 |
| profile | before/after 内容 + 追加的 insert ID；含秘密的原文只进私密备份，不进代码仓库 |
| 任务设置 | 两个任务部署前的 enabled/disabled |
| 执行者与批准范围 | 谁执行、用户批的是什么（写清楚边界） |
| 验证记录 | 命令、退出码、结果（§三 的每一项） |
| 新进程 | DSH、启动层、server 三个 PID 与启动时间 |

**先在隔离副本完整演练一遍**，并核对所有 after→before 哈希；生产只保留审核与结果记录。
manifest 属**私密运维证据**：不得含 raw token 或完整环境；公开代码只留净化摘要。

## 附：本轮代码修订

- `d466f05`（base `ad1a428`）：P1 白名单 fail-closed + P2 崩溃测试改落盘 fixture
- 验收：`node scripts/test.mjs` → 124/124 + 40/40，exit 0
- `af4bd58`（base `fb3ec71`）：受控启动层 `mcp-launch.mjs` + 测试；随后按 GPT 审核修订（与本方案 v3.2 同一提交，哈希见回执）
