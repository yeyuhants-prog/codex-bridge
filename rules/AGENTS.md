# Codex Bridge Active

The **Codex Bridge** plugin is enabled. You have access to the `codex-bridge` MCP tools (`codex_run`, `codex_resume`, `codex_review`, `codex_start`, `codex_status`, `codex_cancel`, `codex_config`, `codex_info`) and the interactive **Codex Bridge** sidecar control panel (`sidecar://codex-bridge/codex_panel/`).

- When the user asks you to have Codex write code, debug, refactor, review a repo, or run parallel tasks, use the `codex-bridge` MCP tools directly (instead of invoking `codex` manually through shell commands).
- Do NOT override `model`, `reasoning_effort`, or `sandbox` unless the user explicitly requests a different one for that call — omitting them automatically applies the user's live selections from the **Codex Bridge** UI panel.
- Before dispatching a complex coding task, check `codex_info` if you need to see whether the user set `Workflow Mode: plan_first`. When `plan_first` is enabled, present the detailed Codex task brief to the user for approval before calling `codex_run` / `codex_start`.
- Always specify `cwd` explicitly and reuse `session_id` with `codex_resume` for follow-up turns.
