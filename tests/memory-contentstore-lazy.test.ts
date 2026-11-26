import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { isDroppedContentStore, markDirty, residentBreakdown, type Session } from "../src/session.ts";
import { createInitialState, createContentStore, storeOriginal, type CoreMessage, type MessageContentStore } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

// #4788 phase 2 (owner decision 2026-10-31, discussion #3916-E): after an idle
// save, the resident CCR content store ({byRef}/{byHash} originals) folds to a
// lazy proxy that re-materializes on first touch from the landed copies
// (unified ccr mirror and/or the .content-store.json sidecar / envelope).
// Transparent to every consumer (one narrow read per burst); an unrecoverable
// drop THROWS instead of letting a save erase the non-empty originals (#2674).

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-bc-hermetic-")),
    "no-config.json",
);
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_PERSIST_TAIL_TOKENS = "600";
delete process.env.BILI_SESSION_CONTENT_STORE_PIN;

function makeSession(id: string): Session {
    return {
        id,
        meta: { label: id, protocol: "openai", upstreamOrigin: "http://up:1" },
        stats: { requests: 3, tokensSaved: 0, inputTokens: 10, cachedTokens: 0, outputTokens: 5, cacheSamples: 0, lastInputTokens: 10, contextTokens: 1000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

/** n refs over two repeated original texts (byHash dedup exercised too). */
function seedStore(n: number): MessageContentStore {
    let st = createContentStore();
    for (let i = 1; i <= n; i++) {
        const text = `CCR original transcript number ${i % 2 === 0 ? "A" : "B"}\nline two of the same shared original`;
        st = storeOriginal(st, {
            ref: `m${String(i).padStart(5, "0")}`,
            rawId: `raw-${i}`,
            text,
            kind: "shell output",
            toolName: "bash",
            tokens: 42,
            head: text.slice(0, 32),
        });
    }
    return st;
}


test("idle save folds the content store; first touch transparently re-materializes the full set", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cs-1-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("cs-1");
        s.contentStore = seedStore(30);
        s.contentStoreDirty = true; // what adoptContentStore does for real growth
        snapshotForSave(s);
        assert.ok(!isDroppedContentStore(s.contentStore), "starts plain");
        const fullBytes = residentBreakdown(s).contentStore;
        assert.ok(fullBytes > 25_000, `seeded originals should be measurable, got ${fullBytes}`);

        await store.writeNow(s);

        assert.ok(isDroppedContentStore(s.contentStore), "idle save swaps in the lazy proxy");
        // NOTE: measuring deepSizeOf through the proxy IS a touch (one narrow
        // read) — that is the design; RAM goes quiet only until first use.
        // First touch: full set back, byte-identical to what was seeded.
        const restored = residentBreakdown(s).contentStore;
        assert.ok(restored >= Math.floor(fullBytes * 0.9), `re-materialized set must match the seed (~${fullBytes}), got ${restored}`);
        assert.equal(Object.keys(s.contentStore!.byRef).length, 30, "all refs visible through the proxy");
        assert.equal(Object.keys(s.contentStore!.byHash).length, 2, "deduped originals visible");
        const entry = s.contentStore!.byRef["m00001"];
        assert.equal(entry.rawId, "raw-1");
        assert.equal(entry.tokens, 42);
    } finally {
        await closeQuietly(store);
        rmrf(dir);
    }
});

test("a save AFTER the fold persists the SAME full set — no thinned-record erase", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cs-2-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("cs-2");
        s.contentStore = seedStore(30);
        s.contentStoreDirty = true; // what adoptContentStore does for real growth
        snapshotForSave(s);
        await store.writeNow(s); // lands + folds
        assert.ok(isDroppedContentStore(s.contentStore));

        // Unrelated dirtying, then a forced full save that walks the proxy.
        s.stats.requests += 1;
        markDirty(s);
        store.flushSync(s);

        const cs = readSidecar(dir);
        assert.equal(Object.keys(cs.byRef).length, 30, "second save lost the store through the proxy");
        assert.equal(Object.keys(cs.byHash).length, 2);
        assert.ok(Object.values(cs.byHash)[0].includes("line two"), "originals byte-preserved");
    } finally {
        await closeQuietly(store);
        rmrf(dir);
    }
});

