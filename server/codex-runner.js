import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
  fallbackSandbox = "workspace-write",
  allowEscalation = false,
} = {}) {
  const orig =
    originalSandbox && Object.hasOwn(SANDBOX_RANK, originalSandbox)
      ? originalSandbox
      : null;

  if (!requestedSandbox) {
    return orig || fallbackSandbox;
  }

  if (!Object.hasOwn(SANDBOX_RANK, requestedSandbox)) {
    throw new Error(`Invalid sandbox mode: ${requestedSandbox}`);
  }

  if (
    orig &&
    SANDBOX_RANK[requestedSandbox] > SANDBOX_RANK[orig] &&
    !allowEscalation
  ) {
    throw new Error(
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
export function resolveCodexBinary() {
  const envBin = process.env.CODEX_BIN?.trim();
  if (envBin && fs.existsSync(envBin)) {
    return { path: envBin, source: "CODEX_BIN" };
  }

  try {
    const locator = IS_WINDOWS ? "where.exe" : "which";
    const out = execFileSync(locator, ["codex"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (first && fs.existsSync(first)) {
      return { path: first, source: "PATH" };
    }
  } catch {
    // Not on PATH; continue to desktop app discovery.
  }

  if (IS_WINDOWS) {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
    if (fs.existsSync(binRoot)) {
      const candidates = [];
      for (const entry of fs.readdirSync(binRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(binRoot, entry.name, "codex.exe");
        if (fs.existsSync(candidate)) {
          const stat = fs.statSync(candidate);
          candidates.push({ path: candidate, mtimeMs: stat.mtimeMs });
        }
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (candidates.length > 0) {
        return { path: candidates[0].path, source: "Codex Desktop bundle" };
      }
    }
  }

  return null;
}

export function getCodexVersion(codexPath) {
  try {
    const out = execFileSync(codexPath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 5000,
    });
    return out.trim();
  } catch (err) {
    return `unknown (${err.message})`;
  }
}

export function killPidTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (IS_WINDOWS) {
    try {
      execFileSync("taskkill", ["/pid", String(n), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
      return true;
    } catch {
      try {
        process.kill(n, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    }
  }
  try {
    process.kill(n, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(n, "SIGKILL");
      } catch {
        // ignore
      }
    }, 2000).unref();
    return true;
  } catch {
    return false;
  }
}

export function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (IS_WINDOWS && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // Fallback below
    }
  }
  try {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, 3000).unref();
  } catch {
    // ignore
  }
}

function appendCommonConfigArgs(args, opts, { allowProfile = true } = {}) {
  if (opts.model) {
    args.push("-m", String(opts.model));
  }
  if (allowProfile && opts.profile) {
    args.push("-p", String(opts.profile));
  }
  const configList = Array.isArray(opts.config) ? [...opts.config] : [];
  if (
    opts.reasoningEffort &&
    !configList.some(
      (kv) =>
        typeof kv === "string" && kv.trim().startsWith("model_reasoning_effort=")
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
    const sid = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
    if (!sid || sid === "last") {
      if (opts.allowLastFallback !== true) {
        throw new Error(
          "An exact Codex session_id is required to resume (automatic fallback to 'last' is disabled)."
        );
      }
    }
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
    if (!sid || sid === "last") {
      args.push("--last");
    } else {
      args.push(sid);
    }
    args.push("-");
    return { args, stdinPrompt: opts.prompt || "" };
  }

  if (mode === "review") {
    if (opts.cwd) {
      args.push("-C", opts.cwd);
    }
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

export function evaluateRunOutcome({
  exitCode,
  timedOut,
  cancelled,
  turnCompleted,
  turnFailed,
  errors = [],
  warnings = [],
}) {
  const finalErrors = [...errors];
  const finalWarnings = [...warnings];

  if (timedOut || cancelled || turnFailed) {
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

  const ok = exitCode === 0 && finalErrors.length === 0;
  return { ok, errors: finalErrors, warnings: finalWarnings };
}

export function runCodex(options) {
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

  let built;
  try {
    built = buildCodexArgs(options.mode, { ...options, cwd });
  } catch (err) {
    return Promise.reject(err);
  }
  const { args, stdinPrompt } = built;

  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? options.timeoutMs
      : 600_000;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    // On Windows, .cmd/.bat shims (e.g. mock test scripts) need cmd.exe /c if CODEX_BIN ends in .cmd/.bat
    const isBatchScript =
      IS_WINDOWS && /\.(cmd|bat)$/i.test(resolved.path);
    const spawnCmd = isBatchScript ? process.env.ComSpec || "cmd.exe" : resolved.path;
    const spawnArgs = isBatchScript ? ["/c", resolved.path, ...args] : args;

    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    if (typeof options.onSpawn === "function") {
      options.onSpawn(child, { args });
    }

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
      rawStdoutLines: [],
      stderr: "",
      timedOut: false,
      cancelled: false,
    };

    let stdoutBuffer = "";

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

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        state.rawStdoutLines.push(trimmed);
        return;
      }

      state.eventCount += 1;

      if (evt.type === "thread.started" && evt.thread_id) {
        state.sessionId = evt.thread_id;
      } else if (evt.type === "turn.completed") {
        state.turnCompleted = true;
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

      const summary = summarizeEvent(evt);
      pushRecentEvent(summary);

      if (typeof options.onProgress === "function") {
        try {
          options.onProgress({
            eventCount: state.eventCount,
            summary: summary || evt.type || "event",
            event: evt,
            sessionId: state.sessionId,
          });
        } catch {
          // ignore callback errors
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let idx;
      while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, idx);
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        handleLine(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (state.stderr.length < 32_000) {
        state.stderr += chunk;
      }
    });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        state.timedOut = true;
        state.errors.push(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
        killProcessTree(child);
      }, timeoutMs);
      timer.unref();
    }

    const onAbort = () => {
      state.cancelled = true;
      state.errors.push("Cancelled by caller");
      killProcessTree(child);
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      if (stdoutBuffer.trim()) {
        handleLine(stdoutBuffer);
      }

      const durationMs = Date.now() - startedAt;
      const lastMessage =
        state.messages.length > 0
          ? state.messages[state.messages.length - 1]
          : state.rawStdoutLines.join("\n").trim();

      const verdict = evaluateRunOutcome({
        exitCode: code,
        timedOut: state.timedOut,
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
        cancelled: state.cancelled,
        eventCount: state.eventCount,
        recentEvents: state.recentEvents,
      });
    });

    if (stdinPrompt !== null && stdinPrompt !== undefined) {
      child.stdin.write(stdinPrompt, "utf8");
    }
    child.stdin.end();
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
