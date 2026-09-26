// #1295: compress-loop adapter for the commandcode CLI wire (bare JSONL event
// stream, not SSE). Reuses the openai adapter's request building (the loop
// always speaks flat OpenAI internally) and overrides stream parsing + every
// emit to speak JSONL. The finish/error events ARE the stream terminators —
// there is no [DONE] sentinel (WC-1).

import { createOpenaiAdapter } from "./adapter-openai.js";
import { buildVisibilityMarker } from "../compress-loop.js";
import { composeStreamFilters, createMarkerLineFilter, createTagEchoFilter } from "./tag-echo-filter.js";
import { degenerateTurnWarning } from "../degenerate-turn.js";
import { log as loggerLog } from "../logger.js";

import type {
    CompressLoopAdapter,
    EmitCompletionOpts,
    ParsedStreamEvent,
    ToolCallEmit,
} from "./core.js";

const PROXY_TOOL_SET = new Set([
    "compress", "decompress", "search_context", "acp_status",
    "bili_compress", "bili_decompress", "bili_search_context", "bili_status",
]);

interface ToolBuffer {
    id: string;
    name: string;
    arguments: string;
}

async function* iterJsonlLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
        while (true) {
            let done: boolean;
            let value: Uint8Array | undefined;
            try {
                ({ done, value } = await reader.read());
            } catch {
                break;
            }
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            buf = buf.replace(/\r\n|\r/g, "\n");
            let idx: number;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                if (line.trim().length > 0) yield line;
            }
        }
        if (buf.trim().length > 0) yield buf;
    } finally {
        try {
            reader.releaseLock();
        } catch { /* already released */ }
    }
}

function lineBuf(line: string): Buffer {
    return Buffer.from(line.endsWith("\n") ? line : line + "\n", "utf8");
}

function rewriteLine(line: string, patch: Record<string, unknown>): Buffer {
    return Buffer.from(JSON.stringify({ ...JSON.parse(line), ...patch }) + "\n", "utf8");
}

