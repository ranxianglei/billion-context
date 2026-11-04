// #5403/#5418 watermark fastpath — verdict ladder, seeding, rekeying
// (cluster ordinal + wireIndex seam continuity vs the legacy full-body parse
// oracle), and the breaker. The legacy pipeline is the source of truth in
// every assertion: `openaiToCore(JSON.parse(body))` over the WHOLE body is
// the oracle the stashed-view reconstruction must match.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { openaiToCore, coreToOpenai } from "acp-kernel/wire";
import { evaluateWatermarkFastpath, finalizeWatermarkTurn, clearWatermarkSeed, watermarkDebugState, PF_COUNT_HEADER, PF_SEQ_HEADER, PF_TAIL_IDS_HEADER, PF_SLOT_UNKNOWN } from "../src/server/fastpath.ts";
import { stripRawStage } from "../src/marker/engine.ts";
import { INCREMENTAL_TURN_MARKER_HEADER } from "../src/incremental-lane.ts";
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
const savedKey = (id: string): string => `${id}\u0000pf:state`;
const readSaved = (stub: StubStore, id: string): Record<string, unknown> =>
    JSON.parse(String(stub.ext.get(savedKey(id)))) as Record<string, unknown>;

/** Drive one full turn through evaluate + finalize exactly the way
 * prepareOpenai does, returning verdict and the emitted response headers. */
const runTurn = (
    session: Session,
    reqHeaders: Record<string, string>,
    bodyText: string,
): { out: ReturnType<typeof evaluateWatermarkFastpath>; headers: Record<string, string> } => {
    const model = JSON.parse(bodyText).model as string;
    const out = evaluateWatermarkFastpath(bodyText, headersOf(reqHeaders), session, { pluginMode: true, titleGen: false, model }, log);
    const oracle = openaiToCore(JSON.parse(bodyText));
    const stripCounts = stripRawStage(JSON.parse(bodyText), "openai");
    const headers = finalizeWatermarkTurn(session, out, {
        model,
        legacyCores: out.hit !== null ? out.hit.view : oracle.msgs,
        rawSystemText: out.hit !== null ? out.hit.systemText : oracle.systemText,
        turnStripCounts: stripCounts,
    });
    return { out, headers };
};

test("gate off / title-gen / incremental-turn requests are untouched", () => {
    _resetStoreForTest();
    makeStubStore();
    const session = freshSession("pf-gate");
    const body = bodyOf([SYS("s"), USR("a")]);

    process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK = "0";
    let r = runTurn(session, {}, body);
    assert.equal(r.out.decision, "gate-off");
    assert.equal(r.out.measuredT, undefined);
    assert.deepEqual(r.headers, {});

    // feature on, but this request belongs to the incremental lane
    process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK = "1";
    r = runTurn(session, { [INCREMENTAL_TURN_MARKER_HEADER]: "x" }, body);
    assert.equal(r.out.decision, "gate-off");
    assert.equal(r.out.measuredT, undefined);

    _resetStoreForTest();
});

test("first turn: unseeded miss, measured T, response re-stamps", () => {
    makeStubStore();
    const session = freshSession("pf-first");
    const body = bodyOf([SYS("s"), USR("hi"), USR("yo"), ASST("yo"), USR("tail")]);
    const { out, headers } = runTurn(session, {}, body);
    assert.equal(out.decision, "no-stamp");
    assert.equal(out.creditedMiss, false);
    assert.equal(out.measuredT, 5);
    assert.equal(out.hit, null);
    assert.equal(headers[PF_SEQ_HEADER], "5");
    const dbg = watermarkDebugState(session);
    assert.equal(dbg.seeded, true);
    assert.equal(dbg.stampT, 5);
});

