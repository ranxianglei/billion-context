// #2868: the body-stability LCP compared UTF-16 code units but every consumer
// treated the result as UTF-8 bytes — LedgerLine.bl, SeamEvent.lcpBytes, the
// 1024-byte head threshold, the ±64-byte append tolerance and the 512 KiB /
// 8 MiB caps. Non-ASCII bodies got wrong offsets (up to 3× short on CJK) and
// misclassified divergence classes. These tests pin the byte-unit contract
// end-to-end: capture (noteForwardedBody) → settle (bl/bs) → seam forensics
// (lcpBytes). The expected values come from an independent reference that
// walks real UTF-8 Buffers — never from the implementation under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { noteForwardedBody, settleUsageReport, getCacheLedger } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `byteu8-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const T0 = Date.parse("2026-10-12T10:00:00Z");

function settle(session: Session, at: number, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

function lastLine(s: Session): { be?: number; bl?: number; bs?: string; bd?: string } {
    const led = getCacheLedger(s);
    return led.lines[led.lines.length - 1]!;
}

function pair(s: Session, b1: string, b2: string): { be?: number; bl?: number; bs?: string; bd?: string } {
    noteForwardedBody(s, b1);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, b2);
    settle(s, T0 + 1000, 100_000, 90_000);
    return lastLine(s);
}

function utf8Lcp(a: string, b: string): number {
    const aa = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    let n = 0;
    while (n < Math.min(aa.length, bb.length) && aa[n] === bb[n]) n++;
    return n;
}

function codeUnitLcp(a: string, b: string): number {
    let n = 0;
    const lim = Math.min(a.length, b.length);
    while (n < lim && a.charCodeAt(n) === b.charCodeAt(n)) n++;
    return n;
}

test("the issue's five synthetic pairs report true UTF-8 byte offsets", () => {
    const cases: Array<[string, string, number]> = [
        ["abcX", "abcY", 3],
        ["中X", "中Y", 3],
        ["\u4e2d", "\u4e2e", 2],
        ["\u4e2d".repeat(400) + "A".repeat(200), "\u4e2d".repeat(400) + "B".repeat(200), 1200],
        [String.fromCodePoint(0x20000) + "X", String.fromCodePoint(0x20400) + "Y", 2],
    ];
    for (const [a, b, want] of cases) {
        const s = makeSession();
        const line = pair(s, a, b);
        assert.equal(line.be, 0);
        assert.equal(line.bl, want, `byte LCP must count UTF-8 bytes (case ${JSON.stringify(a.slice(0, 8))})`);
    }
});

test("CJK pair with a 1200-byte LCP classifies mid, not head (the #2868 regression)", () => {
    const s = makeSession();
    const line = pair(s, "\u4e2d".repeat(400) + "A".repeat(200), "\u4e2d".repeat(400) + "B".repeat(200));
    // Each payload is 1400 bytes; 1200 is past the 1024-byte head threshold and
    // not within ±64 of the tail → mid. The old code-unit math read 400 → head.
    assert.equal(line.bs, "mid");
});

test("non-ASCII divergence inside the first 1 KiB reports the byte-exact head offset", () => {
    const s = makeSession();
    const a = "A".repeat(100) + "\u4e2dX" + "A".repeat(1000);
    const b = "A".repeat(100) + "\u4e2dY" + "A".repeat(1000);
    const line = pair(s, a, b);
    assert.equal(line.bl, 103, "100 ASCII bytes plus the full 3-byte CJK char survive (old code read 101 code units)");
    assert.equal(line.bs, "head");
});

test("JSON request: divergence inside a Chinese message reports the JSON byte offset", () => {
    const s = makeSession();
    const b1 = JSON.stringify({ model: "m", messages: [{ role: "user", content: "p".repeat(1200) }, { role: "user", content: "相同前缀甲" }, { role: "user", content: "q".repeat(400) }] });
    const b2 = JSON.stringify({ model: "m", messages: [{ role: "user", content: "p".repeat(1200) }, { role: "user", content: "相同前缀乙" }, { role: "user", content: "q".repeat(400) }] });
    const line = pair(s, b1, b2);
    assert.equal(line.be, 0);
    assert.equal(line.bl, utf8Lcp(b1, b2));
    assert.ok(line.bl !== undefined && line.bl > 1024 && line.bl < Buffer.byteLength(b1) - 64, "divergence sits mid-body in the JSON text");
    assert.equal(line.bs, "mid");
    assert.equal(line.bd, createHash("sha256").update(b2, "utf8").digest("hex"), "digest stays the ground-truth equality proof");
});

