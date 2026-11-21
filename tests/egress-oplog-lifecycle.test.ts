/**
 * Egress op-log lifecycle (proposal discussions/7398, #6785 perf work;
 * #7439 ruling 1: self-contained bytes). Pinned contract:
 *   1. buildEgressViewRows produces SELF-CONTAINED rows — the message bytes
 *      ride the row inline (no content-CAS hash/ref), so the op-log has zero
 *      cross-table pointers into the (now stale) content table.
 *   2. deleteSession cascades egress_state/egress_flow — the cascade must
 *      list the two op-log tables, so a recorded session does not orphan its
 *      op log forever. (With self-contained bytes there is no CAS body to
 *      release — the rows carry their own bytes.)
 * Both directions asserted (#3617): the rows DO carry bytes AND carry no CAS
 * ref.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteDatabase } from "../src/storage/driver.js";
import { migrateSchema } from "../src/storage/schema.js";
import { egressStateAppend } from "../src/storage/egress-state.js";
import { buildEgressViewRows } from "../src/storage/egress-record.js";
import { UnifiedStore } from "../src/storage/store.js";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = mkdtempSync(join(tmpdir(), "bili-egress-lifecycle-hermetic-"));
process.env.BILI_CONFIG_FILE = join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const M = (id: string, text: string, role: string = "user") => ({ id, role, contentType: "text", text });

test("buildEgressViewRows produces self-contained rows (bytes inline, no CAS ref)", () => {
    const conv = [M("m1", "alpha"), M("m2", "beta")];
    const rows = buildEgressViewRows(conv, "sys");
    // system row + two message rows
    assert.equal(rows.length, 3);
    for (const r of rows) {
        assert.equal(typeof r.bytes, "string", `row ${r.msgid} carries inline bytes`);
        assert.ok(r.bytes.length > 0, `row ${r.msgid} bytes are non-empty`);
        // #7439 ruling 1: NO content-CAS hash/ref on the row
        assert.equal("contentHash" in r, false, "no contentHash field");
        assert.equal("casRef" in r, false, "no casRef field");
    }
    // the message bytes are the FINAL core JSON — they round-trip to the message
    const m1 = JSON.parse(rows[1].bytes) as { id: string; text: string };
    assert.equal(m1.id, "m1");
    assert.equal(m1.text, "alpha");
});

test("deleteSession cascades egress_state/egress_flow (self-contained bytes, no CAS release)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-egress-lifecycle-"));
    let store: UnifiedStore | undefined;
    try {
        store = UnifiedStore.open(join(dir, "index.db"));
        const db = (store as unknown as { db: ReturnType<typeof openSqliteDatabase>["db"] }).db;
        migrateSchema(db);
        const sid = "sess-egress-cascade";

        // #7439 ruling 1: the ops carry the message BYTES inline (no CAS ref)
        egressStateAppend(db, sid, [
            { type: "I", msgid: "m1", after: null, ref: "", tokens: 5, typeTag: "text", bytes: '{"id":"m1","role":"user","text":"alpha"}', role: "user" },
            { type: "I", msgid: "m2", after: "m1", ref: "", tokens: 5, typeTag: "text", bytes: '{"id":"m2","role":"user","text":"beta"}', role: "user" },
            { type: "D", start: "m1", end: "m1" },
            { type: "U", msgid: "m2", bytes: '{"id":"m2","role":"user","text":"beta2"}', role: "user" },
        ], Date.now());
        const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
        assert.equal(count("egress_state"), 4);
        assert.equal(count("egress_flow"), 4);

        store.deleteSession(sid);

        assert.equal(count("egress_state"), 0, "egress_state rows cascade-deleted");
        assert.equal(count("egress_flow"), 0, "egress_flow rows cascade-deleted");
    } finally {
        // close the store before rmSync — Windows cannot unlink an open SQLite
        // db (EPERM/EBUSY on index.db). Precedent: tests/archive-reference-counts.test.ts.
        store?.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
