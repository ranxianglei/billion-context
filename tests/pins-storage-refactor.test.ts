// Storage-refactor pins (S2 invariants + S3 seeded fuzz) — pre-refactor guard
// rails, owner directive 2026-10-11 ("重构之前先打桩").
//
// What these pins protect: the unified-storage refactor must preserve the
// KERNEL CONTRACT of the current engine byte-for-byte at the semantic level.
// These tests pin that contract mechanically so any drift turns red before it
// ships:
//
//   I1 ref-map bijection      byRaw ⇄ byRef are perfect inverses; every ref
//                             matches /^m\d{5,}$/ (kernel/src/refs.ts).
//   I2 ref identity stability a ref number NEVER maps to a different raw id,
//                             and a known raw id NEVER changes its ref, across
//                             growth, folds and client edits (id-never-reused
//                             Kernel Contract; T2 of cache-theorem #2149).
//   I3 block id/edge sanity   blockId /^b\d+$/ strictly below nextBlockId;
//                             directBlockIds reference existing blocks; the
//                             supersede graph is acyclic.
//   I4 active disjointness    the effectiveMessageIds of ACTIVE blocks are
//                             pairwise disjoint (the fold view is a partition,
//                             never a double cover).
//   I5 coverage resolvable    every effectiveMessageId of every block is a
//                             known raw id in byRaw (blocks only cover real
//                             history, never invented ids).
//   I6 tombstone semantics    deadRefs are known refs, unique+sorted, and
//                             NEVER cover a currently-visible message
//                             (tombstone-with-clear, #2362/#2370).
//   I7 cursor monotonicity    nextBlockId/nextRunId exceed every existing id.
//
// S3 (bottom) replays a seeded PRNG command stream (grow / fold / deactivate /
// client-edit) through the real kernel core, checking every invariant after
// every step. It doubles as the Phase-1 differential baseline: the new store
// must reproduce this whole stream with identical states.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage, CompressionState } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap, deactivateBlock } from "acp-kernel";

// ── helpers ────────────────────────────────────────────────────────────────

const REF_RE = /^m\d{5,}$/;
const BLOCK_RE = /^b\d+$/;

function makeMsgs(n: number, tag = "raw"): CoreMessage[] {
    return Array.from({ length: n }, (_, i) => ({
        id: `${tag}${i + 1}`,
        role: i % 2 ? "assistant" : "user",
        contentType: "text",
        text: `message body ${tag}${i + 1} lorem ipsum dolor sit amet `.repeat(20),
    })) as unknown as CoreMessage[];
}

function visibleIds(messages: CoreMessage[]): Set<string> {
    return new Set(messages.map((m) => m.id));
}

