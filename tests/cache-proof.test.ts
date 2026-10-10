// Cache-leak CODE PROVER (#2138, follow-up to #2131; complements #2139): a
// mechanism-level proof that bili NEVER rewrites stable bytes between calls —
// i.e. that a provider with a perfect prefix cache could not miss for any
// reason attributable to the proxy. Log-inference (the #2131 seam forensics)
// shows past traffic was clean; this prover makes "clean" an invariant that
// fails CI if it is ever broken.
//
// Why a separate suite: tests/cache-friendly-proxy.test.ts (#1548) pins the
// same lifecycle at ELEMENT level (JSON.stringify equality), which is blind
// to serialization drift — identical semantics serialized differently is a
// byte miss. This prover compares RAW WIRE BYTES: a byte-layout scanner
// splits each captured outbound body into head / message-array elements /
// post-array tail, and a judge asserts longest-prefix stability per pair
// class (all four wires, one session each, proxy mode, streaming):
//
//   GROWTH   append-only turns: head byte-identical; every core element
//            byte-identical modulo the DECLARED volatile carriers (carrier
//            contract below); only TAIL appends (the client's own additions)
//            may grow the array; the post-array suffix (tools / stream_options)
//            byte-identical;
//   RETRY    transport-failure resend (socket death pre-response on the main
//            model path, fetchWithTransportRetry #1688): the replay must be
//            BYTE-EQUAL to the failed attempt — failure handling may not
//            change a single request byte;
//   SWITCH   client-driven model change proven as a double-probe A/B: the
//            SAME history is sent twice, once per model. Every byte outside
//            the model value (and the declared volatile carriers) must stay
//            identical — the owner's "bytes unchanged but request params
//            changed -> miss" concern (#2138): parameter drift must be
//            attributable to the host's own switch, never to bili;
//   HOSTRW   control group: the CLIENT rewrote a mid-history message. Exactly
//            two outcomes are cache-safe and accepted: bili ADOPTS the edit
//            (first divergent element IS that message, everything before it
//            byte-identical) or its canonical rebuild DROPS it (full shared
//            prefix byte-stable, only the new tail appended); any other
//            mid-history churn is a leak — when bytes move, they move on the
//            host side, never bili's;
//   FOLD     compress transitions (proxy-executed): byte versions of the
//            cf-suite F1/F2/F3 (summary materialized in round-2; pre-anchor
//            head byte-stable through the fold; next turn byte-stable
//            through the last summary anchor);
//   DEGEN    degenerate-turn continuation refetch (#732/#821, injectTool off,
//            chat wire): the re-sent body carries the continuation nudge
//            MERGED into the last user turn (appendTrailingUserText contract:
//            back-to-back user turns break provider replay grouping) — zero
//            byte churn anywhere else, even when the proxy re-requests itself;
//   HOSTCOMPACT (decimation, chat wire, #2596 proxy-mode twin): the CLIENT
//            replaces its ENTIRE history with a compacted view while folds
//            are ACTIVE. Cache-safe contract: head/tail stable; the wire
//            carries exactly the compacted core (shrunk); the destroyed
//            folds' summary carriers must NOT linger (no orphan flapping);
//            every later growth turn is append-stable from the compacted
//            base; and the pipeline re-arms — a fresh fold eventually lands
//            as a clean FOLD transition (self-heal, not a silent replay).
//
// Carrier contract (increment A): volatility is DECLARED per carrier and
// located structurally instead of positionally (no "last N elements may
// drift"). The only bytes allowed to differ between two calls with identical
// history are: (1) the chain checkpoint tag <bili-chain .../>
// (src/chain-checkpoint.ts) — stamped on every outbound with a volatile
// digest+timestamp; rides as a dedicated trailing user element
// (openai/responses) or merged as a trailing text part of the last user
// element (anthropic/google); when merged, only bytes from the part's
// opening brace are volatile and the tag may MIGRATE between turns as a new
// last-user message appears (cmpEl handles both); (2) trailing NOTE messages
// whose entire payload is a declared note (retrieval correction, image-full
// guidance, kernel nudge — NOTE_MARKERS). Everything else — mid-history
// elements AND the non-carrier parts of carrier-bearing elements — must be
// byte-stable; any other difference fails CI. Marker containment cannot mask
// real drift because the client corpus is asserted carrier/brace-free below.
//
// The mock upstream doubles as an IDEAL PREFIX-CACHE BILLING JUDGE: it bills
// cached_tokens = floor(byteLCP/4) against the previous body of the stream
// and feeds bili's own ledger realistic hit rates. Self-consistency check: if
// bili ever rewrote stable bytes, the billed hit rate would collapse in the
// same run that the byte assertions catch. Block alignment to provider KV
// page boundaries is deliberately NOT simulated — the byte assertions do not
// depend on it.
//
// Scope notes: tool protocol only (default); plugin mode (agent-owned
// compress riding inbound history) has its own carrier set and is tracked
// separately. Ungated in `npm test` => permanent per-PR invariant on every
// CI leg (ubuntu/windows x node 22/24).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { conflictEventsOf } from "../src/conflict-watch.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { DEGENERATE_RETRY_NUDGE } from "../src/degenerate-retry.ts";
import { TAG_OPEN } from "../src/chain-checkpoint.ts";
import { rmrf } from "./tmp-rm.ts";

type Item = Record<string, unknown>;
type Wire = "responses" | "chat" | "anthropic" | "google";

const SUMMARY_MARKER = "[Compressed conversation section]";
const REWRITE_MARKER = "HOST-REWRITTEN";
// Declared trailing-note carriers (carrier contract): a dedicated trailing
// user element is volatile iff its ENTIRE payload carries one of these.
const NOTE_MARKERS: string[] = [
    "[billion-context] Earlier acp_retrieve result(s)",
    "[Downscaled screenshots:",
    "If you compress, fold the ranges you keep in ONE call",
    "Only use IDs from visible messages above",
    "[TIER ",
];
const THRESHOLD = 64 * 1024; // high enough that no fold can fire before MIN_FOLD_T
const MODEL_A = "gpt-proof-a";
const MODEL_B = "gpt-proof-b";
const TOOL_FAIL_T = 6;  // tool-call FAILURE turn (error result rides along)
const RETRY_T = 7;      // transport-failure resend turn (socket destroyed pre-response)
const SWITCH_T = 8;     // client switches model A -> B
const UNSWITCH_T = 9;   // client switches back B -> A
const REWRITE_T = 10;   // client rewrites a mid-history message (control group)
const MIN_FOLD_T = 11;  // folds only after all scripted scenarios have passed
const MAX_TURNS = 24;
// Render-tag echo case: the only visible content is an ACP tag, so the
// prose filter empties the turn and the degenerate refetch must fire.
const TAG_ONLY_REPLY = '\x3cacp tokens="2" type="text"\x3em00001\x3c/acp\x3e';
const INSTRUCTIONS = "You are a coding agent operating in a sandbox.\nFollow repo conventions strictly.\nRun tests before finishing.\nEnvironment notes: linux, node 22, repo at /workspace.";
const TOOL_RESULT_OK = (t: number): string => `total 8\n-rw-r--r-- 1 u g 42 Sep 27 10:00 file-${t}.ts`;
const TOOL_RESULT_FAIL = (t: number): string => `Error: exit code 1\nls: cannot access 'mod-${t}': No such file or directory`;

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the build pipeline ran cleanly and the integration suite reported no regressions across all four regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

// Masking guard: client-generated content must never resemble a declared
// carrier or carry braces (the firstBraceBefore heuristic assumes the tag is
// the only brace-bearing construct it can meet inside an element).
for (const s of [INSTRUCTIONS, TOOL_RESULT_OK(0), TOOL_RESULT_FAIL(0), FILLER(0, 1)]) {
    assert.ok(!s.includes("{") && !s.includes("<") && !s.includes(TAG_OPEN) && !NOTE_MARKERS.some((m) => s.includes(m)),
        `corpus template must stay carrier/brace-free: ${JSON.stringify(s.slice(0, 24))}`);
}

const asArr = (x: unknown): Item[] => (Array.isArray(x) ? (x as Item[]) : []);

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

function replyLabel(body: string): string {
    const re = /Turn (\d+):/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) { /* keep last */ }
    return m ? m[1]! : "0";
}


interface Layout { arrStart: number; elems: Array<[number, number]>; arrEnd: number; }

/** Split an outbound JSON body into head [0,arrStart), the raw element slices
 *  of the message array, and the post-array tail [arrEnd,end). Element
 *  contents are compared as RAW BYTES (the whole point vs the cf suite).
 *  Works in UTF-8 byte space: JSON structural characters are ASCII and can
 *  never occur inside a multibyte sequence, so byte scanning is exact for
 *  any content encoding. */
