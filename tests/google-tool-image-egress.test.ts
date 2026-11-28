import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Jimp } from "jimp";
import { googleToCore, coreToGoogle, type GoogleRequestBody } from "acp-kernel/wire";
import { READ_ORIGINAL_IMAGE_TOOL_NAME } from "../src/compress-tool.js";
import { postShedImageView, shedWireImages, shedWireImagesToCount } from "../src/egress-shed.js";
import { applyImageRescalePass, clearRescaleEncodeCache } from "../src/image-rescale.js";
import { countImagesInRawBody, decodeImageDims } from "../src/image-tokens.js";
import { createSession } from "../src/session.js";

process.env.BILI_CONFIG_FILE = "/nonexistent/bili-google-tool-images.json";
process.env.BILI_IMAGE_RESCALE = "1";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const OTHER = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
const NOTE = "[image: png 1x1 m00123 omitted for size limit]";
const opts = { resolveRef: async () => "m00123" };
const image = (data = PNG, displayName?: string) => ({ inlineData: { mimeType: "image/png", data, ...(displayName ? { displayName } : {}) } });
const responsePart = (parts: unknown[], response: unknown = { output: "captured" }, name = "screenshot") => ({ functionResponse: { id: "capture", name, response, parts } });
const body = (parts: unknown[], tail = 0) => JSON.stringify({ contents: [
    { role: "user", parts },
    ...Array.from({ length: tail }, (_, i) => ({ role: i % 2 ? "user" : "model", parts: [{ text: `tail ${i}` }] })),
] });

for (const model of ["gemini-test", "claude-test"]) {
    test(`nested Google count shedding preserves ${model} part order and tool data`, async () => {
        const response = { output: "captured", metadata: { count: 2, ok: true } };
        const original = body([responsePart([image(), image(OTHER)], response)]);
        const result = await shedWireImagesToCount(original, "google", 1, { ...opts, model });
        assert.equal(result.stats.archived, 1);
        assert.equal(countImagesInRawBody("google", result.body), 1);
        const parts = JSON.parse(result.body).contents[0].parts;
        const fr = parts.find((p: Record<string, unknown>) => p.functionResponse).functionResponse;
        assert.deepEqual(fr, { id: "capture", name: "screenshot", response, parts: [image(OTHER)] });
        assert.deepEqual(parts[model.startsWith("claude") ? 1 : 0], { text: NOTE });
        assert.equal(await shedWireImagesToCount(result.body, "google", 1, { ...opts, model }).then(r => r.body), result.body);
        assert.equal(original, body([responsePart([image(), image(OTHER)], response)]));
    });
}

test("mixed top-level and nested archives never shift a sibling image or tool result", async () => {
    const original = body([image(), responsePart([image(), image(OTHER)]), image(OTHER), responsePart([], { output: "untouched" }, "other")]);
    const result = await shedWireImagesToCount(original, "google", 0, opts);
    assert.equal(result.stats.archived, 4);
    assert.equal(countImagesInRawBody("google", result.body), 0);
    const parts = JSON.parse(result.body).contents[0].parts;
    assert.equal(parts.filter((p: { text?: string }) => p.text === NOTE).length, 4);
    assert.deepEqual(parts.filter((p: Record<string, unknown>) => p.functionResponse), [responsePart([]), responsePart([], { output: "untouched" }, "other")]);
});

test("archiving a named image replaces only its exact JSON references", async () => {
    const remote = { fileData: { mimeType: "application/pdf", fileUri: "gs://bucket/doc.pdf", displayName: "doc.pdf" } };
    const response = { output: [{ image: { $ref: "shot.png" }, label: "screen" }, { $ref: "doc.pdf" }], metadata: { $ref: "shot.png", literal: true }, count: 2 };
    const result = await shedWireImagesToCount(body([responsePart([image(PNG, "shot.png"), remote, image(OTHER)], response)]), "google", 1, opts);
    const parts = JSON.parse(result.body).contents[0].parts;
    assert.equal(parts.length, 1, "the existing reference slot carries the note without a new sibling");
    assert.deepEqual(parts[0].functionResponse.response, { ...response, output: [{ image: NOTE, label: "screen" }, { $ref: "doc.pdf" }] });
    assert.deepEqual(parts[0].functionResponse.parts, [remote, image(OTHER)]);
    assert.equal(result.stats.archived, 1);
});

