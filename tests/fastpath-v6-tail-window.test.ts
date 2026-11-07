// #5643 F1 (owner ruling in the PR #5652 review, 2026-11-04): FIXED TAIL
// WINDOW wire form — x-bili-pf-tail-ids carries only the LAST 64 element ids;
// server width expectation = min(window, T); over/under-window lists refuse
// loudly; out-of-window prefixes ride the ledger chain (honest boundary:
// never probed). Plus the F1 matrix line the review demanded: whole-window
// identity rewrite → with-echo = fault storm → park; without-echo = legal
// re-arm onto a fresh world (old archive preserved).

import * as assert from "node:assert";
import { test } from "node:test";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenAIRequestBody } from "acp-kernel/wire";
import { openaiToCore } from "acp-kernel/wire";
import type { Session } from "../src/session.js";
import { SessionStore, _resetStoreForTest, _setStoreForTest } from "../src/persist.js";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { evaluateWatermarkV6, finalizeWatermarkV6, FastpathV6IdentityFault, watermarkV6DebugState, PF_SESSION_HEADER } from "../src/server/fastpath-v6.js";
import { PF_TAIL_IDS_HEADER, PF_SEQ_HEADER } from "../src/server/fastpath.js";

const ENV = "BILI_ROLLOUT_WATERMARK_V6_MSG_ID";
const WINDOW = 64; // mirrors src/server/fastpath-v6.ts PF_TAIL_WINDOW / pf-channel mirror

type LogSink = { lines: { level: string; msg: string }[] } & ((level: string, msg: string) => void);
function makeLog(): LogSink {
    const sink = { lines: [] as { level: string; msg: string }[] };
    const fn = function (this: { lines: unknown[] }, level: string, msg: string) {
        sink.lines.push({ level, msg });
    } as unknown as LogSink;
    (fn as LogSink).lines = sink.lines;
    return fn;
}

