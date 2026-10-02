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
>
> **v3.2 收口（2026-10-02，claude，按 codex `codex-20261002-claude-v3-2-ops-closure`）**：① 前置条件新增「用户批准清单」和「执行边界」两项；
> ② §二.4 扩成可信基核对，附 2026-10-02 只读实测的基线与 ACL 现状；③ §三.5 改为两轮、按 PID 加创建时间判断的宿主退出验收；
> ④ §一.2 与 §四 的回退改为先核对漂移；⑤ 标签纠正记录写在 `docs/releases.md`。

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
2. **用户批准**：按下方「用户批准清单」逐项批准（可以合并成一次，但范围必须覆盖实际动作）。
3. **执行边界已定**：用户就 §二.4 的执行边界做出选择并批准实施，或者书面接受当前风险。**没有这一步，不开试点。**
4. **现场状态现查**，不沿用旧数字：dsh 收件箱积压、有无 dsh / receiver / MCP 进程、有无残留锁。

### 用户批准清单（v3.2 收口：批准范围必须覆盖实际动作）

| # | 动作 | 对应章节 |
|---|---|---|
| 1 | 暂停 `LocalPostPostmaster`、`LocalPostGC` 两个计划任务，事后按原设置恢复 | §一.1、§一.6 |
| 2 | 退出与重启 DSH；停止其它写者（receiver、直接 import `mailbox.mjs` 的脚本） | §一.1 |
| 3 | 备份四份服务文件和 desktop profile 的前像；失败时按 §四 恢复 | §一.2、§四 |
| 4 | 部署四份服务文件，并在 desktop profile 追加 `localpost-mcp` 这一条 insert | §一.3、§二.1 |
| 5 | 创建专用测试信（`mcptest-` 前缀），执行读取、回复、归档、跨身份拒绝和幂等检查 | §三.4 |
| 6 | 两轮宿主退出验收：一轮正常退出 DSH，一轮强制结束 DSH | §三.5 |
| 7 | 部署前、部署后的只读核对（哈希、版本、ACL、重解析点） | §二.4 |

**不在批准范围内（需要时另行批准）**：处理真实积压信件；开启 receiver 或自动派发；执行 GC `--apply`；
修改任何 ACL（核对发现问题只报告，不自动收紧或放宽）；标签操作（归 DSH，见 `docs/releases.md`）。

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
**部署前先确认 `mcp-launch.mjs` 是否已经存在**：不存在就记为「新增」，回退时删除它；已经存在就按普通文件保存前像，
回退时恢复前像。不能固定假设「新增后直接删除」。

### 3. 整体替换 + 逐文件比对

四份文件一次性替换（`mcp-launch.mjs` 按 §一.2 的结论处理），逐个与规范库比对 SHA-256（**只作辅助证据**）。

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
- **失败路径**：停服务 → **先核对当前内容仍是本次 release 的 after 状态**（§四.2）→ 按 §四 恢复四份文件 **+ 撤销本次 profile 补丁** → **校验恢复后哈希** → 再恢复原调度
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

### 4. 可信基核对与执行边界（v3.2 收口；codex 要求）

脚本路径与依赖**固定**：入口 `C:/AI_ASSIST/.mailbox/mcp-launch.mjs`，它只启动同目录的 `mcp-server.mjs` 及其同目录模块。

**部署前、部署后各做一遍只读核对**，结果写进 §五 的发布 manifest。不读取、不回显任何秘密值。
**任何一项和记录不符（漂移）就停止**，不自动收紧或放宽 ACL。

