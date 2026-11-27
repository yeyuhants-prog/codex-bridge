import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const windowsPowerShell = path.join(process.env.SystemRoot || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

export function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === "EPERM"; }
}

export function processIdentity(pid) {
  if (!isPidAlive(pid)) return null;
  try {
    if (process.platform === "win32") {
      const script = "$p=Get-Process -Id " + pid + " -ErrorAction Stop; $p.ProcessName; $p.StartTime.ToUniversalTime().Ticks.ToString()";
      const [name, started] = execFileSync(windowsPowerShell, ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/);
      return started ? { pid, name: name.toLowerCase(), started } : null;
    }
    if (process.platform === "linux") {
      const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return { pid, started, name: path.basename(fs.readlinkSync("/proc/" + pid + "/exe")) };
    }
    const row = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="],
      { encoding: "utf8", timeout: 2000 }).trim();
    const parts = row.match(/^(.+?\d{4})\s+(.+)$/);
    return parts ? { pid, started: parts[1], name: path.basename(parts[2]) } : null;
  } catch { return null; }
}

export function matchesProcess(expected, current) {
  return Boolean(expected?.started && current && current.pid === expected.pid &&
    current.started === expected.started && current.name === expected.name);
}

let own;
export function ownerIdentity(pid = process.pid) {
  if (pid !== process.pid) return processIdentity(pid);
  if (own === undefined) own = processIdentity(pid);
  return own;
}
