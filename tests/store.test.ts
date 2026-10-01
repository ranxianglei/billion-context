import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    buildStoredPlaceholder,
    createCore,
    createInitialState,
    DEFAULT_CCR_CONFIG,
    defaultConfig,
    STORED_PLACEHOLDER_MARKER,
    type CoreMessage,
    type MessageContentStore,
} from "acp-kernel";
import { parseCompressSettings } from "../src/config.ts";
import { applyCompressSettings, mergeCompress } from "../src/compress-settings.ts";
import { adoptContentStore, drainPendingRetrievals, executeRetrieve, retrieveToolName, storeEffectiveCcr, contentStoreOf, snapshotPendingRetrievals, commitRetrievals, dropRetrievals, pruneExpiredRetrievals, reconcileReloadedRetrievals, snapshotRetrievalNotes, renderRetrievalNotes, commitRetrievalNotes } from "../src/store.ts";
import { RETRIEVE_TOOL_NAME } from "../src/compress-tool.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { rmrf } from "./tmp-rm.ts";

// Unit tests never touch the real data/state trees: persistence off by
// default; the envelope round-trip builds its own throwaway SessionStore.
process.env.BILI_PERSIST = "0";
const PERSIST_TMP = mkdtempSync(path.join(tmpdir(), "bili-ccr-persist-"));

const BIG_TEXT = "line of build output ".repeat(700);