test("append and trim with CJK content keep the append class at byte-exact offsets", () => {
    const one = { role: "user", content: "中文内容" };
    const two = { role: "user", content: "追加的消息" };
    const b1 = JSON.stringify({ model: "m", messages: [one] });
    const b2 = JSON.stringify({ model: "m", messages: [one, two] });
    const s = makeSession();
    const line = pair(s, b1, b2);
    assert.equal(line.bs, "append");
    assert.equal(line.bl, utf8Lcp(b1, b2));
    assert.ok(line.bl !== undefined && Math.abs(line.bl - Buffer.byteLength(b1)) <= 64, "append diverges only in the closing-bracket region");

    const s2 = makeSession();
    const trimmed = pair(s2, b2, b1);
    assert.equal(trimmed.bs, "append", "trimming back to the shorter payload also appends (whole short side survives)");
    assert.equal(trimmed.bl, utf8Lcp(b1, b2));
});

test("caps are enforced in BYTES: a clipped CJK head still settles via the retained full body", () => {
    const s = makeSession();
    const cjk = "\u4e2d".repeat(262_145); // 786_435 bytes > 512 KiB, yet < 512 KiB code units
    const b1 = JSON.stringify({ model: "m", messages: [{ role: "user", content: cjk + "AAA" }] });
    const b2 = JSON.stringify({ model: "m", messages: [{ role: "user", content: cjk + "BBB" }] });
    assert.ok(Buffer.byteLength(b1) > 512 * 1024 && b1.length < 512 * 1024, "rig: over the byte cap, under the old code-unit cap");
    const line = pair(s, b1, b2);
    assert.equal(line.be, 0);
    assert.equal(line.bl, utf8Lcp(b1, b2), "full bodies are retained (< 8 MiB) so the offset stays byte-exact despite the clipped seam head");
    assert.equal(line.bs, "append", "the 3-char suffix difference sits within ±64 of the tail");
});

test("over BODY_FULL_CAP in bytes but under it in code units is digest-only (bs=unknown)", () => {
    const s = makeSession();
    const big = "\u4e2d".repeat(4_200_001); // ~12.6 MB > 8 MiB bytes, yet < 8 MiB code units (the old code RETAINED these)
    const b1 = JSON.stringify({ model: "m", messages: [{ role: "user", content: big + "A" }] });
    const b2 = JSON.stringify({ model: "m", messages: [{ role: "user", content: big + "B" }] });
    assert.ok(Buffer.byteLength(b1) > 8 * 1024 * 1024 && b1.length < 8 * 1024 * 1024, "rig: over the byte cap, under the old code-unit cap");
    const line = pair(s, b1, b2);
    assert.equal(line.be, 0, "inequality proven by digest without retention");
    assert.equal(line.bs, "unknown");
    assert.equal(line.bl, undefined);
    assert.equal(line.bd, createHash("sha256").update(b2, "utf8").digest("hex"));
});

test("identical CJK bodies stay be=1 with no divergence fields", () => {
    const s = makeSession();
    const b = JSON.stringify({ model: "m", messages: [{ role: "user", content: "中文重复" }] });
    noteForwardedBody(s, b);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, b);
    settle(s, T0 + 1000, 100_000, 99_000);
    const line = lastLine(s);
    assert.equal(line.be, 1);
    assert.equal(line.bl, undefined);
    assert.equal(line.bs, undefined);
    assert.equal(line.bd, createHash("sha256").update(b, "utf8").digest("hex"));
});

test("oversized (16 MiB) bodies stay fast on the digest-only path", () => {
    const s = makeSession();
    const huge = "x".repeat(16 * 1024 * 1024);
    const b1 = JSON.stringify({ model: "m", messages: [{ role: "user", content: huge }] });
    const b2 = JSON.stringify({ model: "m", messages: [{ role: "user", content: huge + "z" }] });
    const t0 = Date.now();
    const line = pair(s, b1, b2);
    const ms = Date.now() - t0;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "unknown");
    assert.ok(ms < 5000, `single encode + digest must stay cheap on multi-MiB bodies (took ${ms}ms)`);
});

test("seam forensics reports byte-exact lcpBytes for CJK bodies", () => {
    const s = makeSession();
    const mk = (c1: string, c2: string): string => JSON.stringify({ model: "m", messages: [{ role: "user", content: c1 }, { role: "user", content: c2 }] });
    const b1 = mk("第一条消息的内容", "第二条消息的内容");
    const b2 = mk("第一条消息的内容", "第二条消息被改过");
    noteForwardedBody(s, b1);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, b2);
    settle(s, T0 + 1000, 100_000, 20_000);
    const ev = getCacheLedger(s).seamEvents?.[0];
    assert.ok(ev, "unexplained CJK mid-history break records a seam event");
    assert.equal(ev!.msgIndex, 1);
    assert.equal(ev!.lcpBytes, utf8Lcp(b1, b2), "SeamEvent.lcpBytes must be real UTF-8 bytes");
    assert.notEqual(ev!.lcpBytes, codeUnitLcp(b1, b2), "must NOT be the old code-unit value");
});
