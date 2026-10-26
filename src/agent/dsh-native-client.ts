// #1590: browser half of the dsh dual-face plugin (dsh.client). The tsup
// build wraps this CJS body in window.__ModuleLoader__.load({id, factory}) —
// two load-bearing invariants invisible from this file alone: the id MUST
// equal the loader entry name the scanner keys its graph row by ("loaded
// without registering" otherwise), and the factory's `require` resolves only
// through dsh's module system, so react is the sole permitted external.
// Origin discovery has two paths (#1809): the host half (dsh-native.ts)
// injects globalThis.__BILI__ = {origin} into the web index at render time —
// a boot-time snapshot that a page loaded before spawn-mode bootstrap (or a
// desktop boot payload, captured once per app launch) never carries — and it
// serves the live origin at GET /bili/origin on the dsh webserver. The
// snapshot is only a FIRST-PAINT HINT (#2288): attach-mode presets publish
// the env origin at startup while the host re-binds it at runtime (dead-attach
// fallback spawn, routed-origin convergence), so freezing on whatever the page
// captured left the button pointing at a dead URL for the whole session. This
// section therefore keeps polling the live route for the whole mount (fast
// until the first resolution, slow after) and the entry follows wherever the
// proxy actually listens — no reload or app restart. Neither source known ⇒
// degrade to a hint instead of a dead link. #2321: once bound, the panel
// embeds the REAL web UI — a native tab bar (overview/sessions/config/logs)
// driving one iframe at origin/__bili/ with ?embed=1 plus a hash route; tab
// switches move only the fragment, so the frame navigates same-document
// (hashchange) without a full reload — and since its src tracks the polled
// origin, a mid-session re-bind moves the frame in place too. The
// open-in-browser button survives as the escape hatch; #2448: the host panel
// is a NARROW column, so the backup button keeps the origin in a tooltip
// instead of the label (a URL + nowrap squeezed the hint row into a sliver)
// and the frame height follows the host viewport. lang mirrors the host
// locale: bind() resolves against the live dsh locale, and comparing the
// resolved nav label with the registered zh value is the only locale signal
// the client contract exposes. #2559: theme follows the HOST page too —
// an app-level dsh dark setting is invisible to the framed document's
// prefers-color-scheme, so we sample the actual on-screen ground of this page
// (same-origin) and pin the face via &theme=light|dark; first paint reads it
// synchronously, later probe ticks pick up mid-session toggles. The same panel is mounted at two slots (#2125): settings.section
// (always present — the launcher posture has no bundle page) and
// plugins.bundle.config (keyed by package name; the plugin detail page renders
// it only when this package is installed as a profile bundle and draws the
// title itself, so that registration drops the h3). #3862: a THIRD face — a
// per-session Context tab in the official dsh client (conversation.view slot).
// dsh exposes no API to edit the context stream, so host-side stat plugins
// anchored on the event log can never observe bili's folds (their bar freezes
// at the pre-compression caliber, dsh-context#173). Instead of a second
// native re-rendering of the data, the tab EMBEDS the web UI's OWN session
// page (?embed=1 + #/session/<id>) — compression tree and ledger readouts
// stay in one place, the frame. The frame is bound to THIS conversation:
// dsh names it to every conversation.view entry (props.sessionId — the same
// id the lane stamps on x-bili-plugin-conversation), so the status poll asks
// for that exact id; a fallback-resolved row belonging to a sibling
// conversation or an acp_delegate sub-agent is refused at render time
// instead of hijacking the frame (older hosts pass no props and keep the
// historical latest-session behaviour); while no session exists yet the tab
// shows an honest hint instead of an empty frame.

import { createElement, useEffect, useState } from "react";

type Dict = Record<string, string>;

type SlotOptions =
    | { name: string; id: string; order: number; label: () => string; locale: string }
    | { name: string; key: string; locale: string };

type ClientContext = {
    effect: (fn: () => void | (() => void), label?: string) => void;
    locale: {
        register: (ns: string, dict: { zh: Dict; en: Dict }) => void;
        bind: (ns: string) => (key: string) => string;
    };
    slots: {
        inject: (slot: string, provide: () => void) => void;
        register: (options: SlotOptions, component: (props: Record<string, unknown>) => unknown) => unknown;
    };
};

export const inject = ["slots", "locale"];

const NS = "bili";

// #1809/#2187/#2288: live-origin probe cadence — first attempt immediate,
// then a retry every POLL_INTERVAL_MS for POLL_MAX_ATTEMPTS total (~30s),
// after which probing CONTINUES at SLOW_POLL_INTERVAL_MS until the page
// unmounts. #2187: the server side now heals a failed spawn-mode bootstrap
// in the background and a slow Windows boot can take minutes, so stopping at
// ~30s stranded the entry on "not bound" for the whole session. #2288: the
// slow phase also runs AFTER the first resolution — the host re-binds the
// origin mid-session (runtime re-spawn, routed-origin convergence), so the
// entry keeps following the live route instead of freezing on the first value.
const ORIGIN_PATH = "/bili/origin";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 10;
const SLOW_POLL_INTERVAL_MS = 10000;

// #2321: pages offered by the embedded face, in tab-bar order. Labels mirror
// the web UI's own nav terminology (src/web/i18n.ts) so each tab reads like
// the title of the page inside the frame. "connect" stays out: it documents
// how OTHER clients reach this proxy, which makes no sense from inside dsh.
const PAGE_IDS = ["overview", "sessions", "config", "logs", "updates"] as const;
type PageId = (typeof PAGE_IDS)[number];
const PAGE_KEYS: Record<PageId, string> = {
    overview: "tab_overview",
    sessions: "tab_sessions",
    config: "tab_config",
    logs: "tab_logs",
    updates: "tab_updates",
};

// #3816: the exact field a remote user adds to enable the #3373 relay. A
// fragment on purpose — pasting a whole object would clobber an existing
// config's other keys.
const REMOTE_RELAY_SNIPPET = '"security": { "adminRelay": true }';
const EMBED_HEIGHT = "min(640px, 78vh)";

// One look for the panel's action buttons (footer backup entry, #3816
// config-page jump) so the placements cannot drift apart visually.
const ACTION_BTN_STYLE = {
    cursor: "pointer",
    borderRadius: 8,
    border: "1px solid rgba(127,127,127,0.4)",
    background: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: 14,
    lineHeight: "22px",
    padding: "7px 16px",
    whiteSpace: "nowrap",
};

