// Cache-friendliness matrix for PROXY mode, one subtest per wire
// (responses / openai chat / anthropic / google). Follow-up to #1548 (post-fold
// cache collapse on the codex/responses path): the owner asked for a guarantee
// that EVERY proxy-mode situation stays cache-friendly, not just the reported
// one. The fold/strip core is shared (refreshFolded), but each wire serializes
// through its own patch layer, so any single wire can regress independently.
//
// Invariants pinned per wire (bodies = consecutive upstream-bound request
// payloads of one session, normalized to a comparable element list):
//   G. plain-growth turns are APPEND-stable: the longest common element prefix
//      reaches within the trailing volatile slots (chain checkpoint / nudge /
//      imgNote, ≤ 3) of the previous body — nothing mid-history may mutate;
//   F. fold transitions (proxy executes the compress call):
//        F1 the round-2 re-request CONTAINS the in-place acp_summary at the
//            fold anchor (the #1548 regression — the ephemeral acp_loop_* tool
//            pair must not make stripKernelSummaries drop the cross-turn carrier);
//        F2 the pre-fold head (everything before the anchor) survives the fold
//            byte-identical — folding must not rewrite earlier history;
//        F3 the next client turn is byte-identical to round-2 through the
//            summary anchor — the upstream longest-prefix match extends past
//            the fold, not just to the stable head;
//   M. at least TWO folds occur, so multi-fold sessions are covered.
//
// Scope notes: tool protocol only (the default; the marker/text protocol has no
// tool carrier and a different emission path — tracked separately). Plugin mode
// (agent-owned compress calls riding inbound history) has its own invariant set
// and is tracked in a dedicated issue. Streaming responses only; request-byte
// stability is independent of the response format.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

type Item = Record<string, unknown>;
type Wire = "responses" | "chat" | "anthropic" | "google";

const SUMMARY_MARKER = "[Compressed conversation section]";
const CHAIN_MARKER = "bili-chain";
const THRESHOLD = 40 * 1024;
const MAX_TURNS = 20;
const TAIL_VOLATILE_SLOTS = 3;

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the build pipeline ran cleanly and the integration suite reported no regressions across all four regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

const asArr = (x: unknown): Item[] => (Array.isArray(x) ? (x as Item[]) : []);
const asRec = (x: unknown): Item | undefined => (x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Item) : undefined);

const isChainEl = (el: unknown): boolean => JSON.stringify(el ?? "").includes(CHAIN_MARKER);
const eqEl = (a: unknown, b: unknown): boolean => (a === undefined || b === undefined ? a === b : JSON.stringify(a) === JSON.stringify(b) || (isChainEl(a) && isChainEl(b)));

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

/** Normalized comparable element list for one outbound body, per wire. */
function normOf(wire: Wire, p: Item): unknown[] {
    // The tools array is part of the upstream prefix too (it is hashed into
    // the cached prefix by every provider): a per-turn tool-list mutation
    // breaks the cache at element 0. Pin it by placing it FIRST in the
    // comparable element list.
    const tools = p.tools ?? null;
    switch (wire) {
        case "responses": return [tools, ...asArr(p.input)];
        case "chat": return [tools, ...asArr(p.messages)];
        case "anthropic": return [tools, p.system ?? null, ...asArr(p.messages)];
        case "google": return [tools, p.systemInstruction ?? null, ...asArr(p.contents)];
    }
}

/** True when the body carries a compress CALL (the round-2 re-request marker). */
function isRound2Body(wire: Wire, p: Item): boolean {
    switch (wire) {
        case "responses":
            return asArr(p.input).some((it) => it.type === "function_call" && it.name === "compress");
        case "chat":
            return asArr(p.messages).some((m) => asArr(m.tool_calls).some((tc) => asRec(tc.function)?.name === "compress"));
        case "anthropic":
            return asArr(p.messages).flatMap((m) => (typeof m.content === "string" ? [] : asArr(m.content))).some((b) => b.type === "tool_use" && b.name === "compress");
        case "google":
            return asArr(p.contents).flatMap((c) => asArr(c.parts)).some((pt) => asRec(pt.functionCall)?.name === "compress");
    }
}

