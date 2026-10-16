import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { adaptiveDeadlineMs, FC_ADAPTIVE_MIN_SAMPLES, FC_ADAPTIVE_WINDOW, fcP95, loadRoutes, parseDeadlineMs, resolveFirstContentDeadlines, type ProviderRoutes } from "../src/config.ts";
import { readFcSamples, recordFcSample } from "../src/loop/index.ts";

// #3254: in-request summarization had no bili-side wait bound of its own. The
// upstream idle timer is byte-level — SSE keep-alive comments/pings keep it
// armed forever — so a relay that streams pings for 13 minutes per attempt
// left the CLIENT's content watchdog (780s, codex-webui) as the de-facto
// circuit breaker. Incident: one fold = 775s + 773s + 27s across three client
// attempts, bili.log fully silent. Pinned here: (A) an initial-phase deadline
// fires, cancels the stalled body, ends the turn with ONE clean in-band error
// and NO internal refetch (owner decision C-rejected: the client's retry
// ladder re-arms with backoff); (B) the inter-content (gap) phase fires after
// first content; (C) live content re-arms the deadline and never false-fires;
// (D) absent config stays byte-identical legacy (no timers, no early exit);
// (E-H) the three-level cascade (model > route > global network.*) incl.
// explicit-0-wins-at-level, gap-inherits-initial, and strict validation;
// (I-L) route-adaptive refinement (owner point 5): clamp(3×p95(healthy
// first-content durations), 120s, 600s) capped by the explicit config value,
// samples stored per route in session metadata, healthy attempts only.

const ANTHROPIC_BODY = { model: "claude", messages: [], stream: true, max_tokens: 10 };
const enc = new TextEncoder();

function makeCtx(id: string, logs: string[]): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
} {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [],
        session: {
            id,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: (m: string) => { logs.push(m); },
    };
}

const ev = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

const MESSAGE_START = ev("message_start", {
    type: "message_start",
    message: {
        id: "msg_1", type: "message", role: "assistant", model: "claude",
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
    },
});
const PING = ev("ping", { type: "ping" });
const textStart = (index: number) => ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
const textDelta = (index: number, text: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
const blockStop = (index: number) => ev("content_block_stop", { type: "content_block_stop", index });
const MESSAGE_DELTA = (stopReason = "end_turn") => ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 3 } });
const MESSAGE_STOP = ev("message_stop", { type: "message_stop" });

// Emits `text` synchronously then closes — everything is consumed before any
// macrotask timer can fire (deterministic, no timing margin needed).
function completeStream(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(enc.encode(text));
            controller.close();
        },
    });
}

// Emits `text` then HOLDS OPEN (the incident shape: pings/comments keep the
// byte idle-timer armed; no model content ever comes). Records cancellation.
function holdStream(text: string, sink: { cancelled: boolean }): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(enc.encode(text));
        },
        cancel() { sink.cancelled = true; },
    });
}

