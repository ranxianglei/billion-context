/**
 * #6785 step 8 — the frozen state_fields field set, pinned (± #3617 gate
 * discipline). src/storage/slim.ts ROW_BACKED_KSTATE_FIELDS is a READ-PATH
 * decision: the LegacyView builder must know which kstate fields are
 * row-backed, so adding/removing one here silently changes what the column
 * carries on old rows. This test pins:
 *   T1 the exact 9-field set (list equality — a drift is a red build, not a
 *      quiet column/row repartition);
 *   T2 all nine fields round-trip through planIngest → state_fields rows →
 *      loadLegacyView with their values byte-intact;
 *   T3 steady state: an unchanged re-ingest rewrites zero state_fields rows
 *      (applyStateFields compares value_json per row, like the store slim skip).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import { COMPRESSION_STATE_FIELDS, mergeState } from "../src/state-hydration.js";
import { planIngest, loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.js";
import { ROW_BACKED_KSTATE_FIELDS, splitKstate } from "../src/storage/slim.js";
import { openSqliteDatabase } from "../src/storage/driver.js";
import { UnifiedStore } from "../src/storage/store.js";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_CONFIG_FILE = join(mkdtempSync(join(tmpdir(), "sf-pin-")), "missing.json");

/** Every row-backed field DEFINED with a non-empty representative value. */
function fullState(): Record<string, unknown> {
    return {
        ...createInitialState(),
        tokenSnapshot: { "m00003": 1234 },
        tsStamps: { "m00004": 1731000000000 },
        lastPassIds: ["m00005", "m00006"],
        hiddenOrphanRefs: ["m00007"],
        sweptOrphanCallIds: ["tc_1"],
        renderDeferredRefs: ["m00008"],
        viewLatches: { m00009: { text: "latched", hidden: true } },
        absorbed: [
            { toolCallId: "tc_2", callMessageId: "m00010", resultMessageId: "m00011", summary: "did the thing", tokensReclaimed: 42, createdAt: 1731000001000 },
        ],
        rules: [{ id: "r1", text: "always run the tests" }],
    };
}

function session(state: Record<string, unknown>): LegacySessionLike {
    return {
        id: "sf-pin",
        createdAt: 1000,
        lastSeen: 2000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: state as never,
        blockContents: new Map(),
        lastMessages: [{ id: "m1", role: "user", contentType: "text", text: "hi" }],
        lastMessagesFolded: true,
    } as LegacySessionLike;
}

test("T1: ROW_BACKED_KSTATE_FIELDS is exactly the nine frozen fields, and every one is in the derived merge list", () => {
    // The frozen set — a change here is a read-path decision, so it must be
    // a visible, reviewed diff against this literal (not a quiet repartition).
    assert.deepEqual(
        [...ROW_BACKED_KSTATE_FIELDS].sort(),
        [
            "absorbed",
            "hiddenOrphanRefs",
            "lastPassIds",
            "renderDeferredRefs",
            "rules",
            "sweptOrphanCallIds",
            "tokenSnapshot",
            "tsStamps",
            "viewLatches",
        ],
    );
    // Every row-backed field must be one the derived merge list can EMIT,
    // or it can never reach the rows (and the split silently ignores it).
    const derived = [...COMPRESSION_STATE_FIELDS] as string[];
    for (const f of ROW_BACKED_KSTATE_FIELDS) {
        assert.ok(derived.includes(f), `row-backed field "${f}" missing from COMPRESSION_STATE_FIELDS`);
    }
    // And the split partitions exactly: row part = the defined row-backed
    // fields, column part = everything else, nothing dropped either way.
    const { column, rows } = splitKstate(COMPRESSION_STATE_FIELDS as readonly string[], fullState());
    assert.deepEqual(Object.keys(rows).sort(), [...ROW_BACKED_KSTATE_FIELDS].sort());
    for (const f of Object.keys(rows)) assert.ok(!(f in column), `"${f}" landed in BOTH the column and the rows`);
    const all = new Set([...Object.keys(column), ...Object.keys(rows)]);
    for (const f of COMPRESSION_STATE_FIELDS) {
        if ((fullState()[f as keyof typeof fullState] ?? undefined) !== undefined) assert.ok(all.has(f), `"${f}" lost by the split`);
    }
});

test("T2: all nine row-backed fields round-trip through planIngest → state_fields → loadLegacyView", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-pin-rt-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    try {
        store.ingestSession(planIngest(session(fullState())));
        const fields = store.getStateFields("sf-pin");
        assert.ok(fields, "no state_fields rows written");
        assert.deepEqual(Object.keys(fields).sort(), [...ROW_BACKED_KSTATE_FIELDS].sort(), "exactly the nine row-backed fields, no more");
        for (const f of ROW_BACKED_KSTATE_FIELDS) {
            assert.equal(fields![f], JSON.stringify(fullState()[f]), `field "${f}" not byte-intact through the round-trip`);
        }
        const rows = {
            session: store.getSessionRow("sf-pin")!,
            messages: store.getMessages("sf-pin"),
            blocks: store.getBlocks("sf-pin"),
            deadRefs: store.getDeadRefs("sf-pin"),
            refs: store.getRefs("sf-pin"),
        };
        const view = loadLegacyView(rows, store.getStateFields("sf-pin"));
        const st = view.state as Record<string, unknown>;
        for (const f of ROW_BACKED_KSTATE_FIELDS) {
            assert.deepEqual(st[f], fullState()[f], `view.state["${f}"] lost in hydration`);
        }
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("T3: steady-state re-ingest rewrites zero state_fields rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-pin-noop-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    const raw = openSqliteDatabase(join(dir, "index.db"));
    try {
        store.ingestSession(planIngest(session(fullState())));
        const snap = (): string => JSON.stringify(
            (raw.db.prepare("SELECT field, value_json, rowid FROM state_fields WHERE session_id = ? ORDER BY field").all("sf-pin") as unknown[]),
        );
        const before = snap();
        // Change ONE field only: the other eight rows must stay untouched.
        const next = fullState();
        next.rules = [{ id: "r1", text: "always run the tests" }, { id: "r2", text: "no silent failures" }];
        store.ingestSession(planIngest(session(next)));
        const after = raw.db.prepare("SELECT field, value_json, rowid FROM state_fields WHERE session_id = ? ORDER BY field").all("sf-pin") as { field: string; value_json: string; rowid: number }[];
        const beforeRows = JSON.parse(before) as { field: string; value_json: string; rowid: number }[];
        for (const b of beforeRows) {
            if (b.field === "rules") continue;
            const a = after.find((r) => r.field === b.field);
            assert.ok(a, `"${b.field}" row vanished on an unrelated change`);
            assert.equal(a!.value_json, b.value_json, `"${b.field}" rewritten by an unrelated change`);
        }
        const rules = after.find((r) => r.field === "rules");
        assert.equal(rules!.value_json, JSON.stringify(next.rules), "the changed field must land");
    } finally {
        raw.db.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