test("a root image reference becomes a standard structured function output", async () => {
    const result = await shedWireImagesToCount(body([responsePart([image(PNG, "shot.png")], { $ref: "shot.png" })]), "google", 0, opts);
    const parts = JSON.parse(result.body).contents[0].parts;
    assert.deepEqual(parts, [responsePart([], { output: NOTE })]);
});

test("nested non-image inline data and remote file parts remain byte-identical", async () => {
    const preserved = [
        { inlineData: { mimeType: "application/pdf", data: PNG } },
        { inlineData: { mimeType: "audio/wav", data: PNG } },
        { inlineData: { data: PNG } },
        { fileData: { mimeType: "image/png", fileUri: "gs://bucket/image.png" } },
    ];
    const unchanged = body([responsePart(preserved)]);
    assert.equal((await shedWireImagesToCount(unchanged, "google", 0, opts)).body, unchanged);
    const result = await shedWireImagesToCount(body([responsePart([...preserved, image()])]), "google", 0, opts);
    assert.equal(result.stats.archived, 1);
    assert.deepEqual(JSON.parse(result.body).contents[0].parts.find((p: Record<string, unknown>) => p.functionResponse).functionResponse.parts, preserved);
});

test("a nested original-image receipt protects only matching bytes in its own response", async () => {
    const receipt = `Billion original image receipt v1 sha256=${createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex")}`;
    const original = body([responsePart([image(), image(OTHER)], { output: receipt }, "ipython"), responsePart([image()], { output: "ordinary" }, "screenshot")]);
    const result = await shedWireImagesToCount(original, "google", 0, opts);
    assert.equal(result.stats.archived, 2);
    assert.equal(countImagesInRawBody("google", result.body), 1);
    const responses = JSON.parse(result.body).contents[0].parts.filter((p: Record<string, unknown>) => p.functionResponse);
    assert.deepEqual(responses[0].functionResponse.parts, [image()]);
    assert.deepEqual(responses[1].functionResponse.parts, []);
});

test("nested read-original outputs count against the cap without being archived", async () => {
    const result = await shedWireImagesToCount(body([responsePart([image()], { output: "restored" }, READ_ORIGINAL_IMAGE_TOOL_NAME), responsePart([image(OTHER)])]), "google", 1, opts);
    assert.equal(result.stats.archived, 1);
    const responses = JSON.parse(result.body).contents[0].parts.filter((p: Record<string, unknown>) => p.functionResponse);
    assert.deepEqual(responses[0].functionResponse.parts, [image()]);
    assert.deepEqual(responses[1].functionResponse.parts, []);
});

test("byte shedding and its token projection include nested old tool images", async t => {
    const previous = process.env.BILI_HTTP_OUTBOUND_BYTES;
    process.env.BILI_HTTP_OUTBOUND_BYTES = "1000";
    t.after(() => {
        if (previous === undefined) delete process.env.BILI_HTTP_OUTBOUND_BYTES;
        else process.env.BILI_HTTP_OUTBOUND_BYTES = previous;
    });
    const original = body([responsePart([image(Buffer.alloc(3000, 7).toString("base64"))])], 8);
    const projected = postShedImageView(original, "google");
    assert.equal(projected.sheddable, true);
    assert.equal(countImagesInRawBody("google", projected.body), 0);
    const result = await shedWireImages(original, "google", 1000, opts);
    assert.equal(result.stats.archived, 1);
    assert.ok(result.stats.finalBytes <= 1000);
    assert.equal(countImagesInRawBody("google", result.body), 0);
});

test("byte shedding downscales protected nested images without changing their references", async () => {
    const large = (await new Jimp({ width: 2048, height: 1024, color: 0x88aaccff }).getBuffer("image/png", { deflateLevel: 0 })).toString("base64");
    const response = { image: { $ref: "shot.png" }, detail: "keep" };
    const result = await shedWireImages(body([responsePart([image(large, "shot.png")], response)]), "google", 50_000, opts);
    assert.equal(result.stats.archived, 0, "the recent tool result stays inside the protected tail");
    assert.equal(result.stats.downscaled, 1);
    assert.ok(result.stats.finalBytes <= 50_000);
    const fr = JSON.parse(result.body).contents[0].parts[0].functionResponse;
    assert.deepEqual(fr.response, response);
    assert.equal(fr.parts[0].inlineData.displayName, "shot.png");
    assert.deepEqual(decodeImageDims(fr.parts[0].inlineData.data), { w: 1024, h: 512 });
});

