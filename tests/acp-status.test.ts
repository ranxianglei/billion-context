import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import { _resetSessionsForTest, getSession, type Session } from "../src/session.ts";
import { handlePluginStatus, rememberPluginMessages } from "../src/plugin.ts";
import type { ServerResponse } from "node:http";
import { handleAcpStatus } from "../src/acp-status.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput, buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { recordBlindTunnel, _resetBlindTunnelStatsForTest } from "../src/mitm.ts";
import { _resetAdvisoryWatcherForTest, _setAdvisoryStateForTest } from "../src/advisory.ts";

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeCtx(messages: CoreMessage[]): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "acp-status-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: () => {},
    };
}

function withRefs(ctx: ReturnType<typeof makeCtx>): ReturnType<typeof makeCtx> {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

function makeCtx12(): ReturnType<typeof makeCtx> {
    const msgs: CoreMessage[] = [];
    for (let i = 1; i <= 12; i++) {
        msgs.push(textMsg(`raw_${i}`, i % 2 === 1 ? "user" : "assistant", "x".repeat(5000)));
    }
    return withRefs(makeCtx(msgs));
}

const COMPRESS_ARGS = JSON.stringify({ content: [{ startId: "m00001", endId: "m00006", summary: "ACP-STATUS-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });

function rangesSection(report: string): string {
    const idx = report.indexOf("Compressible ranges");
    return idx === -1 ? "" : report.slice(idx);
}

test("#389: acp_status after compress lists no already-compressed refs, without a new prepare", () => {
    const ctx = makeCtx12();
    const before = handleAcpStatus({}, ctx);
    assert.ok(rangesSection(before).includes("m00001"), "pre-compress report lists m00001 as compressible (fixture sanity)");

    const result = applyRanges(parseCompressInput(JSON.parse(COMPRESS_ARGS)), ctx);
    assert.ok(!result.startsWith("[Compression FAILED"), `compress succeeded (got: ${result.slice(0, 80)})`);
    assert.ok(ctx.session.state.blocks.some((b) => b.blockId === "b1" && b.active), "block b1 active after compress");

    // No new prepare between the compress and this status call — the exact
    // #389 scenario. The report must derive ranges/nudge from live state.
    const after = handleAcpStatus({}, ctx);
    assert.ok(after.includes("b1"), "base report shows the new active block");
    // #1179: BLOCK SPANS (and other sections) legitimately name covered refs —
    // scope the check to actual range-entry lines ("  mNNNNN–mNNNNN …").
    const rangeLines = rangesSection(after).split("\n").filter((l) => /^\s{2}m\d{5}–/.test(l));
    assert.ok(rangeLines.length > 0, "remaining compressible ranges still listed");
    assert.ok(!rangeLines.some((l) => l.includes("m00001")), "compressed refs must not reappear in Compressible ranges");
    assert.ok(!rangeLines.some((l) => l.includes("m00006")), "compressed refs must not reappear in Compressible ranges");
    assert.ok(after.includes("Nudge: "), "Nudge line present and derived from live state");
});

test("#389: scope= short-circuit returns the live base report only", () => {
    const ctx = makeCtx12();
    const out = handleAcpStatus({ scope: "uncompressed" }, ctx);
    assert.ok(out.includes("UNCOMPRESSED"), "scope= base report present");
    assert.ok(!out.includes("Compressible ranges"), "scope= output carries no ranges section");
    assert.ok(!out.includes("Nudge:"), "scope= output carries no nudge line");
});

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function fcEvents(outputIndex: number, callId: string, name: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name }, output_index: outputIndex }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args }, output_index: outputIndex }),
    ].join("");
}

