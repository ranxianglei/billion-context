// Mechanism-level proof for positional fold identity (#2480): fold coverage
// must survive a re-serialization that rewrites every message id — the wire
// shape of the #2396/#2454 incident class (a host or client switch re-mints
// tool-call ids and re-serializes tool arguments while the logical content
// stays identical).
//
// Sibling of tests/cache-proof.test.ts (which proves byte-stability of the
// stable prefix). This file proves the IDENTITY side: what the proxy sends
// upstream after the client's id scheme churned.
//
// Per wire (chat / anthropic / responses / google):
//   1. GROW+ Fold: scripted turns with tool pairs until one compress fires
//      and the fold settles (round-2 + >=2 stable turns).
//   2. SWITCH: the client re-sends the SAME logical history with every tool
//      id re-schemed and every tool-call argument JSON re-serialized (keys
//      reversed, whitespace churned) — then continues the conversation.
//      Proof: the next outbound body STILL carries the fold summary and its
//      length stays at the folded magnitude (no unfolded re-entry, no
//      #2396-style billing spike), and growth after the switch continues
//      folded.
//   3. EDIT: a mid-history edit under the NEW id scheme must honestly
//      re-enter (edited original visible on the wire, summary retained for
//      the rest) — position claims never swallow changed content.
//
// Controls:
//   - BILI_FOLD_RECONCILE=off (chat wire): the same switch WITHOUT the
//     reconcile engine drops the summary and re-bills the full history —
//     proving the retention above is Pass 0's work, not an accident.
//   - Cross-wire client swap (anthropic -> chat, same session, ids re-minted
//     during the protocol conversion): coverage must survive the swap.
//   - MODEL-SWITCH (chat wire, #2636): the host re-serializes the SAME
//     logical history onto a differently-shaped model (pi transform-messages
//     on isSameModel=false): structured reasoning_content is inlined as
//     plain text (the reasoning+text core pair collapses into ONE merged
//     core) and image parts become a fixed placeholder line on a text-only
//     target. Fold coverage must survive the shape churn (Pass 3/4), the
//     covered thinking must not re-enter, and a later mid-history edit
//     still re-enters honestly. Its own reconcile-off control proves this
//     churn class re-bills the unfolded history without the layer.
//   - MODEL-SWITCH per-wire companions (#2636, #2193 follow-up): on the
//     anthropic/responses/google wires the realistic cross-model churn is
//     DROP-KEEP — structured thinking is discarded wholesale while every
//     text/tool core keeps its id (kernel ids are seeded blind to thinking
//     siblings). Two thinking carriers per turn keep the covered span above
//     the #2193 escalation minimum, proving the reasoning-only-drop
//     tolerance: coverage survives, thinking never re-bills, the honest
//     edit stays honest, and the destroy-escalation never latches.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

type Item = Record<string, unknown>;
type Wire = "responses" | "chat" | "anthropic" | "google";

const SUMMARY_MARKER = "[Compressed conversation section]";
const EDIT_MARKER = "IDENTITY-PROOF-EDIT";
const THRESHOLD = 64 * 1024;
const MODEL_A = "gpt-proof-a";
const MIN_FOLD_T = 8; // turns before the compress trigger may fire
const MAX_TURNS = 30;

const INSTRUCTIONS = "You are a coding agent operating in a sandbox.\nFollow repo conventions strictly.";
/** Tool results carry the bulk (the #2396/#2454 incident class re-billed
 *  TOOL payloads: ls output / build logs — not prose). ~6KB each with a
 *  per-turn unique marker so "the covered original re-entered the wire" is a
 *  binary, wire-format-independent assertion. */
const TOOL_RESULT_OK = (t: number): string =>
    `total 8\n` + Array.from({ length: 64 }, (_, i) => `-rw-r--r-- 1 u g 4096 Sep 27 10:0${i % 10} file-${t}-row-${i}.ts`).join("\n") + `\n# tail: module ${t} inspected\n`;

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the build pipeline ran cleanly and the integration suite reported no regressions across all four regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

/** Model-switch variant (#2636): every assistant turn carries structured
 *  reasoning (qwen-style same-model replay) with a per-turn unique tail so
 *  "the covered thinking re-entered the wire" is a binary assertion. */
const THINK = (t: number): string =>
    `Scratchpad ${t}: parse the request, enumerate candidates, weigh trade-offs (cost, latency, blast radius), verify assumptions, then commit. Unique marker scratch-${t}-final.`;
/** Second per-turn thinking carrier (drop-wire variant: two reasoning
 *  cores per assistant turn so the covered span exceeds the #2193
 *  escalation minimum of 10 dead ids). */
const THINK2 = (t: number): string =>
    `Scratchpad ${t}b: cross-check the plan against the repo invariants, enumerate failure modes, then finalize. Unique marker scratch-${t}-second-final.`;
/** Third per-turn thinking carrier (anthropic drop wire only: pushes the
 *  span past the reasoning-majority line, pinning the #2695 reap's
 *  reasoning-awareness, #2732). */
const THINK3 = (t: number): string =>
    `Scratchpad ${t}c: weigh the fix against the repo contract, enumerate blast radius, then commit. Unique marker scratch-${t}-third-final.`;
/** Per-turn unique, padding-correct PNG data URL (identity is over the image
 *  bytes — identical bytes across turns would collapse onto one id). */
const IMG = (t: number): string => `data:image/png;base64,iVBORw0KGgo${"A".repeat(39)}${String(t).padStart(8, "0")}==`;
/** pi's NON_VISION_USER_IMAGE_PLACEHOLDER, byte-stable (transform-messages). */
const USER_IMAGE_PLACEHOLDER_PROOF = "(image omitted: model does not support images)";

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

/** Reverse the key order of a flat JSON object and churn its whitespace —
 *  the observable shape of "same arguments, different serializer". */
function reserializeArgs(raw: string): string {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return ` { "v": ${raw.length} } `; }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return ` { "v": 1 } `;
    const entries = Object.entries(parsed as Record<string, unknown>).reverse();
    return " { " + entries.map(([k, v]) => `${JSON.stringify(k)} : ${JSON.stringify(v)}`).join(" , ") + " } ";
}

/** The #2636 incident shape: the host replays the SAME logical history onto
 *  a differently-shaped model (pi transform-messages, isSameModel=false):
 *  reasoning_content is inlined into content as plain text (seamless join —
 *  the reasoning+text core pair collapses into one merged core) and user
 *  image parts become the fixed placeholder line (text part join "\n").
 *  Tool ids and arguments are untouched — this churn class is PURELY
 *  shape, which is exactly what the pre-#2636 passes cannot pair. */
function churnModelSwitch(hist: Item[]): void {
    for (const m of hist) {
        if (m.role === "assistant" && typeof m.reasoning_content === "string") {
            const reply = Array.isArray(m.content) ? m.content.map(String).join("") : String(m.content ?? "");
            m.content = m.reasoning_content + reply;
            delete m.reasoning_content;
        } else if (m.role === "user" && Array.isArray(m.content)) {
            const parts = asArr(m.content);
            const text = parts.filter((p) => p.type === "text").map((p) => String(p.text ?? "")).join("\n");
            m.content = parts.some((p) => p.type === "image_url") ? `${text}\n${USER_IMAGE_PLACEHOLDER_PROOF}` : text;
        }
    }
}

