import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { activityTracker, executable, killProcessTree, resolveCodexBinary, startStallWatchdog } from "./codex-runner.js";
import { canonicalPath, directoryList, transportProvider, writableRoots } from "./run-policy.js";
import { normalizeSessionId } from "./session-lock.js";
import { problem, validateEngineOptions } from "./validation.js";

const sandboxTypes = new Map([["read-only", "readOnly"], ["workspace-write", "workspaceWrite"], ["danger-full-access", "dangerFullAccess"]]);
const approvals = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval"]);
const deltas = new Set(["item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/commandExecution/outputDelta"]);
const configKeys = new Set(["model_verbosity", "model_reasoning_summary"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function prepareAppServerTurn(options) {
  validateEngineOptions(options);
  if (options.worktree || (options.profile !== undefined && (typeof options.profile !== "string" || options.profile.trim()))) {
    throw problem(400, "app_server does not support worktree or profile yet. Use the exec engine.");
  }
  const cwd = canonicalPath(path.resolve(options.cwd || "."));
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw problem(400, "Invalid cwd: " + cwd);
  if (options.skipGitRepoCheck === false) {
    let dir = cwd;
    while (!fs.existsSync(path.join(dir, ".git"))) {
      const parent = path.dirname(dir);
      if (dir === parent) throw problem(400, "No .git repository in cwd or its ancestors.");
      dir = parent;
    }
  }
  const args = ["app-server", "--stdio"];
  if (options.config !== undefined && !Array.isArray(options.config)) throw problem(400, "config must be an array.");
  for (const entry of options.config || []) {
    const key = typeof entry === "string" && /^\s*([a-z_]+)\s*=/.exec(entry)?.[1];
    if (!configKeys.has(key) || /[\r\n\0]/.test(entry)) throw problem(400, "Unsupported or controlled app_server config key: " + (key || "(invalid)"));
    args.push("-c", entry);
  }
  const transport = transportProvider(options.transport);
  const modelProvider = options.modelProvider ?? options.effectiveProvider ?? transport;
  if (modelProvider !== undefined && (typeof modelProvider !== "string" || !modelProvider.trim() || (transport && transport !== modelProvider))) {
    throw problem(400, "Conflicting or invalid model provider.");
  }
  if (modelProvider) args.push("-c", "model_provider=" + JSON.stringify(modelProvider));
  if (options.disableDesktopNotify !== false) args.push("-c", "notify=[]");
  const sandbox = options.sandbox ?? "workspace-write";
  const type = sandboxTypes.get(sandbox);
  if (!type) throw problem(400, "Invalid sandbox: " + sandbox);
  const sandboxPolicy = { type };
  if (type !== "dangerFullAccess") sandboxPolicy.networkAccess = false;
  if (type === "workspaceWrite") Object.assign(sandboxPolicy, {
    writableRoots: writableRoots(cwd, directoryList(options.addDirs ?? [], cwd)), excludeTmpdirEnvVar: true, excludeSlashTmp: true,
  });
  const input = [{ type: "text", text: options.prompt || "", text_elements: [] }];
  if (options.images !== undefined && !Array.isArray(options.images)) throw problem(400, "images must be an array.");
  for (const img of options.images || []) {
    const file = typeof img === "string" && img.trim() && path.resolve(cwd, img);
    if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw problem(400, "Image must be a regular file: " + img);
    input.push({ type: "localImage", path: file });
  }
  let outputSchema;
  if (options.outputSchema !== undefined) {
    try {
      outputSchema = JSON.parse(fs.readFileSync(path.resolve(cwd, options.outputSchema), "utf8"));
      if (!object(outputSchema)) throw new Error("expected a JSON object");
    } catch (err) { throw problem(400, "Invalid outputSchema: " + err.message); }
  }
  const mode = options.mode ?? "run";
  if (!["run", "resume"].includes(mode)) throw problem(400, "Unsupported app_server mode.");
  const target = mode === "resume" ? normalizeSessionId(options.sessionId) : null;
  return { args, cwd, sandbox, sandboxPolicy, modelProvider, input, outputSchema, target };
}

function verifyThread(response, prepared) {
  const { target, cwd, sandbox, sandboxPolicy, modelProvider } = prepared;
  const sessionId = normalizeSessionId(response?.thread?.id);
  if (target && sessionId !== target) throw new Error("Unexpected resumed session UUID.");
  for (const fields of [response, response.thread]) {
    if (fields.cwd !== undefined && (!path.isAbsolute(fields.cwd) || path.relative(canonicalPath(fields.cwd), cwd))) throw new Error("Thread cwd differs from approved cwd.");
    if (fields.approvalPolicy !== undefined && fields.approvalPolicy !== "never") throw new Error("Thread approvalPolicy differs from never.");
    if (modelProvider && fields.modelProvider !== undefined && fields.modelProvider !== modelProvider) throw new Error("Resume with the original model provider: " + fields.modelProvider);
    const policy = fields.sandbox;
    if (policy === undefined) continue;
    if (typeof policy === "string" ? policy !== sandbox : policy?.type !== sandboxPolicy.type) {
      throw new Error(`Thread sandbox differs from approved sandbox (requested ${sandbox}, received ${policy?.type ?? policy}).`);
    }
    if (!object(policy)) continue;
    if (sandbox !== "danger-full-access" && policy.networkAccess === true) throw new Error("Unapproved sandbox network access.");
    if (policy.writableRoots !== undefined && (!Array.isArray(policy.writableRoots) ||
      policy.writableRoots.some(dir => !path.isAbsolute(dir) || !sandboxPolicy.writableRoots?.some(root => !path.relative(root, canonicalPath(dir)))))) {
      throw new Error("Unapproved sandbox writable roots.");
    }
    if (sandbox === "workspace-write" && (policy.excludeTmpdirEnvVar === false || policy.excludeSlashTmp === false)) throw new Error("Unapproved sandbox temporary write roots.");
  }
  return { sessionId, effectiveProvider: response.modelProvider ?? response.thread.modelProvider ?? modelProvider ?? null };
}

export async function runAppServerTurn(options, prepared = prepareAppServerTurn(options)) {
  if (options.signal?.aborted) throw new Error("Cancelled before spawn");
  const binary = resolveCodexBinary();
  if (!binary) throw new Error("Could not locate codex executable. Set CODEX_BIN or add codex to PATH.");
  const { args, cwd, sandbox, sandboxPolicy, modelProvider, input, outputSchema, target } = prepared;
  const startedAt = Date.now();
  const [bin, argv] = executable(binary.path, args);
  const child = spawn(bin, argv, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  const state = {
    sessionId: target, messages: [], commands: [], fileChanges: [], errors: [], warnings: [], usage: null, stderr: "",
    timedOut: false, stalled: false, stallReason: null, stallKind: null, cancelled: false, silenceWarning: false,
    phase: "waiting_api", activeCommands: 0, activeTools: 0, reconnectCount: 0, reconnectingSince: null,
    lastEventMs: startedAt, lastProgressAt: new Date(startedAt).toISOString(), eventCount: 0, recentEvents: [],
  };
  const trackCommand = activityTracker(), trackTool = activityTracker();
  let activeTurnId = null, acceptedId = null, startingTurn = false, terminal = false, ending = false, spawned = false;
  let nextId = 1, interruptTimer, cleanupTimer, taskTimer, stallTimer, handshakeError;
  let lastReport = 0, stopReason = null, nativeGoal = null;
  const pending = new Map();
  const closed = new Promise(resolve => child.once("close", (exitCode, signal) => {
    ending = true;
    for (const request of pending.values()) request.reject(new Error("app_server closed during " + request.method));
    pending.clear();
    resolve({ exitCode, signal });
  }));
  function kill() {
    if (killProcessTree(child) === false) cleanupTimer = setTimeout(kill, 250);
  }
  function end(force = false) {
    if (ending) return;
    ending = true;
    clearTimeout(interruptTimer);
    if (force) kill();
    else {
      child.stdin.end();
      cleanupTimer = setTimeout(kill, 1500);
    }
  }
  function fail(err) {
    if (ending) return;
    state.errors.push(err.message);
    end(true);
  }
  const write = msg => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  function rpc(method, params, onResult) {
    return new Promise((resolve, reject) => {
      if (ending) return reject(new Error("app_server closed before " + method));
      const id = nextId++;
      pending.set(id, { method, resolve, reject, onResult });
      write({ id, method, params });
    });
  }
  function report(summary, event) {
    lastReport = Date.now();
    state.recentEvents.push({ at: new Date(lastReport).toISOString(), summary });
    if (state.recentEvents.length > 40) state.recentEvents.shift();
    const { eventCount, sessionId, phase, activeCommands, activeTools, reconnectCount, lastProgressAt, silenceWarning, stallKind } = state;
    options.onProgress?.({ summary, event, eventCount, sessionId, usage: state.usage, phase, activeCommands, activeTools, reconnectCount, lastProgressAt, silenceWarning, stallKind });
  }
  function stop(reason) {
    if (ending || stopReason) return;
    stopReason = reason;
    if (!state.errors.includes(reason)) state.errors.push(reason);
    if (!activeTurnId) return end(true);
    rpc("turn/interrupt", { threadId: state.sessionId, turnId: activeTurnId }).catch(() => {});
    interruptTimer = setTimeout(() => end(true), 1500);
  }
  function interrupt() {
    if (!ending) state.cancelled = true;
    stop("Cancelled by caller");
  }
  function serverRequest({ method, id }) {
    if (approvals.has(method)) {
      state.warnings.push("Declined " + method);
      return write({ id, result: { decision: "decline" } });
    }
    if (method === "item/permissions/requestApproval") return write({ id, result: { permissions: {}, scope: "turn" } });
    if (method === "mcpServer/elicitation/request") return write({ id, result: { action: "decline", content: null } });
    if (method === "item/tool/requestUserInput") {
      const message = "Manual input required. Resume after a human decision.";
      write({ id, error: { code: -32000, message } });
      return stop(message);
    }
    write({ id, error: { code: -32601, message: "Method not found: " + method } });
  }
  function accept(id) {
    if (typeof id !== "string" || !id) throw new Error("Missing turn ID.");
    if (acceptedId && acceptedId !== id) throw new Error("Unexpected turn/start ID.");
    if (acceptedId) return;
    acceptedId = activeTurnId = id;
    state.lastEventMs = Date.now();
    options.onTurnAccepted?.({ turnId: id, sessionId: state.sessionId });
  }
  let usageBaseline;
  function tokens({ total, last }) {
    if (!total || !last) return;
    // Subtract the thread's usage before this turn, including on a resumed thread.
    usageBaseline ??= Object.fromEntries(Object.keys(total).map(key => [key, total[key] - (last[key] || 0)]));
    state.usage ??= {};
    for (const [key, field] of [["input_tokens", "inputTokens"], ["cached_input_tokens", "cachedInputTokens"], ["output_tokens", "outputTokens"], ["total_tokens", "totalTokens"]]) {
      state.usage[key] = Math.max(0, (total[field] || 0) - (usageBaseline[field] || 0));
    }
    if (options.tokenBudget > 0 && state.usage.total_tokens >= options.tokenBudget) stop("Turn token budget reached.");
  }
  // With native goals enabled, another turn may start on this thread. Wait for
  // the response ID in that case. In isolated single-turn mode, started is an ACK.
  const earlyEvents = [];
  function notification(method, params) {
    if (!state.sessionId || params?.threadId !== state.sessionId || !startingTurn || terminal) return;
    const id = params.turn?.id ?? params.turnId;
    if (!acceptedId && method === "turn/started" && !options.nativeGoalSync) confirmTurn(id);
    if (!acceptedId) {
      earlyEvents.push([method, params]);
      return;
    }
    if (options.nativeGoalSync && (id == null || id === activeTurnId)) {
      if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
        nativeGoal = method === "thread/goal/updated" ? params.goal : null;
        options.onNativeGoal?.(nativeGoal);
        return;
      }
    }
    if (!activeTurnId || id !== activeTurnId) return;
    const delta = deltas.has(method);
    const before = state.phase;
    const item = params.item;
    const itemEvent = method === "item/started" || method === "item/completed";
    state.eventCount++;
    state.lastEventMs = Date.now();
    if (delta || itemEvent || method === "turn/completed") {
      state.lastProgressAt = new Date(state.lastEventMs).toISOString();
      state.silenceWarning = false;
      state.reconnectCount = 0;
      state.reconnectingSince = null;
    }
    if (itemEvent) {
      const started = method === "item/started";
      if (item.type === "commandExecution") state.activeCommands = trackCommand(item, started);
      if (["webSearch", "mcpToolCall"].includes(item.type)) state.activeTools = trackTool(item, started);
      if (!started && item.type === "agentMessage" && typeof item.text === "string") state.messages.push(item.text);
      if (!started && item.type === "commandExecution") state.commands.push({ command: item.command, exitCode: item.exitCode ?? null,
        status: item.status, outputPreview: item.aggregatedOutput?.slice(0, 500) });
      if (!started && item.type === "fileChange") {
        for (const change of item.changes || []) state.fileChanges.push({ path: change.path, kind: change.kind?.type ?? change.kind });
      }
    } else if (method === "error") {
      const message = params.error?.message || params.message || "app_server error";
      if (params.willRetry || /reconnecting|stream disconnected|connection reset|econnreset/i.test(message)) {
        state.reconnectingSince ??= state.lastEventMs;
        state.reconnectCount++;
        state.warnings.push(message);
      } else state.errors.push(message);
    } else if (method === "thread/tokenUsage/updated") tokens(params.tokenUsage);
    else if (method === "turn/completed") {
      terminal = true;
      activeTurnId = null;
      state.turnCompleted = params.turn.status === "completed";
      if (!state.turnCompleted) {
        state.errors.push(params.turn.error?.message || "Turn " + params.turn.status);
        if (params.turn.status === "interrupted" && !stopReason) state.cancelled = true;
      }
      state.activeCommands = state.activeTools = 0;
    }
    state.phase = terminal && state.turnCompleted ? "completed" : state.activeCommands ? "running_cmd"
      : state.activeTools ? "running_tool" : state.reconnectingSince !== null ? "reconnecting" : "waiting_api";
    if (!delta || before !== state.phase || state.lastEventMs - lastReport >= 1500) {
      report(method + (item?.type ? ": " + item.type : ""), { type: method });
    }
    if (terminal) end();
  }
  function confirmTurn(id) {
    accept(id);
    const queued = earlyEvents.splice(0);
    for (const [method, params] of queued) notification(method, params);
  }
  function route(line) {
    const msg = JSON.parse(line);
    if (!object(msg) || (msg.jsonrpc !== undefined && msg.jsonrpc !== "2.0")) throw new Error("Invalid app_server JSON-RPC frame.");
    if (typeof msg.method === "string") {
      if (msg.id !== undefined) serverRequest(msg);
      else notification(msg.method, msg.params);
    } else if (msg.id !== undefined && msg.method === undefined && Object.hasOwn(msg, "result") !== Object.hasOwn(msg, "error")) {
      const request = pending.get(msg.id);
      if (!request) return;
      pending.delete(msg.id);
      if (!startingTurn) state.lastEventMs = Date.now();
      if (msg.error) {
        const mismatch = msg.error.code === -32600 && msg.error.data?.type === "modelProviderMismatch";
        request.reject(new Error(request.method + ": " + (mismatch ? "Restore the original model provider to resume. " : "") + msg.error.message));
      } else {
        try { request.onResult?.(msg.result); request.resolve(msg.result); }
        catch (err) { request.reject(err); throw err; }
      }
    } else throw new Error("Invalid app_server JSON-RPC message.");
  }
  let buffer = "", totalBytes = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    if (ending) return;
    try {
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > 16 * 1024 * 1024) throw new Error("Output limit exceeded.");
      buffer += chunk;
      let offset;
      while (!ending && (offset = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, offset);
        buffer = buffer.slice(offset + 1);
        if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error("NDJSON line limit exceeded.");
        if (line.trim()) route(line);
      }
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) throw new Error("NDJSON line limit exceeded.");
    } catch (err) { fail(err); }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { state.stderr += chunk.slice(0, 32000 - state.stderr.length); });
  child.stdin.on("error", fail);
  child.on("error", fail);
  child.once("spawn", async () => {
    try {
      if (ending) return;
      options.onSpawn?.(child, { args });
      spawned = true;
      state.lastEventMs = Date.now();
      options.onControlReady?.({
        interrupt, getActiveTurnId: () => activeTurnId,
        sendSteer(expectedTurnId, text) {
          // Preserve the original single-argument, in-process control handle.
          if (arguments.length === 1) { text = expectedTurnId; expectedTurnId = activeTurnId; }
          if (!activeTurnId || expectedTurnId !== activeTurnId || stopReason || ending) {
            return Promise.reject(new Error("No matching active turn to steer."));
          }
          return rpc("turn/steer", { threadId: state.sessionId, expectedTurnId, input: [{ type: "text", text }] });
        },
      });
      await rpc("initialize", { clientInfo: { name: "codex-bridge", title: "Codex Bridge", version: "1.8.0" } });
      write({ method: "initialized" });
      const params = { cwd, model: options.model || undefined, modelProvider, sandbox, approvalPolicy: "never" };
      if (sandboxPolicy.type === "workspaceWrite") params.config = { sandbox_workspace_write: {
        writable_roots: sandboxPolicy.writableRoots, network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true,
      } };
      const response = target ? await rpc("thread/resume", { ...params, threadId: target, excludeTurns: true })
        : await rpc("thread/start", { ...params, ephemeral: options.ephemeral ?? false });
      const thread = verifyThread(response, prepared);
      state.sessionId = thread.sessionId;
      if (target) {
        const result = await rpc("thread/goal/get", { threadId: target });
        if (!Object.hasOwn(result, "goal") || (result.goal !== null && typeof result.goal?.status !== "string")) throw new Error("Cannot verify native goal state.");
        nativeGoal = result.goal;
        options.onNativeGoal?.(nativeGoal);
        if (nativeGoal?.status === "active" && !options.nativeGoalSync) throw new Error("Active native Goal: single-turn resume refused. The original Goal is preserved.");
      }
      await options.onThreadReady?.({ ...thread, child });
      if (ending) return;
      startingTurn = true;
      state.lastEventMs = Date.now();
      await rpc("turn/start", { threadId: state.sessionId, model: params.model, effort: options.reasoningEffort || undefined,
        cwd, approvalPolicy: "never", sandboxPolicy, outputSchema, input }, result => confirmTurn(result.turn?.id));
    } catch (err) {
      if (!ending) {
        if (!startingTurn) handshakeError = err;
        fail(err);
      }
    }
  });
  options.signal?.addEventListener("abort", interrupt, { once: true });
  const timeoutMs = options.timeoutMs ?? 600000;
  function deadline() {
    const left = startedAt + timeoutMs - Date.now();
    if (left > 0) taskTimer = setTimeout(deadline, Math.min(left, 2147483647));
    else { state.timedOut = true; stop("Task timed out."); }
  }
  if (timeoutMs > 0) deadline();
  stallTimer = startStallWatchdog(state, options, (...args) => {
    try { report(...args); } catch (err) { fail(err); }
  }, () => stop(state.stallReason), () => !spawned || ending || stopReason);
  const exit = await closed;
  clearTimeout(taskTimer);
  clearInterval(stallTimer);
  clearTimeout(interruptTimer);
  clearTimeout(cleanupTimer);
  options.signal?.removeEventListener("abort", interrupt);
  activeTurnId = null;
  if (handshakeError) throw handshakeError;
  if (!terminal && !state.errors.length) state.errors.push("Stream ended without turn/completed.");
  const { lastEventMs, turnCompleted, ...result } = state;
  return { ...result, ...exit, ok: Boolean(turnCompleted && !state.errors.length), cwd, sandbox, codexBinary: binary.path,
    cliArgs: args, durationMs: Date.now() - startedAt, lastMessage: state.messages.at(-1) || "", stderr: state.stderr.trim() };
}
