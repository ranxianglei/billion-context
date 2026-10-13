// #2798 regressions: the Google (Gemini native) lane never ran the incoming
// ACP panel/marker strip passes — prepare-google imported both strippers but
// never called them, so panels (#359) and ephemeral [ACP] status markers
// (#717/#1029, incl. block-form acp_status reports #2789/#2797) rode straight
// into the compression state on every /v1beta turn and were billed/replayed
// forever while the three sibling lanes stripped them. Covers: the new
// parts-aware strippers (incl. KDD #10 thinking-part protection), the
// fork-adoption id-parity mirror, the google countTokens twin (the anthropic
// twin's regression test lives in tests/count-tokens.test.ts), and a
// full-server proof that upstream /v1beta traffic arrives stripped.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { buildStatusPanel } from "acp-kernel/panel";
import type { GoogleRequestBody } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { startServer } from "../src/server.ts";
import { prepareGoogleCountTokens } from "../src/server/prepare-google.ts";
import { stripAcpPanelGoogleContents, stripAcpStatusMarkersGoogleContents, wrapCacheReport, STATUS_REPORT_OPEN, STATUS_REPORT_CLOSE } from "../src/acp-panel.ts";
import { buildVisibilityMarker } from "../src/loop/core.ts";
import { incomingCoreMessages } from "../src/fork-adoption.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { ProxyOptions } from "../src/config.ts";

function realPanel(): string {
    return buildStatusPanel({
        version: "billion-context@0.1.64",
        tokenCount: 100000,
        systemPromptTokens: 0,
        state: createInitialState(),
        nudge: undefined,
        modelContextLimit: 200000,
    });
}

const FALLBACK = "📊 ACP status\n  context: 12.3K / 200.0K (6.2%)\n  requests: 7";
const MARKER_FAIL = "❌ [ACP] Compression FAILED: no valid ranges parsed.";
const MARKER_OK = "📦 [ACP] Compressed m00001–m00010.";

// Same report-body fixtures as tests/acp-status-marker-block.test.ts (#2789):
// a realistic renderOverview body plus handleAcpStatus extras, in both the
// new sentinel-wrapped form and the pre-#2789 legacy unwrapped grammar.
const REPORT = [
    "ACTIVE SURFACE: pack=default | host=billion-context 0.1.192 (abc1234)",
    "",
    "CONTEXT BREAKDOWN",
    "  0 tool (0%) | 0 text (0%) | 27.1K summaries (100%)",
    "",
    "COMPRESSED BLOCKS — 2 active (1.2K summary, 95.0K original)",
    "",
    '  b1 (T1)  474.4K→169  3 msgs  "preflight overflow compress"',
    '  b2 (T1)  400.0K→150  5 msgs  "exploration"',
    "",
    'Tip: buildStatusReport({scope:"uncompressed", view:"messages", tool:"bash"}) for per-message listing',
].join("\n");
const EXTRAS = [
    "",
    "BILLED INPUT (upstream usage): 912625 tok · est-view total 516609 tok · ratio 1.8×",
    "Nudge: ACTIVE — EMERGENCY T2 distill: max pending 27093, usage 122%",
    "Compressible ranges (1, oldest first):",
    "  m00005–m00040  36 msgs  48.2K [tool 90% | text 10%]",
    "STORAGE — ok",
].join("\n");