interface JudgeState {
    wire: Wire;
    bodies: string[];
    turn: number;
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
                    topic: "identity proof fold",
                    summary: `Identity-proof fold summary covering ${start}..${end}: turns exercised the pipeline, builds stayed green, id schemes churned without losing coverage.`,
                }],
            });
        },
    };
}

function startJudgeUpstream(state: JudgeState, trigger: ReturnType<typeof makeProofTrigger>): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            state.bodies.push(body);
            const idx = state.bodies.length;
            const prompt = Math.max(1, Math.ceil(body.length / 4));
            const label = replyLabel(body);
            const reply = `Reply Turn ${label}: done. ` + FILLER(Number(label), 0.2);
            const compressArgs = !state.suppressTrigger && trigger.should(body, state.turn) ? trigger.args(parseRefIds(body)) : undefined;
            switch (state.wire) {
                case "responses": {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                    const blk = (type: string, data: Record<string, unknown>): void => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
                    const usage = { input_tokens: prompt, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } };
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
                    const usage = { prompt_tokens: prompt, completion_tokens: 5, total_tokens: prompt + 5 };
                    if (compressArgs !== undefined) {
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_cmp_${idx}`, type: "function", function: { name: "compress", arguments: compressArgs } }] } }] });
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage });
                    } else {
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply } }] });
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
                    }
                    res.write("data: [DONE]\n\n");
                    res.end();
                    return;
                }
                case "anthropic": {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                    const ev = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
                    ev("message_start", { type: "message_start", message: { id: `msg_a_${idx}`, role: "assistant", usage: { input_tokens: prompt, cache_read_input_tokens: 0 } } });
                    if (compressArgs !== undefined) {
                        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_cmp_${idx}`, name: "compress", input: {} } });
                        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: compressArgs.slice(0, 20) } });
                        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: compressArgs.slice(20) } });
                        ev("content_block_stop", { type: "content_block_stop" });
                        ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } });
                    } else {
                        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
                        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } });
                        ev("content_block_stop", { type: "content_block_stop" });
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
                        res.write(`data: ${JSON.stringify({ candidates: [candidate], modelVersion: "gemini-test", usageMetadata: { promptTokenCount: prompt, cachedContentTokenCount: 0, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: prompt + 55 } })}\n\n`);
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
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine || dataLine.includes("[DONE]")) continue;
        try {
            if (wire === "responses") {
                const d = JSON.parse(dataLine.slice(5).trim()) as { type?: string; delta?: string };
                if (d.type === "response.output_text.delta" && d.delta) out += d.delta;
            } else if (wire === "chat") {
                const d = JSON.parse(dataLine.slice(5).trim()) as { choices?: Array<{ delta?: { content?: string } }> };
                const c = d.choices?.[0]?.delta?.content;
                if (typeof c === "string") out += c;
            } else if (wire === "anthropic") {
                const d = JSON.parse(dataLine.slice(5).trim()) as { delta?: { type?: string; text?: string } };
                if (d.delta?.type === "text_delta" && d.delta.text) out += d.delta.text;
            } else {
                const d = JSON.parse(dataLine.slice(5).trim()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
                for (const cand of d.candidates ?? []) for (const pt of cand.content?.parts ?? []) if (typeof pt.text === "string" && pt.thought !== true) out += pt.text;
            }
        } catch { /* ignore */ }
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

function proofProxyOptions(upstreamPort: number, ctx: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL_A]: { context: ctx } } } },
        modelContextLimit: ctx,
        kernelConfig: defaultConfig(ctx),
        compress: { injectTool: true, injectNudge: true },
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

/** Wire-specific client history operations: how this wire spells a user
 *  turn, an assistant reply, a shell tool pair — and where the id scheme +
 *  argument serialization live (so the SWITCH phase can churn exactly
 *  those while keeping logical content identical). The "model-switch"
 *  variant (chat wire only, #2636) instead spells reasoning-bearing
 *  assistant turns and image-bearing user turns, and churns the SHAPE. */
interface WireOps {
    field: string;
    initHistory: () => void;
    pushUser: (t: number) => void;
    pushAssistant: (t: number, reply: string) => void;
    pushToolPair: (t: number, result: string) => void;
    /** Rewrite every message id + re-serialize every tool argument in place. */
    churnIds: () => void;
    /** Model-switch churn: re-serialize the history for a differently-shaped
     *  model (reasoning inlined, images placeholdered); new turns after it
     *  take the new model's shape (no reasoning field, no image parts). */
    churnModelSwitch?: () => void;
    /** Edit one mid-history user turn (content edit — must honestly re-enter). */
    editMidHistory: () => void;
    payload: (url: string) => Item;
}

type Variant = "id-churn" | "model-switch";

