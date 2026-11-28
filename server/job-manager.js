import { readJson, withFileLock } from "./file-store.js";
import { createConsumer, publish, waitForAck, pruneControls } from "./job-control.js";
import { processIdentity, matchesProcess } from "./process-identity.js";
import { validateBooleans, validateEngineOptions, problem } from "./validation.js";
import { resolveResume, workerModel, directoryList, workingDirectory, writableRoots } from "./run-policy.js";
import { prepareAppServerTurn, runAppServerTurn } from "./app-server-runner.js";
import { taskRows, historyKey } from "../sidecars/codex_panel/view-model.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  runCodex,
  effectiveReasoningEffort,
  effectiveExecProvider,
  formatCodexResult,
  killPidTree,
} from "./codex-runner.js";
import {
  getJobsPath,
  writeJsonAtomic,
  loadSettings,
  appendHistory, loadHistory, getHistoryPath,
} from "./settings-store.js";
import { abandonGoalDispatch, reserveGoalDispatch, recordGoalExecution } from "./goal-store.js";
import {
  isPidAlive, normalizeSessionId,
  inspectSessionLock, getSessionLockPath,
  acquireSessionLock,
  updateSessionLockPid,
  releaseSessionLock,
} from "./session-lock.js";

const MAX_STORED_JOBS = 50;
const ID_RE = /^[0-9a-f-]{8,}$/i;

export function normalizeCallbackTarget(target) {
  if (!target || typeof target !== "object") return null;
  const conversationId =
    typeof target.conversationId === "string"
      ? target.conversationId.trim()
      : "";
  if (!conversationId || !ID_RE.test(conversationId)) return null;
  const projectId =
    typeof target.projectId === "string" ? target.projectId.trim() : "";
  const source = typeof target.source === "string" ? target.source : "host";
  return { conversationId, projectId, source };
}

export const activeStates = new Set(["running", "stopping", "running_detached"]);
export const callbackTerminal = new Set(["completed", "failed", "timed_out", "interrupted", "cancelled"]);

export function readPersistedJobs() {
  const jobs = readJson(getJobsPath(), [], rows => Array.isArray(rows) && rows.every(row => typeof row?.id === "string"));
  return jobs.map(job => ({ archived: false, archivedAt: null, lastEventAt: job.startedAt, engine: "exec", steerCount: 0, steerHistory: [], ...job, canSteer: steerable(job) }));
}

function steerable(job) {
  return job.engine === "app_server" && job.status === "running" && Boolean(job.canSteer && job.activeTurnId && job.ownerId);
}

function validMessage(message) {
  return typeof message === "string" && message.length <= 16000 && Boolean(message.trim());
}

let cleanupTimer;
function scheduleCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    try { withFileLock(getJobsPath(), () => pruneControls(readPersistedJobs(), isPidAlive)); }
    catch (err) { console.error("[codex-bridge] Control cleanup:", err.message); }
  }, 60_000);
  cleanupTimer.unref();
}

function writePersistedJobs(list) {
  let recent = 0;
  const retained = list.filter(j => j.archived || activeStates.has(j.status) ||
    (j.notifyOnComplete && !j.callbackSent && (!j.callbackStatus || ["pending", "sending", "failed", "unrouted"].includes(j.callbackStatus))) ||
    ++recent <= MAX_STORED_JOBS);
  writeJsonAtomic(getJobsPath(), retained);
}

// Match the same execution the panel displays, including uniquely matched legacy rows.
export function archiveExecutions(request) {
  validateBooleans(request);
  const { jobId, historyKey: key, sessionId, at, conversationId, finishedOnly, archived = true } = request;
  if (conversationId !== undefined && (typeof conversationId !== "string" || !conversationId.trim())) {
    throw problem(400, "Invalid conversationId.");
  }
  const byTime = at !== undefined || sessionId !== undefined;
  if ([Boolean(jobId), Boolean(key), byTime, finishedOnly === true].filter(Boolean).length !== 1 ||
      (byTime && (!at || sessionId === undefined)) || (finishedOnly && !archived)) {
    throw problem(400, "Select one job, history record, or finishedOnly.");
  }
  return withFileLock(getJobsPath(), () => withFileLock(getHistoryPath(), () => {
    const jobs = readPersistedJobs();
    const history = loadHistory();
    const rows = taskRows(jobs, history);
    let targets;
    if (finishedOnly) {
      targets = rows.filter(row => !activeStates.has(row.status) && (!conversationId || row.conversationId === conversationId));
    } else {
      let targetKey = key;
      if (byTime) {
        const records = history.filter(record => record.at === at && record.sessionId === sessionId);
        if (records.length > 1) throw problem(409, "Ambiguous history record. Use historyKey.");
        targetKey = records.length ? historyKey(records[0]) : null;
      }
      targets = rows.filter(row => jobId ? (row.id || row.jobId) === jobId :
        targetKey && (row.historyKey === targetKey || row.historyKey === "history:" + targetKey));
      if (!targets.length) throw problem(404, "Execution record not found.");
      if (targets.some(row => activeStates.has(row.status))) throw problem(409, "Active jobs cannot be archived.");
    }
    const ids = new Set(targets.map(row => row.id).filter(Boolean));
    const keys = new Set(targets.map(row => row.historyKey).filter(Boolean));
    const now = new Date().toISOString();
    const update = row => Boolean(row.archived) === archived ? row :
      { ...row, archived, archivedAt: archived ? now : null };
    const updatedJobs = jobs.map(job => ids.has(job.id) ? update(job) : job);
    const updatedHistory = history.map(row => ids.has(row.jobId) || keys.has(historyKey(row)) ? update(row) : row);
    const historyChanged = updatedHistory.some((row, index) => row !== history[index]);
    if (historyChanged) writeJsonAtomic(getHistoryPath(), updatedHistory);
    try {
      if (updatedJobs.some((job, index) => job !== jobs[index])) writeJsonAtomic(getJobsPath(), updatedJobs);
    } catch (error) {
      if (historyChanged) writeJsonAtomic(getHistoryPath(), history);
      throw error;
    }
    return { ok: true };
  }));
}

function mutateJob(id, change) {
  return withFileLock(getJobsPath(), () => {
    const list = readPersistedJobs();
    const job = list.find(j => j.id === id);
    if (!job) throw problem(404, "Job not found: " + id);
    change(job);
    writePersistedJobs(list);
    return job;
  });
}

