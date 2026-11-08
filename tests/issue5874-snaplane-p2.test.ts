/**
 * #5874 P2 — mapEgress: the outbound compressed context is served from the
 * verified snap plane (tripwire-guarded). Unit scope:
 *   T13  view assembly — anchor + surviving rows + client tail, D-lane seam
 *        walk parity (live tail / reply-lag gap / seam-too-short / rewind).
 *   T14  tripwire normalization — ids and stamps are metadata; payload
 *        (role/type/tool/text/image-hash) must match exactly.
 *   T15  anchor rendering parity with kernel renderSummary.
 *   T16  the gate: config off, cohort, plane miss, mismatch fallback and
 *        the sticky exclusion after EGRESS_EXCLUDE_AFTER verdicts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SUMMARY_HEADER, summaryMessageId, type CompressionState } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { _resetSnapPlaneDeadForTests, type SnapView } from "../src/storage/snap.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { SessionStore, _setStoreForTest, getStore } from "../src/persist.ts";
import {
    applySnapEgress,
    buildSnapEgressView,
    snapEgressFlags,
    snapEgressStatusWire,
    tripwireCompare,
    _resetSnapEgressForTests,
    type SnapEgressProtocol,
} from "../src/server/snap-egress.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5874-p2-"));
const configPath = path.join(hermetic, "config.json");
fs.writeFileSync(configPath, "{}");
process.env.BILI_CONFIG_FILE = configPath;

function setConfig(v: unknown): void {
    fs.writeFileSync(configPath, JSON.stringify(v));
}

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function openPlane(p: string): UnifiedStore {
    return UnifiedStore.open(p, undefined, { snapBase: { enabled: true, shadowWrite: true } });
}

function session(id: string, msgs: Array<{ id: string; text: string; role?: "user" | "assistant" }>): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
        blockContents: new Map(),
        lastMessages: msgs.map((m, i) => ({
            id: m.id,
            role: (m.role ?? (i % 2 === 0 ? "user" : "assistant")) as "user" | "assistant",
            contentType: "text" as const,
            text: m.text,
        })),
        lastMessagesFolded: true,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

/** A folded session: 12 messages, block covers m1..m8 (the T7 shape). */
function foldedSession(sid: string): { sess: LegacySessionLike; blk: Record<string, unknown>; msgs: Array<{ id: string; text: string }> } {
    const msgs = Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, text: `message ${i + 1}` }));
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    msgs.forEach((m, i) => {
        const ref = `m${String(i + 1).padStart(5, "0")}`;
        byRaw[m.id] = ref;
        byRef[ref] = m.id;
    });
    const blk = {
        blockId: "blk-c1",
        runId: 1,
        createdAt: 1_000,
        tier: 1,
        active: true,
        summary: "folded 1-8",
        kind: "fold",
        reason: "test",
        effectiveMessageIds: msgs.slice(0, 8).map((m) => m.id),
        directMessageIds: [] as string[],
    };
    const sess = session(sid, msgs);
    sess.state = { blocks: [blk as never], nextBlockId: 2, nextRunId: 2, messageRefs: { byRaw, byRef } };
    return { sess, blk, msgs };
}

function msg(id: string, text: string, role: "user" | "assistant" | "system" = "user"): BiliMessage {
    return { id, role, contentType: "text", text } as BiliMessage;
}

/** Build the plane for the folded session and return its egress view. */
function planeFor(sid: string): { store: UnifiedStore; view: SnapView; state: CompressionState; blk: Record<string, unknown> } {
    const dir = tmpDir("bili-5874-p2-plane-");
    const store = openPlane(path.join(dir, "index.db"));
    const { sess, blk } = foldedSession(sid);
    store.ingestSession(planIngest(sess));
    const view = store.snapEgressView(sid);
    assert.ok(view, "the plane must have rows after ingest");
    return { store, view, state: { blocks: [blk as never] } as unknown as CompressionState, blk };
}

const clientResend = (msgs: Array<{ id: string; text: string }>): BiliMessage[] =>
    msgs.map((m, i) => msg(m.id, m.text, i % 2 === 0 ? "user" : "assistant"));

