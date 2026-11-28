/**
 * #7577 (b): tsStamps for egress-on sessions is NOT persisted (the write path
 * trims it — ingest.ts KSTATE_TRIM_FIELDS) and is DERIVED from the live egress
 * view on load (store.egressTsStamps, wired in shadow.viewFor). The I row's
 * msgid IS the kernel raw message id and its ts is the first-observed wall
 * clock, so the derivation reproduces the stamp map the kernel needs to
 * re-render <acp time=> attributes after a restart.
 *
 * Pinned contract:
 *   - live view msgid→ts map, byte values verbatim;
 *   - folded (deleted) messages drop out — they are not rendered, so no stamp;
 *   - no egress rows (egress-off session) → null, never a fabricated map;
 *   - corrupt log → null, never a throw into the load path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { UnifiedStore } from "../src/storage/store.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-kstate-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

function openStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-kstate-"));
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const db = (store as unknown as { db: ReturnType<typeof openSqliteDatabase>["db"] }).db;
    migrateSchema(db);
    return { store, db, dir };
}

function closeH(h: { store: UnifiedStore; dir: string }): void {
    h.store.close();
    try {
        fs.rmSync(h.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* leaked temp dir is harmless */ }
}

test("egressTsStamps derives the live view's msgid→ts map verbatim", () => {
    const h = openStore();
    try {
        const sid = "egress-on-session";
        h.store.egressAppendTurn(sid, [
            { type: "I", rid: 1, msgid: "rawA", after: null, ref: "m00001", tokens: 3, typeTag: "text", bytes: "hello", ts: 1_730_000_000_000 },
        ], 0, 1_730_000_000_000);
        h.store.egressAppendTurn(sid, [
            { type: "I", rid: 2, msgid: "rawB", after: 1, ref: "m00002", tokens: 4, typeTag: "text", bytes: "there", ts: 1_730_000_001_500 },
        ], 1, 1_730_000_001_500);
        assert.deepEqual(h.store.egressTsStamps(sid), {
            rawA: 1_730_000_000_000,
            rawB: 1_730_000_001_500,
        });
    } finally { closeH(h); }
});

test("folded messages drop out of the derived stamps (they are not rendered)", () => {
    const h = openStore();
    try {
        const sid = "egress-on-fold";
        h.store.egressAppendTurn(sid, [
            { type: "I", rid: 1, msgid: "rawA", after: null, ref: "m00001", tokens: 3, typeTag: "text", bytes: "hello", ts: 1_730_000_000_000 },
            { type: "I", rid: 2, msgid: "rawB", after: 1, ref: "m00002", tokens: 4, typeTag: "text", bytes: "there", ts: 1_730_000_001_500 },
        ], 0, 1_730_000_001_500);
        // fold both away (compaction in the same write)
        h.store.egressAppendTurn(sid, [
            { type: "D", start: 1, end: 2 },
        ], 2, 1_730_000_010_000);
        // nothing live left → null, not {} and not the folded stamps
        assert.equal(h.store.egressTsStamps(sid), null);
        // a message that survived the fold keeps its birth stamp
        // (the D turn consumed op 3 — 7773 has no in-step compaction row)
        h.store.egressAppendTurn(sid, [
            { type: "I", rid: 3, msgid: "rawC", after: null, ref: "m00003", tokens: 5, typeTag: "text", bytes: "survivor", ts: 1_730_000_012_000 },
        ], 3, 1_730_000_012_000);
        assert.deepEqual(h.store.egressTsStamps(sid), { rawC: 1_730_000_012_000 });
    } finally { closeH(h); }
});

test("a session without egress rows (egress-off) derives null, never a map", () => {
    const h = openStore();
    try {
        assert.equal(h.store.egressTsStamps("never-recorded"), null);
    } finally { closeH(h); }
});

test("a corrupt egress log derives null — it never throws into the load path", () => {
    const h = openStore();
    try {
        const sid = "egress-on-corrupt";
        h.store.egressAppendTurn(sid, [
            { type: "I", rid: 1, msgid: "rawA", after: null, ref: "m00001", tokens: 3, typeTag: "text", bytes: "hello", ts: 1_730_000_000_000 },
        ], 0, 1_730_000_000_000);
        // damage the log so the serving read goes to the rebuild path and
        // the rebuild replay meets the damaged row: a structurally stray
        // state row (pos density breaks) + an unreplayable flow payload
        h.db.prepare(`INSERT INTO eg_state (session_id, rid, msgid, pos, log_seq, num, ref, tokens, type, role, ts, sys_in, bytes, created_at) VALUES (?, 99, 'ghost', 99, 0, 0, '', 0, 'text', 'user', 0, 0, 'x', 9)`).run(sid);
        h.db.prepare(`UPDATE eg_flow SET payload = 'not-json' WHERE session_id = ? AND row_type = 'I'`).run(sid);
        assert.equal(h.store.egressTsStamps(sid), null);
    } finally { closeH(h); }
});
