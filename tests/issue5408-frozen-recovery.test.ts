/**
 * #5408: compression permanently fails for a session — frozen ingest watermark,
 * requests no longer observed, and no warning until the host dies with
 * CONTEXT_WINDOW_EXCEEDED ~8h later (DSH native lane, v0.1.209).
 *
 * Two stacked failures, two layers of gaps pinned here:
 *
 *   A. VISIBILITY. The #4323 freeze (drift escalation → envelope writes frozen,
 *      ingest watermark dropped to NULL) was invisible past the log line: the
 *      skip-save routes were silent, the status wire carried only a count with
 *      no ids/age, and "diverged: state" named no sub-field. Now the freeze
 *      stamps an age (envelopeFrozenInfo/frozenEnvelopeDetails), each skip-save
 *      route logs ONE rate-limited error, the status wire carries the details,
 *      and the diagnosis drills into state sub-keys ("diverged: state" alone is
 *      unactionable — every full re-ingest converges the tables it owns).
 *
 *   B1. CONVERGENCE. While drift-latched the full re-ingest ran WITHOUT the
 *      authoritative-set sweep (completeLog was tied to raw-tail presence), so
 *      a folded-resident save — no raw tail — could never clear foreign rows
 *      from the index; the incident's 17 consecutive drifts never converged.
 *      Now a latched session ingests with completeLog=true even without a raw
 *      tail (the envelope is what loadSync serves under the latch, so the
 *      index must converge to it). Negative gate: unlatched folded saves still
 *      leave foreign rows untouched.
 *
 *   C. OBSERVATION. After the host restart + rotation the cold load served the
 *      frozen state 43 times but ZERO model requests were ever observed for
 *      the session (fetch chain detached, #1158/#1662 family) — silence was
 *      indistinguishable from idle. Now a cold load whose savedAt is still hot
 *      arms a short silence timer; if no request for the session reaches the
 *      proxy before it fires, ONE error names the likely causes. Observability
 *      only — routing and folding are untouched.
 *
 *   D. STALE VIEWS. A cold load whose view predates unseen turns by hours now
 *      warns when the session had compressions (the incident's 123K persisted
 *      baseline vs 542K measured surface).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow, describeViewDivergence, formatDriftDiagnostics } from "../src/storage/shadow.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import { setLogCapture } from "../src/logger.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetStorageRuntimeStatusForTest, storageStatusWire } from "../src/storage/runtime-status.ts";
import type { Session } from "../src/session.ts";
import type { CompressionBlock, CoreMessage } from "acp-kernel";
import { HOT_ATTACH_WINDOW_MS, noteColdLoad, noteRequest, _resetAttachHeartbeatForTest } from "../src/attach-heartbeat.ts";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the #4323 suite: a developer machine with
// storage.unified in its real config must not leak a tier into these tests.
const HERMETIC = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5408-hermetic-"));
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
 *  that only the sampled read-back can catch (replicated from #3919/#4323). */
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

// ---------------------------------------------------------------------------
// A. Freeze visibility: age stamp, details getter, ESCALATED carries diagnosis
// ---------------------------------------------------------------------------

