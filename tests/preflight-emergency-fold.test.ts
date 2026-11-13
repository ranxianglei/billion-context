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
import { listSessions } from "../src/session.ts";
import { deterministicDigest } from "../src/preflight.ts";

// #2383: a dsh fork resends its whole raw history as a FRESH session id —
// observed live: 2824 messages, ~5.09M tokens vs a 240K window (21.2x). The
// LLM fold path needs one upstream summarization call per fold (~15-30s each)
// and its raised budget caps at 32 rounds with a documented coverage bound of
// ~19.2x — structurally unable to converge in one invocation, while the host
// client disconnects every ~300s. The user retries forever; the session never
// starts. Above EMERGENCY_FOLD_COVERAGE (19.2x) the fold switches to a
// CPU-only deterministic digest: zero summarization calls, convergence in
// seconds, folded originals still restorable via decompress (applyRanges
// stores covered originals in the content store exactly like any other fold).

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. " +
    "Key decisions: chose the preflight approach over lossy truncation because the payload must stay coherent. " +
    "Files touched: src/a.ts:10, src/b.ts:20. Outcome: fixed and verified by tests.";

function okSse(inputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

// MARKER_i sits in the FIRST 120 chars (digest form A quotes heads verbatim,
// so it legitimately survives folding); TAIL_i sits at the END and only
// survives if the message itself was not folded.
function conversation(count: number, charsPerMessage: number): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    const filler = "The quick brown fox jumps over the lazy dog. ";
    for (let i = 0; i < count; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        const head = `Message ${i} of the long forked conversation. MARKER_${i}_content_`;
        const tail = `TAIL_${i}_end`;
        const core = (head + " " + filler.repeat(Math.ceil(charsPerMessage / filler.length))).slice(0, charsPerMessage - tail.length - 1);
        msgs.push({ role, content: `${core} ${tail}` });
    }
    return msgs;
}

test("e2e: extreme-overflow fresh session folds with zero summarization calls; moderate overflow keeps the LLM path", async () => {
    const calls: Array<{ stream: boolean; body: string }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary",
                    type: "message",
                    role: "assistant",
                    model: "claude-small",
                    content: [{ type: "text", text: SUMMARY_TEXT }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: 24_000 } } } },
        modelContextLimit: 24_000,
        kernelConfig: defaultConfig(24_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;

    try {
        // --- Scenario A: fork-shaped fresh session, ~25x the window ---
        // 60 messages x 32k chars ~= 480k estimated tokens (~20x the 24k window,
        // well past the 19.2x coverage bound). At this window the walk folds
        // EVERY message to a digest (each digest still costs ~hundreds of
        // tokens; the kernel anchor keeps the first message resident) — the
        // same convergence shape as production, where a 21.2x-overflow against
        // a LARGE window folds down to digests and starts.
        const markA = calls.length;
        const rA = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "emg-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(60, 32_000) }),
        });
        const bodyA = await rA.text();
        assert.equal(rA.status, 200, `the extreme-overflow request succeeds (converges, no fail-fast); body: ${bodyA.slice(0, 500)}`);

        const callsA = calls.slice(markA);
        assert.equal(callsA.filter((c) => !c.stream).length, 0, "#2383 regression: NO summarization calls in the emergency regime");
        assert.equal(callsA.filter((c) => c.stream).length, 1, "exactly one forward");

        const sA = listSessions().find((x) => x.id === "emg-sess");
        const blocksA = (sA?.state.blocks ?? []).filter((b) => b.active);
        assert.ok(blocksA.length >= 1, `emergency folds created compression block(s) (got ${blocksA.length})`);
        assert.ok(blocksA.every((b) => b.summary.startsWith("[deterministic digest")),
            `all active blocks hold deterministic digests (got: ${blocksA[0]?.summary?.slice(0, 80)})`);

        const forwardA = callsA[callsA.length - 1];
        assert.ok(forwardA, "a forward happened");
        assert.ok(!forwardA.body.includes("TAIL_5_"), "mid-history message content is folded out of the payload");
        assert.ok(forwardA.body.includes("[deterministic digest"), "the digest summaries ride the rebuilt payload");

        // Restorability: applyRanges caches each new block's covered originals
        // verbatim (session.blockContents — the proxy-mode decompress source),
        // so a digest block is restorable exactly like any other fold.
        const cached = [...(sA?.blockContents?.values() ?? [])].map((c) => c.full.text).join("\n");
        assert.ok(cached.includes("MARKER_5_content_"), "folded originals are kept in the block-content cache");

        // --- Scenario B: fresh session at ~1.5x the window — LLM path unchanged ---
        const markB = calls.length;
        const rB = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "ctl-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(12, 12_000) }),
        });
        const bodyB = await rB.text();
        assert.equal(rB.status, 200, `the moderate-overflow request succeeds; body: ${bodyB.slice(0, 500)}`);

        const callsB = calls.slice(markB);
        const summaryCallsB = callsB.filter((c) => !c.stream);
        assert.ok(summaryCallsB.length >= 1, `below the coverage bound the LLM path still summarizes (got ${summaryCallsB.length})`);
        const sB = listSessions().find((x) => x.id === "ctl-sess");
        const blocksB = (sB?.state.blocks ?? []).filter((b) => b.active);
        assert.ok(blocksB.length >= 1, "LLM path created compression block(s)");
        assert.ok(blocksB.every((b) => b.summary === SUMMARY_TEXT), "blocks hold the upstream-written summaries");
        const forwardB = callsB[callsB.length - 1];
        assert.ok(forwardB.body.includes(SUMMARY_TEXT), "the preflight summary is in the rebuilt payload");
        assert.ok(!forwardB.body.includes("[deterministic digest"), "no digest artifacts below the coverage bound");
    } finally {
        proxy.close();
        upstream.close();
    }
});

