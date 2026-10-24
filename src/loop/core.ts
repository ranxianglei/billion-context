import {
    hideConsumedCompressCalls,
    type CompressionCore,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import { estimateCoreMessages } from "../preflight.js";
import { estimateWireOverhead } from "../server/budget.js";
import { handleAcpStatus } from "../acp-status.js";
import { STATUS_REPORT_CLOSE, STATUS_REPORT_OPEN } from "../acp-panel.js";
import { credentialFingerprint, generationParamFp, handleAcpCache, lastForwardedBody, noteForwardedBody, noteForwardedImageFacts, settleUsageReport } from "../cache-ledger.js";
import { maybeJudgeContinuity } from "../invariant-judge.js";
import { countImagesInRawBody } from "../image-tokens.js";
import { diagnoseSuccessWithoutUsage, lastCompressSuffix, withSessionLock, type Session } from "../session.js";
import type { BiliMessage } from "acp-kernel/wire";
import { coreToAnthropic } from "acp-kernel/wire";
import {
    parseCompressInput,
    ABSORB_TOOL_NAME,
    COMPRESS_TOOL_NAME,
    READ_ORIGINAL_IMAGE_TOOL_NAME,
    RULE_TOOL_NAME,
} from "../compress-tool.js";
import { effectiveAbsorbConfig, executeAbsorb, isProxyToolFor } from "../absorb.js";
import { effectiveRulesEnabled, executeRule } from "../rules-feature.js";
import { ccrEnabled, drainPendingRetrievals, executeRetrieve, imageRescaleToolArmed, retrieveToolName } from "../store.js";
import { applyImageRescalePass, executeReadOriginalImage } from "../image-rescale.js";
import { recordThreadTail } from "../server/thread-tracking.js";
import { applyRanges } from "../stream.js";
import { applyConfiguredCompression } from "../external-summary-compress.js";
import { executeSearchContextTarget, resolveDecompress } from "../decompress-shared.js";
import { toolFail, type ProxyToolResult } from "../proxy-tool-result.js";
import { fetchWithRetry, UpstreamHttpError } from "../fetch-util.js";
import { classifyUpstreamFailure, type SkippedProxyInfo, type UpstreamFailureKind } from "../upstream-fail.js";
import { formatUpstreamError, proxyDispatcher } from "../upstream-proxy.js";
import { warnCacheCollapse } from "../cache-warn.js";
import { dumpRejectedBody } from "../error-dump.js";
import { shedEgressIfOverBudget } from "../egress-shed.js";
import { DUMP_PLAINTEXT_BANNER } from "../dump-banner.js";
import { bodyDumpEnabled as knobBodyDumpEnabled, imageRescaleMaxDim, renderNone as knobRenderNone } from "../knobs.js";
import { dumpsDir } from "../paths.js";
import { isStrictReasoningEcho, modelIdOf, normalizeStrictEchoBody } from "../strict-echo.js";
import { log as loggerLog } from "../logger.js";
import { promptInputTotal, type WireProtocol } from "../util.js";
import { DEGENERATE_RETRY_NUDGE } from "../degenerate-retry.js";
import { endsWithDraftClose, lastUserSummaryInstruction, requestExpectsProseSummary } from "../degenerate-turn.js";
import { safePrefix, safeSuffix, scrubLoneSurrogatesOnWire } from "../text-safe.js";

export const MAX_LOOP_ROUNDS = 10;

export function buildVisibilityMarker(toolName: string, result: string): string {
    const lines = result.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const failed = lines.some((l) =>
        l.includes("FAILED")
        || l.includes("not found")
        || l.includes("is required")
    );
    const icons: Record<string, string> = {
        compress: "📦",
        decompress: "📤",
        search_context: "🔍",
        acp_status: "📊",
        absorb: "🫧",
    };
    const icon = failed ? "❌" : (icons[toolName] ?? "📦");

    if (toolName === "acp_status") {
        // #2789: the status report is multi-line BY DESIGN — wrap the body in
        // the sentinel pair so replayed-history strips remove the WHOLE unit
        // (a line-granular strip left the 10–40 line report orphaned).
        return `\n${icon} [ACP] acp_status result:\n${STATUS_REPORT_OPEN}\n${result.trim()}\n${STATUS_REPORT_CLOSE}\n`;
    }

    const inner = (lines[0] ?? "").replace(/^\[/, "").replace(/\]$/, "").trim();
    return `\n${icon} [ACP] ${inner}\n`;
}

// #3302 (Ask 6): accumulate endpoint values from failed compress receipts and
// report the first endpoint that saw ≥2 distinct values — the probe-family
// signature. Pure so it is unit-testable without driving a full loop.
export function recordProbeFailures(
    probes: Map<string, Set<string>>,
    results: ReadonlyArray<{ name: string; result: string }>,
): { label: string; values: string[] } | null {
    for (const pr of results) {
        if (pr.name !== "compress") continue;
        for (const m of pr.result.matchAll(/(startId|endId)="(m\d+)"/g)) {
            const values = probes.get(m[1]) ?? new Set<string>();
            values.add(m[2]);
            probes.set(m[1], values);
        }
    }
    const probing = [...probes.entries()].find(([, values]) => values.size >= 2);
    return probing ? { label: probing[0], values: [...probing[1]] } : null;
}

// #413 follow-up: when the stream dies AFTER visible text has already been
// forwarded (final-report shape — heavy reasoning, then the answer starts,
// then the relay cuts), a blind re-fetch would make the client watch the
// answer regrow from scratch on top of the partial one. Instead, re-fetch
// once with a continuation nudge that quotes the forwarded tail and asks the
// model to pick up exactly where the text ended; the retry's output appends
// seamlessly to what the client already has. Ephemeral like #732: never
// committed to coreMessages/session state.
const TRUNCATION_CONTINUATION_TAIL_CHARS = 800;
const truncationContinuationNudge = (tail: string): string =>
    `[billion-context] Your previous response was cut off mid-transmission by a network failure before the stream could complete. The client already received the response up to and including this text:\n\n---\n${tail}\n---\n\nContinue the response seamlessly from exactly where that text ends (mid-sentence if necessary). Do not repeat any part of the received text and do not start over — just pick up where it stopped and finish the response.`;

function isLoopThinking(m: CoreMessage): boolean {
    return m.contentType === "reasoning" && typeof m.id === "string" && m.id.startsWith("acp_loop_");
}

function stripLoopThinking(messages: CoreMessage[]): CoreMessage[] {
    return messages.filter((m) => !isLoopThinking(m));
}

// #2501: evidence that this upstream SIGNS thinking blocks — the client's
// replayed request carries signed thinking in an assistant message (clients of
// a signing upstream persist every signed block and replay it verbatim; that
// replay is exactly what turns a missing signature into a 400). Scans the RAW
// client body, not ctx.messages: folded/compressed views may have dropped the
// old assistant turns long before the incident window, while the client always
// re-sends its full persisted history.
function bodyHasSignedThinking(body: Record<string, unknown>): boolean {
    const messages = body.messages;
    if (!Array.isArray(messages)) return false;
    for (const m of messages) {
        if (!m || typeof m !== "object" || (m as Record<string, unknown>).role !== "assistant") continue;
        const content = (m as Record<string, unknown>).content;
        if (!Array.isArray(content)) continue;
        for (const item of content) {
            if (!item || typeof item !== "object" || (item as Record<string, unknown>).type !== "thinking") continue;
            const sig = (item as Record<string, unknown>).signature;
            if (typeof sig === "string" && sig.length > 0) return true;
        }
    }
    return false;
}

// #1960: Anthropic's "cannot be modified" 400 means the latest assistant
// message we sent differs from its own original response in a thinking-family
// block. The degraded strip-retry cannot undo that — the message is still
// rewritten (e.g. a redacted_thinking block lost in rebuild), so the retry
// guarantees a second 400 plus a swapped error. Propagate the original error
// immediately; the NEXT client request carries the client's own faithful
// history, which is what recovers the session.
function isThinkingModifiedError(e: unknown): boolean {
    return e instanceof UpstreamHttpError && /cannot be modified/i.test(e.body);
}

// #1453 client-facing labels for transport failures that end the turn in-band.
// Deliberately kind-level only: raw error text can embed endpoint hostnames/IPs,
// which must never reach the client stream (the full masked chain goes to the
// server log via formatUpstreamError instead).
const TRANSPORT_FAILURE_LABELS: Record<UpstreamFailureKind, string> = {
    "client-abort": "aborted",
    "upstream-timeout": "upstream timeout",
    "proxy-reset": "connection reset by an intermediate proxy",
    "upstream-reset": "connection reset by the upstream",
    "connect-refused": "connection refused",
    "connect-timeout": "connect timed out",
    dns: "name resolution failed",
    tls: "TLS handshake failure",
    unknown: "network error",
};

function activeAbsorbToolName(session: Session, config: Config): string | undefined {
    const a = effectiveAbsorbConfig(session, config);
    return a?.enabled === true ? a.toolName ?? ABSORB_TOOL_NAME : undefined;
}

// #3661: the re-request below replays proxy-tool arguments into assistant.tool_calls;
// strict chat-template gateways crash server-side rendering of non-JSON arguments and
// 400 the whole continuation request, so the round dies before the model ever sees the
// rejection receipt — which also strands every recovery mechanism (#2146 breaker, nudge
// gating) behind a dead round until the session deadlocks. Unparseable args replay this
// valid-JSON placeholder instead; the raw bytes stay in `arguments` for #156 repeat
// detection and the log above.
const MALFORMED_PROXY_TOOL_ARGS_REPLAY = '{"_bili":"model produced non-JSON tool-call arguments; replaced with this valid placeholder so the continuation request stays parseable — see the tool result"}';

export interface LoopCtx {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    /** View handed to applyCompression (see RewriteCtx.compressMessages). */
    compressMessages?: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
    proxyUrl?: string;
    /** #2809: diagnostic-only — the proxy the auto chain would have picked
     *  while default-direct mode ran this session's upstream directly. Names
     *  itself in re-request transport-failure logs like the outer forward does. */
    skippedProxy?: SkippedProxyInfo;
    /** #1536: origin (scheme://host) of the LLM endpoint this loop forwards to
     *  — part of the cache-invalidation target identity (rotating relays busts
     *  the prefix even for the same model+wire). Distinct from proxyUrl, which
     *  is the routing CONNECT-proxy, not the target. */
    upstreamOrigin?: string;
    textProtocol?: boolean;
    debug?: boolean;
    /** #422: host hook that re-runs the kernel fold (processTurn) on the
     *  original messages with the CURRENT session state, re-attaching this
     *  loop's round records. Called after a successful compress so the
     *  re-request reflects the compression the model just performed instead
     *  of the pre-compress view (stale view = model sees zero effect + a
     *  finished deliverable → wraps up and stops). */
     refreshFolded?: (current: CoreMessage[]) => CoreMessage[] | Promise<CoreMessage[]>;
    // Which wire protocol produced the usage the loop records. Needed to
    // compute the true context total correctly (Anthropic reports
    // input_tokens as NEW-only; OpenAI/Responses report the TOTAL).
    protocol?: WireProtocol;
    /** #862: when `false`, suppress the 📦/❌ ACP visibility markers emitted
     *  after proxy tool executions — both the marker line streamed to the
     *  client (`emitMarker`) and the orphan marker message re-injected into
     *  rebuilt history. Default (undefined) keeps markers on. Paired
     *  tool-call/tool-result messages are unaffected. */
    visibilityMarkers?: boolean;
    /** #1455: tee loop-originated upstream responses (re-request and every
     *  retry fetch) to raw SSE files — the outer request's ACP_DUMP_SSE tee
     *  only covers the FIRST response, so an internal re-request that dies
     *  silently left zero bytes on disk to diagnose. Name is decided here;
     *  the callback must be best-effort (never throw into the stream path). */
    dumpSse?: (name: string, stream: ReadableStream<Uint8Array>) => void;
    /** #1843 L1: route identity for image-cost learning, resolved by the host
     *  at loop setup (the loop has no access to the provider route table):
     *  host = upstream hostname, fp = `${billing}:${cap}` fingerprint. When
     *  present, each sent round captures its image facts alongside the body. */
    imageLearn?: { host: string; fp: string };
    /** #4397: the per-request render-tag strategy that produced this loop's outbound
     *  bodies (the global knob can diverge — compaction-trigger requests force "none").
     *  Stamps noteForwardedBody's rt flag; undefined falls back to the knob. */
    renderTags?: "text-only" | "none";
}

export interface RequestOptions {
    url: string;
    headers: Record<string, string>;
    /** Final-stage wire transform (e.g. compat.roles role rewrite, #552).
     *  Applied to every outgoing body this loop re-sends — truncation retry,
     *  degraded retry, rebuilt rounds — so re-sent bodies carry the same
     *  compat the initial forward() applied. Returns the body to serialize. */
    wireTransform?: (body: Record<string, unknown>) => Record<string, unknown>;
    /** #3280: ingress counterpart of wireTransform — applied to every
     *  loop-originated response stream at the single adoption point
     *  (adoptUpstream) so round-2+ consumers parse the STANDARD wire shape
     *  even though egress went out dialect-wrapped (the v1internal envelope
     *  nests candidates under .response). undefined for non-dialect traffic. */
    responseStreamTransform?: (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
    /** #1884: re-sign every re-sent body before it hits the wire (armed
     *  re-sign lane only; undefined on unsigned traffic). Each round rebuilds
     *  the body, so a signature computed for an earlier round is stale. */
    resign?: (headers: Record<string, string>, body: string | Buffer) => void;
}

// #1960: one round's assistant message parts, in STREAM order. The rebuilt
// latest assistant message must match the upstream response byte-for-byte
// (Anthropic verifies thinking-family blocks verbatim), so reasoning
// segments, text runs and redacted_thinking blocks are recorded as they
// arrive instead of being re-laid out as [reasoning…, text, tool…].
type RoundPart =
    | { kind: "reasoning"; text: string; signature: string }
    | { kind: "text"; text: string }
    | { kind: "redacted"; data: string }
    // #3158: a Gemini part whose only payload is a thoughtSignature (no text,
    // no functionCall). Recorded in stream order so a proxy-tool rebuild puts
    // it back on the re-request at its position.
    | { kind: "standalone_signature"; signature: string };

export type ParsedStreamEvent =
    | { kind: "text"; delta: string; raw?: Buffer }
    | { kind: "reasoning"; delta: string; raw?: Buffer; signature?: string; blockEnd?: boolean }
    // #1960: Anthropic redacted_thinking arrives whole in content_block_start
    // (opaque base64 `data`). The loop must rebuild it byte-exact in position
    // on re-request — Anthropic rejects modified thinking-family blocks — so
    // it is its own event instead of riding the (empty) reasoning seal.
    | { kind: "redacted_thinking"; data: string }
    // #3158: a Gemini part carrying ONLY a thoughtSignature (no text, no
    // functionCall). The adapter forwards it to the client itself; the loop
    // records it so a proxy-tool rebuild carries it back on the re-request —
    // dropped there, the rebuilt history loses the signature association.
    | { kind: "standalone_signature"; signature: string }
    | { kind: "tool_call"; name: string; callId: string; arguments: string; passthrough?: boolean; signature?: string }
    // #4072: cacheCreation carries the upstream's cache_creation breakdown
    // object (e.g. { ephemeral_5m_input_tokens }) verbatim — Anthropic puts it
    // in message_start, which the anthropic adapter forwards usage-neutral
    // (#1315), so only the synthetic terminal can deliver it to hosts that
    // derive their prompt-cache TTL from the breakdown.
    | { kind: "usage"; inputTokens?: number; outputTokens?: number; cachedTokens?: number; creationTokens?: number; declaredInclusive?: boolean; cacheCreation?: Record<string, unknown> }
    // #1766: keys on the upstream terminal frame that bili does not model
    // (e.g. Anthropic's safeguard_results) — the loop replaces that frame with
    // a synthetic completion, so anything not carried here vanishes from the
    // client's view.
    | { kind: "done"; finishReason?: string; suppressCompletion?: boolean; truncated?: boolean; thinking?: boolean; terminalExtra?: Record<string, unknown> }
    | { kind: "error"; message: string }
| { kind: "diag"; level: "info" | "warn"; message: string }
    // #1455: stateless marks an inert keep-alive frame (anthropic ping) whose
    // forwarding creates no client-side stream state — a re-fetched response
    // may emit it again with no client-visible effect, so it must not bar the
    // #413 blind re-fetch (a ping-only truncated round was otherwise locked
    // out of the retry by "any forwarded byte").
    // #2501: thinkingStart marks the release of a held anthropic thinking
    // content_block_start — from this moment the block exists in the CLIENT'S
    // stream until its signature_delta arrives, so a truncation before the
    // signature bars every re-fetch on a signing upstream (see the gates).
    | { kind: "meta"; chunk: Buffer; firstRoundOnly?: boolean; stateless?: boolean; thinkingStart?: boolean };

export interface EmitCompletionOpts {
    finishReason?: string;
    usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; creationTokens?: number; declaredInclusive?: boolean; cacheCreation?: Record<string, unknown> };
    terminalExtra?: Record<string, unknown>;
}

export interface ToolCallEmit {
    name: string;
    callId: string;
    arguments: string;
    passthrough?: boolean;
    /** Protocol signature for the call part (Gemini thoughtSignature). A
     *  reconstructed functionCall replayed without it is rejected by Gemini 3,
     *  so it rides the call through to the re-request and to emitToolCall. */
    signature?: string;
}

export interface ExtractedTextTriggers {
    clean: string;
    calls: ToolCallEmit[];
}

export interface CompressLoopAdapter {
    buildRequest(
        coreMessages: CoreMessage[],
        systemPrompt: string,
        requestBody: Record<string, unknown>,
    ): Record<string, unknown>;
    parseStream(upstream: ReadableStream<Uint8Array>, round: number): AsyncGenerator<ParsedStreamEvent>;
    emitText(delta: string): Buffer;
    emitReasoning?(delta: string): Buffer;
    emitToolCall(call: ToolCallEmit): Buffer;
    emitMarker(toolName: string, result: string): Buffer;
    emitCompletion(opts?: EmitCompletionOpts): Buffer;
    emitError(message: string): Buffer;
    extractTextTriggers?(text: string): ExtractedTextTriggers;
    // #2701 (anthropic Threads only): the id of the LATEST upstream response
    // observed on the wire — the thread tail a re-request must continue from.
    // Undefined when the protocol has no server-side thread tail.
    threadTailId?(): string | undefined;
    // #2701: every response id observed this turn, in order (round 1's id
    // first, then one per internal round). The relay persists them so an
    // inbound continue targeting an id the proxy itself consumed can be
    // rewritten to the current tail.
    threadResponseIds?(): string[];
}

export async function executeProxyToolAsync(
    toolName: string, args: Record<string, unknown>, ctx: LoopCtx,
    callId?: string, rawArguments?: string, signal?: AbortSignal,
): Promise<ProxyToolResult> {
    // #3400: async because it reads the spilled original from disk. The result
    // carries the image bytes; the loop attaches them as an ephemeral carrier
    // message (see proxyResults below).
    if (toolName === READ_ORIGINAL_IMAGE_TOOL_NAME) return executeReadOriginalImage(args, ctx.session, (lvl, msg) => ctx.log(`[${lvl}] ${msg}`));
    if (toolName !== "compress") return executeProxyTool(toolName, args, ctx, callId, rawArguments);
    const input = typeof rawArguments === "string" && rawArguments.length > 0 ? rawArguments : args;
    return applyConfiguredCompression(input, ctx, callId, signal);
}

export function executeProxyTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: LoopCtx,
    callId?: string,
    rawArguments?: string,
): ProxyToolResult {
    if (toolName === "compress") {
        // #1502: on strict-JSON.parse failure the caller passes the raw argument
        // string here — the kernel's lenient parser salvages fence/trailing-
        // comma/single-quote/truncated inputs that the degraded {} would drop.
        const input = typeof rawArguments === "string" && rawArguments.length > 0 ? rawArguments : args;
        return applyRanges(parseCompressInput(input, callId), ctx);
    }
    if (toolName === "decompress") {
        return resolveDecompress(args, ctx);
    }
    if (toolName === "search_context") {
        return executeSearchContextTarget(args, ctx.core, ctx.session.id, ctx.session.state, ctx);
    }
    if (toolName === "acp_status") {
        return handleAcpStatus(args, ctx);
    }
    if (toolName === "acp_cache") {
        return handleAcpCache(ctx.session, args);
    }
    const absorb = effectiveAbsorbConfig(ctx.session, ctx.config);
    if (absorb?.enabled === true && toolName === (absorb.toolName ?? ABSORB_TOOL_NAME)) {
        return executeAbsorb(args, callId, absorb, ctx);
    }
    if (effectiveRulesEnabled(ctx.session, ctx.config) && toolName === RULE_TOOL_NAME) {
        return executeRule(args, ctx);
    }
    if (ccrEnabled(ctx.session) && toolName === retrieveToolName(ctx.session)) {
        return executeRetrieve(args, ctx.session);
    }
    return toolFail(`[Unknown proxy tool: ${toolName}]`);
}

