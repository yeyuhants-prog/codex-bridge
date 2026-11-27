const EFFORT_LABELS = {
  "": "跟随默认",
  low: "低 (low)",
  medium: "中 (medium)",
  high: "高 (high)",
  xhigh: "超高 (xhigh)",
  max: "极高 (max)",
  ultra: "极限 (ultra)",
};

const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

let state = null;
let toastTimer = null;
let activeTab = "control";

const el = {
  statusPill: document.getElementById("status-pill"),
  codexMeta: document.getElementById("codex-meta"),
  toast: document.getElementById("toast"),
  tabs: document.querySelectorAll(".tab"),
  tabBadge: document.getElementById("tab-badge"),
  panelControl: document.getElementById("panel-control"),
  panelGoals: document.getElementById("panel-goals"),
  modelSelect: document.getElementById("model-select"),
  modelDefaultHint: document.getElementById("model-default-hint"),
  modelDesc: document.getElementById("model-desc"),
  effortGroup: document.getElementById("effort-group"),
  effortHint: document.getElementById("effort-hint"),
  effortDesc: document.getElementById("effort-desc"),
  progressionGroup: document.getElementById("progression-group"),
  bindBadge: document.getElementById("bind-badge"),
  maxIterInput: document.getElementById("max-iter-input"),
  btnBindConv: document.getElementById("btn-bind-conv"),
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

function apiFetch(url, options = {}) {
  if (window.sidecar && typeof window.sidecar.fetch === "function") {
    return window.sidecar.fetch(url, options);
  }
  return fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
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
  activeTab = tab;
  for (const btn of el.tabs) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  el.panelControl.classList.toggle("hidden", tab !== "control");
  el.panelGoals.classList.toggle("hidden", tab !== "goals");
}

for (const btn of el.tabs) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
}

function getSelectedModelObj() {
  if (!state) return null;
  const slug = state.settings.model || state.tomlDefaults?.model || "";
  return state.models.find((m) => m.slug === slug) || null;
}

function renderHeader() {
  const c = state.codex;
  if (c.found) {
    el.statusPill.textContent = c.version || "已连接";
    el.statusPill.className = "status-pill ok";
    el.codexMeta.textContent = `${c.source || "Codex"} · v${state.pluginVersion}`;
  } else {
    el.statusPill.textContent = "未找到 Codex";
    el.statusPill.className = "status-pill err";
    el.codexMeta.textContent = "请检查本机 Codex 安装或设置 CODEX_BIN";
  }

  const runningJobs = (state.jobs || []).filter((j) => j.status === "running").length;
  const activeGoals = (state.goalsStore?.goals || []).filter((g) => g.status === "active").length;
  const badgeNum = runningJobs || activeGoals;
  el.tabBadge.textContent = String(badgeNum);
  el.tabBadge.classList.toggle("hidden", badgeNum === 0);
}

function renderModels() {
  const { models, settings, tomlDefaults } = state;
  const tomlModel = tomlDefaults?.model || "auto";
  el.modelDefaultHint.textContent = `Codex 默认: ${tomlModel}`;

  el.modelSelect.innerHTML = "";
  const defOpt = document.createElement("option");
  defOpt.value = "";
  defOpt.textContent = `跟随 Codex 默认 (${tomlModel})`;
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
    customOpt.textContent = `${settings.model} (自定义)`;
    el.modelSelect.appendChild(customOpt);
  }

  el.modelSelect.value = settings.model || "";
  const activeModel = getSelectedModelObj();
  el.modelDesc.textContent = activeModel?.description || "";
}

function renderEfforts() {
  const { settings, tomlDefaults } = state;
  const activeModel = getSelectedModelObj();
  const supported =
    activeModel?.efforts?.length > 0
      ? activeModel.efforts
      : FALLBACK_EFFORTS.map((e) => ({ effort: e, description: "" }));

  const defaultEffortLabel =
    tomlDefaults?.reasoningEffort || activeModel?.defaultEffort || "auto";
  el.effortHint.textContent = `当前默认: ${defaultEffortLabel}`;

  el.effortGroup.innerHTML = "";
  const items = [
    { effort: "", description: `跟随默认（${defaultEffortLabel}）` },
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
    btn.textContent = EFFORT_LABELS[item.effort] || item.effort;
    btn.addEventListener("click", () => {
      updateSetting({ reasoningEffort: item.effort });
    });
    el.effortGroup.appendChild(btn);
  }
  el.effortDesc.textContent = activeDesc;
}

