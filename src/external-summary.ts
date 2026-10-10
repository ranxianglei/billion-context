export interface SummaryWork {
    readonly content: string;
    readonly instructions: string;
    readonly reference?: string;
    readonly minSummaryChars?: number;
    readonly maxSummaryChars?: number;
}

export interface SummaryCandidate {
    summarize(work: Readonly<SummaryWork>, signal: AbortSignal): Promise<string>;
}

export interface SummaryBudget {
    readonly totalTimeoutMs: number;
    readonly targetTimeoutMs: number;
    readonly maxSummaryBytes: number;
}

/** [#2657] Per-batch pool-size request for the shared queue. The pool grows
 *  to the LARGEST request among in-flight work and returns to its base size
 *  once that work settles — one batch never permanently resizes the pool for
 *  everyone else, so chains with different values can coexist safely. */
export interface SummaryPoolOptions {
    readonly concurrency?: number;
}

interface SummaryAttempt {
    readonly targetIndex: number;
    readonly outcome: "success" | "error" | "timeout" | "invalid_summary" | "cancelled";
}

type ExternalSummaryResult =
    | { status: "success"; summary: string; targetIndex: number; attempts: SummaryAttempt[] }
    | { status: "failed"; reason: "invalid_plan" | "exhausted"; attempts: SummaryAttempt[] }
    | { status: "cancelled" | "deadline"; attempts: SummaryAttempt[] };

export type ExternalSummaryBatchResult =
    | { status: "finished" | "cancelled" | "deadline"; results: ExternalSummaryResult[] }
    | { status: "failed"; reason: "invalid_plan"; results: [] };

type AttemptResult = { kind: "value"; value: string } | { kind: "error" } | { kind: "aborted" };
type Release = () => void;
interface Waiter {
    signal: AbortSignal;
    resolve: (release: Release | undefined) => void;
    abort: () => void;
}

function positiveInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function validBudget(budget: SummaryBudget): boolean {
    return positiveInteger(budget.totalTimeoutMs) && budget.totalTimeoutMs <= 2_147_483_647
        && positiveInteger(budget.targetTimeoutMs) && budget.targetTimeoutMs <= 2_147_483_647
        && positiveInteger(budget.maxSummaryBytes);
}

function awaitAttempt(operation: Promise<AttemptResult>, signal: AbortSignal): Promise<AttemptResult> {
    return new Promise((resolve) => {
        const abort = () => resolve({ kind: "aborted" });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        void operation.then((result) => {
            signal.removeEventListener("abort", abort);
            resolve(result);
        });
    });
}

/** Internal execution boundary only: adapters resolve wire/auth; callers own fold commits. */
export class ExternalSummaryExecutor {
    private active = 0;
    private readonly waiting: Waiter[] = [];
    private readonly baseConcurrency: number;
    private readonly scopedConcurrency = new Map<number, number>();

    constructor(concurrency: number) {
        if (!positiveInteger(concurrency)) throw new TypeError("Summary concurrency must be a positive integer");
        this.baseConcurrency = concurrency;
    }

    async execute(work: SummaryWork, candidates: readonly SummaryCandidate[], budget: SummaryBudget, signal?: AbortSignal, options?: SummaryPoolOptions): Promise<ExternalSummaryResult> {
        const endScope = this.beginScope(options);
        try {
            return await this.executeUntil(work, candidates, budget, signal);
        } finally {
            endScope();
        }
    }

    async executeBatch(work: readonly SummaryWork[], candidates: readonly SummaryCandidate[], budget: SummaryBudget, signal?: AbortSignal, options?: SummaryPoolOptions): Promise<ExternalSummaryBatchResult> {
        const endScope = this.beginScope(options);
        try {
            return await this.executeBatchInner(work, candidates, budget, signal);
        } finally {
            endScope();
        }
    }

    private async executeBatchInner(work: readonly SummaryWork[], candidates: readonly SummaryCandidate[], budget: SummaryBudget, signal?: AbortSignal): Promise<ExternalSummaryBatchResult> {
        const results: ExternalSummaryResult[] = [];
        if (signal?.aborted) return { status: "cancelled", results };
        const limits = { ...budget };
        if (!validBudget(limits) || work.length === 0 || candidates.length === 0
            || candidates.some((target) => typeof target.summarize !== "function")) {
            return { status: "failed", reason: "invalid_plan", results: [] };
        }
        const deadline = performance.now() + limits.totalTimeoutMs;
        const requests = work.map((request) => Object.freeze({ ...request }));
        const targets = [...candidates];
        for (const request of requests) {
            if (signal?.aborted) return { status: "cancelled", results };
            if (performance.now() >= deadline) return { status: "deadline", results };
            const result = await this.executeUntil(request, targets, limits, signal, deadline);
            results.push(result);
            if (signal?.aborted) return { status: "cancelled", results };
            if (result.status === "cancelled" || result.status === "deadline") {
                return { status: result.status, results };
            }
            if (performance.now() >= deadline) return { status: "deadline", results };
        }
        return { status: "finished", results };
    }