function toolResult(): CoreMessage[] {
    return [
        { id: "u1", role: "user", contentType: "text", text: "run a big build" },
        { id: "a-tc", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_1", text: JSON.stringify({ command: "npm run build" }) },
        { id: "t-res", role: "tool", contentType: "tool-result", toolCallId: "call_1", toolName: "bash", text: BIG_TEXT },
    ];
}

function ccrConfig() {
    return applyCompressSettings(defaultConfig(200000), 200_000, {
        absorb: { enabled: true, minToolTokens: 50 },
        ccr: { enabled: true, minToolTokens: 50 },
    });
}

function turnWith(cfg: ReturnType<typeof applyCompressSettings>, store?: MessageContentStore) {
    const core = createCore();
    return core.processTurn({ messages: toolResult(), state: createInitialState(), config: cfg, tokenCount: 0, renderTags: "text-only", ...(store ? { contentStore: store } : {}) });
}

// Two oversized results in ONE turn ⇒ two distinct refs in one content store.
// (Separate turns each start their own ref sequence, so their first stored
// refs collide — two loss events need one shared state.)
function turnTwoResults(cfg: ReturnType<typeof applyCompressSettings>) {
    const core = createCore();
    return core.processTurn({
        messages: [
            { id: "u1", role: "user", contentType: "text", text: "run two big builds" },
            { id: "a-tc1", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_1", text: JSON.stringify({ command: "npm run build" }) },
            { id: "t-res1", role: "tool", contentType: "tool-result", toolCallId: "call_1", toolName: "bash", text: BIG_TEXT },
            { id: "a-tc2", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_2", text: JSON.stringify({ command: "npm test" }) },
            { id: "t-res2", role: "tool", contentType: "tool-result", toolCallId: "call_2", toolName: "bash", text: "another very different build log ".repeat(700) },
        ],
        state: createInitialState(), config: cfg, tokenCount: 0, renderTags: "text-only",
    });
}

test("parseCompressSettings: ccr key validates shape and types", () => {
    const okFull = parseCompressSettings({
        ccr: { enabled: true, minToolTokens: 500, excludeTools: ["webfetch"], toolName: "fetch_original", maxHeadChars: 64 },
    });
    assert.ok(okFull);
    assert.deepEqual(okFull.ccr, { enabled: true, minToolTokens: 500, excludeTools: ["webfetch"], toolName: "fetch_original", maxHeadChars: 64 });

    // toolName is trimmed; empty after trim is invalid
    assert.equal(parseCompressSettings({ ccr: { toolName: "  lookup  " } }).ccr?.toolName, "lookup");
    assert.equal(parseCompressSettings({ ccr: { toolName: "   " } }), undefined);
    // wrong types reject the whole settings block (fail loudly, #155)
    assert.equal(parseCompressSettings({ ccr: { enabled: "yes" } }), undefined);
    assert.equal(parseCompressSettings({ ccr: { minToolTokens: "500" } }), undefined);
    assert.equal(parseCompressSettings({ ccr: { maxHeadChars: NaN } }), undefined);
    assert.equal(parseCompressSettings({ ccr: { excludeTools: [42] } }), undefined);
    assert.equal(parseCompressSettings({ ccr: { excludeTools: "webfetch" } }), undefined);
    assert.equal(parseCompressSettings({ ccr: "on" }), undefined);
});

test("mergeCompress: ccr merges sub-field-wise across the three levels", () => {
    const global = parseCompressSettings({ ccr: { enabled: true, excludeTools: ["webfetch"] } })!;
    const model = parseCompressSettings({ ccr: { minToolTokens: 200 } })!;
    const merged = mergeCompress(global, undefined, model);
    assert.deepEqual(merged.ccr, { enabled: true, minToolTokens: 200, excludeTools: ["webfetch"] });

    // a deeper level can override a scalar without clobbering siblings
    const provider = parseCompressSettings({ ccr: { toolName: "lookup" } })!;
    const merged2 = mergeCompress(global, provider, model);
    assert.deepEqual(merged2.ccr, { enabled: true, minToolTokens: 200, excludeTools: ["webfetch"], toolName: "lookup" });

    assert.equal(mergeCompress(undefined, undefined, undefined).ccr, undefined);
});

test("applyCompressSettings: maps ccr onto kernel CcrConfig with DEFAULT_CCR_CONFIG defaults", () => {
    const base = defaultConfig(200000);
    const out = applyCompressSettings(base, 200_000, { ccr: { enabled: true, minToolTokens: 200 } });
    assert.deepEqual(out.ccr, { ...DEFAULT_CCR_CONFIG, minToolTokens: 200, enabled: true });
    // absent block → stays off (#1207 opt-in): no default-on flip, base.ccr
    // carries through untouched
    const defaulted = applyCompressSettings(base, 200_000, {});
    assert.ok(!defaulted.ccr?.enabled, "unset ccr resolves to off (#1207 opt-in)");
    // explicit false still wins (opt-out preserved)
    const off = applyCompressSettings(base, 200_000, { ccr: { enabled: false } });
    assert.equal(off.ccr?.enabled, false);
});

test("integration: kernel processTurn ID-references the oversized tool result (ccr+absorb enabled)", () => {
    const cfg = ccrConfig();
    const turn = turnWith(cfg);
    const res = turn.messages.find((m) => m.role === "tool" && m.toolCallId === "call_1")!;
    assert.ok(res, "tool-result message survived the turn");
    assert.notEqual(res.text, BIG_TEXT);
    assert.ok(res.text!.includes(STORED_PLACEHOLDER_MARKER), `placeholder expected: ${res.text!.slice(0, 160)}`);
    const ref = Object.keys(turn.contentStore.byRef)[0]!;
    assert.ok(res.text!.includes(ref), "placeholder cites the stored ref");
    assert.ok(res.text!.includes(RETRIEVE_TOOL_NAME), "placeholder names the retrieve tool");
    assert.equal(turn.contentStore.byRef[ref]!.rawId, "t-res");
    assert.equal(Object.keys(turn.contentStore.byHash).length, 1);
    // tool-call pairing survives substitution
    assert.equal(turn.messages.find((m) => m.id === "a-tc")!.text, JSON.stringify({ command: "npm run build" }));
});

test("integration: ccr stays inert with no explicit config; explicit enable arms the kernel store node", () => {
    const disarmed = applyCompressSettings(defaultConfig(200000), 200_000, {});
    assert.ok(!disarmed.ccr?.enabled, "unset ccr → off (#1207 opt-in)");
    const inert = turnWith(disarmed);
    const res0 = inert.messages.find((m) => m.role === "tool" && m.toolCallId === "call_1")!;
    assert.equal(res0.text, BIG_TEXT, "no placeholder without explicit opt-in");
    assert.equal(Object.keys(inert.contentStore.byRef).length, 0);

    const cfg = applyCompressSettings(defaultConfig(200000), 200_000, { ccr: { enabled: true } });
    assert.equal(cfg.ccr?.enabled, true, "explicit enable arms");
    const msgs: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "run a big build" },
        { id: "a-tc", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_1", text: JSON.stringify({ command: "npm run build" }) },
        { id: "t-res", role: "tool", contentType: "tool-result", toolCallId: "call_1", toolName: "bash", text: "line of build output ".repeat(3000) },
    ];
    const core = createCore();
    const turn = core.processTurn({ messages: msgs, state: createInitialState(), config: cfg, tokenCount: 0, renderTags: "text-only" });
    const res = turn.messages.find((m) => m.role === "tool" && m.toolCallId === "call_1")!;
    assert.ok(res.text!.includes(STORED_PLACEHOLDER_MARKER), `placeholder expected at the default threshold: ${res.text!.slice(0, 160)}`);
    assert.equal(Object.keys(turn.contentStore.byRef).length, 1, "one entry stored via the default minToolTokens");
});

test("integration: ccr explicitly off → byte-identical pass-through", () => {
    const cfg = applyCompressSettings(defaultConfig(200000), 200_000, { ccr: { enabled: false } });
    assert.equal(cfg.ccr?.enabled, false);
    const turn = turnWith(cfg);
    const res = turn.messages.find((m) => m.role === "tool" && m.toolCallId === "call_1")!;
    assert.equal(res.text, BIG_TEXT);
    assert.equal(Object.keys(turn.contentStore.byRef).length, 0);
});

test("executeRetrieve: hit returns the framed original IN the tool result (GHSA jc6g v2), miss self-corrects, tool name follows config", () => {
    const session = getSession(`t-ccr-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, toolName: "lookup", minToolTokens: 50 });
    assert.equal(retrieveToolName(session), "lookup");
    adoptContentStore(session, turnWith(ccrConfig()).contentStore);
    const ref = Object.keys(session.contentStore!.byRef)[0]!;

    const out = executeRetrieve({ ref }, session);
    assert.match(out, new RegExp(`acp-retrieved #${ref}`), "framed as untrusted data");
    assert.ok(out.includes(BIG_TEXT.slice(0, 80)), "the tool result itself carries the full original");
    assert.equal(session.stats.retrieveCalls, 1);
    assert.equal(session.stats.retrieveHits, 1);
    assert.equal(session.stats.retrieveDelivered, 1, "delivered inline at retrieve time");
    assert.equal(session.pendingRetrievals.length, 0, "nothing queued — the injection channel is gone");
    assert.equal(drainPendingRetrievals(session).length, 0);

    const miss = executeRetrieve({ ref: "m99999" }, session);
    assert.match(miss, /not found/);
    assert.equal(session.stats.retrieveMisses, 1);
    assert.equal(session.stats.retrieveCalls, 2);
    assert.equal(drainPendingRetrievals(session).length, 0, "a miss queues nothing");
    // malformed arg is a miss, not a crash
    assert.match(executeRetrieve({}, session), /ref/);
    assert.equal(session.stats.retrieveMisses, 2);
});

test("buildStoredPlaceholder renders the kernel wire format the gates assert on", () => {
    const text = buildStoredPlaceholder({ ref: "m00423", kind: "shell output", tokens: 4213, head: "npm run build", command: "npm run build", retrieveToolName: RETRIEVE_TOOL_NAME });
    assert.ok(text.includes("[acp-stored #m00423"));
    assert.ok(text.includes("shell output"));
    assert.ok(text.includes("4,213 tok"));
    assert.ok(text.includes(`${RETRIEVE_TOOL_NAME}("m00423")`), "placeholder tells the model how to retrieve");
    assert.ok(text.includes("npm run build"));
});

test("envelope round-trip: dirty flag gates the write; reload restores the store", () => {
    const store = new SessionStore({ dir: PERSIST_TMP, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        const session = getSession(`ccr-rt-${Math.random().toString(36).slice(2)}`);
        storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
        adoptContentStore(session, turnWith(ccrConfig()).contentStore);
        const ref = Object.keys(session.contentStore!.byRef)[0]!;

        // clean store → no envelope write
        session.contentStoreDirty = false;
        store.flushSync(session);
        assert.equal(findEnvelope(PERSIST_TMP), null, "clean store must not write the envelope");

        // dirty → written; round-trip restores it verbatim
        session.contentStoreDirty = true;
        assert.ok(store.flushSync(session));
        const file = findEnvelope(PERSIST_TMP);
        assert.ok(file, "content-store.json written under the session dir");
        const fresh = getSession(session.id);
        const loaded = contentStoreOf(fresh);
        assert.equal(loaded.byRef[ref]!.rawId, "t-res");
        assert.equal(loaded.byHash[loaded.byRef[ref]!.hash], BIG_TEXT);

        // rebase reset: store cleared + dirty → file deleted
        session.contentStore = undefined;
        session.contentStoreDirty = true;
        store.flushSync(session);
        assert.equal(findEnvelope(PERSIST_TMP), null, "emptied store deletes the envelope");
    } finally {
        _setStoreForTest(new SessionStore({ enabled: false }));
        rmrf(PERSIST_TMP);
    }
});

test("flushAll retries a dirty content store after a transient write failure", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-ccr-flushall-"));
    const logs: string[] = [];
    const store = new SessionStore({ dir, debounceMs: 60_000, log: (level, msg) => logs.push(`${level}:${msg}`) });
    _setStoreForTest(store);
    try {
        const session = getSession(`ccr-flushall-${Math.random().toString(36).slice(2)}`);
        storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
        adoptContentStore(session, turnWith(ccrConfig()).contentStore);
        assert.ok(store.flushSync(session));
        const file = findEnvelope(dir);
        assert.ok(file, "initial content-store envelope written");

        rmSync(file, { force: true });
        mkdirSync(file);
        adoptContentStore(session, turnTwoResults(ccrConfig()).contentStore);
        assert.ok(session.contentStore?.byRef.m00005, "second turn adds a new stored ref");
        store.scheduleSave(session);
        assert.equal(session.contentStoreDirty, true, "failed content-store write stays dirty for retry");
        assert.ok(logs.some((line) => line.includes("content-store write failed")), "transient write failure was observed");

        rmrf(file);
        await store.flushAll([session]);
        assert.equal(session.contentStoreDirty, false, "graceful flush retries the dirty content store");
        assert.ok(existsSync(file), "content-store envelope is restored once the transient failure clears");
        assert.ok(store.loadContentStore(session)?.byRef.m00005, "retry persists the ref added before the transient failure");
    } finally {
        store.cancelAll();
        _setStoreForTest(new SessionStore({ enabled: false }));
        rmrf(dir);
    }
});

// [#1343] Delivery-lifecycle coverage: every ack→loss path is observable
// (counter + corrective note), never silent. Sessions are in-memory
// (BILI_PERSIST=0); the durable ledger lives in session.metadata.
function seedCCR() {
    const session = getSession(`t-win-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, toolName: "lookup", minToolTokens: 50 });
    adoptContentStore(session, turnWith(ccrConfig()).contentStore);
    const ref = Object.keys(session.contentStore!.byRef)[0]!;
    return { session, ref };
}

// GHSA jc6g v2: executeRetrieve no longer queues — it delivers inline. The
// lifecycle tests below exercise the SURVIVING carrier/ledger/note machinery
// against the legacy state a pre-v2 process could have left behind (an
// in-flight carrier at upgrade time, a ledger entry persisted across a
// restart), seeded directly the way old executeRetrieve did.
function seedLegacyCarrier(session: ReturnType<typeof getSession>, ref: string): void {
    session.pendingRetrievals.push({ ref, tokens: 2100, chars: 63000, queuedAt: Date.now(), ccr: true, injection: { id: `acp_retrieved_${ref}`, role: "user", contentType: "text", text: "legacy queued frame" } });
    session.metadata.ccrUndelivered = [{ ref, tokens: 2100, chars: 63000 }];
}

test("#1343 W1 restart: reload reconciles acked-but-undelivered ledger entries (counted + correctable)", () => {
    const { session, ref } = seedCCR();
    // Legacy pre-v2 state across a restart: the durable ledger survived, the
    // in-memory carrier did not (v2 delivery is the tool result itself).
    session.metadata.ccrUndelivered = [{ ref, tokens: 2100, chars: 63000 }];
    // Production ordering: persist's load arms ccrReconcilePending, then
    // getSession() clears `restored` BEFORE prepare runs the reconcile — so
    // the flag must fire even with restored === false (#1343 review).
    session.ccrReconcilePending = true;
    session.restored = false;
    reconcileReloadedRetrievals(session);
    assert.equal(session.ccrReconcilePending, false, "one-shot: consumed by the first reconcile");
    assert.equal(session.pendingRetrievals.length, 0);
    assert.deepEqual(session.metadata.ccrUndelivered, [], "ledger cleared after reconciliation");
    assert.equal(session.stats.retrieveDropped, 1, "loss counted, not silent");
    const snap = snapshotRetrievalNotes(session);
    const note = renderRetrievalNotes(snap);
    assert.ok(note && note.includes(ref), `corrective names the lost ref: ${note}`);
    assert.equal(snapshotRetrievalNotes(session).length, 1, "snapshot does not consume (#1457)");
    commitRetrievalNotes(session, snap.map((n) => n.id));
    assert.equal(renderRetrievalNotes(snapshotRetrievalNotes(session)), null, "committed notes are gone");
});

test("#1343 W1b restart: a re-retrieved ref with a live carrier is left for normal delivery", () => {
    const { session, ref } = seedCCR();
    seedLegacyCarrier(session, ref); // a live legacy carrier at upgrade time
    session.ccrReconcilePending = true;
    session.restored = false;
    reconcileReloadedRetrievals(session);
    assert.equal(session.pendingRetrievals.length, 1, "live carrier survives reconcile");
    assert.equal(session.stats.retrieveDropped, 0, "nothing lost while a carrier exists");
});

test("#1343 W2 post-drain failure: snapshot keeps items until drop; failure is dropped-and-logged (never vanishes)", () => {
    const { session, ref } = seedCCR();
    seedLegacyCarrier(session, ref);
    const attached = snapshotPendingRetrievals(session);
    assert.equal(attached.length, 1);
    assert.equal(session.pendingRetrievals.length, 1, "snapshot does not remove");
    dropRetrievals(session, attached.map((i) => i.ref), "upstream network failure");
    assert.equal(session.pendingRetrievals.length, 0);
    assert.deepEqual(session.metadata.ccrUndelivered, []);
    assert.equal(session.stats.retrieveDropped, 1);
    assert.ok((renderRetrievalNotes(snapshotRetrievalNotes(session)) ?? "").includes(ref));
    dropRetrievals(session, [ref], "upstream network failure");
    assert.equal(session.stats.retrieveDropped, 1, "idempotent: no double-count");
});

test("#1343 W3 disarm: pending deliveries terminate observably; no stale flush after re-arm", () => {
    const { session, ref } = seedCCR();
    seedLegacyCarrier(session, ref);
    assert.equal(session.pendingRetrievals.length, 1);
    storeEffectiveCcr(session, undefined);
    assert.equal(session.pendingRetrievals.length, 0, "carrier terminated");
    assert.deepEqual(session.metadata.ccrUndelivered, []);
    assert.equal(session.stats.retrieveDropped, 1);
    assert.ok((renderRetrievalNotes(snapshotRetrievalNotes(session)) ?? "").includes("disarmed"));
    storeEffectiveCcr(session, { enabled: true, toolName: "lookup", minToolTokens: 50 });
    assert.equal(snapshotPendingRetrievals(session).length, 0, "no stale injection after re-arm (#1273)");
});

test("#1343 W4 TTL: an old queued retrieval expires loudly; range-restore riders are exempt", () => {
    const { session, ref } = seedCCR();
    seedLegacyCarrier(session, ref);
    session.pendingRetrievals[0]!.queuedAt = Date.now() - 11 * 60 * 1000;
    session.pendingRetrievals.push({ ref: "range_b0_1-2", tokens: 0, chars: 10, queuedAt: Date.now() - 99 * 60 * 1000, ccr: false, injection: { id: "acp_range_x", role: "system", contentType: "text", text: "restored" } });
    pruneExpiredRetrievals(session);
    assert.equal(session.pendingRetrievals.length, 1, "only the expired CCR item dropped");
    assert.equal(session.pendingRetrievals[0]!.ref, "range_b0_1-2", "restore rider survives TTL");
    assert.equal(session.stats.retrieveDropped, 1, "only CCR counted");
    const note = renderRetrievalNotes(snapshotRetrievalNotes(session));
    assert.ok(note && note.includes(ref));
    assert.ok(!note!.includes("range_b0"), "exempt restore rider produces no note");
});

test("#1343 two-riders: commit counts only CCR; range-restore riders are removed but uncounted", () => {
    const { session, ref } = seedCCR();
    executeRetrieve({ ref }, session);
    session.pendingRetrievals.push({ ref: "range_b0_3-4", tokens: 0, chars: 5, queuedAt: Date.now(), ccr: false, injection: { id: "acp_range_y", role: "system", contentType: "text", text: "restored" } });
    commitRetrievals(session, [ref, "range_b0_3-4"]);
    assert.equal(session.stats.retrieveDelivered, 1, "restore rider not counted as a delivery");
    assert.equal(session.pendingRetrievals.length, 0, "both carriers removed at outcome");
});

test("#1343 proxy lane: drain still settles legacy carriers (delivered); a v2 retrieve settles inline", () => {
    const { session, ref } = seedCCR();
    seedLegacyCarrier(session, ref);
    const injections = drainPendingRetrievals(session);
    assert.equal(injections.length, 1, "legacy carrier drains on the proxy lane");
    assert.equal(injections[0]!.id, `acp_retrieved_${ref}`);
    assert.equal(session.stats.retrieveDelivered, 1, "proxy drain commits as delivered");
    assert.equal(session.stats.retrieveDropped, 0);
    assert.equal(drainPendingRetrievals(session).length, 0);
    // v2: a fresh retrieve is delivered by the tool result alone — no drain needed
    const out = executeRetrieve({ ref }, session);
    assert.ok(out.includes(BIG_TEXT.slice(0, 80)), "v2 tool result carries the original");
    assert.equal(session.stats.retrieveDelivered, 2, "inline retrieve counts as delivered immediately");
    assert.equal(session.pendingRetrievals.length, 0, "v2 retrieve queues nothing");
});

// ---- [#1457] corrective-note lifecycle: snapshot → attach → commit-on-2xx ----

test("#1457 drop buffers an id'd persistent note; snapshot renders without consuming", () => {
    const { session, ref } = seedCCR();
    seedLegacyCarrier(session, ref);
    const attached = snapshotPendingRetrievals(session);
    assert.equal(attached.length, 1);
    dropRetrievals(session, attached.map((i) => i.ref), "upstream network failure");
    const notes = session.metadata.ccrDropNotes as Array<{ id: string; refs: string[]; reason: string; createdAt: number }>;
    assert.equal(notes.length, 1, "one persistent correction note per loss event");
    assert.ok(typeof notes[0]!.id === "string" && notes[0]!.id.length > 0, "stable id assigned once at creation");
    assert.deepEqual(notes[0]!.refs, [ref]);
    assert.equal(notes[0]!.reason, "upstream network failure");
    assert.equal(typeof notes[0]!.createdAt, "number");

    const s1 = snapshotRetrievalNotes(session);
    const s2 = snapshotRetrievalNotes(session);
    assert.equal(s1.length, 1);
    assert.equal(s2.length, 1, "repeated snapshots do not consume");
    assert.equal(s2[0]!.id, s1[0]!.id, "same id across snapshots (stable across retries/restarts)");

    const text = renderRetrievalNotes(s1)!;
    assert.ok(text.includes(ref));
    assert.ok(text.includes("NOT delivered"));
    assert.ok(text.includes("Re-issue acp_retrieve"));
});

test("#1457 failed request keeps the note pending; next success delivers it exactly once", () => {
    const { session, ref } = seedCCR();
    seedLegacyCarrier(session, ref);
    dropRetrievals(session, snapshotPendingRetrievals(session).map((i) => i.ref), "upstream HTTP 503");

    // Request A attaches the note but upstream rejects → NO commit.
    const snapA = snapshotRetrievalNotes(session);
    assert.equal(snapA.length, 1);
    assert.equal(snapshotRetrievalNotes(session).length, 1, "note still pending after the failed request");

    // Request B re-carries the SAME note; upstream accepts → commit.
    const snapB = snapshotRetrievalNotes(session);
    assert.equal(snapB[0]!.id, snapA[0]!.id, "the re-carried note keeps its identity");
    commitRetrievalNotes(session, snapB.map((n) => n.id));
    assert.equal(renderRetrievalNotes(snapshotRetrievalNotes(session)), null, "delivered once, then gone");
    assert.equal(session.stats.retrieveDropped, 1, "note lifecycle never re-counts the loss");
    assert.equal(session.stats.retrieveDelivered ?? 0, 0, "a correction is not a delivery");
});

test("#1457 concurrency: committing a stale snapshot cannot remove notes created later", () => {
    const session = getSession(`t-conc-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, toolName: "lookup", minToolTokens: 50 });
    adoptContentStore(session, turnTwoResults(ccrConfig()).contentStore);
    const [ref, ref2] = Object.keys(contentStoreOf(session).byRef).sort();
    assert.notEqual(ref2, ref, "two distinct oversized results ⇒ two distinct refs");

    // Loss event A → note A; request A snapshots it while still in flight…
    seedLegacyCarrier(session, ref);
    dropRetrievals(session, [ref], "upstream network failure");
    const stale = snapshotRetrievalNotes(session);
    assert.equal(stale.length, 1);
    // …and loss event B lands before request A settles.
    seedLegacyCarrier(session, ref2!);
    dropRetrievals(session, [ref2!], "upstream HTTP 500");
    const current = snapshotRetrievalNotes(session);
    assert.equal(current.length, 2);
    assert.notEqual(current[1]!.id, stale[0]!.id);

    commitRetrievalNotes(session, stale.map((n) => n.id));
    const after = snapshotRetrievalNotes(session);
    assert.equal(after.length, 1, "only the committed note removed");
    assert.equal(after[0]!.id, current[1]!.id, "later note untouched by the stale commit");
    commitRetrievalNotes(session, stale.map((n) => n.id));
    assert.equal(snapshotRetrievalNotes(session).length, 1, "double-commit is a no-op");
    commitRetrievalNotes(session, []);
    assert.equal(snapshotRetrievalNotes(session).length, 1, "empty id set is a no-op");
});

test("#1457 cap: the note buffer is bounded; oldest evicted first", () => {
    const { session, ref } = seedCCR();
    const filler: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 64; i++) filler.push({ refs: [`m999${String(i).padStart(2, "0")}`], reason: "legacy filler" });
    session.metadata.ccrDropNotes = filler;
    seedLegacyCarrier(session, ref);
    dropRetrievals(session, snapshotPendingRetrievals(session).map((i) => i.ref), "upstream HTTP 500");
    const notes = session.metadata.ccrDropNotes as Array<{ refs: string[] }>;
    assert.equal(notes.length, 64, "buffer stays bounded at the cap");
    assert.ok(!notes.some((n) => n.refs[0] === "m99900"), "oldest evicted first");
    assert.ok(notes.some((n) => n.refs[0] === "m99963"), "newest filler kept");
    assert.ok(notes.some((n) => n.refs[0] === ref), "fresh note kept");
});

