/**
 * Egress op-log lifecycle fixes found while writing the PR #6785 report
 * (docs/pr-6785-unified-storage-and-flows.md §5.3):
 *   1. buildEgressViewRows must REUSE the previous turn's casRef for an
 *      unchanged row instead of putContent-ing the same CAS body again —
 *      putContent refcount-bumps on hit, so the old code inflated every
 *      row's refcount by +1/turn with the only release at the session sweep
 *      (storage-only-grows). Pinned: turn 2 unchanged = 0 puts; turn 3 with
 *      one edit + one append = exactly 2 puts.
 *   2. deleteSession must cascade-delete egress_state/egress_flow (and
 *      release their CAS refs) — the old cascade listed every v12 table
 *      except the two op-log tables, so recorded sessions orphaned the op
 *      log + its CAS bodies forever.
 * Both directions asserted (#3617): the put IS skipped on reuse AND still
 * happens when the content changes / the row is new.
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

test("buildEgressViewRows reuses the prev casRef for unchanged rows (no putContent re-bump)", () => {
    const puts: string[] = [];
    const cas = { put: (t: string) => { puts.push(t); return `cas-${puts.length}`; } };
    const conv = [M("m1", "alpha"), M("m2", "beta")];
    const t1 = buildEgressViewRows(conv, "sys", cas);
    assert.equal(puts.length, 3); // system row + every first-seen message row

    const t2 = buildEgressViewRows(conv, "sys", cas, t1);
    assert.equal(puts.length, 3); // unchanged rows (incl. system) reuse casRefs — ZERO new puts
    for (const r of t2) assert.ok(r.casRef, "reused rows keep their casRef");

    // a content edit and a new row both put fresh
    const t3 = buildEgressViewRows([M("m1", "alpha!"), M("m2", "beta"), M("m3", "gamma")], "sys", cas, t2);
    assert.equal(puts.length, 5);
    assert.equal(t3[0].casRef, t2[0].casRef, "system block unchanged → reused");
    assert.notEqual(t3[1].casRef, t2[1].casRef, "edited m1 → fresh put");
    assert.equal(t3[2].casRef, t2[2].casRef, "unchanged m2 → reused");
    assert.ok(t3[3].casRef && t3[3].casRef.startsWith("cas-5"), "new m3 → fresh put");
});

test("deleteSession cascades egress_state/egress_flow and releases their CAS refs", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-egress-lifecycle-"));
    try {
        const store = UnifiedStore.open(join(dir, "index.db"));
        const db = (store as unknown as { db: ReturnType<typeof openSqliteDatabase>["db"] }).db;
        migrateSchema(db);
        const sid = "sess-egress-cascade";

        const h1 = store.egressPutContent('{"id":"m1","role":"user","text":"alpha"}');
        const h2 = store.egressPutContent('{"id":"m2","role":"user","text":"beta"}');
        egressStateAppend(db, sid, [
            { type: "I", msgid: "m1", after: null, ref: "", tokens: 5, typeTag: "text", contentHash: "a", role: "user", casRef: h1 },
            { type: "I", msgid: "m2", after: "m1", ref: "", tokens: 5, typeTag: "text", contentHash: "b", role: "user", casRef: h2 },
            { type: "D", start: "m1", end: "m1" },
            { type: "U", msgid: "m2", contentHash: "b2", role: "user", casRef: h2 },
        ], Date.now());
        const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
        assert.equal(count("egress_state"), 4);
        assert.equal(count("egress_flow"), 4);

        store.deleteSession(sid);

        assert.equal(count("egress_state"), 0, "egress_state rows cascade-deleted");
        assert.equal(count("egress_flow"), 0, "egress_flow rows cascade-deleted");
        const gone = (h: string) => (db.prepare("SELECT count(*) AS n FROM content WHERE hash = ?").get(h) as { n: number }).n;
        assert.equal(gone(h1), 0, "egress CAS body released to zero and collected");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
