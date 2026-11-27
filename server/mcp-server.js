#!/usr/bin/env node
import {
  resolveCodexBinary,
  getCodexVersion,
  runCodex,
  formatCodexResult,
} from "./codex-runner.js";
import { validateBooleans } from "./validation.js";
import { workingDirectory, resolveResume } from "./run-policy.js";
import { processIdentity } from "./process-identity.js";
import { JobManager, normalizeCallbackTarget, readPersistedJobs, reconcilePersistedJobs } from "./job-manager.js";
import {
  loadSettings,
  saveSettings,
  appendHistory,
  readCodexTomlDefaults,
  readCodexModelsCatalog,
} from "./settings-store.js";
import {
  listGoals,
  getGoal,
  createGoal,
  setActiveGoal,
  updateGoalStatus,
  addMilestone,
  updateMilestone,
  recordGoalExecution, reserveGoalDispatch, abandonGoalDispatch,
  deleteGoal,
  formatGoalSummary,
} from "./goal-store.js";
import {
  acquireSessionLock,
  updateSessionLockPid,
  releaseSessionLock,
} from "./session-lock.js";

const SERVER_INFO = {
  name: "codex-mcp-bridge",
  version: "1.5.0",
};

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const jobManager = new JobManager();
reconcilePersistedJobs();
const activeRequests = new Map();

function log(...args) {
  process.stderr.write(`[codex-mcp-bridge] ${args.join(" ")}\n`);
}

function sendMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  sendMessage({ jsonrpc: "2.0", id, error: err });
}

function sendProgress(progressToken, progress, message) {
  if (progressToken === undefined || progressToken === null) return;
  sendMessage({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: {
      progressToken,
      progress,
      message,
    },
  });
}

/**
 * Extract callback destination locked onto a job at dispatch time:
 * 1) Antigravity host _meta (if present)
 * 2) Antigravity host env (if present)
 * 3) Explicit conversation_id passed by the calling conversation agent from its
 *    <user_information> Conversation ID (Sidecar verifies conversation existence
 *    via agentapi before delivering; never falls back to mutable global state).
 */
function extractTrustedHostCallbackTarget(meta = {}, args = {}) {
  const metaConv =
    meta?.conversationId ||
    meta?.conversation_id ||
    meta?.["com.google.antigravity/conversationId"] ||
    meta?.["antigravity/conversationId"] ||
    "";
  const metaProj =
    meta?.projectId ||
    meta?.project_id ||
    meta?.["com.google.antigravity/projectId"] ||
    meta?.["antigravity/projectId"] ||
    "";

  let envConv = process.env.ANTIGRAVITY_CONVERSATION_ID || "";
  const envProj = process.env.ANTIGRAVITY_PROJECT_ID || "";
  if (!envConv && process.env.ANTIGRAVITY_SOURCE_METADATA) {
    try {
      const parsed = JSON.parse(process.env.ANTIGRAVITY_SOURCE_METADATA);
      envConv = parsed?.tool?.conversationId || parsed?.conversationId || "";
    } catch {
      // ignore
    }
  }

  const targets = [[metaConv,metaProj,"mcp_meta"],[args.conversation_id,args.project_id,"agent_conversation_id"],[envConv,envProj,"host_env"]]
    .filter(([id]) => id).map(([conversationId,projectId,source]) => {
      const target = normalizeCallbackTarget({ conversationId,projectId,source });
      if (!target) throw new Error("Invalid conversation_id.");
      return target;
    });
  if (new Set(targets.map(t => t.conversationId.toLowerCase())).size > 1 ||
      new Set(targets.map(t => t.projectId.toLowerCase()).filter(Boolean)).size > 1) {
    throw new Error("Conflicting conversation or project targets in request and host context.");
  }
  if (targets.length) return targets[0];
  return null;
}

