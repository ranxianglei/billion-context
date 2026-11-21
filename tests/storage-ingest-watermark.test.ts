/**
 * #3133 (superseded form) / 2026-11-21: per-save reconciliation by client
 * identity — O(new messages) per save, with NO stored trust.
 *
 * The #3133 watermark (a durable "I wrote 1..W" receipt on the sessions row)
 * is gone: it proved nothing about the prefix rows, could not survive a
 * process handoff honestly, and every doubt about it cost a full re-ingest.
 * Each save now reconciles the client's message ids against the stored rows
 * by (session_id, msg_id, identity):
 *
 *   - a msg id with exactly ONE live stored row PINS BLIND — zero
 *     serializations for that slot (client ids are content-derived, so a
 *     slot rewrite mints a NEW id and arrives as a new row);
 *   - unknown ids, multi-generation ids (split tool-call cores) and
 *     tombstone rows pay stringify+hash and land/update rows;
 *   - ids the save does not present are retired by the completeLog sweep
 *     (raw tail or drift-latched), exactly as the deep path did.
 *
 * Consequences pinned here: a process handoff inherits nothing (there is
 * nothing to inherit), a rewritten tail slot converges on the SAME save
 * (#3285's drift becomes self-healing within one save instead of a
 * watermark void), duplicate-identity tails (#4182 corpus) pin their slots
 * to the one row instead of falling back, and foreign garbage rows are
 * swept instead of anchored around.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { planIngest, planReconciled, loadLegacyView, ingestSerializations, type LegacySessionLike } from "../src/storage/ingest.ts";
import { identityOfStoredContent } from "../src/storage/identity.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: a developer machine with
// storage.unified in its real config must not leak a tier into these tests
// (the shadow here is constructed directly with its own env object anyway).
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-watermark-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

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

function msg(i: number, text = `hello ${i}`): CoreMessage {
    return { id: `h_msg${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text } as CoreMessage;
}

function mkLegacy(id: string, lastMessages: LegacySessionLike["lastMessages"], pluginSnapshot?: LegacySessionLike["pluginSnapshot"]): LegacySessionLike {
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
        pluginSnapshot,
    };
}

interface StatsView {
    ingests: number;
    verifySamples: number;
    verifyOk: number;
    verifyDrift: number;
}

function openShadow(dir: string): { shadow: UnifiedShadow; store: UnifiedStore } {
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
    assert.ok(shadow, "shadow mode sidecar must open");
    return { shadow, store };
}

function stats(shadow: UnifiedShadow): StatsView {
    return (shadow as unknown as { stats: StatsView }).stats;
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

/** The equivalence oracle: whatever the reconciled save wrote must equal
 *  what a deep (full-serialize) re-ingest of the same legacy view writes —
 *  deep view equality (state, tail, pointers). */
function assertReconciledMatchesFull(store: UnifiedStore, legacy: LegacySessionLike): void {
    const before = view(store, legacy.id);
    assert.equal(store.ingestSession(planIngest(legacy)), true, "deep re-ingest must apply");
    assert.deepEqual(view(store, legacy.id), before, "reconciled-written rows must equal a deep re-ingest's");
}

