/**
 * #4392: "[diverged: state]" digest drift on a SINGLE instance — canonicalize
 * must digest object key SETS, not insertion order.
 *
 * The two shadow verify legs build the same values in different orders. Field
 * evidence (v0.1.206, one proxy process): the expect leg loads the envelope
 * through buildSession → mergeState, whose `messageRefs` is taken off the
 * persisted state verbatim, while the got leg rebuilds `messageRefs.byRef` from
 * the refs ledger row order (`loadLegacyView`). The kernel mints refs in a
 * different order than the byRaw keys the ledger is written in, so byRef came
 * back reordered with identical contents — `shadowDigest` hashed the order and
 * reported drift against itself, escalating to "MULTIPLE bili instances"
 * (#4323) after three samples and freezing envelope writes.
 *
 * Post-fix `canonicalize` sorts object keys at every depth (Maps/Sets keep
 * their current canonical form, arrays keep their order), so only a genuine
 * value/set difference trips the digest. Both directions are asserted: the
 * reordered-but-equal case stays green, a real content difference still drifts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { loadLegacyView, planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { canonicalize, DIGEST_SKIPPED_KEYS, sha256 } from "../src/storage/canonical.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-canonical-order-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true });
    } catch {
        // best effort: a locked sqlite file must not fail the assertion path
    }
}

function msg(i: number): CoreMessage {
    return { id: `h_msg${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `hello ${i}` } as CoreMessage;
}

// Above canonicalize's > 2020-09-01 mask threshold so createdAt / lastSeen
// collapse to __TS__ on BOTH digest legs.
const T_CREATED = 1_700_000_000_000;
const T_SEEN = 1_700_000_000_500;

interface StateShape {
    blocks: unknown[];
    messageRefs: { byRaw: Record<string, string>; byRef: Record<string, string> };
    nextBlockId: number;
    nextRunId: number;
}

function mkLegacy(id: string, state: StateShape): LegacySessionLike {
    return {
        id,
        createdAt: T_CREATED,
        lastSeen: T_SEEN,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        state: state as unknown as LegacySessionLike["state"],
        blockContents: new Map(),
        lastMessages: [msg(0), msg(1)],
        lastMessagesFolded: false,
    };
}

interface StatsView {
    ingests: number;
    deltaIngests: number;
    verifySamples: number;
    verifyOk: number;
    verifyDrift: number;
}

function openShadow(dir: string): UnifiedShadow {
    UnifiedStore.open(path.join(dir, "index.db"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
    assert.ok(shadow, "shadow mode sidecar must open");
    return shadow;
}

function stats(shadow: UnifiedShadow): StatsView {
    return (shadow as unknown as { stats: StatsView }).stats;
}

// --- Unit: canonicalize is order-insensitive for objects, order-preserving for arrays ---

test("#4392: canonicalize digests object key sets, not insertion order", () => {
    assert.equal(
        JSON.stringify(canonicalize({ state: { messageRefs: { byRef: { m00002: "b", m00001: "a" } } }, stats: { requests: 1 } })),
        JSON.stringify(canonicalize({ stats: { requests: 1 }, state: { messageRefs: { byRef: { m00001: "a", m00002: "b" } } } })),
        "the same key set in a different order must digest identically",
    );
    assert.equal(sha256(JSON.stringify(canonicalize({ b: 1, a: 2 }))), sha256(JSON.stringify(canonicalize({ a: 2, b: 1 }))));
    assert.notEqual(sha256(JSON.stringify(canonicalize({ a: 1 }))), sha256(JSON.stringify(canonicalize({ a: 2 }))), "values still matter");
    assert.notEqual(sha256(JSON.stringify(canonicalize({ a: 1 }))), sha256(JSON.stringify(canonicalize({ a: 1, b: 2 }))), "the key SET still matters");
});

test("#4392: arrays keep their order; Maps/Sets keep their canonical envelope", () => {
    assert.notEqual(
        sha256(JSON.stringify(canonicalize([{ id: "b1" }, { id: "b2" }]))),
        sha256(JSON.stringify(canonicalize([{ id: "b2" }, { id: "b1" }]))),
        "array order is content — blocks/tail order must still trip the digest",
    );
    assert.notEqual(
        sha256(JSON.stringify(canonicalize(new Set(["a", "b"])))),
        sha256(JSON.stringify(canonicalize(new Set(["b", "a"])))),
        "Set insertion order stays part of the canonical form (nothing changed there)",
    );
    assert.equal(
        JSON.stringify(canonicalize(new Map([["b", 1]]))),
        JSON.stringify({ __map__: [["b", 1]] }),
        "Map envelope shape unchanged",
    );
});

// --- Unit: the skip table is ONE contract, not a per-producer list ---

test("#4392: DIGEST_SKIPPED_KEYS is the single skip contract every digest path shares", () => {
    // Pinned literally: dropping a key changes every golden pin, so it must be
    // a conscious re-pin. The streamed `canonicalDigest` (#4532) imports THIS
    // table instead of hand-copying a list — two hand-maintained skip lists are
    // how the golden corpus and the shadow parity check end up hashing two
    // different canonical forms of the same session.
    assert.deepEqual(Object.keys(DIGEST_SKIPPED_KEYS).sort(), ["storageMode", "tailGaps"]);
    assert.equal(
        JSON.stringify(canonicalize({
            state: { tailGaps: { m00002: 1 }, keep: "x" },
            metadata: { storageMode: "full", biliVersion: "0.1.208" },
            stats: { requests: 3 },
        })),
        JSON.stringify({ metadata: { biliVersion: "__VER__" }, state: { keep: "x" }, stats: { requests: 3 } }),
        "skipped keys are dropped at every depth; biliVersion is masked, never dropped",
    );
});

// --- E2E: the field shape — byRef rebuilt in ledger order, same contents ---

test("#4392: byRef reordered by the ref-ledger rebuild must not trip the parity digest", () => {
    const dir = tmpdir("bili-4392-order-");
    try {
        // The kernel minted m00001 before m00002, but byRaw's insertion order
        // (what the refs ledger is written in) starts at raw-a — so the replay
        // leg rebuilds byRef { m00001, m00002 } while the live view holds
        // { m00002, m00001 }: identical key set, identical values.
        const liveState: StateShape = {
            blocks: [],
            messageRefs: {
                byRaw: { "raw-a": "m00001", "raw-b": "m00002" },
                byRef: { m00002: "raw-b", m00001: "raw-a" },
            },
            nextBlockId: 1,
            nextRunId: 1,
        };
        const legacy = mkLegacy("state-order", liveState);
        const replayed = loadLegacyView(planIngest(legacy) as never);
        // Unchecked cast: loadLegacyView types state as Record<string, unknown>
        // (the view is store-shaped, not kernel-typed); this fixture owns it.
        const replayedState = replayed.state as unknown as StateShape;
        const liveRefs = liveState.messageRefs.byRef;
        const replayRefs = replayedState.messageRefs.byRef;
        assert.deepEqual(Object.keys(liveRefs), ["m00002", "m00001"], "live leg holds byRef in kernel-mint order");
        assert.deepEqual(Object.keys(replayRefs), ["m00001", "m00002"], "replay leg holds byRef in ledger order");
        assert.deepEqual({ ...liveRefs }, { ...replayRefs }, "…with identical contents");

        const shadow = openShadow(dir);
        shadow.record(legacy);
        const s = stats(shadow);
        assert.equal(s.verifySamples, 1, "first save must run the sampled verify");
        assert.equal(s.verifyDrift, 0, "an order-only difference must not drift (pre-fix: 1)");
        assert.equal(s.verifyOk, 1, "the sampled verify must pass");
    } finally {
        rmBestEffort(dir);
    }
});

test("#4392: a real messageRefs content difference still drifts", () => {
    const dir = tmpdir("bili-4392-content-");
    try {
        const shadow = openShadow(dir);
        // Same key set and order, one different mapping: the digest must still
        // catch a genuine fork between the two legs (the #4323 heal path is
        // what depends on this direction).
        const legacy = mkLegacy("state-content", {
            blocks: [],
            messageRefs: {
                byRaw: { "raw-a": "m00001", "raw-b": "m00002" },
                byRef: { m00001: "raw-a", m00002: "raw-c" },
            },
            nextBlockId: 1,
            nextRunId: 1,
        });
        shadow.record(legacy);
        const s = stats(shadow);
        assert.equal(s.verifySamples, 1, "first save must run the sampled verify");
        assert.equal(s.verifyDrift, 1, "a divergent ref mapping must still be reported");
    } finally {
        rmBestEffort(dir);
    }
});
