import { buildStatusReport, collectBlockContent, estimateTokensFast, type CompressionCore, type Config, type CoreMessage, type CompressionState } from "acp-kernel";
import { type Session, cacheBlockContent } from "./session.js";
import { COMPRESS_TOOL_NAME, parseCompressInput, PROXY_TOOL_NAMES } from "./compress-tool.js";
import { ABSORB_TOOL_NAME, executeAbsorb } from "./absorb.js";
import { resolveDecompress } from "./decompress-shared.js";
import { normalizeSseLineEndings } from "./sse-util.js";

export type RewriteCtx = {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
    debug?: boolean;
};

type BlockState = { toolName: string | null; json: string; hadRealToolUse: boolean };

const NOOP = Symbol("noop");

export async function* rewriteSseStream(
    upstream: ReadableStream<Uint8Array>,
    ctx: RewriteCtx,
): AsyncGenerator<Buffer> {
    const reader = upstream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    const blocks = new Map<number, BlockState>();
    let convertedAny = false;
    let sawRealToolUse = false;
    let capturedUsage: Record<string, unknown> | undefined;
    let output = "";

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
                const ev = parseSseEvent(rawEvent);
                if (!ev) continue;
                const routed = routeEvent(ev, blocks, ctx, (c) => (convertedAny = c || convertedAny), () => (sawRealToolUse = true), () => convertedAny, (u) => (capturedUsage = u));
                if (routed === NOOP) continue;
                output += routed;
                if (output.length >= 8192) yield flush();
            }
        }
        if (convertedAny) {
            const finalDelta = buildStopReasonRewrite(sawRealToolUse, capturedUsage);
            if (finalDelta) output += finalDelta;
        }
        if (buf) {
            output += buf;
            buf = "";
        }
        if (output) yield flush();
    } finally {
        reader.releaseLock();
    }
}

function routeEvent(
    ev: SseEvent,
    blocks: Map<number, BlockState>,
    ctx: RewriteCtx,
    markConverted: (v: boolean) => void,
    markRealToolUse: () => void,
    getConverted: () => boolean,
    setUsage: (u: Record<string, unknown>) => void,
): string | typeof NOOP {
    const d = ev.data;
    if (!d || typeof d !== "object") return emitEvent(ev);
    const t = (d as { type?: string }).type;
    if (t === "content_block_start") {
        const index = (d as { index?: number }).index ?? 0;
        const cb = (d as { content_block?: { type?: string; name?: string } }).content_block;
        if (cb?.type === "tool_use" && typeof cb.name === "string" && PROXY_TOOL_NAMES.has(cb.name)) {
            blocks.set(index, { toolName: cb.name, json: "", hadRealToolUse: false });
            markConverted(true);
            return NOOP;
        }
        if (cb?.type === "tool_use") markRealToolUse();
        return emitEvent(ev);
    }
    if (t === "content_block_delta") {
        const index = (d as { index?: number }).index ?? 0;
        const st = blocks.get(index);
        if (st && st.toolName) {
            const partial = (d as { delta?: { partial_json?: string } }).delta?.partial_json;
            if (typeof partial === "string") st.json += partial;
            return NOOP;
        }
        const dt = (d as { delta?: { text?: string } }).delta;
        if (dt?.text && (dt.text.includes("\x3cacp ") || dt.text.includes("\x3c/acp"))) {
            ctx.log(`[warn: tag echo] model emitted <acp tag in text delta: ${dt.text.slice(0, 120).replace(/\n/g, " ")}`);
        }
        return emitEvent(ev);
    }
    if (t === "content_block_stop") {
        const index = (d as { index?: number }).index ?? 0;
        const st = blocks.get(index);
        if (st && st.toolName) {
            blocks.delete(index);
            return emitToolReplacement(st.toolName, st.json, ctx, index);
        }
        return emitEvent(ev);
    }
    // Suppress terminal events ONLY when we converted a compress tool_use
    // (we re-emit a rewritten stop reason at stream end). Without this guard,
    // plain text responses (the common case) never receive message_delta /
    // message_stop and the client hangs until timeout.
    // While here, record upstream usage into the session for the web UI / stats
    // — but ONLY on the non-converted path (when we replaced the response with
    // a compress note, the upstream usage is not the real completion).
    if (t === "message_delta") {
        // Capture upstream usage on BOTH paths: when not converted we need it
        // for stats; when converted (tool_use replaced by text) the upstream
        // message_delta is suppressed (NOOP below) but we still need its usage
        // to emit a well-formed synthetic message_delta — ZCode's Zod schema
        // requires usage.output_tokens:number, so hardcoding {} fails.
        const u = (d as { usage?: Record<string, unknown> }).usage;
        if (u) {
            setUsage(u);
            if (!getConverted()) {
                const out = u.output_tokens;
                if (typeof out === "number") ctx.session.stats.outputTokens += out;
            }
        }
        return getConverted() ? NOOP : emitEvent(ev);
    }
    if (t === "message_start" && !getConverted()) {
        const u = (d as { message?: { usage?: Record<string, unknown> } }).message?.usage;
        if (u) {
            const inp = u.input_tokens;
            const cc = u.cache_creation_input_tokens;
            const cr = u.cache_read_input_tokens;
            if (typeof inp === "number") ctx.session.stats.inputTokens += inp;
            if (typeof cr === "number") {
                ctx.session.stats.cachedTokens += cr;
                ctx.session.stats.cacheSamples += 1;
            } else if (typeof inp === "number") {
                ctx.session.stats.cacheSamples += 1;
            }
            // Anthropic bills cache writes separately; track them under input
            // so the cumulative input reflects real prompt cost.
            if (typeof cc === "number") ctx.session.stats.inputTokens += cc;
        }
    }
    if (t === "message_stop") {
        return getConverted() ? NOOP : emitEvent(ev);
    }
    return emitEvent(ev);
}

