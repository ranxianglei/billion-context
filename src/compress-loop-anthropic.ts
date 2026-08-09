import {
    buildStatusReport,
    estimateTokensFast,
    type CompressionCore,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import type { Session } from "./session.js";
import { parseCompressInput, PROXY_TOOL_NAMES } from "./compress-tool.js";
import { applyRanges } from "./stream.js";
import { resolveDecompress } from "./decompress-shared.js";
import { buildVisibilityMarker } from "./compress-loop.js";
import { fetchWithTimeout } from "./fetch-util.js";
import { normalizeSseLineEndings } from "./sse-util.js";

/** Anthropic SSE multi-round compress loop.
 *
 *  WHY THIS EXISTS: the Anthropic path previously used `rewriteSseStream` — a
 *  single-pass rewriter that intercepts proxy tool_use blocks and emits their
 *  result as a text delta TO THE CLIENT. That result never went back to the
 *  upstream LLM, so query-type tools (acp_status, search_context) broke the
 *  model's reasoning chain: the model called acp_status, proxy ran it, but
 *  the model never SAW the result → couldn't decide to compress next → the
 *  client hung ("Turn execution failed").
 *
 *  This loop mirrors compress-loop.ts (OpenAI chat) and
 *  compress-loop-responses.ts: intercept proxy tool_use → execute → push
 *  assistant(tool_use) + user(tool_result) back into the request → re-request
 *  upstream → loop until the model stops calling proxy tools. The tool RESULT
 *  reaches the model, so acp_status→compress flows work. */

interface CompressLoopAnthropicCtx {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
}

interface RequestOptions {
    url: string;
    headers: Record<string, string>;
}

interface ToolUseBlock {
    id: string;
    name: string;
    json: string;
}

function executeProxyTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: CompressLoopAnthropicCtx,
): string {
    if (toolName === "compress") {
        return applyRanges(parseCompressInput(args), ctx);
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
        return buildStatusReport(ctx.session.state, ctx.messages, estimateTokensFast);
    }
    return `[Unknown proxy tool: ${toolName}]`;
}

function parseAnthropicSse(eventStr: string): { type: string; data: Record<string, unknown> } | null {
    const lines = eventStr.split("\n");
    let type = "";
    const dataLines: string[] = [];
    for (const l of lines) {
        if (l.startsWith("event:")) {
            type = l.slice(6).trim();
        } else if (l.startsWith("data:")) {
            dataLines.push(l.slice(5).replace(/^ /, ""));
        }
    }
    if (!type) return null;
    const jsonStr = dataLines.join("\n").trim();
    if (!jsonStr) return { type, data: {} };
    try {
        return { type, data: JSON.parse(jsonStr) as Record<string, unknown> };
    } catch {
        return { type, data: {} };
    }
}

function buildTextBlockSse(index: number, text: string): string {
    return (
        `event: content_block_start\n` +
        `data: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\n` +
        `data: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } })}\n\n` +
        `event: content_block_stop\n` +
        `data: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`
    );
}

