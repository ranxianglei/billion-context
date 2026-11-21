import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInitialState } from "acp-kernel";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { parseArgs } from "../src/cli.ts";
import { runSessionsCommand, runStorageGcCommand } from "../src/storage-maintenance.ts";
import { UnifiedStore } from "../src/storage/store.ts";

/**
 * #3928 — CLI surface for storage maintenance: `bili sessions ls/rm/archive/restore`
 * + `bili storage gc`. Everything wraps the store APIs the HTTP endpoints use
 * (#3911); these tests demonstrate each command against a scratch store and pin
 * gc parity: the CLI path and the direct store.gc()/unifiedGc() path must report
 * identical {archived, contentRowsDeleted} on equivalent scratch stores.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-storage-maint-")),
    "no-config.json",
);

const DAY_MS = 86_400_000;

function makeSession(id: string, label?: string, lastSeen = Date.now()): Session {
    return {
        id,
        meta: { protocol: "responses", upstreamOrigin: "https://api.openai.com/v1", title: `title-${id}`, ...(label ? { label } : {}) },
        stats: { requests: 12, tokensSaved: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 50, cacheSamples: 1, lastInputTokens: 100, contextTokens: 99000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        createdAt: 1_000,
        lastSeen,
        state: createInitialState(),
        pendingRetrievals: [],
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

async function seed(dir: string, sessions: Array<[string, string?, number?]>): Promise<void> {
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    try {
        for (const [id, label, lastSeen] of sessions) await store.writeNow(makeSession(id, label, lastSeen));
    } finally {
        store.closeQuietly();
    }
}

interface CoreMsg { id: string; role: string; contentType: string; text: string }
const mkMsg = (id: string, text: string): CoreMsg => ({ id, role: "user", contentType: "text", text });

const mkLegacy = (id: string, msgs: CoreMsg[], lastSeen: number, label?: string): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen,
    meta: { protocol: "openai", ...(label ? { label } : {}) },
    stats: {},
    metadata: {},
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

/** DB-direct seeding (no JSON files): controls updated_at exactly, like the #3901 fixture. */
function seedDb(dir: string, entries: Array<[string, CoreMsg[], number, string?]>): void {
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    try {
        for (const [id, msgs, lastSeen, label] of entries) store.ingestSession(planIngest(mkLegacy(id, msgs, lastSeen, label)));
    } finally {
        store.close();
    }
}

/** Runs fn, recording any process.exit(code) call instead of dying (parseArgs usage errors). */
async function captureExit(fn: () => void | Promise<void>): Promise<number | undefined> {
    const prevExit = process.exit;
    let code: number | undefined;
    process.exit = ((c?: number) => { code = c ?? 0; }) as typeof process.exit;
    try {
        await fn();
    } finally {
        process.exit = prevExit;
    }
    return code;
}

test("parseArgs: sessions + storage forms", async () => {
    assert.deepEqual(await captureExit(() => {
        const p = parseArgs(["sessions", "ls"]);
        assert.equal(p.command, "sessions");
        assert.equal(p.sessionsSub, "ls");
        assert.equal(parseArgs(["sessions", "rm", "abc", "--no-vacuum"]).sessionsTarget, "abc");
        assert.equal(parseArgs(["sessions", "rm", "abc", "--no-vacuum"]).sessionsNoVacuum, true);
        assert.equal(parseArgs(["sessions", "archive", "abc"]).sessionsSub, "archive");
        assert.equal(parseArgs(["sessions", "restore", "abc"]).sessionsSub, "restore");
        const g = parseArgs(["storage", "gc", "--days", "7", "--vacuum", "incremental", "--dry-run"]);
        assert.equal(g.command, "storage");
        assert.equal(g.storageDays, 7);
        assert.equal(g.storageVacuum, "incremental");
        assert.equal(g.storageDryRun, true);
    }), undefined);

    assert.equal(await captureExit(() => { parseArgs(["sessions", "frobnicate"]); }), 2);
    assert.equal(await captureExit(() => { parseArgs(["sessions", "rm"]); }), 2);
    assert.equal(await captureExit(() => { parseArgs(["storage"]); }), 2);
    assert.equal(await captureExit(() => { parseArgs(["storage", "vacuum"]); }), 2);
    assert.equal(await captureExit(() => { parseArgs(["storage", "gc", "--days", "-1"]); }), 2);
    assert.equal(await captureExit(() => { parseArgs(["storage", "gc", "--days", "x"]); }), 2);
    assert.equal(await captureExit(() => { parseArgs(["storage", "gc", "--vacuum", "half"]); }), 2);
});

