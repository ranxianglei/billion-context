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

// Issue #1800: on bytes-billing upstreams (unknown hosts), the conservative
// base64/4 image estimate overstates real image cost. When images ALONE push
// the payload estimate over the window while the TEXT portion fits, the old
// #496 arbitration branch did `return prepared` UNCONDITIONALLY — skipping
// preflightCompress entirely and recording no compression state. Result: the
// text portion was never folded even though it was compressible, so
// auto-compression stayed permanently disabled for image sessions (the issue's
// session logged preflightCompress ran 0 times across the whole session).
//
// Fix under test: the arbitration branch must still fold the compressible
// TEXT portion when ranges exist, and only short-circuit (forward-for-the-
// upstream-to-arbitrate) when there is genuinely nothing to fold. The image
// rides along byte-exact either way.
//
// Conventions copied from tests/issue857-image-baseline.test.ts (mock Responses
// upstream + startServer e2e). Window 200K; one screenshot whose BYTES-mode
// cost (b64/4) alone exceeds the window so no amount of text folding can make
// the payload fit — forcing the post-compress image-arbitration forward.
// #1843 made auto resolve to pixels for every host, so this scenario pins
// imageBilling:"bytes" explicitly — the conservative over-estimate class that
// still exists as an opt-in and is exactly what the arbitration path serves.

const WINDOW = 200_000;
const MODEL = "llama-flash-1800";
const IMAGE_TOKENS_TARGET = 210_000;
const IMG_PAD = IMAGE_TOKENS_TARGET * 4 - 32;

function pngB64(w: number, h: number, padChars: number): string {
    const b = Buffer.alloc(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b.toString("base64") + "A".repeat(padChars);
}

interface MockStats { streamingForwards: number; imagesSeen: number; summaryCalls: number }

function startMockUpstream(): Promise<{ server: http.Server; port: number; stats: MockStats }> {
    const stats: MockStats = { streamingForwards: 0, imagesSeen: 0, summaryCalls: 0 };
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { parsed = {}; }
            if (parsed.stream === false) {
                stats.summaryCalls += 1;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ output_text: "PREFLIGHT SUMMARY: folded segment." }));
                return;
            }
            stats.streamingForwards += 1;
            stats.imagesSeen += (raw.match(/"input_image"/g) ?? []).length;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(`event: response.completed\ndata: ${JSON.stringify({ response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: 1000, output_tokens: 5, total_tokens: 1005 } } })}\n\n`);
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return new Promise((resolve) => {
        server.on("listening", () => resolve({ server, port: (server.address() as { port: number }).port, stats }));
    });
}

async function startProxy(upstreamPort: number): Promise<{ proxy: http.Server; port: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: WINDOW } }, imageBilling: "bytes" } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
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
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxy, port: (proxy.address() as { port: number }).port };
}

function body(sessionId: string, input: unknown[]): string {
    return JSON.stringify({ model: MODEL, stream: true, store: false, session_id: sessionId, instructions: "You are the test coding agent.", input, max_output_tokens: 1024 });
}

function fillerHistory(n: number): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push({ type: "message", role: i % 2 ? "assistant" : "user", content: `MARKER_${i}: ${"lorem ipsum dolor sit amet ".repeat(400)}` });
    return out;
}

function imageInput(): unknown[] {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: "screenshot attached" }, { type: "input_image", image_url: `data:image/png;base64,${pngB64(1653, 2339, IMG_PAD)}` }] }];
}

test("#1800: image-dominated estimate with compressible text still folds the text portion (and forwards)", async () => {
    const { server: upstream, port: uport, stats } = await startMockUpstream();
    const { proxy, port } = await startProxy(uport);
    try {
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${uport}/v1/responses`;
        const headers = { "content-type": "application/json" };

        // Turn 1: small text-only turn establishes a sub-window usage baseline
        // (lastInputTokens=1000, source="usage") → noOverflowEvidence=true.
        const r1 = await fetch(url, { method: "POST", headers, body: body("s1800a", [{ type: "message", role: "user", content: "hello there" }]) });
        assert.equal(r1.status, 200);
        await r1.text();

        // Turn 2: enough filler history to create compressible ranges, plus one
        // screenshot whose bytes-mode cost (~210K tokens) ALONE exceeds the
        // 200K window → payloadEstimate over, textEstimate under.
        const r2 = await fetch(url, { method: "POST", headers, body: body("s1800a", [...fillerHistory(60), ...imageInput()]) });
        assert.equal(r2.status, 200, "the image-dominated payload forwards (for the upstream to arbitrate billing), not 502");
        await r2.text();

        // THE TOOTH: preflightCompress actually RAN and spent summarization
        // calls folding the compressible text portion. Before the fix the old
        // branch returned `prepared` before reaching preflightCompress, so
        // summaryCalls was 0 and auto-compression stayed permanently disabled.
        assert.ok(stats.summaryCalls >= 1, `preflight folded the compressible text portion (got ${stats.summaryCalls} summarization calls)`);
        assert.ok(stats.imagesSeen >= 1, "the screenshot rode along byte-exact through the folded forward");
    } finally {
        upstream.close();
        proxy.close();
    }
});
