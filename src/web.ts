import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { configFile } from "./paths.js";
import { safeReadJson, parseRouteEntry, normalizeUrlKey, type ProviderRoute, type ProviderRoutes } from "./config.js";
import { log } from "./logger.js";

function getVersion(): string {
    try {
        const here = fileURLToPath(import.meta.url);
        const pkg = join(dirname(here), "..", "package.json");
        return (JSON.parse(readFileSync(pkg, "utf8")).version as string) ?? "dev";
    } catch {
        return "dev";
    }
}

/** Read the raw `providers` block from the config file (inline form only).
 *  Returns whatever is there, normalized to ProviderRoutes. */
export function readProviders(): ProviderRoutes {
    const parsed = safeReadJson(configFile());
    const routes: ProviderRoutes = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const providers = (parsed as { providers?: Record<string, unknown> }).providers;
        if (providers) {
            for (const [k, v] of Object.entries(providers)) {
                const route = parseRouteEntry(v);
                if (route) routes[k] = route;
            }
        }
    }
    return routes;
}

// ─── API handlers ───────────────────────────────────────────────────────────

export async function handleConfigGet(res: ServerResponse): Promise<void> {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: configFile(), providers: readProviders() }, null, 2));
}

export async function handleConfigPut(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readJsonBody(req);
    if (!raw || typeof raw !== "object") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "expected JSON body" }));
        return;
    }
    const body = raw as Record<string, unknown>;
    if (!body.providers || typeof body.providers !== "object" || Array.isArray(body.providers)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "expected JSON: { \"providers\": { ... } }" }));
        return;
    }
    // Validate each route entry before touching the file. The KEY is the
    // upstream URL (what the client puts after /bili/); the VALUE is {models}.
    const routes: Record<string, ProviderRoute> = {};
    for (const [url, val] of Object.entries(body.providers as Record<string, unknown>)) {
        if (!url || typeof url !== "string") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: `invalid provider key: ${JSON.stringify(url)}` }));
            return;
        }
        const route = parseRouteEntry(val);
        if (!route) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: `invalid provider "${url}": expected { "models": { ... } } or null (the key is the upstream URL)` }));
            return;
        }
        routes[normalizeUrlKey(url)] = route;
    }
    // Merge into the existing file so we never clobber port/host/debug/etc.
    // Write the normalized routes (validated + trailing slashes stripped) so
    // the on-disk file stays clean regardless of what the client sent.
    const existing = (safeReadJson(configFile()) ?? {}) as Record<string, unknown>;
    existing.providers = routes;
    try {
        mkdirSync(dirname(configFile()), { recursive: true });
        writeFileSync(configFile(), JSON.stringify(existing, null, 2) + "\n", "utf8");
    } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `failed to write: ${String(e)}` }));
        return;
    }
    log("info", `[acp-web] providers updated via web UI (${Object.keys(routes).length} upstream URL(s)) — restart to apply`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: Object.keys(routes).length, note: "restart bili to apply" }));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > 256 * 1024) {
                req.destroy();
                resolve(undefined);
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                resolve(undefined);
            }
        });
        req.on("error", () => resolve(undefined));
    });
}

// ─── HTML UI ────────────────────────────────────────────────────────────────

export function renderUI(origin: string): string {
    return HTML_UI.replace(/__ORIGIN__/g, origin).replace(/__VERSION__/g, getVersion());
}

// Single-page UI. No framework, no build step, no external assets.
// Escaped backticks/dollar-braces so the outer TS template literal is clean.
const HTML_UI = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>billion-context</title>
<style>
:root {
  --bg: #1a1b26; --bg2: #24283b; --bg3: #2f334d;
  --fg: #c0caf5; --dim: #565f89; --accent: #7aa2f7; --accent2: #bb9af7;
  --ok: #9ece6a; --warn: #e0af68; --err: #f7768e;
  --border: #3b4261; --radius: 8px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  background: var(--bg); color: var(--fg); line-height: 1.5; min-height: 100vh;
}
.mono { font-family: "SF Mono", "Cascadia Code", Consolas, monospace; }
header {
  display: flex; align-items: center; gap: 16px;
  padding: 16px 24px; border-bottom: 1px solid var(--border);
}
header a { color: inherit; text-decoration: none; }
header .logo { font-size: 18px; font-weight: 600; cursor: pointer; }
header .logo:hover { opacity: 0.85; }
header .logo span { color: var(--accent); }
header .meta { font-size: 12px; color: var(--dim); }
header .meta b { color: var(--fg); }
header .gh {
  margin-left: auto; font-size: 13px; color: var(--dim); text-decoration: none;
  display: flex; align-items: center; gap: 6px; padding: 6px 12px;
  border: 1px solid var(--border); border-radius: var(--radius); transition: color .15s, border-color .15s;
}
header .gh:hover { color: var(--accent); border-color: var(--accent); }
nav { display: flex; gap: 4px; padding: 0 24px; border-bottom: 1px solid var(--border); }
nav button {
  background: none; border: none; color: var(--dim); cursor: pointer;
  padding: 12px 16px; font-size: 14px; border-bottom: 2px solid transparent;
  font-family: inherit; transition: color .15s;
}
nav button:hover { color: var(--fg); }
nav button.active { color: var(--accent); border-bottom-color: var(--accent); }
main { max-width: 800px; margin: 0 auto; padding: 24px; }
.tab { display: none; }
.tab.active { display: block; }