test("unsaved growth (contentStoreDirty) vetoes the fold — the new ref survives in RAM", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cs-3-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("cs-3");
        s.contentStore = seedStore(30);
        s.contentStoreDirty = true; // what adoptContentStore does for real growth
        snapshotForSave(s);
        await store.writeNow(s);
        assert.ok(isDroppedContentStore(s.contentStore));

        // Live growth through the materialized view (touch + append + dirty flag,
        // exactly what adoptContentStore does during processing).
        const touched = s.contentStore!; // fires ensure() — materializes in place
        const grew = storeOriginal(touched, {
            ref: "m00099", rawId: "raw-99", text: "brand-new original that has not been saved yet", kind: "tool", tokens: 7, head: "brand-new o",
        });
        s.contentStore = grew;
        s.contentStoreDirty = true;
        (store as unknown as { runIdleSpill(x: Session): void }).runIdleSpill(s);

        assert.equal(Object.keys(s.contentStore!.byRef).length, 31, "veto failed — unsaved ref would be re-loaded from a pre-growth disk copy");
        assert.ok(!isDroppedContentStore(s.contentStore) || Object.keys(s.contentStore!.byRef).length === 31);
    } finally {
        await closeQuietly(store);
        rmrf(dir);
    }
});

test("once the grown set settles, the store folds AGAIN and reads back all 31 from disk", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cs-4-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("cs-4");
        s.contentStore = seedStore(30);
        s.contentStoreDirty = true; // what adoptContentStore does for real growth
        snapshotForSave(s);
        await store.writeNow(s);
        const grew = storeOriginal(s.contentStore!, { ref: "m00099", rawId: "raw-99", text: "second-generation original", kind: "tool", tokens: 7, head: "second-gen" });
        s.contentStore = grew;
        s.contentStoreDirty = true;

        await store.writeNow(s); // settles the growth, then spills again

        assert.ok(isDroppedContentStore(s.contentStore), "settled store folds again");
        assert.equal(Object.keys(s.contentStore!.byRef).length, 31, "generation-2 ref must have round-tripped through disk");
        assert.equal(s.contentStore!.byRef["m00099"].rawId, "raw-99");
        const cs = readSidecar(dir);
        assert.equal(Object.keys(cs.byRef).length, 31);
    } finally {
        await closeQuietly(store);
        rmrf(dir);
    }
});

test("an unrecoverable drop REFUSES the thinned view — it throws, it never serves empty", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cs-5-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("cs-5");
        s.contentStore = seedStore(30);
        s.contentStoreDirty = true; // what adoptContentStore does for real growth
        snapshotForSave(s);
        await store.writeNow(s);
        assert.ok(isDroppedContentStore(s.contentStore));

        // Simulate both persistent sources being gone (full mode, jsonWriter off,
        // index damaged, no sidecar/envelope): nothing left to re-materialize from.
        (store as unknown as Record<string, unknown>).unifiedCcrFor = (): null => null;
        (store as unknown as Record<string, unknown>).contentStoreById = (): null => null;

        assert.throws(() => { void Object.keys(s.contentStore!.byRef); }, /could not be re-materialized from the store/, "must throw — an empty serve would let the next save erase proven-durable originals");
    } finally {
        await closeQuietly(store);
        rmrf(dir);
    }
});

test("BILI_SESSION_CONTENT_STORE_PIN keeps the old always-resident behavior", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cs-6-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("cs-6");
        s.contentStore = seedStore(30);
        s.contentStoreDirty = true; // what adoptContentStore does for real growth
        snapshotForSave(s);
        process.env.BILI_SESSION_CONTENT_STORE_PIN = "1";
        await store.writeNow(s);
        assert.ok(!isDroppedContentStore(s.contentStore), "pin honored — store stays resident");
        delete process.env.BILI_SESSION_CONTENT_STORE_PIN;
        (store as unknown as { runIdleSpill(x: Session): void }).runIdleSpill(s);
        assert.ok(isDroppedContentStore(s.contentStore), "pin removed — folds as usual");
    } finally {
        delete process.env.BILI_SESSION_CONTENT_STORE_PIN;
        await closeQuietly(store);
        rmrf(dir);
    }
});