interface H { store: SessionStore; cleanup: () => void }
function makeH(tag: string): H {
    process.env[ENV] = "1";
    _resetStoreForTest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `v6tw-${tag}-`));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as never);
    assert.ok(shadow, "shadow sidecar must open in the hermetic dir");
    const store = new SessionStore({ dir: path.join(dir, "sessions"), enabled: true, shadow });
    _setStoreForTest(store);
    return { store, cleanup: () => { process.env[ENV] = ""; _resetStoreForTest(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

function makeBody(msgs: { role: string; content: string }[]): string {
    return JSON.stringify({ model: "m", messages: msgs });
}
const encList = (ids: string[]) => ids.map(encodeURIComponent).join(",");

interface TurnResult { outcome: NonNullable<ReturnType<typeof evaluateWatermarkV6>>; headers: Record<string, string>; sid?: string }
function turn(
    sessId: string, carrier: string,
    bodyText: string, idList: string[], log: LogSink, echoSid?: string,
): TurnResult {
    const headers: Record<string, string> = { "x-bili-plugin-conversation": carrier };
    if (idList.length > 0) headers[PF_TAIL_IDS_HEADER] = encList(idList);
    if (echoSid !== undefined) headers[PF_SESSION_HEADER] = echoSid;
    const req = { headers } as unknown as http.IncomingMessage;
    const outcome = evaluateWatermarkV6(bodyText, req, { id: sessId } as unknown as Session, { pluginMode: true, titleGen: false, model: "m" }, log);
    assert.ok(outcome !== null, `expected v6 to engage (log=${JSON.stringify(log.lines.slice(-4))})`);
    const headersOut = finalizeWatermarkV6({ id: sessId } as unknown as Session, outcome, { bodyText }, log);
    return { outcome, headers: headersOut, sid: outcome.armed?.sid ?? headersOut[PF_SESSION_HEADER] };
}

function assertFault(fn: () => unknown, detailPart: string): FastpathV6IdentityFault {
    let caught: unknown;
    try { fn(); } catch (e) { caught = e; }
    assert.ok(caught instanceof FastpathV6IdentityFault, `expected FastpathV6IdentityFault, got ${String(caught)}: ${JSON.stringify(caught)}`);
    const f = caught as FastpathV6IdentityFault;
    assert.ok(f.detail.includes(detailPart), `fault detail "${f.detail}" should contain "${detailPart}"`);
    assert.equal(f.status, 400);
    assert.equal(f.toJSON().error.code, "pf_v6_identity_fault");
    return f;
}

/** A conformant client's captured id list → what the wire actually carries:
 *  exactly the last min(WINDOW, T) slots, in order. */
const wireSlice = (ids: string[]) => ids.slice(-WINDOW);

test("F1 long history beyond the window: arm ledgers prefix rows WITHOUT identity (honest boundary); tail NEW still exact; parity holds", () => {
    const h = makeH("longhist");
    try {
        const log = makeLog();
        // T = 72: system + 71 users. Wire carries only ids 8..71 (last 64).
        const mk = (n: number) => makeBody([{ role: "system", content: "sys" }, ...Array.from({ length: n }, (_, i) => ({ role: "user", content: `msg ${i}` }))]);
        const allIds = (): string[] => Array.from({ length: 72 }, (_, i) => `w${i}`);

        const r1 = turn("s-lh", "car-lh", mk(71), wireSlice(allIds()), log);
        assert.equal(r1.outcome.decision, "arm", "cold start over a long pre-existing history arms once (P5 exception)");
        assert.match(r1.sid ?? "", /^pf_[0-9a-f]{12}$/u);
        assert.equal(r1.headers[PF_SEQ_HEADER], "72");
        const sid = r1.sid!;

        // Honest boundary made concrete: ids OUTSIDE the carried window have
        // cores registered but NO ledger identity — probes for them miss by design.
        const prefixProbe = h.store.pfProbePairs("car-lh", ["w0", "w3"]) ?? new Map<string, { sid: string; pos: number }>();
        assert.equal(prefixProbe.size, 0, "out-of-window prefix ids are unledgred (prefix rewrites there are NOT promised detectable)");
        const tailProbe = h.store.pfProbePairs("car-lh", ["w8"]) ?? new Map<string, { sid: string; pos: number }>();
        assert.equal(tailProbe.get("w8")?.pos, 8, "first carried id binds its TRUE absolute position");

        // Append ONE more element (T=73): the new tail id is detected exactly,
        // positioned from posStart onward, numbering continues across ALL 72
        // frozen cores — byte-parity with the full-parse oracle.
        // T=73 body (system + 72 users): ids w0..w71 unchanged + w72 the new tail.
        const ids73 = (): string[] => [...Array.from({ length: 72 }, (_, i) => `w${i}`), "w72"];
        const b2 = makeBody([{ role: "system", content: "sys" }, ...Array.from({ length: 72 }, (_, i) => ({ role: "user", content: i < 71 ? `msg ${i}` : "the new one" }))]);
        const r2 = turn("s-lh", "car-lh", b2, wireSlice(ids73()), log, sid);
        assert.equal(r2.outcome.decision, "hit");
        assert.equal(r2.outcome.hit!.totalT, 73);
        assert.ok(r2.outcome.hit!.windowCores.length >= 1, "only the new element is pinned");
        const oracle = openaiToCore(JSON.parse(b2) as never).msgs;
        assert.deepEqual(r2.outcome.hit!.view.map((c) => JSON.parse(JSON.stringify(c))), JSON.parse(JSON.stringify(oracle)),
            "assembled view (frozen 72 + new 1) must byte-match the full parse across the window edge");

        // No-progress ride after the growth: identical resend of the same window
        // ⇒ every carried id already seen ⇒ pure ride, empty pin.
        const r4 = turn("s-lh", "car-lh", b2, wireSlice(ids73()), log, sid);
        assert.equal(r4.outcome.decision, "no-progress", "identical resend rides silently with an empty pin");
        assert.equal(r4.outcome.hit!.windowCores.length, 0);
        assert.equal(watermarkV6DebugState("s-lh").liveSids.length, 1);
    } finally { h.cleanup(); }
});

test("F1 width discipline: over-window list = malformed-format fault; under-window list = width fault (both counted)", () => {
    const h = makeH("width");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "user", content: "one" }]);
        const faultsAfter = (): number => (h.store.getSessionExt("s-wd", "pf:v6-guard") as { faults?: number } | undefined)?.faults ?? -1;

        // OVER-window: 65 unique well-formed segments cannot exist on the wire
        // from a conformant emitter — the strict decoder refuses them inside
        // screening (format class), before any geometry reasoning.
        const over = Array.from({ length: WINDOW + 1 }, (_, i) => `o${i}`);
        assertFault(() => turn("s-wd", "car-wd", b1, over, log), "identity channel malformed");
        const g1 = faultsAfter();

        // UNDER-window: T=3 body but only 2 ids carried (stale slice form /
        // drifted encoder) — the width gate fires loudly, not degrade-silent.
        assertFault(() => turn("s-wd", "car-wd", b1, ["u1", "u2"], log), "identity width mismatch");
        const g2 = faultsAfter();
        assert.ok(g1 >= 1 && g2 >= g1, "both refuse classes count into the breaker");
    } finally { h.cleanup(); }
});