test.beforeEach(() => {
    _resetSnapEgressForTests();
    _resetSnapPlaneDeadForTests();
    setConfig({});
});

// ---------------------------------------------------------------------------
// T13 — view assembly: anchors replace the covered region, surviving rows
// ride the prefix in pos order, the client tail rides verbatim.
// ---------------------------------------------------------------------------

test("#5874 T13: folded session assembles anchor + surviving rows (steady-state seam)", () => {
    const { view, state } = planeFor("sess-p2-a");
    // The client re-sends the full post-fold history (m9..m12 plus the
    // covered m1..m8 — ids still bind onto covered rows, D-lane parity).
    const built = buildSnapEgressView(view, clientResend(Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, text: `message ${i + 1}` }))), state);
    assert.ok(built.ok, `view must assemble, got ${(built as { reason: string }).reason}`);
    assert.equal(built.msgs.length, 5, "anchor + m9..m12");
    const [anchor, ...rest] = built.msgs;
    assert.equal(anchor.id, summaryMessageId("blk-c1"));
    assert.equal(anchor.role, "system");
    assert.equal(anchor.contentType, "text");
    assert.equal(anchor.text, `${SUMMARY_HEADER}\nfolded 1-8`);
    assert.deepEqual(rest.map((m) => m.text), ["message 9", "message 10", "message 11", "message 12"]);
    assert.equal(built.tailCount, 0, "nothing above the join — empty tail");
});

test("#5874 T13b: this turn's fresh user message rides the tail", () => {
    const { view, state } = planeFor("sess-p2-b");
    const client = [...clientResend(Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, text: `message ${i + 1}` }))), msg("m13", "继续")];
    const built = buildSnapEgressView(view, client, state);
    assert.ok(built.ok);
    assert.equal(built.msgs.length, 6);
    assert.equal(built.msgs.at(-1)?.text, "继续");
    assert.equal(built.tailCount, 1);
});

test("#5874 T13c: the reply lag — an unobserved reply under the new user message stays in the tail", () => {
    const { view, state } = planeFor("sess-p2-c");
    // Client: resent history + the previous turn's reply (no row yet) + new user.
    const client = [...clientResend(Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, text: `message ${i + 1}` }))), msg("host-r1", "the reply"), msg("m13", "next question")];
    const built = buildSnapEgressView(view, client, state);
    assert.ok(built.ok);
    assert.equal(built.tailCount, 2, "reply + question both live in the tail");
    assert.deepEqual(built.msgs.slice(-2).map((m) => m.text), ["the reply", "next question"]);
});

test("#5874 T13d: unobserved mid-history messages drop from the plane view — the tripwire catches that live", () => {
    const { view, state } = planeFor("sess-p2-d");
    const base = Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, text: `message ${i + 1}` }));
    // An unobserved message inside the resent region (not reply lag — that
    // rides above): the walk tolerates ONE gap, the prefix renders from the
    // plane rows, so the unknown content is absent from the plane view. In
    // production the legacy view still carries it ⇒ tripwire mismatch ⇒
    // legacy bytes kept. Unit-level: assert the drop + the catch.
    const gapped = [...clientResend(base.slice(0, 9)), msg("host-x", "unknown"), ...clientResend(base.slice(10)), msg("m13", "next question")];
    const built = buildSnapEgressView(view, gapped, state);
    assert.ok(built.ok, "one gap is tolerated");
    assert.deepEqual(built.msgs.map((m) => m.text), [`${SUMMARY_HEADER}\nfolded 1-8`, "message 9", "message 10", "message 11", "message 12", "next question"]);
    assert.equal(built.tailCount, 1);
    // Two consecutive unknowns: same join (the chain ends at the second
    // miss; the seam m11+m12 still satisfies MIN_SEAM_RUN).
    const broken = [...clientResend(base.slice(0, 9)), msg("host-x", "unknown"), msg("host-y", "unknown2"), ...clientResend(base.slice(10)), msg("m13", "next question")];
    const built2 = buildSnapEgressView(view, broken, state);
    assert.ok(built2.ok);
    assert.deepEqual(built2.msgs.map((m) => m.text), built.msgs.map((m) => m.text));
    // The tripwire catches the dropped content: a legacy view that still
    // carries the unknown message must NOT match the plane view.
    const legacyWithX = [msg("acp_summary_blk-c1", `${SUMMARY_HEADER}\nfolded 1-8`, "system"), msg("host-9", "message 9"), msg("host-x", "unknown"), msg("host-10", "message 10"), msg("host-11", "message 11"), msg("host-12", "message 12"), msg("host-13", "next question")];
    const verdict = tripwireCompare(built.msgs, legacyWithX);
    assert.ok(!verdict.ok, "a view missing the unknown message must fail the tripwire");
    assert.equal(verdict.reason, "length(plane=6,legacy=7)");
});

