// #4019: non-stream OpenAI chat-completions proxy-tool loop.
//
// stream:true runs runCompressLoop (src/loop/core.ts): it executes every
// proxy-owned tool server-side, feeds the result back, and re-requests until the
// model yields a real client tool call or plain text. stream:false previously ran
// a ONE-SHOT rewriter (stream-openai.ts) that understood ONLY compress — every
// other proxy tool fell through as a "real" client tool and was passed to the
// client UNEXECUTED (finish_reason:"tool_calls") although the client never
// declared it, losing the model's answer for that turn.
//
// This gives the non-stream OpenAI path the same loop. Per round:
//   no proxy tools           -> terminal: delegate to the existing rewriter
//                               (tag-strip + nameless warn + real passthrough).
//   proxy + real client tool -> surface proxy results as text, keep real calls,
//                               NO re-request (streaming gate: needs realCalls==0).
//   proxy tools only         -> execute, build the function-calling continuation,
//                               re-request so the model can answer.
// The client always gets final text (or its own real tool calls), never
// undeclared proxy tool_calls.

import { drainPendingRetrievals } from "./store.js";
import { lastCompressSuffix, withSessionLock } from "./session.js";
import { buildVisibilityMarker, executeProxyToolAsync } from "./loop/core.js";
import { MAX_LOOP_ROUNDS } from "./loop/index.js";
import { isProxyToolFor } from "./absorb.js";
import { safePrefix } from "./text-safe.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import { fetchWithRetry, UpstreamHttpError, type ReplayRetryInfo } from "./fetch-util.js";
import { rewriteOpenaiJsonResponseAsync } from "./stream-openai.js";
import type { RewriteCtx } from "./stream.js";
import type { ProxyToolResult } from "./proxy-tool-result.js";

interface ParsedToolCall {
    id?: string;
    name: string;
    arguments: string;
}

interface ParsedOutput {
    text: string;
    reasoningContent?: string;
    toolCalls: ParsedToolCall[];
}

interface CompressLoopOpenaiOptions {
    signal?: AbortSignal;
    proxyUrl?: string;
    visibilityMarkers?: boolean;
}

interface CompressLoopOpenaiRequestOptions {
    url: string;
    headers: Record<string, string>;
    wireTransform?: (body: Record<string, unknown>) => Record<string, unknown>;
    resign?: (headers: Record<string, string>, body: string | Buffer) => void;
}

function parseOutput(response: Record<string, unknown>): ParsedOutput {
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = (first?.message ?? {}) as Record<string, unknown>;
    const rawContent = message.content;
    const text = typeof rawContent === "string" ? rawContent : "";
    // #539/#684: OpenAI-wire thinking models (DeepSeek et al.) REQUIRE the
    // assistant turn's reasoning_content echoed back on replay — dropping it
    // 400s the re-request ("reasoning_content ... must be passed back").
    const rawReasoning = message.reasoning_content;
    const reasoningContent = typeof rawReasoning === "string" && rawReasoning.length > 0 ? rawReasoning : undefined;
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls: ParsedToolCall[] = [];
    for (const tc of rawCalls) {
        const t = tc as Record<string, unknown>;
        const fn = (t.function ?? {}) as Record<string, unknown>;
        const name = typeof fn.name === "string" ? fn.name : "";
        const arguments_ = typeof fn.arguments === "string" ? fn.arguments : "";
        toolCalls.push({ id: typeof t.id === "string" ? t.id : undefined, name, arguments: arguments_ });
    }
    return { text, reasoningContent, toolCalls };
}

