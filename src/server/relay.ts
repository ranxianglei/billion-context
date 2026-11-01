import { fetchWithCodexCatalogCache, isCodexCatalogRequest } from "./codex-catalog-cache.js";
import { createHandoffReply, captureHandoffJson } from "./handoff-response.js";
import { checkOutboundBody, OutboundBodyTooLargeError } from "../request-body-budget.js";
import { maybeRunInvariantJudge } from "../invariant-judge.js";
// #1440 P2 cut 4: upstream relay zone (forward) extracted verbatim from src/server.ts — pure move, zero behavior change.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { type CompressionCore, type Config, type CoreMessage, defaultCountTokens, defaultPrompts, resolveOutputSteeringConfig } from "acp-kernel";
import { type BiliMessage } from "acp-kernel/wire";
import { absorbToolName, applyAbsorbView } from "../absorb.js";
import { APIG_RESIGN_SCHEME, resignApig } from "../apig-resign.js";
import { noteSuccessfulForward } from "../cache-keepalive.js";
import { credentialFingerprint, generationParamFp, noteClientAbort, noteForwardedBody, noteForwardedImageFacts, noteInboundMessages, noteOutboundContextEstimates, settleOverflowCalibration, settleUsageReport, withCacheCapture } from "../cache-ledger.js";
import { warnCacheCollapse } from "../cache-warn.js";
import { stampOutbound } from "../chain-checkpoint.js";
import { applyCompatDropFields, dropCompatFieldsJson, resolveCompatDropFields } from "../compat-drop.js";
import { applyCompatRoles, applyCompatRolesJson, detectRoleRejection, detectSystemPlacementError, hasOffHeadSystem, resolveCompatRoles, type CompatRoles } from "../compat-roles.js";
import { compressLoopResponsesJson } from "../compress-loop-responses.js";
import { resolveCompress } from "../compress-settings.js";
import { buildAbsorbSystemPrompt, buildCompressHybridSystemPrompt, buildCompressSystemPrompt, withMarkerIntegrityNote, withMcpDialectNote, withProjectAttribution, withSummaryBudgetNote } from "../compress-tool.js";
import { detectGenerationBoundary, GENERATION_BOUNDARY_NOTE } from "../generation-boundary.js";
import { findRoute, resolveDeclaredProtocol, type ProxyOptions } from "../config.js";
import { makeContinuationRefetch } from "../degenerate-retry.js";
import { dumpRejectedBody } from "../error-dump.js";
import { extractWsOversizeError, formatMiB, shedEgressIfOverBudget, shedWireImages, shedWireImagesToCount, type ShedStats } from "../egress-shed.js";
import { conversationPromptSections, externalSummaryEnabled, messageTimestampSections } from "../external-summary-surface.js";
import { fakeBufCap, injectFakeCompletionHint, isFakeCompletion, maxFakeCompletionRetries } from "../fake-completion.js";
import { fetchWithTimeout, fetchWithTransportRetry } from "../fetch-util.js";
import { currentFetchTransport } from "../fetch-transport.js";
import { refForItemBytes } from "../image-rescale.js";
import { countImagesInParsedBody, countImagesInRawBody, upstreamHost } from "../image-tokens.js";
import { log as loggerLog } from "../logger.js";
import { dumpReqAllowed as knobDumpReqAllowed, limitsWsOutboundBytes, rawDumpDir as knobRawDumpDir } from "../knobs.js";
import { gcDumpDirIfConfigured } from "../state-gc.js";
import { applyLaneCredential, laneCredential } from "../lane-credentials.js";
import { CREDENTIAL_HEADER_RE, maskHeaderForLog, maskHeadersForLog, maskHostPortForDisplay, maskUrlForLog } from "../log-mask.js";
import { pickAdapter, runCompressLoop } from "../loop/index.js";
import { ABSORB_INSTRUCTION_MARKER, containsToolCallXmlFragment } from "../loop/tag-echo-filter.js";
import { dumpsDir } from "../paths.js";
import { noteKnownAttachmentIds } from "../phantom-attachment.js";
import { pipePluginChatWithStrip, pipePluginJson, pipePluginResponsesWithStrip, type UpstreamMeta } from "../plugin.js";
import { describeCoreTextDuplication, estimateCoreMessages, estimateCoreMessagesUpperBytes } from "../preflight.js";
import { reasoningGuardEngages, runReasoningGuard } from "../reasoning-guard.js";
import { wrapStreamWithRunawayGuard } from "../runaway-guard.js";
import { diagnoseSuccessWithoutUsage, markDirty, markNativeCompactionBoundary, withSessionLock, type Session } from "../session.js";
import { adoptContentStore, ccrLoopConfig, commitRetrievalNotes, commitRetrievals, contentStoreOf, dropRetrievals } from "../store.js";
import { emitStreamError } from "../stream-error.js";
import { rewriteGoogleJsonResponseAsync } from "../stream-google.js";
import { v1UnwrapStream, wrapV1Internal, wrapV1ResponseJson, wrapV1SseFrame } from "../v1internal.js";
import { rewriteOpenaiJsonResponseAsync } from "../stream-openai.js";
import { rewriteResponsesJsonResponseAsync } from "../stream-responses.js";
import { observeResponsesTerminalState } from "../stream-terminal.js";
import { rewriteJsonResponseAsync, type RewriteCtx } from "../stream.js";
import { safePrefix, safeSuffix, scrubLoneSurrogatesOnWire } from "../text-safe.js";
import { clearUpstreamAlertsForHost, noteCircuitFailFastLog, recordUpstreamAlert, recordUpstreamCircuitFailure, recordUpstreamCircuitSuccess, upstreamCircuitBlockReason, upstreamCircuitLastFailureKind, upstreamCircuitRetryAfterSeconds } from "../upstream-alerts.js";
import { describeUpstreamFailure, formatUpstreamError, proxyDispatcher, recordUpstreamConnection } from "../upstream-proxy.js";
import { markExpectedFailFast, withUpstreamFailure, type UpstreamFailureKind } from "../upstream-fail.js";
import { noteUpstreamThrottle429, noteUpstreamThrottleResolved, upstreamThrottleLocalReject } from "../upstream-throttle.js";
import { applyEstimateCalibration, currentCalibrationFactor, inspectContextOverflow, isMarkerlessOverflowReject, MIN_ASSUMED_WINDOW_TOKENS, normalizeUpstreamOrigin, usageOutputTotal, usageTotals, type ContextOverflowInfo, type WireProtocol } from "../util.js";
import { billOutputUsage } from "../billing.js";
import { DUMP_PLAINTEXT_BANNER } from "../dump-banner.js";
import { recordPckAblation } from "../pck-probe.js";
import { applyOutputSteering, applyOutputSteeringJson } from "../output-steering.js";
import { estimateWireOverhead } from "./budget.js";
import { buildForwardHeaders, connectionNamedHeaders, RESPONSE_ONLY_STRIP_HEADERS, safeSessionId, UPSTREAM_HOP_HEADERS } from "./headers.js";
import { bodyDumpEnabled, logDumpFailure } from "./observability.js";
import { effectiveAbsorbBlock } from "./prepare-responses.js";
import { awaitDrain, bufferToStream, dumpStreamToFile, pipeThrough, readStreamToBuffer } from "./stream-io.js";
import { buildForwardTarget, outboundPayloadBreakdown, registerRequestAbort, beginStreamKeepalive, effectiveTokenCount, googlePathKind, imageBillingFor, imageTokenCapFor, inboundResignCredential, outboundContextEstimates, repairResponsesAssistantOrdering, resolveUpstream, stripKernelSummaries, usageGradeInputBaseline, DOOMED_PROBE_ABSOLUTE_BYTES, DOOMED_PROBE_BYTES_PER_TOKEN, type Prepared } from "../server.js";

/** Infer the wire protocol from the request path for compat-role rewrites on
 *  requests the pipeline did not prepare (passthrough). Mirrors the path
 *  checks in handleRequest; returns null when unknown (no rewrite). */
function inferWireProtocol(path: string): "openai" | "responses" | "google" | null {
    const p = path.split("?", 2)[0];
    if (p.endsWith("/chat/completions") || p.endsWith("/llm_raw_chat")) return "openai";
    if (p.endsWith("/responses") || p.endsWith("/responses/compact")) return "responses";
    if (googlePathKind(p) !== null) return "google";
    return null;
}

// #3129: wrap every SSE data frame written to a v1internal client into the
// {"response":...} envelope. Buffers blank-line-delimited frames across write()
// calls, rewrites only `data:` payloads carrying a JSON object ([DONE]/empty/
// non-JSON and event:/comment keep-alive lines pass through), preserves the
// write() backpressure boolean on flush, and flushes a trailing partial frame
// on end(). Installs over res.write/res.end only for v1 responses.
function installV1ResponseFramer(res: http.ServerResponse): void {
    let buf = "";
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    const flushFrames = (): string => {
        let out = "";
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
            out += wrapV1SseFrame(buf.slice(0, idx)) + "\n\n";
            buf = buf.slice(idx + 2);
        }
        return out;
    };
    const toStr = (c: unknown): string =>
        typeof c === "string" ? c : c == null ? "" : Buffer.isBuffer(c) ? c.toString("utf8") : Buffer.from(c as Uint8Array).toString("utf8");
    const pickCb = (a?: unknown, b?: unknown): (() => void) | undefined => {
        if (typeof a === "function") return a as () => void;
        if (typeof b === "function") return b as () => void;
        return undefined;
    };
    // A trailing chunk with no blank-line terminator is either an unterminated
    // SSE frame (has a data: line) or a whole non-streaming JSON body — wrap
    // accordingly so neither leaks to the client un-enveloped.
    const wrapChunk = (s: string): string =>
        /(^|\n)\s*data:/.test(s) ? wrapV1SseFrame(s) : wrapV1ResponseJson(s);
    res.write = ((chunk?: unknown, a?: unknown, b?: unknown): boolean => {
        const cb = pickCb(a, b);
        if (chunk == null) {
            if (cb) setImmediate(cb);
            return true;
        }
        buf += toStr(chunk);
        const s = flushFrames();
        if (s.length > 0) return origWrite(s, cb);
        if (cb) setImmediate(cb);
        return true;
    }) as typeof res.write;
    res.end = ((chunk?: unknown, a?: unknown, b?: unknown): http.ServerResponse => {
        const cb = pickCb(a, b);
        if (chunk != null) {
            buf += toStr(chunk);
            const s = flushFrames();
            if (s.length > 0) origWrite(s);
        }
        if (buf.trim().length > 0) {
            origWrite(wrapChunk(buf));
            buf = "";
        }
        return origEnd(cb);
    }) as typeof res.end;
}

/** #604/#1839: record an upstream failure that will never report usage
 *  (relay/gateway 5xx, network-level failure). #604 raises
 *  session.stats.lastInputTokens to a local estimate of the wire body so the
 *  next prepare() lands in the kernel's emergency band (truncate.threshold =
 *  0.95) and truncates large tool results server-side — the rescue that breaks
 *  the relay-5xx deadlock (#1493 refines the arm to the OUTBOUND payload size
 *  so fitting payloads don't over-trigger). The arm STAYS load-bearing:
 *  removing it re-deadlocks exactly those sessions.
 *  #1839: the arm stays ESTIMATE-grade and the ghost it once caused is killed
 *  at the reader, not by deleting the arm — while any usage-grade anchor
 *  exists, effectiveTokenCount's anchor branch prefers lastUsageGradeTokens
 *  over every estimate-grade value, so the arm can no longer reach the nudge
 *  denominator, the display or the preflight floors (pre-fix, one aborted turn
 *  armed 719521 against a real input of 143419 and the inflated denominator
 *  persisted ~23 min). Anchor-less sessions (fresh / silent backends) size on
 *  the per-turn min(localInputEstimate, raw) views, where the arm guarantees a
 *  near-window payload still crosses the emergency band on retry. The next
 *  real usage report overwrites it. */
function armFailureShrink(prepared: Prepared, log: (level: string, msg: string) => void, reason: string, est: number): void {
    const s = prepared.session;
    if (!Number.isFinite(est) || est <= 0) return;
    // An upstream-proven ceiling (overflow-arm) plus its route-origin evidence
    // must never be demoted by a local payload estimate: demoting it back to
    // "estimate" drops baselineFloorRaw below the probe threshold and re-fires
    // the forward-probe loop every turn (#2484). usage→estimate overwrite stays
    // the intended #604 behavior for generic failures with no overflow marker.
    if (s.stats.lastInputTokensSource === "overflow-arm") return;
    if (est > s.stats.lastInputTokens) {
        s.stats.lastInputTokens = est;
        s.stats.lastInputTokensSource = "estimate";
        // #3148: the armed state used to be visible only in this warn line —
        // record it on the session so acp_status can show it to the host/model.
        // Cleared by the next real usage report (settleUsageReport).
        s.stats.emergencyShrinkAt = Date.now();
        s.stats.emergencyShrinkEstimate = est;
        // The error path returns before forward()'s trailing markDirty — the
        // arm must schedule its OWN save or it is lost on restart.
        markDirty(s);
        log("warn", `[${s.id}] ${reason} with no usage report — armed emergency shrink with local estimate ${est} tokens`);
    }
}

/** #3701: user-visible diagnosis for an unrecoverable WS size rejection — names the
 *  exact bytes, why shedding could not fit, and the current budget for context.
 *  Deliberately does NOT suggest raising the budget: the gateway just proved it
 *  rejects this size, so a bigger budget would only send the fat frame again. */
function wsOversizeDiagnosis(sentBytes: number, stats: ShedStats | undefined, budget: number): string {
    const why = !stats || (!stats.archived && !stats.downscaled)
        ? "no sheddable images outside the protected recent messages"
        : `shedding removed ${formatMiB(Math.max(0, sentBytes - stats.finalBytes))} MiB but the remainder is protected recent content`;
    return `WS upstream rejected the ${formatMiB(sentBytes)} MiB request with close 1009 (zero events received) and the payload cannot be reduced further (${why}). Trim older images/history so the frame fits under the wire limit (current pre-send budget: ${budget > 0 ? `${formatMiB(budget)} MiB` : "disabled"} — network.wsOutboundBytes / BILI_WS_OUTBOUND_BYTES).`;
}

// #3434: upstream accepted the request then sent no bytes — the log shows
// nothing between `forward …` and the outcome (client disconnect / idle-watchdog
// abort), so an upstream stall reads as proxy-side. Arm a one-shot first-byte
// watchdog around the initial fetch: headers not arrived by the threshold → ONE
// warn naming target+method+lane. Additive logging only — deliberately NO
// fast-fail (would truncate long prefills, cf. #1706/#1714) and NO new config
// surface (code constant + test seam).
const UPSTREAM_FIRST_BYTE_WARN_MS = 30_000;
let firstByteWarnMs = UPSTREAM_FIRST_BYTE_WARN_MS;
export function _setFirstByteWarnMsForTest(ms?: number): void {
    firstByteWarnMs = ms ?? UPSTREAM_FIRST_BYTE_WARN_MS;
}
// Dedupe once per origin per process (windowSourceLogged pattern) so a
// long-prefill local model logs at most one line, not one per slow request.
// Claimed at FIRE time (not arm time) so a fast request never suppresses a
// later genuine stall on the same origin.
const firstByteWarnedOrigins = new Set<string>();
export function _resetFirstByteWarnedOriginsForTest(): void {
    firstByteWarnedOrigins.clear();
}
/**
 * #3434: arm a one-shot watchdog logging ONE warn if the fetch behind `signal`
 * is still pending after `firstByteWarnMs`. Returns the timer handle (the caller
 * clears it when the fetch settles) or undefined when disarmed (threshold
 * disabled, origin already warned, or signal already aborted).
 */
export function armFirstByteWatchdog(o: {
    url: string;
    method: string;
    lane: string;
    sessionId: string;
    log: (level: string, msg: string) => void;
    signal: AbortSignal;
}): ReturnType<typeof setTimeout> | undefined {
    const threshold = firstByteWarnMs;
    if (!Number.isFinite(threshold) || threshold <= 0) return undefined;
    let origin: string;
    try {
        origin = new URL(o.url).origin;
    } catch {
        origin = o.url;
    }
    if (firstByteWarnedOrigins.has(origin)) return undefined;
    if (o.signal.aborted) return undefined;
    const seconds = Math.round(threshold / 1000);
    const fire = (): void => {
        // First-to-fire claims the origin; concurrent same-origin timers stay silent.
        if (firstByteWarnedOrigins.has(origin)) return;
        firstByteWarnedOrigins.add(origin);
        o.log("warn", `[${o.sessionId}] upstream awaiting first byte ≥${seconds}s: ${o.method} ${maskUrlForLog(o.url)} (lane=${o.lane})`);
    };
    const timer = setTimeout(fire, threshold);
    timer.unref();
    o.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    return timer;
}

export function forward(...args: Parameters<typeof forwardCaptured>): Promise<void> {
    return withCacheCapture(args[4]?.session, () => forwardCaptured(...args));
}

