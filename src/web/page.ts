import { existsSync } from "node:fs";
import { rootCaPath } from "../ca.js";
import { WEB_CLIENT } from "./client.js";
import { WEB_STYLES } from "./styles.js";
import { translate } from "./i18n.js";

const zh = (key: string) => translate("zh-CN", key);

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) =>
        char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === '"' ? "&quot;" : "&#39;");
}

export function renderPage(origin: string, version: string): string {
    const o = escapeHtml(origin);
    const caPath = rootCaPath();
    const caPathEsc = escapeHtml(caPath);
    const caReady = existsSync(caPath);
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>billion-context</title><style>${WEB_STYLES}</style></head><body>
<header class="topbar"><div class="brand"><span class="logo">∞</span>billion-context<span class="ver">v${version}</span></div><nav class="nav"><a href="#/overview" data-nav="overview" class="active" data-i18n="nav.overview">${zh("nav.overview")}</a><a href="#/sessions" data-nav="sessions" data-i18n="nav.sessions">${zh("nav.sessions")}</a><a href="#/config" data-nav="config" data-i18n="nav.config">${zh("nav.config")}</a><a href="#/connect" data-nav="connect" data-i18n="nav.connect">${zh("nav.connect")}</a></nav><div class="actions"><a class="fork-link" href="https://github.com/ranxianglei/billion-context" target="_blank" rel="noopener" data-i18n="fork.label">${zh("fork.label")}</a><button id="language-toggle" class="lang-btn">English</button></div></header>
<div id="passthrough-banner" class="banner warn" hidden></div>
<div id="stale-banner" class="banner warn" hidden></div>
<div id="conflicts-banner" class="banner warn" hidden></div>
<main>
<section id="page-overview" class="page">
<div class="page-head"><div><h1 data-i18n="ov.title">${zh("ov.title")}</h1><div class="sub" data-i18n="ov.sub">${zh("ov.sub")}</div></div></div>
<div class="grid cols-4">
<div class="stat"><div class="k" data-i18n="ov.total_sessions">${zh("ov.total_sessions")}</div><div class="v" id="st-sessions">—</div><div class="s" id="st-sessions-sub"></div></div>
<div class="stat"><div class="k" data-i18n="ov.total_requests">${zh("ov.total_requests")}</div><div class="v" id="st-reqs">—</div></div>
<div class="stat good"><div class="k" data-i18n="ov.gross_saved">${zh("ov.gross_saved")}</div><div class="v" id="st-gross">—</div><div class="s" id="st-gross-sub" data-i18n="common.none">${zh("common.none")}</div></div>
<div class="stat good"><div class="k" data-i18n="ov.net_saved">${zh("ov.net_saved")}</div><div class="v" id="st-netsaved">—</div><div class="s" id="st-net-sub"></div></div>
<div class="stat"><div class="k" data-i18n="ov.global_hitpct">${zh("ov.global_hitpct")}</div><div class="v" id="st-hitpct">—</div></div>
<div class="stat"><div class="k" data-i18n="ov.input_tokens">${zh("ov.input_tokens")}</div><div class="v" id="st-input">—</div></div>
<div class="stat"><div class="k" data-i18n="ov.cached_tokens">${zh("ov.cached_tokens")}</div><div class="v" id="st-cached">—</div></div>
<div class="stat"><div class="k" data-i18n="ov.output_tokens">${zh("ov.output_tokens")}</div><div class="v" id="st-output">—</div></div>
</div>
<div class="grid cols-2" style="margin-top:16px">
<div class="card"><div class="card-h"><span data-i18n="ov.by_protocol">${zh("ov.by_protocol")}</span></div><div class="card-b flush"><table class="data"><thead><tr><th data-i18n="common.protocol">${zh("common.protocol")}</th><th class="num" data-i18n="common.sessions">${zh("common.sessions")}</th><th class="num" data-i18n="ses.th_reqs">${zh("ses.th_reqs")}</th><th class="num" data-i18n="ov.input_tokens">${zh("ov.input_tokens")}</th><th class="num" data-i18n="ov.cached_tokens">${zh("ov.cached_tokens")}</th></tr></thead><tbody id="protocol-body"></tbody></table></div></div>
<div class="card"><div class="card-h"><span data-i18n="sys.title">${zh("sys.title")}</span></div><div class="card-b"><dl class="kv">
<div class="k" data-i18n="sys.version">${zh("sys.version")}</div><div class="v mono" id="sys-version"></div>
<div class="k" data-i18n="sys.disk_version">${zh("sys.disk_version")}</div><div class="v mono" id="sys-disk-version"></div>
<div class="k" data-i18n="sys.inflight">${zh("sys.inflight")}</div><div class="v mono" id="sys-inflight">0</div>
<div class="k" data-i18n="sys.blind_tunnels">${zh("sys.blind_tunnels")}</div><div class="v mono" id="sys-blind">0</div>
</dl></div></div>
</div>
<div class="card" style="margin-top:16px"><div class="card-h"><span data-i18n="ov.recent">${zh("ov.recent")}</span><a class="btn sm" href="#/sessions" data-i18n="ov.view_all">${zh("ov.view_all")}</a></div><div class="card-b flush"><table class="data"><thead><tr>
<th data-i18n="ses.th_title">${zh("ses.th_title")}</th><th data-i18n="ses.th_proto">${zh("ses.th_proto")}</th><th class="num" data-i18n="ses.th_ctx">${zh("ses.th_ctx")}</th><th class="num" data-i18n="ses.th_saved">${zh("ses.th_saved")}</th><th data-i18n="ses.th_seen">${zh("ses.th_seen")}</th>
</tr></thead><tbody id="recent-body"></tbody></table></div></div>
</section>
<section id="page-sessions" class="page" hidden>
<div id="sessions-list-view">
<div class="page-head"><div><h1 data-i18n="ses.title">${zh("ses.title")}</h1><div class="sub" data-i18n="ses.sub">${zh("ses.sub")}</div></div>
<div style="display:flex;gap:10px;align-items:center"><input id="ses-search" type="search" class="search" placeholder="${zh("ses.search_ph")}" data-i18n-ph="ses.search_ph"><span id="ses-count" class="dim small"></span></div></div>
<div class="card"><div class="card-b flush"><table class="data"><thead><tr>
<th data-i18n="ses.th_title">${zh("ses.th_title")}</th><th data-i18n="ses.th_proto">${zh("ses.th_proto")}</th><th data-i18n="ses.th_upstream">${zh("ses.th_upstream")}</th><th class="num" data-i18n="ses.th_reqs">${zh("ses.th_reqs")}</th><th class="num" data-i18n="ses.th_ctx">${zh("ses.th_ctx")}</th><th class="num" data-i18n="ses.th_saved">${zh("ses.th_saved")}</th><th class="num" data-i18n="ses.th_hit">${zh("ses.th_hit")}</th><th class="num" data-i18n="ses.th_blocks">${zh("ses.th_blocks")}</th><th data-i18n="ses.th_seen">${zh("ses.th_seen")}</th>
</tr></thead><tbody id="sessions-body"></tbody></table></div></div>
</div>
<section id="session-detail-view" hidden></section>
</section>
<section id="page-config" class="page" hidden>
<div class="page-head"><div><h1 data-i18n="cfg.title">${zh("cfg.title")}</h1><div class="sub" data-i18n="cfg.sub">${zh("cfg.sub")}</div></div></div>
<div id="cfg-parse-error" class="banner err" hidden></div>
<div class="card"><div class="card-h"><span data-i18n="cfg.file">${zh("cfg.file")}</span></div><div class="card-b"><div class="copy-row"><pre class="codebox" id="cfg-file"></pre><button class="btn sm copy-btn" id="copy-cfg-file" data-copy=""><span data-i18n="common.copy">${zh("common.copy")}</span></button></div></div></div>
<div class="grid cols-2" style="margin-top:16px">
<div class="card"><div class="card-h"><span data-i18n="cfg.providers">${zh("cfg.providers")}</span></div><div class="card-b">
<p class="dim small" style="margin:0 0 8px" data-i18n="cfg.providers_edit_hint">${zh("cfg.providers_edit_hint")}</p>
<textarea id="providers-json" class="editor mono" spellcheck="false"></textarea>
<div style="margin-top:10px"><button id="save-providers" class="btn"><span data-i18n="cfg.save">${zh("cfg.save")}</span></button></div>
</div></div>
<div class="card"><div class="card-h"><span data-i18n="cfg.upstream_net">${zh("cfg.upstream_net")}</span></div><div class="card-b">
<div class="modes">
<label><input type="radio" name="proxy-mode" value="auto" checked><span data-i18n="cfg.up_auto">${zh("cfg.up_auto")}</span></label>
<label><input type="radio" name="proxy-mode" value="manual"><span data-i18n="cfg.up_manual">${zh("cfg.up_manual")}</span></label>
<label><input type="radio" name="proxy-mode" value="direct"><span data-i18n="cfg.up_direct">${zh("cfg.up_direct")}</span></label>
</div>
<input id="proxy-url" class="field-input mono" type="text" placeholder="http://127.0.0.1:7897" spellcheck="false">
<dl class="kv" style="margin-top:12px">
<div class="k" data-i18n="cfg.state">${zh("cfg.state")}</div><div class="v" id="up-state">—</div>
</dl>
<div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button id="save-upstream" class="btn"><span data-i18n="cfg.save">${zh("cfg.save")}</span></button><button id="test-upstream" class="btn"><span data-i18n="cfg.test_btn">${zh("cfg.test_btn")}</span></button><span class="dim small" data-i18n="cfg.test_hint">${zh("cfg.test_hint")}</span></div>
</div></div>
</div>
<div class="grid cols-2" style="margin-top:16px">
<div class="card"><div class="card-h"><span data-i18n="cfg.compress">${zh("cfg.compress")}</span></div><div class="card-b"><p class="dim small" style="margin:0 0 8px" data-i18n="cfg.compress_desc">${zh("cfg.compress_desc")}</p><textarea id="compress-json" class="editor mono" spellcheck="false"></textarea>
<div style="margin-top:10px"><button id="save-compress" class="btn"><span data-i18n="cfg.save">${zh("cfg.save")}</span></button></div>
</div></div>
<div class="card"><div class="card-h"><span data-i18n="cfg.passthrough">${zh("cfg.passthrough")}</span></div><div class="card-b"><div class="pt-row"><span id="pt-state" class="badge disk">—</span><span id="pt-source" class="dim small"></span></div><div style="margin-top:10px"><button id="clear-passthrough" class="btn sm" hidden><span data-i18n="cfg.pt_clear">${zh("cfg.pt_clear")}</span></button></div></div></div>
</div>
</section>
<section id="page-connect" class="page" hidden>
<div class="page-head"><div><h1 data-i18n="con.title">${zh("con.title")}</h1><div class="sub" data-i18n="con.sub">${zh("con.sub")}</div></div></div>
<div class="section-label" data-i18n="con.method_launcher">${zh("con.method_launcher")}</div>
<p class="small dim" data-i18n="con.method_launcher_hint">${zh("con.method_launcher_hint")}</p>
<div class="card"><div class="card-b"><div class="chips">
<span class="chip mono">bili pi</span><span class="chip mono">bili codex</span><span class="chip mono">bili claude</span><span class="chip mono">bili omp</span><span class="chip mono">bili opencode</span><span class="chip mono">bili hermes</span><span class="chip mono">bili dsh</span><span class="chip mono">bili codebuddy</span><span class="chip mono">bili qoder</span><span class="chip mono">bili trae</span><span class="chip mono">bili jcode</span><span class="chip mono">bili kimi</span><span class="chip mono">bili gemini</span><span class="chip mono">bili iflow</span><span class="chip mono">bili qwen</span><span class="chip mono">bili mcode</span><span class="chip mono">bili aider</span><span class="chip mono">bili copilot</span><span class="chip mono">bili amp</span><span class="chip mono">bili goose</span>
</div><p class="small dim" style="margin:10px 0 0"><span data-i18n="con.launcher_help_pre">${zh("con.launcher_help_pre")}</span> <span class="mono">bili --help</span></p></div></div>
<div class="section-label" data-i18n="con.method_a">${zh("con.method_a")}</div>
<p class="small dim"><span data-i18n="con.method_a_hint">${zh("con.method_a_hint")}</span> <span class="mono">${o}/bili/</span></p>
<div class="card"><div class="card-h"><span data-i18n="con.origin">${zh("con.origin")}</span></div><div class="card-b"><div class="copy-row"><pre class="codebox">${o}</pre><button class="btn sm copy-btn" data-copy="${o}"><span data-i18n="common.copy">${zh("common.copy")}</span></button></div></div></div>
<div class="grid cols-2">
<div class="card"><div class="card-h"><span data-i18n="card.opencode">${zh("card.opencode")}</span></div><div class="card-b">
<dl class="kv">
<div class="k" data-i18n="dt.config_file">${zh("dt.config_file")}</div><div class="v mono">~/.config/opencode/opencode.json</div>
<div class="k" data-i18n="dt.setting">${zh("dt.setting")}</div><div class="v mono">baseURL</div>
</dl>
<div class="copy-row" style="margin-top:10px"><pre class="codebox">${o}/bili/https://open.bigmodel.cn/api/coding/paas/v4</pre><button class="btn sm copy-btn" data-copy="${o}/bili/https://open.bigmodel.cn/api/coding/paas/v4"><span data-i18n="common.copy">${zh("common.copy")}</span></button></div>
</div></div>
<div class="card"><div class="card-h"><span data-i18n="card.codex_key">${zh("card.codex_key")}</span></div><div class="card-b">
<dl class="kv">
<div class="k" data-i18n="dt.config_file">${zh("dt.config_file")}</div><div class="v mono">~/.codex/config.toml</div>
<div class="k" data-i18n="dt.setting">${zh("dt.setting")}</div><div class="v mono">base_url</div>
</dl>
<div class="copy-row" style="margin-top:10px"><pre class="codebox">${o}/bili/https://api.openai.com/v1</pre><button class="btn sm copy-btn" data-copy="${o}/bili/https://api.openai.com/v1"><span data-i18n="common.copy">${zh("common.copy")}</span></button></div>
</div></div>
<div class="card"><div class="card-h"><span data-i18n="card.codex_login">${zh("card.codex_login")}</span><span class="dim small" data-i18n="routing.codex_auth_note">${zh("routing.codex_auth_note")}</span></div><div class="card-b">
<dl class="kv">
<div class="k" data-i18n="dt.setting">${zh("dt.setting")}</div><div class="v mono">openai_base_url</div>
<div class="k" data-i18n="dt.auth">${zh("dt.auth")}</div><div class="v">codex login</div>
</dl>
<div class="copy-row" style="margin-top:10px"><pre class="codebox">${o}/bili/https://chatgpt.com/backend-api/codex</pre><button class="btn sm copy-btn" data-copy="${o}/bili/https://chatgpt.com/backend-api/codex"><span data-i18n="common.copy">${zh("common.copy")}</span></button></div>
<p class="small dim" style="margin-top:10px"><span data-i18n="routing.codex_note_a">${zh("routing.codex_note_a")}</span> <span class="mono">model_provider</span> <span data-i18n="routing.codex_note_b">${zh("routing.codex_note_b")}</span> <span class="mono">model_provider = "openai"</span> <span data-i18n="routing.codex_note_c">${zh("routing.codex_note_c")}</span> <span class="mono">NO_PROXY=localhost,127.0.0.1</span> <span data-i18n="routing.codex_note_d">${zh("routing.codex_note_d")}</span> <span class="mono">localhost</span> <span data-i18n="routing.codex_note_e">${zh("routing.codex_note_e")}</span></p>
</div></div>
<div class="card"><div class="card-h"><span data-i18n="card.claude_key">${zh("card.claude_key")}</span></div><div class="card-b">
<dl class="kv">
<div class="k" data-i18n="dt.env">${zh("dt.env")}</div><div class="v mono">ANTHROPIC_BASE_URL</div>
</dl>
<div class="copy-row" style="margin-top:10px"><pre class="codebox">export ANTHROPIC_BASE_URL=${o}/bili/https://api.anthropic.com</pre><button class="btn sm copy-btn" data-copy="export ANTHROPIC_BASE_URL=${o}/bili/https://api.anthropic.com"><span data-i18n="common.copy">${zh("common.copy")}</span></button></div>
</div></div>
<div class="card"><div class="card-h"><span data-i18n="card.pi">${zh("card.pi")}</span></div><div class="card-b">
<dl class="kv">
<div class="k" data-i18n="dt.config_file">${zh("dt.config_file")}</div><div class="v mono">~/.pi/agent/models.json</div>
<div class="k" data-i18n="dt.setting">${zh("dt.setting")}</div><div class="v mono">baseUrl</div>
</dl>
<div class="copy-row" style="margin-top:10px"><pre class="codebox">${o}/bili/https://api.anthropic.com</pre><button class="btn sm copy-btn" data-copy="${o}/bili/https://api.anthropic.com"><span data-i18n="common.copy">${zh("common.copy")}</span></button></div>
</div></div>
<div class="card"><div class="card-h"><span data-i18n="card.other">${zh("card.other")}</span></div><div class="card-b">
<p class="small" style="margin:0 0 6px"><span data-i18n="other.rule">${zh("other.rule")}</span> <span class="mono">${o}/bili/</span></p>
<p class="small dim" style="margin:0 0 8px"><span data-i18n="dt.example">${zh("dt.example")}</span> <span class="mono">https://api.openai.com/v1 → ${o}/bili/https://api.openai.com/v1</span></p>
<div class="copy-row"><pre class="codebox">${o}/bili/</pre><button class="btn sm copy-btn" data-copy="${o}/bili/"><span data-i18n="common.copy">${zh("common.copy")}</span></button></div>
</div></div>
</div>
<div class="section-label" data-i18n="con.method_b">${zh("con.method_b")}</div>
<p class="small dim" data-i18n="con.method_b_hint">${zh("con.method_b_hint")}</p>
<div class="card"><div class="card-h"><span data-i18n="zcode.title">${zh("zcode.title")}</span><span class="hint" data-i18n="zcode.method">${zh("zcode.method")}</span></div><div class="card-b">
<dl class="kv">
<div class="k" data-i18n="dt.setting">${zh("dt.setting")}</div><div class="v mono">Settings → Network → HTTP Proxy</div>
<div class="k" data-i18n="dt.ca_cert">${zh("dt.ca_cert")}</div><div class="v mono">${caPathEsc}${caReady ? "" : `<span class="dim" data-i18n="ca.not_ready">${zh("ca.not_ready")}</span>`}</div>
</dl>
<div class="copy-row" style="margin-top:10px"><pre class="codebox">${o}</pre><button class="btn sm copy-btn" data-copy="${o}"><span data-i18n="common.copy">${zh("common.copy")}</span></button></div>
<div class="copy-row" style="margin-top:8px"><pre class="codebox">${caPathEsc}</pre><button class="btn sm copy-btn" data-copy="${caPath}"><span data-i18n="copy.ca">${zh("copy.ca")}</span></button></div>
<p class="small dim" style="margin-top:10px"><span data-i18n="zcode.hint_a">${zh("zcode.hint_a")}</span> <span class="mono">~</span> <span data-i18n="zcode.hint_b">${zh("zcode.hint_b")}</span> <span class="mono">~/...</span> <span data-i18n="zcode.hint_c">${zh("zcode.hint_c")}</span></p>
</div></div>
</section>
</main>
<div id="toast-host" class="toast-host"></div>
<script>${WEB_CLIENT}</script>
</body></html>`;
}
