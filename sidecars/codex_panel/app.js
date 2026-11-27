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

const el = {
  statusPill: document.getElementById("status-pill"),
  codexMeta: document.getElementById("codex-meta"),
  toast: document.getElementById("toast"),
  modelSelect: document.getElementById("model-select"),
  modelDefaultHint: document.getElementById("model-default-hint"),
  modelDesc: document.getElementById("model-desc"),
  effortGroup: document.getElementById("effort-group"),
  effortHint: document.getElementById("effort-hint"),
  effortDesc: document.getElementById("effort-desc"),
  sandboxGroup: document.getElementById("sandbox-group"),
  workflowGroup: document.getElementById("workflow-group"),
  toggleEphemeral: document.getElementById("toggle-ephemeral"),
  quickTask: document.getElementById("quick-task"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnReset: document.getElementById("btn-reset"),
  btnSendTask: document.getElementById("btn-send-task"),
  btnCheckStatus: document.getElementById("btn-check-status"),
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

function showToast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle("error", isError);
  el.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.add("hidden");
  }, 2400);
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
    el.codexMeta.textContent = `${c.source || "Codex"} · ${c.path || ""}`;
  } else {
    el.statusPill.textContent = "未找到 Codex";
    el.statusPill.className = "status-pill err";
    el.codexMeta.textContent = "请检查本机 Codex 安装或设置 CODEX_BIN";
  }
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

  // If user previously saved a custom slug not in cache, keep it selectable.
  if (
    settings.model &&
    !models.some((m) => m.slug === settings.model)
  ) {
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
      copyBtn.textContent = `复制 Session`;
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
  renderHistory();
}

async function fetchState(silent = false) {
  try {
    const res = await apiFetch("/api/state", { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state = await res.json();
    renderAll();
    if (!silent) showToast("已刷新 Codex 状态与模型列表");
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
    showToast("配置已保存，下次派活自动生效 ✓");
  } catch (err) {
    showToast(`保存失败: ${err.message}`, true);
  }
}

el.modelSelect.addEventListener("change", () => {
  updateSetting({ model: el.modelSelect.value });
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
  const modeHint =
    state?.settings?.workflowMode === "plan_first"
      ? "请先按当前项目情况写出详细的 Codex 执行任务单给我确认，确认后再调用 Codex Bridge 执行："
      : "请整理为清晰的执行要求，直接调用 Codex Bridge 派给 Codex 执行，并把反馈结果汇报给我：";
  await sendToConversation(`${modeHint}\n\n${raw}`);
  el.quickTask.value = "";
});

el.btnCheckStatus.addEventListener("click", async () => {
  await sendToConversation("请调用 codex_info 检查当前 Codex Bridge 的配置与连接状态。");
});

fetchState(true);
setInterval(() => fetchState(true), 8000);
