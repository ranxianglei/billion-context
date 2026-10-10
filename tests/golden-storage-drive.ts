// Shared driver for the storage-render goldens (S1, pre-refactor pin set).
// Drives a FIXED scripted conversation through the real proxy against a
// deterministic judge upstream on one wire, records per-turn sha256 of the
// OUTBOUND body (canonicalized: volatile minted ids → placeholder) and a
// digest of the final persisted session (canonicalized: timestamps/uuids →
// placeholders). The committed snapshot under tests/golden/storage-render/ is
// the render contract; any drift in what the proxy puts on the wire — or in
// what the storage layer ends up persisting — turns the golden red.
//
// Import graph note: this module is imported by BOTH the test and the
// regen script (scripts/update-storage-render-goldens.ts) so the two can
// never disagree about how the corpus is produced.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { canonicalize, sha256 } from "./golden-canonical.ts";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { flushAllSessions, _resetSessionsForTest } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

export type Wire = "responses" | "chat" | "anthropic" | "google";
export const WIRES: Wire[] = ["chat", "anthropic", "responses", "google"];

// Plain-JSON on-disk sessions (BILIZSTD1 would still load, but the golden
// digests must not depend on codec defaults flipping).
process.env.BILI_PERSIST_ZSTD = "0";

const MODEL_A = "gpt-golden-a";
const THRESHOLD = 40 * 1024; // fold once the body crosses this
const MIN_FOLD_T = 8;
const SETTLE_TURNS = 2;
const GROW_TURNS = 20; // hard cap for the grow loop
const SUMMARY_MARKER = "[Compressed conversation section]";
const EDIT_SENTINEL = "GOLDEN-EDIT-SENTINEL";

export interface GoldenTurn { i: number; sha: string; bytes: number }
export interface GoldenRecord {
    wire: Wire;
    turns: GoldenTurn[];
    foldAt: number;        // judge-side body index where compress was issued
    editedAt: number;      // body index after the mid-history edit
    summaryFrom: number;   // first body index carrying the fold summary
    stateDigest: string;   // sha256 of the canonicalized persisted session
    stateShape: {          // human-readable facts baked into the snapshot
        refs: number;
        blocks: number;
        activeBlocks: number;
        deadRefs: number;
        blockContents: number;
        coveredRefSample: string[]; // effectiveMessageIds of block 1 (first 8)
    };
}

type Item = Record<string, unknown>;

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

/** Deterministic bulk: tool results carry per-turn unique row markers so
 *  "the covered original left the wire" is a binary assertion. */
const TOOL_RESULT_OK = (t: number): string =>
    `total 8\n` + Array.from({ length: 48 }, (_, i) => `-rw-r--r-- 1 u g 4096 Sep 27 10:0${i % 10} file-${t}-row-${i}.ts`).join("\n") + `\n# tail: module ${t} inspected\n`;

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the build pipeline ran cleanly and the integration suite reported no regressions across all four regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

/** Volatile ids minted onto the wire (Date.now-based or content-hash) become
 *  placeholders so the hash pins STRUCTURE+CONTENT, not wall-clock time. */
export function canonicalBody(body: string): string {
    return body
        .replace(/msg-proxy-\d+(?:-\d+)?/g, "msg-proxy-<MINT>")
        .replace(/marker-\d+(?:-\d+)?/g, "marker-<MINT>")
        .replace(/msg-fix-[0-9a-f]+/g, "msg-fix-<MINT>");
}

/** Timestamps (ms-epoch magnitude) and UUIDs become placeholders; everything
 *  else — refs, block ids, coverage sets, stats — must be byte-stable. */
// canonicalize/sha256 live in ./golden-canonical.ts (shared with the storage-corpus pins).

// ---------------------------------------------------------------------------
// Deterministic judge upstream (per-wire SSE framing lifted from the
// identity-proof harness; replies are pure functions of turn number).
// ---------------------------------------------------------------------------

interface JudgeState { wire: Wire; bodies: string[]; turn: number }

