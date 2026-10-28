import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
// The contract suite deliberately imports NOTHING from store.ts: every
// assertion goes through the StorageBackend interface only. When the mysql
// backend lands (#3388 step 2) this same file runs against it unchanged.
import { openBackend, listBackendNames, type StorageBackend } from "../src/storage/backend.ts";

const MYSQL_DSN = process.env.BILI_MYSQL_TEST_DSN ?? "";

/** The suite runs against every backend it can reach: sqlite always, mysql
 *  when BILI_MYSQL_TEST_DSN is exported (CI runs a mysql:8.0 service). The
 *  mysql backend needs init() (DDL + schema stamp) once per fresh database. */
const lanes: { name: string; open: (scratchDir: string) => Promise<StorageBackend> }[] = [
    { name: "sqlite", open: async (dir) => openBackend("sqlite", path.join(dir, "index.db")) },
];
if (MYSQL_DSN.length > 0) {
    lanes.push({
        name: "mysql",
        open: async () => {
            const be = await openBackend("mysql", MYSQL_DSN);
            const { MysqlBackend } = await import("../src/storage/mysql.ts");
            assert.ok(be instanceof MysqlBackend, "mysql lane opens the real backend");
            await be.init();
            return be;
        },
    });
}

/**
 * #3931 (step 1 of the #3388 pluggable-storage plan): the operation-level
 * backend contract. This suite is the seam proof — the registry resolves a
 * backend by name and the whole storage surface (ingest, reads, session_ext,
 * watermark, reap journal, archive/restore, gc, conversation lookup, delete
 * with refcount release, close) is exercised through the interface.
 *
 * Against sqlite today the results must equal what the UnifiedStore path
 * produces (pinned elsewhere by the corpus/golden suites); the point here is
 * that the CONTRACT carries the operations and their semantics, so a second
 * implementation has a fixed target to hit.
 */

interface CoreMsg { id: string; role: string; contentType: string; text: string }
const mkMsg = (id: string, text: string): CoreMsg => ({ id, role: "user", contentType: "text", text });

const mkSession = (id: string, msgs: CoreMsg[]): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen: 2_000,
    meta: { protocol: "openai", label: `label-${id}` },
    stats: {},
    metadata: { },
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

function scratch(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "bili-backend-contract-"));
}

