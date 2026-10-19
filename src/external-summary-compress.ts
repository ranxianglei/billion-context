import { collectBlockContent } from "acp-kernel";
import { buildCompressSystemPrompt, parseCompressInput, type ParsedRange } from "./compress-tool.js";
import { configuredSummaryPlan } from "./external-summary-runtime.js";
import { externalSummaryFingerprint, recordExternalBatchOutcome } from "./external-summary-failures.js";
import type { ResolvedKernelConfig } from "./compress-settings.js";
import { applyRanges, noVisibleContextRefusal, normalizeRangeOrder, type RewriteCtx } from "./stream.js";
import { compressResult, type ProxyToolResult } from "./proxy-tool-result.js";
import { imagePlaceholders } from "./image-note.js";
import type { ExternalSummaryBatchResult, SummaryWork } from "./external-summary.js";
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
    try {
        plan = configuredSummaryPlan((ctx.config as ResolvedKernelConfig).externalSummary, ctx.session.id, {
            onBatch: (outcome) => recordExternalBatchOutcome(ctx.session.metadata, outcome),
        });
    }
    catch {
        // #3638: a chain that cannot even build is itself the persistent failure —
        // count it so the latch can stand up its notice instead of re-injecting the
        // full tier>=2 catalog every turn.
        recordExternalBatchOutcome(ctx.session.metadata, { successes: 0, total: 1, classes: ["candidate_unavailable"], fingerprint: externalSummaryFingerprint((ctx.config as ResolvedKernelConfig).externalSummary), dispatched: false });
        return compressResult("[Compression FAILED: external summary configuration is invalid. Nothing compressed.]", "refused", 0);
    }
    if (!plan) return applyRanges(parseCompressInput(input, callId), ctx);
    const parsed = parseCompressInput(withOptionalSummaries(input), callId);
    if (parsed.ranges.length === 0) return applyRanges(parsed, ctx);
    normalizeRangeOrder(parsed.ranges);
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
        // #3638: structured so each candidate fits the reference into its OWN real
        // window (drop-oldest shrinkage) instead of every call carrying the whole
        // session's summary mass unbounded.
        const referenceParts = {
            submittedSummaryHint: range.summary,
            currentContext: messages.filter((message, index) => !covered.has(message.id)
                && (message.role === "user" || index >= messages.length - 5)).map(({ role, text }) => ({ role, text: text ?? "" })),
            otherSummaries: state.blocks.filter((candidate) => candidate.active && !blocks.some((block) => block.directBlockIds.includes(candidate.blockId)))
                .map(({ topic, summary }) => ({ topic, summary })),
        };
        valid.push(range);
        work.push({ content, referenceParts, minSummaryChars: ctx.config.compress.minSummaryLength,
            maxSummaryChars: Math.min(range.summaryMaxChars ?? Infinity, ctx.config.compress.maxSummaryLength),
            instructions: `${ctx.session.meta.summaryInstructions ?? buildCompressSystemPrompt()}\nWrite a faithful summary of the selected range ${range.startRef}-${range.endRef}. Preserve task status, constraints, decisions, exact code identifiers, paths and errors, and unfinished objectives with their source message refs. Submitted summary hints are non-authoritative. Never summarize or change the read-only reference.` });
    }
    if (work.length === 0) return compressResult("[Compression FAILED: no selected range passed the existing kernel protection checks. Nothing compressed.]", "refused", 0);
    const batch = await plan.summarize(work, signal);
    if (signal?.aborted || ctx.session.state !== state || ctx.session.revisionEpoch !== revision) return compressResult("[Compression FAILED: cancelled or session changed while generating external summaries. Nothing compressed.]", "refused", 0);
    const successful: ParsedRange[] = [];
    for (const [index, result] of batch.results.entries()) {
        if (result.status === "success") successful.push({ ...valid[index], summary: result.summary, compressCallId: newExternalCallId() });
    }
    ctx.log(`[external-summary] completed ${successful.length}/${parsed.ranges.length} range(s); batch=${batch.status}${describeBatchAttempts(batch)}`);
    if (successful.length === 0) return compressResult(composeExternalFailureMessage(batch, plan.targetLabels), "refused", 0);
    const applied = applyRanges({ ...parsed, ranges: successful }, ctx);
    // Client call arguments carry only an optional hint, never the generated summary.
    // In-place refolds retain their old call id in the kernel; keep their anchor too.
    for (const block of ctx.session.state.blocks) {
        if (before.get(block.blockId)?.restoredInline && !block.restoredInline) block.compressCallId = newExternalCallId();
    }
    if (successful.length < parsed.ranges.length && (applied.blocksCreated ?? 0) > 0) {
        const failedClasses = [...new Set(collectAttemptClasses(batch))].slice(0, 3);
        const suffix = failedClasses.length > 0 ? ` (last reasons: ${failedClasses.join(", ")})` : "";
        return {
            ...applied, outcome: "partial", text: `${applied.text}\n[External summary: ${parsed.ranges.length - successful.length} selected range(s) were not compressed.${suffix}]`,
        };
    }
    return applied;
}