function layoutOf(buf: Buffer, arrField: string): Layout {
    const key = Buffer.from(`"${arrField}":[`);
    const i = buf.indexOf(key);
    assert.ok(i >= 0, `outbound body lacks "${arrField}":[`);
    const start = i + key.length - 1;
    const elems: Array<[number, number]> = [];
    let depth = 0;
    let inStr = false;
    let esc = false;
    let elemStart = -1;
    let arrEnd = -1;
    for (let p = start; p < buf.length; p++) {
        const c = String.fromCharCode(buf[p]!);
        if (inStr) {
            if (esc) esc = false;
            else if (c === "\\") esc = true;
            else if (c === '"') {
                inStr = false;
                if (depth === 1 && elemStart >= 0) { elems.push([elemStart, p + 1]); elemStart = -1; }
            }
            continue;
        }
        if (c === '"') {
            inStr = true;
            if (depth === 1 && elemStart < 0) elemStart = p;
            continue;
        }
        if (c === "{" || c === "[") {
            if (depth === 1 && elemStart < 0) elemStart = p;
            depth++;
            continue;
        }
        if (c === "}" || c === "]") {
            depth--;
            if (depth === 1 && elemStart >= 0) { elems.push([elemStart, p + 1]); elemStart = -1; }
            else if (depth === 0) { arrEnd = p + 1; break; }
        }
    }
    assert.ok(arrEnd > start, `unterminated ${arrField} array`);
    assert.ok(elemStart < 0, `malformed scalar element in ${arrField} array`);
    return { arrStart: start, elems, arrEnd };
}

function lcpBytes(a: Buffer, b: Buffer): number {
    const n = Math.min(a.length, b.length);
    let k = 0;
    while (k < n && a[k] === b[k]) k++;
    return k;
}

const sha16 = (b: string): string => createHash("sha256").update(b, "utf8").digest("hex").slice(0, 16);

const elText = (buf: Buffer, L: Layout, i: number): string => {
    const [s, e] = L.elems[i]!;
    return buf.subarray(s, e).toString("utf8");
};

function leadingEqual(prev: Buffer, cur: Buffer, P: Layout, C: Layout): number {
    const n = Math.min(P.elems.length, C.elems.length);
    let k = 0;
    while (k < n) {
        const [ps, pe] = P.elems[k]!;
        const [cs, ce] = C.elems[k]!;
        if (!prev.subarray(ps, pe).equals(cur.subarray(cs, ce))) break;
        k++;
    }
    return k;
}

const headEq = (prev: Buffer, cur: Buffer, P: Layout, C: Layout): boolean => prev.subarray(0, P.arrStart).equals(cur.subarray(0, C.arrStart));
const tailEq = (prev: Buffer, cur: Buffer, P: Layout, C: Layout): boolean => prev.subarray(P.arrEnd).equals(cur.subarray(C.arrEnd));

function payloadTexts(el: Item): string[] {
    const out: string[] = [];
    if (typeof el.content === "string") out.push(el.content);
    else if (Array.isArray(el.content)) for (const b of el.content) if (typeof b?.text === "string") out.push(b.text);
    if (Array.isArray(el.parts)) for (const p of el.parts) if (typeof p?.text === "string") out.push(p.text);
    return out;
}

function isDedicatedCarrier(t: string): boolean {
    let el: Item;
    try { el = JSON.parse(t) as Item; } catch { return false; }
    const texts = payloadTexts(el);
    if (texts.length === 0) return false;
    return texts.every((tx) => tx.trim().startsWith(TAG_OPEN) || NOTE_MARKERS.some((mk) => tx.includes(mk)));
}

function firstBraceBefore(raw: string, idx: number): number {
    const i = raw.lastIndexOf("{", idx);
    assert.ok(i >= 0, `no object start before carrier at offset ${idx}`);
    return i;
}

function balancedObjectEnd(raw: string, start: number): number {
    let depth = 0;
    for (let p = start; p < raw.length; p++) {
        const c = raw[p]!;
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) return p + 1; }
    }
    throw new Error("unbalanced carrier part");
}

// Byte-compares two encodings of the same logical element in which the chain
// checkpoint may ride: strips each side's carrier part (from its opening
// brace through its closing brace, plus the separating comma) and requires
// the REMAINDER byte-equal. One side may carry no tag at all — the tag
// migrates between turns as the last-user message changes. Each stripped
// part must be a well-formed chain checkpoint followed only by closers.
function cmpEl(pe: string, ce: string, label: string): void {
    if (pe === ce) return;
    const mp = pe.indexOf(TAG_OPEN);
    const mc = ce.indexOf(TAG_OPEN);
    assert.ok(mp >= 0 || mc >= 0, `${label}: stable bytes rewritten and no declared carrier is involved`);
    const cut = (raw: string, m: number): string => {
        if (m < 0) return raw;
        const ps = firstBraceBefore(raw, m);
        const pend = balancedObjectEnd(raw, ps);
        const part = JSON.parse(raw.slice(ps, pend)) as Item;
        const txt = typeof part.text === "string" ? part.text : typeof part.content === "string" ? part.content : undefined;
        assert.ok(txt !== undefined && txt.startsWith(TAG_OPEN), `${label}: carrier part is not a chain-checkpoint tag`);
        const post = raw.slice(pend);
        assert.ok(/^[\]}]*$/.test(post), `${label}: unexpected content after the carrier part: ${JSON.stringify(post.slice(0, 48))}`);
        return (ps > 0 ? raw.slice(0, ps - 1) : "") + post;
    };
    assert.equal(cut(pe, mp), cut(ce, mc), `${label}: pre-carrier bytes drifted (only the chain checkpoint itself may be volatile)`);
}

const coreLen = (buf: Buffer, L: Layout): number => {
    let n = L.elems.length;
    while (n > 0 && isDedicatedCarrier(elText(buf, L, n - 1))) n--;
    return n;
};

interface CoreCmp { pCore: number; cCore: number; edits: number; }

// Strict core comparison under the carrier contract: dedicated carrier
// elements are peeled from the END of each side (arbitrary count —
// existentially quantified), then every remaining shared index must be
// byte-equal except (a) chain-tag volatility (cmpEl) and (b) when
// hostEditAllowed, elements carrying REWRITE_MARKER (the host's own edit —
// attributed to the host, never to bili). allowAppend expects ONE OR MORE
// new core elements — the client's own additions (new user message plus the
// prior turn's reply / tool pair; host-side, trusted, cache-safe by
// construction because the shared prefix is checked positionally);
// shrinkage belongs to fold transitions only and fails here.
function coreCompare(wire: Wire, prev: Buffer, cur: Buffer, P: Layout, C: Layout, label: string, opts: { allowAppend: boolean; hostEditAllowed?: boolean }): CoreCmp {
    const pc = coreLen(prev, P);
    const cc = coreLen(cur, C);
    assert.ok(cc >= pc, `${wire} ${label}: core element count shrank (${pc} -> ${cc}) outside a fold transition`);
    const shared = Math.min(pc, cc);
    let edits = 0;
    for (let j = 0; j < shared; j++) {
        const pe = elText(prev, P, j);
        const ce = elText(cur, C, j);
        if (pe === ce) continue;
        if (!(opts.hostEditAllowed && ce.includes(REWRITE_MARKER))) cmpEl(pe, ce, `${wire} ${label} elem[${j}]`);
        else edits++;
    }
    const appends = cc - shared;
    if (opts.allowAppend) assert.ok(appends >= 1, `${wire} ${label}: no core elements appended — pair is not a growth`);
    else assert.equal(appends, 0, `${wire} ${label}: core element count changed without a scripted append`);
    return { pCore: pc, cCore: cc, edits };
}

function countSummaryEls(buf: Buffer, L: Layout): number {
    let n = 0;
    for (let i = 0; i < L.elems.length; i++) n += elText(buf, L, i).split(SUMMARY_MARKER).length - 1;
    return n;
}

function firstSummaryEl(buf: Buffer, L: Layout): number {
    for (let i = 0; i < L.elems.length; i++) if (elText(buf, L, i).includes(SUMMARY_MARKER)) return i;
    return -1;
}

function lastSummaryEl(buf: Buffer, L: Layout): number {
    for (let i = L.elems.length - 1; i >= 0; i--) if (elText(buf, L, i).includes(SUMMARY_MARKER)) return i;
    return -1;
}