test("#5874 T13e: a lone match is never a seam (#3812) — degrade, do not guess", () => {
    const { view, state } = planeFor("sess-p2-e");
    const client = [msg("rand-1", "noise"), msg("rand-2", "noise"), ...clientResend([{ id: "m12", text: "message 12" }]), msg("m13", "next question")];
    const built = buildSnapEgressView(view, client, state);
    assert.ok(!built.ok);
    assert.equal(built.reason, "seam-too-short");
});

test("#5874 T13f: rewind truncation — rows beyond the join never render", () => {
    const { view, state } = planeFor("sess-p2-f");
    // Client rewound to m1..m6 (+ new tail): join at m6; m7..m12 never render,
    // m1..m6 are all covered → the anchor is the entire prefix.
    const client = [...clientResend(Array.from({ length: 6 }, (_, i) => ({ id: `m${i + 1}`, text: `message ${i + 1}` }))), msg("m13", "after rewind")];
    const built = buildSnapEgressView(view, client, state);
    assert.ok(built.ok);
    assert.deepEqual(built.msgs.map((m) => m.text), [`${SUMMARY_HEADER}\nfolded 1-8`, "after rewind"]);
    assert.equal(built.tailCount, 1);
});

test("#5874 T13g: signature remint — client ids changed, content matches (#3812 sig path)", () => {
    const { view, state } = planeFor("sess-p2-g");
    const client = Array.from({ length: 12 }, (_, i) => msg(`fresh-${i + 1}`, `message ${i + 1}`, i % 2 === 0 ? "user" : "assistant"));
    const built = buildSnapEgressView(view, client, state);
    assert.ok(built.ok, "the sig path must chain when every id was reminted");
    assert.equal(built.msgs.length, 5);
    assert.deepEqual(built.msgs.slice(1).map((m) => m.text), ["message 9", "message 10", "message 11", "message 12"]);
});

test("#5874 T13h: a block anchoring zero rows degrades (coverage the plane cannot prove)", () => {
    const { view } = planeFor("sess-p2-h");
    const ghost = { blocks: [{ blockId: "blk-ghost", active: true, effectiveMessageIds: ["nope-1", "nope-2"], summary: "ghost" }] } as unknown as CompressionState;
    const built = buildSnapEgressView(view, clientResend(Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, text: `message ${i + 1}` }))), ghost);
    assert.ok(!built.ok);
    assert.equal(built.reason, "block-unanchored");
});

// ---------------------------------------------------------------------------
// T14 — tripwire normalization.
// ---------------------------------------------------------------------------

