// #5460 (P1): realtime perf telemetry — SQLite-backed, DB-modes only.
//
// Schema-stability culture mirrors the storage goldens: the DDL text is
// pinned, the file layout is pinned, and every degradation path must prove
// it leaves serving untouched (telemetry NEVER throws into the request path).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    perfTelemetryInit, perfRecordRequest, perfRecordMemSample,
    perfStopAll, perfRecentRows, perfActiveMode, perfTelemetryResetForTests,
    PERF_DB_FILE, PERF_EVENTS_DDL,
} from "../src/perf-telemetry.js";

const SANDBOXES: string[] = [];
function sandbox(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bili-5460-"));
    SANDBOXES.push(dir);
    return dir;
}

function resetModule(): void {
    perfTelemetryResetForTests();
    delete process.env.BILI_PERF_TELEMETRY;
}

test("#5460 P1: sqlite mode records request rows into <dir>/perf.sqlite", () => {
    resetModule();
    const dir = sandbox();
    try {
        assert.equal(perfTelemetryInit("sqlite", { dir }), true);
        assert.equal(perfActiveMode(), "sqlite");
        const beforeTs = Date.now();
        perfRecordRequest({ sessionId: "sess-x", msgs: 42, inboundBytes: 123456, outboundBytes: 789, totalMs: 12.4, extra: { lane: "dsh" } });
        const db = new DatabaseSync(path.join(dir, PERF_DB_FILE));
        try {
            const row = db.prepare("SELECT * FROM perf_events WHERE kind='req'").get() as Record<string, string | number | null>;
            assert.equal(row.session_id, "sess-x");
            assert.equal(row.msgs, 42);
            assert.equal(row.inbound_bytes, 123456);
            assert.equal(row.outbound_bytes, 789);
            assert.equal(row.total_ms, 12.4);
            assert.ok(Number(row.ts) >= beforeTs && Number(row.ts) <= Date.now());
            const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
            assert.equal(payload.engine, "sqlite");
            assert.equal(payload.lane, "dsh");
        } finally { db.close(); }
    } finally { perfStopAll(); }
});

test("#5460 P1: schema is pinned (DDL text + ts index + WAL) — golden discipline", () => {
    resetModule();
    const dir = sandbox();
    try {
        perfTelemetryInit("sqlite", { dir });
        perfRecordRequest({ sessionId: "s" });
        const db = new DatabaseSync(path.join(dir, PERF_DB_FILE));
        try {
            const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='perf_events'").get() as { sql: string };
            // sqlite_master stores the statement verbatim minus the idempotence
            // prefix, so normalize both sides to the CREATE TABLE body.
            assert.equal(ddl.sql.trim().replace("IF NOT EXISTS ", ""), PERF_EVENTS_DDL.trim().replace("IF NOT EXISTS ", ""));
            const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_perf_events_ts'").get();
            assert.ok(idx, "ts index must exist");
            const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
            assert.equal(String(mode.journal_mode).toLowerCase(), "wal");
        } finally { db.close(); }
    } finally { perfStopAll(); }
});

test("#5460 P1: pure-JSON storage mode is frozen — permanently inert", () => {
    resetModule();
    const dir = sandbox();
    try {
        assert.equal(perfTelemetryInit("json", { dir }), false);
        assert.equal(perfActiveMode(), "json");
        perfRecordRequest({ sessionId: "s", msgs: 1 });
        perfRecordMemSample();
        assert.ok(!existsSync(path.join(dir, PERF_DB_FILE)), "json mode must never create a metrics file");
        assert.equal(perfRecentRows().length, 0);
    } finally { perfStopAll(); }
});

test("#5460 P1: BILI_PERF_TELEMETRY=0 kill switch wins over any mode", () => {
    resetModule();
    const dir = sandbox();
    process.env.BILI_PERF_TELEMETRY = "0";
    try {
        assert.equal(perfTelemetryInit("sqlite", { dir }), false);
        assert.equal(perfActiveMode(), "off");
        perfRecordRequest({ sessionId: "s" });
        perfStopAll();
        assert.ok(!existsSync(path.join(dir, PERF_DB_FILE)));
    } finally {
        perfTelemetryResetForTests();
        delete process.env.BILI_PERF_TELEMETRY;
    }
});

test("#5460 P1: open failure degrades ONCE — no throw into the request path, no retry", () => {
    resetModule();
    const dir = sandbox();
    // A non-SQLite regular file at the db path makes the first exec throw
    // deterministically ("file is not a database") — the open-failure path.
    writeFileSync(path.join(dir, PERF_DB_FILE), "not a sqlite database");
    const warns: string[] = [];
    try {
        assert.equal(perfTelemetryInit("sqlite", { dir, log: (l, m) => warns.push(`${l}:${m}`) }), true);
        perfRecordRequest({ sessionId: "s1" });
        perfRecordRequest({ sessionId: "s2" });
        perfRecordMemSample();
        const degraded = warns.filter((w) => w.startsWith("warn:") && w.includes("telemetry degraded"));
        assert.equal(degraded.length, 1, `exactly ONE degrade warn, got ${degraded.length}`);
        assert.ok(degraded[0].includes("open failed"), "warn must name the open failure");
        assert.equal(perfRecentRows().length, 0, "no rows may be recorded while dead");
    } finally { perfStopAll(); }
});

test("#5460 P1: init is idempotent — later calls never re-arm or throw", () => {
    resetModule();
    const dir = sandbox();
    try {
        perfTelemetryInit("sqlite", { dir });
        assert.equal(perfTelemetryInit("mysql", {}), true, "already armed → no-op true");
        assert.equal(perfTelemetryInit("json", {}), true);
        assert.equal(perfActiveMode(), "sqlite");
    } finally { perfStopAll(); }
});

