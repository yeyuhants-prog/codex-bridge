import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createGoal, recordGoalExecution } from "../server/goal-store.js";
import { activityCounts, resolveGoalLocation, taskRows } from "../sidecars/codex_panel/view-model.mjs";
import { McpClient, startSidecar, freePort } from "./acceptance-v14.mjs";

test("archived goal location follows owner, exact executions, then a unique session and directory", () => {
  const goal = { id: "goal", cwd: "/shared", sessionId: "thread", milestones: [{ jobId: "old" }] };
  const rows = taskRows([{ id: "live", goalId: "goal", conversationId: "B", cwd: goal.cwd, status: "running" }], [
    { jobId: "old", callbackTarget: { conversationId: "A", projectId: "P" }, cwd: goal.cwd, archived: true },
    ...Array.from({ length: 12 }, (_, i) => ({ historyKey: String(i), cwd: goal.cwd, archived: true, at: new Date(i + 100).toISOString() })),
  ]);
  const resolve = (g, r = rows) => resolveGoalLocation(g, r);
  const ambiguous = resolve(goal);
  assert.deepEqual(ambiguous.candidateConversationIds.sort(), ["A", "B"]);
  assert.equal(ambiguous.hasUniqueConversation, false);
  assert.equal(ambiguous.sectionHint, "active");
  assert.deepEqual(ambiguous.matchedRowKeys, ["live", "history:old"]);
  const owned = resolve({ ...goal, conversationId: "A" });
  assert.deepEqual([owned.conversationId, owned.projectId, owned.hasUniqueConversation], ["A", "P", true]);
  const archived = resolve(goal, rows.filter(r => r.id !== "live"));
  assert.deepEqual([archived.sectionHint, archived.matchedRowKeys, archived.conversationId], ["archived", ["history:old"], "A"]);
  assert.ok(rows.findIndex(row => row.key === "history:old") >= 8);
  const history = [{ id: "a", key: "a", sessionId: "thread", cwd: goal.cwd, conversationId: "A", status: "completed" }];
  const unique = resolve(goal, history);
  assert.deepEqual([unique.sectionHint, unique.conversationId, unique.matchedRowKeys], ["history", "A", ["a"]]);
  assert.equal(resolve(goal, [...history, { ...history[0], conversationId: "B" }]).hasUniqueConversation, false);
  assert.deepEqual(resolve({ ...goal, sessionId: "" }, history).matchedRowKeys, []);
  assert.deepEqual(resolve(goal, [{ ...history[0], cwd: "/different" }]).matchedRowKeys, []);
  assert.deepEqual(resolve({ id: "none", cwd: goal.cwd }, rows), { conversationId: "", projectId: "",
    candidateConversationIds: [], cwd: "/shared", matchedRowKeys: [], sectionHint: null, hasUniqueConversation: false });
  assert.equal(resolve({ id: "empty" }, []).cwd, "");
});

test("open goals, local running jobs and other chat jobs are independent counts", () => {
  const goals = ["active", "paused", "completed", "failed"].map(status => ({ status }));
  goals.push({ archived: true, status: "active" });
  const jobs = [{ status: "running", conversationId: "A" }, { status: "running_detached", callbackTarget: { conversationId: "B" } },
    { status: "completed", conversationId: "B" }, { status: "running" }];
  assert.deepEqual(activityCounts(goals, jobs, "A"), { goalsCount: 4, goalStatusCounts: { active: 1, paused: 1, completed: 1, failed: 1 }, openGoalsCount: 2, localActiveCount: 1, otherActiveCount: 1 });
});

