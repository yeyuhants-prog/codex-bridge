import crypto from "node:crypto";
import fs from "node:fs";
import { runCodex, formatCodexResult, killProcessTree } from "./codex-runner.js";
import { getJobsPath, writeJsonAtomic, loadSettings } from "./settings-store.js";
import { recordGoalExecution } from "./goal-store.js";

const MAX_STORED_JOBS = 50;

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

export function markJobCallbackSent(jobId, info = {}) {
  const list = readPersistedJobs();
  const target = list.find((j) => j.id === jobId);
  if (!target) return null;
  target.callbackSent = true;
  target.callbackAt = new Date().toISOString();
  if (info.error) target.callbackError = String(info.error);
  writePersistedJobs(list);
  return target;
}

export class JobManager {
  constructor() {
    this.jobs = new Map();
    this._hydrateFromDisk();
  }

  _hydrateFromDisk() {
    const stored = readPersistedJobs();
    let changed = false;
    for (const rec of stored) {
      if (!rec || !rec.id) continue;
      if (rec.status === "running") {
        // After a server restart we can no longer stream stdio from an orphaned process.
        const alive = isPidAlive(rec.pid);
        rec.status = "interrupted";
        rec.finishedAt = rec.finishedAt || new Date().toISOString();
        rec.error = alive
          ? "MCP server restarted while Codex process was still running. Resume via session_id if needed."
          : "MCP server restarted before job completed. Resume via session_id if available.";
        changed = true;
      }
      this.jobs.set(rec.id, {
        ...rec,
        child: null,
        abortController: null,
        waiters: [],
      });
    }
    if (changed) {
      this._persistAll();
    }
  }