test("reconcile: steady-state saves cost O(new messages), not O(full log)", () => {
    const dir = tmpdir("bili-wm-steady-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const n = 12;
            let legacy = mkLegacy("wm-steady", Array.from({ length: n }, (_, i) => msg(i)));

            ingestSerializations.count = 0;
            shadow.record(legacy);
            assert.equal(ingestSerializations.count, n, "first save (no stored rows) serializes every message once");
            const rows0 = store.getMessages("wm-steady");
            assert.deepEqual(rows0.map((r) => r.msgId), Array.from({ length: n }, (_, i) => `h_msg${i}`), "rows land in client order");

            // +1 message: n pins (zero serialization) + 1 new — cost O(1), not O(n).
            legacy = mkLegacy("wm-steady", Array.from({ length: n + 1 }, (_, i) => msg(i)));
            ingestSerializations.count = 0;
            shadow.record(legacy);
            assert.equal(ingestSerializations.count, 1, "append serializes ONLY the new message (the #3133 property, no watermark)");
            assert.equal(store.getMessages("wm-steady").length, n + 1, "row count tracks the tail");
            assertReconciledMatchesFull(store, legacy);

            // +3 messages: cost scales with NEW, not total.
            legacy = mkLegacy("wm-steady", Array.from({ length: n + 4 }, (_, i) => msg(i)));
            ingestSerializations.count = 0;
            shadow.record(legacy);
            assert.equal(ingestSerializations.count, 3);
            assertReconciledMatchesFull(store, legacy);
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reconcile: zero-new-message save serializes nothing", () => {
    const dir = tmpdir("bili-wm-idle-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const n = 10;
            let legacy = mkLegacy("wm-idle", Array.from({ length: n }, (_, i) => msg(i)));
            shadow.record(legacy);

            // Same tail, changed metadata only (stats bump): every slot pins
            // blind — a metadata-only save commits ZERO message
            // serializations (the #3133 delta probe is gone; pinning is
            // strictly cheaper than the old boundary probe).
            const tailNow = legacy.lastMessages ?? [];
            legacy = mkLegacy("wm-idle", tailNow);
            legacy.stats = { requests: 2 };
            ingestSerializations.count = 0;
            // Production metadata-only saves carry the raw tail (persist
            // passes it whenever lastMessages is non-empty).
            shadow.record(legacy, { lastMessages: tailNow });
            assert.equal(ingestSerializations.count, 0, "metadata-only save must serialize nothing (all blind pins)");
            assert.equal(store.getMessages("wm-idle").length, n, "no message rows change");
            assertReconciledMatchesFull(store, legacy);
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reconcile: envelope re-render without rawTail re-points the tail in envelope order", () => {
    const dir = tmpdir("bili-wm-render-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            // Raw-tail lineage: summary carrier first, then raw messages.
            const msgs = [msg(0), msg(1), msg(2)];
            const carrier = msg(99);
            carrier.id = "acp_summary_b1";
            const lineage = [carrier, ...msgs];
            let legacy = mkLegacy("wm-render", lineage);
            shadow.record(legacy, { lastMessages: lineage });
            const rawOrder = store.getMessages("wm-render").map((r) => r.msgId);
            assert.deepEqual(rawOrder, ["acp_summary_b1", "h_msg0", "h_msg1", "h_msg2"]);

            // Stale-convergence path shape: record(disk) with NO rawTail, the
            // envelope's folded re-render presenting the SAME identities in a
            // DIFFERENT order and the same length. Every slot pins (no
            // serialization); the tail re-points to the envelope's order.
            // (Old contract: the delta was REFUSED here so the full path
            // rebuilt tailSeqs; the reconciler re-points on the cheap path.)
            const envRender = [msgs[0], carrier, msgs[1], msgs[2]];
            legacy = mkLegacy("wm-render", envRender);
            ingestSerializations.count = 0;
            shadow.record(legacy);
            assert.equal(ingestSerializations.count, 0, "envelope render must pin, not re-serialize");
            const served = view(store, "wm-render");
            assert.ok(served.lastMessages);
            assert.deepEqual(served.lastMessages.map((m) => m.id), ["h_msg0", "acp_summary_b1", "h_msg1", "h_msg2"], "served view must follow the envelope render order");
            assertReconciledMatchesFull(store, legacy);
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reconcile: a fold pins the survivors and inserts the summary above them", () => {
    const dir = tmpdir("bili-wm-fold-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const tail0 = Array.from({ length: 8 }, (_, i) => msg(i));
            shadow.record(mkLegacy("wm-fold", tail0));

            // Fold: m2..m5 collapse into a new summary message; the tail
            // SHRINKS. m0/m1/m6/m7 pin blind; the summary lands ABOVE the
            // surviving old rows (abs 8).
            const summary = { id: "h_summary", role: "user", contentType: "text", text: "summary of 2..5" } as CoreMessage;
            const tail1 = [tail0[0], tail0[1], summary, tail0[6], tail0[7]];
            ingestSerializations.count = 0;
            shadow.record(mkLegacy("wm-fold", tail1));
            assert.equal(ingestSerializations.count, 1, "fold serializes only the new summary (survivors pin)");
            const row1 = store.getSessionRow("wm-fold");
            assert.ok(row1);
            const tailSeqs1 = (JSON.parse(row1!.tailJson) as { tailSeqs: number[] }).tailSeqs;
            assert.deepEqual(tailSeqs1, [0, 1, 8, 6, 7], "tail pointers carry the holes verbatim");

            // Post-fold append: pins keep working immediately (anchored at
            // max(seq)+1 = 9, skipping the summary's slot is fine).
            const tail2 = [...tail1, msg(8), msg(9)];
            ingestSerializations.count = 0;
            shadow.record(mkLegacy("wm-fold", tail2));
            assert.equal(ingestSerializations.count, 2, "post-fold append serializes only the two new messages");
            const row2 = store.getSessionRow("wm-fold");
            assert.ok(row2);
            assert.deepEqual((JSON.parse(row2!.tailJson) as { tailSeqs: number[] }).tailSeqs, [0, 1, 8, 6, 7, 9, 10], "appends continue after the max");
            assert.deepEqual(view(store, "wm-fold").lastMessages, tail2, "the read view is the exact folded tail");
            assertReconciledMatchesFull(store, mkLegacy("wm-fold", tail2));
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reconcile: foreign row corruption converges on the SAME save (no watermark to void)", () => {
    const dir = tmpdir("bili-wm-tamper-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const n = 10;
            const at = (k: number) => mkLegacy("wm-tamper", Array.from({ length: k }, (_, i) => msg(i)));
            shadow.record(at(n));

            // Leg 1: a foreign writer renames the boundary row's msg_id. The
            // identity join no longer matches → the message re-serializes at
            // a fresh row, and the renamed junk row is NOT in the presented
            // identity set → the raw-tail sweep retires it. One save, fully
            // converged (the old contract needed a full-fallback save).
            const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
            try {
                conn.prepare("UPDATE messages SET msg_id = 'h_evil' WHERE session_id = ? AND msg_id = ?").run("wm-tamper", "h_msg9");
            } finally {
                conn.close();
            }
            // The sweep that retires the renamed junk row is gated on the
            // raw tail (completeLog) — the production live-save shape. Pass
            // it, or the junk anchors around and the row count stays high.
            shadow.record(at(n + 1), { lastMessages: (at(n + 1).lastMessages ?? []) as CoreMessage[] });
            assert.deepEqual(view(store, "wm-tamper").lastMessages, at(n + 1).lastMessages, "renamed row: the view converges on the same save");
            const rowsAfter = store.getMessages("wm-tamper");
            assert.equal(rowsAfter.length, n + 1, "the junk row was swept, the true row re-landed");
            assertReconciledMatchesFull(store, at(n + 1));

            // Leg 2: foreign DELETE of a tail row. Missing → re-serialized at
            // a fresh seq; converges on the same save too.
            const conn2 = openSqliteDatabase(path.join(dir, "index.db")).db;
            try {
                conn2.prepare("DELETE FROM messages WHERE session_id = ? AND msg_id = ?").run("wm-tamper", "h_msg8");
            } finally {
                conn2.close();
            }
            shadow.record(at(n + 2), { lastMessages: (at(n + 2).lastMessages ?? []) as CoreMessage[] });
            assert.deepEqual(view(store, "wm-tamper").lastMessages, at(n + 2).lastMessages);
            assertReconciledMatchesFull(store, at(n + 2));

            // Recovery: with every row intact again, the next save pins
            // everything and serializes only the append.
            ingestSerializations.count = 0;
            shadow.record(at(n + 3));
            assert.equal(ingestSerializations.count, 1, "steady state resumes: only the new message serializes");
            assertReconciledMatchesFull(store, at(n + 3));
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reconcile: foreign rows are anchored around (no raw tail) or swept (raw tail)", () => {
    const dir = tmpdir("bili-wm-foreign-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const n = 6;
            const at = (k: number) => mkLegacy("wm-foreign", Array.from({ length: k }, (_, i) => msg(i)));
            shadow.record(at(n));

            // A non-bili writer drops a junk row. Save WITHOUT the raw tail:
            // the sweep gate (completeLog) is off, so the junk survives and
            // appends anchor at max(seq)+1 — the view never references it.
            const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
            try {
                const junk = Buffer.from(JSON.stringify({ id: "h_junk", role: "user", contentType: "text", text: "foreign" }), "utf8");
                conn.prepare("INSERT INTO content (hash, byte_len, refcount, bytes) VALUES ('junkhash', ?, 1, ?)").run(junk.length, junk);
                conn
                    .prepare("INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash) VALUES (?, ?, ?, NULL, NULL, 'user', 'message', 'junkhash')")
                    .run("wm-foreign", 99, "h_junk");
            } finally {
                conn.close();
            }
            shadow.record(at(n + 1));
            let rows = store.getMessages("wm-foreign");
            assert.equal(rows.length, n + 2, "no raw tail: the junk row survives (sweep gate off), append anchors above");
            assert.deepEqual(view(store, "wm-foreign").lastMessages, at(n + 1).lastMessages, "the read view never references the junk");

            // WITH the raw tail (the production live-save shape), the same
            // junk is retired by the #3285 authoritative sweep.
            const tail = (at(n + 2).lastMessages ?? []) as CoreMessage[];
            shadow.record(at(n + 2), { lastMessages: tail });
            rows = store.getMessages("wm-foreign");
            assert.deepEqual(rows.map((r) => r.msgId).filter((id) => id !== "h_junk"), tail.map((m) => m.id), "raw tail: the junk row is swept");
            assert.equal(rows.some((r) => r.msgId === "h_junk"), false, "swept (retired) — not visible to live scans");
            assertReconciledMatchesFull(store, at(n + 2));
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reconcile: fresh session serializes everything; the next save pins", () => {
    const dir = tmpdir("bili-wm-fresh-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            ingestSerializations.count = 0;
            shadow.record(mkLegacy("wm-fresh", [msg(0), msg(1), msg(2)]));
            assert.equal(ingestSerializations.count, 3, "no stored rows → everything serializes");
            assert.equal(store.getMessages("wm-fresh").length, 3);

            ingestSerializations.count = 0;
            shadow.record(mkLegacy("wm-fresh", [msg(0), msg(1), msg(2), msg(3)]));
            assert.equal(ingestSerializations.count, 1, "second save pins the three, serializes the one");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reconcile: remove() drops the rows; re-import rebuilds them", () => {
    const dir = tmpdir("bili-wm-remove-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const at = (k: number) => mkLegacy("wm-remove", Array.from({ length: k }, (_, i) => msg(i)));
            shadow.record(at(5));

            shadow.remove("wm-remove");
            assert.equal(store.getSessionRow("wm-remove"), null, "deleteSession drops the row");
            assert.deepEqual(store.storedMessagesIndex("wm-remove"), [], "the stored-row index is empty after the delete");

            shadow.record(at(6));
            assert.equal(store.getMessages("wm-remove").length, 6);

            // Re-import (organic full-mode import path): everything is a new
            // row by construction; subsequent saves pin again.
            shadow.remove("wm-remove");
            const imported = shadow.importRecord(at(6));
            assert.ok(imported, "importRecord returns the legacy view");
            assert.equal(store.getMessages("wm-remove").length, 6, "re-import re-lands every row");
            ingestSerializations.count = 0;
            shadow.record(at(7));
            assert.equal(ingestSerializations.count, 1, "saves pin again after the re-import");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reconcile: rewound/re-derived tail slots pin to the existing rows (no silent drops)", () => {
    const dir = tmpdir("bili-wm-rewind-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            // Save [m0..m4]; then the client rewinds and RE-DERIVES m1/m2
            // byte-identically (same ids + content) appended after m4 — the
            // identities already have rows at seqs 1/2.
            const tail0 = Array.from({ length: 5 }, (_, i) => msg(i));
            shadow.record(mkLegacy("wm-rewind", tail0));
            const tail1 = [...tail0, msg(1), msg(2)];
            ingestSerializations.count = 0;
            shadow.record(mkLegacy("wm-rewind", tail1));
            assert.equal(ingestSerializations.count, 0, "re-derived identities pin — zero serializations (the old path fell back to full)");
            const v = view(store, "wm-rewind");
            assert.deepEqual(v.lastMessages, tail1, "the re-derived slots point at their existing rows");
            assert.equal(store.getMessages("wm-rewind").length, 5, "no duplicate rows for re-derived identities");
            const row = store.getSessionRow("wm-rewind");
            assert.ok(row);
            assert.deepEqual((JSON.parse(row!.tailJson) as { tailSeqs: number[] }).tailSeqs, [0, 1, 2, 3, 4, 1, 2], "tail slots may repeat a seq (both slots pin the one row)");
            assertReconciledMatchesFull(store, mkLegacy("wm-rewind", tail1));
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reconcile: every duplicate-identity tail shape pins to the deep path's rows — corpus from #4182", () => {
    const dir = tmpdir("bili-wm-resend-corpus-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            // The #4182 corpus: every shape whose tail carries an
            // already-stored identity. The reconciler cannot diverge from a
            // deep ingest by construction (it pins the same row the deep
            // remap would adopt), so each shape's final state equals the
            // pure-deep state and the tail slots keep every presentation
            // position — no slot can dangle (the #4182 bug class is closed
            // structurally, not by a guard).
            const shapes: { name: string; first: CoreMessage[]; second: CoreMessage[] }[] = [
                { name: "adjacent duplicate at the tip", first: [msg(0), msg(1), msg(2)], second: [msg(0), msg(1), msg(2), msg(2)] },
                { name: "duplicate in the middle of the new tail", first: [msg(0), msg(1), msg(2)], second: [msg(0), msg(1), msg(2), msg(0), msg(2)] },
                { name: "double duplicate (both prefix messages resent)", first: [msg(0), msg(1)], second: [msg(0), msg(1), msg(0), msg(1)] },
                { name: "duplicate of an interior prefix message", first: [msg(0), msg(1), msg(2), msg(3)], second: [msg(0), msg(1), msg(2), msg(3), msg(1)] },
                { name: "control: no duplicate", first: [msg(0), msg(1), msg(2)], second: [msg(0), msg(1), msg(2), msg(4)] },
            ];
            shapes.forEach((shape, k) => {
                const id = `wm-corpus-${k}`;
                shadow.record(mkLegacy(id, shape.first));
                shadow.record(mkLegacy(id, shape.second));
                // Oracle: what a pure deep ingest of the same view writes.
                const fullPlan = planIngest(mkLegacy(id, shape.second));
                const expTail = (JSON.parse(fullPlan.session.tailJson) as { tailSeqs: number[] }).tailSeqs;
                assert.equal(store.getMessages(id).length, fullPlan.messages.length, `${shape.name}: no extra rows for resent identities`);
                const row = store.getSessionRow(id);
                assert.ok(row);
                assert.deepEqual((JSON.parse(row!.tailJson) as { tailSeqs: number[] }).tailSeqs, expTail, `${shape.name}: tailSeqs equal the deep path's`);
                assert.deepEqual(view(store, id).lastMessages, shape.second, `${shape.name}: served view keeps every tail slot`);
            });
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("planner contract (#4182): the reconciler dedups duplicate-identity tails onto one row, by construction", () => {
    const A = msg(0);
    const B = msg(1);
    const full = planIngest(mkLegacy("p-full", [A, B, A]));
    assert.equal(full.messages.length, 2, "deep plan dedups the resent identity onto its existing seq");
    assert.deepEqual((JSON.parse(full.session.tailJson) as { tailSeqs: number[] }).tailSeqs, [0, 1, 0]);
    // The reconciler against an EMPTY store must produce the SAME plan (it
    // pins nothing, serializes everything) — and against the stored shape,
    // the resent slot pins A's row.
    const fresh = planReconciled(mkLegacy("p-fresh", [A, B, A]), []);
    // The reconciled plan carries SENTINEL seqs (RECONCILE_SENTINEL_BASE+idx)
    // that the store's remap turns absolute; the deep plan carries relative
    // seqs. The two seq spaces differ by design, so only the DEDUP PATTERN
    // (the resent slot points at A's slot) is comparable across them — not
    // the absolute numbers.
    const freshTail = (JSON.parse(fresh.session.tailJson) as { tailSeqs: number[] }).tailSeqs;
    assert.equal(freshTail.length, 3, "empty store: three tail slots");
    assert.equal(freshTail[2], freshTail[0], "empty store: the resent slot dedupes onto A's slot (#4182 closed structurally)");
    assert.equal(fresh.messages.length, 2, "empty store: two rows, duplicate slot deduped");
    const idOf = (m: CoreMessage) => identityOfStoredContent(JSON.stringify(m));
    const pinned = planReconciled(mkLegacy("p-pinned", [A, B, A]), [
        { seq: 0, msgId: A.id, contentHash: "a", identity: idOf(A), retiredAt: null, ref: null },
        { seq: 1, msgId: B.id, contentHash: "b", identity: idOf(B), retiredAt: null, ref: null },
    ]);
    assert.equal(pinned.messages.length, 3, "three log slots (the duplicate pins A's row, not a new row)");
    const pinnedTail = (JSON.parse(pinned.session.tailJson) as { tailSeqs: number[] }).tailSeqs;
    assert.deepEqual(pinnedTail, [0, 1, 0], "the resent slot points at A's existing seq 0 — no dangling slot (#4182 closed structurally)");
});

test("reconcile: snapshot-bearing sessions pin their snapshots; deep re-serializes", () => {
    const dir = tmpdir("bili-wm-snapshot-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const snapshot = [msg(0), msg(1)];
            const tail = [msg(0), msg(1), msg(2)];
            shadow.record(mkLegacy("wm-snap", tail, snapshot));
            assert.equal(store.getMessages("wm-snap").length, 3);
            // The old "snapshot → always full" rule existed because the DELTA
            // planner could not see the full log. The reconciler pins the
            // snapshot entries like any other identity, so the append is
            // cheap; the deep override (drift latch) still re-serializes
            // everything when it fires.
            ingestSerializations.count = 0;
            shadow.record(mkLegacy("wm-snap", [...tail, msg(3)], snapshot));
            assert.equal(ingestSerializations.count, 1, "snapshot entries pin; only the new message serializes");
            // The deep path (latched sessions, #5677) serializes everything.
            const deepPlan = planIngest(mkLegacy("wm-snap", [...tail, msg(3)], snapshot));
            assert.equal(deepPlan.messages.length, 4, "deep plan re-serializes the whole log");
            assertReconciledMatchesFull(store, mkLegacy("wm-snap", [...tail, msg(3)], snapshot));
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reconcile: sampled verification catches CAS drift; the byte-heal is out of scope (#7431 backstop)", async () => {
    const dir = tmpdir("bili-wm-verify-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            // 21 saves: save 1 fresh (all serialize), saves 2..21 pin + append.
            let k = 5;
            shadow.record(mkLegacy("wm-verify", Array.from({ length: k }, (_, i) => msg(i))));
            const s0 = stats(shadow);
            assert.equal(s0.verifySamples, 1, "first ingest verifies");

            // Tamper the CAS body under a tail row the reconciler will PIN
            // (it does not see bytes on the pin path) — only a sampled
            // read-back can catch it, exactly as pre-#3133.
            const conn = openSqliteDatabase(path.join(dir, "index.db")).db;
            try {
                const row = conn.prepare("SELECT content_hash FROM messages WHERE session_id = ? ORDER BY seq LIMIT 1").get("wm-verify") as { content_hash: string } | undefined;
                assert.ok(row, "row to tamper must exist");
                conn
                    .prepare("UPDATE content SET bytes = ? WHERE hash = ?")
                    .run(Buffer.from(JSON.stringify({ id: "tampered", role: "user", contentType: "text", text: "tampered" }), "utf8"), row.content_hash);
            } finally {
                conn.close();
            }

            for (let i = 0; i < 20; i++) {
                k += 1;
                shadow.record(mkLegacy("wm-verify", Array.from({ length: k }, (_, j) => msg(j))));
            }
            const s1 = stats(shadow);
            assert.equal(s1.verifySamples, 2, "verify runs on ingest 1 and 21 only");
            assert.equal(s1.verifyOk, 1, "only the pre-tamper sample may pass");
            assert.equal(s1.verifyDrift, 1, "the sampled save at n=21 must catch the CAS drift");
            assert.equal(store.getMessages("wm-verify").length, k, "rows kept growing through the pinned saves");
            // The drift latch forces the NEXT save onto the deep path — which
            // re-serializes every row. Byte-level CAS poisoning (same hash,
            // different bytes) is OUT OF SCOPE by construction: putContent
            // trusts the hash (store.ts), so the deep save re-serializes to
            // the SAME hash and cannot re-land the bytes — the #7431
            // repair/backup tools are the backstop. The drift is still CAUGHT
            // (verifyDrift above) and the latch still forces the deep path;
            // only the byte-heal is out of reach.
            k += 1;
            ingestSerializations.count = 0;
            shadow.record(mkLegacy("wm-verify", Array.from({ length: k }, (_, j) => msg(j))));
            assert.equal(ingestSerializations.count, k, "the drift latch forced a deep save: every row re-serialized");
            const v = view(store, "wm-verify");
            assert.ok(v.lastMessages);
            const first = v.lastMessages![0] as { id: string; text?: string };
            assert.equal(first.text, "tampered", "byte-level CAS poisoning survives the deep save (hash-trust family; #7431 backstop)");
            assert.equal(store.getMessages("wm-verify").length, k, "deep re-ingest appended the new row");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reconcile: v4 database migrates to v11 additively; newer user_version no-ops", async () => {
    const dir = tmpdir("bili-wm-migrate-");
    try {
        const dbPath = path.join(dir, "index.db");
        // Craft the v4 shape: the current fresh-install DDL minus the v5
        // (then-watermark) column, one live session with message rows,
        // user_version=4. Newer additive shapes still in the DDL (v6 orphans
        // column, v7 media table) are presence-probed by the migration, so
        // they re-land as no-ops.
        // created_at/updated_at must match mkLegacy: the sessions upsert
        // keeps created_at from the existing row (first-seen semantics), so
        // a mismatch would show up as sampled-verify drift, not a migration
        // problem.
        const { STORAGE_DDL_V1_FOR_TESTS } = await import("../src/storage/schema.ts");
        const v4Ddl = STORAGE_DDL_V1_FOR_TESTS.replace(/^\s*last_ingested_seq   INTEGER,$/m, "");
        const { DatabaseSync } = await import("node:sqlite");
        const raw = new DatabaseSync(dbPath);
        raw.exec(v4Ddl);
        raw.prepare(
            "INSERT INTO sessions (session_id, created_at, updated_at, next_block_id, next_run_id, meta_json, stats_json, metadata_json, kstate_json, tail_json, ccr_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run("v4-sess", 1000, 2000, 1, 1, "{}", "{}", "{}", "{}", '{"pluginSnapshotSeqs":null,"tailSeqs":[0],"tailFolded":false}', null);
        raw.prepare("INSERT INTO content (hash, byte_len, refcount, bytes) VALUES (?, ?, 1, ?)").run("c0", Buffer.byteLength(JSON.stringify(msg(0))), Buffer.from(JSON.stringify(msg(0)), "utf8"));
        raw.prepare("INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash) VALUES (?, 0, ?, NULL, NULL, 'user', 'message', ?)").run("v4-sess", msg(0).id, "c0");
        raw.exec("PRAGMA user_version = 4");
        raw.close();

        const store = UnifiedStore.open(dbPath);
        try {
            const ver = (store as unknown as { db: { prepare(q: string): { get(): unknown } } }).db.prepare("PRAGMA user_version").get() as { user_version: number };
            assert.equal(ver.user_version, 11, "open() migrates v4 → v11");
            const row = store.getSessionRow("v4-sess");
            assert.ok(row, "legacy session row survives the migration");
            assert.equal(row!.lastIngestedSeq, null, "legacy rows read back with a NULL deprecated column");
            const messages = store.getMessages("v4-sess");
            assert.equal(messages.length, 1, "legacy message rows readable");
            assert.equal(messages[0].msgId, msg(0).id);

            // First save on a migrated DB: the stored row's identity matches
            // (same bytes) → pin; the new message serializes.
            const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
            assert.ok(shadow);
            try {
                const legacy = mkLegacy("v4-sess", [msg(0), msg(1)]);
                ingestSerializations.count = 0;
                shadow.record(legacy);
                assert.equal(ingestSerializations.count, 1, "migrated row pins (same identity), only the new message serializes");
                const tail2 = [msg(0), msg(1), msg(2)];
                ingestSerializations.count = 0;
                shadow.record(mkLegacy("v4-sess", tail2));
                assert.equal(ingestSerializations.count, 1, "second save: pin 2, serialize 1");
                assertReconciledMatchesFull(store, mkLegacy("v4-sess", tail2));
            } finally {
                shadow.close();
            }
        } finally {
            store.close();
        }

        // Version-gate no-op: a DB stamped at the current schema head
        // (an older build opening a newer file) must open without error and
        // leave user_version alone — the additive-column contract. The
        // probe version sits AT the current schema head so the no-op branch
        // still exercises after future bumps.
        const fwd = new DatabaseSync(dbPath);
        fwd.exec("PRAGMA user_version = 11");
        fwd.close();
        const older = UnifiedStore.open(dbPath);
        try {
            const ver2 = (older as unknown as { db: { prepare(q: string): { get(): unknown } } }).db.prepare("PRAGMA user_version").get() as { user_version: number };
            assert.equal(ver2.user_version, 11, "newer user_version is left untouched");
            assert.ok(older.getSessionRow("v4-sess"), "rows stay readable");
        } finally {
            older.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reconcile: restart handoff — a foreign writer's rows converge on the first raw-tail save (#3285)", () => {
    const dir = tmpdir("bili-wm-handoff-");
    try {
        // Live saves carry the raw tail (persist.ts guardedBuild) — that is
        // what makes a plan the complete log. Both processes save through
        // that production shape.
        const withRaw = (id: string, lastMessages: CoreMessage[]): [LegacySessionLike, { lastMessages: CoreMessage[] }] =>
            [mkLegacy(id, lastMessages), { lastMessages }];
        // Process A: ingests 10 messages, then exits mid-drain (a host
        // restart while the old instance still flushes — the #3285 shape).
        const a = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
        assert.ok(a, "first process must open");
        try {
            const msgsA = Array.from({ length: 10 }, (_, i) => msg(i));
            a.record(...withRaw("handoff", msgsA));
        } finally {
            a.close();
        }
        // Process B boots on the same directory. Its view is what the host
        // resent AFTER the restart: two tail turns are gone (the desktop
        // rebuilt history from its own store), so B's truth is shorter than
        // what A ingested.
        const b = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
        assert.ok(b, "second process must open");
        const storeB = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const view = [msg(0), msg(1), msg(2)];
            b.record(...withRaw("handoff", view));
            const s = stats(b);
            assert.equal(s.verifyDrift, 0, "no DIGEST DRIFT: the reconciled save replaced A's rows");
            assert.equal(s.verifyOk, 1, "sampled verification passes on the first ingest");
            const rows = storeB.getMessages("handoff");
            assert.equal(rows.length, 3, "A's orphaned rows are swept (retired)");
            assert.deepEqual(rows.map((r) => r.msgId), ["h_msg0", "h_msg1", "h_msg2"]);
            // Steady state resumes: the next save pins + appends.
            ingestSerializations.count = 0;
            b.record(...withRaw("handoff", [...view, msg(10)]));
            assert.equal(ingestSerializations.count, 1, "post-handoff saves pin again");
            assert.equal(stats(b).verifyDrift, 0);
        } finally {
            storeB.close();
            b.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("reconcile: completeLog sweep skips lane-owned sessions (#3248/#3285)", () => {
    const dir = tmpdir("bili-wm-lane-skip-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            // Lane-owned: any "inc:" ext key marks positional consumption of the
            // messages table — its rows must survive even when absent from the plan.
            store.ingestSession(planIngest(mkLegacy("lane-a", [msg(0), msg(1)])));
            store.setSessionExt("lane-a", "inc:base-seq", 2);
            store.ingestSession(planIngest(mkLegacy("lane-a", [msg(2)])), { completeLog: true });
            assert.deepEqual(store.getMessages("lane-a").map((r) => r.msgId), ["h_msg0", "h_msg1", "h_msg2"], "lane rows survive the sweep");
            // Control: without a lane marker the #3285 sweep still applies.
            store.ingestSession(planIngest(mkLegacy("plain-b", [msg(0), msg(1)])));
            store.ingestSession(planIngest(mkLegacy("plain-b", [msg(2)])), { completeLog: true });
            assert.deepEqual(store.getMessages("plain-b").map((r) => r.msgId), ["h_msg2"], "non-lane foreign rows swept");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});
