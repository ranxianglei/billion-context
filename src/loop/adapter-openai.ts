import type { CoreMessage } from "acp-kernel";
import { coreToOpenai, injectOpenaiSystem } from "acp-kernel/wire";
import { buildVisibilityMarker } from "../compress-loop.js";
import type {
    CompressLoopAdapter,
    EmitCompletionOpts,
    ParsedStreamEvent,
    ToolCallEmit,
} from "./core.js";

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

export function createOpenaiAdapter(requestBody: Record<string, unknown>): CompressLoopAdapter {
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
            const messages = coreToOpenai(coreMessages);
            const withSys = injectOpenaiSystem(messages, [systemPrompt]);
            return { ...body, messages: withSys };
        },

        async *parseStream(upstream, _round) {
            const pending = new Map<number, ToolCallBuffer>();
            for await (const eventStr of iterSseChunks(upstream)) {
                const dataLine = eventStr.split("\n").find((l) => l.startsWith("data:"));
                if (!dataLine) continue;
                const jsonStr = dataLine.slice(5).trim();
                if (jsonStr === "[DONE]") {
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
                    yield { kind: "done", finishReason: "stop" } as ParsedStreamEvent;
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
                    let yieldedToolCall = false;
                    for (const [, tc] of pending) {
                        if (tc.name.length > 0 || tc.id.length > 0) {
                            yieldedToolCall = true;
                            yield {
                                kind: "tool_call",
                                name: tc.name,
                                callId: tc.id,
                                arguments: tc.arguments,
                            } as ParsedStreamEvent;
                        }
                    }
                    pending.clear();
                    const u = parsed.usage as Record<string, unknown> | undefined;
                    const pd = u?.prompt_tokens_details as Record<string, unknown> | undefined;
                    yield {
                        kind: "usage",
                        inputTokens: typeof u?.prompt_tokens === "number" ? u.prompt_tokens : undefined,
                        outputTokens: typeof u?.completion_tokens === "number" ? u.completion_tokens : undefined,
                        cachedTokens: typeof pd?.cached_tokens === "number" ? pd.cached_tokens : undefined,
                    } as ParsedStreamEvent;
                    yield {
                        kind: "done",
                        finishReason: yieldedToolCall && finishReason === "stop" ? "tool_calls" : finishReason,
                    } as ParsedStreamEvent;
                }

                if (!delta) continue;

                if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
                    yield { kind: "reasoning", delta: delta.reasoning_content, raw: rawBuf } as ParsedStreamEvent;
                }

                if (delta.tool_calls) {
                    const tcs = delta.tool_calls as Array<Record<string, unknown>>;
                    for (const tc of tcs) {
                        const idx = typeof tc.index === "number" ? tc.index : 0;
                        const fn = tc.function as Record<string, unknown> | undefined;
                        const name = typeof fn?.name === "string" ? fn.name : "";
                        const id = typeof tc.id === "string" ? tc.id : "";
                        const args = typeof fn?.arguments === "string" ? fn.arguments : "";
                        let buf = pending.get(idx);
                        if (!buf) {
                            buf = { index: idx, id, name, arguments: args };
                            pending.set(idx, buf);
                        } else {
                            if (id) buf.id = id;
                            if (name) buf.name = name;
                            buf.arguments += args;
                        }
                    }
                    if (typeof delta.content === "string" && delta.content.length > 0) {
                        yield { kind: "text", delta: delta.content } as ParsedStreamEvent;
                    }
                    continue;
                }

                const hasReasoning = typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0;
                if (typeof delta.content === "string" && delta.content.length > 0) {
                    yield { kind: "text", delta: delta.content, ...(hasReasoning ? {} : { raw: rawBuf }) } as ParsedStreamEvent;
                } else if (!hasReasoning && (delta.role || (Object.keys(delta).length === 0 && !finishReason))) {
                    yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
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
            const usage = opts?.usage
                ? {
                      prompt_tokens: opts.usage.inputTokens,
                      completion_tokens: opts.usage.outputTokens,
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
