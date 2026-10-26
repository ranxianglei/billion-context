/**
 * #3919: shadow digest drift must be diagnosable from one log line, and the
 * delta fast path must not ride prefix rewrites below the boundary.
 *
 * The sampled verify backstop (#3166) already heals drift by clearing the
 * watermark, but its single-hash digest left classification to guesswork,
 * and the delta path vouched only for the LAST slot of the trusted prefix —
 * a client/relay rewrite of an older message below the boundary rode the
 * delta undetected until the ≤20-save-later sample fired. Pinned here:
 *  - the head probe fails a rewritten first tail slot to the exact full
 *    path immediately (and converges), without over-refusing normal saves;
 *  - describeViewDivergence/formatDriftDiagnostics name the diverged
 *    dimensions + first divergent tail slot with fingerprints only
 *    (never message body text);
 *  - the repeat marker's input (driftedSessions membership) tracks
 *    consecutive sampled drift until a clean sample re-admits.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow, describeViewDivergence, formatDriftDiagnostics } from "../src/storage/shadow.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { planIngestDelta, loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.ts";
import { setLogCapture } from "../src/logger.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: a developer machine with
// storage.unified in its real config must not leak a tier into these tests.
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3919-hermetic-"));
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
        // Key order matters: loadLegacyView rebuilds state in MERGE_STATE_FIELDS
        // order and the shadow digest is JSON.stringify-based (order-sensitive).
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

/** Swap the CAS bytes under a session's first message row (content_hash
 *  column untouched) — the byte-tamper shape that only the sampled read-back
 *  can catch, replicated from the #3133 suite. Returns the affected hash. */
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

