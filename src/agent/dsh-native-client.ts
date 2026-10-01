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
// serves the live origin at GET /bili/origin on the dsh webserver; this
// section polls that route while unresolved so the entry upgrades without a
// reload or app restart. Neither source known ⇒ degrade to a hint instead of
// a dead link.

import { createElement, useEffect, useState } from "react";

type Dict = Record<string, string>;

type SlotOptions = { name: string; id: string; order: number; label: () => string; locale: string };

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

// #1809: live-origin probe cadence — first attempt immediate, then a retry
// every POLL_INTERVAL_MS up to POLL_MAX_ATTEMPTS total (~30s of coverage for
// a slow spawn-mode bootstrap, bounded so an absent host costs no more).
const ORIGIN_PATH = "/bili/origin";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 10;

const zh: Dict = {
    "nav": "bili设置",
    "title": "billion-context 压缩代理",
    "open": "打开 Web UI",
    "hint": "查看压缩状态、会话与上下文窗口。",
    "degraded": "当前 dsh 进程未绑定 bili 代理（未经 bili dsh 启动，或代理尚未就绪）——先运行 /acp，或改用 bili dsh 启动。",
};

const en: Dict = {
    "nav": "bili",
    "title": "billion-context compression proxy",
    "open": "Open Web UI",
    "hint": "Inspect compression status, sessions and context windows.",
    "degraded": "This dsh process is not bound to a bili proxy (not launched via bili dsh, or the proxy is not up yet) — run /acp first, or launch through bili dsh.",
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

/** #1809: poll the host's live origin route until one arrives; returns the
 *  cancel used as the effect cleanup (no fetch ⇒ no-op, older hosts without
 *  the route simply stay degraded after the attempts are exhausted). */
function probeOrigin(onOrigin: (origin: string) => void): () => void {
    if (typeof fetch !== "function") return () => {};
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const poll = async (): Promise<void> => {
        let resolved = false;
        try {
            const res = await fetch(ORIGIN_PATH);
            if (res.ok) {
                const data = (await res.json()) as { origin?: unknown };
                if (typeof data.origin === "string" && data.origin.length > 0 && !cancelled) {
                    onOrigin(data.origin);
                    resolved = true;
                }
            }
        } catch {
            // host without the route (older builds) or transient error: retry below
        }
        if (resolved) return;
        attempts += 1;
        if (!cancelled && attempts < POLL_MAX_ATTEMPTS) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
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
    const section = (): unknown => {
        const [origin, setOrigin] = useState<string | undefined>(readOrigin());
        useEffect(() => {
            if (origin !== undefined) return;
            return probeOrigin(setOrigin);
        }, [origin]);
        return createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 12, padding: "20px 8px" } },
            createElement("h3", { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t("title")),
            origin === undefined
                ? createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("degraded"))
                : createElement(
                    "button",
                    {
                        type: "button",
                        onClick: () => openExternal(`${origin}/__bili/`),
                        style: {
                            alignSelf: "flex-start",
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
                    `${t("open")}（${origin}）`,
                ),
            createElement("p", { style: { margin: 0, opacity: 0.7, fontSize: 13, lineHeight: 1.6 } }, t("hint")),
        );
    };
    ctx.slots.inject(
        "settings.section",
        () => ctx.slots.register({ name: "settings.section", id: "bili", order: 100, label: () => t("nav"), locale: NS }, section),
    );
}
