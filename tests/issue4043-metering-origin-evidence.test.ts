// #4043: generated thinkingTokens must not establish client origin.
// projectThinkingMass (#1320) stamps CoreMessage.thinkingTokens onto
// Prepared.originalMessages BEFORE noteInboundMessages fingerprints the list,
// and re-derives the value every turn from the previous usage report — so a
// byte-stable client list showed positional fingerprint divergence at every
// signature-only reasoning message, and detectSeam's #3023 client arm booked
// a bili-owned miss as "host churn" (prov:"client" / clientInserts). The fix
// excludes host-generated metering fields from the origin evidence only:
// signatures, raw payloads, tool ids and unknown semantic fields stay full
// evidence; miss accounting is untouched (the unexplained miss remains
// recorded and falls to the seam-suspect bucket, never onto a provider
// without evidence). Gate discipline (#3617): both directions are pinned —
// metering drift alone must NOT trigger the client arm, while a genuine
// client rewrite (signature or text) must STILL trigger it.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BiliMessage } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { getCacheLedger, noteForwardedBody, noteInboundMessages, settleUsageReport } from "../src/cache-ledger.ts";

function session(): Session {
    return {
        id: "synthetic-metering-fixture", metadata: {}, stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}
function inbound(tokens: number, signature = "synthetic-fixed-signature"): BiliMessage[] {
    return [
        { id: "fixture-a", role: "user", contentType: "text", text: "a", wireIndex: 0 },
        { id: "fixture-b", role: "assistant", contentType: "reasoning", text: "", thinkingSignature: signature, thinkingTokens: tokens, wireIndex: 1 },
        { id: "fixture-c", role: "user", contentType: "text", text: "c", wireIndex: 2 },
    ];
}
function sample(s: Session, messages: BiliMessage[], wireContents: string[], cached: number): void {
    noteInboundMessages(s, messages);
    noteForwardedBody(s, JSON.stringify({ model: "synthetic-fixture", messages: wireContents.map((content) => ({ role: "user", content })) }));
    // Synthetic usage only. No network, provider SDK, or real model is involved.
    settleUsageReport(s, { total: 100_000, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://fixture.invalid" });
}

test("generated thinkingTokens must not alone establish client origin of a separate outbound break", () => {
    const s = session();
    sample(s, inbound(10), ["a", "before-outbound", "c"], 99_000);
    sample(s, inbound(20), ["a", "changed-outbound", "c"], 20_000);
    const ledger = getCacheLedger(s);
    assert(ledger.lines.at(-1)!.tr > 8192, "actual unexplained miss must remain recorded");
    assert.equal(ledger.agg.clientInserts, 0, "proxy-owned metering is not client-origin evidence");
    assert.equal(ledger.lines.at(-1)?.prov, undefined);
});

test("metering change with identical outbound bytes does not itself trigger client attribution", () => {
    const s = session();
    sample(s, inbound(10), ["a", "same-outbound", "c"], 99_000);
    sample(s, inbound(20), ["a", "same-outbound", "c"], 20_000);
    assert.equal(getCacheLedger(s).agg.clientInserts, 0);
});

test("real signature changes remain detectable when outbound bytes also diverge", () => {
    const s = session();
    sample(s, inbound(10, "synthetic-signature-before"), ["a", "before-outbound", "c"], 99_000);
    sample(s, inbound(20, "synthetic-signature-after"), ["a", "changed-outbound", "c"], 20_000);
    assert.equal(getCacheLedger(s).agg.clientInserts, 1);
    assert.equal(getCacheLedger(s).lines.at(-1)?.prov, "client");
});

test("a genuine client text edit co-occurring with metering drift still books the client bucket", () => {
    const s = session();
    sample(s, inbound(10), ["a", "before-outbound", "c"], 99_000);
    const msgs = inbound(20);
    msgs[0]!.text = "a-edited";
    sample(s, msgs, ["a-edited", "changed-outbound", "c"], 20_000);
    const ledger = getCacheLedger(s);
    assert.equal(ledger.agg.clientInserts, 1, "raw payload edits stay full evidence");
    assert.equal(ledger.lines.at(-1)?.prov, "client");
});

// Direct pin on the strip itself (union coverage from duplicate PRs
// #4055/#4056): holds even if the detectSeam attribution path reshapes.
test("inbound fingerprint is immune to projected thinkingTokens fluctuation", () => {
    const s = session();
    noteInboundMessages(s, inbound(10));
    const before = [...(s.transient?.inBody?.fps ?? [])];
    noteInboundMessages(s, inbound(20));
    const after = s.transient?.inBody?.fps ?? [];
    assert.equal(before.length, 3, "all three messages fingerprinted");
    assert.deepEqual(after, before, "fingerprint array unchanged when only bili's projected meter moves");
});
