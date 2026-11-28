<div align="center">

<img src="./assets/logo.png" alt="Codex Bridge Logo" width="128" height="128" />

# Codex Bridge

**An Antigravity plugin with an interactive control panel, persistent goal & milestone board, auto-callback progression loop, and zero-dependency MCP bridge to orchestrate your local OpenAI Codex CLI.**

[![Version](https://img.shields.io/badge/version-1.7.0-7c3aed?style=flat-square)](./plugin.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-22c55e?style=flat-square)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-zero-0ea5e9?style=flat-square)](#architecture)
[![MCP](https://img.shields.io/badge/protocol-MCP%20Stdio-f59e0b?style=flat-square)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](./LICENSE)

**English** · [简体中文](./README.zh-CN.md)

</div>

---

## Why Codex Bridge?

**Codex Bridge** turns your local **OpenAI Codex CLI** into a persistent, goal-driven coding & analysis worker inside **Google Antigravity** — built specifically for iterative workflows like **backend debugging/refactoring** and **meta-analysis / data pipelines** that require continuous investigation, execution, and verification.

- Let **Antigravity** analyze requirements, design verifiable milestones, inspect diffs, and verify outcomes.
- Let **Codex** execute edits, run backend tests/scripts, resume multi-turn sessions, and wake Antigravity automatically when background runs finish.

> [!IMPORTANT]
> **Network Stability Requirement**: **Google Antigravity itself** — as well as long-running OpenAI Codex CLI streaming sessions — has **high requirements for network stability**. On unstable networks or flaky proxy nodes, long HTTP/SSE streams can silently stall or drop (`idle timeout waiting for SSE` / `tls handshake eof`). For the best experience:
> - Use a stable, low-latency network/proxy node;
> - Switch **Transport** in the panel to **Prefer WebSocket** if HTTP SSE stalls;
> - Keep the built-in **L1 Auto-Heal Watchdog** and **Periodic Sub-Model Inspection** enabled so transient stream stalls recover automatically.

## Features

- **Mastermind + Worker Role Division (`orchestrator` / `flexible`)** — Defaults to **Mastermind Mode**: Antigravity leverages its strengths in text synthesis, specification writing, lightweight tools/plugins, and stage verification, while delegating all heavy coding, backend debugging, and data/meta-analysis script execution to Codex in a closed callback loop (`codex_start` with `conversation_id`).
- **Flexible Model Routing & Pinned Worker Model (`flexible` / `pinned`)** — Pick your default worker model in the panel (`~/.codex/models_cache.json`) and switch between **Flexible per task** (honor user-named models like *"use `gpt-6.2-sol`"* or switch per task complexity) and **Pinned model** (strictly enforce the selected model unless `force_model: true` is explicitly passed).
- **Three-Tier Monitoring & Auto-Heal Recovery (v1.7.0)**:
  - **L1 Phase-Aware Watchdog & Auto-Heal** — Tracks live execution phase (`running_cmd` vs `waiting_api` vs `reconnecting`). Local shell/build/data commands (`running_cmd`) are protected from false stall kills; if `waiting_api` stays silent past the configurable threshold (`Off / 2 / 4 / 8 min`) or gets stuck reconnecting, the bridge stops the hung stream and automatically resumes via `resume_job_id` (up to `maxAutoHeals` times, without burning goal iterations) using an idempotent recovery prompt.
  - **L2 Periodic Inspection via Lightweight Sub-Model** — Configurable periodic check-in interval (`Off / 3 / 5 / 10 min`) delivers `[Codex Bridge Periodic Check #N]` strictly to the locked source conversation, guiding the Mastermind to delegate fast read-only progress checks to a lightweight `flash_lite` subagent without polluting Mastermind context.
  - **L3 Post-Turn Tail Cleanup & Transport Control** — Supports `Follow default` / `Prefer WebSocket` / `HTTP SSE only`, suppresses Codex Desktop `notify=[]` hooks on headless CLI runs, and cleanly closes lingering post-`turn.completed` processes after a 5-second grace period with zero false warnings.
- **Configurable Per-Turn Timeout (`Unlimited` → `4 hr`)** — Choose `Unlimited (0)`, `30 min`, `1 hr`, `2 hr`, or `4 hr` right in the Controls panel (inherited by resumed jobs).
- **Native Interactive Sidecar Panel (EN / 中文)** — Appears right inside Antigravity's **Plugins** side-pane menu with one-click live **English / Chinese** switching and two clean tabs (**Controls** & **Goals & Jobs**):
  - **Model selection & routing**, **Reasoning effort** (`low` → `ultra`), **Progression mode** (`manual` / `notify` / `autonomous`), **Per-turn timeout**, **Periodic inspection interval**, **API stall threshold & auto-heal toggle**, **Sandbox policy** (`read-only` / `workspace-write` / `danger-full-access`), **Briefing workflow** (`direct` / `plan_first`), and **Transport** (`default` / `websocket` / `http`).
  - **Historical Goals & Execution Records Archiving** — Main goal board and history filters show only unarchived items; archive completed goals/records in one click or individually into dedicated collapsible **Archived** drawers/filters, with one-click restore (active jobs are protected from archiving).
  - **Ergonomic Expand / Collapse** — Long prompts expand inside a bounded scrollable container (`max-height: 260px`) so **Collapse prompt** stays visible on screen, plus collapsible goal milestones and one-click **Collapse all**.
- **Persistent Goal & Milestone State Machine** — Goals, ordered milestones, verification commands, blockers, and linked `Session ID`s persist on disk (`goals.json`), surviving conversation compaction and restarts.
- **Per-Job Locked Callbacks & Explicit Retry** — Callback targets (`conversationId` / `projectId`) are locked from trusted Antigravity host context at job dispatch time (`GET /api/state` is strictly read-only, preventing cross-conversation leaks). Failed deliveries remain visibly marked `failed` with one-click retry strictly to the original source conversation.
- **Restart-Resilient Jobs & Cross-Process Session Locks** — Background jobs (`codex_start`) persist to `jobs.json` with atomic per-session file locks (`locks/`). If the MCP server restarts while a Codex process is still alive, the job transitions to `running_detached` (blocking duplicate spawns until it finishes or is explicitly stopped). Structured resume (`resume_job_id` or panel **Resume Job**) preserves original `session_id`, `cwd`, `sandbox`, `goal_id`, and `milestone_id`, places `-C` / `-s` before `resume`, and blocks accidental sandbox widening unless explicitly confirmed.
- **Automatic Codex Discovery** — Automatically locates the newest `codex.exe` bundled with Codex Desktop on Windows (survives hash-folder auto-updates), falls back to `codex` on `PATH`, or respects `CODEX_BIN`.
- **Zero External Dependencies** — Pure Node.js ESM (`>= 18`). No `npm install`, no build step, instant startup, UTF-8 `stdin` prompting.

## Architecture

```mermaid
flowchart LR
  User["User in Antigravity"] <--> Agent["Antigravity Agent"]
  User <--> Panel["Sidecar Control Panel & Goal Watcher<br/>(sidecars/codex_panel)"]
  Panel -->|Auto-Callback on Job Done| Agent
  Panel <--> Store["Persistent State<br/>(settings.json / goals.json / jobs.json)"]
  Agent <-->|MCP Stdio JSON-RPC| Server["Codex MCP Bridge<br/>(server/mcp-server.js)"]
  Store <--> Server
  Server <-->|JSONL Stream + UTF-8 stdin| Codex["Local OpenAI Codex CLI<br/>(codex exec / resume / review)"]
```

## Quick Start

### Prerequisites

- **Google Antigravity** (Desktop or CLI)
- **Node.js `>= 18`**
- **OpenAI Codex** (Codex Desktop app or `codex` CLI installed and signed in)

### Install

**macOS / Linux:**
```bash
git clone https://github.com/yeyuhants-prog/codex-bridge.git ~/.gemini/config/plugins/codex-bridge
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/yeyuhants-prog/codex-bridge.git "$env:USERPROFILE\.gemini\config\plugins\codex-bridge"
```

### Enable & Open the Panel

1. Open **Skills & Customizations** (自定义扩展) in Antigravity's left sidebar and ensure **Codex Bridge** is toggled **ON**.
2. Open the interactive control panel from the right-hand **Plugins** (`插件`) menu → **Codex Bridge**.
3. Pick your **Codex model**, **reasoning effort**, **progression mode** (`manual` / `notify` / `autonomous`), and **sandbox** — each new job binds its callback when dispatched. Conflicting request and host conversation IDs are rejected.

## MCP Tools (9)

| Tool | Description |
| --- | --- |
| `codex_goal` | Create, inspect, update milestones, pause/resume, archive/unarchive, or delete persistent multi-step Goals shared with the Sidecar goal board. |
| `codex_run` | Run a task synchronously via `codex exec` using active panel settings (or per-call overrides). Supports optional `goal_id`, `milestone_id`, `force_model`, and `timeout_seconds` (`0` = unlimited). |
| `codex_resume` | Continue by `resume_job_id` or an exact session UUID. Unknown sessions default to read-only. |
| `codex_review` | Run Codex's built-in non-interactive Git code review (`uncommitted`, `base` branch, or `commit` SHA). |
| `codex_start` | Launch a persistent background Codex worker and return `job_id` immediately; supports L1 auto-heal watchdog, periodic check-ins, and completion auto-callbacks. |
| `codex_status` | Inspect live phase (`waiting_api` / `running_cmd` / `reconnecting`), progress events, auto-heal & periodic check counts, `Session ID`, or final output of a background job. |
| `codex_cancel` | Terminate a running background Codex job along with its child process tree. |
| `codex_config` | Read or update shared preferences (`model`, `model_routing`, `reasoning_effort`, `sandbox`, `workflow_mode`, `progression_mode`, `task_timeout_seconds`, `transport`, `auto_heal_enabled`, `stall_threshold_seconds`, `max_auto_heals`, `monitor_interval_seconds`, `max_auto_iterations`) and list local Codex models. |
| `codex_info` | Health check showing resolved Codex binary & version, active panel settings, watchdog/monitor configuration, active goal progress, and tracked jobs. |

## Example Prompts

- **Continuous backend debugging:**
  > *"Create a persistent Codex Bridge goal to reproduce the 500 error in `backend/auth`, fix the root cause, and pass `pytest`. Start milestone 1 in the background and keep verifying until all tests pass."*
- **Iterative meta-analysis pipeline:**
  > *"Set up a goal with milestones for cleaning the dataset, checking heterogeneity (I² / Q-test), running sensitivity analysis, and exporting forest plots. Dispatch Codex step-by-step and verify each output table."*
- **Code review:**
  > *"Have Codex review my uncommitted Git changes in this repository and summarize bugs or edge cases."*
- **Per-call model override:**
  > *"Use `gpt-6.2-astra` with `xhigh` reasoning effort and have Codex refactor the parser module."*

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_BIN` | Auto-discovered | Explicit path to the `codex` / `codex.exe` binary. |
| `CODEX_HOME` | `~/.codex` | Directory containing Codex's `config.toml` and `models_cache.json`. |
| `CODEX_BRIDGE_DATA_DIR` | `~/.gemini/antigravity/plugin_data/codex-bridge` | Directory storing `settings.json`, `goals.json`, `jobs.json`, and `history.json`. |

## Testing

```bash
# Zero-token MCP protocol, settings & persistent goal board smoke test
npm test

# Full automated unit, acceptance, and regression suites (v1.4 ~ v1.7)
node --test test/panel-ui.test.mjs
node test/acceptance-v14.mjs
node test/regression-v15.mjs
node test/regression-v16.mjs
node --test test/regression-v17.mjs

# End-to-end live check against your local Codex CLI (read-only, ephemeral)
npm run test:live
```

Structured resumes retain the parent directory, session, goal, callback destination and execution policy. A milestone override must belong to that goal. A cross-conversation panel resume returns HTTP 409 until the caller selects `keepOriginalCallback: true` or `transferCallback: true`. MCP callers can explicitly transfer with `transfer_callback: true`. The child records the previous destination in `transferredFrom`. Expanding writable directories or sandbox permissions requires boolean `allow_sandbox_escalation: true`.

## Project Structure

```text
codex-bridge/
├── plugin.json                 # Antigravity plugin manifest
├── mcp_config.json             # Portable MCP server definition
├── assets/
│   └── logo.png                # Plugin icon (512×512 transparent PNG)
├── server/
│   ├── mcp-server.js           # Zero-dependency MCP Stdio JSON-RPC server
│   ├── codex-runner.js         # Codex CLI auto-discovery, spawn & JSONL parser
│   ├── goal-store.js           # Persistent Goal & Milestone state machine
│   ├── job-manager.js          # Persistent async worker & process-tree manager
│   └── settings-store.js       # Shared preferences, history & model catalog reader
├── sidecars/
│   └── codex_panel/            # Native Antigravity side-pane UI & callback watcher
│       ├── sidecar.json
│       ├── main.mjs
│       ├── index.html
│       ├── app.js
│       └── styles.css
├── skills/
│   └── codex-worker/SKILL.md   # Orchestration skill for Antigravity
├── rules/
│   └── AGENTS.md               # Active rules while plugin is enabled
└── test/
    └── smoke-test.mjs          # End-to-end MCP smoke test
```

## License

Released under the [MIT License](./LICENSE).