function recordUsage(
    ctx: LoopCtx,
    usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; creationTokens?: number; declaredInclusive?: boolean },
    round: number,
): void {
    const prompt = usage.inputTokens;
    const cached = usage.cachedTokens;
    const out = usage.outputTokens;
    // #1536: normalize undefined (provider reports no cache tokens) to null so
    // the ledger quarantines the sample instead of booking its whole billed
    // prefix as an unexplained ttlRepay residual (which reads as a 0% hit rate).
    const reportedCached: number | null = typeof cached === "number" ? cached : null;
    // #4128: thread the upstream's billing_usage declaration so the anthropic
    // lane does not double-count an inclusive relay's input_tokens.
    const total = promptInputTotal(ctx.protocol, prompt, cached, usage.creationTokens, usage.declaredInclusive);
    if (typeof out === "number") ctx.session.stats.outputTokens += out;
    const hitPct =
        reportedCached !== null && total > 0 ? Math.round((reportedCached / total) * 100) : 0;
    if (reportedCached !== null) warnCacheCollapse(ctx.session, total, reportedCached);
    const foldNew = ctx.session.stats.pendingFoldUsage === true;
    if (foldNew) ctx.session.stats.pendingFoldUsage = false;
    ctx.log(
        `[acp-usage] round ${round} input=${total} ${reportedCached !== null ? `cached=${reportedCached} (cache hit ${hitPct}%)` : "(no cache report)"}${foldNew ? " fold=new" : ""}${total <= 0 ? " (zero-total: lastInputTokens kept)" : ""}`,
    );
    if (total > 0 || reportedCached !== null) {
        settleUsageReport(ctx.session, { total, reportedCached, output: out, protocol: ctx.protocol, upstream: ctx.upstreamOrigin });
    }
}

