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
  listGoals, iterationLimit, archiveGoal, archiveCompletedGoals,
  getGoal,
  createGoal,
  setActiveGoal,
  updateGoalStatus,
  addMilestone,
  updateMilestone,
  deleteGoal,
} from "../../server/goal-store.js";
import {
  JobManager, archiveExecutions,
  normalizeCallbackTarget,
  reconcilePersistedJobs,
  claimCallback, beginCallbackSend, finishCallback,
  claimPeriodicCheckIn, finishPeriodicCheckIn,
  readPersistedJobs, callbackTerminal,
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
    !goal.archived && goal.status === "active" &&
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
  }
  if (job.error && (!summary.lastMessage || job.autoHealCircuitBroken)) {
    lines.push(
      isEn ? `\n**Error**: ${job.error}` : `\n**错误信息**: ${job.error}`
    );
  }

  lines.push("");
  if (summary.errors?.includes("Turn token budget reached.")) {
    lines.push(isEn ? "Turn token budget reached. Inspect completed work, verify the milestone and agree the remaining scope and budget before resuming."
      : "本轮 Token 预算已用尽。请核对已完成的工作、验收里程碑，确认剩余范围和预算后再续跑。");
  } else if (job.autoHealCircuitBroken) {
    lines.push(isEn ? "Auto-heal has paused. Report the interruption and review the recovery options above."
      : "自动续跑已熔断。请向用户报告中断原因，并评估上述恢复建议。");
  } else if (isAutonomousEligible) {
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

function buildPeriodicCheckMessage(job, settings, goal, checkNum) {
  const isEn = settings.language === "en";
  const now = Date.now();
  const elapsedSec = Math.max(0, Math.round((now - Date.parse(job.startedAt || "")) / 1000) || 0);
  const idleSec = Math.max(0, Math.round((now - Date.parse(job.lastProgressAt || job.lastEventAt || job.startedAt || "")) / 1000) || 0);
  const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
  const phase = job.phase || "waiting_api";
  const lines = [
    isEn
      ? `[Codex Bridge Periodic Check #${checkNum}] Active background Codex job heartbeat`
      : `[Codex Bridge 定时检验 #${checkNum}] 后台 Codex 任务进展巡检`,
    ``,
    `- **Job ID**: \`${job.id}\` | **Status**: \`${job.status}\` | **Phase**: \`${phase}\`${job.reconnectCount ? ` (reconnects=${job.reconnectCount})` : ""}`,
    `- **Model**: \`${job.model || "default"}\` | **Effort**: \`${job.reasoningEffort || "default"}\` | **Elapsed**: ${fmtDur(elapsedSec)} | **Idle**: ${fmtDur(idleSec)} | **Events**: ${job.eventCount || 0}`,
    `- **Working Dir**: \`${job.cwd}\``,
  ];
  if (job.silenceWarning) lines.push(isEn ? "Silence warning: waiting for API response." : "静默告警：正在等待 API 响应。");
  if (job.autoHealCount > 0) {
    lines.push(`- **Auto-Heal**: #${job.autoHealCount}/${settings.maxAutoHeals ?? 2}`);
  }
  if (goal) {
    lines.push(`- **Goal**: ${goal.title} (\`${goal.id}\`${job.milestoneId ? ` / \`${job.milestoneId}\`` : ""})`);
  }
  const recent = (job.recentEvents || []).slice(-5);
  if (recent.length) {
    lines.push(
      isEn ? `\n**Recent Events**:` : `\n**最近事件**:`,
      ...recent.map((e) => `  - [${e.at}] ${e.summary}`)
    );
  }
  lines.push(
    "",
    isEn
      ? `**Periodic Inspection Instruction (Delegate to Lightweight Sub-Model)**: Launch a read-only monitor via \`invoke_subagent(TypeName="research", Model="flash_lite", Role="Codex Progress Monitor", Prompt="...")\` to keep the Mastermind context clean. Inspect the recent events above and workspace status in \`${job.cwd}\` to judge whether Codex is: (1) progressing normally, (2) stuck in a retry/error loop or drifting, or (3) already done with edits/tests while stalled on reporting. Return a <=5-line verdict to the Mastermind. If healthy, keep waiting.`
      : `**定时检验指令（委托轻量子模型巡检）**：请调用 \`invoke_subagent(TypeName="research", Model="flash_lite", Role="Codex Progress Monitor", Prompt="...")\`（只读轻量子模型，避免污染主脑上下文），结合上述最近事件与 \`${job.cwd}\` 工作区状态做一次快速体检：① 判断 Codex 是正常推进、陷入报错死循环/跑偏，还是其实代码与测试已跑完仅卡在汇报；② 向主脑返回 5 行以内结构化结论（状态 / 进展 / 风险 / 建议）。若进展正常，请继续等待。`
  );
  if (job.canSteer && job.activeTurnId) {
    const call = `codex_steer(job_id=${JSON.stringify(job.id)}, expected_turn_id=${JSON.stringify(job.activeTurnId)}, message="...")`;
    lines.push(isEn ? `For a course correction, first use ${call}. If delivery is unknown, inspect codex_status before resending.`
      : `需要微调时优先在线纠偏：${call}。送达未知时，先用 codex_status 核对再决定是否重发。`);
  }
  const resume = `codex_start(resume_job_id=${JSON.stringify(job.id)}, ...)`;
  lines.push(isEn ? `If intervention is needed and steering is unavailable or the job has seriously drifted, use codex_cancel, verify it stopped, then ${resume}.`
    : `需要介入且无法在线纠偏或已严重跑偏时，用 codex_cancel 停止任务，确认已停后再用 ${resume} 续跑。`);
  return lines.join("\n");
}

