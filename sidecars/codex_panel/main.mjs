import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readOnlySnapshot } from "../../server/file-store.js";
import { problem, validateBooleans } from "../../server/validation.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SidecarApp, Response } from "sidecar_sdk";
import {
  loadSettings,
  saveSettings,
  resetSettings,
  loadHistory,
  readCodexTomlDefaults,
  readCodexModelsCatalog,
} from "../../server/settings-store.js";
import {
  listGoals, iterationLimit,
  getGoal,
  createGoal,
  setActiveGoal,
  updateGoalStatus,
  addMilestone,
  updateMilestone,
  deleteGoal,
} from "../../server/goal-store.js";
import {
  JobManager,
  normalizeCallbackTarget,
  reconcilePersistedJobs,
  claimCallback, beginCallbackSend, finishCallback, readPersistedJobs, callbackTerminal,
} from "../../server/job-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, "..", "..");
const LOGO_PATH = join(PLUGIN_ROOT, "assets", "logo.png");
const ID_RE = /^[0-9a-f-]{8,}$/i;

const app = new SidecarApp();
const jobManager = new JobManager();

const runFile = promisify(execFile);
async function agentApi(args, projectId) {
  const host = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const { stdout } = await runFile(host || "agentapi", host ? ["agentapi", ...args] : args, {
    timeout: 8000, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 1024 * 1024,
    env: projectId ? { ...process.env, ANTIGRAVITY_PROJECT_ID: projectId } : process.env
  });
  return stdout.trim() ? JSON.parse(stdout) : {};
}

let probePromise;
function runtimeProbe(refresh) {
  if (refresh || !probePromise) {
    probePromise = runFile(process.execPath, [join(__dirname, "runtime-probe.mjs")], {
      timeout: 9000, windowsHide: true
    }).then(({ stdout }) => JSON.parse(stdout)).catch(err => ({
      found: false, path: null, source: null, version: null, error: err.message
    }));
  }
  return probePromise;
}

function readText(file) {
  return readFileSync(join(__dirname, file), "utf-8");
}

/**
 * Validate a conversationId against Antigravity's agentapi metadata endpoint
 * and return its authoritative { conversationId, projectId } or { valid: false }.
 */
async function verifyConversationTarget(conversationId, fallbackProjectId = "") {
  if (!conversationId || !ID_RE.test(conversationId)) {
    return { valid: false, reason: "Invalid conversationId format." };
  }
  try {
    const data = await agentApi(["get-conversation-metadata", conversationId]);
    if (data && data.error) {
      return { valid: false, temporary: !/not found|expired|does not exist/i.test(String(data.error)), reason: String(data.error) };
    }
    const metaEvent =
      data?.response?.conversationMetadata ||
      data?.response?.conversation_metadata ||
      data?.conversationMetadata ||
      data?.conversation_metadata;
    const meta = metaEvent?.metadata;
    if (!meta) {
      return {
        valid: false,
        temporary: true, reason: "Conversation metadata temporarily unavailable.",
      };
    }
    const projectId = meta.projectId || meta.project_id || "";
    if (fallbackProjectId && projectId !== fallbackProjectId) {
      return { valid: false, temporary: !projectId, reason: "Locked project and conversation metadata differ." };
    }
    return { valid: true, conversationId, projectId };
  } catch (err) {
    return {
      valid: false,
      temporary: true, reason: err?.message || "Failed to verify conversation metadata.",
    };
  }
}

