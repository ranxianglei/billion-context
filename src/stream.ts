import { collectBlockContent, type CompressionCore, type Config, type CoreMessage, type CompressionState } from "acp-kernel";
import { handleAcpStatus } from "./acp-status.js";
import { handleAcpCache, recordCacheFoldsFromBlocks } from "./cache-ledger.js";
import { type Session, cacheBlockContent, markDirty } from "./session.js";
import { COMPRESS_TOOL_NAME, parseCompressInput, ABSORB_TOOL_NAME, type ParsedRange } from "./compress-tool.js";
import { effectiveAbsorbConfig, executeAbsorb, isProxyToolFor } from "./absorb.js";
import { executeSearchContextTarget, resolveDecompress } from "./decompress-shared.js";
import { containsMarkerLineText, containsRenderTagText, stripAcpTags } from "./loop/tag-echo-filter.js";
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
        return executeSearchContextTarget(args, ctx.core, ctx.session.id, ctx.session.state);
    }
    if (toolName === "acp_status") {
        return handleAcpStatus(args, ctx);
    }
    if (toolName === "acp_cache") {
        return handleAcpCache(ctx.session);
    }
    const absorb = effectiveAbsorbConfig(ctx.session, ctx.config);
    if (absorb?.enabled === true && toolName === (absorb.toolName ?? ABSORB_TOOL_NAME)) {
        return executeAbsorb(args, undefined, absorb, ctx);
    }
    return `[Unknown proxy tool: ${toolName}]`;
}

/** Numeric part of a ref ("m00042" → 42, "b3" → 3); 0 for non-numeric. Used to
 *  order ranges by position when picking the fold point (#189 observability). */
function refNum(ref: string): number {
    return Number(ref.replace(/\D/g, "")) || 0;
}

const M_REF_NUM_RE = /^m0*(\d{1,7})$/i;

// #1001: after a client history rewrite, ref numbers are no longer monotonic
// with message position (surviving old messages keep low refs interleaved with
// fresh high refs), so position-derived spans can come back numerically
// reversed (startId > endId). The kernel resolves boundaries BY POSITION and
// swaps silently — normalize up front so specs and logs stay honest and range
// validity is validated explicitly instead of implicitly. bN/mixed endpoints
// have no cross-namespace ordering and are left untouched.
export function normalizeRangeOrder(ranges: Array<{ startRef: string; endRef: string }>): number {
    let swapped = 0;
    for (const r of ranges) {
        const a = M_REF_NUM_RE.exec(r.startRef.trim());
        const b = M_REF_NUM_RE.exec(r.endRef.trim());
        if (!a || !b) continue;
        if (Number(a[1]) > Number(b[1])) {
            const s = r.startRef;
            r.startRef = r.endRef;
            r.endRef = s;
            swapped++;
        }
    }
    return swapped;
}

// #847: the kernel normalizes reversed startId/endId silently (bounds are
// swapped), so a parameter slip surfaces as an unrelated content error — the
// model then imitates its own failed call in a loop. Surface the reversal.
function reversedRanges(ranges: ParsedRange[]): ParsedRange[] {
    return ranges.filter((r) => refNum(r.startRef) > refNum(r.endRef));
}
// #847: a rejected spec fails deterministically until the visible context
// changes, so repeating it is pure context burn (the incident looped the same
// call 7x over ~13 min while usage climbed 76%→89%). Track recent failed
// specs per session and escalate on repeat instead of echoing the plain gate
// error again. Stored on metadata (persisted) so the streak survives LRU
// eviction/reload; stale keys after a ref reset are harmless (no match).
const FAIL_STREAK_KEY = "compressFailKeys";
const FAIL_STREAK_CAP = 5;
function normalizedSpecKey(ranges: ParsedRange[]): string {
    return ranges
        .map((r) => (refNum(r.startRef) <= refNum(r.endRef) ? `${r.startRef}..${r.endRef}` : `${r.endRef}..${r.startRef}`))
        .sort()
        .join(",");
}
function recordCompressFailure(session: Session, key: string): string {
    if (!key) return "";
    const prev = session.metadata[FAIL_STREAK_KEY];
    const keys = Array.isArray(prev) ? prev.filter((k): k is string => typeof k === "string") : [];
    const occurrences = keys.filter((k) => k === key).length + 1;
    keys.push(key);
    while (keys.length > FAIL_STREAK_CAP) keys.shift();
    session.metadata[FAIL_STREAK_KEY] = keys;
    markDirty(session);
    if (occurrences < 2) return "";
    return ` [Repeat-failure guard: you have now requested this exact range set ${occurrences} time(s) in this session and it keeps failing with the same error. Repeating it deterministically fails the same way until the visible context changes — do NOT re-issue it. Call acp_status first and pick from its CURRENT compressible ranges, or extend your range(s) to cover more adjacent messages.]`;
}
function clearCompressFailures(session: Session): void {
    if (session.metadata[FAIL_STREAK_KEY] !== undefined) {
        delete session.metadata[FAIL_STREAK_KEY];
        markDirty(session);
    }
}