async function forwardCaptured(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts: ProxyOptions,
    body: Buffer | string,
    prepared: Prepared | null,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
    route: ReturnType<typeof resolveUpstream>,
    instanceId: string,
    affinity?: string,
    overflowRefold?: (realWindow: number | undefined) => Promise<{ body: string | Buffer; prepared: Prepared | null } | null>,
    v1Meta?: Record<string, unknown>,
): Promise<void> {
    const forwardStartedAt = Date.now();
    const reply = prepared && !prepared.sidePassthrough ? createHandoffReply(prepared.session, () => !res.destroyed) : undefined;
    // E2: a codex native-compaction request intercepted in prepare() carries a
    // forged success response — serve it without contacting upstream.
    if (prepared?.codexForge) {
        log("info", `[${prepared.session.id}] codex compact served locally (${prepared.codexForge.kind}); upstream not contacted`);
        if (!res.headersSent) res.writeHead(200, { "content-type": prepared.codexForge.contentType });
        res.end(prepared.codexForge.body);
        return;
    }
    // #2740: auto-mode classifier one-shots are answered locally — same
    // zero-egress contract as codexForge; the audit line was written in
    // prepare (this line is the egress-proof for the serve itself).
    if (prepared?.autoModeForge) {
        log("info", `[${prepared.session.id}] auto-mode classifier served locally (${prepared.autoModeForge.variant}); upstream not contacted`);
        if (!res.headersSent) res.writeHead(200, { "content-type": prepared.autoModeForge.contentType });
        res.end(prepared.autoModeForge.body);
        return;
    }
    // #300: stamp the chain marker ONLY when this instance actually processed
    // the request (prepared !== null). A passthrough forward (prepared === null)
    // must NOT claim processing — otherwise a downstream processing bili would
    // wrongly skip and the user loses compression. When prepared is null any
    // inbound marker (from an upstream bili) is preserved verbatim by
    // buildForwardTarget, so the marker keeps propagating down the chain.
    // #552: optional wire-compat role rewrite at the FINAL forward boundary —
    // the only choke point that sees every emission site (client items,
    // bili's injected compress prompt, instructions hoisting, compress-loop
    // items). Opt-in via compat.roles (global + per-provider); empty map =
    // byte-for-byte passthrough.
    let wireBody: Buffer | string = body;
    // #552 resolved compat map + protocol, shared with the compress-retry
    // loops below (re-sent bodies must carry the same rewrite as the initial
    // forward, or a developer-role 400 would hit mid-stream on retry).
    let compatRoles: CompatRoles | null = null;
    let compatProtocol: "openai" | "responses" | null = null;
    // #1757 resolved drop list, shared with wireTransform below (re-sent
    // compress-retry bodies must carry the same drops as the initial forward).
    let compatDropPaths: string[] = [];
    const { upstreamUrl, headers, proxyUrl, skippedProxy } = buildForwardTarget(req, opts, route, affinity, prepared !== null ? instanceId : undefined);
    // #3129: v1internal egress re-wrap — every outbound model body (initial send,
    // role-ladder retry, overflow refold, compress-loop round 2+) must go back to
    // Antigravity inside the CloudCode envelope it arrived in. String-level for
    // the direct fetch sites; object-level via wireTransform below for loop re-sends.
    const v1Active = v1Meta !== undefined && prepared !== null;
    const v1Wrap = (b: string | Buffer): string | Buffer => {
        if (!v1Active || typeof b !== "string") return b;
        try {
            return JSON.stringify(wrapV1Internal(JSON.parse(b) as Record<string, unknown>, v1Meta));
        } catch {
            return b;
        }
    };
    // #3280: in v1internal traffic `body` here is ALREADY the standard inner
    // request — handle.ts unwrapped the envelope before prepare*, and prepared.body
    // (the rebuilt inner) is what forward() ships. The retry paths below mutate
    // that inner body directly, so their egress must be re-nested into the
    // CloudCode envelope via v1Wrap.
    // #1884 re-sign arm: the native lane tunneled this request with the
    // signing credential (x-bili-resign markers — stripped in
    // buildForwardTarget, they must never reach the upstream). Every egress
    // body below — initial send, role-ladder retry, overflow refold,
    // compress-loop rounds, degenerate continuation refetch — is re-signed
    // just before it hits the wire, so the rewritten body and the signature
    // always agree. A failed re-sign logs and sends the previous signature:
    // the upstream's 401 stays visible instead of a synthetic bili error.
    const resignCtx = inboundResignCredential(req.headers, opts, upstreamUrl);
    if (resignCtx !== undefined) {
        log("info", `[${prepared?.session.id ?? "passthrough"}] [resign] re-sign arm active (${APIG_RESIGN_SCHEME}) — every egress body is re-signed (#1884)`);
    }
    // #2336 lane credential override: providers[URL].apiKeyEnv/credentialRef
    // replaces the client's credential with the lane's own key. Applied ONCE
    // to the shared `headers` record (every egress below reuses it), and
    // skipped when the re-sign arm is active — the re-signer owns
    // Authorization there. Resolution failures keep the client's headers
    // (warned once per route+reference inside laneCredential).
    if (resignCtx === undefined) {
        const laneCred = laneCredential(opts.routes, upstreamUrl, (message) => log("warn", `[${prepared?.session.id ?? "passthrough"}] ${message}`));
        if (laneCred !== undefined) {
            applyLaneCredential(headers, laneCred, (message) => log("warn", `[${prepared?.session.id ?? "passthrough"}] ${message}`));
            log("debug", `[${prepared?.session.id ?? "passthrough"}] [lane-credential] applied ${laneCred.reference} for ${maskUrlForLog(upstreamUrl)} (#2336)`);
        }
    }
    const applyResign = (hdrs: Record<string, string>, bodyStr: string | Buffer): void => {
        if (resignCtx === undefined || req.method === "GET" || req.method === "HEAD") return;
        try {
            resignApig(hdrs, resignCtx, req.method ?? "POST", upstreamUrl, bodyStr, findRoute(opts.routes, upstreamUrl));
        } catch (err) {
            log("warn", `[${prepared?.session.id ?? "passthrough"}] [resign] re-sign failed; sending the previous signature: ${String(err)}`);
        }
    };
    // #1093 output-side compression: resolve through the standard three-level
    // compress cascade (global → provider); default off = byte-for-byte passthrough.
    // The kernel decides (turn kind / verbosity / lower-effort); bili only lands it.
    // Resolved at provider granularity — verbosity/effort routing isn't model-specific
    // and extracting a model across all four wires here is disproportionate.
    const steerRaw = resolveCompress(opts.routes, upstreamUrl, undefined, opts.compress).outputSteering;
    const steerResolved = steerRaw !== undefined ? resolveOutputSteeringConfig(steerRaw) : null;
    const steerCfg = steerResolved?.config ?? null;
    for (const w of steerResolved?.warnings ?? []) log("warn", `[${prepared?.session.id ?? "passthrough"}] [output-steering] ${w}`);
    let steerProtocol: WireProtocol | null = null;
    if (typeof body === "string") {
        // upstreamUrl (the real destination) — not route?.rewrittenUrl, which
        // is undefined for zero-config requests and would skip provider compat.
        const configured = resolveCompatRoles(opts.routes, upstreamUrl, opts.compat?.roles);
        // #552 learn-on-failure: roles this session learned from a role-
        // rejection 400 overlay the configured map (empirical wins per key),
        // so later requests skip the 400 round-trip. Session-scoped only —
        // config stays user-owned.
        const learned = (prepared?.session.metadata.learnedCompatRoles as CompatRoles | undefined) ?? {};
        const roles = { ...configured, ...learned };
        const protocol = prepared?.protocol ?? route?.explicitProtocol ?? resolveDeclaredProtocol(opts.routes, upstreamUrl) ?? inferWireProtocol(req.url ?? "");
        // compatProtocol is armed even with zero roles: the learn-on-failure
        // retry below needs it, and roles may be learned mid-request.
        if (protocol === "openai" || protocol === "responses") {
            compatProtocol = protocol;
            if (Object.keys(roles).length > 0) {
                compatRoles = roles;
                const applied = applyCompatRoles(body, protocol, roles);
                if (applied.rewritten > 0) {
                    wireBody = applied.body;
                    log("info", `[${prepared?.session.id ?? "passthrough"}] [compat] rewrote ${applied.rewritten} message role(s) per compat.roles (${Object.entries(roles).map(([f, t]) => `${f}→${t}`).join(",")})`);
                }
            }
        }
        // #1093 land output-side compression AFTER every other body mutation (compat
        // above) so the turn classifier sees the final message list. All wires, not
        // just the compat pair; idempotent, byte-identical when nothing changes.
        steerProtocol = protocol;
        if (steerCfg && steerCfg.enabled && typeof wireBody === "string") {
            const applied = applyOutputSteering(wireBody, protocol, steerCfg);
            if (applied.changed) {
                wireBody = applied.body;
                log("info", `[${prepared?.session.id ?? "passthrough"}] [output-steering] applied (${applied.labels.join(", ")})`);
            }
        }
        // #1757: compat.dropFields — AFTER every other body mutation (roles,
        // output steering) so the final shape carries the drops, BEFORE the
        // #1421 outbound stamp whose digest must cover the exact forwarded
        // bytes. Protocol-neutral (any JSON-object body), unlike the role
        // rewrite above which is openai/responses-only.
        compatDropPaths = resolveCompatDropFields(opts.routes, upstreamUrl, opts.compat?.dropFields);
        if (compatDropPaths.length > 0 && typeof wireBody === "string") {
            const applied = applyCompatDropFields(wireBody, compatDropPaths);
            if (applied.dropped > 0) {
                wireBody = applied.body;
                log("info", `[${prepared?.session.id ?? "passthrough"}] [compat] dropped ${applied.dropped} field(s) per compat.dropFields (${compatDropPaths.join(", ")}) (#1757)`);
            }
        }
    }
    // #1421/#1683: outbound chain checkpoint — when egress stamping is enabled
    // (chainEgressStamp, DEFAULT OFF), every request THIS instance actually
    // processed leaves with a request-level stamp, so a downstream bili applies
    // first-processor-wins even when x-bili-hop was stripped in transit. The
    // carrier is model-visible (insertCheckpointCarrier), which is why this is
    // opt-in: models read it as phantom user input and burn tokens on it. Lands
    // AFTER compat roles + output steering: the digest must cover the exact
    // bytes forwarded. Best-effort — a stamp failure never breaks the forward.
    // Passthrough/side/forge/classifier forwards carry no stamp: only a real
    // kernel pass (processedMessages non-empty — side/classifier Prepareds are
    // empty) claims processing, per the first-processor-wins contract. Inbound
    // recognition + hop passthrough are unaffected by this switch.
    if (prepared && !prepared.sidePassthrough && prepared.processedMessages.length > 0 && typeof wireBody === "string" && opts.chainEgressStamp === true) {
        try {
            const stamped = stampOutbound(JSON.parse(wireBody), prepared.protocol, instanceId);
            if (stamped !== null) {
                wireBody = JSON.stringify(stamped);
                log("debug", `[${prepared.session.id}] [stamp] outbound ${prepared.protocol} request carries checkpoint carrier`);
            }
        } catch (err) {
            log("debug", `[${prepared.session.id}] [chain] outbound stamping failed (${String(err)}); forwarding unstamped`);
        }
    }
    if (res.destroyed || res.writableEnded) return;
    // #552: wire transform shared by ALL re-send paths (compress-retry loops
    // below) so re-sent bodies carry the same rewrite as the initial forward —
    // otherwise a developer-role 400 would hit mid-stream on the first retry.
    // Reads compatRoles at CALL time: a role learned mid-request (retry below)
    // applies to later re-sends within the same request.
    const wireTransform = compatProtocol || (steerCfg !== null && steerCfg.enabled) || compatDropPaths.length > 0 || v1Active
        ? (b: Record<string, unknown>): Record<string, unknown> => {
            if (compatProtocol && compatRoles) applyCompatRolesJson(b, compatProtocol, compatRoles);
            if (steerCfg && steerCfg.enabled && steerProtocol) applyOutputSteeringJson(b, steerProtocol, steerCfg);
            if (compatDropPaths.length > 0) dropCompatFieldsJson(b, compatDropPaths);
            // #3129: re-nest the rebuilt inner request into the CloudCode envelope.
            return v1Active ? wrapV1Internal(b, v1Meta) : b;
        }
        : undefined;
    // Show the final proxied URL (where the request actually lands) as the
    // primary signal. The provider label is appended only for named routes —
    // zero-config requests have a single routing mode now, so the final
    // proxied URL is the only useful signal in the log.
    log("info", currentFetchTransport()
        ? `forward WS → ${maskUrlForLog(upstreamUrl.replace(/^http/, "ws"))}`
        : `forward ${req.method} → ${maskUrlForLog(upstreamUrl)}`);
    if (opts.debug && prepared) {
        const sid = prepared.session.id;
        const hdrKeys = Object.keys(req.headers);
        log("info", `[${sid}] client headers: ${hdrKeys.join(",")}`);
        for (const k of ["authorization", "x-api-key", "x-session-id", "x-session-affinity", "x-acp-session", "x-opencode-session", "prompt-cache-key", "anthropic-beta"]) {
            const v = req.headers[k] ?? req.headers[k.toLowerCase()];
            if (v) {
                const s = Array.isArray(v) ? v.join(",") : String(v);
                // Mask all but a short prefix so the header NAME is visible
                // (so we know the key is sent and roughly how) without leaking
                // the credential into the log.
                const masked = CREDENTIAL_HEADER_RE.test(k) ? safePrefix(s, 8) + "..." + safeSuffix(s, 4) + ` (${s.length} chars)` : safePrefix(s, 60);
                log("info", `[${sid}] client hdr ${k}=${masked}`);
            }
        }
    }
    // #2421: passthrough/side lanes forward Buffer bodies — normalize once so
    // they get the same dumps/ structured view as the string lane; non-JSON
    // payloads still fall out of the parse below (unchanged behavior).
    if (opts.debug || bodyDumpEnabled()) {
        const wireText = typeof wireBody === "string" ? wireBody : wireBody.toString("utf8");
        try {
            const parsed = JSON.parse(wireText);
            if (opts.debug) {
                const toolNames = (parsed.tools ?? []).map((t: Record<string, unknown>) => {
                    const fn = t.function as { name?: string } | undefined;
                    // chat completions nests under `function`; Responses API is flat.
                    return fn?.name ?? (t.name as string | undefined) ?? "?";
                });
                log("info", `[debug] tools=[${toolNames.join(",")}] msgs=${parsed.messages?.length ?? 0} stream=${parsed.stream ?? false} system_len=${JSON.stringify(parsed.messages?.find((m: Record<string, string>) => m.role === "system")?.content ?? "").length}`);
            }
            if (bodyDumpEnabled() && knobDumpReqAllowed()) {
                const dumpDir = dumpsDir();
                try { fs.mkdirSync(dumpDir, { recursive: true }); } catch { /* best-effort */ }
                const sid = prepared?.session.id ?? "unknown";
                const out = path.join(dumpDir, `req-${Date.now()}-${safeSessionId(sid)}.json`);
                try {
                    const pretty = JSON.stringify(JSON.parse(wireText), null, 2);
                    fs.writeFileSync(out, `${DUMP_PLAINTEXT_BANNER}\n${pretty}`);
                } catch {
                    fs.writeFileSync(out, `${DUMP_PLAINTEXT_BANNER}\n${wireText}`);
                }
                log("info", `[debug] forwarded body written to ${out}`);
                gcDumpDirIfConfigured(dumpDir);
            }
        } catch { /* best-effort */ }
    }
    if (opts.debug) {
        const hdrLog: Record<string, string> = {};
        for (const [hk, hv] of Object.entries(headers)) {
            if (typeof hv === "string") {
                const masked = maskHeaderForLog(hk, hv);
                hdrLog[hk] = masked.length > 200 ? masked.slice(0, 200) + "..." : masked;
            }
        }
        log("info", `[${prepared?.session.id ?? "unknown"}] → upstream headers: ${JSON.stringify(hdrLog)}`);
    }
    // Raw HTTP capture: dump the COMPLETE exchange (request method/URL/all
    // headers/exact body bytes; response status+headers) so two consecutive
    // requests can be byte-diffed to locate a cache-breaker that the JSON body
    // dump (which re-formats and omits headers) may hide. Enabled with
    // ACP_DUMP_BODY=1 (credential header values + non-public hosts masked;
    // #4482: body is plaintext by design — the leading banner warns).
    const rawBase =
        bodyDumpEnabled()
            ? (() => {
                  try {
                      const rawDir = knobRawDumpDir();
                      fs.mkdirSync(rawDir, { recursive: true });
                      return path.join(rawDir, `${Date.now()}-${safeSessionId(prepared?.session.id)}`);
                  } catch {
                      return "";
                  }
              })()
            : "";
    if (rawBase) {
        try {
            const hdrText = Object.entries(maskHeadersForLog(headers))
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n");
            const bodyText =
                req.method === "GET" || req.method === "HEAD"
                    ? ""
                    : typeof wireBody === "string"
                      ? wireBody
                      : Buffer.from(wireBody).toString("utf8");
            const reqPath = `${rawBase}-REQ.txt`;
            fs.writeFileSync(reqPath, `${DUMP_PLAINTEXT_BANNER}\n${req.method ?? "POST"} ${maskUrlForLog(upstreamUrl)}\n${hdrText}\n\n${bodyText}`);
            log("info", `[debug] RAW request dump: ${reqPath}`);
            gcDumpDirIfConfigured(path.dirname(rawBase));
        } catch (err) { logDumpFailure("REQ dump", err); }
    }
    const dispatcher = proxyDispatcher(proxyUrl);
    // #3701/#3909: lane-keyed soft byte budget — shed older images from the OUTBOUND COPY
    // before signing, so an oversized body never reaches the upstream (the WS gateway
    // answers close 1009 with zero events, edge runtimes 503 on raw-byte limits, and no
    // retry can fix a size rejection without a smaller payload). Runs only above the
    // budget of the lane actually riding the request: network.wsOutboundBytes for a
    // WS-tagged transport, network.httpOutboundBytes for the plain/proxy/pi-native relay
    // (no transport installed); managed non-WS transports pass through untouched
    // (#3701 Finding 1).
    let outboundCopyRewritten = false;
    if (prepared && !prepared.sidePassthrough && prepared.protocol && req.method !== "GET" && req.method !== "HEAD" && typeof wireBody === "string") {
        const shed = await shedEgressIfOverBudget(wireBody, prepared.protocol, { sessionId: prepared.session.id, session: prepared.session, log, phase: "pre-send" });
        if (shed.body !== wireBody) outboundCopyRewritten = true;
        wireBody = shed.body;
        // #4124: proactive per-prompt image-count cap — once this route PROVED a
        // count wall via an upstream rejection (learned into stats.imageCountCaps),
        // converge the outbound copy under it BEFORE send so the request never 400s
        // on count again. Only acts when the count is over; under-cap bodies pass
        // through byte-identical (deterministic walk → prefix-cache stable).
        const imgOrigin = normalizeUpstreamOrigin(upstreamUrl);
        const imgCap = imgOrigin !== undefined ? prepared.session.stats.imageCountCaps?.[imgOrigin] : undefined;
        if (typeof imgCap === "number" && imgCap > 0) {
            const sess = prepared.session;
            const countShed = await shedWireImagesToCount(wireBody, prepared.protocol, imgCap - 1, {
                resolveRef: (mt, b64) => refForItemBytes(sess, mt, b64),
            });
            if (countShed.stats.changed) {
                outboundCopyRewritten = true;
                sess.metadata.imageCountShed = { at: Date.now(), phase: "pre-send", cap: imgCap, archived: countShed.stats.archived };
                log("info", `[${sess.id}] [image-count-shed] pre-send: archived ${countShed.stats.archived} oldest images to stay under the learned per-prompt cap ${imgCap} on this route (#4124) — originals stay in session storage`);
                wireBody = countShed.body;
            }
        }
    }
    // #1884: sign the FINAL wire body right before the send — everything
    // upstream of this point (prepare* injection, compat, steering) already
    // mutated it, so any inbound signature is stale here.
    if (req.method !== "GET" && req.method !== "HEAD") {
        // #816 family: a lone surrogate in a string wire body (rebuilt from
        // persisted compression state, model-authored text) serializes as an
        // unpaired \uXXXX escape and strict upstreams reject the WHOLE body
        // (non-retryable 400) — scrub before signing so the signature covers
        // the bytes actually sent. Buffer bodies are raw passthrough bytes
        // and are forwarded byte-faithfully, untouched.
        if (typeof wireBody === "string") wireBody = scrubLoneSurrogatesOnWire(wireBody);
        applyResign(headers, wireBody);
    }
    try {
        checkOutboundBody(wireBody);
    } catch (err) {
        if (!(err instanceof OutboundBodyTooLargeError)) throw err;
        log("warn", `413: ${err.message}`);
        if (res.headersSent) emitStreamError(res, prepared?.protocol ?? "openai", err.message, undefined, opts.streamErrorShape);
        else {
            res.writeHead(413, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { type: "request_too_large", stage: "forward", message: err.message } }));
        }
        return;
    }
    // #4079 egress window fuse — the byte budget above is pure bytes (5GiB) and
    // preflight's doom math only runs inside its two escape hatches (#2313
    // estimate-only probe / #3146 fresh-session forward-once); every other
    // path (trigger never fired, the judged estimate said "fits", a wire-dialect
    // reconcile re-anchored nothing and re-sent verbatim, the plugin lane has
    // no preflight) reached this socket with ZERO window comparison. #4068: a
    // 6,165,048-token body hit a 1,048,580 window upstream; #3872: a 5.35×
    // re-send after a mid-session wire switch. Same bars as preflight's doom
    // probe (#2490), same caliber (core text bytes, media excluded — image
    // tokens are a separate learned channel): only bodies NO tokenizer at the
    // densest observed density (~7.5 B/token, #2122) can fit are blocked, so a
    // dense-but-fitting payload is never false-positived (#3617 both-ways).
    // No LocalRefusalRecord here: the doomed body itself re-trips this fuse on
    // every retry, so a record would only outlive the turn and lock the route
    // the way #3974 suffered.
    // #4205: the window below is the UNRESERVED wall (effectiveContextLimit
    // records N) — the bar sizes against the actual upstream limit; bodies
    // between the reserved band and the wall ride forward→400→refold rescue
    // instead of an instant 413 (slightly looser than the pre-#4205 R-sized bar).
    if (prepared && !prepared.sidePassthrough && req.method !== "GET" && req.method !== "HEAD") {
        const declaredWindow = typeof prepared.session.metadata.effectiveContextLimit === "number" && prepared.session.metadata.effectiveContextLimit > 0
            ? prepared.session.metadata.effectiveContextLimit
            : 0;
        // #4079: the declared window can be wrong SMALL (stale config, registry
        // miss, #3993-style catalog fallback) — never size the catastrophic bar
        // below the largest common window, or the fuse false-blocks bodies the
        // real upstream accepts.
        const fuseWindow = Math.max(declaredWindow, MIN_ASSUMED_WINDOW_TOKENS);
        if (declaredWindow > 0) {
            const fuseMsgs = prepared.processedMessages.length > 0 ? prepared.processedMessages : prepared.originalMessages;
            const fuseBytes = estimateCoreMessagesUpperBytes(fuseMsgs);
            if (fuseBytes > Math.max(DOOMED_PROBE_ABSOLUTE_BYTES, fuseWindow * DOOMED_PROBE_BYTES_PER_TOKEN)) {
                const fuseFloorTokens = Math.ceil(fuseBytes / DOOMED_PROBE_BYTES_PER_TOKEN);
                log("warn", `413: [${prepared.session.id}] egress window fuse core-text profile: ${describeCoreTextDuplication(fuseMsgs)}`);
                const fuseMessage = `outbound core text alone is ~${fuseBytes} bytes — even at the densest tokenizer density observed on a live route (~${DOOMED_PROBE_BYTES_PER_TOKEN} bytes/token, #2122) that is ≥ ~${fuseFloorTokens} tokens vs the effective model window ${declaredWindow} (bars never assume below ${MIN_ASSUMED_WINDOW_TOKENS} tokens, #4079) (model=${prepared.model ?? "unknown"}); no upstream can accept it, so the send was stopped at the egress fuse instead of being forwarded (#4068/#4079). Remove or trim the oversized content (e.g. a giant paste or tool result) and retry.`;
                log("warn", `413: [${prepared.session.id}] egress window fuse: ${fuseMessage}`);
                if (res.headersSent) emitStreamError(res, prepared.protocol, fuseMessage, undefined, opts.streamErrorShape);
                else {
                    res.writeHead(413, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { type: "request_too_large", code: "egress_window_fuse", stage: "forward", message: fuseMessage, retryable: false } }));
                }
                return;
            }
        }
    }
    const init: Omit<RequestInit, "dispatcher"> & { dispatcher?: object } = {
        method: req.method ?? "GET",
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : v1Wrap(wireBody),
    };
    if (dispatcher) init.dispatcher = dispatcher;
    // #1843 L1: capture this round's image facts at the SEND chokepoint so the
    // turn's usage settle pairs with the bytes actually sent — streamed turns
    // settle in plugin.ts's SSE handler and never revisit the request body, so
    // a settle-site-only capture would miss every streamed turn. textSide
    // mirrors outboundPayloadBreakdown (messages + wire overhead) so observed
    // image mass = billed total - textSide. Retries within this forward
    // (#5708/#5835 refolds) re-send near-identical image sets — first-send
    // facts stay the pairing source, same as noteForwardedBody's semantics.
    if (prepared && prepared.protocol && req.method !== "GET" && req.method !== "HEAD" && typeof wireBody === "string") {
        // parsedBody (the pre-serialization object) avoids re-parsing the
        // whole wire body here; a body that fails to parse carries no image
        // facts to learn — skip exactly like the old raw-probe miss. When a
        // pre-send shed rewrote the bytes, though, the pre-shed object
        // overcounts the images actually sent — count the final string then.
        let nImages = 0;
        try {
            nImages = outboundCopyRewritten
                ? countImagesInRawBody(prepared.protocol, wireBody)
                : countImagesInParsedBody(prepared.protocol, prepared.parsedBody ?? JSON.parse(wireBody));
        } catch { /* unparseable — no image facts */ }
        if (nImages > 0) {
            const learnUpstream = route?.rewrittenUrl ?? (/^https?:\/\//i.test(req.url ?? "") ? req.url ?? undefined : opts.upstream);
            const msgs = prepared.processedMessages.length > 0 ? prepared.processedMessages : prepared.originalMessages;
            noteForwardedImageFacts(prepared.session, {
                nImages,
                // Overhead against the SENT bytes: parsedBody is the pre-shed memo and
                // would drift from wireBody once an egress shed rewrites the body; when
                // nothing was rewritten, measuring the serialized bytes is exactly what
                // pre-#5131 measured — one fewer branch, identical value.
                textSide: estimateCoreMessages(msgs) + estimateWireOverhead(prepared.protocol, wireBody),
                host: upstreamHost(learnUpstream),
                fp: `${imageBillingFor(opts, learnUpstream)}:${imageTokenCapFor(opts, learnUpstream)}`,
            });
        }
    }
    // Must be created before fetchWithTimeout: the signal aborts the upstream
    // request when the client disconnects (IDE cancel), otherwise the proxy
    // keeps reading upstream and holds the per-session lock. Also passed to
    // the rewriter loop below so fetch and loop stop together.
    const clientAbort = new AbortController();
    registerRequestAbort(res, clientAbort);
    if (clientAbort.signal.aborted) return;
    res.on("close", () => {
        if (!res.writableEnded) {
            // #1647: without this, a client killed by its own undici bodyTimeout
            // (starved by upstream-caused silence) is indistinguishable in the log
            // from a user cancel. Elapsed + bytes-to-client separates the two.
            const ageMs = Date.now() - forwardStartedAt;
            const clientBytes = res.socket?.bytesWritten ?? 0;
            log("info", `[${prepared?.session.id ?? "passthrough"}] client disconnected mid-stream after ${ageMs}ms (${clientBytes} bytes written to client)`);
            clientAbort.abort();
            if (prepared?.session) noteClientAbort(prepared.session);
        }
    });
    // #1891: seam forensics for the MAIN send path — every lane (streaming,
    // plugin pipe, non-streaming) funnels through this one chokepoint, so the
    // next settleUsageReport pairs this exact outbound byte string with the
    // previous request's body. Loop re-fetches re-note their own rebuilt bodies
    // (loop/core.ts fetchUpstream); side requests never settle usage and must
    // not clobber the slot.
    if (prepared?.session && !prepared.sidePassthrough && req.method !== "GET" && req.method !== "HEAD") {
        const sentBody = typeof wireBody === "string" ? wireBody : wireBody.toString("utf8");
        // #2078: ONE parse of the outbound body for the whole seam block — the
        // estimate's projection, its wire-overhead term, and the image reserve
        // each used to re-parse this same string independently.
        let sentParsed: Record<string, unknown> | null;
        try {
            const p = JSON.parse(sentBody);
            sentParsed = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
        } catch {
            sentParsed = null;
        }
        // Publish this send, not a historical usage baseline with a fresh timestamp.
        const est = outboundContextEstimates(prepared, sentBody, opts, upstreamUrl, sentParsed);
        // The char-count upper bound stays the published context value: it is
        // the fail-closed caliber decision paths and legacy displays trust for
        // never-reporting upstreams (#553/#728/#1493). #2117 additionally
        // publishes the billing-caliber estimate of THIS send — preflight's own
        // formula (CJK-aware text + wire overhead), k̂-scaled only where the
        // factor's route+model provenance matches (#1933 F1 / #2117 B), plus
        // the image reserve — so display surfaces can show a calibrated reading
        // instead of the ~2–3.5× over-counting bound. Display-only field.
        // #4383: the write itself lives in noteOutboundContextEstimates so the
        // stamp contract (and its "estimate" freshness mark, which
        // usageAnchorCycleStale reads) is testable.
        const kFactor = currentCalibrationFactor(prepared.session.stats, prepared.session.metadata?.lastModel);
        const scaledText = applyEstimateCalibration(est.textOverhead, kFactor, prepared.session.stats.calibratedEstimateOrigin, normalizeUpstreamOrigin(upstreamUrl));
        noteOutboundContextEstimates(prepared.session, {
            upperBound: est.upperBound,
            scaledText,
            imageTokens: est.imageTokens,
            calibrated: scaledText !== est.textOverhead,
        });
        // #2131: exact message count for seam forensics (sentParsed is the one
        // shared parse above — Responses carries "input", Google native "contents").
        const sentArr = sentParsed !== null ? (sentParsed.messages ?? sentParsed.input ?? sentParsed.contents) : null;
        // #3803: the generation-parameter fingerprint rides the SAME full parse as the message count —
        // it is extracted from sentParsed (the complete object), never from the capped body head, so a
        // trailing-field flip is seen even when the body exceeds SEAM_BODY_CAP.
        noteForwardedBody(prepared.session, sentBody, Array.isArray(sentArr) ? (sentArr as unknown[]).length : null, credentialFingerprint(headers), generationParamFp(sentParsed));
        // #3023: the client's own resent view — the protocol conversion of the
        // inbound bytes BEFORE processTurn folded/replaced anything, captured
        // with the exact same pairing semantics so detectSeam can attribute a
        // mid-history break to the client (host plugin insert / paste hoisting)
        // instead of blaming the rebuild.
        noteInboundMessages(prepared.session, prepared.originalMessages);
        // #3938 (PR-A): judge the exact outbound bytes at the universal main-lane
        // send chokepoint — the same string just paired, AFTER compat-role /
        // steering / chain-stamp / shed rewrites, so I1/I2 see the wire truth.
        // Advisory; never blocks. Replaces the pre-send hook (handle.ts) which
        // judged a pre-rewrite snapshot.
        // #4241: on a snapshot-render turn the outbound prefix is server-rendered
        // (transcript rows + summary carriers), not the raw inbound bytes — the
        // judge must exempt that region and validate only the client tail. The
        // boundary was recorded by prepare's maybeSnapshotView on the same session.
        const renderTailStart = typeof prepared.session.metadata["snapshotRenderTailStart"] === "number"
            ? (prepared.session.metadata["snapshotRenderTailStart"] as number)
            : undefined;
        maybeRunInvariantJudge({
            // #2078: reuse the seam block's single parse of sentBody instead of
            // paying another full JSON.parse of the largest payload per turn.
            parsed: sentParsed,
            // #4241: a render-lane turn's outbound is built from the SERVER
            // transcript (summary anchors + store rows), so its ground truth
            // is the rendered view — reconciling the client's inbound bytes
            // against it false-positives I2 on every folded render turn.
            // judgeBaseline is set only when the view was actually replaced
            // (reference-inequality); otherwise this is byte-identical to
            // prepared.originalMessages.
            originalMessages: prepared.judgeBaseline ?? prepared.originalMessages,
            body: sentBody,
            protocol: prepared.protocol,
            sessionId: prepared.session.id,
            ...(renderTailStart !== undefined ? { renderTailStart } : {}),
        });
    }
    // #3148: round-level breaker — while the endpoint is provably dead, fail
    // fast WITHOUT contacting it instead of burning another full cold send +
    // the whole in-request retry ladder per host-driven retry round. The
    // thrown detail carries the actionable state (last failure + next probe)
    // that the dispatch catch renders into the 502 body.
    const circuitBlock = upstreamCircuitBlockReason(upstreamUrl);
    if (circuitBlock !== undefined && !isCodexCatalogRequest(upstreamUrl, init)) {
        // #4254: throttle the per-request warn to one line/window/host while the
        // circuit stays OPEN (the OPEN/CLOSED/probe state flips log at their own
        // sites) so a single dead upstream stops re-amplifying every blocked round.
        if (noteCircuitFailFastLog(upstreamUrl)) {
            log("warn", `[${prepared?.session.id ?? "passthrough"}] [acp-proxy] upstream circuit open — failing fast without contacting ${upstreamUrl}: ${circuitBlock}`);
        }
        if (prepared && req.method !== "GET" && req.method !== "HEAD") armFailureShrink(prepared, log, "upstream circuit open", outboundPayloadBreakdown(prepared, opts, route, req.url ?? "").armEstimate);
        if (prepared && prepared.attachedRetrievals && prepared.attachedRetrievals.length > 0) dropRetrievals(prepared.session, prepared.attachedRetrievals.map((i) => i.ref), "upstream circuit open");
        const lastKind = upstreamCircuitLastFailureKind(upstreamUrl);
        const retryAfter = upstreamCircuitRetryAfterSeconds(upstreamUrl);
        let displayHost: string | undefined;
        try { displayHost = maskHostPortForDisplay(new URL(upstreamUrl).host); } catch { /* not a URL */ }
        // #4254: carry host/circuitOpen/retryAfterSeconds so the egress can name the
        // dead endpoint in the client-facing `error`, answer 503 + Retry-After, and
        // skip its per-request [error] (markExpectedFailFast) since the throttled
        // warn above is the canonical record.
        throw markExpectedFailFast(withUpstreamFailure(new Error(`upstream circuit open: ${circuitBlock}`), {
            ...(lastKind !== undefined ? { kind: lastKind as UpstreamFailureKind } : {}),
            ...(displayHost !== undefined ? { host: displayHost } : {}),
            circuitOpen: true,
            ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
            hint: "upstream circuit open — the endpoint is unreachable and bili is failing fast instead of resending full context until a probe succeeds",
        }));
    }
    // #4204: egress-side 429 throttle governor — while consecutive sends to this
    // origin+credential came back 429, answer LOCALLY (429 + Retry-After under
    // budget, then a terminal 424 outside every known SDK retry set) instead of
    // forwarding: a host-driven retry loop must not be amplified into egress
    // that pins a concurrency-style provider limit for the whole account. Zero
    // egress while held; one probe per backoff window keeps recovery automatic.
    if (req.method !== "GET" && req.method !== "HEAD") {
        const throttleReject = upstreamThrottleLocalReject(upstreamUrl, headers);
        if (throttleReject !== undefined) {
            log(throttleReject.status === 424 ? "warn" : "debug", `[${prepared?.session.id ?? "passthrough"}] [acp-proxy] 429-hold: answered locally with ${throttleReject.status} without egress (#4204)`);
            if (res.headersSent) emitStreamError(res, prepared?.protocol ?? "openai", throttleReject.message, undefined, opts.streamErrorShape);
            else {
                res.writeHead(throttleReject.status, throttleReject.retryAfterSec !== null
                    ? { "content-type": "application/json", "retry-after": String(throttleReject.retryAfterSec) }
                    : { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { type: "rate_limit_error", code: throttleReject.code, stage: "forward", message: throttleReject.message, retryable: throttleReject.status === 429 } }));
            }
            return;
        }
    }
    let upstreamResult: Awaited<ReturnType<typeof fetchWithTimeout>>;
    // #3701: the catch below replaces upstreamResult on a shrunken resend; capture the
    // FIRST attempt's timer handle separately because upstreamResult may never have been
    // assigned by the time a send failure lands in the catch.
    let firstAttemptClear: (() => void) | undefined;
    try {
        const lane = prepared?.sidePassthrough ? "side" : prepared ? "main" : "passthrough";
        const fetchPromise = fetchWithCodexCatalogCache(signal => fetchWithTransportRetry(upstreamUrl, init, undefined, signal, (info) => {
            log("warn", `[${prepared?.session.id ?? "unknown"}] [acp-proxy] upstream ${info.detail}; retrying in ${info.delayMs}ms (attempt ${info.attempt}/${info.maxAttempts})`);
        }), upstreamUrl, init, clientAbort.signal, log);
        const firstByteTimer = armFirstByteWatchdog({ url: upstreamUrl, method: req.method ?? "UNKNOWN", lane, sessionId: prepared?.session.id ?? "passthrough", log, signal: clientAbort.signal });
        try {
            upstreamResult = await fetchPromise;
            firstAttemptClear = upstreamResult.clearTimer;
        } finally {
            clearTimeout(firstByteTimer);
        }
        if (!(isCodexCatalogRequest(upstreamUrl, init) && upstreamResult.response.headers.get("x-bili-model-catalog") === "offline-cache")) {
            recordUpstreamConnection(upstreamUrl, proxyUrl);
            // #1682: a network response proves reachability; an offline replay does not.
            clearUpstreamAlertsForHost(upstreamUrl);
            recordUpstreamCircuitSuccess(upstreamUrl);
        }
    } catch (error) {
        const oversize = extractWsOversizeError(error);
        if (oversize === undefined) {
            recordUpstreamConnection(upstreamUrl, proxyUrl, error, skippedProxy);
            recordUpstreamAlert(upstreamUrl, error, proxyUrl !== undefined, skippedProxy);
            const failure = describeUpstreamFailure(error, upstreamUrl, proxyUrl, skippedProxy);
            recordUpstreamCircuitFailure(upstreamUrl, error, proxyUrl !== undefined, failure.message);
            // #604: a network-level failure (socket reset, timeout abort) also never
            // reports usage — arm the emergency shrink like the 5xx branch below.
            if (prepared && req.method !== "GET" && req.method !== "HEAD") armFailureShrink(prepared, log, "network failure", outboundPayloadBreakdown(prepared, opts, route, req.url ?? "").armEstimate);
            // [#1343] no response means the attached full text never reached the model —
            // drop-and-log it (a corrective note surfaces on the next qualifying request).
            if (prepared && prepared.attachedRetrievals && prepared.attachedRetrievals.length > 0) dropRetrievals(prepared.session, prepared.attachedRetrievals.map((i) => i.ref), "upstream network failure");
            throw withUpstreamFailure(new Error(`upstream request failed: ${failure.message}`, { cause: error }), failure.detail);
        }
        // #3701: close 1009 with ZERO events received is a verdict on our frame SIZE, not
        // on endpoint health — the same gateway answers smaller frames fine. Deliberately
        // NOT counted as an alert/circuit failure (legacy behavior bricked a healthy
        // endpoint over one oversized session; behavior change, see PR notes). Arm the
        // token-space shrink for visibility, then try ONE bounded byte-shrink resend that
        // must be strictly smaller than what was just rejected.
        recordUpstreamConnection(upstreamUrl, proxyUrl, error, skippedProxy);

        if (prepared && req.method !== "GET" && req.method !== "HEAD") armFailureShrink(prepared, log, "network failure", outboundPayloadBreakdown(prepared, opts, route, req.url ?? "").armEstimate);
        if (prepared && prepared.attachedRetrievals && prepared.attachedRetrievals.length > 0) dropRetrievals(prepared.session, prepared.attachedRetrievals.map((i) => i.ref), "upstream network failure");
        const sentBytes = typeof wireBody === "string" ? Buffer.byteLength(wireBody) : 0;
        const budget = limitsWsOutboundBytes();
        const target = Math.min(sentBytes * 0.85, budget > 0 ? budget : Number.MAX_SAFE_INTEGER);
        if (prepared === null || prepared === undefined || prepared.sidePassthrough || prepared.protocol === undefined || typeof wireBody !== "string" || sentBytes <= 0 || !res.writable || res.writableEnded || res.destroyed) {
            throw new Error(wsOversizeDiagnosis(sentBytes, undefined, budget));
        }
        const shedSession = prepared.session;
        const { body: shrunk, stats } = await shedWireImages(wireBody, prepared.protocol, target, { resolveRef: (mt, b64) => refForItemBytes(shedSession, mt, b64) });
        if (!stats.changed || stats.finalBytes >= sentBytes) throw new Error(wsOversizeDiagnosis(sentBytes, stats, budget));
        log("info", `[${prepared.session.id}] [ws-byte-shed] upstream closed 1009 with zero events at ${formatMiB(sentBytes)} MiB — shed to ${formatMiB(stats.finalBytes)} MiB (archived=${stats.archived} downscaled=${stats.downscaled}), resending once within this request`);
        try {
            const shrunkWire = scrubLoneSurrogatesOnWire(shrunk);
            applyResign(headers, shrunkWire);
            const retried = await fetchWithTimeout(upstreamUrl, { ...init, body: v1Wrap(shrunkWire) }, undefined, clientAbort.signal);
            if (retried.response.ok) {
                firstAttemptClear?.();
                wireBody = shrunkWire;
                upstreamResult = retried;
                prepared.session.metadata.wsByteShed = { at: Date.now(), phase: "post-1009", fromBytes: sentBytes, toBytes: stats.finalBytes, archived: stats.archived, downscaled: stats.downscaled };
                markDirty(prepared.session);
                log("info", `[${prepared.session.id}] [ws-byte-shed] 1009 recovered: shrunken resend accepted within the same request (${formatMiB(sentBytes)} -> ${formatMiB(stats.finalBytes)} MiB)`);
            } else {
                let retryErrText: string | null = null;
                if (retried.response.body) {
                    try {
                        retryErrText = (await readStreamToBuffer(retried.response.body)).toString("utf8");
                    } catch {
                        retryErrText = null;
                    }
                }
                // Answer with the retry's own verdict, not the lost first frame (#1195 shape).
                firstAttemptClear?.();
                upstreamResult = {
                    response: new Response(retryErrText ?? "", {
                        status: retried.response.status,
                        statusText: retried.response.statusText,
                        headers: new Headers(retried.response.headers),
                    }),
                    clearTimer: retried.clearTimer,
                    stopIdleTimer: retried.stopIdleTimer,
                };
                log("warn", `[${prepared.session.id}] [ws-byte-shed] shrunken resend still rejected (HTTP ${retried.response.status}); passing the retry response through`);
            }
        } catch (retryErr) {
            log("warn", `[${prepared?.session.id ?? "unknown"}] [ws-byte-shed] shrunken resend failed: ${formatUpstreamError(retryErr, upstreamUrl, proxyUrl, skippedProxy)}`);
            throw new Error(wsOversizeDiagnosis(sentBytes, stats, budget), { cause: retryErr });
        }
    }
    // #552 learn-on-failure: a converting upstream that rejects a role (codex
    // ≥0.153 sends "developer"; vLLM/SGLang-style backends answer 400
    // "Invalid role: developer") gets ONE auto-retry with the offending role
    // rewritten to "system". On success the mapping is remembered on the
    // session (never written to config — the log carries the permanent
    // per-provider snippet instead). On failure the original response
    // continues downstream verbatim. 400 bodies are small (buffered below).
    if (
        compatProtocol &&
        typeof wireBody === "string" &&
        upstreamResult.response.status === 400 &&
        upstreamResult.response.body
    ) {
        let roleErrText: string | null = null;
        try {
            roleErrText = (await readStreamToBuffer(upstreamResult.response.body)).toString("utf8");
        } catch {
            roleErrText = null;
        }
        if (roleErrText !== null) {
            // Rebuild the consumed body so the error path below re-reads the
            // same bytes verbatim (fetchWithTimeout ships rebuilt Responses
            // itself, so this shape is established).
            upstreamResult = {
                response: new Response(roleErrText, {
                    status: upstreamResult.response.status,
                    statusText: upstreamResult.response.statusText,
                    headers: new Headers(upstreamResult.response.headers),
                }),
                clearTimer: upstreamResult.clearTimer,
                stopIdleTimer: upstreamResult.stopIdleTimer,
            };
            const namedRejection = detectRoleRejection(upstreamResult.response.status, roleErrText);
            // #1996: placement-only rejections name no role (vLLM+Qwen
            // chat_template: "System message must be at the beginning.") — enter
            // the ladder when the error matches a placement marker AND the wire
            // itself carries the offending shape, so a client-origin mid-history
            // system item (plugin-mode #1638 verbatim pass-through) gets the same
            // single-hop repair instead of a permanent 400 loop on every retry.
            const rejection = namedRejection ??
                (detectSystemPlacementError(upstreamResult.response.status, roleErrText) &&
                    hasOffHeadSystem(wireBody, compatProtocol)
                    ? { role: "system" }
                    : null);
            if (rejection && !(namedRejection && namedRejection.role === "system")) {
                // Learn-on-failure ladder — primary hop (#552: offending role →
                // "system") plus a SECOND-CHANCE hop (#583: → "user") fired only
                // when the system hop 400'd with a #377-class system-PLACEMENT
                // error (backend accepts the role name but forbids system off
                // index 0, so a mid-list developer→system still 400s). Each hop
                // rewrites the one offending role to a single target and forwards
                // exactly once; the sequence is fixed (never a loop), hard-capped
                // at original + 2 retries. Any other failure stops the ladder and
                // the original 400 passes through verbatim.
                // (#1996): placement-only errors that name no role enter here
                // directly as { role: "system" } (see above) and skip the
                // identity hop straight to the system→user placement fix.
                const cp = compatProtocol;
                const wb = wireBody;
                const remember = (target: string, rewritten: number): void => {
                    const s = prepared?.session;
                    if (s) {
                        const prev = (s.metadata.learnedCompatRoles as CompatRoles | undefined) ?? {};
                        s.metadata.learnedCompatRoles = { ...prev, [rejection.role]: target };
                        markDirty(s);
                    }
                    // Same-request re-sends (compress-retry loops) carry the
                    // rewrite too — wireTransform reads compatRoles at call time.
                    compatRoles = { ...compatRoles, [rejection.role]: target };
                    const providerKey = maskUrlForLog(new URL(upstreamUrl).origin);
                    log("info", `[${prepared?.session.id ?? "passthrough"}] [compat] upstream rejected role "${rejection.role}" — auto-rewrote ${rewritten} message role(s) to "${target}", retry OK (remembered for this session only). To make permanent, add: {"providers":{"${providerKey}":{"compat":{"roles":{"${rejection.role}":"${target}"}}}}`);
                };
                type HopOutcome = "ok" | "placement-400" | "other";
                const hop = async (target: string): Promise<HopOutcome> => {
                    const fixed = applyCompatRoles(wb, cp, { [rejection.role]: target });
                    if (fixed.rewritten === 0) return "other";
                    let r: Awaited<ReturnType<typeof fetchWithTimeout>>;
                    try {
                        applyResign(headers, fixed.body);
                        r = await fetchWithTimeout(upstreamUrl, { ...init, body: v1Wrap(fixed.body) }, undefined, clientAbort.signal);
                    } catch {
                        return "other"; // transport failure — keep the original 400
                    }
                    if (r.response.ok) {
                        upstreamResult.clearTimer();
                        // #1900: the hop's bytes are now the accepted wire base —
                        // keep wireBody tracking the last successful send so every
                        // later same-request re-send (fake-completion hint retry)
                        // derives from what upstream actually accepted.
                        wireBody = fixed.body;
                        remember(target, fixed.rewritten);
                        upstreamResult = r;
                        return "ok";
                    }
                    let errText: string | null = null;
                    if (r.response.body) {
                        try {
                            errText = (await readStreamToBuffer(r.response.body)).toString("utf8");
                        } catch {
                            errText = null;
                        }
                    }
                    r.clearTimer();
                    return errText !== null && detectSystemPlacementError(r.response.status, errText) ? "placement-400" : "other";
                };
                // #1996: an already-system offender needs no identity hop — go
                // straight to the placement fix (system→user).
                if (rejection.role === "system") {
                    await hop("user");
                } else if ((await hop("system")) === "placement-400") {
                    await hop("user");
                }
            }
        }
    }
    // #2645 probe-and-remember: strict direct APIs 400 unknown body params
    // (NIM: "Unsupported parameter(s): `prompt_cache_key`"). Instead of
    // guessing which destinations are strict by destination shape, run the
    // controlled experiment at this chokepoint on the first key-carrying 400:
    // re-send the IDENTICAL request minus prompt_cache_key once. Accepted ⇒
    // causation confirmed — adopt the retry's response, remember the
    // origin+model pair process-locally (src/pck-probe.ts; surfaced via log /
    // acp_status / web panel), every later prepare withholds the key there
    // until proxy restart. Still failing ⇒ NOT this field — discard the
    // second response, forward the original 400 verbatim, learn nothing (the
    // next turn carries the key again and re-runs the probe). One attempt per
    // request, no loops; the error body is buffered so the passthrough below
    // re-reads the same bytes (same pattern as the #552 ladder above).
    if (
        prepared &&
        req.method !== "GET" &&
        req.method !== "HEAD" &&
        typeof wireBody === "string" &&
        upstreamResult.response.status === 400 &&
        upstreamResult.response.body
    ) {
        let pckErrText: string | null = null;
        try {
            pckErrText = (await readStreamToBuffer(upstreamResult.response.body)).toString("utf8");
        } catch {
            pckErrText = null;
        }
        if (pckErrText !== null) {
            upstreamResult = {
                response: new Response(pckErrText, {
                    status: upstreamResult.response.status,
                    statusText: upstreamResult.response.statusText,
                    headers: new Headers(upstreamResult.response.headers),
                }),
                clearTimer: upstreamResult.clearTimer,
                stopIdleTimer: upstreamResult.stopIdleTimer,
            };
            let strippedPckBody: string | null = null;
            let pckModel: string | undefined;
            try {
                const p = JSON.parse(wireBody) as Record<string, unknown>;
                if (p && typeof p.prompt_cache_key === "string") {
                    delete p.prompt_cache_key;
                    pckModel = typeof p.model === "string" ? p.model : undefined;
                    strippedPckBody = JSON.stringify(p);
                }
            } catch {
                strippedPckBody = null;
            }
            // #4124: a 400 whose body names a CONTENT wall (image-count or
            // token/context overflow) exonerates prompt_cache_key by inspection —
            // the key-less re-send can only fail identically, and in the field it
            // hit a secondary byte-wall 413 instead (#4124 turn 44). Skip the
            // probe; the overflow paths below own this error.
            const pckInspection = strippedPckBody !== null ? inspectContextOverflow(400, pckErrText) : null;
            const contentWall = pckInspection !== null && (pckInspection.isOverflow || pckInspection.imageCountCap !== undefined);
            if (contentWall) {
                log("debug", `[${prepared.session.id}] [pck] 400 names a content wall (${pckInspection!.imageCountCap !== undefined ? `image count > ${pckInspection!.imageCountCap}` : "context overflow"}) — prompt_cache_key exonerated by inspection, A/B probe skipped (#4124)`);
            }
            if (strippedPckBody !== null && !contentWall) {
                let retried: Awaited<ReturnType<typeof fetchWithTimeout>> | null = null;
                try {
                    applyResign(headers, strippedPckBody);
                    retried = await fetchWithTimeout(upstreamUrl, { ...init, body: v1Wrap(strippedPckBody) }, undefined, clientAbort.signal);
                } catch {
                    retried = null; // transport failure — inconclusive, original 400 stands
                }
                if (retried !== null) {
                    if (retried.response.ok) {
                        upstreamResult.clearTimer();
                        // The key-less bytes are the accepted wire base now — track
                        // them like the #552/#1900 role hops do, so every later
                        // same-request re-send derives from what upstream accepted.
                        wireBody = strippedPckBody;
                        recordPckAblation({
                            origin: upstreamUrl,
                            model: pckModel,
                            sessionId: prepared.session.id,
                            statusWithKey: 400,
                            errSnippet: pckErrText,
                        });
                        log("info", `[${prepared.session.id}] [pck] egress carried prompt_cache_key \u2192 400; identical request without the key was accepted — withholding the key for ${maskUrlForLog(upstreamUrl)} until proxy restart (#2645)`);
                        upstreamResult = retried;
                    } else {
                        if (retried.response.body) {
                            try {
                                await readStreamToBuffer(retried.response.body);
                            } catch {
                                /* discarded either way */
                            }
                        }
                        retried.clearTimer();
                        log("debug", `[${prepared.session.id}] [pck] A/B retry without prompt_cache_key also failed (${retried.response.status}) — not the key's fault; key stays, original 400 forwarded (#2645)`);
                    }
                }
            }
        }
    }
    // #987/#1195: arm the one-shot emergency shrink (declared window unchanged,
    // nothing persisted/learned) — extracted so the same-request overflow retry
    // below and the !ok passthrough share it exactly once per request.
    let overflowArmed = false;
    const armOverflowShrink = (info: ContextOverflowInfo): void => {
        if (overflowArmed || !info.isOverflow) return;
        overflowArmed = true;
        const s = prepared!.session;
        let reqModel: string | undefined;
        let rawBody: string | undefined;
        try {
            rawBody = typeof prepared!.body === "string" ? prepared!.body : prepared!.body.toString("utf8");
            const parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
            reqModel = typeof parsedBody.model === "string" ? parsedBody.model : undefined;
        } catch {
            reqModel = undefined;
        }
        if (info.window) {
            // Arm the emergency shrink at EXACTLY the stated window: the
            // upstream just proved a turn cannot succeed above it, so the
            // next turn's kernel emergency nudge + tool-result truncate
            // must fire. #857: a number the upstream itself stated bounds
            // the payload (never a content estimate). #1839: it is still an
            // ARM, not a billing report — tag it "overflow-arm", never
            // "usage" (the only tier trusted unconditionally);
            // effectiveTokenCount's fast path and the #496 forward-once gate
            // accept it as rescue-grade, everything else usage-gated keeps
            // excluding it. A real usage report on the next successful turn
            // overwrites it.
            //
            // #3738: the armed value must be ≤ the limit the kernel actually
            // JUDGES against, or the arm can never trigger the fold it
            // exists to cause. The kernel judges against reqConfig's
            // output-headroom-RESERVED window, recorded per-request as
            // `session.metadata.reservedContextLimit` (#4205 split the display
            // off into the unreserved `effectiveContextLimit`), e.g. 1,048,576
            // - 256,000 = 792,576 — while `info.window` is the RAW stated
            // window (1,048,576). A
            // live limb hit exactly this: upstream 400 "maximum context
            // length is 1048576 ... you requested 1097304 (841304 in the
            // messages, 256000 in the completion)", the arm sat at 1,048,576
            // which is ABOVE the 792,576 judging limit, so the emergency /
            // over-limit bands read the arm as "still fits" and the client
            // re-sent the same oversized history every turn — 400 forever.
            // Clamping to min(stated, reserved) keeps the arm upstream-truth
            // when the two agree, and only bites when a reservation exists.
            //
            // #3450: when the body states the REJECTED PAYLOAD'S OWN size
            // ("N in the messages"), book THAT as the armed baseline — the
            // window is a ceiling, not a measurement; arming at the ceiling
            // made preflight see "payload ~window, deficit 0" while the real
            // payload sat above its local estimate and the re-forward died.
            // The #3738 clamp then caps that measurement at the judging limit
            // (a stated count exceeds the reserved limit exactly when the
            // completion share pushed the total over the window).
            const measured = typeof info.requestedMessages === "number" && info.requestedMessages > 0 ? info.requestedMessages : undefined;
            const judgingLimit = typeof s.metadata.reservedContextLimit === "number" && s.metadata.reservedContextLimit > 0
                ? s.metadata.reservedContextLimit
                : typeof s.metadata.effectiveContextLimit === "number" && s.metadata.effectiveContextLimit > 0 ? s.metadata.effectiveContextLimit : 0;
            const unclampedBaseline = measured ?? info.window;
            const armedBaseline = judgingLimit > 0 && judgingLimit < unclampedBaseline ? judgingLimit : unclampedBaseline;
            s.stats.lastInputTokens = armedBaseline;
            s.stats.lastInputTokensSource = "overflow-arm";
            // #2313: the rejection came from THIS upstream — stamp the
            // evidence origin so the #1933 F2 route gate (and the #2313
            // probe-forward gate) treat the arm as current-route evidence
            // instead of demoting it against a stale settle origin.
            s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(upstreamUrl);
            // #1110: record the arm SEPARATELY so the side-request guard
            // can read it without ever touching the nudge baseline. The guard
            // keeps the CEILING even when the baseline books a measured or
            // clamped value (#3450) — it must never clamp below what the
            // upstream proved, and it reserves each side request's own output
            // from this value itself, so feeding it a pre-reserved number
            // would double-subtract the headroom.
            s.stats.overflowArmTokens = info.window;
            // #3450: the completion share proves this provider bills OUTPUT
            // against the same wall — remember it so preflight folds against
            // window − completion (the foldable quantity is MESSAGES).
            const reserve = typeof info.requestedCompletion === "number" && info.requestedCompletion > 0 ? info.requestedCompletion : undefined;
            if (reserve !== undefined) {
                s.stats.overflowArmCompletionReserve = reserve;
                // #3450 follow-up: same evidence on the provider's lifetime —
                // the arm retires on the next usage report (#1110), this must
                // not (see provenCompletionReserve). Scoped to the origin+model.
                const provenOrigin = normalizeUpstreamOrigin(upstreamUrl);
                if (provenOrigin !== undefined && reqModel !== undefined) {
                    s.stats.provenCompletionWall = reserve;
                    s.stats.provenCompletionWallOrigin = provenOrigin;
                    s.stats.provenCompletionWallModel = reqModel;
                }
            }
            // #3450: one-time mismatch warning — the upstream-stated window
            // differs from the window bili actually judges on. #4205: compare
            // against the UNRESERVED declaration, so routes that reserve output
            // headroom no longer warn on every arm just because R < N.
            const declaredWindow = typeof s.metadata.effectiveContextLimit === "number" ? s.metadata.effectiveContextLimit : 0;
            if (declaredWindow > 0 && declaredWindow !== info.window && !s.stats.overflowArmMismatchWarned) {
                s.stats.overflowArmMismatchWarned = true;
                log("warn", `[${s.id}] upstream-stated window ${info.window} differs from the declared window in use (${declaredWindow}, model=${reqModel ?? "unknown"}) — folding targets the smallest of the stated window, the declared window and the per-route output reservation; set compress.modelContextLimit if the declaration is wrong (#3450)`);
            }
            log("warn", `[${s.id}] upstream context overflow (model=${reqModel ?? "unknown"}) — window ${info.window} stated upstream${measured !== undefined ? `, rejected payload ~${measured} tokens stated` : ""}${reserve !== undefined ? `, completion reservation ${reserve} tokens` : ""}; armed emergency shrink at ${armedBaseline}${armedBaseline < unclampedBaseline ? ` (clamped to the judging limit ${judgingLimit}, #3738)` : ""}, declared window unchanged (#987)`);
            // #3900/#4079: the stated count is a usage-grade measurement of
            // the exact rejected body (#3450) whose local estimate prepare
            // recorded as the pending k̂ pair — feed it into the SAME ring a
            // usage settle uses, so the estimator learns even on a route that
            // only ever overflows and the next preflight judges "doesn't fit"
            // on the corrected calibre instead of re-forwarding the same body
            // forever. The refold below re-runs prepare and re-notes a fresh
            // pair for the folded body (#1195), so retiring the consumed pair
            // here cannot mispair a later report.
            if (measured !== undefined) settleOverflowCalibration(s, measured, upstreamUrl);
        } else {
            // No window number stated — nothing to learn (and #987
            // removed the learner anyway), but the rejection itself is
            // evidence at the size actually sent: arm at
            // min(declared, payload estimate). A payload BELOW the
            // declared window being rejected means the declaration is
            // wrong (or the upstream is flaky) — arming at the payload's
            // own size never over-triggers, while a payload OVER the
            // declared window arms at the declaration — which is what
            // the #496 image-relay forward-once gate needs to break the
            // #488 400 loop after exactly one rejected forward.
            // #4205: arm against the JUDGING (reserved) window so the #3738
            // invariant holds here too; pre-#4205 persisted sessions carry that
            // value in effectiveContextLimit (the field then held R), hence the
            // fallback.
            const judging = typeof s.metadata.reservedContextLimit === "number" && s.metadata.reservedContextLimit > 0
                ? s.metadata.reservedContextLimit
                : typeof s.metadata.effectiveContextLimit === "number" ? s.metadata.effectiveContextLimit : 0;
            let est = 0;
            try {
                // #1492: same CJK-aware lower bound as armFailureShrink.
                est = defaultCountTokens(rawBody ?? "");
            } catch { est = 0; }
            const arm = Math.max(0, Math.min(judging, Number.isFinite(est) ? est : judging));
            if (arm > 0) {
                s.stats.lastInputTokens = arm;
                // #1839: an estimate promoted to "usage" would enter the nudge
                // denominator unconditionally — tag it "overflow-arm" instead
                // (still accepted by effectiveTokenCount + the #496 gate).
                s.stats.lastInputTokensSource = "overflow-arm";
                s.stats.overflowArmTokens = arm; // #1110: guard reads this, not the baseline
                s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(upstreamUrl); // #2313: same-route evidence, see the window branch above
            }
            log("warn", `[${s.id}] upstream context overflow (window not parseable, model=${reqModel ?? "unknown"}) — armed emergency shrink at ~${arm} tokens (min of judging window ${judging} and payload estimate), nothing learned (#987): ${info.message}`);
        }
        // The armed emergency (lastInputTokens) lives in memory only
        // until scheduled — the error path returns before forward()'s
        // trailing markDirty, so schedule the save HERE or the arm is
        // lost on restart.
        markDirty(s);
    };
    // #1195: a context overflow used to arm the shrink and pass the 400 through
    // verbatim, expecting the NEXT turn to fold — but wire clients treat the
    // error as fatal and end the session, so the armed rescue never runs and the
    // session locks. With a refold hook: arm, let the caller re-run prepare+
    // preflight against the window the upstream STATED (per-call override, no
    // learning), and re-send the folded body ONCE within this same request. An
    // unchanged body (nothing foldable), a null refold, or a transport failure
    // falls back to today's verbatim passthrough below.
    if (
        overflowRefold &&
        prepared?.session &&
        (upstreamResult.response.status === 400 || upstreamResult.response.status === 413) &&
        upstreamResult.response.body &&
        res.writable &&
        !res.writableEnded &&
        !res.destroyed
    ) {
        let overflowText: string | null = null;
        try {
            overflowText = (await readStreamToBuffer(upstreamResult.response.body)).toString("utf8");
        } catch {
            overflowText = null;
        }
        if (overflowText !== null) {
            // Rebuild the consumed body (same shape as the role ladder above)
            // so the error path below reads the same bytes verbatim.
            upstreamResult = {
                response: new Response(overflowText, {
                    status: upstreamResult.response.status,
                    statusText: upstreamResult.response.statusText,
                    headers: new Headers(upstreamResult.response.headers),
                }),
                clearTimer: upstreamResult.clearTimer,
                stopIdleTimer: upstreamResult.stopIdleTimer,
            };
            const overflowInfo = inspectContextOverflow(upstreamResult.response.status, overflowText);
            if (overflowInfo.imageCountCap !== undefined && prepared!.protocol && typeof wireBody === "string") {
                // #4124: image-COUNT wall — a different dimension than the token
                // overflow below; armOverflowShrink must NOT run (its no-window
                // branch would arm a bogus token-space shrink at the payload
                // estimate). Learn the cap per-origin, converge the outbound copy
                // to cap−1 with the count-shed machinery, and re-send ONCE within
                // this same request. An unchanged body (nothing archivable), a
                // Buffer body (raw passthrough bytes), or a missing protocol falls
                // through to the verbatim passthrough below, which still learns
                // the cap there.
                const s = prepared!.session;
                const imgOrigin = normalizeUpstreamOrigin(upstreamUrl);
                if (imgOrigin !== undefined) {
                    const caps = s.stats.imageCountCaps ?? {};
                    caps[imgOrigin] = overflowInfo.imageCountCap;
                    s.stats.imageCountCaps = caps;
                    markDirty(s);
                }
                const target = Math.max(0, overflowInfo.imageCountCap - 1);
                const countShed = await shedWireImagesToCount(wireBody, prepared!.protocol, target, {
                    resolveRef: (mt, b64) => refForItemBytes(s, mt, b64),
                });
                if (!countShed.stats.changed) {
                    log("warn", `[${s.id}] image-count overflow (upstream cap ${overflowInfo.imageCountCap}, request carried ${overflowInfo.imageCountSeen ?? "?"}) — nothing archivable in the outbound copy (images sit in exempt tool outputs?) — passing the rejection through (#4124)`);
                } else {
                    try {
                        s.metadata.imageCountShed = { at: Date.now(), phase: "same-request-retry", cap: overflowInfo.imageCountCap, archived: countShed.stats.archived };
                        applyResign(headers, countShed.body);
                        const retried = await fetchWithTimeout(upstreamUrl, { ...init, body: v1Wrap(countShed.body) }, undefined, clientAbort.signal);
                        if (retried.response.ok) {
                            upstreamResult.clearTimer();
                            wireBody = countShed.body; // track the accepted re-send as the wire base
                            upstreamResult = retried;
                            log("info", `[${s.id}] image-count overflow (upstream cap ${overflowInfo.imageCountCap}${overflowInfo.imageCountSeen !== undefined ? `, request carried ${overflowInfo.imageCountSeen}` : ""}) — archived ${countShed.stats.archived} oldest images, re-sent within the same request, upstream accepted (#4124)`);
                        } else {
                            let retryErrText: string | null = null;
                            if (retried.response.body) {
                                try {
                                    retryErrText = (await readStreamToBuffer(retried.response.body)).toString("utf8");
                                } catch {
                                    retryErrText = null;
                                }
                            }
                            // Answer with the retry's own verdict, not the stale first 400.
                            upstreamResult.clearTimer();
                            upstreamResult = {
                                response: new Response(retryErrText ?? "", {
                                    status: retried.response.status,
                                    statusText: retried.response.statusText,
                                    headers: new Headers(retried.response.headers),
                                }),
                                clearTimer: retried.clearTimer,
                                stopIdleTimer: retried.stopIdleTimer,
                            };
                            log("warn", `[${s.id}] image-count overflow — converged to ${target} images but the re-send was still rejected (HTTP ${retried.response.status}; upstream counted ${overflowInfo.imageCountSeen ?? "?"}) — passing the retry verdict through (#4124)`);
                        }
                    } catch {
                        // transport failure — the buffered original 400 answers below
                    }
                }
            } else if (overflowInfo.isOverflow) {
                armOverflowShrink(overflowInfo);
                // #3787 follow-up: a NUMBERLESS overflow states no window; the
                // armed baseline (min of declared and the rejected payload's
                // own estimate) is the only ceiling evidence there is. Judging
                // the refold against the DECLARED window made preflight see
                // "already fits" and return an unchanged body — the rescue
                // then only worked when re-render churn happened to change
                // bytes, which byte-stable rebuilds (#3939 ③) eliminate.
                // The arm is BY CONSTRUCTION the rejected payload's own size,
                // so a refold targeting the arm itself leaves nothing to fold
                // (payload == ceiling on every estimate): fold with a 10%
                // margin under it, the same headroom discipline as the arm's
                // own min(declared, est) clamp — the rejection proved the
                // ceiling is below the payload, give the fold real room.
                const armedWindow = overflowInfo.window ?? (prepared.session.stats.lastInputTokensSource === "overflow-arm" ? Math.floor(prepared.session.stats.lastInputTokens * 0.9) : undefined);
                const refolded = await overflowRefold(armedWindow).catch(() => null);
                if (refolded) {
                    try {
                        // #816 family: the refold rebuilds the body from state
                        // summaries — scrub string bodies again so a lone
                        // surrogate can't poison the retry (see the #1884 seam).
                        const wireRefolded = typeof refolded.body === "string" ? scrubLoneSurrogatesOnWire(refolded.body) : refolded.body;
                        applyResign(headers, wireRefolded);
                        const retried = await fetchWithTimeout(upstreamUrl, { ...init, body: v1Wrap(wireRefolded) }, undefined, clientAbort.signal);
                        if (retried.response.ok) {
                            upstreamResult.clearTimer();
                            wireBody = wireRefolded; // #1900: track the accepted re-send as the wire base
                            upstreamResult = retried;
                            log("info", `[${prepared.session.id}] context overflow — refolded and re-sent within the same request, upstream accepted (#1195)`);
                            prepared = refolded.prepared;
                        } else {
                            let retryErrText: string | null = null;
                            if (retried.response.body) {
                                try {
                                    retryErrText = (await readStreamToBuffer(retried.response.body)).toString("utf8");
                                } catch {
                                    retryErrText = null;
                                }
                            }
                            // Answer with the retry's own verdict, not the stale first 400.
                            upstreamResult.clearTimer();
                            upstreamResult = {
                                response: new Response(retryErrText ?? "", {
                                    status: retried.response.status,
                                    statusText: retried.response.statusText,
                                    headers: new Headers(retried.response.headers),
                                }),
                                clearTimer: retried.clearTimer,
                                stopIdleTimer: retried.stopIdleTimer,
                            };
                            log("warn", `[${prepared.session.id}] context overflow — refold retry still rejected (HTTP ${retried.response.status}); passing the retry response through (#1195)`);
                        }
                    } catch {
                        // transport failure — the buffered original 400 answers below
                    }
                }
            }
        }
    }
    const { response: upstream, clearTimer: clearUpstreamTimer } = upstreamResult;
    // [#1343] delivery decided: the attached full text rode THIS request's body, so settle
    // its lifecycle here — delivered on a 2xx, dropped-and-logged otherwise. The ack is
    // already out to the agent, so a failure must be observable + correctable, not silent.
    if (prepared && prepared.attachedRetrievals && prepared.attachedRetrievals.length > 0) {
        const aRefs = prepared.attachedRetrievals.map((i) => i.ref);
        if (upstream.ok) commitRetrievals(prepared.session, aRefs);
        else dropRetrievals(prepared.session, aRefs, `upstream HTTP ${upstream.status}`);
    }
    // [#1457] corrective notes settle on the SAME boundary but are never DROPPED:
    // committed only when upstream accepted (the model actually saw them); on any
    // failure they stay pending and ride the next request. Not gated on
    // attachedRetrievals — a request may carry a note without any full text.
    if (prepared && prepared.attachedRetrievalNoteIds && prepared.attachedRetrievalNoteIds.length > 0 && upstream.ok) {
        commitRetrievalNotes(prepared.session, prepared.attachedRetrievalNoteIds);
    }
    const respHeaders: Record<string, string> = {};
    const respConnNamed = connectionNamedHeaders(upstream.headers.get("connection") ?? undefined);
    upstream.headers.forEach((v, k) => {
        const lower = k.toLowerCase();
        if (UPSTREAM_HOP_HEADERS.has(lower) || RESPONSE_ONLY_STRIP_HEADERS.has(lower) || respConnNamed.has(lower)) return;
        respHeaders[k] = v;
    });
    if (opts.debug) {
        const respLog: Record<string, string> = {};
        upstream.headers.forEach((v, k) => {
            const lower = k.toLowerCase();
            if (UPSTREAM_HOP_HEADERS.has(lower) || RESPONSE_ONLY_STRIP_HEADERS.has(lower) || respConnNamed.has(lower)) return;
            const masked = maskHeaderForLog(k, v);
            respLog[k] = masked.length > 300 ? masked.slice(0, 300) + "..." : masked;
        });
        log("info", `[${prepared?.session.id ?? "unknown"}] ← upstream response headers: ${JSON.stringify(respLog)}`);
    }
    if (rawBase) {
        try {
            const hdrText = Object.entries(maskHeadersForLog(respHeaders))
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n");
            const resPath = `${rawBase}-RES.txt`;
            fs.writeFileSync(resPath, `${upstream.status}\n${hdrText}\n`);
            log("info", `[debug] RAW response dump: ${resPath}`);
            gcDumpDirIfConfigured(path.dirname(rawBase));
        } catch (err) { logDumpFailure("RES dump", err); }
    }
    // P1.2: if the upstream returned a non-2xx (auth, rate-limit, context too
    // long, ...), do NOT route the error body through the SSE rewriter — it has
    // no SSE events and would be silently swallowed, leaving the client with
    // an empty stream and no idea why. Pass status + body through verbatim.
    // (writeHead is done HERE, only in the error branch, so we never double-
    // write headers when a later branch would also call writeHead.)
    if (!upstream.ok) {
        // Buffer the (small) error body so a context overflow can be detected:
        // when the configured window is wrong (e.g. the 200k fallback for an
        // unknown model on a relay) an upstream 400 is the only reliable signal
        // that the real window is smaller. Learn the window, arm an emergency
        // shrink for the next turn, then pass the error through verbatim. When
        // the #1195 same-request refold above already ran, this is the
        // passthrough of last resort (retry rejected / nothing foldable).
        let errBody: Buffer | null = null;
        if (upstream.body) {
            try {
                errBody = await readStreamToBuffer(upstream.body);
            } catch {
                errBody = null; // body consumed/broken — respond with status only
            }
        }
        if (prepared?.session && errBody) {
            const s = prepared.session;
            const errText = errBody.toString("utf8");
            const info = inspectContextOverflow(upstream.status, errText);
            if (info.isOverflow) {
                armOverflowShrink(info);
            } else if (info.imageCountCap !== undefined) {
                // #4124: an image-count wall reached this path without the
                // same-request rescue above (no refold hook / response not
                // writable / no protocol) — still LEARN the cap per-origin so
                // the next request on this route converges pre-send. Never arms
                // the token-space shrink (a count is not tokens).
                const imgOrigin = normalizeUpstreamOrigin(upstreamUrl);
                if (imgOrigin !== undefined) {
                    const caps = s.stats.imageCountCaps ?? {};
                    caps[imgOrigin] = info.imageCountCap;
                    s.stats.imageCountCaps = caps;
                    markDirty(s);
                }
                log("warn", `[${s.id}] upstream image-count wall (cap ${info.imageCountCap}, request carried ${info.imageCountSeen ?? "?"}) — learned for pre-send convergence on this route; no token-space arm (#4124)`);
            } else if (isMarkerlessOverflowReject(upstream.status, errText)) {
                // #4452: the gateway rewrote this overflow-shaped reject into a body with no
                // parseable marker, so bili's self-heal cannot engage from it — name that here
                // (+ the last meter reading) so a body-rewriting gateway's silent starvation is
                // diagnosable from the log rather than the opaque line further down.
                const est = s.stats.lastInputTokens > 0 ? s.stats.lastInputTokens : 0;
                const win = typeof s.metadata.effectiveContextLimit === "number" && s.metadata.effectiveContextLimit > 0 ? s.metadata.effectiveContextLimit : 0;
                const meterNote = est > 0 && win > 0 ? `; last settled input ~${Math.round(est)} vs effective window ${win}` : "";
                log("warn", `[${s.id}] ← upstream ${upstream.status} carries no parseable overflow marker (an intermediate gateway rewrote the rejection body?) — bili's overflow self-heal (refold / emergency-shrink / window-learn) CANNOT engage from this rejection${meterNote}; repeated at similar size = calibration-starved route (#4452)`);
            }
            // #762: learn strict-echo on the MAIN request path too. The loop-only
            // learner (src/loop/core.ts) never sees client-originated 400s, so a
            // first post-fold rejection left strictReasoningEcho unset — #651 kept
            // dropping reasoning and every following turn split again.
            // #2169: match BOTH field spellings — the chat wire says
            // reasoning_content, DeepSeek's Responses wire says reasoning_text.
            if (upstream.status === 400 && /reasoning_(?:content|text)/i.test(errText)) {
                if (s.metadata.strictReasoningEcho !== true) {
                    s.metadata.strictReasoningEcho = true;
                    markDirty(s);
                    log("warn", `[${s.id}] upstream 400 mentions a reasoning echo field — learned strictReasoningEcho for this session (#684/#762/#2169); reasoning-drop disabled`);
                }
            }
        }
        // #604: relay/gateway 5xx — no usage report will arrive, so arm the
        // emergency shrink with a local estimate of the wire body we just sent
        // (see armFailureShrink for the deadlock this breaks). A generic relay
        // error carries no overflow marker or window number, so this is its only
        // self-heal path; a 5xx whose body DOES match an overflow marker was
        // already armed by the overflow path above, and armFailureShrink's
        // overflow-arm guard keeps this estimate from demoting that ceiling (#2484).
        if (prepared?.session && upstream.status >= 500) {
            armFailureShrink(prepared, log, `upstream ${upstream.status}`, outboundPayloadBreakdown(prepared, opts, route, req.url ?? "").armEstimate);
        }
        // #174: always log a non-2xx upstream response (status + request-id +
        // body snippet) — a 4xx/5xx with zero log trace is a diagnostic
        // black hole (issue #2).
        const errSid = prepared?.session.id ?? "unknown";
        const reqId = upstream.headers.get("x-request-id") ?? upstream.headers.get("request-id");
        const reqIdText = reqId ? ` request-id=${reqId}` : "";
        const bodyText = errBody ? new TextDecoder().decode(errBody) : "";
        let snippet = bodyText.slice(0, 600).replace(/\s+/g, " ").trim();
        if (bodyText.length > 600) snippet += " …";
        if (!snippet) snippet = "(no body)";
        loggerLog("warn", `[${errSid}] ← upstream ${upstream.status}${reqIdText}: ${snippet}`);
        // #4204: feed the egress throttle governor with this send's FINAL verdict
        // (one observation per request — in-request refolds/resends above all
        // converge into this same response handling). A 429 arms/extends the
        // hold; ANY other resolved status proves the endpoint is processing
        // again and clears it.
        if (req.method !== "GET" && req.method !== "HEAD") {
            if (upstream.status === 429) noteUpstreamThrottle429(upstreamUrl, headers, upstream.headers.get("retry-after"));
            else noteUpstreamThrottleResolved(upstreamUrl, headers, upstream.status);
        }
        // #762: persist the exact forwarded body on 4xx (env-gated: BILI_DUMP_4XX=1).
        if (upstream.status >= 400 && upstream.status < 500) {
            dumpRejectedBody(upstream.status, errSid, wireBody);
        }
        if (res.headersSent) {
            // #568: the preflight hold already committed 200 early — the status can no
            // longer change, so deliver the upstream failure in-band (protocol error
            // event for streams; verbatim error body under 200 otherwise).
            if (prepared?.stream) {
                emitStreamError(res, prepared.protocol, `upstream HTTP ${upstream.status}: ${snippet}`, (m) => loggerLog("info", m), opts.streamErrorShape);
            } else {
                try { res.end(errBody ?? undefined); } catch { /* client gone */ }
            }
            clearUpstreamTimer();
            return;
        }
        const errHeaders: Record<string, string> = { ...respHeaders };
        // Drop the upstream framing headers unconditionally: when errBody is
        // present a fixed-length write replaces them, and when errBody is
        // null (broken body stream) the response ends with no body — a
        // content-length/transfer-encoding claiming bytes that never arrive
        // would leave the client on a broken response.
        delete errHeaders["content-length"];
        delete errHeaders["transfer-encoding"];
        res.writeHead(upstream.status, errHeaders);
        res.end(errBody ?? undefined);
        clearUpstreamTimer();
        return;
    }
    // 2xx path: now safe to commit the status + headers, then stream the body.
    // When the #568 hold already committed an early 200, the upstream's own
    // headers (x-request-id etc.) are dropped — informational only.
    if (!res.headersSent) {
        // #4082 negotiated-session protocol: surface the server's own session
        // id so a cooperating client can carry stable identity on retries and
        // model switches (fetch → response carries the id → later fetches send
        // it back). The dsh recall bridge does not need it (it learns at
        // beforeSend), but any client may adopt the header directly.
        if (prepared !== null) respHeaders["x-bili-session"] = prepared.session.id;
        res.writeHead(upstream.status, respHeaders);
    }
    // #4204: success-side counterpart of the non-2xx observation above — a
    // resolved 2xx proves the endpoint is accepting sends again, so clear any
    // hold on this origin+credential (counterpart needed because the non-ok
    // branch returns early and never reaches this point).
    if (req.method !== "GET" && req.method !== "HEAD") noteUpstreamThrottleResolved(upstreamUrl, headers, upstream.status);
    // #3376: idle prompt-cache keepalive — snapshot the EXACT accepted bytes
    // and arm the TTL-refresh timer. Pipeline-prepared requests only
    // (passthrough stays out of scope); internally gated to anthropic-wire
    // POSTs and never throws into the response path.
    if (prepared) {
        noteSuccessfulForward({
            sessionId: prepared.session.id,
            protocol: prepared.protocol,
            reqMethod: req.method ?? "",
            sidePassthrough: prepared.sidePassthrough === true,
            resignLane: resignCtx !== undefined,
            wireBody: typeof wireBody === "string" ? wireBody : undefined,
            upstreamUrl,
            headers,
            dispatcher,
            routes: opts.routes,
        });
    }
    if (!upstream.body) {
        res.end();
        clearUpstreamTimer();
        if (prepared?.resetAfterSuccess) {
            log("warn", `[${prepared.session.id}] native compact response had no body; rebase NOT scheduled`);
        } else {
            // #821: a 2xx with a null body (e.g. upstream answered 204/304) is a
            // SILENT empty response — the client receives zero SSE chunks and
            // reports an "empty stream" with no trace in the log. Name it.
            loggerLog("warn", `[${prepared?.session.id ?? "unknown"}] ← upstream ${upstream.status} returned a null body; responding empty to client`);
        }
        return;
    }
    // #1647: hold the client across streaming-phase silence — upstream pings
    // swallowed by the rewrite/strip pipes, buffered rounds (see
    // beginStreamKeepalive). SSE only: comment injection is framing-safe only
    // where the body is an event stream. Self-clears on res close.
    if (
        prepared?.stream === true &&
        (upstream.headers.get("content-type") ?? "").includes("text/event-stream")
    ) {
        beginStreamKeepalive(res, prepared.session.id, log);
    }
    // #1536: origin of the URL fetched for THIS request — cache-invalidation
    // attribution identity shared by the plugin pipes below and the compress
    // loop further down (proxyUrl is the routing CONNECT-proxy, not the
    // endpoint; the outer upstreamOrigin is the configured route target).
    let targetOrigin: string | undefined;
    try { targetOrigin = new URL(upstreamUrl).origin; } catch { targetOrigin = undefined; }
    let dumpRaw: Promise<void> | undefined;
    // Plugin mode: the agent's native loop owns the tool surface — pass the
    // response through VERBATIM (a model-emitted compress call must reach the
    // plugin untouched) while sniffing usage so lastInputTokens (the input to
    // the next nudge decision) keeps tracking reality. The one exception: the
    // opt-in #371 fake-completion backstop buffers + retries first, same as
    // proxy mode (#473).
    if (prepared?.pluginMode) {
        // m00885 provenance gate: the request body is where the kernel
        // injects its "[ACP absorb]" instruction, so only an absorb-instructed
        // request may have its whole-field tool-call prose dropped. wireBody
        // is the exact shipped bytes (string or Buffer — .includes(string)
        // works on both).
        const absorbInstructed = wireBody.includes(ABSORB_INSTRUCTION_MARKER);
        // m00885: the shipped request text doubles as the echo provenance — a
        // tool-call-shaped span the user asked to output verbatim sits in the
        // request, so an identical span in the response is an echo, not a
        // model-invented emission.
        const wireBodyText = typeof wireBody === "string" ? wireBody : wireBody.toString("utf8");
        // #3456: prime the phantom-attachment ledger with every attachment
        // identifier this request ships — the response-side scan treats
        // anything seen in requests as known (see src/phantom-attachment.ts).
        noteKnownAttachmentIds(prepared.session?.id, wireBodyText);
        // #411: clear the idle timer on every path — resolveFakeCompletion and
        // other failures still escape these pipes; without a finally each one
        // leaked a live idle timer. (#721/#2563: the SSE pipes themselves no
        // longer rethrow an upstream cut — they emit an in-band truncation
        // signal, or end raw for permitlist hosts that own the handling.)
        try {
            let pluginBody = upstream.body as ReadableStream<Uint8Array>;
            if (prepared.stream && maxFakeCompletionRetries() > 0) {
                // #1900: retry from wireBody — the exact bytes this request's main
                // attempt shipped (post wireTransform and any same-request re-send),
                // never the raw client body: upstream may have rejected those raw
                // bytes earlier in this session, and a 400'd hint would present the
                // fake completion. The agent owning compression does not change this:
                // the retry is a proxy→upstream HTTP call whose base must be what
                // upstream just accepted (aligned with the proxy lane below).
                const resolvedBuf = await resolveFakeCompletion(pluginBody, {
                    protocol: prepared.protocol,
                    wireBody,
                    upstreamUrl,
                    reqHeaders: buildForwardHeaders(headers), resign: applyResign,
                    proxyUrl,
                    signal: clientAbort.signal,
                    session: prepared.session,
                    log,
                });
                pluginBody = bufferToStream(resolvedBuf);
            }
            // #2347: raw-dump twin of the tee below — this branch returns
            // before reaching it, so plugin-mode turns need their own.
            if (opts.dumpSse && prepared.stream && pluginBody) {
                const [a, b] = pluginBody.tee();
                pluginBody = a;
                dumpRaw = dumpStreamToFile(b, opts.dumpSse, `${Date.now()}-${safeSessionId(prepared.session.id)}-raw.sse`);
            }
            if (prepared.stream) {
                // #2328: what the pipes know about the upstream HTTP response —
                // first attempt's status/content-type (a resolveFakeCompletion
                // re-send is not reflected; the pipes' own diag says which
                // retry budget was spent instead).
                const upstreamMeta: UpstreamMeta = { status: upstream.status, contentType: upstream.headers.get("content-type") ?? undefined };
                // #2346: intrinsic runaway-enumeration terminator for the plugin-streamed
                // body (the incident lane). Applied after any fake-completion buffering so
                // both the live and replayed paths are guarded; byte-verbatim otherwise.
                // Sits AFTER the #2347 plugin-lane tee on purpose: the dump twin must
                // observe the raw upstream bytes even when the guard aborts them.
                pluginBody = wrapStreamWithRunawayGuard(pluginBody, (v) => {
                    log("error", `[${prepared.session.id}] output-side runaway guard tripped (${v.reason}; ${JSON.stringify(v.detail)}) — aborting upstream stream`);
                    clientAbort.abort();
                });
                if (prepared.protocol === "responses") {
                    // #732/#821 applies to this pipe too (#871): the agent's own
                    // body, held here with its URL and headers, is re-issued once
                    // when the turn completes with nothing visible.
                    await pipePluginResponsesWithStrip(
                        pluginBody,
                        res,
                        prepared.session,
                        (msg) => log("info", `[${prepared.session.id}] ${msg}`),
                        makeContinuationRefetch({
                            protocol: "responses",
                            body,
                            upstreamUrl,
                            reqHeaders: buildForwardHeaders(headers), resign: applyResign,
                            proxyUrl,
                            dispatcher,
                            signal: clientAbort.signal,
                            log,
                            label: prepared.session.id,
                        }),
                        targetOrigin,
                        absorbInstructed,
                        wireBodyText,
                        upstreamMeta,
                        reply,
                    );
                } else {
                    // #732/#821: the plugin pipe re-issues the agent's own body
                    // once when a turn ends with nothing visible (the render-tag
                    // echo case) — it holds the URL and headers, this is where
                    // they live.
                    await pipePluginChatWithStrip(
                        pluginBody,
                        res,
                        prepared.protocol,
                        prepared.session,
                        (msg) => log("info", `[${prepared.session.id}] ${msg}`),
                        makeContinuationRefetch({
                            protocol: prepared.protocol,
                            body,
                            upstreamUrl,
                            reqHeaders: buildForwardHeaders(headers), resign: applyResign,
                            proxyUrl,
                            dispatcher,
                            signal: clientAbort.signal,
                            log,
                            label: prepared.session.id,
                        }),
                        targetOrigin,
                        absorbInstructed,
                        wireBodyText,
                        upstreamMeta,
                        reply,
                    );
                }
            } else {
                await pipePluginJson(pluginBody, res, prepared.session, prepared.protocol, targetOrigin, absorbInstructed, wireBodyText, reply);
            }
        } finally {
            clearUpstreamTimer();
            // #2347: finish the dump before the turn closes — its value is the
            // full upstream tail, which the client may have stopped reading early.
            if (dumpRaw) await dumpRaw;
        }
        return;
    }
    if (prepared && prepared.protocol === "responses" && prepared.stream && !prepared.sidePassthrough && !prepared.compressInjected) {
        const sse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
        if (sse) {
            let reqModel: string | undefined;
            try {
                const wb = typeof wireBody === "string" ? wireBody : wireBody.toString("utf8");
                const parsed = JSON.parse(wb) as Record<string, unknown>;
                if (typeof parsed.model === "string") reqModel = parsed.model;
            } catch { /* non-JSON body: guard stays off */ }
            const rg = resolveCompress(opts.routes, upstreamUrl, reqModel, opts.compress).reasoningGuard;
            if (rg && reasoningGuardEngages(rg)) {
                log("info", `[reasoning-guard] engaged model=${reqModel ?? "?"} session=${prepared.session?.id ?? "-"}`);
                await runReasoningGuard({
                    firstResponse: upstream,
                    clearFirstTimer: clearUpstreamTimer,
                    upstreamUrl,
                    reqHeaders: buildForwardHeaders(headers), resign: applyResign,
                    dispatcher,
                    originalBody: wireBody,
                    signal: clientAbort.signal,
                    res,
                    config: rg,
                    log: (msg) => log("info", msg),
                });
                return;
            }
        }
    }
    // #371: detect + retry a fake completion for every non-plugin streaming
    // response (any turn, not just compress-injected). Buffering is required:
    // the retry re-requests before the client sees the fake completion.
    let responseBody: ReadableStream<Uint8Array> = upstream.body;
    // #411: every body-consuming path below must clear the upstream idle timer
    // even when it throws (client abort / upstream cut) — previously an abort
    // skipped the trailing clearUpstreamTimer and leaked a live idle
    // timer plus its socket for the full window.
    try {
        if (prepared !== null && prepared.stream && !prepared.sidePassthrough && maxFakeCompletionRetries() > 0) {
            // #1900: retry from wireBody — the exact bytes this request's main
            // attempt shipped (post wireTransform and any same-request re-send),
            // never the raw client body: upstream may have rejected those raw
            // bytes earlier in this session, and a 400'd hint would present the
            // fake completion instead of a corrected turn.
            const resolvedBuf = await resolveFakeCompletion(upstream.body, {
                protocol: prepared.protocol,
                wireBody,
                wrapBody: v1Active ? v1Wrap : undefined,
                upstreamUrl,
                reqHeaders: buildForwardHeaders(headers), resign: applyResign,
                proxyUrl,
                signal: clientAbort.signal,
                session: prepared.session,
                log,
            });
            responseBody = bufferToStream(resolvedBuf);
        }
    // #2347: dump the FINAL upstream body for every prepared streaming turn,
    // regardless of rewriter branch — the previous tee sat INSIDE the useRewriter
    // branch, so non-injected turns never dumped (the plugin lane above has its
    // own twin tee before its early return). Must stay AFTER resolveFakeCompletion
    // (it replaces responseBody wholesale; teeing earlier dumps the discarded
    // stream) and BEFORE the branch split.
    if (opts.dumpSse && prepared !== null && prepared.stream && responseBody) {
        const [a, b] = responseBody.tee();
        responseBody = a;
        dumpRaw = dumpStreamToFile(b, opts.dumpSse, `${Date.now()}-${safeSessionId(prepared.session.id)}-raw.sse`);
    }
    // #3129: v1internal response envelope — unwrap upstream frames so every
    // branch below (compress loop, strip pipes, JSON rewriter) reads a standard
    // GenerateContentResponse, and wrap every frame written back to the client
    // (including bili's synthesized acp_status / Compressed markers) into the
    // {"response":...} envelope Antigravity's language_server requires.
    if (v1Active && prepared !== null) {
        installV1ResponseFramer(res);
        if (responseBody) responseBody = v1UnwrapStream(responseBody);
    }
    // We only rewrite when THIS request actually had the compress tool
    // injected (per-request). Non-injected requests (OpenAI title-gen
    // exclusion, ACP_NO_INJECT_TOOL, auto-mode classifier bypass) must NOT
    // enter the compress loop — but their chat SSE still gets render-tag
    // echo stripping (#460) below, so history-borne tags echoed in model
    // prose cannot leak to the client and amplify via its replay.
    const useRewriter =
        prepared !== null &&
        prepared.compressInjected &&
        prepared.processedMessages.length > 0;
    if (!useRewriter || prepared === null) {
        // #2328: pipes cite the first upstream response's HTTP identity.
        const upstreamMeta: UpstreamMeta = { status: upstream.status, contentType: upstream.headers.get("content-type") ?? undefined };
        if (prepared && prepared.resetAfterSuccess) {
            const [toClient, toObserve] = responseBody.tee();
            const observed = observeResponsesTerminalState(toObserve, prepared.stream);
            const tagLog = (msg: string) => log("info", `[${prepared.session.id}] ${msg}`);
            // #460 residual: a native compaction turn is by definition the
            // compression-triggered one, so its context necessarily carries
            // render tags — its echoed prose is the likeliest leak of any
            // Responses stream. Same pipe as the non-injected branch below;
            // no session, so usage accounting stays off.
            if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
                await pipePluginResponsesWithStrip(
                    toClient,
                    res,
                    undefined,
                    tagLog,
                    makeContinuationRefetch({
                        protocol: "responses",
                        body,
                        upstreamUrl,
                        reqHeaders: buildForwardHeaders(headers), resign: applyResign,
                        proxyUrl,
                        dispatcher,
                        signal: clientAbort.signal,
                        log,
                        label: prepared.session.id,
                    }),
                    undefined,
                    undefined,
                    undefined,
                    upstreamMeta,
                    reply,
                );
            } else {
                await pipeThrough(toClient, res);
            }
            const terminal = await observed;
            if (terminal === "completed") {
                await withSessionLock(prepared.session, () => markNativeCompactionBoundary(prepared.session));
                log("info", `[${prepared.session.id}] native Responses compact completed; rebase scheduled for next Responses turn`);
            } else {
                log("warn", `[${prepared.session.id}] native compact response terminal=${terminal}; rebase NOT scheduled`);
            }
        } else if (
            prepared &&
            prepared.stream &&
            (upstream.headers.get("content-type") ?? "").includes("text/event-stream")
        ) {
            // #460: same strip pipes as plugin mode; byte-identical for
            // tag-free streams. No session is passed: usage accounting must
            // stay off here, or a title-gen call's tiny input_tokens would
            // clobber lastInputTokens and break compression triggering for
            // the main conversation (see pipePluginChatWithStrip docs).
            const p = prepared;
            const tagLog = (msg: string) => log("info", `[${p.session.id}] ${msg}`);
            if (p.protocol === "responses") {
                await pipePluginResponsesWithStrip(
                    responseBody,
                    res,
                    undefined,
                    tagLog,
                    makeContinuationRefetch({
                        protocol: "responses",
                        body,
                        upstreamUrl,
                        reqHeaders: buildForwardHeaders(headers), resign: applyResign,
                        proxyUrl,
                        dispatcher,
                        signal: clientAbort.signal,
                        log,
                        label: p.session.id,
                    }),
                    undefined,
                    undefined,
                    undefined,
                    upstreamMeta,
                    reply,
                );
            } else {
                await pipePluginChatWithStrip(
                    responseBody,
                    res,
                    p.protocol,
                    undefined,
                    tagLog,
                    makeContinuationRefetch({
                        protocol: p.protocol,
                        body,
                        wrapBody: v1Active ? v1Wrap : undefined,
                        upstreamUrl,
                        reqHeaders: buildForwardHeaders(headers), resign: applyResign,
                        proxyUrl,
                        dispatcher,
                        signal: clientAbort.signal,
                        log,
                        label: p.session.id,
                    }),
                    undefined,
                    undefined,
                    undefined,
                    upstreamMeta,
                    reply,
                );
            }
        } else if (
            prepared &&
            (upstream.headers.get("content-type") ?? "").includes("application/json")
        ) {
            // #460 residual: the non-streaming twin of the branch above. The
            // compress loop's JSON rewriters strip render tags from every round,
            // so a non-injected JSON response must not hand the model's echoes
            // back untouched. Same pipe as plugin mode; no session, so usage
            // accounting stays off for the same reason as above.
            await pipePluginJson(responseBody, res, undefined, prepared.protocol, undefined, undefined, undefined, reply);
        } else {
            await pipeThrough(responseBody, res);
        }
        // #2347: the raw-SSE dump is finished in the safety-net finally below —
        // an inline await here would be skipped when a pipe rejects.
        return;
    }
    const ctx: RewriteCtx = {
        core,
        config,
        messages: prepared.originalMessages,
        session: prepared.session,
        log: (msg: string) => log("info", `[${prepared.session.id}] ${msg}`),
        debug: opts.debug,
        lastNudge: prepared.nudge,
    };
    if (prepared.stream) {
        // #2346: intrinsic runaway-enumeration terminator for the streamed response —
        // aborts the upstream and ends the stream cleanly when one message degenerates
        // into an unbounded marker flood. Forwards every byte verbatim otherwise.
        // Master moved the #2347 dump tee ahead of the branch split (it reassigns
        // responseBody), so the guard wraps the post-tee body: the dump twin still
        // observes raw upstream bytes even when the guard aborts them.
        responseBody = wrapStreamWithRunawayGuard(responseBody, (v) => {
            log("error", `[${prepared.session.id}] output-side runaway guard tripped (${v.reason}; ${JSON.stringify(v.detail)}) — aborting upstream stream`);
            clientAbort.abort();
        });
        // P1.1: wrap the rewriter loops in try/catch. If a rewriter throws
        // (decompress/search edge case, JSON.parse failure, fetch abort),
        // emitStreamError sends a protocol-appropriate error + finish so the
        // client ends cleanly instead of seeing a bare truncated stream.
        try {
            const parsedReq = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
            const reqHeaders = buildForwardHeaders(headers);
            const textProtocol = prepared.protocol === "responses" && !!prepared.responsesTextProtocol;
            // Same absorb gate as prepare*: the section only exists where the
            // tool is callable, keeping loop re-requests byte-consistent with
            // the first request (prefix-cache anchor).
            const absorbBlock = effectiveAbsorbBlock(prepared.pluginMode === true, config, opts.compress.absorb);
            const absorbActive = absorbBlock?.enabled === true && opts.compress.injectTool && !textProtocol;
            const loopConfig = ccrLoopConfig(prepared.session, { ...config, absorb: absorbActive ? absorbBlock : undefined });
            // Cache-seam: the compress<->absorb join must be byte-identical to
            // the steady prepare* paths. Every steady wire joins the absorb
            // section with a plain "\n\n" (sysParts.join / injectSystem parts
            // join); the historical "---" divider here existed ONLY on round-2
            // and broke the system-element prefix on every fold while absorb
            // was armed (probe: cache-seam-probes P1+P2, chat wire diverged at
            // the absorb boundary char).
            const absorbSection = absorbActive
                ? `\n\n${buildAbsorbSystemPrompt(absorbToolName(loopConfig))}`
                : "";
            const visibilityMarkers = resolveCompress(opts.routes, route?.rewrittenUrl, (parsedReq as { model?: string }).model ?? prepared.model, opts.compress).visibilityMarkers ?? true;
            // #3298 cache-seam parity: every steady prepare* path appends the
            // project-attribution outermost, so the round-2 rebuild must too or
            // the head bytes drift at every fold.
            // absorbSection sits OUTSIDE withProjectAttribution: every steady
            // prepare* path appends the attribution to the compress prompt and
            // only THEN pushes the absorb section (sysParts order). Nesting it
            // inside flipped the two sections on round-2 and broke the
            // system-element prefix at every fold (cache-seam-probes P1+P2/P3).
            // #4344: the round-2 rebuild threads the MCP-dialect note inside the
            // same nesting for byte-parity with the steady prepare paths. Round-2
            // is proxy-loop-only today (proxy mode never sets the flag — bili
            // injects the bare tools there), so `prepared.mcpDialectNote === true`
            // is the explicit seam, not a live branch yet.
            // #4305 cache-seam parity: the standing generation-boundary note sits
            // between the compress prompt and the absorb section on every steady
            // prepare* path — the round-2 rebuild must keep that exact order or
            // the system-element prefix forks at every fold of an affected session.
            const genBoundaryNote = detectGenerationBoundary(prepared.session, prepared.originalMessages, log) ? `\n\n${GENERATION_BOUNDARY_NOTE}` : "";
            const systemPrompt = withProjectAttribution(withMcpDialectNote(withMarkerIntegrityNote(withSummaryBudgetNote(textProtocol ? buildCompressHybridSystemPrompt(prepared.prompts ?? defaultPrompts, messageTimestampSections(conversationPromptSections(prepared.surface?.promptSections, externalSummaryEnabled(config)), "hybrid")) : buildCompressSystemPrompt(prepared.prompts ?? defaultPrompts, messageTimestampSections(conversationPromptSections(prepared.surface?.promptSections, externalSummaryEnabled(config)))), externalSummaryEnabled(config)), visibilityMarkers), prepared.mcpDialectNote === true)) + genBoundaryNote + absorbSection;
            const adapter = pickAdapter(prepared.protocol, parsedReq, textProtocol, prepared.responsesProjection, prepared.anthropicSystem, prepared.openaiSystemText, absorbActive ? absorbToolName(loopConfig) : undefined, prepared.google, prepared.systemNotes, opts.streamErrorShape, prepared.anthropicCacheMarks, prepared.anthropicClientCacheControls, absorbActive);
            const refreshFolded = async (current: CoreMessage[]): Promise<CoreMessage[]> => {
                return withSessionLock(prepared.session, async () => {
                    // #422: mirror the prepare's fold with the post-compress state so
                    // the re-request shows the compression the model just performed.
                    // Records from this loop round (acp_loop_* namespace) ride on top
                    // so the model still sees its own compress call + result.
                    const turn = core.processTurn({
                        messages: prepared.originalMessages,
                        state: prepared.session.state,
                        config: loopConfig,
                        // #1492 doctrine (secondary processTurn feeds): the round-2
                        // re-render must never light the kernel's emergency bands on
                        // an estimate-grade poison — e.g. a fake/zeroed usage report
                        // (lastInput=0 after the compress credit nets out) falls
                        // through to the inflated pre-fold estimate, arms
                        // emergency-truncate against a context the fold just
                        // shrank, and the truncation marker oscillates per fold
                        // cycle (round-2 truncated, next steady full) — a
                        // mid-history cache break on every fold (#1592 family).
                        // Usage-grade baselines pass through; estimate-grade reads
                        // as 0 ("unknown") and leaves the bands dark.
                        tokenCount: usageGradeInputBaseline(prepared.session),
                        renderTags: prepared.renderTags ?? "text-only",
                        contentStore: contentStoreOf(prepared.session),
                    });
                    prepared.session.state = turn.state;
                    adoptContentStore(prepared.session, turn.contentStore);
                    // #1592-family seam: the absorb view must be fed by the SAME
                    // token-count source the steady prepare* paths use. Feeding
                    // raw lastInputTokens here made round-2 and the neighboring
                    // steady requests disagree across absorb.contextThresholdPct
                    // crossings — absorb prompts appeared/disappeared mid-history
                    // and broke the prefix cache on every fold while the
                    // threshold was being straddled (probe: cache-seam-probes).
                    const viewed = applyAbsorbView(turn.messages, turn.state, loopConfig, effectiveTokenCount(prepared.session, turn.messages).tokens);
                    const records = current.filter((m) => typeof m.id === "string" && m.id.startsWith("acp_loop_"));
                    // #1548: strip only when the compress call rides INBOUND history (client persists
                    // it). Ephemeral acp_loop_* pairs are never re-sent by proxy-mode clients; stripping
                    // against them drops the only cross-turn summary carrier and breaks the byte-prefix
                    // at the fold anchor (post-fold cache floor reset to the stable head).
                    const out = [...stripKernelSummaries(viewed as BiliMessage[], turn.state), ...(records as BiliMessage[])] as BiliMessage[];
                    // [#1592] Mirror the steady path's per-wire post-processing EXACTLY:
                    // the reasoning drop each prepare* applied, and — only on the
                    // Responses wire — the run-ordering repair (#564). Applying the
                    // repair on chat/anthropic/google round-2s injected acp_turn_sep_*
                    // user messages and split assistant runs that the steady paths
                    // never emit, so the folded re-request and the very next client
                    // turn rendered one history with two different shapes and the
                    // byte prefix broke mid-history on every fold.
                    const dropped = prepared.dropReasoning ? prepared.dropReasoning(out) : out;
                    const ordered = prepared.protocol === "responses" ? repairResponsesAssistantOrdering(dropped, prepared.originalMessages) : dropped;
                    return ordered;
                });
            };
            // #1455: loop-originated upstream responses (re-request/retries) are NOT covered by the outer tee above — they were invisible to ACP_DUMP_SSE until now.
            const loopDumpDir = opts.dumpSse;
            // #1843 L1: route identity for image-cost learning, resolved here —
            // the loop has no access to the provider route table. Same billing
            // upstream expression as outboundPayloadBreakdown.
            const loopBillingUpstream = route?.rewrittenUrl ?? (/^https?:\/\//i.test(req.url ?? "") ? req.url ?? undefined : opts.upstream);
            const loop = runCompressLoop(
                responseBody,
                { core, config, messages: prepared.processedMessages.length > 0 ? prepared.processedMessages : prepared.originalMessages, compressMessages: prepared.originalMessages, session: prepared.session, reply, log: ctx.log, proxyUrl, skippedProxy, upstreamOrigin: targetOrigin, protocol: prepared.protocol, textProtocol, debug: opts.debug, refreshFolded, visibilityMarkers, dumpSse: loopDumpDir ? (name, stream) => dumpStreamToFile(stream, loopDumpDir, name) : undefined, imageLearn: { host: upstreamHost(loopBillingUpstream), fp: `${imageBillingFor(opts, loopBillingUpstream)}:${imageTokenCapFor(opts, loopBillingUpstream)}` } },
                parsedReq,
                // #3280: egress goes out enveloped via wireTransform, so every
                // round-2+ response comes back enveloped too — unwrap at the loop's
                // single adoption point or parseStream sees no candidates.
                { url: upstreamUrl, headers: reqHeaders, wireTransform, resign: applyResign, responseStreamTransform: v1Active ? v1UnwrapStream : undefined },
                adapter,
                systemPrompt,
                clientAbort.signal,
            );
            let protocolFragmentWarned = false;
            for await (const chunk of loop) {
                if (res.destroyed || res.writableEnded) break;
                {
                    const s = chunk.toString("utf8");
                    if (s.includes("\x3cacp ") || s.includes("\x3c/acp")) {
                        log("warn", `[${prepared.session.id}] [tag-echo] detected: ${prepared.protocol} response stream contains \x3cacp tag`);
                    } else if (!protocolFragmentWarned && containsToolCallXmlFragment(s)) {
                        protocolFragmentWarned = true;
                        log("warn", `[${prepared.session.id}] [tag-echo] detected: ${prepared.protocol} response stream contains tool-call XML fragment (left untouched)`);
                    }
                }
                res.write(chunk);
                if (res.writableNeedDrain) {
                    await awaitDrain(res);
                }
                if (res.destroyed || res.writableEnded) break;
            }
            res.end();
        } catch (e) {
            emitStreamError(res, prepared.protocol, (e as Error)?.message ?? String(e), (m) => log("error", `[${prepared.session.id}] ${m}`), opts.streamErrorShape);
        } finally {
            clearUpstreamTimer();
            if (dumpRaw) await dumpRaw;
            // #411: persist the final snapshot on every exit (see the
            // non-streaming twin below) — state may have mutated during
            // streaming (compress created a block, decompress deactivated one).
            markDirty(prepared.session);
        }
    } else {
        // Wrap the whole non-streaming branch in try/finally so the upstream
        // timer is always cleared and the session is always persisted — even
        // when arrayBuffer() throws (idle-timeout abort, connection reset). Without
        // this, a thrown arrayBuffer() leaks the timeout and skips markDirty(),
        // losing the persistence of any block this turn's compress created.
        try {
            // #3280: read responseBody, not upstream — in v1 mode the Round-1
            // unwrap above replaced responseBody with a TransformStream that
            // LOCKS upstream.body, so upstream.arrayBuffer() threw "Body is
            // unusable" and every non-streaming CloudCode turn responded 200
            // with an empty body. Non-v1 traffic is unaffected: both pre-branch
            // body swaps (fake-completion, dumpSse tee) are stream-gated, so
            // responseBody === upstream.body there. When v1Active, responseBody
            // is already the unwrapped standard shape (usageMetadata visible to
            // the accounting below); res.end hands the bare JSON to the v1
            // framer, which re-wraps it for the client.
            const buf = responseBody ? Buffer.from(await new Response(responseBody).arrayBuffer()) : Buffer.alloc(0);
            let text = Buffer.from(buf).toString("utf8");
            try {
                let json = JSON.parse(text) as Record<string, unknown>;
                if (prepared.protocol === "responses" && prepared.responsesTextProtocol) {
                    const requestBody = JSON.parse(typeof body === "string" ? body : body.toString("utf8")) as Record<string, unknown>;
                    const requestHeaders = buildForwardHeaders(headers);
                    const visibilityMarkers = resolveCompress(opts.routes, route?.rewrittenUrl, (requestBody as { model?: string }).model, opts.compress).visibilityMarkers ?? true;
                    json = await compressLoopResponsesJson(
                        json,
                        { core, config, messages: prepared.originalMessages, session: prepared.session, log: ctx.log, proxyUrl, textProtocol: true, visibilityMarkers, signal: clientAbort.signal },
                        requestBody,
                        { url: upstreamUrl, headers: requestHeaders, wireTransform, resign: applyResign },
                    );
                }
                // Capture upstream usage so tokenCount (which drives nudge +
                // emergency-truncate) reflects reality for non-streaming
                // sessions too. The streaming loops do this in their SSE
                // event handlers; without it here, lastInputTokens stays 0 for
                // any non-streaming session → compression never fires. Field
                // names differ per protocol:
                //   Anthropic: input_tokens / cache_read_input_tokens / output_tokens
                //   OpenAI: prompt_tokens / prompt_tokens_details.cached_tokens / completion_tokens
                //   Responses: input_tokens / input_tokens_details.cached_tokens / output_tokens
                //   Google: usageMetadata — promptTokenCount / cachedContentTokenCount /
                //     candidatesTokenCount + thoughtsTokenCount
                // usageTotals() normalizes the per-protocol semantics so
                // `total` is always the true context size (see util.ts).
                const rawUsage = prepared.protocol === "google" ? json.usageMetadata ?? json.usage : json.usage;
                const u = (rawUsage ?? {}) as Record<string, unknown>;
                const { total, cached, creation } = usageTotals(prepared.protocol, u);
                const out = usageOutputTotal(prepared.protocol, u);
                // #1547: settle through the shared path — stats AND the cache
                // ledger. Before this, this branch updated stats only, so
                // stream:false sessions produced zero ledger lines and were
                // invisible to /acp-cache, __bili/cache-report and the
                // invalidation attribution built on them (#1536).
                const reportedCached: number | null = typeof cached === "number" ? cached : null;
                const billed = typeof total === "number" ? total : 0;
                if (billed > 0 || reportedCached !== null) {
                    // Use the send-time capture; settlement is not another send.
                    settleUsageReport(prepared.session, { total: billed, reportedCached, output: out, protocol: prepared.protocol, upstream: targetOrigin, creation });
                    if (reportedCached !== null) warnCacheCollapse(prepared.session, billed, reportedCached);
                    const hitPct = reportedCached !== null && billed > 0 ? Math.round((100 * reportedCached) / billed) : undefined;
                    loggerLog("info", `[${prepared.session.id}] [acp-usage] input=${billed} ${hitPct === undefined ? "(no cache report)" : `cached=${reportedCached} (cache hit ${hitPct}%)`}${billed <= 0 ? " (zero-total: lastInputTokens kept)" : ""}`);
                } else {
                    diagnoseSuccessWithoutUsage(prepared.session, "proxy-json");
                }
                if (typeof out === "number") {
                    prepared.session.stats.outputTokens += out;
                    // #4899: output USD billed at the stamped price, in lockstep with the token counter.
                    billOutputUsage(prepared.session, out);
                }
                if (prepared.protocol === "openai") {
                    await withSessionLock(prepared.session, () => rewriteOpenaiJsonResponseAsync(json, ctx, clientAbort.signal));
                } else if (prepared.protocol === "responses") {
                    await withSessionLock(prepared.session, () => rewriteResponsesJsonResponseAsync(json, ctx, clientAbort.signal));
                } else if (prepared.protocol === "google") {
                    await withSessionLock(prepared.session, () => rewriteGoogleJsonResponseAsync(json, ctx, clientAbort.signal));
                } else {
                    await withSessionLock(prepared.session, () => rewriteJsonResponseAsync(json, ctx, clientAbort.signal));
                }
                captureHandoffJson(reply, prepared.protocol, json);
                reply?.save();
                res.end(JSON.stringify(json));
            } catch {
                res.end(text);
            }
        } finally {
            clearUpstreamTimer();
            // #411: persist even when arrayBuffer() throws (client cancel /
            // connection reset) — the comment above promised this, but
            // markDirty sat outside the try and was skipped on the throw path.
            markDirty(prepared.session);
        }
    }
    } finally {
        // #411 safety net: clears on every exit — the early returns above, the
        // rewriter throws, and the fall-through completion. The rewriter paths
        // clear earlier in their own finallys (double-clear is idempotent);
        // this one must sit at the very end so clearing never happens while a
        // live stream still needs the external-abort listener.
        clearUpstreamTimer();
        // #2347: finish the raw-SSE dump before the turn closes — its value is
        // the full upstream tail, which the client may have stopped reading
        // early. Idempotent where the rewriter lane already awaited it in its
        // own finally; this covers the non-rewriter branch's throw paths too.
        if (dumpRaw) await dumpRaw;
    }
}

// #371: buffer the raw upstream response, detect a fake completion (tool-call
// XML, no real tool block), and — bounded per turn and per session — re-request
// upstream with a corrective hint. Returns the bytes to stream to the client
// (the retry's response when a retry recovered, else the original). The session
// streak (metadata.fakeCompletionStreak) counts consecutive fake-completion
// turns: it gates retries (skip once >= cap) and resets to 0 on a clean turn.
// #1900 contract: `wireBody` must be the EXACT bytes this request's main attempt
// shipped upstream (post wireTransform — compat roles / output steering /
// dropFields / chain stamp — and post any same-request re-send such as the #552
// role hop or the #1195 overflow refold). The hinted retry derives from the base
// upstream just accepted; pre-transform client bytes may have been rejected
// earlier in the same session, which would 400 the hint and present the fake
// completion to the user.
async function resolveFakeCompletion(
    stream: ReadableStream<Uint8Array>,
    opts: {
        protocol: WireProtocol;
        wireBody: string | Buffer;
        upstreamUrl: string;
        reqHeaders: Record<string, string>;
        proxyUrl?: string;
        signal: AbortSignal;
        session: Session;
        log: (level: string, msg: string) => void;
        /** #1884: re-sign the retry body before it hits the wire (armed
         *  re-sign lane only; undefined on unsigned traffic). */
        resign?: (headers: Record<string, string>, body: string | Buffer) => void;
        /** #3280: v1internal egress re-wrap — wireBody above is the INNER
         *  request (the hint needs top-level contents), so the hinted retry
         *  must go back out inside the CloudCode envelope. */
        wrapBody?: (body: string | Buffer) => string | Buffer;
    },
): Promise<Buffer> {
    let buffer = await readStreamToBuffer(stream, fakeBufCap());
    const max = maxFakeCompletionRetries();
    const sid = opts.session.id;
    const priorStreak = (opts.session.metadata.fakeCompletionStreak as number | undefined) ?? 0;
    if (max > 0 && priorStreak < max && isFakeCompletion(opts.protocol, buffer.toString("utf8"))) {
        for (let attempt = 1; attempt <= max && !opts.signal.aborted; attempt++) {
            const hinted = injectFakeCompletionHint(opts.protocol, opts.wireBody);
            if (hinted === null) break;
            const wireHinted = opts.wrapBody ? opts.wrapBody(hinted) : hinted;
            opts.log("warn", `[${sid}] fake completion (tool-call XML, no tool block); retry ${attempt}/${max} with corrective hint`);
            let r: Awaited<ReturnType<typeof fetchWithTimeout>>;
            try {
                opts.resign?.(opts.reqHeaders, wireHinted);
                r = await fetchWithTimeout(
                    opts.upstreamUrl,
                    {
                        method: "POST",
                        headers: opts.reqHeaders,
                        body: wireHinted,
                        ...(opts.proxyUrl ? { dispatcher: proxyDispatcher(opts.proxyUrl) } : {}),
                    },
                    undefined,
                    opts.signal,
                );
            } catch (e) {
                opts.log("warn", `[${sid}] fake-completion retry failed: ${String(e)}; presenting original`);
                break;
            }
            try {
                if (!r.response.ok || !r.response.body) {
                    opts.log("warn", `[${sid}] fake-completion retry rejected (HTTP ${r.response.status}); presenting original`);
                    break;
                }
                buffer = await readStreamToBuffer(r.response.body, fakeBufCap());
            } finally {
                r.clearTimer();
            }
            if (!isFakeCompletion(opts.protocol, buffer.toString("utf8"))) break;
        }
    }
    const stillFake = isFakeCompletion(opts.protocol, buffer.toString("utf8"));
    opts.session.metadata.fakeCompletionStreak = stillFake ? priorStreak + 1 : 0;
    markDirty(opts.session);
    return buffer;
}
