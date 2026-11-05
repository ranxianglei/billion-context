import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { parseImageTokenCap, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import {
    PIXEL_IMAGE_FALLBACK_TOKENS,
    REMOTE_IMAGE_TOKENS,
    decodeImageDims,
    imageTokensInParsedBody,
    imageTokensInRawBody,
    pixelTileEstimate,
    resolveImageBilling,
} from "../src/image-tokens.ts";

// Issue #767 (follow-up to #496/#500): on pixel-tile billing upstreams (official
// Codex/OpenAI), the default base64/4 image cost overestimates real tile billing
// by orders of magnitude. When a session's historical lastInputTokens baseline
// already sits above the window, that overestimate closes BOTH safe-forward paths
// at once (#496 forward-once requires a sub-window baseline; #300 stale-baseline
// fit requires payloadEstimate < limit) → a persistent 502 loop even though the
// images bill only a few thousand tokens. Fix: per-provider `imageBilling`
// ("pixels" | "bytes", env BILI_IMAGE_BILLING overrides both) charges by a
// dimension-based tile model instead of raw bytes; bytes stays the conservative
// default so byte-counting relays keep #488/#496 protection intact.

const WINDOW = 272_000; // gpt-6-astra effective limit from the issue
const STALE_BASELINE = 696_789; // the reported stuck lastInputTokens

function pngB64(w: number, h: number, padChars = 0): string {
    const b = Buffer.alloc(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b.toString("base64") + "A".repeat(padChars);
}

function gifB64(w: number, h: number): string {
    const b = Buffer.alloc(13);
    b.write("GIF89a", 0, "ascii");
    b.writeUInt16LE(w, 6);
    b.writeUInt16LE(h, 8);
    return b.toString("base64");
}

function bmpB64(w: number, h: number): string {
    const b = Buffer.alloc(26);
    b.write("BM", 0, "ascii");
    b.writeUInt32LE(26, 2);
    b.writeUInt32LE(26, 10);
    b.writeUInt32LE(40, 14);
    b.writeInt32LE(w, 18);
    b.writeInt32LE(h, 22);
    return b.toString("base64");
}

function webpVp8B64(w: number, h: number): string {
    const b = Buffer.alloc(32);
    b.write("RIFF", 0, "ascii");
    b.writeUInt32LE(32 - 8, 4);
    b.write("WEBP", 8, "ascii");
    b.write("VP8 ", 12, "ascii");
    b.writeUInt32LE(12, 16);
    b[20] = 0x30;
    b[21] = 0x00;
    b[22] = 0x00;
    b[23] = 0x9d;
    b[24] = 0x01;
    b[25] = 0x2a;
    b.writeUInt16LE(w, 26);
    b.writeUInt16LE(h, 28);
    return b.toString("base64");
}

function webpVp8lB64(w: number, h: number): string {
    const wm = w - 1, hm = h - 1;
    const b = Buffer.alloc(32);
    b.write("RIFF", 0, "ascii");
    b.writeUInt32LE(32 - 8, 4);
    b.write("WEBP", 8, "ascii");
    b.write("VP8L", 12, "ascii");
    b.writeUInt32LE(12, 16);
    b[20] = 0x2f;
    b[21] = wm & 0xff;
    b[22] = ((wm >> 8) & 0x3f) | ((hm & 0x3) << 6);
    b[23] = (hm >> 2) & 0xff;
    b[24] = (hm >> 10) & 0x0f;
    return b.toString("base64");
}

function webpVp8xB64(w: number, h: number): string {
    const b = Buffer.alloc(32);
    b.write("RIFF", 0, "ascii");
    b.writeUInt32LE(32 - 8, 4);
    b.write("WEBP", 8, "ascii");
    b.write("VP8X", 12, "ascii");
    b.writeUInt32LE(10, 16);
    b[20] = 0x00;
    b[24] = (w - 1) & 0xff;
    b[25] = ((w - 1) >> 8) & 0xff;
    b[26] = ((w - 1) >> 16) & 0xff;
    b[27] = (h - 1) & 0xff;
    b[28] = ((h - 1) >> 8) & 0xff;
    b[29] = ((h - 1) >> 16) & 0xff;
    return b.toString("base64");
}

function jpegB64(w: number, h: number): string {
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]);
    const dims = Buffer.alloc(4);
    dims.writeUInt16BE(h, 0);
    dims.writeUInt16BE(w, 2);
    const b = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from([0xff, 0xe0, 0x00, 0x10]),
        Buffer.alloc(14),
        Buffer.from([0xff, 0xe1, 0x01, 0x00]),
        Buffer.alloc(254),
        sof,
        dims,
        Buffer.alloc(4, 0x00),
    ]);
    return b.toString("base64");
}

