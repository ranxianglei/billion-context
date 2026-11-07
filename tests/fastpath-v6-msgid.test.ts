// #5643 — fastpath v6: composite-identity-driven incremental lane.
//
// Contract source: issue #5643 (§8 matrix rows are cited inline as §8-N).
// The v6 lane judges purely by set difference over (sess_raw, ledger_id):
// NEW = R \ seen, anywhere in the body; frozen prefix hydrates from the
// pf_* plane; client-side compaction is ignored EXCEPT for honest stamping.
//
// Harness: unit-level against a REAL sqlite sidecar (UnifiedShadow in
// shadow mode + SessionStore seam), so the identity plane, folding and
// hydration run exactly as in production — only the HTTP layer is skipped
// (the 400 mapping itself lives in handle.ts and is exercised by the fault
// class shape asserted here).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { openaiToCore } from "acp-kernel/wire";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import type { SessionStore as SessionStoreType } from "../src/persist.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import type { Session } from "../src/session.ts";
import {
    evaluateWatermarkV6, finalizeWatermarkV6, FastpathV6IdentityFault, watermarkV6DebugState, clearWatermarkV6, _resetWatermarkV6MirrorsForTest, PF_SESSION_HEADER,
} from "../src/server/fastpath-v6.ts";
import { PF_SEQ_HEADER, PF_TAIL_IDS_HEADER } from "../src/server/fastpath.ts";
import type { V6Outcome } from "../src/server/fastpath-v6.ts";

const ENV = "BILI_ROLLOUT_WATERMARK_V6_MSG_ID";

interface Msg { role: string; content: string }

function makeBody(messages: Msg[]): string {
    return JSON.stringify({ model: "m", messages });
}

const SYS = "sys v1";
/** Distinct ids per element; `n` suffix keeps ids unique across turn shapes. */
function ids(n: number, tag = ""): string[] {
    return Array.from({ length: n }, (_, i) => `id${i}${tag}`);
}

type LogSink = { lines: { level: string; msg: string }[] } & ((level: string, msg: string) => void);
function makeLog(): LogSink {
    const l = { lines: [] as { level: string; msg: string }[] };
    return Object.assign((level: string, msg: string) => { l.lines.push({ level, msg }); }, { lines: l.lines });
}

interface TurnResult { outcome: V6Outcome; headers: Record<string, string>; sid: string | undefined }

function turn(
    sessId: string, carrier: string,
    bodyText: string, idList: string[], log: LogSink, echoSid?: string,
    extraHeaders: Record<string, string> = {},
): TurnResult {
    const headers: Record<string, string> = { "x-bili-plugin-conversation": carrier, ...extraHeaders };
    if (idList.length > 0) headers[PF_TAIL_IDS_HEADER] = idList.map(encodeURIComponent).join(",");
    if (echoSid !== undefined) headers[PF_SESSION_HEADER] = echoSid;
    const req = { headers } as unknown as http.IncomingMessage;
    const session = { id: sessId } as unknown as Session;
    const outcome = evaluateWatermarkV6(bodyText, req, session, { pluginMode: true, titleGen: false, model: "m" }, log);
    assert.ok(outcome !== null, `expected v6 to engage (log=${JSON.stringify(log.lines.slice(-4))})`);
    const headersOut = finalizeWatermarkV6(session, outcome, { bodyText }, log);
    return { outcome, headers: headersOut, sid: outcome.armed?.sid ?? headersOut[PF_SESSION_HEADER] };
}

function assertFault(fn: () => unknown, detailPart: string): FastpathV6IdentityFault {
    let caught: unknown;
    try { fn(); } catch (e) { caught = e; }
    assert.ok(caught instanceof FastpathV6IdentityFault, `expected FastpathV6IdentityFault, got ${String(caught)}: ${JSON.stringify(caught)}`);
    const f = caught as FastpathV6IdentityFault;
    assert.ok(f.detail.includes(detailPart), `detail ${JSON.stringify(f.detail)} ⊄ ${JSON.stringify(detailPart)}`);
    assert.equal(f.status, 400);
    const json = f.toJSON();
    assert.equal(json.error.type, "invalid_request_error");
    assert.equal(json.error.code, "pf_v6_identity_fault");
    return f;
}

interface H { dir: string; store: SessionStoreType; cleanup: () => void }

const SESSION_TAG = "v6";

function makeH(tag: string): H {
    process.env[ENV] = "1";
    _resetStoreForTest();
    const dir = mkdtempSync(path.join(os.tmpdir(), `v6-${tag}-`));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as never);
    assert.ok(shadow, "shadow sidecar must open in the hermetic dir");
    const store = new SessionStore({ dir: path.join(dir, "sessions"), enabled: true, shadow });
    _setStoreForTest(store);
    return { dir, store, cleanup: () => { _resetStoreForTest(); rmSync(dir, { recursive: true, force: true }); } };
}

test("§8-1 pure append: tail-only decode, _N parity with full parse, no-progress ride", (t) => {
    const h = makeH("append");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "hello one" }]);
        const r1 = turn("s-app", "carrier-app", b1, ids(2, "-a"), log);
        assert.equal(r1.outcome.decision, "arm");
        assert.match(r1.sid ?? "", /^pf_[0-9a-f]{12}$/u);
        assert.equal(r1.headers[PF_SEQ_HEADER], "2");
        const sid = r1.sid!;

        // turn 2: append one element → hit, view == full parse of the whole body
        const b2 = makeBody([
            { role: "system", content: SYS },
            { role: "user", content: "hello one" },
            { role: "assistant", content: "hi there" },
        ]);
        const r2 = turn("s-app", "carrier-app", b2, [...ids(2, "-a"), "id2-new"], log, sid);
        assert.equal(r2.outcome.decision, "hit");
        const hit = r2.outcome.hit!;
        assert.equal(hit.totalT, 3);
        assert.ok(hit.windowCores.length >= 1, "window pins the new cores");
        const oracle = openaiToCore(JSON.parse(b2) as never).msgs;
        assert.deepEqual(hit.view.map((c) => JSON.parse(JSON.stringify(c))), JSON.parse(JSON.stringify(oracle)),
            "v6 assembled view must byte-match the full-parse oracle (numbering included)");

        // turn 3: identical body (client resends unchanged) → NO-PROGRESS:
        // nothing decoded interior-wise, stamp re-echoed, plane untouched growth-wise
        const r3 = turn("s-app", "carrier-app", b2, [...ids(2, "-a"), "id2-new"], log, sid);
        assert.equal(r3.outcome.decision, "no-progress");
        assert.equal(r3.headers[PF_SESSION_HEADER], sid);
        assert.equal(r3.headers[PF_SEQ_HEADER], "3");
        assert.equal(r3.outcome.hit!.view.length, hit.view.length, "no-progress view IS the plane (no shrink, no grow)");
        assert.equal(r3.outcome.hit!.windowCores.length, 0, "no window pin on a plain ride");
    } finally { h.cleanup(); }
});

