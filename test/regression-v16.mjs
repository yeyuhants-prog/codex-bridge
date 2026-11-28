import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { McpClient } from "./acceptance-v14.mjs";
import { buildCodexArgs, runCodex } from "../server/codex-runner.js";
import { archiveCompletedGoals, archiveGoal, createGoal, getGoal, listGoals, setActiveGoal, updateGoalStatus } from "../server/goal-store.js";
import { archiveExecutions, JobManager, readPersistedJobs } from "../server/job-manager.js";
import { appendHistory, getGoalsPath, getHistoryPath, getJobsPath, getSettingsPath, loadHistory, loadSettings, saveSettings, writeJsonAtomic } from "../server/settings-store.js";
import { validateBooleans } from "../server/validation.js";
import { taskRows } from "../sidecars/codex_panel/view-model.mjs";

let dir, original;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-v16-"));
  const environment = { CODEX_BRIDGE_DATA_DIR: dir, CODEX_HOME: dir, CODEX_BIN: path.join(dir, "fixture.mjs") };
  original = Object.fromEntries(Object.keys(environment).map(k => [k, process.env[k]]));
  Object.assign(process.env, environment);
});
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("settings migrate on read, accept the full timeout range and reject invalid writes", () => {
  const invalid = { modelRouting: "unknown", transport: null, taskTimeoutSeconds: 59, disableDesktopNotify: "true" };
  writeJsonAtomic(getSettingsPath(), invalid);
  const defaults = loadSettings();
  assert.deepEqual([defaults.modelRouting, defaults.transport, defaults.taskTimeoutSeconds, defaults.disableDesktopNotify],
    ["flexible", "default", 7200, true]);
  assert.deepEqual(JSON.parse(fs.readFileSync(getSettingsPath())), invalid);
  for (const value of [0, 60, 61, 1800, 3600, 7200, 14400]) assert.equal(saveSettings({ taskTimeoutSeconds: value }).taskTimeoutSeconds, value);
  for (const value of [-1, 1, 59, 60.5, 14401, null, "7200", NaN]) {
    assert.throws(() => saveSettings({ taskTimeoutSeconds: value }), { status: 400, message: "Invalid taskTimeoutSeconds." });
  }
  for (const [key, value] of Object.entries(invalid)) assert.throws(() => saveSettings({ [key]: value }), { status: 400 });
  for (const key of ["archived", "completedOnly", "finishedOnly", "force_model", "disableDesktopNotify"]) {
    assert.throws(() => validateBooleans({ [key]: "false" }), { status: 400 });
  }
});

test("run, resume and review pass the configured transport and respect explicit notify hooks", () => {
  for (const mode of ["run", "resume", "review"]) {
    const args = opts => buildCodexArgs(mode, { sessionId: randomUUID(), ...opts }).args;
    assert.ok(args({}).includes("notify=[]"));
    assert.ok(!args({ transport: "default" }).some(arg => arg.startsWith("model_provider=")));
    for (const [transport, provider] of [["websocket", "openai"], ["http", "openai_http"]]) {
      const argv = args({ transport, config: ['notify = ["custom"]'] });
      const index = argv.indexOf('model_provider="' + provider + '"');
      assert.equal(argv[index - 1], "-c");
      assert.deepEqual(argv.filter(x => x.startsWith("notify")), ['notify = ["custom"]']);
    }
    assert.ok(!args({ disableDesktopNotify: false }).includes("notify=[]"));
  }
});