    private async executeUntil(work: SummaryWork, candidates: readonly SummaryCandidate[], budget: SummaryBudget, signal?: AbortSignal, sharedDeadline?: number): Promise<ExternalSummaryResult> {
        const attempts: SummaryAttempt[] = [];
        if (signal?.aborted) return { status: "cancelled", attempts };
        const limits = { ...budget };
        if (!validBudget(limits) || !work.content.trim() || !work.instructions.trim()
            || candidates.length === 0 || candidates.some((target) => typeof target.summarize !== "function")) {
            return { status: "failed", reason: "invalid_plan", attempts };
        }
        const targets = [...candidates];
        const request = Object.freeze({ ...work });
        const overall = new AbortController();
        const cancel = () => overall.abort();
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        const deadline = Math.min(performance.now() + limits.totalTimeoutMs, sharedDeadline ?? Infinity);
        const totalTimer = setTimeout(cancel, Math.max(0, deadline - performance.now()));
        const stopped = (): ExternalSummaryResult => ({ status: signal?.aborted ? "cancelled" : "deadline", attempts });
        try {
            for (const [targetIndex, target] of targets.entries()) {
                const release = await this.acquire(overall.signal);
                if (performance.now() >= deadline) cancel();
                if (!release || overall.signal.aborted) {
                    release?.();
                    return stopped();
                }
                const attempt = new AbortController();
                const abort = () => attempt.abort();
                overall.signal.addEventListener("abort", abort, { once: true });
                if (overall.signal.aborted) abort();
                const targetDeadline = performance.now() + limits.targetTimeoutMs;
                const timer = setTimeout(abort, limits.targetTimeoutMs);
                // Retain the permit until the actual call settles, even if it ignores cancellation.
                const operation: Promise<AttemptResult> = Promise.resolve().then(() => {
                    if (performance.now() >= deadline) cancel();
                    if (performance.now() >= targetDeadline) abort();
                    if (attempt.signal.aborted) throw new Error("Summary attempt cancelled before dispatch");
                    return target.summarize(request, attempt.signal);
                }).then<AttemptResult, AttemptResult>((value) => ({ kind: "value", value }), () => ({ kind: "error" })).finally(release);
                let result: AttemptResult;
                try {
                    result = await awaitAttempt(operation, attempt.signal);
                } finally {
                    clearTimeout(timer);
                    overall.signal.removeEventListener("abort", abort);
                }
                if (performance.now() >= deadline) cancel();
                if (overall.signal.aborted) {
                    attempts.push({ targetIndex, outcome: signal?.aborted ? "cancelled" : "timeout" });
                    return stopped();
                }
                if (performance.now() >= targetDeadline) abort();
                if (result.kind === "aborted" || attempt.signal.aborted) {
                    attempts.push({ targetIndex, outcome: "timeout" });
                } else if (result.kind === "error") {
                    attempts.push({ targetIndex, outcome: "error" });
                } else if (typeof result.value !== "string" || !result.value.trim()
                    || Buffer.byteLength(result.value, "utf8") > limits.maxSummaryBytes
                    || result.value.trim().length < (request.minSummaryChars ?? 1)
                    || ((request.maxSummaryChars ?? 0) > 0 && result.value.trim().length > request.maxSummaryChars!)) {
                    attempts.push({ targetIndex, outcome: "invalid_summary" });
                } else {
                    attempts.push({ targetIndex, outcome: "success" });
                    return { status: "success", summary: result.value, targetIndex, attempts };
                }
            }
            return { status: "failed", reason: "exhausted", attempts };
        } finally {
            clearTimeout(totalTimer);
            signal?.removeEventListener("abort", cancel);
        }
    }

    /** [#2657] Register one batch's pool-size demand for its lifetime; the
     *  returned release restores the previous sizing. No-op when the batch
     *  requests no size (the base pool applies). */
    private beginScope(options?: SummaryPoolOptions): () => void {
        const requested = options?.concurrency;
        if (requested === undefined) return () => {};
        if (!positiveInteger(requested)) throw new TypeError("Summary concurrency must be a positive integer");
        const live = this.scopedConcurrency.get(requested) ?? 0;
        if (live === 0) {
            this.scopedConcurrency.set(requested, 1);
            this.drain();
        } else {
            this.scopedConcurrency.set(requested, live + 1);
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const remaining = (this.scopedConcurrency.get(requested) ?? 1) - 1;
            if (remaining > 0) this.scopedConcurrency.set(requested, remaining);
            else this.scopedConcurrency.delete(requested);
        };
    }

    private effectiveConcurrency(): number {
        let cap = this.baseConcurrency;
        for (const requested of this.scopedConcurrency.keys()) if (requested > cap) cap = requested;
        return cap;
    }

    private acquire(signal: AbortSignal): Promise<Release | undefined> {
        if (signal.aborted) return Promise.resolve(undefined);
        return new Promise((resolve) => {
            const waiter: Waiter = {
                signal, resolve,
                abort: () => {
                    const index = this.waiting.indexOf(waiter);
                    if (index >= 0) this.waiting.splice(index, 1);
                    signal.removeEventListener("abort", waiter.abort);
                    resolve(undefined);
                    this.drain();
                },
            };
            this.waiting.push(waiter);
            signal.addEventListener("abort", waiter.abort, { once: true });
            this.drain();
        });
    }

    private drain(): void {
        while (this.active < this.effectiveConcurrency() && this.waiting.length > 0) {
            const waiter = this.waiting.shift();
            if (!waiter) break;
            waiter.signal.removeEventListener("abort", waiter.abort);
            if (waiter.signal.aborted) {
                waiter.resolve(undefined);
                continue;
            }
            this.active++;
            let released = false;
            waiter.resolve(() => {
                if (released) return;
                released = true;
                this.active--;
                this.drain();
            });
        }
    }
}
