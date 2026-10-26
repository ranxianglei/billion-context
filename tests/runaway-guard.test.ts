import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createRunawayGuard,
    wrapStreamWithRunawayGuard,
    ACP_TAG_THRESHOLD,
    TOOL_XML_THRESHOLD,
    type RunawayVerdict,
} from "../src/runaway-guard.ts";

// #2346 regression: intrinsic runaway-enumeration termination.
// Samples mirror the real evidence: instance A = 265 contiguous acp render tags
// m02040..m02304, all tokens="0", strictly increasing refs; instance B = a flood of
// antml tool-call XML fragments to max_tokens.

const enc = new TextEncoder();
function acpTag(ref: number, tokens = "0"): string {
    return `\x3cacp tokens="${tokens}" type="text">m${String(ref).padStart(5, "0")}\x3c/acp`;
}
function instanceAText(): string {
    // 265 tags, refs 2040..2304 (monotonic +1), every tokens="0" — the incident shape.
    return Array.from({ length: 265 }, (_, i) => acpTag(2040 + i)).join("\n");
}

test("instance-A shape (265 monotonic tokens=0 tags) trips as acp-enumeration", () => {
    const g = createRunawayGuard();
    const v = g.feed(instanceAText());
    assert.equal(v.tripped, true);
    assert.equal(v.reason, "acp-enumeration");
    assert.ok(v.detail && v.detail.acpTags >= ACP_TAG_THRESHOLD, `acpTags ${v.detail?.acpTags}`);
    assert.ok(v.detail && v.detail.maxMonotonicRefRun >= 50, `monoRun ${v.detail?.maxMonotonicRefRun}`);
});

test("instance-A split across many small chunks still trips (cross-boundary)", () => {
    const g = createRunawayGuard();
    const text = instanceAText();
    let v: RunawayVerdict = { tripped: false };
    for (let i = 0; i < text.length; i += 2) {
        v = g.feed(text.slice(i, i + 2));
        if (v.tripped) break;
    }
    assert.equal(v.tripped, true);
    assert.equal(v.reason, "acp-enumeration");
});

test("legit short message (<=11 scattered tags, varied tokens) does NOT trip", () => {
    const refs = [12, 87, 300, 45, 999, 210, 77, 500, 33, 1200, 64];
    const text = refs.map((r, i) => acpTag(r, String((i % 9) + 1))).join(" some prose between citations ");
    const v = createRunawayGuard().feed(text);
    assert.equal(v.tripped, false);
});

test("degenerate-but-completed turn (a few malformed tags + prose) does NOT trip", () => {
    // Malformed / drifted-name tags that still complete normally must never be co-blocked.
    const text =
        "here is the answer \x3cacip tokens=\"1\" type=\"text\">m0001\x3c/ap " +
        "\x3cACP tokens=\"2\">m0002\x3c/ACP> and more \x3cap tokens=0>m0003\x3c/p closing notes";
    const v = createRunawayGuard().feed(text);
    assert.equal(v.tripped, false, JSON.stringify(v.detail));
});

test("high-count (80) but NOT corroborated (non-monotonic refs, non-zero tokens) does NOT trip", () => {
    // The safety property behind the threshold hardening: raw count alone must not fire;
    // corroboration (monotonic +1 run OR near-universal tokens=0) is required.
    const text = Array.from({ length: 80 }, (_, i) => acpTag((i * 37) % 5000, String((i % 9) + 1))).join(" ");
    const v = createRunawayGuard().feed(text);
    assert.equal(v.tripped, false, JSON.stringify(v.detail));
    assert.ok(v.detail && v.detail.acpTags >= ACP_TAG_THRESHOLD, "sanity: count was above threshold");
});

test("instance-B tool-call XML flood trips as tool-xml-flood", () => {
    const text = Array.from({ length: 400 }, () => "\x3cparameter=x\x3e\x3c/parameter\x3e\x3c/invoke").join("");
    const v = createRunawayGuard().feed(text);
    assert.equal(v.tripped, true);
    assert.equal(v.reason, "tool-xml-flood");
    assert.ok(v.detail && v.detail.toolXmlFragments >= TOOL_XML_THRESHOLD);
});

test("#2451 review: tool-xml count >= threshold but spread over real content does NOT trip (corroboration required)", () => {
    // The same safety property the acp lane already had: raw fragment count alone
    // must not abort a turn — a parameter payload that legitimately CONTAINS
    // tool-shape XML (transcript export, protocol doc, fixture) spaces the
    // fragments with hundreds of bytes of real content per fragment.
    const text = Array.from({ length: 320 }, (_, i) => `<parameter name="k${i}">${"real content ".repeat(20)}(${i})</parameter>`).join("\n");
    const v = createRunawayGuard().feed(text);
    assert.equal(v.tripped, false, JSON.stringify(v.detail));
    assert.ok(v.detail && v.detail.toolXmlFragments >= TOOL_XML_THRESHOLD, "sanity: count was above threshold");
    assert.ok(v.detail && v.detail.toolXmlGapBytes / v.detail.toolXmlFragments > 64, "sanity: gap average carried the corroboration signal");
});