test("MCP routing, force overrides, timeout defaults and goal archives work through tools/call", async () => {
  const sid = randomUUID();
  fs.writeFileSync(process.env.CODEX_BIN, `
    if (process.argv.includes("--version")) { console.log("fixture"); process.exit(); }
    if (process.argv.includes("--help")) { console.log("exec review"); process.exit(); }
    for await (const chunk of process.stdin) {}
    console.log(JSON.stringify({ type: "thread.started", thread_id: "${sid}" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(process.argv.slice(2)) } }));
    console.log(JSON.stringify({ type: "turn.completed" }));
  `);
  const client = new McpClient({ ANTIGRAVITY_SOURCE_METADATA: "", ANTIGRAVITY_CONVERSATION_ID: "", ANTIGRAVITY_PROJECT_ID: "" });
  const call = async (name, args) => {
    const result = await client.callTool(name, args);
    assert.notEqual(result.isError, true, result.content[0].text);
    return result.content[0].text;
  };
  try {
    await client.init();
    const tools = (await client.request("tools/list")).tools;
    const names = ["codex_run", "codex_resume", "codex_review", "codex_start"];
    for (const name of names) assert.equal(tools.find(t => t.name === name).inputSchema.properties.force_model.type, "boolean");
    await call("codex_config", { model: "panel", model_routing: "pinned", task_timeout_seconds: 0, transport: "http" });
    for (const tool of ["codex_config", "codex_info"]) {
      const info = await call(tool, {});
      assert.match(info, /Model Routing: pinned/);
      assert.match(info, /Task Timeout: unlimited/);
      assert.match(info, /Transport: http/);
    }
    const base = { cwd: dir, prompt: "inspect" };
    const emptyModel = await client.callTool("codex_run", { ...base, model: "" });
    assert.match(emptyModel.content[0].text, /pinned to panel/);
    for (const name of names) {
      const args = name === "codex_resume" ? { ...base, session_id: sid } : base;
      const reject = await client.callTool(name, { ...args, model: "named" });
      assert.equal(reject.isError, true);
      assert.match(reject.content[0].text, /pinned to panel.*force_model=true.*flexible/);
      for (const timeout_seconds of [-1, null, "0"]) {
        const bad = await client.callTool(name, { ...args, timeout_seconds });
        assert.match(bad.content[0].text, /Invalid timeout_seconds/);
      }
      if (name !== "codex_start") {
        assert.match(await call(name, args), /"-m","panel"/);
        assert.match(await call(name, { ...args, timeout_seconds: 0, model: "named", force_model: true }), /"-m","named"/);
      }
    }
    const launch = async args => {
      const result = await call("codex_start", { ...base, ...args });
      const [, id] = result.match(/Job ID: (codex_\w+)/);
      const status = await call("codex_status", { job_id: id, wait_seconds: 10 });
      return { job: readPersistedJobs().find(j => j.id === id), status };
    };
    const first = await launch({ model: "named", force_model: true });
    assert.equal(first.job.timeoutSeconds, 0);
    assert.match(first.status, /Task Timeout: unlimited/);
    assert.match(first.job.resultSummary.lastMessage, /"-m","named"/);
    await call("codex_config", { task_timeout_seconds: 61 });
    const resumed = await launch({ resume_job_id: first.job.id });
    assert.equal(resumed.job.model, "panel");
    assert.equal(resumed.job.timeoutSeconds, 61);
    assert.match(resumed.status, /Task Timeout: 61s/);
    await call("codex_config", { model_routing: "flexible" });
    const flexible = await launch({ resume_job_id: first.job.id, model: "task-model", timeout_seconds: 0 });
    assert.equal(flexible.job.timeoutSeconds, 0);
    assert.match(flexible.job.resultSummary.lastMessage, /"-m","task-model"/);
    assert.equal((await launch({ timeout_seconds: 3.5 })).job.timeoutSeconds, 3.5);

    const goal = createGoal({ title: "MCP archive" });
    const change = action => call("codex_goal", { action, goal_id: goal.id });
    await change("archive");
    assert.match(await change("list"), /Archived goals[\s\S]*MCP archive/);
    await change("unarchive");
    assert.match(await change("list"), /Open goals[\s\S]*MCP archive[\s\S]*Archived goals/);
    updateGoalStatus(goal.id, "failed");
    assert.match(await change("archive_completed"), /Archived 1/);
  } finally { client.close(); }
});

test("zero and null disable the run timer, undefined uses ten minutes, and natural exit warnings survive", async t => {
  fs.writeFileSync(process.env.CODEX_BIN, 'for await (const chunk of process.stdin) {}\nconsole.log(\'{"type":"turn.completed"}\'); process.exitCode = 2;');
  const scheduled = [];
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) => {
    scheduled.push(delay);
    return timer(fn, delay, ...args);
  });
  for (const timeoutMs of [0, null, undefined]) {
    scheduled.length = 0;
    const result = await runCodex({ mode: "run", cwd: dir, timeoutMs, postTurnGraceMs: 0 });
    assert.equal(result.ok, true);
    assert.match(result.warnings.join(" "), /exited with code 2/);
    assert.deepEqual(scheduled, timeoutMs === undefined ? [600000] : []);
  }
});

test("tail cleanup waits for the latest completed turn and leaves real failures visible", async () => {
  const events = `const event = type => console.log(JSON.stringify({ type }));
    for await (const chunk of process.stdin) {}
    event("turn.completed");`;
  const run = async source => {
    fs.writeFileSync(process.env.CODEX_BIN, events + source);
    return runCodex({ mode: "run", cwd: dir, timeoutMs: 3000, postTurnGraceMs: 90 });
  };
  const tail = await run('setInterval(() => {}, 30000)');
  assert.equal(tail.ok, true);
  assert.deepEqual(tail.warnings, []);
  const next = await run('event("turn.started"); setTimeout(() => { event("turn.completed"); }, 250);');
  assert.equal(next.ok, true);
  assert.equal(next.eventCount, 3);
  const failed = await run('event("turn.failed"); setInterval(() => {}, 30000);');
  assert.equal(failed.ok, false);
  assert.ok(failed.errors.length);
});