test("#767 unit: decodeImageDims parses container headers without full decode", () => {
    assert.deepEqual(decodeImageDims(pngB64(2048, 1536)), { w: 2048, h: 1536 });
    assert.deepEqual(decodeImageDims(gifB64(320, 240)), { w: 320, h: 240 });
    assert.deepEqual(decodeImageDims(bmpB64(640, 480)), { w: 640, h: 480 });
    assert.deepEqual(decodeImageDims(webpVp8B64(1280, 720)), { w: 1280, h: 720 });
    assert.deepEqual(decodeImageDims(webpVp8lB64(1000, 800)), { w: 1000, h: 800 });
    assert.deepEqual(decodeImageDims(webpVp8xB64(300, 200)), { w: 300, h: 200 });
    assert.deepEqual(decodeImageDims(jpegB64(512, 384)), { w: 512, h: 384 }, "JPEG dims found behind APP0+EXIF padding");
    assert.equal(decodeImageDims("A".repeat(64)), undefined, "unparsable garbage falls back to flat cost");
    assert.equal(decodeImageDims(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")), undefined, "truncated header → fallback");
});

test("#767 unit: pixelTileEstimate matches the OpenAI high-detail tile model", () => {
    assert.equal(pixelTileEstimate(100, 100), 765, "small square scales up to 768×768 = 4 tiles");
    assert.equal(pixelTileEstimate(2048, 2048), 2805, "max-size square = 16 tiles (the ceiling)");
    assert.equal(pixelTileEstimate(3584, 1024), 1445, "long side capped at 2048 → 4×2 tiles");
    assert.equal(pixelTileEstimate(1000, 200), 765, "double scale: up short side, then cap long side");
});

test("#767 unit: resolveImageBilling — explicit bytes wins, everything else resolves to pixels (#1843)", () => {
    assert.equal(resolveImageBilling("pixels", undefined), "pixels");
    assert.equal(resolveImageBilling("bytes", "https://api.openai.com/v1"), "bytes");
    assert.equal(resolveImageBilling(undefined, "https://api.openai.com/v1"), "pixels");
    assert.equal(resolveImageBilling("auto", "https://chatgpt.com/backend-api/codex/responses"), "pixels");
    assert.equal(resolveImageBilling("auto", "mitm://chatgpt.com/backend-api/codex/responses"), "pixels");
    assert.equal(resolveImageBilling("auto", "https://api.anthropic.com/v1/messages"), "pixels");
    assert.equal(resolveImageBilling("auto", "https://westus2.openai.azure.com/openai/v1"), "pixels");
    // #1843 L2: the host whitelist is gone — unknown hosts used to fall back to
    // base64/4 (the #1800 incident's 15× poison); they now get the pixel prior.
    assert.equal(resolveImageBilling("auto", "https://open.bigmodel.cn/api/paas/v4"), "pixels");
    assert.equal(resolveImageBilling("auto", "https://evil-openai.com/v1"), "pixels");
    assert.equal(resolveImageBilling("auto", undefined), "pixels");
    assert.equal(resolveImageBilling("auto", "not-a-url"), "pixels");
});

test("#767 unit: parsed-body costs — pixels vs bytes, fallback, remote URLs, cap", () => {
    const big = pngB64(2048, 1536, 600_000);
    const body = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: `data:image/png;base64,${big}` }] }] };
    const bytesCost = Math.ceil(big.length / 4);
    assert.ok(bytesCost > WINDOW / 2, "fixture really overflows the window under byte billing");
    assert.equal(imageTokensInParsedBody("responses", body, "bytes"), bytesCost);
    // 2048×1536 → tiles ceil(2048/512)*ceil(1536/512) = 4*3 = 12 → 85 + 170*12
    assert.equal(imageTokensInParsedBody("responses", body, "pixels"), 85 + 170 * 12);

    const remote = { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/screenshot.png" }] }] };
    assert.equal(imageTokensInParsedBody("responses", remote, "pixels"), REMOTE_IMAGE_TOKENS);
    assert.equal(imageTokensInParsedBody("responses", remote, "bytes"), REMOTE_IMAGE_TOKENS);

    const unknownFmt = { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(4000)}` }] }] };
    assert.equal(imageTokensInParsedBody("responses", unknownFmt, "pixels"), PIXEL_IMAGE_FALLBACK_TOKENS);
    assert.equal(imageTokensInParsedBody("responses", unknownFmt, "bytes"), 1000);

    process.env.BILI_IMAGE_TOKEN_CAP = "500";
    try {
        assert.equal(imageTokensInParsedBody("responses", body, "pixels"), 500, "cap clamps pixels mode too");
        assert.equal(imageTokensInParsedBody("responses", body, "bytes"), 500);
        assert.equal(imageTokensInParsedBody("responses", body, "pixels", 300), 500, "#1843 L3: env cap takes precedence over the config cap (any value)");
    } finally {
        delete process.env.BILI_IMAGE_TOKEN_CAP;
    }
    // #1843 L3: the config-level cap (route/global imageTokenCap) threads through
    // the same seam and applies with no env set.
    assert.equal(imageTokensInParsedBody("responses", body, "pixels", 500), 500, "config cap clamps pixels mode");
    assert.equal(imageTokensInParsedBody("responses", body, "bytes", 200), 200, "config cap clamps bytes mode");
    assert.equal(imageTokensInParsedBody("responses", body, "pixels", 0), 85 + 170 * 12, "cap of 0 means no cap (unset)");
});

test("#1843 unit: parseImageTokenCap — positive integer only, lenient", () => {
    assert.equal(parseImageTokenCap(500), 500);
    assert.equal(parseImageTokenCap(0), undefined);
    assert.equal(parseImageTokenCap(-5), undefined);
    assert.equal(parseImageTokenCap(1.5), undefined);
    assert.equal(parseImageTokenCap("500"), undefined);
    assert.equal(parseImageTokenCap(null), undefined);
    assert.equal(parseImageTokenCap(undefined), undefined);
});

test("#767 unit: raw-body probe honors the billing mode", () => {
    const big = pngB64(3584, 1024, 600_000);
    const raw = JSON.stringify({ input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${big}` }] }] });
    assert.equal(imageTokensInRawBody("responses", raw, "pixels"), 1445);
    assert.ok(imageTokensInRawBody("responses", raw, "bytes") > WINDOW / 2);
    assert.equal(imageTokensInRawBody("responses", JSON.stringify({ input: [] }), "pixels"), 0);
});

