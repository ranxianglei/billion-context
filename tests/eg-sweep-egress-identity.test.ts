/**
 * eg 系列扫尾 (proposal discussions/7735, KDD #25) — the four fixes land as
 * ONE sweep:
 *   1. egress-mode table creation gate: a fresh eg-mode database gets EXACTLY
 *      the core trio (sessions/session_ext/kv_store) plus the four egress
 *      tables — none of the 12 legacy tables; a later open with the gate off
 *      converges them back in (probe-first, nothing ever dropped);
 *   2. the minimal identity row: the first armed request lands a sessions
 *      row (first row already carries metadata.egressAuthority=true) BEFORE
 *      the egress append and before any flush — idempotent per-turn upsert,
 *      first-parent-wins lineage, self-healing;
 *   3. the arm turn's dead l1_world row is cleaned in the same transaction
 *      (armed rows and R3 breaker latch rows survive);
 *   4. kv hygiene: the 256-char value cap (frozen whitelist for the two
 *      known growing keys) plus the eg-mode retirement of the three big
 *      blobs (session-order / plugin-conversations / prefix-affinity for
 *      identified clients).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { UnifiedStore, KV_VALUE_MAX_CHARS, KV_VALUE_WHITELIST } from "../src/storage/store.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { setLogCapture } from "../src/logger.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
const hermetic = mkdtempSync(join(tmpdir(), "bili-eg-sweep-hermetic-"));
process.env.BILI_CONFIG_FILE = join(hermetic, "no-config.json");
const testRoot = mkdtempSync(join(tmpdir(), "bili-eg-sweep-"));
function rmBestEffort(p: string): void {
    try { rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* leaked temp dir is harmless */ }
}
test.after(() => rmBestEffort(testRoot));

const MODEL = "claude-test";

type Db = ReturnType<typeof openSqliteDatabase>["db"];

function tablesOf(db: Db): string[] {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((r) => r.name)
        .filter((n) => !n.startsWith("sqlite_"))
        .sort();
}

const EG_CORE_TABLES = ["egress_block_flow", "egress_block_state", "egress_flow", "egress_state", "kv_store", "session_ext", "sessions"];
const LEGACY_TABLES = ["blocks", "checkpoints", "ccr_entries", "conversations", "content", "dead_refs", "l1_world", "message_media", "messages", "orphan_blocks", "refs", "state_fields"];

// ---------------------------------------------------------------------------
// A1: the table creation gate (fresh eg db = 7 tables; convergence back to 19)
// ---------------------------------------------------------------------------

test("A1: fresh egress-mode database creates exactly the 7 core+egress tables; a legacy open converges the 12 back in", () => {
    const dir = mkdtempSync(join(testRoot, "a1-"));
    const { db } = openSqliteDatabase(join(dir, "index.db"));
    try {
        migrateSchema(db, { legacyTables: false });
        assert.deepEqual(tablesOf(db), EG_CORE_TABLES, `fresh eg db tables (got ${tablesOf(db).join(", ")})`);
        // Convergence: the same file reopened with the gate ON (egressPlane
        // flipped off) must get the 12 legacy tables back in one probe pass.
        migrateSchema(db); // default: legacyTables = true
        const all = tablesOf(db);
        for (const t of [...EG_CORE_TABLES, ...LEGACY_TABLES]) assert.ok(all.includes(t), `converged db carries ${t}`);
        assert.equal(all.length, EG_CORE_TABLES.length + LEGACY_TABLES.length, `exactly 19 tables after convergence (got ${all.length})`);
    } finally {
        db.close();
        rmBestEffort(dir);
    }
});

test("A1b: a fresh LEGACY database is unchanged (all 19 tables, as before this change)", () => {
    const dir = mkdtempSync(join(testRoot, "a1b-"));
    const { db } = openSqliteDatabase(join(dir, "index.db"));
    try {
        migrateSchema(db);
        assert.equal(tablesOf(db).length, 19, `legacy fresh db keeps all 19 tables (got ${tablesOf(db).join(", ")})`);
    } finally {
        db.close();
        rmBestEffort(dir);
    }
});