// #3862: Context tab data source + cadence. When the host names THIS
// conversation (slot props.sessionId — the same value the dsh lane stamps on
// x-bili-plugin-conversation upstream), the poll binds the tab to that exact
// conversation. `fallback=latest` is kept ONLY so the pre-first-request panel
// still resolves before our own first request; a fallback-resolved row that
// belongs to ANOTHER conversation is refused at render time (see the
// ownership gate below), so a concurrently-active acp_delegate sub-agent can
// never steal the frame. The literal "dsh" form remains for hosts that pass
// no identity (older builds: previous behaviour, preserved bit-for-bit).
// The response's `sessionId` field is what the embedded frame navigates to
// (#/session/<id>). Polling is slow by design: the id only changes when a
// conversation re-binds or a new one lands, so 10s is imperceptible lag at
// zero cost.
const CTX_STATUS_PATH = "/__bili/plugin/status?conversationId=dsh&fallback=latest";
const ctxStatusPathFor = (hostSessionId: string | undefined): string =>
    hostSessionId === undefined
        ? CTX_STATUS_PATH
        : `/__bili/plugin/status?conversationId=${encodeURIComponent(hostSessionId)}&fallback=latest`;
const CTX_POLL_MS = 10000;
// #4254: frame-level upstream-unavailable pill (shell.overlay) — same slow cadence
// as the per-session Context tab. A dead circuit retries on its own ~60s probe, so
// 10s keeps the "retry in ~Ns" hint fresh and clears the banner within one tick.
const UPSTREAM_POLL_MS = 10000;

type CtxStatus = {
    ok: boolean;
    phase?: string;
    panelPresent: boolean;
    sessionId: string | null;
    /** Which conversation id the resolved row was recorded under (null when
     *  the response carries none / predates the field). */
    conversationId: string | null;
    /** True when the server resolved the row via the fallback=latest pool
     *  instead of an exact conversation match. */
    viaFallback: boolean;
};

/** Parse the /__bili/plugin/status body into the tab's render shape. Every
 *  field is guard-wrapped: an older or foreign build answering the URL must
 *  yield `undefined` (→ degraded states), never a crash mid-render. Builds
 *  that predate the ownership fields simply omit them ⇒ viaFallback false,
 *  which preserves the historical render for those responses. */
function parseCtxStatus(raw: unknown): CtxStatus | undefined {
    const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (o === null || typeof o.ok !== "boolean") return undefined;
    return {
        ok: o.ok,
        phase: typeof o.phase === "string" ? o.phase : undefined,
        panelPresent: o.panel !== undefined,
        sessionId: typeof o.sessionId === "string" && o.sessionId.length > 0 ? o.sessionId : null,
        conversationId: typeof o.conversationId === "string" && o.conversationId.length > 0 ? o.conversationId : null,
        viaFallback: o.viaFallback === true,
    };
}

/** #3816: the unreachable-by-construction notice for remote browsers
 *  (loopback panel) — shared by the settings panel and the Context tab so the
 *  fix text, relay snippet and jump target cannot drift between placements.
 *  The jump button targets the panel's config page (#/config) in a fresh tab;
 *  for a purely remote browser that address is still unreachable — the
 *  file-edit text is the primary route, the button serves same-LAN/tunneled
 *  access where it lands on the exact field to set. #3693: an optional error
 *  readout rides underneath — the raw probe failure that PROVES the loopback
 *  address is unreachable from this browser (evidence + copyable for reports). */
function renderRemoteBlock(t: (key: string) => string, origin: string, errorReadout?: unknown): ReturnType<typeof createElement> {
    const cfgUrl = `${origin}/__bili/#/config`;
    return createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" } },
        createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("remote_blocked")),
        createElement(
            "code",
            {
                style: {
                    display: "block",
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1px solid rgba(127,127,127,0.4)",
                    background: "rgba(127,127,127,0.08)",
                    fontSize: 13,
                    lineHeight: 1.6,
                },
            },
            REMOTE_RELAY_SNIPPET,
        ),
        createElement(
            "button",
            { type: "button", title: cfgUrl, onClick: () => openExternal(cfgUrl), style: ACTION_BTN_STYLE },
            t("remote_open_config"),
        ),
        errorReadout ?? null,
    );
}

/** Shared open-in-browser action — one builder for the settings-panel footer,
 *  the embedded tab row and the Context tab so the placements cannot drift
 *  (label, tooltip, target). Returns null while the origin is unknown. */
function openWebButton(origin: string | undefined, t: (key: string) => string, style?: Record<string, string>): ReturnType<typeof createElement> {
    return origin === undefined
        ? null
        : createElement(
            "button",
            {
                type: "button",
                title: origin,
                onClick: () => openExternal(`${origin}/__bili/`),
                style: { ...ACTION_BTN_STYLE, ...style },
            },
            t("open"),
        );
}

// #3693: one self-contained line for a failed probe/status read — the raw
// engine message plus the URL that failed, so the copied text makes sense in
// a support report without extra context. Duck-typed on purpose: fetch
// failures cross realms in test sandboxes, where instanceof fails.
function describeProbeError(err: unknown, url: string): string {
    let msg: string;
    const o = err !== null && typeof err === "object" ? (err as { message?: unknown }) : undefined;
    if (o !== undefined && typeof o.message === "string" && o.message.length > 0) {
        msg = o.message;
    } else if (typeof err === "string" && err.length > 0) {
        msg = err;
    } else {
        try {
            msg = String(err);
        } catch {
            msg = "unknown error";
        }
    }
    return `${msg} (${url})`;
}

// #3693: clipboard write with a legacy fallback — LAN-http pages (the exact
// remote-access posture of #3693) are NOT secure contexts, so
// navigator.clipboard is absent there and the execCommand path is what
// actually copies. Resolves to whether the text landed on the clipboard.
function copyText(text: string): Promise<boolean> {
    const g = globalThis as {
        navigator?: { clipboard?: { writeText?: (t: string) => Promise<unknown> } };
        document?: {
            body?: { appendChild?: (n: unknown) => void; removeChild?: (n: unknown) => void } | null;
            createElement?: (tag: string) => unknown;
            execCommand?: (cmd: string) => boolean;
        };
    };
    const legacy = (): boolean => {
        const doc = g.document;
        if (!doc || typeof doc.createElement !== "function" || !doc.body || typeof doc.body.appendChild !== "function") return false;
        const ta = doc.createElement("textarea") as Record<string, unknown> & { select?: () => void };
        ta.value = text;
        ta.style = { position: "fixed", opacity: 0 };
        doc.body.appendChild(ta);
        try {
            ta.select?.();
        } catch {
            // non-DOM stand-in (test harness): selection is decorative there
        }
        const ok = doc.execCommand?.("copy") ?? false;
        try {
            doc.body.removeChild?.(ta);
        } catch {
            // ditto
        }
        return ok;
    };
    const clip = g.navigator?.clipboard;
    if (clip !== undefined && typeof clip.writeText === "function") {
        return clip.writeText(text).then(
            () => true,
            () => legacy(),
        );
    }
    return Promise.resolve(legacy());
}