/** Summary OCCURRENCES in the normalized body. Per occurrence, not per element:
 *  coreToAnthropic/coreToGoogle merge same-role runs into one element under
 *  strict role alternation, so one element may legally carry several summaries. */
function countSummaries(list: unknown[]): number {
    let n = 0;
    for (const el of list) n += JSON.stringify(el ?? "").split(SUMMARY_MARKER).length - 1;
    return n;
}

function firstSummaryIdx(list: unknown[]): number {
    for (let i = 0; i < list.length; i++) if (JSON.stringify(list[i] ?? "").includes(SUMMARY_MARKER)) return i;
    return -1;
}

function lastSummaryIdx(list: unknown[]): number {
    for (let i = list.length - 1; i >= 0; i--) if (JSON.stringify(list[i] ?? "").includes(SUMMARY_MARKER)) return i;
    return -1;
}

function lcpTolerant(a: unknown[], b: unknown[]): number {
    let k = 0;
    const n = Math.min(a.length, b.length);
    while (k < n && eqEl(a[k], b[k])) k++;
    return k;
}

function checkGrowthStable(prev: unknown[], cur: unknown[], label: string): void {
    const prevSolid = prev.length - (isChainEl(prev[prev.length - 1]) ? 1 : 0);
    assert.ok(cur.length >= prevSolid - 2, `${label}: body shrank unexpectedly (${prev.length} -> ${cur.length}) without a fold`);
    const k = lcpTolerant(prev, cur);
    assert.ok(
        k >= prevSolid - TAIL_VOLATILE_SLOTS,
        `${label}: cache-hostile mutation at element[${k}] of ${prev.length} — during plain growth only the trailing volatile slots (chain/nudge/imgNote, <=${TAIL_VOLATILE_SLOTS}) may differ`,
    );
}

function checkFoldTransition(pre: unknown[], r2: unknown[], next: unknown[], label: string): void {
    // F1: the fold materialized — round-2 carries exactly one more summary
    // occurrence than the trigger turn; the ephemeral tool pair must not make
    // stripKernelSummaries drop the cross-turn carrier.
    assert.equal(countSummaries(r2), countSummaries(pre) + 1, `${label}: REGRESSION(#1548): round-2 must carry ${countSummaries(pre) + 1} summary occurrence(s), got ${countSummaries(r2)}`);
    // F2: pre-fold head stability — everything strictly before the first
    // summary element is byte-identical between the trigger turn and round-2.
    // (Earlier summaries ride inside their elements and are covered byte-wise
    // by this comparison wherever they sit before the newest one.)
    const firstIdx = firstSummaryIdx(r2);
    for (let i = 0; i < firstIdx; i++) {
        assert.ok(eqEl(pre[i], r2[i]), `${label}: fold mutated pre-summary head element[${i}] — upstream cache match collapses at element[${i}]`);
    }
    // F3: the byte prefix extends PAST the fold point — everything through the
    // LAST summary element is byte-identical between round-2 and the next
    // client turn, no summary lost, and the next turn appends past the anchor.
    const lastIdx = lastSummaryIdx(r2);
    for (let i = 0; i <= lastIdx; i++) {
        assert.ok(eqEl(r2[i], next[i]), `${label}: REGRESSION(#1548): round-2 and next turn diverge at element[${i}] (last summary anchor [${lastIdx}]) — upstream cache match collapses to the stable head`);
    }
    assert.equal(countSummaries(next), countSummaries(r2), `${label}: next client turn lost or gained a summary (${countSummaries(r2)} -> ${countSummaries(next)})`);
    assert.ok(next.length > lastSummaryIdx(next) + 1, `${label}: next turn must append new content after the anchor`);
}