export async function* runCompressLoop(
    upstream: ReadableStream<Uint8Array>,
    ctx: LoopCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
    adapter: CompressLoopAdapter,
    systemPrompt: string,
    signal?: AbortSignal,
): AsyncGenerator<Buffer> {
    let activeClearTimer: (() => void) | null = null;
    let currentUpstream = upstream;
    let roundBody: Record<string, unknown> = requestBody;
    const coreMessages: CoreMessage[] = [...ctx.messages];
    let degradedRetried = false;
    let truncationRetried = false;
    // Independent one-shot for the visible-text continuation retry (#413
    // follow-up): the two retry shapes must not share a budget — a visible
    // cut that continues and then cuts again invisibly still needs the blind
    // re-fetch available, because the second attempt added nothing the
    // client can see.
    let continuationRetried = false;
    let degenerateRetried = false;
    // #1029: a retry storm re-executes the same failing proxy call every round;
    // re-streaming the identical status marker each time only accumulates noise
    // in client-stored history (incoming-history stripping removes it next turn,
    // but one copy per request is enough signal for humans).
    const seenMarkers = new Set<string>();

    const fetchUpstream = async (body: Record<string, unknown>) => {
        // #1592-family seam forensics: remember the body actually sent so the
        // next usage settle can pair it with the previous one (LCP on miss).
        // #2131: also hand over the exact message count — bodies above the
        // forensics cap are stored clipped and parse to zero messages.
        const wireObj = requestOptions.wireTransform ? requestOptions.wireTransform(body) : body;
        // #816 family: a lone surrogate anywhere in the body (model-authored
        // text, pre-#816 persisted state) serializes as an unpaired \uXXXX
        // escape and strict upstreams reject the WHOLE body (non-retryable
        // 400). Scrub once at the single loop send chokepoint; the same string
        // then feeds resign and forensics so all three views agree (this also
        // de-duplicates the previous double JSON.stringify of the same body).
        let wireBodyStr = scrubLoneSurrogatesOnWire(JSON.stringify(wireObj));
        // #3701: internal re-requests ride the same WS transport as the outer
        // turn (AsyncLocalStorage), so an oversized rebuild dies the same way —
        // run the same soft byte budget here, before resign/forensics, so both
        // see the bytes actually transmitted.
        if (ctx.protocol) {
            wireBodyStr = scrubLoneSurrogatesOnWire((await shedEgressIfOverBudget(wireBodyStr, ctx.protocol, {
                sessionId: ctx.session.id,
                session: ctx.session,
                // Single sink: ctx.log routes into the same tee logger
                // (server.ts logMsg → loggerLog), so calling both would
                // write each line twice (#3701 review Finding 2).
                log: (level, msg) => loggerLog(level, `[acp-loop] ${msg}`),
                phase: "loop",
            })).body);
        }
        requestOptions.resign?.(requestOptions.headers, wireBodyStr);
        // #2131 follow-up: the message array lives under `messages` (chat),
        // `input` (Responses) or `contents` (Google) depending on wire shape.
        const wireArr = [wireObj.messages, wireObj.input, wireObj.contents].find((v): v is unknown[] => Array.isArray(v));
        // #3938 (PR-A): loop rounds 2+ have no client inbound — their I1 entry
        // ground truth is the PREVIOUS outbound. Grab it BEFORE noteForwardedBody
        // overwrites the slot; clipped/oversized bodies retain no full copy and
        // the continuity check silently skips (no false positives from partial
        // forensics). Advisory; never blocks.
        const prevSentFull = lastForwardedBody(ctx.session)?.full ?? null;
        // #3803: generation-parameter fingerprint from the full wire object (never the capped head) —
        // a host reasoning-effort / thinking-config flip re-partitions the provider cache namespace.
        // #4397: stamp whether bili's render tags were active on THIS body (the #2483 suspect flag)
        // — per-request strategy via ctx (see LoopCtx.renderTags), knob fallback where absent.
        noteForwardedBody(ctx.session, wireBodyStr, wireArr !== undefined ? wireArr.length : null, credentialFingerprint(requestOptions.headers), generationParamFp(wireObj), ctx.renderTags !== undefined ? ctx.renderTags !== "none" : !knobRenderNone());
        if (prevSentFull) {
            maybeJudgeContinuity(prevSentFull, wireBodyStr, ctx.protocol, ctx.session.id);
        }
        // #1843 L1: capture the round's image facts for the learning layer — the
        // text side must mirror what outboundPayloadBreakdown bills (messages +
        // wire overhead) so observed image mass = billed total - textSide.
        if (ctx.imageLearn && ctx.protocol) {
            const nImages = countImagesInRawBody(ctx.protocol, wireBodyStr);
            if (nImages > 0) {
                noteForwardedImageFacts(ctx.session, {
                    nImages,
                    textSide: estimateCoreMessages(coreMessages) + estimateWireOverhead(ctx.protocol, wireBodyStr),
                    host: ctx.imageLearn.host,
                    fp: ctx.imageLearn.fp,
                });
            }
        }
        return fetchWithRetry(
            requestOptions.url,
            {
                method: "POST",
                headers: requestOptions.headers,
                body: wireBodyStr,
                ...(ctx.proxyUrl ? { dispatcher: proxyDispatcher(ctx.proxyUrl) } : {}),
            },
            undefined,
            signal,
            (info) => {
                // #189: correlate the rejection with the rewrite that
                // preceded it (shrink ratio + fold point), if any.
                const lc = lastCompressSuffix(ctx.session.lastCompress);
                ctx.log(`[acp-proxy: upstream rejected replay (HTTP ${info.status}: ${info.detail.slice(0, 120)}); likely provider risk-control — retrying in ${info.delayMs}ms (attempt ${info.attempt}/${info.maxAttempts})${lc}]`);
                loggerLog("warn", `[acp-loop] upstream rejected replay (HTTP ${info.status}); retrying in ${info.delayMs}ms (attempt ${info.attempt}/${info.maxAttempts})${lc}`);
            },
        );
    };

    // #1455: single adoption point for every loop-originated upstream body so
    // the ACP_DUMP_SSE tee covers re-requests and retries, not just the first
    // response (the incident's round-2 death left no bytes on disk at all).
    let loopFetchSeq = 0;
    const adoptUpstream = (respResult: { response: Response; clearTimer: () => void }): ReadableStream<Uint8Array> => {
        let body = respResult.response.body as ReadableStream<Uint8Array>;
        if (activeClearTimer) activeClearTimer();
        activeClearTimer = respResult.clearTimer;
        if (ctx.dumpSse && body) {
            loopFetchSeq += 1;
            const sid = (ctx.session.id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
            const [read, dump] = body.tee();
            try {
                ctx.dumpSse(`${Date.now()}-${sid}-loop${loopFetchSeq}-raw.sse`, dump);
            } catch { /* best-effort */ }
            body = read;
        }
        // #3280: undo the outbound dialect wrap (wireTransform) before any
        // consumer parses — the dump twin above keeps RAW upstream bytes,
        // mirroring the outer request's pre-unwrap tee order in relay.ts.
        if (body && requestOptions.responseStreamTransform) body = requestOptions.responseStreamTransform(body);
        return body;
    };

    // #3302 (Ask 6): probe-family observability — a model failing compress with
    // one endpoint fixed and the other varying is enumerating a sparse ref
    // space; every attempt carries different args, so the failed-only breaker
    // below ends such turns without ever flagging them. Log it once as an
    // operator signal; the failure receipts carry the live range table.
    const probeFailures = new Map<string, Set<string>>();
    let probeWarned = false;

    // #762,#1479: strict-echo origin for re-request normalization (the learned
    // flag rides on ctx.session.metadata; mirrors prepareOpenai's static gate).
    // EVERY body this loop sends upstream goes through it — main re-request AND
    // the nudge/degenerate retries, which rebuild from the same core view.
    let strictEchoOrigin: string | undefined;
    try {
        strictEchoOrigin = new URL(requestOptions.url).origin;
    } catch {
        strictEchoOrigin = undefined;
    }
    const withStrictEchoRepair = (body: Record<string, unknown>): Record<string, unknown> =>
        normalizeStrictEchoBody(body, isStrictReasoningEcho(ctx.session, strictEchoOrigin, modelIdOf(requestBody)), (level, msg) => loggerLog(level, `[acp-loop] ${msg}`), ctx.session.id ?? "unknown");

    // #1766: accumulated across rounds — every upstream terminal frame is
    // replaced by the final synthetic completion, so each round's unmodeled
    // keys must survive into it (later rounds win on key collision).
    let terminalExtra: Record<string, unknown> | undefined;

    // #2501: history-side evidence that this upstream signs thinking blocks —
    // computed once; the per-attempt side (a signature_delta seen while
    // streaming) is tracked with the other attempt state below.
    const historyHasSignedThinking = bodyHasSignedThinking(requestBody);

    // #2701: anthropic Threads continue-turns. On these the conversation
    // lives server-side behind `thread.previous_message_id`; the request body
    // carries only this turn's delta messages. The legacy round-2 rebuild —
    // `adapter.buildRequest(coreMessages, ...)` re-stamping system from
    // appendSystemText(systemPrompt, originalSystem) — is a full-history
    // CREATE: resent on a continue turn it (a) re-sends the client's already-
    // consumed continue target → upstream 400 "previous_message_id has
    // already been continued", and (b) writes different system/tools bytes
    // than the steady prepare path ever sends, poisoning the thread
    // fingerprint ("differing field(s): cache_control, system, tools" — the
    // class-2 400s after folds). Thread-mode re-requests therefore:
    //   - continue from the LATEST observed upstream response id (adapter
    //     tail), never the client's target;
    //   - send ONLY the loop's own additions since the last accepted send
    //     (proxy tool results + retrieval injections — assistant output is
    //     already server-side in r_k; visibility markers are client noise and
    //     would live in the thread forever);
    //   - keep every other body byte identical to round 1's (fingerprint).
    // Thread CREATE turns keep the legacy full-rebuild path: a create
    // re-sends the whole (possibly folded) history, the only channel that
    // can deliver a fold to the server-side thread.
    const threadContinue =
        ctx.protocol === "anthropic" &&
        typeof requestBody.thread === "object" && requestBody.thread !== null &&
        (requestBody.thread as { type?: unknown }).type === "continue";
    const threadDelta: CoreMessage[] = [];
    let threadAcceptedLen = 0; // delta entries already continued past upstream
    let threadInFlightLen = 0; // delta entries in the last-sent thread body
    let threadTailAtSend: string | undefined =
        threadContinue && typeof (requestBody.thread as { previous_message_id?: unknown }).previous_message_id === "string"
            ? (requestBody.thread as { previous_message_id: string }).previous_message_id
            : undefined;
    const threadCurrentTail = (): string | undefined => adapter.threadTailId?.();
    const threadUnsent = (): CoreMessage[] => threadDelta.slice(threadAcceptedLen);
    // Shared builder for every re-request on a threads-continue turn. Returns
    // undefined while no upstream response id has been observed (nothing to
    // continue from) — callers fall back to the legacy rebuild for that case
    // only, which is safe pre-start because the client's target is then
    // unconsumed.
    // #3400: every loop re-request re-encodes from core messages that may
    // still carry full-size originals (the post-compress refreshFolded view is
    // rebuilt from prepared.originalMessages), so each encode goes through the
    // shared egress rescale pass. Outbound copies only — coreMessages keeps
    // holding what it held. Already-shrunken images hit the hash cache and
    // pass through byte-identical (deterministic encoder), so repeated calls
    // never perturb the upstream prefix cache.
    const rescaleForEncode = async (messages: CoreMessage[]): Promise<BiliMessage[]> =>
        applyImageRescalePass(messages as BiliMessage[], { session: ctx.session, sessionId: ctx.session.id, log: (lvl, msg) => ctx.log(`[${lvl}] ${msg}`), maxDim: imageRescaleMaxDim(), toolArmed: imageRescaleToolArmed(ctx.session) });
    const buildThreadBody = async (extra: CoreMessage[]): Promise<Record<string, unknown> | undefined> => {
        const tail = threadCurrentTail();
        if (tail === undefined) return undefined;
        threadInFlightLen = threadDelta.length;
        threadTailAtSend = tail;
        const messages = coreToAnthropic(await rescaleForEncode([...threadUnsent(), ...extra]), undefined);
        return withStrictEchoRepair({
            ...requestBody,
            thread: { ...(requestBody.thread as Record<string, unknown>), previous_message_id: tail },
            messages,
        });
    };
    const buildLoopRequestBody = async (extra: CoreMessage[] = []): Promise<Record<string, unknown>> => {
        if (threadContinue) {
            const body = await buildThreadBody(extra);
            if (body !== undefined) return body;
        }
        return withStrictEchoRepair(adapter.buildRequest(await rescaleForEncode([...coreMessages, ...extra]), systemPrompt, requestBody));
    };
    // The blind truncation retry re-sends roundBody byte-identical — on a
    // threads turn that re-continues the body's target. Allowed only while
    // the target is provably unconsumed: no response observed this turn yet,
    // or the observed tail is still the one the body was sent with.
    const threadBlindRetrySafe = (): boolean => {
        const tail = threadCurrentTail();
        return tail === undefined || tail === threadTailAtSend;
    };

    try {
        for (let round = 1; round <= MAX_LOOP_ROUNDS; round++) {
            if (signal?.aborted) break;
            let assistantText = "";
            let assistantReasoning = "";
            const roundParts: RoundPart[] = [];
            let reasoningSealed = true;
            const calls: ToolCallEmit[] = [];
            let usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; creationTokens?: number; declaredInclusive?: boolean; cacheCreation?: Record<string, unknown> } = {};
            let finishReason: string | undefined;
            let streamError: string | undefined;
            let sawDone = false;
            let suppressCompletion = false;
            let truncatedDone = false;
            let sawThinking = false;
            // #821: on wires that stream reasoning verbatim (openai/anthropic) a thinking-only
            // turn marks output forwarded before done, making the #732 retry unreachable there.
            // Track model-VISIBLE output separately: a reasoning prefix is invisible to host turn
            // semantics, so the degenerate retry may still append a fresh attempt to the stream.
            // #1455 refines #413's "no bytes at all" condition: a forwarded byte only bars the
            // blind re-fetch when it CREATES client-side stream state (framing: anthropic
            // message_start / content_block_start, responses item-lifecycle events). Inert
            // keep-alives (pings — marked stateless by the adapter) are idempotent: a re-fetched
            // response may emit them again with no client-visible effect, so they must not bar
            // the retry. That is exactly where the incident died: internal re-request rounds on
            // GLM-style upstreams receive pings right after message_start, which locked every
            // round-2 truncation out of this retry path.
            let forwardedFraming = false;
            let forwardedVisible = false;
            // #2501: a thinking block reached the client without its signature —
            // unrecoverable by re-fetch on a signing upstream (see the gates).
            // Set when the held start is released (adapter's thinkingStart meta),
            // cleared when that block's signature_delta is forwarded.
            let unsignedThinkingOnWire = false;
            let sawSignedThinkingThisAttempt = false;
            let fwdBytes = 0;
            const fwd = (chunk: Buffer, visible = false, stateless = false): Buffer => {
                fwdBytes += chunk.length;
                if (!stateless) forwardedFraming = true;
                if (visible) forwardedVisible = true;
                return chunk;
            };
            // #1862: settle a measured attempt's usage the moment a retry replaces it.
            // recordUsage below runs once per ROUND, but a successful retry re-fetches within
            // the same round and the top-of-loop `usage = {}` reset drops the replaced attempt's
            // usage before it is ever recorded — billed tokens vanish from the internal ledger.
            // Called on the success path only: each upstream attempt is accounted exactly once.
            // A FAILED retry never reaches these call sites (it catches and falls through to
            // break), so the surviving original attempt is settled once by recordUsage — no
            // double counting. The client-facing completion still carries only the FINAL
            // attempt's usage (emitCompletion reads `usage`, which this never mutates), so the
            // internal ledger and the response's usage representation stay separate.
            const settleAttemptUsage = (): void => {
                if (
                    usage.inputTokens !== undefined ||
                    usage.outputTokens !== undefined ||
                    usage.cachedTokens !== undefined
                ) {
                    recordUsage(ctx, usage, round);
                }
            };

            for (;;) {
                assistantText = "";
                assistantReasoning = "";
                roundParts.length = 0;
                reasoningSealed = true;
                calls.length = 0;
                usage = {};
                finishReason = undefined;
                streamError = undefined;
                sawDone = false;
                suppressCompletion = false;
                truncatedDone = false;
                sawThinking = false;
                forwardedFraming = false;
                forwardedVisible = false;
                unsignedThinkingOnWire = false;
                sawSignedThinkingThisAttempt = false;
                fwdBytes = 0;

                for await (const ev of adapter.parseStream(currentUpstream, round)) {
                    if (signal?.aborted) break;
                    if (ev.kind === "text") {
                        assistantText += ev.delta;
                        let tp = roundParts[roundParts.length - 1];
                        if (!tp || tp.kind !== "text") {
                            tp = { kind: "text", text: "" };
                            roundParts.push(tp);
                        }
                        tp.text += ev.delta;
                        if (!ctx.textProtocol && ev.raw) {
                            yield fwd(ev.raw, true);
                        } else if (!ctx.textProtocol && round > 1 && ev.delta.length > 0) {
                            yield fwd(adapter.emitText(ev.delta), true);
                        }
                    } else if (ev.kind === "reasoning") {
                        assistantReasoning += ev.delta;
                        let seg = roundParts[roundParts.length - 1];
                        if (reasoningSealed || !seg || seg.kind !== "reasoning") {
                            seg = { kind: "reasoning", text: "", signature: "" };
                            roundParts.push(seg);
                            reasoningSealed = false;
                        }
                        seg.text += ev.delta;
                        if (ev.signature) {
                            seg.signature += ev.signature;
                            // #2501: the open thinking block just got its signature —
                            // it is valid client history again, and its presence is
                            // in-attempt evidence that this upstream signs.
                            unsignedThinkingOnWire = false;
                            sawSignedThinkingThisAttempt = true;
                        }
                        if (ev.blockEnd) reasoningSealed = true;
                        if (!ctx.textProtocol) {
                            if (ev.raw) {
                                yield fwd(ev.raw);
                            } else if (round > 1 && ev.delta.length > 0 && adapter.emitReasoning) {
                                yield fwd(adapter.emitReasoning(ev.delta));
                            }
                        }
                    } else if (ev.kind === "redacted_thinking") {
                        roundParts.push({ kind: "redacted", data: ev.data });
                    } else if (ev.kind === "standalone_signature") {
                        roundParts.push({ kind: "standalone_signature", signature: ev.signature });
                    } else if (ev.kind === "tool_call") {
                        calls.push({ name: ev.name, callId: ev.callId, arguments: ev.arguments, passthrough: ev.passthrough, signature: ev.signature });
                    } else if (ev.kind === "usage") {
                        usage = {
                            inputTokens: ev.inputTokens,
                            outputTokens: ev.outputTokens,
                            cachedTokens: ev.cachedTokens,
                            creationTokens: ev.creationTokens,
                            declaredInclusive: ev.declaredInclusive,
                            cacheCreation: ev.cacheCreation,
                        };
                    } else if (ev.kind === "done") {
                        sawDone = true;
                        finishReason = ev.finishReason;
                        suppressCompletion = ev.suppressCompletion === true;
                        truncatedDone = ev.truncated === true;
                        sawThinking = ev.thinking === true;
                        if (ev.terminalExtra && Object.keys(ev.terminalExtra).length > 0) {
                            terminalExtra = { ...terminalExtra, ...ev.terminalExtra };
                        }
                    } else if (ev.kind === "error") {
                        // A 200 SSE response can still carry a provider error.
                        // Preserve it as an error path; never let the absence of
                        // choices fall through to a synthetic successful stop.
                    streamError = ev.message;
                } else if (ev.kind === "diag") {
                    ctx.log(ev.message);
                    if (ev.level === "warn") loggerLog("warn", `[${ctx.session.id}] ${ev.message}`);
                    } else if (ev.kind === "meta") {
                        // #2501: track the client-wire state regardless of whether
                        // this round forwards the frame — the gate reads it after
                        // the attempt ends, not per forwarded byte.
                        if (ev.thinkingStart) unsignedThinkingOnWire = true;
                        if (round === 1 || !ev.firstRoundOnly) {
                            yield fwd(ev.chunk, false, ev.stateless === true);
                        }
                    }
                }

                // #2701: threads acceptance. This round's response started ⇔
                // the tail advanced past the id the sent body continued from ⇔
                // that body (with its in-flight delta slice) was consumed
                // upstream. Roll the accepted window BEFORE the retry gates
                // below so they rebuild from an empty unsent window.
                if (threadContinue) {
                    const tail = threadCurrentTail();
                    if (tail !== undefined && tail !== threadTailAtSend) {
                        threadAcceptedLen = threadInFlightLen;
                    }
                }

                if (ctx.debug) {
                    ctx.log(`[acp-loop] round ${round}: forwarded ${fwdBytes} bytes (visible=${forwardedVisible}, framing=${forwardedFraming})`);
                }

                // An in-band error has no completion event. Keep it on the
                // same zero-side-effect retry path as an abruptly truncated
                // stream; importantly, do not synthesize a successful stop.
                if (streamError !== undefined) {
                    ctx.log(`[acp-loop] round ${round}: upstream stream error: ${streamError}`);
                    loggerLog("warn", `[acp-loop] upstream stream error: ${streamError}`);
                }

                // #2501: a thinking block already forwarded to the client WITHOUT its
                // signature can never be made valid by a re-fetch — closing it (resume
                // or error path) leaves an INVALID block in the client's persisted
                // history; the next replay is rejected ("thinking.signature: Field
                // required") and Claude Code then strips ALL prior thinking from the
                // session forever. On a signing upstream (history or in-attempt
                // evidence) refuse BOTH re-fetch shapes and fall through to the
                // truncation error below: the client discards the whole failed attempt
                // instead of persisting the poisoned block. Unsigned relays — no
                // evidence either way — keep the #1455 behavior intact.
                const unsignedThinkingBarsRefetch =
                    ctx.protocol === "anthropic" &&
                    unsignedThinkingOnWire &&
                    (historyHasSignedThinking || sawSignedThinkingThisAttempt);

                // #413: zero-side-effect truncation — re-fetching the same round is
                // invisible to the client in two shapes:
                // (a) no STATEFUL bytes were forwarded (any wire — the original guarantee
                //     refined by #1455): nothing that creates client-side stream state was
                //     emitted, so the re-fetched response replaces the dead one wholesale.
                //     Inert keep-alives (pings) do not count — they are idempotent and a
                //     re-fetched response may emit them again with no effect (#1455: GLM-
                //     style upstreams send pings right after message_start, which used to
                //     bar EVERY internal re-request from this retry because the gate
                //     counted any forwarded byte).
                // (b) only INVISIBLE bytes were forwarded (reasoning/meta prefix):
                //     invisible to host turn semantics, so a high-reasoning model that
                //     thinks and then truncates still retries. OpenAI wire (stateless
                //     chunks — a re-fetched response duplicates nothing client-side) AND
                //     anthropic: its two stateful hazards are neutralized in the adapter
                //     (#1455 supplement) — the start frame is suppressed by ACTUAL
                //     forwarding state rather than round number, so a re-fetched stream
                //     cannot emit a second response identity, and parseStream closes the
                //     dead attempt's still-open blocks before resuming, so no dangling
                //     content_block_start survives. The THIRD anthropic hazard — an
                //     unsigned thinking block already on the client wire — is barred
                //     out of this gate by unsignedThinkingBarsRefetch (#2501).
                //     responses/google keep shape (a) only:
                //     their item-lifecycle identity frames (response.created — #440's
                //     single-created invariant) have no equivalent dedup here.
                // One retry per request; 200+early-EOF flakiness (common on relays) no
                // longer lands in the agent session.
                // `truncatedDone` covers adapters that surface truncation as a synthetic
                // failed done (responses) instead of ending with !sawDone (anthropic) —
                // same retry, both shapes.
                if (
                    (!sawDone || truncatedDone) &&
                    (!forwardedVisible && (!forwardedFraming || ctx.protocol === "openai" || ctx.protocol === "anthropic")) &&
                    calls.length === 0 &&
                    !(ctx.textProtocol && assistantText.length > 0) &&
                    !signal?.aborted &&
                    !truncationRetried &&
                    !unsignedThinkingBarsRefetch &&
                    // #2701: on a threads-continue turn a byte-identical re-send
                    // re-continues this body's target — legal only while it is
                    // provably unconsumed (no response started since the send).
                    (!threadContinue || threadBlindRetrySafe())
                ) {
                    truncationRetried = true;
                    ctx.log(`[acp-loop] round ${round}: upstream truncated with no visible output reaching the client; retrying fetch once`);
                    try {
                        // Same roundBody bytes on purpose: the retry re-issues the SAME
                        // logical request (the gate above proves nothing client-visible
                        // was emitted), so the body must stay byte-identical — rebuilding
                        // it would shift prompt-cache leading-edge markers and break
                        // prefix cache reuse on the re-fetch.
                        const respResult = await fetchUpstream(roundBody);
                        if (!respResult.response.body) {
                            respResult.clearTimer();
                            throw new UpstreamHttpError(respResult.response.status, "(empty response body)", 1);
                        }
                        currentUpstream = adoptUpstream(respResult);
                        settleAttemptUsage();
                        continue;
                    } catch (e) {
                        if (e instanceof UpstreamHttpError) {
                            const suffix = e.attempts > 1 ? ` after ${e.attempts} attempt(s)` : "";
                            ctx.log(`[acp-loop] round ${round}: truncation retry failed (upstream error ${e.status}${suffix}: ${e.body.slice(0, 200)})`);
                        } else {
                            ctx.log(`[acp-loop] round ${round}: truncation retry failed (${e instanceof Error ? e.message : String(e)})`);
                        }
                    }
                }

                // #413 follow-up: the stream died AFTER visible text already
                // reached the client. A blind re-fetch would make it watch the
                // answer regrow on top of the partial one, so re-fetch once with
                // a continuation nudge quoting the forwarded tail: the retry's
                // output appends seamlessly to what the client already has.
                // Independent one-shot budget (continuationRetried), separate
                // from #413's truncationRetried: a visible cut that continues
                // and then cuts again invisibly must still leave the blind
                // re-fetch available, because the second attempt added nothing
                // the client can see. Gate keeps calls.length === 0 — a round
                // with tool-call fragments falls through to the plain
                // truncation error, since their semantics only survive a
                // completed stream. OpenAI and Anthropic wires only: openai
                // has no per-message identity frame to duplicate, and
                // anthropic's two re-fetch hazards are neutralized by the
                // adapter — state-keyed message_start suppression (at most one
                // start frame per logical response) and close-at-resume of
                // the dead attempt's dangling blocks, with block indices
                // continuing upward (#1455/#1464; #1470). responses/google
                // stay excluded: their item-lifecycle identity frames have no
                // dedup equivalent (#440 single-created invariant).
                if (
                    (!sawDone || truncatedDone) &&
                    forwardedVisible &&
                    (ctx.protocol === "openai" || ctx.protocol === "anthropic") &&
                    !ctx.textProtocol &&
                    assistantText.length > 0 &&
                    calls.length === 0 &&
                    !signal?.aborted &&
                    !continuationRetried &&
                    // #2501: text before the open thinking block — same poisoned-block
                    // hazard as the blind shape; refuse and fall through to the error.
                    !unsignedThinkingBarsRefetch
                ) {
                    continuationRetried = true;
                    const tail = assistantText.length <= TRUNCATION_CONTINUATION_TAIL_CHARS
                        ? assistantText
                        : `…${safeSuffix(assistantText, TRUNCATION_CONTINUATION_TAIL_CHARS)}`;
                    ctx.log(`[acp-loop] round ${round}: upstream truncated after ${assistantText.length} text chars reached the client; retrying once with continuation nudge`);
                    const nudge: CoreMessage = {
                        id: `acp_truncation_retry_r${round}`,
                        role: "user",
                        contentType: "text",
                        text: truncationContinuationNudge(tail),
                    };
                    try {
                        const retryBody = await buildLoopRequestBody([nudge]);
                        const respResult = await fetchUpstream(retryBody);
                        if (!respResult.response.body) {
                            respResult.clearTimer();
                            throw new UpstreamHttpError(respResult.response.status, "(empty response body)", 1);
                        }
                        currentUpstream = adoptUpstream(respResult);
                        roundBody = retryBody;
                        settleAttemptUsage();
                        continue;
                    } catch (e) {
                        if (e instanceof UpstreamHttpError) {
                            ctx.log(`[acp-loop] round ${round}: continuation retry failed (upstream error ${e.status}: ${e.body.slice(0, 200)}); falling back to the truncation error`);
                        } else {
                            ctx.log(`[acp-loop] round ${round}: continuation retry failed (${e instanceof Error ? e.message : String(e)}); falling back to the truncation error`);
                        }
                        loggerLog("warn", `[acp-loop] truncation continuation retry failed round ${round}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }

                // #732 (completes the auto-retry groundwork of #673/#674), extended by #821: a reasoning model can end a turn with ONLY a thinking block — zero visible text, zero tool calls, status completed — most often right after a post-compress re-request, where it sees the freshly-shrunk context and "wraps up" into a silent thought. The client then receives an empty completed turn and stalls until manually nudged. Retriable when no VISIBLE output reached the client yet (!forwardedVisible): on Responses rounds the framing is suppressed so nothing was forwarded at all; on openai/anthropic a thinking-only prefix WAS streamed verbatim, but it is invisible to host turn semantics and its chunks carry no finish_reason, so appending the retry's content to the same stream is safe. Re-fetch once with a continuation nudge (a plain re-fetch reproduces the same silent output deterministically). One-shot per request. `sawThinking` is mandatory so a genuinely empty (no-reasoning) terminal turn is left untouched — only the "silent thought" shape retries.
                if (
                    !degenerateRetried &&
                    sawDone &&
                    sawThinking &&
                    !truncatedDone &&
                    !suppressCompletion &&
                    typeof finishReason === "string" &&
                    finishReason !== "failed" &&
                    finishReason !== "incomplete" &&
                    finishReason !== "error" &&
                    assistantText.length === 0 &&
                    calls.length === 0 &&
                    !forwardedVisible &&
                    !signal?.aborted
                ) {
                    degenerateRetried = true;
                    ctx.log(`[acp-loop] round ${round}: degenerate terminal turn (completed, zero visible output); retrying once with continuation nudge (#732/#821)`);
                    loggerLog("warn", `[acp-loop] degenerate-turn auto-retry round ${round} (session ${ctx.session.id})`);
                    const nudge: CoreMessage = {
                        id: `acp_degenerate_retry_r${round}`,
                        role: "user",
                        contentType: "text",
                        text: DEGENERATE_RETRY_NUDGE,
                    };
                    try {
                        const retryBody = await buildLoopRequestBody([nudge]);
                        const respResult = await fetchUpstream(retryBody);
                        if (!respResult.response.body) {
                            respResult.clearTimer();
                            throw new UpstreamHttpError(respResult.response.status, "(empty response body)", 1);
                        }
                        currentUpstream = adoptUpstream(respResult);
                        roundBody = retryBody;
                        settleAttemptUsage();
                        continue;
                    } catch (e) {
                        if (e instanceof UpstreamHttpError) {
                            ctx.log(`[acp-loop] round ${round}: degenerate retry failed (upstream error ${e.status}: ${e.body.slice(0, 200)}); passing the empty turn through`);
                        } else {
                            ctx.log(`[acp-loop] round ${round}: degenerate retry failed (${e instanceof Error ? e.message : String(e)}); passing the empty turn through`);
                        }
                        loggerLog("warn", `[acp-loop] degenerate-turn auto-retry failed round ${round}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }

                // #2303: a terminal turn that DID deliver visible prose but ends with a
                // compression-draft closing tag (summary/analysis close forms) and no
                // tool call — the model wrote a handoff/compression draft in prose
                // instead of issuing the action it described, most often after the
                // upstream cut the final tool call out of the step (149 silent stops /
                // 70 sessions, DSH native). Same non-convergence as the zero-visible
                // shape above, so the same one-shot continuation nudge applies. The
                // retry's output APPENDS to what the client already has, like the
                // truncation-continuation path: openai/anthropic wires only (same
                // framing-dedup boundary as #413-follow-up). Reuses degenerateRetried
                // as its budget: a draft-tail retry that degenerates again falls
                // through to the plain completion, exactly like the #732 twin.
                if (
                    !degenerateRetried &&
                    sawDone &&
                    !truncatedDone &&
                    !suppressCompletion &&
                    typeof finishReason === "string" &&
                    finishReason !== "failed" &&
                    finishReason !== "incomplete" &&
                    finishReason !== "error" &&
                    (ctx.protocol === "openai" || ctx.protocol === "anthropic") &&
                    !ctx.textProtocol &&
                    assistantText.length > 0 &&
                    calls.length === 0 &&
                    endsWithDraftClose(assistantText) &&
                    // #2612: the client's own compaction request instructs the
                    // model to answer with a plain-text summary block and no
                    // tool call — that compliant reply is a draft tail by
                    // design, not a stalled handoff; retrying it breaks the
                    // compaction (the retry complies too → #870 error).
                    !requestExpectsProseSummary(lastUserSummaryInstruction(coreMessages)) &&
                    !signal?.aborted
                ) {
                    degenerateRetried = true;
                    ctx.log(`[acp-loop] round ${round}: terminal turn ends with a compression-draft closing tag and no tool call; retrying once with continuation nudge (#2303)`);
                    loggerLog("warn", `[acp-loop] draft-tail auto-retry round ${round} (session ${ctx.session.id})`);
                    const nudge: CoreMessage = {
                        id: `acp_draft_tail_retry_r${round}`,
                        role: "user",
                        contentType: "text",
                        text: DEGENERATE_RETRY_NUDGE,
                    };
                    try {
                        const retryBody = await buildLoopRequestBody([nudge]);
                        const respResult = await fetchUpstream(retryBody);
                        if (!respResult.response.body) {
                            respResult.clearTimer();
                            throw new UpstreamHttpError(respResult.response.status, "(empty response body)", 1);
                        }
                        currentUpstream = adoptUpstream(respResult);
                        roundBody = retryBody;
                        settleAttemptUsage();
                        continue;
                    } catch (e) {
                        if (e instanceof UpstreamHttpError) {
                            ctx.log(`[acp-loop] round ${round}: draft-tail retry failed (upstream error ${e.status}: ${e.body.slice(0, 200)}); passing the turn through`);
                        } else {
                            ctx.log(`[acp-loop] round ${round}: draft-tail retry failed (${e instanceof Error ? e.message : String(e)}); passing the turn through`);
                        }
                        loggerLog("warn", `[acp-loop] draft-tail auto-retry failed round ${round}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                break;
            }

            if (
                usage.inputTokens !== undefined ||
                usage.outputTokens !== undefined ||
                usage.cachedTokens !== undefined
            ) {
                recordUsage(ctx, usage, round);
            } else {
                diagnoseSuccessWithoutUsage(ctx.session, "acp-loop");
            }
            let resolvedText = assistantText;
            let allCalls = calls;
            if (ctx.textProtocol && assistantText.length > 0 && adapter.extractTextTriggers) {
                const extracted = adapter.extractTextTriggers(assistantText);
                resolvedText = extracted.clean;
                allCalls = [...calls, ...extracted.calls];
            }
            // #906: gate on allCalls (structured + text-extracted), not just
            // structured calls — an extracted trigger executes identically, so
            // its result must ride back as a real tool-call/tool-result pair;
            // the marker fallback below would become a mid-conversation
            // developer item the backend may drop (and truncates the result).
            const functionCallIds = new Set(allCalls.map(c => c.callId));

            if (ctx.textProtocol && resolvedText.length > 0) {
                yield adapter.emitText(resolvedText);
            }

            let realCalls = 0;
            const realToolCalls: ToolCallEmit[] = [];
            const proxyResults: { name: string; callId: string; result: string; arguments: string; wireArguments: string; signature?: string; image?: { base64: string; mediaType: string } }[] = [];

            for (const call of allCalls) {
                if (call.name.length === 0) {
                    // #1484: upstream emitted a tool_call whose function.name never arrived. No
                    // conforming client can render or execute a nameless call, and forwarding a
                    // synthetic frame for it guarantees AI_InvalidResponseDataError at assembly.
                    ctx.log(`[acp-loop] round ${round}: dropping nameless tool call (id=${call.callId || "-"}, argsLen=${call.arguments.length}) — upstream sent no function.name (#1484)`);
                    loggerLog("warn", `[acp-loop] round ${round}: dropping nameless tool call (session ${ctx.session.id}, id=${call.callId || "-"}, argsLen=${call.arguments.length}) (#1484)`);
                    continue;
                }
                if (isProxyToolFor(call.name, ctx.session, ctx.config)) {
                    let parsedArgs: Record<string, unknown>;
                    let rawArgs: string | undefined;
                    try {
                        parsedArgs = call.arguments.length > 0 ? JSON.parse(call.arguments) : {};
                    } catch {
                        // #1306: an empty/truncated arguments string is wire-loss-shaped, bad JSON is model-shaped — log the shape so the two are separable in logs.
                        // #1502: tail= alongside head= separates mid-string corruption from truncation; the raw string survives for the lenient parser.
                        ctx.log(`[acp-loop] proxy tool ${call.name}: arguments not parseable JSON (len=${call.arguments.length}${call.arguments.length > 0 ? `, head=${safePrefix(call.arguments, 200)}, tail=${safeSuffix(call.arguments, 200)}` : ""}) — ${call.name === COMPRESS_TOOL_NAME ? "routing the raw string to the lenient parser" : "executing with {}"}; re-request replays a valid-JSON placeholder (#3661)`);
                        rawArgs = call.arguments;
                        parsedArgs = {};
                    }
                    const result = await withSessionLock(ctx.session, () => executeProxyToolAsync(call.name, parsedArgs, ctx, call.callId, rawArgs, signal));
                    proxyResults.push({ name: call.name, callId: call.callId, result: result.text, arguments: call.arguments, wireArguments: rawArgs === undefined ? call.arguments : MALFORMED_PROXY_TOOL_ARGS_REPLAY, signature: call.signature, ...(result.image ? { image: result.image } : {}) });
                    if (ctx.visibilityMarkers !== false) {
                        const markerKey = `${call.name}\u0000${result.text}`;
                        if (seenMarkers.has(markerKey)) {
                            ctx.log(`[acp-loop] suppressed duplicate ${call.name} status marker (identical failure repeated this request)`);
                        } else {
                            seenMarkers.add(markerKey);
                            yield adapter.emitMarker(call.name, result.text);
                        }
                    }
                } else {
                    realToolCalls.push(call);
                    realCalls += 1;
                }
            }

            if (ctx.debug) {
                const callSummary = allCalls.map(c => {
                    const argSnippet = c.arguments.length > 200 ? c.arguments.slice(0, 200) + "..." : c.arguments;
                    return `${c.name}(${argSnippet})`;
                }).join(" | ");
                ctx.log(`[acp-loop] round ${round}: ${allCalls.length} call(s): ${callSummary || "(none)"}`);
                for (const pr of proxyResults) {
                    const resSnippet = pr.result.length > 300 ? pr.result.slice(0, 300) + "..." : pr.result;
                    ctx.log(`[acp-loop]   → ${pr.name} result: ${resSnippet}`);
                }
                if (realCalls > 0) ctx.log(`[acp-loop] round ${round}: ${realCalls} real tool call(s) forwarded to client`);
            }

            // Per-round hygiene (fixes the injection-persistence 炸锅): the
            // philosophy systemPrompt is transient (passed fresh to buildRequest,
            // never in coreMessages), and hideConsumedCompressCalls runs each
            // round so consumed compress records cannot re-prime the model.
            if (proxyResults.length > 0) {
                // #539: only wires that VERIFY thinking+signature pairs need a
                // signature to replay a thinking block — Anthropic and Gemini 3
                // (its thoughtSignature is rejected when dropped, same fatality).
                // OpenAI/DeepSeek and Responses echo reasoning_content back
                // verbatim and emit no signature — gating on one dropped every
                // such round's reasoning from the re-request, leaving the
                // proxy-tool assistant message without reasoning_content
                // (DeepSeek 400 invalid_request_error: "reasoning_content ...
                // must be passed back"). Relies on the invariant that the single
                // production call site (server.ts) always populates ctx.protocol.
                const requiresThinkingSignature = ctx.protocol === "anthropic" || ctx.protocol === "google";
                let reasoningIdx = 0;
                let textIdx = 0;
                let redactedIdx = 0;
                let sigIdx = 0;
                for (const part of roundParts) {
                    if (part.kind === "reasoning") {
                        if (part.text.length === 0 || (requiresThinkingSignature && part.signature.length === 0)) continue;
                        reasoningIdx += 1;
                        const reasoningMsg: BiliMessage = {
                            id: reasoningIdx === 1 ? `acp_loop_r${round}_reasoning` : `acp_loop_r${round}_reasoning_${reasoningIdx}`,
                            role: "assistant",
                            contentType: "reasoning",
                            text: part.text,
                            reasoningContent: part.text,
                            ...(part.signature.length > 0
                                ? ctx.protocol === "google"
                                    ? { googleThoughtSignature: part.signature }
                                    : { thinkingSignature: part.signature }
                                : {}),
                        };
                        coreMessages.push(reasoningMsg);
                    } else if (part.kind === "text") {
                        if (part.text.length === 0) continue;
                        textIdx += 1;
                        coreMessages.push({
                            id: textIdx === 1 ? `acp_loop_r${round}_asst` : `acp_loop_r${round}_asst_${textIdx}`,
                            role: "assistant",
                            contentType: "text",
                            text: part.text,
                        });
                    } else if (part.kind === "standalone_signature") {
                        // #3158: put the standalone thoughtSignature back at its
                        // stream position. rawGoogleParts is required: contentParts
                        // returns the raw verbatim only when it can prove the raw's
                        // texts equal the core's text, and an empty-text core with
                        // no raw would serialize to zero parts — content vanishes.
                        sigIdx += 1;
                        const sigMsg: BiliMessage = {
                            id: sigIdx === 1 ? `acp_loop_r${round}_asst_sig` : `acp_loop_r${round}_asst_sig_${sigIdx}`,
                            role: "assistant",
                            contentType: "text",
                            text: "",
                            googleThoughtSignature: part.signature,
                            rawGoogleParts: [{ thoughtSignature: part.signature }],
                        };
                        coreMessages.push(sigMsg);
                    } else {
                        // #1960: byte-exact, position-exact replay of the opaque
                        // block; coreToAnthropic re-emits rawAnthropicBlock verbatim.
                        redactedIdx += 1;
                        const redactedMsg: BiliMessage = {
                            id: redactedIdx === 1 ? `acp_loop_r${round}_redacted` : `acp_loop_r${round}_redacted_${redactedIdx}`,
                            role: "assistant",
                            contentType: "text",
                            text: "[redacted_thinking]",
                            rawAnthropicBlock: { type: "redacted_thinking", data: part.data },
                        };
                        coreMessages.push(redactedMsg);
                    }
                }
                for (const pr of proxyResults) {
                    if (functionCallIds.has(pr.callId)) {
                        coreMessages.push({
                            id: `acp_loop_r${round}_asst_tc_${pr.callId}`,
                            role: "assistant",
                            contentType: "tool-call",
                            toolName: pr.name,
                            toolCallId: pr.callId,
                            // #3661: guaranteed-valid-JSON replay (see wireArguments); raw model bytes stay in pr.arguments for #156 signatures.
                            text: pr.wireArguments,
                            ...(ctx.protocol === "google" && pr.signature ? { googleThoughtSignature: pr.signature } : {}),
                        });
                        const toolResultMsg: CoreMessage = {
                            id: `acp_loop_r${round}_tool_${pr.callId}`,
                            role: "tool",
                            contentType: "tool-result",
                            toolName: pr.name,
                            toolCallId: pr.callId,
                            text: pr.result,
                        };
                        coreMessages.push(toolResultMsg);
                        // #2701: on a threads turn this tool_result is the ONLY
                        // model-visible record of the proxy execution that must
                        // ride the server-side thread (the assistant tool_use it
                        // answers already lives there in r_k).
                        if (threadContinue) threadDelta.push(toolResultMsg);
                        // #3400: the original image rides an ephemeral user
                        // message right after its ack. toolName marks it so the
                        // egress rescale pass exempts it structurally (the loop
                        // guard — without this, reading an original would just
                        // get it shrunk again, #3266's cycle). Ephemeral like
                        // every acp_loop_* record: never persisted, never seen
                        // by the client (#1548).
                        if (pr.image) {
                            const dataUrl = `data:${pr.image.mediaType};base64,${pr.image.base64}`;
                            const carrierMsg: BiliMessage = {
                                id: `acp_loop_r${round}_img_${pr.callId}`,
                                role: "user",
                                contentType: "text",
                                text: "[bili] 原图已读取,完整分辨率的原始图片如下。",
                                toolName: pr.name,
                                imageBase64: pr.image.base64,
                                imageMediaType: pr.image.mediaType,
                                rawResponsesItem: { type: "message", role: "user", content: [{ type: "input_text", text: "[bili] 原图已读取,完整分辨率的原始图片如下。" }, { type: "input_image", image_url: dataUrl }] },
                            };
                            coreMessages.push(carrierMsg);
                            if (threadContinue) threadDelta.push(carrierMsg);
                        }
                    } else if (ctx.visibilityMarkers !== false) {
                        coreMessages.push({
                            id: `acp_loop_r${round}_marker_${pr.callId}`,
                            role: "system",
                            contentType: "text",
                            text: buildVisibilityMarker(pr.name, pr.result),
                        });
                        // #2701: visibility markers are CLIENT-side noise; they
                        // are streamed to the client (emitMarker) and deliberately
                        // kept OUT of the thread delta — a server-side thread is
                        // append-only and would carry them forever.
                    }
                }
                // #1097: retrieval injections ride the same re-request channel
                // as the ack pairs above — ack first, full text second. Their
                // ids (acp_retrieved_*) are structurally excluded from ref
                // assignment, so they never consume message numbers.
                for (const injection of drainPendingRetrievals(ctx.session)) {
                    coreMessages.push(injection);
                    // #2701: retrieval injections carry full retrieved text the
                    // model must see — deliverable on a threads turn via the delta.
                    if (threadContinue) threadDelta.push(injection);
                }
                const anyCompressFailed = proxyResults.some(
                    (pr) => (pr.name === "compress" || pr.name === "decompress") && pr.result.includes("FAILED"),
                );
                if (!ctx.textProtocol && !anyCompressFailed) {
                    const hidden = hideConsumedCompressCalls(ctx.session.state, coreMessages, ctx.config.isCompressTool);
                    if (hidden.hidden > 0) {
                        ctx.log(`[acp-loop] round ${round} hideConsumed hid ${hidden.hidden} compress record(s)`);
                        coreMessages.length = 0;
                        coreMessages.push(...hidden.messages);
                    }
                }
                // #422: a successful compress changed the session state — refresh
                // the fold so the re-request shows the post-compress view. A
                // successful absorb does the same (state.absorbed grew; the
                // refresh's processTurn + hideAbsorbedView drop the pair). A
                // no-op re-absorb ("already absorbed") also passes this check —
                // its refresh is a harmless identical-view re-fold. Falls back
                // to the pre-compress view (previous behavior) if the host hook
                // is absent or throws.
                const absorbName = activeAbsorbToolName(ctx.session, ctx.config);
                if (
                    ctx.refreshFolded &&
                    proxyResults.some((pr) => (pr.name === "compress" || pr.name === absorbName) && !pr.result.includes("FAILED"))
                ) {
                    try {
                        const refreshed = await ctx.refreshFolded(coreMessages);
                        if (refreshed.length > 0) {
                            coreMessages.length = 0;
                            coreMessages.push(...refreshed);
                            // The fold has now materialized in a request the
                            // model actually sees — the next usage report is
                            // post-fold reality; keeping the credit would net
                            // the savings twice (recordUsage).
                            ctx.session.stats.compressCreditTokens = 0;
                            ctx.log(`[acp-loop] round ${round}: re-request view refreshed to post-compress fold`);
                        }
                    } catch (err) {
                        ctx.log(`[acp-loop] round ${round}: fold refresh failed (${String(err)}); keeping pre-compress view`);
                        loggerLog("warn", `[acp-loop] fold refresh failed: ${String(err)}`);
                    }
                }
            }

            for (const tc of realToolCalls) {
                if (tc.passthrough) continue;
                yield adapter.emitToolCall(tc);
            }

            // Re-request so the model receives the proxy-tool result and can
            // continue (standard function-calling continuation: the proxy acts as
            // the client, executes compress/decompress/acp_status/search, then
            // feeds the result back as a normal tool output via functionCallIds
            // above — success OR failure alike). The model sees the result and
            // decides its next action (retry a different range, or stop). A failed
            // compress returns its failure as the tool output, so the model is not
            // blind to why it failed. MAX_LOOP_ROUNDS bounds runaway loops.
            const reRequest = proxyResults.length > 0 && realCalls === 0;
            if (!reRequest) {
                // #887: nothing is learned from a truncated stream — the
                // window is a deployment property (#987), and stream cuts are
                // indistinguishable from network noise mid-stream.
                if (!sawDone) {
                    const partialText = assistantText.length;
                    const partialReasoning = assistantReasoning.length;
                    const detail = streamError !== undefined ? `upstream stream error: ${streamError}` : "no completion event";
                    const msg = `upstream stream truncated (${detail}; round ${round}, ${partialText} text chars + ${partialReasoning} reasoning chars received)`;
                    ctx.log(`[acp-loop] round ${round}: ${msg}`);
                    yield adapter.emitError(msg);
                    return;
                }
                // A passthrough round already streamed the upstream's own finish
                // chunk + [DONE] verbatim (original id + order); re-emitting a
                // regenerated completion would duplicate them.
                if (!suppressCompletion) {
                    yield adapter.emitCompletion({ finishReason, usage, terminalExtra });
                }
                return;
            }

            // Graceful termination at the loop limit — NEVER a degenerate empty
            // completion; surface whatever text/markers were produced this round.
            if (round >= MAX_LOOP_ROUNDS) {
                ctx.log(`[acp-loop] round ${round} hit MAX_LOOP_ROUNDS; completing gracefully`);
                loggerLog("warn", `[acp-loop] loop limit (${MAX_LOOP_ROUNDS}) reached; completing gracefully`);
                yield adapter.emitCompletion({ finishReason: "length", usage, terminalExtra });
                return;
            }

            // #156/#4186: if this round is only failed compress/decompress, stop
            // here instead of re-requesting. The failed frames spliced into the
            // retry body above are ephemeral (#1548): never persisted, never seen
            // by the client. Letting them reach upstream and then vanish from the
            // next request rewrites the provider's frozen prefix mid-history —
            // an unsanctioned cache seam. Breaking keeps them off the wire; the
            // receipt already streamed to the client carries why it failed, and a
            // later turn can retry with a different range.
            const failedMutating = proxyResults.filter(
                (pr) => (pr.name === "compress" || pr.name === "decompress") && pr.result.includes("FAILED"),
            );

            if (!probeWarned) {
                const probing = recordProbeFailures(probeFailures, failedMutating);
                if (probing) {
                    probeWarned = true;
                    ctx.log(`[acp-loop] round ${round}: model probed ${probing.values.length} distinct ${probing.label} values (${probing.values.join(", ")}) in failed compress calls — sparse ref-space enumeration (#3302); the receipts carry the live range table`);
                    loggerLog("warn", `[acp-loop] compress probe family at round ${round}: ${probing.values.length} distinct ${probing.label} values failed (${probing.values.join(", ")}) (#3302)`);
                }
            }

            if (reRequest && failedMutating.length > 0 && failedMutating.length === proxyResults.length) {
                ctx.log(`[acp-loop] round ${round}: failed-only mutating round; completing after ${round} round(s) instead of re-requesting (#156/#4186)`);
                loggerLog("warn", `[acp-loop] failed compress/decompress round at round ${round}; breaking early (#156/#4186)`);
                yield adapter.emitCompletion({ finishReason: "length", usage, terminalExtra });
                return;
            }

            ctx.log(`[acp-loop] round ${round}: proxy tool executed; re-requesting so the model sees the result`);

            if (signal?.aborted) break;

            // #2701: threads-continue turns build the delta-shaped body (see
            // buildLoopRequestBody); legacy full-rebuild otherwise.
            let newBody = await buildLoopRequestBody();
            if (knobBodyDumpEnabled()) {
                try {
                    const fs = await import("node:fs");
                    const path = await import("node:path");
                    const dumpDir = dumpsDir();
                    fs.mkdirSync(dumpDir, { recursive: true });
                    const sid = (ctx.session.id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
                    fs.writeFileSync(path.join(dumpDir, `req-${Date.now()}-${sid}-REREQUEST.json`), `${DUMP_PLAINTEXT_BANNER}\n${JSON.stringify(newBody, null, 2)}`);
                } catch { /* best-effort */ }
            }
            let respResult: { response: Response; clearTimer: () => void };
            try {
                try {
                    respResult = await fetchUpstream(newBody);
                } catch (e) {
                    // #539 follow-up: stripping replayed thinking only recovers a
                    // backend where thinking is OPTIONAL (Anthropic, and Gemini —
                    // its thoughtSignature check is what a stripped replay drops).
                    // On OpenAI/DeepSeek thinking mode reasoning_content is
                    // MANDATORY, so a strip-retry there guarantees another 400 plus
                    // a misleading log — gate the degraded retry to the wires that
                    // verify signatures.
                    if (
                        !(e instanceof UpstreamHttpError) ||
                        e.status < 400 ||
                        e.status >= 500 ||
                        degradedRetried ||
                        isThinkingModifiedError(e) ||
                        (ctx.protocol !== "anthropic" && ctx.protocol !== "google") ||
                        !coreMessages.some(isLoopThinking)
                    ) {
                        throw e;
                    }
                    degradedRetried = true;
                    const stripped = stripLoopThinking(coreMessages);
                    coreMessages.length = 0;
                    coreMessages.push(...stripped);
                    ctx.log(`[acp-loop] round ${round}: re-request rejected (${e.status}: ${e.body.slice(0, 200)}); retrying without replayed thinking blocks`);
                    loggerLog("warn", `[acp-loop] re-request rejected (${e.status}); retrying without thinking replay: ${e.body.slice(0, 200)}`);
                    newBody = await buildLoopRequestBody();
                    respResult = await fetchUpstream(newBody);
                }
            } catch (e) {
                if (!(e instanceof UpstreamHttpError)) {
                    // #1453: transport-level failure — no HTTP response ever
                    // arrived. Previously this escaped the loop and surfaced as
                    // a bare "fetch failed" stream error, killing the turn even
                    // though the round's compress may already have landed. End
                    // in-band like every other loop exit and tell the user what
                    // survived. Client abort keeps the old path (socket gone).
                    if (!signal?.aborted) {
                        const kind = classifyUpstreamFailure(e, { viaProxy: ctx.proxyUrl !== undefined });
                        let committedTokens = 0;
                        let committedBlocks = 0;
                        for (const pr of proxyResults) {
                            if (pr.name === "compress" && !pr.result.includes("FAILED")) {
                                const saved = /~(\d[\d,]*) tokens saved/.exec(pr.result);
                                if (saved) committedTokens += Number(saved[1]!.replace(/,/g, ""));
                                const blocks = /(\d+) block\(s\)/.exec(pr.result);
                                if (blocks) committedBlocks += Number(blocks[1]);
                            }
                        }
                        const absorbed = proxyResults.some((pr) => pr.name === activeAbsorbToolName(ctx.session, ctx.config) && !pr.result.includes("FAILED"));
                        const note = committedTokens > 0
                            ? `compression committed (~${committedTokens.toLocaleString("en-US")} tokens saved${committedBlocks > 0 ? ` in ${committedBlocks} block(s)` : ""}); `
                            : absorbed ? "context work committed; " : "";
                        const msg = `${note}the follow-up request to the model failed (${TRANSPORT_FAILURE_LABELS[kind]}) before any response — your context is intact, resend your last message to continue`;
                        ctx.log(`[acp-loop] round ${round}: re-request transport failure (${kind}); ending turn in-band instead of throwing (#1453)`);
                        loggerLog("error", `[acp-loop] re-request transport failure after ${round} round(s): ${formatUpstreamError(e, requestOptions.url, ctx.proxyUrl, ctx.skippedProxy)}`);
                        yield adapter.emitError(msg);
                        return;
                    }
                    throw e;
                }
                // #684 learn-on-failure: a 400 mentioning reasoning_content on
                // a thinking session is the split-turn signature — remember it
                // on the session so #651's reasoning-drop never fires here
                // again (kernel gate prevents the split; this closes the loop).
                // #2169: match BOTH field spellings — the chat wire says
                // reasoning_content, DeepSeek's Responses wire says reasoning_text.
                if (
                    e.status === 400 &&
                    /reasoning_(?:content|text)/i.test(e.body) &&
                    ctx.session.metadata.strictReasoningEcho !== true
                ) {
                    ctx.session.metadata.strictReasoningEcho = true;
                    ctx.log(`[acp-loop] 400 mentions a reasoning echo field — learned strict reasoning echo for this session; #651 reasoning-drop disabled (#684/#2169)`);
                    loggerLog("warn", `[acp-loop] learned strictReasoningEcho (session ${ctx.session.id}); reasoning-drop disabled (#684)`);
                }
                // #762: persist the exact re-requested body on 4xx (env-gated: BILI_DUMP_4XX=1).
                if (e.status >= 400 && e.status < 500) {
                    dumpRejectedBody(e.status, ctx.session.id ?? "unknown", JSON.stringify(newBody));
                }
                const suffix = e.attempts > 1 ? ` after ${e.attempts} attempt(s)` : "";
                ctx.log(`[acp-proxy: compress loop upstream error ${e.status}${suffix}: ${e.body.slice(0, 200)}]`);
                loggerLog("error", `[acp-loop] upstream error ${e.status}${suffix}: ${e.body.slice(0, 200)}`);
                yield adapter.emitError(`upstream error ${e.status}${suffix}: ${e.body.slice(0, 200)}`);
                return;
            }

            if (!respResult.response.body) {
                respResult.clearTimer();
                yield adapter.emitError(`upstream error ${respResult.response.status}: empty response body`);
                return;
            }

            currentUpstream = adoptUpstream(respResult);
            roundBody = newBody;
        }
    } finally {
        // #2701: anthropic Threads — persist every response id observed this
        // turn (round 1's message_start id first, then one per internal
        // round) so an inbound continue targeting an id the PROXY itself
        // consumed gets rewritten to the current tail (see
        // server/thread-tracking.ts). In `finally` on purpose: an id whose
        // stream later died mid-parse was still consumed upstream, and this
        // runs on every exit shape including throws.
        if (threadContinue) {
            for (const id of adapter.threadResponseIds?.() ?? []) {
                recordThreadTail(ctx.session, id);
            }
        }
        if (activeClearTimer) {
            activeClearTimer();
            activeClearTimer = null;
        }
    }
}
