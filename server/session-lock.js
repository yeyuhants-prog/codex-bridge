import { problem } from "./validation.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./settings-store.js";
import { withFileLock, writeJsonAtomic } from "./file-store.js";
import { isPidAlive, matchesProcess, processIdentity, ownerIdentity } from "./process-identity.js";
export { isPidAlive };

export function normalizeSessionId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.trim())) {
    throw problem(400, "An exact session_id UUID is required.");
  }
  return value.trim().toLowerCase();
}

export function getLocksDir() { return path.join(getDataDir(), "locks"); }

export function getSessionLockPath(sessionId) {
  const hash = crypto.createHash("sha256").update(normalizeSessionId(sessionId)).digest("hex").slice(0, 24);
  return path.join(getLocksDir(), "session_" + hash + ".lock");
}

export function inspectSessionLock(sessionId) {
  const file = getSessionLockPath(sessionId);
  let lock;
  try { lock = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (err) {
    if (err.code === "ENOENT") return { locked: false };
    if (!(err instanceof SyntaxError)) throw err;
  }
  if (!lock || typeof lock !== "object" || (!lock.ownerPid && !lock.pid)) {
    try { return { locked: Date.now() - fs.statSync(file).mtimeMs < 30000, lock: null }; }
    catch (err) { if (err.code === "ENOENT") return { locked: false }; throw err; }
  }
  let locked = isPidAlive(lock.pid || lock.ownerPid);
  if (locked && lock.pid && lock.processIdentity) {
    const current = processIdentity(lock.pid);
    if (current) locked = matchesProcess(lock.processIdentity, current);
  }
  if (locked && !lock.pid) {
    if (lock.ownerIdentity) {
      const current = ownerIdentity(lock.ownerPid);
      if (current) locked = matchesProcess(lock.ownerIdentity, current);
    } else {
      locked = Date.now() - Date.parse(lock.acquiredAt || 0) < 30000;
    }
  }
  return { locked, stale: !locked, lock, lockPath: file };
}

export function acquireSessionLock(sessionId, fields = {}) {
  const file = getSessionLockPath(sessionId);
  return withFileLock(path.join(getLocksDir(), "owners"), () => {
    const info = inspectSessionLock(sessionId);
    if (info.locked) return { acquired: false, existing: info.lock };
    const ownerToken = crypto.randomUUID();
    writeJsonAtomic(file, { ...fields, sessionId: normalizeSessionId(sessionId),
      ownerPid: fields.ownerPid || process.pid, ownerIdentity: fields.pid ? null : ownerIdentity(fields.ownerPid),
      ownerToken, acquiredAt: new Date().toISOString() });
    return { acquired: true, ownerToken, lockPath: file };
  });
}

function changeOwnedLock(sessionId, token, action) {
  if (!sessionId || !token) return false;
  const file = getSessionLockPath(sessionId);
  return withFileLock(path.join(getLocksDir(), "owners"), () => {
    let lock;
    try { lock = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (err) { if (err.code === "ENOENT") return false; throw err; }
    if (lock?.ownerToken !== token) return false;
    action(file, lock);
    return true;
  });
}

export function updateSessionLockPid(sid, token, pid, identity) {
  return changeOwnedLock(sid, token, (file, lock) =>
    writeJsonAtomic(file, { ...lock, pid, processIdentity: identity || null }));
}

export function releaseSessionLock(sid, token) {
  return changeOwnedLock(sid, token, file => fs.unlinkSync(file));
}
