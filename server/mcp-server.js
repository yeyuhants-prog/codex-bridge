#!/usr/bin/env node
import {
  resolveCodexBinary,
  getCodexVersion,
  runCodex,
  formatCodexResult,
} from "./codex-runner.js";
import { JobManager } from "./job-manager.js";

const SERVER_INFO = {
  name: "codex-mcp-bridge",
  version: "1.0.0",
};

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const jobManager = new JobManager();
const activeRequests = new Map(); // requestId -> AbortController

function log(...args) {
  process.stderr.write(`[codex-mcp-bridge] ${args.join(" ")}\n`);
}

function sendMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  sendMessage({ jsonrpc: "2.0", id, error: err });
}

function sendProgress(progressToken, progress, message) {
  if (progressToken === undefined || progressToken === null) return;
  sendMessage({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: {
      progressToken,
      progress,
      message,
    },
  });
}

const COMMON_RUN_PROPERTIES = {
  cwd: {
    type: "string",
    description:
      "Absolute path to the working directory where Codex should operate. Defaults to the current workspace directory.",
  },
  sandbox: {
    type: "string",
    enum: ["read-only", "workspace-write", "danger-full-access"],
    default: "workspace-write",
    description:
      "Sandbox policy for Codex shell commands. Use 'read-only' for analysis/Q&A, 'workspace-write' (default) for editing files & running workspace tests, or 'danger-full-access' only when explicitly needed.",
  },
  model: {
    type: "string",
    description:
      "Optional model override for Codex (e.g. 'gpt-5.4', 'o3'). Omit to use your default Codex config.",
  },
  profile: {
    type: "string",
    description: "Optional Codex config profile name (-p <profile>).",
  },
  add_dirs: {
    type: "array",
    items: { type: "string" },
    description:
      "Additional directories that should be writable alongside cwd.",
  },
  images: {
    type: "array",
    items: { type: "string" },
    description: "Optional image file paths to attach to the prompt.",
  },
  config: {
    type: "array",
    items: { type: "string" },
    description:
      "Optional Codex config overrides in 'key=value' TOML format (passed as -c).",
  },
  ephemeral: {
    type: "boolean",
    default: false,
    description: "If true, do not persist the Codex session to disk.",
  },
  worktree: {
    type: "boolean",
    default: false,
    description: "If true, run the session inside a managed Git worktree.",
  },
  skip_git_repo_check: {
    type: "boolean",
    default: true,
    description:
      "Allow Codex to run outside a Git repository (default: true).",
  },
  output_schema: {
    type: "string",
    description:
      "Optional path to a JSON Schema file constraining Codex's final response shape.",
  },
};

