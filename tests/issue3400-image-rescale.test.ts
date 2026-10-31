import { test } from "node:test";
import { createHash } from "node:crypto";
import { responsesToCoreWithToolImages, coreToResponsesWithToolImages } from "../src/responses-tool-output.js";
import { shedWireImages } from "../src/egress-shed.js";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Jimp } from "jimp";
import { type BiliMessage } from "acp-kernel/wire";
import type { ProxyOptions } from "../src/config.js";

// #3400: egress image rescale (simplified re-do of #3295's removal). Contract:
// big images (>1600 longest edge or >100KB) are downscaled on the OUTBOUND
// copy only; originals stay in session storage; the model is told both sizes
// beside the image; acp_read_original_image returns the exact stored bytes and
// its results are structurally exempt from re-shrinking (the #3266 loop guard).
process.env.BILI_CONFIG_FILE = "/nonexistent/bili-issue3400-config.json";

const { createSession, peekSession } = await import("../src/session.js");
const {
    applyImageRescalePass, applyImageRescaleItems, executeReadOriginalImage,
    buildRescaleNote, clearRescaleEncodeCache,
} = await import("../src/image-rescale.js");
const { storeEffectiveImageRescale, imageRescaleToolArmed } = await import("../src/store.js");
const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.js");
const { SessionStore, _setStoreForTest } = await import("../src/persist.js");
const { _setForTest: setRegistryForTest } = await import("../src/registry.js");
const { startFakeUpstream } = await import("./wire-contract-fakes.js");

const root = mkdtempSync(path.join(tmpdir(), "issue3400-rescale-"));
const logLines: string[] = [];
const log = (level: string, msg: string): void => { logLines.push(`${level} ${msg}`); };

function ctxFor(sessionId: string, toolArmed = true) {
    const session = createSession(sessionId);
    return { session, ctx: { session, sessionId, log, maxDim: 1600, toolArmed } };
}

async function makePng(width: number, height: number): Promise<{ b64: string; bytes: number }> {
    const img = new Jimp({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const c = (((x % 256) << 16) | ((y % 256) << 8) | ((x + y) % 256)) >>> 0;
            img.setPixelColor((0xff000000 | c) >>> 0, x, y);
        }
    }
    const buf = await img.getBuffer("image/png");
    return { b64: buf.toString("base64"), bytes: buf.length };
}

async function makeBmp(width: number, height: number): Promise<{ b64: string; bytes: number }> {
    const seed = new Jimp({ width: 1, height: 1 });
    seed.setPixelColor(0xff8899aa, 0, 0);
    const img = await Jimp.read(await seed.getBuffer("image/bmp"));
    await img.resize({ w: width, h: height });
    const buf = await img.getBuffer("image/bmp");
    return { b64: buf.toString("base64"), bytes: buf.length };
}

test.beforeEach(() => {
    clearRescaleEncodeCache();
    logLines.length = 0;
    delete process.env.BILI_IMAGE_RESCALE;
});

const BIG = await makePng(2400, 1800);
const SMALL = await makePng(400, 300);
const BMP = await makeBmp(1601, 400);

function anthropicImageMsg(id: string, b64: string, mediaType = "image/png"): BiliMessage {
    return { id, role: "user", contentType: "text", text: "[image]", rawAnthropicBlock: { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } } };
}