function makeOps(wire: Wire, hist: Item[], variant: Variant = "id-churn"): WireOps {
    const SHELL_ARGS = (t: number): string => JSON.stringify({ command: `ls -la mod-${t}`, cwd: `/ws/${t}` });
    if (variant === "model-switch") {
        // Per-wire model-switch churn. chat is the #2636 incident shape (pi
        // transform-messages: reasoning inlined seamlessly, image parts
        // placeholdered). The other three wires' REALISTIC cross-model shape
        // is DROP-KEEP: structured thinking (anthropic thinking blocks /
        // responses reasoning items / google thought parts) is discarded
        // wholesale while every text/tool core is replayed byte-identically —
        // kernel ids are seeded blind to thinking siblings, so surviving ids
        // do not churn at all. Two thinking carriers per turn so the covered
        // span accumulates >= 10 dead reasoning ids — enough to trip the
        // #2193 destroy-escalation thresholds if the classification below
        // were missing.
        let switched = false;
        const dropThinking = (keep: (m: Item) => void): void => {
            switched = true;
            for (const m of hist) keep(m);
        };
        if (wire === "chat") {
            return {
                field: "messages",
                initHistory: () => { hist.push({ role: "system", content: "You are a coding agent operating in a sandbox. Follow repo conventions strictly." }); },
                pushUser: (t) => {
                    const text = `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6);
                    hist.push(switched ? { role: "user", content: text } : { role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: IMG(t) } }] });
                },
                pushAssistant: (t, reply) => {
                    hist.push(switched ? { role: "assistant", content: reply } : { role: "assistant", content: reply, reasoning_content: THINK(t) });
                },
                pushToolPair: (t, result) => {
                    hist.push({ role: "assistant", content: null, tool_calls: [{ id: `call_t${t}`, type: "function", function: { name: "shell", arguments: SHELL_ARGS(t) } }] });
                    hist.push({ role: "tool", tool_call_id: `call_t${t}`, content: result });
                },
                churnIds: () => { /* id-scheme churn is the other variant's phase; ids are NOT the churn here. */ },
                churnModelSwitch: () => { switched = true; churnModelSwitch(hist); },
                editMidHistory: () => {
                    const u = hist.find((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Turn 2:")) as { content: string } | undefined;
                    assert.ok(u !== undefined, "chat model-switch: mid-history user turn not found for the edit");
                    u.content = u.content.replace("Turn 2:", `Turn 2 [${EDIT_MARKER}]:`);
                },
                payload: () => ({ model: MODEL_A, stream: true, messages: [...hist] }),
            };
        }
        if (wire === "anthropic") {
            return {
                field: "messages",
                initHistory: () => undefined,
                pushUser: (t) => { hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) }); },
                pushAssistant: (t, reply) => {
                    // Three thinking carriers per turn (60% of the span's
                    // covered ids) — past the majority line, so a reasoning-
                    // blind #2695 reap would eat this block 3 passes after
                    // the sanctioned drop. The other drop wires stay at two
                    // carriers: they pin the escalation-side tolerance; this
                    // wire pins the reap-side tolerance.
                    hist.push(switched
                        ? { role: "assistant", content: [{ type: "text", text: reply }] }
                        : { role: "assistant", content: [{ type: "thinking", thinking: THINK(t), signature: `sig-${t}-a` }, { type: "thinking", thinking: THINK2(t), signature: `sig-${t}-b` }, { type: "thinking", thinking: THINK3(t), signature: `sig-${t}-c` }, { type: "text", text: reply }] });
                },
                pushToolPair: (t, result) => {
                    // No tool pairs in this variant: with pairs the covered
                    // span's reasoning share sits at 46% (under the majority
                    // line — the false-reap bug would not reproduce).
                    // Pair-free turns make the span 75% reasoning, past the
                    // line, which is what pins the #2695 reap's
                    // reasoning-awareness (#2732). The other wires keep tool
                    // pairs for the re-bill teeth.
                    void t; void result;
                },
                churnIds: () => { /* ids are NOT the churn in this variant. */ },
                churnModelSwitch: () => dropThinking((m) => {
                    if (m.role === "assistant" && Array.isArray(m.content)) {
                        m.content = asArr(m.content).filter((b) => b.type !== "thinking");
                    }
                }),
                editMidHistory: () => {
                    const u = hist.find((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Turn 2:")) as { content: string } | undefined;
                    assert.ok(u !== undefined, "anthropic model-switch: mid-history user turn not found for the edit");
                    u.content = u.content.replace("Turn 2:", `Turn 2 [${EDIT_MARKER}]:`);
                },
                payload: () => ({ model: MODEL_A, max_tokens: 1024, stream: true, system: "You are a test assistant.", messages: [...hist] }),
            };
        }
        if (wire === "responses") {
            return {
                field: "input",
                initHistory: () => undefined,
                pushUser: (t) => { hist.push({ type: "message", role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) }); },
                pushAssistant: (t, reply) => {
                    if (!switched) {
                        hist.push({ type: "reasoning", id: `rs_a${t}`, encrypted_content: `enc_a${t}_` + "x".repeat(200) });
                        hist.push({ type: "reasoning", id: `rs_b${t}`, encrypted_content: `enc_b${t}_` + "y".repeat(200) });
                    }
                    hist.push({ type: "message", id: `msg_a${t}`, role: "assistant", content: reply });
                },
                pushToolPair: (t, result) => {
                    hist.push({ type: "function_call", id: `fc_t${t}`, call_id: `call_t${t}`, name: "shell", arguments: SHELL_ARGS(t), status: "completed" });
                    hist.push({ type: "function_call_output", id: `fco_t${t}`, call_id: `call_t${t}`, output: result });
                },
                churnIds: () => { /* ids are NOT the churn in this variant. */ },
                churnModelSwitch: () => dropThinking(() => {
                    for (let i = hist.length - 1; i >= 0; i--) {
                        if (hist[i]!.type === "reasoning") hist.splice(i, 1);
                    }
                }),
                editMidHistory: () => {
                    const u = hist.find((it) => it.type === "message" && it.role === "user" && typeof it.content === "string" && it.content.includes("Turn 2:")) as { content: string } | undefined;
                    assert.ok(u !== undefined, "responses model-switch: mid-history user turn not found for the edit");
                    u.content = u.content.replace("Turn 2:", `Turn 2 [${EDIT_MARKER}]:`);
                },
                payload: () => ({ model: MODEL_A, stream: true, instructions: INSTRUCTIONS, tools: [{ type: "function", name: "shell", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }], input: [...hist] }),
            };
        }
        // google
        return {
            field: "contents",
            initHistory: () => undefined,
            pushUser: (t) => { hist.push({ role: "user", parts: [{ text: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) }] }); },
            pushAssistant: (t, reply) => {
                hist.push(switched
                    ? { role: "model", parts: [{ text: reply }] }
                    : { role: "model", parts: [{ text: THINK(t), thought: true }, { text: THINK2(t), thought: true }, { text: reply }] });
            },
            pushToolPair: (t, result) => {
                hist.push({ role: "model", parts: [{ functionCall: { id: `fcg_${t}`, name: "shell", args: { command: `ls -la mod-${t}`, cwd: `/ws/${t}` } } }] });
                hist.push({ role: "user", parts: [{ functionResponse: { name: "shell", response: { result } } }] });
            },
            churnIds: () => { /* ids are NOT the churn in this variant. */ },
            churnModelSwitch: () => dropThinking((c) => {
                if (Array.isArray(c.parts)) c.parts = asArr(c.parts).filter((p) => p.thought !== true);
            }),
            editMidHistory: () => {
                for (const c of hist) if (c.role === "user") for (const pt of asArr(c.parts)) {
                    const tx = pt.text as string | undefined;
                    if (typeof tx === "string" && tx.includes("Turn 2:")) { pt.text = tx.replace("Turn 2:", `Turn 2 [${EDIT_MARKER}]:`); return; }
                }
                assert.fail("google model-switch: mid-history user turn not found for the edit");
            },
            payload: (url) => ({ model: url.split("/models/")[1]?.split(":")[0] ?? MODEL_A, contents: [...hist], systemInstruction: { parts: [{ text: "you are a test assistant" }] }, generationConfig: { maxOutputTokens: 4096 } }),
        };
    }
    switch (wire) {
        case "responses":
            return {
                field: "input",
                initHistory: () => undefined,
                pushUser: (t) => { hist.push({ type: "message", role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) }); },
                pushAssistant: (t, reply) => {
                    hist.push({ type: "reasoning", id: `rs_${t}`, encrypted_content: `enc_${t}_` + "x".repeat(200) });
                    hist.push({ type: "message", id: `msg_a${t}`, role: "assistant", content: reply });
                },
                pushToolPair: (t, result) => {
                    hist.push({ type: "function_call", id: `fc_t${t}`, call_id: `call_t${t}`, name: "shell", arguments: SHELL_ARGS(t), status: "completed" });
                    hist.push({ type: "function_call_output", id: `fco_t${t}`, call_id: `call_t${t}`, output: result });
                },
                churnIds: () => {
                    for (const it of hist) {
                        if (typeof it.id === "string") it.id = `alt_${it.id}`;
                        if (typeof it.call_id === "string") it.call_id = `alt_${it.call_id}`;
                        if (it.type === "function_call" && typeof it.arguments === "string") it.arguments = reserializeArgs(it.arguments);
                    }
                },
                editMidHistory: () => {
                    const u = hist.find((it) => it.type === "message" && it.role === "user" && typeof it.content === "string" && it.content.includes("Turn 2:")) as { content: string } | undefined;
                    assert.ok(u !== undefined, "responses: mid-history user turn not found for the edit");
                    u.content = u.content.replace("Turn 2:", `Turn 2 [${EDIT_MARKER}]:`);
                },
                payload: () => ({ model: MODEL_A, stream: true, instructions: INSTRUCTIONS, tools: [{ type: "function", name: "shell", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }], input: [...hist] }),
            };
        case "chat":
            return {
                field: "messages",
                initHistory: () => { hist.push({ role: "system", content: "You are a coding agent operating in a sandbox. Follow repo conventions strictly." }); },
                pushUser: (t) => { hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) }); },
                pushAssistant: (t, reply) => { hist.push({ role: "assistant", content: reply }); },
                pushToolPair: (t, result) => {
                    hist.push({ role: "assistant", content: null, tool_calls: [{ id: `call_t${t}`, type: "function", function: { name: "shell", arguments: SHELL_ARGS(t) } }] });
                    hist.push({ role: "tool", tool_call_id: `call_t${t}`, content: result });
                },
                churnIds: () => {
                    for (const m of hist) {
                        for (const tc of asArr(m.tool_calls)) {
                            if (typeof tc.id === "string") tc.id = `alt_${tc.id}`;
                            const f = tc.function as { arguments?: string } | undefined;
                            if (f && typeof f.arguments === "string") f.arguments = reserializeArgs(f.arguments);
                        }
                        if (typeof m.tool_call_id === "string") m.tool_call_id = `alt_${m.tool_call_id}`;
                    }
                },
                editMidHistory: () => {
                    const u = hist.find((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Turn 2:")) as { content: string } | undefined;
                    assert.ok(u !== undefined, "chat: mid-history user turn not found for the edit");
                    u.content = u.content.replace("Turn 2:", `Turn 2 [${EDIT_MARKER}]:`);
                },
                payload: () => ({ model: MODEL_A, stream: true, messages: [...hist] }),
            };
        case "anthropic":
            return {
                field: "messages",
                initHistory: () => undefined,
                pushUser: (t) => { hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) }); },
                pushAssistant: (t, reply) => { hist.push({ role: "assistant", content: [{ type: "text", text: reply }] }); },
                pushToolPair: (t, result) => {
                    hist.push({ role: "assistant", content: [{ type: "text", text: "running a check" }, { type: "tool_use", id: `tu_${t}`, name: "shell", input: { command: `ls -la mod-${t}`, cwd: `/ws/${t}` } }] });
                    hist.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${t}`, content: result }] });
                },
                churnIds: () => {
                    for (const m of hist) {
                        for (const b of asArr(m.content)) {
                            if (b.type === "tool_use" && typeof b.id === "string") {
                                b.id = `alt_${b.id}`;
                                if (b.input && typeof b.input === "object") b.input = Object.fromEntries(Object.entries(b.input as Record<string, unknown>).reverse());
                            }
                            if (b.type === "tool_result" && typeof b.tool_use_id === "string") b.tool_use_id = `alt_${b.tool_use_id}`;
                        }
                    }
                },
                editMidHistory: () => {
                    const u = hist.find((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Turn 2:")) as { content: string } | undefined;
                    assert.ok(u !== undefined, "anthropic: mid-history user turn not found for the edit");
                    u.content = u.content.replace("Turn 2:", `Turn 2 [${EDIT_MARKER}]:`);
                },
                payload: () => ({ model: MODEL_A, max_tokens: 1024, stream: true, system: "You are a test assistant.", messages: [...hist] }),
            };
        case "google":
            return {
                field: "contents",
                initHistory: () => undefined,
                pushUser: (t) => { hist.push({ role: "user", parts: [{ text: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) }] }); },
                pushAssistant: (t, reply) => { hist.push({ role: "model", parts: [{ text: reply }] }); },
                pushToolPair: (t, result) => {
                    hist.push({ role: "model", parts: [{ functionCall: { id: `fcg_${t}`, name: "shell", args: { command: `ls -la mod-${t}`, cwd: `/ws/${t}` } } }] });
                    hist.push({ role: "user", parts: [{ functionResponse: { name: "shell", response: { result } } }] });
                },
                churnIds: () => {
                    for (const c of hist) for (const pt of asArr(c.parts)) {
                        const fc = pt.functionCall as { id?: string; args?: Record<string, unknown> } | undefined;
                        if (fc) {
                            if (typeof fc.id === "string") fc.id = `alt_${fc.id}`;
                            if (fc.args && typeof fc.args === "object") fc.args = Object.fromEntries(Object.entries(fc.args).reverse());
                        }
                    }
                },
                editMidHistory: () => {
                    for (const c of hist) if (c.role === "user") for (const pt of asArr(c.parts)) {
                        const tx = pt.text as string | undefined;
                        if (typeof tx === "string" && tx.includes("Turn 2:")) { pt.text = tx.replace("Turn 2:", `Turn 2 [${EDIT_MARKER}]:`); return; }
                    }
                    assert.fail("google: mid-history user turn not found for the edit");
                },
                payload: (url) => ({ model: url.split("/models/")[1]?.split(":")[0] ?? MODEL_A, contents: [...hist], systemInstruction: { parts: [{ text: "you are a test assistant" }] }, generationConfig: { maxOutputTokens: 4096 } }),
            };
    }
}

