// Optional Chromium interaction test. Pass the local Chrome/Edge executable as argv[2].
// Only this loopback fixture is served. No bridge, host SDK, or real job is started.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

function preload() {
  const A = "aaaa0000-source";
  const B = "bbbb0000-target";
  const state = {
    codex: { found: true, version: "codex-cli 0.171" }, pluginVersion: "1.5.0",
    settings: { language: "zh", sandbox: "read-only" }, models: [], goalsStore: { goals: [] },
    jobs: [
      { id: "live", conversationId: B, status: "running", eventCount: 17, prompt: "本地任务", cwd: "/project/local" },
      { id: "old", conversationId: A, sessionId: "22222222-aaaa-4222-8222-aaaaaaaaaaaa",
        cwd: "D:\\project\\api", status: "failed", sandbox: "workspace-write", callbackStatus: "failed",
        prompt: "<img src=x onerror=no()> " + "长文本 Long prompt with line breaks.\n".repeat(8) },
    ],
    history: [
      { jobId: "old", durationMs: 1250, usage: { input_tokens: 310, output_tokens: 22 }, model: "m1" },
      ...Array.from({ length: 9 }, (_, i) => ({ conversationId: A, at: new Date(i).toISOString(),
        sessionId: "sync-" + i, status: "completed", promptPreview: "Sync run " + i, executionKind: "sync" })),
      { at: "2024-01-01", status: "completed", prompt: "Unbound" },
    ],
  };
  const fixture = window.fixture = { state, resumes: [], send: async () => ({ ok: true }) };
  // Drive polling explicitly, so the test also controls the response order.
  const interval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...args) => {
    if (ms !== 6000) return interval(fn, ms, ...args);
    fixture.poll = fn;
    return 0;
  };
  window.sidecar = {
    conversationId: B,
    agent: { sendMessage: (...args) => fixture.send(...args) },
    async fetch(url, options = {}) {
      const body = JSON.parse(options.body || "{}");
      if (url.startsWith("/api/state")) {
        const snapshot = Response.json(state);
        if (fixture.holdRead) {
          fixture.holdRead = false;
          await new Promise(resolve => { fixture.releaseRead = resolve; });
        }
        return snapshot;
      }
      if (url === "/api/settings" || url === "/api/reset") {
        if (fixture.holdWrite) {
          fixture.holdWrite = false;
          await new Promise(resolve => { fixture.releaseWrite = resolve; });
        }
        state.settings = url === "/api/reset" ? { language: "zh", sandbox: "read-only" } : { ...state.settings, ...body };
        return Response.json({ ok: true, settings: state.settings });
      }
      if (url === "/api/jobs/resume") {
        fixture.resumes.push(body);
        if (body.keepOriginalCallback || body.transferCallback) return Response.json({ ok: true, job: { id: "child" } });
        return Response.json({ ok: false, code: "CROSS_CONVERSATION_RESUME", jobId: "old",
          sourceConversationId: A, targetConversationId: B }, { status: 409 });
      }
      return Response.json({ ok: false, error: "fixture action rejected" });
    },
  };
}

