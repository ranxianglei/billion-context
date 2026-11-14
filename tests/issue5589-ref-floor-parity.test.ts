/**
 * #5589: the synthetic ref-floor pin must not break unified shadow parity.
 *
 * After a Responses/codex native-compaction rebase (#2592/F5), byRaw carries
 * the synthetic key "bili:ref-floor" → mNNNNN with NO byRef counterpart
 * (documented invariant — the floor only exists to hold the kernel cursor
 * high). The refs ledger persists EVERY byRaw entry, and the replay leg used
 * to invert every non-BLOCKED row into byRef — including the floor row —
 * minting a phantom mNNNNN→"bili:ref-floor" entry the live map never has.
 * Post-#4685 key-sorting removed the order false positive, so this content
 * difference was the last divergent dimension left: DIGEST DRIFT [diverged:
 * state; state: messageRefs] on every sampled verify of any session that ever
 * pinned a floor, watermark drop + full-tail re-ingest each time, escalating
 * to envelope freeze after three samples — permanently, because the floor
 * never leaves byRaw. Field evidence: v0.1.212, Codex Desktop app-server
 * 0.166.0, long-running conversation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { loadLegacyView, planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { REF_FLOOR_RAW_ID } from "../src/state-hydration.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ref-floor-hermetic-"));
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

// A session right after a native-compaction rebase: one live message plus the
// floor pinning the pre-compaction high-water mark (byRaw-only, no byRef).
const FLOOR_PINNED_STATE: StateShape = {
    blocks: [],
    messageRefs: {
        byRaw: { "raw-a": "m00001", [REF_FLOOR_RAW_ID]: "m00042" },
        byRef: { m00001: "raw-a" },
    },
    nextBlockId: 1,
    nextRunId: 1,
};

test("#5589: a floor-pinned session must not trip the parity digest", () => {
    const dir = tmpdir("bili-5589-floor-");
    try {
        const shadow = openShadow(dir);
        shadow.record(mkLegacy("floor-pin", FLOOR_PINNED_STATE));
        const s = stats(shadow);
        assert.equal(s.verifySamples, 1, "first save must run the sampled verify");
        assert.equal(s.verifyDrift, 0, "the synthetic floor row must not manufacture a byRef entry (pre-fix: 1)");
        assert.equal(s.verifyOk, 1, "the sampled verify must pass");
    } finally {
        rmBestEffort(dir);
    }
});

test("#5589: the replay leg keeps the floor in byRaw without minting a byRef entry", () => {
    const replayed = loadLegacyView(planIngest(mkLegacy("floor-shape", FLOOR_PINNED_STATE)) as never);
    // Unchecked cast: loadLegacyView types state as Record<string, unknown>
    // (the view is store-shaped, not kernel-typed); this fixture owns it.
    const replayedState = replayed.state as unknown as StateShape;
    assert.equal(replayedState.messageRefs.byRaw[REF_FLOOR_RAW_ID], "m00042", "the cursor pin must survive the round-trip (full-mode boot relies on it)");
    assert.equal(replayedState.messageRefs.byRef["m00042"], undefined, "no phantom mNNNNN→floor entry may be minted");
    assert.deepEqual(replayedState.messageRefs.byRef, { m00001: "raw-a" });
});

test("#5589: a genuine divergence around the floor number still drifts", () => {
    const dir = tmpdir("bili-5589-content-");
    try {
        const shadow = openShadow(dir);
        // Live leg claims m00042 → raw-c while byRaw pins the floor at the same
        // number: the rows rebuild byRef without raw-c's claim, so a real fork
        // around the floor number must STILL be reported (the #4323 heal path
        // depends on this direction).
        shadow.record(mkLegacy("floor-content", {
            blocks: [],
            messageRefs: {
                byRaw: { "raw-a": "m00001", [REF_FLOOR_RAW_ID]: "m00042" },
                byRef: { m00001: "raw-a", m00042: "raw-c" },
            },
            nextBlockId: 1,
            nextRunId: 1,
        }));
        const s = stats(shadow);
        assert.equal(s.verifySamples, 1, "first save must run the sampled verify");
        assert.equal(s.verifyDrift, 1, "a divergent ref mapping around the floor number must still be reported");
    } finally {
        rmBestEffort(dir);
    }
});
