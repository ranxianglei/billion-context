import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnifiedStore, type IngestSessionInput, type SessionRow } from "../src/storage/store.ts";
import { identityOfStoredContent } from "../src/storage/identity.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy"; // hermetic tier baseline; tests drive UnifiedStore directly
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-4793-cfg-")), "no-config.json");

/**
 * #4793: UNIQUE(session_id, msg_id, content_hash) spans ALL rows including
 * retired ones. When a session's history contains an OLD GENERATION of a
 * message (same msg_id) that already holds the exact bytes the full-ingest
 * plan is about to adopt at its identity-matched seq — e.g. a row stamped
 * with an EMPTY identity by a pre-#4390 build — remapPlanToAbsolute's
 * adopting UPDATE throws and rolls back the entire ingest; three such throws
 * trip the shadow's process-wide 3-strike disable and every other session's
 * index degrades to JSON ("SQLite storage degraded" banner). Single instance,
 * one stuck session, reproducible (issue #4793).
 *
 * The fix clears byte-identical blockers before the adopting UPDATE: live
 * siblings are retired (same CAS blob ⇒ no information lost), retired
 * duplicates are dropped outright. The adopting row keeps its stable seq
 * (#4390 D4-1).
 */

const X = "msg-x-4793";
// Same logical message, different position stamp → SAME identity, different
// content_hash. This is exactly what makes the identity join pick seq 0 while
// a sibling still owns the target bytes.
const G1 = JSON.stringify({ id: X, role: "user", contentType: "text", text: "payload", wireIndex: 1 });
const G2 = JSON.stringify({ id: X, role: "user", contentType: "text", text: "payload", wireIndex: 2 });
const H2 = sha256Hex(G2);

function mkSessionRow(id: string): SessionRow {
    return {
        sessionId: id,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        nextBlockId: 0,
        nextRunId: 0,
        metaJson: "{}",
        statsJson: "{}",
        metadataJson: "{}",
        kstateJson: "{}",
        tailJson: "{}",
        ccrJson: "null",
    };
}

function fullInput(id: string, content: string): IngestSessionInput {
    return {
        session: mkSessionRow(id),
        messages: [{
            seq: 0,
            msgId: X,
            ref: null,
            refNum: 1,
            role: "user",
            kind: "text",
            content,
            contentHash: sha256Hex(content),
            identity: identityOfStoredContent(content),
        }],
        blocks: [],
        deadRefs: [],
        refs: [],
        ccrEntries: [],
        pluginSnapshotSeqs: [],
        tailSeqs: [],
    };
}

interface Fixture {
    dbPath: string;
    sessionId: string;
    openStore(): UnifiedStore;
    rawInsert(opts: { hash: string; bytes: string; retiredAt: number | null }): void;
    closeAll(): void;
}

function openFixture(sessionId: string): Fixture {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-4793-"));
    const dbPath = path.join(dir, "index.db");
    // Seed generation 1 through the normal path so the session row + seq 0
    // exist exactly as a first save would have left them.
    const seed = UnifiedStore.open(dbPath);
    seed.ingestSession(fullInput(sessionId, G1));
    seed.close();

    const handles: { close?: () => void }[] = [];
    const openedRaw = openSqliteDatabase(dbPath, "node:sqlite");
    const raw = openedRaw.db as unknown as { prepare(sql: string): { run(...args: unknown[]): unknown }; close?(): void };
    handles.push(raw);
    return {
        dbPath,
        sessionId,
        openStore() {
            const s = UnifiedStore.open(dbPath);
            handles.push(s);
            return s;
        },
        rawInsert(opts) {
            raw.prepare("INSERT INTO content (hash, byte_len, algo, bytes, refcount) VALUES (?, ?, 'sha256', ?, 1)").run(opts.hash, Buffer.byteLength(opts.bytes), Buffer.from(opts.bytes));
            raw.prepare("INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at) VALUES (?, 1, ?, NULL, 2, 'user', 'text', ?, ?, ?)").run(sessionId, X, opts.hash, "", opts.retiredAt);
        },
        closeAll() {
            for (const h of [...handles].reverse()) { try { h.close?.(); } catch { /* no-op */ } }
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

test("#4793: LIVE sibling holds the target bytes → retired before the adopting UPDATE, ingest succeeds", () => {
    const fx = openFixture("u4793-live");
    try {
        // Pre-#4793 shape of the real incident: same msg_id row holding G2's
        // bytes with an EMPTY identity stamp (older build era), still live.
        fx.rawInsert({ hash: H2, bytes: G2, retiredAt: null });

        const store = fx.openStore();
        const ok = store.ingestSession(fullInput(fx.sessionId, G2));
        assert.ok(ok === true || ok === undefined, `ingest must not fail on the collision class, got ${String(ok)}`);

        const rows = store.getMessages(fx.sessionId);
        assert.equal(rows.length, 1, "exactly one live row survives");
        assert.equal(rows[0].seq, 0, "the identity-joined stable seq is kept");
        assert.equal(rows[0].contentHash, H2, "the row adopts the fresher bytes");
        // The #4390 historian sweep may already have retired the empty-
        // identity sibling before the repairs loop ran; either way it must
        // not remain LIVE under the same msg_id + target hash.
        const all = store.getMessages(fx.sessionId, { includeRetired: true });
        const sib = all.find((r) => r.seq === 1);
        assert.equal(sib?.contentHash, undefined, "byte-identical live sibling is gone");
        if (sib !== undefined) {
            assert.ok(sib.retiredAt !== null, "a surviving duplicate carries a retire tombstone");
        }
    } finally {
        fx.closeAll();
    }
});

test("#4793: RETIRED duplicate holds the target bytes → constraint still spans it → dropped outright", () => {
    const fx = openFixture("u4793-dead");
    try {
        fx.rawInsert({ hash: H2, bytes: G2, retiredAt: Date.now() });

        const store = fx.openStore();
        const ok = store.ingestSession(fullInput(fx.sessionId, G2));
        assert.ok(ok === true || ok === undefined, `ingest must not fail on the collision class, got ${String(ok)}`);

        const rows = store.getMessages(fx.sessionId, { includeRetired: true });
        assert.equal(rows.length, 1, "the retired byte-identical duplicate is dropped");
        assert.equal(rows[0].seq, 0);
        assert.equal(rows[0].contentHash, H2);
    } finally {
        fx.closeAll();
    }
});

test("#4793 regression guard: plain repair (no sibling holder) converges and re-ingest stays idempotent", () => {
    const fx = openFixture("u4793-plain");
    try {
        const G3 = JSON.stringify({ id: X, role: "user", contentType: "text", text: "payload", wireIndex: 99 });
        const store = fx.openStore();
        assert.ok(store.ingestSession(fullInput(fx.sessionId, G3)));
        let rows = store.getMessages(fx.sessionId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].seq, 0);
        assert.equal(rows[0].contentHash, sha256Hex(G3));
        // Same plan again: pure no-op.
        assert.ok(store.ingestSession(fullInput(fx.sessionId, G3)));
        rows = store.getMessages(fx.sessionId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].contentHash, sha256Hex(G3));
    } finally {
        fx.closeAll();
    }
});
