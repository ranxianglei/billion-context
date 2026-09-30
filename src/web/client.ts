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
        if (on) { btn.dataset.label = btn.innerHTML; btn.classList.add("busy"); btn.disabled = true; }
        else { btn.classList.remove("busy"); btn.disabled = false; if (btn.dataset.label !== undefined) btn.innerHTML = btn.dataset.label; }
    }
    async function json(url, opts) {
        const res = await fetch(url, opts);
        let body = null;
        try { body = await res.json(); } catch (e) {}
        if (!res.ok) throw new Error(body && body.error ? String(body.error) : "HTTP " + res.status);
        return body;
    }
    async function putCfg(btn, payload) {
        busy(btn, true);
        try {
            await json("/__bili/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
            toast(t("cfg.saved"), "ok");
            loadConfig();
        } catch (e) {
            toast(e.message, "err");
        } finally {
            busy(btn, false);
        }
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
    function fmtDT(ms) {
        const d = new Date(ms || 0);
        const p = (v) => String(v).padStart(2, "0");
        return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    function hostOf(u) {
        if (!u) return "";
        try { return new URL(u).host; } catch (e) { return u; }
    }
    // #1426: sessions recorded before wire-path tagging have protocol "unknown" — show them as
    // "unmarked (legacy)" instead of a bare question mark.
    function protoBadge(p) {
        if (!p || p === "unknown") return '<span class="dim small">' + escapeHtml(t("protocol.unmarked")) + "</span>";
        return '<span class="badge proto">' + escapeHtml(p) + "</span>";
    }
    function hydrate() {
        document.documentElement.lang = locale;
        document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.getAttribute("data-i18n")); });
        document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph"))); });
        document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.setAttribute("title", t(el.getAttribute("data-i18n-title"))); });
        const tog = $("language-toggle");
        if (tog) tog.textContent = locale === "zh-CN" ? "English" : "中文";
    }

    const PAGES = ["overview", "sessions", "config", "connect", "logs"];
    let current = "overview";
    let sessionsCache = [];
    // #1682: last overview alert payload — lets a dismiss re-render without refetching.
    let latestAlerts = [];

    function sessionTitleCell(s) {
        // #1426: title falls back to an "untitled" placeholder and the FULL session id is always
        // shown underneath so rows stay identifiable. Disk-restored pool entries read as history,
        // not live.
        const named = Boolean(s.title || s.label || s.firstBlockHint);
        const name = s.title || s.label || s.firstBlockHint || t("ses.no_title");
        const live = s.live && !s.restored;
        // Only actively running sessions get a status tag; disk/restored rows carry none.
        // The whole cell is a real hash anchor: plain clicks route inside the SPA exactly as
        // before (the row handler bails on <a>), while Ctrl/Cmd+click or middle-click opens
        // the session in a new tab for free (#1426 user ask).
        const href = "#/session/" + encodeURIComponent(s.id);
        return '<a class="slink" href="' + href + '"><span class="row-title clip w-title' + (named ? "" : " faint") + '">' + escapeHtml(name) + "</span>"
            + (live ? ' <span class="badge live" title="' + escapeHtml(t("ses.badge_live_tip")) + '">' + t("common.live") + "</span>" : "")
            + '<span class="row-id">' + escapeHtml(s.id) + "</span></a>";
    }
    // SAVED column prefers ledger-derived net savings; pre-tagging sessions fall back
    // to the local tokensSaved estimate; neither present => honest dash, never fake 0.
    function savedTd(x) {
        const v = x.netSaved != null ? x.netSaved : (x.tokensSaved || 0);
        if (v > 0) return '<td class="num good-num">' + fmtW(v) + "</td>";
        if (v) return '<td class="num" title="' + escapeHtml(t("ov.saved_neg_tip")) + '">' + fmtW(v) + "</td>";
        return '<td class="num dim">' + t("common.none") + "</td>";
    }
    // Compact single-line hit cell: (97.0%/−1.3%/−0.9%/−1.1%) = hit/new/compress/TTL.
    function hitTd(s) {
        if (s.cacheHitPct == null) return '<td class="num dim">' + t("common.none") + "</td>";
        const main = s.cacheHitPct.toFixed(1) + "%";
        if (s.missDropNew == null && s.missDropComp == null && s.missDropTtl == null) return '<td class="num">' + main + "</td>";
        const parts = [main];
        ["missDropNew", "missDropComp", "missDropTtl"].forEach((k) => {
            const v = s[k];
            parts.push(v == null ? "−" : (v === 0 ? "0%" : "−" + v + "%"));
        });
        return '<td class="num"><span class="hitc" title="' + escapeHtml(t("ses.drop_ph")) + '">(' + parts.join("/") + ")</span></td>";
    }
    // MODEL SWITCHES column (#1535): mid-session model changes re-bill the stable prefix;
    // shows count · dropped tokens, honest dash when none.
    function switchTd(s) {
        if (!s.modelSwitches) return '<td class="num dim">' + t("common.none") + "</td>";
        const tip = escapeHtml(t("ses.th_switches_tip"));
        if (!s.switchMissedTokens) return '<td class="num" title="' + tip + '">' + s.modelSwitches + "</td>";
        return '<td class="num" title="' + tip + '">' + s.modelSwitches + " · " + fmtW(s.switchMissedTokens) + "</td>";
    }

    function sessionRow(s, compact) {
        const tr = document.createElement("tr");
        tr.title = s.id;
        if (compact) {
            tr.innerHTML = "<td>" + sessionTitleCell(s) + '</td><td>' + protoBadge(s.protocol) + '</span></td><td class="num">' + fmtW(s.contextTokens) + '</td>' + savedTd(s) + '<td class="dim">' + timeAgo(s.lastSeen) + "</td>";
        } else {
            tr.innerHTML = "<td>" + sessionTitleCell(s) + '</td><td>' + (s.clientHint ? '<span class="mono small">' + escapeHtml(s.clientHint) + "</span>" : '<span class="dim">' + t("common.none") + "</span>") + '</td><td>' + protoBadge(s.protocol) + '</td><td><span class="mono dim small clip w-up">' + escapeHtml(hostOf(s.upstreamOrigin)) + '</td><td class="num">' + (s.requests ? s.requests : t("common.none")) + '</td><td class="num">' + fmtW(s.contextTokens) + '</td><td class="num">' + (s.inputTokens ? fmtW(s.inputTokens) : '<span class="dim">' + t("common.none") + "</span>") + "</td>" + savedTd(s) + hitTd(s) + switchTd(s) + '<td class="num">' + (s.foldCount || 0) + '</td><td class="num">' + (s.blocks || 0) + '</td><td class="dim">' + timeAgo(s.lastSeen) + "</td>";
        }
        let navTimer = null;
        tr.addEventListener("click", (ev) => {
            if (ev.target.closest && ev.target.closest("button,a,input,textarea,.copy-btn,.qmark")) return;
            if (window.getSelection && String(window.getSelection()).length > 0) return;
            clearTimeout(navTimer);
            navTimer = setTimeout(() => {
                if (!window.getSelection || String(window.getSelection()).length === 0) location.hash = "#/session/" + encodeURIComponent(s.id);
            }, 250);
        });
        tr.addEventListener("dblclick", () => clearTimeout(navTimer));
        return tr;
    }

    async function loadOverview(silent) {
        try {
            const d = await json("/__bili/overview");
            const o = d.overview || {};
            // #1426: total splits live vs historical (disk-restored pool entries are history);
            // counters without usage samples render "—" instead of a misleading 0; the saved
            // counter labels how much comes from pre-tagging local estimates (no cache ledger).
            const total = o.sessions || 0;
            const liveN = o.live || 0;
            $("st-sessions").textContent = String(total);
            $("st-sessions-sub").textContent = liveN + " " + t("ov.live_now") + " · " + Math.max(0, total - liveN) + " " + t("ov.hist");
            $("st-reqs").textContent = o.requests ? fmtW(o.requests) : t("common.none");
            $("st-gross").textContent = o.grossSavedTotal ? fmtW(o.grossSavedTotal) : t("common.none");
            $("st-gross-sub").textContent = t("ov.gross_note") + ((o.savedEstimated || 0) > 0 ? " · " + t("ov.saved_from_legacy", { n: fmtW(o.savedEstimated) }) : "");
            $("st-netsaved").textContent = o.hasFoldData ? ((o.netSavedTotal || 0) < 0 ? "-" : "") + fmtW(Math.abs(o.netSavedTotal || 0)) : t("common.none");
            $("st-net-sub").textContent = o.hasFoldData ? t("ov.sub_repay", { r: fmtW(o.repayTotal || 0), s: fmtW(o.summaryCostTotal || 0) }) + ((o.savedEstimated || 0) > 0 ? " · " + t("ov.net_excl") : "") : "";
            $("st-hitpct").textContent = o.hitPct == null ? t("common.none") : o.hitPct.toFixed(1) + "%";
            const hs = $("st-hit-split");
            if (hs) {
                const missSum = (o.missNewTotal || 0) + (o.missCompTotal || 0) + (o.missTtlTotal || 0);
                const mi = o.missInputTotal || 0;
                const f = (v) => fmtW(v) + (mi > 0 ? " (−" + ((v / mi) * 100).toFixed(1) + "%)" : "");
                hs.textContent = missSum > 0 ? t("ov.miss_split", { n: f(o.missNewTotal || 0), c: f(o.missCompTotal || 0), x: f(o.missTtlTotal || 0) }) : t("common.none");
            }
            $("st-input").textContent = o.inputTokens ? fmtW(o.inputTokens) : t("common.none");
            $("st-cached").textContent = o.cachedTokens ? fmtW(o.cachedTokens) : t("common.none");
            $("st-output").textContent = o.outputTokens ? fmtW(o.outputTokens) : t("common.none");
            const pb = $("protocol-body");
            pb.innerHTML = "";
            const rows = (o.byProtocol || []).slice().sort((a, b) => b.sessions - a.sessions || b.requests - a.requests);
            if (!rows.length) pb.innerHTML = '<tr><td colspan="8" class="dim">' + t("common.empty") + "</td></tr>";
            rows.forEach((r) => {
                const tr = document.createElement("tr");
                tr.innerHTML = '<td>' + protoBadge(r.protocol) + '</td><td class="num">' + r.sessions + '</td><td class="num">' + (r.requests ? fmtW(r.requests) : t("common.none")) + '</td><td class="num">' + (r.inputTokens ? fmtW(r.inputTokens) : t("common.none")) + '</td><td class="num">' + (r.cachedTokens ? fmtW(r.cachedTokens) : t("common.none")) + '</td>' + hitTd({ cacheHitPct: r.hitPct, missDropNew: r.missDropNew, missDropComp: r.missDropComp, missDropTtl: r.missDropTtl }) + '<td class="' + (r.savedNet > 0 ? "num good-num" : "num") + '"' + (r.savedNet < 0 ? ' title="' + escapeHtml(t("ov.saved_neg_tip")) + '"' : "") + '">' + (r.savedNet ? fmtW(r.savedNet) : t("common.none")) + '</td><td class="num">' + (r.folds ? fmtW(r.folds) : t("common.none")) + "</td>";
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
            if (!recent.length) rb.innerHTML = '<tr><td colspan="13" class="dim">' + t("common.empty") + "</td></tr>";
            recent.forEach((s) => rb.appendChild(sessionRow(s, false)));
            renderBanners(d);
        } catch (e) {
            if (!silent) toast(t("toast.failed", { msg: e.message }), "err");
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
        const ab = $("advisory-banner");
        if (ab) {
            const a = d.advisory;
            if (a && a.id) {
                ab.hidden = false;
                ab.classList.add("show");
                ab.innerHTML = '<strong>' + t("advisory.on") + '</strong> <span class="mono">[' + a.id + "]</span> " + t("advisory.desc") + "<span>" + (a.reason || "") + "</span>" + t("advisory.hint") + '<span class="mono">npm install -g billion-context@' + (a.targetFailed ? "latest" : a.target || "latest") + "</span>";
            } else {
                ab.hidden = true;
                ab.classList.remove("show");
                ab.innerHTML = "";
            }
        }
        // #1682: global upstream-connection alert banner — visible on every view,
        // one row per active alert (no stacking), dismiss per alert instance.
        latestAlerts = Array.isArray(d.alerts) ? d.alerts : [];
        renderAlertBanner();
    }
    function readDismissedAlerts() {
        try {
            const v = JSON.parse(localStorage.getItem("bili-alert-dismissed") || "[]");
            return new Set(Array.isArray(v) ? v : []);
        } catch (e) { return new Set(); }
    }
    // Static per-kind references: the #1024 i18n lint requires every catalog
    // key to be referenced literally in this file, with no dead keys.
    function alertHint(kind) {
        switch (kind) {
            case "connect-timeout": return t("alert.hint.connect_timeout");
            case "connect-refused": return t("alert.hint.connect_refused");
            case "proxy-reset": return t("alert.hint.proxy_reset");
            case "upstream-reset": return t("alert.hint.upstream_reset");
            case "dns": return t("alert.hint.dns");
            case "tls": return t("alert.hint.tls");
            default: return t("alert.hint.unknown");
        }
    }
    function alertKey(a) { return a.kind + "|" + a.host + "|" + a.firstSeen; }
    function dismissAlert(key) {
        const s = readDismissedAlerts();
        s.add(key);
        const arr = [...s];
        while (arr.length > 64) arr.shift();
        try { localStorage.setItem("bili-alert-dismissed", JSON.stringify(arr)); } catch (e) {}
    }
    function renderAlertBanner() {
        const el = $("alerts-banner");
        if (!el) return;
        const dismissed = readDismissedAlerts();
        const vis = latestAlerts.filter((a) => a && a.kind && a.host && !dismissed.has(alertKey(a)));
        if (!vis.length) {
            el.hidden = true;
            el.classList.remove("show");
            el.innerHTML = "";
            return;
        }
        el.hidden = false;
        el.classList.add("show");
        el.innerHTML = "";
        const head = document.createElement("div");
        head.className = "banner-title";
        head.textContent = "⚠️ " + t("alert.title");
        el.appendChild(head);
        vis.forEach((a) => {
            const row = document.createElement("div");
            row.className = "alert-row";
            const msg = document.createElement("span");
            msg.textContent = t("alert.item", { host: a.host, kind: a.kind, count: a.count, first: fmtDT(a.firstSeen), hint: alertHint(a.kind) });
            const btn = document.createElement("button");
            btn.className = "btn sm alert-dismiss";
            btn.textContent = t("alert.dismiss");
            btn.addEventListener("click", () => {
                dismissAlert(alertKey(a));
                renderAlertBanner();
            });
            row.appendChild(msg);
            row.appendChild(btn);
            el.appendChild(row);
        });
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
    let hiddenEmptyN = 0;
    async function refreshSessions(showToast) {
        try {
            const d = await json("/__bili/sessions");
            sessionsCache = d.sessions || [];
            hiddenEmptyN = d.hiddenEmpty || 0;
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
        const heEl = $("ses-empty-hint");
        if (heEl) {
            if (hiddenEmptyN > 0) { heEl.hidden = false; heEl.textContent = t("ses.empty_hidden", { n: hiddenEmptyN }); }
            else { heEl.hidden = true; heEl.textContent = ""; }
        }
        const tb = $("sessions-body");
        tb.innerHTML = "";
        if (!rows.length) {
            tb.innerHTML = '<tr><td colspan="13"><div class="empty"><div class="big">🗂</div>' + t("ses.empty") + "<br>" + t("ses.empty_hint") + "</div></td></tr>";
            return;
        }
        rows.forEach((s) => tb.appendChild(sessionRow(s, false)));
    }

    function mini(parts, label, value, good, sub, info) {
        if (info) label = label + '<span class="qmark" data-qtip="' + escapeHtml(info) + '">?</span>';
        parts.push('<div class="stat' + (good ? " good" : "") + '"><div class="k">' + label + '</div><div class="v' + (value == null ? " faint" : "") + '">' + (value == null ? t("common.none") : value) + "</div>" + (sub ? '<div class="s">' + sub + "</div>" : "") + "</div>");
    }
    function kv(parts, label, value, mono) {
        parts.push('<div class="k">' + label + '</div><div class="v' + (mono ? " mono" : "") + '">' + (value == null || value === "" ? t("common.none") : escapeHtml(String(value))) + "</div>");
    }
    function trajectorySvg(lines, folds, win, baseIn, seamEvents) {
        lines = (lines || []).filter((l) => Boolean(l));
        if (!lines.length) return "";
        const W = 960, H = 260, PL = 56, PR = 16, PT = 14, PB = 26;
        const iw = W - PL - PR, ih = H - PT - PB;
        let maxY = 0;
        lines.forEach((l) => { if ((l.input || 0) > maxY) maxY = l.input; });
        if (win && win > maxY) maxY = win * 1.05;
        if (maxY <= 0) maxY = 1;
        const x = (i) => PL + (lines.length === 1 ? iw / 2 : (i / (lines.length - 1)) * iw);
        const y = (v) => PT + ih - (Math.max(0, v) / maxY) * ih;
        const dt = (ms) => fmtDT(ms);
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
        // Cache-gap causes: color each sample's un-cached band (input − cached)
        // by its most likely cause so gaps on the chart explain themselves.
        // Heuristics use only fields every ledger era carries (at/input/cached + fold times).
        const GAP_MS = 600_000;
        const CAUSE_COLOR = { cold: "#6e7681", comp: "#bf8700", ttl: "#8250df" };
        const CAUSE_KEY = { cold: "det.cause_cold", comp: "det.cause_comp", ttl: "det.cause_ttl" };
        const causes = lines.map((l, i) => {
            if (i === 0) return !(l.cached || 0) ? "cold" : "new";
            const p = lines[i - 1];
            const missed = (l.input || 0) - (l.cached || 0);
            const growth = Math.max(0, (l.input || 0) - (p.input || 0));
            if ((folds || []).some((f) => (f.at || 0) >= (p.at || 0) && (f.at || 0) <= (l.at || 0)) && missed > growth + 256) return "comp";
            if ((l.at || 0) - (p.at || 0) > GAP_MS && missed > growth + 2048) return "ttl";
            return "new";
        });
        let bands = "", hovers = "";
        const swSeg = lines.length === 1 ? iw : iw / (lines.length - 1);
        lines.forEach((l, i) => {
            const c = causes[i];
            const yIn = y(l.input || 0), yCa = y(l.cached || 0);
            const x0 = Math.max(PL, x(i) - swSeg / 2), x1 = Math.min(W - PR, x(i) + swSeg / 2);
            if (c !== "new") {
                bands += '<rect x="' + x0.toFixed(1) + '" y="' + yIn.toFixed(1) + '" width="' + Math.max(1, x1 - x0).toFixed(1) + '" height="' + Math.max(3, yCa - yIn).toFixed(1) + '" fill="' + CAUSE_COLOR[c] + '" opacity="0.35" rx="1"/>';
            }
            const hitPctLine = (l.input || 0) > 0 ? ((l.cached || 0) / l.input * 100).toFixed(1) + "%" : t("common.none");
            hovers += '<rect x="' + x0.toFixed(1) + '" y="' + PT + '" width="' + Math.max(1, x1 - x0).toFixed(1) + '" height="' + ih + '" fill="transparent"><title>'
                + (l.seq != null ? "#" + l.seq + " · " : "") + dt(l.at)
                + "\\nin " + fmtW(l.input || 0) + " · cached " + fmtW(l.cached || 0) + " · missed " + fmtW((l.input || 0) - (l.cached || 0)) + " · hit " + hitPctLine
                + (c === "new" ? "" : "\\n" + t(CAUSE_KEY[c])) + "</title></rect>";
        });
        let foldMarks = "";
        // Burst-folds share (near-)identical timestamps and thus the same pixel — merge them
        // into one marker per pixel-bucket so stacked marks don't ghost into doubled lines.
        const foldBuckets = [];
        (folds || []).forEach((f) => {
            let idx = -1;
            for (let i = 0; i < lines.length; i++) { if ((lines[i].at || 0) >= (f.at || 0)) { idx = i; break; } }
            if (idx < 0) idx = lines.length - 1;
            const fx = x(idx);
            const bk = foldBuckets.find((b) => Math.abs(b.fx - fx) <= 1.5);
            if (bk) bk.items.push(f); else foldBuckets.push({ fx, items: [f] });
        });
        foldBuckets.forEach((bk) => {
            const n = bk.items.length;
            const seqs = bk.items.map((m) => m.seq != null ? "#" + m.seq : "").filter(Boolean).slice(0, 5).join("·");
            foldMarks += '<line x1="' + bk.fx.toFixed(1) + '" y1="' + PT + '" x2="' + bk.fx.toFixed(1) + '" y2="' + (PT + ih) + '" stroke="#cf222e" stroke-width="1.2" stroke-dasharray="3 3"><title>'
                + t("det.fold_short") + (n > 1 ? " ×" + n : "") + (seqs ? " " + seqs + (bk.items.length > 5 ? "…" : "") + " · " : " ") + dt(bk.items[0].at) + " · " + fmtW(bk.items.reduce((a, m) => a + (m.S || 0), 0)) + "</title></line>";
        });
        // #1609: cache-seam suspects (#1606) get SOLID red marks at the first sample at/after
        // the divergence time — folds stay dashed, so both read in the same visual language.
        let seamMarks = "";
        (seamEvents || []).forEach((ev) => {
            if (!ev || !(ev.at > 0)) return;
            let idx = -1;
            for (let i = 0; i < lines.length; i++) { if ((lines[i].at || 0) >= ev.at) { idx = i; break; } }
            if (idx < 0) idx = lines.length - 1;
            const fx = x(idx);
            const hit = typeof ev.hitPct === "number" ? ev.hitPct.toFixed(1) : "?";
            const lcp = fmtB(ev.lcpBytes || 0);
            const msg = ev.msgIndex != null ? ev.msgIndex : "?";
            const prev = ev.prevMsgs != null ? ev.prevMsgs : "?";
            const cur = ev.curMsgs != null ? ev.curMsgs : "?";
            seamMarks += '<line x1="' + fx.toFixed(1) + '" y1="' + PT + '" x2="' + fx.toFixed(1) + '" y2="' + (PT + ih) + '" stroke="#cf222e" stroke-width="1.8"><title>'
                + t("det.seam_mark_tip", { seq: ev.seq != null ? ev.seq : "?", at: dt(ev.at), hit, lcp, msg, prev, cur }) + "</title></line>";
        });
        let ceiling = "";
        if (win && win > 0) {
            const yy = y(win);
            ceiling = '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="#cf222e" stroke-width="1.5" stroke-dasharray="6 4"/>'
                + '<text x="' + (W - PR) + '" y="' + Math.max(10, yy - 4).toFixed(1) + '" text-anchor="end" font-size="10" fill="#cf222e">' + t("det.legend_window") + " " + fmtW(win) + "</text>";
        }
        // Baseline: the not-compressible floor every request carries (system prompt + tools).
        // Measured when the kernel persisted systemPromptTokens; otherwise estimated as the
        // 10th percentile of (input − cached) across samples.
        let baseline = "";
        const baseMeasured = Boolean(baseIn && baseIn > 0);
        const baseVal = baseMeasured
            ? baseIn
            : lines.length >= 20
                ? (() => { const ds = lines.map((l) => Math.max(0, (l.input || 0) - (l.cached || 0))).sort((a, b) => a - b); return ds[Math.floor(ds.length * 0.1)] || 0; })()
                : 0;
        if (baseVal >= 200 && baseVal < maxY) {
            const yy = y(baseVal);
            baseline = '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="#8b949e" stroke-width="1" stroke-dasharray="2 4"/>'
                + '<text x="' + PL + '" y="' + Math.max(10, yy - 4).toFixed(1) + '" font-size="9.5" fill="#8b949e">' + t(baseMeasured ? "det.legend_base" : "det.legend_base_est") + " " + fmtW(baseVal) + "</text>";
        }
        const xt = [0, Math.floor((lines.length - 1) / 2), lines.length - 1]
            .map((i) => '<text x="' + x(i).toFixed(1) + '" y="' + (H - 20) + '" text-anchor="middle" font-size="10" fill="var(--text-muted)">' + lines[i].seq + "</text>").join("");
        const xtTime =
            (lines[0] && lines[0].at ? '<text x="' + PL + '" y="' + (H - 8) + '" text-anchor="start" font-size="9.5" fill="var(--text-faint)">' + dt(lines[0].at) + "</text>" : "")
            + (lines.length > 1 && lines[lines.length - 1].at ? '<text x="' + (W - PR) + '" y="' + (H - 8) + '" text-anchor="end" font-size="9.5" fill="var(--text-faint)">' + dt(lines[lines.length - 1].at) + "</text>" : "");
        return '<svg viewBox="0 0 ' + W + " " + H + '" class="chart-svg" role="img">' + grid
            + '<path d="' + area + '" fill="var(--accent)" opacity="0.18"/>'
            + bands
            + hovers
            + '<path d="' + stroke.trim() + '" fill="none" stroke="var(--accent)" stroke-width="1.8"/>'
            + foldMarks + seamMarks + ceiling + baseline + ticks + xt + xtTime + "</svg>";
    }
    function legendItem(style, label, dashed) {
        if (dashed) return '<span><span class="dot" style="background:none;border-top:2px dashed #cf222e;height:0;border-radius:0;width:14px"></span>' + label + "</span>";
        return '<span><span class="dot" style="' + style + '"></span>' + label + "</span>";
    }
    function blockTopic(b) {
        // #1426: untitled blocks fall back to the lead line of their summary
        if (b.topic && String(b.topic).trim()) return String(b.topic).trim();
        const lead = String(b.summary || "").split("\\n").map((s) => s.trim()).find(Boolean) || "";
        return lead.length > 48 ? lead.slice(0, 48) + "…" : lead || b.blockId;
    }
    function detailBadges(d) {
        const live = d.live && !d.restored;
        let html = "";
        if (live) html = '<span class="badge live" title="' + escapeHtml(t("ses.badge_live_tip")) + '">' + t("common.live") + "</span>";
        if (d.protocol) html += (html ? " " : "") + protoBadge(d.protocol);
        return html;
    }
    // #1426: structured handoff rendering — per-role blocks with separated thinking,
    // output text and tool call/result formatting (tool chips + pretty JSON args).
    function toolChipCls(name) {
        if (name === "bash" || name === "shell" || name === "run_command") return "t-shell";
        if (name === "read" || name === "write" || name === "edit" || name === "ls" || name === "glob" || name === "note") return "t-file";
        if (name === "grep" || name === "search_context" || name === "decompress" || name === "acp_retrieve") return "t-seek";
        if (name === "compress" || name === "acp_status" || name === "acp_cache") return "t-fold";
        return "";
    }
    function parseToolLine(line) {
        const BT = String.fromCharCode(96);
        if (line.charAt(0) !== BT) return null;
        const ARGS = ")" + BT + " args: ";
        const RES = ")" + BT + " \u2192 ";
        let mark = -1, kind = "", tailLen = 0;
        if (line.indexOf(ARGS) > -1) { mark = line.indexOf(ARGS); kind = "call"; tailLen = ARGS.length; }
        else if (line.indexOf(RES) > -1) { mark = line.indexOf(RES); kind = "res"; tailLen = RES.length; }
        else return null;
        const nameId = line.slice(1, mark);
        const lp = nameId.indexOf("(");
        if (lp < 0) return null;
        return { kind: kind, name: nameId.slice(0, lp), cid: nameId.slice(lp + 1), text: line.slice(mark + tailLen) };
    }
    function splitHandoffBody(bodyLines) {
        const segs = [];
        for (const raw of bodyLines) {
            if (raw.trim() === "" && !(segs.length && segs[segs.length - 1].type === "out")) continue;
            const tool = parseToolLine(raw);
            if (tool) { segs.push({ type: "tool", kind: tool.kind, name: tool.name, cid: tool.cid, lines: [tool.text] }); continue; }
            if (raw.indexOf("_reasoning_: ") === 0) {
                const lastT = segs[segs.length - 1];
                if (!lastT || lastT.type !== "think") segs.push({ type: "think", lines: [] });
                segs[segs.length - 1].lines.push(raw.slice("_reasoning_: ".length));
                continue;
            }
            const last = segs[segs.length - 1];
            if (last && (last.type === "out" || last.type === "think")) last.lines.push(raw);
            else segs.push({ type: "out", lines: [raw] });
        }
        return segs;
    }
    function renderBlockMd(md) {
        // #1426: render expanded compression-block summaries as markdown.
        // No regex literals with backslashes allowed here (WEB_CLIENT template).
        const lines = md.split("\\n");
        const html = [];
        let para = [], list = null, quote = [], pre = [];
        function inline(s) {
            let out = "", i = 0;
            while (i < s.length) {
                const ch = s[i];
                if (ch === "\`") {
                    const j = s.indexOf("\`", i + 1);
                    if (j > -1) { out += "<code>" + escapeHtml(s.slice(i + 1, j)) + "</code>"; i = j + 1; continue; }
                } else if (ch === "*" && s[i + 1] === "*") {
                    const j = s.indexOf("**", i + 2);
                    if (j > i + 1) { out += "<strong>" + escapeHtml(s.slice(i + 2, j)) + "</strong>"; i = j + 2; continue; }
                }
                out += escapeHtml(ch); i++;
            }
            return out;
        }
        function fP() { if (para.length) { html.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } }
        function fL() { if (list) { html.push("</" + list + ">"); list = null; } }
        function fQ() { if (quote.length) { html.push("<blockquote>" + quote.map(inline).join("<br>") + "</blockquote>"); quote = []; } }
        function fPr() { if (pre.length) { html.push("<pre><code>" + escapeHtml(pre.join("\\n")) + "</code></pre>"); pre = []; } }
        for (const raw0 of lines) {
            let l = raw0;
            while (l && (l[l.length - 1] === " " || l[l.length - 1] === "\\t")) l = l.slice(0, -1);
            let indent = 0;
            while (indent < l.length && (l[indent] === " " || l[indent] === "\\t")) indent++;
            const l2 = l.slice(indent);
            if (!l2) { fP(); fL(); fQ(); continue; }
            if (indent >= 4) { fP(); fL(); fQ(); pre.push(l2); continue; }
            if (l2.length >= 3 && l2.split("").every((c) => c === "-")) { fP(); fL(); fQ(); html.push("<hr>"); continue; }
            if (l2[0] === "#" && l2.indexOf(" ") > -1) {
                let n = 0; while (n < l2.length && l2[n] === "#") n++;
                const lvl = Math.min(n, 4);
                fP(); fL(); fQ();
                html.push("<h" + lvl + ">" + inline(l2.slice(n).trimStart()) + "</h" + lvl + ">");
                continue;
            }
            if (l2[0] === ">" && (l2.length === 1 || l2[1] === " ")) { fP(); fL(); quote.push(l2.slice(1).trimStart()); continue; }
            if (l2[0] === "-" || l2[0] === "*") {
                fP(); fQ();
                if (list !== "ul") { fL(); html.push("<ul>"); list = "ul"; }
                html.push("<li>" + inline(l2.slice(1).trimStart()) + "</li>");
                continue;
            }
            const dot = l2.indexOf(". ");
            if (dot > 0 && dot < 5 && l2.slice(0, dot).split("").every((c) => c >= "0" && c <= "9")) {
                fP(); fQ();
                if (list !== "ol") { fL(); html.push("<ol>"); list = "ol"; }
                html.push("<li>" + inline(l2.slice(dot + 2)) + "</li>");
                continue;
            }
            fL(); fQ(); para.push(l2);
        }
        fP(); fL(); fQ(); fPr();
        return html.join("");
    }
    function renderHandoffMd(md) {
        const lines = md.split("\\n");
        let start = 0;
        for (let i = 0; i < lines.length; i++) if (lines[i].indexOf("## ") === 0 && lines[i].indexOf("Conversation") > -1) { start = i + 1; break; }
        const blocks = [];
        let cur = null;
        for (let i = start; i < lines.length; i++) {
            const l = lines[i];
            if (l.indexOf("### ") === 0) { cur = { role: l.slice(4).trim(), lines: [] }; blocks.push(cur); continue; }
            if (cur) cur.lines.push(l);
        }
        const html = [];
        if (!blocks.length) return '<span class="dim small">' + escapeHtml(String(md).slice(0, 200)) + "</span>";
        for (const b of blocks) {
            const role = b.role === "user" || b.role === "assistant" || b.role === "tool" ? b.role : "assistant";
            html.push('<h3 class="msg-role ' + role + '">' + role + "</h3>");
            const segs = splitHandoffBody(b.lines);
            if (!segs.length) { html.push('<div class="dim small">_(empty)_</div>'); continue; }
            for (const s of segs) {
                if (s.type === "think") {
                    const n = s.lines.filter((x) => x.trim() !== "").length;
                    html.push('<details class="msg-think"><summary>' + t("det.thinking") + " \u00b7 " + n + '</summary><div class="think-box">' + s.lines.map(escapeHtml).join("<br/>") + "</div></details>");
                } else if (s.type === "out") {
                    html.push('<p class="msg-out">' + s.lines.map(escapeHtml).join("<br/>") + "</p>");
                } else {
                    const txt = s.lines.join("\\n");
                    let shown = txt;
                    if (s.kind === "call") { try { shown = JSON.stringify(JSON.parse(txt), null, 2); } catch (e) {} }
                    html.push('<div class="' + (s.kind === "call" ? "msg-tool" : "msg-result") + '"><span class="tool-chip ' + toolChipCls(s.name) + '">' + escapeHtml(s.name) + '</span><span class="tool-cid">' + escapeHtml(s.cid) + "</span>" + (s.kind === "res" ? '<span class="dim"> \u2192 </span>' : "") + '<pre class="' + (s.kind === "call" ? "tool-args" : "tool-out") + '">' + escapeHtml(shown) + "</pre></div>");
                }
            }
        }
        return html.join("");
    }
    function buildDetailHtml(d) {
        const parts = [];
        parts.push('<a class="btn sm" href="#/sessions">' + t("common.back") + "</a>");
        parts.push('<div class="page-head"><div><h1 title="' + escapeHtml(d.title || d.label || d.id) + '">' + escapeHtml(d.title || d.label || d.id.slice(0, 16)) + '</h1><div class="sub mono">' + escapeHtml(d.id) + "</div></div><div>" + detailBadges(d) + "</div></div>");
        parts.push('<div class="card"><div class="card-h"><span>' + t("det.identity") + '</span></div><div class="card-b"><dl class="kv">');
        // Full title wraps in place, is hoverable (title attr) and carries a copy button.
        parts.push('<div class="k">' + t("common.title") + '</div><div class="v" title="' + escapeHtml(d.title || "") + '">' + (d.title ? escapeHtml(d.title) + ' <button id="title-copy" class="btn sm">' + t("common.copy") + "</button>" : '<span class="faint">' + t("common.none") + "</span>") + "</div>");
        if (d.label && d.label !== d.id) kv(parts, t("common.label"), d.label);
        kv(parts, t("common.protocol"), d.protocol || null, true);
        kv(parts, t("det.client_hint"), d.clientHint || null, true);
        kv(parts, t("common.upstream"), hostOf(d.upstreamOrigin) || null, true);
        kv(parts, t("det.version"), d.biliVersion || null, true);
        kv(parts, t("det.active_pack"), d.activePack || null, true);
        parts.push('<div class="k">' + t("det.log") + '</div><div class="v"><a href="#/logs?q=' + encodeURIComponent(d.id) + '">' + t("det.log_view") + "</a></div>");
        parts.push("</dl></div></div>");
        parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.usage") + '</span></div><div class="card-b">');
        parts.push('<div class="grid cols-4">');
        mini(parts, t("common.requests"), d.requests ? fmtW(d.requests) : null);
        mini(parts, t("ov.input_tokens"), d.inputTokens ? fmtW(d.inputTokens) : null);
        mini(parts, t("ov.cached_tokens"), d.cachedTokens ? fmtW(d.cachedTokens) : null);
        const mt = d.ledger && d.ledger.totals;
        const missArgs = mt && mt.input > 0 ? { n: fmtW(mt.newContent || 0), c: fmtW(mt.compRepay || 0), x: fmtW(mt.ttlRepay || 0), pn: (((mt.newContent || 0) / mt.input) * 100).toFixed(1), pc: (((mt.compRepay || 0) / mt.input) * 100).toFixed(1), px: (((mt.ttlRepay || 0) / mt.input) * 100).toFixed(1) } : null;
        // #1609/#1606: surface the attribution buckets (seam / provider-side / rewound /
        // abort-correlated) in the headline hit-rate subline — nonzero-only, same colors
        // as the 归因·未解释残差 card lower on this page.
        const lsRaw = d.ledger && typeof d.ledger.seam === "object" ? d.ledger.seam : null;
        let hitSub = "";
        if (missArgs) hitSub += t("det.miss_sub", { x: missArgs.px, c: missArgs.pc, n: missArgs.pn });
        const attrChips = [];
        if (lsRaw) {
            const seamSm = Number(lsRaw.missed) || 0, seamSn = Number(lsRaw.suspects) || 0;
            if (seamSm > 0 || seamSn > 0) attrChips.push('<span style="color:#cf222e" title="' + escapeHtml(t("det.attr_seam_tip")) + '">' + escapeHtml(t("det.attr_seam")) + " " + fmtW(seamSm) + (seamSn > 0 ? " ×" + seamSn : "") + "</span>");
            const provM = (lsRaw.providerSide && Number(lsRaw.providerSide.missed)) || 0, provN = (lsRaw.providerSide && Number(lsRaw.providerSide.count)) || 0;
            if (provM > 0 || provN > 0) attrChips.push('<span style="color:#bf8700" title="' + escapeHtml(t("det.attr_provider_tip")) + '">' + escapeHtml(t("det.attr_provider")) + " " + fmtW(provM) + (provN > 0 ? " ×" + provN : "") + "</span>");
            const rewM = (lsRaw.rewinds && Number(lsRaw.rewinds.missed)) || 0, rewN = (lsRaw.rewinds && Number(lsRaw.rewinds.count)) || 0;
            if (rewM > 0 || rewN > 0) attrChips.push('<span style="color:#57606a" title="' + escapeHtml(t("det.attr_rewind_tip")) + '">' + escapeHtml(t("det.attr_rewind")) + " " + fmtW(rewM) + (rewN > 0 ? " ×" + rewN : "") + "</span>");
            const abN = Number(lsRaw.abortCorrelated) || 0;
            if (abN > 0) attrChips.push('<span style="color:#d4a72c" title="' + escapeHtml(t("det.attr_abort_tip")) + '">' + escapeHtml(t("det.attr_abort")) + " ×" + abN + "</span>");
        }
        if (attrChips.length) hitSub += (hitSub ? " · " : "") + attrChips.join(" · ");
        mini(parts, t("det.hit_pct"), d.cacheHitPct == null ? null : d.cacheHitPct.toFixed(1) + "%", false, hitSub, missArgs ? t("det.miss_split_line", missArgs) : "");
        mini(parts, t("ov.output_tokens"), d.outputTokens ? fmtW(d.outputTokens) : null);
        const dSavedV = d.netSaved != null ? d.netSaved : d.tokensSaved;
        mini(parts, t("ov.tokens_saved"), dSavedV ? fmtW(dSavedV) : null, dSavedV > 0);
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
        // #1609: cache-miss attribution (#1606). Defensive reads — servers predating #1606
        // carry no ledger.seam at all, and an all-zero shape must render nothing.
        const seamRaw = ledger.seam && typeof ledger.seam === "object" ? ledger.seam : null;
        const seam = seamRaw ? {
            suspects: Number(seamRaw.suspects) || 0,
            missed: Number(seamRaw.missed) || 0,
            events: Array.isArray(seamRaw.events) ? seamRaw.events.filter((e) => e && e.at > 0) : [],
            providerSide: { count: (seamRaw.providerSide && Number(seamRaw.providerSide.count)) || 0, missed: (seamRaw.providerSide && Number(seamRaw.providerSide.missed)) || 0 },
            rewinds: { count: (seamRaw.rewinds && Number(seamRaw.rewinds.count)) || 0, missed: (seamRaw.rewinds && Number(seamRaw.rewinds.missed)) || 0 },
            abortCorrelated: Number(seamRaw.abortCorrelated) || 0,
        } : null;
        const seamActive = !!(seam && (seam.suspects > 0 || seam.missed > 0 || seam.events.length > 0 || seam.providerSide.count > 0 || seam.rewinds.count > 0 || seam.abortCorrelated > 0));
        parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.trajectory") + '</span><span class="hint">' + t("det.trajectory_sub") + '</span></div><div class="card-b">');
        if (!lines.length) {
            parts.push('<div class="chart-empty">' + t("det.trajectory_empty") + "</div>");
        } else {
            parts.push('<div class="chart-wrap">' + trajectorySvg(lines, ledger.folds || [], d.contextWindow, d.systemPromptTokens || 0, seamActive ? seam.events : []) + "</div>");
            parts.push('<div class="chart-legend">');
            parts.push(legendItem("background:var(--accent)", t("det.legend_input")));
            parts.push(legendItem("background:var(--accent);opacity:.4", t("det.legend_cached"), false));
            parts.push(legendItem("#cf222e", t("det.legend_fold"), true));
            if (seamActive && seam.events.length > 0)
                parts.push(legendItem("background:#cf222e", t("det.legend_seam")));
            parts.push(legendItem("#cf222e", t("det.legend_window"), true));
            // Swatches carry real backgrounds (a bare hex in style= renders nothing):
            parts.push(legendItem("background:#bf8700", t("det.cause_comp")));
            parts.push(legendItem("background:#8250df", t("det.cause_ttl")));
            parts.push(legendItem("background:#6e7681", t("det.cause_cold")));
            if (d.systemPromptTokens || lines.length >= 20) parts.push(legendItem("border:1.5px solid #8b949e;background:#f2f5f7;", d.systemPromptTokens ? t("det.legend_base") : t("det.legend_base_est")));
            parts.push("</div>");
            if ((ledger.linesOmitted || 0) > 0) parts.push('<div class="dim small" style="margin-top:6px">' + t("det.omitted", { n: ledger.linesOmitted }) + "</div>");
        }
        parts.push("</div></div>");
        if (seamActive && seam.events.length > 0) {
            const evHead = '<tr><th class="num">#</th><th>' + t("det.fold_time") + '</th><th class="num">' + t("det.seam_col_hit") + '</th><th class="num">' + t("det.seam_col_input") + '</th><th>' + t("det.seam_col_div") + "</th></tr>";
            parts.push('<details open class="seam-ev"><summary title="' + escapeHtml(t("det.seam_events_tip")) + '"><b>' + t("det.seam_events", { n: seam.events.length }) + "</b></summary>"
                + '<div class="fold-scroll" style="max-height:320px;border:none;border-radius:0;padding:2px 8px 8px"><table class="data"><thead>' + evHead + "</thead><tbody>");
            seam.events.forEach((ev) => {
                parts.push('<tr><td class="num">' + ev.seq + '</td><td class="num">' + (ev.at ? fmtDT(ev.at) : t("common.none")) + '</td><td class="num">' + (typeof ev.hitPct === "number" ? ev.hitPct.toFixed(1) + "%" : t("common.none")) + '</td><td class="num">' + fmtW(ev.input || 0) + '</td><td class="mono small">' + fmtB(ev.lcpBytes || 0) + " @ " + t("det.seam_msg", { i: ev.msgIndex != null ? ev.msgIndex : "?", prev: ev.prevMsgs != null ? ev.prevMsgs : "?", cur: ev.curMsgs != null ? ev.curMsgs : "?" }) + "</td></tr>");
            });
            parts.push("</tbody></table></div></details>");
        }
        const tot = ledger.totals;
        parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.cache_econ") + "</span>" + (tot ? (tot.balanced ? ' <span class="badge ok">' + t("det.ce_balanced") + "</span>" : ' <span class="badge warn">' + t("det.ce_unbalanced") + "</span>") : "") + '</div><div class="card-b">' + (d.ledger ? '<div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:10px"><button id="cacherpt-copy" class="btn sm">' + t("common.copy") + '</button><button id="cacherpt-dl" class="btn sm">' + t("det.report_dl") + "</button></div>" : ""));
        if (tot) {
            parts.push('<div class="grid cols-4">');
            mini(parts, t("det.ce_new"), fmtW(tot.newContent || 0));
            mini(parts, t("det.ce_comp"), fmtW(tot.compRepay || 0));
            mini(parts, t("det.ce_ttl"), fmtW(tot.ttlRepay || 0));
            mini(parts, t("det.ce_residual"), fmtW(tot.residual || 0));
            parts.push("</div>");
        }
        if (seamActive) {
            parts.push('<div class="section-label" style="margin-top:14px">' + t("det.attr_title") + "</div>"
                + '<div class="grid cols-4">'
                + '<div class="mini"><div class="k" style="color:#cf222e" title="' + escapeHtml(t("det.attr_seam_tip")) + '">' + escapeHtml(t("det.attr_seam")) + '</div><div class="v mono" style="color:#cf222e">' + fmtW(seam.missed) + (seam.suspects > 0 ? ' <span class="dim small">×</span>' + seam.suspects : "") + "</div>"
                // Per-event attribution inside the seam mini: which samples the aggregate points at.
                + (seam.events.length ? '<div class="dim small mono attr-sub" style="margin-top:4px;line-height:1.6">' + seam.events.slice(0, 6).map((ev) => "#" + ev.seq + " " + (ev.at ? fmtDT(ev.at) : "") + (typeof ev.hitPct === "number" ? " " + ev.hitPct.toFixed(1) + "%" : "") + " ≥" + fmtB(ev.lcpBytes || 0) + " @m" + (ev.msgIndex != null ? ev.msgIndex : "?") + (ev.prevMsgs != null && ev.curMsgs != null ? " (" + ev.prevMsgs + "→" + ev.curMsgs + ")" : "") + "<br>").join("") + (seam.events.length > 6 ? "+" + (seam.events.length - 6) + " …<br>" : "") + "</div>" : "")
                + "</div>"
                + '<div class="mini"><div class="k" style="color:#bf8700" title="' + escapeHtml(t("det.attr_provider_tip")) + '">' + escapeHtml(t("det.attr_provider")) + '</div><div class="v mono" style="color:#bf8700">' + fmtW(seam.providerSide.missed) + (seam.providerSide.count > 0 ? ' <span class="dim small">×</span>' + seam.providerSide.count : "") + "</div></div>"
                + '<div class="mini"><div class="k" style="color:#57606a" title="' + escapeHtml(t("det.attr_rewind_tip")) + '">' + escapeHtml(t("det.attr_rewind")) + '</div><div class="v mono" style="color:#57606a">' + fmtW(seam.rewinds.missed) + (seam.rewinds.count > 0 ? ' <span class="dim small">×</span>' + seam.rewinds.count : "") + "</div></div>"
                + '<div class="mini"><div class="k" style="color:#d4a72c" title="' + escapeHtml(t("det.attr_abort_tip")) + '">' + escapeHtml(t("det.attr_abort")) + '</div><div class="v mono" style="color:#d4a72c">' + String(seam.abortCorrelated) + "</div></div>"
                + "</div>"
                + '<div class="dim small" style="margin-top:6px">' + t("det.attr_note") + "</div>");
        }
        const folds = ledger.folds || [];
        parts.push('<div class="section-label" style="margin-top:14px">' + t("det.folds") + "</div>");
        if (!folds.length) parts.push('<div class="dim small">' + t("det.folds_empty") + "</div>");
        else {
            // All folds in one scrollable panel (same pattern as the compression blocks):
            // numeric headers align with their columns; long lists just scroll.
            const foldHead = '<tr><th class="num">#</th><th>' + t("det.fold_time") + '</th><th class="num">' + t("det.fold_s") + '</th><th class="num">' + t("det.fold_sigma") + '</th><th class="num">' + t("det.fold_h") + '</th><th class="num">' + t("det.fold_t") + "</th></tr>";
            const foldRow = (f, i) => '<tr><td class="num">' + (f.seq != null ? f.seq : i + 1) + '</td><td class="num">' + (f.at ? fmtDT(f.at) : t("common.none")) + '</td><td class="num">' + fmtW(f.S) + '</td><td class="num">' + fmtW(f.sigma) + '</td><td class="num">' + (f.hPct == null ? t("common.none") : f.hPct.toFixed(1) + "%") + '</td><td class="num">' + fmtW(f.T) + "</td></tr>";
            parts.push('<div class="fold-scroll"><table class="data"><thead>' + foldHead + '</thead><tbody>');
            folds.forEach((f, i) => parts.push(foldRow(f, i)));
            parts.push("</tbody></table></div>");
        }
        parts.push("</div></div>");
        const blocks = d.blockDetails || [];
        const activeBlocks = blocks.filter((b) => b.active).length;
        parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.blocks_title") + '</span><span class="hint">' + t("det.blocks_count", { total: blocks.length, active: activeBlocks }) + '</span></div><div class="card-b blocks-list">');
        if (!blocks.length) {
            parts.push('<div class="dim small" style="padding:8px 0">' + t("det.blocks_empty") + "</div>");
        } else {
            // #1426: copy-all / download blocks-markdown actions
            parts.push('<div style="display:flex;gap:8px;margin-bottom:10px"><button id="blocks-copy" class="btn sm">' + t("det.blocks_copy_md") + '</button><button id="blocks-dl" class="btn sm">' + t("det.blocks_download") + "</button></div>");
            blocks.forEach((b, i) => {
                // #1426: expose the compressed conversation span (mNNNNN refs) when the kernel tagged it
                const refRange = b.startRef ? (b.endRef && b.endRef !== b.startRef ? b.startRef + "–" + b.endRef : b.startRef) : null;
                // Active = still inside the current context window; inactive = archived history.
                const badge = b.active
                    ? '<span class="badge ok">' + t("det.block_active") + "</span>"
                    : '<span class="badge disk">' + t("det.block_inactive") + "</span>";
                parts.push('<details class="block-item"><summary><span class="bid">' + escapeHtml(b.blockId) + '</span>' + badge + '<span class="topic">' + escapeHtml(blockTopic(b)) + '</span><span class="meta">T' + String(b.tier) + " · " + fmtW(b.compressedTokens) + " · " + timeAgo(b.createdAt) + (refRange ? " · " + escapeHtml(refRange) : "") + '</span><button class="btn sm blk-copy" data-bi="' + i + '" style="margin-left:auto">' + t("common.copy") + '</button></summary><div class="body md">' + renderBlockMd(b.summary || "") + "</div></details>");
            });
        }
        parts.push("</div></div>");
        parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.handoff") + '</span><span class="hint">' + t("det.handoff_hint") + '</span></div><div class="card-b">');
        // #1426: copy / download actions over the rendered handoff document
        parts.push('<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"><button id="handoff-copy-md" class="btn sm">' + t("det.handoff_copy_md") + '</button><button id="handoff-dl" class="btn sm">' + t("det.handoff_download") + "</button></div>");
        if (d.handoffTruncated) parts.push('<div class="banner warn show" style="margin:0 0 10px">' + t("det.handoff_truncated") + "</div>");
        if (d.handoffMd) parts.push('<div class="handoff">' + renderHandoffMd(d.handoffMd) + "</div>");
        else if (d.handoffHtml) parts.push('<div class="handoff">' + d.handoffHtml + "</div>");
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
        try {
            host.innerHTML = buildDetailHtml(d);
            bindHandoffActions(d);
            bindBlocksActions(d);
            bindCacheReportActions(d);
            const tc = $("title-copy");
            if (tc && d.title) tc.addEventListener("click", () => copyText(d.title, tc));
        } catch (e) {
            host.innerHTML = '<a class="btn sm" href="#/sessions">' + t("common.back") + '</a><div class="card" style="margin-top:12px"><div class="card-b"><div class="empty">⚠️ ' + escapeHtml(e.message) + "</div></div></div>";
        }
    }
    // Shared clipboard feedback: never swap the label — green state plus a transient
    // “copied” bubble above the control so success is unmistakable.
    function copiedHint(el) {
        if (!el || !el.getBoundingClientRect) return;
        const r = el.getBoundingClientRect();
        const tip = document.createElement("span");
        tip.className = "copied-hint";
        tip.textContent = t("common.copied_hint");
        tip.style.left = Math.max(60, Math.min(window.innerWidth - 60, r.left + r.width / 2)) + "px";
        tip.style.top = Math.max(4, r.top - 38) + "px";
        document.body.appendChild(tip);
        setTimeout(() => { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 1400);
    }
    function flashCopied(el) {
        if (!el || !el.classList) return;
        el.classList.add("copied");
        setTimeout(() => { el.classList.remove("copied"); }, 1200);
        copiedHint(el);
    }
    function copyText(text, btn) {
        const done = () => flashCopied(btn);
        const fallback = () => {
            const ta = document.createElement("textarea");
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand("copy"); } catch (e) {}
            ta.remove();
            done();
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(fallback);
        else fallback();
    }
    function refRangeOf(b) {
        return b.startRef ? (b.endRef && b.endRef !== b.startRef ? b.startRef + "–" + b.endRef : b.startRef) : null;
    }
    function buildBlockMd(b) {
        const rr = refRangeOf(b);
        const L = [];
        L.push("## Block " + b.blockId + (b.topic ? " — " + b.topic : "") + (b.active ? "" : " (inactive)"));
        L.push("");
        L.push("tier " + b.tier + " · ~" + fmtW(b.compressedTokens) + " tokens" + (b.createdAt ? " · " + fmtDT(b.createdAt) : "") + (rr ? " · " + rr : ""));
        L.push("");
        L.push(String(b.summary || "").trim());
        return L.join("\\n");
    }
    function buildBlocksMd(d) {
        const L = [];
        L.push("# billion-context compression blocks");
        L.push("");
        if (d.title) L.push("- title: " + d.title);
        L.push("- session id: " + d.id);
        L.push("- blocks: " + d.blockDetails.length + " (" + d.blockDetails.filter((x) => x.active).length + " active)");
        d.blockDetails.forEach((b) => { L.push(""); L.push(buildBlockMd(b)); });
        return L.join("\\n");
    }
    function bindBlocksActions(d) {
        if (!d.blockDetails || !d.blockDetails.length) return;
        const cp = $("blocks-copy");
        if (cp) cp.addEventListener("click", () => copyText(buildBlocksMd(d), cp));
        const dl = $("blocks-dl");
        if (dl) dl.addEventListener("click", () => {
            const url = URL.createObjectURL(new Blob([buildBlocksMd(d)], { type: "text/markdown;charset=utf-8" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "billion-context-blocks-" + String(d.id).replace(/[^A-Za-z0-9._-]/g, "_") + ".md";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
        });
        // Per-block copy buttons live inside <summary>, so stop propagation/toggle.
        document.querySelectorAll(".blk-copy").forEach((btn) => {
            const bi = Number(btn.getAttribute("data-bi") || 0);
            const b = d.blockDetails[bi];
            if (!b) return;
            btn.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); copyText(buildBlockMd(b), btn); });
        });
    }
    function bindCacheReportActions(d) {
        const copyB = $("cacherpt-copy");
        const dlB = $("cacherpt-dl");
        if (!copyB || !dlB) return;
        const grab = async () => {
            const r = await json("/__bili/cache-report?session=" + encodeURIComponent(d.id));
            const rep = r && Array.isArray(r.reports) && r.reports[0] ? r.reports[0].report : null;
            if (!rep) throw new Error("no cache report for this session yet");
            return rep;
        };
        copyB.addEventListener("click", async () => {
            busy(copyB, true);
            try {
                const md = await grab();
                try { await navigator.clipboard.writeText(md); }
                catch (e) { const ta = document.createElement("textarea"); ta.value = md; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
                flashCopied(copyB);
            } catch (e) { toast(t("toast.failed", { msg: e.message }), "err"); } finally { busy(copyB, false); }
        });
        dlB.addEventListener("click", async () => {
            busy(dlB, true);
            try {
                const md = await grab();
                const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = "billion-context-cacherpt-" + String(d.id).replace(/[^A-Za-z0-9._-]/g, "_") + ".md";
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            } catch (e) { toast(t("toast.failed", { msg: e.message }), "err"); } finally { busy(dlB, false); }
        });
    }
    function bindHandoffActions(d) {
        const copyBtn = $("handoff-copy-md");
        const dlBtn = $("handoff-dl");
        if (!d.handoffMd) {
            if (copyBtn) copyBtn.hidden = true;
            if (dlBtn) dlBtn.hidden = true;
            return;
        }
        const md = d.handoffMd;
        if (copyBtn) copyBtn.addEventListener("click", () => {
            const done = () => flashCopied(copyBtn);
            const fallback = () => {
                const ta = document.createElement("textarea");
                ta.value = md;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand("copy"); done(); } catch (e) { toast(t("toast.failed", { msg: e.message }), "err"); }
                ta.remove();
            };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(md).then(done, fallback);
            else fallback();
        });
        // #1426 web UI: "?" info marks (e.g. hit-rate miss split) - click opens a floating note
        let qtipEl = null;
        let qtipFor = null;
        const hideQTip = () => { if (qtipEl) { qtipEl.remove(); qtipEl = null; qtipFor = null; } };
        const showQTip = (el) => {
            hideQTip();
            const text = el.getAttribute("data-qtip") || "";
            if (!text) return;
            qtipEl = document.createElement("div");
            qtipEl.className = "qtip";
            qtipEl.textContent = text;
            document.body.appendChild(qtipEl);
            const r = el.getBoundingClientRect();
            const w = qtipEl.offsetWidth;
            const h = qtipEl.offsetHeight;
            let left = r.right - 8;
            if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
            let top = r.bottom + 6;
            if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
            qtipEl.style.left = left + "px";
            qtipEl.style.top = top + "px";
            qtipFor = el;
        };
        document.addEventListener("click", (ev) => {
            const target = ev.target;
            if (!target || !target.closest) return;
            const q = target.closest(".qmark");
            if (q) {
                ev.preventDefault();
                ev.stopPropagation();
                if (qtipFor === q) hideQTip();
                else showQTip(q);
                return;
            }
            hideQTip();
        });
        document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") hideQTip(); });
        window.addEventListener("hashchange", hideQTip);
        if (dlBtn) dlBtn.addEventListener("click", () => {
            const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "billion-context-handoff-" + String(d.id).replace(/[^A-Za-z0-9._-]/g, "_") + ".md";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
        });
    }

    async function loadConfig() {
        try {
            const cfg = await json("/__bili/config");
            const cfgPathEl = $("cfg-path");
            if (cfgPathEl) cfgPathEl.textContent = cfg.path || t("common.empty");
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
            // #1426: one raw config-file editor replaced the per-section JSON boxes
            const fe = $("cfg-file-edit");
            if (fe) {
                let val = typeof cfg.raw === "string" && cfg.raw.trim() ? cfg.raw : "";
                if (!val) {
                    const o = {};
                    if (cfg.providers && typeof cfg.providers === "object" && Object.keys(cfg.providers).length) o.providers = cfg.providers;
                    if (cfg.upstreamProxyMode || cfg.upstreamProxy) { o.upstreamProxyMode = cfg.upstreamProxyMode || "auto"; if (cfg.upstreamProxy) o.upstreamProxy = cfg.upstreamProxy; }
                    if (cfg.compress && typeof cfg.compress === "object" && Object.keys(cfg.compress).length) o.compress = cfg.compress;
                    val = JSON.stringify(o, null, 2);
                }
                fe.value = val;
            }
            const broken = Boolean(cfg.parseError);
            ["cfg-file-edit", "save-file", "save-upstream"].forEach((id) => { const el = $(id); if (el) el.disabled = broken; });
            const ptState = $("pt-state");
            const ptSource = $("pt-source");
            const clearPt = $("clear-passthrough");
            const pt = cfg.passthrough;
            // #1426: passthrough shows where it came from; env-driven cannot be cleared from here
            if (pt && pt.enabled) {
                ptState.className = "badge ok";
                ptState.textContent = t("cfg.pt_on");
                ptSource.textContent = pt.source === "env" ? t("sys.pt_env") : t("sys.pt_file");
                clearPt.hidden = pt.source !== "env";
            } else {
                ptState.className = "badge disk";
                ptState.textContent = t("cfg.pt_off");
                ptSource.textContent = pt && pt.source ? (pt.source === "env" ? t("sys.pt_env") : t("sys.pt_file")) : "";
                clearPt.hidden = true;
            }
            loadUpstream(cfg);
        } catch (e) {
            toast(t("toast.failed", { msg: e.message }), "err");
        }
    }
    async function loadUpstream(cfg) {
        let up = null;
        try { up = await json("/__bili/upstream"); } catch (e) {}
        // #1426: mode/proxy are editable form fields again, not read-only labels
        const mode = (up && up.mode) || cfg.upstreamProxyMode || "auto";
        document.querySelectorAll('input[name="proxy-mode"]').forEach((el) => { el.checked = el.value === mode; });
        const pu = $("proxy-url");
        if (pu) pu.value = ((up && up.proxy) || cfg.upstreamProxy || "").replace(new RegExp("/+$"), "");
        const st = $("up-state");
        if (up && up.connected === true) { st.className = "badge ok"; st.textContent = "ok · " + (up.checkedAt ? timeAgo(up.checkedAt) : ""); }
        else if (up && up.connected === false) { st.className = "badge warn"; st.textContent = up.error ? String(up.error) : "error"; }
        else { st.className = "badge disk"; st.textContent = t("cfg.untested"); }
    }

    function applyLogFilter(hq) {
        const m = hq.match(/^(?:[?&])?q=([\\s\\S]*)$/);
        const q = m ? decodeURIComponent(m[1]) : "";
        const el = $("log-search");
        if (el && el.value !== q) el.value = q;
    }
    function logViewExtras() {
        // Context expansion vs time window (window wins — it implies context).
        const winChk = $("log-win");
        const ctxChk = $("log-ctx");
        if (winChk && winChk.checked) return "&win=120";
        if (ctxChk && ctxChk.checked) return "&ctx=3";
        return "";
    }
    async function loadLogs() {
        const qEl = $("log-search");
        if (!qEl || !$("log-body")) return;
        const q = (qEl.value || "").trim();
        try {
            const linesSel = $("log-lines");
            const d = await json("/__bili/logs?q=" + encodeURIComponent(q) + "&lines=" + (linesSel ? linesSel.value : "500") + logViewExtras());
            $("log-path").textContent = d.path || t("logs.empty");
            $("copy-log-path").dataset.copy = d.path || "";
            $("log-count").textContent = d.total > 0
                ? t("logs.count", { n: (d.lines || []).length, total: d.total }) + ((typeof d.omitted === "number" && d.omitted > 0) ? t("logs.omitted", { o: d.omitted }) : "")
                : "";
            const bodyEl = $("log-body");
            const rows = d.lines || [];
            if (!rows.length) {
                bodyEl.textContent = t("logs.empty");
            } else if (Array.isArray(d.isMatch)) {
                // Filtered view: highlight hits, dim context/time-window rows.
                bodyEl.innerHTML = rows.map(function (l, i) { return '<div class="' + (d.isMatch[i] ? "lm-hit" : "lm-ctx") + '">' + escapeHtml(l) + "</div>"; }).join("");
            } else {
                bodyEl.textContent = rows.join("\\n");
            }
        } catch (e) { /* the log endpoint is best-effort; stay quiet */ }
    }

    function bindLauncherNotes() {
        // Per-client launch notes (from the README launcher table) as hover tooltips.
        const N = { pi: t("con.note_pi"), codex: t("con.note_codex"), claude: t("con.note_claude"), omp: t("con.note_omp"), opencode: t("con.note_opencode"), hermes: t("con.note_hermes"), dsh: t("con.note_dsh"), codebuddy: t("con.note_codebuddy"), qoder: t("con.note_qoder"), trae: t("con.note_trae"), jcode: t("con.note_jcode"), kimi: t("con.note_kimi"), gemini: t("con.note_gemini"), iflow: t("con.note_iflow"), qwen: t("con.note_qwen"), mcode: t("con.note_mcode"), aider: t("con.note_aider"), copilot: t("con.note_copilot"), amp: t("con.note_amp"), goose: t("con.note_goose") };
        document.querySelectorAll(".chip[data-launcher]").forEach((el) => { const n = N[el.getAttribute("data-launcher")]; if (n) el.title = n; });
    }

    function route() {
        bindLauncherNotes();
        const hash = location.hash || "#/overview";
        const qi = hash.indexOf("?");
        const hbase = qi < 0 ? hash : hash.slice(0, qi);
        const hq = qi < 0 ? "" : hash.slice(qi + 1);
        let name = "overview";
        let detailId = null;
        const top = hbase.match(new RegExp("^#/(overview|config|connect|logs)$"));
        if (top) {
            name = top[1];
            if (name === "logs" && hq) applyLogFilter(hq);
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
        else if (name === "logs") loadLogs();
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
        let logTimer = null;
        const lsearch = $("log-search");
        if (lsearch) lsearch.addEventListener("input", () => { clearTimeout(logTimer); logTimer = setTimeout(loadLogs, 400); });
        const llines = $("log-lines");
        if (llines) llines.addEventListener("change", loadLogs);
        const ldl = $("log-dl");
        if (ldl) ldl.addEventListener("click", async () => {
            busy(ldl, true);
            try {
                const q = ($("log-search").value || "").trim();
                const r = await fetch("/__bili/logs?raw=1&q=" + encodeURIComponent(q) + "&lines=2000" + logViewExtras());
                const blob = await r.blob();
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = "billion-context-log.txt";
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            } catch (e) {
                toast(t("toast.failed", { msg: e.message }), "err");
            } finally {
                busy(ldl, false);
            }
        });
        const ldlAll = $("log-dl-all");
        if (ldlAll) ldlAll.addEventListener("click", async () => {
            busy(ldlAll, true);
            try {
                // Full unfiltered log (rotated .old + current) regardless of the
                // search box — the honest "download everything" path.
                const r = await fetch("/__bili/logs?raw=1&all=1");
                const blob = await r.blob();
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = "billion-context-full-log.txt";
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            } catch (e) {
                toast(t("toast.failed", { msg: e.message }), "err");
            } finally {
                busy(ldlAll, false);
            }
        });
        const testBtn = $("test-upstream");
        if (testBtn) testBtn.addEventListener("click", async () => {
            busy(testBtn, true);
            try {
                const r = await json("/__bili/upstream/test", { method: "POST" });
                // #1426: an HTTP >= 400 answer still proves the network path works — auth is the
                // client's job, so report reachability instead of a flat failure
                const st = $("up-state");
                st.className = "badge ok";
                st.textContent = t("cfg.state_reached", { status: r.status });
                toast(r.status >= 400 ? t("toast.upstream_reachable", { status: r.status }) : t("toast.connect_ok", { status: r.status }), "ok");
            } catch (e) {
                toast(t("toast.failed", { msg: e.message }), "err");
                const st = $("up-state");
                st.className = "badge warn";
                st.textContent = e.message;
            } finally {
                busy(testBtn, false);
            }
        });
        // #1426: restore the config editors lost in the web UI rewrite (PUT endpoints were already in place)
        const su = $("save-upstream");
        if (su) su.addEventListener("click", async () => {
            const modeEl = document.querySelector('input[name="proxy-mode"]:checked');
            const mode = modeEl ? modeEl.value : "auto";
            const pu = $("proxy-url");
            const val = pu ? pu.value.trim() : "";
            await putCfg(su, { upstreamProxyMode: mode, upstreamProxy: val || null });
        });
        // #1426: single raw config-file editor — the server validates every known field
        const sf = $("save-file");
        if (sf) sf.addEventListener("click", async () => {
            const el = $("cfg-file-edit");
            const raw = el ? el.value : "";
            let parsed;
            try { parsed = JSON.parse(raw || "{}"); } catch (e) { toast(t("cfg.invalid_json"), "err"); return; }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { toast(t("cfg.invalid_json"), "err"); return; }
            await putCfg(sf, { file: raw });
        });
        const cp = $("clear-passthrough");
        if (cp) cp.addEventListener("click", async () => {
            busy(cp, true);
            try {
                await json("/__bili/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ passthrough: null }) });
                toast(t("toast.passthrough_cleared"), "ok");
                loadConfig();
            } catch (e) {
                toast(e.message, "err");
            } finally {
                busy(cp, false);
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
            const done = () => flashCopied(btn);
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
        // #1682: keep the global alert banner fresh on every view — silent, so a
        // restarting server cannot spam toasts from background views.
        if (current === "overview") loadOverview();
        else loadOverview(true);
        if (current === "sessions" && $("session-detail-view").hidden) refreshSessions(false);
        else if (current === "logs") loadLogs();
    }, 5000);
})();`;
