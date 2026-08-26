import {
    buildStatusReport,
    estimateTokensFast,
    formatRanges,
    hideConsumedCompressCalls,
    type CompressionCore,
    type Config,
    type CoreMessage,
    type NudgeDecision,
} from "acp-kernel";
import type { Session } from "../session.js";
import type { BiliMessage } from "acp-kernel/wire";
import {
    parseCompressInput,
    PROXY_TOOL_NAMES,
} from "../compress-tool.js";
import { applyRanges } from "../stream.js";
import { resolveDecompress } from "../decompress-shared.js";
import { buildVisibilityMarker } from "../compress-loop.js";
import { fetchWithRetry, UpstreamHttpError } from "../fetch-util.js";
import { proxyDispatcher } from "../upstream-proxy.js";
import { log as loggerLog } from "../logger.js";
import { applyUsageFloor, pendingEstimateTokens, type WireProtocol } from "../util.js";

export const MAX_LOOP_ROUNDS = 10;

function isLoopThinking(m: CoreMessage): boolean {
    return m.contentType === "reasoning" && typeof m.id === "string" && m.id.startsWith("acp_loop_");
}

function stripLoopThinking(messages: CoreMessage[]): CoreMessage[] {
    return messages.filter((m) => !isLoopThinking(m));
}

export interface LoopCtx {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    /** View handed to applyCompression (see RewriteCtx.compressMessages). */
    compressMessages?: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
    proxyUrl?: string;
    textProtocol?: boolean;
    debug?: boolean;
    nudge?: NudgeDecision;
    // Which wire protocol produced the usage the loop records. Needed to
    // compute the true context total correctly (Anthropic reports
    // input_tokens as NEW-only; OpenAI/Responses report the TOTAL).
    protocol?: WireProtocol;
}

export interface RequestOptions {
    url: string;
    headers: Record<string, string>;
}

export type ParsedStreamEvent =
    | { kind: "text"; delta: string; raw?: Buffer }
    | { kind: "reasoning"; delta: string; raw?: Buffer; signature?: string; blockEnd?: boolean }
    | { kind: "tool_call"; name: string; callId: string; arguments: string; passthrough?: boolean }
    | { kind: "usage"; inputTokens?: number; outputTokens?: number; cachedTokens?: number }
    | { kind: "done"; finishReason?: string; suppressCompletion?: boolean }
    | { kind: "meta"; chunk: Buffer; firstRoundOnly?: boolean };

export interface EmitCompletionOpts {
    finishReason?: string;
    usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
}

export interface ToolCallEmit {
    name: string;
    callId: string;
    arguments: string;
    passthrough?: boolean;
}

export interface ExtractedTextTriggers {
    clean: string;
    calls: ToolCallEmit[];
}

export interface CompressLoopAdapter {
    buildRequest(
        coreMessages: CoreMessage[],
        systemPrompt: string,
        requestBody: Record<string, unknown>,
    ): Record<string, unknown>;
    parseStream(upstream: ReadableStream<Uint8Array>, round: number): AsyncGenerator<ParsedStreamEvent>;
    emitText(delta: string): Buffer;
    emitReasoning?(delta: string): Buffer;
    emitToolCall(call: ToolCallEmit): Buffer;
    emitMarker(toolName: string, result: string): Buffer;
    emitCompletion(opts?: EmitCompletionOpts): Buffer;
    emitError(message: string): Buffer;
    extractTextTriggers?(text: string): ExtractedTextTriggers;
}

export function executeProxyTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: LoopCtx,
    callId?: string,
): string {
    if (toolName === "compress") {
        return applyRanges(parseCompressInput(args, callId), ctx);
    }
    if (toolName === "decompress") {
        return resolveDecompress(args, ctx);
    }
    if (toolName === "search_context") {
        const query = typeof args.query === "string" ? args.query : "";
        if (query.length === 0) return "[search_context FAILED: query is required]";
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
        const blocks = ctx.core.search(query, ctx.session.state).slice(0, limit);
        if (blocks.length === 0) return `[No blocks matched "${query}"]`;
        const lines = blocks.map((b) => {
            const topic = b.topic ?? "(no topic)";
            const preview = b.summary.length > 200 ? b.summary.slice(0, 200) + "..." : b.summary;
            return `${b.blockId} (T${b.tier}) "${topic}"\n  ${preview}`;
        });
        return `Found ${blocks.length} block(s) for "${query}":\n\n${lines.join("\n\n")}`;
    }
    if (toolName === "acp_status") {
        return handleAcpStatus(args, ctx);
    }
    return `[Unknown proxy tool: ${toolName}]`;
}

