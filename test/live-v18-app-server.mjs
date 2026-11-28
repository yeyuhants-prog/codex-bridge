import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { getCodexVersion, resolveCodexBinary } from "../server/codex-runner.js";
import { JobManager, readPersistedJobs } from "../server/job-manager.js";
import { getSessionLockPath, isPidAlive, normalizeSessionId } from "../server/session-lock.js";
import { getDataDir, saveSettings } from "../server/settings-store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-live-v18-"));
const cwd = path.join(root, "workspace");
process.env.CODEX_BRIDGE_DATA_DIR = path.join(root, "data");
const model = "gpt-6.2-astra";
const marker = "STEER_LIVE_OK_18";
const options = { cwd, model, executionEngine: "app_server", reasoningEffort: "medium",
  transport: "websocket", sandbox: "read-only", notifyOnComplete: false };
let manager;

function diagnostic(job) {
  return [job.status, job.error, ...(job.result?.errors || []), ...(job.result?.warnings || []).slice(-2)].filter(Boolean).join(" | ");
}

async function until(job, ready) {
  const deadline = Date.now() + 90000;
  while (!ready()) {
    assert.equal(job.status, "running", diagnostic(job));
    assert.ok(Date.now() < deadline, "Timed out waiting for app-server readiness");
    await delay(10);
  }
}

async function complete(job) {
  await job.promise;
  assert.equal(job.status, "completed", diagnostic(job));
  assert.equal(job.engine, "app_server");
  assert.equal(job.effectiveProvider, "openai");
  assert.equal(job.model, model);
  assert.equal(job.sandbox, "read-only");
  assert.equal(normalizeSessionId(job.sessionId), job.sessionId);
  assert.ok(job.usage?.input_tokens > 0 && job.usage?.output_tokens > 0, "Missing live token counts");
  return job.result.lastMessage.trim();
}

async function budgetTurn(tokenBudget, prompt, shouldComplete) {
  const { job } = manager.startJob({ ...options, tokenBudget, prompt });
  assert.equal(job.nativeGoalSync, false);
  // Observe the wire independently of the runner's active-turn filter.
  await until(job, () => job.child);
  const wire = createInterface({ input: job.child.stdout });
  const started = [], ended = [];
  let wireError;
  wire.on("line", line => {
    try {
      const { method, params } = JSON.parse(line);
      if (method === "turn/started") started.push([params.threadId, params.turn.id]);
      if (method === "turn/completed") ended.push([params.threadId, params.turn.id]);
    } catch (err) { wireError = err; }
  });
  try {
    if (shouldComplete) {
      assert.equal(await complete(job), "BOUNDARY_OK");
      assert.ok(job.usage.total_tokens > 0 && job.usage.total_tokens < tokenBudget);
    } else {
      await job.promise;
      assert.equal(job.status, "failed", diagnostic(job));
      assert.ok(job.result.errors.includes("Turn token budget reached."), diagnostic(job));
      assert.ok(job.usage.total_tokens >= tokenBudget);
    }
    if (wireError) throw wireError;
    assert.equal(started.length, 1, "Expected exactly one native turn");
    assert.equal(started[0][0], job.sessionId);
    assert.ok(started[0][1]);
    assert.deepEqual(ended, started);
    assert.equal(isPidAlive(job.pid), false);
    console.log(JSON.stringify({ tokenBudget, used: job.usage.total_tokens, turns: started.length, status: job.status }));
    return job.sessionId;
  } finally { wire.close(); }
}

try {
  assert.equal(getDataDir(), path.join(root, "data"));
  const binary = resolveCodexBinary();
  assert.ok(binary, "Codex CLI is required");
  const version = getCodexVersion(binary.path);
  assert.match(version, /^codex-cli \d/);
  console.log(version, model, "websocket", "read-only");
  fs.mkdirSync(cwd);
  for (const file of ["plugin.json", "package.json"]) {
    fs.copyFileSync(new URL("../" + file, import.meta.url), path.join(cwd, file));
  }
  saveSettings({ model, taskTimeoutSeconds: 180 });
  manager = new JobManager();
  const { job } = manager.startJob({ ...options,
    prompt: "请先读取当前目录的 plugin.json 和 package.json，比较两处版本号，再简短说明结果。只读检查。" });
  await until(job, () => job.activeTurnId && job.canSteer === true);
  const expectedTurnId = job.activeTurnId;
  const ack = await manager.steerJob({ jobId: job.id, expectedTurnId,
    message: "请务必在最终回复末尾额外附带校验口令：" + marker });
  assert.equal(ack.status, "accepted", JSON.stringify(ack));
  assert.equal(ack.turnId, expectedTurnId);
  const answer = await complete(job);
  assert.match(answer, /\b1\.8\.0\b/);
  assert.ok(answer.includes(marker), answer);
  assert.ok(job.steerCount >= 1);
  console.log(JSON.stringify({ steer: ack.status, turnId: ack.turnId, sessionId: job.sessionId,
    steerCount: job.steerCount, usage: job.usage, answer }));

  const { job: resumed } = manager.resumeFromJob(job.id, { prompt: "请只回复上一轮你附带的校验口令，无需执行命令。" });
  const recalled = await complete(resumed);
  assert.equal(resumed.parentJobId, job.id);
  assert.equal(resumed.sessionId, job.sessionId);
  assert.equal(resumed.effectiveProvider, job.effectiveProvider);
  assert.equal(recalled, marker);
  console.log(JSON.stringify({ resume: resumed.status, sessionId: resumed.sessionId,
    provider: resumed.effectiveProvider, usage: resumed.usage, recalled }));

  const normal = await budgetTurn(1000000, "只回复 BOUNDARY_OK，无需执行命令。", true);
  const capped = await budgetTurn(1, "请读取 plugin.json，说明版本号。", false);
  assert.equal(new Set([job.sessionId, normal, capped]).size, 3);
  assert.equal(readPersistedJobs().length, 4);
} finally {
  try {
    if (manager) {
      await manager.cancelAll();
      for (const job of readPersistedJobs()) {
        assert.ok(!job.pid || !isPidAlive(job.pid), "Live app-server PID " + job.pid);
        if (job.sessionId) assert.ok(!fs.existsSync(getSessionLockPath(job.sessionId)), "Unreleased session lock");
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8 });
    assert.ok(!fs.existsSync(root));
  }
}
console.log("Live v1.8 acceptance passed. Temporary workspace and bridge data removed.");
