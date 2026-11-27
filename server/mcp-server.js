#!/usr/bin/env node
import {
  resolveCodexBinary,
  getCodexVersion,
  runCodex,
  formatCodexResult,
} from "./codex-runner.js";
import { JobManager } from "./job-manager.js";
import {
  loadSettings,
  saveSettings,
  appendHistory,
  readCodexTomlDefaults,
  readCodexModelsCatalog,
} from "./settings-store.js";

const SERVER_INFO = {
  name: "codex-mcp-bridge",
  version: "1.1.0",
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
    description:
      "Sandbox policy for Codex shell commands. Omit to use the active Codex Bridge UI panel setting (defaults to 'workspace-write').",
  },
  model: {
    type: "string",
    description:
      "Optional model override for Codex (e.g. 'gpt-6.2-sol', 'gpt-6.2-astra'). Omit to use the model selected in the Codex Bridge UI panel or ~/.codex/config.toml.",
  },
  reasoning_effort: {
    type: "string",
    enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
    description:
      "Optional reasoning effort override for Codex. Omit to use the level selected in the Codex Bridge UI panel or Codex default.",
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
    description: "If true, do not persist the Codex session to disk.",
  },
  worktree: {
    type: "boolean",
    default: false,
    description: "If true, run the session inside a managed Git worktree.",
  },
  skip_git_repo_check: {
    type: "boolean",
    description:
      "Allow Codex to run outside a Git repository (defaults to UI panel setting / true).",
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
      "Run a task synchronously with local OpenAI Codex CLI (`codex exec`) using the model, reasoning effort, and sandbox configured in the Codex Bridge UI panel (unless explicitly overridden). Returns final response, session_id, modified files, executed commands, and token usage.",
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
        reasoning_effort: COMMON_RUN_PROPERTIES.reasoning_effort,
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
            "Optional custom review instructions.",
        },
        model: COMMON_RUN_PROPERTIES.model,
        reasoning_effort: COMMON_RUN_PROPERTIES.reasoning_effort,
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
    name: "codex_config",
    description:
      "Read or update the persistent Codex Bridge preferences (model, reasoning_effort, sandbox, workflow_mode) shared with the Codex Bridge UI panel, and list available local Codex models.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Set default Codex model slug (pass empty string '' to follow ~/.codex/config.toml).",
        },
        reasoning_effort: {
          type: "string",
          enum: ["", "low", "medium", "high", "xhigh", "max", "ultra"],
          description:
            "Set default reasoning effort (pass '' to follow model/config default).",
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Set default sandbox policy.",
        },
        workflow_mode: {
          type: "string",
          enum: ["direct", "plan_first"],
          description:
            "Set collaboration mode: 'direct' executes immediately; 'plan_first' drafts a detailed brief for user confirmation before invoking Codex.",
        },
        list_models: {
          type: "boolean",
          default: true,
          description: "Include available local Codex models in the output.",
        },
      },
    },
  },
  {
    name: "codex_info",
    description:
      "Check Codex Bridge health: shows resolved codex.exe path & version, active UI panel preferences (model, reasoning effort, sandbox, workflow mode), and tracked background jobs.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

function mapCommonOptions(args) {
  const prefs = loadSettings();
  return {
    cwd: args.cwd,
    sandbox: args.sandbox || prefs.sandbox || "workspace-write",
    model: args.model || prefs.model || undefined,
    reasoningEffort:
      args.reasoning_effort || prefs.reasoningEffort || undefined,
    profile: args.profile,
    addDirs: args.add_dirs,
    images: args.images,
    config: args.config,
    ephemeral:
      args.ephemeral !== undefined ? Boolean(args.ephemeral) : prefs.ephemeral,
    worktree: Boolean(args.worktree),
    skipGitRepoCheck:
      args.skip_git_repo_check !== undefined
        ? Boolean(args.skip_git_repo_check)
        : prefs.skipGitRepoCheck,
    outputSchema: args.output_schema,
    timeoutMs:
      typeof args.timeout_seconds === "number" && args.timeout_seconds > 0
        ? args.timeout_seconds * 1000
        : undefined,
  };
}

function recordRunHistory(mode, opts, result) {
  appendHistory({
    mode,
    status: result.ok
      ? "completed"
      : result.cancelled
        ? "cancelled"
        : result.timedOut
          ? "timed_out"
          : "failed",
    model: opts.model || "(codex default)",
    reasoningEffort: opts.reasoningEffort || "(default)",
    sandbox: opts.sandbox || "workspace-write",
    cwd: result.cwd || opts.cwd || process.cwd(),
    sessionId: result.sessionId || null,
    durationMs: result.durationMs || 0,
    usage: result.usage || null,
    promptPreview: String(opts.prompt || "").replace(/\s+/g, " ").slice(0, 140),
  });
}

async function handleToolCall(name, args = {}, meta = {}, signal) {
  const progressToken = meta?.progressToken;

  if (name === "codex_info") {
    const resolved = resolveCodexBinary();
    const version = resolved ? getCodexVersion(resolved.path) : "not found";
    const jobs = jobManager.listJobs();
    const prefs = loadSettings();
    const toml = readCodexTomlDefaults();
    const effectiveModel =
      prefs.model || `${toml.model || "default"} (Codex 默认)`;
    const effectiveEffort =
      prefs.reasoningEffort ||
      `${toml.reasoningEffort || "default"} (Codex 默认)`;
    const text = [
      `Bridge: ${SERVER_INFO.name} v${SERVER_INFO.version}`,
      `Node: ${process.version}`,
      `Codex Binary: ${resolved ? `${resolved.path} (${resolved.source})` : "NOT FOUND"}`,
      `Codex Version: ${version}`,
      `Active Model: ${effectiveModel}`,
      `Reasoning Effort: ${effectiveEffort}`,
      `Sandbox Policy: ${prefs.sandbox}`,
      `Workflow Mode: ${prefs.workflowMode}`,
      `Tracked Jobs: ${jobs.length} (${jobs.filter((j) => j.status === "running").length} running)`,
    ].join("\n");
    return {
      content: [{ type: "text", text }],
      isError: !resolved,
    };
  }

  if (name === "codex_config") {
    const patch = {};
    if (args.model !== undefined) patch.model = args.model;
    if (args.reasoning_effort !== undefined)
      patch.reasoningEffort = args.reasoning_effort;
    if (args.sandbox !== undefined) patch.sandbox = args.sandbox;
    if (args.workflow_mode !== undefined)
      patch.workflowMode = args.workflow_mode;

    const updated =
      Object.keys(patch).length > 0 ? saveSettings(patch) : loadSettings();
    const toml = readCodexTomlDefaults();
    const lines = [
      `## Active Codex Bridge Preferences`,
      `- Model: ${updated.model || `(follow Codex default: ${toml.model || "auto"})`}`,
      `- Reasoning Effort: ${updated.reasoningEffort || `(follow default: ${toml.reasoningEffort || "auto"})`}`,
      `- Sandbox: ${updated.sandbox}`,
      `- Workflow Mode: ${updated.workflowMode}`,
      `- Ephemeral: ${updated.ephemeral}`,
    ];

    if (args.list_models !== false) {
      const models = readCodexModelsCatalog();
      if (models.length > 0) {
        lines.push(`\n## Available Local Codex Models (${models.length})`);
        for (const m of models) {
          const efforts = m.efforts.map((e) => e.effort).join(", ");
          lines.push(
            `- \`${m.slug}\` (${m.displayName})${efforts ? ` — efforts: ${efforts}` : ""}`
          );
        }
      }
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }

  if (name === "codex_run") {
    if (!args.prompt || typeof args.prompt !== "string") {
      return {
        content: [{ type: "text", text: "Error: 'prompt' is required." }],
        isError: true,
      };
    }
    const opts = {
      mode: "run",
      prompt: args.prompt,
      ...mapCommonOptions(args),
    };
    const result = await runCodex({
      ...opts,
      signal,
      onProgress: ({ eventCount, summary }) => {
        sendProgress(progressToken, eventCount, summary);
      },
    });
    recordRunHistory("run", opts, result);
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
    const opts = {
      mode: "resume",
      sessionId: args.session_id,
      prompt: args.prompt,
      ...mapCommonOptions(args),
    };
    const result = await runCodex({
      ...opts,
      signal,
      onProgress: ({ eventCount, summary }) => {
        sendProgress(progressToken, eventCount, summary);
      },
    });
    recordRunHistory("resume", opts, result);
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
    const common = mapCommonOptions(args);
    const opts = {
      mode: "review",
      cwd: args.cwd,
      uncommitted: Boolean(args.uncommitted),
      base: args.base,
      commit: args.commit,
      title: args.title,
      prompt: args.prompt,
      model: common.model,
      reasoningEffort: common.reasoningEffort,
      config: args.config,
      timeoutMs:
        typeof args.timeout_seconds === "number" && args.timeout_seconds > 0
          ? args.timeout_seconds * 1000
          : 600_000,
    };
    const result = await runCodex({
      ...opts,
      signal,
      onProgress: ({ eventCount, summary }) => {
        sendProgress(progressToken, eventCount, summary);
      },
    });
    recordRunHistory("review", opts, result);
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
    const opts = {
      mode,
      sessionId: args.session_id,
      prompt: args.prompt,
      ...mapCommonOptions(args),
    };
    const job = jobManager.startJob(opts);
    job.promise.then(() => {
      if (job.result) recordRunHistory(mode, opts, job.result);
    });
    const text = [
      `Started background Codex job.`,
      `Job ID: ${job.id}`,
      `Mode: ${job.mode}`,
      `Model: ${opts.model || "(codex default)"}`,
      `Reasoning Effort: ${opts.reasoningEffort || "(default)"}`,
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
          "Use codex_run for synchronous tasks, codex_resume to continue a prior Codex session_id, codex_review for Git code reviews, codex_start/codex_status/codex_cancel for long-running or parallel Codex workers, and codex_config/codex_info to inspect or update active preferences shared with the Codex Bridge sidecar panel.",
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
