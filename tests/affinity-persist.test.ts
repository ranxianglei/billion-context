import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrefixAffinityResolver, prefixAffinity } from "../src/prefix-affinity.ts";
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

test("importSnapshot drops malformed and expired entries", () => {
    const r = new PrefixAffinityResolver();
    assert.equal(r.importSnapshot("nope"), 0);
    assert.equal(r.importSnapshot([{ sessionId: 1 }, { sessionId: "x", depth: "3" }, null, { sessionId: "ok", depth: 3, tailHash: "t", itemHashes: ["h1", "h2"], lastSeen: Date.now() - 8 * 24 * 60 * 60 * 1000 }]), 0, "malformed + expired are skipped");
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
