// Cache-friendliness matrix for PLUGIN mode, one subtest per wire
// (responses / openai chat / anthropic / google). Twin of
// tests/cache-friendly-proxy.test.ts (#1548), ordered by #1553: the two
// compression modes have different summary carriers, so a green proxy-mode
// matrix proves nothing about plugin mode.
//
// Plugin-mode carrier semantics: the ACP-native agent OWNS compression — it
// executes `compress` locally through the plugin tool API and re-sends the
// call + result in its own persisted history on every later request (pi
// semantics: pairs stay at their chronological position forever). That pair
// IS the wire summary carrier — the agent's view never renders the kernel
// acp_summary (KDD#7). Since the #1567 fix the kernel-rendered anchor is
// STRIPPED per-block, self-verified: only while that exact fold's compress
// pair rides the (post-prepare) inbound history quoting an ACTIVE block's
// range (#3769 carrier exemption). The moment a pair stops riding (client
// drop), its anchor re-carries the summary from that turn on (#1567
// fail-safe); a pair whose block died (swallowed by a wider fold) loses its
// carrier status and is swept at the swallowing fold's boundary, together
// with genuinely failed compress records sitting at/after the fold's start
// ref (fold-gated sweep, #3769). This suite pins that behavior
// byte-for-byte.
//
// Invariants pinned per wire (bodies = consecutive upstream-bound request
// payloads of one session, compared as flat unit lists — text blocks and
// structured tool units in serialization order, entry merging dissolved):
//   P1 plain-growth turns are APPEND-stable: the previous body's unit list is
//       an EXACT byte-prefix of the next (mid-history never mutates); the
//       volatile tail slots (chain checkpoint / nudge / imgNote / retrieval
//       note, ≤ 4) may only appear as a contiguous tail run;
//       #3159 (google lane only): Vertex rejects plain text after a
//       functionResponse part inside one user content, so coreToGoogle
//       forwards such a content with the plain-text parts LEADING — when a
//       user content ending on tool results gains new text parts between
//       turns, the previous body's trailing tool units shift right past the
//       inserted text run (assertPrefix's allowCanonShift sanctions exactly
//       that move); every other byte stays an exact prefix;
//   P2 fold transitions (client re-sends its compress pair after a
//       /__bili/plugin/tool fold):
//        P2a the pre-fold span is replaced by exactly the expected units and
//            nothing else moves or mutates (exact reconstruction; when the
//            span touches m00001 the session head survives as boundary,
//            mid-history spans are consumed whole);
//        P2b the pair RIDES inbound from its fold turn on and IS the summary
//            carrier — occurrence counts pinned: ZERO kernel anchors
//            (SUM_MARKER) while any pair rides, and exactly TWO summary-text
//            hits per riding pair (re-sent call args + tool-result receipt);
//        P2c fail-safe (#1567 hardening): the anchor carries the summary
//            whenever the pair does NOT ride inbound — the drop-pair subtest
//            pins that a client-side pair drop surfaces exactly its anchor
//            once, then stays append-stable (no flapping);
//   P3 multi-fold: two folds in one session; each pair rides alongside its
//       siblings as its own carrier, anchors stay stripped for the life of
//       the pairs, per-fold summary counts constant, quiet turns
//       append-stable (keep-two rotation is gone, #3769);
//   P4 no transient acp_loop_* artifact leaks into any forwarded body
//      (plugin mode has none by construction — pin it);
//   P5 marker/tag hygiene: every content text unit carries exactly one
//       well-formed head render tag; the marker→ref map is constant across
//       ALL turns (ids are never reused); refs unique per turn; OPEN/CLOSE
//       balanced; the system layer is byte-stable across all turns. At a
//       SANCTIONED native-compaction boundary the era splits: refs re-seeded
//       onto the compacted view belong to a new era and the old-era map does
//       not constrain them (eraBreak option) — within each era the map stays
//       constant;
//   P6 dsh native-compaction rebase (#2596/#2658, all four wires): after a
//       live fold, the host replaces its history with [checkpoint framing,
//       retained tail] (the dsh compaction landing — the #2596 cache-loss
//       lane). The dual-signal gate must rebase in the SAME turn: the
//       forwarded body carries exactly the compacted view (framing + tail
//       markers), the dead fold's summary/pair artifacts must NOT re-enter
//       the wire, and every later turn is APPEND-stable from the compacted
//       base — a missing lane implementation (the #2658 regression class:
//       rebase shipped on only 2 of 4 wires) fails here per wire.
//
// Scenario (main, all wires): t1=[q1,a1,q2,a2], t2=+q3,a3, t3=+q4,a4,
// foldA(m00001..m00002)+pairA@t4, t5=+q5,a5, foldB(m00003..m00005)+pairB@t6,
// t7=+q7,a7, t8=+q8,a8 — each pair rides as its fold's carrier from its
// fold turn on; anchors stay stripped while their pairs ride (#1567/#3769).
//
// Scope notes: tool protocol only (the default). The swallow/back-to-back
// fold geometries get a dedicated anthropic subtest (kernel-side behavior,
// shared with proxy mode, but exercised here through the plugin endpoint).
// Test-only workstream per #1553: no product changes.

import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { getSession } from "../src/session.ts";
import { DSH_CHECKPOINT_OPEN_TAG, DSH_CHECKPOINT_PREAMBLE_PREFIX } from "../src/server/dsh-compaction-guard.ts";
import { rmrf } from "./tmp-rm.ts";

const LT = "\x3c";
const GT = "\x3e";
const OPEN_TAG = LT + "acp ";
const CLOSE_TAG = LT + "/acp" + GT;
const CHAIN_PREFIX = LT + "bili-chain v=";
const NUDGE_PREFIX = "This is an efficiency nudge";
const IMGNOTE_PREFIX = "[Downscaled screenshots:";
const RETRNOTE_PREFIX = "[billion-context] Earlier acp_retrieve";
const SUM_MARKER = "[Compressed conversation section]";
const TAG_RE = new RegExp(`^${LT}acp tokens="[0-9]+(\\.[0-9])?K?" type="text"${GT}(m[0-9]+)${CLOSE_TAG}\n`);

const SUM_A = "Cache-friendly plugin fold summary covering m00001..m00002 alpha";
const SUM_B = "Cache-friendly plugin fold summary covering m00003..m00005 beta";
const SYS = "You are a test assistant.";

