import { fetchWithTimeout } from "./fetch-util.js";
import { beginProvisionalUpstreamThrottle429, noteUpstreamThrottleResolved, releaseUpstreamThrottleProbe, requestModelFromBody, reserveUpstreamThrottleClassification, throttle429ModelScope, upstreamThrottleGate, type ThrottleClassificationReservation } from "./upstream-throttle.js";
import { hasCompactionTrigger } from "./codex-compact.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import type { WireProtocol } from "./util.js";
import { appendEchoedToolExchange, appendTrailingUserText } from "./wire-body.js";

/** #5440: the verbatim exchange the proxy appends when continuing after an
 *  echoed tool-call name — the assistant turn (carrying the echoed call) plus
 *  the canned tool result. The caller builds these per wire protocol.
 *  Module-local: the `cont` param contract of makeContinuationRefetch, no
 *  cross-file import (unused-exports INTERNAL_ONLY). */
interface EchoedToolContinuation {
    assistantMessages: Record<string, unknown>[];
    toolResultMessages: Record<string, unknown>[];
}

const MAX_THROTTLE_ERROR_BODY_BYTES = 16 * 1024;
// Keep callback latency separate from the bounded body read used for scope refinement.
const MAX_THROTTLE_ERROR_READ_MS = 250;

function cancelThrottleErrorReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    try {
        void reader.cancel().catch(() => undefined);
    } catch {
        /* cancellation is best-effort; never make the client wait for it */
    }
}

function releaseThrottleErrorReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    try {
        reader.releaseLock();
    } catch {
        /* an in-flight read still owns the lock */
    }
}
// #732/#821 ran this retry for the compress loop, which owns the request body
// AND the response framing. The plugin pipe (plugin mode, and proxy-mode chat
// SSE that skipped compress injection) owns neither: it forwards the agent's
// own body and passes the upstream stream through byte-identically, so a turn
// that ends with nothing visible — the render-tag echo case, where the tag
// filter empties the only text block — reaches the host as an empty completed
// turn and the host aborts it. The pipe can still re-issue the SAME body
// (plus this nudge) because it holds the upstream URL and the forwarded
// headers, and it can splice the retry's content into the open client stream.
// Bounded by the configured degenerate budget (compress.degenerateRetry.
// maxAttempts, default 1 — pre-#7666 behavior); the body mutation never
// touches session state, so each nudge is neither persisted nor replayed on
// the client's next request.
// Wording covers BOTH retry shapes: the empty-turn shape (#732/#821) and the
// draft-tail shape (#2303, visible prose ending in a compression-draft closing
// tag) — both are "ended without a tool call", and both need the same push:
// issue the pending action or state the final answer explicitly.
export const DEGENERATE_RETRY_NUDGE =
    "[billion-context] Your previous response ended without a tool call. Continue now: take your next concrete action — issue the tool call you were about to make, or state your final answer explicitly.";

/** #7666: built-in nudge rotation when the user configured no `nudges` list.
 *  Attempt i sends the i-th sentence (cycling), so repeated attempts do not
 *  present the model with a byte-identical prompt. Each sentence keeps the
 *  same contract as DEGENERATE_RETRY_NUDGE: push the pending action or an
 *  explicit final answer. */
export const DEFAULT_DEGENERATE_RETRY_NUDGES: readonly string[] = [
    DEGENERATE_RETRY_NUDGE,
    "Please continue with the unfinished task.",
    "You stopped before acting. Finish now: issue the pending tool call, or state your final answer in one line.",
];

/** The retry body: the forwarded body with the continuation nudge appended as a
 *  trailing user turn. Null when the body cannot carry one. */
export function injectContinuationNudge(protocol: WireProtocol, body: string | Buffer, model?: string, nudge: string = DEGENERATE_RETRY_NUDGE): string | null {
    return appendTrailingUserText(protocol, body, nudge, model);
}