| 对象 | 要记录的内容 |
|---|---|
| `.mailbox` 目录 + 四份服务文件 | 精确路径、SHA-256、ACL（谁能写；谁能删除或改名 —— 替换文件要用到目录上的删除/改名权限）、是否重解析点 |
| desktop profile `C:\Users\16548\.dsh\profiles\desktop\cordis.patch.yml` 及其目录 | 精确路径、before/after SHA-256、ACL、是否重解析点、本次 insert ID（`localpost-mcp`）；核对这一条的 `args` 仍指向 `mcp-launch.mjs`，env 里 `NODE_OPTIONS` / `OPENSSL_CONF` 仍是 `''` |
| `node.exe` | 解析后的路径、版本、SHA-256、ACL、是否重解析点 |
| 桌面版 DSH | `DeepSeek Harness.exe` 的版本、`resources\app.asar` 的 SHA-256。§二.1 / §二.2 依赖的 `buildChildEnv` 与过滤规则是在下表这个版本上静态核对的，哈希变了就要重新核对 |

命令示例：`Get-FileHash <路径> -Algorithm SHA256`；`icacls <路径>`；
`(Get-Item <路径> -Force).Attributes -band [IO.FileAttributes]::ReparsePoint`，期望结果为 0。

**2026-10-02 只读实测的基线**（部署时要重新测；不一致先查明原因）：

| 对象 | 值 |
|---|---|
| `node.exe` | `C:\Program Files\nodejs\node.exe`（PATH 解析到的也是它），24.15.0，不是重解析点，SHA-256 `3331E1FFE19874215472217C5E94F5A0C6D8E18C4AC7111D3937AA0AD5E9B4A5`；ACL：只有 Administrators / SYSTEM 能改 |
| 桌面版 DSH | DeepSeek Harness 0.2.0-rc.2；`app.asar` 121,348,951 字节，2026-09-29 11:34，SHA-256 `983CA71114E6DFD353FC79AF5A1F9481A250EE64C2A3C757673029B811B23BC2` |
| npm 版 dsh（对照） | 0.1.5-rc.1；`dsh-mcp-client` / `dsh-subprocess` 同为 0.1.5-rc.1，`lib/index.js` SHA-256 分别为 `45D018FC0D57B4EFBE950BCA6E02ADC2765E8B7AA74F7CF322F7267C1511D6E5`、`DEB2D485FADBB28707AA5AA7FBCA0FC89DDB247B5A32D71782F78A9BF258E766` |
| profile | 上述路径存在，不是重解析点 |

**ACL 现状与真正的执行边界（2026-10-02 用 `icacls` 只读实测，如实写）**：

- `.mailbox` 及其中的服务文件继承 `C:\AI_ASSIST` 的 ACL。以下主体都有修改权限：
  - `CodexSandboxUsers`，组员是 `CodexSandboxOffline` / `CodexSandboxOnline`，为 Modify；
  - 两个解析不出名字的 SID（`S-1-5-21-1920298460-…-2774449718`、`S-1-5-21-453586369-…-4041696719`），为 Modify；
  - dsh 沙箱的写 SID `S-1-4-653368769-522399837`，为 W,D,DC；
  - `Authenticated Users`，为 Modify。

  根目录还带 Low 完整性标签 `(OI)(CI)(NW)`，会被继承下来。
- profile 目录和 `cordis.patch.yml` 上，另一个写 SID `S-1-4-529685576-412677121` 有 W,D,DC 权限，来源未确认。
- **结论**：「模型不得改服务文件 / profile」**目前在操作系统这一层并不成立**。
  - codex 的沙箱用户和 dsh 沙箱都能改服务代码，有的沙箱主体还能改注册配置，比如改成直启 `mcp-server.mjs`，或者重新注入代码加载变量。
  - 用户本人、不进沙箱的 agent 和部署者用的是**同一个 Windows token**，ACL 也无法按「是不是模型」来区分。
  - 现在真正起作用的只有工具层的约束（Claude Code 的权限确认 / 自动模式分类器、各 agent 的规则）和用户的逐项批准。
- **试点前由用户选择执行边界**（前置条件 3；这里只是方案，实施要另行批准）：
  - **A. 提权部署**：把服务文件放到只有 Administrators 能写的位置，部署者是用户本人，通过提权执行。不提权的进程（包括所有模型）都改不了。
    代价：内核也 import `fs-safe.mjs`，位置变化的影响要由 dsh 评估。
  - **B. 原位收紧 ACL**：四份文件和 profile 断开继承，去掉沙箱主体和 `Authenticated Users` 的写权限，去掉 Low 标签。
    这样能挡住沙箱，**挡不住**和用户同 token、不进沙箱的进程。
  - **C. 书面接受当前风险**：写进发布记录，靠工具层约束。
