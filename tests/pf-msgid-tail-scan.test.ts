// #5654 watermark fastpath — tail-limited structural scan on the id lane.
//
// The per-round cost of the #5403/#5418 watermark judgment was a full
// per-element walk of the ENTIRE resent history. On the id lane (a
// shape-valid x-bili-pf-tail-ids list whose width matches the server ledger)
// the walk now RESUMES at the seed's tail anchor: only the head region
// (re-verified fresh each turn), the new tail and the top-level fields are
// touched. Pinned here in BOTH directions (#3617 gate discipline):
//   POSITIVE — steady-state id-lane turns walk HEAD_CHECK_ELEMENTS + tail
//   elements (counter-pinned constant while T grows), verdicts stay plain
//   hits, and the hit view stays byte-for-byte the legacy full-parse oracle.
//   NEGATIVE — every lane outside the id lane keeps the FULL walk
//   byte-for-byte (pure count turns, unseeded first turns, zero-delta turns,
//   wrong-width lists), and detectable prefix damage still MISSES — never
//   hits — with the fallback full scan running.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { openaiToCore } from "acp-kernel/wire";
import {
    evaluateWatermarkFastpath, finalizeWatermarkTurn, pfMsgidTailScanLimit, watermarkDebugState,
    PF_COUNT_HEADER, PF_SEQ_HEADER, PF_TAIL_IDS_HEADER,
} from "../src/server/fastpath.ts";
import {
    scanMessagesSpans, scanMessagesSpansLimited, fastpathScannedElements, resetFastpathScannedElements,
} from "../src/server/fastpath-scan.ts";
import { stripRawStage } from "../src/marker/engine.ts";
import { _setStoreForTest, _resetStoreForTest, type SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";

process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK = "1";

const LOGS: string[] = [];
const log = (level: string, msg: string): void => { LOGS.push(`${level} ${msg}`); };

const SYS = (t: string) => ({ role: "system", content: t });
const USR = (t: string) => ({ role: "user", content: t });
const ASST = (t: string) => ({ role: "assistant", content: t });

const bodyOf = (messages: unknown[], model = "m1"): string =>
    JSON.stringify({ model, stream: false, messages });

const headersOf = (h: Record<string, string>): http.IncomingMessage =>
    ({ headers: h }) as unknown as http.IncomingMessage;

const freshSession = (id: string): Session => ({ id }) as unknown as Session;

interface StubStore { ext: Map<string, unknown> }
const makeStubStore = (): StubStore => {
    const ext = new Map<string, unknown>();
    _setStoreForTest({
        closeQuietly: (): void => {},
        replicasAvailable: (): boolean => true,
        getSessionExt: (sid: string, k: string): unknown => ext.get(`${sid}\u0000${k}`),
        setSessionExt: (sid: string, k: string, v: unknown): void => { void ext.set(`${sid}\u0000${k}`, v); },
    } as unknown as SessionStore);
    return { ext };
};

/** Drive one full turn through evaluate + finalize exactly the way
 * prepareOpenai does, capturing the verdict, response headers and the number
 * of messages elements the structural scan WALKED this turn (the #5654 cost
 * metric — successful walks only; failed resume attempts count nothing). */
const runTurn = (
    session: Session,
    reqHeaders: Record<string, string>,
    bodyText: string,
): { out: ReturnType<typeof evaluateWatermarkFastpath>; headers: Record<string, string>; walked: number } => {
    const model = JSON.parse(bodyText).model as string;
    resetFastpathScannedElements();
    const out = evaluateWatermarkFastpath(bodyText, headersOf(reqHeaders), session, { pluginMode: true, titleGen: false, model }, log);
    const oracle = openaiToCore(JSON.parse(bodyText));
    const stripCounts = stripRawStage(JSON.parse(bodyText), "openai");
    const headers = finalizeWatermarkTurn(session, out, {
        model,
        legacyCores: out.hit !== null ? out.hit.view : oracle.msgs,
        rawSystemText: out.hit !== null ? out.hit.systemText : oracle.systemText,
        turnStripCounts: stripCounts,
    });
    return { out, headers, walked: fastpathScannedElements() };
};

/** FNV-1a of the element bytes — hermetic stand-in for host-minted msgids
 * (same message ⇒ same id), mirroring tests/issue5403-watermark-fastpath. */
const idOf = (el: unknown): string => {
    const s = JSON.stringify(el);
    let h = 0x811c9dc5;
    for (let k = 0; k < s.length; k++) {
        h ^= s.charCodeAt(k);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `eid-${h.toString(16)}`;
};

const TAIL = (ids: string[]): Record<string, string> => ({ [PF_TAIL_IDS_HEADER]: ids.map(encodeURIComponent).join(",") });

// ---------------------------------------------------------------------------
// Scanner unit level
// ---------------------------------------------------------------------------

function buildFixture(n: number): { body: string; elems: string[]; starts: number[] } {
    const elems = Array.from({ length: n }, (_, k) =>
        JSON.stringify({ role: k % 2 === 0 ? "user" : "assistant", content: `m${k}-payload-${"x".repeat(8)}` }));
    const prefix = '{"model":"m1","messages":[';
    const body = `${prefix}${elems.join(",")}],"stream":false}`;
    const starts: number[] = [];
    let off = prefix.length;
    for (const e of elems) { starts.push(off); off += e.length + 1; }
    return { body, elems, starts };
}

test("scanner: full-scan parity is unchanged by the refactor", () => {
    const f = buildFixture(20);
    const res = scanMessagesSpans(f.body, "all");
    assert(res !== null, "fixture must scan");
    assert.equal(res.total, 20);
    for (let k = 0; k < 20; k++) {
        assert.equal(f.body.slice(res.messageSpans[k]!.start, res.messageSpans[k]!.end), f.elems[k], `span @${k}`);
    }
    for (const key of ["model", "messages", "stream"]) assert.ok(res.fieldSpans.has(key), `field ${key}`);
});

test("scanner: limited scan collects the head region + post-anchor tail only", () => {
    const f = buildFixture(20);
    const full = scanMessagesSpans(f.body, "all")!;
    // anchor on the LAST element: tail region is just that element
    const last = scanMessagesSpansLimited(f.body, "all", { headLimit: 8, resumeAt: f.starts[19]! })!;
    assert.deepEqual(last.headSpans, full.messageSpans.slice(0, 8));
    assert.deepEqual(last.tailSpans, full.messageSpans.slice(19));
    assert.equal(last.tailCount, 1);
    // anchor mid-history: tail region is elements 12..19
    const mid = scanMessagesSpansLimited(f.body, "all", { headLimit: 8, resumeAt: f.starts[12]! })!;
    assert.deepEqual(mid.tailSpans, full.messageSpans.slice(12));
    assert.equal(mid.tailCount, 8);
    // field spans stay fully fresh either way
    assert.deepEqual([...last.fieldSpans.entries()], [...full.fieldSpans.entries()]);
});

test("scanner: the walk counter pins the cost drop N -> head+tail", () => {
    const f = buildFixture(20);
    resetFastpathScannedElements();
    scanMessagesSpans(f.body, "all");
    assert.equal(fastpathScannedElements(), 20, "full walk touches every element");
    resetFastpathScannedElements();
    scanMessagesSpansLimited(f.body, "all", { headLimit: 8, resumeAt: f.starts[12]! });
    assert.equal(fastpathScannedElements(), 16, "limited walk touches head 8 + tail 8");
    resetFastpathScannedElements();
    scanMessagesSpansLimited(f.body, "all", { headLimit: 8, resumeAt: f.starts[19]! });
    assert.equal(fastpathScannedElements(), 9, "limited walk touches head 8 + tail 1");
});

test("scanner: ANY resume misalignment fails soft to null", () => {
    const f = buildFixture(20);
    const opts = { headLimit: 8 };
    assert.equal(scanMessagesSpansLimited(f.body, "all", { ...opts, resumeAt: f.starts[19]! + 3 }), null, "mid-string resume");
    assert.equal(scanMessagesSpansLimited(f.body, "all", { ...opts, resumeAt: f.starts[19]! - 1 }), null, "separator resume");
    assert.equal(scanMessagesSpansLimited(f.body, "all", { ...opts, resumeAt: f.starts[4]! }), null, "resume inside the head region");
    assert.equal(scanMessagesSpansLimited(f.body, "all", { ...opts, resumeAt: f.body.length }), null, "resume past EOF");
    const wsDrift = f.body.slice(0, f.starts[19]!) + " " + f.body.slice(f.starts[19]!);
    assert.equal(scanMessagesSpansLimited(wsDrift, "all", { ...opts, resumeAt: f.starts[19]! }), null, "whitespace drift at the anchor");
});

test("scanner: a stale anchor (prefix shrank) fails soft to null", () => {
    const f = buildFixture(20);
    const shrunkElems = [...f.elems.slice(0, 5), ...f.elems.slice(6)];
    const shrunk = `{"model":"m1","messages":[${shrunkElems.join(",")}],"stream":false}`;
    assert.equal(scanMessagesSpans(shrunk, "all")!.total, 19, "sanity: shrank by one");
    assert.equal(scanMessagesSpansLimited(shrunk, "all", { headLimit: 8, resumeAt: f.starts[19]! }), null, "old offset no longer aligns");
});

test("scanner: short arrays cannot satisfy a resume", () => {
    const f5 = buildFixture(5);
    assert.equal(scanMessagesSpansLimited(f5.body, "all", { headLimit: 8, resumeAt: f5.starts[4]! }), null, "array shorter than the head window");
    const f9 = buildFixture(9);
    assert.equal(scanMessagesSpansLimited(f9.body, "all", { headLimit: 8, resumeAt: f9.starts[8]! }), null, "anchor at the exact next boundary leaves no verifiable gap");
});

test("scanner: malformed bodies fail both modes", () => {
    const f = buildFixture(12);
    const truncated = f.body.slice(0, f.body.length - 3);
    assert.equal(scanMessagesSpans(truncated, "all"), null);
    assert.equal(scanMessagesSpansLimited(truncated, "all", { headLimit: 8, resumeAt: f.starts[11]! }), null);
    const rawControl = '{"messages":[{"role":"us\ner"}],"model":"m1"}';
    assert.equal(scanMessagesSpans(rawControl, "all"), null);
    assert.equal(scanMessagesSpansLimited(rawControl, "all", { headLimit: 8, resumeAt: 17 }), null);
});

test("pfMsgidTailScanLimit: only the id lane gets a limit", () => {
    assert.equal(pfMsgidTailScanLimit([], undefined), undefined);
    assert.equal(pfMsgidTailScanLimit(null, 5), undefined, "malformed list");
    assert.equal(pfMsgidTailScanLimit(undefined, 5), undefined, "header absent (pure count mode)");
    assert.equal(pfMsgidTailScanLimit(["a"], 5), undefined, "zero delta keeps the legacy no-progress path");
    assert.equal(pfMsgidTailScanLimit(["a", "b"], 5), 1);
    assert.equal(pfMsgidTailScanLimit(["a", "b", "c"], 10), 2);
    assert.equal(pfMsgidTailScanLimit(["a", "b"], 0), undefined, "unseeded (no countPrev)");
    assert.equal(pfMsgidTailScanLimit(["a", "b"], undefined), undefined);
});

// ---------------------------------------------------------------------------
// Judge integration level (direct evaluate + finalize, oracle = legacy parse)
// ---------------------------------------------------------------------------

/** Full-resend history growth: turn t carries system + (t+1) users + t acks
 * = 2t+2 elements. */
const historyFor = (t: number): unknown[] => {
    const h: unknown[] = [SYS("You are TestBuddy v2.")];
    for (let i = 0; i <= t; i++) {
        h.push(USR(`line-${i}`));
        if (i < t) h.push(ASST(`ack-${i}`));
    }
    return h;
};

const IDLANE_TURNS = 12;

test("id lane: steady-state turns walk head+tail only while verdicts stay hits", () => {
    _resetStoreForTest();
    makeStubStore();
    const session = freshSession("pf-tail-idlane");
    const decisions: string[] = [];
    const walked: number[] = [];
    const stamps: (string | undefined)[] = [];
    let lastHitView: unknown[] | null = null;
    for (let t = 0; t < IDLANE_TURNS; t++) {
        const msgs = historyFor(t);
        const body = bodyOf(msgs);
        const prev = t > 0 ? 2 * (t - 1) + 2 : undefined;
        const headers: Record<string, string> = {};
        if (prev !== undefined) {
            headers[PF_COUNT_HEADER] = String(prev);
            headers[PF_TAIL_IDS_HEADER] = msgs.map(idOf).slice(prev - 1).map(encodeURIComponent).join(",");
        }
        const r = runTurn(session, headers, body);
        decisions.push(r.out.decision);
        walked.push(r.walked);
        stamps.push(r.headers[PF_SEQ_HEADER]);
        if (t === IDLANE_TURNS - 1 && r.out.hit !== null) lastHitView = r.out.hit.view;
    }
    assert.equal(decisions[0], "no-stamp", "first turn unseeded");
    for (let t = 1; t < IDLANE_TURNS; t++) assert.equal(decisions[t], "hit", `turn ${t}: ${LOGS.slice(-6).join("\n")}`);
    // small-history turns: the anchor sits inside the head region -> the
    // limited scan cannot engage and the FULL walk runs (negative direction)
    assert.deepEqual(walked.slice(0, 5), [2, 4, 6, 8, 10], "pre-steady-state turns walk everything");
    // steady state: the walk is CONSTANT (head 8 + tail 3) while T grows
    // 12 -> 24 — the #5654 cost claim, counter-pinned
    assert.deepEqual(walked.slice(5), [11, 11, 11, 11, 11, 11, 11], "steady-state id-lane turns walk head+tail only");
    for (let t = 0; t < IDLANE_TURNS; t++) assert.equal(stamps[t], String(2 * t + 2), `stamp ${t}`);
    // the steady-state (tail-mode) hit view is byte-for-byte the legacy
    // full-parse oracle — ids, wireIndex and texts all included
    assert(lastHitView !== null, "last turn must have hit");
    const lastBody = bodyOf(historyFor(IDLANE_TURNS - 1));
    const oracle = openaiToCore(JSON.parse(lastBody));
    assert.equal(lastHitView.length, oracle.msgs.length);
    for (let i = 0; i < oracle.msgs.length; i++) {
        const o = oracle.msgs[i]!;
        const v = lastHitView[i] as { id: string; text?: unknown; role?: string; wireIndex?: number };
        assert.equal(v.id, o.id, `view id @${i}`);
        assert.equal((v.text ?? "") as string, String(o.text ?? ""), `view text @${i}`);
        assert.equal(v.role, o.role, `view role @${i}`);
        assert.equal(v.wireIndex, o.wireIndex, `view wireIndex @${i}`);
    }
    const dbg = watermarkDebugState(session);
    assert.equal(dbg.seeded, true);
    assert.equal(dbg.stampT, 2 * (IDLANE_TURNS - 1) + 2);
    assert.equal(typeof dbg.tailAnchorStart, "number", "anchor taught into the seed");
});

test("count-only lane: the hash/count lane keeps the full walk byte-for-byte", () => {
    _resetStoreForTest();
    makeStubStore();
    const session = freshSession("pf-tail-countlane");
    for (let t = 0; t < IDLANE_TURNS; t++) {
        const body = bodyOf(historyFor(t));
        const headers: Record<string, string> = {};
        if (t > 0) headers[PF_COUNT_HEADER] = String(2 * (t - 1) + 2);
        const r = runTurn(session, headers, body);
        if (t === 0) assert.equal(r.out.decision, "no-stamp");
        else assert.equal(r.out.decision, "hit", `turn ${t}: ${LOGS.slice(-6).join("\n")}`);
        assert.equal(r.walked, 2 * t + 2, `turn ${t}: pure count mode must walk the whole history`);
    }
});

test("zero-delta turns never enable the limited scan", () => {
    _resetStoreForTest();
    makeStubStore();
    const session = freshSession("pf-tail-zero");
    const b1 = bodyOf([SYS("s"), USR("a")]);
    const r1 = runTurn(session, {}, b1);
    assert.equal(r1.out.decision, "no-stamp");
    // identical resend with a ledger-valid 1-element list: width says "no
    // new elements" -> the legacy no-progress path, full walk, no limit
    const lastId = idOf((JSON.parse(b1).messages as unknown[])[1]!);
    const r2 = runTurn(session, { [PF_COUNT_HEADER]: "2", ...TAIL([lastId]) }, b1);
    assert.equal(r2.out.decision, "no-progress");
    assert.equal(r2.out.creditedMiss, false);
    assert.equal(r2.walked, 2, "zero delta keeps the full-scan semantics");
});

test("detectable prefix damage still misses — full scan runs, no hit", () => {
    _resetStoreForTest();
    makeStubStore();
    const session = freshSession("pf-tail-mutate");
    assert.equal(runTurn(session, {}, bodyOf(historyFor(0))).out.decision, "no-stamp");
    const drive = (t: number, mutate?: (msgs: unknown[]) => void): ReturnType<typeof runTurn> => {
        const msgs = historyFor(t);
        mutate?.(msgs);
        const body = bodyOf(msgs);
        const prev = 2 * (t - 1) + 2;
        const ids = msgs.map(idOf).slice(prev - 1).map(encodeURIComponent).join(",");
        return runTurn(session, { [PF_COUNT_HEADER]: String(prev), ...TAIL(ids.split(",")) }, body);
    };
    for (let t = 1; t <= 4; t++) assert.equal(drive(t).out.decision, "hit", `warmup ${t}`);
    // DELETE a middle element (dsh truncation-class rewrite): the id
    // continuity chain breaks and the stale anchor forces the full walk —
    // the turn MUST miss, never hit
    const m = drive(5, (msgs) => { msgs.splice(3, 1); });
    // With this fixture's near-uniform element sizes the stale anchor
    // realigns onto a LIVE element boundary, so the tail attempt itself
    // succeeds structurally (8 head + 2 tail) and the width cross-check
    // passes (2 == 11-10+1). The turn is STILL caught — uncredited — by the
    // id continuity chain: tailIds[0] names the new tail element, not the
    // stored anchor. The head-8 fresh check plus the id chain are the
    // load-bearing guards; anchor resync is best-effort by design.
    assert.equal(m.out.decision, "tail-ids-prev", LOGS.slice(-6).join("\n"));
    assert.equal(m.out.creditedMiss, false);
    assert.equal(m.out.measuredT, 11, "truthful T despite the damage");
    assert.equal(m.walked, 10, "tail attempt charged (8+2); no fallback walk needed");
    assert.equal(m.headers[PF_SEQ_HEADER], "11", "restamped to truth");
    // a deeper shrink (three middle deletions) takes the body BELOW the
    // watermark: the classic credited "ahead" verdict, full walk, no list can
    // unlock anything here
    const s2 = freshSession("pf-tail-shrink");
    assert.equal(runTurn(s2, {}, bodyOf(historyFor(0))).out.decision, "no-stamp");
    for (let t = 1; t <= 4; t++) {
        const msgs = historyFor(t);
        const prev = 2 * (t - 1) + 2;
        const r = runTurn(s2, { [PF_COUNT_HEADER]: String(prev), ...TAIL(msgs.map(idOf).slice(prev - 1)) }, bodyOf(msgs));
        assert.equal(r.out.decision, "hit", `shrink-warmup ${t}`);
    }
    const shrunken = historyFor(5);
    shrunken.splice(3, 3); // 12 -> 9 elements
    const m2 = runTurn(s2, { [PF_COUNT_HEADER]: "10", ...TAIL(shrunken.map(idOf).slice(9)) }, bodyOf(shrunken));
    assert.equal(m2.out.decision, "ahead", LOGS.slice(-6).join("\n"));
    assert.equal(m2.out.creditedMiss, true);
    assert.equal(m2.walked, 9, "shrunken body fully walked");
});

test("wrong-width id list: full-scan fallback + miss, then one correct turn self-heals into tail mode", () => {
    _resetStoreForTest();
    makeStubStore();
    const session = freshSession("pf-tail-widthoff");
    assert.equal(runTurn(session, {}, bodyOf(historyFor(0))).out.decision, "no-stamp");
    const drive = (t: number, extraIds: string[] = []): ReturnType<typeof runTurn> => {
        const msgs = historyFor(t);
        const body = bodyOf(msgs);
        const prev = 2 * (t - 1) + 2;
        const ids = [...msgs.map(idOf).slice(prev - 1), ...extraIds].map(encodeURIComponent).join(",");
        return runTurn(session, { [PF_COUNT_HEADER]: String(prev), ...TAIL(ids.split(",")) }, body);
    };
    for (let t = 1; t <= 4; t++) assert.equal(drive(t).out.decision, "hit", `warmup ${t}`);
    // list claims 4 elements where the physical tail has 3: the limited scan
    // succeeds structurally but the width cross-check fails -> FULL walk on
    // top of the tail attempt (the counter charges both), honest
    // tail-ids-shape miss, reseed onto truth
    const w = drive(5, ["eid-fake"]);
    assert.equal(w.out.decision, "tail-ids-shape", LOGS.slice(-6).join("\n"));
    assert.equal(w.out.creditedMiss, false);
    assert.equal(w.walked, 23, "tail attempt (8+3) plus full fallback (12)");
    assert.equal(w.headers[PF_SEQ_HEADER], "12");
    // the next correctly-shaped turn re-engages the limited scan
    const healed = drive(6);
    assert.equal(healed.out.decision, "hit", LOGS.slice(-6).join("\n"));
    assert.equal(healed.walked, 11, "self-healed back to head+tail");
});
