import { problem } from "./validation.js";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { normalizeSessionId } from "./session-lock.js";
import { readCodexTomlDefaults } from "./settings-store.js";
import { isPidAlive, matchesProcess, processIdentity, windowsPowerShell } from "./process-identity.js";

const IS_WINDOWS = process.platform === "win32";

export const SANDBOX_RANK = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

/**
 * Validate sandbox permission transitions when resuming a prior session/job.
 * - Defaults to preserving originalSandbox when requestedSandbox is omitted.
 * - Tightening permissions is always allowed.
 * - Widening permissions requires explicit allowEscalation === true.
 */
export function resolveResumeSandbox({
  requestedSandbox,
  originalSandbox,
  allowEscalation = false,
} = {}) {
  if (typeof allowEscalation !== "boolean") throw problem(400, "allow_sandbox_escalation must be boolean.");
  const orig =
    originalSandbox && Object.hasOwn(SANDBOX_RANK, originalSandbox)
      ? originalSandbox
      : "read-only";

  if (!requestedSandbox) {
    return orig;
  }

  if (!Object.hasOwn(SANDBOX_RANK, requestedSandbox)) {
    throw problem(400, `Invalid sandbox mode: ${requestedSandbox}`);
  }

  if (
    SANDBOX_RANK[requestedSandbox] > SANDBOX_RANK[orig] &&
    !allowEscalation
  ) {
    throw problem(400,
      `Refusing to widen sandbox on resume from '${orig}' to '${requestedSandbox}'. Pass allow_sandbox_escalation=true to explicitly confirm.`
    );
  }

  return requestedSandbox;
}

/**
 * Resolve the Codex CLI binary path.
 * Priority:
 *   1. CODEX_BIN environment variable
 *   2. `codex` on PATH
 *   3. Newest `codex.exe` bundled with Codex Desktop under %LOCALAPPDATA%\OpenAI\Codex\bin\*
 */
const discovery = new Map();
const versions = new Map();
const reviewSupport = new Map();

function entry(file, source) {
  if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  if (/\.(cmd|bat)$/i.test(file)) {
    const dir = path.dirname(file);
    const candidates = ["codex.exe", "codex.js", "codex.cjs", "codex.mjs",
      "node_modules/@openai/codex/bin/codex.js", "../@openai/codex/bin/codex.js"];
    for (const relative of candidates) {
      const candidate = path.resolve(dir, relative);
      const direct = entry(candidate, source);
      if (direct) return direct;
    }
    return null;
  }
  if (IS_WINDOWS && !/\.(exe|[cm]?js)$/i.test(file)) return null;
  return { path: path.resolve(file), source };
}

export function resolveCodexBinary(refresh = false) {
  const key = process.env.CODEX_BIN?.trim() || "";
  if (!refresh && discovery.has(key)) return discovery.get(key);
  let found = entry(key, "CODEX_BIN");
  if (!found && !key) {
    try {
      const paths = execFileSync(IS_WINDOWS ? "where.exe" : "which", ["codex"], { encoding: "utf8", timeout: 2000, windowsHide: true, stdio: ["ignore","pipe","ignore"] });
      found = paths.trim().split(/\r?\n/).map(p => entry(p, "PATH")).find(Boolean);
    } catch { /* Try the desktop bundle. */ }
    if (!found && IS_WINDOWS) {
      const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
      if (fs.existsSync(dir)) found = fs.readdirSync(dir).map(n => entry(path.join(dir, n, "codex.exe"), "Codex Desktop bundle"))
        .filter(Boolean).sort((a,b) => fs.statSync(b.path).mtimeMs - fs.statSync(a.path).mtimeMs)[0];
    }
  }
  discovery.set(key, found || null);
  return found || null;
}

export function executable(file, args) {
  return /\.[cm]?js$/i.test(file) ? [process.execPath, [file, ...args]] : [file, args];
}

