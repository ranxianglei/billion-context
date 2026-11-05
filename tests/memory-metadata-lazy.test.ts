import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { Session, isDroppedMetadata, lazyMetadata, residentBreakdown, snapshotMessages } from "../src/session.ts";
import { createInitialState, type CoreMessage } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

// #3050 R3 ②c: after an idle save, the resident metadata record folds to a
// transparent lazy proxy; any access re-materializes the persisted shape,
// and a later save persists the SAME keys (no thinned-record erase).

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-md-hermetic-")),
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

function rawTail(n: number): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (let i = 0; i < n; i++) {
        out.push({ id: `mm${i}`, contentType: "text", role: i % 2 === 0 ? "user" : "assistant", text: `metadata probe message number ${i} with filler words to spend tokens` });
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

test("idle save folds metadata to a lazy proxy; access re-materializes the persisted shape", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-md-1-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("md-1");
        s.metadata.foldAnchors = { m00001: { c: "text", frags: ["a", "b"] }, m00002: { c: "tool-call" } };
        s.metadata.cacheLedger = { restartDrops: { count: 2 } };
        s.metadata.effectiveConfig = { compress: { promptPack: "lean" } };
        snapshotMessages(s, rawTail(50));
        const fullBytes = residentBreakdown(s).metadata;
        assert.ok(fullBytes > 500, `seeded metadata measurable, got ${fullBytes}`);

        await store.writeNow(s);

        assert.equal(isDroppedMetadata(s.metadata), true, "metadata folded to a lazy proxy");
        assert.ok(residentBreakdown(s).metadata < 200, `folded proxy ~0 bytes, got ${residentBreakdown(s).metadata}`);
        // Envelope keeps every key — disk is the authority. The persisted
        // record additionally stamps biliVersion/storageMode (persist.ts
        // buildRecord), and the materialized shape is exactly this disk
        // shape — the same record a restart would restore.
        assert.deepEqual(Object.keys(readRecord(dir).metadata as object).sort(), ["biliVersion", "cacheLedger", "effectiveConfig", "foldAnchors", "storageMode"]);

        // Any access re-materializes the persisted shape verbatim.
        assert.deepEqual((s.metadata.foldAnchors as Record<string, unknown>).m00002, { c: "tool-call" });
        assert.equal(isDroppedMetadata(s.metadata), false, "materialized on read");
        assert.deepEqual(s.metadata.cacheLedger, { restartDrops: { count: 2 } });
        assert.equal(typeof s.metadata.biliVersion, "string", "disk-stamped fields present (restart shape)");

        // A later save writes the SAME keys — no thinned erase.
        s.metadata.newKey = { n: 1 };
        await store.writeNow(s);
        const keys = Object.keys(readRecord(dir).metadata as object).sort();
        assert.deepEqual(keys, ["biliVersion", "cacheLedger", "effectiveConfig", "foldAnchors", "newKey", "storageMode"]);
    } finally {
        store.cancelAll();
        rmrf(dir);
    }
});

test("proxy semantics survive the usual record operations after a fold", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-md-2-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("md-2");
        s.metadata.keep = "v";
        s.metadata.gone = "v2";
        snapshotMessages(s, rawTail(10));
        await store.writeNow(s);
        assert.equal(isDroppedMetadata(s.metadata), true);

        assert.equal("keep" in s.metadata, true, "'in' works on the folded proxy");
        delete s.metadata.gone;
        assert.equal(s.metadata.keep, "v");
        const spread = { ...s.metadata };
        assert.equal(spread.keep, "v");
        assert.equal("gone" in spread, false);
        const roundTripped = JSON.parse(JSON.stringify(s.metadata));
        assert.deepEqual(roundTripped, { keep: "v", biliVersion: roundTripped.biliVersion, storageMode: roundTripped.storageMode }, "JSON round-trip of the materialized (restart) shape");
        await store.writeNow(s);
        const persistedKeys = Object.keys(readRecord(dir).metadata as object).sort();
        assert.ok(persistedKeys.includes("keep") && !persistedKeys.includes("gone"), `delete survived: ${persistedKeys}`);
    } finally {
        store.cancelAll();
        rmrf(dir);
    }
});

test("mid-turn save keeps resident metadata; unrecoverable drop refuses to go empty", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-md-3-"));
    const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
    try {
        const s = makeSession("md-3");
        s.metadata.a = 1;
        snapshotMessages(s, rawTail(5));
        s.inFlight = 1;
        await store.writeNow(s);
        assert.equal(isDroppedMetadata(s.metadata), false, "in-flight save must not fold");
        assert.equal(s.metadata.a, 1);
        s.inFlight = 0;
        await store.writeNow(s);
        assert.equal(isDroppedMetadata(s.metadata), true);

        const broken = lazyMetadata("no-such-session", { protocol: "openai" }, () => null);
        assert.throws(() => broken.anyKey, /could not be re-materialized/, "missing disk record must fail loudly, not read as empty");
    } finally {
        store.cancelAll();
        rmrf(dir);
    }
});
