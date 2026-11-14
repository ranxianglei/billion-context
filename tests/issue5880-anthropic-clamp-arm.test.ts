import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// #5880: two independent defects let a session bili believes fits sail past the
// upstream wall on the ANTHROPIC wire (wrapper providers like DeepSeek bill the
// completion against the SAME window — their 400 says so):
//   A. the post-preflight-fold anchor write (server.ts) overwrote an ACTIVE
//      overflow-arm evidence tag with an estimate-grade one whenever the fresh
//      rebuilt-view estimate measured slightly above the netted arm value —
//      every successful fold silently disarmed the evidence floor, so the next
//      turn fit-forwarded on a stale optimistic estimate until the 400 re-armed
//      it: a livelock (fold → forward → 400 → re-arm → repeat).
//   B. the outgoing max_tokens clamp had NO call site on the anthropic lane
//      (budget.ts wired openai/responses/google only) — even with an honest
//      estimate, requested input+output could exceed the native window.
// These tests pin both: the arm tag survives the anchor write (and unarmed
// sessions keep the #1987 behavior), and the anthropic lane clamps max_tokens
// against the RAW native window exactly like the other lanes do (#2096
// semantics — the headroom-adjusted window feeds nudge/preflight, the raw one
// guards the egress budget).

import { createInitialState } from "acp-kernel";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { applyPostRebuildBaselineAnchor } from "../src/session.ts";
import type { Session } from "../src/session.ts";

// ---------- Part 1: unit — the post-rebuild anchor must not demote an arm ----------

function makeSession(lastInputTokens: number, source: Session["stats"]["lastInputTokensSource"]): Session {
    const now = Date.now();
    return {
        id: "s5880-unit",
        meta: {},
        metadata: {},
        state: createInitialState(),
        stats: {
            requests: 1,
            tokensSaved: 0,
            inputTokens: 0,
            cachedTokens: 0,
            outputTokens: 0,
            cacheSamples: 0,
            lastInputTokens,
            lastInputTokensSource: source,
            compressCreditTokens: 0,
            contextTokens: lastInputTokens,
            retrieveCalls: 0,
            retrieveHits: 0,
            retrieveMisses: 0,
            storedBytes: 0,
            storeBytesSaved: 0,
            rangeRestores: 0,
        },
        pendingRetrievals: [],
        createdAt: now,
        lastSeen: now,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    } as unknown as Session;
}

test("#5880 unit: an active overflow-arm tag survives the post-rebuild anchor write", () => {
    // Incident shape: the arm holds the netted measured value; the fresh
    // rebuilt-view estimate measures slightly HIGHER (caliber delta) — the old
    // inequality-based write demoted the tag to "estimate" here.
    const s = makeSession(783_000, "overflow-arm");
    applyPostRebuildBaselineAnchor(s, 783_353);
    assert.equal(s.stats.lastInputTokensSource, "overflow-arm", "armed tag must not be demoted");
    assert.equal(s.stats.lastInputTokens, 783_000, "arm value must not be overwritten by the estimate");
});

test("#5880 unit: unarmed sessions keep the #1987 anchor behavior (both directions)", () => {
    const up = makeSession(100_000, "estimate");
    applyPostRebuildBaselineAnchor(up, 120_000);
    assert.equal(up.stats.lastInputTokens, 120_000, "larger rebuilt view must still anchor (#1987)");
    assert.equal(up.stats.lastInputTokensSource, "estimate");

    const down = makeSession(100_000, "estimate");
    applyPostRebuildBaselineAnchor(down, 80_000);
    assert.equal(down.stats.lastInputTokens, 100_000, "smaller rebuilt view must not lower the floor");
});

test("#5880 unit: usage-grade baselines keep the pre-existing #604 overwrite behavior", () => {
    // Only the overflow-arm tag is protected; a newer larger local measurement
    // still retires an older usage sample (the relay path does the same).
    const u = makeSession(100_000, "usage");
    applyPostRebuildBaselineAnchor(u, 120_000);
    assert.equal(u.stats.lastInputTokens, 120_000);
    assert.equal(u.stats.lastInputTokensSource, "estimate", "usage→estimate overwrite stays #604 behavior");
});

// ---------- Part 2: e2e — the anthropic lane clamps max_tokens near the wall ----------

const WINDOW = 200_000;
const MODEL = "ds-flash";