// ---------------------------------------------------------------------------
// A2: the minimal identity row (store level)
// ---------------------------------------------------------------------------

function openLegacyStore(dir: string): UnifiedStore {
    // Open with the gate OFF so the legacy tables exist (the identity row
    // method serves both shapes; eg-mode DBs simply skip the l1 cleanup).
    const saved = process.env.BILI_ROLLOUT_EGRESS_PLANE;
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "0";
    let store: UnifiedStore;
    try {
        store = UnifiedStore.open(join(dir, "index.db"));
    } finally {
        if (saved === undefined) delete process.env.BILI_ROLLOUT_EGRESS_PLANE; else process.env.BILI_ROLLOUT_EGRESS_PLANE = saved;
    }
    return store;
}

function identityInput(sid: string, over: Partial<Parameters<UnifiedStore["ensureEgressIdentity"]>[0]> = {}) {
    return {
        sessionId: sid,
        parentSessionId: null,
        protocol: "openai",
        label: "host-" + sid,
        title: "first title",
        hostTitle: null,
        namespace: "dsh",
        origin: "http://127.0.0.1:8199",
        createdAt: 1000,
        updatedAt: 2000,
        metaJson: JSON.stringify({ protocol: "openai" }),
        metadataJson: JSON.stringify({ egressAuthority: true, pluginAgent: "dsh" }),
        ...over,
    };
}

test("A2: the identity row lands on the FIRST call with egressAuthority already in the row; re-runs are idempotent upserts (latest-wins, one row)", () => {
    const dir = mkdtempSync(join(testRoot, "a2-"));
    const store = openLegacyStore(dir);
    const db = (store as unknown as { db: Db }).db;
    try {
        store.ensureEgressIdentity(identityInput("s1"));
        const rows = db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];
        assert.equal(rows.length, 1, "one row");
        assert.equal(rows[0].session_id, "s1");
        assert.equal(rows[0].namespace, "dsh");
        assert.equal(rows[0].status, "active");
        assert.equal(rows[0].fork_point_seq, null, "identity never writes fork_point_seq (fork path only)");
        const metadata = JSON.parse(String(rows[0].metadata_json)) as Record<string, unknown>;
        assert.equal(metadata.egressAuthority, true, "the FIRST row already carries egressAuthority=true (the #7591 §2.1 claim, now true)");
        const meta = JSON.parse(String(rows[0].meta_json)) as Record<string, unknown>;
        assert.equal(meta.protocol, "openai", "meta_json lands (the 13th live column the 12-column list missed)");
        // payload columns stay at their DDL defaults for an egress-on row
        // (the '{}' defaults for stats/kstate/tail; NULL for the rest) —
        // never written
        const defaults: Record<string, unknown> = { stats_json: "{}", kstate_json: "{}", tail_json: "{}", ccr_json: null, orphans_json: null, last_ingested_seq: null };
        for (const col of Object.keys(defaults)) {
            assert.equal(rows[0][col], defaults[col], `payload column ${col} stays at its DDL default`);
        }
        // second turn: descriptive + metadata latest-wins, still one row
        store.ensureEgressIdentity(identityInput("s1", { title: "second title", updatedAt: 3000, metadataJson: JSON.stringify({ egressAuthority: true, lastModel: "m" }) }));
        const again = db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];
        assert.equal(again.length, 1, "idempotent — still one row");
        assert.equal(again[0].title, "second title");
        assert.equal(again[0].updated_at, 3000);
        assert.equal(JSON.parse(String(again[0].metadata_json)).lastModel, "m");
        assert.equal(again[0].created_at, 1000, "created_at never moves");
    } finally {
        try { store.close(); } catch { /* already closed */ }
        rmBestEffort(dir);
    }
});

