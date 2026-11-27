import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSessionId } from "./session-lock.js";
import { resolveResumeSandbox } from "./codex-runner.js";
import { getGoal } from "./goal-store.js";
import { loadHistory, loadSettings } from "./settings-store.js";

import { problem, validateBooleans } from "./validation.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const samePath = (a, b) => path.relative(a, b) === "";

export function workingDirectory(cwd, goal) {
  const fromCaller = cwd ?? goal?.cwd;
  if (fromCaller !== undefined && typeof fromCaller !== "string") throw problem(400, "Invalid cwd.");
  const dir = path.resolve(fromCaller || process.cwd());
  const relative = path.relative(root, dir);
  if (!fromCaller && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep)) {
    throw problem(400, "Explicit cwd or goal.cwd is required in the plugin directory.");
  }
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw problem(400, "Invalid working directory: " + dir);
  return dir;
}

export function directoryList(input, cwd) {
  if (!Array.isArray(input) || input.some(d => typeof d !== "string" || !d.trim())) throw problem(400, "Invalid add_dirs.");
  return [...new Set(input.map(d => path.resolve(cwd, d)))];
}

// Both structured and bare-session calls must resolve their authority before taking a lock.
export function resolveResume(options, jobs) {
  validateBooleans(options);
  const parent = options.parentJobId ? jobs.find(j => j.id === options.parentJobId) : null;
  if (options.parentJobId && !parent) throw problem(404, "Previous job not found: " + options.parentJobId);
  const sid = normalizeSessionId(parent ? parent.sessionId : options.sessionId);
  if (parent && options.sessionId !== undefined && normalizeSessionId(options.sessionId) !== sid) {
    throw problem(409, "session_id conflicts with the parent job.");
  }
  let baseline = parent || jobs.find(j => j.sessionId?.toLowerCase() === sid);
  if (!parent) {
    const history = loadHistory().find(row => row.sessionId?.toLowerCase() === sid);
    // A synchronous resume can tighten the policy after the last persisted background job.
    if (history && (!baseline || Date.parse(history.at) > Date.parse(baseline.finishedAt || baseline.startedAt))) {
      baseline = { ...baseline, ...history };
    }
  }
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || !options.cwd.trim())) throw problem(400, "Invalid cwd.");
  if (parent && (!parent.cwd || (options.cwd !== undefined && !samePath(path.resolve(options.cwd), path.resolve(parent.cwd))))) {
    throw problem(409, "cwd conflicts with the parent job.");
  }
  if (parent && options.goalId !== undefined && options.goalId !== parent.goalId) throw problem(409, "goal_id conflicts with the parent job.");
  const goalId = options.goalId ?? baseline?.goalId;
  const goal = goalId ? getGoal(goalId) : null;
  const milestoneId = options.milestoneId ?? baseline?.milestoneId;
  if (goalId && !goal) throw problem(404, "Goal not found: " + goalId);
  if (milestoneId && !goal?.milestones.some(m => m.id === milestoneId)) throw problem(400, "Milestone does not belong to the goal.");
  const cwd = parent?.cwd || options.cwd || baseline?.cwd || goal?.cwd;
  if (!cwd) throw problem(400, "Explicit cwd is required for an unknown session.");
  const dir = workingDirectory(cwd);
  const previousDirs = directoryList(baseline?.addDirs || [], baseline?.cwd || dir);
  const addDirs = options.addDirs === undefined ? previousDirs : directoryList(options.addDirs, dir);
  if (options.allowSandboxEscalation !== true && addDirs.some(d => !previousDirs.some(old => samePath(old, d)))) {
    throw problem(400, "Additional writable directories require explicit sandbox escalation.");
  }
  const sandbox = resolveResumeSandbox({ requestedSandbox: options.sandbox, originalSandbox: baseline?.sandbox || "read-only",
    allowEscalation: options.allowSandboxEscalation === true });
  const prefs = loadSettings();
  if (options.transferCallback && !options.callbackTarget?.conversationId) throw problem(400, "A callback transfer requires a verified destination.");
  const original = baseline?.callbackTarget || null;
  const callbackTarget = parent && !options.transferCallback ? original : options.callbackTarget || original;
  const transferredFrom = options.transferCallback && original && original.conversationId !== callbackTarget?.conversationId
    ? original.conversationId : baseline?.transferredFrom || null;
  const previousModel = baseline?.model === "(codex default)" ? "" : baseline?.model;
  const previousEffort = baseline?.reasoningEffort === "(default)" ? "" : baseline?.reasoningEffort;
  return { ...options, mode: "resume", sessionId: sid, cwd: dir, goalId, milestoneId, sandbox, addDirs, callbackTarget, transferredFrom,
    model: options.model || previousModel || prefs.model, reasoningEffort: options.reasoningEffort || previousEffort || prefs.reasoningEffort,
    skipGitRepoCheck: options.skipGitRepoCheck ?? baseline?.skipGitRepoCheck ?? prefs.skipGitRepoCheck,
    notifyOnComplete: options.notifyOnComplete ?? baseline?.notifyOnComplete ?? (prefs.progressionMode !== "manual"),
    prompt: options.prompt || "Continue the previous task in " + dir + ", inspect its progress and verify the remaining work." };
}
