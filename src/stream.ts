import { buildStatusReport, collectBlockContent, estimateTokensFast, type CompressionCore, type Config, type CoreMessage, type CompressionState } from "acp-kernel";
import { type Session, cacheBlockContent } from "./session.js";
import { COMPRESS_TOOL_NAME, parseCompressInput, PROXY_TOOL_NAMES } from "./compress-tool.js";
import { resolveDecompress } from "./decompress-shared.js";
import { containsRenderTagText, stripAcpTags } from "./loop/tag-echo-filter.js";
import { maxShrinkPerCompress } from "./fetch-util.js";

export type RewriteCtx = {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    /** View handed to applyCompression. Defaults to `messages`; hosts whose
     *  `messages` view has pruned/hidden content (so block anchors can't
     *  resolve) pass the unpruned log here (billion-context-pi#195). */
    compressMessages?: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
    debug?: boolean;
};

// Dispatch all four ACP proxy tools to the same logic the OpenAI/Responses
// path uses (compress-loop.ts executeProxyTool). compress mutates context
// (handled by applyRanges); the other three are read-only queries whose result
// becomes a text block replacing the intercepted tool_use.
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
    return `[Unknown proxy tool: ${toolName}]`;
}

/** Numeric part of a ref ("m00042" → 42, "b3" → 3); 0 for non-numeric. Used to
 *  order ranges by position when picking the fold point (#189 observability). */
function refNum(ref: string): number {
    return Number(ref.replace(/\D/g, "")) || 0;
}

export function applyRanges(parsed: ReturnType<typeof parseCompressInput>, ctx: RewriteCtx): string {
    const { ranges, diagnostics } = parsed;
    if (ranges.length === 0) {
        ctx.log("[acp-proxy: compress call had no valid ranges; nothing compressed.]");
        const reasons = diagnostics.invalidReasons?.slice(0, 8).map((r) => (r.length > 200 ? r.slice(0, 200) + "..." : r)) ?? [];
        const why = reasons.length > 0 ? ` Rejected entries:\n${reasons.map((r) => `- ${r}`).join("\n")}` : "";
        return `[Compression FAILED: no valid ranges parsed (kind=${diagnostics.kind}, dropped=${diagnostics.invalidItems}).${why}\n compress requires a non-empty 'content' array of {startId, endId, summary} ranges, where startId/endId are mNNNNN message refs from the conversation. Re-issue the compress call with a valid content array.]`;
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
            messages: ctx.compressMessages ?? ctx.messages,
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
        // Leaf blocks have no active nested children, so both kernel paths
        // emit byte-identical text — persist a single copy in that case
        // (#478: the duplicate was 50% of blockContents bytes on disk).
        for (const b of res.state.blocks) {
            if (beforeIds.has(b.blockId)) continue;
            const full = collectBlockContent(res.state, b, ctx.messages, { full: true });
            const one = collectBlockContent(res.state, b, ctx.messages, { full: false });
            if (full.count > 0 || one.count > 0) {
                const sameView = one.text === full.text && one.count === full.count;
                cacheBlockContent(ctx.session, b.blockId, {
                    one: sameView ? null : { text: one.text, count: one.count },
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

        // #189 observability: record the rewrite magnitude + fold point so a
        // downstream transient rejection (GLM 3007) can be correlated with it.
        // preContext is read BEFORE the credit netting below (lastInputTokens
        // still holds the pre-compress context at this point).
        const preContext = ctx.session.stats.lastInputTokens;
        const shrinkRatio = preContext > 0 ? r.tokensCompressed / preContext : 0;
        const foldPoint = [...ranges].sort((a, b) => refNum(a.startRef) - refNum(b.startRef))[0]?.startRef ?? "unknown";
        ctx.session.lastCompress = { at: Date.now(), shrinkRatio, foldPoint, blocks: r.blocksCreated, tokensCompressed: r.tokensCompressed };
        ctx.log(`[acp-compress-obs] shrink ${Math.round(shrinkRatio * 100)}% (~${r.tokensCompressed}/${preContext} tok) foldPoint=${foldPoint} blocks=${r.blocksCreated}`);

        const warn = r.warnings.length > 0 ? ` ${r.warnings.join("; ")}` : "";
        let msg = `[Compressed ${detail} → ${r.blocksCreated} block(s), ~${r.tokensCompressed} tokens saved.${warn}]`;
        // #189 staged compression (gated): a rewrite above the configured max
        // shrink is the shape that trips provider risk-control; steer the model
        // toward smaller, tail-biased ranges so the prefix (m00001..foldPoint)
        // survives for prefix caching and each round's transition stays gentle.
        const maxShrink = maxShrinkPerCompress();
        if (maxShrink !== undefined && shrinkRatio > maxShrink) {
            msg += ` [Staged-compress: this rewrite shrank context ${Math.round(shrinkRatio * 100)}%, above your ${Math.round(maxShrink * 100)}% per-compress target — the shape that trips provider risk-control (3007). Next time compress a SMALLER, TAIL-biased range (the most recent large content) and keep the stable prefix intact.]`;
        }
        ctx.log(`[acp-proxy: ${msg}]`);
        // The fold materializes only at the NEXT request's processTurn; the
        // post-compress re-request re-sends the unfolded history (prefix-cache
        // friendly), so usage reports until then over-report. Net the savings
        // out immediately and keep them as a credit the usage recorders apply,
        // so the next nudge decision sees post-compress reality instead of
        // re-firing on the stale pre-compress number (#252 double-inject).
        ctx.session.stats.compressCreditTokens = (ctx.session.stats.compressCreditTokens ?? 0) + r.tokensCompressed;
        ctx.session.stats.lastInputTokens = Math.max(0, ctx.session.stats.lastInputTokens - r.tokensCompressed);
        return msg;
    } catch (err) {
        ctx.log(`[acp-proxy: compress failed: ${String(err)}]`);
        return `[Compression FAILED: ${String(err)}]`;
    }
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
        if (typeof t === "string" && containsRenderTagText(t)) {
            ctx.log(`[warn: tag echo] non-stream model output contains <acp tag: ${t.slice(0, 120).replace(/\n/g, " ")}`);
            (blk as { text?: string }).text = stripAcpTags(t);
        }
    }
    return body;
}

export type { CompressionState };