test("the unified ccr mirror is preferred over the legacy sidecar when both exist", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cs-7-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("cs-7");
        s.contentStore = seedStore(30);
        s.contentStoreDirty = true; // what adoptContentStore does for real growth
        snapshotForSave(s);
        await store.writeNow(s);
        assert.ok(isDroppedContentStore(s.contentStore));

        const mirror = seedStore(30);
        (store as unknown as Record<string, unknown>).contentStoreById = (): null => null; // legacy source dark
        (store as unknown as Record<string, unknown>).unifiedCcrFor = (): MessageContentStore => mirror;
        assert.equal(Object.keys(s.contentStore!.byRef).length, 30, "re-materialized from the mirror");
        assert.equal(Object.keys(s.contentStore!.byHash).length, 2);
    } finally {
        await closeQuietly(store);
        rmrf(dir);
    }
});

test("a fork-child store (copy only in the parent envelope, nothing of its own landed) stays resident", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-cs-8-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        // A fork child receives its content store through the PARENT'S
        // envelope (record.forkContentStore): rehydrated children start clean
        // (persisted, no pending growth) with no sidecar of their own and no
        // index rows under their id. Dropping RAM here would throw on first
        // touch (child snapshot loses its parentRevision). The proof gate must
        // refuse — and because the store is NOT dirty, this isolates the
        // landed-copy check rather than the dirty veto.
        const c = makeSession("cs-fork-child");
        c.contentStore = seedStore(30);
        c.contentStoreDirty = false;
        c.persisted = true;

        (store as unknown as { runIdleSpill(x: Session): void }).runIdleSpill(c);
        assert.equal(
            (store as unknown as { contentStoreLanded(id: string, m?: unknown): boolean }).contentStoreLanded(c.id, c.meta),
            false,
            "gate: no provably-landed copy yet",
        );
        assert.ok(!isDroppedContentStore(c.contentStore), "child store must stay resident while unproven");
        assert.equal(Object.keys(c.contentStore!.byRef).length, 30, "full set still in RAM");

        // The moment the child grows real content under its own id, adoption
        // marks the store dirty; that save then writes its OWN sidecar, which
        // is the proof, and the store folds like any settled one.
        const grew = storeOriginal(c.contentStore!, {
            ref: "m00099", rawId: "raw-99", text: "first original minted under the child's own id", kind: "tool", tokens: 7, head: "first child",
        });
        c.contentStore = grew;
        c.contentStoreDirty = true;
        snapshotForSave(c);
        await store.writeNow(c);
        assert.ok(isDroppedContentStore(c.contentStore), "landed copy = proof — folds as usual");
        assert.equal(Object.keys(c.contentStore!.byRef).length, 31, "round-trips through its OWN sidecar");
    } finally {
        await closeQuietly(store);
        rmrf(dir);
    }
});

// --- helpers ---------------------------------------------------------------

function readSidecar(dir: string): { byRef: Record<string, unknown>; byHash: Record<string, string> } {
    const proto = readdirSync(dir, { withFileTypes: true }).find((d) => d.isDirectory())?.name;
    assert.ok(proto, "no protocol dir written");
    const file = readdirSync(path.join(dir, proto!)).find((f) => f.endsWith(".content-store.json"));
    assert.ok(file, "no .content-store.json sidecar written");
    const j = JSON.parse(readFileSync(path.join(dir, proto!, file!), "utf8")) as { byRef?: Record<string, unknown>; byHash?: Record<string, string> };
    return { byRef: j.byRef ?? {}, byHash: j.byHash ?? {} };
}

function snapshotForSave(s: Session): void {
    // buildRecord persists session.lastMessages tail; give it a tiny tail so the
    // envelope is a complete, realistic record (mirrors the block-contents suite).
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 3; i++) {
        msgs.push({ id: `msg-${i}`, contentType: "text", role: i === 0 ? "user" : "assistant", text: `content-store probe message ${i}` });
    }
    (s as unknown as { lastMessages: CoreMessage[] }).lastMessages = msgs;
}

async function closeQuietly(store: SessionStore): Promise<void> {
    try {
        await (store as unknown as { close(): Promise<void> }).close();
    } catch {
        /* best effort */
    }
}
