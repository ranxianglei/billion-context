import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import {
    reconcileFoldCoverage,
    normalizedIdentity,
    positionalFingerprint,
    type FoldAnchor,
} from "../src/fold-reconcile.ts";

// #3752 — the 0.1.200→0.1.201 identity re-key mass-unfolded long sessions
// because covered ids beyond the MAX_ANCHORS=16384 window lost EVERY channel
// except the positional scan, which dies after MAX_RESYNC_GAPS accumulated
// breaks. Weeks of genuine drift guarantee >8 breaks on a 15K-core session,
// so the window's tool cores became unrecoverable in both directions
// (upgrade AND downgrade). The fix mints hash-free LITE anchors ({r,c,t,b})
// for tool cores beyond the window: Pass 1's toolCallId channel consumes
// exactly those fields, so tool cores re-anchor at any session length.
//
// Pinned properties:
//   1. the seed loop mints lite anchors past the cap — ONLY for tool cores
//      (non-tool cores keep the old positional-only status quo) and WITHOUT
//      touching the full-anchor cap (#2334 contract);
//   2. when the positional scan has died in the past-cap region, Pass 1
//      claims the past-cap tool cores THROUGH THE toolCallId CHANNEL (asserted
//      on the reconciler's own counter, not just on outcomes), pairing each
//      new id with the protocol tool id it actually carries (no cross-pairing);
//   3. the incident trajectory converges: a true pre-fix ledger + a re-keyed,
//      drift-riddled resend may lose dead-middle cores once (honest — no
//      bytes on the wire under the old ids to pair from), the refold
//      re-covers the new ids, and from the next pass on the ledger is
//      complete and the session sits in drift-free steady state.

const CAP = 16384; // mirrors MAX_ANCHORS in src/fold-reconcile.ts
const TURNS = 5700; // 3 cores/turn → 17100 covered, past the cap
type Kind = "user" | "call" | "result";

interface FixtureMsg extends CoreMessage {
    kind: Kind;
    turn: number;
    toolCallId?: string;
}