const headFiller = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(28);
const tailFiller = "enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate. ".repeat(28);

type Wire = "anthropic" | "openai" | "responses" | "google";
interface Turn { role: "user" | "assistant"; text: string }
interface Pair { args: FoldSpec; result: string; id: string }
type CItem = Turn | { pair: Pair };
interface FoldSpec { startId: string; endId: string; topic: string; summary: string }

type Unit =
    | { k: "text"; x: string }
    | { k: "tu"; id: string; name: string; input: unknown }
    | { k: "tr"; id: string; content: unknown };

function norm(v: unknown): unknown { return JSON.parse(JSON.stringify(v)); }
const eqUnit = (a: Unit, b: Unit): boolean => JSON.stringify(a) === JSON.stringify(b);

function slotKind(x: string): string | null {
    if (x.startsWith(CHAIN_PREFIX)) return "chain";
    if (x.startsWith(NUDGE_PREFIX)) return "nudge";
    if (x.startsWith(IMGNOTE_PREFIX)) return "imgnote";
    if (x.startsWith(RETRNOTE_PREFIX)) return "retrnote";
    return null;
}

function textsOf(entry: Record<string, unknown>): string[] {
    const c = entry.content;
    if (typeof c === "string") return [c];
    if (Array.isArray(c)) {
        const out: string[] = [];
        for (const b of c) {
            const blk = b as Record<string, unknown>;
            if ((blk.type === "text" || blk.type === "input_text" || blk.type === "output_text") && typeof blk.text === "string") out.push(blk.text);
        }
        return out;
    }
    if (Array.isArray(entry.parts)) {
        const out: string[] = [];
        for (const p of entry.parts) {
            const part = p as Record<string, unknown>;
            if (typeof part.text === "string") out.push(part.text);
        }
        return out;
    }
    return [];
}

function toolsOf(entry: Record<string, unknown>, wire: Wire): Unit[] {
    const out: Unit[] = [];
    const c = entry.content;
    if (wire === "anthropic" && Array.isArray(c)) {
        for (const b of c) {
            const blk = b as Record<string, unknown>;
            if (blk.type === "tool_use") out.push({ k: "tu", id: String(blk.id), name: String(blk.name), input: norm(blk.input) });
            if (blk.type === "tool_result") out.push({ k: "tr", id: String(blk.tool_use_id), content: norm(blk.content) });
        }
    }
    if (wire === "openai") {
        const tcs = entry.tool_calls;
        if (Array.isArray(tcs)) {
            for (const tc of tcs) {
                const f = (tc as Record<string, unknown>).function as Record<string, unknown>;
                out.push({ k: "tu", id: String((tc as Record<string, unknown>).id), name: String(f.name), input: norm(JSON.parse(String(f.arguments))) });
            }
        }
        if (entry.role === "tool") out.push({ k: "tr", id: String(entry.tool_call_id), content: norm(entry.content) });
    }
    if (wire === "responses") {
        if (entry.type === "function_call") out.push({ k: "tu", id: String(entry.call_id), name: String(entry.name), input: norm(JSON.parse(String(entry.arguments))) });
        if (entry.type === "function_call_output") out.push({ k: "tr", id: String(entry.call_id), content: norm(entry.output) });
    }
    if (wire === "google" && Array.isArray(entry.parts)) {
        for (const p of entry.parts) {
            const part = p as Record<string, unknown>;
            if (part.functionCall) {
                const fc = part.functionCall as Record<string, unknown>;
                out.push({ k: "tu", id: "", name: String(fc.name), input: norm(fc.args) });
            }
            if (part.functionResponse) {
                const fr = part.functionResponse as Record<string, unknown>;
                out.push({ k: "tr", id: "", content: norm((fr.response as Record<string, unknown>)?.result ?? fr.response) });
            }
        }
    }
    return out;
}

// anthropic/google merge consecutive same-role turns into ONE entry holding
// several blocks/parts; extracting must follow serialized block order or the
// unit sequence no longer mirrors the byte order of the forwarded body.
function orderedUnits(entry: Record<string, unknown>, wire: Wire): Unit[] {
    const out: Unit[] = [];
    if (wire === "anthropic") {
        const c = entry.content;
        if (typeof c === "string") { out.push({ k: "text", x: c }); return out; }
        if (!Array.isArray(c)) return out;
        for (const b of c) {
            const blk = b as Record<string, unknown>;
            if ((blk.type === "text" || blk.type === "input_text" || blk.type === "output_text") && typeof blk.text === "string") out.push({ k: "text", x: blk.text });
            else if (blk.type === "tool_use") out.push({ k: "tu", id: String(blk.id), name: String(blk.name), input: norm(blk.input) });
            else if (blk.type === "tool_result") out.push({ k: "tr", id: String(blk.tool_use_id), content: norm(blk.content) });
        }
        return out;
    }
    if (!Array.isArray(entry.parts)) return out;
    for (const p of entry.parts) {
        const part = p as Record<string, unknown>;
        if (typeof part.text === "string") out.push({ k: "text", x: part.text });
        else if (part.functionCall) {
            const fc = part.functionCall as Record<string, unknown>;
            out.push({ k: "tu", id: "", name: String(fc.name), input: norm(fc.args) });
        } else if (part.functionResponse) {
            const fr = part.functionResponse as Record<string, unknown>;
            out.push({ k: "tr", id: "", content: norm((fr.response as Record<string, unknown>)?.result ?? fr.response) });
        }
    }
    return out;
}

interface Canon { core: Unit[]; slots: string[]; sys: string; raw: string }

