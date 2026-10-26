import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import zlib from "node:zlib";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../../src/server.ts";
import type { ProxyOptions } from "../../src/config.ts";
import { SessionStore, _setStoreForTest } from "../../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../../src/registry.ts";
import { listSessions } from "../../src/session.ts";
import { decodeImageDims, pixelTileEstimate, resolveImageBilling } from "../../src/image-tokens.ts";

// #1843/#1857 real-image billing lane — the hermetic twin of the manual
// verification that cleared PR #1857 for merge. Everything a runner needs is
// synthesized here (no PIL/ImageMagick, no network, zero tokens): a corpus of
// structurally real images (valid container headers, real dimensions, real
// file sizes) is generated at runtime, pushed through the actual billing
// pipeline against a mock upstream that bills the Qwen2-VL formula, and the
// three failure classes that motivated #1857 are asserted end to end:
//
//   1. parser truth: decodeImageDims recovers the written dimensions for every
//      well-formed container, and malformed blobs stay clamped;
//   2. bytes-prior poison: a 4.7MB 4032x3024 photo bills >=700x its real
//      vision-encoder cost on a bytes route;
//   3. learned rescue: the arbitrated forward + usage report teach the real
//      per-image cost, which then carries a session a stale-high usage
//      baseline would otherwise brick; the default (auto->pixels) route never
//      needs rescuing.
//
// Run: npm run test:e2e:image  (CI: .github/workflows/ci-image.yml)

const WINDOW = 262_144;

// ---------------------------------------------------------------------------
// Corpus synthesis — deterministic (seeded PRNG), pure Node.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomBytes(len: number, seed: number): Buffer {
    const rnd = mulberry32(seed);
    const b = Buffer.alloc(len);
    for (let i = 0; i < len; i++) b[i] = Math.floor(rnd() * 256);
    return b;
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A structurally valid PNG. `fill` decides the pixel payload: "zeros" keeps
 *  the file tiny (billing reads dimensions, never pixels), "noise" produces an
 *  incompressible multi-MB body like a real screenshot. */
