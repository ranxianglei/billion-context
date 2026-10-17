/**
 * Storage GC (#3463 step 1) — reclaiming bytes from the unified store.
 *
 * The unified index only grew: session deletion existed at the store level but
 * nothing invoked it from the file sweep, and even when rows WERE deleted
 * nothing reconciled refcount drift or returned freed pages to the OS. This
 * suite pins #3463's first step:
 *
 *   RECONCILE   — the audit detects all three drift classes (over-booked
 *                 leaks, under-booked premature-reclaim hazards, orphaned
 *                 zero-actual rows) and fix=true restores every drifted row to
 *                 its actually-counted value (#2671 §7 item 6, layer ② — the
 *                 verify command, --fix form; these raw UPDATEs are the CI
 *                 fixture-injection layer of item ③).
 *   RECLAIM     — zero-refcount CAS rows are collected; referenced rows always
 *                 survive, including when runGc orders audit-fix before reclaim.
 *   VACUUM      — after mass deletion, runGc's VACUUM shrinks index.db (deletes
 *                 alone only grow the freelist).
 *   PARITY      — the #1082 file sweep finally releases the unified side too: an
 *                 aged-out eligible file → index rows gone, exclusive CAS rows
 *                 reclaimed, shared CAS rows survive while any holder lives.
 *   HTTP        — POST /__bili/storage/gc rejects non-object bodies with 400 and
 *                 an unflagged run defaults to fix+vacuum ON.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, getStore, _setStoreForTest } from "../src/persist.ts";
import { UnifiedStore, type RefcountAuditReport } from "../src/storage/store.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { gcSessionFiles } from "../src/session-gc.ts";
import { defaultConfig, type CoreMessage } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.BILI_PERSIST_ZSTD = "0";
// Hermeticity contract shared by the storage suites: a developer machine with
// storage.unified in its real config must not leak a tier into these tests.
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-storagegc-hermetic-")),
    "no-config.json",
);
process.env.BILI_STORAGE_UNIFIED = "legacy";

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function msg(i: number, text: string): CoreMessage {
    return { id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text } as CoreMessage;
}

/** Message-only legacy record (no blocks) — exactly the shape of a GC-eligible
 *  session: compression artifacts are never GC targets (#1082), so eligible
 *  sessions carry their unified content only in the messages table. */
function mkMsgSession(id: string, bodies: string[]): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages: bodies.map((text, i) => msg(i, text)),
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
    };
}

// ---------------------------------------------------------------------------
// RECONCILE: drift detection + fix.
// ---------------------------------------------------------------------------

test("storage gc: reconcile detects over-booked drift and fix restores actual counts", async () => {
    const dir = tmpdir("bili-storagegc-overbooked-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            store.ingestSession(planIngest(mkMsgSession("s1", ["BODY-A"])));
            const { DatabaseSync } = await import("node:sqlite");
            const raw = new DatabaseSync(store.dbPath);
            try {
                raw.exec("UPDATE content SET refcount = refcount + 3");
            } finally {
                raw.close();
            }
            const rep: RefcountAuditReport = store.refcountAudit(false);
            assert.equal(rep.checked, 1);
            assert.equal(rep.overBooked, 1);
            assert.equal(rep.orphaned, 0);
            assert.equal(rep.underBooked, 0);
            assert.equal(rep.missingContentRefs, 0);
            assert.equal(rep.fixedRows, 0);
            // Report-only mode must not change anything.
            assert.equal(store.refcountAudit(false).overBooked, 1, "audit without fix must leave the drift in place");
            const fixed = store.refcountAudit(true);
            assert.equal(fixed.fixedRows, 1);
            assert.equal(store.refcountAudit(false).overBooked, 0, "fix must reset the booked count to the actually-counted refs");
            assert.equal(store.contentDedupReport().refcounted, 1);
        } finally {
            store.close();
        }
    } finally {
        rmrf(dir);
    }
});

