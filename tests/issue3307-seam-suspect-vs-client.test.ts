// #3307: the text report's two seam sections must stay disjoint. detectSeam
// pushes BOTH the #3023 client-side rewrite AND the legacy "suspected rebuild"
// fall-through into ONE shared capped ring (led.seamEvents); formatSeam's
// ⚠ CACHE SEAM section used to iterate every event in that ring without
// filtering, so a host-owned client rewrite was ALSO listed under the
// "suspected mid-history prefix breaks" header (double-listed), contaminating
// the suspect triage. The ✎ CLIENT section already filters to e.client. This
// pins that a session carrying both arms renders each seq under exactly one
// header — the client seq only under ✎, the suspect seq only under ⚠.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, noteInboundMessages, settleUsageReport, getCacheLedger, handleAcpCache } from "../src/cache-ledger.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `seam-disjoint-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const body = (msgs: string[]): string => JSON.stringify({ model: "m", messages: msgs.map((c) => ({ role: "user", content: c })) });
const inbound = (msgs: string[]): CoreMessage[] => msgs.map((c) => ({ role: "user", content: c })) as unknown as CoreMessage[];
const T0 = Date.parse("2026-10-16T08:00:00Z");

function settle(session: Session, at: number, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

test("#3307: client rewrite and genuine seam render under disjoint sections", () => {
    const s = makeSession();

    noteInboundMessages(s, inbound(["m0", "m1", "m2"]));
    noteForwardedBody(s, body(["m0", "m1", "m2"]));
    settle(s, T0, 100_000, 99_000);

    // Arm A — CLIENT mid-list insert at index 1 (inbound breaks mid-list).
    noteInboundMessages(s, inbound(["m0", "INS", "m1", "m2"]));
    noteForwardedBody(s, body(["m0", "INS", "m1", "m2"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const clientSeq = getCacheLedger(s).lines.at(-1)!.seq;

    // Arm B — GENUINE seam: inbound prefix-stable (pure tail append) but the
    // outbound rebuild rewrote a MIDDLE message → bili-owned divergence.
    noteInboundMessages(s, inbound(["m0", "INS", "m1", "m2", "m3"]));
    noteForwardedBody(s, body(["m0", "INS", "CHG", "m2", "m3"]));
    settle(s, T0 + 2000, 100_000, 20_000);
    const suspectSeq = getCacheLedger(s).lines.at(-1)!.seq;

    const led = getCacheLedger(s);
    assert.equal(led.agg.clientInserts, 1, "client arm booked");
    assert.equal(led.agg.seamSuspects, 1, "suspect arm booked");
    assert.notEqual(clientSeq, suspectSeq, "two distinct samples");
    assert.ok(led.seamEvents?.some((e) => e.client && e.seq === clientSeq), "client event carries .client");
    assert.ok(led.seamEvents?.some((e) => !e.client && e.seq === suspectSeq), "suspect event has no .client");

    const text = handleAcpCache(s).text;
    const warnStart = text.indexOf("⚠ CACHE SEAM");
    const cliStart = text.indexOf("✎ CLIENT MID-HISTORY REWRITE");
    assert.ok(warnStart >= 0, "⚠ suspected section present");
    assert.ok(cliStart > warnStart, "✎ client section present after ⚠");
    const warnSection = text.slice(warnStart, cliStart);
    const clientSection = text.slice(cliStart);

    assert.ok(warnSection.includes(`#${suspectSeq}`), "suspect seq listed under ⚠");
    assert.ok(!warnSection.includes(`#${clientSeq}`), "client seq NOT echoed under ⚠ (the #3307 bug)");
    assert.ok(clientSection.includes(`#${clientSeq}`), "client seq listed under ✎");
    assert.ok(!clientSection.includes(`#${suspectSeq}`), "suspect seq NOT listed under ✎");
});