function runChecks(wire: Wire, bodies: string[]): void {
    const lists = bodies.map((b) => normOf(wire, JSON.parse(b) as Item));
    const r2All = lists.map((_, i) => i).filter((i) => isRound2Body(wire, JSON.parse(bodies[i]!) as Item));
    const r2Idxs = r2All.filter((i) => i > 0 && !r2All.includes(i - 1));
    assert.ok(r2Idxs.length >= 2, `${wire}: expected >= 2 compress cycles, got ${r2All.length} (multi-fold coverage)`);
    const r2set = new Set(r2Idxs);
    for (let i = 1; i < lists.length; i++) {
        if (r2set.has(i) || r2set.has(i - 1)) continue;
        checkGrowthStable(lists[i - 1]!, lists[i]!, `${wire} req#${i - 1}->req#${i}`);
    }
    for (const i of r2Idxs) {
        checkFoldTransition(lists[i - 1]!, lists[i]!, lists[i + 1]!, `${wire} fold@req#${i}`);
    }
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

/** Shared fold trigger: demand compression once the payload is big enough and
 *  refs are plentiful, throttled so consecutive demands cannot stack. */
function makeCompressTrigger(threshold: number, plan?: Array<number | undefined>, gapless?: boolean): { calls: () => number; should: (body: string) => boolean; args: (refs: string[]) => string } {
    let lastDemandBytes = Infinity;
    let sinceDemand = 99;
    let calls = 0;
    let firstViewRefs: string[] | undefined;
    return {
        calls: () => calls,
        should(body: string): boolean {
            const bytes = Buffer.byteLength(body);
            const refs = parseRefIds(body);
            if (firstViewRefs === undefined && refs.length >= 12) firstViewRefs = refs;
            const noShrinkAfterDemand = !gapless && sinceDemand <= 2 && bytes >= lastDemandBytes * 0.9;
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
            const planned = plan?.[calls - 1];
            const view = firstViewRefs ?? refs;
            // planned number: index into the PRE-FOLD view -> swallowing ranges
            // (superset / partial overlap); default: tail range of current view.
            const start = typeof planned === "number" ? (view[planned] ?? refs[2]!) : refs[2]!;
            const end = refs[refs.length - 6]!;
            return JSON.stringify({
                content: [{
                    startId: start,
                    endId: end,
                    topic: "cf fold",
                    summary: `Cache-friendly fold summary covering ${start}..${end}: turns exercised the pipeline, builds stayed green, measurements recorded at each checkpoint.`,
                }],
            });
        },
    };
}

function replyLabel(body: string): string {
    const re = /Turn (\d+):/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) { /* keep last */ }
    return m ? m[1]! : "0";
}

