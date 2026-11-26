// #7574 (review of PR #6785) — what happens when an OLDER build (everything
// before the unified storage landed) opens a library saved by this build.
//
// That older build only knows the sessions row. It does not know the
// state_fields rows, so it loads a session WITHOUT them and its next save
// leaves this behind (replayed here statement for statement; first observed
// with the real previous build):
//   - the nine row-backed state fields are written back as the older
//     build's own values (nothing, an empty container, or what was added
//     while it ran).
// After re-upgrading, this build used to trust the row silently: every
// state_fields row was overlaid on the column — so a rule added while the
// older build ran vanished again.
//
// Now: a state-field value the older build really wrote wins over the row.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import { planIngest, loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.js";
import { ROW_BACKED_KSTATE_FIELDS, isEmptyStateValue } from "../src/storage/slim.js";
import { openSqliteDatabase } from "../src/storage/driver.js";
import { UnifiedStore } from "../src/storage/store.js";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_CONFIG_FILE = join(mkdtempSync(join(tmpdir(), "rollback-7574-cfg-")), "missing.json");

const RULE_BEFORE = { id: "r1", text: "always run the tests" };
const RULE_ADDED_WHILE_OLDER_BUILD_RAN = { id: "r2", text: "no silent failures" };

function fullState(): Record<string, unknown> {
    return {
        ...createInitialState(),
        tokenSnapshot: { "m00003": 1234, "m00005": 777 },
        tsStamps: { "m00004": 1731000000000 },
        lastPassIds: ["m00005", "m00006"],
        hiddenOrphanRefs: ["m00007"],
        sweptOrphanCallIds: ["tc_1"],
        renderDeferredRefs: ["m00008"],
        viewLatches: { m00009: { text: "latched", hidden: true } },
        absorbed: [
            { toolCallId: "tc_2", callMessageId: "m00010", resultMessageId: "m00011", summary: "did the thing", tokensReclaimed: 42, createdAt: 1731000001000 },
        ],
        rules: [RULE_BEFORE],
    };
}

function session(state: Record<string, unknown>): LegacySessionLike {
    return {
        id: "sess-rb",
        createdAt: 1000,
        lastSeen: 2000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: state as never,
        blockContents: new Map(),
        lastMessages: [{ id: "m1", role: "user", contentType: "text", text: "hi" }],
        lastMessagesFolded: true,
        pluginSnapshot: undefined,
    } as LegacySessionLike;
}

function open(dir: string): { store: UnifiedStore; raw: ReturnType<typeof openSqliteDatabase> } {
    const file = join(dir, "index.db");
    return { store: UnifiedStore.open(file), raw: openSqliteDatabase(file) };
}

function load(store: UnifiedStore, id: string): ReturnType<typeof loadLegacyView> {
    const rows = {
        session: store.getSessionRow(id)!,
        messages: store.getMessages(id),
        blocks: store.getBlocks(id),
        deadRefs: store.getDeadRefs(id),
        refs: store.getRefs(id),
    };
    return loadLegacyView(rows, store.getStateFields(id));
}

test("a state-field value the older build really wrote stays; its empty default gives way to the value from before", () => {
    const dir = mkdtempSync(join(tmpdir(), "rollback-7574-state-"));
    const { store, raw } = open(dir);
    try {
        const before = fullState();
        store.ingestSession(planIngest(session(before)), undefined, { completeLog: true });
        const fields = store.getStateFields("sess-rb")!;
        assert.equal(Object.keys(fields).length, ROW_BACKED_KSTATE_FIELDS.length, "the nine fields are in the rows");
        const column = JSON.parse((raw.db.prepare("SELECT kstate_json AS k FROM sessions WHERE session_id = ?").get("sess-rb") as { k: string }).k) as Record<string, unknown>;
        for (const f of ROW_BACKED_KSTATE_FIELDS) assert.equal(column[f], undefined, `"${f}" is not in the column any more`);

        // The older build: loaded the session without the nine fields, added
        // one rule while it ran, and saved the column with its own (empty
        // or changed) values for the fields it keeps in the state object.
        const olderBuildColumn: Record<string, unknown> = {
            ...column,
            tokenSnapshot: {},                                   // its default
            lastPassIds: [],                                     // its default
            rules: [RULE_ADDED_WHILE_OLDER_BUILD_RAN],           // what it added
        };
        raw.db.prepare("UPDATE sessions SET kstate_json = ? WHERE session_id = ?").run(JSON.stringify(olderBuildColumn), "sess-rb");

        const st = load(store, "sess-rb").state as Record<string, unknown>;
        assert.deepEqual(st.rules, [RULE_ADDED_WHILE_OLDER_BUILD_RAN], "the rule added while the older build ran is still there (the column is newer)");
        assert.deepEqual(st.tokenSnapshot, before.tokenSnapshot, "the empty default gives way to the snapshot from before the rollback");
        assert.deepEqual(st.lastPassIds, before.lastPassIds, "… and so does every other field the older build emptied");
        for (const f of ROW_BACKED_KSTATE_FIELDS) {
            if (f === "rules") continue;
            assert.deepEqual(st[f], before[f], `"${f}" lost`);
        }

        // The next save re-aligns the rows with what is now loaded.
        const reloaded = { ...before, rules: [RULE_ADDED_WHILE_OLDER_BUILD_RAN] } as never;
        store.ingestSession(planIngest(session(reloaded as Record<string, unknown>)), undefined, { completeLog: true });
        assert.equal(store.getStateFields("sess-rb")!.rules, JSON.stringify([RULE_ADDED_WHILE_OLDER_BUILD_RAN]), "the row follows the newer value");
    } finally {
        raw.db.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("steady state is unchanged: a column without the field always takes the row", () => {
    const dir = mkdtempSync(join(tmpdir(), "rollback-7574-steady-"));
    // `load` reads through the raw connection — it must be closed before the
    // folder goes, Windows refuses to remove a file that is still open
    // (EBUSY, CI windows-latest node 22 shard 3).
    const { store, raw } = open(dir);
    try {
        const state = fullState();
        store.ingestSession(planIngest(session(state)), undefined, { completeLog: true });
        const st = load(store, "sess-rb").state as Record<string, unknown>;
        for (const f of ROW_BACKED_KSTATE_FIELDS) assert.deepEqual(st[f], state[f], `"${f}" lost in plain hydration`);
    } finally {
        raw.db.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(
        [[], {}, "", 0, false, null, undefined].filter((v) => !isEmptyStateValue(v)),
        [],
        "empty containers and empty scalars are the older build's defaults",
    );
    assert.equal(isEmptyStateValue({ a: 1 }), false);
    assert.equal(isEmptyStateValue(["x"]), false);
    assert.equal(isEmptyStateValue("text"), false);
    assert.equal(isEmptyStateValue(3), false);
});
