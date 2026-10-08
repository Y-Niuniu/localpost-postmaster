# LocalPost：本地 AI Agent 通信与任务对账工具

[English](README.md) · [工程报告](docs/localpost_engineering_report_and_manual.zh-CN.md)

LocalPost 是一个用于本地多 AI Agent 协作的个人工程项目。它通过 JSON 信封和共享目录传递任务、回执与附件，由对账内核跟踪任务完成情况、超时及信封冲突。

核心使用 Node.js 内置模块，无第三方 npm 运行依赖，无需另外部署网络消息 Broker。项目面向同一设备上不同 AI 开发工具之间的协作。

## 我的角色与开发方式

我主要负责需求与架构设计，包括定义任务和回执的关系、划分模块职责，以及确定失败和不确定投递的处理原则。代码主要由 AI 编码代理生成与迭代。

项目展示我的需求分析、系统架构和组织 AI 辅助开发的实践，不将实现描述为完全由我手工编写。

## 主要功能

- 使用 `task`、`result`、`ping` 信封及附件引用传递任务和结果。
- 根据任务 ID、线程及收发双方匹配有效回执。
- 区分任务结束与等待用户授权，避免将非终态误记为完成。
- 使用文件租约与所有权检查协调受控写入。
- 为受管信件记录所有权和完成意图，核对重试的一致性。
- 明确报告“回执已发布，但原信归档尚未完成”等部分失败。
- 提供接收队列、保留期清理、备份校验及可选告警通知。

## 系统结构

| 组件 | 职责 |
|---|---|
| `localpost/fs-safe.mjs` | 路径检查、原子写入、租约与 Windows 瞬态错误重试 |
| `localpost/mailbox.mjs` | 受控投递、读取、申领、回执与归档 |
| `letter-claims.mjs`、`session-binding.mjs`、`rotation.mjs` | 受管所有权、会话绑定及分阶段交接 |
| `postmaster.mjs`、`receiver.mjs` | 对账、告警与接收队列 |
| `gc.mjs`、`mail-backup.mjs` | 保守清理、快照校验与隔离恢复 |
| `lib/`、`integrations/` | 宿主插件、MCP 接口与外部客户端桥 |

表中未写其他目录的模块位于 `localpost/`。受控接口将已投递信封作为不可变通信证据，账本和告警作为派生视图。不确定派发保留待核对状态，不盲目重投；宿主受理调用与模型完成任务是不同事实。

## 查看与测试

建议使用 Node.js 24，核心无需 `npm install`。

```sh
git clone https://github.com/Y-Niuniu/localpost-postmaster.git
cd localpost-postmaster
node scripts/test.mjs
```

测试入口使用隔离临时目录运行核心套件和旧插件自测。结果以实际输出为准；离线测试不等于所有客户端的生产验收。克隆或运行测试不会自动部署或启用模型唤醒。

## 工程文档与集成

- [完整工程报告、设计蓝图与操作指南](docs/localpost_engineering_report_and_manual.zh-CN.md)：基于 Gemini 初稿的审阅版，保留架构图，修正术语和运维建议。
- [模块集成](docs/integration.md)、[会话轮转](docs/rotation-decisions.md)、[备份恢复](docs/mail-backup.md)。
- [外部客户端集成](integrations/README.md)与[验证入口](integrations/verification/README.md)。
- [历史插件 README](docs/legacy-plugin-readme.md)：保留原配置说明，作为历史快照阅读。

部署需要明确选择邮箱根目录、身份、发件人白名单和目标会话。仓库保留核心与兼容 MCP 入口，两者的环境变量和读取/申领语义有所不同。

## 范围与限制

系统主要面向共享本地文件系统的多进程协作，不承诺跨主机一致性或端到端 exactly-once 执行。信封中的发件人字段不是密码学身份认证，可信边界仍依赖文件权限和受控接口。

自动唤醒取决于客户端及版本，需要单独验证。信件内容不构成用户授权。历史设计和部署记录应结合日期、版本及相应证据阅读。
