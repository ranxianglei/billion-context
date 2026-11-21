import assert from "node:assert/strict";
import test from "node:test";
import { Jimp } from "jimp";
import { createSession } from "../src/session.ts";
import { applyImageRescalePass, clearRescaleEncodeCache, shedDownscaleImage } from "../src/image-rescale.ts";

// Isolate the rescale knob from any host config: the pass must run on the
// default (enabled) posture, matching the issue3400 suite's isolation.
process.env.BILI_CONFIG_FILE = "/nonexistent/bili-image-rescale-cache-budget.json";

// Exercise the production admission/eviction paths with small payloads; the
// real-codec benchmark uses the unchanged default 64 MiB budget.
test.beforeEach(() => clearRescaleEncodeCache(64));
test.afterEach(() => clearRescaleEncodeCache());

function input(index: number): string {
    const header = Buffer.alloc(128);
    header.set([0x89, 0x50, 0x4e, 0x47]);
    header.writeUInt32BE(2, 16);
    header.writeUInt32BE(1, 20);
    header.writeUInt32BE(index, 24);
    return header.toString("base64");
}

test("image encodes evict retained payloads before the 512-entry count cap", async (t) => {
    // Isolate cache ownership from codec cost: seven 12-byte base64 results
    // exceed the test budget. Both egress paths share that same budget.
    const pixels = new Jimp({ width: 2, height: 1 });
    const encoded = Buffer.alloc(8);
    let reads = 0;
    t.mock.method(pixels, "getBuffer", async () => encoded);
    t.mock.method(pixels, "resize", () => pixels);
    t.mock.method(Jimp, "read", async () => {
        reads++;
        return pixels;
    });
    const session = createSession("image-cache-budget");
    const ctx = { session, sessionId: session.id, maxDim: 1, toolArmed: false, log: () => {} };
    const encode = async (index: number) => {
        const [out] = await applyImageRescalePass([{ id: `image-${index}`, role: "user", contentType: "text", imageBase64: input(index), imageMediaType: "image/png" }], ctx);
        assert.equal(out!.imageBase64!.length, encoded.toString("base64").length);
    };
    for (let i = 0; i < 6; i++) await encode(i);
    assert.equal(await shedDownscaleImage("image/png", input(99), 1), encoded.toString("base64"));
    assert.equal(reads, 7);
    await encode(5);
    assert.equal(reads, 7, "the newest image stays cached");
    await encode(0);
    assert.equal(reads, 8, "the oldest payload must be released before 512 large images accumulate");
});

test("simultaneous requests share one image encode", async (t) => {
    const pixels = new Jimp({ width: 2, height: 1 });
    const encoded = Buffer.from("small encoded output");
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    t.mock.method(pixels, "getBuffer", async () => encoded);
    t.mock.method(Jimp, "read", async () => { reads++; await gate; return pixels; });
    const a = shedDownscaleImage("image/png", input(0), 1);
    const b = shedDownscaleImage("image/png", input(0), 1);
    release!();
    assert.equal(await a, encoded.toString("base64"));
    assert.equal(await b, encoded.toString("base64"));
    assert.equal(reads, 1);
});

test("an oversized result is returned without evicting smaller cached images", async (t) => {
    const pixels = new Jimp({ width: 2, height: 1 });
    let encoded = Buffer.alloc(8);
    let reads = 0;
    t.mock.method(pixels, "resize", () => pixels);
    t.mock.method(pixels, "getBuffer", async () => encoded);
    t.mock.method(Jimp, "read", async () => { reads++; return pixels; });
    const small = await shedDownscaleImage("image/png", input(0), 1);
    encoded = Buffer.alloc(60); // 80 base64 bytes, larger than the entire budget
    const large = await shedDownscaleImage("image/png", input(1), 1);
    assert.equal(large, encoded.toString("base64"));
    assert.equal(await shedDownscaleImage("image/png", input(0), 1), small);
    assert.equal(reads, 2, "an oversized result must not displace the useful small entry");
    assert.equal(await shedDownscaleImage("image/png", input(1), 1), large, "re-encoding is byte-identical");
    assert.equal(reads, 3, "the oversized result is not retained");
});

