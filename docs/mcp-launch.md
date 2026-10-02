# MCP 受控启动层 `localpost/mcp-launch.mjs`（只在 worktree 实现和测试；未部署、未注册）

依据：`.mailbox/attachments/claude-codex-v3-1-followup-分析与方案-20261002.md` ①，codex 审核
`codex-v3-1-review-fb3ec71-7d-20261002.md` §二，以及 GPT 对 `af4bd58` 的审核（三项阻塞 + 四项次要，本版已修订）。
部署、注册、真实宿主验收都要用户另行批准。注册与部署步骤见方案 `docs/mcp-registration-plan-v3.md` v3.2。

## 一、它做什么，边界在哪

宿主（dsh）注册的入口是本文件。它按顺序做这些事：

1. 检查 `NODE_OPTIONS`、`OPENSSL_CONF` 是否为空，不为空就拒绝启动（退出码 2，原因见 §三.3）；
2. 从自己的环境里取出允许表中的变量，然后清空自己的环境（原因见 §三.1）；
3. 用 `process.execPath` 启动**同目录固定**的 `mcp-server.mjs`：不接受参数或路径覆盖，`stdio` 原样交给 server，`windowsHide`，显式 `detached: false`；
4. 原样透传 server 的退出码（被信号结束时为 1）；自身配置错误时退出码为 2。

**边界（如实写）**：

- 启动层**自己仍拿到 dsh 传来的完整环境**，也就是 dsh 只按名字过滤后剩下的一切。隔离的**只是它再启动的 server 进程**。
  准确的说法是「**server 进程只收到允许表里的变量名**」（已测，server 会自报）；**不能**写成「MCP 子进程环境严格隔离」。
- `NODE_OPTIONS`（`--require` / `--import`）和 `OPENSSL_CONF`（配置文件里的 provider 模块）会让 node 在启动层代码运行**之前**
  就加载外部代码，启动层自己挡不住（GPT 实际复现过，本仓库测试也复现了）。所以必须由 **dsh 在建进程前把它们覆盖为空**：
  注册配置的 `env` 里写成 `''`。启动层再查一遍，不为空就拒绝启动，但这**只能事后发现**，已经执行的预加载收不回来。
- node.exe 启动时还会读其它环境变量。`node --help` 列出的清单并不完整（里面连 `NODE_OPTIONS`、`OPENSSL_CONF` 都没有），
  本轮只实测了这两个。要彻底消除「启动边界受 Node 环境影响」这一类风险，只能换成不受 Node 环境影响的启动边界，
  比如一个原生可执行文件（它还能显式创建 Job Object）。这需要引入编译产物和构建链，**本轮没做，待用户决定**。

## 二、允许表

| 变量 | 为什么给 |
|---|---|
| `SystemRoot` | 没有它 node 启动即崩溃（实测，§三.2） |
| `MAILBOX_ROOT` `MAILBOX_IDENTITY` `MAILBOX_ADMIN` `MAILBOX_TOOLS` | server 的配置；取值和权限语义经过启动层后不变（已测） |
| `MAILBOX_ENV_REPORT` | 设为 `1` 时，server 自报实际收到的变量名（只写名字） |

- 按 Windows 的语义取值，名字不区分大小写（`mailbox_identity`、`mailbox_tools` 都能取到），交给 server 时统一成表中的写法。
- 显式设成空串的变量照传：`MAILBOX_TOOLS=''` 经过启动层后仍然 fail closed（退出码 2）。
- 相对分析稿，系统变量从 5 个收窄到 1 个；另外加了 `MAILBOX_ENV_REPORT`，用来让 server 自报（GPT 次要项 4）。

## 三、实测事实（node v24.15.0 / Windows 11，2026-10-02）

复现：`node scripts/measure-mcp-env.mjs`（第 1、2、3 条都在里面）