test("A2b: lineage survives identity upserts — a pre-inserted fork row keeps its parent + fork_point_seq; first parent wins on a bare row", () => {
    const dir = mkdtempSync(join(testRoot, "a2b-"));
    const store = openLegacyStore(dir);
    const db = (store as unknown as { db: Db }).db;
    try {
        // point-fork child shape (written by the fork path, store.ts fork):
        db.prepare("INSERT INTO sessions (session_id, parent_session_id, fork_point_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
            .run("child", "parent", 7, 1000, 1000);
        store.ensureEgressIdentity(identityInput("child", { parentSessionId: "WRONG" }));
        const row = db.prepare("SELECT * FROM sessions WHERE session_id = 'child'").get() as Record<string, unknown>;
        assert.equal(row.parent_session_id, "parent", "first parent wins — the upsert must not clobber fork lineage");
        assert.equal(row.fork_point_seq, 7, "fork_point_seq untouched");
        // bare row: an identity-provided parent is adopted once, then frozen
        db.prepare("INSERT INTO sessions (session_id, created_at, updated_at) VALUES ('p', 1000, 1000)").run();
        store.ensureEgressIdentity(identityInput("p", { parentSessionId: "orig" }));
        store.ensureEgressIdentity(identityInput("p", { parentSessionId: "later" }));
        const prow = db.prepare("SELECT parent_session_id FROM sessions WHERE session_id = 'p'").get() as { parent_session_id: string | null };
        assert.equal(prow.parent_session_id, "orig", "the first non-null parent wins; later inputs do not move it");
    } finally {
        try { store.close(); } catch { /* already closed */ }
        rmBestEffort(dir);
    }
});

// ---------------------------------------------------------------------------
// A3: the arm turn's dead l1_world row — cleaned, with the R3/armed guards
// ---------------------------------------------------------------------------

test("A3: the identity transaction deletes the arm turn's dead l1 row and spares armed rows and R3 breaker latch rows", () => {
    const dir = mkdtempSync(join(testRoot, "a3-"));
    const store = openLegacyStore(dir);
    const db = (store as unknown as { db: Db }).db;
    try {
        const mk = (sid: string, opts: { witness?: string; armed?: number; r3?: number }): void => {
            db.prepare("INSERT INTO l1_world (sess_raw, ledger_id, witness_probe, issued_at, armed_at, r3_latched_at) VALUES (?, ?, ?, ?, ?, ?)")
                .run(sid, sid, opts.witness ?? "wp", 1000, opts.armed ?? null, opts.r3 ?? null);
        };
        mk("dead", {});                       // the arm-turn dead row (witness set, nothing latched)
        mk("r3", { witness: "", r3: 123 });   // R3 breaker latch row
        mk("armed", { armed: 123 });          // an armed identity row
        store.ensureEgressIdentity(identityInput("dead"));
        store.ensureEgressIdentity(identityInput("r3"));
        store.ensureEgressIdentity(identityInput("armed"));
        const rows = db.prepare("SELECT sess_raw FROM l1_world ORDER BY sess_raw").all() as { sess_raw: string }[];
        assert.deepEqual(rows.map((r) => r.sess_raw), ["armed", "r3"], `only the dead row is removed (got ${rows.map((r) => r.sess_raw).join(", ")})`);
    } finally {
        try { store.close(); } catch { /* already closed */ }
        rmBestEffort(dir);
    }
});

// ---------------------------------------------------------------------------
// A4: the kv 256-char cap + frozen whitelist
// ---------------------------------------------------------------------------

test("A4: setKv enforces the 256-char cap; whitelisted keys pass; the tripwire names the offender", () => {
    const dir = mkdtempSync(join(testRoot, "a4-"));
    const store = openLegacyStore(dir);
    try {
        // the cap counts the STORED (JSON-stringified) value: 254 x's
        // stringify to exactly 256 chars (quotes included)
        store.setKv("notices", "ok", "x".repeat(KV_VALUE_MAX_CHARS - 2));
        assert.throws(
            () => store.setKv("notices", "big", "x".repeat(KV_VALUE_MAX_CHARS - 1)),
            (err: Error) => err.message.includes("kv value too large") && err.message.includes("notices|big"),
        );
        for (const entry of KV_VALUE_WHITELIST) {
            const [ns, key] = entry.split("|");
            store.setKv(ns, key, "y".repeat(10_000));
            assert.ok(store.getKv(ns, key) !== undefined, `${entry} is whitelisted`);
        }
    } finally {
        try { store.close(); } catch { /* already closed */ }
        rmBestEffort(dir);
    }
});

// ---------------------------------------------------------------------------
// B: fresh-DB invariants end to end (real server, pinned plugin lane)
// ---------------------------------------------------------------------------

const SAVED_PLANE = process.env.BILI_ROLLOUT_EGRESS_PLANE;

async function harness(plane: string): Promise<{ dir: string; store: SessionStore; base: string; origin: string; close: () => Promise<void> }> {
    const dir = mkdtempSync(join(testRoot, "b-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_ROLLOUT_EGRESS_PLANE = plane;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    setLogCapture(null);
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 15 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chat_test", object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { [MODEL]: { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: false, injectNudge: false, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    return {
        dir,
        store,
        origin: `http://127.0.0.1:${paddr.port}`,
        base: `http://127.0.0.1:${paddr.port}/bili/${upstreamUrl}/v1/chat/completions`,
        close: async () => {
            store.cancelAll();
            proxy.close();
            proxy.closeIdleConnections?.();
            upstream.close();
            upstream.closeIdleConnections?.();
            await Promise.all([once(proxy, "close"), once(upstream, "close")]);
        },
    };
}

const m = (role: "user" | "assistant", i: number) => ({ role, content: `message-${i} ${"x".repeat(32)}-${i}` });
const HISTORY = [m("user", 1), m("assistant", 2), m("user", 3), m("assistant", 4), m("user", 5)];

async function turn(base: string, convId: string, messages: unknown[]): Promise<void> {
    const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": convId },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: false, messages, biliMsgIds: messages.map((_, i) => `${convId}-id-${i}`) }),
    });
    assert.equal(res.status, 200, `turn ${convId}: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

/** The egress record lands at the debounced SAVE — wait for two quiet flushes
 *  (same settle discipline as egress-authority-pinned.test.ts). */
async function settle(store: SessionStore, sid: string): Promise<void> {
    const race = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);
    assert.equal(await race(store.afterNextFlush(sid), 10_000), true, "first debounced flush landed");
    assert.equal(await race(store.afterNextFlush(sid), 10_000), true, "second flush settled");
}

function readOnlyDb(p: string): InstanceType<typeof DatabaseSync> {
    return new DatabaseSync(p, { readOnly: true });
}

test("B1: fresh eg-mode database after a real pinned lane — exactly 7 tables, identity row first request, no big kv blobs", async () => {
    const h = await harness("1");
    try {
        // --- the identity row lands with the FIRST request (before any flush)
        await turn(h.base, "p1", HISTORY.slice(0, 3));
        {
            const db = readOnlyDb(join(h.dir, "sessions", "index.db"));
            try {
                const row = db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];
                assert.equal(row.length, 1, "the first armed request lands exactly one sessions row (synchronously, pre-flush)");
                assert.equal(row[0].session_id, "p1");
                assert.equal(JSON.parse(String(row[0].metadata_json)).egressAuthority, true, "first row already carries egressAuthority=true");
                assert.equal(row[0].namespace, "dsh", "identity columns mirror the ingest mapping (pluginAgent → namespace)");
                const flow = db.prepare("SELECT COUNT(*) AS n FROM egress_flow").get() as { n: number };
                assert.ok(flow.n >= 3, "the op log holds the bootstrap rows (eg tables write first, as before)");
            } finally { db.close(); }
        }
        await turn(h.base, "p1", HISTORY.slice(0, 5));
        await settle(h.store, "p1");
        // --- the full fresh-DB invariant (acceptance criterion 1)
        const db = readOnlyDb(join(h.dir, "sessions", "index.db"));
        try {
            const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
                .map((r) => r.name).filter((n) => !n.startsWith("sqlite_")).sort();
            assert.deepEqual(tables, EG_CORE_TABLES, `fresh eg db after real traffic has exactly the 7 core+egress tables (got ${tables.join(", ")})`);
            // kv: only small config rows; the three big blobs must not exist
            // (kv is the primary; the legacy file is the pre-hydration fallback
            // — assert both paths are dry in eg mode)
            const kv = db.prepare("SELECT namespace, key, value_json FROM kv_store").all() as { namespace: string; key: string; value_json: string }[];
            for (const row of kv) {
                assert.ok(!["session-order", "plugin-conversations"].includes(row.namespace), `retired blob namespace ${row.namespace} must not be written in eg mode`);
                if (row.namespace === "prefix-affinity") {
                    assert.fail("prefix-affinity must not be written for an identified client in eg mode (the #1486 branch is gated)");
                }
                if (!KV_VALUE_WHITELIST.has(`${row.namespace}|${row.key}`)) {
                    assert.ok(row.value_json.length <= KV_VALUE_MAX_CHARS, `kv row ${row.namespace}|${row.key} = ${row.value_json.length} chars exceeds the ${KV_VALUE_MAX_CHARS} cap`);
                }
            }
            // session_ext: pf:state only (the K1 exemption) — and small
            const ext = db.prepare("SELECT key, value_json FROM session_ext WHERE session_id = 'p1'").all() as { key: string; value_json: string }[];
            for (const row of ext) {
                assert.ok(["pf:state"].includes(row.key), `unexpected session_ext key ${row.key} for the egress-on session`);
            }
            // the sessions row survived the turns (per-turn upsert, one row)
            const rows = db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];
            assert.equal(rows.length, 1, "still exactly one sessions row after two turns");
            assert.equal(JSON.parse(String(rows[0].metadata_json)).egressAuthority, true);
            // the egress tables carried the whole conversation
            const flow = db.prepare("SELECT COUNT(*) AS n FROM egress_flow").get() as { n: number };
            assert.ok(flow.n >= 5, `egress flow holds the seeded cells (got ${flow.n})`);
            assert.ok(!existsSync(join(h.dir, "billion-context", "plugin-conversations.json")), "no legacy plugin-conversations file in eg mode");
            assert.ok(!existsSync(join(h.dir, "billion-context", "prefix-affinity.json")), "no legacy prefix-affinity file in eg mode (identified client, gated)");
        } finally { db.close(); }
    } finally {
        await h.close();
    }
});

test("B2 (dual gate): a fresh LEGACY-mode database still persists the route table and the identified-client affinity chain", async () => {
    const h = await harness("0");
    try {
        await turn(h.base, "l1", HISTORY.slice(0, 5));
        await settle(h.store, "l1");
        // affinity persistence is debounced (~500 ms) — give it a quiet beat
        await new Promise((r) => setTimeout(r, 1500));
        const db = readOnlyDb(join(h.dir, "sessions", "index.db"));
        try {
            const kv = db.prepare("SELECT namespace, key FROM kv_store").all() as { namespace: string; key: string }[];
            const namespaces = new Set(kv.map((r) => r.namespace));
            assert.ok(namespaces.has("plugin-conversations") || existsSync(join(h.dir, "billion-context", "plugin-conversations.json")),
                "legacy mode still persists the conversation route table (the gate is eg-mode only)");
            assert.ok(namespaces.has("prefix-affinity") || existsSync(join(h.dir, "billion-context", "prefix-affinity.json")),
                "legacy mode still persists the identified-client affinity chain (kv after hydration, legacy file otherwise; the gate is eg-mode only)");
            const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
                .map((r) => r.name).filter((n) => !n.startsWith("sqlite_"));
            assert.ok(tables.includes("l1_world"), "legacy mode still creates the legacy tables (gate off → full DDL)");
        } finally { db.close(); }
    } finally {
        await h.close();
    }
});

test.after(() => {
    if (SAVED_PLANE === undefined) delete process.env.BILI_ROLLOUT_EGRESS_PLANE; else process.env.BILI_ROLLOUT_EGRESS_PLANE = SAVED_PLANE;
});