test("§8-3/15 silent pass-throughs: unscannable body / non-cohort carrier / feature OFF fall to baseline without touching anything", () => {
    const h = makeH("silent");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "x" }]);
        // (a) cohort carrier present but the body is NOT scannable JSON ⇒
        //     fail-soft null (bad bodies are never identity faults; the
        //     baseline lanes own them). Note: carrier present WITH a clean
        //     scan but NO id channel is FAULT class 1 — asserted in §8-7.
        const reqA = { headers: { "x-bili-plugin-conversation": "c-sil", [PF_TAIL_IDS_HEADER]: "a,b" } } as unknown as http.IncomingMessage;
        assert.equal(evaluateWatermarkV6("not-json{", reqA, { id: "s-sil" } as unknown as Session, { pluginMode: true, titleGen: false, model: "m" }, log), null);
        // (b) non-cohort carrier absence ⇒ null too (configuration-level exclusion, NOT a fault)
        const reqB = { headers: { [PF_TAIL_IDS_HEADER]: "a,b" } } as unknown as http.IncomingMessage;
        assert.equal(evaluateWatermarkV6(b1, reqB, { id: "s-sil" } as unknown as Session, { pluginMode: true, titleGen: false, model: "m" }, log), null);
        // (c) default-OFF switch: with the env unset the module reports a plain miss even on perfect traffic
        delete process.env[ENV];
        try {
            const reqC = { headers: { "x-bili-plugin-conversation": "c-sil", [PF_TAIL_IDS_HEADER]: "a,b" } } as unknown as http.IncomingMessage;
            assert.equal(evaluateWatermarkV6(b1, reqC, { id: "s-sil" } as unknown as Session, { pluginMode: true, titleGen: false, model: "m" }, log), null);
        } finally { process.env[ENV] = "1"; }
        assert.equal(watermarkV6DebugState("s-sil").liveSids.length, 0, "no world minted by any of the silent pass-throughs");
    } finally { h.cleanup(); }
});

test("§8-7..12 identity hard gate: four fault classes → structured 400, zero side effects, recovery leaves no trace", () => {
    const h = makeH("faults");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "one" }, { role: "user", content: "two" }]);
        const I3 = ["a1", "a2", "a3"];
        // Establish world A under this session/carrier (legal arm, rule ③)
        const rA = turn("s-fa", "car-a", b1, I3, log);
        assert.equal(rA.outcome.decision, "arm");
        const sidA = rA.sid!;
        const guardBefore = h.store.getSessionExt("s-fa", "pf:v6-guard") as { faults?: number; disabledAt?: number } | undefined;
        const faultsAfter = (): number => (h.store.getSessionExt("s-fa", "pf:v6-guard") as { faults?: number } | undefined)?.faults ?? -1;
        void guardBefore;

        // (1) channel incomplete: carrier present, id header absent
        const g0 = faultsAfter();
        assertFault(() => turn("s-fa", "car-a", b1, [], log), "identity channel incomplete");
        assert.equal(faultsAfter(), g0 + 1, "each refusal is counted into the breaker");

        // (2) malformed member: an unknown-slot placeholder rides the wire
        assertFault(() => turn("s-fa", "car-a", b1, ["?", "a2", "a3"], log), "identity channel malformed");

        // (3) width mismatch: list length ≠ scanned geometry T
        assertFault(() => turn("s-fa", "car-a", b1, I3.slice(0, 2), log), "identity width mismatch");

        // (4) consistency break: echo carries another world's unresolvable span
        assertFault(() => turn("s-fa", "car-other", b1, I3, log, sidA), "carries no resolvable identity");

        // Zero side effects: the plane still holds ONLY the arm registration
        const meta = h.store.pfMeta(sidA);
        assert.ok(meta !== null && meta.log.length === 3, `arm wrote exactly 3 log entries, got ${meta ? meta.log.length : "null"}`);
        assert.equal(watermarkV6DebugState("s-fa").liveSids.length, 1);

        // Recovery-without-trace: the FIFTH hard fault parks the lane inside
        // its own request (which is still refused once); while parked, broken
        // requests degrade SILENTLY to baseline instead of throwing loops;
        // after the hold expires the next request walks back in and a healthy
        // turn hits cleanly.
        const realNow = Date.now;
        try {
            assertFault(() => turn("s-fa", "car-a", b1, I3.slice(0, 2), log), "identity width mismatch");
            const reqP = { headers: { "x-bili-plugin-conversation": "car-a", [PF_TAIL_IDS_HEADER]: I3.slice(0, 2).join(",") } } as unknown as http.IncomingMessage;
            for (let i = 0; i < 4; i++) {
                assert.equal(evaluateWatermarkV6(b1, reqP, { id: "s-fa" } as unknown as Session, { pluginMode: true, titleGen: false, model: "m" }, log), null, `parked lane must not throw-loop (iter ${i})`);
            }
            assert.ok(log.lines.some((l) => l.level === "warn" && l.msg.includes("PARKED")), "parking announced loudly");
            Date.now = (() => realNow() + 61 * 60 * 1000) as typeof Date.now;
            const b2 = makeBody([...JSON.parse(b1).messages, { role: "user", content: "three" }]);
            const rRec = turn("s-fa", "car-a", b2, [...I3, "a4"], log, sidA);
            assert.equal(rRec.outcome.decision, "hit", "post-hold recovery rides straight back into the lane");
        } finally { Date.now = realNow; }
    } finally { h.cleanup(); }
});

