// #5826 release-review gap fix (owner ruling 2026-11-07): the sessionid+msgid
// identity substrate is public infrastructure consumed by five lanes (store
// pin, session-resolve last-resort rung, settlement membership probe,
// incremental-lane canonical rows, watermark tail-id continuity), yet its id
// hygiene rules live in SIX hand-maintained copies — the host bundles are
// injected into foreign runtimes and MUST NOT import server modules, so
// mirroring is structural, not laziness. This pin turns the "keep them in
// sync" comments (src/msgid-pin.ts, src/agent/dsh-native.ts,
// src/agent/incremental-client.ts, src/agent/pf-channel.ts) into CI: every
// reject class is fed through every implementation and the CURRENT verdict is
// asserted. Deliberate divergences are pinned AS DIVERGENT below — change any
// copy's rules and this file fails until you consciously re-pin it here.
import { test } from "node:test";
import assert from "node:assert/strict";

import { MSG_IDS_BODY_FIELD, incomingMsgIdsOf, validateMsgIds } from "../src/msgid-pin.js";
import { collectRequestIds } from "../src/request-membership.js";
import { PF_SLOT_UNKNOWN, pfCaptureIds, pfLearnStamp, pfRequestHeaders } from "../src/agent/pf-channel.js";
import { _hostMsgIdsOfForTest, _pfSlotIdsOfForTest } from "../src/agent/dsh-native.js";
import { _screenMsgIdsForTest } from "../src/agent/incremental-client.js";
import { _parseTailIdsForTest } from "../src/server/fastpath.js";

const GOOD = "h_deadbeefcafe0001";
const GOOD2 = "h_cafebabe12345678";
const RES = "acp_summary_anchor1";
const CFC = "zero\u200bwidth"; // Cf format char: \p{C} yes, ASCII-C0 range no

// Shared reject-class set (the classes the canonical validator names).
type EntryCase = { name: string; value: unknown; /** raw wire decode can't express "non-string" post-decode */ noWire?: boolean; /** passes the LENIENT inbound collector by design */ inboundPasses?: boolean };
const REJECTS: EntryCase[] = [
    { name: "non-string entry", value: 42, noWire: true },
    { name: "null entry", value: null, noWire: true },
    { name: "empty string", value: "" },
    { name: "over-long (513)", value: "x".repeat(513) },
    { name: "reserved kernel prefix", value: RES },
    { name: "space inside id", value: "a b" },
    { name: "tab inside id", value: "a\tb" },
    { name: "ascii control \\u0001", value: "a\u0001b" },
];
// Boundary cases pinned separately because their verdict differs between
// copies BY DESIGN (see the expectation notes below):
const CF_CASE: EntryCase = { name: "unicode format U+200B (\\p{C} only)", value: CFC, inboundPasses: true };
const DUP_ALONE: EntryCase = { name: "duplicate / alone", value: [GOOD, GOOD], inboundPasses: true }; // lenient-only again: no dedupe gate
const DUP_MIXED: EntryCase = { name: "duplicate / mixed", value: [GOOD, GOOD2, GOOD], inboundPasses: true };

const LONG_LIST = Array.from({ length: 2049 }, (_, i) => `bulk_${i}_abcdef00`); // > pf-channel MAX_IDS (2048); the strict validators have NO cap today

function objForm(values: unknown[]): Array<{ id?: unknown }> {
    return values.map((v) => ({ id: v }));
}

