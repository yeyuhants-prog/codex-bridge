import { I18N } from "./i18n.mjs";
import { taskRows, taskView, conversationOf, isActive, shortId, responseData } from "./view-model.mjs";

const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

let state = null;
let toastTimer = null;
let scope = "current";
let historyFilter = "all";
const pageSize = 8;
let historyLimit = pageSize;
const collapsed = new Set();
const expanded = new Set();
const busy = new Set();
let stateReqSeq = 0;
let settingsVersion = 0;
let pendingSettings = 0;
let settingsQueue = Promise.resolve();

const el = {
  scope: document.getElementById("task-scope"),
  all: document.getElementById("view-all"),
  filter: document.getElementById("history-filter"),
  more: document.getElementById("history-more"),
  less: document.getElementById("history-less"),
  dialog: document.getElementById("route-modal"),
  statusPill: document.getElementById("status-pill"),
  codexMeta: document.getElementById("codex-meta"),
  toast: document.getElementById("toast"),
  btnLang: document.getElementById("btn-lang"),
  tabs: document.querySelectorAll(".tab"),
  tabBadge: document.getElementById("tab-badge"),
  panelControl: document.getElementById("panel-control"),
  panelGoals: document.getElementById("panel-goals"),
  roleGroup: document.getElementById("role-group"),
  modelSelect: document.getElementById("model-select"),
  modelDefaultHint: document.getElementById("model-default-hint"),
  modelDesc: document.getElementById("model-desc"),
  effortGroup: document.getElementById("effort-group"),
  effortHint: document.getElementById("effort-hint"),
  effortDesc: document.getElementById("effort-desc"),
  progressionGroup: document.getElementById("progression-group"),
  bindBadge: document.getElementById("bind-badge"),
  maxIterInput: document.getElementById("max-iter-input"),
  sandboxGroup: document.getElementById("sandbox-group"),
  workflowGroup: document.getElementById("workflow-group"),
  toggleEphemeral: document.getElementById("toggle-ephemeral"),
  quickTask: document.getElementById("quick-task"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnReset: document.getElementById("btn-reset"),
  btnSendTask: document.getElementById("btn-send-task"),
  btnCheckStatus: document.getElementById("btn-check-status"),
  btnToggleNewGoal: document.getElementById("btn-toggle-new-goal"),
  newGoalForm: document.getElementById("new-goal-form"),
  goalTitle: document.getElementById("goal-title"),
  goalCwd: document.getElementById("goal-cwd"),
  goalMilestones: document.getElementById("goal-milestones"),
  btnCancelGoal: document.getElementById("btn-cancel-goal"),
  goalSelectorRow: document.getElementById("goal-selector-row"),
  goalSelect: document.getElementById("goal-select"),
  activeGoalView: document.getElementById("active-goal-view"),
  jobsCount: document.getElementById("jobs-count"),
  jobsList: document.getElementById("jobs-list"),
  historyCount: document.getElementById("history-count"),
  historyList: document.getElementById("history-list"),
};

function getLang() {
  return state?.settings?.language === "en" ? "en" : "zh";
}

function t() {
  return I18N[getLang()];
}

function applyStaticI18n() {
  const dict = t();
  document.documentElement.lang = getLang() === "en" ? "en" : "zh-CN";
  el.btnLang.textContent = dict.langToggle;
  el.btnLang.title = dict.langToggleTitle;
  el.btnRefresh.title = dict.refreshTitle;

  for (const node of document.querySelectorAll("[data-i18n]")) {
    const key = node.dataset.i18n;
    if (typeof dict[key] === "string") {
      node.textContent = dict[key];
    }
  }
  for (const node of document.querySelectorAll("[data-i18n-aria]")) {
    node.setAttribute("aria-label", dict[node.dataset.i18nAria]);
  }
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
    const key = node.dataset.i18nPlaceholder;
    if (typeof dict[key] === "string") {
      node.placeholder = dict[key];
    }
  }
}

function apiFetch(url, options = {}) {
  if (window.sidecar && typeof window.sidecar.fetch === "function") {
    return window.sidecar.fetch(url, options);
  }
  return fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
}

async function apiJson(url, options = {}) {
  return responseData(await apiFetch(url, options));
}

function post(url, data) {
  return apiJson(url, { method: "POST", body: JSON.stringify(data) });
}