function canon(raw: string, wire: Wire): Canon {
    const b = JSON.parse(raw) as Record<string, unknown>;
    let sys = "";
    let entries: Record<string, unknown>[];
    if (wire === "anthropic") {
        sys = typeof b.system === "string" ? b.system : JSON.stringify(b.system ?? null);
        entries = (b.messages as Record<string, unknown>[]) ?? [];
    } else if (wire === "openai") {
        const msgs = (b.messages as Record<string, unknown>[]) ?? [];
        if (msgs.length > 0 && msgs[0]!.role === "system") {
            sys = JSON.stringify(msgs[0]!.content);
            entries = msgs.slice(1);
        } else entries = msgs;
    } else if (wire === "responses") {
        const inp = (b.input as Record<string, unknown>[]) ?? [];
        sys = inp.length > 0 ? JSON.stringify(inp[0]) : "";
        entries = inp.slice(1);
    } else {
        sys = JSON.stringify(b.systemInstruction ?? null);
        entries = (b.contents as Record<string, unknown>[]) ?? [];
    }
    const core: Unit[] = [];
    const slots: string[] = [];
    for (const e of entries) {
        if (wire === "anthropic" || wire === "google") {
            for (const u of orderedUnits(e, wire)) {
                if (u.k === "text") {
                    const sk = slotKind(u.x);
                    if (sk) slots.push(sk);
                    else core.push(u);
                } else core.push(u);
            }
            continue;
        }
        if (!(wire === "openai" && e.role === "tool")) {
            for (const t of textsOf(e)) {
                const sk = slotKind(t);
                if (sk) slots.push(sk);
                else core.push({ k: "text", x: t });
            }
        }
        for (const u of toolsOf(e, wire)) core.push(u);
    }
    return { core, slots, sys, raw };
}

function keyOf(u: Unit): string {
    if (u.k === "text") {
        if (u.x.includes(SUM_A)) return "SA";
        if (u.x.includes(SUM_B)) return "SB";
        const m = u.x.match(/\b([qa][0-9]+)-marker\b/);
        if (m) return m[1]!;
        return "TXT:" + u.x.slice(0, 24);
    }
    if (u.k === "tu") {
        if (u.id) return "TU:" + u.id;
        return "TU*:" + JSON.stringify({ n: u.name, i: u.input }).slice(0, 48);
    }
    if (u.id) return "TR:" + u.id;
    return "TR*:" + JSON.stringify(u.content).slice(0, 48);
}

function canonEq(a: Unit[], b: Unit[], label: string): void {
    assert.equal(b.length, a.length, `${label}: unit count ${b.length} != expected ${a.length}`);
    for (let i = 0; i < a.length; i++) {
        assert.ok(eqUnit(a[i]!, b[i]!), `${label}: unit[${i}] differs\n expected=${JSON.stringify(a[i])}\n actual  =${JSON.stringify(b[i])}`);
    }
}

// #3159 (google lane only): a user content ending on functionResponse parts
// is forwarded with new plain-text parts LEADING, so between turns the
// previous body's trailing tool units shift right past an inserted run of
// text units from that same content. allowCanonShift sanctions exactly that
// move — text-unit insertions immediately before a surviving byte-equal tool
// unit — and nothing else; any other mutation still fails.
function assertPrefix(prev: Unit[], next: Unit[], label: string, expectNew: string[], allowCanonShift = false): void {
    let pi = 0;
    let ni = 0;
    while (pi < prev.length) {
        if (ni < next.length && eqUnit(prev[pi]!, next[ni]!)) { pi++; ni++; continue; }
        const p = prev[pi]!;
        const n = ni < next.length ? next[ni]! : null;
        assert.ok(allowCanonShift && p.k !== "text" && n !== null && n.k === "text", `${label}: mid-history unit[${pi}] mutated\n previous=${JSON.stringify(p)}\n next    =${JSON.stringify(n)}`);
        let k = 0;
        while (ni + k < next.length && next[ni + k]!.k === "text") k++;
        assert.ok(k > 0 && ni + k < next.length && eqUnit(p, next[ni + k]!), `${label}: unit[${pi}] not realigned after ${k} inserted text unit(s)\n previous=${JSON.stringify(p)}\n next    =${JSON.stringify(next.slice(ni, ni + k + 1))}`);
        ni += k;
    }
    const added = next.slice(ni);
    assert.deepEqual(added.map(keyOf), expectNew, `${label}: appended units ${JSON.stringify(added.map(keyOf))} != expected ${JSON.stringify(expectNew)}`);
}

function assertFoldTransition(prev: Unit[], next: Unit[], cover: string[], insert: string[], label: string): void {
    const idxs = prev.map((u, i) => (cover.includes(keyOf(u)) ? i : -1)).filter((i) => i >= 0);
    assert.ok(idxs.length === cover.length, `${label}: covered units found ${idxs.length}/${cover.length}`);
    const i0 = idxs[0]!;
    const i1 = idxs[idxs.length - 1]!;
    for (let i = i0; i <= i1; i++) assert.ok(cover.includes(keyOf(prev[i]!)), `${label}: span [${i0}..${i1}] not contiguous-covered at [${i}] (${keyOf(prev[i]!)})`);
    const spanLen = i1 - i0 + 1;
    const prevKeys = new Set(prev.map(keyOf));
    let tailLen = 0;
    for (const u of next) if ((u.k === "tu" || u.k === "tr") && !prevKeys.has(keyOf(u))) tailLen++;
    const insLen = spanLen + (next.length - prev.length - tailLen);
    assert.ok(insLen >= 0, `${label}: computed insertion length ${insLen} < 0`); // 0 = span fully consumed (#1567 strips the anchor)
    const ins = next.slice(i0, i0 + insLen);
    assert.deepEqual(ins.map(keyOf), insert, `${label}: inserted units ${JSON.stringify(ins.map(keyOf))} != expected ${JSON.stringify(insert)}`);
    const rebuilt = [...prev.slice(0, i0), ...ins, ...prev.slice(i1 + 1), ...next.slice(next.length - tailLen)];
    canonEq(rebuilt, next, `${label}: reconstruction`);
}

function assertSlotsTail(c: Canon, label: string): void {
    assert.ok(c.slots.length <= 4, `${label}: ${c.slots.length} tail slots (> 4): ${c.slots.join(",")}`);
    const kinds = c.slots.join(",");
    assert.ok(kinds === "" || /(?:chain|nudge|imgnote|retrnote)(?:,(?:chain|nudge|imgnote|retrnote))*$/.test(kinds), `${label}: unexpected slot kinds ${kinds}`);
}