test("big image shrunk: anthropic standalone gets copied block + adjacent note message", async () => {
    const { session, ctx } = ctxFor("s-anth");
    session.state.messageRefs.byRaw["msg_img_1"] = "m12345";
    const input = [anthropicImageMsg("msg_img_1", BIG.b64)];
    const out = await applyImageRescalePass(input, ctx);
    assert.equal(out.length, 2);
    const block = out[0].rawAnthropicBlock as { source: { data: string } };
    assert.notEqual(block.source.data, BIG.b64);
    const decoded = await Jimp.read(Buffer.from(block.source.data, "base64"));
    assert.ok(decoded.width <= 1600 && decoded.height <= 1600, `shrunk dims ${decoded.width}x${decoded.height}`);
    assert.notEqual(out[0], input[0], "input object not mutated in place");
    assert.equal(out[1].id, "acp_imgnote_msg_img_1");
    assert.equal(out[1].role, "user");
    assert.match(String(out[1].text), /^\[bili\] 本图已降采样:当前 \d+×\d+ \/ \d+KB;原图 2400×1800 \/ \d+KB\(约 [\d.]+ 倍\)。需要原分辨率细节\(小字、颜色、对齐\)时,调用 acp_read_original_image\("m12345"\) 读取原图。原图较大,按需读取。$/);
    // original sidecar untouched in the input array
    assert.equal((input[0].rawAnthropicBlock as { source: { data: string } }).source.data, BIG.b64);
});

test("small image passes untouched (object identity preserved)", async () => {
    const { session, ctx } = ctxFor("s-small");
    const input = [anthropicImageMsg("msg_small", SMALL.b64)];
    const out = await applyImageRescalePass(input, ctx);
    assert.equal(out.length, 1);
    assert.equal(out[0], input[0]);
});

test("low-benefit image kept (re-encode saves <20% → keep-smaller)", async () => {
    const { session, ctx } = ctxFor("s-bmp");
    // 1601x400 flat BMP: gated by width, but BMP bytes scale ~linearly with
    // pixel count — the 1600x400 re-encode is ~0.999x of the original, above
    // the 0.8 keep-smaller threshold, so it must pass through byte-identical.
    const input = [anthropicImageMsg("msg_bmp", BMP.b64, "image/bmp")];
    const out = await applyImageRescalePass(input, ctx);
    assert.equal(out.length, 1);
    assert.equal(out[0], input[0]);
});

test("hash cache: same content encodes once, cache hits log nothing", async () => {
    const { session, ctx } = ctxFor("s-cache");
    const h1 = [anthropicImageMsg("msg_a", BIG.b64)];
    await applyImageRescalePass(h1, ctx);
    const firstLogs = logLines.filter((l) => l.includes("[image-rescale]")).length;
    assert.equal(firstLogs, 1);
    const h2 = [anthropicImageMsg("msg_b", BIG.b64)];
    await applyImageRescalePass(h2, ctx);
    assert.equal(logLines.filter((l) => l.includes("[image-rescale]")).length, 1, "second identical image must hit the cache without re-encoding or re-logging");
    const d1 = (h1[0].rawAnthropicBlock as { source: { data: string } }).source.data;
    const d2 = (h2[0].rawAnthropicBlock as { source: { data: string } }).source.data;
    assert.equal(d2, d1);
});

test("byte-stable: same history → identical outbound bytes across cache states", async () => {
    const build = (): BiliMessage[] => [anthropicImageMsg("msg_x", BIG.b64), { id: "msg_t", role: "user", contentType: "text", text: "hi" }];
    const s1 = createSession("s-stab");
    const c1 = { session: s1, sessionId: "s-stab", log, maxDim: 1600, toolArmed: true };
    const out1 = JSON.stringify(await applyImageRescalePass(build(), c1));
    clearRescaleEncodeCache();
    const s2 = createSession("s-stab");
    const c2 = { session: s2, sessionId: "s-stab", log, maxDim: 1600, toolArmed: true };
    const out2 = JSON.stringify(await applyImageRescalePass(build(), c2));
    assert.equal(out2, out1, "two independent encodes of the same history must be byte-identical (upstream prefix-cache protection)");
});