.card {
  background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 16px; margin-bottom: 12px;
}
.card-head {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;
}
.card-head .name { font-weight: 600; color: var(--accent); }
.card-head .name input { font-weight: 600; color: var(--accent); }
input, select {
  background: var(--bg3); border: 1px solid var(--border); border-radius: 4px;
  color: var(--fg); padding: 6px 10px; font-size: 13px; font-family: inherit; width: 100%;
}
input:focus, select:focus { outline: none; border-color: var(--accent); }
.row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.row label { font-size: 12px; color: var(--dim); min-width: 80px; }
.row input { flex: 1; }
.sub-card {
  background: var(--bg3); border-radius: 4px; padding: 10px 12px; margin: 8px 0 8px 20px;
  border-left: 2px solid var(--accent2);
}
.model-head { display: flex; justify-content: space-between; align-items: center; }
.model-head .mname { color: var(--accent2); font-size: 13px; font-weight: 500; }
.model-row { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
.model-row label { font-size: 11px; color: var(--dim); min-width: 60px; }
.model-row input { flex: 1; font-family: "SF Mono", monospace; font-size: 12px; }
.btn {
  background: var(--bg3); border: 1px solid var(--border); border-radius: 4px;
  color: var(--fg); padding: 8px 14px; font-size: 13px; cursor: pointer; font-family: inherit;
  transition: background .15s, border-color .15s;
}
.btn:hover { background: var(--border); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 500; }
.btn.primary:hover { background: var(--accent2); border-color: var(--accent2); }
.btn.danger { color: var(--err); }
.btn.danger:hover { background: rgba(247,118,142,.1); }
.btn.small { padding: 4px 8px; font-size: 12px; }
.add-bar { display: flex; gap: 8px; margin: 12px 0; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

.snippet {
  background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
  padding: 12px; margin-bottom: 12px; position: relative;
}
.snippet .label { font-size: 12px; color: var(--dim); margin-bottom: 4px; }
.snippet .label b { color: var(--fg); }
.snippet code { display: block; font-size: 13px; color: var(--ok); white-space: pre-wrap; word-break: break-all; }
.snippet .copy { position: absolute; top: 8px; right: 8px; }
.client-setup { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--border); }
.client-head { font-size: 12px; color: var(--dim); margin-bottom: 8px; }

table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; padding: 8px 12px; color: var(--dim); font-weight: 500; border-bottom: 1px solid var(--border); }
td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
td.mono { color: var(--accent); font-size: 12px; }
.empty { text-align: center; padding: 32px; color: var(--dim); font-size: 14px; }
.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  background: var(--ok); color: var(--bg); padding: 10px 20px; border-radius: var(--radius);
  font-size: 14px; font-weight: 500; opacity: 0; transition: opacity .3s; pointer-events: none;
}
.toast.show { opacity: 1; }
.toast.err { background: var(--err); color: var(--bg); }
.notice {
  background: rgba(224,175,104,.1); border: 1px solid var(--warn); border-radius: var(--radius);
  color: var(--warn); padding: 10px 14px; margin-bottom: 16px; font-size: 13px;
}
select { cursor: pointer; }
</style>
</head>
<body>
<header>
  <a class="logo" href="https://github.com/ranxianglei/billion-context" target="_blank" rel="noopener" title="GitHub repo">billion<span>-context</span></a>
  <div class="meta">v<b>__VERSION__</b> &middot; <b>__ORIGIN__</b></div>
  <a class="gh" href="https://github.com/ranxianglei/billion-context" target="_blank" rel="noopener">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    GitHub
  </a>
</header>
<nav>
  <button class="active" onclick="showTab('providers')">Providers</button>
  <button onclick="showTab('sessions')">Sessions</button>