function assertTagPolicy(cans: Canon[], label: string, eraBreak?: number): void {
    // eraBreak: index of the turn whose request is the SANCTIONED
    // native-compaction boundary. Refs before/after belong to different
    // eras (the rebase re-seeds the ref space onto the compacted view), so
    // the marker→ref map is pinned constant WITHIN each era only —
    // cross-era re-issue is sanctioned, never a bug.
    const seen = new Map<string, string>();
    const seenNext = new Map<string, string>();
    for (let t = 0; t < cans.length; t++) {
        const c = cans[t]!;
        const occ = c.raw.split(OPEN_TAG).length - 1;
        const clos = c.raw.split(CLOSE_TAG).length - 1;
        assert.equal(clos, occ, `${label} t${t + 1}: CLOSE(${clos}) != OPEN(${occ}) imbalance`);
        const refs: string[] = [];
        for (const u of c.core) {
            if (u.k !== "text") continue;
            const isCarrier = u.x.includes(SUM_MARKER);
            const m = u.x.match(TAG_RE);
            if (isCarrier) {
                assert.ok(!m, `${label} t${t + 1}: summary carrier must be untagged`);
                continue;
            }
            assert.ok(m, `${label} t${t + 1}: content unit missing well-formed head tag: ${JSON.stringify(u.x.slice(0, 60))}`);
            const ref = m[2]!;
            refs.push(ref);
            const km = u.x.match(/\b([qa][0-9]+)-marker\b/);
            if (km) {
                const marker = km[1]!;
                const active = eraBreak === undefined || t < eraBreak ? seen : seenNext;
                const prevRef = active.get(marker);
                if (prevRef) assert.equal(ref, prevRef, `${label} t${t + 1}: ref reuse — ${marker} was ${prevRef}, now ${ref}`);
                else active.set(marker, ref);
            }
        }
        assert.equal(new Set(refs).size, refs.length, `${label} t${t + 1}: duplicate refs in one turn`);
    }
    for (let t = 1; t < cans.length; t++) {
        assert.equal(cans[t]!.sys, cans[0]!.sys, `${label}: system layer bytes changed at t${t + 1}`);
    }
}

const adapters: Record<Wire, { model: string; path: string; buildBody: (items: CItem[]) => unknown; sseText: (reply: string) => string[] }> = {
    anthropic: {
        model: "claude-test",
        path: "/v1/messages",
        buildBody: (items) => ({
            model: "claude-test", max_tokens: 1024, stream: true, system: SYS,
            messages: items.flatMap((it): Record<string, unknown>[] => "pair" in it
                ? [
                    { role: "assistant", content: [{ type: "tool_use", id: it.pair.id, name: "compress", input: it.pair.args }] },
                    { role: "user", content: [{ type: "tool_result", tool_use_id: it.pair.id, content: it.pair.result }] },
                ]
                : [{ role: it.role, content: [{ type: "text", text: it.text }] }]),
        }),
        sseText: (text) => [
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_p", role: "assistant", usage: { input_tokens: 55 } } })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ],
    },
    openai: {
        model: "gpt-test",
        path: "/v1/chat/completions",
        buildBody: (items) => ({
            model: "gpt-test", stream: true,
            messages: items.flatMap((it): Record<string, unknown>[] => "pair" in it
                ? [
                    { role: "assistant", content: null, tool_calls: [{ id: it.pair.id, type: "function", function: { name: "compress", arguments: JSON.stringify(it.pair.args) } }] },
                    { role: "tool", tool_call_id: it.pair.id, content: it.pair.result },
                ]
                : [{ role: it.role, content: it.text }]),
        }),
        sseText: (text) => [
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] })}\n\n`,
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
            "data: [DONE]\n\n",
        ],
    },
    responses: {
        model: "gpt-test",
        path: "/v1/responses",
        buildBody: (items) => ({
            model: "gpt-test", stream: true,
            input: items.flatMap((it): Record<string, unknown>[] => "pair" in it
                ? [
                    { type: "function_call", name: "compress", call_id: it.pair.id, arguments: JSON.stringify(it.pair.args) },
                    { type: "function_call_output", call_id: it.pair.id, output: it.pair.result },
                ]
                : [{ type: "message", role: it.role, content: [{ type: it.role === "user" ? "input_text" : "output_text", text: it.text }] }]),
        }),
        sseText: (text) => [
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress", output: [] } })}\n\n`,
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "msg_o_1", type: "message", status: "in_progress", role: "assistant", content: [] } })}\n\n`,
            `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", item_id: "msg_o_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_o_1", output_index: 0, delta: text })}\n\n`,
            `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_o_1", output_index: 0, content_index: 0, text })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "msg_o_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text }] } })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", object: "response", status: "completed", output: [{ id: "msg_o_1", type: "message", status: "completed", content: [{ type: "output_text", text }] }] } })}\n\n`,
        ],
    },
    google: {
        model: "gemini-test",
        path: "/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
        buildBody: (items) => ({
            contents: items.flatMap((it): Record<string, unknown>[] => "pair" in it
                ? [
                    { role: "model", parts: [{ functionCall: { name: "compress", args: it.pair.args } }] },
                    { role: "user", parts: [{ functionResponse: { name: "compress", response: { result: it.pair.result } } }] },
                ]
                : [{ role: it.role === "user" ? "user" : "model", parts: [{ text: it.text }] }]),
            systemInstruction: { parts: [{ text: SYS }] },
        }),
        sseText: (text) => [
            `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] } }], modelVersion: "gemini-test" })}\n\n`,
            `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }], modelVersion: "gemini-test" })}\n\n`,
        ],
    },
};

interface Step {
    send?: CItem[];
    fold?: FoldSpec;
    pairId?: string;
    dropPair?: string;
    // P6 native-compaction scenario: the host (dsh) replaces its ENTIRE
    // history with [checkpoint framing, retained tail] — the compacted view
    // after a native compaction landing. Processed before `send` appends.
    compact?: CItem[];
}

interface DriveOpts {
    // Override the x-bili-plugin identity ("dsh" drives the dsh lane gates).
    pluginAgent?: string;
    // Deterministic conversation id (default: generated per run).
    conv?: string;
}

