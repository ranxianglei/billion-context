// #5139 regression: the Responses ordering repair inserts acp_turn_sep_* USER
// markers into the SEND view only — they never exist in the original history
// (the apply view). Range candidates derived from the send view can therefore
// endpoint on a marker ref; screened against the apply view those endpoints
// throw BoundaryNotFoundError and screenRecommendedUnits demotes the whole
// unit to a gap SILENTLY — tens of thousands of offerrable tokens vanish from
// the acp_status offer while the uncovered-history audit still shows them
// going upstream raw ("little left to fold" while 180K+ was recoverable).
//
// These pins wire the analysis entry points exactly like the relay does
// (messages = send view incl. markers, compressMessages = original history)
// and assert the acceptance contract from the issue: every recommended
// endpoint resolves in the apply view, and recoverable mass stays offerrable
// across (a) a normal request, (b) the post-compress internal re-request, and
// (c) the acp_status surface itself.
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCore, defaultConfig, refForRaw, type CompressionCore, type Config, type CoreMessage } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { handleAcpStatus, liveCompressionRanges } from "../src/acp-status.ts";
import { repairResponsesAssistantOrdering, stripKernelSummaries } from "../src/server.ts";
import { isResponsesTurnSeparatorId, withoutTurnSeparators } from "../src/turn-separator.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const LIMIT = 200000;
const pad = (n: number) => "x".repeat(n);

const textMsg = (id: string, role: CoreMessage["role"], text: string): CoreMessage => ({ id, role, contentType: "text", text });
const reasoningMsg = (id: string, text: string): CoreMessage => ({ id, role: "assistant", contentType: "reasoning", text });
const callMsg = (id: string, callId: string): CoreMessage => ({ id, role: "assistant", contentType: "tool-call", toolCallId: callId, toolName: "bash", text: JSON.stringify({ cmd: `step ${callId}` }) });
const resultMsg = (id: string, callId: string, text: string): CoreMessage => ({ id, role: "tool", contentType: "tool-result", toolCallId: callId, text });

/** Geometry chosen so the ONLY candidate loss is the #5139 separator defect:
 *  tA → rB are consecutive assistant items in the original (one run), so the
 *  ordering repair splits them with acp_turn_sep_1 in the send view — the repro
 *  precondition. The foldable MID mass is a single USER message placed right
 *  after rB: that leaves rB an orphaned reasoning run (no companion burst → no
 *  #684 turn-integrity constraint), while the TAIL tool pairs each form their
 *  own complete turn group — the integrity gate stays silent, so whatever the
 *  offer loses is attributable to the marker endpoint, not to withdrawals. */
function buildOriginal(): CoreMessage[] {
    return [
        textMsg("u1", "user", "Inspect services A and B and report. " + pad(500)),
        reasoningMsg("rA", "REASONING-A " + pad(500)),
        textMsg("tA", "assistant", "Starting inspection. " + pad(500)),
        reasoningMsg("rB", "REASONING-B " + pad(500)),
        textMsg("mid1", "user", "Pasted service logs: " + pad(8000)),
        textMsg("tB", "assistant", "Analysis of collected results. " + pad(500)),
        callMsg("f1", "c1"), resultMsg("o1", "c1", "TAILMASS-1 " + pad(4000)),
        callMsg("f2", "c2"), resultMsg("o2", "c2", "TAILMASS-2 " + pad(4000)),
        callMsg("f3", "c3"), resultMsg("o3", "c3", "TAILMASS-3 " + pad(4000)),
        textMsg("u_last", "user", "Continue with the fix."),
        textMsg("rec1", "assistant", "On it."),
        textMsg("rec2", "assistant", "Done step one."),
    ];
}

/** Plain alternating history — no adjacent assistant runs, so the ordering
 *  repair must stay a no-op (normal-request control). */
function buildPlainOriginal(): CoreMessage[] {
    return [
        textMsg("p_u1", "user", "Do the migration. " + pad(500)),
        reasoningMsg("p_r1", "P-REASONING-1 " + pad(500)),
        textMsg("p_t1", "assistant", "Migrating tables. " + pad(500)),
        callMsg("p_f1", "pc1"), resultMsg("p_r1s", "pc1", "PLAINMASS-1 " + pad(4000)),
        callMsg("p_f2", "pc2"), resultMsg("p_r2s", "pc2", "PLAINMASS-2 " + pad(4000)),
        callMsg("p_f3", "pc3"), resultMsg("p_r3s", "pc3", "PLAINMASS-3 " + pad(4000)),
        textMsg("p_last", "user", "Report back."),
        textMsg("p_rec1", "assistant", "Will do."),
        textMsg("p_rec2", "assistant", "Starting now."),
    ];
}

