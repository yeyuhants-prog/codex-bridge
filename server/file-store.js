import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ownerIdentity } from "./process-identity.js";

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const held = new Set();
let snapshotDepth = 0;

export function readOnlySnapshot(read) {
  snapshotDepth++;
  try { return read(); } finally { snapshotDepth--; }
}

export function retryWindowsIo(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return fn(); }
    catch (err) {
      const transient = err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES");
      if (!transient || attempt >= 10) throw err;
      Atomics.wait(sleeper, 0, 0, Math.min(50, 4 * (attempt + 1)));
    }
  }
}

export function readJson(file, missing, valid) {
  let raw;
  try { raw = retryWindowsIo(() => fs.readFileSync(file, "utf8")); }
  catch (err) {
    if (err.code === "ENOENT") return missing;
    throw err;
  }
  try {
    const value = JSON.parse(raw);
    if (!valid(value)) throw new Error("invalid record structure");
    return value;
  } catch (cause) {
    if (!snapshotDepth) {
      const suffix = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
      const backup = file + ".corrupt." + Math.floor(fs.statSync(file).mtimeMs) + "." + suffix;
      try { fs.writeFileSync(backup, raw, { flag: "wx" }); }
      catch (err) { if (err.code !== "EEXIST") throw err; }
    }
    throw Object.assign(new Error("Corrupt JSON store: " + file, { cause }), { code: "CORRUPT_STORE" });
  }
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
    retryWindowsIo(() => fs.renameSync(tmp, file));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Lamport bakery tickets have unique filenames. A stale contender can only
// remove its own ticket, never a successor's lock. No callback here may await.
function processFingerprint(pid) {
  const identity = ownerIdentity(pid);
  return identity ? crypto.createHash("sha256").update(identity.name + ":" + identity.started).digest("hex").slice(0,16) : "unknown";
}

export function withFileLock(file, action) {
  if (held.has(file)) return action();
  const dir = file + ".transactions";
  fs.mkdirSync(dir, { recursive: true });
  const id = process.pid + "-" + processFingerprint(process.pid) + "-" + crypto.randomUUID();
  const ticketPath = path.join(dir, id);
  function tickets() {
    const entries = [];
    for (const name of fs.readdirSync(dir)) {
      const match = /^(\d+)-(unknown|[\da-f]{16})-[\da-f-]+$/.exec(name);
      if (!match) continue;
      const entry = path.join(dir, name);
      try {
        if (name !== id) {
          const pid = Number(match[1]);
          if (match[2] !== "unknown" && Date.now() - fs.statSync(entry).mtimeMs > 5000) {
            const current = processFingerprint(pid);
            if (current !== "unknown" && current !== match[2]) { fs.rmSync(entry, { force: true }); continue; }
          }
          try { process.kill(pid, 0); }
          catch (err) {
            if (err.code === "ESRCH") { fs.rmSync(entry, { force: true }); continue; }
          }
        }
        entries.push([name, Number(retryWindowsIo(() => fs.readFileSync(entry, "utf8")))]);
      } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
    return entries;
  }
  fs.writeFileSync(ticketPath, "0", { flag: "wx" });
  try {
    const number = 1 + tickets().reduce((n, [, t]) => Math.max(n, t), 0);
    writeJsonAtomic(ticketPath, number);
    const deadline = Date.now() + 15000;
    while (tickets().some(([other, n]) => other !== id &&
      (n === 0 || n < number || (n === number && other < id)))) {
      if (Date.now() >= deadline) throw new Error("Store transaction timed out: " + file);
      Atomics.wait(sleeper, 0, 0, 8);
    }
    held.add(file);
    return action();
  } finally {
    held.delete(file);
    fs.rmSync(ticketPath, { force: true });
  }
}
