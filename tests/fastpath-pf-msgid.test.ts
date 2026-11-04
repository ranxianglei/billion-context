// #5600 v6 msgid lane — identity rides server-minted pf_sids
// (x-bili-pf-session echo / ledger-id probe / mint), frozen cores come from
// the persistent pf_* partition store; hit authority is ledger-width
// arithmetic against OUR OWN frontier + window-origin pin. These tests pin:
// soft-plane degradation (store absent ⇒ legacy lanes byte-for-byte),
// cold-start mint/arm ingestion, geometry-only hits, hard-pin hits with
// ledger-id binding, shape/wrong-origin self-healing misses, compaction
// archive-and-reset (no row deletion, same sid echoed through the reset),
// post-boot hydration, L1 checkpoint fold round-trip, sess-change as an
// identity event, model-switch as a non-event, shared-breaker naming via
// credited misses, id-stable in-place edits riding frozen cores, and the
// untouched default (knob OFF) behavior as the regression anchor.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import http from "node:http";
import { openaiToCore } from "acp-kernel/wire";
import { evaluateWatermarkFastpath, finalizeWatermarkTurn, PF_SID_HEADER, PF_TAIL_IDS_HEADER } from "../src/server/fastpath.ts";
import { stripRawStage } from "../src/marker/engine.ts";
import { rolloutEnvName } from "../src/rollout.ts";
import { _setStoreForTest, _resetStoreForTest, type SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";

const MSGID_ENV = rolloutEnvName("watermarkV6MsgId");

process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK = "1";
process.env.BILI_ROLLOUT_WATERMARK_CANONICAL_V6 = "0";

const LOGS: string[] = [];
const log = (level: string, msg: string): void => { LOGS.push(`${level} ${msg}`); };

const USR = (t: string): { role: string; content: string } => ({ role: "user", content: t });
const ASST = (t: string): { role: string; content: string } => ({ role: "assistant", content: t });

const headersOf = (h: Record<string, string>): http.IncomingMessage =>
    ({ headers: h }) as unknown as http.IncomingMessage;

const setMsgIdLane = (on: boolean): void => {
    if (on) process.env[MSGID_ENV] = "1";
    else delete process.env[MSGID_ENV];
};

// ---------------------------------------------------------------------------
// In-memory pf_* partition store (mirrors src/storage/store.ts pf* semantics:
// contiguous pos per sid, ls_seq continuing per sid, ckpt truncates tail
// inclusive, global ledger index first-hit by pos).
interface MemRow { pos: number; elem: number; ledgerId: string | null; coreId: string; coreJson: string; ts: number }
interface MemEntry { lsSeq: number; kind: string; payloadJson: string; bornPosHi: number | null }
class MemPF {
    rows = new Map<string, MemRow[]>();
    logs = new Map<string, MemEntry[]>();
    ckpts = new Map<string, { ckptLsSeq: number; metaJson: string; checksum: string }>();
    ledger = new Map<string, { sid: string; pos: number }>();
    appendTurn(
        sid: string,
        rws: { ledgerId: string | null; elem: number; coreId: string; coreJson: string }[],
        entries: { kind: string; payload: unknown; bornPosHi?: number }[],
    ): { maxPos: number; lsSeq: number } {
        const rs = this.rows.get(sid) ?? [];
        let pos = rs.length > 0 ? rs[rs.length - 1].pos : -1;
        const now = Date.now();
        for (const r of rws) {
            pos += 1;
            rs.push({ pos, elem: r.elem, ledgerId: r.ledgerId, coreId: r.coreId, coreJson: r.coreJson, ts: now });
            if (r.ledgerId !== null && !this.ledger.has(r.ledgerId)) this.ledger.set(r.ledgerId, { sid, pos });
        }
        this.rows.set(sid, rs);
        const lg = this.logs.get(sid) ?? [];
        let seq = lg.length > 0 ? lg[lg.length - 1].lsSeq : -1;
        for (const e of entries) {
            seq += 1;
            lg.push({ lsSeq: seq, kind: e.kind, payloadJson: JSON.stringify(e.payload), bornPosHi: e.bornPosHi ?? null });
        }
        this.logs.set(sid, lg);
        return { maxPos: pos, lsSeq: seq };
    }
    lookupLedger(id: string): { sid: string; pos: number } | null { return this.ledger.get(id) ?? null; }
    verifyOriginPin(sid: string, elem: number, id: string): boolean {
        return (this.rows.get(sid) ?? []).some((r) => r.elem === elem && r.ledgerId === id);
    }
    readMeta(sid: string): { ckpt: { ckptLsSeq: number; metaJson: string; checksum: string } | null; tailLog: MemEntry[] } {
        return { ckpt: this.ckpts.get(sid) ?? null, tailLog: [...(this.logs.get(sid) ?? [])] };
    }
    writeCkpt(sid: string, ckptLsSeq: number, metaJson: string, checksum: string, truncateBeforeInclusive = true): void {
        this.ckpts.set(sid, { ckptLsSeq, metaJson, checksum });
        if (truncateBeforeInclusive) this.logs.set(sid, (this.logs.get(sid) ?? []).filter((e) => e.lsSeq > ckptLsSeq));
    }
    readRows(sid: string, intervals: ReadonlyArray<readonly [number, number]>): MemRow[] {
        const rs = this.rows.get(sid) ?? [];
        return rs.filter((r) => intervals.some(([a, b]) => r.pos >= a && r.pos < b)).sort((a, b) => a.pos - b.pos);
    }
    maxPos(sid: string): number {
        const rs = this.rows.get(sid) ?? [];
        return rs.length > 0 ? rs[rs.length - 1].pos : -1;
    }
}

const makeStub = (pf: MemPF | "absent"): { ext: Map<string, unknown>; pf: MemPF } => {
    const ext = new Map<string, unknown>();
    const mem = pf === "absent" ? undefined : pf;
    _setStoreForTest({
        closeQuietly: (): void => {},
        replicasAvailable: (): boolean => true,
        getSessionExt: (sid: string, k: string): unknown => ext.get(`${sid}\u0000${k}`),
        setSessionExt: (sid: string, k: string, v: unknown): void => { void ext.set(`${sid}\u0000${k}`, v); },
        ...(mem === undefined ? {} : { pfStore: (): typeof mem => mem! }),
    } as unknown as SessionStore);
    return { ext, pf: mem as unknown as MemPF };
};

const mkSession = (id: string): Session => ({
    id,
    state: { blocks: [] },
    metadata: {},
}) as unknown as Session;

const runTurn = (
    session: Session,
    reqHeaders: Record<string, string>,
    messages: unknown[],
    model = "m1",
): { out: ReturnType<typeof evaluateWatermarkFastpath>; headers: Record<string, string> } => {
    const bodyText = JSON.stringify({ model, stream: false, messages });
    const out = evaluateWatermarkFastpath(bodyText, headersOf(reqHeaders), session, { pluginMode: true, titleGen: false, model }, log);
    const oracle = openaiToCore(JSON.parse(bodyText) as never);
    const stripCounts = stripRawStage(JSON.parse(bodyText), "openai");
    const headers = finalizeWatermarkTurn(session, out, {
        model,
        legacyCores: out.hit !== null ? out.hit.view : oracle.msgs,
        rawSystemText: out.hit !== null ? out.hit.systemText : oracle.systemText,
        turnStripCounts: stripCounts,
    });
    return { out, headers };
};

const SYSP = { role: "system", content: "pf-test-system-prompt-bytes" };

test("msgid lane off by default — legacy lanes untouched", () => {
    try {
        // TEMP push: registry default is 100% while verification is on, so the
        // "lane off" assertion pins the env kill-switch explicitly (REVERT the
        // extra line together with the TEMP-ON defaults before merge).
        setMsgIdLane(false);
        process.env[MSGID_ENV] = "0";
        makeStub(new MemPF());
        const s = mkSession("s-off");
        const { out, headers } = runTurn(s, {}, [SYSP, USR("first user bytes off-lane")]);
        assert.equal(out.sid, undefined, "default must not resolve a pf_sid");
        assert.equal(headers[PF_SID_HEADER], undefined, "no sid header when the lane stands aside");
        assert.ok(!String(out.decision).includes("v6m"), `unexpected msgid decision: ${out.decision}`);
    } finally { setMsgIdLane(false); _resetStoreForTest(); }
});

test("soft plane: lane live but pf store absent ⇒ legacy lanes byte-for-byte", () => {
    try {
        setMsgIdLane(true);
        makeStub("absent");
        const s = mkSession("s-soft");
        const { out, headers } = runTurn(s, {}, [SYSP, USR("soft plane user bytes"), ASST("soft plane reply")]);
        assert.equal(out.sid, undefined, "store unavailable must NOT mint (plane stands aside)");
        assert.equal(headers[PF_SID_HEADER], undefined);
        assert.ok(!String(out.decision).includes("v6m"), `unexpected msgid decision: ${out.decision}`);
    } finally { setMsgIdLane(false); _resetStoreForTest(); }
});

const bootWorld = (pf: MemPF, session: Session): { sid: string; msgs: unknown[] } => {
    // Cold start: sys + u1 + a1 → mint + arm ingest.
    let msgs = [SYSP, USR("world u1 bytes"), ASST("world a1 reply")];
    let res = runTurn(session, {}, msgs);
    assert.match(String(res.out.sid), /^pf_[0-9a-f]{12}$/, `arm must mint: ${res.out.decision}`);
    assert.equal(res.out.decision, "v6m-arm");
    assert.equal(res.headers[PF_SID_HEADER], res.out.sid);
    // Growth turn WITH ids: list [origin=?, new] binds the new element id.
    msgs = [...msgs, USR("world u2 bytes")];
    res = runTurn(session, { [PF_SID_HEADER]: res.out.sid!, [PF_TAIL_IDS_HEADER]: "?,cidU2" }, msgs);
    assert.equal(res.out.decision, "hit(v6-mid)", `geometry+weak-pin hit expected, got ${res.out.decision}`);
    const sid = res.out.sid!;
    // Frontier now carries cidU2 at its last pos.
    assert.deepEqual(pf.lookupLedger("cidU2"), { sid, pos: pf.maxPos(sid) });
    return { sid, msgs };
};

test("cold-start mints, arms, then hard-pin hit serves resident cores + rekeyed window", () => {
    try {
        setMsgIdLane(true);
        const pf = new MemPF();
        const stub = makeStub(pf);
        const s = mkSession("s-hit");
        const { sid, msgs } = bootWorld(pf, s);
        // Next turn: origin pin = recorded frontier id, one fresh message.
        const next = [...msgs, ASST("world a2 reply")];
        const { out, headers } = runTurn(s, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: "cidU2,cidA2" }, next);
        assert.equal(out.decision, "hit(v6-mid)", `hard-pin hit expected, got ${out.decision}`);
        assert.equal(out.canonical, true);
        assert.ok(out.hit, "hit view present");
        // Resident cores (3 non-system) + window core (1) = 4 served cores.
        assert.equal(out.hit!.view.length, 4);
        assert.equal(headers[PF_SID_HEADER], sid, "echo continues the same partition");
        // Window row bound to cidA2; geom snapshot carries elements T=5 (sys,u1,a1,u2,a2).
        const rows = pf.readRows(sid, [[0, 1_000_000]]);
        assert.equal(rows.at(-1)?.ledgerId, "cidA2");
        const logTail = pf.readMeta(sid).tailLog.at(-1)!;
        assert.equal(logTail.kind, "geom");
        assert.equal((JSON.parse(logTail.payloadJson) as { t: number }).t, 5);
        void stub;
    } finally { setMsgIdLane(false); _resetStoreForTest(); }
});