function buildCallbackMessage(job, settings, goal) {
  const summary = job.resultSummary || {};
  const mode = settings.progressionMode;
  const isEn = settings.language === "en";
  const hasExactSession = Boolean(
    job.sessionId && String(job.sessionId).trim() && job.sessionId !== "last"
  );
  const limit = goal ? iterationLimit(goal, settings) : settings.maxAutoIterations;
  const used = goal ? (goal.iterationCount || 0) - (goal.iterationBaseline || 0) : 0;
  const isAutonomousEligible =
    mode === "autonomous" &&
    goal &&
    goal.status === "active" &&
    used < limit;

  const lines = [
    isEn
      ? `[Codex Bridge Auto-Callback] Background Codex job finished (${job.status})`
      : `[Codex Bridge Auto-Callback] 后台 Codex 任务已完成（${job.status}）`,
    ``,
    `- **Job ID**: \`${job.id}\``,
    `- **Status**: \`${job.status}\` | **Model**: \`${job.model || "default"}\` | **Effort**: \`${job.reasoningEffort || "default"}\` | **Sandbox**: \`${job.sandbox || "workspace-write"}\``,
    `- **Session ID**: \`${hasExactSession ? job.sessionId : "(none)"}\``,
    `- **Working Dir**: \`${job.cwd}\``,
  ];

  if (job.parentJobId) {
    lines.push(`- **Resumed From**: \`${job.parentJobId}\``);
  }
  if (summary.durationMs) {
    lines.push(`- **Duration**: ${(summary.durationMs / 1000).toFixed(1)}s`);
  }
  if (goal) {
    const done = goal.milestones.filter((m) => m.status === "done").length;
    lines.push(
      `- **Goal**: ${goal.title} (\`${goal.id}\`, ${done}/${goal.milestones.length} done, iter ${used}/${limit})`
    );
    if (job.milestoneId) {
      const ms = goal.milestones.find((m) => m.id === job.milestoneId);
      if (ms) {
        lines.push(
          `- **Milestone**: \`${ms.id}\` — ${ms.title}${ms.verification ? ` (verify: \`${ms.verification}\`)` : ""}`
        );
      }
    }
  }

  if (job.goalId && !goal) lines.push(isEn ? "Linked goal has been deleted." : "此任务绑定的目标已删除。");
  if (summary.fileChanges?.length) {
    const files = summary.fileChanges
      .slice(0, 12)
      .map((f) => `  - [${f.kind || "modified"}] ${f.path}`)
      .join("\n");
    lines.push(
      isEn
        ? `\n**File Changes (${summary.fileChanges.length})**:\n${files}`
        : `\n**改动文件 (${summary.fileChanges.length})**:\n${files}`
    );
  }

  if (summary.lastMessage) {
    const preview = summary.lastMessage.slice(0, 1800);
    lines.push(
      isEn
        ? `\n**Codex Summary**:\n${preview}${summary.lastMessage.length > 1800 ? "\n...(truncated; call codex_status for full output)" : ""}`
        : `\n**Codex 回复摘要**:\n${preview}${summary.lastMessage.length > 1800 ? "\n...(已截断，可调用 codex_status 查看完整输出)" : ""}`
    );
  } else if (job.error) {
    lines.push(
      isEn ? `\n**Error**: ${job.error}` : `\n**错误信息**: ${job.error}`
    );
  }

  lines.push("");
  if (isAutonomousEligible) {
    if (hasExactSession) {
      lines.push(
        isEn
          ? `**Progression Instruction (Autonomous Mode)**: Immediately verify the result & milestone checks, update the milestone via \`codex_goal(action="update_milestone")\`; if verification failed, call \`codex_start(resume_job_id="${job.id}", prompt="...")\` (exact Session ID: \`${job.sessionId}\`) to fix it, or if passed and pending milestones remain, call \`codex_start\` for the next milestone until complete (pause & report if user input is required).`
          : `**推进指令（目标持续自动推进模式）**：请立刻验收上述结果与里程碑验证条件，调用 \`codex_goal(action="update_milestone")\` 更新里程碑状态；若未通过请调用 \`codex_start(resume_job_id="${job.id}", prompt="...")\`（确切 Session ID: \`${job.sessionId}\`）返工，若已通过且还有待办里程碑，请自动调用 \`codex_start\` 推进下一阶段直到目标达成（如遇需用户决策的阻塞点则暂停并汇报）。`
      );
    } else {
      lines.push(
        isEn
          ? `**Progression Notice**: This job has no verified Session ID, so automatic resume is disabled. Inspect the result, update milestone status, and ask the user before starting a new session.`
          : `**推进提示**：该任务缺少确切的 Session ID，已禁用自动续跑（不再回退到 last）。请先核验结果并汇报给用户由人工处理。`
      );
    }
  } else if (mode === "autonomous" && goal && goal.status !== "active") {
    lines.push(
      isEn
        ? `**Progression Notice**: Goal status is \`${goal.status}\`, so autonomous progression stopped. Please report the verification summary to the user.`
        : `**推进提示**：目标当前状态为 \`${goal.status}\`，已停止自动推进。请先向用户汇报本次验收结果。`
    );
  } else if (
    mode === "autonomous" &&
    goal &&
    used >= limit
  ) {
    lines.push(
      isEn
        ? `**Progression Notice**: Reached max automatic iterations (${used}/${limit}). Auto-paused; report current progress and ask whether to continue.`
        : `**推进提示**：已达到目标最大自动轮次上限（${used}/${limit}），已自动暂停。请汇报当前进展与验收结果，询问用户是否继续。`
    );
  } else {
    lines.push(
      isEn
        ? `**Progression Instruction (Notify & Verify Mode)**: Verify the Codex output above, update any linked milestone, present verified findings clearly, and propose the next step.`
        : `**推进指令（完工自动验收模式）**：请验收上述 Codex 执行结果、更新对应里程碑状态（如有），向用户清晰汇报发现与结论，并给出下一步建议。`
    );
  }

  return lines.join("\n");
}

/**
 * Deliver a callback strictly to job.callbackTarget (never falls back to any global/current conversation).
 * Marks `sent` ONLY AFTER confirmed delivery. Failures stay visibly marked `failed` for manual retry.
 */
async function deliverCallbackForJob(id, settings, retry = false) {
  const job = claimCallback(id, retry);
  if (!job.callbackClaim) return { ok: false, status: job.callbackStatus, error: job.callbackError };
  const finish = patch => finishCallback(id, job.callbackClaim, patch);
  const target = normalizeCallbackTarget(job.callbackTarget);
  if (!target) {
    const updated = finish({
      callbackStatus: "unrouted",
      callbackSent: false,
      callbackError:
        "No trusted source conversation locked on this job; result kept in panel.",
    });
    return { ok: false, status: "unrouted", job: updated };
  }

  // Verify the locked conversation is still valid before sending
  const verified = await verifyConversationTarget(
    target.conversationId,
    target.projectId
  );
  if (!verified.valid) {
    const updated = finish({
      callbackStatus: verified.temporary ? "failed" : "unrouted",
      callbackSent: false,
      callbackError: `Locked source conversation unavailable (${verified.reason}); result kept in panel.`,
    });
    return { ok: false, status: updated.callbackStatus, error: verified.reason, job: updated };
  }

  try {
    const goal = job.goalId ? getGoal(job.goalId) : null;
    const message = buildCallbackMessage(job, settings, goal);
    beginCallbackSend(id, job.callbackClaim);
    const sendRes = await agentApi(["send-message", verified.conversationId, message], verified.projectId);
    if (sendRes && sendRes.error) {
      throw new Error(String(sendRes.error));
    }
    const updated = finish({
      callbackStatus: "sent",
      callbackSent: true,
      callbackAt: new Date().toISOString(),
      callbackError: null,
    });
    console.log(
      `[codex-panel] Delivered callback for job ${job.id} -> conv ${verified.conversationId} (${settings.progressionMode})`
    );
    return { ok: true, status: "sent", job: updated };
  } catch (err) {
    const errMsg = err?.message || String(err);
    const updated = finish({
      callbackStatus: "failed",
      callbackSent: false,
      callbackError: errMsg,
    });
    console.error(
      `[codex-panel] Callback delivery failed for job ${job.id} -> conv ${verified.conversationId}:`,
      errMsg
    );
    return { ok: false, status: "failed", error: errMsg, job: updated };
  }
}

let watcherBusy = false;
async function checkAndDispatchCallbacks() {
  if (watcherBusy) return;
  watcherBusy = true;
  try {
    const settings = loadSettings();
    const jobs = reconcilePersistedJobs(jobManager._localRunningIds);
    if (settings.progressionMode === "manual") return;

    const pending = jobs.filter(
      (j) =>
        j &&
        j.notifyOnComplete &&
        (j.callbackStatus === "pending" || (j.callbackStatus === "sending" && !(Date.parse(j.callbackLeaseUntil) > Date.now()))) &&
        !j.callbackSent &&
        callbackTerminal.has(j.status)
    );
    for (const job of pending) {
      try { await deliverCallbackForJob(job.id, settings); }
      catch (err) { if (err.status !== 409) console.error("[codex-panel] callback:", err.message); }
    }
  } finally {
    watcherBusy = false;
  }
}

/**
 * PURE READ-ONLY state snapshot.
 * Never mutates settings.json or any global conversation binding!
 */
async function buildState(query = {}) {
  const convFromQuery =
    typeof query.conversationId === "string" ? query.conversationId.trim() : "";
  const convId = convFromQuery || app.config.conversationId || "";

  const codex = await runtimeProbe(query.refresh === "1");
  return readOnlySnapshot(() => {
    const models = readCodexModelsCatalog();
    const tomlDefaults = readCodexTomlDefaults();
    const settings = loadSettings();
    const goalsStore = listGoals();
    const jobs = readPersistedJobs().map(publicJob);
    const history = loadHistory().map(row => {
      const job = row.jobId && jobs.find(j => j.id === row.jobId);
      return { cwd: job?.cwd || null, conversationId: job?.conversationId || null, transferredFrom: job?.transferredFrom || null,
        durationMs: null, usage: null, model: "", reasoningEffort: "", ...row };
    });
    return { pluginVersion: "1.5.0", codex, tomlDefaults, models, settings,
      goalsStore, jobs, history, conversationId: convId || null };
  });
}

function publicJob({ lockToken, callbackClaim, processIdentity, ...job }) {
  return { ...job, conversationId: job.callbackTarget?.conversationId || job.conversationId || null,
    transferredFrom: job.transferredFrom || null, durationMs: job.durationMs ?? job.resultSummary?.durationMs ?? null,
    usage: job.usage ?? job.resultSummary?.usage ?? null, model: job.model || "", reasoningEffort: job.reasoningEffort || "" };
}

function api(route, handler, method) {
  app.api(route, async data => {
    try {
      validateBooleans(data);
      return await handler(data);
    } catch (err) {
      const status = err.status || 500;
      return new Response(JSON.stringify({ ok: false, error: err.message, ...err.details }),
        { status, contentType: "application/json" });
    }
  }, method);
}

app.page("/", () =>
  new Response(readText("index.html"), {
    contentType: "text/html; charset=utf-8",
  })
);

api(
  "/styles.css",
  () =>
    new Response(readText("styles.css"), {
      contentType: "text/css; charset=utf-8",
    }),
  "GET"
);

function readClassicAppBundle() {
  const stripExport = (src) => src.replace(/^export\s+/gm, "");
  const stripLocalImport = (src) =>
    src.replace(/^import\s+[\s\S]*?from\s+["']\.\/[^"']+["'];?\r?\n/gm, "");
  return [
    "(() => {",
    '"use strict";',
    stripExport(readText("i18n.mjs")),
    stripExport(readText("view-model.mjs")),
    stripLocalImport(readText("app.js")),
    "})();",
  ].join("\n");
}

api(
  "/app.js",
  () =>
    new Response(readClassicAppBundle(), {
      contentType: "application/javascript; charset=utf-8",
    }),
  "GET"
);

for (const file of ["i18n.mjs", "view-model.mjs"]) {
  api("/" + file, () => new Response(readText(file), {
    contentType: "application/javascript; charset=utf-8",
  }), "GET");
}

api(
  "/logo.png",
  () => {
    if (!existsSync(LOGO_PATH)) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(readFileSync(LOGO_PATH), {
      contentType: "image/png",
      headers: { "Cache-Control": "private, max-age=3600" },
    });
  },
  "GET"
);

// Pure read-only state endpoint
api("/api/state", (data) => buildState(data), "GET");

api(
  "/api/settings",
  (data) => {
    const settings = saveSettings({
      language: data.language,
      roleMode: data.roleMode,
      model: data.model,
      reasoningEffort: data.reasoningEffort,
      sandbox: data.sandbox,
      workflowMode: data.workflowMode,
      progressionMode: data.progressionMode,
      maxAutoIterations: data.maxAutoIterations,
      ephemeral: data.ephemeral,
      skipGitRepoCheck: data.skipGitRepoCheck,
    });
    return { ok: true, settings };
  },
  "POST"
);

api(
  "/api/reset",
  () => {
    const settings = resetSettings();
    return { ok: true, settings };
  },
  "POST"
);

// Structured background resume by old job_id (inherits exact sessionId, cwd, sandbox, goal, milestone)
api(
  "/api/jobs/resume",
  async data => {
    if (typeof data.jobId !== "string" || !data.jobId.trim()) throw problem(400, "jobId is required.");
    const old = readPersistedJobs().find(j => j.id === data.jobId);
    if (!old) throw problem(404, "Job not found: " + data.jobId);
    const source = old.callbackTarget?.conversationId;
    const target = data.conversationId || app.config.conversationId;
    if (data.keepOriginalCallback && data.transferCallback) throw problem(400, "Conflicting callback choices.");
    if (source && target && source !== target && !data.keepOriginalCallback && !data.transferCallback) {
      throw problem(409, "Cross-conversation resume requires a callback choice.", {
        code: "CROSS_CONVERSATION_RESUME", sourceConversationId: source, targetConversationId: target, jobId: old.id });
    }
    let callbackTarget;
    if (data.transferCallback) {
      const verified = await verifyConversationTarget(target);
      if (!verified.valid) throw problem(verified.temporary ? 500 : 400, verified.reason);
      callbackTarget = { conversationId: target, projectId: verified.projectId, source: "sidecar_host" };
    }
    const { job, reused, reason } = jobManager.resumeFromJob(old.id, {
      prompt: data.prompt, sandbox: data.sandbox, cwd: data.cwd,
      sessionId: data.sessionId ?? data.session_id, goalId: data.goalId ?? data.goal_id,
      milestoneId: data.milestoneId ?? data.milestone_id, addDirs: data.addDirs ?? data.add_dirs,
      notifyOnComplete: data.notifyOnComplete ?? data.notify_on_complete, skipGitRepoCheck: data.skipGitRepoCheck ?? data.skip_git_repo_check,
      ephemeral: data.ephemeral, allowSandboxEscalation: data.allowSandboxEscalation ?? data.allow_sandbox_escalation,
      transferCallback: data.transferCallback, callbackTarget });
    return { ok: true, reused, reason, job: publicJob(jobManager._serializeJob(job)), jobs: readPersistedJobs().map(publicJob) };
  }, "POST"
);

// Stop a running or detached-running job by PID and release its session lock
api(
  "/api/jobs/stop",
  async (data) => {
    const jobId = typeof data.jobId === "string" ? data.jobId.trim() : "";
    if (!jobId) {
      return new Response(
        JSON.stringify({ ok: false, error: "jobId is required." }),
        { status: 400, contentType: "application/json" }
      );
    }
    const res = await jobManager.stopJob(jobId);
    if (!res.found) throw problem(404, "Job not found.");
    if (!res.cancelled && !res.alreadyFinished) throw problem(409, res.error);
    return {
      ok: true,
      ...res,
      jobs: readPersistedJobs().map(publicJob),
    };
  },
  "POST"
);

// Retry a failed callback strictly to the job's locked callbackTarget (never to another conversation)
api(
  "/api/jobs/retry-callback",
  async data => {
    if (!data.jobId) throw problem(400, "jobId is required.");
    const res = await deliverCallbackForJob(data.jobId, loadSettings(), true);
    if (!res.ok) throw problem(res.status === "unrouted" ? 409 : 500, res.error || "Callback unavailable.");
    return { ...res, job: publicJob(res.job), jobs: readPersistedJobs().map(publicJob) };
  }, "POST"
);

api(
  "/api/goals",
  (data) => {
    const goal = createGoal({
      title: data.title,
      objective: data.objective,
      cwd: data.cwd,
      acceptanceCriteria: data.acceptanceCriteria,
      milestones: data.milestones,
      maxIterations: data.maxIterations,
    });
    return { ok: true, goal, goalsStore: listGoals() };
  },
  "POST"
);

api(
  "/api/goals/status",
  (data) => {
    if (data.activateOnly) {
      const goal = setActiveGoal(data.goalId);
      return { ok: true, goal, goalsStore: listGoals() };
    }
    const goal = updateGoalStatus(data.goalId, data.status, {
      blockers: data.blockers,
      notes: data.notes,
    });
    return { ok: true, goal, goalsStore: listGoals() };
  },
  "POST"
);

api(
  "/api/goals/milestone",
  (data) => {
    if (data.add) {
      const res = addMilestone(data.goalId, {
        title: data.title,
        verification: data.verification,
        status: data.status || "pending",
      });
      return { ok: true, ...res, goalsStore: listGoals() };
    }
    const res = updateMilestone(data.goalId, data.milestoneId, {
      status: data.status,
      notes: data.notes,
      verification: data.verification,
    });
    return { ok: true, ...res, goalsStore: listGoals() };
  },
  "POST"
);

api(
  "/api/goals/delete",
  (data) => {
    if (!data.goalId) throw problem(400, "goalId is required.");
    const deleted = deleteGoal(data.goalId);
    if (!deleted) throw problem(404, "Goal not found.");
    return { ok: deleted, goalsStore: listGoals() };
  },
  "POST"
);

// Start background callback watcher
const watcherMs = Math.max(
  200,
  Number(process.env.CODEX_PANEL_WATCHER_MS) || 2500
);
if (process.env.CODEX_PANEL_DISABLE_WATCHER !== "1") {
  setInterval(() => {
    void checkAndDispatchCallbacks().catch(err => console.error("[codex-panel] maintenance:", err.message));
  }, watcherMs).unref();
}

app.run();
