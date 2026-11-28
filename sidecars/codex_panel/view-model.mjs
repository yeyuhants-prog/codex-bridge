const activeStates = new Set(["running", "running_detached", "stopping"]);
const terminalStates = new Set(["completed", "failed", "timed_out", "cancelled", "interrupted"]);

export const isActive = row => activeStates.has(row.status);
export const conversationOf = row => row.conversationId || row.callbackTarget?.conversationId || "";
export const shortId = id => "#" + id.slice(0, 8);

function timestamp(row) {
  return Date.parse(row.finishedAt || row.at || row.startedAt) || 0;
}

function legacyMatch(record, candidates) {
  if (!record.sessionId || record.executionKind === "sync" || record.mode === "review") return null;
  const matches = candidates.filter(job =>
    job.sessionId?.toLowerCase() === record.sessionId.toLowerCase() &&
    (!record.conversationId || !conversationOf(job) || conversationOf(job) === record.conversationId) &&
    (!record.cwd || !job.cwd || record.cwd === job.cwd) &&
    (!record.mode || !job.mode || job.mode === record.mode) &&
    (!record.status || record.status === job.status) &&
    (!record.promptPreview || !job.promptPreview || job.promptPreview.startsWith(record.promptPreview) ||
      record.promptPreview.startsWith(job.promptPreview)) &&
    (!job.finishedAt || !record.at || Math.abs(Date.parse(job.finishedAt) - Date.parse(record.at)) < 2000));
  return matches.length === 1 ? matches[0] : null;
}

export function historyKey(row) {
  return "history:" + (row.historyKey || row.jobId || JSON.stringify([row.sessionId, row.at, row.mode, row.conversationId, row.promptPreview || row.prompt]));
}

// Session IDs identify threads. A legacy match must identify one execution
// in both directions, even when several resumes ran in the same thread.
export function taskRows(jobs = [], history = []) {
  const records = new Map();
  const jobIds = new Set(jobs.map(job => job.id));
  const unmatched = new Map();
  for (const row of history) {
    if (row.jobId && jobIds.has(row.jobId)) {
      if (!records.has(row.jobId)) records.set(row.jobId, row);
      continue;
    }
    const key = historyKey(row);
    if (!unmatched.has(key)) unmatched.set(key, row);
  }

  const candidates = jobs.filter(job => !records.has(job.id) && terminalStates.has(job.status));
  const matches = new Map();
  for (const [key, record] of unmatched) {
    if (record.jobId) continue;
    const job = legacyMatch(record, candidates);
    if (job) matches.set(job.id, matches.has(job.id) ? null : key);
  }
  for (const [jobId, key] of matches) {
    if (key === null) continue;
    records.set(jobId, unmatched.get(key));
    unmatched.delete(key);
  }

  const rows = [];
  for (const job of jobs) {
    if (!isActive(job) && !terminalStates.has(job.status)) continue;
    const record = records.get(job.id);
    rows.push({
      ...record, ...job, key: job.id, kind: "job", historyKey: record ? historyKey(record) : null,
      archived: Boolean(job.archived || record?.archived), archivedAt: job.archivedAt || record?.archivedAt || null,
      conversationId: conversationOf(job) || (record && conversationOf(record)) || "",
      sessionId: job.sessionId || record?.sessionId,
      durationMs: job.durationMs ?? record?.durationMs, usage: job.usage ?? record?.usage,
      model: job.model || record?.model, reasoningEffort: job.reasoningEffort || record?.reasoningEffort,
      prompt: job.prompt || record?.prompt, promptPreview: job.promptPreview || record?.promptPreview
    });
  }
  for (const [key, record] of unmatched) {
    const status = record.status || "completed";
    if (!terminalStates.has(status)) continue;
    rows.push({ ...record, status, key, historyKey: key, archived: Boolean(record.archived), archivedAt: record.archivedAt || null,
      kind: record.jobId ? "archived" : "sync", conversationId: conversationOf(record) });
  }
  return rows.sort((a, b) => timestamp(b) - timestamp(a));
}

export function groupsFor(rows, current) {
  const groups = new Map();
  for (const row of rows) {
    const id = conversationOf(row);
    if (!groups.has(id)) groups.set(id, { id, rows: [], directories: new Map() });
    const group = groups.get(id);
    group.rows.push(row);
    const name = row.cwd?.split(/[\\/]/).filter(Boolean).at(-1);
    if (name) group.directories.set(name, (group.directories.get(name) || 0) + 1);
  }
  const priority = id => !id ? 2 : id === current ? 0 : 1;
  return [...groups.values()].sort((a, b) => priority(a.id) - priority(b.id)).map(group => ({
    id: group.id, rows: group.rows,
    directory: [...group.directories].sort((a, b) => b[1] - a[1])[0]?.[0] || ""
  }));
}

export function taskView(rows, current, scope, filter) {
  const local = current ? rows.filter(row => conversationOf(row) === current) : [];
  const visible = current && scope === "current" ? local : rows;
  const finished = visible.filter(row => !isActive(row));
  const history = finished.filter(row => !row.archived);
  const archived = finished.filter(row => row.archived);
  return {
    total: rows.length, currentCount: local.length, historyCount: history.length, archivedCount: archived.length,
    active: groupsFor(visible.filter(isActive), current),
    history: groupsFor(filter === "archived" ? archived : history.filter(row => filter === "all" ||
      (filter === "success" ? row.status === "completed" : ["failed","timed_out","interrupted"].includes(row.status))), current)
  };
}

export async function responseData(response) {
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error("HTTP " + response.status + " · " + raw.slice(0, 120)); }
  if (!response.ok || data?.ok === false) {
    throw Object.assign(new Error(data?.error || data?.message || data?.code || "HTTP " + response.status),
      { status: response.status, data });
  }
  return data;
}