// #3693: the failure readout shared by every connecting/degraded face — the
// raw error line in a selectable block plus an explicit copy action, so no
// failure state hides its evidence behind a friendly hint. The `copied` flag
// and the copy kick-off live with the PARENT component: hook order must stay
// stable across renders, so no hook is called here.
function renderProbeError(t: (key: string) => string, error: string, copied: boolean, onCopy: () => void): ReturnType<typeof createElement> {
    return createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" } },
        createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("probe_error")),
        createElement(
            "code",
            {
                style: {
                    display: "block",
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1px solid rgba(127,127,127,0.4)",
                    background: "rgba(127,127,127,0.08)",
                    fontSize: 13,
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                },
            },
            error,
        ),
        createElement(
            "button",
            {
                type: "button",
                title: error,
                onClick: onCopy,
                style: { ...ACTION_BTN_STYLE, fontSize: 13, lineHeight: "20px", padding: "4px 14px" },
            },
            copied ? t("copied") : t("copy"),
        ),
    );
}

// #3693: hint headline with the optional error readout riding beneath it —
// the hint wording stays untouched, the evidence is additive.
function hintColumn(hint: unknown, box: unknown): unknown {
    return box === null
        ? hint
        : createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" } },
            hint,
            box,
        );
}

// #3100: pre-flight for the framed face. Auto-update refreshes the profile
// bundle on DISK while the long-running proxy child keeps serving the code it
// booted with — and this browser half always runs the freshest disk code — so
// right after an update it frames a route the frozen server may not have yet
// (the query form landed in v0.1.189; older builds answer it with a raw JSON
// 404 inside the frame). Probe the exact embed URL once per origin BEFORE
// mounting: HTML ⇒ mount the frame; any other answer ⇒ the running build
// predates the route ⇒ show the restart notice instead (the backup button
// targets the bare /__bili/ form every build serves). A network error yields
// no verdict — the origin poll re-probes on its regular ticks. Verdicts are
// cached per origin for the page lifetime: a frozen process cannot gain
// routes mid-session.
const EMBED_PROBE_PATH = "/__bili/?embed=1";
type EmbedVerdict = "ok" | "stale";
// #3693: verdict undefined + error set means "probe failed with evidence" —
// transient by definition (never cached; retried on every poll tick), so the
// face can show WHAT failed instead of spinning on "connecting…" forever.
type EmbedState = { origin: string; verdict: EmbedVerdict | undefined; error?: string };
const embedVerdicts = new Map<string, EmbedVerdict>();
const embedProbesInFlight = new Set<string>();

function probeEmbedRoute(origin: string, onVerdict: (state: EmbedState) => void): void {
    if (typeof fetch !== "function") return;
    const cached = embedVerdicts.get(origin);
    if (cached !== undefined) {
        onVerdict({ origin, verdict: cached });
        return;
    }
    if (embedProbesInFlight.has(origin)) return;
    embedProbesInFlight.add(origin);
    void fetch(`${origin}${EMBED_PROBE_PATH}`)
        .then((res) => {
            let html = false;
            try {
                const ct = typeof res.headers.get === "function" ? res.headers.get("content-type") : "";
                html = res.ok && String(ct ?? "").includes("text/html");
            } catch {
                html = false;
            }
            const verdict: EmbedVerdict = html ? "ok" : "stale";
            embedVerdicts.set(origin, verdict);
            try {
                void res.body?.cancel?.().catch(() => {});
            } catch {
                // non-stream body (harness): nothing to release
            }
            onVerdict({ origin, verdict });
        })
        .catch((err: unknown) => {
            // #3693: unreachable right now — report the failure verbatim so
            // the face shows WHAT failed instead of spinning forever. Unlike
            // ok/stale this is deliberately NOT cached: a network error is
            // transient, the next poll tick retries and replaces it.
            onVerdict({ origin, verdict: undefined, error: describeProbeError(err, `${origin}${EMBED_PROBE_PATH}`) });
        })
        .finally(() => {
            embedProbesInFlight.delete(origin);
        });
}

/** #2559: classify the host page's actual ground as light/dark. The framed
 *  bili face is a separate document — it only sees the browser/OS
 *  color-scheme, while dsh's dark theme is app-level. Same origin lets us
 *  sample what the user actually sees: walk the usual ground candidates,
 *  read each opaque background-color, vote by simple weighted luminance
 *  (near-black app grounds < 0.4, near-white > 0.4). No readable signal at
 *  all ⇒ fall back to the OS signal; nothing even for that ⇒ undefined and
 *  the frame stays OS-driven. Every read is guard-wrapped: older hosts or
 *  minimal DOMs must degrade to "no pin", never crash the panel. */
type ThemeDom = {
    document?: { documentElement?: unknown; body?: { querySelector?: (sel: string) => unknown } & Record<string, unknown> };
    getComputedStyle?: (el: unknown) => { backgroundColor?: unknown };
    matchMedia?: (q: string) => { matches: boolean };
};
function detectHostTheme(): "light" | "dark" | undefined {
    const g = globalThis as ThemeDom;
    try {
        const doc = g.document;
        if (!doc || typeof g.getComputedStyle !== "function") return undefined;
        const candidates: unknown[] = [];
        if (doc.documentElement) candidates.push(doc.documentElement);
        if (doc.body) candidates.push(doc.body);
        try {
            for (const sel of ["main", "[role=main]", "#root", "#app"]) {
                const el = doc.body?.querySelector?.(sel);
                if (typeof el === "object" && el !== null) candidates.push(el);
            }
        } catch {
            // non-DOM harness: ground sampling below just yields no votes
        }
        let lightVotes = 0;
        let darkVotes = 0;
        for (const c of candidates) {
            let bg: string;
            try {
                const v = g.getComputedStyle!(c).backgroundColor;
                if (typeof v !== "string") continue;
                bg = v;
            } catch {
                continue;
            }
            const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\/\s]+([\d.]+))?\)/.exec(bg);
            if (!m) continue; // transparent / named / unparsable → no vote
            const alpha = m[4] !== undefined ? Number(m[4]) : 1;
            if (alpha <= 0.5) continue;
            const luma = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
            if (luma <= 0.4) darkVotes += 1;
            else lightVotes += 1;
        }
        if (darkVotes !== lightVotes && (darkVotes > 0 || lightVotes > 0)) return darkVotes > lightVotes ? "dark" : "light";
    } catch {
        return undefined;
    }
    try {
        const mq = g.matchMedia?.("(prefers-color-scheme: dark)");
        if (mq) return mq.matches ? "dark" : "light";
    } catch {
        // no media support either — leave the face OS-driven
    }
    return undefined;
}