function isRound2Body(wire: Wire, p: Item): boolean {
    switch (wire) {
        case "responses":
            return asArr(p.input).some((it) => it.type === "function_call" && it.name === "compress");
        case "chat":
            return asArr(p.messages).some((m) => asArr(m.tool_calls).some((tc) => {
                const f = typeof tc.function === "object" && tc.function !== null ? tc.function as Item : undefined;
                return f?.name === "compress";
            }));
        case "anthropic":
            return asArr(p.messages).flatMap((m) => (typeof m.content === "string" ? [] : asArr(m.content))).some((b) => b.type === "tool_use" && b.name === "compress");
        case "google":
            return asArr(p.contents).flatMap((c) => asArr(c.parts)).some((pt) => {
                const fc = typeof pt.functionCall === "object" && pt.functionCall !== null ? pt.functionCall as Item : undefined;
                return fc?.name === "compress";
            });
    }
}


function checkGrowth(wire: Wire, bodies: string[], field: string, i: number, lines: string[]): void {
    const prev = bodies[i - 1]!;
    const cur = bodies[i]!;
    const PB = Buffer.from(prev, "utf8");
    const CB = Buffer.from(cur, "utf8");
    const P = layoutOf(PB, field);
    const C = layoutOf(CB, field);
    assert.ok(headEq(PB, CB, P, C), `${wire} pair#${i}->#${i + 1}: HEAD bytes mutated during growth — cache miss at byte 0`);
    const r = coreCompare(wire, PB, CB, P, C, `pair#${i}->#${i + 1}`, { allowAppend: true });
    assert.ok(tailEq(PB, CB, P, C), `${wire} pair#${i}->#${i + 1}: post-array suffix (tools/stream_options) mutated during growth`);
    lines.push(`proof[${wire}] pair#${i}->#${i + 1} GROWTH ok lcp=${lcpBytes(PB, CB)}/${CB.length} core=${r.pCore}->${r.cCore}(+${r.cCore - r.pCore}) carriers=declared sha=${sha16(cur)}`);
}

function checkRetry(wire: Wire, bodies: string[], i: number, lines: string[]): void {
    const prev = bodies[i - 1]!;
    const cur = bodies[i]!;
    assert.equal(cur, prev, `${wire} pair#${i}->#${i + 1}: transport retry RESENT DIFFERENT BYTES — failure handling rewrote the request`);
    lines.push(`proof[${wire}] pair#${i}->#${i + 1} RETRY ok bytes-equal sha=${sha16(cur)}`);
}

const maskModelValue = (b: string): string => b.replace(/"model":"[^"]*"/g, '"model":"proof-mask"');

/** Double-probe A/B: the SAME client history was sent twice, once per model
 *  (the driver's switch scenario). Everything the proxy emits MUST be a pure
 *  function of (history, model): after masking the model value, head and
 *  post-array suffix are byte-identical, the core element count is unchanged,
 *  and every core element is byte-identical modulo declared carriers. Any
 *  further drift means bili re-derived request parameters from the model —
 *  the "bytes unchanged but params changed -> miss" leak class (#2138). */
function checkSwitch(wire: Wire, bodies: string[], field: string, i: number, lines: string[]): void {
    const prev = bodies[i - 1]!;
    const cur = bodies[i]!;
    const PB = Buffer.from(prev, "utf8");
    const CB = Buffer.from(cur, "utf8");
    const P = layoutOf(PB, field);
    const C = layoutOf(CB, field);
    if (wire !== "google") {
        const p = JSON.parse(prev) as Item;
        const c = JSON.parse(cur) as Item;
        assert.notEqual(String(c.model), String(p.model), `${wire} pair#${i}->#${i + 1}: probe did not actually change the model`);
        assert.equal(maskModelValue(CB.subarray(0, C.arrStart).toString("utf8")), maskModelValue(PB.subarray(0, P.arrStart).toString("utf8")), `${wire} pair#${i}->#${i + 1}: head bytes drifted beyond the model value on switch — bili re-derived ${field}-head params from the model`);
    }
    const r = coreCompare(wire, PB, CB, P, C, `pair#${i}->#${i + 1}`, { allowAppend: false });
    assert.ok(tailEq(PB, CB, P, C), `${wire} pair#${i}->#${i + 1}: post-array suffix (tools/stream_options/generationConfig) drifted on model switch`);
    lines.push(`proof[${wire}] pair#${i}->#${i + 1} SWITCH ok same-history-A/B drift=${wire === "google" ? "url-model-only" : "model-value-only"} carriers=declared core=${r.pCore}->${r.cCore} sha=${sha16(cur)}`);
}

/** Host-side mid-history rewrite (control group): the client edits an old
 *  message in its own history and re-sends. Two outcomes are cache-safe and
 *  both are accepted; anything else is an unexplained leak:
 *  (A) bili rebuilds the wire from its OWN canonical session state — the edit
 *      never reaches the bytes: the full shared prefix stays byte-stable and
 *      only the new tail is appended (the host's edit is dropped by design;
 *      any miss here is attributable to the host, zero bili-rewritten bytes);
 *  (B) bili adopts the edit — exactly the first divergent element carries the
 *      marker and everything before it is byte-stable (miss attributable to
 *      the host's own edit from that byte on). */
function checkHostRewrite(wire: Wire, bodies: string[], field: string, i: number, lines: string[]): void {
    const prev = bodies[i - 1]!;
    const cur = bodies[i]!;
    const PB = Buffer.from(prev, "utf8");
    const CB = Buffer.from(cur, "utf8");
    const P = layoutOf(PB, field);
    const C = layoutOf(CB, field);
    assert.ok(!prev.includes(REWRITE_MARKER), `${wire} pair#${i}->#${i + 1}: control invalid — marker predates the rewrite`);
    assert.ok(headEq(PB, CB, P, C), `${wire} pair#${i}->#${i + 1}: head bytes mutated across a host-side rewrite`);
    assert.ok(tailEq(PB, CB, P, C), `${wire} pair#${i}->#${i + 1}: post-array suffix mutated across a host-side rewrite`);
    const r = coreCompare(wire, PB, CB, P, C, `pair#${i}->#${i + 1}`, { allowAppend: true, hostEditAllowed: true });
    if (cur.includes(REWRITE_MARKER)) {
        assert.equal(r.edits, 1, `${wire} pair#${i}->#${i + 1}: expected exactly one host-edited core element, got ${r.edits} — bili moved something mid-history`);
        lines.push(`proof[${wire}] pair#${i}->#${i + 1} HOSTRW ok edit-adopted core=${r.pCore}->${r.cCore}(+${r.cCore - r.pCore}) sha=${sha16(cur)}`);
    } else {
        assert.equal(r.edits, 0, `${wire} pair#${i}->#${i + 1}: host edit absent from wire BUT core churn detected — unexplained mid-history movement`);
        lines.push(`proof[${wire}] pair#${i}->#${i + 1} HOSTRW ok edit-dropped-by-canonical-rebuild core=${r.pCore}->${r.cCore}(+${r.cCore - r.pCore}) sha=${sha16(cur)}`);
    }
}

function checkFoldPre(wire: Wire, bodies: string[], field: string, i: number, lines: string[]): void {
    // i = round-2 index; compare trigger turn (pre) -> round-2 (r2).
    const pre = bodies[i - 1]!;
    const r2 = bodies[i]!;
    const PB = Buffer.from(pre, "utf8");
    const RB = Buffer.from(r2, "utf8");
    const P = layoutOf(PB, field);
    const R = layoutOf(RB, field);
    assert.equal(countSummaryEls(RB, R), countSummaryEls(PB, P) + 1, `${wire} fold@req#${i}: REGRESSION(#1548): round-2 must carry exactly one more summary occurrence`);
    assert.ok(headEq(PB, RB, P, R), `${wire} fold@req#${i}: fold mutated the head`);
    const f = firstSummaryEl(RB, R);
    assert.ok(f >= 0, `${wire} fold@req#${i}: round-2 lacks the summary carrier`);
    const k = leadingEqual(PB, RB, P, R);
    assert.ok(k >= f, `${wire} fold@req#${i}: fold mutated pre-anchor element[${k}] (anchor=[${f}]) — upstream cache match collapses before the summary`);
    lines.push(`proof[${wire}] pair#${i - 1}->#${i} FOLD-A ok summaries=${countSummaryEls(PB, P)}->${countSummaryEls(RB, R)} pre-anchor-bytes-stable(anchor=[${f}]) sha=${sha16(r2)}`);
}

