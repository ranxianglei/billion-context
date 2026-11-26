import { fetchWithTimeout } from "./fetch-util.js";
import { beginProvisionalUpstreamThrottle429, noteUpstreamThrottleResolved, releaseUpstreamThrottleProbe, requestModelFromBody, reserveUpstreamThrottleClassification, throttle429ModelScope, upstreamThrottleGate, type ThrottleClassificationReservation } from "./upstream-throttle.js";
import { hasCompactionTrigger } from "./codex-compact.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import type { WireProtocol } from "./util.js";
import { appendTrailingUserText } from "./wire-body.js";
import { loadConfigFile } from "./config.js";

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
// tag) — both are "ended without a tool call". #7235: the old "take your next
// concrete action" pushed the model to FABRICATE an action for a turn that
// legitimately needs none (a teammate message, an already-reported
// notification); the new wording lets an intentional no-op stay silent while
// still nudging a genuine stall to issue its pending action or answer.
export const DEGENERATE_RETRY_NUDGE =
    "[billion-context] Your previous response ended without a tool call. If you intended to call a tool or give an answer, do so now; if no response is needed, output nothing.";

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

/** The continuation refetch handed to the stream pipes. Callable as a plain
 *  re-issue function (the retry's response body, or null when the retry cannot
 *  be issued), and carrying a LAZY background-event probe (#7235) the pipe's
 *  empty-turn retry checks BEFORE nudging. The probe is a property of the
 *  closure (not inside the refetch body) so the zero-byte-cut and
 *  reasoning-only-cut retries that share the refetch keep working unchanged. */
