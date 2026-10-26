import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { Session, cacheBlockContent, residentBreakdown, snapshotMessages, LazyBlockContents } from "../src/session.ts";
import { createInitialState, type CoreMessage } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

// #3050 R3 ②b: after an idle save, the resident block-contents map folds to
// a lazy shell; the next touch re-materializes the full set from the store,
// and a later save persists the SAME set (no thinned-record erase).

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-bc-hermetic-")),
    "no-config.json",
);
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_PERSIST_TAIL_TOKENS = "600";

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

function seedBlocks(s: Session, n: number): void {
    for (let i = 1; i <= n; i++) {
        cacheBlockContent(s, `b${i}`, {
            one: null,
            full: { text: `ORIGINAL content of block b${i}\nline two of the original transcript`, count: 2 },
        });
    }
}

function rawTail(n: number): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (let i = 0; i < n; i++) {
        out.push({ id: `mb${i}`, contentType: "text", role: i % 2 === 0 ? "user" : "assistant", text: `block-content probe message number ${i} with filler words to spend tokens` });
    }
    return out;
}

function readRecord(dir: string): Record<string, unknown> {
    const proto = readdirSync(dir, { withFileTypes: true }).find((d) => d.isDirectory())?.name;
    assert.ok(proto, "no protocol dir written");
    const file = readdirSync(path.join(dir, proto!)).find((f) => f.endsWith(".json"));
    assert.ok(file, "no session file written");
    const envelope = JSON.parse(readFileSync(path.join(dir, proto!, file!), "utf8")) as { payload: Record<string, unknown> };
    return envelope.payload;
}

test("idle save folds block contents to a lazy shell; next touch re-materializes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-bc-1-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("bc-1");
        seedBlocks(s, 40);
        snapshotMessages(s, rawTail(50));
        const fullBytes = residentBreakdown(s).blockContents;
        assert.ok(fullBytes > 4_000, `seeded contents should be measurable, got ${fullBytes}`);

        await store.writeNow(s);

        assert.ok(s.blockContents instanceof LazyBlockContents, "idle save swaps in the lazy map");
        assert.equal((s.blockContents as LazyBlockContents).isDropped, true, "contents folded away");
        assert.ok(residentBreakdown(s).blockContents < 200, `lazy shell must be ~0 bytes, got ${residentBreakdown(s).blockContents}`);
        // The envelope keeps every entry — disk is the authority.
        const payload = readRecord(dir);
        assert.equal(Object.keys(payload.blockContents as object).length, 40);

        // Next touch re-materializes the full set through the store.
        const content = s.blockContents.get("b7")!;
        assert.ok(content.full.text.includes("ORIGINAL content of block b7"));
        assert.equal(s.blockContents.size, 40, "full set resident again");
        assert.equal((s.blockContents as LazyBlockContents).isDropped, false);

        // And a later save writes the SAME 40 entries (no thinned erase).
        await store.writeNow(s);
        assert.equal(Object.keys(readRecord(dir).blockContents as object).length, 40);
    } finally {
        store.cancelAll();
        rmrf(dir);
    }
});

test("writes on a dropped map merge instead of erasing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-bc-2-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("bc-2");
        seedBlocks(s, 3);
        snapshotMessages(s, rawTail(10));
        await store.writeNow(s);
        assert.equal((s.blockContents as LazyBlockContents).isDropped, true);

        // A new fold lands while the map is still folded (e.g. external
        // summary side-write): set() re-materializes then appends.
        cacheBlockContent(s, "b4", { one: null, full: { text: "fresh original b4", count: 1 } });
        assert.equal(s.blockContents.size, 4, "materialized set + the new entry");
        await store.writeNow(s);
        assert.equal(Object.keys(readRecord(dir).blockContents as object).length, 4, "nothing lost on the merge path");
    } finally {
        store.cancelAll();
        rmrf(dir);
    }
});

test("mid-turn save keeps the resident set; unrecoverable drop refuses to go empty", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-bc-3-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("bc-3");
        seedBlocks(s, 2);
        snapshotMessages(s, rawTail(5));
        s.inFlight = 1;
        await store.writeNow(s);
        assert.ok(!(s.blockContents instanceof LazyBlockContents) || !(s.blockContents as LazyBlockContents).isDropped, "in-flight save must not fold");
        assert.equal(s.blockContents.size, 2);
        s.inFlight = 0;
        await store.writeNow(s);
        assert.equal((s.blockContents as LazyBlockContents).isDropped, true);

        // Simulate the store losing the record: a dropped map must THROW on
        // access rather than silently become an empty set that a later save
        // would persist as an erase.
        const broken = makeSession("bc-broken");
        seedBlocks(broken, 2);
        snapshotMessages(broken, rawTail(5));
        await store.writeNow(broken);
        // never persisted a record for this id:
        const lazy = new LazyBlockContents("no-such-session", { protocol: "openai" }, () => null);
        lazy.drop();
        assert.throws(() => lazy.get("b1"), /could not be re-materialized/, "missing disk record must fail loudly");
    } finally {
        store.cancelAll();
        rmrf(dir);
    }
});
