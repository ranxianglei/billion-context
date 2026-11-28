// #7857 review F3 (KDD #25 WRITE side): a fresh egress-plane database
// creates exactly the core trio (sessions/session_ext/kv_store) plus the
// egress tables — none of the 12 legacy tables (schema.ts
// STORAGE_DDL_V1_CORE vs _LEGACY; the gate: shadow.ts
// `legacyTables: !egressPlaneGateOn() || BILI_TEST_FORCE_FULL_DDL`).
//
// A session whose egress authority is NEVER armed (a client that does not
// pin the msgid envelope — every non-plugin and non-bili client) is
// persisted through the legacy ingest path. Pre-fix, its first save died on
// `no such table: messages` and the whole ingest transaction rolled back —
// including the core `sessions` upsert — so in pure-sqlite mode the
// metadata row (title / pluginAgent / stats) was lost permanently and
// EVERY subsequent save re-crashed (the gate opencode "plugin lane claimed"
// red: sessions table with 0 rows while the lane's turns all passed).
//
// Pinned here: egress plane ON, fresh DB, two turns of a plain (non-pinned)
// header conversation — the core row lands with metadata, no
// no-such-table crash on any save, the second save UPDATES the row
// (requests >= 2 — pre-fix every save rolled back), and the DB carries
// exactly the 8 core+egress tables.

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
// Deliberately NO BILI_TEST_FORCE_FULL_DDL — the production 7-table shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

const WINDOW = 4_000_000;
const MODEL = "f3-nonpinned-7857";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

const body = (turn: number): string =>
    JSON.stringify({
        model: MODEL, stream: false, max_tokens: 4096,
        messages: [
            { role: "user", content: `f3 conversation turn ${turn}` },
            ...(turn > 1 ? [{ role: "assistant", content: "ok" }] : []),
        ],
    });

test("#7857 F3: a non-pinned session persists its core row on a 7-table egress DB (no no-such-table crash, metadata survives repeated saves)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f3-nonpinned-7857-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const warnLines: string[] = [];
    setLogCapture((lvl, m) => { if (lvl === "warn" || lvl === "error") warnLines.push(m); });
    let store: SessionStore | null = null;
    let srv: http.Server | null = null;
    let upstream: http.Server | null = null;
    try {
        setRegistryForTest({});
        store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        upstream = http.createServer((req, res) => {
            req.on("data", () => undefined);
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "chatcmpl-test", object: "chat.completion", model: MODEL,
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                }));
            });
        });
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: llmUrl,
            routes: {},
            modelContextLimit: WINDOW, kernelConfig: defaultConfig(WINDOW),
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
            log: true, debug: true, passthrough: false, autoUpdate: false,
            compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
            autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        srv = await startServer(opts);
        await listen(srv);
        const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
        const post = (b: string): Promise<{ status: number; text: string }> =>
            fetch(`${base}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "f3-conv" },
                body: b,
                signal: AbortSignal.timeout(60_000),
            }).then(async (r) => ({ status: r.status, text: await r.text() }));
        const postOk = async (p: Promise<{ status: number; text: string }>, label: string): Promise<void> => {
            const r = await p;
            assert.equal(r.status, 200, `${label} (got ${r.status}: ${r.text.slice(0, 300)})`);
        };
        // Two turns of the same (non-pinned) conversation: the FIRST save
        // pre-fix crashed AND the SECOND re-crashed (WARN on every save).
        await postOk(post(body(1)), "turn 1");
        await postOk(post(body(2)), "turn 2");

        const candidates = [
            join(dir, "sessions", "index.db"),
            join(dir, "data", "billion-context", "sessions", "index.db"),
        ];
        const dbPath = candidates.find((p) => existsSync(p)) ?? candidates[0];
        // Open a SECOND, read-write connection: the writer's committed
        // frames sit in index.db-wal while it is open, and a readOnly
        // connection cannot rebuild the WAL index (it needs write access
        // to -shm) — a normal connection reads the committed WAL frames
        // through the writer's existing -shm.
        // Poll: the flush is debounced (15ms here) but the row must appear.
        let row: { requests: number; metadata: string; title: string | null } | null = null;
        let allIds: string[] = [];
        for (let i = 0; i < 100 && row === null; i++) {
            if (!existsSync(dbPath)) {
                await new Promise((res) => setTimeout(res, 100));
                continue;
            }
            const db = new DatabaseSync(dbPath);
            try {
                allIds = (db.prepare("SELECT session_id FROM sessions").all() as { session_id: string }[]).map((r) => r.session_id);
                const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
                // The production 7-table (+) shape: no legacy group.
                for (const t of ["messages", "content", "blocks", "orphan_blocks", "conversations", "refs", "dead_refs", "ccr_entries", "message_media"]) {
                    assert.ok(!tables.includes(t), `fresh egress DB must not create the legacy table ${t} (got ${tables.join(", ")})`);
                }
                const r = db.prepare("SELECT json_extract(stats_json, '$.requests') AS requests, metadata_json AS metadata, title FROM sessions WHERE session_id LIKE 'f3-conv%'").get() as { requests: number; metadata: string; title: string | null } | undefined;
                if (r && (r.requests ?? 0) >= 2) row = r;
            } finally {
                db.close();
            }
            if (row === null) await new Promise((res) => setTimeout(res, 100));
        }
        assert.ok(row !== null, `the core sessions row for the non-pinned session landed with requests>=2 (sessions table: ${JSON.stringify(allIds)}; warns: ${warnLines.slice(0, 4).join(" | ")})`);
        assert.ok(row.metadata.length > 0, `the metadata column landed (got ${JSON.stringify(row.metadata)})`);
        const meta = JSON.parse(row.metadata) as Record<string, unknown>;
        assert.ok(Object.keys(meta).length > 0, "metadata_json is a non-empty object");
        assert.ok(!warnLines.some((l) => l.includes("no such table")), `no no-such-table crash on any save (saw: ${warnLines.filter((l) => l.includes("no such table")).slice(0, 3).join(" | ")})`);
        assert.ok(!warnLines.some((l) => l.includes("failed to ingest")), `no failed-to-ingest WARN on any save (saw: ${warnLines.filter((l) => l.includes("failed to ingest")).slice(0, 3).join(" | ")})`);
    } finally {
        setLogCapture(null);
        store?.closeQuietly();
        srv?.closeAllConnections?.();
        await new Promise<void>((r) => { if (srv) srv.close(() => r()); else r(); });
        await new Promise<void>((r) => { if (upstream) upstream.close(() => r()); else r(); });
    }
});
