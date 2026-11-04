// #5576 v6 canonical-watermark lane — the hit verdict comes SOLELY from
// unified-transcript row-chain alignment (alignClientAgainstTranscript);
// the v4/v5 byte-compare machinery survives only as negative filters.
// These tests pin: anchored hits served from ROWS (covered regions behind
// synthetic anchors), fresh-head system passthrough, the R6 logical ledger
// (model switches are non-events), the R7 sess-change identity gate,
// rewrite-class misses (+ BILI_PF_V6_REWRITE_STRICT crediting), the ledger
// width/shrink filters, pre-fold/store degrade, the zero-retention doctrine
// (canonical outcomes pin NO seed stash), and — with the knob OFF — the
// untouched v5 behavior as the regression anchor.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { openaiToCore } from "acp-kernel/wire";
import { evaluateWatermarkFastpath, finalizeWatermarkTurn, watermarkDebugState, PF_SEQ_HEADER, PF_TAIL_IDS_HEADER } from "../src/server/fastpath.ts";
import { stripRawStage } from "../src/marker/engine.ts";
import { _setStoreForTest, _resetStoreForTest, type SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";

process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK = "1";

const LOGS: string[] = [];
const log = (level: string, msg: string): void => { LOGS.push(`${level} ${msg}`); };

const SYS = (t: string): { role: string; content: string } => ({ role: "system", content: t });
const USR = (t: string): { role: string; content: string } => ({ role: "user", content: t });
const ASST = (t: string): { role: string; content: string } => ({ role: "assistant", content: t });

const bodyOf = (messages: unknown[], model = "m1"): string =>
    JSON.stringify({ model, stream: false, messages });

const headersOf = (h: Record<string, string>): http.IncomingMessage =>
    ({ headers: h }) as unknown as http.IncomingMessage;

type RowSeed = { id: string; role: string; contentType: string; text: string; wireIndex?: number };
interface Row { seq: number; msgId: string; ref: null; refNum: null; role: string; kind: string; content: string; contentHash: string; tokens: number }

/** Unified rows for `wirePrefix`, carrying EXACTLY the ids/sigs the legacy
 *  codec mints for those bytes (the alignment contract under test). */
const rowsFrom = (wirePrefix: unknown[], offset = 1): { rows: Row[]; seeds: RowSeed[] } => {
    const cores = openaiToCore({ model: "m1", messages: wirePrefix } as never) as { msgs: RowSeed[] };
    const rows: Row[] = cores.msgs.map((m, i) => ({
        seq: offset + i,
        msgId: m.id,
        ref: null,
        refNum: null,
        role: m.role,
        kind: m.contentType,
        content: JSON.stringify(m),
        contentHash: `h${offset + i}`,
        tokens: 3,
    }));
    return { rows, seeds: cores.msgs };
};

interface StubStore { ext: Map<string, unknown>; rows: Row[] | null }
const makeStubStore = (): StubStore => {
    const ext = new Map<string, unknown>();
    const s: StubStore = { ext, rows: null };
    _setStoreForTest({
        closeQuietly: (): void => {},
        replicasAvailable: (): boolean => true,
        getSessionExt: (sid: string, k: string): unknown => ext.get(`${sid}\u0000${k}`),
        setSessionExt: (sid: string, k: string, v: unknown): void => { void ext.set(`${sid}\u0000${k}`, v); },
        unifiedTailSeqs: (): number[] | null => (s.rows ? s.rows.map((_, i) => i + 1) : null),
        unifiedMessageIdRows: () => (s.rows ? s.rows.map(({ seq, msgId }) => ({ seq, msgId })) : null),
        unifiedTailViewRows: () => s.rows,
        unifiedUncoveredRows: (_id: string, intervals: readonly [number, number][]) =>
            (s.rows ? s.rows.filter((r) => !intervals.some(([a, b]) => r.seq >= a && r.seq <= b)) : null),
    } as unknown as SessionStore);
    return s;
};
const savedKey = (id: string): string => `${id}\u0000pf:state`;
const readSaved = (stub: StubStore, id: string): Record<string, unknown> | null => {
    const raw = stub.ext.get(savedKey(id));
    return raw === undefined ? null : (JSON.parse(String(raw)) as Record<string, unknown>);
};

const mkSession = (id: string, coverRowIds: readonly string[]): Session => ({
    id,
    state: {
        blocks: [{
            blockId: "b1", runId: "r", tier: 1, summary: "S",
            directMessageIds: [...coverRowIds], effectiveMessageIds: [...coverRowIds],
            directBlockIds: [], compressedTokens: 9, createdAt: 0, survivedCount: 0, generation: 1, active: true,
        }],
    },
    metadata: {},
}) as unknown as Session;

const setV6 = (on: boolean): void => { process.env.BILI_ROLLOUT_WATERMARK_CANONICAL_V6 = on ? "1" : "0"; };

/** Drive one evaluated turn exactly like prepareOpenai does. */
const runTurn = (
    session: Session,
    reqHeaders: Record<string, string>,
    bodyText: string,
): { out: ReturnType<typeof evaluateWatermarkFastpath>; headers: Record<string, string> } => {
    const model = JSON.parse(bodyText).model as string;
    const out = evaluateWatermarkFastpath(bodyText, headersOf(reqHeaders), session, { pluginMode: true, titleGen: false, model }, log);
    const parsed = JSON.parse(bodyText) as { messages: unknown[] };
    const oracle = openaiToCore(parsed as never);
    const stripCounts = stripRawStage(JSON.parse(bodyText), "openai");
    const headers = finalizeWatermarkTurn(session, out, {
        model,
        legacyCores: out.hit !== null ? out.hit.view : oracle.msgs,
        rawSystemText: out.hit !== null ? out.hit.systemText : oracle.systemText,
        turnStripCounts: stripCounts,
    });
    return { out, headers };
};

// Fixture: history U1/A1/U2 already folded-backed (rows), block b1 anchored
// on A1's row (covered → rendered behind its synthetic anchor). Every test
// below starts from exactly this state unless noted.
const FIX = {
    u1: USR("unique-user-one-history-bytes"),
    a1: ASST("unique-assistant-one-reply-bytes"),
    u2: USR("unique-user-two-history-bytes"),
    u3: USR("unique-user-three-fresh-question"),
};

const setupFix = (stub: StubStore): void => {
    const { rows, seeds } = rowsFrom([FIX.u1, FIX.a1, FIX.u2]);
    stub.rows = rows;
    void seeds;
};

test("v6: count-only client hits via canonical alignment; view = rows + fresh tail; zero retention", () => {
    _resetStoreForTest();
    const stub = makeStubStore();
    setupFix(stub);
    const session = mkSession("v6-hit", [rowsFrom([FIX.u1, FIX.a1, FIX.u2]).seeds[1].id]);
    setV6(true);
    try {
        // Arm the ledger the way turn A's (pre-fold) legacy turn left it:
        // t = element count of the previous request (5 incl. system).
        // Ledger arm = the previous turn's (pre-fold legacy) T: 4 elements
        // ([sys,u1,a1,u2]); this turn appends u3 → T=5 > K=4.
        stub.ext.set(savedKey(session.id), JSON.stringify({ t: 4, m: "m1", misses: 0 }));
        const body = bodyOf([SYS("sys-a"), FIX.u1, FIX.a1, FIX.u2, FIX.u3]);
        const r = runTurn(session, {}, body);
        assert.equal(r.out.decision, "hit-v6");
        assert.equal(r.out.measuredT, 5);
        assert.ok(r.out.hit);
        const ids = r.out.hit.view.map((m) => m.id);
        const seeded = rowsFrom([FIX.u1, FIX.a1, FIX.u2]).seeds;
        // Covered A1 renders BEHIND its synthetic anchor — exact order pinned.
        assert.deepEqual(ids, [seeded[0].id, "acp_summary_b1", seeded[2].id, (openaiToCore({ model: "m1", messages: [FIX.u3] } as never) as { msgs: RowSeed[] }).msgs[0].id]);
        assert.deepEqual(r.out.hit.windowMessages, [FIX.u3]);
        assert.equal(r.out.hit.systemText, "sys-a");
        assert.equal(r.headers[PF_SEQ_HEADER], "5");
        const saved = readSaved(stub, session.id)!;
        assert.equal(saved.t, 5);
        assert.equal(saved.misses, 0);
        // Zero-retention doctrine: a canonical hit pins NO seed stash.
        assert.equal(watermarkDebugState(session).seeded, false);
    } finally {
        setV6(false);
        _resetStoreForTest();
    }
});

test("v6: changed system text is passthrough, not drift (head-drift gate retired)", () => {
    _resetStoreForTest();
    const stub = makeStubStore();
    setupFix(stub);
    const session = mkSession("v6-sys", [rowsFrom([FIX.u1, FIX.a1, FIX.u2]).seeds[1].id]);
    setV6(true);
    try {
        stub.ext.set(savedKey(session.id), JSON.stringify({ t: 4, m: "m1", misses: 0 }));
        const body = bodyOf([SYS("totally-different-system-now"), FIX.u1, FIX.a1, FIX.u2, FIX.u3]);
        const r = runTurn(session, {}, body);
        // v5 would answer head-drift + breaker credit here; v6 rides it.
        assert.equal(r.out.decision, "hit-v6");
        assert.equal(r.out.creditedMiss, false);
        assert.equal(r.out.hit?.systemText, "totally-different-system-now");
        assert.equal(readSaved(stub, session.id)?.misses, 0);
    } finally {
        setV6(false);
        _resetStoreForTest();
    }
});

test("v6 R6: model switch is a non-event on the shared logical ledger", () => {
    _resetStoreForTest();
    const stub = makeStubStore();
    setupFix(stub);
    const session = mkSession("v6-model", [rowsFrom([FIX.u1, FIX.a1, FIX.u2]).seeds[1].id]);
    setV6(true);
    try {
        // State seeded by a DIFFERENT model (v5 answers seed-stale here).
        stub.ext.set(savedKey(session.id), JSON.stringify({ t: 4, m: "other-model", misses: 0 }));
        const body = bodyOf([SYS("sys-a"), FIX.u1, FIX.a1, FIX.u2, FIX.u3], "m2");
        const r = runTurn(session, {}, body);
        assert.equal(r.out.decision, "hit-v6");
        assert.equal(readSaved(stub, session.id)?.m, "m2");
    } finally {
        setV6(false);
        _resetStoreForTest();
    }
});

test("v6 R7: swapped client-native session is an identity event even on identical bytes", () => {
    _resetStoreForTest();
    const stub = makeStubStore();
    setupFix(stub);
    const session = mkSession("v6-cs", [rowsFrom([FIX.u1, FIX.a1, FIX.u2]).seeds[1].id]);
    setV6(true);
    try {
        stub.ext.set(savedKey(session.id), JSON.stringify({ t: 4, m: "m1", misses: 0, cs: "aa".repeat(4).slice(0, 8) }));
        const body = bodyOf([SYS("sys-a"), FIX.u1, FIX.a1, FIX.u2, FIX.u3]);
        const r = runTurn(session, { "x-conversation-id": "another-host-session" }, body);
        assert.equal(r.out.decision, "sess-change");
        assert.equal(r.out.creditedMiss, false);
        assert.equal(watermarkDebugState(session).seeded, false);
    } finally {
        setV6(false);
        _resetStoreForTest();
    }
});

test("v6: client-side rewrite misses stay uncredited by default, credited under BILI_PF_V6_REWRITE_STRICT", () => {
    for (const strict of ["unset", "on"]) {
        _resetStoreForTest();
        const stub = makeStubStore();
        setupFix(stub);
        const session = mkSession(`v6-rw-${strict}`, [rowsFrom([FIX.u1, FIX.a1, FIX.u2]).seeds[1].id]);
        setV6(true);
        if (strict === "on") process.env.BILI_PF_V6_REWRITE_STRICT = "1";
        try {
            stub.ext.set(savedKey(session.id), JSON.stringify({ t: 4, m: "m1", misses: 0 }));
            // Two ADJACENT rewritten middle elements: one tolerated gap, the
            // second consecutive miss ends the chain; the surviving run
            // (u2, one match) is below MIN_SEAM_RUN → rewrite class.
            const body = bodyOf([SYS("sys-a"), USR("edited-one"), ASST("edited-two"), FIX.u2, FIX.u3]);
            const r = runTurn(session, {}, body);
            assert.equal(r.out.decision, "v6-seam-too-short");
            const saved = readSaved(stub, session.id)!;
            assert.equal(saved.misses, strict === "on" ? 1 : 0);
            assert.equal(saved.disabledAt, undefined);
        } finally {
            delete process.env.BILI_PF_V6_REWRITE_STRICT;
            setV6(false);
            _resetStoreForTest();
        }
    }
});

test("v6: epoch-style total rewrite → chain-not-started (rewrite class)", () => {
    _resetStoreForTest();
    const stub = makeStubStore();
    setupFix(stub);
    const session = mkSession("v6-epoch", [rowsFrom([FIX.u1, FIX.a1, FIX.u2]).seeds[1].id]);
    setV6(true);
    try {
        stub.ext.set(savedKey(session.id), JSON.stringify({ t: 4, m: "m1", misses: 0 }));
        // Entirely novel content, ledger still growing (T=5 > K=4 so the
        // width filters pass): nothing in the body anchors to a stored row.
        const body = bodyOf([SYS("sys-a"), USR("brand-new-x"), ASST("brand-new-y"), USR("brand-new-z"), ASST("brand-new-w")]);
        const r = runTurn(session, {}, body);
        assert.equal(r.out.decision, "v6-chain-not-started");
        assert.equal(r.out.creditedMiss, false);
    } finally {
        setV6(false);
        _resetStoreForTest();
    }
});

test("v6: ledger-width arithmetic catches a compaction shrink BEFORE the expensive stage", () => {
    _resetStoreForTest();
    const stub = makeStubStore();
    setupFix(stub);
    const session = mkSession("v6-shrink", [rowsFrom([FIX.u1, FIX.a1, FIX.u2]).seeds[1].id]);
    setV6(true);
    process.env.BILI_PF_V6_REWRITE_STRICT = "1"; // shrink stays uncredited even in strict
    try {
        // Previous turn stamped T=9; the host compacted down to 4 elements.
        stub.ext.set(savedKey(session.id), JSON.stringify({ t: 9, m: "m1", misses: 0 }));
        const body = bodyOf([SYS("compaction-summary-passes-through"), ASST("kept-one"), USR("kept-two"), ASST("kept-three")]);
        const list = ["?", "h_kepta", "h_keptb"].map(encodeURIComponent).join(",");
        const r = runTurn(session, { [PF_TAIL_IDS_HEADER]: list }, body);
        assert.equal(r.out.decision, "tail-ids-shape");
        assert.equal(r.out.creditedMiss, false);
        assert.equal(readSaved(stub, session.id)?.misses, 0);
    } finally {
        delete process.env.BILI_PF_V6_REWRITE_STRICT;
        setV6(false);
        _resetStoreForTest();
    }
});

test("v6: no prior fold → cheap v6-pre-fold degrade; no store → v6-store-unavailable", () => {
    _resetStoreForTest();
    const stub = makeStubStore();
    setupFix(stub);
    setV6(true);
    const body = bodyOf([SYS("sys-a"), FIX.u1, FIX.a1, FIX.u2, FIX.u3]);
    // The no-blocks degrade must not depend on any stub being registered
    // (store presence is irrelevant before the blocks pre-gate).
    const noBlocks = { id: "v6-nofold", state: { blocks: [] as unknown[] }, metadata: {} };
    try {
        const r1 = runTurn(noBlocks as never, {}, body);
        assert.equal(r1.out.decision, "v6-pre-fold");
        assert.equal(r1.out.canonical, true);
    } finally {
        setV6(false);
        _resetStoreForTest();
    }
    // No STORE CAPABILITY at all: a registered store whose replicas report
    // unavailable (getStore() auto-instantiates a real one when unset, so
    // "null" cannot be simulated from here — capability-off is the honest
    // injection).
    _resetStoreForTest();
    setV6(true);
    _setStoreForTest({
        closeQuietly: (): void => {},
        replicasAvailable: (): boolean => false,
        getSessionExt: (): unknown => undefined,
        setSessionExt: (): void => {},
    } as unknown as SessionStore);
    try {
        const r2 = runTurn(mkSession("v6-nostore", ["x"]), {}, body);
        assert.equal(r2.out.decision, "v6-store-unavailable");
        assert.equal(r2.out.canonical, true);
    } finally {
        setV6(false);
        _resetStoreForTest();
    }
});

test("v6: '?' slots ride the ledger list without penalty (identity-unverified, not a fault)", () => {
    _resetStoreForTest();
    const stub = makeStubStore();
    setupFix(stub);
    const session = mkSession("v6-slots", [rowsFrom([FIX.u1, FIX.a1, FIX.u2]).seeds[1].id]);
    setV6(true);
    try {
        stub.ext.set(savedKey(session.id), JSON.stringify({ t: 4, m: "m1", misses: 0 }));
        const body = bodyOf([SYS("sys-a"), FIX.u1, FIX.a1, FIX.u2, FIX.u3]);
        // Valid width (T-K+1 = 2) with a slot in it — v6 never consults the
        // VALUES, only the width; slots must not disturb the hit.
        const list = ["?"].concat(["h_some"]).map(encodeURIComponent).join(",");
        const r = runTurn(session, { [PF_TAIL_IDS_HEADER]: list }, body);
        assert.equal(r.out.decision, "hit-v6");
    } finally {
        setV6(false);
        _resetStoreForTest();
    }
});

test("v6: duplicate-content histories agree with the legacy full-parse numbering", () => {
    _resetStoreForTest();
    const stub = makeStubStore();
    // History CONTAINS a repeated user text — cluster numbering (_N suffixes)
    // only agrees if the v6 conversion sees the same occurrence stream the
    // legacy single-parse minted (full-body conversion).
    const hist = [USR("ok"), ASST("reply-alpha"), USR("ok"), ASST("reply-beta")];
    const { rows, seeds } = rowsFrom(hist);
    stub.rows = rows;
    const session = mkSession("v6-dup", [seeds[1].id]);
    setV6(true);
    try {
        stub.ext.set(savedKey(session.id), JSON.stringify({ t: 5, m: "m1", misses: 0 }));
        const fresh = USR("unique-fresh-question");
        const body = bodyOf([SYS("sys-a"), ...hist, fresh]);
        const r = runTurn(session, {}, body);
        assert.equal(r.out.decision, "hit-v6", `expected canonical hit, got ${r.out.decision}`);
        const last = r.out.hit!.view[r.out.hit!.view.length - 1];
        assert.equal(last.text, "unique-fresh-question");
        assert.deepEqual(r.out.hit!.windowMessages, [fresh]);
    } finally {
        setV6(false);
        _resetStoreForTest();
    }
});

test("v6: trailing element duplicating old content degrades safely (sig-fallback residual, never a silent tail drop)", () => {
    _resetStoreForTest();
    const stub = makeStubStore();
    const hist = [USR("ok"), ASST("reply-alpha"), USR("ok"), ASST("reply-beta")];
    const { rows, seeds } = rowsFrom(hist);
    stub.rows = rows;
    const session = mkSession("v6-dup-tail", [seeds[1].id]);
    setV6(true);
    try {
        stub.ext.set(savedKey(session.id), JSON.stringify({ t: 5, m: "m1", misses: 0 }));
        // The NEW trailing message repeats older text verbatim: its sig
        // collides with a stored row and the full-length join would serve a
        // view that silently drops the tail → guarded miss, legacy serves.
        const body = bodyOf([SYS("sys-a"), ...hist, USR("ok")]);
        const r = runTurn(session, {}, body);
        assert.equal(r.out.decision, "v6-no-seam-origin");
        assert.equal(r.out.creditedMiss, false);
        assert.equal(watermarkDebugState(session).seeded, false);
    } finally {
        setV6(false);
        _resetStoreForTest();
    }
});

test("regression anchor: with v6 OFF the v5 machinery behaves byte-for-byte as before", () => {
    _resetStoreForTest();
    const stub = makeStubStore();
    setupFix(stub);
    const session = mkSession("v5-anchor", [rowsFrom([FIX.u1, FIX.a1, FIX.u2]).seeds[1].id]);
    setV6(false);
    try {
        // Turn 1: FIRST request carries no stamp at all → v5 no-stamp miss,
        // and finalize pins the seed stash (canonical skip must NOT fire on
        // the v5 lane — retention semantics unchanged).
        const b1 = bodyOf([SYS("sys-a"), FIX.u1, FIX.a1, FIX.u2]);
        const r1 = runTurn(session, {}, b1);
        assert.equal(r1.out.decision, "no-stamp");
        assert.notEqual(r1.out.canonical, true);
        assert.equal(watermarkDebugState(session).seeded, true);
        // Turn 2: echoes turn 1's measured T as stamp and appends u3 → the
        // v5 seed path hits (NOT hit-v6).
        const b2 = bodyOf([SYS("sys-a"), FIX.u1, FIX.a1, FIX.u2, FIX.u3]);
        const r2 = runTurn(session, { "x-bili-pf-count": "4" }, b2);
        assert.match(r2.out.decision, /^hit\b/);
        assert.notEqual(r2.out.decision, "hit-v6");
        assert.ok(r2.out.hit && r2.out.hit.windowMessages.length === 1);
    } finally {
        _resetStoreForTest();
    }
});