test("openai singular image_url converts to plural parts with inline note", async () => {
    const { session, ctx } = ctxFor("s-openai");
    session.state.messageRefs.byRaw["msg_o"] = "m20001";
    const input: BiliMessage[] = [{
        id: "msg_o", role: "user", contentType: "text", text: "look",
        rawOpenaiContent: { type: "image_url", image_url: { url: `data:image/png;base64,${BIG.b64}` } },
        imageBase64: BIG.b64, imageMediaType: "image/png",
    }];
    const out = await applyImageRescalePass(input, ctx);
    assert.equal(out.length, 1);
    const m = out[0];
    assert.equal(m.rawOpenaiContent, undefined);
    assert.equal(m.imageBase64, undefined);
    assert.ok(Array.isArray(m.rawOpenaiContentParts));
    const parts = m.rawOpenaiContentParts as Array<Record<string, unknown>>;
    assert.equal(parts.length, 2);
    const url = (parts[0].image_url as { url: string }).url;
    assert.match(url, /^data:image\/png;base64,/);
    assert.notEqual(url, `data:image/png;base64,${BIG.b64}`);
    assert.equal(parts[1].type, "text");
    assert.match(String(parts[1].text), /acp_read_original_image\("m20001"\)/);
});

test("google inlineData shrunk, note appended to core text (never a raw text part)", async () => {
    const { session, ctx } = ctxFor("s-google");
    session.state.messageRefs.byRaw["msg_g"] = "m30001";
    const input: BiliMessage[] = [{
        id: "msg_g", role: "user", contentType: "text", text: "hello",
        rawGoogleParts: [{ inlineData: { mimeType: "image/png", data: BIG.b64 } }],
    }];
    const out = await applyImageRescalePass(input, ctx);
    assert.equal(out.length, 1);
    const parts = out[0].rawGoogleParts as Array<{ inlineData?: { data?: string } }>;
    assert.equal(parts.length, 1);
    assert.notEqual(parts[0].inlineData?.data, BIG.b64);
    assert.match(String(out[0].text), /^hello\n\n\[bili\] 本图已降采样:.*acp_read_original_image\("m30001"\)/);
});

test("responses item: image url replaced, NO text part inside item, note rides separate message", async () => {
    const { session, ctx } = ctxFor("s-resp");
    session.state.messageRefs.byRaw["msg_r"] = "m40001";
    const input: BiliMessage[] = [{
        id: "msg_r", role: "user", contentType: "text", text: "[image]",
        rawResponsesItem: {
            type: "message", role: "user",
            content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: `data:image/png;base64,${BIG.b64}` }],
        },
    }];
    const out = await applyImageRescalePass(input, ctx);
    assert.equal(out.length, 2);
    const content = (out[0].rawResponsesItem as { content: Array<Record<string, unknown>> }).content;
    assert.equal(content.length, 2, "no note part may be inserted inside the item (verbatim round-trip condition)");
    assert.match(String(content[1].image_url), /^data:image\/png;base64,/);
    assert.notEqual(content[1].image_url, `data:image/png;base64,${BIG.b64}`);
    assert.equal(out[1].id, "acp_imgnote_msg_r");
    assert.match(String(out[1].text), /acp_read_original_image\("m40001"\)/);
});

test("items walker (responses steady path): shrinks + inserts input_text note after the image", async () => {
    const { session, ctx } = ctxFor("s-items");
    const items = [
        { type: "message", role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: `data:image/png;base64,${BIG.b64}` }] },
    ];
    const out = (await applyImageRescaleItems(items, ctx)) as Array<{ content: Array<Record<string, unknown>> }>;
    assert.equal(out.length, 1);
    assert.equal(out[0].content.length, 3);
    assert.equal(out[0].content[2].type, "input_text");
    assert.match(String(out[0].content[2].text), /^\[bili\] 本图已降采样:/);
});

test("items walker exemption: output answering acp_read_original_image passes verbatim", async () => {
    const { session, ctx } = ctxFor("s-items-exempt");
    const items = [
        { type: "function_call", call_id: "call_1", name: "acp_read_original_image", arguments: '{"ref":"m12345"}' },
        { type: "function_call_output", call_id: "call_1", output: [{ type: "input_image", image_url: `data:image/png;base64,${BIG.b64}` }] },
    ];
    const out = (await applyImageRescaleItems(items, ctx)) as unknown[];
    assert.equal(out.length, 2);
    assert.equal(out[1], items[1], "exempt tool output must be the SAME object (untouched)");
});

