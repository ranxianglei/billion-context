// #4137 (来源: #4128 分析 anthropic-lane usage double-counting 时发现): the
// per-call body-stability classifier compared RAW outbound bytes. On the
// Anthropic wire a client-managed cache stamper re-stamps `cache_control`
// breakpoints onto the newest message(s) every turn (src/loop/cache-control.ts
// forwards pre-existing client marks verbatim instead of bili's own cumulative
// stamps), so the MARKER MIGRATES between consecutive bodies: the previous last
// message loses its mark, the new tail gains one. A PURE-APPEND turn therefore
// diverges in raw bytes exactly where the marker moved — strictly before the
// message-array close — and the raw-LCP arms could only ever land "mid" (247
// spurious "mid-history divergence" samples on one dsh session, while isolated
// experiments showed a 99.7% upstream hit). Fix: classify on a marker-blind view
// (strip every `cache_control` field from BOTH sides before the LCP/array-close
// comparison; fall back to raw bytes when a side cannot normalize). The forensic
// offset (bl, #2868) stays the raw wire offset — only the CLASS moves.
//
// Gate discipline (#3617): positives prove a migrating pure-append is NO LONGER
// "mid"; negatives prove a genuine mid-history CONTENT rewrite is STILL "mid"
// (the strip must not mask real rewrites) and that the no-marker fast path and
// the non-object fallback are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, settleUsageReport, getCacheLedger, buildSessionCacheReport } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `ccmig-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

function settle(session: Session, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

// ~400-char payloads so every shared prefix clears the 1 KiB head threshold.
const P = "x".repeat(400);
const MARK = { type: "ephemeral" } as const;
const sysMarked = [{ type: "text", text: `sys-${P}`, cache_control: MARK }];
const sysPlain = [{ type: "text", text: `sys-${P}` }];
const userMsg = (tag: string, marked = false) => ({ role: "user", content: [{ type: "text", text: `${tag}-${P}`, ...(marked ? { cache_control: MARK } : {}) }] });
const assistantMsg = (tag: string, marked = false) => ({ role: "assistant", content: [{ type: "text", text: `${tag}-${P}`, ...(marked ? { cache_control: MARK } : {}) }] });

function anthropic(messages: unknown[], opts: { system?: unknown[]; tools?: unknown[] } = {}): string {
    return JSON.stringify({ model: "claude-x", max_tokens: 1024, system: opts.system ?? sysMarked, ...(opts.tools ? { tools: opts.tools } : {}), messages });
}

test("pure-append whose marker MIGRATES onto the new tail ⇒ bs=append (was mislabelled mid)", () => {
    const s = makeSession();
    // Turn N: a1 carries the breakpoint. Turn N+1: a1 loses it, the appended u2 gains it.
    const prev = anthropic([userMsg("u1"), assistantMsg("a1", true)]);
    const cur = anthropic([userMsg("u1"), assistantMsg("a1", false), userMsg("u2", true)]);
    noteForwardedBody(s, prev);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, cur);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0, "the raw bytes DO differ (the marker moved)");
    assert.equal(line.bs, "append", "marker-blind, the whole shorter payload survives — pure tail growth");
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.append, 1);
    assert.equal(rep.stability.mid, 0, "no mid count may be charged for a migrating marker");
});

test("SYSTEM-block marker migration + append ⇒ bs=append (system-position markers stripped too)", () => {
    const s = makeSession();
    const prev = anthropic([userMsg("u1")], { system: sysMarked });
    const cur = anthropic([userMsg("u1"), userMsg("u2", true)], { system: sysPlain });
    noteForwardedBody(s, prev);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, cur);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "append", "the system marker drop must not read as history churn");
});

test("TOOLS-entry marker migration + append ⇒ bs=append (nested-key markers stripped too)", () => {
    const s = makeSession();
    const toolMarked = { name: "t", description: "d", input_schema: { type: "object", properties: { q: { type: "string" } } }, cache_control: MARK };
    const toolPlain = { name: "t", description: "d", input_schema: { type: "object", properties: { q: { type: "string" } } } };
    const prev = anthropic([userMsg("u1")], { tools: [toolMarked] });
    const cur = anthropic([userMsg("u1"), userMsg("u2", true)], { tools: [toolPlain] });
    noteForwardedBody(s, prev);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, cur);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "append", "the tools marker lives behind a nested input_schema object — the scanner must reach it");
});

test("genuine MID-HISTORY content rewrite (with markers present) still ⇒ bs=mid (strip must not mask real rewrites)", () => {
    const s = makeSession();
    const base = [userMsg("m1"), userMsg("m2"), userMsg("m3"), userMsg("m4"), userMsg("m5", true)];
    const prev = anthropic(base);
    // Rewrite message[3]'s TEXT (a real change) AND let the marker migrate off m5 onto a new m6.
    const rew = base.map((m, i) => (i === 3 ? userMsg("m3-REWRITTEN") : m));
    const cur = anthropic([...rew, userMsg("m6", true)]);
    noteForwardedBody(s, prev);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, cur);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "mid", "a real mid-list content change must survive normalization as mid");
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.mid, 1);
});

test("SUBSTITUTING bytes INSIDE the LAST message (marker migrates off it) still ⇒ bs=mid (boundary guard)", () => {
    const s = makeSession();
    // Interior SUBSTITUTION with a length change (a×200 → b×300): a genuine byte
    // change with a non-empty middle residual, so #3476's in-unit-insertion rung
    // (which claims only empty-residual growth) cannot launder it into "append".
    // An append-SHAPED edit ("m3"→"m3-CHANGED") is legitimately a semantic append
    // per #3476 — that is deliberately NOT what this guard pins.
    const sub = (block: string, marked: boolean) => ({ role: "assistant", content: [{ type: "text", text: `head-${block}-tail`, ...(marked ? { cache_control: MARK } : {}) }] });
    const prev = anthropic([userMsg("m1"), userMsg("m2"), sub("a".repeat(200), true)]);
    const cur = anthropic([userMsg("m1"), userMsg("m2"), sub("b".repeat(300), false)]);
    noteForwardedBody(s, prev);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, cur);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "mid", "a real interior byte substitution must survive normalization as mid — marker-blindness must not swallow it");
});

test("no cache_control anywhere (fast path) ⇒ unchanged classification, pure append ⇒ bs=append", () => {
    const s = makeSession();
    const om = Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `o${i}-${P}` }));
    const prev = JSON.stringify({ model: "gpt", messages: om.slice(0, 5) });
    const cur = JSON.stringify({ model: "gpt", messages: om });
    noteForwardedBody(s, prev);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, cur);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "append", "the spans.length===0 fast path returns the original buffer — behavior is byte-for-byte pre-fix");
});

test("non-object body (array) ⇒ strip returns null, raw fallback, no crash", () => {
    const s = makeSession();
    const g1 = "[" + "a".repeat(2000) + "]";
    const g2 = "[" + "a".repeat(1500) + "b" + "a".repeat(1499) + "]";
    noteForwardedBody(s, g1);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, g2);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.ok(line.bs !== undefined, "a class is still produced via the raw fallback");
    assert.notEqual(line.bs, "unknown", "both bodies were retained under BODY_FULL_CAP, so the offset is known");
});