test("deterministicDigest: deterministic, self-describing, head fragments included", () => {
    const entries = [
        { ref: "m00001", label: "user", text: "hello world " + "x".repeat(100) },
        { ref: "m00002", label: "assistant tool-call bash", text: "ls -la " + "y".repeat(200) },
    ];
    const opts = { maxSummary: 20_000, minSummaryLength: 50, shrinkBound: 100_000, countText: (t: string) => t.length };
    const a = deterministicDigest(entries, "m00001", "m00002", opts);
    const b = deterministicDigest(entries, "m00001", "m00002", opts);
    assert.equal(a, b, "byte-stable for identical input");
    assert.ok(a.startsWith("[deterministic digest m00001:m00002]"));
    assert.ok(a.includes("2 message(s)"));
    assert.ok(a.includes("[m00001 user]"));
    assert.ok(a.includes("ch :: hello world"), "head fragment present in form A");
});

test("deterministicDigest: falls back through forms until both bounds fit", () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
        ref: `m${String(i + 1).padStart(5, "0")}`,
        label: "user",
        text: "z".repeat(1000),
    }));
    const out = deterministicDigest(entries, "m00001", "m00008", {
        maxSummary: 300, minSummaryLength: 50, shrinkBound: 300, countText: (t: string) => t.length,
    });
    assert.ok(out.length <= 300, `form fits maxSummaryLength (got ${out.length})`);
    assert.ok(out.startsWith("[deterministic digest m00001:m00008]"));
    assert.ok(!out.includes("[m00001 user]"), "per-entry lines were dropped");
    assert.ok(out.includes("Structure:"), "#4224: structural conclusion survives when per-entry lines drop");
});

test("deterministicDigest: #4224 dynamic head trimming keeps short excerpts for large spans", () => {
    const entries = Array.from({ length: 150 }, (_, i) => ({
        ref: `m${String(10000 + i).padStart(5, "0")}`,
        label: "assistant tool-call bash",
        text: `echo hello world number ${i} ` + "x".repeat(200),
    }));
    const out = deterministicDigest(entries, "m10000", "m10149", {
        maxSummary: 20_000, minSummaryLength: 50, shrinkBound: 100_000, countText: (t: string) => t.length,
    });
    assert.ok(out.length <= 20_000, `digest fits maxSummaryLength (got ${out.length})`);
    assert.ok(out.includes("Structure:"), "structural conclusion present");
    assert.ok(out.includes("×bash"), "tool verb counted in structure");
    assert.ok(out.includes(":: "), "per-entry excerpts present (not dropped entirely)");
    const headMatch = / :: (.+?)(?:\n|$)/.exec(out.split("\n").find((l) => l.includes(":: ")) ?? "");
    assert.ok(headMatch && headMatch[1].length < 120, `head trimmed below 120 chars (got ${headMatch?.[1]?.length})`);
});

test("deterministicDigest: #4224 structure counts merge a tool call with its result under one verb", () => {
    const entries = [
        { ref: "m00001", label: "assistant tool-call bash", text: "ls -la" },
        { ref: "m00002", label: "tool result bash", text: "total 8" },
        { ref: "m00003", label: "assistant tool-call read", text: "path/a.ts" },
        { ref: "m00004", label: "tool result read", text: "const x = 1;" },
        { ref: "m00005", label: "user", text: "go" },
    ];
    const out = deterministicDigest(entries, "m00001", "m00005", {
        maxSummary: 20_000, minSummaryLength: 50, shrinkBound: 100_000, countText: (t: string) => t.length,
    });
    const struct = out.split("\n").find((l) => l.startsWith("Structure:"));
    assert.ok(struct, "structure line present");
    assert.ok(struct.includes("2\u00d7bash"), `bash call and its result merged under one verb (got: ${struct})`);
    assert.ok(struct.includes("2\u00d7read"), `read call and its result merged under one verb (got: ${struct})`);
    assert.ok(struct.includes("1\u00d7user"), `plain role kept as-is (got: ${struct})`);
    assert.ok(!struct.includes("tool result"), "no raw 'tool result <verb>' category leaks into the counts");
});

test("deterministicDigest: extreme bounds still fall back to header-only", () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
        ref: `m${String(i + 1).padStart(5, "0")}`,
        label: "user",
        text: "z".repeat(1000),
    }));
    const out = deterministicDigest(entries, "m00001", "m00008", {
        maxSummary: 240, minSummaryLength: 50, shrinkBound: 240, countText: (t: string) => t.length,
    });
    assert.ok(out.length <= 240, `header-only form fits (got ${out.length})`);
    assert.ok(out.startsWith("[deterministic digest m00001:m00008]"));
    assert.ok(!out.includes("\n"), "structure line also dropped at extreme bounds");
});

test("deterministicDigest: pathological bounds yield a padded marker at the minimum length", () => {
    const out = deterministicDigest([], "m00001", "m00010", {
        maxSummary: 100, minSummaryLength: 50, shrinkBound: 80, countText: (t: string) => t.length,
    });
    const marker = "[deterministic digest m00001:m00010]";
    assert.ok(out.startsWith(marker));
    assert.equal(out.length, 50, "padded up to compress.minSummaryLength");
});