const zh: Dict = {
    "nav": "bili设置",
    "title": "billion-context 压缩代理",
    "open": "打开 Web UI",
    "hint": "查看压缩状态、会话与上下文窗口。",
    "degraded": "当前 dsh 进程未绑定 bili 代理（未经 bili dsh 启动，或代理尚未就绪）——先运行 /acp，或改用 bili dsh 启动。",
    "connecting": "正在连接 bili 代理…",
    "stale": "运行中的 bili 代理比已安装的配置文件旧：本页面已加载新版界面，但代理进程仍在提供旧版服务，暂时无法打开内嵌页面。若本应用已运行新版本，启动一个新会话即会自动换上新代理（也可手动结束旧代理进程立即生效）；若应用本身还是旧版本，请完全退出并重新启动 dsh。恢复前可点下方按钮直接打开 Web UI。",
    "remote_blocked": "本页面通过远程地址访问，而 bili 面板运行在服务器本机的回环地址（127.0.0.1）上——你的浏览器无法直连它（直连会指向你自己的电脑）。要远程打开面板：在服务器上编辑 ~/.config/billion-context/billion-context.json，向顶层对象加入下方字段并保存——本页会在数秒内自动生效（无需重启 dsh，刷新页面同样可以）；若你能直接访问该面板地址，也可点下方按钮在配置页开启。",
    "remote_open_config": "打开配置页",
    "tab_overview": "总览",
    "tab_sessions": "会话",
    "tab_config": "配置",
    "tab_logs": "日志",
    "tab_updates": "版本",
    "tab_ctx": "上下文",
    "ctx_waiting": "等待首个模型请求…",
    "ctx_nodata": "暂无上下文数据——完成一次模型请求后自动刷新。",
    "ctx_refresh": "刷新",
    "upstreams_label": "bili 上游状态",
    "upstreams_down_one": "1 个上游不可用",
    "upstreams_down_many": "{n} 个上游不可用",
    "upstream_retry_hint": "约 {s}s 后重试",
    "probe_error": "连接 bili 代理失败——最近一次探测报出的错误（可复制，便于反馈）：",
    "copy": "复制",
    "copied": "已复制",
};

const en: Dict = {
    "nav": "bili",
    "title": "billion-context compression proxy",
    "open": "Open Web UI",
    "hint": "Inspect compression status, sessions and context windows.",
    "degraded": "This dsh process is not bound to a bili proxy (not launched via bili dsh, or the proxy is not up yet) — run /acp first, or launch through bili dsh.",
    "connecting": "Connecting to the bili proxy…",
    "stale": "The running bili proxy is older than the installed profile: this page already runs the new face, but the proxy process still serves the old build, so the embedded page cannot be opened yet. If this app itself runs the new version, starting a new session swaps in the new proxy automatically (or kill the old proxy process manually for an immediate switch); if the app itself is still on the old version, fully quit and relaunch dsh. Until then, use the button below to open the Web UI directly.",
    "remote_blocked": "This page is reached through a remote address, but the bili panel runs on the server's own loopback address (127.0.0.1) — your browser cannot reach it directly (it would point at your own machine). To open the panel remotely: edit ~/.config/billion-context/billion-context.json on the server and add the field below to the top-level object — this page picks it up within seconds (no dsh restart needed; reloading works too); if you CAN reach that panel address directly, use the button below to enable it from the config page.",
    "remote_open_config": "Open config page",
    "tab_overview": "Overview",
    "tab_sessions": "Sessions",
    "tab_config": "Config",
    "tab_logs": "Logs",
    "tab_updates": "Versions",
    "tab_ctx": "Context",
    "ctx_waiting": "Waiting for the first model request…",
    "ctx_nodata": "No context data yet — refreshes automatically after the first model request.",
    "ctx_refresh": "Refresh",
    "upstreams_label": "bili upstream status",
    "upstreams_down_one": "1 upstream unavailable",
    "upstreams_down_many": "{n} upstreams unavailable",
    "upstream_retry_hint": "~{s}s until retry",
    "probe_error": "Failed to reach the bili proxy — last probe error (copyable for reporting):",
    "copy": "Copy",
    "copied": "Copied",
};

function readOrigin(): string | undefined {
    const g = globalThis as { __BILI__?: { origin?: unknown; relay?: unknown } };
    const snap = g.__BILI__;
    // #3373: relay snapshot — the entry serves the admin surface itself, so
    // the base is same-origin ("" = entry-relative paths). Prefix gateways
    // correct this to an absolute base on the first live probe.
    if (snap !== undefined && snap.relay === true) return "";
    const origin = snap?.origin;
    return typeof origin === "string" && origin.length > 0 ? origin : undefined;
}

/** #4237: Context-tab face flags from the __BILI__ snapshot (host half,
 *  dsh.contextTab / dsh.contextTabLabel): `hidden` drops the conversation.view
 *  registration entirely (the top-bar entry only — compression is untouched),
 *  `label` overrides the built-in "上下文"/"Context" for machines where another
 *  plugin occupies the same name. Both fail open: absent fields (legacy host,
 *  pre-bootstrap page load) keep today's behavior byte-identical. */
function readCtxTabFace(): { hidden: boolean; label: string | undefined } {
    const g = globalThis as { __BILI__?: { contextTab?: unknown; contextTabLabel?: unknown } };
    const snap = g.__BILI__;
    const hidden = snap !== undefined && snap.contextTab === false;
    const raw = snap?.contextTabLabel;
    const label = typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
    return { hidden, label };
}

function openExternal(url: string): void {
    const w = globalThis as { open?: (url: string, target?: string, features?: string) => unknown };
    if (typeof w.open === "function") w.open(url, "_blank", "noopener,noreferrer");
}

/** #3373: relay mode — the probe response carries `relay: true` instead of
 *  a loopback origin. Derive the UI base from the probe's own response URL:
 *  whatever origin+prefix carried the probe also serves /__bili/. An empty
 *  base means same-origin paths (root deployments, test harnesses). */