test("sessions ls: id/label/size/last-updated/status, sorted by recency", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maint-ls-"));
    try {
        await seed(dir, [["s-old", "old-label", Date.now() - 5 * DAY_MS], ["s-new", "new-label"]]);
        const r = await runSessionsCommand({ sub: "ls", dir });
        assert.equal(r.code, 0);
        assert.match(r.text, /s-new/);
        assert.match(r.text, /new-label/);
        assert.match(r.text, /s-old/);
        assert.match(r.text, /active/);
        // newest first
        assert.ok(r.text.indexOf("s-new") < r.text.indexOf("s-old"), `expected s-new before s-old in:\n${r.text}`);
        const j = JSON.parse((await runSessionsCommand({ sub: "ls", dir, json: true })).text) as Array<{ id: string; sizeBytes: number; status: string }>;
        assert.equal(j.length, 2);
        assert.equal(j[0].id, "s-new");
        assert.ok(j[0].sizeBytes > 0, "decoded bytes must be counted");
        assert.equal(j[0].status, "active");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("sessions ls: never materializes the corpus (loadAll-free, #6795)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maint-ls-noload-"));
    try {
        await seed(dir, [["ls-a", "a-label"], ["ls-b", "b-label"]]);
        const orig = SessionStore.prototype.loadAll;
        SessionStore.prototype.loadAll = (async () => {
            throw new Error("loadAll must not be called by `sessions ls` (#6795)");
        }) as typeof orig;
        try {
            const r = await runSessionsCommand({ sub: "ls", dir });
            assert.equal(r.code, 0, r.text);
            assert.match(r.text, /ls-a/);
            assert.match(r.text, /ls-b/);
            assert.match(r.text, /a-label/);
        } finally {
            SessionStore.prototype.loadAll = orig;
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("sessions ls: legacy files survive with no index rows (index.db removed)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maint-ls-nodb-"));
    try {
        await seed(dir, [["nodb-1", "file-only-label"]]);
        for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dir, "index.db" + suffix), { force: true });
        const r = await runSessionsCommand({ sub: "ls", dir, json: true });
        assert.equal(r.code, 0, r.text);
        const j = JSON.parse(r.text) as Array<{ id: string; label: string; sizeBytes: number; status: string }>;
        assert.equal(j.length, 1);
        assert.equal(j[0].id, "nodb-1");
        assert.equal(j[0].label, "file-only-label");
        assert.ok(j[0].sizeBytes > 0, `file footprint must still be reported`);
        assert.equal(j[0].status, "active");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("sessions ls: index-only rows (no legacy file) list with the DB footprint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maint-ls-dbonly-"));
    try {
        seedDb(dir, [["dbonly-1", [mkMsg("m1", "index only ".repeat(80))], Date.now(), "db-only-label"]]);
        const r = await runSessionsCommand({ sub: "ls", dir, json: true });
        assert.equal(r.code, 0, r.text);
        const j = JSON.parse(r.text) as Array<{ id: string; label: string; sizeBytes: number; status: string }>;
        assert.equal(j.length, 1);
        assert.equal(j[0].id, "dbonly-1");
        assert.equal(j[0].label, "db-only-label");
        assert.ok(j[0].sizeBytes > 0, `DB footprint (inlineBytes + casExclusiveBytes) must be reported, not 0`);
        assert.equal(j[0].status, "active");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("sessions ls: a corrupt file is skipped, never quarantined (read-only lane)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maint-ls-corrupt-"));
    try {
        await seed(dir, [["good-1", "still-here"]]);
        const corruptPath = path.join(dir, "zz-corrupt.json");
        fs.writeFileSync(corruptPath, "{not json");
        const r = await runSessionsCommand({ sub: "ls", dir, json: true });
        assert.equal(r.code, 0, r.text);
        const j = JSON.parse(r.text) as Array<{ id: string }>;
        assert.deepEqual(j.map((x) => x.id), ["good-1"]);
        assert.ok(fs.existsSync(corruptPath), "ls must not rename/quarantine operator files");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("sessions archive/restore: tombstone status, single archive.jsonl line, rows round-trip", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maint-archive-"));
    try {
        seedDb(dir, [["s-a", [mkMsg("m1", "archive me ".repeat(50))], Date.now(), "keep-me"]]);
        const dbPath = path.join(dir, "index.db");
        const before = UnifiedStore.open(dbPath);
        assert.equal(before.getMessages("s-a").length > 0, true);
        before.close();

        const arc = await runSessionsCommand({ sub: "archive", target: "s-a", dir });
        assert.equal(arc.code, 0, arc.text);
        assert.match(arc.text, /archive\.jsonl/);

        const dbMid = UnifiedStore.open(dbPath);
        assert.equal(dbMid.getSessionRow("s-a")?.status, "archived");
        assert.equal(dbMid.getMessages("s-a").length, 0);
        dbMid.close();
        const logFile = path.join(dir, "archive", "archive.jsonl");
        assert.equal(fs.readFileSync(logFile, "utf8").trim().split("\n").length, 1);

        const rst = await runSessionsCommand({ sub: "restore", target: "s-a", dir });
        assert.equal(rst.code, 0, rst.text);
        const dbAfter = UnifiedStore.open(dbPath);
        assert.equal(dbAfter.getSessionRow("s-a")?.status, "active");
        assert.equal(dbAfter.getMessages("s-a").length > 0, true);
        dbAfter.close();
        // restore rewrites the log without the restored session's line
        assert.equal(fs.readFileSync(logFile, "utf8").trim().split("\n").filter((l) => l.includes("\"s-a\"")).length, 0);

        // unknown ids fail cleanly
        assert.equal((await runSessionsCommand({ sub: "archive", target: "ghost", dir })).code, 1);
        assert.equal((await runSessionsCommand({ sub: "restore", target: "ghost", dir })).code, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("sessions rm: files + rows released, zero-ref content collected; unknown id fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maint-rm-"));
    try {
        await seed(dir, [["s-rm", "doomed"]]);
        const r = await runSessionsCommand({ sub: "rm", target: "s-rm", dir });
        assert.equal(r.code, 0, r.text);
        assert.match(r.text, /released/i);

        const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
        try {
            assert.deepEqual(await store.findSessionFiles("s-rm"), []);
        } finally {
            store.closeQuietly();
        }
        const db = UnifiedStore.open(path.join(dir, "index.db"));
        assert.equal(db.sessionUpdatedAt("s-rm"), null);
        assert.equal(db.contentZeroRefReport().rows, 0);
        assert.equal(db.listSessionIds().includes("s-rm"), false);
        db.close();

        const miss = await runSessionsCommand({ sub: "rm", target: "ghost", dir });
        assert.equal(miss.code, 1);
        assert.match(miss.text, /no session found/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("storage gc --dry-run: prints plan, changes nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maint-gcdr-"));
    try {
        seedDb(dir, [
            ["s-stale", [mkMsg("m-old", "ancient body ".repeat(50))], Date.now() - 400 * DAY_MS, "stale-label"],
            ["s-fresh", [mkMsg("m-new", "fresh body ".repeat(50))], Date.now() - DAY_MS],
        ]);
        const r = await runStorageGcCommand({ days: 365, dryRun: true, dir });
        assert.equal(r.code, 0, r.text);
        assert.match(r.text, /s-stale/);
        assert.doesNotMatch(r.text, /s-fresh/);
        assert.match(r.text, /zero-ref/);
        const db = UnifiedStore.open(path.join(dir, "index.db"));
        assert.equal(db.getSessionRow("s-stale")?.status, "active");
        db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("storage gc: e2e numbers match the direct store.gc() path on an equivalent store", async () => {
    const seedPair = (tag: string): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `maint-gc-${tag}-`));
        seedDb(dir, [
            ["s-stale", [mkMsg("m-old", "ancient body ".repeat(50))], Date.now() - 400 * DAY_MS, "stale-label"],
            ["s-fresh", [mkMsg("m-new", "fresh body ".repeat(50))], Date.now() - DAY_MS],
        ]);
        return dir;
    };

    const cliDir = seedPair("cli");
    const refDir = seedPair("ref");
    try {
        const r = await runStorageGcCommand({ days: 365, vacuum: "incremental", json: true, dir: cliDir });
        assert.equal(r.code, 0, r.text);
        const cli = JSON.parse(r.text) as { result?: { archived: number; contentRowsDeleted: number } };
        assert.ok(cli.result, "a real run must report its result");

        // same facade call the HTTP endpoint uses — the CLI must not diverge from it
        const facadeStore = new SessionStore({ dir: cliDir, enabled: true, debounceMs: 0 });
        const again = facadeStore.unifiedGc({ archiveAfterDays: 365, vacuum: "incremental" });
        facadeStore.closeQuietly();
        assert.deepEqual(again, { archived: 0, contentRowsDeleted: 0 }, "second sweep on the collected store is a no-op");

        const refStore = UnifiedStore.open(path.join(refDir, "index.db"));
        const ref = refStore.gc({ archiveAfterDays: 365, archiveDir: path.join(refDir, "archive"), vacuum: "incremental" });
        refStore.close();

        assert.equal(cli.result.archived, ref.archived);
        assert.equal(cli.result.contentRowsDeleted, ref.contentRowsDeleted);
        assert.ok(ref.archived >= 1, "the stale session must be swept");
    } finally {
        for (const d of [cliDir, refDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("legacy-only lane: archive/restore/gc refuse with the unified-store hint; ls/rm still work", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maint-legacy-"));
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "legacy";
    try {
        await seed(dir, [["s-leg", "legacy-label"]]);
        const arc = await runSessionsCommand({ sub: "archive", target: "s-leg", dir });
        assert.equal(arc.code, 1);
        assert.match(arc.text, /BILI_STORAGE_UNIFIED/);
        const rst = await runSessionsCommand({ sub: "restore", target: "s-leg", dir });
        assert.equal(rst.code, 1);
        assert.match(rst.text, /BILI_STORAGE_UNIFIED/);
        const gc = await runStorageGcCommand({ days: 365, dir });
        assert.equal(gc.code, 1);
        assert.match(gc.text, /BILI_STORAGE_UNIFIED/);

        const ls = await runSessionsCommand({ sub: "ls", dir });
        assert.equal(ls.code, 0);
        assert.match(ls.text, /s-leg/);
        const rm = await runSessionsCommand({ sub: "rm", target: "s-leg", dir });
        assert.equal(rm.code, 0, rm.text);
    } finally {
        if (prevMode === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prevMode;
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
