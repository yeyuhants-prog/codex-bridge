import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SidecarApp, Response } from "sidecar_sdk";
import {
  resolveCodexBinary,
  getCodexVersion,
} from "../../server/codex-runner.js";
import {
  loadSettings,
  saveSettings,
  resetSettings,
  loadHistory,
  readCodexTomlDefaults,
  readCodexModelsCatalog,
} from "../../server/settings-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, "..", "..");
const LOGO_PATH = join(PLUGIN_ROOT, "assets", "logo.png");

const app = new SidecarApp();

function readText(file) {
  return readFileSync(join(__dirname, file), "utf-8");
}

function buildState() {
  const resolved = resolveCodexBinary();
  const version = resolved ? getCodexVersion(resolved.path) : null;
  const models = readCodexModelsCatalog();
  const tomlDefaults = readCodexTomlDefaults();
  const settings = loadSettings();
  const history = loadHistory();

  return {
    pluginVersion: "1.1.0",
    codex: {
      found: Boolean(resolved),
      path: resolved?.path || null,
      source: resolved?.source || null,
      version,
    },
    tomlDefaults,
    models,
    settings,
    history,
    conversationId: app.config.conversationId || null,
  };
}

app.page("/", () => new Response(readText("index.html"), {
  contentType: "text/html; charset=utf-8",
}));

app.api("/styles.css", () => new Response(readText("styles.css"), {
  contentType: "text/css; charset=utf-8",
}), "GET");

app.api("/app.js", () => new Response(readText("app.js"), {
  contentType: "application/javascript; charset=utf-8",
}), "GET");

app.api("/logo.png", () => {
  if (!existsSync(LOGO_PATH)) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(readFileSync(LOGO_PATH), {
    contentType: "image/png",
    headers: { "Cache-Control": "private, max-age=3600" },
  });
}, "GET");

app.api("/api/state", () => buildState(), "GET");

app.api("/api/settings", (data) => {
  const settings = saveSettings({
    model: data.model,
    reasoningEffort: data.reasoningEffort,
    sandbox: data.sandbox,
    workflowMode: data.workflowMode,
    ephemeral: data.ephemeral,
    skipGitRepoCheck: data.skipGitRepoCheck,
  });
  return { ok: true, settings };
}, "POST");

app.api("/api/reset", () => {
  const settings = resetSettings();
  return { ok: true, settings };
}, "POST");

app.run();