test("hit path reconstructs EXACTLY the legacy full-parse ids/wireIndex/texts (incl. repeated-base cluster ordinals)", () => {
    makeStubStore();
    const session = freshSession("pf-hit");
    const b1 = bodyOf([SYS("s"), USR("hi"), USR("yo"), ASST("ok"), USR("hi")]);
    const t1 = runTurn(session, {}, b1);
    assert.equal(t1.out.decision, "no-stamp");
    // turn 2: same prefix + a NEW "hi" duplicate and one more exchange
    const prefix = [SYS("s"), USR("hi"), USR("yo"), ASST("ok"), USR("hi")];
    const b2 = bodyOf([...prefix, USR("hi"), ASST("again")]);
    const { out, headers } = runTurn(session, { [PF_COUNT_HEADER]: "5" }, b2);
    assert.equal(out.decision, "hit", LOGS.join("\n"));
    assert.ok(out.hit);
    const oracle = openaiToCore(JSON.parse(b2));
    const view = out.hit.view;
    assert.equal(view.length, oracle.msgs.length);
    for (let i = 0; i < oracle.msgs.length; i++) {
        const o = oracle.msgs[i]!;
        const v = view[i]!;
        assert.equal(v.id, o.id, `id @${i}: ${v.id} != ${o.id}`);
        assert.equal(v.text, o.text, `text @${i}`);
        assert.equal(v.role, o.role, `role @${i}`);
        assert.equal((v as { wireIndex?: number }).wireIndex, (o as { wireIndex?: number }).wireIndex, `wireIndex @${i}`);
    }
    assert.equal(out.hit.systemText, oracle.systemText);
    assert.equal(headers[PF_SEQ_HEADER], "7");
    // the repeated base really exercised the ordinal machinery: the last "hi"
    // must carry the _3 suffix (three earlier occurrences across the array).
    const hiIds = view.filter((m) => m.text === "hi").map((m) => m.id);
    assert.equal(hiIds.length, 3);
    assert.equal(new Set(hiIds).size, 3, "cluster ordinals must de-duplicate across the seam");
    assert.ok(/_1$/.test(hiIds[1]!) && /_2$/.test(hiIds[2]!), `ordinal continuation: ${JSON.stringify(hiIds)}`);
});