export function claimCallback(id, retry = false) {
  return mutateJob(id, job => {
    const expired = job.callbackStatus === "sending" && !(Date.parse(job.callbackLeaseUntil) > Date.now());
    const eligible = retry ? ["failed","unrouted"].includes(job.callbackStatus) : job.callbackStatus === "pending" || expired;
    if (!callbackTerminal.has(job.status) || job.notifyOnComplete === false || !eligible || job.callbackSent) {
      throw problem(409, "Callback is not eligible for " + (retry ? "retry" : "delivery"));
    }
    if (expired && job.callbackDeliveryStartedAt) {
      // The host has no idempotency key. Require an explicit retry when receipt is uncertain.
      Object.assign(job, { callbackStatus: "failed", callbackClaim: null, callbackLeaseUntil: null,
        callbackError: "Delivery acknowledgement unknown. Check the destination before retrying." });
      return;
    }
    job.callbackDeliveryStartedAt = null;
    job.callbackStatus = "sending";
    job.callbackClaim = crypto.randomUUID();
    job.callbackLeaseUntil = new Date(Date.now() + 120000).toISOString();
    job.callbackAttempts = (job.callbackAttempts || 0) + 1;
  });
}

export function beginCallbackSend(id, token) {
  return mutateJob(id, job => {
    if (!token || job.callbackClaim !== token || Date.parse(job.callbackLeaseUntil) <= Date.now()) {
      throw problem(409, "Callback lease expired.");
    }
    job.callbackDeliveryStartedAt = new Date().toISOString();
  });
}

export function finishCallback(id, token, patch) {
  return mutateJob(id, job => {
    if (!token || job.callbackClaim !== token) throw problem(409, "Callback lease no longer owned");
    Object.assign(job, patch, { callbackClaim: null, callbackLeaseUntil: null });
  });
}

export function claimPeriodicCheckIn(id, intervalSeconds) {
  return mutateJob(id, job => {
    if (!["running", "running_detached"].includes(job.status) || job.notifyOnComplete === false) {
      throw problem(409, "Job is not eligible for periodic check-in.");
    }
    const now = Date.now();
    if (job.checkInClaim && Date.parse(job.checkInLeaseUntil) > now) {
      throw problem(409, "Periodic check-in already in progress.");
    }
    const refMs = Date.parse(job.lastCheckInAt || job.startedAt) || now;
    if (now - refMs < intervalSeconds * 1000) {
      throw problem(409, "Periodic check-in interval has not elapsed.");
    }
    job.checkInClaim = crypto.randomUUID();
    job.checkInLeaseUntil = new Date(now + 60_000).toISOString();
  });
}

export function finishPeriodicCheckIn(id, token, { delivered = false, error = null } = {}) {
  return mutateJob(id, job => {
    if (!token || job.checkInClaim !== token) throw problem(409, "Check-in lease no longer owned");
    job.checkInClaim = null;
    job.checkInLeaseUntil = null;
    job.lastCheckInAt = new Date().toISOString();
    if (delivered) {
      job.checkInCount = (job.checkInCount || 0) + 1;
      job.lastCheckInError = null;
    } else if (error) {
      job.lastCheckInError = String(error);
    }
  });
}

function buildAutoHealPrompt(job, attempt, maxHeals, stallReason) {
  return [
    `[Auto-Heal Resume #${attempt}/${maxHeals}]`,
    `Previous background run (${job.id}) was stopped by the L1 network-stall watchdog (${stallReason || "upstream stream stalled"}).`,
    `Do NOT repeat already-completed downloads, installs, or file edits.`,
    `First inspect current workspace state (e.g., git status, existing files, recent test outputs) in ${job.cwd}.`,
    `If all requested changes and verification checks are already complete, summarize the verified results immediately and finish.`,
    `Otherwise continue cleanly from the exact point where work paused and complete the remaining verification.`,
  ].join("\n");
}

export function reconcilePersistedJobs(localRunningIds = new Set()) {
  return withFileLock(getJobsPath(), () => {
    const list = readPersistedJobs();
    let changed = false;
    for (const rec of list) {
      if (localRunningIds.has(rec.id)) continue;
      if (!rec.callbackStatus) {
        rec.callbackStatus = rec.callbackSent ? "sent" : !rec.notifyOnComplete ? "skipped" :
          normalizeCallbackTarget(rec.callbackTarget) ? "pending" : "unrouted";
        changed = true;
      }
      if (!activeStates.has(rec.status)) continue;
      const ownerAlive = isPidAlive(rec.ownerPid);
      let childAlive = isPidAlive(rec.pid);
      if (childAlive && !ownerAlive && rec.processIdentity) {
        const current = processIdentity(rec.pid);
        if (current && !matchesProcess(rec.processIdentity, current)) childAlive = false;
      }
      const justStarted = Date.now() - Date.parse(rec.startedAt) < 30000;
      if (ownerAlive && rec.status !== "running_detached" && (childAlive || justStarted)) continue;
      if (childAlive) {
        if (!ownerAlive && rec.canSteer) { rec.canSteer = false; changed = true; }
        if (rec.status === "running") { rec.status = "running_detached"; changed = true; }
        if (rec.sessionId && !inspectSessionLock(rec.sessionId).locked) {
          const lease = acquireSessionLock(rec.sessionId, { jobId: rec.id, pid: rec.pid,
            ownerPid: rec.ownerPid, processIdentity: rec.processIdentity, cwd: rec.cwd });
          if (lease.acquired) { rec.lockToken = lease.ownerToken; changed = true; }
        }
      } else {
        rec.status = rec.status === "stopping" ? "cancelled" : "interrupted";
        rec.activeTurnId = null;
        rec.canSteer = false;
        rec.finishedAt ||= new Date().toISOString();
        rec.error ||= "Process ended before the owner recorded completion.";
        if (rec.sessionId && rec.lockToken) releaseSessionLock(rec.sessionId, rec.lockToken);
        changed = true;
      }
    }
    if (changed) writePersistedJobs(list);
    return list;
  });
}

export class JobManager {
  constructor() {
    this.ownerId = crypto.randomUUID();
    scheduleCleanup();
    this.jobs = new Map();
    this._localRunningIds = new Set();
    this._syncFromDisk();
  }