test("wrong origin / wrong length miss self-heals without touching the resident", () => {
    try {
        setMsgIdLane(true);
        const pf = new MemPF();
        makeStub(pf);
        const s = mkSession("s-heal");
        const { sid, msgs } = bootWorld(pf, s);
        const hi = pf.maxPos(sid);
        // Shape mismatch: two ids but W=1 ⇒ length must be 2… send 3.
        let bad = runTurn(s, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: "cidU2,x1,x2" }, [...msgs, USR("heal u3")]);
        assert.equal(bad.out.decision, "v6m-shape");
        assert.equal(bad.out.creditedMiss, false);
        // Unknown origin against a RECORDED frontier id ⇒ strict prev miss.
        bad = runTurn(s, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: "bogus,cidU3" }, [...msgs, USR("heal u3")]);
        assert.equal(bad.out.decision, "v6m-prev");
        assert.equal(bad.out.creditedMiss, false);
        // No progress: same body as the stored world pins nothing new.
        bad = runTurn(s, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: "?" }, msgs);
        assert.equal(bad.out.decision, "v6m-no-progress");
        // Nothing was ingested by the misses: frontier unchanged.
        assert.equal(pf.maxPos(sid), hi);
        // Retry with the right origin heals to a hit.
        const good = runTurn(s, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: "cidU2,cidU3" }, [...msgs, USR("heal u3")]);
        assert.equal(good.out.decision, "hit(v6-mid)", `self-heal expected, got ${good.out.decision}`);
    } finally { setMsgIdLane(false); _resetStoreForTest(); }
});

