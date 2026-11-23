// #7574 (review of PR #6785) — what happens when an OLDER build (everything
// before the unified storage landed) opens a library saved by this build.
//
// That older build only reads the sessions row. It does not know the
// content table behind ccr_entries, the state_fields rows or the
// orphan_blocks table, so it loads a session WITHOUT them and writes the
// row back without them:
//   - the slim ccr column becomes a "full" envelope whose entries are
//     `{ hash }` stubs with no text (tool outputs and file reads showed as
//     `{ hash }`);
//   - the nine row-backed state fields are written back as the older
//     build's defaults (nothing / empty), or with what was added while it
//     ran.
// After re-upgrading, this build used to trust the row: the texts stayed
// gone and every state_fields row was overlaid on the column — so a rule
// added while the older build ran vanished again.
//
// The ledger rows survive the rollback (the older build never touches
// them), so the load path now takes the texts back from there and keeps a
// state-field value the older build really wrote. Checked here against a
// real library, with the older build simulated by rewriting the sessions
// row the way it does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createInitialState } from "acp-kernel";
import { planIngest, loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.js";
import { ROW_BACKED_KSTATE_FIELDS, isEmptyStateValue } from "../src/storage/slim.js";
import { openSqliteDatabase } from "../src/storage/driver.js";
import { UnifiedStore } from "../src/storage/store.js";
import { setLogCapture } from "../src/logger.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_CONFIG_FILE = join(mkdtempSync(join(tmpdir(), "rollback-7574-cfg-")), "missing.json");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const BIG_BODY = "B".repeat(4096);
const BIG_H = sha(BIG_BODY);
const TOOL_JSON = JSON.stringify({ tool: "bash", output: "ok" });
const TOOL_H = sha(TOOL_JSON);
const FILE_ENTRY = { hash: BIG_H, rawId: "raw-10", kind: "file read", tokens: 5, chars: BIG_BODY.length, head: "BBBBBBBBBB" };
const TOOL_ENTRY = { hash: TOOL_H, rawId: "raw-11", kind: "command", tokens: 2, chars: TOOL_JSON.length, head: "{...}" };

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

function session(state: Record<string, unknown>, contentStore?: unknown): LegacySessionLike {
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
        contentStore,
    } as LegacySessionLike;
}

function ccrStore(): { version: 1, byHash: Record<string, string>, byRef: Record<string, unknown> } {
    return { version: 1, byHash: { [BIG_H]: BIG_BODY, [TOOL_H]: TOOL_JSON }, byRef: { m00010: FILE_ENTRY, m00011: TOOL_ENTRY } };
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
    return loadLegacyView(rows, store.getCcrEntries(id), store.getStateFields(id));
}

