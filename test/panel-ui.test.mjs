import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { taskRows, taskView, groupsFor, responseData } from "../sidecars/codex_panel/view-model.mjs";
import { I18N } from "../sidecars/codex_panel/i18n.mjs";

const files = name => readFileSync(new URL("../sidecars/codex_panel/" + name, import.meta.url), "utf8");
const ids = groups => groups.flatMap(group => group.rows.map(row => row.id));
const jobs = [
  { id: "a", callbackTarget: { conversationId: "B" }, cwd: "D:\\test\\backend", status: "running" },
  { id: "b", conversationId: "A", cwd: "/test/front", status: "stopping" },
  { id: "c", conversationId: "B", cwd: "/test/backend", status: "completed" },
  { id: "d", conversationId: "B", cwd: "/test/docs", status: "timed_out" },
  { id: "e", status: "running_detached" },
  { id: "f", status: "interrupted" },
  { id: "g", status: "cancelled" },
  { id: "h", status: "failed" },
];

test("current, all and standalone panel scopes use the same conversation owner and counts", () => {
  const rows = taskRows(jobs);
  const current = taskView(rows, "A", "current", "all");
  assert.deepEqual(ids(current.active), ["b"]);
  assert.equal(current.currentCount, 1);
  assert.equal(current.total, 8);
  assert.equal(current.historyCount, 0);
  const groups = groupsFor(rows, "A");
  assert.deepEqual(groups.map(g => g.id), ["A", "B", ""]);
  assert.equal(groups[1].directory, "backend");
  assert.deepEqual(taskView(rows, "", "current", "all").active, taskView(rows, "", "all", "all").active);
});

test("active and history sections partition executions, with state-specific filters", () => {
  const view = filter => taskView(taskRows(jobs), "A", "all", filter);
  assert.deepEqual(ids(view("all").active), ["b", "a", "e"]);
  assert.deepEqual(ids(view("all").history), ["c", "d", "f", "g", "h"]);
  assert.deepEqual(ids(view("success").history), ["c"]);
  assert.deepEqual(ids(view("failure").history), ["d", "f", "h"]);
  assert.equal(view("failure").historyCount, 5);
});

test("explicit job IDs reserve the execution and merge its measurements exactly once", () => {
  const job = { id: "J", status: "completed", sessionId: "sid", conversationId: "A", durationMs: null, model: "" };
  const metrics = { jobId: "J", sessionId: "sid", model: "m", reasoningEffort: "high", durationMs: 0, usage: { input_tokens: 7, output_tokens: 0 } };
  const rows = taskRows([job], [{ executionKind: "sync", sessionId: "sid", at: "2026-01-01" }, metrics, metrics]);
  assert.equal(rows.length, 2);
  const merged = rows.find(row => row.kind === "job");
  for (const field of ["model", "reasoningEffort", "durationMs", "usage"]) assert.deepEqual(merged[field], metrics[field]);
  assert.equal(merged.conversationId, "A");
  assert.equal(rows.filter(row => row.kind === "sync").length, 1);
});

test("unique compatible legacy session matches, ambiguous or differently owned resumes stay separate", () => {
  const job = { id: "J", status: "completed", sessionId: "ABC", conversationId: "A" };
  const record = { sessionId: "abc", model: "history-model" };
  assert.equal(taskRows([job], [record])[0].model, "history-model");
  assert.equal(taskRows([job, { ...job, id: "K" }], [record]).length, 3);
  assert.equal(taskRows([job], [{ ...record, at: "2024-01-01" }, { ...record, at: "2024-01-02" }]).length, 3);
  assert.equal(taskRows([job], [{ ...record, conversationId: "B" }]).length, 2);
  assert.equal(taskRows([job], [{ ...record, jobId: "archived" }]).filter(r => r.kind === "archived").length, 1);
  assert.equal(taskRows([job], [{ ...record, executionKind: "sync" }]).length, 2);
  assert.equal(taskRows([job], [{ ...record, at: "2026-01-01", executionKind: "sync" },
    { ...record, at: "2026-01-02", executionKind: "sync" }]).length, 3);
});

