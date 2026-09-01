import type { CoreMessage } from "acp-kernel";
import { coreToOpenai, injectOpenaiSystem } from "acp-kernel/wire";
import { buildVisibilityMarker } from "../compress-loop.js";
import { createTagEchoFilter } from "./tag-echo-filter.js";
import { log as loggerLog } from "../logger.js";
import { systemToUser } from "../util.js";

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

// Given a raw SSE chunk that carries tool_call fragments, decide how to
// replay it for a real-tool round: "keep" = every fragment belongs to a real
// call (forward verbatim), null = nothing real in it (drop), or a rewritten
// copy keeping only the real fragments (mixed chunk).
function filterRealToolFragments(
    parsed: Record<string, unknown>,
    realIndexes: Set<number>,
): "keep" | null | Record<string, unknown> {
    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const delta = choice?.delta as Record<string, unknown> | undefined;
    const tcs = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (!tcs || tcs.length === 0) return "keep";
    let anyReal = false;
    let anyProxy = false;
    for (const tc of tcs) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        if (realIndexes.has(idx)) anyReal = true;
        else anyProxy = true;
    }
    if (!anyProxy) return "keep";
    if (!anyReal) return null;
    const filtered: Record<string, unknown> = { ...parsed };
    const filteredChoices: Array<Record<string, unknown>> = [...(choices as Array<Record<string, unknown>>)];
    const filteredChoice: Record<string, unknown> = { ...(choice as Record<string, unknown>) };
    const filteredDelta: Record<string, unknown> = { ...(delta as Record<string, unknown>) };
    filteredDelta.tool_calls = tcs.filter((tc) => realIndexes.has(typeof tc.index === "number" ? tc.index : 0));
    filteredChoice.delta = filteredDelta;
    filteredChoices[0] = filteredChoice;
    filtered.choices = filteredChoices;
    return filtered;
}

interface ToolCallBuffer {
    index: number;
    id: string;
    name: string;
    arguments: string;
}

async function* iterSseChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = stream.getReader();
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
            buf += new TextDecoder().decode(value, { stream: true });
            buf = buf.replace(/\r\n|\r/g, "\n");
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
                const raw = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (raw.trim().length > 0) yield raw;
            }
        }
        if (buf.trim().length > 0) yield buf;
    } finally {
        reader.releaseLock();
    }
}

function rewriteContentChunk(parsed: Record<string, unknown>, content: string): Buffer {
    const clone = { ...parsed } as { choices?: Array<Record<string, unknown>> };
    if (clone.choices && clone.choices.length > 0) {
        const choice = { ...(clone.choices[0] as Record<string, unknown>) };
        const delta = { ...(choice.delta as Record<string, unknown>) };
        delta.content = content;
        choice.delta = delta;
        clone.choices = [choice, ...clone.choices.slice(1)];
    }
    return Buffer.from(`data: ${JSON.stringify(clone)}\n\n`, "utf8");
}

// A chunk forwarded verbatim must never carry finish_reason: the ACP loop may run
// another upstream round after this one (core.ts reRequest), and the completion is
// emitted once, at the end, by emitCompletion. Leaking an early finish makes every
// later token "content after the finish reason" to the client.
function stripFinishReasonChunk(buf: Buffer): Buffer {
    const m = /^data: (.*)\n\n$/s.exec(buf.toString("utf8"));
    if (!m) return buf;
    try {
        const parsed = JSON.parse(m[1]) as { choices?: Array<Record<string, unknown>> };
        if (!Array.isArray(parsed.choices)) return buf;
        parsed.choices = parsed.choices.map((c) => ({ ...c, finish_reason: null }));
        return Buffer.from(`data: ${JSON.stringify(parsed)}\n\n`, "utf8");
    } catch {
        return buf;
    }
}