function makeConfig(): Config {
    return defaultConfig(LIMIT, {
        preserveRecentMessages: 3,
        preserveRecentTokens: 0,
        compress: { minCompressRange: 0, minSummaryLength: 0, maxSummaryLength: 20000 },
    });
}

interface Fixture {
    core: CompressionCore;
    config: Config;
    original: CoreMessage[];
    session: ReturnType<typeof getSession>;
    /** Round-1 send view: the prepared folded view + ordering repair — the
     *  exact array class the relay hands tools as `messages` (#5139 wiring). */
    sendView: CoreMessage[];
    refs: Record<string, string>;
}

function setupFixture(build: () => CoreMessage[]): Fixture {
    const core = createCore();
    const session = getSession(`issue5139-${randomUUID()}`);
    const config = makeConfig();
    const original = build();
    const prep = core.processTurn({ messages: original, state: session.state, config, tokenCount: 0, renderTags: "text-only" });
    session.state = prep.state;
    const processed = stripKernelSummaries(prep.messages as BiliMessage[], prep.state) as CoreMessage[];
    const sendView = repairResponsesAssistantOrdering(processed, original);
    const refs: Record<string, string> = {};
    for (const m of original) {
        const r = refForRaw(session.state.messageRefs, m.id);
        if (r) refs[m.id] = r;
    }
    return { core, config, original, session, sendView, refs };
}

const refNum = (ref: string): number => Number(ref.replace(/\D/g, ""));
function spanCovers(r: { startRef: string; endRef: string }, lo: number, hi: number): boolean {
    const a = Math.min(refNum(r.startRef), refNum(r.endRef));
    const b = Math.max(refNum(r.startRef), refNum(r.endRef));
    return a <= lo && b >= hi;
}

/** The #5139 acceptance contract: every recommended endpoint must resolve in
 *  the apply view (original history) — marker refs must never be advertised. */
function assertEndpointsResolve(label: string, ranges: Array<{ startRef: string; endRef: string }>, refs: Record<string, string>): void {
    const applyRefs = new Set(Object.values(refs));
    for (const r of ranges) {
        assert.ok(applyRefs.has(r.startRef), `${label}: start ${r.startRef} must resolve in the apply view (original history)`);
        assert.ok(applyRefs.has(r.endRef), `${label}: end ${r.endRef} must resolve in the apply view (original history)`);
    }
}

test("#5139: withoutTurnSeparators strips only outbound-only markers (no-op otherwise)", () => {
    const plain = [textMsg("a", "user", "hi"), textMsg("b", "assistant", "yo")];
    assert.equal(withoutTurnSeparators(plain), plain, "no markers → identical array (zero-copy fast path)");
    const mixed = [
        textMsg("a", "user", "hi"),
        textMsg("acp_turn_sep_1", "user", "[The exchange between these two assistant turns was compressed.]"),
        textMsg("b", "assistant", "yo"),
        textMsg("acp_turn_sep_2", "user", "[The exchange between these two assistant turns was compressed.]"),
        textMsg("c", "user", "next"),
    ];
    assert.deepEqual(withoutTurnSeparators(mixed).map((m) => m.id), ["a", "b", "c"], "markers removed, order kept");
    assert.ok(isResponsesTurnSeparatorId("acp_turn_sep_1") && !isResponsesTurnSeparatorId("a_turn_sep_1"));
});

