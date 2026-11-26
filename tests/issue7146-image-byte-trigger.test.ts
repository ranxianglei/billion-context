import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Jimp } from "jimp";
import { defaultConfig } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import type { ProxyOptions } from "../src/config.js";
import { applyImageRescaleItems, applyImageRescalePass, clearRescaleEncodeCache, shedDownscaleImage } from "../src/image-rescale.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import { createSession, peekSession } from "../src/session.js";
import { startServer } from "../src/server.js";
import { startFakeUpstream } from "./wire-contract-fakes.js";

const pngImage = new Jimp({ width: 256, height: 256, color: 0x3070a0ff });
const png = await pngImage.getBuffer("image/png", { deflateLevel: 0 });
const pngExpected = await (await Jimp.read(png)).getBuffer("image/png");
const pngBase64 = png.toString("base64");
const pngExpectedBase64 = pngExpected.toString("base64");

function context(id: string) {
    const session = createSession(id);
    return { session, sessionId: id, maxDim: 1600, toolArmed: false, log: () => {} };
}

function anthropicMessage(data: string, mime = "image/png"): BiliMessage {
    return { id: "picture", role: "user", contentType: "text", text: "look",
        rawAnthropicBlock: { type: "image", source: { type: "base64", media_type: mime, data } } };
}

function anthropicData(message: BiliMessage): string {
    return (message.rawAnthropicBlock as { source: { data: string } }).source.data;
}

test.beforeEach(() => {
    clearRescaleEncodeCache();
    delete process.env.BILI_IMAGE_RESCALE;
});

