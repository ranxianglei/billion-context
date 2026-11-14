// #3912: after a failed attempt's recovery omission, pi's native footer
// shows ITS OWN raw-history projection estimate (chars/4 over the FULL
// unfolded local history — 500%+ of the window) while the effective request
// bili sends is a fraction of that. The pi lane answers with a persistent,
// labeled effective-context line in pi's keyed status slot. These tests pin:
//   ① renderer semantics — grade labels (usage/est), staleness tiers, the
//      host-divergence reconciliation note, and honesty on missing data
//      (no number is ever rendered without a grade; nothing is clamped);
//   ② wiring lifecycle — which events refresh vs clear, the refresh
//      throttle (both directions), force-refresh on session_start, and the
//      no-cross-session-bleed guarantee (an unknown session CLEARS the line
//      instead of keeping the previous session's numbers).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BILI_CONTEXT_STATUS_KEY, createBiliPlugin, renderBiliContextLine } from "../src/agent/pi.ts";

const NOW = 1_760_000_000_000;

function statusOf(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { ok: true, contextTokens: 104_733, contextLimit: 500_000, contextTokensSource: "usage", contextTokensAt: NOW - 1000, ...over };
}

test("usage-grade line with limit", () => {
    assert.equal(renderBiliContextLine(statusOf(), null, NOW), "bili 20.9% 104.7K/500.0K · usage");
});

test("estimate-grade line is labeled est", () => {
    assert.equal(renderBiliContextLine(statusOf({ contextTokensSource: "estimate" }), null, NOW), "bili 20.9% 104.7K/500.0K · est");
});

test("no limit renders the absolute count only", () => {
    assert.equal(renderBiliContextLine(statusOf({ contextTokens: 45_000, contextLimit: null }), null, NOW), "bili 45.0K · usage");
});

test("missing status renders nothing", () => {
    assert.equal(renderBiliContextLine(undefined, 562.8, NOW), undefined);
});

test("zero/negative/non-finite token counts render nothing", () => {
    assert.equal(renderBiliContextLine(statusOf({ contextTokens: 0 }), null, NOW), undefined);
    assert.equal(renderBiliContextLine(statusOf({ contextTokens: -5 }), null, NOW), undefined);
    assert.equal(renderBiliContextLine(statusOf({ contextTokens: Number.NaN }), null, NOW), undefined);
});

test("unavailable or missing source renders nothing (never unlabeled)", () => {
    assert.equal(renderBiliContextLine(statusOf({ contextTokensSource: "unavailable" }), null, NOW), undefined);
    const noSource = statusOf();
    delete noSource.contextTokensSource;
    assert.equal(renderBiliContextLine(noSource, null, NOW), undefined);
});

test("fresh observation (<5min) carries no staleness marker", () => {
    assert.equal(renderBiliContextLine(statusOf({ contextTokensAt: NOW - 4 * 60_000 }), null, NOW), "bili 20.9% 104.7K/500.0K · usage");
});

test("5-60min age gets a minute-age marker", () => {
    assert.equal(renderBiliContextLine(statusOf({ contextTokensAt: NOW - 10 * 60_000 }), null, NOW), "bili 20.9% 104.7K/500.0K · usage · 10m");
});

test(">60min age is marked stale", () => {
    assert.equal(renderBiliContextLine(statusOf({ contextTokensAt: NOW - 90 * 60_000 }), null, NOW), "bili 20.9% 104.7K/500.0K · usage · stale");
});

test("host divergence >= 25 points gets a reconciliation note", () => {
    assert.equal(
        renderBiliContextLine(statusOf(), 562.8, NOW),
        "bili 20.9% 104.7K/500.0K · usage · host est 562.8%",
    );
});

test("host divergence exactly at the threshold is noted", () => {
    assert.ok(renderBiliContextLine(statusOf({ contextTokens: 100_000 }), 45.0, NOW)?.endsWith("· host est 45.0%"));
});

test("small host divergence is not noted", () => {
    assert.equal(renderBiliContextLine(statusOf(), 25.0, NOW), "bili 20.9% 104.7K/500.0K · usage");
});

test("host percent null/undefined yields no note", () => {
    assert.equal(renderBiliContextLine(statusOf(), null, NOW), "bili 20.9% 104.7K/500.0K · usage");
    assert.equal(renderBiliContextLine(statusOf(), undefined, NOW), "bili 20.9% 104.7K/500.0K · usage");
});

test("without a limit there is nothing to compare against the host", () => {
    assert.equal(renderBiliContextLine(statusOf({ contextTokens: 45_000, contextLimit: null }), 562.8, NOW), "bili 45.0K · usage");
});

test("staleness and divergence combine", () => {
    assert.equal(
        renderBiliContextLine(statusOf({ contextTokensAt: NOW - 90 * 60_000 }), 562.8, NOW),
        "bili 20.9% 104.7K/500.0K · usage · stale · host est 562.8%",
    );
});

function makeFakePi() {
    const events = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    return {
        events,
        registerTool: () => {},
        registerCommand: () => {},
        registerProvider: () => {},
        getSessionName: () => "test",
        on: (event: string, handler: (event: never, ctx: never) => unknown) => {
            const list = events.get(event) ?? [];
            list.push(handler as (event: unknown, ctx: unknown) => unknown);
            events.set(event, list);
        },
        fire: (name: string, event: unknown, ctx: unknown): unknown => {
            const list = events.get(name) ?? [];
            let last: unknown;
            for (const h of list) last = h(event, ctx);
            return last;
        },
        fireAsync: async (name: string, event: unknown, ctx: unknown): Promise<unknown> => {
            const list = events.get(name) ?? [];
            let last: unknown;
            for (const h of list) last = await h(event, ctx);
            return last;
        },
    };
}