async function deliverPeriodicCheckIn(id, settings) {
  const claimed = claimPeriodicCheckIn(id, settings.monitorIntervalSeconds);
  const token = claimed.checkInClaim;
  const target = normalizeCallbackTarget(claimed.callbackTarget);
  if (!target) {
    finishPeriodicCheckIn(id, token, { delivered: false, error: "No locked conversationId." });
    return { ok: false };
  }
  const verified = await verifyConversationTarget(target.conversationId, target.projectId);
  if (!verified.valid) {
    finishPeriodicCheckIn(id, token, { delivered: false, error: verified.reason });
    return { ok: false };
  }
  try {
    const goal = claimed.goalId ? getGoal(claimed.goalId) : null;
    const checkNum = (claimed.checkInCount || 0) + 1;
    const message = buildPeriodicCheckMessage(claimed, settings, goal, checkNum);
    const sendRes = await agentApi(["send-message", verified.conversationId, message], verified.projectId);
    if (sendRes && sendRes.error) throw new Error(String(sendRes.error));
    finishPeriodicCheckIn(id, token, { delivered: true });
    console.log(`[codex-panel] Delivered periodic check #${checkNum} for job ${id} -> conv ${verified.conversationId}`);
    return { ok: true };
  } catch (err) {
    finishPeriodicCheckIn(id, token, { delivered: false, error: err?.message || String(err) });
    return { ok: false };
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

    if (settings.monitorIntervalSeconds > 0) {
      const now = Date.now();
      const intervalMs = settings.monitorIntervalSeconds * 1000;
      const dueChecks = jobs.filter(
        (j) =>
          j &&
          ["running", "running_detached"].includes(j.status) &&
          j.notifyOnComplete !== false &&
          normalizeCallbackTarget(j.callbackTarget) &&
          !(j.checkInClaim && Date.parse(j.checkInLeaseUntil) > now) &&
          now - (Date.parse(j.lastCheckInAt || j.startedAt) || now) >= intervalMs
      );
      for (const job of dueChecks) {
        try { await deliverPeriodicCheckIn(job.id, settings); }
        catch (err) { if (err.status !== 409) console.error("[codex-panel] periodic check:", err.message); }
      }
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
    const storedGoals = listGoals();
    const goalsStore = { ...storedGoals, goals: storedGoals.goals.map(({ pendingDispatches, ...goal }) => goal) };
    const jobs = readPersistedJobs().map(publicJob);
    const history = loadHistory().map(({ ownerId, lockToken, callbackClaim, checkInClaim, ...row }) => {
      const job = row.jobId && jobs.find(j => j.id === row.jobId);
      return { cwd: job?.cwd || null, conversationId: job?.conversationId || null, transferredFrom: job?.transferredFrom || null,
        durationMs: null, usage: null, model: "", reasoningEffort: "", ...row };
    });
    return { pluginVersion: "1.8.0", codex, tomlDefaults, models, settings,
      goalsStore, jobs, history, conversationId: convId || null };
  });
}

