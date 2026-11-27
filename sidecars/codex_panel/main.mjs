import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SidecarApp, Response } from "sidecar_sdk";
import {
  resolveCodexBinary,
  getCodexVersion,
} from "../../server/codex-runner.js";
import {
  loadSettings,
  saveSettings,
  resetSettings,
  loadHistory,
  readCodexTomlDefaults,
  readCodexModelsCatalog,
} from "../../server/settings-store.js";
import {
  listGoals,
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
  updateJobCallbackState,
} from "../../server/job-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, "..", "..");
const LOGO_PATH = join(PLUGIN_ROOT, "assets", "logo.png");
const ID_RE = /^[0-9a-f-]{8,}$/i;

const app = new SidecarApp();
const jobManager = new JobManager();

function readText(file) {
  return readFileSync(join(__dirname, file), "utf-8");
}

/**
 * Validate a conversationId against Antigravity's agentapi metadata endpoint
 * and return its authoritative { conversationId, projectId } or { valid: false }.
 */
function verifyConversationTarget(conversationId, fallbackProjectId = "") {
  if (!conversationId || !ID_RE.test(conversationId)) {
    return { valid: false, reason: "Invalid conversationId format." };
  }
  try {
    const data = app.getConversationMetadata(conversationId);
    if (data && data.error) {
      return { valid: false, reason: String(data.error) };
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
        reason: "Conversation metadata not found or expired.",
      };
    }
    const projectId =
      meta.projectId || meta.project_id || fallbackProjectId || "";
    return { valid: true, conversationId, projectId };
  } catch (err) {
    return {
      valid: false,
      reason: err?.message || "Failed to verify conversation metadata.",
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
  const isAutonomousEligible =
    mode === "autonomous" &&
    goal &&
    goal.status === "active" &&
    (goal.iterationCount || 0) <
      (goal.maxIterations || settings.maxAutoIterations || 12);

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
      `- **Goal**: ${goal.title} (\`${goal.id}\`, ${done}/${goal.milestones.length} done, iter ${goal.iterationCount || 0}/${goal.maxIterations || settings.maxAutoIterations})`
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
    (goal.iterationCount || 0) >=
      (goal.maxIterations || settings.maxAutoIterations || 12)
  ) {
    lines.push(
      isEn
        ? `**Progression Notice**: Reached max automatic iterations (${goal.iterationCount}/${goal.maxIterations || settings.maxAutoIterations}). Auto-paused; report current progress and ask whether to continue.`
        : `**推进提示**：已达到目标最大自动轮次上限（${goal.iterationCount}/${goal.maxIterations || settings.maxAutoIterations}），已自动暂停。请汇报当前进展与验收结果，询问用户是否继续。`
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
function deliverCallbackForJob(job, settings) {
  const target = normalizeCallbackTarget(job.callbackTarget);
  if (!target) {
    const updated = updateJobCallbackState(job.id, {
      callbackStatus: "unrouted",
      callbackSent: false,
      callbackError:
        "No trusted source conversation locked on this job; result kept in panel.",
    });
    return { ok: false, status: "unrouted", job: updated };
  }

  // Verify the locked conversation is still valid before sending
  const verified = verifyConversationTarget(
    target.conversationId,
    target.projectId
  );
  if (!verified.valid) {
    const updated = updateJobCallbackState(job.id, {
      callbackStatus: "unrouted",
      callbackSent: false,
      callbackError: `Locked source conversation unavailable (${verified.reason}); result kept in panel.`,
    });
    return { ok: false, status: "unrouted", error: verified.reason, job: updated };
  }

  // Mark `sending` (NOT `sent`) before invoking agentapi
  updateJobCallbackState(job.id, {
    callbackStatus: "sending",
    callbackSent: false,
    callbackError: null,
    incrementAttempts: true,
  });

  const goal = job.goalId ? getGoal(job.goalId) : getGoal();
  const message = buildCallbackMessage(job, settings, goal);

  try {
    const sendRes = app.sendMessage(verified.conversationId, message, {
      projectId: verified.projectId || undefined,
    });
    if (sendRes && sendRes.error) {
      throw new Error(String(sendRes.error));
    }
    const updated = updateJobCallbackState(job.id, {
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
    const updated = updateJobCallbackState(job.id, {
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
        j.callbackStatus === "pending" &&
        !j.callbackSent &&
        (j.status === "completed" ||
          j.status === "failed" ||
          j.status === "timed_out")
    );

    for (const job of pending) {
      deliverCallbackForJob(job, settings);
    }
  } finally {
    watcherBusy = false;
  }
}

/**
 * PURE READ-ONLY state snapshot.
 * Never mutates settings.json or any global conversation binding!
 */
function buildState(query = {}) {
  const convFromQuery =
    typeof query.conversationId === "string" ? query.conversationId.trim() : "";
  const convId = convFromQuery || app.config.conversationId || "";

  const resolved = resolveCodexBinary();
  const version = resolved ? getCodexVersion(resolved.path) : null;
  const models = readCodexModelsCatalog();
  const tomlDefaults = readCodexTomlDefaults();
  const settings = loadSettings();
  const goalsStore = listGoals();
  const jobs = reconcilePersistedJobs(jobManager._localRunningIds);
  const history = loadHistory();

  return {
    pluginVersion: "1.4.0",
    codex: {
      found: Boolean(resolved),
      path: resolved?.path || null,
      source: resolved?.source || null,
      version,
    },
    tomlDefaults,
    models,
    settings,
    goalsStore,
    jobs,
    history,
    conversationId: convId || null,
  };
}

app.page("/", () =>
  new Response(readText("index.html"), {
    contentType: "text/html; charset=utf-8",
  })
);

app.api(
  "/styles.css",
  () =>
    new Response(readText("styles.css"), {
      contentType: "text/css; charset=utf-8",
    }),
  "GET"
);

app.api(
  "/app.js",
  () =>
    new Response(readText("app.js"), {
      contentType: "application/javascript; charset=utf-8",
    }),
  "GET"
);

app.api(
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
app.api("/api/state", (data) => buildState(data), "GET");

app.api(
  "/api/settings",
  (data) => {
    const settings = saveSettings({
      language: data.language,
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

app.api(
  "/api/reset",
  () => {
    const settings = resetSettings();
    return { ok: true, settings };
  },
  "POST"
);

// Structured background resume by old job_id (inherits exact sessionId, cwd, sandbox, goal, milestone)
app.api(
  "/api/jobs/resume",
  (data) => {
    const oldJobId = typeof data.jobId === "string" ? data.jobId.trim() : "";
    if (!oldJobId) {
      return new Response(
        JSON.stringify({ ok: false, error: "jobId is required." }),
        { status: 400, contentType: "application/json" }
      );
    }

    // Lock trusted callback target from host conversation if provided & verified;
    // otherwise resumeFromJob inherits oldJob.callbackTarget if valid.
    let callbackTarget = null;
    const reqConv =
      (typeof data.conversationId === "string" && data.conversationId.trim()) ||
      app.config.conversationId ||
      "";
    if (reqConv && ID_RE.test(reqConv)) {
      const verified = verifyConversationTarget(reqConv);
      if (verified.valid) {
        callbackTarget = {
          conversationId: verified.conversationId,
          projectId: verified.projectId,
          source: "sidecar_host",
        };
      }
    }

    try {
      const { job, reused, reason } = jobManager.resumeFromJob(oldJobId, {
        prompt: data.prompt,
        sandbox: data.sandbox,
        allowSandboxEscalation: Boolean(data.allowSandboxEscalation),
        callbackTarget,
      });
      return {
        ok: true,
        reused,
        reason: reason || null,
        job: jobManager._serializeJob(job),
        jobs: reconcilePersistedJobs(jobManager._localRunningIds),
      };
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: err?.message || String(err) }),
        { status: 400, contentType: "application/json" }
      );
    }
  },
  "POST"
);

// Stop a running or detached-running job by PID and release its session lock
app.api(
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
    return {
      ok: Boolean(res.cancelled || res.alreadyFinished),
      ...res,
      jobs: reconcilePersistedJobs(jobManager._localRunningIds),
    };
  },
  "POST"
);

// Retry a failed callback strictly to the job's locked callbackTarget (never to another conversation)
app.api(
  "/api/jobs/retry-callback",
  (data) => {
    const jobId = typeof data.jobId === "string" ? data.jobId.trim() : "";
    if (!jobId) {
      return new Response(
        JSON.stringify({ ok: false, error: "jobId is required." }),
        { status: 400, contentType: "application/json" }
      );
    }
    const jobs = reconcilePersistedJobs(jobManager._localRunningIds);
    const job = jobs.find((j) => j.id === jobId);
    if (!job) {
      return new Response(
        JSON.stringify({ ok: false, error: `Job not found: ${jobId}` }),
        { status: 404, contentType: "application/json" }
      );
    }
    if (job.callbackStatus === "sent") {
      return { ok: true, status: "sent", alreadySent: true, job, jobs };
    }
    const res = deliverCallbackForJob(job, loadSettings());
    return {
      ...res,
      jobs: reconcilePersistedJobs(jobManager._localRunningIds),
    };
  },
  "POST"
);

app.api(
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

app.api(
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

app.api(
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

app.api(
  "/api/goals/delete",
  (data) => {
    const deleted = deleteGoal(data.goalId);
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
    void checkAndDispatchCallbacks();
  }, watcherMs).unref();
}

app.run();
