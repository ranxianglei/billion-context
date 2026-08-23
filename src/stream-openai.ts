import type { CompressionCore, Config, CoreMessage } from "acp-kernel";
import type { Session } from "./session.js";
import { COMPRESS_TOOL_NAME, parseCompressInput } from "./compress-tool.js";
import { applyRanges, type RewriteCtx } from "./stream.js";
import { normalizeSseLineEndings } from "./sse-util.js";
import { safeJsonParse } from "./util.js";

type StreamState = {
    compressIndices: Set<number>;
    args: Record<number, string>;
    converted: boolean;
    sawReal: boolean;
    finishReason: string | null;
    finishObj: Record<string, unknown> | null;
    done: boolean;
};

function newState(): StreamState {
    return {
        compressIndices: new Set(),
        args: {},
        converted: false,
        sawReal: false,
        finishReason: null,
        finishObj: null,
        done: false,
    };
}

export async function* rewriteOpenaiSseStream(
    upstream: ReadableStream<Uint8Array>,
    ctx: RewriteCtx,
): AsyncGenerator<Buffer> {
    const reader = upstream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    const state = newState();
    let output = "";
    let eventNum = 0;
    const flush = (): Buffer => {
        const out = Buffer.from(output, "utf8");
        output = "";
        return out;
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            buf = normalizeSseLineEndings(buf);
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
                const rawEvent = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const routed = routeOpenaiEvent(rawEvent, state);
                eventNum++;
                if (ctx.debug) {
                    const dl = rawEvent.split("\n").find(l => l.startsWith("data:"));
                    const data = dl ? dl.slice(5).trim() : "";
                    let summary = data.slice(0, 80);
                    try {
                        const obj = JSON.parse(data);
                        const tc = obj.choices?.[0]?.delta?.tool_calls?.[0];
                        if (tc?.function?.name) summary = `tool_call name=${tc.function.name} idx=${tc.index} args_len=${(tc.function.arguments ?? "").length}`;
                        else if (obj.choices?.[0]?.finish_reason) summary = `finish=${obj.choices[0].finish_reason}`;
                    } catch { /* best-effort debug summary */ }
                    ctx.log(`sse[${eventNum}] routed=${routed === null ? "SUPPRESSED" : "passthrough"} | ${summary}`);
                }
                if (routed === null) continue;
                output += routed;
                if (output.length >= 8192) yield flush();
            }
        }
        output += buildOpenaiTail(state, ctx);
        if (output) yield flush();
    } finally {
        reader.releaseLock();
    }
}

function routeOpenaiEvent(rawEvent: string, state: StreamState): string | null {
    const dataLine = extractDataLine(rawEvent);
    if (dataLine === null) return rawEvent + "\n\n";
    if (dataLine === "[DONE]") {
        state.done = true;
        return state.converted ? null : rawEvent + "\n\n";
    }
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(dataLine);
    } catch {
        return rawEvent + "\n\n";
    }
    const choices = obj.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) return rawEvent + "\n\n";
    const finishReason = choice.finish_reason;
    if (typeof finishReason === "string" && finishReason !== "null") {
        state.finishReason = finishReason;
        if (!state.converted) {
            state.done = true;
            return rawEvent + "\n\n";
        }
        state.finishObj = obj;
        return null;
    }
    const delta = choice.delta as { content?: string; tool_calls?: Array<Record<string, unknown>> } | undefined;
    if (delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        // Process EVERY tool call in the delta, not just tool_calls[0]. A
        // single SSE chunk can carry multiple tool calls (different indices);
        // reading only [0] dropped the args of the 2nd+ and failed to mark
        // them as real/compress.
        let allCompress = true;
        for (const raw of delta.tool_calls) {
            const entry = raw as {
                index?: number;
                function?: { name?: string; arguments?: string };
            };
            const tidx = entry.index ?? 0;
            const name = entry.function?.name;
            if (typeof name === "string") {
                if (name === COMPRESS_TOOL_NAME) {
                    state.compressIndices.add(tidx);
                    state.converted = true;
                } else {
                    state.sawReal = true;
                }
            }
            if (state.compressIndices.has(tidx)) {
                const frag = entry.function?.arguments;
                if (typeof frag === "string") state.args[tidx] = (state.args[tidx] ?? "") + frag;
            } else {
                allCompress = false;
            }
        }
        // Suppress the whole event only if every tool call in this chunk is a
        // compress call. If a real tool call shares the chunk, pass it through
        // verbatim (multi-tool-per-chunk is rare; rewriting a partial delta
        // is fragile, so we accept the edge case rather than risk corruption).
        if (allCompress) return null;
        return rawEvent + "\n\n";
    }
    return rawEvent + "\n\n";
}

function buildOpenaiTail(state: StreamState, ctx: RewriteCtx): string {
    if (!state.converted) return "";
    const base = (state.finishObj ?? { object: "chat.completion.chunk" }) as Record<string, unknown>;
    let out = "";
    const sortedIndices = [...state.compressIndices].sort((a, b) => a - b);
    for (const tidx of sortedIndices) {
        const raw = state.args[tidx] ?? "";
        let parsed: unknown = {};
        try {
            parsed = raw ? JSON.parse(raw) : {};
        } catch {
            parsed = {};
        }
        const note = applyRanges(parseCompressInput(parsed), ctx);
        out += `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: note + "\n" }, finish_reason: null }] })}\n\n`;
    }
    let finalReason: string;
    if (state.converted) {
        finalReason = state.sawReal ? "tool_calls" : "stop";
    } else {
        finalReason = state.finishReason ?? "stop";
    }
    out += `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finalReason }] })}\n\n`;
    out += "data: [DONE]\n\n";
    return out;
}

function extractDataLine(rawEvent: string): string | null {
    const lines = rawEvent.split("\n");
    for (const l of lines) {
        if (l.startsWith("data:")) {
            return l.slice(5).trim();
        }
    }
    return null;
}

export function rewriteOpenaiJsonResponse(body: unknown, ctx: RewriteCtx): unknown {
    if (!body || typeof body !== "object") return body;
    const b = body as {
        choices?: Array<{ message?: Record<string, unknown>; finish_reason?: string }>;
    };
    const choice = b.choices?.[0];
    const msg = choice?.message;
    if (!choice || !msg) return body;
    let converted = false;
    let sawReal = false;
    const noteParts: string[] = [];
    const keepToolCalls: unknown[] = [];
    const existingText = typeof msg.content === "string" ? msg.content : "";
    const toolCalls = msg.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> | undefined;
    if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
            if (tc.function?.name === COMPRESS_TOOL_NAME) {
                converted = true;
                noteParts.push(applyRanges(parseCompressInput(safeJsonParse(tc.function?.arguments ?? "")), ctx));
            } else {
                sawReal = true;
                keepToolCalls.push(tc);
            }
        }
    }
    if (existingText && (existingText.includes("\x3cacp ") || existingText.includes("\x3c/acp"))) {
        ctx.log(`[warn: tag echo] non-stream openai output contains <acp tag: ${existingText.slice(0, 120).replace(/\n/g, " ")}`);
    }
    if (!converted) return body;
    const note = noteParts.join("\n");
    msg.content = existingText ? `${existingText}\n${note}` : note;
    if (keepToolCalls.length > 0) {
        msg.tool_calls = keepToolCalls;
    } else {
        delete msg.tool_calls;
    }
    if (!sawReal) {
        choice.finish_reason = "stop";
    }
    return body;
}

export type { CompressionCore, Config, CoreMessage, Session };