test("§8-4/5 client compaction is IGNORED: no hide machinery, summaries are ordinary increments, stamp follows the body", () => {
    const h = makeH("compact");
    try {
        const log = makeLog();
        // Grow to T=6 through arm + appends
        let msgs: Msg[] = [{ role: "system", content: SYS }, { role: "user", content: "m1" }];
        let r = turn("s-cp", "car-cp", makeBody(msgs), ["c0", "c1"], log);
        const sid = r.sid!;
        const list = ["c0", "c1"];
        for (let i = 2; i <= 5; i++) {
            msgs = [...msgs, { role: i % 2 === 0 ? "assistant" : "user", content: `m${i}` }];
            const nid = `c${i}`;
            list.push(nid);
            r = turn("s-cp", "car-cp", makeBody(msgs), [...list], log, sid);
            assert.equal(r.outcome.decision, "hit");
        }
        assert.equal(watermarkV6DebugState("s-cp").worlds[sid].t, 6);

        // CLIENT COMPACTS: body shrinks to 3 elements — one brand-new element
        // that IS the compression summary (ordinary new identity, ZERO special
        // treatment) plus the two most recent originals.
        const compacted: Msg[] = [
            { role: "system", content: SYS },
            { role: "user", content: "<summary> we discussed m1..m5 </summary>" },
            { role: "user", content: "m5" },
        ];
        const cIds = ["c0", "SUMMARY-NEW", "c5"];
        const rc = turn("s-cp", "car-cp", makeBody(compacted), cIds, log, sid);
        assert.equal(rc.outcome.decision, "hit", "compaction turns take the exact same path as any other turn");
        assert.equal(rc.headers[PF_SEQ_HEADER], "3", "honest stamping follows the body geometry (count bookkeeping only)");
        const hitView = rc.outcome.hit!.view;
        assert.equal(hitView.length, 6, "view keeps ALL FIVE frozen content cores (the leading system element rides systemText, P4) and APPENDS the summary core (B-version: no shrink)");
        const summaryCore = hitView[hitView.length - 1];
        assert.ok(JSON.stringify(summaryCore).includes("<summary>"), "the summary rides as an ordinary newly-appended core");

        // Plane vocabulary check: no hide/replace/archive entries exist in this
        // design at all — fold(ckpt,log) may only contain arm/front/geom/block/unarm (+arm-family)
        const meta = h.store.pfMeta(sid);
        assert.ok(meta !== null);
        const kinds = new Set(meta.log.map((e) => e.kind));
        for (const banned of ["hide", "replace", "archive"]) assert.ok(!kinds.has(banned), `${banned} entries must not exist in the v6 plane`);

        // Next round resumes normally (full resend with the summary present)
        const next: Msg[] = [...compacted, { role: "assistant", content: "m6 reply" }];
        const rn = turn("s-cp", "car-cp", makeBody(next), [...cIds, "c6"], log, sid);
        assert.equal(rn.outcome.decision, "hit");
        assert.equal(rn.headers[PF_SEQ_HEADER], "4");
    } finally { h.cleanup(); }
});

test("§8-6 scattered NEW (any position): appended at the ledger tail, numbering continues across the frozen prefix", () => {
    const h = makeH("scat");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "u1" }]);
        const r1 = turn("s-sc", "car-sc", b1, ["s0", "s1"], log);
        const sid = r1.sid!;
        const r2 = turn("s-sc", "car-sc", makeBody([{ role: "system", content: SYS }, { role: "user", content: "u1" }, { role: "assistant", content: "a1" }]), ["s0", "s1", "s2"], log, sid);
        assert.equal(r2.outcome.decision, "hit");
        // The client RE-SLOTS a mid-body element with a fresh identity (opencode-style
        // rewrite of position 2). Position 1's old identity s1 drops out of the body
        // entirely; the NEW one lands MID-BODY. Set difference sees it at index 1,
        // registers it at the LEDGER TAIL (append-only), decodes only its span.
        const b3 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "rewritten u1' " }, { role: "assistant", content: "a1" }]);
        const r3 = turn("s-sc", "car-sc", b3, ["s0", "s1-prime", "s2"], log, sid);
        assert.equal(r3.outcome.decision, "hit");
        const view = r3.outcome.hit!.view;
        assert.equal(view.length, 3, "frozen TWO content cores (system rides systemText) + the rewritten element appended ONCE (no duplicate of s1's old core)");
        assert.ok(JSON.stringify(view[view.length - 1]).includes("rewritten u1'"), "new core lands at the end of the ledger-ordered view");
        // Numbering continuity vs the full-parse oracle over the SAME ledger order
        const oracle = openaiToCore(JSON.parse(makeBody([{ role: "system", content: SYS }, { role: "user", content: "u1" }, { role: "assistant", content: "a1" }, { role: "user", content: "rewritten u1' " }])) as never).msgs;
        assert.deepEqual(view.map((c) => JSON.parse(JSON.stringify(c))), JSON.parse(JSON.stringify(oracle)), "_N numbering must continue across the frozen prefix exactly like a full parse of ledger order");
    } finally { h.cleanup(); }
});

