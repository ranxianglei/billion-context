import assert from "node:assert/strict";
import test from "node:test";
import { shedWireImages, shedWireImagesToCount } from "../src/egress-shed.ts";

const data = Buffer.alloc(3000, 7).toString("base64");
const media = (mimeType?: string) => ({ inlineData: { ...(mimeType === undefined ? {} : { mimeType }), data } });
const tail = Array.from({ length: 8 }, (_, i) => ({ role: "user", parts: [{ text: `tail ${i}` }] }));

for (const mime of ["audio/wav", "video/mp4", "application/pdf", "application/octet-stream", undefined]) {
    test(`image byte shedding preserves inline media declared as ${mime ?? "unknown"}`, async () => {
        const body = JSON.stringify({ contents: [{ role: "user", parts: [media(mime)] }, ...tail] });
        const result = await shedWireImages(body, "google", 100);
        assert.equal(result.body, body);
        assert.equal(result.stats.changed, false);
    });
}

test("image count limits do not count or archive non-image inline parts", async () => {
    const parts = [media("audio/wav"), media("application/pdf"), media("video/mp4"), media()];
    const body = JSON.stringify({ contents: [{ role: "user", parts }] });
    const result = await shedWireImagesToCount(body, "google", 0);
    assert.equal(result.body, body);
    assert.equal(result.stats.archived, 0);
});

test("a mixed-media byte budget archives images while retaining the document", async () => {
    const document = media("application/pdf");
    const body = JSON.stringify({ contents: [{ role: "user", parts: [document, media("image/png")] }, ...tail] });
    const result = await shedWireImages(body, "google", 5000);
    const parts = JSON.parse(result.body).contents[0].parts;
    assert.deepEqual(parts[0], document);
    assert.match(parts[1].text, /omitted for size limit/);
    assert.equal(result.stats.archived, 1);
    assert.ok(result.stats.finalBytes <= 5000);
});

test("a mixed-media count cap archives only the oldest surplus image", async () => {
    const audio = media("audio/wav");
    const newest = media("image/jpeg");
    const body = JSON.stringify({ contents: [{ role: "user", parts: [audio, media("image/png"), newest] }] });
    const result = await shedWireImagesToCount(body, "google", 1);
    const parts = JSON.parse(result.body).contents[0].parts;
    assert.deepEqual(parts[0], audio);
    assert.match(parts[1].text, /omitted for size limit/);
    assert.deepEqual(parts[2], newest);
    assert.equal(result.stats.archived, 1);
});
