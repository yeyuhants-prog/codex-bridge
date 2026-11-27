export function problem(status, message, details = {}) {
  return Object.assign(new Error(message), { status, details });
}

export function validateBooleans(args) {
  for (const key of ["allow_sandbox_escalation", "allowSandboxEscalation", "transfer_callback", "transferCallback",
    "keepOriginalCallback", "ephemeral", "notify_on_complete", "notifyOnComplete", "skip_git_repo_check",
    "skipGitRepoCheck", "worktree", "uncommitted", "list_models", "activateOnly", "add"]) {
    if (args[key] !== undefined && typeof args[key] !== "boolean") throw problem(400, key + " must be boolean.");
  }
}