async function driveWire(wire: Wire, steps: Step[], opts?: DriveOpts): Promise<Canon[]> {
    const adapter = adapters[wire];
    const conv = opts?.conv ?? `cfp-${wire}-${Date.now().toString(36)}`;
    const captured: string[] = [];

    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString();
            captured.push(body);
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const line of adapter.sseText(`answer-${captured.length}`)) res.write(line);
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfp-plugin-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [adapter.model]: { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true, nudgeGrowthTokens: 500 },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}${adapter.path}`;

    const hist: CItem[] = [];
    try {
        for (const step of steps) {
            if (step.compact) {
                hist.length = 0;
                hist.push(...step.compact);
            }
            for (const it of step.send ?? []) hist.push(it);
            if (step.fold) {
                const r = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [step.fold] } }),
                });
                const j = (await r.json()) as { ok: boolean; result?: string; error?: string };
                assert.ok(j.ok, `[${wire}] compress rejected: ${r.status} ${j.error ?? ""}`);
                assert.ok(!j.result?.includes("[Compression FAILED"), `[${wire}] compression failed: ${j.result?.slice(0, 200)}`);
                hist.push({ pair: { args: step.fold, result: j.result!, id: step.pairId ?? `${wire}_cmp` } });
            }
            // #1567 hardening scenario: a contract-violating (or pruning)
            // client stops re-sending an older compress pair
            if (step.dropPair) {
                const idx = hist.findIndex((it) => "pair" in it && it.pair.id === step.dropPair);
                if (idx < 0) assert.fail(`[${wire}] dropPair ${step.dropPair}: pair not in history`);
                hist.splice(idx, 1);
            }
            const resp = await fetch(base, {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-plugin": opts?.pluginAgent ?? "pi-plugin/0.0.1", "x-bili-plugin-conversation": conv },
                body: JSON.stringify(adapter.buildBody(hist)),
            });
            if (resp.status !== 200) {
                const detail = (await resp.text()).slice(0, 300);
                assert.fail(`[${wire}] request failed: ${resp.status} ${detail}`);
            }
            await resp.arrayBuffer();
        }
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(stateDir);
    }
    return captured.map((raw) => canon(raw, wire));
}

const T = (i: number): Turn => ({ role: "user", text: `q${i}-marker ${i <= 2 ? headFiller : tailFiller}` });
const A = (i: number): Turn => ({ role: "assistant", text: `a${i}-marker answer ${i <= 2 ? headFiller : tailFiller}` });

const FOLD_A: FoldSpec = { startId: "m00001", endId: "m00002", topic: "CFP-TOPIC-A", summary: SUM_A };
const FOLD_B: FoldSpec = { startId: "m00003", endId: "m00005", topic: "CFP-TOPIC-B", summary: SUM_B };

const MAIN_STEPS: Step[] = [
    { send: [T(1), A(1), T(2), A(2)] },
    { send: [T(3), A(3)] },
    { send: [T(4), A(4)] },
    { send: [], fold: FOLD_A, pairId: "cfp_a" },
    { send: [T(5), A(5)] },
    { send: [], fold: FOLD_B, pairId: "cfp_b" },
    { send: [T(7), A(7)] },
    { send: [T(8), A(8)] },
];

function countOcc(raw: string, needle: string): number { return raw.split(needle).length - 1; }

// node:test (v22) silently ignores an options object passed AFTER the fn argument, but its
// overloads reject that call shape — bind a precise alias so the existing calls typecheck unchanged.
const testCompat = test as (name: string, fn: () => void | Promise<void>, opts?: { timeout?: number }) => Promise<void>;

for (const wire of ["anthropic", "openai", "responses", "google"] as Wire[]) {
    testCompat(`cache-friendly plugin matrix: ${wire}`, async () => {
        const cans = await driveWire(wire, MAIN_STEPS);
        assert.equal(cans.length, 8, "expected 8 outbound bodies");
        const L = (i: number) => `cfp/${wire} t${i + 1}`;

        for (let i = 0; i < cans.length; i++) {
            assertSlotsTail(cans[i]!, L(i));
            assert.equal(countOcc(cans[i]!.raw, "acp_loop_"), 0, `${L(i)}: acp_loop_ artifact leaked into forwarded body`);
        }
        assertTagPolicy(cans, `cfp/${wire}`);

        assertPrefix(cans[0]!.core, cans[1]!.core, L(1), ["q3", "a3"]);
        assertPrefix(cans[1]!.core, cans[2]!.core, L(2), ["q4", "a4"]);
        assertFoldTransition(cans[2]!.core, cans[3]!.core, ["q1", "a1"], ["q1"], L(3)); // session-head boundary survives; span consumed, no anchor — pair A rides as carrier (#1567/#3769)
        // #3159 (google lane only): the riding pair's functionCall/
        // functionResponse split swallows the turn's leading text part into
        // the sanctioned shift, so only the model reply lands in `added`
        assertPrefix(cans[3]!.core, cans[4]!.core, L(4), wire === "google" ? ["a5"] : ["q5", "a5"], wire === "google");
        assertFoldTransition(cans[4]!.core, cans[5]!.core, ["q2", "a2", "q3"], [], L(5)); // mid-history span consumed whole; no anchor — pair B rides (#1567/#3769)
        assertPrefix(cans[5]!.core, cans[6]!.core, L(6), wire === "google" ? ["a7"] : ["q7", "a7"], wire === "google");
        assertPrefix(cans[6]!.core, cans[7]!.core, L(7), ["q8", "a8"]);

        for (let i = 3; i < cans.length; i++) {
            const raw = cans[i]!.raw;
            // Carrier regime (#1567/#3769/KDD#7): each fold's echoed pair
            // rides from its fold turn on and IS the summary carrier — the
            // kernel anchor stays stripped for the pair's life, and the
            // summary text appears exactly twice per riding pair (call args
            // + result receipt).
            assert.equal(countOcc(raw, SUM_MARKER), 0, `${L(i)}: anchors stripped while their pairs ride (#1567)`);
            assert.equal(countOcc(raw, SUM_A), 2, `${L(i)}: SUM_A rides pair A args+receipt (got ${countOcc(raw, SUM_A)})`);
            assert.equal(countOcc(raw, SUM_B), i < 5 ? 0 : 2, `${L(i)}: SUM_B rides pair B from its fold turn on (got ${countOcc(raw, SUM_B)})`);
            // pin pair PRESENCE — the carriers; google part-shapes carry no
            // call id, so pin through the fold-spec refs in the re-sent
            // functionCall args
            const pairA = wire === "google" ? "\"startId\":\"m00001\"" : "\"cfp_a\"";
            const pairB = wire === "google" ? "\"startId\":\"m00003\"" : "\"cfp_b\"";
            assert.ok(raw.includes(pairA), `${L(i)}: pair A rides as its fold's carrier (#1567)`);
            assert.equal(raw.includes(pairB), i >= 5, `${L(i)}: pair B rides from t6 on`);
        }

    }, { timeout: 120_000 });
}