function makePng(w: number, h: number, fill: "zeros" | "noise", seed = 1): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 0; // grayscale
    const stride = 1 + w; // filter byte + samples
    const raw = fill === "noise" ? randomBytes(stride * h, seed) : Buffer.alloc(stride * h);
    return Buffer.concat([
        PNG_SIG,
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", zlib.deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

/** A JPEG whose SOF0 (near the head, like every real camera file — the
 *  decoder's scan window is ~260KB) carries the given dimensions, padded to
 *  `targetBytes` with COM segments of random payload. */
function makeJpeg(w: number, h: number, targetBytes: number, seed = 2, exifOrientation?: number): Buffer {
    const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]; // SOI
    if (exifOrientation !== undefined) {
        const tiff = Buffer.alloc(8 + 2 + 12 + 4);
        tiff.write("II", 0, "ascii");
        tiff.writeUInt16LE(0x2a, 2);
        tiff.writeUInt32LE(8, 4);
        tiff.writeUInt16LE(1, 8); // one IFD0 entry
        tiff.writeUInt16LE(0x0112, 10); // Orientation
        tiff.writeUInt16LE(3, 12); // SHORT
        tiff.writeUInt32LE(1, 14);
        tiff.writeUInt16LE(exifOrientation, 18);
        const app1Data = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
        const app1 = Buffer.alloc(4 + app1Data.length);
        app1[0] = 0xff; app1[1] = 0xe1;
        app1.writeUInt16BE(app1Data.length + 2, 2);
        app1Data.copy(app1, 4);
        parts.push(app1);
    }
    const sof = Buffer.alloc(2 + 11);
    sof[0] = 0xff; sof[1] = 0xc0;
    sof.writeUInt16BE(11, 2);
    sof[4] = 8; // precision
    sof.writeUInt16BE(h, 5);
    sof.writeUInt16BE(w, 7);
    sof[9] = 1; // components
    sof[10] = 1; sof[11] = 0x11; sof[12] = 0;
    parts.push(sof);
    const eoi = Buffer.from([0xff, 0xd9]);
    let used = parts.reduce((n, p) => n + p.length, 0) + eoi.length;
    const rnd = mulberry32(seed);
    while (targetBytes - used > 4) {
        const room = Math.min(65_533, targetBytes - used - 4);
        if (room < 2) break;
        const data = Buffer.alloc(room);
        for (let i = 0; i < room; i++) data[i] = Math.floor(rnd() * 256);
        const com = Buffer.alloc(4 + room);
        com[0] = 0xff; com[1] = 0xfe;
        com.writeUInt16BE(room + 2, 2);
        data.copy(com, 4);
        parts.push(com);
        used += com.length;
    }
    parts.push(eoi);
    return Buffer.concat(parts);
}

function makeGif(w: number, h: number): Buffer {
    const b = Buffer.alloc(13);
    b.write("GIF89a", 0, "ascii");
    b.writeUInt16LE(w, 6);
    b.writeUInt16LE(h, 8);
    b[10] = 0x70; // no GCT
    b[12] = 0x3b; // trailer
    return b;
}

/** A VP8L (lossless) WebP: 5-byte signature header carries the dims, junk
 *  payload pads the chunk so the container clears the 30-byte decode floor. */
function makeWebp(w: number, h: number): Buffer {
    const payload = Buffer.alloc(12);
    payload[0] = 0x2f; // VP8L signature
    const wm1 = (w - 1) & 0x3fff, hm1 = (h - 1) & 0x3fff;
    payload[1] = wm1 & 0xff;
    payload[2] = ((wm1 >> 8) & 0x3f) | ((hm1 & 0x03) << 6);
    payload[3] = (hm1 >> 2) & 0xff;
    payload[4] = (hm1 >> 10) & 0x0f;
    const riffSize = 4 + 8 + payload.length;
    const out = Buffer.alloc(8 + riffSize);
    out.write("RIFF", 0, "ascii");
    out.writeUInt32LE(riffSize, 4);
    out.write("WEBP", 8, "ascii");
    out.write("VP8L", 12, "ascii");
    out.writeUInt32LE(payload.length, 16);
    payload.copy(out, 20);
    return out;
}

interface Corpus {
    dir: string;
    files: Record<string, Buffer>;
    truth: { name: string; w: number; h: number }[];
}

function buildCorpus(): Corpus {
    const shot1080 = makePng(1920, 1080, "noise", 101);
    const shot4k = makePng(3840, 2160, "zeros");
    const photo = makeJpeg(4032, 3024, 4_700_000, 202);
    const webp = makeWebp(1280, 720);
    const icon = makePng(64, 64, "zeros");
    const favicon = makePng(16, 16, "zeros");
    const huge = makePng(6000, 4000, "zeros");
    const anim = makeGif(800, 600);
    const exif = makeJpeg(160, 120, 4_000, 203, 6);
    const truncated = shot1080.subarray(0, Math.floor(shot1080.length * 0.6));
    const garbage = Buffer.concat([PNG_SIG, randomBytes(20_000, 204)]);

    const files = {
        "shot-1080p.png": shot1080,
        "shot-4k.png": shot4k,
        "photo-4032.jpg": photo,
        "webp-720.webp": webp,
        "icon-64.png": icon,
        "favicon-16.png": favicon,
        "huge-6000x4000.png": huge,
        "anim-800x600.gif": anim,
        "exif-orient6.jpg": exif,
        "truncated.png": truncated,
        "garbage.png": garbage,
    };
    const dir = mkdtempSync(path.join(tmpdir(), "e2e-image-billing-"));
    for (const [name, buf] of Object.entries(files)) writeFileSync(path.join(dir, name), buf);
    return {
        dir,
        files,
        truth: [
            { name: "shot-1080p.png", w: 1920, h: 1080 },
            { name: "shot-4k.png", w: 3840, h: 2160 },
            { name: "photo-4032.jpg", w: 4032, h: 3024 },
            { name: "webp-720.webp", w: 1280, h: 720 },
            { name: "icon-64.png", w: 64, h: 64 },
            { name: "favicon-16.png", w: 16, h: 16 },
            { name: "huge-6000x4000.png", w: 6000, h: 4000 },
            { name: "anim-800x600.gif", w: 800, h: 600 },
            { name: "exif-orient6.jpg", w: 160, h: 120 },
            { name: "truncated.png", w: 1920, h: 1080 },
        ],
    };
}

const CORPUS = buildCorpus();
const b64 = (name: string): string => CORPUS.files[name].toString("base64");

// Qwen2-VL vision billing: ceil(w*h/784) per image — the "real encoder" the
// mock upstream charges. 4032x3024 -> 15551.
const qwenVl = (w: number, h: number) => Math.ceil((w * h) / 784);
const PHOTO_TRUTH = qwenVl(4032, 3024);

// ---------------------------------------------------------------------------
// Mock upstream: bills text as chars/3.5 plus the Qwen2-VL formula per image,
// reports usage on the final SSE chunk (openai chat wire).
// ---------------------------------------------------------------------------

interface UpStats { forwards: number; images: number; bodies: number[]; }

function startMockUpstream(): Promise<{ server: http.Server; port: number; stats: UpStats }> {
    const stats: UpStats = { forwards: 0, images: 0, bodies: [] };
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            stats.forwards += 1;
            stats.bodies.push(body.length);
            let parsed: { messages?: unknown[] } = {};
            try { parsed = JSON.parse(body.toString("utf8")); } catch { /* bill as text */ }
            let nImg = 0, textChars = 0;
            const walk = (x: unknown): void => {
                if (!x || typeof x !== "object") {
                    if (typeof x === "string") textChars += x.length;
                    return;
                }
                if (Array.isArray(x)) { x.forEach(walk); return; }
                const o = x as Record<string, unknown>;
                if (o.type === "image_url" || o.type === "input_image" || o.type === "image") { nImg += 1; return; }
                Object.values(o).forEach(walk);
            };
            walk(parsed.messages ?? []);
            stats.images += nImg;
            const input = Math.round(textChars / 3.5) + nImg * PHOTO_TRUTH;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "gpt-astra", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "gpt-astra", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: input, completion_tokens: 5, total_tokens: input + 5 } })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return new Promise((resolve) => server.on("listening", () => resolve({ server, port: (server.address() as { port: number }).port, stats })));
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("corpus sanity: synthesized files are structurally real (magic bytes, sizes)", () => {
    const png = CORPUS.files["shot-1080p.png"];
    assert.deepEqual([...png.subarray(0, 8)], [...PNG_SIG], "1080p screenshot is a real PNG");
    assert.ok(png.length > 1_500_000 && png.length < 2_600_000, `noise PNG ~2MB (got ${png.length})`);
    const photo = CORPUS.files["photo-4032.jpg"];
    assert.equal(photo[0], 0xff); assert.equal(photo[1], 0xd8);
    assert.ok(Math.abs(photo.length - 4_700_000) < 100, `photo padded to 4.7MB (got ${photo.length})`);
    assert.ok(CORPUS.files["anim-800x600.gif"].toString("ascii", 0, 6).startsWith("GIF8"));
    assert.equal(CORPUS.files["webp-720.webp"].toString("ascii", 0, 4), "RIFF");
});

