import { problem } from "./validation.js";
import { isPidAlive } from "./process-identity.js";
import { readJson, withFileLock } from "./file-store.js";
import crypto from "node:crypto";
import { getGoalsPath, writeJsonAtomic, loadSettings } from "./settings-store.js";

const VALID_GOAL_STATUSES = new Set(["active", "paused", "completed", "failed"]);
const VALID_MILESTONE_STATUSES = new Set([
  "pending",
  "in_progress",
  "done",
  "blocked",
  "skipped",
]);

function readStore() {
  return readJson(getGoalsPath(), { activeGoalId: null, goals: [] },
    v => v && Array.isArray(v.goals) && v.goals.every(g => typeof g?.id === "string" && Array.isArray(g.milestones)));
}

function saveStore(store) {
  writeJsonAtomic(getGoalsPath(), store);
  return store;
}

export function listGoals() {
  return readStore();
}

export function getGoal(goalId) {
  const store = readStore();
  const targetId = goalId || store.activeGoalId;
  if (!targetId) return null;
  return store.goals.find((g) => g.id === targetId) || null;
}

export function createGoal({
  title,
  objective = "",
  cwd = "",
  acceptanceCriteria = [],
  milestones = [],
  maxIterations,
  setActive = true,
}) {
  return withFileLock(getGoalsPath(), () => {
    if (!title || !String(title).trim()) {
      throw problem(400, "Goal title is required.");
    }
    const store = readStore();
    if (maxIterations !== undefined && (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 100)) throw problem(400, "Invalid maxIterations.");
    const settings = loadSettings();
    const now = new Date().toISOString();
    const goalId = `goal_${crypto.randomBytes(3).toString("hex")}`;

    const normalizedMilestones = (Array.isArray(milestones) ? milestones : [])
      .map((m, idx) => {
        if (typeof m === "string") {
          return {
            id: `m${idx + 1}`,
            title: m.trim(),
            verification: "",
            status: "pending",
            notes: "",
            sessionId: null,
            jobId: null,
            updatedAt: now,
          };
        }
        return {
          id: (m?.id && String(m.id).trim()) || `m${idx + 1}`,
          title: String(m?.title || `Milestone ${idx + 1}`).trim(),
          verification: String(m?.verification || "").trim(),
          status: VALID_MILESTONE_STATUSES.has(m?.status) ? m.status : "pending",
          notes: String(m?.notes || "").trim(),
          sessionId: m?.sessionId || null,
          jobId: m?.jobId || null,
          updatedAt: now,
        };
      })
      .filter((m) => m.title);

    const goal = {
      id: goalId,
      title: String(title).trim(),
      objective: String(objective || "").trim(),
      cwd: String(cwd || "").trim(),
      acceptanceCriteria: (Array.isArray(acceptanceCriteria)
        ? acceptanceCriteria
        : []
      )
        .map((c) => String(c || "").trim())
        .filter(Boolean),
      status: "active",
      sessionId: null,
      blockers: [],
      milestones: normalizedMilestones,
      iterationCount: 0,
      maxIterations:
        typeof maxIterations === "number" && maxIterations >= 1
          ? Math.min(100, Math.round(maxIterations))
          : settings.maxAutoIterations || 12,
      createdAt: now,
      updatedAt: now,
    };

    store.goals.unshift(goal);
    if (setActive || !store.activeGoalId) {
      store.activeGoalId = goal.id;
    }
    saveStore(store);
    return goal;
  });
}

export function setActiveGoal(goalId) {
  return withFileLock(getGoalsPath(), () => {
    const store = readStore();
    if (!goalId) {
      store.activeGoalId = null;
      saveStore(store);
      return null;
    }
    const goal = store.goals.find((g) => g.id === goalId);
    if (!goal) throw problem(404, `Goal not found: ${goalId}`);
    store.activeGoalId = goal.id;
    saveStore(store);
    return goal;
  });
}

export function updateGoalStatus(goalId, status, { blockers, notes } = {}) {
  return withFileLock(getGoalsPath(), () => {
    const store = readStore();
    const targetId = goalId || store.activeGoalId;
    const goal = store.goals.find((g) => g.id === targetId);
    if (!goal) throw problem(404, `Goal not found: ${targetId || "(none)"}`);

    if (status !== undefined) {
      if (!VALID_GOAL_STATUSES.has(status)) {
        throw problem(400, `Invalid goal status: ${status}`);
      }
      if (status === "active" && goal.status === "paused") {
        goal.iterationBaseline = goal.iterationCount || 0;
      }
      goal.status = status;
    }
    if (Array.isArray(blockers)) {
      goal.blockers = blockers.map((b) => String(b || "").trim()).filter(Boolean);
    }
    if (typeof notes === "string" && notes.trim()) {
      goal.lastNotes = notes.trim();
    }
    goal.updatedAt = new Date().toISOString();
    saveStore(store);
    return goal;
  });
}