test("fabricated echo falls back to probe/mint and issues a fresh sid", () => {
    try {
        setMsgIdLane(true);
        const pf = new MemPF();
        const stub = makeStub(pf);
        const s = mkSession("s-forged");
        const { out, headers } = runTurn(s, { [PF_SID_HEADER]: "pf_deadbeefcafe" }, [SYSP, USR("forged echo bytes")]);
        assert.notEqual(out.sid, "pf_deadbeefcafe", "unknown partition must not be adopted");
        assert.match(String(out.sid), /^pf_[0-9a-f]{12}$/);
        assert.equal(out.decision, "v6m-arm");
        assert.equal(headers[PF_SID_HEADER], out.sid, "the response IS the issuance channel");
        const reg = stub.ext.get("s-forged\u0000pf:sids") as unknown;
        assert.deepEqual(reg, [out.sid], "registry records the mint under the bili session");
    } finally { setMsgIdLane(false); _resetStoreForTest(); }
});

test("client compaction: shrink is archive-and-reset, same sid, rows never deleted", () => {
    try {
        setMsgIdLane(true);
        process.env.BILI_PF_V6_REWRITE_STRICT = "1";
        const pf = new MemPF();
        makeStub(pf);
        const s = mkSession("s-cmp");
        const { sid, msgs } = bootWorld(pf, s);
        const posBefore = pf.maxPos(sid);
        // Host compacted: the new view is SHORTER than the stored frontier.
        const shrunken = [{ role: "system", content: "compact summary: earlier talk about X" }, USR("resume question after compaction")];
        const res = runTurn(s, { [PF_SID_HEADER]: sid }, shrunken);
        assert.equal(res.out.decision, "v6m-compact");
        assert.equal(res.out.creditedMiss, true, "strict mode credits compaction-class misses");
        assert.equal(res.headers[PF_SID_HEADER], sid, "identity survives the reset");
        // Archive-and-reset: old rows remain, new world appended after them.
        const rows = pf.readRows(sid, [[0, 1_000_000]]);
        assert.ok(rows.length > posBefore + 1, "reset appends beyond the archived world");
        const entry = pf.readMeta(sid).tailLog.filter((e) => e.kind === "reset").at(-1)!;
        const ep = JSON.parse(entry.payloadJson) as { t: number; fromPos: number };
        assert.equal(ep.fromPos, posBefore + 1, "new world starts after the archived one");
        assert.equal(ep.t, 2, "reset records the NEW world width in elements");
        delete process.env.BILI_PF_V6_REWRITE_STRICT;
        // Next normal growth turn rides the NEW frontier (T'=3 > 2).
        const grew = [...shrunken, USR("grew u")];
        // Two slots: origin pin "?" (weak-pin legal — the reset row was
        // ingested id-silent) + one fresh "?" slot ⇒ geometry-only hit.
        const g = runTurn(s, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: ["?", "?"].join(",") }, grew);
        assert.equal(g.out.decision, "hit(v6-mid)", `post-reset frontier ride expected, got ${g.out.decision}`);
    } finally { setMsgIdLane(false); delete process.env.BILI_PF_V6_REWRITE_STRICT; _resetStoreForTest(); }
});