test("job progress persists before completion and direct starts inherit the panel timeout", async () => {
  saveSettings({ taskTimeoutSeconds: 0 });
  fs.writeFileSync(process.env.CODEX_BIN, `
    for await (const chunk of process.stdin) {}
    console.log('{"type":"turn.started"}');
    setTimeout(() => console.log('{"type":"turn.completed"}'), 600);
  `);
  const manager = new JobManager();
  const { job } = manager.startJob({ cwd: dir, prompt: "progress", notifyOnComplete: false });
  assert.equal(job.lastEventAt, job.startedAt);
  try {
    const deadline = Date.now() + 5000;
    let live;
    do {
      await new Promise(resolve => setTimeout(resolve, 15));
      [live] = readPersistedJobs();
    } while (!live.eventCount && Date.now() < deadline);
    assert.equal(live.status, "running");
    assert.equal(live.eventCount, 1);
    assert.ok(Date.parse(live.lastEventAt) >= Date.parse(live.startedAt));
    assert.equal(live.lastEventAt, live.recentEvents[0].at);
  } finally { await job.promise; }
  const [done] = readPersistedJobs();
  assert.equal(done.timeoutSeconds, 0);
  assert.equal(done.eventCount, 2);
  assert.equal(done.lastEventAt, done.recentEvents.at(-1).at);
});

test("goal archives migrate legacy goals and reassign the active goal only to eligible goals", () => {
  const paused = createGoal({ title: "Paused" });
  updateGoalStatus(paused.id, "paused");
  const complete = createGoal({ title: "Completed" });
  updateGoalStatus(complete.id, "completed");
  const failed = createGoal({ title: "Failed" });
  updateGoalStatus(failed.id, "failed");
  const legacy = listGoals();
  for (const g of legacy.goals) { delete g.archived; delete g.archivedAt; }
  writeJsonAtomic(getGoalsPath(), legacy);
  assert.equal(getGoal().archived, false);
  assert.equal(archiveCompletedGoals(), 2);
  assert.equal(getGoal().id, paused.id);
  assert.ok(getGoal(failed.id).archivedAt);
  assert.equal(archiveCompletedGoals(), 0);
  assert.throws(() => setActiveGoal(complete.id), { status: 409 });
  archiveGoal(paused.id);
  assert.equal(getGoal(), null);
  assert.equal(archiveGoal(paused.id, false).archivedAt, null);
  assert.equal(getGoal().id, paused.id);
});

test("archive selectors cover legacy matches, sync turns, retained history and conversation scope", () => {
  const old = { id: "old", status: "completed", sessionId: "same", conversationId: "A" };
  writeJsonAtomic(getJobsPath(), [old, { id: "foreign", status: "failed", conversationId: "B" },
    ...["running", "running_detached", "stopping"].map(status => ({ id: status, status, conversationId: "A" }))]);
  const at = "2026-01-01T00:00:00Z";
  writeJsonAtomic(getHistoryPath(), [
    { sessionId: "same", conversationId: "A", at },
    { sessionId: "same", executionKind: "sync", conversationId: "A", at, prompt: "separate turn" },
    { jobId: "pruned", conversationId: "B", status: "failed" },
  ]);
  const rows = () => taskRows(readPersistedJobs(), loadHistory());
  const syncKey = rows().find(row => row.kind === "sync").key;
  for (const id of ["running", "running_detached", "stopping"]) assert.throws(() => archiveExecutions({ jobId: id }), { status: 409 });
  assert.throws(() => archiveExecutions({ sessionId: "same", at }), { status: 409 });
  archiveExecutions({ finishedOnly: true, conversationId: "A" });
  assert.deepEqual(rows().filter(row => row.archived).map(row => row.key).sort(), ["old", syncKey].sort());
  assert.ok(loadHistory()[0].archivedAt);
  archiveExecutions({ jobId: "old", archived: false });
  assert.equal(loadHistory()[0].archivedAt, null);
  assert.equal(readPersistedJobs()[0].archivedAt, null);
  archiveExecutions({ historyKey: syncKey, archived: false });
  archiveExecutions({ jobId: "pruned" });
  const historyOnly = rows().find(row => row.jobId === "pruned");
  assert.equal(historyOnly.archived, true);
  archiveExecutions({ historyKey: historyOnly.key, archived: false });
  appendHistory({ sessionId: "unique", at, status: "completed" });
  archiveExecutions({ sessionId: "unique", at });
  assert.equal(loadHistory()[0].archived, true);
  for (let i = 0; i < 35; i++) appendHistory({ prompt: "new " + i });
  assert.equal(loadHistory().filter(r => !r.archived).length, 30);
  assert.ok(loadHistory().some(r => r.sessionId === "unique" && r.archived));
});

test("a stale owner persist preserves archived fields, callback state and the recent-job budget", () => {
  const jobs = Array.from({ length: 51 }, (_, i) => ({ id: String(i), status: "completed", callbackSent: true }));
  writeJsonAtomic(getJobsPath(), jobs);
  const manager = new JobManager();
  const stale = manager.jobs.get("50");
  archiveExecutions({ jobId: stale.id });
  manager._persistJob(stale);
  const saved = readPersistedJobs();
  assert.equal(saved.length, 51);
  assert.equal(saved.find(j => j.id === stale.id).callbackSent, true);
  assert.ok(saved.find(j => j.id === stale.id).archivedAt);
  archiveExecutions({ jobId: stale.id, archived: false });
  assert.equal(readPersistedJobs().find(j => j.id === stale.id).archived, false);
});