function startUpstream(wire: Wire, captured: string[], trigger: ReturnType<typeof makeCompressTrigger>): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push(body);
            const idx = captured.length;
            const label = replyLabel(body);
            const reply = `Reply Turn ${label}: done. ` + FILLER(Number(label), 0.2);
            const compressArgs = trigger.should(body) ? trigger.args(parseRefIds(body)) : undefined;
            switch (wire) {
                case "responses": {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                    const blk = (type: string, data: Record<string, unknown>): void => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
                    if (compressArgs !== undefined) {
                        blk("response.created", { response: { id: `resp_${idx}`, status: "in_progress" } });
                        blk("response.output_item.added", { output_index: 0, item: { type: "function_call", id: `fc_${idx}`, call_id: `call_cmp_${idx}`, name: "compress", arguments: "", status: "in_progress" } });
                        blk("response.function_call_arguments.delta", { item_id: `fc_${idx}`, output_index: 0, delta: compressArgs });
                        blk("response.function_call_arguments.done", { item_id: `fc_${idx}`, output_index: 0, arguments: compressArgs });
                        blk("response.output_item.done", { output_index: 0, item: { type: "function_call", id: `fc_${idx}`, call_id: `call_cmp_${idx}`, name: "compress", arguments: compressArgs, status: "completed" } });
                        blk("response.completed", { response: { id: `resp_${idx}`, status: "completed", output: [{ type: "function_call", id: `fc_${idx}`, call_id: `call_cmp_${idx}`, name: "compress", arguments: compressArgs, status: "completed" }] } });
                    } else {
                        blk("response.created", { response: { id: `resp_${idx}`, status: "in_progress" } });
                        blk("response.output_item.added", { output_index: 0, item: { type: "message", id: `msg_${idx}`, role: "assistant", status: "in_progress", content: [] } });
                        blk("response.output_text.delta", { item_id: `msg_${idx}`, output_index: 0, content_index: 0, delta: reply });
                        blk("response.output_text.done", { item_id: `msg_${idx}`, output_index: 0, text: reply });
                        blk("response.output_item.done", { output_index: 0, item: { type: "message", id: `msg_${idx}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply }] } });
                        blk("response.completed", { response: { id: `resp_${idx}`, status: "completed", output: [{ type: "message", id: `msg_${idx}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply }] }] } });
                    }
                    res.end();
                    return;
                }
                case "chat": {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                    const line = (o: unknown): void => res.write(`data: ${JSON.stringify(o)}\n\n`);
                    if (compressArgs !== undefined) {
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_cmp_${idx}`, type: "function", function: { name: "compress", arguments: compressArgs } }] } }] });
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 2 } });
                    } else {
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply } }] });
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
                    }
                    res.write("data: [DONE]\n\n");
                    res.end();
                    return;
                }
                case "anthropic": {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                    const ev = (event: string, data: unknown): void => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                    ev("message_start", { type: "message_start", message: { id: `msg_a_${idx}`, role: "assistant", usage: { input_tokens: 100 } } });
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
                        res.write(`data: ${JSON.stringify({ candidates: [candidate], modelVersion: "gemini-test", usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 0, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 1050 } })}\n\n`);
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

function proxyOptions(upstreamPort: number, model: string, ctx: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [model]: { context: ctx } } } },
        modelContextLimit: ctx,
        kernelConfig: defaultConfig(ctx),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
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

/** Drives a growing conversation on one wire until >= 2 folds happened and at
 *  least 3 plain turns followed the last fold. Returns the captured upstream
 *  bodies in arrival order. */
async function driveWire(wire: Wire, sessionId: string, model: string, ctx: number, opts?: { plan?: Array<number | undefined>; gapless?: boolean }): Promise<string[]> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cf-${wire}-`));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmp;
    delete process.env.ACP_DUMP_BODY;
    const captured: string[] = [];
    const trigger = makeCompressTrigger(THRESHOLD, opts?.plan, opts?.gapless);
    let upstream: http.Server | undefined;
    let proxy: http.Server | undefined;
    try {
        upstream = startUpstream(wire, captured, trigger);
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        proxy = await startServer(proxyOptions(upstreamPort, model, ctx));
        await listen(proxy);
        const proxyPort = (proxy.address() as { port: number }).port;
        const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
        const url =
            wire === "responses" ? `${base}/v1/responses`
            : wire === "chat" ? `${base}/v1/chat/completions`
            : wire === "anthropic" ? `${base}/v1/messages`
            : `${base}/v1beta/models/${model}:streamGenerateContent?alt=sse`;

        const hist: Item[] = [];
        const sendTurn = async (t: number): Promise<void> => {
            if (wire === "responses") {
                hist.push({ type: "message", role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) });
                const body: Item = {
                    model,
                    stream: true,
                    instructions: "You are a coding agent operating in a sandbox.\nFollow repo conventions strictly.\nRun tests before finishing.\nEnvironment notes: linux, node 22, repo at /workspace.",
                    tools: [{ type: "function", name: "shell", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
                    input: [...hist],
                };
                const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify(body) });
                if (!res.ok) throw new Error(`${wire} turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
                const reply = extractReply(wire, await res.text());
                assert.ok(reply.length > 0, `${wire} turn ${t}: empty reply`);
                hist.push({ type: "reasoning", id: `rs_${t}`, encrypted_content: `enc_${t}_` + "x".repeat(200) });
                hist.push({ type: "message", id: `msg_a${t}`, role: "assistant", content: reply });
                if (t % 2 === 0) {
                    hist.push({ type: "function_call", id: `fc_t${t}`, call_id: `call_t${t}`, name: "shell", arguments: JSON.stringify({ command: `ls -la mod-${t}` }), status: "completed" });
                    hist.push({ type: "function_call_output", id: `fco_t${t}`, call_id: `call_t${t}`, output: `total 8\n-rw-r--r-- 1 u g 42 Sep 27 10:00 file-${t}.ts` });
                }
            } else if (wire === "chat") {
                if (hist.length === 0) hist.push({ role: "system", content: "You are a coding agent operating in a sandbox. Follow repo conventions strictly." });
                hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) });
                const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify({ model, stream: true, messages: [...hist] }) });
                if (!res.ok) throw new Error(`${wire} turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
                const reply = extractReply(wire, await res.text());
                assert.ok(reply.length > 0, `${wire} turn ${t}: empty reply`);
                hist.push({ role: "assistant", content: reply });
                if (t % 2 === 0) {
                    hist.push({ role: "assistant", content: null, tool_calls: [{ id: `call_t${t}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: `ls -la mod-${t}` }) } }] });
                    hist.push({ role: "tool", tool_call_id: `call_t${t}`, content: `total 8\n-rw-r--r-- 1 u g 42 Sep 27 10:00 file-${t}.ts` });
                }
            } else if (wire === "anthropic") {
                hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) });
                const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify({ model, max_tokens: 1024, stream: true, system: "You are a test assistant.", messages: [...hist] }) });
                if (!res.ok) throw new Error(`${wire} turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
                const reply = extractReply(wire, await res.text());
                assert.ok(reply.length > 0, `${wire} turn ${t}: empty reply`);
                hist.push({ role: "assistant", content: reply });
                if (t % 2 === 0) {
                    hist.push({ role: "assistant", content: [{ type: "text", text: "running a check" }, { type: "tool_use", id: `tu_${t}`, name: "shell", input: { command: `ls -la mod-${t}` } }] });
                    hist.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${t}`, content: `total 8\n-rw-r--r-- 1 u g 42 Sep 27 10:00 file-${t}.ts` }] });
                }
            } else {
                hist.push({ role: "user", parts: [{ text: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) }] });
                const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify({ contents: [...hist], systemInstruction: { parts: [{ text: "you are a test assistant" }] }, generationConfig: { maxOutputTokens: 4096 } }) });
                if (!res.ok) throw new Error(`${wire} turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
                const reply = extractReply(wire, await res.text());
                assert.ok(reply.length > 0, `${wire} turn ${t}: empty reply`);
                hist.push({ role: "model", parts: [{ text: reply }] });
                if (t % 2 === 0) {
                    hist.push({ role: "model", parts: [{ functionCall: { id: `fcg_${t}`, name: "shell", args: { command: `ls -la mod-${t}` } } }] });
                    hist.push({ role: "user", parts: [{ functionResponse: { name: "shell", response: { result: `total 8\n-rw-r--r-- 1 u g 42 Sep 27 10:00 file-${t}.ts` } } }] });
                }
            }
        };
        let sinceFold = 0;
        for (let t = 0; t < MAX_TURNS; t++) {
            const before = trigger.calls();
            await sendTurn(t);
            if (trigger.calls() > before) sinceFold = 0;
            else sinceFold++;
            if (trigger.calls() >= 2 && sinceFold >= 3) break;
        }
        // The next-turn pinning needs a NORMAL body after every captured fold;
        // if MAX_TURNS exhausted right on a round-2 re-request, send more turns.
        let guard = 0;
        while (captured.length > 0 && isRound2Body(wire, JSON.parse(captured[captured.length - 1]!) as Item) && guard < 3) {
            await sendTurn(MAX_TURNS + guard);
            guard++;
        }
        if (process.env.CF_DUMP) {
            fs.mkdirSync(process.env.CF_DUMP, { recursive: true });
            for (let i = 0; i < captured.length; i++) {
                fs.writeFileSync(path.join(process.env.CF_DUMP, `${wire}-${String(i).padStart(3, "0")}.json`), captured[i]!);
            }
        }
        return captured;
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(tmp);
    }
}

test("cache-friendly proxy (responses wire): growth append-stable, folds keep the anchored summary", { timeout: 120_000 }, async () => {
    const bodies = await driveWire("responses", "cf-responses", "gpt-test", 200_000);
    assert.ok(bodies.length >= 10, `expected a substantial request stream, got ${bodies.length}`);
    runChecks("responses", bodies);
});

test("cache-friendly proxy (openai chat wire): growth append-stable, folds keep the anchored summary", { timeout: 120_000 }, async () => {
    const bodies = await driveWire("chat", "cf-chat", "gpt-test", 200_000);
    assert.ok(bodies.length >= 10, `expected a substantial request stream, got ${bodies.length}`);
    runChecks("chat", bodies);
});

test("cache-friendly proxy (anthropic wire): growth append-stable, folds keep the anchored summary", { timeout: 120_000 }, async () => {
    const bodies = await driveWire("anthropic", "cf-anthropic", "claude-test", 400_000);
    assert.ok(bodies.length >= 10, `expected a substantial request stream, got ${bodies.length}`);
    runChecks("anthropic", bodies);
});

test("cache-friendly proxy (google wire): growth append-stable, folds keep the anchored summary", { timeout: 120_000 }, async () => {
    const bodies = await driveWire("google", "cf-google", "gemini-test", 1_000_000);
    assert.ok(bodies.length >= 10, `expected a substantial request stream, got ${bodies.length}`);
    runChecks("google", bodies);
});

// Fifth geometry, anthropic wire: SWALLOWING folds — range geometries the
// per-wire matrix never produces (its demands always take the current view's
// tail). Production models routinely compress "from the beginning", citing
// refs covered by earlier folds. Three shapes pinned:
//   S1 superset swallow  — fold 2 covers fold 1 entirely: the OLD summary is
//      replaced by the NEW wide one (the feared "second fold loses the new
//      summary" must not happen; the new carrier must be on the wire);
//   S2 partial overlap   — fold 3 starts INSIDE fold 2's region: both coexist;
//   S3 back-to-back tails — every later summary survives every later round-2
//      and normal turn (monotone accumulation, zero drops).
test("cache-friendly proxy (anthropic swallow/back-to-back): superset replaces, partial coexists, tails never drop", { timeout: 120_000 }, async () => {
    // plan: demand1 = tail; demand2 = view[2] (superset swallow of fold 1);
    // demand3 = view[5] (partial overlap inside fold 2); demands 4+ = tails,
    // gapless so they fire back-to-back while prior tool pairs still ride the
    // resent history.
    const bodies = await driveWire("anthropic", "cf-swallow-anth", "claude-swallow-1", 40 * 1024, { plan: [undefined, 2, 5], gapless: true });
    const lists = bodies.map((b) => normOf("anthropic", JSON.parse(b) as Item));
    const r2All = bodies.map((b, i) => i).filter((i) => isRound2Body("anthropic", JSON.parse(bodies[i]!) as Item));
    const r2Idxs = r2All.filter((i) => i > 0 && !r2All.includes(i - 1));
    assert.ok(r2Idxs.length >= 4, `expected >= 4 folds (got ${r2Idxs.length})`);
    const rangesAt = (i: number): string[] => {
        const found: string[] = [];
        const text = JSON.stringify(lists[i]);
        const re = /Cache-friendly fold summary covering (m\d+)\.\.(m\d+)/g;
        let m2: RegExpExecArray | null;
        while ((m2 = re.exec(text)) !== null) if (!found.includes(`${m2[1]}..${m2[2]}`)) found.push(`${m2[1]}..${m2[2]}`);
        return found;
    };
    // S1: after the superset swallow (fold 2), the next normal body carries
    // exactly the NEW wide summary — old replaced, new present.
    const afterS1 = rangesAt(r2Idxs[1]! + 1);
    assert.equal(afterS1.length, 1, `S1: expected exactly the new superset summary, got ${JSON.stringify(afterS1)}`);
    assert.ok(!afterS1.includes(rangesAt(r2Idxs[0]! + 1)[0]!), "S1: fold-1 summary must be superseded");
    // S2: after the partial overlap (fold 3), both fold-2's and fold-3's coexist.
    const afterS2 = rangesAt(r2Idxs[2]! + 1);
    assert.equal(afterS2.length, 2, `S2: expected coexistence, got ${JSON.stringify(afterS2)}`);
    // S3: every summary present before fold N is still present after it —
    // nothing is ever dropped by later folds. (Skip the tail fold when the
    // run ended on its round-2: there is no post-fold body to inspect yet.)
    for (let k = 3; k < r2Idxs.length; k++) {
        if (r2Idxs[k]! + 1 >= bodies.length) continue;
        const before = rangesAt(r2Idxs[k]! - 1);
        const after = rangesAt(r2Idxs[k]! + 1);
        for (const r of before) assert.ok(after.includes(r), `S3: summary ${r} dropped by fold #${k + 1}`);
    }
});