function getCurrentConvId() {
  return window.sidecar?.conversationId || "";
}

function showToast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle("error", isError);
  el.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.add("hidden");
  }, 2600);
}

function switchTab(tab) {
  for (const btn of el.tabs) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
    btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
    btn.tabIndex = btn.dataset.tab === tab ? 0 : -1;
  }
  el.panelControl.classList.toggle("hidden", tab !== "control");
  el.panelGoals.classList.toggle("hidden", tab !== "goals");
}

for (const btn of el.tabs) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  btn.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? el.tabs[0] : event.key === "End" ? el.tabs[1] : [...el.tabs].find(tab => tab !== btn);
    switchTab(next.dataset.tab);
    next.focus();
  });
}

function getSelectedModelObj() {
  if (!state) return null;
  const slug = state.settings.model || state.tomlDefaults?.model || "";
  return state.models.find((m) => m.slug === slug) || null;
}

function renderHeader() {
  const dict = t();
  const c = state.codex;
  if (c.found) {
    el.statusPill.textContent = c.version || dict.statusConnected;
    el.statusPill.className = "status-pill ok";
    el.codexMeta.textContent = `${c.source || "Codex"} · v${state.pluginVersion}`;
  } else {
    el.statusPill.textContent = dict.statusNotFound;
    el.statusPill.className = "status-pill err";
    el.codexMeta.textContent = dict.notFoundMeta;
  }

  const active = (state.jobs || []).filter(isActive);
  const current = getCurrentConvId();
  el.tabBadge.textContent = String(active.length);
  el.tabBadge.title = dict.activeCount + " · " + active.length;
  el.tabBadge.setAttribute("aria-label", el.tabBadge.title);
  el.tabBadge.classList.toggle("hidden", !active.length);
  el.tabBadge.classList.toggle("local", Boolean(current && active.some(job => conversationOf(job) === current)));
}

function renderModels() {
  const dict = t();
  const { models, settings, tomlDefaults } = state;
  const tomlModel = tomlDefaults?.model || "auto";
  el.modelDefaultHint.textContent = dict.modelDefaultHint(tomlModel);

  el.modelSelect.replaceChildren();
  const defOpt = document.createElement("option");
  defOpt.value = "";
  defOpt.textContent = dict.modelFollowDefault(tomlModel);
  el.modelSelect.appendChild(defOpt);

  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.slug;
    opt.textContent = `${m.displayName} (${m.slug})`;
    el.modelSelect.appendChild(opt);
  }

  if (settings.model && !models.some((m) => m.slug === settings.model)) {
    const customOpt = document.createElement("option");
    customOpt.value = settings.model;
    customOpt.textContent = dict.modelCustom(settings.model);
    el.modelSelect.appendChild(customOpt);
  }

  el.modelSelect.value = settings.model || "";
  const activeModel = getSelectedModelObj();
  el.modelDesc.textContent = activeModel?.description || "";
}

function renderEfforts() {
  const dict = t();
  const { settings, tomlDefaults } = state;
  const activeModel = getSelectedModelObj();
  const supported =
    activeModel?.efforts?.length > 0
      ? activeModel.efforts
      : FALLBACK_EFFORTS.map((e) => ({ effort: e, description: "" }));

  const defaultEffortLabel =
    tomlDefaults?.reasoningEffort || activeModel?.defaultEffort || "auto";
  el.effortHint.textContent = dict.effortHint(defaultEffortLabel);

  el.effortGroup.replaceChildren();
  const items = [
    { effort: "", description: dict.effortFollowDesc(defaultEffortLabel) },
    ...supported,
  ];

  let activeDesc = "";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pill-btn";
    const isActive = (settings.reasoningEffort || "") === item.effort;
    if (isActive) {
      btn.classList.add("active");
      activeDesc = item.description || "";
    }
    btn.textContent = dict.efforts[item.effort] || item.effort;
    btn.addEventListener("click", () => {
      updateSetting({ reasoningEffort: item.effort });
    });
    el.effortGroup.appendChild(btn);
  }
  el.effortDesc.textContent = activeDesc;
}