test("structural loop guard: carrier message with toolName acp_read_original_image is never re-shrunk", async () => {
    const { session, ctx } = ctxFor("s-guard");
    const input: BiliMessage[] = [{
        id: "acp_loop_r2_img_call_1", role: "user", contentType: "text",
        text: "[bili] 原图已读取,完整分辨率的原始图片如下。",
        toolName: "acp_read_original_image", imageBase64: BIG.b64, imageMediaType: "image/png",
    }];
    const out = await applyImageRescalePass(input, ctx);
    assert.equal(out.length, 1);
    assert.equal(out[0], input[0], "the returned ORIGINAL must survive subsequent rounds byte-identical (#3266 regression pin)");
});

test("knob off (BILI_IMAGE_RESCALE=0): pass returns the same array untouched", async () => {
    process.env.BILI_IMAGE_RESCALE = "0";
    try {
        const { session, ctx } = ctxFor("s-off");
        const input = [anthropicImageMsg("msg_off", BIG.b64)];
        const out = await applyImageRescalePass(input, ctx);
        assert.equal(out, input);
    } finally {
        delete process.env.BILI_IMAGE_RESCALE;
    }
});

test("size-only note when the tool lane is not armed (codex/plugin lanes)", async () => {
    const { session, ctx } = ctxFor("s-codex", false);
    session.state.messageRefs.byRaw["msg_c"] = "m50001";
    const input = [anthropicImageMsg("msg_c", BIG.b64)];
    const out = await applyImageRescalePass(input, ctx);
    assert.equal(out.length, 2);
    assert.match(String(out[1].text), /^\[bili\] 本图已降采样:当前 \d+×\d+ \/ \d+KB;原图 2400×1800 \/ \d+KB。$/);
    assert.doesNotMatch(String(out[1].text), /acp_read_original_image/);
});

test("buildRescaleNote: deterministic templates (full + size-only)", () => {
    const full = buildRescaleNote({ ref: "m12345", toolArmed: true, width: 1600, height: 1173, kb: 73, origWidth: 2140, origHeight: 1560, origKb: 317, ratio: 4.3 });
    assert.equal(full, "[bili] 本图已降采样:当前 1600×1173 / 73KB;原图 2140×1560 / 317KB(约 4.3 倍)。需要原分辨率细节(小字、颜色、对齐)时,调用 acp_read_original_image(\"m12345\") 读取原图。原图较大,按需读取。");
    assert.equal(full, buildRescaleNote({ ref: "m12345", toolArmed: true, width: 1600, height: 1173, kb: 73, origWidth: 2140, origHeight: 1560, origKb: 317, ratio: 4.3 }));
    const sizeOnly = buildRescaleNote({ ref: "m12345", toolArmed: false, width: 1600, height: 1173, kb: 73, origWidth: 2140, origHeight: 1560, origKb: 317, ratio: 4.3 });
    assert.equal(sizeOnly, "[bili] 本图已降采样:当前 1600×1173 / 73KB;原图 2140×1560 / 317KB。");
    const noRef = buildRescaleNote({ ref: undefined, toolArmed: true, width: 1600, height: 1173, kb: 73, origWidth: 2140, origHeight: 1560, origKb: 317, ratio: 4.3 });
    assert.equal(noRef, sizeOnly);
});

test("gate stamping: storeEffectiveImageRescale/imageRescaleToolArmed", () => {
    const s = createSession("s-gate");
    assert.equal(imageRescaleToolArmed(s), false);
    storeEffectiveImageRescale(s, true);
    assert.equal(imageRescaleToolArmed(s), true);
});