async function drainGen(gen: AsyncGenerator<Buffer>, chunks: Buffer[], timeoutMs: number): Promise<void> {
    const drain = (async () => { for await (const c of gen) chunks.push(c); })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`drain timed out after ${timeoutMs}ms (generator hung)`)), timeoutMs);
    });
    try {
        await Promise.race([drain, guard]);
    } catch (e) {
        // fire-and-forget on purpose: if the generator is parked on a read that
        // can never settle (a deliberately held-open stream), .return() queues
        // BEHIND the stuck .next() and never settles itself — awaiting it
        // deadlocks the test (verified empirically). The abandoned generator is
        // GC-eligible; it owns no handles.
        void gen.return(undefined).catch(() => {});
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

async function drainAnthropic(
    stream: ReadableStream<Uint8Array>,
    deadline: { initialMs?: number; gapMs?: number } | undefined,
    id: string,
    timeoutMs: number,
    fcRouteKey?: string,
): Promise<{ out: string; fetchCalls: number; logs: string[]; session: Session }> {
    let n = 0;
    const orig = globalThis.fetch;
    // Any fetch here means the loop REFETCHED — the #3254 decision pins that a
    // deadline kill never triggers an internal refetch (C-rejected).
    globalThis.fetch = (async () => { n += 1; throw new Error("fetch called — internal refetch forbidden (#3254 C-rejected)"); }) as typeof fetch;
    const logs: string[] = [];
    const ctx = makeCtx(id, logs);
    (ctx as Record<string, unknown>).protocol = "anthropic";
    if (deadline !== undefined) (ctx as Record<string, unknown>).firstContentDeadline = deadline;
    if (fcRouteKey !== undefined) (ctx as Record<string, unknown>).fcRouteKey = fcRouteKey;
    const chunks: Buffer[] = [];
    try {
        const gen = runCompressLoop(
            stream,
            ctx,
            ANTHROPIC_BODY,
            { url: "http://mock", headers: {} },
            createAnthropicAdapter(ANTHROPIC_BODY, undefined, undefined, "protocol"),
            buildCompressSystemPrompt(),
        );
        await drainGen(gen, chunks, timeoutMs);
    } finally {
        globalThis.fetch = orig;
    }
    return { out: Buffer.concat(chunks).toString("utf8"), fetchCalls: n, logs, session: ctx.session };
}

const sseBlocks = (s: string): string[] => s.split("\n\n").map((b) => b.trim()).filter(Boolean);

// --- A: initial-phase deadline fires on a stalled stream -------------------

test("#3254 A: initial-phase deadline cancels the stalled body and ends in-band once, no refetch", async () => {
    const sink = { cancelled: false };
    const { out, fetchCalls, logs } = await drainAnthropic(holdStream(MESSAGE_START + PING, sink), { initialMs: 150, gapMs: 150 }, "s3254a", 3000);
    assert.match(out, /model content deadline exceeded/);
    assert.match(out, /no model content within 1s of the response starting \(limit 150ms\)/);
    assert.match(out, /your context is intact, resend your last message to continue/);
    assert.ok(sseBlocks(out).at(-1)?.startsWith("event: error"), "last SSE block must be the protocol-native error channel");
    assert.ok(logs.some((l) => l.includes("content-deadline fired") && l.includes("phase=initial") && l.includes("source=config") && l.includes("upstream attempt 1") && l.includes("round 1")), `fire log missing/malformed: ${JSON.stringify(logs)}`);
    assert.equal(fetchCalls, 0, "deadline kill must NOT trigger an internal refetch");
    assert.equal(sink.cancelled, true, "the stalled upstream body must be cancelled");
});

// --- B: gap phase fires after first content; pings do not re-arm -----------

test("#3254 B: inter-content (gap) deadline fires after first content; ping does not re-arm it", async () => {
    const sink = { cancelled: false };
    const prefix = MESSAGE_START + textStart(0) + textDelta(0, "hi") + blockStop(0) + PING;
    const { out, fetchCalls, logs } = await drainAnthropic(holdStream(prefix, sink), { gapMs: 150 }, "s3254b", 3000);
    assert.match(out, /model content deadline exceeded/);
    assert.match(out, /no model content for 1s between content events \(limit 150ms\)/);
    assert.ok(logs.some((l) => l.includes("content-deadline fired") && l.includes("phase=gap")), `gap fire log missing: ${JSON.stringify(logs)}`);
    assert.equal(fetchCalls, 0);
    assert.equal(sink.cancelled, true);
});

// --- C: live content re-arms the deadline — no false positive --------------

test("#3254 C: continuous content re-arms the deadline; a healthy slow stream completes cleanly", async () => {
    const text = MESSAGE_START + textStart(0) + textDelta(0, "a") + textDelta(0, "b") + blockStop(0) + MESSAGE_DELTA() + MESSAGE_STOP;
    const { out, fetchCalls, logs } = await drainAnthropic(completeStream(text), { initialMs: 100, gapMs: 100 }, "s3254c", 3000);
    assert.doesNotMatch(out, /model content deadline exceeded/);
    assert.doesNotMatch(out, /event: error/);
    assert.match(out, /"text_delta"/);
    assert.ok(!logs.some((l) => l.includes("content-deadline")), `healthy stream must not trip the deadline: ${JSON.stringify(logs)}`);
    assert.equal(fetchCalls, 0);
});

// --- D: absent config = legacy behavior (no timer, stream stays pending) ---

test("#3254 D: without firstContentDeadline the legacy path is untouched (stall stays pending)", async () => {
    // node:test treats "event loop drained while tests still pending" as fatal;
    // this test deliberately leaves a stream read dangling, so pin a keep-alive
    // handle for its duration or the later tests in this file get cancelled.
    const keepAlive = setInterval(() => {}, 50);
    const sink = { cancelled: false };
    let hung = false;
    try {
        try {
            await drainAnthropic(holdStream(MESSAGE_START + PING, sink), undefined, "s3254d", 400);
        } catch (e) {
            hung = e instanceof Error && /drain timed out/.test(e.message);
        }
        assert.ok(hung, "legacy path must keep waiting on the stalled stream (no early exit)");
        assert.equal(sink.cancelled, false, "nothing may cancel the body when the feature is off");
    } finally {
        clearInterval(keepAlive);
    }
});

// --- E: parseDeadlineMs strictness -----------------------------------------

test("#3254 E: parseDeadlineMs accepts undefined/0/integers and rejects everything else", () => {
    assert.equal(parseDeadlineMs("x", undefined), undefined);
    assert.equal(parseDeadlineMs("x", 0), 0);
    assert.equal(parseDeadlineMs("x", 180000), 180000);
    for (const bad of [-1, 1.5, Number.NaN, "180000", true, null]) {
        assert.throws(() => parseDeadlineMs("x", bad), /\[acp-config\] x must be a non-negative integer number of milliseconds/);
    }
});

// --- F: three-level cascade semantics --------------------------------------

const ROUTES: ProviderRoutes = {
    "https://relay-a.example": {
        firstContentTimeoutMs: 600000,
        models: { "gpt-x": { firstContentTimeoutMs: 90000 } },
    },
    "https://relay-b.example": {
        firstContentTimeoutMs: 0,
    },
    "https://relay-c.example": {
        firstContentTimeoutMs: 180000,
        contentGapTimeoutMs: 0,
    },
};

test("#3254 F: cascade — model > route > global, 0 wins at its level, absent falls to built-in, gap inherits initial", () => {
    // all absent → OUT-OF-THE-BOX built-in default (feature ON by default, #3254 round-3)
    assert.deepEqual(resolveFirstContentDeadlines({}, undefined, undefined, undefined), { initialMs: 720000, initialSource: "builtin", gapMs: 720000, gapSource: "builtin" });
    // global tier alone; gap inherits the resolved initial ceiling
    assert.deepEqual(resolveFirstContentDeadlines({}, "https://any.example", undefined, { firstContentTimeoutMs: 180000 }), { initialMs: 180000, initialSource: "config", gapMs: 180000, gapSource: "config" });
    // global gap-only: initial is ABSENT so it falls to the built-in default; gap takes the explicit value
    assert.deepEqual(resolveFirstContentDeadlines({}, "https://any.example", undefined, { contentGapTimeoutMs: 300000 }), { initialMs: 720000, initialSource: "builtin", gapMs: 300000, gapSource: "config" });
    // explicit 0 at the GLOBAL tier disables every phase (opt-out escape hatch overrides the built-in)
    assert.equal(resolveFirstContentDeadlines({}, "https://any.example", undefined, { firstContentTimeoutMs: 0 }), undefined);
    // route beats global
    assert.deepEqual(resolveFirstContentDeadlines(ROUTES, "https://relay-a.example/v1/messages", undefined, { firstContentTimeoutMs: 180000 }), { initialMs: 600000, initialSource: "config", gapMs: 600000, gapSource: "config" });
    // model beats route
    assert.deepEqual(resolveFirstContentDeadlines(ROUTES, "https://relay-a.example/v1/messages", "gpt-x", { firstContentTimeoutMs: 180000 }), { initialMs: 90000, initialSource: "config", gapMs: 90000, gapSource: "config" });
    // model ignored when the URL matches no route
    assert.deepEqual(resolveFirstContentDeadlines(ROUTES, "https://other.example", "gpt-x", { firstContentTimeoutMs: 180000 }), { initialMs: 180000, initialSource: "config", gapMs: 180000, gapSource: "config" });
    // explicit 0 at route level disables the phase (no fall-through to global);
    // gap then inherits nothing → feature fully off
    assert.equal(resolveFirstContentDeadlines(ROUTES, "https://relay-b.example", undefined, { firstContentTimeoutMs: 180000 }), undefined);
    // explicit 0 for gap only → initial survives, gap phase off
    assert.deepEqual(resolveFirstContentDeadlines(ROUTES, "https://relay-c.example", undefined, undefined), { initialMs: 180000, initialSource: "config" });
    // garbage at ANY tier rejects loudly (the global tier bypasses load-time parsing)
    assert.throws(() => resolveFirstContentDeadlines({}, "https://any.example", undefined, { firstContentTimeoutMs: "fast" }), /firstContentTimeoutMs must be a non-negative integer/);
});

// --- G: load-time validation of providers entries (route + model level) ----

test("#3254 G: loadRoutes rejects malformed deadline values at provider and model level, accepts valid ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili3254-"));
    const path = join(dir, "providers.json");
    const load = (obj: unknown) => {
        writeFileSync(path, JSON.stringify(obj));
        return loadRoutes({ ACP_PROVIDERS: path });
    };
    assert.throws(() => load({ "https://relay-a.example": { firstContentTimeoutMs: -5 } }), /providers entry firstContentTimeoutMs must be a non-negative integer/);
    assert.throws(() => load({ "https://relay-a.example": { models: { m: { contentGapTimeoutMs: "soon" } } } }), /providers entry models\.m\.contentGapTimeoutMs must be a non-negative integer/);
    const ok = load({ "https://relay-a.example": { firstContentTimeoutMs: 0, models: { m: { contentGapTimeoutMs: 120000 } } } });
    assert.equal(ok["https://relay-a.example"]?.firstContentTimeoutMs, 0);
    assert.equal(ok["https://relay-a.example"]?.models?.["m"]?.contentGapTimeoutMs, 120000);
});