test("#5874 T14: tripwire ignores ids/stamps, compares payload exactly", () => {
    const a = [msg("plane-1", "hello"), msg("plane-2", "world", "assistant")];
    const b = [msg("host-1", "hello"), msg("host-2", "world", "assistant")];
    assert.deepEqual(tripwireCompare(a, b), { ok: true }, "same payload, different ids → match");
    const c = [msg("host-1", "hello"), msg("host-2", "WORLD", "assistant")];
    const cVerdict = tripwireCompare(a, c);
    assert.equal(cVerdict.ok, false);
    assert.equal(cVerdict.ok === false && cVerdict.reason, "shape@1:text");
    assert.match(cVerdict.ok === false && cVerdict.firstDiff || "", /^text plane\(len=5\)=\"world\" legacy\(len=5\)=\"WORLD\"$/);
    const d = [msg("host-1", "hello")];
    assert.deepEqual(tripwireCompare(a, d), { ok: false, reason: "length(plane=2,legacy=1)" });
    const imgA = { id: "i1", role: "user", contentType: "image", text: "", imagePart: true, imageBase64: "QUJD" } as unknown as BiliMessage;
    const imgB = { id: "i2", role: "user", contentType: "image", text: "", imagePart: true, imageBase64: "QUJD" } as unknown as BiliMessage;
    const imgC = { id: "i3", role: "user", contentType: "image", text: "", imagePart: true, imageBase64: "REVG" } as unknown as BiliMessage;
    assert.deepEqual(tripwireCompare([imgA], [imgB]), { ok: true }, "image hashed, not id-compared");
    const imgVerdict = tripwireCompare([imgA], [imgC]);
    assert.equal(imgVerdict.ok, false);
    assert.equal(imgVerdict.ok === false && imgVerdict.reason, "shape@0:image");
});

// ---------------------------------------------------------------------------
// T15 — anchor rendering parity (kernel renderSummary).
// ---------------------------------------------------------------------------

test("#5874 T15: anchor text mirrors renderSummary (topic line + body; body-only fallback)", () => {
    // Two rows so the seam run ≥ 2; the block covers m1 only.
    const view: SnapView = {
        sid: "x",
        rows: [
            { pos: 0, coreIds: ["m1"], preJson: null, postJson: JSON.stringify(msg("m1", "one")), tokensEst: 1, active: 1, coverRef: null, rowSum: "" },
            { pos: 1, coreIds: ["m2"], preJson: null, postJson: JSON.stringify(msg("m2", "two")), tokensEst: 1, active: 1, coverRef: null, rowSum: "" },
        ],
        tailSeq: 2,
        ckptSeq: 0,
    } as unknown as SnapView;
    const built = buildSnapEgressView(view, [msg("m1", "one"), msg("m2", "two")], {
        blocks: [{ blockId: "blk-t", active: true, effectiveMessageIds: ["m1"], summary: "the body", topic: "setup" } as never],
    } as unknown as CompressionState);
    assert.ok(built);
    assert.ok(built.ok, `expected ok, got ${JSON.stringify(built)}`);
    assert.equal(built.msgs[0].text, `${SUMMARY_HEADER} — setup\nthe body`, "topic line + body");
    assert.equal(built.msgs[0].id, "acp_summary_blk-t");
    assert.equal(built.msgs.length, 2, "anchor + m2");
    const built2 = buildSnapEgressView(view, [msg("m1", "one"), msg("m2", "two")], {
        blocks: [{ blockId: "blk-t2", active: true, effectiveMessageIds: ["m1"], summary: "the body" } as never],
    } as unknown as CompressionState);
    assert.ok(built2.ok);
    assert.equal(built2.msgs[0].text, `${SUMMARY_HEADER}\nthe body`, "no topic → header + body");
});

// ---------------------------------------------------------------------------
// T16 — the gate: config, cohort, plane miss, mismatch fallback, sticky
// exclusion — via the real applySnapEgress with a store stub.
// ---------------------------------------------------------------------------

function withStore(view: SnapView | null): void {
    _setStoreForTest({ snapEgressView: () => view } as unknown as SessionStore);
    assert.ok(getStore(), "store stub installed");
}

const identity = (m: BiliMessage[]): BiliMessage[] => m;
const deps = (protocol: SnapEgressProtocol = "openai") => ({
    sessionId: "sess-gate",
    protocol,
    log: () => {},
    transform: identity,
});

test("#5874 T16a: config egress:false keeps legacy bytes", () => {
    setConfig({ storage: { snapBase: { enabled: true, shadowWrite: true, egress: false } } });
    assert.equal(snapEgressFlags().egress, false);
    const legacy = [msg("l1", "legacy")];
    const out = applySnapEgress([msg("m1", "one")], { blocks: [] } as unknown as CompressionState, legacy, deps());
    assert.equal(out, legacy, "flag off → identity (same array reference)");
});

test("#5874 T16b: cohort exclusion keeps legacy bytes", () => {
    setConfig({ storage: { snapBase: { enabled: true, shadowWrite: true, egressCohorts: ["anthropic"] } } });
    const legacy = [msg("l1", "legacy")];
    const out = applySnapEgress([msg("m1", "one")], { blocks: [] } as unknown as CompressionState, legacy, deps("openai"));
    assert.equal(out, legacy);
    // and the named cohort passes the flag check (plane miss follows below).
    setConfig({});
});

test("#5874 T16c: plane miss counts and keeps legacy", () => {
    withStore(null);
    const legacy = [msg("l1", "legacy")];
    const out = applySnapEgress([msg("m1", "one")], { blocks: [] } as unknown as CompressionState, legacy, deps());
    assert.equal(out, legacy);
    assert.equal(snapEgressStatusWire().planeMiss, 1);
});

test("#5874 T16d: exact tripwire match cuts over; mismatch falls back; 3 mismatches sticky-exclude", () => {
    const { view, state } = planeFor("sess-gate");
    withStore(view);
    const resend = clientResend(Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, text: `message ${i + 1}` })));
    // Legacy view the kernel would emit for the same turn: anchor (reminted
    // id is fine — payload compared) + m9..m12 with host-side ids.
    const legacyOk: BiliMessage[] = [
        { ...msg(summaryMessageId("blk-c1"), `${SUMMARY_HEADER}\nfolded 1-8`), role: "system" },
        msg("host-9", "message 9", "user"),
        msg("host-10", "message 10", "assistant"),
        msg("host-11", "message 11", "user"),
        msg("host-12", "message 12", "assistant"),
    ];
    const out = applySnapEgress(resend, state, legacyOk, { ...deps(), sessionId: "sess-gate" });
    assert.notEqual(out, legacyOk, "cutover returns the plane-sourced array");
    assert.equal(snapEgressStatusWire().cutover, 1);
    assert.equal(out.length, 5);
    // Mismatching legacy (different text) → fallback, legacy kept, 3 strikes out.
    const legacyBad = [msg("host-9", "DIFFERENT", "assistant")];
    const sid = "sess-gate";
    for (let i = 1; i <= 3; i++) {
        const kept = applySnapEgress(resend, state, legacyBad, { ...deps(), sessionId: sid });
        assert.equal(kept, legacyBad, `fallback ${i} keeps legacy`);
    }
    const st = snapEgressStatusWire();
    assert.equal(st.fallback, 3);
    assert.equal(st.excludedSids, 1, "sticky exclusion after the 3rd mismatch");
    // 4th call short-circuits: even a perfect legacy view stays legacy now.
    const kept = applySnapEgress(resend, state, legacyOk, { ...deps(), sessionId: sid });
    assert.equal(kept, legacyOk);
    assert.equal(snapEgressStatusWire().cutover, 1, "no further cutovers for the excluded sid");
});

