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
