---
name: codex-worker
description: >-
  Orchestrate local OpenAI Codex CLI via the codex-bridge MCP server to delegate
  coding, refactoring, debugging, parallel sub-tasks, and Git code reviews. Use
  when the user asks to have Codex do work, review code, or collaborate alongside
  Antigravity.
---

# Codex Worker Orchestration Guide

When the **Codex Bridge** plugin is enabled, you have direct MCP tools to dispatch
work to the user's local OpenAI Codex CLI.

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
- **`codex_info`**: Health check showing resolved `codex.exe` path, CLI version,
  and tracked background jobs.

## Best Practices When Briefing Codex

1. **Always pass an explicit `cwd`** pointing to the target project directory.
2. **Pick the right `sandbox` mode**:
   - `read-only` for codebase analysis, Q&A, architecture review, or planning.
   - `workspace-write` (default) for editing code and running project tests.
   - Only use `danger-full-access` if the user explicitly asks for it.
3. **Write self-contained prompts**: Specify target files, constraints, expected
   behavior, and verification commands Codex should run before finishing.
4. **Preserve `session_id`**: Note the `Session ID` returned by `codex_run` /
   `codex_status` so follow-up fixes use `codex_resume` instead of re-explaining
   the entire codebase.
5. **Review Codex's output**: Summarize modified files, command results, and any
   remaining issues clearly for the user; verify critical changes if needed.