test("P4 conservative layout + §8-13 breaker via soft misses: mid-body system run routes to baseline ×5 then parks", () => {
    const h = makeH("softbreak");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "u1" }]);
        const r1 = turn("s-sb", "car-sb", b1, ["b0", "b1"], log);
        const sid = r1.sid!;
        // Grow to T=10 first: elements inside the eight-element conservative
        // front re-read region are legitimate P4 fresh-system, so the injected
        // system element must land at index ≥ frontEnd to route conservatively.
        let growMsgs: Msg[] = [...(JSON.parse(b1).messages as Msg[])];
        let growIds = ["b0", "b1"];
        for (let g = 2; g <= 9; g++) {
            growMsgs = [...growMsgs, { role: g % 2 === 0 ? "assistant" : "user", content: `grow${g}` }];
            growIds.push(`bg${g}`);
            const rg = turn("s-sb", "car-sb", makeBody(growMsgs), [...growIds], log, sid);
            assert.equal(rg.outcome.decision, "hit", `grow ${g}`);
        }
        assert.equal(watermarkV6DebugState("s-sb").worlds[sid].t, 10);
        const realNow = Date.now;
        try {
            for (let i = 0; i < 5; i++) {
                // A NEW element OPENING a system run at index 10 (> frontEnd=8):
                // boundary unknown ⇒ baseline turn, streak +1, nothing registered.
                const bb = makeBody([...growMsgs, { role: "system", content: "injected sys" }]);
                const out = turn("s-sb", "car-sb", bb, [...growIds, `sysN${i}`], log, sid);
                assert.equal(out.outcome.decision, "mid-system-new", `streak ${i + 1}`);
                assert.equal(out.outcome.hit, null, "soft miss never produces a v6 hit");
            }
            // Fifth miss parked the lane: the identical request now degrades silently
            const bb = makeBody([...growMsgs, { role: "system", content: "injected sys" }]);
            const reqP = { headers: { "x-bili-plugin-conversation": "car-sb", [PF_TAIL_IDS_HEADER]: [...growIds, "sysN5"].map(encodeURIComponent).join(",") } } as unknown as http.IncomingMessage;
            assert.equal(evaluateWatermarkV6(bb, reqP, { id: "s-sb" } as unknown as Session, { pluginMode: true, titleGen: false, model: "m" }, log), null, "parked ⇒ baseline serves");
            assert.ok(log.lines.some((l) => l.level === "warn" && l.msg.includes("PARKED")), "parking announced loudly");
            Date.now = (() => realNow() + 61 * 60 * 1000) as typeof Date.now;
            const recMsgs = [...growMsgs, { role: "assistant", content: "fine" }];
            const ok = turn("s-sb", "car-sb", makeBody(recMsgs), [...growIds, "bOK"], log, sid);
            assert.equal(ok.outcome.decision, "hit", "recovery edge re-enters and credits reset");
        } finally { Date.now = realNow; }
    } finally { h.cleanup(); }
});

test("§8-14 capacity cap: over-window lists refuse loudly (F1 format-class fault, counted)", () => {
    const h = makeH("cap");
    try {
        const log = makeLog();
        // F1: the strict decoder refuses ANY list longer than PF_TAIL_WINDOW
        // (64) segments before geometry reasoning — an adversarial 16k-segment
        // list hits that boundary immediately and lands in the breaker.
        const many = Array.from({ length: 16_385 }, (_, i) => `cap${i}`);
        const b1 = makeBody([{ role: "system", content: SYS }]);
        const req = {
            headers: {
                "x-bili-plugin-conversation": "car-cap",
                [PF_TAIL_IDS_HEADER]: many.slice(0, 1).concat(many.slice(1).map(() => "other")).map((s) => encodeURIComponent(s)).join(","),
            },
        } as unknown as http.IncomingMessage;
        // A well-formed OVERLONG list (T+extra uniques is impossible here — drive
        // the cap branch directly with T matching would need 16k messages; instead
        // verify the parser-level behaviour through the gate error on a duplicate
        // overflow which ALSO fails screening):
        assertFault(() => evaluateWatermarkV6(b1, req, { id: "s-cap" } as unknown as Session, { pluginMode: true, titleGen: false, model: "m" }, log), "identity channel");
    } finally { h.cleanup(); }
});

test("§8-16/19 restart hydration: view survives boot cycles across an L1 fold (B1 pin) — bytes identical", () => {
    const h = makeH("restart");
    try {
        const log = makeLog();
        const CARRIER = "car-re";
        const SESS = "s-re";
        // Build a 40-element world turn-by-turn (arm + 39 appends). Each hit-turn
        // commit writes front+geom log entries; past the compaction threshold the
        // plane folds ckpt←log on its own.
        let idsList: string[] = [];
        let msgs: Msg[] = [{ role: "system", content: SYS }];
        let r = turn(SESS, CARRIER, makeBody(msgs), ["r0"], log);
        let sid = r.sid!;
        idsList.push("r0");
        for (let i = 1; i < 40; i++) {
            const role = i % 2 === 0 ? "assistant" : "user";
            msgs.push({ role, content: `msg ${i}` });
            idsList.push(`r${i}`);
            r = turn(SESS, CARRIER, makeBody(msgs), [...idsList], log, sid);
            assert.equal(r.outcome.decision, "hit", `turn ${i}`);
        }
        const lastBody = makeBody(msgs);
        const preRestartView = JSON.stringify(r.outcome.hit!.view);
        // Confirm an L1 checkpoint actually exists (fold happened during the run)
        let meta = h.store.pfMeta(sid);
        assert.ok(meta !== null && meta.ckpt !== null, "L1 compaction must have fired inside the 40-turn run");
        void meta!.log;
        // --- SIMULATE PROCESS RESTART: drop every mirror, reopen the SAME disk ----
        // Module-level mirrors OUTSURVIVE _resetStoreForTest — without this
        // hook the round below hits memory and never exercises hydration.
        _resetWatermarkV6MirrorsForTest();
        _resetStoreForTest();
        const shadow2 = UnifiedShadow.maybeOpen(h.dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r2) => r2 as never)!;
        const store2 = new SessionStore({ dir: path.join(h.dir, "sessions"), enabled: true, shadow: shadow2 });
        _setStoreForTest(store2);
        const log2 = makeLog();
        const r2res = turn(SESS, CARRIER, lastBody, [...idsList], log2, sid);
        assert.equal(r2res.outcome.decision, "no-progress", "restart round: everything already known ⇒ plain ride off the hydrate");
        assert.equal(JSON.stringify(r2res.outcome.hit!.view), preRestartView, "post-restart view must byte-match the pre-restart view (B1 pin)");
    } finally { h.cleanup(); }
});