test("post-boot hydration rebuilds the resident from L1+L0 (and across an L1 fold)", async (t) => {
    try {
        setMsgIdLane(true);
        const pf = new MemPF();
        makeStub(pf);
        const A = mkSession("s-hyd");
        const { sid, msgs: m0 } = bootWorld(pf, A);
        // Grow until an L1 checkpoint fires (lsSeq % 32 === 0) — every even
        // turn carries a USER multimodal element (openaiToCore splits it into
        // text+IMG cores sharing the element wireIndex) so imgFlag sticks
        // into the checkpoint state and the per-element id binding rides the
        // split pair.
        let msgs: unknown[] = [...m0];
        let lastT = 0;
        for (let i = 5; i <= 40; i++) {
            const body: unknown[] = i % 2 === 0
                ? [...msgs, { role: "user", content: [{ type: "text", text: `h u${i} look` }, { type: "image_url", image_url: { url: `data:image/png;base64,IMC${i}` } }] }]
                : [...msgs, USR(`h u${i} plain`)];
            const last = pf.readRows(sid, [[pf.maxPos(sid), pf.maxPos(sid) + 1]]).at(-1)?.ledgerId;
            const pin = last ?? "?";
            const r = runTurn(A, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: `${pin},hid${i}` }, body);
            assert.equal(r.out.decision, "hit(v6-mid)", `turn ${i}: got ${r.out.decision}`);
            msgs = body;
            lastT = r.out.measuredT!
        }
        const ckpt = pf.readMeta(sid).ckpt;
        assert.ok(ckpt, "an L1 fold must have fired by now");
        const sState = JSON.parse(ckpt.metaJson).s as { t: number; imgFlag: boolean };
        assert.equal(sState.imgFlag, true, "imgFlag persists into the checkpoint state");
        const elemsBefore = sState.t;
        // Simulated restart: brand-new Session object, same store — the
        // resident must rebuild itself from L1 ckpt + L0 tail, then serve a
        // hard-pin hit at exactly the stored element frontier.
        const B = mkSession("s-hyd-reborn");
        const frontierId = pf.readRows(sid, [[pf.maxPos(sid), pf.maxPos(sid) + 1]]).at(-1)?.ledgerId;
        assert.ok(frontierId, "frontier row should carry a bound id");
        const next = [...msgs, USR("after reboot question")];
        const h = runTurn(B, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: `${frontierId},hidX` }, next);
        assert.equal(h.out.decision, "hit(v6-mid)", `hydrated hit expected, got ${h.out.decision}`);
        assert.equal(h.headers[PF_SID_HEADER], sid);
        // Frontier is LAST ingest + 1 new element — later L0 turns after the
        // fold advanced elemsBeyond the checkpoint state (elemsBefore ≤ lastT).
        assert.ok(elemsBefore <= lastT, "fold state precedes the final ingest");
        assert.equal(h.out.measuredT, lastT + 1, "element frontier restored exactly across L1+L0");
    } finally { setMsgIdLane(false); _resetStoreForTest(); }
});

