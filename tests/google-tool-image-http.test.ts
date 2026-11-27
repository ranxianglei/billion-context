import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { Jimp } from "jimp";
import { defaultConfig } from "acp-kernel";
import type { GoogleRequestBody } from "acp-kernel/wire";
import type { ProxyOptions } from "../src/config.js";
import { executeReadOriginalImage } from "../src/image-rescale.js";
import { countImagesInRawBody, decodeImageDims } from "../src/image-tokens.js";
import { _setStoreForTest, SessionStore } from "../src/persist.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import { _resetSessionsForTest, peekSession } from "../src/session.js";
import { startServer } from "../src/server.js";
import { closeServers } from "./server-close-guard.js";
import { VALIDATORS } from "./wire-contract-fakes.js";

process.env.BILI_CONFIG_FILE = "/nonexistent/bili-google-tool-image-http.json";

type Scenario = "byte" | "count" | "rescale" | "loop";

async function exercise(model: string, plugin: boolean, scenario: Scenario): Promise<void> {
    const env = ["BILI_HTTP_OUTBOUND_BYTES", "BILI_IMAGE_RESCALE", "BILI_IMAGE_RESCALE_MAX_DIM"] as const;
    const previous = env.map(key => process.env[key]);
    process.env.BILI_HTTP_OUTBOUND_BYTES = scenario === "byte" ? "50000" : "0";
    process.env.BILI_IMAGE_RESCALE = scenario === "rescale" ? "1" : "0";
    process.env.BILI_IMAGE_RESCALE_MAX_DIM = "128";
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const original = (await new Jimp({ width: 512, height: 256, color: 0x88aaccff }).getBuffer("image/png", {
        deflateLevel: scenario === "byte" || scenario === "loop" ? 0 : 9,
    })).toString("base64");
    const requests: string[] = [];
    const violations: string[] = [];
    const upstream = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const wire = Buffer.concat(chunks).toString("utf8");
        requests.push(wire);
        const parsed = JSON.parse(wire) as GoogleRequestBody;
        violations.push(...VALIDATORS.google(parsed, model));
        if (model.startsWith("claude")) {
            for (const content of parsed.contents ?? []) {
                const firstText = content.parts.findIndex(p => typeof p.text === "string" && !p.thought && !p.thoughtSignature);
                const lastResponse = content.parts.findLastIndex(p => p.functionResponse !== undefined);
                if (firstText >= 0 && firstText < lastResponse) violations.push("Claude tool responses must precede ordinary text");
            }
        }
        if (violations.length) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: violations.join("; ") } }));
            return;
        }
        const count = countImagesInRawBody("google", wire);
        if (scenario === "count" && count > 2) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: `Too many images in request: ${count} > 2` } }));
            return;
        }
        const loop = scenario === "loop" && requests.length === 1;
        if (loop) process.env.BILI_HTTP_OUTBOUND_BYTES = "50000";
        const parts = loop ? [{ functionCall: { name: "acp_status", args: {} }, thoughtSignature: "status-signature" }] : [{ text: "image egress accepted" }];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 } })}\n\n`);
    });
    let proxy: http.Server | undefined;
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const origin = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}`;
    const id = `google-images-${model}-${plugin}-${scenario}`;
    try {
        proxy = await startServer({
            port: 0, host: "127.0.0.1", upstream: origin, routes: {},
            modelContextLimit: 200_000, kernelConfig: defaultConfig(200_000),
            compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
            log: false, debug: false, passthrough: false, autoUpdate: false,
            compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
            autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false,
            releaseNotesCheck: false, mitm: { enabled: false, domains: [] },
        } satisfies ProxyOptions);
        if (!proxy.listening) await once(proxy, "listening");
        const port = (proxy.address() as import("node:net").AddressInfo).port;
        const count = scenario === "rescale" ? 1 : 3;
        const functionOutput = { image: { $ref: "shot-0.png" }, output: "captured", metadata: { keep: true } };
        const request = { contents: [
            { role: "user", parts: [{ text: "inspect screenshots" }] },
            { role: "model", parts: [{ functionCall: { id: "capture", name: "screenshot", args: {} }, thoughtSignature: "capture-signature" }] },
            { role: "user", parts: [{ functionResponse: { id: "capture", name: "screenshot", response: functionOutput,
                parts: Array.from({ length: count }, (_, i) => ({ inlineData: { mimeType: "image/png", data: original, displayName: `shot-${i}.png` } })),
            } }] },
            ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "user" : "model", parts: [{ text: `tail ${i}` }] })),
        ] };
        const post = () => fetch(`http://127.0.0.1:${port}/bili/${origin}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
            method: "POST", headers: { "content-type": "application/json", "x-acp-session": id, ...(plugin ? { "x-bili-plugin": "pi" } : {}) }, body: JSON.stringify(request),
        });
        const response = await post();
        const text = await response.text();
        assert.equal(response.status, 200, text);
        assert.match(text, /image egress accepted/);
        assert.deepEqual(violations, []);
        if (scenario === "count") {
            assert.deepEqual(requests.map(wire => countImagesInRawBody("google", wire)), [3, 1], "reactive count rescue reaches cap minus one");
            const next = await post();
            assert.equal(next.status, 200, await next.text());
            assert.deepEqual(requests.map(wire => countImagesInRawBody("google", wire)), [3, 1, 1], "later sends use the learned cap before forwarding");
        } else if (scenario === "rescale") {
            const forwarded = JSON.parse(requests[0]) as GoogleRequestBody;
            const fr = forwarded.contents!.flatMap(c => c.parts).find(p => p.functionResponse)?.functionResponse;
            assert.ok(fr);
            const inline = fr.parts![0].inlineData!;
            assert.notEqual(inline.data, original);
            assert.deepEqual(decodeImageDims(inline.data), { w: 128, h: 64 });
            assert.match(requests[0], /now 128×64/);
            assert.deepEqual(fr.response, functionOutput);
        } else {
            assert.equal(requests.length, scenario === "loop" ? 2 : 1);
            if (scenario === "loop") assert.ok(requests[0].includes(original));
            const sent = requests.at(-1)!;
            assert.ok(Buffer.byteLength(sent) <= 50000);
            assert.equal(countImagesInRawBody("google", sent), 0);
            assert.match(sent, /omitted for size limit/);
            assert.ok(!sent.includes(original));
        }
        const session = peekSession(id);
        assert.ok(session);
        const stored = session.transient?.pluginMessages;
        assert.ok(stored && JSON.stringify(stored.processed).includes(original), "remembered messages retain the original image bytes");
        assert.ok(!stored.processed.some(m => m.id.startsWith("acp_imgnote_")), "synthetic notes never enter persisted history");
        const ref = session.incomingImageIndex?.keys().next().value;
        assert.ok(ref, "original bytes remain indexed for recovery");
        const restored = await executeReadOriginalImage({ ref }, session, () => {});
        assert.equal(restored.outcome, "success");
        assert.equal(restored.image?.base64, original);
    } finally {
        env.forEach((key, i) => {
            if (previous[i] === undefined) delete process.env[key];
            else process.env[key] = previous[i];
        });
        await closeServers(proxy ? [proxy, upstream] : [upstream], "Google tool-image egress");
    }
}

for (const model of ["gemini-test", "claude-test"]) {
    for (const plugin of [false, true]) {
        for (const scenario of ["byte", "count", "rescale"] as const) {
            test(`Google ${model} ${plugin ? "plugin" : "proxy"} ${scenario} image egress`, { timeout: 25_000 }, () => exercise(model, plugin, scenario));
        }
    }
    test(`Google ${model} internal status continuation sheds nested images`, { timeout: 25_000 }, () => exercise(model, false, "loop"));
}