</nav>
<main>
  <!-- Providers tab (URL + models + client config, all in one) -->
  <div id="tab-providers" class="tab active">
    <div id="restart-notice" class="notice" style="display:none"></div>
    <div id="providers-list"></div>
    <div class="add-bar">
      <button class="btn" onclick="addProvider()">+ Add provider</button>
    </div>
    <div class="actions">
      <button class="btn" onclick="applyProviders()">Apply</button>
      <button class="btn primary" onclick="saveProviders()">Save</button>
    </div>
  </div>

  <!-- Sessions tab -->
  <div id="tab-sessions" class="tab">
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <span style="font-size:13px;color:var(--dim)">Auto-refreshes every 5s</span>
      <span id="sess-total" style="font-size:13px;color:var(--dim)"></span>
    </div>
    <div id="sessions-table"></div>
  </div>
</main>
<div id="toast" class="toast"></div>

<script>
var ORIGIN = "__ORIGIN__";
var providers = [];
var savedProviders = null;

// ── helpers ──
function el(id) { return document.getElementById(id); }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function fmtTok(n) { if (n >= 1000000) return (n/1000000).toFixed(1)+"M"; if (n >= 1000) return (n/1000).toFixed(1)+"K"; return String(n); }
function toast(msg, isErr) {
  var t = el("toast"); t.textContent = msg; t.className = "toast show" + (isErr ? " err" : "");
  setTimeout(function(){ t.className = "toast" + (isErr ? " err" : ""); }, 2500);
}
function showTab(name) {
  document.querySelectorAll(".tab").forEach(function(t){ t.classList.remove("active"); });
  document.querySelectorAll("nav button").forEach(function(b){ b.classList.remove("active"); });
  el("tab-"+name).classList.add("active");
  event.target.classList.add("active");
  if (name === "sessions") refreshSessions();
}

// ── load ──
async function load() {
  try {
    var r = await fetch("/__acp/config");
    var d = await r.json();
    providers = entries(d.providers);
    savedProviders = JSON.stringify(providers);
    renderProviders();
  } catch(e) {
    el("providers-list").innerHTML = '<div class="empty">Failed to load config: ' + esc(e) + "</div>";
  }
}
function entries(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj).map(function(url){
    var v = obj[url];
    var models = [];
    if (v && typeof v === "object" && !Array.isArray(v)) models = entries_models(v.models);
    return { url: url, models: models };
  });
}
function entries_models(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj).map(function(name){
    return { name: name, context: obj[name].context||0 };
  });
}

// ── providers editor ──
function renderProviders() {
  var html = "";
  if (providers.length === 0) html = '<div class="empty">No providers yet. Click "Add provider" below.</div>';
    providers.forEach(function(p, i) {
    html += '<div class="card">';
    html += '<div class="card-head"><div class="name"><input class="mono" value="'+esc(p.url)+'" onchange="providers['+i+'].url=this.value" placeholder="https://upstream/api/path" style="background:transparent;border:none;padding:0;width:100%"></div>';
    html += '<button class="btn danger small" onclick="removeProvider('+i+')">Remove</button></div>';
    p.models.forEach(function(m, j) {
      html += '<div class="sub-card">';
      html += '<div class="model-head"><span class="mname mono">'+esc(m.name)+'</span>';
      html += '<button class="btn danger small" onclick="removeModel('+i+','+j+')">Remove</button></div>';
      html += '<div class="model-row"><label>context</label><input type="number" value="'+m.context+'" onchange="providers['+i+'].models['+j+'].context=parseInt(this.value)||0" placeholder="optional"></div>';
      html += '<div class="model-row"><label>name</label><input value="'+esc(m.name)+'" onchange="providers['+i+'].models['+j+'].name=this.value"></div>';
      html += '</div>';
    });
    html += '<button class="btn small" onclick="addModel('+i+')">+ Add model</button>';
    html += '</div>';
  });
  el("providers-list").innerHTML = html;
  checkDirty();
}
function addProvider() {
  providers.push({ url: "https://api.example.com", models: [] });
  renderProviders();
}
function removeProvider(i) {
  providers.splice(i, 1);
  renderProviders();
}
function addModel(i) {
  providers[i].models.push({ name: "model-name", context: 0 });
  renderProviders();
}
function removeModel(i, j) {
  providers[i].models.splice(j, 1);
  renderProviders();
}
function checkDirty() {
  var dirty = savedProviders !== null && JSON.stringify(providers) !== savedProviders;
  var n = el("restart-notice");
  if (dirty) { n.style.display = "block"; n.textContent = "Unsaved changes — click Save to write to the config file, then click Apply to activate without restart."; }
  else { n.style.display = "none"; }
}