/** All seven invariants over a state + the currently-visible message list. */
function checkInvariants(state: CompressionState, messages: CoreMessage[], label: string): void {
    const byRaw = state.messageRefs.byRaw;
    const byRef = state.messageRefs.byRef;

    // I1 bijection + ref format
    for (const [raw, ref] of Object.entries(byRaw)) {
        assert.ok(REF_RE.test(ref), `${label} I1: ref ${ref} for raw ${raw} fails format`);
        assert.equal(byRef[ref], raw, `${label} I1: byRef[${ref}] must invert byRaw[${raw}]`);
    }
    for (const [ref, raw] of Object.entries(byRef)) {
        assert.equal(byRaw[raw], ref, `${label} I1: byRaw[${raw}] must invert byRef[${ref}]`);
        assert.ok(REF_RE.test(ref), `${label} I1: ref key ${ref} fails format`);
    }

    // I3 block id / edge sanity + acyclicity
    const knownBlocks = new Set(state.blocks.map((b) => b.blockId));
    for (const b of state.blocks) {
        assert.ok(BLOCK_RE.test(b.blockId), `${label} I3: blockId ${b.blockId} fails format`);
        assert.ok(Number(b.blockId.slice(1)) < state.nextBlockId, `${label} I3: ${b.blockId} >= nextBlockId ${state.nextBlockId}`);
        for (const parent of b.directBlockIds) {
            assert.ok(knownBlocks.has(parent), `${label} I3: ${b.blockId} supersede edge to unknown ${parent}`);
        }
    }
    for (const start of state.blocks) {
        const seen = new Set<string>();
        let queue = [...start.directBlockIds];
        while (queue.length > 0) {
            const id = queue.shift()!;
            if (seen.has(id)) continue;
            seen.add(id);
            const parent = state.blocks.find((b) => b.blockId === id);
            assert.ok(parent, `${label} I3: supersede walk from ${start.blockId} hit unknown ${id}`);
            if (id === start.blockId) assert.fail(`${label} I3: supersede cycle through ${id}`);
            queue.push(...parent.directBlockIds);
        }
    }

    // I4 active disjointness + I5 coverage resolvable
    const active = state.blocks.filter((b) => b.active);
    const claimed: Map<string, string> = new Map();
    for (const b of state.blocks) {
        for (const id of b.effectiveMessageIds) {
            assert.ok(
                Object.prototype.hasOwnProperty.call(byRaw, id),
                `${label} I5: ${b.blockId} covers ${id} which is not a known raw id`,
            );
            if (!b.active) continue;
            const prior = claimed.get(id);
            assert.equal(prior, undefined, `${label} I4: ${id} covered by both ${prior} and ${b.blockId} (active)`);
            claimed.set(id, b.blockId);
        }
    }

    // I6 tombstone semantics
    const visible = visibleIds(messages);
    if (state.deadRefs !== undefined) {
        assert.ok(state.deadRefs.length > 0, `${label} I6: deadRefs present but empty (must be undefined)`);
        const seen = new Set<string>();
        let prev = -1;
        for (const ref of state.deadRefs) {
            assert.ok(REF_RE.test(ref), `${label} I6: deadRef ${ref} fails format`);
            assert.ok(!seen.has(ref), `${label} I6: duplicate deadRef ${ref}`);
            seen.add(ref);
            const n = Number(ref.slice(1));
            assert.ok(n > prev, `${label} I6: deadRefs not sorted ascending at ${ref}`);
            prev = n;
            assert.ok(byRef[ref] !== undefined, `${label} I6: deadRef ${ref} has no byRef entry`);
            assert.ok(!visible.has(byRef[ref]), `${label} I6: deadRef ${ref} covers visible message ${byRef[ref]} (tombstone must lift)`);
        }
    }

    // I7 cursor monotonicity
    for (const b of state.blocks) {
        assert.ok(Number(b.blockId.slice(1)) < state.nextBlockId, `${label} I7: ${b.blockId} >= nextBlockId`);
        const runN = Number(String(b.runId).replace(/^run/, ""));
        if (Number.isFinite(runN) && String(b.runId).startsWith("run")) {
            assert.ok(runN < state.nextRunId, `${label} I7: runId ${b.runId} >= nextRunId ${state.nextRunId}`);
        }
    }
}

interface Engine {
    core: ReturnType<typeof createCore>;
    config: ReturnType<typeof defaultConfig>;
    state: CompressionState;
    messages: CoreMessage[];
    nextIndex: number;
    /** All-time ref→raw assignments: a ref number may never flip identity. */
    refIdentities: Map<string, string>;
    foldCount: number;
}

function newEngine(): Engine {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        state: createInitialState(),
        messages: [],
        nextIndex: 0,
        refIdentities: new Map(),
        foldCount: 0,
    };
}

/** Re-run assignRefs over the current view (what the request pipeline does),
 *  then enforce I2 (identity stability) against all-time history. */
