import assert from "node:assert/strict";
import test from "node:test";
import { Jimp } from "jimp";
import { shedWireImages } from "../src/egress-shed.ts";

test("archived images do not consume the downscale work budget of the surviving tail", async () => {
    const image = new Jimp({ width: 1024, height: 1024 });
    let seed = 1977;
    const bytes = image.bitmap.data;
    for (let i = 0; i < bytes.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        bytes[i] = i % 4 === 3 ? 255 : seed >>> 24;
    }
    const original = (await image.getBuffer("image/png")).toString("base64");
    const imageItem = (b64: string) => ({ type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${b64}` }] });
    const input = [
        ...Array.from({ length: 64 }, () => imageItem(Buffer.alloc(3000, 7).toString("base64"))),
        imageItem(original),
        ...Array.from({ length: 7 }, () => ({ type: "message", role: "user", content: [{ type: "input_text", text: "tail" }] })),
    ];
    const body = JSON.stringify({ model: "m", input });
    const target = 1_000_000;
    const result = await shedWireImages(body, "responses", target);
    assert.equal(result.stats.archived, 64);
    assert.ok(result.stats.downscaled > 0, "the surviving recent image is still eligible for downscaling");
    assert.ok(result.stats.finalBytes <= target, `${result.stats.finalBytes} exceeds ${target}`);
    const parts = JSON.parse(result.body).input[64].content;
    assert.equal(parts[0].type, "input_image", "the protected tail is resized, never archived");
    const restored = await Jimp.read(Buffer.from(parts[0].image_url.split(",")[1], "base64"));
    assert.ok(restored.width < image.width);
    assert.equal(JSON.stringify({ model: "m", input }), body);
});
