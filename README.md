# magpie-doubao-acp · 豆包 CLI · ACP

把豆包 CLI（doubao-cli）的 ACP agent 能力接入 magpie：豆包自主执行工具（读写文件、运行命令），
支持多轮会话续接、工具链实时呈现、并发调度。无需外置反代服务，凭据由豆包 CLI 自行保管。

## 安装

```bash
# 从 GitHub 安装
magpie.com plugin add github:zheng0625/magpie-doubao-acp

# 从本地源码安装
magpie.com plugin add D:\path\to\magpie-doubao-acp
```

依赖 `@bytedance/doubao-cli`（公开 npm 包）随插件安装。其 postinstall 按平台下载签名运行时；
magpie 宿主为 Bun，默认不执行未信任包的 postinstall——插件首次使用时会自检运行时
（`doubao --version`），缺失时自动补跑 `scripts/install.cjs`。

运行时要求：Windows 优先（trajectory 富化与内存 watchdog 依赖 Windows 路径/PowerShell）；
node 可选——无 node 时自动回退用宿主 Bun 运行 CLI 脚本。

## 登录 / 退出

magpie 账户设置里提供三个入口：

- **扫码登录豆包 CLI**：自动打开 `doubao login --qr=png` 生成的二维码图片，用豆包 App 扫码确认。
- **本机已登录，直接启用**：检测 `doubao auth status`，已登录则免密启用。
- **退出豆包 CLI 登录**：执行 `doubao logout`（会同时停止该账号下运行中的任务）。

凭据始终由豆包 CLI 管理（Windows DPAPI），插件不读取、不存储任何 CLI 账号凭据。
magpie 侧的账号移除用账号卡片自带的「退出」（magpie 原生 sign-out，插件无 logout hook）；
CLI 侧退出用上面的入口或终端 `doubao logout`。两者相互独立。

## 选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| 工具链实时呈现 | 开 | 工具开始和完成时推送进度。Codex 的 Responses 接口显示过程消息，Chat Completions 客户端接收 `reasoning_content` |
| 正文附工作流回顾 | 关 | 开启后在最终回复末尾附加工具链列表 |
| 转发调用方系统提示 | 关 | 默认剥离 Qoder/Codex 的 system/developer 消息与用户消息内嵌样板（system-reminder、AGENTS.md/INSTRUCTIONS、environment_context），仅保留项目目录一行 |

Codex 的会话标题生成请求（thread_title 元提示）由插件本地应答，不转发豆包、不产生账号侧会话。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOUBAO_CLI` | 自动解析 | run.cjs 路径覆盖（插件依赖 → magpie 共享插件树 → 全局 npm） |
| `DOUBAO_NODE` | 自动探测 | CLI 脚本解释器；缺省优先 node，无 node 回退宿主可执行文件 |
| `DOUBAO_ACP_CWD` | `<数据目录>/workspace` | agent 工作目录 |
| `DOUBAO_ACP_PERMISSION` | `bypass_permissions` | agent 权限模式（自主执行，无弹询） |
| `DOUBAO_ACP_MAX_MS` | 0（无上限） | 单回合时长上限（毫秒） |
| `DOUBAO_ACP_MAX_CONCURRENCY` | 0（不限） | 并行回合数（同会话串行、异会话并行） |
| `DOUBAO_ACP_MEM_MB` | 0（关闭） | 内存 watchdog 阈值 |
| `DOUBAO_ACP_TOOL_PROGRESS` | `reasoning` | 工具行通道：reasoning / comment / off |
| `DOUBAO_ACP_TOOL_DETAIL` | 200 | 工具输出摘录长度 |
| `DOUBAO_ACP_PROCESS_APPENDIX` | 关 | `1` 开启正文工作流附录 |
| `DOUBAO_ACP_SYSTEM` | 剥离 | `full` 原样转发调用方系统提示 |
| `DOUBAO_ACP_LOCAL_TITLE` | 开 | `0` 关闭标题请求本地应答 |
| `DOUBAO_ACP_CAPTURE` | 关 | 请求体捕获目录；也可在数据目录放 `capture.on` 文件免重启开启 |

数据目录：`~/.config/magpie/doubao-acp/`（会话映射、捕获、工作区）。

## 行为约定

- Responses 流将过程叙述、计划和工具事件作为 `commentary` 消息发送，最终回复使用 `final_answer`。会话续接忽略过程消息及未转发的开发者指令，并保留项目路径。
- Responses 轮次由豆包 CLI 自行调度工具，包括它可用的搜索工具。这样 Codex 请求附带 `web_search` 时，Magpie 可以直接转发过程消息。
- 会话续接：历史前缀哈希命中 → 同一 sessionId 直接续接；完全相同的请求（含并发重试）
  按请求指纹复用同一会话，不会扇出多个豆包会话。
- 客户端断开 → `session/cancel`，真实终止工具 worker。
- SSE 每 5 秒心跳；usage 为估算值，真实用量见响应 `doubao_context_usage`。
- 模型列表获取失败时回退默认模型，回合仍可执行。

## 已知限制

- 终端工具事件不含命令原文（ACP adapter 限制），富化依赖磁盘 trajectory 匹配；trajectory 按工具完成落盘，
  故命令原文在完成行才可知，开始行仅显示「运行中」标记（文件类工具开始行即带路径）。
- 本插件由社区维护。豆包 CLI 的使用受其服务条款约束。
- agent 默认使用 `bypass_permissions` 权限模式。`DOUBAO_ACP_CWD` 设置起始工作目录，实际访问权限由 CLI 进程所在环境决定。

## 开发

```bash
node test/unit.mjs     # 离线单测（剥离 / cwd / 标题识别 / 指纹）
node test/trajectory.mjs # 离线单测（trajectory 解析 / 运行中命令查找）
node test/entries.mjs  # 离线单测（登入登出入口 / 无额度 hook）
node --test test/responses.mjs # 离线检查 Responses 流与续接输入
node test/auth.mjs     # 登录流只读联调（需已登录的豆包 CLI）
node test/run.mjs      # 联调（需已登录的豆包 CLI；会产生真实会话）
```

## 许可证

[MIT](LICENSE)