interface ContinuationRetryOpts {
    protocol: WireProtocol;
    /** The body that was forwarded upstream (the agent's own, in plugin mode). */
    body: string | Buffer;
    /** Exact request model: isolates a matching KeyRing model refusal (throttle scope),
     *  and is threaded into the continuation nudge so Claude-through-Google targets keep
     *  tool_result-first part order (#5390). */
    model?: string;
    upstreamUrl: string;
    reqHeaders: Record<string, string>;
    proxyUrl?: string;
    dispatcher?: object;
    signal: AbortSignal;
    log: (level: string, msg: string) => void;
    /** Log prefix, normally the session id. */
    label: string;
    /** #7666: nudge sentence list for multi-attempt turns — attempt i sends
     *  nudges[i] (cycling when shorter than the budget). Absent/empty = the
     *  built-in DEFAULT_DEGENERATE_RETRY_NUDGES rotation. The budget itself
     *  (how many attempts) is enforced by the pipe, not here. */
    nudges?: readonly string[];
    /** #1884: re-sign the retry body before it hits the wire (armed re-sign
     *  lane only; undefined on unsigned traffic). The retry body carries an
     *  injected continuation nudge, so the previous signature is stale. */
    resign?: (headers: Record<string, string>, body: string | Buffer) => void;
    /** #3280: v1internal egress re-wrap — `body` above is the INNER request
     *  (the nudge needs top-level contents), so the retry goes out enveloped. */
    wrapBody?: (body: string | Buffer) => string | Buffer;
}

async function readSmallThrottleErrorBody(response: Response): Promise<Uint8Array | undefined> {
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) {
                const body = new Uint8Array(bytes);
                let offset = 0;
                for (const chunk of chunks) {
                    body.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                return body;
            }
            bytes += result.value.byteLength;
            if (bytes > MAX_THROTTLE_ERROR_BODY_BYTES) {
                cancelThrottleErrorReader(reader);
                return undefined;
            }
            chunks.push(result.value);
        }
    } catch {
        return undefined;
    } finally {
        releaseThrottleErrorReader(reader);
    }
}
/** Build the re-request used when a turn ends with no visible output. Returns a
 *  function for the stream pipe: it yields the retry's response body, or null
 *  when the retry cannot be issued (unbuildable body, upstream error, client
 *  already gone) — the caller then passes the original empty turn through
 *  unchanged. */