test("goal owners persist across transfers, and MCP creation reconciles explicit and host context", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-goal-owner-"));
  const oldDir = process.env.CODEX_BRIDGE_DATA_DIR;
  process.env.CODEX_BRIDGE_DATA_DIR = dir;
  t.after(() => {
    if (oldDir === undefined) delete process.env.CODEX_BRIDGE_DATA_DIR;
    else process.env.CODEX_BRIDGE_DATA_DIR = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const a = randomUUID(), b = randomUUID();
  const goal = createGoal({ title: "Legacy" });
  assert.deepEqual([goal.conversationId, goal.projectId], ["", ""]);
  const dispatch = (conversationId, projectId) => recordGoalExecution(goal.id, { conversationId, projectId });
  dispatch(a, "");
  assert.equal(dispatch(b, "other").projectId, "");
  dispatch(a, "project");
  const kept = dispatch(b, "other");
  assert.deepEqual([kept.conversationId, kept.projectId], [a, "project"]);
  const client = new McpClient({ ANTIGRAVITY_CONVERSATION_ID: a, ANTIGRAVITY_PROJECT_ID: "", ANTIGRAVITY_SOURCE_METADATA: "" });
  try {
    await client.init();
    const create = id => client.callTool("codex_goal", { action: "create", title: "MCP", conversation_id: id, project_id: "project" });
    assert.ok(!(await create(a)).isError);
    assert.ok((await create(b)).isError);
    const { goals } = JSON.parse(fs.readFileSync(path.join(dir, "goals.json")));
    assert.deepEqual(goals.filter(g => g.title === "MCP").map(g => [g.conversationId, g.projectId]), [[a, "project"]]);
  } finally { client.close(); }
});

test("host-backed goal create, read-only legacy state and steer-first periodic check", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-goal-panel-"));
  const write = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  const read = file => fs.readFileSync(path.join(dir, file), "utf8");
  const conversationId = randomUUID(), projectId = randomUUID(), token = randomUUID();
  const old = new Date(Date.now() - 120000).toISOString();
  const goal = { id: "legacy", title: "Legacy", cwd: dir, milestones: [], status: "completed", archived: true };
  write("goals.json", { activeGoalId: null, goals: [goal] });
  const before = read("goals.json");
  write("jobs.json", [{ id: "job", status: "running", startedAt: old, engine: "app_server", canSteer: true,
    activeTurnId: "turn-42", ownerId: "owner", ownerPid: process.pid, pid: process.pid, goalId: goal.id,
    notifyOnComplete: true, callbackTarget: { conversationId, projectId }, cwd: dir }]);
  write("settings.json", { progressionMode: "notify", language: "en", monitorIntervalSeconds: 60 });
  write("package.json", { type: "module" });
  fs.writeFileSync(path.join(dir, "agentapi"), [
    'import fs from "node:fs";',
    'const [command, , message] = process.argv.slice(2);',
    'if (command === "send-message") fs.writeFileSync("inspection.txt", message);',
    'console.log(JSON.stringify({ conversationMetadata: { metadata: { projectId: process.env.ANTIGRAVITY_PROJECT_ID } } }));',
  ].join("\n"));
  const port = await freePort();
  let child;
  try {
    child = await startSidecar({ CODEX_BRIDGE_DATA_DIR: dir, CODEX_HOME: dir, ANTIGRAVITY_PROJECT_ID: projectId,
      ANTIGRAVITY_CONVERSATION_ID: conversationId, ANTIGRAVITY_AGENTAPI_EXE: process.execPath, CODEX_PANEL_DISABLE_WATCHER: "0" }, port, token, dir);
    const base = "http://127.0.0.1:" + port;
    const state = await (await fetch(base + "/api/state?conversationId=" + randomUUID())).json();
    assert.equal(state.jobs[0].canSteer, true);
    assert.equal(state.goalsStore.goals[0].conversationId, undefined);
    assert.equal(read("goals.json"), before);
    const response = await fetch(base + "/api/goals", { method: "POST", headers: { "Content-Type": "application/json", "X-Sidecar-Token": token },
      body: JSON.stringify({ title: "Panel", conversationId: "wrong", projectId: "wrong" }) });
    const created = (await response.json()).goal;
    assert.deepEqual([created.conversationId, created.projectId], [conversationId, projectId]);
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, "inspection.txt")); i++) await delay(80);
    const inspection = read("inspection.txt");
    assert.match(inspection, /first use codex_steer\(job_id="job", expected_turn_id="turn-42", message="\.\.\."\)/);
    assert.ok(inspection.indexOf("codex_steer") < inspection.indexOf("codex_cancel"));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("Chromium: badge and ARIA, banner, locate across pages, host toggle guard, render cache and steer receipts", async () => {
  const file = fileURLToPath(new URL("./panel-browser.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file], { windowsHide: true, timeout: 90000 });
  for (const width of [360, 480]) assert.ok(stdout.includes(width + "px"));
});
