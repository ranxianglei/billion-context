import { MESSAGES } from "./i18n.js";

export const WEB_CLIENT = `(function () {
    "use strict";
    const MESSAGES=${JSON.stringify(MESSAGES)};
    let locale = "zh-CN";
    try {
        // #2321: an embedding host may pin the locale explicitly (?lang=zh|en) —
        // it outranks both the stored choice and the browser default so the
        // framed UI follows the host's language. Regex parse + typeof guard on
        // purpose: this IIFE also executes in vm sandboxes without URLSearchParams
        // and in host contexts with no location global at all (test harnesses).
        const search = typeof location !== "undefined" ? location.search || "" : "";
        const pinMatch = /[?&]lang=([^&]*)/i.exec(search);
        const pinned = pinMatch && pinMatch[1] ? pinMatch[1] : null;
        if (pinned === "zh" || pinned === "zh-CN") locale = "zh-CN";
        else if (pinned === "en") locale = "en";
        else {
            const saved = localStorage.getItem("bili-language");
            if (saved === "en" || saved === "zh-CN") locale = saved;
            else if (/^en([-_]|$)/i.test(navigator.language || "")) locale = "en";
        }
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
    // #1206 ledger detail carries per-event identity (client/entry/source);
    // #2045: third-party plugin entries render in FULL — keep the source path and
    // list EVERY distinct entry, no truncation.
    // #2102: non-plugin kinds (unannounced-rewrite / orphan-reap / native-compaction)
    // carry time + short detail — the banner sentence must attribute exactly what
    // this line names, never a fixed "third-party plugin" claim.
    function conflictItemName(e) {
        if (!e || typeof e.detail !== "string" || !e.detail) return "";
        if (e.kind === "third-party-plugin") {
            let s = e.detail;
            const suspected = s.indexOf("[suspected]") >= 0;
            const si = s.lastIndexOf("[suspected]");
            if (si >= 0) s = s.slice(0, si);
            return s.trim() + (suspected ? " [suspected]" : "");
        }
        const at = Number(e.at);
        const time = Number.isFinite(at) ? new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z" : "?";
        const sid = e.sessionId && String(e.sessionId).length > 8 ? String(e.sessionId).slice(0, 5) + "…" : null;
        const d = e.detail.length > 60 ? e.detail.slice(0, 57) + "..." : e.detail;
        return "[" + time + "]" + (sid ? " " + sid : "") + ": " + d;
    }
    function bili_conflictLine(c) {
        const kinds = Object.entries(c.kinds || {}).map((kv) => kv[0] + "×" + kv[1]).join(", ");
        const items = [];
        for (const e of c.latest || []) {
            const name = conflictItemName(e);
            if (!name) continue;
            const hit = items.find((x) => x.name === name);
            if (hit) hit.n += 1;
            else items.push({ name: name, n: 1, plugin: e.kind === "third-party-plugin" });
        }
        // #2102: the banner is a summary surface — plugin identities stay complete
        // (#2045), other kinds are capped so a stock ledger doesn't become a log dump.
        const shown = [];
        let hidden = 0;
        for (const x of items) {
            if (x.plugin || shown.filter((y) => !y.plugin).length < 4) shown.push(x);
            else hidden += 1;
        }
        let line = c.events + " event(s) in " + c.sessions + " session(s)" + (kinds ? ": " + kinds : "");
        // #2324: the split is record RECENCY, not liveness — "active" read as a running conflict.
        if (typeof c.active === "number" && typeof c.historical === "number") {
            line += " · " + t("conflict.age_active", { n: c.active }) + " · " + t("conflict.age_historical", { n: c.historical });
        }
        if (shown.length > 0) {
            line += " — " + shown.map((x) => escapeHtml(x.name) + (x.n > 1 ? "×" + x.n : "")).join(" · ");
        }
        if (hidden > 0) line += " · …+" + hidden + " more (GET /__bili/stats → conflicts)";
        return line;
    }
    // #2324: pick the banner title/risk wording from the ledger families present. Name-only
    // [suspected] matches are NEVER treated as confirmed compressors — they get a softer
    // "verify first" framing, not the imperative double-compression warning. Old payloads
    // without c.suspected degrade to the previous all-confirmed view. Pure (reads only c),
    // exported for tests the same way bili_conflictLine is.
    function bili_conflictSeverity(c) {
        const pluginN = (c.kinds && c.kinds["third-party-plugin"]) || 0;
        const siblingN = Math.max(0, Math.min(typeof c.sibling === "number" ? c.sibling : 0, pluginN));
        const suspectedN = Math.max(0, Math.min(typeof c.suspected === "number" ? c.suspected : 0, pluginN - siblingN));
        const confirmedTpN = Math.max(0, pluginN - siblingN - suspectedN);
        const nativeN = Math.max(0, c.events - pluginN);
        const whatParts = [];
        if (confirmedTpN > 0) whatParts.push(t("conflict.what_plugin"));
        if (suspectedN > 0) whatParts.push(t("conflict.what_suspected"));
        // #2430: siblings are family, never a warning — they no longer appear in the
        // "what" enumeration even in mixed ledgers (pure-sibling banners are hidden outright).
        if (nativeN > 0) whatParts.push(t("conflict.what_native"));
        const active = typeof c.active === "number" ? c.active : c.events;
        const hasConfirmed = confirmedTpN > 0 || nativeN > 0;
        // Resolve each branch through a direct translate call (not a key-to-text lookup table)
        // so the #1024 static ref-scanner still counts every conflict.* key used here; surface
        // both the key (locale-independent, asserted by tests) and the rendered text.
        let onKey, riskKey, onText, riskText;
        if (hasConfirmed) {
            onKey = "conflict.on"; onText = t("conflict.on");
            if (active > 0) { riskKey = "conflict.risk_active"; riskText = t("conflict.risk_active"); }
            else { riskKey = "conflict.risk_historical"; riskText = t("conflict.risk_historical"); }
        } else if (suspectedN > 0) {
            onKey = "conflict.on_suspected"; onText = t("conflict.on_suspected");
            riskKey = "conflict.risk_suspected"; riskText = t("conflict.risk_suspected");
        } else {
            onKey = "conflict.on"; onText = t("conflict.on");
            riskKey = "conflict.risk_sibling"; riskText = t("conflict.risk_sibling");
        }
        // #2430: a ledger that is ONLY bili's own siblings stands down completely — they are
        // compatible family, not conflicts; the web banner must stay hidden for them.
        const siblingOnly = !hasConfirmed && suspectedN === 0 && siblingN > 0;
        return { onKey: onKey, riskKey: riskKey, onText: onText, riskText: riskText, hasConfirmed: hasConfirmed, siblingOnly: siblingOnly, what: whatParts.join(t("conflict.what_join")), active: active };
    }
    window.bili_conflictLine = bili_conflictLine;
    window.bili_conflictSeverity = bili_conflictSeverity;
    // #2219: per-client remediation block for the conflict surfaces — one
    // actionable i18n line per resolved client (capped so the banner stays a
    // summary), unknown clients fall back to the generic hint, and every block
    // ends at the docs pointer instead of duplicating the full matrix.
    // Explicit branches keep every key a literal t("…") reference so the #1024
    // liveness gate sees them (dynamic "conflict.hint." + cl reads as dead);
    // the whitelist mirrors the server map (conflictRemediation), unknown → generic.
    function conflictHintLine(cl) {
        switch (cl) {
            case "opencode": return t("conflict.hint.opencode");
            case "claude": return t("conflict.hint.claude");
            case "codex": return t("conflict.hint.codex");
            case "pi": return t("conflict.hint.pi");
            case "omp": return t("conflict.hint.omp");
            default: return t("conflict.hint.generic");
        }
    }
    function conflictHintBlock(clients) {
        const uniq = [];
        for (const x of Array.isArray(clients) ? clients : []) {
            if (typeof x !== "string" || !x || uniq.indexOf(x) >= 0) continue;
            uniq.push(x);
        }
        const MAX_HINTS = 3;
        let html = '<div style="margin-top:6px">' + t("conflict.hint_label");
        if (uniq.length === 0) {
            html += '<div class="mono small" style="margin-top:2px">' + escapeHtml(t("conflict.hint.generic")) + "</div>";
        } else {
            for (const cl of uniq.slice(0, MAX_HINTS)) {
                html += '<div class="mono small" style="margin-top:2px">' + escapeHtml(conflictHintLine(cl)) + "</div>";
            }
            if (uniq.length > MAX_HINTS) html += '<div class="dim small">' + t("conflict.hint_more", { n: uniq.length - MAX_HINTS }) + "</div>";
        }
        html += '<div class="dim small">' + escapeHtml(t("conflict.docs")) + "</div></div>";
        return html;
    }
    window.bili_conflictHintBlock = conflictHintBlock;
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
    // #1937: hard 20s cap — a wedged admin endpoint must fail visibly instead of
    // stacking unbounded in-flight requests while the UI keeps polling.
    async function json(url, opts) {
        const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = ac ? setTimeout(() => ac.abort(), 20000) : null;
        try {
            const res = await fetch(url, Object.assign({}, opts, ac ? { signal: ac.signal } : {}));
            let body = null;
            try { body = await res.json(); } catch (e) {}
            if (!res.ok) throw new Error(body && body.error ? String(body.error) : "HTTP " + res.status);
            return body;
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
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
        // #2413: B-tier was toFixed(1) → 100M step, cumulative counters looked frozen for days; toFixed(2) = 10M keeps growth visible.
        if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
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
    // #2478: money formatting mirroring the server's fmtUsd (cache-ledger.ts).
    function fmtUsd(n) {
        if (n === null || n === undefined || isNaN(n)) return t("common.none");
        n = Number(n);
        const sign = n < 0 ? "-" : "";
        const a = Math.abs(n);
        if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(2) + "M";
        if (a >= 10000) return sign + "$" + (a / 1000).toFixed(1) + "K";
        if (a >= 100) return sign + "$" + a.toFixed(1);
        return sign + "$" + a.toFixed(2);
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
    // #1937: server-side paging state for the session list (50 rows per page).
    const SES_PAGE_SIZE = 50;
    let sesPage = 1;
    let sesTotal = 0;
    // #1937: poll failure accounting — exponential backoff (5s → 10s → … cap 60s),
    // one persistent error strip instead of toast spam, and an in-flight guard so
    // slow responses never stack concurrent admin requests.
    let pollFailures = 0;
    let nextPollAt = 0;
    let pollBusy = false;
    let lastErrMsg = "";
    function friendlyMsg(e) {
        const m = String((e && e.message) || "");
        if (/abort/i.test(m)) return t("data.timeout");
        return m || t("data.generic");
    }
    function showDataError(msg) {
        lastErrMsg = msg;
        let el = $("bili-data-error");
        if (!el) {
            el = document.createElement("div");
            el.id = "bili-data-error";
            el.className = "banner err";
            const host = document.querySelector ? (document.querySelector("main") || document.body) : document.body;
            if (host && host.appendChild) host.prepend ? host.prepend(el) : host.appendChild(el);
        }
        el.textContent = t("data.error", { msg });
        el.hidden = false;
    }
    function hideDataError() {
        const el = $("bili-data-error");
        if (el) { el.hidden = true; el.textContent = ""; }
    }

    function sortKeysDeep(x) {
        if (Array.isArray(x)) return x.map(sortKeysDeep);
        if (x !== null && typeof x === "object") { const o = {}; Object.keys(x).sort().forEach((k) => { o[k] = sortKeysDeep(x[k]); }); return o; }
        return x;
    }
    function canonCfgText(s) {
        try { return JSON.stringify(sortKeysDeep(JSON.parse(s))); } catch (e) { return "\u0000" + s; }
    }
    let cfgSavedSnap = null;
    function refreshDirtyFlag() {
        const el = $("cfg-file-edit");
        const dirty = Boolean(el && cfgSavedSnap !== null && canonCfgText(el.value) !== canonCfgText(cfgSavedSnap));
        ["card-quick", "card-file", "summary-settings"].forEach((id) => { const c = $(id); if (c) c.style.borderColor = dirty ? "#bf8700" : ""; });
        document.querySelectorAll(".cfg-dirty-note").forEach((n) => { n.hidden = !dirty; });
    }

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
            + (s.selfHeal ? ' <span class="badge live" style="background:#8a6d3b" title="' + escapeHtml(t("det.self_heal_tip")) + '">' + t("det.self_heal_short") + "</span>" : "")
            + '<span class="row-id">' + escapeHtml(s.id) + "</span></a>";
    }
    // SAVED column prefers ledger-derived net savings; pre-tagging sessions fall back
    // to the local tokensSaved estimate; neither present => honest dash, never fake 0.
    function savedTd(x) {
        // #2478 round 2: tokens stay primary (money is a list-price estimate —
        // owner keeps both calibers); priced sessions get a small "≈$X" line
        // under the figure with the price source in the tooltip.
        const v = x.netSaved != null ? x.netSaved : (x.tokensSaved || 0);
        const priced = x.netSavedUsd != null;
        const usdLine = priced ? '<br><span class="dim small">≈' + fmtUsd(x.netSavedUsd) + "</span>" : "";
        // #2202: name the frozen share in the tooltip when any fold lost
        // coverage — the number is honest now, but the operator must see it.
        const clTip = x.coverageLostFolds
            ? t("ses.covlost_tip", { n: x.coverageLostFolds, x: fmtW(x.coverageLostFrozenTokens || 0) })
            : "";
        const usdTip = priced
            ? [x.priceSource ? t("ses.saved_usd_tip", { s: x.priceSource }) : t("ses.saved_usd_tip_plain"), (v < 0 || x.netSavedUsd < 0) ? t("ov.saved_neg_usd_tip") : ""].filter(Boolean).join(" ")
            : "";
        const tips = [usdTip, clTip].filter(Boolean);
        const tip = tips.length ? ' title="' + escapeHtml(tips.join(" ")) + '"' : "";
        if (v > 0) return '<td class="num good-num"' + tip + ">" + fmtW(v) + usdLine + "</td>";
        if (v) return '<td class="num"' + (tip || ' title="' + escapeHtml(t("ov.saved_neg_tip")) + '"') + ">" + fmtW(v) + usdLine + "</td>";
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
    // shows count · dropped tokens, honest dash when none. #2131: appends 🔑 key
    // switches (relay account rotation) when observed — rare but cache-fatal.
    function switchTd(s) {
        const modelPart = s.modelSwitches
            ? s.modelSwitches + (!s.switchMissedTokens ? "" : " · " + fmtW(s.switchMissedTokens))
            : "";
        const keyPart = s.keySwitches
            ? '<span title="' + escapeHtml(t("ses.th_keyswitches_tip")) + '">🔑' + s.keySwitches + (!s.keySwitchMissedTokens ? "" : " · " + fmtW(s.keySwitchMissedTokens)) + "</span>"
            : "";
        // #2350: ✍️ = host system-prompt rewrites (fingerprint changed between requests).
        const promptPart = s.promptSwitches
            ? '<span title="' + escapeHtml(t("ses.th_promptswitches_tip")) + '">✍️' + s.promptSwitches + (!s.promptSwitchMissedTokens ? "" : " · " + fmtW(s.promptSwitchMissedTokens)) + "</span>"
            : "";
        if (!modelPart && !keyPart && !promptPart) return '<td class="num dim">' + t("common.none") + "</td>";
        const parts = [modelPart, keyPart, promptPart].filter(Boolean);
        return '<td class="num" title="' + escapeHtml(t("ses.th_switches_tip")) + '">' + parts.join(" ") + "</td>";
    }

    function sessionRow(s, compact) {
        const tr = document.createElement("tr");
        tr.title = s.id;
        if (compact) {
            tr.innerHTML = "<td>" + sessionTitleCell(s) + '</td><td>' + protoBadge(s.protocol) + '</span></td><td class="num">' + fmtW(s.contextBest ? s.contextBest.tokens : s.contextTokens) + '</td>' + savedTd(s) + '<td class="dim">' + timeAgo(s.lastSeen) + "</td>";
        } else {
            tr.innerHTML = "<td>" + sessionTitleCell(s) + '</td><td>' + (s.clientHint ? '<span class="mono small">' + escapeHtml(s.clientHint) + "</span>" : '<span class="dim">' + t("common.none") + "</span>") + '</td><td>' + protoBadge(s.protocol) + '</td><td><span class="mono dim small clip w-up">' + escapeHtml(hostOf(s.upstreamOrigin)) + '</td><td class="num">' + (s.requests ? s.requests : t("common.none")) + '</td><td class="num">' + fmtW(s.contextBest ? s.contextBest.tokens : s.contextTokens) + '</td><td class="num">' + (s.inputTokens ? fmtW(s.inputTokens) : '<span class="dim">' + t("common.none") + "</span>") + "</td>" + savedTd(s) + hitTd(s) + switchTd(s) + '<td class="num">' + (s.foldCount || 0) + '</td><td class="num">' + (s.blocks || 0) + '</td><td class="dim">' + timeAgo(s.lastSeen) + "</td>";
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
            // #2478 round 2: token figures stay the headline (owner keeps both
            // calibers; money is a list-price estimate) — priced sessions add an
            // "≈$X" clause to the sub-line instead of replacing the tokens.
            const grossSubPrized = o.netSavedUsdTotal != null
                ? "≈" + fmtUsd(o.grossSavedUsdTotal || 0) + " · " + t("ov.gross_priced", { n: o.pricedSessions || 0 })
                : "";
            $("st-gross").textContent = o.grossSavedTotal ? fmtW(o.grossSavedTotal) : t("common.none");
            $("st-gross-sub").textContent = (o.hasFoldData ? (grossSubPrized || t("ov.gross_note")) : "")
                + ((o.savedEstimated || 0) > 0 ? " · " + t("ov.saved_from_legacy", { n: fmtW(o.savedEstimated) }) : "");
            const netSubPrized = o.netSavedUsdTotal != null
                ? "≈" + fmtUsd(o.netSavedUsdTotal) + " · " + t("ov.net_priced_cost", { c: fmtUsd(o.oneTimeCostTotal || 0) })
                : "";
            $("st-netsaved").textContent = o.hasFoldData ? ((o.netSavedTotal || 0) < 0 ? "-" : "") + fmtW(Math.abs(o.netSavedTotal || 0)) : t("common.none");
            $("st-net-sub").textContent = o.hasFoldData
                ? (netSubPrized || t("ov.sub_repay", { r: fmtW(o.repayTotal || 0), s: fmtW(o.summaryCostTotal || 0) }))
                + ((o.savedEstimated || 0) > 0 ? " · " + t("ov.net_excl") : "")
                + ((o.coverageLostFrozenTotal || 0) > 0 ? " · " + t("ov.covlost_note", { n: o.coverageLostFoldTotal || 0, x: fmtW(o.coverageLostFrozenTotal) }) : "")
                : "";
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
            $("sys-version").textContent = d.version ? (d.commit ? d.version + " (" + d.commit + ")" : d.version) : "?";
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
            return true;
        } catch (e) {
            lastErrMsg = friendlyMsg(e);
            if (!silent) toast(t("toast.failed", { msg: lastErrMsg }), "err");
            return false;
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
            // #2430: siblings-only ledgers stand down — bili's own family (billion-context-pi /
            // opencode-acp) is compatible, so a pure-sibling ledger is not a warning. The events
            // stay recorded (acp_status keeps the calm #2261 footer); only the banner goes quiet.
            const sev0 = c && c.events > 0 ? bili_conflictSeverity(c) : null;
            if (c && c.events > 0 && !(sev0 && sev0.siblingOnly)) {
                cb.hidden = false;
                cb.classList.add("show");
                // #2102: attribute per kind family present; split active from historical
                // stock; detail pointer must target a cross-session surface (acp_status
                // renders conflicts for the CURRENT session only).
                // #2261: bili's own siblings (billion-context-pi / opencode-acp) are NOT
                // third-party plugins — the server counts them separately so the sentence
                // never mislabels them or commands removal of something that stands down.
                const sev = bili_conflictSeverity(c);
                // #2219: per-client remediation block between the summary line and the
                // details pointer — clients[] comes from summarizeConflicts (server-side
                // resolution); payloads without it degrade to the generic hint only.
                cb.innerHTML = '<strong>' + sev.onText + "</strong>" + t("conflict.found") + escapeHtml(sev.what) + sev.riskText + '<span class="mono">(' + bili_conflictLine(c) + ")</span>" + conflictHintBlock(c.clients) + t("conflict.where") + '<button id="conflicts-clear-btn" class="btn sm">' + t("conflict.clear_btn") + "</button>";
                cb.classList.toggle("info", !(sev.hasConfirmed && sev.active > 0));
                cb.classList.toggle("warn", sev.hasConfirmed && sev.active > 0);
                const btn = $("conflicts-clear-btn");
                if (btn) {
                    btn.addEventListener("click", async () => {
                        busy(btn, true);
                        try {
                            await json("/__bili/conflicts/clear", { method: "POST" });
                            toast(t("conflict.cleared"), "ok");
                            await loadOverview(true);
                        } catch (e) {
                            toast(e.message, "err");
                        } finally {
                            busy(btn, false);
                        }
                    });
                }
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
                if (a.pendingRestart) {
                    ab.innerHTML = '<strong>' + t("advisory.on") + '</strong> <span class="mono">[' + a.id + "]</span> " + t("advisory.restartDesc") + "<span>" + (a.reason || "") + "</span>" + t("advisory.restartHint");
                } else {
                    ab.innerHTML = '<strong>' + t("advisory.on") + '</strong> <span class="mono">[' + a.id + "]</span> " + t("advisory.desc") + "<span>" + (a.reason || "") + "</span>" + t("advisory.hint") + '<span class="mono">npm install -g billion-context@' + (a.targetFailed ? "latest" : a.target || "latest") + "</span>";
                }
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
    // #1937: the list is server-side paged & filtered — page 1 replaces the
    // cache, load-more appends the next page, search re-queries with ?q=.
    async function refreshSessions(showToast) {
        try {
            const d = await json(sessionListUrl(1));
            sessionsCache = d.sessions || [];
            sesTotal = typeof d.total === "number" ? d.total : sessionsCache.length;
            sesPage = 1;
            hiddenEmptyN = d.hiddenEmpty || 0;
            renderSessionTable();
            updateLoadMoreBtn();
            return true;
        } catch (e) {
            lastErrMsg = friendlyMsg(e);
            if (showToast) toast(t("toast.failed", { msg: lastErrMsg }), "err");
            return false;
        }
    }
    function sessionListUrl(page) {
        const input = $("ses-search");
        const q = ((input && input.value) || "").trim();
        return "/__bili/sessions?page=" + page + "&pageSize=" + SES_PAGE_SIZE + (q ? "&q=" + encodeURIComponent(q) : "");
    }
    async function loadMoreSessions() {
        const btn = $("ses-loadmore");
        if (btn) busy(btn, true);
        try {
            const next = sesPage + 1;
            const d = await json(sessionListUrl(next));
            sessionsCache = sessionsCache.concat(d.sessions || []);
            sesTotal = typeof d.total === "number" ? d.total : sessionsCache.length;
            sesPage = next;
            renderSessionTable();
            updateLoadMoreBtn();
            return true;
        } catch (e) {
            lastErrMsg = friendlyMsg(e);
            toast(t("toast.failed", { msg: lastErrMsg }), "err");
            return false;
        } finally {
            if (btn) busy(btn, false);
        }
    }
    function updateLoadMoreBtn() {
        const btn = $("ses-loadmore");
        if (!btn) return;
        btn.hidden = !(sessionsCache.length < sesTotal);
    }
    function renderSessionTable() {
        const rows = sessionsCache;
        $("ses-count").textContent = t("ses.count", { count: sesTotal });
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
        // #2065: only known roles open a block — an in-body Markdown heading
        // ("### 7.1 …" inside a user's rules blob) is content, not a divider.
        const KNOWN_ROLE = { user: 1, assistant: 1, tool: 1 };
        for (let i = start; i < lines.length; i++) {
            const l = lines[i];
            let divider = null;
            if (l.indexOf("### ") === 0) { const r = l.slice(4).trim(); if (KNOWN_ROLE[r]) divider = r; }
            if (divider) { cur = { role: divider, lines: [] }; blocks.push(cur); continue; }
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
    window.bili_renderHandoffMd = renderHandoffMd;
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
        if (d.selfHeal) kv(parts, t("det.self_heal"), (d.selfHeal.action === "degrade-to-proxy" ? t("det.self_heal_degrade_to_proxy") : t("det.self_heal_suppress_nudge")) + " · " + d.selfHeal.detected + " · " + timeAgo(d.selfHeal.since), true);
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
        // #2350: host system-prompt rewrites are a named partition of the same
        // residual (cause=prompt), not part of ledger.seam — read them directly.
        const pswRaw = d.ledger && typeof d.ledger.promptSwitches === "object" ? d.ledger.promptSwitches : null;
        if (pswRaw) {
            const pM = Number(pswRaw.missedTokens) || 0, pN = Number(pswRaw.count) || 0;
            if (pM > 0 || pN > 0) attrChips.push('<span style="color:#0969da" title="' + escapeHtml(t("det.attr_prompt_tip")) + '">' + escapeHtml(t("det.attr_prompt")) + " " + fmtW(pM) + (pN > 0 ? " ×" + pN : "") + "</span>");
        }
        if (attrChips.length) hitSub += (hitSub ? " · " : "") + attrChips.join(" · ");
        mini(parts, t("det.hit_pct"), d.cacheHitPct == null ? null : d.cacheHitPct.toFixed(1) + "%", false, hitSub, missArgs ? t("det.miss_split_line", missArgs) : "");
        mini(parts, t("ov.output_tokens"), d.outputTokens ? fmtW(d.outputTokens) : null);
        // #2478 round 2: the token figure is always primary; a priced session
        // adds "≈$X · costs" to the sub-line so both calibers stay visible.
        {
            const dSavedV = d.netSaved != null ? d.netSaved : d.tokensSaved;
            const covSub = d.coverageLostFolds ? t("det.covlost_sub", { n: d.coverageLostFolds, x: fmtW(d.coverageLostFrozenTokens || 0) }) : "";
            const dSavedSub = d.netSavedUsd != null
                ? [
                    d.priceSource ? t("ses.saved_usd_tip", { s: d.priceSource }) : t("ses.saved_usd_tip_plain"),
                    "≈" + fmtUsd(d.netSavedUsd) + " · " + t("ov.net_priced_cost", { c: fmtUsd(d.oneTimeCostUsd || 0) }),
                    covSub,
                ].filter(Boolean).join(" · ")
                : covSub;
            mini(parts, t("ov.tokens_saved"), dSavedV ? fmtW(dSavedV) : null, dSavedV > 0, dSavedSub);
        }
        mini(parts, t("det.last_input"), (d.lastInputTokens || 0) > 0 ? fmtW(d.lastInputTokens) : null);
        parts.push("</div>");
        // #1839: mark estimate-grade context numbers so a bounded local estimate
        // is never read as a measured value (the ghost-denominator incident).
        // #2117: drive the bar from contextBest — provenance-picked by the server
        // (usage > calibrated estimate > char-count upper bound) — so one value
        // never mixes calibers; the bound itself stays visible, labeled as a BOUND
        // on its own sub-line, and the calibration behind the estimate is shown
        // with its evidence instead of an unexplained number.
        const best = d.contextBest || null;
        const ctxVal = best ? best.tokens : (d.contextTokens || 0);
        const ctxMark = best
            ? ' <span class="hint">' + (best.kind === "usage" ? t("common.ctx_meas") : best.kind === "estimate" ? (best.calibrated ? t("common.ctx_est_calib") : t("common.ctx_est_raw")) : t("common.ctx_upper")) + "</span>"
            : (d.contextTokensSource === "estimate" ? ' <span class="hint">' + t("common.ctx_est") + "</span>" : "");
        if (d.contextWindow && d.contextWindow > 0) {
            const pct = Math.min(100, Math.round((ctxVal / d.contextWindow) * 100));
            const cls = pct >= 90 ? "bar-fill danger" : pct >= 70 ? "bar-fill warn" : "bar-fill";
            parts.push('<div class="bar-row"><span class="dim small">' + t("common.context") + ctxMark + " / " + t("common.window") + '</span><div class="bar-track"><div class="' + cls + '" style="width:' + pct + '%"></div></div><span class="mono small">' + fmtW(ctxVal) + " / " + fmtW(d.contextWindow) + " (" + pct + "%)" + ctxMark + "</span></div>");
            const ctxSubBits = [];
            if ((d.contextUpperTokens || 0) > 0 && (!best || best.kind !== "upper") && d.contextUpperTokens !== ctxVal) {
                ctxSubBits.push(t("det.upper_bound", { v: fmtW(d.contextUpperTokens) }));
            }
            if (d.estimateCalibration) {
                const c = d.estimateCalibration;
                ctxSubBits.push('<span title="' + escapeHtml(t("det.calib_tip", { n: c.samples, spread: c.spread.toFixed(1), origin: c.origin || "", model: c.model || "" })) + '">' + t("det.calib_chip", { k: c.factor.toFixed(2), n: c.samples, spread: c.spread.toFixed(1), origin: c.origin ? hostOf(c.origin) : "" }) + "</span>");
            }
            if (ctxSubBits.length) parts.push('<div class="dim small" style="margin-top:4px">' + ctxSubBits.join(" · ") + "</div>");
        } else {
            parts.push('<div class="dim small" style="margin-top:10px">' + t("common.context") + ctxMark + ": " + fmtW(ctxVal) + "</div>");
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
        // #2131: key switch events (relay account rotation) — fingerprints only,
        // raw credentials never leave the ledger.
        const keySw = ledger.keySwitches;
        if (keySw && keySw.count > 0 && keySw.events && keySw.events.length > 0) {
            const kHead = '<tr><th class="num">#</th><th>' + t("det.fold_time") + '</th><th class="num">' + t("det.seam_col_hit") + '</th><th class="num">' + t("det.seam_col_input") + "</th><th>" + t("det.key_fp") + "</th></tr>";
            parts.push('<details open class="seam-ev"><summary title="' + escapeHtml(t("det.key_events_tip")) + '"><b>' + t("det.key_events", { n: keySw.count }) + "</b></summary>"
                + '<div class="fold-scroll" style="max-height:320px;border:none;border-radius:0;padding:2px 8px 8px"><table class="data"><thead>' + kHead + "</thead><tbody>");
            keySw.events.forEach((ev) => {
                parts.push('<tr><td class="num">' + ev.seq + '</td><td class="num">' + (ev.at ? fmtDT(ev.at) : t("common.none")) + '</td><td class="num">' + (typeof ev.hitPct === "number" ? ev.hitPct.toFixed(1) + "%" : t("common.none")) + '</td><td class="num">' + fmtW(ev.input || 0) + '</td><td class="mono small">' + (ev.from || "?") + " → " + (ev.to || "?") + "</td></tr>");
            });
            parts.push("</tbody></table></div></details>");
        }
        // #2350: host system-prompt rewrite events — fingerprints only, raw
        // prompt text never leaves the ledger.
        const promptSw = ledger.promptSwitches;
        if (promptSw && promptSw.count > 0 && promptSw.events && promptSw.events.length > 0) {
            const pHead = '<tr><th class="num">#</th><th>' + t("det.fold_time") + '</th><th class="num">' + t("det.seam_col_hit") + '</th><th class="num">' + t("det.seam_col_input") + "</th><th>" + t("det.prompt_fp") + "</th></tr>";
            parts.push('<details open class="seam-ev"><summary title="' + escapeHtml(t("det.prompt_events_tip")) + '"><b>' + t("det.prompt_events", { n: promptSw.count }) + "</b></summary>"
                + '<div class="fold-scroll" style="max-height:320px;border:none;border-radius:0;padding:2px 8px 8px"><table class="data"><thead>' + pHead + "</thead><tbody>");
            promptSw.events.forEach((ev) => {
                parts.push('<tr><td class="num">' + ev.seq + '</td><td class="num">' + (ev.at ? fmtDT(ev.at) : t("common.none")) + '</td><td class="num">' + (typeof ev.hitPct === "number" ? ev.hitPct.toFixed(1) + "%" : t("common.none")) + '</td><td class="num">' + fmtW(ev.input || 0) + '</td><td class="mono small">' + (ev.from || "?") + " → " + (ev.to || "?") + "</td></tr>");
            });
            parts.push("</tbody></table></div></details>");
        }
        // #2131: per-call body-stability proof (digest vs previous settled request).
        // Defensive reads — servers predating #2131 carry no ledger.stability, and an
        // unpaired shape (paired=0) must render nothing.
        const stRaw = ledger.stability && typeof ledger.stability === "object" ? ledger.stability : null;
        if (stRaw && (Number(stRaw.paired) || 0) > 0) {
            const st = {
                paired: Number(stRaw.paired) || 0,
                equal: Number(stRaw.equal) || 0,
                diverged: Number(stRaw.diverged) || 0,
                head: Number(stRaw.head) || 0,
                append: Number(stRaw.append) || 0,
                mid: Number(stRaw.mid) || 0,
                unknownOffset: Number(stRaw.unknownOffset) || 0,
                sizeBuckets: Array.isArray(stRaw.sizeBuckets) ? stRaw.sizeBuckets : [],
                gapSplit: stRaw.gapSplit && typeof stRaw.gapSplit === "object" ? stRaw.gapSplit : null,
            };
            const divParts = [];
            if (st.equal > 0) divParts.push('<span class="dim">' + escapeHtml(t("det.stab_identical")) + " <b>" + st.equal + "</b></span>");
            if (st.head > 0) divParts.push('<span style="color:#bf8700">' + escapeHtml(t("det.stab_head")) + " <b>" + st.head + "</b></span>");
            if (st.append > 0) divParts.push('<span style="color:#57606a">' + escapeHtml(t("det.stab_append")) + " <b>" + st.append + "</b></span>");
            if (st.mid > 0) divParts.push('<span style="color:#cf222e">' + escapeHtml(t("det.stab_mid")) + " <b>" + st.mid + "</b></span>");
            if (st.unknownOffset > 0) divParts.push('<span class="dim">' + escapeHtml(t("det.stab_unknown")) + " <b>" + st.unknownOffset + "</b></span>");
            let stabBody = '<div class="mono small" style="line-height:1.8">' + escapeHtml(t("det.stab_pairs", { n: st.paired })) + ": " + (st.diverged > 0 ? '<span style="color:' + (st.mid > 0 ? "#cf222e" : "inherit") + '">' + st.diverged + " ↓</span>" : "0") + (divParts.length ? " — " + divParts.join(" · ") : "") + "</div>";
            const sb = st.sizeBuckets.filter((b) => b && (Number(b.n) || 0) >= 3);
            if (sb.length >= 2) {
                stabBody += '<div class="dim small mono" style="margin-top:4px">' + escapeHtml(t("det.stab_size")) + ": " + sb.map((b) => Math.round(((Number(b.lo) || 0) / 1000)) + "K=" + (Number(b.hitMedian) || 0).toFixed(0) + "%").join("  ") + "</div>";
            }
            if (st.gapSplit && st.gapSplit.lowHitMedGapMs != null && st.gapSplit.highHitMedGapMs != null) {
                stabBody += '<div class="dim small mono" style="margin-top:4px">' + escapeHtml(t("det.stab_gap", { a: ((Number(st.gapSplit.lowHitMedGapMs) || 0) / 1000).toFixed(1), b: ((Number(st.gapSplit.highHitMedGapMs) || 0) / 1000).toFixed(1) })) + "</div>";
            }
            parts.push('<details open class="seam-ev"><summary title="' + escapeHtml(t("det.stab_tip")) + '"><b>' + escapeHtml(t("det.stab_title")) + "</b></summary>"
                + '<div style="padding:4px 8px 10px">' + stabBody + "</div></details>");
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
        if (Array.isArray(d.conflicts) && d.conflicts.length > 0) {
            // #2102: per-session evidence rows — the banner aggregates across sessions,
            // so this page is where its detail pointer lands.
            parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.conflicts_title") + '</span><span class="hint">' + t("det.conflicts_hint") + '</span></div><div class="card-b">');
            // #2219: per-client remediation for THIS session — conflictClient is
            // resolved server-side (sessions-data), unknown/absent → generic hint.
            parts.push('<div class="mono small dim" style="margin-bottom:8px">' + escapeHtml(conflictHintLine(d.conflictClient)) + "</div>");
            for (const ev of d.conflicts.slice(-10).reverse()) {
                parts.push('<div class="alert-row"><span class="mono">' + escapeHtml(fmtDT(ev.at)) + ' · ' + escapeHtml(ev.kind) + "</span><span>" + escapeHtml(ev.detail) + "</span></div>");
            }
            if (d.conflicts.length > 10) parts.push('<div class="dim small">' + t("det.conflicts_more", { n: d.conflicts.length - 10 }) + "</div>");
            parts.push('<div style="margin-top:10px"><button id="session-conflicts-clear" class="btn sm">' + t("det.conflicts_clear") + "</button></div>");
            parts.push("</div></div>");
        }
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
            const cc = $("session-conflicts-clear");
            if (cc) {
                cc.addEventListener("click", async () => {
                    busy(cc, true);
                    try {
                        await json("/__bili/conflicts/clear?session=" + encodeURIComponent(id), { method: "POST" });
                        toast(t("det.conflicts_cleared"), "ok");
                        await loadDetail(id);
                    } catch (e) {
                        toast(e.message, "err");
                    } finally {
                        busy(cc, false);
                    }
                });
            }
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
            if (fe) cfgSavedSnap = fe.value;
            hydrateQuickConfig(cfg);
            hydrateSummaryConfig(cfg);
            refreshDirtyFlag();
            const broken = Boolean(cfg.parseError);
            ["cfg-file-edit", "save-file", "save-upstream", "save-quick", "save-summary"].forEach((id) => { const el = $(id); if (el) el.disabled = broken; });
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
            void loadResign();
        } catch (e) {
            toast(t("toast.failed", { msg: e.message }), "err");
        }
    }
    // #2090 plan A: read-only "Signed upstreams" card — every known/observed
    // signature scheme with its effective policy, remembered refusals, and —
    // for the BUILT-IN scheme only — a copy-ready passthrough snippet (other
    // schemes show an awaiting-re-signer hint: no config can pass them
    // through, #2090 owner ruling).
    async function loadResign() {
        const box = $("resign-body");
        if (!box) return;
        let data;
        try {
            data = await json("/__bili/resign");
        } catch (e) {
            const el = document.createElement("div");
            el.className = "dim small";
            el.textContent = t("cfg.resign_none") + " (" + e.message + ")";
            box.replaceChildren(el);
            return;
        }
        box.innerHTML = "";
        const schemes = data.schemes && typeof data.schemes === "object" ? data.schemes : {};
        const pending = data.pending && typeof data.pending === "object" ? data.pending : {};
        let anyPending = false;
        for (const name of Object.keys(schemes).sort()) {
            const s = schemes[name];
            if (!s || typeof s !== "object") continue;
            anyPending = anyPending || Boolean(pending[name]);
            const row = document.createElement("div");
            row.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap";
            const label = document.createElement("span");
            label.className = "mono small";
            label.textContent = s.builtIn && s.known ? t("cfg.resign_builtin", { scheme: name, label: s.known.label }) : name;
            row.appendChild(label);
            const badge = document.createElement("span");
            badge.className = "badge ";
            const effectivePassthrough = Boolean(s.builtIn && s.passthrough);
            badge.textContent = !s.enabled ? t("cfg.resign_disabled") : effectivePassthrough ? t("cfg.resign_passthrough") : t("cfg.resign_refusing");
            badge.classList.add(effectivePassthrough ? "ok" : s.enabled ? "warn" : "disk");
            row.appendChild(badge);
            const entry = pending[name];
            if (entry && typeof entry === "object") {
                const meta = document.createElement("span");
                meta.className = "dim small";
                meta.textContent = t("cfg.resign_row", { origin: entry.origin || "—", count: entry.count ?? 1, firstSeen: String(entry.firstSeen ?? "").slice(0, 10) });
                row.appendChild(meta);
                if (s.enabled && !effectivePassthrough) {
                    if (s.builtIn) {
                        const btn = document.createElement("button");
                        btn.className = "btn sm copy-btn";
                        btn.setAttribute("data-copy", JSON.stringify({ resign: { [name]: { passthrough: true } } }, null, 0));
                        btn.setAttribute("title", t("cfg.resign_copy_hint"));
                        const sp = document.createElement("span");
                        sp.textContent = t("common.copy");
                        btn.appendChild(sp);
                        row.appendChild(btn);
                    } else {
                        const hint = document.createElement("span");
                        hint.className = "dim small";
                        hint.textContent = t("cfg.resign_awaiting");
                        row.appendChild(hint);
                    }
                }
            }
            box.appendChild(row);
        }
        if (!anyPending && Object.keys(pending).length === 0) {
            const el = document.createElement("div");
            el.className = "dim small";
            el.textContent = t("cfg.resign_none");
            box.appendChild(el);
        }
    }
    function hydrateQuickConfig(cfg) {
        const box = $("quick-fields");
        if (!box) return;
        box.innerHTML = "";
        const fe = $("cfg-file-edit");
        let draft = {};
        try { draft = JSON.parse(fe && fe.value ? fe.value : "{}"); if (!draft || typeof draft !== "object" || Array.isArray(draft)) draft = {}; } catch (e) { return; }
        function compressOf(d) { return (d.compress && typeof d.compress === "object" && !Array.isArray(d.compress)) ? d.compress : null; }
        const NUDGE_DEFAULT = 50000, NUDGE_STEP = 5000, NUDGE_LOW = 20000, NUDGE_HIGH = 100000;
        const PRM_KERNEL_DEFAULT = 5;
        const brokenNote = document.createElement("div");
        brokenNote.style.cssText = "min-height:16px;font-size:12px;color:#cf222e";
        box.appendChild(brokenNote);
        const qCtrls = [];
        function quickBroken(on) {
            brokenNote.textContent = on ? t("cfg.q_parse_err") : "";
            qCtrls.forEach((el) => { el.disabled = !!on; });
        }
        function freshDraft() {
            try {
                const p = JSON.parse(fe && fe.value ? fe.value : "{}");
                if (!p || typeof p !== "object" || Array.isArray(p)) return {};
                return p;
            } catch (e) { quickBroken(true); return null; }
        }
        function syncAll() {
            const cp = compressOf(draft);
            dbg.inp.checked = draft.debug === true;
            ptRow.inp.checked = draft.passthrough === true;
            dsgRow.inp.checked = Boolean(draft.dsh && draft.dsh.allowDshCompaction === true);
            dsgWarnNote.hidden = !(draft.dsh && draft.dsh.allowDshCompaction === true);
            const pv = (cp && typeof cp.promptPack === "string") ? cp.promptPack : "default";
            while (packSel.options.length > 0) packSel.removeChild(packSel.lastChild);
            ["default", "lean"].forEach((name) => {
                const o = document.createElement("option");
                o.value = name;
                o.textContent = name;
                packSel.appendChild(o);
            });
            if (pv !== "default" && pv !== "lean") {
                const o = document.createElement("option");
                o.value = pv;
                o.textContent = pv + " *";
                packSel.appendChild(o);
            }
            packSel.value = pv;
            updatePackNote();
            nudge.value = String(cp && typeof cp.nudgeGrowthTokens === "number" ? cp.nudgeGrowthTokens : NUDGE_DEFAULT);
            updateNudgeNote();
            refreshTierInputs();
            prm.value = String(cp && typeof cp.preserveRecentMessages === "number" ? cp.preserveRecentMessages : PRM_KERNEL_DEFAULT);
            ptInp.value = (cp && Array.isArray(cp.protectedTools)) ? cp.protectedTools.join(", ") : "";
            const nv = (cp && Array.isArray(cp.neverPreserveRecentTools)) ? cp.neverPreserveRecentTools : null;
            neInp.value = nv ? nv.filter((x) => typeof x === "string").join(", ") : "";
            const m = (draft.mitm && typeof draft.mitm === "object" && !Array.isArray(draft.mitm)) ? draft.mitm : null;
            mitmInp.value = (m && Array.isArray(m.domains)) ? m.domains.filter((x) => typeof x === "string").join(", ") : "";
        }
        function commit(mutate) {
            const fresh = freshDraft();
            if (fresh === null) return;
            draft = fresh;
            mutate(draft);
            if (fe) fe.value = JSON.stringify(draft, null, 2);
            quickBroken(false);
            syncAll();
            refreshDirtyFlag();
        }
        function row(id, label) {
            const w = document.createElement("div");
            w.style.cssText = "display:flex;gap:12px;align-items:center;flex-wrap:wrap";
            const lab = document.createElement("label");
            lab.style.cssText = "flex:0 1 auto;max-width:520px";
            const ctl = document.createElement("div");
            ctl.style.flex = "0 0 auto";
            const inp = document.createElement("input");
            inp.type = "checkbox";
            inp.id = id;
            lab.appendChild(inp);
            lab.append(document.createTextNode(" \u2009" + label));
            w.appendChild(lab);
            w.appendChild(ctl);
            box.appendChild(w);
            return { inp, ctl };
        }
        function textRow(id, label, placeholder) {
            const w = document.createElement("div");
            w.style.cssText = "display:flex;gap:12px;align-items:center;flex-wrap:wrap";
            const lab = document.createElement("label");
            lab.htmlFor = id;
            lab.style.cssText = "flex:0 1 auto;max-width:520px";
            lab.textContent = label;
            const inp = document.createElement("input");
            inp.type = "text";
            inp.id = id;
            inp.className = "field-input mono";
            inp.style.flex = "1 1 320px";
            inp.spellcheck = false;
            if (placeholder) inp.placeholder = placeholder;
            w.appendChild(lab);
            w.appendChild(inp);
            box.appendChild(w);
            return inp;
        }
        const dbg = row("quick-debug", t("cfg.q_debug"));
        qCtrls.push(dbg.inp);
        dbg.inp.addEventListener("change", () => commit((d) => { if (dbg.inp.checked) d.debug = true; else delete d.debug; }));
        const ptRow = row("quick-pt", t("cfg.q_passthrough"));
        qCtrls.push(ptRow.inp);
        ptRow.inp.addEventListener("change", () => commit((d) => { if (ptRow.inp.checked) d.passthrough = true; else delete d.passthrough; }));
        void ptRow.ctl;
        // #2028: env BILI_ALLOW_DSH_COMPACTION outranks the file — keep the control out
        // of qCtrls in that case so quickBroken's blanket enable/disable never re-enables it.
        const dsgEnvForced = Boolean(cfg.allowDshCompaction && cfg.allowDshCompaction.source === "env");
        const dsgRow = row("quick-dsg", t("cfg.q_dsh_compact"));
        if (!dsgEnvForced) qCtrls.push(dsgRow.inp);
        const dsgWarnNote = document.createElement("div");
        dsgWarnNote.style.cssText = "margin:-6px 0 4px;font-size:12px;color:#9a6700";
        dsgWarnNote.textContent = t("cfg.q_dsh_compact_warn");
        dsgWarnNote.hidden = true;
        box.appendChild(dsgWarnNote);
        const dsgEnvNote = document.createElement("div");
        dsgEnvNote.style.cssText = "margin:-6px 0 4px;font-size:12px;color:#57606a";
        dsgEnvNote.textContent = t("cfg.q_dsh_compact_env");
        dsgEnvNote.hidden = true;
        box.appendChild(dsgEnvNote);
        dsgRow.inp.addEventListener("change", () => commit((d) => {
            if (dsgRow.inp.checked) { if (!d.dsh || typeof d.dsh !== "object") d.dsh = {}; d.dsh.allowDshCompaction = true; }
            else { if (d.dsh) { delete d.dsh.allowDshCompaction; if (Object.keys(d.dsh).length === 0) delete d.dsh; } }
        }));
        if (dsgEnvForced) { dsgRow.inp.disabled = true; dsgEnvNote.hidden = false; }
        const packSel = document.createElement("select");
        packSel.className = "field-input mono";
        qCtrls.push(packSel);
        const pw = document.createElement("div");
        pw.style.cssText = "display:flex;gap:12px;align-items:center;flex-wrap:wrap";
        const plab = document.createElement("label");
        plab.htmlFor = "quick-pack";
        plab.style.cssText = "flex:0 1 auto;max-width:520px";
        plab.textContent = t("cfg.q_pack");
        pw.appendChild(plab);
        pw.appendChild(packSel);
        box.appendChild(pw);
        const packNote = document.createElement("div");
        packNote.style.cssText = "margin:-6px 0 4px;font-size:12px;color:#57606a";
        function updatePackNote() {
            if (packSel.value === "lean") packNote.textContent = t("cfg.q_pack_lean_desc");
            else if (packSel.value === "default") packNote.textContent = t("cfg.q_pack_default_desc");
            else packNote.textContent = t("cfg.q_pack_custom");
        }
        box.appendChild(packNote);
        packSel.addEventListener("change", () => commit((d) => {
            if (!compressOf(d)) d.compress = {};
            if (packSel.value === "default") delete d.compress.promptPack; else d.compress.promptPack = packSel.value;
        }));
        const nudge = document.createElement("input");
        nudge.type = "number";
        nudge.id = "quick-nudge";
        nudge.className = "field-input mono";
        nudge.style.width = "140px";
        nudge.min = "1";
        nudge.step = "1000";
        nudge.spellcheck = false;
        qCtrls.push(nudge);
        const nnote = document.createElement("div");
        nnote.style.cssText = "min-height:18px;font-size:12px;margin-top:2px";
        function updateNudgeNote() {
            const v = parseInt(nudge.value, 10);
            nnote.textContent = "";
            nnote.style.color = "";
            if (!isNaN(v)) {
                if (v < NUDGE_LOW) { nnote.textContent = t("cfg.q_nudge_low"); nnote.style.color = "#cf222e"; }
                else if (v > NUDGE_HIGH) { nnote.textContent = t("cfg.q_nudge_high"); nnote.style.color = "#bf8700"; }
            }
        }
        function syncNudge() {
            updateNudgeNote();
            commit((d) => {
                if (!compressOf(d)) d.compress = {};
                const v = parseInt(nudge.value, 10);
                if (!isNaN(v) && v > 0 && v !== NUDGE_DEFAULT) d.compress.nudgeGrowthTokens = v; else delete d.compress.nudgeGrowthTokens;
            });
            refreshTierInputs();
        }
        function nudgeBtn(label, delta) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "btn sm";
            b.textContent = label;
            b.title = t("cfg.q_nudge_step");
            b.addEventListener("click", () => { const cur = parseInt(nudge.value, 10); const base = isNaN(cur) ? NUDGE_DEFAULT : cur; nudge.value = String(Math.max(1, base + delta)); syncNudge(); });
            return b;
        }
        const nrow = document.createElement("div");
        nrow.style.cssText = "display:flex;gap:12px;align-items:center;flex-wrap:wrap";
        const nlab = document.createElement("label");
        nlab.htmlFor = "quick-nudge";
        nlab.style.cssText = "flex:0 1 auto;max-width:520px";
        nlab.textContent = t("cfg.q_nudge");
        const ng = document.createElement("div");
        ng.style.cssText = "display:flex;gap:6px;align-items:center";
        ng.appendChild(nudgeBtn("\u2212", -NUDGE_STEP));
        ng.appendChild(nudge);
        ng.appendChild(nudgeBtn("+", NUDGE_STEP));
        nrow.appendChild(nlab);
        nrow.appendChild(ng);
        const nwrap = document.createElement("div");
        nwrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
        nwrap.appendChild(nrow);
        nwrap.appendChild(nnote);
        box.appendChild(nwrap);
        nudge.addEventListener("change", syncNudge);
        function tierDerivedOf(cp) {
            const base = (cp && typeof cp.nudgeGrowthTokens === "number") ? cp.nudgeGrowthTokens : NUDGE_DEFAULT;
            const m = Math.round(base * 1.5);
            return { t1: base, t2: m, t3: m };
        }
        function refreshTierInputs() {
            const cp = compressOf(draft);
            const tt = (cp && cp.tierNudgeTokens && typeof cp.tierNudgeTokens === "object" && !Array.isArray(cp.tierNudgeTokens)) ? cp.tierNudgeTokens : null;
            const dv = tierDerivedOf(cp);
            ["t1", "t2", "t3"].forEach((k) => { tierInps[k].value = String((tt && typeof tt[k] === "number") ? tt[k] : dv[k]); });
        }
        const tierInps = {};
        ["t1", "t2", "t3"].forEach((k) => {
            const inp = document.createElement("input");
            inp.type = "number";
            inp.id = "quick-tiers-" + k;
            inp.className = "field-input mono";
            inp.style.width = "84px";
            inp.min = "1";
            inp.step = String(NUDGE_STEP);
            inp.spellcheck = false;
            inp.placeholder = t("cfg.q_tiers_auto");
            qCtrls.push(inp);
            tierInps[k] = inp;
        });
        tierInps.t1.title = t("cfg.q_tiers_tip_t1");
        tierInps.t2.title = t("cfg.q_tiers_tip_t2");
        tierInps.t3.title = t("cfg.q_tiers_tip_t3");
        function syncTiers() {
            commit((d) => {
                if (!compressOf(d)) d.compress = {};
                const dv = tierDerivedOf(compressOf(d));
                const next = {};
                ["t1", "t2", "t3"].forEach((k) => {
                    const v = parseInt(tierInps[k].value, 10);
                    if (isNaN(v) || v < 1) { tierInps[k].value = String(dv[k]); return; }
                    if (v !== dv[k]) next[k] = v;
                });
                if (Object.keys(next).length === 0) delete d.compress.tierNudgeTokens; else d.compress.tierNudgeTokens = next;
            });
        }
        function tierBtn(k, delta) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "btn sm";
            b.textContent = delta > 0 ? "+" : "\u2212";
            b.title = t("cfg.q_tiers_step");
            b.addEventListener("click", () => { const cur = parseInt(tierInps[k].value, 10); const base = isNaN(cur) ? tierDerivedOf(compressOf(draft))[k] : cur; tierInps[k].value = String(Math.max(1, base + delta)); syncTiers(); });
            return b;
        }
        const trow = document.createElement("div");
        trow.style.cssText = "display:flex;gap:12px;align-items:center;flex-wrap:wrap";
        const tlab = document.createElement("label");
        tlab.htmlFor = "quick-tiers-t1";
        tlab.style.cssText = "flex:0 1 auto;max-width:520px";
        tlab.textContent = t("cfg.q_tiers");
        const tg = document.createElement("div");
        tg.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap";
        ["t1", "t2", "t3"].forEach((k, i) => {
            if (i > 0) tg.appendChild(document.createTextNode("/"));
            const tag = document.createElement("span");
            tag.style.cssText = "font-size:12px;color:#57606a";
            tag.textContent = k.toUpperCase();
            tg.appendChild(tag);
            tg.appendChild(tierBtn(k, -NUDGE_STEP));
            tg.appendChild(tierInps[k]);
            tg.appendChild(tierBtn(k, NUDGE_STEP));
        });
        trow.appendChild(tlab);
        trow.appendChild(tg);
        const twrap = document.createElement("div");
        twrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
        twrap.appendChild(trow);
        const tnote = document.createElement("div");
        tnote.style.cssText = "font-size:12px;color:#57606a";
        tnote.textContent = t("cfg.q_tiers_desc");
        twrap.appendChild(tnote);
        box.appendChild(twrap);
        ["t1", "t2", "t3"].forEach((k) => tierInps[k].addEventListener("change", syncTiers));
        const ptInp = textRow("quick-ptools", t("cfg.q_ptools"), t("cfg.q_ptools_ph"));
        qCtrls.push(ptInp);
        const ptWarn = document.createElement("div");
        ptWarn.style.cssText = "font-size:12px;color:#57606a";
        ptWarn.textContent = t("cfg.q_ptools_warn");
        ptInp.parentElement.appendChild(ptWarn);
        ptInp.addEventListener("change", () => commit((d) => {
            const list = ptInp.value.split(",").map((s) => s.trim()).filter(Boolean);
            if (!compressOf(d)) d.compress = {};
            if (list.length === 0) delete d.compress.protectedTools; else d.compress.protectedTools = list;
        }));
        const prm = textRow("quick-prm", t("cfg.q_prm"), t("cfg.q_prm_ph"));
        prm.type = "number";
        prm.min = "1";
        prm.style.flex = "0 0 140px";
        qCtrls.push(prm);
        prm.addEventListener("change", () => commit((d) => {
            if (!compressOf(d)) d.compress = {};
            const v = parseInt(prm.value, 10);
            if (!isNaN(v) && v > 0 && v !== PRM_KERNEL_DEFAULT) d.compress.preserveRecentMessages = v;
            else { delete d.compress.preserveRecentMessages; prm.value = String(PRM_KERNEL_DEFAULT); }
        }));
        const NEVER_DEFAULT = ["decompress", "search_context", "read", "bash"];
        const neInp = textRow("quick-never", t("cfg.q_never"), t("cfg.q_never_ph"));
        qCtrls.push(neInp);
        const neNote = document.createElement("div");
        neNote.style.cssText = "font-size:12px;color:#57606a";
        neNote.textContent = t("cfg.q_never_note");
        neInp.parentElement.appendChild(neNote);
        neInp.addEventListener("change", () => commit((d) => {
            const list = neInp.value.split(",").map((s) => s.trim()).filter(Boolean);
            const sameAsDefault = list.length === NEVER_DEFAULT.length && NEVER_DEFAULT.every((x) => list.indexOf(x) >= 0);
            if (!compressOf(d)) d.compress = {};
            if (list.length === 0 || sameAsDefault) delete d.compress.neverPreserveRecentTools; else d.compress.neverPreserveRecentTools = list;
        }));
        const mitmInp = textRow("quick-mitm", t("cfg.q_mitm"), t("cfg.q_mitm_ph"));
        qCtrls.push(mitmInp);
        mitmInp.addEventListener("change", () => commit((d) => {
            const domains = mitmInp.value.split(",").map((s) => s.trim()).filter(Boolean);
            if (domains.length === 0) { delete d.mitm; return; }
            if (!d.mitm || typeof d.mitm !== "object" || Array.isArray(d.mitm)) d.mitm = {};
            d.mitm.domains = domains;
        }));
        const moreA = document.createElement("a");
        moreA.href = t("cfg.q_more_url");
        moreA.target = "_blank";
        moreA.rel = "noopener";
        moreA.style.cssText = "font-size:12px;color:#0969da";
        moreA.textContent = t("cfg.q_more");
        box.appendChild(moreA);
        if (fe) fe.addEventListener("input", () => { quickBroken(freshDraft() === null); refreshDirtyFlag(); });
        syncAll();
    }
    function hydrateSummaryConfig(cfg) {
        const box = $("summary-fields"), fe = $("cfg-file-edit");
        if (!box || !fe) return;
        const status = Object.assign({}, cfg.externalSummaryCredentials || {});
        function read() {
            const draft = JSON.parse(fe.value || "{}");
            if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error(t("cfg.invalid_json"));
            return draft;
        }
        function mutate(fn, repaint) {
            try {
                const draft = read();
                if (!draft.compress) draft.compress = {};
                if (!draft.compress.externalSummary) draft.compress.externalSummary = { enabled: false, targets: [] };
                fn(draft.compress.externalSummary);
                fe.value = JSON.stringify(draft, null, 2);
                refreshDirtyFlag();
                if (repaint) render();
            } catch (e) { toast(e.message, "err"); }
        }
        function button(parent, label, action, symbol) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "btn sm";
            btn.title = label;
            btn.setAttribute("aria-label", label);
            if (symbol) btn.innerHTML = symbol; else btn.textContent = label;
            btn.addEventListener("click", action);
            parent.appendChild(btn);
            return btn;
        }
        function field(parent, id, label, value, change, type, options) {
            const lab = document.createElement("label");
            lab.htmlFor = id;
            const title = document.createElement("span"); title.textContent = label;
            lab.appendChild(title);
            const inp = document.createElement(options ? "select" : "input");
            inp.id = id; inp.className = "field-input";
            if (options) options.forEach((v) => { const opt = document.createElement("option"); opt.value = typeof v === "object" ? v.value : v; opt.textContent = typeof v === "object" ? v.label : v; inp.appendChild(opt); });
            else { inp.type = type || "text"; if (type === "number") { inp.min = "1"; inp.step = "1"; } }
            inp.value = value === undefined ? "" : String(value);
            inp.addEventListener("change", () => change(type === "number" ? Number(inp.value) : inp.value));
            lab.appendChild(inp); parent.appendChild(lab);
            return inp;
        }
        function render() {
            box.replaceChildren();
            let draft;
            try { draft = read(); } catch (e) { box.textContent = t("cfg.invalid_json"); return; }
            const s = (draft.compress && draft.compress.externalSummary) || { enabled: false, targets: [] };
            if (s.invalid || !Array.isArray(s.targets || [])) { box.textContent = t("summary.invalid"); return; }
            // Recipes = named (non-URL) providers entries carrying dial fields;
            // the raw editor below owns their bodies, this panel only wires the
            // chain (references + budget) and the credential keys they cite.
            const providers = draft.providers && typeof draft.providers === "object" && !Array.isArray(draft.providers) ? draft.providers : {};
            const recipes = Object.keys(providers).filter((name) => name.indexOf("http://") !== 0 && name.indexOf("https://") !== 0 && providers[name] && typeof providers[name] === "object" && !Array.isArray(providers[name]) && (providers[name].baseUrl !== undefined || providers[name].api !== undefined)).map((name) => ({ name, recipe: providers[name] }));
            const options = [];
            recipes.forEach(({ name, recipe }) => { Object.keys(recipe.models && typeof recipe.models === "object" ? recipe.models : {}).forEach((model) => options.push(name + "/" + model)); });
            // #2336: agent-registry fallback — providers the host agent
            // reported live (dialing lives in its memory, not in this file).
            // Offered with an agent marker so the operator knows editing them
            // here is not possible; the ref itself saves as provider/model.
            (Array.isArray(cfg.agentProviders) ? cfg.agentProviders : []).forEach((group) => {
                (group.providers || []).forEach((p) => {
                    (p.models || []).forEach((model) => {
                        const ref = p.name + "/" + model;
                        if (options.some((o) => (typeof o === "object" ? o.value : o) === ref)) return;
                        options.push({ value: ref, label: ref + " (" + (group.agent || "agent") + ")" });
                    });
                });
            });
            const head = document.createElement("div"); head.className = "summary-actions";
            const plain = (v) => typeof v === "object" ? v.value : v;
            const enabled = document.createElement("label");
            const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.id = "summary-enabled"; toggle.checked = s.enabled === true;
            toggle.disabled = !!cfg.parseError;
            toggle.addEventListener("change", () => mutate((v) => { v.enabled = toggle.checked; }));
            enabled.append(toggle, document.createTextNode(" " + t("summary.enabled"))); head.appendChild(enabled);
            const add = button(head, t("summary.add"), () => mutate((v) => {
                if (!v.targets) v.targets = [];
                v.targets.push(plain(options.find((option) => v.targets.indexOf(plain(option)) === -1)) || "");
            }, true));
            add.disabled = !!cfg.parseError || (s.targets || []).length >= 16 || (options.length === 0 && (s.targets || []).length > 0);
            box.appendChild(head);
            if (options.length === 0) {
                const hint = document.createElement("p"); hint.textContent = t("summary.no_recipes"); box.appendChild(hint);
            }
            (s.targets || []).forEach((ref, i) => {
                const item = document.createElement("fieldset"); item.className = "summary-target";
                const legend = document.createElement("legend"); legend.textContent = String(i + 1) + ". " + (ref || "—"); item.appendChild(legend);
                const fields = document.createElement("div"); fields.className = "summary-grid";
                const refOptions = options.slice();
                if (ref && refOptions.map(plain).indexOf(ref) === -1) refOptions.unshift(ref);
                const set = (value) => mutate((v) => { v.targets[i] = String(value).trim(); }, true);
                field(fields, "summary-" + i + "-ref", t("summary.ref"), ref, set, refOptions.length ? null : "text", refOptions.length ? refOptions : undefined);
                item.appendChild(fields);
                const actions = document.createElement("div"); actions.className = "summary-actions";
                button(actions, t("summary.up"), () => mutate((v) => { const prev = v.targets[i - 1]; v.targets[i - 1] = v.targets[i]; v.targets[i] = prev; }, true), "&#8593;").disabled = i === 0;
                button(actions, t("summary.down"), () => mutate((v) => { const next = v.targets[i + 1]; v.targets[i + 1] = v.targets[i]; v.targets[i] = next; }, true), "&#8595;").disabled = i === s.targets.length - 1;
                button(actions, t("summary.remove"), () => mutate((v) => { v.targets.splice(i, 1); }, true), "&#215;");
                item.appendChild(actions); item.disabled = !!cfg.parseError; box.appendChild(item);
            });
            if (recipes.length) {
                const creds = document.createElement("div"); creds.className = "summary-creds";
                const title = document.createElement("h4"); title.textContent = t("summary.credentials"); creds.appendChild(title);
                recipes.forEach(({ name, recipe }) => {
                    const row = document.createElement("div"); row.className = "summary-actions";
                    const ref = typeof recipe.credentialRef === "string" ? "secret:" + recipe.credentialRef : typeof recipe.apiKeyEnv === "string" ? "env:" + recipe.apiKeyEnv : null;
                    const label = document.createElement("span"); label.textContent = name + " · " + (ref || "—"); row.appendChild(label);
                    const badge = document.createElement("span"); badge.className = "badge " + (ref && status[ref] ? "ok" : "disk"); badge.textContent = ref && status[ref] ? t("summary.key_set") : t("summary.key_missing"); row.appendChild(badge);
                    if (ref && ref.indexOf("secret:") === 0) {
                        const key = field(row, "summary-key-" + name, t("summary.key"), "", () => {}, "password");
                        key.autocomplete = "new-password"; key.disabled = !!cfg.parseError;
                        async function saveKey(btn, value) {
                            busy(btn, true);
                            try {
                                const result = await json("/__bili/external-summary/credential", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: recipe.credentialRef, key: value }) });
                                key.value = ""; status[ref] = result.configured;
                                render();
                                toast(t("summary.key_saved"), "ok");
                            } catch (e) { toast(e.message, "err"); } finally { busy(btn, false); }
                        }
                        const save = button(row, t("summary.key_save"), () => saveKey(save, key.value));
                        const del = button(row, t("summary.key_delete"), () => { if (confirm(t("summary.key_delete") + "?")) saveKey(del, null); });
                        save.disabled = del.disabled = !!cfg.parseError;
                    }
                    creds.appendChild(row);
                });
                box.appendChild(creds);
            }
            const budget = document.createElement("div"); budget.className = "summary-grid";
            [["totalTimeoutMs", t("summary.total"), 50000], ["targetTimeoutMs", t("summary.timeout"), 25000], ["maxSummaryBytes", t("summary.bytes"), 65536]].forEach(([key, label, fallback]) => {
                field(budget, "summary-" + key, label, s.budget && s.budget[key] || fallback, (value) => mutate((v) => { if (!v.budget) v.budget = {}; v.budget[key] = value; }), "number").disabled = !!cfg.parseError;
            });
            box.appendChild(budget);
        }
        render();
        fe.onchange = render;
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
        if (!qEl || !$("log-body")) return true;
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
            return true;
        } catch (e) { /* the log endpoint is best-effort; stay quiet */ lastErrMsg = friendlyMsg(e); return false; }
    }

    function bindLauncherNotes() {
        // Per-client launch notes (from the README launcher table) as hover tooltips.
        const N = { pi: t("con.note_pi"), codex: t("con.note_codex"), claude: t("con.note_claude"), omp: t("con.note_omp"), opencode: t("con.note_opencode"), hermes: t("con.note_hermes"), dsh: t("con.note_dsh"), codebuddy: t("con.note_codebuddy"), qoder: t("con.note_qoder"), trae: t("con.note_trae"), jcode: t("con.note_jcode"), kimi: t("con.note_kimi"), gemini: t("con.note_gemini"), iflow: t("con.note_iflow"), qwen: t("con.note_qwen"), antigravity: t("con.note_antigravity"), mcode: t("con.note_mcode"), aider: t("con.note_aider"), copilot: t("con.note_copilot"), amp: t("con.note_amp"), goose: t("con.note_goose") };
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
            // #2321: a ?lang= pin would silently re-force the old language on a
            // plain reload — drop it so the manual choice sticks.
            if (/[?&]lang=[^&]*/i.test(location.search)) {
                const qs = location.search.slice(1).replace(/(?:^|&)lang=[^&]*/i, "").replace(/^[?&]+|[?&]+$/g, "");
                location.href = location.pathname + (qs ? "?" + qs : "") + location.hash;
            } else {
                location.reload();
            }
        });
        // #1937: search is server-side (?q=) — debounced re-query, not a local filter.
        const search = $("ses-search");
        if (search) {
            let sesTimer = null;
            search.addEventListener("input", () => { clearTimeout(sesTimer); sesTimer = setTimeout(() => refreshSessions(false), 300); });
        }
        const sref = $("ses-refresh");
        if (sref) sref.addEventListener("click", () => refreshSessions(true));
        const lm = $("ses-loadmore");
        if (lm) lm.addEventListener("click", loadMoreSessions);
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
        // #1748: quick-config controls edit the same in-memory draft as the raw JSON
        // editor; every change re-serializes into #cfg-file-edit, one Save writes once.
        const sq = $("save-quick");
        if (sq) sq.addEventListener("click", async () => {
            const el = $("cfg-file-edit");
            const raw = el ? el.value : "";
            let parsed;
            try { parsed = JSON.parse(raw || "{}"); } catch (e) { toast(t("cfg.invalid_json"), "err"); return; }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { toast(t("cfg.invalid_json"), "err"); return; }
            await putCfg(sq, { file: raw });
        });
        // #1426: single raw config-file editor — the server validates every known field
        const sf = $("save-file");
        const ss = $("save-summary");
        if (ss) ss.addEventListener("click", () => putCfg(ss, { file: $("cfg-file-edit").value }));
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
    // #1937: failures back off exponentially (5s → 10s → … cap 60s) with a
    // persistent error strip instead of silent toast-spam retries, and a slow
    // wedged response can never stack onto an in-flight poll.
    setInterval(async () => {
        if (document.hidden) return;
        if (pollBusy) return;
        if (pollFailures > 0 && Date.now() < nextPollAt) return;
        pollBusy = true;
        try {
            // #1682: keep the global alert banner fresh on every view — silent, so a
            // restarting server cannot spam toasts from background views.
            let ok = current === "overview" ? await loadOverview() : await loadOverview(true);
            // A paged-down or searched list must not be clobbered by the background refresh.
            if (current === "sessions" && $("session-detail-view").hidden && sessionsCache.length <= SES_PAGE_SIZE) ok = (await refreshSessions(false)) && ok;
            else if (current === "logs") ok = (await loadLogs()) && ok;
            if (ok) { pollFailures = 0; nextPollAt = 0; hideDataError(); }
            else {
                pollFailures += 1;
                nextPollAt = Date.now() + Math.min(5000 * Math.pow(2, pollFailures), 60000);
                showDataError(lastErrMsg || t("data.generic"));
            }
        } finally {
            pollBusy = false;
        }
    }, 5000);
})();`;
