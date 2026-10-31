// #5000: the three doomed gates (egress fuse / preflight fail-fast /
// post-compress recheck) priced ONLY core message bytes, while preflight's
// trigger priced messages PLUS system/tools wire overhead — a payload whose
// billable total exceeds every window could still clear the floor on the
// residual caliber. Field evidence (dsh 0.1.208): a 26,903-message session
// with 1.44 MiB of core text sent 55.2 MiB request bodies the gate never saw;
// the symmetric false-negative is a multi-MB tool manifest clearing a floor
// its own billed total can't fit. Fix: every gate prices BILLABLE content =
// core message text + system/tools wire overhead, both measured from the
// ACTUAL outbound body (whatever prepare really transmitted). The JSON
// envelope stays OUT of the floor: it is transport syntax no tokenizer bills,
// and counting it would break the bytes÷7.5>tokens⇒doomed invariant into
// false positives on dense-but-fitting payloads (#3617 both-ways: tests B/D
// pin that under-bar bodies — manifest-heavy ones included — still forward).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

import { defaultConfig, defaultCountTokens } from "acp-kernel";
import { startServer, estimateWireOverhead } from "../src/server.ts";
import { estimateWireOverheadBytes, wireOverheadTexts } from "../src/server/budget.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

const WINDOW = 20_000;

type Call = { bytes: number };

// ── unit: the byte-twin extraction ──────────────────────────────────────────

const anthropicBody = { model: "m", system: "S".repeat(4_000), tools: [{ name: "t", description: "D".repeat(2_000), input_schema: {} }], messages: [{ role: "user", content: "U".repeat(50_000) }] };

test("estimateWireOverheadBytes: anthropic counts exactly system + tools, never message content", () => {
    const expected = Buffer.byteLength("S".repeat(4_000), "utf8") + Buffer.byteLength(JSON.stringify([{ name: "t", description: "D".repeat(2_000), input_schema: {} }]), "utf8");
    assert.equal(estimateWireOverheadBytes("anthropic", JSON.stringify(anthropicBody)), expected);
    // independence: a 50KB user message changes nothing
    const stripped = { ...anthropicBody, messages: [] };
    assert.equal(estimateWireOverheadBytes("anthropic", JSON.stringify(stripped)), expected);
});

test("estimateWireOverheadBytes: openai raw-client shape hoists system+developer only (exact)", () => {
    const body = { messages: [
        { role: "system", content: "SYS ".repeat(300) },
        { role: "developer", content: "DEV ".repeat(300) },
        { role: "user", content: "U".repeat(50_000) },
    ] };
    // "SYS "×300 + "\n" + "DEV "×300 = 2401B, plus the empty tool list "[]" = 2B
    assert.equal(estimateWireOverheadBytes("openai", JSON.stringify(body)), 2_403);
});

test("estimateWireOverheadBytes: responses counts instructions + developer items + loaded items (exact)", () => {
    const loaded = { type: "additional_tools", tools: [{ name: "x" }] };
    const body = {
        instructions: "I".repeat(4_000),
        tools: [{ type: "function", name: "f" }],
        input: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: "P1 ".repeat(300) }, { type: "input_text", text: "P2 ".repeat(300) }] },
            { type: "message", role: "user", content: "U".repeat(50_000) },
            loaded,
        ],
    };
    // instructions and input[] developer items merge into ONE sysText joined by "\n" (budget.ts join rule)
    const expected =
        Buffer.byteLength("I".repeat(4_000) + "\n" + "P1 ".repeat(300) + "\n" + "P2 ".repeat(300), "utf8") +
        Buffer.byteLength(JSON.stringify([{ type: "function", name: "f" }]), "utf8") +
        Buffer.byteLength(JSON.stringify(loaded), "utf8");
    assert.equal(estimateWireOverheadBytes("responses", JSON.stringify(body)), expected);
});

