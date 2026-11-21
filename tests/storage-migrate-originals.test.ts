import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContentStore, createInitialState, storeOriginal, type MessageContentStore } from "acp-kernel";
import { SessionStore, contentStoreRelPathFor, relPathFor } from "../src/persist.ts";
import { createStorageCodec } from "../src/encrypt.ts";
import { runStorageMigrateCommand } from "../src/storage-maintenance.ts";
import type { Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const id = "migration-originals";
const meta: Session["meta"] = { protocol: "anthropic", upstreamOrigin: "https://originals.example" };
const originals = storeOriginal(createContentStore(), {
    ref: "m90001", rawId: "original-message", text: "café\nexact second line\r\n🧪",
    kind: "shell output", tokens: 12, head: "exact original", command: "printf original",
});

async function seed(dir: string, content = originals, requests = 1): Promise<void> {
    process.env.BILI_STORAGE_UNIFIED = "legacy";
    const store = new SessionStore({ dir, enabled: true });
    const session: Session = {
        id, meta, stats: { requests, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {}, state: createInitialState(), createdAt: Date.now(), lastSeen: Date.now(),
        blockContents: new Map(), inFlight: 0, persisted: false, pendingRetrievals: [],
        contentStore: content, contentStoreDirty: true,
    };
    try { await store.writeNow(session); }
    finally { await store.closeQuietlyAsync(); process.env.BILI_STORAGE_UNIFIED = "full"; }
}

async function indexedOriginals(dir: string): Promise<MessageContentStore | null> {
    const store = new SessionStore({ dir, enabled: true });
    try { return structuredClone(store.unifiedCcrFor(id)); }
    finally { await store.closeQuietlyAsync(); }
}

test("migration preserves paired originals and rerun verifies without rewriting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-"));
    try {
        await seed(dir);
        const source = join(dir, contentStoreRelPathFor(id, meta.protocol, meta.upstreamOrigin));
        const before = readFileSync(source);
        const first = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(first.code, 0, first.text);
        assert.deepEqual(await indexedOriginals(dir), originals, "SQLite must retain exact paired originals");
        const second = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(second.code, 0, second.text);
        assert.equal(JSON.parse(second.text).counts.indexed, 1);
        assert.equal(JSON.parse(second.text).counts.imported, 0);
        assert.deepEqual(readFileSync(source), before, "source originals remain untouched");
    } finally { rmrf(dir); }
});

test("corrupt paired originals fail migration before a session is acknowledged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-corrupt-"));
    try {
        await seed(dir);
        const source = join(dir, contentStoreRelPathFor(id, meta.protocol, meta.upstreamOrigin));
        writeFileSync(source, "not valid JSON");
        const result = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(result.code, 1, "corrupt originals cannot report successful migration");
        const store = new SessionStore({ dir, enabled: true });
        try { assert.deepEqual(store.unifiedListSessionIds(), [], "failed source must not be partially imported"); }
        finally { await store.closeQuietlyAsync(); }
        assert.equal(readFileSync(source, "utf8"), "not valid JSON");
    } finally { rmrf(dir); }
});

test("paired originals retain an independently matching session reference owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-owner-match-"));
    try {
        await seed(dir);
        const file = join(dir, relPathFor(id, meta.protocol, meta.upstreamOrigin));
        const record = JSON.parse(readFileSync(file, "utf8"));
        record.payload.state.messageRefs.byRef.m90001 = originals.byRef.m90001.rawId;
        record.payload.state.messageRefs.byRaw[originals.byRef.m90001.rawId] = "m90001";
        writeFileSync(file, JSON.stringify(record));
        const result = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(result.code, 0, result.text);
        assert.deepEqual(await indexedOriginals(dir), originals);
    } finally { rmrf(dir); }
});

test("paired originals retain frozen aliases for pruned message IDs without rekeying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-frozen-alias-"));
    try {
        await seed(dir);
        const file = join(dir, relPathFor(id, meta.protocol, meta.upstreamOrigin));
        const record = JSON.parse(readFileSync(file, "utf8"));
        delete record.payload.state.messageRefs.byRaw[originals.byRef.m90001.rawId];
        record.payload.state.messageRefs.byRef.m90001 = "a-different-known-message";
        record.payload.state.messageRefs.byRaw["a-different-known-message"] = "m90001";
        writeFileSync(file, JSON.stringify(record));
        const before = readFileSync(file);
        const result = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(result.code, 0, "an unmapped frozen original is allowed by the existing fork alias contract");
        assert.deepEqual(await indexedOriginals(dir), originals, "migration must preserve the original keys and bodies exactly");
        assert.deepEqual(readFileSync(file), before, "source refs must not be repaired or reassigned");
    } finally { rmrf(dir); }
});

