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

/** Abort a fetch after `timeoutMs`. Unlike the naive version, the timer is
 *  NOT cleared when headers arrive — it must cover the response BODY too
 *  (LLM SSE streams can stall mid-stream). Callers receive a `clearTimer`
 *  callback and invoke it once the response stream has been fully consumed;
 *  otherwise the timer correctly fires and aborts a stuck stream. */
export async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<{ response: Response; clearTimer: () => void }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        return { response, clearTimer: () => clearTimeout(timer) };
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}
