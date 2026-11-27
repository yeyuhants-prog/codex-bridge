const I18N = {
  zh: {
    langToggle: "EN",
    langToggleTitle: "Switch to English",
    refreshTitle: "刷新状态、模型与目标",
    statusChecking: "检测中…",
    statusConnected: "已连接",
    statusNotFound: "未找到 Codex",
    loadingMeta: "正在读取本机 Codex 环境与模型列表",
    notFoundMeta: "请检查本机 Codex 安装或设置 CODEX_BIN",
    tabControl: "控制台",
    tabGoals: "目标与任务",
    modelTitle: "Codex 干活模型",
    modelDefaultHint: (m) => `Codex 默认: ${m}`,
    modelFollowDefault: (m) => `跟随 Codex 默认 (${m})`,
    modelCustom: (m) => `${m} (自定义)`,
    effortTitle: "思考深度（Reasoning Effort）",
    effortHint: (e) => `当前默认: ${e}`,
    effortFollowDesc: (e) => `跟随默认（${e}）`,
    efforts: {
      "": "跟随默认",
      low: "低 (low)",
      medium: "中 (medium)",
      high: "高 (high)",
      xhigh: "超高 (xhigh)",
      max: "极高 (max)",
      ultra: "极限 (ultra)",
    },
    progressionTitle: "目标推进模式（Progression）",
    progManual: "手动推进",
    progManualSub: "干完不回调，等你指示",
    progNotify: "完工自动验收",
    progNotifySub: "后台跑完自动唤醒汇报",
    progAuto: "持续自动推进",
    progAutoSub: "自动验收→返工/下一步",
    maxIterLabel: "自动推进轮次上限",
    perJobRoutingBadge: "按任务锁定原对话 ✓",
    sandboxTitle: "执行权限（Sandbox）与派活方式",
    sbReadOnly: "只读分析",
    sbWrite: "工作区可写",
    sbFull: "完全权限",
    wfDirect: "直接派活执行",
    wfDirectSub: "拆解后立即交给 Codex",
    wfPlan: "先出任务单确认",
    wfPlanSub: "你点头后再启动 Codex",
    ephemeralLabel: "临时会话模式（不写入 Codex 历史会话）",
    resetBtn: "恢复默认",
    quickTitle: "快捷派活给反重力 → Codex",
    quickPlaceholder: "描述你想让 Codex 持续排查、验证或修改的后端/Meta分析任务…",
    sendTaskBtn: "发送任务给反重力",
    checkStatusBtn: "对话自检",
    goalBoardTitle: "持久化目标板（Goal & Milestones）",
    newGoalBtn: "+ 新建目标",
    goalTitlePlaceholder: "目标标题，例如：排查后端鉴权 500 报错并补全单测",
    goalCwdPlaceholder: "项目目录（可选，留空自动使用当前工作区）",
    goalMilestonesPlaceholder: "子里程碑（每行一条），例如：\n复现 500 错误并定位根因\n修复代码并跑通 pytest\n验证接口回归无副作用",
    createGoalBtn: "创建并设为当前目标",
    cancelBtn: "取消",
    emptyGoal: "暂无持久化目标。点右上角「+ 新建目标」或直接在对话中让反重力创建目标板～",
    goalMeta: (id, done, total, iter, max) => `${id} · 进度 ${done}/${total} · 自动轮次 ${iter}/${max}`,
    msToggleTitle: "点击切换完成状态",
    msVerifyPrefix: "验证: ",
    msNotesPrefix: "备注: ",
    continueGoalBtn: "让反重力继续推进此目标",
    resumeGoalBtn: "恢复推进",
    pauseGoalBtn: "暂停自动推进",
    deleteBtn: "删除",
    jobsTitle: "后台 Codex 任务（断点可续接）",
    jobsCount: (n) => `${n} 个`,
    emptyJobs: "暂无后台任务记录（使用 codex_start 启动后会实时显示）。",
    cbSent: "已回调原对话 ✓",
    cbFailed: "回调失败",
    cbPending: "完工将回调原对话",
    cbUnrouted: "仅面板查看（无绑定来源）",
    cbSkipped: "未启用回调",
    retryCbBtn: "重试回调",
    resumeJobBtn: "结构化续跑",
    stopJobBtn: "停止原进程",
    noSessionHint: "无 Session ID（需人工处理）",
    detachedBanner: (pid) => `原进程仍在运行 (PID ${pid || "?"})，请等待结束或先停止后再续跑`,
    checkProgressBtn: "查进度",
    toastResumedNew: (id) => `已启动续跑任务 ${id}（保留原目录与权限）✓`,
    toastResumedReused: (id, st) => `该 Session 已有活跃任务 ${id} (${st})，未重复启动`,
    toastStopped: (id) => `已停止任务 ${id} 并释放 Session 锁 ✓`,
    toastRetryOk: (id) => `已成功补发回调到原对话 (${id}) ✓`,
    toastRetryFail: (m) => `重试回调失败: ${m}`,
    historyTitle: "最近执行记录",
    historyCount: (n) => `${n} 条`,
    emptyHistory: "还没有执行记录，派 Codex 干一单后会显示在这里～",
    noPromptPreview: "(无提示词预览)",
    copySessionBtn: "复制 Session",
    toastRefreshed: "已刷新 Codex 状态、模型与目标板",
    toastSaved: "配置已保存并实时生效 ✓",
    toastReset: "已恢复默认设置",
    toastLangSwitched: "已切换为中文界面 ✓",
    toastBound: "已绑定当前对话，后台任务完工将自动回调 ✓",
    toastNoConv: "当前不在对话侧边栏内，无法获取对话 ID",
    toastGoalCreated: "已创建持久化目标 ✓",
    toastGoalDeleted: "已删除目标",
    toastGoalResumed: "目标已恢复为 active",
    toastGoalPaused: "目标已暂停，不再自动推进",
    toastMsUpdated: (id, st) => `里程碑 ${id} 已标记为 ${st}`,
    toastCopiedSid: (id) => `已复制 Session ID: ${id}…`,
    toastSent: "已发送到当前反重力对话 ✓",
    toastNoSidecarMsg: "当前页面不在对话侧边栏中，无法直接发消息",
    toastNeedTask: "请先输入想让 Codex 执行的任务内容",
    toastLoadErr: (m) => `加载失败: ${m}`,
    toastSaveErr: (m) => `保存失败: ${m}`,
    toastResetErr: (m) => `重置失败: ${m}`,
    toastActionErr: (m) => `操作失败: ${m}`,
    toastSendErr: (m) => `发送失败: ${m}`,
    msgContinueGoal: (id, title, prog) =>
      `请调用 codex_goal(action="get", goal_id="${id}") 读取目标「${title}」的当前进度与关联 Session，按照当前推进模式（${prog}）继续推进下一个未完成的里程碑并验收。`,
    msgResumeJob: (sid, jid) =>
      `请使用 \`codex_resume(session_id="${sid}")\` 续接后台任务 \`${jid}\` 的上下文，检查当前进度并继续完成剩余工作。`,
    msgCheckJob: (jid) =>
      `请调用 \`codex_status(job_id="${jid}")\` 查看这个后台 Codex 任务的最新进度。`,
    msgDispatchPlan: (prog, raw) =>
      `请先为以下需求建好持久化目标板（codex_goal）并输出详细任务单给我确认，确认后按当前推进模式（${prog}）派给 Codex 执行：\n\n${raw}`,
    msgDispatchDirect: (prog, raw) =>
      `请先为以下需求建好持久化目标板（codex_goal），然后按当前推进模式（${prog}）直接调用 Codex Bridge 派给 Codex 执行并持续验证：\n\n${raw}`,
    msgCheckStatus: "请调用 codex_info 检查当前 Codex Bridge 的模型、推进模式、目标进度与连接状态。",
  },
  en: {
    langToggle: "中文",
    langToggleTitle: "切换为中文",
    refreshTitle: "Refresh status, models & goals",
    statusChecking: "Checking…",
    statusConnected: "Connected",
    statusNotFound: "Codex Not Found",
    loadingMeta: "Loading local Codex runtime & model catalog",
    notFoundMeta: "Check local Codex installation or set CODEX_BIN",
    tabControl: "Controls",
    tabGoals: "Goals & Jobs",
    modelTitle: "Codex Model",
    modelDefaultHint: (m) => `Codex default: ${m}`,
    modelFollowDefault: (m) => `Follow Codex default (${m})`,
    modelCustom: (m) => `${m} (custom)`,
    effortTitle: "Reasoning Effort",
    effortHint: (e) => `Default: ${e}`,
    effortFollowDesc: (e) => `Follow default (${e})`,
    efforts: {
      "": "Default",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra High",
      max: "Max",
      ultra: "Ultra",
    },
    progressionTitle: "Goal Progression Mode",
    progManual: "Manual",
    progManualSub: "No auto-callback; wait for prompt",
    progNotify: "Notify & Verify",
    progNotifySub: "Wake Antigravity when job finishes",
    progAuto: "Autonomous",
    progAutoSub: "Verify → fix or advance milestones",
    maxIterLabel: "Max auto-iterations",
    perJobRoutingBadge: "Per-job locked routing ✓",
    sandboxTitle: "Sandbox Policy & Briefing Mode",
    sbReadOnly: "Read-only",
    sbWrite: "Workspace Write",
    sbFull: "Full Access",
    wfDirect: "Direct Dispatch",
    wfDirectSub: "Plan and dispatch to Codex directly",
    wfPlan: "Plan First",
    wfPlanSub: "Show brief for approval first",
    ephemeralLabel: "Ephemeral sessions (do not persist Codex history)",
    resetBtn: "Reset Defaults",
    quickTitle: "Quick Dispatch (Antigravity → Codex)",
    quickPlaceholder: "Describe a backend fix, verification, or meta-analysis task for Codex…",
    sendTaskBtn: "Send Task to Antigravity",
    checkStatusBtn: "Health Check",
    goalBoardTitle: "Persistent Goal & Milestone Board",
    newGoalBtn: "+ New Goal",
    goalTitlePlaceholder: "Goal title, e.g. Fix auth 500 error & pass pytest",
    goalCwdPlaceholder: "Working directory (optional, defaults to workspace)",
    goalMilestonesPlaceholder: "Milestones (one per line), e.g.\nReproduce 500 error & find root cause\nImplement fix and pass pytest\nVerify no regressions",
    createGoalBtn: "Create & Set Active",
    cancelBtn: "Cancel",
    emptyGoal: "No persistent goals yet. Click \"+ New Goal\" or ask Antigravity to create one.",
    goalMeta: (id, done, total, iter, max) => `${id} · ${done}/${total} done · iter ${iter}/${max}`,
    msToggleTitle: "Click to toggle done status",
    msVerifyPrefix: "Verify: ",
    msNotesPrefix: "Notes: ",
    continueGoalBtn: "Continue This Goal",
    resumeGoalBtn: "Resume",
    pauseGoalBtn: "Pause Auto",
    deleteBtn: "Delete",
    jobsTitle: "Background Codex Jobs (Resumable)",
    jobsCount: (n) => `${n}`,
    emptyJobs: "No background jobs yet (jobs launched via codex_start appear here).",
    cbSent: "Delivered to source chat ✓",
    cbFailed: "Callback failed",
    cbPending: "Will callback source chat",
    cbUnrouted: "Panel-only (no bound source)",
    cbSkipped: "Callback off",
    retryCbBtn: "Retry Callback",
    resumeJobBtn: "Resume Job",
    stopJobBtn: "Stop Process",
    noSessionHint: "No Session ID (manual)",
    detachedBanner: (pid) => `Original process still running (PID ${pid || "?"}). Wait or stop before resuming.`,
    checkProgressBtn: "Check Status",
    toastResumedNew: (id) => `Started resumed job ${id} (preserved cwd & sandbox) ✓`,
    toastResumedReused: (id, st) => `Session already active in ${id} (${st}); reused instead of spawning a duplicate`,
    toastStopped: (id) => `Stopped job ${id} & released session lock ✓`,
    toastRetryOk: (id) => `Callback retried & delivered to source chat (${id}) ✓`,
    toastRetryFail: (m) => `Retry callback failed: ${m}`,
    historyTitle: "Recent Runs",
    historyCount: (n) => `${n}`,
    emptyHistory: "No recent runs yet.",
    noPromptPreview: "(no prompt preview)",
    copySessionBtn: "Copy Session",
    toastRefreshed: "Refreshed Codex status, models & goals",
    toastSaved: "Settings saved & active ✓",
    toastReset: "Reset to defaults",
    toastLangSwitched: "Switched to English ✓",
    toastBound: "Bound to this conversation for auto-callbacks ✓",
    toastNoConv: "Open inside a conversation side-pane to bind",
    toastGoalCreated: "Created persistent goal ✓",
    toastGoalDeleted: "Deleted goal",
    toastGoalResumed: "Goal resumed (active)",
    toastGoalPaused: "Goal paused (auto-progression stopped)",
    toastMsUpdated: (id, st) => `Milestone ${id} marked ${st}`,
    toastCopiedSid: (id) => `Copied Session ID: ${id}…`,
    toastSent: "Sent to current Antigravity chat ✓",
    toastNoSidecarMsg: "Cannot message chat outside side-pane",
    toastNeedTask: "Please enter a task description first",
    toastLoadErr: (m) => `Load failed: ${m}`,
    toastSaveErr: (m) => `Save failed: ${m}`,
    toastResetErr: (m) => `Reset failed: ${m}`,
    toastActionErr: (m) => `Action failed: ${m}`,
    toastSendErr: (m) => `Send failed: ${m}`,
    msgContinueGoal: (id, title, prog) =>
      `Call codex_goal(action="get", goal_id="${id}") to inspect goal "${title}" and its linked session, then advance and verify the next pending milestone under progression mode "${prog}".`,
    msgResumeJob: (sid, jid) =>
      `Use \`codex_resume(session_id="${sid}")\` to resume background job \`${jid}\`, inspect its current state, and finish the remaining work.`,
    msgCheckJob: (jid) =>
      `Call \`codex_status(job_id="${jid}")\` to check the latest progress of this background Codex job.`,
    msgDispatchPlan: (prog, raw) =>
      `First create a persistent goal via codex_goal and present a detailed Codex task brief for my approval, then dispatch under progression mode "${prog}":\n\n${raw}`,
    msgDispatchDirect: (prog, raw) =>
      `Create a persistent goal via codex_goal, then dispatch directly through Codex Bridge under progression mode "${prog}" and verify the results:\n\n${raw}`,
    msgCheckStatus: "Call codex_info to check Codex Bridge status, active model, progression mode, and goal progress.",
  },
};

