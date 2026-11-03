import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #4316 layer 3 PR3/3 stakes — RED first.
 *
 * S12: protocol-fork children clone the parent's unified-store rows wholesale
 *      (same seq values) so the child's kernel refs (cloned from the parent by
 *      the fork endpoint) keep pointing at the same ledger positions; the
 *      child appends from the parent's max seq + 1.
 * S14: a compress call citing a ref superseded by the one-time ledger re-stamp
 *      is refused with renumber guidance instead of folding the wrong range.
 * S15: cold load leaves issued refs untouched (no re-stamp) and a second
 *      load sees the exact same refs and no superseded map.
 */
process.env.NODE_ENV = "test";
process.env.BILI_STORAGE_UNIFIED = "full";
const testRoot = mkdtempSync(join(tmpdir(), "bili-pr3-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage } from "acp-kernel";
import { applyRanges, supersededRefRejection } from "../src/stream.ts";
import type { Session } from "../src/session.ts";

function msg(id: string, role: "user" | "assistant" = "user", text = `content for ${id} ${"x".repeat(120)}`): CoreMessage {
    return { id, role, contentType: "text", text };
}

function legacyLike(id: string, messages: CoreMessage[]): LegacySessionLike {
    return {
        id,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        meta: {},
        stats: {},
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages: messages,
    } as unknown as LegacySessionLike;
}

function store(): UnifiedStore {
    const dir = join(testRoot, `db-${Math.random().toString(36).slice(2)}`);
    const s = UnifiedStore.open(join(dir, "index.db"), undefined as never) as unknown as UnifiedStore;
    return s;
}

test("S12a: cloneSessionRows copies parent rows with identical seqs, lineage columns, and idempotent replay", async () => {
    const st = store();
    const parent = legacyLike(
        "pr3-parent",
        [msg("a"), msg("b"), msg("c"), msg("d"), msg("e"), msg("f")],
    );
    const plan = planIngest(parent);
    st.ingestSession(plan);

    // Clone the whole prefix (branch at the end, seq 5).
    st.cloneSessionRows("pr3-parent", "pr3-child", 5);

    const childRows = st.getMessages("pr3-child");
    assert.equal(childRows.length, 6, "child rows cloned");
    const parentRows = st.getMessages("pr3-parent");
    for (let i = 0; i < 6; i++) {
        assert.equal(childRows[i]!.seq, parentRows[i]!.seq, `seq preserved at ${i}`);
        assert.equal(childRows[i]!.msgId, parentRows[i]!.msgId, `msg_id preserved at ${i}`);
        assert.equal(childRows[i]!.identity, parentRows[i]!.identity, `identity preserved at ${i}`);
    }

    // Lineage columns on the child session row.
    const sess = st.getSessionRow("pr3-child");
    assert.equal(sess?.parentSessionId, "pr3-parent");
    assert.equal(sess?.forkPointSeq, 5);

    // Idempotent replay: cloning again must not duplicate.
    st.cloneSessionRows("pr3-parent", "pr3-child", 5);
    assert.equal(st.getMessages("pr3-child").length, 6);

    // The child's own first append continues from the parent's max seq + 1.
    // Rebuild the child's resent view from the CLONED rows' real bytes (the
    // client resends what it holds — same content, same ids), then append g.
    const cloned = st.getMessages("pr3-child").map((r) => JSON.parse(r.content) as CoreMessage);
    const childSession = legacyLike("pr3-child", [...cloned, msg("g")]);
    const childPlan = planIngest(childSession);
    st.ingestSession(childPlan);
    const after = st.getMessages("pr3-child");
    assert.equal(after.length, 7);
    assert.equal(after[6]!.seq, 6, "child append lands at parent max seq + 1");
    assert.equal(after[6]!.msgId, "g");
    st.close(); // release the handle before test.after's rmSync — Windows cannot unlink an open index.db
});

test("S12b: partial branch (throughSeq) clones only the prefix", async () => {
    const st = store();
    const parent = legacyLike("pr3-parent-2", [msg("a"), msg("b"), msg("c"), msg("d")]);
    st.ingestSession(planIngest(parent));
    st.cloneSessionRows("pr3-parent-2", "pr3-child-2", 2);
    const rows = st.getMessages("pr3-child-2");
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.msgId), ["a", "b", "c"]);
    st.close(); // release the handle before test.after's rmSync — Windows cannot unlink an open index.db
});

