// #5460 (P1): realtime perf telemetry — SQLite-backed, DB-modes only.
//
// Schema-stability culture mirrors the storage goldens: the DDL text is
// pinned, the file layout is pinned, and every degradation path must prove
// it leaves serving untouched (telemetry NEVER throws into the request path).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

before(() => { /* env handled per-test via resetModule */ });
after(() => { for (const d of SANDBOXES.splice(0)) rmSync(d, { recursive: true, force: true }); });
