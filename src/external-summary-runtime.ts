import { performance } from "node:perf_hooks";
import { SummaryCredentialStore } from "./external-summary-credentials.js";
import { createSummaryHttpCandidate } from "./external-summary-http.js";
import { parseExternalSummarySettings, type ExternalSummarySettings } from "./external-summary-settings.js";
import { ExternalSummaryExecutor, type ExternalSummaryBatchResult, type SummaryCandidate, type SummaryWork } from "./external-summary.js";
import { log as loggerLog } from "./logger.js";

// One shared queue across all sessions and all compression entry points.
const executor = new ExternalSummaryExecutor(4);

// Test seam (#2662): saturate the process-wide pool deterministically.
export const _executorForTest = executor;

// The plan is rebuilt on every request, so a persistently-misconfigured chain
// must not spam a warn line per request — dedupe by (candidate, reason).
const seenCandidateWarnings = new Set<string>();

export class ConfiguredSummaryPlan {
    private readonly candidates: readonly SummaryCandidate[];
    private readonly settings: ExternalSummarySettings;
    readonly deadline: number;
    /** #2662: batches submitted vs candidate calls actually dispatched —
     *  calls > 0 && attempts === 0 means the shared pool dropped every batch
     *  before dispatch (congestion, not a chain failure). */
    readonly stats = { calls: 0, attempts: 0 };

    // `raw` may be an already-parsed chain off the request rail or raw JSON
    // from a hand-edited file — re-parse here so invalid settings fail
    // loudly at plan build, never silently use main-model summaries.
    constructor(raw: unknown, store = new SummaryCredentialStore(), env: NodeJS.ProcessEnv = process.env) {
        // inlineKeys: the rail may carry agent-registry recipes whose keys
        // were resolved in the agent's memory (#2336) — literal apiKey bytes
        // instead of a credentialRef.
        this.settings = parseExternalSummarySettings(raw, { inlineKeys: true });
        const proxyUrl = env.BILI_UPSTREAM_PROXY?.trim() || undefined;
        this.deadline = performance.now() + this.settings.budget.totalTimeoutMs;
        this.candidates = this.settings.targets.map((target) => {
            try {
                const key = target.apiKey !== undefined ? target.apiKey : store.resolve(target.credentialRef ?? "", env);
                if (!key) throw new Error(`credential ${target.credentialRef || "(none)"} did not resolve to a value`);
                const headers: Record<string, string> = target.protocol === "anthropic" ? { "x-api-key": key }
                    : target.protocol === "google" ? { "x-goog-api-key": key }
                    : { authorization: `Bearer ${key}` };
                return createSummaryHttpCandidate({ ...target, headers, proxyUrl }, this.settings.budget.maxSummaryBytes * 4 + 65536);
            } catch (error) {
                // Log WHY this target is unusable (once per signature) so a
                // misconfigured chain is diagnosable instead of silently degrading
                // every fold to main-model summaries (#2484). The placeholder keeps
                // its generic message so no private detail leaks into results/wire.
                const reason = error instanceof Error ? error.message : String(error);
                const signature = `${target.name}|${reason}`;
                if (!seenCandidateWarnings.has(signature)) {
                    seenCandidateWarnings.add(signature);
                    loggerLog("warn", `[external-summary] candidate ${target.name} unavailable: ${reason} — it will be skipped until fixed`);
                }
                return { async summarize(): Promise<string> { throw new Error("External summary candidate unavailable"); } };
            }
        });
    }

    async summarize(work: readonly SummaryWork[], signal?: AbortSignal): Promise<ExternalSummaryBatchResult> {
        const remaining = Math.floor(this.deadline - performance.now());
        if (remaining <= 0) {
            this.stats.calls += 1;
            return { status: "deadline", results: [] };
        }
        const batch = await executor.executeBatch(work, this.candidates, {
            ...this.settings.budget, totalTimeoutMs: remaining,
            targetTimeoutMs: Math.min(remaining, this.settings.budget.targetTimeoutMs),
        }, signal);
        this.stats.calls += 1;
        for (const item of batch.results) this.stats.attempts += item.attempts.length;
        return batch;
    }
}

/** Build the per-request plan from the RESOLVED settings riding the request
 *  Config rail (`ResolvedKernelConfig.externalSummary`, merged by
 *  `mergeCompress` with whole-chain-replace semantics). undefined/disabled →
 *  undefined (legacy in-model summaries). Invalid settings throw — they must
 *  fail loudly, never silently fall back to main-model summaries. */
export function configuredSummaryPlan(settings: unknown): ConfiguredSummaryPlan | undefined {
    if (!settings || typeof settings !== "object") return undefined;
    if ((settings as { enabled?: unknown }).enabled !== true) return undefined;
    return new ConfiguredSummaryPlan(settings);
}