test("S14: superseded-ref compress resolution — old refs translate (or refuse on dead-end), current refs pass untouched", () => {
    const session = {
        restampSuperseded: new Map([
            ["m00003", "d"],
            ["m00004", "e"],
            ["m00009", "ghost"],
        ]),
        state: { messageRefs: { byRef: { m00004: "x", m00005: "d" }, byRaw: { d: "m00005" } } },
    } as unknown as Session;
    // m00003 is vacated (not live) and translatable onto its raw id; the guard
    // resolves it, never rejects it (#4797: refusal of status-advertised refs
    // dead-looped the session). The resolution carries translated endpoints.
    const hit = supersededRefRejection(
        [{ startRef: "m00003", endRef: "m00003", summary: "s" }],
        session,
    );
    assert.equal(hit.rejection, null);
    assert.equal(hit.translated, 2, "endpoint-granular: start+end both translate");
    // A dead-end key (raw id lost its mapping) still refuses with guidance.
    const dead = supersededRefRejection(
        [{ startRef: "m00009", endRef: "m00009", summary: "s" }],
        session,
    );
    assert.ok(dead.rejection !== null);
    assert.match(dead.rejection, /acp_status/);
    // Live refs pass untouched even with a map present — live-first priority
    // is what breaks the #4797 collision loop (a superseded key can be the
    // live ref of a different message after the one-time alignment).
    const live = supersededRefRejection(
        [{ startRef: "m00004", endRef: "m00010", summary: "s" }],
        session,
    );
    assert.equal(live.rejection, null);
    assert.equal(live.translated, 0);
    // No map on the session → no rejection (fresh sessions).
    assert.equal(supersededRefRejection([{ startRef: "m00003", endRef: "m00004" }], {} as Session).rejection, null);
});

test("S15: cold load seals legacy counter refs without re-stamping them", async () => {
    // A persisted session whose kernel refs came from the counter path (a
    // BLOCKED protected message skipped a number, so refs drift ahead of
    // seq+1). Cold load must preserve every issued number exactly as stored:
    // no re-stamp, no superseded map, and a SECOND cold load must see the
    // same refs.
    const dir = join(testRoot, `s15-${Math.random().toString(36).slice(2)}`);
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        // Rows land via a unified full-mode save; kernel state carries the
        // pre-alignment refs (BLOCKED skip: d=m3, e=m4 while rows are 0..4).
        const messages = [msg("a"), msg("b"), msg("c"), msg("d"), msg("e")];
        const legacy = legacyLike("pr3-restamp", messages);
        legacy.state.messageRefs = {
            byRaw: { a: "m00001", b: "m00002", c: "BLOCKED", d: "m00003", e: "m00004" },
            byRef: { m00001: "a", m00002: "b", m00003: "d", m00004: "e" },
        };
        legacy.state.blocks = [];
        const first = store.loadSync("pr3-restamp");
        assert.ok(first === undefined || first === null, "fresh id: nothing to load yet");
        // Seed the store through the same save path production uses.
        const seedSession = {
            id: "pr3-restamp",
            createdAt: Date.now(),
            lastSeen: Date.now(),
            meta: { protocol: "anthropic" },
            stats: {},
            metadata: {},
            state: legacy.state,
            blockContents: new Map(),
            lastMessages: messages,
        } as never;
        store.scheduleSave(seedSession as never);
        assert.ok(store.flushSync(seedSession as never), "seed save committed");

        // Cold load: a fresh store instance over the same dir.
        store.closeQuietly();
        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        _setStoreForTest(store2);
        const reloaded = store2.loadSync("pr3-restamp");
        assert.ok(reloaded, "session loads");
        // Cold load must not rewrite the issued numbers.
        const refs = reloaded.state.messageRefs;
        assert.equal(refs.byRaw.a, "m00001");
        assert.equal(refs.byRaw.b, "m00002");
        assert.equal(refs.byRaw.c, "BLOCKED", "protected keeps taking no number");
        assert.equal(refs.byRaw.d, "m00003", "d keeps its issued counter ref");
        assert.equal(refs.byRaw.e, "m00004", "e keeps its issued counter ref");
        assert.equal(refs.byRef.m00003, "d");
        assert.equal(refs.byRef.m00004, "e");
        assert.equal((reloaded.state as { refLedgerAligned?: boolean }).refLedgerAligned, undefined);
        assert.equal(reloaded.restampSuperseded, undefined);
        assert.ok(store2.flushSync(reloaded), "sealed state committed");

        // Second cold load: identical refs, still no re-stamp.
        store2.closeQuietly();
        const store3 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        _setStoreForTest(store3);
        const again = store3.loadSync("pr3-restamp");
        assert.ok(again);
        assert.equal(again.state.messageRefs.byRaw.d, "m00003", "refs stable across reloads");
        assert.equal(again.state.messageRefs.byRaw.e, "m00004");
        assert.equal(again.state.messageRefs.byRef.m00003, "d");
        assert.equal(again.state.messageRefs.byRef.m00004, "e");
        assert.equal(again.restampSuperseded, undefined);
        store3.closeQuietly();
    } finally {
        // restore the singleton-less state for later tests
        _setStoreForTest({} as never);
    }
    rmSync(dir, { recursive: true, force: true });
});

