# MCP 受控启动层 `localpost/mcp-launch.mjs`（只在 worktree 实现和测试；未部署、未注册）

依据：`.mailbox/attachments/claude-codex-v3-1-followup-分析与方案-20261002.md` ①，以及 codex 审核
`codex-v3-1-review-fb3ec71-7d-20261002.md` §二。部署、注册、真实宿主验收都要用户另行批准。

## 一、它做什么，边界在哪

宿主（dsh）注册的入口改成本文件后，它按顺序做四件事：

1. 从自己的环境里取出允许表中的变量；
2. 清空自己的环境（原因见 §三.1）；
3. 用 `process.execPath` 启动**同目录固定**的 `mcp-server.mjs`：不接受参数或路径覆盖，`stdio` 原样交给 server，`windowsHide`；
4. 把 server 的退出码原样透传出去（被信号结束时退出码为 1）；它自己的配置错误退出码为 2。

**边界（如实写）**：启动层**自己仍拿到 dsh 传来的完整环境**，也就是 dsh 只按名字过滤后剩下的一切
（代理变量、PATH，以及 `NODE_OPTIONS` 这类会影响 node 自身启动的变量）。隔离的**只是它再启动的 server 进程**。

- 准确的说法是「**server 进程只收到允许表里的变量名**」（已测，见 §四）。
  **不能**写成「MCP 子进程环境严格隔离」：dsh 直接启动的那个子进程就是启动层，它的环境由 dsh 决定，本文件管不到。
- 例如 dsh 的环境里如果有 `NODE_OPTIONS`，它仍然会作用于启动层这个 node 进程；server 进程收不到它。

## 二、允许表

| 变量 | 为什么给 |
|---|---|
| `SystemRoot` | 没有它 node 启动即崩溃（实测，§三.2） |
| `MAILBOX_ROOT` `MAILBOX_IDENTITY` `MAILBOX_ADMIN` `MAILBOX_TOOLS` | server 的配置 |

- 按 Windows 的语义取值，名字不区分大小写（`mailbox_identity` 也能取到），交给 server 时统一成表中的写法。
- 显式设成空串的变量照传：`MAILBOX_TOOLS=''` 经过启动层后仍然 fail closed（退出码 2）。
- 相对分析稿的变化：系统变量从 5 个（SystemRoot、SystemDrive、windir、TEMP、TMP）**收窄到 1 个**。
  实测另外四个都不是必需的。允许表只收窄、没有新增，没有超出审核过的范围。

## 三、实测事实（node v24.15.0 / Windows 11，2026-10-02）

复现：`node scripts/measure-mcp-env.mjs`

1. **只给 spawn 一个干净的 env 对象不够。** 父进程环境还在时，只传 `MAILBOX_IDENTITY` 的子进程实际收到了
   `HOMEDRIVE, HOMEPATH, LOGONSERVER, MAILBOX_IDENTITY, PATH, SYSTEMDRIVE, SYSTEMROOT, TEMP, USERDOMAIN, USERNAME, USERPROFILE, WINDIR`。
   也就是说 Node（libuv）会把父进程的这 11 个变量补进子进程，所以启动层必须先清空自己的环境，再启动 server。
2. **最小系统变量。** 清空父进程环境后，按子集直接启动真实 server，跑握手和全部 7 个工具（9 个响应）：

   | 给的系统变量 | 子进程实际收到 | server 退出码 | 成功响应 |
   |---|---|---|---|
   | 无 | （node 崩溃：`ncrypto::CSPRNG` 断言） | 134 | 0/9 |
   | 只有 SystemRoot | MAILBOX_IDENTITY, MAILBOX_ROOT, SystemRoot | 0 | 9/9 |
   | 只有 windir | （node 崩溃） | 134 | 0/9 |
   | 五个全给 | 五个 + MAILBOX_* | 0 | 9/9 |
   | 五个去掉 SystemRoot | （node 崩溃） | 134 | 0/9 |
   | 五个去掉 SystemDrive / windir / TEMP / TMP 中任一个 | 对应四个 + MAILBOX_* | 0 | 9/9 |

3. **启动层被强制结束时 server 也会结束。** SDK 关闭时如果 `stdin.end()` 之后进程还没退出，就会调
   `kill('SIGTERM')` / `kill('SIGKILL')`，在 Windows 上就是 TerminateProcess。实测：
   - 普通启动（不加 `detached`）：server 被外部终止，它自己的退出钩子一个都没跑；
   - 对照组加了 `detached`：server 一直存活，只是 4ms 后收到了 stdin end。

   Node 文档写明，在 Windows 上 `detached: true` 才能让子进程在父进程退出后继续运行。
   一般认为这是因为 libuv 把非 detached 的子进程放进了退出即杀的 job object，但**本机没有读 libuv 源码核对**这一点。