test("all-or-nothing collectors reject every shared class identically (#5826 parity)", () => {
    // Every case runs TWICE: once as a pure-id array and once with ONE good
    // neighbour appended, so "degrades over mispair" cannot hide behind a
    // short-list shortcut anywhere.
    const cases: EntryCase[] = [];
    for (const r of [...REJECTS, CF_CASE]) {
        const mk = (suffix: string): EntryCase => ({ name: `${r.name} / ${suffix}`, value: suffix === "alone" ? [r.value] : [GOOD, r.value], noWire: r.noWire, inboundPasses: r.inboundPasses });
        cases.push(mk("alone"), mk("mixed"));
    }
    for (const c of [...cases, DUP_ALONE, DUP_MIXED]) {
        const values = c.value as unknown[];
        // Canonical: src/msgid-pin.ts validateMsgIds — length aligned.
        assert.equal(validateMsgIds(values, values.length).ok, false, `validateMsgIds ${c.name}`);
        // dsh host collector (host bundle mirror).
        assert.equal(_hostMsgIdsOfForTest(objForm(values)), undefined, `hostMsgIdsOf ${c.name}`);
        // incremental-client pre-screen (host bundle mirror).
        assert.equal(_screenMsgIdsForTest(values), false, `screenMsgIds ${c.name}`);
        // #5719 last-resort-rung input (lenient ONLY in width: any-length
        // arrays allowed, and NO dedupe gate): entry screening is still
        // all-or-nothing except that its control-char class is the ASCII-C0/Del
        // range, NOT full \p{C} — U+200B intentionally PASSES here (evidence-
        // only role: overlap with strictly-pinned stored ids is impossible for
        // such an id, so it can never mis-anchor).
        assert.equal(incomingMsgIdsOf({ [MSG_IDS_BODY_FIELD]: values }) === undefined ? undefined : "has", c.inboundPasses ? "has" : undefined, `incomingMsgIdsOf ${c.name}`);
        // watermark wire decode (skipped where the input domain can't express
        // the class post-decode).
        if (!c.noWire) assert.equal(_parseTailIdsForTest(values.map((v) => encodeURIComponent(String(v))).join(",")), null, `parseTailIds ${c.name}`);
    }
    // The good shapes survive everywhere they travel.
    assert.equal(validateMsgIds([GOOD, GOOD2], 2).ok, true, "validateMsgIds good");
    assert.deepEqual(_hostMsgIdsOfForTest(objForm([GOOD, GOOD2])), [GOOD, GOOD2], "hostMsgIdsOf good");
    assert.equal(_screenMsgIdsForTest([GOOD, GOOD2]), true, "screenMsgIds good");
    assert.deepEqual(incomingMsgIdsOf({ [MSG_IDS_BODY_FIELD]: [GOOD, GOOD2] }), [GOOD, GOOD2], "incomingMsgIdsOf good");
    assert.deepEqual(_parseTailIdsForTest(`${encodeURIComponent(GOOD)},${encodeURIComponent(GOOD2)}`), [GOOD, GOOD2], "parseTailIds good");
});

test("structural cases: non-array / empty / width mismatch / bulk cap (#5826 parity)", () => {
    assert.equal(validateMsgIds("not-an-array", 0).ok, false, "validateMsgIds non-array");
    assert.ok((validateMsgIds([], 0) as { ok?: boolean }).ok === true, "validateMsgIds empty+expectedLen 0 is legal (aligned)");
    assert.equal(validateMsgIds([GOOD], 2).ok, false, "validateMsgIds width mismatch");
    assert.equal(validateMsgIds(LONG_LIST, LONG_LIST.length).ok, true, "validateMsgIds has NO bulk cap (documented divergence vs pf-channel MAX_IDS)");

    assert.equal(incomingMsgIdsOf({ [MSG_IDS_BODY_FIELD]: "not-an-array" }), undefined, "incomingMsgIdsOf non-array");
    assert.equal(incomingMsgIdsOf({ [MSG_IDS_BODY_FIELD]: [] }), undefined, "incomingMsgIdsOf empty array degrades");
    assert.deepEqual(incomingMsgIdsOf({ [MSG_IDS_BODY_FIELD]: LONG_LIST }), LONG_LIST, "incomingMsgIdsOf accepts any width incl. bulk (no cap)");

    assert.equal(_hostMsgIdsOfForTest(null), undefined, "hostMsgIdsOf non-array");
    assert.equal(_hostMsgIdsOfForTest([]), undefined, "hostMsgIdsOf empty");
    const bulkHost = _hostMsgIdsOfForTest(objForm(LONG_LIST));
    assert.ok(Array.isArray(bulkHost) && bulkHost.length === LONG_LIST.length, "hostMsgIdsOf has no bulk cap");
    assert.equal(_pfSlotIdsOfForTest(null), undefined, "pfSlotIdsOf non-array");
    assert.equal(_pfSlotIdsOfForTest([]), undefined, "pfSlotIdsOf empty");

    assert.equal(_screenMsgIdsForTest("not-an-array"), false, "screenMsgIds non-array");
    assert.equal(_screenMsgIdsForTest([]), false, "screenMsgIds empty");
    assert.equal(_screenMsgIdsForTest(LONG_LIST), true, "screenMsgIds has no bulk cap");

    assert.equal(_parseTailIdsForTest(""), null, "parseTailIds empty string -> no segments");
});

