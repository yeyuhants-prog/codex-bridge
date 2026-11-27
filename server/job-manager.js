import crypto from "node:crypto";
import { runCodex, formatCodexResult, killProcessTree } from "./codex-runner.js";

const MAX_FINISHED_JOBS = 50;

export class JobManager {
  constructor() {
    this.jobs = new Map();
  }

  startJob(options) {
    const jobId = `codex_${crypto.randomBytes(4).toString("hex")}`;
    const abortController = new AbortController();

    const job = {
      id: jobId,
      mode: options.mode || "run",
      status: "running",
      cwd: options.cwd || process.cwd(),
      promptPreview: (options.prompt || "").replace(/\s+/g, " ").slice(0, 140),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      sessionId: options.sessionId || null,
      eventCount: 0,
      recentEvents: [],
      result: null,
      error: null,
      child: null,
      abortController,
      waiters: [],
    };

    this.jobs.set(jobId, job);
    this._pruneOldJobs();

    const promise = runCodex({
      ...options,
      timeoutMs: options.timeoutMs ?? 1_800_000, // 30 min default for background jobs
      signal: abortController.signal,
      onSpawn: (child) => {
        job.child = child;
      },
      onProgress: ({ eventCount, summary, sessionId }) => {
        job.eventCount = eventCount;
        if (sessionId) job.sessionId = sessionId;
        job.recentEvents.push({
          at: new Date().toISOString(),
          summary,
        });
        if (job.recentEvents.length > 40) {
          job.recentEvents.shift();
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
      })
      .catch((err) => {
        job.error = err.message || String(err);
        job.status = abortController.signal.aborted ? "cancelled" : "failed";
        job.finishedAt = new Date().toISOString();
      })
      .finally(() => {
        job.child = null;
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
    job.abortController.abort();
    if (job.child) {
      killProcessTree(job.child);
    }
    return { found: true, cancelled: true };
  }

  listJobs() {
    return [...this.jobs.values()].map((j) => ({
      id: j.id,
      mode: j.mode,
      status: j.status,
      sessionId: j.sessionId,
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
        job.abortController.abort();
        if (job.child) {
          killProcessTree(job.child);
        }
      }
    }
  }

  formatJobStatus(job) {
    if (job.result) {
      return `Job ID: ${job.id}\n${formatCodexResult(job.result)}`;
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

    if (job.finishedAt) {
      lines.push(`Finished At: ${job.finishedAt}`);
    }
    if (job.error) {
      lines.push(`\n## Error\n\n${job.error}`);
    }
    if (job.recentEvents.length > 0) {
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
    if (finished.length <= MAX_FINISHED_JOBS) return;
    finished.sort((a, b) =>
      String(a.finishedAt || "").localeCompare(String(b.finishedAt || ""))
    );
    const toRemove = finished.length - MAX_FINISHED_JOBS;
    for (let i = 0; i < toRemove; i += 1) {
      this.jobs.delete(finished[i].id);
    }
  }
}