type MockStats = { streamingForwards: number; imagesSeen: number; summaryCalls: number };

function startMockUpstream(onStream?: (raw: string) => void): Promise<{ server: http.Server; port: number; stats: MockStats }> {
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
            onStream?.(raw);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(`event: response.completed\ndata: ${JSON.stringify({ response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: 6617, output_tokens: 5, total_tokens: 6622 } } })}\n\n`);
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return new Promise((resolve) => {
        server.on("listening", () => resolve({ server, port: (server.address() as { port: number }).port, stats }));
    });
}

async function startProxy(upstreamPort: number, routeExtra: Record<string, unknown> = {}, routeKey?: string): Promise<{ proxy: http.Server; port: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [routeKey ?? `http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-astra": { context: WINDOW } }, ...routeExtra } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
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
    return { proxy, port: (proxy.address() as { port: number }).port };
}

function imageTurn(sessionId: string): string {
    const img = (w: number, h: number) => ({ type: "input_image", image_url: `data:image/png;base64,${pngB64(w, h, 600_000)}` });
    return JSON.stringify({
        model: "gpt-astra",
        stream: true,
        store: false,
        session_id: sessionId,
        instructions: "You are the test coding agent.",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "two screenshots attached" }, img(3584, 1024), img(3584, 1024)] }],
        max_output_tokens: 1024,
    });
}

test("e2e #767: pixels billing recovers a stale-baseline session the bytes estimate bricks", async () => {
    const { server: upstream, port: upstreamPort, stats } = await startMockUpstream();
    const { proxy, port: proxyPort } = await startProxy(upstreamPort, { imageBilling: "pixels" });
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;
        const headers = { "content-type": "application/json" };

        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "gpt-astra", stream: true, store: false, session_id: "img-pix-sess", instructions: "You are the test coding agent.", input: [{ type: "message", role: "user", content: "hello there" }], max_output_tokens: 1024 }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        const s = listSessions().find((x) => x.meta.label === "img-pix-sess");
        assert.ok(s, "session established");
        s!.stats.lastInputTokens = STALE_BASELINE;

        const r2 = await fetch(url, { method: "POST", headers, body: imageTurn("img-pix-sess") });
        assert.equal(r2.status, 200, "stale baseline no longer bricks pixel-billing payloads");
        await r2.text();
        assert.equal(stats.streamingForwards, 2, "both turns were forwarded");
        assert.equal(stats.imagesSeen, 2, "both screenshots reached the upstream verbatim");

        const after = listSessions().find((x) => x.meta.label === "img-pix-sess")!;
        assert.ok(after.stats.lastInputTokens > 0 && after.stats.lastInputTokens < WINDOW, `baseline recovered to real usage (got ${after.stats.lastInputTokens})`);

        const r3 = await fetch(url, { method: "POST", headers, body: imageTurn("img-pix-sess") });
        assert.equal(r3.status, 200, "steady state keeps working after recovery");
        await r3.text();
        assert.equal(stats.streamingForwards, 3);
        assert.equal(stats.imagesSeen, 4);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

// #1843: auto no longer resolves to bytes on unknown hosts, so the relay-
// protection control pins the explicit opt-in mode that still carries it.
test("e2e #767 control: explicit bytes route still fails fast — relay protection intact", async () => {
    const { server: upstream, port: upstreamPort, stats } = await startMockUpstream();
    const { proxy, port: proxyPort } = await startProxy(upstreamPort, { imageBilling: "bytes" });
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;
        const headers = { "content-type": "application/json" };

        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "gpt-astra", stream: true, store: false, session_id: "img-byt-sess", instructions: "You are the test coding agent.", input: [{ type: "message", role: "user", content: "hello there" }], max_output_tokens: 1024 }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        const s = listSessions().find((x) => x.meta.label === "img-byt-sess");
        assert.ok(s);
        s!.stats.lastInputTokens = STALE_BASELINE;

        const r2 = await fetch(url, { method: "POST", headers, body: imageTurn("img-byt-sess") });
        // #3461: structurally doomed (byte-billed images can't fold enough) → 413.
        assert.equal(r2.status, 413, "byte-billed over-window images stay blocked locally");
        const err2 = JSON.parse(await r2.text()) as { error?: { code?: string; message?: string } };
        assert.equal(err2.error?.code, "preflight_compress_failed");
        assert.ok(err2.error?.message?.includes("Images alone account for"), "fail-fast carries the image remedy wording");
        assert.equal(stats.streamingForwards, 1, "only the text-only turn was ever forwarded");
        assert.equal(stats.imagesSeen, 0, "over-window images never reached the upstream");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

// #1843 L2: the DEFAULT route (no imageBilling configured) now resolves to the
// pixel prior on unknown hosts. The same stale-baseline scenario that the
// explicit-bytes control above still blocks must now forward: two 600k-base64
// screenshots bill 2 × 1,445 = 2,890 tokens (not 300,002), so the payload fits
// the window and the session recovers to real usage instead of 502-looping.
test("e2e #1843: default route (auto→pixels) forwards an image-heavy payload the bytes estimate would brick", async () => {
    const { server: upstream, port: upstreamPort, stats } = await startMockUpstream();
    const { proxy, port: proxyPort } = await startProxy(upstreamPort);
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;
        const headers = { "content-type": "application/json" };

        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "gpt-astra", stream: true, store: false, session_id: "img-auto-sess", instructions: "You are the test coding agent.", input: [{ type: "message", role: "user", content: "hello there" }], max_output_tokens: 1024 }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        const s = listSessions().find((x) => x.meta.label === "img-auto-sess");
        assert.ok(s, "session established");
        s!.stats.lastInputTokens = STALE_BASELINE;

        const r2 = await fetch(url, { method: "POST", headers, body: imageTurn("img-auto-sess") });
        assert.equal(r2.status, 200, "default-route image payload fits on the pixel prior and forwards (#1843 de-poisoning)");
        await r2.text();
        assert.equal(stats.streamingForwards, 2, "both turns were forwarded");
        assert.equal(stats.imagesSeen, 2, "both screenshots reached the upstream verbatim");

        const after = listSessions().find((x) => x.meta.label === "img-auto-sess")!;
        assert.ok(after.stats.lastInputTokens > 0 && after.stats.lastInputTokens < WINDOW, `baseline recovered to real usage (got ${after.stats.lastInputTokens})`);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e #767: learned-limit-only variant also closes forward-once (explicit bytes route)", async () => {
    const { server: upstream, port: upstreamPort, stats } = await startMockUpstream();
    const { proxy, port: proxyPort } = await startProxy(upstreamPort, { imageBilling: "bytes" });
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;
        const headers = { "content-type": "application/json" };

        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "gpt-astra", stream: true, store: false, session_id: "img-lrn-sess", instructions: "You are the test coding agent.", input: [{ type: "message", role: "user", content: "hello there" }], max_output_tokens: 1024 }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        const s = listSessions().find((x) => x.meta.label === "img-lrn-sess");
        assert.ok(s);
        assert.ok(s!.stats.lastInputTokens < WINDOW, "baseline is fresh here");
        // #987 removed the window learner; the equivalent usage-grounded
        // evidence (what an overflow 400's arm leaves behind) closes the gate.
        (s!.stats as { lastInputTokens: number }).lastInputTokens = WINDOW;
        (s!.stats as { lastInputTokensSource: string }).lastInputTokensSource = "usage";

        const r2 = await fetch(url, { method: "POST", headers, body: imageTurn("img-lrn-sess") });
        // #3461: structurally doomed (byte-billed images can't fold enough) → 413.
        assert.equal(r2.status, 413, "overflow evidence (learned limit) closes #496 forward-once even with a fresh baseline");
        const err2 = JSON.parse(await r2.text()) as { error?: { code?: string } };
        assert.equal(err2.error?.code, "preflight_compress_failed");
        assert.equal(stats.streamingForwards, 1, "image-bearing turn was never forwarded");
        assert.equal(stats.imagesSeen, 0);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e #767: env BILI_IMAGE_BILLING beats per-provider route config", async () => {
    const { server: upstream, port: upstreamPort, stats } = await startMockUpstream();
    const { proxy, port: proxyPort } = await startProxy(upstreamPort, { imageBilling: "pixels" });
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;
        const headers = { "content-type": "application/json" };

        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "gpt-astra", stream: true, store: false, session_id: "img-env-sess", instructions: "You are the test coding agent.", input: [{ type: "message", role: "user", content: "hello there" }], max_output_tokens: 1024 }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        const s = listSessions().find((x) => x.meta.label === "img-env-sess");
        assert.ok(s);
        s!.stats.lastInputTokens = STALE_BASELINE;

        process.env.BILI_IMAGE_BILLING = "bytes";
        let r2: Response;
        try {
            r2 = await fetch(url, { method: "POST", headers, body: imageTurn("img-env-sess") });
        } finally {
            delete process.env.BILI_IMAGE_BILLING;
        }
        // #3461: structurally doomed (byte-billed images can't fold enough) → 413.
        assert.equal(r2.status, 413, "env override downgrades the pixels route back to conservative byte billing");
        const err2 = JSON.parse(await r2.text()) as { error?: { code?: string } };
        assert.equal(err2.error?.code, "preflight_compress_failed");
        assert.equal(stats.streamingForwards, 1);
        assert.equal(stats.imagesSeen, 0);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e #767: per-route imageBilling applies under a path-qualified provider key at every gate", async () => {
    const { server: upstream, port: upstreamPort, stats } = await startMockUpstream();
    const { proxy, port: proxyPort } = await startProxy(upstreamPort, { imageBilling: "pixels" }, `http://127.0.0.1:${upstreamPort}/v1`);
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;
        const headers = { "content-type": "application/json" };

        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "gpt-astra", stream: true, store: false, session_id: "img-path-sess", instructions: "You are the test coding agent.", input: [{ type: "message", role: "user", content: "hello there" }], max_output_tokens: 1024 }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        const s = listSessions().find((x) => x.meta.label === "img-path-sess");
        assert.ok(s, "session established");
        s!.stats.lastInputTokens = STALE_BASELINE;

        // Regression pin: origin-only route lookups missed this path-qualified key at the
        // preflight/clamp/guard gates (auto → bytes on a bare IP host → 502); every other
        // per-route setting resolves against route.rewrittenUrl instead.
        const r2 = await fetch(url, { method: "POST", headers, body: imageTurn("img-path-sess") });
        assert.equal(r2.status, 200, "path-qualified per-route override reaches the preflight gate");
        await r2.text();
        assert.equal(stats.streamingForwards, 2);
        assert.equal(stats.imagesSeen, 2);

        const after = listSessions().find((x) => x.meta.label === "img-path-sess")!;
        assert.ok(after.stats.lastInputTokens > 0 && after.stats.lastInputTokens < WINDOW, `baseline recovered to real usage (got ${after.stats.lastInputTokens})`);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
