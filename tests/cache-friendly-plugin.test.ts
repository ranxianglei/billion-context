// Cache-friendliness matrix for PLUGIN mode, one subtest per wire
// (responses / openai chat / anthropic / google). Twin of
// tests/cache-friendly-proxy.test.ts (#1548), ordered by #1553: the two
// compression modes have different summary carriers, so a green proxy-mode
// matrix proves nothing about plugin mode.
//
// Plugin-mode carrier semantics: the ACP-native agent OWNS compression — it
// executes `compress` locally through the plugin tool API and re-sends the
// call + result in its own persisted history on every later request (pi
// semantics: pairs stay at their chronological position forever). The proxy
// therefore re-injects the in-place acp_summary carrier from block state on
// every request. Since the #1567 fix the carrier is STRIPPED per-block, but
// self-verified: only while that exact fold's compress pair actually rides
// the (post-prepare) inbound history. A pair pruned client-side or hidden by
// the kernel (KEEP_LAST_ORPHANED) keeps the anchor, so an active fold never
// has zero carriers. This suite pins that behavior byte-for-byte.
//
// Invariants pinned per wire (bodies = consecutive upstream-bound request
// payloads of one session, compared as flat unit lists — text blocks and
// structured tool units in serialization order, entry merging dissolved):
//   P1 plain-growth turns are APPEND-stable: the previous body's unit list is
//       an EXACT byte-prefix of the next (mid-history never mutates); the
//       volatile tail slots (chain checkpoint / nudge / imgNote / retrieval
//       note, ≤ 4) may only appear as a contiguous tail run;
//   P2 fold transitions (client re-sends its compress pair after a
//       /__bili/plugin/tool fold):
//        P2a the pre-fold span is replaced by exactly the expected carrier
//            units and nothing else moves or mutates (exact reconstruction);
//        P2b the in-place carrier is stripped from every post-fold turn
//            while the client's pair rides inbound — occurrence counts
//            pinned: exactly 2 summary-text hits per post-fold turn (the
//            fold spec echoed in the re-sent tool_call args + the tail
//            quote inside the persistently re-sent tool result) and ZERO
//            carrier markers (#1567 fix);
//        P2c fail-safe (#1567 hardening): the anchor re-carries the summary
//            whenever the pair does NOT ride inbound — the client stops
//            re-sending it, or the kernel hid it (KEEP_LAST_ORPHANED) —
//            pinned by the two hardening subtests at the bottom of this file;
//   P3 multi-fold: two folds in one session; both pairs stay visible
//       (≤ KEEP_LAST_ORPHANED) and the pair-quote counts stay constant across
//       all later turns;
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
// t7=+q7,a7, t8=+q8,a8 — every historical pair rides every later request.
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

