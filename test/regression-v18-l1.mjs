import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { effortSilenceMultiplier, runCodex } from "../server/codex-runner.js";
import { createGoal, getGoal } from "../server/goal-store.js";
import { JobManager, claimCallback, readPersistedJobs } from "../server/job-manager.js";
import { getSettingsPath, loadSettings, readCodexTomlDefaults, saveSettings } from "../server/settings-store.js";

let dir, previousEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-l1-"));
  const env = { CODEX_BRIDGE_DATA_DIR: dir, CODEX_HOME: dir, CODEX_BIN: path.join(dir, "worker.mjs") };
  previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
});
afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(body) {
  fs.writeFileSync(process.env.CODEX_BIN, `
    import { setTimeout as wait } from "node:timers/promises";
    let prompt = "";
    for await (const chunk of process.stdin) prompt += chunk;
    const send = (type, fields = {}) => console.log(JSON.stringify({type, ...fields}));
    const item = (event, type, id) => send("item." + event, {item: {type, id}});
    const reconnect = () => send("error", {message: "Reconnecting..."});
    ${body}
  `);
}
const run = opts => runCodex({ mode: "run", cwd: dir, timeoutMs: 8000, ...opts });
const persisted = id => readPersistedJobs().find(job => job.id === id);

test("legacy silence settings migrate independently and model_provider is top-level only", () => {
  fs.writeFileSync(getSettingsPath(), '{"stallThresholdSeconds":240}');
  assert.equal(loadSettings().stallThresholdSeconds, 240);
  assert.equal(loadSettings().stallPolicy, "reconnect_only");
  assert.equal(loadSettings().reconnectStallSeconds, 150);
  for (const stallPolicy of ["off", "always", "reconnect_only"]) {
    saveSettings({ stallPolicy });
    assert.equal(loadSettings().stallPolicy, stallPolicy);
  }
  for (const reconnectStallSeconds of [0, 60, 1800]) {
    saveSettings({ reconnectStallSeconds, stallThresholdSeconds: 3600 });
    assert.equal(loadSettings().reconnectStallSeconds, reconnectStallSeconds);
    assert.equal(loadSettings().stallThresholdSeconds, 3600);
  }
  for (const bad of [59, 1801, 61.5, "60", null]) {
    assert.throws(() => saveSettings({ reconnectStallSeconds: bad }), { status: 400 });
  }
  assert.throws(() => saveSettings({ stallPolicy: "sometimes" }), { status: 400 });
  fs.writeFileSync(path.join(dir, "config.toml"), 'model_provider = "local"\n[profiles.other]\nmodel_provider = "nested"');
  assert.equal(readCodexTomlDefaults().modelProvider, "local");
});

test("default policy warns once per silent period, then clears on real progress", async () => {
  fixture(`
    item("started", "reasoning", "think");
    await wait(600);
    item("completed", "reasoning", "think");
    await wait(600);
    send("turn.completed");
  `);
  const progress = [];
  const result = await run({ stallTimeoutMs: 150, onProgress: p => progress.push(p) });
  assert.equal(result.ok, true);
  assert.equal(result.stalled, false);
  assert.equal(result.stallKind, null);
  assert.equal(result.silenceWarning, false);
  const events = progress.slice(progress.findIndex(p => p.event?.type === "item.started"));
  assert.deepEqual(events.map(p => [p.eventCount, p.silenceWarning]), [
    [1, false], [1, true], [2, false], [2, true], [3, false],
  ]);
  assert.equal(events[0].lastProgressAt, events[1].lastProgressAt);
  assert.ok(Date.parse(events[2].lastProgressAt) > Date.parse(events[1].lastProgressAt));
  assert.equal(result.lastProgressAt, events.at(-1).lastProgressAt);
});

