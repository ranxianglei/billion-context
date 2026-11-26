import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";

test("320 MB archive boots under a 128 MB heap and restores an older original", { timeout: 100_000 }, () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-bounded-scale-"));
    const dir = path.join(root, "sessions");
    const source = fileURLToPath(new URL("../", import.meta.url));
    const text = "synthetic archived original ".repeat(40000);
    try {
        mkdirSync(path.join(dir, "_unknown"), { recursive: true });
        for (let i = 0; i < 320; i++) {
            const id = `scale-session-${i}`;
            const hash = createHash("sha256").update(id).digest("hex").slice(0, 24);
            const record = {
                version: 3, savedAt: 1000 + i, id, meta: { label: id },
                state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} } },
                blockContents: { b1: { one: null, full: { text, count: 1 } } },
                stats: { requests: 1 }, createdAt: 1000 + i,
            };
            writeFileSync(path.join(dir, "_unknown", `${hash}.json`), JSON.stringify({ version: 3, savedAt: record.savedAt, id, payload: record }));
        }
        // No migration marker: the first boot must also stay bounded.
        const script = `
import assert from 'node:assert/strict';
const { SessionStore } = await import(${JSON.stringify(pathToFileURL(path.join(source, "src/persist.ts")).href)});
const store = new SessionStore({ dir: ${JSON.stringify(dir)}, enabled: true, debounceMs: 0 });
const loaded = await store.boot({ maxSessions: 8, maxBytes: 16 * 1024 * 1024 });
assert.ok(loaded.size <= 8);
assert.equal(store.loadSync('scale-session-0').blockContents.get('b1').full.text.length, ${text.length});
store.closeQuietly();
`;
        const entry = path.join(root, "check.mjs");
        writeFileSync(entry, script);
        const env: NodeJS.ProcessEnv = { ...process.env, BILI_PERSIST_ZSTD: "0", BILI_SESSIONS_DIR: dir };
        delete env.BILI_ENCRYPTION_KEY;
        delete env.BILI_STORAGE_UNIFIED;
        for (const kind of ["DATA", "STATE", "CONFIG", "CACHE"]) env[`XDG_${kind}_HOME`] = path.join(root, kind.toLowerCase());
        const result = spawnSync(process.execPath, ["--max-old-space-size=128", "--import", pathToFileURL(path.join(source, "node_modules/tsx/dist/loader.mjs")).href, entry], {
            env, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024,
        });
        assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stderr.slice(-5000)}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("paged list, full list and overview exclude archival payloads under a 128 MB heap", { timeout: 100_000 }, () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-bounded-web-"));
    const dir = path.join(root, "sessions");
    const source = fileURLToPath(new URL("../", import.meta.url));
    const count = 192;
    const extra = 27230;
    try {
        mkdirSync(dir);
        const { db } = openSqliteDatabase(path.join(dir, "index.db"));
        try {
            migrateSchema(db);
            const padding = "archived payload ".repeat(16384);
            const metadata = JSON.stringify({
                unrelated: padding,
                clientHint: "codex",
                cacheLedger: { agg: { requests: 4, input: 1000, cached: 500 }, samples: [padding], folds: [{ bid: "b1", S: 100, sigma: 10, T: 20, requestsAfter: 3, original: padding }] },
                foldCoverageByBlock: { b1: { e: 1, p: 0, r: 0, unrelated: padding } },
            });
            const stats = JSON.stringify({ requests: 2, contextTokens: 100, unrelated: padding });
            const payload = JSON.stringify({ topic: " \n\t A synthetic   preview " + padding, summary: padding, compressedTokens: 100 });
            const insert = db.prepare("INSERT INTO sessions(session_id, protocol, title, stats_json, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)");
            db.prepare("INSERT INTO content(hash, byte_len, bytes) VALUES ('fixture', 0, X'')").run();
            const block = db.prepare("INSERT INTO blocks(session_id, block_id, ord, start_seq, end_seq, tier, summary_hash, active, created_at, covered_hash, payload_json) VALUES (?, 'b1', 0, 0, 0, 1, 'fixture', 1, 1, '', ?)");
            db.transaction(() => {
                for (let i = 0; i < count; i++) {
                    const id = `large-${i}`;
                    insert.run(id, i % 2 ? "anthropic" : "openai", `archived ${i}`, stats, metadata, 1000 + i);
                    block.run(id, payload);
                }
                for (let i = 0; i < extra; i++) insert.run(`small-${i}`, "openai", "small", '{"requests":2}', '{}', 10);
                insert.run("stub", "hidden", "stub", '{}', '{}', 2000);
            });
        } finally {
            db.close();
        }
        const script = `
import assert from 'node:assert/strict';
import { buildSessionPage, buildSessionList, buildOverview, hiddenEmptyCount, _resetDiskCacheForTest } from ${JSON.stringify(pathToFileURL(path.join(source, "src/web/sessions-data.ts")).href)};
import { getSession, _resetSessionsForTest } from ${JSON.stringify(pathToFileURL(path.join(source, "src/session.ts")).href)};
import { getStore, SessionStore, _setStoreForTest } from ${JSON.stringify(pathToFileURL(path.join(source, "src/persist.ts")).href)};
_setStoreForTest(new SessionStore({ enabled: false }));
const live = getSession('large-0', { protocol: 'openai' });
live.meta.hostTitle = 'live override';
_resetDiskCacheForTest();
live.stats.requests = 9;
live.lastSeen = 3000;
const timings = { initialMaxRssKiB: process.resourceUsage().maxRSS, initialRss: process.memoryUsage().rss };
let started = performance.now();
const page = await buildSessionPage({ page: 1, pageSize: 10 });
timings.pageMs = performance.now() - started;
timings.pageRss = process.memoryUsage().rss;
console.log(JSON.stringify({ phase: 'page', ...timings, heapUsed: process.memoryUsage().heapUsed }));
assert.equal(page.sessions.length, 10);
assert.equal(page.total, ${count + extra});
assert.equal(hiddenEmptyCount(), 1);
assert.equal(page.sessions[0].id, 'large-0');
assert.equal(page.sessions[0].requests, 9);
assert.equal(page.sessions[0].title, 'live override');
assert.deepEqual(page.protocols, ['anthropic', 'openai']);
assert.equal(page.sessions[1].id, 'large-${count - 1}');
assert.equal(page.sessions[1].requests, 4);
assert.equal(page.sessions[1].coverageLostFolds, 1);
assert.equal(page.sessions[1].grossSaved, 270);
assert.equal(page.sessions[1].netSaved, 240);
assert.equal(page.sessions[1].tokensSaved, 100);
assert.match(page.sessions[1].firstBlockHint, /^A synthetic preview archived payload /);
assert.equal(page.sessions[1].firstBlockHint.length, 49);
started = performance.now();
const filtered = await buildSessionPage({ page: 2, pageSize: 10, q: 'archived', protocol: 'anthropic', client: 'codex', state: 'history' });
timings.filteredPageMs = performance.now() - started;
timings.filteredPageRss = process.memoryUsage().rss;
console.log(JSON.stringify({ phase: 'filtered', ...timings, heapUsed: process.memoryUsage().heapUsed }));
assert.equal(filtered.total, ${count / 2});
assert.equal(filtered.sessions[0].id, 'large-${count - 21}');
started = performance.now();
const list = await buildSessionList();
timings.listMs = performance.now() - started;
timings.listRss = process.memoryUsage().rss;
console.log(JSON.stringify({ phase: 'list', ...timings, heapUsed: process.memoryUsage().heapUsed }));
assert.equal(list.length, ${count + extra});
assert.deepEqual(page.sessions, list.slice(0, 10));
list.length = 0;
started = performance.now();
const overview = await buildOverview();
timings.overviewMs = performance.now() - started;
timings.overviewRss = process.memoryUsage().rss;
console.log(JSON.stringify({ phase: 'overview', ...timings, heapUsed: process.memoryUsage().heapUsed }));
assert.equal(overview.sessions, ${count + extra});
assert.equal(overview.hiddenEmpty, 1);
assert.deepEqual(overview.recent, page.sessions.slice(0, 8));
assert.equal(getStore().unifiedWebSummaries(({ sessionId, status, updatedAt, label }) => ({ sessionId, status, updatedAt, label })).length, ${count + extra + 1});
console.log(JSON.stringify({ ...timings, heapUsed: process.memoryUsage().heapUsed, maxRssKiB: process.resourceUsage().maxRSS }));
_resetSessionsForTest();
_resetDiskCacheForTest();
`;
        const entry = path.join(root, "check.mjs");
        writeFileSync(entry, script);
        const env: NodeJS.ProcessEnv = { ...process.env, BILI_PERSIST_ZSTD: "0", BILI_STORAGE_UNIFIED: "full", BILI_SESSIONS_DIR: dir, BILI_CONFIG_FILE: path.join(root, "absent-config.json") };
        delete env.BILI_ENCRYPTION_KEY;
        for (const kind of ["DATA", "STATE", "CONFIG", "CACHE"]) env[`XDG_${kind}_HOME`] = path.join(root, kind.toLowerCase());
        const result = spawnSync(process.execPath, ["--max-old-space-size=128", "--import", pathToFileURL(path.join(source, "node_modules/tsx/dist/loader.mjs")).href, entry], {
            env, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024,
        });
        assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr.slice(-5000)}`);
        console.log(`bounded web child: ${result.stdout.trim()}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
