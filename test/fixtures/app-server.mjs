import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";

// This executable stands in for CODEX_BIN. Its transcript is visible to the parent
// even if the runner has to kill it. Each test uses a fresh working directory.
const { sid, scenario = "", response = {}, policy, lockFile } = JSON.parse(fs.readFileSync("scenario.json"));
const turn = "test-turn";
const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");
const note = (method, fields) => send({ method, params: { threadId: sid, turnId: turn, ...fields } });
const complete = (status = "completed", id = turn) => note("turn/completed", { turn: { id, status, error: status === "failed" ? { message: "turn failed deliberately" } : null } });
const item = (stage, type, id, fields) => note("item/" + stage, { item: { id, type, ...fields } });
const log = value => fs.appendFileSync("transcript.ndjson", JSON.stringify(value) + "\n");
log({ args: process.argv.slice(2), pid: process.pid });
process.stderr.write("independent stderr\n");
let initId, resumed = false;
const wants = [
  ...["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval"].map(m => [m, { decision: "decline" }]),
  ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
  ["mcpServer/elicitation/request", { action: "decline", content: null }],
  ["unknown/server/request", null],
];
let approval = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  log(m);
  const reply = result => send({ id: m.id, result });
  const reject = (code, message, data) => send({ id: m.id, error: { code, message, data } });
  if (m.method === "initialize") {
    assert.deepEqual(m.params.clientInfo, { name: "codex-bridge", title: "Codex Bridge", version: "1.8.0" });
    if (scenario === "initialize") reject(-32600, "initialize failure");
    else if (scenario === "approvals") {
      initId = m.id;
      send({ id: initId, method: wants[0][0], params: {} });
    } else reply({});
  } else if (m.id === initId && !m.method && scenario === "approvals") {
    if (wants[approval][1]) assert.deepEqual(m.result, wants[approval][1]);
    else assert.equal(m.error.code, -32601);
    if (++approval < wants.length) send({ id: initId, method: wants[approval][0] });
    else reply({});
  } else if (m.method === "thread/start" || m.method === "thread/resume") {
    resumed = m.method === "thread/resume";
    if (scenario === "mismatch") reject(-32600, "provider changed", { type: "modelProviderMismatch" });
    else if (scenario === "thread/start") reject(-32600, "thread failure");
    else {
      const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {
        thread: { id: sid }, cwd: m.params.cwd, sandbox: policy || m.params.sandbox, approvalPolicy: "never",
        modelProvider: m.params.modelProvider || "mock", label: "多字节", ...response,
      } }) + "\r\n");
      const cut = frame.indexOf(Buffer.from("多")) + 1;
      process.stdout.write(frame.subarray(0, cut));
      await wait(8);
      process.stdout.write(frame.subarray(cut));
    }
  } else if (m.method === "thread/goal/get") {
    reply({ goal: scenario === "native" ? { status: "active", objective: "existing goal" } : null });
  } else if (m.method === "turn/start") {
    if (lockFile) {
      const lock = JSON.parse(fs.readFileSync(lockFile));
      assert.equal(lock.pid, process.pid);
      assert.equal(lock.sessionId, sid);
      assert.ok(lock.ownerToken);
    }
    if (scenario === "invalid-json") { process.stdout.write("invalid\n"); continue; }
    if (scenario === "overlong") { process.stdout.write("x".repeat(2 * 1024 * 1024 + 1)); continue; }
    if (scenario === "overflow") {
      const line = JSON.stringify({ method: "unrelated", params: { data: "x".repeat(1024 * 1024) } }) + "\n";
      for (let i = 0; i < 16; i++) process.stdout.write(line);
      continue;
    }
    // Old turns and other threads may be multiplexed into the same stdout read.
    note("turn/started", { threadId: "other", turn: { id: "foreign" } });
    complete("failed", "stale");
    const started = () => note("turn/started", { turn: { id: turn } });
    if (scenario === "early" || scenario === "early-native") {
      started();
      item("completed", "agentMessage", "a", { text: "早到" });
      complete();
      await wait(35);
    }
    reply({ turn: { id: turn } });
    if (scenario === "early" || scenario === "early-native") continue;
    started(); started();
    note("item/completed", { turnId: "other", item: { type: "agentMessage", text: "wrong" } });
    if (scenario === "manual") send({ id: 880, method: "item/tool/requestUserInput", params: { threadId: sid, turnId: turn } });
    else if (scenario === "hang" || scenario === "uncooperative") {
      if (scenario === "uncooperative") {
        const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{},60000)"], { stdio: "ignore", windowsHide: true });
        log({ grandchild: grandchild.pid });
      }
    } else if (scenario === "heartbeat") {
      for (const [type, id] of [["commandExecution", "cmd"], ["webSearch", "web"], ["mcpToolCall", "tool"]]) {
        item("started", type, id); item("started", type, id);
        await wait(380);
        item("completed", type, id);
      }
      const stream = ["item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/commandExecution/outputDelta"];
      for (let i = 0; i < 80; i++) {
        note(stream[i % stream.length], { delta: "partial" });
        await wait(45);
      }
      item("completed", "agentMessage", "a", { text: "final message" });
      complete();
    } else if (scenario === "budget") {
      note("thread/tokenUsage/updated", { tokenUsage: { total: { totalTokens: 103 }, last: { totalTokens: 3 } } });
      note("thread/tokenUsage/updated", { tokenUsage: { total: { totalTokens: 106 }, last: { totalTokens: 3 } } });
    } else if (scenario === "recover" && !resumed) note("error", { willRetry: true, error: { message: "Reconnecting" } });
    else if (scenario === "silence") { /* leave the accepted turn idle */ }
    else complete(["failed", "interrupted"].includes(scenario) ? scenario : "completed");
  } else if (m.method === "turn/interrupt") {
    assert.deepEqual(m.params, { threadId: sid, turnId: turn });
    reply({});
    complete("completed", "wrong-turn");
    if (scenario !== "uncooperative") complete("interrupted");
  } else if (m.method === "turn/steer") {
    const text = m.params.input[0].text;
    if (text === "no-response") continue;
    if (text === "refuse") { reject(-32000, "Refused correction"); continue; }
    const turnId = text === "wrong-response" ? "other" : m.params.expectedTurnId;
    setTimeout(() => {
      log({ steerAck: text });
      reply({ turnId });
    }, 40);
  }
}