// ── apply (hot-reload routes into running process) ──
async function applyProviders() {
  // Apply always re-reads the config FILE, so require a Save first if dirty.
  if (savedProviders !== JSON.stringify(providers)) {
    toast("Save your changes first", true);
    return;
  }
  try {
    var r = await fetch("/__acp/config/reload", { method: "POST" });
    var d = await r.json();
    if (r.ok) { toast("Applied — " + d.count + " providers active (no restart needed)"); }
    else { toast("Apply failed: " + (d.error || "unknown"), true); }
  } catch(e) { toast("Apply failed: " + e, true); }
}

// ── save ──
async function saveProviders() {
  var obj = {};
  providers.forEach(function(p) {
    if (!p.url) return;
    // Strip trailing slashes (keys must be prefix-matchable). Done without a
    // regex literal because the HTML is inlined into a template string and
    // backslash escaping there is brittle.
    var key = p.url;
    while (key.length > 1 && key.charAt(key.length - 1) === "/") key = key.slice(0, -1);
    if (!key) return;
    if (p.models.length === 0) { obj[key] = {}; }
    else {
      var models = {};
      p.models.forEach(function(m){ if(m.name) models[m.name] = { context: m.context }; });
      obj[key] = { models: models };
    }
  });
  try {
    var r = await fetch("/__acp/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providers: obj }) });
    var d = await r.json();
    if (r.ok) { savedProviders = JSON.stringify(providers); checkDirty(); toast("Saved " + d.count + " provider(s) — click Apply to activate"); }
    else { toast("Error: " + (d.error || "unknown"), true); }
  } catch(e) { toast("Save failed: " + e, true); }
}

// ── snippets (used inline in each provider card) ──
function snippet(label, code) {
  var c = code.replace(/"/g, "&quot;");
  return '<div class="snippet"><div class="label"><b>' + label + '</b></div><code>' + esc(code) + '</code><button class="btn small copy" onclick="copyText(this,\\''+c+'\\')">Copy</button></div>';
}
function copyText(btn, text) {
  var t = text.replace(/&quot;/g, '"');
  navigator.clipboard.writeText(t).then(function(){ toast("Copied"); });
}

// ── sessions ──
async function refreshSessions() {
  try {
    var r = await fetch("/__acp/stats");
    var d = await r.json();
    var ss = d.sessions || [];
    el("sess-total").textContent = ss.length + " session" + (ss.length !== 1 ? "s" : "");
    if (ss.length === 0) { el("sessions-table").innerHTML = '<div class="empty">No sessions yet. Send a request through the proxy.</div>'; return; }
    var h = '<table><tr><th>ID</th><th>Requests</th><th>Tokens saved</th><th>Last seen</th></tr>';
    var h = '<table><tr><th>Title</th><th>Protocol</th><th>Label</th><th>Requests</th><th>Context</th><th>Cache hit</th><th>Input</th><th>Output</th><th>Last seen</th></tr>';
    ss.forEach(function(s) {
      var title = s.title ? esc(s.title) : "<span class='dim'>—</span>";
      var proto = s.protocol ? esc(s.protocol) : "<span class='dim'>?</span>";
      var label = s.label ? "<span class=\\"mono\\">"+esc(s.label.slice(0,24))+"</span>" : "<span class='dim'>—</span>";
      var ctx = s.contextTokens ? fmtTok(s.contextTokens) : "0";
      var ch = (s.cacheHitPct !== null && s.cacheHitPct !== undefined) ? s.cacheHitPct + "%" : "<span class='dim'>—</span>";
      var inp = s.inputTokens ? fmtTok(s.inputTokens) : "0";
      var out = s.outputTokens ? fmtTok(s.outputTokens) : "0";
      h += "<tr><td>"+title+"</td><td>"+proto+"</td><td>"+label+"</td><td>"+s.requests+"</td><td>"+ctx+"</td><td>"+ch+"</td><td>"+inp+"</td><td>"+out+"</td><td>"+esc(s.lastSeen)+"</td></tr>";
    });
    h += "</table>";
    el("sessions-table").innerHTML = h;
  } catch(e) { el("sessions-table").innerHTML = '<div class="empty">Failed to load: ' + esc(e) + "</div>"; }
}
setInterval(function(){ if (el("tab-sessions").classList.contains("active")) refreshSessions(); }, 5000);

load();
</script>
</body>
</html>`;