testCompat("cache-friendly plugin matrix: anthropic swallow/back-to-back geometries", async () => {
    const FOLD_WIDE: FoldSpec = { startId: "m00001", endId: "m00004", topic: "CFP-TOPIC-WIDE", summary: "Cache-friendly plugin fold summary covering m00001..m00004 wide" };
    const FOLD_E: FoldSpec = { startId: "m00005", endId: "m00007", topic: "CFP-TOPIC-E", summary: "Cache-friendly plugin fold summary covering m00005..m00007 gamma" };
    const steps: Step[] = [
        { send: [T(1), A(1), T(2), A(2)] },
        { send: [T(3), A(3)] },
        { send: [T(4), A(4)] },
        { send: [], fold: FOLD_A, pairId: "geo_a" },
        { send: [T(5), A(5)] },
        { send: [], fold: FOLD_WIDE, pairId: "geo_wide" },
        { send: [], fold: FOLD_E, pairId: "geo_e" },
        { send: [T(8), A(8)] },
    ];
    const cans = await driveWire("anthropic", steps);
    assert.equal(cans.length, 8, "expected 8 outbound bodies");
    const L = (i: number) => `cfp-geo t${i + 1}`;

    for (let i = 0; i < cans.length; i++) {
        assertSlotsTail(cans[i]!, L(i));
        assert.equal(countOcc(cans[i]!.raw, "acp_loop_"), 0, `${L(i)}: acp_loop_ artifact leaked`);
    }
    assertTagPolicy(cans, "cfp-geo");

    assertPrefix(cans[0]!.core, cans[1]!.core, L(1), ["q3", "a3"]);
    assertPrefix(cans[1]!.core, cans[2]!.core, L(2), ["q4", "a4"]);
    assertFoldTransition(cans[2]!.core, cans[3]!.core, ["q1", "a1"], ["q1"], L(3)); // session-head boundary survives; no anchor — geo_a rides as carrier (#1567/#3769)
    assertPrefix(cans[3]!.core, cans[4]!.core, L(4), ["q5", "a5"]);

    const wide = FOLD_WIDE.summary;
    const gamma = FOLD_E.summary;
    // The wide fold (m00001..m00004) swallows the alpha fold's range: the
    // alpha summary merges into the wide fold, and the geo_a pair — whose
    // block died — loses carrier status and is swept at the swallow
    // boundary (#3769). geo_wide rides as the merged region's carrier.
    // FOLD_E's tail sits in the protected zone, so only its first message
    // folds; geo_e rides alongside.
    for (const i of [5, 6, 7]) {
        const raw = cans[i]!.raw;
        assert.ok(!raw.includes("q2-marker"), `${L(i)}: swallowed content q2 must stay hidden`);
        assert.ok(!raw.includes("a2-marker"), `${L(i)}: swallowed content a2 must stay hidden`);
        assert.ok(!raw.includes("\"geo_a\""), `${L(i)}: dead-block pair swept at the swallow boundary (#3769)`);
    }
    assert.equal(countOcc(cans[5]!.raw, SUM_A), 0, `${L(5)}: alpha summary absorbed into the wide fold`);
    assert.equal(countOcc(cans[5]!.raw, wide), 2, `${L(5)}: wide summary rides geo_wide args+receipt`);
    assert.equal(countOcc(cans[5]!.raw, gamma), 0, `${L(5)}: E not folded yet`);
    assert.equal(countOcc(cans[5]!.raw, SUM_MARKER), 0, `${L(5)}: anchors stripped while their pairs ride`);
    assert.equal(countOcc(cans[6]!.raw, wide), 2, `${L(6)}: wide carrier persists`);
    assert.equal(countOcc(cans[6]!.raw, gamma), 2, `${L(6)}: gamma rides geo_e from its fold turn on`);
    assert.equal(countOcc(cans[6]!.raw, SUM_MARKER), 0, `${L(6)}: anchors stripped while their pairs ride`);
    assert.equal(countOcc(cans[7]!.raw, wide), 2, `${L(7)}: wide carrier persists`);
    assert.equal(countOcc(cans[7]!.raw, gamma), 2, `${L(7)}: gamma carrier persists`);
    assert.equal(countOcc(cans[7]!.raw, SUM_MARKER), 0, `${L(7)}: carriers stable across quiet turns`);
    // t5→t6 rewrite: the wide span (minus the session-head boundary) is
    // consumed and the dead-block pair swept — everything else keeps order
    const goneT6 = new Set(["a1", "q2", "a2", "TU:geo_a", "TR:geo_a"]);
    const keptT5 = cans[4]!.core.filter((u) => !goneT6.has(keyOf(u)));
    let cursor = -1;
    for (const u of keptT5) {
        const found = cans[5]!.core.findIndex((v, j) => j > cursor && eqUnit(u, v));
        assert.ok(found > cursor, `cfp-geo t6: unit ${JSON.stringify(keyOf(u))} lost or reordered by the wide fold`);
        cursor = found;
    }
    assertFoldTransition(cans[5]!.core, cans[6]!.core, ["q3"], [], L(6)); // protected-zone carve: only E's first message folds; no anchor — geo_e rides
    // #1567: while the pairs ride, their summaries live in TOOL units only —
    // never a text-unit anchor
    for (const idx of [5, 6, 7]) {
        const textCarriers = cans[idx]!.core.filter((u) => u.k === "text" && (u.x.includes(wide) || u.x.includes(gamma)));
        assert.equal(textCarriers.length, 0, `${L(idx)}: no text-unit anchor while the riding pairs carry the summaries (#1567)`);
    }
    assertPrefix(cans[6]!.core, cans[7]!.core, L(7), ["q8", "a8"]);
}, { timeout: 120_000 });

