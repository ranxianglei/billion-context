/**
 * #4323: structural digest drift must escalate to a loud alarm plus an
 * envelope-write freeze, and a drift-latched cold load must take the side
 * with the fuller fold coverage.
 *
 * Measured incident: several bili instances sharing one sessions dir (#394
 * anti-pattern) ping-ponged the JSON envelope and the SQLite index into
 * permanent divergence; every restart/eviction cold load hit the drift latch
 * and served the STALE envelope (12 active blocks where the index held 16) —
 * putting ~240K already-folded tokens back into context. Two gaps pinned here:
 *
 *   A. the sampler logged each non-converging sample but never escalated: N
 *      consecutive structural drifts looked like one-off external churn. Now
 *      DRIFT_ESCALATE_STREAK samples fire ONE loud WARN naming both sides'
 *      fold counts and freeze THIS process's JSON envelope writes for the
 *      session (persist.ts routes its saves index-only); a clean sample
 *      re-admits and resumes file writes.
 *   B. the latch served the legacy envelope unconditionally ("last file write
 *      is fresher" — false under multi-writer ping-pong). Now the unified
 *      view wins when it strictly carries MORE active blocks; a tie or an
 *      unreadable other side keeps the historical envelope preference (the
 *      negative gate is pinned too: unlatched loads stay unified-first).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import { setLogCapture } from "../src/logger.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetStorageRuntimeStatusForTest, storageStatusWire } from "../src/storage/runtime-status.ts";
import type { Session } from "../src/session.ts";
import type { CompressionBlock, CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: a developer machine with
// storage.unified in its real config must not leak a tier into these tests.
const HERMETIC = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4323-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC, "no-config.json");
delete process.env.BILI_STORAGE_UNIFIED;

const PREV_UNIFIED = process.env.BILI_STORAGE_UNIFIED;

type Captured = { level: string; msg: string };

function captureLogs(): { captured: Captured[]; stop: () => void } {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    return { captured, stop: () => setLogCapture(null) };
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

function tmpDir(tag: string): string {
    return fs.mkdtempSync(path.join(HERMETIC, `${tag}-`));
}

function settle(ms = 300): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// A. Escalation + freeze at the shadow level (harness replicated from #3919)
// ---------------------------------------------------------------------------

function msg(i: number, text = `hello ${i}`): CoreMessage {
    return { id: `h_msg${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text } as CoreMessage;
}

function mkLegacy(id: string, lastMessages: LegacySessionLike["lastMessages"]): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: false,
    };
}

interface StatsView {
    verifyOk: number;
    verifyDrift: number;
}

function stats(shadow: UnifiedShadow): StatsView {
    return (shadow as unknown as { stats: StatsView }).stats;
}

function openShadow(dir: string): { shadow: UnifiedShadow; store: UnifiedStore } {
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
    assert.ok(shadow, "shadow mode sidecar must open");
    return { shadow, store };
}

/** Swap the CAS bytes under a session's first message row — the tamper shape
 *  that only the sampled read-back can catch (replicated from #3919). */
function tamperFirstRowBytes(dir: string, sessionId: string): string {
    const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
    try {
        const row = conn.prepare("SELECT content_hash FROM messages WHERE session_id = ? ORDER BY seq LIMIT 1").get(sessionId) as { content_hash: string } | undefined;
        assert.ok(row, "row to tamper must exist");
        conn
            .prepare("UPDATE content SET bytes = ? WHERE hash = ?")
            .run(Buffer.from(JSON.stringify({ id: "tampered", role: "user", contentType: "text", text: "tampered" }), "utf8"), row.content_hash);
        return row.content_hash;
    } finally {
        conn.close();
    }
}

