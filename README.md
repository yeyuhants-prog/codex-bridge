# Codex Bridge — Antigravity Plugin

一个零依赖、可一键开关的 **Antigravity 插件**，通过内置的 MCP (Stdio) 桥接服务让 Antigravity 直接指挥你本机的 **OpenAI Codex CLI** 干活。

## 特性

- **插件一键开关**：在 Antigravity 插件页直接开启/关闭，开启后 MCP 服务、协作技能（`codex-worker`）与激活规则一起生效，关闭后整体停用。
- **自动发现 Codex**：自动定位本机 Codex Desktop 内置的最新 `codex.exe`（`%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`），也支持 `PATH` 或通过环境变量 `CODEX_BIN` 手动指定。
- **零外部依赖**：纯 Node.js ESM（Node >= 18），免 `npm install`，跨平台路径配置，克隆即用。
- **同步 + 异步并行**：短任务实时推送进度同步返回；耗时任务或并行派活可通过 `codex_start` / `codex_status` / `codex_cancel` 后台管理。
- **多轮会话延续**：支持按 `session_id`（或 `"last"`）用 `codex_resume` 接着上次的上下文继续改代码。

## 提供的 7 个 MCP 工具

| 工具 | 用途 |
| --- | --- |
| `codex_run` | 同步执行 Codex 任务（默认 `workspace-write` 沙箱），返回回复、`Session ID`、改动文件清单、执行命令与 Token 统计 |
| `codex_resume` | 按 `session_id`（或 `"last"`）延续上次 Codex 会话 |
| `codex_review` | 调用 `codex exec review` 对 Git 仓库做代码审查（支持未提交改动、对比分支、指定 commit） |
| `codex_start` | 后台异步启动 Codex 任务并立即返回 `job_id` |
| `codex_status` | 查看后台任务实时进度或最终结果（支持 `wait_seconds` 长轮询） |
| `codex_cancel` | 终止正在运行的后台 Codex 任务（清理整棵子进程树） |
| `codex_info` | 健康检查，显示当前解析到的 `codex.exe` 路径、版本与任务概览 |

## 安装方式

将本仓库克隆到 Antigravity 的全局插件目录：

```bash
git clone https://github.com/yeyuhants-prog/codex-bridge.git ~/.gemini/config/plugins/codex-bridge
```

（Windows PowerShell 下为 `C:\Users\<用户名>\.gemini\config\plugins\codex-bridge`）

安装后即可在 Antigravity 的 Customizations / Plugins 页面随时开关 **Codex Bridge**。

## 自测

```bash
npm test
# 如需真实调用一次只读 codex_run：
npm run test:live
```