test("nested rescale exemptions stay within the returned image and function response", async () => {
    const large = (await new Jimp({ width: 512, height: 256, color: 0x88aaccff }).getBuffer("image/png")).toString("base64");
    const different = (await new Jimp({ width: 512, height: 256, color: 0x112233ff }).getBuffer("image/png")).toString("base64");
    const receipt = `Billion original image receipt v1 sha256=${createHash("sha256").update(Buffer.from(large, "base64")).digest("hex")}`;
    const preserved = [
        { inlineData: { mimeType: "application/pdf", data: large } },
        { inlineData: { mimeType: "audio/wav", data: large } },
        { inlineData: { data: large } },
        { fileData: { mimeType: "image/png", fileUri: "gs://bucket/image.png" } },
        image(),
    ];
    const input = googleToCore({ contents: [{ role: "user", parts: [
        responsePart([image(large), image(different), ...preserved], { output: [{ text: receipt }] }, "ipython"),
        responsePart([image(large)], { output: "ordinary" }),
        responsePart([image(large)], { output: "restored" }, READ_ORIGINAL_IMAGE_TOOL_NAME),
    ] }] } as GoogleRequestBody).msgs;
    const original = JSON.stringify(input);
    const session = createSession("nested-rescale-exemptions");
    const output = await applyImageRescalePass(input, { session, sessionId: session.id, maxDim: 16, toolArmed: false, log: () => {} });
    const responses = coreToGoogle(output).flatMap(c => c.parts).filter(p => p.functionResponse).map(p => p.functionResponse!);
    assert.equal(responses[0].parts![0].inlineData!.data, large);
    assert.notEqual(responses[0].parts![1].inlineData!.data, different, "the receipt only protects its matching image");
    assert.deepEqual(responses[0].parts!.slice(2), preserved, "non-image, remote and already-small parts keep their bytes");
    assert.notEqual(responses[1].parts![0].inlineData!.data, large, "the sibling output cannot borrow the receipt");
    assert.equal(responses[2].parts![0].inlineData!.data, large, "the direct read-original output remains intact");
    assert.equal(output.filter(m => m.id.startsWith("acp_imgnote_")).length, 2);
    assert.equal(JSON.stringify(input), original);
});

for (const model of ["gemini-test", "claude-test"]) {
    test(`nested Google rescale survives the ${model} core round-trip with exact refs`, async () => {
        clearRescaleEncodeCache();
        const large = (await new Jimp({ width: 512, height: 256, color: 0x88aaccff }).getBuffer("image/png")).toString("base64");
        const request = { contents: [
            { role: "user", parts: [{ text: "capture" }] },
            { role: "model", parts: [{ functionCall: { id: "capture", name: "screenshot", args: {} } }] },
            { role: "user", parts: [responsePart([image(large, "shot.png")], { image: { $ref: "shot.png" }, detail: "keep" })] },
        ] } as GoogleRequestBody;
        const input = googleToCore(request).msgs;
        const original = JSON.stringify(input);
        const session = createSession(`nested-rescale-${model}`);
        const tool = input.find(m => m.role === "tool")!;
        session.state.messageRefs.byRaw[tool.id] = "m00123";
        const output = await applyImageRescalePass(input, { session, sessionId: session.id, maxDim: 16, toolArmed: true, log: () => {} });
        assert.notEqual(output, input);
        const rendered = coreToGoogle(output, { model });
        const parts = rendered[rendered.length - 1].parts;
        const fr = parts.find(p => p.functionResponse)!.functionResponse!;
        const inline = fr.parts![0].inlineData!;
        assert.notEqual(inline.data, large);
        assert.deepEqual(decodeImageDims(inline.data), { w: 16, h: 8 });
        assert.deepEqual(fr.response, { image: { $ref: "shot.png" }, detail: "keep" });
        assert.equal((inline as { displayName?: string }).displayName, "shot.png");
        const note = parts.find(p => typeof p.text === "string")!.text!;
        assert.equal(note, '[bili][resized] 本图已降采样/downsampled: now 16×8 (0KB), original 512×256 (1KB). (≈10.8×) Call acp_read_original_image("m00123") to read the original when full-resolution detail matters (small text, colors, alignment). 需要原分辨率细节时调用该工具读取原图,按需读取。');
        assert.equal(parts[model.startsWith("claude") ? 0 : 1].functionResponse, fr);
        assert.equal(JSON.stringify(input), original, "only the outbound copy changes");
    });
}