// --- I: adaptive deadline math ----------------------------------------------

test("#3254 I: fcP95 + adaptiveDeadlineMs — cold undefined, [floor, ceiling] clamp, ceiling follows resolved value", () => {
    assert.equal(fcP95([42]), 42);
    // nearest-rank: at n=8 the rank is ceil(0.95×8)=8 → the max; at n=20 it is 19 → second-highest
    assert.equal(fcP95([5, 10, 15, 20, 25, 30, 35, 40]), 40);
    assert.equal(fcP95(Array.from({ length: 20 }, (_, i) => (i + 1) * 5)), 95);
    assert.equal(adaptiveDeadlineMs(undefined, 180000), undefined);
    assert.equal(adaptiveDeadlineMs(Array.from({ length: FC_ADAPTIVE_MIN_SAMPLES - 1 }, () => 20000), 180000), undefined, "one below MIN_SAMPLES is still cold");
    // p95=20000 → 3×=60000 → clamped UP to the 120s floor
    assert.equal(adaptiveDeadlineMs(Array.from({ length: FC_ADAPTIVE_MIN_SAMPLES }, () => 20000), 180000), 120000);
    // p95=200000 → 3×=600000 → exactly the 600000 ceiling passed here
    assert.equal(adaptiveDeadlineMs(Array.from({ length: FC_ADAPTIVE_MIN_SAMPLES }, () => 200000), 600000), 600000);
    // mid-band: p95=50000 → 150000, below the ceiling
    assert.equal(adaptiveDeadlineMs(Array.from({ length: FC_ADAPTIVE_MIN_SAMPLES }, () => 50000), 180000), 150000);
    // a user-pinned tighter ceiling is never relaxed upward (floor yields to it)
    assert.equal(adaptiveDeadlineMs(Array.from({ length: FC_ADAPTIVE_MIN_SAMPLES }, () => 20000), 60000), 60000);
    // ceiling FOLLOWS the resolved value (no hardcoded 600s cap): a slow route
    // (p95=300s → 3×=900s) under a 720s ceiling keeps its full 720s instead of
    // discontinuously dropping to ≤600s once warm (#3254 round-3 point ③)
    assert.equal(adaptiveDeadlineMs(Array.from({ length: FC_ADAPTIVE_MIN_SAMPLES }, () => 300000), 720000), 720000);
});