test("parser probe: decodeImageDims recovers every written dimension", () => {
    for (const t of CORPUS.truth) {
        const dims = decodeImageDims(b64(t.name));
        assert.ok(dims, `${t.name} decoded`);
        assert.equal(dims.w, t.w, `${t.name} width`);
        assert.equal(dims.h, t.h, `${t.name} height`);
    }
    // billing reads stored dimensions; EXIF orientation is display-only.
    const garbageDims = decodeImageDims(b64("garbage.png"));
    if (garbageDims) {
        // Random IHDR fields can parse as absurd dimensions — the tile model
        // must clamp them into its documented [765, 2805] band, never explode.
        const t = pixelTileEstimate(garbageDims.w, garbageDims.h);
        assert.ok(t >= 765 && t <= 2805, `garbage dims clamped (got ${t})`);
    }
    assert.equal(resolveImageBilling("auto", "https://relay.example/v1"), "pixels", "unknown host defaults to pixels");
});

test("poison measurement: bytes prior overbills a real photo >= 700x", () => {
    const data = b64("photo-4032.jpg");
    const bytesPrior = Math.ceil(data.length / 4);
    const pixelsPrior = pixelTileEstimate(4032, 3024);
    const encoderTruth = PHOTO_TRUTH;
    const ratio = bytesPrior / pixelsPrior;
    assert.ok(ratio >= 700, `bytes-vs-pixels poison ratio held (got ${Math.round(ratio)}x: ${bytesPrior} vs ${pixelsPrior})`);
    assert.ok(pixelsPrior / encoderTruth < 8, `pixels prior within the documented ±15x/8x-of-truth band (${pixelsPrior} vs truth ${encoderTruth})`);
});

