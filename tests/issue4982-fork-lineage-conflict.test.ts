import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnifiedStore, sha256Hex, type IngestSessionInput } from "../src/storage/store.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { MysqlBackend, type Mysql2Module } from "../src/storage/mysql.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";

test("#4982: a mirror with an exhausted store still attempts the queued fork (never fails closed on a breaker any more)", async () => {
    // Pre-owner-policy-2026-10-30 shape: the 3-strike breaker could disable
    // storage mid-run, and createForkAsync refused with "fork storage
    // unavailable" once it noticed. That gate is GONE — index writes are
    // never abandoned, so the fork must still ATTEMPT its work against the
    // exhausted store and surface whatever the store reports (envelope
    // serves meanwhile), instead of refusing up front.
    let backendCalls = 0;
    let cloneCalls = 0;
    const stats = { disabled: true };
    const shadow = {
        stats,
        sync: null,
        backend: {
            async lastLiveSeq() { backendCalls++; return 0; },
            async cloneSessionRows() { cloneCalls++; return false; },
        },
        async enqueue<T>(work: () => Promise<T>): Promise<T> {
            return work();
        },
    } as unknown as UnifiedShadow;
    const child: LegacySessionLike = {
        id: "queued-child", createdAt: 1, lastSeen: 1, meta: {}, stats: {}, metadata: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, nextBlockId: 1, nextRunId: 1 },
        blockContents: new Map(),
    };
    await UnifiedShadow.prototype.createForkAsync.call(shadow, "parent", child);
    assert.equal(cloneCalls, 1, "the fork ATTEMPTED its work against the exhausted store instead of refusing");
    assert.ok(backendCalls >= 1, "the live-seq lookup ran as part of the attempt");
});

