// #4788 D2 (decision #4792 D1-A + option 2): server-side resident-memory
// minimization. Covers the four acceptance behaviors of the new machinery:
//   (a) between-turns drops — at every request-end boundary whose save has
//       provably landed, droppable resident fields discharge back to disk;
//   (b) narrow-read reconstruction — after a drop, re-materialized
//       blockContents/metadata deepEqual the pre-drop reference (disk is the
//       authority);
//   (c) per-session hard cap — BILI_SESSION_RESIDENT_HARD_MAX_BYTES still
//       fires under sustained activity (in-flight turns skip, boundaries drop,
//       warn throttled to 60 s), default equals the pool soft cap;
//   (d) index-only routing parity — an envelope-frozen session saves through
//       the SAME index-only branch as writerOff (no envelope churn), gets the
//       equivalent post-save drops, and reconstructs from unified rows.
// Invariants exercised here: #1 frozen routing byte-identical; #5 index-only
// paths get equivalent drops; #6 CompressionState untouched by any drop.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../src/persist.ts";
import {
    cacheBlockContent,
    getSession,
    isDroppedMetadata,
    LazyBlockContents,
    residentBreakdown,
    sessionWeight,
    snapshotMessages,
    type Session,
} from "../src/session.ts";
import { sessionResidentHardMaxBytes, sessionResidentMaxBytes } from "../src/knobs.ts";
import type { CoreMessage } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

// Hermetic baseline (mirrors memory-blockcontent-lazy.test.ts): no zstd, no
// developer config, legacy storage for tests (a)-(c). Test (d) switches one
// store to unified-full and restores this value in its finally.
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-bc-4788-hermetic-")),
    "no-config.json",
);
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_PERSIST_TAIL_TOKENS = "600";
// Tiny cap so the D1-A warn path triggers in milliseconds. The cap only
// gates the CALL-OUT (warn + forced discharge identity): safe drops already
// run at every landed-save boundary regardless (item B), which is what
// tests (a)-(d) assert behaviorally.
process.env.BILI_SESSION_RESIDENT_HARD_MAX_BYTES = "4096";

function rawTail(n: number): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (let i = 0; i < n; i++) {
        out.push({ id: `m${i}`, contentType: "text", role: i % 2 === 0 ? "user" : "assistant", text: `resident-probe message number ${i} with filler words to spend tokens` });
    }
    return out;
}

function seed(s: Session, blocks: number): void {
    for (let i = 1; i <= blocks; i++) {
        cacheBlockContent(s, `b${i}`, {
            one: null,
            full: { text: `ORIGINAL content of block b${i}\nline two of the original transcript`, count: 2 },
        });
    }
}

function makeHeavy(id: string, blocks: number): Session {
    const s = getSession(id, { protocol: "openai", label: id });
    seed(s, blocks);
    s.metadata.anchorNote = "reconciliation bookkeeping that dominates long sessions";
    s.metadata.foldAnchors = { first: "b1", last: `b${blocks}` };
    snapshotMessages(s, rawTail(50));
    // Production bumps revisionEpoch through markDirty on every mutation; do
    // the same here so sessionWeight's revision cache (single source of
    // truth with /__bili/memory) reflects the seeded state.
    s.revisionEpoch = (s.revisionEpoch ?? 0) + 1;
    return s;
}

/** One simulated request against a store: mutate (what markDirty would do),
 * arm the debounced save, wait for it to settle on the kernel chain. */
async function turn(store: SessionStore, s: Session, midFlight?: boolean): Promise<boolean> {
    if (midFlight) s.inFlight = 1;
    s.revisionEpoch = (s.revisionEpoch ?? 0) + 1;
    store.scheduleSave(s);
    // #4788: while a caller awaits afterNextFlush, persist.ts keeps the pending
    // debounce timer ref'd, so this settle is deterministic even in a node:test
    // child whose only surviving handles are unref'd sockets — no test-side
    // keep-alive needed here anymore.
    const landed = await store.afterNextFlush(s.id);
    if (midFlight) s.inFlight = 0;
    return landed;
}

function findEnvelope(dir: string, protocol: string): string | null {
    const protoDir = path.join(dir, protocol);
    let files: string[];
    try {
        files = readdirSync(protoDir).filter((f) => f.endsWith(".json"));
    } catch {
        return null;
    }
    return files.length > 0 ? path.join(protoDir, files[0]) : null;
}