function probe(file, args) {
  const [bin, argv] = executable(file, args);
  return execFileSync(bin, argv, { encoding: "utf8", windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export function getCodexVersion(file, refresh = false) {
  if (refresh || !versions.has(file)) {
    try { versions.set(file, probe(file, ["--version"])); }
    catch { versions.set(file, "unknown"); }
  }
  return versions.get(file);
}

function supportsReviewSandbox(file) {
  if (!reviewSupport.has(file)) {
    try { reviewSupport.set(file, /exec review/i.test(probe(file, ["exec", "-s", "read-only", "review", "--help"]))); }
    catch { reviewSupport.set(file, false); }
  }
  return reviewSupport.get(file);
}

export function killPidTree(pid, identity) {
  if (!identity || identity.pid !== pid || !/^(node(js)?|codex)(\.exe)?$/i.test(identity.name)) return false;
  if (!matchesProcess(identity, processIdentity(pid))) return false;
  try {
    if (IS_WINDOWS) {
      // Hold an OS handle across verification and taskkill so this PID cannot be recycled in between.
      const script = [
        "$ErrorActionPreference='Stop'",
        "$p=Get-Process -Id ([int]$env:BRIDGE_STOP_PID)",
        "$null=$p.Handle",
        "if ($p.StartTime.ToUniversalTime().Ticks.ToString() -ne $env:BRIDGE_STOP_TIME -or $p.ProcessName -ne $env:BRIDGE_STOP_NAME){exit 2}",
        "& (Join-Path $env:SystemRoot 'System32/taskkill.exe') /PID $p.Id /T /F",
        "$code=$LASTEXITCODE", "$p.Dispose()", "exit $code"
      ].join(";");
      execFileSync(windowsPowerShell, ["-NoProfile","-NonInteractive","-Command",script], {
        stdio: "ignore", windowsHide: true, timeout: 5000,
        env: { ...process.env, BRIDGE_STOP_PID: String(pid), BRIDGE_STOP_TIME: identity.started, BRIDGE_STOP_NAME: identity.name }
      });
    }
    else process.kill(-pid, "SIGKILL");
    return true;
  } catch { return !isPidAlive(pid); }
}

export function killProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  if (IS_WINDOWS) {
    // The live ChildProcess handle pins the Windows process object while owned here.
    try { execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 }); }
    catch { return !isPidAlive(child.pid); }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { return !isPidAlive(child.pid); }
  }
}

const effortConfigKey = /^\s*model_reasoning_effort\s*=/;

