// #3641 doctrine characterization — "snapshot is the session":
//   order carries, hash is a hint, deletion is benign, wholesale shape
//   churn re-anchors, and total collapse asks for an epoch confirm
//   instead of silently resetting.
//
// These fixtures replay the two production incidents:
//   #3640 — opencode switched /chat/completions → /v1/messages mid-session:
//           96.2% textual overlap, yet 298 covered ids churned wholesale
//           (norms changed with the shape), no positional fence survived,
//           every claim tier starved → 3-pass streak → "substrate appears
//           destroyed" misdiagnosis + unresolved summary anchors parked at
//           the very tail, riding AFTER the user's newest question.
//   #3588 — dsh image-offload rewrote history images into placeholder text:
//           the whole empty-text image family (ids clustered _1.._N) churned
//           at once, no sh/wh anchors exist for empty-text cores → same
//           destroyed misdiagnosis.
//   #2695 — host truncation (a covered slice dropped client-side) reaped
//           healthy blocks instead of retaining the snapshot.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { simhashHex, hammingHex } from "../src/affinity-simhash.ts";
import {
    normalizedIdentity,
    canonicalTextOf,
    reconcileFoldCoverage,
    wordBagDigest,
    type FoldAnchor,
} from "../src/fold-reconcile.ts";
import { epochConfirmPending, METADATA_DRIFT_ESCALATED } from "../src/fold-reconcile.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

function msg(id: string, role: string, text: string, extra?: Partial<CoreMessage>): CoreMessage {
    return { id, role, contentType: "text", text, ...extra } as CoreMessage;
}
function anchorOf(m: CoreMessage): FoldAnchor {
    const a: FoldAnchor = { n: normalizedIdentity(m), r: m.role, c: m.contentType, b: m.text?.length ?? 0 };
    if (m.toolCallId) {
        a.t = m.toolCallId;
    }
    if (m.text && m.text !== "" && m.contentType !== "reasoning") {
        a.sh = simhashHex(canonicalTextOf(m.text));
        a.wh = wordBagDigest(canonicalTextOf(m.text));
    }
    return a;
}
function fakeSession(ids: string[], msgs: CoreMessage[], agent?: string): Session {
    const anchors: Record<string, FoldAnchor> = {};
    for (const m of msgs) if (ids.includes(m.id as string)) anchors[m.id as string] = anchorOf(m);
    const s = {
        id: "s-doctrine",
        // order array mirrors production semantics: the FULL last-pass wire
        // order (all inbound ids), not just the covered subset — the #3641
        // truncation witness and flank pairing read it (fold-reconcile writes
        // plan.newOrder there every pass).
        metadata: { foldAnchors: anchors, foldAnchorOrder: msgs.map((m) => m.id as string) },
        state: {
            blocks: [{ active: true, blockId: "blk-1", effectiveMessageIds: [...ids], directMessageIds: [...ids] }],
            messageRefs: { byRaw: {}, byRef: {} },
        },
    } as unknown as Session;
    if (agent !== undefined) s.metadata.pluginAgent = agent;
    return s;
}
const repair = (log?: (l: string, m: string) => void) => ({ mode: "repair" as const, sessionId: "s-doctrine", log: log ?? (() => {}) });

/** #3640 shape: prose history where every id churns and the normalized
 *  identity changes with the shape (tool cells re-formed, whitespace
 *  re-wrapped) while the WORDS survive — 96%+ overlap, zero exact channels. */