test("(a) between-turns drop: every landed request-end boundary discharges droppable fields", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-bc-4788-a-"));
    const store = new SessionStore({ dir, debounceMs: 50, enabled: true });
    try {
        const s = makeHeavy("rt-a", 40);
        const beforeTotal = sessionWeight(s);
        assert.ok(beforeTotal > 8_000, `seeded session should be heavy, got ${beforeTotal}`);

        // Turn 1 ends: save settles, then the boundary spill runs.
        assert.equal(await turn(store, s), true, "debounced save must land with proof");
        await store.spillBetweenTurns(s);
        assert.ok(s.blockContents instanceof LazyBlockContents && (s.blockContents as LazyBlockContents).isDropped, "block contents folded to lazy shell");
        assert.ok(isDroppedMetadata(s.metadata), "metadata folded to lazy proxy");
        assert.equal(s.lastMessagesFolded, true, "raw tail folded to the bounded view");
        const afterA = residentBreakdown(s);
        assert.ok(afterA.blockContents < 200, `lazy shell ~0 bytes, got ${afterA.blockContents}`);
        assert.ok(afterA.metadata < 200, `dropped metadata proxy ~0 bytes, got ${afterA.metadata}`);
        assert.ok(sessionWeight(s) < beforeTotal - 4_000, `weight must measurably fall (${beforeTotal} -> ${sessionWeight(s)})`);
        // #6: CompressionState is non-droppable and never touched.
        assert.equal(afterA.state > 0, true, "state stays resident");

        // Turn 2: the same boundary works repeatedly (idempotent drops).
        assert.equal(await turn(store, s), true);
        await store.spillBetweenTurns(s);
        assert.ok((s.blockContents as LazyBlockContents).isDropped, "still folded after the second boundary");
        assert.ok(isDroppedMetadata(s.metadata));
    } finally {
        // #4739/#5140 family: the suite arms a real SessionStorage under
        // BILI_STORAGE_UNIFIED=full, so the sidecar handle is still open here.
        // cancelAll() clears timers and the build map but never closes the
        // shadow; Windows then refuses to unlink the directory (EBUSY/EPERM).
        // Close the short-lived store first: cancel, then close.
        store.closeQuietly();
        rmrf(dir);
    }
});

test("(b) narrow-read reconstruction deepEquals the pre-drop reference", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-bc-4788-b-"));
    const store = new SessionStore({ dir, debounceMs: 50, enabled: true });
    try {
        const s = makeHeavy("rt-b", 30);
        const refBlocks: Record<string, unknown> = {};
        for (const [k, v] of s.blockContents) refBlocks[k] = structuredClone(v);
        const refMeta: Record<string, unknown> = structuredClone({ ...s.metadata });

        assert.equal(await turn(store, s), true);
        await store.spillBetweenTurns(s);
        assert.ok((s.blockContents as LazyBlockContents).isDropped);

        // First touch re-materializes EVERY entry from disk…
        const rebuilt: Record<string, unknown> = {};
        for (const k of Object.keys(refBlocks)) rebuilt[k] = structuredClone(s.blockContents.get(k));
        assert.deepEqual(rebuilt, refBlocks, "block contents rebuilt identically from the narrow read");
        assert.equal((s.blockContents as LazyBlockContents).isDropped, false, "materialized for the rest of the burst");
        assert.equal(s.blockContents.size, Object.keys(refBlocks).length);

        // …and metadata re-materializes to the persisted shape.
        void Object.keys(s.metadata);
        assert.deepEqual({ ...s.metadata }, refMeta, "metadata rebuilt identically from the narrow read");

        // A later save persists the SAME full set again (no thinned erase).
        await turn(store, s);
        const parsed = JSON.parse(readFileSync(findEnvelope(dir, "openai")!, "utf8")) as { payload?: Record<string, unknown> };
        const rec = (parsed.payload ?? parsed) as Record<string, unknown>;
        assert.equal(Object.keys((rec.blockContents ?? {}) as object).length, Object.keys(refBlocks).length, "full set round-trips through the envelope");
    } finally {
        store.closeQuietly();
        rmrf(dir);
    }
});