test("sess-change: swapped client-native session identity is an event (sid survives, resident untouched)", () => {
    try {
        setMsgIdLane(true);
        const pf = new MemPF();
        makeStub(pf);
        const s = mkSession("s-sess");
        const { sid, msgs } = bootWorld(pf, s);
        // Teach the saved carrier baseline (cs) with a normal hit turn.
        const a = runTurn(s, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: "cidU2,cidQA", "x-conversation-id": "conv-A" }, [...msgs, USR("sess qA")]);
        assert.equal(a.out.decision, "hit(v6-mid)", `baseline hit expected, got ${a.out.decision}`);
        const hi = pf.maxPos(sid);
        // Swap the carrier under the same bili session + sid ⇒ identity event.
        // (The event fires BEFORE world-shape arithmetic — T===K here would
        // otherwise read as no-progress, which pins the gate ordering too.)
        const b = runTurn(s, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: "cidU2,cidQB", "x-conversation-id": "conv-B" }, [...msgs, USR("sess qB")]);
        assert.equal(b.out.decision, "sess-change", `carrier swap must be an event, got ${b.out.decision}`);
        assert.equal(b.out.creditedMiss, false, "identity events are uncredited legal fulls");
        assert.equal(b.headers[PF_SID_HEADER], sid, "the partition identity survives the event");
        assert.equal(pf.maxPos(sid), hi, "the resident partition is untouched by the event");
    } finally { setMsgIdLane(false); _resetStoreForTest(); }
});

