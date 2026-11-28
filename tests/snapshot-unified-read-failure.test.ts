import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-snapshot-read-"));
process.env.BILI_STORAGE_UNIFIED = "full";
// KDD #25 hermeticity: legacy read-failure fallback assertions — pin the plane OFF.
process.env.BILI_ROLLOUT_EGRESS_PLANE = "0";
process.env.BILI_SESSIONS_DIR = path.join(root, "sessions");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");

const { getStore, unifiedKvActive } = await import("../src/persist.js");
const affinity = await import("../src/affinity-persist.js");
const { prefixAffinity } = await import("../src/prefix-affinity.js");

// 2026-11-23: the second writer (session-order) retired with the
// trust-stamped-id GA — the skeleton map and its persistence module are gone,
// so this parameterized suite now runs against the surviving affinity writer.
const affinityEntry = (sessionId: string) => ({ sessionId, depth: 1, tailHash: "a".repeat(16), itemHashes: ["b".repeat(16)], lastSeen: Date.now() });
const writers = [
    {
        name: "prefix-affinity", hydrate: affinity.hydrateAffinityUnified, flush: affinity.flushPrefixAffinity,
        reset: affinity._resetAffinityPersistForTest, entry: affinityEntry,
        clear: () => { for (const id of prefixAffinity.trackedSessionIds()) prefixAffinity.forget(id); },
        add: (id: string) => { prefixAffinity.importSnapshot([affinityEntry(id)]); },
    },
];
const store = getStore();
await store.ready();
assert.equal(unifiedKvActive(), true, "exercise the real unified SQLite store");
const read = store.getKvAsync.bind(store);
const write = store.setKvAsync.bind(store);
const legacyFile = (name: string) => path.join(root, "state", "billion-context", `${name}.json`);

after(async () => {
    for (const writer of writers) { writer.reset(); writer.clear(); }
    await store.closeQuietlyAsync();
    fs.rmSync(root, { recursive: true, force: true });
});

for (const writer of writers) {
    async function reset() {
        writer.reset();
        writer.clear();
        await store.deleteKvAsync(writer.name, "v1");
        fs.rmSync(legacyFile(writer.name), { force: true });
    }

    test(`${writer.name}: failed hydration read preserves the durable peer snapshot`, async (t) => {
        await reset();
        const peer = { version: 1, entries: [writer.entry("durable-peer")] };
        const mine = { version: 1, entries: [writer.entry("legacy-local")] };
        await write(writer.name, "v1", peer);
        fs.mkdirSync(path.dirname(legacyFile(writer.name)), { recursive: true });
        fs.writeFileSync(legacyFile(writer.name), JSON.stringify(mine));
        let failedRead = false;
        let writes = 0;
        t.mock.method(store, "getKvAsync", async (namespace: string, key: string) => {
            if (namespace === writer.name && !failedRead) {
                failedRead = true;
                throw Object.assign(new Error("snapshot metadata read failed"), { code: "SQLITE_BUSY" });
            }
            return read(namespace, key);
        });
        t.mock.method(store, "setKvAsync", async (namespace: string, key: string, value: unknown) => {
            if (namespace === writer.name) writes++;
            return write(namespace, key, value);
        });
        try {
            await writer.hydrate();
            assert.equal(failedRead, true);
            assert.deepEqual(await read(writer.name, "v1"), peer, "failed reads cannot authorize replacing peer state");
            assert.equal(writes, 0, "do not treat an unavailable snapshot as an absent one");
            t.mock.restoreAll();
            await writer.hydrate();
            const recovered = await read(writer.name, "v1") as { entries: unknown[] };
            assert.deepEqual(recovered.entries, [...peer.entries, ...mine.entries], "retry imports both existing and legacy state");
        } finally {
            t.mock.restoreAll();
            writer.reset();
        }
    });

    test(`${writer.name}: failed flush read retains peer state and demotes later writes`, async (t) => {
        await reset();
        await write(writer.name, "v1", { version: 1, entries: [] });
        await writer.hydrate();
        writer.add("local-update");
        // A different process publishes after this process hydrated.
        const peer = { version: 1, entries: [writer.entry("new-peer")] };
        await write(writer.name, "v1", peer);
        let failedRead = false;
        t.mock.method(store, "getKvAsync", async (namespace: string, key: string) => {
            if (namespace === writer.name && !failedRead) {
                failedRead = true;
                throw Object.assign(new Error("snapshot metadata read failed"), { code: "SQLITE_BUSY" });
            }
            return read(namespace, key);
        });
        try {
            await writer.flush();
            assert.equal(failedRead, true);
            assert.deepEqual(await read(writer.name, "v1"), peer, "a failed merge read must leave the stored snapshot unchanged");
            t.mock.restoreAll();
            await writer.flush();
            assert.ok(fs.existsSync(legacyFile(writer.name)), "the next flush uses the documented legacy fallback");
            assert.deepEqual(await read(writer.name, "v1"), peer);
            const fallback = JSON.parse(fs.readFileSync(legacyFile(writer.name), "utf8")) as { entries: unknown[] };
            assert.equal(fallback.entries.length, 1, "the local update survives in the fallback carrier");
            await writer.hydrate();
            const recovered = await read(writer.name, "v1") as { entries: unknown[] };
            assert.equal(recovered.entries.length, 2, "successful retry reunites peer and local state");
        } finally {
            t.mock.restoreAll();
            writer.reset();
        }
    });

    test(`${writer.name}: an actually missing row still migrates legacy state`, async () => {
        await reset();
        const mine = { version: 1, entries: [writer.entry("initial-local")] };
        fs.mkdirSync(path.dirname(legacyFile(writer.name)), { recursive: true });
        fs.writeFileSync(legacyFile(writer.name), JSON.stringify(mine));
        await writer.hydrate();
        assert.deepEqual(await read(writer.name, "v1"), mine);
    });
}