test("per-slot screening: bad slots ride ?, never poison neighbours (#5826 parity)", () => {
    // pfSlotIdsOf (dsh watermark capture): position preserved, bad -> "?".
    assert.deepEqual(_pfSlotIdsOfForTest(objForm([GOOD, "a b", GOOD2])), [GOOD, PF_SLOT_UNKNOWN, GOOD2], "pfSlotIdsOf mixed");
    assert.deepEqual(_pfSlotIdsOfForTest(objForm(["a b"])), [PF_SLOT_UNKNOWN], "pfSlotIdsOf all-bad still returns the slot list (channel decides absence)");
    // NOTE: duplicates DO travel here — dedupe lives in pfCaptureIds (asserted next).

    // collectRequestIds (settlement evidence): LENOIENT by design — skips
    // bad entries without voiding the rest (its ids never enter the identity
    // space; worst case the needle misses one settle cycle, self-heals on
    // the next main-scale resend). No control-char screening at all.
    assert.deepEqual(collectRequestIds([GOOD, 42, "", RES, GOOD2, GOOD], []), [GOOD, GOOD2], "collectRequestIds skips bad, dedupes");
    assert.deepEqual(collectRequestIds(["a b", CFC], []), ["a b", CFC], "collectRequestIds does NOT control-screen (intentional)");
    assert.deepEqual(collectRequestIds(undefined, [{ toolCallId: "call_1" }, {}] as never[]), ["call_1"], "collectRequestIds falls back to resent toolCallIds");
    assert.deepEqual(collectRequestIds([], []), [], "collectRequestIds all-absent");
});

let pfSidSeq = 0;
function pfRoundTrip(t: number, capture: unknown): Record<string, string> {
    const sid = `pf-parity-${++pfSidSeq}`;
    pfLearnStamp(
        { "x-bili-plugin-conversation": sid },
        200,
        new Headers({ "x-bili-pf-seq": String(t) }),
    );
    pfCaptureIds(sid, capture);
    return pfRequestHeaders({ "x-bili-plugin-conversation": sid });
}

test("pf-channel end-to-end screening via the public handshake API (#5826 parity)", () => {
    assert.deepEqual(pfRoundTrip(3, [GOOD, "mid", GOOD2]), { "x-bili-pf-count": "3", "x-bili-pf-tail-ids": GOOD2 }, "all-known list: tail window slices at learned K");
    assert.deepEqual(pfRoundTrip(3, [GOOD, "a b", GOOD2]), { "x-bili-pf-count": "3", "x-bili-pf-tail-ids": GOOD2 }, "bad middle slot rides ?; window tail intact");
    assert.deepEqual(pfRoundTrip(3, [GOOD, GOOD2, "\u200bcf"]), { "x-bili-pf-count": "3", "x-bili-pf-tail-ids": "%3F" }, "\\p{C} slot screens to ? (emitted percent-encoded)");
    assert.deepEqual(pfRoundTrip(3, ["a b", "c d"]), { "x-bili-pf-count": "3" }, "nothing identifiable -> count-only");
    assert.deepEqual(pfRoundTrip(2, [GOOD, GOOD]), { "x-bili-pf-count": "2", "x-bili-pf-tail-ids": "%3F" }, "duplicate second slot screens to ?");
    assert.deepEqual(pfRoundTrip(3, LONG_LIST), { "x-bili-pf-count": "3" }, "MAX_IDS (2048) cap degrades to count-only");
    assert.deepEqual(pfRoundTrip(3, "not-an-array"), { "x-bili-pf-count": "3" }, "failed resolution clears stored list (honest absence beats stale)");
});

test("watermark wire encode/decode contract: %2C inside ids, literal commas separate (#5826 parity)", () => {
    const withComma = "g,B";
    // Literal separator commas stay unencoded; commas INSIDE ids travel %2C —
    // split(",") then per-segment decode is unambiguous for arbitrary alphabets.
    assert.deepEqual(_parseTailIdsForTest(`${GOOD},${encodeURIComponent(withComma)}`), [GOOD, withComma], "pfRequestHeaders-shaped emit decodes back");
    assert.deepEqual(_parseTailIdsForTest(encodeURIComponent("a,b,c")), ["a,b,c"], "single id with commas survives whole");
    assert.deepEqual(_parseTailIdsForTest("a,b"), ["a", "b"], "plain separators");
    assert.deepEqual(_parseTailIdsForTest("%3F,%3F,%3F"), [PF_SLOT_UNKNOWN, PF_SLOT_UNKNOWN, PF_SLOT_UNKNOWN], "? repeats are EXPECTED (compressed slots)");
    assert.equal(_parseTailIdsForTest("a,foo,a"), null, "real-id repeats void the whole list");
    assert.equal(_parseTailIdsForTest(`${Array.from({ length: 2049 }, () => "x").join(",")}`), null, "> 2048 segments voids");
    assert.equal(_parseTailIdsForTest("a,,b"), null, "empty segment voids");
});