test("#389: same-turn loop — acp_status after compress in one round shows live ranges", async () => {
    const ctx = makeCtx12();
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", COMPRESS_ARGS),
        fcEvents(1, "call_s", "acp_status", "{}"),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ].join("");
    const refetch = sse("response.completed", { response: { id: "resp_refetch", status: "completed", output: [], usage: { input_tokens: 8000, output_tokens: 5 } } });
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(refetch, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    try {
        const chunks: Buffer[] = [];
        for await (const chunk of runCompressLoop(new Response(round1, { status: 200 }).body!, ctx, { model: "gpt-4o", input: [], stream: true }, { url: "http://mock", headers: {} }, createResponsesAdapter(), buildCompressSystemPrompt())) {
            chunks.push(chunk);
        }
        const out = Buffer.concat(chunks).toString("utf8");
        const markerIdx = out.indexOf("acp_status result:");
        assert.ok(markerIdx !== -1, "acp_status marker emitted");
        const statusPart = out.slice(markerIdx);
        assert.ok(statusPart.includes("Compressible ranges"), "responses loop acp_status now carries the ranges section");
        assert.ok(statusPart.includes("b1"), "status marker shows the newly created block");
        // #1179: BLOCK SPANS names the covered span in the same report — check
        // the range-entry shape ("  mNNNNN–mNNNNN  …") instead of a bare substring.
        assert.ok(!statusPart.includes("  m00001–m00006  "), "compressed range must not be listed as compressible in the same-turn status");
    } finally {
        globalThis.fetch = orig;
    }
});

test("#897: acp_status surfaces blind-tunneled CONNECT traffic as UNDECRYPTED TRAFFIC", () => {
    _resetBlindTunnelStatsForTest();
    try {
        const ctx = makeCtx12();
        const clean = handleAcpStatus({}, ctx);
        assert.ok(!clean.includes("UNDECRYPTED TRAFFIC"), "no section when no blind tunnels recorded");

        recordBlindTunnel("copilot.tencent.com");
        recordBlindTunnel("copilot.tencent.com");
        recordBlindTunnel("api.deepseek.com");
        const out = handleAcpStatus({}, ctx);
        assert.ok(out.includes("UNDECRYPTED TRAFFIC (instance-level)"), "section present when blind tunnels exist");
        assert.ok(out.includes("3 CONNECT tunnel(s)"), `total count rendered (got: ${out.slice(-400)})`);
        assert.ok(out.includes("copilot.tencent.com×2"), "per-host counts with real hosts, most tunnels first");
        assert.ok(out.includes("api.deepseek.com×1"));
        assert.ok(out.includes('add its model domain to "mitm".domains'), "points at the config fix");
        assert.ok(out.includes("/__bili/stats → blindTunnels"), "points at the stats endpoint");
    } finally {
        _resetBlindTunnelStatsForTest();
    }
});

test("#1577: acp_status surfaces an active instance-level advisory", () => {
    _resetAdvisoryWatcherForTest();
    try {
        const ctx = makeCtx12();
        const clean = handleAcpStatus({}, ctx);
        assert.ok(!clean.includes("CRITICAL ADVISORY"), "no section when no advisory is active");

        _setAdvisoryStateForTest({
            active: { id: "bc-2026-001", affected: ">=0.1.155 <0.1.158", target: "0.1.157", reason: "corrupts tool-call arguments", currentVersion: "0.1.156" },
        });
        const out = handleAcpStatus({}, ctx);
        assert.ok(out.includes("CRITICAL ADVISORY (instance-level):"), "section present while an advisory is active");
        assert.ok(out.includes("[bc-2026-001] version 0.1.156 is affected (corrupts tool-call arguments)"), "id + affected version + reason rendered");
        assert.ok(out.includes("npm install -g billion-context@0.1.157"), "manual fallback command present");
        assert.ok(out.includes("GET /__bili/status → advisory"), "points at the live-state field");
    } finally {
        _resetAdvisoryWatcherForTest();
    }
});

test("acp_status renders the ACTIVE SURFACE line from the session's pack stamp", () => {
    const ctx = makeCtx12();
    const unstamped = handleAcpStatus({}, ctx).split("\n").find((l) => l.startsWith("ACTIVE SURFACE:"));
    assert.ok(unstamped?.includes("pack=default"), `unstamped session reports pack=default (got: ${unstamped})`);
    const stamped = makeCtx12();
    (stamped.session as { meta: { activePack?: string } }).meta.activePack = "lean";
    const report = handleAcpStatus({}, stamped);
    const line = report.split("\n").find((l) => l.startsWith("ACTIVE SURFACE:"));
    assert.ok(line, "ACTIVE SURFACE line present once stamped");
    assert.ok(line!.startsWith("ACTIVE SURFACE: pack=lean | host=billion-context "), `host identity rendered (got: ${line})`);
});

