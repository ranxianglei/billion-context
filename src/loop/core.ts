import {
    hideConsumedCompressCalls,
    type CompressionCore,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import { handleAcpStatus } from "../acp-status.js";
import { handleAcpCache, noteForwardedBody, settleUsageReport } from "../cache-ledger.js";
import { diagnoseSuccessWithoutUsage, lastCompressSuffix, withSessionLock, type Session } from "../session.js";
import type { BiliMessage } from "acp-kernel/wire";
import {
    parseCompressInput,
    ABSORB_TOOL_NAME,
    COMPRESS_TOOL_NAME,
    RULE_TOOL_NAME,
} from "../compress-tool.js";
import { effectiveAbsorbConfig, executeAbsorb, isProxyToolFor } from "../absorb.js";
import { effectiveRulesEnabled, executeRule } from "../rules-feature.js";
import { ccrEnabled, drainPendingRetrievals, executeRetrieve, retrieveToolName } from "../store.js";
import { IMAGE_FULL_TOOL_NAME, executeImageFull, imageCompressionEnabled, imageUsageSuffix } from "../image-compress.js";
import { applyRanges } from "../stream.js";
import { executeSearchContextTarget, resolveDecompress } from "../decompress-shared.js";
import { fetchWithRetry, UpstreamHttpError } from "../fetch-util.js";
import { classifyUpstreamFailure, type UpstreamFailureKind } from "../upstream-fail.js";
import { formatUpstreamError, proxyDispatcher } from "../upstream-proxy.js";
import { warnCacheCollapse } from "../cache-warn.js";
import { dumpRejectedBody } from "../error-dump.js";
import { dumpsDir } from "../paths.js";
import { isStrictReasoningEcho, modelIdOf, normalizeStrictEchoBody } from "../strict-echo.js";
import { log as loggerLog } from "../logger.js";
import { promptInputTotal, type WireProtocol } from "../util.js";
import { DEGENERATE_RETRY_NUDGE } from "../degenerate-retry.js";
import { safePrefix, safeSuffix } from "../text-safe.js";

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
        return `\n${icon} [ACP] acp_status result:\n${result.trim()}\n`;
    }

    const inner = (lines[0] ?? "").replace(/^\[/, "").replace(/\]$/, "").trim();
    return `\n${icon} [ACP] ${inner}\n`;
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

// Canonical args for repeat-detection: key-order/whitespace differences must not
// defeat an identical-call match, so parse + re-stringify with sorted keys.
function canonicalArgs(args: string): string {
    try {
        return JSON.stringify(sortKeys(JSON.parse(args)));
    } catch {
        return args;
    }
}

function sortKeys(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
        const src = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
        return out;
    }
    return v;
}

export interface LoopCtx {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    /** View handed to applyCompression (see RewriteCtx.compressMessages). */
    compressMessages?: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
    proxyUrl?: string;
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
}

export interface RequestOptions {
    url: string;
    headers: Record<string, string>;
    /** Final-stage wire transform (e.g. compat.roles role rewrite, #552).
     *  Applied to every outgoing body this loop re-sends — truncation retry,
     *  degraded retry, rebuilt rounds — so re-sent bodies carry the same
     *  compat the initial forward() applied. Returns the body to serialize. */
    wireTransform?: (body: Record<string, unknown>) => Record<string, unknown>;
}

export type ParsedStreamEvent =
    | { kind: "text"; delta: string; raw?: Buffer }
    | { kind: "reasoning"; delta: string; raw?: Buffer; signature?: string; blockEnd?: boolean }
    | { kind: "tool_call"; name: string; callId: string; arguments: string; passthrough?: boolean; signature?: string }
    | { kind: "usage"; inputTokens?: number; outputTokens?: number; cachedTokens?: number; creationTokens?: number }
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
    | { kind: "meta"; chunk: Buffer; firstRoundOnly?: boolean; stateless?: boolean };

export interface EmitCompletionOpts {
    finishReason?: string;
    usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; creationTokens?: number };
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
}

export function executeProxyTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: LoopCtx,
    callId?: string,
    rawArguments?: string,
): string {
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
    if (imageCompressionEnabled(ctx.session) && toolName === IMAGE_FULL_TOOL_NAME) {
        return executeImageFull(args, ctx.session, ctx.config, callId);
    }
    return `[Unknown proxy tool: ${toolName}]`;
}