  _serializeJob(job) {
    return {
      id: job.id,
      mode: job.mode,
      status: job.status,
      cwd: job.cwd,
      model: job.model || "",
      reasoningEffort: job.reasoningEffort || "",
      sandbox: job.sandbox || "",
      goalId: job.goalId || null,
      milestoneId: job.milestoneId || null,
      promptPreview: job.promptPreview,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      pid: job.pid || null,
      sessionId: job.sessionId || null,
      eventCount: job.eventCount || 0,
      recentEvents: (job.recentEvents || []).slice(-20),
      error: job.error || null,
      notifyOnComplete: Boolean(job.notifyOnComplete),
      callbackSent: Boolean(job.callbackSent),
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
          }
        : job.resultSummary || null,
    };
  }

  _persistAll() {
    // Merge callback flags that may have been updated by the Sidecar process
    const diskMap = new Map(readPersistedJobs().map((j) => [j.id, j]));
    const list = [...this.jobs.values()]
      .sort((a, b) =>
        String(b.startedAt || "").localeCompare(String(a.startedAt || ""))
      )
      .map((job) => {
        const serialized = this._serializeJob(job);
        const onDisk = diskMap.get(job.id);
        if (onDisk?.callbackSent && !serialized.callbackSent) {
          serialized.callbackSent = true;
          serialized.callbackAt = onDisk.callbackAt || null;
          job.callbackSent = true;
          job.callbackAt = onDisk.callbackAt || null;
        }
        return serialized;
      });
    writePersistedJobs(list);
  }

  startJob(options) {
    const jobId = `codex_${crypto.randomBytes(4).toString("hex")}`;
    const abortController = new AbortController();
    const settings = loadSettings();

    const notifyOnComplete =
      options.notifyOnComplete !== undefined
        ? Boolean(options.notifyOnComplete)
        : settings.progressionMode !== "manual";

    const job = {
      id: jobId,
      mode: options.mode || "run",
      status: "running",
      cwd: options.cwd || process.cwd(),
      model: options.model || "",
      reasoningEffort: options.reasoningEffort || "",
      sandbox: options.sandbox || "workspace-write",
      goalId: options.goalId || null,
      milestoneId: options.milestoneId || null,
      promptPreview: (options.prompt || "").replace(/\s+/g, " ").slice(0, 160),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pid: null,
      sessionId: options.sessionId || null,
      eventCount: 0,
      recentEvents: [],
      result: null,
      resultSummary: null,
      error: null,
      notifyOnComplete,
      callbackSent: false,
      callbackAt: null,
      child: null,
      abortController,
      waiters: [],
    };

    this.jobs.set(jobId, job);
    this._pruneOldJobs();
    this._persistAll();

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
      timeoutMs: options.timeoutMs ?? 1_800_000,
      signal: abortController.signal,
      onSpawn: (child) => {
        job.child = child;
        job.pid = child.pid || null;
        this._persistAll();
      },
      onProgress: ({ eventCount, summary, sessionId }) => {
        job.eventCount = eventCount;
        const gotNewSession = sessionId && sessionId !== job.sessionId;
        if (sessionId) job.sessionId = sessionId;
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
          this._persistAll();
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
        if (job.goalId && job.sessionId) {
          recordGoalExecution(job.goalId, {
            milestoneId: job.milestoneId,
            sessionId: job.sessionId,
            jobId: job.id,
            incrementIteration: false,
          });
        }
      })
      .catch((err) => {
        job.error = err.message || String(err);
        job.status = abortController.signal.aborted ? "cancelled" : "failed";
        job.finishedAt = new Date().toISOString();
      })
      .finally(() => {
        job.child = null;
        this._persistAll();
        const waiters = job.waiters.splice(0, job.waiters.length);
        for (const fn of waiters) fn();
      });

    job.promise = promise;
    return job;
  }

  async getStatus(jobId, waitSeconds = 0) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    if (job.status === "running" && waitSeconds > 0) {
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

    return job;
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return { found: false };
    if (job.status !== "running") {
      return { found: true, alreadyFinished: true, status: job.status };
    }
    job.notifyOnComplete = false; // don't trigger auto-callback on manual cancel
    job.abortController?.abort();
    if (job.child) {
      killProcessTree(job.child);
    }
    this._persistAll();
    return { found: true, cancelled: true };
  }

  listJobs() {
    return [...this.jobs.values()]
      .sort((a, b) =>
        String(b.startedAt || "").localeCompare(String(a.startedAt || ""))
      )
      .map((j) => ({
        id: j.id,
        mode: j.mode,
        status: j.status,
        sessionId: j.sessionId,
        goalId: j.goalId,
        milestoneId: j.milestoneId,
        cwd: j.cwd,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        eventCount: j.eventCount,
        promptPreview: j.promptPreview,
      }));
  }

  cancelAll() {
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        job.abortController?.abort();
        if (job.child) {
          killProcessTree(job.child);
        }
      }
    }
    this._persistAll();
  }

  formatJobStatus(job) {
    if (job.result) {
      const goalLine = job.goalId
        ? `Goal: ${job.goalId}${job.milestoneId ? ` / ${job.milestoneId}` : ""}\n`
        : "";
      return `Job ID: ${job.id}\n${goalLine}${formatCodexResult(job.result)}`;
    }

    const lines = [
      `Job ID: ${job.id}`,
      `Status: ${job.status}`,
      `Mode: ${job.mode}`,
      `Session ID: ${job.sessionId || "(pending)"}`,
      `Working Dir: ${job.cwd}`,
      `Started At: ${job.startedAt}`,
      `Events Seen: ${job.eventCount}`,
    ];

    if (job.goalId) {
      lines.push(
        `Goal: ${job.goalId}${job.milestoneId ? ` / ${job.milestoneId}` : ""}`
      );
    }
    if (job.finishedAt) {
      lines.push(`Finished At: ${job.finishedAt}`);
    }
    if (job.error) {
      lines.push(`\n## Error\n\n${job.error}`);
    }
    if (job.status === "interrupted" && job.sessionId) {
      lines.push(
        `\nTip: Resume this session cleanly with \`codex_resume(session_id="${job.sessionId}", prompt="...")\` or \`codex_start(session_id="${job.sessionId}", ...)\`.`
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

  _pruneOldJobs() {
    const finished = [...this.jobs.values()].filter(
      (j) => j.status !== "running"
    );
    if (finished.length <= MAX_STORED_JOBS) return;
    finished.sort((a, b) =>
      String(a.finishedAt || "").localeCompare(String(b.finishedAt || ""))
    );
    const toRemove = finished.length - MAX_STORED_JOBS;
    for (let i = 0; i < toRemove; i += 1) {
      this.jobs.delete(finished[i].id);
    }
  }
}