test("gate pins once per session (#4789): a later opposite decision is a no-op", () => {
    // Armed at session start -> a mid-session disarm (feature toggled off) must not drop the tool.
    const on = createSession("s-gate-pin-on");
    storeEffectiveImageRescale(on, true);
    storeEffectiveImageRescale(on, undefined);
    assert.equal(imageRescaleToolArmed(on), true, "once armed, the flag is pinned for the session's life");
    // Decided-off at session start -> a mid-session arm (feature toggled on) must not add the tool.
    const off = createSession("s-gate-pin-off");
    storeEffectiveImageRescale(off, undefined);
    assert.equal(imageRescaleToolArmed(off), false);
    storeEffectiveImageRescale(off, true);
    assert.equal(imageRescaleToolArmed(off), false, "once decided off, the flag is pinned for the session's life");
});

test("executeReadOriginalImage: returns EXACT stored bytes + cumulative counter", async () => {
    const session = createSession("s-read");
    const imgPath = path.join(root, "original.png");
    const buf = Buffer.from(BIG.b64, "base64");
    writeFileSync(imgPath, buf);
    session.incomingImageIndex = new Map([["m12345", [{ mediaType: "image/png", bytes: buf.length, width: 2400, height: 1800, path: imgPath }]]]);
    const r1 = await executeReadOriginalImage({ ref: "m12345" }, session, log);
    assert.equal(r1.outcome, "success");
    assert.equal(r1.image?.base64, BIG.b64, "returned bytes must equal the stored original exactly");
    assert.equal(r1.image?.mediaType, "image/png");
    assert.match(r1.text, new RegExp(imgPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const counter = session.metadata.imageRescaleReads as { count: number; bytes: number };
    assert.deepEqual(counter, { count: 1, bytes: buf.length });
    await executeReadOriginalImage({ ref: "m12345" }, session, log);
    assert.deepEqual(session.metadata.imageRescaleReads, { count: 2, bytes: buf.length * 2 });
    assert.match(logLines.at(-1) ?? "", /session-cumulative 2 read\(s\)/);
});

test("executeReadOriginalImage: invalid / unknown / evicted refs fail cleanly", async () => {
    const session = createSession("s-read-fail");
    const bad = await executeReadOriginalImage({ ref: "not-a-ref" }, session, log);
    assert.equal(bad.outcome, "failure");
    const missing = await executeReadOriginalImage({ ref: "m99999" }, session, log);
    assert.equal(missing.outcome, "failure");
    assert.match(missing.text, /no original image stored/);
    session.incomingImageIndex = new Map([["m12345", [{ mediaType: "image/png", bytes: 10, width: 10, height: 10, path: path.join(root, "gone.png") }]]]);
    const evicted = await executeReadOriginalImage({ ref: "m12345" }, session, log);
    assert.equal(evicted.outcome, "failure");
    assert.match(evicted.text, /evicted/);
});

// #3400 spec goal 2 pin: the shrink must happen on the OUTBOUND COPY ONLY.
// Regression pinned: prepare-* once reassigned its local processedMessages to
// the rescaled array, and Prepared returned that local — leaking shrunken bytes
// plus synthetic acp_imgnote_* messages into rememberPluginMessages() →
// session.transient.pluginMessages (the tool-API compress anchor view), i.e.
// the session storage no longer kept what the wire received. This test drives
// one real request through startServer and checks BOTH halves: upstream saw the
// shrunken image, while the remembered session view keeps the original bytes
// byte-exact and contains no synthetic note messages.
test("persistence invariant: remembered session view keeps ORIGINAL image bytes while egress sends shrunken (#3400)", async () => {
    const fake = await startFakeUpstream("anthropic");
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: fake.url,
        routes: { [fake.url]: { models: { "claude-test": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        streamErrorShape: "protocol",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    try {
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}/bili/${fake.url}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "test", "x-acp-session": "wc-persist-pin" },
            body: JSON.stringify({
                model: "claude-test", max_tokens: 1024, stream: true,
                messages: [{ role: "user", content: [
                    { type: "text", text: "look at this" },
                    { type: "image", source: { type: "base64", media_type: "image/png", data: BIG.b64 } },
                ]}],
            }),
        });
        assert.equal(res.status, 200);
        await res.text();

        // Egress half: the forwarded body carried the SHRUNKEN image.
        const fwdBody = fake.requests[0]?.body as { messages?: Array<{ content?: Array<{ type?: string; source?: { data?: string } }> }> } | undefined;
        const fwdImage = fwdBody?.messages?.flatMap((m) => m.content ?? []).find((c) => c.type === "image");
        assert.ok(fwdImage, "forwarded body carries the image block");
        assert.notEqual(fwdImage.source?.data, BIG.b64, "egress copy must be downscaled");

        // Storage half: the remembered view keeps the ORIGINAL bytes byte-exact.
        const session = peekSession("wc-persist-pin");
        assert.ok(session, "session exists after the turn");
        const stored = session.transient?.pluginMessages;
        assert.ok(stored, "rememberPluginMessages must have run for the forwarded turn");
        const originalKept = stored.processed.some((m) => {
            const block = (m as BiliMessage).rawAnthropicBlock as { type?: string; source?: { data?: string } } | undefined;
            return block?.type === "image" && block?.source?.data === BIG.b64;
        });
        assert.ok(originalKept, "remembered processed view must keep the ORIGINAL big-image bytes");
        assert.ok(!stored.processed.some((m) => String(m.id).startsWith("acp_imgnote_")), "synthetic note messages must not enter the stored view");
    } finally {
        await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
        await fake.close();
    }
});

test("PTC original receipt: real restore survives an Anthropic ipython tool result", async () => {
    const { session, ctx } = ctxFor("s-ptc-original");
    const imgPath = path.join(root, "ptc-original.png");
    const buf = Buffer.from(BIG.b64, "base64");
    writeFileSync(imgPath, buf);
    session.incomingImageIndex = new Map([["m12345", [{ mediaType: "image/png", bytes: buf.length, width: 2400, height: 1800, path: imgPath }]]]);
    const restored = await executeReadOriginalImage({ ref: "m12345" }, session, log);
    assert.ok(restored.image);
    const input: BiliMessage[] = [{
        id: "ptc-result", role: "tool", contentType: "tool-result", toolName: "ipython", text: restored.text,
        rawAnthropicBlock: { type: "tool_result", tool_use_id: "ptc", content: [
            { type: "text", text: restored.text },
            { type: "image", source: { type: "base64", media_type: restored.image.mediaType, data: restored.image.base64 } },
        ] },
    }];
    const before = JSON.stringify(input);
    const out = await applyImageRescalePass(input, ctx);
    assert.equal(out[0], input[0], "receipt-bound original must survive PTC unchanged");
    assert.equal(JSON.stringify(input), before, "history remains byte-exact");
    assert.match(restored.text, /^Original image for m12345 restored .*\nBillion original image receipt v1 sha256=[a-f0-9]{64}$/);
});

const RECEIPT = `Billion original image receipt v1 sha256=${createHash("sha256").update(Buffer.from(BIG.b64, "base64")).digest("hex")}`;
const OTHER = (await makePng(2200, 1700)).b64;
type ImageTestPart = { type: string; text?: string; image_url?: string };
const responseImage = (b64: string): ImageTestPart => ({ type: "input_image", image_url: `data:image/png;base64,${b64}` });

test("PTC original receipt: Responses steady and rebuilt outputs protect only matching images", async () => {
    const { ctx } = ctxFor("s-ptc-responses");
    for (const type of ["function_call_output", "custom_tool_call_output"]) {
        const input = [{ type, call_id: "ptc", output: [
            { type: "input_text", text: RECEIPT }, responseImage(BIG.b64), responseImage(OTHER),
        ] }];
        const before = JSON.stringify(input);
        const steady = await applyImageRescaleItems(input, ctx) as typeof input;
        assert.ok(steady[0].output[1].image_url === responseImage(BIG.b64).image_url, "matching original survives steady egress");
        assert.ok(steady[0].output[2].image_url !== responseImage(OTHER).image_url, "unrelated PTC image still shrinks");
        const projection = responsesToCoreWithToolImages({ input });
        const generic = await applyImageRescalePass(projection.msgs, ctx);
        const rebuilt = coreToResponsesWithToolImages(generic, projection.customToolCallIds) as typeof input;
        assert.ok(rebuilt[0].output[1].image_url === responseImage(BIG.b64).image_url, "matching original survives generic/rebuilt egress");
        assert.ok(rebuilt[0].output[2].image_url !== responseImage(OTHER).image_url, "unrelated rebuilt image still shrinks");
        assert.equal(JSON.stringify(input), before, "history is untouched");
    }
});

test("PTC original receipt: byte-shed keeps matching originals but sheds unrelated images", async () => {
    for (const tail of [0, 9]) {
        for (const protocol of ["responses", "anthropic"] as const) {
            const output = protocol === "responses"
                ? [{ type: "input_text", text: RECEIPT }, responseImage(BIG.b64), responseImage(OTHER)]
                : [{ type: "text", text: RECEIPT },
                    { type: "image", source: { type: "base64", media_type: "image/png", data: BIG.b64 } },
                    { type: "image", source: { type: "base64", media_type: "image/png", data: OTHER } }];
            const body = protocol === "responses"
                ? { input: [{ type: "function_call_output", call_id: "ptc", output }, ...Array.from({ length: tail }, () => ({ type: "message", role: "user", content: "padding" }))] }
                : { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "ptc", content: output }] }, ...Array.from({ length: tail }, () => ({ role: "user", content: "padding" }))] };
            const result = await shedWireImages(JSON.stringify(body), protocol, 1000);
            assert.ok(result.body.includes(BIG.b64), "original survives both archiving and forced downscale");
            assert.ok(!result.body.includes(OTHER), "unrelated image remains eligible for byte-shed");
            assert.ok(tail ? result.stats.archived > 0 : result.stats.downscaled > 0);
        }
    }
});