test("#4323 A: three consecutive sampled drifts escalate once and freeze envelope writes; a clean sample re-admits", () => {
    const dir = tmpDir("escalate");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const ids = "drift-esc";
            let k = 5;
            shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, i) => msg(i))));
            const hash = tamperFirstRowBytes(dir, ids);

            const { captured, stop } = captureLogs();
            try {
                // Sample n=21: first drift — not yet structural.
                for (let i = 0; i < 20; i++) {
                    k += 1;
                    shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, j) => msg(j))));
                }
                assert.equal(stats(shadow).verifyDrift, 1);
                assert.equal(shadow.envelopeFrozen(ids), false, "one drift sample must not freeze");

                // Sample n=41 over the SAME unhealed tamper: still below threshold.
                for (let i = 0; i < 20; i++) {
                    k += 1;
                    shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, j) => msg(j))));
                }
                assert.equal(stats(shadow).verifyDrift, 2);
                assert.equal(shadow.envelopeFrozen(ids), false, "two drift samples must not freeze yet");

                // Sample n=61: third consecutive — structural, escalate + freeze.
                for (let i = 0; i < 20; i++) {
                    k += 1;
                    shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, j) => msg(j))));
                }
                assert.equal(stats(shadow).verifyDrift, 3);
                assert.equal(shadow.envelopeFrozen(ids), true, "three consecutive sampled drifts freeze the envelope");

                // Repair the CAS bytes, then sample n=81: clean re-admission.
                const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
                try {
                    conn.prepare("UPDATE content SET bytes = ? WHERE hash = ?").run(Buffer.from(JSON.stringify(msg(0)), "utf8"), hash);
                } finally {
                    conn.close();
                }
                for (let i = 0; i < 20; i++) {
                    k += 1;
                    shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, j) => msg(j))));
                }
                assert.equal(stats(shadow).verifyDrift, 3, "no further drift after the repair");
                assert.equal(stats(shadow).verifyOk, 2, "pre-tamper sample plus the post-repair sample pass");
                assert.equal(shadow.envelopeFrozen(ids), false, "a clean sample re-admits and unfreezes");
            } finally {
                stop();
            }

            const escalated = captured.filter((e) => e.level === "warn" && e.msg.includes(`DIGEST DRIFT ESCALATED for ${ids}`));
            assert.equal(escalated.length, 1, "exactly ONE escalation alarm for the whole streak");
            assert.ok(escalated[0].msg.includes("active block(s) vs index"), `alarm names both sides' fold counts: ${escalated[0].msg}`);
            assert.ok(escalated[0].msg.includes("#394"), "alarm names the multi-writer anti-pattern");
            // #4614: the alarm must name BOTH known producers — a single host re-writing
            // slots below the watermark on every save produces the identical signature.
            assert.ok(escalated[0].msg.includes("#4614"), "alarm also names the single-writer repeating-rewrite producer");
            const resolved = captured.filter((e) => e.level === "info" && e.msg.includes(`drift resolved for ${ids}`));
            assert.equal(resolved.length, 1, "re-admission is logged");
            const driftErrors = captured.filter((e) => e.level === "error" && e.msg.startsWith(`[storage] unified shadow DIGEST DRIFT for ${ids}:`));
            assert.equal(driftErrors.length, 3, "each non-converging sample still logs its error line");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

// ---------------------------------------------------------------------------
// B. Drift-latched cold load takes the fuller fold coverage (full mode)
// ---------------------------------------------------------------------------

type ShadowLike = {
    record(r: unknown): void;
    stats: { verifyDrift: number };
    driftedSessions?: Set<string>;
    frozenEnvelopeIds?: Set<string>;
};

function makeBlock(blockId: string): CompressionBlock {
    return {
        blockId,
        runId: "r0",
        tier: 1,
        summary: "",
        directMessageIds: [],
        effectiveMessageIds: [],
        directBlockIds: [],
        compressedTokens: 0,
        createdAt: Date.now(),
        survivedCount: 0,
        generation: "young",
        active: true,
    };
}

function makeSession(id: string, requests: number, blocks: CompressionBlock[]): Session {
    return {
        id,
        createdAt: Date.now(),
        meta: {},
        metadata: {},
        stats: { requests },
        state: { blocks, messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {}, nextBlockId: blocks.length + 1 },
        blockContents: new Map(),
        lastMessages: [],
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    } as unknown as Session;
}

interface FullCase {
    tag: string;
    latch: boolean;
    genA: { requests: number; blocks: CompressionBlock[] };
    genB: { requests: number; blocks: CompressionBlock[] };
}

async function runLatchedLoad(c: FullCase): Promise<{ reloaded: Session | null; captured: Captured[] }> {
    _resetStorageRuntimeStatusForTest();
    process.env.BILI_STORAGE_UNIFIED = "full";
    const dir = tmpDir(c.tag);
    try {
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const { captured, stop } = captureLogs();
        try {
            const id = `${c.tag}-session`;
            const genA = makeSession(id, c.genA.requests, c.genA.blocks);
            store.scheduleSave(genA);
            await settle();

            const sh = (store as unknown as { shadow?: ShadowLike }).shadow;
            assert.ok(sh, "full mode opens a sidecar");
            if (!sh.driftedSessions) sh.driftedSessions = new Set();
            if (!sh.frozenEnvelopeIds) sh.frozenEnvelopeIds = new Set();
            if (c.latch) sh.driftedSessions.add(id);

            // Commit ONLY the envelope to generation B (stub the sidecar ingest
            // for one save — same recipe as storage-full-flip #3818 ④): the
            // index now holds genA, the file holds genB.
            const realRecord = sh.record.bind(sh);
            sh.record = () => {};
            const genB = makeSession(id, c.genB.requests, c.genB.blocks);
            assert.ok(store.flushSync(genB), "gen-B envelope committed");
            sh.record = realRecord;

            const reloaded = store.loadSync(id);
            stop();
            store.closeQuietly();
            return { reloaded, captured };
        } finally {
            stop();
            rmBestEffort(dir);
        }
    } finally {
        delete process.env.BILI_STORAGE_UNIFIED;
    }
}

