import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpClient } from "./acceptance-v14.mjs";
import { runCodex } from "../server/codex-runner.js";
import { createGoal, getGoal } from "../server/goal-store.js";
import { JobManager, readPersistedJobs, claimPeriodicCheckIn, finishPeriodicCheckIn } from "../server/job-manager.js";
import { getJobsPath, getSettingsPath, loadSettings, saveSettings, writeJsonAtomic } from "../server/settings-store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let dir, original;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-v17-"));
  const env = { CODEX_BRIDGE_DATA_DIR: dir, CODEX_HOME: dir, CODEX_BIN: path.join(dir, "fixture.mjs") };
  original = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
});

afterEach(() => {
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("v1.7 settings validate watchdog, auto-heal, and periodic inspection bounds", () => {
  const defaults = loadSettings();
  assert.equal(defaults.autoHealEnabled, true);
  assert.equal(defaults.stallThresholdSeconds, 240);
  assert.equal(defaults.maxAutoHeals, 2);
  assert.equal(defaults.monitorIntervalSeconds, 300);

  for (const v of [0, 60, 240, 1800]) {
    assert.equal(saveSettings({ stallThresholdSeconds: v }).stallThresholdSeconds, v);
    assert.equal(saveSettings({ monitorIntervalSeconds: v }).monitorIntervalSeconds, v);
  }
  for (const v of [0, 1, 2, 5]) {
    assert.equal(saveSettings({ maxAutoHeals: v }).maxAutoHeals, v);
  }
  assert.equal(saveSettings({ autoHealEnabled: false }).autoHealEnabled, false);

  for (const bad of [-1, 59, 1801, 60.5, "240", null]) {
    assert.throws(() => saveSettings({ stallThresholdSeconds: bad }), { status: 400 });
    assert.throws(() => saveSettings({ monitorIntervalSeconds: bad }), { status: 400 });
  }
  for (const bad of [-1, 6, 1.5, "2", null]) {
    assert.throws(() => saveSettings({ maxAutoHeals: bad }), { status: 400 });
  }
  assert.throws(() => saveSettings({ autoHealEnabled: "true" }), { status: 400 });

  writeJsonAtomic(getSettingsPath(), { autoHealEnabled: "bad", stallThresholdSeconds: 12, maxAutoHeals: 99, monitorIntervalSeconds: -5 });
  const migrated = loadSettings();
  assert.equal(migrated.autoHealEnabled, true);
  assert.equal(migrated.stallThresholdSeconds, 240);
  assert.equal(migrated.maxAutoHeals, 2);
  assert.equal(migrated.monitorIntervalSeconds, 300);
});

test("L1 watchdog kills waiting_api silence and stuck reconnecting, but NEVER kills running_cmd", async () => {
  // 1) waiting_api silence triggers stall
  fs.writeFileSync(process.env.CODEX_BIN, `
    for await (const _ of process.stdin) {}
    console.log(JSON.stringify({ type: "turn.started" }));
    setInterval(() => {}, 30000);
  `);
  const apiStall = await runCodex({ mode: "run", cwd: dir, timeoutMs: 5000, stallTimeoutMs: 220, postTurnGraceMs: 0 });
  assert.equal(apiStall.ok, false);
  assert.equal(apiStall.stalled, true);
  assert.match(apiStall.stallReason, /Upstream API silent/);

  // 2) stuck reconnecting loop triggers stall via reconnectStallMs
  fs.writeFileSync(process.env.CODEX_BIN, `
    for await (const _ of process.stdin) {}
    console.log(JSON.stringify({ type: "turn.started" }));
    setInterval(() => console.log(JSON.stringify({ type: "error", message: "Reconnecting... 1/5 (idle timeout waiting for SSE)" })), 40);
  `);
  const reconnStall = await runCodex({ mode: "run", cwd: dir, timeoutMs: 5000, stallTimeoutMs: 2000, reconnectStallMs: 180, postTurnGraceMs: 0 });
  assert.equal(reconnStall.ok, false);
  assert.equal(reconnStall.stalled, true);
  assert.match(reconnStall.stallReason, /Stuck reconnecting/);
  assert.ok(reconnStall.reconnectCount >= 1);

  // 3) running_cmd is EXEMPT even when command runs much longer than stallTimeoutMs
  fs.writeFileSync(process.env.CODEX_BIN, `
    for await (const _ of process.stdin) {}
    console.log(JSON.stringify({ type: "turn.started" }));
    console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "gradle assembleDebug" } }));
    setTimeout(() => {
      console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "gradle assembleDebug", exit_code: 0 } }));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "BUILD_OK" } }));
      console.log(JSON.stringify({ type: "turn.completed" }));
    }, 550);
  `);
  const phases = [];
  const cmdOk = await runCodex({
    mode: "run", cwd: dir, timeoutMs: 5000, stallTimeoutMs: 180, postTurnGraceMs: 0,
    onProgress: ({ phase }) => phases.push(phase),
  });
  assert.equal(cmdOk.ok, true);
  assert.equal(cmdOk.stalled, false);
  assert.equal(cmdOk.lastMessage, "BUILD_OK");
  assert.ok(phases.includes("running_cmd"));
});

test("JobManager auto-heals a stalled job cleanly via resume_job_id without burning goal budget, and stops at maxAutoHeals", async () => {
  const sid = randomUUID();
  const counterFile = path.join(dir, "attempt.txt");
  fs.writeFileSync(counterFile, "0");
  fs.writeFileSync(process.env.CODEX_BIN, `
    import fs from "node:fs";
    const count = Number(fs.readFileSync(${JSON.stringify(counterFile)}, "utf8")) + 1;
    fs.writeFileSync(${JSON.stringify(counterFile)}, String(count));
    let prompt = "";
    for await (const chunk of process.stdin) prompt += chunk;
    console.log(JSON.stringify({ type: "thread.started", thread_id: "${sid}" }));
    console.log(JSON.stringify({ type: "turn.started" }));
    if (count === 1) {
      // First attempt stalls waiting on API
      setInterval(() => {}, 30000);
    } else {
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "HEALED:" + prompt.slice(0, 26) } }));
      console.log(JSON.stringify({ type: "turn.completed" }));
    }
  `);

  saveSettings({ autoHealEnabled: true, stallThresholdSeconds: 60, maxAutoHeals: 2, progressionMode: "notify" });
  const goal = createGoal({ title: "Resilient goal", cwd: dir, milestones: [{ id: "m1", title: "Step 1" }] });
  const manager = new JobManager();
  const convId = "11111111-1111-4111-8111-111111111111";

  const { job: first } = manager.startJob({
    cwd: dir,
    prompt: "Run step 1",
    goalId: goal.id,
    milestoneId: "m1",
    callbackTarget: { conversationId: convId, projectId: "proj-1", source: "agent_conversation_id" },
    stallTimeoutMs: 650,
    postTurnGraceMs: 0,
  });

  await first.promise;
  // Wait for auto-healed child job to finish
  const deadline = Date.now() + 8000;
  let healedJob;
  while (Date.now() < deadline) {
    const persisted = readPersistedJobs();
    const p1 = persisted.find(j => j.id === first.id);
    if (p1?.autoHealedToJobId) {
      healedJob = persisted.find(j => j.id === p1.autoHealedToJobId);
      if (healedJob?.status === "completed") break;
    }
    await new Promise(r => setTimeout(r, 40));
  }

  const persisted = readPersistedJobs();
  const p1 = persisted.find(j => j.id === first.id);
  assert.equal(p1.status, "interrupted");
  assert.equal(p1.callbackStatus, "skipped");
  assert.ok(p1.autoHealedToJobId, "Parent job must record autoHealedToJobId");

  assert.ok(healedJob, "Auto-healed child job must exist");
  assert.equal(healedJob.status, "completed");
  assert.equal(healedJob.autoHealCount, 1);
  assert.equal(healedJob.autoHealFromJobId, first.id);
  assert.equal(healedJob.callbackStatus, "pending");
  assert.equal(healedJob.callbackTarget?.conversationId, convId);
  assert.match(healedJob.resultSummary.lastMessage, /HEALED:\[Auto-Heal Resume #1\/2\]/);
  // Auto-heal must NOT burn an extra goal iteration
  assert.equal(getGoal(goal.id).iterationCount, 1);

  // Now verify maxAutoHeals exhaustion does NOT loop and keeps callback pending
  saveSettings({ maxAutoHeals: 0 });
  fs.writeFileSync(counterFile, "0");
  const { job: exhausted } = manager.startJob({
    cwd: dir,
    prompt: "Stall with zero budget",
    callbackTarget: { conversationId: convId, projectId: "proj-1", source: "agent_conversation_id" },
    stallTimeoutMs: 650,
    postTurnGraceMs: 0,
  });
  await exhausted.promise;
  const pEx = readPersistedJobs().find(j => j.id === exhausted.id);
  assert.equal(pEx.status, "interrupted");
  assert.equal(pEx.autoHealedToJobId, null);
  assert.equal(pEx.callbackStatus, "pending");
});

test("MCP codex_config and codex_info expose v1.7 watchdog & periodic inspection settings", async () => {
  fs.writeFileSync(process.env.CODEX_BIN, 'if (process.argv.includes("--version")) console.log("fixture-1.7");');
  const client = new McpClient({ ANTIGRAVITY_SOURCE_METADATA: "", ANTIGRAVITY_CONVERSATION_ID: "", ANTIGRAVITY_PROJECT_ID: "" });
  try {
    await client.init();
    const res = await client.callTool("codex_config", {
      auto_heal_enabled: true,
      stall_threshold_seconds: 180,
      max_auto_heals: 3,
      monitor_interval_seconds: 240,
      list_models: false,
    });
    assert.notEqual(res.isError, true, res.content[0].text);
    assert.match(res.content[0].text, /Auto-Heal Watchdog: on \(stall=180s, maxHeals=3\)/);
    assert.match(res.content[0].text, /Periodic Inspection: 240s/);

    const info = await client.callTool("codex_info", {});
    assert.match(info.content[0].text, /v1\.7\.0/);
    assert.match(info.content[0].text, /Auto-Heal Watchdog: on \(stall=180s, maxHeals=3\)/);
    assert.match(info.content[0].text, /Periodic Inspection: 240s/);
  } finally {
    client.close();
  }
});

test("Sidecar periodic inspection delivers heartbeat strictly to locked conversation and enforces interval lease", async () => {
  const convA = "aaaa1111-1111-4111-8111-111111111111";
  const convB = "bbbb2222-2222-4222-8222-222222222222";
  const logFile = path.join(dir, "agentapi-log.jsonl");

  // Mock agentapi executable script (invoked via node agentapi ...)
  const mockApi = path.join(dir, "agentapi");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.writeFileSync(mockApi, `
    import fs from "node:fs";
    const [cmd, ...rest] = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ cmd, rest, projectId: process.env.ANTIGRAVITY_PROJECT_ID || "" }) + "\\n");
    if (cmd === "get-conversation-metadata") {
      console.log(JSON.stringify({ response: { conversationMetadata: { metadata: { projectId: "proj-A" } } } }));
    } else if (cmd === "send-message") {
      console.log(JSON.stringify({ ok: true }));
    } else {
      console.log("{}");
    }
  `);

  saveSettings({ progressionMode: "autonomous", monitorIntervalSeconds: 60, language: "zh" });
  const oldStart = new Date(Date.now() - 120_000).toISOString();
  writeJsonAtomic(getJobsPath(), [{
    id: "codex_periodic_1",
    mode: "run",
    status: "running",
    cwd: dir,
    model: "gpt-6.2-astra",
    reasoningEffort: "high",
    sandbox: "workspace-write",
    prompt: "Long running task",
    promptPreview: "Long running task",
    startedAt: oldStart,
    lastEventAt: oldStart,
    pid: process.pid,
    ownerPid: process.pid,
    phase: "waiting_api",
    eventCount: 5,
    recentEvents: [{ at: oldStart, summary: "Turn started" }],
    notifyOnComplete: true,
    callbackTarget: { conversationId: convA, projectId: "proj-A", source: "agent_conversation_id" },
    callbackStatus: "pending",
    callbackSent: false,
    checkInCount: 0,
    lastCheckInAt: null,
  }]);

  // Verify lease prevents premature check-in when interval hasn't elapsed
  assert.throws(() => claimPeriodicCheckIn("codex_periodic_1", 300), { status: 409 });

  const loader = path.join(os.homedir(), ".gemini", "antigravity", "lib", "node_modules", "sidecar_sdk", "register_loader.js");
  const srv = net.createServer();
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise(r => srv.close(r));

  const sidecar = spawn(
    process.execPath,
    [`--import=${pathToFileURL(loader).href}`, path.join(ROOT, "sidecars/codex_panel/main.mjs")],
    {
      cwd: dir,
      env: {
        ...process.env,
        CODEX_BRIDGE_DATA_DIR: dir,
        CODEX_HOME: dir,
        ANTIGRAVITY_AGENTAPI_EXE: process.execPath,
        ANTIGRAVITY_CONVERSATION_ID: convB, // Panel opened on Conv B must NOT steal Conv A's periodic check!
        ANTIGRAVITY_LS_ADDRESS: "localhost:5387",
        ANTIGRAVITY_CSRF_TOKEN: "test-csrf",
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
        ANTIGRAVITY_SIDECAR_UI_TOKEN: "v17-test-token",
        CODEX_PANEL_WATCHER_MS: "200",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );

  try {
    const deadline = Date.now() + 8000;
    let sent = [];
    while (Date.now() < deadline) {
      if (fs.existsSync(logFile)) {
        sent = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)).filter(e => e.cmd === "send-message");
        if (sent.length >= 1) break;
      }
      await new Promise(r => setTimeout(r, 80));
    }
    assert.equal(sent.length, 1, "Sidecar should deliver exactly 1 periodic check-in");
    assert.equal(sent[0].rest[0], convA, "Periodic check must route strictly to locked Conv A, never Conv B");
    assert.match(sent[0].rest[1], /\[Codex Bridge 定时检验 #1\]/);
    assert.match(sent[0].rest[1], /flash_lite/);

    const updated = readPersistedJobs().find(j => j.id === "codex_periodic_1");
    assert.equal(updated.checkInCount, 1);
    assert.ok(updated.lastCheckInAt);

    // Wait another 500ms to confirm it does NOT double-send inside the 60s interval
    await new Promise(r => setTimeout(r, 500));
    const sentAfter = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)).filter(e => e.cmd === "send-message");
    assert.equal(sentAfter.length, 1);
  } finally {
    try { sidecar.kill(); } catch {}
  }

  // Direct unit check on finishPeriodicCheckIn lease ownership
  const dummyClaim = claimPeriodicCheckIn("codex_periodic_1", 0);
  assert.throws(() => finishPeriodicCheckIn("codex_periodic_1", "wrong-token", { delivered: true }), { status: 409 });
  finishPeriodicCheckIn("codex_periodic_1", dummyClaim.checkInClaim, { delivered: true });
  assert.equal(readPersistedJobs().find(j => j.id === "codex_periodic_1").checkInCount, 2);
});