function syncRefs(e: Engine): void {
    const { map, nextIndex } = assignRefs(e.messages, { existing: e.state.messageRefs, nextIndex: e.nextIndex });
    for (const [ref, raw] of Object.entries(map.byRef)) {
        const prior = e.refIdentities.get(ref);
        if (prior !== undefined && prior !== raw) {
            assert.fail(`I2: ref ${ref} re-minted for ${raw} (was ${prior}) — id-never-reused violation`);
        }
        e.refIdentities.set(ref, raw);
    }
    for (const [raw, ref] of Object.entries(e.state.messageRefs.byRaw)) {
        assert.equal(map.byRaw[raw], ref, `I2: raw id ${raw} changed ref ${ref} → ${map.byRaw[raw]}`);
    }
    e.state.messageRefs = map;
    e.nextIndex = nextIndex;
}

function refFor(e: Engine, raw: string): string | undefined {
    return e.state.messageRefs.byRaw[raw];
}

function fold(e: Engine, startRef: string, endRef: string, summary: string): { created: number; errors: string[] } {
    const r = e.core.applyCompression({
        ranges: [{ startRef, endRef, summary }],
        messages: e.messages,
        state: e.state,
        config: e.config,
    });
    e.foldCount++;
    // NOTE: r.state must be taken even when refused — the #2370 tombstone write
    // happens on the refusal path too (deadRefs is a state transition).
    e.state = r.state;
    return { created: r.result.blocksCreated, errors: r.result.errors };
}

// ── S2: scripted scenarios ─────────────────────────────────────────────────

test("S2/A grow → fold → supersede → deactivate keeps all invariants", () => {
    const e = newEngine();
    e.messages = makeMsgs(60);
    syncRefs(e);
    checkInvariants(e.state, e.messages, "A/initial");

    const f1 = fold(e, refFor(e, "raw2")!, refFor(e, "raw20")!, "fold of raw2..raw20 ".repeat(6));
    assert.equal(f1.created, 1, `f1: ${f1.errors.join("; ")}`);
    checkInvariants(e.state, e.messages, "A/after-b1");

    const f2 = fold(e, refFor(e, "raw21")!, refFor(e, "raw40")!, "fold of raw21..raw40 ".repeat(6));
    assert.equal(f2.created, 1, `f2: ${f2.errors.join("; ")}`);
    checkInvariants(e.state, e.messages, "A/after-b2");

    // T2 distillation: re-fold the T1 block's span by BLOCK-ID refs (b1..b1) —
    // the supersede transition: directBlockIds edge + active flip in one step.
    const b1 = e.state.blocks[0].blockId;
    const f3 = fold(e, b1, b1, "tier-2 distillation of the same span ".repeat(6));
    assert.ok(f3.created >= 1, `f3 (supersede) must create a block: ${f3.errors.join("; ")}`);
    checkInvariants(e.state, e.messages, "A/after-t2");
    const superseded = e.state.blocks.filter((b) => !b.active && b.effectiveMessageIds.includes("raw2"));
    assert.ok(superseded.length > 0, "A: the T1 block must be inactive after supersede");

    // decompress path: deactivate the T2 block — coverage drops, invariants hold.
    e.state = deactivateBlock(e.state, [e.state.blocks.filter((b) => b.active)[0].blockId]);
    checkInvariants(e.state, e.messages, "A/after-deactivate");

    // more traffic after decompress, then another fold — steady state stays sane
    e.messages = [...e.messages, ...makeMsgs(10, "tail")];
    syncRefs(e);
    checkInvariants(e.state, e.messages, "A/after-grow");
});