// #1567 hardening scenario A, re-pinned under #3769: a contract-violating
// (or pruning) client stops re-sending an older compress pair at t7. While
// the pairs ride they ARE the carriers (anchors stripped); the moment pairA
// stops riding, its anchor re-carries the summary exactly once at the
// covered span — then the body stays append-stable (no flapping). PairB
// still rides, so anchor B never surfaces.
testCompat(`cache-friendly plugin matrix: anthropic — client drops re-sent pair → anchor re-carries once, no flapping (#1567/#3769)`, async () => {
    const steps: Step[] = [
        { send: [T(1), A(1), T(2), A(2)] },
        { send: [T(3), A(3)] },
        { send: [T(4), A(4)] },
        { send: [], fold: FOLD_A, pairId: "cfp_a" },
        { send: [T(5), A(5)] },
        { send: [], fold: FOLD_B, pairId: "cfp_b" },
        { send: [T(7), A(7)], dropPair: "cfp_a" },
        { send: [T(8), A(8)] },
    ];
    const cans = await driveWire("anthropic", steps);
    assert.equal(cans.length, 8, "expected 8 outbound bodies");
    const L = (i: number) => `cfp-drop t${i + 1}`;
    for (let i = 0; i < cans.length; i++) {
        assertSlotsTail(cans[i]!, L(i));
        assert.equal(countOcc(cans[i]!.raw, "acp_loop_"), 0, `${L(i)}: acp_loop_ artifact leaked`);
    }
    assertTagPolicy(cans, "cfp-drop");
    // t4..t6: both pairs ride as carriers — anchors stripped
    for (const i of [3, 4, 5]) {
        const raw = cans[i]!.raw;
        assert.ok(raw.includes('"cfp_a"'), `${L(i)}: pair A rides as its fold's carrier (#1567)`);
        assert.ok(i >= 5 || !raw.includes('"cfp_b"') , `${L(i)}: pair B rides from t6 on`);
        assert.equal(countOcc(raw, SUM_MARKER), 0, `${L(i)}: anchors stripped while their pairs ride`);
        assert.equal(countOcc(raw, SUM_A), 2, `${L(i)}: SUM_A rides pair A args+receipt`);
        assert.equal(countOcc(raw, SUM_B), i < 5 ? 0 : 2, `${L(i)}: SUM_B rides pair B from its fold turn on`);
    }
    // t7: pairA dropped → its anchor re-carries exactly once at the covered
    // span; pairB still rides so anchor B stays stripped (#1567 fail-safe)
    {
        const raw = cans[6]!.raw;
        assert.ok(!raw.includes('"cfp_a"'), `${L(6)}: dropped pair stays dropped`);
        assert.ok(raw.includes('"cfp_b"'), `${L(6)}: pair B unaffected by A's drop`);
        assert.equal(countOcc(raw, SUM_A), 1, `${L(6)}: anchor A re-carries the sole copy`);
        assert.equal(countOcc(raw, SUM_B), 2, `${L(6)}: pair B still rides`);
        assert.equal(countOcc(raw, SUM_MARKER), 1, `${L(6)}: exactly one anchor rendered (A's)`);
        assert.ok(raw.includes("q7-marker"), `${L(6)}: new turn visible`);
    }
    // t8: once re-carried, the body stays append-stable (no flapping)
    {
        const raw = cans[7]!.raw;
        assert.equal(countOcc(raw, SUM_A), 1, `${L(7)}: anchor A stable`);
        assert.equal(countOcc(raw, SUM_MARKER), 1, `${L(7)}: no flapping after the drop`);
    }
    assertPrefix(cans[6]!.core, cans[7]!.core, L(7), ["q8", "a8"]);
}, { timeout: 120_000 });

// #3769 contract pin (plugin lane): three back-to-back folds, each with a
// client-visible compress pair. The old KEEP_LAST_ORPHANED=2 rotation hid
// the oldest pair on EVERY turn — a mid-history rewrite with no fold behind
// it, exactly #3769's cache seam. Under the carrier regime every pair rides
// as its fold's summary carrier for good: no per-turn hiding, no churn,
// anchors stay stripped while the pairs ride, and quiet turns stay
// append-stable.
testCompat(`cache-friendly plugin matrix: anthropic — 3 concurrent folds: every pair rides as its carrier, quiet turns append-stable (#3769)`, async () => {
    const SUM_P1 = "Prune-safe fold one summary covering m00001..m00002";
    const SUM_P2 = "Prune-safe fold two summary covering m00003..m00004";
    const SUM_P3 = "Prune-safe fold three summary covering m00005..m00006";
    const F1: FoldSpec = { startId: "m00001", endId: "m00002", topic: "CFP-TOPIC-P1", summary: SUM_P1 };
    const F2: FoldSpec = { startId: "m00003", endId: "m00004", topic: "CFP-TOPIC-P2", summary: SUM_P2 };
    const F3: FoldSpec = { startId: "m00005", endId: "m00006", topic: "CFP-TOPIC-P3", summary: SUM_P3 };
    const steps: Step[] = [
        { send: [T(1), A(1), T(2), A(2), T(3), A(3), T(4), A(4)] },
        { send: [T(5), A(5), T(6), A(6)] }, // keep fold ranges outside the protected zone (last 5 messages)
        { send: [], fold: F1, pairId: "fs1" },
        { send: [], fold: F2, pairId: "fs2" },
        { send: [], fold: F3, pairId: "fs3" },
        { send: [T(7), A(7)] },
        { send: [T(8), A(8)] },
    ];
    const cans = await driveWire("anthropic", steps);
    assert.equal(cans.length, 7, "expected 7 outbound bodies");
    const L = (i: number) => `cfp-prune t${i + 1}`;
    for (let i = 0; i < cans.length; i++) {
        assertSlotsTail(cans[i]!, L(i));
        assert.equal(countOcc(cans[i]!.raw, "acp_loop_"), 0, `${L(i)}: acp_loop_ artifact leaked`);
    }
    assertTagPolicy(cans, "cfp-prune");
    // t3..t5: each fold's pair rides from its fold turn on (args+receipt =
    // 2 occurrences); anchors stay stripped for the life of the pairs
    for (const i of [2, 3, 4]) {
        const raw = cans[i]!.raw;
        assert.ok(raw.includes('"fs1"'), `${L(i)}: pair 1 rides as its fold's carrier (#1567)`);
        assert.ok(i >= 3 || !raw.includes('"fs2"'), `${L(i)}: pair 2 rides from t4 on`);
        assert.ok(i >= 4 || !raw.includes('"fs3"'), `${L(i)}: pair 3 rides from t5 on`);
        assert.equal(countOcc(raw, SUM_P1), 2, `${L(i)}: P1 rides pair-1 args+receipt`);
        assert.equal(countOcc(raw, SUM_P2), i < 3 ? 0 : 2, `${L(i)}: P2 rides from its fold turn on`);
        assert.equal(countOcc(raw, SUM_P3), i < 4 ? 0 : 2, `${L(i)}: P3 rides from its fold turn on`);
        assert.equal(countOcc(raw, SUM_MARKER), 0, `${L(i)}: anchors stripped while the pairs ride`);
    }
    // t6/t7: all three pairs persist, stable across quiet turns
    for (const i of [5, 6]) {
        const raw = cans[i]!.raw;
        assert.equal(countOcc(raw, SUM_P1), 2, `${L(i)}: P1 carrier persists`);
        assert.equal(countOcc(raw, SUM_P2), 2, `${L(i)}: P2 carrier persists`);
        assert.equal(countOcc(raw, SUM_P3), 2, `${L(i)}: P3 carrier persists`);
        assert.equal(countOcc(raw, SUM_MARKER), 0, `${L(i)}: three riding pairs, zero anchors, stable`);
    }
    // mid-history never mutates between quiet turns
    assertPrefix(cans[5]!.core, cans[6]!.core, L(6), ["q8", "a8"]);
}, { timeout: 120_000 });

