// #5403/#5418 watermark fastpath — verdict ladder, seeding, rekeying
// (cluster ordinal + wireIndex seam continuity vs the legacy full-body parse
// oracle), and the breaker. The legacy pipeline is the source of truth in
// every assertion: `openaiToCore(JSON.parse(body))` over the WHOLE body is
// the oracle the stashed-view reconstruction must match.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { openaiToCore, coreToOpenai } from "acp-kernel/wire";
import { evaluateWatermarkFastpath, evaluateDeltaResend, finalizeWatermarkTurn, stampOnlyWatermarkTurn, clearWatermarkSeed, watermarkDebugState, PF_COUNT_HEADER, PF_SEQ_HEADER, PF_TAIL_IDS_HEADER, PF_DELTA_HEADER, PF_SLOT_UNKNOWN } from "../src/server/fastpath.ts";
import { stripRawStage } from "../src/marker/engine.ts";
import { applyMsgIdPin } from "../src/msgid-pin.ts";
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

/** Drive one turn the way prepareOpenai does for a PINNED session
 *  (pluginLaneServerHistory on, #4491): on a miss the seed is re-keyed to the
 *  host msgids via applyMsgIdPin (the id namespace the stash then carries), on
 *  a hit the pin is skipped (the seed's prefix was already pinned when it was
 *  materialized). This is the 2x2 traffic the watermark fastpath exists to
 *  accelerate — the seed cores carry host msgids while a fresh openaiToCore
 *  parse mints content-hash ids, so the id namespaces differ structurally
 *  (#7345). */