test("storage gc: under-booked hazard is raised before reclaim can eat live bytes", async () => {
    const dir = tmpdir("bili-storagegc-underbooked-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            store.ingestSession(planIngest(mkMsgSession("s1", ["BODY-A"])));
            const { DatabaseSync } = await import("node:sqlite");
            const raw = new DatabaseSync(store.dbPath);
            try {
                raw.exec("UPDATE content SET refcount = 0");
            } finally {
                raw.close();
            }
            const rep = store.refcountAudit(false);
            assert.equal(rep.underBooked, 1, "a still-referenced row booked at zero is a premature-reclaim hazard");
            // The ordering guarantee: runGc reconciles (with fix) BEFORE
            // reclaiming, so the referenced row survives the pass.
            const gc = store.runGc({ fix: true, vacuum: false });
            assert.equal(gc.audit.underBooked, 1);
            assert.equal(gc.audit.fixedRows, 1);
            assert.equal(gc.reclaimed.rows, 0, "no zero-refcount garbage may exist here");
            assert.equal(store.contentDedupReport().rows, 1, "referenced row must survive the GC pass");
        } finally {
            store.close();
        }
    } finally {
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// RECLAIM: zero-refcount garbage collection.
// ---------------------------------------------------------------------------

test("storage gc: zero-refcount garbage is reclaimed, referenced rows untouched", async () => {
    const dir = tmpdir("bili-storagegc-reclaim-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            store.ingestSession(planIngest(mkMsgSession("s1", ["BODY-A"])));
            const { DatabaseSync } = await import("node:sqlite");
            const raw = new DatabaseSync(store.dbPath);
            try {
                // Garbage left behind by a hypothetical old bug: a CAS row
                // nobody references and nobody booked.
                raw.prepare(
                    "INSERT OR IGNORE INTO content(hash, byte_len, refcount, algo, bytes) VALUES (?, ?, ?, ?, ?)",
                ).run("deadbeefdeadbeef", 4096, 0, "sha256", Buffer.alloc(4096));
            } finally {
                raw.close();
            }
            const gc = store.runGc({ fix: true, vacuum: false });
            assert.equal(gc.audit.orphaned, 0, "booked==actual==0 is garbage, not drift");
            assert.equal(gc.reclaimed.rows, 1);
            assert.equal(gc.reclaimed.bytes, 4096);
            assert.equal(store.contentDedupReport().rows, 1, "the referenced row must survive");
            assert.equal(gc.sessions, 1);
            assert.ok(!gc.vacuum.ran && gc.vacuum.error === null, "vacuum off means skipped, not failed");
            assert.ok(gc.dbSizeBytesBefore >= 0 && gc.durationMs >= 0);
        } finally {
            store.close();
        }
    } finally {
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// VACUUM: freed pages actually return to the OS.
// ---------------------------------------------------------------------------

test("storage gc: vacuum returns freed pages to the OS (file shrinks)", () => {
    const dir = tmpdir("bili-storagegc-vacuum-");
    try {
        const dbPath = path.join(dir, "index.db");
        const ids: string[] = [];
        {
            const store = UnifiedStore.open(dbPath);
            for (let s = 0; s < 6; s++) {
                const id = `bulk-${s}`;
                ids.push(id);
                // ~500KB of unique content per session -> several MB total.
                const bodies = Array.from({ length: 5 }, (_, i) => `session ${s} chunk ${i} `.repeat(5_000));
                store.ingestSession(planIngest(mkMsgSession(id, bodies)));
            }
            store.close();
        }
        const sizeAfterIngest = fs.statSync(dbPath).size;
        {
            const store = UnifiedStore.open(dbPath);
            for (const id of ids) store.deleteSession(id);
            store.close(); // TRUNCATE checkpoint: freed pages land in the main file's freelist
        }
        const sizeAfterDelete = fs.statSync(dbPath).size;
        assert.ok(sizeAfterDelete >= sizeAfterIngest - 4096, "deletes alone must not shrink the file (freelist keeps the pages)");
        {
            const store = UnifiedStore.open(dbPath);
            try {
                const gc = store.runGc({ fix: false, vacuum: true });
                assert.ok(gc.vacuum.ran && gc.vacuum.error === null, `vacuum must succeed: ${gc.vacuum.error}`);
            } finally {
                store.close();
            }
        }
        const sizeAfterVacuum = fs.statSync(dbPath).size;
        assert.ok(sizeAfterVacuum < sizeAfterDelete, `VACUUM must shrink the file (${sizeAfterVacuum} not < ${sizeAfterDelete})`);
        assert.ok(sizeAfterVacuum < sizeAfterIngest, "post-GC file must sit below the pre-delete high-water mark");
    } finally {
        rmrf(dir);
    }
});

// ---------------------------------------------------------------------------
// PARITY: the file sweep releases the unified side (#3463 gap close).
// ---------------------------------------------------------------------------

/** v3 envelope JSON matching the shape viewFromParsed reads (never-compressed,
 *  small — eligible once aged out). */
function envelope(id: string, ageDays: number): string {
    const savedAt = Date.now() - ageDays * 86_400_000;
    return JSON.stringify({
        version: 3,
        savedAt,
        id,
        payload: {
            version: 3,
            savedAt,
            id,
            meta: { protocol: "anthropic", upstreamOrigin: "https://api.example.com" },
            stats: { requests: 3, contextTokens: 8000 },
            createdAt: savedAt,
            state: { blocks: [] },
            blockContents: {},
        },
    });
}

function writeFile(dir: string, rel: string, content: string, ageDays = 0): void {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    if (ageDays > 0) {
        const t = (Date.now() - ageDays * 86_400_000) / 1000;
        fs.utimesSync(p, t, t);
    }
}

test("storage gc parity: file sweep releases unified rows and exclusive CAS refs", async () => {
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    const prevGc = process.env.BILI_SESSION_GC;
    const prevXdg = process.env.XDG_STATE_HOME;
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "bili-storagegc-xdg-"));
    process.env.BILI_STORAGE_UNIFIED = "1";
    process.env.BILI_SESSION_GC = "1";
    process.env.XDG_STATE_HOME = xdg;
    const dir = tmpdir("bili-storagegc-parity-");
    try {
        const dbPath = path.join(dir, "index.db");
        const SHARED = "shared-body-must-survive";
        {
            const idx = UnifiedStore.open(dbPath);
            idx.ingestSession(planIngest(mkMsgSession("gc-a", [SHARED, "exclusive-a"])));
            idx.ingestSession(planIngest(mkMsgSession("gc-b", [SHARED, "exclusive-b"])));
            idx.ingestSession(planIngest(mkMsgSession("gc-c", [SHARED])));
            idx.close();
        }
        writeFile(dir, "anthropic/host_gc-a.json", envelope("gc-a", 10), 10);
        writeFile(dir, "anthropic/host_gc-b.json", envelope("gc-b", 10), 10);
        writeFile(dir, "anthropic/host_gc-c.json", envelope("gc-c", 0));
        const store = new SessionStore({ dir, debounceMs: 500 });
        try {
            const res = await gcSessionFiles({ dir, store, now: Date.now() });
            assert.equal(res.removed, 2, "both aged-out files must be swept");
            assert.equal(res.kept, 1, "the fresh session must survive");
            const idx = UnifiedStore.open(dbPath);
            try {
                assert.equal(idx.getSessionRow("gc-a"), null, "a swept session's index row must be released");
                assert.equal(idx.getSessionRow("gc-b"), null);
                assert.ok(idx.getSessionRow("gc-c"), "the kept session's row must survive");
                const dedup = idx.contentDedupReport();
                assert.equal(dedup.rows, 1, "exclusive bodies reclaimed; the shared body held by the kept session must survive");
                assert.equal(dedup.refcounted, 1);
                const audit = idx.refcountAudit(false);
                assert.equal(audit.checked, 1);
                assert.equal(audit.overBooked + audit.underBooked + audit.orphaned, 0, "post-sweep reconcile must be clean");
            } finally {
                idx.close();
            }
        } finally {
            store.closeQuietly();
        }
    } finally {
        if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prevUnified;
        if (prevGc === undefined) delete process.env.BILI_SESSION_GC; else process.env.BILI_SESSION_GC = prevGc;
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(dir);
        rmrf(xdg);
    }
});

// ---------------------------------------------------------------------------
// HTTP surface: POST /__bili/storage/gc (loopback-gated ops route).
// ---------------------------------------------------------------------------

test("storage gc http: non-object bodies are 400, unflagged run defaults to fix+vacuum", async () => {
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    const prevSessions = process.env.BILI_SESSIONS_DIR;
    const prevXdg = process.env.XDG_STATE_HOME;
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "bili-storagegc-xdg-http-"));
    const dir = tmpdir("bili-storagegc-http-");
    process.env.BILI_STORAGE_UNIFIED = "1";
    process.env.BILI_SESSIONS_DIR = dir;
    process.env.XDG_STATE_HOME = xdg;
    try {
        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1:1",
            routes: {},
            proxy: "",
            proxyMode: "direct",
            proxySource: "direct",
            modelContextLimit: 400_000,
            kernelConfig: defaultConfig(400_000),
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: false,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            compat: { roles: {} },
            streamErrorShape: "protocol",
            passthroughSource: null,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            advisoryCheck: false,
            releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        const store = getStore(); // the singleton startServer serves from (unified sidecar in dir)
        const proxy = await startServer(opts);
        if (!proxy.listening) await once(proxy, "listening");
        const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
        try {
            for (const body of ["null", "[true]", '"gc"', "42"]) {
                const bad = await fetch(`${base}/__bili/storage/gc`, { method: "POST", body });
                assert.equal(bad.status, 400, `non-object body ${body} must be rejected with 400`);
                assert.equal(((await bad.json()) as { ok: boolean }).ok, false);
            }
            const flag = await fetch(`${base}/__bili/storage/gc`, { method: "POST", body: JSON.stringify({ fix: "yes" }) });
            assert.equal(flag.status, 400, "a wrong-typed option must be rejected with 400");
            const res = await fetch(`${base}/__bili/storage/gc`, { method: "POST" });
            assert.equal(res.status, 200);
            const rep = (await res.json()) as { ok: boolean; audit: { checked: number }; reclaimed: { rows: number }; vacuum: { ran: boolean } };
            assert.equal(rep.ok, true);
            assert.equal(rep.audit.checked, 0, "fresh store has no content to audit");
            assert.equal(rep.reclaimed.rows, 0);
            assert.equal(rep.vacuum.ran, true, "unflagged run defaults to fix+vacuum ON");
        } finally {
            await new Promise<void>((resolve, reject) => proxy.close((err) => (err ? reject(err) : resolve())));
            // The server's store keeps index.db open; on Windows unlinking an open file
            // fails with EBUSY, so close the handle before the dir rmrf below.
            store.closeQuietly();
            _setStoreForTest(new SessionStore({ enabled: false }));
        }
    } finally {
        if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prevUnified;
        if (prevSessions === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prevSessions;
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(dir);
        rmrf(xdg);
    }
});
