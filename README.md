# Codex Bridge — Antigravity Plugin

一个零依赖、可一键开关且自带**可视化交互侧边栏面板**的 **Antigravity 插件**，通过内置的 MCP (Stdio) 桥接服务让 Antigravity 直接指挥你本机的 **OpenAI Codex CLI** 干活。

## 特性

- **原生交互式控制面板（Sidecar UI）**：出现在 Antigravity 右侧「插件」菜单中，支持实时点选：
  - **Codex 模型**（自动读取本机 `~/.codex/models_cache.json` 中的全部可用模型）
  - **思考深度（Reasoning Effort）**（动态适配所选模型的 `low / medium / high / xhigh / max / ultra` 档位）
  - **执行权限（Sandbox）**（`read-only` / `workspace-write` / `danger-full-access`）
  - **协作方式**（`直接派活执行` 或 `先出任务单确认再执行`）
  - **快捷发活与最近执行记录**（查看耗时、Token 消耗，一键复制 `Session ID`）
- **插件一键开关**：在 Antigravity `自定义扩展` 页面直接开关，开启后 UI 面板、MCP 服务、协作技能（`codex-worker`）与激活规则同步上线，关闭后整体停用。
- **自动发现 Codex**：自动定位本机 Codex Desktop 内置的最新 `codex.exe`，也支持 `PATH` 或 `CODEX_BIN` 环境变量。
- **零外部依赖**：纯 Node.js ESM（Node >= 18），免 `npm install`，克隆即用。

## 提供的 8 个 MCP 工具

| 工具 | 用途 |
| --- | --- |
| `codex_run` | 同步执行 Codex 任务（自动应用面板中选定的模型、思考深度与沙箱权限） |
| `codex_resume` | 按 `session_id`（或 `"last"`）延续上次 Codex 会话 |
| `codex_review` | 调用 `codex exec review` 对 Git 仓库做代码审查 |
| `codex_start` | 后台异步启动 Codex 任务并立即返回 `job_id` |
| `codex_status` | 查看后台任务实时进度或最终结果（支持 `wait_seconds` 长轮询） |
| `codex_cancel` | 终止正在运行的后台 Codex 任务（清理整棵子进程树） |
| `codex_config` | 读取/更新与侧边栏 UI 共享的默认模型、思考深度、沙箱和协作模式，并列出本地可用模型 |
| `codex_info` | 健康检查，显示 `codex.exe` 路径、版本、当前生效的面板配置与任务概览 |

## 安装方式

```bash
git clone https://github.com/yeyuhants-prog/codex-bridge.git ~/.gemini/config/plugins/codex-bridge
```

## 自测

```bash
npm test
# 如需真实调用一次只读 codex_run：
npm run test:live
```