function renderSegments() {
  const { settings } = state;
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

  const curConv = getCurrentConvId();
  if (settings.boundConversationId) {
    const isCurrent = curConv && settings.boundConversationId === curConv;
    el.bindBadge.textContent = isCurrent
      ? "已绑定当前对话 ✓"
      : `已绑定对话 ${settings.boundConversationId.slice(0, 8)}…`;
    el.bindBadge.className = "hint ok";
  } else {
    el.bindBadge.textContent = "未绑定回调对话";
    el.bindBadge.className = "hint";
  }
}

function renderGoals() {
  const store = state.goalsStore || { activeGoalId: null, goals: [] };
  const goals = store.goals || [];
  const activeGoal =
    goals.find((g) => g.id === store.activeGoalId) || goals[0] || null;

  if (goals.length > 1) {
    el.goalSelectorRow.classList.remove("hidden");
    el.goalSelect.innerHTML = "";
    for (const g of goals) {
      const opt = document.createElement("option");
      opt.value = g.id;
      const done = g.milestones.filter((m) => m.status === "done").length;
      opt.textContent = `[${g.status}] ${g.title} (${done}/${g.milestones.length})`;
      el.goalSelect.appendChild(opt);
    }
    if (activeGoal) el.goalSelect.value = activeGoal.id;
  } else {
    el.goalSelectorRow.classList.add("hidden");
  }

  el.activeGoalView.innerHTML = "";
  if (!activeGoal) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      "暂无持久化目标。点右上角「+ 新建目标」或直接在对话中让反重力创建目标板～";
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
  meta.textContent = `${activeGoal.id} · 进度 ${doneCount}/${totalCount} · 自动轮次 ${activeGoal.iterationCount || 0}/${activeGoal.maxIterations || 12}`;
  left.append(title, meta);

  const badge = document.createElement("span");
  badge.className = `badge ${activeGoal.status}`;
  badge.textContent = activeGoal.status;
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

    const checkBtn = document.createElement("button");
    checkBtn.type = "button";
    checkBtn.className = `ms-check ${ms.status}`;
    checkBtn.textContent = msIcons[ms.status] || "";
    checkBtn.title = "点击切换完成状态";
    checkBtn.addEventListener("click", async () => {
      const nextStatus = ms.status === "done" ? "pending" : "done";
      await apiFetch("/api/goals/milestone", {
        method: "POST",
        body: JSON.stringify({
          goalId: activeGoal.id,
          milestoneId: ms.id,
          status: nextStatus,
        }),
      });
      await fetchState(true);
      showToast(`里程碑 ${ms.id} 已标记为 ${nextStatus}`);
    });

    const body = document.createElement("div");
    body.className = "ms-body";
    const t = document.createElement("div");
    t.className = `ms-title ${ms.status === "done" ? "done" : ""}`;
    t.textContent = `${ms.id}. ${ms.title}`;
    body.appendChild(t);

    if (ms.verification || ms.notes) {
      const sub = document.createElement("div");
      sub.className = "ms-sub";
      sub.textContent = [
        ms.verification ? `验证: ${ms.verification}` : "",
        ms.notes ? `备注: ${ms.notes}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      body.appendChild(sub);
    }

    row.append(checkBtn, body);
    msList.appendChild(row);
  }

  const actions = document.createElement("div");
  actions.className = "goal-actions";

  const btnContinue = document.createElement("button");
  btnContinue.type = "button";
  btnContinue.className = "primary-btn";
  btnContinue.textContent = "让反重力继续推进此目标";
  btnContinue.addEventListener("click", async () => {
    await sendToConversation(
      `请调用 codex_goal(action="get", goal_id="${activeGoal.id}") 读取目标「${activeGoal.title}」的当前进度与关联 Session，按照当前推进模式（${state.settings.progressionMode}）继续推进下一个未完成的里程碑并验收。`
    );
  });
  actions.appendChild(btnContinue);

  const btnPause = document.createElement("button");
  btnPause.type = "button";
  btnPause.className = "mini-btn";
  const isPaused = activeGoal.status === "paused";
  btnPause.textContent = isPaused ? "恢复推进" : "暂停自动推进";
  btnPause.addEventListener("click", async () => {
    const nextStatus = isPaused ? "active" : "paused";
    await apiFetch("/api/goals/status", {
      method: "POST",
      body: JSON.stringify({ goalId: activeGoal.id, status: nextStatus }),
    });
    await fetchState(true);
    showToast(isPaused ? "目标已恢复为 active" : "目标已暂停，不再自动推进");
  });
  actions.appendChild(btnPause);

  const btnDelete = document.createElement("button");
  btnDelete.type = "button";
  btnDelete.className = "mini-btn danger";
  btnDelete.textContent = "删除";
  btnDelete.addEventListener("click", async () => {
    await apiFetch("/api/goals/delete", {
      method: "POST",
      body: JSON.stringify({ goalId: activeGoal.id }),
    });
    await fetchState(true);
    showToast("已删除目标");
  });
  actions.appendChild(btnDelete);

  el.activeGoalView.append(header, track, msList, actions);
}

function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function renderJobs() {
  const jobs = state.jobs || [];
  el.jobsCount.textContent = `${jobs.length} 个`;
  el.jobsList.innerHTML = "";

  if (jobs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无后台任务记录（使用 codex_start 启动后会实时显示）。";
    el.jobsList.appendChild(empty);
    return;
  }

  for (const job of jobs.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "history-item";

    const top = document.createElement("div");
    top.className = "history-top";
    const left = document.createElement("span");
    const badge = document.createElement("span");
    badge.className = `badge ${job.status}`;
    badge.textContent = job.status;
    left.appendChild(badge);
    left.appendChild(
      document.createTextNode(
        ` ${job.id}${job.goalId ? ` · ${job.goalId}` : ""}`
      )
    );
    const right = document.createElement("span");
    right.textContent = `${job.eventCount || 0} events · ${formatTime(job.startedAt)}`;
    top.append(left, right);

    const prompt = document.createElement("div");
    prompt.className = "history-prompt";
    prompt.textContent = job.promptPreview || "(无提示词预览)";

    const foot = document.createElement("div");
    foot.className = "history-foot";
    const cbNote = job.callbackSent
      ? "已自动回调 ✓"
      : job.notifyOnComplete && job.status === "running"
        ? "完工将自动回调"
        : job.model || "default";
    const metaText = document.createElement("span");
    metaText.textContent = cbNote;
    foot.appendChild(metaText);

    const footActions = document.createElement("div");
    footActions.className = "foot-actions";

    if (job.sessionId) {
      const resumeBtn = document.createElement("button");
      resumeBtn.type = "button";
      resumeBtn.className = "copy-sid";
      resumeBtn.textContent = "续跑 Session";
      resumeBtn.addEventListener("click", async () => {
        await sendToConversation(
          `请使用 \`codex_resume(session_id="${job.sessionId}")\` 续接后台任务 \`${job.id}\` 的上下文，检查当前进度并继续完成剩余工作。`
        );
      });
      footActions.appendChild(resumeBtn);
    }

    if (job.status === "running") {
      const checkBtn = document.createElement("button");
      checkBtn.type = "button";
      checkBtn.className = "copy-sid";
      checkBtn.textContent = "查进度";
      checkBtn.addEventListener("click", async () => {
        await sendToConversation(
          `请调用 \`codex_status(job_id="${job.id}")\` 查看这个后台 Codex 任务的最新进度。`
        );
      });
      footActions.appendChild(checkBtn);
    }

    foot.appendChild(footActions);
    row.append(top, prompt, foot);
    el.jobsList.appendChild(row);
  }
}