  _syncFromDisk() {
    const list = readPersistedJobs();
    const seen = new Set();
    for (const rec of list) {
      if (!rec || !rec.id) continue;
      seen.add(rec.id);
      if (this._localRunningIds.has(rec.id) && this.jobs.has(rec.id)) {
        // Preserve in-memory live state, but merge callback fields updated by Sidecar
        const live = this.jobs.get(rec.id);
        live.callbackStatus = rec.callbackStatus;
        live.callbackSent = rec.callbackSent;
        live.callbackAt = rec.callbackAt;
        live.callbackError = rec.callbackError;
        live.callbackAttempts = rec.callbackAttempts || live.callbackAttempts || 0;
        live.lastCheckInAt = rec.lastCheckInAt || live.lastCheckInAt || null;
        live.checkInCount = rec.checkInCount || live.checkInCount || 0;
        live.lastCheckInError = rec.lastCheckInError ?? live.lastCheckInError ?? null;
        continue;
      }
      const existing = this.jobs.get(rec.id);
      this.jobs.set(rec.id, {
        ...rec,
        result: existing?.result || null,
        child: existing?.child || null,
        abortController: existing?.abortController || null,
        waiters: existing?.waiters || [],
      });
    }
    // Keep any pruned jobs clean
    for (const id of [...this.jobs.keys()]) {
      if (!seen.has(id) && !this._localRunningIds.has(id)) {
        this.jobs.delete(id);
      }
    }
  }

  _serializeJob(job) {
    return {
      id: job.id,
      parentJobId: job.parentJobId || null,
      addDirs: job.addDirs || [], skipGitRepoCheck: job.skipGitRepoCheck ?? true,
      processIdentity: job.processIdentity || null, lockToken: job.lockToken || null,
      conversationId: job.callbackTarget?.conversationId || null, transferredFrom: job.transferredFrom || null,
      durationMs: job.result?.durationMs ?? job.resultSummary?.durationMs ?? null,
      usage: job.result?.usage ?? job.resultSummary?.usage ?? job.usage ?? null,
      mode: job.mode,
      engine: job.engine, effectiveProvider: job.effectiveProvider ?? null,
      activeTurnId: job.activeTurnId ?? null, canSteer: steerable(job),
      ownerId: job.ownerId || null, steerCount: job.steerCount || 0, steerHistory: job.steerHistory || [],
      nativeGoal: job.nativeGoal ?? null, nativeGoalSync: job.nativeGoalSync, tokenBudget: job.tokenBudget,
      ephemeral: job.ephemeral, writableRoots: job.writableRoots,
      status: job.status,
      cwd: job.cwd,
      model: job.model || "",
      reasoningEffort: job.reasoningEffort || "",
      sandbox: job.sandbox || "workspace-write",
      goalId: job.goalId || null,
      milestoneId: job.milestoneId || null,
      prompt: job.prompt,
      promptPreview: job.promptPreview,
      startedAt: job.startedAt,
      lastEventAt: job.lastEventAt || job.startedAt,
      lastProgressAt: job.lastProgressAt || job.startedAt,
      timeoutSeconds: job.timeoutSeconds,
      phase: job.phase || "waiting_api",
      activeCommands: job.activeCommands || 0,
      activeTools: job.activeTools || 0,
      reconnectCount: job.reconnectCount || 0,
      autoHealCount: job.autoHealCount || 0,
      autoHealFromJobId: job.autoHealFromJobId || null,
      autoHealedToJobId: job.autoHealedToJobId || null,
      stallReason: job.stallReason || null,
      stallKind: job.stallKind || null,
      silenceWarning: Boolean(job.silenceWarning),
      recoveryChainId: job.recoveryChainId || job.id,
      zeroErrorSilenceKills: job.zeroErrorSilenceKills || 0,
      autoHealCircuitBroken: Boolean(job.autoHealCircuitBroken),
      lastCheckInAt: job.lastCheckInAt || null,
      checkInCount: job.checkInCount || 0,
      lastCheckInError: job.lastCheckInError || null,
      archived: Boolean(job.archived), archivedAt: job.archivedAt || null,
      finishedAt: job.finishedAt,
      pid: job.pid || null,
      ownerPid: job.ownerPid || process.pid,
      sessionId: job.sessionId || null,
      eventCount: job.eventCount || 0,
      recentEvents: (job.recentEvents || []).slice(-20),
      error: job.error || null,
      detachedNote: job.detachedNote || null,
      notifyOnComplete: Boolean(job.notifyOnComplete),
      callbackTarget: normalizeCallbackTarget(job.callbackTarget),
      callbackStatus: job.callbackStatus || "skipped",
      callbackSent: Boolean(job.callbackSent),
      callbackAttempts: job.callbackAttempts || 0,
      callbackAt: job.callbackAt || null,
      callbackError: job.callbackError || null,
      resultSummary: job.result
        ? {
            ok: job.result.ok,
            exitCode: job.result.exitCode,
            durationMs: job.result.durationMs,
            lastMessage: (job.result.lastMessage || "").slice(0, 6000),
            fileChanges: (job.result.fileChanges || []).slice(0, 40),
            commands: (job.result.commands || []).slice(0, 20),
            usage: job.result.usage || null,
            errors: (job.result.errors || []).slice(0, 10),
            warnings: (job.result.warnings || []).slice(0, 10),
          }
        : job.resultSummary || null,
    };
  }

