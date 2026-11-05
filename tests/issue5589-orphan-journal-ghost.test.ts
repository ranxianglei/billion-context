/**
 * #5589 (facet C): an authoritative blockContents clear must not leave stale
 * orphan-journal ghosts that latch permanent DIGEST DRIFT.
 *
 * The orphan journal (#4216/#4242) rides every save so reaped block contents
 * stay decompress-resolvable. The store-side merge kept existing journal
 * entries the incoming plan no longer carried — sound while the live map can
 * re-materialize them, but after a native-compaction REBASE
 * (resetSessionCompression, #2592/F5) the live map is authoritatively CLEARED
 * and can never carry them again. The ghosts then fail the verifier's
 * orphan-vs-live comparison on every sampled verify ([diverged:
 * blockContents]), escalate after three samples, and freeze the JSON envelope
 * forever — nothing in the save path can ever clear the journal again. Field
 * evidence: v0.1.212, Codex Desktop (BILI_CODEX_COMPACT=intercept), session S6
 * — 4× blockContents,state drifts, escalation, 0× "drift resolved".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-orphan-ghost-hermetic-"));
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

const T_CREATED = 1_700_000_000_000;
const T_SEEN = 1_700_000_000_500;

type OrphanMap = Map<string, { one: null; full: { text: string; count: number } }>;

function mkLegacy(id: string, blockContents: OrphanMap): LegacySessionLike {
    return {
        id,
        createdAt: T_CREATED,
        lastSeen: T_SEEN,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, nextBlockId: 1, nextRunId: 1 } as unknown as LegacySessionLike["state"],
        blockContents: blockContents as unknown as LegacySessionLike["blockContents"],
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

function reapShape(): OrphanMap {
    return new Map([["blk-1", { one: null, full: { text: "T1", count: 2 } }]]);
}

test("#5589-C: an authoritative clear must not latch a ghost-journal drift", () => {
    const dir = tmpdir("bili-5589-ghost-");
    try {
        const shadow = openShadow(dir);
        // Generation 1: the reap shape — block gone from state.blocks, content
        // retained; the journal covers it, so the first sampled verify is clean.
        shadow.record(mkLegacy("ghost", reapShape()));
        let s = stats(shadow);
        assert.equal(s.verifySamples, 1, "first save must run the sampled verify");
        assert.equal(s.verifyDrift, 0, "reap shape with journal coverage must be clean (#4216/#4242)");
        // Generation 2: a native-compaction rebase cleared blockContents. The
        // 21st save carries the second sampled verify.
        for (let i = 0; i < 20; i++) shadow.record(mkLegacy("ghost", new Map()));
        s = stats(shadow);
        assert.equal(s.verifySamples, 2, "the 21st save must run the second sampled verify");
        assert.equal(s.verifyDrift, 0, "an authoritative clear must reset the journal, not leave ghosts behind (pre-fix: 1)");
    } finally {
        rmBestEffort(dir);
    }
});

test("#5589-C: persisted orphan contents stay covered across saves", () => {
    const dir = tmpdir("bili-5589-ghost-keep-");
    try {
        const shadow = openShadow(dir);
        // No clear: the orphan content stays in the live map across saves, so
        // every plan carries it and the journal must keep covering it.
        for (let i = 0; i < 21; i++) shadow.record(mkLegacy("ghost-keep", reapShape()));
        const s = stats(shadow);
        assert.equal(s.verifySamples, 2, "both sampled verifies must run");
        assert.equal(s.verifyDrift, 0, "replacement semantics must not drop entries the live side still carries");
    } finally {
        rmBestEffort(dir);
    }
});