function assertPrefix(prev: Unit[], next: Unit[], label: string, expectNew: string[]): void {
    for (let i = 0; i < prev.length; i++) {
        assert.ok(eqUnit(prev[i]!, next[i]!), `${label}: mid-history unit[${i}] mutated\n previous=${JSON.stringify(prev[i])}\n next    =${JSON.stringify(next[i])}`);
    }
    const added = next.slice(prev.length);
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
        await once(proxy, "close");
        upstream.close();
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
        assertFoldTransition(cans[2]!.core, cans[3]!.core, ["q1", "a1"], ["q1"], L(3)); // head boundary survives; anchor stripped (#1567)
        assertPrefix(cans[3]!.core, cans[4]!.core, L(4), ["q5", "a5"]);
        assertFoldTransition(cans[4]!.core, cans[5]!.core, ["q2", "a2", "q3"], [], L(5)); // anchor stripped (#1567)
        assertPrefix(cans[5]!.core, cans[6]!.core, L(6), ["q7", "a7"]);
        assertPrefix(cans[6]!.core, cans[7]!.core, L(7), ["q8", "a8"]);

        for (let i = 3; i < cans.length; i++) {
            const raw = cans[i]!.raw;
            // #1567 (fixed): the in-place carrier is stripped per-block while
            // the client's re-sent pair rides inbound — only the two pair
            // quotes (tool_call args + tool result) keep the summary text.
            const expA = 2;
            const expB = i < 5 ? 0 : 2;
            assert.equal(countOcc(raw, SUM_MARKER), 0, `${L(i)}: in-place carrier must be stripped while the client's pair rides inbound (got ${countOcc(raw, SUM_MARKER)})`);
            assert.equal(countOcc(raw, SUM_A), expA, `${L(i)}: SUM_A occurrences ${countOcc(raw, SUM_A)} != ${expA} (pair quotes only, #1567)`);
            assert.equal(countOcc(raw, SUM_B), expB, `${L(i)}: SUM_B occurrences ${countOcc(raw, SUM_B)} != ${expB} (pair quotes only, #1567)`);
            // google part-shapes carry no call id; pin pair presence through
            // the fold topic embedded in the re-sent functionCall args
            const pairA = wire === "google" ? "CFP-TOPIC-A" : "\"cfp_a\"";
            const pairB = wire === "google" ? "CFP-TOPIC-B" : "\"cfp_b\"";
            assert.ok(raw.includes(pairA), `${L(i)}: pairA lost from re-sent history`);
            if (i >= 5) assert.ok(raw.includes(pairB), `${L(i)}: pairB lost from re-sent history`);
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
    assertFoldTransition(cans[2]!.core, cans[3]!.core, ["q1", "a1"], ["q1"], L(3)); // head boundary survives; anchor stripped (#1567)
    assertPrefix(cans[3]!.core, cans[4]!.core, L(4), ["q5", "a5"]);

    const wide = FOLD_WIDE.summary;
    const gamma = FOLD_E.summary;
    for (const i of [5, 6, 7]) {
        const raw = cans[i]!.raw;
        // carrier is superseded on every turn; the two head/tail quotes ride
        // the re-sent geo_a tool result until that pair is pruned at t7
        const expA = i === 5 ? 2 : 0;
        assert.equal(countOcc(raw, SUM_A), expA, `${L(i)}: SUM_A occurrences ${countOcc(raw, SUM_A)} != ${expA}`);
        assert.equal(countOcc(raw, SUM_MARKER), 0, `${L(i)}: carriers must be stripped while their pairs ride inbound (got ${countOcc(raw, SUM_MARKER)})`);
        assert.ok(!raw.includes("q2-marker"), `${L(i)}: swallowed content q2 must stay hidden`);
        assert.ok(!raw.includes("a2-marker"), `${L(i)}: swallowed content a2 must stay hidden`);
    }
    const surviveKeys = new Set(["q1", "a1", "q2", "a2", "SA"]);
    const keepT5 = cans[4]!.core.filter((u) => !surviveKeys.has(keyOf(u)));
    let cursor = -1;
    for (const u of keepT5) {
        const found = cans[5]!.core.findIndex((v, j) => j > cursor && eqUnit(u, v));
        assert.ok(found > cursor, `cfp-geo t6: unit ${JSON.stringify(keyOf(u))} lost or reordered by the wide fold`);
        cursor = found;
    }
    assert.equal(countOcc(cans[5]!.raw, wide), 2, `${L(5)}: wide fold turn occurrences (pair quotes; anchor stripped)`);
    assert.equal(countOcc(cans[6]!.raw, gamma), 2, `${L(6)}: gamma fold turn occurrences (pair quotes; anchor stripped)`);
    assert.equal(countOcc(cans[7]!.raw, wide), 2, `${L(7)}: resent wide quotes must survive`);
    assert.equal(countOcc(cans[7]!.raw, gamma), 2, `${L(7)}: resent gamma quotes must survive`);
    for (const i of [6, 7]) {
        const raw = cans[i]!.raw;
        assert.ok(raw.includes("\"geo_wide\"") && raw.includes("\"geo_e\""), `${L(i)}: latest two pairs must stay visible`);
        assert.ok(!raw.includes("\"geo_a\""), `${L(i)}: oldest pair must be pruned (KEEP_LAST_ORPHANED=2)`);
    }
    // #1567 (fixed): no text unit carries the wide summary anymore (stripped
    // anchor); the quotes ride structured tool units, not text
    const wideT6 = cans[6]!.core.filter((u) => u.k === "text" && u.x.includes(wide));
    const wideT7 = cans[7]!.core.filter((u) => u.k === "text" && u.x.includes(wide));
    assert.equal(wideT6.length, 0, `${L(6)}: wide carrier must be stripped while the geo_wide pair rides inbound`);
    assert.equal(wideT7.length, 0, `${L(7)}: wide carrier must be stripped while the geo_wide pair rides inbound`);
    assertPrefix(cans[6]!.core, cans[7]!.core, L(7), ["q8", "a8"]);
}, { timeout: 120_000 });