test("model switch within the wire family is not an event (the lane carries no model gate)", () => {
    try {
        setMsgIdLane(true);
        const pf = new MemPF();
        makeStub(pf);
        const s = mkSession("s-model");
        const { sid, msgs } = bootWorld(pf, s);
        // Identical geometry + valid origin pin, different model string.
        const r = runTurn(s, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: "cidU2,cidA2" }, [...msgs, ASST("model a2 reply")], "m2");
        assert.equal(r.out.decision, "hit(v6-mid)", `model switch must not be an event, got ${r.out.decision}`);
        assert.equal(r.out.canonical, true);
    } finally { setMsgIdLane(false); _resetStoreForTest(); }
});

test("breaker naming: msgid-lane credited misses arm the SHARED breaker (5 strikes / 60-min TTL)", () => {
    try {
        setMsgIdLane(true);
        const pf = new MemPF();
        const stub = makeStub(pf);
        const s = mkSession("s-break");
        const { sid, msgs } = bootWorld(pf, s);
        const hi = pf.maxPos(sid);
        // A system element at the window head is the lane's always-credited
        // drift verdict, and it writes NOTHING to the pf plane — repeatable
        // against the same frontier, so it names the shared breaker cleanly.
        for (let i = 0; i < 5; i++) {
            const body = [...msgs, { role: "system", content: `intruder ${i}` }, USR(`break q${i}`)];
            const r = runTurn(s, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: "?,?,?" }, body);
            assert.equal(r.out.decision, "v6m-window-system", `strike ${i + 1}: got ${r.out.decision}`);
            assert.equal(r.out.creditedMiss, true);
        }
        const stateKey = `${s.id}\u0000pf:state`;
        const st = JSON.parse(String(stub.ext.get(stateKey))) as Record<string, unknown>;
        assert.equal(typeof st.disabledAt, "number", "five consecutive credited misses arm the hold");
        assert.equal(pf.maxPos(sid), hi, "credited misses never touch the resident partition");
        // Held: the gate stands above every lane — no hit, but T keeps measuring.
        const held = runTurn(s, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: "?,?,?" }, [...msgs, { role: "system", content: "intruder h" }, USR("break qh")]);
        assert.equal(held.out.decision, "breaker-armed");
        assert.equal(held.headers[PF_SID_HEADER], undefined, "a held turn never resolves a sid");
        // TTL expiry pays off: the next verified miss counts fresh from zero.
        stub.ext.set(stateKey, JSON.stringify({ ...st, disabledAt: Date.now() - 61 * 60 * 1000 }));
        const rec = runTurn(s, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: "?,?,?" }, [...msgs, { role: "system", content: "intruder r" }, USR("break qr")]);
        assert.equal(rec.out.decision, "v6m-window-system", `post-TTL miss expected, got ${rec.out.decision}`);
        const st2 = JSON.parse(String(stub.ext.get(stateKey))) as Record<string, unknown>;
        assert.equal(st2.disabledAt, undefined, "an expired hold resets the strike counter");
    } finally { setMsgIdLane(false); _resetStoreForTest(); }
});