const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

let state = null;
let toastTimer = null;
let activeTab = "control";

const el = {
  statusPill: document.getElementById("status-pill"),
  codexMeta: document.getElementById("codex-meta"),
  toast: document.getElementById("toast"),
  btnLang: document.getElementById("btn-lang"),
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
  const res = await apiFetch(url, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 120) || "invalid response"}`);
  }
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
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

  const runningJobs = (state.jobs || []).filter(
    (j) => j.status === "running" || j.status === "running_detached"
  ).length;
  const activeGoals = (state.goalsStore?.goals || []).filter((g) => g.status === "active").length;
  const badgeNum = runningJobs || activeGoals;
  el.tabBadge.textContent = String(badgeNum);
  el.tabBadge.classList.toggle("hidden", badgeNum === 0);
}

function renderModels() {
  const dict = t();
  const { models, settings, tomlDefaults } = state;
  const tomlModel = tomlDefaults?.model || "auto";
  el.modelDefaultHint.textContent = dict.modelDefaultHint(tomlModel);

  el.modelSelect.innerHTML = "";
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

  el.effortGroup.innerHTML = "";
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
    checkBtn.title = dict.msToggleTitle;
    checkBtn.addEventListener("click", async () => {
      try {
        const nextStatus = ms.status === "done" ? "pending" : "done";
        await apiJson("/api/goals/milestone", {
          method: "POST",
          body: JSON.stringify({
            goalId: activeGoal.id,
            milestoneId: ms.id,
            status: nextStatus,
          }),
        });
        await fetchState(true);
        showToast(t().toastMsUpdated(ms.id, nextStatus));
      } catch (err) {
        showToast(t().toastActionErr(err.message), true);
      }
    });

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

    row.append(checkBtn, body);
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

function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString(
      getLang() === "en" ? "en-US" : "zh-CN",
      {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }
    );
  } catch {
    return iso;
  }
}

function renderJobs() {
  const dict = t();
  const jobs = state.jobs || [];
  el.jobsCount.textContent = dict.jobsCount(jobs.length);
  el.jobsList.innerHTML = "";

  if (jobs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = dict.emptyJobs;
    el.jobsList.appendChild(empty);
    return;
  }

  for (const job of jobs.slice(0, 10)) {
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
        ` ${job.id}${job.parentJobId ? ` ← ${job.parentJobId}` : ""}${job.goalId ? ` · ${job.goalId}` : ""}`
      )
    );
    const right = document.createElement("span");
    right.textContent = `${job.sandbox || "workspace-write"} · ${job.eventCount || 0} ev · ${formatTime(job.startedAt)}`;
    top.append(left, right);

    const prompt = document.createElement("div");
    prompt.className = "history-prompt";
    prompt.textContent = job.promptPreview || dict.noPromptPreview;

    const subline = document.createElement("div");
    subline.className = "job-subline";
    subline.textContent = [
      job.cwd || "",
      job.sessionId ? `sid:${job.sessionId.slice(0, 8)}…` : dict.noSessionHint,
    ]
      .filter(Boolean)
      .join(" · ");

    row.append(top, prompt, subline);

    if (job.status === "running_detached") {
      const alert = document.createElement("div");
      alert.className = "job-alert";
      alert.textContent = dict.detachedBanner(job.pid);
      row.appendChild(alert);
    }

    if (job.callbackStatus === "failed" && job.callbackError) {
      const errBanner = document.createElement("div");
      errBanner.className = "job-alert error";
      errBanner.textContent = `${dict.cbFailed}: ${job.callbackError}`;
      row.appendChild(errBanner);
    }

    const foot = document.createElement("div");
    foot.className = "history-foot";

    const cbTag = document.createElement("span");
    const cbStatus = job.callbackStatus || (job.callbackSent ? "sent" : "skipped");
    cbTag.className = `cb-tag ${cbStatus}`;
    if (cbStatus === "sent") {
      cbTag.textContent = dict.cbSent;
    } else if (cbStatus === "failed") {
      cbTag.textContent = dict.cbFailed;
    } else if (cbStatus === "unrouted") {
      cbTag.textContent = dict.cbUnrouted;
      if (job.callbackError) cbTag.title = job.callbackError;
    } else if (cbStatus === "pending") {
      cbTag.textContent = dict.cbPending;
    } else {
      cbTag.textContent = dict.cbSkipped;
    }
    foot.appendChild(cbTag);

    const footActions = document.createElement("div");
    footActions.className = "foot-actions";

    if (cbStatus === "failed" && job.callbackTarget?.conversationId) {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "copy-sid";
      retryBtn.textContent = dict.retryCbBtn;
      retryBtn.addEventListener("click", async () => {
        try {
          const data = await apiJson("/api/jobs/retry-callback", {
            method: "POST",
            body: JSON.stringify({ jobId: job.id }),
          });
          if (data.jobs) state.jobs = data.jobs;
          renderJobs();
          if (data.ok) {
            showToast(t().toastRetryOk(job.id));
          } else {
            showToast(t().toastRetryFail(data.error || data.status), true);
          }
        } catch (err) {
          showToast(t().toastRetryFail(err.message), true);
        }
      });
      footActions.appendChild(retryBtn);
    }

    const isActiveJob =
      job.status === "running" || job.status === "running_detached";

    if (isActiveJob) {
      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "copy-sid";
      stopBtn.textContent = dict.stopJobBtn;
      stopBtn.addEventListener("click", async () => {
        try {
          const data = await apiJson("/api/jobs/stop", {
            method: "POST",
            body: JSON.stringify({ jobId: job.id }),
          });
          if (data.jobs) state.jobs = data.jobs;
          renderAll();
          if (data.ok) {
            showToast(t().toastStopped(job.id));
          } else {
            showToast(t().toastActionErr(data.error || "stop failed"), true);
          }
        } catch (err) {
          showToast(t().toastActionErr(err.message), true);
        }
      });
      footActions.appendChild(stopBtn);

      if (job.status === "running") {
        const checkBtn = document.createElement("button");
        checkBtn.type = "button";
        checkBtn.className = "copy-sid";
        checkBtn.textContent = dict.checkProgressBtn;
        checkBtn.addEventListener("click", async () => {
          await sendToConversation(t().msgCheckJob(job.id));
        });
        footActions.appendChild(checkBtn);
      }
    } else if (job.sessionId && job.sessionId !== "last") {
      // Structured resume by old job_id directly via Sidecar backend (preserves cwd, sandbox, goal, milestone)
      const resumeBtn = document.createElement("button");
      resumeBtn.type = "button";
      resumeBtn.className = "copy-sid";
      resumeBtn.textContent = dict.resumeJobBtn;
      resumeBtn.addEventListener("click", async () => {
        try {
          const data = await apiJson("/api/jobs/resume", {
            method: "POST",
            body: JSON.stringify({
              jobId: job.id,
              conversationId: getCurrentConvId(),
            }),
          });
          if (data.jobs) state.jobs = data.jobs;
          renderAll();
          if (data.reused) {
            showToast(t().toastResumedReused(data.job.id, data.job.status));
          } else {
            showToast(t().toastResumedNew(data.job.id));
          }
        } catch (err) {
          showToast(t().toastActionErr(err.message), true);
        }
      });
      footActions.appendChild(resumeBtn);
    }

    foot.appendChild(footActions);
    row.appendChild(foot);
    el.jobsList.appendChild(row);
  }
}

function renderHistory() {
  const dict = t();
  const list = state.history || [];
  el.historyCount.textContent = dict.historyCount(list.length);
  el.historyList.innerHTML = "";

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = dict.emptyHistory;
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
    prompt.textContent = item.promptPreview || dict.noPromptPreview;

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
      copyBtn.textContent = dict.copySessionBtn;
      copyBtn.title = item.sessionId;
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(item.sessionId);
          showToast(t().toastCopiedSid(item.sessionId.slice(0, 8)));
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
  applyStaticI18n();
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
    state = await apiJson(`/api/state${qs}`, { method: "GET" });
    renderAll();
    if (!silent) showToast(t().toastRefreshed);
  } catch (err) {
    showToast(t().toastLoadErr(err.message), true);
  }
}

async function updateSetting(patch, customToast = null) {
  try {
    const data = await apiJson("/api/settings", {
      method: "POST",
      body: JSON.stringify(patch),
    });
    state.settings = data.settings;
    renderAll();
    showToast(customToast || t().toastSaved);
  } catch (err) {
    showToast(t().toastSaveErr(err.message), true);
  }
}

el.btnLang.addEventListener("click", () => {
  const nextLang = getLang() === "en" ? "zh" : "en";
  updateSetting(
    { language: nextLang },
    I18N[nextLang].toastLangSwitched
  );
});

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

el.btnReset.addEventListener("click", async () => {
  try {
    const data = await apiJson("/api/reset", { method: "POST", body: "{}" });
    state.settings = data.settings;
    renderAll();
    showToast(t().toastReset);
  } catch (err) {
    showToast(t().toastResetErr(err.message), true);
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
  if (!window.sidecar?.agent?.sendMessage) {
    showToast(t().toastNoSidecarMsg, true);
    return;
  }
  try {
    await window.sidecar.agent.sendMessage(message);
    showToast(t().toastSent);
  } catch (err) {
    showToast(t().toastSendErr(err.message), true);
  }
}

el.btnSendTask.addEventListener("click", async () => {
  const raw = el.quickTask.value.trim();
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
  await sendToConversation(msg);
  el.quickTask.value = "";
});

el.btnCheckStatus.addEventListener("click", async () => {
  await sendToConversation(t().msgCheckStatus);
});

fetchState(true);
setInterval(() => fetchState(true), 6000);
