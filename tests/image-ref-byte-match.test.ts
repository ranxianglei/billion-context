import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jimp } from "jimp";
import { createSession } from "../src/session.js";
import { applyImageRescaleItems, executeReadOriginalImage, refForItemBytes } from "../src/image-rescale.js";
import { shedWireImages } from "../src/egress-shed.js";
import type { IndexedImage } from "../src/image-restore.js";

const root = mkdtempSync(join(tmpdir(), "image-ref-byte-match-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
let next = 0;
function fixture() {
    const session = createSession(`image-ref-byte-match-${next++}`);
    session.incomingImageIndex = new Map<string, IndexedImage[]>();
    const add = (ref: string, bytes: Buffer, present = true): void => {
        const path = join(root, `${next++}.png`);
        if (present) writeFileSync(path, bytes);
        const entries = session.incomingImageIndex!.get(ref) ?? [];
        entries.push({ mediaType: "image/png", bytes: bytes.length, path });
        session.incomingImageIndex!.set(ref, entries);
    };
    return { session, add };
}

test("a sole same-size candidate must match the actual image bytes", async () => {
    const { session, add } = fixture();
    add("m12345", Buffer.from("other"));
    assert.equal(await refForItemBytes(session, "image/png", Buffer.from("image").toString("base64")), undefined);
});

test("a sole evicted spill does not advertise an unreadable original", async () => {
    const { session, add } = fixture();
    const bytes = Buffer.from("image");
    add("m12345", bytes, false);
    assert.equal(await refForItemBytes(session, "image/png", bytes.toString("base64")), undefined);
});

test("a sole exact match still resolves, with MIME and length prefilters", async () => {
    const { session, add } = fixture();
    const bytes = Buffer.from("image");
    add("m12345", bytes);
    assert.equal(await refForItemBytes(session, "image/png", bytes.toString("base64")), "m12345");
    assert.equal(await refForItemBytes(session, "image/jpeg", bytes.toString("base64")), undefined);
    assert.equal(await refForItemBytes(session, "image/png", Buffer.from("longer").toString("base64")), undefined);
});

test("distinct same-size candidates select only the matching original", async () => {
    const { session, add } = fixture();
    add("m11111", Buffer.from("other"));
    add("m22222", Buffer.from("image"));
    assert.equal(await refForItemBytes(session, "image/png", Buffer.from("image").toString("base64")), "m22222");
});

test("identical bytes under different refs remain ambiguous", async () => {
    const { session, add } = fixture();
    const bytes = Buffer.from("image");
    add("m11111", bytes);
    add("m22222", bytes);
    assert.equal(await refForItemBytes(session, "image/png", bytes.toString("base64")), undefined);
});

test("duplicate entries under one ref are not ambiguous", async () => {
    const { session, add } = fixture();
    const bytes = Buffer.from("image");
    add("m11111", bytes);
    add("m11111", bytes);
    assert.equal(await refForItemBytes(session, "image/png", bytes.toString("base64")), "m11111");
});

test("rescale then byte-shed never labels a red image with a same-size blue original", async () => {
    const oldEnabled = process.env.BILI_IMAGE_RESCALE;
    process.env.BILI_IMAGE_RESCALE = "1";
    try {
        const red = await new Jimp({ width: 2400, height: 100, color: 0xff0000ff }).getBuffer("image/png");
        const blue = await new Jimp({ width: 1600, height: 67, color: 0x0000ffff }).getBuffer("image/png");
        const { session, add } = fixture();
        add("m11111", red);
        add("m22222", blue);
        const image = (bytes: Buffer) => ({ type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${bytes.toString("base64")}` }] });
        const input = [image(red), image(blue), ...Array.from({ length: 8 }, (_, i) => ({ type: "message", role: "user", content: [{ type: "input_text", text: `tail ${i}` }] }))];
        const original = JSON.stringify(input);
        const scaled = await applyImageRescaleItems(input, { session, sessionId: session.id, log: () => {}, maxDim: 1600, toolArmed: true }) as { content: { type: string; image_url?: string; text?: string }[] }[];
        const scaledRed = Buffer.from(scaled[0].content[0].image_url!.split(",")[1], "base64");
        assert.equal(scaledRed.length, blue.length, "real red/blue PNGs have identical encoded lengths");
        assert.notDeepEqual(scaledRed, blue, "the equal-size PNGs have different pixels");
        assert.match(scaled[0].content[1].text!, /m11111/);
        const body = JSON.stringify({ model: "fixture", input: scaled });
        const shed = await shedWireImages(body, "responses", Buffer.byteLength(body) - 500, {
            resolveRef: (mime, b64) => refForItemBytes(session, mime, b64),
        });
        assert.equal(shed.stats.archived, 1);
        assert.ok(shed.stats.finalBytes <= Buffer.byteLength(body) - 500);
        const note = JSON.parse(shed.body).input[0].content[0].text as string;
        assert.match(note, /omitted for size limit/);
        assert.doesNotMatch(note, /m22222/, "the archive note must not send the model to the unrelated blue image");
        const restored = await executeReadOriginalImage({ ref: "m11111" }, session, () => {});
        assert.equal(restored.image?.base64, red.toString("base64"));
        assert.equal(JSON.stringify(input), original, "inbound history is unchanged");
    } finally {
        if (oldEnabled === undefined) delete process.env.BILI_IMAGE_RESCALE;
        else process.env.BILI_IMAGE_RESCALE = oldEnabled;
    }
});