4. **dsh 现有过滤**（静态核对）：npm 版 dsh-subprocess（dsh 0.1.5-rc.1）和桌面版 `app.asar`（2026-09-29 构建）
   用的规则相同：变量名匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 或以 `DSH_` 开头的被剔除，其余全部传下去。
   分析稿里「桌面版过滤规则未核对」这一项到此补上。
5. **SDK 的关闭顺序**（静态核对，`@modelcontextprotocol/sdk` 1.30.0）：先 `stdin.end()`，再 `kill('SIGTERM')`，最后 `kill('SIGKILL')`。
   第一步时 server 读到 EOF 就正常退出，启动层透传它的退出码；后两步对应第 3 条。

## 四、测试（`localpost/mcp-launch.test.mjs`，4 项；都是真实子进程，fixture 都是落盘文件）

| # | 测什么 | 怎么测 |
|---|---|---|
| 1 | server 只收到允许表里的名字 | 启动层和假 server（`fixtures/env-probe-server.mjs`）一起复制到临时目录。探针是 `MY_PASSPHRASE`、`HTTPS_PROXY`、`http_proxy`、`OPENAI_ORG`、`NODE_OPTIONS`，另外还有从完整环境带进来的 `PATH`、`USERPROFILE`、`TEMP` 等，这些名字都能通过 dsh 的过滤。断言 server 实际收到的名字**恰好**是 `MAILBOX_IDENTITY, MAILBOX_ROOT, MAILBOX_TOOLS, SystemRoot`（小写名已统一写法，空串也照传），报告行和实际收到的一致，且不含任何值 |
| 2 | 只有允许表时真实 server 能工作 | 带着探针经启动层启动真实 server：握手、`tools/list` 返回 7 个，7 个工具各调一次全部成功（包括生成 UUID 的投递、回执、幂等归档） |
| 3 | 退出码透传、fail closed 不被绕过 | `MAILBOX_TOOLS=''`、未绑定身份、给启动层传多余参数，三种情况退出码都是 2，stdout 为空；传参数时 server 根本不会启动 |
| 4 | 启动层被硬杀后 server 也结束 | 假 server 只认 `exit` 行，stdin 断开也不会自己退出。用 `kill()` 结束启动层后，server 的 pid 必须在 5 秒内消失 |

**变异检验**（人工跑过，脚本没有提交）：以下四种改法，每一种都会让对应的测试失败。

- 去掉「清空自身环境」→ 测试 1 失败（PATH 等变量回来了）
- 允许表去掉 SystemRoot → 4 项全部失败（node 起不来）
- 启动 server 时加 `detached: true` → 测试 4 失败
- 把空串当成未设置 → 测试 1、3 失败

## 五、真实宿主验收（需要用户批准；本提交没有执行）

1. 注册时在 env 里临时加上 `MAILBOX_ENV_REPORT: '1'`。启动层会往 stderr 写一行
   `[mcp-launch] server pid=… entry=… env=…`，其中只有变量**名**，不写任何值。
2. 在 dsh 的 MCP 日志里找到这一行，确认名字都在允许表里。**只要出现表外的名字就停止接入。**
3. 说明：这一行记录的是启动层交给 server 的变量名。它和 server 实际收到的名字一致，这一点**只在本机测试里验证过**（测试 1 比对了两者）。
   在真实宿主上，证据仍然是这一行加上行为验证（方案 v3.1 §三），静态核查不能代替。

## 六、对方案 v3.1 的影响（建议；是否并入由 dsh 决定，本提交没有改方案正文）

- §一：要部署的文件从 3 个变成 4 个，新增 `mcp-launch.mjs`。它只依赖 node 内置模块。
- §二.1：注册的 `args` 改成 `C:/AI_ASSIST/.mailbox/mcp-launch.mjs`，`command` 不变（仍是 node 的绝对路径；启动层用同一个 node 启动 server）。
- §二.2：「最小环境」可以改成：server 的环境由启动层按允许表构造（已测）；启动层自己的环境仍是 dsh 过滤后的完整环境（如实写）。
- §一.4：进程树变成 dsh → node（mcp-launch）→ node（mcp-server），所以要记录的是 server 那一层的 PID 和入口；验收时 `MAILBOX_ENV_REPORT` 那一行会给出这两项。

本提交**没有**做以下事情：合并到 main、改标签、部署、改 dsh 配置或重启 dsh、开人工试点或自动派发。