test("S16: retained old-vs-current ref collision fails closed without changing bytes", async () => {
    const dir = join(testRoot, `s16-${Math.random().toString(36).slice(2)}`);
    const dbPath = join(dir, "index.db");
    // First ingest issues m00001/m00002 to a/b. A second ingest keeps those
    // first-seen message-row refs (INSERT OR IGNORE) while the refs table
    // moves m00001 to c — the exact residue a retired cold-load re-stamp
    // leaves behind.
    const st = UnifiedStore.open(dbPath, undefined as never) as unknown as UnifiedStore;
    const first = legacyLike("pr3-collision", [msg("a"), msg("b")]);
    first.state.messageRefs = { byRaw: { a: "m00001", b: "m00002" }, byRef: { m00001: "a", m00002: "b" } };
    assert.equal(st.ingestSession(planIngest(first)), true);
    const second = legacyLike("pr3-collision", [msg("a"), msg("b"), msg("c")]);
    second.state.messageRefs = {
        byRaw: { a: "m00002", b: "m00003", c: "m00001" },
        byRef: { m00001: "c", m00002: "a", m00003: "b" },
    };
    assert.equal(st.ingestSession(planIngest(second)), true);
    const refsBefore = st.getRefs("pr3-collision");
    const rowsBefore = st.getMessages("pr3-collision", { includeRetired: true });
    const blocksBefore = st.getBlocks("pr3-collision");
    const countsBefore = st.counts();
    assert.ok(st.findRefHistoryCollisions("pr3-collision").length > 0, "fixture must leave a detectable collision");
    st.close();

    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        const session = store.loadSync("pr3-collision");
        assert.ok(session, "collision fixture must still load");
        assert.ok(session.refLedgerConflict && session.refLedgerConflict.length > 0, "cold load must flag the collision");
        const refused = applyRanges(
            { ranges: [{ startRef: "m00001", endRef: "m00001", summary: "fold" }], diagnostics: { kind: "ok", invalidItems: 0 } } as never,
            { session, log: () => {} } as never,
            { loopTracking: false },
        );
        assert.equal(refused.outcome, "refused");
        assert.equal(refused.reason, "ref-ledger-conflict");
        assert.match(refused.text, /ambiguous/);
        assert.match(refused.text, /Raw messages, blocks, and the ref ledger are preserved/);
        assert.equal(refused.blocksCreated, 0);
        store.closeQuietly();

        const after = UnifiedStore.open(dbPath, undefined as never) as unknown as UnifiedStore;
        try {
            assert.deepEqual(after.getRefs("pr3-collision"), refsBefore, "refs ledger unchanged");
            assert.deepEqual(after.getMessages("pr3-collision", { includeRetired: true }), rowsBefore, "raw rows unchanged");
            assert.deepEqual(after.getBlocks("pr3-collision"), blocksBefore, "blocks unchanged");
            assert.deepEqual(after.counts(), countsBefore, "no rows added or removed");
        } finally {
            after.close();
        }

        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        _setStoreForTest(store2);
        const again = store2.loadSync("pr3-collision");
        assert.ok(again);
        assert.deepEqual(again.refLedgerConflict, session.refLedgerConflict, "detection is stable across cold loads");
        store2.closeQuietly();
    } finally {
        _setStoreForTest({} as never);
    }
});