function checkFoldNext(wire: Wire, bodies: string[], field: string, i: number, lines: string[]): void {
    // i = round-2 index; compare round-2 (r2) -> next client turn.
    const r2 = bodies[i]!;
    const next = bodies[i + 1]!;
    const RB = Buffer.from(r2, "utf8");
    const NB = Buffer.from(next, "utf8");
    const R = layoutOf(RB, field);
    const N = layoutOf(NB, field);
    const last = lastSummaryEl(RB, R);
    const k = leadingEqual(RB, NB, R, N);
    assert.ok(k > last, `${wire} fold@req#${i}: next turn diverges at element[${k}] BEFORE the summary anchor [${last}] — cache match collapses to the stable head`);
    assert.equal(countSummaryEls(NB, N), countSummaryEls(RB, R), `${wire} fold@req#${i}: next turn lost or gained a summary`);
    lines.push(`proof[${wire}] pair#${i}->#${i + 1} FOLD-B ok stable-through-summary(anchor=[${last}]) sha=${sha16(next)}`);
}

/** The refetch re-issues the SAME forwarded body with the continuation nudge
 *  appended via appendTrailingUserText, which MERGES into the last user turn
 *  when there is one (back-to-back user turns break provider replay grouping).
 *  Contract proven here: element count unchanged, every element before the
 *  last byte-identical, and the last user turn's text extended by exactly
 *  "\n\n" + nudge — zero churn anywhere else. */
function checkDegenerate(wire: Wire, bodies: string[], field: string, i: number, lines: string[]): void {
    const orig = bodies[i - 1]!;
    const retry = bodies[i]!;
    const OB = Buffer.from(orig, "utf8");
    const RB = Buffer.from(retry, "utf8");
    const O = layoutOf(OB, field);
    const R = layoutOf(RB, field);
    const oLast = JSON.parse(elText(OB, O, O.elems.length - 1)) as Item;
    assert.equal(oLast.role, "user", `${wire} pair#${i}->#${i + 1}: precondition — original body must end on a user turn for the merge contract`);
    assert.equal(typeof oLast.content, "string", `${wire} pair#${i}->#${i + 1}: precondition — last user turn carries plain text content`);
    assert.equal(R.elems.length, O.elems.length, `${wire} pair#${i}->#${i + 1}: refetch changed the element count (nudge must merge, not append)`);
    assert.ok(headEq(OB, RB, O, R), `${wire} pair#${i}->#${i + 1}: refetch mutated the head`);
    const k = leadingEqual(OB, RB, O, R);
    assert.equal(k, O.elems.length - 1, `${wire} pair#${i}->#${i + 1}: refetch mutated stable message[${k}]`);
    assert.ok(tailEq(OB, RB, O, R), `${wire} pair#${i}->#${i + 1}: refetch mutated the post-array suffix`);
    const rLast = JSON.parse(elText(RB, R, R.elems.length - 1)) as Item;
    assert.equal(rLast.role, "user", `${wire} pair#${i}->#${i + 1}: refetch replaced the last user turn's role`);
    assert.equal(String(rLast.content), `${oLast.content}\n\n${DEGENERATE_RETRY_NUDGE}`, `${wire} pair#${i}->#${i + 1}: nudge not merged verbatim ("\\n\n" + nudge) into the last user turn`);
    lines.push(`proof[${wire}] pair#${i}->#${i + 1} DEGEN ok nudge-merged-into-trailing-user-turn zero-other-churn sha=${sha16(retry)}`);
}


interface JudgeState {
    wire: Wire;
    bodies: string[];
    urls: string[];
    turn: number;
    destroyOnNext: boolean;
    tagOnlyNext: boolean;
    suppressTrigger: boolean;
}

function makeProofTrigger(threshold: number, minTurns: number): { calls: () => number; should: (body: string, turn: number) => boolean; args: (refs: string[]) => string } {
    let lastDemandBytes = Infinity;
    let sinceDemand = 99;
    let calls = 0;
    return {
        calls: () => calls,
        should(body: string, turn: number): boolean {
            if (turn < minTurns) return false;
            const bytes = Buffer.byteLength(body);
            const refs = parseRefIds(body);
            const noShrinkAfterDemand = sinceDemand <= 2 && bytes >= lastDemandBytes * 0.9;
            if (bytes > threshold && refs.length >= 12 && !noShrinkAfterDemand) {
                lastDemandBytes = bytes;
                sinceDemand = 0;
                calls++;
                return true;
            }
            sinceDemand++;
            return false;
        },
        args(refs: string[]): string {
            const start = refs[2]!;
            const end = refs[refs.length - 6]!;
            return JSON.stringify({
                content: [{
                    startId: start,
                    endId: end,
                    topic: "proof fold",
                    summary: `Cache-proof fold summary covering ${start}..${end}: turns exercised the pipeline, builds stayed green, measurements recorded at each checkpoint.`,
                }],
            });
        },
    };
}

type ProofTrigger = ReturnType<typeof makeProofTrigger>;

function startJudgeUpstream(state: JudgeState, trigger: ProofTrigger): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            state.urls.push(req.url ?? "");
            state.bodies.push(body);
            const idx = state.bodies.length;
            if (state.destroyOnNext) {
                // Transport-failure scenario: die pre-response after receiving
                // the full body (upstream-reset on the main model path).
                state.destroyOnNext = false;
                req.socket.destroy();
                return;
            }
            // Ideal prefix-cache billing judge: bill what a perfect provider
            // would have cached — the byte LCP against the previous body.
            const bBuf = Buffer.from(body, "utf8");
            const lcp = idx > 1 ? lcpBytes(Buffer.from(state.bodies[idx - 2]!, "utf8"), bBuf) : 0;
            const cached = Math.floor(lcp / 4);
            const prompt = Math.max(1, Math.ceil(bBuf.length / 4));
            const label = replyLabel(body);
            const reply = `Reply Turn ${label}: done. ` + FILLER(Number(label), 0.2);
            const compressArgs = !state.suppressTrigger && trigger.should(body, state.turn) ? trigger.args(parseRefIds(body)) : undefined;
            const tagOnly = state.tagOnlyNext;
            state.tagOnlyNext = false;
            switch (state.wire) {
                case "responses": {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                    const blk = (type: string, data: Record<string, unknown>): void => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
                    const usage = { input_tokens: prompt, output_tokens: 5, input_tokens_details: { cached_tokens: cached } };
                    if (compressArgs !== undefined) {
                        blk("response.created", { response: { id: `resp_${idx}`, status: "in_progress" } });
                        blk("response.output_item.added", { output_index: 0, item: { type: "function_call", id: `fc_${idx}`, call_id: `call_cmp_${idx}`, name: "compress", arguments: "", status: "in_progress" } });
                        blk("response.function_call_arguments.delta", { item_id: `fc_${idx}`, output_index: 0, delta: compressArgs });
                        blk("response.function_call_arguments.done", { item_id: `fc_${idx}`, output_index: 0, arguments: compressArgs });
                        blk("response.output_item.done", { output_index: 0, item: { type: "function_call", id: `fc_${idx}`, call_id: `call_cmp_${idx}`, name: "compress", arguments: compressArgs, status: "completed" } });
                        blk("response.completed", { response: { id: `resp_${idx}`, status: "completed", usage, output: [{ type: "function_call", id: `fc_${idx}`, call_id: `call_cmp_${idx}`, name: "compress", arguments: compressArgs, status: "completed" }] } });
                    } else {
                        blk("response.created", { response: { id: `resp_${idx}`, status: "in_progress" } });
                        blk("response.output_item.added", { output_index: 0, item: { type: "message", id: `msg_${idx}`, role: "assistant", status: "in_progress", content: [] } });
                        blk("response.output_text.delta", { item_id: `msg_${idx}`, output_index: 0, content_index: 0, delta: reply });
                        blk("response.output_text.done", { item_id: `msg_${idx}`, output_index: 0, text: reply });
                        blk("response.output_item.done", { output_index: 0, item: { type: "message", id: `msg_${idx}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply }] } });
                        blk("response.completed", { response: { id: `resp_${idx}`, status: "completed", usage, output: [{ type: "message", id: `msg_${idx}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply }] }] } });
                    }
                    res.end();
                    return;
                }
                case "chat": {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                    const line = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
                    const usage = { prompt_tokens: prompt, completion_tokens: 5, total_tokens: prompt + 5, prompt_tokens_details: { cached_tokens: cached } };
                    if (compressArgs !== undefined) {
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_cmp_${idx}`, type: "function", function: { name: "compress", arguments: compressArgs } }] } }] });
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage });
                    } else {
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: tagOnly ? TAG_ONLY_REPLY : reply } }] });
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
                    }
                    res.write("data: [DONE]\n\n");
                    res.end();
                    return;
                }
                case "anthropic": {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                    const ev = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
                    ev("message_start", { type: "message_start", message: { id: `msg_a_${idx}`, role: "assistant", usage: { input_tokens: prompt, cache_read_input_tokens: cached } } });
                    if (compressArgs !== undefined) {
                        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_cmp_${idx}`, name: "compress", input: {} } });
                        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: compressArgs.slice(0, 20) } });
                        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: compressArgs.slice(20) } });
                        ev("content_block_stop", { type: "content_block_stop", index: 0 });
                        ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } });
                    } else {
                        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
                        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } });
                        ev("content_block_stop", { type: "content_block_stop", index: 0 });
                        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
                    }
                    ev("message_stop", { type: "message_stop" });
                    res.end();
                    return;
                }
                case "google": {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                    const frame = (parts: Item[], finishReason?: string): void => {
                        const candidate: Record<string, unknown> = { content: { role: "model", parts }, index: 0 };
                        if (finishReason) candidate.finishReason = finishReason;
                        res.write(`data: ${JSON.stringify({ candidates: [candidate], modelVersion: "gemini-test", usageMetadata: { promptTokenCount: prompt, cachedContentTokenCount: cached, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: prompt + 55 } })}\n\n`);
                    };
                    if (compressArgs !== undefined) {
                        const args = JSON.parse(compressArgs) as Item;
                        frame([{ functionCall: { id: `fcg_cmp_${idx}`, name: "compress", args } }]);
                        frame([], "STOP");
                    } else {
                        frame([{ text: reply }]);
                        frame([], "STOP");
                    }
                    res.end();
                    return;
                }
            }
        });
    });
}