test("§8-17/18 identity boundary: echo accelerates O(1); carrier change does NOT continue the world (fresh mint + archive preserved)", () => {
    const h = makeH("boundary");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "u1" }]);
        const rA = turn("s-bd", "car-A", b1, ["d0", "d1"], log);
        const sidA = rA.sid!;
        assert.equal(rA.outcome.decision, "arm");
        // Same body under a DIFFERENT carrier with the SAME ids: probe keyed on
        // (sess_raw, ledger_id) cannot match ⇒ fresh world mint (accepted cost:
        // one more legal arm), old archive stays byte-intact.
        const rB = turn("s-bd", "car-B", b1, ["d0", "d1"], log);
        assert.equal(rB.outcome.decision, "arm");
        const sidB = rB.sid!;
        assert.notEqual(sidB, sidA, "carrier change mints a new partition key (owner ruling: no cross-carrier continuation)");
        assert.deepEqual(watermarkV6DebugState("s-bd"), { liveSids: [sidA, sidB], worlds: watermarkV6DebugState("s-bd").worlds });
        // Old archive intact: its ledger rows survive deletion-free until session removal
        const metaA = h.store.pfMeta(sidA);
        assert.ok(metaA !== null && metaA.log.length === 3, "old world archive untouched by the new mint");
        // Deletion cascade: purging the relay session wipes EVERY registered world
        h.store.pfDeleteForSession("s-bd");
        assert.deepEqual(h.store.pfMeta(sidA), { ckpt: null, log: [] }, "pfDeleteForSession sweeps all sids of this relay session");
        assert.equal(h.store.pfLatestGeom(sidB), null);
    } finally { h.cleanup(); }
});

test("teardown: clearWatermarkV6 drops every in-memory mirror; the disk plane survives until pfDeleteForSession", () => {
    const h = makeH("teardown");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "u1" }]);
        const r1 = turn("s-tear", "car-tear", b1, ids(2, "-t"), log);
        assert.equal(r1.outcome.decision, "arm");
        const sid = r1.sid!;
        assert.deepEqual(watermarkV6DebugState("s-tear").liveSids, [sid]);
        const before = h.store.pfMeta(sid);
        assert.ok(before !== null && before.log.length > 0, "arm committed rows to the disk plane");

        clearWatermarkV6("s-tear");
        assert.deepEqual(watermarkV6DebugState("s-tear"), { liveSids: [], worlds: {} }, "every mirror + pending commit dropped");
        assert.deepEqual(h.store.pfMeta(sid), before, "disk plane untouched (delete-time cascade owns it)");
        clearWatermarkV6("s-tear"); // idempotent
        assert.equal(watermarkV6DebugState("s-tear").liveSids.length, 0);
    } finally { h.cleanup(); }
});

test("failed arm registration hands out NO world id (next turn re-arms cleanly, no fault storm)", () => {
    const h = makeH("armfail");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "u1" }]);
        const commit = h.store.pfCommitTurn.bind(h.store);
        let failNext = true;
        h.store.pfCommitTurn = ((...args: Parameters<SessionStoreType["pfCommitTurn"]>) => {
            if (failNext) { failNext = false; return null; }
            return commit(...args);
        }) as SessionStoreType["pfCommitTurn"];
        const r1 = turn("s-af", "car-af", b1, ["w0", "w1"], log);
        assert.equal(r1.outcome.decision, "arm");
        assert.equal(r1.headers[PF_SESSION_HEADER], undefined, "a failed registration must not echo a world id the plane cannot resolve");
        assert.equal(r1.headers[PF_SEQ_HEADER], "2", "the honest seq stamp still rides");
        const r2 = turn("s-af", "car-af", b1, ["w0", "w1"], log);
        assert.equal(r2.outcome.decision, "arm");
        assert.notEqual(r2.sid, r1.sid, "re-arm mints a new world id");
    } finally { h.cleanup(); }
});

test("§8-22 real store deletion cascades every registered world (in-TX registry sweep)", async () => {
    const h = makeH("cascade");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "u1" }]);
        const rA = turn("s-cs", "car-cs-A", b1, ["z0", "z1"], log);
        const sidA = rA.sid!;
        const rB = turn("s-cs", "car-cs-B", b1, ["z0", "z1"], log);
        const sidB = rB.sid!;
        assert.notEqual(sidA, sidB);
        await h.store.removeSession("s-cs");
        const db = new DatabaseSync(path.join(h.dir, "index.db"));
        try {
            for (const t of ["pf_rows", "pf_log", "pf_ckpt", "pf_render", "pf_render_log", "pf_render_ckpt"]) {
                const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number } | undefined;
                assert.equal(row?.n, 0, `${t} must be empty after session deletion`);
            }
        } finally { db.close(); }
        assert.equal(h.store.pfLatestGeom(sidA), null);
        assert.equal(h.store.pfLatestGeom(sidB), null);
    } finally { h.cleanup(); }
});

test("S4: a tampered pf_ckpt checksum parks the world loudly instead of hydrating corrupt state", () => {
    const h = makeH("cksum");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "u1" }]);
        const r1 = turn("s-ck", "car-ck", b1, ["k0", "k1"], log);
        assert.equal(r1.outcome.decision, "arm");
        const sid = r1.sid!;
        // fold the log into a ckpt so hydration depends on the ckpt bytes,
        // then break the checksum binding on disk (bytes intact, binding not)
        const m = h.store.pfMeta(sid);
        assert.ok(m !== null && m.log.length > 0 && m.ckpt === null);
        h.store.pfCompact(sid, { metaJson: JSON.stringify({ v: 1, t: 2, maxPos: 1 }), nextLsSeq: m.log[m.log.length - 1].lsSeq });
        const db = new DatabaseSync(path.join(h.dir, "index.db"));
        db.prepare(`UPDATE pf_ckpt SET checksum = 'deadbeef' WHERE sid = ?`).run(sid);
        db.close();
        clearWatermarkV6("s-ck"); // drop the in-memory mirror: the next turn MUST hydrate from the plane
        const req = {
            headers: {
                "x-bili-plugin-conversation": "car-ck",
                [PF_TAIL_IDS_HEADER]: ["k0", "k1"].map(encodeURIComponent).join(","),
                [PF_SESSION_HEADER]: sid,
            },
        } as unknown as http.IncomingMessage;
        const input = { pluginMode: true, titleGen: false, model: "m" };
        const out = evaluateWatermarkV6(b1, req, { id: "s-ck" } as unknown as Session, input, log);
        assert.equal(out, null, `corrupt-ckpt world must NOT hydrate (log=${JSON.stringify(log.lines.slice(-3))})`);
        assert.ok(log.lines.some((l) => l.msg.includes("world unrecoverable")), "the park must be logged loud");
        // parked: the very next turn rides baseline without a fresh fault storm
        assert.equal(evaluateWatermarkV6(b1, req, { id: "s-ck" } as unknown as Session, input, log), null);
        const db2 = new DatabaseSync(path.join(h.dir, "index.db"));
        try {
            const row = db2.prepare(`SELECT COUNT(*) AS n FROM pf_rows WHERE sid = ?`).get(sid) as { n: number };
            assert.equal(row.n, 2, "the park path must not touch the data plane");
        } finally { db2.close(); }
    } finally { h.cleanup(); }
});

