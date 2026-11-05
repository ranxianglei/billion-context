/**
 * #4390: storage foundation defects found by the five-dimension review.
 * Stakes FIRST (RED on master), then the fixes:
 *   S1  identity must not include position metadata — a client head-truncation
 *       (wireIndex shift) must NOT re-mint rows/seqs for surviving messages.
 *   S2  the authoritative-set sweep must RETIRE (tombstone) absent rows
 *       instead of DELETE-ing them; a rewind-redo reactivates the SAME seq.
 *   S3  snapshot-render seam fingerprints must hash image bytes, not length:
 *       same-length different images must NOT match; identical images MUST.
 *   S4  fork lineage (metadata.derivedFromSessionId) must land in the
 *       sessions row instead of being dropped (dead columns).
 *   S5  schema migration backfills the identity column and heals
 *       wireIndex-split duplicate generations, preserving survivor seqs.
 *   S6  gc(vacuum:'full') must delegate to vacuum() (wal_checkpoint TRUNCATE).
 *   S7  loadLegacyView must REPORT tail pointer gaps instead of silently
 *       shrinking the tail view.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createInitialState } from "acp-kernel";
import { planIngest, loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { identitySigForTest } from "../src/server/snapshot-render.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_CONFIG_FILE = join(mkdtempSync(join(tmpdir(), "p2s-")), "missing.json");

/** CoreMessage-shaped fixture; wireIndex simulates the positional metadata the
 *  wire codecs stamp on every parse (the D4-1 pollutant). */
function wmsg(id: string, text: string, wireIndex: number) {
    return { id, role: "user", contentType: "text", text, wireIndex };
}

function histLike(id: string, requests: number, msgs: { id: string; text: string; wireIndex: number }[], parent?: string): LegacySessionLike {
    const state = { ...createInitialState(), requests };
    state.nextBlockId = 1;
    return {
        id,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        meta: { label: id, protocol: "anthropic", upstreamOrigin: "https://api.anthropic.com" },
        stats: { requests },
        metadata: parent ? { pluginAgent: "proxy", derivedFromSessionId: parent } : { pluginAgent: "proxy" },
        state: state as never,
        blockContents: new Map() as never,
        lastMessages: msgs.map((m) => wmsg(m.id, m.text, m.wireIndex)) as never,
        lastMessagesFolded: false,
    };
}

type Row = { seq: number; msg_id: string; content_hash: string; identity: string; retired_at: number | null };

function rowsOf(store: UnifiedStore, sessionId: string): Row[] {
    const db = (store as unknown as { db: { prepare: (q: string) => { all: (...a: unknown[]) => unknown[] } } }).db;
    return db
        .prepare("SELECT seq, msg_id, content_hash, identity, retired_at FROM messages WHERE session_id = ? ORDER BY seq")
        .all(sessionId) as Row[];
}

function liveOf(store: UnifiedStore, sessionId: string): string[] {
    // getMessages is the unified replay surface — after the fix it filters retired rows.
    return store
        .getMessages(sessionId)
        .map((r) => (JSON.parse(r.content as unknown as string) as { id?: string }).id ?? "?");
}

