import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { createCore, defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";

// An actual PNG: deterministic dimensions, incompressible pixels, and valid CRCs.
function png(): Buffer {
    const chunk = (type: string, data: Buffer): Buffer => {
        const body = Buffer.concat([Buffer.from(type), data]);
        let crc = 0xffffffff;
        for (const byte of body) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
        const header = Buffer.alloc(4), tail = Buffer.alloc(4);
        header.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([header, body, tail]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(256, 0); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 2;
    const rows = Array.from({ length: 256 }, () => Buffer.concat([Buffer.from([0]), randomBytes(256 * 3)]));
    return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

for (const mode of ["all-images", "remaining-images", "upstream-overflow"] as const) {
test(`preflight image budget: ${mode}`, async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const pixels = png(), base64 = pixels.toString("base64");
    const partial = mode !== "all-images";
    const limit = partial ? 8_000 : 12_000;
    const liveImage = partial ? `data:image/png;base64,${png().toString("base64")}` : undefined;
    const forwards: string[] = [], summaries: string[] = [];
    const summary = "The historical screenshot was inspected. Keep its image retrieval reference, the accepted decisions, and the current task constraints when continuing the work.";
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (JSON.parse(raw).stream === false) {
                summaries.push(raw);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ output_text: summary }));
            } else {
                forwards.push(raw);
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(`event: response.completed\ndata: ${JSON.stringify({ response: { id: "done", status: "completed", output: [], usage: { input_tokens: 1000, output_tokens: 5, total_tokens: 1005 } } })}\n\n`);
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address(); assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const config = defaultConfig(limit);
    config.preserveRecentMessages = 2; config.preserveRecentTokens = 500;
    const opts: ProxyOptions = {
        port: 0, host: "127.0.0.1", upstream: origin,
        routes: { [origin]: { models: { test: { context: limit } } } },
        modelContextLimit: limit, kernelConfig: config, imageBilling: partial ? "pixels" : "bytes",
        compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, passthroughSource: null, autoUpdate: false, autoRestartOnUpdate: false,
        updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false, compat: { roles: {} }, streamErrorShape: "protocol", mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress !== "string");
    try {
        const url = `http://127.0.0.1:${proxyAddress.port}/bili/${origin}/responses`;
        const seed = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "test", stream: true, session_id: "image-budget", input: [{ type: "message", role: "user", content: "Begin the screenshot investigation." }] }) });
        assert.equal(seed.status, 200); await seed.text();
        const seeded = listSessions().find(s => s.meta.label === "image-budget"); assert.ok(seeded);
        seeded.stats.lastInputTokens = 70_000;
        seeded.stats.lastInputTokensSource = mode === "upstream-overflow" ? "overflow-arm" : "usage";
        seeded.stats.lastInputTokensOrigin = origin;
        if (partial) seeded.metadata.learnedImageCosts = { "127.0.0.1": { cost: 20_000, seen: 1, ts: Date.now(), fp: "pixels:0" } };
        forwards.length = 0;
        const input: unknown[] = [
            { type: "message", role: "user", content: "Begin the screenshot investigation." },
            { type: "message", role: "assistant", content: "The historical evidence and decisions follow." },
            { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect this historical screenshot. " + "evidence details ".repeat(180) }, { type: "input_image", image_url: `data:image/png;base64,${base64}`, detail: "high" }] },
        ];
        for (let i = 0; i < 12; i++) input.push({ type: "message", role: i % 2 ? "user" : "assistant", content: `Historical turn ${i}. ` + "preserve decisions and constraints ".repeat(40) });
        input.push({ type: "message", role: "user", content: partial ? [
            { type: "input_text", text: "Continue using these current screenshots and the accepted findings." },
            { type: "input_image", image_url: liveImage, detail: "high" },
            { type: "input_image", image_url: liveImage, detail: "high" },
        ] : "Continue using the accepted findings." });
        const response = await fetch(url, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "test", stream: true, session_id: "image-budget", input }),
        });
        const body = await response.text();
        assert.ok(summaries.length > 0, "folding must not be declared futile from text savings alone");
        if (mode === "upstream-overflow") {
            assert.equal(response.status, 502, body);
            assert.equal(forwards.length, 0, "confirmed upstream overflow must not be bypassed by image arbitration");
            return;
        }
        assert.equal(response.status, 200, body);
        assert.equal(forwards.length, 1);
        assert.ok(!forwards[0]!.includes(base64), "the folded image must leave the actual outbound wire");
        assert.ok(forwards[0]!.includes(summary));
        assert.equal((forwards[0]!.match(/"input_image"/g) ?? []).length, partial ? 2 : 0, "only the protected live images remain");
        const ref = summaries.join("\n").match(/\[image: png 256x256 · (m\d+)\]/)?.[1];
        assert.ok(ref, "summary input retains a resolvable image reference");
        const session = listSessions().find(s => s.meta.label === "image-budget"); assert.ok(session);
        const restored = resolveDecompress({ imageRef: ref }, { core: createCore(), config, messages: [], session, log: () => {} });
        assert.equal(restored.outcome, "success", restored.text);
        const file = restored.text.match(/\n  (.+\.png)/)?.[1]; assert.ok(file, restored.text);
        assert.deepEqual(readFileSync(file), pixels, "retrieval restores the original pixels exactly");
    } finally {
        const proxyClosed = once(proxy, "close"), upstreamClosed = once(upstream, "close");
        proxy.close(); proxy.closeAllConnections(); upstream.close(); upstream.closeAllConnections();
        await Promise.all([proxyClosed, upstreamClosed]);
    }
});
}
