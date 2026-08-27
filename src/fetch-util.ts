/** HTTP robustness helpers for the proxy.

  - readBody is capped: an unbounded request body is a memory-exhaustion
    vector when the proxy listens publicly. 100 MB is generous for LLM
    payloads (which can carry large tool results / file contents) while
    still rejecting pathological sizes.
  - fetchWithTimeout wraps upstream requests with an AbortController so a
    stuck upstream cannot hold a client connection open forever. LLM
    streams can legitimately run for minutes, so the default is long. */

export const MAX_REQUEST_BYTES = 100 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

/** undici's fetch accepts a `dispatcher` option (its own Dispatcher type) that
 *  @types/node's RequestInit already declares — but typed as the internal
 *  `Dispatcher` interface, which conflicts with the `undici` package's
 *  exported `Dispatcher`. We Omit that field and re-add it as a plain
 *  `object` so any Dispatcher-shaped value (ProxyAgent from either source)
 *  is accepted, without `as any`. */
export type FetchOptions = Omit<RequestInit, "dispatcher"> & { dispatcher?: object };

/** Abort a fetch after `timeoutMs`. Unlike the naive version, the timer is
 *  NOT cleared when headers arrive — it must cover the response BODY too
 *  (LLM SSE streams can stall mid-stream). Callers receive a `clearTimer`
 *  callback and invoke it once the response stream has been fully consumed;
 *  otherwise the timer correctly fires and aborts a stuck stream.
 *
 *  `opts.dispatcher` (optional) routes the fetch through an upstream proxy
 *  (an `undici.ProxyAgent`). When omitted, fetch uses its default agent.
 *
 *  `externalSignal` (optional) lets the caller abort the in-flight request
 *  independently of the timeout — e.g. when the downstream client disconnects.
 *  When it fires, the internal controller aborts as well, which (a) cancels
 *  any pending fetch and (b) frees the body stream promptly. */
