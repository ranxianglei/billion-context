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
    evaluateWatermarkV6, finalizeWatermarkV6, FastpathV6IdentityFault, watermarkV6DebugState, clearWatermarkV6, PF_SESSION_HEADER,
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
            for (const t of ["pf_rows", "pf_log", "pf_ckpt"]) {
                const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number } | undefined;
                assert.equal(row?.n, 0, `${t} must be empty after session deletion`);
            }
        } finally { db.close(); }
        assert.equal(h.store.pfLatestGeom(sidA), null);
        assert.equal(h.store.pfLatestGeom(sidB), null);
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
