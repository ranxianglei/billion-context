// #5760 — fastpath v6: tunnel-origin exclusion at the identity hard gate.
//
// The v6 lane's identity hard gate (§3.2) is fail-loud by design on the
// premise "lane traffic always comes from a native shim that stamps the
// pf-* handshake". That premise holds only OFF-tunnel: /bili/ tunnel
// traffic (prefix/attach mode) is a plain HTTP client with no in-process
// fetch interception, so an absent identity channel there is STRUCTURAL —
// pre-fix every turn 400'd the session (five refusals then a park, repeat).
// The gate now excludes such requests from the cohort (silent pass to the
// v5/legacy lanes, same treatment as the carrier-absent exclusion) while
// keeping every other fault class byte-identical for ALL origins.
//
// Gate discipline (#3617) — both directions asserted:
//   NOT triggered: tunnel + absent channel → soft exclusion (no fault, no
//                  park, no world); tunnel + sound channel → lane engages.
//   Triggered:     non-tunnel + absent channel → 400 fault; tunnel +
//                  present-but-bad channel → 400 fault.
//
// Harness mirrors fastpath-v6-msgid.test.ts: unit-level against a REAL
// sqlite sidecar (UnifiedShadow shadow mode + SessionStore seam); only the
// HTTP layer is skipped (the 400 mapping lives in handle.ts).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import type { SessionStore as SessionStoreType } from "../src/persist.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import type { Session } from "../src/session.ts";
import { evaluateWatermarkV6, finalizeWatermarkV6, FastpathV6IdentityFault, watermarkV6DebugState, PF_SESSION_HEADER } from "../src/server/fastpath-v6.ts";
import { PF_SEQ_HEADER, PF_TAIL_IDS_HEADER } from "../src/server/fastpath.ts";
import type { V6Outcome } from "../src/server/fastpath-v6.ts";

const ENV = "BILI_ROLLOUT_WATERMARK_V6_MSG_ID";

interface Msg { role: string; content: string }

function makeBody(messages: Msg[]): string {
    return JSON.stringify({ model: "m", messages });
}

const SYS = "sys tun";

type LogSink = { lines: { level: string; msg: string }[] } & ((level: string, msg: string) => void);
function makeLog(): LogSink {
    const l = { lines: [] as { level: string; msg: string }[] };
    return Object.assign((level: string, msg: string) => { l.lines.push({ level, msg }); }, { lines: l.lines });
}

interface H { dir: string; store: SessionStoreType; cleanup: () => void }

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

/** Direct evaluate without the engage assertion (exclusion paths expect null). */
function v6(
    sessId: string, bodyText: string, headers: Record<string, string>, log: LogSink, tunnelOrigin?: boolean,
): V6Outcome | null {
    const req = { headers } as unknown as http.IncomingMessage;
    const session = { id: sessId } as unknown as Session;
    return evaluateWatermarkV6(bodyText, req, session, { pluginMode: true, titleGen: false, model: "m", tunnelOrigin }, log);
}

interface TurnResult { outcome: V6Outcome; headers: Record<string, string>; sid: string | undefined }

/** Engage-asserting turn over the tunnel origin (shimmed host routed via /bili/). */
function turnTunnel(
    sessId: string, carrier: string, bodyText: string, idList: string[], log: LogSink, echoSid?: string,
): TurnResult {
    const headers: Record<string, string> = { "x-bili-plugin-conversation": carrier };
    if (idList.length > 0) headers[PF_TAIL_IDS_HEADER] = idList.map(encodeURIComponent).join(",");
    if (echoSid !== undefined) headers[PF_SESSION_HEADER] = echoSid;
    const req = { headers } as unknown as http.IncomingMessage;
    const session = { id: sessId } as unknown as Session;
    const outcome = evaluateWatermarkV6(bodyText, req, session, { pluginMode: true, titleGen: false, model: "m", tunnelOrigin: true }, log);
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

const B2 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "one" }]);
const CARRIER_HDR = "x-bili-plugin-conversation";

