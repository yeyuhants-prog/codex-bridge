import { readJson, withFileLock } from "./file-store.js";
import { processIdentity, matchesProcess } from "./process-identity.js";
import { validateBooleans, problem } from "./validation.js";
import { resolveResume, directoryList, workingDirectory } from "./run-policy.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  runCodex,
  formatCodexResult,
  killPidTree,
} from "./codex-runner.js";
import {
  getJobsPath,
  writeJsonAtomic,
  loadSettings,
  appendHistory,
} from "./settings-store.js";
import { abandonGoalDispatch, reserveGoalDispatch, recordGoalExecution } from "./goal-store.js";
import {
  isPidAlive, normalizeSessionId,
  inspectSessionLock,
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
  return readJson(getJobsPath(), [], rows => Array.isArray(rows) && rows.every(row => typeof row?.id === "string"));
}

function writePersistedJobs(list) {
  let archived = 0;
  const retained = list.filter(j => activeStates.has(j.status) ||
    (j.notifyOnComplete && !j.callbackSent && (!j.callbackStatus || ["pending", "sending", "failed", "unrouted"].includes(j.callbackStatus))) ||
    ++archived <= MAX_STORED_JOBS);
  writeJsonAtomic(getJobsPath(), retained);
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
        if (rec.status === "running") { rec.status = "running_detached"; changed = true; }
        if (rec.sessionId && !inspectSessionLock(rec.sessionId).locked) {
          const lease = acquireSessionLock(rec.sessionId, { jobId: rec.id, pid: rec.pid,
            ownerPid: rec.ownerPid, processIdentity: rec.processIdentity, cwd: rec.cwd });
          if (lease.acquired) { rec.lockToken = lease.ownerToken; changed = true; }
        }
      } else {
        rec.status = rec.status === "stopping" ? "cancelled" : "interrupted";
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
      usage: job.result?.usage ?? job.resultSummary?.usage ?? null,
      mode: job.mode,
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
    if (typeof options.prompt !== "string" || !options.prompt.trim()) throw problem(400, "A prompt is required.");
    options.cwd = workingDirectory(options.cwd);
    options.addDirs = directoryList(options.addDirs || [], options.cwd);
    reconcilePersistedJobs(this._localRunningIds);
    const settings = loadSettings();
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

    const job = {
      id: jobId,
      parentJobId: options.parentJobId || null,
      lockToken, transferredFrom: options.transferredFrom || null, addDirs: options.addDirs,
      skipGitRepoCheck: options.skipGitRepoCheck ?? settings.skipGitRepoCheck,
      mode,
      status: "running",
      cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
      model: options.model || "",
      reasoningEffort: options.reasoningEffort || "",
      sandbox: options.sandbox || "workspace-write",
      goalId: options.goalId || null,
      milestoneId: options.milestoneId || null,
      prompt: options.prompt,
      promptPreview: (options.prompt || "").replace(/\s+/g, " ").slice(0, 160),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pid: null,
      ownerPid: process.pid,
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
      reservation = reserveGoalDispatch(job.goalId, job.milestoneId);
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

    let lastPersistAt = 0;

    const promise = Promise.resolve().then(() => runCodex({
      ...options,
      mode,
      cwd: job.cwd,
      sandbox: job.sandbox, skipGitRepoCheck: job.skipGitRepoCheck,
      sessionId: exactSid || undefined,
      timeoutMs: options.timeoutMs ?? 1_800_000,
      signal: abortController.signal,
      onSpawn: (child) => {
        job.child = child;
        job.pid = child.pid || null;
        job.processIdentity = processIdentity(job.pid);
        if (lockedSessionId && job.pid) {
          if (!updateSessionLockPid(lockedSessionId, lockToken, job.pid, job.processIdentity)) throw new Error("Lost session lock");
        }
        this._persistJob(job);
        if (reservation) {
          recordGoalExecution(job.goalId, { reservationId: reservation, milestoneId: job.milestoneId, sessionId: job.sessionId, jobId });
          reservation = null;
        }
      },
      onProgress: ({ eventCount, summary, sessionId }) => {
        job.eventCount = eventCount;
        if (sessionId) sessionId = normalizeSessionId(sessionId);
        const gotNewSession = sessionId && sessionId !== job.sessionId;
        if (sessionId) job.sessionId = sessionId;
        if (gotNewSession && !lockedSessionId) {
          const acq = acquireSessionLock(sessionId, {
            jobId: job.id,
            pid: job.pid,
            ownerPid: process.pid,
            cwd: job.cwd, processIdentity: job.processIdentity,
          });
          if (!acq.acquired) throw new Error("Session already locked");
          lockedSessionId = sessionId;
          job.lockToken = lockToken = acq.ownerToken;
        }
        job.recentEvents.push({
          at: new Date().toISOString(),
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
        const now = Date.now();
        if (gotNewSession || now - lastPersistAt > 2000) {
          lastPersistAt = now;
          this._persistJob(job);
        }
      },
    }))
      .then((result) => {
        job.result = result;
        job.sessionId = result.sessionId?.toLowerCase() || job.sessionId;
        job.status = (job.status === "stopping" || abortController.signal.aborted ||
          readPersistedJobs().some(j => j.id === job.id && ["stopping","cancelled"].includes(j.status))) ? "cancelled" : result.ok
          ? "completed"
          : result.cancelled
            ? "cancelled"
            : result.timedOut
              ? "timed_out"
              : "failed";
        job.finishedAt = new Date().toISOString();
        if (job.status === "cancelled") {
          job.callbackStatus = "skipped";
          job.result = { ...result, ok: false, cancelled: true };
        }
        if (job.goalId && job.sessionId) {
          recordGoalExecution(job.goalId, {
            milestoneId: job.milestoneId,
            sessionId: job.sessionId,
            jobId: job.id,
            incrementIteration: false,
          });
        }
        appendHistory({
          mode: job.mode, jobId: job.id, conversationId: callbackTarget?.conversationId || null,
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
        job.child = null;
        this._localRunningIds.delete(jobId);
        try {
          this._persistJob(job);
        } finally {
          try { abandonGoalDispatch(job.goalId, reservation); }
          finally {
            try { if (lockedSessionId) releaseSessionLock(lockedSessionId, lockToken); }
            finally { for (const wake of job.waiters.splice(0)) wake(); }
          }
        }
      });

    promise.catch(err => console.error("[codex-bridge] Job finalization failed:", err.message));
    job.promise = promise;
    return { job, reused: false };
  }

  /**
   * Structured resume from a prior job_id:
   * - Inherits exact sessionId, cwd, goalId, milestoneId, model, reasoningEffort, sandbox, callbackTarget.
   * - Refuses missing sessionId (no 'last' fallback).
   * - Enforces sandbox non-escalation unless allowSandboxEscalation is explicitly true.
   * - Enforces cross-process per-session mutual exclusion (reuses active job if already running).
   */
  resumeFromJob(oldJobId, overrides = {}) {
    return this.startJob(resolveResume({ ...overrides, parentJobId: oldJobId }, readPersistedJobs()));
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
      if (isPidAlive(job.pid) && !killPidTree(job.pid, job.processIdentity)) {
        return { found: true, cancelled: false, error: "Unable to confirm process tree termination." };
      }
      for (let i = 0; i < 30 && isPidAlive(job.pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
      if (isPidAlive(job.pid)) return { found: true, cancelled: false, error: "Process still running." };
      job.status = "cancelled";
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
    if (job.result) {
      const extra = [];
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
      `Mode: ${job.mode}`,
      `Session ID: ${job.sessionId || "(none)"}`,
      `Working Dir: ${job.cwd}`,
      `Sandbox: ${job.sandbox || "workspace-write"}`,
      `PID: ${job.pid || "(none)"}`,
      `Started At: ${job.startedAt}`,
      `Events Seen: ${job.eventCount}`,
      `Callback: ${job.callbackStatus}${job.callbackTarget ? ` -> ${job.callbackTarget.conversationId}` : ""}`,
    ];

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
