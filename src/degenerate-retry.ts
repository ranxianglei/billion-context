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
// Bounded: the first re-issue carries the plain continuation nudge, a second
// (final) re-issue carries the anti-echo escalation (#2176: chronic tag-echo
// where the model keeps answering with markup only). The body mutation never
// touches session state, so the nudge is neither persisted nor replayed on
// the client's next request.
export const DEGENERATE_RETRY_NUDGE =
    "[billion-context] Your previous response ended with no visible text and no tool call. Continue now: take your next concrete action.";

/** #2176: the second (escalated) re-issue. The first nudge says "continue";
 *  a model that answers with markup again is imitating the render tags it saw
 *  in its prompt, so this one names the behavior to stop and the output to
 *  produce instead. Mentioning the tags here is deliberate: at this point the
 *  turn is already lost, and the instruction rides a one-shot trailing user
 *  message that is never persisted. */
export const DEGENERATE_RETRY_NUDGE_ESCALATED =
    "[billion-context] Your last two responses contained only message-reference tags with no visible text and no tool call — those tags are stripped before anyone reads them. Do not output them. Answer now in plain prose, or make a tool call.";

/** #2176: re-issues per degenerate turn (1 = plain nudge, 2 = escalated). */
export const DEGENERATE_RETRY_MAX_ATTEMPTS = 2;

/** The retry body: the forwarded body with the continuation nudge appended as a
 *  trailing user turn. Null when the body cannot carry one. `escalated` selects
 *  the #2176 anti-echo nudge (second and final attempt). */
export function injectContinuationNudge(protocol: WireProtocol, body: string | Buffer, escalated = false): string | null {
    return appendTrailingUserText(protocol, body, escalated ? DEGENERATE_RETRY_NUDGE_ESCALATED : DEGENERATE_RETRY_NUDGE);
}

export interface ContinuationRetryOpts {
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
}

/** Build the re-request used when a turn ends with no visible output. Returns a
 *  function for the stream pipe: it yields the retry's response body, or null
 *  when the retry cannot be issued (unbuildable body, upstream error, client
 *  already gone) — the caller then passes the original empty turn through
 *  unchanged. Callers that escalate pass `true` for the #2176 anti-echo nudge
 *  (the caller tracks attempt count; the closure is stateless). */
export function makeContinuationRefetch(opts: ContinuationRetryOpts): (escalated?: boolean) => Promise<ReadableStream<Uint8Array> | null> {
    return async (escalated = false) => {
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
        const retryBody = injectContinuationNudge(opts.protocol, opts.body, escalated);
        if (retryBody === null) {
            opts.log("warn", `[${opts.label}] [plugin] degenerate-terminal retry skipped: request body carries no turn array`);
            return null;
        }
        try {
            opts.resign?.(opts.reqHeaders, retryBody);
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

/** #2176: aggregate view of the degenerate-retry counters carried in
 *  session.stats, surfaced by /__bili/status so the chronic tag-echo tail is
 *  measurable in the field (fired re-issues and turns no re-issue could
 *  save). Sessions without counters are skipped from the session count. */
export function degenerateRetrySummary(sessions: Array<{ stats?: { degenerateRetries?: number; degenerateExhausted?: number } }>): { sessions: number; retries: number; exhausted: number } {
    let touched = 0;
    let retries = 0;
    let exhausted = 0;
    for (const s of sessions) {
        const r = s.stats?.degenerateRetries ?? 0;
        const e = s.stats?.degenerateExhausted ?? 0;
        if (r === 0 && e === 0) continue;
        touched += 1;
        retries += r;
        exhausted += e;
    }
    return { sessions: touched, retries, exhausted };
}
