/* Sarathy SPA — chat-first mobile portal. No build step. */
"use strict";

const state = {
  sessionId: null,
  running: false,
  streams: new Map(), // messageId -> { el, text }
  sessions: [],
  config: null,
};

const $ = (id) => document.getElementById(id);

/* -------- inline SVG icon set (Lucide-style, stroke-based) -------- */
const ICONS = {
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
};

function icon(name) {
  return ICONS[name] || "";
}

/* ------------------------------------------------------------------ api */
async function api(method, path, body, raw = false) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || res.statusText);
  }
  return raw ? res : res.json();
}

/* ------------------------------------------------------------------ auth */
function showLogin() {
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
}
function hideLogin() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = $("pairing-token").value.trim();
  $("login-error").classList.add("hidden");
  try {
    await api("POST", "/api/auth/login", { token });
    $("pairing-token").value = "";
    hideLogin();
    init();
  } catch (err) {
    $("login-error").textContent = "Invalid pairing token";
    $("login-error").classList.remove("hidden");
  }
});

/* ------------------------------------------------------------------ toast */
let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4000);
}

/* ------------------------------------------------------------------ tabs */
document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $("view-" + btn.dataset.view).classList.add("active");
    if (btn.dataset.view === "sessions") loadSessions();
    if (btn.dataset.view === "settings") loadSettings();
  });
});
$("btn-settings").addEventListener("click", () =>
  document.querySelector('.tabs button[data-view="settings"]').click()
);
$("btn-sessions").addEventListener("click", () =>
  document.querySelector('.tabs button[data-view="sessions"]').click()
);

$("btn-new").addEventListener("click", async () => {
  const s = await api("POST", "/api/sessions");
  await switchSession(s.session_id);
  toast("New session");
});

$("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("input").value.trim();
  if (!text || !state.sessionId) return;
  $("input").value = "";
  $("input").style.height = "auto";
  await api("POST", `/api/sessions/${state.sessionId}/messages`, { content: text });
});

$("input").addEventListener("input", () => {
  $("input").style.height = "auto";
  $("input").style.height = Math.min($("input").scrollHeight, 120) + "px";
});

$("stop-btn").addEventListener("click", async () => {
  if (!state.sessionId) return;
  await api("POST", `/api/sessions/${state.sessionId}/cancel`);
  api("POST", `/api/sessions/${state.sessionId}/read`);
});

$("btn-save").addEventListener("click", saveConfig);
$("btn-restart").addEventListener("click", async () => {
  await api("POST", "/api/config/restart");
  toast("Restarting gateway…");
});
$("btn-install-ext").addEventListener("click", async () => {
  const url = $("ext-url").value.trim();
  if (!url) return;
  await api("POST", "/api/extensions/install", { url });
  $("ext-url").value = "";
  toast("Installed");
  loadSettings();
});
$("btn-reload-ext").addEventListener("click", async () => {
  await api("POST", "/api/extensions/reload");
  toast("Extensions reloaded");
  loadSettings();
});
$("cron-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("POST", "/api/cron", {
    body: $("cron-body").value.trim(),
    schedule: $("cron-schedule").value.trim() || "0 9 * * *",
  });
  $("cron-body").value = "";
  toast("Scheduled");
  loadCron();
});
$("btn-consolidate").addEventListener("click", async () => {
  const r = await api("POST", "/api/memory/consolidate");
  toast(`Consolidated: ${r.added} fact(s)`);
});

/* ------------------------------------------------------------------ sessions */
async function switchSession(sessionId) {
  state.sessionId = sessionId;
  state.streams.clear();
  const t = await api("GET", `/api/sessions/${sessionId}`);
  state.running = t.running;
  $("session-title").textContent = t.title || sessionId;
  renderMessages(t.messages || []);
  $("stop-btn").classList.toggle("hidden", !t.running);
  api("POST", `/api/sessions/${sessionId}/read`).catch(() => {});
  const tab = document.querySelector('.tabs button[data-view="chat"]');
  tab.click();
}

