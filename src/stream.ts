import type { CompressionCore, Config, CoreMessage, CompressionState } from "acp-kernel";
import type { Session } from "./session.js";
import { COMPRESS_TOOL_NAME, parseCompressInput } from "./compress-tool.js";

export type RewriteCtx = {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
    debug?: boolean;
};

type BlockState = { isCompress: boolean; json: string; hadRealToolUse: boolean };

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
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
                const rawEvent = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const ev = parseSseEvent(rawEvent);
                if (!ev) continue;
                const routed = routeEvent(ev, blocks, ctx, (c) => (convertedAny = c || convertedAny), () => (sawRealToolUse = true), () => convertedAny);
                if (routed === NOOP) continue;
                output += routed;
                if (output.length >= 8192) yield flush();
            }
        }
        if (convertedAny) {
            const finalDelta = buildStopReasonRewrite(sawRealToolUse);
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
): string | typeof NOOP {
    const d = ev.data;
    if (!d || typeof d !== "object") return emitEvent(ev);
    const t = (d as { type?: string }).type;
    if (t === "content_block_start") {
        const index = (d as { index?: number }).index ?? 0;
        const cb = (d as { content_block?: { type?: string; name?: string } }).content_block;
        if (cb?.type === "tool_use" && cb.name === COMPRESS_TOOL_NAME) {
            blocks.set(index, { isCompress: true, json: "", hadRealToolUse: false });
            markConverted(true);
            return NOOP;
        }
        if (cb?.type === "tool_use") markRealToolUse();
        return emitEvent(ev);
    }
    if (t === "content_block_delta") {
        const index = (d as { index?: number }).index ?? 0;
        const st = blocks.get(index);
        if (st && st.isCompress) {
            const partial = (d as { delta?: { partial_json?: string } }).delta?.partial_json;
            if (typeof partial === "string") st.json += partial;
            return NOOP;
        }
        return emitEvent(ev);
    }
    if (t === "content_block_stop") {
        const index = (d as { index?: number }).index ?? 0;
        const st = blocks.get(index);
        if (st && st.isCompress) {
            blocks.delete(index);
            return emitReplacementText(st.json, ctx, index);
        }
        return emitEvent(ev);
    }
    // Suppress terminal events ONLY when we converted a compress tool_use
    // (we re-emit a rewritten stop reason at stream end). Without this guard,
    // plain text responses (the common case) never receive message_delta /
    // message_stop and the client hangs until timeout.
    if (t === "message_delta") {
        return getConverted() ? NOOP : emitEvent(ev);
    }
    if (t === "message_stop") {
        return getConverted() ? NOOP : emitEvent(ev);
    }
    return emitEvent(ev);
}

function emitReplacementText(jsonInput: string, ctx: RewriteCtx, index: number): string {
    let parsed: unknown = {};
    try {
        parsed = jsonInput ? JSON.parse(jsonInput) : {}
    } catch {
        parsed = {};
    }
    const ranges = parseCompressInput(parsed);
    const note = applyRanges(ranges, ctx);
    // Reuse the suppressed tool_use block's own index instead of hardcoding 0.
    // Hardcoding 0 re-opens an already-closed text block (index 0 is usually a
    // preceding text block), producing malformed SSE.
    return (
        `event: content_block_start\n` +
        `data: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\n` +
        `data: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text: note } })}\n\n` +
        `event: content_block_stop\n` +
        `data: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`
    );
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
        ctx.session.state = res.state;
        const r = res.result;
        const detail = ranges.map((rg) => `${rg.startRef}–${rg.endRef}`).join(", ");

        if (r.blocksCreated === 0) {
            const errs = r.errors.join("; ") || "no blocks created";
            ctx.log(`[acp-proxy: compress FAILED ${detail} → 0 blocks. ${errs}]`);
            return `[Compression FAILED: ${errs} Do not retry the same range.]`;
        }

        const warn = r.warnings.length > 0 ? ` ${r.warnings.join("; ")}` : "";
        const msg = `[Compressed ${detail} → ${r.blocksCreated} block(s), ~${r.tokensCompressed} tokens saved.${warn}]`;
        ctx.log(`[acp-proxy: ${msg}]`);
        return msg;
    } catch (err) {
        ctx.log(`[acp-proxy: compress failed: ${String(err)}]`);
        return `[Compression FAILED: ${String(err)} Do not retry the same range.]`;
    }
}

function buildStopReasonRewrite(sawRealToolUse: boolean): string {
    const stop_reason = sawRealToolUse ? "tool_use" : "end_turn";
    return (
        `event: message_delta\n` +
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason }, usage: {} })}\n\n` +
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
        if (blk.type === "tool_use" && blk.name === COMPRESS_TOOL_NAME) {
            converted = true;
            const ranges = parseCompressInput(blk.input);
            newContent.push({ type: "text", text: applyRanges(ranges, ctx) });
        } else {
            if (blk.type === "tool_use") sawRealToolUse = true;
            newContent.push(block);
        }
    }
    b.content = newContent;
    if (converted && !sawRealToolUse) b.stop_reason = "end_turn";
    return body;
}

export type { CompressionState };