function extractReply(wire: Wire, raw: string): string {
    let out = "";
    for (const block of raw.split("\n\n")) {
        if (wire === "responses") {
            const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            try {
                const d = JSON.parse(dataLine.slice(5).trim()) as { type?: string; delta?: string };
                if (d.type === "response.output_text.delta" && d.delta) out += d.delta;
            } catch { /* ignore */ }
        } else if (wire === "chat") {
            const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine || dataLine.includes("[DONE]")) continue;
            try {
                const d = JSON.parse(dataLine.slice(5).trim()) as { choices?: Array<{ delta?: { content?: string } }> };
                const c = d.choices?.[0]?.delta?.content;
                if (typeof c === "string") out += c;
            } catch { /* ignore */ }
        } else if (wire === "anthropic") {
            let event = "";
            const dataLines: string[] = [];
            for (const line of block.split("\n")) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
            }
            if (event !== "content_block_delta" || dataLines.length === 0) continue;
            try {
                const d = JSON.parse(dataLines.join("\n")) as { delta?: { type?: string; text?: string } };
                if (d.delta?.type === "text_delta" && d.delta.text) out += d.delta.text;
            } catch { /* ignore */ }
        } else {
            const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            try {
                const d = JSON.parse(dataLine.slice(5).trim()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
                for (const cand of d.candidates ?? []) {
                    for (const part of cand.content?.parts ?? []) {
                        if (typeof part.text === "string" && part.thought !== true) out += part.text;
                    }
                }
            } catch { /* ignore */ }
        }
    }
    return out;
}


function listen(server: http.Server): Promise<void> {
    return once(server, "listening").then(() => undefined);
}

function closeServer(s: http.Server | undefined): Promise<void> {
    return s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();
}

function proofProxyOptions(upstreamPort: number, ctx: number, injectTool: boolean): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL_A]: { context: ctx }, [MODEL_B]: { context: ctx } } } },
        modelContextLimit: ctx,
        kernelConfig: defaultConfig(ctx),
        compress: { injectTool, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    };
}

interface ProofEvents { retry: Array<[number, number]>; switch: Array<[number, number]>; rewrite: Array<[number, number]>; }

/** Drives one scripted session on one wire: growth -> tool failure ->
 *  transport retry -> model-switch A/B double-probes -> host rewrite -> folds.
 *  Returns the captured upstream bodies + URLs plus the scripted pair indices. */
async function driveProof(wire: Wire, sessionId: string, ctx: number): Promise<{ bodies: string[]; urls: string[]; ev: ProofEvents }> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `proof-${wire}-`));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmp;
    delete process.env.ACP_DUMP_BODY;
    const prevBase = process.env.BILI_REPLAY_RETRY_BASE_MS;
    process.env.BILI_REPLAY_RETRY_BASE_MS = "50";
    const bodies: string[] = [];
    const ev: ProofEvents = { retry: [], switch: [], rewrite: [] };
    const trigger = makeProofTrigger(THRESHOLD, MIN_FOLD_T);
        const state: JudgeState = { wire, bodies, urls: [], turn: 0, destroyOnNext: false, tagOnlyNext: false, suppressTrigger: false };
    let upstream: http.Server | undefined;
    let proxy: http.Server | undefined;
    try {
        upstream = startJudgeUpstream(state, trigger);
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        proxy = await startServer(proofProxyOptions(upstreamPort, ctx, true));
        await listen(proxy);
        const proxyPort = (proxy.address() as { port: number }).port;
        const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
        const urlFor = (model: string): string =>
            wire === "responses" ? `${base}/v1/responses`
            : wire === "chat" ? `${base}/v1/chat/completions`
            : wire === "anthropic" ? `${base}/v1/messages`
            : `${base}/v1beta/models/${model}:streamGenerateContent?alt=sse`;

        const hist: Item[] = [];
        const post = async (url: string, payload: Item, t: number): Promise<string> => {
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify(payload) });
            if (!res.ok) throw new Error(`${wire} turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
            return res.text();
        };
        const rewriteFirstUser = (): void => {
            const h = hist[wire === "chat" ? 1 : 0]!;
            if (wire === "google") {
                const pt = asArr(h.parts)[0]!;
                pt.text = String(pt.text ?? "").replace("Turn 0:", `Turn 0 [${REWRITE_MARKER}]:`);
            } else {
                assert.equal(typeof h.content, "string", `${wire}: first user message must be plain text`);
                h.content = String(h.content).replace("Turn 0:", `Turn 0 [${REWRITE_MARKER}]:`);
            }
            assert.ok(JSON.stringify(h).includes(REWRITE_MARKER), `${wire}: host rewrite did not land in the client history (silent no-op)`);
        };

        const SHELL_TOOL = { type: "function", name: "shell", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
        const makePayload = (model: string): Item =>
            wire === "responses" ? { model, stream: true, instructions: INSTRUCTIONS, tools: [SHELL_TOOL], input: [...hist] }
            : wire === "chat" ? { model, stream: true, messages: [...hist] }
            : wire === "anthropic" ? { model, max_tokens: 1024, stream: true, system: "You are a test assistant.", messages: [...hist] }
            : { contents: [...hist], systemInstruction: { parts: [{ text: "you are a test assistant" }] }, generationConfig: { maxOutputTokens: 4096 } };
        const postHist = async (model: string, t: number): Promise<string> => {
            const raw = await post(urlFor(model), makePayload(model), t);
            const reply = extractReply(wire, raw);
            assert.ok(reply.length > 0, `${wire} turn ${t}: empty reply`);
            return reply;
        };
        const pushResult = (t: number, result: string | undefined): void => {
            if (result === undefined) return;
            if (wire === "responses") {
                hist.push({ type: "function_call", id: `fc_t${t}`, call_id: `call_t${t}`, name: "shell", arguments: JSON.stringify({ command: `ls -la mod-${t}` }), status: "completed" });
                hist.push({ type: "function_call_output", id: `fco_t${t}`, call_id: `call_t${t}`, output: result });
            } else if (wire === "chat") {
                hist.push({ role: "assistant", content: null, tool_calls: [{ id: `call_t${t}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: `ls -la mod-${t}` }) } }] });
                hist.push({ role: "tool", tool_call_id: `call_t${t}`, content: result });
            } else if (wire === "anthropic") {
                hist.push({ role: "assistant", content: [{ type: "text", text: "running a check" }, { type: "tool_use", id: `tu_${t}`, name: "shell", input: { command: `ls -la mod-${t}` } }] });
                hist.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${t}`, content: result }] });
            } else {
                hist.push({ role: "model", parts: [{ functionCall: { id: `fcg_${t}`, name: "shell", args: { command: `ls -la mod-${t}` } } }] });
                hist.push({ role: "user", parts: [{ functionResponse: { name: "shell", response: { result } } }] });
            }
        };

        const sendTurn = async (t: number, model: string): Promise<void> => {
            state.turn = t;
            const before = bodies.length;
            if (t === RETRY_T) { state.destroyOnNext = true; ev.retry.push([before, before + 1]); }
            if (t === REWRITE_T) { rewriteFirstUser(); ev.rewrite.push([before - 1, before]); }

            const userText = `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6);
            const result = t % 2 === 0 ? (t === TOOL_FAIL_T ? TOOL_RESULT_FAIL(t) : TOOL_RESULT_OK(t)) : undefined;
            if (wire === "responses") {
                hist.push({ type: "message", role: "user", content: userText });
                const reply = await postHist(model, t);
                hist.push({ type: "reasoning", id: `rs_${t}`, encrypted_content: `enc_${t}_` + "x".repeat(200) });
                hist.push({ type: "message", id: `msg_a${t}`, role: "assistant", content: reply });
                pushResult(t, result);
            } else if (wire === "chat") {
                if (hist.length === 0) hist.push({ role: "system", content: "You are a coding agent operating in a sandbox. Follow repo conventions strictly." });
                hist.push({ role: "user", content: userText });
                const reply = await postHist(model, t);
                hist.push({ role: "assistant", content: reply });
                pushResult(t, result);
            } else if (wire === "anthropic") {
                hist.push({ role: "user", content: userText });
                const reply = await postHist(model, t);
                hist.push({ role: "assistant", content: reply });
                pushResult(t, result);
            } else {
                hist.push({ role: "user", parts: [{ text: userText }] });
                const reply = await postHist(model, t);
                hist.push({ role: "model", parts: [{ text: reply }] });
                pushResult(t, result);
            }
        };

        // Model-switch scenario as a same-history A/B double-probe: the current
        // history is sent once per model WITHOUT advancing it, so the pair
        // differs only by the model (body field, or URL on google). The probe
        // replies are discarded — bili's outbound is a function of the inbound
        // history, so the next normal turn continues from unchanged state.
        const probeSwitch = async (t: number, m1: string, m2: string): Promise<void> => {
            state.turn = t;
            const b1 = bodies.length;
            // Probes re-send an already-large history; keep the scripted
            // compress trigger from firing mid-probe (its tool-call reply
            // would be discarded anyway and break the non-empty-reply assert).
            state.suppressTrigger = true;
            await postHist(m1, t);
            const b2 = bodies.length;
            await postHist(m2, t);
            state.suppressTrigger = false;
            ev.switch.push([b1, b2]);
        };

        let sinceFold = 0;
        for (let t = 0; t < MAX_TURNS; t++) {
            const before = trigger.calls();
            if (t === SWITCH_T) await probeSwitch(t, MODEL_A, MODEL_B);
            else if (t === UNSWITCH_T) await probeSwitch(t, MODEL_B, MODEL_A);
            else await sendTurn(t, MODEL_A);
            if (trigger.calls() > before) sinceFold = 0;
            else sinceFold++;
            if (trigger.calls() >= 2 && sinceFold >= 3) break;
        }
        let guard = 0;
        while (bodies.length > 0 && isRound2Body(wire, JSON.parse(bodies[bodies.length - 1]!) as Item) && guard < 3) {
            await sendTurn(MAX_TURNS + guard, MODEL_A);
            guard++;
        }
        if (process.env.PROOF_DUMP) {
            const dir = path.join(process.env.PROOF_DUMP, wire);
            fs.mkdirSync(dir, { recursive: true });
            bodies.forEach((b, idx) => fs.writeFileSync(path.join(dir, `${String(idx).padStart(3, "0")}.json`), b));
        }
        return { bodies, urls: state.urls, ev };
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        if (prevBase === undefined) delete process.env.BILI_REPLAY_RETRY_BASE_MS;
        else process.env.BILI_REPLAY_RETRY_BASE_MS = prevBase;
        rmrf(tmp);
    }
}