function renderSegments() {
  const dict = t();
  const { settings } = state;
  for (const btn of el.roleGroup.querySelectorAll(".seg-btn")) {
    btn.classList.toggle("active", btn.dataset.role === settings.roleMode);
  }
  for (const btn of el.progressionGroup.querySelectorAll(".seg-btn")) {
    btn.classList.toggle(
      "active",
      btn.dataset.progression === settings.progressionMode
    );
  }
  for (const btn of el.sandboxGroup.querySelectorAll(".seg-btn")) {
    btn.classList.toggle("active", btn.dataset.sandbox === settings.sandbox);
  }
  for (const btn of el.workflowGroup.querySelectorAll(".seg-btn")) {
    btn.classList.toggle(
      "active",
      btn.dataset.workflow === settings.workflowMode
    );
  }
  el.toggleEphemeral.checked = Boolean(settings.ephemeral);
  el.maxIterInput.value = String(settings.maxAutoIterations || 12);

  for (const btn of el.panelControl.querySelectorAll(".seg-btn, .pill-btn")) {
    btn.setAttribute("aria-pressed", String(btn.classList.contains("active")));
  }
  el.bindBadge.textContent = dict.perJobRoutingBadge;
  el.bindBadge.className = "hint ok";
}

function renderGoals() {
  const dict = t();
  const store = state.goalsStore || { activeGoalId: null, goals: [] };
  const goals = store.goals || [];
  const activeGoal =
    goals.find((g) => g.id === store.activeGoalId) || goals[0] || null;

  if (goals.length > 1) {
    el.goalSelectorRow.classList.remove("hidden");
    el.goalSelect.replaceChildren();
    for (const g of goals) {
      const opt = document.createElement("option");
      opt.value = g.id;
      const done = g.milestones.filter((m) => m.status === "done").length;
      opt.textContent = `[${dict.taskStatuses[g.status] || g.status}] ${g.title} (${done}/${g.milestones.length})`;
      el.goalSelect.appendChild(opt);
    }
    if (activeGoal) el.goalSelect.value = activeGoal.id;
  } else {
    el.goalSelectorRow.classList.add("hidden");
  }

  el.activeGoalView.replaceChildren();
  if (!activeGoal) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = dict.emptyGoal;
    el.activeGoalView.appendChild(empty);
    return;
  }

  const doneCount = activeGoal.milestones.filter((m) => m.status === "done").length;
  const totalCount = activeGoal.milestones.length;
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const header = document.createElement("div");
  header.className = "goal-header";
  const left = document.createElement("div");
  const title = document.createElement("div");
  title.className = "goal-title";
  title.textContent = activeGoal.title;
  const meta = document.createElement("div");
  meta.className = "goal-meta";
  meta.textContent = dict.goalMeta(
    activeGoal.id,
    doneCount,
    totalCount,
    activeGoal.iterationCount || 0,
    activeGoal.maxIterations || 12
  );
  left.append(title, meta);

  const badge = document.createElement("span");
  badge.className = `badge ${activeGoal.status}`;
  badge.textContent = dict.taskStatuses[activeGoal.status] || activeGoal.status;
  header.append(left, badge);

  const track = document.createElement("div");
  track.className = "progress-track";
  const fill = document.createElement("div");
  fill.className = "progress-fill";
  fill.style.width = `${pct}%`;
  track.appendChild(fill);

  const msList = document.createElement("div");
  msList.className = "milestone-list";
  const msIcons = {
    pending: "",
    in_progress: "…",
    done: "✓",
    blocked: "!",
    skipped: "–",
  };
  for (const ms of activeGoal.milestones) {
    const row = document.createElement("div");
    row.className = "milestone-item";

    const statusIcon = document.createElement("span");
    statusIcon.className = `ms-check ${ms.status}`;
    statusIcon.textContent = msIcons[ms.status] || "";
    const statusLabel = dict.taskStatuses[ms.status] || ms.status;
    statusIcon.title = `${ms.title} · ${statusLabel}`;
    statusIcon.setAttribute("aria-label", statusLabel);

    const body = document.createElement("div");
    body.className = "ms-body";
    const titleEl = document.createElement("div");
    titleEl.className = `ms-title ${ms.status === "done" ? "done" : ""}`;
    titleEl.textContent = `${ms.id}. ${ms.title}`;
    body.appendChild(titleEl);

    if (ms.verification || ms.notes) {
      const sub = document.createElement("div");
      sub.className = "ms-sub";
      sub.textContent = [
        ms.verification ? `${dict.msVerifyPrefix}${ms.verification}` : "",
        ms.notes ? `${dict.msNotesPrefix}${ms.notes}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      body.appendChild(sub);
    }

    row.append(statusIcon, body);
    msList.appendChild(row);
  }

  const actions = document.createElement("div");
  actions.className = "goal-actions";

  const btnContinue = document.createElement("button");
  btnContinue.type = "button";
  btnContinue.className = "primary-btn";
  btnContinue.textContent = dict.continueGoalBtn;
  btnContinue.addEventListener("click", async () => {
    await sendToConversation(
      t().msgContinueGoal(
        activeGoal.id,
        activeGoal.title,
        state.settings.progressionMode
      )
    );
  });
  actions.appendChild(btnContinue);

  const btnPause = document.createElement("button");
  btnPause.type = "button";
  btnPause.className = "mini-btn";
  const isPaused = activeGoal.status === "paused";
  btnPause.textContent = isPaused ? dict.resumeGoalBtn : dict.pauseGoalBtn;
  btnPause.addEventListener("click", async () => {
    try {
      const nextStatus = isPaused ? "active" : "paused";
      await apiJson("/api/goals/status", {
        method: "POST",
        body: JSON.stringify({ goalId: activeGoal.id, status: nextStatus }),
      });
      await fetchState(true);
      showToast(isPaused ? t().toastGoalResumed : t().toastGoalPaused);
    } catch (err) {
      showToast(t().toastActionErr(err.message), true);
    }
  });
  actions.appendChild(btnPause);

  const btnDelete = document.createElement("button");
  btnDelete.type = "button";
  btnDelete.className = "mini-btn danger";
  btnDelete.textContent = dict.deleteBtn;
  btnDelete.addEventListener("click", async () => {
    try {
      await apiJson("/api/goals/delete", {
        method: "POST",
        body: JSON.stringify({ goalId: activeGoal.id }),
      });
      await fetchState(true);
      showToast(t().toastGoalDeleted);
    } catch (err) {
      showToast(t().toastActionErr(err.message), true);
    }
  });
  actions.appendChild(btnDelete);

  el.activeGoalView.append(header, track, msList, actions);
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function button(label, className, click) {
  const btn = node("button", className, label);
  btn.type = "button";
  btn.addEventListener("click", click);
  return btn;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.valueOf())) return "";
  return date.toLocaleString(getLang(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function chooseRouting(job, conflict) {
  if (el.dialog.open) return Promise.resolve("cancel");
  document.getElementById("route-job").textContent = conflict.jobId;
  document.getElementById("route-cwd").textContent = job.cwd || "—";
  document.getElementById("route-source").textContent = conflict.sourceConversationId;
  document.getElementById("route-target").textContent = conflict.targetConversationId;
  el.dialog.returnValue = "cancel";
  el.dialog.showModal();
  return new Promise(resolve => el.dialog.addEventListener("close", () => resolve(el.dialog.returnValue), { once: true }));
}
el.dialog.addEventListener("click", event => {
  if (event.target === el.dialog) el.dialog.close("cancel");
});

async function resumeJob(job) {
  const url = "/api/jobs/resume";
  const request = { jobId: job.id, conversationId: getCurrentConvId() };
  let result;
  let choice;
  try {
    result = await post(url, request);
  } catch (error) {
    const conflict = error.data;
    if (error.status !== 409 || conflict?.code !== "CROSS_CONVERSATION_RESUME") throw error;
    if (!conflict.sourceConversationId || !conflict.targetConversationId || conflict.jobId !== job.id ||
        (request.conversationId && conflict.targetConversationId !== request.conversationId)) {
      throw new Error(t().contextChanged);
    }
    choice = await chooseRouting(job, conflict);
    if (choice !== "keep" && choice !== "transfer") return;
    if (getCurrentConvId() !== request.conversationId) throw new Error(t().contextChanged);
    result = await post(url, { ...request, conversationId: conflict.targetConversationId,
      [choice === "keep" ? "keepOriginalCallback" : "transferCallback"]: true });
  }
  await fetchState(true);
  if (result.reused) showToast(t().toastResumedReused(result.job.id, t().taskStatuses[result.job.status] || result.job.status));
  else showToast(choice === "keep" ? t().kept : choice === "transfer" ? t().moved : t().toastResumedNew(result.job.id));
}

function jobAction(job, name, label, action, disabled = false) {
  const key = JSON.stringify([job.key, name]);
  const btn = button(label, "task-action", async () => {
    if (busy.has(key)) return;
    const restoreFocus = document.activeElement === btn;
    busy.add(key);
    btn.disabled = true;
    try {
      await action();
    } catch (err) {
      showToast(t().toastActionErr(err.message), true);
    } finally {
      busy.delete(key);
      // Polling may have replaced the button while the action was in flight.
      for (const current of document.querySelectorAll(".task-action")) {
        if (current.dataset.key !== key) continue;
        current.disabled = current.dataset.unavailable === "true";
        if (restoreFocus && document.activeElement === document.body) current.focus({ preventScroll: true });
      }
    }
  });
  btn.dataset.key = key;
  btn.dataset.unavailable = String(disabled);
  btn.disabled = disabled || busy.has(key);
  return btn;
}

function renderPrompt(card, row) {
  const prompt = node("p", "task-prompt", row.prompt || row.promptPreview || t().noPromptPreview);
  const toggle = button("", "prompt-toggle", () => {
    if (expanded.has(row.key)) expanded.delete(row.key);
    else expanded.add(row.key);
    update();
  });
  toggle.dataset.key = JSON.stringify([row.key, "prompt"]);
  function update() {
    const open = expanded.has(row.key);
    prompt.classList.toggle("expanded", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? t().fold : t().expand;
    toggle.hidden = !open && prompt.scrollHeight <= prompt.clientHeight + 1;
  }
  card.append(prompt, toggle);
  toggle.hidden = true;
  prompt.classList.toggle("expanded", expanded.has(row.key));
  promptObserver.observe(prompt);
  update();
}

const promptObserver = new ResizeObserver(entries => {
  for (const { target } of entries) {
    if (!target.isConnected) continue;
    const toggle = target.nextElementSibling;
    toggle.hidden = !target.classList.contains("expanded") && target.scrollHeight <= target.clientHeight + 1;
  }
});

function taskCard(row) {
  const d = t();
  const live = isActive(row);
  const card = node("article", live ? "task-card live" : "task-card");
  const top = node("div", "task-top");
  const badge = node("span", "badge " + row.status, d.taskStatuses[row.status]);
  if (live) badge.prepend(node("i", "pulse-dot"));
  top.append(badge);
  if (row.kind !== "job") top.append(node("span", "kind", d[row.kind]));
  if (row.id || row.jobId) {
    const id = node("span", "job-id", row.id || row.jobId);
    id.title = id.textContent;
    top.append(id);
  }
  const time = node("time", "time", formatTime(row.finishedAt || row.at || row.startedAt));
  top.append(time);
  card.append(top);
  renderPrompt(card, row);

  const meta = node("div", "task-meta");
  const add = (label, cls = "", title = "") => {
    const tag = node("span", "chip " + cls, label);
    tag.title = title || label;
    meta.append(tag);
  };
  add(row.conversationId ? shortId(row.conversationId) : d.unbound, "chat", row.conversationId);
  if (row.transferredFrom) add(d.transferred.replace("{id}", shortId(row.transferredFrom)), "transfer", row.transferredFrom);
  if (row.sandbox) add(row.sandbox, "sandbox " + row.sandbox);
  if (row.model) add(d.model + " · " + row.model);
  if (row.reasoningEffort) add(d.effort + " · " + (d.efforts[row.reasoningEffort] || row.reasoningEffort));
  if (row.durationMs != null) add(d.duration + " · " + (row.durationMs / 1000).toLocaleString(getLang(), { maximumFractionDigits: 1 }) + " s");
  if (row.usage) {
    const tokens = n => typeof n === "number" ? n.toLocaleString(getLang()) : "—";
    add("Tokens · " + d.tokensIn + " " + tokens(row.usage.input_tokens) + " / " + d.tokensOut + " " + tokens(row.usage.output_tokens), "tokens");
  }
  if (row.eventCount != null || live) add(d.events + " · " + (row.eventCount || 0), live ? "event-count" : "");
  if (row.parentJobId) add("← " + row.parentJobId);
  if (row.goalId) add([row.goalId, row.milestoneId].filter(Boolean).join(" / "));
  card.append(meta);
  if (row.cwd) {
    const cwd = node("div", "task-cwd", row.cwd);
    cwd.title = d.workdir + " · " + row.cwd;
    card.append(cwd);
  }
  if (row.status === "running_detached") card.append(node("div", "task-note", d.detachedBanner(row.pid)));
  if (!live && row.error) card.append(node("div", "task-note", row.error));
  if (row.kind === "job") {
    const cb = row.callbackStatus || (row.callbackSent ? "sent" : "skipped");
    const labels = { sent: d.cbSent, failed: d.cbFailed, unrouted: d.cbUnrouted, pending: d.cbPending, sending: d.cbSending, skipped: d.cbSkipped };
    card.append(node("div", "callback " + cb, [labels[cb] || cb, row.callbackError].filter(Boolean).join(" · ")));
  }
  const actions = node("div", "task-actions");
  if (live) {
    actions.append(jobAction(row, "check", d.checkProgressBtn, () => sendToConversation(t().msgCheckJob(row.id))),
      jobAction(row, "stop", d.stopJobBtn, async () => {
        const result = await post("/api/jobs/stop", { jobId: row.id });
        await fetchState(true);
        showToast(result.alreadyFinished ? t().alreadyFinished : t().toastStopped(row.id));
      }, row.status === "stopping"));
  } else {
    if (row.sessionId && row.sessionId !== "last") {
      if (row.kind === "job") actions.append(jobAction(row, "resume", d.resumeJobBtn, () => resumeJob(row)));
      actions.append(jobAction(row, "copy", d.copySessionBtn, async () => {
        try {
          await navigator.clipboard.writeText(row.sessionId);
          showToast(t().toastCopiedSid(row.sessionId.slice(0, 8)));
        } catch { showToast(row.sessionId); }
      }));
    }
    if (row.kind === "job" && row.notifyOnComplete !== false && ["failed", "unrouted"].includes(row.callbackStatus)) {
      actions.append(jobAction(row, "retry", d.retryCbBtn, async () => {
        await post("/api/jobs/retry-callback", { jobId: row.id });
        await fetchState(true);
        showToast(t().toastRetryOk(row.id));
      }));
    }
  }
  if (actions.childElementCount) card.append(actions);
  return card;
}

function renderGroups(list, groups, grouped, limit, emptyText) {
  list.replaceChildren();
  if (!groups.length) list.append(node("p", "empty", emptyText));
  let available = 0;
  for (const group of groups) {
    const key = JSON.stringify([list.id, group.id]);
    const closed = grouped && collapsed.has(key);
    const section = node("div", "task-group");
    if (grouped) {
      const local = group.id && group.id === getCurrentConvId();
      const heading = button("", "group-head", () => {
        if (closed) collapsed.delete(key);
        else collapsed.add(key);
        renderTasks();
      });
      heading.dataset.key = key;
      heading.setAttribute("aria-expanded", String(!closed));
      const label = local ? t().currentChat : group.id ? t().otherChat : t().unbound;
      heading.append(node("span", local ? "group-label current" : "group-label", label));
      if (group.id) heading.append(node("span", "group-id", shortId(group.id)));
      if (group.directory && group.id && !local) heading.append(node("span", "directory", group.directory));
      heading.append(node("span", "group-count", group.rows.length), node("span", "chevron", closed ? "▸" : "▾"));
      heading.title = group.id;
      section.append(heading);
    }
    if (!closed) {
      const slice = group.rows.slice(0, Math.max(0, limit - available));
      available += group.rows.length;
      for (const row of slice) section.append(taskCard(row));
      if (!slice.length) continue;
    }
    list.append(section);
  }
  return available;
}

function renderTasks() {
  const focusedKey = document.activeElement?.dataset.key;
  promptObserver.disconnect();
  if (!state) return;
  const current = getCurrentConvId();
  const grouped = !current || scope === "all";
  const v = taskView(taskRows(state.jobs, state.history), current, scope, historyFilter);
  for (const btn of el.scope.querySelectorAll("button")) {
    const local = btn.dataset.scope === "current";
    btn.querySelector("b").textContent = local ? v.currentCount : v.total;
    btn.disabled = local && !current;
    btn.setAttribute("aria-pressed", String(local !== grouped));
  }
  el.all.hidden = grouped || v.currentCount > 0 || v.total === 0;
  el.all.textContent = t().viewAll + " (" + v.total + ")";
  for (const btn of el.filter.querySelectorAll("button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.filter === historyFilter));
  }
  el.jobsCount.textContent = v.active.reduce((n, g) => n + g.rows.length, 0);
  el.historyCount.textContent = v.historyCount;
  renderGroups(el.jobsList, v.active, grouped, Infinity, t().noActive);
  const available = renderGroups(el.historyList, v.history, grouped, historyLimit, t().noHistory);
  el.more.textContent = t().more + " (+" + Math.min(pageSize, Math.max(0, available - historyLimit)) + ")";
  el.more.hidden = available <= historyLimit;
  el.less.hidden = historyLimit <= pageSize || available <= pageSize;
  if (focusedKey && document.activeElement === document.body) {
    Array.from(el.panelGoals.querySelectorAll("[data-key]")).find(b => b.dataset.key === focusedKey)?.focus({ preventScroll: true });
  }
}

function setScope(value) {
  scope = value;
  historyLimit = pageSize;
  renderTasks();
}
for (const btn of el.scope.querySelectorAll("button")) btn.addEventListener("click", () => setScope(btn.dataset.scope));
el.all.addEventListener("click", () => setScope("all"));
for (const btn of el.filter.querySelectorAll("button")) btn.addEventListener("click", () => {
  historyFilter = btn.dataset.filter;
  historyLimit = pageSize;
  renderTasks();
});
el.more.addEventListener("click", () => { historyLimit += pageSize; renderTasks(); });
el.less.addEventListener("click", () => { historyLimit = pageSize; renderTasks(); });

let lastSettings, lastGoals, lastTasks;
function renderAll() {
  const lang = getLang();
  const settingsKey = JSON.stringify([state.settings, state.models, state.tomlDefaults]);
  if (lastSettings !== settingsKey) {
    applyStaticI18n();
    renderModels();
    renderEfforts();
    renderSegments();
    lastSettings = settingsKey;
  }
  renderHeader();
  const goalKey = JSON.stringify([state.goalsStore, lang]);
  if (goalKey !== lastGoals) { renderGoals(); lastGoals = goalKey; }
  const taskKey = JSON.stringify([state.jobs, state.history, getCurrentConvId(), lang]);
  if (taskKey !== lastTasks) { renderTasks(); lastTasks = taskKey; }
}

async function fetchState(silent = false) {
  const seq = ++stateReqSeq;
  const version = settingsVersion;
  try {
    const query = new URLSearchParams();
    if (getCurrentConvId()) query.set("conversationId", getCurrentConvId());
    if (!silent) query.set("refresh", "1");
    const snapshot = await apiJson("/api/state?" + query);
    if (seq !== stateReqSeq) return;
    if (state && (pendingSettings || version !== settingsVersion)) snapshot.settings = state.settings;
    state = snapshot;
    renderAll();
    if (!silent) showToast(t().toastRefreshed);
  } catch (err) {
    if (seq === stateReqSeq) showToast(t().toastLoadErr(err.message), true);
  }
}

function updateSetting(patch, customToast = null) {
  if (!state) return;
  pendingSettings++;
  settingsVersion++;
  settingsQueue = settingsQueue.then(async () => {
    try {
      const data = await post(patch ? "/api/settings" : "/api/reset", patch || {});
      state.settings = data.settings;
      renderAll();
      showToast(customToast || (patch ? t().toastSaved : t().toastReset));
    } catch (err) {
      renderSegments();
      renderModels();
      showToast(patch ? t().toastSaveErr(err.message) : t().toastResetErr(err.message), true);
    } finally {
      pendingSettings--;
      settingsVersion++;
    }
  });
  return settingsQueue;
}

el.btnLang.addEventListener("click", () => {
  const nextLang = getLang() === "en" ? "zh" : "en";
  updateSetting(
    { language: nextLang },
    I18N[nextLang].toastLangSwitched
  );
});

for (const btn of el.roleGroup.querySelectorAll(".seg-btn")) {
  btn.addEventListener("click", () => {
    updateSetting({ roleMode: btn.dataset.role });
  });
}

el.modelSelect.addEventListener("change", () => {
  updateSetting({ model: el.modelSelect.value });
});

for (const btn of el.progressionGroup.querySelectorAll(".seg-btn")) {
  btn.addEventListener("click", () => {
    updateSetting({ progressionMode: btn.dataset.progression });
  });
}

el.maxIterInput.addEventListener("change", () => {
  const val = Math.max(1, Math.min(100, parseInt(el.maxIterInput.value, 10) || 12));
  updateSetting({ maxAutoIterations: val });
});

for (const btn of el.sandboxGroup.querySelectorAll(".seg-btn")) {
  btn.addEventListener("click", () => {
    updateSetting({ sandbox: btn.dataset.sandbox });
  });
}

for (const btn of el.workflowGroup.querySelectorAll(".seg-btn")) {
  btn.addEventListener("click", () => {
    updateSetting({ workflowMode: btn.dataset.workflow });
  });
}

el.toggleEphemeral.addEventListener("change", () => {
  updateSetting({ ephemeral: el.toggleEphemeral.checked });
});

el.btnRefresh.addEventListener("click", () => fetchState(false));

el.btnReset.addEventListener("click", () => updateSetting(null));

el.btnToggleNewGoal.addEventListener("click", () => {
  el.newGoalForm.classList.toggle("hidden");
  if (!el.newGoalForm.classList.contains("hidden")) {
    el.goalTitle.focus();
  }
});

el.btnCancelGoal.addEventListener("click", () => {
  el.newGoalForm.classList.add("hidden");
});

el.newGoalForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = el.goalTitle.value.trim();
  if (!title) return;
  const milestones = el.goalMilestones.value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => ({ title: line }));

  try {
    const data = await apiJson("/api/goals", {
      method: "POST",
      body: JSON.stringify({
        title,
        cwd: el.goalCwd.value.trim(),
        milestones,
      }),
    });
    if (data.ok) {
      state.goalsStore = data.goalsStore;
      el.goalTitle.value = "";
      el.goalCwd.value = "";
      el.goalMilestones.value = "";
      el.newGoalForm.classList.add("hidden");
      renderGoals();
      renderHeader();
      showToast(t().toastGoalCreated);
    } else {
      showToast(data.error || t().toastActionErr("create"), true);
    }
  } catch (err) {
    showToast(t().toastActionErr(err.message), true);
  }
});

el.goalSelect.addEventListener("change", async () => {
  try {
    await apiJson("/api/goals/status", {
      method: "POST",
      body: JSON.stringify({
        goalId: el.goalSelect.value,
        activateOnly: true,
      }),
    });
    await fetchState(true);
  } catch (err) {
    showToast(t().toastActionErr(err.message), true);
  }
});

async function sendToConversation(message) {
  if (!getCurrentConvId() || !window.sidecar?.agent?.sendMessage) {
    showToast(t().toastNoSidecarMsg, true);
    return false;
  }
  try {
    const result = await window.sidecar.agent.sendMessage(message);
    if (result === false || result?.ok === false || result?.error) throw new Error(result?.error?.message || result?.error || result?.message || t().sendRejected);
    showToast(t().toastSent);
    return true;
  } catch (err) {
    showToast(t().toastSendErr(err.message), true);
    return false;
  }
}

el.btnSendTask.addEventListener("click", async () => {
  const draft = el.quickTask.value;
  const raw = draft.trim();
  if (!raw) {
    showToast(t().toastNeedTask, true);
    el.quickTask.focus();
    return;
  }
  const progMode = state?.settings?.progressionMode || "notify";
  const workflowMode = state?.settings?.workflowMode || "direct";
  const msg =
    workflowMode === "plan_first"
      ? t().msgDispatchPlan(progMode, raw)
      : t().msgDispatchDirect(progMode, raw);
  el.btnSendTask.disabled = true;
  try {
    if (await sendToConversation(msg) && el.quickTask.value === draft) el.quickTask.value = "";
  } finally {
    el.btnSendTask.disabled = false;
  }
});

el.btnCheckStatus.addEventListener("click", async () => {
  await sendToConversation(t().msgCheckStatus);
});

fetchState(true);
setInterval(() => fetchState(true), 6000);
