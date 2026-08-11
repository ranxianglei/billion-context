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
import {
    parseCompressInput,
    PROXY_TOOL_NAMES,
} from "../compress-tool.js";
import { applyRanges } from "../stream.js";
import { resolveDecompress } from "../decompress-shared.js";
import { buildVisibilityMarker } from "../compress-loop.js";
import { fetchWithTimeout } from "../fetch-util.js";
import { proxyDispatcher } from "../upstream-proxy.js";
import { log as loggerLog } from "../logger.js";

export const MAX_LOOP_ROUNDS = 10;

export interface LoopCtx {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    originalMessages: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
    proxyUrl?: string;
    textProtocol?: boolean;
    debug?: boolean;
    nudge?: NudgeDecision;
}

export interface RequestOptions {
    url: string;
    headers: Record<string, string>;
}

export type ParsedStreamEvent =
    | { kind: "text"; delta: string; raw?: Buffer }
    | { kind: "tool_call"; name: string; callId: string; arguments: string }
    | { kind: "usage"; inputTokens?: number; outputTokens?: number; cachedTokens?: number }
    | { kind: "done"; finishReason?: string }
    | { kind: "meta"; chunk: Buffer; firstRoundOnly?: boolean };

export interface EmitCompletionOpts {
    finishReason?: string;
    usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
}

export interface ToolCallEmit {
    name: string;
    callId: string;
    arguments: string;
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
    if (typeof prompt === "number") ctx.session.stats.inputTokens += prompt;
    ctx.session.stats.lastInputTokens =
        (typeof prompt === "number" ? prompt : 0) + (typeof cached === "number" ? cached : 0);
    if (typeof cached === "number") ctx.session.stats.cachedTokens += cached;
    if (typeof out === "number") ctx.session.stats.outputTokens += out;
    ctx.session.stats.cacheSamples += 1;
    const hitPct =
        typeof prompt === "number" && typeof cached === "number" && prompt + cached > 0
            ? Math.round((cached / (prompt + cached)) * 100)
            : 0;
    ctx.log(
        `[acp-usage] round ${round} input=${ctx.session.stats.lastInputTokens} cached=${cached ?? 0} (cache hit ${hitPct}%)`,
    );
}

export async function* runCompressLoop(
    upstream: ReadableStream<Uint8Array>,
    ctx: LoopCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
    adapter: CompressLoopAdapter,
    systemPrompt: string,
): AsyncGenerator<Buffer> {
    let activeClearTimer: (() => void) | null = null;
    let currentUpstream = upstream;
    const coreMessages: CoreMessage[] = [...ctx.messages];

    try {
        for (let round = 1; round <= MAX_LOOP_ROUNDS; round++) {
            let assistantText = "";
            const calls: ToolCallEmit[] = [];
            let usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } = {};
            let finishReason: string | undefined;

            for await (const ev of adapter.parseStream(currentUpstream, round)) {
                if (ev.kind === "text") {
                    assistantText += ev.delta;
                    if (!ctx.textProtocol && round === 1 && ev.raw) {
                        yield ev.raw;
                    }
                } else if (ev.kind === "tool_call") {
                    calls.push({ name: ev.name, callId: ev.callId, arguments: ev.arguments });
                } else if (ev.kind === "usage") {
                    usage = {
                        inputTokens: ev.inputTokens,
                        outputTokens: ev.outputTokens,
                        cachedTokens: ev.cachedTokens,
                    };
                } else if (ev.kind === "done") {
                    finishReason = ev.finishReason;
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

            if (ctx.textProtocol && resolvedText.length > 0) {
                yield adapter.emitText(resolvedText);
            } else if (!ctx.textProtocol && round > 1 && resolvedText.length > 0) {
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
                if (resolvedText.length > 0) {
                    coreMessages.push({
                        id: `acp_loop_r${round}_asst`,
                        role: "assistant",
                        contentType: "text",
                        text: resolvedText,
                    });
                }
                for (const pr of proxyResults) {
                    if (ctx.textProtocol) {
                        coreMessages.push({
                            id: `acp_loop_r${round}_marker_${pr.callId}`,
                            role: "system",
                            contentType: "text",
                            text: buildVisibilityMarker(pr.name, pr.result),
                        });
                    } else {
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
                    }
                }
                if (!ctx.textProtocol) {
                    const hidden = hideConsumedCompressCalls(ctx.session.state, coreMessages);
                    if (hidden.hidden > 0) {
                        ctx.log(`[acp-loop] round ${round} hideConsumed hid ${hidden.hidden} compress record(s)`);
                        coreMessages.length = 0;
                        coreMessages.push(...hidden.messages);
                    }
                }
            }

            for (const tc of realToolCalls) {
                yield adapter.emitToolCall(tc);
            }

            // Fix A (align Pi): one compress per request. After a state-changing
            // proxy tool (compress/decompress), complete immediately and do NOT
            // re-request. Multi-round re-requests used a divergent request prefix
            // (re-request body != original forward) → a cache miss every compress
            // round, and the stale coreMessages view caused 0-char compress
            // failures. The compress system prompt encourages batching multiple
            // ranges in one trigger, so round 1 captures all compress calls; we
            // fold them into state, then complete.
            const stateChanged = proxyResults.some(pr => pr.name === "compress" || pr.name === "decompress");
            const reRequest = proxyResults.length > 0 && realCalls === 0 && !stateChanged;
            if (!reRequest) {
                if (stateChanged) ctx.log(`[acp-loop] round ${round}: state changed (compress/decompress); completing (one per request)`);
                yield adapter.emitCompletion({ finishReason, usage });
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

            ctx.log(`[acp-loop] round ${round}: non-mutating proxy tool (acp_status/search); re-requesting so the model sees the result`);

            const newBody = adapter.buildRequest(coreMessages, systemPrompt, requestBody);
            if (process.env.ACP_DUMP_REQ !== "0" && ctx.debug) {
                try {
                    const fs = await import("node:fs");
                    const dumpDir = process.env.ACP_DUMP_DIR || `${process.env.HOME}/.local/state/billion-context/dumps`;
                    fs.mkdirSync(dumpDir, { recursive: true });
                    const sid = ctx.session.id ?? "unknown";
                    fs.writeFileSync(`${dumpDir}/req-${Date.now()}-${sid}-REREQUEST.json`, JSON.stringify(newBody, null, 2));
                } catch { /* best-effort */ }
            }
            const { response: resp, clearTimer } = await fetchWithTimeout(requestOptions.url, {
                method: "POST",
                headers: requestOptions.headers,
                body: JSON.stringify(newBody),
                ...(ctx.proxyUrl ? { dispatcher: proxyDispatcher(ctx.proxyUrl) } : {}),
            });

            if (!resp.ok || !resp.body) {
                clearTimer();
                const errText = await resp.text().catch(() => "upstream error");
                ctx.log(`[acp-proxy: compress loop upstream error ${resp.status}: ${errText.slice(0, 200)}]`);
                loggerLog("error", `[acp-loop] upstream error ${resp.status}: ${errText.slice(0, 200)}`);
                yield adapter.emitError(`upstream error ${resp.status}: ${errText.slice(0, 200)}`);
                return;
            }

            currentUpstream = resp.body as ReadableStream<Uint8Array>;
            if (activeClearTimer) activeClearTimer();
            activeClearTimer = clearTimer;
        }
    } finally {
        if (activeClearTimer) {
            activeClearTimer();
            activeClearTimer = null;
        }
    }
}