const FIELD: Record<Wire, string> = { responses: "input", chat: "messages", anthropic: "messages", google: "contents" };

function runProof(wire: Wire, bodies: string[], urls: string[], ev: ProofEvents): string[] {
    const lines: string[] = [];
    assert.ok(bodies.length >= 14, `${wire}: expected a substantial request stream, got ${bodies.length}`);
    const field = FIELD[wire];
    const r2All = bodies.map((_, i) => i).filter((i) => isRound2Body(wire, JSON.parse(bodies[i]!) as Item));
    const r2Idxs = r2All.filter((i) => i > 0 && !r2All.includes(i - 1));
    assert.ok(r2Idxs.length >= 2, `${wire}: expected >= 2 compress cycles, got ${r2Idxs.length} (multi-fold coverage)`);
    for (const r2 of r2Idxs) {
        checkFoldPre(wire, bodies, field, r2, lines);
        checkFoldNext(wire, bodies, field, r2, lines);
    }
    const handled = new Set<number>();
    for (const r2 of r2Idxs) { handled.add(r2); if (r2 + 1 < bodies.length) handled.add(r2 + 1); }
    for (const [a, b] of [...ev.retry, ...ev.switch, ...ev.rewrite]) {
        assert.ok(a >= 0 && b < bodies.length, `${wire}: scripted pair [${a},${b}] out of range (${bodies.length} bodies)`);
        handled.add(b);
    }
    // Consecutive scripted events can leave their boundary pair unclassified
    // (two probe events share one unchanged history). Classify it explicitly
    // instead of letting it fall through as growth: equal core length + same
    // model ⇒ pure resend (must stay carrier-stable); different model ⇒ a
    // switch; unequal core length ⇒ the client advanced the history and the
    // pair remains a normal growth step.
    const evSorted = [...ev.retry, ...ev.switch, ...ev.rewrite].sort((x, y) => x[0] - y[0]);
    for (let k = 0; k + 1 < evSorted.length; k++) {
        const [, b1] = evSorted[k]!;
        const [a2] = evSorted[k + 1]!;
        if (a2 !== b1 + 1) continue;
        const PB = Buffer.from(bodies[b1]!, "utf8");
        const CB = Buffer.from(bodies[a2]!, "utf8");
        const P = layoutOf(PB, field);
        const C = layoutOf(CB, field);
        if (coreLen(PB, P) !== coreLen(CB, C)) continue;
        const sameModel = wire === "google"
            ? urls[b1] === urls[a2]
            : String((JSON.parse(bodies[a2]!) as Item).model) === String((JSON.parse(bodies[b1]!) as Item).model);
        handled.add(a2);
        if (sameModel) {
            assert.ok(headEq(PB, CB, P, C), `${wire} pair#${a2}->#${a2 + 1}: HEAD bytes mutated on a pure resend`);
            const r = coreCompare(wire, PB, CB, P, C, `pair#${a2}->#${a2 + 1}`, { allowAppend: false });
            assert.ok(tailEq(PB, CB, P, C), `${wire} pair#${a2}->#${a2 + 1}: post-array suffix mutated on a pure resend`);
            lines.push(`proof[${wire}] pair#${a2}->#${a2 + 1} RESEND ok same-hist-same-model core=${r.pCore}->${r.cCore} carriers=declared sha=${sha16(bodies[a2]!)}`);
        } else {
            checkSwitch(wire, bodies, field, a2, lines);
        }
    }
    let growth = 0;
    for (let i = 1; i < bodies.length; i++) {
        if (handled.has(i)) continue;
        checkGrowth(wire, bodies, field, i, lines);
        growth++;
    }
    for (const pr of ev.retry) checkRetry(wire, bodies, pr[1], lines);
    for (const pr of ev.switch) {
        if (wire === "google") {
            const [uA, uB] = [urls[pr[0]]!, urls[pr[1]]!];
            const mA = uA.includes(MODEL_A) ? MODEL_A : uA.includes(MODEL_B) ? MODEL_B : "?";
            const mB = uB.includes(MODEL_A) ? MODEL_A : uB.includes(MODEL_B) ? MODEL_B : "?";
            assert.notEqual(mB, mA, `${wire} pair#${pr[0]}->#${pr[1]}: google switch did not change the URL model (${mA} -> ${mB})`);
        }
        checkSwitch(wire, bodies, field, pr[1], lines);
    }
    for (const pr of ev.rewrite) checkHostRewrite(wire, bodies, field, pr[1], lines);
    lines.sort((x, y) => Number(x.match(/pair#\d+->#(\d+)/)?.[1] ?? 0) - Number(y.match(/pair#\d+->#(\d+)/)?.[1] ?? 0));
    for (const l of lines) console.log(l);
    lines.push(`proof[${wire}] VERDICT pairs=${bodies.length - 1} growth=${growth} retries=${ev.retry.length} switches=${ev.switch.length} hostRewrites=${ev.rewrite.length} folds=${r2Idxs.length} unexplainedDivergences=0`);
    console.log(lines[lines.length - 1]!);
    return lines;
}


test("cache proof (openai chat wire): byte-stable growth, failure paths, param drift, folds", { timeout: 120_000 }, async () => {
    const { bodies, urls, ev } = await driveProof("chat", "proof-chat", 200_000);
    assert.ok(ev.retry.length === 1, "transport-retry scenario must have produced a resend pair");
    assert.ok(ev.switch.length === 2, "both model switches must be captured");
    assert.ok(ev.rewrite.length === 1, "host-rewrite control must be captured");
    runProof("chat", bodies, urls, ev);
});

test("cache proof (anthropic wire): byte-stable growth, failure paths, param drift, folds", { timeout: 120_000 }, async () => {
    const { bodies, urls, ev } = await driveProof("anthropic", "proof-anthropic", 400_000);
    assert.ok(ev.retry.length === 1, "transport-retry scenario must have produced a resend pair");
    assert.ok(ev.switch.length === 2, "both model switches must be captured");
    assert.ok(ev.rewrite.length === 1, "host-rewrite control must be captured");
    runProof("anthropic", bodies, urls, ev);
});

test("cache proof (responses wire): byte-stable growth, failure paths, param drift, folds", { timeout: 120_000 }, async () => {
    const { bodies, urls, ev } = await driveProof("responses", "proof-responses", 200_000);
    assert.ok(ev.retry.length === 1, "transport-retry scenario must have produced a resend pair");
    assert.ok(ev.switch.length === 2, "both model switches must be captured");
    assert.ok(ev.rewrite.length === 1, "host-rewrite control must be captured");
    runProof("responses", bodies, urls, ev);
});

test("cache proof (google wire): byte-stable growth, failure paths, param drift, folds", { timeout: 120_000 }, async () => {
    const { bodies, urls, ev } = await driveProof("google", "proof-google", 1_000_000);
    assert.ok(ev.retry.length === 1, "transport-retry scenario must have produced a resend pair");
    assert.ok(ev.switch.length === 2, "both model switches must be captured");
    assert.ok(ev.rewrite.length === 1, "host-rewrite control must be captured");
    runProof("google", bodies, urls, ev);
});

// Degenerate-turn continuation refetch (#732/#821) on the chat wire with
// compress injection OFF: the model echoes only render tags, the prose filter
// empties the turn, and the proxy re-issues ITS OWN body. The re-sent bytes
// must extend the original by exactly one trailing nudge message — even the
// proxy's own failure handling must not touch a stable byte.
test("cache proof (degenerate refetch, chat wire): re-request is a pure tail append", { timeout: 120_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proof-degen-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmp;
    delete process.env.ACP_DUMP_BODY;
    const bodies: string[] = [];
    const state: JudgeState = { wire: "chat", bodies, urls: [], turn: 0, destroyOnNext: false, tagOnlyNext: false, suppressTrigger: false };
    const trigger = makeProofTrigger(THRESHOLD, MIN_FOLD_T);
    let upstream: http.Server | undefined;
    let proxy: http.Server | undefined;
    try {
        upstream = startJudgeUpstream(state, trigger);
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        proxy = await startServer(proofProxyOptions(upstreamPort, 200_000, false));
        await listen(proxy);
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const hist: Item[] = [{ role: "system", content: "You are a coding agent operating in a sandbox." }];
        const send = async (t: number, tagOnly: boolean): Promise<string> => {
            state.turn = t;
            state.tagOnlyNext = tagOnly;
            hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) });
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "proof-degen" }, body: JSON.stringify({ model: MODEL_A, stream: true, messages: [...hist] }) });
            if (!res.ok) throw new Error(`degen turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
            const raw = await res.text();
            const reply = extractReply("chat", raw);
            assert.ok(reply.length > 0, `degen turn ${t}: empty reply (refetch splice failed?)`);
            hist.push({ role: "assistant", content: reply });
            return raw;
        };
        await send(0, false);
        await send(1, true);
        assert.equal(bodies.length, 3, `expected original + refetch (got ${bodies.length} bodies)`);
        const lines: string[] = [];
        checkGrowth("chat", bodies, "messages", 1, lines);
        checkDegenerate("chat", bodies, "messages", 2, lines);
        for (const l of lines) console.log(l);
        console.log(`proof[chat-degen] VERDICT pairs=2 growth=1 refetches=1 unexplainedDivergences=0`);
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(tmp);
    }
});

/** HOSTCOMPACT (decimation, chat wire — #2596 proxy-mode twin): a plain
 *  client (no plugin headers) replaces its ENTIRE history with a compacted
 *  view while folds are active. Byte-level contract:
 *    - decimation turn: head/tail bytes stable, core carries exactly the
 *      compacted view (shrunk), and NONE of the destroyed folds' summary
 *      carriers linger on the wire (an orphan carrier would flap the prefix
 *      cache on every later turn — the #2596 complaint, proxy-mode shape);
 *    - every post-decimation growth turn is a clean GROWTH pair (append-
 *      stable from the compacted base — the cache recovers);
 *    - the pipeline re-arms: once the compacted history regrows past the
 *      threshold, a fresh fold lands as a clean FOLD-A/FOLD-B transition
 *      (self-heal, not a silent full replay). */
test("cache proof (host compaction, chat wire): decimated replay drops orphan carriers and re-arms cleanly", { timeout: 180_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proof-decim-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmp;
    delete process.env.ACP_DUMP_BODY;
    const bodies: string[] = [];
    const state: JudgeState = { wire: "chat", bodies, urls: [], turn: 0, destroyOnNext: false, tagOnlyNext: false, suppressTrigger: false };
    // minTurns=8 (not MIN_FOLD_T=11): this scenario has no scripted pre-fold
    // events to protect, and the regrowth phase needs the seed folds to land
    // early enough that decimation provably destroys ACTIVE folds.
    const trigger = makeProofTrigger(THRESHOLD, 8);
    const HOST_COMPACT = "HOST-COMPACTION: earlier work covered modules 0-9; harness built, folds landed.";
    let upstream: http.Server | undefined;
    let proxy: http.Server | undefined;
    try {
        upstream = startJudgeUpstream(state, trigger);
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        // Not proofProxyOptions: this scenario needs the aggressive nudge
        // cadence (nudgeGrowthTokens 500, as the plugin suite drives) so the
        // decimated body regains enough refs fast for the trigger's
        // refs>=12 gate — the re-arm must happen within the scripted turns.
        proxy = await startServer({
            ...proofProxyOptions(upstreamPort, 200_000, true),
            compress: { injectTool: true, injectNudge: true, nudgeGrowthTokens: 500 },
        });
        await listen(proxy);
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const hist: Item[] = [{ role: "system", content: "You are a coding agent operating in a sandbox." }];
        const send = async (t: number, suppress: boolean): Promise<void> => {
            state.turn = t;
            state.suppressTrigger = suppress;
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "proof-decim" }, body: JSON.stringify({ model: MODEL_A, stream: true, messages: [...hist] }) });
            if (!res.ok) throw new Error(`decim turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
            const reply = extractReply("chat", await res.text());
            if (reply) hist.push({ role: "assistant", content: reply });
            state.suppressTrigger = false;
        };
        // 1) seed: 12 fat turns — at least one proxy-side fold lands
        for (let t = 0; t < 12; t++) {
            hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) });
            await send(t, false);
        }
        assert.ok(trigger.calls() >= 1, `seed must land >=1 fold (got ${trigger.calls()})`);
        const seedFolds = trigger.calls();
        // 2) decimate: [system, compacted head, retained tail] — fatter
        // compacted base (≈34KB) so the regrowth phase crosses the 64KB
        // trigger threshold deterministically within the scripted turns
        const retainedUser = `Turn 10 recap: please analyze module 10. ` + FILLER(10, 8);
        // Unique retained bytes (NOT a byte-identical seed reply): a real
        // host compaction rewrites its retained tail as a fresh summary, so
        // no fold anchor can re-match it. This is what keeps the post-
        // decimation wire strictly append-stable: stale blocks find no
        // anchor, go through destroy escalation, and never render carriers.
        // (Byte-identical retention re-anchors blocks onto the survivor and
        // produces a few turns of bounded carrier healing — observed during
        // development, noted in the PR body, deliberately not pinned here.)
        const retainedAssistant = "Retained tail: final analysis of module 11 delivered, integration green. " + FILLER(11, 8);
        hist.length = 0;
        hist.push({ role: "system", content: "You are a coding agent operating in a sandbox." });
        hist.push({ role: "user", content: HOST_COMPACT + " " + FILLER(90, 8) });
        hist.push({ role: "user", content: retainedUser });
        hist.push({ role: "assistant", content: retainedAssistant });
        await send(12, true);
        const decimIdx = bodies.findIndex((b) => b.includes("HOST-COMPACTION"));
        assert.ok(decimIdx > 0, "decimation body captured");
        // 3) regrow: enough turns to deterministically cross the threshold
        //    and let the fresh fold's round-2 settle (FOLD-B needs a body
        //    AFTER the round-2)
        for (let t = 13; t < 22; t++) {
            hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) });
            await send(t, false);
        }
        if (process.env.PROOF_DUMP) {
            const dir = path.join(process.env.PROOF_DUMP, "decim");
            fs.mkdirSync(dir, { recursive: true });
            bodies.forEach((b, idx) => fs.writeFileSync(path.join(dir, `${String(idx).padStart(3, "0")}.json`), b));
        }
        assert.ok(trigger.calls() > seedFolds, `pipeline must re-arm after decimation (folds ${seedFolds} -> ${trigger.calls()})`);

        // ---- classify every pair ----
        const lines: string[] = [];
        const field = "messages";
        const r2All = bodies.map((_, i) => i).filter((i) => isRound2Body("chat", JSON.parse(bodies[i]!) as Item));
        const r2s = new Set(r2All);
        const prev = bodies[decimIdx - 1]!;
        const cur = bodies[decimIdx]!;
        const PB = Buffer.from(prev, "utf8");
        const CB = Buffer.from(cur, "utf8");
        const P = layoutOf(PB, field);
        const C = layoutOf(CB, field);
        assert.ok(headEq(PB, CB, P, C), `chat pair#${decimIdx}->#${decimIdx + 1}: head bytes mutated across host compaction`);
        assert.ok(tailEq(PB, CB, P, C), `chat pair#${decimIdx}->#${decimIdx + 1}: post-array suffix mutated across host compaction`);
        assert.ok(coreLen(CB, C) < coreLen(PB, P), `chat pair#${decimIdx}->#${decimIdx + 1}: decimated core must SHRINK (got ${coreLen(PB, P)} -> ${coreLen(CB, C)})`);
        assert.ok(!cur.includes("Cache-proof fold summary"), `chat pair#${decimIdx}->#${decimIdx + 1}: destroyed folds' summary carriers lingered on the wire (orphan flapping, #2596)`);
        assert.ok(cur.includes(HOST_COMPACT) && cur.includes("Turn 10 recap"), `chat pair#${decimIdx}->#${decimIdx + 1}: compacted view must be forwarded`);
        assert.ok(!cur.includes("acp_loop_"), `chat pair#${decimIdx}->#${decimIdx + 1}: acp_loop_ artifact leaked`);
        lines.push(`proof[chat] pair#${decimIdx}->#${decimIdx + 1} HOSTCOMPACT ok core=${coreLen(PB, P)}->${coreLen(CB, C)} carriers-dropped lcp=${lcpBytes(PB, CB)}/${CB.length} sha=${sha16(cur)}`);
        // #2695 bounded healing window: an unannounced host compaction
        // orphans fold blocks whose carriers may keep riding the wire until
        // the zombie-reap streak (3 majority-absent passes) removes them.
        // A zombie carrier is DEFINED here as a summary element whose exact
        // text already appeared pre-decimation (the destroyed seed folds'
        // carriers); the window closes at the LAST body still carrying one.
        // After that: strictly append-stable growth, clean fold transitions,
        // and the zombie never returns. Without the reap the zombie rides
        // every later fold round-2 — the bound below is the regression pin.
        const seedCarrierTexts = new Set<string>();
        for (let i = 0; i < decimIdx; i++) {
            const B = Buffer.from(bodies[i]!, "utf8");
            const L = layoutOf(B, field);
            for (let j = 0; j < L.elems.length; j++) {
                const t = elText(B, L, j);
                if (t.includes(SUMMARY_MARKER)) seedCarrierTexts.add(t);
            }
        }
        const bodyHasZombie = (i: number): boolean => {
            const B = Buffer.from(bodies[i]!, "utf8");
            const L = layoutOf(B, field);
            for (let j = 0; j < L.elems.length; j++) {
                const t = elText(B, L, j);
                if (seedCarrierTexts.has(t)) return true;
            }
            return false;
        };
        let lastDirty = -1;
        for (let i = decimIdx; i < bodies.length; i++) {
            if (i === decimIdx) continue; // decim body is clean by the pair assert above
            if (bodyHasZombie(i)) lastDirty = i;
        }
        assert.ok(lastDirty > decimIdx, "scenario drifted: expected zombie carriers to ride at least one post-decimation body");
        const ZOMBIE_SETTLE_BOUND = 9; // bodies after decimIdx; measured with the reap active
        assert.ok(lastDirty - decimIdx <= ZOMBIE_SETTLE_BOUND, `chat zombie flap not bounded: zombie carrier last seen on body #${lastDirty}, ${lastDirty - decimIdx} bodies after decimation #${decimIdx} (bound ${ZOMBIE_SETTLE_BOUND}, #2695)`);

        let postFold = false;
        for (let i = 1; i < bodies.length; i++) {
            if (i === decimIdx) continue;
            const inWindow = i > decimIdx && i <= lastDirty;
            if (inWindow) {
                if (r2s.has(i)) {
                    // Settling fold: the rearm round-2 may still carry zombie
                    // carriers from the destroyed seed folds (the reap lands
                    // after this body is forwarded). The rearm fold itself
                    // must still work: carrier present, core shrunk, and no
                    // NEW zombie spawned beyond what round-1 already had.
                    const PB = Buffer.from(bodies[i - 1]!, "utf8");
                    const RB = Buffer.from(bodies[i]!, "utf8");
                    const P = layoutOf(PB, field);
                    const R = layoutOf(RB, field);
                    assert.ok(firstSummaryEl(RB, R) >= 0, `chat fold@req#${i}: rearm round-2 lacks its summary carrier (no self-heal)`);
                    assert.ok(countSummaryEls(RB, R) <= countSummaryEls(PB, P) + 1, `chat fold@req#${i}: settling round-2 spawned a NEW zombie carrier (#2695)`);
                    assert.ok(coreLen(RB, R) < coreLen(PB, P), `chat fold@req#${i}: rearm round-2 must shrink the core`);
                    lines.push(`proof[chat] pair#${i - 1}->#${i} SETTLING-FOLD ok summaries=${countSummaryEls(PB, P)}->${countSummaryEls(RB, R)} (zombie ride bounded, #2695)`);
                    postFold = true;
                } else {
                    lines.push(`proof[chat] pair#${i}->#${i + 1} SETTLING (bounded zombie churn, #2695)`);
                }
                continue;
            }
            if (r2s.has(i)) {
                checkFoldPre("chat", bodies, field, i, lines);
                if (i + 1 < bodies.length && i + 1 !== decimIdx) checkFoldNext("chat", bodies, field, i, lines);
                if (i > decimIdx) postFold = true;
            } else if (r2s.has(i - 1)) {
                continue; // classified by checkFoldNext above
            } else {
                checkGrowth("chat", bodies, field, i, lines);
            }
        }
        assert.ok(postFold, "post-decimation fold must occur (self-heal)");

        // Direct teeth on the fix (#2695): the reap must have fired, archived
        // the orphaned block, and KEPT its content for derived decompress.
        const session = getSession("proof-decim");
        const reaps = conflictEventsOf(session).filter((e) => e.kind === "orphan-reap");
        assert.ok(reaps.length > 0, "orphan-reap conflict event recorded (#2695)");
        const reapedIds = reaps.flatMap((e) => e.detail.match(/\[([^\]]+)\]/)?.[1]?.split(", ") ?? []);
        assert.ok(reapedIds.length > 0, `orphan-reap detail names the reaped blocks (got: ${reaps[0]?.detail})`);
        for (const id of reapedIds) {
            assert.ok(session.blockContents.has(id), `reaped block ${id} content retained for decompress (#395 semantics)`);
            const coverage = session.metadata.foldCoverageByBlock as Record<string, unknown> | undefined;
            assert.ok(!coverage || coverage[id] === undefined, `reaped block ${id} stripped from foldCoverageByBlock`);
        }
        lines.push(`proof[chat] REAP ok blocks=${reapedIds.join(",")} content-retained coverage-stripped`);
        for (const l of lines) console.log(l);
        console.log(`proof[chat-decim] VERDICT bodies=${bodies.length} decimIdx=${decimIdx} folds=${trigger.calls()} unexplainedDivergences=0`);
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(tmp);
    }
});
