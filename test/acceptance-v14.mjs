import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_ROOT =
  process.env.PLUGIN_ROOT ||
  path.join(os.homedir(), ".gemini", "config", "plugins", "codex-bridge");
const MCP_SERVER = path.join(PLUGIN_ROOT, "server", "mcp-server.js");
const SIDECAR_MAIN = path.join(PLUGIN_ROOT, "sidecars", "codex_panel", "main.mjs");
const SIDECAR_LOADER = path.join(
  os.homedir(),
  ".gemini",
  "config",
  "node_modules",
  "sidecar_sdk",
  "register_loader.js"
);
const RUN_REAL_CLI = process.argv.includes("--real-cli");

const CONV_A = "11111111-aaaa-4111-8111-aaaaaaaaaaaa";
const PROJ_A = "aaaa1111-0000-4000-8000-000000000001";
const CONV_B = "22222222-bbbb-4222-8222-bbbbbbbbbbbb";
const PROJ_B = "bbbb2222-0000-4000-8000-000000000002";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class McpClient {
  constructor(env = {}) {
    this.child = spawn(process.execPath, [MCP_SERVER], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d) => {
      this.buf += d;
      let idx;
      while ((idx = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      }
    });
    let stderr = "";
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => (stderr += d));
    this.child.on("close", (code) => {
      for (const [, { reject }] of this.pending) {
        reject(new Error(`MCP server exited unexpectedly (code=${code}): ${stderr.slice(0, 400)}`));
      }
      this.pending.clear();
    });
  }

  async init() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "acceptance-test", version: "1.4.0" },
    });
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
    );
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
    });
  }

  callTool(name, args = {}, meta = {}) {
    return this.request("tools/call", { name, arguments: args, _meta: meta });
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.kill();
    } catch {}
  }
}