function shapeHistory(): CoreMessage[] {
    const out: CoreMessage[] = [msg("h0", "user", "preamble describing the project goals and constraints in detail")];
    for (let i = 1; i <= 9; i++) {
        out.push(msg(`h${i}`, i % 2 ? "user" : "assistant", `turn ${i} body with distinctive vocabulary marker ${i} and enough prose to shingle`));
    }
    out.push(msg("h10", "user", "the newest question the user just asked"));
    return out;
}
function reshape(old: CoreMessage[], gen: string): CoreMessage[] {
    // every id re-minted; EVERY prose cell re-wrapped with space → line
    // break (norm and positional fingerprints change, wordbag stays
    // identical, simhash hamming stays 0) — so NO cell is claimable by any
    // cheaper tier and the whole mass lands on the shape tier: ids differ
    // (byNorm ✗ — canonical text changed), no fence ever verifies (byPos ✗),
    // nothing tool (byTool/byTwin ✗), no bracket (byOrder ✗), sim gaps
    // never recorded (gapPairs empty) ✗. Deleting the shape tier makes this
    // fixture escalate (claims.size === 0 → totalDrift) — the no-escalation
    // assertion below has teeth because of this, not by luck.
    return old.map((m, i) => msg(`${gen}_${i}`, m.role, (m.text ?? "").replace(/ /g, "\n")));
}

describe("#3640 wholesale shape churn re-anchors by wordbag evidence", () => {
    test("protocol-switch resend: no destroyed escalation, coverage re-keyed, next pass clean", () => {
        const old = shapeHistory();
        const session = fakeSession(old.slice(0, 9).map((m) => m.id as string), old);
        const logs: string[] = [];
        const reshaped = reshape(old, "g1");
        // the first pass must actually route the mass through the shape tier
        // — byShape > 0 is the tier's footprint on this fixture (every cell
        // \n-rewrapped, so no cheaper channel can claim any of them).
        const first = reconcileFoldCoverage(session, reshaped, repair((l, m) => logs.push(`${l}: ${m}`)));
        assert.ok(first.byShape > 0, "the reshaped mass is claimed by the shape tier, not silently unmatched");
        for (let pass = 1; pass < 4; pass++) reconcileFoldCoverage(session, reshaped, repair((l, m) => logs.push(`${l}: ${m}`)));
        assert.notEqual(session.metadata[METADATA_DRIFT_ESCALATED], true,
            "word-preserving wholesale churn must not diagnose substrate destruction");
        const block = (session.state as { blocks: Array<{ effectiveMessageIds: string[] }> }).blocks[0]!;
        assert.ok(block.effectiveMessageIds.some((id) => id.startsWith("g1_")), "coverage re-keyed onto the reshaped ids");
        // and the very next stable pass is silent (no drift noise left)
        const before = logs.length;
        reconcileFoldCoverage(session, reshaped, repair((l, m) => logs.push(`${l}: ${m}`)));
        assert.ok(!logs.slice(before).some((line) => line.includes("drifted") || line.includes("destroyed")),
            "after re-keying a stable resend is quiet");
    });
});

describe("#3588 image-offload family (empty-text anchors) re-anchors", () => {
    test("placeholder rewrite of the image family: coverage re-keyed, no escalation", () => {
        // the real incident: a family of user turns whose ONLY content was an
        // image (text "") shares one base identity; offload rewrites each into
        // a short placeholder string — every family id churns at once. 12
        // members cross the destroy MIN_UNMATCHED=10 bar, so an unclaimed
        // family WOULD escalate today.
        const family = 12;
        const old: CoreMessage[] = [msg("p0", "user", "prose turn with real words for the flanks")];
        for (let i = 1; i <= family; i++) old.push(msg(`img_${i}`, "user", "")); // empty text → no sh/wh
        for (let i = 1; i <= 3; i++) old.push(msg(`q${i}`, i % 2 ? "user" : "assistant", `trailing prose turn ${i} keeps talking about architecture`));
        const covered = old.slice(0, 1 + family).map((m) => m.id as string);
        const session = fakeSession(covered, old);
        const offloaded = [
            old[0]!,
            ...Array.from({ length: family }, (_, k) => msg(`off_${k + 1}`, "user", `[image ${k + 1} offloaded to save context]`)),
            ...old.slice(1 + family),
        ];
        for (let pass = 0; pass < 4; pass++) reconcileFoldCoverage(session, offloaded, repair());
        assert.notEqual(session.metadata[METADATA_DRIFT_ESCALATED], true, "offload is a transform, not destruction");
        const block = (session.state as { blocks: Array<{ effectiveMessageIds: string[] }> }).blocks[0]!;
        assert.ok(block.effectiveMessageIds.some((id) => id.startsWith("off_")),
            "the image family coverage re-keyed onto placeholder ids (the block still covers the slots)");
    });
});

