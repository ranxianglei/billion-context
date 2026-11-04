/**
 * #5677: a chronic DIGEST DRIFT report (v0.1.212, dsh lane) where the same
 * short assistant slot diverged between the envelope leg and the unified
 * store leg on EVERY sampled check for days — fingerprints showed identical
 * ids (stable text) but byte lengths flipping 148↔149, so the disagreeing
 * byte sat in a NON-text field the diagnosis never named. Two gaps pinned
 * here:
 *  - the drift diagnosis must name the divergent top-level FIELDS of the
 *    first divergent slot (names only — values never reach the log line,
 *    same privacy contract as the #3919 fingerprints);
 *  - while a session is drift-latched the stored prefix is proven
 *    untrustworthy, so the delta fast path must not vouch for it (BOTH
 *    lanes — the sync record() and the backend-queue twin): every
 *    latched save takes the exact full path, the legs stay same-generation
 *    at sample time, the next sample re-admits, and the delta resumes —
 *    the chronic ESCALATED→FROZEN loop (#4614 producer class: a host
 *    re-writing history slots below the watermark on every save) becomes
 *    a bounded, self-healing, diagnosable episode.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow, describeViewDivergence, formatDriftDiagnostics } from "../src/storage/shadow.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { openBackend } from "../src/storage/backend.ts";
import { loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.ts";
import { setLogCapture } from "../src/logger.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: a developer machine with
// storage.unified in its real config must not leak a tier into these tests.
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5677-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

type Captured = { level: string; msg: string };

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

/** Give the serial backend queue a turn so enqueueAsyncRecord drains (same
 *  pattern as the #5412 async suite). */
function settle(ms = 300): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function captureLogs(): { captured: Captured[]; stop: () => void } {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    return { captured, stop: () => setLogCapture(null) };
}

function driftLines(captured: Captured[], sessionId: string): string[] {
    return captured.filter((e) => e.level === "error" && e.msg.startsWith(`[storage] unified shadow DIGEST DRIFT for ${sessionId}:`)).map((e) => e.msg);
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
    ingests: number;
    deltaIngests: number;
    verifySamples: number;
    verifyOk: number;
    verifyDrift: number;
}

function stats(shadow: UnifiedShadow): StatsView {
    return (shadow as unknown as { stats: StatsView }).stats;
}

function drifted(shadow: UnifiedShadow): Set<string> {
    return (shadow as unknown as { driftedSessions: Set<string> }).driftedSessions;
}

function openShadow(dir: string): { shadow: UnifiedShadow; store: UnifiedStore } {
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
    assert.ok(shadow, "shadow mode sidecar must open");
    return { shadow, store };
}

function view(store: UnifiedStore, id: string): ReturnType<typeof loadLegacyView> {
    const session = store.getSessionRow(id);
    assert.ok(session, `session row must exist: ${id}`);
    return loadLegacyView({
        session,
        messages: store.getMessages(id),
        blocks: store.getBlocks(id),
        deadRefs: store.getDeadRefs(id),
        refs: store.getRefs(id),
    });
}

test("diagnosis: the divergent slot's differing top-level fields are named, values stay out", () => {
    // The reported shape: same id/role/text on both legs, ONE extra field on
    // the stored copy (a position/volatile stamp) — the fingerprint alone
    // shows len 148 vs 149 with no way to tell which key moved.
    const base = [msg(0), msg(1), msg(2)];
    const expectView = { lastMessages: base };
    const gotView = { lastMessages: [{ ...base[0], wireIndex: 7 }, base[1], base[2]] };
    const d = describeViewDivergence(expectView, gotView);
    assert.deepEqual(d.keys, ["lastMessages"]);
    assert.equal(d.tailSlot?.index, 0);
    assert.deepEqual(d.tailSlot?.fields, ["wireIndex"], "the extra field is named");
    const line = formatDriftDiagnostics(d);
    assert.ok(line.includes("tail slot 0:"), `slot still named: ${line}`);
    assert.ok(line.includes("fields: wireIndex"), `field segment present: ${line}`);
    assert.ok(!line.includes("hello 0"), "values never reach the line");

    // A VALUE change on a shared key names that key too.
    const d2 = describeViewDivergence(expectView, { lastMessages: [{ ...base[0], text: "changed" }, base[1], base[2]] });
    assert.deepEqual(d2.tailSlot?.fields, ["text"]);

    // Multiple disagreements are all named, sorted.
    const d3 = describeViewDivergence(expectView, { lastMessages: [{ ...base[0], ts: 123, role: "system" }, base[1], base[2]] });
    assert.deepEqual(d3.tailSlot?.fields, ["role", "ts"]);

    // Identical views: no drift, no tailSlot at all.
    const d4 = describeViewDivergence(expectView, { lastMessages: base.map((m) => ({ ...m })) });
    assert.deepEqual(d4.keys, []);
    assert.equal(d4.tailSlot, undefined);

    // Non-object slots: the field drill-down bails cleanly (no crash, no key).
    const d5 = describeViewDivergence({ lastMessages: ["plain"] }, { lastMessages: ["other"] });
    assert.equal(d5.tailSlot?.index, 0);
    assert.equal(d5.tailSlot?.fields, undefined);
});