export async function fetchWithTimeout(
    url: string,
    opts: FetchOptions,
    timeoutMs: number = UPSTREAM_TIMEOUT_MS,
    externalSignal?: AbortSignal,
): Promise<{ response: Response; clearTimer: () => void }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let onExternalAbort: (() => void) | null = null;
    if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else {
            onExternalAbort = () => controller.abort();
            externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        }
    }
    try {
        const finalOpts: Omit<RequestInit, "dispatcher"> & { dispatcher?: object } = { ...opts, signal: controller.signal };
        // `fetch` is undici's global; it accepts `dispatcher` at runtime. @types/node
        // types RequestInit.dispatcher as its internal `Dispatcher` interface,
        // which structurally conflicts with the `undici` package's exported
        // Dispatcher — but at runtime they're the same thing. Assert to the
        // concrete RequestInit type (no `as any`) to satisfy the call site.
        const response = await fetch(url, finalOpts as RequestInit);
        return {
            response: response as Response,
            clearTimer: () => {
                clearTimeout(timer);
                if (onExternalAbort && externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
            },
        };
    } catch (e) {
        clearTimeout(timer);
        if (onExternalAbort && externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
        throw e;
    }
}

/** Upstream HTTP failure after all retry attempts are exhausted (or a
 *  non-transient error that fails fast). `attempts` is the number of requests
 *  actually made; `body` is the upstream error body (already read). */
export class UpstreamHttpError extends Error {
    readonly status: number;
    readonly body: string;
    readonly attempts: number;
    constructor(status: number, body: string, attempts: number) {
        super(`upstream error ${status}`);
        this.name = "UpstreamHttpError";
        this.status = status;
        this.body = body;
        this.attempts = attempts;
    }
}

/** Body markers indicating an upstream 4xx is a transient risk-control /
 *  rate-limit rejection rather than a genuine client error. GLM Coding Plan
 *  returns 400 {"code":3007,"msg":"captcha verify failed"} ~1s after large
 *  context rewrites (issue #189); every observed case recovered on retry,
 *  so such bodies are retried while plain 4xx (bad model, bad params) fail fast. */
const TRANSIENT_BODY_MARKERS = [
    "captcha",
    "verify failed",
    "risk control",
    "风控",
    "rate limit",
    "too many requests",
    "try again",
];

export function isTransientUpstreamError(status: number, body: string): boolean {
    if (status === 429 || status >= 500) return true;
    if (status < 400) return false;
    const lower = body.toLowerCase();
    return TRANSIENT_BODY_MARKERS.some((marker) => lower.includes(marker));
}

/** Total requests per replay attempt (initial + retries). */
export const REPLAY_MAX_ATTEMPTS = 3;

/** Total requests per replay attempt; overridable via BILI_REPLAY_RETRY_MAX
 *  (1 = legacy fail-fast behavior, no retry). Read on each call so tests can
 *  tune it live. */
export function replayMaxAttempts(): number {
    const raw = Number(process.env.BILI_REPLAY_RETRY_MAX);
    return Number.isInteger(raw) && raw >= 1 ? raw : REPLAY_MAX_ATTEMPTS;
}

/** Base backoff delay in ms; overridable via BILI_REPLAY_RETRY_BASE_MS
 *  (0 disables the delay). Read on each call so tests can tune it live. */
export function replayBaseDelayMs(): number {
    const raw = Number(process.env.BILI_REPLAY_RETRY_BASE_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}

/** Max shrink FRACTION (0,1] a single compress may remove before the proxy
 *  steers the model toward smaller, tail-biased ranges (#189 staged
 *  compression). A rewrite larger than this is the request-shape change that
 *  trips provider risk-control (GLM 3007); capping it keeps each round's
 *  transition gentle and the prefix cache alive. Unset (or out of range) =
 *  no steering (legacy behavior). Read on each call so tests can tune it live. */
export function maxShrinkPerCompress(): number | undefined {
    const raw = Number(process.env.BILI_MAX_SHRINK_PER_COMPRESS);
    return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : undefined;
}

/** Exponential backoff for the given 1-based attempt: base * 2^(attempt-1). */
export function replayBackoffMs(attempt: number): number {
    return replayBaseDelayMs() * 2 ** (attempt - 1);
}

/** Abortable sleep: resolves early if `signal` fires (downstream disconnect).
 *  ms <= 0 resolves immediately. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = () => {
            if (timer) clearTimeout(timer);
            if (signal) signal.removeEventListener("abort", finish);
            resolve();
        };
        timer = setTimeout(finish, ms);
        if (signal) signal.addEventListener("abort", finish, { once: true });
    });
}

export interface ReplayRetryInfo {
    attempt: number;
    status: number;
    detail: string;
    delayMs: number;
    maxAttempts: number;
}

/** fetchWithTimeout with bounded retry on transient upstream HTTP failures.
 *  For acp-loop replay requests, where provider risk-control may briefly
 *  reject a request whose context was just rewritten (#189). Network-level
 *  failures (timeout, connection reset) propagate unchanged — NOT retried
 *  here, to avoid stacking the 10-min timeout across attempts. */
export async function fetchWithRetry(
    url: string,
    opts: FetchOptions,
    timeoutMs: number | undefined,
    externalSignal: AbortSignal | undefined,
    onRetry?: (info: ReplayRetryInfo) => void,
): Promise<{ response: Response; clearTimer: () => void }> {
    const maxAttempts = replayMaxAttempts();
    for (let attempt = 1; ; attempt++) {
        const result = await fetchWithTimeout(url, opts, timeoutMs, externalSignal);
        if (result.response.ok) return result;
        const errText = await result.response.text().catch(() => "upstream error");
        result.clearTimer();
        const lastAttempt = attempt >= maxAttempts;
        if (!lastAttempt && isTransientUpstreamError(result.response.status, errText)) {
            const delayMs = replayBackoffMs(attempt);
            onRetry?.({ attempt, status: result.response.status, detail: errText, delayMs, maxAttempts });
            await sleep(delayMs, externalSignal);
            continue;
        }
        throw new UpstreamHttpError(result.response.status, errText, attempt);
    }
}
