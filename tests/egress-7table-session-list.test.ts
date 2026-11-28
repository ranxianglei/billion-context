/** #B4 (KDD#25): a 7-table (egress) instance does NOT create the legacy
 *  `blocks` table. `webSummaryRows()` used to start `WITH bl AS (SELECT … FROM
 *  blocks b)` — on a 7-table store that threw "no such table: blocks", the whole
 *  list crashed into the disk-index walk (unifiedWebSummaries → null), and egress
 *  sessions (no JSON files) were MISSING → the panel showed 0 sessions.
 *
 *  Pinned here (a plain fresh eg instance — egress on, NO forced full DDL, so the
 *  legacy group is absent): an egress session recorded into the store appears in
 *  the web list with `egressRecords > 0`. Pre-fix `unifiedWebSummaries()` returns
 *  null (the blocks CTE throws) and the session is hidden.
 */
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY = "1";
// NOTE: deliberately NO BILI_TEST_FORCE_FULL_DDL — a plain fresh eg instance has
// the 7 egress tables + the identity `sessions` table, but NOT the legacy group
// (the exact shape where the blocks CTE used to crash).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const hermetic = mkdtempSync(join(tmpdir(), "eg7-list-hermetic-"));
process.env.BILI_CONFIG_FILE = join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "full";

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { recordEgressTurn } from "../src/storage/egress-record.ts";

function openStore(dir: string): InstanceType<typeof SessionStore> {
    const s = new SessionStore({ enabled: true, dir, debounceMs: 60000 });
    _setStoreForTest(s);
    return s;
}

const core = (id: string, role: "user" | "assistant", text: string, wireIndex: number) =>
    ({ id, role, content: [{ type: "text", text }], wireIndex, contentType: "text" }) as never;

test("B4: a 7-table egress session appears in the web list (absent blocks table)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eg7-list-"));
    const store = openStore(dir);
    try {
        const st = store.egressOpLogStore()!;
        const sid = "eg7-session-1";
        const now = 1_000_000;
        // identity row → the `sessions` table (the arm-time upsert).
        st.ensureEgressIdentity({
            sessionId: sid, parentSessionId: null, protocol: "openai", label: "cli",
            title: "eg7 title", hostTitle: null, namespace: "proxy", origin: null,
            createdAt: now, updatedAt: now, metaJson: "{}", metadataJson: "{}",
        });
        // one turn → eg_state rows (the non-system rows count as egressRecords).
        recordEgressTurn({
            store: st, sessionId: sid, prev: undefined,
            conversation: [core("u0", "user", "hello", 0), core("a0", "assistant", "hi", 1)],
            systemText: "sys", nowMs: now,
        });

        const rows = store.unifiedWebSummaries();
        assert.ok(Array.isArray(rows), "the list is non-null (pre-fix: 'no such table: blocks' → the whole query throws → null → disk walk)");
        const row = rows!.find((r) => r.sessionId === sid);
        assert.ok(row, "the egress session appears in the list (pre-fix: the disk walk finds no JSON files for an egress session → hidden)");
        assert.equal(row!.title, "eg7 title", "the title is carried from the identity row");
        assert.ok((row!.egressRecords ?? 0) > 0, "the session has egress records (egressRecords > 0 → not an empty stub)");
    } finally {
        _resetStoreForTest();
        store.closeQuietly();
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
