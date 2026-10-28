import { MESSAGES } from "./i18n.js";

// #3572 (client half): the server accepts JSONC config files (comments +
// trailing commas) since the parseBiliConfig fix, but the web editor still
// strict-parses the draft text in five places — so a user with a JSONC config
// sees the quick-config panel vanish (#3488) and cannot save. These three pure
// helpers implement the same tolerance client-side; they live in the TS module
// (importable by tests) and are inlined into the browser IIFE below via
// toString(), so there is exactly one implementation.
export function stripJsoncComments(text: string): string {
    let out = "";
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const c = text.charAt(i);
        const d = i + 1 < text.length ? text.charAt(i + 1) : "";
        if (inString) {
            out += c;
            if (c === "\\") {
                if (d !== "") {
                    out += d;
                    i += 2;
                    continue;
                }
            } else if (c === '"') inString = false;
            i += 1;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i += 1;
            continue;
        }
        // Comments become spaces (not deleted) so JSON.parse error offsets stay honest.
        if (c === "/" && d === "/") {
            while (i < text.length && text.charAt(i) !== "\n") {
                out += " ";
                i += 1;
            }
            continue;
        }
        if (c === "/" && d === "*") {
            while (i < text.length && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/")) {
                out += text.charAt(i) === "\n" ? "\n" : " ";
                i += 1;
            }
            out += "  "; // the closing */ — kept as spaces so offsets stay honest
            i += 2;
            continue;
        }
        out += c;
        i += 1;
    }
    return out;
}

// Second pass, string-aware: drop a comma only when the next meaningful char
// closes the current object/array. Run AFTER stripJsoncComments so commas and
// closers inside string literals are the only ones left to protect.
export function stripJsoncTrailingCommas(text: string): string {
    let out = "";
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const c = text.charAt(i);
        if (inString) {
            out += c;
            if (c === "\\") {
                const d = i + 1 < text.length ? text.charAt(i + 1) : "";
                if (d !== "") {
                    out += d;
                    i += 2;
                    continue;
                }
            } else if (c === '"') inString = false;
            i += 1;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i += 1;
            continue;
        }
        if (c === ",") {
            let j = i + 1;
            while (j < text.length && " \t\r\n".includes(text.charAt(j))) j += 1;
            if (j < text.length && (text.charAt(j) === "}" || text.charAt(j) === "]")) {
                i += 1;
                continue;
            }
        }
        out += c;
        i += 1;
    }
    return out;
}

// Strict JSON first so a valid file takes the exact same path as before;
// fall back to the JSONC tolerance above; a genuinely malformed draft still
// throws, and the server's parseBiliConfig remains the authoritative check on save.
export function parseConfigDraft(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        // fall through to the tolerant path
    }
    return JSON.parse(stripJsoncTrailingCommas(stripJsoncComments(text)));
}

// #3816: does this config draft carry an ENABLED admin relay? Strict on the
// value (=== true): "true", 1 and other truthy typos do not count. Malformed
// drafts report false — the parse-error banner owns that state, not this one.
export function adminRelayActiveInDraft(text: string): boolean {
    let draft: unknown;
    try {
        draft = parseConfigDraft(text);
    } catch {
        return false;
    }
    if (draft === null || typeof draft !== "object" || Array.isArray(draft)) return false;
    const sec = (draft as Record<string, unknown>).security;
    if (sec === null || sec === undefined || typeof sec !== "object" || Array.isArray(sec)) return false;
    return (sec as Record<string, unknown>).adminRelay === true;
}

// #4906 P3: i18n bl.sub promises the feed turns over "约 1 小时一次", but the
// panel kept its ONE fetch for the whole tab lifetime — pure staleness gate
// for loadBlog's cache, inlined into the browser IIFE below via toString()
// (same single-implementation discipline as the JSONC helpers above). The 1h
// matches the server's hourly pull cadence (web/blog-refresh.ts ROUND_TTL_MS).
export function blogCacheStale(cachedAt: number, now: number): boolean {
    return now - cachedAt >= 60 * 60 * 1000;
}