describe("#2695 host truncation retains the snapshot (benign deletion)", () => {
    test("covered slice dropped client-side: no reap, no escalation, one benign note", () => {
        // 18-message history, covered prefix of 8, and the client keeps a
        // 10-turn tail — the tail must clear SIDE_REQUEST_MAX_MSGS (the
        // reconcile guard skips tiny resends as side-request-shaped), and a
        // 10-turn tail is exactly a windowed host.
        const old: CoreMessage[] = [];
        for (let i = 0; i < 18; i++) old.push(msg(`t${i}`, i % 2 ? "user" : "assistant", `history turn ${i} with words to shingle properly`));
        // proxy mode: no pluginAgent → the #2695 reap arm is armed
        const session = fakeSession(old.slice(0, 8).map((m) => m.id as string), old);
        // host drops the covered slice entirely, keeps the tail verbatim
        const truncated = old.slice(8);
        const logs: string[] = [];
        for (let pass = 0; pass < 5; pass++) reconcileFoldCoverage(session, truncated, repair((l, m) => logs.push(`${l}: ${m}`)));
        assert.notEqual(session.metadata[METADATA_DRIFT_ESCALATED], true, "client-side truncation is sanctioned host behavior");
        const blocks = (session.state as { blocks: Array<{ blockId?: string; active: boolean }> }).blocks;
        assert.ok(blocks.some((b) => b.blockId === "blk-1"), "the snapshot block is retained, not reaped");
        const conflicts = (session.metadata["conflicts"] as Array<{ kind?: string }> | undefined) ?? [];
        assert.ok(!conflicts.some((c) => c.kind === "orphan-reap"), "no reap ledger entry");
        assert.ok(logs.some((line) => line.startsWith("info") && /truncat|dropped/i.test(line)),
            "one benign info line names the truncation");
    });
});

describe("#3724 host rewind/undo (tail truncation) retains the snapshot", () => {
    test("newest covered turns rewound away: no reap, no false epoch-confirm, exactly one benign note", () => {
        // 30-message history; the fold covers the NEWEST 10 (t20..t29). A warm
        // pass establishes the snapshot (coverage e=1) while the span is fully
        // on the wire. The host then rewinds PAST the fold: the resent wire
        // keeps only the head (t0..t19) and drops t20..t29 — a clean PREFIX-CUT
        // of the pre-rewind wire, with 10 class-carrying covered ids vanishing
        // and zero word evidence left behind. Without the #3724 mirror signal
        // this reads as total-loss drift (claims 0, unmatched 10 >= the mass
        // bar) -> a false "epoch confirmation" after 3 passes, while the
        // proxy-mode reap arm destroys the snapshot (z streak, e already 1).
        const old: CoreMessage[] = [];
        for (let i = 0; i < 30; i++) old.push(msg(`t${i}`, i % 2 ? "user" : "assistant", `history turn ${i} with distinctive vocabulary marker word ${i} for shingle coverage`));
        const covered = old.slice(20).map((m) => m.id as string);
        // proxy mode: no pluginAgent -> the #2695 reap arm is armed
        const session = fakeSession(covered, old);
        // warm pass: the folded span is fully present -> snapshot e=1, no drift
        reconcileFoldCoverage(session, old, repair());
        // host rewinds past the fold: keep the head verbatim, drop the newest 10
        const rewound = old.slice(0, 20);
        const logs: string[] = [];
        const first = reconcileFoldCoverage(session, rewound, repair((l, m) => logs.push(`${l}: ${m}`)));
        assert.equal(first.claims, 0, "a rewound span is absent, not re-encoded churn (nothing to re-anchor onto)");
        for (let pass = 1; pass < 5; pass++) reconcileFoldCoverage(session, rewound, repair((l, m) => logs.push(`${l}: ${m}`)));
        assert.notEqual(session.metadata[METADATA_DRIFT_ESCALATED], true,
            "a host rewind is sanctioned deletion, not substrate destruction");
        assert.equal(epochConfirmPending(session), false, "no false epoch-confirmation ask for a clean tail cut");
        const blocks = (session.state as { blocks: Array<{ blockId?: string }> }).blocks;
        assert.ok(blocks.some((b) => b.blockId === "blk-1"), "the snapshot block is retained, not reaped");
        const conflicts = (session.metadata["conflicts"] as Array<{ kind?: string }> | undefined) ?? [];
        assert.ok(!conflicts.some((c) => c.kind === "orphan-reap"), "no reap ledger entry");
        const notes = logs.filter((line) => line.startsWith("info") && /rewind|undo|truncat/i.test(line));
        assert.ok(notes.length >= 1, "one benign info line names the rewind/tail truncation");
        assert.ok(notes.length <= 1, "exactly one note per episode (cross-gated), not one per stable resend");
    });
});