async function exercise(width) {
  const $ = selector => document.querySelector(selector);
  const all = selector => [...document.querySelectorAll(selector)];
  const wait = async (fn, description) => {
    for (let n = 0; n < 100; n++) {
      if (fn()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error(description);
  };
  const check = (condition, description) => { if (!condition) throw Error(description); };
  const click = selector => $(selector).click();
  const ready = () => !$("#history-more").hidden;
  const layout = () => {
    check(innerWidth === width, "viewport width " + innerWidth + " expected " + width);
    check(document.documentElement.scrollWidth <= innerWidth, "horizontal overflow");
  };
  const scope = name => click('[data-scope="' + name + '"]');
  const filter = name => click('[data-filter="' + name + '"]');
  const action = name => all(".task-action").find(b => JSON.parse(b.dataset.key)[1] === name);
  const modal = $("#route-modal");
  const draft = $("#quick-task");
  const dispatch = async () => {
    click("#btn-send-task");
    await wait(() => !$("#btn-send-task").disabled, "send did not settle");
  };
  const cfg = window.fixture;
  await wait(() => $("#tab-badge").textContent === "1", "initial render");
  layout();
  click('[data-tab="goals"]');
  check($("#tab-badge").classList.contains("local") && $("#jobs-list .event-count").textContent.includes("17"), "local active event count");
  check(!$("#history-list .task-card"), "initial local scope");
  scope("all");
  check(ready() && all("#history-list .task-card").length === 8, "history initial page");
  click("#history-more");
  check(all("#history-list .task-card").length === 11 && !$("#history-less").hidden, "expanded history");
  click("#history-less");
  check(all("#history-list .task-card").length === 8, "collapsed page");
  filter("failure");
  check(all("#history-list .task-card").length === 1 && $("#history-list .tokens").textContent.includes("310"), "merged metrics");
  const group = $("#history-list .group-head");
  check(group.textContent.includes("#aaaa0000") && group.textContent.includes("api"), "group label");
  group.click();
  check(!$("#history-list .task-card"), "collapsed conversation");
  click("#history-list .group-head");
  const prompt = $("#history-list .task-prompt");
  const toggle = prompt.nextElementSibling;
  await wait(() => !toggle.hidden, "long prompt has no expander");
  check(!prompt.querySelector("img") && prompt.textContent.startsWith("<img"), "prompt text escaped");
  const height = prompt.offsetHeight;
  toggle.click();
  check(prompt.offsetHeight > height, "prompt did not expand");
  toggle.click();
  layout();
  action("retry").click();
  await wait(() => $("#toast").textContent.includes("fixture action rejected"), "business error reason missing");
  for (const choice of ["cancel", "backdrop", "dismiss", "keep", "transfer"]) {
    const before = cfg.resumes.length;
    action("resume").click();
    await wait(() => modal.open, "route dialog did not open");
    check($("#route-job").textContent === "old" && $("#route-cwd").textContent === "D:\\project\\api", "routing job fields");
    check($("#route-source").textContent === "aaaa0000-source" && $("#route-target").textContent === "bbbb0000-target", "routing identities");
    check(document.activeElement.value === "keep", "default confirmation");
    if (choice === "dismiss") modal.requestClose();
    else if (choice === "backdrop") modal.click();
    else click('#route-modal [value="' + choice + '"]');
    await wait(() => !modal.open && !action("resume").disabled, "resume " + choice + " did not settle (open=" + modal.open + ", disabled=" + action("resume").disabled + ")");
    const confirmed = ["keep", "transfer"].includes(choice);
    check(cfg.resumes.length === before + (confirmed ? 2 : 1), "resume request count");
    if (confirmed) {
      const key = choice === "keep" ? "keepOriginalCallback" : "transferCallback";
      const payload = cfg.resumes.at(-1);
      check(payload[key] === true && Object.keys(payload).length === 3 && payload.conversationId === "bbbb0000-target", "exclusive routing choice");
      check($("#toast").textContent.includes(choice === "keep" ? "保留" : "转绑"), "routing toast");
    }
  }
  scope("current");
  window.sidecar.conversationId = "empty";
  await cfg.poll();
  check(!$("#view-all").hidden && $("#view-all").textContent.includes("12"), "empty local escape");
  click("#view-all");
  check($('[data-scope="all"]').getAttribute("aria-pressed") === "true", "empty escape scope");
  scope("current");
  window.sidecar.conversationId = "";
  await cfg.poll();
  check($('[data-scope="current"]').disabled && $('[data-scope="all"]').getAttribute("aria-pressed") === "true", "standalone scope");
  click('[data-tab="control"]');
  draft.value = "preserve draft";
  await dispatch();
  check(draft.value === "preserve draft", "standalone lost draft");
  window.sidecar.conversationId = "bbbb0000-target";
  cfg.send = async () => ({ ok: false, error: "host rejected" });
  await dispatch();
  check(draft.value === "preserve draft" && $("#toast").textContent.includes("host rejected"), "send rejection lost draft or reason");
  cfg.send = async () => { draft.value = "new edit"; return { ok: true }; };
  await dispatch();
  check(draft.value === "new edit", "successful send erased a newer edit");
  cfg.send = async () => ({ ok: true });
  await dispatch();
  check(draft.value === "", "successful dispatch retained its submitted draft");

  cfg.holdRead = true;
  const old = cfg.poll();
  cfg.state.jobs[0].eventCount = 28;
  await cfg.poll();
  cfg.releaseRead();
  await old;
  check($("#jobs-list .event-count").textContent.includes("28"), "older snapshot won");
  cfg.holdWrite = true;
  click('[data-sandbox="workspace-write"]');
  await wait(() => cfg.releaseWrite, "settings not in flight");
  cfg.holdRead = true;
  const during = cfg.poll();
  cfg.releaseWrite();
  await wait(() => $('[data-sandbox="workspace-write"]').classList.contains("active"), "settings not saved");
  cfg.releaseRead();
  await during;
  check($('[data-sandbox="workspace-write"]').classList.contains("active"), "stale poll reverted settings");
  cfg.holdRead = true;
  const beforeReset = cfg.poll();
  click("#btn-reset");
  await wait(() => $('[data-sandbox="read-only"]').classList.contains("active"), "reset failed");
  cfg.releaseRead();
  await beforeReset;
  check($('[data-sandbox="read-only"]').classList.contains("active"), "stale poll reverted reset");
  click("#btn-lang");
  await wait(() => document.documentElement.lang === "en", "English toggle");
  click('[data-tab="goals"]');
  scope("all");
  check($("#history-heading").textContent === "Task history" && $("#route-title").textContent.includes("result"), "English history/dialog");
  layout();
}

const executable = process.argv[2];
assert.ok(executable, "Pass the path to a Chromium-based browser executable");
const staticFiles = new Map();
for (const file of ["index.html", "app.js", "styles.css", "i18n.mjs", "view-model.mjs"]) {
  staticFiles.set("/" + file, await readFile(new URL("../sidecars/codex_panel/" + file, import.meta.url), "utf8"));
}
staticFiles.set("/app.js", [
  "(() => {",
  '"use strict";',
  staticFiles.get("/i18n.mjs").replace(/^export\s+/gm, ""),
  staticFiles.get("/view-model.mjs").replace(/^export\s+/gm, ""),
  staticFiles.get("/app.js").replace(/^import\s+[\s\S]*?from\s+["']\.\/[^"']+["'];?\r?\n/gm, ""),
  "})();",
].join("\n"));
let finishExercise;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  if (pathname === "/wait-for-exercise") {
    finishExercise = () => res.end();
    return;
  }
  if (pathname === "/finished") {
    finishExercise?.();
    res.end();
    return;
  }
  let body = staticFiles.get(pathname);
  let type = pathname.endsWith(".css") ? "text/css" : "application/javascript";
  if (pathname === "/") {
    type = "text/html";
    const width = Number(url.searchParams.get("width"));
    body = '<body><img hidden src="/wait-for-exercise"><iframe style="border:none" width="' + width + '" height="860" src="/panel?width=' + width + '"></iframe></body>';
  } else if (pathname === "/panel") {
    type = "text/html";
    body = staticFiles.get("/index.html").replace("</body>", '<script type="module" src="/exercise.js"></script></body>');
  } else if (pathname === "/preload.js") body = "(" + preload + ")()";
  else if (pathname === "/exercise.js") {
    body = "(" + exercise + ")(Number(new URL(location.href).searchParams.get('width')))" +
      ".then(() => top.document.body.dataset.result = 'passed')" +
      ".catch(e => top.document.body.dataset.failure = e.stack).finally(() => fetch('/finished'))";
  }
  res.writeHead(body === undefined ? 404 : 200, { "Content-Type": type + "; charset=utf-8" });
  res.end(body);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(path.join(tmpdir(), "bridge-panel-browser-"));
try {
  for (const width of [360, 480]) {
    const { stdout } = await promisify(execFile)(executable, ["--headless", "--disable-gpu", "--no-first-run",
      "--disable-background-networking", "--disable-extensions", "--hide-scrollbars", "--user-data-dir=" + profile,
      "--window-size=700,900", "--dump-dom",
      "http://127.0.0.1:" + server.address().port + "/?width=" + width], { timeout: 30000, maxBuffer: 4e6, windowsHide: true });
    assert.ok(stdout.includes('data-result="passed"'), stdout.match(/data-failure="([^"]*)"/)?.[1] || "Browser exercise did not complete");
    console.log(width + "px · scope, paging, prompt, callback routing, drafts, stale reads, reset and language passed");
  }
} finally {
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
}