function buildTerminalSse(
    stopReason: string,
    outputTokens: number,
    messageId: string | undefined,
    model: string | undefined,
): string {
    const usage = { output_tokens: outputTokens };
    const extra: Record<string, unknown> = {};
    if (messageId) extra.id = messageId;
    if (model) extra.model = model;
    return (
        `event: message_delta\n` +
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage, ...extra })}\n\n` +
        `event: message_stop\n` +
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function remapIndex(json: string, oldIndex: number, newIndex: number): string {
    return json.replaceAll(`"index":${oldIndex}`, `"index":${newIndex}`)
        .replaceAll(`"index": ${oldIndex}`, `"index": ${newIndex}`);
}

function safeParse(s: string): Record<string, unknown> {
    try {
        const v = JSON.parse(s);
        return typeof v === "object" && v ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** Round-level state for the SSE processor.
 *  - `clientIndex`: next sequential index for a block the client WILL see
 *    (proxy tool_use blocks are suppressed — they don't consume a client index).
 *    Persists across rounds so round 2+ content continues after round 1.
 *  - `indexMap`: per-round mapping from upstream index → client index, so
 *    delta/stop events for non-proxy blocks find their assigned client index
 *    even after a proxy block was skipped (which creates a gap in upstream
 *    indices but not client indices). */
interface RoundState {
    clientIndex: number;
    toolBlocks: Map<number, ToolUseBlock>;
    indexMap: Map<number, number>;
}

export async function* compressLoopAnthropicStream(
    initialUpstream: ReadableStream<Uint8Array>,
    ctx: CompressLoopAnthropicCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
): AsyncGenerator<Buffer> {
    let upstream = initialUpstream;
    let activeClearTimer: (() => void) | null = null;
    try {
        const model = (requestBody.model as string) ?? undefined;
        let messageId: string | undefined;
        let clientIndex = 0;
        let totalOutputTokens = 0;

        for (let loopCount = 1; ; loopCount++) {
            if (loopCount > 10) {
                ctx.log("[acp-proxy: anthropic compress loop limit (10) reached, finishing]");
                yield Buffer.from(buildTerminalSse("end_turn", totalOutputTokens, messageId, model), "utf8");
                return;
            }
            const isFirstRound = loopCount === 1;
            const state: RoundState = { clientIndex, toolBlocks: new Map(), indexMap: new Map() };
            let hasRealToolUse = false;
            let roundText = "";
            let roundStopReason: string | undefined;

            const reader = upstream.getReader();
            const decoder = new TextDecoder("utf-8");
            let sseBuffer = "";
            const cbs: RouteCallbacks = {
                onRealToolUse: () => { hasRealToolUse = true; },
                onText: (t) => { roundText += t; },
                onOutputTokens: (n) => { totalOutputTokens += n; },
                onMessageId: (id) => { if (!messageId) messageId = id; },
                onStopReason: (r) => { roundStopReason = r; },
                onCacheUsage: (input, cached) => {
                    if (typeof input === "number") ctx.session.stats.inputTokens += input;
                    if (typeof cached === "number") {
                        ctx.session.stats.cachedTokens += cached;
                        ctx.session.stats.cacheSamples += 1;
                    }
                },
            };
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    sseBuffer += decoder.decode(value, { stream: true });
                    sseBuffer = normalizeSseLineEndings(sseBuffer);
                    let sep: number;
                    while ((sep = sseBuffer.indexOf("\n\n")) >= 0) {
                        const eventStr = sseBuffer.slice(0, sep);
                        sseBuffer = sseBuffer.slice(sep + 2);
                        if (!eventStr.trim()) continue;
                        for (const b of routeAnthropicEvent(eventStr, isFirstRound, state, cbs)) {
                            yield b;
                        }
                    }
                }
                sseBuffer += decoder.decode();
                sseBuffer = normalizeSseLineEndings(sseBuffer);
                let resSep: number;
                while ((resSep = sseBuffer.indexOf("\n\n")) >= 0) {
                    const eventStr = sseBuffer.slice(0, resSep);
                    sseBuffer = sseBuffer.slice(resSep + 2);
                    if (!eventStr.trim()) continue;
                    for (const b of routeAnthropicEvent(eventStr, isFirstRound, state, cbs)) {
                        yield b;
                    }
                }
            } finally {
                reader.releaseLock();
            }

            // Persist the clientIndex advance from this round.
            clientIndex = state.clientIndex;

            const proxyCalls = [...state.toolBlocks.values()].filter((b) => PROXY_TOOL_NAMES.has(b.name));
            const hasOnlyProxy = proxyCalls.length > 0 && !hasRealToolUse;

            if (!hasOnlyProxy) {
                const stop = hasRealToolUse ? "tool_use" : (roundStopReason ?? "end_turn");
                yield Buffer.from(buildTerminalSse(stop, totalOutputTokens, messageId, model), "utf8");
                return;
            }

            const names = proxyCalls.map((c) => c.name).join(", ");
            ctx.log(`[acp-proxy: anthropic round ${loopCount} — ${proxyCalls.length} proxy call(s): ${names}]`);

            const messages = (requestBody.messages as Array<Record<string, unknown>>) ?? [];
            const assistantContent: Record<string, unknown>[] = [];
            if (roundText.length > 0) {
                assistantContent.push({ type: "text", text: roundText });
            }
            for (const tc of proxyCalls) {
                assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeParse(tc.json) });
            }
            messages.push({ role: "assistant", content: assistantContent });

            for (const tc of proxyCalls) {
                const args = safeParse(tc.json);
                const result = executeProxyTool(tc.name, args, ctx);
                const preview = result.length > 120 ? result.slice(0, 120) + "..." : result;
                ctx.log(`[acp-proxy: ${tc.name} (${tc.id}) → ${preview.replace(/\n/g, " ")}]`);
                yield Buffer.from(buildTextBlockSse(clientIndex, buildVisibilityMarker(tc.name, result)), "utf8");
                clientIndex++;
                messages.push({
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: tc.id, content: result }],
                });
            }

            requestBody.messages = messages;

            const { response: resp, clearTimer } = await fetchWithTimeout(requestOptions.url, {
                method: "POST",
                headers: requestOptions.headers,
                body: JSON.stringify(requestBody),
            });

            if (!resp.ok || !resp.body) {
                const errText = await resp.text().catch(() => "upstream error");
                ctx.log(`[acp-proxy: anthropic compress loop upstream error ${resp.status}: ${errText.slice(0, 200)}]`);
                yield Buffer.from(buildTextBlockSse(clientIndex, `\n[acp-proxy: upstream error ${resp.status}: ${errText.slice(0, 200)}]\n`), "utf8");
                yield Buffer.from(buildTerminalSse("end_turn", totalOutputTokens, messageId, model), "utf8");
                return;
            }

            upstream = resp.body as ReadableStream<Uint8Array>;
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

interface RouteCallbacks {
    onRealToolUse: () => void;
    onText: (t: string) => void;
    onOutputTokens: (n: number) => void;
    onMessageId: (id: string) => void;
    onStopReason: (r: string) => void;
    onCacheUsage: (input: number | undefined, cached: number | undefined) => void;
}

function routeAnthropicEvent(
    eventStr: string,
    isFirstRound: boolean,
    state: RoundState,
    cb: RouteCallbacks,
): Buffer[] {
    const parsed = parseAnthropicSse(eventStr);
    if (!parsed) return [];
    const { type, data } = parsed;

    if (type === "message_start") {
        const msg = (data.message ?? {}) as Record<string, unknown>;
        if (typeof msg.id === "string") cb.onMessageId(msg.id);
        const u = (msg.usage ?? {}) as Record<string, unknown>;
        cb.onCacheUsage(u.input_tokens as number | undefined, u.cache_read_input_tokens as number | undefined);
        // message_start is only valid once per SSE response. Forward it in
        // round 1; suppress in all subsequent rounds (client already has it).
        return isFirstRound ? [Buffer.from(eventStr + "\n\n", "utf8")] : [];
    }

    if (type === "ping") {
        return [Buffer.from(eventStr + "\n\n", "utf8")];
    }

    if (type === "content_block_start") {
        const upstreamIndex = (data.index as number) ?? 0;
        const block = (data.content_block ?? {}) as Record<string, unknown>;
        if (block.type === "tool_use") {
            const name = typeof block.name === "string" ? block.name : "";
            const id = typeof block.id === "string" ? block.id : `toolu_${upstreamIndex}`;
            if (PROXY_TOOL_NAMES.has(name)) {
                state.toolBlocks.set(upstreamIndex, { id, name, json: "" });
                return [];
            }
            cb.onRealToolUse();
        }
        const ci = state.clientIndex++;
        state.indexMap.set(upstreamIndex, ci);
        if (isFirstRound) return [Buffer.from(eventStr + "\n\n", "utf8")];
        return [Buffer.from(remapIndex(eventStr + "\n\n", upstreamIndex, ci), "utf8")];
    }

    if (type === "content_block_delta") {
        const upstreamIndex = (data.index as number) ?? 0;
        const delta = (data.delta ?? {}) as Record<string, unknown>;
        if (state.toolBlocks.has(upstreamIndex)) {
            if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                state.toolBlocks.get(upstreamIndex)!.json += delta.partial_json;
            }
            return [];
        }
        if (delta.type === "text_delta" && typeof delta.text === "string") cb.onText(delta.text);
        if (isFirstRound) return [Buffer.from(eventStr + "\n\n", "utf8")];
        const ci = state.indexMap.get(upstreamIndex) ?? upstreamIndex;
        return [Buffer.from(remapIndex(eventStr + "\n\n", upstreamIndex, ci), "utf8")];
    }

    if (type === "content_block_stop") {
        const upstreamIndex = (data.index as number) ?? 0;
        if (state.toolBlocks.has(upstreamIndex)) return [];
        if (isFirstRound) return [Buffer.from(eventStr + "\n\n", "utf8")];
        const ci = state.indexMap.get(upstreamIndex) ?? upstreamIndex;
        return [Buffer.from(remapIndex(eventStr + "\n\n", upstreamIndex, ci), "utf8")];
    }

    if (type === "message_delta") {
        const u = (data.usage ?? {}) as Record<string, unknown>;
        const out = u.output_tokens as number | undefined;
        if (typeof out === "number") cb.onOutputTokens(out);
        const d = (data.delta ?? {}) as Record<string, unknown>;
        if (typeof d.stop_reason === "string") cb.onStopReason(d.stop_reason);
        // ALWAYS suppress — we emit our own terminal SSE at the end with
        // accumulated output_tokens across all rounds. Forwarding the upstream
        // message_delta here would close the response prematurely.
        return [];
    }

    if (type === "message_stop") {
        return [];
    }

    return isFirstRound ? [Buffer.from(eventStr + "\n\n", "utf8")] : [];
}
