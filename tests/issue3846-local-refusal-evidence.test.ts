// #3846: a locally refused oversized request (preflight 413, NOT forwarded)
// could be forwarded on retry once the usage baseline demoted to
// "estimate": the refusal lived only in the #726 dead-end marker's
// body-hash dimension, so (a) the #2313 estimate-only probe re-armed at
// baselineFloor === 0 and ran BEFORE the dead-end check, and (b) every
// turn's changed body missed the hash — production shape: three consecutive
// full-bill forwards of 606K/620K/633K-token payloads bili itself had
// already refused locally. The fix persists local refusal evidence in
// session metadata scoped to origin/model/window and keeps every
// forward-once escape hatch closed at the same or tighter window. Pinned
// here end-to-end, both directions (#3617 gate discipline):
//   (a) positive — the issue's deterministic repro: fitting seed → oversized
//       non-foldable system text → local 413 → baseline demotion + restart
//       simulation → three identical retries stay 413 with ZERO additional
//       upstream calls; a trimmed payload still forwards;
//   (b) positive — production shape: retries with CHANGED bodies defeat the
//       dead-end hash, so only the persisted evidence can hold the line;
//   (c) negative — another model on the same origin, and another origin
//       entirely, are evaluated independently (the escape hatches stay open
//       where bili never refused);
//   (d) hygiene — the refusal is its own metadata channel: it must never be
//       labeled upstream usage (lastInputTokens/Source untouched).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";
import { normalizeUpstreamOrigin } from "../src/util.ts";

const WINDOW = 20_000;
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment held deterministic load-growth payloads across turns; every marker derives from the turn index, so folding loses nothing.";

// ~400KB of varying ASCII core text: ~100K tokens at the chars/4 estimate
// (5x the 20K window, robust across the whole k̂ clamp [0.25, 4]) yet far
// under the 2MB absolute doom bar, so the pre-fix probe would forward it.
function bigSystem(): string {
    let out = "";
    for (let i = 0; i < 400_000; i += 64) {
        out += `oversized non-foldable system load segment ${Math.floor(i / 64)}: ` + "x".repeat(40);
    }
    return out.slice(0, 400_000);
}

type Call = { summary: boolean; stream: boolean; contentChars: number };

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

// Counting fake upstream: bills what it receives at ~40 B/token and reports
// it as usage; answers summarization calls deterministically.
function makeUpstream(): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            try {
                const parsed = JSON.parse(raw) as { stream?: boolean; messages?: Array<{ content?: unknown }> };
                const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
                calls.push({ summary: isSummary, stream: !isSummary && !!parsed.stream, contentChars: chars });
                if (isSummary) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
                    return;
                }
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(chatSse("forwarded answer", { prompt_tokens: Math.max(1, Math.round(chars / 40)), completion_tokens: 3 }));
            } catch {
                res.writeHead(400, { "content-type": "application/json" });
                res.end('{"error":{"message":"unparseable"}}');
            }
        });
    });
    return { server, calls };
}

type Upstream = ReturnType<typeof makeUpstream>;

function proxyOptions(routes: Record<string, object>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        promptCache: { routing: "auto" },
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

type Ctx = { url: string; headers: Record<string, string>; upstreamPort: number };

async function listen(u: Upstream): Promise<number> {
    u.server.listen(0, "127.0.0.1");
    await once(u.server, "listening");
    return (u.server.address() as { port: number }).port;
}

async function setup(routes: Record<string, object>): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const firstKey = Object.keys(routes)[0]!;
    const port = Number(new URL(firstKey).port);
    const proxy = await startServer(proxyOptions(routes));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/${firstKey}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": "" },
            upstreamPort: port,
        },
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await Promise.allSettled([once(proxy, "close")]);
        },
    };
}

const post = (ctx: Ctx, body: Record<string, unknown>) =>
    fetch(ctx.url, { method: "POST", headers: { ...ctx.headers }, body: JSON.stringify(body) });

const streamCalls = (calls: Call[]) => calls.filter((c) => c.stream).length;
const summaryCalls = (calls: Call[]) => calls.filter((c) => c.summary).length;

// The issue's repro step 3: the baseline demotion a preflight rebuild performs
// (lastInputTokens anchored to the rebuilt size, source "estimate"), followed
// by a restart simulation — only the persisted metadata survives the round trip.
function demoteToEstimate(sessionId: string): void {
    const s = getSession(sessionId);
    assert.ok(s, "session exists");
    s.stats.lastInputTokens = 60_000;
    s.stats.lastInputTokensSource = "estimate";
    s.metadata = JSON.parse(JSON.stringify(s.metadata));
}

// Repro steps 1-2: a fitting seed settles a usage baseline; then an oversized
// NON-FOLDABLE system text (system is wire overhead — folding never removes
// it) must come back as a local 413 without touching the upstream.
async function seedAndRefuse(ctx: Ctx, sessionId: string, model: string): Promise<void> {
    ctx.headers["x-acp-session"] = sessionId;
    const rSeed = await post(ctx, { model, stream: true, messages: [{ role: "user", content: "hello" }] });
    assert.equal(rSeed.status, 200, "the fitting seed forwards");
    await rSeed.text();

    const rBig = await post(ctx, { model, stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] });
    assert.equal(rBig.status, 413, "oversized non-foldable payload is refused locally");
    const body = await rBig.text();
    assert.match(body, /NOT forwarded/, "the verdict says the payload did not ride");
}