test("#2451 review: realistic skeleton flood (short names/values) still trips despite non-zero gaps", () => {
    const unit = '<antml:invoke name="t">\n<antml:parameter name="k">v</antml:parameter>\n</antml:invoke>';
    const text = Array.from({ length: 90 }, () => unit).join("");
    // 4 fragments per unit (invoke open/close + parameter open/close) x 90 = 360.
    const v = createRunawayGuard().feed(text);
    assert.equal(v.tripped, true, JSON.stringify(v.detail));
    assert.equal(v.reason, "tool-xml-flood");
});

test("#2451 review: skeleton flood split across tiny chunks still trips (cross-boundary gap accounting)", () => {
    const unit = '<antml:invoke name="t">\n<antml:parameter name="k">v</antml:parameter>\n</antml:invoke>';
    const text = Array.from({ length: 90 }, () => unit).join("");
    const g = createRunawayGuard();
    let v: RunawayVerdict = { tripped: false };
    for (let i = 0; i < text.length && !v.tripped; i += 7) {
        v = g.feed(text.slice(i, i + 7));
    }
    assert.equal(v.tripped, true);
    assert.equal(v.reason, "tool-xml-flood");
});

test("#2451 review: prose/fragment-alternating stream via wrapStream counts skipped-prose gaps and does NOT trip", async () => {
    // The no-angle-bracket fast path must still count its bytes toward the gap
    // average: 320 fragments spread through a turn whose prose chunks carry no
    // "<" at all. Before feedGapOnly the prose was invisible to the average and
    // the guard could abort a legitimate transcript-writing turn (#1039).
    const prose = "A long paragraph of perfectly ordinary prose without any angle bracket at all. ".repeat(6);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 160; i++) {
        parts.push(enc.encode(`<parameter name="k${i}">payload-${i}-content</parameter>`));
        parts.push(enc.encode(prose));
    }
    // 2 fragments per unit x 160 = 320 >= threshold; gap average is dominated by prose.
    const source = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });
    let tripped = false;
    const wrapped = wrapStreamWithRunawayGuard(source, () => { tripped = true; });
    const reader = wrapped.getReader();
    let bytes = 0;
    for (;;) { const r = await reader.read(); if (r.done) break; bytes += r.value.length; }
    assert.equal(tripped, false, "legit alternating turn must not trip");
    assert.equal(bytes, parts.reduce((n, p) => n + p.length, 0), "byte-exact forward");
});

test("legit multi-tool turn (dozens of fragments) does NOT trip", () => {
    const text = Array.from({ length: 10 }, () => "\x3cfunction_calls\x3e\x3cfunction\x3efoo\x3c/function\x3e\x3c/function_calls").join("\n");
    const v = createRunawayGuard().feed(text);
    assert.equal(v.tripped, false, JSON.stringify(v.detail));
});

test("long pure-prose stream (no angle brackets) passes untouched and does not trip", () => {
    const g = createRunawayGuard();
    let v: RunawayVerdict = { tripped: false };
    for (let i = 0; i < 500; i++) v = g.feed(`plain prose line number ${i} with no markup at all. `);
    assert.equal(v.tripped, false);
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const r = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

test("wrapStreamWithRunawayGuard forwards normal bytes verbatim (byte-exact)", async () => {
    const text = "hello world, no tags here\nthen a second chunk with prose.";
    const src = new ReadableStream<Uint8Array>({
        start(c) {
            c.enqueue(enc.encode(text.slice(0, 20)));
            c.enqueue(enc.encode(text.slice(20)));
            c.close();
        },
    });
    let tripped = false;
    const out = await collect(wrapStreamWithRunawayGuard(src, () => (tripped = true)));
    assert.equal(tripped, false);
    assert.equal(out.toString("utf8"), text);
});

test("wrapStreamWithRunawayGuard aborts on runaway: onTrip once, clean early EOF, byte-exact prefix", async () => {
    const tail = "TAIL-SHOULD-NOT-BE-FORWARDED";
    const src = new ReadableStream<Uint8Array>({
        start(c) {
            for (let i = 0; i < 265; i++) c.enqueue(enc.encode(acpTag(2040 + i) + "\n"));
            c.enqueue(enc.encode(tail));
            c.close();
        },
    });
    let tripCount = 0;
    const verdicts: RunawayVerdict[] = [];
    const out = await collect(
        wrapStreamWithRunawayGuard(src, (v) => {
            tripCount += 1;
            verdicts.push(v);
        }),
    );
    assert.equal(tripCount, 1);
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].reason, "acp-enumeration");
    assert.ok(!out.toString("utf8").includes(tail), "stream must end before the post-trip tail");
    // Every forwarded byte up to the trip point is verbatim (the first N complete tag lines).
    const forwarded = out.toString("utf8");
    assert.match(forwarded, /^\x3cacp tokens="0" type="text">m02040\x3c\/acp$/m);
});
