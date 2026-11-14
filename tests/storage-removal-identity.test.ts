import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { createInitialState } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest } from "../src/storage/ingest.ts";

const root = mkdtempSync(join(tmpdir(), "bili-removal-identity-"));
process.env.BILI_CONFIG_FILE = join(root, "no-config.json");
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_STORAGE_JSON_WRITER = "1";

function session(id: string, protocol?: Session["meta"]["protocol"], origin?: string): Session {
    return {
        id, meta: { protocol, upstreamOrigin: origin },
        stats: { requests: 1, tokensSaved: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 50,
            cacheSamples: 1, lastInputTokens: 100, contextTokens: 100, compressCreditTokens: 0,
            retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {}, createdAt: 1_700_000_000_000, lastSeen: 1_700_000_001_000,
        state: createInitialState(), pendingRetrievals: [], blockContents: new Map(),
        inFlight: 0, persisted: false,
        lastMessages: [{ id: "shared-message", role: "user", contentType: "text", text: "shared content" }],
    };
}

async function withStore(run: (store: SessionStore, dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(root, "store-"));
    const store = new SessionStore({ dir, debounceMs: 0, log: () => {} });
    try {
        await run(store, dir);
    } finally {
        store.closeQuietly();
        rmSync(dir, { recursive: true, force: true });
    }
}

for (const [protocol, origin] of [
    ["openai", "https://example.test/v1"],
    ["anthropic", "https://example.test/anthropic"],
    ["google", "https://example.test/gemini"],
    [undefined, undefined],
] as const) {
    test(`removeSession preserves dual-write deletion for ${protocol ?? "unknown"} identity`, async () => {
        await withStore(async (store, dir) => {
            await store.writeNow(session("target", protocol, origin));
            await store.writeNow(session("survivor", protocol, origin));
            const targetFiles = await store.findSessionFiles("target", { protocol, upstreamOrigin: origin });
            const survivorFiles = await store.findSessionFiles("survivor", { protocol, upstreamOrigin: origin });
            assert.ok(targetFiles.length > 0);
            const survivorBytes = survivorFiles.map((file) => readFileSync(join(dir, file)));
            assert.deepEqual(await store.removeSession("target"), { envelopeFound: true, unifiedHadRows: true });
            assert.deepEqual(await store.findSessionFiles("target"), []);
            survivorFiles.forEach((file, i) => assert.deepEqual(readFileSync(join(dir, file)), survivorBytes[i]));
            const db = UnifiedStore.open(join(dir, "index.db"));
            try {
                assert.equal(db.getSessionRow("target"), null);
                assert.equal(db.getMessages("target").length, 0);
                assert.equal(db.getSessionRow("survivor")?.protocol, protocol ?? null);
                assert.equal(db.getMessages("survivor")[0]?.content.includes("shared content"), true);
            } finally { db.close(); }
        });
    });
}

test("removeSession deletes a DB-only session and retains unrelated CAS content", async () => {
    await withStore(async (store, dir) => {
        const db = UnifiedStore.open(join(dir, "index.db"));
        try {
            const target = session("target", "openai", "https://example.test");
            const survivor = session("survivor", "anthropic", "https://other.test");
            db.ingestSession(planIngest({ ...target, state: { ...target.state } }));
            db.ingestSession(planIngest({ ...survivor, state: { ...survivor.state } }));
            assert.deepEqual(await store.findSessionFiles("target"), []);
            assert.deepEqual(await store.removeSession("target"), { envelopeFound: false, unifiedHadRows: true });
            assert.equal(db.getSessionRow("target"), null);
            assert.equal(db.getMessages("target").length, 0);
            assert.equal(db.getMessages("survivor")[0]?.content.includes("shared content"), true);
        } finally { db.close(); }
    });
});

test("removeSession finds legacy files after the target's index row is absent", async () => {
    await withStore(async (store, dir) => {
        await store.writeNow(session("target", "responses", "https://example.test/v1"));
        const db = UnifiedStore.open(join(dir, "index.db"));
        try { db.deleteSession("target"); } finally { db.close(); }
        assert.deepEqual(await store.removeSession("target"), { envelopeFound: true, unifiedHadRows: false });
        assert.deepEqual(await store.findSessionFiles("target"), []);
    });
});

test("removeSession preserves corrupt-envelope quarantine and its result", async () => {
    await withStore(async (store, dir) => {
        await store.writeNow(session("target", "openai", "https://example.test"));
        const files = await store.findSessionFiles("target");
        assert.ok(files.length > 0);
        for (const file of files) writeFileSync(join(dir, file), "{broken");
        assert.deepEqual(await store.removeSession("target"), { envelopeFound: false, unifiedHadRows: true });
        assert.deepEqual(await store.findSessionFiles("target"), []);
        for (const file of files) {
            const siblings = readdirSync(join(dir, dirname(file)));
            const quarantined = siblings.find((name) => name.startsWith(`${basename(file)}.corrupt-`));
            assert.ok(quarantined);
            assert.equal(readFileSync(join(dir, dirname(file), quarantined), "utf8"), "{broken");
        }
    });
});

test("removeSession reports an unknown id without touching another session", async () => {
    await withStore(async (store, dir) => {
        await store.writeNow(session("survivor", "openai", "https://example.test"));
        const files = await store.findSessionFiles("survivor");
        const before = files.map((file) => readFileSync(join(dir, file)));
        assert.deepEqual(await store.removeSession("absent"), { envelopeFound: false, unifiedHadRows: false });
        files.forEach((file, i) => assert.deepEqual(readFileSync(join(dir, file)), before[i]));
        const db = UnifiedStore.open(join(dir, "index.db"));
        try { assert.ok(db.getSessionRow("survivor")); } finally { db.close(); }
    });
});

test.after(() => rmSync(root, { recursive: true, force: true }));
