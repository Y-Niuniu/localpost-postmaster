# 方案 v3：给 dsh 注册 LocalPost 信箱 MCP（取代 v2；待用户批准，未执行）

v2 见 `.mailbox/attachments/claude-dsh-mcp-registration-plan-v2-20261002.md`。
v3 按 codex 审核 `codex-review-ad1a428-20261002.md`「启用方案 v2：部署前须改」六条修订。
**本方案不是部署授权**；每一步写操作都要用户在聊天里批准。

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
2. **用户批准**（可合并为一次）：① 部署三份服务文件；② 注册 MCP 并重启 dsh。
3. **现场状态现查**，不沿用旧数字：dsh 收件箱积压、有无 dsh / receiver / MCP 进程、有无残留锁。

## 一、部署服务文件（`mailbox.mjs`、`mcp-server.mjs`、`fs-safe.mjs`）

三者属同一依赖图，**必须整体一起部署**。

### 1. 停写（**必须停，不是"避开时刻"**）

`fs-safe.mjs` 被内核、GC、MCP、receiver 以及任何直接 import 投信的脚本共享，所以：

1. **退出 dsh**（插件经内核间接 import `fs-safe.mjs`；dsh 活着就停不干净）
2. **禁用** `LocalPostPostmaster` 与 `LocalPostGC`（先记录原始 State）。
   ⚠️ **不能**用"部署不在它每 15 分钟运行时进行"替代 —— 错过补跑、手动触发、别的调用者都可能撞上
3. **等在途结束**：`.mailbox` 日志静默、`.postmaster.lock` / `.mailbox-write.lock` 均不存在
4. 确认没有别的使用者：正在跑的 MCP 服务、receiver、agent 用 node 直接调 `mailbox.mjs` 投信
5. **部署窗口内不投信**

### 2. 备份精确前像

三份服务文件 + desktop profile 的 `cordis.patch.yml`：记录路径、SHA-256、时间，备份名**不可覆盖**。

### 3. 整体替换 + 逐文件比对

三份文件一次性替换，逐个与规范库比对 SHA-256（**只作辅助证据**）。

### 4. 新进程加载证据（codex 要求）

文件哈希**不能**证明旧进程已切换。必须看到：

- dsh 重启后插件的**新一轮日志**（`postmaster.log` 里 plugin 来源的 run 行）
- MCP 子进程的**启动日志**（`[mailbox-mcp] ready`）与其实际继承环境
- 两者都指向新代码（例如新内核行为/新工具白名单生效）

### 5. 不需要重建账本

内核本身未改动，**不重建账本、不重做迁移**。

## 二、注册 MCP

### 1. 配置追加（相对 v2 无变化）

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
          - 'C:/AI_ASSIST/.mailbox/mcp-server.mjs'
        env:
          MAILBOX_ROOT: 'C:/AI_ASSIST/.mailbox'
          MAILBOX_IDENTITY: dsh
          MAILBOX_ADMIN: '0'
        failOnStartupError: false
```

- 只用 `dsh-mcp-client` 已有配置项，不臆造字段
- 人工模式**不设** `MAILBOX_TOOLS`（保留 `mailbox_send`）。
  ⚠️ 注意：**显式设成空字符串会 fail closed（退出 2）**，不是"回到默认"—— 本轮已修（v2 时代的 fail-open 已消除）
- 将来开放自动处理时，另起一个设了 `MAILBOX_TOOLS`（**不含 `mailbox_send`**）的部署
- 追加后用 js-yaml 校验：只新增一项，其余不变

### 2. 最小环境

子进程环境只保留必要变量（`MAILBOX_ROOT/IDENTITY/ADMIN`），不继承无关 token。

### 3. 连接失败必须可见且阻断依赖能力

`failOnStartupError: false` 只保证 dsh 能启动。**工具缺失 = 故障**，必须告警；依赖该服务的自动能力保持禁用；
**不允许**悄悄退回"直接写文件"的老路。

### 4. 可信代码核查（codex 要求）

- 脚本路径与依赖**固定**（`C:/AI_ASSIST/.mailbox/mcp-server.mjs` 及其同目录模块），不被模型改写
- 记录并核对文件权限（谁能写这三个文件）；模型不得有改写权限
- 用户 token **不保证**能 override 显式拒绝的 ACL；真实操作失败时**不自动改 ACL**，只报告
- 部分失败的故障注入只在**副本**上做，不在生产制造

## 三、验证顺序

1. **身份绑定证据（不是 roster）**：
   - 读 `initialize` 返回的 `instructions`，确认其中 identity 为 `dsh`
   - 做**跨身份负向请求**（例如以 dsh 身份去归档/读取别人的信）必须被拒
   - `mailbox_roster` 只作辅助（它只列 agents 与数量，**不是**绑定证据）
2. **只读**：工具列表出现 `localpost__mailbox_*`；调 `mailbox_rules` 能读到唯一源
3. **隔离测试信**：claude 用专门 thread 投 `mcptest-` 前缀的 task 给 dsh，验证：
   - 正向：`mailbox_reply`（completed）自动归档原信；`mailbox_archive` 重复调用幂等
   - 反向：归档 claude 的信被拒；逃逸 id 被拒
   - 部分失败：**生产不做**，以单元测试为准（已覆盖）
4. **最后才处理积压**：只归档 dsh **读过并向用户汇报过**的信，不按"共 N 封"盲搬

## 四、回退

1. 先停 MCP 与相关使用者（退出 dsh）
2. 只删掉本次追加的 `insert` 段；若期间无人改配置可恢复前像，**别人后来加的配置必须保留**
3. 服务文件恢复前像（同样先停写），重启
4. **不回退信件/回执/队列，不删已发出的回执**

## 不在本方案范围内

- receiver 试点、自动派发、GC `--apply`：均未获批
- 注册本 MCP **不等于** E 已通过，也**不等于**自动派发获批

## 附：本轮代码修订

- `d466f05`（base `ad1a428`）：P1 白名单 fail-closed + P2 崩溃测试改落盘 fixture
- 验收：`node scripts/test.mjs` → 124/124 + 40/40，exit 0
