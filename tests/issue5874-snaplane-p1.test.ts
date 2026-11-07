/**
 * #5874 P1 — shadow-write plane: B1 trap nail, A/B shadow comparison,
 * coverage mapping, bounded growth. The plane is shadow-only in this
 * phase: it must agree with the legacy view on every save, and a
 * mismatch or crash gap must degrade (or self-heal) without ever
 * touching what a reader sees.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { readSnapView, snapL1Lookup, _resetSnapPlaneDeadForTests } from "../src/storage/snap.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5874-p1-"));
const configPath = path.join(hermetic, "config.json");
fs.writeFileSync(configPath, "{}");
process.env.BILI_CONFIG_FILE = configPath;

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function openPlane(p: string): UnifiedStore {
    return UnifiedStore.open(p, undefined, { snapBase: { enabled: true, shadowWrite: true } });
}

/** One full-message turn of a legacy session. */
function session(id: string, msgs: Array<{ id: string; text: string; role?: "user" | "assistant" }>): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
        blockContents: new Map(),
        lastMessages: msgs.map((m, i) => ({
            id: m.id,
            role: (m.role ?? (i % 2 === 0 ? "user" : "assistant")) as "user" | "assistant",
            contentType: "text" as const,
            text: m.text,
        })),
        lastMessagesFolded: true,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

/** The store's raw db handle (the plane reads share the store's own
 *  connection for a consistent snapshot). */
function raw(store: UnifiedStore): Parameters<typeof readSnapView>[0] {
    return (store as unknown as { db: Parameters<typeof readSnapView>[0] }).db;
}

// ---------------------------------------------------------------------------
// T3 — the B1 trap nail: l1 identity is issued once, arms on the first echo,
// and survives restarts (the wire re-sends the same identity each turn).
// ---------------------------------------------------------------------------

