import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH =
  process.env.BRIDGE_SERVER ||
  path.resolve(__dirname, "..", "server", "mcp-server.js");
const LIVE = process.argv.includes("--live");

class McpTestClient {
  constructor(extraEnv = {}) {
    this.child = spawn(process.execPath, [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.buffer = "";

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        } else {
          this.notifications.push(msg);
        }
      }
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => {
      process.stderr.write(`[server stderr] ${d}`);
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`
    );
  }

  close() {
    this.child.stdin.end();
  }
}

async function main() {
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-test-"));
  const client = new McpTestClient({ CODEX_BRIDGE_DATA_DIR: tempDataDir });
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.2.0" },
    });
    console.log("1) initialize OK:", init.serverInfo, init.protocolVersion);
    client.notify("notifications/initialized");

    const toolsRes = await client.request("tools/list");
    const toolNames = toolsRes.tools.map((t) => t.name);
    console.log("2) tools/list OK:", toolNames.join(", "));
    if (toolNames.length !== 9) {
      throw new Error(`Expected 9 tools, got ${toolNames.length}`);
    }

    const infoRes = await client.request("tools/call", {
      name: "codex_info",
      arguments: {},
    });
    console.log("3) codex_info OK:\n" + infoRes.content[0].text);
    if (infoRes.isError) {
      throw new Error("codex_info returned isError=true");
    }

    const cfgRes = await client.request("tools/call", {
      name: "codex_config",
      arguments: {
        progression_mode: "autonomous",
        max_auto_iterations: 15,
        list_models: true,
      },
    });
    console.log("4) codex_config OK (length=" + cfgRes.content[0].text.length + ")");
    if (cfgRes.isError || !cfgRes.content[0].text.includes("autonomous")) {
      throw new Error("codex_config failed to update progression_mode");
    }

    const goalCreate = await client.request("tools/call", {
      name: "codex_goal",
      arguments: {
        action: "create",
        title: "Verify backend auth fix",
        objective: "Reproduce 500 error and pass pytest",
        cwd: process.cwd(),
        acceptance_criteria: ["pytest passes"],
        milestones: [
          { title: "Reproduce bug", verification: "pytest -k auth" },
          { title: "Apply fix and verify", verification: "pytest" },
        ],
      },
    });
    const goalText = goalCreate.content[0].text;
    const m = /goal_[a-f0-9]+/.exec(goalText);
    if (!m) throw new Error("codex_goal create did not return a goal_id");
    const goalId = m[0];
    console.log("5) codex_goal create OK:", goalId);

    const msUpdate = await client.request("tools/call", {
      name: "codex_goal",
      arguments: {
        action: "update_milestone",
        goal_id: goalId,
        milestone_id: "m1",
        status: "done",
        notes: "Reproduced locally",
      },
    });
    if (msUpdate.isError || !msUpdate.content[0].text.includes("1/2 milestones")) {
      throw new Error("codex_goal update_milestone failed");
    }
    console.log("6) codex_goal update_milestone OK (1/2 done)");

    const goalDel = await client.request("tools/call", {
      name: "codex_goal",
      arguments: { action: "delete", goal_id: goalId },
    });
    if (goalDel.isError) throw new Error("codex_goal delete failed");
    console.log("7) codex_goal delete OK");

    if (LIVE) {
      console.log("8) Running live codex_run (read-only, ephemeral)...");
      const runRes = await client.request("tools/call", {
        name: "codex_run",
        arguments: {
          prompt: "Reply with only: BRIDGE_OK",
          cwd: process.cwd(),
          sandbox: "read-only",
          ephemeral: true,
        },
        _meta: { progressToken: "smoke-1" },
      });
      console.log("   codex_run result:\n" + runRes.content[0].text);
      if (runRes.isError || !runRes.content[0].text.includes("BRIDGE_OK")) {
        throw new Error("Live codex_run did not return expected BRIDGE_OK");
      }
    }

    console.log("\nALL SMOKE TESTS PASSED!");
  } finally {
    client.close();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