- 两个 `S-1-5-21-…` SID 和 `S-1-4-529685576-412677121` 分别属于谁，要在试点前查明。
- 用户 token **不保证**能 override 显式拒绝的 ACL；真实操作失败时**不自动改 ACL**，只报告。
- 部分失败的故障注入只在**副本**上做，不在生产制造。

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
5. **宿主退出验收：两轮，按精确 PID 判断（v3.2 收口）**。正常退出和强制结束必须是**两个独立的生命周期**：
   - **第 1 轮**：启动 dsh，调用一次只读工具 `mcp__localpost__mailbox_rules`（显式触发 MCP），用下面的「记录」命令记下第 1 组三层进程和入口文件哈希。
     然后**正常退出** dsh，用「核对」命令确认第 1 组的启动层和 server 都已结束。
   - **第 2 轮**：重新启动 dsh，再次调用只读工具，记下**全新的**第 2 组三层进程。
     然后**只强制结束第 2 组里那个确切的 DSH PID**（`Stop-Process -Id <第 2 组 DSH PID> -Force`），再核对第 2 组的启动层和 server 都已结束，并且没有任何进程指向本次入口。
   - 「DSH PID」指启动层的父进程，即实际创建 MCP 子进程的那个 dsh 进程。启动层要按结构认定：命令行含入口，**并且**恰好有一个运行 `mcp-server.mjs` 的 node 子进程。
     只按名字或路径匹配会误认（演练时就把命令行里带入口路径的宿主也算了进去）。
   - **判断是否结束要同时看 PID 和创建时间**：同一个 PID 还在、但创建时间不同，说明 PID 被复用了，不算残留；PID 和创建时间都相同才是残留。
   - **任何残留都停止试点**：保持自动派发禁用，记录证据，按 §四 回退并上报；**不要处理真实积压信件**。
   - 仓库测试只覆盖 Node 宿主，真实 dsh 以这一步为准。下面的命令已在模拟进程树（假宿主 → 启动层 → server，强杀假宿主）上演练通过；
     命令行里只有脚本路径，不含秘密。

   ```powershell
   # 记录：在 dsh 已触发 MCP 后运行；把输出（PID、创建时间、入口）写进发布 manifest
   $launchRe = 'C:[\\/]AI_ASSIST[\\/]\.mailbox[\\/]mcp-launch\.mjs'
   $serverRe = 'C:[\\/]AI_ASSIST[\\/]\.mailbox[\\/]mcp-server\.mjs'
   $nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
   $launcher = @($nodes | Where-Object { $_.CommandLine -match $launchRe -and @($nodes | Where-Object ParentProcessId -eq $_.ProcessId | Where-Object CommandLine -match $serverRe).Count -eq 1 })
   if ($launcher.Count -ne 1) { throw "启动层应恰好一个，实际 $($launcher.Count) 个：停止，先查明" }
   $server = @($nodes | Where-Object ParentProcessId -eq $launcher[0].ProcessId | Where-Object CommandLine -match $serverRe)
   $dsh = Get-CimInstance Win32_Process -Filter "ProcessId=$($launcher[0].ParentProcessId)"
   $set = @($dsh) + $launcher + $server | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine
   $set | Format-List
   Get-FileHash 'C:\AI_ASSIST\.mailbox\mcp-launch.mjs', 'C:\AI_ASSIST\.mailbox\mcp-server.mjs' -Algorithm SHA256 | Select-Object Path, Hash

   # 核对：dsh 退出（或被强制结束）后运行；两行都应输出「无」/ 0
   $left = foreach ($p in $set) { $now = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ProcessId)"; if ($now -and $now.CreationDate -eq $p.CreationDate) { $p.ProcessId } }
   "残留（PID + 创建时间）：" + $(if ($left) { $left -join ', ' } else { '无' })
   "指向本次入口的 node 进程数：" + @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $launchRe -or $_.CommandLine -match $serverRe }).Count
   ```