export function createCommandcodeAdapter(
    requestBody: Record<string, unknown>,
    clientSystem?: string,
    absorbName?: string,
    notes?: string[],
): CompressLoopAdapter {
    const base = createOpenaiAdapter(requestBody, clientSystem, absorbName, notes);
    return {
        ...base,

        async *parseStream(upstream: ReadableStream<Uint8Array>, round: number): AsyncGenerator<ParsedStreamEvent> {
            void round;
            const tagFilter = composeStreamFilters(createTagEchoFilter((snippet) => {
                loggerLog("warn", `[tag-echo] stripped model-emitted render tag (commandcode proxy mode): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
            }), createMarkerLineFilter());
            let sawReasoning = false;
            let sawRealToolCall = false;
            let sawTerminal = false;
            let visibleTextChars = 0;
            let toolCallsEmitted = 0;
            const pending = new Map<number, ToolBuffer>();
            const rawToolLines: { line: string; name: string }[] = [];
            let toolSeq = 0;
            let finalFinishReason: string | undefined;

            const flushPendingAsStructured = function* (): Generator<ParsedStreamEvent> {
                for (const tc of pending.values()) {
                    if (tc.name.length > 0 || tc.id.length > 0) {
                        toolCallsEmitted++;
                        yield { kind: "tool_call", name: tc.name, callId: tc.id, arguments: tc.arguments } as ParsedStreamEvent;
                    }
                }
                pending.clear();
            };
            // Each CC tool-call event carries ONE complete call, so the
            // proxy-vs-real decision is per event; real calls replay their
            // original line verbatim (original id/name/arguments).
            const settleToolCalls = function* (): Generator<ParsedStreamEvent> {
                const realIndexes = new Set<number>();
                for (const [idx, tc] of pending) {
                    if (tc.name.length > 0 && !PROXY_TOOL_SET.has(tc.name) && tc.name !== absorbName) realIndexes.add(idx);
                }
                sawRealToolCall = realIndexes.size > 0;
                if (!sawRealToolCall) {
                    yield* flushPendingAsStructured();
                    return;
                }
                for (const [idx, tc] of pending) {
                    if (realIndexes.has(idx) && (tc.name.length > 0 || tc.id.length > 0)) {
                        toolCallsEmitted++;
                        yield { kind: "tool_call", name: tc.name, callId: tc.id, arguments: tc.arguments, passthrough: true } as ParsedStreamEvent;
                    }
                }
                for (const { line, name } of rawToolLines) {
                    const idx = [...pending.entries()].find(([, tc]) => tc.name === name)?.[0];
                    if (idx === undefined || realIndexes.has(idx)) {
                        yield { kind: "meta", chunk: lineBuf(line) } as ParsedStreamEvent;
                    }
                }
                for (const [idx, tc] of pending) {
                    if (!realIndexes.has(idx) && tc.name.length > 0) {
                        toolCallsEmitted++;
                        yield { kind: "tool_call", name: tc.name, callId: tc.id, arguments: tc.arguments } as ParsedStreamEvent;
                    }
                }
                pending.clear();
            };
            const maybeWarnDegenerate = (finishReason?: string) => {
                if (!sawTerminal || sawRealToolCall) return;
                const st = tagFilter.stats();
                const msg = degenerateTurnWarning({
                    reason: finishReason,
                    terminalReason: "stop",
                    toolCalls: toolCallsEmitted,
                    text: { inputChars: st.inputChars, outputChars: visibleTextChars, dropped: st.dropped },
                    sawThinking: sawReasoning,
                    wire: "commandcode-proxy",
                });
                if (msg) loggerLog("warn", msg);
            };

            for await (const line of iterJsonlLines(upstream)) {
                let ev: Record<string, unknown>;
                try {
                    ev = JSON.parse(line) as Record<string, unknown>;
                } catch {
                    // WC-3 (WIRE-CONTRACTS.md): undecodable line — forward
                    // verbatim in round 1 only, never fabricate meaning.
                    if (round === 1) yield { kind: "meta", chunk: lineBuf(line), firstRoundOnly: true } as ParsedStreamEvent;
                    continue;
                }
                const type = ev.type;
                if (type === "text-delta" && typeof ev.text === "string") {
                    const clean = tagFilter.push(ev.text);
                    visibleTextChars += clean.length;
                    if (clean.length > 0) {
                        const raw = clean === ev.text ? lineBuf(line) : rewriteLine(line, { text: clean });
                        yield { kind: "text", delta: clean, raw } as ParsedStreamEvent;
                    }
                } else if (type === "reasoning-delta" && typeof ev.text === "string") {
                    sawReasoning = true;
                    yield { kind: "reasoning", delta: ev.text, raw: lineBuf(line) } as ParsedStreamEvent;
                } else if (type === "tool-call") {
                    const args = typeof ev.input === "string" ? ev.input
                        : typeof ev.args === "string" ? ev.args
                            : typeof ev.arguments === "string" ? ev.arguments
                                : JSON.stringify(ev.input ?? ev.args ?? ev.arguments ?? {});
                    const idx = toolSeq++;
                    pending.set(idx, {
                        id: typeof ev.toolCallId === "string" ? ev.toolCallId : "",
                        name: typeof ev.toolName === "string" ? ev.toolName : "",
                        arguments: args,
                    });
                    rawToolLines.push({ line, name: typeof ev.toolName === "string" ? ev.toolName : "" });
                } else if (type === "finish") {
                    const tail = tagFilter.flush();
                    if (tail.length > 0) {
                        visibleTextChars += tail.length;
                        yield { kind: "text", delta: tail, raw: lineBuf(JSON.stringify({ type: "text-delta", text: tail })) } as ParsedStreamEvent;
                    }
                    yield* settleToolCalls();
                    const tu = ev.totalUsage;
                    if (tu !== null && typeof tu === "object" && !Array.isArray(tu)) {
                        const t = tu as Record<string, unknown>;
                        const details = t.inputTokenDetails;
                        yield {
                            kind: "usage",
                            inputTokens: typeof t.inputTokens === "number" ? t.inputTokens : undefined,
                            outputTokens: typeof t.outputTokens === "number" ? t.outputTokens : undefined,
                            cachedTokens: details !== null && typeof details === "object" && typeof (details as Record<string, unknown>).cacheReadTokens === "number"
                                ? (details as Record<string, unknown>).cacheReadTokens as number
                                : undefined,
                        } as ParsedStreamEvent;
                    }
                    finalFinishReason = typeof ev.finishReason === "string" ? ev.finishReason : undefined;
                    sawTerminal = true;
                    maybeWarnDegenerate(finalFinishReason);
                    if (sawRealToolCall) {
                        // The provider-measured finish frame rides through
                        // verbatim — same as openai's raw finish chunk.
                        yield { kind: "meta", chunk: lineBuf(line) } as ParsedStreamEvent;
                    }
                    yield { kind: "done", finishReason: finalFinishReason ?? "stop", thinking: sawReasoning, ...(sawRealToolCall ? { suppressCompletion: true } : {}) } as ParsedStreamEvent;
                } else if (type === "error") {
                    const message = typeof ev.message === "string" ? ev.message
                        : typeof ev.error === "string" ? ev.error
                            : "upstream error";
                    yield { kind: "error", message } as ParsedStreamEvent;
                    return;
                } else {
                    // WC-3 (WIRE-CONTRACTS.md): reasoning-start/end and any
                    // future event types — forward verbatim in round 1 only
                    // so synthetic rounds do not replay upstream frames.
                    yield { kind: "meta", chunk: lineBuf(line), firstRoundOnly: true } as ParsedStreamEvent;
                }
            }
        },

        emitText(delta: string): Buffer {
            return lineBuf(JSON.stringify({ type: "text-delta", text: delta }));
        },

        emitReasoning(delta: string): Buffer {
            return lineBuf(JSON.stringify({ type: "reasoning-delta", text: delta }));
        },

        emitToolCall(call: ToolCallEmit): Buffer {
            let input: unknown = {};
            try {
                const parsed = JSON.parse(call.arguments);
                if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
            } catch { /* malformed arguments → {} (WC-4) */ }
            return lineBuf(JSON.stringify({ type: "tool-call", toolCallId: call.callId, toolName: call.name, input }));
        },

        emitMarker(toolName, result) {
            // The base openai marker is SSE-framed; on this wire the marker
            // rides as prose inside a text-delta (WC-5).
            return lineBuf(JSON.stringify({ type: "text-delta", text: buildVisibilityMarker(toolName, result) }));
        },

        emitCompletion(opts?: EmitCompletionOpts): Buffer {
            const u = opts?.usage;
            // Numeric fields must never be absent: dsh's mapUsage computes over
            // them and a missing field yields NaN (same rule as adapter-openai).
            const totalUsage = {
                inputTokens: u?.inputTokens ?? 0,
                outputTokens: u?.outputTokens ?? 0,
                inputTokenDetails: { cacheReadTokens: u?.cachedTokens ?? 0 },
            };
            return lineBuf(JSON.stringify({ type: "finish", finishReason: opts?.finishReason ?? "stop", totalUsage }));
        },

        emitError(message: string): Buffer {
            return lineBuf(JSON.stringify({ type: "error", error: "acp_proxy_error", message }));
        },
    };
}