test("archived executions stay out of normal filters and are counted once per conversation", () => {
  const archivedAt = "2026-01-01T12:00:00Z";
  const rows = taskRows([
    { id: "live", conversationId: "A", archived: true, status: "running" },
    { id: "merged", conversationId: "A", status: "failed", archived: false },
    { id: "done", conversationId: "B", status: "completed", archived: true, archivedAt },
    { id: "open", conversationId: "A", status: "completed" },
  ], [{ jobId: "merged", archived: true, archivedAt }, { conversationId: "A", status: "completed", archived: true }]);
  const view = (filter, scope = "all") => taskView(rows, "A", scope, filter);
  assert.deepEqual(ids(view("all").history), ["open"]);
  assert.deepEqual(ids(view("success").history), ["open"]);
  assert.deepEqual(ids(view("failure").history), []);
  assert.deepEqual(ids(view("archived").active), ["live"]);
  assert.equal(view("all").historyCount, 1);
  assert.equal(view("all").archivedCount, 3);
  assert.equal(view("archived", "current").archivedCount, 2);
  const merged = rows.find(r => r.id === "merged");
  assert.equal(merged.archivedAt, archivedAt);
  assert.equal(merged.archived, true);
  assert.equal(view("archived").history.flatMap(g => g.rows).length, 3);
});

test("legacy execution keys remain stable when archive state changes", () => {
  const record = { sessionId: "thread", at: "2026-01-01", mode: "resume", prompt: "continue" };
  const [before] = taskRows([], [record]);
  const [after] = taskRows([], [{ ...record, archived: true, archivedAt: record.at }]);
  assert.equal(after.key, before.key);
  assert.equal(after.historyKey, before.key);
  assert.equal(before.archivedAt, null);
  assert.equal(after.kind, "sync");
});

test("API errors retain the backend reason, HTTP status and routing conflict fields", async () => {
  for (const status of [200, 400, 404, 409, 500]) {
    const data = { ok: false, error: "reason", code: "CROSS_CONVERSATION_RESUME", jobId: "J" };
    await assert.rejects(responseData(new Response(JSON.stringify(data), { status })), err => {
      assert.equal(err.message, data.error);
      assert.equal(err.status, status);
      assert.deepEqual(err.data, data);
      return true;
    });
  }
  assert.deepEqual(await responseData(new Response('{"ok":true}')), { ok: true });
  await assert.rejects(responseData(new Response("invalid")), /HTTP 200/);
});

test("all translation keys and types match across languages including nested status tables", () => {
  function compare(a, b) {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
    for (const key of Object.keys(a)) {
      assert.equal(typeof a[key], typeof b[key], key);
      if (typeof a[key] === "object") compare(a[key], b[key]);
    }
  }
  compare(I18N.en, I18N.zh);
  for (const [, key] of files("index.html").matchAll(/data-i18n(?:-aria|-placeholder)?="([^"]+)"/g)) {
    assert.equal(typeof I18N.zh[key], "string", key);
  }
  for (const [, key] of files("app.js").matchAll(/\b(?:dict|d|t\(\))\.(\w+)/g)) {
    assert.ok(Object.hasOwn(I18N.en, key), key);
  }
});

test("HTML IDs are unique, script and accessibility references resolve, and modules are served", () => {
  const html = files("index.html");
  const script = files("app.js");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, id] of script.matchAll(/getElementById\("([^"]+)"\)/g)) assert.ok(ids.includes(id), id);
  for (const [, id] of html.matchAll(/(?:for|aria-labelledby|aria-describedby|aria-controls)="([^"]+)"/g)) assert.ok(ids.includes(id), id);
  assert.match(html, /<script src="\/app\.js"><\/script>/);
  for (const [, file] of script.matchAll(/from "\.\/([^"]+)"/g)) {
    assert.ok(files("main.mjs").includes(JSON.stringify(file)), file);
    assert.ok(files(file).length);
  }
});

test("untrusted content uses text DOM operations and routing confirmation uses a styled dialog", () => {
  const source = ["app.js", "view-model.mjs", "i18n.mjs", "index.html"].map(files).join("\n");
  assert.doesNotMatch(source, /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(|\b(?:alert|confirm)\s*\(/);
  assert.match(source, /<dialog id="route-modal"/);
});