test("paired originals under a pre-renumbering ref are re-keyed to the message's current ref", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-rekey-"));
    try {
        await seed(dir);
        const file = join(dir, relPathFor(id, meta.protocol, meta.upstreamOrigin));
        const source = join(dir, contentStoreRelPathFor(id, meta.protocol, meta.upstreamOrigin));
        const record = JSON.parse(readFileSync(file, "utf8"));
        record.payload.state.messageRefs.byRef.m90001 = "a-different-known-message";
        record.payload.state.messageRefs.byRaw["a-different-known-message"] = "m90001";
        record.payload.state.messageRefs.byRaw[originals.byRef.m90001.rawId] = "m90002";
        record.payload.state.messageRefs.byRef.m90002 = originals.byRef.m90001.rawId;
        writeFileSync(file, JSON.stringify(record));
        const before = readFileSync(file);
        const sourceBefore = readFileSync(source);
        const result = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(result.code, 0, result.text);
        const indexed = await indexedOriginals(dir);
        assert.deepEqual(indexed?.byRef, { m90002: originals.byRef.m90001 }, "the original follows its message, never the other owner of m90001");
        assert.deepEqual(indexed?.byHash, originals.byHash);
        assert.deepEqual(readFileSync(file), before, "source refs stay untouched");
        assert.deepEqual(readFileSync(source), sourceBefore, "source originals stay untouched");
    } finally { rmrf(dir); }
});

test("paired originals cannot attach to an inconsistent session ref map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-owner-"));
    try {
        await seed(dir);
        const file = join(dir, relPathFor(id, meta.protocol, meta.upstreamOrigin));
        const record = JSON.parse(readFileSync(file, "utf8"));
        record.payload.state.messageRefs.byRaw[originals.byRef.m90001.rawId] = "m90001";
        record.payload.state.messageRefs.byRef.m90001 = "a-different-known-message";
        record.payload.state.messageRefs.byRaw["a-different-known-message"] = "m90001";
        writeFileSync(file, JSON.stringify(record));
        const before = readFileSync(file);
        const result = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(result.code, 1, "a ref the map assigns both ways to different messages must not be imported");
        assert.equal(JSON.parse(result.text).counts.failed, 1);
        const store = new SessionStore({ dir, enabled: true });
        try { assert.deepEqual(store.unifiedListSessionIds(), [], "wrong-owner source must not be partially imported"); }
        finally { await store.closeQuietlyAsync(); }
        assert.deepEqual(readFileSync(file), before);
    } finally { rmrf(dir); }
});

test("already-indexed sessions cannot hide changed originals on rerun", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-drift-"));
    try {
        await seed(dir);
        assert.equal((await runStorageMigrateCommand({ dir, json: true })).code, 0);
        const changed = storeOriginal(createContentStore(), {
            ref: "m90001", rawId: "different-message", text: "different bytes",
            kind: "shell output", tokens: 4, head: "different",
        });
        writeFileSync(join(dir, contentStoreRelPathFor(id, meta.protocol, meta.upstreamOrigin)), JSON.stringify(changed));
        const result = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(result.code, 1, "source/index originals divergence must be reported");
        assert.deepEqual(await indexedOriginals(dir), originals, "rerun must not replace indexed originals");
    } finally { rmrf(dir); }
});

test("missing body in a paired originals store is a failed migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-missing-"));
    try {
        await seed(dir);
        const broken = { ...originals, byHash: {} };
        writeFileSync(join(dir, contentStoreRelPathFor(id, meta.protocol, meta.upstreamOrigin)), JSON.stringify(broken));
        assert.equal((await runStorageMigrateCommand({ dir, json: true })).code, 1);
    } finally { rmrf(dir); }
});

test("dry-run reports corrupt originals and does not import them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-dry-"));
    try {
        await seed(dir);
        writeFileSync(join(dir, contentStoreRelPathFor(id, meta.protocol, meta.upstreamOrigin)), "broken");
        const result = await runStorageMigrateCommand({ dir, json: true, dryRun: true });
        assert.equal(result.code, 0, "dry-run retains the existing CLI exit-code contract");
        assert.equal(JSON.parse(result.text).counts.failed, 1);
    } finally { rmrf(dir); }
});