describe("#3641 total collapse asks for epoch confirmation", () => {
    test("nothing matches anywhere: escalated + epoch-confirm latch + folds suspended until recovery", () => {
        const old: CoreMessage[] = [];
        for (let i = 0; i < 10; i++) old.push(msg(`c${i}`, i % 2 ? "user" : "assistant", `conversation turn ${i} with distinct vocabulary`));
        const session = fakeSession(old.map((m) => m.id as string), old);
        // a completely different conversation under the same session id
        const foreign: CoreMessage[] = [];
        for (let i = 0; i < 14; i++) foreign.push(msg(`x${i}`, i % 2 ? "user" : "assistant", `unrelated fresh content ${i} about a brand new topic entirely`));
        const logs: string[] = [];
        for (let pass = 0; pass < 4; pass++) reconcileFoldCoverage(session, foreign, repair((l, m) => logs.push(`${l}: ${m}`)));
        assert.equal(session.metadata[METADATA_DRIFT_ESCALATED], true, "detection intact: the collapse is still flagged");
        assert.equal(epochConfirmPending(session), true, "epoch confirmation is latched, not a silent reset");
        assert.ok(logs.some((line) => line.startsWith("error") && /epoch/i.test(line)), "one error asks the user to confirm the new epoch");
        // recovery: the host resends the original history → the latch clears
        reconcileFoldCoverage(session, old, repair((l, m) => logs.push(`${l}: ${m}`)));
        assert.notEqual(epochConfirmPending(session), true, "identity restored → the epoch latch auto-clears");
    });
});