test("PTC original receipt: missing, malformed, mismatched and unrelated receipts never exempt", async () => {
    const { ctx } = ctxFor("s-ptc-negative");
    const cases = ["", RECEIPT.replace("v1", "v2"), RECEIPT.slice(0, -1), `${RECEIPT} extra`,
        `Billion original image receipt v1 sha256=${"0".repeat(64)}`];
    for (const receipt of cases) {
        const input = [{ type: "function_call_output", call_id: "ptc", output: [
            { type: "input_text", text: receipt }, responseImage(BIG.b64),
        ] }];
        const steady = await applyImageRescaleItems(input, ctx) as typeof input;
        assert.ok(steady[0].output[1].image_url !== responseImage(BIG.b64).image_url, "invalid receipt follows ordinary shrink");
        const generic = await applyImageRescalePass(responsesToCoreWithToolImages({ input }).msgs, ctx);
        const rebuilt = coreToResponsesWithToolImages(generic) as typeof input;
        assert.ok(rebuilt[0].output[1].image_url !== responseImage(BIG.b64).image_url);
        const anth: BiliMessage = { id: "negative", role: "tool", contentType: "tool-result", toolName: "run_code", text: receipt,
            rawAnthropicBlock: { type: "tool_result", tool_use_id: "ptc", content: [
                { type: "text", text: receipt }, { type: "image", source: { type: "base64", media_type: "image/png", data: BIG.b64 } },
            ] } };
        const out = await applyImageRescalePass([anth], ctx);
        assert.ok(out[0] !== anth, "Anthropic invalid receipt follows ordinary shrink");
    }
    const otherOutput = [
        { type: "function_call_output", call_id: "receipt-only", output: [{ type: "input_text", text: RECEIPT }] },
        { type: "function_call_output", call_id: "image-only", output: [responseImage(BIG.b64)] },
        { type: "message", role: "user", content: [{ type: "input_text", text: RECEIPT }, responseImage(BIG.b64)] },
    ];
    const before = JSON.stringify(otherOutput);
    const out = await applyImageRescaleItems(otherOutput, ctx);
    assert.ok(!JSON.stringify(out).includes(BIG.b64), "receipt elsewhere or in a user message grants no exemption");
    assert.equal(JSON.stringify(otherOutput), before);
    clearRescaleEncodeCache();
    const freshCtx = ctxFor("s-fresh-process").ctx;
    const valid = [{ type: "function_call_output", call_id: "ptc", output: [{ type: "input_text", text: RECEIPT }, responseImage(BIG.b64)] }];
    assert.deepEqual(await applyImageRescaleItems(valid, freshCtx), valid, "receipt is stateless after cache/session reset");
    const ordinary = [{ type: "function_call_output", call_id: "ordinary", output: [responseImage(BIG.b64)] }];
    const normal = await applyImageRescaleItems(ordinary, ctxFor("s-other-session").ctx) as typeof ordinary;
    assert.ok(normal[0].output[0].image_url !== responseImage(BIG.b64).image_url, "exemption never leaks into encode cache");
    const shed = await shedWireImages(JSON.stringify({ input: otherOutput }), "responses", 1000);
    assert.ok(!shed.body.includes(BIG.b64), "byte-shed does not search unrelated outputs or user text for receipts");
});