test("#5408 A: escalation stamps the freeze age, details ride the getters, and the ESCALATED warn carries the field-level diagnosis", () => {
    const dir = tmpDir("freeze-vis");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const ids = "freeze-vis";
            let k = 5;
            shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, i) => msg(i))));
            const hash = tamperFirstRowBytes(dir, ids);

            const { captured, stop } = captureLogs();
            try {
                // Three consecutive sampled drifts over the unhealed tamper.
                for (let loop = 0; loop < 3; loop++) {
                    for (let i = 0; i < 20; i++) {
                        k += 1;
                        shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, j) => msg(j))));
                    }
                }
                assert.equal(stats(shadow).verifyDrift, 3);
                assert.equal(shadow.envelopeFrozen(ids), true, "three consecutive sampled drifts freeze the envelope");

                // #5408: the freeze carries WHEN and rides the detail getters.
                const info = shadow.envelopeFrozenInfo(ids);
                assert.ok(info, "envelopeFrozenInfo reports the freeze");
                assert.ok(info!.sinceMs > Date.now() - 120_000 && info!.sinceMs <= Date.now(), `stamp is recent: ${info!.sinceMs}`);
                assert.deepEqual(shadow.frozenEnvelopeDetails(), [{ id: ids, sinceMs: info!.sinceMs }], "details list the frozen session with its stamp");

                // #5408: the ESCALATED warn (the line operators grep for) now
                // carries the field-level diagnosis instead of bare counts.
                const escalated = captured.filter((e) => e.level === "warn" && e.msg.includes(`DIGEST DRIFT ESCALATED for ${ids}`));
                assert.equal(escalated.length, 1, "exactly ONE escalation alarm for the whole streak");
                assert.ok(escalated[0].msg.includes("diverged:"), `ESCALATED warn carries the diagnosis: ${escalated[0].msg}`);
                assert.ok(escalated[0].msg.includes("tail slot"), `ESCALATED warn names the divergent slot: ${escalated[0].msg}`);

                // Repair the CAS bytes, then one more sample: clean re-admission
                // clears the stamp along with the freeze.
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
                assert.equal(stats(shadow).verifyOk, 2, "pre-tamper sample plus the post-repair sample pass");
                assert.equal(shadow.envelopeFrozen(ids), false, "a clean sample re-admits and unfreezes");
                assert.equal(shadow.envelopeFrozenInfo(ids), null, "re-admission clears the age stamp");
                assert.deepEqual(shadow.frozenEnvelopeDetails(), [], "details are empty after re-admission");
            } finally {
                stop();
            }
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

// ---------------------------------------------------------------------------
// B1. Sweep-while-latched: positive gate + negative gate
// ---------------------------------------------------------------------------

/** Insert a foreign message row (identity absent from any plan this test
 *  produces) — the residue shape a second writer or a lost rewind leaves. */