test("clearing during an encode does not let its completion alter a newer entry", async (t) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    t.mock.method(Jimp, "read", async () => {
        const call = ++reads;
        const pixels = new Jimp({ width: 2, height: 1 });
        t.mock.method(pixels, "getBuffer", async () => {
            if (call === 1) await gate;
            return Buffer.alloc(call === 1 ? 60 : 8);
        });
        return pixels;
    });
    const old = shedDownscaleImage("image/png", input(0), 1);
    clearRescaleEncodeCache(64);
    const current = await shedDownscaleImage("image/png", input(0), 1);
    release!();
    assert.equal(await old, Buffer.alloc(60).toString("base64"));
    assert.equal(await shedDownscaleImage("image/png", input(0), 1), current);
    assert.equal(reads, 2, "the older completion cannot evict/account the replacement entry");
});

test("failed encodes retain the existing 512-entry bound", async (t) => {
    let reads = 0;
    t.mock.method(Jimp, "read", async () => { reads++; throw new Error("decode failure"); });
    for (let i = 0; i < 513; i++) assert.equal(await shedDownscaleImage("image/png", input(i), 1), null);
    assert.equal(reads, 513);
    assert.equal(await shedDownscaleImage("image/png", input(512), 1), null);
    assert.equal(reads, 513, "negative results still share the cache");
    assert.equal(await shedDownscaleImage("image/png", input(0), 1), null);
    assert.equal(reads, 514, "zero-byte results cannot grow without the count cap");
});

test("payload pressure retains pending entries for in-flight de-duplication", async (t) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    t.mock.method(Jimp, "read", async () => {
        const call = ++reads;
        const pixels = new Jimp({ width: 2, height: 1 });
        t.mock.method(pixels, "getBuffer", async () => {
            if (call === 1) await gate;
            return Buffer.alloc(8);
        });
        return pixels;
    });
    const first = shedDownscaleImage("image/png", input(0), 1);
    for (let i = 1; i <= 6; i++) await shedDownscaleImage("image/png", input(i), 1);
    const same = shedDownscaleImage("image/png", input(0), 1);
    release!();
    assert.equal(await first, await same);
    assert.equal(reads, 7, "byte eviction only removes completed payloads");
});

test("a normal reset restores the production budget after a test override", async (t) => {
    const pixels = new Jimp({ width: 2, height: 1 });
    let reads = 0;
    t.mock.method(pixels, "resize", () => pixels);
    t.mock.method(pixels, "getBuffer", async () => Buffer.alloc(8));
    t.mock.method(Jimp, "read", async () => { reads++; return pixels; });
    clearRescaleEncodeCache(1);
    await shedDownscaleImage("image/png", input(0), 1);
    await shedDownscaleImage("image/png", input(0), 1);
    assert.equal(reads, 2);
    clearRescaleEncodeCache();
    await shedDownscaleImage("image/png", input(0), 1);
    await shedDownscaleImage("image/png", input(0), 1);
    assert.equal(reads, 3, "the default reset restores normal cache admission");
});

test("forced within-maxDim: the 100 KiB trigger gate skips small, re-encodes large", async (t) => {
    // A 1x1 image is within maxDim=1 (scale=1, no downscale). The forced path's
    // trigger gate is a cheap pre-filter: below-trigger images are skipped entirely
    // (no decode/re-encode), above-trigger images are re-encoded at the same dims and
    // adopted only if strictly smaller. Pins both directions (#3617).
    const pixels = new Jimp({ width: 1, height: 1 });
    t.mock.method(pixels, "getBuffer", async () => Buffer.alloc(8));
    t.mock.method(Jimp, "read", async () => pixels);

    const below = "a".repeat(136532); // b64Bytes = 102399, below the 100 KiB trigger
    const above = "a".repeat(136536); // b64Bytes = 102402, above the trigger

    assert.equal(await shedDownscaleImage("image/png", below, 1), null, "below trigger is skipped");
    assert.equal(await shedDownscaleImage("image/png", above, 1), Buffer.alloc(8).toString("base64"), "above trigger is re-encoded and adopted");
});
