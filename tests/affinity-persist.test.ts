import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrefixAffinityResolver, prefixAffinity, MAX_TRACKED_SESSIONS } from "../src/prefix-affinity.ts";
import { flushPrefixAffinity, hydratePrefixAffinity } from "../src/affinity-persist.ts";

let tmp: string;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "affinity-persist-"));
    process.env.XDG_STATE_HOME = tmp;
});

function messages(n: number): unknown[] {
    const out: unknown[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < n; i++) out.push({ role: "user", content: `msg ${i}` });
    return out;
}

test("exportSnapshot/importSnapshot roundtrip preserves resolution", () => {
    const a = new PrefixAffinityResolver();
    const first = a.resolve(messages(10));
    assert.ok(first);
    a.note(first.sessionId, first.incomingDepth, first.tailHash, first.itemHashes);
    const snapshot = a.exportSnapshot();
    assert.ok(snapshot.length === 1);

    const b = new PrefixAffinityResolver();
    assert.equal(b.importSnapshot(snapshot), 1);
    const replay = b.resolve(messages(10));
    assert.ok(replay);
    assert.equal(replay.via, "prefix");
    assert.equal(replay.sessionId, first.sessionId, "rehydrated chain still resolves to the same session");
});

test("importSnapshot drops malformed entries; aged chains stay permanent (#1724)", () => {
    const r = new PrefixAffinityResolver();
    assert.equal(r.importSnapshot("nope"), 0);
    assert.equal(r.importSnapshot([{ sessionId: 1 }, { sessionId: "x", depth: "3" }, null]), 0, "malformed are skipped");
    // 400 days old — the month/year single-session promise keeps it valid.
    assert.equal(r.importSnapshot([{ sessionId: "ok", depth: 3, tailHash: "t", itemHashes: ["h1", "h2"], lastSeen: Date.now() - 400 * 24 * 60 * 60 * 1000 }]), 1, "permanent chains import regardless of age");
});

test("flush writes the snapshot file; hydrate reattaches after a restart", () => {
    const m = messages(6);
    const aff = prefixAffinity.resolve(m);
    assert.ok(aff && aff.via === "new");
    prefixAffinity.note(aff.sessionId, aff.incomingDepth, aff.tailHash, aff.itemHashes);
    flushPrefixAffinity();

    const file = path.join(tmp, "billion-context", "prefix-affinity.json");
    assert.ok(fs.existsSync(file));
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number; entries: unknown[] };
    assert.equal(parsed.version, 1);
    assert.ok(parsed.entries.length >= 1);

    prefixAffinity.forget(aff.sessionId);
    assert.ok(!prefixAffinity.trackedSessionIds().includes(aff.sessionId));
    hydratePrefixAffinity();
    assert.ok(prefixAffinity.trackedSessionIds().includes(aff.sessionId), "chain restored from disk");
    const replay = prefixAffinity.resolve(m);
    assert.ok(replay && replay.via === "prefix" && replay.sessionId === aff.sessionId);
});

test("hydrate on a missing or corrupt file is a no-op", () => {
    hydratePrefixAffinity();
    const file = path.join(tmp, "billion-context", "prefix-affinity.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    hydratePrefixAffinity();
});

test("writeSnapshot unions with on-disk chains instead of clobbering a sibling instance's (#1724)", () => {
    const m6 = messages(6);
    const a = prefixAffinity.resolve(m6);
    assert.ok(a);
    prefixAffinity.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes);

    const sib = new PrefixAffinityResolver();
    const b = sib.resolve(messages(9));
    assert.ok(b && b.sessionId !== a.sessionId);
    sib.note(b.sessionId, b.incomingDepth, b.tailHash, b.itemHashes);

    const file = path.join(tmp, "billion-context", "prefix-affinity.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [...sib.exportSnapshot(), ...prefixAffinity.exportSnapshot()] }));

    flushPrefixAffinity();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: { sessionId: string }[] };
    const ids = parsed.entries.map((e) => e.sessionId);
    assert.ok(ids.includes(a.sessionId), "our own chain survives our own write");
    assert.ok(ids.includes(b.sessionId), "sibling chain preserved across our write (#1724)");
});