function urlForWire(wire: Wire, base: string, model = MODEL_A): string {
    return wire === "responses" ? `${base}/v1/responses`
        : wire === "chat" ? `${base}/v1/chat/completions`
        : wire === "anthropic" ? `${base}/v1/messages`
        : `${base}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
}

const sha16 = (b: string): string => createHash("sha256").update(b, "utf8").digest("hex").slice(0, 16);

interface DriveResult { bodies: string[]; foldIdx: number; switchIdx: number; editIdx: number; unfoldLen: number; }

/** Drives grow->fold->switch->edit on one wire and returns the judge-side
 *  body stream with the key indices. The variant selects the SWITCH phase's
 *  churn: "id-churn" (id scheme + argument serialization) or "model-switch"
 *  (#2636 shape churn: reasoning inlined, images placeholdered). */
async function driveIdentity(wire: Wire, sessionId: string, ctx: number, variant: Variant = "id-churn"): Promise<DriveResult> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `identity-${wire}-`));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmp;
    delete process.env.ACP_DUMP_BODY;
    const reconcileLines: string[] = [];
    if (process.env.IDENTITY_PROOF_DUMP) {
        const { setLogCapture } = await import("../src/logger.js");
        setLogCapture((level, msg) => {
            if (msg.includes("fold-reconcile") || msg.includes("fold") || msg.includes("compaction") || msg.includes("transform failed") || msg.includes("rebas") || msg.includes("rewrite") || msg.includes("[identity-")) reconcileLines.push(`[${level}] ${msg}`);
        });
    }
    const hist: Item[] = [];
    const ops = makeOps(wire, hist, variant);
    const bodies: string[] = [];
    const trigger = makeProofTrigger(THRESHOLD, MIN_FOLD_T);
    const state: JudgeState = { wire, bodies, turn: 0, suppressTrigger: false };
    let upstream: http.Server | undefined;
    let proxy: http.Server | undefined;
    try {
        upstream = startJudgeUpstream(state, trigger);
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        proxy = await startServer(proofProxyOptions(upstreamPort, ctx));
        await listen(proxy);
        const proxyPort = (proxy.address() as { port: number }).port;
        const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
        const url = urlForWire(wire, base);
        const post = async (t: number): Promise<string> => {
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify(ops.payload(url)) });
            if (!res.ok) throw new Error(`${wire} turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
            return res.text();
        };
        const sendTurn = async (t: number): Promise<void> => {
            state.turn = t;
            ops.pushUser(t);
            const raw = await post(t);
            const reply = extractReply(wire, raw);
            assert.ok(reply.length > 0, `${wire} turn ${t}: empty reply`);
            ops.pushAssistant(t, reply);
            if (t % 2 === 0) ops.pushToolPair(t, TOOL_RESULT_OK(t));
        };

        ops.initHistory();
        // Phase G: grow until one fold fires and settles.
        let foldIdx = -1;
        let sinceFold = 0;
        for (let t = 0; t < MAX_TURNS; t++) {
            const before = trigger.calls();
            await sendTurn(t);
            if (trigger.calls() > before) { foldIdx = bodies.length - 1; sinceFold = 0; }
            else sinceFold++;
            if (foldIdx >= 0 && sinceFold >= 2) break;
        }
        assert.ok(foldIdx >= 0, `${wire}: no fold fired within ${MAX_TURNS} turns`);
        // The largest pre-fold body is the unfolded magnitude reference.
        let unfoldLen = 0;
        for (let i = 0; i < foldIdx; i++) unfoldLen = Math.max(unfoldLen, Buffer.byteLength(bodies[i]!, "utf8"));
        assert.ok(unfoldLen > THRESHOLD * 0.6, `${wire}: unfolded reference body suspiciously small (${unfoldLen}B)`);
        const settledLen = Buffer.byteLength(bodies[bodies.length - 1]!, "utf8");
        assert.ok(bodies[foldIdx]!.includes(SUMMARY_MARKER), `${wire}: fold round-2 body lacks the summary carrier`);
        // Snapshot BEFORE the churn: the fold blocks settled here (with their
        // reasoning cores inside the covered span) must survive every churned
        // pass verbatim — a #2695 false reap would silently replace them with
        // a re-fold over the decimated text-only history (#2732).
        const blocksAtFold = new Set(getSession(sessionId).state.blocks.map((b) => b.blockId));
        assert.ok(blocksAtFold.size >= 1, `${wire}: no fold block after settle`);

        // Phase S: churn (id scheme + argument serialization, or the #2636
        // model-switch shape churn), then continue the conversation on the
        // SAME session.
        if (variant === "model-switch") ops.churnModelSwitch?.();
        else ops.churnIds();
        const phaseLabel = variant === "model-switch" ? "MODEL-SWITCH" : "SWITCH";
        // Judge the FIRST body after the churn, not the last: if the fold
        // failed to attach, the unfolded replay goes out on round-1 and a
        // fresh server-side compress may re-fold it — the healed round-2
        // must never stand in for the retention proof.
        const firstChurnBody = bodies.length;
        await sendTurn(MAX_TURNS + 1);
        const switchIdx = firstChurnBody;
        const switchBody = bodies[switchIdx]!;
        const switchLen = Buffer.byteLength(switchBody, "utf8");
        if (process.env.IDENTITY_PROOF_DUMP) {
            const { writeFileSync } = await import("node:fs");
            bodies.forEach((b, i) => {
                const markers = [0, 2, 4, 6, 8, 10, 12].filter((t) => b.includes(`file-${t}-row-`));
                writeFileSync(`/tmp/idproof-${wire}-all-${String(i).padStart(2, "0")}.json`, b);
                console.log(`dump[${wire}] body[${i}] alt=${b.includes("alt_") ? 1 : 0} summary=${b.includes(SUMMARY_MARKER) ? 1 : 0} markers=${JSON.stringify(markers)} len=${Buffer.byteLength(b, "utf8")}B`);
            });
            for (const line of reconcileLines) console.log(`reconcile[${wire}] ${line.slice(0, 400)}`);
        }
        assert.ok(switchBody.includes(SUMMARY_MARKER), `${wire} ${phaseLabel}: summary carrier LOST after the churn — coverage re-entered unfolded (#2396 regression, #2480 claim failed)`);
        assert.ok(!switchBody.includes("file-2-row-"), `${wire} ${phaseLabel}: a covered tool result re-entered the wire verbatim — the fold span was re-billed`);
        assert.ok(switchLen < unfoldLen, `${wire} ${phaseLabel}: post-churn body ${switchLen}B at or beyond the unfolded magnitude (ref ${unfoldLen}B) while the history only grew — full re-entry`);
        if (variant === "model-switch") {
            assert.ok(!switchBody.includes("scratch-2-final"), `${wire} ${phaseLabel}: a covered assistant thinking re-entered the wire verbatim — the pair->merged churn re-billed folded reasoning (#2636 regression)`);
            if (wire === "chat") {
                assert.ok(switchBody.includes(USER_IMAGE_PLACEHOLDER_PROOF), `${wire} ${phaseLabel}: the placeholder sanity marker is missing — the churn did not land`);
            } else {
                assert.ok(!switchBody.includes("scratch-"), `${wire} ${phaseLabel}: thinking carriers still on the wire — the drop churn did not land`);
            }
        }
        console.log(`proof[${wire}] ${phaseLabel} ok churn-retained-fold len=${switchLen}B (unfolded-ref=${unfoldLen}B, settled=${settledLen}B) sha=${sha16(switchBody)}`);
        // Growth continues folded after the churn.
        await sendTurn(MAX_TURNS + 2);
        const growthBody = bodies[bodies.length - 1]!;
        assert.ok(growthBody.includes(SUMMARY_MARKER), `${wire} post-switch growth lost the summary`);
        assert.ok(!growthBody.includes("file-2-row-"), `${wire} post-switch growth re-billed a covered tool result`);
        assert.ok(Buffer.byteLength(growthBody, "utf8") < unfoldLen, `${wire} post-switch growth re-billed the unfolded magnitude`);
        console.log(`proof[${wire}] GROWTH-AFTER-SWITCH ok folded len=${Buffer.byteLength(growthBody, "utf8")}B sha=${sha16(growthBody)}`);

        // Phase E: mid-history content edit under the churned scheme must
        // honestly re-enter: the edited original becomes visible on the wire
        // while the summary is retained for everything else.
        ops.editMidHistory();
        await sendTurn(MAX_TURNS + 3);
        const editIdx = bodies.length - 1;
        const editBody = bodies[editIdx]!;
        assert.ok(editBody.includes(SUMMARY_MARKER), `${wire} EDIT: summary lost on a content edit`);
        assert.ok(editBody.includes(EDIT_MARKER), `${wire} EDIT: the edited original did not honestly re-enter the wire — position claims swallowed changed content (MISATTRIBUTION)`);
        console.log(`proof[${wire}] EDIT ok edit-reentered summary-retained len=${Buffer.byteLength(editBody, "utf8")}B sha=${sha16(editBody)}`);
        if (variant === "model-switch") {
            // #2193 follow-up (per-wire model-switch audit): the churn phases
            // above are sanctioned host behavior — a pure reasoning drop (or
            // the chat merge) must NEVER latch the destroy-escalation: the
            // fold substrate stays healthy (summary retained, covered text
            // never re-billed — asserted above). On the drop wires the
            // covered span carries >= 10 dead reasoning ids, so by this
            // third churned pass master (without the reasoning-only-drop
            // classification) would already have latched the escalation.
            // The honest EDIT above may accrue an ordinary single-pass drift,
            // and dead reasoning ids never count toward the destroy bar —
            // with the reasoning-only-drop classification the latch can
            // never fire from a sanctioned switch plus one edit.
            // Reap side of the same audit (#2695 × #2732): a block whose
            // covered span is reasoning-majority (anthropic here) must not
            // be reaped by the sanctioned drop — the substrate is healthy
            // (text/tool ride verbatim). Blocks may only grow past the
            // pre-churn snapshot, never shrink.
            const mid = getSession(sessionId);
            assert.ok(mid.metadata.foldDriftEscalated !== true, `${wire} ${phaseLabel}: destroy-escalation latched on a sanctioned model switch — misdiagnosis (#2193 follow-up)`);
            for (const bid of blocksAtFold.keys()) {
                const alive = mid.state.blocks.find((b) => b.blockId === bid);
                assert.ok(alive !== undefined, `${wire} ${phaseLabel}: fold block ${bid} reaped by a sanctioned model switch and replaced by a re-fold — false zombie (#2695 reap, #2732)`);
            }
            await sendTurn(MAX_TURNS + 4);
            const sess = getSession(sessionId);
            assert.ok(sess.metadata.foldDriftEscalated !== true, `${wire} POST-EDIT: destroy-escalation latched on a sanctioned model switch — misdiagnosis (#2193 follow-up)`);
            for (const bid of blocksAtFold.keys()) {
                const alive = sess.state.blocks.find((b) => b.blockId === bid);
                assert.ok(alive !== undefined, `${wire} POST-EDIT: fold block ${bid} reaped by a sanctioned model switch and replaced by a re-fold — false zombie (#2695 reap, #2732)`);
            }
            const cleanBody = bodies[bodies.length - 1]!;
            assert.ok(cleanBody.includes(SUMMARY_MARKER), `${wire} POST-EDIT: summary carrier lost after the edit phase`);
        }
        console.log(`proof[${wire}] VERDICT fold=1 switchRetained=1 editHonest=1 misattributions=0`);
        return { bodies, foldIdx, switchIdx, editIdx, unfoldLen };
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(tmp);
    }
}

