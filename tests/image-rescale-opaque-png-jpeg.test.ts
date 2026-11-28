import assert from "node:assert/strict";
import test from "node:test";
import { Jimp } from "jimp";
import type { BiliMessage } from "acp-kernel/wire";
import {
    applyImageRescaleItems,
    applyImageRescalePass,
    clearRescaleEncodeCache,
    shedDownscaleImage,
} from "../src/image-rescale.js";
import { createSession } from "../src/session.js";

function ctxFor(id: string, maxDim = 1600) {
    const session = createSession(id);
    return { session, ctx: { session, sessionId: id, maxDim, toolArmed: false, log: () => {} } };
}

/** Deterministic noisy-but-smooth RGBA image >100KB as compressed PNG where
 *  re-encoding via Jimp PNG at same dims yields ~100% of original bytes (fails
 *  KEEP_RATIO=0.8), whereas JPEG q=80 shrinks well under 80%. */
async function makeScreenshotPng(width: number, height: number, alpha: number): Promise<Buffer> {
    const img = new Jimp({ width, height });
    const data = img.bitmap.data;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const wave = Math.round(127 + 60 * Math.sin(x / 17) * Math.cos(y / 19));
            const noise = ((x * 37 + y * 91 + ((x ^ y) & 15)) % 23) - 11;
            data[idx] = Math.max(0, Math.min(255, wave + noise));
            data[idx + 1] = Math.max(0, Math.min(255, (wave * 3) % 256));
            data[idx + 2] = Math.max(0, Math.min(255, 255 - wave));
            data[idx + 3] = alpha;
        }
    }
    return img.getBuffer("image/png");
}

const OPAQUE_PNG = await makeScreenshotPng(720, 640, 255);
const ALPHA_PNG = await makeScreenshotPng(720, 640, 200);

test.beforeEach(() => {
    clearRescaleEncodeCache();
    delete process.env.BILI_IMAGE_RESCALE;
});

test("opaque PNG that fails PNG KEEP_RATIO falls back to JPEG and propagates media_type across all carriers", async () => {
    assert.ok(OPAQUE_PNG.length > 100 * 1024, `fixture expected >100KB, got ${OPAQUE_PNG.length}`);
    const b64 = OPAQUE_PNG.toString("base64");

    // 1. Anthropic standalone image
    const anth = await applyImageRescalePass(
        [{ id: "m1", role: "user", contentType: "text", text: "[image]", rawAnthropicBlock: { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } } }],
        ctxFor("s-anth").ctx,
    );
    assert.equal(anth.length, 2);
    const anthSrc = (anth[0].rawAnthropicBlock as { source: { media_type: string; data: string } }).source;
    assert.equal(anthSrc.media_type, "image/jpeg");
    const anthBytes = Buffer.from(anthSrc.data, "base64");
    assert.equal(anthBytes[0], 0xff);
    assert.equal(anthBytes[1], 0xd8);
    assert.ok(anthBytes.length < OPAQUE_PNG.length * 0.8);

    // 2. Anthropic tool_result image
    const anthTr = await applyImageRescalePass(
        [{ id: "m2", role: "user", contentType: "tool-result", toolCallId: "tc1", text: "", rawAnthropicBlock: { type: "tool_result", tool_use_id: "tc1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }] } }],
        ctxFor("s-anth-tr").ctx,
    );
    const trContent = (anthTr[0].rawAnthropicBlock as { content: Array<{ source?: { media_type: string; data: string } }> }).content;
    assert.equal(trContent[0].source?.media_type, "image/jpeg");

    // 3. OpenAI content parts + singular
    const oaiParts = await applyImageRescalePass(
        [{ id: "m3", role: "user", contentType: "text", text: "look", rawOpenaiContentParts: [{ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }] }],
        ctxFor("s-oai-parts").ctx,
    );
    assert.match((oaiParts[0].rawOpenaiContentParts as Array<{ image_url: { url: string } }>)[0].image_url.url, /^data:image\/jpeg;base64,/);

    const oaiSingle = await applyImageRescalePass(
        [{ id: "m4", role: "user", contentType: "text", text: "look", rawOpenaiContent: { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } } }],
        ctxFor("s-oai-single").ctx,
    );
    assert.match((oaiSingle[0].rawOpenaiContentParts as Array<{ image_url: { url: string } }>)[0].image_url.url, /^data:image\/jpeg;base64,/);

    // 4. Google inlineData
    const google = await applyImageRescalePass(
        [{ id: "m5", role: "user", contentType: "text", text: "look", rawGoogleParts: [{ inlineData: { mimeType: "image/png", data: b64 } }] }],
        ctxFor("s-google").ctx,
    );
    assert.equal((google[0].rawGoogleParts as Array<{ inlineData: { mimeType: string } }>)[0].inlineData.mimeType, "image/jpeg");

    // 5. Responses item + steady-path items walker
    const respItem = await applyImageRescalePass(
        [{ id: "m6", role: "user", contentType: "text", text: "[image]", rawResponsesItem: { type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${b64}` }] } }],
        ctxFor("s-resp-item").ctx,
    );
    assert.match((respItem[0].rawResponsesItem as { content: Array<{ image_url: string }> }).content[0].image_url, /^data:image\/jpeg;base64,/);

    const respWalk = (await applyImageRescaleItems(
        [{ type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${b64}` }] }],
        ctxFor("s-resp-walk").ctx,
    )) as Array<{ content: Array<{ image_url: string }> }>;
    assert.match(respWalk[0].content[0].image_url, /^data:image\/jpeg;base64,/);

    // 6. Bare sidecar
    const bare = await applyImageRescalePass(
        [{ id: "m7", role: "user", contentType: "text", text: "look", imageBase64: b64, imageMediaType: "image/png" }],
        ctxFor("s-bare").ctx,
    );
    assert.equal(bare[0].imageMediaType, "image/jpeg");
});

test("transparent PNG never converts to JPEG when lossless PNG re-encode fails KEEP_RATIO", async () => {
    assert.ok(ALPHA_PNG.length > 100 * 1024);
    const input: BiliMessage[] = [{
        id: "m-alpha", role: "user", contentType: "text", text: "[image]",
        rawAnthropicBlock: { type: "image", source: { type: "base64", media_type: "image/png", data: ALPHA_PNG.toString("base64") } },
    }];
    const out = await applyImageRescalePass(input, ctxFor("s-alpha").ctx);
    assert.equal(out.length, 1);
    assert.equal(out[0], input[0], "transparent PNG must stay untouched rather than losing alpha via JPEG");
});

test("shedDownscaleImage keeps same-MIME contract (never converts PNG to JPEG)", async () => {
    const out = await shedDownscaleImage("image/png", OPAQUE_PNG.toString("base64"), 512);
    if (out !== null) {
        const bytes = Buffer.from(out, "base64");
        assert.equal(bytes[0], 0x89, "shedDownscaleImage output must remain PNG");
        assert.equal(bytes[1], 0x50);
    }
});