test("S17: warm startup retains known ref-history collision refusal", async () => {
    const dir = join(testRoot, `s17-${Math.random().toString(36).slice(2)}`);
    const id = "pr3-warm-collision";
    const st = UnifiedStore.open(join(dir, "index.db"), undefined as never) as unknown as UnifiedStore;
    const first = legacyLike(id, [msg("a"), msg("b")]);
    first.state.messageRefs = { byRaw: { a: "m00001", b: "m00002" }, byRef: { m00001: "a", m00002: "b" } };
    assert.equal(st.ingestSession(planIngest(first)), true);
    const second = legacyLike(id, [msg("a"), msg("b"), msg("c")]);
    second.state.messageRefs = {
        byRaw: { a: "m00002", b: "m00003", c: "m00001" },
        byRef: { m00001: "c", m00002: "a", m00003: "b" },
    };
    assert.equal(st.ingestSession(planIngest(second)), true);
    st.close();
    const { SessionStore } = await import("../src/persist.ts");
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    try {
        const cold = store.loadSync(id);
        assert.ok(cold?.refLedgerConflict?.length, "cold fixture must detect retained conflict");
        assert.equal(store.flushSync(cold), true, "write the normal legacy startup envelope");
        for (const method of ["loadAll", "boot"] as const) {
            const warm = (await store[method]()).get(id);
            assert.ok(warm?.refLedgerConflict?.length, `${method} must retain the same conflict`);
            const before = structuredClone(warm.state);
            const refused = applyRanges(
                { ranges: [{ startRef: "m00001", endRef: "m00001", summary: "fold" }], diagnostics: { kind: "ok", invalidItems: 0 } } as never,
                { session: warm, log: () => {} } as never,
                { loopTracking: false },
            );
            assert.equal(refused.outcome, "refused");
            assert.equal(refused.reason, "ref-ledger-conflict");
            assert.deepEqual(warm.state, before, "refusal must not mutate loaded state");
        }
        const child: Session = { ...cold, id: `${id}-child`, state: structuredClone(cold.state), refLedgerConflict: undefined };
        await store.persistForkSession(id, child);
        assert.ok(child.refLedgerConflict?.length, "an in-memory fork must detect the cloned ref history");
    } finally {
        store.closeQuietly();
    }
    const mode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "shadow";
    const legacyStore = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    try {
        const legacy = legacyStore.loadSync(id);
        assert.ok(legacy?.refLedgerConflict?.length, "legacy fallback must retain a detectable collision");
    } finally {
        legacyStore.closeQuietly();
        if (mode === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = mode;
    }
});

for (const mode of ["legacy", "full"] as const) {
    test(`S18: ambiguous resume inheritance survives ${mode} restart and another adoption`, async () => {
        const { createCore, defaultConfig, DEFAULT_ABSORB_CONFIG } = await import("acp-kernel");
        const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
        const { createSession } = await import("../src/session.ts");
        const { incomingCoreMessages, maybeAdoptResume } = await import("../src/fork-adoption.ts");
        const { executeProxyToolAsync } = await import("../src/loop/core.ts");
        const { executeAbsorb } = await import("../src/absorb.ts");
        const dir = mkdtempSync(join(testRoot, `resume-${mode}-`));
        const previousMode = process.env.BILI_STORAGE_UNIFIED;
        const previousWriter = process.env.BILI_STORAGE_JSON_WRITER;
        process.env.BILI_STORAGE_UNIFIED = "full";
        process.env.BILI_STORAGE_JSON_WRITER = "on";
        _setStoreForTest(new SessionStore({ enabled: false }));
        const parsed = { model: "synthetic", messages: [
            { role: "user", content: "Original request. " + "Retained source context. ".repeat(200) },
            { role: "assistant", content: "First reply. " + "Retained first answer. ".repeat(200) },
            { role: "assistant", content: "Second reply. " + "Retained second answer. ".repeat(200) },
            { role: "user", content: "Keep the original references." },
        ] };
        const messages = incomingCoreMessages("openai", parsed)!;
        const [a, b, c, d] = messages.map((m) => m.id);
        const fixture = legacyLike(`parent-${mode}`, messages);
        fixture.meta = { protocol: "openai" };
        fixture.state.messageRefs = { byRaw: { [a]: "m00001", [b]: "m00002", [c]: "m00003", [d]: "m00004" }, byRef: { m00001: a, m00002: b, m00003: c, m00004: d } };
        const db = UnifiedStore.open(join(dir, "index.db"));
        assert.equal(db.ingestSession(planIngest(fixture)), true);
        fixture.state.messageRefs = { byRaw: { [a]: "m00002", [b]: "m00003", [c]: "m00001", [d]: "m00004" }, byRef: { m00001: c, m00002: a, m00003: b, m00004: d } };
        assert.equal(db.ingestSession(planIngest(fixture)), true);
        const parentRows = db.getMessages(fixture.id, { includeRetired: true });
        db.close();
        let store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        try {
            const parent = store.loadSync(fixture.id)!;
            assert.ok(parent.refLedgerConflict?.length, "fixture hydration must find real retained ambiguity");
            const core = createCore();
            const config = defaultConfig(400_000);
            config.preserveRecentMessages = 0;
            config.preserveRecentTokens = 0;
            config.compress.minCompressRange = 100;
            const child = createSession(`child-${mode}`, { protocol: "openai" });
            const resumed = { ...parsed, messages: [...parsed.messages, { role: "user", content: "Resume with the old m00001 citation." }] };
            const childMessages = incomingCoreMessages("openai", resumed)!;
            const adopt = (target: Session, source: Session) => maybeAdoptResume({
                session: target, parent: source, sharedDepth: messages.length, protocol: "openai", parsed: resumed,
                upstreamOrigin: "https://synthetic.invalid", blocksEnabled: true, log: () => {},
            });
            assert.equal(adopt(child, parent).seededRefs, 4);
            child.state = core.processTurn({ messages: childMessages, state: child.state, config, tokenCount: 30000, renderTags: "text-only" }).state;
            child.lastMessages = childMessages;
            const refuse = async (session: Session) => {
                const before = JSON.stringify({ state: session.state, stats: session.stats, metadata: session.metadata, revision: session.revisionEpoch });
                const result = await executeProxyToolAsync("compress", { content: [{ startId: "m00001", endId: "m00001", summary: "Retain the original source context and exact reference ownership without changing any source message or stored block." }] }, {
                    core, config, session, messages: childMessages, log: () => {},
                });
                assert.equal(result.outcome, "refused", "known inherited ambiguity must refuse, never fold the current wrong owner");
                assert.equal(result.reason, "ref-ledger-conflict");
                const absorbed = executeAbsorb({ ref: "m00001", summary: "must not hide ambiguous source" }, "test-call", DEFAULT_ABSORB_CONFIG, { config, session, messages: childMessages });
                assert.equal(absorbed.reason, "ref-ledger-conflict");
                assert.equal(JSON.stringify({ state: session.state, stats: session.stats, metadata: session.metadata, revision: session.revisionEpoch }), before);
            };
            await refuse(child);
            assert.equal(child.refLedgerConflict, undefined, "adoption need not invent historical diagnostic rows");
            assert.equal(child.metadata.refLedgerConflict, true);
            store.closeQuietly();
            process.env.BILI_STORAGE_UNIFIED = mode;
            store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
            assert.equal(store.flushSync(child), true);
            store.closeQuietly();
            store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
            const loaded = store.loadSync(child.id, { protocol: "openai" })!;
            assert.ok(loaded);
            assert.equal(loaded.refLedgerConflict, undefined, "child has no retained old-owner rows to rediscover");
            assert.equal(loaded.metadata.refLedgerConflict, true, "existing metadata must keep quarantine across restart");
            await refuse(loaded);
            const grandchild = createSession(`grandchild-${mode}`, { protocol: "openai" });
            assert.ok(adopt(grandchild, loaded).seededRefs > 0);
            await refuse(grandchild);
            const healthy = createSession(`healthy-${mode}`, { protocol: "openai" });
            healthy.state = structuredClone(loaded.state);
            const healthyChild = createSession(`healthy-child-${mode}`, { protocol: "openai" });
            adopt(healthyChild, healthy);
            assert.equal(healthyChild.metadata.refLedgerConflict, undefined, "healthy adoption must not acquire quarantine");
            const checker = UnifiedStore.open(join(dir, "index.db"));
            try {
                assert.deepEqual(checker.getMessages(fixture.id, { includeRetired: true }), parentRows);
                assert.deepEqual(checker.findRefHistoryCollisions(child.id), [], "the marker, not a new SQL collision, must enforce refusal");
            } finally { checker.close(); }
        } finally {
            store.closeQuietly();
            _setStoreForTest(new SessionStore({ enabled: false }));
            if (previousMode === undefined) delete process.env.BILI_STORAGE_UNIFIED;
            else process.env.BILI_STORAGE_UNIFIED = previousMode;
            if (previousWriter === undefined) delete process.env.BILI_STORAGE_JSON_WRITER;
            else process.env.BILI_STORAGE_JSON_WRITER = previousWriter;
        }
    });
}


for (const mode of ["legacy", "full"] as const) {
    const scenarios = ["disk-newer", "local-newer", "local-known", "healthy", ...(mode === "full" ? ["index-only"] : [])];
    for (const scenario of scenarios) {
        test(`S19: ${mode} save keeps known quarantine when ${scenario}`, async () => {
            const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
            const { createSession, acquireInFlight, releaseInFlight, hasRefLedgerConflict } = await import("../src/session.ts");
            const previousMode = process.env.BILI_STORAGE_UNIFIED;
            const previousWriter = process.env.BILI_STORAGE_JSON_WRITER;
            process.env.BILI_STORAGE_UNIFIED = mode;
            process.env.BILI_STORAGE_JSON_WRITER = "on";
            const dir = mkdtempSync(join(testRoot, `convergence-${mode}-`));
            const localStore = new SessionStore({ enabled: true, dir, debounceMs: 0 });
            if (scenario === "index-only") process.env.BILI_STORAGE_JSON_WRITER = "off";
            const foreignStore = new SessionStore({ enabled: true, dir, debounceMs: 0 });
            process.env.BILI_STORAGE_JSON_WRITER = "on";
            _setStoreForTest(new SessionStore({ enabled: false }));
            const local = createSession(`convergence-${scenario}`, { protocol: "openai" });
            acquireInFlight(local);
            let foreign: Session | undefined;
            try {
                local.metadata.localOnly = "keep resident metadata";
                await localStore.writeNow(local);
                foreign = foreignStore.loadSync(local.id, { protocol: "openai" })!;
                assert.ok(foreign);
                acquireInFlight(foreign);
                foreign.stats.requests = 2;
                foreign.metadata.foreignOnly = "do not copy unrelated metadata";
                if (scenario === "disk-newer" || scenario === "local-newer" || scenario === "index-only") foreign.metadata.refLedgerConflict = true;
                await foreignStore.writeNow(foreign);
                if (scenario === "local-known") local.metadata.refLedgerConflict = true;
                const localWins = scenario === "local-newer" || scenario === "index-only";
                if (localWins) local.stats.requests = 3;
                await localStore.writeNow(local);
                const expected = scenario !== "healthy";
                assert.equal(hasRefLedgerConflict(local), expected, "active resident must retain known quarantine whichever state wins");
                assert.equal(local.stats.requests, localWins ? 3 : 2);
                assert.equal(local.metadata.localOnly, "keep resident metadata");
                assert.equal(local.metadata.foreignOnly, undefined, "do not replace unrelated resident metadata");
                const reader = new SessionStore({ enabled: true, dir, debounceMs: 0 });
                try {
                    const loaded = reader.loadSync(local.id, { protocol: "openai" })!;
                    assert.ok(loaded);
                    assert.equal(hasRefLedgerConflict(loaded), expected, "the selected persisted payload must retain the same fact");
                } finally { reader.closeQuietly(); }
            } finally {
                releaseInFlight(local);
                if (foreign) releaseInFlight(foreign);
                localStore.closeQuietly();
                foreignStore.closeQuietly();
                _setStoreForTest(new SessionStore({ enabled: false }));
                if (previousMode === undefined) delete process.env.BILI_STORAGE_UNIFIED;
                else process.env.BILI_STORAGE_UNIFIED = previousMode;
                if (previousWriter === undefined) delete process.env.BILI_STORAGE_JSON_WRITER;
                else process.env.BILI_STORAGE_JSON_WRITER = previousWriter;
            }
        });
    }
}
