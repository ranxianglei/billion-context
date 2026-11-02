import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, createSession, getSession, getSessionAsync, hasRefLedgerConflict, memoryReport, peekSession, publishForkSession, type Session } from "../src/session.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

async function fixture(t: TestContext, full = false): Promise<SessionStore> {
    const previousEnv = Object.fromEntries(["BILI_STORAGE_UNIFIED", "BILI_STORAGE_JSON_WRITER", "BILI_PERSIST_ZSTD"].map((key) => [key, process.env[key]]));
    if (full) Object.assign(process.env, { BILI_STORAGE_UNIFIED: "full", BILI_STORAGE_JSON_WRITER: "on", BILI_PERSIST_ZSTD: "0" });
    const dir = mkdtempSync(join(tmpdir(), "bili-fork-publication-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 60000 });
    _resetSessionsForTest();
    _setStoreForTest(store);
    t.after(async () => {
        store.cancelAll();
        await store.closeQuietlyAsync();
        _resetSessionsForTest();
        rmSync(dir, { recursive: true, force: true });
        if (full) for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    await store.ready();
    if (full) assert.ok(existsSync(join(dir, "index.db")), "full mode must use a real SQLite database");
    for (const id of ["parent-a", "parent-b"]) assert.equal(store.flushSync(createSession(id)), true);
    return store;
}

test("fork publication reserves a child before its existence probe settles", async (t) => {
    const store = await fixture(t);
    const probe = deferred<Session | null>();
    const load = store.loadAsync.bind(store);
    const persist = store.persistForkSession.bind(store);
    const writes: string[] = [];
    let probes = 0;
    store.loadAsync = async (id, meta) => ++probes === 1 ? probe.promise : load(id, meta);
    store.persistForkSession = async (parentId, session) => {
        await persist(parentId, session);
        writes.push(parentId);
    };
    const winner = createSession("child", { label: "first publisher" });
    const loser = createSession("child", { label: "second publisher" });
    const first = publishForkSession(winner, "parent-a");
    const [second] = await Promise.allSettled([publishForkSession(loser, "parent-b")]);
    const [reader] = await Promise.allSettled([getSessionAsync("child")]);
    let syncReadError: unknown;
    try { getSession("child"); } catch (error) { syncReadError = error; }
    probe.resolve(null);
    const [published] = await Promise.allSettled([first]);
    t.diagnostic(JSON.stringify({ probes, writes, first: published.status, second: second.status, durableLabel: store.loadSync("child")?.meta.label }));

    assert.equal(second.status, "rejected", `different-parent contender must be refused; writes=${writes.join(",")}`);
    if (second.status === "rejected") assert.match(String(second.reason), /child fork publication in progress/);
    assert.equal(published.status, "fulfilled");
    assert.equal(reader.status, "rejected", "new async readers must be refused during the existence probe");
    if (reader.status === "rejected") assert.match(String(reader.reason), /child fork publication in progress/);
    assert.match(String(syncReadError), /child fork publication in progress/);
    assert.equal(probes, 1, "the losing publisher must not even enter the existence probe");
    assert.deepEqual(writes, ["parent-a"]);
    assert.equal(peekSession("child"), winner);
    assert.equal(store.loadSync("child")?.meta.label, "first publisher");
});

test("an in-flight load cannot adopt a child during fork persistence", async (t) => {
    const store = await fixture(t);
    const loaded = deferred<Session | null>();
    const persisting = deferred<void>();
    const release = deferred<void>();
    const load = store.loadAsync.bind(store);
    const persist = store.persistForkSession.bind(store);
    let probes = 0;
    store.loadAsync = async (id, meta) => ++probes === 1 ? loaded.promise : load(id, meta);
    store.persistForkSession = async (parentId, session) => {
        persisting.resolve();
        await release.promise;
        await persist(parentId, session);
    };
    const reading = Promise.allSettled([getSessionAsync("child")]);
    const child = createSession("child", { label: "published child" });
    const publishing = publishForkSession(child, "parent-a");
    await persisting.promise;
    loaded.resolve(null);
    const [read] = await reading;
    const midPublication = peekSession("child");
    release.resolve();
    await publishing;

    t.diagnostic(JSON.stringify({ read: read.status, residentDuringPublication: midPublication?.id ?? null }));
    assert.equal(read.status, "rejected", "a load started before publication must recheck exclusion after its await");
    if (read.status === "rejected") assert.match(String(read.reason), /child fork publication in progress/);
    assert.equal(midPublication, undefined, "no ghost may become resident while the fork is publishing");
    assert.equal(await getSessionAsync("child"), child);
});

for (const result of ["missing", "stale"] as const) {
    test(`an in-flight ${result} load returns the completed fork winner`, async (t) => {
        const store = await fixture(t);
        const loaded = deferred<Session | null>();
        const load = store.loadAsync.bind(store);
        let probes = 0;
        store.loadAsync = async (id, meta) => ++probes === 1 ? loaded.promise : load(id, meta);
        const reading = getSessionAsync("child");
        const child = createSession("child", { label: "published child" });
        child.metadata.refLedgerConflict = true;
        await publishForkSession(child, "parent-a");
        loaded.resolve(result === "missing" ? null : createSession("child", { label: "stale load" }));

        const winner = await reading;
        assert.equal(winner, child, "a completed publication must win over the earlier load result");
        assert.equal(hasRefLedgerConflict(winner), true, "a stale load must not clear the published quarantine");
        assert.equal(peekSession("child"), child);
        const durable = store.loadSync("child");
        assert.equal(durable?.meta.label, "published child");
        assert.ok(durable && hasRefLedgerConflict(durable));
    });
}

test("missing-child loads remain single-flight without publication", async (t) => {
    const store = await fixture(t);
    const loaded = deferred<Session | null>();
    let probes = 0;
    store.loadAsync = async () => { probes++; return loaded.promise; };
    const first = getSessionAsync("missing");
    const second = getSessionAsync("missing");
    loaded.resolve(null);
    const [a, b] = await Promise.all([first, second]);

    assert.equal(probes, 1);
    assert.equal(a, b);
    assert.equal(getSession("missing"), a);
});

test("serialized publication refuses resident and durable children without leaving exclusion set", async (t) => {
    const store = await fixture(t);
    const child = createSession("child", { label: "published child" });
    await publishForkSession(child, "parent-a");
    await assert.rejects(publishForkSession(createSession("child"), "parent-b"), /child session already exists/);
    assert.equal(getSession("child"), child);
    _resetSessionsForTest();
    await assert.rejects(publishForkSession(createSession("child"), "parent-b"), /child session already exists/);

    const loaded = await getSessionAsync("child");
    assert.equal(loaded.meta.label, "published child");
    assert.equal(getSession("child"), loaded);
    assert.equal(store.loadSync("child")?.meta.label, "published child");
});

for (const failure of ["probe", "persist"] as const) {
    test(`fork ${failure} failure releases child exclusion for a clean retry`, async (t) => {
        const store = await fixture(t);
        const load = store.loadAsync.bind(store);
        const persist = store.persistForkSession.bind(store);
        if (failure === "probe") store.loadAsync = async () => { throw new Error("synthetic probe failure"); };
        else store.persistForkSession = async () => { throw new Error("synthetic persist failure"); };
        const child = createSession("child");
        await assert.rejects(publishForkSession(child, "parent-a"), new RegExp(`synthetic ${failure} failure`));
        assert.equal(peekSession("child"), undefined);
        store.loadAsync = load;
        store.persistForkSession = persist;

        await publishForkSession(child, "parent-a");
        assert.equal(await getSessionAsync("child"), child);
        assert.equal(store.loadSync("child")?.id, "child");
    });
}

async function inheritedFixture(t: TestContext) {
    const store = await fixture(t, true);
    const parent = createSession("parent-a");
    parent.metadata.refLedgerConflict = true;
    parent.state.messageRefs = { byRaw: { "issued-raw": "m00090" }, byRef: { m00090: "issued-raw" } };
    parent.state.deadRefs = ["m00080"];
    parent.lastMessages = [{ id: "issued-raw", role: "user", contentType: "text", text: "Synthetic inherited ref fixture." }];
    assert.equal(store.flushSync(parent), true);
    const child = createSession("child", { label: "inherited quarantined fork" });
    child.metadata.refLedgerConflict = true;
    child.state = structuredClone(parent.state);
    child.lastMessages = structuredClone(parent.lastMessages);
    return { store, child };
}

function assertInherited(session: Session | null | undefined) {
    assert.ok(session);
    assert.equal(hasRefLedgerConflict(session), true);
    assert.equal(session.state.messageRefs.byRaw["issued-raw"], "m00090");
    assert.ok(session.state.deadRefs?.includes("m00080"));
}

function holdEarlierRead(store: SessionStore, result: "missing" | "stale") {
    const started = deferred<void>();
    const release = deferred<void>();
    const load = store.loadAsync.bind(store);
    let held = false;
    store.loadAsync = async (id, meta) => {
        const hold = id === "child" && !held;
        if (hold) held = true;
        const snapshot = await load(id, meta);
        if (!hold) return snapshot;
        assert.equal(snapshot, null, "the first read must actually miss before publication");
        started.resolve();
        await release.promise;
        return result === "missing" ? snapshot : createSession(id, { label: "earlier snapshot" });
    };
    const reading = Promise.allSettled([getSessionAsync("child")]);
    return { started, release, reading, load };
}

function failEnvelope(t: TestContext, store: SessionStore) {
    const disk = (store as unknown as { store: { flushSync(id: string, build: () => unknown): boolean } }).store;
    const flush = disk.flushSync.bind(disk);
    return t.mock.method(disk, "flushSync", (id: string, build: () => unknown) => id === "child" ? false : flush(id, build));
}

for (const result of ["missing", "stale"] as const) {
    test(`an earlier ${result} load cannot replace a fork after ordinary LRU eviction`, async (t) => {
        const { store, child } = await inheritedFixture(t);
        const pool = memoryReport().pool;
        _resetSessionsForTest(1, pool.budgetBytes);
        const held = holdEarlierRead(store, result);
        try {
            await held.started.promise;
            await publishForkSession(child, "parent-a");
            assert.equal(peekSession("child"), child);
            getSession("eviction-pressure");
            assert.equal(peekSession("child"), undefined, "real one-slot LRU must evict the completed child");
            assertInherited(await held.load("child"));
            held.release.resolve();
            const [read] = await held.reading;
            const durable = await held.load("child");
            assertInherited(durable);
            t.diagnostic(JSON.stringify({ schedule: "publish-evict-release", result, reader: read.status, returnedRefs: read.status === "fulfilled" ? read.value.state.messageRefs : null, returnedQuarantine: read.status === "fulfilled" ? hasRefLedgerConflict(read.value) : null, durableRefs: durable?.state.messageRefs, durableQuarantine: durable && hasRefLedgerConflict(durable) }));
            assert.equal(read.status, "rejected", "the old claim must not adopt after the resident winner is evicted");
            if (read.status === "rejected") assert.match(String(read.reason), /session load superseded/);
            assert.equal(peekSession("child"), undefined);
            assertInherited(await getSessionAsync("child"));
        } finally {
            held.release.resolve();
            await held.reading;
            _resetSessionsForTest(pool.maxSessions, pool.budgetBytes);
        }
    });

    test(`an earlier ${result} load cannot replace a committed fork after envelope failure`, async (t) => {
        const { store, child } = await inheritedFixture(t);
        const held = holdEarlierRead(store, result);
        try {
            await held.started.promise;
            const fault = failEnvelope(t, store);
            try {
                await assert.rejects(publishForkSession(child, "parent-a"), /fork envelope persistence failed; retry the same request/);
            } finally { fault.mock.restore(); }
            assert.equal(peekSession("child"), undefined);
            assert.equal((await store.findSessionFiles("child")).length, 0);
            assertInherited(await held.load("child"));
            held.release.resolve();
            const [read] = await held.reading;
            const durable = await held.load("child");
            assertInherited(durable);
            t.diagnostic(JSON.stringify({ schedule: "committed-envelope-error-release", result, reader: read.status, returnedRefs: read.status === "fulfilled" ? read.value.state.messageRefs : null, returnedQuarantine: read.status === "fulfilled" ? hasRefLedgerConflict(read.value) : null, durableRefs: durable?.state.messageRefs, durableQuarantine: durable && hasRefLedgerConflict(durable) }));
            assert.equal(read.status, "rejected", "a committed-then-error publication must invalidate the earlier claim too");
            if (read.status === "rejected") assert.match(String(read.reason), /session load superseded/);
            assert.equal(peekSession("child"), undefined);
            assertInherited(await getSessionAsync("child"));
        } finally {
            held.release.resolve();
            await held.reading;
        }
    });
}

test("a fresh reader recovers the actual committed fork after envelope failure", async (t) => {
    const { store, child } = await inheritedFixture(t);
    const fault = failEnvelope(t, store);
    try {
        await assert.rejects(publishForkSession(child, "parent-a"), /fork envelope persistence failed; retry the same request/);
    } finally { fault.mock.restore(); }
    assert.equal(peekSession("child"), undefined);
    assert.equal((await store.findSessionFiles("child")).length, 0);
    assertInherited(await store.loadAsync("child"));
    assertInherited(await getSessionAsync("child"));
});

test("a failed load releases its own claim for an ordinary missing-child retry", async (t) => {
    const store = await fixture(t);
    const load = store.loadAsync.bind(store);
    let probes = 0;
    store.loadAsync = async (id, meta) => {
        if (++probes === 1) throw new Error("synthetic read failure");
        return load(id, meta);
    };
    await assert.rejects(getSessionAsync("missing"), /synthetic read failure/);
    const missing = await getSessionAsync("missing");
    assert.equal(probes, 2);
    assert.equal(await getSessionAsync("missing"), missing);
});


test("an invalidated load's finally cannot clear a newer reader's single-flight claim", async (t) => {
    const { store, child } = await inheritedFixture(t);
    const pool = memoryReport().pool;
    _resetSessionsForTest(1, pool.budgetBytes);
    const load = store.loadAsync.bind(store);
    const started = deferred<void>();
    const releaseOld = deferred<void>();
    const releaseNew = deferred<void>();
    let reads = 0;
    store.loadAsync = async (id, meta) => {
        const probe = id === "child" ? ++reads : 0;
        const snapshot = await load(id, meta);
        if (probe === 1) {
            assert.equal(snapshot, null);
            started.resolve();
            await releaseOld.promise;
        } else if (probe > 2) await releaseNew.promise;
        return snapshot;
    };
    const older = Promise.allSettled([getSessionAsync("child")]);
    const settling = [older];
    try {
        await started.promise;
        await publishForkSession(child, "parent-a");
        getSession("eviction-pressure");
        assert.equal(peekSession("child"), undefined);
        const newer = Promise.allSettled([getSessionAsync("child")]);
        settling.push(newer);
        releaseOld.resolve();
        const [old] = await older;
        const joining = Promise.allSettled([getSessionAsync("child")]);
        settling.push(joining);
        const issuedReads = reads;
        releaseNew.resolve();
        const [[next], [joined]] = await Promise.all([newer, joining]);
        assertInherited(await load("child"));
        t.diagnostic(JSON.stringify({ schedule: "old-finally-new-claim", issuedReads, old: old.status, newer: next.status, joining: joined.status }));
        assert.equal(issuedReads, 3, "two newer readers must share one fresh load after the old claim settles");
        assert.equal(old.status, "rejected");
        assert.ok(next.status === "fulfilled" && joined.status === "fulfilled");
        assert.equal(next.value, joined.value);
        assertInherited(next.value);
    } finally {
        releaseOld.resolve();
        releaseNew.resolve();
        await Promise.all(settling);
        _resetSessionsForTest(pool.maxSessions, pool.budgetBytes);
    }
});
