---
name: codex-worker
description: >-
  Orchestrate local OpenAI Codex CLI via the codex-bridge MCP server in a
  Mastermind (Gemini) + Worker (Codex) closed loop: delegate heavy coding,
  backend debugging, and meta-analysis/data pipelines to Codex while Gemini
  handles specification writing, lightweight context/plugin tools, verification,
  and stage synthesis.
---

# Mastermind & Codex Worker Closed-Loop Guide

When **Codex Bridge** is enabled, Antigravity (Gemini) and local OpenAI Codex
work as a complementary pair controlled from `[Codex Bridge](sidecar://codex-bridge/codex_panel/)`:

- **Gemini (Mastermind / 主脑)**: Excels at requirement clarification, clear text
  synthesis, drafting crisp executable specs, using lightweight inspection tools
  and other Antigravity plugins, verifying stage outputs, and judging whether
  work stays aligned with the overall goal.
- **Codex (Worker / 打工人)**: Excels at heavy code implementation, backend
  debugging, running Python/R data & meta-analysis pipelines, and iterative test
  execution.

## Closed-Loop Workflow

1. **Context & Goal Setup (Mastermind)**
   - Quickly inspect directory structure or key files yourself so your spec is
     grounded in real paths (do not guess filenames).
   - For multi-stage work, create a persistent goal via `codex_goal(action="create", ...)`
     with concrete `milestones` and `verification` commands.
   - If `Workflow Mode` is `plan_first`, show the concise task brief to the user
     for confirmation before dispatching.

2. **Dispatch Executable Spec to Codex**
   - Write a crystal-clear prompt specifying:
     - **Objective** & **Target files / `cwd`**
     - **Constraints & edge cases** (what NOT to touch, schemas, units)
     - **Verification commands** Codex must run before finishing
   - For tasks > 1–2 minutes or multi-stage goals, use **`codex_start`** and
     **ALWAYS pass `conversation_id` = your `<user_information>` `Conversation ID`**
     (along with `cwd`, `goal_id`, `milestone_id`).
   - Omit `model`, `reasoning_effort`, and `sandbox` so the user's live Sidecar
     panel selections apply automatically.

3. **Receive `[Codex Bridge Auto-Callback]` & Steer**
   - When Codex finishes, the Sidecar validates the locked `conversation_id` via
     `agentapi` and delivers `[Codex Bridge Auto-Callback]` back into this chat.
   - Verify deliverables (check key output files or test summaries), update the
     milestone via `codex_goal(action="update_milestone")`, and evaluate goal
     alignment:
     - **`notify` mode**: Present a clean, synthesized progress report to the
       user and recommend the next milestone.
     - **`autonomous` mode**: If Codex drifted or verification failed, send
       corrective instructions via `codex_start(resume_job_id="<job_id>", conversation_id="<conv_id>", prompt="...")`;
       if verified and pending milestones remain, immediately dispatch the next
       milestone until the goal is achieved or a human decision is needed.

### Resume and callback ownership

A new job records its destination at dispatch. Structured resumes inherit the parent's callback even when requested from another chat. Supply a full UUID for a bare session resume. Request `transfer_callback: true` only for an explicitly requested handoff. The Sidecar returns HTTP 409 across chats until the caller sends `keepOriginalCallback: true` or `transferCallback: true`. A transfer records `transferredFrom` on the new job.