6. **最后才处理积压**：只归档 dsh **读过并向用户汇报过**的信，不按"共 N 封"盲搬

## 四、回退（v3.2 收口：先核对漂移，不覆盖后来的合法修改）

1. 先停 MCP 与相关使用者（退出 dsh），停写方式同 §一.1
2. **恢复前先核对**：四份服务文件的当前 SHA-256 仍等于本次 release 记录的 after 哈希；
   profile 里仍是本次追加的 `localpost-mcp` insert，内容也和记录一致。**任何一项已经漂移，就停止自动恢复**，转人工协调，
   不能覆盖后来的合法修改
3. profile：只删掉本次追加的 `insert` 段，**别人后来加的配置必须保留**。只有核对确认期间无人改过，才可以整份恢复前像
4. 服务文件：按 §一.2 的前像恢复。`mcp-launch.mjs` 部署前不存在的就删除，部署前已存在的就恢复它的前像。
   恢复后校验哈希等于前像，然后重启
5. **不回退信件/回执/队列，不删已发出的回执**

## 不在本方案范围内

- receiver 试点、自动派发、GC `--apply`：均未获批
- 注册本 MCP **不等于** E 已通过，也**不等于**自动派发获批

## 五、发布清单与回滚证据链（v3.1 新增）

**一次部署 = 一个 release ID**，必须记录：

| 项 | 内容 |
|---|---|
| release ID | 日期 + 目标 commit（如 `rel-20261002-721e6ef`） |
| 源 commit | 规范库 main 的完整 SHA |
| 目标路径 | 四份服务文件（`mcp-launch.mjs` 部署前是否已存在，按 §一.2 记录）+ 本次 profile 补丁 |
| before/after 哈希 | 每个文件的前像（部署前不存在的记为“无”）与替换后的 SHA-256 |
| 可信基 | §二.4 各对象的路径、哈希、版本、ACL、重解析点，部署前、部署后各一份；任何一项漂移就停止 |
| 执行边界 | 用户在 §二.4 选的方案（A / B / C）和批准记录 |
| 宿主退出验收 | 两轮各三层进程的 PID、创建时间、入口和核对结果（§三.5） |
| 前像位置 | **不可覆盖**名（含时间戳），并记录其自身哈希 |
| profile | before/after 内容 + 追加的 insert ID；含秘密的原文只进私密备份，不进代码仓库 |
| 任务设置 | 两个任务部署前的 enabled/disabled |
| 执行者与批准范围 | 谁执行；用户按「用户批准清单」批准了哪几项（写清楚边界） |
| 验证记录 | 命令、退出码、结果（§三 的每一项） |
| 新进程 | DSH、启动层、server 三个 PID 与启动时间 |

**先在隔离副本完整演练一遍**，并核对所有 after→before 哈希；生产只保留审核与结果记录。
manifest 属**私密运维证据**：不得含 raw token 或完整环境；公开代码只留净化摘要。
manifest 只用**完整的 source SHA**，不引用误标的旧里程碑标签（纠正记录见 `docs/releases.md`）。

## 附：本轮代码修订

- `d466f05`（base `ad1a428`）：P1 白名单 fail-closed + P2 崩溃测试改落盘 fixture
- 验收：`node scripts/test.mjs` → 124/124 + 40/40，exit 0
- `af4bd58`（base `fb3ec71`）：受控启动层 `mcp-launch.mjs` + 测试
- `94e3223`：按 GPT 审 `af4bd58` 修订，方案升 v3.2；codex 复审结论为「代码可进 DSH 集成审查」（134/134 + 40/40）
- v3.2 收口（只改文档，哈希见回执）：用户批准清单、§二.4 可信基与执行边界、§三.5 两轮宿主验收、§四 回退核对，以及 `docs/releases.md`
