import { Agent } from "undici";

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

const liveUpstreamTimers = new Set<ReturnType<typeof setTimeout>>();
/** Test hook: how many fetchWithTimeout idle-timers are currently armed.
 *  #411: an aborted passthrough used to leak its 10-minute timer because
 *  clearTimer was only called on the success path — tests assert this stays
 *  at zero after a client abort. */
export function _liveUpstreamTimersForTest(): number {
    return liveUpstreamTimers.size;
}

/** Idle-timeout budget for upstream requests; overridable via
 *  BILI_UPSTREAM_TIMEOUT_MS (milliseconds). Read on each call so tests can
 *  tune it live. Local-model deployments with very large contexts can need
 *  prefills longer than the 10-minute default before their first token. */
export function upstreamTimeoutMs(): number {
    const raw = Number(process.env.BILI_UPSTREAM_TIMEOUT_MS);
    return Number.isInteger(raw) && raw > 0 ? raw : UPSTREAM_TIMEOUT_MS;
}

// Direct (non-proxied) requests go through Node's hidden global agent, whose
// undici headersTimeout/bodyTimeout defaults are both 300s — that cap silently
// killed long prefills before this watchdog ever got a chance (#551). Inject an
// explicit Agent per timeout value so the transport layer matches the watchdog
// instead of firing first.
const directDispatchers = new Map<number, Agent>();

function directDispatcher(timeoutMs: number): Agent {
    let agent = directDispatchers.get(timeoutMs);
    if (!agent) {
        agent = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
        directDispatchers.set(timeoutMs, agent);
    }
    return agent;
}

export function _resetFetchUtilForTest(): void {
    for (const agent of directDispatchers.values()) {
        try { void agent.close().catch(() => undefined); } catch { /* already closed */ }
    }
    directDispatchers.clear();
}

/** undici's fetch accepts a `dispatcher` option (its own Dispatcher type) that
 *  @types/node's RequestInit already declares — but typed as the internal
 *  `Dispatcher` interface, which conflicts with the `undici` package's
 *  exported `Dispatcher`. We Omit that field and re-add it as a plain
 *  `object` so any Dispatcher-shaped value (ProxyAgent from either source)
 *  is accepted, without `as any`. */
export type FetchOptions = Omit<RequestInit, "dispatcher"> & { dispatcher?: object };

/** Abort a fetch after `timeoutMs` of IDLE time. The timer starts when the
 *  fetch begins (bounding time-to-first-byte / headers) and is RE-ARMED on
 *  every response-body chunk, so it becomes an idle timeout once the body is
 *  streaming: a healthy stream that keeps producing chunks is never aborted
 *  mid-flight (LLM generations can legitimately run for minutes — a total
 *  timer would kill a healthy 12-minute stream at the 10-minute mark), while a
 *  genuinely stuck stream (no chunk for `timeoutMs`) still trips the abort.
 *  Callers receive a `clearTimer` callback and invoke it once the response
 *  stream has been fully consumed (or on the error path) to stop the timer.
 *
 *  `opts.dispatcher` (optional) routes the fetch through an upstream proxy
 *  (an `undici.ProxyAgent`). When omitted, a direct `undici.Agent` cached per
 *  timeout value is injected — its headersTimeout/bodyTimeout match the idle
 *  watchdog below so undici's hidden 300s transport defaults can never fire
 *  first (#551).
 *
 *  `externalSignal` (optional) lets the caller abort the in-flight request
 *  independently of the timeout — e.g. when the downstream client disconnects.
 *  When it fires, the internal controller aborts as well, which (a) cancels
 *  any pending fetch and (b) frees the body stream promptly. */
export async function fetchWithTimeout(
    url: string,
    opts: FetchOptions,
    timeoutMs?: number,
    externalSignal?: AbortSignal,
): Promise<{ response: Response; clearTimer: () => void }> {
    const effective = timeoutMs ?? upstreamTimeoutMs();
    const controller = new AbortController();
    const armTimer = () => {
        const t = setTimeout(() => {
            liveUpstreamTimers.delete(t);
            controller.abort();
        }, effective);
        liveUpstreamTimers.add(t);
        return t;
    };
    let timer = armTimer();
    const rearm = () => {
        clearTimeout(timer);
        liveUpstreamTimers.delete(timer);
        timer = armTimer();
    };
    let onExternalAbort: (() => void) | null = null;
    if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else {
            onExternalAbort = () => controller.abort();
            externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        }
    }
    const cleanup = () => {
        clearTimeout(timer);
        liveUpstreamTimers.delete(timer);
        if (onExternalAbort && externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    };
    try {
        const finalOpts: Omit<RequestInit, "dispatcher"> & { dispatcher?: object } = {
            ...opts,
            signal: controller.signal,
            dispatcher: opts.dispatcher ?? directDispatcher(effective),
        };
        // `fetch` is undici's global; it accepts `dispatcher` at runtime. @types/node
        // types RequestInit.dispatcher as its internal `Dispatcher` interface,
        // which structurally conflicts with the `undici` package's exported
        // Dispatcher — but at runtime they're the same thing. Assert to the
        // concrete RequestInit type (no `as any`) to satisfy the call site.
        const raw = await fetch(url, finalOpts as RequestInit) as Response;
        if (raw.body) {
            // Wrap the body so each chunk re-arms the timer (idle timeout); carry
            // status/headers onto a fresh Response so callers see an identical shape.
            const wrapped = armIdleBody(raw.body, rearm);
            return {
                response: new Response(wrapped, {
                    status: raw.status,
                    statusText: raw.statusText,
                    headers: raw.headers,
                }),
                clearTimer: cleanup,
            };
        }
        return { response: raw, clearTimer: cleanup };
    } catch (e) {
        cleanup();
        throw e;
    }
}

function armIdleBody(body: ReadableStream<Uint8Array>, rearm: () => void): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const result = await reader.read();
                if (result.done) {
                    controller.close();
                    return;
                }
                rearm();
                controller.enqueue(result.value);
            } catch (e) {
                controller.error(e);
            }
        },
        async cancel(reason) {
            try {
                await reader.cancel(reason);
            } catch {
                /* already closed */
            }
        },
    });
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
