export function problem(status, message, details = {}) {
  return Object.assign(new Error(message), { status, details });
}

export const validEngine = value => value === "exec" || value === "app_server";
export const validTokenBudget = value => Number.isInteger(value) && value >= 0 && value <= 100_000_000;

export function validateEngineOptions(options) {
  if (options.executionEngine !== undefined && !validEngine(options.executionEngine)) throw problem(400, "Invalid execution_engine.");
  if (options.nativeGoalSync !== undefined && typeof options.nativeGoalSync !== "boolean") throw problem(400, "native_goal_sync must be boolean.");
  if (options.tokenBudget !== undefined && !validTokenBudget(options.tokenBudget)) throw problem(400, "Invalid token_budget.");
}

export function validateBooleans(args) {
  for (const key of ["allow_sandbox_escalation", "allowSandboxEscalation", "transfer_callback", "transferCallback",
    "keepOriginalCallback", "ephemeral", "native_goal_sync", "nativeGoalSync", "notify_on_complete", "notifyOnComplete", "skip_git_repo_check",
    "skipGitRepoCheck", "worktree", "uncommitted", "list_models", "activateOnly", "add", "archived", "completedOnly", "finishedOnly",
    "force_model", "disableDesktopNotify", "disable_desktop_notify", "autoHealEnabled", "auto_heal_enabled"]) {
    if (args[key] !== undefined && typeof args[key] !== "boolean") throw problem(400, key + " must be boolean.");
  }
}