function renderHistory() {
  const list = state.history || [];
  el.historyCount.textContent = `${list.length} 条`;
  el.historyList.innerHTML = "";

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "还没有执行记录，派 Codex 干一单后会显示在这里～";
    el.historyList.appendChild(empty);
    return;
  }

  for (const item of list.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "history-item";

    const top = document.createElement("div");
    top.className = "history-top";

    const left = document.createElement("span");
    const badge = document.createElement("span");
    badge.className = `badge ${item.status || "completed"}`;
    badge.textContent = item.status || "completed";
    left.appendChild(badge);
    left.appendChild(
      document.createTextNode(
        ` ${item.model || "default"} · ${item.reasoningEffort || "default"}`
      )
    );

    const right = document.createElement("span");
    const sec = item.durationMs ? `${(item.durationMs / 1000).toFixed(1)}s` : "";
    right.textContent = [sec, formatTime(item.at)].filter(Boolean).join(" · ");

    top.append(left, right);

    const prompt = document.createElement("div");
    prompt.className = "history-prompt";
    prompt.textContent = item.promptPreview || "(无提示词预览)";

    const foot = document.createElement("div");
    foot.className = "history-foot";
    const metaText = document.createElement("span");
    const tokens = item.usage
      ? `in=${item.usage.input_tokens ?? 0} / out=${item.usage.output_tokens ?? 0}`
      : item.mode || "run";
    metaText.textContent = tokens;
    foot.appendChild(metaText);

    if (item.sessionId) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "copy-sid";
      copyBtn.textContent = "复制 Session";
      copyBtn.title = item.sessionId;
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(item.sessionId);
          showToast(`已复制 Session ID: ${item.sessionId.slice(0, 8)}…`);
        } catch {
          showToast(item.sessionId);
        }
      });
      foot.appendChild(copyBtn);
    }

    row.append(top, prompt, foot);
    el.historyList.appendChild(row);
  }
}

