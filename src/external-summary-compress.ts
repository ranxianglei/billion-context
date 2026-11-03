import { collectBlockContent } from "acp-kernel";
import { buildCompressSystemPrompt, parseCompressInput, type ParsedRange } from "./compress-tool.js";
import { messageTimestampSections } from "./external-summary-surface.js";
import { configuredSummaryPlan } from "./external-summary-runtime.js";
import type { ResolvedKernelConfig } from "./compress-settings.js";
import { applyRanges, noVisibleContextRefusal, normalizeRangeOrder, recoverEvictedView, type RewriteCtx } from "./stream.js";
import { compressResult, type ProxyToolResult } from "./proxy-tool-result.js";
import { imagePlaceholders } from "./image-note.js";
import { describeExternalSummaryFailure, summaryLengthBudgetClause, type SummaryWork } from "./external-summary.js";
import { newExternalCallId } from "./external-summary-marker.js";

// Re-exported for callers that historically imported it here; the canonical
// home is the leaf module (kept import-graph-light for display surfaces).
export { EXTERNAL_SUMMARY_CALL_ID_PREFIX, isExternalSummaryBlock, newExternalCallId } from "./external-summary-marker.js";

function withOptionalSummaries(input: unknown): unknown {
    let value = input;
    if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { return input; }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const object = value as Record<string, unknown>;
    let content = object.content;
    if (typeof content === "string") {
        try { content = JSON.parse(content); } catch { return value; }
    }
    const fill = (item: unknown): unknown => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const range = item as Record<string, unknown>;
        return range.summary === undefined || range.summary === ""
            ? { ...range, summary: "External summary requested." } : range;
    };
    return Array.isArray(content) ? { ...object, content: content.map(fill) } : fill(object);
}