test("identity proof (chat wire): id-scheme churn keeps fold coverage, edits stay honest (#2480)", { timeout: 180_000 }, async () => {
    await driveIdentity("chat", "identity-chat", 200_000);
});

test("identity proof (anthropic wire): id-scheme churn keeps fold coverage, edits stay honest (#2480)", { timeout: 180_000 }, async () => {
    await driveIdentity("anthropic", "identity-anthropic", 400_000);
});

test("identity proof (responses wire): id-scheme churn keeps fold coverage, edits stay honest (#2480)", { timeout: 180_000 }, async () => {
    await driveIdentity("responses", "identity-responses", 200_000);
});

test("identity proof (google wire): id-scheme churn keeps fold coverage, edits stay honest (#2480)", { timeout: 180_000 }, async () => {
    await driveIdentity("google", "identity-google", 1_000_000);
});

// #2636: the model-switch churn class (reasoning inlined pair->merged, image
// parts placeholdered) — the same grow->fold->switch->edit arc on the chat
// wire with reasoning-bearing turns and image-bearing user turns. Coverage
// must survive the shape churn, the covered THINKING must not re-enter, and
// the mid-history edit afterwards must still re-enter honestly.
test("identity proof (chat wire, model switch): cross-model re-serialization keeps fold coverage (#2636)", { timeout: 180_000 }, async () => {
    await driveIdentity("chat", "identity-chat-modelswitch", 200_000, "model-switch");
});