// Aligns with billion-context-pi's handleStatus: appends compressible ranges
// to the default overview so the model picks valid refs (else it guesses
// covered/protected refs → 0-char compress failures).
function handleAcpStatus(args: Record<string, unknown>, ctx: LoopCtx): string {
    const scope = typeof args.scope === "string" ? (args.scope as "compressed" | "uncompressed") : undefined;
    const view = typeof args.view === "string" ? (args.view as "ranges" | "messages") : undefined;
    const tool = typeof args.tool === "string" ? args.tool : undefined;
    const sort = typeof args.sort === "string" ? (args.sort as "size" | "time" | "tool" | "age") : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const base = buildStatusReport(ctx.session.state, ctx.messages, estimateTokensFast, { scope, view, tool, sort, limit });
    if (scope) return base;
    const nudge = ctx.nudge;
    const ranges = nudge?.compressibleRanges ?? [];
    const protectedRanges = nudge?.protectedRanges ?? [];
    const extra: string[] = [];
    if (nudge) {
        extra.push("");
        extra.push(nudge.shouldInject ? `Nudge: ACTIVE — ${nudge.reason}` : `Nudge: idle — ${nudge.reason}`);
    }
    if (ranges.length > 0 || protectedRanges.length > 0) {
        extra.push("");
        extra.push(formatRanges(ranges, protectedRanges));
    }
    return extra.length > 0 ? `${base}\n${extra.join("\n")}` : base;
}

function recordUsage(
    ctx: LoopCtx,
    usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number },
    round: number,
): void {
    const prompt = usage.inputTokens;
    const cached = usage.cachedTokens;
    const out = usage.outputTokens;
    // Adapters emit `inputTokens` in protocol-native units: Anthropic's
    // `input_tokens` is the NEW (uncached) portion only (cached reported
    // separately), while OpenAI/Responses report the TOTAL (cached already
    // included). Add `cached` back in ONLY when it is not already part of
    // `prompt` — otherwise the cached portion is double-counted, inflating the
    // context size (→ premature compression) and deflating the hit rate.
    const includesCached = ctx.protocol === "openai" || ctx.protocol === "responses";
    const total =
        (typeof prompt === "number" ? prompt : 0) +
        (!includesCached && typeof cached === "number" ? cached : 0);
    if (total > 0) ctx.session.stats.inputTokens += total;
    // Floor the relay-reported size against the kernel's own estimate: some
    // relays under-report input_tokens (issue #256), which would keep the
    // nudge — keyed on lastInputTokens — permanently idle. Billing above
    // stays raw; only the nudge input is floored.
    const effective = applyUsageFloor(total, pendingEstimateTokens(ctx.nudge));
    if (effective !== total) {
        ctx.log(`[acp-usage] round ${round} upstream under-reported usage: reported=${total} < kernel-estimate=${effective} — flooring (relay usage unreliable)`);
    }
    // Net out this turn's compress credit: the post-compress re-request
    // re-sends the unfolded history, so its usage report over-reports the
    // context the NEXT request will actually carry (see stream.ts applyRanges).
    ctx.session.stats.lastInputTokens = Math.max(0, effective - (ctx.session.stats.compressCreditTokens ?? 0));
    if (typeof cached === "number") {
        ctx.session.stats.cachedTokens += cached;
        ctx.session.stats.cacheSamples += 1;
    }
    if (typeof out === "number") ctx.session.stats.outputTokens += out;
    const hitPct =
        typeof cached === "number" && total > 0 ? Math.round((cached / total) * 100) : 0;
    ctx.log(
        `[acp-usage] round ${round} input=${total} cached=${cached ?? 0} (cache hit ${hitPct}%)`,
    );
}