function makeSession(): Session {
    return {
        id: `i2798-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        pendingRetrievals: [],
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

test("#2798 stripAcpPanelGoogleContents removes whole panel user contents (box/fallback/reports)", () => {
    const contents: Array<Record<string, unknown>> = [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "user", parts: [{ text: realPanel() }] },
        { role: "user", parts: [{ text: FALLBACK }] },
        { role: "user", parts: [{ text: wrapCacheReport("cache report body") }] },
        { role: "model", parts: [{ text: realPanel() }] },
        { role: "user", parts: [{ text: `${realPanel()}\nmy follow-up question` }] },
    ];
    assert.equal(stripAcpPanelGoogleContents(contents), 3, "box + fallback + cache report removed");
    assert.deepEqual(contents.map((c) => c.role), ["user", "model", "user"]);
});

test("#2798 panel split across text parts is still removed (whole-content join)", () => {
    const half = Math.floor(realPanel().length / 2);
    const contents: Array<Record<string, unknown>> = [
        { role: "user", parts: [{ text: realPanel().slice(0, half) }, { text: realPanel().slice(half) }] },
        { role: "user", parts: [{ text: "keep me" }] },
    ];
    assert.equal(stripAcpPanelGoogleContents(contents), 1);
    assert.equal(contents.length, 1);
    assert.equal((contents[0]!.parts as Array<{ text: string }>)[0]!.text, "keep me");
});

test("#2798 any non-text/signatured part makes a content panel-ineligible (preserved)", () => {
    const panel = realPanel();
    const cases: Array<{ name: string; parts: unknown[] }> = [
        { name: "inlineData image part", parts: [{ text: panel }, { inlineData: { mimeType: "image/png", data: "x" } }] },
        { name: "functionCall part", parts: [{ text: panel }, { functionCall: { id: "c1", name: "f", args: {} } }] },
        { name: "functionResponse part", parts: [{ text: panel }, { functionResponse: { id: "c1", name: "f", response: {} } }] },
        { name: "thought part", parts: [{ text: panel.slice(0, 5), thought: true }, { text: panel.slice(5) }] },
        { name: "thoughtSignature-carrying part", parts: [{ text: panel, thoughtSignature: "sig" }] },
        { name: "model role", parts: [{ text: panel }] },
    ];
    for (const c of cases) {
        const arr: Array<Record<string, unknown>> = c.name === "model role"
            ? [{ role: "model", parts: c.parts }]
            : [{ role: "user", parts: c.parts }];
        assert.equal(stripAcpPanelGoogleContents(arr), 0, `${c.name} must be preserved`);
        assert.equal(arr.length, 1, `${c.name}: content never deleted`);
    }
});

test("#2798 stripAcpPanelGoogleContents is a no-op on non-array input", () => {
    assert.equal(stripAcpPanelGoogleContents({}), 0);
    assert.equal(stripAcpPanelGoogleContents(undefined), 0);
});

test("#2798 stripAcpStatusMarkersGoogleContents strips marker lines from user/model/role-less text parts", () => {
    const contents: Array<Record<string, unknown>> = [
        { role: "user", parts: [{ text: `继续\n${MARKER_FAIL}\n后面还有内容` }] },
        { role: "model", parts: [{ text: `answer\n${MARKER_OK}` }] },
        { parts: [{ text: `role-less defaults to user side\n${MARKER_OK}` }] },
        { role: "model", parts: [{ text: "clean model text" }] },
        { role: "model", parts: [{ functionCall: { id: "c1", name: "compress", args: {} } }] },
    ];
    assert.equal(stripAcpStatusMarkersGoogleContents(contents), 3, "three marker lines removed");
    assert.equal((contents[0]!.parts as Array<{ text: string }>)[0]!.text, "继续\n后面还有内容");
    assert.equal((contents[1]!.parts as Array<{ text: string }>)[0]!.text, "answer", "a marker at end of part leaves no trailing newline (stripAcpStatusBlocks split/join, #2797)");
    assert.equal((contents[2]!.parts as Array<{ text: string }>)[0]!.text, "role-less defaults to user side");
    assert.equal((contents[3]!.parts as Array<{ text: string }>)[0]!.text, "clean model text");
});

test("#2798 wrapped acp_status block is removed whole from google parts (#2789/#2797)", () => {
    const marker = buildVisibilityMarker("acp_status", REPORT);
    const contents: Array<Record<string, unknown>> = [{ role: "user", parts: [{ text: `check state\n${marker}\nnow fold that range.` }] }];
    assert.equal(stripAcpStatusMarkersGoogleContents(contents), 1, "one marker head counted");
    const out = (contents[0]!.parts as Array<{ text: string }>)[0]!.text;
    assert.ok(out.includes("check state"), "prose before survives");
    assert.ok(out.includes("now fold that range."), "prose after survives");
    assert.ok(!out.includes("acp_status result:"), "head gone");
    assert.ok(!out.includes(STATUS_REPORT_OPEN) && !out.includes(STATUS_REPORT_CLOSE), "sentinels gone");
    assert.ok(!out.includes("ACTIVE SURFACE"), "report body gone");
});

test("#2798 legacy unwrapped acp_status body consumed by report grammar and stops at prose", () => {
    const legacy = `intro\n📊 [ACP] acp_status result:\n${REPORT}${EXTRAS}\n\nAlright, let me fold that range.`;
    const contents: Array<Record<string, unknown>> = [{ role: "model", parts: [{ text: legacy }] }];
    assert.equal(stripAcpStatusMarkersGoogleContents(contents), 1);
    const out = (contents[0]!.parts as Array<{ text: string }>)[0]!.text;
    assert.ok(out.startsWith("intro"), `intro kept, got: ${JSON.stringify(out)}`);
    assert.ok(out.includes("Alright, let me fold that range."), "prose after the report survives");
    assert.ok(!out.includes("ACTIVE SURFACE") && !out.includes("BILLED INPUT") && !out.includes("STORAGE — ok"), "legacy report body gone");
});

test("#2798 cut mid-report (open sentinel without close) consumes to end of part", () => {
    const cut = `start\n📊 [ACP] acp_status result:\n${STATUS_REPORT_OPEN}\nACTIVE SURFACE: pack=default`;
    const contents: Array<Record<string, unknown>> = [{ role: "user", parts: [{ text: cut }] }];
    assert.equal(stripAcpStatusMarkersGoogleContents(contents), 1);
    assert.equal((contents[0]!.parts as Array<{ text: string }>)[0]!.text, "start", "everything after the open sentinel is consumed");
});

test("#2798 thinking-family parts are byte-exact untouched (KDD #10)", () => {
    const signedBlock = `state\n${buildVisibilityMarker("acp_status", REPORT)}`;
    const contents: Array<Record<string, unknown>> = [
        { role: "model", parts: [{ text: MARKER_FAIL, thought: true }] },
        { role: "model", parts: [{ text: `${MARKER_FAIL}\nreal`, thoughtSignature: "abc" }] },
        { role: "model", parts: [{ text: signedBlock, thoughtSignature: "sig2" }] },
        { role: "model", parts: [{ text: `${MARKER_FAIL}\nreal` }] },
    ];
    assert.equal(stripAcpStatusMarkersGoogleContents(contents), 1, "only the unsigned plain part is touched");
    assert.equal((contents[0]!.parts as Array<{ text: string }>)[0]!.text, MARKER_FAIL, "thought part byte-exact");
    assert.equal((contents[1]!.parts as Array<{ text: string }>)[0]!.text, `${MARKER_FAIL}\nreal`, "signed part byte-exact");
    assert.equal((contents[2]!.parts as Array<{ text: string }>)[0]!.text, signedBlock, "signed part with a full acp_status block inside stays byte-exact");
    assert.equal((contents[3]!.parts as Array<{ text: string }>)[0]!.text, "real", "unsigned part stripped (marker line incl. newline removed)");
});

test("#2798 marker-only parts degrade to a space and are never deleted", () => {
    const contents: Array<Record<string, unknown>> = [{ role: "model", parts: [{ text: MARKER_FAIL }] }];
    assert.equal(stripAcpStatusMarkersGoogleContents(contents), 1);
    assert.equal(contents.length, 1, "part kept");
    assert.equal((contents[0]!.parts as Array<{ text: string }>)[0]!.text, " ", "degraded to a space");
    assert.equal(stripAcpStatusMarkersGoogleContents(null), 0, "non-array input is a no-op");
});

test("#2798 fork-adoption google id-pass mirrors prepareGoogle (panels + markers stripped)", () => {
    const body = {
        contents: [
            { role: "user", parts: [{ text: realPanel() }] },
            { role: "model", parts: [{ text: `real answer\n${MARKER_FAIL}` }] },
            { role: "user", parts: [{ text: "next question" }] },
        ],
    };
    const msgs = incomingCoreMessages("google", body);
    assert.ok(msgs, "google adoption supported");
    assert.equal(msgs!.length, 2, "panel content gone from the projection");
    const texts = msgs!.map((m) => m.text ?? "");
    assert.ok(!texts.some((t) => t.includes("ACP Context Analysis")), "panel text absent");
    assert.ok(!texts.some((t) => t.includes("[ACP]")), "marker lines absent");
    assert.ok(texts.some((t) => t.includes("next question")), "real conversation text intact");
    assert.ok(texts.some((t) => t.includes("real answer")), "stripped model text keeps its payload");
});

test("#2798 prepareGoogleCountTokens strips panels + markers before measuring", () => {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const logs: string[] = [];
    const parsed: GoogleRequestBody = {
        contents: [
            { role: "user", parts: [{ text: realPanel() }] },
            { role: "model", parts: [{ text: `answer\n${MARKER_FAIL}` }] },
            { role: "user", parts: [{ text: "how much is this?" }] },
        ],
    };
    const prepared = prepareGoogleCountTokens(parsed, core, config, (_l, m) => logs.push(m), session);
    const out = JSON.parse(prepared.body.toString()) as { contents: unknown[] };
    assert.equal(out.contents.length, 2, "panel content not measured");
    assert.ok(!JSON.stringify(out.contents).includes("ACP Context Analysis"), "panel absent from measured payload");
    assert.ok(!JSON.stringify(out.contents).includes("[ACP]"), "markers absent from measured payload");
    assert.ok(logs.some((l) => /stripped 1 ACP panel message\(s\) before projection/.test(l)), "panel strip logged");
    assert.ok(logs.some((l) => /stripped 1 ACP status marker line\(s\) from incoming history/.test(l)), "marker strip logged");
    assert.equal(session.state.blocks.length, 0, "countTokens stays read-only");
});

test("#2798 full-server: upstream /v1beta traffic arrives stripped of panels + markers", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstreamReqs: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            upstreamReqs.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const frame = (parts: Array<Record<string, unknown>>, finishReason?: string): void => {
                const candidate: Record<string, unknown> = { content: { role: "model", parts }, index: 0 };
                if (finishReason) candidate.finishReason = finishReason;
                res.write(`data: ${JSON.stringify({ candidates: [candidate], modelVersion: "gemini-test" })}\n\n`);
            };
            frame([{ text: "ok" }]);
            frame([], "STOP");
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gemini-test": { context: 1_000_000 } } } } as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
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
        mitm: { enabled: false, domains: [] },
    });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                contents: [
                    { role: "user", parts: [{ text: realPanel() }] },
                    { role: "model", parts: [{ text: `real answer\n${MARKER_FAIL}` }] },
                    { role: "user", parts: [{ text: "how much is this?" }] },
                ],
                generationConfig: { maxOutputTokens: 4096 },
            }),
        });
        assert.equal(res.status, 200, `google turn failed: ${res.status}`);
        const reply = await res.text();
        assert.ok(reply.includes("ok"), "lane still answers through the proxy");

        assert.equal(upstreamReqs.length, 1, "exactly one upstream request");
        const sent = JSON.parse(upstreamReqs[0]!) as { contents: Array<{ role?: string; parts: Array<{ text?: string }> }> };
        assert.equal(sent.contents.length, 2, "panel content must not reach upstream");
        const allText = sent.contents.map((c) => (c.parts ?? []).map((p) => p.text ?? "").join("")).join("\n");
        assert.ok(!allText.includes("ACP Context Analysis"), "panel text must not reach upstream");
        assert.ok(!allText.includes("[ACP]"), "marker lines must not reach upstream");
        assert.ok(allText.includes("real answer"), "conversation payload preserved");
        assert.ok(allText.includes("how much is this?"), "trailing question preserved");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