  _persistJob(job) {
    return withFileLock(getJobsPath(), () => {
      const list = readPersistedJobs();
      const idx = list.findIndex(j => j.id === job.id);
      const serialized = this._serializeJob(job);
      if (idx >= 0) {
        const onDisk = list[idx];
        serialized.archived = Boolean(onDisk.archived);
        serialized.archivedAt = onDisk.archivedAt || null;
        for (const field of ["lastCheckInAt", "checkInCount", "lastCheckInError", "checkInClaim", "checkInLeaseUntil"]) {
          if (onDisk[field] !== undefined && serialized[field] == null) serialized[field] = onDisk[field];
        }
        if (onDisk.checkInClaim !== undefined) serialized.checkInClaim = onDisk.checkInClaim;
        if (onDisk.checkInLeaseUntil !== undefined) serialized.checkInLeaseUntil = onDisk.checkInLeaseUntil;
        if (typeof onDisk.checkInCount === "number" && onDisk.checkInCount > (serialized.checkInCount || 0)) {
          serialized.checkInCount = onDisk.checkInCount;
          serialized.lastCheckInAt = onDisk.lastCheckInAt;
          serialized.lastCheckInError = onDisk.lastCheckInError ?? null;
        }
        if (["stopping", "cancelled"].includes(onDisk.status)) {
          job.status = serialized.status = onDisk.status === "stopping" && activeStates.has(job.status) ? "stopping" : "cancelled";
          serialized.notifyOnComplete = false;
          serialized.callbackStatus = "skipped";
        } else if (serialized.callbackStatus !== "skipped") {
          for (const field of ["callbackStatus", "callbackSent", "callbackAt", "callbackError",
            "callbackAttempts", "callbackClaim", "callbackLeaseUntil", "callbackDeliveryStartedAt"]) {
            if (onDisk[field] !== undefined) serialized[field] = onDisk[field];
          }
        }
        list[idx] = serialized;
      } else list.unshift(serialized);
      list.sort((a,b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      writePersistedJobs(list);
    });
  }

  findActiveJobForSession(sessionId) {
    if (!sessionId || sessionId === "last") return null;
    this._syncFromDisk();
    for (const job of this.jobs.values()) {
      if (
        job.sessionId?.toLowerCase() === sessionId && activeStates.has(job.status)
      ) {
        return job;
      }
    }
    const lockInfo = inspectSessionLock(sessionId);
    if (lockInfo.locked && lockInfo.lock?.jobId) {
      return this.jobs.get(lockInfo.lock.jobId) || {
        id: lockInfo.lock.jobId,
        sessionId,
        status: "running_detached",
        pid: lockInfo.lock.pid,
        cwd: lockInfo.lock.cwd,
      };
    }
    return null;
  }

  startJob(options) {
    this._syncFromDisk();
    validateBooleans(options);
    validateEngineOptions(options);
    const records = reconcilePersistedJobs(this._localRunningIds);
    if (options.mode === "resume" || options.parentJobId || options.sessionId) options = resolveResume(options, records);
    if (typeof options.prompt !== "string" || !options.prompt.trim()) throw problem(400, "A prompt is required.");
    options.cwd = workingDirectory(options.cwd);
    options.addDirs = directoryList(options.addDirs || [], options.cwd);
    const settings = loadSettings();
    const engine = options.executionEngine ?? settings.executionEngine;
    options = { ...options, sandbox: options.sandbox || (engine === "exec" ? "workspace-write" : settings.sandbox),
      ephemeral: options.ephemeral ?? settings.ephemeral, transport: options.transport ?? settings.transport,
      skipGitRepoCheck: options.skipGitRepoCheck ?? settings.skipGitRepoCheck,
      disableDesktopNotify: options.disableDesktopNotify ?? settings.disableDesktopNotify,
      tokenBudget: options.tokenBudget ?? settings.tokenBudget, nativeGoalSync: options.nativeGoalSync ?? settings.nativeGoalSync };
    const prepared = engine === "app_server" ? prepareAppServerTurn(options) : null;
    const roots = options.sandbox === "workspace-write" ? writableRoots(options.cwd, options.addDirs) : [];
    const timeoutMs = options.timeoutMs === undefined ? settings.taskTimeoutSeconds * 1000 : options.timeoutMs;
    const stallPolicy = options.stallPolicy ?? settings.stallPolicy;
    const stallTimeoutMs = options.stallTimeoutMs ?? settings.stallThresholdSeconds * 1000;
    const reconnectStallMs = options.reconnectStallMs ?? settings.reconnectStallSeconds * 1000;
    const reasoningEffort = effectiveReasoningEffort(options, settings.reasoningEffort);
    const model = workerModel(settings, options.model, options.force_model);
    const mode = options.mode || (options.sessionId ? "resume" : "run");
    const exactSid =
      options.sessionId ? normalizeSessionId(options.sessionId) : "";

    if (mode === "resume" && (!exactSid || exactSid === "last")) {
      throw new Error(
        "Resuming a background job requires an exact session_id (no automatic 'last' fallback)."
      );
    }

    // Cross-process per-session mutual exclusion
    if (exactSid) {
      const existing = this.findActiveJobForSession(exactSid);
      if (existing) {
        if (options.transferCallback && existing.callbackTarget?.conversationId !== options.callbackTarget?.conversationId) {
          throw problem(409, "An active job already owns this session and its callback destination.");
        }
        return { job: existing, reused: true };
      }
    }

    const jobId = `codex_${crypto.randomBytes(4).toString("hex")}`;
    let lockedSessionId = null;
    let lockToken = null;

    if (exactSid) {
      const acq = acquireSessionLock(exactSid, {
        jobId,
        ownerPid: process.pid,
        cwd: options.cwd || process.cwd(),
      });
      if (!acq.acquired) {
        const existing =
          (acq.existing?.jobId && this.jobs.get(acq.existing.jobId)) || {
            id: acq.existing?.jobId || "active_session",
            sessionId: exactSid,
            status: "running_detached",
            pid: acq.existing?.pid || null,
            cwd: acq.existing?.cwd || options.cwd || "",
          };
        if (options.transferCallback) throw problem(409, "Session is already active; destination cannot be transferred.");
        return { job: existing, reused: true };
      }
      lockedSessionId = exactSid;
      lockToken = acq.ownerToken;
    }

    const abortController = new AbortController();
    const callbackTarget = normalizeCallbackTarget(options.callbackTarget);
    const notifyOnComplete =
      options.notifyOnComplete !== undefined
        ? Boolean(options.notifyOnComplete)
        : settings.progressionMode !== "manual";

    const initialCallbackStatus = !notifyOnComplete
      ? "skipped"
      : callbackTarget
        ? "pending"
        : "unrouted";

    const startedAt = new Date().toISOString();
    const parent = records.find(record => record.id === options.parentJobId);
    const recoveryChainId = parent?.recoveryChainId ?? parent?.id ?? crypto.randomUUID();
    // A manual resume can select an older ancestor. Records are stored newest first.
    const previousAttempt = parent && (records.find(record => record.recoveryChainId === recoveryChainId) || parent);
    const job = {
      id: jobId,
      parentJobId: options.parentJobId || null,
      lockToken, transferredFrom: options.transferredFrom || null, addDirs: options.addDirs,
      skipGitRepoCheck: options.skipGitRepoCheck ?? settings.skipGitRepoCheck,
      mode,
      engine, effectiveProvider: engine === "exec" ? effectiveExecProvider(options) : prepared.modelProvider ?? null,
      activeTurnId: null, canSteer: false, nativeGoal: null, nativeGoalSync: options.nativeGoalSync, tokenBudget: options.tokenBudget,
      ephemeral: options.ephemeral, writableRoots: roots,
      status: "running",
      cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
      model: model || "",
      reasoningEffort,
      sandbox: options.sandbox || "workspace-write",
      goalId: options.goalId || null,
      milestoneId: options.milestoneId || null,
      prompt: options.prompt,
      promptPreview: (options.prompt || "").replace(/\s+/g, " ").slice(0, 160),
      startedAt, lastEventAt: startedAt, timeoutSeconds: timeoutMs / 1000,
      lastProgressAt: startedAt,
      recoveryChainId,
      zeroErrorSilenceKills: previousAttempt?.zeroErrorSilenceKills ?? 0,
      autoHealCircuitBroken: false,
      stallKind: null,
      silenceWarning: false,
      phase: "waiting_api",
      activeCommands: 0,
      activeTools: 0,
      reconnectCount: 0,
      autoHealCount: Number.isInteger(options.autoHealCount) ? options.autoHealCount : 0,
      autoHealFromJobId: options.autoHealFromJobId || null,
      autoHealedToJobId: null,
      stallReason: null,
      lastCheckInAt: null,
      checkInCount: 0,
      lastCheckInError: null,
      archived: false, archivedAt: null,
      finishedAt: null,
      pid: null,
      ownerPid: process.pid, ownerId: this.ownerId, steerCount: 0, steerHistory: [],
      sessionId: exactSid || null,
      eventCount: 0,
      recentEvents: [],
      result: null,
      resultSummary: null,
      error: null,
      detachedNote: null,
      notifyOnComplete,
      callbackTarget,
      callbackStatus: initialCallbackStatus,
      callbackSent: false,
      callbackAttempts: 0,
      callbackAt: null,
      callbackError:
        initialCallbackStatus === "unrouted"
          ? "No trusted host conversationId available at dispatch time; result will stay in the panel."
          : null,
      child: null,
      abortController,
      waiters: [],
    };

    this.jobs.set(jobId, job);
    this._localRunningIds.add(jobId);
    let reservation;
    try {
      reservation = options.isAutoHeal ? null : reserveGoalDispatch(job.goalId, job.milestoneId);
      this._persistJob(job);
    } catch (err) {
      this._localRunningIds.delete(jobId);
      this.jobs.delete(jobId);
      try {
        withFileLock(getJobsPath(), () => {
          const list = readPersistedJobs();
          if (list.some(j => j.id === jobId)) writePersistedJobs(list.filter(j => j.id !== jobId));
        });
      } finally {
        try { abandonGoalDispatch(job.goalId, reservation); }
        finally { if (lockedSessionId) releaseSessionLock(lockedSessionId, lockToken); }
      }
      throw err;
    }

    let pendingAutoHeal = null;
    // A panel/MCP process can request cancellation without owning this stdio pipe.
    // Observe atomic jobs.json replacements so the owner can interrupt a silent turn.
    const jobsPath = getJobsPath();
    const checkExternalStop = () => {
      try {
        if (readPersistedJobs().some(j => j.id === jobId && ["stopping", "cancelled"].includes(j.status))) abortController.abort();
      } catch (err) { console.error("[codex-bridge] Cannot read cancellation request:", err.message); }
    };
    if (prepared) fs.watchFile(jobsPath, { persistent: false, interval: 350 }, checkExternalStop);
    const run = prepared ? opts => runAppServerTurn(opts, prepared) : runCodex;
    let acceptedTurnId = null;
    const lockSession = sid => {
      if (!lockedSessionId) {
        const acq = acquireSessionLock(sid, {
          jobId, pid: job.pid, ownerPid: process.pid, cwd: job.cwd, processIdentity: job.processIdentity,
        });
        if (!acq.acquired) throw new Error("Session already locked");
        lockedSessionId = sid;
        job.lockToken = lockToken = acq.ownerToken;
      }
      job.sessionId = sid;
    };
    const promise = Promise.resolve().then(() => run({
      ...options,
      mode,
      cwd: job.cwd,
      sandbox: job.sandbox, skipGitRepoCheck: job.skipGitRepoCheck,
      sessionId: exactSid || undefined,
      timeoutMs, stallPolicy, stallTimeoutMs, reconnectStallMs, reasoningEffort, model,
      transport: options.transport ?? settings.transport,
      disableDesktopNotify: options.disableDesktopNotify ?? settings.disableDesktopNotify,
      signal: abortController.signal,
      onSpawn: (child) => {
        job.child = child;
        job.lastEventAt = new Date().toISOString();
        job.pid = child.pid || null;
        job.processIdentity = processIdentity(job.pid);
        if (lockedSessionId && job.pid) {
          if (!updateSessionLockPid(lockedSessionId, lockToken, job.pid, job.processIdentity)) throw new Error("Lost session lock");
        }
        this._persistJob(job);
        if (job.goalId && engine === "exec") {
          recordGoalExecution(job.goalId, { ...job.callbackTarget, reservationId: reservation, incrementIteration: Boolean(reservation),
            milestoneId: job.milestoneId, sessionId: job.sessionId, jobId });
          reservation = null;
        }
      },
      onThreadReady: ({ sessionId, effectiveProvider }) => {
        lockSession(sessionId);
        job.effectiveProvider = effectiveProvider;
        this._persistJob(job);
      },
      onNativeGoal: goal => { job.nativeGoal = goal; this._persistJob(job); },
      onControlReady: control => {
        job.control = control;
        job.consumer = createConsumer(jobId, command => this._consumeSteer(job, command));
      },
      onTurnAccepted: ({ turnId }) => {
        if (acceptedTurnId === turnId) return;
        if (acceptedTurnId) throw new Error("Unexpected second turn for job " + jobId);
        if (job.goalId) recordGoalExecution(job.goalId, { ...job.callbackTarget, reservationId: reservation, incrementIteration: Boolean(reservation),
          milestoneId: job.milestoneId, sessionId: job.sessionId, jobId });
        reservation = null;
        acceptedTurnId = job.activeTurnId = turnId;
        job.canSteer = true;
        this._persistJob(job);
      },
      onProgress: ({ event, eventCount, summary, sessionId, usage, phase, activeCommands, activeTools, reconnectCount, lastProgressAt, silenceWarning, stallKind }) => {
        const at = new Date().toISOString();
        if (usage) job.usage = usage;
        if (event) job.lastEventAt = at;
        Object.assign(job, { eventCount, phase, activeCommands, activeTools, reconnectCount, lastProgressAt, silenceWarning, stallKind });
        if (sessionId) sessionId = normalizeSessionId(sessionId);
        const gotNewSession = sessionId && sessionId !== job.sessionId;
        if (gotNewSession) lockSession(sessionId);
        if (event?.type === "turn/completed") {
          job.activeTurnId = null;
          job.canSteer = false;
        }
        job.recentEvents.push({
          at,
          summary,
        });
        if (job.recentEvents.length > 40) {
          job.recentEvents.shift();
        }
        if (gotNewSession && job.goalId) {
          recordGoalExecution(job.goalId, {
            milestoneId: job.milestoneId,
            sessionId: job.sessionId,
            jobId: job.id,
            incrementIteration: false,
          });
        }
        this._persistJob(job);
      },
    }))
      .then((result) => {
        job.result = result;
        job.sessionId = result.sessionId?.toLowerCase() || job.sessionId;
        job.phase = result.ok ? "completed" : result.phase || job.phase;
        job.stallReason = result.stallReason || null;
        job.stallKind = result.stallKind;
        job.silenceWarning = result.silenceWarning;
        job.lastProgressAt = result.lastProgressAt;
        const wasCancelled = job.status === "stopping" || abortController.signal.aborted ||
          readPersistedJobs().some(j => j.id === job.id && ["stopping","cancelled"].includes(j.status));
        job.status = wasCancelled ? "cancelled" : result.ok
          ? "completed"
          : result.cancelled
            ? "cancelled"
            : result.timedOut
              ? "timed_out"
              : result.stalled
                ? "interrupted"
                : "failed";
        if (result.stalled && result.stallReason) {
          job.error = result.stallReason;
        }
        if (!wasCancelled && result.stalled && result.stallKind === "zero_error_silence") {
          job.zeroErrorSilenceKills += 1;
          if (job.zeroErrorSilenceKills >= 2) {
            job.autoHealCircuitBroken = true;
            job.error += " (Auto-heal circuit breaker: repeated zero-error silence kills in this recovery chain. Split the task, switch to reconnect_only, or use the app_server streaming engine.)";
          }
        } else {
          job.zeroErrorSilenceKills = 0;
        }
        job.finishedAt = new Date().toISOString();
        if (job.status === "cancelled") {
          job.callbackStatus = "skipped";
          job.result = { ...result, ok: false, cancelled: true };
        }
        const liveSettings = loadSettings();
        const maxHeals = liveSettings.maxAutoHeals ?? 2;
        if (
          !wasCancelled &&
          !job.ephemeral &&
          !job.autoHealCircuitBroken &&
          result.stalled &&
          liveSettings.autoHealEnabled &&
          (job.autoHealCount || 0) < maxHeals &&
          job.sessionId &&
          job.sessionId !== "last"
        ) {
          pendingAutoHeal = {
            attempt: (job.autoHealCount || 0) + 1,
            maxHeals,
            stallReason: result.stallReason,
            notifyOnComplete: job.notifyOnComplete,
          };
          job.notifyOnComplete = false;
          job.callbackStatus = "skipped";
        }
        if (engine === "exec" && job.goalId && job.sessionId) {
          recordGoalExecution(job.goalId, {
            milestoneId: job.milestoneId,
            sessionId: job.sessionId,
            jobId: job.id,
            incrementIteration: false,
          });
        }
        appendHistory({
          mode: job.mode, jobId: job.id, conversationId: callbackTarget?.conversationId || null, projectId: callbackTarget?.projectId || "",
          engine, effectiveProvider: job.effectiveProvider, writableRoots: roots, ephemeral: job.ephemeral,
          transferredFrom: job.transferredFrom, addDirs: job.addDirs, skipGitRepoCheck: job.skipGitRepoCheck,
          status: job.status,
          model: job.model || "(codex default)",
          reasoningEffort: job.reasoningEffort || "(default)",
          sandbox: job.sandbox || "workspace-write",
          goalId: job.goalId || null,
          milestoneId: job.milestoneId || null,
          cwd: result.cwd || job.cwd,
          sessionId: job.sessionId || null,
          durationMs: result.durationMs || 0,
          usage: result.usage || null,
          prompt: job.prompt,
          promptPreview: job.promptPreview,
        });
      })
      .catch((err) => {
        job.error = err.message || String(err);
        job.status = abortController.signal.aborted ? "cancelled" : "failed";
        job.finishedAt = new Date().toISOString();
        if (job.status === "cancelled") {
          job.callbackStatus = "skipped";
        }
      })
      .finally(() => {
        if (prepared) fs.unwatchFile(jobsPath, checkExternalStop);
        job.activeTurnId = job.control = null;
        job.canSteer = false;
        job.child = null;
        this._localRunningIds.delete(jobId);
        try {
          this._persistJob(job);
        } finally {
          job.consumer?.close();
          try { abandonGoalDispatch(job.goalId, reservation); }
          finally {
            try { if (lockedSessionId) releaseSessionLock(lockedSessionId, lockToken); }
            finally {
              if (pendingAutoHeal) {
                try {
                  const healed = this.resumeFromJob(job.id, {
                    prompt: buildAutoHealPrompt(job, pendingAutoHeal.attempt, pendingAutoHeal.maxHeals, pendingAutoHeal.stallReason),
                    autoHealCount: pendingAutoHeal.attempt,
                    autoHealFromJobId: job.id,
                    isAutoHeal: true,
                    notifyOnComplete: pendingAutoHeal.notifyOnComplete,
                    stallPolicy: options.stallPolicy,
                    stallTimeoutMs: options.stallTimeoutMs,
                    reconnectStallMs: options.reconnectStallMs,
                    postTurnGraceMs: options.postTurnGraceMs,
                  });
                  job.autoHealedToJobId = healed.job.id;
                  this._persistJob(job);
                } catch (healErr) {
                  job.error = `${job.error || "Network stall"} (auto-heal failed: ${healErr.message})`;
                  if (pendingAutoHeal.notifyOnComplete) {
                    job.notifyOnComplete = true;
                    job.callbackStatus = job.callbackTarget ? "pending" : "unrouted";
                  }
                  this._persistJob(job);
                }
              }
              for (const wake of job.waiters.splice(0)) wake();
            }
          }
        }
      });

    promise.catch(err => console.error("[codex-bridge] Job finalization failed:", err.message));
    job.promise = promise;
    return { job, reused: false };
  }

  /**
   * Structured resume from a prior job_id:
   * - Inherits exact sessionId, cwd, goalId, milestoneId, reasoningEffort, sandbox, callbackTarget. Model routing uses current preferences.
   * - Refuses missing sessionId (no 'last' fallback).
   * - Enforces sandbox non-escalation unless allowSandboxEscalation is explicitly true.
   * - Enforces cross-process per-session mutual exclusion (reuses active job if already running).
   */
  resumeFromJob(oldJobId, overrides = {}) {
    return this.startJob({ ...overrides, parentJobId: oldJobId });
  }

  async getStatus(jobId, waitSeconds = 0) {
    this._syncFromDisk();
    const job = this.jobs.get(jobId);
    if (!job) return null;

    if (job.status === "running" && this._localRunningIds.has(jobId) && waitSeconds > 0) {
      const clampedMs = Math.min(waitSeconds, 120) * 1000;
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, clampedMs);
        timer.unref();
        job.waiters.push(finish);
      });
    }