function createMockBinaries(tmpRoot) {
  // 1) Mock Codex CLI (.cmd wrapper -> node script)
  const mockCodexJs = path.join(tmpRoot, "mock-codex.mjs");
  const mockCodexLog = path.join(tmpRoot, "mock-codex-log.jsonl");
  const mockCodexCmd = path.join(tmpRoot, "mock-codex.cmd");

  fs.writeFileSync(
    mockCodexJs,
    `
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.171.0-mock");
  process.exit(0);
}

const logFile = process.env.MOCK_CODEX_LOG;
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", async () => {
  // Validate flag placement just like real codex.exe: --sandbox / -s / -C after 'resume' is an error!
  const resumeIdx = args.indexOf("resume");
  if (resumeIdx !== -1) {
    const after = args.slice(resumeIdx + 1);
    if (after.includes("-s") || after.includes("--sandbox") || after.includes("-C") || after.includes("--cd")) {
      console.error("error: unexpected argument '--sandbox' / '-C' found after 'resume'");
      process.exit(2);
    }
  }

  // Extract -s / --sandbox before resume (or anywhere in run)
  let sandbox = "workspace-write";
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-s" || args[i] === "--sandbox") sandbox = args[i + 1];
  }
  let cdArg = null;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-C" || args[i] === "--cd") cdArg = args[i + 1];
  }

  const sid = resumeIdx !== -1 ? args[args.length - 2] : (process.env.MOCK_SESSION_ID || "11111111-1111-4111-8111-111111111111");
  const record = {
    pid: process.pid,
    cwd: process.cwd(),
    cdArg,
    sandbox,
    args,
    resumeIdx,
    sessionId: sid,
    stdin: stdin.trim(),
    at: new Date().toISOString(),
  };
  fs.appendFileSync(logFile, JSON.stringify(record) + "\\n", "utf8");

  console.log(JSON.stringify({ type: "thread.started", thread_id: sid }));
  console.log(JSON.stringify({ type: "turn.started" }));

  const holdMs = Number(process.env.MOCK_HOLD_MS || 0);
  if (holdMs > 0) {
    await new Promise((r) => setTimeout(r, holdMs));
  }

  if (stdin.includes("ATTEMPT_WRITE")) {
    if (sandbox === "read-only") {
      console.log(JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "WRITE_BLOCKED_BY_READ_ONLY_SANDBOX" }
      }));
    } else {
      fs.writeFileSync(path.join(process.cwd(), "mock_written.txt"), "WRITTEN", "utf8");
      console.log(JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "WRITE_SUCCEEDED" }
      }));
    }
  } else {
    console.log(JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "MOCK_DONE:" + sid }
    }));
  }
  console.log(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 }
  }));
});
`,
    "utf8"
  );
  fs.writeFileSync(
    mockCodexCmd,
    `@echo off\r\n"${process.execPath}" "${mockCodexJs}" %*\r\n`,
    "utf8"
  );

  // 2) Mock agentapi (executed directly by node.exe via `execFileSync(node, ["agentapi", ...])`)
  const mockAgentDir = path.join(tmpRoot, "mock_agent_cwd");
  fs.mkdirSync(mockAgentDir, { recursive: true });
  const mockAgentScript = path.join(mockAgentDir, "agentapi");
  const mockAgentLog = path.join(tmpRoot, "mock-agentapi-log.jsonl");
  const mockAgentFlag = path.join(tmpRoot, "mock-agentapi-fail.flag");

  fs.writeFileSync(
    path.join(mockAgentDir, "package.json"),
    JSON.stringify({ type: "module" }),
    "utf8"
  );
  fs.writeFileSync(
    mockAgentScript,
    `
import fs from "node:fs";
const args = process.argv.slice(2);
const sub = args[0];
const rest = args.slice(1);
const logFile = process.env.MOCK_AGENTAPI_LOG;
const failFlag = process.env.MOCK_AGENTAPI_FAIL_FLAG;

if (sub === "get-conversation-metadata") {
  const convId = rest[0];
  const map = {
    "${CONV_A}": "${PROJ_A}",
    "${CONV_B}": "${PROJ_B}",
  };
  if (!map[convId]) {
    console.log(JSON.stringify({ error: "conversation not found: " + convId }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    response: { conversationMetadata: { metadata: { projectId: map[convId] } } }
  }));
  process.exit(0);
}

if (sub === "send-message") {
  const convId = rest[0];
  const message = rest[1] || "";
  const projId = process.env.ANTIGRAVITY_PROJECT_ID || "";
  const shouldFail = failFlag && fs.existsSync(failFlag);
  fs.appendFileSync(logFile, JSON.stringify({
    convId,
    projId,
    failed: shouldFail,
    preview: message.slice(0, 120),
    at: new Date().toISOString(),
  }) + "\\n", "utf8");
  if (shouldFail) {
    console.error("simulated send-message network error");
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, conversationId: convId }));
  process.exit(0);
}

console.log("{}");
`,
    "utf8"
  );

  return {
    mockCodexCmd,
    mockCodexLog,
    mockAgentDir,
    mockAgentLog,
    mockAgentFlag,
  };
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function startSidecar(env, port, token, cwd) {
  const child = spawn(
    process.execPath,
    [`--import=${pathToFileURL(SIDECAR_LOADER).href}`, SIDECAR_MAIN],
    {
      cwd: cwd || path.dirname(SIDECAR_MAIN),
      env: {
        ...process.env,
        ...env,
        ANTIGRAVITY_LS_ADDRESS: "localhost:5387",
        ANTIGRAVITY_CSRF_TOKEN: "test-csrf",
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
        ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
        CODEX_PANEL_WATCHER_MS: "250",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (r.ok) return child;
    } catch {}
    if (child.exitCode !== null) {
      throw new Error(`Sidecar crashed early: ${stderr}`);
    }
    await sleep(150);
  }
  throw new Error(`Sidecar failed to bind port ${port}: ${stderr}`);
}

async function runTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cb-v14-accept-"));
  const dataDir = path.join(tmpRoot, "data");
  const projectDir = path.join(tmpRoot, "target_project");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const mocks = createMockBinaries(tmpRoot);
  const sidecarPort = 47925 + Math.floor(Math.random() * 400);
  const sidecarToken = "accept-tok-14";
  const baseEnv = {
    CODEX_BRIDGE_DATA_DIR: dataDir,
    CODEX_BIN: mocks.mockCodexCmd,
    MOCK_CODEX_LOG: mocks.mockCodexLog,
    ANTIGRAVITY_AGENTAPI_EXE: process.execPath,
    MOCK_AGENTAPI_LOG: mocks.mockAgentLog,
    MOCK_AGENTAPI_FAIL_FLAG: mocks.mockAgentFlag,
  };

  let sidecar = null;
  let mcpA = null;
  let mcpB = null;

  try {
    sidecar = await startSidecar(baseEnv, sidecarPort, sidecarToken, mocks.mockAgentDir);
    const sidecarPost = async (urlPath, body) => {
      const r = await fetch(`http://127.0.0.1:${sidecarPort}${urlPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sidecar-Token": sidecarToken,
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, data: await r.json() };
    };

    // =========================================================================
    // ACCEPTANCE TEST 1: Conv A dispatches, Conv B refreshes panel -> callback goes ONLY to A
    // =========================================================================
    console.log("=== TEST 1: Per-job locked callback routing (A -> B refresh -> callback ONLY to A) ===");
    mcpA = new McpClient({
      ...baseEnv,
      ANTIGRAVITY_CONVERSATION_ID: CONV_A,
      ANTIGRAVITY_PROJECT_ID: PROJ_A,
      MOCK_SESSION_ID: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      MOCK_HOLD_MS: "800",
    });
    await mcpA.init();

    const startRes1 = await mcpA.callTool("codex_start", {
      prompt: "Task from conversation A",
      cwd: projectDir,
      sandbox: "read-only",
    });
    const job1Match = /Job ID: (codex_[a-f0-9]+)/.exec(startRes1.content[0].text);
    assert.ok(job1Match, "Should return job_id for Test 1");
    const job1Id = job1Match[1];

    // While job1 is running, Conv B refreshes /api/state multiple times
    const settingsBefore = fs.existsSync(path.join(dataDir, "settings.json"))
      ? fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")
      : null;
    for (let i = 0; i < 3; i++) {
      const r = await fetch(
        `http://127.0.0.1:${sidecarPort}/api/state?conversationId=${CONV_B}`
      );
      assert.equal(r.status, 200);
      await sleep(150);
    }
    const settingsAfter = fs.existsSync(path.join(dataDir, "settings.json"))
      ? fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")
      : null;
    assert.equal(settingsAfter, settingsBefore, "GET /api/state MUST be pure read-only");

    // Wait for job1 completion + watcher callback delivery
    let delivered = [];
    for (let i = 0; i < 30; i++) {
      delivered = readJsonl(mocks.mockAgentLog);
      if (delivered.length > 0) break;
      await sleep(200);
    }
    assert.equal(delivered.length, 1, "Exactly one callback should be sent");
    assert.equal(delivered[0].convId, CONV_A, "Callback MUST go to Conv A, NEVER Conv B");
    assert.equal(delivered[0].projId, PROJ_A, "Callback MUST carry Conv A projectId");
    console.log("  PASS: Callback delivered exclusively to Conv A despite Conv B panel refreshes.");

    // =========================================================================
    // ACCEPTANCE TEST 2: Simulate send failure -> marked failed (not sent) -> retry delivers to A
    // =========================================================================
    console.log("=== TEST 2: Failed callback stays failed & retries strictly to Conv A ===");
    fs.writeFileSync(mocks.mockAgentFlag, "fail", "utf8");
    const mcpA2 = new McpClient({
      ...baseEnv,
      ANTIGRAVITY_CONVERSATION_ID: CONV_A,
      ANTIGRAVITY_PROJECT_ID: PROJ_A,
      MOCK_SESSION_ID: "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa",
      MOCK_HOLD_MS: "100",
    });
    await mcpA2.init();
    const startRes2 = await mcpA2.callTool("codex_start", {
      prompt: "Task A2 for failure retry test",
      cwd: projectDir,
      sandbox: "read-only",
    });
    const job2Id = /Job ID: (codex_[a-f0-9]+)/.exec(startRes2.content[0].text)[1];

    // Wait for watcher to attempt & fail delivery
    let job2State = null;
    for (let i = 0; i < 30; i++) {
      const st = await (
        await fetch(`http://127.0.0.1:${sidecarPort}/api/state?conversationId=${CONV_B}`)
      ).json();
      job2State = st.jobs.find((j) => j.id === job2Id);
      if (job2State && job2State.callbackStatus === "failed") break;
      await sleep(200);
    }
    assert.equal(job2State.callbackStatus, "failed", "Failed delivery MUST be marked failed");
    assert.equal(job2State.callbackSent, false, "Failed delivery MUST NOT be marked callbackSent=true");
    assert.ok(job2State.callbackError, "Failed delivery MUST record callbackError");

    // Now clear failure flag and retry from panel (even while Conv B is open)
    fs.unlinkSync(mocks.mockAgentFlag);
    const retryRes = await sidecarPost("/api/jobs/retry-callback", { jobId: job2Id });
    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.data.ok, true);
    assert.equal(retryRes.data.status, "sent");

    const allDeliveries = readJsonl(mocks.mockAgentLog);
    const lastDelivery = allDeliveries[allDeliveries.length - 1];
    assert.equal(lastDelivery.convId, CONV_A, "Retry MUST deliver strictly to Conv A");
    assert.equal(lastDelivery.failed, false);
    mcpA2.close();
    console.log("  PASS: Failed callback stayed visibly failed and retried strictly to Conv A.");

    // =========================================================================
    // ACCEPTANCE TEST 3: Resume read-only job via Panel & MCP -> preserves cwd, passes -s read-only before resume, blocks escalation
    // =========================================================================
    console.log("=== TEST 3: Structured resume from Panel & MCP preserves cwd & enforces read-only sandbox ===");
    // 3a: Escalation blocked via Panel
    const escPanel = await sidecarPost("/api/jobs/resume", {
      jobId: job1Id,
      sandbox: "workspace-write",
      prompt: "ATTEMPT_WRITE",
    });
    assert.equal(escPanel.status, 400, "Widening sandbox without explicit confirmation must fail");
    assert.match(escPanel.data.error, /Refusing to widen sandbox/i);

    // 3b: Panel structured resume inherits cwd + read-only sandbox & creates linked job
    const panelResume = await sidecarPost("/api/jobs/resume", {
      jobId: job1Id,
      prompt: "ATTEMPT_WRITE",
    });
    assert.equal(panelResume.status, 200);
    assert.equal(panelResume.data.ok, true);
    assert.equal(panelResume.data.reused, false);
    assert.equal(panelResume.data.job.parentJobId, job1Id);
    assert.equal(panelResume.data.job.sandbox, "read-only");
    assert.equal(path.resolve(panelResume.data.job.cwd), path.resolve(projectDir));

    // Wait for resumed background job to finish
    for (let i = 0; i < 30; i++) {
      const st = await (await fetch(`http://127.0.0.1:${sidecarPort}/api/state`)).json();
      const j = st.jobs.find((x) => x.id === panelResume.data.job.id);
      if (j && j.status !== "running") break;
      await sleep(150);
    }

    // 3c: MCP sync codex_resume by resume_job_id (omitting cwd & sandbox!)
    const mcpEsc = await mcpA.callTool("codex_resume", {
      resume_job_id: job1Id,
      sandbox: "danger-full-access",
      prompt: "ATTEMPT_WRITE",
    });
    assert.equal(mcpEsc.isError, true, "MCP sync resume escalation must be blocked");

    const mcpResume = await mcpA.callTool("codex_resume", {
      resume_job_id: job1Id,
      prompt: "ATTEMPT_WRITE",
    });
    assert.equal(mcpResume.isError, false, "MCP sync resume should succeed");
    assert.match(mcpResume.content[0].text, /WRITE_BLOCKED_BY_READ_ONLY_SANDBOX/);

    // Verify mock-codex log for both resumes
    const codexLogs = readJsonl(mocks.mockCodexLog).filter((e) => e.resumeIdx !== -1);
    assert.ok(codexLogs.length >= 2, "Expected at least 2 resume invocations");
    for (const entry of codexLogs) {
      assert.equal(path.resolve(entry.cwd), path.resolve(projectDir), "Child cwd MUST match original projectDir");
      assert.equal(entry.sandbox, "read-only", "Resume MUST pass -s read-only before resume");
      assert.ok(entry.args.indexOf("-s") < entry.resumeIdx, "-s MUST precede resume");
      assert.ok(entry.args.indexOf("-C") < entry.resumeIdx, "-C MUST precede resume");
    }
    assert.equal(
      fs.existsSync(path.join(projectDir, "mock_written.txt")),
      false,
      "No file may be written under read-only sandbox"
    );
    console.log("  PASS: Both Panel & MCP resumes preserved cwd, placed -C/-s before resume, blocked escalation & write.");

    // =========================================================================
    // ACCEPTANCE TEST 4: Old PID still alive across MCP restart -> running_detached + mutex blocks duplicate spawns
    // =========================================================================
    console.log("=== TEST 4: Detached alive PID across restart & cross-process per-session mutex ===");
    const longSid = "44444444-4444-4444-8444-444444444444";
    // Spawn a real long-running detached OS process (node sleep) to simulate an orphaned live Codex process
    const orphanChild = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      { stdio: "ignore", windowsHide: true }
    );
    const orphanPid = orphanChild.pid;
    assert.ok(orphanPid, "Orphan PID must exist");

    // Persist a running job record owned by a dead parent PID (999999) with our live orphanPid
    const jobsPath = path.join(dataDir, "jobs.json");
    const existingJobs = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
    const detachedJobId = "codex_deadbeef";
    existingJobs.unshift({
      id: detachedJobId,
      parentJobId: null,
      mode: "run",
      status: "running",
      cwd: projectDir,
      model: "gpt-6.2-sol",
      reasoningEffort: "high",
      sandbox: "read-only",
      goalId: null,
      milestoneId: null,
      promptPreview: "Long running job across MCP restart",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pid: orphanPid,
      ownerPid: 999999,
      sessionId: longSid,
      eventCount: 5,
      recentEvents: [],
      error: null,
      notifyOnComplete: true,
      callbackTarget: { conversationId: CONV_A, projectId: PROJ_A, source: "host_env" },
      callbackStatus: "pending",
      callbackSent: false,
      callbackAttempts: 0,
      callbackAt: null,
      callbackError: null,
      resultSummary: null,
    });
    fs.writeFileSync(jobsPath, JSON.stringify(existingJobs, null, 2), "utf8");

    // Start a fresh MCP server after simulated restart
    mcpB = new McpClient({
      ...baseEnv,
      ANTIGRAVITY_CONVERSATION_ID: CONV_A,
      ANTIGRAVITY_PROJECT_ID: PROJ_A,
      MOCK_HOLD_MS: "50",
    });
    await mcpB.init();

    // Check status -> MUST be running_detached (NOT interrupted!)
    const detStatus = await mcpB.callTool("codex_status", { job_id: detachedJobId });
    assert.match(detStatus.content[0].text, /Status: running_detached/);

    const countBefore = readJsonl(mocks.mockCodexLog).length;

    // Rapidly fire concurrent resumes from Panel AND MCP while orphanPid is alive!
    const [p1, p2, m1, m2] = await Promise.all([
      sidecarPost("/api/jobs/resume", { jobId: detachedJobId }),
      sidecarPost("/api/jobs/resume", { jobId: detachedJobId }),
      mcpB.callTool("codex_start", { resume_job_id: detachedJobId }),
      mcpB.callTool("codex_resume", { resume_job_id: detachedJobId, prompt: "try concurrent" }),
    ]);

    assert.equal(p1.data.reused, true, "Panel resume #1 must reuse active detached job");
    assert.equal(p2.data.reused, true, "Panel resume #2 must reuse active detached job");
    assert.match(m1.content[0].text, /already active/i, "MCP codex_start must reuse active job");
    assert.equal(m2.isError, true, "MCP sync codex_resume must refuse while session is active");

    await sleep(300);
    const countWhileAlive = readJsonl(mocks.mockCodexLog).length;
    assert.equal(countWhileAlive, countBefore, "ZERO new Codex processes may spawn while old PID is alive");

    // Explicitly stop the detached process via Panel endpoint
    const stopRes = await sidecarPost("/api/jobs/stop", { jobId: detachedJobId });
    assert.equal(stopRes.status, 200);
    assert.equal(stopRes.data.ok, true);

    // Now fire 2 rapid resumes: ONLY ONE new process should spawn (second reuses it!)
    const [r1, r2] = await Promise.all([
      sidecarPost("/api/jobs/resume", { jobId: detachedJobId, prompt: "Now safely resume" }),
      sidecarPost("/api/jobs/resume", { jobId: detachedJobId, prompt: "Duplicate click" }),
    ]);
    assert.equal(r1.data.ok, true);
    assert.equal(r2.data.ok, true);
    assert.notEqual(r1.data.reused, r2.data.reused, "Exactly one click spawns and the other reuses");
    await sleep(400);
    const countAfterStop = readJsonl(mocks.mockCodexLog).length;
    assert.equal(countAfterStop, countBefore + 1, "Exactly ONE new Codex process spawned after stopping old PID");
    console.log("  PASS: running_detached preserved alive PID, mutex blocked all duplicate spawns, and stop->resume spawned exactly 1 process.");

    // =========================================================================
    // ACCEPTANCE TEST 6: Shared global MCP process (no host env) locks conversation_id & verifies via agentapi
    // =========================================================================
    console.log("=== TEST 6: Shared MCP process (no host env) closed-loop via conversation_id ===");
    const mcpShared = new McpClient({
      ...baseEnv,
      ANTIGRAVITY_CONVERSATION_ID: "",
      ANTIGRAVITY_PROJECT_ID: "",
      ANTIGRAVITY_SOURCE_METADATA: "",
      MOCK_SESSION_ID: "66666666-6666-4666-8666-666666666666",
      MOCK_HOLD_MS: "100",
    });
    await mcpShared.init();

    const deliveriesBefore6 = readJsonl(mocks.mockAgentLog).length;

    // 6a: Valid conversation_id from Gemini mastermind -> verified by Sidecar agentapi -> delivered strictly to CONV_A
    const sharedStart = await mcpShared.callTool("codex_start", {
      prompt: "Heavy task from Mastermind in shared MCP server",
      cwd: projectDir,
      sandbox: "read-only",
      conversation_id: CONV_A,
    });
    const job6aId = /Job ID: (codex_[a-f0-9]+)/.exec(sharedStart.content[0].text)[1];

    // Conv B refreshes panel in the meantime
    await fetch(`http://127.0.0.1:${sidecarPort}/api/state?conversationId=${CONV_B}`);

    let job6a = null;
    for (let i = 0; i < 30; i++) {
      const st = await (await fetch(`http://127.0.0.1:${sidecarPort}/api/state`)).json();
      job6a = st.jobs.find((j) => j.id === job6aId);
      if (job6a && job6a.callbackStatus === "sent") break;
      await sleep(150);
    }
    assert.equal(job6a.callbackStatus, "sent", "Shared MCP job with valid conversation_id must deliver callback");
    const deliveriesAfter6a = readJsonl(mocks.mockAgentLog);
    assert.equal(deliveriesAfter6a.length, deliveriesBefore6 + 1);
    assert.equal(deliveriesAfter6a[deliveriesAfter6a.length - 1].convId, CONV_A);
    assert.equal(deliveriesAfter6a[deliveriesAfter6a.length - 1].projId, PROJ_A, "ProjectId auto-resolved via agentapi");

    // 6b: Non-existent / invalid conversation_id -> rejected by agentapi -> kept safely as unrouted in panel
    const bogusStart = await mcpShared.callTool("codex_start", {
      prompt: "Task with stale/nonexistent conversation_id",
      cwd: projectDir,
      sandbox: "read-only",
      conversation_id: "99999999-dead-4999-8999-999999999999",
    });
    const job6bId = /Job ID: (codex_[a-f0-9]+)/.exec(bogusStart.content[0].text)[1];
    let job6b = null;
    for (let i = 0; i < 30; i++) {
      const st = await (await fetch(`http://127.0.0.1:${sidecarPort}/api/state`)).json();
      job6b = st.jobs.find((j) => j.id === job6bId);
      if (job6b && job6b.status === "completed" && job6b.callbackStatus !== "pending") break;
      await sleep(150);
    }
    assert.equal(job6b.callbackStatus, "unrouted", "Bogus conversation_id must be marked unrouted");
    assert.equal(job6b.callbackSent, false);
    mcpShared.close();
    console.log("  PASS: Shared MCP closed-loop delivered to Conv A (auto-resolved projectId) and safely quarantined invalid conversation_id.");

    // =========================================================================
    // BONUS REAL CLI VERIFICATION (when --real-cli passed): Real read-only resume write denial
    // =========================================================================
    if (RUN_REAL_CLI) {
      console.log("=== TEST 5 (REAL LOCAL CODEX CLI): Read-only resume denies actual file write ===");
      const realWorkDir = path.join(tmpRoot, "real_readonly_dir");
      fs.mkdirSync(realWorkDir, { recursive: true });
      const origCodexBin = process.env.CODEX_BIN;
      delete process.env.CODEX_BIN;
      const runner = await import(
        pathToFileURL(path.join(PLUGIN_ROOT, "server", "codex-runner.js")).href
      );
      try {
        const first = await runner.runCodex({
          mode: "run",
          cwd: realWorkDir,
          sandbox: "read-only",
          prompt: "Reply with only: READY",
        });
        assert.equal(first.ok, true, "Initial real read-only session should succeed");
        assert.ok(first.sessionId, "Initial real session must yield sessionId");

        const resumed = await runner.runCodex({
          mode: "resume",
          sessionId: first.sessionId,
          cwd: realWorkDir,
          sandbox: "read-only",
          prompt:
            "Use a shell command to try creating a file named forbidden_write.txt containing TEST in the current working directory. Report whether it failed or succeeded.",
        });
        console.log("  Real resume CLI args:", resumed.cliArgs.join(" "));
        console.log("  Real resume response:", (resumed.lastMessage || "").slice(0, 220));
        assert.equal(
          fs.existsSync(path.join(realWorkDir, "forbidden_write.txt")),
          false,
          "REAL Codex CLI read-only resumed session MUST NOT be able to write forbidden_write.txt!"
        );
        console.log("  PASS: Real local codex.exe denied file write inside resumed read-only session!");
      } finally {
        if (origCodexBin) process.env.CODEX_BIN = origCodexBin;
      }
    }

    console.log("\nALL v1.4.0 ACCEPTANCE TESTS PASSED!");
  } finally {
    if (mcpA) mcpA.close();
    if (mcpB) mcpB.close();
    if (sidecar) {
      try {
        sidecar.kill();
      } catch {}
    }
    await sleep(300);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error("ACCEPTANCE TEST FAILED:", err);
  process.exit(1);
});