function publicJob({ ownerId, lockToken, callbackClaim, processIdentity, checkInClaim, checkInLeaseUntil, ...job }) {
  return { ...job, conversationId: job.callbackTarget?.conversationId || job.conversationId || null,
    transferredFrom: job.transferredFrom || null, durationMs: job.durationMs ?? job.resultSummary?.durationMs ?? null,
    usage: job.usage ?? job.resultSummary?.usage ?? null, model: job.model || "", reasoningEffort: job.reasoningEffort || "" };
}

function api(route, handler, method) {
  app.api(route, async data => {
    try {
      if (route === "/api/jobs/steer" && !process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN?.trim()) {
        throw problem(403, "Sidecar UI token required.");
      }
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
      modelRouting: data.modelRouting,
      transport: data.transport,
      executionEngine: data.executionEngine,
      nativeGoalSync: data.nativeGoalSync,
      tokenBudget: data.tokenBudget,
      taskTimeoutSeconds: data.taskTimeoutSeconds,
      disableDesktopNotify: data.disableDesktopNotify,
      autoHealEnabled: data.autoHealEnabled,
      stallThresholdSeconds: data.stallThresholdSeconds,
      stallPolicy: data.stallPolicy,
      reconnectStallSeconds: data.reconnectStallSeconds,
      maxAutoHeals: data.maxAutoHeals,
      monitorIntervalSeconds: data.monitorIntervalSeconds,
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

api("/api/jobs/archive", archiveExecutions, "POST");
api("/api/goals/archive", data => {
  if (data.completedOnly === true) {
    if (data.goalId || data.archived === false) throw problem(400, "Select a single goal or completedOnly.");
    archiveCompletedGoals();
  } else {
    if (!data.goalId) throw problem(400, "goalId is required.");
    archiveGoal(data.goalId, data.archived);
  }
  return { ok: true, goalsStore: listGoals() };
}, "POST");

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
      prompt: data.prompt, sandbox: data.sandbox, cwd: data.cwd, model: data.model, force_model: data.force_model,
      sessionId: data.sessionId ?? data.session_id, goalId: data.goalId ?? data.goal_id,
      milestoneId: data.milestoneId ?? data.milestone_id, addDirs: data.addDirs ?? data.add_dirs,
      notifyOnComplete: data.notifyOnComplete ?? data.notify_on_complete, skipGitRepoCheck: data.skipGitRepoCheck ?? data.skip_git_repo_check,
      ephemeral: data.ephemeral, allowSandboxEscalation: data.allowSandboxEscalation ?? data.allow_sandbox_escalation,
      transferCallback: data.transferCallback, callbackTarget });
    return { ok: true, reused, reason, job: publicJob(jobManager._serializeJob(job)), jobs: readPersistedJobs().map(publicJob) };
  }, "POST"
);

api("/api/jobs/steer", async data => {
  const host = app.config.conversationId;
  if (data.conversationId !== undefined && (!host || host.toLowerCase() !== String(data.conversationId).toLowerCase())) {
    throw problem(403, "Conversation differs from the sidecar host context.");
  }
  const receipt = await jobManager.steerJob({ jobId: data.jobId, message: data.message,
    expectedTurnId: data.expectedTurnId, callerConversationId: host, waitSeconds: data.waitSeconds,
    wait: data.wait ?? data.waitSeconds !== 0 });
  return { ok: receipt.status === "accepted" || receipt.status === "queued", ...receipt };
}, "POST");

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
      conversationId: app.config.conversationId || "",
      projectId: app.config.projectId || "",
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