// #2636 per-wire companions: on the anthropic/responses/google wires the
// REALISTIC cross-model churn is DROP-KEEP — structured thinking (thinking
// blocks / reasoning items / thought parts) is discarded wholesale while
// every text/tool core is replayed byte-identically (kernel ids are seeded
// blind to thinking siblings). Two thinking carriers per turn keep the
// covered span above the #2193 escalation minimum of 10 dead reasoning
// ids, so these tests prove the reasoning-only-drop tolerance: coverage
// survives, thinking never re-enters, the subsequent honest edit stays
// honest, and the destroy-escalation never latches (#2193 follow-up).
test("identity proof (anthropic wire, model switch): thinking-drop re-serialization keeps fold coverage (#2636)", { timeout: 180_000 }, async () => {
    await driveIdentity("anthropic", "identity-anthropic-modelswitch", 400_000, "model-switch");
});

test("identity proof (responses wire, model switch): reasoning-item-drop re-serialization keeps fold coverage (#2636)", { timeout: 180_000 }, async () => {
    await driveIdentity("responses", "identity-responses-modelswitch", 200_000, "model-switch");
});

test("identity proof (google wire, model switch): thought-part-drop re-serialization keeps fold coverage (#2636)", { timeout: 180_000 }, async () => {
    await driveIdentity("google", "identity-google-modelswitch", 1_000_000, "model-switch");
});

// Negative control for the #2636 churn class: WITHOUT the reconcile engine
// the model-switch re-serialization re-bills the unfolded history — proving
// the retention above is the reconcile layer's Pass 3/4 work, not an
// accident, and that this churn class genuinely defeats the old world.
test("identity proof (control, chat wire): reconcile OFF lets the model-switch churn re-bill the unfolded history (#2636)", { timeout: 180_000 }, async () => {
    const prev = process.env.BILI_FOLD_RECONCILE;
    process.env.BILI_FOLD_RECONCILE = "off";
    try {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "identity-ms-ctl-"));
        const prevXdg = process.env.XDG_STATE_HOME;
        process.env.XDG_STATE_HOME = tmp;
        const hist: Item[] = [];
        const ops = makeOps("chat", hist, "model-switch");
        const bodies: string[] = [];
        const trigger = makeProofTrigger(THRESHOLD, MIN_FOLD_T);
        const state: JudgeState = { wire: "chat", bodies, turn: 0, suppressTrigger: false };
        let upstream: http.Server | undefined;
        let proxy: http.Server | undefined;
        try {
            upstream = startJudgeUpstream(state, trigger);
            upstream.listen(0, "127.0.0.1");
            await listen(upstream);
            const upstreamPort = (upstream.address() as { port: number }).port;
            _setStoreForTest(new SessionStore({ enabled: false }));
            setRegistryForTest({});
            proxy = await startServer(proofProxyOptions(upstreamPort, 200_000));
            await listen(proxy);
            const proxyPort = (proxy.address() as { port: number }).port;
            const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
            const post = async (t: number): Promise<string> => {
                const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "identity-ms-ctl" }, body: JSON.stringify(ops.payload(url)) });
                if (!res.ok) throw new Error(`ms-ctl turn ${t}: HTTP ${res.status}`);
                return res.text();
            };
            const sendTurn = async (t: number): Promise<void> => {
                state.turn = t;
                ops.pushUser(t);
                const raw = await post(t);
                const reply = extractReply("chat", raw);
                assert.ok(reply.length > 0, `ms-ctl turn ${t}: empty reply`);
                ops.pushAssistant(t, reply);
                if (t % 2 === 0) ops.pushToolPair(t, TOOL_RESULT_OK(t));
            };
            ops.initHistory();
            let foldIdx = -1;
            let sinceFold = 0;
            for (let t = 0; t < MAX_TURNS; t++) {
                const before = trigger.calls();
                await sendTurn(t);
                if (trigger.calls() > before) { foldIdx = bodies.length - 1; sinceFold = 0; }
                else sinceFold++;
                if (foldIdx >= 0 && sinceFold >= 2) break;
            }
            assert.ok(foldIdx >= 0 && bodies[foldIdx]!.includes(SUMMARY_MARKER), "ms-ctl: fold did not fire");
            let unfoldLen = 0;
            for (let i = 0; i < foldIdx; i++) unfoldLen = Math.max(unfoldLen, Buffer.byteLength(bodies[i]!, "utf8"));
            ops.churnModelSwitch?.();
            // Scan EVERY judge body since the churn: with the layer off, the
            // unfolded replay goes out on round-1 and a fresh server-side
            // compress may then re-fold it — judging only the LAST body
            // would see the self-healed round-2 and miss the re-bill.
            const firstChurnBody = bodies.length;
            await sendTurn(MAX_TURNS + 1);
            const churnBodies = bodies.slice(firstChurnBody);
            assert.ok(churnBodies.length > 0, "ms-ctl: no body recorded after the churn");
            const lost = churnBodies.every((b) => !b.includes(SUMMARY_MARKER));
            const reBilled = churnBodies.some((b) => b.includes("file-2-row-") || b.includes("scratch-2-final") || Buffer.byteLength(b, "utf8") >= unfoldLen * 0.8);
            assert.ok(lost || reBilled, "ms-ctl failed to fail: with reconcile OFF the model-switch churn should lose the summary and/or re-bill the folded payloads — if it survives, the positive test above is not actually exercising Pass 3/4");
            console.log(`proof[chat-ms-ctl] VERDICT reconcile=off modelSwitchFoldLost=${lost} modelSwitchReBilled=${reBilled} bodiesSinceChurn=${churnBodies.length} maxLen=${Math.max(...churnBodies.map((b) => Buffer.byteLength(b, "utf8")))}B (unfolded-ref=${unfoldLen}B)`);
        } finally {
            await closeServer(proxy);
            await closeServer(upstream);
            if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
            else process.env.XDG_STATE_HOME = prevXdg;
            rmrf(tmp);
        }
    } finally {
        if (prev === undefined) delete process.env.BILI_FOLD_RECONCILE;
        else process.env.BILI_FOLD_RECONCILE = prev;
    }
});