type FakePi = ReturnType<typeof makeFakePi>;

test("wiring: keyed-slot refresh/clear lifecycle against a live status endpoint", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bili-issue3912-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.NODE_ENV = "test";
    const prevProxy = process.env.BILLION_CONTEXT_PROXY;
    const prevKill = process.env.BILLION_CONTEXT_PLUGIN;
    delete process.env.BILLION_CONTEXT_PLUGIN;

    let statusHits = 0;
    const mock = http.createServer((req, res) => {
        if (req.url?.startsWith("/__bili/plugin/status")) {
            statusHits++;
            const sid = new URL(`http://x${req.url}`).searchParams.get("conversationId") ?? "";
            if (sid !== "sid-x") {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "unknown plugin conversation" }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, conversationId: "sid-x", contextTokens: 104_733, contextLimit: 500_000, contextTokensSource: "usage", contextTokensAt: Date.now() }));
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
    });
    mock.listen(0, "127.0.0.1");
    await once(mock, "listening");
    const port = (mock.address() as { port: number }).port;
    process.env.BILLION_CONTEXT_PROXY = `http://127.0.0.1:${port}`;

    try {
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        for (const name of ["turn_end", "agent_settled", "after_provider_response", "session_start", "session_shutdown", "session_tree"]) {
            assert.ok((pi.events.get(name) ?? []).length > 0, `handler registered for ${name}`);
        }
        const lines: Array<string | undefined> = [];
        const ctx = {
            sessionManager: { getSessionId: () => "sid-x" },
            model: { id: "claude-test", contextWindow: 500_000, api: "anthropic", baseUrl: "https://api.example.com/v1" },
            ui: { notify: () => {}, setStatus: (key: string, text: string | undefined) => { assert.equal(key, BILI_CONTEXT_STATUS_KEY); lines.push(text); } },
            getContextUsage: () => ({ tokens: 2_813_956, contextWindow: 500_000, percent: 562.8 }),
            cwd: dir,
        };
        const EXPECTED_LINE = "bili 20.9% 104.7K/500.0K · usage · host est 562.8%";
        const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
            const deadline = Date.now() + 3000;
            while (!pred()) {
                if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
                await new Promise((r) => setTimeout(r, 25));
            }
        };
        // A settled turn refreshes the slot, with the host-divergence note
        // (the #3912 repro shape: native footer 562.8%, effective 20.9%). The
        // refresh is fire-and-forget on purpose (it must never block the host
        // event loop), so the test polls for the slot write.
        await pi.fireAsync("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
        await waitFor(() => lines.length === 1, "first slot write");
        assert.deepEqual(lines, [EXPECTED_LINE]);
        // Back-to-back events are throttled (one status read per window).
        await pi.fireAsync("after_provider_response", { type: "after_provider_response", status: 200 }, ctx);
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(statusHits, 1);
        assert.equal(lines.length, 1);
        // session_start force-refreshes even inside the throttle window
        // (resume/reload must repopulate immediately).
        await pi.fireAsync("session_start", { type: "session_start", reason: "resume" }, ctx);
        await waitFor(() => lines.length === 2 && statusHits === 2, "forced re-read");
        assert.equal(lines.at(-1), EXPECTED_LINE);
        // Unknown session (switched away): the line CLEARS instead of
        // keeping the previous session's numbers.
        ctx.sessionManager = { getSessionId: () => "sid-elsewhere" };
        await pi.fireAsync("session_start", { type: "session_start", reason: "new" }, ctx);
        await waitFor(() => lines.length === 3, "clear write for unknown session");
        assert.equal(lines.at(-1), undefined);
        // Local rewind invalidates the observed payload until the next request.
        ctx.sessionManager = { getSessionId: () => "sid-x" };
        pi.fire("session_tree", { type: "session_tree" }, ctx);
        assert.equal(lines.at(-1), undefined);
        pi.fire("session_shutdown", { type: "session_shutdown" }, ctx);
        assert.equal(lines.at(-1), undefined);
    } finally {
        await new Promise<void>((resolve) => mock.close(() => resolve()));
        if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prevProxy;
        if (prevKill === undefined) delete process.env.BILLION_CONTEXT_PLUGIN;
        else process.env.BILLION_CONTEXT_PLUGIN = prevKill;
    }
});

test("wiring: hosts without the status slot or proxy degrade silently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-issue3912-noui-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.NODE_ENV = "test";
    const prevProxy = process.env.BILLION_CONTEXT_PROXY;
    const prevKill = process.env.BILLION_CONTEXT_PLUGIN;
    delete process.env.BILLION_CONTEXT_PROXY;
    delete process.env.BILLION_CONTEXT_PLUGIN;
    try {
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        const ctx = {
            sessionManager: { getSessionId: () => "sid-x" },
            model: { id: "m", contextWindow: 500_000, api: "openai", baseUrl: "https://api.example.com/v1" },
            ui: { notify: () => {} },
            cwd: dir,
        };
        // No ui.setStatus (older host) AND no resolvable proxy base: every
        // trigger must be a silent no-op, never a throw into the host loop.
        await pi.fireAsync("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
        await pi.fireAsync("after_provider_response", { type: "after_provider_response", status: 500 }, ctx);
        pi.fire("session_tree", { type: "session_tree" }, ctx);
        pi.fire("session_shutdown", { type: "session_shutdown" }, ctx);
    } finally {
        if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prevProxy;
        if (prevKill === undefined) delete process.env.BILLION_CONTEXT_PLUGIN;
        else process.env.BILLION_CONTEXT_PLUGIN = prevKill;
    }
});