describe("shape tier honesty gates (no wholesale claiming)", () => {
    test("wordbag-equal candidates that flip role, pad length, or reorder words are NOT shape-claimed", () => {
        // #3641 review: the shape tier pairs on wordbag equality, so the
        // gates around it are the only thing keeping a same-words-but-
        // different message from being claimed. Each candidate below keeps
        // the word multiset identical and violates exactly one guard:
        // role flip, whitespace length padding (wordbag tokenizes words
        // only), or word-order reversal (simhash is bigram-shingled, so
        // order changes the sketch). No cheaper tier claims them either
        // (identity includes role; the length collision guard in byNorm
        // rejects the padding) — so all six residuals reach the shape tier
        // and every pairing must be refused.
        const old: CoreMessage[] = [];
        for (let i = 0; i < 6; i++) old.push(msg(`g${i}`, i % 2 ? "user" : "assistant", `gate turn ${i} with vocabulary ${i} to shingle across the sentence for hashing`));
        const session = fakeSession(old.map((m) => m.id as string), old);
        const reversed = (t: string) => t.split(" ").reverse().join(" ");
        const wire: CoreMessage[] = [
            msg("w0", "assistant", old[0]!.text!), // role flip
            msg("w1", "user", old[1]!.text!), // role flip
            msg("w2", "user", old[2]!.text! + " ".repeat(600)), // length beyond the guard, wordbag identical
            msg("w3", "user", old[3]!.text! + " ".repeat(600)),
            msg("w4", "user", reversed(old[4]!.text!)), // word order reversed → bigram shingles change
            msg("w5", "user", reversed(old[5]!.text!)),
        ];
        const r = reconcileFoldCoverage(session, wire, repair());
        assert.equal(r.byShape, 0, "edit-honesty gates (role, length, simhash) must refuse every pairing");
    });
});

describe("honesty gates survive the doctrine (no wholesale silencing)", () => {

    test("epoch-confirm suspends preflight compression (verbatim passthrough until realigned)", async () => {
        // Once the fold asks for epoch confirmation, the compression pipeline
        // must not keep folding a substrate it can no longer prove — requests
        // pass through verbatim until the histories realign (or the user
        // confirms a new epoch). No fold happens on the gated session.
        const old: CoreMessage[] = [];
        for (let i = 0; i < 10; i++) old.push(msg(`t${i}`, i % 2 ? "user" : "assistant", `history turn ${i} with words to shingle properly`));
        const session = fakeSession(old.map((m) => m.id as string), old);
        const foreign: CoreMessage[] = [];
        for (let i = 0; i < 14; i++) foreign.push(msg(`x${i}`, i % 2 ? "user" : "assistant", `foreign conversation content ${i} ${"z".repeat(120)}`));
        const logs: { level: string; msg: string }[] = [];
        const rl = (l: string, m: string) => logs.push({ level: l, msg: m });
        for (let pass = 0; pass < 3; pass++) reconcileFoldCoverage(session, foreign, repair(rl));
        assert.equal((session.metadata as Record<string, unknown>)["foldEpochConfirmPending"], true);
        const { preflightCompress } = await import("../src/preflight.ts");
        const { defaultPrompts } = await import("acp-kernel");
        const result = await preflightCompress({
            core: {} as never, // untouched on the gated path
            config: { modelContextLimit: 1000 } as never,
            session: session as never,
            prompts: defaultPrompts,
            protocol: "responses",
            url: "http://127.0.0.1:1/summary-must-not-be-called",
            headers: {},
            model: "m",
            log: rl,
        }, foreign);
        assert.equal(result.compressedRanges, 0, "epoch-confirm gate: verbatim passthrough");
        assert.equal(result.savedTokens, 0);
        assert.equal(session.state.blocks.length, 1, "the existing snapshot is kept untouched");
    });

    test("a genuine edit below the mass bar still reports drift honestly", () => {
        const old: CoreMessage[] = [];
        for (let i = 0; i < 10; i++) old.push(msg(`e${i}`, i % 2 ? "user" : "assistant", `steady turn ${i} prose for the stable spine of this session`));
        const session = fakeSession(old.slice(0, 6).map((m) => m.id as string), old);
        const edited = old.map((m, i) => (i === 3 ? msg("edited_3", m.role, "totally rewritten content with different meaning and words") : m));
        const logs: string[] = [];
        for (let pass = 0; pass < 3; pass++) reconcileFoldCoverage(session, edited, repair((l, m) => logs.push(`${l}: ${m}`)));
        assert.ok(logs.some((line) => line.includes("e3") || line.includes("drifted")), "the honestly-edited cell still reports");
        assert.notEqual(session.metadata[METADATA_DRIFT_ESCALATED], true, "single-cell churn never mass-escalates");
    });
});

