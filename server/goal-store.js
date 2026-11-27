import crypto from "node:crypto";
import fs from "node:fs";
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
  const filePath = getGoalsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { activeGoalId: null, goals: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      activeGoalId:
        typeof parsed.activeGoalId === "string" ? parsed.activeGoalId : null,
      goals: Array.isArray(parsed.goals) ? parsed.goals : [],
    };
  } catch {
    return { activeGoalId: null, goals: [] };
  }
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
  if (!title || !String(title).trim()) {
    throw new Error("Goal title is required.");
  }
  const store = readStore();
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
}

export function setActiveGoal(goalId) {
  const store = readStore();
  if (!goalId) {
    store.activeGoalId = null;
    saveStore(store);
    return null;
  }
  const goal = store.goals.find((g) => g.id === goalId);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);
  store.activeGoalId = goal.id;
  saveStore(store);
  return goal;
}

export function updateGoalStatus(goalId, status, { blockers, notes } = {}) {
  const store = readStore();
  const targetId = goalId || store.activeGoalId;
  const goal = store.goals.find((g) => g.id === targetId);
  if (!goal) throw new Error(`Goal not found: ${targetId || "(none)"}`);

  if (status !== undefined) {
    if (!VALID_GOAL_STATUSES.has(status)) {
      throw new Error(`Invalid goal status: ${status}`);
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
}

export function addMilestone(goalId, { title, verification = "", status = "pending" }) {
  const store = readStore();
  const targetId = goalId || store.activeGoalId;
  const goal = store.goals.find((g) => g.id === targetId);
  if (!goal) throw new Error(`Goal not found: ${targetId || "(none)"}`);
  if (!title || !String(title).trim()) {
    throw new Error("Milestone title is required.");
  }

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
  goal.updatedAt = now;
  saveStore(store);
  return { goal, milestone };
}

export function updateMilestone(
  goalId,
  milestoneId,
  { status, notes, verification, sessionId, jobId } = {}
) {
  const store = readStore();
  const targetId = goalId || store.activeGoalId;
  const goal = store.goals.find((g) => g.id === targetId);
  if (!goal) throw new Error(`Goal not found: ${targetId || "(none)"}`);

  const ms = goal.milestones.find((m) => m.id === milestoneId);
  if (!ms) throw new Error(`Milestone not found: ${milestoneId} in ${goal.id}`);

  const now = new Date().toISOString();
  if (status !== undefined) {
    if (!VALID_MILESTONE_STATUSES.has(status)) {
      throw new Error(`Invalid milestone status: ${status}`);
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
}

export function recordGoalExecution(
  goalId,
  { milestoneId, sessionId, jobId, incrementIteration = true } = {}
) {
  const store = readStore();
  const targetId = goalId || store.activeGoalId;
  if (!targetId) return null;
  const goal = store.goals.find((g) => g.id === targetId);
  if (!goal) return null;

  const now = new Date().toISOString();
  if (incrementIteration) {
    goal.iterationCount = (goal.iterationCount || 0) + 1;
  }
  if (sessionId) {
    goal.sessionId = sessionId;
  }
  if (milestoneId) {
    const ms = goal.milestones.find((m) => m.id === milestoneId);
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
}

export function deleteGoal(goalId) {
  const store = readStore();
  const idx = store.goals.findIndex((g) => g.id === goalId);
  if (idx === -1) return false;
  store.goals.splice(idx, 1);
  if (store.activeGoalId === goalId) {
    store.activeGoalId = store.goals[0]?.id || null;
  }
  saveStore(store);
  return true;
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