function recordUsage(
    ctx: LoopCtx,
    usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; creationTokens?: number },
    round: number,
): void {
    const prompt = usage.inputTokens;
    const cached = usage.cachedTokens;
    const out = usage.outputTokens;
    // #1536: normalize undefined (provider reports no cache tokens) to null so
    // the ledger quarantines the sample instead of booking its whole billed
    // prefix as an unexplained ttlRepay residual (which reads as a 0% hit rate).
    const reportedCached: number | null = typeof cached === "number" ? cached : null;
    const total = promptInputTotal(ctx.protocol, prompt, cached, usage.creationTokens);
    if (typeof out === "number") ctx.session.stats.outputTokens += out;
    const hitPct =
        reportedCached !== null && total > 0 ? Math.round((reportedCached / total) * 100) : 0;
    if (reportedCached !== null) warnCacheCollapse(ctx.session, total, reportedCached);
    const foldNew = ctx.session.stats.pendingFoldUsage === true;
    if (foldNew) ctx.session.stats.pendingFoldUsage = false;
    ctx.log(
        `[acp-usage] round ${round} input=${total} ${reportedCached !== null ? `cached=${reportedCached} (cache hit ${hitPct}%)` : "(no cache report)"}${foldNew ? " fold=new" : ""}${total <= 0 ? " (zero-total: lastInputTokens kept)" : ""}${imageUsageSuffix(ctx.session)}`,
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

    const fetchUpstream = (body: Record<string, unknown>) => {
        // #1592-family seam forensics: remember the body actually sent so the
        // next usage settle can pair it with the previous one (LCP on miss).
        noteForwardedBody(ctx.session, JSON.stringify(requestOptions.wireTransform ? requestOptions.wireTransform(body) : body));
        return fetchWithRetry(
            requestOptions.url,
            {
                method: "POST",
                headers: requestOptions.headers,
                body: JSON.stringify(requestOptions.wireTransform ? requestOptions.wireTransform(body) : body),
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
        const body = respResult.response.body as ReadableStream<Uint8Array>;
        if (activeClearTimer) activeClearTimer();
        activeClearTimer = respResult.clearTimer;
        if (ctx.dumpSse && body) {
            loopFetchSeq += 1;
            const sid = (ctx.session.id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
            const [read, dump] = body.tee();
            try {
                ctx.dumpSse(`${Date.now()}-${sid}-loop${loopFetchSeq}-raw.sse`, dump);
            } catch { /* best-effort */ }
            return read;
        }
        return body;
    };

    // #156: compress/decompress calls already failed this loop. Validation is
    // deterministic (identical args → identical failure), so a byte-identical
    // re-submission can never succeed — break early instead of at MAX_LOOP_ROUNDS.
    const failedSignatures = new Set<string>();

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

    try {
        for (let round = 1; round <= MAX_LOOP_ROUNDS; round++) {
            if (signal?.aborted) break;
            let assistantText = "";
            let assistantReasoning = "";
            const reasoningSegments: { text: string; signature: string }[] = [];
            let reasoningSealed = true;
            const calls: ToolCallEmit[] = [];
            let usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; creationTokens?: number } = {};
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
            let fwdBytes = 0;
            const fwd = (chunk: Buffer, visible = false, stateless = false): Buffer => {
                fwdBytes += chunk.length;
                if (!stateless) forwardedFraming = true;
                if (visible) forwardedVisible = true;
                return chunk;
            };

            for (;;) {
                assistantText = "";
                assistantReasoning = "";
                reasoningSegments.length = 0;
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
                fwdBytes = 0;

                for await (const ev of adapter.parseStream(currentUpstream, round)) {
                    if (signal?.aborted) break;
                    if (ev.kind === "text") {
                        assistantText += ev.delta;
                        if (!ctx.textProtocol && ev.raw) {
                            yield fwd(ev.raw, true);
                        } else if (!ctx.textProtocol && round > 1 && ev.delta.length > 0) {
                            yield fwd(adapter.emitText(ev.delta), true);
                        }
                    } else if (ev.kind === "reasoning") {
                        assistantReasoning += ev.delta;
                        let seg = reasoningSegments[reasoningSegments.length - 1];
                        if (reasoningSealed || !seg) {
                            seg = { text: "", signature: "" };
                            reasoningSegments.push(seg);
                            reasoningSealed = false;
                        }
                        seg.text += ev.delta;
                        if (ev.signature) seg.signature += ev.signature;
                        if (ev.blockEnd) reasoningSealed = true;
                        if (!ctx.textProtocol) {
                            if (ev.raw) {
                                yield fwd(ev.raw);
                            } else if (round > 1 && ev.delta.length > 0 && adapter.emitReasoning) {
                                yield fwd(adapter.emitReasoning(ev.delta));
                            }
                        }
                    } else if (ev.kind === "tool_call") {
                        calls.push({ name: ev.name, callId: ev.callId, arguments: ev.arguments, passthrough: ev.passthrough, signature: ev.signature });
                    } else if (ev.kind === "usage") {
                        usage = {
                            inputTokens: ev.inputTokens,
                            outputTokens: ev.outputTokens,
                            cachedTokens: ev.cachedTokens,
                            creationTokens: ev.creationTokens,
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
                        if (round === 1 || !ev.firstRoundOnly) {
                            yield fwd(ev.chunk, false, ev.stateless === true);
                        }
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
                //     content_block_start survives. responses/google keep shape (a) only:
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
                    !truncationRetried
                ) {
                    truncationRetried = true;
                    ctx.log(`[acp-loop] round ${round}: upstream truncated with no visible output reaching the client; retrying fetch once`);
                    try {
                        const respResult = await fetchUpstream(roundBody);
                        if (!respResult.response.body) {
                            respResult.clearTimer();
                            throw new UpstreamHttpError(respResult.response.status, "(empty response body)", 1);
                        }
                        currentUpstream = adoptUpstream(respResult);
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
                    !continuationRetried
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
                        const retryBody = withStrictEchoRepair(adapter.buildRequest([...coreMessages, nudge], systemPrompt, requestBody));
                        const respResult = await fetchUpstream(retryBody);
                        if (!respResult.response.body) {
                            respResult.clearTimer();
                            throw new UpstreamHttpError(respResult.response.status, "(empty response body)", 1);
                        }
                        currentUpstream = adoptUpstream(respResult);
                        roundBody = retryBody;
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
                        const retryBody = withStrictEchoRepair(adapter.buildRequest([...coreMessages, nudge], systemPrompt, requestBody));
                        const respResult = await fetchUpstream(retryBody);
                        if (!respResult.response.body) {
                            respResult.clearTimer();
                            throw new UpstreamHttpError(respResult.response.status, "(empty response body)", 1);
                        }
                        currentUpstream = adoptUpstream(respResult);
                        roundBody = retryBody;
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
            const proxyResults: { name: string; callId: string; result: string; arguments: string; signature?: string }[] = [];

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
                        ctx.log(`[acp-loop] proxy tool ${call.name}: arguments not parseable JSON (len=${call.arguments.length}${call.arguments.length > 0 ? `, head=${safePrefix(call.arguments, 200)}, tail=${safeSuffix(call.arguments, 200)}` : ""}) — ${call.name === COMPRESS_TOOL_NAME ? "routing the raw string to the lenient parser" : "executing with {}"}`);
                        rawArgs = call.arguments;
                        parsedArgs = {};
                    }
                    const result = await withSessionLock(ctx.session, () => executeProxyTool(call.name, parsedArgs, ctx, call.callId, rawArgs));
                    proxyResults.push({ name: call.name, callId: call.callId, result, arguments: call.arguments, signature: call.signature });
                    if (ctx.visibilityMarkers !== false) {
                        const markerKey = `${call.name}\u0000${result}`;
                        if (seenMarkers.has(markerKey)) {
                            ctx.log(`[acp-loop] suppressed duplicate ${call.name} status marker (identical failure repeated this request)`);
                        } else {
                            seenMarkers.add(markerKey);
                            yield adapter.emitMarker(call.name, result);
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
                if (reasoningSegments.length > 0) {
                    for (let i = 0; i < reasoningSegments.length; i++) {
                        const seg = reasoningSegments[i];
                        if (seg.text.length === 0 || (requiresThinkingSignature && seg.signature.length === 0)) continue;
                        const reasoningMsg: BiliMessage = {
                            id: i === 0 ? `acp_loop_r${round}_reasoning` : `acp_loop_r${round}_reasoning_${i + 1}`,
                            role: "assistant",
                            contentType: "reasoning",
                            text: seg.text,
                            reasoningContent: seg.text,
                            ...(seg.signature.length > 0
                                ? ctx.protocol === "google"
                                    ? { googleThoughtSignature: seg.signature }
                                    : { thinkingSignature: seg.signature }
                                : {}),
                        };
                        coreMessages.push(reasoningMsg);
                    }
                }
                if (assistantText.length > 0) {
                    coreMessages.push({
                        id: `acp_loop_r${round}_asst`,
                        role: "assistant",
                        contentType: "text",
                        text: assistantText,
                    });
                }
                for (const pr of proxyResults) {
                    if (functionCallIds.has(pr.callId)) {
                        coreMessages.push({
                            id: `acp_loop_r${round}_asst_tc_${pr.callId}`,
                            role: "assistant",
                            contentType: "tool-call",
                            toolName: pr.name,
                            toolCallId: pr.callId,
                            text: pr.arguments,
                            ...(ctx.protocol === "google" && pr.signature ? { googleThoughtSignature: pr.signature } : {}),
                        });
                        coreMessages.push({
                            id: `acp_loop_r${round}_tool_${pr.callId}`,
                            role: "tool",
                            contentType: "tool-result",
                            toolName: pr.name,
                            toolCallId: pr.callId,
                            text: pr.result,
                        });
                    } else if (ctx.visibilityMarkers !== false) {
                        coreMessages.push({
                            id: `acp_loop_r${round}_marker_${pr.callId}`,
                            role: "system",
                            contentType: "text",
                            text: buildVisibilityMarker(pr.name, pr.result),
                        });
                    }
                }
                // #1097: retrieval injections ride the same re-request channel
                // as the ack pairs above — ack first, full text second. Their
                // ids (acp_retrieved_*) are structurally excluded from ref
                // assignment, so they never consume message numbers.
                for (const injection of drainPendingRetrievals(ctx.session)) {
                    coreMessages.push(injection);
                }
                const anyCompressFailed = proxyResults.some(
                    (pr) => (pr.name === "compress" || pr.name === "decompress") && pr.result.includes("FAILED"),
                );
                if (!ctx.textProtocol && !anyCompressFailed) {
                    const hidden = hideConsumedCompressCalls(ctx.session.state, coreMessages);
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

            // #156: if this round is only failed compress/decompress and one of
            // them re-submits args that already failed, the model is stuck in a
            // deterministic failure loop — break early instead of burning rounds.
            const failedMutating = proxyResults.filter(
                (pr) => (pr.name === "compress" || pr.name === "decompress") && pr.result.includes("FAILED"),
            );
            if (reRequest && failedMutating.length > 0 && failedMutating.length === proxyResults.length) {
                const repeated = failedMutating.some((pr) => failedSignatures.has(`${pr.name}\u0000${canonicalArgs(pr.arguments)}`));
                if (repeated) {
                    ctx.log(`[acp-loop] round ${round}: model re-submitted an already-failed compress with identical arguments; stopping after ${round} round(s) instead of ${MAX_LOOP_ROUNDS}`);
                    loggerLog("warn", `[acp-loop] repeated identical compress failure at round ${round}; breaking early (#156)`);
                    yield adapter.emitCompletion({ finishReason: "length", usage, terminalExtra });
                    return;
                }
            }
            for (const pr of failedMutating) failedSignatures.add(`${pr.name}\u0000${canonicalArgs(pr.arguments)}`);

            ctx.log(`[acp-loop] round ${round}: proxy tool executed; re-requesting so the model sees the result`);

            if (signal?.aborted) break;

            let newBody = withStrictEchoRepair(adapter.buildRequest(coreMessages, systemPrompt, requestBody));
            if (process.env.ACP_DUMP_BODY === "1") {
                try {
                    const fs = await import("node:fs");
                    const path = await import("node:path");
                    const dumpDir = dumpsDir();
                    fs.mkdirSync(dumpDir, { recursive: true });
                    const sid = (ctx.session.id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
                    fs.writeFileSync(path.join(dumpDir, `req-${Date.now()}-${sid}-REREQUEST.json`), JSON.stringify(newBody, null, 2));
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
                    newBody = withStrictEchoRepair(adapter.buildRequest(coreMessages, systemPrompt, requestBody));
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
                        loggerLog("error", `[acp-loop] re-request transport failure after ${round} round(s): ${formatUpstreamError(e, requestOptions.url, ctx.proxyUrl)}`);
                        yield adapter.emitError(msg);
                        return;
                    }
                    throw e;
                }
                // #684 learn-on-failure: a 400 mentioning reasoning_content on
                // a thinking session is the split-turn signature — remember it
                // on the session so #651's reasoning-drop never fires here
                // again (kernel gate prevents the split; this closes the loop).
                if (
                    e.status === 400 &&
                    /reasoning_content/i.test(e.body) &&
                    ctx.session.metadata.strictReasoningEcho !== true
                ) {
                    ctx.session.metadata.strictReasoningEcho = true;
                    ctx.log(`[acp-loop] 400 mentions reasoning_content — learned strict reasoning echo for this session; #651 reasoning-drop disabled (#684)`);
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
        if (activeClearTimer) {
            activeClearTimer();
            activeClearTimer = null;
        }
    }
}