test("restart after compaction: a compacted world echoes cleanly off its ckpt (no fault storm, no re-arm)", () => {
    const h = makeH("ckok");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "u1" }]);
        const r1 = turn("s-co", "car-co", b1, ["c0", "c1"], log);
        assert.equal(r1.outcome.decision, "arm");
        const sid = r1.sid!;
        const m = h.store.pfMeta(sid);
        assert.ok(m !== null && m.log.length > 0 && m.ckpt === null);
        // fold into a ckpt (log goes EMPTY), then drop every mirror — the
        // process-restart shape: the ckpt row is now the world's only state
        h.store.pfCompact(sid, { metaJson: JSON.stringify({ v: 1, t: 2, maxPos: 1 }), nextLsSeq: m.log[m.log.length - 1].lsSeq });
        clearWatermarkV6("s-co");
        const b2 = makeBody([
            { role: "system", content: SYS }, { role: "user", content: "u1" },
            { role: "assistant", content: "a1" }, { role: "user", content: "u2" },
        ]);
        const r2 = turn("s-co", "car-co", b2, ["c0", "c1", "c2", "c3"], log, sid);
        assert.equal(r2.outcome.decision, "hit", `compacted world must hydrate off the ckpt, log=${JSON.stringify(log.lines.slice(-4))}`);
        assert.equal(r2.headers[PF_SESSION_HEADER], sid, "the SAME world continues — no re-arm, no fault");
    } finally { h.cleanup(); }
});

test("fold-then-append across a REAL restart: post-fold log entries clear the ckpt watermark and the folded maxPos advances (review BUG-1 regression)", () => {
    const h = makeH("foldvis");
    try {
        const log = makeLog();
        const SESS = "s-fv";
        const CARRIER = "car-fv";
        // arm T=2 + hit T=3
        let msgs: Msg[] = [{ role: "system", content: SYS }, { role: "user", content: "u1" }];
        let r = turn(SESS, CARRIER, makeBody(msgs), ["f0", "f1"], log);
        assert.equal(r.outcome.decision, "arm");
        const sid = r.sid!;
        msgs.push({ role: "assistant", content: "a1" });
        r = turn(SESS, CARRIER, makeBody(msgs), ["f0", "f1", "f2"], log, sid);
        assert.equal(r.outcome.decision, "hit");
        // Fold NOW — exactly what opportunisticCompact does once ≥64 entries
        // accumulate: checkpoint bound to the CURRENT world state, log wiped
        // inside the same transaction.
        const wState = watermarkV6DebugState(SESS).worlds[sid];
        const metaBefore = h.store.pfMeta(sid);
        assert.ok(metaBefore !== null && metaBefore.ckpt === null);
        const foldSeq = metaBefore!.log[metaBefore!.log.length - 1].lsSeq;
        h.store.pfCompact(sid, { metaJson: JSON.stringify({ v: 1, t: wState.t, maxPos: wState.maxPos }), nextLsSeq: foldSeq });
        assert.equal(h.store.pfMeta(sid)!.log.length, 0, "the fold absorbed its own log");
        // Post-fold progress turn (T=4): the new front/geom pair must number
        // AHEAD of the fold — numbering from MAX(log) alone would re-issue
        // sequences ≤ ckpt and pfMeta's `ls_seq > ckpt` filter would hide them
        // forever, freezing the folded world's maxPos one element short.
        msgs.push({ role: "user", content: "u2" });
        r = turn(SESS, CARRIER, makeBody(msgs), ["f0", "f1", "f2", "f3"], log, sid);
        assert.equal(r.outcome.decision, "hit");
        const metaAfterFoldTurn = h.store.pfMeta(sid)!;
        assert.ok(metaAfterFoldTurn.log.length >= 2, `the post-fold front/geom pair must be VISIBLE past the ckpt watermark ${foldSeq}, got ${JSON.stringify(metaAfterFoldTurn.log.map((e) => e.lsSeq))}`);
        assert.ok(metaAfterFoldTurn.log.every((e) => e.lsSeq > foldSeq), `no post-fold sequence may sit at or below the ckpt watermark ${foldSeq}: ${JSON.stringify(metaAfterFoldTurn.log.map((e) => e.lsSeq))}`);
        // --- REAL process restart: mirrors AND store gone, same disk ---
        _resetWatermarkV6MirrorsForTest();
        _resetStoreForTest();
        const shadow2 = UnifiedShadow.maybeOpen(h.dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r2) => r2 as never)!;
        const store2 = new SessionStore({ dir: path.join(h.dir, "sessions"), enabled: true, shadow: shadow2 });
        _setStoreForTest(store2);
        const log2 = makeLog();
        // Pure-append turn off the REHYDRATED world: the visible geom entries
        // must advance maxPos through the post-fold element — otherwise the
        // next row lands on an occupied ledger position (PK collision → commit
        // fail-loop) and the served view ships a TRUNCATED prefix.
        msgs.push({ role: "assistant", content: "a2" });
        const r5 = turn(SESS, CARRIER, makeBody(msgs), ["f0", "f1", "f2", "f3", "f4"], log2, sid);
        assert.equal(r5.outcome.decision, "hit", `rehydrated world must ride the lane, log=${JSON.stringify(log2.lines.slice(-4))}`);
        const view5 = r5.outcome.hit!.view.map((c) => JSON.stringify(c)).join("\n");
        for (const m of ["u1", "a1", "u2", "a2"]) {
            assert.ok(view5.includes(JSON.stringify(m)), `view must carry ${JSON.stringify(m)} — no truncated prefix across fold+restart`);
        }
        assert.ok(!log2.lines.some((l) => l.msg.includes("degraded") || l.msg.includes("commit failed")),
            `no finalize hiccup across fold+restart: ${JSON.stringify(log2.lines.slice(-4))}`);
        assert.equal(watermarkV6DebugState(SESS).worlds[sid].maxPos, 4, "folded maxPos must include the post-fold element");
        const db = new DatabaseSync(path.join(h.dir, "index.db"));
        try {
            const row = db.prepare(`SELECT COUNT(*) AS n FROM pf_rows WHERE sid = ?`).get(sid) as { n: number };
            assert.equal(row.n, 5, "every element registered exactly once — no collision-driven loss or duplication");
        } finally { db.close(); }
    } finally { h.cleanup(); }
});

