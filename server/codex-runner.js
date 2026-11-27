import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const IS_WINDOWS = process.platform === "win32";

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

  // Check PATH
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

  // Check Windows Codex Desktop bundled binaries
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

function appendCommonConfigArgs(args, opts) {
  if (opts.model) {
    args.push("-m", String(opts.model));
  }
  if (opts.profile) {
    args.push("-p", String(opts.profile));
  }
  if (Array.isArray(opts.config)) {
    for (const kv of opts.config) {
      if (typeof kv === "string" && kv.trim()) {
        args.push("-c", kv.trim());
      }
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
    appendCommonConfigArgs(args, opts);
    args.push("-");
    return { args, stdinPrompt: opts.prompt || "" };
  }

  if (mode === "resume") {
    args.push("resume", "--json");
    appendCommonConfigArgs(args, opts);
    if (!opts.sessionId || opts.sessionId === "last") {
      args.push("--last");
    } else {
      args.push(String(opts.sessionId));
    }
    args.push("-");
    return { args, stdinPrompt: opts.prompt || "" };
  }

  if (mode === "review") {
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
    appendCommonConfigArgs(args, { ...opts, skipGitRepoCheck: false });
    if (opts.prompt && opts.prompt.trim()) {
      args.push("-");
      return { args, stdinPrompt: opts.prompt };
    }
    return { args, stdinPrompt: null };
  }

  throw new Error(`Unsupported Codex mode: ${mode}`);
}

/**
 * Summarize a Codex JSONL event for progress notifications and structured output.
 */
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

/**
 * Run a Codex CLI invocation and parse its JSONL event stream.
 *
 * @param {object} options
 * @param {"run"|"resume"|"review"} options.mode
 * @param {string} [options.cwd]
 * @param {string} [options.prompt]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {(info: { eventCount: number, summary: string, event: any }) => void} [options.onProgress]
 * @param {(child: import("node:child_process").ChildProcess) => void} [options.onSpawn]
 */
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

  const { args, stdinPrompt } = buildCodexArgs(options.mode, {
    ...options,
    cwd,
  });

  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? options.timeoutMs
      : 600_000;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(resolved.path, args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    if (typeof options.onSpawn === "function") {
      options.onSpawn(child);
    }

    const state = {
      sessionId: null,
      messages: [],
      commands: [],
      fileChanges: [],
      errors: [],
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
      } else if (evt.type === "turn.completed" && evt.usage) {
        state.usage = evt.usage;
      } else if (evt.type === "turn.failed" || evt.type === "error") {
        const msg =
          evt.error?.message || evt.message || JSON.stringify(evt);
        state.errors.push(msg);
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

      const ok =
        code === 0 &&
        !state.timedOut &&
        !state.cancelled &&
        state.errors.length === 0;

      resolve({
        ok,
        exitCode: code,
        signal,
        durationMs,
        codexBinary: resolved.path,
        cwd,
        sessionId: state.sessionId,
        lastMessage,
        messages: state.messages,
        commands: state.commands,
        fileChanges: state.fileChanges,
        usage: state.usage,
        errors: state.errors,
        stderr: state.stderr.trim(),
        timedOut: state.timedOut,
        cancelled: state.cancelled,
        eventCount: state.eventCount,
        recentEvents: state.recentEvents,
      });
    });

    // Write prompt to stdin and close it so Codex starts immediately.
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

  if (result.errors?.length) {
    sections.push(`## Errors\n\n${result.errors.map((e) => `- ${e}`).join("\n")}`);
  }

  if (!result.ok && result.stderr) {
    sections.push(`## Stderr\n\n\`\`\`\n${result.stderr.slice(0, 4000)}\n\`\`\``);
  }

  return sections.join("\n\n");
}