const TOOLS = [
  {
    name: "codex_run",
    description:
      "Run a task synchronously with local OpenAI Codex CLI (`codex exec`) and return its final response, session_id (for follow-up via codex_resume), modified files, executed commands, and token usage. Best for tasks finishing within a few minutes; for very long or parallel tasks, use codex_start.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Clear, detailed task instructions for Codex (supports multiline text and Chinese/English).",
        },
        ...COMMON_RUN_PROPERTIES,
        timeout_seconds: {
          type: "number",
          default: 600,
          description: "Maximum seconds to wait before aborting (default 600).",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "codex_resume",
    description:
      "Continue a previous Codex session synchronously by session_id (or 'last' for the most recent session) with follow-up instructions, preserving Codex's full conversation context.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Session UUID returned by a prior codex_run/codex_start, or 'last' to resume the most recent session.",
        },
        prompt: {
          type: "string",
          description: "Follow-up instructions to send to the resumed Codex session.",
        },
        cwd: {
          type: "string",
          description: "Working directory for the resumed session.",
        },
        model: COMMON_RUN_PROPERTIES.model,
        images: COMMON_RUN_PROPERTIES.images,
        config: COMMON_RUN_PROPERTIES.config,
        skip_git_repo_check: COMMON_RUN_PROPERTIES.skip_git_repo_check,
        timeout_seconds: {
          type: "number",
          default: 600,
          description: "Maximum seconds to wait before aborting (default 600).",
        },
      },
      required: ["session_id", "prompt"],
    },
  },
  {
    name: "codex_review",
    description:
      "Run Codex's built-in non-interactive code review (`codex exec review`) on a Git repository.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Absolute path to the Git repository to review.",
        },
        uncommitted: {
          type: "boolean",
          description:
            "Review staged, unstaged, and untracked changes in the working tree.",
        },
        base: {
          type: "string",
          description: "Review changes against this base branch (e.g. 'main').",
        },
        commit: {
          type: "string",
          description: "Review changes introduced by a specific commit SHA.",
        },
        title: {
          type: "string",
          description: "Optional title to display in the review summary.",
        },
        prompt: {
          type: "string",
          description:
            "Optional custom review instructions (note: Codex may treat custom prompt as an alternative to target flags depending on CLI version).",
        },
        model: COMMON_RUN_PROPERTIES.model,
        config: COMMON_RUN_PROPERTIES.config,
        timeout_seconds: {
          type: "number",
          default: 600,
          description: "Maximum seconds to wait before aborting (default 600).",
        },
      },
      required: ["cwd"],
    },
  },
  {
    name: "codex_start",
    description:
      "Launch a Codex task asynchronously in the background and immediately return a job_id. Ideal for long-running refactors/builds or dispatching multiple Codex workers in parallel. Poll progress with codex_status.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed task instructions for Codex.",
        },
        session_id: {
          type: "string",
          description:
            "Optional: if provided, starts an async `codex exec resume` on this session_id instead of a brand-new session.",
        },
        ...COMMON_RUN_PROPERTIES,
        timeout_seconds: {
          type: "number",
          default: 1800,
          description: "Maximum runtime in seconds (default 1800 = 30 min).",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "codex_status",
    description:
      "Check status, live progress events, session_id, or final output of a background Codex job started with codex_start. Optionally waits up to wait_seconds for completion.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description:
            "The job_id returned by codex_start. Omit to list all tracked jobs.",
        },
        wait_seconds: {
          type: "number",
          default: 0,
          description:
            "Optional long-poll wait time in seconds (0-120) to wait for the job to finish before returning.",
        },
      },
    },
  },
  {
    name: "codex_cancel",
    description: "Cancel a running background Codex job by job_id.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "The job_id to cancel.",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "codex_info",
    description:
      "Check Codex MCP bridge health: shows the resolved codex.exe binary path, CLI version, and active/recent background jobs.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

function mapCommonOptions(args) {
  return {
    cwd: args.cwd,
    sandbox: args.sandbox,
    model: args.model,
    profile: args.profile,
    addDirs: args.add_dirs,
    images: args.images,
    config: args.config,
    ephemeral: Boolean(args.ephemeral),
    worktree: Boolean(args.worktree),
    skipGitRepoCheck:
      args.skip_git_repo_check === undefined
        ? true
        : Boolean(args.skip_git_repo_check),
    outputSchema: args.output_schema,
    timeoutMs:
      typeof args.timeout_seconds === "number" && args.timeout_seconds > 0
        ? args.timeout_seconds * 1000
        : undefined,
  };
}

async function handleToolCall(name, args = {}, meta = {}, signal) {
  const progressToken = meta?.progressToken;

  if (name === "codex_info") {
    const resolved = resolveCodexBinary();
    const version = resolved ? getCodexVersion(resolved.path) : "not found";
    const jobs = jobManager.listJobs();
    const text = [
      `Bridge: ${SERVER_INFO.name} v${SERVER_INFO.version}`,
      `Node: ${process.version}`,
      `Codex Binary: ${resolved ? `${resolved.path} (${resolved.source})` : "NOT FOUND"}`,
      `Codex Version: ${version}`,
      `Tracked Jobs: ${jobs.length} (${jobs.filter((j) => j.status === "running").length} running)`,
    ].join("\n");
    return {
      content: [{ type: "text", text }],
      isError: !resolved,
    };
  }

  if (name === "codex_run") {
    if (!args.prompt || typeof args.prompt !== "string") {
      return {
        content: [{ type: "text", text: "Error: 'prompt' is required." }],
        isError: true,
      };
    }
    const result = await runCodex({
      mode: "run",
      prompt: args.prompt,
      ...mapCommonOptions(args),
      signal,
      onProgress: ({ eventCount, summary }) => {
        sendProgress(progressToken, eventCount, summary);
      },
    });
    return {
      content: [{ type: "text", text: formatCodexResult(result) }],
      isError: !result.ok,
    };
  }

  if (name === "codex_resume") {
    if (!args.session_id || !args.prompt) {
      return {
        content: [
          {
            type: "text",
            text: "Error: both 'session_id' and 'prompt' are required.",
          },
        ],
        isError: true,
      };
    }
    const result = await runCodex({
      mode: "resume",
      sessionId: args.session_id,
      prompt: args.prompt,
      ...mapCommonOptions(args),
      signal,
      onProgress: ({ eventCount, summary }) => {
        sendProgress(progressToken, eventCount, summary);
      },
    });
    return {
      content: [{ type: "text", text: formatCodexResult(result) }],
      isError: !result.ok,
    };
  }

  if (name === "codex_review") {
    if (!args.cwd) {
      return {
        content: [{ type: "text", text: "Error: 'cwd' is required." }],
        isError: true,
      };
    }
    const result = await runCodex({
      mode: "review",
      cwd: args.cwd,
      uncommitted: Boolean(args.uncommitted),
      base: args.base,
      commit: args.commit,
      title: args.title,
      prompt: args.prompt,
      model: args.model,
      config: args.config,
      timeoutMs:
        typeof args.timeout_seconds === "number" && args.timeout_seconds > 0
          ? args.timeout_seconds * 1000
          : 600_000,
      signal,
      onProgress: ({ eventCount, summary }) => {
        sendProgress(progressToken, eventCount, summary);
      },
    });
    return {
      content: [{ type: "text", text: formatCodexResult(result) }],
      isError: !result.ok,
    };
  }

  if (name === "codex_start") {
    if (!args.prompt || typeof args.prompt !== "string") {
      return {
        content: [{ type: "text", text: "Error: 'prompt' is required." }],
        isError: true,
      };
    }
    const mode = args.session_id ? "resume" : "run";
    const job = jobManager.startJob({
      mode,
      sessionId: args.session_id,
      prompt: args.prompt,
      ...mapCommonOptions(args),
    });
    const text = [
      `Started background Codex job.`,
      `Job ID: ${job.id}`,
      `Mode: ${job.mode}`,
      `Working Dir: ${job.cwd}`,
      `Use codex_status(job_id="${job.id}", wait_seconds=30) to monitor progress or collect the result.`,
    ].join("\n");
    return {
      content: [{ type: "text", text }],
    };
  }

  if (name === "codex_status") {
    if (!args.job_id) {
      const jobs = jobManager.listJobs();
      if (jobs.length === 0) {
        return {
          content: [{ type: "text", text: "No background Codex jobs recorded." }],
        };
      }
      const lines = jobs.map(
        (j) =>
          `- ${j.id} [${j.status}] session=${j.sessionId || "pending"} events=${j.eventCount} cwd=${j.cwd} | "${j.promptPreview}"`
      );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }

    const waitSeconds =
      typeof args.wait_seconds === "number" && args.wait_seconds > 0
        ? args.wait_seconds
        : 0;
    const job = await jobManager.getStatus(args.job_id, waitSeconds);
    if (!job) {
      return {
        content: [{ type: "text", text: `Job not found: ${args.job_id}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: jobManager.formatJobStatus(job) }],
      isError: job.status === "failed",
    };
  }

  if (name === "codex_cancel") {
    if (!args.job_id) {
      return {
        content: [{ type: "text", text: "Error: 'job_id' is required." }],
        isError: true,
      };
    }
    const res = jobManager.cancelJob(args.job_id);
    if (!res.found) {
      return {
        content: [{ type: "text", text: `Job not found: ${args.job_id}` }],
        isError: true,
      };
    }
    if (res.alreadyFinished) {
      return {
        content: [
          {
            type: "text",
            text: `Job ${args.job_id} already finished with status: ${res.status}`,
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: `Cancelled job ${args.job_id}.` }],
    };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  // Notifications (no id)
  if (id === undefined || id === null) {
    if (method === "notifications/cancelled") {
      const reqId = params?.requestId;
      const controller = activeRequests.get(reqId);
      if (controller) {
        controller.abort();
        activeRequests.delete(reqId);
      }
    }
    return;
  }

  try {
    if (method === "initialize") {
      const clientVersion = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion)
        ? clientVersion
        : SUPPORTED_PROTOCOL_VERSIONS[0];

      sendResult(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
        instructions:
          "Use codex_run for synchronous tasks, codex_resume to continue a prior Codex session_id, codex_review for Git code reviews, and codex_start/codex_status/codex_cancel for long-running or parallel Codex workers.",
      });
      return;
    }

    if (method === "ping") {
      sendResult(id, {});
      return;
    }

    if (method === "tools/list") {
      sendResult(id, { tools: TOOLS });
      return;
    }

    if (method === "resources/list") {
      sendResult(id, { resources: [] });
      return;
    }

    if (method === "prompts/list") {
      sendResult(id, { prompts: [] });
      return;
    }

    if (method === "tools/call") {
      const controller = new AbortController();
      activeRequests.set(id, controller);
      try {
        const result = await handleToolCall(
          params?.name,
          params?.arguments || {},
          params?._meta || {},
          controller.signal
        );
        sendResult(id, result);
      } catch (err) {
        sendResult(id, {
          content: [
            {
              type: "text",
              text: `Codex bridge error: ${err?.message || String(err)}`,
            },
          ],
          isError: true,
        });
      } finally {
        activeRequests.delete(id);
      }
      return;
    }

    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    log("Unhandled error:", err?.stack || String(err));
    sendError(id, -32603, err?.message || "Internal server error");
  }
}

// Stdio newline-delimited JSON-RPC transport
let inputBuffer = "";
process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let newlineIdx;
  while ((newlineIdx = inputBuffer.indexOf("\n")) !== -1) {
    const line = inputBuffer.slice(0, newlineIdx).trim();
    inputBuffer = inputBuffer.slice(newlineIdx + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      log("Malformed JSON on stdin:", err.message);
      sendError(null, -32700, "Parse error");
      continue;
    }

    // Dispatch concurrently so status/cancel/ping never block behind a long codex_run.
    void handleRequest(msg);
  }
});

function shutdown() {
  for (const controller of activeRequests.values()) {
    controller.abort();
  }
  activeRequests.clear();
  jobManager.cancelAll();
  process.exit(0);
}

process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log(`Started ${SERVER_INFO.name} v${SERVER_INFO.version}`);
