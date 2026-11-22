import { collectBlockContent } from "acp-kernel";
import { buildCompressSystemPrompt, parseCompressInput, type ParsedRange } from "./compress-tool.js";
import { messageTimestampSections } from "./external-summary-surface.js";
import { configuredSummaryPlan } from "./external-summary-runtime.js";
import type { ResolvedKernelConfig } from "./compress-settings.js";
import { applyRanges, compressBreakerDetail, noVisibleContextRefusal, normalizeRangeOrder, noteCompressLoopFailure, recoverEvictedView, supersededRefRejection, type RewriteCtx } from "./stream.js";
import { compressResult, type ProxyToolResult } from "./proxy-tool-result.js";
import { imagePlaceholders } from "./image-note.js";
import { describeExternalSummaryFailure, summaryLengthBudgetClause, type SummaryWork } from "./external-summary.js";
import { newExternalCallId } from "./external-summary-marker.js";

// Re-exported for callers that historically imported it here; the canonical
// home is the leaf module (kept import-graph-light for display surfaces).
export { EXTERNAL_SUMMARY_CALL_ID_PREFIX, isExternalSummaryBlock, newExternalCallId } from "./external-summary-marker.js";

// #6903: the consecutive-failure breaker cause for the external-summary lane.
// The prefix is matched by the pre-dispatch gate (startsWith); the full string
// rides the streak so acp_status can show the provider-down verdict. It
// deliberately does NOT claim "summary too long" — the underlying provider
// cause (endpoint/credentials/budget) stays an independent diagnosis, and a
// generic error must not be read as a length-cap rejection.
const EXTERNAL_SUMMARY_FAILURE_CAUSE_PREFIX = "external-summary-failure";
const EXTERNAL_SUMMARY_FAILURE_CAUSE = `${EXTERNAL_SUMMARY_FAILURE_CAUSE_PREFIX} — every configured summary candidate failed or exceeded its budget (see the batch diagnostics); fix the endpoint/credentials/budget or wait for the breaker to decay`;