const COMMON_RUN_PROPERTIES = {
  cwd: {
    type: "string",
    description:
      "Absolute path to the working directory where Codex should operate. Defaults to the active goal cwd or current workspace directory.",
  },
  sandbox: {
    type: "string",
    enum: ["read-only", "workspace-write", "danger-full-access"],
    description:
      "Sandbox policy for Codex shell commands. Omit to use the active Codex Bridge UI panel setting (or original job's sandbox when resuming).",
  },
  model: {
    type: "string",
    description:
      "Optional model override for Codex. Omit to use the model selected in the Codex Bridge UI panel or ~/.codex/config.toml.",
  },
  reasoning_effort: {
    type: "string",
    enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
    description:
      "Optional reasoning effort override for Codex. Omit to use the level selected in the Codex Bridge UI panel or Codex default.",
  },
  goal_id: {
    type: "string",
    description:
      "Optional persistent goal_id to associate this Codex execution with (auto-links session_id and iteration count).",
  },
  milestone_id: {
    type: "string",
    description:
      "Optional milestone_id (e.g. 'm1') inside goal_id that this execution is working on.",
  },
  profile: {
    type: "string",
    description: "Optional Codex config profile name (-p <profile>).",
  },
  add_dirs: {
    type: "array",
    items: { type: "string" },
    description:
      "Additional directories that should be writable alongside cwd.",
  },
  images: {
    type: "array",
    items: { type: "string" },
    description: "Optional image file paths to attach to the prompt.",
  },
  config: {
    type: "array",
    items: { type: "string" },
    description:
      "Optional Codex config overrides in 'key=value' TOML format (passed as -c).",
  },
  ephemeral: {
    type: "boolean",
    description: "If true, do not persist the Codex session to disk.",
  },
  worktree: {
    type: "boolean",
    default: false,
    description: "If true, run the session inside a managed Git worktree.",
  },
  skip_git_repo_check: {
    type: "boolean",
    description:
      "Allow Codex to run outside a Git repository (defaults to UI panel setting / true).",
  },
  output_schema: {
    type: "string",
    description:
      "Optional path to a JSON Schema file constraining Codex's final response shape.",
  },
};