export async function* runCompressLoop(
    upstream: ReadableStream<Uint8Array>,
    ctx: LoopCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
    adapter: CompressLoopAdapter,
    systemPrompt: string,
    signal?: AbortSignal,
): AsyncGenerator<Buffer> {
    let activeClearTimer: (() => void) | null = null;
    let currentUpstream = upstream;
    const coreMessages: CoreMessage[] = [...ctx.messages];
    let degradedRetried = false;

    try {
        for (let round = 1; round <= MAX_LOOP_ROUNDS; round++) {
            if (signal?.aborted) break;
            let assistantText = "";
            let assistantReasoning = "";
            const reasoningSegments: { text: string; signature: string }[] = [];
            let reasoningSealed = true;
            const calls: ToolCallEmit[] = [];
            let usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } = {};
            let finishReason: string | undefined;
            let sawDone = false;
            let suppressCompletion = false;

            for await (const ev of adapter.parseStream(currentUpstream, round)) {
                if (signal?.aborted) break;
                    if (ev.kind === "text") {
                        assistantText += ev.delta;
                        if (!ctx.textProtocol && ev.raw) {
                            yield ev.raw;
                        } else if (!ctx.textProtocol && round > 1 && ev.delta.length > 0) {
                            yield adapter.emitText(ev.delta);
                        }
                    } else if (ev.kind === "reasoning") {
                        assistantReasoning += ev.delta;
                        let seg = reasoningSegments[reasoningSegments.length - 1];
                        if (reasoningSealed || !seg) {
                            seg = { text: "", signature: "" };
                            reasoningSegments.push(seg);
                            reasoningSealed = false;
                        }
                        seg.text += ev.delta;
                        if (ev.signature) seg.signature += ev.signature;
                        if (ev.blockEnd) reasoningSealed = true;
                        if (!ctx.textProtocol) {
                            if (ev.raw) {
                                yield ev.raw;
                            } else if (round > 1 && ev.delta.length > 0 && adapter.emitReasoning) {
                                yield adapter.emitReasoning(ev.delta);
                            }
                        }
                    } else if (ev.kind === "tool_call") {
                    calls.push({ name: ev.name, callId: ev.callId, arguments: ev.arguments, passthrough: ev.passthrough });
                } else if (ev.kind === "usage") {
                    usage = {
                        inputTokens: ev.inputTokens,
                        outputTokens: ev.outputTokens,
                        cachedTokens: ev.cachedTokens,
                    };
                } else if (ev.kind === "done") {
                    sawDone = true;
                    finishReason = ev.finishReason;
                    suppressCompletion = ev.suppressCompletion === true;
                } else if (ev.kind === "meta") {
                    if (round === 1 || !ev.firstRoundOnly) {
                        yield ev.chunk;
                    }
                }
            }

            if (
                usage.inputTokens !== undefined ||
                usage.outputTokens !== undefined ||
                usage.cachedTokens !== undefined
            ) {
                recordUsage(ctx, usage, round);
            }

            let resolvedText = assistantText;
            let allCalls = calls;
            if (ctx.textProtocol && assistantText.length > 0 && adapter.extractTextTriggers) {
                const extracted = adapter.extractTextTriggers(assistantText);
                resolvedText = extracted.clean;
                allCalls = [...calls, ...extracted.calls];
            }
            const functionCallIds = new Set(calls.map(c => c.callId));

            if (ctx.textProtocol && resolvedText.length > 0) {
                yield adapter.emitText(resolvedText);
            }

            let realCalls = 0;
            const realToolCalls: ToolCallEmit[] = [];
            const proxyResults: { name: string; callId: string; result: string; arguments: string }[] = [];

            for (const call of allCalls) {
                if (PROXY_TOOL_NAMES.has(call.name)) {
                    let parsedArgs: Record<string, unknown>;
                    try {
                        parsedArgs = call.arguments.length > 0 ? JSON.parse(call.arguments) : {};
                    } catch {
                        parsedArgs = {};
                    }
                    const result = executeProxyTool(call.name, parsedArgs, ctx, call.callId);
                    proxyResults.push({ name: call.name, callId: call.callId, result, arguments: call.arguments });
                    yield adapter.emitMarker(call.name, result);
                } else {
                    realToolCalls.push(call);
                    realCalls += 1;
                }
            }

            if (ctx.debug) {
                const callSummary = allCalls.map(c => {
                    const argSnippet = c.arguments.length > 200 ? c.arguments.slice(0, 200) + "..." : c.arguments;
                    return `${c.name}(${argSnippet})`;
                }).join(" | ");
                ctx.log(`[acp-loop] round ${round}: ${allCalls.length} call(s): ${callSummary || "(none)"}`);
                for (const pr of proxyResults) {
                    const resSnippet = pr.result.length > 300 ? pr.result.slice(0, 300) + "..." : pr.result;
                    ctx.log(`[acp-loop]   → ${pr.name} result: ${resSnippet}`);
                }
                if (realCalls > 0) ctx.log(`[acp-loop] round ${round}: ${realCalls} real tool call(s) forwarded to client`);
            }

            // Per-round hygiene (fixes the injection-persistence 炸锅): the
            // philosophy systemPrompt is transient (passed fresh to buildRequest,
            // never in coreMessages), and hideConsumedCompressCalls runs each
            // round so consumed compress records cannot re-prime the model.
            if (proxyResults.length > 0) {
                if (reasoningSegments.length > 0) {
                    for (let i = 0; i < reasoningSegments.length; i++) {
                        const seg = reasoningSegments[i];
                        if (seg.text.length === 0 || seg.signature.length === 0) continue;
                        const reasoningMsg: BiliMessage = {
                            id: i === 0 ? `acp_loop_r${round}_reasoning` : `acp_loop_r${round}_reasoning_${i + 1}`,
                            role: "assistant",
                            contentType: "reasoning",
                            text: seg.text,
                            reasoningContent: seg.text,
                            ...(seg.signature.length > 0 ? { thinkingSignature: seg.signature } : {}),
                        };
                        coreMessages.push(reasoningMsg);
                    }
                }
                if (assistantText.length > 0) {
                    coreMessages.push({
                        id: `acp_loop_r${round}_asst`,
                        role: "assistant",
                        contentType: "text",
                        text: assistantText,
                    });
                }
                for (const pr of proxyResults) {
                    if (functionCallIds.has(pr.callId)) {
                        coreMessages.push({
                            id: `acp_loop_r${round}_asst_tc_${pr.callId}`,
                            role: "assistant",
                            contentType: "tool-call",
                            toolName: pr.name,
                            toolCallId: pr.callId,
                            text: pr.arguments,
                        });
                        coreMessages.push({
                            id: `acp_loop_r${round}_tool_${pr.callId}`,
                            role: "tool",
                            contentType: "tool-result",
                            toolCallId: pr.callId,
                            text: pr.result,
                        });
                    } else {
                        coreMessages.push({
                            id: `acp_loop_r${round}_marker_${pr.callId}`,
                            role: "system",
                            contentType: "text",
                            text: buildVisibilityMarker(pr.name, pr.result),
                        });
                    }
                }
                const anyCompressFailed = proxyResults.some(
                    (pr) => (pr.name === "compress" || pr.name === "decompress") && pr.result.includes("FAILED"),
                );
                if (!ctx.textProtocol && !anyCompressFailed) {
                    const hidden = hideConsumedCompressCalls(ctx.session.state, coreMessages);
                    if (hidden.hidden > 0) {
                        ctx.log(`[acp-loop] round ${round} hideConsumed hid ${hidden.hidden} compress record(s)`);
                        coreMessages.length = 0;
                        coreMessages.push(...hidden.messages);
                    }
                }
            }

            for (const tc of realToolCalls) {
                if (tc.passthrough) continue;
                yield adapter.emitToolCall(tc);
            }

            // Re-request so the model receives the proxy-tool result and can
            // continue (standard function-calling continuation: the proxy acts as
            // the client, executes compress/decompress/acp_status/search, then
            // feeds the result back as a normal tool output via functionCallIds
            // above — success OR failure alike). The model sees the result and
            // decides its next action (retry a different range, or stop). A failed
            // compress returns its failure as the tool output, so the model is not
            // blind to why it failed. MAX_LOOP_ROUNDS bounds runaway loops.
            const reRequest = proxyResults.length > 0 && realCalls === 0;
            if (!reRequest) {
                if (!sawDone) {
                    const partialText = assistantText.length;
                    const partialReasoning = assistantReasoning.length;
                    const msg = `upstream stream truncated (no completion event; round ${round}, ${partialText} text chars + ${partialReasoning} reasoning chars received)`;
                    ctx.log(`[acp-loop] round ${round}: ${msg}`);
                    loggerLog("error", `[acp-loop] ${msg}`);
                    yield adapter.emitError(msg);
                    return;
                }
                // A passthrough round already streamed the upstream's own finish
                // chunk + [DONE] verbatim (original id + order); re-emitting a
                // regenerated completion would duplicate them.
                if (!suppressCompletion) {
                    yield adapter.emitCompletion({ finishReason, usage });
                }
                return;
            }

            // Graceful termination at the loop limit — NEVER a degenerate empty
            // completion; surface whatever text/markers were produced this round.
            if (round >= MAX_LOOP_ROUNDS) {
                ctx.log(`[acp-loop] round ${round} hit MAX_LOOP_ROUNDS; completing gracefully`);
                loggerLog("warn", `[acp-loop] loop limit (${MAX_LOOP_ROUNDS}) reached; completing gracefully`);
                yield adapter.emitCompletion({ finishReason: "length", usage });
                return;
            }

            ctx.log(`[acp-loop] round ${round}: proxy tool executed; re-requesting so the model sees the result`);

            if (signal?.aborted) break;

            const fetchUpstream = (body: Record<string, unknown>) =>
                fetchWithRetry(
                    requestOptions.url,
                    {
                        method: "POST",
                        headers: requestOptions.headers,
                        body: JSON.stringify(body),
                        ...(ctx.proxyUrl ? { dispatcher: proxyDispatcher(ctx.proxyUrl) } : {}),
                    },
                    undefined,
                    signal,
                    (info) => {
                        ctx.log(`[acp-proxy: upstream rejected replay (HTTP ${info.status}: ${info.detail.slice(0, 120)}); likely provider risk-control — retrying in ${info.delayMs}ms (attempt ${info.attempt}/${info.maxAttempts})]`);
                        loggerLog("warn", `[acp-loop] upstream rejected replay (HTTP ${info.status}); retrying in ${info.delayMs}ms (attempt ${info.attempt}/${info.maxAttempts})`);
                    },
                );

            let newBody = adapter.buildRequest(coreMessages, systemPrompt, requestBody);
            if (process.env.ACP_DUMP_REQ !== "0" && ctx.debug) {
                try {
                    const fs = await import("node:fs");
                    const dumpDir = process.env.ACP_DUMP_DIR || `${process.env.HOME}/.local/state/billion-context/dumps`;
                    fs.mkdirSync(dumpDir, { recursive: true });
                    const sid = ctx.session.id ?? "unknown";
                    fs.writeFileSync(`${dumpDir}/req-${Date.now()}-${sid}-REREQUEST.json`, JSON.stringify(newBody, null, 2));
                } catch { /* best-effort */ }
            }
            let respResult: { response: Response; clearTimer: () => void };
            try {
                try {
                    respResult = await fetchUpstream(newBody);
                } catch (e) {
                    if (
                        !(e instanceof UpstreamHttpError) ||
                        e.status < 400 ||
                        e.status >= 500 ||
                        degradedRetried ||
                        !coreMessages.some(isLoopThinking)
                    ) {
                        throw e;
                    }
                    degradedRetried = true;
                    const stripped = stripLoopThinking(coreMessages);
                    coreMessages.length = 0;
                    coreMessages.push(...stripped);
                    ctx.log(`[acp-loop] round ${round}: re-request rejected (${e.status}: ${e.body.slice(0, 200)}); retrying without replayed thinking blocks`);
                    loggerLog("warn", `[acp-loop] re-request rejected (${e.status}); retrying without thinking replay: ${e.body.slice(0, 200)}`);
                    newBody = adapter.buildRequest(coreMessages, systemPrompt, requestBody);
                    respResult = await fetchUpstream(newBody);
                }
            } catch (e) {
                if (!(e instanceof UpstreamHttpError)) throw e;
                const suffix = e.attempts > 1 ? ` after ${e.attempts} attempt(s)` : "";
                ctx.log(`[acp-proxy: compress loop upstream error ${e.status}${suffix}: ${e.body.slice(0, 200)}]`);
                loggerLog("error", `[acp-loop] upstream error ${e.status}${suffix}: ${e.body.slice(0, 200)}`);
                yield adapter.emitError(`upstream error ${e.status}${suffix}: ${e.body.slice(0, 200)}`);
                return;
            }

            if (!respResult.response.body) {
                respResult.clearTimer();
                yield adapter.emitError(`upstream error ${respResult.response.status}: empty response body`);
                return;
            }

            currentUpstream = respResult.response.body as ReadableStream<Uint8Array>;
            if (activeClearTimer) activeClearTimer();
            activeClearTimer = respResult.clearTimer;
        }
    } finally {
        if (activeClearTimer) {
            activeClearTimer();
            activeClearTimer = null;
        }
    }
}