const runPinnedTurn = (
    session: Session,
    reqHeaders: Record<string, string>,
    bodyText: string,
    hostIds: string[],
): { out: ReturnType<typeof evaluateWatermarkFastpath>; headers: Record<string, string> } => {
    const model = JSON.parse(bodyText).model as string;
    const out = evaluateWatermarkFastpath(bodyText, headersOf(reqHeaders), session, { pluginMode: true, titleGen: false, model }, log);
    const oracle = openaiToCore(JSON.parse(bodyText));
    const stripCounts = stripRawStage(JSON.parse(bodyText), "openai");
    const headers = finalizeWatermarkTurn(session, out, {
        model,
        legacyCores: out.hit !== null ? out.hit.view : applyMsgIdPin(oracle.msgs, hostIds),
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

test("stampOnlyWatermarkTurn: flag off still emits the seq heartbeat (#7367)", () => {
    // The x-bili-pf-seq stamp is the client's watermark advance, NOT
    // fastpath-only state. With pluginFullResendWatermark gated off the
    // fastpath never evaluates, so finalizeWatermarkTurn never runs — the
    // stamp must still flow (via the structural scan) or the client's k2
    // freezes and its tail-ids grow past the 16 KB header limit.
    const body = bodyOf([SYS("s"), USR("hi"), USR("yo"), ASST("ok"), USR("tail")]);
    const headers = stampOnlyWatermarkTurn(body);
    assert.equal(headers[PF_SEQ_HEADER], "5", "stamp = measured element count T");
    // an unscannable body degrades to no stamp (the client's cap is the backstop)
    assert.deepEqual(stampOnlyWatermarkTurn("not-json-at-all"), {});
    assert.deepEqual(stampOnlyWatermarkTurn(""), {});
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

// #7064 2×2 perf regression (2026-11-20, 100k-message sessions): in a
// pinned session prepare-openai rebinds originalMessages to s0.pinned
// BEFORE finalizeWatermarkTurn, so the prefix stash carries HOST-MSGID ids
// (host/ledger namespace), while a fresh turn's openaiToCore mints
// content-hash ids. The head check must not treat the id field as drift
// evidence or the fastpath misses (head-prefix-drift) on EVERY steady
// turn — the exact traffic the watermark was built for. runTurnPinned
// simulates that reseed: a full host-id list pins, and the reseed takes
// the pinned (host-id) cores.
const runTurnPinned = (
    session: Session,
    reqHeaders: Record<string, string>,
    bodyText: string,
    hostIds?: string[],
): { out: ReturnType<typeof evaluateWatermarkFastpath>; headers: Record<string, string> } => {
    const model = JSON.parse(bodyText).model as string;
    const out = evaluateWatermarkFastpath(bodyText, headersOf(reqHeaders), session, { pluginMode: true, titleGen: false, model }, log);
    const oracle = openaiToCore(JSON.parse(bodyText));
    const stripCounts = stripRawStage(JSON.parse(bodyText), "openai");
    const base = out.hit !== null ? out.hit.view : oracle.msgs;
    const legacyCores = hostIds !== undefined && hostIds.length === base.length
        ? base.map((m, i) => ({ ...m, id: hostIds[i]! }))
        : base;
    const headers = finalizeWatermarkTurn(session, out, {
        model,
        legacyCores,
        rawSystemText: out.hit !== null ? out.hit.systemText : oracle.systemText,
        turnStripCounts: stripCounts,
    });
    return { out, headers };
};

test("pinned (2x2) steady state still HITS — host-id stash must not break the head check", () => {
    _resetStoreForTest();
    makeStubStore();
    const session = freshSession("pf-pinned");
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `host-id-${i}`); // n = NON-system core count
    // t1: SEED turn already carries the full host-id list → stage0 pins →
    // prepare-openai reseeds the stash from the PINNED cores (host-id
    // namespace). This is the field sequence (first 100k turn sends the
    // full biliMsgIds list); pre-fix the stash carried host ids from the
    // very first stamp and every later turn missed head-prefix-drift.
    const b1 = bodyOf([SYS("s"), USR("a"), USR("b"), ASST("c")]);
    const t1 = runTurnPinned(session, {}, b1, ids(3));
    assert.equal(t1.out.decision, "no-stamp", LOGS.join("\n"));
    // t2: steady state — tail-ids only (anchor + new), no body list.
    // Pre-fix: head-prefix-drift (fresh content-hash ids vs stashed host ids).
    const b2 = bodyOf([SYS("s"), USR("a"), USR("b"), ASST("c"), USR("d")]);
    const t2 = runTurnPinned(session, { [PF_COUNT_HEADER]: "4", ...TAIL([ids(4)[2]!, ids(4)[3]!]) }, b2);
    assert.equal(t2.out.decision, "hit", LOGS.join("\n"));
    assert.ok(t2.out.hit, "hit view expected");
    // t3: one more steady growth — the bug was PERMANENT drift, so a second
    // consecutive hit proves the stash stays consistent after a hit-turn
    // reseed (hit paths stash outcome.hit.view, a mixed namespace).
    const b3 = bodyOf([SYS("s"), USR("a"), USR("b"), ASST("c"), USR("d"), ASST("e")]);
    const t3 = runTurnPinned(session, { [PF_COUNT_HEADER]: "5", ...TAIL([ids(5)[3]!, ids(5)[4]!]) }, b3);
    assert.equal(t3.out.decision, "hit", LOGS.join("\n"));
    assert.ok(t3.out.hit, "second consecutive hit expected");
    assert.deepEqual(
        t3.out.hit.view.map((m) => String((m as { text?: unknown }).text ?? "")),
        ["a", "b", "c", "d", "e"],
        "view = stashed prefix + rekeyed window, byte-identical texts",
    );
    // id-excluded head check must STILL catch a real in-place content edit
    // in a pinned session (both directions, #3617).
    const b4 = bodyOf([SYS("s"), USR("a"), USR("b-EDITED"), ASST("c"), USR("d"), ASST("e"), USR("f")]);
    const t4 = runTurnPinned(session, { [PF_COUNT_HEADER]: "6", ...TAIL([ids(6)[4]!, ids(6)[5]!]) }, b4);
    assert.equal(t4.out.decision, "head-prefix-drift", LOGS.join("\n"));
    assert.equal(t4.out.creditedMiss, false);
    _resetStoreForTest();
});

// #5403 family, delta arm (x-bili-pf-delta): the body carries ONLY the tail
// slice [T-L .. T-1] (anchor = the previous turn's last element), the full
// logical count rides x-bili-pf-count, per-element ids ride x-bili-pf-tail-ids
// (width exactly L). A satisfiable claim yields the SAME FastpathHit the
// full-body lane would — every assertion is against the legacy full-parse
// oracle over the WHOLE logical body. An unsatisfiable claim is a re-anchor
// (the 400 the client answers with a full-form resend).

const dTail = (n: number): string[] => Array.from({ length: n }, (_, i) => `dhost-${i}`);

const runDeltaTurn = (
    session: Session,
    reqHeaders: Record<string, string>,
    sliceMessages: unknown[],
    model = "m1",
): { verdict: { hit: import("../src/server/fastpath.ts").FastpathHit; receivedTailIds?: string[] }; headers: Record<string, string> } => {
    const bodyText = bodyOf(sliceMessages, model);
    const verdict = evaluateDeltaResend(JSON.parse(bodyText) as Parameters<typeof evaluateDeltaResend>[0], bodyText, headersOf(reqHeaders), session, { pluginMode: true, titleGen: false, model }, log);
    assert.ok(verdict !== null && "hit" in verdict, `expected a delta hit, got ${JSON.stringify(verdict)}\n${LOGS.slice(-6).join("\n")}`);
    const hit = verdict;
    const headers = finalizeWatermarkTurn(session, { hit: hit.hit, measuredT: hit.hit.totalT, decision: "delta-hit", creditedMiss: false, receivedTailIds: hit.receivedTailIds }, {
        model,
        legacyCores: hit.hit.view,
        rawSystemText: hit.hit.systemText,
        turnStripCounts: hit.hit.markerCounts,
    });
    return { verdict: hit, headers };
};

test("delta arm: hit reconstructs EXACTLY the legacy full-parse oracle across consecutive slices", () => {
    makeStubStore();
    process.env.BILI_ROLLOUT_PLUGIN_DELTA_RESEND = "1";
    const session = freshSession("pf-delta-hit");
    const full: unknown[] = [SYS("s"), USR("a"), USR("b")];
    // Seed carries NO pf headers (field: the first request of a session
    // never stamps) — the first delta turn opens unverified, from then on
    // every list is chained on the previous turn's stamped last id.
    const t1 = runTurn(session, {}, bodyOf(full));
    assert.equal(t1.out.decision, "no-stamp"); // seed stampT=3
    // t2: logical T=5, L=5-3=2 -> body = NEW elements only [USR c, ASST d],
    // tail-ids = anchor(b)+new = [dhost-2, dhost-3, dhost-4]
    full.push(USR("c"), ASST("d"));
    const r2 = runDeltaTurn(session, { [PF_COUNT_HEADER]: "5", [PF_DELTA_HEADER]: "1", ...TAIL(dTail(5).slice(2)) }, full.slice(3));
    assert.equal(r2.headers[PF_SEQ_HEADER], "5");
    let oracle = openaiToCore(JSON.parse(bodyOf(full)));
    assert.deepEqual(r2.verdict.hit!.view.map((m) => String((m as { text?: unknown }).text ?? "")), oracle.msgs.map((m) => m.text), "texts");
    for (let i = 0; i < oracle.msgs.length; i++) {
        assert.equal(r2.verdict.hit!.view[i]!.id, oracle.msgs[i]!.id, `id @${i}`);
        assert.equal((r2.verdict.hit!.view[i]! as { wireIndex?: number }).wireIndex, (oracle.msgs[i]! as { wireIndex?: number }).wireIndex, `wireIndex @${i}`);
    }
    assert.equal(r2.verdict.hit!.systemText, oracle.systemText);
    assert.equal(r2.verdict.hit!.totalT, 5);
    // t3: logical T=6, L=1 -> body = [USR e], tail-ids = anchor(d)+new = [dhost-4, dhost-5]
    full.push(USR("e"));
    const r3 = runDeltaTurn(session, { [PF_COUNT_HEADER]: "6", [PF_DELTA_HEADER]: "1", ...TAIL(dTail(6).slice(4)) }, full.slice(5));
    assert.equal(r3.headers[PF_SEQ_HEADER], "6");
    oracle = openaiToCore(JSON.parse(bodyOf(full)));
    assert.deepEqual(r3.verdict.hit!.view.map((m) => String((m as { text?: unknown }).text ?? "")), oracle.msgs.map((m) => m.text), "texts after second slice");
    for (let i = 0; i < oracle.msgs.length; i++) {
        assert.equal(r3.verdict.hit!.view[i]!.id, oracle.msgs[i]!.id, `id @${i} (t3)`);
        assert.equal((r3.verdict.hit!.view[i]! as { wireIndex?: number }).wireIndex, (oracle.msgs[i]! as { wireIndex?: number }).wireIndex, `wireIndex @${i} (t3)`);
    }
    // t4: a delta turn must NOT disturb the full lane — a full-form turn right
    // after a delta hit still hits against the delta-advanced seed.
    full.push(ASST("f"));
    const t4 = runTurn(session, { [PF_COUNT_HEADER]: "6", ...TAIL(dTail(7).slice(5)) }, bodyOf(full));
    assert.equal(t4.out.decision, "hit", LOGS.slice(-6).join("\n"));
    assert.ok(t4.out.hit);
    delete process.env.BILI_ROLLOUT_PLUGIN_DELTA_RESEND;
    _resetStoreForTest();
});

test("delta arm: every unsatisfiable claim re-anchors (both directions, #3617)", () => {
    makeStubStore();
    process.env.BILI_ROLLOUT_PLUGIN_DELTA_RESEND = "1";
    const session = freshSession("pf-delta-reanchor");
    const full: unknown[] = [SYS("s"), USR("a"), USR("b")];
    runTurn(session, {}, bodyOf(full)); // seed stampT=3 (no pf headers — field)
    full.push(USR("c"), ASST("d")); // logical T=5, L=2 -> body = [USR c, ASST d]
    const deltaBody = JSON.stringify({ model: "m1", stream: false, messages: full.slice(3) });
    const delta = { [PF_DELTA_HEADER]: "1", [PF_COUNT_HEADER]: "5", ...TAIL(dTail(5).slice(2)) } as Record<string, string>;
    const ev = (h: Record<string, string>, bodyText = deltaBody) =>
        evaluateDeltaResend(JSON.parse(bodyText) as Parameters<typeof evaluateDeltaResend>[0], bodyText, headersOf(h), session, { pluginMode: true, titleGen: false, model: JSON.parse(bodyText).model as string }, log);

    // negative: no header = not a delta request (full lane owns it)
    assert.equal(ev({}), null);
    // bad header value
    assert.deepEqual(ev({ [PF_DELTA_HEADER]: "0", [PF_COUNT_HEADER]: "5" }), { reanchor: "delta-bad-value" });
    // wrong model for the seed
    assert.deepEqual(ev(delta, JSON.stringify({ model: "OTHER", stream: false, messages: full.slice(3) })), { reanchor: "model" });
    // missing count
    assert.deepEqual(ev({ [PF_DELTA_HEADER]: "1" }), { reanchor: "no-count" });
    // behind the stamp (client desynced backwards: L = T - stampT <= 0)
    assert.deepEqual(ev({ ...delta, [PF_COUNT_HEADER]: "3" }), { reanchor: "behind" });
    // window above the bound
    assert.deepEqual(ev({ ...delta, [PF_COUNT_HEADER]: String(3 + 2048 + 1) }), { reanchor: "window-too-large" });
    // body length does not match L
    assert.deepEqual(ev(delta, JSON.stringify({ model: "m1", stream: false, messages: [USR("c")] })), { reanchor: "body-length" });
    // messages not an array
    assert.deepEqual(ev(delta, JSON.stringify({ model: "m1", stream: false, messages: "oops" })), { reanchor: "body-length" });
    // tail-ids absent / wrong width / garbage
    assert.deepEqual(ev({ [PF_DELTA_HEADER]: "1", [PF_COUNT_HEADER]: "5" }), { reanchor: "tail-ids-shape" });
    assert.deepEqual(ev({ ...delta, ...TAIL(["x", "y"]) }), { reanchor: "tail-ids-shape" });
    assert.deepEqual(ev({ ...delta, [PF_TAIL_IDS_HEADER]: "a,b%2Cc%%" }), { reanchor: "tail-ids-shape" });
    // a system element riding the new slice (pre-chain: stamp still 3)
    assert.deepEqual(ev(delta, JSON.stringify({ model: "m1", stream: false, messages: [SYS("intruder"), ASST("d")] })), { reanchor: "window-system-head" });
    // anchor continuity: after a delta hit stamps a list, the NEXT list must
    // open with its last id — wrong head re-anchors (both directions #3617)
    const rChain = runDeltaTurn(session, { ...delta }, full.slice(3));
    void rChain; // stamps lastTailIds = dhost-2..4, next anchor must be dhost-4
    full.push(USR("e")); // T=6, L=1
    const delta2 = { [PF_DELTA_HEADER]: "1", [PF_COUNT_HEADER]: "6", ...TAIL(dTail(6).slice(4)) } as Record<string, string>;
    const ev2 = (h: Record<string, string>) =>
        evaluateDeltaResend({ model: "m1", stream: false, messages: [USR("e")] } as Parameters<typeof evaluateDeltaResend>[0], JSON.stringify({ model: "m1", stream: false, messages: [USR("e")] }), headersOf(h), session, { pluginMode: true, titleGen: false, model: "m1" }, log);
    assert.deepEqual(ev2({ ...delta2, ...TAIL(["WRONG", "dhost-5"]) }), { reanchor: "tail-ids-prev" });
    assert.ok("hit" in (ev2(delta2) as object), "chained head dhost-4 must pass");
    // unseeded session: a fresh id can never delta
    const cold = freshSession("pf-delta-cold");
    assert.deepEqual(evaluateDeltaResend(JSON.parse(deltaBody) as Parameters<typeof evaluateDeltaResend>[0], deltaBody, headersOf(delta), cold, { pluginMode: true, titleGen: false, model: "m1" }, log), { reanchor: "unseeded" });
    // rollout off = the rollback kill switch (LAST: it mutes every gate below it)
    process.env.BILI_ROLLOUT_PLUGIN_DELTA_RESEND = "0";
    assert.deepEqual(ev(delta), { reanchor: "rollout-off" });
    delete process.env.BILI_ROLLOUT_PLUGIN_DELTA_RESEND;
    _resetStoreForTest();
});

test("pinned seed (host msgids) + tail-only growth HITS; in-place head edit still drifts (#7345)", () => {
    makeStubStore();
    const session = freshSession("pf-pin");
    // turn 1: seed. pluginLaneServerHistory pins the seed cores to host msgids
    // (applyMsgIdPin), so the stash carries a DIFFERENT id namespace than the
    // content-hash ids a fresh openaiToCore parse mints.
    const b1 = bodyOf([SYS("s"), USR("a"), USR("b"), ASST("c"), USR("d")]);
    const t1 = runPinnedTurn(session, {}, b1, ["host-a", "host-b", "host-c", "host-d"]);
    assert.equal(t1.out.decision, "no-stamp", LOGS.join("\n"));
    assert.equal(t1.out.measuredT, 5);
    // turn 2: same prefix + one new tail element. The fresh head cores carry
    // content-hash ids while the seed carries host msgids — the head check must
    // ignore the id namespace and HIT on the unchanged content. Pre-fix this is
    // a permanent head-prefix-drift miss (the field symptom: every turn of a
    // 2x2 pinned session fell back to the full legacy parse).
    const b2 = bodyOf([SYS("s"), USR("a"), USR("b"), ASST("c"), USR("d"), USR("e")]);
    const t2 = runPinnedTurn(session, { [PF_COUNT_HEADER]: "5" }, b2, ["host-a", "host-b", "host-c", "host-d", "host-e"]);
    assert.equal(t2.out.decision, "hit", LOGS.join("\n"));
    assert.equal(t2.out.creditedMiss, false);
    // the view must still be the legacy full-parse oracle on CONTENT. The
    // prefix ids are host msgids by design in a pinned session, so assert
    // text/role parity (not id parity — that is the namespace difference).
    if (!t2.out.hit) throw new Error("expected hit");
    const oracle2 = openaiToCore(JSON.parse(b2));
    assert.equal(t2.out.hit.view.length, oracle2.msgs.length);
    for (let i = 0; i < oracle2.msgs.length; i++) {
        assert.equal(t2.out.hit.view[i]!.text, oracle2.msgs[i]!.text, `text @${i}`);
        assert.equal(t2.out.hit.view[i]!.role, oracle2.msgs[i]!.role, `role @${i}`);
    }
    // turn 3: rewrite a HEAD element IN PLACE (prefix counts unchanged, system
    // identical, stamp honest) + append one tail — the per-core content
    // comparison (id excluded) must still catch the rewrite, so the fix does
    // not mask a genuine in-place edit.
    const b3 = bodyOf([SYS("s"), USR("a"), USR("b-EDITED"), ASST("c"), USR("d"), USR("e"), USR("f")]);
    const t3 = runPinnedTurn(session, { [PF_COUNT_HEADER]: "6" }, b3, ["host-a", "host-b2", "host-c", "host-d", "host-e", "host-f"]);
    assert.equal(t3.out.decision, "head-prefix-drift", LOGS.join("\n"));
    assert.equal(t3.out.creditedMiss, false);
});