function renderAll() {
  renderHeader();
  renderModels();
  renderEfforts();
  renderSegments();
  renderGoals();
  renderJobs();
  renderHistory();
}

async function fetchState(silent = false) {
  try {
    const convId = getCurrentConvId();
    const qs = convId ? `?conversationId=${encodeURIComponent(convId)}` : "";
    const res = await apiFetch(`/api/state${qs}`, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state = await res.json();
    renderAll();
    if (!silent) showToast("已刷新 Codex 状态、模型与目标板");
  } catch (err) {
    showToast(`加载失败: ${err.message}`, true);
  }
}

async function updateSetting(patch) {
  try {
    const res = await apiFetch("/api/settings", {
      method: "POST",
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.settings = data.settings;
    renderModels();
    renderEfforts();
    renderSegments();
    showToast("配置已保存并实时生效 ✓");
  } catch (err) {
    showToast(`保存失败: ${err.message}`, true);
  }
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

el.btnBindConv.addEventListener("click", async () => {
  const convId = getCurrentConvId();
  if (!convId) {
    showToast("当前不在对话侧边栏内，无法获取对话 ID", true);
    return;
  }
  const res = await apiFetch("/api/bind-conversation", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  const data = await res.json();
  if (data.ok) {
    state.settings = data.settings;
    renderSegments();
    showToast("已绑定当前对话，后台任务完工将自动回调 ✓");
  } else {
    showToast(data.error || "绑定失败", true);
  }
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

el.btnReset.addEventListener("click", async () => {
  try {
    const res = await apiFetch("/api/reset", { method: "POST", body: "{}" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.settings = data.settings;
    renderAll();
    showToast("已恢复默认设置");
  } catch (err) {
    showToast(`重置失败: ${err.message}`, true);
  }
});

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

  const res = await apiFetch("/api/goals", {
    method: "POST",
    body: JSON.stringify({
      title,
      cwd: el.goalCwd.value.trim(),
      milestones,
    }),
  });
  const data = await res.json();
  if (data.ok) {
    state.goalsStore = data.goalsStore;
    el.goalTitle.value = "";
    el.goalCwd.value = "";
    el.goalMilestones.value = "";
    el.newGoalForm.classList.add("hidden");
    renderGoals();
    renderHeader();
    showToast("已创建持久化目标 ✓");
  } else {
    showToast(data.error || "创建失败", true);
  }
});

el.goalSelect.addEventListener("change", async () => {
  await apiFetch("/api/goals/status", {
    method: "POST",
    body: JSON.stringify({
      goalId: el.goalSelect.value,
      activateOnly: true,
    }),
  });
  await fetchState(true);
});

async function sendToConversation(message) {
  if (!window.sidecar?.agent?.sendMessage) {
    showToast("当前页面不在对话侧边栏中，无法直接发消息", true);
    return;
  }
  try {
    await window.sidecar.agent.sendMessage(message);
    showToast("已发送到当前反重力对话 ✓");
  } catch (err) {
    showToast(`发送失败: ${err.message}`, true);
  }
}

el.btnSendTask.addEventListener("click", async () => {
  const raw = el.quickTask.value.trim();
  if (!raw) {
    showToast("请先输入想让 Codex 执行的任务内容", true);
    el.quickTask.focus();
    return;
  }
  const progMode = state?.settings?.progressionMode || "notify";
  const workflowMode = state?.settings?.workflowMode || "direct";
  const hint =
    workflowMode === "plan_first"
      ? `请先为以下需求建好持久化目标板（codex_goal）并输出详细任务单给我确认，确认后按当前推进模式（${progMode}）派给 Codex 执行：`
      : `请先为以下需求建好持久化目标板（codex_goal），然后按当前推进模式（${progMode}）直接调用 Codex Bridge 派给 Codex 执行并持续验证：`;
  await sendToConversation(`${hint}\n\n${raw}`);
  el.quickTask.value = "";
});

el.btnCheckStatus.addEventListener("click", async () => {
  await sendToConversation(
    "请调用 codex_info 检查当前 Codex Bridge 的模型、推进模式、目标进度与连接状态。"
  );
});

fetchState(true);
setInterval(() => fetchState(true), 6000);