// id-churn control, RETIRED-AND-INVERTED by #3642: this churn class used to
// re-key chat cores (tool_call ids + argument re-serialization moved the
// seeds), so with reconcile OFF the fold coverage died — the control proved
// the positive test was exercising Pass 0. Canonical core identity makes
// toolCallId a non-seed ("transport plumbing") and normalizes tool arguments
// (canonicalToolArgs: sorted keys, compact form), so this churn class is now
// absorbed BY CONSTRUCTION, upstream of reconcile. The old control "failed
// to fail" — correctly detecting that its premise is gone. Inverted, the
// test stays useful as a canary: with reconcile deliberately OFF, the churn
// must STILL retain the summary and not re-bill. If it ever goes red, someone
// reintroduced id-sensitivity into the canonical seeds (or arg normalization
// regressed) — both are #3642 contract breaks, not reconcile bugs.
test("identity proof (control, chat wire): canonical ids absorb the id churn even with reconcile OFF (#3642)", { timeout: 180_000 }, async () => {
    const prev = process.env.BILI_FOLD_RECONCILE;
    process.env.BILI_FOLD_RECONCILE = "off";
    try {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "identity-ctl-"));
        const prevXdg = process.env.XDG_STATE_HOME;
        process.env.XDG_STATE_HOME = tmp;
        const hist: Item[] = [];
        const ops = makeOps("chat", hist);
        const bodies: string[] = [];
        const trigger = makeProofTrigger(THRESHOLD, MIN_FOLD_T);
        const state: JudgeState = { wire: "chat", bodies, turn: 0, suppressTrigger: false };
        let upstream: http.Server | undefined;
        let proxy: http.Server | undefined;
        try {
            upstream = startJudgeUpstream(state, trigger);
            upstream.listen(0, "127.0.0.1");
            await listen(upstream);
            const upstreamPort = (upstream.address() as { port: number }).port;
            _setStoreForTest(new SessionStore({ enabled: false }));
            setRegistryForTest({});
            proxy = await startServer(proofProxyOptions(upstreamPort, 200_000));
            await listen(proxy);
            const proxyPort = (proxy.address() as { port: number }).port;
            const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
            const post = async (t: number): Promise<string> => {
                const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "identity-ctl" }, body: JSON.stringify(ops.payload(url)) });
                if (!res.ok) throw new Error(`ctl turn ${t}: HTTP ${res.status}`);
                return res.text();
            };
            const sendTurn = async (t: number): Promise<void> => {
                state.turn = t;
                ops.pushUser(t);
                const raw = await post(t);
                const reply = extractReply("chat", raw);
                assert.ok(reply.length > 0, `ctl turn ${t}: empty reply`);
                ops.pushAssistant(t, reply);
                if (t % 2 === 0) ops.pushToolPair(t, TOOL_RESULT_OK(t));
            };
            ops.initHistory();
            let foldIdx = -1;
            let sinceFold = 0;
            for (let t = 0; t < MAX_TURNS; t++) {
                const before = trigger.calls();
                await sendTurn(t);
                if (trigger.calls() > before) { foldIdx = bodies.length - 1; sinceFold = 0; }
                else sinceFold++;
                if (foldIdx >= 0 && sinceFold >= 2) break;
            }
            assert.ok(foldIdx >= 0 && bodies[foldIdx]!.includes(SUMMARY_MARKER), "ctl: fold did not fire");
            let unfoldLen = 0;
            for (let i = 0; i < foldIdx; i++) unfoldLen = Math.max(unfoldLen, Buffer.byteLength(bodies[i]!, "utf8"));
            ops.churnIds();
            await sendTurn(MAX_TURNS + 1);
            const switchBody = bodies[bodies.length - 1]!;
            const retained = switchBody.includes(SUMMARY_MARKER);
            const reBilled = switchBody.includes("file-2-row-") || Buffer.byteLength(switchBody, "utf8") >= unfoldLen * 0.8;
            assert.ok(retained && !reBilled, "ctl-absorb: with reconcile OFF the id churn (tool_call id rewrite + arg re-serialization) must NOT disturb fold coverage — canonical ids absorb it by construction (#3642). If this fails, id-sensitivity leaked back into the canonical seeds or canonicalToolArgs normalization regressed");
            console.log(`proof[chat-ctl-absorb] VERDICT reconcile=off churnAbsorbed=true summaryRetained=${retained} reBilled=${reBilled} len=${Buffer.byteLength(switchBody, "utf8")}B (unfolded-ref=${unfoldLen}B) sha=${sha16(switchBody)}`);
        } finally {
            await closeServer(proxy);
            await closeServer(upstream);
            if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
            else process.env.XDG_STATE_HOME = prevXdg;
            rmrf(tmp);
        }
    } finally {
        if (prev === undefined) delete process.env.BILI_FOLD_RECONCILE;
        else process.env.BILI_FOLD_RECONCILE = prev;
    }
});

