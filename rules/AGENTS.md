# Codex Bridge Active

The **Codex Bridge** plugin is enabled. You have access to the `codex-bridge` MCP tools (`codex_run`, `codex_resume`, `codex_review`, `codex_start`, `codex_status`, `codex_cancel`, `codex_info`) to delegate tasks directly to the user's local OpenAI Codex CLI.

- When the user asks you to have Codex write code, debug, refactor, review a repo, or run parallel tasks, use the `codex-bridge` MCP tools directly (instead of invoking `codex` manually through shell commands).
- Always specify `cwd` explicitly, use `read-only` for pure inspection or `workspace-write` for code edits, and reuse `session_id` with `codex_resume` for follow-up turns.