// Empty/malformed args yield {}: executeProxyToolAsync routes an empty compress
// input to the default-all-fold path, matching the rewriter's parseCompressInput.
function parseArgs(argumentsStr: string): Record<string, unknown> {
    const trimmed = argumentsStr.trim();
    if (trimmed.length === 0) return {};
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export async function compressLoopOpenaiJson(
    initialResponse: Record<string, unknown>,
    ctx: RewriteCtx,
    options: CompressLoopOpenaiOptions,
    requestBody: Record<string, unknown>,
    requestOptions: CompressLoopOpenaiRequestOptions,
): Promise<Record<string, unknown>> {
    const { session, config, log } = ctx;
    let current = initialResponse;

    // Surface executed proxy results as assistant text and replace tool_calls
    // with `kept` (the real client tools, if any) so the client never receives
    // undeclared proxy tool_calls.
    const finalize = (executed: { call: ParsedToolCall; result: ProxyToolResult }[], kept: ParsedToolCall[]): void => {
        const firstChoice = (Array.isArray(current.choices) ? current.choices[0] : {}) as Record<string, unknown>;
        const message = (firstChoice.message ?? {}) as Record<string, unknown>;
        const markerText = (options.visibilityMarkers === false
            ? []
            : executed.map(({ call, result }) => buildVisibilityMarker(call.name, result.text))
        ).join("\n\n");
        const existingText = typeof message.content === "string" ? message.content : "";
        message.content = existingText.length > 0 ? `${existingText}\n${markerText}` : markerText;
        // tool_calls live on the message in the OpenAI shape; finish_reason on the choice.
        message.tool_calls = kept.map((c) => ({ id: c.id ?? "", type: "function", function: { name: c.name, arguments: c.arguments } }));
        firstChoice.message = message;
        firstChoice.finish_reason = kept.length > 0 ? "tool_calls" : "stop";
    };

    for (let loopCount = 1; loopCount <= MAX_LOOP_ROUNDS; loopCount++) {
        const output = parseOutput(current);
        const allCalls = output.toolCalls.filter((c) => c.name.length > 0);
        const proxyCalls = allCalls.filter((c) => isProxyToolFor(c.name, session, config));
        const realCalls = allCalls.filter((c) => !isProxyToolFor(c.name, session, config));

        // No proxy tools: terminal round — reuse the existing single-round rewriter.
        if (proxyCalls.length === 0) {
            return (await rewriteOpenaiJsonResponseAsync(current, ctx, options.signal)) as Record<string, unknown>;
        }

        // Execute every proxy-owned call under the per-session lock (same path the
        // streaming loop drives via executeProxyToolAsync).
        const executed: { call: ParsedToolCall; result: ProxyToolResult }[] = [];
        for (const call of proxyCalls) {
            const result = await withSessionLock(session, () =>
                executeProxyToolAsync(call.name, parseArgs(call.arguments), ctx, call.id, call.arguments, options.signal),
            );
            executed.push({ call, result });
        }

        // Mixed round: surface proxy results, keep only real tool_calls, no
        // re-request (mirrors the streaming gate: re-request needs realCalls==0).
        if (realCalls.length > 0) {
            finalize(executed, realCalls);
            return current;
        }

        // Loop exhausted on proxy-only rounds: degrade gracefully rather than
        // hand undeclared proxy tool_calls to the client (bounded-degradation,
        // matching the responses-text loop).
        if (loopCount >= MAX_LOOP_ROUNDS) {
            log(`[compress-loop-limit] ${session.id} hit MAX_LOOP_ROUNDS (${MAX_LOOP_ROUNDS}) on non-stream OpenAI proxy loop; surfacing last results instead of re-requesting`);
            finalize(executed, []);
            return current;
        }

        // Proxy-only round: build the function-calling continuation (assistant
        // turn + tool results) and re-request so the model receives the result
        // and can produce its answer.
        const baseMessages = Array.isArray(requestBody.messages) ? (requestBody.messages as unknown[]) : [];
        const continuation: unknown[] = [
            ...baseMessages,
            {
                role: "assistant",
                content: output.text.length > 0 ? output.text : null,
                ...(output.reasoningContent !== undefined ? { reasoning_content: output.reasoningContent } : {}),
                tool_calls: proxyCalls.map((c) => ({ id: c.id ?? "", type: "function", function: { name: c.name, arguments: c.arguments } })),
            },
            ...executed.map(({ call, result }) => ({ role: "tool", tool_call_id: call.id ?? "", content: result.text })),
        ];
        // #1097: retrieval injections ride the re-request after their ack.
        for (const injection of drainPendingRetrievals(session)) continuation.push({ role: "user", content: injection.text ?? "" });
        requestBody.messages = continuation;

        const roundBody = JSON.stringify(requestOptions.wireTransform ? requestOptions.wireTransform(requestBody) : requestBody);
        requestOptions.resign?.(requestOptions.headers, roundBody);
        const retryLog = (info: ReplayRetryInfo) => {
            log(`[compress-loop-retry] ${session.id} attempt=${info.attempt}/${info.maxAttempts} delayMs=${info.delayMs} status=${info.status} detail=${safePrefix(info.detail, 120)} suffix=${lastCompressSuffix(session.lastCompress)}`);
        };
        let fetchResult: { response: Response; clearTimer: () => void };
        try {
            fetchResult = await fetchWithRetry(
                requestOptions.url,
                { method: "POST", headers: requestOptions.headers, body: roundBody, ...(options.proxyUrl ? { dispatcher: proxyDispatcher(options.proxyUrl) } : {}) },
                undefined,
                options.signal,
                retryLog,
            );
        } catch (e) {
            if (e instanceof UpstreamHttpError) {
                log(`[compress-loop-error] ${session.id} upstream failed after retries: status=${e.status} attempts=${e.attempts} body=${safePrefix(e.body, 500)} suffix=${lastCompressSuffix(session.lastCompress)}`);
            }
            throw e;
        }
        try {
            current = (await fetchResult.response.json()) as Record<string, unknown>;
        } finally {
            fetchResult.clearTimer();
        }
    }

    // Unreachable: every round returns (terminal/mixed/limit) or re-requests and
    // continues, and the final iteration always hits the limit branch.
    return current;
}
