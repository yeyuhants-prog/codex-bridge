import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_DATA_DIR = path.join(
  os.homedir(),
  ".gemini",
  "antigravity",
  "plugin_data",
  "codex-bridge"
);

export function getDataDir() {
  return process.env.CODEX_BRIDGE_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
}

export function getSettingsPath() {
  return path.join(getDataDir(), "settings.json");
}

export function getHistoryPath() {
  return path.join(getDataDir(), "history.json");
}

export function getJobsPath() {
  return path.join(getDataDir(), "jobs.json");
}

export function getGoalsPath() {
  return path.join(getDataDir(), "goals.json");
}

export function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, filePath);
}

export const DEFAULT_SETTINGS = {
  model: "", // "" means follow ~/.codex/config.toml default
  reasoningEffort: "", // "" means follow model/config default
  sandbox: "workspace-write",
  workflowMode: "direct", // "direct" | "plan_first"
  progressionMode: "notify", // "manual" | "notify" | "autonomous"
  maxAutoIterations: 12,
  boundConversationId: "",
  boundProjectId: "",
  ephemeral: false,
  skipGitRepoCheck: true,
};

const VALID_SANDBOXES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

const VALID_WORKFLOW_MODES = new Set(["direct", "plan_first"]);

const VALID_PROGRESSION_MODES = new Set(["manual", "notify", "autonomous"]);

const VALID_EFFORTS = new Set([
  "",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export function loadSettings() {
  const filePath = getSettingsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_SETTINGS, updatedAt: null };
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const maxIter = Number(raw.maxAutoIterations);
    return {
      model: typeof raw.model === "string" ? raw.model.trim() : "",
      reasoningEffort: VALID_EFFORTS.has(raw.reasoningEffort)
        ? raw.reasoningEffort
        : "",
      sandbox: VALID_SANDBOXES.has(raw.sandbox)
        ? raw.sandbox
        : DEFAULT_SETTINGS.sandbox,
      workflowMode: VALID_WORKFLOW_MODES.has(raw.workflowMode)
        ? raw.workflowMode
        : DEFAULT_SETTINGS.workflowMode,
      progressionMode: VALID_PROGRESSION_MODES.has(raw.progressionMode)
        ? raw.progressionMode
        : DEFAULT_SETTINGS.progressionMode,
      maxAutoIterations:
        Number.isInteger(maxIter) && maxIter >= 1 && maxIter <= 100
          ? maxIter
          : DEFAULT_SETTINGS.maxAutoIterations,
      boundConversationId:
        typeof raw.boundConversationId === "string"
          ? raw.boundConversationId.trim()
          : "",
      boundProjectId:
        typeof raw.boundProjectId === "string"
          ? raw.boundProjectId.trim()
          : "",
      ephemeral: Boolean(raw.ephemeral),
      skipGitRepoCheck:
        raw.skipGitRepoCheck === undefined
          ? true
          : Boolean(raw.skipGitRepoCheck),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    };
  } catch {
    return { ...DEFAULT_SETTINGS, updatedAt: null };
  }
}