export function createOpenaiAdapter(requestBody: Record<string, unknown>, clientSystem?: string, hostCredit = 0): CompressLoopAdapter {
    const model = (requestBody.model as string) ?? "unknown";
    let responseId = `chatcmpl-proxy-${Date.now()}`;
    let toolIndex = 0;

    const makeBase = () => ({
        id: responseId,
        object: "chat.completion.chunk" as const,
        created: Date.now(),
        model,
    });

    const buildContent = (content: string): Buffer =>
        Buffer.from(
            `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Date.now(),
                model,
                choices: [{ index: 0, delta: { content }, finish_reason: null }],
            })}\n\n`,
            "utf8",
        );

    const buildReasoning = (content: string): Buffer =>
        Buffer.from(
            `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Date.now(),
                model,
                choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
            })}\n\n`,
            "utf8",
        );

    const buildToolCall = (call: ToolCallEmit): Buffer => {
        const idx = toolIndex++;
        return Buffer.from(
            `data: ${JSON.stringify({
                ...makeBase(),
                choices: [{
                    index: 0,
                    delta: {
                        tool_calls: [{
                            index: idx,
                            id: call.callId,
                            type: "function",
                            function: { name: call.name, arguments: call.arguments },
                        }],
                    },
                    finish_reason: null,
                }],
            })}\n\n`,
            "utf8",
        );
    };

    const buildFinish = (finishReason: string, usage: Record<string, unknown> | null): Buffer =>
        Buffer.from(
            `data: ${JSON.stringify({
                ...makeBase(),
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                ...(usage ? { usage } : {}),
            })}\n\n`,
            "utf8",
        );

    return {
        buildRequest(coreMessages, systemPrompt, body) {
            // Kernel 0.0.37 hoists the leading system/developer prefix out of
            // the openai fold space (fingerprints must not depend on host
            // runtime state), so coreMessages no longer carries it — re-inject
            // the CLIENT's original system ahead of the compress prompt,
            // mirroring the anthropic adapter's anthropicSystem path.
            const messages = systemToUser(coreToOpenai(coreMessages));
            const withSys = injectOpenaiSystem(messages, [clientSystem, systemPrompt].filter((p): p is string => typeof p === "string" && p.length > 0));
            return { ...body, messages: withSys };
        },

        async *parseStream(upstream, _round) {
            const pending = new Map<number, ToolCallBuffer>();
            // #206: strip model-imitated render tags from content deltas; the
            // filter may hold back a short tail, flushed at finish/[DONE].
            const tagFilter = createTagEchoFilter((snippet) => {
                loggerLog("warn", `[tag-echo] stripped model-emitted render tag: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
            });
            const flushFilter = function* (): Generator<ParsedStreamEvent> {
                const tail = tagFilter.flush();
                if (tail.length > 0) {
                    yield { kind: "text", delta: tail, raw: buildContent(tail) } as ParsedStreamEvent;
                }
            };
            // Raw tool_call chunks in arrival order. Backends (SGLang/vLLM)
            // stream a tool name across MULTIPLE deltas — the first fragment
            // carries the name, continuation fragments carry empty names.
            // Deciding "proxy vs real" per-chunk loses the name entirely (the
            // name chunk gets buffered while an empty-name continuation flips
            // the stream into passthrough mode, and the flush is then skipped).
            // So: buffer EVERYTHING, decide once at finish.
            const rawToolChunks: { json: string; parsed: Record<string, unknown> }[] = [];
            let sawRealToolCall = false;
            const flushPendingAsStructured = function* (): Generator<ParsedStreamEvent> {
                for (const [, tc] of pending) {
                    if (tc.name.length > 0 || tc.id.length > 0) {
                        yield {
                            kind: "tool_call",
                            name: tc.name,
                            callId: tc.id,
                            arguments: tc.arguments,
                        } as ParsedStreamEvent;
                    }
                }
                pending.clear();
            };
            // Decide proxy-vs-real from the ACCUMULATED names and emit events:
            // real calls → raw replay (verbatim chunks, original ids/order) +
            // passthrough-flagged structured events so the loop counts them;
            // proxy calls → structured events (server-side execution).
            const settleToolCalls = function* (): Generator<ParsedStreamEvent> {
                const realIndexes = new Set<number>();
                for (const [idx, tc] of pending) {
                    if (tc.name.length > 0 && !PROXY_TOOL_SET.has(tc.name)) realIndexes.add(idx);
                }
                sawRealToolCall = realIndexes.size > 0;
                if (!sawRealToolCall) {
                    yield* flushPendingAsStructured();
                    return;
                }
                for (const [idx, tc] of pending) {
                    if (realIndexes.has(idx) && (tc.name.length > 0 || tc.id.length > 0)) {
                        yield {
                            kind: "tool_call",
                            name: tc.name,
                            callId: tc.id,
                            arguments: tc.arguments,
                            passthrough: true,
                        } as ParsedStreamEvent;
                    }
                }
                for (const { json, parsed } of rawToolChunks) {
                    const filtered = filterRealToolFragments(parsed, realIndexes);
                    if (filtered === "keep") {
                        yield { kind: "meta", chunk: Buffer.from("data: " + json + "\n\n", "utf8") } as ParsedStreamEvent;
                    } else if (filtered !== null) {
                        yield { kind: "meta", chunk: Buffer.from("data: " + JSON.stringify(filtered) + "\n\n", "utf8") } as ParsedStreamEvent;
                    }
                }
                for (const [idx, tc] of pending) {
                    if (!realIndexes.has(idx) && tc.name.length > 0) {
                        yield {
                            kind: "tool_call",
                            name: tc.name,
                            callId: tc.id,
                            arguments: tc.arguments,
                        } as ParsedStreamEvent;
                    }
                }
                pending.clear();
            };
            for await (const eventStr of iterSseChunks(upstream)) {
                const dataLine = eventStr.split("\n").find((l) => l.startsWith("data:"));
                if (!dataLine) continue;
                const jsonStr = dataLine.slice(5).trim();
                if (jsonStr === "[DONE]") {
                    yield* flushFilter();
                    if (sawRealToolCall) {
                        yield { kind: "meta", chunk: Buffer.from(eventStr + "\n\n", "utf8") } as ParsedStreamEvent;
                        continue;
                    }
                    yield* settleToolCalls();
                    if (sawRealToolCall) {
                        yield { kind: "meta", chunk: Buffer.from(eventStr + "\n\n", "utf8") } as ParsedStreamEvent;
                    }
                    yield { kind: "done", finishReason: "stop", ...(sawRealToolCall ? { suppressCompletion: true } : {}) } as ParsedStreamEvent;
                    continue;
                }
                let parsed: Record<string, unknown>;
                try {
                    parsed = JSON.parse(jsonStr);
                } catch {
                    continue;
                }
                const rawBuf = Buffer.from(eventStr + "\n\n", "utf8");
                const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
                const choice = choices?.[0];
                if (!choice) {
                    if (parsed.usage) {
                        const u = parsed.usage as Record<string, unknown>;
                        const pd = u.prompt_tokens_details as Record<string, unknown> | undefined;
                        yield {
                            kind: "usage",
                            inputTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
                            outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
                            cachedTokens: typeof pd?.cached_tokens === "number" ? pd.cached_tokens : undefined,
                        } as ParsedStreamEvent;
                    }
                    continue;
                }
                const delta = choice.delta as Record<string, unknown> | undefined;
                const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;

                if (finishReason) {
                    yield* flushFilter();
                    const hadToolCalls = [...pending.values()].some((tc) => tc.name.length > 0 || tc.id.length > 0);
                    yield* settleToolCalls();
                    const u = parsed.usage as Record<string, unknown> | undefined;
                    const pd = u?.prompt_tokens_details as Record<string, unknown> | undefined;
                    yield {
                        kind: "usage",
                        inputTokens: typeof u?.prompt_tokens === "number" ? u.prompt_tokens : undefined,
                        outputTokens: typeof u?.completion_tokens === "number" ? u.completion_tokens : undefined,
                        cachedTokens: typeof pd?.cached_tokens === "number" ? pd.cached_tokens : undefined,
                    } as ParsedStreamEvent;
                    if (sawRealToolCall) {
                        // #408: this raw finish chunk (with the provider's
                        // post-fold usage) reaches the host verbatim — add the
                        // prepare-time credit back so the host anchors on the
                        // uncompressed baseline.
                        let chunk = rawBuf;
                        if (hostCredit > 0 && u) {
                            const pu = typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined;
                            const tu = typeof u.total_tokens === "number" ? u.total_tokens : undefined;
                            if (pu !== undefined || tu !== undefined) {
                                const patched = {
                                    ...parsed,
                                    usage: {
                                        ...u,
                                        ...(pu !== undefined ? { prompt_tokens: pu + hostCredit } : {}),
                                        ...(tu !== undefined ? { total_tokens: tu + hostCredit } : {}),
                                    },
                                };
                                const out = eventStr
                                    .split("\n")
                                    .map((l) => (l.startsWith("data:") ? `data: ${JSON.stringify(patched)}` : l))
                                    .join("\n");
                                chunk = Buffer.from(out + "\n\n", "utf8");
                            }
                        }
                        // This verbatim chunk IS the round's authoritative completion
                        // (suppressCompletion); write it once and never fall through
                        // to the text/reasoning branches (which would re-emit the same
                        // bytes after the finish reason).
                        yield { kind: "meta", chunk } as ParsedStreamEvent;
                        yield { kind: "done", finishReason, suppressCompletion: true } as ParsedStreamEvent;
                        continue;
                    } else {
                        yield {
                            kind: "done",
                            finishReason: hadToolCalls && finishReason === "stop" ? "tool_calls" : finishReason,
                        } as ParsedStreamEvent;
                    }
                }

                if (!delta) continue;

                if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
                    yield { kind: "reasoning", delta: delta.reasoning_content, raw: finishReason ? stripFinishReasonChunk(rawBuf) : rawBuf } as ParsedStreamEvent;
                }

                if (delta.tool_calls) {
                    const tcs = delta.tool_calls as Array<Record<string, unknown>>;
                    rawToolChunks.push({ json: jsonStr, parsed });
                    for (const tc of tcs) {
                        const idx = typeof tc.index === "number" ? tc.index : 0;
                        const fn = tc.function as Record<string, unknown> | undefined;
                        const name = typeof fn?.name === "string" ? fn.name : "";
                        const id = typeof tc.id === "string" ? tc.id : "";
                        const rawArgs = fn?.arguments;
                        const args = typeof rawArgs === "string" ? rawArgs : (rawArgs !== null && typeof rawArgs === "object" ? JSON.stringify(rawArgs) : "");
                        let buf = pending.get(idx);
                        if (!buf) {
                            buf = { index: idx, id, name, arguments: args };
                            pending.set(idx, buf);
                        } else {
                            if (id) buf.id = id;
                            buf.name += name;
                            buf.arguments += args;
                        }
                    }
                    if (typeof delta.content === "string" && delta.content.length > 0) {
                        const clean = tagFilter.push(delta.content);
                        if (clean.length > 0) {
                            yield { kind: "text", delta: clean } as ParsedStreamEvent;
                        }
                    }
                    continue;
                }

                const hasReasoning = typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0;
                if (typeof delta.content === "string" && delta.content.length > 0) {
                        const clean = tagFilter.push(delta.content);
                        if (clean.length > 0) {
                            const raw = clean === delta.content ? rawBuf : rewriteContentChunk(parsed, clean);
                            yield { kind: "text", delta: clean, ...(hasReasoning ? {} : { raw: finishReason ? stripFinishReasonChunk(raw) : raw }) } as ParsedStreamEvent;
                        }
                } else if (!hasReasoning && (delta.role || (Object.keys(delta).length === 0 && !finishReason))) {
                    yield { kind: "meta", chunk: finishReason ? stripFinishReasonChunk(rawBuf) : rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                }
            }
        },

        emitText(delta) {
            return buildContent(delta);
        },

        emitReasoning(delta) {
            return buildReasoning(delta);
        },

        emitToolCall(call) {
            return buildToolCall(call);
        },

        emitMarker(toolName, result) {
            return buildContent(buildVisibilityMarker(toolName, result));
        },

        emitCompletion(opts?: EmitCompletionOpts) {
            const finishReason = opts?.finishReason ?? "stop";
            // Numeric fields must never serialize to absent/undefined: strict
            // clients (dsh's mapUsage) compute over prompt_tokens/completion_tokens
            // and a usage object missing them yields NaN (non-JSON-serializable).
            const usage = opts?.usage
                ? {
                      prompt_tokens: opts.usage.inputTokens ?? 0,
                      completion_tokens: opts.usage.outputTokens ?? 0,
                      total_tokens: (opts.usage.inputTokens ?? 0) + (opts.usage.outputTokens ?? 0),
                      ...(typeof opts.usage.cachedTokens === "number"
                          ? { prompt_tokens_details: { cached_tokens: opts.usage.cachedTokens } }
                          : {}),
                  }
                : null;
            return Buffer.concat([buildFinish(finishReason, usage), Buffer.from("data: [DONE]\n\n", "utf8")]);
        },

        emitError(message) {
            return Buffer.concat([
                buildContent(`\n[acp-proxy: ${message}]\n`),
                buildFinish("stop", null),
                Buffer.from("data: [DONE]\n\n", "utf8"),
            ]);
        },
    };
}