export function effectiveExecProvider(options) {
  if (options.modelProvider) return options.modelProvider;
  if (options.transport === "websocket") return "openai";
  if (options.transport === "http") return "openai_http";
  if (Array.isArray(options.config)) {
    for (const value of [...options.config].reverse()) {
      const match = typeof value === "string" && /^\s*model_provider\s*=\s*["']?([\w.-]+)["']?\s*$/.exec(value);
      if (match) return match[1];
    }
  }
  return options.profile ? null : readCodexTomlDefaults().modelProvider;
}

export function effectiveReasoningEffort(options, fallback = "") {
  // Codex applies the last explicit -c assignment ahead of bridge preferences.
  if (Array.isArray(options.config)) {
    for (let i = options.config.length - 1; i >= 0; i--) {
      const entry = options.config[i];
      if (typeof entry === "string" && effortConfigKey.test(entry)) {
        return entry.replace(effortConfigKey, "").trim().replace(/^["']|["']$/g, "");
      }
    }
  }
  return options.reasoningEffort || fallback;
}

function appendCommonConfigArgs(args, opts, { allowProfile = true } = {}) {
  if (opts.model) {
    args.push("-m", String(opts.model));
  }
  if (allowProfile && opts.profile) {
    args.push("-p", String(opts.profile));
  }
  const configList = Array.isArray(opts.config) ? [...opts.config] : [];
  const provider = opts.modelProvider || { websocket: "openai", http: "openai_http" }[opts.transport];
  if (provider) configList.push("model_provider=" + JSON.stringify(provider));
  if (opts.disableDesktopNotify !== false && !configList.some(kv => typeof kv === "string" && /^\s*notify\s*=/.test(kv))) {
    configList.push("notify=[]");
  }
  if (
    opts.reasoningEffort &&
    !configList.some(
      (kv) =>
        typeof kv === "string" && effortConfigKey.test(kv)
    )
  ) {
    configList.push(
      `model_reasoning_effort="${String(opts.reasoningEffort).trim()}"`
    );
  }
  for (const kv of configList) {
    if (typeof kv === "string" && kv.trim()) {
      args.push("-c", kv.trim());
    }
  }
  if (Array.isArray(opts.images)) {
    for (const img of opts.images) {
      if (typeof img === "string" && img.trim()) {
        args.push("-i", img.trim());
      }
    }
  }
  if (opts.ephemeral) {
    args.push("--ephemeral");
  }
  if (opts.worktree) {
    args.push("--worktree");
  }
  if (opts.skipGitRepoCheck !== false) {
    args.push("--skip-git-repo-check");
  }
  if (opts.dangerouslyBypassSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (opts.outputSchema) {
    args.push("--output-schema", String(opts.outputSchema));
  }
}

export function buildCodexArgs(mode, opts) {
  const args = ["exec"];

  if (mode === "run") {
    args.push("--json");
    if (opts.cwd) {
      args.push("-C", opts.cwd);
    }
    const sandbox = opts.sandbox || "workspace-write";
    if (!opts.dangerouslyBypassSandbox) {
      args.push("-s", sandbox);
    }
    if (Array.isArray(opts.addDirs)) {
      for (const dir of opts.addDirs) {
        if (typeof dir === "string" && dir.trim()) {
          args.push("--add-dir", dir.trim());
        }
      }
    }
    appendCommonConfigArgs(args, opts, { allowProfile: true });
    args.push("-");
    return { args, stdinPrompt: opts.prompt || "" };
  }

  if (mode === "resume") {
    const sid = normalizeSessionId(opts.sessionId);
    // IMPORTANT: Codex CLI requires -C / --cd and -s / --sandbox BEFORE the `resume` subcommand.
    if (opts.cwd) {
      args.push("-C", opts.cwd);
    }
    const sandbox = opts.sandbox || "workspace-write";
    if (!opts.dangerouslyBypassSandbox) {
      args.push("-s", sandbox);
    }
    if (Array.isArray(opts.addDirs)) {
      for (const dir of opts.addDirs) {
        if (typeof dir === "string" && dir.trim()) {
          args.push("--add-dir", dir.trim());
        }
      }
    }
    args.push("resume", "--json");
    appendCommonConfigArgs(args, opts, { allowProfile: false });
    args.push(sid);
    args.push("-");
    return { args, stdinPrompt: opts.prompt || "" };
  }

  if (mode === "review") {
    if (opts.cwd) {
      args.push("-C", opts.cwd);
    }
    if (opts.sandbox && opts.sandbox !== "cli-default") args.push("-s", opts.sandbox);
    args.push("review", "--json");
    if (opts.uncommitted) {
      args.push("--uncommitted");
    } else if (opts.base) {
      args.push("--base", String(opts.base));
    } else if (opts.commit) {
      args.push("--commit", String(opts.commit));
    }
    if (opts.title) {
      args.push("--title", String(opts.title));
    }
    appendCommonConfigArgs(args, { ...opts, skipGitRepoCheck: false }, { allowProfile: false });
    if (opts.prompt && opts.prompt.trim()) {
      args.push("-");
      return { args, stdinPrompt: opts.prompt };
    }
    return { args, stdinPrompt: null };
  }

  throw new Error(`Unsupported Codex mode: ${mode}`);
}

function summarizeEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  const type = evt.type || "unknown";

  if (type === "thread.started") {
    return `Session started (${evt.thread_id || "unknown"})`;
  }
  if (type === "turn.started") {
    return "Turn started";
  }
  if (type === "turn.completed") {
    return "Turn completed";
  }
  if (type === "turn.failed" || type === "error") {
    const msg = evt.error?.message || evt.message || JSON.stringify(evt);
    return `Error: ${msg}`;
  }
  if (type === "item.started" || type === "item.completed") {
    const item = evt.item || {};
    const itemType = item.type || "item";
    if (itemType === "command_execution") {
      const cmd = item.command || "";
      const preview = cmd.length > 80 ? `${cmd.slice(0, 80)}...` : cmd;
      return type === "item.started"
        ? `Running command: ${preview}`
        : `Command finished (exit ${item.exit_code ?? "?"}): ${preview}`;
    }
    if (itemType === "file_change") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((c) => c.path).filter(Boolean).join(", ");
      return `File change: ${paths || "updated files"}`;
    }
    if (itemType === "agent_message") {
      const text = (item.text || "").replace(/\s+/g, " ").trim();
      const preview = text.length > 100 ? `${text.slice(0, 100)}...` : text;
      return `Codex: ${preview}`;
    }
    if (itemType === "reasoning") {
      return "Codex is reasoning...";
    }
    if (itemType === "mcp_tool_call") {
      return `MCP tool call: ${item.server || ""}/${item.tool || ""}`;
    }
    return `${type}: ${itemType}`;
  }
  return type;
}

const RECOVERABLE_ERROR_RE =
  /reconnecting|stream disconnected|retrying|temporarily unavailable|connection reset|econnreset/i;
const RECONNECT_ERROR_RE = /reconnecting|stream disconnected|connection reset|econnreset/i;
const LONG_TOOL_TYPES = new Set(["web_search", "mcp_tool_call", "tool_call", "file_search", "code_interpreter"]);

export function effortSilenceMultiplier(effort) {
  switch (effort) {
    case "low":
    case "medium": return 1;
    case "xhigh": return 3;
    case "max":
    case "ultra": return 5;
    default: return 2; // high or inherited/unknown effort
  }
}

// A replayed start (even after completion) must never create a phantom active item.
export function activityTracker() {
  const active = new Set();
  const completed = new Set();
  const anonymous = new Map();
  return (item, started) => {
    if (item.id == null || item.id === "") {
      const count = anonymous.get(item.type) || 0;
      anonymous.set(item.type, Math.max(0, count + (started ? 1 : -1)));
    } else if (!started) {
      active.delete(item.id);
      completed.add(item.id);
    } else if (!completed.has(item.id)) {
      active.add(item.id);
    }
    let count = active.size;
    for (const value of anonymous.values()) count += value;
    return count;
  };
}

export function startStallWatchdog(state, { stallPolicy = "reconnect_only", stallTimeoutMs = 0, reconnectStallMs = 0, reasoningEffort }, notifyProgress, terminate, inactive) {
  const effectiveSilenceMs = stallTimeoutMs * effortSilenceMultiplier(reasoningEffort);
  if (stallPolicy === "off" || !(reconnectStallMs > 0 || stallTimeoutMs > 0)) return null;
  const shortest = Math.min(...[stallTimeoutMs, reconnectStallMs].filter(ms => ms > 0));
  const checkEvery = Math.min(5000, Math.max(40, Math.floor(shortest / 4)));
  const stallTimer = setInterval(() => {
    if (state.turnCompleted || state.cancelled || state.timedOut || state.stalled || inactive()) return;
    if (state.activeCommands > 0 || state.activeTools > 0) return;
    const now = Date.now();
    const silentMs = now - state.lastEventMs;
    if (state.phase === "reconnecting" && reconnectStallMs > 0 && now - state.reconnectingSince >= reconnectStallMs) {
      state.stallKind = "reconnect";
      state.stallReason = `Stuck reconnecting for ${Math.round((now - state.reconnectingSince) / 1000)}s (${state.reconnectCount} retries)`;
    } else if (state.phase === "waiting_api" && stallPolicy === "always" && effectiveSilenceMs > 0 && silentMs >= effectiveSilenceMs) {
      state.stallKind = "zero_error_silence";
      state.stallReason = `Upstream API silent for ${Math.round(silentMs / 1000)}s while waiting for response`;
    } else {
      if (state.phase === "waiting_api" && stallPolicy === "reconnect_only" && stallTimeoutMs > 0 && silentMs >= stallTimeoutMs && !state.silenceWarning) {
        state.silenceWarning = true;
        notifyProgress("Silence warning while waiting for API response");
      }
      return;
    }
    state.stalled = true;
    state.errors.push(state.stallReason);
    notifyProgress(state.stallReason);
    terminate();
  }, checkEvery);
  stallTimer.unref();
  return stallTimer;
}

export function evaluateRunOutcome({
  exitCode,
  timedOut,
  stalled = false,
  cancelled,
  turnCompleted,
  turnFailed,
  errors = [],
  warnings = [],
}) {
  const finalErrors = [...errors];
  const finalWarnings = [...warnings];

  if (timedOut || stalled || cancelled || turnFailed) {
    return { ok: false, errors: finalErrors, warnings: finalWarnings };
  }

  if (turnCompleted) {
    if (finalErrors.length > 0) {
      for (const e of finalErrors) {
        finalWarnings.push(`Recovered before turn.completed: ${e}`);
      }
      finalErrors.length = 0;
    }
    if (exitCode !== 0 && exitCode !== null) {
      finalWarnings.push(
        `Process exited with code ${exitCode} after turn.completed`
      );
    }
    return { ok: true, errors: finalErrors, warnings: finalWarnings };
  }

  finalErrors.push("Stream ended without turn.completed");
  return { ok: false, errors: finalErrors, warnings: finalWarnings };
}

export function runCodex(options) {
  if (options.signal?.aborted) return Promise.reject(new Error("Cancelled before spawn"));
  const resolved = resolveCodexBinary();
  if (!resolved) {
    return Promise.reject(
      new Error(
        "Could not locate codex executable. Set CODEX_BIN env var or add codex to PATH."
      )
    );
  }

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  if (!fs.existsSync(cwd)) {
    return Promise.reject(new Error(`Working directory does not exist: ${cwd}`));
  }

  if (options.mode === "review") options = { ...options, sandbox: supportsReviewSandbox(resolved.path) ? options.sandbox || "read-only" : "cli-default" };
  let built;
  try {
    built = buildCodexArgs(options.mode, { ...options, cwd });
  } catch (err) {
    return Promise.reject(err);
  }
  const { args, stdinPrompt } = built;

  const timeoutMs = options.timeoutMs === undefined ? 600_000 : options.timeoutMs;
  const graceMs = options.postTurnGraceMs ?? 5000;
  const stallTimeoutMs = typeof options.stallTimeoutMs === "number" && options.stallTimeoutMs > 0 ? options.stallTimeoutMs : 0;
  const reconnectStallMs = options.reconnectStallMs ?? 0;
  const stallPolicy = options.stallPolicy ?? "reconnect_only";

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const [spawnCmd, spawnArgs] = executable(resolved.path, args);
    const child = spawn(spawnCmd, spawnArgs, { cwd, env: { ...process.env },
      detached: !IS_WINDOWS, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const state = {
      sessionId: options.sessionId && options.sessionId !== "last" ? options.sessionId : null,
      messages: [],
      commands: [],
      fileChanges: [],
      errors: [],
      warnings: [],
      turnCompleted: false,
      turnFailed: false,
      usage: null,
      eventCount: 0,
      recentEvents: [],
      stderr: "",
      timedOut: false,
      stalled: false,
      stallKind: null,
      stallReason: null,
      silenceWarning: false,
      lastProgressAt: new Date(startedAt).toISOString(),
      cancelled: false,
      phase: "waiting_api",
      activeCommands: 0,
      activeTools: 0,
      reconnectCount: 0,
      reconnectingSince: null,
      lastEventMs: startedAt,
    };

    let trackCommand = activityTracker();
    let trackTool = activityTracker();
    let stdoutBuffer = "";
    let totalBytes = 0;
    let protocolFailure = null;
    let terminationTimer;
    let graceTimer;
    let stallTimer = null;
    let cleanedUpTail = false;
    function terminate() {
      if (child.exitCode !== null || child.signalCode) return;
      if (killProcessTree(child) === false && !terminationTimer) {
        terminationTimer = setTimeout(() => { terminationTimer = null; terminate(); }, 1000);
        terminationTimer.unref();
      }
    }
    const maxLine = 2 * 1024 * 1024;
    const maxOutput = 16 * 1024 * 1024;
    function failStream(reason) {
      if (protocolFailure) return;
      protocolFailure = reason;
      state.errors.push(reason);
      state.turnFailed = true;
      terminate();
    }

    const pushRecentEvent = (summary) => {
      if (!summary) return;
      state.recentEvents.push({
        at: new Date().toISOString(),
        summary,
      });
      if (state.recentEvents.length > 40) {
        state.recentEvents.shift();
      }
    };

    function watchdogState() {
      return {
        phase: state.phase,
        activeCommands: state.activeCommands,
        activeTools: state.activeTools,
        reconnectCount: state.reconnectCount,
        reconnectingSince: state.reconnectingSince,
        lastProgressAt: state.lastProgressAt,
        stallKind: state.stallKind,
        silenceWarning: state.silenceWarning,
      };
    }

    function notifyProgress(summary, event) {
      pushRecentEvent(summary);
      try {
        options.onProgress?.({ eventCount: state.eventCount, sessionId: state.sessionId,
          summary, event, ...watchdogState() });
      } catch (err) { failStream("Progress bookkeeping failed: " + err.message); }
    }

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        failStream("Invalid NDJSON on stdout");
        return;
      }

      if (!evt || typeof evt !== "object" || typeof evt.type !== "string" ||
          (evt.item && typeof evt.item !== "object")) return failStream("Invalid event object");
      if (state.eventCount >= 50000) return failStream("Event limit exceeded");
      if (evt.type === "turn.started") {
        if (state.turnCompleted && graceMs > 0) startTaskTimer();
        clearTimeout(graceTimer);
        state.turnCompleted = false;
      }
      if (state.turnCompleted && (evt.type === "error" || evt.type === "turn.failed")) {
        state.turnFailed = true;
      }
      state.eventCount += 1;
      state.lastEventMs = Date.now();

      const itemEvent = (evt.type === "item.started" || evt.type === "item.completed") && evt.item;
      if (itemEvent || evt.type === "turn.completed") {
        state.lastProgressAt = new Date(state.lastEventMs).toISOString();
        state.silenceWarning = false;
        state.reconnectingSince = null;
        state.reconnectCount = 0;
      }
      if (itemEvent) {
        const started = evt.type === "item.started";
        if (evt.item.type === "command_execution") state.activeCommands = trackCommand(evt.item, started);
        if (LONG_TOOL_TYPES.has(evt.item.type)) state.activeTools = trackTool(evt.item, started);
      }
      if (evt.type === "thread.started") {
        const sid = normalizeSessionId(evt.thread_id);
        if (options.mode === "resume" && sid !== normalizeSessionId(options.sessionId)) return failStream("Unexpected resumed session UUID");
        state.sessionId = sid;
      } else if (evt.type === "turn.completed") {
        state.turnCompleted = true;
        state.activeCommands = 0;
        state.activeTools = 0;
        trackCommand = activityTracker();
        trackTool = activityTracker();
        clearTimeout(graceTimer);
        if (graceMs > 0) {
          clearTimeout(timer);
          graceTimer = setTimeout(() => {
            if (child.exitCode !== null || child.signalCode) return;
            cleanedUpTail = true;
            terminate();
          }, graceMs);
          graceTimer.unref();
        }
        if (evt.usage) state.usage = evt.usage;
      } else if (evt.type === "turn.failed") {
        state.turnFailed = true;
        const msg =
          evt.error?.message || evt.message || JSON.stringify(evt);
        state.errors.push(msg);
      } else if (evt.type === "error") {
        const msg =
          evt.error?.message || evt.message || JSON.stringify(evt);
        if (RECOVERABLE_ERROR_RE.test(msg)) {
          state.warnings.push(msg);
          if (RECONNECT_ERROR_RE.test(msg)) {
            state.reconnectCount += 1;
            state.reconnectingSince ??= state.lastEventMs;
          }
        } else {
          state.errors.push(msg);
        }
      } else if (evt.type === "item.completed" && evt.item) {
        const item = evt.item;
        if (item.type === "agent_message" && typeof item.text === "string") {
          state.messages.push(item.text);
        } else if (item.type === "command_execution") {
          state.commands.push({
            command: item.command || "",
            exitCode: item.exit_code ?? null,
            status: item.status || "completed",
            outputPreview:
              typeof item.aggregated_output === "string"
                ? item.aggregated_output.slice(0, 500)
                : undefined,
          });
        } else if (item.type === "file_change" && Array.isArray(item.changes)) {
          for (const change of item.changes) {
            state.fileChanges.push({
              path: change.path,
              kind: change.kind || "modified",
            });
          }
        }
      }

      if (state.turnCompleted) state.phase = "completed";
      else if (state.activeCommands > 0) state.phase = "running_cmd";
      else if (state.activeTools > 0) state.phase = "running_tool";
      else state.phase = state.reconnectingSince !== null ? "reconnecting" : "waiting_api";
      notifyProgress(summarizeEvent(evt) || evt.type, evt);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (protocolFailure) return;
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > maxOutput) return failStream("Output limit exceeded");
      stdoutBuffer += chunk;
      let idx;
      while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, idx);
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (Buffer.byteLength(line) > maxLine) return failStream("NDJSON line limit exceeded");
        try { handleLine(line); } catch { return failStream("Invalid event fields"); }
        if (protocolFailure) return;
      }
      if (Buffer.byteLength(stdoutBuffer) > maxLine) failStream("NDJSON line limit exceeded");
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (state.stderr.length < 32_000) {
        state.stderr += chunk;
      }
    });

    let timer = null;
    function startTaskTimer() {
      if (!(timeoutMs > 0)) return;
      const deadline = Date.now() + timeoutMs;
      function schedule(remaining) {
        // Node clamps delays above a signed 32-bit integer to one millisecond.
        timer = setTimeout(() => {
          const left = deadline - Date.now();
          if (left > 0) return schedule(left);
          state.timedOut = true;
          state.errors.push(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
          terminate();
        }, Math.min(remaining, 2_147_483_647));
        timer.unref();
      }
      schedule(timeoutMs);
    }
    startTaskTimer();

    stallTimer = startStallWatchdog(state, { stallPolicy, stallTimeoutMs, reconnectStallMs, reasoningEffort: effectiveReasoningEffort(options) },
      notifyProgress, terminate, () => protocolFailure);

    const onAbort = () => {
      state.cancelled = true;
      state.errors.push("Cancelled by caller");
      terminate();
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (err) => {
      if (child.pid && isPidAlive(child.pid)) { failStream("Codex process error: " + err.message); return; }
      clearTimeout(graceTimer);
      clearInterval(stallTimer);
      clearTimeout(terminationTimer);
      if (timer) clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(terminationTimer);
      clearInterval(stallTimer);
      if (timer) clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      if (!protocolFailure && stdoutBuffer.trim()) {
        try { handleLine(stdoutBuffer); } catch { failStream("Invalid final event"); }
      }

      clearTimeout(graceTimer);
      clearInterval(stallTimer);
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const lastMessage =
        state.messages.length > 0
          ? state.messages[state.messages.length - 1]
          : "";

      const verdict = evaluateRunOutcome({
        exitCode: cleanedUpTail ? null : code,
        timedOut: state.timedOut,
        stalled: state.stalled,
        cancelled: state.cancelled,
        turnCompleted: state.turnCompleted,
        turnFailed: state.turnFailed,
        errors: state.errors,
        warnings: state.warnings,
      });

      resolve({
        ok: verdict.ok,
        exitCode: code,
        signal,
        durationMs,
        codexBinary: resolved.path,
        cliArgs: args,
        cwd,
        sandbox: options.sandbox || "workspace-write",
        sessionId: state.sessionId,
        lastMessage,
        messages: state.messages,
        commands: state.commands,
        fileChanges: state.fileChanges,
        usage: state.usage,
        errors: verdict.errors,
        warnings: verdict.warnings,
        stderr: state.stderr.trim(),
        timedOut: state.timedOut,
        stalled: state.stalled,
        stallReason: state.stallReason,
        ...watchdogState(),
        cancelled: state.cancelled,
        eventCount: state.eventCount,
        recentEvents: state.recentEvents,
      });
    });

    child.stdin.on("error", err => failStream("Codex stdin failed: " + err.message));
    child.once("spawn", () => {
      if (state.cancelled || state.timedOut) { terminate(); return; }
      try {
        options.onSpawn?.(child, { args });
        child.stdin.end(stdinPrompt ?? undefined, "utf8");
        state.lastEventMs = Date.now();
      } catch (err) {
        failStream("Spawn bookkeeping failed: " + err.message);
        child.stdin.end();
      }
    });
  });
}