// #6903: the pre-dispatch refusal shown when the breaker is already armed by
// external-summary failures. It states the breaker is armed (n consecutive
// all-failure batches), that NOTHING was dispatched (no summary request was
// sent), and the two recovery paths (fix the config, or wait for the decay).
// It carries no new numbers/refs the model could anchor on beyond n and
// decayMinutes (both real values from the streak).
function armedExternalSummaryRefusal(n: number, decayMinutes: number): string {
    return `[Compression refused: the external-summary circuit breaker is already armed (${n} consecutive all-failure batches — every configured summary candidate failed or exceeded its budget). Nothing was compressed and no summary request was sent. Do not call compress again to retry the same configuration: the breaker disarms on one substantial fold (a trivial one that saves almost nothing does not count) or ${decayMinutes} minutes without a failing call. Fix the external-summary configuration (endpoint/credentials/budget) if it is misconfigured, or continue your task without compressing — compression resumes automatically once the breaker decays and a summary succeeds.]`;
}

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
    // #5558: resolve superseded refs BEFORE the probe preview — the preview
    // judges foldability while applyRanges re-resolves refs on every entry, so
    // judging on untranslated refs lets an unanchorable stale cite read as "no
    // change" here yet translate and fold under a synthetic probe summary in
    // there, committing content without the configured external summarizer.
    // One projection for judgment AND execution (#3236 discipline).
    const resolved = supersededRefRejection(parsed.ranges, ctx.session);
    if (resolved.rejection !== null) return applyRanges({ ...parsed, ranges: resolved.translatedRanges }, ctx);
    const state = ctx.session.state;
    const revision = ctx.session.revisionEpoch;
    const messages = (ctx.compressMessages ?? ctx.messages).map((message) => {
        const notes = imagePlaceholders(message);
        return notes.length > 0 ? { ...message, text: `${message.text ?? ""}\n${notes.join(" ")}` } : message;
    });
    const work: SummaryWork[] = [];
    const valid: ParsedRange[] = [];
    let hasProbeChanges = false;
    // Kernel protection and aggregate size checks must see the complete batch.
    const probes = resolved.translatedRanges.map((range, index) => {
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
        hasProbeChanges = true;
        const content = blocks.map((block) => {
            const collected = collectBlockContent(state, block, source, { full: false }).text;
            if (collected.trim()) return collected;
            // An inline-restored block may no longer have originals in the wire view.
            const cached = ctx.session.blockContents.get(block.blockId);
            return cached?.one?.text ?? cached?.full?.text ?? "";
        }).join("\n\n");
        if (!content.trim()) continue;
        const covered = new Set(blocks.flatMap((block) => block.effectiveMessageIds));
        const directBlockIds = new Set(blocks.flatMap((block) => block.directBlockIds));
        const reference = JSON.stringify({
            submittedSummaryHint: range.summary,
            currentContext: messages.filter((message, index) => !covered.has(message.id)
                && (message.role === "user" || index >= messages.length - 5)).map(({ role, text }) => ({ role, text })),
            otherSummaries: state.blocks.filter((candidate) => candidate.active && !directBlockIds.has(candidate.blockId))
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
    if (work.length === 0) {
        // #5558: an unchanged preview can be an already-covered/protected no-op
        // or a kernel refusal; the normal path supplies that truthful receipt.
        // If a probe changed state but yielded no content, never fold a hint
        // without the configured external summary.
        if (!hasProbeChanges) return applyRanges({ ...parsed, ranges: probes }, ctx);
        return compressResult("[Compression FAILED: no selected range passed the existing kernel protection checks. Nothing compressed.]", "refused", 0);
    }
    // #6903: refuse BEFORE dispatch when the breaker is already armed by
    // external-summary failures — re-requesting unavailable candidates just
    // burns budget and the model ignores the in-receipt paragraph. Cause-gated
    // (not any-armed): substrate-destruction's instructed recovery (compress
    // one live range) and stale-ref re-anchoring must still be able to dispatch
    // and clear the breaker; only the provider-down cause guarantees
    // re-dispatch keeps failing. This refusal does NOT call
    // noteCompressLoopFailure, so repeated refusals do not extend the 10-min
    // cooldown — recovery is the decay, not the refusal.
    const armed = compressBreakerDetail(ctx.session);
    if (armed !== undefined && armed.cause !== undefined && armed.cause.startsWith(EXTERNAL_SUMMARY_FAILURE_CAUSE_PREFIX)) {
        ctx.log(`[external-summary] dispatch refused — compress breaker armed by external-summary failures (n=${armed.n}, decay ${armed.decayMinutes} min); no candidate calls dispatched`);
        return compressResult(armedExternalSummaryRefusal(armed.n, armed.decayMinutes), "refused", 0, "gate:external-summary-breaker");
    }
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
    if (successful.length === 0) {
        // #6903: wire the dispatched-but-all-failed batch into the
        // consecutive-failure breaker so repeated compress calls stop
        // re-requesting unavailable candidates (the existing 3-failure /
        // 10-min-cooldown protection). Count only when a candidate call was
        // actually dispatched (plan.stats.attempts > 0) — a congestion-only
        // batch (no dispatch) is not a provider failure — and only for
        // finished/deadline batches (a cancelled batch is request teardown,
        // not a provider failure). The pause paragraph (once armed) rides the
        // receipt; the forced cause keeps the provider-down verdict visible to
        // acp_status without claiming summary-too-long.
        const providerFailure = plan.stats.attempts > 0 && (batch.status === "finished" || batch.status === "deadline");
        const loopGuard = providerFailure
            ? noteCompressLoopFailure(ctx, valid.map((r) => `${r.startRef}..${r.endRef}`).join(","), describeExternalSummaryFailure(batch), EXTERNAL_SUMMARY_FAILURE_CAUSE)
            : "";
        return compressResult(`[Compression FAILED: all configured external summary candidates failed or exceeded their budget. Nothing compressed; do not retry unchanged configuration — summaries longer than the configured cap are rejected whole, so raise compress.maxSummaryLength or request less via per-range summaryMaxChars.] [${describeExternalSummaryFailure(batch)}]${loopGuard}`, "refused", 0);
    }
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