test("(c) hard cap under sustained activity: boundaries drop, in-flight skips, warn throttled", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-bc-4788-c-"));
    const lines: string[] = [];
    const store = new SessionStore({ dir, debounceMs: 50, enabled: true, log: (_l, m) => lines.push(m) });
    try {
        const s = makeHeavy("rt-c", 40);
        assert.ok(sessionWeight(s) > Number(process.env.BILI_SESSION_RESIDENT_HARD_MAX_BYTES), "session must exceed the (tiny) cap");

        // Three consecutive busy turns: mid-flight the spill must NOT run…
        for (let t = 1; t <= 3; t++) {
            assert.equal(await turn(store, s, true), true, `turn ${t} save lands`);
            // Mid-response (still streaming): the spill must decline.
            s.inFlight = 1;
            await store.spillBetweenTurns(s);
            s.inFlight = 0;
            await store.spillBetweenTurns(s);
            assert.ok(s.blockContents instanceof LazyBlockContents && (s.blockContents as LazyBlockContents).isDropped, `boundary ${t}: dropped despite sustained activity`);
            assert.ok(isDroppedMetadata(s.metadata), `boundary ${t}: metadata dropped too`);
            snapshotMessages(s, rawTail(50 + t * 5)); // next turn's fresh tail
        }
        // The cap call-out fired exactly once (60 s throttle covers the loop).
        const warns = lines.filter((l) => l.includes("exceeds the per-session hard cap"));
        assert.equal(warns.length, 1, `expected one throttled cap warning, got ${warns.length}: ${lines.join(" | ")}`);

        // Default without env: the hard cap falls back to the pool soft cap.
        const saved = process.env.BILI_SESSION_RESIDENT_HARD_MAX_BYTES;
        delete process.env.BILI_SESSION_RESIDENT_HARD_MAX_BYTES;
        try {
            assert.equal(sessionResidentHardMaxBytes(), sessionResidentMaxBytes(), "default = pool soft cap");
            assert.equal(sessionResidentHardMaxBytes(), 536_870_912);
        } finally {
            process.env.BILI_SESSION_RESIDENT_HARD_MAX_BYTES = saved;
        }
    } finally {
        store.closeQuietly();
        rmrf(dir);
    }
});

test("(d) envelope-frozen routing is unchanged AND gets equivalent drops", async () => {
    process.env.BILI_STORAGE_UNIFIED = "full";
    const dir = mkdtempSync(path.join(tmpdir(), "bili-bc-4788-d-"));
    const store = new SessionStore({ dir, debounceMs: 50, enabled: true });
    try {
        const s = makeHeavy("frz-d", 20);
        s.revisionEpoch = (s.revisionEpoch ?? 0) + 1;
        await store.writeNow(s); // normal routing: envelope + unified rows
        const envPath = findEnvelope(dir, "openai");
        const bytesBefore = envPath ? readFileSync(envPath) : null;

        // Escalate structural drift past the warn threshold: freeze THIS
        // session's envelope writes (#4323 state lives in frozenEnvelopeIds;
        // persist.ts consults UnifiedShadow.envelopeFrozen on every save route).
        const shadow = (store as unknown as { shadow?: { frozenEnvelopeIds?: Set<string>; envelopeFrozen?: (id: string) => boolean } }).shadow;
        assert.ok(shadow?.frozenEnvelopeIds, "unified-full store must expose the shadow for deterministic freeze");
        shadow!.frozenEnvelopeIds!.add(s.id);
        assert.equal(shadow.envelopeFrozen?.(s.id), true, "freeze armed");

        // Frozen save: index-only branch (no debounce — the pre-PR path),
        // now with the equivalent settle protocol + drops.
        cacheBlockContent(s, "bx", { one: null, full: { text: "frozen-era content bx", count: 1 } });
        s.revisionEpoch = (s.revisionEpoch ?? 0) + 1;
        await store.writeNow(s); // frozen: index-only SYNCHRONOUS branch

        if (envPath && bytesBefore) {
            assert.deepEqual(readFileSync(envPath), bytesBefore, "frozen session: envelope bytes must not churn (#394)");
        } else {
            assert.equal(envPath, null, "full mode without envelope: nothing to churn");
        }
        // Invariant #5: the index-only route performs the same discharge.
        assert.ok(s.blockContents instanceof LazyBlockContents && (s.blockContents as LazyBlockContents).isDropped, "index-only save discharges like the kernel-write save");
        assert.ok(isDroppedMetadata(s.metadata));
        // Rebuilt from the UNIFIED rows (the envelope predates block bx).
        assert.equal((s.blockContents.get("bx")?.full.text as string | undefined)?.includes("frozen-era content bx"), true, "narrow read serves the freshest copy from the index");
        assert.equal(s.blockContents.size, 21, "all entries resident again after reconstruction");
    } finally {
        process.env.BILI_STORAGE_UNIFIED = "legacy";
        store.closeQuietly();
        rmrf(dir);
    }
});
