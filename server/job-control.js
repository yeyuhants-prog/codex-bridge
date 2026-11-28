import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getDataDir } from "./settings-store.js";
import { readJson, retryWindowsIo, writeJsonAtomic } from "./file-store.js";

const pollMs = 120;
const retentionMs = 60_000;
const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const commandName = new RegExp("^cmd-(\\d{16})-(" + uuid + ")\\.json$");
const root = () => path.join(getDataDir(), "control");
function directory(id) {
  if (!/^codex_[0-9a-f]{8}$/.test(id)) throw new Error("Invalid control directory");
  return path.join(root(), id);
}

function entries(dir) {
  try { return retryWindowsIo(() => fs.readdirSync(dir)); }
  catch (err) { if (err.code === "ENOENT") return []; throw err; }
}

// Caller holds the jobs transaction across validation, sequence allocation and publication.
export function publish(command, local) {
  const dir = directory(command.jobId);
  const counter = path.join(dir, "sequence.json");
  command.seq = readJson(counter, 0, Number.isSafeInteger) + 1;
  writeJsonAtomic(counter, command.seq);
  if (local) return local.submit(command);
  const seq = String(command.seq).padStart(16, "0");
  writeJsonAtomic(path.join(dir, `cmd-${seq}-${command.requestId}.json`), command);
}

const unknown = () => ({ status: "unknown", error: "Acknowledgement deadline elapsed. Delivery is uncertain. Do not retry automatically." });

export async function waitForAck(command, timeout, localResult) {
  if (localResult) {
    let timer;
    try {
      return await Promise.race([localResult.catch(unknown), new Promise(resolve => {
        timer = setTimeout(() => resolve(unknown()), timeout);
      })]);
    } finally { clearTimeout(timer); }
  }
  const deadline = Date.now() + timeout;
  const ack = path.join(directory(command.jobId), "ack-" + command.requestId + ".json");
  for (;;) {
    try {
      const result = readJson(ack, null, value => ["accepted", "rejected"].includes(value?.status) &&
        (value.status !== "accepted" || value.turnId === command.expectedTurnId));
      if (result) return result;
    } catch (err) {
      return { status: "unknown", error: "Cannot verify acknowledgement: " + err.message };
    }
    const left = deadline - Date.now();
    if (left <= 0) return unknown();
    await delay(Math.min(left, pollMs));
  }
}

export function createConsumer(jobId, execute) {
  const dir = directory(jobId);
  const local = [];
  let busy = false;
  async function drain() {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const file = entries(dir).filter(name => commandName.test(name)).sort()[0];
        const match = file && commandName.exec(file);
        if (local.length && (!match || local[0].command.seq < Number(match[1]))) {
          const { command, resolve, reject } = local.shift();
          try { resolve(await execute(command)); } catch (err) { reject(err); }
          continue;
        }
        if (!file) return;
        const source = path.join(dir, file);
        let command;
        try { command = readJson(source, null, value => value !== null && typeof value === "object"); }
        catch (err) { if (err.code !== "CORRUPT_STORE") throw err; }
        // Remove before RPC. A crash on either side of the send can never replay it.
        retryWindowsIo(() => fs.unlinkSync(source));
        const result = command?.requestId === match[2] && command.seq === Number(match[1])
          ? await execute(command)
          : { status: "rejected", error: "Invalid command envelope", currentTurnId: null, at: new Date().toISOString() };
        writeJsonAtomic(path.join(dir, "ack-" + match[2] + ".json"), result);
      }
    } catch (err) { console.error("[codex-bridge] Control channel:", err.message); }
    finally { busy = false; }
  }
  const timer = setInterval(drain, pollMs);
  timer.unref();
  return {
    submit(command) {
      return new Promise((resolve, reject) => local.push({ command, resolve, reject }));
    },
    drain,
    close() { clearInterval(timer); void drain(); },
  };
}

// Called under the jobs transaction so a new publication cannot race removal.
export function pruneControls(jobs, alive) {
  const cutoff = Date.now() - retentionMs;
  for (const id of entries(root())) {
    if (!/^codex_[0-9a-f]{8}$/.test(id)) continue;
    const job = jobs.find(row => row.id === id);
    if (job?.status === "running" && alive(job.ownerPid)) continue;
    const dir = directory(id);
    if (Math.max(fs.statSync(dir).mtimeMs, Date.parse(job?.finishedAt) || 0) < cutoff) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }
}