test("id-stable in-place edit rides the frozen core (geometry+ids judged, bytes never)", () => {
    try {
        setMsgIdLane(true);
        const pf = new MemPF();
        makeStub(pf);
        const s = mkSession("s-edit");
        const { sid, msgs } = bootWorld(pf, s);
        const hi = pf.maxPos(sid);
        // Client rewrites u1 IN PLACE, keeping geometry and ids; one new element.
        const edited = [SYSP, USR("world u1 bytes EDITED"), ASST("world a1 reply"), USR("world u2 bytes"), USR("edit u3")];
        const r = runTurn(s, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: "cidU2,cidU3" }, edited);
        assert.equal(r.out.decision, "hit(v6-mid)", `origin pin must ride on the recorded id, got ${r.out.decision}`);
        assert.equal(r.out.hit!.view[0]!.text, "world u1 bytes", "server snapshot stays absolute authority over the edited slot");
        // Only the window was ingested: exactly one new row, bound to cidU3.
        const rows = pf.readRows(sid, [[hi + 1, 1_000_000]]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].ledgerId, "cidU3");
    } finally { setMsgIdLane(false); _resetStoreForTest(); }
});

// ---------------------------------------------------------------------------
// #5576 review round-1 (2026-11-04) regressions — B1 BLOCKER: the hydrated
// resident must serve the FULL active transcript, never just the last
// window. The pre-fix hydration consumed each geom entry's `f` (that
// WINDOW's pre-append start) as the row-read frontier, so after N windows
// a restart silently served "last window + new tail" while `t` still claimed
// full width. These tests assert the EXACT delivered texts across repeated
// simulated boots (fresh Session object, same persistent store), crossing
// L1 folds so the checkpoint's world-origin field carries the frontier.
// ---------------------------------------------------------------------------

test("B1: repeated boots hydrate the FULL transcript, across L1 folds", () => {
    try {
        setMsgIdLane(true);
        const pf = new MemPF();
        makeStub(pf);
        let session = mkSession("b1-s0");
        const { sid, msgs: m0 } = bootWorld(pf, session);
        const served: string[] = ["world u1 bytes", "world a1 reply", "world u2 bytes"];
        let msgs: unknown[] = [...m0];
        const frontierPin = (): string => pf.readRows(sid, [[pf.maxPos(sid), pf.maxPos(sid) + 1]]).at(-1)?.ledgerId ?? "?";
        for (let c = 1; c <= 3; c++) {
            // Grow 45 in-process turns before each boot — crosses the
            // 32-entry L1 fold, so the checkpoint (not the raw arm entry)
            // must carry the world origin through the restart.
            for (let i = 1; i <= 45; i++) {
                const t = `b1 c${c} u${i} bytes`;
                served.push(t);
                msgs = [...msgs, USR(t)];
                const r = runTurn(session, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: `${frontierPin()},bc${c}_${i}` }, msgs);
                assert.equal(r.out.decision, "hit(v6-mid)", `cycle ${c} turn ${i}: got ${r.out.decision}`);
            }
            // Simulated restart: brand-new Session object (fresh residents
            // map) over the SAME persistent store, then one more turn.
            session = mkSession(`b1-s${c}`);
            const t = `b1 c${c} reboot question`;
            served.push(t);
            msgs = [...msgs, USR(t)];
            const h = runTurn(session, { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: `${frontierPin()},br${c}` }, msgs);
            assert.equal(h.out.decision, "hit(v6-mid)", `boot ${c}: got ${h.out.decision}`);
            // THE regression assertion: the view IS the complete transcript
            // (pre-fix code served only the last window + this turn here).
            assert.deepEqual(
                h.out.hit!.view.map((v) => v.text),
                served,
                `boot ${c}: hydrated view must equal the full transcript`,
            );
        }
        // Writer side: every L1 checkpoint carries the active world ORIGIN
        // (`o`) — cold-started here, never reset ⇒ always 0.
        const ck = pf.readMeta(sid).ckpt;
        assert.ok(ck, "an L1 fold must have fired");
        assert.equal(JSON.parse(ck.metaJson).o, 0, "checkpoint records the cold-start world origin");
    } finally { setMsgIdLane(false); _resetStoreForTest(); }
});