test("head probe: a rewritten first tail slot fails the delta immediately and converges via the full path", () => {
    const dir = tmpdir("bili-3919-head-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const base = Array.from({ length: 12 }, (_, i) => msg(i));
            shadow.record(mkLegacy("drift-head", base), { lastMessages: base });
            shadow.record(mkLegacy("drift-head", [...base, msg(12)]), { lastMessages: [...base, msg(12)] });
            assert.equal(stats(shadow).deltaIngests, 1, "steady append rides the delta");

            // Interior rewrite BELOW the boundary: slot 0 replaced, the rest
            // intact, two fresh turns appended. Pre-#3919 this rode the delta
            // (only the last slot was probed) and surfaced ≤20 saves later as
            // DIGEST DRIFT; now the head probe refuses it on this very save.
            const rewritten = [
                { id: "h_msg0_v2", role: "user", contentType: "text", text: "rewritten head" } as CoreMessage,
                ...base.slice(1), msg(12), msg(13),
            ];
            shadow.record(mkLegacy("drift-head", rewritten), { lastMessages: rewritten });
            assert.equal(stats(shadow).deltaIngests, 1, "rewritten head slot below the boundary must refuse the delta");
            assert.deepEqual(view(store, "drift-head").lastMessages, rewritten, "the full path re-points every slot — the view converges exactly");
            let mark = store.ingestWatermark("drift-head");
            assert.ok(mark && mark.tailSeqs.length === 14, "watermark re-established across the whole new tail");

            shadow.record(mkLegacy("drift-head", [...rewritten, msg(14)]), { lastMessages: [...rewritten, msg(14)] });
            assert.equal(stats(shadow).deltaIngests, 2, "a normal append after the heal still rides the delta (probe must not over-refuse)");

            // The pure planner gate agrees (defense in depth).
            mark = store.ingestWatermark("drift-head");
            assert.ok(mark, "watermark for the planner gate");
            const b = store.probeIngestBoundary("drift-head", mark.seq);
            assert.ok(b, "boundary row for the planner gate");
            const sess = mkLegacy("planner", [...rewritten, msg(14)]);
            assert.ok(planIngestDelta(sess, mark.seq, mark.tailSeqs, { msgId: b.msgId, contentHash: b.contentHash }, true, { msgId: rewritten[0].id }), "matching head → plan");
            assert.equal(planIngestDelta(sess, mark.seq, mark.tailSeqs, { msgId: b.msgId, contentHash: b.contentHash }, true, { msgId: "h_msg0" }), null, "stale head identity → refuse");
            assert.ok(planIngestDelta(sess, mark.seq, mark.tailSeqs, { msgId: b.msgId, contentHash: b.contentHash }, true), "no head arg → legacy behavior (plan)");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("forensics: the drift diagnosis names the diverged dimension and slot without body text", () => {
    const dir = tmpdir("bili-3919-fx-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const ids = "drift-fx";
            let k = 5;
            shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, i) => msg(i))));
            const hash = tamperFirstRowBytes(dir, ids);

            const { captured, stop } = captureLogs();
            try {
                for (let i = 0; i < 20; i++) {
                    k += 1;
                    shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, j) => msg(j))));
                }
            } finally {
                stop();
            }
            assert.equal(stats(shadow).verifyDrift, 1, "the sampled save at n=21 catches the CAS drift");

            // The pure diagnosis over the same two views record() digests:
            // exactly one dimension diverges, at the tampered slot.
            const finalLegacy = mkLegacy(ids, Array.from({ length: k }, (_, j) => msg(j)));
            const d = describeViewDivergence(finalLegacy, view(store, ids));
            assert.deepEqual(d.keys, ["lastMessages"], "only the tampered dimension may diverge");
            assert.equal(d.tailSlot?.index, 0, "first divergence is the tampered slot");
            assert.equal(d.tailSlot?.expect.id, "h_msg0");
            assert.equal(d.tailSlot?.got.id, "tampered");
            assert.notEqual(d.tailSlot?.expect.sha8, d.tailSlot?.got.sha8);
            const line = formatDriftDiagnostics(d);
            assert.ok(line.startsWith(" [diverged: lastMessages"), `diagnosis names the dimension: ${line}`);
            assert.ok(line.includes("tail slot 0:"), `diagnosis names the slot: ${line}`);
            assert.ok(!line.includes("hello 0") && !line.includes(hash), "fingerprints only — never body text or raw hashes");

            // End-to-end: the actual log line carries the same diagnosis, and
            // the FIRST drift of a session is not flagged as repeat.
            const lines = driftLines(captured, ids);
            assert.equal(lines.length, 1, "exactly one drift logged in this window");
            assert.ok(lines[0].includes(" [diverged: lastMessages; tail slot 0: expect h_msg0/user"), `log line carries the field diagnosis: ${lines[0]}`);
            assert.ok(!lines[0].includes("(repeat:"), "the first drift of a session is not flagged as repeat");
            assert.ok(!lines[0].includes("hello 0"), "log line carries fingerprints only");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("repeat marker: consecutive sampled drift stays flagged until a clean sample re-admits", () => {
    const dir = tmpdir("bili-3919-repeat-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const ids = "drift-rpt";
            let k = 5;
            shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, i) => msg(i))));
            const hash = tamperFirstRowBytes(dir, ids);

            const { captured, stop } = captureLogs();
            try {
                // Sample n=21: first drift.
                for (let i = 0; i < 20; i++) {
                    k += 1;
                    shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, j) => msg(j))));
                }
                assert.equal(stats(shadow).verifyDrift, 1);
                assert.ok(drifted(shadow).has(ids), "drift flags the session");

                // Sample n=41 over the SAME unhealed tamper: the watermark
                // clear healed nothing — this is the structural signature.
                for (let i = 0; i < 20; i++) {
                    k += 1;
                    shadow.record(mkLegacy(ids, Array.from({ length: k }, (_, j) => msg(j))));
                }
                assert.equal(stats(shadow).verifyDrift, 2);
                assert.ok(drifted(shadow).has(ids), "consecutive drift keeps the flag");

                // Repair the CAS bytes, then sample n=61: clean re-admission.
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
                const s = stats(shadow);
                assert.equal(s.verifyDrift, 2, "no further drift after the repair");
                assert.equal(s.verifyOk, 2, "pre-tamper sample plus the post-repair sample pass");
                assert.equal(drifted(shadow).size, 0, "a clean sample re-admits the session");
            } finally {
                stop();
            }
            const lines = driftLines(captured, ids);
            assert.equal(lines.length, 2, "two drifts logged");
            assert.ok(!lines[0].includes("(repeat:"), "the first drift is not flagged as repeat");
            assert.ok(lines[1].includes("(repeat: consecutive sampled drift"), `the second consecutive drift IS flagged: ${lines[1]}`);
            const mark = store.ingestWatermark(ids);
            assert.ok(mark && mark.tailSeqs.length === k, "watermark re-established across the healed tail");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});