test("e2e #3846 a: identical oversized retries stay local 413 after the baseline demotes to estimate — zero extra upstream calls", async () => {
    const up = makeUpstream();
    const port = await listen(up);
    const { ctx, close } = await setup({ [`http://127.0.0.1:${port}`]: { models: { "gpt-test": { context: WINDOW } } } });
    try {
        await seedAndRefuse(ctx, "i3846-a", "gpt-test");
        assert.equal(streamCalls(up.calls), 1, "only the seed reached the upstream");
        assert.equal(summaryCalls(up.calls), 0, "the refusal spent no summarization call");

        demoteToEstimate("i3846-a");

        // Three byte-identical retries: pre-fix the FIRST one sailed through
        // the estimate-only probe (which sits ahead of the dead-end check) and
        // billed the full 400KB payload.
        for (let i = 1; i <= 3; i++) {
            const r = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] });
            assert.equal(r.status, 413, `retry ${i} stays a local 413`);
            await r.text();
        }
        assert.equal(streamCalls(up.calls), 1, "no oversized retry may reach the upstream");
        assert.equal(summaryCalls(up.calls), 0, "no summarization call may run either");

        // Hygiene: the refusal is its own channel, never labeled usage.
        const s = getSession("i3846-a")!;
        assert.equal(s.stats.lastInputTokens, 60_000, "refusal evidence never rewrites the baseline value");
        assert.equal(s.stats.lastInputTokensSource, "estimate", "refusal evidence never relabels the baseline source");
        const refusals = s.metadata.localRefusals as Array<{ origin: string; model: string; window: number }>;
        assert.ok(Array.isArray(refusals) && refusals.length === 1, `one refusal record, got ${JSON.stringify(refusals)}`);
        assert.equal(refusals[0]!.origin, normalizeUpstreamOrigin(`http://127.0.0.1:${port}`));
        assert.equal(refusals[0]!.model, "gpt-test");
        assert.equal(refusals[0]!.window, WINDOW);

        // A fitting payload still forwards — the evidence closes escapes, not
        // the lane.
        const rTrim = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "user", content: "small question" }] });
        assert.equal(rTrim.status, 200, "the trimmed request succeeds");
        await rTrim.text();
        assert.equal(streamCalls(up.calls), 2, "the trimmed request is the only new forward");
    } finally {
        up.server.close();
        up.server.closeIdleConnections?.();
        await close();
    }
});

test("e2e #3846 b: CHANGED-body retries defeat the dead-end hash — only the persisted evidence holds the line", async () => {
    const up = makeUpstream();
    const port = await listen(up);
    const { ctx, close } = await setup({ [`http://127.0.0.1:${port}`]: { models: { "gpt-test": { context: WINDOW } } } });
    try {
        await seedAndRefuse(ctx, "i3846-b", "gpt-test");
        demoteToEstimate("i3846-b");

        // Production shape: each turn's body differs, so the #726 dead-end key
        // (model+window+body hash) misses every time. Pre-fix each retry
        // re-entered the estimate-only probe and forwarded once.
        const tails = ["q-A", "q-B-tail", "q-C-even-longer-tail"];
        for (let i = 0; i < tails.length; i++) {
            const r = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: tails[i]! }] });
            assert.equal(r.status, 413, `changed-body retry ${i + 1} stays a local 413`);
            await r.text();
        }
        assert.equal(streamCalls(up.calls), 1, "zero additional upstream stream calls across all changed-body retries");
        assert.equal(summaryCalls(up.calls), 0, "zero summarization calls — nothing was foldable");
    } finally {
        up.server.close();
        up.server.closeIdleConnections?.();
        await close();
    }
});

test("e2e #3846 c: another model on the same origin is evaluated independently — the probe stays open", async () => {
    const up = makeUpstream();
    const port = await listen(up);
    const { ctx, close } = await setup({
        [`http://127.0.0.1:${port}`]: { models: { "gpt-test": { context: WINDOW }, "gpt-other": { context: WINDOW } } },
    });
    try {
        await seedAndRefuse(ctx, "i3846-c", "gpt-test");
        demoteToEstimate("i3846-c");

        // Same origin, same window, DIFFERENT model: the refusal record does
        // not cover it — the estimate-only bet is still worth one request.
        const r = await post(ctx, { model: "gpt-other", stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] });
        assert.equal(r.status, 200, "an uncovered model still probes once");
        await r.text();
        assert.equal(streamCalls(up.calls), 2, "seed + exactly one probe forward for the other model");

        const s = getSession("i3846-c")!;
        const refusals = s.metadata.localRefusals as Array<{ model: string }>;
        assert.equal(refusals.length, 1, "the probe on the other model adds no refusal record");
        assert.equal(refusals[0]!.model, "gpt-test");
    } finally {
        up.server.close();
        up.server.closeIdleConnections?.();
        await close();
    }
});