test("latch gate: a drift-latched session rides the full path until a clean sample re-admits it", () => {
    const dir = tmpdir("bili-5677-latch-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const ids = "drift-latch";
            let k = 5;
            shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, i) => msg(i))));
            assert.equal(stats(shadow).verifyOk, 1, "first ingest samples clean");

            // Tamper the stored copy of slot 0 into a DIFFERENT message (the
            // #3919 CAS-swap shape) — the byte divergence only the sampled
            // read-back can see.
            const db = openSqliteDatabase(path.join(dir, "index.db")).db;
            const row = db.prepare("SELECT content_hash FROM messages WHERE session_id = ? ORDER BY seq LIMIT 1").get(ids) as { content_hash: string };
            assert.ok(row, "row to tamper must exist");
            db.prepare("UPDATE content SET bytes = ? WHERE hash = ?")
                .run(Buffer.from(JSON.stringify({ id: "h_tampered", role: "user", contentType: "text", text: "cas-swap-payload" }), "utf8"), row.content_hash);
            db.close();

            const { captured, stop } = captureLogs();
            try {
                // Sample n=21 catches the divergence.
                for (let i = 0; i < 20; i++) {
                    k += 1;
                    shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, j) => msg(j))));
                }
                assert.equal(stats(shadow).verifyDrift, 1, "sampled drift detected");
                assert.ok(drifted(shadow).has(ids), "drift latches the session");

                const lines = driftLines(captured, ids);
                assert.equal(lines.length, 1);
                // The diagnosis now names WHICH fields of the slot disagree —
                // id/text moved (the tamper swapped the whole message under
                // the slot position); role/contentType agree and stay out.
                assert.ok(lines[0].includes("tail slot 0:"), `slot named: ${lines[0]}`);
                assert.ok(lines[0].includes("fields: id,text"), `fields named, sorted: ${lines[0]}`);
                // Text VALUES stay out (ids appear in the fingerprints by design).
                assert.ok(!lines[0].includes("cas-swap-payload") && !lines[0].includes("hello 0"), "values never reach the log line");

                // While latched: every save takes the exact full path — the
                // trusted-prefix delta is suspended for the whole window.
                const deltasAtLatch = stats(shadow).deltaIngests;
                for (let i = 0; i < 20; i++) {
                    k += 1;
                    shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, j) => msg(j))));
                }
                assert.equal(stats(shadow).deltaIngests, deltasAtLatch, "no delta ingest while drift-latched");
                assert.equal(stats(shadow).verifyDrift, 2, "the tamper is permanent, so the second sample drifts too");

                // Heal the stored bytes; the next sample must re-admit.
                const db2 = openSqliteDatabase(path.join(dir, "index.db")).db;
                db2.prepare("UPDATE content SET bytes = ? WHERE hash = ?")
                    .run(Buffer.from(JSON.stringify(msg(0)), "utf8"), row.content_hash);
                db2.close();
                for (let i = 0; i < 20; i++) {
                    k += 1;
                    shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, j) => msg(j))));
                }
                assert.equal(stats(shadow).verifyDrift, 2, "no further drift after the heal");
                assert.ok(!drifted(shadow).has(ids), "a clean sample releases the latch");

                // Delta resumes once the prefix is trusted again.
                const before = stats(shadow).deltaIngests;
                shadow.record(mkLegacy(ids, Array.from({ length: k + 1 }, (_, j) => msg(j))));
                assert.equal(stats(shadow).deltaIngests, before + 1, "post-re-admission append rides the delta");
            } finally {
                stop();
            }
            assert.deepEqual(view(store, ids).lastMessages, Array.from({ length: k + 1 }, (_, j) => msg(j)), "the healed view converges exactly");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("latch gate (async twin): a drift-latched session on the backend queue also rides the full path", async () => {
    const dir = tmpdir("bili-5677-async-latch-");
    try {
        // Real sqlite backend + fromBackend: record() lands on
        // enqueueAsyncRecord — the same queue an opt-in network backend runs
        // on, without needing a live server (same setup as the #5412 suite).
        const backend = await openBackend("sqlite", path.join(dir, "index.db"));
        const shadow = UnifiedShadow.fromBackend("shadow", backend, (r) => r as LegacySessionLike);
        try {
            const ids = "drift-latch-async";
            let k = 5;
            shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, i) => msg(i))));
            await settle();
            assert.equal(stats(shadow).ingests, 1, "first ingest is full");
            assert.equal(stats(shadow).deltaIngests, 0);

            // Positive control: unlatched, an append rides the delta fast path.
            k += 1;
            shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, i) => msg(i))));
            await settle();
            assert.equal(stats(shadow).deltaIngests, 1, "unlatched append rides the delta");
            assert.equal(stats(shadow).ingests, 2, "every save lands as an ingest (async lane counts deltas too)");

            // Latch the session directly (same manual latch as the #5412
            // suite — this pins the GATE predicate, not the sampling that
            // sets it): the next save must take the exact full path even
            // though the watermark says the prefix is unchanged.
            drifted(shadow).add(ids);
            k += 1;
            shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, i) => msg(i))));
            await settle();
            assert.equal(stats(shadow).deltaIngests, 1, "no delta ingest while drift-latched (async queue)");
            assert.equal(stats(shadow).ingests, 3, "the latched save landed via the exact full path");
        } finally {
            shadow.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});