test("estimateWireOverheadBytes: google counts systemInstruction + functionDeclarations, not contents", () => {
    const tools = [{ functionDeclarations: [{ name: "g" }] }];
    const body = { model: "m", systemInstruction: { parts: [{ text: "G".repeat(4_000) }] }, contents: [{ parts: [{ text: "U".repeat(50_000) }] }], tools };
    const expected = Buffer.byteLength("G".repeat(4_000), "utf8") + Buffer.byteLength(JSON.stringify(tools), "utf8");
    assert.equal(estimateWireOverheadBytes("google", JSON.stringify(body)), expected, `system+tools only (got ${estimateWireOverheadBytes("google", JSON.stringify(body))})`);
});

test("estimateWireOverheadBytes: CJK is priced in UTF-8 BYTES, not chars", () => {
    // 1000 CJK chars = 3000 utf8 bytes; a char-based meter would read ~1000 and
    // miss a third of the mass on dense-CJK manifests
    assert.equal(estimateWireOverheadBytes("anthropic", JSON.stringify({ system: "汉".repeat(1_000) })), 3_002);
});

test("estimateWireOverheadBytes: unparseable → 0, empty → just the empty tool list", () => {
    assert.equal(estimateWireOverheadBytes("anthropic", "not json {"), 0);
    assert.equal(estimateWireOverheadBytes("openai", Buffer.from("}{")), 0);
    assert.equal(estimateWireOverheadBytes("responses", JSON.stringify({})), 2);
});

test("estimateWireOverheadBytes: pre-parsed object ≡ legacy string re-parse (#2078 shape)", () => {
    const cases: Array<[Parameters<typeof estimateWireOverheadBytes>[0], Record<string, unknown>]> = [
        ["anthropic", anthropicBody],
        ["openai", { messages: [{ role: "system", content: "SYS ".repeat(300) }, { role: "user", content: "U".repeat(40_000) }] }],
        ["responses", { instructions: "I".repeat(4_000), input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "P1 ".repeat(300) }] }] }],
        ["google", { model: "m", systemInstruction: { parts: [{ text: "G".repeat(4_000) }] }, contents: [] }],
    ];
    for (const [protocol, obj] of cases) {
        assert.equal(estimateWireOverheadBytes(protocol, obj), estimateWireOverheadBytes(protocol, JSON.stringify(obj)), `${protocol}: pre-parsed must equal legacy`);
    }
});

// Refactor no-drift pin: the token caliber must still be exactly the sum of
// defaultCountTokens over the same extracted pieces (the pre-#5000 formula).
test("estimateWireOverhead: unchanged by the byte-twin refactor — identical piece-sum", () => {
    const cases: Array<[Parameters<typeof estimateWireOverhead>[0], Record<string, unknown>]> = [
        ["anthropic", anthropicBody],
        ["openai", { messages: [{ role: "system", content: "SYS ".repeat(300) }, { role: "developer", content: "DEV ".repeat(300) }, { role: "user", content: "U".repeat(40_000) }] }],
        ["responses", { instructions: "I".repeat(4_000), input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "P1 ".repeat(300) }] }, { type: "additional_tools", tools: [{ name: "x" }] }] }],
        ["google", { model: "m", systemInstruction: { parts: [{ text: "G".repeat(4_000) }] }, contents: [], tools: [{ functionDeclarations: [{ name: "g" }] }] }],
    ];
    for (const [protocol, obj] of cases) {
        const { sysText, toolsJson, loadedItemJsons } = wireOverheadTexts(protocol, obj);
        const pieceSum = defaultCountTokens(sysText) + defaultCountTokens(toolsJson) + loadedItemJsons.reduce((a, j) => a + defaultCountTokens(j), 0);
        assert.equal(estimateWireOverhead(protocol, obj), pieceSum, `${protocol}: token caliber must stay the piece-sum`);
    }
});

// ── e2e: both gate sites price the real outbound body ───────────────────────