test("#1457 legacy pre-fix notes (no id) ride the same path and clear on first confirmed delivery", () => {
    const { session } = seedCCR();
    session.metadata.ccrDropNotes = [{ refs: ["m00100"], reason: "persisted before ids existed" }];
    const snap = snapshotRetrievalNotes(session);
    assert.equal(snap.length, 1);
    assert.equal(snap[0]!.id, "", "missing id normalizes to ''");
    assert.ok(renderRetrievalNotes(snap)!.includes("m00100"));
    commitRetrievalNotes(session, snap.map((n) => n.id));
    assert.equal(renderRetrievalNotes(snapshotRetrievalNotes(session)), null, "legacy note clears on first confirmed delivery");
});

test("#1457 notes survive a restart (metadata round-trip through the session envelope)", () => {
    const store = new SessionStore({ dir: PERSIST_TMP, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        const session = getSession(`ccr-note-${Math.random().toString(36).slice(2)}`);
        storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
        adoptContentStore(session, turnWith(ccrConfig()).contentStore);
        const ref = Object.keys(session.contentStore!.byRef)[0]!;
        seedLegacyCarrier(session, ref);
        dropRetrievals(session, snapshotPendingRetrievals(session).map((i) => i.ref), "upstream network failure");
        const before = snapshotRetrievalNotes(session);
        assert.equal(before.length, 1);
        store.flushSync(session);

        const reloaded = getSession(session.id);
        const after = snapshotRetrievalNotes(reloaded);
        assert.equal(after.length, 1, "note survives the reload");
        assert.equal(after[0]!.id, before[0]!.id, "stable id survives the restart");
        assert.ok(renderRetrievalNotes(after)!.includes(ref));
    } finally {
        _setStoreForTest(new SessionStore({ enabled: false }));
    }
});

function findEnvelope(root: string): string | null {
    for (const d of readdirSync(root)) {
        const p = path.join(root, d);
        if (!statSync(p).isDirectory()) continue;
        for (const f of readdirSync(p)) {
            if (f.endsWith(".content-store.json")) return path.join(p, f);
        }
    }
    return null;
}