test("#5460 P1: mem sampler rows land with real memory numbers", async () => {
    resetModule();
    const dir = sandbox();
    try {
        perfTelemetryInit("sqlite", { dir, memIntervalMs: 5 });
        await new Promise((r) => setTimeout(r, 80));
        perfStopAll();
        const db = new DatabaseSync(path.join(dir, PERF_DB_FILE));
        try {
            const rows = db.prepare("SELECT payload FROM perf_events WHERE kind='mem'").all() as Array<{ payload: string }>;
            assert.ok(rows.length >= 2, `expected repeated mem samples, got ${rows.length}`);
            const p = JSON.parse(rows[0].payload) as Record<string, number>;
            assert.ok(p.rss > 0 && p.heapUsed > 0 && p.external >= 0);
        } finally { db.close(); }
    } finally { perfStopAll(); }
});

test("#5460 P1: ring buffer serves in-process consumers (/stats, panel P4)", () => {
    resetModule();
    const dir = sandbox();
    try {
        perfTelemetryInit("sqlite", { dir });
        perfRecordRequest({ sessionId: "a", inboundBytes: 1 });
        perfRecordRequest({ sessionId: "b", inboundBytes: 2 });
        const ring = perfRecentRows();
        assert.equal(ring.length, 2);
        assert.equal((ring[1] as Record<string, unknown>).session_id, "b");
    } finally { perfStopAll(); }
});

test("#5460 P1: logRequestCost wires structured rows through the single choke point", async () => {
    // Late import keeps the heavy server module out of the fast paths above;
    // importing ../src/server.js in tests is an established pattern.
    const { logRequestCost } = await import("../src/server.js");
    resetModule();
    const dir = sandbox();
    try {
        assert.equal(perfTelemetryInit("sqlite", { dir }), true);
        const logs: string[] = [];
        logRequestCost((lvl, msg) => logs.push(`${lvl}:${msg}`), "sess-wired", 7, 2048, performance.now(), "body-out");
        perfStopAll();
        const db = new DatabaseSync(path.join(dir, PERF_DB_FILE));
        let row: Record<string, string | number | null> | undefined;
        try {
            row = db.prepare("SELECT * FROM perf_events WHERE kind='req' AND session_id='sess-wired'").get() as Record<string, string | number | null>;
        } finally { db.close(); }
        assert.ok(row, "logRequestCost must emit a telemetry row");
        assert.equal(row!.msgs, 7);
        assert.equal(row!.inbound_bytes, 2048);
        assert.equal(row!.outbound_bytes, Buffer.byteLength("body-out"));
        assert.ok(Number(row!.total_ms) >= 0);
        assert.ok(logs.some((l) => l.includes("request:")), "original human line untouched");
    } finally { perfStopAll(); }
});

test("#5460 P1: retention sweep caps perf_events at the 200k-row window — oldest drop first", () => {
    resetModule();
    const dir = sandbox();
    try {
        assert.equal(perfTelemetryInit("sqlite", { dir }), true);
        // Stop EXACTLY on a sweep boundary past the cap (a multiple of the
        // 500-insert sweep period): the sweep that just fired must leave the
        // table at precisely the cap, newest kept. Between sweeps the table
        // may hold up to cap+period-1 (amortized by design).
        for (let i = 0; i < 200_500; i++) {
            perfRecordRequest({ sessionId: `r${i}`, inboundBytes: i });
        }
        perfStopAll();
        const db = new DatabaseSync(path.join(dir, PERF_DB_FILE));
        try {
            const n = db.prepare("SELECT COUNT(*) AS n FROM perf_events").get() as { n: number };
            assert.equal(Number(n.n), 200_000, "retention cap must hold at the sweep boundary");
            const newest = db.prepare("SELECT session_id FROM perf_events ORDER BY id DESC LIMIT 1").get() as { session_id: string };
            assert.equal(newest.session_id, "r200499", "newest rows survive, oldest drop");
        } finally { db.close(); }
    } finally { perfStopAll(); }
});

test("#5460 P1: legacy (pure-JSON) storage mode leaves ZERO telemetry footprint — owner constraint ②", async () => {
    // The sqlite arming branch runs for every enabled store — including
    // storage.unified=legacy ones where maybeOpen() returns null. This pins
    // that such a store still never creates perf.sqlite.
    const { SessionStore } = await import("../src/persist.js");
    resetModule();
    const savedUnified = process.env.BILI_STORAGE_UNIFIED;
    const savedKey = process.env.BILI_ENCRYPTION_KEY;
    delete process.env.BILI_ENCRYPTION_KEY;
    process.env.BILI_STORAGE_UNIFIED = "legacy";
    const dir = sandbox();
    try {
        new SessionStore({ enabled: true, dir });
        perfStopAll();
        assert.equal(perfActiveMode(), "json", "legacy mode must arm the frozen (inert) engine");
        assert.ok(!existsSync(path.join(dir, PERF_DB_FILE)), "pure-JSON mode must never create a metrics file");
    } finally {
        if (savedUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = savedUnified;
        if (savedKey === undefined) delete process.env.BILI_ENCRYPTION_KEY; else process.env.BILI_ENCRYPTION_KEY = savedKey;
        perfTelemetryResetForTests();
    }
});

after(() => { for (const d of SANDBOXES.splice(0)) rmSync(d, { recursive: true, force: true }); });