test("tunnel-origin + carrier + ABSENT channel → cohort exclusion: null, no fault, no park, no world, no loud log", () => {
    const h = makeH("tun-excl");
    try {
        const log = makeLog();
        const hdrs = { [CARRIER_HDR]: "car-tx" };
        // Six consecutive absent-channel turns: pre-fix this was 4×400 then
        // a 60-minute PARK (and the cycle repeats after the hold expires).
        for (let i = 0; i < 6; i++) {
            assert.equal(v6("s-tx", B2, hdrs, log, true), null, `turn ${i}: structural exclusion must be a silent baseline pass`);
        }
        assert.equal(h.store.getSessionExt("s-tx", "pf:v6-guard"), undefined, "exclusions never touch the breaker ledger");
        assert.equal(watermarkV6DebugState("s-tx").liveSids.length, 0, "no world minted by any excluded turn");
        assert.ok(!log.lines.some((l) => l.level === "error" || l.level === "warn"), "exclusion stays out of error/warn (cohort exclusions pass silently)");
        assert.ok(log.lines.some((l) => l.level === "debug" && l.msg.includes("tunnel-origin")), "the exclusion itself is greppable at debug level");
    } finally { h.cleanup(); }
});

test("non-tunnel (default AND explicit false) + carrier + absent channel → hard 400 UNCHANGED: the fix must not weaken the off-tunnel gate", () => {
    const h = makeH("tun-fault");
    try {
        const log = makeLog();
        const hdrs = { [CARRIER_HDR]: "car-nf" };
        assertFault(() => v6("s-nf", B2, hdrs, log), "identity channel incomplete");
        assertFault(() => v6("s-nf2", B2, hdrs, log, false), "identity channel incomplete");
        assert.equal((h.store.getSessionExt("s-nf", "pf:v6-guard") as { faults?: number } | undefined)?.faults, 1, "off-tunnel absence still feeds the breaker exactly once per refusal");
        assert.equal((h.store.getSessionExt("s-nf2", "pf:v6-guard") as { faults?: number } | undefined)?.faults, 1, "the explicit-false twin carries its OWN session ledger (one fault from its own refusal, nothing shared with s-nf)");
    } finally { h.cleanup(); }
});

test("tunnel-origin WITH a sound channel (shimmed host routed through /bili/) → lane engages normally: arm then hit", () => {
    const h = makeH("tun-shim");
    try {
        const log = makeLog();
        const I2 = ["t0", "t1"];
        const r1 = turnTunnel("s-ts", "car-ts", B2, I2, log);
        assert.equal(r1.outcome.decision, "arm");
        assert.match(r1.sid ?? "", /^pf_[0-9a-f]{12}$/u);
        assert.equal(r1.headers[PF_SEQ_HEADER], "2");
        const sid = r1.sid!;

        const b3 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "one" }, { role: "assistant", content: "hi" }]);
        const r2 = turnTunnel("s-ts", "car-ts", b3, [...I2, "t2"], log, sid);
        assert.equal(r2.outcome.decision, "hit", "tunnel traffic carrying the full channel rides the lane like any other");
        assert.equal(r2.outcome.hit!.totalT, 3);
    } finally { h.cleanup(); }
});

test("tunnel-origin + PRESENT-but-bad channel → still faults for every origin (malformed member, width mismatch)", () => {
    const h = makeH("tun-bad");
    try {
        const log = makeLog();
        const b3 = makeBody([{ role: "system", content: SYS }, { role: "user", content: "one" }, { role: "user", content: "two" }]);
        // A client that PRESENTS the channel submits to its strict
        // validation regardless of where the request arrived from.
        assertFault(
            () => v6("s-tm", b3, { [CARRIER_HDR]: "car-tm", [PF_TAIL_IDS_HEADER]: "?,a2,a3" }, log, true),
            "identity channel malformed",
        );
        assertFault(
            () => v6("s-tw", b3, { [CARRIER_HDR]: "car-tw", [PF_TAIL_IDS_HEADER]: "a1,a2" }, log, true),
            "identity width mismatch",
        );
    } finally { h.cleanup(); }
});

test("breaker isolation: ten excluded turns never park the lane — a later sound-channel turn on the SAME session arms cleanly", () => {
    const h = makeH("tun-park");
    try {
        const log = makeLog();
        const hdrs = { [CARRIER_HDR]: "car-pk" };
        for (let i = 0; i < 10; i++) {
            assert.equal(v6("s-pk", B2, hdrs, log, true), null, `excluded turn ${i}`);
        }
        const r = turnTunnel("s-pk", "car-pk", B2, ["p0", "p1"], log);
        assert.equal(r.outcome.decision, "arm", "no residual park state from the excluded history");
        const g = h.store.getSessionExt("s-pk", "pf:v6-guard") as { faults?: number; disabledAt?: number } | undefined;
        assert.equal(g?.faults ?? 0, 0, "the excluded history counted ZERO faults (a healthy arm turn may reset the counter, never increment it)");
        assert.equal(g?.disabledAt, undefined, "never parked");
    } finally { h.cleanup(); }
});
