import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInitialState } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, getSession, initSessions, peekSession, type Session } from "../src/session.ts";
import { handlePluginStatus } from "../src/plugin.ts";

/**
 * #404: a restart must not fabricate activity.
 *
 * buildSession used to stamp every disk-restored session with
 * lastSeen = Date.now(), so after boot ALL restored sessions shared one
 * millisecond: the panel's "last activity" column showed the boot time for
 * every row, and handlePluginStatus's fallback=latest broke the 245-way tie
 * by readdir order, attaching a fresh client to an unrelated old session.
 *
 * Fix: lastSeen comes from the persisted savedAt, restored sessions are
 * flagged `restored` until their first real request in THIS process, the
 * boot-load truncation key becomes max(createdAt, savedAt), and
 * fallback=latest only considers sessions with post-boot activity.
 */

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

/** Hand-write a v3 envelope file with FULLY CONTROLLED createdAt/savedAt so
 *  the boot-restore semantics are testable without clock mocking. The label
 *  equals the id so migrateLegacyIds (#286 re-keying) leaves it alone. */
function writeEnvelope(dir: string, id: string, createdAt: number, savedAt: number): void {
    const payload = {
        version: 3,
        savedAt,
        id,
        meta: { label: id, protocol: "anthropic" },
        stats: { requests: 3, tokensSaved: 0 },
        createdAt,
        state: createInitialState(),
        blockContents: {},
    };
    const hash = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24);
    const file = join(dir, "anthropic", `${hash}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 3, savedAt, id, payload }));
}

function mockRes(): { res: http.ServerResponse; status: number; body: string } {
    const out = { res: undefined as unknown as http.ServerResponse, status: 0, body: "" };
    const res = {
        writeHead(code: number) { out.status = code; return res; },
        end(chunk?: unknown) { if (typeof chunk === "string") out.body = chunk; return res; },
    } as unknown as http.ServerResponse;
    out.res = res;
    return out;
}

await test("boot restore: lastSeen=savedAt, restored flag, freshness-keyed truncation, fallback=latest skips restored (#404)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-404-boot-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    try {
        // Freshness by max(createdAt, savedAt): A=9000, C=8000, B=5000.
        // The OLD truncation key (createdAt only: B=5000 > A=1000 > C=2000)
        // would keep B and drop C — the active-but-old A / idle-but-new B mix.
        writeEnvelope(dir, "sess-A", 1000, 9000);
        writeEnvelope(dir, "sess-B", 5000, 5000);
        writeEnvelope(dir, "sess-C", 2000, 8000);

        _resetSessionsForTest(2);
        await initSessions();

        const a = peekSession("sess-A");
        const b = peekSession("sess-B");
        const c = peekSession("sess-C");
        assert.ok(a && c, "the two freshest sessions by max(createdAt, savedAt) survive boot truncation");
        assert.equal(b, undefined, "newer-created but idle-since-boot session loses its slot to the active-but-old one");
        assert.equal(a!.lastSeen, 9000, "restored lastSeen is the on-disk savedAt, not the restore moment");
        assert.equal(a!.restored, true, "restored sessions are flagged until their first request in this process");
        assert.equal(c!.restored, true);

        // fallback=latest must resolve the session with REAL post-boot
        // activity, never a restored one — the 245-way-tie regression.
        const active = getSession("sess-active", { protocol: "anthropic", label: "ACTIVE" });
        assert.notEqual(active.restored, true, "a session created by a live request is not restored");
        const res1 = mockRes();
        handlePluginStatus("never-seen", res1.res, true);
        const body1 = JSON.parse(res1.body) as { ok: boolean; fallback?: boolean; label: string | null };
        assert.equal(res1.status, 200);
        assert.equal(body1.ok, true);
        assert.equal(body1.fallback, true);
        assert.equal(body1.label, "ACTIVE", "fallback=latest resolves the post-boot-active session");

        // All sessions restored (no activity since boot): refuse to guess.
        _resetSessionsForTest();
        const res2 = mockRes();
        handlePluginStatus("never-seen", res2.res, true);
        assert.equal(res2.status, 404);
        assert.ok(res2.body.includes("since boot"), "explicit no-post-boot-activity error instead of a readdir-order guess");
    } finally {
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
        _resetSessionsForTest(64);
    }
});

await test("writeNow → loadAll round-trip keeps savedAt as lastSeen (#404)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-404-rt-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    try {
        const s = makeSession("roundtrip-1");
        s.meta.label = "roundtrip-1";
        await store.writeNow(s);
        await new Promise((r) => setTimeout(r, 15));
        const before = Date.now();
        const loaded = (await store.loadAll()).get("roundtrip-1");
        assert.ok(loaded);
        assert.ok(loaded.lastSeen < before, "restored lastSeen predates the load (came from the file, not Date.now())");
        assert.equal(loaded.restored, true);
    } finally {
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
    }
});

await test("memory-miss reload counts as real activity: restored cleared, lastSeen stamped now (#404)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-404-miss-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    try {
        writeEnvelope(dir, "miss-1", 1000, 2000);
        _resetSessionsForTest(64);
        const before = Date.now();
        const s = getSession("miss-1", { protocol: "anthropic" });
        assert.ok(s);
        assert.ok(s.lastSeen >= before, "a request-triggered reload stamps fresh activity");
        assert.notEqual(s.restored, true, "and clears the restored flag — fallback=latest may resolve it");
    } finally {
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
        _resetSessionsForTest(64);
    }
});