export function saveSettings(patch = {}) {
  const current = loadSettings();
  const maxIterPatch =
    patch.maxAutoIterations !== undefined
      ? Number(patch.maxAutoIterations)
      : undefined;

  const next = {
    model:
      patch.model !== undefined
        ? String(patch.model ?? "").trim()
        : current.model,
    reasoningEffort:
      patch.reasoningEffort !== undefined
        ? VALID_EFFORTS.has(String(patch.reasoningEffort ?? "").trim())
          ? String(patch.reasoningEffort ?? "").trim()
          : current.reasoningEffort
        : current.reasoningEffort,
    sandbox:
      patch.sandbox !== undefined && VALID_SANDBOXES.has(patch.sandbox)
        ? patch.sandbox
        : current.sandbox,
    workflowMode:
      patch.workflowMode !== undefined &&
      VALID_WORKFLOW_MODES.has(patch.workflowMode)
        ? patch.workflowMode
        : current.workflowMode,
    progressionMode:
      patch.progressionMode !== undefined &&
      VALID_PROGRESSION_MODES.has(patch.progressionMode)
        ? patch.progressionMode
        : current.progressionMode,
    maxAutoIterations:
      maxIterPatch !== undefined &&
      Number.isInteger(maxIterPatch) &&
      maxIterPatch >= 1 &&
      maxIterPatch <= 100
        ? maxIterPatch
        : current.maxAutoIterations,
    boundConversationId:
      patch.boundConversationId !== undefined
        ? String(patch.boundConversationId ?? "").trim()
        : current.boundConversationId,
    boundProjectId:
      patch.boundProjectId !== undefined
        ? String(patch.boundProjectId ?? "").trim()
        : current.boundProjectId,
    ephemeral:
      patch.ephemeral !== undefined
        ? Boolean(patch.ephemeral)
        : current.ephemeral,
    skipGitRepoCheck:
      patch.skipGitRepoCheck !== undefined
        ? Boolean(patch.skipGitRepoCheck)
        : current.skipGitRepoCheck,
    updatedAt: new Date().toISOString(),
  };

  writeJsonAtomic(getSettingsPath(), next);
  return next;
}

export function resetSettings() {
  const current = loadSettings();
  return saveSettings({
    ...DEFAULT_SETTINGS,
    // Keep bound conversation so resetting preferences does not break callback routing
    boundConversationId: current.boundConversationId,
    boundProjectId: current.boundProjectId,
  });
}

export function loadHistory() {
  const filePath = getHistoryPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const arr = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function appendHistory(entry) {
  try {
    const list = loadHistory();
    list.unshift({
      at: new Date().toISOString(),
      ...entry,
    });
    writeJsonAtomic(getHistoryPath(), list.slice(0, 30));
  } catch {
    // Non-fatal
  }
}

export function getCodexHomeDir() {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

/**
 * Parse top-level scalar defaults from ~/.codex/config.toml (read-only).
 */
export function readCodexTomlDefaults() {
  const tomlPath = path.join(getCodexHomeDir(), "config.toml");
  const defaults = {
    model: null,
    reasoningEffort: null,
    sandboxMode: null,
    verbosity: null,
  };
  try {
    if (!fs.existsSync(tomlPath)) return defaults;
    const text = fs.readFileSync(tomlPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("[")) break;
      const m = /^([a-zA-Z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
      if (!m) continue;
      const [, key, val] = m;
      if (key === "model") defaults.model = val;
      else if (key === "model_reasoning_effort") defaults.reasoningEffort = val;
      else if (key === "sandbox_mode") defaults.sandboxMode = val;
      else if (key === "model_verbosity") defaults.verbosity = val;
    }
  } catch {
    // ignore
  }
  return defaults;
}

/**
 * Read available models & supported reasoning levels from ~/.codex/models_cache.json.
 */
export function readCodexModelsCatalog() {
  const cachePath = path.join(getCodexHomeDir(), "models_cache.json");
  try {
    if (!fs.existsSync(cachePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.models)
        ? parsed.models
        : [];

    const seen = new Set();
    const models = [];
    for (const m of list) {
      if (!m || m.visibility === "hide") continue;
      const slug = m.slug || m.id;
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const levels = Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels
            .map((lvl) =>
              typeof lvl === "string"
                ? { effort: lvl, description: "" }
                : {
                    effort: lvl?.effort || "",
                    description: lvl?.description || "",
                  }
            )
            .filter((x) => x.effort)
        : [];
      models.push({
        slug,
        displayName: m.display_name || m.name || slug,
        description: m.description || "",
        defaultEffort: m.default_reasoning_level || "",
        efforts: levels,
      });
    }
    return models;
  } catch {
    return [];
  }
}