test("zero silence threshold leaves reconnect watchdog and budget-free recovery enabled", async () => {
  const sid = randomUUID();
  fixture(`
    const handshake = () => { send("thread.started", {thread_id: "${sid}"}); send("turn.started"); };
    handshake();
    if (process.argv.includes("resume")) send("turn.completed");
    else setInterval(() => { reconnect(); handshake(); }, 45);
  `);
  saveSettings({ stallThresholdSeconds: 0 });
  const manager = new JobManager();
  const goal = createGoal({ title: "Reconnect", cwd: dir });
  const { job } = manager.startJob({ cwd: dir, prompt: "work", goalId: goal.id, reconnectStallMs: 240, timeoutMs: 6000 });
  await job.promise;
  assert.equal(job.result.stallKind, "reconnect");
  assert.ok(job.result.reconnectCount > 1);
  assert.equal(job.result.silenceWarning, false);
  const healed = manager.jobs.get(job.autoHealedToJobId);
  await healed.promise;
  assert.equal(persisted(healed.id).status, "completed");
  assert.equal(healed.autoHealCount, 1);
  assert.equal(healed.recoveryChainId, job.recoveryChainId);
  assert.equal(healed.zeroErrorSilenceKills, 0);
  assert.equal(getGoal(goal.id).iterationCount, 1);
});

test("active tools survive duplicates, out-of-order IDs, anonymous items and reconnects", async () => {
  fixture(`
    item("started", "web_search", "a");
    item("started", "mcp_tool_call", "b");
    item("started", "web_search", "a");
    item("completed", "web_search", "late");
    item("started", "web_search", "late");
    item("completed", "mcp_tool_call", "b");
    item("completed", "mcp_tool_call", "b");
    reconnect();
    await wait(550);
    item("started", "file_search");
    item("started", "file_search");
    item("completed", "web_search", "a");
    item("completed", "file_search");
    item("started", "command_execution", "cmd");
    item("completed", "command_execution", "cmd");
    await wait(550);
    item("completed", "file_search");
    item("started", "mcp_tool_call", "slow");
    reconnect();
    await wait(550);
    item("completed", "mcp_tool_call", "slow");
    send("turn.completed");
  `);
  for (const stallPolicy of ["always", "reconnect_only"]) {
    const progress = [];
    const result = await run({ stallPolicy, reasoningEffort: "low", stallTimeoutMs: 250,
      reconnectStallMs: 150, onProgress: p => progress.push(p) });
    assert.equal(result.ok, true);
    assert.equal(result.activeTools, 0);
    assert.ok(progress.every(p => !p.silenceWarning && !p.stallKind));
    assert.deepEqual(progress.map(p => p.activeTools), [1, 2, 2, 2, 2, 1, 1, 1, 2, 3, 2, 1, 1, 1, 0, 1, 1, 0, 0]);
    assert.equal(progress[7].phase, "running_tool");
    assert.equal(progress[7].reconnectCount, 1);
    assert.equal(progress[8].reconnectingSince, null);
    assert.equal(progress[12].phase, "running_cmd");
    assert.equal(progress[13].phase, "running_tool");
    assert.equal(progress[14].phase, "waiting_api");
  }
});

test("always scales the actual silence deadline with reasoning effort", async () => {
  for (const [effort, multiplier] of [["low", 1], ["medium", 1], ["high", 2], ["xhigh", 3],
    ["max", 5], ["ultra", 5], ["", 2], [undefined, 2], ["unknown", 2]]) {
    assert.equal(effortSilenceMultiplier(effort), multiplier);
  }
  fixture('send("turn.started"); setInterval(() => {}, 10000);');
  for (const [reasoningEffort, multiplier] of [["low", 1], ["high", 2], ["max", 5]]) {
    let started, killed;
    const effortOptions = reasoningEffort === "max" ? { config: ['model_reasoning_effort = "max"'], reasoningEffort: "low" } : { reasoningEffort };
    const result = await run({ stallPolicy: "always", stallTimeoutMs: 250, ...effortOptions, onProgress(p) {
      if (p.event?.type === "turn.started") started = Date.now();
      if (p.stallKind) killed = Date.now();
    } });
    assert.equal(result.stallKind, "zero_error_silence");
    assert.equal(result.stalled, true);
    assert.ok(killed - started >= 250 * multiplier - 5, reasoningEffort + " killed early");
    assert.ok(killed - started < 250 * multiplier + 240, reasoningEffort + " killed late");
  }
});