function renderMessages(messages) {
  const box = $("messages");
  box.innerHTML = "";
  for (const m of messages) {
    const el = appendMessage(m.role, m.content, m.toolName || m.tool_name);
    if (m.role === "assistant") {
      state.streams.set(el.dataset.mid || String(Math.random()), { el, text: m.content });
    }
  }
  box.scrollTop = box.scrollHeight;
}

function appendMessage(role, content, toolName) {
  const box = $("messages");
  const div = document.createElement("div");
  div.className = "msg " + role;
  if (role === "tool") {
    const span = document.createElement("span");
    span.className = "toolname";
    span.innerHTML = icon("tool");
    const label = document.createElement("span");
    label.textContent = toolName || "tool";
    span.appendChild(label);
    div.appendChild(span);
  }
  const text = document.createElement("div");
  text.className = "content";
  text.textContent = content || "";
  div.appendChild(text);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

async function loadSessions() {
  const { sessions } = await api("GET", "/api/sessions");
  state.sessions = sessions;
  const ul = $("session-list");
  ul.innerHTML = "";
  for (const s of sessions) {
    const li = document.createElement("li");
    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = s.title || s.session_id;
    const sub = document.createElement("div");
    sub.className = "sub";
    const when = s.created_at ? new Date(s.created_at).toLocaleString() : "—";
    sub.textContent = `${when} · ${s.messages ? s.messages.length : 0} msg · ${s.running ? "running" : "idle"}`;
    meta.append(title, sub);
    li.append(meta);
    li.addEventListener("click", () => switchSession(s.session_id));
    ul.appendChild(li);
  }
}

/* ------------------------------------------------------------------ settings */
async function loadSettings() {
  const cfg = await api("GET", "/api/config");
  state.config = cfg;
  $("cfg-model").value = cfg.agents?.defaults?.model || "";
  $("cfg-provider").value = cfg.agents?.defaults?.provider || "custom";
  const prov = cfg.providers?.[cfg.agents?.defaults?.provider] || cfg.providers?.custom || {};
  $("cfg-api-base").value = prov.api_base || "";
  $("cfg-api-key").value = "";
  $("cfg-web-auth").value = String(!!cfg.web?.auth?.enabled);
  await loadExtensions();
  await loadSkills();
  await loadCron();
}

async function saveConfig() {
  const cfg = state.config;
  cfg.agents.defaults.model = $("cfg-model").value.trim();
  cfg.agents.defaults.provider = $("cfg-provider").value;
  const provider = cfg.providers[$("cfg-provider").value];
  provider.api_base = $("cfg-api-base").value.trim();
  const key = $("cfg-api-key").value.trim();
  if (key) provider.api_key = key;
  cfg.web.auth.enabled = $("cfg-web-auth").value === "true";
  await api("PUT", "/api/config", cfg);
  toast("Config saved (restart to apply)");
}

async function loadExtensions() {
  const { extensions } = await api("GET", "/api/extensions");
  const box = $("extension-list");
  box.innerHTML = "";
  for (const ext of extensions) {
    const div = document.createElement("div");
    div.className = "list-item";
    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = ext.name;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `tools: ${(ext.tools || []).join(", ") || "—"} · commands: ${(ext.commands || []).join(", ") || "—"}`;
    meta.append(title, sub);
    const rm = document.createElement("button");
    rm.className = "ghost icon-btn";
    rm.title = "Uninstall";
    rm.innerHTML = icon("x");
    rm.onclick = async () => {
      await api("DELETE", `/api/extensions/${ext.name}`);
      loadExtensions();
    };
    div.append(meta, rm);
    box.appendChild(div);
  }
}

async function loadSkills() {
  const { skills } = await api("GET", "/api/skills");
  const box = $("skills-list");
  box.innerHTML = "";
  for (const s of skills || []) {
    const div = document.createElement("div");
    div.className = "list-item";
    div.textContent = (s.name || s.description || "skill") + " — " + (s.description || "");
    box.appendChild(div);
  }
}

async function loadCron() {
  const { jobs } = await api("GET", "/api/cron");
  const box = $("cron-list");
  box.innerHTML = "";
  for (const job of jobs) {
    const div = document.createElement("div");
    div.className = "list-item";
    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = job.name || job.id;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `${job.schedule?.expr || "?"} · ${job.payload?.message?.slice(0, 40) || ""}`;
    meta.append(title, sub);
    const rm = document.createElement("button");
    rm.className = "ghost icon-btn";
    rm.title = "Delete";
    rm.innerHTML = icon("x");
    rm.onclick = async () => {
      await api("DELETE", `/api/cron/${job.id}`);
      loadCron();
    };
    div.append(meta, rm);
    box.appendChild(div);
  }
}

/* ------------------------------------------------------------------ SSE */
function openEvents() {
  const es = new EventSource("/api/events");
  const events = [
    "agent_start", "agent_end", "agent_settled",
    "turn_start", "turn_end",
    "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "run_start", "run_end", "session_created", "notify",
  ];
  events.forEach((name) => {
    es.addEventListener(name, (e) => handleEvent(name, JSON.parse(e.data)));
  });
  es.onerror = () => setTimeout(() => openEvents(), 3000);
}

function handleEvent(type, data) {
  const sid = data.session_id;

  if (type === "notify") {
    toast(data.message);
    return;
  }

  if (sid !== state.sessionId) {
    // background session: bump badge via polling
    refreshBadge();
    return;
  }

  switch (type) {
    case "run_start":
      state.running = true;
      $("stop-btn").classList.remove("hidden");
      appendMessage("user", data.content || "");
      break;
    case "message_update": {
      const msg = data.message;
      const mid = msg.id;
      const text = (msg.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      const entry = state.streams.get(mid);
      if (entry) {
        entry.text = text;
        entry.el.querySelector(".content").textContent = text + "▍";
      } else {
        const el = appendMessage("assistant", text + "▍");
        el.dataset.mid = mid;
        state.streams.set(mid, { el, text });
      }
      break;
    }
    case "message_end": {
      const msg = data.message;
      const mid = msg.id;
      const role = msg.role === "assistant" ? "assistant" : msg.role === "tool" ? "tool" : "assistant";
      if (role === "tool") {
        const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
        appendMessage("tool", text, msg.tool_name);
      } else {
        const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
        const entry = state.streams.get(mid);
        if (entry) {
          entry.el.querySelector(".content").textContent = text;
          state.streams.delete(mid);
        } else {
          appendMessage("assistant", text);
        }
      }
      api("POST", `/api/sessions/${sid}/read`).catch(() => {});
      refreshBadge();
      break;
    }
    case "tool_execution_start": {
      const name = data.call?.name || data.tool_name || "tool";
      if (!state.running) appendMessage("tool", `running ${name}…`, name);
      break;
    }
    case "run_end":
      state.running = false;
      $("stop-btn").classList.add("hidden");
      refreshBadge();
      break;
  }
}

/* ------------------------------------------------------------------ badge */
function setBadge(total) {
  const tab = document.querySelector('.tabs button[data-view="sessions"]');
  if (!tab) return;
  tab.querySelector("span").textContent = total > 0 ? `Sessions (${total})` : "Sessions";
  // update page title for lock-screen preview
  document.title = total > 0 ? `Sarathy (${total})` : "Sarathy";
}

async function refreshBadge() {
  try {
    const counts = await api("GET", "/api/notifications");
    setBadge(counts.total || 0);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ init */
async function init() {
  try {
    const { authEnabled } = await api("GET", "/api/auth/status");
    if (!authEnabled) hideLogin();
    else if (!$("app").classList.contains("hidden")) hideLogin();
  } catch {
    return;
  }
  openEvents();
  try {
    const { sessions } = await api("GET", "/api/sessions");
    state.sessions = sessions;
    if (sessions.length) {
      await switchSession(sessions[0].session_id);
    } else {
      const s = await api("POST", "/api/sessions");
      await switchSession(s.session_id);
    }
  } catch (err) {
    toast(String(err.message || err));
  }
}

(async () => {
  try {
    await api("GET", "/api/auth/status");
    hideLogin();
    init();
  } catch {
    showLogin();
  }
})();