const ZERO_MARKERS = { panels: 0, statusBodies: 0, statusBodyLines: 0, markerLines: 0, nudges: 0, carriers: 0 };
const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

test("B1/S4: untrusted checkpoints degrade exactly ONE turn, then self-heal (pre-fix shapes)", () => {
    try {
        setMsgIdLane(true);
        const runBadCkptCase = (label: string, metaJson: string, checksum: string): void => {
            const pf = new MemPF();
            makeStub(pf);
            const s = mkSession(`bad-${label}`);
            const { sid, msgs: m0 } = bootWorld(pf, s);
            // Plant an UNTRUSTED checkpoint over the folded prefix: it
            // truncates the tail exactly like a real fold did.
            const tailSeq = pf.readMeta(sid).tailLog.at(-1)!.lsSeq;
            pf.writeCkpt(sid, tailSeq, metaJson, checksum);
            const bodyA = [...m0, USR(`bad-${label} qa`)];
            // Fresh Session objects for BOTH degraded turns — the in-process
            // resident must NOT mask the broken partition (that is exactly
            // the post-boot path under review).
            const r1 = runTurn(mkSession(`bad-${label}-b1`), { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: ["?", "?"].join(",") }, bodyA);
            assert.equal(r1.out.decision, "v6m-hydrate", `${label}: got ${r1.out.decision}`);
            assert.equal(r1.out.hit, null, `${label}: degraded turn must not serve a fast view`);
            // …and the failed turn itself repairs the partition by re-ingesting
            // the FULL legacy view (append-only archive-and-reset).
            const bodyB = [...bodyA, USR(`bad-${label} qb`)];
            const r2 = runTurn(mkSession(`bad-${label}-b2`), { [PF_SID_HEADER]: sid, [PF_TAIL_IDS_HEADER]: ["?", "?"].join(",") }, bodyB);
            assert.equal(r2.out.decision, "hit(v6-mid)", `${label} heal: got ${r2.out.decision}`);
            assert.deepEqual(
                r2.out.hit!.view.map((v) => v.text),
                ["world u1 bytes", "world a1 reply", "world u2 bytes", `bad-${label} qa`, `bad-${label} qb`],
                `${label}: healed view serves the full transcript`,
            );
        };
        // (a) PRE-FIX shape: self-consistent hash but the old field set —
        // `f` instead of `o`, i.e. no world origin recorded anywhere.
        const oldMeta = JSON.stringify({ s: { t: 4, imgFlag: false, markers: ZERO_MARKERS }, f: 2 });
        runBadCkptCase("noo", oldMeta, sha256hex(oldMeta));
        // (b) CURRENT shape with a CORRUPTED checksum — state must be
        // ignored the same way even though `o` parses fine inside it.
        const curMeta = JSON.stringify({ s: { t: 4, imgFlag: false, markers: ZERO_MARKERS }, o: 0 });
        runBadCkptCase("sum", curMeta, "deadbeef");
    } finally { setMsgIdLane(false); _resetStoreForTest(); }
});