function relayBaseOf(res: { url?: unknown }): string {
    const url = typeof res.url === "string" ? res.url : "";
    if (url.endsWith(ORIGIN_PATH)) {
        const base = url.slice(0, -ORIGIN_PATH.length).replace(/\/+$/, "");
        return base.length > 0 ? base : "";
    }
    return "";
}

/** #3816: hosts that mean "this machine" from the browser's point of view. */
function isLoopbackHost(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

// #3816: remote-access mismatch — the bound origin is the server's loopback
// while THIS page was reached through a non-loopback address, so the
// browser's 127.0.0.1 is its own machine and the origin is unreachable by
// construction. Left alone the entry spins on "connecting…" forever and the
// backup button opens a dead link; instead the face explains the fix
// (security.adminRelay, #3373). Client-side detection on purpose: server
// socket inspection breaks under reverse proxies. Undecidable (no location,
// no URL constructor, unparsable origin) ⇒ false ⇒ old behavior stands.
function remoteMismatch(origin: string | undefined): boolean {
    if (origin === undefined || origin.length === 0) return false; // relay mode: same-origin paths are reachable by construction
    let parsed: { hostname?: unknown };
    try {
        parsed = new URL(origin);
    } catch {
        return false;
    }
    const originHost = typeof parsed.hostname === "string" ? parsed.hostname : "";
    if (!isLoopbackHost(originHost)) return false;
    const g = globalThis as { location?: { hostname?: unknown } };
    const pageHost = typeof g.location?.hostname === "string" ? g.location.hostname : "";
    return pageHost.length > 0 && !isLoopbackHost(pageHost);
}

// #4254: one row of GET /__bili/upstreams as consumed by the shell.overlay pill.
// host already carries the port ("127.0.0.1:7864"); code is the errno token
// (ECONNREFUSED/...), count the consecutive-failure tally, nextProbeInMs only
// exists while that host's circuit is OPEN (it is the "retry in ~Ns" ETA).
type UpstreamRow = { host: string; kind: string; code?: string; count: number; nextProbeInMs?: number };

/** #4254: defensively parse the /__bili/upstreams report into render rows —
 *  a malformed or partial payload yields fewer rows, never a throw, so a broken
 *  health report can never break the DSH client. */
function parseUpstreamHealth(raw: unknown): UpstreamRow[] {
    if (typeof raw !== "object" || raw === null) return [];
    const list = (raw as { upstreams?: unknown }).upstreams;
    if (!Array.isArray(list)) return [];
    const rows: UpstreamRow[] = [];
    for (const item of list) {
        if (typeof item !== "object" || item === null) continue;
        const o = item as Record<string, unknown>;
        const host = typeof o.host === "string" && o.host.length > 0 ? o.host : undefined;
        if (host === undefined) continue;
        const kind = typeof o.kind === "string" && o.kind.length > 0 ? o.kind : "unknown";
        const code = typeof o.code === "string" && o.code.length > 0 ? o.code : undefined;
        const count = typeof o.count === "number" && Number.isFinite(o.count) ? Math.max(0, Math.round(o.count)) : 0;
        const circuit = (typeof o.circuit === "object" && o.circuit !== null ? o.circuit : undefined) as { state?: unknown; nextProbeInMs?: unknown } | undefined;
        const probe = circuit !== undefined && circuit.state === "open" && typeof circuit.nextProbeInMs === "number" && Number.isFinite(circuit.nextProbeInMs)
            ? Math.max(0, circuit.nextProbeInMs)
            : undefined;
        rows.push({ host, kind, code, count, ...(probe !== undefined ? { nextProbeInMs: probe } : {}) });
    }
    return rows;
}

// #3373: gateways that mount dsh web under a path prefix re-map every URL
// the index references, so the absolute probe path misses. Probe relative to
// the page's own base as a second form; the last form that answered wins the
// next tick (direct hosts never leave the primary form).
let winningProbeForm: string | undefined;

function probeForms(): string[] {
    if (winningProbeForm !== undefined) return [winningProbeForm];
    const doc = (globalThis as { document?: { baseURI?: unknown } }).document;
    const baseURI = typeof doc?.baseURI === "string" && doc.baseURI.length > 0 ? doc.baseURI : undefined;
    if (baseURI === undefined) return [ORIGIN_PATH];
    try {
        const fallback = new URL("bili/origin", baseURI).toString();
        return fallback === ORIGIN_PATH ? [ORIGIN_PATH] : [ORIGIN_PATH, fallback];
    } catch {
        return [ORIGIN_PATH];
    }
}

/** #1809/#2187/#2288: follow the host's live origin route for the lifetime
 *  of the mount; returns the cancel used as the effect cleanup (no fetch ⇒
 *  no-op, older hosts without the route simply stay on the snapshot or
 *  degrade). The snapshot is only a first-paint hint — the host re-binds the
 *  origin at runtime, so polling never stops after a resolution.
 *  #2559: every successful tick also re-classifies the host ground and pushes
 *  a fresh theme pin — mid-session theme toggles land within one slow phase.
 *  No extra timers are scheduled here (the test pins in tests/dsh-settings-ui
 *  count every delay on this queue). */
function probeOrigin(onOrigin: (origin: string) => void, onTheme?: (theme: "light" | "dark") => void, onTick?: (origin: string) => void): () => void {
    if (typeof fetch !== "function") return () => {};
    let cancelled = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const poll = async (): Promise<void> => {
        // #3373: try the known-good form first — under a path-prefix gateway
        // that becomes the relative form after its first hit.
        let sawOk = false;
        for (const form of probeForms()) {
            try {
                const res = await fetch(form);
                if (!res.ok) continue;
                sawOk = true;
                const data = (await res.json()) as { origin?: unknown; relay?: unknown };
                let bind: string | undefined;
                if (data.relay === true) bind = relayBaseOf(res);
                else if (typeof data.origin === "string" && data.origin.length > 0) bind = data.origin;
                if (bind !== undefined && !cancelled) {
                    winningProbeForm = form;
                    onOrigin(bind);
                    settled = true;
                    // #3100: every resolution is also an embed-probe retry slot —
                    // a snapshot-only origin (older hosts without the route)
                    // never flows through onOrigin again after mount.
                    if (onTick !== undefined) onTick(bind);
                    break;
                }
            } catch {
                // host without the route (older builds) or transient error: try the next form
            }
        }
        if (sawOk && onTheme && !cancelled) {
            const theme = detectHostTheme();
            if (theme !== undefined) onTheme(theme);
        }
        if (cancelled) return;
        attempts += 1;
        // #2187/#2288: fast phase until the first resolution, then an endless
        // slow phase — the origin can land (background heal) or move
        // (runtime re-bind) at any time.
        const delay = !settled && attempts < POLL_MAX_ATTEMPTS ? POLL_INTERVAL_MS : SLOW_POLL_INTERVAL_MS;
        if (!cancelled) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
    };
}

export function apply(ctx: ClientContext): void {
    const zhDict = zh;
    const enDict = en;
    ctx.effect(
        () => ctx.locale.register(NS, { zh: zhDict, en: enDict }),
        "bili: dictionaries",
    );
    const t = ctx.locale.bind(NS);
    // #3862: per-session Context tab (conversation.view slot). Embeds the web
    // UI's OWN session page (?embed=1 + #/session/<id>) — the same framed face
    // the settings panel drives, so the compression tree and ledger readouts
    // live in ONE place instead of a second native re-rendering of them. The
    // session id comes from the status poll above; while it is unknown (no
    // request yet / chain-advisory) the tab shows an honest hint, never a
    // stale or empty frame.
    const contextPanel = (): ((props?: Record<string, unknown>) => unknown) => (props) => {
        // The host names this conversation to every conversation.view entry
        // (props.sessionId — the same id the dsh lane stamps on
        // x-bili-plugin-conversation), so the poll targets OUR session. Old
        // hosts pass nothing ⇒ the legacy literal path (unchanged).
        const hostSessionId =
            props !== undefined && typeof props.sessionId === "string" && props.sessionId.length > 0
                ? props.sessionId
                : undefined;
        const statusPath = ctxStatusPathFor(hostSessionId);
        const [origin, setOrigin] = useState<string | undefined>(readOrigin());
        // #2559: pin the frame palette to the host ground, same discipline as
        // the settings panel (sampled synchronously for first paint).
        const [theme, setTheme] = useState<("light" | "dark") | undefined>(detectHostTheme);
        // #3100: embed pre-flight verdict for the CURRENT origin — a verdict
        // recorded for a previous origin (mid-session re-bind) is stale by
        // definition until its own probe lands (shared cache with panel()).
        const [embed, setEmbed] = useState<EmbedState | undefined>(() => {
            const o = readOrigin();
            const v = o !== undefined ? embedVerdicts.get(o) : undefined;
            return o !== undefined && v !== undefined ? { origin: o, verdict: v } : undefined;
        });
        const [sessionId, setSessionId] = useState<string | null>(null);
        const [status, setStatus] = useState<CtxStatus | undefined>(undefined);
        const [fetchFailed, setFetchFailed] = useState(false);
        // #3693: last status-read failure — surfaced verbatim beneath the
        // degraded hint instead of being swallowed by it. Declared
        // unconditionally so hook order stays stable across renders.
        const [statusError, setStatusError] = useState<string | undefined>(undefined);
        const [copied, setCopied] = useState(false);
        const [reloadTick, setReloadTick] = useState(0);
        // #3100: every resolution probes the new origin's embed route in
        // flight, and every poll tick re-drives pending origins (snapshot-only
        // hosts never resolve through onOrigin again after mount).
        useEffect(() => probeOrigin((o) => { setOrigin(o); probeEmbedRoute(o, setEmbed); }, setTheme, (o) => probeEmbedRoute(o, setEmbed)), []);
        useEffect(() => {
            if (origin !== undefined) probeEmbedRoute(origin, setEmbed);
        }, [origin]);
        useEffect(() => {
            if (origin === undefined) return;
            let cancelled = false;
            const load = (): void => {
                void fetch(`${origin}${statusPath}`)
                    .then((res) => {
                        // #3693: a non-ok answer carries no contract body —
                        // surface its status code instead of parsing it blind.
                        if (res.ok !== true) throw new Error(`HTTP ${typeof res.status === "number" ? res.status : "?"}`);
                        return res.json() as Promise<unknown>;
                    })
                    .then((raw) => {
                        if (cancelled) return;
                        const parsed = parseCtxStatus(raw);
                        setStatus(parsed);
                        setFetchFailed(parsed === undefined);
                        setStatusError(undefined);
                        setSessionId(parsed !== undefined && parsed.sessionId !== null ? parsed.sessionId : null);
                    })
                    .catch((err: unknown) => {
                        if (!cancelled) {
                            setStatus(undefined);
                            setFetchFailed(true);
                            setStatusError(describeProbeError(err, `${origin}${statusPath}`));
                        }
                    });
            };
            load();
            const timer: ReturnType<typeof setInterval> = setInterval(load, CTX_POLL_MS);
            return () => {
                cancelled = true;
                clearInterval(timer);
            };
        }, [origin, reloadTick, statusPath]);
        const liveEmbed: EmbedVerdict | undefined = embed !== undefined && embed.origin === origin ? embed.verdict : undefined;
        // #3693: the live probe's last network failure (transient — retried
        // every poll tick until a verdict lands).
        const liveEmbedError: string | undefined = embed !== undefined && embed.origin === origin ? embed.error : undefined;
        // #3816: remote page + loopback origin ⇒ unreachable by construction —
        // ANY resolved verdict outranks the mismatch (a verdict means THIS
        // browser actually reached the origin).
        const remoteBlocked = remoteMismatch(origin) && liveEmbed === undefined;
        const lang = t("nav") === zhDict.nav ? "zh" : "en";
        // Ownership gate: a fallback-resolved row describes whatever ran LAST
        // globally — possibly a sibling conversation or a delegate sub-agent.
        // With a known host identity such a row is not ours ⇒ fall through to
        // the not-yet hint instead of framing someone else's session page.
        // Exact hits are trusted unconditionally; legacy responses (field
        // absent) behave exactly as before.
        const sessionOurs =
            hostSessionId === undefined ||
            status === undefined ||
            status.viaFallback !== true ||
            status.conversationId === hostSessionId;
        // #4281: framed ⇒ fill the whole conversation view (full-height
        // column, no outer padding, borderless frame on flex:1, slim top
        // action row); every hint state keeps its own breathing room.
        const framed = origin !== undefined && liveEmbed === "ok" && sessionId !== null && sessionOurs;
        const hintP = (key: string): unknown => createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t(key));
        // #3693: kick off a clipboard write of the readout line; the label
        // flips to "copied" briefly on success.
        const startCopy = (target: string): void => {
            void copyText(target).then((ok) => {
                if (!ok) return;
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            });
        };
        const errorBox = (error: string | undefined): unknown =>
            error === undefined
                ? null
                : renderProbeError(t, error, copied, () => startCopy(error));
        let middle: unknown;
        if (origin === undefined) {
            middle = hintP("degraded");
        } else if (remoteBlocked) {
            middle = renderRemoteBlock(t, origin, errorBox(liveEmbedError));
        } else if (liveEmbed === "stale") {
            // Frozen proxy predates the ?embed=1 route: framing is impossible
            // on any page, including the session one.
            middle = hintP("stale");
        } else if (framed) {
            middle = createElement(
                "iframe",
                {
                    src: `${origin}/__bili/?embed=1&lang=${lang}${theme !== undefined ? `&theme=${theme}` : ""}#/session/${encodeURIComponent(sessionId)}`,
                    title: t("title"),
                    style: {
                        display: "block",
                        flex: 1,
                        width: "100%",
                        height: "100%",
                        minHeight: 0,
                        border: "none",
                        background: "transparent",
                    },
                },
            );
        } else if (status?.ok === true && status.phase === "pre-first-request") {
            // No session row exists yet: waiting is truthful, framing impossible.
            middle = hintP("ctx_waiting");
        } else if (status === undefined) {
            middle = hintColumn(hintP(fetchFailed ? "degraded" : "connecting"), errorBox(fetchFailed ? statusError : undefined));
        } else if (!status.ok) {
            middle = hintP("ctx_nodata");
        } else {
            // Session resolved but the embed verdict has not landed yet (first
            // probe tick) — or a status build that answers without a session id:
            // honest connecting / not-yet hints instead of an empty frame.
            // chain-advisory lands here with liveEmbed "ok" ⇒ ctx_nodata, and
            // must NEVER read as a stale-build claim. #3693: if the embed
            // probe itself is failing, its raw error rides beneath the hint.
            middle = hintColumn(hintP(liveEmbed === "ok" ? "ctx_nodata" : "connecting"), errorBox(liveEmbedError));
        }
        return createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", height: "100%", minWidth: 0, minHeight: 0 } },
            origin !== undefined
                ? createElement(
                    "div",
                    { style: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "8px 12px" } },
                    createElement(
                        "button",
                        {
                            type: "button",
                            onClick: () => setReloadTick((x) => x + 1),
                            style: { cursor: "pointer", borderRadius: 8, border: "1px solid rgba(127,127,127,0.4)", background: "transparent", color: "inherit", fontFamily: "inherit", fontSize: 13, lineHeight: "20px", padding: "4px 14px" },
                        },
                        t("ctx_refresh"),
                    ),
                    openWebButton(origin, t, { fontSize: "13", lineHeight: "20px", padding: "4px 14px" }),
                )
                : null,
            createElement(
                "div",
                { style: framed ? { display: "flex", flex: 1, minHeight: 0 } : { flex: 1, minHeight: 0, padding: 16 } },
                middle,
            ),
        );
    };
    const panel = (titled: boolean): ((props: Record<string, unknown>) => unknown) => () => {
        const [origin, setOrigin] = useState<string | undefined>(readOrigin());
        const [page, setPage] = useState<PageId>("overview");
        // #2559: synchronous first paint — the very first render already pins
        // the palette to the host's current ground (no wrong-scheme flash).
        const [theme, setTheme] = useState<("light" | "dark") | undefined>(detectHostTheme);
        // #3100: embed pre-flight verdict for the CURRENT origin — a verdict
        // recorded for a previous origin (mid-session re-bind) is stale by
        // definition and reads as "pending" until its own probe lands.
        const [embed, setEmbed] = useState<EmbedState | undefined>(() => {
            const o = readOrigin();
            const v = o !== undefined ? embedVerdicts.get(o) : undefined;
            return o !== undefined && v !== undefined ? { origin: o, verdict: v } : undefined;
        });
        // #3693: copy feedback for the probe-error readout — declared
        // unconditionally so hook order stays stable across renders.
        const [copied, setCopied] = useState(false);
        // #2288: no guard on the snapshot — the live route is authoritative
        // for the whole mount, so a stale boot value is corrected in place.
        // #3100: each resolution also probes the new origin's embed route in
        // flight, and every tick re-drives pending origins (snapshot-only
        // hosts never resolve through this path again after mount).
        useEffect(
            () =>
                probeOrigin(
                    (o) => {
                        setOrigin(o);
                        probeEmbedRoute(o, setEmbed);
                    },
                    setTheme,
                    (o) => probeEmbedRoute(o, setEmbed),
                ),
            [],
        );
        // #3100: mount-time probe for a snapshot origin and re-probe on any
        // origin change (covers hosts whose live route never answers).
        useEffect(() => {
            if (origin !== undefined) probeEmbedRoute(origin, setEmbed);
        }, [origin]);
        const liveEmbed: EmbedVerdict | undefined = embed !== undefined && embed.origin === origin ? embed.verdict : undefined;
        // #3693: the live probe's last network failure (transient — retried
        // every poll tick until a verdict lands).
        const liveEmbedError: string | undefined = embed !== undefined && embed.origin === origin ? embed.error : undefined;
        // #3816: remote page + loopback origin ⇒ unreachable by construction —
        // explain the fix instead of spinning on "connecting…". ANY resolved
        // verdict outranks the mismatch: a verdict means THIS browser actually
        // reached the origin (same-machine access through a LAN IP still
        // reaches the loopback) — never shadow a working frame or the stale
        // notice of a reachable-but-frozen proxy.
        const remoteBlocked = remoteMismatch(origin) && liveEmbed === undefined;
        const lang = t("nav") === zhDict.nav ? "zh" : "en";
        // #3693: kick off a clipboard write of the readout line; the label
        // flips to "copied" briefly on success.
        const startCopy = (target: string): void => {
            void copyText(target).then((ok) => {
                if (!ok) return;
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            });
        };
        const errorBox = (error: string | undefined): unknown =>
            error === undefined
                ? null
                : renderProbeError(t, error, copied, () => startCopy(error));
        let middle: unknown;
        if (origin === undefined) {
            middle = createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("degraded"));
        } else if (remoteBlocked && origin !== undefined) {
            // The jump button targets the panel's config page (#/config) in a
            // fresh tab. For a purely remote browser that address is still
            // unreachable — the file-edit text above is the primary route;
            // the button serves same-LAN/tunneled access where it lands on
            // the exact field to set. #3693: the raw probe failure proving
            // the unreachability rides underneath, copyable for reports.
            middle = renderRemoteBlock(t, origin, errorBox(liveEmbedError));
        } else if (liveEmbed === "stale") {
            middle = createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("stale"));
        } else if (liveEmbed === "ok") {
            middle = createElement(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 10 } },
                createElement(
                    "div",
                    { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
                    PAGE_IDS.map((id) =>
                        createElement(
                            "button",
                            {
                                key: id,
                                type: "button",
                                onClick: () => setPage(id),
                                style: {
                                    cursor: "pointer",
                                    borderRadius: 8,
                                    border: id === page ? "1px solid rgba(127,127,127,0.7)" : "1px solid rgba(127,127,127,0.4)",
                                    background: id === page ? "rgba(127,127,127,0.12)" : "transparent",
                                    color: "inherit",
                                    fontFamily: "inherit",
                                    fontSize: 13,
                                    fontWeight: id === page ? 600 : 400,
                                    lineHeight: "20px",
                                    padding: "4px 14px",
                                },
                            },
                            t(PAGE_KEYS[id]),
                        ),
                    ),
                    // The open-in-browser action rides the TAB row — right
                    // after the logs tab, pushed to the row's far end —
                    // instead of sitting in the footer below the iframe.
                    openWebButton(origin, t, { marginLeft: "auto", fontSize: "13", lineHeight: "20px", padding: "4px 14px" }),
                ),
                createElement("iframe", {
                    src: `${origin}/__bili/?embed=1&lang=${lang}${theme ? `&theme=${theme}` : ""}#/${page}`,
                    title: t("title"),
                    style: {
                        display: "block",
                        width: "100%",
                        height: EMBED_HEIGHT,
                        border: "1px solid rgba(127,127,127,0.4)",
                        borderRadius: 8,
                        background: "transparent",
                    },
                }),
            );
        } else {
            // #3693: "connecting…" alone hid every failure — when the probe is
            // actually failing, its raw error rides beneath the hint.
            middle = hintColumn(
                createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("connecting")),
                errorBox(liveEmbedError),
            );
        }
        return createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 12, padding: "20px 8px" } },
            titled ? createElement("h3", { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t("title")) : null,
            middle,
            createElement(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
                createElement("p", { style: { margin: 0, opacity: 0.7, fontSize: 13, lineHeight: 1.6, flex: 1, minWidth: 200 } }, t("hint")),
                // ok 状态:按钮在上方页签行(日志页签后面);degraded/stale
                // 仍留在页脚作后备入口(#2448 同一按钮)。#3816: remoteBlocked
                // 时按钮指向的正是那个够不到的回环地址——死链,一并隐藏。
                liveEmbed === "ok" || remoteBlocked ? null : openWebButton(origin, t),
            ),
        );
    };
    // #4254 defect ②: frame-level upstream-unavailable pill (shell.overlay slot).
    // Polls the loopback-gated GET /__bili/upstreams read surface (#4257) and
    // renders one row per unreachable upstream; returns null while every upstream
    // is reachable, so the banner auto-dismisses when circuits close + alerts clear.
    // Purely additive UI — no request path changes. Display identity is the
    // forwarded host:port (bili is a transparent pipe); provider/model reverse
    // lookup stays host-side.
    const upstreamBanner = (): ((props?: Record<string, unknown>) => unknown) => () => {
        const [origin, setOrigin] = useState<string | undefined>(readOrigin());
        const [rows, setRows] = useState<UpstreamRow[]>([]);
        useEffect(() => probeOrigin((o) => setOrigin(o)), []);
        useEffect(() => {
            if (origin === undefined) return;
            let cancelled = false;
            const load = (): void => {
                void fetch(`${origin}/__bili/upstreams`)
                    .then((res) => res.json() as Promise<unknown>)
                    .then((raw) => { if (!cancelled) setRows(parseUpstreamHealth(raw)); })
                    .catch(() => { if (!cancelled) setRows([]); });
            };
            load();
            const timer: ReturnType<typeof setInterval> = setInterval(load, UPSTREAM_POLL_MS);
            return () => { cancelled = true; clearInterval(timer); };
        }, [origin]);
        if (rows.length === 0) return null;
        const header = rows.length === 1 ? t("upstreams_down_one") : t("upstreams_down_many").replace("{n}", String(rows.length));
        return createElement(
            "div",
            { role: "status", style: { display: "flex", flexDirection: "column", gap: 4, maxWidth: 520, padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(217,63,11,0.5)", background: "rgba(217,63,11,0.1)" } },
            createElement("div", { style: { fontSize: 13, fontWeight: 600 } }, header),
            ...rows.map((r) => {
                const code = r.code !== undefined ? ` ${r.code}` : "";
                const s = r.nextProbeInMs !== undefined ? Math.max(1, Math.ceil(r.nextProbeInMs / 1000)) : undefined;
                const eta = s !== undefined ? ` · ${t("upstream_retry_hint").replace("{s}", String(s))}` : "";
                return createElement("div", { key: r.host, style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, lineHeight: 1.5 } }, `${r.host} · ${r.kind}${code} ×${r.count}${eta}`);
            }),
        );
    };
    ctx.slots.inject(
        "settings.section",
        () => ctx.slots.register({ name: "settings.section", id: "bili", order: 100, label: () => t("nav"), locale: NS }, panel(true)),
    );
    ctx.slots.inject(
        "plugins.bundle.config",
        () => ctx.slots.register({ name: "plugins.bundle.config", key: "billion-context", locale: NS }, panel(false)),
    );
    // #3862: session Context tab. order 30 sits right of the built-in chat (0)
    // and trajectory (10) tabs and right of dsh-context's Context tab (20)
    // when both are installed. Deferred injection is fail-open on hosts whose
    // build lacks the slot. #4237: dsh.contextTab=false (web settings / config
    // file / BILI_DSH_CONTEXT_TAB=0) skips this slot entirely — hiding removes
    // only the top-bar entry; the ledger stays reachable through the settings
    // section, the plugin bundle config face, the Web UI and /acp. A custom
    // label (dsh.contextTabLabel) replaces the built-in name where another
    // plugin occupies it.
    const ctxGate = readCtxTabFace();
    if (!ctxGate.hidden) {
        ctx.slots.inject(
            "conversation.view",
            () => ctx.slots.register({ name: "conversation.view", id: "bili-context", order: 30, label: () => ctxGate.label ?? t("tab_ctx"), locale: NS }, contextPanel()),
        );
    }
    // #4254 defect ②: frame-level upstream-unavailable pill. Deferred injection
    // is fail-open on hosts whose build lacks the shell.overlay slot (same
    // discipline as the session Context tab above).
    ctx.slots.inject(
        "shell.overlay",
        () => ctx.slots.register({ name: "shell.overlay", id: "bili-upstreams", order: 100, label: () => t("upstreams_label"), locale: NS }, upstreamBanner()),
    );
}
