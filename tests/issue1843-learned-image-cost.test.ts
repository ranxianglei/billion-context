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
import { getSession, listSessions, type Session } from "../src/session.ts";
import { countImagesInParsedBody, countImagesInRawBody, upstreamHost } from "../src/image-tokens.ts";
import { learnedImageReserve, noteForwardedImageFacts, settleUsageReport, type LearnedImageCostEntry } from "../src/cache-ledger.ts";

// Issue #1843 L1: the billing half of #1800. The prior image estimate can be
// off by up to 15x per image on non-OpenAI vision encoders; the upstream usage
// report is ground truth, so bili learns a per-route per-image cost from
// (billed input - text-side estimate of the same forwarded payload) and uses it
// as the image reserve in every window gate once fresh evidence exists.

const WINDOW = 10_000;

function pngB64(w: number, h: number, padChars = 0): string {
    const b = Buffer.alloc(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b.toString("base64") + "A".repeat(padChars);
}

test("#1843 unit: countImagesInParsedBody — all four wire shapes", () => {
    const anthropic = { messages: [{ role: "user", content: [
        { type: "text", text: "hi" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "image", source: { type: "url", url: "https://x/s.png" } },
    ] }] };
    assert.equal(countImagesInParsedBody("anthropic", anthropic), 2);
    assert.equal(countImagesInParsedBody("anthropic", { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }), 0);

    const openai = { messages: [{ role: "user", content: [
        { type: "text", text: "hi" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${pngB64(64, 64)}` } },
        { type: "file", file_id: "file-api-1" },
    ] }] };
    assert.equal(countImagesInParsedBody("openai", openai), 2);

    const responses = { input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "hi" },
        { type: "input_image", image_url: `data:image/png;base64,${pngB64(64, 64)}` },
    ] }] };
    assert.equal(countImagesInParsedBody("responses", responses), 1);
    assert.equal(countImagesInParsedBody("responses", { input: [] }), 0);

    const google = { contents: [{ parts: [
        { text: "hi" },
        { inlineData: { mimeType: "image/png", data: "AAAA" } },
        { fileData: { mimeType: "image/png", fileUri: "https://x/s.png" } },
    ] }] };
    assert.equal(countImagesInParsedBody("google", google), 2);
});

test("#1843 unit: countImagesInRawBody — cheap probe gate + parse failure safety", () => {
    const withImg = JSON.stringify({ input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${pngB64(64, 64)}` }] }] });
    assert.equal(countImagesInRawBody("responses", withImg), 1);
    assert.equal(countImagesInRawBody("responses", JSON.stringify({ input: [] })), 0, "no markers → no parse");
    assert.equal(countImagesInRawBody("responses", '{"input_image": broken'), 0, "unparseable probe hit stays 0");
});

test("#1843 unit: upstreamHost — hostname keying for per-route learning", () => {
    assert.equal(upstreamHost("https://api.openai.com/v1/chat"), "api.openai.com");
    assert.equal(upstreamHost("http://127.0.0.1:8199/v1/responses"), "127.0.0.1");
    assert.equal(upstreamHost(undefined), "unknown");
    assert.equal(upstreamHost("not-a-url"), "not-a-url");
});

test("#1843 unit: learning loop — EMA, invalidation by fp/TTL, cap application", () => {
    const s = getSession(`t-l1-${Math.random().toString(36).slice(2)}`);
    const host = "vision.example.com";

    noteForwardedImageFacts(s, { nImages: 2, textSide: 2000, host, fp: "bytes:0" });
    settleUsageReport(s, { total: 8000, reportedCached: null });
    let entry = s.metadata.learnedImageCosts as Record<string, LearnedImageCostEntry>;
    assert.ok(entry[host], "first sample learned");
    assert.equal(entry[host].cost, 3000, "(8000-2000)/2 first sample lands exactly");
    assert.equal(entry[host].seen, 1);

    noteForwardedImageFacts(s, { nImages: 2, textSide: 2000, host, fp: "bytes:0" });
    settleUsageReport(s, { total: 10_000, reportedCached: null });
    entry = s.metadata.learnedImageCosts as Record<string, LearnedImageCostEntry>;
    assert.equal(entry[host].cost, 3500, "EMA α=0.5: (3000+4000)/2");
    assert.equal(entry[host].seen, 2);

    assert.equal(learnedImageReserve(s, host, 2, "bytes:0", 0), 7000, "fresh match → learned x nImages");
    assert.equal(learnedImageReserve(s, host, 2, "bytes:0", 500), 1000, "cap still bounds the learned value per image");
    assert.equal(learnedImageReserve(s, host, 2, "pixels:0", 0), undefined, "billing reconfigured since learning → stale");
    assert.equal(learnedImageReserve(s, host, 0, "bytes:0", 0), undefined, "no images in payload → no reserve");
    assert.equal(learnedImageReserve(s, "other.host", 2, "bytes:0", 0), undefined, "different route → no evidence");

    entry[host] = { ...entry[host], ts: Date.now() - 25 * 60 * 60 * 1000 };
    assert.equal(learnedImageReserve(s, host, 2, "bytes:0", 0), undefined, "TTL (24h) expired → back to prior");
});