export function makeContinuationRefetch(opts: ContinuationRetryOpts): (cont?: EchoedToolContinuation) => Promise<ReadableStream<Uint8Array> | null> {
    const nudges = opts.nudges && opts.nudges.length > 0 ? opts.nudges : DEFAULT_DEGENERATE_RETRY_NUDGES;
    // #7666: self-counted attempt index for nudge rotation. The pipe only ever
    // calls this within its configured budget, so the index can never run past
    // what the user allowed; the modulo keeps a short list cycling instead of
    // stalling on a missing sentence.
    let attempt = 0;
    return async (cont?: EchoedToolContinuation) => {
        if (opts.signal.aborted) return null;
        const kind = cont ? "echoed-tool continuation" : "degenerate-terminal retry";
        // A body whose final input item is a compaction trigger must never be
        // re-issued: appending the nudge/exchange after it breaks the wire shape
        // (#283: the trigger stays the last input item), and the trigger's
        // terminal is decided by the compaction flow, not by a terminal retry.
        // Parsed here, at retry time, so healthy turns pay nothing.
        if (opts.protocol === "responses") {
            try {
                const parsed = JSON.parse(typeof opts.body === "string" ? opts.body : opts.body.toString("utf8")) as Record<string, unknown>;
                if (hasCompactionTrigger(parsed["input"])) {
                    opts.log("warn", `[${opts.label}] [plugin] ${kind} skipped: request ends on a compaction trigger`);
                    return null;
                }
            } catch {
                /* unparseable body: the body builders below report and skip */
            }
        }
        let retryBody: string | null;
        if (cont) {
            retryBody = appendEchoedToolExchange(opts.protocol, opts.body, cont.assistantMessages, cont.toolResultMessages);
        } else {
            const attemptNudge = nudges[attempt % nudges.length];
            attempt += 1;
            retryBody = injectContinuationNudge(opts.protocol, opts.body, opts.model, attemptNudge);
        }
        if (retryBody === null) {
            opts.log("warn", `[${opts.label}] [plugin] ${kind} skipped: request body carries no turn array`);
            return null;
        }
        const wireRetryBody = opts.wrapBody ? opts.wrapBody(retryBody) : retryBody;
        const requestModel = opts.model ?? requestModelFromBody(retryBody);
        let probeToken: symbol | undefined;
        let classificationReservation: ThrottleClassificationReservation | undefined;
        let settleProvisional: ((modelScope?: string) => void) | undefined;
        try {
            classificationReservation = reserveUpstreamThrottleClassification(opts.upstreamUrl, opts.reqHeaders);
            if (classificationReservation === undefined) {
                opts.log("info", `[${opts.label}] [plugin] ${kind} skipped: throttle classification capacity is full`);
                return null;
            }
            opts.resign?.(opts.reqHeaders, wireRetryBody);
            // #4743: the retry is an egress send like any other. Its local
            // admission gate returns a token so only this send can release the
            // probe slots it claimed.
            const throttleGate = upstreamThrottleGate(
                opts.upstreamUrl,
                opts.reqHeaders,
                Date.now(),
                requestModel,
            );
            probeToken = throttleGate.probeToken;
            const throttleReject = throttleGate.reject;
            if (throttleReject !== undefined) {
                classificationReservation.release();
                classificationReservation = undefined;
                opts.log("info", `[${opts.label}] [plugin] ${kind} answered locally by the 429 hold (#4204) — passing the original turn through`);
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
                if (r.response.status === 429) {
                    const retryAfter = r.response.headers.get("retry-after");
                    const now = Date.now();
                    const settle = beginProvisionalUpstreamThrottle429(
                        opts.upstreamUrl,
                        opts.reqHeaders,
                        retryAfter,
                        now,
                        requestModel,
                        probeToken,
                        classificationReservation,
                    );
                    classificationReservation = undefined;
                    settleProvisional = settle;
                    // Keep the fetch watchdog and external-abort listener alive
                    // until this bounded reader completes. Its only local wait
                    // is the continuation callback's 250ms latency budget.
                    const bodyRead = readSmallThrottleErrorBody(r.response)
                        .then((errorBody) => {
                            const modelScope = throttle429ModelScope(r.response.status, requestModel, errorBody);
                            settle(modelScope);
                        })
                        .catch(() => {
                            settle();
                        })
                        .finally(() => {
                            r.clearTimer();
                        })
                        .catch(() => undefined);
                    let initialTimer: ReturnType<typeof setTimeout> | undefined;
                    const firstDeadline = new Promise<{ kind: "timeout" }>((resolve) => {
                        initialTimer = setTimeout(() => resolve({ kind: "timeout" }), MAX_THROTTLE_ERROR_READ_MS);
                    });
                    await Promise.race([
                        bodyRead.then(() => ({ kind: "body" as const })),
                        firstDeadline,
                    ]).finally(() => clearTimeout(initialTimer));
                } else {
                    noteUpstreamThrottleResolved(opts.upstreamUrl, opts.reqHeaders, r.response.status, Date.now(), requestModel, probeToken);
                    classificationReservation.release();
                    classificationReservation = undefined;
                    r.clearTimer();
                    // A discarded body has no consumer; do not wait for a tee sibling to cancel.
                    void r.response.body?.cancel().catch(() => undefined);
                }
                opts.log("warn", `[${opts.label}] [plugin] ${kind} rejected (HTTP ${r.response.status}); passing the original turn through`);
                return null;
            }
            noteUpstreamThrottleResolved(opts.upstreamUrl, opts.reqHeaders, r.response.status, Date.now(), requestModel, probeToken);
            classificationReservation.release();
            classificationReservation = undefined;
            const body = r.response.body as ReadableStream<Uint8Array>;
            // The retry stream is spliced into a response the caller already
            // owns, so its own idle timer is dropped — a stalled retry then ends
            // with the client abort instead of an upstream watchdog (the
            // streamed re-request in reasoning-guard.ts does the same).
            r.stopIdleTimer();
            return body;
        } catch (e) {
            settleProvisional?.();
            classificationReservation?.release();
            releaseUpstreamThrottleProbe(probeToken);
            opts.log("warn", `[${opts.label}] [plugin] ${kind} failed (${e instanceof Error ? e.message : String(e)}); passing the original turn through`);
            return null;
        }
    };
}