export function formatCodexResult(result) {
  const sections = [];

  const statusLine = result.ok
    ? "Status: completed"
    : result.cancelled
      ? "Status: cancelled"
      : result.timedOut
        ? "Status: timed_out"
        : `Status: failed (exit code ${result.exitCode})`;

  const meta = [
    statusLine,
    `Session ID: ${result.sessionId || "(none)"}`,
    `Working Dir: ${result.cwd}`,
    `Sandbox: ${result.sandbox || "workspace-write"}`,
    `Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
  ];

  if (result.usage) {
    const u = result.usage;
    meta.push(
      `Tokens: in=${u.input_tokens ?? 0} (cached=${u.cached_input_tokens ?? 0}), out=${u.output_tokens ?? 0}`
    );
  }
  sections.push(meta.join("\n"));

  if (result.lastMessage) {
    sections.push(`## Codex Response\n\n${result.lastMessage}`);
  } else if (result.messages?.length) {
    sections.push(`## Codex Response\n\n${result.messages.join("\n\n")}`);
  }

  if (result.fileChanges?.length) {
    const uniqueFiles = new Map();
    for (const fc of result.fileChanges) {
      uniqueFiles.set(fc.path, fc.kind);
    }
    const list = [...uniqueFiles.entries()]
      .map(([p, k]) => `- [${k}] ${p}`)
      .join("\n");
    sections.push(`## File Changes (${uniqueFiles.size})\n\n${list}`);
  }

  if (result.commands?.length) {
    const list = result.commands
      .map((c) => `- \`${c.command}\` (exit ${c.exitCode ?? "?"})`)
      .join("\n");
    sections.push(`## Commands Executed (${result.commands.length})\n\n${list}`);
  }

  if (result.warnings?.length) {
    sections.push(
      `## Warnings (Non-Fatal)\n\n${result.warnings.map((w) => `- ${w}`).join("\n")}`
    );
  }

  if (result.errors?.length) {
    sections.push(`## Errors\n\n${result.errors.map((e) => `- ${e}`).join("\n")}`);
  }

  if (!result.ok && result.stderr) {
    sections.push(`## Stderr\n\n\`\`\`\n${result.stderr.slice(0, 4000)}\n\`\`\``);
  }

  return sections.join("\n\n");
}