test("e2e real payload: bytes route 743x-poisoned, learned cost rescues, baseline regresses", async () => {
    const { server: upstream, port: upstreamPort, stats } = await startMockUpstream();
    const { proxy, port: proxyPort } = await startProxy(upstreamPort, { imageBilling: "bytes" });
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": "img-e2e-bytes" };
        const photoUrl = `data:image/jpeg;base64,${b64("photo-4032.jpg")}`;
        const turn = (imgs: boolean) => JSON.stringify({ model: "gpt-astra", stream: true, max_tokens: 1024, messages: [{ role: "user", content: imgs
            ? [{ type: "text", text: "compare these two photos" }, { type: "image_url", image_url: { url: photoUrl } }, { type: "image_url", image_url: { url: photoUrl } }]
            : "hello there" }] });

        const t1 = await fetch(url, { method: "POST", headers, body: turn(false), signal: AbortSignal.timeout(30_000) });
        assert.equal(t1.status, 200, "text warmup forwards");
        await t1.text();

        // 2x 4.7MB real photos: ~12.6MB body on a route whose prior bills
        // ~3.1M image tokens — must be arbitrated forward, not rejected.
        const t2 = await fetch(url, { method: "POST", headers, body: turn(true), signal: AbortSignal.timeout(120_000) });
        assert.equal(t2.status, 200, "poisoned-prior payload arbitrated forward");
        await t2.text();
        assert.ok(stats.bodies[1] > 12_000_000, `full payload reached upstream (${Math.round(stats.bodies[1] / 1e6)}MB)`);
        assert.equal(stats.images, 2);

        const s = listSessions().find((x) => x.meta.label === "img-e2e-bytes")!;
        assert.ok(s, "session tracked");
        const entry = ((s.metadata as Record<string, unknown>).learnedImageCosts as Record<string, { cost: number; seen: number; fp: string }>)["127.0.0.1"];
        assert.ok(entry, "usage report landed in the learned cost table");
        assert.equal(entry.fp, "bytes:0");
        assert.ok(Math.abs(entry.cost - PHOTO_TRUTH) <= 1_000, `learned per-image cost near encoder truth (got ${entry.cost}, truth ${PHOTO_TRUTH})`);

        // Incident class: stale-high usage-grade baseline at the window edge.
        s.stats.lastInputTokens = WINDOW - 2_000;
        s.stats.lastInputTokensSource = "usage";

        const t3 = await fetch(url, { method: "POST", headers, body: turn(true), signal: AbortSignal.timeout(120_000) });
        assert.equal(t3.status, 200, "learned reserve carries the bricked session");
        await t3.text();
        assert.equal(stats.forwards, 3);
        assert.equal(stats.images, 4);

        const after = listSessions().find((x) => x.meta.label === "img-e2e-bytes")!;
        const baseline = after.stats.lastInputTokens;
        assert.ok(baseline > 2 * PHOTO_TRUTH && baseline < 60_000, `baseline regressed to real billing (~2 photos + text; got ${baseline})`);
        assert.notEqual(baseline, WINDOW - 2_000, "stale stamped baseline replaced");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e default route: auto->pixels de-poisoned, malformed image rides along, no crash", async () => {
    const { server: upstream, port: upstreamPort, stats } = await startMockUpstream();
    const { proxy, port: proxyPort } = await startProxy(upstreamPort);
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": "img-e2e-default" };
        const turn = (imgs: boolean) => JSON.stringify({ model: "gpt-astra", stream: true, max_tokens: 1024, messages: [{ role: "user", content: imgs
            ? [{ type: "text", text: "compare these two photos" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64("photo-4032.jpg")}` } }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64("photo-4032.jpg")}` } }, { type: "image_url", image_url: { url: `data:image/png;base64,${b64("garbage.png")}` } } ]
            : "hello there" }] });

        const t1 = await fetch(url, { method: "POST", headers, body: turn(false), signal: AbortSignal.timeout(30_000) });
        assert.equal(t1.status, 200);
        await t1.text();

        const s = listSessions().find((x) => x.meta.label === "img-e2e-default")!;
        assert.ok(s, "session tracked");
        s.stats.lastInputTokens = WINDOW - 2_000;
        s.stats.lastInputTokensSource = "usage";

        const t2 = await fetch(url, { method: "POST", headers, body: turn(true), signal: AbortSignal.timeout(120_000) });
        assert.equal(t2.status, 200, "stale-high baseline + malformed image forwards clean on the default route");
        await t2.text();
        assert.equal(stats.images, 3, "both photos and the garbage blob reached upstream verbatim");

        const after = listSessions().find((x) => x.meta.label === "img-e2e-default")!;
        const entry = ((after.metadata as Record<string, unknown>).learnedImageCosts as Record<string, { fp: string }>)["127.0.0.1"];
        assert.equal(entry?.fp, "pixels:0", "default route learns under the pixels fingerprint");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