test("#5874 T16e: zero-plane session (no rows) degrades with no-plane", () => {
    withStore({ sid: "empty", rows: [], tailSeq: 0, ckptSeq: 0 } as unknown as SnapView);
    const legacy = [msg("l1", "legacy")];
    const out = applySnapEgress([msg("m1", "one")], { blocks: [] } as unknown as CompressionState, legacy, deps());
    assert.equal(out, legacy);
    const st = snapEgressStatusWire();
    assert.equal(st.degradeReasons["no-plane"], 1);
});

test("#5874 T16f: soak default — no config section means egress ON for all four cohorts", () => {
    setConfig({});
    const flags = snapEgressFlags();
    assert.equal(flags.egress, true);
    for (const p of ["openai", "anthropic", "google", "responses"] as SnapEgressProtocol[]) {
        assert.ok(flags.cohorts.has(p), `${p} in default cohorts`);
    }
});

test("#5874 T18a: resend envelope re-applied onto plane prefix rows (byte parity with the live resend)", () => {
    _resetSnapEgressForTests();
    setConfig({});
    const { view, state } = planeFor("sess-p2-env-a");
    const env = (ref: string, time: string) => `<acp tokens="90" type="text" time="${time}">${ref}</acp>\n`;
    // Client resends EVERYTHING with fresh envelopes; m9..m12 are the seam
    // tail, m1..m8 covered (block), and the surviving prefix rows get the
    // client's exact tagged text adopted.
    const resend = [
        msg("m1", env("m00001", "T2") + "message 1"),
        msg("m2", env("m00002", "T2") + "message 2"),
        msg("m9", env("m00009", "T2") + "message 9"),
        msg("m10", env("m00010", "T2") + "message 10"),
        msg("m11", env("m00011", "T2") + "message 11"),
        msg("m12", env("m00012", "T2") + "message 12"),
    ];
    const built = buildSnapEgressView(view, resend, state);
    assert.ok(built.ok);
    assert.equal(built.msgs.length, 5);
    assert.equal(built.msgs[0].text, `${SUMMARY_HEADER}\nfolded 1-8`, "anchor never carries an envelope");
    assert.equal(built.msgs[1].text, env("m00009", "T2") + "message 9", "prefix row adopts the live resend envelope");
    assert.equal(built.msgs[2].text, env("m00010", "T2") + "message 10");
    assert.equal(built.msgs[3].text, env("m00011", "T2") + "message 11");
    assert.equal(built.msgs[4].text, env("m00012", "T2") + "message 12", "tail verbatim");
    // legacy processed: kernel drops the covered m1..m8 by id and keeps the
    // resent tagged texts for the rest — byte-for-byte identical.
    const legacy = [
        msg("acp_summary_blk-c1", `${SUMMARY_HEADER}\nfolded 1-8`, "system"),
        msg("m9", env("m00009", "T2") + "message 9"),
        msg("m10", env("m00010", "T2") + "message 10", "assistant"),
        msg("m11", env("m00011", "T2") + "message 11"),
        msg("m12", env("m00012", "T2") + "message 12", "assistant"),
    ];
    assert.deepEqual(tripwireCompare(built.msgs, legacy), { ok: true });
});