// P6 (#2596/#2658): the dsh native-compaction rebase lane, per wire. After a
// live fold the dsh host replaces its ENTIRE history with [checkpoint
// framing, retained tail] — exactly the landing that, when a lane misses the
// rebase (#2658 shipped it on openai/responses only), left the ACP state
// permanently unrebased and the prefix cache dead (#2596 main complaint).
// Byte-level contract, all four wires:
//   - the dual-signal gate rebases in the SAME turn (state: boundary
//     recorded, no active block survives);
//   - the rebase-turn body carries exactly the compacted view (framing + the
//     retained tail markers) and NONE of the dead fold's artifacts (no
//     summary carrier, no pair quotes, no compress pair id/topic);
//   - every later turn is APPEND-stable from the compacted base (the cache
//     recovers instead of flapping) — the marker→ref map splits into eras at
//     the sanctioned boundary and stays constant within each era.
for (const wire of ["anthropic", "openai", "responses", "google"] as Wire[]) {
    testCompat(`cache-friendly plugin matrix: ${wire} — dsh native-compaction rebase keeps the wire clean and append-stable (#2596/#2658)`, async () => {
        const NATIVE_SUM = "Native-compaction fold summary covering m00001..m00009 nuance";
        const NATIVE_FOLD: FoldSpec = { startId: "m00001", endId: "m00009", topic: "CFP-TOPIC-NATIVE", summary: NATIVE_SUM };
        const checkpoint: CItem = {
            role: "user",
            text: `${DSH_CHECKPOINT_PREAMBLE_PREFIX} of the conversation so far, as context for continuing. The work established the harness, drove one fold, and then dsh compacted natively. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n${DSH_CHECKPOINT_OPEN_TAG}\n## Primary Request and Intent\n- drive a fold, then replay the compacted view`,
        };
        const steps: Step[] = [
            { send: [T(1), A(1), T(2), A(2), T(3), A(3)] },
            { send: [T(4), A(4), T(5), A(5), T(6), A(6)] },
            { send: [T(7), A(7)] },
            { send: [], fold: NATIVE_FOLD, pairId: "nc_pair" },
            { compact: [checkpoint, T(7), A(7)] },
            { send: [T(8), A(8)] },
            { send: [T(9), A(9)] },
        ];
        const conv = `cfp-native-${wire}`;
        const cans = await driveWire(wire, steps, { pluginAgent: "dsh", conv });
        assert.equal(cans.length, 7, "expected 7 outbound bodies");
        const L = (i: number) => `cfp-native/${wire} t${i + 1}`;

        // The rebase landed in the SAME turn: boundary recorded, no active
        // fold survives, refs re-seeded onto the compacted view.
        const s = getSession(conv)!;
        assert.ok(s, "session exists under the conversation key");
        const boundary = s.metadata["nativeCompactionBoundary"] as { pendingRebase?: boolean } | undefined;
        assert.ok(boundary, "native-compaction boundary recorded");
        assert.equal(boundary?.pendingRebase, false, "rebase consumed within the rebase turn");
        assert.equal((s.state.blocks ?? []).filter((b) => b.active).length, 0, "no active fold survives the rebase");

        for (let i = 0; i < cans.length; i++) {
            assertSlotsTail(cans[i]!, L(i));
            assert.equal(countOcc(cans[i]!.raw, "acp_loop_"), 0, `${L(i)}: acp_loop_ artifact leaked`);
        }
        // eraBreak = 4: the compacted replay (t5) opens era B; refs re-issued
        // across the boundary are sanctioned, within each era the map is law.
        assertTagPolicy(cans, `cfp-native/${wire}`, 4);

        // t4 (fold turn): pair rides inbound, anchor stripped (#1567)
        assert.equal(countOcc(cans[3]!.raw, SUM_MARKER), 0, `${L(3)}: carrier stripped while the pair rides`);
        assert.equal(countOcc(cans[3]!.raw, NATIVE_SUM), 2, `${L(3)}: pair quotes only`);

        // t5 (rebase turn): exactly the compacted view on the wire
        const rebase = cans[4]!.raw;
        assert.ok(rebase.includes(DSH_CHECKPOINT_OPEN_TAG), `${L(4)}: checkpoint framing forwarded upstream`);
        assert.ok(rebase.includes("q7-marker") && rebase.includes("a7-marker"), `${L(4)}: retained tail forwarded upstream`);
        assert.equal(countOcc(rebase, SUM_MARKER), 0, `${L(4)}: no summary carrier may linger after the rebase`);
        assert.equal(countOcc(rebase, NATIVE_SUM), 0, `${L(4)}: the dead fold's summary must not re-enter the wire`);
        const pairIdOnWire = wire === "google" ? "CFP-TOPIC-NATIVE" : '"nc_pair"';
        assert.ok(!rebase.includes(pairIdOnWire), `${L(4)}: the dead fold's compress pair must be gone with the compacted history`);

        // t6/t7: growth resumes APPEND-stable from the compacted base
        assertPrefix(cans[4]!.core, cans[5]!.core, L(5), ["q8", "a8"]);
        assertPrefix(cans[5]!.core, cans[6]!.core, L(6), ["q9", "a9"]);
    }, { timeout: 120_000 });
}