test("S1+S2: head truncation keeps identities/seqs stable; sweep retires (not deletes); rewind-redo reactivates the same seq", () => {
    const dir = mkdtempSync(join(tmpdir(), "s1-"));
    try {
        const store = UnifiedStore.open(join(dir, "index.db"));
        const msgs = [
            { id: "id-a", text: "alpha", wireIndex: 0 },
            { id: "id-b", text: "bravo", wireIndex: 1 },
            { id: "id-c", text: "charlie", wireIndex: 2 },
            { id: "id-d", text: "delta", wireIndex: 3 },
            { id: "id-e", text: "echo", wireIndex: 4 },
        ];
        store.ingestSession(planIngest(histLike("s12", 10, msgs)), undefined, { completeLog: true });
        const seq1 = new Map(rowsOf(store, "s12").map((r) => [r.msg_id, r.seq]));
        assert.equal(seq1.size, 5);

        // Client truncated the first message → the re-parse shifts every
        // surviving wireIndex down by one. Same ids, same content, new wire
        // positions. Old behavior: whole row generation re-minted.
        const truncated = msgs.slice(1).map((m, i) => ({ ...m, wireIndex: i }));
        store.ingestSession(planIngest(histLike("s12", 11, truncated)), undefined, { completeLog: true });

        const rows2 = rowsOf(store, "s12");
        // b..e survive at their ORIGINAL seqs (identity ignores wireIndex).
        for (const m of truncated) {
            const row = rows2.find((r) => r.msg_id === m.id);
            assert.ok(row, `row for ${m.id} exists`);
            assert.equal(row.seq, seq1.get(m.id), `${m.id} keeps its save-1 seq (identity stability, #4390)`);
        }
        // a is RETIRED (tombstoned), not deleted — the historian keeps the bytes.
        const a2 = rows2.find((r) => r.msg_id === "id-a");
        assert.ok(a2, "retired row for id-a still exists (tombstone, #4390)");
        assert.notEqual(a2.retired_at, null, "id-a is retired");
        // And no duplicate generation was minted for the survivors.
        assert.equal(rows2.length, 5, "no re-minted rows (5 originals: 4 live + 1 retired)");
        assert.deepEqual(liveOf(store, "s12"), ["id-b", "id-c", "id-d", "id-e"]);

        // Rewind-redo: the truncated head comes back. Same identity → same seq.
        store.ingestSession(planIngest(histLike("s12", 12, msgs)), undefined, { completeLog: true });
        const rows3 = rowsOf(store, "s12");
        assert.equal(rows3.length, 5, "still 5 rows after redo");
        const a3 = rows3.find((r) => r.msg_id === "id-a")!;
        assert.equal(a3.retired_at, null, "id-a reactivated");
        assert.equal(a3.seq, seq1.get("id-a"), "id-a reactivated at its ORIGINAL seq");
        assert.deepEqual(liveOf(store, "s12"), ["id-a", "id-b", "id-c", "id-d", "id-e"]);
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("S3: seam fingerprint hashes image bytes, not their length (#4390)", () => {
    const base = (byte: number, n: number) => Buffer.alloc(n, byte).toString("base64");
    const sameLen = base(1, 4096);
    const sameLen2 = base(2, 4096);
    const mk = (b64: string) => ({ role: "user", contentType: "image", text: "[image]", imagePart: true, imageBase64: b64 }) as never;
    // Different content, identical length → signatures MUST differ.
    assert.notEqual(identitySigForTest(mk(sameLen)), identitySigForTest(mk(sameLen2)), "same-length different images must not collide");
    // Identical content → identical signature (seam chaining works).
    assert.equal(identitySigForTest(mk(sameLen)), identitySigForTest(mk(sameLen)));
    // And a different-length crop of the SAME image stays a different sig from its parent.
    assert.notEqual(identitySigForTest(mk(base(1, 2048))), identitySigForTest(mk(base(1, 4096))));
});

test("S4: fork lineage lands in the sessions row (parent_session_id)", () => {
    const plan = planIngest(histLike("child-1", 5, [{ id: "id-a", text: "hi", wireIndex: 0 }], "parent-9"));
    const row = plan.session as unknown as { parentSessionId: string | null };
    assert.equal(row.parentSessionId, "parent-9", "metadata.derivedFromSessionId must reach the unified row (#4390)");
    const noParent = planIngest(histLike("plain-1", 5, [{ id: "id-a", text: "hi", wireIndex: 0 }]));
    assert.equal((noParent.session as unknown as { parentSessionId: string | null }).parentSessionId, null);
});

test("S5: v8 migration backfills identity and heals wireIndex-split generations", () => {
    const dir = mkdtempSync(join(tmpdir(), "s5-"));
    try {
        // 1. Write rows with the CURRENT code (post-fix schema v8).
        const store = UnifiedStore.open(join(dir, "index.db"));
        store.ingestSession(planIngest(histLike("mig", 3, [
            { id: "id-a", text: "alpha", wireIndex: 0 },
            { id: "id-b", text: "bravo", wireIndex: 1 },
        ])), undefined, { completeLog: true });
        // Simulate a PRE-v8 database: the split-generation bug already
        // happened historically — id-b re-minted at a later seq with a
        // shifted wireIndex inside its content bytes, identity column empty.
        const db = (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown }; exec: (q: string) => void } }).db;
        const dupContent = JSON.stringify(wmsg("id-b", "bravo", 9));
        // The dup generation carries its own CAS bytes under its own hash
        // (the polluted formula minted a different content_hash too).
        const dupBuf = Buffer.from(dupContent, "utf8");
        db.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES ('legacy-dup-hash', ?, 1, 'sha256', ?)").run(dupBuf.byteLength, dupBuf);
        db.prepare(
            "INSERT INTO messages (session_id, seq, msg_id, ref, role, kind, content_hash, identity) VALUES (?, 2, 'id-b', NULL, 'user', 'text', 'legacy-dup-hash', '')",
        ).run("mig");
        // Reset to pre-v8 shape: version 7 + empty identity on every row.
        db.exec("UPDATE messages SET identity = ''");
        db.exec("PRAGMA user_version = 7");
        store.close();

        // 2. Reopen — the v7→v8 migration must backfill identity from content
        //    bytes (id/wireIndex stripped) and dedupe split generations,
        //    keeping the ORIGINAL arrival (lowest seq).
        const reopened = UnifiedStore.open(join(dir, "index.db"));
        const rows = rowsOf(reopened, "mig");
        assert.equal(rows.length, 2, "split generation healed (dup removed)");
        const b = rows.find((r) => r.msg_id === "id-b")!;
        assert.equal(b.seq, 1, "survivor keeps the original arrival seq");
        assert.ok(b.identity.length >= 16, "identity backfilled");
        // Backfilled identity must match what the live intern computes for
        // the same message regardless of wireIndex position.
        const store2 = UnifiedStore.open(join(dir, "second.db"));
        try {
            store2.ingestSession(planIngest(histLike("mig2", 3, [{ id: "id-b", text: "bravo", wireIndex: 42 }])));
            const live = rowsOf(store2, "mig2").find((r) => r.msg_id === "id-b")!;
            assert.equal(live.identity, b.identity, "backfilled identity equals live-computed identity (wireIndex-independent)");
        } finally {
            store2.close();
        }
        reopened.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("S6: gc full vacuum delegates to vacuum() (wal_checkpoint TRUNCATE included)", () => {
    const dir = mkdtempSync(join(tmpdir(), "s6-"));
    try {
        const store = UnifiedStore.open(join(dir, "index.db"));
        store.ingestSession(planIngest(histLike("gcv", 2, [{ id: "id-a", text: "x", wireIndex: 0 }])));
        const calls: string[] = [];
        (store as unknown as { vacuum: (m: string) => void }).vacuum = (m: string) => { calls.push(m); };
        store.gc({ archiveAfterDays: 0, archiveDir: join(dir, "arch"), vacuum: "full" });
        assert.deepEqual(calls, ["full"], "gc must route through vacuum() so the TRUNCATE checkpoint runs (#4390)");
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("S7: loadLegacyView reports tail pointer gaps instead of silently shrinking", () => {
    const core = { id: "id-a", role: "user", contentType: "text", text: "alpha" };
    const out = loadLegacyView({
        session: {
            sessionId: "gap",
            createdAt: 1,
            updatedAt: 2,
            nextBlockId: 1,
            nextRunId: 1,
            metaJson: "{}",
            statsJson: "{}",
            metadataJson: "{}",
            kstateJson: JSON.stringify(createInitialState()),
            tailJson: JSON.stringify({ pluginSnapshotSeqs: null, tailSeqs: [0, 7, 8], tailFolded: false }),
            ccrJson: null,
            orphansJson: null,
        },
        messages: [
            { seq: 0, msgId: "id-a", ref: null, content: JSON.stringify(core) },
            { seq: 8, msgId: "id-b", ref: null, content: JSON.stringify({ ...core, id: "id-b", text: "b" }) },
        ],
        blocks: [],
        deadRefs: [],
        refs: [],
    });
    // seq 7 is pointed at but missing → must be REPORTED (and the tail keeps
    // its surviving members rather than pretending nothing happened).
    assert.equal(out.lastMessages!.length, 2);
    assert.equal((out as unknown as { tailGaps?: number }).tailGaps, 1, "missing tail rows must be counted, not swallowed (#4390)");
});

// keep the hash import honest for fixtures that grow media later
void createHash;