export function addMilestone(goalId, { title, verification = "", status = "pending" }) {
  return withFileLock(getGoalsPath(), () => {
    const store = readStore();
    const targetId = goalId || store.activeGoalId;
    const goal = store.goals.find((g) => g.id === targetId);
    if (!goal) throw problem(404, `Goal not found: ${targetId || "(none)"}`);
    if (!title || !String(title).trim()) {
      throw problem(400, "Milestone title is required.");
    }

    if (!VALID_MILESTONE_STATUSES.has(status)) throw problem(400, "Invalid milestone status.");
    const nextNum = goal.milestones.length + 1;
    let id = `m${nextNum}`;
    const existing = new Set(goal.milestones.map((m) => m.id));
    let bump = nextNum;
    while (existing.has(id)) {
      bump += 1;
      id = `m${bump}`;
    }

    const now = new Date().toISOString();
    const milestone = {
      id,
      title: String(title).trim(),
      verification: String(verification || "").trim(),
      status: VALID_MILESTONE_STATUSES.has(status) ? status : "pending",
      notes: "",
      sessionId: null,
      jobId: null,
      updatedAt: now,
    };
    goal.milestones.push(milestone);
    reopenForMilestone(goal, milestone);
    goal.updatedAt = now;
    saveStore(store);
    return { goal, milestone };
  });
}

export function updateMilestone(
  goalId,
  milestoneId,
  { status, notes, verification, sessionId, jobId } = {}
) {
  return withFileLock(getGoalsPath(), () => {
    const store = readStore();
    const targetId = goalId || store.activeGoalId;
    const goal = store.goals.find((g) => g.id === targetId);
    if (!goal) throw problem(404, `Goal not found: ${targetId || "(none)"}`);

    const ms = goal.milestones.find((m) => m.id === milestoneId);
    if (!ms) throw problem(404, `Milestone not found: ${milestoneId} in ${goal.id}`);

    const now = new Date().toISOString();
    if (status !== undefined) {
      if (!VALID_MILESTONE_STATUSES.has(status)) {
        throw problem(400, `Invalid milestone status: ${status}`);
      }
      ms.status = status;
    }
    if (notes !== undefined) ms.notes = String(notes ?? "").trim();
    if (verification !== undefined)
      ms.verification = String(verification ?? "").trim();
    if (sessionId) {
      ms.sessionId = sessionId;
      goal.sessionId = sessionId;
    }
    if (jobId) ms.jobId = jobId;
    ms.updatedAt = now;
    reopenForMilestone(goal, ms);

    // Auto-mark goal completed if all milestones are done/skipped
    if (
      goal.status === "active" &&
      goal.milestones.length > 0 &&
      goal.milestones.every((m) => m.status === "done" || m.status === "skipped")
    ) {
      goal.status = "completed";
    }

    goal.updatedAt = now;
    saveStore(store);
    return { goal, milestone: ms };
  });
}

function reopenForMilestone(goal, milestone) {
  if (goal.status === "completed" && !["done", "skipped"].includes(milestone.status)) goal.status = "active";
}

function pendingDispatches(goal) {
  return (goal.pendingDispatches || []).filter(r => r.expires > Date.now() && isPidAlive(r.ownerPid));
}

export function iterationLimit(goal, settings) {
  return Math.min(goal.maxIterations || settings.maxAutoIterations, settings.maxAutoIterations);
}

function checkBudget(store, goal, otherReservations) {
  const limit = iterationLimit(goal, loadSettings());
  const used = (goal.iterationCount || 0) - (goal.iterationBaseline || 0);
  if (goal.status === "active" && used >= limit) {
    goal.status = "paused";
    saveStore(store);
  }
  if (goal.status !== "active" || used + otherReservations >= limit) {
    throw Object.assign(new Error("Goal is paused, completed or at its iteration limit."), { status: 409 });
  }
  return limit;
}

// Reserve before spawn; consume a turn only after the process and its PID are recorded.
export function reserveGoalDispatch(goalId, milestoneId) {
  if (!goalId) return null;
  return withFileLock(getGoalsPath(), () => {
    const store = readStore();
    const goal = store.goals.find(g => g.id === goalId);
    if (!goal) throw problem(404, "Goal not found: " + goalId);
    if (milestoneId && !goal.milestones.some(m => m.id === milestoneId)) throw problem(404, "Milestone not found: " + milestoneId);
    const pending = pendingDispatches(goal);
    checkBudget(store, goal, pending.length);
    const id = crypto.randomUUID();
    goal.pendingDispatches = [...pending, { id, ownerPid: process.pid, expires: Date.now() + 120000 }];
    saveStore(store);
    return id;
  });
}