const TOOLS = [
  {
    name: "codex_run",
    description:
      "Run a task synchronously with local OpenAI Codex CLI (`codex exec`) using the model, reasoning effort, and sandbox configured in the Codex Bridge UI panel (unless explicitly overridden). Returns final response, session_id, modified files, executed commands, and token usage.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Clear, detailed task instructions for Codex (supports multiline text and Chinese/English).",
        },
        ...COMMON_RUN_PROPERTIES,
        timeout_seconds: {
          type: "number",
          default: 600,
          description: "Maximum seconds to wait before aborting (default 600).",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "codex_resume",
    description:
      "Continue a previous Codex session synchronously with follow-up instructions. Pass either `resume_job_id` (recommended: inherits original session_id, cwd, sandbox, goal & milestone) or an exact `session_id` + explicit `cwd`. Enforces per-session mutual exclusion and blocks accidental sandbox widening unless `allow_sandbox_escalation: true`.",
    inputSchema: {
      type: "object",
      properties: {
        resume_job_id: {
          type: "string",
          description:
            "Recommended: previous job_id to resume from (automatically inherits exact session_id, cwd, sandbox, goal_id, milestone_id).",
        },
        session_id: {
          type: "string",
          description:
            "Exact Codex session UUID (required if resume_job_id is not provided; 'last' is rejected to prevent resuming the wrong session).",
        },
        prompt: {
          type: "string",
          description: "Follow-up instructions to send to the resumed Codex session.",
        },
        cwd: {
          type: "string",
          description:
            "Absolute working directory (required when resuming by session_id without resume_job_id or goal_id).",
        },
        sandbox: COMMON_RUN_PROPERTIES.sandbox,
        add_dirs: COMMON_RUN_PROPERTIES.add_dirs,
        allow_sandbox_escalation: {
          type: "boolean",
          default: false,
          description:
            "Must be true to widen sandbox permissions relative to the original job (narrowing is always allowed).",
        },
        model: COMMON_RUN_PROPERTIES.model,
        reasoning_effort: COMMON_RUN_PROPERTIES.reasoning_effort,
        goal_id: COMMON_RUN_PROPERTIES.goal_id,
        milestone_id: COMMON_RUN_PROPERTIES.milestone_id,
        images: COMMON_RUN_PROPERTIES.images,
        config: COMMON_RUN_PROPERTIES.config,
        skip_git_repo_check: COMMON_RUN_PROPERTIES.skip_git_repo_check,
        timeout_seconds: {
          type: "number",
          default: 600,
          description: "Maximum seconds to wait before aborting (default 600).",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "codex_review",
    description:
      "Run Codex's built-in non-interactive code review (`codex exec review`) on a Git repository.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Absolute path to the Git repository to review.",
        },
        goal_id: COMMON_RUN_PROPERTIES.goal_id,
        sandbox: COMMON_RUN_PROPERTIES.sandbox,
        uncommitted: {
          type: "boolean",
          description:
            "Review staged, unstaged, and untracked changes in the working tree.",
        },
        base: {
          type: "string",
          description: "Review changes against this base branch (e.g. 'main').",
        },
        commit: {
          type: "string",
          description: "Review changes introduced by a specific commit SHA.",
        },
        title: {
          type: "string",
          description: "Optional title to display in the review summary.",
        },
        prompt: {
          type: "string",
          description: "Optional custom review instructions.",
        },
        model: COMMON_RUN_PROPERTIES.model,
        reasoning_effort: COMMON_RUN_PROPERTIES.reasoning_effort,
        config: COMMON_RUN_PROPERTIES.config,
        timeout_seconds: {
          type: "number",
          default: 600,
          description: "Maximum seconds to wait before aborting (default 600).",
        },
      },
      required: [],
    },
  },
  {
    name: "codex_start",
    description:
      "Launch a persistent background Codex job and immediately return a job_id. Supports resuming an earlier job via `resume_job_id` (inherits exact session_id, cwd, sandbox, goal & milestone) with cross-process per-session mutual exclusion. Locks its callback target from trusted host context at dispatch time.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Detailed task instructions for Codex (optional when resume_job_id is given).",
        },
        resume_job_id: {
          type: "string",
          description:
            "Recommended for resume: creates a linked background job inheriting original session_id, cwd, sandbox, goal_id & milestone_id.",
        },
        session_id: {
          type: "string",
          description:
            "Optional exact session UUID to resume (requires explicit cwd if resume_job_id is not set; 'last' is rejected).",
        },
        allow_sandbox_escalation: {
          type: "boolean",
          default: false,
          description:
            "Must be true to widen sandbox permissions relative to the original job.",
        },
        transfer_callback: { type: "boolean", description: "Explicitly transfer the parent callback to this conversation." },
        notify_on_complete: {
          type: "boolean",
          description:
            "Whether the Sidecar should auto-callback the locked source conversation on completion.",
        },
        conversation_id: {
          type: "string",
          description:
            "IMPORTANT: Pass your current Antigravity Conversation ID (from <user_information>) so completion auto-callbacks route strictly back to this conversation when Codex finishes.",
        },
        project_id: {
          type: "string",
          description:
            "Optional Antigravity Project ID associated with conversation_id (auto-resolved via agentapi if omitted).",
        },
        ...COMMON_RUN_PROPERTIES,
        timeout_seconds: {
          type: "number",
          default: 1800,
          description: "Maximum runtime in seconds (default 1800 = 30 min).",
        },
      },
    },
  },
  {
    name: "codex_status",
    description:
      "Check status, live progress events, detached running PID state, callback delivery status, session_id, or final output of a background Codex job. Optionally waits up to wait_seconds.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description:
            "The job_id returned by codex_start. Omit to list all tracked jobs.",
        },
        wait_seconds: {
          type: "number",
          default: 0,
          description:
            "Optional long-poll wait time in seconds (0-120) to wait for the job to finish before returning.",
        },
      },
    },
  },
  {
    name: "codex_cancel",
    description:
      "Stop a running or detached-running (`running_detached`) background Codex job by job_id and release its session lock.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "The job_id to cancel/stop.",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "codex_goal",
    description:
      "Manage persistent multi-step Goals & Milestones shared with the Codex Bridge Sidecar panel (survives restarts and conversation compaction).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "get",
            "list",
            "create",
            "update_milestone",
            "add_milestone",
            "set_status",
            "set_active",
            "delete",
          ],
          default: "get",
          description: "Operation to perform on the persistent goal board.",
        },
        goal_id: { type: "string", description: "Target goal_id (defaults to active goal)." },
        title: { type: "string", description: "Title for a new goal or new milestone." },
        objective: { type: "string", description: "Detailed goal description (for create)." },
        cwd: { type: "string", description: "Working directory for the goal (for create)." },
        acceptance_criteria: {
          type: "array",
          items: { type: "string" },
          description: "Verifiable acceptance criteria list (for create).",
        },
        milestones: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              verification: { type: "string" },
            },
            required: ["title"],
          },
          description: "Initial ordered milestones list (for create).",
        },
        milestone_id: { type: "string", description: "Target milestone id like 'm1'." },
        status: { type: "string", description: "New goal or milestone status." },
        verification: { type: "string", description: "Verification command or check." },
        notes: { type: "string", description: "Verification outcome or notes." },
        blockers: {
          type: "array",
          items: { type: "string" },
          description: "Current blockers list (for set_status).",
        },
        max_iterations: { type: "number", description: "Max automatic progression iterations." },
      },
    },
  },
  {
    name: "codex_config",
    description:
      "Read or update persistent Codex Bridge preferences (language, model, reasoning_effort, sandbox, workflow_mode, progression_mode, max_auto_iterations) shared with the Codex Bridge UI panel, and list available local Codex models.",
    inputSchema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["zh", "en"],
          description: "UI & callback language ('zh' for Chinese, 'en' for English).",
        },
        role_mode: {
          type: "string",
          enum: ["orchestrator", "flexible"],
          description:
            "'orchestrator' (default): Antigravity acts as the mastermind (planning, writing specs, synthesizing reports, using lightweight tools/plugins) while delegating heavy coding/execution to Codex; 'flexible': use Codex on demand.",
        },
        model: {
          type: "string",
          description:
            "Set default Codex model slug (pass '' to follow ~/.codex/config.toml).",
        },
        reasoning_effort: {
          type: "string",
          enum: ["", "low", "medium", "high", "xhigh", "max", "ultra"],
          description:
            "Set default reasoning effort (pass '' to follow model/config default).",
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Set default sandbox policy.",
        },
        workflow_mode: {
          type: "string",
          enum: ["direct", "plan_first"],
          description:
            "Briefing mode: 'direct' executes immediately; 'plan_first' presents a brief for confirmation first.",
        },
        progression_mode: {
          type: "string",
          enum: ["manual", "notify", "autonomous"],
          description:
            "Goal progression mode: 'manual', 'notify', or 'autonomous'.",
        },
        max_auto_iterations: {
          type: "number",
          description: "Maximum automatic iterations before pausing (1-100, default 12).",
        },
        list_models: {
          type: "boolean",
          default: true,
          description: "Include available local Codex models in the output.",
        },
      },
    },
  },
  {
    name: "codex_info",
    description:
      "Check Codex Bridge health: shows resolved codex.exe path & version, active UI panel preferences, active goal progress, and tracked background jobs.",
    inputSchema: {
      type: "object",
      properties: { refresh: { type: "boolean", description: "Recheck the local CLI path and version." } },
    },
  },
];

