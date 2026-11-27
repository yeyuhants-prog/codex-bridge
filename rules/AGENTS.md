# Codex Bridge Active

The **Codex Bridge** plugin is enabled. You have access to the `codex-bridge` MCP tools (`codex_run`, `codex_resume`, `codex_review`, `codex_start`, `codex_status`, `codex_cancel`, `codex_goal`, `codex_config`, `codex_info`) and the interactive **Codex Bridge** sidecar control panel (`sidecar://codex-bridge/codex_panel/`).

- When the user asks you to have Codex write code, debug backend issues, run meta-analysis scripts, review a repo, or execute multi-step verification tasks, use the `codex-bridge` MCP tools directly (instead of invoking `codex` manually through shell commands).
- Do NOT override `model`, `reasoning_effort`, or `sandbox` unless the user explicitly requests a different one for that call — omitting them automatically applies the user's live selections from the **Codex Bridge** UI panel.
- For multi-step debugging, backend changes, or meta-analysis pipelines that require ongoing verification, create and maintain a persistent goal with `codex_goal` (milestones + verification commands) and pass `goal_id` / `milestone_id` into `codex_start` / `codex_run` / `codex_resume`.
- Respect the panel's `Workflow Mode` (`plan_first` = present detailed brief for approval before dispatching) and `Progression Mode`:
  - When a `[Codex Bridge Auto-Callback]` message arrives in the conversation after a background job finishes: inspect the result & modified files, run or verify acceptance checks, update the milestone via `codex_goal(action="update_milestone")`, and:
    - In **`notify`** mode: report the verified findings clearly and ask/propose the next step.
    - In **`autonomous`** mode: if the goal is still `active` and under `maxIterations`, immediately continue by calling `codex_resume` (to fix issues) or `codex_start` (for the next pending milestone) until all acceptance criteria pass or a genuine blocker requires user input.
- Always specify `cwd` explicitly. When resuming an existing job, prefer `codex_start(resume_job_id=...)` or `codex_resume(resume_job_id=...)` so original `session_id`, `cwd`, `sandbox`, `goal_id`, and `milestone_id` are inherited safely (never pass `"last"`).
