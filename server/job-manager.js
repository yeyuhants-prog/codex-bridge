import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  runCodex,
  formatCodexResult,
  killProcessTree,
  killPidTree,
  resolveResumeSandbox,
} from "./codex-runner.js";
import {
  getJobsPath,
  writeJsonAtomic,
  loadSettings,
  appendHistory,
} from "./settings-store.js";
import { recordGoalExecution } from "./goal-store.js";
import {
  isPidAlive,
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

export function readPersistedJobs() {
  const filePath = getJobsPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const arr = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function writePersistedJobs(list) {
  try {
    writeJsonAtomic(getJobsPath(), list.slice(0, MAX_STORED_JOBS));
  } catch {
    // Non-fatal
  }
}

/**
 * Reconcile detached / foreign-owner jobs on disk against live OS PIDs.
 * - If a job from another/restarted Node process still has a live Codex PID:
 *   mark `running_detached` and keep its session lock intact.
 * - If its Codex PID is dead: mark `interrupted` and release any stale lock.
 */
export function reconcilePersistedJobs(localRunningIds = new Set()) {
  const list = readPersistedJobs();
  let changed = false;

  for (const rec of list) {
    if (!rec || !rec.id) continue;
    if (localRunningIds.has(rec.id)) continue;

    // Normalize legacy jobs missing callbackStatus
    if (!rec.callbackStatus) {
      if (rec.callbackSent) {
        rec.callbackStatus = "sent";
      } else if (!rec.notifyOnComplete) {
        rec.callbackStatus = "skipped";
      } else if (!normalizeCallbackTarget(rec.callbackTarget)) {
        rec.callbackStatus = "unrouted";
      } else {
        rec.callbackStatus = "pending";
      }
      changed = true;
    }

    if (rec.status === "running" || rec.status === "running_detached") {
      // Check if owned by another still-alive Node owner process (e.g. Sidecar reading MCP's job)
      const ownerAlive =
        rec.ownerPid &&
        rec.ownerPid !== process.pid &&
        isPidAlive(rec.ownerPid);
      const childAlive = rec.pid ? isPidAlive(rec.pid) : false;

      if (ownerAlive && rec.status === "running") {
        // Active in sibling Node process (e.g. MCP owns it while Sidecar reads it)
        continue;
      }

      if (childAlive) {
        if (rec.status !== "running_detached") {
          rec.status = "running_detached";
          rec.detachedNote = `Original Codex process is still running (PID ${rec.pid}). Wait for it to finish or stop it explicitly before resuming.`;
          changed = true;
        }
        // Keep session lock alive while the detached child process is still running
        if (rec.sessionId) {
          const insp = inspectSessionLock(rec.sessionId);
          if (!insp.locked) {
            acquireSessionLock(rec.sessionId, {
              jobId: rec.id,
              pid: rec.pid,
              ownerPid: rec.ownerPid || process.pid,
              cwd: rec.cwd,
            });
          }
        }
      } else {
        rec.status = "interrupted";
        rec.finishedAt = rec.finishedAt || new Date().toISOString();
        rec.error =
          rec.error ||
          "Codex process ended while detached or before completion. Resume via the linked job/session if needed.";
        if (rec.sessionId) {
          releaseSessionLock(rec.sessionId, rec.id);
        }
        changed = true;
      }
    }
  }

  if (changed) {
    writePersistedJobs(list);
  }
  return list;
}

export function updateJobCallbackState(jobId, patch = {}) {
  const list = readPersistedJobs();
  const target = list.find((j) => j.id === jobId);
  if (!target) return null;

  if (patch.callbackStatus !== undefined) {
    target.callbackStatus = patch.callbackStatus;
  }
  if (patch.callbackSent !== undefined) {
    target.callbackSent = Boolean(patch.callbackSent);
  }
  if (patch.callbackAt !== undefined) {
    target.callbackAt = patch.callbackAt;
  }
  if (patch.callbackError !== undefined) {
    target.callbackError = patch.callbackError;
  }
  if (patch.incrementAttempts) {
    target.callbackAttempts = (target.callbackAttempts || 0) + 1;
  }

  writePersistedJobs(list);
  return target;
}

export class JobManager {
  constructor() {
    this.jobs = new Map();
    this._localRunningIds = new Set();
    this._syncFromDisk();
  }

  _syncFromDisk() {
    const list = reconcilePersistedJobs(this._localRunningIds);
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
      mode: job.mode,
      status: job.status,
      cwd: job.cwd,
      model: job.model || "",
      reasoningEffort: job.reasoningEffort || "",
      sandbox: job.sandbox || "workspace-write",
      goalId: job.goalId || null,
      milestoneId: job.milestoneId || null,
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
    const list = readPersistedJobs();
    const idx = list.findIndex((j) => j.id === job.id);
    const serialized = this._serializeJob(job);
    if (idx !== -1) {
      // Preserve callback status updates written concurrently by Sidecar
      const onDisk = list[idx];
      if (
        onDisk.callbackStatus &&
        onDisk.callbackStatus !== "pending" &&
        serialized.callbackStatus === "pending"
      ) {
        serialized.callbackStatus = onDisk.callbackStatus;
        serialized.callbackSent = Boolean(onDisk.callbackSent);
        serialized.callbackAt = onDisk.callbackAt || null;
        serialized.callbackError = onDisk.callbackError || null;
        serialized.callbackAttempts = onDisk.callbackAttempts || 0;
        job.callbackStatus = serialized.callbackStatus;
        job.callbackSent = serialized.callbackSent;
        job.callbackAt = serialized.callbackAt;
        job.callbackError = serialized.callbackError;
        job.callbackAttempts = serialized.callbackAttempts;
      }
      list[idx] = serialized;
    } else {
      list.unshift(serialized);
    }
    list.sort((a, b) =>
      String(b.startedAt || "").localeCompare(String(a.startedAt || ""))
    );
    writePersistedJobs(list);
  }

  findActiveJobForSession(sessionId) {
    if (!sessionId || sessionId === "last") return null;
    this._syncFromDisk();
    for (const job of this.jobs.values()) {
      if (
        job.sessionId === sessionId &&
        (job.status === "running" || job.status === "running_detached")
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
    const settings = loadSettings();
    const mode = options.mode || (options.sessionId ? "resume" : "run");
    const exactSid =
      typeof options.sessionId === "string" ? options.sessionId.trim() : "";

    if (mode === "resume" && (!exactSid || exactSid === "last")) {
      throw new Error(
        "Resuming a background job requires an exact session_id (no automatic 'last' fallback)."
      );
    }

    // Cross-process per-session mutual exclusion
    if (exactSid) {
      const existing = this.findActiveJobForSession(exactSid);
      if (existing) {
        return { job: existing, reused: true };
      }
    }

    const jobId = `codex_${crypto.randomBytes(4).toString("hex")}`;
    let lockedSessionId = null;

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
        return { job: existing, reused: true };
      }
      lockedSessionId = exactSid;
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
      mode,
      status: "running",
      cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
      model: options.model || "",
      reasoningEffort: options.reasoningEffort || "",
      sandbox: options.sandbox || "workspace-write",
      goalId: options.goalId || null,
      milestoneId: options.milestoneId || null,
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
    this._persistJob(job);

    if (job.goalId) {
      recordGoalExecution(job.goalId, {
        milestoneId: job.milestoneId,
        sessionId: job.sessionId,
        jobId: job.id,
        incrementIteration: true,
      });
    }

    let lastPersistAt = 0;

    const promise = runCodex({
      ...options,
      mode,
      cwd: job.cwd,
      sandbox: job.sandbox,
      sessionId: exactSid || undefined,
      timeoutMs: options.timeoutMs ?? 1_800_000,
      signal: abortController.signal,
      onSpawn: (child) => {
        job.child = child;
        job.pid = child.pid || null;
        if (lockedSessionId && job.pid) {
          updateSessionLockPid(lockedSessionId, job.id, job.pid);
        }
        this._persistJob(job);
      },
      onProgress: ({ eventCount, summary, sessionId }) => {
        job.eventCount = eventCount;
        const gotNewSession = sessionId && sessionId !== job.sessionId;
        if (sessionId) job.sessionId = sessionId;
        if (gotNewSession && !lockedSessionId) {
          const acq = acquireSessionLock(sessionId, {
            jobId: job.id,
            pid: job.pid,
            ownerPid: process.pid,
            cwd: job.cwd,
          });
          if (acq.acquired) {
            lockedSessionId = sessionId;
          }
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
    })
      .then((result) => {
        job.result = result;
        job.sessionId = result.sessionId || job.sessionId;
        job.status = result.ok
          ? "completed"
          : result.cancelled
            ? "cancelled"
            : result.timedOut
              ? "timed_out"
              : "failed";
        job.finishedAt = new Date().toISOString();
        if (job.status === "cancelled") {
          job.callbackStatus = "skipped";
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
          mode: job.mode,
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
        if (lockedSessionId) {
          releaseSessionLock(lockedSessionId, job.id, { force: true });
        }
        this._persistJob(job);
        const waiters = job.waiters.splice(0, job.waiters.length);
        for (const fn of waiters) fn();
      });

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
    this._syncFromDisk();
    const oldJob = this.jobs.get(oldJobId);
    if (!oldJob) {
      throw new Error(`Previous job not found: ${oldJobId}`);
    }
    const sid = typeof oldJob.sessionId === "string" ? oldJob.sessionId.trim() : "";
    if (!sid || sid === "last") {
      throw new Error(
        `Job ${oldJobId} has no verified session_id; manual handling is required.`
      );
    }
    if (!oldJob.cwd || !fs.existsSync(oldJob.cwd)) {
      throw new Error(
        `Original working directory for job ${oldJobId} is missing or invalid: ${oldJob.cwd || "(empty)"}`
      );
    }

    // If the old job itself or any job for the same session is still alive, return it without spawning.
    const active = this.findActiveJobForSession(sid);
    if (active) {
      return { job: active, reused: true, reason: active.status };
    }

    const effectiveSandbox = resolveResumeSandbox({
      requestedSandbox: overrides.sandbox,
      originalSandbox: oldJob.sandbox,
      allowEscalation: Boolean(overrides.allowSandboxEscalation),
    });

    const callbackTarget =
      normalizeCallbackTarget(overrides.callbackTarget) ||
      normalizeCallbackTarget(oldJob.callbackTarget);

    const prompt =
      (typeof overrides.prompt === "string" && overrides.prompt.trim()) ||
      `Continue from the interrupted/previous state of job ${oldJob.id} in ${oldJob.cwd}. Inspect what has already been completed, avoid redoing finished work, finish the remaining steps, and verify the results.`;

    return this.startJob({
      mode: "resume",
      parentJobId: oldJob.id,
      sessionId: sid,
      prompt,
      cwd: oldJob.cwd,
      sandbox: effectiveSandbox,
      model: overrides.model || oldJob.model || undefined,
      reasoningEffort:
        overrides.reasoningEffort || oldJob.reasoningEffort || undefined,
      goalId: overrides.goalId || oldJob.goalId || undefined,
      milestoneId: overrides.milestoneId || oldJob.milestoneId || undefined,
      callbackTarget,
      notifyOnComplete: overrides.notifyOnComplete,
      timeoutMs: overrides.timeoutMs,
      config: overrides.config,
      images: overrides.images,
    });
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

    if (job.status !== "running" && job.status !== "running_detached") {
      return { found: true, alreadyFinished: true, status: job.status };
    }

    job.notifyOnComplete = false;
    job.callbackStatus = "skipped";

    if (this._localRunningIds.has(jobId) && job.abortController) {
      job.abortController.abort();
      if (job.child) {
        killProcessTree(job.child);
      }
      this._persistJob(job);
      return { found: true, cancelled: true, pid: job.pid };
    }

    // Detached or foreign-owner process: explicitly kill by PID and wait briefly for exit
    if (job.pid && isPidAlive(job.pid)) {
      killPidTree(job.pid);
      for (let i = 0; i < 15; i += 1) {
        if (!isPidAlive(job.pid)) break;
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    const stillAlive = job.pid ? isPidAlive(job.pid) : false;
    if (stillAlive) {
      return {
        found: true,
        cancelled: false,
        error: `Failed to stop process PID ${job.pid}; still alive.`,
      };
    }

    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    job.error = "Stopped explicitly by user.";
    if (job.sessionId) {
      releaseSessionLock(job.sessionId, job.id, { force: true });
    }
    this._persistJob(job);
    return { found: true, cancelled: true, pid: job.pid };
  }

  cancelJob(jobId) {
    this._syncFromDisk();
    const job = this.jobs.get(jobId);
    if (!job) return { found: false };
    if (job.status !== "running" && job.status !== "running_detached") {
      return { found: true, alreadyFinished: true, status: job.status };
    }
    job.notifyOnComplete = false;
    job.callbackStatus = "skipped";
    if (job.abortController) {
      job.abortController.abort();
    }
    if (job.child) {
      killProcessTree(job.child);
    } else if (job.pid && isPidAlive(job.pid)) {
      killPidTree(job.pid);
    }
    if (!this._localRunningIds.has(jobId)) {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      job.error = "Cancelled by caller.";
      if (job.sessionId) {
        releaseSessionLock(job.sessionId, job.id, { force: true });
      }
    }
    this._persistJob(job);
    return { found: true, cancelled: true };
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

  cancelAll() {
    for (const id of [...this._localRunningIds]) {
      const job = this.jobs.get(id);
      if (job && job.status === "running") {
        job.abortController?.abort();
        if (job.child) {
          killProcessTree(job.child);
        }
        this._persistJob(job);
      }
    }
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
