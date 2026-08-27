import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// Issue #280 regression (Responses protocol): a long Codex session that was
// compressed once, then rebound/restored — the client replays the FULL raw
// history to a fresh session whose lastInputTokens is 0. The nudge is blind at
// tokenCount=0, so only the preflight fit check (payload estimate vs window)
// can catch it. The proxy must compress the oversized history BEFORE forward,
// never replaying it verbatim to a smaller upstream window.

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. Key decisions: chose the preflight approach over lossy truncation because the payload must stay coherent. Files touched: src/a.ts:10, src/b.ts:20. Outcome: fixed and verified by tests.";

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}

function fcEvents(callId: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress" }, output_index: 0 }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress", arguments: args }, output_index: 0 }),
    ].join("");
}

function longInput() {
    const input: { type: string; role: string; content: string }[] = [];
    for (let i = 0; i < 12; i++) {
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return input;
}

test("e2e #280 (Responses): restored session with lastInputTokens=0 → preflight compresses the raw history before forward", async () => {
    let summaryCalls = 0;
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            const parsed = JSON.parse(raw) as { stream?: boolean };
            if (parsed.stream === false) {
                summaryCalls += 1;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ output_text: SUMMARY_TEXT }));
                return;
            }
            if (bodies.length === 1) {
                // Session A's first turn: the model compresses the oldest pair.
                // Refs are the kernel's sequential message refs (m00001...);
                // `instructions` becomes systemParts and consumes no ref.
                const compressArgs = JSON.stringify({
                    content: [
                        {
                            startId: "m00001",
                            endId: "m00002",
                            topic: "session setup",
                            summary: "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK",
                        },
                    ],
                });
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.write(fcEvents("call_p", compressArgs));
                res.write(completed(3000));
            } else {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.write(completed(1000));
            }
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-resp": { context: 10_000 } } } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;

    // Seven ~4.6k-char messages (~1140 tokens each, ~8k total < the 10k window,
    // so preflight stays off for session A). The kernel protects the last 5
    // messages (and the 5k-token tail), leaving m00001/m00002 compressible.
    function setupInput() {
        return Array.from({ length: 7 }, (_, i) => ({
            type: "message",
            role: i % 2 === 0 ? "user" : "assistant",
            content: `Message ${i} for session setup. ` + `FILLER_${i}_content_`.repeat(268),
        }));
    }

    try {
        // --- Session A: a normal session that compresses once (the original
        // long session before the rebind) ---
        const rA = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "resp-sess-a", instructions: "You are the test coding agent.", input: setupInput() }),
        });
        assert.equal(rA.status, 200);
        await rA.text();

        const sA = listSessions().find((x) => x.meta.label === "resp-sess-a");
        assert.ok(sA, "session A exists");
        assert.ok((sA!.state.blocks ?? []).some((b) => b.active), "session A compressed once");

        // --- Session B: the rebind/restore — a FRESH session (lastInputTokens=0)
        // receives the full raw history (~13k tokens > the 10k window). Preflight
        // must compress it before forward; the raw history must never be replayed
        // verbatim. ---
        const rB = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "resp-sess-b", instructions: "You are the test coding agent.", input: longInput() }),
        });
        assert.equal(rB.status, 200, "restored session's request succeeds");
        await rB.text();

        assert.ok(summaryCalls >= 1, `preflight summarization ran for the restored session (got ${summaryCalls})`);

        const finalForward = bodies[bodies.length - 1];
        // The kernel keeps the first user message raw (task anchor), so the
        // rest of the compressed range (markers 1-3) must be gone.
        assert.ok(!finalForward.includes("MARKER_1_"), "compressed range folded out of the forward");
        assert.ok(!finalForward.includes("MARKER_2_"), "compressed range folded out of the forward");
        assert.ok(!finalForward.includes("MARKER_3_"), "compressed range folded out of the forward");
        assert.ok(finalForward.includes("MARKER_11_"), "recent history survives");
        assert.ok(finalForward.includes(SUMMARY_TEXT), "the compression summary re-enters the payload");

        const sB = listSessions().find((x) => x.meta.label === "resp-sess-b");
        assert.ok(sB, "session B exists");
        assert.ok((sB!.state.blocks ?? []).some((b) => b.active), "session B has a compression block from preflight");
        assert.equal(sB!.stats.lastInputTokens, 1000, "the real usage report lands after the recovered forward");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