describe("#5715 partial interior loss with a surviving direct-ID majority is NOT total drift", () => {
    // 30-turn history, every turn folded in. The host drops TEN INTERIOR turns
    // (neither a head cut nor a tail rewind) while the other TWENTY ride
    // verbatim on the wire. The #3641 verdict classifier only saw
    // claims==0 + unmatched>0 and never counted the twenty surviving DIRECT
    // matches, so three such passes latched epoch-confirm and paused
    // compression on a healthy session (#5715 field: 1162/1171 direct-present,
    // ten interior missing). A strict direct-ID majority is the opposite of
    // wholesale replacement and must not read as substrate destruction.
    function interiorLossFixture(): { old: CoreMessage[]; covered: string[]; wire: CoreMessage[] } {
        const old: CoreMessage[] = [];
        for (let i = 0; i < 30; i++) {
            old.push(msg(`t${i}`, i % 2 ? "user" : "assistant",
                `history turn ${i} with distinctive vocabulary marker word ${i} for shingle coverage`));
        }
        const covered = old.map((m) => m.id as string);
        const removed = new Set([4, 6, 8, 10, 12, 14, 16, 18, 20, 22]); // ten INTERIOR turns
        const wire = old.filter((_, i) => !removed.has(i));
        return { old, covered, wire };
    }

    test("ten interior turns dropped, twenty verbatim: no escalation, no epoch-confirm latch", () => {
        const { old, covered, wire } = interiorLossFixture();
        const session = fakeSession(covered, old, "dsh");
        for (let pass = 0; pass < 4; pass++) reconcileFoldCoverage(session, wire, repair());
        assert.notEqual(session.metadata[METADATA_DRIFT_ESCALATED], true,
            "a surviving strict direct-ID majority is not substrate destruction");
        assert.equal(epochConfirmPending(session), false,
            "partial interior loss must not ask for an epoch confirmation");
        const blocks = (session.state as { blocks: Array<{ blockId?: string }> }).blocks;
        assert.ok(blocks.some((b) => b.blockId === "blk-1"), "the snapshot block is retained, not reaped");
    });

    test("the same interior-loss shape is tolerated in proxy mode too (lane-agnostic)", () => {
        const { old, covered, wire } = interiorLossFixture();
        const session = fakeSession(covered, old); // no pluginAgent -> proxy mode
        for (let pass = 0; pass < 4; pass++) reconcileFoldCoverage(session, wire, repair());
        assert.equal(epochConfirmPending(session), false,
            "direct-ID majority continuity is identity evidence on every lane, not just DSH");
    });

    test("an already-pending stale latch clears once the healthy majority is back", () => {
        const { old, covered } = interiorLossFixture();
        const session = fakeSession(covered, old, "dsh");
        // A persisted pending latch whose drift streak was already cleared
        // (#5715 second site: prevStreak===0 must not strand the pause).
        session.metadata["foldEpochConfirmPending"] = true;
        assert.equal(epochConfirmPending(session), true, "precondition: the latch is pending");
        // the original history is back on the wire wholesale -> a clean realigned pass
        reconcileFoldCoverage(session, old, repair());
        assert.equal(epochConfirmPending(session), false,
            "strong direct continuity on an already-pending session recovers compression");
    });

    test("an explained head cut keeps its own note — the majority note stays silent", () => {
        // 30 fully-covered turns; the host drops the OLDEST ten (a head cut —
        // truncationExplained territory, #2695) while twenty ride verbatim,
        // which is ALSO a strict direct-ID majority. The #2695 note owns this
        // episode: the #5715 majority note must not fire a second line
        // mislabeling the head cut as "interior" loss.
        const old: CoreMessage[] = [];
        for (let i = 0; i < 30; i++) {
            old.push(msg(`t${i}`, i % 2 ? "user" : "assistant",
                `history turn ${i} with distinctive vocabulary marker word ${i} for shingle coverage`));
        }
        const session = fakeSession(old.map((m) => m.id as string), old);
        reconcileFoldCoverage(session, old, repair()); // warm pass: coverage established
        const logs: string[] = [];
        for (let pass = 0; pass < 4; pass++) reconcileFoldCoverage(session, old.slice(10), repair((l, m) => logs.push(`${l}: ${m}`)));
        assert.ok(logs.some((line) => line.startsWith("info") && /truncat/i.test(line)),
            "the #2695 truncation note still names the head cut");
        assert.ok(!logs.some((line) => line.includes("partial interior loss")),
            "an already-explained episode is not double-reported as interior loss");
    });

    test("genuine wholesale replacement STILL escalates (the gate did not weaken detection)", () => {
        const { old, covered } = interiorLossFixture();
        const session = fakeSession(covered, old, "dsh");
        const foreign: CoreMessage[] = [];
        for (let i = 0; i < 14; i++) foreign.push(msg(`x${i}`, i % 2 ? "user" : "assistant",
            `unrelated fresh content ${i} about a brand new topic entirely`));
        for (let pass = 0; pass < 4; pass++) reconcileFoldCoverage(session, foreign, repair());
        assert.equal(session.metadata[METADATA_DRIFT_ESCALATED], true, "detection intact: the collapse is still flagged");
        assert.equal(epochConfirmPending(session), true, "wholesale replacement still asks for an epoch confirmation");
    });

    // #5715 field report (independent 0.1.213/Linux-DSH confirmation): the
    // surviving-majority base must be ACTIVE coverage alone. A successful
    // rewind deactivates an old fold (#4050 lineage) whose ids legitimately
    // leave the wire; counting those absent inactive recovery candidates in
    // the denominator dilutes a healthy active direct-ID majority below the
    // bar and re-latches epoch-confirm on a live session.
    test("absent inactive recovery candidates cannot dilute a healthy active majority", () => {
        const active: CoreMessage[] = [];
        for (let i = 0; i < 20; i++) {
            active.push(msg(`a${i}`, i % 2 ? "user" : "assistant",
                `live turn ${i} alpha distinctive vocabulary ${i} shingle coverage body`));
        }
        const rewound: CoreMessage[] = [];
        for (let i = 0; i < 30; i++) {
            rewound.push(msg(`r${i}`, i % 2 ? "user" : "assistant",
                `retired rewound turn ${i} beta distinctive vocabulary ${i} long deactivated`));
        }
        const anchors: Record<string, FoldAnchor> = {};
        for (const m of [...active, ...rewound]) anchors[m.id as string] = anchorOf(m);
        const droppedActive = new Set([3, 14]); // two INTERIOR live turns lost
        const wire = [...active.filter((_, i) => !droppedActive.has(i)),
            ...Array.from({ length: 6 }, (_, i) => msg(`n${i}`, i % 2 ? "user" : "assistant", `fresh turn ${i} gamma vocabulary ${i}`))];
        // Order backbone sandwiches the deactivated block between two LIVE halves
        // so its absence is interior, not a head/tail truncation run.
        const order = [...active.slice(0, 10).map((m) => m.id as string),
            ...rewound.map((m) => m.id as string),
            ...active.slice(10).map((m) => m.id as string)];
        const session = {
            id: "s-doctrine",
            metadata: { foldAnchors: anchors, foldAnchorOrder: order, pluginAgent: "dsh" },
            state: {
                blocks: [
                    { active: true, blockId: "blk-live", effectiveMessageIds: active.map((m) => m.id as string), directMessageIds: active.map((m) => m.id as string) },
                    { active: false, blockId: "blk-rewound", effectiveMessageIds: rewound.map((m) => m.id as string), directMessageIds: rewound.map((m) => m.id as string) },
                ],
                messageRefs: { byRaw: {}, byRef: {} },
            },
        } as unknown as Session;
        for (let pass = 0; pass < 4; pass++) reconcileFoldCoverage(session, wire, repair());
        assert.ok((session.metadata["foldDriftStreak"] as number ?? 0) >= 3,
            "precondition: drift WAS detected (total-loss verdict held, no explainer) — the gate, not an explainer, decides");
        assert.equal(epochConfirmPending(session), false,
            "absent inactive recovery candidates must not mask a healthy active direct-ID majority");
        assert.notEqual(session.metadata[METADATA_DRIFT_ESCALATED], true,
            "partial active loss plus legitimate rewind residuals is not substrate destruction");
    });

    // #5715 field report negative control: a "surviving majority" made ONLY of
    // reasoning cores must never satisfy the bar — reasoning is excluded from
    // both numerator and denominator, so a genuine HARD (text/tool) loss still
    // escalates even when many thinking cores ride verbatim on the wire.
    test("reasoning-only survivors do not mask a hard (text) loss", () => {
        const text: CoreMessage[] = [];
        for (let i = 0; i < 20; i++) {
            text.push(msg(`t${i}`, i % 2 ? "user" : "assistant",
                `hard turn ${i} delta distinctive vocabulary ${i} shingle body here`));
        }
        const reasoning: CoreMessage[] = [];
        for (let i = 0; i < 20; i++) {
            reasoning.push(msg(`q${i}`, "assistant", `thinking core ${i} epsilon vocabulary ${i}`, { contentType: "reasoning" }));
        }
        const anchors: Record<string, FoldAnchor> = {};
        for (const m of [...text, ...reasoning]) anchors[m.id as string] = anchorOf(m);
        const droppedText = new Set([1, 3, 5, 7, 9, 11, 13, 15, 17, 19]); // ten INTERIOR hard turns lost
        const wire = [...text.filter((_, i) => !droppedText.has(i)), ...reasoning];
        const session = {
            id: "s-doctrine",
            metadata: { foldAnchors: anchors, foldAnchorOrder: [...text, ...reasoning].map((m) => m.id as string), pluginAgent: "dsh" },
            state: {
                blocks: [{ active: true, blockId: "blk-1", effectiveMessageIds: [...text, ...reasoning].map((m) => m.id as string), directMessageIds: [...text, ...reasoning].map((m) => m.id as string) }],
                messageRefs: { byRaw: {}, byRef: {} },
            },
        } as unknown as Session;
        for (let pass = 0; pass < 4; pass++) reconcileFoldCoverage(session, wire, repair());
        assert.equal(epochConfirmPending(session), true,
            "twenty surviving reasoning cores are not a surviving HARD majority — the text loss still escalates");
        assert.equal(session.metadata[METADATA_DRIFT_ESCALATED], true,
            "excluding reasoning from the majority base keeps detection honest");
    });

    // #5715 tie-breaker: exactly HALF the active hard ids present is NOT a clear
    // surviving majority (strict > half required). A repeated exactly-half loss
    // is itself a strong anomaly — under-detecting a real 50% collapse is worse
    // than one confirmable epoch prompt, so the bar stays strict at the boundary.
    test("exactly half present is not a clear majority (strict boundary)", () => {
        const old: CoreMessage[] = [];
        for (let i = 0; i < 20; i++) {
            old.push(msg(`t${i}`, i % 2 ? "user" : "assistant",
                `half turn ${i} zeta distinctive vocabulary ${i} shingle coverage`));
        }
        const session = fakeSession(old.map((m) => m.id as string), old, "dsh");
        const removed = new Set([1, 3, 5, 7, 9, 11, 13, 15, 17, 19]); // exactly ten of twenty
        const wire = old.filter((_, i) => !removed.has(i));
        for (let pass = 0; pass < 4; pass++) reconcileFoldCoverage(session, wire, repair());
        assert.equal(epochConfirmPending(session), true,
            "ten-of-twenty present is not a strict majority — the terminal verdict may still fire");
    });
});
