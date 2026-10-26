import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { exportSession, renderSessionJsonlFromTables, renderSessionJsonlFromSession } from "../src/export.ts";
import { SqliteBackend } from "../src/storage/backend.ts";
import { buildStoredPlaceholder } from "acp-kernel";
import type { Session } from "../src/session.ts";

/**
 * JSONL export (Phase 2c, #2671).
 *
 * `bili export --jsonl` renders a deterministic dump: one JSON record per
 * line — a session header, then messages ordered by seq, then blocks ordered
 * by ord, then dead refs. When the session lives in the unified index the
 * dump comes from the tables; otherwise it falls back to the legacy record's
 * tail + block summaries (`source: "legacy-tail"` says so). The dump is a
 * generated artifact — never a source of truth.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-jsonl-hermetic-")),
    "no-config.json",
);
// Absent everywhere now resolves to the shadow DEFAULT (#2815 rollout flip);
// this suite needs the explicit legacy baseline — per-test legs override it.
process.env.BILI_STORAGE_UNIFIED = "legacy";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

async function loadCorpusCase(dir: string, name: string, id: string, protocol: string): Promise<Session> {
    fs.cpSync(path.join(CORPUS_ROOT, name), path.join(dir, name), { recursive: true });
    const loader = new SessionStore({ dir: path.join(dir, name), debounceMs: 1, enabled: true });
    try {
        const loaded = loader.loadSync(id, { protocol, upstreamOrigin: "http://127.0.0.1:8199" });
        assert.ok(loaded, `${name}: corpus loadSync returned null`);
        return loaded;
    } finally {
        // The loader's own unified shadow holds index.db open — close it via
        // the graceful-shutdown path, or Windows rmSync fails with EPERM.
        loader.cancelAll();
        await loader.flushAll();
    }
}

async function withMode<T>(mode: string, fn: () => Promise<T> | T): Promise<T> {
    // await fn(): the old `return fn()` released the env at the first await
    // inside an async body — constructing stores after that ran legacy-mode.
    process.env.BILI_STORAGE_UNIFIED = mode;
    try {
        return await fn();
    } finally {
        // Restore the hermetic legacy baseline — deleting would land on the
        // shadow DEFAULT and flip later legs.
        process.env.BILI_STORAGE_UNIFIED = "legacy";
    }
}

function parseLines(text: string): Record<string, unknown>[] {
    return text.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("--jsonl renders from the unified tables: header, blocks, dead refs (folded + deadrefs corpus)", async () => {
    await withMode("full", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jsonl-full-"));
        try {
            const session = await loadCorpusCase(dir, "folded", "corpus-folded", "anthropic");
            const store = new SessionStore({ dir: path.join(dir, "folded"), debounceMs: 1, enabled: true });
            await store.writeNow(session);
            await store.flushAll(); // closes the unified handle (Windows: an open index.db blocks rmSync)
            store.cancelAll();

            const unified = UnifiedStore.open(path.join(dir, "folded", "index.db"));
            try {
                assert.ok(unified.getSessionRow(session.id), "full mode must have ingested the session");
                const lines = parseLines(await renderSessionJsonlFromTables(new SqliteBackend(unified), session.id, false));
                assert.equal(lines[0]!.type, "session");
                assert.equal(lines[0]!.source, "unified");
                assert.equal(lines[0]!.sessionId, session.id);
                const blocks = lines.filter((l) => l.type === "block");
                assert.ok(blocks.length > 0, "folded corpus has blocks");
                assert.equal(blocks[0]!.blockId, session.state.blocks[0]!.blockId);
                const msgs = lines.filter((l) => l.type === "message");
                assert.ok(msgs.length > 0, "tail messages render");
                // seq strictly increasing
                for (let i = 1; i < msgs.length; i++) assert.ok((msgs[i]!.seq as number) > (msgs[i - 1]!.seq as number));
            } finally {
                unified.close();
            }
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
        }
    });
});

test("--jsonl falls back to the legacy tail when no index exists (deadrefs corpus)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jsonl-legacy-"));
    try {
        const session = await loadCorpusCase(dir, "deadrefs", "corpus-deadrefs", "anthropic");
        const store = new SessionStore({ dir: path.join(dir, "deadrefs"), debounceMs: 1, enabled: true });
        await store.writeNow(session);
        await store.flushAll(); // closes the unified handle (Windows: an open index.db blocks rmSync)
        store.cancelAll();
        assert.ok(!fs.existsSync(path.join(dir, "deadrefs", "index.db")), "legacy dir must not grow an index");

        const text = await exportSession(session.id, { dir: path.join(dir, "deadrefs"), jsonl: true });
        const lines = parseLines(text);
        assert.equal(lines[0]!.type, "session");
        assert.equal(lines[0]!.source, "legacy-tail");
        assert.equal(lines[0]!.sessionId, session.id);
        const dead = lines.filter((l) => l.type === "deadRefs");
        assert.equal(dead.length, 1, "deadrefs corpus has tombstones");
        assert.ok((dead[0]!.refs as unknown[]).length > 0);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
    }
});

test("--jsonl prefers the unified index when it exists (ccr corpus, --full dereferences CCR placeholders)", async () => {
    await withMode("full", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jsonl-ccr-"));
        try {
            const session = await loadCorpusCase(dir, "ccr", "corpus-ccr", "responses");
            // The ccr corpus pins the envelope (entries m00006/m00008) but its
            // tail holds no placeholder; graft one on to exercise deref.
            const placeholder = buildStoredPlaceholder({ ref: "m00001", kind: "file read", tokens: 5, head: "ORIGINAL HEAD", retrieveToolName: "acp_retrieve" });
            session.lastMessages = [{ id: "msg-ccr-1", role: "user", contentType: "text", text: placeholder } as never];
            session.contentStore = { version: 1, byHash: { h1: "THE ORIGINAL LONG TEXT" }, byRef: { m00001: { hash: "h1", rawId: "raw-1", kind: "file read", tokens: 5, chars: 22, head: "ORIGINAL HEAD" } } };
            session.contentStoreDirty = true; // rewrite content-store.json so the disk sibling carries the graft
            const store = new SessionStore({ dir: path.join(dir, "ccr"), debounceMs: 1, enabled: true });
            await store.writeNow(session);
            await store.flushAll(); // closes the unified handle (Windows: an open index.db blocks rmSync)
            store.cancelAll();

            // --full: placeholders in the tail dereference to their stored originals
            const fullText = await exportSession(session.id, { dir: path.join(dir, "ccr"), jsonl: true, full: true });
            const fullLines = parseLines(fullText);
            assert.equal(fullLines[0]!.source, "unified", "index.db present + indexed → tables render");
            const derefed = fullLines.filter((l) => l.type === "message" && (l.message as Record<string, unknown>).dereferencedFrom !== undefined);
            assert.ok(derefed.length > 0, "ccr corpus tail holds placeholders that must dereference");
            // every dereferenced text is non-empty
            for (const m of derefed) assert.ok(((m.message as Record<string, unknown>).text as string).length > 0);

            // without --full the placeholder ships verbatim
            const plainText = await exportSession(session.id, { dir: path.join(dir, "ccr"), jsonl: true });
            const plainLines = parseLines(plainText);
            assert.equal(plainLines.filter((l) => l.type === "message" && (l.message as Record<string, unknown>).dereferencedFrom !== undefined).length, 0);
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
        }
    });
});

test("renderSessionJsonlFromSession dereferences via an injected content store", () => {
    const session = {
        id: "sess-jsonl-synthetic",
        createdAt: 5,
        lastSeen: 6,
        meta: {},
        stats: { requests: 1 },
        state: { blocks: [], deadRefs: [] },
        lastMessages: [{ id: "msg-1", role: "user", contentType: "text", text: "hello" }],
    } as unknown as Session;
    const lines = parseLines(renderSessionJsonlFromSession(session, false, null));
    const msg = lines.find((l) => l.type === "message") as { message: { text: string } };
    assert.equal(msg.message.text, "hello");
});

test("--jsonl enforces the backend selection at open time: the mysql stub fails with its documented error (#3932 review)", async () => {
    await withMode("full", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jsonl-backend-"));
        try {
            const session = await loadCorpusCase(dir, "folded", "corpus-folded", "anthropic");
            const store = new SessionStore({ dir: path.join(dir, "folded"), debounceMs: 1, enabled: true });
            await store.writeNow(session);
            await store.flushAll(); // closes the unified handle (Windows: an open index.db blocks rmSync)
            store.cancelAll();
            assert.ok(fs.existsSync(path.join(dir, "folded", "index.db")), "full-mode corpus ingest must leave index.db behind");

            // #3931 step 3: the backend selection binds at STORE construction —
            // a store built under "mysql" without a DSN has no sqlite shadow at
            // all (boot warns; the envelope is the only sink), so this leg
            // ingests under the sqlite default and selects mysql only for the
            // export call, which is the surface under test here.
            process.env.BILI_STORAGE_BACKEND = "mysql";

            await assert.rejects(
                () => exportSession(session.id, { dir: path.join(dir, "folded"), jsonl: true }),
                (err: unknown) => {
                    const msg = String((err as Error).message);
                    return msg.includes("mysql") && msg.includes("#3388");
                },
                "a deliberate mysql selection must fail at open time, not silently read sqlite",
            );
        } finally {
            delete process.env.BILI_STORAGE_BACKEND;
            try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
        }
    });
});
