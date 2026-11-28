import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { beforeEach, afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { JobManager, readPersistedJobs } from "../server/job-manager.js";
import { getJobsPath, loadHistory } from "../server/settings-store.js";
import { inspectSessionLock, releaseSessionLock } from "../server/session-lock.js";
import { withFileLock, writeJsonAtomic } from "../server/file-store.js";
import { publish, pruneControls } from "../server/job-control.js";
import { McpClient, freePort, startSidecar } from "./acceptance-v14.mjs";

let dir, sid, conv, saved, sidecar;
const turn = "test-turn";
const record = id => readPersistedJobs().find(row => row.id === id);
const transcript = () => fs.readFileSync(path.join(dir, "transcript.ndjson"), "utf8").trim().split("\n").map(s => JSON.parse(s));
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out awaiting " + check);
    await delay(30);
  }
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-steer-"));
  sid = randomUUID();
  conv = randomUUID();
  const env = { CODEX_HOME: dir, CODEX_BRIDGE_DATA_DIR: dir, ANTIGRAVITY_CONVERSATION_ID: conv,
    CODEX_BIN: fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url)) };
  saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  writeJsonAtomic(path.join(dir, "scenario.json"), { sid, scenario: "hang" });
});
afterEach(async () => {
  if (sidecar && sidecar.exitCode === null && sidecar.signalCode === null) {
    const closed = once(sidecar, "close");
    sidecar.kill();
    await closed;
  }
  sidecar = null;
  for (const [k,v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function panel(token) {
  const port = await freePort();
  sidecar = await startSidecar({ CODEX_PANEL_DISABLE_WATCHER: "1" }, port, token, dir);
  const url = "http://127.0.0.1:" + port;
  return { url, post: (route, data, credential = token) => fetch(url + route, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Sidecar-Token": credential },
    body: JSON.stringify(data),
  }) };
}

async function startMcp(mcp) {
  await mcp.init();
  const started = await mcp.callTool("codex_start", { cwd: dir, prompt: "test", execution_engine: "app_server", notify_on_complete: false });
  const id = /Job ID: (codex_\w+)/.exec(started.content[0].text)?.[1];
  assert.ok(id, started.content[0].text);
  await until(() => record(id)?.canSteer);
  return id;
}

test("MCP and sidecar each own and steer live jobs across processes with scoped receipts", async () => {
  const token = randomUUID(), ui = await panel(token);
  const mcp = new McpClient();
  try {
    const id = await startMcp(mcp);
    const post = args => ui.post("/api/jobs/steer", { jobId: id, message: "correction", ...args });
    const original = record(id);
    assert.equal((await post({ conversationId: randomUUID() })).status, 403);
    const mismatch = await mcp.callTool("codex_steer", { job_id: id, message: "bad", conversation_id: conv }, { conversationId: randomUUID() });
    assert.match(mismatch.content[0].text, /Status: rejected/);
    const local = await mcp.callTool("codex_steer", { job_id: id, message: "local" });
    assert.match(local.content[0].text, /Status: accepted[\s\S]+Turn ID: test-turn/);
    const remote = await (await post({})).json();
    assert.equal(remote.status, "accepted"); assert.equal(remote.turnId, turn);
    const queued = await mcp.callTool("codex_steer", { job_id: id, message: "later", wait_seconds: 0 });
    assert.match(queued.content[0].text, /Status: queued/);
    await until(() => record(id).steerCount === 3);
    assert.deepEqual(record(id).steerHistory.map(e => e.preview), ["local", "correction", "later"]);
    assert.deepEqual(record(id).callbackTarget, original.callbackTarget);
    assert.equal(record(id).transferredFrom, original.transferredFrom);
    const parallel = await Promise.all([
      new JobManager().steerJob({ jobId: id, message: "writer A", callerConversationId: conv }),
      post({ message: "writer B" }).then(res => res.json()),
    ]);
    assert.ok(parallel.every(r => r.status === "accepted" && r.turnId === turn));
    const last = transcript().filter(m => m.method === "turn/steer" || m.steerAck).slice(-4);
    assert.equal(last[0].params.input[0].text, last[1].steerAck);
    assert.equal(last[2].params.input[0].text, last[3].steerAck);
    assert.notEqual(last[1].steerAck, last[3].steerAck);
    await mcp.callTool("codex_cancel", { job_id: id });

    const resumed = await (await ui.post("/api/jobs/resume", { jobId: id })).json();
    assert.ok(resumed.ok, JSON.stringify(resumed));
    const next = resumed.job.id;
    try {
      await until(() => record(next)?.canSteer);
      assert.notEqual(record(next).ownerId, original.ownerId);
      assert.equal(releaseSessionLock(sid, original.lockToken), false);
      assert.equal((await ui.post("/api/jobs/steer", { jobId: next, message: "bad" }, randomUUID())).status, 401);
      const ack = await mcp.callTool("codex_steer", { job_id: next, message: "sidecar owner", expected_turn_id: turn });
      assert.match(ack.content[0].text, /Status: accepted[\s\S]+Turn ID: test-turn/);
      assert.equal(record(next).steerCount, 1);
      const state = await (await fetch(ui.url + "/api/state")).text();
      for (const secret of ["ownerId", "lockToken", record(next).ownerId, record(next).lockToken, token]) assert.ok(!state.includes(secret));
    } finally { await ui.post("/api/jobs/stop", { jobId: next }); }
  } finally { mcp.close(); }
});

test("tokenless sidecar refuses steering", async () => {
  const ui = await panel("");
  assert.equal((await ui.post("/api/jobs/steer", { jobId: "x", conversationId: conv })).status, 403);
});

test("serialized consumption, stale envelopes, bounded history and concurrent stop", async () => {
  const owner = new JobManager(), remote = new JobManager();
  const job = owner.startJob({ cwd: dir, prompt: "test", executionEngine: "app_server" }).job;
  const steer = (manager, message, fields) => manager.steerJob({ jobId: job.id, message, ...fields });
  try {
    await until(() => job.canSteer);
    const pair = await Promise.all([steer(remote, "first"), steer(owner, "second")]);
    assert.deepEqual(pair.map(r => r.status), ["accepted", "accepted"]);
    const order = transcript().filter(m => m.method === "turn/steer" || m.steerAck).map(m => m.steerAck || m.params.input[0].text);
    assert.deepEqual(order, ["first", "first", "second", "second"]);
    for (const message of [" ", "a".repeat(16001)]) await assert.rejects(steer(remote, message), { status: 400 });
    assert.equal((await steer(remote, "wrong turn", { expectedTurnId: "old" })).status, "rejected");
    for (const message of ["wrong-response", "refuse"]) assert.equal((await steer(owner, message)).status, "rejected");
    const controlDir = path.join(dir, "control", job.id);
    for (const override of [{ ownerId: randomUUID() }, { expiresAt: new Date(0).toISOString() }, { expectedTurnId: "old" }]) {
      const cmd = { jobId: job.id, threadId: sid, ownerPid: process.pid, ownerId: owner.ownerId, expectedTurnId: turn,
        requestId: randomUUID(), message: "invalid", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+12000).toISOString(), ...override };
      withFileLock(getJobsPath(), () => publish(cmd));
      const file = path.join(controlDir, "ack-" + cmd.requestId + ".json");
      await until(() => fs.existsSync(file));
      assert.equal(JSON.parse(fs.readFileSync(file)).status, "rejected");
    }
    assert.ok(!transcript().some(m => m.params?.input?.[0]?.text === "invalid"));
    for (let i = 0; i < 21; i++) assert.equal((await steer(owner, "serial " + i)).status, "accepted");
    assert.equal(record(job.id).steerCount, 23);
    assert.deepEqual(record(job.id).steerHistory.map(r => r.preview), Array.from({ length: 20 }, (_, i) => "serial " + (i+1)));
    const [ack] = await Promise.all([steer(remote, "race"), owner.stopJob(job.id)]);
    assert.equal(ack.status, "rejected");
    assert.equal(loadHistory().filter(r => r.jobId === job.id).length, 1);
    assert.equal(record(job.id).status, "cancelled"); assert.equal(inspectSessionLock(sid).locked, false);
    const rows = readPersistedJobs();
    pruneControls(rows, () => false);
    assert.ok(fs.existsSync(controlDir));
    rows[0].finishedAt = new Date(0).toISOString();
    fs.utimesSync(controlDir, new Date(0), new Date(0));
    pruneControls(rows, () => false);
    assert.ok(!fs.existsSync(controlDir));
  } finally { await owner.stopJob(job.id); }
});

test("owner death after RPC and before ACK yields unknown with one delivery", async () => {
  const mcp = new McpClient(), caller = new JobManager();
  try {
    const id = await startMcp(mcp);
    const receipt = caller.steerJob({ jobId: id, message: "no-response", callerConversationId: conv, waitSeconds: 1.5 });
    await until(() => transcript().some(m => m.method === "turn/steer"));
    const closed = once(mcp.child, "close");
    mcp.close();
    await closed;
    assert.equal((await receipt).status, "unknown");
    assert.equal(transcript().filter(m => m.method === "turn/steer").length, 1);
    assert.ok(!fs.readdirSync(path.join(dir, "control", id)).some(f => /^(cmd-|ack-)/.test(f)));
  } finally { mcp.close(); }
});

test("legacy exec and detached records cannot steer", async () => {
  for (const [engine,status] of [["exec","running"], ["app_server","running_detached"]]) {
    const job = { id: "old", ownerId: randomUUID(), engine, status, activeTurnId: turn, canSteer: true };
    writeJsonAtomic(getJobsPath(), [job]);
    assert.equal(record(job.id).canSteer, false);
    await assert.rejects(new JobManager().steerJob({ jobId: job.id, message: "test" }), { status: 409, message: /codex_start/ });
  }
});
