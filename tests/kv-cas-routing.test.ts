import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// #7378: a kv value that exceeds the 4 MiB inline cap (EXT_VALUE_MAX_BYTES) is
// routed into the content CAS; the kv row keeps a small CAS ref and the payload
// lives in the content table (refcount-managed). Before this fix, setKv threw
// "extension value exceeds 4194304 bytes" and the session-order skeleton fell
// back to the legacy file path for the process lifetime. This suite pins the
// round-trip AND the refcount discipline (no orphaned blobs).

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-kv-cas-"));
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_SESSIONS_DIR = path.join(root, "sessions");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");

const { getStore, _resetStoreForTest } = await import("../src/persist.js");

const dbPath = path.join(root, "sessions", "index.db");

/** Open the index.db read-only (WAL allows concurrent readers) and run a query. */
function query<T>(sql: string, ...args: unknown[]): T[] {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        return db.prepare(sql).all(...(args as never[])) as T[];
    } finally {
        db.close();
    }
}

const NS = "cas-test";
// ~5 MiB when JSON-serialized — comfortably over the 4 MiB inline cap.
const BIG_STRING = "x".repeat(5 * 1024 * 1024);
const bigValue = { payload: BIG_STRING, marker: "big" };

before(() => {
    getStore();
});

after(() => {
    _resetStoreForTest();
    fs.rmSync(root, { recursive: true, force: true });
});

test("setKv of an oversized value does not throw and routes to the CAS", () => {
    // The regression: before the fix this threw "extension value exceeds
    // 4194304 bytes — store large payloads in the content CAS instead".
    getStore().setKv(NS, "big", bigValue);

    // The kv row holds a small CAS ref, not the 5 MiB payload.
    const [row] = query<{ value_json: string }>(
        "SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?",
        NS,
        "big",
    );
    assert.ok(row, "kv row exists");
    assert.ok(Buffer.byteLength(row.value_json, "utf8") < 256, `kv row is a small CAS ref, got ${Buffer.byteLength(row.value_json)} bytes`);
    const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
    assert.ok(typeof parsed["$biliCas"] === "string", "kv row carries the $biliCas ref");
    const hash = parsed["$biliCas"] as string;

    // The payload lives in the content table with refcount 1.
    const [blob] = query<{ refcount: number; byte_len: number }>(
        "SELECT refcount, byte_len FROM content WHERE hash = ?",
        hash,
    );
    assert.ok(blob, "content blob exists");
    assert.equal(blob.refcount, 1, "blob refcount is 1");
    assert.ok(blob.byte_len > 4 * 1024 * 1024, "blob is the full payload");
});

test("getKv resolves the CAS ref back to the original value", () => {
    const got = getStore().getKv(NS, "big") as typeof bigValue;
    assert.equal(got.marker, "big");
    assert.equal(got.payload, BIG_STRING, "payload round-trips byte-exact");
});

test("listKv resolves CAS refs for every row", () => {
    const rows = getStore().listKv(NS);
    const big = rows.find((r) => r.key === "big");
    assert.ok(big, "listKv returns the big row");
    assert.equal((big.value as typeof bigValue).payload, BIG_STRING);
});

test("small values stay inline (no CAS ref)", () => {
    getStore().setKv(NS, "small", { hello: "world" });
    const [row] = query<{ value_json: string }>(
        "SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?",
        NS,
        "small",
    );
    assert.ok(row, "small kv row exists");
    const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
    assert.equal(parsed["$biliCas"], undefined, "small value is inline, not a CAS ref");
    assert.equal(parsed.hello, "world");
});

test("overwriting an oversized value keeps the refcount balanced", () => {
    // Overwrite with a DIFFERENT oversized payload: old blob released (refcount
    // 0 → deleted), new blob at refcount 1.
    const otherBig = { payload: "y".repeat(5 * 1024 * 1024), marker: "other" };
    getStore().setKv(NS, "big", otherBig);

    const [row] = query<{ value_json: string }>(
        "SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?",
        NS,
        "big",
    );
    const newHash = (JSON.parse(row.value_json) as Record<string, unknown>)["$biliCas"] as string;

    const [newBlob] = query<{ refcount: number }>("SELECT refcount FROM content WHERE hash = ?", newHash);
    assert.ok(newBlob, "new blob exists");
    assert.equal(newBlob.refcount, 1, "new blob refcount is 1");

    // The old blob must be gone (refcount dropped to 0 → delete-on-zero).
    const oldHashes = query<{ hash: string }>("SELECT hash FROM content WHERE refcount > 0");
    assert.equal(oldHashes.length, 1, "exactly one live blob remains (the new one)");
    assert.equal(oldHashes[0].hash, newHash);

    // And the value round-trips to the new payload.
    const got = getStore().getKv(NS, "big") as typeof otherBig;
    assert.equal(got.marker, "other");
    assert.equal(got.payload, "y".repeat(5 * 1024 * 1024));
});

test("deleteKv releases the CAS ref (blob reclaimed)", () => {
    getStore().deleteKv(NS, "big");
    // No live blobs left for this namespace's payload.
    const live = query<{ hash: string }>("SELECT hash FROM content WHERE refcount > 0");
    assert.equal(live.length, 0, "deleteKv released the CAS ref; no live blobs remain");
    assert.equal(getStore().getKv(NS, "big"), undefined, "value is gone");
});

test("deleting the whole namespace releases every CAS ref", () => {
    getStore().setKv(NS, "a", { payload: "z".repeat(5 * 1024 * 1024) });
    getStore().setKv(NS, "b", { payload: "w".repeat(5 * 1024 * 1024) });
    const removed = getStore().deleteKv(NS);
    assert.equal(removed, 3, "removed a, b and the leftover small row");
    const live = query<{ hash: string }>("SELECT hash FROM content WHERE refcount > 0");
    assert.equal(live.length, 0, "whole-namespace delete released every CAS ref");
});