test("after an older build rewrote the sessions row, tool-output texts come back from the ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "rollback-7574-ccr-"));
    const { store, raw } = open(dir);
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    try {
        store.ingestSession(planIngest(session(fullState(), ccrStore())), undefined, { completeLog: true });
        assert.equal(store.getCcrEntries("sess-rb").length, 2, "the ledger holds both entries");
        assert.equal(JSON.parse((raw.db.prepare("SELECT ccr_json AS c FROM sessions WHERE session_id = ?").get("sess-rb") as { c: string }).c).ccrSlim, 1);

        // The older build: it parsed the slim column as a full store, so every
        // entry is its { hash } stub and byHash is empty — and that is what
        // it saves.
        const olderBuildColumn = { version: 1, byHash: {}, byRef: { m00010: { hash: BIG_H }, m00011: { hash: TOOL_H } } };
        raw.db.prepare("UPDATE sessions SET ccr_json = ? WHERE session_id = ?").run(JSON.stringify(olderBuildColumn), "sess-rb");

        const view = load(store, "sess-rb");
        assert.ok(view.contentStore, "the store is served");
        assert.equal(view.contentStore!.byHash[BIG_H], BIG_BODY, "the file-read text is back");
        assert.equal(view.contentStore!.byHash[TOOL_H], TOOL_JSON, "the tool-output text is back");
        assert.deepEqual(view.contentStore!.byRef.m00010, FILE_ENTRY, "a pure { hash } stub is replaced by the ledger's full entry");
        assert.deepEqual(view.contentStore!.byRef.m00011, TOOL_ENTRY);
        assert.deepEqual(Object.keys(view.contentStore!.byHash).sort(), [BIG_H, TOOL_H].sort(), "nothing else was invented");
        assert.ok(logs.some((l) => l.includes("sess-rb") && l.includes("2 content-store entries had no text")), `the heal is logged: ${logs.join(" | ")}`);
        // the direct path gives the same store
        assert.deepEqual(store.getCcr("sess-rb"), view.contentStore, "getCcr heals the same way");

        // The next save puts the library back in order: slim column, same bytes.
        store.ingestSession(planIngest(session(fullState(), view.contentStore)), undefined, { completeLog: true });
        assert.equal(JSON.parse((raw.db.prepare("SELECT ccr_json AS c FROM sessions WHERE session_id = ?").get("sess-rb") as { c: string }).c).ccrSlim, 1, "the column is slim again");
        assert.deepEqual(store.getCcr("sess-rb")?.byRef, ccrStore().byRef, "and still serves the full entries");
    } finally {
        setLogCapture(null);
        raw.db.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an entry the older build really changed is kept as written; an entry nobody has text for is reported, not invented", () => {
    const dir = mkdtempSync(join(tmpdir(), "rollback-7574-mixed-"));
    const { store, raw } = open(dir);
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    try {
        store.ingestSession(planIngest(session(fullState(), ccrStore())), undefined, { completeLog: true });
        const UNKNOWN_H = sha("nobody has this text");
        raw.db.prepare("UPDATE sessions SET ccr_json = ? WHERE session_id = ?").run(JSON.stringify({
            version: 1,
            byHash: {},
            byRef: {
                // the older build changed the entry's metadata
                m00010: { hash: BIG_H, rawId: "renamed-by-the-older-build", kind: "file read", tokens: 5, chars: BIG_BODY.length, head: "BBBBBBBBBB" },
                // an entry the ledger knows nothing about
                m00012: { hash: UNKNOWN_H, rawId: "raw-12", kind: "file read" },
                // an entry whose text the column still has: untouched
                m00011: { hash: TOOL_H, rawId: "raw-11", kind: "command", tokens: 2, chars: TOOL_JSON.length, head: "{...}" },
            },
        }), "sess-rb");
        // give m00011 its text in the column (an entry written by the older build itself)
        const col = JSON.parse((raw.db.prepare("SELECT ccr_json AS c FROM sessions WHERE session_id = ?").get("sess-rb") as { c: string }).c) as { byHash: Record<string, string> };
        col.byHash[TOOL_H] = TOOL_JSON;
        raw.db.prepare("UPDATE sessions SET ccr_json = ? WHERE session_id = ?").run(JSON.stringify(col), "sess-rb");

        const view = load(store, "sess-rb");
        const store2 = view.contentStore!;
        assert.equal(store2.byHash[BIG_H], BIG_BODY, "the text of a changed entry is still filled in (the content hash is the same)");
        assert.equal((store2.byRef.m00010 as { rawId: string }).rawId, "renamed-by-the-older-build", "but the entry itself is kept as the older build wrote it");
        assert.equal(store2.byHash[UNKNOWN_H], undefined, "no text is invented for an unknown entry");
        assert.equal(store2.byHash[TOOL_H], TOOL_JSON, "an entry whose text the column has is untouched");
        assert.ok(logs.some((l) => l.includes("1 content-store entry has no text")), `the unrecoverable entry is reported: ${logs.join(" | ")}`);
    } finally {
        setLogCapture(null);
        raw.db.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a full column without ledger rows (a session older than the ledger) is served exactly as stored", () => {
    const dir = mkdtempSync(join(tmpdir(), "rollback-7574-legacy-"));
    const { store, raw } = open(dir);
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    try {
        store.ingestSession(planIngest(session(fullState())), undefined, { completeLog: true });
        const legacy = { version: 1, byHash: { "sha256-ccr-legacy": "LEGACY-BODY" }, byRef: { m9: { hash: "sha256-ccr-legacy", rawId: "r9", kind: "file read" } } };
        raw.db.prepare("UPDATE sessions SET ccr_json = ? WHERE session_id = ?").run(JSON.stringify(legacy), "sess-rb");
        assert.deepEqual(load(store, "sess-rb").contentStore, legacy);
        assert.deepEqual(store.getCcr("sess-rb"), legacy);
        assert.equal(logs.length, 0, `nothing to report (log: ${logs.join(" | ")})`);
    } finally {
        setLogCapture(null);
        raw.db.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a slim column whose ledger lost a body is reported instead of silently serving no store", () => {
    const dir = mkdtempSync(join(tmpdir(), "rollback-7574-lost-"));
    const { store, raw } = open(dir);
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    try {
        store.ingestSession(planIngest(session(fullState(), ccrStore())), undefined, { completeLog: true });
        const row = raw.db.prepare("SELECT orig_hash FROM ccr_entries WHERE session_id = ? AND ccr_key = 'm00010'").get("sess-rb") as { orig_hash: string };
        // (the raw connection drops the foreign-key check for this one statement:
        // a library that lost a body is exactly the damaged state wanted here)
        raw.db.prepare("PRAGMA foreign_keys = OFF").run();
        raw.db.prepare("DELETE FROM content WHERE hash = ?").run(row.orig_hash);
        assert.equal(load(store, "sess-rb").contentStore, undefined, "still no partial store");
        assert.ok(logs.some((l) => l.includes("sess-rb") && l.includes("could not be rebuilt from its 2 ledger row(s)")), `the loss is logged: ${logs.join(" | ")}`);
    } finally {
        setLogCapture(null);
        raw.db.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

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
    const { store } = open(dir);
    try {
        const state = fullState();
        store.ingestSession(planIngest(session(state)), undefined, { completeLog: true });
        const st = load(store, "sess-rb").state as Record<string, unknown>;
        for (const f of ROW_BACKED_KSTATE_FIELDS) assert.deepEqual(st[f], state[f], `"${f}" lost in plain hydration`);
    } finally {
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
