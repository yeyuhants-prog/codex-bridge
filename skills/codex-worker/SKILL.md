---
name: codex-worker
description: >-
  Orchestrate local OpenAI Codex CLI via the codex-bridge MCP server to delegate
  coding, refactoring, debugging, parallel sub-tasks, and Git code reviews. Use
  when the user asks to have Codex do work, review code, configure Codex model
  or reasoning effort, or collaborate alongside Antigravity.
---

# Codex Worker Orchestration Guide

When the **Codex Bridge** plugin is enabled, you have direct MCP tools and an
interactive sidecar panel (`[Codex Bridge](sidecar://codex-bridge/codex_panel/)`)
where the user can pick the default Codex model, reasoning effort, sandbox
policy, and workflow mode.

## Tool Selection

- **`codex_run`**: Synchronous single task (default). Best for tasks completing in
  under a few minutes. Returns Codex's final message, `Session ID`, modified files,
  executed commands, and token usage.
- **`codex_resume`**: Continue an existing Codex session using its `session_id`
  (or `"last"`) so Codex keeps full context from the previous turn.
- **`codex_review`**: Run Codex's built-in Git code review (`uncommitted: true`,
  `base: "main"`, or `commit: "<sha>"`).
- **`codex_start` + `codex_status` + `codex_cancel`**: Background async workflow.
  Use for long-running tasks (large refactors, test suites) or when dispatching
  multiple independent Codex workers in parallel. Use `codex_status` with
  `wait_seconds` (e.g. 30–60) for clean long-polling.
- **`codex_config`**: View or update the persistent default model, reasoning
  effort, sandbox, and workflow mode shared with the UI panel, and list local
  Codex models.
- **`codex_info`**: Health check showing resolved `codex.exe` path, CLI version,
  active panel settings, and tracked background jobs.

## Best Practices When Briefing Codex

1. **Respect the user's UI panel settings**: Omit `model`, `reasoning_effort`,
   and `sandbox` unless the user explicitly overrides them in their message —
   the bridge automatically applies whatever the user selected in the Codex
   Bridge sidecar panel.
2. **Respect `workflowMode`**: If `codex_info` reports `Workflow Mode: plan_first`,
   draft the detailed Codex execution brief (goal, target files, constraints,
   verification steps) and ask the user to confirm before calling `codex_run` /
   `codex_start`.
3. **Always pass an explicit `cwd`** pointing to the target project directory.
4. **Write self-contained prompts**: Specify target files, constraints, expected
   behavior, and verification commands Codex should run before finishing.
5. **Preserve `session_id`**: Note the `Session ID` returned by `codex_run` /
   `codex_status` so follow-up fixes use `codex_resume` instead of re-explaining
   the entire codebase.
6. **Review Codex's output**: Summarize modified files, command results, and any
   remaining issues clearly for the user; verify critical changes if needed.