export const WEB_CLIENT = `(function () {
    "use strict";
    const stripJsoncComments = ${stripJsoncComments.toString()};
    const stripJsoncTrailingCommas = ${stripJsoncTrailingCommas.toString()};
    const parseConfigDraft = ${parseConfigDraft.toString()};
    const adminRelayActiveInDraft = ${adminRelayActiveInDraft.toString()};
    const blogCacheStale = ${blogCacheStale.toString()};
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
    // #3373: when the panel is served through a host relay under a path
    // prefix (e.g. /app/dsh/__bili/…), the wire root is that prefixed path,
    // not the site root. Derive it from the document's own pathname — the
    // only prefix source that survives gateway <base> injection. Direct
    // serving (/__bili/) keeps the byte-identical root "/__bili".
    let API_ROOT = "/__bili";
    try {
        if (typeof location !== "undefined" && location.pathname) {
            const m = /^(.*\\/)__bili(\\/|$)/.exec(location.pathname);
            if (m && m[1] !== undefined) API_ROOT = m[1] + "__bili";
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
        if (hidden > 0) line += " · …+" + hidden + " more (the conflicts field of GET /__bili/stats)";
        return line;
    }
    // #2324/#2545: pick the banner title/risk wording from the ledger EVIDENCE TIERS.
    // CONFIRMED = non-suspected third-party plugin findings + detected native-compaction
    // landings only. UNCONFIRMED SIGNALS = unannounced rewrites + orphan reaps (observed
    // history changes whose cause is NOT identified) — counting them as confirmed turned
    // one unexplained rewrite into a "two compressors on one conversation" alarm (#2545);
    // they outrank name-only [suspected] matches (an observed change is stronger than a
    // name guess), so any signal takes the unconfirmed tier even next to suspected names.
    // SUSPECTED-ONLY keeps the #2324 verify-first tier. Siblings and verified
    // non-compressing plugins (read-only viewers, protocol adapters — #2324/#2545/#2969)
    // are NEUTRAL. Old payloads without c.suspected / c.displayOnly degrade to the
    // previous view; without c.activeConfirmed, liveness falls back to c.active.
    // Pure (reads only c), exported for tests the same way bili_conflictLine is.
    function bili_conflictSeverity(c) {
        const kinds = c.kinds || {};
        const pluginN = kinds["third-party-plugin"] || 0;
        const siblingN = Math.max(0, Math.min(typeof c.sibling === "number" ? c.sibling : 0, pluginN));
        // Stock ledgers written by pre-#1736 keyword rules carry display-only plugins as
        // [suspected]; subtract display-only BEFORE suspected so they count for no severity.
        const displayOnlyN = Math.max(0, Math.min(typeof c.displayOnly === "number" ? c.displayOnly : 0, pluginN - siblingN));
        const suspectedN = Math.max(0, Math.min(typeof c.suspected === "number" ? c.suspected : 0, pluginN - siblingN - displayOnlyN));
        const confirmedTpN = Math.max(0, pluginN - siblingN - displayOnlyN - suspectedN);
        // #2709/#2912: only an attribution-only (inferred) landing is CONFIRMED evidence — a
        // marker-detected landing (native-compaction) was already rebased onto (#2372/#2432),
        // so it is handled stock, not an alarm. Kept out of signalN too, else it masquerades
        // as an unexplained rewrite (warned-on-impact policy, #2912).
        const confirmedNativeN = kinds["native-compaction-inferred"] || 0;
        const handledNativeN = kinds["native-compaction"] || 0;
        const signalN = Math.max(0, c.events - pluginN - confirmedNativeN - handledNativeN);
        const whatParts = [];
        if (confirmedTpN > 0) whatParts.push(t("conflict.what_plugin"));
        if (suspectedN > 0) whatParts.push(t("conflict.what_suspected"));
        // #2430: siblings are family, never a warning — they no longer appear in the
        // "what" enumeration even in mixed ledgers (pure-sibling banners are hidden outright).
        if (confirmedNativeN > 0) whatParts.push(t("conflict.what_native"));
        if (signalN > 0) whatParts.push(t("conflict.what_signal"));
        const active = typeof c.active === "number" ? c.active : c.events;
        // Liveness of the CONFIRMED evidence itself — a fresh unconfirmed signal must not
        // re-light a stale confirmed ledger as a live alarm.
        const activeConfirmed = typeof c.activeConfirmed === "number" ? Math.min(c.activeConfirmed, active) : active;
        const hasConfirmed = confirmedTpN > 0 || confirmedNativeN > 0;
        // Resolve each branch through a direct translate call (not a key-to-text lookup table)
        // so the #1024 static ref-scanner still counts every conflict.* key used here; surface
        // both the key (locale-independent, asserted by tests) and the rendered text.
        let onKey, riskKey, onText, riskText;
        if (hasConfirmed) {
            onKey = "conflict.on"; onText = t("conflict.on");
            if (activeConfirmed > 0) { riskKey = "conflict.risk_active"; riskText = t("conflict.risk_active"); }
            else { riskKey = "conflict.risk_historical"; riskText = t("conflict.risk_historical"); }
        } else if (signalN > 0) {
            onKey = "conflict.on_unconfirmed"; onText = t("conflict.on_unconfirmed");
            riskKey = "conflict.risk_unconfirmed"; riskText = t("conflict.risk_unconfirmed");
        } else if (suspectedN > 0) {
            onKey = "conflict.on_suspected"; onText = t("conflict.on_suspected");
            riskKey = "conflict.risk_suspected"; riskText = t("conflict.risk_suspected");
        } else {
            onKey = "conflict.on"; onText = t("conflict.on");
            riskKey = "conflict.risk_sibling"; riskText = t("conflict.risk_sibling");
        }
        // #2430/#2545: a ledger naming ONLY bili's own siblings or verified read-only viewers
        // stands down completely — compatible family / non-compressors, not conflicts.
        const siblingOnly = !hasConfirmed && suspectedN === 0 && signalN === 0 && siblingN > 0;
        const neutralOnly = !hasConfirmed && suspectedN === 0 && signalN === 0 && (siblingN + displayOnlyN + handledNativeN) > 0; // #2912: fully-handled (recovered-native-only) ledger also stands down
        // #3235 owner rule: the banner is an ALARM for interception FAILURE — evidence a
        // history rewrite actually LANDED unrecovered (confirmed third-party / inferred
        // native landing / unexplained rewrite signal). Co-residence alone (suspected
        // plugin stock, siblings, read-only viewers) never pops; it stays recorded in
        // acp_status and the web conflict details for the curious.
        const landed = hasConfirmed || signalN > 0;
        // #2969: per-client remediation hints are imperative ("disable auto-compaction,
        // start a fresh session") — they belong to CONFIRMED and UNCONFIRMED-SIGNAL tiers.
        // A suspected-only ledger already carries verify-first wording in riskText; an
        // imperative hint block beneath it contradicts it and demands action on a guess.
        const showHints = hasConfirmed || signalN > 0;
        return { onKey: onKey, riskKey: riskKey, onText: onText, riskText: riskText, hasConfirmed: hasConfirmed, siblingOnly: siblingOnly, neutralOnly: neutralOnly, landed: landed, signalN: signalN, showHints: showHints, what: whatParts.join(t("conflict.what_join")), active: active, activeConfirmed: activeConfirmed };
    }
    // #3235: persisted banner dismissal — "don't show again" must survive new
    // sessions (users reported the banner stalking them across sessions) but
    // NEVER mask new evidence: the stored watermark (newest event timestamp +
    // event count) re-arms the banner the moment a newer landing is recorded.
    // Defined before the window exports so the Node test-extraction slice
    // (web-conflict-banner.test.ts) can reach it without a window global.
    function bili_conflictDismissed(c, stored) {
        if (!stored || typeof stored !== "object") return false;
        if (typeof stored.lastAt !== "number" || typeof stored.events !== "number") return false;
        if (c.lastAt === null || c.lastAt === undefined) return c.events <= stored.events;
        return c.lastAt <= stored.lastAt && c.events <= stored.events;
    }
    const CONFLICT_DISMISS_KEY = "biliConflictDismiss";
    function loadConflictDismiss() {
        try { return JSON.parse(localStorage.getItem(CONFLICT_DISMISS_KEY) || "null"); } catch { return null; }
    }
    function saveConflictDismiss(c) {
        try { localStorage.setItem(CONFLICT_DISMISS_KEY, JSON.stringify({ lastAt: c.lastAt ?? 0, events: c.events, at: Date.now() })); } catch { /* private mode etc. — dismissal just won't persist */ }
    }
    window.bili_conflictLine = bili_conflictLine;
    window.bili_conflictSeverity = bili_conflictSeverity;
    window.bili_conflictDismissed = bili_conflictDismissed;
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
    // #2462: high-cost plugin notice (NOT a compression conflict). Pure builder
    // taking pre-translated strings so the test seam needs only escapeHtml;
    // name/url are user/plugin data -> escaped.
    function bili_pluginAdvisoryBanner(advs, s) {
        let html = '<div class="banner-title">' + escapeHtml(s.on) + "</div>";
        for (const a of advs) {
            const url = typeof a.issueUrl === "string" ? a.issueUrl : "";
            html += '<div class="alert-row"><span><strong>' + escapeHtml(a.name || a.id) + "</strong> " + escapeHtml(s.desc) + "</span>";
            if (url) html += '<a class="mono" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(url) + "</a>";
            html += "</div>";
        }
        html += '<div class="dim small" style="margin-top:6px">' + escapeHtml(s.hint) + "</div>";
        return html;
    }
    window.bili_pluginAdvisoryBanner = bili_pluginAdvisoryBanner;
    // #2861: host-side metering plugin notice (pre-compression local caliber).
    // Pure builder taking pre-translated strings; name/id are data -> escaped.
    function bili_hostPluginBanner(notices, s) {
        let html = '<div class="banner-title">' + escapeHtml(s.on) + "</div>";
        for (const n of notices) {
            html += '<div class="alert-row"><span><strong>' + escapeHtml(n.name || n.id) + "</strong> " + escapeHtml(s.desc) + '</span><button class="btn sm host-plugin-dismiss" data-hpid="' + escapeHtml(n.id) + '">' + escapeHtml(s.dismiss) + "</button></div>";
        }
        html += '<div class="dim small" style="margin-top:6px">' + escapeHtml(s.hint) + "</div>";
        return html;
    }
    window.bili_hostPluginBanner = bili_hostPluginBanner;
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
            // #3488: server errors may be objects ({type, message}); String() on
            // them rendered "[object Object]" in the toast.
            if (!res.ok) throw new Error(body && body.error ? (typeof body.error === "object" ? String(body.error.message || body.error.type || JSON.stringify(body.error)) : String(body.error)) : "HTTP " + res.status);
            return body;
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    }
    async function putCfg(btn, payload) {
        busy(btn, true);
        try {
            await json(API_ROOT + "/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
            toast(t("cfg.saved"), "ok");
            loadConfig();
            return true;
        } catch (e) {
            toast(e.message, "err");
            return false;
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
    // #4899: USD display — 4 decimals under $1 (per-turn pennies stay visible),
    // 2 above; negatives keep the sign (unpaid-back folds are honest).
    function fmtUsd(n) {
        if (n === null || n === undefined || isNaN(n)) return "—";
        const abs = Math.abs(Number(n));
        return (n < 0 ? "−" : "") + "$" + (abs >= 1 ? abs.toFixed(2) : abs.toFixed(4));
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

    const PAGES = ["overview", "sessions", "config", "updates", "connect", "logs", "blog"];
    let current = "overview";
    let sessionsCache = [];
    // #1682: last overview alert payload — lets a dismiss re-render without refetching.
    let latestAlerts = [];
    // #1937: server-side paging state for the session list (50 rows per page).
    const SES_PAGE_SIZE = 50;
    let sesPage = 1;
    let sesPages = 1;
    let sesTotal = 0;
    let sesUnfilteredTotal = 0;
    let sesRequestId = 0;
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
        refreshRelayWarn();
    }
    // #3816: the admin-relay warning rides every editor change and the initial
    // load, so it shows WHILE the user is setting security.adminRelay — before
    // the save lands — not only afterwards.
    function refreshRelayWarn() {
        const el = $("cfg-relay-warn");
        const fe = $("cfg-file-edit");
        if (!el || !fe) return;
        if (adminRelayActiveInDraft(fe.value)) {
            el.hidden = false;
            el.classList.add("show");
            el.textContent = t("cfg.relay_warn");
        } else {
            el.hidden = true;
            el.classList.remove("show");
            el.textContent = "";
        }
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
            + (s.autoModeForge ? ' <span class="badge live" style="background:#6d3b8a" title="' + escapeHtml(t("det.auto_mode_forge_tip")) + '">' + t("det.auto_mode_forge_short") + "</span>" : "")
+ (s.keepalive ? ' <span class="badge live" style="background:#3b6d8a" title="' + escapeHtml(t("det.keepalive_tip") + " · " + s.keepalive.tierLabel + " · " + (s.keepalive.cadenceMs >= 60_000 ? Math.round(s.keepalive.cadenceMs / 60_000) + "min" : Math.round(s.keepalive.cadenceMs / 1000) + "s") + (s.keepalive.lastHitAt ? " · " + t("det.keepalive_last_hit") + " " + timeAgo(new Date(s.keepalive.lastHitAt).toISOString()) : "")) + '">' + t("det.keepalive_short") + "×" + s.keepalive.pingCount + "</span>" : "")
            + '<span class="row-id">' + escapeHtml(s.id) + "</span></a>";
    }
    // SAVED column prefers ledger-derived net savings; pre-tagging sessions fall back
    // to the local tokensSaved estimate; neither present => honest dash, never fake 0.
    function savedTd(x) {
        const v = x.netSaved != null ? x.netSaved : (x.tokensSaved || 0);
        // #2202: name the frozen share in the tooltip when any fold lost
        // coverage — the number is honest now, but the operator must see it.
        const clTip = x.coverageLostFolds
            ? ' title="' + escapeHtml(t("ses.covlost_tip", { n: x.coverageLostFolds, x: fmtW(x.coverageLostFrozenTokens || 0) })) + '"'
            : "";
        if (v > 0) return '<td class="num good-num"' + clTip + ">" + fmtW(v) + moneySub(x) + "</td>";
        if (v) return '<td class="num"' + (clTip || ' title="' + escapeHtml(t("ov.saved_neg_tip")) + '"') + ">" + fmtW(v) + moneySub(x) + "</td>";
        return '<td class="num dim">' + t("common.none") + "</td>";
    }
    // #4899: small $ line under the saved-tokens number — priced folds only
    // (undefined when the session has no price profile: tokens only, no fake $).
    function moneySub(x) {
        if (x.savedUsd == null) return "";
        return '<div class="dim small">' + (x.savedUsd >= 0 ? "≈ " : "") + "" + escapeHtml(fmtUsd(x.savedUsd)) + "</div>";
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
        // #2867: 🔀 = proxy projection/mode switches (bili's own doing, e.g. self-heal degrade-to-proxy).
        const projPart = s.projSwitches
            ? '<span title="' + escapeHtml(t("ses.th_projswitches_tip")) + '">🔀' + s.projSwitches + (!s.projSwitchMissedTokens ? "" : " · " + fmtW(s.projSwitchMissedTokens)) + "</span>"
            : "";
        if (!modelPart && !keyPart && !promptPart && !projPart) return '<td class="num dim">' + t("common.none") + "</td>";
        const parts = [modelPart, keyPart, promptPart, projPart].filter(Boolean);
        return '<td class="num" title="' + escapeHtml(t("ses.th_switches_tip")) + '">' + parts.join(" ") + "</td>";
    }

    function sessionRow(s, compact) {
        const tr = document.createElement("tr");
        tr.title = s.id;
        if (compact) {
            tr.innerHTML = "<td>" + sessionTitleCell(s) + '</td><td>' + protoBadge(s.protocol) + '</span></td><td class="num">' + fmtW(s.contextBest ? s.contextBest.tokens : s.contextTokens) + '</td>' + savedTd(s) + '<td class="dim">' + timeAgo(s.lastSeen) + "</td>";
        } else {
            const clientHint = s.clientHint ? String(s.clientHint) : "";
            // #4571: inline sessions carry a lane chip beside the client hint so
            // "did this run in-process?" is visible in the list, not just detail.
            const laneChip = s.engineLane === "inline"
                ? ' <span class="badge proto" title="' + escapeHtml(t("det.engine_lane_inline")) + '">inline</span>'
                : s.engineLane === "server" ? ' <span class="badge proto dim" title="' + escapeHtml(t("det.engine_lane_server")) + '">srv</span>' : "";
            const clientCell = clientHint
                ? '<span class="mono small clip w-client" title="' + escapeHtml(clientHint) + '">' + escapeHtml(clientHint) + "</span>" + laneChip
                : '<span class="dim">' + t("common.none") + "</span>" + laneChip;
            tr.innerHTML = "<td>" + sessionTitleCell(s) + '</td><td class="client-cell">' + clientCell + '</td><td>' + protoBadge(s.protocol) + '</td><td><span class="mono dim small clip w-up">' + escapeHtml(hostOf(s.upstreamOrigin)) + '</td><td class="num">' + (s.requests ? s.requests : t("common.none")) + '</td><td class="num">' + fmtW(s.contextBest ? s.contextBest.tokens : s.contextTokens) + '</td><td class="num">' + (s.inputTokens ? fmtW(s.inputTokens) : '<span class="dim">' + t("common.none") + "</span>") + "</td>" + savedTd(s) + hitTd(s) + switchTd(s) + '<td class="num">' + (s.foldCount || 0) + '</td><td class="num">' + (s.blocks || 0) + '</td><td class="dim">' + timeAgo(s.lastSeen) + "</td>";
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

    // #3719: changelog section (overview page, collapsed card) — one fetch per
    // page load; the server caches with a 10-minute throttle, so this costs at
    // most one GitHub API hit per 10 minutes fleet-wide.
    let chlogLoaded = false;
    // Escaped-plain-text → anchor tags. Function-form replacer on purpose:
    // URL characters ($, &) would corrupt "string" replacement patterns.
    function linkifyText(escaped) {
        return escaped.replace(/(https?:\\/\\/[^\\s<>]+)/g, (u) => '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + "</a>");
    }
function changelogCatOf(rawLine) {
        const s = rawLine.replace(/^\\*?\\s*\\[PR\\]\\s*/i, "").trim();
        if (/^kernel([(:\\s]|$)/i.test(s)) return "cat_kernel";
        if (/(^|[.(,\\s])(dsh|pi(?:-subagents)?|codex|claude(?:-code)?|opencode(?:v?\\d)?|hermes|kimi|zcode|trae)([):,\\s]|$)/i.test(s)) return "cat_host";
        const m = s.match(/^([a-z]+)(\\([^)]*\\))?[:\\s]/);
        if (m) {
            const p = m[1].toLowerCase();
            if (p === "feat" || p === "feature" || p === "improve") return "cat_feat";
            if (p === "fix" || p === "perf") return "cat_fix";
            if (p === "docs") return "cat_web";
            if (p === "ci" || p === "build" || p === "test" || p === "chore" || p === "refactor" || p === "style") return "cat_infra";
        }
        if (/(persist|storage|session|sqlite|index\\.db|unified)/i.test(s)) return "cat_store";
        if (/(self-update|auto-update|update policy|release|publish|stagger|version bump)/i.test(s)) return "cat_upd";
        if (/\\b(web|panel|i18n|changelog|favicon)\\b/i.test(s)) return "cat_web";
        return "cat_other";
    }
    const CHLOG_CATS = ["cat_feat", "cat_fix", "cat_kernel", "cat_host", "cat_store", "cat_upd", "cat_web", "cat_infra", "cat_other"];
    // One release body → intro (headings/prose) + categorized bullet groups.
    function changelogBodyHtml(escaped) {
        const intro = [];
        let para = [];
        const flushPara = () => { if (para.length) { intro.push('<div class="cl-p">' + para.map((s)=>s.replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>")).join("<br>") + "</div>"); para = []; } };
        const cats = {};
        for (const raw of escaped.split("\\n")) {
            const tl = raw.trim();
            const bm = tl.match(/^(?:[-*]|\\d+[.)])\\s+(.*)$/);
            if (bm) {
                flushPara();
                const item = linkifyText(bm[1]);
                const key = changelogCatOf(bm[1]);
                if (!cats[key]) cats[key] = [];
                cats[key].push(item);
            } else if (/^#{1,6}\\s/.test(tl)) {
                flushPara();
                intro.push('<div class="cl-h">' + linkifyText(tl.replace(/^#{1,6}\\s*/, "")) + "</div>");
            } else if (tl === "") flushPara();
            else para.push(linkifyText(tl));
        }
        flushPara();
        let html = intro.join("");
        for (const key of CHLOG_CATS) {
            const items = cats[key];
            if (!items) continue;
            // Inline t() per key: the #1024 scanner counts literal t("…") refs only.
            const label = { cat_feat: t("sys.changelog_cat_feat"), cat_fix: t("sys.changelog_cat_fix"), cat_kernel: t("sys.changelog_cat_kernel"), cat_host: t("sys.changelog_cat_host"), cat_store: t("sys.changelog_cat_store"), cat_upd: t("sys.changelog_cat_upd"), cat_web: t("sys.changelog_cat_web"), cat_infra: t("sys.changelog_cat_infra"), cat_other: t("sys.changelog_cat_other") }[key];
            html += '<div class="cl-cat">' + label + ' <span class="dim">' + items.length + "</span></div>" + items.map(function (x) { return '<div class="cl-li">' + x + "</div>"; }).join("");
        }
        return html;
    }
    // Version-select → scroll that release open and flash it briefly.
    function focusChangelogRelease(val) {
        const el = $("changelog-body");
        if (!el) return;
        const want = String(val).replace(/^v/, "");
        const items = el.querySelectorAll("details.cl-item");
        if (typeof items.forEach !== "function") return;
        items.forEach((it) => {
            const hit = String(it.getAttribute("data-tag") || "").replace(/^v/, "") === want;
            try { it.open = hit; } catch (_) { /* harness */ }
            it.classList.remove("cl-flash");
        });
        const target = el.querySelector('details.cl-item[data-tag="' + want.replace(/"/g, "") + '"]');
        if (!target) return;
        try { target.open = true; } catch (_) { /* harness */ }
        target.classList.add("cl-flash");
        if (target.scrollIntoView) target.scrollIntoView({ behavior: "smooth", block: "start" });
        setTimeout(() => target.classList.remove("cl-flash"), 2500);
    }
    function renderChangelog(d) {
        const el = $("changelog-body");
        if (!el) return;
        const rels = (d && typeof d === "object" && Array.isArray(d.releases)) ? d.releases : [];
        if (!rels.length) {
            el.textContent = (d && d.error) ? t("sys.changelog_offline") : t("sys.changelog_empty");
            return;
        }
        let html = "";
        rels.forEach((r, i) => {
            const tagRaw = String(r.tag || "");
            const tag = escapeHtml(tagRaw);
            const dataTag = tagRaw.replace(/^v/, "").replace(/"/g, "");
            const name = (typeof r.name === "string" && r.name !== r.tag) ? escapeHtml(r.name) + " · " : "";
            const latest = i === 0 ? ' <span class="badge cl-latest">' + t("sys.changelog_latest") + "</span>" : "";
            const date = r.publishedAt ? ' <span class="dim">' + escapeHtml(String(r.publishedAt).slice(0, 10)) + "</span>" : "";
            const view = '<a href="' + escapeHtml(String(r.url || "")) + '" target="_blank" rel="noopener noreferrer">' + t("sys.changelog_view") + "</a>";
            const body = typeof r.body === "string" && r.body.trim() ? '<div class="cl-body">' + changelogBodyHtml(escapeHtml(r.body)) + '<div class="cl-foot">' + view + "</div></div>" : view;
            html += '<details class="cl-item" data-tag="' + dataTag + (i === 0 ? '" open>' : '">' ) + '<summary><span class="cl-tag">' + tag + "</span>" + name + latest + date + "</summary>" + body + "</details>";
        });
        html += '<div class="cl-actions"><button class="btn sm" id="cl-expand-all" type="button">' + t("up.cl_expand_all") + '</button><button class="btn sm" id="cl-collapse-all" type="button">' + t("up.cl_collapse_all") + '</button><a class="btn sm" href="https://github.com/ranxianglei/billion-context/releases" target="_blank" rel="noopener noreferrer">' + t("sys.changelog_all") + "</a></div>";
        el.innerHTML = html;
        const expandAll = $("cl-expand-all");
        const collapseAll = $("cl-collapse-all");
        if (expandAll) expandAll.addEventListener("click", () => el.querySelectorAll("details.cl-item").forEach((it) => { try { it.open = true; } catch (_) { /* harness */ } }));
        if (collapseAll) collapseAll.addEventListener("click", () => el.querySelectorAll("details.cl-item").forEach((it) => { try { it.open = false; } catch (_) { /* harness */ } }));
    }
    async function loadChangelog() {
        if (chlogLoaded) return;
        const el = $("changelog-body");
        if (!el) return;
        chlogLoaded = true;
        el.textContent = t("sys.changelog_loading");
        try {
            renderChangelog(await json(API_ROOT + "/changelog"));
        } catch (e) {
            // The endpoint itself never errors (fail-soft); reaching here means
            // the PROXY is unreachable — same offline wording either way.
            renderChangelog({ releases: [], error: "offline" });
        }
    }

    // #3719 phase 2: dedicated 更新/Updates tab — self-update state, pushed
    // notices, and install/rollback actions. All writes go through the
    // admin-gated POST /__bili/update/* routes (same json() pattern as
    // putCfg); one shared in-flight flag keeps ALL action buttons disabled
    // while any action runs (the server dedupes a second call too).
    let upBusyAction = false;
    let upReleases = [];
    function upSetButtons(on) {
        [$("up-check"), $("up-upgrade-now"), $("up-install")].forEach((b) => {
            if (!b) return;
            b.classList.toggle("busy", on);
            b.disabled = on;
        });
        // Install-selected additionally needs an actual selection.
        const ins = $("up-install");
        const sel = $("up-select");
        if (ins) ins.disabled = on || !(sel && sel.value);
    }
    function showUpdateResult(msg, ok) {
        const el = $("up-result");
        if (!el || !msg) return;
        el.hidden = false;
        el.textContent = msg;
        el.style.color = ok ? "var(--green)" : "var(--red)";
    }
    // Loose numeric compare on major/minor/patch — enough to decide the
    // rollback confirm without pulling semver into the panel.
    function upVerParts(v) {
        return String(v || "").replace(/^v/i, "").split(/[.+]/).slice(0, 3).map((p) => parseInt(p, 10));
    }
    function upCmpVer(a, b) {
        const x = upVerParts(a);
        const y = upVerParts(b);
        for (let i = 0; i < 3; i++) {
            const d = (x[i] || 0) - (y[i] || 0);
            if (d !== 0) return d < 0 ? -1 : 1;
        }
        return 0;
    }
    function renderNotices(items) {
        const el = $("up-notices");
        if (!el) return;
        if (!items.length) { el.textContent = t("up.notice_empty"); return; }
        let html = "";
        items.slice().reverse().forEach((n) => {
            const tier = n.tier === "critical" ? "critical" : (n.tier === "recommended" ? "recommended" : "routine");
            // Fully literal keys below: the i18n dead-key scanner (#1024)
            // greps t() call sites and would flag a dynamically built
            // tier-prefix key.
            const tierLabel = tier === "critical" ? t("up.tier_critical") : (tier === "recommended" ? t("up.tier_recommended") : t("up.tier_routine"));
            // #3719 item4: locale-aware summary — zh picks summaryZh when the
            // entry carries one; every other locale (and legacy payloads)
            // falls back to the English one-liner.
            const summaryText = (locale === "zh-CN" && typeof n.summaryZh === "string" && n.summaryZh) ? n.summaryZh : String(n.summary || "");
            html += '<div class="ntc-item"><span class="badge' + (tier === "routine" ? " disk" : " ntc-" + tier) + '">' + escapeHtml(tierLabel) + "</span><span class='mono'>" + escapeHtml(String(n.version || "")) + "</span>" + (n.date ? ' <span class="dim">' + escapeHtml(String(n.date)) + "</span>" : "") + "<br>" + escapeHtml(summaryText) + "</div>";
        });
        el.innerHTML = html;
    }
    // Newest release known to the panel: the newest pushed notice wins, the
    // changelog tag list is the fallback (tags arrive newest-first, capped at
    // what the endpoint returns). Leading "v" is stripped before install —
    // the updater takes plain semver.
    function upNewestVersion(notices) {
        if (notices && notices.length) return String(notices[notices.length - 1].version || "");
        return String(upReleases[0] || "").replace(/^v/, "");
    }
    function applyUpdateButtons(st) {
        const now = $("up-upgrade-now");
        const target = upNewestVersion(st && st.notices);
        if (now) {
            const lbl = $("up-upgrade-now-label");
            if (lbl) lbl.textContent = target ? t("up.upgrade_now", { v: target }) : t("up.upgrade_none");
            now.disabled = upBusyAction || !target;
        }
    }
    function renderUpdateState(st) {
        if (!st || typeof st !== "object") return;
        const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
        set("up-running", st.running || "?");
        set("up-disk", st.disk || t("common.none"));
        set("up-latest", upNewestVersion(st.notices) || t("common.none"));
        set("up-last-check", st.lastCheckAt ? new Date(st.lastCheckAt).toLocaleString() : t("common.none"));
        const hint = $("up-pending-hint");
        if (hint) hint.hidden = !st.pendingRestart;
        renderNotices(Array.isArray(st.notices) ? st.notices : []);
        const sel = $("up-select");
        if (sel) {
            const cur = sel.value;
            let opt = '<option value="">' + t("up.select_placeholder") + "</option>";
            upReleases.forEach((tag) => { opt += '<option value="' + escapeHtml(tag) + '">' + escapeHtml(tag) + "</option>"; });
            sel.innerHTML = opt;
            if (cur) sel.value = cur;
        }
        applyUpdateButtons(st);
        // A check/install started from another tab of this process shows in
        // the snapshot — keep the buttons held down until it settles.
        if (st.checking || st.installing) upSetButtons(true);
    }
    // #4587: panel-embedded blog & articles — the server renders the bundled
    // markdown with web/markdown.ts (escaped by construction), so this side only
    // lays out cards and expands bodies. Language rides the page-level locale;
    // switching languages reloads the page, so no incremental re-render hook.
    // #4906 P3: the cache carries a timestamp and goes stale after ~1h (the
    // cadence bl.sub promises), so a long-lived tab re-pulls instead of pinning
    // one fetch forever. A stale hit still paints instantly from cache; the
    // re-pull runs silently in the background and re-renders only if the blog
    // view is still on screen — the overview poll's discipline (no blocked
    // first paint, no toasts from background refreshes).
    let blogCache = null; // { data, at }
    let blogSub = null;
    let blogRefreshBusy = false;
    function refreshBlogInBackground() {
        if (blogRefreshBusy) return;
        blogRefreshBusy = true;
        json(API_ROOT + "/blog").then(function (feed) {
            blogCache = { data: feed, at: Date.now() };
            if (current === "blog") loadBlog(blogSub); // cache is fresh now — no refresh loop
        }, function () {
            // keep the stale paint; the cache keeps its old timestamp, so the next visit retries
        }).then(function () { blogRefreshBusy = false; });
    }
    async function loadBlog(sub) {
        const host = $("bl-list");
        if (!host) return;
        blogSub = sub || null;
        let data = blogCache ? blogCache.data : null;
        if (!data) {
            try {
                data = await json(API_ROOT + "/blog");
                blogCache = { data: data, at: Date.now() };
            } catch (e) {
                host.innerHTML = "";
                toast(t("toast.failed", { msg: e.message }), "err");
                return;
            }
        } else if (blogCacheStale(blogCache.at, Date.now())) {
            refreshBlogInBackground();
        }
        const items = (data && Array.isArray(data.items)) ? data.items : [];
        const zhOn = locale === "zh-CN";
        const offlineNote = data && data.error ? '<div class="card"><div class="card-b">' + escapeHtml(t("bl.offline")) + '</div></div>' : "";
        if (sub) {
            const item = items.find((x) => String(x.id) === String(sub)) || null;
            if (!item) {
                host.innerHTML = '<div class="card"><div class="card-b"><a href="#/blog" class="bl-back">' + escapeHtml(t("bl.back")) + "</a> " + escapeHtml(t("bl.nf")) + "</div></div>";
                return;
            }
            const kindLabel = item.kind === "post" ? t("bl.kind_post") : t("bl.kind_article");
            const title = zhOn && item.titleZh ? item.titleZh : (item.title || "");
            const html = zhOn ? (item.htmlZh || item.html || "") : (item.html || "");
            host.innerHTML = offlineNote + '<div class="card"><div class="card-b"><span class="mono bl-date">' + escapeHtml(item.date || "\u2014") + '</span><span class="badge">' + escapeHtml(kindLabel) + '</span><a href="#/blog" class="bl-back">' + escapeHtml(t("bl.back")) + "</a></div>"
                + '<h3 class="bl-h">' + escapeHtml(title) + "</h3>"
                + '<div class="card-b post-body">' + html + "</div></div>";
            return;
        }
        if (!items.length) {
            const wrap = document.createElement("div");
            wrap.className = "card";
            const box = document.createElement("div");
            box.className = "card-b";
            box.textContent = t("bl.empty");
            wrap.appendChild(box);
            host.innerHTML = offlineNote;
            host.appendChild(wrap);
            return;
        }
        host.innerHTML = offlineNote + '<div class="card">' + items.map((it) => {
            const title = zhOn && it.titleZh ? it.titleZh : (it.title || "");
            const alt = zhOn ? (it.title || "") : (it.titleZh || "");
            let kindLabel;
            if (it.kind === "post") kindLabel = t("bl.kind_post");
            else kindLabel = t("bl.kind_article");
            return '<a class="bl-row" href="#/blog/' + encodeURIComponent(String(it.id)) + '">'
                + '<span class="mono bl-date">' + escapeHtml(it.date || "\u2014") + '</span>'
                + '<span class="badge">' + escapeHtml(kindLabel) + '</span>'
                + '<span class="bl-title">' + escapeHtml(title) + (alt ? ' <span class="bl-title-alt">' + escapeHtml(alt) + "</span>" : "") + "</span>"
                + '<span class="bl-arrow">&#8594;</span></a>';
        }).join("") + "</div>";
    }
    async function loadUpdates() {
        try {
            const [st, cl] = await Promise.all([json(API_ROOT + "/update/state"), json(API_ROOT + "/changelog")]);
            upReleases = (cl && Array.isArray(cl.releases)) ? cl.releases.map((r) => String(r.tag || "")).filter(Boolean) : [];
            renderUpdateState(st);
        } catch (e) {
            // Both endpoints are fail-soft 200s; reaching here = proxy unreachable.
            toast(t("toast.failed", { msg: e.message }), "err");
        }
    }
    async function upInstall(version) {
        if (upBusyAction || !version) return;
        const running = $($("up-running") && "up-running") ? $("up-running").textContent.replace(/^v/i, "") : "";
        if (upCmpVer(version, running) < 0 && !window.confirm(t("up.rollback_confirm", { v: version }))) return;
        upBusyAction = true;
        upSetButtons(true);
        showUpdateResult(t("up.installing", {}), true);
        try {
            const r = await json(API_ROOT + "/update/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: version }) });
            if (r.already) showUpdateResult(t("up.already_in_flight"), true);
            else if (r.ok) showUpdateResult(t("up.installed", { v: version }), true);
            else showUpdateResult(String(r.error || t("toast.failed", { msg: "install failed" })), false);
        } catch (e) {
            showUpdateResult(e.message, false);
        } finally {
            upBusyAction = false;
            upSetButtons(false);
            loadUpdates();
        }
    }
    function upUpgradeNow() { upInstall(upNewestVersion(null).replace(/^v/, "")); }
    function upInstallSelected() { const sel = $("up-select"); if (sel && sel.value) upInstall(String(sel.value).replace(/^v/, "")); }
    async function upCheckNow() {
        if (upBusyAction) return;
        upBusyAction = true;
        upSetButtons(true);
        try {
            const r = await json(API_ROOT + "/update/check", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
            if (r.already) showUpdateResult(t("up.already_in_flight"), true);
            else if (r.ok) showUpdateResult(t("up.check_ok"), true);
            else showUpdateResult(String(r.error || t("toast.failed", { msg: "check failed" })), false);
        } catch (e) {
            showUpdateResult(e.message, false);
        } finally {
            upBusyAction = false;
            upSetButtons(false);
            loadUpdates();
        }
    }

    async function loadOverview(silent) {
        try {
            const d = await json(API_ROOT + "/overview");
            const o = d.overview || {};
            // #1426: total splits live vs historical (disk-restored pool entries are history);
            // counters without usage samples render "—" instead of a misleading 0; the saved
            // counter labels how much comes from pre-tagging local estimates (no cache ledger).
            const total = o.sessions || 0;
            const liveN = o.live || 0;
            $("st-sessions").textContent = String(total);
            $("st-sessions-sub").textContent = liveN + " " + t("ov.live_now") + " · " + Math.max(0, total - liveN) + " " + t("ov.hist");
            $("st-reqs").textContent = o.requests ? fmtW(o.requests) : t("common.none");
            const grossEl = $("st-gross");
            grossEl.textContent = o.grossSavedTotal ? fmtW(o.grossSavedTotal) : t("common.none");
            grossEl.title = o.grossSavedTotal ? String(Math.round(Number(o.grossSavedTotal))) : "";
            // #4899 v5: print THE prices inside the formula lines — only when
            // every priced session resolves identical rates; mixed fleets keep
            // plain ≈$ amounts (never a misleading single rate).
            const r6 = (x) => String(Math.round(x * 1e6) / 1e6);
            const mra = o.moneyRates ? { w: r6(o.moneyRates.w), r: r6(o.moneyRates.r), q: r6(o.moneyRates.q) } : null;
            $("st-gross-sub").textContent = t("ov.gross_note") + ((o.savedEstimated || 0) > 0 ? " · " + t("ov.saved_from_legacy", { n: fmtW(o.savedEstimated) }) : "")
                + (o.savedUsdGrossTotal
                    ? " · " + (mra ? t("ov.gross_formula", { f: o.foldsTotal, g: fmtW(o.grossSavedTotal), r: mra.r, n: fmtUsd(o.savedUsdGrossTotal) }) : t("ov.money_eq", { n: fmtUsd(o.savedUsdGrossTotal) }))
                    : "");
            const netEl = $("st-netsaved");
            netEl.textContent = o.hasFoldData ? ((o.netSavedTotal || 0) < 0 ? "-" : "") + fmtW(Math.abs(o.netSavedTotal || 0)) : t("common.none");
            netEl.title = o.hasFoldData && o.netSavedTotal ? String(Math.round(Number(o.netSavedTotal))) : "";
            $("st-net-sub").textContent = o.hasFoldData ? t("ov.sub_repay", { r: fmtW(o.repayTotal || 0), s: fmtW(o.summaryCostTotal || 0) }) + ((o.savedEstimated || 0) > 0 ? " · " + t("ov.net_excl") : "") + ((o.coverageLostFrozenTotal || 0) > 0 ? " · " + t("ov.covlost_note", { n: o.coverageLostFoldTotal || 0, x: fmtW(o.coverageLostFrozenTotal) }) : "") : "";
            if (o.hasFoldData && o.savedUsdTotal) $("st-net-sub").textContent += " · " + t("ov.money_eq", { n: fmtUsd(o.savedUsdTotal) }) + (mra ? " " + t("ov.net_rates", mra) : "");
            $("st-hitpct").textContent = o.hitPct == null ? t("common.none") : o.hitPct.toFixed(1) + "%";
            // #4899: fleet money totals — only priced sessions contribute; no
            // price data anywhere => dash, never $0.00 (honest-output rule).
            const spendEl = $("st-spend");
            if (spendEl) {
                spendEl.textContent = o.hasMoneyData ? fmtUsd(o.costUsdTotal || 0) : t("common.none");
                $("st-spend-sub").textContent = o.hasMoneyData && (o.savedUsdTotal || 0) !== 0
                    ? t("ov.money_saved", { n: fmtUsd(o.savedUsdTotal) })
                    : (o.hasMoneyData ? t("ov.money_none") : "");
            }
            const hs = $("st-hit-split");
            // #4899 v3: compression payback — colored net plus a break-even
            // line (green when avoided turns outrun the fold cost, red while
            // they haven't; turns here are the fleet Σ post-fold requests).
            const pbEl = $("st-payback");
            if (pbEl) {
                const pbCard = $("st-payback-card");
                if (o.paybackUsdTotal) {
                    const pbNet = (o.paybackUsdTotal.saved || 0) - (o.paybackUsdTotal.spent || 0);
                    pbEl.textContent = "\u2248 " + fmtUsd(pbNet);
                    pbEl.title = String(Math.round(pbNet * 1e4) / 1e4);
                    pbCard.classList.remove("good", "bad");
                    if (pbNet !== 0) pbCard.classList.add(pbNet >= 0 ? "good" : "bad");
                    const turns = o.paybackUsdTotal.turns || 0;
                    const avgPerTurn = turns > 0 ? (o.paybackUsdTotal.saved || 0) / turns : 0;
                    let sub = t("ov.payback_sub", { v: fmtUsd(o.paybackUsdTotal.saved || 0), s: fmtUsd(o.paybackUsdTotal.spent || 0) });
                    if (avgPerTurn > 0 && (o.paybackUsdTotal.spent || 0) > 0) {
                        const be = o.paybackUsdTotal.spent / avgPerTurn;
                        sub += " · " + (turns >= be ? t("ov.payback_ok") : t("ov.payback_wait", { k: Math.max(1, Math.ceil(be - turns)) }));
                    } else if (pbNet >= 0) sub += " · " + t("ov.payback_ok");
                    if (mra) sub += " · " + t("ov.payback_rates", mra);
                    $("st-payback-sub").textContent = sub;
                } else {
                    pbEl.textContent = t("common.none");
                    pbCard.classList.remove("good", "bad");
                    $("st-payback-sub").textContent = "";
                }
            }
            if (hs) {
                const missSum = (o.missNewTotal || 0) + (o.missCompTotal || 0) + (o.missTtlTotal || 0);
                const mi = o.missInputTotal || 0;
                const f = (v) => fmtW(v) + (mi > 0 ? " (−" + ((v / mi) * 100).toFixed(1) + "%)" : "");
                hs.textContent = missSum > 0 ? t("ov.miss_split", { n: f(o.missNewTotal || 0), c: f(o.missCompTotal || 0), x: f(o.missTtlTotal || 0) }) : t("common.none");
                if (o.missSplitUsdTotal)
                    hs.textContent += " · " + t("ov.miss_split_usd", { n: fmtUsd(o.missSplitUsdTotal.n), c: fmtUsd(o.missSplitUsdTotal.c), x: fmtUsd(o.missSplitUsdTotal.x) }) + (mra ? " " + t("ov.miss_rates", mra) : "");
            }
            $("st-input").textContent = o.inputTokens ? fmtW(o.inputTokens) : t("common.none");
            $("st-cached").textContent = o.cachedTokens ? fmtW(o.cachedTokens) : t("common.none");
            $("st-output").textContent = o.outputTokens ? fmtW(o.outputTokens) : t("common.none");
            // #4899 v3: each token card carries its own ≈$ tier — together they
            // reconcile with the 花费 card (i + r + w + o == costUsdTotal), so
            // every displayed token figure has a money face next to it.
            const cu = o.costUsdSplitTotal;
            $("st-input-sub").textContent = cu ? t("ov.tier_unhit", { n: fmtUsd(cu.i) }) + (mra ? " · " + t("ov.at_input", { v: mra.w }) : "") : "";
            $("st-cached-sub").textContent = cu ? t("ov.money_eq", { n: fmtUsd(cu.r) }) + (mra ? " · " + t("ov.at_read", { v: mra.r }) : "") : "";
            $("st-output-sub").textContent = cu ? t("ov.money_eq", { n: fmtUsd(cu.o) }) + (mra ? " · " + t("ov.at_output", { v: mra.q }) : "") : "";
            const pb = $("protocol-body");
            pb.innerHTML = "";
            const rows = (o.byProtocol || []).slice().sort((a, b) => b.sessions - a.sessions || b.requests - a.requests);
            if (!rows.length) pb.innerHTML = '<tr><td colspan="8" class="dim">' + t("common.empty") + "</td></tr>";
            rows.forEach((r) => {
                const tr = document.createElement("tr");
                tr.innerHTML = '<td>' + protoBadge(r.protocol) + '</td><td class="num">' + r.sessions + '</td><td class="num">' + (r.requests ? fmtW(r.requests) : t("common.none")) + '</td><td class="num">' + (r.inputTokens ? fmtW(r.inputTokens) : t("common.none")) + '</td><td class="num">' + (r.cachedTokens ? fmtW(r.cachedTokens) : t("common.none")) + '</td>' + hitTd({ cacheHitPct: r.hitPct, missDropNew: r.missDropNew, missDropComp: r.missDropComp, missDropTtl: r.missDropTtl }) + '<td class="' + (r.savedNet > 0 ? "num good-num" : "num") + '"' + (r.savedNet < 0 ? ' title="' + escapeHtml(t("ov.saved_neg_tip")) + '"' : "") + '">' + (r.savedNet ? fmtW(r.savedNet) : t("common.none")) + moneySub({ savedUsd: r.savedUsd }) + '</td><td class="num">' + (r.folds ? fmtW(r.folds) : t("common.none")) + "</td>";
                pb.appendChild(tr);
            });
            $("sys-version").textContent = d.version ? (d.commit ? d.version + " (" + d.commit + ")" : d.version) : "?";
            $("sys-lane").textContent = d.origin || t("common.none");
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
        // #1870 web surface: critical update notice (#1977 — only critical
        // spans ever reach here; the server sends null otherwise). Kept ABOVE
        // the stale banner: it carries the release context (version + summary),
        // while stale-banner stays the generic disk-vs-running restart cue.
        const ub = $("update-banner");
        if (ub) {
            const u = d.updateReady;
            if (u && typeof u === "object" && typeof u.version === "string") {
                // compose per locale from kind/version/summary — "available"
                // carries the MINIMUM fixed version, so each locale can say
                // "v{version} 或更新版本" / "v{version} or newer" separately.
                const vars = { version: u.version, summary: u.summary || "" };
                // #3719 item3: locale-aware summary — zh gets summaryZh when
                // the entry carries one (release-notes bilingual support).
                if (locale === "zh-CN" && typeof u.summaryZh === "string" && u.summaryZh) vars.summary = u.summaryZh;
                const line = u.kind === "ready" ? t("sys.update_ready", vars) : t("sys.update_available", vars);
                ub.hidden = false;
                ub.classList.add("show");
                ub.innerHTML = "<strong>" + t("sys.update") + "</strong> " + escapeHtml(line);
                // #3719 item3: one-click upgrade straight from the banner when
                // the fix is still "available" (ready = already on disk, just
                // restart). Reuses the phase-2 install endpoint + its safety
                // chain; feedback stays inside the banner.
                if (u.kind === "available") {
                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = "banner-upgrade-now";
                    btn.textContent = t("sys.update_now", { version: u.version });
                    btn.addEventListener("click", async () => {
                        btn.disabled = true;
                        btn.textContent = t("sys.updating", {});
                        try {
                            const r = await json(API_ROOT + "/update/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: u.version }) });
                            if (r && (r.ok || r.already)) btn.textContent = t("sys.update_done", { version: u.version });
                            else { btn.textContent = String((r && r.error) || "install failed"); btn.disabled = false; }
                        } catch (e) {
                            btn.textContent = String((e && e.message) || e);
                            btn.disabled = false;
                        }
                    });
                    ub.appendChild(btn);
                }
            } else {
                ub.hidden = true;
                ub.classList.remove("show");
                ub.innerHTML = "";
            }
        }
        // #3619: hold/pinned are the policy BRAKE states (auto-upgrades frozen
        // fleet-wide) — the issue requires them user-visible with the escape hatch.
        const upb = $("update-policy-banner");
        if (upb) {
            const lines = [];
            const up = d.updatePolicy;
            if (up && typeof up === "object") {
                if (up.hold === true) lines.push(t("sys.policy_hold"));
                if (typeof up.pinned === "string" && up.pinned) lines.push(t("sys.policy_pinned", { version: up.pinned }));
            }
            if (lines.length) {
                upb.hidden = false;
                upb.classList.add("show");
                upb.innerHTML = "<strong>" + t("sys.policy_title") + "</strong> " + lines.map(escapeHtml).join("<br>");
            } else {
                upb.hidden = true;
                upb.classList.remove("show");
                upb.innerHTML = "";
            }
        }
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
        // #3581/#3651: takeover-attribution failure notice — under the #3651
        // owner contract only DIAGNOSABLE failures reach this surface (threw
        // episodes report error text + masked endpoint; by-design agentless
        // lanes never report), so a visible banner always names what failed.
        // Shown only when traffic is actually going direct: at least one agent
        // is degraded AND no session is live (live > 0 means compression is
        // still serving this host, so the bare "0 running" sub-line is not
        // misleading).
        const attEl = $("attribution-banner");
        if (attEl) {
            const att = d.attribution;
            const degraded = att && typeof att === "object"
                ? Object.entries(att).filter(([, a]) => a && typeof a === "object" && a.state !== "ok" && (a.refusals || 0) > 0)
                : [];
            // #3581: only meaningful while nothing runs — with live sessions the
            // takeover is demonstrably working for them.
            const show = degraded.length > 0 && ((d.overview || {}).live || 0) === 0;
            if (show) {
                const [agent, entry] = degraded[0];
                const sinceText = entry.since > 0 ? new Date(entry.since).toLocaleString() : "?";
                attEl.hidden = false;
                attEl.classList.add("show");
                attEl.innerHTML = "<strong>" + escapeHtml(t("sys.attribution_broken", { agent: agent, n: entry.refusals })) + "</strong>"
                    + (entry.error ? '<div class="mono">' + escapeHtml(t("sys.attribution_error", { err: String(entry.error) })) + "</div>" : "")
                    + "<div>" + escapeHtml(t("sys.attribution_impact", { since: sinceText })) + "</div>"
                    + '<div style="margin-top:8px;display:flex;gap:8px">'
                    + '<button id="report-copy-btn" class="btn sm">' + t("sys.report_copy") + "</button>"
                    + '<a id="report-issue-link" class="btn sm" target="_blank" rel="noopener noreferrer" href="#">' + t("sys.report_issue") + "</a>"
                    + "</div>";
                attachReportButtons("attribution", attEl);
            } else {
                attEl.hidden = true;
                attEl.classList.remove("show");
                attEl.innerHTML = "";
            }
        }
        const sb = $("storage-degraded-banner");
        if (sb) {
            const sg = d.storage;
            if (sg && sg.degraded) {
                sb.hidden = false;
                sb.classList.add("show");
                sb.innerHTML = "<strong>" + t("sys.storage_degraded_title") + "</strong> " + escapeHtml(t("sys.storage_degraded", { reason: sg.reason || "" }))
                    + '<div style="margin-top:8px;display:flex;gap:8px">'
                    + '<button id="report-copy-btn" class="btn sm">' + t("sys.report_copy") + "</button>"
                    + '<a id="report-issue-link" class="btn sm" target="_blank" rel="noopener noreferrer" href="#">' + t("sys.report_issue") + "</a>"
                    + "</div>";
                attachReportButtons("storage-legacy-only", sb);
            } else {
                sb.hidden = true;
                sb.classList.remove("show");
                sb.innerHTML = "";
            }
        }
        const sh = $("snapshot-shadow-banner");
        if (sh) {
            const sw = d.snapshotShadow;
            if (sw && sw.enabled && sw.errors > 0) {
                sh.hidden = false;
                sh.classList.add("show");
                const worstTxt = sw.worst ? "（" + (sw.worst.label ?? sw.worst.sessionId) + "）" : "";
                sh.innerHTML = "<strong>" + t("sys.snapshot_shadow_title") + "</strong> " + escapeHtml(t("sys.snapshot_shadow", { n: String(sw.errors), worst: worstTxt }))
                    + '<div style="margin-top:8px;display:flex;gap:8px">'
                    + '<button id="report-copy-btn" class="btn sm">' + t("sys.report_copy") + "</button>"
                    + '<a id="report-issue-link" class="btn sm" target="_blank" rel="noopener noreferrer" href="#">' + t("sys.report_issue") + "</a>"
                    + "</div>";
                attachReportButtons("snapshot-shadow", sh);
            } else {
                sh.hidden = true;
                sh.classList.remove("show");
                sh.innerHTML = "";
            }
        }
        const spb = $("storage-second-process-banner");
        if (spb) {
            const sg2 = d.storage;
            const sp = sg2 && typeof sg2 === "object" ? sg2.secondProcess : null;
            if (sp && typeof sp.pid === "number") {
                spb.hidden = false;
                spb.classList.add("show");
                // #3923/#3959: a known bili instance of a DIFFERENT lane sharing
                // the machine-global sessions dir is the supported topology —
                // informational styling, not a corruption alarm.
                if (sp.benign === true) {
                    spb.classList.remove("warn");
                    spb.classList.add("info");
                    spb.innerHTML = "<strong>" + escapeHtml(t("sys.storage_second_process_cross_lane_title")) + "</strong> " + escapeHtml(t("sys.storage_second_process_cross_lane", { pid: String(sp.pid), lane: typeof sp.lane === "string" && sp.lane ? sp.lane : t("sys.split_brain_lane_undeclared") }));
                } else {
                    spb.classList.remove("info");
                    spb.classList.add("warn");
                    spb.innerHTML = "<strong>" + escapeHtml(t("sys.storage_second_process_title")) + "</strong> " + escapeHtml(t("sys.storage_second_process", { pid: String(sp.pid) }));
                }
            } else {
                spb.hidden = true;
                spb.classList.remove("show");
                spb.innerHTML = "";
            }
        }
        const sbb = $("split-brain-banner");
        if (sbb) {
            // #3923/#3959: a REAL contest — session id + title + both sides'
            // pid/lane, with a dismiss action that clears the surfaced entry.
            const sb = d.storage && typeof d.storage === "object" ? d.storage.splitBrain : null;
            if (sb && typeof sb.sessionId === "string" && sb.self && typeof sb.self.pid === "number" && sb.peer && typeof sb.peer.pid === "number") {
                sbb.hidden = false;
                sbb.classList.add("show");
                const laneOf = (x) => (x && typeof x.lane === "string" && x.lane ? x.lane : t("sys.split_brain_lane_undeclared"));
                sbb.innerHTML = "<strong>" + escapeHtml(t("sys.split_brain_title")) + "</strong> "
                    + escapeHtml(t("sys.split_brain", {
                        title: typeof sb.title === "string" && sb.title ? sb.title : sb.sessionId.slice(0, 8),
                        sid: sb.sessionId.slice(0, 8),
                        selfPid: String(sb.self.pid),
                        selfLane: laneOf(sb.self),
                        peerPid: String(sb.peer.pid),
                        peerLane: laneOf(sb.peer),
                    }))
                    + '<div style="margin-top:8px"><button id="split-brain-ack-btn" class="btn sm">' + escapeHtml(t("sys.split_brain_ack_btn")) + "</button></div>";
                const ackBtn = $("split-brain-ack-btn");
                if (ackBtn) ackBtn.addEventListener("click", async () => {
                    busy(ackBtn, true);
                    try {
                        await json(API_ROOT + "/storage/split-brain/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sb.sessionId }) });
                        toast(t("sys.split_brain_acked"), "ok");
                        await loadOverview(true);
                    } catch (e) {
                        toast(e instanceof Error ? e.message : String(e), "err");
                    } finally {
                        busy(ackBtn, false);
                    }
                });
            } else {
                sbb.hidden = true;
                sbb.classList.remove("show");
                sbb.innerHTML = "";
            }
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
            // #2430/#2545: neutral-only ledgers stand down — bili's own family (billion-
            // context-pi / opencode-acp) is compatible and verified read-only viewers are not
            // compressors, so such ledgers are not warnings. The events stay recorded
            // (acp_status keeps the calm #2261 footer); only the banner goes quiet.
            // #3235: the banner now requires LANDED-UNRECOVERED evidence (interception
            // actually failed) — suspected-tier stock alone no longer pops — and a persisted
            // dismissal (#3235) quiets it until a newer event re-arms the alarm.
            const sev0 = c && c.events > 0 ? bili_conflictSeverity(c) : null;
            const dismissed = c && c.events > 0 ? bili_conflictDismissed(c, loadConflictDismiss()) : false;
            if (c && c.events > 0 && sev0 && sev0.landed && !dismissed) {
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
                cb.innerHTML = '<strong>' + sev.onText + "</strong>" + t("conflict.found") + escapeHtml(sev.what) + sev.riskText + '<span class="mono">(' + bili_conflictLine(c) + ")</span>" + (sev.showHints ? conflictHintBlock(c.clients) : "") + t("conflict.where") + '<button id="conflicts-clear-btn" class="btn sm">' + t("conflict.clear_btn") + "</button>" + '<button id="conflicts-dismiss-btn" class="btn sm">' + t("conflict.dismiss") + "</button>" + '<button id="report-copy-btn" class="btn sm">' + t("sys.report_copy") + "</button>" + '<a id="report-issue-link" class="btn sm" target="_blank" rel="noopener noreferrer" href="#">' + t("sys.report_issue") + "</a>";
                // #2545: red styling follows CONFIRMED liveness — a fresh unconfirmed
                // signal beside a stale confirmed ledger renders as info, not warn.
                cb.classList.toggle("info", !(sev.hasConfirmed && sev.activeConfirmed > 0));
                cb.classList.toggle("warn", sev.hasConfirmed && sev.activeConfirmed > 0);
                const btn = $("conflicts-clear-btn");
                if (btn) {
                    btn.addEventListener("click", async () => {
                        busy(btn, true);
                        try {
                            await json(API_ROOT + "/conflicts/clear", { method: "POST" });
                            toast(t("conflict.cleared"), "ok");
                            await loadOverview(true);
                        } catch (e) {
                            toast(e.message, "err");
                        } finally {
                            busy(btn, false);
                        }
                    });
                }
                const dBtn = $("conflicts-dismiss-btn");
                if (dBtn) {
                    dBtn.addEventListener("click", () => {
                        saveConflictDismiss(c);
                        toast(t("conflict.dismissed"), "ok");
                        cb.hidden = true;
                        cb.classList.remove("show");
                        cb.innerHTML = "";
                    });
                }
                // #3235: ride the shared #3040 report wiring — copy diagnostics + prefilled
                // GitHub issue link, cached per topic so the 5s overview poll stays cheap.
                attachReportButtons("conflict-banner", cb);
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
        const pb = $("plugin-advisory-banner");
        if (pb) {
            const advs = Array.isArray(d.pluginAdvisories) ? d.pluginAdvisories : [];
            if (advs.length > 0) {
                pb.hidden = false;
                pb.classList.add("show");
                pb.innerHTML = bili_pluginAdvisoryBanner(advs, { on: t("pluginadv.on"), desc: t("pluginadv.desc"), hint: t("pluginadv.hint") });
            } else {
                pb.hidden = true;
                pb.classList.remove("show");
                pb.innerHTML = "";
            }
        }
        // #2645: the key-hostile upstream pairs learned by A/B this process
        // (in-memory only — a restart re-probes and clears them).
        const kb = $("pck-banner");
        if (kb) {
            const pcks = Array.isArray(d.pckSuppressions) ? d.pckSuppressions : [];
            if (pcks.length > 0) {
                kb.hidden = false;
                kb.classList.add("show");
                const items = pcks.slice(0, 3).map((p) => [
                    (p.model ? '<span class="mono">' + escapeHtml(p.model) + "</span>: " : "") + '<span class="mono">' + escapeHtml(p.origin) + "</span>",
                    p.sessions && p.sessions.length > 0 ? t("pck.sessions", { ids: escapeHtml(p.sessions.join(", ")) }) : null,
                ].filter(Boolean).join(" ")).join(" · ");
                kb.innerHTML = "<strong>" + t("pck.on") + '</strong> <span class="mono">' + items + "</span> " + t("pck.hint");
            } else {
                kb.hidden = true;
                kb.classList.remove("show");
                kb.innerHTML = "";
            }
        }
        // #2861: host-side metering plugin notice — dismissal is server-side
        // (POST /__bili/host-plugins/dismiss) so one close silences every browser.
        const hb = $("host-plugin-banner");
        if (hb) {
            const hns = Array.isArray(d.hostPluginNotices) ? d.hostPluginNotices : [];
            if (hns.length > 0) {
                hb.hidden = false;
                hb.classList.add("show");
                hb.innerHTML = bili_hostPluginBanner(hns, { on: t("hostplug.on"), desc: t("hostplug.desc"), hint: t("hostplug.hint"), dismiss: t("hostplug.dismiss_btn") });
                for (const btn of Array.from(hb.querySelectorAll(".host-plugin-dismiss"))) {
                    btn.addEventListener("click", async () => {
                        busy(btn, true);
                        try {
                            await json(API_ROOT + "/host-plugins/dismiss", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: btn.getAttribute("data-hpid") || "" }) });
                            toast(t("hostplug.dismissed"), "ok");
                            await loadOverview(true);
                        } catch (e) {
                            toast(e.message, "err");
                        } finally {
                            busy(btn, false);
                        }
                    });
                }
            } else {
                hb.hidden = true;
                hb.classList.remove("show");
                hb.innerHTML = "";
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
            // #2809: the server-side note names the proxy default-direct mode
            // skipped. Rendered from the STRUCTURED fields (skippedProxy /
            // skippedSource) through the catalog — the per-kind hint above is
            // static and can't carry dynamic values; a.hint (full English
            // string) stays for JSON consumers only.
            const baseHint = alertHint(a.kind);
            const skippedNote = a.skippedProxy ? " " + t("alert.note.skipped_proxy", { proxy: a.skippedProxy, source: a.skippedSource || "" }) : "";
            msg.textContent = t("alert.item", { host: a.host, kind: a.kind, count: a.count, first: fmtDT(a.firstSeen), hint: baseHint + skippedNote });
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
        chartZooms.forEach((z) => { z.state = null; z.range = null; });
        await refreshSessions(true);
    }
    let hiddenEmptyN = 0;
    // #1937：服务端筛选后分页；改变筛选返回首页，翻页替换当前页。
    async function refreshSessions(showToast, page) {
        const requestId = ++sesRequestId;
        try {
            const requested = Math.max(1, Math.floor(Number(page) || 1));
            const d = await json(sessionListUrl(requested));
            if (requestId !== sesRequestId) return true;
            const total = typeof d.total === "number" ? d.total : (d.sessions || []).length;
            const pages = Math.max(1, Math.ceil(total / SES_PAGE_SIZE));
            if (requested > pages) return await refreshSessions(showToast, pages);
            sessionsCache = d.sessions || [];
            sesTotal = total;
            sesUnfilteredTotal = typeof d.unfilteredTotal === "number" ? d.unfilteredTotal : sesTotal;
            sesPage = typeof d.page === "number" ? d.page : requested;
            sesPages = pages;
            hiddenEmptyN = d.hiddenEmpty || 0;
            updateFacetOptions(d);
            renderSessionTable();
            updatePager();
            return true;
        } catch (e) {
            if (requestId !== sesRequestId) return true;
            lastErrMsg = friendlyMsg(e);
            if (showToast) toast(t("toast.failed", { msg: lastErrMsg }), "err");
            return false;
        }
    }
    function sessionListUrl(page) {
        const input = $("ses-search");
        const q = ((input && input.value) || "").trim();
        const protocol = filterValue("ses-protocol");
        const client = filterValue("ses-client");
        const state = filterValue("ses-state");
        return API_ROOT + "/sessions?page=" + page + "&pageSize=" + SES_PAGE_SIZE +
            (q ? "&q=" + encodeURIComponent(q) : "") +
            (protocol ? "&protocol=" + encodeURIComponent(protocol) : "") +
            (client ? "&client=" + encodeURIComponent(client) : "") +
            (state ? "&state=" + encodeURIComponent(state) : "");
    }
    function filterValue(id) {
        const el = $(id);
        return ((el && el.value) || "").trim();
    }
    function facetLabel(kind, value) {
        if (kind === "protocol") return value === "unknown" ? t("ses.filter_unknown") : value;
        return value;
    }
    function fillFacet(id, values, allLabel, kind) {
        const sel = $(id);
        if (!sel) return;
        const active = sel.value || "";
        const frag = document.createDocumentFragment ? document.createDocumentFragment() : document.createElement("div");
        const all = document.createElement("option");
        all.value = "";
        all.textContent = allLabel;
        frag.appendChild(all);
        values.forEach((value) => {
            const opt = document.createElement("option");
            opt.value = value;
            opt.textContent = facetLabel(kind, value);
            frag.appendChild(opt);
        });
        sel.textContent = "";
        sel.appendChild(frag);
        if (active) sel.value = active;
        if (active && sel.value !== active) {
            const stale = document.createElement("option");
            stale.value = active;
            stale.textContent = facetLabel(kind, active);
            sel.appendChild(stale);
            sel.value = active;
        }
    }
    function updateFacetOptions(d) {
        fillFacet("ses-protocol", Array.isArray(d.protocols) ? d.protocols : [], t("ses.filter_all"), "protocol");
        fillFacet("ses-client", Array.isArray(d.clients) ? d.clients : [], t("ses.filter_all_clients"), "client");
    }
    function hasActiveFilters() {
        const q = (($("ses-search") && $("ses-search").value) || "").trim();
        return Boolean(q || filterValue("ses-protocol") || filterValue("ses-client") || filterValue("ses-state"));
    }
    function updatePager() {
        const prev = $("ses-prev");
        const next = $("ses-next");
        if (prev) prev.disabled = sesPage <= 1;
        if (next) next.disabled = sesPage >= sesPages;
        const label = $("ses-page-label");
        if (label) label.textContent = t("ses.page_label", { page: sesPage, pages: sesPages });
    }
    async function goToSessionPage(page) {
        const target = Math.min(Math.max(1, page), sesPages);
        if (target === sesPage) return true;
        const prev = $("ses-prev");
        const next = $("ses-next");
        if (prev) busy(prev, true);
        if (next) busy(next, true);
        try {
            return await refreshSessions(true, target);
        } finally {
            if (prev) busy(prev, false);
            if (next) busy(next, false);
            updatePager();
        }
    }
    function resetSessionFilters() {
        const search = $("ses-search");
        if (search) search.value = "";
        ["ses-protocol", "ses-client", "ses-state"].forEach((id) => { const el = $(id); if (el) el.value = ""; });
        return refreshSessions(false, 1);
    }
    function renderSessionTable() {
        const rows = sessionsCache;
        $("ses-count").textContent = hasActiveFilters()
            ? t("ses.filtered_count", { shown: sesTotal, total: sesUnfilteredTotal })
            : t("ses.count", { count: sesTotal });
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
    // #2489: chart geometry shared by the renderer and the brush interaction below.
    const TRAJ_W = 960, TRAJ_H = 260, TRAJ_PL = 56, TRAJ_PR = 16, TRAJ_PT = 14, TRAJ_PB = 26;
    const TRAJ_MIN_SAMPLES = 5;
    // #3484: per-sample miss-cause palette + labels shared by the trajectory gap bands
    // (#2929) and the hit-rate line markers — one definition so both charts paint the
    // same bucket membership the economics card aggregates.
    const CAUSE_COLOR = { cold: "#6e7681", comp: "#bf8700", seam: "#cf222e", pt: "#1a7f37", ps: "#f0883e", rw: "#57606a", ci: "#0969da", rest: "#9aa1a8" };
    const CAUSE_KEY = { cold: "det.cause_cold", comp: "det.cause_comp", seam: "det.legend_seam", pt: "det.leg_pttl", ps: "det.leg_pside", rw: "det.leg_rewind", ci: "det.leg_client", rest: "det.cause_ttl" };
    // #2929/#3484: per-sample causes follow the LEDGER's authoritative attribution
    // (foldSeq / seam / prov), not a parallel heuristic — the charts paint the same
    // bucket membership the economics card aggregates. The gap heuristic remains only
    // as the legacy fallback for old ledgers whose lines carry no attribution fields.
    // The fold cold-tail window mirrors the ledger's own: a fold owns the first sample
    // after it AND the cold continuation (hit < 85%) up to 4 samples, closing on the
    // first warm line. Ledger lines carry foldSeq directly; the fold-between-times
    // heuristic stays as the opener and for pre-#2929 ledgers without foldSeq. The
    // tail counter arms ONLY on that opener path: foldSeq-stamped lines are the
    // ledger's own attribution and must not re-arm, or the chart keeps coloring comp
    // up to 4 lines past the ledger retiring the window.
    function classifyLineCauses(lines, folds) {
        const GAP_MS = 600_000;
        let foldTailClaims = 0;
        return lines.map((l, i) => {
            if (i === 0) return !(l.cached || 0) ? "cold" : "new";
            const p = lines[i - 1];
            const missed = (l.input || 0) - (l.cached || 0);
            const growth = Math.max(0, (l.input || 0) - (p.input || 0));
            const warm = (l.hitPct || 0) >= 85;
            const foldBetween = (folds || []).some((f) => (f.at || 0) >= (p.at || 0) && (f.at || 0) <= (l.at || 0));
            const foldOwned = l.foldSeq != null || foldBetween;
            let tailComp = false;
            if (warm) {
                foldTailClaims = 0;
            } else if (foldBetween && l.foldSeq == null) {
                // Opener heuristic (pre-#2929 ledgers / unattributed openers):
                // 3 continuation rounds after this one (FOLD_CLAIM_COLD_ROUNDS − 1).
                foldTailClaims = 3;
            } else if (foldTailClaims > 0 && missed > growth + 256) {
                foldTailClaims -= 1;
                tailComp = true;
            }
            if ((foldOwned || tailComp) && missed > growth + 256) return "comp";
            // Authoritative unattributed sub-causes (#2929 ledger fields):
            if (l.seam === 1) return "seam";
            if (l.prov === "ttl") return "pt";
            if (l.prov === "side") return "ps";
            if (l.prov === "rewind") return "rw";
            if (l.prov === "client") return "ci";
            // Legacy fallback only: no attribution fields on this line.
            if (l.foldSeq == null && l.seam === undefined && l.prov === undefined && (l.at || 0) - (p.at || 0) > GAP_MS && missed > growth + 2048) return "rest";
            return "new";
        });
    }
    // #2489/#3484: vertical event marks shared by both detail charts. Folds stay
    // dashed red, seams solid red (#1609 visual language); burst-folds share
    // (near-)identical timestamps and thus the same pixel — merge them into one
    // marker per pixel-bucket so stacked marks don't ghost into doubled lines.
    function foldMarkLines(folds, lines, x, PT, ih) {
        let foldMarks = "";
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
                + t("det.fold_short") + (n > 1 ? " ×" + n : "") + (seqs ? " " + seqs + (bk.items.length > 5 ? "…" : "") + " · " : " ") + fmtDT(bk.items[0].at) + " · " + fmtW(bk.items.reduce((a, m) => a + (m.S || 0), 0)) + "</title></line>";
        });
        return foldMarks;
    }
    // #1609: cache-seam suspects (#1606) get SOLID red marks at the first sample at/after
    // the divergence time — folds stay dashed, so both read in the same visual language.
    function seamMarkLines(seamEvents, lines, x, PT, ih) {
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
                + t("det.seam_mark_tip", { seq: ev.seq != null ? ev.seq : "?", at: fmtDT(ev.at), hit, lcp, msg, prev, cur }) + "</title></line>";
        });
        return seamMarks;
    }
    // #2929/#3484: pixel-driven seq ticks shared by both detail charts — every band must map
    // to a visible index, not "somewhere between 5 and 10". Thinning is PIXEL-driven, not
    // count-driven: real sessions carry hundreds/thousands of samples (~0.4px/sample), where
    // any flat count step either mosaics the axis or drops to two naked numbers. Vertical
    // (rotated) ticks reclaim the unused Y range; hold a constant ≥24px HORIZONTAL pitch.
    // NO Math.max(barW,1) floor — that clamps sub-pixel bars UP to 1 and silently disables
    // thinning exactly on the dense sessions this exists for.
    function seqTickLines(lines, x, W, H, PL, PR) {
        const barW = lines.length > 1 ? (W - PL - PR) / (lines.length - 1) : 1;
        const tStep = Math.max(1, Math.ceil(24 / barW));
        const xtArr = [];
        for (let i = lines.length - 1; i >= 0; i -= tStep) {
            const l = lines[i];
            xtArr.push('<text transform="translate(' + x(i).toFixed(1) + ',' + (H - 28) + ') rotate(-90)" text-anchor="end" font-size="10" fill="var(--text-muted)">' + l.seq + "</text>");
        }
        const xt = xtArr.join("");
        const xtTime =
            (lines[0] && lines[0].at ? '<text x="' + PL + '" y="' + (H - 8) + '" text-anchor="start" font-size="9.5" fill="var(--text-faint)">' + fmtDT(lines[0].at) + "</text>" : "")
            + (lines.length > 1 && lines[lines.length - 1].at ? '<text x="' + (W - PR) + '" y="' + (H - 8) + '" text-anchor="end" font-size="9.5" fill="var(--text-faint)">' + fmtDT(lines[lines.length - 1].at) + "</text>" : "");
        return xt + xtTime;
    }
    function trajectorySvg(lines, folds, win, baseIn, seamEvents) {
        lines = (lines || []).filter((l) => Boolean(l));
        if (!lines.length) return "";
        const W = TRAJ_W, H = TRAJ_H, PL = TRAJ_PL, PR = TRAJ_PR, PT = TRAJ_PT, PB = TRAJ_PB;
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
        // Classification lives in classifyLineCauses (#2929/#3484) — shared with
        // the hit-rate line markers so both charts name the same buckets.
        const causes = classifyLineCauses(lines, folds);
        let bands = "", hovers = "";
        const swSeg = lines.length === 1 ? iw : iw / (lines.length - 1);
        lines.forEach((l, i) => {
            const c = causes[i];
            const yIn = y(l.input || 0), yCa = y(l.cached || 0);
            const x0 = Math.max(PL, x(i) - swSeg / 2), x1 = Math.min(W - PR, x(i) + swSeg / 2);
            if (c !== "new") {
                bands += '<rect x="' + x0.toFixed(1) + '" y="' + yIn.toFixed(1) + '" width="' + Math.max(1, x1 - x0).toFixed(1) + '" height="' + Math.max(3, yCa - yIn).toFixed(1) + '" fill="' + CAUSE_COLOR[c] + '" opacity="0.35" rx="1"/>';
                // Vertical spine: the miss band floats above the cache line, so drop
                // a thin same-colour rule down to the baseline — the bar the band
                // belongs to becomes self-evident instead of floating free.
                bands += '<line x1="' + x(i).toFixed(1) + '" x2="' + x(i).toFixed(1) + '" y1="' + (yCa - 2).toFixed(1) + '" y2="' + ih.toFixed(1) + '" stroke="' + CAUSE_COLOR[c] + '" stroke-width="1" opacity="0.45"/>';
            }
            const hitPctLine = (l.input || 0) > 0 ? ((l.cached || 0) / l.input * 100).toFixed(1) + "%" : t("common.none");
            hovers += '<rect x="' + x0.toFixed(1) + '" y="' + PT + '" width="' + Math.max(1, x1 - x0).toFixed(1) + '" height="' + ih + '" fill="transparent"><title>'
                + (l.seq != null ? "#" + l.seq + " · " : "") + dt(l.at)
                + "\\nin " + fmtW(l.input || 0) + " · cached " + fmtW(l.cached || 0) + " · missed " + fmtW((l.input || 0) - (l.cached || 0)) + " · hit " + hitPctLine
                + (c === "new" ? "" : "\\n" + t(CAUSE_KEY[c])) + "</title></rect>";
        });
        const foldMarks = foldMarkLines(folds, lines, x, PT, ih);
        const seamMarks = seamMarkLines(seamEvents, lines, x, PT, ih);
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
        const xt = seqTickLines(lines, x, W, H, PL, PR);
        return '<svg viewBox="0 0 ' + W + " " + H + '" class="chart-svg" role="img">' + grid
            + '<path d="' + area + '" fill="var(--accent)" opacity="0.18"/>'
            + bands
            + hovers
            + '<path d="' + stroke.trim() + '" fill="none" stroke="var(--accent)" stroke-width="1.8"/>'
            + foldMarks + seamMarks + ceiling + baseline + ticks + xt + "</svg>";
    }
    // #3484: per-request cache hit-rate line — the trend view the numeric cards lack
    // (overview/list/card show one aggregate; this shows which rounds dipped and how far).
    // Y axis is fixed 0–100% so drops read at a glance; non-"new" samples get a cause dot
    // from the exact ledger-backed classification the trajectory bands paint, and the
    // hover column names the cause. Same geometry and brush-zoom contract as trajectorySvg.
    function hitRateSvg(lines, folds, seamEvents) {
        lines = (lines || []).filter((l) => Boolean(l));
        if (!lines.length) return "";
        const W = TRAJ_W, H = TRAJ_H, PL = TRAJ_PL, PR = TRAJ_PR, PT = TRAJ_PT, PB = TRAJ_PB;
        const iw = W - PL - PR, ih = H - PT - PB;
        const x = (i) => PL + (lines.length === 1 ? iw / 2 : (i / (lines.length - 1)) * iw);
        const y = (pct) => PT + ih - (Math.max(0, Math.min(100, pct)) / 100) * ih;
        const dt = (ms) => fmtDT(ms);
        // Ledger lines carry hitPct; older ledgers compute it from input/cached.
        // Zero-input samples have no defined rate — break the line there.
        const hp = (l) => l.hitPct != null ? l.hitPct : ((l.input || 0) > 0 ? ((l.cached || 0) / l.input) * 100 : null);
        let grid = "", ticks = "";
        for (let g = 0; g <= 4; g++) {
            const v = 25 * g;
            const yy = y(v);
            grid += '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="var(--border)" stroke-width="1"/>';
            ticks += '<text x="' + (PL - 6) + '" y="' + (yy + 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--text-muted)">' + v + "%</text>";
        }
        const causes = classifyLineCauses(lines, folds);
        let stroke = "", started = false;
        lines.forEach((l, i) => {
            const v = hp(l);
            if (v == null) { started = false; return; }
            stroke += (started ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1) + " ";
            started = true;
        });
        let dots = "", hovers = "";
        const swSeg = lines.length === 1 ? iw : iw / (lines.length - 1);
        lines.forEach((l, i) => {
            const c = causes[i];
            const v = hp(l);
            const x0 = Math.max(PL, x(i) - swSeg / 2), x1 = Math.min(W - PR, x(i) + swSeg / 2);
            if (v != null && c !== "new") dots += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.5" fill="' + CAUSE_COLOR[c] + '"/>';
            const hitTxt = v == null ? t("common.none") : v.toFixed(1) + "%";
            hovers += '<rect x="' + x0.toFixed(1) + '" y="' + PT + '" width="' + Math.max(1, x1 - x0).toFixed(1) + '" height="' + ih + '" fill="transparent"><title>'
                + (l.seq != null ? "#" + l.seq + " · " : "") + dt(l.at)
                + "\\nin " + fmtW(l.input || 0) + " · cached " + fmtW(l.cached || 0) + " · missed " + fmtW((l.input || 0) - (l.cached || 0)) + " · hit " + hitTxt
                + (c === "new" ? "" : "\\n" + t(CAUSE_KEY[c])) + "</title></rect>";
        });
        // Accent placeholder dot only when the sample carries no cause dot of its own —
        // a 1-line cold session must keep its cold color, not an accent dot on top.
        const singleDot = lines.length === 1 && hp(lines[0]) != null && causes[0] === "new"
            ? '<circle cx="' + x(0).toFixed(1) + '" cy="' + y(hp(lines[0])).toFixed(1) + '" r="3" fill="var(--accent)"/>'
            : "";
        const foldMarks = foldMarkLines(folds, lines, x, PT, ih);
        const seamMarks = seamMarkLines(seamEvents, lines, x, PT, ih);
        const xt = seqTickLines(lines, x, W, H, PL, PR);
        return '<svg viewBox="0 0 ' + W + " " + H + '" class="chart-svg" role="img">' + grid
            + (stroke.trim() ? '<path d="' + stroke.trim() + '" fill="none" stroke="var(--accent)" stroke-width="1.8"/>' : "")
            + dots + singleDot + hovers + foldMarks + seamMarks + ticks + xt + "</svg>";
    }
    function legendItem(style, label, dashed) {
        if (dashed) return '<span><span class="dot" style="background:none;border-top:2px dashed #cf222e;height:0;border-radius:0;width:14px"></span>' + label + "</span>";
        return '<span><span class="dot" style="' + style + '"></span>' + label + "</span>";
    }
    // #1609: cache-miss attribution (#1606). Defensive reads — servers predating #1606
    // carry no ledger.seam at all, and an all-zero shape must render nothing.
    function detailSeam(ledger) {
        const raw = ledger && ledger.seam && typeof ledger.seam === "object" ? ledger.seam : null;
        if (!raw) return null;
        return {
            suspects: Number(raw.suspects) || 0,
            missed: Number(raw.missed) || 0,
            events: Array.isArray(raw.events) ? raw.events.filter((e) => e && e.at > 0) : [],
            providerSide: { count: (raw.providerSide && Number(raw.providerSide.count)) || 0, missed: (raw.providerSide && Number(raw.providerSide.missed)) || 0 },
            providerTtl: { count: (raw.providerTtl && Number(raw.providerTtl.count)) || 0, missed: (raw.providerTtl && Number(raw.providerTtl.missed)) || 0 },
            rewinds: { count: (raw.rewinds && Number(raw.rewinds.count)) || 0, missed: (raw.rewinds && Number(raw.rewinds.missed)) || 0 },
            client: { count: (raw.client && Number(raw.client.count)) || 0, missed: (raw.client && Number(raw.client.missed)) || 0 },
            abortCorrelated: Number(raw.abortCorrelated) || 0,
        };
    }
    function detailSeamActive(seam) {
        return !!(seam && (seam.suspects > 0 || seam.missed > 0 || seam.events.length > 0 || seam.providerSide.count > 0 || seam.rewinds.count > 0 || seam.client.count > 0 || seam.abortCorrelated > 0));
    }
    // #2489/#3484: zoom-to-selection over the detail charts. The data is already
    // client-side, so zooming re-renders the SAME renderer over a filtered slice — no
    // server round-trip, and an un-zoomed view stays byte-identical to the full render.
    // One gesture machinery serves both charts (context trajectory + cache hit rate):
    // identical geometry and interaction; each instance supplies element ids, its
    // state and its renderer.
    function chartIdxFromX(x, n) {
        if (n <= 1) return 0;
        const iw = TRAJ_W - TRAJ_PL - TRAJ_PR;
        return Math.max(0, Math.min(n - 1, Math.round(((x - TRAJ_PL) / iw) * (n - 1))));
    }
    const chartZooms = [];   // live instances — Esc resets any zoomed chart (#2489 behavior)
    function makeChartZoom(cfg) {
        // cfg: { elId, statusId, resetId, render(lines, folds, seams) -> svg, link?: { members } }
        const z = { range: null, drag: null, state: null, cfg };
        z.visible = function visible() {
            if (!z.state) return null;
            const L = z.state.lines;
            let a = 0, b = L.length - 1;
            if (z.range) {
                a = Math.max(0, Math.min(L.length - 1, z.range[0]));
                b = Math.max(a, Math.min(L.length - 1, z.range[1]));
            }
            const lines = L.slice(a, b + 1);
            // Full view passes EVERY fold/seam through unfiltered: the renderer clamps
            // out-of-sample-range marks to the nearest edge (the pre-#2489 behavior, which
            // the byte-parity acceptance criterion pins). Time-filtering only applies to a
            // ZOOMED window, where a foreign mark would land on the wrong sample.
            if (!z.range) return { lines, folds: z.state.folds || [], seams: z.state.seams || [], offset: a };
            const t0 = lines[0] ? (lines[0].at || 0) : 0;
            const t1 = lines.length ? (lines[lines.length - 1].at || 0) : 0;
            return {
                lines,
                folds: (z.state.folds || []).filter((f) => (f.at || 0) >= t0 && (f.at || 0) <= t1),
                seams: (z.state.seams || []).filter((e) => e && e.at > 0 && e.at >= t0 && e.at <= t1),
                offset: a,
            };
        };
        function updateStatus(v) {
            const st = $(cfg.statusId);
            if (!st) return;
            if (!z.range || !v || !v.lines.length) { st.hidden = true; st.innerHTML = ""; return; }
            const L = z.state.lines;
            const a = v.offset, b = v.offset + v.lines.length - 1;
            const sa = L[a].seq != null ? "#" + L[a].seq : "#" + (a + 1);
            const sb = L[b].seq != null ? "#" + L[b].seq : "#" + (b + 1);
            const times = v.lines.map((l) => l.at).filter(Boolean);
            st.hidden = false;
            st.innerHTML = '<span class="mono small">' + escapeHtml(t("det.traj_zoomed", { a: sa.slice(1), b: sb.slice(1), times: times.length ? fmtDT(times[0]) + " \u2192 " + fmtDT(times[times.length - 1]) : t("common.none") })) + "</span>"
                + '<button id="' + cfg.resetId + '" class="btn sm" type="button">' + escapeHtml(t("det.traj_reset")) + "</button>";
            const rb = $(cfg.resetId);
            if (rb) rb.addEventListener("click", () => z.setRange(null));
        }
        z.render = function render() {
            const wrap = $(cfg.elId);
            const v = z.visible();
            if (!wrap || !v) return;
            wrap.innerHTML = v.lines.length ? cfg.render(v.lines, v.folds, v.seams) : "";
            updateStatus(v);
        };
        z.setRange = function setRange(r) {
            const nr = r && r[1] > r[0] ? [r[0], r[1]] : null;
            const same = (nr === null && z.range === null) || (nr !== null && z.range !== null && nr[0] === z.range[0] && nr[1] === z.range[1]);
            if (same) return;
            z.range = nr;
            z.render();
            // #4317: linked charts share ONE brush window — a selection or reset on either
            // re-renders its peers over the same sample indices. The length guard keeps a
            // stale peer bound to another session's ledger out of the propagation.
            if (cfg.link && z.state) cfg.link.members.forEach((m) => { if (m !== z && m.state && m.state.lines.length === z.state.lines.length) m.setRange(nr); });
        };
        function localX(wrap, ev) {
            const r = wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null;
            if (!r || !(r.width > 0)) return null;
            const x = (ev.clientX - r.left) * (TRAJ_W / r.width);
            return Math.max(TRAJ_PL, Math.min(TRAJ_W - TRAJ_PR, x));
        }
        function overlayShow(wrap, xa, xb) {
            if (!z.drag || !z.drag.overlay) return;
            const r = wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null;
            if (!r || !(r.width > 0)) return;
            const o = z.drag.overlay;
            o.style.left = (Math.min(xa, xb) * (r.width / TRAJ_W)).toFixed(1) + "px";
            o.style.width = (Math.abs(xb - xa) * (r.width / TRAJ_W)).toFixed(1) + "px";
            o.style.top = (TRAJ_PT * (r.height / TRAJ_H)).toFixed(1) + "px";
            o.style.height = ((TRAJ_H - TRAJ_PT - TRAJ_PB) * (r.height / TRAJ_H)).toFixed(1) + "px";
        }
        function onDown(ev) {
            if (!z.state || ev.button !== 0) return;
            const wrap = $(cfg.elId);
            const v = z.visible();
            if (!wrap || !v || v.lines.length < TRAJ_MIN_SAMPLES) return;
            ev.preventDefault();
            const x0 = localX(wrap, ev);
            if (x0 == null) return;
            const o = document.createElement("div");
            o.className = "chart-brush";
            wrap.appendChild(o);
            z.drag = { x0, cur: x0, n: v.lines.length, offset: v.offset, overlay: o };
            overlayShow(wrap, x0, x0);
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        }
        function onMove(ev) {
            if (!z.drag) return;
            const x = localX($(cfg.elId), ev);
            if (x == null) return;
            z.drag.cur = x;
            overlayShow($(cfg.elId), z.drag.x0, x);
        }
        function onUp(ev) {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            if (!z.drag) return;
            const d0 = z.drag;
            z.drag = null;
            if (d0.overlay) d0.overlay.remove();
            const x1 = localX($(cfg.elId), ev);
            if (x1 == null) return;
            const i0 = chartIdxFromX(Math.min(d0.x0, x1), d0.n);
            const i1 = chartIdxFromX(Math.max(d0.x0, x1), d0.n);
            if (i1 - i0 + 1 < TRAJ_MIN_SAMPLES) return;     // too narrow — treat as a click
            if (i1 - i0 + 1 >= d0.n) return;                 // full-width drag — nothing to gain
            z.setRange([d0.offset + i0, d0.offset + i1]);
        }
        z.bind = function bind(state) {
            z.state = state && state.lines.length ? state : null;
            z.range = null;
            const wrap = $(cfg.elId);
            if (!wrap || !z.state) { z.render(); return; }
            wrap.addEventListener("mousedown", onDown);
            wrap.addEventListener("dblclick", () => z.setRange(null));
            z.render();
        };
        chartZooms.push(z);
        if (cfg.link) cfg.link.members.push(z);
        return z;
    }
    const trajAux = { win: 0, baseIn: 0 };
    // #4317: both detail charts plot the SAME request timeline in two projections —
    // one shared brush window keeps them in lockstep (select on either, both follow).
    const detailChartLink = { members: [] };
    const trajZoom = makeChartZoom({ elId: "traj-chart", statusId: "traj-status", resetId: "traj-reset", link: detailChartLink, render: (lines, folds, seams) => trajectorySvg(lines, folds, trajAux.win, trajAux.baseIn, seams) });
    const hitZoom = makeChartZoom({ elId: "hit-chart", statusId: "hit-status", resetId: "hit-reset", link: detailChartLink, render: (lines, folds, seams) => hitRateSvg(lines, folds, seams) });
    function bindTrajectoryBrush(d) {
        const ledger = d.ledger || {};
        const lines = (ledger.lines || []).filter((l) => Boolean(l));
        const seam = detailSeam(ledger);
        trajAux.win = d.contextWindow || 0;
        trajAux.baseIn = d.systemPromptTokens || 0;
        trajZoom.bind({ lines, folds: ledger.folds || [], seams: detailSeamActive(seam) && seam ? seam.events : [] });
    }
    function bindHitRateChart(d) {
        const ledger = d.ledger || {};
        const lines = (ledger.lines || []).filter((l) => Boolean(l));
        const seam = detailSeam(ledger);
        hitZoom.bind({ lines, folds: ledger.folds || [], seams: detailSeamActive(seam) && seam ? seam.events : [] });
    }
    window.bili_trajSvg = trajectorySvg;
    window.bili_hitSvg = hitRateSvg;
    window.bili_causes = classifyLineCauses;
    window.bili_trajZoom = { minSamples: TRAJ_MIN_SAMPLES, idxFromX: chartIdxFromX, visible: () => trajZoom.visible(), range: () => trajZoom.range };
    window.bili_hitZoom = { minSamples: TRAJ_MIN_SAMPLES, idxFromX: chartIdxFromX, visible: () => hitZoom.visible(), range: () => hitZoom.range };
    function blockTopic(b) {
        // #1426: untitled blocks fall back to the lead line of their summary
        if (b.topic && String(b.topic).trim()) return String(b.topic).trim();
        const lead = String(b.summary || "").split("\\n").map((s) => s.trim()).find(Boolean) || "";
        const plain = lead.replace(/^#{1,6}\\s*/, "").replace(/^[*>-]+\\s*/, "");
        return plain.length > 48 ? plain.slice(0, 48) + "…" : plain || b.blockId;
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
    // Terminates the reasoning cell of a reply: _reasoning_: has no end
    // marker, so the handoff renderer would otherwise fold the answer that
    // follows into the collapsed thinking box. Mirrored in HANDOFF_THINK_END.
    const HANDOFF_THINK_END = "<!-- /reasoning -->";
    function splitHandoffBody(bodyLines) {
        const segs = [];
        let thinkClosed = false;
        for (let i = 0; i < bodyLines.length; i++) {
            const raw = bodyLines[i];
            if (raw.trim() === "" && !(segs.length && segs[segs.length - 1].type === "out")) continue;
            const activeThink = segs[segs.length - 1];
            if (raw.trim() === HANDOFF_THINK_END && activeThink && activeThink.type === "think" && !thinkClosed) {
                if (bodyLines[i + 1] === raw) { activeThink.lines.push(raw); i++; }
                else thinkClosed = true;
                continue;
            }
            const tool = parseToolLine(raw);
            if (tool) { segs.push({ type: "tool", kind: tool.kind, name: tool.name, cid: tool.cid, lines: [tool.text] }); continue; }
            if (raw.indexOf("_reasoning_: ") === 0) {
                const lastT = segs[segs.length - 1];
                if (!lastT || lastT.type !== "think" || thinkClosed) segs.push({ type: "think", lines: [] });
                segs[segs.length - 1].lines.push(raw.slice("_reasoning_: ".length));
                thinkClosed = false;
                continue;
            }
            const last = segs[segs.length - 1];
            if (last && (last.type === "out" || (last.type === "think" && !thinkClosed))) last.lines.push(raw);
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
    // #3917: compression-structure tree — nested by parentBlockId (an active
    // block's children are the blocks it folded); roots are blocks whose parent
    // is no longer folded. Nodes carry the kernel's own accounting:
    // compressedTokens (what the block absorbed), summaryTokens (what replaced
    // it), summaryBytes (the rendered artifact) and the mNNNNN span it covers.
    function blockTreeStats(blocks) {
        const tiers = {};
        let active = 0;
        let coverTokens = 0;
        let summaryTokens = 0;
        blocks.forEach(function (b) {
            const tier = Number(b.tier) || 1;
            tiers[tier] = (tiers[tier] || 0) + 1;
            if (b.active) active += 1;
            coverTokens += Number(b.compressedTokens) || 0;
            summaryTokens += Number(b.summaryTokens) || 0;
        });
        return { tiers: tiers, active: active, coverTokens: coverTokens, summaryTokens: summaryTokens };
    }
    function blockTreeShape(blocks) {
        const byId = {};
        blocks.forEach(function (b) { byId[b.blockId] = b; });
        const children = {};
        const roots = [];
        blocks.forEach(function (b) {
            const pid = b.parentBlockId;
            if (pid && byId[pid] && pid !== b.blockId) (children[pid] = children[pid] || []).push(b);
            else roots.push(b);
        });
        return { children: children, roots: roots };
    }
    // #4608: geometry for the collapsible-tree reading of the blocks pane.
    // (The flame-chart reading was cut at owner request — the pane keeps
    // the tree plus the classic folded-block list instead.)
    const TREE_W = 200;          // collapsible-tree node box
    const TREE_H = 44;
    const TREE_GAP_X = 22;       // column spacing (depth axis)
    const TREE_GAP_Y = 10;
    // Collapsible depth-column tree: roots always show, a branch appears only
    // while its parent carries the expand mark; the "+N" chip counts the whole
    // hidden subtree so a deep collapse still says how much hides behind it.
    function collapSubtreeSize(blocks) {
        const byId = {};
        blocks.forEach(function (b) { byId[b.blockId] = true; });
        const childIds = {};
        blocks.forEach(function (b) {
            const pid = b.parentBlockId;
            if (pid && pid !== b.blockId && byId[pid]) (childIds[pid] = childIds[pid] || []).push(b.blockId);
        });
        const memo = {};
        const size = function (id, trail) {
            if (memo[id] != null) return memo[id];
            if (trail.indexOf(id) >= 0) return 1;
            trail.push(id);
            const total = 1 + (childIds[id] || []).reduce(function (acc, k) { return acc + size(k, trail); }, 0);
            trail.pop();
            memo[id] = total;
            return total;
        };
        blocks.forEach(function (b) { size(b.blockId, []); });
        return memo;
    }
    function collapTreeLayout(blocks, expanded) {
        const shape = blockTreeShape(blocks);
        const sizes = collapSubtreeSize(blocks);
        const nodes = [], links = [];
        let cursor = 0, maxDepth = 0;
        const place = function (b, depth) {
            if (depth > 40) return null;
            const node = { b: b, x: depth, y: 0 };
            const ys = [];
            if (expanded && expanded[b.blockId])
                (shape.children[b.blockId] || []).forEach(function (k) {
                    const kn = place(k, depth + 1);
                    if (kn) { ys.push(kn.y); links.push([node, kn]); }
                });
            if (ys.length) node.y = (ys[0] + ys[ys.length - 1]) / 2;
            else { node.y = cursor; cursor += TREE_H + TREE_GAP_Y; }
            nodes.push(node);
            if (depth > maxDepth) maxDepth = depth;
            return node;
        };
        (shape.roots.length ? shape.roots : blocks).forEach(function (r) { place(r, 0); });
        if (!nodes.length) return { nodes: nodes, links: links, cols: 1, height: 0, sizes: sizes };
        return { nodes: nodes, links: links, cols: maxDepth + 1, height: cursor - TREE_GAP_Y + TREE_H, sizes: sizes };
    }
    function renderCollapSvg(blocks, expanded, selectedBid) {
        const lay = collapTreeLayout(blocks, expanded || {});
        if (!lay.nodes.length) return { html: "" };
        const colW = TREE_W + TREE_GAP_X;
        const W = 12 + lay.cols * colW + 4;
        const H = lay.height + 12;
        const sel = selectedBid || "";
        const p = [];
        p.push('<svg class="g-svg g-svg-v" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" preserveAspectRatio="xMinYMin meet" role="img">');
        lay.links.forEach(function (l) {
            const x1 = l[0].x * colW + 12 + TREE_W, y1 = l[0].y + 6 + TREE_H / 2;
            const x2 = l[1].x * colW + 12, y2 = l[1].y + 6 + TREE_H / 2;
            const mx = (x1 + x2) / 2;
            p.push('<path class="g-edge" fill="none" d="M' + x1.toFixed(1) + " " + y1.toFixed(1) + " C" + mx.toFixed(1) + " " + y1.toFixed(1) + " " + mx.toFixed(1) + " " + y2.toFixed(1) + " " + x2.toFixed(1) + " " + y2.toFixed(1) + '"></path>');
        });
        lay.nodes.forEach(function (n) {
            const b = n.b;
            const tierNum = Number(b.tier) || 1;
            const hidden = (lay.sizes[b.blockId] || 1) - 1;
            const isOpen = !!(expanded && expanded[b.blockId]);
            const cls = "g-node tier-" + (tierNum > 3 ? "n" : String(tierNum)) + (b.active ? "" : " inactive") + (sel === b.blockId ? " fsel" : "");
            let topic = blockTopic(b);
            const maxCh = Math.floor((TREE_W - 52) / 7);
            if (topic.length > maxCh) topic = topic.slice(0, Math.max(1, maxCh - 1)) + "...";
            const rr = refRangeOf(b);
            p.push('<g class="' + cls + '" data-bid="' + escapeHtml(b.blockId) + '" transform="translate(' + (n.x * colW + 12).toFixed(1) + "," + (n.y + 6).toFixed(1) + ')">');
            p.push('<rect width="' + TREE_W + '" height="' + TREE_H + '" rx="9"><title>' + escapeHtml(b.blockId + " \u00b7 T" + tierNum + (rr ? " \u00b7 " + rr : "") + " \u00b7 " + blockTopic(b)) + "</title></rect>");
            p.push('<text class="g-id" x="10" y="17">' + escapeHtml(b.blockId + " \u00b7 T" + tierNum + (rr ? " \u00b7 " + rr : "")) + "</text>");
            p.push('<text class="g-topic" x="10" y="34">' + escapeHtml(topic) + "</text>");
            if (hidden > 0)
                p.push('<g class="tchip" data-toggle="' + escapeHtml(b.blockId) + '" transform="translate(' + (TREE_W - 34) + ',13)">' + '<rect width="28" height="18" rx="9"></rect><text x="14" y="13">' + (isOpen ? "−" : "+" + hidden) + '</text></g>');
            p.push("</g>");
        });
        p.push("</svg>");
        return { html: p.join("") };
    }
    function refRangeOf(b) {
        if (!b.startRef) return "";
        return b.endRef && b.endRef !== b.startRef ? b.startRef + "–" + b.endRef : String(b.startRef);
    }
    // #4608: one pre-rendered detail panel per fold block — hidden until its
    // bar/node is selected, so the drawings stay light while the summary, the
    // kernel's own accounting and the lazy raw-content endpoints all live next
    // to the thing you clicked.
    function sidePanelHtml(b, idx) {
        const tierNum = Number(b.tier) || 1;
        const badge = b.active
            ? '<span class="badge ok">' + t("det.block_active") + "</span>"
            : '<span class="badge disk">' + t("det.block_inactive") + "</span>";
        const extBadge = b.external ? '<span class="badge ext">' + t("det.block_external") + "</span>" : "";
        const meta = ["T" + tierNum, fmtW(b.compressedTokens) + " \u2192 " + fmtW(b.summaryTokens)];
        if (b.compressedTokens > 0 && b.summaryTokens > 0) meta.push((100 * b.summaryTokens / b.compressedTokens).toFixed(1) + "%");
        meta.push(fmtB(b.summaryBytes));
        if (b.effectiveMessageCount) meta.push(t("det.tree_msgs", { n: b.effectiveMessageCount }));
        const rr = refRangeOf(b);
        if (rr) meta.push(rr);
        meta.push(timeAgo(b.createdAt));
        // Same contract as the old list row: long summaries open as five
        // clamped lines behind a show-all button; the clamp only survives
        // measurement if it actually cut anything.
        const sumLong = String(b.summary || "").trim().length > 64;
        let bodyInner = renderBlockMd(b.summary || "");
        if (sumLong) {
            bodyInner = '<div class="blk-sum clamp">' + bodyInner + "</div>"
                + '<button type="button" class="btn sm blk-sum-toggle">' + t("det.tree_sum_more") + "</button>";
        }
        const bid = escapeHtml(b.blockId);
        let html = '<div class="bd-panel" data-bid="' + bid + '" hidden><div class="bd-head"><span class="mono">' + bid + "</span>" + badge + extBadge
            + '<button class="btn sm blk-copy" data-bi="' + idx + '">' + t("common.copy") + "</button></div>"
            + '<div class="topic">' + escapeHtml(blockTopic(b)) + "</div>"
            + '<div class="meta mono">' + escapeHtml(meta.join(" \u00b7 ")) + "</div>"
            + '<div class="body md">' + bodyInner + "</div>"
            + '<div class="blk-content-bar">'
            + '<button class="btn sm blk-content-btn" data-bid="' + bid + '" data-view="one">' + t("det.tree_orig_one") + "</button>"
            + '<button class="btn sm blk-content-btn" data-bid="' + bid + '" data-view="full">' + t("det.tree_orig_full") + "</button>"
            + '<span class="dim small">' + escapeHtml(t("det.tree_direct", { n: Number(b.directMessageCount) || 0 })) + "</span>"
            + "</div>"
            + '<div class="blk-content" data-blkbox hidden></div>';
        // The messages this block folded — preview only, bytes arrive lazily
        // (#3917) through the very same endpoint the old list rows used.
        const msgs = b.directMessages || [];
        if (msgs.length) {
            html += '<ul class="blk-msgs">';
            msgs.forEach(function (m) {
                if (m.missing) {
                    html += '<li><div class="msg-row missing"><span class="mref mono">' + escapeHtml(m.ref) + '</span><span class="mprev">' + t("det.tree_msg_gone") + "</span></div></li>";
                    return;
                }
                const tags = m.toolName ? '<span class="badge">' + escapeHtml(m.toolName) + "</span>" : "";
                html += '<li><button class="msg-row" data-ref="' + escapeHtml(m.ref) + '">'
                    + '<span class="mref mono">' + escapeHtml(m.ref) + "</span>"
                    + '<span class="badge">' + escapeHtml(m.role || "") + "</span>" + tags
                    + '<span class="mprev">' + escapeHtml(m.preview || "") + "</span></button>"
                    + '<div class="msg-body" hidden></div></li>';
            });
            html += "</ul>";
        } else if (Number(b.directMessageCount) > 0) {
            html += '<div class="dim small" style="margin:2px 0 8px">' + t("det.tree_msgs_unavailable") + "</div>";
        }
        return html + "</div>";
    }    function blockNodeHtml(b, shape, idx, depth) {
        const kids = shape.children[b.blockId] || [];
        const tierNum = Number(b.tier) || 1;
        // #4173 review: rows start COLLAPSED — a 200-block session must not
        // open as a wall of expanded cards. The tree-map click opens the
        // target row for you; <summary> expands any row on demand.
        const openAttr = "";
        const badge = b.active
            ? '<span class="badge ok">' + t("det.block_active") + "</span>"
            : '<span class="badge disk">' + t("det.block_inactive") + "</span>";
        const extBadge = b.external ? '<span class="badge ext">' + t("det.block_external") + "</span>" : "";
        const refRange = refRangeOf(b);
        const meta = ["T" + tierNum, fmtW(b.compressedTokens) + " → " + fmtW(b.summaryTokens)];
        if (b.compressedTokens > 0 && b.summaryTokens > 0) meta.push((100 * b.summaryTokens / b.compressedTokens).toFixed(1) + "%");
        meta.push(fmtB(b.summaryBytes));
        if (b.effectiveMessageCount) meta.push(t("det.tree_msgs", { n: b.effectiveMessageCount }));
        if (refRange) meta.push(refRange);
        meta.push(timeAgo(b.createdAt));
        // #4173 review: long summaries open as five clamped lines + a show-all
        // button. Closed <details> rows have no layout, so whether the clamp
        // actually cut anything is measured once on first expand (below).
        const sumLong = String(b.summary || "").trim().length > 64;
        let bodyInner = renderBlockMd(b.summary || "");
        if (sumLong) {
            bodyInner = '<div class="blk-sum clamp">' + bodyInner + '</div>'
                + '<button type="button" class="btn sm blk-sum-toggle">' + t("det.tree_sum_more") + "</button>";
        }
        const bid = escapeHtml(b.blockId);
        let html = '<details class="block-item block-node tier-' + (tierNum > 3 ? "n" : String(tierNum)) + '" data-bid="' + bid + '"' + openAttr + ">"
            + '<summary><span class="bid">' + bid + "</span>" + badge + extBadge
            + '<span class="topic">' + escapeHtml(blockTopic(b)) + "</span>"
            + '<span class="meta">' + escapeHtml(meta.join(" · ")) + "</span>"
            + '<button class="btn sm blk-copy" data-bi="' + idx + '">' + t("common.copy") + "</button>"
            + "</summary>"
            + '<div class="body md">' + bodyInner + "</div>"
            + '<div class="blk-content-bar">'
            + '<button class="btn sm blk-content-btn" data-bid="' + bid + '" data-view="one">' + t("det.tree_orig_one") + "</button>"
            + '<button class="btn sm blk-content-btn" data-bid="' + bid + '" data-view="full">' + t("det.tree_orig_full") + "</button>"
            + '<span class="dim small">' + escapeHtml(t("det.tree_direct", { n: Number(b.directMessageCount) || 0 })) + "</span>"
            + "</div>"
            + '<div class="blk-content" data-blkbox hidden></div>';
        // #3917: the messages this block folded, one leaf per mNNNNN ref. The
        // preview is all the tree needs; the bytes arrive on the first click
        // (the lazy endpoint), so a wide session never ships its transcript.
        const msgs = b.directMessages || [];
        if (msgs.length) {
            html += '<ul class="blk-msgs">';
            msgs.forEach(function (m) {
                if (m.missing) {
                    html += '<li><div class="msg-row missing"><span class="mref mono">' + escapeHtml(m.ref) + '</span><span class="mprev">' + t("det.tree_msg_gone") + "</span></div></li>";
                    return;
                }
                const tags = m.toolName ? '<span class="badge">' + escapeHtml(m.toolName) + "</span>" : "";
                html += '<li><button class="msg-row" data-ref="' + escapeHtml(m.ref) + '">'
                    + '<span class="mref mono">' + escapeHtml(m.ref) + "</span>"
                    + '<span class="badge">' + escapeHtml(m.role || "") + "</span>" + tags
                    + '<span class="mprev">' + escapeHtml(m.preview || "") + "</span></button>"
                    + '<div class="msg-body" hidden></div></li>';
            });
            html += "</ul>";
        } else if (Number(b.directMessageCount) > 0) {
            html += '<div class="dim small" style="margin:2px 0 8px 24px">' + t("det.tree_msgs_unavailable") + "</div>";
        }
        if (depth < 32) kids.forEach(function (k) { html += blockNodeHtml(k, shape, idx, depth + 1); });
        return html + "</details>";
    }


    function buildTreePane(blocks) {
        const parts = [];
        parts.push('<div class="card"><div class="card-h"><span>' + t("det.blocks_title") + '</span><span class="hint">' + t("det.blocks_count", { total: blocks.length, active: blocks.filter(function (b) { return b.active; }).length }) + '</span></div><div class="card-b">');
        if (!blocks.length) {
            parts.push('<div class="dim small" style="padding:8px 0">' + t("det.blocks_empty") + "</div></div></div>");
            return parts.join("");
        }
        window.__biliDetailBlocks = blocks; // consumed by bindTreeModeActions() after insertion
        const stats = blockTreeStats(blocks);
        const tierBits = Object.keys(stats.tiers).sort(function (a, b) { return Number(a) - Number(b); }).map(function (k) { return "T" + k + " ×" + stats.tiers[k]; });
        parts.push('<div class="tree-stats mono small">'
            + "<span>" + escapeHtml(t("det.tree_total", { n: blocks.length })) + "</span>"
            + "<span>" + escapeHtml(t("det.tree_active", { n: stats.active })) + "</span>"
            + "<span>" + escapeHtml(t("det.tree_split", { x: fmtW(stats.coverTokens), y: fmtW(stats.summaryTokens), p: stats.coverTokens > 0 ? (100 * stats.summaryTokens / stats.coverTokens).toFixed(1) + "%" : t("common.none") })) + "</span>"
            + (tierBits.length ? "<span>" + escapeHtml(tierBits.join(" · ")) + "</span>" : "")
            + "</div>");
        parts.push('<div class="tree-actions"><button id="blocks-copy" class="btn sm">' + t("det.blocks_copy_md") + '</button><button id="blocks-dl" class="btn sm">' + t("det.blocks_download") + "</button></div>");
        parts.push('<div class="tree-modes">'
            + '<button class="btn sm tree-mode active" data-mode="tree">' + t("det.tree_view_graph") + "</button>"
            + '<button class="btn sm tree-mode" data-mode="list">' + t("det.tree_view_list") + "</button>"
            + '<button id="tm-expand-all" class="btn sm" hidden>' + t("det.tree_expand_all") + "</button>"
            + '<button id="tm-collapse-all" class="btn sm" hidden>' + t("det.tree_collapse_all") + "</button>"
            + '<span class="hint" id="tree-hint">' + t("det.tree_interact") + "</span>"
            + "</div>");
        // Left: the two interchangeable readings inside one scrollable frame
        // (the collapsible tree by default, the classic folded-block list on
        // demand); right: the selected block, sticky beside the tree.
        const shape = blockTreeShape(blocks);
        const idxOf = {};
        blocks.forEach(function (b, i) { if (idxOf[b.blockId] === undefined) idxOf[b.blockId] = i; });
        parts.push('<div class="fd-grid"><div class="fd-left">');
        parts.push('<div class="tm-view" id="tree-graph"><div class="tm-inner"></div></div>');
        parts.push('<div class="tree-list" id="tree-list" hidden><div class="block-tree">');
        const rootBlocks = shape.roots.length ? shape.roots : blocks;
        rootBlocks.forEach(function (b) { parts.push(blockNodeHtml(b, shape, idxOf[b.blockId] || 0, 0)); });
        parts.push("</div></div>");
        parts.push('</div><aside class="fd-side"><div class="card bd-card"><div class="card-h"><span>' + t("det.block_detail_title") + '</span></div><div class="card-b">');
        parts.push('<div class="dim small" id="bd-empty">' + t("det.block_side_hint") + "</div>");
        parts.push('<div id="bd-panels">');
        blocks.forEach(function (b) { parts.push(sidePanelHtml(b, idxOf[b.blockId])); });
        parts.push("</div></div></div></aside></div>");
        parts.push("</div></div>");
        return parts.join("");
    }
    function buildDetailHtml(d) {
        const parts = [];
        // Hoisted above the page head so the tab count badge can share the same
        // array (originally declared further down, inside the tree pane).
        const blocks = d.blockDetails || [];
        parts.push('<a class="btn sm" href="#/sessions">' + t("common.back") + "</a>");
        parts.push('<div class="page-head"><div><h1 title="' + escapeHtml(d.title || d.label || d.id) + '">' + escapeHtml(d.title || d.label || d.id.slice(0, 16)) + '</h1><div class="sub mono">' + escapeHtml(d.id) + "</div></div><div>" + detailBadges(d) + "</div></div>");
        parts.push('<div style="display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap"><span class="dim small">' + t("det.report_note") + '</span><button id="sessrpt-md" class="btn sm">' + t("det.report_md") + '</button><button id="sessrpt-png" class="btn sm">' + t("det.report_png") + '</button></div>');
        // #3917: the detail page splits into panes — overview (identity, usage,
        // cache economics), the compression tree, and the handoff document. The
        // blocks card moved out of the overview into its own tier-tree pane.
        parts.push('<div class="det-tabs" id="det-tabs">'
            + '<button class="det-tab active" data-pane="overview">' + t("det.tab_overview") + "</button>"
            + '<button class="det-tab" data-pane="blocks">' + t("det.tab_blocks") + (blocks.length ? ' <span class="hint">' + blocks.length + "</span>" : "") + "</button>"
            + '<button class="det-tab" data-pane="handoff">' + t("det.tab_handoff") + "</button>"
            + "</div>");
        parts.push('<div class="det-pane" data-pane="overview">');
        parts.push('<div class="card"><div class="card-h"><span>' + t("det.identity") + '</span></div><div class="card-b"><dl class="kv">');
        // Full title wraps in place, is hoverable (title attr) and carries a copy button.
        parts.push('<div class="k">' + t("common.title") + '</div><div class="v" title="' + escapeHtml(d.title || "") + '">' + (d.title ? escapeHtml(d.title) + ' <button id="title-copy" class="btn sm">' + t("common.copy") + "</button>" : '<span class="faint">' + t("common.none") + "</span>") + "</div>");
        if (d.label && d.label !== d.id) kv(parts, t("common.label"), d.label);
        kv(parts, t("common.protocol"), d.protocol || null, true);
        kv(parts, t("det.client_hint"), d.clientHint || null, true);
        // #4571: engine lane — in-process (inline) vs standalone proxy process.
        kv(parts, t("det.engine_lane"), d.engineLane === "inline" ? t("det.engine_lane_inline") : d.engineLane === "server" ? t("det.engine_lane_server") : null, true);
        if (d.selfHeal) kv(parts, t("det.self_heal"), (d.selfHeal.action === "degrade-to-proxy" ? t("det.self_heal_degrade_to_proxy") : t("det.self_heal_suppress_nudge")) + " · " + d.selfHeal.detected + " · " + timeAgo(d.selfHeal.since), true);
        // #2740: session-level notice — auto-mode verdicts here are bili-local, not model judgments.
        if (d.autoModeForge) kv(parts, t("det.auto_mode_forge"), t("det.auto_mode_forge_local") + " · " + d.autoModeForge.count + "×" + (d.autoModeForge.lastVariant || "?") + " · " + timeAgo(d.autoModeForge.lastAt), true);
if (d.keepalive) kv(parts, t("det.keepalive"), d.keepalive.tierLabel + " · " + (d.keepalive.cadenceMs >= 60_000 ? Math.round(d.keepalive.cadenceMs / 60_000) + "min" : Math.round(d.keepalive.cadenceMs / 1000) + "s") + " · " + t("det.keepalive_pings") + " " + d.keepalive.pingCount + (d.keepalive.lastHitAt ? " · " + t("det.keepalive_last_hit") + " " + timeAgo(new Date(d.keepalive.lastHitAt).toISOString()) : ""), true);
        kv(parts, t("common.upstream"), hostOf(d.upstreamOrigin) || null, true);
        kv(parts, t("det.version"), d.biliVersion || null, true);
        // #2671: absent stamp = no db copy (legacy/blocked/pre-feature) — render
        // as legacy rather than a dash. Literal t() branches (not concat) keep
        // every catalog key statically referenceable for the #1024 dead-key gate.
        const sm = d.storageMode || "legacy";
        const smLabel = sm === "full" ? t("det.storage_mode_full") : sm === "shadow" ? t("det.storage_mode_shadow") : t("det.storage_mode_legacy");
        kv(parts, t("det.storage_mode"), smLabel || sm, true);
        kv(parts, t("det.active_pack"), d.activePack || null, true);
        parts.push('<div class="k">' + t("det.log") + '</div><div class="v"><a href="#/logs?q=' + encodeURIComponent(d.id) + '">' + t("det.log_view") + "</a></div>");
        parts.push("</dl></div></div>");
        parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.usage") + '</span></div><div class="card-b">');
        parts.push('<div class="grid cols-4">');
        mini(parts, t("common.requests"), d.requests ? fmtW(d.requests) : null);
        // #4899 v4: every token figure gets its own ≈$ face even without folds
        // (priced sessions carry a live-estimated costUsd) — same tiers as the
        // overview cards; unpriced sessions stay bare.
        // #4899 v5: per-session rate args — show THE price inside each formula,
        // same rule as the overview (only when one price actually applies).
        const d6 = (x) => String(Math.round(x * 1e6) / 1e6);
        const drates = d.rates ? { w: d6(d.rates.w), r: d6(d.rates.r), q: d6(d.rates.q) } : null;
        const inSub = (d.costUsd ? t("ov.tier_unhit", { n: fmtUsd(d.costUsd.input) }) : "")
            + (drates ? " · " + t("ov.at_input", { v: drates.w }) : "")
            + (d.payback != null && d.savedUsdGross != null ? " · " + t("det.in_counterfactual", { n: fmtUsd(d.savedUsdGross) }) : "");
        mini(parts, t("ov.input_tokens"), d.inputTokens ? fmtW(d.inputTokens) : null, false, inSub);
        mini(parts, t("ov.cached_tokens"), d.cachedTokens ? fmtW(d.cachedTokens) : null, false,
            d.costUsd && d.cachedTokens > 0 ? t("ov.money_eq", { n: fmtUsd(d.costUsd.cacheRead) }) + (drates ? " · " + t("ov.at_read", { v: drates.r }) : "") : "");
        const mt = d.ledger && d.ledger.totals;
        const missArgs = mt && mt.input > 0 ? { n: fmtW(mt.newContent || 0), c: fmtW(mt.compRepay || 0), x: fmtW(mt.ttlRepay || 0), pn: (((mt.newContent || 0) / mt.input) * 100).toFixed(1), pc: (((mt.compRepay || 0) / mt.input) * 100).toFixed(1), px: (((mt.ttlRepay || 0) / mt.input) * 100).toFixed(1) } : null;
        // #2929: the headline hit-rate subline stays the three-bucket split only —
        // the attribution chips (seam / provider / TTL / rewind / abort / prompt /
        // projection) used to be appended here too, duplicating the 归因·未解释残差
        // card lower on the page and mixing taxonomy levels in one line.
        let hitSub = "";
        if (missArgs) hitSub += t("det.miss_sub", { x: missArgs.px, c: missArgs.pc, n: missArgs.pn });
        // #2734: the ledger only covers requests since its last (re)start — a
        // restore/restart window drop leaves older requests invisible to hit/miss
        // stats. Surface the gap and the restart drops explicitly so a frozen-
        // looking ledger reads as a window, not as "nothing happened".
        const ledTot = d.ledger && d.ledger.totals ? d.ledger.totals : null;
        if (ledTot && d.requests > ledTot.requests) {
            hitSub += " · " + '<span style="color:#57606a" title="' + escapeHtml(t("det.ledger_gap_tip")) + '">' + escapeHtml(t("det.ledger_gap", { n: d.requests - ledTot.requests })) + "</span>";
        }
        const rdRaw = d.ledger && typeof d.ledger.restartDrops === "object" ? d.ledger.restartDrops : null;
        if (rdRaw && (Number(rdRaw.count) > 0)) {
            hitSub += " · " + '<span style="color:#8250df" title="' + escapeHtml(t("det.attr_restart_tip")) + '">' + escapeHtml(t("det.attr_restart")) + " ×" + Number(rdRaw.count) + "</span>";
        }
        // #4899: $ face under the missed-tokens split (current price table); tokens
        // only when no price resolves.
        const missLine = missArgs
            ? t("det.miss_split_line", missArgs) + (d.missSplitUsd ? "<br>≈ " + escapeHtml(t("ov.miss_split_usd", { n: fmtUsd(d.missSplitUsd.n), c: fmtUsd(d.missSplitUsd.c), x: fmtUsd(d.missSplitUsd.x) })) + (drates ? " " + escapeHtml(t("ov.miss_rates", drates)) : "") : "")
            : "";
        mini(parts, t("det.hit_pct"), d.cacheHitPct == null ? null : d.cacheHitPct.toFixed(1) + "%", false, hitSub, missLine);
        mini(parts, t("ov.output_tokens"), d.outputTokens ? fmtW(d.outputTokens) : null, false,
            (d.costUsd ? t("ov.money_eq", { n: fmtUsd(d.costUsd.output) }) : "")
            + (drates ? " · " + t("ov.at_output", { v: drates.q }) : "")
            + (d.payback != null && d.summaryCost ? " · " + t("det.out_split", { n: fmtW(Math.max(0, d.outputTokens - d.summaryCost)), nn: fmtUsd(d.payback.normalOutputUsd), s: fmtW(d.summaryCost), ss: fmtUsd(d.payback.sigmaUsd) }) : ""));
        const dSavedV = d.netSaved != null ? d.netSaved : d.tokensSaved;
        // #4899: money faces — saved-$ rides the saved-tokens card as the sub
        // line; spend gets its own card with the input/cache/output breakdown.
        const savedUsdSub = d.savedUsd != null ? t("ov.money_saved", { n: fmtUsd(d.savedUsd) }) : "";
        mini(parts, t("ov.tokens_saved"), dSavedV ? fmtW(dSavedV) : null, dSavedV > 0,
            d.coverageLostFolds ? t("det.covlost_sub", { n: d.coverageLostFolds, x: fmtW(d.coverageLostFrozenTokens || 0) }) : savedUsdSub);
        // #4899 v3: the honest question — did this session's folding pay back?
        // The net reuses the same rounded faces rendered next door
        // (gross − spent, exactly the canonical savedUsd arithmetic), so the
        // numbers on screen reconcile by construction.
        if (d.payback != null && d.savedUsdGross != null) {
            const pnet = d.savedUsdGross - d.payback.spentUsd;
            let brk = t("det.payback_brk_base", { r: fmtUsd(d.payback.replayUsd), g: fmtUsd(d.payback.sigmaUsd) });
            if ((d.payback.creditUsd || 0) > 0) brk += " · " + t("det.payback_brk_credit", { c: fmtUsd(d.payback.creditUsd) });
            if (d.rates) brk += " · " + escapeHtml(t("ov.payback_rates", { w: d6(d.rates.w), r: d6(d.rates.r), q: d6(d.rates.q) }));
            let badge = "";
            if (d.payback.breakevenTurns != null) {
                const done = d.payback.actualTurns >= d.payback.breakevenTurns;
                badge = ' <span style="color:' + (done ? "#1a7f37" : "#cf222e") + '">' + (done ? t("ov.payback_ok") : t("ov.payback_wait", { k: Math.max(1, Math.ceil(d.payback.breakevenTurns - d.payback.actualTurns)) })) + "</span>";
            } else if (pnet >= 0) {
                badge = ' <span style="color:#1a7f37">' + t("ov.payback_ok") + "</span>";
            }
            mini(parts, t("det.payback"), "\u2248 " + fmtUsd(pnet), pnet >= 0,
                t("det.payback_split", { s: fmtUsd(d.payback.spentUsd), brk, v: fmtUsd(d.savedUsdGross) }) + badge);
        }
        if (d.costUsd != null) {
            // #4899: derived-from-price-table spend carries the same ≈ mark
            // every other money face uses; a persisted ledger reads exact.
            mini(parts, t("ov.spend"), (d.costUsd.estimated ? "\u2248 " : "") + fmtUsd(d.costUsd.total), false,
                t("det.spend_sub", { i: fmtUsd(d.costUsd.input), r: fmtUsd(d.costUsd.cacheRead), w: fmtUsd(d.costUsd.cacheWrite), o: fmtUsd(d.costUsd.output) }));
        }
        mini(parts, t("det.last_input"), (d.lastInputTokens || 0) > 0 ? fmtW(d.lastInputTokens) : null);
        // #4899 v3: money faces are live estimates at current list prices — say so where they appear.
        if (d.costUsd != null || d.savedUsd != null)
            parts.push('<div class="dim small" style="margin-top:8px">' + escapeHtml(t("common.price_est_note")) + "</div>");
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
            // #2734: estimate/usage stamps freeze on restore or idle — an old
            // snapshot must not read as the current sent view.
            if (d.contextMeasuredAt) {
                ctxSubBits.push('<span title="' + escapeHtml(t("det.ctx_age_tip")) + '">' + escapeHtml(t("det.ctx_age", { v: timeAgo(d.contextMeasuredAt) })) + "</span>");
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
        if ((d.wholeBlockRestores || 0) > 0 || (d.rangeRestores || 0) > 0) parts.push('<div class="dim small" style="margin-top:4px">' + t("det.decompress") + ' · <span class="mono">' + t("det.decompress_detail", { blocks: d.wholeBlockRestores || 0, precise: d.wholeBlockRestoresPreciseAvailable || 0, ranges: d.rangeRestores || 0 }) + "</span></div>");
        if ((d.storedBytes || 0) > 0) parts.push('<div class="dim small" style="margin-top:4px">' + t("det.store") + ' · <span class="mono">' + fmtB(d.storedBytes) + ((d.storeBytesSaved || 0) > 0 ? " / " + fmtB(d.storeBytesSaved) + " " + t("common.saved") : "") + "</span></div>");
        parts.push("</div></div>");
        const ledger = d.ledger || {};
        const lines = ledger.lines || [];
        // #1609: cache-miss attribution (#1606) — shared by the legend group below and
        // the brush state (bindTrajectoryBrush), so it stays a helper, not inline reads.
        const seam = detailSeam(ledger);
        const seamActive = detailSeamActive(seam);
        parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.trajectory") + '</span><span class="hint">' + t("det.trajectory_sub") + '</span></div><div class="card-b">');
        if (!lines.length) {
            parts.push('<div class="chart-empty">' + t("det.trajectory_empty") + "</div>");
        } else {
            parts.push('<div class="chart-status" id="traj-status" hidden></div>');
            // #2489: the wrap starts empty — bindTrajectoryBrush() fills it on bind,
            // so every chart state (full and zoomed) comes from the single render path.
            parts.push('<div class="chart-wrap" id="traj-chart"></div>');
            parts.push('<div class="chart-legend">');
            parts.push(legendItem("background:var(--accent)", t("det.legend_input")));
            parts.push(legendItem("background:var(--accent);opacity:.4", t("det.legend_cached"), false));
            parts.push(legendItem("#cf222e", t("det.legend_fold"), true));
            parts.push(legendItem("#cf222e", t("det.legend_window"), true));
            // Swatches carry real backgrounds (a bare hex in style= renders nothing).
            // #2929: miss-cause swatches mirror the ledger buckets — the
            // unattributed family renders as ONE bordered group (外框) with its
            // sub-causes inside, so containment is visible, not implied.
            parts.push(legendItem("background:#bf8700", t("det.cause_comp")));
            parts.push(legendItem("background:#6e7681", t("det.cause_cold")));
            if (seam) {
                const sub = [];
                if (seam.missed > 0 || seam.suspects > 0) sub.push(legendItem("background:#cf222e", t("det.legend_seam")));
                if (seam.providerTtl.count > 0) sub.push(legendItem("background:#1a7f37", t("det.leg_pttl")));
                if (seam.providerSide.count > 0) sub.push(legendItem("background:#f0883e", t("det.leg_pside")));
                if (seam.rewinds.count > 0) sub.push(legendItem("background:#57606a", t("det.leg_rewind")));
                if (seam.client.count > 0) sub.push(legendItem("background:#0969da", t("det.leg_client")));
                sub.push(legendItem("background:#9aa1a8", t("det.leg_rest")));
                parts.push('<span style="display:inline-flex;align-items:center;gap:8px;border:1px solid #d0d7de;border-radius:6px;padding:2px 8px;margin:2px 0">'
                    + legendItem("background:#8250df", t("det.cause_unattrib"))
                    + '<span class="dim">⊇</span>'
                    + sub.join("")
                    + "</span>");
            } else {
                parts.push(legendItem("background:#9aa1a8", t("det.cause_ttl")));
            }
            if (d.systemPromptTokens || lines.length >= 20) parts.push(legendItem("border:1.5px solid #8b949e;background:#f2f5f7;", d.systemPromptTokens ? t("det.legend_base") : t("det.legend_base_est")));
            parts.push("</div>");
            parts.push('<div class="dim small" style="margin-top:4px">' + t("det.traj_zoom_hint") + "</div>");
            if ((ledger.linesOmitted || 0) > 0) parts.push('<div class="dim small" style="margin-top:6px">' + t("det.omitted", { n: ledger.linesOmitted }) + "</div>");
        }
        parts.push("</div></div>");
        // #3484: hit-rate trend — same data as the trajectory chart above, plotted as
        // per-request hit % so dips (and their causes) read at a glance.
        parts.push('<div class="card" style="margin-top:16px"><div class="card-h"><span>' + t("det.hitrate") + '</span><span class="hint">' + t("det.hitrate_sub") + '</span></div><div class="card-b">');
        if (!lines.length) {
            parts.push('<div class="chart-empty">' + t("det.hitrate_empty") + "</div>");
        } else {
            parts.push('<div class="chart-status" id="hit-status" hidden></div>');
            parts.push('<div class="chart-wrap" id="hit-chart"></div>');
            const hrCauses = classifyLineCauses(lines, ledger.folds || []);
            const present = {};
            hrCauses.forEach((c) => { if (c !== "new") present[c] = true; });
            parts.push('<div class="chart-legend">');
            parts.push(legendItem("background:var(--accent)", t("det.legend_hitline")));
            ["comp", "cold", "seam", "pt", "ps", "rw", "ci", "rest"].forEach((c) => {
                if (present[c]) parts.push(legendItem("background:" + CAUSE_COLOR[c], t(CAUSE_KEY[c])));
            });
            if ((ledger.folds || []).length > 0) parts.push(legendItem("#cf222e", t("det.legend_fold"), true));
            if (seamActive && seam.events.length > 0) parts.push(legendItem("#cf222e", t("det.legend_seam")));
            parts.push("</div>");
            parts.push('<div class="dim small" style="margin-top:4px">' + t("det.traj_zoom_hint") + "</div>");
            if ((ledger.linesOmitted || 0) > 0) parts.push('<div class="dim small" style="margin-top:6px">' + t("det.omitted", { n: ledger.linesOmitted }) + "</div>");
        }
        parts.push("</div></div>");
        if (seamActive && seam.events.length > 0) {
            const evHead = '<tr><th class="num">#</th><th>' + t("det.fold_time") + '</th><th class="num">' + t("det.seam_col_hit") + '</th><th class="num">' + t("det.seam_col_input") + '</th><th>' + t("det.seam_col_div") + "</th></tr>";
            parts.push('<details open class="seam-ev"><summary title="' + escapeHtml(t("det.seam_events_tip")) + '"><b>' + t("det.seam_events", { n: seam.events.length }) + "</b></summary>"
                + '<div class="fold-scroll" style="max-height:320px;border:none;border-radius:0;padding:2px 8px 8px"><table class="data event-table"><thead>' + evHead + "</thead><tbody>");
            seam.events.forEach((ev) => {
                const cli = ev.client ? ' · <span style="color:#0969da">' + t("det.attr_client") + " @" + ev.client.idx + " (" + ev.client.role + "/" + ev.client.cls + ", " + fmtB(ev.client.len || 0) + ")</span>" : "";
                parts.push('<tr><td class="num">' + ev.seq + '</td><td class="num">' + (ev.at ? fmtDT(ev.at) : t("common.none")) + '</td><td class="num">' + (typeof ev.hitPct === "number" ? ev.hitPct.toFixed(1) + "%" : t("common.none")) + '</td><td class="num">' + fmtW(ev.input || 0) + '</td><td class="mono small">' + fmtB(ev.lcpBytes || 0) + " @ " + t("det.seam_msg", { i: ev.msgIndex != null ? ev.msgIndex : "?", prev: ev.prevMsgs != null ? ev.prevMsgs : "?", cur: ev.curMsgs != null ? ev.curMsgs : "?" }) + cli + "</td></tr>");
            });
            parts.push("</tbody></table></div></details>");
        }
        // #2131: key switch events (relay account rotation) — fingerprints only,
        // raw credentials never leave the ledger.
        const keySw = ledger.keySwitches;
        if (keySw && keySw.count > 0 && keySw.events && keySw.events.length > 0) {
            const kHead = '<tr><th class="num">#</th><th>' + t("det.fold_time") + '</th><th class="num">' + t("det.seam_col_hit") + '</th><th class="num">' + t("det.seam_col_input") + "</th><th>" + t("det.key_fp") + "</th></tr>";
            parts.push('<details open class="seam-ev"><summary title="' + escapeHtml(t("det.key_events_tip")) + '"><b>' + t("det.key_events", { n: keySw.count }) + "</b></summary>"
                + '<div class="fold-scroll" style="max-height:320px;border:none;border-radius:0;padding:2px 8px 8px"><table class="data event-table"><thead>' + kHead + "</thead><tbody>");
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
                + '<div class="fold-scroll" style="max-height:320px;border:none;border-radius:0;padding:2px 8px 8px"><table class="data event-table"><thead>' + pHead + "</thead><tbody>");
            promptSw.events.forEach((ev) => {
                parts.push('<tr><td class="num">' + ev.seq + '</td><td class="num">' + (ev.at ? fmtDT(ev.at) : t("common.none")) + '</td><td class="num">' + (typeof ev.hitPct === "number" ? ev.hitPct.toFixed(1) + "%" : t("common.none")) + '</td><td class="num">' + fmtW(ev.input || 0) + '</td><td class="mono small">' + (ev.from || "?") + " → " + (ev.to || "?") + "</td></tr>");
            });
            parts.push("</tbody></table></div></details>");
        }
        // #2867: proxy projection/mode switch events — same fingerprints-only rule.
        const projSw = ledger.projSwitches;
        if (projSw && projSw.count > 0 && projSw.events && projSw.events.length > 0) {
            const jHead = '<tr><th class="num">#</th><th>' + t("det.fold_time") + '</th><th class="num">' + t("det.seam_col_hit") + '</th><th class="num">' + t("det.seam_col_input") + "</th><th>" + t("det.proj_fp") + "</th></tr>";
            parts.push('<details open class="seam-ev"><summary title="' + escapeHtml(t("det.proj_events_tip")) + '"><b>' + t("det.proj_events", { n: projSw.count }) + "</b></summary>"
                + '<div class="fold-scroll" style="max-height:320px;border:none;border-radius:0;padding:2px 8px 8px"><table class="data event-table"><thead>' + jHead + "</thead><tbody>");
            projSw.events.forEach((ev) => {
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
                tail: Number(stRaw.tail) || 0,
                unknownOffset: Number(stRaw.unknownOffset) || 0,
                sizeBuckets: Array.isArray(stRaw.sizeBuckets) ? stRaw.sizeBuckets : [],
                gapSplit: stRaw.gapSplit && typeof stRaw.gapSplit === "object" ? stRaw.gapSplit : null,
            };
            const divParts = [];
            if (st.equal > 0) divParts.push('<span class="dim">' + escapeHtml(t("det.stab_identical")) + " <b>" + st.equal + "</b></span>");
            if (st.head > 0) divParts.push('<span style="color:#bf8700">' + escapeHtml(t("det.stab_head")) + " <b>" + st.head + "</b></span>");
            if (st.append > 0) divParts.push('<span style="color:#57606a">' + escapeHtml(t("det.stab_append")) + " <b>" + st.append + "</b></span>");
            if (st.mid > 0) divParts.push('<span style="color:#cf222e">' + escapeHtml(t("det.stab_mid")) + " <b>" + st.mid + "</b></span>");
            if (st.tail > 0) divParts.push('<span style="color:#57606a">' + escapeHtml(t("det.stab_tail")) + " <b>" + st.tail + "</b></span>");
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
            // #2929: percentages mirror the top-of-page basis — share of TOTAL
            // INPUT (same denominator as the cache-hit % above). The
            // unattributed tile's chips instead show their share of that
            // bucket's parent total — "what eats the 2.6M" is the useful split.
            const inp = Number(tot.input) || 0;
            const parentU = Number(tot.ttlRepay) || 0;
            const pc = (x) => (x >= 10 ? x.toFixed(0) : x.toFixed(1)) + "%";
            const pctIn = (v) => (+v > 0 && inp > 0) ? ' <span class="dim" style="font-size:.7em">' + pc((+v / inp) * 100) + "</span>" : "";
            const pctU = (v) => (parentU > 0 && +v > 0) ? " (" + pc((+v / parentU) * 100) + ")" : "";
            parts.push('<div class="grid cols-4">');
            mini(parts, t("det.ce_new"), fmtW(tot.newContent || 0) + pctIn(tot.newContent || 0));
            mini(parts, t("det.ce_comp"), fmtW(tot.compRepay || 0) + pctIn(tot.compRepay || 0), false, (tot.compRepay || 0) > 0 ? t("det.ce_comp_hint") : "");
            // #2929: the unattributed bucket shows its own composition INSIDE the
            // tile (label · value · then the parts, top to bottom) — containment
            // rendered as layout, not as a caption floating beside the tiles.
            const plainUnattrib = () => '<div class="stat"><div class="k">' + t("det.ce_ttl") + '</div><div class="v mono">' + fmtW(tot.ttlRepay || 0) + pctIn(tot.ttlRepay || 0) + "</div></div>";
            if (seam && (seam.missed > 0 || seam.providerTtl.count > 0 || seam.providerSide.count > 0 || seam.rewinds.count > 0 || seam.client.count > 0)) {
                var uChips = [];
                if (seam.missed > 0 || seam.suspects > 0) uChips.push('<span style="color:#cf222e" title="' + escapeHtml(t("det.attr_seam_tip")) + '">' + t("det.attr_seam") + " " + fmtW(seam.missed) + (seam.suspects > 0 ? " ×" + seam.suspects : "") + pctU(seam.missed) + "</span>");
                if (seam.providerTtl.missed > 0 || seam.providerTtl.count > 0) uChips.push('<span style="color:#1a7f37" title="' + escapeHtml(t("det.attr_ttl_tip")) + '">' + t("det.attr_ttl") + " " + fmtW(seam.providerTtl.missed) + (seam.providerTtl.count > 0 ? " ×" + seam.providerTtl.count : "") + pctU(seam.providerTtl.missed) + "</span>");
                if (seam.providerSide.missed > 0 || seam.providerSide.count > 0) uChips.push('<span style="color:#f0883e" title="' + escapeHtml(t("det.attr_provider_tip")) + '">' + t("det.attr_provider") + " " + fmtW(seam.providerSide.missed) + (seam.providerSide.count > 0 ? " ×" + seam.providerSide.count : "") + pctU(seam.providerSide.missed) + "</span>");
                if (seam.rewinds.missed > 0 || seam.rewinds.count > 0) uChips.push('<span style="color:#57606a" title="' + escapeHtml(t("det.attr_rewind_tip")) + '">' + t("det.attr_rewind") + " " + fmtW(seam.rewinds.missed) + (seam.rewinds.count > 0 ? " ×" + seam.rewinds.count : "") + pctU(seam.rewinds.missed) + "</span>");
                if (seam.client.missed > 0 || seam.client.count > 0) uChips.push('<span style="color:#0969da" title="' + escapeHtml(t("det.attr_client_tip")) + '">' + t("det.attr_client") + " " + fmtW(seam.client.missed) + (seam.client.count > 0 ? " ×" + seam.client.count : "") + pctU(seam.client.missed) + "</span>");
                if (seam.abortCorrelated > 0) uChips.push('<span style="color:#d4a72c" title="' + escapeHtml(t("det.attr_abort_tip")) + '">' + t("det.attr_abort") + " ×" + seam.abortCorrelated + "</span>");
                var uRest = Math.max(0, (tot.ttlRepay || 0) - seam.missed - seam.providerTtl.missed - seam.providerSide.missed - seam.rewinds.missed - seam.client.missed);
                if (uRest > 8192) uChips.push('<span style="color:#9aa1a8" title="' + escapeHtml(t("det.attr_rest_tip")) + '">' + t("det.attr_rest", { x: fmtW(uRest) }) + pctU(uRest) + "</span>");
                if (uChips.length) {
                    parts.push('<div class="stat"><div class="k">' + t("det.ce_ttl") + '</div><div class="v mono">' + fmtW(tot.ttlRepay || 0) + pctIn(tot.ttlRepay || 0) + '</div>'
                        + '<div class="dim small mono" style="margin-top:6px;line-height:1.7"><span>' + escapeHtml(t("det.ce_breakdown")) + "</span><br>" + uChips.join("<br>") + "</div></div>");
                } else {
                    parts.push(plainUnattrib());
                }
            } else {
                parts.push(plainUnattrib());
            }
            mini(parts, t("det.ce_residual"), fmtW(tot.residual || 0) + pctIn(tot.residual || 0));
            parts.push("</div>");
        }
        const folds = ledger.folds || [];
        parts.push('<div class="section-label" style="margin-top:14px">' + t("det.folds") + "</div>");
        if (!folds.length) parts.push('<div class="dim small">' + t("det.folds_empty") + "</div>");
        else {
            // All folds in one scrollable panel (same pattern as the compression blocks):
            // numeric headers align with their columns; long lists just scroll.
            const foldHead = '<tr><th class="num">#</th><th>' + t("det.fold_time") + '</th><th class="num">' + t("det.fold_s") + '</th><th class="num">' + t("det.fold_sigma") + '</th><th class="num">' + t("det.fold_h") + '</th><th class="num">' + t("det.fold_t") + '</th><th class="num">' + t("det.fold_ra") + '</th><th class="num">' + t("det.fold_saved") + "</th>" + (d.rates ? '<th class="num">' + t("det.fold_usd") + "</th>" : "") + "</tr>";
            const foldRow = (f, i) => {
                // #4899 v5: make "how much × how much" concrete per fold — the
                // later-request multiplier, its token credit, and the ≈$ when a
                // read rate resolves.
                const credit = ((f.S ?? 0) - (f.sigma ?? 0)) * (f.requestsAfter ?? 0);
                return '<tr><td class="num">' + (f.seq != null ? f.seq : i + 1) + '</td><td class="num">' + (f.at ? fmtDT(f.at) : t("common.none")) + '</td><td class="num">' + fmtW(f.S) + '</td><td class="num">' + fmtW(f.sigma) + '</td><td class="num">' + (f.hPct == null ? t("common.none") : f.hPct.toFixed(1) + "%") + '</td><td class="num">' + fmtW(f.T) + '</td><td class="num">' + fmtW(f.requestsAfter ?? 0) + '</td><td class="num">' + fmtW(credit) + "</td>" + (d.rates ? '<td class="num">' + fmtUsd((credit * d.rates.r) / 1e6) + "</td>" : "") + "</tr>";
};
            parts.push('<div class="fold-scroll"><table class="data fold-table"><thead>' + foldHead + '</thead><tbody>');
            folds.forEach((f, i) => parts.push(foldRow(f, i)));
            parts.push("</tbody></table></div>");
        }
        parts.push("</div></div>");
        // #2904: no-ceiling output-budget pin — surface at the top of the detail
        // so GUI users see WHY long turns truncate (the /acp twin).
        if (d.outputBudgetDegraded) parts.push('<div class="banner warn show" style="margin-bottom:12px">' + escapeHtml(t("det.obudget_degraded", { model: d.outputBudgetDegraded.model, value: d.outputBudgetDegraded.value })) + "</div>");
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
        parts.push("</div>");
        parts.push('<div class="det-pane" data-pane="blocks" hidden>' + buildTreePane(blocks) + "</div>");
        parts.push('<div class="det-pane" data-pane="handoff" hidden>');
        parts.push('<div class="card"><div class="card-h"><span>' + t("det.handoff") + '</span><span class="hint">' + t("det.handoff_hint") + '</span></div><div class="card-b">');
        // #1426: copy / download actions over the rendered handoff document
        parts.push('<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"><button id="handoff-copy-md" class="btn sm">' + t("det.handoff_copy_md") + '</button><button id="handoff-dl" class="btn sm">' + t("det.handoff_download") + "</button></div>");
        if (d.handoffTruncated) parts.push('<div class="banner warn show" style="margin:0 0 10px">' + t("det.handoff_truncated") + "</div>");
        if (d.handoffMd) parts.push('<div class="handoff">' + renderHandoffMd(d.handoffMd) + "</div>");
        else if (d.handoffHtml) parts.push('<div class="handoff">' + d.handoffHtml + "</div>");
        else parts.push('<div class="dim small">' + t("common.empty") + "</div>");
        parts.push("</div></div>");
        parts.push("</div>");
        return parts.join("");
    }
    async function loadDetail(id) {
        const host = $("session-detail-view");
        host.innerHTML = '<div class="empty"><span class="spin"></span> ' + t("common.loading") + "</div>";
        let d = null;
        try {
            d = await json(API_ROOT + "/sessions/" + encodeURIComponent(id) + "/detail");
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
            bindBlockContentActions(d);
            bindTreeModeActions();
            bindDetTabs();
            bindCacheReportActions(d);
            bindSessionReportActions(d);
            bindTrajectoryBrush(d);
            bindHitRateChart(d);
            const cc = $("session-conflicts-clear");
            if (cc) {
                cc.addEventListener("click", async () => {
                    busy(cc, true);
                    try {
                        await json(API_ROOT + "/conflicts/clear?session=" + encodeURIComponent(id), { method: "POST" });
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
    // #3040: generic report wiring shared by every warning banner — fetches the
    // topic's diagnostics report and binds #report-copy-btn (clipboard) +
    // #report-issue-link (prefilled GitHub issue) inside the given container.
    // The overview poll re-renders banners every 5s while degraded, so the
    // fetch is cached per topic (60s): without it each refresh re-hit
    // /__bili/diagnostics — a full server-side blob rebuild (listSessions +
    // whole-file log reads) — and re-toasted on every failed poll (the
    // #1937 poll backoff does not cover this fetch).
    const DIAG_CACHE_MS = 60_000;
    const diagCache = {};
    const diagToastedOnce = {};
    function bindReport(d, copyBtn, issueLink) {
        if (copyBtn) copyBtn.addEventListener("click", () => copyText(d.blob, copyBtn));
        if (issueLink && typeof d.url === "string") issueLink.href = d.url;
    }
    async function attachReportButtons(topic, host) {
        const copyBtn = host.querySelector("#report-copy-btn");
        const issueLink = host.querySelector("#report-issue-link");
        const hit = diagCache[topic];
        if (hit && Date.now() - hit.at < DIAG_CACHE_MS) return bindReport(hit.d, copyBtn, issueLink);
        busy(copyBtn, true);
        try {
            const d = await json(API_ROOT + "/diagnostics?topic=" + encodeURIComponent(topic));
            diagCache[topic] = { at: Date.now(), d };
            bindReport(d, copyBtn, issueLink);
        } catch (e) {
            if (!diagToastedOnce[topic]) { diagToastedOnce[topic] = true; toast(friendlyMsg(e), "err"); }
        } finally {
            busy(copyBtn, false);
        }
    }
    function refRangeOf(b) {
        return b.startRef ? (b.endRef && b.endRef !== b.startRef ? b.startRef + "–" + b.endRef : b.startRef) : null;
    }
    function buildBlockMd(b) {
        const rr = refRangeOf(b);
        const L = [];
        L.push("## Block " + b.blockId + (b.topic ? " — " + b.topic : "") + (b.active ? "" : " (inactive)"));
        L.push("");
        L.push("tier " + b.tier + " · ~" + fmtW(b.compressedTokens) + " tokens" + (b.createdAt ? " · " + fmtDT(b.createdAt) : "") + (rr ? " · " + rr : "") + (b.external ? " · ⚡" + t("det.block_external") : ""));
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
    // #3057 report export: MD/SVG render server-side (/__bili/session-report); the browser downloads MD and rasterizes the closed-vector SVG to PNG.
    function downloadUrl(url, name) {
        var a = document.createElement("a");
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }
    function svgToPngBlob(svgStr, w, h) {
        return new Promise(function (resolve, reject) {
            var scale = Math.max(1, Math.min(2, 1600 / w));
            var outW = Math.round(w * scale), outH = Math.round(h * scale);
            if (outH > 14000) { scale = 14000 / h; outW = Math.round(w * scale); outH = Math.round(h * scale); }
            var img = new Image();
            var url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }));
            img.onload = function () {
                try {
                    var canvas = document.createElement("canvas");
                    canvas.width = outW; canvas.height = outH;
                    var ctx = canvas.getContext("2d");
                    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, outW, outH);
                    ctx.drawImage(img, 0, 0, outW, outH);
                    URL.revokeObjectURL(url);
                    canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error("PNG encode failed")); }, "image/png");
                } catch (e) { URL.revokeObjectURL(url); reject(e); }
            };
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("SVG rasterize failed")); };
            img.src = url;
        });
    }
    function bindSessionReportActions(d) {
        var mdBtn = $("sessrpt-md"), pngBtn = $("sessrpt-png");
        if (!mdBtn && !pngBtn) return;
        var safeId = String(d.id).replace(/[^A-Za-z0-9._-]/g, "_");
        var base = "billion-context-report-" + safeId;
        var q = "session=" + encodeURIComponent(d.id) + "&mask=on&lang=" + (locale === "en" ? "en" : "zh-CN");
        if (mdBtn) mdBtn.addEventListener("click", async function () {
            busy(mdBtn, true);
            try {
                var r = await json(API_ROOT + "/session-report?format=md&" + q);
                if (!r || typeof r.md !== "string") throw new Error("no report");
                downloadUrl(URL.createObjectURL(new Blob([r.md], { type: "text/markdown;charset=utf-8" })), base + ".md");
            } catch (e) { toast(t("toast.failed", { msg: e.message }), "err"); } finally { busy(mdBtn, false); }
        });
        if (pngBtn) pngBtn.addEventListener("click", async function () {
            busy(pngBtn, true);
            try {
                var r = await json(API_ROOT + "/session-report?format=svg&" + q);
                if (!r || !r.svg) throw new Error("no report");
                var blob = await svgToPngBlob(r.svg, r.w || 920, r.h || 800);
                downloadUrl(URL.createObjectURL(blob), base + ".png");
            } catch (e) { toast(t("toast.failed", { msg: e.message }), "err"); } finally { busy(pngBtn, false); }
        });
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
    // #3917: pane switcher for the detail page — the last-used pane survives a
    // reload so a user who lives on the tree does not re-click every visit.
    function bindDetTabs() {
        const tabs = $("det-tabs");
        if (!tabs) return;
        const panes = document.querySelectorAll("#session-detail-view .det-pane");
        const show = (want) => {
            tabs.querySelectorAll(".det-tab").forEach((b) => b.classList.toggle("active", b.getAttribute("data-pane") === want));
            panes.forEach((p) => { p.hidden = p.getAttribute("data-pane") !== want; });
        };
        tabs.querySelectorAll(".det-tab").forEach((btn) => {
            btn.addEventListener("click", () => {
                const want = btn.getAttribute("data-pane") || "overview";
                show(want);
                try { sessionStorage.setItem("bili-det-pane", want); } catch (e) {}
            });
        });
        let saved = "overview";
        try { saved = sessionStorage.getItem("bili-det-pane") || "overview"; } catch (e) {}
        show(saved === "blocks" || saved === "handoff" ? saved : "overview");
    }
    // #3917: lazy raw-content loader per block — the tree ships summary + numbers
    // only; the conversation bytes behind a block come on demand. "one" is what
    // decompress(block) hands back, "full" is the whole covered span.
    // A summary clamp can only be measured once its card has layout —
    // side panels get checked on selection, classic list rows on first
    // expand. If the five-line clamp cut nothing, it is removed outright.
    function fixSumClamp(pn) {
        const body = pn.querySelector(":scope > .body.md");
        if (!body || body.__sumChk) return;
        body.__sumChk = 1;
        let sum = null, btn = null;
        for (let i = 0; i < body.children.length; i++) {
            const c = body.children[i];
            if (c.classList.contains("blk-sum")) sum = c;
            if (c.classList.contains("blk-sum-toggle")) btn = c;
        }
        if (!sum || !btn) return;
        if (sum.scrollHeight <= sum.clientHeight + 2) { sum.classList.remove("clamp"); btn.remove(); return; }
        btn.addEventListener("click", function () {
            const clamped = sum.classList.toggle("clamp");
            btn.textContent = clamped ? t("det.tree_sum_more") : t("det.tree_sum_less");
        });
    }
    function bindBlockContentActions(d) {
        document.querySelectorAll(".blk-content-btn").forEach((btn) => {
            btn.addEventListener("click", async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const bid = btn.getAttribute("data-bid") || "";
                const view = btn.getAttribute("data-view") === "full" ? "full" : "one";
                // #4608: classic list rows and the side panels share the
                // .blk-content class, so resolve the target box inside the
                // button's own card — getElementById would grab whichever
                // card happens to come first.
                const hostEl = btn.closest(".bd-panel") || btn.closest(".block-item");
                const box = hostEl ? hostEl.querySelector(":scope > .blk-content") : null;
                if (!box) return;
                // #4173 review: pressing the same button again collapses the
                // raw view (it used to be one-way, so users were stuck).
                if (!box.hidden && box.getAttribute("data-view") === view) { box.hidden = true; return; }
                if (box.getAttribute("data-state") === "ok" && box.getAttribute("data-view") === view) { box.hidden = false; return; }
                box.hidden = false;
                box.setAttribute("data-state", "loading");
                box.innerHTML = '<div class="empty small"><span class="spin"></span> ' + t("common.loading") + "</div>";
                busy(btn, true);
                try {
                    const r = await json(API_ROOT + "/sessions/" + encodeURIComponent(d.id) + "/block-content?blockId=" + encodeURIComponent(bid) + "&view=" + view);
                    box.setAttribute("data-state", "ok");
                    box.setAttribute("data-view", view);
                    const head = '<div class="blk-content-meta mono small">' + escapeHtml(t("det.tree_orig_meta", { n: r.count, b: fmtB(r.totalBytes) })) + (r.truncated ? ' <span class="warn-text">' + escapeHtml(t("det.tree_orig_truncated", { b: fmtB(r.bytes) })) + "</span>" : "") + "</div>";
                    box.innerHTML = head + '<pre class="blk-content-pre mono small">' + escapeHtml(r.text) + "</pre>";
                } catch (e) {
                    box.setAttribute("data-state", "err");
                    const msg = String(e && e.message ? e.message : e);
                    box.innerHTML = '<div class="dim small">' + escapeHtml(msg.indexOf("no-content-snapshot") >= 0 ? t("det.tree_orig_missing") : msg) + "</div>";
                } finally {
                    busy(btn, false);
                }
            });
        });
        // #3917: message leaves — first click fetches that one message's text.
        document.querySelectorAll(".msg-row").forEach((btn) => {
            btn.addEventListener("click", async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const row = btn.closest("li");
                const box = row ? row.querySelector(".msg-body") : null;
                if (!box) return;
                if (!box.hidden) { box.hidden = true; return; }
                if (box.getAttribute("data-state") === "ok") { box.hidden = false; return; }
                box.hidden = false;
                box.setAttribute("data-state", "loading");
                box.innerHTML = '<div class="empty small"><span class="spin"></span> ' + t("common.loading") + "</div>";
                try {
                    const ref = btn.getAttribute("data-ref") || "";
                    const r = await json(API_ROOT + "/sessions/" + encodeURIComponent(d.id) + "/message?ref=" + encodeURIComponent(ref));
                    box.setAttribute("data-state", "ok");
                    const meta = '<div class="blk-content-meta mono small">' + (r.toolName ? escapeHtml(r.toolName) + " · " : "") + escapeHtml(fmtB(r.totalBytes)) + (r.truncated ? ' <span class="warn-text">' + escapeHtml(t("det.tree_orig_truncated", { b: fmtB(r.bytes) })) + "</span>" : "") + "</div>";
                    box.innerHTML = meta + '<pre class="blk-content-pre mono small">' + escapeHtml(r.text) + "</pre>";
                } catch (e) {
                    box.setAttribute("data-state", "err");
                    const msg = String(e && e.message ? e.message : e);
                    box.innerHTML = '<div class="dim small">' + escapeHtml(msg.indexOf("unknown-message") >= 0 ? t("det.tree_msg_gone") : msg) + "</div>";
                }
            });
        });
        // #4173 review: classic list rows start collapsed — measure each
        // row's clamp once on first expand (panels get the same treatment
        // on selection).
        document.querySelectorAll("#tree-list .block-node").forEach((row) => {
            row.addEventListener("toggle", () => { if (row.open) fixSumClamp(row); });
        });
    }
    // #4608: master-detail pane binder — the left frame shows the
    // collapsible tree (default) or the classic folded-block list; in tree
    // mode the right side is the selected block's panel. Click selects;
    // chips (+N/−) expand or collapse a branch; Esc collapses back to the
    // roots. All hits are point-tested because the poller may have swapped
    // innerHTML under a pressed finger (same trick as the #4173 live map).
    let treeViewState = null;
    let treeViewRender = null;
    function bindTreeModeActions() {
        const graphView = $("tree-graph");
        const listView = $("tree-list");
        if (!graphView || !listView) return;
        const blocks = window.__biliDetailBlocks || [];
        const btns = Array.prototype.slice.call(document.querySelectorAll(".tree-mode"));
        const expBtn = $("tm-expand-all");
        const colBtn = $("tm-collapse-all");
        const gridEl = graphView.closest(".fd-grid");
        const sideEl = gridEl ? gridEl.querySelector(".fd-side") : null;
        const hintEl = $("tree-hint");
        let mode = "tree";
        try { mode = sessionStorage.getItem("bili-tree-mode") === "list" ? "list" : "tree"; } catch (e) {}
        const st = { mode: mode, selected: "", expanded: {} };
        treeViewState = st;
        function renderTree() {
            const inner = graphView.querySelector(".tm-inner");
            if (inner) inner.innerHTML = renderCollapSvg(blocks, st.expanded, st.selected).html;
        }
        treeViewRender = renderTree;
        function select(bid) {
            st.selected = bid;
            document.querySelectorAll("#tree-graph [data-bid]").forEach(function (el) {
                el.classList.toggle("fsel", el.getAttribute("data-bid") === bid);
            });
            let found = null;
            document.querySelectorAll("#bd-panels .bd-panel").forEach(function (pn) {
                const on = pn.getAttribute("data-bid") === bid;
                pn.hidden = !on;
                if (on) found = pn;
            });
            const empty = $("bd-empty");
            if (empty) {
                empty.style.display = found ? "none" : "";
                if (!found) empty.textContent = bid ? t("det.block_side_live") : t("det.block_side_hint");
            }
            if (found) fixSumClamp(found);
        }
        function hitEl(e) {
            let el = e.target;
            try { el = document.elementFromPoint(e.clientX, e.clientY) || el; } catch (err) {}
            return el;
        }
        function setMode(m) {
            st.mode = m;
            try { sessionStorage.setItem("bili-tree-mode", m); } catch (e) {}
            graphView.hidden = m !== "tree";
            listView.hidden = m !== "list";
            if (expBtn) expBtn.hidden = m !== "tree";
            if (colBtn) colBtn.hidden = m !== "tree";
            if (gridEl) gridEl.classList.toggle("list-mode", m === "list");
            if (sideEl) sideEl.hidden = m !== "tree";
            if (hintEl) hintEl.textContent = m === "tree" ? t("det.tree_interact") : t("det.tree_list_hint");
            btns.forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-mode") === m); });
        }
        btns.forEach(function (b) {
            b.addEventListener("click", function (ev) { ev.preventDefault(); setMode(b.getAttribute("data-mode") === "list" ? "list" : "tree"); });
        });
        if (expBtn) expBtn.addEventListener("click", function () {
            blocks.forEach(function (b) { st.expanded[b.blockId] = true; });
            renderTree();
        });
        if (colBtn) colBtn.addEventListener("click", function () { st.expanded = {}; renderTree(); });
        const pressAt = { on: false, x: 0, y: 0 };
        function down(e) { if (e.button !== 0) return; pressAt.on = true; pressAt.x = e.clientX; pressAt.y = e.clientY; }
        function up(e) {
            if (!pressAt.on) return null;
            const moved = Math.abs(e.clientX - pressAt.x) > 3 || Math.abs(e.clientY - pressAt.y) > 3;
            pressAt.on = false;
            if (moved || e.button !== 0) return null;
            return hitEl(e);
        }
        graphView.addEventListener("pointerdown", down);
        graphView.addEventListener("pointercancel", function () { pressAt.on = false; });
        graphView.addEventListener("pointerup", function (e) {
            const el = up(e);
            if (!el) return;
            const chip = el.closest ? el.closest("[data-toggle]") : null;
            if (chip) {
                const bid = chip.getAttribute("data-toggle");
                if (st.expanded[bid]) delete st.expanded[bid]; else st.expanded[bid] = true;
                renderTree();
                return;
            }
            const n = el.closest ? el.closest("[data-bid]") : null;
            if (n) select(n.getAttribute("data-bid"));
        });
        // One global Esc listener per page life: collapse the tree back to
        // its roots (only while the tree is the visible reading). The view
        // and renderer resolve at keypress time, so a re-rendered detail
        // pane (hash navigation) stays reachable instead of closing over
        // the first pane's detached nodes.
        if (!window.__biliTreeEscBound) {
            window.__biliTreeEscBound = true;
            window.addEventListener("keydown", function (e) {
                const gv = $("tree-graph");
                if (e.key !== "Escape" || !treeViewState || !gv || gv.hidden) return;
                treeViewState.expanded = {};
                if (treeViewRender) treeViewRender();
            });
        }
        renderTree();
        setMode(mode);
    }

        function bindCacheReportActions(d) {
        const copyB = $("cacherpt-copy");
        const dlB = $("cacherpt-dl");
        if (!copyB || !dlB) return;
        const grab = async () => {
            const r = await json(API_ROOT + "/cache-report?session=" + encodeURIComponent(d.id));
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
            const cfg = await json(API_ROOT + "/config");
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
            ["cfg-file-edit", "save-file", "save-upstream", "save-quick", "save-summary", "save-pricing"].forEach((id) => { const el = $(id); if (el) el.disabled = broken; });
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
            void loadPricing();
        } catch (e) {
            toast(t("toast.failed", { msg: e.message }), "err");
        }
    }
    // #4899: per-model billing price editor — GET /__bili/pricing renders one
    // row per model the panel has seen (plus existing override keys); the
    // models.dev registry defaults prefill the placeholders; Save PUTs
    // {billing:{prices}} through the structured config section (hot-applied).
    let pricingModels = [];
    function priceBadge(m) {
        if (m.override) return '<span class="badge ok">' + t("cfg.pricing_src_config") + "</span>";
        if (m.price) return '<span class="badge disk">' + t("cfg.pricing_src_registry") + "</span>";
        return '<span class="badge warn">' + t("cfg.pricing_src_none") + "</span>";
    }
    function priceInput(m, f, label) {
        const ov = m.override && m.override[f] != null ? m.override[f] : "";
        const def = m.price && m.price[f] != null ? m.price[f] : "";
        return '<label style="flex:1;min-width:110px"><span class="dim small">' + label + '</span>'
            + '<input class="field-input mono" data-f="' + f + '" value="' + ov + '" placeholder="' + (def !== "" ? def : "—")
            + '" inputmode="decimal" spellcheck="false"></label>';
    }
    function renderPricing() {
        const host = $("pricing-fields");
        if (!host) return;
        if (!pricingModels.length) { host.innerHTML = '<span class="dim small">' + t("cfg.pricing_empty") + "</span>"; return; }
        host.innerHTML = pricingModels.map((m) =>
            '<div class="price-row" data-model="' + escapeHtml(m.model) + '" style="display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:1px solid var(--border,#e1e4e8)">'
            + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="mono small">' + escapeHtml(m.model) + "</span>" + priceBadge(m)
            + '<button class="btn sm" data-del="1" title="' + escapeHtml(t("cfg.pricing_del")) + '">✕</button></div>'
            + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
            + priceInput(m, "input", t("cfg.pricing_input"))
            + priceInput(m, "output", t("cfg.pricing_output"))
            + priceInput(m, "cacheRead", t("cfg.pricing_cacheread"))
            + priceInput(m, "cacheWrite", t("cfg.pricing_cachewrite"))
            + "</div></div>").join("");
        const note = host.parentElement ? host.parentElement.querySelector(".cfg-dirty-note") : null;
        if (note) note.hidden = true;
    }
    async function loadPricing() {
        const host = $("pricing-fields");
        if (!host) return;
        try {
            const data = await json(API_ROOT + "/pricing");
            pricingModels = Array.isArray(data.models) ? data.models : [];
            renderPricing();
        } catch (e) {
            host.innerHTML = '<span class="dim small">' + escapeHtml(t("toast.failed", { msg: e.message })) + "</span>";
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
            data = await json(API_ROOT + "/resign");
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
        try { const p = parseConfigDraft(fe && fe.value ? fe.value : "{}"); draft = p && typeof p === "object" && !Array.isArray(p) ? p : {}; } catch (e) { return; }
        function compressOf(d) { return (d.compress && typeof d.compress === "object" && !Array.isArray(d.compress)) ? d.compress : null; }
        const NUDGE_DEFAULT = 50000, NUDGE_STEP = 5000, NUDGE_LOW = 20000, NUDGE_HIGH = 100000;
        const PRM_KERNEL_DEFAULT = 3;
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
                const p = parseConfigDraft(fe && fe.value ? fe.value : "{}");
                if (!p || typeof p !== "object" || Array.isArray(p)) return {};
                return p;
            } catch (e) { quickBroken(true); return null; }
        }
        function syncAll() {
            const cp = compressOf(draft);
            dbg.inp.checked = draft.debug === true;
            ptRow.inp.checked = draft.passthrough === true;
            imgRow.inp.checked = draft.imageRescale !== false;
            const ab = (cp && cp.absorb && typeof cp.absorb === "object" && !Array.isArray(cp.absorb)) ? cp.absorb : null;
            abRow.inp.checked = ab ? ab.enabled === true : false;
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
            const ds = (draft.dsh && typeof draft.dsh === "object" && !Array.isArray(draft.dsh)) ? draft.dsh : null;
            dshCtxRow.inp.checked = ds ? ds.contextTab !== false : true;
            dshLblInp.value = (ds && typeof ds.contextTabLabel === "string") ? ds.contextTabLabel : "";
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
        const imgRow = row("quick-imgrescale", t("cfg.q_imgrescale"));
        qCtrls.push(imgRow.inp);
        imgRow.inp.addEventListener("change", () => commit((d) => { if (imgRow.inp.checked) delete d.imageRescale; else d.imageRescale = false; }));
        const imgHint = document.createElement("span");
        imgHint.className = "dim small";
        imgHint.textContent = t("cfg.q_imgrescale_hint");
        imgRow.ctl.appendChild(imgHint);
        const dshCtxRow = row("quick-dsh-ctxtab", t("cfg.q_dsh_ctxtab"));
        qCtrls.push(dshCtxRow.inp);
        dshCtxRow.inp.addEventListener("change", () => commit((d) => {
            const ds = (d.dsh && typeof d.dsh === "object" && !Array.isArray(d.dsh)) ? d.dsh : {};
            if (dshCtxRow.inp.checked) delete ds.contextTab; else ds.contextTab = false;
            if (Object.keys(ds).length === 0) delete d.dsh; else d.dsh = ds;
        }));
        const dshCtxHint = document.createElement("span");
        dshCtxHint.className = "dim small";
        dshCtxHint.textContent = t("cfg.q_dsh_ctxtab_hint");
        dshCtxRow.ctl.appendChild(dshCtxHint);
        const dshLblInp = textRow("quick-dsh-ctxtab-label", t("cfg.q_dsh_ctxtab_label"));
        qCtrls.push(dshLblInp);
        dshLblInp.addEventListener("change", () => commit((d) => {
            const v = dshLblInp.value.trim();
            const ds = (d.dsh && typeof d.dsh === "object" && !Array.isArray(d.dsh)) ? d.dsh : {};
            if (v.length > 0) ds.contextTabLabel = v; else delete ds.contextTabLabel;
            if (Object.keys(ds).length === 0) delete d.dsh; else d.dsh = ds;
        }));
        const abRow = row("quick-absorb", t("cfg.q_absorb"));
        qCtrls.push(abRow.inp);
        abRow.inp.addEventListener("change", () => commit((d) => {
            if (abRow.inp.checked) {
                if (!compressOf(d)) d.compress = {};
                const a = d.compress.absorb;
                d.compress.absorb = (a && typeof a === "object" && !Array.isArray(a)) ? a : {};
                d.compress.absorb.enabled = true;
            } else {
                const c = compressOf(d);
                if (c) {
                    delete c.absorb;
                    if (Object.keys(c).length === 0) delete d.compress;
                }
            }
        }));
        const abHint = document.createElement("span");
        abHint.className = "dim small";
        abHint.textContent = t("cfg.q_absorb_hint");
        abRow.ctl.appendChild(abHint);
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
        // #3488: five-state view; falls back to the legacy boolean on old servers.
        const detail = cfg.externalSummaryCredentialStatus || {};
        function read() {
            const draft = parseConfigDraft(fe.value || "{}");
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
                    // #3488: distinguish "not set" from "set but unusable" and
                    // "store broken" — all of them used to render as 未配置.
                    const state = ref ? detail[ref] : undefined;
                    const badgeState = state !== undefined ? state : (ref && status[ref]) ? "configured" : "missing";
                    const badge = document.createElement("span");
                    badge.className = "badge " + (badgeState === "configured" ? "ok" : badgeState === "missing" ? "disk" : "warn");
                    badge.textContent = badgeState === "configured" ? t("summary.key_set") : badgeState === "missing" ? t("summary.key_missing") : badgeState === "invalid_value" ? t("summary.key_invalid") : badgeState === "store_unreadable" ? t("summary.key_unreadable") : t("summary.key_bad_ref");
                    row.appendChild(badge);
                    if (ref && ref.indexOf("secret:") === 0) {
                        const key = field(row, "summary-key-" + name, t("summary.key"), "", () => {}, "password");
                        key.autocomplete = "new-password"; key.disabled = !!cfg.parseError;
                        async function saveKey(btn, value) {
                            busy(btn, true);
                            try {
                                const result = await json(API_ROOT + "/external-summary/credential", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: recipe.credentialRef, key: value }) });
                                key.value = ""; status[ref] = result.configured; detail[ref] = result.configured ? "configured" : "missing";
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
            const pool = document.createElement("div"); pool.className = "summary-grid";
            const conc = field(pool, "summary-concurrency", t("summary.concurrency"), s.concurrency, (value) => mutate((v) => { v.concurrency = value; }), "number");
            conc.max = "32"; conc.disabled = !!cfg.parseError;
            box.appendChild(pool);
        }
        render();
        fe.onchange = render;
    }
    async function loadUpstream(cfg) {
        let up = null;
        try { up = await json(API_ROOT + "/upstream"); } catch (e) {}
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
            const d = await json(API_ROOT + "/logs?q=" + encodeURIComponent(q) + "&lines=" + (linesSel ? linesSel.value : "500") + logViewExtras());
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
        const top = hbase.match(new RegExp("^#/(overview|config|updates|connect|logs|blog)$"));
        if (top) {
            name = top[1];
            if (name === "logs" && hq) applyLogFilter(hq);
        } else {
            const ses = hash.match(new RegExp("^#/sessions(?:/(.+))?$")) || hash.match(new RegExp("^#/session/(.+)$"));
            const blg = hash.match(new RegExp("^#/blog/(.+)$"));
            if (ses) {
                name = "sessions";
                if (ses[1]) detailId = decodeURIComponent(ses[1]);
            } else if (blg) {
                name = "blog";
                detailId = decodeURIComponent(blg[1]);
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
        else if (name === "updates") loadUpdates();
        else if (name === "blog") loadBlog(detailId);
        else if (name === "logs") loadLogs();
    }
    window.addEventListener("hashchange", route);
    // #2489: Esc resets a zoomed trajectory view from anywhere on the page.
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") chartZooms.forEach((z) => { if (z.range) z.setRange(null); }); });

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
            search.addEventListener("input", () => { clearTimeout(sesTimer); sesTimer = setTimeout(() => refreshSessions(false, 1), 300); });
        }
        const sref = $("ses-refresh");
        if (sref) sref.addEventListener("click", () => refreshSessions(true, sesPage));
        ["ses-protocol", "ses-client", "ses-state"].forEach((id) => {
            const el = $(id);
            if (el) el.addEventListener("change", () => refreshSessions(false, 1));
        });
        const reset = $("ses-reset-filters");
        if (reset) reset.addEventListener("click", resetSessionFilters);
        const prev = $("ses-prev");
        if (prev) prev.addEventListener("click", () => goToSessionPage(sesPage - 1));
        const next = $("ses-next");
        if (next) next.addEventListener("click", () => goToSessionPage(sesPage + 1));
        // #3719 phase 2: 更新/Updates tab actions — check now / upgrade now /
        // install selected. One shared in-flight flag (see upSetButtons).
        const uchk = $("up-check");
        if (uchk) uchk.addEventListener("click", () => upCheckNow());
        const unow = $("up-upgrade-now");
        if (unow) unow.addEventListener("click", () => upUpgradeNow());
        const usel = $("up-select");
        const unins = $("up-install");
        if (usel) usel.addEventListener("change", () => { if (unins) unins.disabled = upBusyAction || !usel.value; focusChangelogRelease(usel.value); });
        if (unins) unins.addEventListener("click", () => upInstallSelected());
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
                const r = await fetch(API_ROOT + "/logs?raw=1&q=" + encodeURIComponent(q) + "&lines=2000" + logViewExtras());
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
                const r = await fetch(API_ROOT + "/logs?raw=1&all=1");
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
                const r = await json(API_ROOT + "/upstream/test", { method: "POST" });
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
            try { parsed = parseConfigDraft(raw || "{}"); } catch (e) { toast(t("cfg.invalid_json"), "err"); return; }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { toast(t("cfg.invalid_json"), "err"); return; }
            await putCfg(sq, { file: raw });
        });
        // #1426: single raw config-file editor — the server validates every known field
        const sf = $("save-file");
        const ss = $("save-summary");
        if (ss) ss.addEventListener("click", () => putCfg(ss, { file: $("cfg-file-edit").value }));
        // #4899: billing price editor events — add-model, per-row delete, and
        // Save (validates every filled field, PUTs {billing:{prices}}).
        const addBtn = $("pricing-add-btn");
        if (addBtn) addBtn.addEventListener("click", () => {
            const inp = $("pricing-add-model");
            const model = inp ? inp.value.trim() : "";
            if (!model) { toast(t("cfg.pricing_add_ph"), "err"); return; }
            if (pricingModels.some((m) => m.model === model)) { toast(t("cfg.pricing_dup"), "err"); return; }
            pricingModels.push({ model, price: null, override: null });
            inp.value = "";
            renderPricing();
            const note = $("pricing-fields").parentElement.querySelector(".cfg-dirty-note");
            if (note) note.hidden = false;
        });
        const pf = $("pricing-fields");
        if (pf) pf.addEventListener("click", (ev) => {
            const del = ev.target && ev.target.closest ? ev.target.closest("[data-del]") : null;
            if (!del) return;
            const row = del.closest(".price-row");
            if (!row) return;
            const model = row.getAttribute("data-model") || "";
            pricingModels = pricingModels.filter((m) => m.model !== model);
            renderPricing();
        });
        if (pf) pf.addEventListener("input", () => {
            const note = pf.parentElement.querySelector(".cfg-dirty-note");
            if (note) note.hidden = false;
        });
        const spr = $("save-pricing");
        if (spr) spr.addEventListener("click", async () => {
            const prices = {};
            try {
                pf.querySelectorAll(".price-row").forEach((row) => {
                    const model = row.getAttribute("data-model") || "";
                    if (!model) return;
                    const read = (f) => {
                        const el = row.querySelector('[data-f="' + f + '"]');
                        const v = el ? String(el.value || "").trim() : "";
                        if (v === "") return undefined;
                        const n = Number(v);
                        if (!isFinite(n) || n < 0) throw new Error(model + ": " + f);
                        return n;
                    };
                    const input = read("input");
                    if (input == null) return;
                    const entry = { input };
                    const output = read("output");
                    if (output != null) entry.output = output;
                    const cacheRead = read("cacheRead");
                    if (cacheRead != null) entry.cacheRead = cacheRead;
                    const cacheWrite = read("cacheWrite");
                    if (cacheWrite != null) entry.cacheWrite = cacheWrite;
                    prices[model] = entry;
                });
            } catch (e) {
                toast(t("cfg.pricing_invalid", { msg: e.message }), "err");
                return;
            }
            if (await putCfg(spr, { billing: { prices } })) loadPricing();
        });
        if (sf) sf.addEventListener("click", async () => {
            const el = $("cfg-file-edit");
            const raw = el ? el.value : "";
            let parsed;
            try { parsed = parseConfigDraft(raw || "{}"); } catch (e) { toast(t("cfg.invalid_json"), "err"); return; }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { toast(t("cfg.invalid_json"), "err"); return; }
            await putCfg(sf, { file: raw });
        });
        const cp = $("clear-passthrough");
        if (cp) cp.addEventListener("click", async () => {
            busy(cp, true);
            try {
                await json(API_ROOT + "/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ passthrough: null }) });
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

    // #4173: keep the in-pane tree panorama live while a session detail is open.
    // Decorative lane: failures keep the last good frame and never touch the
    // error strip or the #1937 backoff ladder (always resolves true). Re-renders
    // only when the block population actually changed; the viewer's zoom
    // (view.__vm) is restored on top of each rebuild.
    let mapBusy = false;
    let lastMapSig = "";
    async function refreshTreeMap() {
        if (mapBusy) return true;
        const view = $("tree-graph");
        if (!view || view.hidden) return true; // list mode: nothing live to repaint
        const m = location.hash.match(new RegExp("^#/session/(.+)$"));
        if (!m) return true;
        mapBusy = true;
        try {
            const r = await json(API_ROOT + "/sessions/" + encodeURIComponent(m[1]) + "/tree");
            if (r && Array.isArray(r.blocks)) {
                const sig = r.blocks.map(function (b) { return b.blockId + String(b.tier) + (b.active ? "a" : "") + ":" + (b.directBlockIds || []).join(","); }).join("|");
                if (sig !== lastMapSig) {
                    lastMapSig = sig;
                    // #4608: repaint only the tree drawing — expansion and
                    // selection survive the tick (the list is static DOM).
                    const inner = view.querySelector(".tm-inner");
                    const stv = treeViewState || { expanded: {}, selected: "" };
                    if (inner) inner.innerHTML = renderCollapSvg(r.blocks, stv.expanded, stv.selected).html;
                }
            }
        } catch (e) {
            /* decorative lane — keep the stale frame */
        } finally {
            mapBusy = false;
        }
        return true;
    }

    hydrate();
    initStaticHandlers();
    loadChangelog();
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
            if (current === "sessions" && $("session-detail-view").hidden && sesPage === 1 && !hasActiveFilters()) ok = (await refreshSessions(false, 1)) && ok;
            else if (current === "logs") ok = (await loadLogs()) && ok;
            // #4173: session DETAIL view → keep the in-pane tree panorama live.
            else if (current === "sessions") ok = (await refreshTreeMap()) && ok;
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
