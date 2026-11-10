// #5745: an image-dense session (>64 inline history images) on the plain/proxy HTTP relay lane
// resends tens of MiB of base64 every round. The egress byte-shed capped its work list at
// MAX_SHED_IMAGES (64) for BOTH rungs, so once a session had more than 64 sheddable images the
// excess bytes could never be removed — the body stayed over the network.httpOutboundBytes cap,
// upstream rejected it (400, no overflow marker), nothing self-healed, and the session retried
// the identical over-budget body forever ("shed to X MiB but still over budget … sending anyway").
//
// This suite pins the fix: rung A (archiving) is a cheap string swap, NOT a jimp pass, so it must
// walk EVERY non-tail occurrence until the estimate fits — the 64-image bound stays only on rung B
// (downscale), where it bounds per-request decode/re-encode CPU. The protected-tail invariant is
// deliberately UNCHANGED here (tail is still never archived, only downscaled); yielding the tail
// when even that falls short is a separate design decision, not part of this fix.
import assert from "node:assert/strict";
import test from "node:test";
import { shedWireImages } from "../src/egress-shed.ts";

type Item = Record<string, unknown>;

/** Incompressible-noise base64 blob (~rawBytes of payload → ~4/3 rawBytes of base64). jimp cannot
 *  decode it, so rung B (downscale) yields null and only rung A (archive) reduces the size —
 *  predictable math. */
function fakeB64(seed: number, rawBytes = 100_000): string {
    const buf = Buffer.alloc(rawBytes);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + seed * 7) % 256;
    return buf.toString("base64");
}

const userImage = (text: string, b64: string): Item => ({
    type: "message",
    role: "user",
    content: [
        { type: "input_text", text },
        { type: "input_image", image_url: `data:image/png;base64,${b64}` },
    ],
});

const bodyWith = (n: number): string => {
    const input: Item[] = [];
    for (let i = 0; i < n; i++) input.push(userImage(`image ${i}`, fakeB64(i + 1)));
    return JSON.stringify({ model: "m", input });
};

test("#5745: more than 64 images → rung A archives past the old cap to actually reach the budget", async () => {
    // 100 x ~130 KiB of base64 ≈ 13.3 MiB body. Budget 3 MiB needs ~78 images archived — far past
    // the old 64-image work cap. Pre-fix, rung A stopped at 64 and left ~4.8 MiB (still over), so
    // BOTH assertions below fail on the old code.
    const body = bodyWith(100);
    const targetBytes = 3_000_000;
    const out = await shedWireImages(body, "responses", targetBytes);
    assert.equal(out.stats.changed, true, "over-budget image-dense body is shed");
    assert.ok(out.stats.archived > 64, `archived ${out.stats.archived} images (old code capped at 64)`);
    assert.ok(out.stats.finalBytes <= targetBytes, `${out.stats.finalBytes} <= ${targetBytes} (reached budget)`);
});

test("#5745: reaching the budget via non-tail archiving leaves the protected tail untouched", async () => {
    // 30 images, budget reachable by archiving a handful of OLD (non-tail) images. The last 8
    // entries are the protected tail and must keep their images — Defect 1 lifts the cap, it does
    // NOT start archiving recent images.
    const n = 30;
    const body = bodyWith(n);
    const targetBytes = 2_000_000;
    const out = await shedWireImages(body, "responses", targetBytes);
    assert.ok(out.stats.finalBytes <= targetBytes, `${out.stats.finalBytes} <= ${targetBytes}`);
    const input = (JSON.parse(out.body) as { input: Item[] }).input;
    const protectFrom = n - 8;
    for (let i = protectFrom; i < n; i++) {
        const content = input[i].content as Item[];
        assert.equal(content[1].type, "input_image", `protected-tail entry ${i} keeps its image`);
    }
});

test("#5745 boundary: when non-tail archiving + downscaling cannot reach budget, the tail is NOT yielded (still 'send anyway')", async () => {
    // Pins the edge between this fix and the pending decision (yield-the-tail). 12 images, an
    // impossibly tight budget: archiving the 4 non-tail images plus a failed jimp downscale of the
    // noise still leaves the body far over target. Defect 1 must stop there — archive only the
    // non-tail, leave the tail intact, and report still-over (it does NOT start eating the tail).
    const n = 12;
    const body = bodyWith(n);
    const targetBytes = 100_000;
    const out = await shedWireImages(body, "responses", targetBytes);
    assert.equal(out.stats.archived, 4, "only the 4 non-tail images are archived (entries 0..3)");
    assert.ok(out.stats.finalBytes > targetBytes, `${out.stats.finalBytes} > ${targetBytes} — still over, tail not yielded`);
    const input = (JSON.parse(out.body) as { input: Item[] }).input;
    for (let i = 4; i < n; i++) {
        const content = input[i].content as Item[];
        assert.equal(content[1].type, "input_image", `entry ${i} (tail) keeps its image — not yielded by this fix`);
    }
});