1. **只给 spawn 一个干净的 env 对象不够。** 父进程环境还在时，只传 `MAILBOX_IDENTITY` 的子进程实际收到了
   `HOMEDRIVE, HOMEPATH, LOGONSERVER, MAILBOX_IDENTITY, PATH, SYSTEMDRIVE, SYSTEMROOT, TEMP, USERDOMAIN, USERNAME, USERPROFILE, WINDIR`。
   Node（libuv）会把父进程的这 11 个变量补进子进程，所以启动层必须先清空自己的环境。
2. **最小系统变量。** 清空父进程环境后，只给 `SystemRoot` + MAILBOX_* 时，握手和 7 个工具全部成功（9/9）；
   不给 `SystemRoot`（或只给 `windir`）时 node 启动即崩溃（`ncrypto::CSPRNG` 断言，退出码 134）；
   windir、SystemDrive、TEMP、TMP 都不是必需的。
3. **代码加载类变量：**

   | 变量 | node 退出码 | 主模块运行 | 预加载运行 |
   |---|---|---|---|
   | `NODE_OPTIONS=--require=<预加载>` | 0 | 是 | **是**（在主模块之前） |
   | `NODE_OPTIONS=''`（注册配置覆盖为空） | 0 | 是 | 否 |
   | `OPENSSL_CONF=<激活 provider 模块的配置>` | 134 | 否 | — |
   | `OPENSSL_CONF=''`（注册配置覆盖为空） | 0 | 是 | — |

   OPENSSL_CONF 那一行，配置里的 provider 模块指向一个不存在的 DLL，node 在启动阶段就去处理它并因此崩溃。
   说明这个 DLL 如果存在，就会在我们的代码运行之前被加载。注意 Node 默认读的是配置文件里的 `nodejs_conf` 段，不是 `openssl_conf` 段。
4. **dsh 的环境构造**（静态核对，npm 版 dsh 0.1.5-rc.1 与桌面版 `app.asar` 2026-09-29 构建相同）：
   - 过滤规则：变量名匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 或以 `DSH_` 开头的被剔除，其余全部传下去；
   - `buildChildEnv` 是 `{...过滤后的父环境, ...config.env}`，所以注册配置里的空串会覆盖父环境里的同名变量；
   - 父环境里有小写的 `node_options` 时，注册配置里全大写的 `NODE_OPTIONS: ''` 仍然生效（测试 6 实测）。
     原因据 Node 的实现：在 Windows 上启动子进程时，只差大小写的同名变量只保留按排序最靠前的一个，而全大写总是排在最前（这一点没有读源码核对）。
5. **SDK 的关闭顺序**（静态核对，`@modelcontextprotocol/sdk` 1.30.0）：先 `stdin.end()`，再 `kill('SIGTERM')`，最后 `kill('SIGKILL')`。
   在 Windows 上，后两步都是 TerminateProcess，被结束的进程来不及运行任何 JS。

## 四、server 随启动层结束：三条互相独立的路径（GPT 阻塞项 3）

| # | 路径 | 覆盖的情形 | 单独验证的方法 |
|---|---|---|---|
| 1 | 非 detached 启动（Node 文档：Windows 上只有 detached 的子进程能在父进程退出后继续运行） | 启动层被 TerminateProcess、崩溃 | 假 server 收到 EOF 也不退出、启动层被硬杀时 'exit' 处理来不及运行，此时 server 仍在 5 秒内结束 |
| 2 | 启动层的 `'exit'` 处理里先结束 server | 启动层因 JS 异常退出 | 用故障注入去掉路径 1（改成 detached），再让启动层抛出未捕获异常：server 仍被结束 |
| 3 | 宿主（Node 的 ChildProcess）在启动层退出时关掉 stdin，真实 server 读到 EOF 后自行退出 | 前两条都失效时 | 去掉路径 1，并且硬杀启动层（路径 2 不会运行）：真实 server 仍然退出 |

另外还有一项**宿主崩溃链**测试：假宿主像 SDK 那样启动启动层，测试把假宿主硬杀，启动层和 server 都在 5 秒内结束。