// --- J: resolver with adaptive samples --------------------------------------

test("#3254 J: warm routes adapt (source=adaptive) under their configured ceiling; cold stay on config", () => {
    const globals = { firstContentTimeoutMs: 180000 };
    const warm = Array.from({ length: FC_ADAPTIVE_MIN_SAMPLES }, () => 20000);
    // warm initial, no gap samples yet: initial adapts to the floor; the
    // INHERITED gap has no gap samples of its own and sits at the inherited
    // initial CEILING (the configured bound, not the tightened value)
    assert.deepEqual(resolveFirstContentDeadlines({}, "https://any.example", undefined, globals, { init: warm, gap: [] }), {
        initialMs: 120000, initialSource: "adaptive", gapMs: 180000, gapSource: "config",
    });
    // both phases warm in-band: p95=50000 → 150000 each
    const mid = Array.from({ length: FC_ADAPTIVE_MIN_SAMPLES }, () => 50000);
    assert.deepEqual(resolveFirstContentDeadlines({}, "https://any.example", undefined, globals, { init: mid, gap: mid }), {
        initialMs: 150000, initialSource: "adaptive", gapMs: 150000, gapSource: "adaptive",
    });
    // explicit ceiling tighter than the adaptive floor: adaptation engages but
    // the user's pinned value wins as the ceiling
    assert.deepEqual(resolveFirstContentDeadlines({}, "https://any.example", undefined, { firstContentTimeoutMs: 60000 }, { init: warm, gap: [] }), {
        initialMs: 60000, initialSource: "adaptive", gapMs: 60000, gapSource: "config",
    });
});

