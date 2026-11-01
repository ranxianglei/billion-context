// #5403/#5418 watermark fastpath — verdict ladder, seeding, rekeying
// (cluster ordinal + wireIndex seam continuity vs the legacy full-body parse
// oracle), and the breaker. The legacy pipeline is the source of truth in
// every assertion: `openaiToCore(JSON.parse(body))` over the WHOLE body is
// the oracle the stashed-view reconstruction must match.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { openaiToCore, coreToOpenai } from "acp-kernel/wire";
import { evaluateWatermarkFastpath, finalizeWatermarkTurn, clearWatermarkSeed, watermarkDebugState, PF_COUNT_HEADER, PF_SEQ_HEADER } from "../src/server/fastpath.ts";
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