// #1567 hardening scenario A: a contract-violating (or pruning) client stops
// re-sending an older compress pair. While pairA rides, its anchor is
// stripped (P2b); the moment the pair vanishes the anchor MUST re-carry the
// summary (zero-carrier fail-safe) and the body must stay append-stable on
// later turns (no flapping).
testCompat(`cache-friendly plugin matrix: anthropic — client drops re-sent pair → anchor re-carries (#1567 hardening)`, async () => {
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
    // t4..t6: both pairs ride → both anchors stripped
    for (const i of [3, 4, 5]) {
        const raw = cans[i]!.raw;
        assert.equal(countOcc(raw, SUM_MARKER), 0, `${L(i)}: carrier must be stripped while pair rides`);
        assert.ok(raw.includes('"cfp_a"'), `${L(i)}: pairA still re-sent here`);
    }
    assert.ok(cans[5]!.raw.includes('"cfp_b"'), `${L(5)}: pairB rides`);
    // t7/t8: pairA gone → anchor A is the ONLY carrier again
    for (const i of [6, 7]) {
        const raw = cans[i]!.raw;
        assert.ok(!raw.includes('"cfp_a"'), `${L(i)}: client no longer re-sends pairA`);
        assert.equal(countOcc(raw, SUM_MARKER), 1, `${L(i)}: anchor A must re-carry (exactly one carrier)`);
        assert.equal(countOcc(raw, SUM_A), 1, `${L(i)}: SUM_A = carrier only (pair quotes gone with the pair)`);
        assert.equal(countOcc(raw, SUM_B), 2, `${L(i)}: SUM_B quotes only, anchor B still stripped (pairB rides)`);
        assert.ok(raw.includes('"cfp_b"'), `${L(i)}: pairB rides`);
    }
    assert.ok(cans[6]!.raw.includes("q7-marker"), `${L(6)}: new turn visible`);
    // once re-carried, the body stays append-stable (no flapping)
    assertPrefix(cans[6]!.core, cans[7]!.core, L(7), ["q8", "a8"]);
}, { timeout: 120_000 });

// #1567 hardening scenario B: three concurrent ACTIVE folds. The kernel hides
// consumed compress pairs beyond the newest KEEP_LAST_ORPHANED=2, so the
// oldest pair leaves the wire while its block is still active — the strip
// guard must see it gone and KEEP that anchor (kernel-side fail-safe).
testCompat(`cache-friendly plugin matrix: anthropic — 3rd fold prunes oldest pair → oldest anchor kept (#1567 hardening)`, async () => {
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
    // t3/t4: pairs ride (≤ 2) → anchors stripped. From t5 on, three pairs
    // coexist and the kernel hides the oldest (KEEP_LAST_ORPHANED=2) — the
    // guard sees it gone and keeps that anchor (kernel-side fail-safe)
    for (const i of [2, 3]) {
        assert.equal(countOcc(cans[i]!.raw, SUM_MARKER), 0, `${L(i)}: anchors stripped while pairs ride`);
    }
    assert.ok(cans[3]!.raw.includes('"fs1"') && cans[3]!.raw.includes('"fs2"'), `${L(3)}: both pairs visible`);
    // t5..t7: fs1 hidden by KEEP_LAST_ORPHANED → anchor F1 re-carries;
    // F2/F3 anchors stay stripped while their pairs ride
    for (const i of [4, 5, 6]) {
        const raw = cans[i]!.raw;
        assert.ok(!raw.includes('"fs1"'), `${L(i)}: oldest pair pruned (KEEP_LAST_ORPHANED=2)`);
        assert.ok(raw.includes('"fs2"') && raw.includes('"fs3"'), `${L(i)}: newest two pairs stay visible`);
        assert.equal(countOcc(raw, SUM_MARKER), 1, `${L(i)}: exactly one carrier (F1 anchor re-carried)`);
        assert.equal(countOcc(raw, SUM_P1), 1, `${L(i)}: SUM_P1 = carrier only (its pair quotes pruned with the pair)`);
        assert.equal(countOcc(raw, SUM_P2), 2, `${L(i)}: SUM_P2 quotes only`);
        assert.equal(countOcc(raw, SUM_P3), 2, `${L(i)}: SUM_P3 quotes only`);
    }
    // once the oldest anchor re-carries, later turns are append-stable
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
