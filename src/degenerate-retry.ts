import { fetchWithTimeout } from "./fetch-util.js";
import { noteUpstreamThrottle429, noteUpstreamThrottleResolved, upstreamThrottleLocalReject } from "./upstream-throttle.js";
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
// Wording covers BOTH retry shapes: the empty-turn shape (#732/#821) and the
// draft-tail shape (#2303, visible prose ending in a compression-draft closing
// tag) — both are "ended without a tool call", and both need the same push:
// issue the pending action or state the final answer explicitly.
export const DEGENERATE_RETRY_NUDGE =
    "[billion-context] Your previous response ended without a tool call. Continue now: take your next concrete action — issue the tool call you were about to make, or state your final answer explicitly.";

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
    /** #1884: re-sign the retry body before it hits the wire (armed re-sign
     *  lane only; undefined on unsigned traffic). The retry body carries an
     *  injected continuation nudge, so the previous signature is stale. */
    resign?: (headers: Record<string, string>, body: string | Buffer) => void;
    /** #3280: v1internal egress re-wrap — `body` above is the INNER request
     *  (the nudge needs top-level contents), so the retry goes out enveloped. */
    wrapBody?: (body: string | Buffer) => string | Buffer;
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
        const wireRetryBody = opts.wrapBody ? opts.wrapBody(retryBody) : retryBody;
        try {
            opts.resign?.(opts.reqHeaders, wireRetryBody);
            // #4743: the retry is an egress send like any other — feed the 429
            // governor (observe only, no local gate: the retry is bounded by
            // the degenerate-turn ladder, and holding IT locally would strand
            // the client's already-open response stream). A 429 verdict arms
            // the hold for the NEXT main-lane send; any other resolved status
            // clears it — same one-observation-per-request discipline as relay.
            const throttleReject = upstreamThrottleLocalReject(opts.upstreamUrl, opts.reqHeaders);
            if (throttleReject !== undefined) {
                opts.log("info", `[${opts.label}] [plugin] degenerate-terminal retry answered locally by the 429 hold (#4204) — passing the empty turn through`);
                return null;
            }
            const r = await fetchWithTimeout(
                opts.upstreamUrl,
                {
                    method: "POST",
                    headers: opts.reqHeaders,
                    body: wireRetryBody,
                    ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : opts.proxyUrl ? { dispatcher: proxyDispatcher(opts.proxyUrl) } : {}),
                },
                undefined,
                opts.signal,
            );
            if (!r.response.ok || !r.response.body) {
                r.clearTimer();
                if (r.response.status === 429) noteUpstreamThrottle429(opts.upstreamUrl, opts.reqHeaders, r.response.headers.get("retry-after"));
                else noteUpstreamThrottleResolved(opts.upstreamUrl, opts.reqHeaders, r.response.status);
                opts.log("warn", `[${opts.label}] [plugin] degenerate-terminal retry rejected (HTTP ${r.response.status}); passing the empty turn through`);
                return null;
            }
            noteUpstreamThrottleResolved(opts.upstreamUrl, opts.reqHeaders, r.response.status);
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