test("merge keeps the deeper disk copy when our in-memory snapshot is stale (#1724)", () => {
    const a = prefixAffinity.resolve(messages(6));
    assert.ok(a);
    prefixAffinity.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes);
    const mine = prefixAffinity.exportSnapshot()[0];
    assert.ok(mine);
    const deeper = { ...mine, depth: mine.depth + 2, lastSeen: mine.lastSeen + 1000 };
    const file = path.join(tmp, "billion-context", "prefix-affinity.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [deeper] }));

    flushPrefixAffinity();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: { depth: number }[] };
    assert.equal(parsed.entries[0].depth, mine.depth + 2, "fresher disk copy not rolled back by our stale write");
});

test("writeSnapshot re-applies the store's bounds to the union (LRU cap; chains are permanent) (#1724)", () => {
    const a = prefixAffinity.resolve(messages(7));
    assert.ok(a);
    prefixAffinity.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes);

    const now = Date.now();
    const pads: unknown[] = [];
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 50; i++) {
        pads.push({ sessionId: `pfa-pad-${i}`, depth: 3, tailHash: `t${i}`, itemHashes: ["h"], lastSeen: now - (i + 1) * 1000 });
    }
    pads.push({ sessionId: "pfa-oldest", depth: 3, tailHash: "ta", itemHashes: ["h"], lastSeen: now - 400 * 24 * 60 * 60 * 1000 });
    const file = path.join(tmp, "billion-context", "prefix-affinity.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: pads }));

    flushPrefixAffinity();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: { sessionId: string }[] };
    const ids = new Set(parsed.entries.map((e) => e.sessionId));
    assert.ok(ids.has(a.sessionId), "our own chain survives the capped write");
    assert.ok(!ids.has("pfa-oldest"), "when the cap bites, the least-recently-seen entry is the first to go");
    assert.ok(!ids.has(`pfa-pad-${MAX_TRACKED_SESSIONS + 49}`), "oldest disk-only chains are LRU-capped at write time");
    assert.equal(parsed.entries.length, MAX_TRACKED_SESSIONS, "file stays bounded at the tracked-chain cap instead of growing per churned chain");
});

test("chains are permanent at write time — age alone never prunes (#1724)", () => {
    const now = Date.now();
    const file = path.join(tmp, "billion-context", "prefix-affinity.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [
        { sessionId: "pfa-year-old", depth: 5, tailHash: "ty", itemHashes: ["h"], lastSeen: now - 400 * 24 * 60 * 60 * 1000 },
        { sessionId: "pfa-fresh", depth: 2, tailHash: "tf", itemHashes: ["h"], lastSeen: now },
    ] }));

    flushPrefixAffinity();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: { sessionId: string }[] };
    const ids = new Set(parsed.entries.map((e) => e.sessionId));
    assert.ok(ids.has("pfa-year-old"), "a 400-day-old chain survives the write — permanence means only the LRU cap, never age");
    assert.ok(ids.has("pfa-fresh"), "fresh entry untouched");
});

test("a malformed disk entry cannot win a same-depth merge or persist (#1724)", () => {
    const a = prefixAffinity.resolve(messages(6));
    assert.ok(a);
    prefixAffinity.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes);
    const file = path.join(tmp, "billion-context", "prefix-affinity.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ sessionId: a.sessionId, depth: a.incomingDepth, tailHash: "deadbeef" }] }));

    flushPrefixAffinity();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: { tailHash: string; itemHashes: string[] }[] };
    const ours = parsed.entries.find((e) => e.tailHash === a.tailHash);
    assert.ok(ours, "the corrupt same-depth copy is rejected, our valid chain is written back");
    assert.ok(Array.isArray(ours.itemHashes) && ours.itemHashes.every((h) => typeof h === "string"));
    assert.ok(!parsed.entries.some((e) => e.tailHash === "deadbeef"), "corrupt entry does not persist on disk");
});