test("e2e #3846 d: another ORIGIN is evaluated independently — the probe stays open", async () => {
    const upA = makeUpstream();
    const upB = makeUpstream();
    const portA = await listen(upA);
    const portB = await listen(upB);
    const { ctx, close } = await setup({
        [`http://127.0.0.1:${portA}`]: { models: { "gpt-test": { context: WINDOW } } },
        [`http://127.0.0.1:${portB}`]: { models: { "gpt-test": { context: WINDOW } } },
    });
    try {
        // Refuse on origin A (ctx.url points at A).
        await seedAndRefuse(ctx, "i3846-d", "gpt-test");
        assert.equal(streamCalls(upA.calls), 1);
        demoteToEstimate("i3846-d");

        // Same session, same model, DIFFERENT origin B: no covering record →
        // the probe fires again (a fresh route may bill on a different scale).
        const urlB = ctx.url.replace(`:${portA}`, `:${portB}`);
        const r = await fetch(urlB, { method: "POST", headers: { ...ctx.headers }, body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] }) });
        assert.equal(r.status, 200, "an uncovered origin still probes once");
        await r.text();
        assert.equal(streamCalls(upB.calls), 1, "origin B saw exactly the one probe forward");
        assert.equal(streamCalls(upA.calls), 1, "origin A saw nothing more");

        const s = getSession("i3846-d")!;
        const refusals = s.metadata.localRefusals as Array<{ origin: string }>;
        assert.equal(refusals.length, 1, "the probe on the other origin adds no refusal record");
        assert.equal(refusals[0]!.origin, normalizeUpstreamOrigin(`http://127.0.0.1:${portA}`));
    } finally {
        upA.server.close();
        upA.server.closeIdleConnections?.();
        upB.server.close();
        upB.server.closeIdleConnections?.();
        await close();
    }
});

// (#4079/#3974) The refusal evidence now carries a TTL (10 minutes): the
// #3846 lock was real money protection, but a record that never expires
// turned one bad hour into a permanent "this model is unusable" for the
// session — the uninstall-event class from #3974. Both directions pinned:
//   (e) an expired record no longer covers — the estimate-only probe may
//       bet once again (that bet is cheap and self-correcting: usage
//       settles, or a fresh refusal re-records with a fresh timestamp);
//   (f) a record without a readable `at` (persisted before the TTL existed)
//       is treated as expired too, so upgraded stuck sessions self-heal.
test("e2e #4079 e: refusal evidence expires after the TTL — the probe reopens exactly once", async () => {
    const up = makeUpstream();
    const port = await listen(up);
    const { ctx, close } = await setup({ [`http://127.0.0.1:${port}`]: { models: { "gpt-test": { context: WINDOW } } } });
    try {
        await seedAndRefuse(ctx, "i3846-e", "gpt-test");
        demoteToEstimate("i3846-e");

        const s = getSession("i3846-e")!;
        const refusals = s.metadata.localRefusals as Array<{ at?: number }>;
        assert.equal(refusals.length, 1, "one refusal record");
        assert.equal(typeof refusals[0]!.at, "number", "the record carries a readable timestamp");

        // Backdate past the TTL.
        refusals[0]!.at = Date.now() - 11 * 60_000;

        // The expired record no longer covers: the estimate-only probe may
        // bet once again (and here the bet lands — usage settles afresh).
        const r = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] });
        assert.equal(r.status, 200, "an expired record lets the probe bet once again");
        await r.text();
        assert.equal(streamCalls(up.calls), 2, "seed + exactly one reopened probe forward");
    } finally {
        up.server.close();
        up.server.closeIdleConnections?.();
        await close();
    }
});

test("e2e #4079 f: a record without a timestamp (pre-TTL legacy) is expired — upgraded stuck sessions self-heal", async () => {
    const up = makeUpstream();
    const port = await listen(up);
    const { ctx, close } = await setup({ [`http://127.0.0.1:${port}`]: { models: { "gpt-test": { context: WINDOW } } } });
    try {
        await seedAndRefuse(ctx, "i3846-f", "gpt-test");
        demoteToEstimate("i3846-f");

        const s = getSession("i3846-f")!;
        const refusals = s.metadata.localRefusals as Array<{ origin: string; model: string; window: number; at?: number }>;
        assert.equal(refusals.length, 1, "one refusal record");
        delete refusals[0]!.at;

        // No readable `at` proves nothing — the lane must behave as if no
        // refusal was recorded (the pre-TTL lock is exactly what #3974 hit).
        const r = await post(ctx, { model: "gpt-test", stream: true, messages: [{ role: "system", content: bigSystem() }, { role: "user", content: "q" }] });
        assert.equal(r.status, 200, "an at-less record does not hold the line");
        await r.text();
        assert.equal(streamCalls(up.calls), 2, "seed + exactly one probe forward");
    } finally {
        up.server.close();
        up.server.closeIdleConnections?.();
        await close();
    }
});