test("#1843 unit: out-of-band samples are rejected, never learned", () => {
    const s = getSession(`t-l1-reject-${Math.random().toString(36).slice(2)}`);
    // billed total below the text estimate → negative observation, no signal
    noteForwardedImageFacts(s, { nImages: 2, textSide: 20_000, host: "h1", fp: "bytes:0" });
    settleUsageReport(s, { total: 8000, reportedCached: null });
    assert.equal((s.metadata.learnedImageCosts ?? undefined), undefined, "negative observation skipped");

    // absurd per-image bill (> 1M) → gateway echo / placeholder, quarantine
    noteForwardedImageFacts(s, { nImages: 1, textSide: 0, host: "h1", fp: "bytes:0" });
    settleUsageReport(s, { total: 2_000_000, reportedCached: null });
    assert.equal((s.metadata.learnedImageCosts ?? undefined), undefined, "out-of-band sample quarantined");
});

type MockStats = { streamingForwards: number; imagesSeen: number; summaryCalls: number };

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
            // A believable vision encoder: ~3k tokens per screenshot on top of
            // whatever text rides along — NOT the 150k/image the bytes prior
            // claims for these fixtures.
            const inputTokens = raw.includes('"input_image"') ? 8000 : 6617;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(`event: response.completed\ndata: ${JSON.stringify({ response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } } })}\n\n`);
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return new Promise((resolve) => {
        server.on("listening", () => resolve({ server, port: (server.address() as { port: number }).port, stats }));
    });
}

async function startProxy(upstreamPort: number, routeExtra: Record<string, unknown> = {}): Promise<{ proxy: http.Server; port: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-astra": { context: WINDOW } }, ...routeExtra } },
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

function turn(sessionId: string, withImages: boolean): string {
    const content = withImages
        ? [{ type: "input_text", text: "two screenshots attached" }, { type: "input_image", image_url: `data:image/png;base64,${pngB64(3584, 1024, 600_000)}` }, { type: "input_image", image_url: `data:image/png;base64,${pngB64(3584, 1024, 600_000)}` }]
        : "hello there";
    return JSON.stringify({ model: "gpt-astra", stream: true, store: false, session_id: sessionId, instructions: "You are the test coding agent.", input: [{ type: "message", role: "user", content }], max_output_tokens: 1024 });
}

// The L1 rescue: an explicit-bytes route (the 15x poison class) where the prior
// bills each 600k-base64 screenshot at ~150k tokens. Turn 1 warms the baseline;
// turn 2's over-prior payload is arbitrated forward (#1801 path) and its usage
// report teaches the real per-image cost; after a stale-high usage baseline is
// stamped, turn 3 would fail-fast on the PRIOR (overflow evidence closes the
// arbitration hatch) but fits on the LEARNED reserve and forwards clean.
test("e2e #1843 L1: learned image cost rescues a session the bytes prior bricks", async () => {
    const { server: upstream, port: upstreamPort, stats } = await startMockUpstream();
    const { proxy, port: proxyPort } = await startProxy(upstreamPort, { imageBilling: "bytes" });
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;
        const headers = { "content-type": "application/json" };

        const r1 = await fetch(url, { method: "POST", headers, body: turn("img-lrn-sess", false) });
        assert.equal(r1.status, 200);
        await r1.text();

        const r2 = await fetch(url, { method: "POST", headers, body: turn("img-lrn-sess", true) });
        assert.equal(r2.status, 200, "over-prior payload arbitrated forward while no overflow evidence exists");
        await r2.text();
        assert.equal(stats.streamingForwards, 2);
        assert.equal(stats.imagesSeen, 2, "screenshots reached the upstream verbatim");

        const s = listSessions().find((x) => x.meta.label === "img-lrn-sess")!;
        const learned = s.metadata.learnedImageCosts as Record<string, LearnedImageCostEntry>;
        const entry = learned["127.0.0.1"];
        assert.ok(entry, "usage report landed in the per-route learned cost table");
        assert.ok(entry.seen >= 1);
        // billed 8000 - small text side, split over 2 screenshots: a few k per
        // image, nowhere near the 150k the bytes prior claims.
        assert.ok(entry.cost > 1500 && entry.cost < 5000, `learned per-image cost sane (got ${entry.cost})`);

        // Stamp the incident-class state: a usage-grounded baseline at the
        // window edge. With the bytes prior this now fail-fasts (arbitration
        // hatch closed by overflow evidence); the learned reserve must carry it.
        s.stats.lastInputTokens = WINDOW;
        s.stats.lastInputTokensSource = "usage";

        const r3 = await fetch(url, { method: "POST", headers, body: turn("img-lrn-sess", true) });
        assert.equal(r3.status, 200, "learned reserve replaces the 15x prior — the bricked session forwards");
        await r3.text();
        assert.equal(stats.streamingForwards, 3);
        assert.equal(stats.imagesSeen, 4);
        assert.equal(stats.summaryCalls, 0, "no folding was needed — text fit all along");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
