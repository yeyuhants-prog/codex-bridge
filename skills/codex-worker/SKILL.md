---
name: codex-worker
description: >-
  Orchestrate local OpenAI Codex CLI via the codex-bridge MCP server to delegate
  backend debugging, refactoring, meta-analysis pipelines, parallel sub-tasks,
  persistent multi-step goals, and Git code reviews. Use when the user asks to
  have Codex do work, track a continuous goal, configure Codex settings, or
  collaborate alongside Antigravity.
---

# Codex Worker & Continuous Goal Orchestration Guide

When the **Codex Bridge** plugin is enabled, you have direct MCP tools and an
interactive sidecar panel (`[Codex Bridge](sidecar://codex-bridge/codex_panel/)`)
where the user selects the Codex model, reasoning effort, sandbox policy,
workflow mode, and **progression mode** (`manual` / `notify` / `autonomous`).

## Tool Selection

- **`codex_goal`**: Persistent goal & milestone board stored on disk (survives
  conversation compaction and restarts). Use for any multi-step backend fix,
  experiment, or meta-analysis workflow needing repeated verification.
  - `create`: Define title, objective, `cwd`, `acceptance_criteria`, and ordered
    `milestones` (each with a concrete `verification` command/check).
  - `get` / `list`: Recover full goal state and linked `session_id` anytime.
  - `update_milestone`: Mark `in_progress` / `done` / `blocked` with verification notes.
  - `set_status`: Pause, resume (`active`), complete, or record `blockers`.
- **`codex_run`**: Synchronous single task for quick steps (< 2–3 min).
- **`codex_resume`**: Continue an existing Codex session (`session_id` or `"last"`)
  to iterate on fixes without losing codebase context.
- **`codex_start` + `codex_status` + `codex_cancel`**: Persistent background jobs.
  Pass `goal_id` & `milestone_id` so the Sidecar panel tracks progress and triggers
  an automatic callback back into this conversation when the job completes (in
  `notify` or `autonomous` progression modes).
- **`codex_review`**: Built-in Git code review (`uncommitted`, `base`, `commit`).
- **`codex_config` / `codex_info`**: Inspect or update panel preferences and check
  Codex binary health + active goal progress.

## Continuous Verification Loop (Backend & Meta-Analysis Best Practices)

1. **Always check `codex_info` first** when starting a complex multi-step task to
   see the user's current `Workflow Mode`, `Progression Mode`, and any active Goal.
2. **Respect the user's UI panel selections**: Omit `model`, `reasoning_effort`,
   and `sandbox` unless the user explicitly overrides them for that call.
3. **Define verifiable milestones**: For backend changes (unit/integration tests,
   API curl checks, schema checks) and meta-analysis pipelines (data integrity,
   effect-size reproducibility, heterogeneity stats, plot generation), give every
   milestone an explicit `verification` command or assertion.
4. **Handling `[Codex Bridge Auto-Callback]` messages**:
   - Inspect Codex's output, modified files, and command exit codes.
   - Verify the milestone's acceptance condition (either from Codex's test output
     or by running a quick check yourself).
   - Call `codex_goal(action="update_milestone", ...)` to persist the outcome.
   - If **`notify`** mode: summarize verified results and ask before dispatching
     the next step.
   - If **`autonomous`** mode: while the goal is `active` and below `maxIterations`,
     keep driving forward — call `codex_resume` if verification failed, or
     `codex_start` for the next pending milestone. Stop and report clearly when all
     milestones are `done`, `maxIterations` is reached, or a real decision/blocker
     needs the user.
5. **Recovering interrupted jobs**: If `codex_status` shows `interrupted` after a
   restart, use the preserved `session_id` with `codex_resume` or `codex_start`
   to pick up right where Codex left off.