// Cross-wire client swap: fold on the anthropic wire, then the SAME session
// continues on the chat wire with the history re-encoded and every id
// re-minted during the conversion (a different client would re-issue its own
// tool-call ids). Coverage must survive the swap.
test("identity proof (cross-wire swap anthropic -> chat): coverage survives a client swap (#2480)", { timeout: 240_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "identity-xwire-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmp;
    delete process.env.ACP_DUMP_BODY;
    const anthropicHist: Item[] = [];
    const aOps = makeOps("anthropic", anthropicHist);
    const chatBodies: string[] = [];
    const trigger = makeProofTrigger(THRESHOLD, MIN_FOLD_T);
    const aState: JudgeState = { wire: "anthropic", bodies: [], turn: 0, suppressTrigger: false };
    const cState: JudgeState = { wire: "chat", bodies: chatBodies, turn: 0, suppressTrigger: true };
    let upstreamA: http.Server | undefined;
    let upstreamC: http.Server | undefined;
    let proxy: http.Server | undefined;
    try {
        upstreamA = startJudgeUpstream(aState, trigger);
        upstreamA.listen(0, "127.0.0.1");
        await listen(upstreamA);
        upstreamC = startJudgeUpstream(cState, trigger);
        upstreamC.listen(0, "127.0.0.1");
        await listen(upstreamC);
        const portA = (upstreamA.address() as { port: number }).port;
        const portC = (upstreamC.address() as { port: number }).port;
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const opts = proofProxyOptions(portA, 400_000);
        opts.routes = {
            [`http://127.0.0.1:${portA}`]: { models: { [MODEL_A]: { context: 400_000 } } },
            [`http://127.0.0.1:${portC}`]: { models: { [MODEL_A]: { context: 400_000 } } },
        };
        proxy = await startServer(opts);
        await listen(proxy);
        const proxyPort = (proxy.address() as { port: number }).port;
        const baseA = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${portA}`;
        const baseC = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${portC}`;
        const urlA = urlForWire("anthropic", baseA);
        const urlC = urlForWire("chat", baseC);
        const post = async (url: string, payload: Item, t: number, tag: string): Promise<string> => {
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "identity-xwire" }, body: JSON.stringify(payload) });
            if (!res.ok) throw new Error(`${tag} turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
            return res.text();
        };
        // Phase A: grow on anthropic until the fold settles.
        const sendA = async (t: number): Promise<void> => {
            aState.turn = t;
            aOps.pushUser(t);
            const raw = await post(urlA, aOps.payload(urlA) as Item, t, "anthropic");
            const reply = extractReply("anthropic", raw);
            assert.ok(reply.length > 0, `xwire anthropic turn ${t}: empty reply`);
            aOps.pushAssistant(t, reply);
            if (t % 2 === 0) aOps.pushToolPair(t, TOOL_RESULT_OK(t));
        };
        aOps.initHistory();
        let foldIdx = -1;
        let sinceFold = 0;
        for (let t = 0; t < MAX_TURNS; t++) {
            const before = trigger.calls();
            await sendA(t);
            if (trigger.calls() > before) { foldIdx = aState.bodies.length - 1; sinceFold = 0; }
            else sinceFold++;
            if (foldIdx >= 0 && sinceFold >= 2) break;
        }
        assert.ok(foldIdx >= 0 && aState.bodies[foldIdx]!.includes(SUMMARY_MARKER), "xwire: fold did not fire on the anthropic lane");
        let unfoldLen = 0;
        for (let i = 0; i < foldIdx; i++) unfoldLen = Math.max(unfoldLen, Buffer.byteLength(aState.bodies[i]!, "utf8"));

        // Phase X: re-encode the SAME logical history for the chat wire.
        // Tool ids are re-minted (alt_*) during conversion — the new client
        // issues its own id scheme; prose is copied verbatim.
        const chatHist: Item[] = [{ role: "system", content: "You are a coding agent operating in a sandbox. Follow repo conventions strictly." }];
        for (const m of anthropicHist) {
            if (m.role === "user" && typeof m.content === "string") chatHist.push({ role: "user", content: m.content });
            else if (m.role === "assistant" && Array.isArray(m.content)) {
                const blocks = asArr(m.content);
                const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
                const tu = blocks.find((b) => b.type === "tool_use") as { id?: string; name?: string; input?: Record<string, unknown> } | undefined;
                if (tu !== undefined && tu.id !== undefined) {
                    // A real client keeps the assistant prose alongside the
                    // re-minted tool call (chat allows content + tool_calls in
                    // one message). Dropping the text here would structurally
                    // DELETE a message — exactly what Pass 0 must refuse to
                    // bridge, so the swap would honestly fail instead of
                    // proving the identity layer.
                    chatHist.push({ role: "assistant", content: text.length > 0 ? text : null, tool_calls: [{ id: `alt_${tu.id}`, type: "function", function: { name: String(tu.name ?? "shell"), arguments: " { " + Object.entries(tu.input ?? {}).reverse().map(([k, v]) => `${JSON.stringify(k)} : ${JSON.stringify(v)}`).join(" , ") + " } " } }] });
                } else if (text.length > 0) chatHist.push({ role: "assistant", content: text });
            } else if (m.role === "user" && Array.isArray(m.content)) {
                for (const b of asArr(m.content)) {
                    if (b.type === "tool_result" && typeof b.tool_use_id === "string") chatHist.push({ role: "tool", tool_call_id: `alt_${b.tool_use_id}`, content: String(b.content ?? "") });
                }
            }
        }
        const cOps = makeOps("chat", chatHist);
        cOps.initHistory = () => undefined; // system message already present
        const sendC = async (t: number): Promise<void> => {
            cState.turn = t;
            cOps.pushUser(t);
            const raw = await post(urlC, cOps.payload(urlC), t, "chat");
            const reply = extractReply("chat", raw);
            assert.ok(reply.length > 0, `xwire chat turn ${t}: empty reply`);
            cOps.pushAssistant(t, reply);
            if (t % 2 === 0) cOps.pushToolPair(t, TOOL_RESULT_OK(t));
        };
        await sendC(MAX_TURNS + 1);
        const swapBody = chatBodies[chatBodies.length - 1]!;
        assert.ok(swapBody.includes(SUMMARY_MARKER), "xwire SWAP: summary carrier lost across the client swap — coverage did not survive the protocol change");
        assert.ok(!swapBody.includes("file-2-row-"), "xwire SWAP: a covered tool result re-entered the wire — the fold span was re-billed across the swap");
        assert.ok(Buffer.byteLength(swapBody, "utf8") < unfoldLen, `xwire SWAP: post-swap body ${Buffer.byteLength(swapBody, "utf8")}B at unfolded magnitude (ref ${unfoldLen}B)`);
        console.log(`proof[xwire] SWAP ok anthropic->chat retained-fold len=${Buffer.byteLength(swapBody, "utf8")}B (unfolded-ref=${unfoldLen}B) sha=${sha16(swapBody)}`);
        await sendC(MAX_TURNS + 2);
        const after = chatBodies[chatBodies.length - 1]!;
        assert.ok(after.includes(SUMMARY_MARKER), "xwire: post-swap growth lost the summary");
        assert.ok(!after.includes("file-2-row-"), "xwire: post-swap growth re-billed a covered tool result");
        console.log(`proof[xwire] VERDICT swapRetained=1 growthAfterSwapFolded=1 misattributions=0`);
    } finally {
        await closeServer(proxy);
        await closeServer(upstreamA);
        await closeServer(upstreamC);
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(tmp);
    }
});