test("S2/B client edit: ghost refs stay, tombstones mint, ref identities frozen", () => {
    const e = newEngine();
    e.messages = makeMsgs(30);
    syncRefs(e);
    const f = fold(e, refFor(e, "raw2")!, refFor(e, "raw20")!, "client-edit fixture fold ".repeat(6));
    assert.equal(f.created, 1, `fold: ${f.errors.join("; ")}`);

    // Client rewrite: raw10..raw16 deleted from the resent history, tail edited.
    const edited: CoreMessage[] = [
        ...e.messages.slice(0, 9),
        ...e.messages.slice(16, 30).map((m, i) => ({ ...m, id: m.id === "raw17" ? "raw17-edited" : m.id })),
        ...makeMsgs(3, "post"),
    ] as unknown as CoreMessage[];
    const ghostRef = refFor(e, "raw10")!;
    e.messages = edited;
    syncRefs(e);

    // Kernel Contract: ghost raw id keeps its ref; no reassignment happened.
    assert.equal(e.state.messageRefs.byRaw["raw10"], ghostRef, "B: ghost raw10 must keep its ref");
    checkInvariants(e.state, e.messages, "B/after-edit");

    // Ask to compress a consumed range whose endpoint backs the ghost → #2362
    // tombstone must be minted exactly once, sorted, and DEAD.
    const f2 = fold(e, ghostRef, refFor(e, "raw14")!, "attempt over dead range ".repeat(6));
    checkInvariants(e.state, e.messages, "B/after-dead-retry");
    assert.ok(e.state.deadRefs?.includes(ghostRef) ?? false, `B: ghostRef ${ghostRef} must be tombstoned (fold said: ${f2.created} created, ${f2.errors.join("; ")})`);
});

// ── S3: seeded fuzz over the real core ─────────────────────────────────────

/** xorshift32 — deterministic across Node versions. */
function prng(seed: number): () => number {
    let s = seed | 0;
    return () => {
        s ^= s << 13; s |= 0;
        s ^= s >>> 17;
        s ^= s << 5; s |= 0;
        return (s >>> 0) / 0x100000000;
    };
}

test("S3 seeded command fuzz: 400 random steps, invariants after every step", () => {
    const e = newEngine();
    const rand = prng(0x5eed_1234);
    let steps = 0;
    let counter = 0;

    e.messages = makeMsgs(12);
    syncRefs(e);

    for (let step = 0; step < 400; step++) {
        const op = rand();
        if (op < 0.35) {
            // grow
            counter++;
            e.messages = [...e.messages, ...makeMsgs(1 + Math.floor(rand() * 4), `g${counter}-`)];
            syncRefs(e);
        } else if (op < 0.6) {
            // fold a random span of visible refs
            const visibleRefs = e.messages.map((m) => refFor(e, m.id)!).filter(Boolean);
            if (visibleRefs.length >= 8) {
                const a = Math.floor(rand() * (visibleRefs.length - 7));
                const b = a + 4 + Math.floor(rand() * 4);
                fold(e, visibleRefs[a], visibleRefs[Math.min(b, visibleRefs.length - 1)], `fuzz fold ${step} `.repeat(8));
            }
        } else if (op < 0.75) {
            // decompress a random active block
            const active = e.state.blocks.filter((b) => b.active);
            if (active.length > 0) {
                const victim = active[Math.floor(rand() * active.length)];
                e.state = deactivateBlock(e.state, [victim.blockId]);
            }
        } else if (op < 0.85) {
            // client edit: drop 1-3 tail messages (excluding the newest)
            if (e.messages.length > 8) {
                const drop = 1 + Math.floor(rand() * 3);
                e.messages = e.messages.slice(0, e.messages.length - drop - 1).concat(e.messages.slice(-1));
                syncRefs(e);
            }
        } else {
            // no-op turn: refs resync must be a pure function of the view
            syncRefs(e);
        }
        steps++;
        checkInvariants(e.state, e.messages, `S3/step${step}`);
    }

    // Falsifiable summary: the stream must actually exercise the machinery.
    assert.ok(e.foldCount >= 40, `S3: too few fold attempts (${e.foldCount}) — fuzz is not exercising the engine`);
    assert.ok(e.state.blocks.length >= 5, `S3: too few blocks (${e.state.blocks.length})`);
    assert.equal(steps, 400);
    assert.ok(e.refIdentities.size >= 12, "S3: ref identities must have accumulated");
});