test("manual resume after reload and auto-heal share one persistent two-kill circuit", async () => {
  const sid = randomUUID();
  fixture(`
    send("thread.started", {thread_id: "${sid}"});
    send("turn.started");
    if (prompt === "root") send("turn.completed");
    else setInterval(() => {}, 10000);
  `);
  saveSettings({ reasoningEffort: "low", maxAutoHeals: 5 });
  const target = { conversationId: randomUUID() };
  const { job: root } = new JobManager().startJob({ cwd: dir, prompt: "root", callbackTarget: target, notifyOnComplete: false });
  await root.promise;
  assert.equal(root.status, "completed");
  const manager = new JobManager();
  const { job: first } = manager.resumeFromJob(root.id, { prompt: "think", stallPolicy: "always",
    stallTimeoutMs: 450, timeoutMs: 8000, notifyOnComplete: true });
  await first.promise;
  const last = manager.jobs.get(first.autoHealedToJobId);
  await last.promise;
  const chain = readPersistedJobs().filter(j => j.recoveryChainId === root.recoveryChainId);
  assert.ok(root.recoveryChainId);
  assert.deepEqual(chain.map(j => j.zeroErrorSilenceKills), [2, 1, 0]);
  assert.deepEqual(chain.map(j => j.id), [last.id, first.id, root.id]);
  assert.equal(last.autoHealedToJobId, null);
  assert.equal(chain[0].autoHealCircuitBroken, true);
  assert.equal(chain[0].stallKind, "zero_error_silence");
  assert.equal(chain[0].notifyOnComplete, true);
  assert.equal(chain[0].callbackTarget.conversationId, target.conversationId);
  assert.match(chain[0].error, /circuit breaker.*split.*reconnect_only.*app_server/i);
  assert.deepEqual(chain.map(j => j.callbackStatus), ["pending", "skipped", "skipped"]);
  assert.equal(claimCallback(last.id).callbackStatus, "sending");
  assert.throws(() => claimCallback(last.id), { status: 409 });

  // Selecting the original ancestor after a restart must not rewind the chain's streak.
  const { job: retry } = new JobManager().resumeFromJob(root.id, { prompt: "manual retry",
    stallPolicy: "always", stallTimeoutMs: 450, timeoutMs: 8000 });
  await retry.promise;
  assert.equal(persisted(retry.id).zeroErrorSilenceKills, 3);
  assert.equal(retry.autoHealCircuitBroken, true);
  assert.equal(retry.autoHealedToJobId, null);
});

test("off disables both watchdogs and a zero reconnect threshold disables just reconnect kills", async () => {
  fixture('send("turn.started"); await wait(450); reconnect(); await wait(450); send("turn.completed");');
  for (const [stallPolicy, reconnectStallMs] of [["off", 100], ["reconnect_only", 0]]) {
    const progress = [];
    const result = await run({ stallPolicy, stallTimeoutMs: 120, reconnectStallMs, onProgress: p => progress.push(p) });
    assert.equal(result.ok, true);
    assert.equal(progress.some(p => p.silenceWarning), stallPolicy !== "off");
  }
});

test("hard timeout and manual stop terminate workers even during a silence warning", async () => {
  fixture('send("turn.started"); setInterval(() => {}, 10000);');
  const result = await run({ stallTimeoutMs: 120, timeoutMs: 650 });
  assert.equal(result.timedOut, true);
  assert.equal(result.silenceWarning, true);
  assert.equal(result.stalled, false);
  const manager = new JobManager();
  const { job } = manager.startJob({ cwd: dir, prompt: "think", stallTimeoutMs: 150, timeoutMs: 8000 });
  try {
    const deadline = Date.now() + 6000;
    while (!persisted(job.id).silenceWarning && Date.now() < deadline) await delay(40);
    assert.equal(persisted(job.id).silenceWarning, true);
    assert.equal((await manager.stopJob(job.id)).cancelled, true);
    assert.equal(persisted(job.id).status, "cancelled");
    assert.equal(job.result.stallKind, null);
    assert.equal(job.autoHealedToJobId, null);
  } finally {
    await manager.cancelAll();
  }
});