export interface ContinuationRefetch {
    (): Promise<ReadableStream<Uint8Array> | null>;
    /** True when the forwarded request's last user message is a pure
     *  background event — the empty turn is the correct answer and must not be
     *  nudged (#7235). Optional so test mocks that only supply the callable
     *  half keep working; the pipe treats a missing probe as "not a background
     *  event". */
    isBackgroundEvent?(): boolean;
    /** Classify the forwarded request's last user message for the
     *  degenerate-nudge observability log (#7235): "background-event" /
     *  "non-text" / "human". Optional for the same reason. */
    lastUserMessageCategory?(): string;
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
export function makeContinuationRefetch(opts: ContinuationRetryOpts): ContinuationRefetch {
    const nudges = opts.nudges && opts.nudges.length > 0 ? opts.nudges : DEFAULT_DEGENERATE_RETRY_NUDGES;
    // #7666: self-counted attempt index for nudge rotation. The pipe only ever
    // calls this within its configured budget, so the index can never run past
    // what the user allowed; the modulo keeps a short list cycling instead of
    // stalling on a missing sentence.
    let attempt = 0;
    const refetch = async (): Promise<ReadableStream<Uint8Array> | null> => {
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
        const attemptNudge = nudges[attempt % nudges.length];
        attempt += 1;
        const retryBody = injectContinuationNudge(opts.protocol, opts.body, opts.model, attemptNudge);
        if (retryBody === null) {
            opts.log("warn", `[${opts.label}] [plugin] degenerate-terminal retry skipped: request body carries no turn array`);
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
                opts.log("info", `[${opts.label}] [plugin] degenerate-terminal retry skipped: throttle classification capacity is full`);
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
                opts.log("warn", `[${opts.label}] [plugin] degenerate-terminal retry rejected (HTTP ${r.response.status}); passing the empty turn through`);
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
            opts.log("warn", `[${opts.label}] [plugin] degenerate-terminal retry failed (${e instanceof Error ? e.message : String(e)}); passing the empty turn through`);
            return null;
        }
    };
    // #7235: the lazy background-event probe. Computed on demand (the pipe's
    // empty-turn retry asks before nudging); it reads the forwarded body's last
    // user message, never the retry body.
    refetch.isBackgroundEvent = (): boolean => isBackgroundEventRequest(opts.protocol, opts.body, resolveExemptEnvelopes());
    refetch.lastUserMessageCategory = (): string => lastUserMessageCategory(opts.protocol, opts.body, resolveExemptEnvelopes());
    return refetch;
}

// #7235: background-event exemption for the degenerate-terminal retry. A turn
// whose LAST outgoing user message is a pure background event (a
// task-notification / system-reminder with nothing else) is an intentional
// no-op: the model's empty end_turn is the correct answer. Nudging it turns the
// no-op into boilerplate text, unrequested tool calls, or (on the chat path) an
// in-band stream error written into the persisted session record. The probe
// checks the OUTGOING request body's last user message (NOT
// lastUserSummaryInstruction, which walks back past tool_result to an EARLIER
// message and cannot say what THIS turn is answering).

/** The default envelopes that mark a background-event message. Harness tags
 *  differ across clients, so the list is configurable via
 *  `degenerateRetry.exemptEnvelopes` in the config file. */
export const DEFAULT_EXEMPT_ENVELOPES: readonly string[] = ["task-notification", "system-reminder"];

// The Claude Code harness appends a tail line after a notification block telling
// the model when to act. It is not part of the notification content, so the
// probe strips it before checking for emptiness.
const HARNESS_TAIL_RE = /(?:^|\n)\s*If this event is something the user would act on now[^\n]*/g;

// bili's own render tags (KDD #2): <acp tokens="N" type="text">mNNNNN</acp>.
// Hex-escaped per the source-file rule.
const ACP_TAG_RE = /\x3cacp\b[^\x3e]*\x3e[\s\S]*?\x3c\/acp\x3e/g;

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip the background-event envelopes, bili render tags, and the harness
 *  tail line from `text`. Returns the residual content. */
function stripBackgroundEventContent(text: string, envelopes: readonly string[]): string {
    let residual = text.replace(ACP_TAG_RE, "");
    for (const envelope of envelopes) {
        if (!envelope) continue;
        const re = new RegExp(`<${escapeRegExp(envelope)}>[\\s\\S]*?<\\/${escapeRegExp(envelope)}>`, "g");
        residual = residual.replace(re, "");
    }
    return residual.replace(HARNESS_TAIL_RE, "");
}

/** True when `text` is a pure background-event message: it contains at least
 *  one configured envelope, and after stripping envelopes + render tags + the
 *  harness tail line, nothing remains. Whole-message match — "notif + human
 *  question" leaves a residual and is NOT exempted. */
export function isBackgroundEventText(text: string, envelopes: readonly string[]): boolean {
    let hasEnvelope = false;
    for (const envelope of envelopes) {
        if (envelope && text.includes(`<${envelope}>`)) {
            hasEnvelope = true;
            break;
        }
    }
    if (!hasEnvelope) return false;
    return stripBackgroundEventContent(text, envelopes).trim() === "";
}

/** Extract the last user message's text from a PARSED request body. Returns
 *  undefined when the last message is not a pure-text user message (it is a
 *  tool_result / image / file / function-output tail, an assistant message, or
 *  a trailing system run) — those are never background events. */
export function lastUserTextFromParsed(protocol: WireProtocol, obj: Record<string, unknown>): string | undefined {
    if (protocol === "responses") {
        const input = obj.input;
        if (typeof input === "string") return input;
        if (!Array.isArray(input)) return undefined;
        const arr = input as Record<string, unknown>[];
        const last = arr[arr.length - 1];
        if (!last || typeof last !== "object" || last.role !== "user") return undefined;
        const c = last.content;
        if (typeof c === "string") return c;
        if (!Array.isArray(c)) return undefined;
        let text = "";
        for (const part of c as Record<string, unknown>[]) {
            if (!part || typeof part !== "object" || part.type !== "input_text" || typeof part.text !== "string") return undefined;
            text += part.text;
        }
        return text;
    }
    if (protocol === "google") {
        const contents = obj.contents;
        if (!Array.isArray(contents)) return undefined;
        const arr = contents as Record<string, unknown>[];
        const last = arr[arr.length - 1];
        if (!last || typeof last !== "object" || last.role !== "user" || !Array.isArray(last.parts)) return undefined;
        let text = "";
        for (const part of last.parts as Record<string, unknown>[]) {
            if (!part || typeof part !== "object" || typeof part.text !== "string") return undefined;
            text += part.text;
        }
        return text;
    }
    // anthropic / openai (messages array)
    const messages = obj.messages;
    if (!Array.isArray(messages)) return undefined;
    const arr = messages as Record<string, unknown>[];
    const last = arr[arr.length - 1];
    if (!last || typeof last !== "object" || last.role !== "user") return undefined;
    const c = last.content;
    if (typeof c === "string") return c;
    if (!Array.isArray(c)) return undefined;
    let text = "";
    for (const part of c as Record<string, unknown>[]) {
        if (!part || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string") return undefined;
        text += part.text;
    }
    return text;
}

/** True when the OUTGOING request body's last user message is a pure
 *  background event (see isBackgroundEventText). The probe the three degenerate
 *  retry paths check before nudging (#7235). */
export function isBackgroundEventRequest(protocol: WireProtocol, body: string | Buffer, envelopes: readonly string[]): boolean {
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(typeof body === "string" ? body : body.toString("utf8")) as Record<string, unknown>;
    } catch {
        return false;
    }
    return isBackgroundEventRequestFromParsed(protocol, obj, envelopes);
}

/** Parsed twin of isBackgroundEventRequest for callers that already hold the
 *  parsed body (the acp-loop path). */
export function isBackgroundEventRequestFromParsed(protocol: WireProtocol, obj: Record<string, unknown>, envelopes: readonly string[]): boolean {
    const text = lastUserTextFromParsed(protocol, obj);
    if (text === undefined) return false;
    return isBackgroundEventText(text, envelopes);
}

/** Resolve the exempt-envelope list from the config file
 *  (`degenerateRetry.exemptEnvelopes`), falling back to the default. The list
 *  is read per-probe (degenerate turns are rare; loadConfigFile is cached). */
export function resolveExemptEnvelopes(): string[] {
    const file = loadConfigFile().degenerateRetry?.exemptEnvelopes;
    if (Array.isArray(file) && file.length > 0) {
        const clean = file.filter((s): s is string => typeof s === "string" && s !== "");
        if (clean.length > 0) return clean;
    }
    return [...DEFAULT_EXEMPT_ENVELOPES];
}

/** Classify the last user message in the outgoing request body for the
 *  degenerate-nudge observability log (#7235). Returns one of:
 *  "background-event" (a pure notification / system-reminder), "non-text" (the
 *  last message is not a pure-text user message — tool_result / image /
 *  function output / assistant / trailing system run), or "human" (a plain
 *  text user message). */
export function lastUserMessageCategory(protocol: WireProtocol, body: string | Buffer, envelopes: readonly string[]): string {
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(typeof body === "string" ? body : body.toString("utf8")) as Record<string, unknown>;
    } catch {
        return "other";
    }
    return lastUserMessageCategoryFromParsed(protocol, obj, envelopes);
}

/** Parsed twin of lastUserMessageCategory for callers that already hold the
 *  parsed body (the acp-loop path). */
export function lastUserMessageCategoryFromParsed(protocol: WireProtocol, obj: Record<string, unknown>, envelopes: readonly string[]): string {
    if (isBackgroundEventRequestFromParsed(protocol, obj, envelopes)) return "background-event";
    if (lastUserTextFromParsed(protocol, obj) === undefined) return "non-text";
    return "human";
}