export function applyRanges(parsed: ReturnType<typeof parseCompressInput>, ctx: RewriteCtx): string {
    const { ranges, diagnostics } = parsed;
    if (ranges.length === 0) {
        ctx.log("[acp-proxy: compress call had no valid ranges; nothing compressed.]");
        const reasons = diagnostics.invalidReasons?.slice(0, 8).map((r) => (r.length > 200 ? r.slice(0, 200) + "..." : r)) ?? [];
        const why = reasons.length > 0 ? ` Rejected entries:\n${reasons.map((r) => `- ${r}`).join("\n")}` : "";
        return `[Compression FAILED: no valid ranges parsed (kind=${diagnostics.kind}, dropped=${diagnostics.invalidItems}).${why}\n compress requires a non-empty 'content' array where each element is EITHER an object {startId, endId, summary} OR one line-form string whose first line is 'mNNNNN–mNNNNN optional topic' with the summary markdown on the following lines (a separate summary-only element right after a bare header line is also accepted). startId/endId are mNNNNN message refs from the conversation. Re-issue the compress call with a valid content array.]`;
    }
    // #847: detect reversed refs as SUBMITTED, before #1001 normalization
    // rewrites them (order matters — normalizeRangeOrder mutates in place).
    const revs = reversedRanges(ranges);
    const swappedRanges = normalizeRangeOrder(ranges);
    if (swappedRanges > 0) {
        ctx.log(`[acp-proxy: normalized ${swappedRanges} reversed range(s) to ascending ref order (#1001)]`);
    }
    ctx.log(`[acp-proxy: compress requested ${ranges.length} range(s): ${ranges.map((r) => `${r.startRef}–${r.endRef}`).join(", ")}]`);
    ctx.log(`[acp-proxy: ctx has ${ctx.messages.length} message(s), state has ${Object.keys(ctx.session.state.messageRefs?.byRef ?? {}).length} ref(s) mapped]`);
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
        // (#401: the duplicate was 50% of blockContents bytes on disk).
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
        if (revs.length > 0) {
            ctx.log(`[acp-proxy: reversed range(s) in compress call: ${revs.map((rg) => `${rg.startRef}->${rg.endRef}`).join(", ")}`);
        }

        if (r.blocksCreated === 0) {
            const errs = r.errors.join("; ") || "no blocks created";
            const revNote = revs.length > 0
                ? ` Note: startId > endId in range(s) ${revs.map((rg) => `${rg.startRef}→${rg.endRef}`).join(", ")} — your refs were reversed; they were normalized to ascending order before evaluation, so check your ref order.`
                : "";
            ctx.log(`[acp-proxy: compress FAILED ${detail} → 0 blocks. ${errs}${revs.length > 0 ? " [reversed refs]" : ""}]`);
            return `[Compression FAILED: ${errs}${revNote}${recordCompressFailure(ctx.session, normalizedSpecKey(ranges))}]`;
        }
        clearCompressFailures(ctx.session);

        // #189 observability: record the rewrite magnitude + fold point so a
        // downstream transient rejection (GLM 3007) can be correlated with it.
        // preContext is read BEFORE the credit netting below (lastInputTokens
        // still holds the pre-compress context at this point).
        const preContext = ctx.session.stats.lastInputTokens;
        const shrinkRatio = preContext > 0 ? r.tokensCompressed / preContext : 0;
        const foldPoint = [...ranges].sort((a, b) => refNum(a.startRef) - refNum(b.startRef))[0]?.startRef ?? "unknown";
        ctx.session.lastCompress = { at: Date.now(), shrinkRatio, foldPoint, blocks: r.blocksCreated, tokensCompressed: r.tokensCompressed };
        ctx.session.stats.pendingFoldUsage = true;
        // #695: the next request materializes this fold — its prefix-cache hit
        // ceiling ≈ anchor / postFoldContext. sys length is unknown here, so
        // anchor (active block summaries) is a LOWER bound; the fold=new
        // [acp-usage] line reports the real cached, separating physics from
        // upstream eviction.
        const anchorTok = res.state.blocks.reduce((n, b) => n + (b.active ? Math.ceil(b.summary.length / 4) : 0), 0);
        const postCtx = Math.max(0, preContext - r.tokensCompressed);
        const ceiling = postCtx > 0 ? Math.floor((100 * anchorTok) / postCtx) : 0;
        ctx.log(`[acp-compress-obs] shrink ${Math.round(shrinkRatio * 100)}% (~${r.tokensCompressed}/${preContext} tok) foldPoint=${foldPoint} blocks=${r.blocksCreated} anchor≈${anchorTok} tok (${res.state.blocks.filter((b) => b.active).length} active blocks, sys excluded) postCtx≈${postCtx} → next-request cache ceiling ≥${ceiling}%`);
        // #800: feed the cache ledger — the next request's usage report will
        // attribute its re-pay cliff to these folds via decomposeSample.
        recordCacheFoldsFromBlocks(
            ctx.session,
            res.state.blocks.filter((b) => !beforeIds.has(b.blockId)),
            { V: preContext, Vp: postCtx },
        );

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
        return `[Compression FAILED: ${String(err)}${recordCompressFailure(ctx.session, normalizedSpecKey(ranges))}]`;
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
        if (blk.type === "tool_use" && typeof blk.name === "string" && isProxyToolFor(blk.name, ctx.session, ctx.config)) {
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
        if (typeof t === "string" && (containsRenderTagText(t) || containsMarkerLineText(t))) {
            ctx.log(`[warn: tag echo] non-stream model output contains ACP echo (render tags/markers), stripped: ${t.slice(0, 120).replace(/\n/g, " ")}`);
            (blk as { text?: string }).text = stripAcpTags(t);
        }
    }
    return body;
}

export type { CompressionState };
