import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { contentStoreOf } from "../src/store.ts";
import { Session } from "../src/session.ts";
import { createContentStore, createInitialState } from "acp-kernel";
import { UnifiedStore } from "../src/storage/store.ts";
import { loadLegacyView } from "../src/storage/ingest.ts";
import { rmrf } from "./tmp-rm.ts";

// readRecord-style file inspection requires the plain-JSON codec.
process.env.BILI_PERSIST_ZSTD = "0";

// #2671 hermeticity: pin the config file + legacy baseline; per-test legs
// override BILI_STORAGE_UNIFIED explicitly.
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-ccr-hermetic-")),
    "no-config.json",
);
process.env.BILI_STORAGE_UNIFIED = "legacy";

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://up:1", title: "ccr test" },
        stats: { requests: 3, tokensSaved: 0, inputTokens: 10, cachedTokens: 0, outputTokens: 5, cacheSamples: 0, lastInputTokens: 10, contextTokens: 1000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        state: createInitialState(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

/** A content store holding one retrievable original under ref m00002. */
function makeCcr() {
    const ccr = createContentStore();
    ccr.byHash["sha256-ccr-original"] = "ORIGINAL-BODY-XYZ";
    ccr.byRef["m00002"] = { hash: "sha256-ccr-original", rawId: "raw-2", kind: "file read", tokens: 7, chars: 17, head: "ORIGINAL-BODY-XYZ" };
    return ccr;
}

function sidecarPath(dir: string, id: string, origin = "http://up:1"): string {
    const proto = readdirSync(dir, { withFileTypes: true }).find((d) => d.isDirectory() && d.name !== ".bili-migration-286.done")?.name;
    assert.ok(proto, "no protocol dir");
    const hash = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24);
    return path.join(dir, proto!, `up_${hash}.content-store.json`);
}

test("ccr: full mode ingests the LIVE store and serves it after the sidecar is gone (#2960 ③)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-ccr-full-"));
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const session = makeSession("ccr-full-1");
        session.contentStore = makeCcr();
        session.contentStoreDirty = true;
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        await store.writeNow(session);
        store.closeQuietly();
        assert.ok(existsSync(sidecarPath(dir, "ccr-full-1")), "sidecar was not written (payload-first contract)");

        // The unified row mirrors the LIVE store even though this session has
        // no fork receipt (the envelope would have dropped it).
        const unified = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const rowCcr = unified.getCcr("ccr-full-1");
            assert.ok(rowCcr, "sessions.ccr_json mirror is empty for a live (non-fork) CCR session");
            assert.equal(rowCcr!.byRef["m00002"].hash, "sha256-ccr-original");
            assert.equal(unified.getCcrEntries("ccr-full-1").length, 1);
        } finally {
            unified.close();
        }

        // Lose the sidecar entirely: full-mode loadSync still restores the
        // store from the index (record.forkContentStore leg).
        rmSync(sidecarPath(dir, "ccr-full-1"), { force: true });
        const store2 = new SessionStore({ dir, debounceMs: 1, enabled: true });
        const restored = store2.loadSync("ccr-full-1");
        store2.closeQuietly();
        assert.ok(restored, "full-mode loadSync returned null after sidecar loss");
        assert.ok(restored!.contentStore, "restored session lost its CCR store despite the unified mirror");
        assert.equal(restored!.contentStore!.byRef["m00002"].hash, "sha256-ccr-original");

        // Lazy first-touch path is unified-first too: a session whose store
        // was never materialized gets it from the index, not the (absent)
        // file. Drive it through the GLOBAL store (contentStoreOf calls
        // getStore()), pointed at this test's dir.
        const store3 = new SessionStore({ dir, debounceMs: 1, enabled: true });
        _setStoreForTest(store3);
        try {
            const lazy = makeSession("ccr-full-1");
            const viaLazy = contentStoreOf(lazy);
            assert.equal(viaLazy.byRef["m00002"].hash, "sha256-ccr-original", "contentStoreOf did not serve the unified CCR mirror");
        } finally {
            store3.closeQuietly();
        }
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        rmrf(dir);
    }
});

test("ccr: shadow parity — live store ingest keeps both digest legs equal (#2960 ③)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-ccr-shadow-"));
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "shadow";
    try {
        const session = makeSession("ccr-shadow-1");
        session.contentStore = makeCcr();
        session.contentStoreDirty = true;
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        await store.writeNow(session);
        // The claim in the name needs teeth: record() digests BOTH legs through
        // the same liveCcr override, so any lossy CCR table round-trip would
        // trip verifyDrift on this very write (#2960 ③ review).
        const stats = (store as unknown as {
            shadow?: { stats: { ingests: number; verifyOk: number; verifyDrift: number } };
        }).shadow?.stats;
        assert.ok(stats && stats.ingests >= 1, "shadow ingest did not run");
        assert.equal(stats!.verifyDrift, 0, "liveCcr override drifted the digest legs");
        assert.ok(stats!.verifyOk >= 1, "no verified ingest recorded");
        store.closeQuietly();
        const unified = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const rowCcr = unified.getCcr("ccr-shadow-1");
            assert.ok(rowCcr, "shadow row did not mirror the live store");
            assert.equal(rowCcr!.byRef["m00002"]?.hash, "sha256-ccr-original");
            // Got-leg data: the replayed view carries the same store the caller had.
            const view = loadLegacyView({
                session: unified.getSessionRow("ccr-shadow-1")!,
                messages: unified.getMessages("ccr-shadow-1"),
                blocks: unified.getBlocks("ccr-shadow-1"),
                deadRefs: unified.getDeadRefs("ccr-shadow-1"),
                refs: unified.getRefs("ccr-shadow-1"),
            });
            assert.equal((view.contentStore?.byRef["m00002"] as { hash?: string } | undefined)?.hash, "sha256-ccr-original", "replayed view lost the CCR ref entry");
            assert.equal(view.contentStore?.byHash["sha256-ccr-original"], "ORIGINAL-BODY-XYZ", "replayed view lost the CCR original");
        } finally {
            unified.close();
        }
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        rmrf(dir);
    }
});

test("ccr: legacy mode keeps the file as the read of record (#2960 ③ control)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-ccr-legacy-"));
    try {
        const session = makeSession("ccr-legacy-1");
        session.contentStore = makeCcr();
        session.contentStoreDirty = true;
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        await store.writeNow(session);
        store.closeQuietly();
        assert.ok(existsSync(sidecarPath(dir, "ccr-legacy-1")), "legacy sidecar missing");

        const store2 = new SessionStore({ dir, debounceMs: 1, enabled: true });
        const restored = store2.loadSync("ccr-legacy-1", { protocol: "openai", upstreamOrigin: "http://up:1" });
        assert.ok(restored, "legacy loadSync returned null");
        // No fork receipt → the envelope never carried the store; the lazy
        // path must fall back to the FILE and still serve the original.
        _setStoreForTest(store2);
        try {
            const lazy = { ...restored!, contentStore: undefined } as Session;
            const viaLazy = contentStoreOf(lazy);
            assert.equal(viaLazy.byRef["m00002"].hash, "sha256-ccr-original", "legacy lazy path lost the file-served store");
        } finally {
            store2.closeQuietly();
        }
    } finally {
        rmrf(dir);
    }
});
