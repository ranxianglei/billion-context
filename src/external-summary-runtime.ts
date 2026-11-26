import { createHash } from "node:crypto";
import { SummaryCredentialStore } from "./external-summary-credentials.js";
import { createSummaryHttpCandidate } from "./external-summary-http.js";
import { parseExternalSummarySettings, SUMMARY_CONCURRENCY_DEFAULT, type ExternalSummarySettings } from "./external-summary-settings.js";
import { ExternalSummaryExecutor, targetInputBudget, type ExternalSummaryBatchResult, type SummaryCandidate, type SummaryWork } from "./external-summary.js";
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
    readonly fingerprint: string;
    private readonly sessionId: string | undefined;

    // `raw` may be an already-parsed chain off the request rail or raw JSON
    // from a hand-edited file — re-parse here so invalid settings fail
    // loudly at plan build, never silently use main-model summaries.
    constructor(raw: unknown, store = new SummaryCredentialStore(), env: NodeJS.ProcessEnv = process.env, sessionId?: string) {
        // inlineKeys: the rail may carry agent-registry recipes whose keys
        // were resolved in the agent's memory (#2336) — literal apiKey bytes
        // instead of a credentialRef.
        this.settings = parseExternalSummarySettings(raw, { inlineKeys: true });
        this.sessionId = sessionId;
        const proxyUrl = env.BILI_UPSTREAM_PROXY?.trim() || undefined;
        const fingerprint = createHash("sha256").update(JSON.stringify({ settings: this.settings, proxyUrl }));
        this.candidates = this.settings.targets.map((target) => {
            try {
                const key = target.apiKey !== undefined ? target.apiKey : store.resolve(target.credentialRef ?? "", env);
                fingerprint.update(JSON.stringify(key ?? null));
                if (!key) throw new Error(`credential ${target.credentialRef || "(none)"} did not resolve to a value`);
                const headers: Record<string, string> = target.protocol === "anthropic" ? { "x-api-key": key }
                    : target.protocol === "google" ? { "x-goog-api-key": key }
                    : { authorization: `Bearer ${key}` };
                // SSE repeats framing/model metadata for every token; those bytes
                // are not summary content. Keep a bounded transport allowance while
                // the executor independently enforces maxSummaryBytes on the text.
                const jsonResponseBytes = this.settings.budget.maxSummaryBytes * 4 + 65536;
                const responseBytes = target.stream ? Math.max(8 * 1024 * 1024, jsonResponseBytes) : jsonResponseBytes;
                // #4833: hand the candidate its configured budgets so failure
                // lines can state what was actually in force for this chain.
                return createSummaryHttpCandidate({ ...target, headers, proxyUrl, ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}) }, responseBytes, { targetTimeoutMs: this.settings.budget.targetTimeoutMs, totalTimeoutMs: this.settings.budget.totalTimeoutMs });
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
        this.fingerprint = fingerprint.digest("hex");
    }

    async summarize(work: readonly SummaryWork[], signal?: AbortSignal): Promise<ExternalSummaryBatchResult> {
        // Deliberately NO cached deadline here: preflight reuses one plan across
        // many summarize() calls, so each must get the FULL configured budget —
        // a construction-time clock point went stale mid-round and starved every
        // later range (#2639). The model-tool path packs all ranges into one call,
        // where executeBatch's shared deadline still bounds the whole batch.
        const batch = await executor.executeBatch(work, this.candidates, { ...this.settings.budget }, signal, { concurrency: this.settings.concurrency });
        this.stats.calls += 1;
        for (const item of batch.results) this.stats.attempts += item.attempts.length;
        return batch;
    }

    /** #6945: the tightest per-target input budget across the chain — the
     *  smallest (contextWindow - outputTokens - 256) — for the manual lane's
     *  pre-validation of nominated ranges. A range whose input tokens exceed
     *  this is rejected by the smallest target's guard before any fetch.
     *  Undefined when the chain has no targets (a disabled/empty chain never
     *  reaches the manual lane). */
    get tightestInputBudget(): number | undefined {
        let tightest: number | undefined;
        for (const target of this.settings.targets) {
            const room = targetInputBudget(target.contextWindow, target.outputTokens);
            if (tightest === undefined || room < tightest) tightest = room;
        }
        return tightest;
    }
}

/** Build the per-request plan from the RESOLVED settings riding the request
 *  Config rail (`ResolvedKernelConfig.externalSummary`, merged by
 *  `mergeCompress` with whole-chain-replace semantics). undefined/disabled →
 *  undefined (legacy in-model summaries). Invalid settings throw — they must
 *  fail loudly, never silently fall back to main-model summaries. */
export function configuredSummaryPlan(settings: unknown, sessionId?: string): ConfiguredSummaryPlan | undefined {
    if (!settings || typeof settings !== "object") return undefined;
    if ((settings as { enabled?: unknown }).enabled !== true) return undefined;
    return new ConfiguredSummaryPlan(settings, new SummaryCredentialStore(), process.env, sessionId);
}