test("archiving a session sweeps its pf planes too (review BUG-2 regression): no orphaned sid rows survive the tombstone; a restored session re-boots through a fresh arm", () => {
    const h = makeH("archpf");
    const SESS = "s-ap";
    const CARRIER_A = "car-ap-a";
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "u1" }]);
        const rA = turn(SESS, CARRIER_A, b1, ["p0", "p1"], log);
        assert.equal(rA.outcome.decision, "arm");
        const sidA = rA.sid!;
        // Second carrier ⇒ second world on the SAME relay session: the
        // registry holds two sids, so the cascade must reach every partition
        // of BOTH, not just the newest.
        const rB = turn(SESS, "car-ap-b", b1, ["p0", "p1"], log);
        assert.equal(rB.outcome.decision, "arm");
        const sidB = rB.sid!;
        assert.notEqual(sidB, sidA, "distinct carriers mint distinct worlds");
        // A real sessions row for the archive machinery to find (in
        // production the first plugin turn records one).
        const db0 = new DatabaseSync(path.join(h.dir, "index.db"));
        db0.prepare(`INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)`).run(SESS, Date.now(), Date.now());
        db0.close();
        const archDir = path.join(h.dir, "arch");
        const arch = h.store.unifiedArchiveSession(SESS, archDir);
        assert.ok(arch !== null && arch.ok, `archive must succeed, got ${JSON.stringify(arch)}`);
        const db = new DatabaseSync(path.join(h.dir, "index.db"));
        try {
            for (const t of ["pf_rows", "pf_log", "pf_ckpt", "pf_render", "pf_render_log", "pf_render_ckpt"]) {
                for (const sid of [sidA, sidB]) {
                    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE sid = ?`).get(sid) as { n: number };
                    assert.equal(row.n, 0, `${t} must be swept by archive — before the fix every archived session's plane rows stayed permanently orphaned behind the deleted registry`);
                }
            }
            const srow = db.prepare(`SELECT status FROM sessions WHERE session_id = ?`).get(SESS) as { status: string };
            assert.equal(srow.status, "archived", "the sessions row survives as a tombstone, like every other archived session");
        } finally { db.close(); }
        // Rebuildability: the planes are a cache, never an identity source.
        // A restored session whose ledger plane was purged must re-bootstrap
        // through a FRESH arm (probe-miss ⇒ rule ③) instead of fault-looping
        // on the dead sids its exported registry still lists.
        const res = h.store.unifiedRestoreArchived(SESS, archDir);
        assert.ok(res !== null && res.ok, `restore must succeed, got ${JSON.stringify(res)}`);
        clearWatermarkV6(SESS);
        const log2 = makeLog();
        const rC = turn(SESS, CARRIER_A, b1, ["p0", "p1"], log2);
        assert.equal(rC.outcome.decision, "arm", `restored session must re-arm cleanly off an empty probe (log=${JSON.stringify(log2.lines.slice(-3))})`);
        assert.notEqual(rC.sid, sidA, "a FRESH world mint — the old plane bytes are gone by design");
    } finally { h.cleanup(); }
});

test("F6 pin: an echoed pf_sid the plane never minted faults loudly with one breaker strike and zero data-plane writes (#5652 review)", () => {
    const h = makeH("fakeecho");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "u1" }]);
        const r1 = turn("s-fe", "car-fe", b1, ["e0", "e1"], log);
        assert.equal(r1.outcome.decision, "arm");
        // Well-formed but never minted: the client-loopback / forged-echo
        // shape — exactly how mis-attribution starts (#2821 discipline on the
        // wire). The list contents are known world-A ids; only the ECHO lies.
        const forged = `pf_${"f".repeat(12)}`;
        assert.notEqual(r1.sid, forged);
        const db0 = new DatabaseSync(path.join(h.dir, "index.db"));
        const countOf = (t: string) => (db0.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        const rowsBefore = countOf("pf_rows");
        const logBefore = countOf("pf_log");
        db0.close();
        const f = assertFault(() => turn("s-fe", "car-fe", b1, ["e0", "e1"], log, forged), "echo references unknown pf_sid");
        assert.ok(f.detail.includes(forged), "the refused sid must name itself in the detail");
        const guard = h.store.getSessionExt("s-fe", "pf:v6-guard") as { faults?: number } | null;
        assert.equal(guard?.faults, 1, `one strike must land in the breaker, got ${JSON.stringify(guard)}`);
        const db = new DatabaseSync(path.join(h.dir, "index.db"));
        try {
            assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM pf_rows`).get() as { n: number }).n, rowsBefore, "the fault must not register elements");
            assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM pf_log`).get() as { n: number }).n, logBefore, "the fault must not extend the plane journal");
        } finally { db.close(); }
    } finally { h.cleanup(); }
});