function chatSse(text: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", { usage: { prompt_tokens: 100, completion_tokens: 3 } }) + "data: [DONE]\n\n";
}

function bigMessages(count: number, charsPerMsg: number): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    const pad = Math.max(1, charsPerMsg - 12);
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}: ` + "f".repeat(pad) });
    }
    return messages;
}

function bigTools(count: number, descChars: number): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, i) => ({
        type: "function",
        function: { name: `tool_${i}`, description: "d".repeat(descChars), parameters: { type: "object", properties: {} } },
    }));
}

function makeUpstream(): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const bytes = Buffer.concat(chunks).length;
            calls.push({ bytes });
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(chatSse("forwarded answer"));
        });
    });
    return { server, calls };
}

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

type Ctx = { url: string; headers: Record<string, string> };

async function setup(): Promise<{ ctx: Ctx; calls: Call[]; close: () => void }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } }));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": "" },
        },
        calls,
        // #4245 deterministic teardown (same rationale as the #4079 harness):
        // assertions are done, ports are ephemeral — force-destroy connections
        // instead of gating on cross-socket 'close' timing.
        close: () => {
            proxy.close();
            proxy.closeAllConnections?.();
            upstream.close();
            upstream.closeAllConnections?.();
        },
    };
}

const post = (ctx: Ctx, messages: Array<{ role: string; content: string }>, opts: { withModel?: boolean; tools?: unknown[]; sessionId?: string } = {}) =>
    fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers, ...(opts.sessionId ? { "x-acp-session": opts.sessionId } : {}) },
        body: JSON.stringify({ ...(opts.withModel ? { model: "gpt-test" } : {}), ...(opts.tools ? { tools: opts.tools } : {}), stream: true, messages }),
    });

// #2847 stuck-meter seed: one small turn establishes a session whose last
// reported input dwarfs the window (F2 demotes the baseline floor to 0), so
// the next request arms preflight's probe-for-evidence doom check.
async function seedStuckMeter(ctx: Ctx, sessionId: string): Promise<void> {
    const r = await fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers, "x-acp-session": sessionId },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    await r.text();
    const s = getSession(sessionId);
    s.stats.lastInputTokens = 7_300_000;
    s.stats.lastInputTokensSource = "estimate";
    s.stats.lastInputTokensOrigin = "http://127.0.0.1:1";
}

test("e2e #5000 fuse positive: core text alone clears the bar but text+manifest does not — stopped, not forwarded", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-5000a-"));
    const { ctx, calls, close } = await setup();
    try {
        // No `model` in the body → preflight's `!model` early return skips its
        // doom math entirely; the egress fuse is the ONLY gate left (#4079).
        // Floored bar = max(2MB, max(20K declared, 1M assumed) × 7.5) = 7.5MB.
        // ~5.5MB core text ALONE is under the bar (the old gate stayed silent
        // here — the blind spot), but +~2.6MB of tool manifest crosses it.
        const messages = bigMessages(1_250, 4_400);
        const tools = bigTools(260, 10_000);
        const coreTextAlone = messages.reduce((a, m) => a + Buffer.byteLength(m.content, "utf8"), 0);
        assert.ok(coreTextAlone < 7_500_000, `sanity: the OLD message-only measure (${coreTextAlone}B) would have let this through`);

        const r = await post(ctx, messages, { tools });
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { type?: string; code?: string; retryable?: boolean; message?: string } };

        assert.equal(r.status, 413, `doomed egress must answer 413 (got ${r.status})`);
        assert.equal(parsed.error?.code, "egress_window_fuse");
        assert.equal(parsed.error?.retryable, false);
        assert.match(parsed.error?.message ?? "", /outbound billable content is ~\d{7} bytes/, "the combined billable mass is in the operator-facing message");
        assert.match(parsed.error?.message ?? "", /system\/tools overhead/, "the new component breakdown names the previously-invisible class");
        assert.match(parsed.error?.message ?? "", /shrink the tool manifest/, "the remedy now covers the manifest class");
        assert.equal(calls.length, 0, `upstream must see zero calls (got ${JSON.stringify(calls)})`);
    } finally {
        await close();
        rmrf(root);
    }
});

test("e2e #5000 fuse both-ways negative: manifest-heavy body UNDER the combined bar still forwards", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-5000b-"));
    const { ctx, calls, close } = await setup();
    try {
        // ~3.08MB core text + ~1.1MB manifest ≈ 4.2MB < 7.5MB floored bar —
        // the stricter gate must NOT false-block what no-window-math condemns
        // (#3617 both-ways, #4079 floor discipline).
        const r = await post(ctx, bigMessages(700, 4_400), { tools: bigTools(110, 10_000) });
        assert.equal(r.status, 200, `under-bar bodies forward regardless of estimator opinion (got ${r.status})`);
        await r.text();
        assert.equal(calls.length, 1, "the request reached the upstream");
        assert.ok(calls[0]!.bytes > 3_000_000, `the multi-MB body really was forwarded (got ${calls[0]!.bytes}B)`);
    } finally {
        await close();
        rmrf(root);
    }
});

test("e2e #5000 fail-fast positive: stuck-meter session, text alone under the absolute bar but billable over — 413 non-retryable, not probed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-5000c-"));
    const { ctx, calls, close } = await setup();
    try {
        await seedStuckMeter(ctx, "s-5000-c");
        // Absolute bar = 2MB (dominates the 20K×7.5=150KB ratio bar).
        // ~1.505MB core text ALONE is under it (old gate silent), +~0.7MB
        // manifest crosses it → the probe-for-evidence doom check fires.
        const messages = bigMessages(350, 4_300);
        const coreTextAlone = messages.reduce((a, m) => a + Buffer.byteLength(m.content, "utf8"), 0);
        assert.ok(coreTextAlone < 2_000_000, `sanity: the OLD message-only measure (${coreTextAlone}B) would have probed this`);

        const r = await post(ctx, messages, { withModel: true, tools: bigTools(70, 10_000), sessionId: "s-5000-c" });
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { code?: string; retryable?: boolean; message?: string } };

        assert.equal(r.status, 413, `doomed probe must answer 413 (got ${r.status})`);
        assert.equal(parsed.error?.code, "preflight_compress_failed");
        assert.equal(parsed.error?.retryable, false, "#2847: 4xx non-retryable semantics");
        assert.match(parsed.error?.message ?? "", /billable content alone is ~2\d{6} bytes/, "combined mass in the message (~2.2MB)");
        assert.match(parsed.error?.message ?? "", /NOT forwarded even for evidence/);
        assert.equal(calls.length, 1, `only the seed turn reached the upstream (got ${calls.length})`);
        assert.ok(calls[0]!.bytes < 50_000, "the doomed payload itself was never probed");
    } finally {
        await close();
        rmrf(root);
    }
});

test("e2e #5000 fail-fast both-ways negative: billable under the absolute bar falls through to forward-once", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-5000d-"));
    const { ctx, calls, close } = await setup();
    try {
        await seedStuckMeter(ctx, "s-5000-d");
        // ~1.505MB text + ~0.3MB manifest ≈ 1.8MB < 2MB absolute bar → the
        // doom check passes and the #2313 forward-once escape hatches.
        const r = await post(ctx, bigMessages(350, 4_300), { withModel: true, tools: bigTools(30, 10_000), sessionId: "s-5000-d" });
        assert.equal(r.status, 200, `under-bar payloads keep their forward-once evidence probe (got ${r.status})`);
        await r.text();
        assert.equal(calls.length, 2, "seed turn + the full payload were both forwarded");
        assert.ok(calls[1]!.bytes > 1_500_000, `the multi-MB payload really was forwarded (got ${calls[1]!.bytes}B)`);
    } finally {
        await close();
        rmrf(root);
    }
});
