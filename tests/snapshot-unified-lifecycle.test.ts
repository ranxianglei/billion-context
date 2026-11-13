import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(tmpdir(), "bili-snapshot-lifecycle-"));
process.env.XDG_STATE_HOME = root;

const { _setStoreForTest, _resetStoreForTest } = await import("../src/persist.js");
const affinity = await import("../src/affinity-persist.js");
const order = await import("../src/order-persist.js");
type SessionStore = import("../src/persist.js").SessionStore;

const writers = [
    { name: "prefix-affinity", hydrate: affinity.hydrateAffinityUnified, flush: affinity.flushPrefixAffinity, schedule: affinity.scheduleAffinityPersist, reset: affinity._resetAffinityPersistForTest },
    { name: "session-order", hydrate: order.hydrateOrderUnified, flush: order.flushOrderSkeletons, schedule: order.scheduleOrderPersist, reset: order._resetOrderPersistForTest },
];

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}

function installStore(setKvAsync: () => Promise<void>): void {
    _setStoreForTest({
        liveStorageStamp: "unified",
        getKvAsync: async () => ({ version: 1, entries: [] }),
        setKvAsync,
        listKvAsync: async () => [],
        closeQuietly: () => {},
    } as unknown as SessionStore);
}

after(() => {
    for (const writer of writers) writer.reset();
    _resetStoreForTest();
    rmSync(root, { recursive: true, force: true });
});

for (const writer of writers) {
    test(`${writer.name}: flush waits for all queued durable writes`, async () => {
        writer.reset();
        const started = [deferred(), deferred()];
        const release = [deferred(), deferred()];
        let writes = 0;
        installStore(async () => {
            const i = writes++;
            started[i]!.resolve();
            await release[i]!.promise;
        });
        await writer.hydrate();
        let settled = false;
        const first = writer.flush();
        const second = writer.flush().then(() => { settled = true; });
        try {
            await started[0]!.promise;
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(settled, false, "shutdown must not proceed while the first store write is pending");
            assert.equal(writes, 1, "queued snapshots stay serialized");
            release[0]!.resolve();
            await started[1]!.promise;
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(settled, false, "flush includes its own queued write, not only the preceding one");
            release[1]!.resolve();
            await Promise.all([first, second]);
            assert.equal(settled, true);
        } finally {
            for (const gate of release) gate.resolve();
            await Promise.all([first, second]);
            await new Promise<void>((resolve) => setImmediate(resolve));
            writer.reset();
        }
    });

    test(`${writer.name}: a completed write starts a fresh debounce budget`, async (t) => {
        writer.reset();
        const oldDebounce = process.env.BILI_PERSIST_DEBOUNCE_MS;
        const oldMaxDelay = process.env.BILI_PERSIST_MAX_DELAY_MS;
        process.env.BILI_PERSIST_DEBOUNCE_MS = "100";
        process.env.BILI_PERSIST_MAX_DELAY_MS = "300";
        let writes = 0;
        installStore(async () => { writes++; });
        await writer.hydrate();
        t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
        try {
            writer.schedule();
            t.mock.timers.tick(100);
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(writes, 1);
            t.mock.timers.tick(1_000);
            writer.schedule();
            t.mock.timers.tick(1);
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(writes, 1, "the first batch's expired max-delay must not force an immediate second write");
            t.mock.timers.tick(99);
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(writes, 2, "the next batch still writes after its normal debounce");
        } finally {
            writer.reset();
            t.mock.timers.reset();
            if (oldDebounce === undefined) delete process.env.BILI_PERSIST_DEBOUNCE_MS;
            else process.env.BILI_PERSIST_DEBOUNCE_MS = oldDebounce;
            if (oldMaxDelay === undefined) delete process.env.BILI_PERSIST_MAX_DELAY_MS;
            else process.env.BILI_PERSIST_MAX_DELAY_MS = oldMaxDelay;
        }
    });
}