function insertForeignRow(dir: string, sessionId: string): void {
    const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
    try {
        const row = conn.prepare("SELECT content_hash FROM messages WHERE session_id = ? ORDER BY seq LIMIT 1").get(sessionId) as { content_hash: string } | undefined;
        assert.ok(row, "base content row must exist");
        conn
            .prepare("INSERT INTO messages (session_id, seq, msg_id, role, kind, content_hash, identity) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(sessionId, 99_999, "foreign-msg", "user", "message", row.content_hash, "foreign-identity");
    } finally {
        conn.close();
    }
}

function foreignRowRetired(dir: string, sessionId: string): boolean | null {
    const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
    try {
        const row = conn.prepare("SELECT retired_at FROM messages WHERE session_id = ? AND msg_id = 'foreign-msg'").get(sessionId) as { retired_at: number | null } | undefined;
        return row ? row.retired_at !== null : null;
    } finally {
        conn.close();
    }
}

function latchDrift(shadow: UnifiedShadow, id: string): void {
    const sh = shadow as unknown as { driftedSessions?: Set<string> };
    if (!sh.driftedSessions) sh.driftedSessions = new Set();
    sh.driftedSessions.add(id);
}

test("#5408 B1: a drift-latched folded save sweeps the foreign row out of the index", () => {
    const dir = tmpDir("b1-latched");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const ids = "b1-latched";
            shadow.record(mkLegacy(ids, Array.from({ length: 5 }, (_, i) => msg(i))));
            insertForeignRow(dir, ids);
            assert.equal(foreignRowRetired(dir, ids), false, "foreign row present before the latched save");

            latchDrift(shadow, ids);
            shadow.record({ ...mkLegacy(ids, []), lastMessagesFolded: true });

            assert.equal(foreignRowRetired(dir, ids), true, "latched folded save runs the authoritative-set sweep and retires the foreign row");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("#5408 B1 negative gate: an UNLATCHED folded save leaves foreign rows untouched", () => {
    const dir = tmpDir("b1-control");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const ids = "b1-control";
            shadow.record(mkLegacy(ids, Array.from({ length: 5 }, (_, i) => msg(i))));
            insertForeignRow(dir, ids);

            // No latch: the historical behavior — a folded save (no raw tail)
            // does not claim authoritative-set authority over the table.
            shadow.record({ ...mkLegacy(ids, []), lastMessagesFolded: true });

            assert.equal(foreignRowRetired(dir, ids), false, "unlatched folded save must not sweep (no raw tail, no latch)");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

// ---------------------------------------------------------------------------
// B2. State sub-key drill-down in the drift diagnosis
// ---------------------------------------------------------------------------

test("#5408 B2: describeViewDivergence drills state sub-keys so 'diverged: state' becomes actionable", () => {
    const base = {
        id: "x",
        state: { nextBlockId: 1, tokenSnapshot: { a: 1 }, messageRefs: { byRaw: {}, byRef: {} } },
        lastMessages: [],
    };
    const diverged = { ...base, state: { nextBlockId: 1, tokenSnapshot: { a: 2 }, messageRefs: { byRaw: {}, byRef: {} } } };

    const d = describeViewDivergence(base, diverged);
    assert.deepEqual(d.keys, ["state"]);
    assert.deepEqual(d.stateKeys, ["tokenSnapshot"], "the disagreeing sub-field is named");
    assert.ok(formatDriftDiagnostics(d).includes("diverged: state"), formatDriftDiagnostics(d));
    assert.ok(formatDriftDiagnostics(d).includes("state: tokenSnapshot"), formatDriftDiagnostics(d));

    // Negative gate: equal views carry no drill-down at all.
    const d2 = describeViewDivergence(base, { ...base });
    assert.deepEqual(d2.keys, []);
    assert.equal(d2.stateKeys, undefined, "no stateKeys without a state divergence");
    assert.equal(formatDriftDiagnostics(d2), " [diverged: <unknown>]");
});

// ---------------------------------------------------------------------------
// C. Post-attach observation heartbeat
// ---------------------------------------------------------------------------

test("#5408 C: hot-at-attach silence alarms once; a request disarms; stale or unsaved loads stay quiet", async () => {
    const { captured, stop } = captureLogs();
    try {
        _resetAttachHeartbeatForTest(60);

        // Fire: hot at attach, then total silence.
        noteColdLoad("hb-fire", "unit-test", Date.now() - 1_000);
        await settle(250);
        const fired = captured.filter((e) => e.level === "error" && e.msg.startsWith("[attach] hb-fire"));
        assert.equal(fired.length, 1, "one alarm for the silent hot attach");
        assert.ok(fired[0].msg.includes("NO model request was observed"), fired[0].msg);
        assert.ok(fired[0].msg.includes("#5408"), fired[0].msg);

        // Disarm: traffic resumed before the timer.
        noteColdLoad("hb-disarm", "unit-test", Date.now() - 1_000);
        noteRequest("hb-disarm");
        await settle(250);
        assert.equal(captured.filter((e) => e.msg.startsWith("[attach] hb-disarm")).length, 0, "an observed request disarms the alarm");

        // Stale negative gate: a long-idle session staying idle is normal.
        noteColdLoad("hb-stale", "unit-test", Date.now() - 2 * HOT_ATTACH_WINDOW_MS);
        await settle(250);
        assert.equal(captured.filter((e) => e.msg.startsWith("[attach] hb-stale")).length, 0, "stale-at-attach loads must not arm");

        // No savedAt at all: nothing to judge against.
        noteColdLoad("hb-nosavedat", "unit-test", undefined);
        await settle(250);
        assert.equal(captured.filter((e) => e.msg.startsWith("[attach] hb-nosavedat")).length, 0, "loads without savedAt must not arm");
    } finally {
        _resetAttachHeartbeatForTest();
        stop();
    }
});

// ---------------------------------------------------------------------------
// A2/D. Full-mode SessionStore: rate-limited skip-save errors + stale-load warn
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

test("#5408 A2: frozen skip-saves log exactly ONE rate-limited error per cooldown, and the status wire carries the details", async () => {
    _resetStorageRuntimeStatusForTest();
    process.env.BILI_STORAGE_UNIFIED = "full";
    const dir = tmpDir("skiplog");
    try {
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const sh = (store as unknown as { shadow?: ShadowLike }).shadow;
        assert.ok(sh, "full mode opens a sidecar");
        if (!sh.frozenEnvelopeIds) sh.frozenEnvelopeIds = new Set();
        const id = "skip-session";
        sh.frozenEnvelopeIds.add(id);
        const sinceMap = (sh as unknown as { frozenEnvelopeSince?: Map<string, number> }).frozenEnvelopeSince;
        assert.ok(sinceMap instanceof Map, "frozenEnvelopeSince ledger exists on the sidecar");
        sinceMap.set(id, Date.now() - 11 * 60_000);

        // Wire assertions come FIRST: the first ingest is always sampled, and
        // a clean view re-admits the session (clearing the freeze) inside the
        // very first save — after that the wire is honestly empty again.
        const wire = storageStatusWire();
        assert.equal(wire.frozenEnvelopeSessions, 1, "escalated session visible on the wire");
        assert.deepEqual(wire.frozenEnvelopeDetails.map((f) => f.id), [id], "wire lists the frozen session");
        assert.ok(wire.frozenEnvelopeDetails[0].sinceMs > Date.now() - 12 * 60_000, "wire carries the freeze age");

        const { captured, stop } = captureLogs();
        try {
            const s = makeSession(id, 5, [makeBlock("sb1")]);
            store.scheduleSave(s);
            await settle();
            store.scheduleSave(s);
            await settle();
            store.flushSync(s);
        } finally {
            stop();
        }

        const skips = captured.filter((e) => e.level === "error" && e.msg.includes("skipping") && e.msg.includes("envelope save") && e.msg.includes("#5408"));
        assert.equal(skips.length, 1, "three frozen saves inside one cooldown log exactly ONE error");
        assert.ok(skips[0].msg.includes("scheduled"), `first route named: ${skips[0].msg}`);
        assert.ok(skips[0].msg.includes("FROZEN since"), `freeze age surfaced: ${skips[0].msg}`);

        store.closeQuietly();
        rmBestEffort(dir);
    } finally {
        delete process.env.BILI_STORAGE_UNIFIED;
        _resetStorageRuntimeStatusForTest();
        _setStoreForTest(new SessionStore({ enabled: false, dir: tmpDir("skiplog-out") }));
    }
});

test("#5408 D1: a stale cold-load warns only when the session had compressions AND the view is old", () => {
    process.env.BILI_STORAGE_UNIFIED = "full";
    const dir = tmpDir("stale-load");
    try {
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const lc = (store as unknown as { logColdLoad(id: string, source: string, s: unknown, savedAt?: number): void }).logColdLoad.bind(store as never);
        const shape = (compressionCount: number) => ({
            stats: { lastInputTokens: 1000 },
            state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, stats: { compressionCount } },
        });

        const { captured, stop } = captureLogs();
        try {
            lc("stale-c", "unit-test", shape(2), Date.now() - 45 * 60_000);
            lc("fresh-c", "unit-test", shape(2), Date.now() - 5 * 60_000);
            lc("idle-c", "unit-test", shape(0), Date.now() - 45 * 60_000);
        } finally {
            stop();
        }

        const warns = captured.filter((e) => e.level === "warn" && e.msg.includes("cold-loaded view is ~") && e.msg.includes("#5408"));
        assert.equal(warns.length, 1, "only the old-with-compressions load warns");
        assert.ok(warns[0].msg.includes("stale-c"), warns[0].msg);
        assert.ok(!captured.some((e) => e.msg.includes("fresh-c") && e.msg.includes("cold-loaded view is ~")), "recent view stays quiet");
        assert.ok(!captured.some((e) => e.msg.includes("idle-c") && e.msg.includes("cold-loaded view is ~")), "never-compressed session stays quiet");

        store.closeQuietly();
        rmBestEffort(dir);
    } finally {
        delete process.env.BILI_STORAGE_UNIFIED;
        _resetAttachHeartbeatForTest();
        _setStoreForTest(new SessionStore({ enabled: false, dir: tmpDir("stale-out") }));
    }
});

test.after(() => {
    if (PREV_UNIFIED === undefined) delete process.env.BILI_STORAGE_UNIFIED;
    else process.env.BILI_STORAGE_UNIFIED = PREV_UNIFIED;
    _resetAttachHeartbeatForTest();
    rmBestEffort(HERMETIC);
});
