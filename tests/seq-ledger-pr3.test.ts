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
 * S15: cold load re-stamps legacy counter refs onto seq+1 exactly once and
 *      records the superseded map on the session.
 * S16: cold load KEEPS legacy refs when mapped ids own no rows (#5599: an
 *      imported collapsed ledger must not be stamped — the stamp would
 *      evict ghost bindings and re-target saved citations at newer bodies);
 *      a complete ledger still aligns (control half).
 */
process.env.NODE_ENV = "test";
process.env.BILI_STORAGE_UNIFIED = "full";
const testRoot = mkdtempSync(join(tmpdir(), "bili-pr3-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage } from "acp-kernel";
import { supersededRefRejection } from "../src/stream.ts";
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

test("S15: citation-space alignment defers from cold load to the next fold save (#5608-D)", async () => {
    // A persisted session whose kernel refs came from the counter path (a
    // BLOCKED protected message skipped a number, so refs drift ahead of
    // seq+1). #5608-D: cold load must NOT re-stamp anymore — restarts must
    // leave every rendered byte untouched so the provider prefix survives;
    // the one-time alignment rides the NEXT fold's save (its history rewrite
    // already breaks the prefix once), armed via session.pendingLedgerAlign.
    // A second fold/save cycle must be a no-op (kept only, map preserved).
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
        // #5608-D: cold load alone must keep the legacy counter refs — the
        // rendered bytes stay byte-identical to what the provider cached.
        const refs = reloaded.state.messageRefs;
        assert.equal(refs.byRaw.a, "m00001");
        assert.equal(refs.byRaw.b, "m00002");
        assert.equal(refs.byRaw.c, "BLOCKED", "protected keeps taking no number");
        assert.equal(refs.byRaw.d, "m00003", "legacy counter ref kept on cold load");
        assert.equal(refs.byRaw.e, "m00004", "legacy counter ref kept on cold load");
        assert.notEqual((reloaded.state as { refLedgerAligned?: boolean }).refLedgerAligned, true);
        assert.equal(reloaded.restampSuperseded, undefined);

        // Simulate the fold commit (stream.ts sets the marker right after
        // `ctx.session.state = res.state;`) then the follow-up save:
        // scheduleSave consumes the marker BEFORE serializing anything.
        (reloaded as { pendingLedgerAlign?: boolean }).pendingLedgerAlign = true;
        assert.ok(store2.flushSync(reloaded), "post-fold save commits");
        // The alignment ran in that single pass: refs settled onto seq+1,
        // the superseded map published for stale-citation refusal.
        const refs2 = reloaded.state.messageRefs;
        assert.equal(refs2.byRaw.d, "m00004", "d re-stamped to seq3+1");
        assert.equal(refs2.byRaw.e, "m00005", "e re-stamped to seq4+1");
        assert.equal((reloaded.state as { refLedgerAligned?: boolean }).refLedgerAligned, true);
        const rs = reloaded as { restampSuperseded?: Map<string, string> };
        assert.ok(rs.restampSuperseded instanceof Map);
        assert.equal(rs.restampSuperseded.get("m00003"), "d");
        assert.equal(rs.restampSuperseded.get("m00004"), "e");
        assert.equal((reloaded as { pendingLedgerAlign?: boolean }).pendingLedgerAlign, undefined, "marker consumed exactly once");
        // A further save without a new fold is a plain no-op (flag already set).
        assert.ok(store2.flushSync(reloaded), "second save committed");
        assert.equal(reloaded.state.messageRefs.byRaw.e, "m00005", "second save does not re-settle");

        // Cold load after the fold: aligned state is a no-op (kept only),
        // and the superseded map rides the Session object for this process
        // only — this reload proves the new process starts without one.
        store2.closeQuietly();
        const store3 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        _setStoreForTest(store3);
        const again = store3.loadSync("pr3-restamp");
        assert.ok(again);
        assert.equal(again.state.messageRefs.byRaw.d, "m00004", "aligned refs stable across reloads");
        assert.equal(again.state.messageRefs.byRaw.e, "m00005");
        // Fresh process: no superseded map — refs behave normally.
        assert.equal(again.restampSuperseded, undefined);
        store3.closeQuietly();
    } finally {
        // restore the singleton-less state for later tests
        _setStoreForTest({} as never);
    }
    rmSync(dir, { recursive: true, force: true });
});

test("S16: cold load keeps legacy refs when mapped ids own no rows (#5599 folded-tail import)", async () => {
    const refOf = (i: number): string => `m${String(i).padStart(5, "0")}`;
    const idOf = (i: number): string => (i <= 6 ? `o${i}` : `t${i - 6}`);

    const dir = join(testRoot, `s16-${Math.random().toString(36).slice(2)}`);
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    try {
        // Imported collapsed ledger: o1..o6 are folded (bindings live in the
        // ref ledger, NO message rows), t1..t3 are the resident tail re-based
        // at seq 0..2, and the saved summary cites m00001. Seeded exactly like
        // an import does — one ingest of the record as-is.
        const legacy = legacyLike("pr3-folded-tail", [msg("t1", "assistant"), msg("t2"), msg("t3")]);
        const byRaw: Record<string, string> = {};
        const byRef: Record<string, string> = {};
        for (let i = 1; i <= 9; i++) {
            byRaw[idOf(i)] = refOf(i);
            byRef[refOf(i)] = idOf(i);
        }
        legacy.state.messageRefs = { byRaw, byRef };
        legacy.state.blocks = [{
            blockId: "b1",
            runId: "r1",
            tier: 1,
            summary: "Earlier evidence: m00001.",
            directMessageIds: ["o1", "o2", "o3", "o4", "o5", "o6"],
            effectiveMessageIds: ["o1", "o2", "o3", "o4", "o5", "o6"],
            directBlockIds: [],
            compressedTokens: 60,
            createdAt: Date.now(),
            survivedCount: 0,
            generation: "young",
            active: true,
            startRef: "m00001",
            endRef: "m00006",
        }];
        legacy.state.deadRefs = ["m00001", "m00002", "m00003", "m00004", "m00005", "m00006"];
        legacy.contentStore = {
            version: 1,
            byHash: {},
            byRef: {
                m00001: msg("o1", "user", "original body one"),
                m00007: msg("t1", "assistant", "tail body one"),
            },
        };
        const st = UnifiedStore.open(join(dir, "index.db"), undefined as never) as unknown as UnifiedStore;
        st.ingestSession(planIngest(legacy));
        st.close();

        // Cold load from the index alone (fresh store over the same dir).
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        _setStoreForTest(store);
        const reloaded = store.loadSync("pr3-folded-tail");
        assert.ok(reloaded, "session loads from the index");
        for (let i = 1; i <= 9; i++) {
            assert.equal(reloaded!.state.messageRefs.byRaw[idOf(i)], refOf(i), `${idOf(i)} keeps its legacy ref`);
        }
        assert.notEqual((reloaded!.state as { refLedgerAligned?: boolean }).refLedgerAligned, true, "incomplete ledger: alignment skipped, retried on a later cold load");
        assert.equal(reloaded!.restampSuperseded, undefined);
        // The saved citation still resolves to the original body, not the tail.
        const ccr = reloaded!.contentStore as { byRef?: Record<string, { text?: string }> } | undefined;
        assert.equal(ccr?.byRef?.["m00001"]?.text, "original body one", "m00001 retrieves o1's original");
        assert.equal(ccr?.byRef?.["m00007"]?.text, "tail body one", "tail binding untouched");
        store.closeQuietly();

        // Control: the SAME ref map over a COMPLETE ledger (every mapped id
        // owns a live row) must still align — here it converges to a no-op,
        // proving the guard discriminates on row coverage, not on folds.
        const dir2 = join(testRoot, `s16c-${Math.random().toString(36).slice(2)}`);
        try {
            const complete = legacyLike("pr3-complete", Array.from({ length: 9 }, (_, k) => msg(idOf(k + 1))));
            complete.state.messageRefs = { byRaw, byRef };
            const st2 = UnifiedStore.open(join(dir2, "index.db"), undefined as never) as unknown as UnifiedStore;
            st2.ingestSession(planIngest(complete));
            st2.close();
            const store2 = new SessionStore({ enabled: true, dir: dir2, debounceMs: 0 });
            _setStoreForTest(store2);
            const aligned = store2.loadSync("pr3-complete");
            assert.ok(aligned, "complete-ledger session loads");
            assert.equal((aligned!.state as { refLedgerAligned?: boolean }).refLedgerAligned, true, "complete ledger still aligns");
            for (let i = 1; i <= 9; i++) {
                assert.equal(aligned!.state.messageRefs.byRaw[idOf(i)], refOf(i), `${idOf(i)} already at seq+1 — no-op alignment`);
            }
            store2.closeQuietly();
        } finally {
            _setStoreForTest({} as never);
            rmSync(dir2, { recursive: true, force: true });
        }
    } finally {
        _setStoreForTest({} as never);
    }
    rmSync(dir, { recursive: true, force: true });
});