test("PTC original receipt: Google-wire tool results protect only matching images", async () => {
    const { ctx } = ctxFor("s-ptc-google");
    const pos: BiliMessage = {
        id: "g-pos", role: "tool", contentType: "tool-result", toolName: "ipython", text: "",
        rawGoogleParts: [
            { text: RECEIPT },
            { inlineData: { mimeType: "image/png", data: BIG.b64 } },
            { inlineData: { mimeType: "image/png", data: OTHER } },
        ],
    };
    const out = await applyImageRescalePass([pos], ctx);
    assert.equal(out.length, 1);
    assert.notEqual(out[0], pos, "unrelated image must still produce a rescaled copy");
    const gp = out[0].rawGoogleParts as Array<{ inlineData?: { data?: string } }>;
    assert.equal(gp[1].inlineData?.data, BIG.b64, "receipt-bound original survives Google egress byte-identical");
    assert.notEqual(gp[2].inlineData?.data, OTHER, "unrelated PTC image still shrinks");
    const neg: BiliMessage = {
        id: "g-neg", role: "tool", contentType: "tool-result", toolName: "ipython", text: "",
        rawGoogleParts: [
            { text: RECEIPT.replace("v1", "v2") },
            { inlineData: { mimeType: "image/png", data: BIG.b64 } },
        ],
    };
    const nout = await applyImageRescalePass([neg], ctx);
    assert.notEqual(nout[0], neg, "invalid receipt follows ordinary shrink on the Google wire");
    for (const tail of [0, 9]) {
        const entry = { role: "user", parts: [
            { functionResponse: { name: "ipython", response: {} } },
            { text: RECEIPT },
            { inlineData: { mimeType: "image/png", data: BIG.b64 } },
            { inlineData: { mimeType: "image/png", data: OTHER } },
        ] };
        const body = { contents: [entry, ...Array.from({ length: tail }, () => ({ role: "user", parts: [{ text: "padding" }] }))] };
        const result = await shedWireImages(JSON.stringify(body), "google", 1000);
        assert.ok(result.body.includes(BIG.b64), "original survives both archiving and forced downscale");
        assert.ok(!result.body.includes(OTHER), "unrelated image remains eligible for byte-shed");
        assert.ok(tail ? result.stats.archived > 0 : result.stats.downscaled > 0);
    }
});