function startJudgeUpstream(state: JudgeState, shouldFold: (body: string, turn: number, calls: number) => boolean, foldArgs: (refs: string[]) => string): http.Server {
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
            const compressArgs = shouldFold(body, state.turn, 0) ? foldArgs(parseRefIds(body)) : undefined;
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

// ---------------------------------------------------------------------------
// Client-side wire ops (fixed script).
// ---------------------------------------------------------------------------

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

interface WireOps {
    initHistory: () => void;
    pushUser: (t: number) => void;
    pushAssistant: (t: number, reply: string) => void;
    pushToolPair: (t: number, result: string) => void;
    editMidHistory: () => void;
    payload: (url: string) => Item;
}

function makeOps(wire: Wire, hist: Item[]): WireOps {
    const SHELL_ARGS = (t: number): string => JSON.stringify({ command: `ls -la mod-${t}`, cwd: `/ws/${t}` });
    switch (wire) {
        case "responses":
            return {
                initHistory: () => undefined,
                pushUser: (t) => { hist.push({ type: "message", role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 5) }); },
                pushAssistant: (t, reply) => {
                    hist.push({ type: "reasoning", id: `rs_${t}`, encrypted_content: `enc_${t}_` + "x".repeat(200) });
                    hist.push({ type: "message", id: `msg_a${t}`, role: "assistant", content: reply });
                },
                pushToolPair: (t, result) => {
                    hist.push({ type: "function_call", id: `fc_t${t}`, call_id: `call_t${t}`, name: "shell", arguments: SHELL_ARGS(t), status: "completed" });
                    hist.push({ type: "function_call_output", id: `fco_t${t}`, call_id: `call_t${t}`, output: result });
                },
                editMidHistory: () => {
                    const u = hist.find((it) => it.type === "message" && it.role === "user" && typeof it.content === "string" && it.content.includes("Turn 2:")) as { content: string } | undefined;
                    if (u) u.content = u.content.replace("Turn 2:", `Turn 2 [${EDIT_SENTINEL}]:`);
                },
                payload: () => ({ model: MODEL_A, stream: true, instructions: "You are a coding agent operating in a sandbox.", tools: [{ type: "function", name: "shell", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }], input: [...hist] }),
            };
        case "chat":
            return {
                initHistory: () => { hist.push({ role: "system", content: "You are a coding agent operating in a sandbox. Follow repo conventions strictly." }); },
                pushUser: (t) => { hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 5) }); },
                pushAssistant: (t, reply) => { hist.push({ role: "assistant", content: reply }); },
                pushToolPair: (t, result) => {
                    hist.push({ role: "assistant", content: null, tool_calls: [{ id: `call_t${t}`, type: "function", function: { name: "shell", arguments: SHELL_ARGS(t) } }] });
                    hist.push({ role: "tool", tool_call_id: `call_t${t}`, content: result });
                },
                editMidHistory: () => {
                    const u = hist.find((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Turn 2:")) as { content: string } | undefined;
                    if (u) u.content = u.content.replace("Turn 2:", `Turn 2 [${EDIT_SENTINEL}]:`);
                },
                payload: () => ({ model: MODEL_A, stream: true, messages: [...hist] }),
            };
        case "anthropic":
            return {
                initHistory: () => undefined,
                pushUser: (t) => { hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 5) }); },
                pushAssistant: (t, reply) => { hist.push({ role: "assistant", content: [{ type: "text", text: reply }] }); },
                pushToolPair: (t, result) => {
                    hist.push({ role: "assistant", content: [{ type: "text", text: "running a check" }, { type: "tool_use", id: `tu_${t}`, name: "shell", input: { command: `ls -la mod-${t}`, cwd: `/ws/${t}` } }] });
                    hist.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${t}`, content: result }] });
                },
                editMidHistory: () => {
                    const u = hist.find((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Turn 2:")) as { content: string } | undefined;
                    if (u) u.content = u.content.replace("Turn 2:", `Turn 2 [${EDIT_SENTINEL}]:`);
                },
                payload: () => ({ model: MODEL_A, max_tokens: 1024, stream: true, system: "You are a test assistant.", messages: [...hist] }),
            };
        case "google":
            return {
                initHistory: () => undefined,
                pushUser: (t) => { hist.push({ role: "user", parts: [{ text: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 5) }] }); },
                pushAssistant: (t, reply) => { hist.push({ role: "model", parts: [{ text: reply }] }); },
                pushToolPair: (t, result) => {
                    hist.push({ role: "model", parts: [{ functionCall: { id: `fcg_${t}`, name: "shell", args: { command: `ls -la mod-${t}`, cwd: `/ws/${t}` } } }] });
                    hist.push({ role: "user", parts: [{ functionResponse: { name: "shell", response: { result } } }] });
                },
                editMidHistory: () => {
                    for (const c of hist) if (c.role === "user") for (const pt of asArr(c.parts)) {
                        const tx = pt.text as string | undefined;
                        if (typeof tx === "string" && tx.includes("Turn 2:")) { pt.text = tx.replace("Turn 2:", `Turn 2 [${EDIT_SENTINEL}]:`); return; }
                    }
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

function listen(server: http.Server): Promise<void> {
    return once(server, "listening").then(() => undefined);
}

function closeServer(s: http.Server | undefined): Promise<void> {
    return s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();
}

function goldenProxyOptions(upstreamPort: number, ctx: number): ProxyOptions {
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

/** Drive one wire and produce the golden record. */
export async function driveWire(wire: Wire, sessionId = `golden-${wire}`, opts: { dumpStateTo?: string } = {}): Promise<GoldenRecord> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `golden-${wire}-`));
    const sessionsDir = path.join(tmp, "sessions");
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmp;
    delete process.env.ACP_DUMP_BODY;
    const hist: Item[] = [];
    const ops = makeOps(wire, hist);
    const bodies: string[] = [];
    const state: JudgeState = { wire, bodies, turn: 0 };
    let folds = 0;
    let foldAt = -1;
    const shouldFold = (body: string, turn: number): boolean =>
        folds === 0 && turn >= MIN_FOLD_T && Buffer.byteLength(body, "utf8") > THRESHOLD;
    const foldArgs = (refs: string[]): string => {
        const start = refs[2]!;
        const end = refs[refs.length - 6]!;
        return JSON.stringify({
            content: [{
                startId: start,
                endId: end,
                topic: "storage render golden fold",
                summary: `Golden fold covering ${start}..${end}: turns exercised the pipeline, builds stayed green, row markers unique per turn.`,
            }],
        });
    };
    let upstream: http.Server | undefined;
    let proxy: http.Server | undefined;
    let store: SessionStore | undefined;
    try {
        upstream = startJudgeUpstream(state, (b, t) => {
            if (shouldFold(b, t)) { folds++; foldAt = bodies.length; return true; }
            return false;
        }, foldArgs);
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;
        store = new SessionStore({ dir: sessionsDir, debounceMs: 1, enabled: true });
        _setStoreForTest(store);
        setRegistryForTest({});
        proxy = await startServer(goldenProxyOptions(upstreamPort, 200_000));
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
            if (reply.length === 0) throw new Error(`${wire} turn ${t}: empty reply`);
            ops.pushAssistant(t, reply);
            if (t % 2 === 0) ops.pushToolPair(t, TOOL_RESULT_OK(t));
        };

        ops.initHistory();
        // GROW until one fold fires and settles.
        let t = 0;
        for (; t < GROW_TURNS; t++) {
            await sendTurn(t);
            if (folds > 0 && bodies.length - foldAt > SETTLE_TURNS) break;
        }
        if (folds === 0) throw new Error(`${wire}: fold never fired within ${GROW_TURNS} turns`);
        // EDIT: mid-history edit must honestly re-enter.
        ops.editMidHistory();
        await sendTurn(t + 1);
        const editedAt = bodies.length - 1;
        const editedBody = bodies[editedAt]!;
        if (!editedBody.includes(EDIT_SENTINEL)) throw new Error(`${wire}: edited original did not re-enter the wire`);
        // Post-edit growth: 2 trailing turns. Also load-bearing for the
        // STATE digest: the persist layer does not reliably write the final
        // turn's mutations on their own (missing final markDirty — #2671
        // defect ② family, hotfix candidate); production papers over it via
        // the NEXT request's save, and this script exercises exactly that.
        await sendTurn(t + 2);
        await sendTurn(t + 3);
        const postEdit = bodies[bodies.length - 1]!;
        if (!postEdit.includes(SUMMARY_MARKER)) throw new Error(`${wire}: post-edit growth lost the summary carrier`);

        // Final persisted session → digest. Take the REAL graceful-shutdown
        // path (SIGTERM → flushAllSessions) instead of polling: the debounced
        // writers otherwise race the read, and the LAST turn's state can
        // simply never hit disk inside the window — a snapshot that depends
        // on which debounce window won is not a golden, it is a coin flip
        // (write-side races are #2671 defect ②, pinned separately).
        await flushAllSessions();
        const session = store.loadSync(sessionId);
        if (!session) throw new Error(`${wire}: session not persisted`);
        const lastView = JSON.stringify(canonicalize({
            state: session.state,
            blockContents: [...session.blockContents.entries()],
            stats: session.stats,
            metadata: session.metadata,
        }))
            // Ephemeral environment, not contract: the judge upstream's
            // ephemeral port and this drive's session id appear inside ledger
            // lines / stats origins. Normalize before hashing.
            .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<PORT>")
            .split(JSON.stringify(sessionId).slice(1, -1)).join("<SID>");
        const stateDigest = sha256(lastView);
        if (opts.dumpStateTo) fs.writeFileSync(opts.dumpStateTo, JSON.stringify(JSON.parse(lastView), null, 1));
        const st = session.state as { messageRefs?: { byRaw?: Record<string, string>; byRef?: Record<string, string> }, blocks?: Array<{ blockId: string; active: boolean; effectiveMessageIds?: string[] }>, deadRefs?: string[] };
        const active = st.blocks?.filter((b) => b.active) ?? [];
        return {
            wire,
            turns: bodies.map((b, i) => ({ i, sha: sha256(canonicalBody(b)), bytes: Buffer.byteLength(b, "utf8") })),
            foldAt,
            editedAt,
            summaryFrom: bodies.findIndex((b) => b.includes(SUMMARY_MARKER)),
            stateDigest,
            stateShape: {
                refs: Object.keys(st.messageRefs?.byRaw ?? {}).length,
                blocks: st.blocks?.length ?? 0,
                activeBlocks: active.length,
                deadRefs: st.deadRefs?.length ?? 0,
                blockContents: session.blockContents.size,
                coveredRefSample: active[0]?.effectiveMessageIds?.slice(0, 8) ?? [],
            },
        };
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        _resetSessionsForTest();
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(tmp);
    }
}