function makeSession(): Session {
    return {
        id: `test-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

// One long OpenCode-style history: each turn = user text + assistant
// tool-call + tool-result. Tool ids embed the turn so every toolCallId is
// conversation-unique (protocol guarantee) while core ids stay synthetic.
function buildBase(): FixtureMsg[] {
    const out: FixtureMsg[] = [];
    for (let t = 0; t < TURNS; t++) {
        out.push({
            id: `u_${t}`, kind: "user", turn: t,
            role: "user", contentType: "text",
            text: `request ${t} ${"x".repeat(120)}`,
        });
        out.push({
            id: `tc_${t}`, kind: "call", turn: t, toolCallId: `tu_${t}`,
            role: "assistant", contentType: "tool-call", toolName: "bash",
            text: `{"command":"step ${t}","cwd":"/w"}`,
        });
        out.push({
            id: `tr_${t}`, kind: "result", turn: t, toolCallId: `tu_${t}`,
            role: "tool", contentType: "tool-result",
            text: `output of step ${t} ${"y".repeat(120)}`,
        });
    }
    return out;
}

const isTool = (m: FixtureMsg): boolean => m.kind !== "user";

// The resent generation: bili's own re-key (every tool core re-minted — same
// bytes, new ids, exactly what #3658 does to this lane) PLUS genuine host-side
// drift concentrated in the TAIL: the last `mutateTail` user messages edited
// (new bytes, new ids). All edits land strictly inside the past-cap region
// (turn ≥ TURNS-240 → index ≥ 16500), so the head scan runs clean to the cap
// boundary and then dies at the first break (consecutive edits leave no
// 3-run resync window), and the tail scan dies after 8 gaps near the very end
// — the entire past-cap middle is positional-dead and only an anchor channel
// can claim it.
function buildResent(base: FixtureMsg[], mutateTail: number): { msgs: CoreMessage[]; mutatedUserIds: string[] } {
    const mutatedUserIds: string[] = [];
    const cut = TURNS - mutateTail;
    const msgs: CoreMessage[] = base.map((m) => {
        if (isTool(m)) return { ...m, id: `${m.id}_remint` };
        if (m.turn >= cut) {
            const nm = { ...m, id: `${m.id}_e`, text: `request ${m.turn} REWRITTEN BY HOST ${"z".repeat(116)}` };
            mutatedUserIds.push(nm.id as string);
            return nm;
        }
        return m;
    });
    return { msgs, mutatedUserIds };
}

function fullAnchor(m: CoreMessage): FoldAnchor {
    return { n: normalizedIdentity(m), r: m.role, c: m.contentType, b: (m.text ?? "").length };
}

function liteAnchor(m: FixtureMsg): FoldAnchor {
    return { r: m.role, c: m.contentType, t: m.toolCallId, b: (m.text ?? "").length };
}

function installBlock(session: Session, ids: string[]): void {
    session.state.blocks = [{
        blockId: "b0", runId: "r0", tier: 1, summary: "fold", directMessageIds: ids,
        effectiveMessageIds: ids, directBlockIds: [], compressedTokens: 1000, createdAt: Date.now(),
        survivedCount: 0, generation: "young", active: true,
    }];
}

function installLedger(session: Session, base: FixtureMsg[], anchors: Record<string, FoldAnchor>): void {
    const ids = base.map((m) => m.id as string);
    installBlock(session, ids);
    session.metadata = {
        foldAnchors: anchors,
        foldAnchorOrder: [...ids],
        foldPositions: { ids: [...ids], canon: base.map((m) => positionalFingerprint(m)) },
    };
}

function toolClaimCount(logs: string[]): number {
    for (const line of logs) {
        const m = /(\d+) by toolCallId/.exec(line);
        if (m !== null) return Number(m[1]);
    }
    return -1;
}

test("#3752: seed loop mints hash-free lite anchors for past-cap tool cores only", () => {
    const session = makeSession();
    const base = buildBase();
    installLedger(session, base, {});

    reconcileFoldCoverage(session, base, { mode: "repair" });

    const anchors = session.metadata["foldAnchors"] as Record<string, FoldAnchor>;
    const full = Object.values(anchors).filter((a) => a.n !== undefined);
    // The expensive-anchor cap holds exactly as before (#2334 contract)…
    assert.equal(full.length, CAP, "full anchors must stay capped at MAX_ANCHORS");
    // …but past-cap TOOL cores now persist hash-free lite anchors…
    const pastCapTools = base.filter((m, i) => i >= CAP && isTool(m));
    for (const m of pastCapTools) {
        const a = anchors[m.id as string];
        assert.ok(a !== undefined, `past-cap tool core ${m.id} must get a lite anchor`);
        assert.equal(a.n, undefined, "lite anchors carry no norm hash");
        assert.equal(a.m, undefined, "lite anchors carry no twin norm");
        assert.equal(a.sh, undefined, "lite anchors carry no simhash");
        assert.equal(a.wh, undefined, "lite anchors carry no wordbag");
        assert.equal(a.t, m.toolCallId, "lite anchors keep the protocol tool id (Pass 1's key)");
        assert.equal(a.r, m.role);
        assert.equal(a.c, m.contentType);
        assert.equal(a.b, (m.text ?? "").length);
    }
    // …while past-cap NON-tool cores keep the old status quo (no anchor).
    const pastCapNonTools = base.filter((m, i) => i >= CAP && !isTool(m));
    for (const m of pastCapNonTools) {
        assert.equal(anchors[m.id as string], undefined, `past-cap non-tool core ${m.id} must stay anchor-less`);
    }
    assert.equal(Object.keys(anchors).length, CAP + pastCapTools.length);
});

test("#3752: past-cap tool cores are claimed through the toolCallId channel when position is dead", () => {
    const session = makeSession();
    const base = buildBase();
    const { msgs: resent, mutatedUserIds } = buildResent(base, 240);
    // Ledger as a RUNNING FIXED build persists it: full anchors under the
    // cap, hash-free lite anchors for past-cap tool cores, nothing else.
    const anchors: Record<string, FoldAnchor> = {};
    base.forEach((m, i) => {
        if (i < CAP) anchors[m.id as string] = fullAnchor(m);
        else if (isTool(m)) anchors[m.id as string] = liteAnchor(m);
    });
    installLedger(session, base, anchors);

    const logs: string[] = [];
    reconcileFoldCoverage(session, resent, { mode: "repair", log: (level, msg) => { logs.push(`${level}: ${msg}`); } });

    // The reconciler's own accounting proves the channel: some past-cap tool
    // cores were claimed BY TOOLCALLID (position died before the cap region
    // could be reached from either flank).
    assert.ok(toolClaimCount(logs) > 0, `expected a positive toolCallId claim count in the drift log, got: ${logs.join(" | ")}`);

    const nextAnchors = session.metadata["foldAnchors"] as Record<string, FoldAnchor>;
    // Every re-minted tool core — including EVERY one past the cap — must be
    // claimed (byTool through the dead region, byPos in the surviving flanks).
    // A claimed id seeds its anchor under the NEW id this pass.
    let pastCapClaimed = 0;
    base.forEach((m, i) => {
        if (!isTool(m)) return;
        const newId = `${m.id}_remint`;
        const a = nextAnchors[newId];
        assert.ok(a !== undefined, `re-minted tool core ${newId} must have been claimed`);
        assert.equal(a.t, m.toolCallId, `anchor under ${newId} must carry its own tool id (no cross-pairing)`);
        assert.equal(a.r, m.role);
        if (i >= CAP) pastCapClaimed++;
    });
    assert.ok(pastCapClaimed > 0, "fixture must exercise past-cap tool cores");
    // Full-anchor discipline survives the churn pass unchanged.
    assert.ok(Object.values(nextAnchors).filter((a) => a.n !== undefined).length <= CAP);
    // The host edits never leak into the tool channel: no anchor seeded under
    // a mutated USER id carries a tool id.
    for (const id of mutatedUserIds) {
        const a = nextAnchors[id];
        if (a !== undefined) assert.equal(a.t, undefined, `mutated user cell ${id} must not gain a tool id`);
    }
});

test("#3752: incident trajectory — true pre-fix ledger converges to a complete ledger in one refold", () => {
    const session = makeSession();
    const base = buildBase();
    const { msgs: resent } = buildResent(base, 240);
    const resentIds = resent.map((m) => m.id as string);
    // PRE-FIX ledger: exactly what a 0.1.200 build persisted — full anchors
    // for the first CAP ids, NOTHING beyond (the break-at-cap survivor set).
    const anchors: Record<string, FoldAnchor> = {};
    base.forEach((m, i) => { if (i < CAP) anchors[m.id as string] = fullAnchor(m); });
    installLedger(session, base, anchors);

    // Pass 1 — the first request after the upgrade. Dead-region cores may
    // lose once (honest loss: no bytes on the wire under the old ids); the
    // pass must stay consistent regardless.
    reconcileFoldCoverage(session, resent, { mode: "repair" });
    assert.notEqual(session.metadata["foldDriftEscalated"], true, "one partial pass must not latch destruction");

    // The proxy's preflight re-folds the unfolded content: coverage now
    // follows the CURRENT ids (applyRanges semantics — same bytes, new ids).
    installBlock(session, resentIds);

    // Pass 2 — every covered id is on the wire: the seed loop mints a
    // COMPLETE ledger, full under the cap, lite for past-cap tool cores.
    reconcileFoldCoverage(session, resent, { mode: "repair" });
    const after2 = session.metadata["foldAnchors"] as Record<string, FoldAnchor>;
    const pastCapTools = base.filter((m, i) => i >= CAP && isTool(m));
    for (const m of pastCapTools) {
        const a = after2[`${m.id}_remint`];
        assert.ok(a !== undefined, `post-refold past-cap tool core ${m.id} must be anchored`);
        assert.equal(a.n, undefined, "minted past the cap → lite shape");
        assert.equal(a.t, m.toolCallId);
    }
    const fullAfter2 = Object.values(after2).filter((a) => a.n !== undefined).length;
    assert.ok(fullAfter2 > 0 && fullAfter2 <= CAP, "cap intact after the refold");

    // Pass 3 — steady state: the ledger is frozen (pure reuse) and no drift
    // state accrues. The session is drift-proof for tool cores at this length.
    const keysBefore = Object.keys(after2).sort().join("\n");
    reconcileFoldCoverage(session, resent, { mode: "repair" });
    const after3 = session.metadata["foldAnchors"] as Record<string, FoldAnchor>;
    assert.equal(Object.keys(after3).sort().join("\n"), keysBefore, "steady-state pass must neither add nor drop anchors");
    assert.notEqual(session.metadata["foldDriftEscalated"], true, "converged session must not carry the destruction latch");
});