const statusBaselines: Array<{
    name: string;
    source?: Session["stats"]["lastInputTokensSource"];
    anchor?: number;
    current?: number;
    expected: number;
}> = [
    { name: "failure estimate with real anchor", source: "estimate", anchor: 60000, expected: 60000 },
    { name: "legacy baseline with real anchor", anchor: 60000, expected: 60000 },
    { name: "estimate without real anchor", source: "estimate", expected: 0 },
    { name: "legacy baseline without real anchor", expected: 0 },
    { name: "actual over-window usage", source: "usage", anchor: 60000, expected: 174000 },
    { name: "credit-adjusted measured baseline", source: "usage", anchor: 60000, current: 30000, expected: 30000 },
    { name: "bounded overflow rescue arm", source: "overflow-arm", anchor: 60000, current: 150000, expected: 150000 },
];

for (const { name, source, anchor, current = 174000, expected } of statusBaselines) {
    test(`#2029: acp_status uses provenance for ${name}`, () => {
        const ctx = makeCtx12();
        ctx.config = defaultConfig(150000);
        ctx.session.stats.lastInputTokens = current;
        ctx.session.stats.lastInputTokensSource = source;
        ctx.session.stats.lastUsageGradeTokens = anchor;
        const before = JSON.stringify({ stats: ctx.session.stats, state: ctx.session.state });
        const original = ctx.core;
        const observed: number[] = [];
        ctx.core = { ...original, processTurn(input) {
            observed.push(input.tokenCount ?? 0);
            return original.processTurn(input);
        } };
        const report = handleAcpStatus({}, ctx);
        assert.deepEqual(observed, [expected]);
        assert.ok(report.includes("Nudge:"));
        if (expected === 60000 || expected === 0) assert.ok(!report.includes("usage 116%"), report);
        assert.equal(JSON.stringify({ stats: ctx.session.stats, state: ctx.session.state }), before);
    });

    test(`#2029: plugin status nudge and panel use provenance for ${name}`, () => {
        _resetSessionsForTest();
        try {
            const ctx = makeCtx12();
            const session = getSession("status-provenance");
            session.state = ctx.session.state;
            session.metadata.effectiveContextLimit = 150000;
            session.stats.lastInputTokens = current;
            session.stats.lastInputTokensSource = source;
            session.stats.lastUsageGradeTokens = anchor;
            rememberPluginMessages(session.id, ctx.messages, ctx.messages);
            const before = JSON.stringify({ stats: session.stats, state: session.state });
            const observed: number[] = [];
            const core = { ...ctx.core, processTurn(input: Parameters<typeof ctx.core.processTurn>[0]) {
                observed.push(input.tokenCount ?? 0);
                return ctx.core.processTurn(input);
            } };
            let status = 0;
            let body = "";
            const res = {
                writeHead(code: number) { status = code; return res; },
                end(chunk: string) { body = chunk; return res; },
            };
            handlePluginStatus(session.id, res as unknown as ServerResponse, {
                core, config: defaultConfig(150000), log: () => {},
            });
            assert.equal(status, 200);
            const result = JSON.parse(body) as { ok: boolean; panel?: string; contextTokens: number };
            assert.equal(result.ok, true);
            assert.equal(result.contextTokens, expected);
            assert.deepEqual(observed, [expected]);
            assert.ok(result.panel, "live panel is present");
            if (expected > 0) assert.ok(result.panel.includes(`${Math.round(expected / 1000)}k`), result.panel);
            if (expected !== 174000) assert.ok(!result.panel.includes("174k"), result.panel);
            assert.equal(JSON.stringify({ stats: session.stats, state: session.state }), before);
        } finally {
            _resetSessionsForTest();
        }
    });
}
