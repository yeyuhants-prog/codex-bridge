import { problem } from "./validation.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readJson, writeJsonAtomic, withFileLock } from "./file-store.js";
export { writeJsonAtomic };

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

export const DEFAULT_SETTINGS = {
  language: "zh", // "zh" | "en"
  roleMode: "orchestrator", // "orchestrator" | "flexible"
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

const VALID_LANGUAGES = new Set(["zh", "en"]);
const VALID_ROLE_MODES = new Set(["orchestrator", "flexible"]);

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
    const raw = readJson(filePath, null, v => v && typeof v === "object" && !Array.isArray(v));
    if (!raw) return { ...DEFAULT_SETTINGS, updatedAt: null };
    const maxIter = Number(raw.maxAutoIterations);
    return {
      language: VALID_LANGUAGES.has(raw.language)
        ? raw.language
        : DEFAULT_SETTINGS.language,
      roleMode: VALID_ROLE_MODES.has(raw.roleMode)
        ? raw.roleMode
        : DEFAULT_SETTINGS.roleMode,
      model: typeof raw.model === "string" ? raw.model.trim() : "",
      reasoningEffort: VALID_EFFORTS.has(raw.reasoningEffort)
        ? raw.reasoningEffort
        : "",
      sandbox: VALID_SANDBOXES.has(raw.sandbox)
        ? raw.sandbox
        : "read-only",
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
  } catch (err) {
    if (err.code !== "CORRUPT_STORE") throw err;
    return { ...DEFAULT_SETTINGS, sandbox: "read-only", updatedAt: null };
  }
}

export function saveSettings(patch = {}) {
  return withFileLock(getSettingsPath(), () => {
    for (const key of ["ephemeral", "skipGitRepoCheck"]) {
      if (patch[key] !== undefined && typeof patch[key] !== "boolean") throw problem(400, key + " must be boolean.");
    }
    for (const [key, allowed] of Object.entries({ language: VALID_LANGUAGES, roleMode: VALID_ROLE_MODES,
      reasoningEffort: VALID_EFFORTS, sandbox: VALID_SANDBOXES, workflowMode: VALID_WORKFLOW_MODES,
      progressionMode: VALID_PROGRESSION_MODES })) {
      if (patch[key] !== undefined && !allowed.has(patch[key])) throw problem(400, "Invalid setting: " + key);
    }
    if (patch.maxAutoIterations !== undefined && (!Number.isInteger(patch.maxAutoIterations) ||
      patch.maxAutoIterations < 1 || patch.maxAutoIterations > 100)) throw problem(400, "Invalid maxAutoIterations.");
    const next = loadSettings();
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (patch[key] === undefined) continue;
      if (["model", "boundConversationId", "boundProjectId"].includes(key)) {
        next[key] = String(patch[key] ?? "").trim();
      } else {
        next[key] = patch[key];
      }
    }
    next.updatedAt = new Date().toISOString();
    writeJsonAtomic(getSettingsPath(), next);
    return next;
  });
}

export function resetSettings() {
  return withFileLock(getSettingsPath(), () => {
    const current = loadSettings();
    return saveSettings({
      ...DEFAULT_SETTINGS,
      // Keep bound conversation so resetting preferences does not break callback routing
      boundConversationId: current.boundConversationId,
      boundProjectId: current.boundProjectId,
    });
  });
}

export function loadHistory() {
  return readJson(getHistoryPath(), [], Array.isArray);
}

export function appendHistory(entry) {
  return withFileLock(getHistoryPath(), () => {
    const list = loadHistory();
    list.unshift({ at: new Date().toISOString(), ...entry });
    writeJsonAtomic(getHistoryPath(), list.slice(0, 30));
  });
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