function mapCommonOptions(args, resume = false) {
  const prefs = loadSettings();
  const linkedGoal = args.goal_id ? getGoal(args.goal_id) : getGoal();
  return {
    cwd: resume ? args.cwd : workingDirectory(args.cwd, linkedGoal),
    sandbox: args.sandbox || prefs.sandbox || "workspace-write",
    model: args.model || prefs.model || undefined,
    reasoningEffort:
      args.reasoning_effort || prefs.reasoningEffort || undefined,
    goalId: args.goal_id || undefined,
    milestoneId: args.milestone_id || undefined,
    profile: args.profile,
    addDirs: args.add_dirs,
    images: args.images,
    config: args.config,
    ephemeral:
      args.ephemeral !== undefined ? Boolean(args.ephemeral) : prefs.ephemeral,
    worktree: Boolean(args.worktree),
    skipGitRepoCheck:
      args.skip_git_repo_check !== undefined
        ? Boolean(args.skip_git_repo_check)
        : prefs.skipGitRepoCheck,
    outputSchema: args.output_schema,
    timeoutMs:
      typeof args.timeout_seconds === "number" && args.timeout_seconds > 0
        ? args.timeout_seconds * 1000
        : undefined,
  };
}

function resumeOptions(args, target) {
  return {
    ...mapCommonOptions(args, true),
    parentJobId: args.resume_job_id, sessionId: args.session_id,
    prompt: args.prompt, sandbox: args.sandbox, model: args.model, reasoningEffort: args.reasoning_effort,
    allowSandboxEscalation: args.allow_sandbox_escalation, transferCallback: args.transfer_callback,
    callbackTarget: target, notifyOnComplete: args.notify_on_complete, skipGitRepoCheck: args.skip_git_repo_check,
  };
}

function recordRunHistory(mode, opts, result) {
  appendHistory({
    mode, conversationId: opts.callbackTarget?.conversationId || null, transferredFrom: opts.transferredFrom || null,
    addDirs: opts.addDirs || [], skipGitRepoCheck: opts.skipGitRepoCheck,
    status: result.ok
      ? "completed"
      : result.cancelled
        ? "cancelled"
        : result.timedOut
          ? "timed_out"
          : "failed",
    model: opts.model || "(codex default)",
    reasoningEffort: opts.reasoningEffort || "(default)",
    sandbox: result.sandbox || opts.sandbox,
    goalId: opts.goalId || null,
    milestoneId: opts.milestoneId || null,
    cwd: result.cwd || opts.cwd || process.cwd(),
    sessionId: result.sessionId || null,
    durationMs: result.durationMs || 0,
    usage: result.usage || null,
    executionKind: "sync",
    prompt: opts.prompt,
    promptPreview: String(opts.prompt || "").replace(/\s+/g, " ").slice(0, 140),
  });
}

async function runWithGoal(opts, runtime) {
  let reservation = reserveGoalDispatch(opts.goalId, opts.milestoneId);
  try {
    return await runCodex({
      ...opts, ...runtime,
      onSpawn(child) {
        runtime.onSpawn?.(child);
        if (reservation) {
          recordGoalExecution(opts.goalId, { milestoneId: opts.milestoneId, reservationId: reservation });
          reservation = null;
        }
      },
    });
  } finally { abandonGoalDispatch(opts.goalId, reservation); }
}

