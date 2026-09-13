# @dsh-external/dsh-localpost-postmaster

LocalPost **局长外壳**（子项目②）：给已经写好的局长内核套一层 dsh 插件。

内核（对账器）在 `C:/AI_ASSIST/.mailbox/postmaster.mjs`，本插件**不含任何业务逻辑**，只做三件事：

1. **定时器**：每 15 分钟（可配）调一次 `runOnce({ root })` —— 纯定时器，零 token。
2. **冒泡**：有告警就告诉用户。两条通道：
   - **A · ntfy 推送**（手机/桌面收推送，JSON publish，中文标题无编码坑）；
   - **D · Windows 桌面 toast**（`assets/toast.ps1`，**仅 error 级**才弹，避免 warn 级打断）。
   - 每轮只发**一条汇总**；新告警立即响，同一条 12 小时内不重复，`warn → error` 升级会再响一次。
   - 没有告警时**完全安静**（不刷屏）。
3. **`localpost_check` 工具**：对话里随时「查一下信箱」→ 真跑一轮并回报体检报告；
   本轮告警在对话里已回报，就不再多弹一次窗（但会记入冷却，避免随后重复响）。

另有自故障保护：内核 import 失败 / runOnce 抛错时，**连续 3 轮**才响一次「插件故障」，
任一轮成功即归零 —— 「没消息」和「没告警」必须能区分开。

还有**单例守卫**：热重载会让 `apply` 跑第二次，bundle 装配与运行时注入也可能同时命中同一个插件；
两个实例 = 两份定时器 = 同一告警弹两次。冒泡类插件绝不能重复响，所以新实例一律先把旧实例停掉
（`Symbol.for` + `globalThis` 跨模块实例共享，`ctx.on('dispose')` 兜底）。

## 硬约束（来自承接文档）

- **不 spawn 内核**：同语言同运行时，直接 `import(file://…)`。
- **不写 `ledger.json` / `alerts.json`**：唯一写者是内核，插件只读（离线自测里有一条断言守着）。
- **默认不开 LLM 循环**：定时器 + 读文件 = 零 token。
- **插件崩溃不影响内核**：内核同时挂在 Windows 计划任务上独立运行。

## 文件

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 插件主体（零依赖纯 ESM：定时器 + 工具 + 故障计数） |
| `lib/notify.js` | 通知通道（ntfy / toast）+ 冷却记忆 |
| `assets/toast.ps1` | 桌面 toast 脚本（ASCII-only：PS 5.1 读无 BOM 的 .ps1 按 ANSI，中文一律由参数传入） |
| `test/selftest.mjs` | 离线自测：25 项断言，改完插件先跑它，别拿真宿主当调试器 |
| `cordis.patch.yml` | bundle patch（写进 profile 的 `dsh.profile.bundles` 后由 loader 自动装配） |

**为什么是纯 JS 而不是 TS**：本机没有 dsh 源码 checkout（`DSH_CHECKOUT` 未设、常见路径不存在），
脚手架生成的 `tsc` 构建路径走不通；零依赖直挂 `lib/` 反而更少出错面、热重载更快。

## 配置（全部有默认值，改了才需要在 row 的 `config` 里写）

| 键 | 默认 | 说明 |
|---|---|---|
| `root` | `C:/AI_ASSIST/.mailbox` | 信箱根目录 |
| `kernelPath` | `<root>/postmaster.mjs` | 内核文件路径 |
| `intervalMinutes` | `15` | 定时器间隔（支持小数，验收时可临时调 0.1） |
| `startupDelayMs` | `3000` | 加载后首次检查的延迟（DSH 一开就先查一次） |
| `cooldownHours` | `12` | 同一告警重复提醒的冷却 |
| `selfFailThreshold` | `3` | 连续失败几轮才报「插件故障」 |
| `ntfyEnabled` / `ntfyServer` / `ntfyTopic` | `on` / `https://ntfy.sh` / `dsh-ysiqnef3w9j7lz` | 通道 A（与 `ntfy-notify` 同一 topic） |
| `toastEnabled` / `toastScriptPath` | `on` / `<包>/assets/toast.ps1` | 通道 D |
| `stateFile` | `%DSH_HOME%/.dsh/localpost-postmaster/state.json` | 冷却状态（原子写，损坏即当空状态） |
| `logFile` | `%DSH_HOME%/.dsh/localpost-postmaster/plugin.log` | 插件日志（超 256KB 转 `.1`） |

## 自测（改代码后必跑）

```powershell
node C:\AI_ASSIST\tools\dsh-localpost-postmaster\test\selftest.mjs
```

在临时目录里造 fixture 信箱 + 起一个本地假 ntfy 服务器，断言 25 项：工具注册形状、
手动查（suppress 语义）、定时器新告警冒泡、冷却去重、告警消失后状态清理、dry-run 不写盘、
内核缺失的可诊断文案、单例守卫、以及「内核 ledger.json 没被插件改写」。
在受限沙箱里跑时，toast 分支会以 `spawn EPERM` 失败——那是沙箱拦了管道，属预期；
宿主进程里应为 `toast 已弹出`。

## 运维

```powershell
# 手动跑内核（插件不在也不影响这一条）
node C:\AI_ASSIST\.mailbox\postmaster.mjs

# 看插件日志
Get-Content "$env:USERPROFILE\.dsh\localpost-postmaster\plugin.log" -Tail 20

# 热注入 / 卸载（免重启）
#   dev_inject_plugin   { dir: "C:/AI_ASSIST/tools/dsh-localpost-postmaster" }
#   dev_uninject_plugin { match: "dsh-localpost-postmaster" }
```

## 已知边界（不试图解决）

- 正在跑的一轮 LLM 对话**无法被外部打断**：冒泡只能在下一轮或宿主事件里出现。
- DSH 宿主进程不在时（退出/未启动），定时器与两条通道都不工作；此时告警只落到
  `alerts.json`，下次 DSH 启动后 3 秒内的那次检查会补报。
- P1（ack 状态机 / 超时重投）不在本插件范围，内核 v0.1 只做 `sent → replied / overdue`。