test("#5874 T18b: a new turn's changed envelope time still matches (per-resend tags)", () => {
    _resetSnapEgressForTests();
    setConfig({});
    const { view, state } = planeFor("sess-p2-env-b");
    const env = (ref: string, time: string) => `<acp tokens="7" type="text" time="${time}">${ref}</acp>\n`;
    // Turn 3's resend: same content, NEW envelope times (transport metadata).
    const resend = [
        msg("m1", env("m00001", "T3") + "message 1"),
        msg("m9", env("m00009", "T3") + "message 9"),
        msg("m10", env("m00010", "T3") + "message 10"),
        msg("m11", env("m00011", "T3") + "message 11"),
        msg("m12", env("m00012", "T3") + "message 12"),
    ];
    const built = buildSnapEgressView(view, resend, state);
    assert.ok(built.ok);
    assert.equal(built.msgs[1].text, env("m00009", "T3") + "message 9", "adopted from THIS resend, not a stale one");
});

test("#5874 T18c: content edit under an envelope is never adopted (byte-strict)", () => {
    _resetSnapEgressForTests();
    setConfig({});
    const { view, state } = planeFor("sess-p2-env-c");
    const env = (ref: string) => `<acp tokens="7" type="text" time="T9">${ref}</acp>\n`;
    // The client rewrote m9's body (edits): pairing finds the id but the
    // content differs beyond the envelope — plane text stays, tripwire fires.
    const resend = [
        msg("m1", env("m00001") + "message 1"),
        msg("m9", env("m00009") + "message 9 EDITED"),
        msg("m10", env("m00010") + "message 10"),
        msg("m11", env("m00011") + "message 11"),
        msg("m12", env("m00012") + "message 12"),
    ];
    const built = buildSnapEgressView(view, resend, state);
    assert.ok(built.ok);
    assert.equal(built.msgs[1].text, "message 9", "edited row keeps the plane text (no blind adoption)");
    // legacy keeps the edited resend (m9 is not covered) → tripwire catches
    // the text divergence at the very row where adoption was refused.
    const legacy = [
        msg("acp_summary_blk-c1", `${SUMMARY_HEADER}\nfolded 1-8`, "system"),
        msg("m9", env("m00009") + "message 9 EDITED"),
        msg("m10", env("m00010") + "message 10", "assistant"),
        msg("m11", env("m00011") + "message 11"),
        msg("m12", env("m00012") + "message 12", "assistant"),
    ];
    const verdict = tripwireCompare(built.msgs, legacy);
    assert.ok(!verdict.ok);
    assert.equal(verdict.reason, "shape@1:text");
});