async function handleToolCall(name, args = {}, meta = {}, signal) {
  validateBooleans(args);
  const progressToken = meta?.progressToken;

  if (name === "codex_info") {
    if (args.refresh !== undefined && typeof args.refresh !== "boolean") throw new Error("refresh must be boolean.");
    const resolved = resolveCodexBinary(args.refresh);
    const version = resolved ? getCodexVersion(resolved.path, args.refresh) : "not found";
    const jobs = jobManager.listJobs();
    const prefs = loadSettings();
    const toml = readCodexTomlDefaults();
    const activeGoal = getGoal();
    const hostTarget = extractTrustedHostCallbackTarget(meta);
    const effectiveModel =
      prefs.model || `${toml.model || "default"} (Codex 默认)`;
    const effectiveEffort =
      prefs.reasoningEffort ||
      `${toml.reasoningEffort || "default"} (Codex 默认)`;
    const goalLine = activeGoal
      ? `${activeGoal.title} (${activeGoal.id}) [${activeGoal.status}, ${activeGoal.milestones.filter((m) => m.status === "done").length}/${activeGoal.milestones.length} done]`
      : "(none)";

    const runningCount = jobs.filter(
      (j) => j.status === "running" || j.status === "running_detached"
    ).length;

    const text = [
      `Bridge: ${SERVER_INFO.name} v${SERVER_INFO.version}`,
      `Node: ${process.version}`,
      `Codex Binary: ${resolved ? `${resolved.path} (${resolved.source})` : "NOT FOUND"}`,
      `Codex Version: ${version}`,
      `Active Model: ${effectiveModel}`,
      `Reasoning Effort: ${effectiveEffort}`,
      `Role Division: ${prefs.roleMode}`,
      `Sandbox Policy: ${prefs.sandbox}`,
      `Workflow Mode: ${prefs.workflowMode}`,
      `Progression Mode: ${prefs.progressionMode} (maxAutoIterations=${prefs.maxAutoIterations})`,
      `UI Language: ${prefs.language}`,
      `Trusted Host Context: ${hostTarget ? `${hostTarget.conversationId} (${hostTarget.source})` : "(unavailable in shared MCP process; per-job callbacks stay in panel unless started with host context)"}`,
      `Active Goal: ${goalLine}`,
      `Tracked Jobs: ${jobs.length} (${runningCount} active)`,
    ].join("\n");
    return {
      content: [{ type: "text", text }],
      isError: !resolved,
    };
  }

  if (name === "codex_goal") {
    const action = args.action || "get";
    if (action === "list") {
      const store = listGoals();
      if (store.goals.length === 0) {
        return {
          content: [{ type: "text", text: "No persistent goals recorded yet." }],
        };
      }
      const lines = store.goals.map((g) => {
        const done = g.milestones.filter((m) => m.status === "done").length;
        const activeMark = g.id === store.activeGoalId ? "★ " : "";
        return `- ${activeMark}\`${g.id}\` [${g.status}] **${g.title}** (${done}/${g.milestones.length} done, iter ${g.iterationCount || 0}/${g.maxIterations || 12})`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    if (action === "get") {
      const goal = getGoal(args.goal_id);
      if (!goal) {
        return {
          content: [
            {
              type: "text",
              text: args.goal_id
                ? `Goal not found: ${args.goal_id}`
                : "No active goal. Create one with codex_goal(action='create', ...).",
            },
          ],
        };
      }
      return { content: [{ type: "text", text: formatGoalSummary(goal) }] };
    }

    if (action === "create") {
      const goal = createGoal({
        title: args.title,
        objective: args.objective,
        cwd: args.cwd,
        acceptanceCriteria: args.acceptance_criteria,
        milestones: args.milestones,
        maxIterations: args.max_iterations,
      });
      return {
        content: [
          {
            type: "text",
            text: `Created and activated persistent goal.\n\n${formatGoalSummary(goal)}`,
          },
        ],
      };
    }

    if (action === "add_milestone") {
      const { goal, milestone } = addMilestone(args.goal_id, {
        title: args.title,
        verification: args.verification,
        status: args.status || "pending",
      });
      return {
        content: [
          {
            type: "text",
            text: `Added milestone ${milestone.id} to ${goal.id}.\n\n${formatGoalSummary(goal)}`,
          },
        ],
      };
    }

    if (action === "update_milestone") {
      if (!args.milestone_id) {
        return {
          content: [{ type: "text", text: "Error: 'milestone_id' is required." }],
          isError: true,
        };
      }
      const { goal } = updateMilestone(args.goal_id, args.milestone_id, {
        status: args.status,
        notes: args.notes,
        verification: args.verification,
      });
      return {
        content: [
          {
            type: "text",
            text: `Updated milestone ${args.milestone_id}.\n\n${formatGoalSummary(goal)}`,
          },
        ],
      };
    }

    if (action === "set_status") {
      const goal = updateGoalStatus(args.goal_id, args.status, {
        blockers: args.blockers,
        notes: args.notes,
      });
      return {
        content: [
          {
            type: "text",
            text: `Updated goal ${goal.id}.\n\n${formatGoalSummary(goal)}`,
          },
        ],
      };
    }

    if (action === "set_active") {
      const goal = setActiveGoal(args.goal_id);
      return {
        content: [
          {
            type: "text",
            text: goal
              ? `Activated goal ${goal.id}.\n\n${formatGoalSummary(goal)}`
              : "Cleared active goal.",
          },
        ],
      };
    }

    if (action === "delete") {
      if (!args.goal_id) {
        return {
          content: [{ type: "text", text: "Error: 'goal_id' is required." }],
          isError: true,
        };
      }
      const ok = deleteGoal(args.goal_id);
      return {
        content: [
          {
            type: "text",
            text: ok
              ? `Deleted goal ${args.goal_id}.`
              : `Goal not found: ${args.goal_id}`,
          },
        ],
        isError: !ok,
      };
    }

    return {
      content: [{ type: "text", text: `Unknown goal action: ${action}` }],
      isError: true,
    };
  }

  if (name === "codex_config") {
    const patch = {};
    if (args.language !== undefined) patch.language = args.language;
    if (args.role_mode !== undefined) patch.roleMode = args.role_mode;
    if (args.model !== undefined) patch.model = args.model;
    if (args.reasoning_effort !== undefined)
      patch.reasoningEffort = args.reasoning_effort;
    if (args.sandbox !== undefined) patch.sandbox = args.sandbox;
    if (args.workflow_mode !== undefined)
      patch.workflowMode = args.workflow_mode;
    if (args.progression_mode !== undefined)
      patch.progressionMode = args.progression_mode;
    if (args.max_auto_iterations !== undefined)
      patch.maxAutoIterations = args.max_auto_iterations;

    const updated =
      Object.keys(patch).length > 0 ? saveSettings(patch) : loadSettings();
    const toml = readCodexTomlDefaults();
    const lines = [
      `## Active Codex Bridge Preferences`,
      `- Language: ${updated.language}`,
      `- Role Division: ${updated.roleMode}`,
      `- Model: ${updated.model || `(follow Codex default: ${toml.model || "auto"})`}`,
      `- Reasoning Effort: ${updated.reasoningEffort || `(follow default: ${toml.reasoningEffort || "auto"})`}`,
      `- Sandbox: ${updated.sandbox}`,
      `- Workflow Mode: ${updated.workflowMode}`,
      `- Progression Mode: ${updated.progressionMode} (maxAutoIterations=${updated.maxAutoIterations})`,
      `- Ephemeral: ${updated.ephemeral}`,
    ];

    if (args.list_models !== false) {
      const models = readCodexModelsCatalog();
      if (models.length > 0) {
        lines.push(`\n## Available Local Codex Models (${models.length})`);
        for (const m of models) {
          const efforts = m.efforts.map((e) => e.effort).join(", ");
          lines.push(
            `- \`${m.slug}\` (${m.displayName})${efforts ? ` — efforts: ${efforts}` : ""}`
          );
        }
      }
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }

  if (name === "codex_run") {
    if (!args.prompt || typeof args.prompt !== "string") {
      return {
        content: [{ type: "text", text: "Error: 'prompt' is required." }],
        isError: true,
      };
    }
    const opts = {
      mode: "run",
      prompt: args.prompt,
      ...mapCommonOptions(args), callbackTarget: extractTrustedHostCallbackTarget(meta, args),
    };
    const result = await runWithGoal(opts, {
      signal,
      onProgress: ({ eventCount, summary }) => {
        sendProgress(progressToken, eventCount, summary);
      },
    });
    if (opts.goalId) {
      recordGoalExecution(opts.goalId, {
        milestoneId: opts.milestoneId,
        sessionId: result.sessionId,
        incrementIteration: false,
      });
    }
    recordRunHistory("run", opts, result);
    return {
      content: [{ type: "text", text: formatCodexResult(result) }],
      isError: !result.ok,
    };
  }

  if (name === "codex_resume") {
    if (!args.prompt || typeof args.prompt !== "string") {
      return {
        content: [{ type: "text", text: "Error: 'prompt' is required." }],
        isError: true,
      };
    }

    const opts = resolveResume(resumeOptions(args, extractTrustedHostCallbackTarget(meta, args)), readPersistedJobs());
    const { sessionId: sid, cwd } = opts;
    reconcilePersistedJobs(jobManager._localRunningIds);
    // Cross-process per-session mutual exclusion
    const syncLockId = `sync_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const active = jobManager.findActiveJobForSession(sid);
    if (active) {
      return {
        content: [
          {
            type: "text",
            text: `Session ${sid} is already active in job ${active.id} (status=${active.status}, PID=${active.pid || "?"}). Wait for it to finish or stop it with codex_cancel(job_id="${active.id}") before resuming.`,
          },
        ],
        isError: true,
      };
    }
    const lockRes = acquireSessionLock(sid, {
      jobId: syncLockId,
      ownerPid: process.pid,
      cwd,
    });
    if (!lockRes.acquired) {
      return {
        content: [
          {
            type: "text",
            text: `Session ${sid} is currently locked by active job ${lockRes.existing?.jobId || "unknown"} (PID=${lockRes.existing?.pid || "?"}). Refusing concurrent resume.`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await runWithGoal(opts, {
        signal,
        onSpawn: (child) => {
          if (child.pid && !updateSessionLockPid(sid, lockRes.ownerToken, child.pid, processIdentity(child.pid))) throw new Error("Lost session lock.");
        },
        onProgress: ({ eventCount, summary }) => {
          sendProgress(progressToken, eventCount, summary);
        },
      });
      if (opts.goalId) {
        recordGoalExecution(opts.goalId, {
          milestoneId: opts.milestoneId,
          sessionId: result.sessionId || sid,
          incrementIteration: false,
        });
      }
      recordRunHistory("resume", opts, result);
      return {
        content: [{ type: "text", text: formatCodexResult(result) }],
        isError: !result.ok,
      };
    } finally {
      releaseSessionLock(sid, lockRes.ownerToken);
    }
  }

  if (name === "codex_review") {
    const common = mapCommonOptions(args);
    const opts = {
      mode: "review",
      cwd: common.cwd, sandbox: common.sandbox, callbackTarget: extractTrustedHostCallbackTarget(meta, args),
      uncommitted: Boolean(args.uncommitted),
      base: args.base,
      commit: args.commit,
      title: args.title,
      prompt: args.prompt,
      model: common.model,
      reasoningEffort: common.reasoningEffort,
      config: args.config,
      timeoutMs:
        typeof args.timeout_seconds === "number" && args.timeout_seconds > 0
          ? args.timeout_seconds * 1000
          : 600_000,
    };
    const result = await runCodex({
      ...opts,
      signal,
      onProgress: ({ eventCount, summary }) => {
        sendProgress(progressToken, eventCount, summary);
      },
    });
    recordRunHistory("review", opts, result);
    return {
      content: [{ type: "text", text: formatCodexResult(result) }],
      isError: !result.ok,
    };
  }

  if (name === "codex_start") {
    const trustedTarget = extractTrustedHostCallbackTarget(meta, args);

    // Structured resume by previous job_id
    if (args.resume_job_id) {
      const { job, reused } = jobManager.resumeFromJob(args.resume_job_id, resumeOptions(args, trustedTarget));

      const lines = reused
        ? [
            `Session is already active — reused existing job instead of spawning a duplicate.`,
            `Job ID: ${job.id}`,
            `Status: ${job.status}`,
            `PID: ${job.pid || "(spawning)"}`,
            `Session ID: ${job.sessionId}`,
          ]
        : [
            `Started resumed background Codex job.`,
            `Job ID: ${job.id}`,
            `Parent Job: ${job.parentJobId}`,
            `Session ID: ${job.sessionId}`,
            `Working Dir: ${job.cwd}`,
            `Sandbox: ${job.sandbox}`,
            `Callback: ${job.callbackStatus}${job.callbackTarget ? ` -> ${job.callbackTarget.conversationId}` : ""}`,
          ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    if (!args.prompt || typeof args.prompt !== "string") {
      return {
        content: [{ type: "text", text: "Error: 'prompt' is required." }],
        isError: true,
      };
    }

    const mode = args.session_id !== undefined ? "resume" : "run";
    const common = mode === "resume" ? resolveResume(resumeOptions(args, trustedTarget), readPersistedJobs()) : mapCommonOptions(args);

    const { job, reused } = jobManager.startJob({
      mode,
      sessionId: args.session_id,
      prompt: args.prompt,
      notifyOnComplete: args.notify_on_complete,
      callbackTarget: trustedTarget,
      ...common,
    });

    if (reused) {
      return {
        content: [
          {
            type: "text",
            text: `Session ${job.sessionId} is already active in job ${job.id} (status=${job.status}, PID=${job.pid || "?"}). Returned existing job instead of starting a second process.`,
          },
        ],
      };
    }

    const lines = [
      `Started background Codex job.`,
      `Job ID: ${job.id}`,
      `Mode: ${job.mode}`,
      `Model: ${job.model || "(codex default)"}`,
      `Reasoning Effort: ${job.reasoningEffort || "(default)"}`,
      `Sandbox: ${job.sandbox}`,
      `Working Dir: ${job.cwd}`,
    ];
    if (job.goalId) {
      lines.push(
        `Goal: ${job.goalId}${job.milestoneId ? ` / ${job.milestoneId}` : ""}`
      );
    }
    lines.push(
      `Callback: ${job.callbackStatus}${job.callbackTarget ? ` -> ${job.callbackTarget.conversationId}` : " (result stays in panel)"}`
    );
    lines.push(
      `Use codex_status(job_id="${job.id}", wait_seconds=30) to poll progress.`
    );
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }

  if (name === "codex_status") {
    if (!args.job_id) {
      const jobs = jobManager.listJobs();
      if (jobs.length === 0) {
        return {
          content: [{ type: "text", text: "No background Codex jobs recorded." }],
        };
      }
      const lines = jobs.map(
        (j) =>
          `- ${j.id} [${j.status}]${j.pid ? ` pid=${j.pid}` : ""} sandbox=${j.sandbox}${j.goalId ? ` goal=${j.goalId}` : ""} cb=${j.callbackStatus} session=${j.sessionId || "pending"} | "${j.promptPreview}"`
      );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }

    const waitSeconds =
      typeof args.wait_seconds === "number" && args.wait_seconds > 0
        ? args.wait_seconds
        : 0;
    const job = await jobManager.getStatus(args.job_id, waitSeconds);
    if (!job) {
      return {
        content: [{ type: "text", text: `Job not found: ${args.job_id}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: jobManager.formatJobStatus(job) }],
      isError: job.status === "failed",
    };
  }

  if (name === "codex_cancel") {
    if (!args.job_id) {
      return {
        content: [{ type: "text", text: "Error: 'job_id' is required." }],
        isError: true,
      };
    }
    const res = await jobManager.stopJob(args.job_id);
    if (!res.found) {
      return {
        content: [{ type: "text", text: `Job not found: ${args.job_id}` }],
        isError: true,
      };
    }
    if (res.alreadyFinished) {
      return {
        content: [
          {
            type: "text",
            text: `Job ${args.job_id} already finished with status: ${res.status}`,
          },
        ],
      };
    }
    if (!res.cancelled) {
      return {
        content: [{ type: "text", text: res.error || `Failed to stop job ${args.job_id}.` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Stopped job ${args.job_id} and released its session lock.` }],
    };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (id === undefined || id === null) {
    if (method === "notifications/cancelled") {
      const reqId = params?.requestId;
      const controller = activeRequests.get(reqId);
      if (controller) {
        controller.abort();
      }
    }
    return;
  }

  try {
    if (method === "initialize") {
      const clientVersion = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion)
        ? clientVersion
        : SUPPORTED_PROTOCOL_VERSIONS[0];

      sendResult(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
        instructions:
          "Use codex_goal to create and track persistent multi-step goals & milestones, codex_run/codex_resume/codex_review for synchronous tasks, codex_start/codex_status/codex_cancel for persistent background workers with per-job locked callbacks and cross-process session locks, and codex_config/codex_info to inspect or update active preferences.",
      });
      return;
    }

    if (method === "ping") {
      sendResult(id, {});
      return;
    }

    if (method === "tools/list") {
      sendResult(id, { tools: TOOLS });
      return;
    }

    if (method === "resources/list") {
      sendResult(id, { resources: [] });
      return;
    }

    if (method === "prompts/list") {
      sendResult(id, { prompts: [] });
      return;
    }

    if (method === "tools/call") {
      const controller = new AbortController();
      activeRequests.set(id, controller);
      try {
        const result = await handleToolCall(
          params?.name,
          params?.arguments || {},
          params?._meta || {},
          controller.signal
        );
        sendResult(id, result);
      } catch (err) {
        sendResult(id, {
          content: [
            {
              type: "text",
              text: `Codex bridge error: ${err?.message || String(err)}`,
            },
          ],
          isError: true,
        });
      } finally {
        activeRequests.delete(id);
      }
      return;
    }

    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    log("Unhandled error:", err?.stack || String(err));
    sendError(id, -32603, err?.message || "Internal server error");
  }
}

let inputBuffer = "";
process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let newlineIdx;
  while ((newlineIdx = inputBuffer.indexOf("\n")) !== -1) {
    const line = inputBuffer.slice(0, newlineIdx).trim();
    inputBuffer = inputBuffer.slice(newlineIdx + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      log("Malformed JSON on stdin:", err.message);
      sendError(null, -32700, "Parse error");
      continue;
    }

    void handleRequest(msg);
  }
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const controller of activeRequests.values()) {
    controller.abort();
  }
  await jobManager.cancelAll();
  const deadline = Date.now() + 6000;
  while (activeRequests.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  process.exit(0);
}

process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log(`Started ${SERVER_INFO.name} v${SERVER_INFO.version}`);