test("#5874 T3: B1 trap nail — l1 record is stable across restarts", () => {
    _resetSnapPlaneDeadForTests();
    const dir = tmpDir("bili-5874-t3-");
    const p = path.join(dir, "index.db");
    try {
        for (let boot = 0; boot < 3; boot++) {
            const store = openPlane(p);
            // Every "request" re-sends the same full message history (B1):
            // byte-identical wire, so the id space — and the l1 witness —
            // is unchanged across boots. That is exactly the trap the
            // record must survive without re-issuing.
            store.ingestSession(planIngest(session("sess-t3", [{ id: "m1", text: "one" }, { id: "m2", text: "two" }, { id: "m3", text: "three" }])));
            const db = raw(store);
            const rec = snapL1Lookup(db, "sess-t3");
            assert.ok(rec, "l1 record must exist after the first save");
            assert.equal(rec.ledgerId, "sess-t3");
            if (boot === 0) {
                assert.equal(rec.armedAt, null, "the first save ISSUES the identity; arming costs one round");
            } else {
                assert.ok(rec.armedAt !== null, `l1 must be armed by save ${boot} (the wire re-sent the same identity)`);
            }
            const view = readSnapView(db, "sess-t3");
            assert.ok(view?.verified, "the plane must verify after every restart");
            assert.equal(view?.rows.filter((r) => r.active === 1).length, 3, "three live rows");
            store.close();
        }
        // Exactly ONE l1 row — issued once, never re-issued.
        const db = openSqliteDatabase(p).db;
        const count = (db.prepare("SELECT COUNT(*) AS n FROM l1_world").get() as { n: number }).n;
        assert.equal(count, 1, "l1 identity must not multiply across restarts");
        db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// T4 — A/B shadow comparison: after every save the plane's active rows must
// equal the legacy live set (pos-by-pos, byte-for-byte), including the
// crash-gap case (a save the plane never saw must self-heal on the next
// save, because the derivation is a final-state diff).
// ---------------------------------------------------------------------------

test("#5874 T4: the shadow plane tracks the legacy view on every save (incl. crash gap)", () => {
    _resetSnapPlaneDeadForTests();
    const dir = tmpDir("bili-5874-t4-");
    const p = path.join(dir, "index.db");
    const store = openPlane(p);
    try {
        // Save 1: three messages.
        store.ingestSession(planIngest(session("sess-t4", [{ id: "m1", text: "one" }, { id: "m2", text: "two" }, { id: "m3", text: "three" }])));
        assertAbEqual(store, "sess-t4");
        // Save 2: the classic B1 re-send + one new message.
        store.ingestSession(planIngest(session("sess-t4", [{ id: "m1", text: "one" }, { id: "m2", text: "two" }, { id: "m3", text: "three" }, { id: "m4", text: "four" }])));
        assertAbEqual(store, "sess-t4");
        // CRASH GAP: the legacy write of save 3 lands, but the plane never
        // saw it (simulate a crash between the two writes). Until the
        // plane's next save, the view still agrees with what it last
        // committed (4 rows) — and the next save (the wire re-sends the
        // same history, B1) must heal the gap: the derivation is a
        // final-state diff.
        {
            const raw = openSqliteDatabase(p).db;
            const plan = planIngest(session("sess-t4", [{ id: "m1", text: "one" }, { id: "m2", text: "two" }, { id: "m3", text: "three" }, { id: "m4", text: "four" }, { id: "m5", text: "five" }]));
            const s2 = UnifiedStore.open(p); // no plane
            s2.ingestSession(plan);
            s2.close();
            raw.close();
        }
        { const db = raw(store);
          const stale = readSnapView(db, "sess-t4")!.rows.filter((r) => r.active === 1).length;
          assert.equal(stale, 4, "before the next save the plane still shows its last committed state"); }
        store.ingestSession(planIngest(session("sess-t4", [{ id: "m1", text: "one" }, { id: "m2", text: "two" }, { id: "m3", text: "three" }, { id: "m4", text: "four" }, { id: "m5", text: "five" }])));
        assertAbEqual(store, "sess-t4"); // healed by the re-send
        // Save 4: same, still equal.
        store.ingestSession(planIngest(session("sess-t4", [{ id: "m1", text: "one" }, { id: "m2", text: "two" }, { id: "m3", text: "three" }, { id: "m4", text: "four" }, { id: "m5", text: "five" }, { id: "m6", text: "six" }])));
        assertAbEqual(store, "sess-t4");
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function assertAbEqual(store: UnifiedStore, sid: string): void {
    const db = raw(store);
    const view = readSnapView(db, sid);
    assert.ok(view, "plane must be initialized after the first save");
    assert.ok(view.verified, "plane checksum must verify");
    const live = (db.prepare("SELECT m.seq, c.bytes AS bytes FROM messages m JOIN content c ON c.hash = m.content_hash WHERE m.session_id = ? AND m.retired_at IS NULL ORDER BY m.seq").all(sid)) as Array<{ seq: number; bytes: Buffer | Uint8Array }>;
    const active = view.rows.filter((r) => r.active === 1);
    assert.equal(active.length, live.length, `active plane rows (${active.length}) must equal live legacy rows (${live.length})`);
    for (const l of live) {
        const row = active.find((r) => r.pos === l.seq);
        assert.ok(row, `plane row for pos ${l.seq} missing`);
        assert.equal(row.postJson, Buffer.from(l.bytes).toString("utf8"), `pos ${l.seq}: plane post_json must be byte-equal to the legacy content`);
    }
}

// ---------------------------------------------------------------------------
// T7 — the fold coverage mapping: the compacted-away region must be named
// in the checkpoint's meta (summary → covered pos range), and the rows
// stay on disk (double form) until GC.
// ---------------------------------------------------------------------------

test("#5874 T7: a block's covered range lands in the checkpoint coverage map", () => {
    _resetSnapPlaneDeadForTests();
    const dir = tmpDir("bili-5874-t7-");
    const p = path.join(dir, "index.db");
    const store = openPlane(p);
    try {
        const msgs = Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, text: `message ${i + 1}` }));
        // A compression block (through the real ingest path, like a host
        // that re-sends covered history — B1) covers positions 1..8.
        const byRaw: Record<string, string> = {};
        const byRef: Record<string, string> = {};
        msgs.forEach((m, i) => {
            const ref = `m${String(i + 1).padStart(5, "0")}`;
            byRaw[m.id] = ref;
            byRef[ref] = m.id;
        });
        const blk = {
            blockId: "blk-c1",
            runId: 1,
            createdAt: 1_000,
            tier: 1,
            active: true,
            summary: "folded 1-8",
            kind: "fold",
            reason: "test",
            effectiveMessageIds: msgs.slice(0, 8).map((m) => m.id),
            directMessageIds: [] as string[],
        };
        const sess: LegacySessionLike = {
            id: "sess-t7",
            createdAt: 1_000,
            lastSeen: 2_000,
            meta: { protocol: "openai" },
            stats: { requests: 1 },
            metadata: {},
            state: { blocks: [blk as never], nextBlockId: 2, nextRunId: 2, messageRefs: { byRaw, byRef } },
            blockContents: new Map(),
            lastMessages: msgs.map((m, i) => ({ id: m.id, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: m.text })),
            lastMessagesFolded: false,
            pluginSnapshot: undefined,
            contentStore: undefined,
        };
        // One save: the derivation flips the covered rows compact and the
        // compact-triggered fold must name the range in the ckpt meta.
        store.ingestSession(planIngest(sess));
        const db = raw(store);
        const ckpt = db.prepare("SELECT meta_json FROM snap_ckpt WHERE sid = 'sess-t7'").get() as { meta_json: string };
        assert.ok(ckpt, "a checkpoint must exist after the compact fold");
        const meta = JSON.parse(ckpt.meta_json) as { coverage: Array<[string, number, number]>; s4: string; kstate: string | null };
        // seqs are 0-based (planIngest's first-seen order), so m1..m8 = pos 0..7.
        assert.deepEqual(meta.coverage, [["blk-c1", 0, 7]], "coverage map must name the block's exact range");
        assert.ok(meta.s4, "the S4 aggregate lives in the ckpt");
        // The covered rows are STILL on disk (invariant iv) but inactive.
        const rows = db.prepare("SELECT pos, active, cover_ref FROM snap_rows WHERE sid = 'sess-t7' ORDER BY pos").all() as Array<{ pos: number; active: number; cover_ref: string | null }>;
        for (const r of rows.slice(0, 8)) {
            assert.equal(r.active, 0, `pos ${r.pos} must be compacted away`);
            assert.equal(r.cover_ref, "blk-c1");
        }
        for (const r of rows.slice(8)) {
            assert.equal(r.active, 1, `pos ${r.pos} must survive`);
        }
        // The read-side view verifies even though 8 rows are covered.
        const view = readSnapView(db, "sess-t7");
        assert.ok(view?.verified);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// T9 — bounded growth: N full saves (B1 re-sends) must not grow the plane
// unboundedly — log depth folds at the threshold, rows stay O(pos).
// ---------------------------------------------------------------------------

test("#5874 T9: growth is bounded under continuous B1 re-sends", () => {
    _resetSnapPlaneDeadForTests();
    const dir = tmpDir("bili-5874-t9-");
    const p = path.join(dir, "index.db");
    const store = openPlane(p);
    const N = 40; // 40 full saves over a 12-message session
    try {
        const base = Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, text: `message ${i + 1}` }));
        for (let i = 0; i < N; i++) {
            const msgs = i === 0 ? base : [...base, { id: `x${i}`, text: `extra ${i}` }];
            store.ingestSession(planIngest(session("sess-t9", msgs)));
            const db = raw(store);
            const depth = (db.prepare("SELECT COUNT(*) AS n FROM snap_log WHERE sid = 'sess-t9'").get() as { n: number }).n;
            assert.ok(depth <= 256, `log depth ${depth} must stay bounded (got > 256)`);
        }
        const db = raw(store);
        const rows = (db.prepare("SELECT COUNT(*) AS n FROM snap_rows WHERE sid = 'sess-t9'").get() as { n: number }).n;
        assert.ok(rows <= 12 + N, `rows (${rows}) must stay O(pos), not O(saves)`);
        const view = readSnapView(db, "sess-t9");
        assert.ok(view?.verified, "the plane must still verify after all folds");
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
