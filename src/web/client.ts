import { MESSAGES } from "./i18n.js";

export const WEB_CLIENT = `(function () {
    "use strict";
    const MESSAGES=${JSON.stringify(MESSAGES)};
    let locale = "zh-CN";
    try {
        const saved = localStorage.getItem("bili-language");
        if (saved === "en" || saved === "zh-CN") locale = saved;
        else if (/^en([-_]|$)/i.test(navigator.language || "")) locale = "en";
    } catch (e) {}
    function t(key, vars) {
        let text = MESSAGES[locale][key];
        if (text === undefined) text = MESSAGES["zh-CN"][key];
        if (text === undefined) text = key;
        if (vars) for (const name of Object.keys(vars)) text = text.split("{" + name + "}").join(String(vars[name]));
        return text;
    }
    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (c) => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === \'"\' ? "&quot;" : "&#39;");
    }
    function $(id) { return document.getElementById(id); }
    function toast(message, kind) {
        const host = $("toast-host");
        if (!host) return;
        const el = document.createElement("div");
        el.className = "toast " + (kind === "err" ? "err" : "ok");
        el.textContent = message;
        host.appendChild(el);
        setTimeout(() => el.remove(), 2600);
    }
    function busy(btn, on) {
        if (on) { btn.dataset.label = btn.textContent; btn.classList.add("busy"); btn.disabled = true; }
        else { btn.classList.remove("busy"); btn.disabled = false; if (btn.dataset.label !== undefined) btn.textContent = btn.dataset.label; }
    }
    async function json(url, opts) {
        const res = await fetch(url, opts);
        let body = null;
        try { body = await res.json(); } catch (e) {}
        if (!res.ok) throw new Error(body && body.error ? String(body.error) : "HTTP " + res.status);
        return body;
    }
    function fmtW(n) {
        if (n === null || n === undefined || isNaN(n)) return t("common.none");
        n = Math.round(Number(n));
        const abs = Math.abs(n);
        if (abs >= 1e9) return (n / 1e9).toFixed(1) + "B";
        if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
        if (abs >= 1e4) return Math.round(n / 1e3) + "K";
        if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
        return String(n);
    }
    function fmtB(n) {
        if (n === null || n === undefined || isNaN(n)) return t("common.none");
        n = Number(n);
        const units = ["B", "KB", "MB", "GB", "TB"];
        let i = 0;
        while (Math.abs(n) >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return (i > 0 ? n.toFixed(1) : String(Math.round(n))) + " " + units[i];
    }
    function timeAgo(iso) {
        if (!iso) return t("common.none");
        const then = typeof iso === "number" ? iso : Date.parse(String(iso));
        if (isNaN(then)) return escapeHtml(String(iso));
        const s = Math.max(0, (Date.now() - then) / 1000);
        if (s < 60) return Math.floor(s) + "s";
        if (s < 3600) return Math.floor(s / 60) + "m";
        if (s < 86400) return Math.floor(s / 3600) + "h";
        return Math.floor(s / 86400) + "d";
    }
    function hostOf(u) {
        if (!u) return "";
        try { return new URL(u).host; } catch (e) { return u; }
    }
    function hydrate() {
        document.documentElement.lang = locale;
        document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.getAttribute("data-i18n")); });
        document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph"))); });
        document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.setAttribute("title", t(el.getAttribute("data-i18n-title"))); });
        const tog = $("language-toggle");
        if (tog) tog.textContent = locale === "zh-CN" ? "English" : "中文";
    }

    const PAGES = ["overview", "sessions", "config", "connect"];
    let current = "overview";
    let sessionsCache = [];

    function sessionTitleCell(s) {
        const name = s.title || s.label || s.id.slice(0, 12) + "…";
        return '<span class="row-title">' + escapeHtml(name) + "</span>"
            + ' <span class="badge ' + (s.live ? "live" : "disk") + '">' + (s.live ? t("common.live") : t("common.disk")) + "</span>"
            + (s.restored ? ' <span class="dim small">' + t("common.restored") + "</span>" : "");
    }
    function sessionRow(s, compact) {
        const tr = document.createElement("tr");
        tr.title = s.id;
        if (compact) {
            tr.innerHTML = "<td>" + sessionTitleCell(s) + '</td><td><span class="badge proto">' + escapeHtml(s.protocol || "?") + '</span></td><td class="num">' + fmtW(s.contextTokens) + '</td><td class="num good-num">' + fmtW(s.tokensSaved) + '</td><td class="dim">' + timeAgo(s.lastSeen) + "</td>";
        } else {
            tr.innerHTML = "<td>" + sessionTitleCell(s) + '</td><td><span class="badge proto">' + escapeHtml(s.protocol || "?") + '</span></td><td class="mono dim small">' + escapeHtml(hostOf(s.upstreamOrigin)) + '</td><td class="num">' + fmtW(s.requests) + '</td><td class="num">' + fmtW(s.contextTokens) + '</td><td class="num good-num">' + fmtW(s.tokensSaved) + '</td><td class="num">' + (s.cacheHitPct == null ? t("common.none") : s.cacheHitPct.toFixed(1) + "%") + '</td><td class="num">' + (s.blocks || 0) + '</td><td class="dim">' + timeAgo(s.lastSeen) + "</td>";
        }
        tr.addEventListener("click", () => { location.hash = "#/session/" + encodeURIComponent(s.id); });
        return tr;
    }

    async function loadOverview() {
        try {
            const d = await json("/__bili/overview");
            const o = d.overview || {};
            $("st-sessions").textContent = String(o.sessions || 0);
            $("st-sessions-sub").textContent = (o.live || 0) + " " + t("ov.live_now");
            $("st-reqs").textContent = fmtW(o.requests || 0);
            $("st-saved").textContent = fmtW(o.tokensSaved || 0);
            $("st-hitpct").textContent = o.hitPct == null ? t("common.none") : o.hitPct.toFixed(1) + "%";
            $("st-input").textContent = fmtW(o.inputTokens || 0);
            $("st-cached").textContent = fmtW(o.cachedTokens || 0);
            $("st-output").textContent = fmtW(o.outputTokens || 0);
            const pb = $("protocol-body");
            pb.innerHTML = "";
            const rows = (o.byProtocol || []).slice().sort((a, b) => b.sessions - a.sessions || b.requests - a.requests);
            if (!rows.length) pb.innerHTML = '<tr><td colspan="5" class="dim">' + t("common.empty") + "</td></tr>";
            rows.forEach((r) => {
                const tr = document.createElement("tr");
                tr.innerHTML = '<td class="mono">' + escapeHtml(r.protocol || "?") + '</td><td class="num">' + r.sessions + '</td><td class="num">' + fmtW(r.requests) + '</td><td class="num">' + fmtW(r.inputTokens) + '</td><td class="num">' + fmtW(r.cachedTokens) + "</td>";
                pb.appendChild(tr);
            });
            $("sys-version").textContent = d.version || "?";
            $("sys-disk-version").textContent = d.diskVersion || t("common.none");
            $("sys-inflight").textContent = String(d.inFlight || 0);
            const bt = d.blindTunnels || {};
            $("sys-blind").textContent = String(bt.total != null ? bt.total : 0);
            const rb = $("recent-body");
            rb.innerHTML = "";
            const recent = (o.recent || []).slice(0, 8);
            if (!recent.length) rb.innerHTML = '<tr><td colspan="5" class="dim">' + t("common.empty") + "</td></tr>";
            recent.forEach((s) => rb.appendChild(sessionRow(s, true)));
            renderBanners(d);
        } catch (e) {
            toast(t("toast.failed", { msg: e.message }), "err");
        }
    }
    function renderBanners(d) {
        const stale = $("stale-banner");
        if (d.stale) {
            stale.hidden = false;
            stale.classList.add("show");
            stale.innerHTML = "<strong>" + t("sys.stale", { disk: d.diskVersion || "?", running: d.version || "?" }) + "</strong> " + (d.autoRestartOnUpdate ? t("sys.stale_auto") : t("sys.stale_manual"));
        } else {
            stale.hidden = true;
            stale.classList.remove("show");
            stale.innerHTML = "";
        }
        const pt = $("passthrough-banner");
        if (d.passthrough && d.passthrough.enabled) {
            pt.hidden = false;
            pt.classList.add("show");
            pt.textContent = t("sys.pt_on") + (d.passthrough.source === "env" ? t("sys.pt_env") : t("sys.pt_file"));
        } else {
            pt.hidden = true;
            pt.classList.remove("show");
            pt.textContent = "";
        }
        const cb = $("conflicts-banner");
        if (cb) {
            const c = d.conflicts;
            if (c && c.events > 0) {
                cb.hidden = false;
                cb.classList.add("show");
                const kinds = Object.entries(c.kinds || {}).map((kv) => kv[0] + "×" + kv[1]).join(", ");
                cb.innerHTML = '<strong>' + t("conflict.on") + "</strong> " + t("conflict.desc") + '<span class="mono"> (' + c.events + " event(s) in " + c.sessions + " session(s): " + kinds + ")</span>";
            } else {
                cb.hidden = true;
                cb.classList.remove("show");
                cb.innerHTML = "";
            }
        }
    }

    async function loadSessions(detailId) {
        const listEl = $("sessions-list-view");
        const detEl = $("session-detail-view");
        if (detailId) {
            listEl.hidden = true;
            detEl.hidden = false;
            await loadDetail(detailId);
            return;
        }
        detEl.hidden = true;
        listEl.hidden = false;
        await refreshSessions(true);
    }
    async function refreshSessions(showToast) {
        try {
            const d = await json("/__bili/sessions");
            sessionsCache = d.sessions || [];
            renderSessionTable();
        } catch (e) {
            if (showToast) toast(t("toast.failed", { msg: e.message }), "err");
        }
    }
    function renderSessionTable() {
        const input = $("ses-search");
        const q = ((input && input.value) || "").toLowerCase();
        const rows = sessionsCache.filter((s) => !q
            || (s.title || "").toLowerCase().indexOf(q) >= 0
            || (s.label || "").toLowerCase().indexOf(q) >= 0
            || s.id.toLowerCase().indexOf(q) >= 0);
        $("ses-count").textContent = t("ses.count", { count: rows.length });
        const tb = $("sessions-body");
        tb.innerHTML = "";
        if (!rows.length) {
            tb.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="big">🗂</div>' + t("ses.empty") + "<br>" + t("ses.empty_hint") + "</div></td></tr>";
            return;
        }
        rows.forEach((s) => tb.appendChild(sessionRow(s, false)));
    }

    function mini(parts, label, value, good) {
        parts.push('<div class="stat' + (good ? " good" : "") + '"><div class="k">' + label + '</div><div class="v' + (value == null ? " faint" : "") + '">' + (value == null ? t("common.none") : value) + "</div></div>");
    }
    function kv(parts, label, value, mono) {
        parts.push('<div class="k">' + label + '</div><div class="v' + (mono ? " mono" : "") + '">' + (value == null || value === "" ? t("common.none") : escapeHtml(String(value))) + "</div>");
    }
    function trajectorySvg(lines, folds, win) {
        const W = 960, H = 260, PL = 56, PR = 16, PT = 14, PB = 26;
        const iw = W - PL - PR, ih = H - PT - PB;
        let maxY = 0;
        lines.forEach((l) => { if ((l.input || 0) > maxY) maxY = l.input; });
        if (win && win > maxY) maxY = win * 1.05;
        if (maxY <= 0) maxY = 1;
        const x = (i) => PL + (lines.length === 1 ? iw / 2 : (i / (lines.length - 1)) * iw);
        const y = (v) => PT + ih - (Math.max(0, v) / maxY) * ih;
        let grid = "", ticks = "";
        for (let g = 0; g <= 4; g++) {
            const v = (maxY / 4) * g;
            const yy = y(v);
            grid += '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="var(--border)" stroke-width="1"/>';
            ticks += '<text x="' + (PL - 6) + '" y="' + (yy + 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--text-muted)">' + fmtW(v) + "</text>";
        }
        let area = "M" + x(0).toFixed(1) + "," + y(lines[0].input || 0).toFixed(1);
        let stroke = "";
        lines.forEach((l, i) => {
            area += " L" + x(i).toFixed(1) + "," + y(l.cached || 0).toFixed(1);
            stroke += (i === 0 ? "M" : "L") + x(i).toFixed(1) + "," + y(l.input || 0).toFixed(1) + " ";
        });
        area += " L" + x(lines.length - 1).toFixed(1) + "," + (PT + ih).toFixed(1) + " L" + x(0).toFixed(1) + "," + (PT + ih).toFixed(1) + " Z";
        let foldMarks = "";
        (folds || []).forEach((f) => {
            let idx = -1;
            for (let i = 0; i < lines.length; i++) { if ((lines[i].at || 0) >= (f.at || 0)) { idx = i; break; } }
            if (idx < 0) idx = lines.length - 1;
            foldMarks += '<line x1="' + x(idx).toFixed(1) + '" y1="' + PT + '" x2="' + x(idx).toFixed(1) + '" y2="' + (PT + ih) + '" stroke="#cf222e" stroke-width="1.2" stroke-dasharray="3 3"/>';
        });
        let ceiling = "";
        if (win && win > 0) {
            const yy = y(win);
            ceiling = '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="#cf222e" stroke-width="1.5" stroke-dasharray="6 4"/>'
                + '<text x="' + (W - PR) + '" y="' + Math.max(10, yy - 4).toFixed(1) + '" text-anchor="end" font-size="10" fill="#cf222e">' + t("det.legend_window") + " " + fmtW(win) + "</text>";
        }
        const xt = [0, Math.floor((lines.length - 1) / 2), lines.length - 1]
            .map((i) => '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="var(--text-muted)">' + lines[i].seq + "</text>").join("");
        return '<svg viewBox="0 0 ' + W + " " + H + '" class="chart-svg" role="img">' + grid
            + '<path d="' + area + '" fill="var(--accent)" opacity="0.18"/>'
            + '<path d="' + stroke.trim() + '" fill="none" stroke="var(--accent)" stroke-width="1.8"/>'
            + foldMarks + ceiling + ticks + xt + "</svg>";
    }
    function legendItem(style, label, dashed) {
        if (dashed) return '<span><span class="dot" style="background:none;border-top:2px dashed #cf222e;height:0;border-radius:0;width:14px"></span>' + label + "</span>";
        return '<span><span class="dot" style="' + style + '"></span>' + label + "</span>";
    }
    function detailBadges(d) {
        let html = '<span class="badge ' + (d.live ? "live" : "disk") + '">' + (d.live ? t("common.live") : t("common.disk")) + "</span>";
        if (d.protocol) html += ' <span class="badge proto">' + escapeHtml(d.protocol) + "</span>";
        if (d.restored) html += ' <span class="dim small">' + t("common.restored") + "</span>";
        return html;
    }
    function buildDetailHtml(d) {
        const parts = [];
        parts.push('<a class="btn sm" href="#/sessions">' + t("common.back") + "</a>");
        parts.push('<div class="page-head"><div><h1>' + escapeHtml(d.title || d.label || d.id.slice(0, 16)) + '</h1><div class="sub mono">' + escapeHtml(d.id) + "</div></div><div>" + detailBadges(d) + "</div></div>");
        parts.push('<div class="card"><div class="card-h"><span>' + t("det.identity") + '</span></div><div class="card-b"><dl class="kv">');
        kv(parts, t("common.title"), d.title || null);
        kv(parts, t("common.label"), d.label || null);
        kv(parts, t("common.protocol"), d.protocol || null, true);
        kv(parts, t("common.upstream"), hostOf(d.upstreamOrigin) || null, true);
        kv(parts, t("det.active_pack"), d.activePack || null, true);
        parts.push("</dl></div></div>");
        parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.usage") + '</span></div><div class="card-b">');
        parts.push('<div class="grid cols-4">');
        mini(parts, t("common.requests"), fmtW(d.requests || 0));
        mini(parts, t("ov.input_tokens"), fmtW(d.inputTokens || 0));
        mini(parts, t("ov.cached_tokens"), fmtW(d.cachedTokens || 0));
        mini(parts, t("ov.output_tokens"), fmtW(d.outputTokens || 0));
        mini(parts, t("ov.tokens_saved"), fmtW(d.tokensSaved || 0), true);
        mini(parts, t("det.last_input"), (d.lastInputTokens || 0) > 0 ? fmtW(d.lastInputTokens) : null);
        parts.push("</div>");
        if (d.contextWindow && d.contextWindow > 0) {
            const pct = Math.min(100, Math.round((d.contextTokens / d.contextWindow) * 100));
            const cls = pct >= 90 ? "bar-fill danger" : pct >= 70 ? "bar-fill warn" : "bar-fill";
            parts.push('<div class="bar-row"><span class="dim small">' + t("common.context") + " / " + t("common.window") + '</span><div class="bar-track"><div class="' + cls + '" style="width:' + pct + '%"></div></div><span class="mono small">' + fmtW(d.contextTokens) + " / " + fmtW(d.contextWindow) + " (" + pct + "%)</span></div>");
        } else {
            parts.push('<div class="dim small" style="margin-top:10px">' + t("common.context") + ": " + fmtW(d.contextTokens || 0) + "</div>");
        }
        if ((d.retrieveCalls || 0) > 0) parts.push('<div class="dim small" style="margin-top:10px">' + t("det.ccr") + ' · <span class="mono">' + t("det.ccr_detail", { calls: d.retrieveCalls, hits: d.retrieveHits || 0, misses: d.retrieveMisses || 0 }) + "</span></div>");
        if ((d.storedBytes || 0) > 0) parts.push('<div class="dim small" style="margin-top:4px">' + t("det.store") + ' · <span class="mono">' + fmtB(d.storedBytes) + ((d.storeBytesSaved || 0) > 0 ? " / " + fmtB(d.storeBytesSaved) + " " + t("common.saved") : "") + "</span></div>");
        parts.push("</div></div>");
        const ledger = d.ledger || {};
        const lines = ledger.lines || [];
        parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.trajectory") + '</span><span class="hint">' + t("det.trajectory_sub") + '</span></div><div class="card-b">');
        if (!lines.length) {
            parts.push('<div class="chart-empty">' + t("det.trajectory_empty") + "</div>");
        } else {
            parts.push('<div class="chart-wrap">' + trajectorySvg(lines, ledger.folds || [], d.contextWindow) + "</div>");
            parts.push('<div class="chart-legend">');
            parts.push(legendItem("background:var(--accent)", t("det.legend_input")));
            parts.push(legendItem("background:var(--accent);opacity:.4", t("det.legend_cached"), false));
            parts.push(legendItem("#cf222e", t("det.legend_fold"), true));
            parts.push(legendItem("#cf222e", t("det.legend_window"), true));
            parts.push("</div>");
            if ((ledger.linesOmitted || 0) > 0) parts.push('<div class="dim small" style="margin-top:6px">' + t("det.omitted", { n: ledger.linesOmitted }) + "</div>");
        }
        parts.push("</div></div>");
        const tot = ledger.totals;
        parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.cache_econ") + "</span>" + (tot ? (tot.balanced ? ' <span class="badge ok">' + t("det.ce_balanced") + "</span>" : ' <span class="badge warn">' + t("det.ce_unbalanced") + "</span>") : "") + '</div><div class="card-b">');
        if (tot) {
            parts.push('<div class="grid cols-4">');
            mini(parts, t("det.ce_new"), fmtW(tot.newContent || 0));
            mini(parts, t("det.ce_comp"), fmtW(tot.compRepay || 0));
            mini(parts, t("det.ce_ttl"), fmtW(tot.ttlRepay || 0));
            mini(parts, t("det.ce_residual"), fmtW(tot.residual || 0));
            parts.push("</div>");
        }
        const folds = ledger.folds || [];
        parts.push('<div class="section-label" style="margin-top:14px">' + t("det.folds") + "</div>");
        if (!folds.length) parts.push('<div class="dim small">' + t("det.folds_empty") + "</div>");
        else {
            parts.push('<table class="data"><thead><tr><th>#</th><th>' + t("det.fold_s") + '</th><th>' + t("det.fold_sigma") + '</th><th>' + t("det.fold_h") + '</th><th>' + t("det.fold_t") + "</th></tr></thead><tbody>");
            folds.forEach((f, i) => {
                parts.push('<tr><td class="num">' + (f.seq != null ? f.seq : i + 1) + '</td><td class="num">' + fmtW(f.S) + '</td><td class="num">' + fmtW(f.sigma) + '</td><td class="num">' + (f.hPct == null ? t("common.none") : f.hPct.toFixed(1) + "%") + '</td><td class="num">' + fmtW(f.T) + "</td></tr>");
            });
            parts.push("</tbody></table>");
        }
        parts.push("</div></div>");
        const blocks = d.blockDetails || [];
        parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.blocks_title") + '</span><span class="hint">' + t("det.blocks_count", { n: blocks.length }) + '</span></div><div class="card-b blocks-list">');
        if (!blocks.length) parts.push('<div class="dim small" style="padding:8px 0">' + t("det.blocks_empty") + "</div>");
        blocks.forEach((b) => {
            parts.push('<details class="block-item"><summary><span class="bid">' + escapeHtml(b.blockId) + '</span><span class="topic">' + escapeHtml(b.topic || b.blockId) + '</span><span class="meta">T' + String(b.tier) + " · " + fmtW(b.compressedTokens) + " · " + timeAgo(b.createdAt) + '</span></summary><div class="body">' + escapeHtml(b.summary) + "</div></details>");
        });
        parts.push("</div></div>");
        parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.handoff") + '</span><span class="hint">' + t("det.handoff_hint") + '</span></div><div class="card-b">');
        if (d.handoffTruncated) parts.push('<div class="banner warn show" style="margin:0 0 10px">' + t("det.handoff_truncated") + "</div>");
        if (d.handoffHtml) parts.push('<div class="handoff">' + d.handoffHtml + "</div>");
        else parts.push('<div class="dim small">' + t("common.empty") + "</div>");
        parts.push("</div></div>");
        return parts.join("");
    }
    async function loadDetail(id) {
        const host = $("session-detail-view");
        host.innerHTML = '<div class="empty"><span class="spin"></span> ' + t("common.loading") + "</div>";
        let d = null;
        try {
            d = await json("/__bili/sessions/" + encodeURIComponent(id) + "/detail");
        } catch (e) {}
        if (!d) {
            host.innerHTML = '<a class="btn sm" href="#/sessions">' + t("common.back") + "</a>"
                + '<div class="card" style="margin-top:12px"><div class="card-b"><div class="empty"><div class="big">🔍</div>' + t("det.not_found") + "<br>" + t("det.not_found_hint") + "</div></div></div>";
            return;
        }
        host.innerHTML = buildDetailHtml(d);
    }

    async function loadConfig() {
        try {
            const cfg = await json("/__bili/config");
            $("cfg-file").textContent = cfg.path || t("common.empty");
            const fileBtn = $("copy-cfg-file");
            if (fileBtn && cfg.path) fileBtn.setAttribute("data-copy", cfg.path);
            const errBox = $("cfg-parse-error");
            if (cfg.parseError) {
                errBox.hidden = false;
                errBox.classList.add("show");
                errBox.textContent = t("cfg.parse_error");
            } else {
                errBox.hidden = true;
                errBox.classList.remove("show");
                errBox.textContent = "";
            }
            const pb = $("providers-body");
            pb.innerHTML = "";
            const providers = cfg.providers && typeof cfg.providers === "object" ? cfg.providers : {};
            const keys = Object.keys(providers);
            if (!keys.length) pb.innerHTML = '<div class="dim small">' + t("cfg.providers_empty") + "</div>";
            keys.forEach((k) => {
                const r = providers[k] || {};
                let html = '<div class="route-block"><div class="route-key">' + escapeHtml(k) + "</div>";
                if (r.compressProtocol === "marker") html += ' <span class="badge proto">' + t("cfg.route_marker") + "</span>";
                html += '<dl class="kv">';
                html += '<div class="k">' + t("cfg.route_models") + "</div>";
                const models = r.models && typeof r.models === "object" ? r.models : null;
                if (models && Object.keys(models).length) {
                    html += '<table class="mini"><tr><th>model</th><th class="num">context</th><th class="num">output</th></tr>';
                    Object.keys(models).forEach((mn) => {
                        const me = models[mn] || {};
                        html += '<tr><td class="mono">' + escapeHtml(mn) + '</td><td class="num">' + (me.context ? fmtW(me.context) : t("common.none")) + '</td><td class="num">' + (me.output ? fmtW(me.output) : t("common.none")) + "</td></tr>";
                    });
                    html += "</table>";
                } else {
                    html += '<div class="v dim small">' + t("cfg.route_no_models") + "</div>";
                }
                html += '<div class="k">' + t("cfg.route_proxy") + '</div><div class="v mono">' + (r.proxy ? escapeHtml(r.proxy) : t("cfg.route_direct")) + "</div>";
                if (r.compress) html += '<div class="k">' + t("cfg.route_compress") + '</div><pre class="codebox small-pre">' + escapeHtml(JSON.stringify(r.compress, null, 2)) + "</pre>";
                html += "</dl></div>";
                pb.insertAdjacentHTML("beforeend", html);
            });
            $("compress-json").textContent = cfg.compress && Object.keys(cfg.compress).length ? JSON.stringify(cfg.compress, null, 2) : t("cfg.compress_empty");
            const ptState = $("pt-state");
            if (cfg.passthrough && cfg.passthrough.enabled) {
                ptState.className = "badge ok";
                ptState.textContent = t("cfg.pt_on");
            } else {
                ptState.className = "badge disk";
                ptState.textContent = t("cfg.pt_off");
            }
            loadUpstream(cfg);
        } catch (e) {
            toast(t("toast.failed", { msg: e.message }), "err");
        }
    }
    async function loadUpstream(cfg) {
        let up = null;
        try { up = await json("/__bili/upstream"); } catch (e) {}
        const mode = (up && up.mode) || cfg.upstreamProxyMode || "auto";
        $("up-mode").textContent = mode === "manual" ? t("cfg.up_manual") : mode === "direct" ? t("cfg.up_direct") : t("cfg.up_auto");
        $("up-proxy").textContent = (up && up.proxy) || cfg.upstreamProxy || t("common.none");
        const st = $("up-state");
        if (up && up.connected === true) { st.className = "badge ok"; st.textContent = "ok · " + (up.checkedAt ? timeAgo(up.checkedAt) : ""); }
        else if (up && up.connected === false) { st.className = "badge warn"; st.textContent = up.error ? String(up.error) : "error"; }
        else { st.className = "badge disk"; st.textContent = t("cfg.untested"); }
    }

    function route() {
        const hash = location.hash || "#/overview";
        let name = "overview";
        let detailId = null;
        const top = hash.match(new RegExp("^#/(overview|config|connect)$"));
        if (top) {
            name = top[1];
        } else {
            const ses = hash.match(new RegExp("^#/sessions(?:/(.+))?$")) || hash.match(new RegExp("^#/session/(.+)$"));
            if (ses) {
                name = "sessions";
                if (ses[1]) detailId = decodeURIComponent(ses[1]);
            }
        }
        PAGES.forEach((p) => {
            const sec = $("page-" + p);
            if (sec) sec.hidden = p !== name;
        });
        document.querySelectorAll(".nav a[data-nav]").forEach((a) => a.classList.toggle("active", a.getAttribute("data-nav") === name));
        current = name;
        if (name === "overview") loadOverview();
        else if (name === "sessions") loadSessions(detailId);
        else if (name === "config") loadConfig();
    }
    window.addEventListener("hashchange", route);

    function initStaticHandlers() {
        const tog = $("language-toggle");
        if (tog) tog.addEventListener("click", () => {
            locale = locale === "zh-CN" ? "en" : "zh-CN";
            try { localStorage.setItem("bili-language", locale); } catch (e) {}
            location.reload();
        });
        const search = $("ses-search");
        if (search) search.addEventListener("input", renderSessionTable);
        const testBtn = $("test-upstream");
        if (testBtn) testBtn.addEventListener("click", async () => {
            busy(testBtn, true);
            try {
                const r = await json("/__bili/upstream/test", { method: "POST" });
                toast(t("toast.connect_ok", { status: r.status }), "ok");
                const st = $("up-state");
                st.className = "badge ok";
                st.textContent = "HTTP " + r.status;
            } catch (e) {
                toast(t("toast.failed", { msg: e.message }), "err");
                const st = $("up-state");
                st.className = "badge warn";
                st.textContent = e.message;
            } finally {
                busy(testBtn, false);
            }
        });
        document.addEventListener("click", (ev) => {
            const target = ev.target;
            if (!target || !target.closest) return;
            const btn = target.closest(".copy-btn");
            if (!btn) return;
            let text = btn.getAttribute("data-copy") || "";
            if (!text) {
                const row = btn.parentElement;
                const box = row && row.querySelector ? row.querySelector(".codebox") : null;
                if (box) text = box.textContent || "";
            }
            if (!text) return;
            const span = btn.querySelector("span");
            const orig = span ? span.textContent : "";
            const done = () => {
                if (span) { span.textContent = t("common.copied"); setTimeout(() => { span.textContent = orig || t("common.copy"); }, 1200); }
            };
            const fallback = () => {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand("copy"); done(); } catch (e) {}
                ta.remove();
            };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
            else fallback();
        });
    }

    hydrate();
    initStaticHandlers();
    route();
    setInterval(() => {
        if (document.hidden) return;
        if (current === "overview") loadOverview();
        else if (current === "sessions" && $("session-detail-view").hidden) refreshSessions(false);
    }, 5000);
})();`;
