import { SummaryCredentialStore } from "./external-summary-credentials.js";
import { createSummaryHttpCandidate } from "./external-summary-http.js";
import { ExternalSummaryError, externalSummaryFingerprint, type ExternalBatchOutcome, type ExternalSummaryFailureClass } from "./external-summary-failures.js";
import { parseExternalSummarySettings, SUMMARY_CONCURRENCY_DEFAULT, type ExternalSummarySettings } from "./external-summary-settings.js";
import { ExternalSummaryExecutor, type ExternalSummaryBatchResult, type SummaryCandidate, type SummaryWork } from "./external-summary.js";
import { log as loggerLog } from "./logger.js";

// One shared queue across all sessions and all compression entry points; its
// base size is the config default — a chain's `concurrency` resizes it for
// that batch's lifetime (#2657).
const executor = new ExternalSummaryExecutor(SUMMARY_CONCURRENCY_DEFAULT);

// Test seam (#2662): saturate the process-wide pool deterministically.
export const _executorForTest = executor;

// The plan is rebuilt on every request, so a persistently-misconfigured chain
// must not spam a warn line per request — dedupe by (candidate, reason).
const seenCandidateWarnings = new Set<string>();

export class ConfiguredSummaryPlan {
    private readonly candidates: readonly SummaryCandidate[];
    private readonly settings: ExternalSummarySettings;
    /** #2662: summarize() invocations vs candidate calls actually dispatched —
     *  calls > 0 && attempts === 0 means no candidate call was ever dispatched
     *  (shared-pool congestion, or the plan's budget already exhausted before
     *  reaching the pool — congestion, not a chain failure). */
    readonly stats = { calls: 0, attempts: 0 };
    /** #3638: stable chain identity for the per-session failure latch. */
    readonly fingerprint: string;
    /** #3638: caller-visible labels for diagnostics (config values, not secrets). */
    readonly targetLabels: readonly { readonly name: string; readonly protocol: string; readonly model: string }[];
    private readonly onBatch: ((outcome: ExternalBatchOutcome) => void) | undefined;
    private readonly sessionId: string | undefined;

    // `raw` may be an already-parsed chain off the request rail or raw JSON
    // from a hand-edited file — re-parse here so invalid settings fail
    // loudly at plan build, never silently use main-model summaries.
    constructor(raw: unknown, store = new SummaryCredentialStore(), env: NodeJS.ProcessEnv = process.env, sessionId?: string, options?: { onBatch?: (outcome: ExternalBatchOutcome) => void }) {
        // inlineKeys: the rail may carry agent-registry recipes whose keys
        // were resolved in the agent's memory (#2336) — literal apiKey bytes
        // instead of a credentialRef.
        this.settings = parseExternalSummarySettings(raw, { inlineKeys: true });
        this.sessionId = sessionId;
        // Fingerprint the RAW chain, not the parsed settings: the latch
        // consumers (catch paths, lane nudge render) see the unresolved rail
        // chain, and parseExternalSummarySettings fills defaults / normalizes
        // URLs, which would make the two fingerprints disagree (#3638 review).
        this.fingerprint = externalSummaryFingerprint(raw);
        this.targetLabels = this.settings.targets.map((target) => ({ name: target.name, protocol: target.protocol, model: target.model }));
        this.onBatch = options?.onBatch;
        const proxyUrl = env.BILI_UPSTREAM_PROXY?.trim() || undefined;
        this.candidates = this.settings.targets.map((target) => {
            try {
                const key = target.apiKey !== undefined ? target.apiKey : store.resolve(target.credentialRef ?? "", env);
                if (!key) throw new Error(`credential ${target.credentialRef || "(none)"} did not resolve to a value`);
                const headers: Record<string, string> = target.protocol === "anthropic" ? { "x-api-key": key }
                    : target.protocol === "google" ? { "x-goog-api-key": key }
                    : { authorization: `Bearer ${key}` };
                return createSummaryHttpCandidate({ ...target, headers, proxyUrl, ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}) }, this.settings.budget.maxSummaryBytes * 4 + 65536);
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
                // #3638: typed so the caller-visible diagnostic names the class
                // (candidate_unavailable) without leaking the private reason.
                return { async summarize(): Promise<string> { throw new ExternalSummaryError({ cls: "candidate_unavailable" }); } };
            }
        });
    }

    async summarize(work: readonly SummaryWork[], signal?: AbortSignal): Promise<ExternalSummaryBatchResult> {
        // Deliberately NO cached deadline here: preflight reuses one plan across
        // many summarize() calls, so each must get the FULL configured budget —
        // a construction-time clock point went stale mid-round and starved every
        // later range (#2639). The model-tool path packs all ranges into one call,
        // where executeBatch's shared deadline still bounds the whole batch.
        const attemptsBefore = this.stats.attempts;
        const batch = await executor.executeBatch(work, this.candidates, { ...this.settings.budget }, signal, { concurrency: this.settings.concurrency });
        this.stats.calls += 1;
        for (const item of batch.results) this.stats.attempts += item.attempts.length;
        // #3638: report the batch to the session-scoped latch consumer.
        // dispatched=false (pool dropped everything, #2662) means congestion —
        // the latch consumer ignores it rather than counting a chain failure.
        if (this.onBatch) {
            const classes = new Set<ExternalSummaryFailureClass>();
            for (const item of batch.results) for (const attempt of item.attempts) if (attempt.failure?.cls) classes.add(attempt.failure.cls);
            this.onBatch({
                successes: batch.results.filter((item) => item.status === "success").length,
                total: batch.results.length,
                classes: [...classes],
                fingerprint: this.fingerprint,
                dispatched: this.stats.attempts > attemptsBefore,
            });
        }
        return batch;
    }
}

/** Build the per-request plan from the RESOLVED settings riding the request
 *  Config rail (`ResolvedKernelConfig.externalSummary`, merged by
 *  `mergeCompress` with whole-chain-replace semantics). undefined/disabled →
 *  undefined (legacy in-model summaries). Invalid settings throw — they must
 *  fail loudly, never silently fall back to main-model summaries. */
export function configuredSummaryPlan(settings: unknown, sessionId?: string, options?: { onBatch?: (outcome: ExternalBatchOutcome) => void }): ConfiguredSummaryPlan | undefined {
    if (!settings || typeof settings !== "object") return undefined;
    if ((settings as { enabled?: unknown }).enabled !== true) return undefined;
    return new ConfiguredSummaryPlan(settings, new SummaryCredentialStore(), process.env, sessionId, options);
}