test("cold compressed paired originals migrate exactly", async () => {
    const root = mkdtempSync(join(tmpdir(), "bili-migrate-originals-cold-"));
    const dir = join(root, "sessions");
    try {
        await seed(dir);
        const sidecar = join(dir, contentStoreRelPathFor(id, meta.protocol, meta.upstreamOrigin));
        const codec = createStorageCodec({ compress: true });
        assert.ok(codec);
        writeFileSync(sidecar, codec.encode(JSON.stringify(originals)));
        renameSync(dir, `${dir}-cold`);
        mkdirSync(dir);
        const result = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(result.code, 0, result.text);
        assert.deepEqual(await indexedOriginals(dir), originals);
        assert.ok(JSON.parse(result.text).results[0].file.startsWith("cold:"));
    } finally { rmrf(root); }
});

test("ahead import retains prior indexed originals alongside new source originals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-ahead-"));
    try {
        await seed(dir);
        assert.equal((await runStorageMigrateCommand({ dir, json: true })).code, 0);
        const next = storeOriginal(createContentStore(), {
            ref: "m90002", rawId: "next-message", text: "new original\n",
            kind: "file read", tokens: 4, head: "next",
        });
        await seed(dir, next, 2);
        const result = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(result.code, 0, result.text);
        assert.deepEqual(await indexedOriginals(dir), {
            version: 1, byHash: { ...originals.byHash, ...next.byHash }, byRef: { ...originals.byRef, ...next.byRef },
        });
        const rerun = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(rerun.code, 0, rerun.text);
        assert.equal(JSON.parse(rerun.text).counts.indexed, 1);
        assert.equal(JSON.parse(rerun.text).counts.imported, 0);
        assert.deepEqual(await indexedOriginals(dir), {
            version: 1, byHash: { ...originals.byHash, ...next.byHash }, byRef: { ...originals.byRef, ...next.byRef },
        });
    } finally { rmrf(dir); }
});

test("ahead import refuses conflicting indexed references without replacing them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-conflict-"));
    try {
        await seed(dir);
        assert.equal((await runStorageMigrateCommand({ dir, json: true })).code, 0);
        const conflict = storeOriginal(createContentStore(), {
            ref: "m90001", rawId: "conflicting-message", text: "conflicting bytes",
            kind: "file read", tokens: 4, head: "conflict",
        });
        await seed(dir, conflict, 2);
        const result = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(result.code, 1);
        assert.match(result.text, /conflicting CCR original reference/);
        assert.deepEqual(await indexedOriginals(dir), originals);
    } finally { rmrf(dir); }
});

test("embedded fork originals cannot silently conflict with the paired sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-fork-"));
    try {
        await seed(dir);
        const file = join(dir, relPathFor(id, meta.protocol, meta.upstreamOrigin));
        const record = JSON.parse(readFileSync(file, "utf8"));
        record.payload.forkContentStore = storeOriginal(createContentStore(), {
            ref: "m90001", rawId: "fork-message", text: "fork bytes",
            kind: "file read", tokens: 4, head: "fork",
        });
        writeFileSync(file, JSON.stringify(record));
        const result = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(result.code, 1);
        assert.match(result.text, /conflicting CCR original reference/);
    } finally { rmrf(dir); }
});

test("an old partial index is reported drifted when its originals are absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-partial-"));
    try {
        await seed(dir, createContentStore());
        assert.equal((await runStorageMigrateCommand({ dir, json: true })).code, 0);
        await seed(dir);
        const result = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(result.code, 1);
        assert.equal(JSON.parse(result.text).counts.drifted, 1);
        assert.match(result.text, /CCR originals/);
    } finally { rmrf(dir); }
});

test("UUID-only original reference drift is rejected without replacing indexed originals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-migrate-originals-uuid-"));
    try {
        const initial = storeOriginal(createContentStore(), {
            ref: "m90001", rawId: "00000000-0000-4000-8000-000000000001", text: "stable original bytes",
            kind: "file read", tokens: 4, head: "stable",
        });
        await seed(dir, initial);
        assert.equal((await runStorageMigrateCommand({ dir, json: true })).code, 0);
        const changed = structuredClone(initial);
        changed.byRef.m90001.rawId = "00000000-0000-4000-8000-000000000002";
        writeFileSync(join(dir, contentStoreRelPathFor(id, meta.protocol, meta.upstreamOrigin)), JSON.stringify(changed));
        const rerun = await runStorageMigrateCommand({ dir, json: true });
        assert.equal(rerun.code, 1, "UUID normalization must not hide exact original identity drift");
        assert.deepEqual(await indexedOriginals(dir), initial);
    } finally { rmrf(dir); }
});
