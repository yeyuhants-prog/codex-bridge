import { getCodexVersion, resolveCodexBinary } from "../../server/codex-runner.js";
const binary = resolveCodexBinary();
console.log(JSON.stringify({ found: Boolean(binary), path: binary?.path ?? null,
  source: binary?.source ?? null, version: binary ? getCodexVersion(binary.path) : null }));