const carriers: Array<{ name: string; message: () => BiliMessage; read: (m: BiliMessage) => string }> = [
    { name: "Anthropic", message: () => anthropicMessage(pngBase64), read: anthropicData },
    { name: "OpenAI", message: () => ({ id: "picture", role: "user", contentType: "text", text: "look",
        rawOpenaiContentParts: [{ type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } }] }),
    read: m => (m.rawOpenaiContentParts as Array<{ image_url: { url: string } }>)[0].image_url.url.split(",")[1] },
    { name: "Google", message: () => ({ id: "picture", role: "user", contentType: "text", text: "look",
        rawGoogleParts: [{ inlineData: { mimeType: "image/png", data: pngBase64 } }] }),
    read: m => (m.rawGoogleParts as Array<{ inlineData: { data: string } }>)[0].inlineData.data },
    { name: "Responses core", message: () => ({ id: "picture", role: "user", contentType: "text", text: "look",
        rawResponsesItem: { type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${pngBase64}` }] } }),
    read: m => (m.rawResponsesItem as { content: Array<{ image_url: string }> }).content[0].image_url.split(",")[1] },
    { name: "bare sidecar", message: () => ({ id: "picture", role: "user", contentType: "text", text: "look",
        imageBase64: pngBase64, imageMediaType: "image/png" }), read: m => m.imageBase64! },
];

for (const carrier of carriers) {
    test(`#7146 ${carrier.name}: byte-triggered PNG re-encode keeps dimensions, pixels and original history`, async () => {
        assert.ok(png.length > 100 * 1024);
        assert.ok(pngExpected.length < png.length * 0.8);
        const input = [carrier.message()];
        const before = JSON.stringify(input);
        const output = await applyImageRescalePass(input, context(`byte-trigger-${carrier.name}`));
        const actual = carrier.read(output[0]);
        assert.equal(actual, pngExpectedBase64);
        const decoded = await Jimp.read(Buffer.from(actual, "base64"));
        assert.deepEqual([decoded.width, decoded.height], [256, 256]);
        assert.deepEqual(decoded.bitmap.data, pngImage.bitmap.data);
        assert.equal(JSON.stringify(input), before);
        assert.match(JSON.stringify(output), /now 256×256 \(1KB\), original 256×256 \(256KB\)/);
    });
}

for (const type of ["message", "function_call_output"]) {
    test(`#7146 Responses ${type}: item-level byte trigger preserves the input`, async () => {
        const key = type === "message" ? "content" : "output";
        const item = { type, role: "user", call_id: "camera", [key]: [{ type: "input_image", image_url: `data:image/png;base64,${pngBase64}` }] };
        const before = JSON.stringify(item);
        const output = await applyImageRescaleItems([item], context(`byte-trigger-item-${type}`));
        const parts = (output[0] as Record<string, Array<Record<string, string>>>)[key];
        assert.equal(parts[0].image_url, `data:image/png;base64,${pngExpectedBase64}`);
        assert.equal(parts[1].type, "input_text");
        assert.equal(JSON.stringify(item), before);
    });
}

test("#7146 within-limit JPEG uses the existing quality and keep-smaller policy", async () => {
    const pixels = new Jimp({ width: 256, height: 256 });
    let seed = 7146;
    for (let i = 0; i < pixels.bitmap.data.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels.bitmap.data[i] = seed & 255;
        pixels.bitmap.data[i + 1] = (seed >>> 8) & 255;
        pixels.bitmap.data[i + 2] = (seed >>> 16) & 255;
        pixels.bitmap.data[i + 3] = 255;
    }
    const original = await pixels.getBuffer("image/jpeg", { quality: 100 });
    const expected = await (await Jimp.read(original)).getBuffer("image/jpeg", { quality: 80 });
    assert.ok(original.length > 100 * 1024);
    assert.ok(expected.length < original.length * 0.8);
    const message = anthropicMessage(original.toString("base64"), "image/jpeg");
    const output = await applyImageRescalePass([message], context("byte-trigger-jpeg"));
    assert.equal(anthropicData(output[0]), expected.toString("base64"));
    const decoded = await Jimp.read(expected);
    assert.deepEqual([decoded.width, decoded.height], [256, 256]);
    assert.equal(anthropicData(message), original.toString("base64"));
});

for (const [width, expectedChange] of [[199, false], [200, true]] as const) {
    test(`#7146 decoded-size threshold: ${width} by 128 PNG`, async () => {
        const original = await new Jimp({ width, height: 128, color: 0x3070a0ff }).getBuffer("image/png", { deflateLevel: 0 });
        assert.equal(original.length > 100 * 1024, expectedChange);
        const message = anthropicMessage(original.toString("base64"));
        const output = await applyImageRescalePass([message], context(`byte-trigger-threshold-${width}`));
        assert.equal(anthropicData(output[0]) !== anthropicData(message), expectedChange);
        if (!expectedChange) assert.equal(output[0], message);
    });
}

test("#7146 large same-dimension BMP with no byte benefit stays untouched", async () => {
    const original = await pngImage.getBuffer("image/bmp");
    const expected = await (await Jimp.read(original)).getBuffer("image/bmp");
    assert.ok(original.length > 100 * 1024);
    assert.ok(expected.length >= original.length * 0.8);
    const message = anthropicMessage(original.toString("base64"), "image/bmp");
    assert.equal((await applyImageRescalePass([message], context("byte-trigger-bmp")))[0], message);
});

test("#7146 repeated same-dimension encodes remain byte-identical with and without the cache", async () => {
    const input = [anthropicMessage(pngBase64)];
    const ctx = context("byte-trigger-repeat");
    const first = await applyImageRescalePass(input, ctx);
    assert.equal(anthropicData(first[0]), pngExpectedBase64);
    assert.deepEqual(await applyImageRescalePass(input, ctx), first);
    clearRescaleEncodeCache();
    assert.deepEqual(await applyImageRescalePass(input, ctx), first);
});

test("#7146 disabling rescale keeps byte-heavy images unchanged", async () => {
    process.env.BILI_IMAGE_RESCALE = "0";
    try {
        const input = [anthropicMessage(pngBase64)];
        assert.equal(await applyImageRescalePass(input, context("byte-trigger-disabled")), input);
    } finally {
        delete process.env.BILI_IMAGE_RESCALE;
    }
});

test("#7146 original-image tool results retain their byte-heavy originals", async () => {
    const input: BiliMessage[] = [{ ...anthropicMessage(pngBase64), role: "tool", contentType: "tool-result", toolName: "acp_read_original_image" }];
    assert.equal((await applyImageRescalePass(input, context("byte-trigger-original")))[0], input[0]);
    const call = { type: "function_call", call_id: "restore", name: "acp_read_original_image", arguments: "{}" };
    const result = { type: "function_call_output", call_id: "restore", output: [{ type: "input_image", image_url: `data:image/png;base64,${pngBase64}` }] };
    const output = await applyImageRescaleItems([call, result], context("byte-trigger-original-item"));
    assert.equal(output[1], result);
});

test("#7146 forced same-dimension encoding retains its previous gate", async () => {
    assert.equal(await shedDownscaleImage("image/png", pngBase64, 1600), pngExpectedBase64);
    assert.equal(await shedDownscaleImage("image/png", pngExpectedBase64, 1600), null);
});

for (const plugin of [false, true]) {
    test(`#7146 real ${plugin ? "plugin" : "proxy"} request sends compressed bytes and keeps originals`, { timeout: 20_000 }, async () => {
        const fake = await startFakeUpstream("anthropic");
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const sessionId = `byte-trigger-relay-${plugin}`;
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: fake.url,
            routes: { [fake.url]: { models: { "claude-test": { context: 100_000 } } } },
            modelContextLimit: 100_000, kernelConfig: defaultConfig(100_000),
            compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" },
            log: false, sessionHeader: "x-acp-session", debug: false, passthrough: false, autoUpdate: false,
            compat: { roles: {} }, passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest",
            streamErrorShape: "protocol", advisoryCheck: false, releaseNotesCheck: false, mitm: { enabled: false, domains: [] },
        };
        const proxy = await startServer(opts);
        try {
            await once(proxy, "listening");
            const port = (proxy.address() as { port: number }).port;
            const response = await fetch(`http://127.0.0.1:${port}/bili/${fake.url}/v1/messages`, {
                method: "POST", headers: { "content-type": "application/json", "x-api-key": "test", "x-acp-session": sessionId,
                    ...(plugin ? { "x-bili-plugin": "pi" } : {}) },
                body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true,
                    messages: [{ role: "user", content: [{ type: "text", text: "Describe this picture." },
                        { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } }] }] }),
            });
            assert.equal(response.status, 200);
            await response.text();
            const body = fake.requests[0]?.body as { messages?: Array<{ content?: Array<{ type?: string; source?: { data?: string } }> }> } | undefined;
            const forwarded = body?.messages?.flatMap(m => Array.isArray(m.content) ? m.content : []).find(c => c.type === "image");
            assert.equal(forwarded?.source?.data, pngExpectedBase64);
            const remembered = peekSession(sessionId)?.transient?.pluginMessages;
            assert.ok(remembered);
            assert.ok(remembered.processed.some(m => {
                const block = (m as BiliMessage).rawAnthropicBlock as { source?: { data?: string } } | undefined;
                return block?.source?.data === pngBase64;
            }));
            assert.ok(!remembered.processed.some(m => String(m.id).startsWith("acp_imgnote_")));
        } finally {
            await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
            await fake.close();
        }
    });
}
