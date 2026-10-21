// #4133: client-managed rolling cache_control breakpoints (dsh / Claude Code
// style: the ephemeral mark moves onto the newest message every turn) mutate
// the PREVIOUS last message's bytes on every pure tail append — the mark
// leaves it. Raw byte LCP therefore stops inside that message, and BOTH
// diagnostic surfaces misread the pair as a mid-history rewrite:
//   - the per-call body-stability ladder classes it "mid" (the divergence sits
//     before the shorter body's message-array close bracket, outside the ±64
//     append tolerance when the marked block is not the very last one);
//   - detectSeam's #2059 tail-append arm sees msgIndex == prevMsgs-1 instead
//     of prevMsgs and cries "suspected mid-history prefix break" on a big miss.
// The upstream wire is stable (isolation experiments: pure append / stripped
// markers / migrated markers all hold ~99.7% hit rate) — only the
// classification lies. Both surfaces must judge survival modulo cache_control
// migration while REAL rewrites keep their flags.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, settleUsageReport, getCacheLedger, buildSessionCacheReport } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `cc-seam-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const CC = { type: "ephemeral" };
const msg = (text: string): Record<string, unknown> => ({ role: "user", content: [{ type: "text", text }] });
// Marked FIRST block of a two-block message: the mark leaving the previous
// last message then leaves >64 bytes of that message after the divergence
// point, which is what pushes the pair past the ±64 append tolerance into the
// pre-fix "mid" bucket (a mark on the very last block would be too close to
// the body end to reproduce).
const markedFirst = (head: string, cc: boolean): Record<string, unknown> => ({
    role: "user",
    content: [
        { type: "text", text: head, ...(cc ? { cache_control: CC } : {}) },
        { type: "text", text: "trailing-block-payload-that-pushes-the-tail-past-the-sixty-four-byte-append-tolerance" },
    ],
});
const body = (msgs: Array<Record<string, unknown>>): string => JSON.stringify({ model: "claude-x", messages: msgs });
const T0 = Date.parse("2026-10-21T10:00:00Z");
const PAD = "x".repeat(4096); // keeps the divergence past the 1 KiB head threshold

function settle(session: Session, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

test("body-stability: pure tail append with a rolling cache_control classifies append, not mid (#4133)", () => {
    const s = makeSession();
    // Previous request: the breakpoint sits on the first block of message 2.
    noteForwardedBody(s, body([msg(PAD), markedFirst("h", true)]));
    settle(s, 100_000, 99_000);
    // Next request: message 2 loses the mark, new message 3 carries it.
    noteForwardedBody(s, body([msg(PAD), markedFirst("h", false), markedFirst("h2", true)]));
    settle(s, 100_000, 99_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.be, 0, "rig sanity: the bodies do differ (the mark moved)");
    assert.equal(line.bs, "append", "marker-migrated tail append must class append, not mid");
    const st = buildSessionCacheReport(s).stability;
    assert.equal(st.mid, 0, "no mid-history count for a stable tail append");
    assert.ok(st.append >= 1, "pair counted under tail-append");
});

test("body-stability: marker reshuffle WITHOUT growth also classifies append (#4133)", () => {
    const s = makeSession();
    noteForwardedBody(s, body([msg(PAD), markedFirst("h", false), markedFirst("i", true)]));
    settle(s, 100_000, 99_000);
    // Same message list, the breakpoint just walked back one message.
    noteForwardedBody(s, body([msg(PAD), markedFirst("h", true), markedFirst("i", false)]));
    settle(s, 100_000, 99_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "append", "history content untouched — only the mark moved");
});

test("body-stability: a REAL mid rewrite combined with marker migration stays mid (#4133)", () => {
    const s = makeSession();
    noteForwardedBody(s, body([msg(PAD), markedFirst("h", true), msg("c")]));
    settle(s, 100_000, 99_000);
    // Message 2's CONTENT changes (not just its mark) — a genuine rewrite.
    noteForwardedBody(s, body([msg(PAD), markedFirst("H-CHANGED", false), msg("c")]));
    settle(s, 100_000, 99_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.bs, "mid", "content change must not be swallowed by the cc-blind rescue");
});

test("seam detector: tail append with a rolling cache_control attributes provider-side, not a seam (#4133)", () => {
    const s = makeSession();
    noteForwardedBody(s, body([msg(PAD), markedFirst("h", true)]));
    settle(s, 100_000, 99_000);
    // Append + big unexplained miss, no fold/switch/restart anywhere. Pre-fix
    // the strict element walk stopped at msgIndex 1 (< prevMsgs 2) and cried
    // seam; the cc-blind index reaches prevMsgs and books provider-side.
    noteForwardedBody(s, body([msg(PAD), markedFirst("h", false), markedFirst("h2", true)]));
    settle(s, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.providerSideMisses, 1, "marker-migrated append miss is provider-side");
    assert.equal(led.agg.seamSuspects, 0, "must not cry a false seam");
    assert.notEqual(led.lines[led.lines.length - 1]!.seam, 1);
});

test("seam detector: a REAL mid rewrite with marker migration stays a seam-suspect (#4133)", () => {
    const s = makeSession();
    noteForwardedBody(s, body([msg(PAD), markedFirst("h", true), msg("c")]));
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, body([msg(PAD), markedFirst("H-CHANGED", false), msg("c")]));
    settle(s, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 1, "content change stays a seam-suspect");
    assert.equal(led.agg.providerSideMisses, 0, "must not be swallowed into provider-side");
    assert.equal(led.lines[led.lines.length - 1]!.seam, 1);
    const ev = led.seamEvents?.[0];
    assert.ok(ev, "forensic event recorded");
    assert.equal(ev!.msgIndex, 1, "strict walk localizes the content change");
    assert.equal(ev!.msgIndexCc, 1, "cc-blind walk agrees — the divergence is NOT marker-only");
});