    this._syncFromDisk();
    return this.jobs.get(jobId) || job;
  }

  async steerJob({ jobId, expectedTurnId, message, callerConversationId, conversationId,
    wait = true, waitSeconds = 12 }) {
    if (typeof wait !== "boolean" || !Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 120 ||
        (wait && waitSeconds === 0)) throw problem(400, "Invalid steer wait.");
    if (!validMessage(message)) throw problem(400, "message must contain 1 to 16000 characters.");
    const requestId = crypto.randomUUID();
    const receipt = { requestId, jobId };
    let command, local, localResult;
    withFileLock(getJobsPath(), () => {
      const job = readPersistedJobs().find(row => row.id === jobId);
      if (!job) throw problem(404, "Job not found.");
      const bound = job.callbackTarget?.conversationId?.toLowerCase();
      const contexts = [callerConversationId, conversationId].filter(id => id !== undefined && id !== null);
      if (bound && (!contexts.length || contexts.some(id => typeof id !== "string" || id.toLowerCase() !== bound))) {
        throw problem(403, "Steer requires the bound conversation.");
      }
      if (job.engine !== "app_server" || job.status === "running_detached") {
        throw problem(409, "Stop the job and continue with codex_start(resume_job_id=" + jobId + ").");
      }
      const turn = expectedTurnId === undefined ? job.activeTurnId : expectedTurnId;
      Object.assign(receipt, { sessionId: job.sessionId, turnId: turn, currentTurnId: job.activeTurnId });
      if (!steerable(job) || turn !== job.activeTurnId || !isPidAlive(job.ownerPid)) {
        Object.assign(receipt, { status: "rejected", error: "No matching active turn." });
        return;
      }
      const now = Date.now();
      command = { requestId, jobId, ownerId: job.ownerId, ownerPid: job.ownerPid, threadId: job.sessionId,
        expectedTurnId: turn, message, createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + (wait ? waitSeconds * 1000 : 12000)).toISOString() };
      if (this._localRunningIds.has(jobId)) local = this.jobs.get(jobId)?.consumer;
      localResult = publish(command, wait && local);
    });
    if (!command) return receipt;
    void local?.drain();
    if (!wait) return { ...receipt, status: "queued" };
    const result = await waitForAck(command, waitSeconds * 1000, localResult);
    return { ...receipt, ...result };
  }

  async _consumeSteer(job, cmd) {
    const disk = readPersistedJobs().find(row => row.id === job.id);
    let result;
    try {
      if (!disk || !steerable(disk) || !steerable(job) || cmd.ownerId !== this.ownerId ||
          disk.ownerId !== cmd.ownerId || cmd.jobId !== job.id || cmd.ownerPid !== process.pid ||
          cmd.threadId !== job.sessionId || cmd.threadId !== disk.sessionId ||
          cmd.expectedTurnId !== disk.activeTurnId || cmd.expectedTurnId !== job.activeTurnId ||
          !(Date.parse(cmd.createdAt) <= Date.now() && Date.parse(cmd.expiresAt) > Date.now()) || !validMessage(cmd.message)) {
        throw new Error("Expired command, changed owner or no matching active turn.");
      }
      const lease = readJson(getSessionLockPath(cmd.threadId), null, value => Boolean(value));
      if (!lease || lease.ownerToken !== job.lockToken || lease.jobId !== job.id) throw new Error("Lost session ownership.");
      const ack = await job.control.sendSteer(cmd.expectedTurnId, cmd.message);
      if (ack?.turnId !== cmd.expectedTurnId) throw new Error("Codex acknowledged a different turn.");
      result = { status: "accepted", turnId: ack.turnId };
    } catch (err) {
      result = { status: "rejected", error: err.message, currentTurnId: job.activeTurnId };
    }
    result.at = new Date().toISOString();
    const event = { requestId: cmd.requestId, at: result.at, turnId: cmd.expectedTurnId,
      status: result.status, preview: typeof cmd.message === "string" ? cmd.message.slice(0, 160) : "" };
    if (cmd.ownerId === this.ownerId && disk?.ownerId === this.ownerId) {
      mutateJob(job.id, row => {
        if (row.ownerId !== this.ownerId) return;
        if (result.status === "accepted") row.steerCount++;
        row.steerHistory = [...row.steerHistory, event].slice(-20);
        job.steerCount = row.steerCount;
        job.steerHistory = row.steerHistory;
      });
    }
    return result;
  }

  async stopJob(jobId) {
    this._syncFromDisk();
    const job = this.jobs.get(jobId);
    if (!job) return { found: false };

    if (!activeStates.has(job.status)) return { found: true, alreadyFinished: true, status: job.status };
    const local = this._localRunningIds.has(jobId);
    if (!local && job.pid && isPidAlive(job.pid) && !matchesProcess(job.processIdentity, processIdentity(job.pid))) {
      return { found: true, cancelled: false, error: "Cannot confirm process identity for this job." };
    }
    if (!local && !job.pid) return { found: true, cancelled: false, error: "Job has not recorded a PID yet." };
    mutateJob(jobId, rec => {
      if (!activeStates.has(rec.status)) throw problem(409, "Job already finished.");
      Object.assign(rec, { status: "stopping", notifyOnComplete: false, callbackStatus: "skipped" });
    });
    job.status = "stopping";
    job.notifyOnComplete = false;
    job.callbackStatus = "skipped";
    if (local) {
      job.abortController.abort();
      let timer;
      try {
        const stopped = await Promise.race([job.promise.then(() => true),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), 8000); })]);
        if (!stopped) return { found: true, cancelled: false, error: "Process termination has not been confirmed." };
      } finally { clearTimeout(timer); }
    } else {
      if (job.engine === "app_server" && isPidAlive(job.ownerPid)) {
        for (let i = 0; i < 35; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          const ended = readPersistedJobs().find(j => j.id === jobId)?.status === "cancelled";
          if (ended && !isPidAlive(job.pid)) return { found: true, cancelled: true, pid: job.pid };
        }
      }
      if (isPidAlive(job.pid) && !killPidTree(job.pid, job.processIdentity)) {
        return { found: true, cancelled: false, error: "Unable to confirm process tree termination." };
      }
      for (let i = 0; i < 30 && isPidAlive(job.pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
      if (isPidAlive(job.pid)) return { found: true, cancelled: false, error: "Process still running." };
      job.status = "cancelled";
      job.canSteer = false;
      job.activeTurnId = null;
      job.finishedAt = new Date().toISOString();
      this._persistJob(job);
      if (job.sessionId) releaseSessionLock(job.sessionId, job.lockToken);
    }
    return { found: true, cancelled: true, pid: job.pid };
  }

  listJobs() {
    this._syncFromDisk();
    return [...this.jobs.values()]
      .sort((a, b) =>
        String(b.startedAt || "").localeCompare(String(a.startedAt || ""))
      )
      .map((j) => ({
        id: j.id,
        parentJobId: j.parentJobId || null,
        mode: j.mode,
        status: j.status,
        pid: j.pid || null,
        sandbox: j.sandbox || "workspace-write",
        sessionId: j.sessionId,
        goalId: j.goalId,
        milestoneId: j.milestoneId,
        cwd: j.cwd,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        eventCount: j.eventCount,
        callbackStatus: j.callbackStatus,
        callbackTarget: j.callbackTarget,
        promptPreview: j.promptPreview,
      }));
  }

  async cancelAll() {
    await Promise.allSettled([...this._localRunningIds].map(id => this.stopJob(id)));
  }

  formatJobStatus(job) {
    const steering = [`Engine: ${job.engine || "exec"}`, `Active Turn: ${job.activeTurnId || "(none)"}`,
      `Can Steer: ${steerable(job)}`, `Steer Count: ${job.steerCount || 0}`];
    const timeout = "Task Timeout: " + (job.timeoutSeconds === 0 ? "unlimited" :
      job.timeoutSeconds === undefined ? "(unrecorded)" : job.timeoutSeconds + "s");
    if (job.result) {
      const extra = [timeout, ...steering];
      if (job.autoHealCircuitBroken) extra.push(job.error);
      if (job.parentJobId) extra.push(`Parent Job: ${job.parentJobId}`);
      if (job.goalId) {
        extra.push(
          `Goal: ${job.goalId}${job.milestoneId ? ` / ${job.milestoneId}` : ""}`
        );
      }
      extra.push(
        `Callback: ${job.callbackStatus}${job.callbackTarget ? ` -> ${job.callbackTarget.conversationId}` : ""}${job.callbackError ? ` (${job.callbackError})` : ""}`
      );
      return `Job ID: ${job.id}\n${extra.join("\n")}\n${formatCodexResult(job.result)}`;
    }

    const lines = [
      `Job ID: ${job.id}`,
      `Status: ${job.status}`,
      `Phase: ${job.phase || "waiting_api"}${job.reconnectCount ? ` (reconnects=${job.reconnectCount})` : ""}`,
      timeout, ...steering,
      `Mode: ${job.mode}`,
      `Session ID: ${job.sessionId || "(none)"}`,
      `Working Dir: ${job.cwd}`,
      `Sandbox: ${job.sandbox || "workspace-write"}`,
      `PID: ${job.pid || "(none)"}`,
      `Started At: ${job.startedAt}`,
      `Last Event At: ${job.lastEventAt || job.startedAt}`,
      `Events Seen: ${job.eventCount}`,
      `Callback: ${job.callbackStatus}${job.callbackTarget ? ` -> ${job.callbackTarget.conversationId}` : ""}`,
    ];

    if (job.autoHealCount > 0) lines.push(`Auto-Heal Attempt: #${job.autoHealCount}${job.autoHealFromJobId ? ` (from ${job.autoHealFromJobId})` : ""}`);
    if (job.autoHealedToJobId) lines.push(`Auto-Healed To: ${job.autoHealedToJobId}`);
    if (job.checkInCount > 0) lines.push(`Periodic Checks: ${job.checkInCount}${job.lastCheckInAt ? ` (last ${job.lastCheckInAt})` : ""}`);
    if (job.parentJobId) lines.push(`Parent Job: ${job.parentJobId}`);
    if (job.goalId) {
      lines.push(
        `Goal: ${job.goalId}${job.milestoneId ? ` / ${job.milestoneId}` : ""}`
      );
    }
    if (job.finishedAt) lines.push(`Finished At: ${job.finishedAt}`);
    if (job.detachedNote) lines.push(`\n## Detached Process Notice\n\n${job.detachedNote}`);
    if (job.callbackError) lines.push(`Callback Error: ${job.callbackError}`);
    if (job.error) lines.push(`\n## Error\n\n${job.error}`);

    if (job.status === "running_detached") {
      lines.push(
        `\nOriginal Codex process (PID ${job.pid}) is still running. Wait for it to exit or call \`codex_cancel(job_id="${job.id}")\` before resuming.`
      );
    } else if (job.status === "interrupted" && job.sessionId) {
      lines.push(
        `\nResume safely with \`codex_start(resume_job_id="${job.id}", prompt="...")\` (preserves cwd, sandbox, goal & milestone).`
      );
    }

    if (job.resultSummary?.lastMessage) {
      lines.push(`\n## Last Codex Response\n\n${job.resultSummary.lastMessage}`);
    }
    if (job.recentEvents?.length > 0) {
      const tail = job.recentEvents
        .slice(-12)
        .map((e) => `- [${e.at}] ${e.summary}`)
        .join("\n");
      lines.push(`\n## Recent Progress\n\n${tail}`);
    }

    return lines.join("\n");
  }
}