// --- K: sample ring storage in session metadata ------------------------------

test("#3254 K: recordFcSample/readFcSamples — window cap, per-phase rows, sanitizing read", () => {
    const s = makeCtx("s3254k", []).session;
    assert.equal(readFcSamples(s, "r"), undefined);
    recordFcSample(s, "r", 1234, 567);
    recordFcSample(s, "r", 2222);
    let got = readFcSamples(s, "r");
    assert.deepEqual(got, { init: [1234, 2222], gap: [567] });
    const s2 = makeCtx("s3254k2", []).session;
    for (let i = 0; i < FC_ADAPTIVE_WINDOW + 5; i++) recordFcSample(s2, "r", i);
    got = readFcSamples(s2, "r");
    assert.equal(got?.init.length, FC_ADAPTIVE_WINDOW, "oldest samples must be evicted past the window");
    assert.equal(got?.init[0], 5, "the first five records must have been evicted");
    assert.equal(got?.gap.length, 0);
    (s.metadata as Record<string, unknown>)["firstContentSamples"] = { r: { init: [1, Number.NaN, -5, "x"], gap: null } };
    assert.deepEqual(readFcSamples(s, "r"), { init: [1], gap: [] }, "reads must sanitize hand-corrupted metadata");
});

// --- L: end-to-end sampling — healthy attempts only --------------------------

test("#3254 L: a cleanly completed attempt records one healthy sample per phase; a killed attempt records none", async () => {
    const text = MESSAGE_START + textStart(0) + textDelta(0, "a") + textDelta(0, "b") + blockStop(0) + MESSAGE_DELTA() + MESSAGE_STOP;
    const healthy = await drainAnthropic(completeStream(text), { initialMs: 100000 }, "s3254l", 3000, "route-l");
    const sample = readFcSamples(healthy.session, "route-l");
    assert.ok(sample !== undefined && sample.init.length === 1 && sample.gap.length === 1, `expected one init + one gap sample: ${JSON.stringify(sample)}`);
    // the stream is synchronous, so both measured durations are legitimately 0ms
    assert.ok(sample!.init[0] >= 0 && sample!.init[0] < 10000, `first-content duration implausible: ${sample?.init[0]}ms`);
    const sink = { cancelled: false };
    const killed = await drainAnthropic(holdStream(MESSAGE_START + PING, sink), { initialMs: 150 }, "s3254l2", 3000, "route-l2");
    assert.match(killed.out, /model content deadline exceeded/);
    assert.equal(readFcSamples(killed.session, "route-l2"), undefined, "a deadline-killed attempt must not poison the route's samples");
});