function collectAttemptClasses(batch: ExternalSummaryBatchResult): string[] {
    const classes: string[] = [];
    for (const result of batch.results) for (const attempt of result.attempts) {
        if (attempt.outcome !== "success" && attempt.failure?.cls) classes.push(attempt.failure.cls);
    }
    return classes;
}

// Operator-log detail: per-range attempt outcomes with classified reasons.
function describeBatchAttempts(batch: ExternalSummaryBatchResult): string {
    const parts: string[] = [];
    batch.results.forEach((result, index) => {
        for (const attempt of result.attempts) parts.push(`r${index}:t${attempt.targetIndex}:${attempt.outcome}${attempt.failure ? `(${attempt.failure.cls})` : ""}`);
    });
    return parts.length > 0 ? `; attempts=${parts.slice(0, 12).join(" ")}` : "";
}

/** #3638: bounded, secret-free tool-result diagnostic replacing the old
 *  one-size-fits-all sentence — distinguishes missing candidate configuration,
 *  provider failures, input/output budget overflow, timeouts, and retry
 *  exhaustion per candidate. Candidate name/protocol/model are user config,
 *  not secrets; details come only from the classified failures (URLs scrubbed). */
export function composeExternalFailureMessage(batch: ExternalSummaryBatchResult, labels: readonly { readonly name: string; readonly protocol: string; readonly model: string }[]): string {
    if (batch.status === "failed") return "[Compression FAILED: external summary configuration is invalid. Nothing compressed.]";
    const lines = ["[Compression FAILED: all configured external summary candidates failed. Nothing compressed; originals unchanged.]"];
    const lastByTarget = new Map<number, { cls: string; detail?: string }>();
    let anyAttempt = false;
    for (const result of batch.results) for (const attempt of result.attempts) {
        if (attempt.outcome === "success") continue;
        anyAttempt = true;
        if (attempt.failure) lastByTarget.set(attempt.targetIndex, { cls: attempt.failure.cls, detail: attempt.failure.detail });
    }
    if (!anyAttempt) {
        lines.push("No candidate was dispatched: the shared summary queue was saturated (transient congestion, not a chain fault).");
    } else {
        for (const [index, label] of labels.entries()) {
            const failure = lastByTarget.get(index);
            if (!failure) continue;
            lines.push(`- ${label.name} (${label.protocol}/${label.model}): ${failure.cls}${failure.detail ? ` — ${failure.detail}` : ""}`);
        }
    }
    if (batch.status === "deadline") lines.push("The batch time budget expired before every candidate could be tried.");
    lines.push("Safe recovery: fix the external summary configuration (credentials/targets/window — see the bili panel) or set compress.externalSummary.enabled=false to restore model-written summaries, then retry.");
    const message = lines.join("\n");
    return message.length > 900 ? `${message.slice(0, 899)}…` : message;
}