export function abandonGoalDispatch(goalId, id) {
  if (!id) return;
  withFileLock(getGoalsPath(), () => {
    const store = readStore();
    const goal = store.goals.find(g => g.id === goalId);
    if (goal?.pendingDispatches?.some(r => r.id === id)) {
      goal.pendingDispatches = goal.pendingDispatches.filter(r => r.id !== id);
      saveStore(store);
    }
  });
}

export function recordGoalExecution(
  goalId,
  { milestoneId, sessionId, jobId, reservationId, incrementIteration = true } = {}
) {
  return withFileLock(getGoalsPath(), () => {
    const store = readStore();
    const targetId = goalId || store.activeGoalId;
    if (!targetId) return null;
    const goal = store.goals.find((g) => g.id === targetId);
    if (!goal) {
      if (incrementIteration) throw problem(404, "Goal not found: " + targetId);
      return null;
    }

    const now = new Date().toISOString();
    if (incrementIteration) {
      const pending = pendingDispatches(goal);
      if (reservationId && !pending.some(r => r.id === reservationId)) throw new Error("Dispatch reservation expired.");
      goal.pendingDispatches = pending.filter(r => r.id !== reservationId);
      const limit = checkBudget(store, goal, goal.pendingDispatches.length);
      goal.iterationCount = (goal.iterationCount || 0) + 1;
      if (goal.iterationCount - (goal.iterationBaseline || 0) >= limit) goal.status = "paused";
    }
    if (sessionId) {
      goal.sessionId = sessionId;
    }
    if (milestoneId) {
      const ms = goal.milestones.find((m) => m.id === milestoneId);
      if (!ms && incrementIteration) throw problem(404, "Milestone not found: " + milestoneId);
      if (ms) {
        if (sessionId) ms.sessionId = sessionId;
        if (jobId) ms.jobId = jobId;
        if (ms.status === "pending") ms.status = "in_progress";
        ms.updatedAt = now;
      }
    }
    goal.updatedAt = now;
    saveStore(store);
    return goal;
  });
}

export function deleteGoal(goalId) {
  return withFileLock(getGoalsPath(), () => {
    const store = readStore();
    const idx = store.goals.findIndex((g) => g.id === goalId);
    if (idx === -1) return false;
    store.goals.splice(idx, 1);
    if (store.activeGoalId === goalId) {
      store.activeGoalId = store.goals[0]?.id || null;
    }
    saveStore(store);
    return true;
  });
}

export function formatGoalSummary(goal) {
  if (!goal) return "No active goal.";
  const doneCount = goal.milestones.filter((m) => m.status === "done").length;
  const total = goal.milestones.length;
  const lines = [
    `Goal: ${goal.title} (${goal.id})`,
    `Status: ${goal.status} | Progress: ${doneCount}/${total} milestones | Iterations: ${goal.iterationCount || 0}/${goal.maxIterations || 12}`,
  ];
  if (goal.cwd) lines.push(`Working Dir: ${goal.cwd}`);
  if (goal.sessionId) lines.push(`Linked Codex Session: ${goal.sessionId}`);
  if (goal.objective) lines.push(`Objective: ${goal.objective}`);

  if (goal.acceptanceCriteria?.length) {
    lines.push(
      `\n### Acceptance Criteria\n${goal.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
    );
  }

  if (goal.milestones.length) {
    const icon = {
      pending: "[ ]",
      in_progress: "[~]",
      done: "[x]",
      blocked: "[!]",
      skipped: "[-]",
    };
    const msLines = goal.milestones.map((m) => {
      const parts = [`- ${icon[m.status] || "[ ]"} **${m.id}**: ${m.title} (${m.status})`];
      if (m.verification) parts.push(`  verify: \`${m.verification}\``);
      if (m.notes) parts.push(`  notes: ${m.notes}`);
      if (m.sessionId) parts.push(`  session: \`${m.sessionId}\``);
      return parts.join("\n");
    });
    lines.push(`\n### Milestones\n${msLines.join("\n")}`);
  }

  if (goal.blockers?.length) {
    lines.push(
      `\n### Blockers\n${goal.blockers.map((b) => `- ${b}`).join("\n")}`
    );
  }

  return lines.join("\n");
}