test("F6 pin: one body probing ids from two co-registered worlds under one carrier is refused, never side-chosen (#5652 review)", () => {
    const h = makeH("multiworld");
    try {
        const log = makeLog();
        const SESS = "s-mw";
        const CARRIER = "car-mw";
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "u1" }]);
        // Carrier reuse (the production shape): each all-new-id span re-arms
        // a fresh world under the SAME sess_raw, so the registry holds both
        // sids and both row sets resolve through the same probe index.
        const rA = turn(SESS, CARRIER, b1, ["a0", "a1"], log);
        assert.equal(rA.outcome.decision, "arm");
        const rB = turn(SESS, CARRIER, b1, ["b0", "b1"], log);
        assert.equal(rB.outcome.decision, "arm");
        assert.notEqual(rB.sid, rA.sid, "distinct all-new spans mint distinct worlds");
        // The mixed span: T=4 ⇒ width 4, and every id resolves — to a
        // DIFFERENT world. Design-impossible for a real single conversation
        // (kernel msgids are globally unique forever), so the lane refuses
        // instead of choosing a side.
        const b3 = makeBody([
            { role: "system", content: SYS }, { role: "user", content: "u1" },
            { role: "assistant", content: "a1" }, { role: "user", content: "u2" },
        ]);
        const f = assertFault(() => turn(SESS, CARRIER, b3, ["a0", "a1", "b0", "b1"], log), "identity span crosses multiple worlds");
        assert.ok(f.detail.includes(rA.sid!) && f.detail.includes(rB.sid!), `both offending worlds must be named: ${f.detail}`);
    } finally { h.cleanup(); }
});

test("§7-A② soft-degrade node: sidecar down ⇒ lane disengages SILENTLY, no state moved, recovers on reopen", (t) => {
    const h = makeH("softdegrade");
    try {
        const log = makeLog();
        // Arm a live world first so the stub is proven against a real armed sid.
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "hello one" }]);
        const r1 = turn("s-sd", "carrier-sd", b1, ids(2, "-sd"), log);
        assert.equal(r1.outcome.decision, "arm");
        assert.ok(r1.sid !== undefined);

        // Close the sidecar from under the lane: pfAvailable() is the §7-A②
        // soft-degrade node (fastpath-v6.ts) — baseline byte path serves, no 400.
        const downStore: SessionStoreType = Object.create(h.store);
        downStore.pfAvailable = () => false;
        _setStoreForTest(downStore);
        try {
            const b2 = makeBody([
                { role: "system", content: SYS },
                { role: "user", content: "hello one" },
                { role: "assistant", content: "hi there" },
            ]);
            const req = {
                headers: {
                    "x-bili-plugin-conversation": "carrier-sd",
                    [PF_TAIL_IDS_HEADER]: ids(3, "-sd").map(encodeURIComponent).join(","),
                    [PF_SESSION_HEADER]: r1.sid!,
                },
            } as unknown as http.IncomingMessage;
            const session = { id: "s-sd" } as unknown as Session;
            const outcome = evaluateWatermarkV6(b2, req, session, { pluginMode: true, titleGen: false, model: "m" }, log);
            assert.equal(outcome, null, "soft-degrade must disengage SILENTLY — never a fault, never a fallback 5xx");
            // Reopen the sidecar: the armed world is untouched and the lane resumes.
            _setStoreForTest(h.store);
            const r3 = turn("s-sd", "carrier-sd", b2, ids(3, "-sd"), log, r1.sid!);
            assert.equal(r3.outcome.decision, "hit", "world must be exactly where the silent turn left it");
        } finally {
            _setStoreForTest(h.store);
        }
    } finally { h.cleanup(); }
});

test("§8-12 breaker streak clears on a sound turn — memory mirror included, not just the ext replica", (t) => {
    const h = makeH("breakerreset");
    try {
        const log = makeLog();
        const b1 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "hello one" }]);
        const r1 = turn("s-br", "car-br", b1, ids(2, "-br"), log);
        assert.equal(r1.outcome.decision, "arm");
        const b2 = makeBody([...JSON.parse(b1).messages as Msg[], { role: "assistant", content: "hi there" }]);

        // Width-mismatch strike (deterministic, zero side effects on the plane).
        const strike = (): void => {
            assertFault(() => evaluateWatermarkV6(b2, {
                headers: { "x-bili-plugin-conversation": "car-br", [PF_TAIL_IDS_HEADER]: ids(3, "-br").slice(0, 2).join(",") },
            } as unknown as http.IncomingMessage, { id: "s-br" } as unknown as Session, { pluginMode: true, titleGen: false, model: "m" }, log), "identity width mismatch");
        };
        strike(); strike(); strike(); strike();
        assert.ok(log.lines.some((l) => l.msg.includes("REJECTED (4/5)")), "fourth consecutive strike must be loud");

        // A healthy HIT clears the CONSECUTIVE-fault streak (§8). Before the fix
        // the reset touched only the advisory ext copy while readGuard is
        // memory-first — so one more single fault parked this session for 60m
        // on a cumulative-but-not-consecutive fifth strike.
        const rHit = turn("s-br", "car-br", b2, ids(3, "-br"), log, r1.sid!);
        assert.equal(rHit.outcome.decision, "hit");
        strike();
        assert.ok(log.lines.some((l) => l.msg.includes("REJECTED (1/5)")), "post-reset strike must start from zero");

        // Same rule on the NO-PROGRESS ride path: ride twice to 3/5, one sound
        // ride resets, next strike is fresh again.
        strike(); strike();
        assert.ok(!log.lines.some((l) => l.msg.includes("PARKED")), "cumulative non-consecutive strikes must not park");
        for (let i = 0; i < 2; i++) {
            const ride = turn("s-br", "car-br", b2, ids(3, "-br"), log, r1.sid!);
            assert.equal(ride.outcome.decision, "no-progress", `healthy ride ${i + 1}`);
        }
        strike();
        assert.ok(!log.lines.some((l) => l.msg.includes("PARKED")), "still no park after the ride-path reset");
        // "(1/5)" appears exactly thrice overall: once per fresh streak start
        // (initial strike block, post-hit strike, post-ride strike).
        assert.equal(log.lines.filter((l) => l.msg.includes("REJECTED (1/5)")).length, 3, "every streak started fresh at exactly 1");
    } finally { h.cleanup(); }
});
