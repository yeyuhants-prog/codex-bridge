import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runAppServerTurn } from "../server/app-server-runner.js";
import { createGoal, getGoal } from "../server/goal-store.js";
import { JobManager, readPersistedJobs } from "../server/job-manager.js";
import { resolveResume, writableRoots } from "../server/run-policy.js";
import { getSessionLockPath, inspectSessionLock, acquireSessionLock, releaseSessionLock, isPidAlive } from "../server/session-lock.js";
import { appendHistory, getSettingsPath, loadSettings, saveSettings } from "../server/settings-store.js";
import { McpClient } from "./acceptance-v14.mjs";

let dir, sid, env;
const setup = (scenario, fields, cwd = dir) => fs.writeFileSync(path.join(cwd, "scenario.json"), JSON.stringify({ sid, scenario, ...fields }));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-m2-"));
  sid = randomUUID();
  const overrides = { CODEX_BRIDGE_DATA_DIR: dir, CODEX_HOME: dir,
    CODEX_BIN: fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url)) };
  env = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  setup("");
});
afterEach(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
const run = opts => runAppServerTurn({ cwd: dir, prompt: "test", timeoutMs: 10000, ...opts });
const log = (cwd = dir) => fs.readFileSync(path.join(cwd, "transcript.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const record = id => readPersistedJobs().find(j => j.id === id);

test("settings validate on write, recover per field, and default to exec", () => {
  assert.equal(loadSettings().executionEngine, "exec");
  for (const patch of [{ tokenBudget: "1" }, { tokenBudget: null }, { tokenBudget: -1 }, { tokenBudget: 1.1 },
    { tokenBudget: 100000001 }, { executionEngine: null }, { executionEngine: "app" }, { nativeGoalSync: 1 }]) {
    assert.throws(() => saveSettings(patch), { status: 400 });
  }
  for (const tokenBudget of [0, 1, 100000000]) {
    const settings = saveSettings({ executionEngine: "app_server", nativeGoalSync: true, tokenBudget });
    assert.equal(settings.tokenBudget, tokenBudget);
    assert.equal(loadSettings().nativeGoalSync, true);
  }
  fs.writeFileSync(getSettingsPath(), '{"nativeGoalSync":"false","tokenBudget":false,"executionEngine":1,"roleMode":"flexible"}');
  const prefs = loadSettings();
  assert.deepEqual([prefs.executionEngine, prefs.nativeGoalSync, prefs.tokenBudget, prefs.roleMode], ["exec", false, 0, "flexible"]);
});

test("bidirectional NDJSON, matching numeric IDs, denials and approved turn parameters", async () => {
  setup("approvals");
  fs.writeFileSync(path.join(dir, "schema.json"), '{"type":"object"}');
  fs.writeFileSync(path.join(dir, "input.png"), "image fixture");
  fs.mkdirSync(path.join(dir, "extra"));
  fs.mkdirSync(path.join(dir, ".git"));
  let locked = false, accepts = 0;
  const result = await run({ images: ["input.png"], config: ['model_verbosity="low"'], outputSchema: "schema.json", skipGitRepoCheck: false,
    addDirs: ["extra"], transport: "http", model: "model", reasoningEffort: "high", ephemeral: true,
    async onThreadReady({ sessionId, effectiveProvider, child }) {
      await delay(45);
      assert.equal(sessionId, sid); assert.equal(effectiveProvider, "openai_http"); assert.ok(child.pid);
      assert.ok(!log().some(m => m.method === "turn/start"));
      locked = true;
    }, onTurnAccepted({ turnId, sessionId }) {
      assert.ok(locked); assert.equal(sessionId, sid); assert.equal(turnId, "test-turn"); accepts++;
    } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.stderr, "independent stderr");
  assert.equal(result.warnings.length, 4);
  assert.equal(accepts, 1);
  const rows = log();
  assert.deepEqual(rows[0].args, ["app-server", "--stdio", "-c", 'model_verbosity="low"', "-c", 'model_provider="openai_http"', "-c", "notify=[]"]);
  assert.deepEqual(rows.filter(m => m.method).map(m => m.method), ["initialize", "initialized", "thread/start", "turn/start"]);
  assert.equal(rows.find(m => m.method === "initialized").id, undefined);
  const thread = rows.find(m => m.method === "thread/start").params;
  assert.deepEqual([thread.modelProvider, thread.sandbox, thread.ephemeral, thread.approvalPolicy], ["openai_http", "workspace-write", true, "never"]);
  const turn = rows.at(-1).params;
  assert.deepEqual(turn.sandboxPolicy.writableRoots, writableRoots(dir, ["extra"]));
  assert.equal(turn.sandboxPolicy.type, "workspaceWrite");
  assert.deepEqual(turn.input, [{ type: "text", text: "test", text_elements: [] }, { type: "localImage", path: path.join(dir, "input.png") }]);
  assert.deepEqual([turn.threadId, turn.model, turn.effort, turn.approvalPolicy, turn.outputSchema], [sid, "model", "high", "never", { type: "object" }]);
});

test("preflight rejects unsupported capabilities, invalid inputs and controlled config before spawn", async () => {
  fs.writeFileSync(path.join(dir, "invalid"), "[]");
  for (const opts of [{ worktree: true }, { profile: "p" }, { skipGitRepoCheck: false }, { images: ["missing"] }, { images: ["."] },
    { outputSchema: "invalid" }, { outputSchema: "missing" }, ...["sandbox_mode", "approval_policy", "model_reasoning_effort", "model",
      "model_provider", "notify", "sandbox_workspace_write.network_access", '"model"', "mcp_servers"].map(k => ({ config: [k + "=true"] }))]) {
    await assert.rejects(run(opts), { status: 400 });
  }
  assert.throws(() => new JobManager().startJob({ executionEngine: "app_server", cwd: dir, prompt: "x", profile: "p" }), { status: 400 });
  assert.ok(!fs.existsSync(path.join(dir, "transcript.ndjson")));
  fs.mkdirSync(path.join(dir, ".git"));
  const nested = fs.mkdtempSync(path.join(dir, "nested"));
  setup("", {}, nested);
  assert.equal((await run({ cwd: nested, skipGitRepoCheck: false, transport: "websocket", disableDesktopNotify: false })).ok, true);
  assert.deepEqual(log(nested)[0].args, ["app-server", "--stdio", "-c", 'model_provider="openai"']);
});

test("accepted turn survives early/coalesced notifications, failed and interrupted are terminal failures", async () => {
  for (const scenario of ["early", "early-native", "failed", "interrupted"]) {
    setup(scenario);
    const ids = [];
    const result = await run({ nativeGoalSync: scenario === "early-native", onTurnAccepted: ({ turnId }) => ids.push(turnId) });
    assert.deepEqual(ids, ["test-turn"]);
    assert.equal(result.ok, scenario.startsWith("early"));
    assert.equal(result.cancelled, scenario === "interrupted");
    if (scenario.startsWith("early")) assert.deepEqual(result.messages, ["早到"]);
    else assert.match(result.errors.join(), /failed deliberately|interrupted/);
  }
});

test("manual input aborts without fabricating answers even with full access", async () => {
  setup("manual");
  const result = await run({ sandbox: "danger-full-access" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(), /human decision/);
  assert.ok(log().some(m => m.id === 880 && m.error && !m.result));
  assert.equal(log().filter(m => m.method === "turn/interrupt").length, 1);
});

test("matching deltas keep the watchdog alive with throttled progress and immediate phase changes", async () => {
  setup("heartbeat");
  const progress = [];
  const result = await run({ stallPolicy: "always", reasoningEffort: "low", stallTimeoutMs: 240, onProgress(p) { progress.push({ ...p, at: Date.now() }); } });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.lastMessage, "final message");
  assert.ok(result.eventCount >= 50);
  const streamed = progress.filter(p => /delta$/i.test(p.event?.type));
  assert.ok(streamed.length >= 2 && streamed.length < 10);
  for (let i = 1; i < streamed.length; i++) assert.ok(streamed[i].at - streamed[i - 1].at >= 1499);
  assert.equal(streamed[0].event.delta, undefined);
  for (const phase of ["running_cmd", "running_tool", "waiting_api", "completed"]) assert.ok(progress.some(p => p.phase === phase));
  assert.equal(progress.filter(p => p.event?.type === "item/completed").length, 4);
  assert.ok(progress.every(p => p.activeTools <= 1 && p.activeCommands <= 1 && !p.silenceWarning));
});

test("protocol limits fail closed", async () => {
  for (const [scenario, pattern] of [["invalid-json", /JSON/i], ["overlong", /line limit/i], ["overflow", /Output limit/i]]) {
    setup(scenario);
    const result = await run();
    assert.equal(result.ok, false);
    assert.match(result.errors.join(), pattern);
  }
});

test("spawn and handshake failures refund reservations, session lease precedes turn and charging", async () => {
  saveSettings({ executionEngine: "app_server" });
  const manager = new JobManager();
  const goal = createGoal({ title: "test", cwd: dir });
  const callbackTarget = { conversationId: randomUUID(), projectId: randomUUID() };
  const dispatch = () => manager.startJob({ prompt: "test", cwd: dir, goalId: goal.id, callbackTarget }).job;
  for (const scenario of ["initialize", "thread/start"]) {
    setup(scenario);
    const job = dispatch();
    await job.promise;
    assert.equal(job.status, "failed");
    assert.ok(job.pid); assert.match(job.error, /failure/);
    assert.equal(getGoal(goal.id).iterationCount, 0);
    assert.deepEqual(getGoal(goal.id).pendingDispatches, []);
  }
  const lease = acquireSessionLock(sid, { jobId: "another-owner", cwd: dir });
  try {
    setup("hang");
    const conflict = dispatch();
    await conflict.promise;
    assert.match(conflict.error, /locked/);
    assert.ok(!log().some(m => m.method === "turn/start"));
    assert.equal(getGoal(goal.id).iterationCount, 0);
    assert.equal(inspectSessionLock(sid).lock.ownerToken, lease.ownerToken);
  } finally { releaseSessionLock(sid, lease.ownerToken); }
  setup("hang", { lockFile: getSessionLockPath(sid) });
  const job = dispatch();
  try {
    for (let i = 0; !job.activeTurnId && i < 200; i++) await delay(30);
    assert.equal(job.activeTurnId, "test-turn", job.error);
    const saved = record(job.id);
    assert.deepEqual([saved.canSteer, saved.engine, saved.effectiveProvider, saved.nativeGoal], [true, "app_server", "mock", null]);
    const owner = getGoal(goal.id);
    assert.deepEqual([owner.conversationId, owner.projectId], [callbackTarget.conversationId, callbackTarget.projectId]);
    assert.equal(job.control.getActiveTurnId(), saved.activeTurnId);
    assert.deepEqual(await job.control.sendSteer("clarify"), { turnId: "test-turn" });
    assert.equal(getGoal(goal.id).iterationCount, 1);
    const remote = new McpClient();
    try {
      await remote.init();
      assert.ok(!(await remote.callTool("codex_cancel", { job_id: job.id })).isError);
      assert.ok(log().some(m => m.method === "turn/interrupt"));
    } finally { remote.close(); }
  } finally { await manager.stopJob(job.id); await job.promise; }
  assert.equal(inspectSessionLock(sid).locked, false);
  assert.deepEqual([record(job.id).activeTurnId, record(job.id).canSteer], [null, false]);
  assert.equal(getGoal(goal.id).iterationCount, 1);
});

test("bare SID verifies canonical complete writable roots from jobs and history, including junctions", () => {
  const orig = path.join(dir, "orig"), extra = path.join(dir, "extra"), other = path.join(dir, "other"), alias = path.join(dir, "alias");
  for (const d of [orig, extra, other]) fs.mkdirSync(d);
  fs.symlinkSync(extra, alias, process.platform === "win32" ? "junction" : "dir");
  const baseline = { id: "parent", cwd: orig, addDirs: [alias], writableRoots: writableRoots(orig, [alias]),
    sessionId: sid, sandbox: "workspace-write", engine: "app_server", effectiveProvider: "custom" };
  const resolve = (opts, jobs = [baseline]) => resolveResume({ sessionId: sid, ...opts }, jobs);
  assert.equal(resolve({ cwd: extra, addDirs: [orig] }).executionEngine, "app_server");
  assert.deepEqual(resolve({ cwd: alias }).addDirs, [extra]);
  for (const opts of [{ cwd: other }, { addDirs: [other] }, { executionEngine: "exec" }, { modelProvider: "openai" }]) {
    assert.throws(() => resolve(opts), { status: 400 });
  }
  assert.equal(resolve({ cwd: other, allowSandboxEscalation: true }).cwd, other);
  assert.equal(resolve({ sandbox: "workspace-write" }, [{ ...baseline, sandbox: "danger-full-access", writableRoots: [] }]).cwd, orig);
  appendHistory(baseline);
  assert.throws(() => resolve({ cwd: other }, []), { status: 400 });
  fs.unlinkSync(alias);
  fs.symlinkSync(other, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolve({}, []), { status: 400 });
  assert.equal(resolve({ addDirs: [extra] }, []).modelProvider, "custom");
});

test("resume rejects changed permissions, mismatched UUID/provider and active native goals before turn/start", async () => {
  const resume = opts => run({ mode: "resume", sessionId: sid, ...opts });
  for (const [scenario, fields, pattern] of [
    ["mismatch", {}, /original model provider/i], ["native", {}, /active native goal/i],
    ["", { response: { thread: { id: randomUUID() } } }, /UUID/], ["", { response: { approvalPolicy: "on-request" } }, /approvalPolicy/],
    ["", { response: { cwd: path.dirname(dir) } }, /cwd/], ["", { policy: { type: "dangerFullAccess" } }, /sandbox/],
    ["", { policy: { type: "workspaceWrite", writableRoots: [path.dirname(dir)] } }, /writable roots/],
  ]) {
    setup(scenario, fields);
    await assert.rejects(resume(), pattern);
  }
  assert.ok(!log().some(m => m.method === "turn/start"));
  setup("native");
  const goals = [];
  const result = await resume({ nativeGoalSync: true, onNativeGoal: goal => goals.push(goal) });
  assert.equal(result.ok, true); assert.equal(goals[0].status, "active");
  const request = log().find(m => m.method === "thread/resume");
  assert.deepEqual([request.params.threadId, request.params.excludeTurns, request.params.approvalPolicy], [sid, true, "never"]);
});

test("cancel waits for the matching terminal or kills only the uncooperative process group", async () => {
  const otherDir = fs.mkdtempSync(path.join(dir, "other"));
  setup("hang", { sid: randomUUID() }, otherDir);
  const otherAbort = new AbortController();
  let otherReady;
  const ready = new Promise(resolve => { otherReady = resolve; });
  const other = run({ cwd: otherDir, signal: otherAbort.signal, onTurnAccepted: otherReady });
  try {
    await ready;
    for (const scenario of ["hang", "uncooperative"]) {
      setup(scenario);
      const abort = new AbortController();
      const result = await run({ signal: abort.signal, onTurnAccepted() { setTimeout(() => abort.abort(), 80); } });
      assert.equal(result.cancelled, true);
      const rows = log();
      assert.ok(rows.some(m => m.method === "turn/interrupt"));
      if (scenario === "hang") assert.equal(result.exitCode, 0);
      else {
        assert.ok(result.durationMs >= 1500);
        assert.equal(isPidAlive(rows.find(m => m.grandchild).grandchild), false);
      }
      assert.ok(isPidAlive(log(otherDir)[0].pid));
    }
  } finally { otherAbort.abort(); await other; }
});

test("L1 resumes with the original engine/provider, excludes ephemeral jobs and reports silence", async () => {
  setup("recover");
  const manager = new JobManager();
  const opts = { cwd: dir, prompt: "run", executionEngine: "app_server", reconnectStallMs: 150 };
  const job = manager.startJob(opts).job;
  await job.promise;
  assert.equal(job.stallKind, "reconnect");
  const healed = manager.jobs.get(job.autoHealedToJobId);
  await healed.promise;
  assert.equal(healed.status, "completed", healed.error);
  assert.equal(record(healed.id).engine, "app_server");
  assert.equal(log().find(m => m.method === "thread/resume").params.modelProvider, "mock");
  const temp = manager.startJob({ ...opts, ephemeral: true }).job;
  await temp.promise;
  assert.equal(temp.stallKind, "reconnect"); assert.equal(temp.autoHealedToJobId, null);
  setup("silence");
  const abort = new AbortController();
  let warned = 0;
  await run({ stallTimeoutMs: 150, signal: abort.signal, onProgress(p) { if (p.silenceWarning) { warned++; abort.abort(); } } });
  assert.ok(warned > 0);
});

test("per-turn token budget uses current usage on a resumed thread", async () => {
  setup("budget");
  const result = await run({ mode: "resume", sessionId: sid, tokenBudget: 5 });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(), /token budget/);
  assert.equal(result.usage.total_tokens, 6);
});

test("MCP config and info expose preferences, synchronous resume directs known app_server sessions to codex_start", async () => {
  const mcp = new McpClient();
  try {
    await mcp.init();
    const call = (name, args) => mcp.callTool(name, args);
    const saved = await call("codex_config", { execution_engine: "exec", native_goal_sync: false, token_budget: 42 });
    assert.ok(!saved.isError);
    assert.match((await call("codex_info", {})).content[0].text, /Background Engine: exec[\s\S]*Native Goal Sync: false[\s\S]*Token Budget: 42/);
    const started = await call("codex_start", { prompt: "test", cwd: dir, execution_engine: "app_server", token_budget: 1, native_goal_sync: true });
    const id = /Job ID: (\w+)/.exec(started.content[0].text)[1];
    await call("codex_status", { job_id: id, wait_seconds: 10 });
    assert.deepEqual([record(id).status, record(id).tokenBudget, record(id).nativeGoalSync], ["completed", 1, true]);
    for (const arg of [{ resume_job_id: id }, { session_id: sid }]) {
      const result = await call("codex_resume", { prompt: "continue", ...arg });
      assert.ok(result.isError); assert.ok(result.content[0].text.includes('codex_start(resume_job_id="' + id + '")'));
    }
    const conflict = await call("codex_start", { resume_job_id: id, execution_engine: "exec" });
    assert.ok(conflict.isError); assert.match(conflict.content[0].text, /engine/);
  } finally { mcp.close(); }
});
