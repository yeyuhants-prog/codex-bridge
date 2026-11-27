import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDir, writeJsonAtomic } from "./settings-store.js";

const SPAWN_GRACE_MS = 30_000;

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user/elevation level
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

export function getLocksDir() {
  return path.join(getDataDir(), "locks");
}

export function getSessionLockPath(sessionId) {
  const hash = crypto
    .createHash("sha256")
    .update(String(sessionId).trim())
    .digest("hex")
    .slice(0, 24);
  return path.join(getLocksDir(), `session_${hash}.lock`);
}

function readLockFile(lockPath) {
  try {
    if (!fs.existsSync(lockPath)) return null;
    const raw = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

function isLockRecordAlive(lock) {
  if (!lock) return false;
  // Once the Codex child PID is recorded, that child PID is authoritative.
  if (lock.pid) {
    return isPidAlive(lock.pid);
  }
  // During the brief pre-spawn window before child PID is assigned, check ownerPid.
  if (lock.ownerPid && isPidAlive(lock.ownerPid)) {
    const ageMs = Date.now() - Date.parse(lock.acquiredAt || 0);
    return Number.isNaN(ageMs) || ageMs < SPAWN_GRACE_MS;
  }
  return false;
}

export function inspectSessionLock(sessionId) {
  if (!sessionId || !String(sessionId).trim()) {
    return { locked: false, stale: false, lock: null };
  }
  const lockPath = getSessionLockPath(sessionId);
  const lock = readLockFile(lockPath);
  if (!lock) {
    return { locked: false, stale: false, lock: null };
  }
  if (isLockRecordAlive(lock)) {
    return { locked: true, stale: false, lock, lockPath };
  }
  return { locked: false, stale: true, lock, lockPath };
}

/**
 * Atomically acquire an exclusive cross-process lock for a Codex sessionId.
 * Returns { acquired: true, lockPath } or { acquired: false, existing }.
 */
export function acquireSessionLock(
  sessionId,
  { jobId, pid = null, ownerPid = process.pid, cwd = "" } = {}
) {
  if (!sessionId || !String(sessionId).trim()) {
    return { acquired: true, lockPath: null };
  }
  const sid = String(sessionId).trim();
  const dir = getLocksDir();
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = getSessionLockPath(sid);

  const payload = {
    sessionId: sid,
    jobId: jobId || null,
    pid: pid || null,
    ownerPid,
    cwd: cwd || "",
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify(payload, null, 2) + "\n", "utf8");
      } finally {
        fs.closeSync(fd);
      }
      return { acquired: true, lockPath };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;

      const existing = readLockFile(lockPath);
      if (existing && isLockRecordAlive(existing)) {
        // Idempotent if the exact same job already owns this lock.
        if (jobId && existing.jobId === jobId) {
          return { acquired: true, lockPath, alreadyOwned: true };
        }
        return { acquired: false, existing, lockPath };
      }

      // Stale lock from a dead process — remove and retry atomically.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Another process may have already removed or replaced it; retry loop handles it.
      }
    }
  }

  const existing = readLockFile(lockPath);
  return { acquired: false, existing, lockPath };
}

export function updateSessionLockPid(sessionId, jobId, pid) {
  if (!sessionId || !pid) return false;
  const lockPath = getSessionLockPath(sessionId);
  const existing = readLockFile(lockPath);
  if (!existing) return false;
  if (jobId && existing.jobId && existing.jobId !== jobId) return false;
  writeJsonAtomic(lockPath, {
    ...existing,
    pid,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

export function releaseSessionLock(sessionId, jobId, { force = false } = {}) {
  if (!sessionId) return false;
  const lockPath = getSessionLockPath(sessionId);
  const existing = readLockFile(lockPath);
  if (!existing) return false;
  if (!force && jobId && existing.jobId && existing.jobId !== jobId) {
    return false;
  }
  if (!force && existing.pid && isPidAlive(existing.pid)) {
    // Refuse to drop a lock while the underlying Codex process is still running.
    return false;
  }
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