test("#5139: acp_status offers the full recoverable mass when the send view carries ordering separators", () => {
    const fx = setupFixture(buildOriginal);
    assert.ok(fx.sendView.some((m) => isResponsesTurnSeparatorId(m.id)), "repro precondition: ordering repair inserted a separator into the send view");

    const ctx = { core: fx.core, config: fx.config, messages: fx.sendView, compressMessages: fx.original, session: fx.session, log: () => {} };
    const live = liveCompressionRanges(ctx);
    assert.ok(live, "live recompute produced a verdict");
    assert.ok(live!.ranges.length > 0, "recoverable mass must be offerrable");
    assertEndpointsResolve("steady-state", live!.ranges, fx.refs);
    assert.ok(
        live!.ranges.some((r) => spanCovers(r, refNum(fx.refs.mid1), refNum(fx.refs.o3))),
        `the full recoverable mass (mid1..o3, behind the separator) must be offered: ${JSON.stringify(live!.ranges.map((r) => `${r.startRef}-${r.endRef}`))}`,
    );
    assert.ok(
        live!.ranges.some((r) => spanCovers(r, refNum(fx.refs.f1), refNum(fx.refs.o3))),
        `TAIL tool-pair mass (f1..o3) must be offered: ${JSON.stringify(live!.ranges.map((r) => `${r.startRef}-${r.endRef}`))}`,
    );

    // Both surfaces agree: what the audit shows as going upstream raw must be
    // covered by the offer (or genuinely protected), never "unoffered mass"
    // that is actually offered under different geometry.
    const report = handleAcpStatus({}, ctx).text ?? "";
    assert.ok(report.includes("Compressible ranges ("), "status report lists the offer");
    assert.ok(!report.includes("UNCOVERED HISTORY"), `offer and uncovered audit disagree:\n${report}`);
});

test("#5139: post-compress internal re-request keeps offering everything around the new block", () => {
    const fx = setupFixture(buildOriginal);
    assert.ok(fx.sendView.some((m) => isResponsesTurnSeparatorId(m.id)), "repro precondition: separator present in the round-1 send view");

    // A previous request's loop round folded the middle mass (mid1) — the
    // state now carries block b1; the round-2+ tool surface still analyzes
    // the ROUND-1 send view (relay pins ctx.messages at loop setup) against
    // the post-fold state, with the original history as apply view.
    const folded = fx.core.applyCompression({
        ranges: [{ startRef: fx.refs.mid1, endRef: fx.refs.mid1, summary: "Pasted logs analyzed for timeout entries.", compressCallId: "call_mid" }],
        messages: fx.original,
        state: fx.session.state,
        config: fx.config,
    });
    fx.session.state = folded.state;
    const block = fx.session.state.blocks.find((b) => b.active);
    assert.ok(block, "fold committed a block");
    assert.ok(block!.effectiveMessageIds.includes("mid1"), "block covers the folded middle");

    const ctx = { core: fx.core, config: fx.config, messages: fx.sendView, compressMessages: fx.original, session: fx.session, log: () => {} };
    const live = liveCompressionRanges(ctx);
    assert.ok(live, "live recompute produced a verdict");
    assertEndpointsResolve("post-compress", live!.ranges, fx.refs);
    assert.ok(
        live!.ranges.some((r) => spanCovers(r, refNum(fx.refs.rB), refNum(fx.refs.rB))),
        `the reasoning mass right before the new block (rB) must stay offered: ${JSON.stringify(live!.ranges.map((r) => `${r.startRef}-${r.endRef}`))}`,
    );
    assert.ok(
        live!.ranges.some((r) => spanCovers(r, refNum(fx.refs.f1), refNum(fx.refs.o3))),
        `TAIL mass (after the new block) must stay offered: ${JSON.stringify(live!.ranges.map((r) => `${r.startRef}-${r.endRef}`))}`,
    );

    const report = handleAcpStatus({}, ctx).text ?? "";
    assert.ok(!report.includes("UNCOVERED HISTORY"), `surfaces disagree post-fold:\n${report}`);
});

test("#5139 control: a normal request without ordering separators is unaffected", () => {
    const fx = setupFixture(buildPlainOriginal);
    assert.ok(!fx.sendView.some((m) => isResponsesTurnSeparatorId(m.id)), "control precondition: no separator inserted");

    const ctx = { core: fx.core, config: fx.config, messages: fx.sendView, compressMessages: fx.original, session: fx.session, log: () => {} };
    const live = liveCompressionRanges(ctx);
    assert.ok(live && live.ranges.length > 0, "plain history still offers its old mass");
    assertEndpointsResolve("plain", live!.ranges, fx.refs);
    assert.ok(
        live!.ranges.some((r) => spanCovers(r, refNum(fx.refs.p_f1), refNum(fx.refs.p_r3s))),
        `plain old mass must be offered: ${JSON.stringify(live!.ranges.map((r) => `${r.startRef}-${r.endRef}`))}`,
    );
    const report = handleAcpStatus({}, ctx).text ?? "";
    assert.ok(report.includes("Compressible ranges ("), "status report lists the offer");
    assert.ok(!report.includes("UNCOVERED HISTORY"), `control surfaces disagree:\n${report}`);
});