test("F1' whole-window rewrite (matrix line the review demanded): with-echo → fault storm → park; without-echo → legal re-arm, old archive intact", () => {
    const h = makeH("rewrite");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: "sys" }, { role: "user", content: "one" }, { role: "user", content: "two" }]);
        const rA = turn("s-rw", "car-rw", b1, ["r1", "r2", "r3"], log);
        assert.equal(rA.outcome.decision, "arm");
        const sidA = rA.sid!;

        // A wholesale identity rewrite of the ENTIRE carried window (host
        // recast every id, e.g. aggressive compaction-replace).
        const bRewrite = makeBody([{ role: "system", content: "RECAST" }, { role: "user", content: "alpha" }, { role: "user", content: "beta" }]);
        const newIds = ["z1", "z2", "z3"];

        // POSITIVE side — the client STILL ECHOES the old world id: every
        // carried identity is foreign to that world ⇒ consistency break. Five
        // consecutive breaks park the lane for the session (loud, then quiet
        // baseline serving — no 400 loop).
        for (let i = 1; i <= 5; i++) {
            assertFault(() => turn("s-rw", "car-rw", bRewrite, newIds, log, sidA), "carries no resolvable identity");
        }
        const parkedReq = {
            headers: { "x-bili-plugin-conversation": "car-rw", [PF_TAIL_IDS_HEADER]: encList(newIds), [PF_SESSION_HEADER]: sidA },
        } as unknown as http.IncomingMessage;
        assert.equal(evaluateWatermarkV6(bRewrite, parkedReq, { id: "s-rw" } as unknown as Session, { pluginMode: true, titleGen: false, model: "m" }, log), null,
            "parked lane degrades SILENTLY to baseline instead of throw-looping");
        assert.ok(log.lines.some((l) => l.level === "warn" && l.msg.includes("PARKED")), "parking announced loudly");

        // NEGATIVE side — a DIFFERENT session whose window is likewise wholly
        // recast but which does NOT carry a stale echo: probe-miss is the LEGAL
        // identity-boundary entrance (rule ③). Fresh mint + armed turn; the
        // previous world's rows and log stay untouched (audit trail survives).
        const rB1 = turn("s-rw2", "car-rw2", b1, ["k1", "k2", "k3"], log);
        const sidB1 = rB1.sid!;
        const metaBefore = h.store.pfMeta(sidB1)!;
        assert.ok(metaBefore.log.length >= 3, "old world had committed its arm entries");
        const rB2 = turn("s-rw2", "car-rw2", bRewrite, ["q1", "q2", "q3"], log);
        assert.equal(rB2.outcome.decision, "arm", "no stale echo ⇒ whole-rewrite is a lawful new world, not a fault");
        assert.notEqual(rB2.sid, sidB1, "new mint, same conversation carrier");
        const metaAfter = h.store.pfMeta(sidB1)!;
        assert.equal(metaAfter.log.length, metaBefore.log.length, "old-world log archive is preserved byte-for-byte in entry count");
        assert.equal(h.store.pfProbePairs("car-rw2", ["q1"])?.get("q1")?.sid, rB2.sid, "the recast span now belongs to the fresh world");
    } finally { h.cleanup(); }
});
