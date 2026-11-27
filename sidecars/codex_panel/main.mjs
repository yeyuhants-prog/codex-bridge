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
  readPersistedJobs,
  markJobCallbackSent,
} from "../../server/job-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, "..", "..");
const LOGO_PATH = join(PLUGIN_ROOT, "assets", "logo.png");
const ID_RE = /^[0-9a-f-]{8,}$/i;

const app = new SidecarApp();

function readText(file) {
  return readFileSync(join(__dirname, file), "utf-8");
}

function resolveProjectIdForConversation(conversationId) {
  if (!conversationId || !ID_RE.test(conversationId)) return "";
  try {
    const data = app.getConversationMetadata(conversationId);
    const metaEvent =
      data?.response?.conversationMetadata ||
      data?.response?.conversation_metadata;
    const meta = metaEvent?.metadata;
    return meta?.projectId || meta?.project_id || "";
  } catch {
    return "";
  }
}

function maybeBindConversation(conversationId, explicitProjectId = "") {
  if (!conversationId || !ID_RE.test(conversationId)) return null;
  const current = loadSettings();
  if (
    current.boundConversationId === conversationId &&
    (current.boundProjectId || !explicitProjectId)
  ) {
    return current;
  }
  const projectId =
    explicitProjectId || resolveProjectIdForConversation(conversationId) || "";
  return saveSettings({
    boundConversationId: conversationId,
    boundProjectId: projectId,
  });
}

function buildCallbackMessage(job, settings, goal) {
  const summary = job.resultSummary || {};
  const mode = settings.progressionMode;
  const isEn = settings.language === "en";
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
    `- **Status**: \`${job.status}\` | **Model**: \`${job.model || "default"}\` | **Effort**: \`${job.reasoningEffort || "default"}\``,
    `- **Session ID**: \`${job.sessionId || "(none)"}\``,
    `- **Working Dir**: \`${job.cwd}\``,
  ];

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
    lines.push(
      isEn
        ? `**Progression Instruction (Autonomous Mode)**: Immediately verify the result & milestone checks, update the milestone via \`codex_goal(action="update_milestone")\`; if verification failed, call \`codex_resume(session_id="${job.sessionId || "last"}")\` to fix it, or if passed and pending milestones remain, call \`codex_start\` for the next milestone until complete (pause & report if user input is required).`
        : `**推进指令（目标持续自动推进模式）**：请立刻验收上述结果与里程碑验证条件，调用 \`codex_goal(action="update_milestone")\` 更新里程碑状态；若未通过则用 \`codex_resume(session_id="${job.sessionId || "last"}")\` 返工，若已通过且还有待办里程碑，请自动调用 \`codex_start\` 推进下一阶段直到目标达成（如遇需用户决策的阻塞点则暂停并汇报）。`
    );
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

let watcherBusy = false;
async function checkAndDispatchCallbacks() {
  if (watcherBusy) return;
  watcherBusy = true;
  try {
    const settings = loadSettings();
    if (settings.progressionMode === "manual") return;
    const convId = settings.boundConversationId || app.config.conversationId || "";
    if (!convId || !ID_RE.test(convId)) return;

    const jobs = readPersistedJobs();
    const pending = jobs.filter(
      (j) =>
        j &&
        j.notifyOnComplete &&
        !j.callbackSent &&
        j.status !== "running" &&
        j.status !== "cancelled" &&
        j.status !== "interrupted"
    );

    if (pending.length === 0) return;

    for (const job of pending) {
      // Mark before sending so restarts or transient errors never duplicate callbacks.
      markJobCallbackSent(job.id);
      const goal = job.goalId ? getGoal(job.goalId) : getGoal();
      const message = buildCallbackMessage(job, settings, goal);
      try {
        const projectId =
          settings.boundProjectId ||
          resolveProjectIdForConversation(convId) ||
          undefined;
        app.sendMessage(convId, message, { projectId });
        console.log(
          `[codex-panel] Dispatched auto-callback for job ${job.id} -> conv ${convId} (${settings.progressionMode})`
        );
      } catch (err) {
        markJobCallbackSent(job.id, { error: err?.message || String(err) });
        console.error(
          `[codex-panel] Failed auto-callback for job ${job.id}:`,
          err?.message || err
        );
      }
    }
  } finally {
    watcherBusy = false;
  }
}

function buildState(query = {}) {
  const convFromQuery =
    typeof query.conversationId === "string" ? query.conversationId.trim() : "";
  const convId = convFromQuery || app.config.conversationId || "";
  if (convId && ID_RE.test(convId)) {
    maybeBindConversation(convId);
  }

  const resolved = resolveCodexBinary();
  const version = resolved ? getCodexVersion(resolved.path) : null;
  const models = readCodexModelsCatalog();
  const tomlDefaults = readCodexTomlDefaults();
  const settings = loadSettings();
  const goalsStore = listGoals();
  const jobs = readPersistedJobs();
  const history = loadHistory();

  return {
    pluginVersion: "1.3.0",
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
  "/api/bind-conversation",
  (data) => {
    const convId = String(
      data.conversationId || app.config.conversationId || ""
    ).trim();
    if (!convId) {
      return { ok: false, error: "No conversationId available to bind." };
    }
    const settings = maybeBindConversation(convId, data.projectId || "");
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

// Start background callback watcher (skip if explicitly disabled in unit tests)
if (process.env.CODEX_PANEL_DISABLE_WATCHER !== "1") {
  setInterval(() => {
    void checkAndDispatchCallbacks();
  }, 2500).unref();
}

app.run();