// #5278/#2096 derivation kept here so the cap math stays testable end-to-end.
const expectedCap = (input: number, window: number): number => {
    const safeEst = Math.ceil(input * 1.12);
    const margin = Math.max(2048, Math.ceil(safeEst * 0.05));
    return Math.floor(window - safeEst - margin);
};

function filler(chars: number): string {
    const unit = "the quick brown fox jumps over the lazy dog. ";
    let s = "";
    while (s.length < chars) s += unit;
    return s.slice(0, chars);
}

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const anthropicSseReply = (): string =>
    anthropicSse("message_start", { type: "message_start", message: { id: "m1", role: "assistant" } }) +
    anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
    anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
    anthropicSse("message_stop", { type: "message_stop" });

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    bodies: Array<{ url: string; json: Record<string, unknown> }>;
    closeAll(): Promise<void>;
}

async function startHarness(): Promise<Rig> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const bodies: Rig["bodies"] = [];
    const upstream = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
            try { bodies.push({ url: req.url ?? "", json: JSON.parse(raw) }); } catch { /* ignore */ }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(anthropicSseReply());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return {
        proxyPort: (proxy.address() as { port: number }).port,
        upstreamPort,
        bodies,
        closeAll: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            upstream.close();
            upstream.closeIdleConnections?.();
            await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
        },
    };
}

async function driveAnthropic(rig: Rig, session: string, body: Record<string, unknown>): Promise<void> {
    const r = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify(body),
    });
    assert.equal(r.status, 200, `request must succeed, got ${r.status}: ${await r.text().catch(() => "")}`);
    await r.body?.cancel().catch(() => { /* drained */ });
}

test("#5880 e2e: near-wall anthropic request gets max_tokens clamped against the RAW window", async () => {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    const rig = await startHarness();
    try {
        // ~560k ASCII chars ≈ 140k estimated tokens (non-CJK counts len/4) with
        // max_tokens 60_000 (>25% of the window → headroom reservation shrinks
        // the EFFECTIVE window to 150_000). The cap must be computed against
        // the RAW 200_000, where it lands ~35k — below the request, so it fires;
        // against the effective 150_000 it would go negative and surrender.
        await driveAnthropic(rig, "s5880-clamp", {
            model: MODEL,
            max_tokens: 60_000,
            stream: true,
            system: "You are a helpful assistant.",
            messages: [{ role: "user", content: filler(560_000) }],
        });
        const sent = rig.bodies.at(-1)?.json;
        assert.ok(sent, "upstream must have received the request");
        const sentMax: unknown = sent.max_tokens;
        assert.ok(typeof sentMax === "number", `max_tokens must remain a number, got ${typeof sentMax}`);
        assert.ok(sentMax < 60_000, `near-wall request must be clamped below 60000, got ${sentMax}`);
        assert.ok(sentMax >= 1024, `clamp must stay above the surrender floor, got ${sentMax}`);

        const line = logs.find((l) => l.includes(`[s5880-clamp]`) && l.includes("output budget clamped"));
        assert.ok(line, `a clamp log line must exist, got: ${JSON.stringify(logs.filter((l) => l.includes("clamped")))}`);
        const m = /output budget clamped 60000 -> (\d+) \(input~(\d+), window=(\d+)\)/.exec(line!);
        assert.ok(m, `clamp line must carry the cap math, got: ${line}`);
        assert.equal(Number(m![3]), WINDOW, "cap must be computed against the RAW native window (#2096)");
        assert.equal(sentMax, expectedCap(Number(m![2]), WINDOW), "cap math must match the logged estimate");
    } finally {
        setLogCapture(null);
        await rig.closeAll();
    }
});

test("#5880 e2e: comfortably-fitting anthropic request keeps its max_tokens", async () => {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    const rig = await startHarness();
    try {
        await driveAnthropic(rig, "s5880-fit", {
            model: MODEL,
            max_tokens: 60_000,
            stream: true,
            system: "You are a helpful assistant.",
            messages: [{ role: "user", content: "hello" }],
        });
        const sent = rig.bodies.at(-1)?.json;
        assert.ok(sent, "upstream must have received the request");
        assert.equal(sent?.max_tokens, 60_000, "fitting request must pass through unclamped");
        assert.ok(!logs.some((l) => l.includes("[s5880-fit]") && l.includes("output budget clamped")), "no clamp may fire for a fitting request");
    } finally {
        setLogCapture(null);
        await rig.closeAll();
    }
});