/** Called under the host session lock; generation is separate from kernel commit. */
export async function applyConfiguredCompression(input: unknown, ctx: RewriteCtx, callId?: string, signal?: AbortSignal): Promise<ProxyToolResult> {
    if (signal?.aborted) return compressResult("[Compression FAILED: cancelled. Nothing compressed.]", "refused", 0);
    // The plan rides the request Config rail (#833: ctx.config is the
    // session's effective Config — same cascade that produced the wire).
    let plan;
    try { plan = configuredSummaryPlan((ctx.config as ResolvedKernelConfig).externalSummary, ctx.session.id); }
    catch { return compressResult("[Compression FAILED: external summary configuration is invalid. Nothing compressed.]", "refused", 0); }
    if (!plan) return applyRanges(parseCompressInput(input, callId), ctx);
    const parsed = parseCompressInput(withOptionalSummaries(input), callId);
    if (parsed.ranges.length === 0) return applyRanges(parsed, ctx);
    normalizeRangeOrder(parsed.ranges);
    recoverEvictedView(ctx);
    const noView = noVisibleContextRefusal(ctx, parsed.ranges);
    if (noView) return noView;
    const state = ctx.session.state;
    const revision = ctx.session.revisionEpoch;
    const messages = (ctx.compressMessages ?? ctx.messages).map((message) => {
        const notes = imagePlaceholders(message);
        return notes.length > 0 ? { ...message, text: `${message.text ?? ""}\n${notes.join(" ")}` } : message;
    });
    const work: SummaryWork[] = [];
    const valid: ParsedRange[] = [];
    // Kernel protection and aggregate size checks must see the complete batch.
    const probes = parsed.ranges.map((range, index) => {
        const maximum = Math.min(ctx.config.compress.maxSummaryLength, range.summaryMaxChars ?? Infinity);
        const length = Math.min(maximum, Math.max(64, ctx.config.compress.minSummaryLength));
        return { ...range, summary: (`external-probe-${index}:`).padEnd(length, "x").slice(0, length) };
    });
    const preview = ctx.core.applyCompression({ messages, state, config: ctx.config, ranges: probes });
    const before = new Map(state.blocks.map((block) => [block.blockId, block]));
    const source = messages.map((message) => ({ ...message, text:
        `[${state.messageRefs.byRaw[message.id] ?? message.id}] ${message.text ?? ""}` }));
    for (const [index, range] of parsed.ranges.entries()) {
        const blocks = preview.state.blocks.filter((candidate) => candidate.summary === probes[index].summary
            && before.get(candidate.blockId)?.summary !== candidate.summary);
        if (blocks.length === 0) continue;
        const content = blocks.map((block) => {
            const collected = collectBlockContent(state, block, source, { full: false }).text;
            if (collected.trim()) return collected;
            // An inline-restored block may no longer have originals in the wire view.
            const cached = ctx.session.blockContents.get(block.blockId);
            return cached?.one?.text ?? cached?.full?.text ?? "";
        }).join("\n\n");
        if (!content.trim()) continue;
        const covered = new Set(blocks.flatMap((block) => block.effectiveMessageIds));
        const reference = JSON.stringify({
            submittedSummaryHint: range.summary,
            currentContext: messages.filter((message, index) => !covered.has(message.id)
                && (message.role === "user" || index >= messages.length - 5)).map(({ role, text }) => ({ role, text })),
            otherSummaries: state.blocks.filter((candidate) => candidate.active && !blocks.some((block) => block.directBlockIds.includes(candidate.blockId)))
                .map(({ topic, summary }) => ({ topic, summary })),
        });
        valid.push(range);
        // #3635: state the EXACT cap the validator enforces in the instructions
        // — the preflight path has told its summarizers this number since #1775;
        // without it the compress path asked for output it could never accept.
        const maxSummaryChars = Math.min(range.summaryMaxChars ?? Infinity, ctx.config.compress.maxSummaryLength);
        work.push({ content, reference, minSummaryChars: ctx.config.compress.minSummaryLength, maxSummaryChars,
            instructions: `${ctx.session.meta.summaryInstructions ?? buildCompressSystemPrompt(undefined, messageTimestampSections(undefined))}\nWrite a faithful summary of the selected range ${range.startRef}-${range.endRef}. Preserve task status, constraints, decisions, exact code identifiers, paths and errors, and unfinished objectives with their source message refs. Submitted summary hints are non-authoritative. Never summarize or change the read-only reference.`
                + summaryLengthBudgetClause(maxSummaryChars, ctx.config.compress.minSummaryLength) });
    }
    if (work.length === 0) return compressResult("[Compression FAILED: no selected range passed the existing kernel protection checks. Nothing compressed.]", "refused", 0);
    const batch = await plan.summarize(work, signal);
    if (signal?.aborted || ctx.session.state !== state || ctx.session.revisionEpoch !== revision) return compressResult("[Compression FAILED: cancelled or session changed while generating external summaries. Nothing compressed.]", "refused", 0);
    const successful: ParsedRange[] = [];
    for (const [index, result] of batch.results.entries()) {
        if (result.status === "success") successful.push({ ...valid[index], summary: result.summary, compressCallId: newExternalCallId() });
    }
    // #3635: full failure description (parity with the preflight log line) so
    // an over-cap rejection is visible with its length reason, not bare "batch=finished".
    ctx.log(`[external-summary] completed ${successful.length}/${parsed.ranges.length} range(s); ${describeExternalSummaryFailure(batch)}`);
    // #4833: the bounded attempt diagnostics (source + budgets + outcomes) ride
    // the tool result too — enums and numbers only, never payload bytes.
    if (successful.length === 0) return compressResult(`[Compression FAILED: all configured external summary candidates failed or exceeded their budget. Nothing compressed; do not retry unchanged configuration — summaries longer than the configured cap are rejected whole, so raise compress.maxSummaryLength or request less via per-range summaryMaxChars.] [${describeExternalSummaryFailure(batch)}]`, "refused", 0);
    const applied = applyRanges({ ...parsed, ranges: successful }, ctx);
    // Client call arguments carry only an optional hint, never the generated summary.
    // In-place refolds retain their old call id in the kernel; keep their anchor too.
    for (const block of ctx.session.state.blocks) {
        if (before.get(block.blockId)?.restoredInline && !block.restoredInline) block.compressCallId = newExternalCallId();
    }
    if (successful.length < parsed.ranges.length && (applied.blocksCreated ?? 0) > 0) return {
        ...applied, outcome: "partial", text: `${applied.text}\n[External summary: ${parsed.ranges.length - successful.length} selected range(s) were not compressed.]`,
    };
    return applied;
}