**没有做到的**：本仓库只能证明 Node 宿主下的行为。真实 dsh 会不会留下孤儿进程，要以真实宿主验收为准（§六第 2 步）。
路径 1 依赖的 Job Object 是 Node（libuv）内部创建的，启动层没有自己调用 Win32 API 去建；纯 Node 做不到这一点。
要显式创建 Job Object，就需要 §一 最后提到的原生启动边界。

## 五、测试（`localpost/mcp-launch.test.mjs`，10 项；都是真实子进程，fixture 都是落盘文件）

| # | 测什么 |
|---|---|
| 1 | server 收到的名字**恰好**是 `MAILBOX_ENV_REPORT, MAILBOX_IDENTITY, MAILBOX_ROOT, MAILBOX_TOOLS, SystemRoot`。探针有两类，名字都能通过 dsh 的过滤：一类是额外注入的 `MY_PASSPHRASE`、`HTTPS_PROXY`、`http_proxy`、`OPENAI_ORG`；另一类是完整环境本来就带的 `PATH`、`USERPROFILE`、`TEMP` 等。小写名已统一写法，空串照传，报告行不含任何值 |
| 2 | 真实 server 经启动层完成握手，7 个工具各调一次全部成功；server 自报的名字**恰好**是 `MAILBOX_ENV_REPORT,MAILBOX_IDENTITY,MAILBOX_ROOT,SystemRoot` |
| 3 | 退出码 2 透传：`MAILBOX_TOOLS=''`、未绑定身份、给启动层传多余参数（这一种 server 根本不会启动） |
| 4 | 其它退出码透传（server 以 7 退出，启动层也以 7 退出） |
| 5 | `MAILBOX_ADMIN` / 非空 `MAILBOX_TOOLS` 的取值与权限语义：限制名单只暴露两个工具，直接调 `mailbox_send` 被拒；`MAILBOX_ADMIN='0'` 加身份时仍是绑定模式，跨身份操作被拒；`'1'` 且不绑定身份时是管理员模式；`'0'` 且不绑定身份时拒绝启动 |
| 6 | `NODE_OPTIONS`、`OPENSSL_CONF` 不为空时拒绝启动，server 不启动；同时断言预加载**已经执行过**（启动层挡不住）。父环境里有小写的 `node_options` 预加载，但注册配置把它覆盖为空后，预加载不再执行，server 正常工作 |
| 7–9 | §四 的三条路径，每次只留一条单独验证 |
| 10 | 宿主崩溃链 |

**变异检验**（人工跑过，脚本没有提交）：以下八种改法，每一种都会让对应的测试失败。

| 改法 | 失败的测试 |
|---|---|
| 不清空自身环境 | 1、2 |
| 允许表去掉 SystemRoot | 全部 |
| 改成 detached | 7、10（8、9 因为找不到注入点也会失败） |
| 把空串当成未设置 | 1、3 |
| 去掉代码加载变量检查 | 6 |
| 去掉 `'exit'` 清理 | 8 |
| 不透传退出码 | 3、4、5 |
| server 不自报 | 2 |

## 六、真实宿主验收（需要用户批准；方案 v3.2 §三）

1. **环境证据**：dsh 的 MCP 日志里有一行 `[mailbox-mcp] env names: …`，它由 server 自己输出，记录的是**实际收到**的名字。
   这些名字必须都在允许表里，**出现表外名字就停止接入**。启动层另写一行 `[mcp-launch] server pid=… entry=…`，作为进程身份证据。
2. **孤儿进程检查**：正常退出 dsh 后查一次，在任务管理器里强制结束 dsh 后再查一次，都不得残留 `mcp-launch.mjs` 或 `mcp-server.mjs` 的 node 进程。
   查询命令见方案 §三.5。**有残留就停止接入。**
3. **部署前只读核对**：`.mailbox` 目录和四个文件的 ACL（谁能写、删除、改名），以及它们都不是重解析点。见方案 §二.4。
