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
// open-in-browser button survives as the escape hatch. lang mirrors the host
// locale: bind() resolves against the live dsh locale, and comparing the
// resolved nav label with the registered zh value is the only locale signal
// the client contract exposes. The same panel is mounted at two slots (#2125): settings.section
// (always present — the launcher posture has no bundle page) and
// plugins.bundle.config (keyed by package name; the plugin detail page renders
// it only when this package is installed as a profile bundle and draws the
// title itself, so that registration drops the h3).

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
const PAGE_IDS = ["overview", "sessions", "config", "logs"] as const;
type PageId = (typeof PAGE_IDS)[number];
const PAGE_KEYS: Record<PageId, string> = {
    overview: "tab_overview",
    sessions: "tab_sessions",
    config: "tab_config",
    logs: "tab_logs",
};
const EMBED_HEIGHT_CSS = "min(640px, 78vh)";

const zh: Dict = {
    "nav": "bili设置",
    "title": "billion-context 压缩代理",
    "open": "打开 Web UI",
    "hint": "查看压缩状态、会话与上下文窗口。",
    "degraded": "当前 dsh 进程未绑定 bili 代理（未经 bili dsh 启动，或代理尚未就绪）——先运行 /acp，或改用 bili dsh 启动。",
    "tab_overview": "总览",
    "tab_sessions": "会话",
    "tab_config": "配置",
    "tab_logs": "日志",
};

const en: Dict = {
    "nav": "bili",
    "title": "billion-context compression proxy",
    "open": "Open Web UI",
    "hint": "Inspect compression status, sessions and context windows.",
    "degraded": "This dsh process is not bound to a bili proxy (not launched via bili dsh, or the proxy is not up yet) — run /acp first, or launch through bili dsh.",
    "tab_overview": "Overview",
    "tab_sessions": "Sessions",
    "tab_config": "Config",
    "tab_logs": "Logs",
};

function readOrigin(): string | undefined {
    const g = globalThis as { __BILI__?: { origin?: unknown } };
    const origin = g.__BILI__?.origin;
    return typeof origin === "string" && origin.length > 0 ? origin : undefined;
}

function openExternal(url: string): void {
    const w = globalThis as { open?: (url: string, target?: string, features?: string) => unknown };
    if (typeof w.open === "function") w.open(url, "_blank", "noopener,noreferrer");
}

/** #1809/#2187/#2288: follow the host's live origin route for the lifetime
 *  of the mount; returns the cancel used as the effect cleanup (no fetch ⇒
 *  no-op, older hosts without the route simply stay on the snapshot or
 *  degrade). The snapshot is only a first-paint hint — the host re-binds the
 *  origin at runtime, so polling never stops after a resolution. */
function probeOrigin(onOrigin: (origin: string) => void): () => void {
    if (typeof fetch !== "function") return () => {};
    let cancelled = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const poll = async (): Promise<void> => {
        try {
            const res = await fetch(ORIGIN_PATH);
            if (res.ok) {
                const data = (await res.json()) as { origin?: unknown };
                if (typeof data.origin === "string" && data.origin.length > 0 && !cancelled) {
                    onOrigin(data.origin);
                    settled = true;
                }
            }
        } catch {
            // host without the route (older builds) or transient error: retry below
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
    const panel = (titled: boolean): ((props: Record<string, unknown>) => unknown) => () => {
        const [origin, setOrigin] = useState<string | undefined>(readOrigin());
        const [page, setPage] = useState<PageId>("overview");
        // #2288: no guard on the snapshot — the live route is authoritative
        // for the whole mount, so a stale boot value is corrected in place.
        useEffect(() => probeOrigin(setOrigin), []);
        const lang = t("nav") === zhDict.nav ? "zh" : "en";
        return createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 12, padding: "20px 8px" } },
            titled ? createElement("h3", { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t("title")) : null,
            origin === undefined
                ? createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("degraded"))
                : createElement(
                    "div",
                    { style: { display: "flex", flexDirection: "column", gap: 10 } },
                    createElement(
                        "div",
                        { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
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
                    ),
                    createElement("iframe", {
                        src: `${origin}/__bili/?embed=1&lang=${lang}#/${page}`,
                        title: t("title"),
                        style: {
                            display: "block",
                            width: "100%",
                            height: EMBED_HEIGHT_CSS,
                            border: "1px solid rgba(127,127,127,0.4)",
                            borderRadius: 8,
                            background: "transparent",
                        },
                    }),
                ),
            createElement(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
                createElement("p", { style: { margin: 0, opacity: 0.7, fontSize: 13, lineHeight: 1.6, flex: "1 1 240px" } }, t("hint")),
                origin === undefined
                    ? null
                    : createElement(
                        "button",
                        {
                            type: "button",
                            title: `${origin}/__bili/`,
                            onClick: () => openExternal(`${origin}/__bili/`),
                            style: {
                                cursor: "pointer",
                                borderRadius: 8,
                                border: "1px solid rgba(127,127,127,0.4)",
                                background: "transparent",
                                color: "inherit",
                                fontFamily: "inherit",
                                fontSize: 14,
                                lineHeight: "22px",
                                padding: "7px 16px",
                            },
                        },
                        t("open"),
                    ),
            ),
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
}
