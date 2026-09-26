import { fetchWithTimeout } from "./fetch-util.js";
import { hasCompactionTrigger } from "./codex-compact.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import type { WireProtocol } from "./util.js";
import { appendTrailingUserText } from "./wire-body.js";

// #732/#821 ran this retry for the compress loop, which owns the request body
// AND the response framing. The plugin pipe (plugin mode, and proxy-mode chat
// SSE that skipped compress injection) owns neither: it forwards the agent's
// own body and passes the upstream stream through byte-identically, so a turn
// that ends with nothing visible — the render-tag echo case, where the tag
// filter empties the only text block — reaches the host as an empty completed
// turn and the host aborts it. The pipe can still re-issue the SAME body
// (plus this nudge) because it holds the upstream URL and the forwarded
// headers, and it can splice the retry's content into the open client stream.
// Bounded to one attempt per turn; the body mutation never touches session
// state, so the nudge is neither persisted nor replayed on the client's next
// request.
export const DEGENERATE_RETRY_NUDGE =
    "[billion-context] Your previous response ended with no visible text and no tool call. Continue now: take your next concrete action.";

/** The retry body: the forwarded body with the continuation nudge appended as a
 *  trailing user turn. Null when the body cannot carry one. */
export function injectContinuationNudge(protocol: WireProtocol, body: string | Buffer): string | null {
    return appendTrailingUserText(protocol, body, DEGENERATE_RETRY_NUDGE);
}

interface ContinuationRetryOpts {
    protocol: WireProtocol;
    /** The body that was forwarded upstream (the agent's own, in plugin mode). */
    body: string | Buffer;
    upstreamUrl: string;
    reqHeaders: Record<string, string>;
    proxyUrl?: string;
    dispatcher?: object;
    signal: AbortSignal;
    log: (level: string, msg: string) => void;
    /** Log prefix, normally the session id. */
    label: string;
}

/** Build the re-request used when a turn ends with no visible output. Returns a
 *  function for the stream pipe: it yields the retry's response body, or null
 *  when the retry cannot be issued (unbuildable body, upstream error, client
 *  already gone) — the caller then passes the original empty turn through
 *  unchanged. */
export function makeContinuationRefetch(opts: ContinuationRetryOpts): () => Promise<ReadableStream<Uint8Array> | null> {
    return async () => {
        if (opts.signal.aborted) return null;
        // A body whose final input item is a compaction trigger must never be
        // re-issued: appending the nudge after it breaks the wire shape (#283:
        // the trigger stays the last input item), and the trigger's terminal is
        // decided by the compaction flow, not by an empty-turn retry. Parsed
        // here, at retry time, so healthy turns pay nothing.
        if (opts.protocol === "responses") {
            try {
                const parsed = JSON.parse(typeof opts.body === "string" ? opts.body : opts.body.toString("utf8")) as Record<string, unknown>;
                if (hasCompactionTrigger(parsed["input"])) {
                    opts.log("warn", `[${opts.label}] [plugin] degenerate-terminal retry skipped: request ends on a compaction trigger`);
                    return null;
                }
            } catch {
                /* unparseable body: injectContinuationNudge below reports and skips */
            }
        }
        const retryBody = injectContinuationNudge(opts.protocol, opts.body);
        if (retryBody === null) {
            opts.log("warn", `[${opts.label}] [plugin] degenerate-terminal retry skipped: request body carries no turn array`);
            return null;
        }
        try {
            const r = await fetchWithTimeout(
                opts.upstreamUrl,
                {
                    method: "POST",
                    headers: opts.reqHeaders,
                    body: retryBody,
                    ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : opts.proxyUrl ? { dispatcher: proxyDispatcher(opts.proxyUrl) } : {}),
                },
                undefined,
                opts.signal,
            );
            if (!r.response.ok || !r.response.body) {
                r.clearTimer();
                opts.log("warn", `[${opts.label}] [plugin] degenerate-terminal retry rejected (HTTP ${r.response.status}); passing the empty turn through`);
                return null;
            }
            const body = r.response.body as ReadableStream<Uint8Array>;
            // The retry stream is spliced into a response the caller already
            // owns, so its own idle timer is dropped — a stalled retry then ends
            // with the client abort instead of an upstream watchdog (the
            // streamed re-request in reasoning-guard.ts does the same).
            r.stopIdleTimer();
            return body;
        } catch (e) {
            opts.log("warn", `[${opts.label}] [plugin] degenerate-terminal retry failed (${e instanceof Error ? e.message : String(e)}); passing the empty turn through`);
            return null;
        }
    };
}