// Actual SQLite storage, including content refcounts and zero-row clones.
for (const populated of [false, true]) {
    test(`#4982: ${populated ? "populated" : "empty"} fork keeps its immutable pair across retries/conflicts/reopen`, () => {
        const dir = mkdtempSync(join(tmpdir(), "bili-4982-lineage-"));
        const filename = join(dir, "index.db");
        let store = UnifiedStore.open(filename);
        const raw = openSqliteDatabase(filename, "node:sqlite").db;
        try {
            for (const id of ["parent", "other", "placeholder"])
                raw.prepare("INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, 1, 1)").run(id);
            if (populated) {
                const bytes = Buffer.from("body");
                const hash = sha256Hex(bytes);
                raw.prepare("INSERT INTO content (hash, byte_len, refcount, bytes) VALUES (?, ?, 1, ?)").run(hash, bytes.length, bytes);
                raw.prepare("INSERT INTO messages (session_id, seq, msg_id, role, kind, content_hash, identity) VALUES ('parent', 0, 'm1', 'user', 'text', ?, '')").run(hash);
            }
            assert.equal(store.cloneSessionRows("parent", "placeholder", 0), true);
            const before = raw.prepare("SELECT * FROM content ORDER BY hash").all();
            const rows = store.getMessages("placeholder");
            store.close();
            store = UnifiedStore.open(filename);
            assert.equal(store.cloneSessionRows("parent", "placeholder", 0), true);
            assert.throws(() => store.cloneSessionRows("other", "placeholder", 0), /conflicting fork lineage/);
            assert.throws(() => store.cloneSessionRows("parent", "placeholder", 1), /conflicting fork lineage/);
            assert.throws(() => store.cloneSessionRows("parent", "parent", 0), /conflicting fork lineage/);
            assert.equal(store.getSessionRow("placeholder")!.parentSessionId, "parent");
            assert.equal(store.getSessionRow("placeholder")!.forkPointSeq, 0);
            assert.deepEqual(store.getMessages("placeholder"), rows);
            assert.deepEqual(raw.prepare("SELECT * FROM content ORDER BY hash").all(), before);
            assert.equal(store.cloneSessionRows("missing", "absent", 0), false);
            assert.equal(store.getSessionRow("absent"), null);
            if (populated) assert.throws(() => store.cloneSessionRows("other", "parent", 0), /child already has messages/);
        } finally {
            raw.close();
            store.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
}

// A connection-contract test, NOT a MySQL integration/concurrency test.
// Reject pool queries and assert the unique-key lock precedes the locking read;
// actual InnoDB contention requires the separately gated MySQL e2e environment.
for (const scenario of ["fresh", "same", "parent-conflict", "point-conflict", "occupied", "missing", "copy-failure"] as const) {
    test(`#4982: MySQL clone transaction contract: ${scenario}`, async () => {
        const calls: string[] = [];
        const conn = {
            async beginTransaction() { calls.push("begin"); },
            async commit() { calls.push("commit"); },
            async rollback() { calls.push("rollback"); },
            release() { calls.push("release"); },
            async query(sql: string) {
                const q = sql.replace(/\s+/g, " ").trim();
                calls.push(q);
                if (q.startsWith("SELECT session_id")) return [scenario === "missing" ? [] : [{ session_id: "parent" }]];
                if (q.includes("FOR UPDATE")) return [[{
                    parent_session_id: scenario === "parent-conflict" ? "other" : ["same", "point-conflict"].includes(scenario) ? "parent" : null,
                    fork_point_seq: scenario === "point-conflict" ? 1 : ["same", "parent-conflict"].includes(scenario) ? 0 : null,
                }]];
                if (q.startsWith("SELECT COUNT")) return [[{ n: scenario === "occupied" ? 1 : 0 }]];
                if (q.startsWith("INSERT INTO messages") && scenario === "copy-failure") throw new Error("injected copy failure");
                if (q.startsWith("SELECT")) return [[]];
                return [{ affectedRows: 1 }];
            },
        };
        const driver = { createPool: () => ({
            getConnection: async () => conn,
            query: () => { throw new Error("clone must not read through pool outside transaction"); },
        }) } as unknown as Mysql2Module;
        const store = new MysqlBackend("unused", driver);
        const fails = ["parent-conflict", "point-conflict", "occupied", "copy-failure"].includes(scenario);
        if (fails) await assert.rejects(store.cloneSessionRows("parent", "child", 0), /conflicting fork lineage|injected copy failure/);
        else assert.equal(await store.cloneSessionRows("parent", "child", 0), scenario !== "missing");
        assert.equal(calls[0], "begin");
        assert.deepEqual(calls.slice(-2), [fails ? "rollback" : "commit", "release"]);
        if (scenario !== "missing") {
            const claim = calls.findIndex(q => q.startsWith("INSERT INTO sessions"));
            const read = calls.findIndex(q => q.includes("FOR UPDATE"));
            assert.ok(claim > 0 && read > claim, "lock absent or existing child before inspecting lineage");
        }
        if (["same", "parent-conflict", "point-conflict", "occupied", "missing"].includes(scenario)) {
            assert.ok(!calls.some(q => q.startsWith("INSERT INTO messages")), "retries/conflicts cannot copy rows or increase refs");
        }
    });
}

for (const fail of [false, true]) {
    test(`#4982: initial clone snapshot is atomic (${fail ? "ingest rollback" : "success"})`, () => {
        const dir = mkdtempSync(join(tmpdir(), "bili-4982-atomic-"));
        const filename = join(dir, "index.db");
        const store = UnifiedStore.open(filename);
        const raw = openSqliteDatabase(filename, "node:sqlite").db;
        try {
            raw.prepare("INSERT INTO sessions (session_id, created_at, updated_at) VALUES ('parent', 1, 1)").run();
            const bytes = Buffer.from("body");
            const hash = sha256Hex(bytes);
            raw.prepare("INSERT INTO content (hash, byte_len, refcount, bytes) VALUES (?, ?, 1, ?)").run(hash, bytes.length, bytes);
            raw.prepare("INSERT INTO messages (session_id, seq, msg_id, role, kind, content_hash, identity) VALUES ('parent', 0, 'm1', 'user', 'text', ?, '')").run(hash);
            const initial: IngestSessionInput = {
                session: { ...store.getSessionRow("parent")!, sessionId: "child", kstateJson: '{"nextBlockId":9}', metadataJson: '{"cloneReady":true}' },
                messages: [], blocks: [], deadRefs: [], ccrEntries: [],
                refs: [{ ord: 0, rawId: "m1", ref: "m00001", refNum: 1 }],
            };
            if (fail) {
                raw.exec("CREATE TRIGGER fail_initial_ref BEFORE INSERT ON refs BEGIN SELECT RAISE(ABORT, 'injected initial ingest failure'); END");
                assert.throws(() => store.cloneSessionRows("parent", "child", 0, initial), /injected initial ingest failure/);
                assert.equal(store.getSessionRow("child"), null);
                assert.throws(() => store.cloneSessionRows("unmirrored", "child", 0, initial), /injected initial ingest failure/);
                assert.equal(store.getSessionRow("child"), null, "unmirrored-parent initialization rolls back too");
                assert.deepEqual(store.getMessages("child"), []);
                assert.equal((raw.prepare("SELECT refcount FROM content WHERE hash = ?").get(hash) as { refcount: number }).refcount, 1);
            } else {
                assert.equal(store.cloneSessionRows("parent", "child", 0, initial), true);
                assert.equal(store.getSessionRow("child")!.kstateJson, initial.session.kstateJson);
                assert.equal(store.getSessionRow("child")!.metadataJson, initial.session.metadataJson);
                assert.equal(store.getSessionRow("child")!.parentSessionId, "parent");
                assert.equal(store.getMessages("child").length, 0, "initial empty snapshot retires cloned rows outside its prefix");
                assert.ok((raw.prepare("SELECT retired_at FROM messages WHERE session_id = 'child'").get() as { retired_at: number }).retired_at !== null, "historical row remains but is not live");
                assert.throws(() => store.cloneSessionRows("parent", "child", 0, initial), /child already exists/);
                assert.throws(() => store.cloneSessionRows("unmirrored", "child", 0, initial), /child already exists/);
                assert.equal(store.getSessionRow("child")!.parentSessionId, "parent");
                assert.equal(store.cloneSessionRows("unmirrored", "absent", 0, { ...initial, session: { ...initial.session, sessionId: "absent", parentSessionId: null, forkPointSeq: null } }), true);
                assert.equal(store.getSessionRow("absent")!.parentSessionId, null, "no ledger lineage is invented for an unmirrored parent");
                assert.equal(store.getSessionRow("absent")!.kstateJson, initial.session.kstateJson);
                assert.deepEqual(store.getMessages("absent"), []);
            }
        } finally {
            raw.close(); store.close(); rmSync(dir, { recursive: true, force: true });
        }
    });
}

for (const scenario of ["success", "ingest-failure", "existing-child", "missing-parent", "missing-parent-ingest-failure"] as const) {
    test(`#4982: MySQL initial snapshot shares clone connection: ${scenario}`, async () => {
        const calls: string[] = [];
        const conn = {
            async beginTransaction() { calls.push("begin"); },
            async commit() { calls.push("commit"); },
            async rollback() { calls.push("rollback"); },
            release() { calls.push("release"); },
            async query(sql: string) {
                const q = sql.replace(/\s+/g, " ").trim();
                calls.push(q);
                if (q.startsWith("INSERT INTO sessions (session_id, created_at, updated_at)")) {
                    assert.ok(!q.includes("ON DUPLICATE"), "initial clone must strictly insert its child");
                    if (scenario === "existing-child") throw Object.assign(new Error("duplicate child"), { code: "ER_DUP_ENTRY" });
                }
                if (q.startsWith("INSERT INTO sessions (session_id, parent_session_id")) {
                    if (scenario === "ingest-failure" || scenario === "missing-parent-ingest-failure") throw new Error("injected snapshot write failure");
                }
                if (q.startsWith("SELECT session_id")) return [scenario === "existing-child" || scenario.startsWith("missing-parent") ? [] : [{ session_id: "parent" }]];
                if (q.includes("FOR UPDATE")) return [[{ parent_session_id: null, fork_point_seq: null }]];
                if (q.startsWith("SELECT COUNT")) return [[{ n: 0 }]];
                return q.startsWith("SELECT") ? [[]] : [{ affectedRows: 1 }];
            },
        };
        let connections = 0;
        const driver = { createPool: () => ({ getConnection: async () => { connections++; return conn; } }) } as unknown as Mysql2Module;
        const store = new MysqlBackend("unused", driver);
        const initial: IngestSessionInput = {
            session: { sessionId: "child", parentSessionId: null, forkPointSeq: null, createdAt: 1, updatedAt: 1,
                nextBlockId: 9, nextRunId: 1, metaJson: "{}", statsJson: "{}", metadataJson: "{}", kstateJson: "{}", tailJson: "{}", ccrJson: null },
            messages: [], blocks: [], refs: [], deadRefs: [], ccrEntries: [],
        };
        if (scenario === "success") assert.equal(await store.cloneSessionRows("parent", "child", 0, initial), true);
        else if (scenario === "missing-parent") assert.equal(await store.cloneSessionRows("parent", "child", 0, initial), true);
        else await assert.rejects(store.cloneSessionRows("parent", "child", 0, initial), /injected snapshot write failure|conflicting fork lineage/);
        if (scenario === "missing-parent") {
            assert.ok(calls.some(q => q.startsWith("INSERT INTO sessions (session_id, parent_session_id")), "unmirrored parent still initializes its prepared child");
            assert.ok(!calls.some(q => q.startsWith("INSERT INTO messages")), "no parent rows are invented");
        }
        assert.equal(connections, 1, "ingest must reuse the clone transaction connection");
        assert.equal(calls.filter(q => q === "begin").length, 1);
        assert.deepEqual(calls.slice(-2), [scenario === "success" || scenario === "missing-parent" ? "commit" : "rollback", "release"]);
        assert.equal(calls.filter(q => q === "commit").length, scenario === "success" || scenario === "missing-parent" ? 1 : 0);
    });
}

test("#4982: MySQL atomic sparse clone persists absolute snapshot and tail pointers", async () => {
    const absoluteSeqs = [0, 3, 4];
    const messages = absoluteSeqs.map((_, seq) => ({
        seq, msgId: `m${seq}`, identity: `id:${seq}`, content: `body${seq}`, contentHash: sha256Hex(`body${seq}`),
        ref: `m0000${seq + 1}`, refNum: seq + 1, role: "user", kind: "text",
    }));
    let persistedTail: string | undefined;
    let persistedWatermark: unknown;
    const writtenSeqs: unknown[] = [];
    const conn = {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql: string, params: unknown[] = []) {
            const q = sql.replace(/\s+/g, " ").trim();
            if (q.startsWith("SELECT session_id")) return [[{ session_id: "parent" }]];
            if (q.includes("FOR UPDATE")) return [[{ parent_session_id: null, fork_point_seq: null }]];
            if (q.startsWith("SELECT COUNT")) return [[{ n: 0 }]];
            if (q.startsWith("SELECT seq, msg_id, identity, content_hash, retired_at")) return [messages.map((m, i) => ({
                seq: absoluteSeqs[i], msg_id: m.msgId, identity: m.identity, content_hash: m.contentHash, retired_at: null,
            }))];
            if (q.startsWith("INSERT INTO sessions (session_id, parent_session_id")) {
                const columns = q.slice(q.indexOf("(") + 1, q.indexOf(")")).split(", ");
                persistedTail = params[columns.indexOf("tail_json")] as string;
                persistedWatermark = params[columns.indexOf("last_ingested_seq")];
            }
            if (q.startsWith("INSERT IGNORE INTO messages")) writtenSeqs.push(params[1]);
            return q.startsWith("SELECT") ? [[]] : [{ affectedRows: 1 }];
        },
    };
    const store = new MysqlBackend("unused", { createPool: () => ({ getConnection: async () => conn }) } as unknown as Mysql2Module);
    const initial: IngestSessionInput = {
        session: { sessionId: "child", parentSessionId: null, forkPointSeq: null, createdAt: 1, updatedAt: 1,
            nextBlockId: 9, nextRunId: 1, metaJson: "{}", statsJson: "{}", metadataJson: "{}", kstateJson: "{}",
            tailJson: JSON.stringify({ tailSeqs: [0, 1, 2], pluginSnapshotSeqs: [0, 1, 2] }), ccrJson: null },
        messages, blocks: [], refs: [], deadRefs: [], ccrEntries: [], tailSeqs: [0, 1, 2], pluginSnapshotSeqs: [0, 1, 2],
    };
    assert.equal(await store.cloneSessionRows("parent", "child", 4, initial), true);
    assert.deepEqual(writtenSeqs, absoluteSeqs);
    assert.equal(persistedWatermark, 4);
    assert.deepEqual(JSON.parse(persistedTail!).tailSeqs, absoluteSeqs, "tail points to absolute cloned ledger positions");
    assert.deepEqual(JSON.parse(persistedTail!).pluginSnapshotSeqs, absoluteSeqs, "snapshot uses the same absolute positions");
});