test("#4323 B1: latched load serves the INDEX when it strictly has more active blocks", async () => {
    const { reloaded, captured } = await runLatchedLoad({
        tag: "idx-rich", latch: true,
        genA: { requests: 5, blocks: [makeBlock("bA1"), makeBlock("bA2")] },
        genB: { requests: 99, blocks: [] },
    });
    assert.ok(reloaded, "session loads");
    assert.equal((reloaded.state.blocks as CompressionBlock[]).length, 2, "the fuller (index) fold coverage wins");
    assert.equal((reloaded.stats as { requests?: number }).requests, 5, "served the index generation, not the newer-but-thinner envelope");
    const warn = captured.find((e) => e.level === "warn" && e.msg.includes("despite the drift latch"));
    assert.ok(warn, "source switch is logged loudly");
    assert.ok(warn?.msg.includes("legacy envelope holds 0 active block(s), the index holds 2"), `counts named in the log: ${warn?.msg}`);
});

test("#4323 B2: latched load KEEPS the envelope when it has the fuller coverage (historical preference)", async () => {
    const { reloaded, captured } = await runLatchedLoad({
        tag: "env-rich", latch: true,
        genA: { requests: 5, blocks: [] },
        genB: { requests: 99, blocks: [makeBlock("bB1"), makeBlock("bB2")] },
    });
    assert.ok(reloaded, "session loads");
    assert.equal((reloaded.state.blocks as CompressionBlock[]).length, 2, "envelope keeps the richer fold coverage");
    assert.equal((reloaded.stats as { requests?: number }).requests, 99, "served the envelope generation");
    assert.ok(!captured.some((e) => e.msg.includes("despite the drift latch")), "no source-switch alarm when the envelope stays authoritative");
    assert.ok(captured.some((e) => e.msg.includes("serving") && e.msg.includes("legacy envelope: last sampled digest drifted")), "historical fallback line intact");
});

test("#4323 B3: latched load with EQUAL active blocks keeps the historical envelope preference", async () => {
    const { reloaded } = await runLatchedLoad({
        tag: "tie", latch: true,
        genA: { requests: 5, blocks: [makeBlock("bTA")] },
        genB: { requests: 99, blocks: [makeBlock("bTB")] },
    });
    assert.ok(reloaded, "session loads");
    assert.equal((reloaded.stats as { requests?: number }).requests, 99, "tie goes to the envelope (unchanged behavior)");
    assert.deepEqual((reloaded.state.blocks as CompressionBlock[]).map((b) => b.blockId), ["bTB"], "envelope block served");
});

test("#4323 B4 negative gate: WITHOUT the latch an equal-progress load stays unified-first", async () => {
    // #4216/#4370 narrowed the gate: a strictly-ahead envelope now recovers
    // defensively without any latch (progress-gated, tests/storage-orphan-recovery.test.ts);
    // the negative direction kept here is that fold RICHNESS (more active
    // blocks, same progress) never displaces the index on its own.
    const { reloaded, captured } = await runLatchedLoad({
        tag: "no-latch", latch: false,
        genA: { requests: 5, blocks: [] },
        genB: { requests: 5, blocks: [makeBlock("bN1"), makeBlock("bN2")] },
    });
    assert.ok(reloaded, "session loads");
    assert.equal((reloaded.stats as { requests?: number }).requests, 5, "unlatched equal-progress loads serve the index (unified-first default)");
    assert.ok(!captured.some((e) => e.msg.includes("despite the drift latch")), "selection logic must not fire outside the latch");
    assert.ok(!captured.some((e) => e.msg.includes("last sampled digest drifted")), "no drift-fallback line outside the latch");
});

// ---------------------------------------------------------------------------
// C. The freeze is observable on the status wire
// ---------------------------------------------------------------------------

test("#4323 C: frozenEnvelopeSessions rides the /__bili/status wire", async () => {
    _resetStorageRuntimeStatusForTest();
    process.env.BILI_STORAGE_UNIFIED = "full";
    const dir = tmpDir("wire");
    try {
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const sh = (store as unknown as { shadow?: ShadowLike }).shadow;
        assert.ok(sh, "full mode opens a sidecar");
        if (!sh.frozenEnvelopeIds) sh.frozenEnvelopeIds = new Set();
        assert.equal(storageStatusWire().frozenEnvelopeSessions, 0, "no freezes on a fresh store");
        sh.frozenEnvelopeIds.add("wire-session");
        assert.equal(storageStatusWire().frozenEnvelopeSessions, 1, "an escalated session is visible on the wire");
        sh.frozenEnvelopeIds.delete("wire-session");
        assert.equal(storageStatusWire().frozenEnvelopeSessions, 0, "re-admission clears the counter");
        store.closeQuietly();
        rmBestEffort(dir);
    } finally {
        delete process.env.BILI_STORAGE_UNIFIED;
        _setStoreForTest(new SessionStore({ enabled: false, dir: tmpDir("wire-out") }));
    }
});

test.after(() => {
    if (PREV_UNIFIED === undefined) delete process.env.BILI_STORAGE_UNIFIED;
    else process.env.BILI_STORAGE_UNIFIED = PREV_UNIFIED;
    rmBestEffort(HERMETIC);
});