test("registry: sqlite resolves through the registry; names are advertised", async () => {
    const names = listBackendNames();
    assert.ok(names.includes("sqlite"), "sqlite is a registered backend");
    assert.ok(names.includes("mysql"), "mysql is registered as a step-2 stub so config validation recognizes it");
    const dir = scratch();
    try {
        const backend = await openBackend("sqlite", path.join(dir, "index.db"));
        await backend.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("contract: ingest → reads round-trip through the interface", async () => {
    const dir = scratch();
    try {
        const backend = await openBackend("sqlite", path.join(dir, "index.db"));
        try {
            const msgs = [mkMsg("m1", "hello " + "x".repeat(200)), mkMsg("m2", "world " + "y".repeat(200))];
            await backend.ingestSession(planIngest(mkSession("sess-contract", msgs)));

            const row = await backend.getSessionRow("sess-contract");
            assert.ok(row, "session row readable via the interface");
            assert.equal(row!.sessionId, "sess-contract");
            assert.equal(row!.label, "label-sess-contract");

            const rows = await backend.getMessages("sess-contract");
            assert.equal(rows.length, 2, "both messages landed");
            const parsed = JSON.parse(rows[1]!.content) as { id?: string };
            assert.equal(parsed.id, "m2", "message content is the verbatim core JSON");
            assert.ok(typeof rows[1]!.contentHash === "string" && rows[1]!.contentHash.length > 0, "content hashes ride the rows");

            const counters = await backend.sessionCounters("sess-contract");
            assert.ok(counters, "session counters readable");

            // #4730: last live seq through the interface — the fork lane's
            // inclusive bound (NOT count-1; mysql must answer identically).
            assert.equal(await backend.lastLiveSeq("sess-contract"), 1, "last live seq = newest live row");
            assert.equal(await backend.lastLiveSeq("sess-contract-absent"), null, "no live rows → null");

            const ids = await backend.listSessionIds();
            assert.ok(ids.includes("sess-contract"), "session enumerated");
        } finally {
            await backend.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("contract: session_ext + watermark + tailSeqs", async () => {
    const dir = scratch();
    try {
        const backend = await openBackend("sqlite", path.join(dir, "index.db"));
        try {
            await backend.ingestSession(planIngest(mkSession("sess-ext", [mkMsg("m1", "payload".repeat(60))])));
            await backend.setSessionExt("sess-ext", "inc:canonical-ptrs", [0, 1]);
            assert.deepEqual(await backend.getSessionExt("sess-ext", "inc:canonical-ptrs"), [0, 1]);
            const listed = await backend.listSessionExt("sess-ext");
            assert.equal(listed.filter((e) => e.key === "inc:canonical-ptrs").length, 1);
            assert.equal(await backend.deleteSessionExt("sess-ext", "inc:canonical-ptrs"), 1);
            // session_ext reads return undefined when the key is absent
            // (verbatim store semantics — the contract keeps them).
            assert.equal(await backend.getSessionExt("sess-ext", "inc:canonical-ptrs"), undefined);

            const wm = await backend.ingestWatermark("sess-ext");
            assert.ok(wm && typeof wm.seq === "number", "watermark readable");
            const tails = await backend.tailSeqs("sess-ext");
            assert.ok(Array.isArray(tails), "tailSeqs readable");
            await backend.clearIngestWatermark("sess-ext");
            assert.equal(await backend.ingestWatermark("sess-ext"), null, "clearIngestWatermark clears it");
        } finally {
            await backend.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("contract: reap journal orphans through the interface (#3841 semantics)", async () => {
    const dir = scratch();
    try {
        const backend = await openBackend("sqlite", path.join(dir, "index.db"));
        try {
            await backend.ingestSession(planIngest(mkSession("sess-reap", [mkMsg("m1", "keep".repeat(80))])));
            const orphans = new Map([["b2", { one: null, full: { text: "orphaned summary", count: 0 } }]]);
            await backend.reapBlocks("sess-reap", new Set(["b2"]), orphans);
            // Idempotent: re-running the journal with the same shape is a no-op.
            await backend.reapBlocks("sess-reap", new Set(["b2"]), new Map());
        } finally {
            await backend.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("contract: archive → restore round-trip + gc counters", async () => {
    const dir = scratch();
    const archiveDir = path.join(dir, "archive");
    try {
        const backend = await openBackend("sqlite", path.join(dir, "index.db"));
        try {
            await backend.ingestSession(planIngest(mkSession("sess-gc", [mkMsg("m1", "gc target".repeat(120))])));
            const archived = await backend.archiveSession("sess-gc", { archiveDir });
            assert.ok(archived.ok && archived.exportPath, "archive ok");
            assert.ok(fs.existsSync(archived.exportPath!), "export landed on disk");
            const row = await backend.getSessionRow("sess-gc");
            assert.equal(row!.status, "archived", "tombstone keeps the row");
            const restored = await backend.restoreArchived("sess-gc", { archiveDir });
            assert.ok(restored.ok, `restore ok (${restored.reason ?? ""})`);
            const back = await backend.getSessionRow("sess-gc");
            assert.equal(back!.status, "active", "restore reactivates");
            const gc = await backend.gc({ archiveAfterDays: 365, archiveDir, now: 9_000_000_000_000 });
            assert.ok(gc.archived >= 0 && gc.contentRowsDeleted >= 0, "gc returns counters");
        } finally {
            await backend.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("contract: conversation lookup + delete releases content refs", async () => {
    const dir = scratch();
    try {
        const backend = await openBackend("sqlite", path.join(dir, "index.db"));
        try {
            const shared = mkMsg("m-shared", "shared body ".repeat(50));
            await backend.ingestSession(planIngest(mkSession("sess-del-a", [shared])));
            await backend.ingestSession(planIngest(mkSession("sess-del-b", [shared])));
            const before = await backend.contentRefCountOfBody("shared body ");
            assert.ok(before >= 2, "shared content is refcounted across sessions");
            await backend.deleteSession("sess-del-a");
            const after = await backend.contentRefCountOfBody("shared body ");
            assert.equal(after, before - 1, "delete releases exactly this session's refs");
            assert.equal(await backend.getSessionRow("sess-del-a"), null, "row gone");
        } finally {
            await backend.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("contract: fork clone copies rows, records lineage, replays idempotently (#4316 PR3/3, #4911)", async () => {
    const dir = scratch();
    try {
        const backend = await openBackend("sqlite", path.join(dir, "index.db"));
        try {
            const msgs = [mkMsg("m1", "alpha ".repeat(80)), mkMsg("m2", "beta ".repeat(80)), mkMsg("m3", "gamma ".repeat(80))];
            await backend.ingestSession(planIngest(mkSession("sess-clone-parent", msgs)));
            const parentRows = await backend.getMessages("sess-clone-parent");
            assert.equal(parentRows.length, 3, "parent rows landed");

            // throughSeq is INCLUSIVE: seq 0..1 of the three rows are copied.
            const refBefore = await backend.contentRefCountOfBody("alpha ");
            assert.ok(await backend.cloneSessionRows("sess-clone-parent", "sess-clone-child", 1), "clone ok");
            const childRows = await backend.getMessages("sess-clone-child");
            assert.equal(childRows.length, 2, "throughSeq is inclusive");
            for (let i = 0; i < childRows.length; i++) {
                assert.equal(childRows[i]!.seq, parentRows[i]!.seq, "child keeps the parent's seq values");
                assert.equal(childRows[i]!.msgId, parentRows[i]!.msgId);
                assert.equal(childRows[i]!.contentHash, parentRows[i]!.contentHash);
            }
            const childRow = await backend.getSessionRow("sess-clone-child");
            assert.ok(childRow, "child session row created");
            assert.equal(childRow!.parentSessionId, "sess-clone-parent", "lineage recorded");
            assert.equal(childRow!.forkPointSeq, 1, "fork point recorded");
            assert.equal(await backend.contentRefCountOfBody("alpha "), refBefore + 1, "one refcount bump per copied row");

            // Idempotent replay — a retried fork must not duplicate rows.
            assert.ok(await backend.cloneSessionRows("sess-clone-parent", "sess-clone-child", 1), "replay ok");
            assert.equal((await backend.getMessages("sess-clone-child")).length, 2, "replay is a no-op");

            // A parent with no row clones nothing and reports false (the fork
            // then proceeds kernel-only) — both backends must agree on this.
            assert.equal(await backend.cloneSessionRows("sess-clone-absent", "sess-clone-orphan", 5), false, "absent parent → false");
        } finally {
            await backend.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// MySQL lane (#3388 step 2): the same contract surface against MySQL 8.0.
// Runs only when BILI_MYSQL_TEST_DSN is exported (CI starts a mysql:8.0
// service; locally `docker run -e MYSQL_ROOT_PASSWORD=… -p 3307:3306 mysql:8.0`).
// Session ids are suffixed so the shared database stays isolated per run.
// ---------------------------------------------------------------------------

test("mysql lane: contract surface against MySQL 8.0", { skip: MYSQL_DSN.length === 0 ? "set BILI_MYSQL_TEST_DSN to run" : false }, async (t) => {
    const backend = await openBackend("mysql", MYSQL_DSN);
    await backend.init?.();
    t.after(async () => {
        await backend.close();
    });
    const run = String(Date.now());

    // ingest → reads round-trip
    const sid = `sess-mysql-${run}`;
    const msgs = [mkMsg("m1", "hello " + "x".repeat(200)), mkMsg("m2", "world " + "y".repeat(200))];
    assert.ok(await backend.ingestSession(planIngest(mkSession(sid, msgs))), "ingest ok");
    const row = await backend.getSessionRow(sid);
    assert.ok(row && row.sessionId === sid && row.label === `label-${sid}`, "session row + label");
    const rows = await backend.getMessages(sid);
    assert.equal(rows.length, 2, "both messages landed");
    assert.equal((JSON.parse(rows[1]!.content) as { id?: string }).id, "m2", "verbatim core JSON");
    assert.ok(typeof rows[1]!.contentHash === "string" && rows[1]!.contentHash.length > 0, "content hashes ride the rows");
    const counters = await backend.sessionCounters(sid);
    assert.ok(counters && counters.nextBlockId >= 1, "counters readable");
    assert.equal(await backend.lastLiveSeq(sid), 1, "#4730: last live seq = newest live row");
    assert.equal(await backend.lastLiveSeq(`${sid}-absent`), null, "#4730: no live rows → null");
    assert.ok((await backend.listSessionIds()).includes(sid), "enumerated");

    // ext / watermark / tailSeqs
    await backend.setSessionExt(sid, "inc:canonical-ptrs", [0, 1]);
    assert.deepEqual(await backend.getSessionExt(sid, "inc:canonical-ptrs"), [0, 1]);
    const wm = await backend.ingestWatermark(sid);
    assert.ok(wm && typeof wm.seq === "number", "watermark readable");
    assert.ok(Array.isArray(await backend.tailSeqs(sid)), "tailSeqs readable");
    await backend.clearIngestWatermark(sid);
    assert.equal(await backend.ingestWatermark(sid), null);

    // re-ingest the same identity is stable (seq preservation via remap)
    assert.ok(await backend.ingestSession(planIngest(mkSession(sid, msgs))), "re-ingest ok");
    const rows2 = await backend.getMessages(sid);
    assert.equal(rows2.length, 2, "no duplicate rows on identical re-ingest");

    // fork clone (#4316 PR3/3, #4911): the same contract surface the shadow
    // async twins route into on the real fork lane — semantics must match
    // the sqlite lane's dedicated test line for line.
    const cpSid = `sess-mysql-clone-parent-${run}`;
    const chSid = `sess-mysql-clone-child-${run}`;
    const cmsgs = [mkMsg("cm1", "c-alpha ".repeat(80)), mkMsg("cm2", "c-beta ".repeat(80)), mkMsg("cm3", "c-gamma ".repeat(80))];
    assert.ok(await backend.ingestSession(planIngest(mkSession(cpSid, cmsgs))), "clone parent ingested");
    const cParentRows = await backend.getMessages(cpSid);
    assert.equal(cParentRows.length, 3, "parent rows landed");
    const cRefBefore = await backend.contentRefCountOfBody("c-alpha ");
    assert.ok(await backend.cloneSessionRows(cpSid, chSid, 1), "clone ok");
    const cChildRows = await backend.getMessages(chSid);
    assert.equal(cChildRows.length, 2, "throughSeq is inclusive");
    for (let i = 0; i < cChildRows.length; i++) {
        assert.equal(cChildRows[i]!.seq, cParentRows[i]!.seq, "child keeps the parent's seq values");
        assert.equal(cChildRows[i]!.msgId, cParentRows[i]!.msgId);
        assert.equal(cChildRows[i]!.contentHash, cParentRows[i]!.contentHash);
    }
    const cChildRow = await backend.getSessionRow(chSid);
    assert.ok(cChildRow, "child session row created");
    assert.equal(cChildRow!.parentSessionId, cpSid, "lineage recorded");
    assert.equal(cChildRow!.forkPointSeq, 1, "fork point recorded");
    assert.equal(await backend.contentRefCountOfBody("c-alpha "), cRefBefore + 1, "one refcount bump per copied row");
    assert.ok(await backend.cloneSessionRows(cpSid, chSid, 1), "idempotent replay ok");
    assert.equal((await backend.getMessages(chSid)).length, 2, "replay is a no-op");
    assert.equal(await backend.cloneSessionRows(`sess-mysql-absent-${run}`, `${chSid}-orphan`, 5), false, "absent parent → false");

    // reap journal
    await backend.reapBlocks(sid, new Set(["b2"]), new Map([["b2", { one: null, full: { text: "orphaned", count: 0 } }]]));
    await backend.reapBlocks(sid, new Set(["b2"]), new Map(), );

    // archive → restore + gc
    const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-backend-mysql-archive-"));
    try {
        const archived = await backend.archiveSession(sid, { archiveDir });
        assert.ok(archived.ok && archived.exportPath, `archive ok (${archived.reason ?? ""})`);
        assert.ok(fs.existsSync(archived.exportPath!), "export landed on disk (local JSONL even for mysql)");
        assert.equal((await backend.getSessionRow(sid))!.status, "archived", "tombstone keeps the row");
        const restored = await backend.restoreArchived(sid, { archiveDir });
        assert.ok(restored.ok, `restore ok (${restored.reason ?? ""})`);
        assert.equal((await backend.getSessionRow(sid))!.status, "active", "restore reactivates");
        const gc = await backend.gc({ archiveAfterDays: 365, archiveDir, now: 9_000_000_000_000 });
        assert.ok(gc.archived >= 0 && gc.contentRowsDeleted >= 0, "gc returns counters");
    } finally {
        fs.rmSync(archiveDir, { recursive: true, force: true });
    }

    // conversation lookup + refcounted delete
    const sharedA = `sess-mysql-del-a-${run}`;
    const sharedB = `sess-mysql-del-b-${run}`;
    const shared = mkMsg("m-shared", "shared body ".repeat(50));
    assert.ok(await backend.ingestSession(planIngest(mkSession(sharedA, [shared]))));
    assert.ok(await backend.ingestSession(planIngest(mkSession(sharedB, [shared]))));
    const before = await backend.contentRefCountOfBody("shared body ");
    assert.ok(before >= 2, "shared content refcounted across sessions");
    await backend.deleteSession(sharedA);
    const after = await backend.contentRefCountOfBody("shared body ");
    assert.equal(after, before - 1, "delete releases exactly this session's refs");
    assert.equal(await backend.getSessionRow(sharedA), null, "row gone");
    await backend.deleteSession(sharedB);
    await backend.deleteSession(chSid);
    await backend.deleteSession(cpSid);
    await backend.deleteSession(sid);

    // verifyProjections on a fresh session
    const vSid = `sess-mysql-verify-${run}`;
    assert.ok(await backend.ingestSession(planIngest(mkSession(vSid, [mkMsg("m1", "verify ".repeat(40))]))));
    const verified = await backend.verifyProjections(vSid);
    assert.ok(verified.ok, `projections verified (${verified.ok ? verified.checks : verified.error})`);
    await backend.deleteSession(vSid);
});