function emitToolReplacement(toolName: string, jsonInput: string, ctx: RewriteCtx, index: number): string {
    let parsed: unknown = {};
    try {
        parsed = jsonInput ? JSON.parse(jsonInput) : {}
    } catch {
        parsed = {};
    }
    const args = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    const text = executeAnthropicProxyTool(toolName, args, ctx);
    // Reuse the suppressed tool_use block's own index instead of hardcoding 0.
    // Hardcoding 0 re-opens an already-closed text block (index 0 is usually a
    // preceding text block), producing malformed SSE.
    return (
        `event: content_block_start\n` +
        `data: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\n` +
        `data: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } })}\n\n` +
        `event: content_block_stop\n` +
        `data: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`
    );
}

// Dispatch all four ACP proxy tools to the same logic the OpenAI/Responses
// path uses (compress-loop.ts executeProxyTool). compress mutates context
// (handled by applyRanges); the other three are read-only queries whose result
// is emitted as a text delta replacing the intercepted tool_use block.
function executeAnthropicProxyTool(toolName: string, args: Record<string, unknown>, ctx: RewriteCtx): string {
    if (toolName === COMPRESS_TOOL_NAME) {
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
    if (toolName === ABSORB_TOOL_NAME) {
        return executeAbsorb(args, ctx);
    }
    return `[Unknown proxy tool: ${toolName}]`;
}

export function applyRanges(ranges: ReturnType<typeof parseCompressInput>, ctx: RewriteCtx): string {
    if (ranges.length === 0) {
        ctx.log("[acp-proxy: compress call had no valid ranges; nothing compressed.]");
        return "[Compression FAILED: no valid ranges parsed from the tool call. Check your startId/endId parameters.]";
    }
    ctx.log(`[acp-proxy: compress requested ${ranges.length} range(s): ${ranges.map((r) => `${r.startRef}–${r.endRef}`).join(", ")}]`);
    ctx.log(`[acp-proxy: ctx has ${ctx.messages.length} message(s), state has ${ctx.session.state.messageRefs?.byRef?.size ?? "?"} ref(s) mapped]`);
    if (ctx.messages.length > 0) {
        const ids = ctx.messages.slice(0, 10).map((m) => `${m.id}(${(m.text ?? "").length}c)`).join(", ");
        ctx.log(`[acp-proxy: first msg ids: ${ids}]`);
    }
    try {
        const res = ctx.core.applyCompression({
            ranges,
            messages: ctx.messages,
            state: ctx.session.state,
            config: ctx.config,
        });
        const beforeIds = new Set(ctx.session.state.blocks.map((b) => b.blockId));
        ctx.session.state = res.state;
        // Cache original content for newly-created blocks. At compress time the
        // source messages are still in ctx.messages (this round's view, before
        // the next processTurn folds them). Storing the text here lets decompress
        // work in later rounds where ctx.messages no longer carries the originals.
        // Two views are cached so decompress can honor the `full` flag: `one`
        // (direct messages + nested child summaries) and `full` (all originals).
        for (const b of res.state.blocks) {
            if (beforeIds.has(b.blockId)) continue;
            const full = collectBlockContent(res.state, b, ctx.messages, { full: true });
            const one = collectBlockContent(res.state, b, ctx.messages, { full: false });
            if (full.count > 0 || one.count > 0) {
                cacheBlockContent(ctx.session, b.blockId, {
                    one: { text: one.text, count: one.count },
                    full: { text: full.text, count: full.count },
                });
            }
        }
        const r = res.result;
        const detail = ranges.map((rg) => `${rg.startRef}–${rg.endRef}`).join(", ");

        if (r.blocksCreated === 0) {
            const errs = r.errors.join("; ") || "no blocks created";
            ctx.log(`[acp-proxy: compress FAILED ${detail} → 0 blocks. ${errs}]`);
            return `[Compression FAILED: ${errs}]`;
        }

        const warn = r.warnings.length > 0 ? ` ${r.warnings.join("; ")}` : "";
        const msg = `[Compressed ${detail} → ${r.blocksCreated} block(s), ~${r.tokensCompressed} tokens saved.${warn}]`;
        ctx.log(`[acp-proxy: ${msg}]`);
        return msg;
    } catch (err) {
        ctx.log(`[acp-proxy: compress failed: ${String(err)}]`);
        return `[Compression FAILED: ${String(err)}]`;
    }
}

function buildStopReasonRewrite(sawRealToolUse: boolean, usage?: Record<string, unknown>): string {
    const stop_reason = sawRealToolUse ? "tool_use" : "end_turn";
    // Preserve upstream usage (output_tokens etc.). Default output_tokens:0 so
    // strict clients (ZCode Zod) that require output_tokens:number still pass
    // even if the upstream omitted it.
    const u = { output_tokens: 0, ...(usage ?? {}) };
    return (
        `event: message_delta\n` +
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason }, usage: u })}\n\n` +
        `event: message_stop\n` +
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

type SseEvent = { raw: string; data: unknown | null };

function parseSseEvent(raw: string): SseEvent | null {
    const lines = raw.split("\n");
    let dataLine: string | null = null;
    for (const l of lines) {
        if (l.startsWith("data:")) {
            dataLine = l.slice(5).trim();
        }
    }
    if (dataLine === null) return { raw, data: null };
    try {
        return { raw, data: JSON.parse(dataLine) };
    } catch {
        return { raw, data: dataLine };
    }
}

function emitEvent(ev: SseEvent): string {
    return ev.raw + "\n\n";
}

export function rewriteJsonResponse(body: unknown, ctx: RewriteCtx): unknown {
    if (!body || typeof body !== "object") return body;
    const b = body as { content?: unknown[]; stop_reason?: string };
    if (!Array.isArray(b.content)) return body;
    let converted = false;
    let sawRealToolUse = false;
    const newContent: unknown[] = [];
    for (const block of b.content) {
        const blk = block as { type?: string; name?: string; input?: unknown };
        if (blk.type === "tool_use" && typeof blk.name === "string" && PROXY_TOOL_NAMES.has(blk.name)) {
            converted = true;
            const args = (blk.input && typeof blk.input === "object" ? blk.input : {}) as Record<string, unknown>;
            newContent.push({ type: "text", text: executeAnthropicProxyTool(blk.name, args, ctx) });
        } else {
            if (blk.type === "tool_use") sawRealToolUse = true;
            newContent.push(block);
        }
    }
    b.content = newContent;
    if (converted && !sawRealToolUse) b.stop_reason = "end_turn";
    for (const blk of newContent) {
        const t = (blk as { type?: string; text?: string }).text;
        if (typeof t === "string" && (t.includes("\x3cacp ") || t.includes("\x3c/acp"))) {
            ctx.log(`[warn: tag echo] non-stream model output contains <acp tag: ${t.slice(0, 120).replace(/\n/g, " ")}`);
        }
    }
    return body;
}

export type { CompressionState };