test("K=1 seam: multi-part window head must NOT merge into the prefix neighbor", () => {
    makeStubStore();
    const session = freshSession("pf-seam");
    const b1 = bodyOf([SYS("s"), USR("only")]);
    const t1 = runTurn(session, {}, b1);
    assert.equal(t1.out.decision, "no-stamp");
    const multipart = { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,x" } }] };
    const b2 = bodyOf([SYS("s"), USR("only"), multipart]);
    const { out } = runTurn(session, { [PF_COUNT_HEADER]: "2" }, b2);
    assert.equal(out.decision, "hit", LOGS.join("\n"));
    assert.ok(out.hit);
    const oracle = openaiToCore(JSON.parse(b2));
    // outbound reconstruction parity — the byte-level consequence
    const rebuiltFast = coreToOpenai(out.hit.view as Parameters<typeof coreToOpenai>[0]);
    const rebuiltOracle = coreToOpenai(oracle.msgs);
    assert.equal(JSON.stringify(rebuiltFast), JSON.stringify(rebuiltOracle));
    assert.equal(rebuiltFast.length, rebuiltOracle.length);
});

test("head-system drift is a CREDITED miss and the next turn recovers", () => {
    makeStubStore();
    const session = freshSession("pf-drift");
    const sys = "the system prompt";
    const b1 = bodyOf([SYS(sys), USR("a"), USR("b")]);
    assert.equal(runTurn(session, {}, b1).out.decision, "no-stamp");
    const b2 = bodyOf([SYS(sys + " CHANGED"), USR("a"), USR("b"), ASST("c")]);
    const { out } = runTurn(session, { [PF_COUNT_HEADER]: "3" }, b2);
    assert.equal(out.decision, "head-drift");
    assert.equal(out.creditedMiss, true);
    // after the miss reseeded from real bytes, a follow-up PAST the watermark hits
    const b3 = bodyOf([SYS(sys + " CHANGED"), USR("a"), USR("b"), ASST("c"), USR("d")]);
    const r3 = runTurn(session, { [PF_COUNT_HEADER]: "4" }, b3);
    assert.equal(r3.out.decision, "hit", LOGS.join("\n"))
});

test("in-place HEAD edit is caught by prefix-core comparison, uncredited, self-heals on reseed", () => {
    makeStubStore();
    const session = freshSession("pf-headedit");
    const b1 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c"), USR("d"), USR("e"), USR("f"), USR("g")]);
    assert.equal(runTurn(session, {}, b1).out.decision, "no-stamp");
    // rewrite element #3 IN PLACE (prefix counts unchanged, system identical, stamp honest)
    // and append one turn — only the per-core prefix comparison can see the rewrite.
    const b2 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c-EDITED"), USR("d"), USR("e"), USR("f"), USR("g"), ASST("h")]);
    const { out } = runTurn(session, { [PF_COUNT_HEADER]: "8" }, b2);
    assert.equal(out.decision, "head-prefix-drift", LOGS.join("\n"));
    assert.equal(out.creditedMiss, false);
    // the missed turn went legacy + reseeded from real bytes; resending the SAME body is no-progress
    const same = runTurn(session, { [PF_COUNT_HEADER]: "9" }, b2);
    assert.equal(same.out.decision, "no-progress");
    // ...and one growth past the fresh watermark HITS with the EDITED bytes, not the stale seed byte
    const b3 = bodyOf([...JSON.parse(b2).messages, USR("i")]);
    const r3 = runTurn(session, { [PF_COUNT_HEADER]: "9" }, b3);
    assert.equal(r3.out.decision, "hit", LOGS.join("\n"));
    const texts = r3.out.hit!.view.map((m) => String((m as { text?: unknown }).text ?? ""));
    assert.ok(texts.some((t) => t.includes("c-EDITED")), "edited content must ride, stale byte must not");
    assert.ok(!texts.some((t) => t.trim() === "c"), "stale pre-edit element must be gone from the view");
});

const TAIL = (ids: string[]): Record<string, string> => ({ [PF_TAIL_IDS_HEADER]: ids.map(encodeURIComponent).join(",") });

test("v4 count relaxation: a ledger-proven tail-id list carries the turn with NO count header", () => {
    makeStubStore();
    const session = freshSession("pf-v4-nocount");
    const b1 = bodyOf([SYS("s"), USR("a"), USR("b")]);
    assert.equal(runTurn(session, {}, b1).out.decision, "no-stamp"); // stampT=3
    const b2 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c")]);
    const h2 = runTurn(session, { ...TAIL(["h-b", "h-c"]) }, b2);
    assert.equal(h2.out.decision, "hit(no-count)", LOGS.join("\n"));
    assert.equal(h2.out.creditedMiss, false);
    // the view must still be byte-for-byte the legacy full-parse oracle
    if (!h2.out.hit) throw new Error("expected hit");
    const oracle = openaiToCore(JSON.parse(b2));
    assert.equal(h2.out.hit.view.length, oracle.msgs.length);
    for (let i = 0; i < oracle.msgs.length; i++) {
        assert.equal(h2.out.hit.view[i]!.id, oracle.msgs[i]!.id, `id @${i}`);
        assert.equal((h2.out.hit.view[i]! as { wireIndex?: number }).wireIndex,
            (oracle.msgs[i]! as { wireIndex?: number }).wireIndex, `wireIndex @${i}`);
    }
    // the restamp taught the client the true total; the next turn echoes it
    // normally and the plain-string decision returns
    const b3 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c"), USR("d")]);
    const h3 = runTurn(session, { [PF_COUNT_HEADER]: "4", ...TAIL(["h-c", "h-d"]) }, b3);
    assert.equal(h3.out.decision, "hit", LOGS.join("\n"));
});

test("v4 count relaxation: desynced echoes (high AND low) degrade to diagnostic, never breaker fuel", () => {
    makeStubStore();
    const session = freshSession("pf-v4-desync");
    const b1 = bodyOf([SYS("s"), USR("a")]);
    assert.equal(runTurn(session, {}, b1).out.decision, "no-stamp"); // stampT=2
    // HIGH desync: the echo exceeds even the CURRENT body size (an older,
    // larger stamp survived a lost response) — pre-v4 this was a CREDITED
    // "ahead" miss; v4 trusts the ledger-proven list instead
    const b2 = bodyOf([SYS("s"), USR("a"), USR("u1")]);
    const h2 = runTurn(session, { [PF_COUNT_HEADER]: "9", ...TAIL(["u-prev", "u-u1"]) }, b2);
    assert.equal(h2.out.decision, "hit(count-off=9)", LOGS.join("\n"));
    assert.equal(h2.out.creditedMiss, false);
    // LOW desync: the echo lags behind the server's own bookkeeping —
    // pre-v4 this was "seed-stale"
    const b3 = bodyOf([SYS("s"), USR("a"), USR("u1"), USR("u2")]);
    const h3 = runTurn(session, { [PF_COUNT_HEADER]: "2", ...TAIL(["u-u1", "u-u2"]) }, b3);
    assert.equal(h3.out.decision, "hit(count-off=2)", LOGS.join("\n"));
    assert.equal(h3.out.creditedMiss, false);
    assert.equal(watermarkDebugState(session).missCount ?? 0, 0, "diagnostic drift must never feed the breaker");
});

test("v4 count relaxation: malformed lists do NOT unlock the relaxation; shrink turns stay caught; zero-delta keeps no-progress", () => {
    makeStubStore();
    const session = freshSession("pf-v4-neg");
    const b1 = bodyOf([SYS("s"), USR("a")]);
    assert.equal(runTurn(session, {}, b1).out.decision, "no-stamp"); // stampT=2
    // malformed header + no count: the pre-v4 ladder runs untouched
    const r1 = runTurn(session, { [PF_TAIL_IDS_HEADER]: "x%zz,x%zz" }, bodyOf([SYS("s"), USR("a"), USR("u1")]));
    assert.equal(r1.out.decision, "no-stamp", LOGS.join("\n"));
    assert.equal(r1.out.creditedMiss, false);
    // destructive prefix SHRINK with a plausible-looking id list: the width
    // arithmetic demands T - stampT + 1 <= 0, so ids cannot prove anything
    // here and the credited ahead verdict fires exactly as pre-v4
    const shrunk = bodyOf([SYS("s"), USR("brand-new-tail")]);
    const r2 = runTurn(session, { [PF_COUNT_HEADER]: "7", ...TAIL(["x", "y"]) }, shrunk);
    assert.equal(r2.out.decision, "ahead", LOGS.join("\n"));
    assert.equal(r2.out.creditedMiss, true);
    // zero delta (T === stampT) with a ledger-valid 1-element list: kept as
    // no-progress — an empty window would pin an empty lastMessages baseline
    const r3 = runTurn(session, { [PF_COUNT_HEADER]: "2", ...TAIL(["solo"]) }, bodyOf([SYS("s"), USR("a")]));
    assert.equal(r3.out.decision, "no-progress", LOGS.join("\n"));
    assert.equal(r3.out.creditedMiss, false);
});

test("tail-ids: prevId chain rides consecutive hits; a broken anchor is uncredited and self-heals", () => {
    makeStubStore();
    const session = freshSession("pf-tailids");
    const b1 = bodyOf([SYS("s"), USR("a"), USR("b")]);
    assert.equal(runTurn(session, {}, b1).out.decision, "no-stamp");
    // seed turn carried no list -> prevId check dormant on the first stamped turn
    const b2 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c")]);
    const h2 = runTurn(session, { [PF_COUNT_HEADER]: "3", ...TAIL(["h-b", "h-c"]) }, b2);
    assert.equal(h2.out.decision, "hit", LOGS.join("\n"));
    assert.deepEqual(h2.out.receivedTailIds, ["h-b", "h-c"]);
    // next turn must open with the list's LAST id — the stored anchor
    const b3 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c"), USR("d")]);
    const h3 = runTurn(session, { [PF_COUNT_HEADER]: "4", ...TAIL(["h-c", "h-d"]) }, b3);
    assert.equal(h3.out.decision, "hit", LOGS.join("\n"));
    // anchor mismatch = legit in-place rewrite of the PREVIOUS TURN's last
    // message (its id minted again): UNcredited, legacy reseed drops the stale
    // anchor, one growth hits again
    const b4 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c"), USR("d-EDITED"), USR("e")]);
    const m4 = runTurn(session, { [PF_COUNT_HEADER]: "5", ...TAIL(["h-dPRIME", "h-e"]) }, b4);
    assert.equal(m4.out.decision, "tail-ids-prev", LOGS.join("\n"));
    assert.equal(m4.out.creditedMiss, false);
    const b5 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c"), USR("d-EDITED"), USR("e"), USR("f")]);
    const h5 = runTurn(session, { [PF_COUNT_HEADER]: "6", ...TAIL(["h-e", "h-f"]) }, b5);
    assert.equal(h5.out.decision, "hit", LOGS.join("\n"));
});

test("tail-ids: wrong length / duplicate / bad segment are UNcredited shape faults (silent degrade)", () => {
    makeStubStore();
    const session = freshSession("pf-tailbad");
    const b1 = bodyOf([SYS("s"), USR("a")]);
    runTurn(session, {}, b1);
    // every verified miss reseeds at its own T, so each fault row must GROW one
    // element — stamped stays last-turn-T while the list length lies again.
    const g = (n: number): string => bodyOf([SYS("s"), USR("a"), ...Array.from({ length: n }, (_, j) => USR(`g${j}`))]);
    const shortList = runTurn(session, { [PF_COUNT_HEADER]: "2", ...TAIL(["only-prev"]) }, g(1));
    assert.equal(shortList.out.decision, "tail-ids-shape", LOGS.join("\n"));
    assert.equal(shortList.out.creditedMiss, false);
    const dup = runTurn(session, { [PF_COUNT_HEADER]: "3", ...TAIL(["x", "x", "x"]) }, g(2));
    assert.equal(dup.out.decision, "tail-ids-shape");
    assert.equal(dup.out.creditedMiss, false);
    const badseg = runTurn(session, { [PF_COUNT_HEADER]: "4", ...{ [PF_TAIL_IDS_HEADER]: "x%zz,x%zz" } }, g(3));
    assert.equal(badseg.out.decision, "tail-ids-shape");
    assert.equal(badseg.out.creditedMiss, false);
    // owner ruling 2026-11-02: shape faults are shim/proxy drift, not a lying
    // client — five consecutive faults must NOT arm the breaker, nothing is
    // credited (the legacy path + restamp self-heal).
    let faultDecision = "";
    for (let i = 4; i <= 7; i++) faultDecision = runTurn(session, { [PF_COUNT_HEADER]: String(i + 1), ...TAIL(["q", "q", "q"]) }, g(i)).out.decision;
    assert.equal(faultDecision, "tail-ids-shape", LOGS.join("\n"));
    assert.equal(watermarkDebugState(session).missCount ?? 0, 0);
}
);

test("tail-ids: '?' unknown slots ride without penalty (owner 2026-11-02)", () => {
    makeStubStore();
    const session = freshSession("pf-slotunk");
    const U = PF_SLOT_UNKNOWN; // "?" — TAIL() percent-encodes it (%3F on the wire), decode restores
    const b1 = bodyOf([SYS("s"), USR("a"), USR("b")]);
    assert.equal(runTurn(session, {}, b1).out.decision, "no-stamp");
    const b2 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c")]);
    assert.equal(runTurn(session, { [PF_COUNT_HEADER]: "3", ...TAIL(["h-b", "h-c"]) }, b2).out.decision, "hit", LOGS.join("\n"));
    // unknown anchor = NO identity claim, NOT a fault: the stored prevId
    // ("h-c") cannot be verified against "?", so the byte-level head check
    // alone decides — matching prefix still HITS
    const b3 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c"), USR("d")]);
    const r3 = runTurn(session, { [PF_COUNT_HEADER]: "4", ...TAIL([U, "h-d"]) }, b3);
    assert.equal(r3.out.decision, "hit", LOGS.join("\n"));
    assert.deepEqual(r3.out.receivedTailIds, [PF_SLOT_UNKNOWN, "h-d"]);
    // interior unknown slots are fine too
    const b4 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c"), USR("d"), USR("e")]);
    const r4 = runTurn(session, { [PF_COUNT_HEADER]: "5", ...TAIL(["h-d", U]) }, b4);
    assert.equal(r4.out.decision, "hit", LOGS.join("\n"));
    // an ALL-unknown tail is tolerated as well (unknown anchor verifies no one)
    const b5 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c"), USR("d"), USR("e"), USR("f")]);
    const r5 = runTurn(session, { [PF_COUNT_HEADER]: "6", ...TAIL([U, U]) }, b5);
    assert.equal(r5.out.decision, "hit", LOGS.join("\n"));
    assert.deepEqual(r5.out.receivedTailIds, [PF_SLOT_UNKNOWN, PF_SLOT_UNKNOWN]);
}
);

test("tail-ids: comma inside an id survives the wire form", () => {
    makeStubStore();
    const session = freshSession("pf-tailcomma");
    const b1 = bodyOf([SYS("s"), USR("a")]);
    runTurn(session, {}, b1);
    const b2 = bodyOf([SYS("s"), USR("a"), USR("b")]);
    const h2 = runTurn(session, { [PF_COUNT_HEADER]: "2", ...TAIL(["pre,v1", "new,id"]) }, b2);
    assert.equal(h2.out.decision, "hit", LOGS.join("\n"));
    assert.deepEqual(h2.out.receivedTailIds, ["pre,v1", "new,id"]);
    // continuity through a comma-bearing anchor
    const b3 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c")]);
    const h3 = runTurn(session, { [PF_COUNT_HEADER]: "3", ...TAIL(["new,id", "c"]) }, b3);
    assert.equal(h3.out.decision, "hit", LOGS.join("\n"));
});

test("system element appearing at the WINDOW head degrades (hoist hazard)", () => {
    makeStubStore();
    const session = freshSession("pf-hoist");
    const b1 = bodyOf([SYS("s"), USR("a")]);
    runTurn(session, {}, b1);
    const b2 = bodyOf([SYS("s"), USR("a"), SYS("mid"), USR("b")]);
    const { out } = runTurn(session, { [PF_COUNT_HEADER]: "2" }, b2);
    assert.equal(out.decision, "window-system-head");
    assert.equal(out.creditedMiss, true);
});

test("no-progress (stamp == T) is uncredited but re-stamps", () => {
    makeStubStore();
    const session = freshSession("pf-noprog");
    const b1 = bodyOf([SYS("s"), USR("a")]);
    const t1 = runTurn(session, {}, b1);
    assert.equal(t1.headers[PF_SEQ_HEADER], "2");
    const { out, headers } = runTurn(session, { [PF_COUNT_HEADER]: "2" }, b1);
    assert.equal(out.decision, "no-progress");
    assert.equal(out.creditedMiss, false);
    assert.equal(headers[PF_SEQ_HEADER], "2");
});

test("count ahead of reality is credited; five consecutive verified misses arm the breaker for one hour", () => {
    const stub = makeStubStore();
    const session = freshSession("pf-breaker");
    const b1 = bodyOf([SYS("s"), USR("a")]);
    runTurn(session, {}, b1);
    const shrunk = bodyOf([SYS("s"), USR("a")].slice(0, 1)); // client dropped history
    for (let i = 0; i < 5; i++) {
        const { out, headers } = runTurn(session, { [PF_COUNT_HEADER]: "77" }, shrunk);
        assert.equal(out.decision, "ahead");
        assert.equal(out.creditedMiss, true);
        assert.equal(headers[PF_SEQ_HEADER], "1");
    }
    const saved = readSaved(stub, "pf-breaker");
    assert.equal(typeof saved.disabledAt, "number");
    // held turns take NO hit but keep measuring and restamping — otherwise
    // the client's stale watermark could never converge and the hold would
    // re-arm forever (the loop the unit pins)
    const held = runTurn(session, { [PF_COUNT_HEADER]: "77" }, shrunk);
    assert.equal(held.out.decision, "breaker-armed");
    assert.equal(held.out.measuredT, 1);
    assert.equal(held.headers[PF_SEQ_HEADER], "1", "held lane keeps teaching truth");
    // client has learned T=1; after the TTL expires verification resumes and
    // an identical resend is a plain no-progress (no re-arm either way)
    stub.ext.set(savedKey("pf-breaker"), JSON.stringify({ ...saved, disabledAt: Date.now() - 61 * 60 * 1000 }));
    const after = runTurn(session, { [PF_COUNT_HEADER]: "1" }, shrunk);
    assert.equal(after.out.decision, "no-progress");
    assert.equal(after.out.creditedMiss, false);
    // and if growth resumes past the stale-watermark, ONE uncredited
    // seed-stale round re-keys the seed onto the new reality (its own real
    // bytes), then the same-shaped next turn hits
    const grew = runTurn(session, { [PF_COUNT_HEADER]: "1" }, bodyOf([SYS("s"), USR("back")]));
    assert.equal(grew.out.decision, "seed-stale");
    assert.equal(grew.out.creditedMiss, false);
    const again = runTurn(session, { [PF_COUNT_HEADER]: "2" }, bodyOf([SYS("s"), USR("back"), USR("more")]));
    assert.equal(again.out.decision, "hit", LOGS.join("\n"));
});

test("model switch and stale watermark are uncredited misses that converge in one turn", () => {
    makeStubStore();
    const session = freshSession("pf-model");
    const b1 = bodyOf([SYS("s"), USR("a")], "m-one");
    runTurn(session, {}, b1);
    const b2otherModel = bodyOf([SYS("s"), USR("a"), USR("b")], "m-two");
    const r = runTurn(session, { [PF_COUNT_HEADER]: "2" }, b2otherModel);
    assert.equal(r.out.decision, "seed-stale");
    assert.equal(r.out.creditedMiss, false);
    // seed was re-keyed under m-two with the measured T (3): an IDENTICAL
    // resend is a no-progress verification (nothing new to trust yet); once
    // the conversation grows past the watermark the re-keyed seed pays off
    const same = runTurn(session, { [PF_COUNT_HEADER]: "3" }, b2otherModel);
    assert.equal(same.out.decision, "no-progress");
    const grew = runTurn(session, { [PF_COUNT_HEADER]: "3" }, bodyOf([SYS("s"), USR("a"), USR("b"), USR("c")], "m-two"));
    assert.equal(grew.out.decision, "hit", LOGS.join("\n"));
});

test("garbage stamp header and unscannable body degrade without credit", () => {
    makeStubStore();
    const session = freshSession("pf-garbage");
    const b1 = bodyOf([SYS("s"), USR("a")]);
    runTurn(session, {}, b1);
    const r1 = runTurn(session, { [PF_COUNT_HEADER]: "abc" }, b1 + "");
    assert.equal(r1.out.decision, "no-stamp");
    assert.equal(r1.out.creditedMiss, false);

    // valid JSON far beyond the scanner's depth cap (1024): JSON.parse
    // accepts it, the structural walk refuses -> legacy path, no T measured
    const deep = '{' + '"messages":' + "[".repeat(1101) + "]".repeat(1101) + '}';
    const r2 = runTurn(session, { [PF_COUNT_HEADER]: "2" }, deep);
    assert.equal(r2.out.decision, "scan-broken");
    assert.equal(r2.out.measuredT, undefined);

});

test("clearWatermarkSeed forces the next turn back through verification", () => {
    makeStubStore();
    const session = freshSession("pf-clear");
    const b1 = bodyOf([SYS("s"), USR("a"), USR("b")]);
    runTurn(session, {}, b1);
    clearWatermarkSeed(session);
    const b2 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c")]);
    const { out } = runTurn(session, { [PF_COUNT_HEADER]: "3" }, b2);
    assert.equal(out.decision, "unseeded");
});

// #5576 review round-1 (V1/V3, 2026-11-04): the v5 lane is the only LIVE
// identity lane today, so its #3617 bidirectionality matrix and the R7
// sess-change gate get their positive-direction lines HERE — they previously
// existed only inside the canonical/msgid lanes.

test("v5 #3617 matrix: id-mode stable-id edit RIDES with a warn (stale byte outbound); count-only same edit is GATED", () => {
    // A) id mode: identity chain intact ⇒ hit; stashed cores ride OUTBOUND —
    //    the pre-edit byte is served, the edit is diagnostic-only (owner
    //    ruling 2026-11-03; feeds M3 re-seeding signals).
    makeStubStore();
    const sA = freshSession("pf-v5-ride");
    assert.equal(runTurn(sA, {}, bodyOf([SYS("s"), USR("a"), USR("b")])).out.decision, "no-stamp");
    const bA2 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c")]);
    assert.equal(runTurn(sA, { [PF_COUNT_HEADER]: "3", ...TAIL(["h-b", "h-c"]) }, bA2).out.decision, "hit");
    const LOGS_AT = LOGS.length;
    // client rewrites element `b` IN PLACE while its host id stays `h-b`
    const bA3 = bodyOf([SYS("s"), USR("a"), USR("b-EDITED"), USR("c"), ASST("d")]);
    const rA = runTurn(sA, { [PF_COUNT_HEADER]: "4", ...TAIL(["h-c", "h-d"]) }, bA3);
    assert.equal(rA.out.decision, "hit", LOGS.join("\n"));
    assert.ok(LOGS.slice(LOGS_AT).some((l) => l.includes("riding the stashed prefix")),
        "id-mode head drift must log the diagnostic ride line");
    const textsA = rA.out.hit!.view.map((m) => String((m as { text?: unknown }).text ?? ""));
    assert.ok(textsA.includes("b"), "stale core byte rides outbound under id mode");
    assert.ok(!textsA.includes("b-EDITED"), "the edit must NOT be served from this lane");
    // B) count-only parallel: SAME bytes without an id list stay byte-gated —
    //    rewrite detected, uncredited miss, self-heal reseed (paired direction).
    makeStubStore();
    const sB = freshSession("pf-v5-gate");
    assert.equal(runTurn(sB, {}, bodyOf([SYS("s"), USR("a"), USR("b")])).out.decision, "no-stamp");
    assert.equal(runTurn(sB, { [PF_COUNT_HEADER]: "3" }, bA2).out.decision, "hit");
    const mB = runTurn(sB, { [PF_COUNT_HEADER]: "4" }, bA3);
    assert.equal(mB.out.decision, "head-prefix-drift", LOGS.join("\n"));
    assert.equal(mB.out.creditedMiss, false);
});

test("v5 R7 port: sess-change on the DEFAULT lane — swap is an event, same carrier silent, absent carrier never one", () => {
    const stub = makeStubStore();
    const s1 = freshSession("pf-r7-swap");
    assert.equal(runTurn(s1, {}, bodyOf([SYS("s"), USR("a"), USR("b")])).out.decision, "no-stamp");
    const h = { "x-conversation-id": "conv-A" };
    assert.equal(runTurn(s1, { [PF_COUNT_HEADER]: "3", ...TAIL(["h-b", "h-c"]), ...h },
        bodyOf([SYS("s"), USR("a"), USR("b"), USR("c")])).out.decision, "hit");
    assert.equal(typeof readSaved(stub, s1.id).cs, "string", "first claimed carrier persists as cs digest");
    // same carrier on the next turn = non-event
    assert.equal(runTurn(s1, { [PF_COUNT_HEADER]: "4", ...TAIL(["h-c", "h-d"]), ...h },
        bodyOf([SYS("s"), USR("a"), USR("b"), USR("c"), ASST("d")])).out.decision, "hit");
    // swapped carrier = identity EVENT (uncredited, legacy + reseed)
    const swapped = runTurn(s1, { [PF_COUNT_HEADER]: "5", ...TAIL(["h-d", "h-e"]), "x-conversation-id": "conv-B" },
        bodyOf([SYS("s"), USR("a"), USR("b"), USR("c"), ASST("d"), USR("e")]));
    assert.equal(swapped.out.decision, "sess-change", LOGS.join("\n"));
    assert.equal(swapped.out.creditedMiss, false);
    // identity follows traffic: growth under the NEW carrier rides again
    assert.equal(runTurn(s1, { [PF_COUNT_HEADER]: "6", ...TAIL(["h-e", "h-f"]), "x-conversation-id": "conv-B" },
        bodyOf([SYS("s"), USR("a"), USR("b"), USR("c"), ASST("d"), USR("e"), USR("f")])).out.decision, "hit");
    // neutral: state that never claimed a carrier never fires, even late
    makeStubStore();
    const s2 = freshSession("pf-r7-neutral");
    assert.equal(runTurn(s2, {}, bodyOf([SYS("s"), USR("a"), USR("b")])).out.decision, "no-stamp");
    assert.equal(runTurn(s2, { [PF_COUNT_HEADER]: "3", ...TAIL(["h-b", "h-c"]) },
        bodyOf([SYS("s"), USR("a"), USR("b"), USR("c")])).out.decision, "hit");
    assert.equal(runTurn(s2, { [PF_COUNT_HEADER]: "4", ...TAIL(["h-c", "h-d"]), "x-conversation-id": "late-joiner" },
        bodyOf([SYS("s"), USR("a"), USR("b"), USR("c"), ASST("d")])).out.decision, "hit",
        "carrier appearing where none was stored must be neutral (first claim, not a change)");
});

test("v5 drift-ride lifetime cap: after 5 consecutive ride turns one UNcredited reseed forces the edit into the seed (review V1)", () => {
    makeStubStore();
    const session = freshSession("pf-v1-cap");
    const b1 = bodyOf([SYS("s"), USR("a"), USR("b"), USR("c")]);
    assert.equal(runTurn(session, {}, b1).out.decision, "no-stamp");
    // Rewrite element #2 IN PLACE with stable host ids + an honest count:
    // id mode demotes the byte check to a diagnostic — the STALE byte rides.
    let msgs = [SYS("s"), USR("a"), USR("b-EDITED"), USR("c"), ASST("d")];
    let r = runTurn(session, { [PF_COUNT_HEADER]: "4", ...TAIL(["h-c", "h-d"]) }, bodyOf(msgs));
    assert.equal(r.out.decision, "hit", LOGS.join("\n"));
    assert.equal(r.out.creditedMiss, false);
    assert.equal(r.out.driftRides, 1, "the first drift turn rides and counts itself");
    assert.equal(String((r.out.hit!.view[1] as { text?: unknown }).text ?? ""), "b", "stale stashed byte serves during the ride");
    // The ride re-stashes its own view, so a persistent edit keeps riding —
    // the counter climbs one per consecutive drift turn...
    msgs = [...msgs, USR("x0")];
    r = runTurn(session, { [PF_COUNT_HEADER]: "5", ...TAIL(["h-d", "h-x0"]) }, bodyOf(msgs));
    assert.equal(r.out.decision, "hit", LOGS.join("\n"));
    assert.equal(r.out.driftRides, 2);
    msgs = [...msgs, USR("x1")];
    r = runTurn(session, { [PF_COUNT_HEADER]: "6", ...TAIL(["h-x0", "h-x1"]) }, bodyOf(msgs));
    assert.equal(r.out.driftRides, 3);
    msgs = [...msgs, USR("x2")];
    r = runTurn(session, { [PF_COUNT_HEADER]: "7", ...TAIL(["h-x1", "h-x2"]) }, bodyOf(msgs));
    assert.equal(r.out.driftRides, 4);
    msgs = [...msgs, USR("x3")];
    r = runTurn(session, { [PF_COUNT_HEADER]: "8", ...TAIL(["h-x2", "h-x3"]) }, bodyOf(msgs));
    assert.equal(r.out.decision, "hit", LOGS.join("\n"));
    assert.equal(r.out.driftRides, 5);
    // ...until the sixth: the cap forces ONE uncredited legacy reseed —
    // self-heal, never breaker fuel.
    msgs = [...msgs, USR("x4")];
    r = runTurn(session, { [PF_COUNT_HEADER]: "9", ...TAIL(["h-x3", "h-x4"]) }, bodyOf(msgs));
    assert.equal(r.out.decision, "v5-drift-cap", LOGS.join("\n"));
    assert.equal(r.out.creditedMiss, false);
    assert.equal(watermarkDebugState(session).missCount ?? 0, 0, "the cap miss is a self-heal, not breaker fuel");
    // Reseeded from real bytes: the EDIT now rides and the head compares clean.
    msgs = [...msgs, USR("x5")];
    r = runTurn(session, { [PF_COUNT_HEADER]: "10", ...TAIL(["h-x4", "h-x5"]) }, bodyOf(msgs));
    assert.equal(r.out.decision, "hit", LOGS.join("\n"));
    assert.equal(r.out.driftRides, undefined, "fresh seed: the ride episode is over");
    const texts = r.out.hit!.view.map((m) => String((m as { text?: unknown }).text ?? ""));
    assert.ok(texts.includes("b-EDITED"), "the reseed carried the edited bytes");
    assert.ok(!texts.some((t) => t === "b"), "the stale byte is gone from the view");
});
