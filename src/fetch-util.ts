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
 *  (an `undici.ProxyAgent`). When omitted, fetch uses its default agent. */
export async function fetchWithTimeout(
    url: string,
    opts: FetchOptions,
    timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<{ response: Response; clearTimer: () => void }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const finalOpts: Omit<RequestInit, "dispatcher"> & { dispatcher?: object } = { ...opts, signal: controller.signal };
        // `fetch` is undici's global; it accepts `dispatcher` at runtime. @types/node
        // types RequestInit.dispatcher as its internal `Dispatcher` interface,
        // which structurally conflicts with the `undici` package's exported
        // Dispatcher — but at runtime they're the same thing. Assert to the
        // concrete RequestInit type (no `as any`) to satisfy the call site.
        const response = await fetch(url, finalOpts as RequestInit);
        return { response: response as Response, clearTimer: () => clearTimeout(timer) };
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}
