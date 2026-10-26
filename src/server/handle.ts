// #1440 P2 cut 3: proxy request pipeline (handle) extracted verbatim from src/server.ts — pure move, zero behavior change.

import http from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { defaultPrompts, type CompressionCore, type Config, type PackSurface, type Prompts } from "acp-kernel";
import { conversationSignalAnthropic, conversationSignalGoogle, conversationSignalOpenai, conversationIdentityResponses, conversationSignalResponses, googleSystemText, type AnthropicRequestBody, type GoogleRequestBody, type OpenAIRequestBody, type ResponsesRequestBody } from "acp-kernel/wire";
import { resolveCompress, resolveCompressPrompts, resolveCompressSurfaceDetailed, resolveRequestConfig } from "../compress-settings.js";
import { FALLBACK_EFFECTIVE_WINDOW_FLOOR, findRoute, findRouteKey, lookupContextLimit, resolveConfiguredContextLimit, resolveConfiguredOutputLimit, resolveCompressProtocol, resolveDeclaredProtocol, type ProxyOptions } from "../config.js";
import { resolveProxyDecision } from "../upstream-proxy.js";
import { contextFromRegistry, peekRegistryContext, peekRegistryOutputLimit, peekRegistryPriceProfile } from "../registry.js";
import { codexAlignedWindow } from "../codex-models.js";
import { DecodedRequestAdmission, DecodedRequestBusyError } from "../request-body-budget.js";
import { hostIdForLog, maskHeadersForLog, maskUrlForLog, maskUrlsInText } from "../log-mask.js";
import { bodyMightCarryImages, buildIncomingImageIndex, pruneRetrieveImgExports, refreshIncomingImageIndex, type IndexedImage } from "../image-restore.js";
import { durableMessageToolPaths, withDurableProtection } from "../durable-message-guards.js";
import { biliToolsDeclaredOnWire, countBiliToolUses, declaresMcpBiliToolsOnWire, evaluateSelfHealRound, pluginLaneDegraded, pluginLaneRestore } from "../session-self-heal.js";
import { acquireInFlight, getSession, hasProcessedState, markDirty, peekSession, releaseInFlight, storeEffectiveConfig, tickPostRebuildAnchor, withSessionLock, type Session } from "../session.js";
import { buildCompressSystemPrompt } from "../compress-tool.js";
import { storeEffectiveSearchPlanAware } from "../decompress-shared.js";
import { externalSummaryEnabled } from "../external-summary-surface.js";
import { estimateRawBodyTokens } from "../preflight.js";
import { gcDumpDirIfConfigured } from "../state-gc.js";
import { imageTokensInParsedBody } from "../image-tokens.js";
import { APIG_RESIGN_CREDENTIAL_HEADER, APIG_RESIGN_HEADER, APIG_RESIGN_SCHEME, clearSignedRefusal, decodeApigCredential, inboundSignedScheme, recordSignedRefusal, signedRefusal } from "../apig-resign.js";
import { conflictScanEnabled, isDesignBenign, scanClientPlugins, sniffScanClient } from "../thirdparty-scan.js";
import { recordConflict } from "../conflict-watch.js";
import { getStore } from "../persist.js";
import { enterSessionContext, log as loggerLog } from "../logger.js";
import { codexCompactGatePre, codexCompactMode, hasCompactionTrigger, isCodexHost, replaceBiliCompactionItems } from "../codex-compact.js";
import { emitPreflightError } from "../stream-error.js";
import { agentProviderRecipes } from "../agent-providers.js";
import { affinityToken, conversationHeaderSource, claudeSubagentAgentId, claudeSubagentSplit, clientConversationHeader, codexTurnIdentity, dshPersonaFingerprintApplies, instructionsFingerprintApplies, openaiSystemTextForPersona, preferPromptCacheKeyIdentity } from "../session-id.js";
import { personaConversationOrder } from "../session-resolve.js";
import { prefixAffinity, describeResumeMiss, type AnonymousAffinity } from "../prefix-affinity.js";
import { buildAnonymousProvenance, type AnonymousProvenance } from "../anon-provenance.js";
import { maybeAdoptForkBlocks, maybeAdoptResume, maybeAdoptDerivedFork } from "../fork-adoption.js";
import { executeThreadsReforge } from "./threads-lane.js";
import { resetThreadTailTracking } from "./thread-tracking.js";
import { resolveClaudeTranscriptLineage } from "../claude-transcript-lineage.js";
import { consumePluginRegisterFor, pluginAgentHeader, pluginConversationHeader, pluginHeadersMatchModel, pluginReportedContextWindow, pluginReportedMaxOutput, pluginReportedModel, pluginRequestAgentHeader, pluginRuntimeInfoFor, pluginRuntimeInfoForConversation, publicForkInputCheck, recordChainVerdict, recordPluginSession, rememberPluginMessages, resolveConversation, runtimeConversationId, takePendingPluginRegister } from "../plugin.js";
import { scheduleAffinityPersist } from "../affinity-persist.js";
import { evaluateChain, extractChainCarriers } from "../chain-checkpoint.js";
import { BILI_PASSTHROUGH_HEADER, BILI_PLUGIN_BYPASS_HEADER, isLoopbackAddress, normalizeUpstreamOrigin, provenCompletionReserve, reserveOutputHeadroom, resolveOutputHeadroomCap, shouldReserveOutputHeadroom, type WireProtocol } from "../util.js";
import { checkTunnelDestination, tunnelAllowlistFromEnv } from "../tunnel-guard.js";
import { resolveCompatDropFields } from "../compat-drop.js";
import { DecompressedTooLargeError, decodeRequestBody } from "../content-encoding.js";
import { autoModeForgeEnabled, dshAuthoredCompactionEnabled, imageRescaleEnabled, limitsDecodedBytes as knobLimitsDecodedBytes, noInjectTool as knobNoInjectTool, rawDumpDir as knobRawDumpDir } from "../knobs.js";
import { buildForgeResponse, classifierForgeVariant, estimateCjkTokens, isAutoModeClassifier, requestText, summarizeAction } from "../auto-mode-forge.js";
import { extractConversationId, isV1BackgroundSideRequest, isV1InternalRequest, unwrapV1Internal } from "../v1internal.js";
import { anthropicBetaContextWindow, BILI_HOP_HEADER, capRegistryWindowByStandard, expandedContextSuffixWindow, launcherContextWindow, launcherMaxOutput, windowSourceLogged } from "./context-window.js";
import { NO_IDENTITY_MESSAGE, safeSessionId } from "./headers.js";
import { demoteGate, hasLeakedBiliToolsOnly, isDshAutoReviewRequest, isDshTitleRequest, isServerToolUtilityCall, isSideRequest, resolveSideLane, restoreOutputBudget, sideRequestGuard, stripLeakedBiliTools } from "./side-request.js";
import { DSH_COMPACTION_SHAPE_MSGS, DSH_REFUSAL_STORM_LOG_EVERY, detectPassthroughDshCompactionCall, dshCompactionRefusal, dshPassthroughGuardStats, isDshCompactionCall } from "./dsh-compaction-guard.js";
import { buildDshCompactionForgeBody, renderDshAuthoredCheckpoint } from "./dsh-authored-compaction.js";
import { artifactSeedHit, detectAcpArtifacts } from "./chain-artifacts.js";
import { piSubagentChannelFallback } from "./pi-subagent-channel.js";
import { FORCE_TEXT_PROTOCOL } from "./inject.js";
import { prepareAnthropic } from "./prepare-anthropic.js";
import { prepareOpenai } from "./prepare-openai.js";
import { prepareGoogle, prepareGoogleCountTokens } from "./prepare-google.js";
import { DUMP_PLAINTEXT_BANNER } from "../dump-banner.js";
import { prepareResponses, prepareResponsesCompact } from "./prepare-responses.js";
import { bodyDumpEnabled, isModelDiscoveryPath, isV1InternalControlPlanePath, logDumpFailure, logUnrecognizedPath } from "./observability.js";
import { adminGateDenial, handleAdminRoute, isManagementPath } from "./admin.js";
import { handleIncrementalTurn, handleIncrementalProbe, incrementalTurnBodyShape, incrementalTurnsEnabled, INCREMENTAL_TURN_MARKER_HEADER, INCREMENTAL_TURN_PATH } from "../incremental-lane.js";
import { handlePluginRender, PLUGIN_RENDER_PATH } from "../plugin-render.js";
import { ccrPluginWireOk, storeEffectiveCcr, storeEffectiveImageRescale, type CcrSettings } from "../store.js";
import { DEFAULT_DECIDE_MAX_TOKENS } from "../nudge-decide.js";
import { BodyTooLargeError, buildForwardTarget, forward, forwardUpstreamUrl, googleModelFromPath, googlePathKind, headroomEffectiveLogged, headroomFallbackLogged, headerValue, imageBillingFor, imageReserveFor, imageTokenCapFor, isCountTokensRequest, isPreflightFailFast, logRequestCost, NON_CONVERSATION_RELAY_WARN_CAP, nonConversationRelayWarned, prepareCountTokens, preflightCompressIfNeeded, readBody, resolveKnownOutputCeiling, resolveUpstream, resignSettingsFor, selfAddressedLocalPath, scrubAnthropicPck, scrubCompatDrop, vertexAnthropicModelFromPath, warnRouteMissIfNew, type Prepared } from "../server.js";
import { normalizeVertexModelId } from "../vertex.js";

// #2986: the derivedFromSessionId link is what keeps a kind child session
// reachable along its parent chain after a restart — without it the shared
// prefix is re-sent whole and over-window requests 503 (the #2985 failure). It
// is established ONCE per child (low write frequency) but markDirty alone only
// persists it on the debounced cadence: a non-graceful exit inside that window
// drops the link and the child is permanently orphaned. Force an immediate
// durable write so the link lands on disk within a tick instead of the debounce
// window. Fire-and-forget on purpose: this runs on the model-request hot path,
// so we must not stall this response or freeze the event loop (unlike
// flushSync's Atomics.wait retry); a failed write logs here and the debounced
// save retries on the next mutation.
function persistLineageLinkNow(session: Session): void {
    void getStore().writeNow(session).catch((err) => {
        loggerLog("warn", `[${session.id}] [lineage] immediate lineage persist failed (${String(err)}); the debounced save will retry (#2986)`);
    });
}

/** Vertex model ids are mixed-convention — `claude-haiku-5-5` is bare while
 *  others carry an `@YYYYMMDD` tag — so the path-derived id is normalised before
 *  any model-keyed lookup. Logged once per raw id: a silent rewrite would make a
 *  lookup miss read as "compression chose not to", and a line per request would
 *  be noise on a stream that re-sends the same id every turn. */
const vertexModelNormalised = new Set<string>();
const VERTEX_MODEL_LOG_CAP = 64;

export async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
    instanceId: string,
    instanceStartedAt: number,
    proxyWatchers: Set<number>,
    initialWatcherPid: number | null,
    adminCtx: Parameters<typeof handleAdminRoute>[2],
): Promise<void> {
    const admission = new DecodedRequestAdmission();
    const decodingAbort = new AbortController();
    const close = () => { if (!res.writableEnded) decodingAbort.abort(); };
    res.on("close", close);
    try {
        // #3248 incremental lane: intercept BEFORE handleAdminRoute — the turn
        // endpoint re-enters this same pipeline with a synthetic anthropic
        // request, which requires module-local access to handleRequest. The
        // /__bili/ security gate is applied explicitly here (same checks as
        // handleAdminRoute, via adminGateDenial).
        if (req.method === "POST" && (req.url ?? "").split("?", 2)[0] === INCREMENTAL_TURN_PATH) {
            const denial = adminGateDenial(req, opts.host);
            if (denial) {
                res.writeHead(403, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: denial }));
                return;
            }
            await handleIncrementalTurn(req, res, log, (syntheticReq, synRes) =>
                handleRequest(syntheticReq, synRes, opts, core, config, log, instanceId, instanceStartedAt, proxyWatchers, initialWatcherPid, adminCtx, new DecodedRequestAdmission(), new AbortController().signal));
            return;
        }
        // #3248 capabilities probe: GET on the turn path (loopback-gated like
        // every /__bili/ surface). Native extensions cache this per proxy
        // base; a 404 on older servers means "no support — stay full-resend".
        if (req.method === "GET" && (req.url ?? "").split("?", 2)[0] === INCREMENTAL_TURN_PATH) {
            const denial = adminGateDenial(req, opts.host);
            if (denial) {
                res.writeHead(403, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: denial }));
                return;
            }
            const conv = new URL(req.url ?? "/", "http://localhost").searchParams.get("conversation");
            handleIncrementalProbe(res, conv !== null && conv.length > 0 ? conv : undefined);
            return;
        }
        // #4491 S4: server-owned transcript render — the client shim splices
        // the returned prefix into its outbound body instead of resending its
        // own history bytes. Loopback-gated like every /__bili/ surface.
        if (req.method === "POST" && (req.url ?? "").split("?", 2)[0] === PLUGIN_RENDER_PATH) {
            const denial = adminGateDenial(req, opts.host);
            if (denial) {
                res.writeHead(403, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: denial }));
                return;
            }
            await handlePluginRender(req, res, log);
            return;
        }
        // #3248 marker divert: a native extension may stamp
        // `x-bili-plugin-turn: 1` on an ORDINARY model request (any /bili/…
        // or bare path, provider baseURL untouched) to send only the delta.
        // Trust class = the plugin marker headers (x-bili-plugin must be
        // present too) AND the management-plane gate (adminGateDenial — same
        // loopback + anti-tunnel + trusted-origin checks as the direct
        // /__bili/plugin/turn entry): the diverted turn re-enters the
        // pipeline carrying the ORIGINAL request URL and writes canonical
        // session state under a caller-chosen conversationId, so a header
        // alone could not bound who reaches applyTurn (#3343). Management
        // prefixes (/__bili/, /__acp/) never ride the divert at all. The
        // marker only declares intent for MODEL paths — the BODY SHAPE is
        // the final word, because a marker'd host may still send full-resend
        // turns (retries, dead conversations, side lanes); those ride the
        // normal pipeline regardless of source address. So: buffer once (the
        // pipeline re-buffers every JSON body anyway), shape-test, then
        // divert or replay. The synthetic re-entries above call handleRequest
        // DIRECTLY (never this divert), so no loops.
        if (req.method === "POST"
            && !isManagementPath((req.url ?? "").split("?", 2)[0])
            && req.headers["x-bili-plugin"] !== undefined
            && req.headers[INCREMENTAL_TURN_MARKER_HEADER] !== undefined) {
            let raw: Buffer;
            try {
                raw = await readBody(req);
            } catch (err) {
                // A failed body read leaves nothing to replay — answer exactly
                // like the normal pipeline would for the same failure (413 on
                // the size cap, 400 on any other stream error) instead of
                // re-sending a half-consumed stream as an empty body.
                if (!res.destroyed && !res.writableEnded) {
                    const tooLarge = err instanceof BodyTooLargeError;
                    log("warn", tooLarge
                        ? `413: request body exceeds ${err.limit} bytes`
                        : `failed to read marked-turn body (${String(err)}) - 400`);
                    res.writeHead(tooLarge ? 413 : 400, { "content-type": "application/json" });
                    res.end(JSON.stringify(tooLarge
                        ? { error: { type: "request_too_large", stage: "receive", message: err.message } }
                        : { error: { type: "invalid_request", message: String(err) } }));
                }
                return;
            }
            if (incrementalTurnBodyShape(raw)) {
                // #3343: shaped turns are lane traffic — loopback-only, same
                // trust class as the direct /__bili/plugin/turn entry. A
                // non-loopback / tunnel / untrusted-origin caller gets 403
                // here instead of reaching applyTurn (which writes canonical
                // session state under a caller-chosen conversationId).
                // Well-behaved remote hosts never send deltas: their GET
                // probe already 403s, so they stay full-resend (replay below).
                const denial = adminGateDenial(req, opts.host);
                if (denial) {
                    res.writeHead(403, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: denial }));
                    return;
                }
                if (!incrementalTurnsEnabled()) {
                    res.writeHead(503, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "incremental turns disabled on this lane (rollout feature pluginIncrementalTurns off, or unified sidecar unavailable)" }));
                    return;
                }
                await handleIncrementalTurn(req, res, log, (syntheticReq, synRes) =>
                    handleRequest(syntheticReq, synRes, opts, core, config, log, instanceId, instanceStartedAt, proxyWatchers, initialWatcherPid, adminCtx, new DecodedRequestAdmission(), new AbortController().signal), (req.url ?? "/v1/messages").split("?", 2)[0], raw);
                return;
            }
            // Marker'd but full-resend: replay through the normal pipeline with
            // the body re-streamed (identical request; the marker is dropped so
            // downstream sees exactly what a non-incremental client sends).
            const replayHeaders = { ...req.headers } as Record<string, string | string[] | undefined>;
            delete replayHeaders[INCREMENTAL_TURN_MARKER_HEADER];
            const replay = Readable.from([raw]) as unknown as http.IncomingMessage;
            Object.assign(replay, { method: req.method, url: req.url, headers: replayHeaders, socket: req.socket });
            await handleRequest(replay, res, opts, core, config, log, instanceId, instanceStartedAt, proxyWatchers, initialWatcherPid, adminCtx, admission, decodingAbort.signal);
            return;
        }
        await handleRequest(req, res, opts, core, config, log, instanceId, instanceStartedAt, proxyWatchers, initialWatcherPid, adminCtx, admission, decodingAbort.signal);
    } finally {
        res.removeListener("close", close);
        admission.release();
    }
}

// #3386: staged heap probes over the local processing window. One oversized
// request can abort the whole process mid-turn (#3386: 25 MiB / 1372 msgs →
// 4 GB heap), and attributing WHICH stage materialized it (raw buffer vs
// toString+JSON.parse graph vs kernel/processTurn rebuild) needs a heap
// sample at each boundary. Gated on the existing --debug flag: zero new
// config surface, zero behavior change when off.
function memProbe(debug: boolean, log: (level: string, msg: string) => void, sessionId: string, stage: string, payloadBytes?: number): void {
    if (!debug) return;
    const mu = process.memoryUsage();
    const mi = (n: number): string => `${Math.round(n / 1048576)}MiB`;
    log("debug", `[${sessionId}] mem-probe ${stage}: heap=${mi(mu.heapUsed)} external=${mi(mu.external)} rss=${mi(mu.rss)}${payloadBytes !== undefined ? ` payload=${payloadBytes}B` : ""}`);
}

async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
    instanceId: string,
    instanceStartedAt: number,
    proxyWatchers: Set<number>,
    initialWatcherPid: number | null,
    adminCtx: Parameters<typeof handleAdminRoute>[2],
    admission: DecodedRequestAdmission,
    decodingSignal: AbortSignal,
): Promise<void> {
    // #1073/#3245: an absolute-form request addressed to THIS instance's own
    // endpoint is a fetch of us, not a tunnel — strip the authority so every
    // downstream stage (admin gate, /bili/ tunnel admission, protocol detection)
    // sees the same origin-form request a direct connection would send. Must run
    // before handleAdminRoute so the admin gate judges the stripped path.
    const selfLocalPath = selfAddressedLocalPath(req.url ?? "", req.socket.localPort);
    if (selfLocalPath !== undefined) req.url = selfLocalPath;

    // #1440 P2 cut 1: the /__bili/* + /__acp/* management surface (security gates +
    // endpoint dispatch) moved to src/server/admin.ts behind the loopback +
    // trusted-origin gate; it answers admin requests itself, and non-admin
    // traffic falls through to the proxy pipeline below.
    await handleAdminRoute(req, res, adminCtx);
    if (res.writableEnded) return;

    // NOTE: WebSocket upgrades are answered by the dedicated 'upgrade' listener
    // in startServer() (above), which is the only reliable path — Node routes
    // upgrade requests there and never to this request handler.
    let bodyBuffer: Buffer;
    let urlPath: string;
    let responsesCompact: boolean;
    let route: ReturnType<typeof resolveUpstream>;
    let upstreamOrigin: string;
    /** #4501: full destination URL this request forwards to — the single basis for
     *  matching providers.* config keys. Path-style requests (no /bili/ tunnel, no
     *  absolute form, non-MITM) leave resolveUpstream undefined so route?.rewrittenUrl
     *  alone misses every per-provider declaration; reconstruct opts.upstream + path
     *  there so config resolves identically across all request forms. */
    let providerDestUrl: string;
    let protocol: WireProtocol | null;
    /** Gemini's model, resolved from the request path (its body never carries
     *  one). Undefined for every other protocol. */
    let googleModel: string | undefined;
    /** Anthropic-on-Vertex's model, resolved from the request path for the same
     *  reason: that wire's body carries `anthropic_version` and never `model`.
     *  Undefined for every other protocol. */
    let vertexModel: string | undefined;
    // #903: cost clock starts BEFORE the body read — local= covers body
    // reception + parse + processTurn + rebuild/serialize, i.e. everything bili
    // does before handing off. inboundBytes stays the raw wire size (pre-decode).
    const reqT0 = performance.now();
    let inboundBytes = 0;
    // #1117: read before the body decode below — a passthrough-marked request
    // must relay its ORIGINAL bytes (content-encoding included) untouched.
    const passthroughMark = headerValue(req, BILI_PASSTHROUGH_HEADER) === "1";
    try {
        bodyBuffer = await readBody(req);
        inboundBytes = bodyBuffer.length;
        const url = req.url ?? "";
        urlPath = url.split("?", 2)[0];
        responsesCompact = urlPath.endsWith("/responses/compact");
        route = resolveUpstream(opts, req.url ?? "", req);
        // #409: destination admission for the zero-config /bili/ absolute-URL
        // tunnel. CONNECT has its own gates (mitm.ts); this is the /bili/
        // counterpart — self-proxy, link-local/metadata always denied;
        // loopback/private denied for remote clients unless allowlisted.
        if (route?.tunnel) {
            const verdict = await checkTunnelDestination(route.upstream, {
                selfPort: req.socket.localPort ?? undefined,
                clientLoopback: isLoopbackAddress(req.socket.remoteAddress),
                allowlist: tunnelAllowlistFromEnv(),
                // #2124: delegate hostname classification when egress leaves via an upstream proxy (same per-destination decision buildForwardTarget uses below).
                egressProxied: resolveProxyDecision(opts.routes, opts.proxy, route.rewrittenUrl ?? route.upstream, opts.proxyFallback).proxy !== undefined,
            });
            if (!verdict.ok) {
                log("warn", `[tunnel] denied ${maskUrlsInText(route.upstream)}: ${verdict.message}`);
                // #1686: a resolution failure is transport-class (the resolver was
                // momentarily unreachable; the name itself may be perfectly valid),
                // not a permission decision — 403 tells clients "never will succeed"
                // and kills their retry logic mid-outage. Policy denials stay 403;
                // a malformed embedded URL is a client error (400).
                const status = verdict.code === "unresolvable" ? 502 : verdict.code === "invalid" ? 400 : 403;
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: verdict.message, code: "tunnel_destination_denied", detail: verdict.code }));
                return;
            }
        }
        upstreamOrigin = route ? route.upstream : /^https?:\/\//i.test(url) ? new URL(url).origin : opts.upstream;
        providerDestUrl = route ? route.rewrittenUrl : /^https?:\/\//i.test(urlPath) ? urlPath : `${opts.upstream}${urlPath}`;
        // #1909: user-declared wire protocol (providers[<url-prefix>].protocol)
        // outranks the built-in suffix heuristics — explicit intent beats
        // inference. Looked up by the FULL destination URL (route.rewrittenUrl
        // keeps the mitm:// scheme for MITM lanes, so mitm:// keys work here
        // like every other provider field); the /bili/<protocol>/ explicit
        // marker still outranks the declaration. POST-with-body only, same
        // gate as the built-in table. Resolved through the prefix hierarchy
        // (deepest EXPLICIT declarer wins); the other fields keep findRoute's
        // single-entry longest-key semantics.
        const declaredProtocol = req.method === "POST" && bodyBuffer.length > 0
            ? resolveDeclaredProtocol(
                opts.routes,
                route ? route.rewrittenUrl : /^https?:\/\//i.test(url) ? url : `${opts.upstream}${url}`,
            )
            : undefined;
        protocol =
            route?.explicitProtocol
            ?? declaredProtocol
            ?? (req.method === "POST" && bodyBuffer.length > 0
                ? urlPath.endsWith("/chat/completions") || urlPath.endsWith("/llm_raw_chat")
                    ? "openai"
                    : urlPath.endsWith("/v1/messages") || urlPath.endsWith("/messages")
                      ? "anthropic"
                      : urlPath.endsWith("/responses") || responsesCompact
                        ? "responses"
                        : googlePathKind(urlPath) !== null
                          ? "google"
                          : null
                : null);
        // Gemini carries the model in the PATH, not the body — resolve it here so
        // the window/config block below and every later model-keyed decision see
        // it on a request whose body has no `model` field (#google).
        googleModel = protocol === "google" ? googleModelFromPath(urlPath) : undefined;
        // Same shape on the Vertex anthropic wire: the path holds the model
        // (`…/publishers/anthropic/models/<model>:streamRawPredict`) and the
        // body holds none, so this is the only source for every model-keyed
        // decision on that wire.
        vertexModel = protocol === "anthropic" ? vertexAnthropicModelFromPath(urlPath) : undefined;
        // Issue #99: decode body only for known protocols — passthrough requests
        // (e.g. GET /models) must forward raw bytes without content-encoding decode.
        if (!passthroughMark && protocol !== null && bodyBuffer.length > 0) {
            try {
                const decoded = await decodeRequestBody(headerValue(req, "content-encoding"), bodyBuffer, knobLimitsDecodedBytes(), { signal: decodingSignal, onBytes: (bytes) => admission.observe(bytes) });
                bodyBuffer = decoded.body;
                if (decoded.decoded) delete req.headers["content-encoding"];
            } catch (decErr) {
                if (decErr instanceof DecompressedTooLargeError || decErr instanceof DecodedRequestBusyError || decodingSignal.aborted) throw decErr;
                // #619: bili can't decode this content-encoding -> don't 400. Drop
                // protocol so the request falls to the verbatim passthrough below,
                // relaying the ORIGINAL still-encoded bytes (the reassignment never
                // ran and the content-encoding header stays intact) so the upstream
                // applies its own decode - mirroring the JSON.parse path.
                protocol = null;
                log("warn", `decode body failed (${String(decErr)}) - forwarding raw body verbatim to ${maskUrlsInText(upstreamOrigin)}`);
            }
        }
    } catch (err) {
        if (decodingSignal.aborted || res.destroyed) return;
        if (err instanceof DecodedRequestBusyError) {
            log("warn", "503: large decoded request budget is busy");
            res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
            res.end(JSON.stringify({ error: { type: "request_body_busy", stage: "decode", message: err.message } }));
            return;
        }
        if (err instanceof BodyTooLargeError || err instanceof DecompressedTooLargeError) {
            log("warn", `413: request body exceeds ${err.limit} bytes`);
            res.writeHead(413, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { type: "request_too_large", stage: err instanceof BodyTooLargeError ? "receive" : "decode", message: err.message } }));
            return;
        }
        log("warn", `failed to prepare inbound request (${String(err)}) - 400`);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_request", message: String(err) } }));
        return;
    }
    // #1757: resolve compat.dropFields once, ahead of the verbatim branches
    // that forward before reaching the final boundary (they can't use
    // forward()'s own resolution). Same destination derivation as
    // buildForwardTarget, so the list matches what the processed path applies.
    const compatDropPaths = resolveCompatDropFields(opts.routes, forwardUpstreamUrl(req, opts, route), opts.compat?.dropFields);
    // #1117: an unattributed in-process caller (native patch marked it — its
    // URL was already /bili/-routed by the settings overlay, so refusal was
    // impossible client-side) relays byte-untouched, mirroring a direct send
    // without the overlay: no session, no injection, no guard. Same raw
    // forward as the #920 bypass.
    if (passthroughMark) {
        // #2709: ...except the compaction guard. dsh's background compaction is
        // agentless by nature (no active initiator attribution), so the takeover
        // gate refuses it INTO this lane — and a verbatim relay below the #1835
        // pipeline guard is exactly how 4/49 compaction calls landed in the field
        // report (45 were refused through the pipeline). Same refusal, applied at
        // this lane too: marker-decisive (#2193), unconditional (#3651 removed
        // the #2028 opt-out), fail-open on undecodable bodies (#1835 failure
        // direction — relay verbatim, today's behavior). The check decodes only
        // a COPY: the relay still forwards the original bytes with content-
        // encoding intact.
        if (protocol !== null && req.method === "POST" && bodyBuffer.length > 0
            && await detectPassthroughDshCompactionCall(protocol, bodyBuffer, headerValue(req, "content-encoding"), async (enc, buf) => (await decodeRequestBody(enc, buf, knobLimitsDecodedBytes(), { signal: decodingSignal, onBytes: (bytes) => admission.observe(bytes) })).body)) {
            dshPassthroughGuardStats.refusals += 1;
            // #3013/#3022 (A3): first refusal warns; then every
            // DSH_REFUSAL_STORM_LOG_EVERY-th refusal logs an info so an
            // agentless retry storm stays visible without spamming (the
            // field-reported storm re-fired every ~328ms — per-refusal warn
            // would have written thousands of lines). This log line, not the
            // #2490 ledger, is the only record on this lane.
            if (dshPassthroughGuardStats.refusals === 1 || dshPassthroughGuardStats.refusals % DSH_REFUSAL_STORM_LOG_EVERY === 0) {
                log(dshPassthroughGuardStats.refusals === 1 ? "warn" : "info", `[passthrough] dsh native compaction call identified on the unattributed passthrough lane (#1117/#2709) — REFUSED, not forwarded: bili owns compression on this lane; a landed dsh checkpoint would durably shadow the raw history (#1729, cf. #1772/#1206). No session exists on this lane, so this log line (not the #2490 ledger) is the record; passthrough refusals so far: ${dshPassthroughGuardStats.refusals}` + (dshPassthroughGuardStats.refusals === 1 ? "" : ` — retrying will keep failing (terminal, bili_final; #3013): disable dsh auto-compaction (#2474)`));
            }
            const refusal = dshCompactionRefusal(protocol);
            if (!res.headersSent && !res.writableEnded && !res.destroyed) {
                res.writeHead(refusal.status, { "content-type": "application/json" });
                res.end(JSON.stringify(refusal.body));
            }
            logRequestCost(log, "passthrough", null, inboundBytes, reqT0);
            return;
        }
        log("debug", `passthrough: ${req.method ?? "?"} ${maskUrlForLog(req.url ?? "")} — unattributed in-process caller (#1117), relaying verbatim`);
        await forward(req, res, opts, scrubCompatDrop(scrubAnthropicPck(protocol, bodyBuffer, log), compatDropPaths, log), null, core, config, log, route, instanceId, undefined);
        return;
    }
    // #300: bili→bili chain detection. If the inbound request already carries
    // the x-bili-hop marker, an upstream bili instance already ran the
    // compression pipeline on it. Processing it again would double-compress
    // and corrupt session state (#292). Skip ALL processing (no tool/tag
    // injection, no acp-loop, no session state) and pass the request through
    // verbatim. Clients never send this header, so its presence on an inbound
    // request always means "came from a bili instance".
    const hopMarker = headerValue(req, BILI_HOP_HEADER);
    if (hopMarker !== undefined) {
        const selfLoop = hopMarker === instanceId;
        log("warn", selfLoop
            ? `[chain] inbound request carries THIS instance's ${BILI_HOP_HEADER} marker (${hopMarker}) — self-loop detected. Passing through without processing; check your upstream config (it may point back to this instance).`
            : `[chain] inbound request carries ${BILI_HOP_HEADER} from another bili instance (${hopMarker}) — bili→bili chain detected. Passing through without processing to avoid double compression; keep only one bili instance in the chain.`);
    }
    // #1086: byte pre-filter for the ACP-artifact content fallback — the only
    // remaining signal when a middlebox strips x-bili-hop. The DECISION is
    // deferred until session identity is resolved below: artifacts in a
    // session THIS instance processed are self-produced and must run through
    // the kernel (v0.1.133 judged them chains before binding, which stopped
    // compression permanently on single-instance setups).
    // #1100: "no local state ⇒ foreign" is only sound when persistence proves
    // ownership across a restart. With BILI_PERSIST=0 an instance can't recover
    // ownership, so "no state" is ambiguous with our own replayed session — a
    // decisive passthrough would re-brick compression (#1086). Skip the fallback
    // entirely when the store is disabled; the hop marker above still catches chains.
    const artifactSeed = hopMarker === undefined && bodyBuffer.length > 0
        && opts.chainContentDetection !== false && getStore().enabled && artifactSeedHit(bodyBuffer);
    // #920: legacy opencode-acp sessions bypass the whole pipeline. The thin
    // plugin stamps this header per request for sessions with acp state on
    // disk; acp owns their context in-process, so binding/injecting/compressing
    // here would double-manage it. Raw forward, zero state touched.
    if (headerValue(req, BILI_PLUGIN_BYPASS_HEADER) === "1") {
        log("debug", `bypass: ${req.method ?? "?"} ${maskUrlForLog(req.url ?? "")} — raw passthrough (legacy in-process compression)`);
        await forward(req, res, opts, scrubCompatDrop(scrubAnthropicPck(protocol, bodyBuffer, log), compatDropPaths, log), null, core, config, log, route, instanceId, undefined);
        return;
    }
    const countTokens = isCountTokensRequest(req.method ?? "GET", urlPath, bodyBuffer.length > 0);
    // Per-request context limit: look up body.model against the per-route model
    // declaration in providers.json first (same model can have different
    // windows behind different relays), then the built-in table. Falls back to
    // the global env default if neither matches.
    // Parse body once and reuse everywhere (fixes duplicate JSON.parse).
    let parsed: unknown = null;
    let bodyText: string | undefined;
    if (protocol && bodyBuffer.length > 0) {
        bodyText = bodyBuffer.toString("utf8");
        try {
            parsed = JSON.parse(bodyText);
        } catch {
            parsed = null;
        }
    }
    // #3129: CloudCode/Antigravity v1internal dialect — unwrap the outer envelope
    // so the pipeline sees a standard GoogleRequest, and decide identity. The
    // inner request.sessionId is a constant FNV-1a hash, so identity comes from
    // the stable Conversation ID in the system instruction instead. Background
    // utility calls bypass the ACP state machine entirely (verbatim passthrough).
    let v1Meta: Record<string, unknown> | undefined;
    let v1Model: string | undefined;
    let v1ConvId: string | undefined;
    if (protocol === "google" && parsed !== null && isV1InternalRequest(urlPath, parsed)) {
        const unwrapped = unwrapV1Internal(parsed as Record<string, unknown>);
        parsed = unwrapped.inner;
        v1Meta = unwrapped.meta;
        v1Model = unwrapped.model ?? undefined;
        v1ConvId = extractConversationId(unwrapped.inner) ?? undefined;
        if (isV1BackgroundSideRequest(unwrapped.meta, unwrapped.inner)) {
            log("info", `v1internal background utility call (requestType=${typeof unwrapped.meta.requestType === "string" ? unwrapped.meta.requestType : "micro"}) — verbatim passthrough, ACP state machine bypassed (#3129)`);
            await forward(req, res, opts, scrubCompatDrop(scrubAnthropicPck(protocol, bodyBuffer, log), compatDropPaths, log), null, core, config, log, route, instanceId, undefined);
            return;
        }
        log("debug", `v1internal envelope unwrapped (model=${v1Model ?? "?"} convId=${v1ConvId ?? "none"})`);
    }
    // #2824: one cheap raw-text pass decides whether the incoming-image index
    //  (#1995/#2607) can find anything — a provably image-free body skips BOTH
    //  index builds (each one re-converts the full history wire→core). The
    //  predicate over-approximates by design; see bodyMightCarryImages.
    const bodyMayCarryImages = protocol !== null && bodyText !== undefined ? bodyMightCarryImages(bodyText, protocol) : false;
    // #903: inbound message count for the per-request cost line — messages
    // (anthropic/openai) or input (responses); null when the body has neither.
    const inboundMsgs: number | null = (() => {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const p = parsed as Record<string, unknown>;
        if (Array.isArray(p.messages)) return p.messages.length;
        if (Array.isArray(p.input)) return p.input.length;
        return null;
    })();
    // #1395 step 3 (#1421): chain-checkpoint ENFORCEMENT — first-processor-
    // wins. A verifiable checkpoint means an upstream bili already ran the
    // pipeline on this exact body: forward it verbatim (pipeline skipped)
    // instead of re-running kernel/injection. Only trusted verdicts skip;
    // stale-unmatched carriers are stripped and processed normally (this
    // instance becomes the processor and re-stamps on egress in forward()).
    // Gated like the legacy artifact fallback (chainContentDetection) and
    // skipped when x-bili-hop is present (that path already decides).
    let chainSkip = false;
    if (protocol && hopMarker === undefined && opts.chainContentDetection !== false && parsed !== null && typeof parsed === "object") {
        try {
            const chainCtx = evaluateChain(parsed, protocol);
            if (chainCtx.verdict !== "none") {
                const sel = chainCtx.selected;
                const selTxt = sel ? ` (v=${sel.v} processor=${sel.processor} issued-at=${sel.issuedAt} request-id=${sel.requestId})` : "";
                const malTxt = chainCtx.malformed > 0 ? ` malformed=${chainCtx.malformed}` : "";
                const head = `[chain] inbound ${protocol} request carries ${chainCtx.candidates.length} chain checkpoint(s) — verdict=${chainCtx.verdict}${selTxt}${malTxt}`;
                switch (chainCtx.verdict) {
                    case "valid":
                        chainSkip = true;
                        log("info", `${head}; first-processor-wins: forwarding verbatim, pipeline skipped (#1421)`);
                        break;
                    case "recent-mismatch":
                        chainSkip = true;
                        log("warn", `${head}; interop: forwarding verbatim + warn (well-formed fresh checkpoint, no digest match — body may have drifted since stamp) (#1421)`);
                        break;
                    case "stale":
                        if (chainCtx.selectedMatched) {
                            chainSkip = true;
                            log("warn", `${head}; digest match but out-of-window/future timestamp — forwarding verbatim + warn (replay or clock skew) (#1421)`);
                        } else {
                            parsed = extractChainCarriers(parsed, protocol).stripped;
                            log("info", `${head}; no digest match — stripping stale checkpoint(s), processing normally (#1421)`);
                        }
                        break;
                    case "invalid":
                        log("warn", `${head}; never trusted — processing normally (#1421)`);
                        break;
                }
            }
        } catch (err) {
            log("debug", `[chain] evaluation failed (${String(err)}); ignoring`);
        }
    }
    // #806: a parseable body missing the conversation field used to crash the
    // kernel's conversation-signal fingerprint (body.messages.find on undefined —
    // top-level arrays included) and surface as an opaque 502; #806 answered that
    // with a 400. #1284 showed the 400 is the wrong verdict for the common case:
    // the native fetch patch claims by URL SHAPE alone (isModelApiUrl), which
    // cannot tell a model endpoint from any other API ending in /messages or
    // /chat/completions — a dsh plugin writing single-message records to
    // .../sessions/<id>/messages died with an unretryable 400 before ever
    // reaching its own upstream. The proxy is the only layer that sees both URL
    // and body, so the body is the deciding signal: not a model conversation ⇒
    // relay verbatim, exactly like the unparseable-body path — the upstream
    // rejects its own API contract. (#806's crash cannot recur: a verbatim
    // forward never enters the kernel.)
    if ((protocol === "anthropic" || protocol === "openai") && parsed !== null) {
        const p = typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
        if (!p || !Array.isArray(p.messages)) {
            const relayKey = `${upstreamOrigin}${urlPath}`;
            if (!nonConversationRelayWarned.has(relayKey)) {
                nonConversationRelayWarned.add(relayKey);
                if (nonConversationRelayWarned.size > NON_CONVERSATION_RELAY_WARN_CAP) {
                    nonConversationRelayWarned.delete(nonConversationRelayWarned.values().next().value as string);
                }
                log("warn", `[${protocol}] body has no "messages" array — not a model conversation; relaying verbatim to ${maskUrlsInText(upstreamOrigin)} instead of rejecting (#1284) — ${req.method ?? "?"} ${maskUrlForLog(req.url ?? "")}`);
            }
            await forward(req, res, opts, scrubCompatDrop(scrubAnthropicPck(protocol, bodyBuffer, log), compatDropPaths, log), null, core, config, log, route, instanceId, undefined);
            return;
        }
    }
    // The effective model for this request. Every wire carries it in the body
    // except Gemini, whose URL path holds it (`/v1beta/models/<model>:…`), and
    // Anthropic-on-Vertex, whose path holds it the same way
    // (`…/publishers/anthropic/models/<model>:rawPredict`) with no body `model`
    // at all.
    const bodyModel = parsed && typeof parsed === "object" && "model" in parsed && typeof parsed.model === "string" ? parsed.model : undefined;
    // Only the path-derived Vertex id is normalised: it is the one id whose
    // spelling the wire itself guarantees (the publisher path), and dropping an
    // `@version` tag is what makes the registry lookup and the compress
    // thresholds land on the right row.
    const vertexPathModel = vertexModel !== undefined ? normalizeVertexModelId(vertexModel) : undefined;
    if (vertexModel !== undefined && vertexPathModel !== undefined && vertexPathModel !== vertexModel && !vertexModelNormalised.has(vertexModel)) {
        if (vertexModelNormalised.size < VERTEX_MODEL_LOG_CAP) vertexModelNormalised.add(vertexModel);
        log("info", `[anthropic] Vertex model id normalised ${vertexModel} -> ${vertexPathModel}; the @version tag is not part of the publisher model id on this wire`);
    }
    // #3129: v1internal carries the model in the OUTER envelope, not the path
    // (/v1internal:* has no /models/<m>: segment) and not always the inner body.
    const requestModel = bodyModel ?? googleModel ?? vertexPathModel ?? v1Model;
    // Capture the CLIENT's raw incoming request (before bili rebuilds) to
    // resolve whether codex sends previous_response_id + full input vs delta.
    if (opts.debug && parsed && typeof parsed === "object") {
        const p = parsed as Record<string, unknown>;
        const hasPrev = p.previous_response_id !== undefined;
        const inLen = Array.isArray(p.input) ? p.input.length : 0;
        log("info", `[debug] INCOMING previous_response_id=${hasPrev ? String(p.previous_response_id).slice(0, 16) : "absent"} input_items=${inLen} instructions=${p.instructions !== undefined ? "present" : "absent"}`);
    }
    // Per-request context limit + compression tuning: look up body.model against
    // the per-route model declaration first, then the built-in table / registry.
    // Compress settings (global → provider → model) merge deepest-field-wins and
    // are applied on top of the resolved limit. `compress.contextLimit` (an
    // absolute number, a "70%" string of the native window, or unset → native)
    // overrides the table.
    let reqConfig = config;
    // #736: the resolved NATIVE window (before the compress.modelContextLimit
    // override and the codex align) plus what shrank the effective window below
    // it — threaded into preflightCompressIfNeeded so a fail-fast can tell the
    // operator that their own setting, not the upstream, is the wall they hit.
    let resolvedNativeWindow: number | undefined;
    let windowShrinkReason: "operator" | "codex" | undefined;
    // True when the resolved native window came from a low-confidence fallback
    // (built-in table / env default) instead of an authoritative source — such
    // windows get an effective-floor after output-headroom reservation (see
    // FALLBACK_EFFECTIVE_WINDOW_FLOOR). Cleared when an async registry hit
    // replaces the value.
    let nativeFromFallback = false;
    // Effective compression prompts for this request: resolved from the same
    // three-level cascade (global → provider → model) as the limit above, then
    // threaded into every prepare* path so the system prompt, the nudge text,
    // and the compress-loop system prompt all use one consistent Prompts set
    // (kernel contract: renderNudgeText and the adapter prompt must match).
    let reqPrompts: Prompts = defaultPrompts;
    let reqSurface: PackSurface = {};
    let reqSurfacePack = "default";
    let wsSourceForLog: string | undefined;
    // [#1097] host-only CCR policy for this request scope (three-level
    // merge); resolved before the session is bound, then stamped onto it below so
    // every view / injection / execution site reads one value.
    let resolvedCcrCfg: CcrSettings | undefined;
    // [#1336] host-only plan-aware search flag for this request scope (three-
    // level merge); stamped onto the session below like the other per-request
    // policies. Off unless compress.search.planAware=true at some level.
    let resolvedSearchPlanAware = false;
    let reqModelId: string | undefined;
    if (parsed && typeof parsed === "object") {
        // Gemini's model lives in the request path, every other wire carries it
        // in the body — either way the window/config block below needs one.
        const model = requestModel;
        reqModelId = typeof model === "string" ? model : undefined;
        if (model) {
            const embeddedUrl = providerDestUrl;
            // Native-window resolution order: (0) per-request TIER EVIDENCE
            // that this request runs on an expanded tier — (a) the client's
            // `anthropic-beta` larger-context negotiation (context-1m-… →
            // 1,000,000) or (b) an [Nm]-suffixed model name (claude-opus-5-5[1m]
            // → 1M) — the most direct evidence of the window the upstream will
            // serve, so it outranks every static source (the model table /
            // registry list the STANDARD window, e.g. 200K for claude); (1) a cooperative
            // plugin's report (the agent's own config — most authoritative, gated
            // on the x-bili-plugin marker so a plain client cannot rewrite the
            // nudge denominator by name); (1b) the launcher's per-model
            // windows (BILI_LAUNCHER_MODEL_WINDOWS — the client's own
            // models.json/models.yml contextWindow, authoritative for this
            // deployment, no header trust needed since only the launcher
            // sets the env); (2) the user's per-route per-model declaration —
            // operator-controlled and deployment-specific: the same model name
            // can have different windows behind different relays (a private
            // relay may serve gpt-5.6-sol at 272K while models.dev lists the
            // official 1M), so an explicit declaration always outranks the
            // auto-fetched registry (#344); (3) a WARM models.dev registry
            // cache (daily refresh — outranks the static table whenever
            // already resident; peek never fetches, cold start skips to (4)
            // without blocking) — for TIER-GATED families (claude-) a registry
            // value above the built-in standard window is capped back to the
            // standard when rank 0 saw no tier evidence (#1321: models.dev
            // advertises the max tier, plain plans serve the standard one);
            // (4) the built-in CONTEXT_LIMIT_TABLE
            // fallback. Operator tuning via compress.modelContextLimit still
            // outranks everything inside resolveRequestConfig.
            const host = (() => { try { return embeddedUrl ? new URL(embeddedUrl).host : undefined; } catch { return undefined; } })();
            const betaWindow = anthropicBetaContextWindow(req.headers);
            const suffixWindow = expandedContextSuffixWindow(model);
            const hasTierEvidence = betaWindow !== undefined || suffixWindow !== undefined;
            const pluginWindow = pluginHeadersMatchModel(req.headers, model) ? pluginReportedContextWindow(req.headers) : undefined;
            // Runtime-table fallback for the window (#955): only when this
            // request's plugin sent no window header AND the latest
            // runtime-info entry matches THIS request's model — a stale
            // post-switch entry must never size a different model. #1531:
            // header-less plugin agents (omp native binds via identity
            // register + prompt_cache_key stamping, never x-bili-plugin)
            // resolve their report by conversation signal instead of the
            // header — with the header present the agent table still wins
            // exclusively (a plain client can only ever miss, not hit).
            const runtimeAgent = pluginAgentHeader(req.headers);
            const runtimeEntry = runtimeAgent !== undefined
                ? pluginRuntimeInfoFor(runtimeAgent, model)
                : pluginRuntimeInfoForConversation(runtimeConversationId(req.headers, parsed, opts.sessionHeader), model);
            const runtimeWindow = pluginWindow === undefined ? runtimeEntry?.contextWindow : undefined;
            const launcherWindow = launcherContextWindow(model);
            const configuredWindow = resolveConfiguredContextLimit(opts.routes, embeddedUrl, model);
            const operatorWindowTuned = resolveCompress(opts.routes, embeddedUrl, model, opts.compress).modelContextLimit !== undefined;
            // #2317: the providers key this request resolved against (or proof of a
            // route-miss) plus the origin/host the match ran on — surfaced by the
            // [window]/clamp lines, the once-per-upstream route-miss WARN, and the
            // preflight fail-fast note, because a silent miss drops every per-provider
            // override while the registry value happens to look plausible.
            const routeKey = findRouteKey(opts.routes, embeddedUrl);
            const providerKeys = Object.keys(opts.routes);
            const routeLabel = routeKey !== undefined
                ? hostIdForLog(routeKey)
                : (providerKeys.length > 0 ? "miss" : "none");
            let diagOrigin: string | undefined;
            if (embeddedUrl) {
                try {
                    const u = new URL(embeddedUrl);
                    // .origin is the string "null" for non-special schemes (mitm://),
                    // which would collapse every MITM relay into one dedupe bucket —
                    // derive scheme+host directly instead (#2317 review).
                    if (u.host) diagOrigin = `${u.protocol}//${u.host}`;
                } catch {}
            }
            const peekWindow = capRegistryWindowByStandard(model, peekRegistryContext(model, host), hasTierEvidence);
            let native = betaWindow
                ?? suffixWindow
                ?? pluginWindow
                ?? runtimeWindow
                ?? launcherWindow
                ?? configuredWindow
                ?? peekWindow
                ?? lookupContextLimit(model);
            // Fallback = no authoritative source AND the operator did not
            // explicitly tune the window via compress.modelContextLimit (an
            // explicit tuning is owned by the operator — never floored). The
            // beta/suffix windows are authoritative (the client's own runtime
            // negotiation), so they also clear the fallback flag.
            nativeFromFallback = !betaWindow && !suffixWindow && !pluginWindow && !runtimeWindow && !launcherWindow && !peekWindow && !configuredWindow && !operatorWindowTuned;
            if (!native) {
                native = capRegistryWindowByStandard(model, await contextFromRegistry(model, host), hasTierEvidence);
                if (native) nativeFromFallback = false;
            }
            // #2336: agent-registry recipes are the FALLBACK layer — bili's
            // own named providers (file) win per provider name.
            reqConfig = resolveRequestConfig(config, opts.routes, embeddedUrl, model, native, opts.compress, { ...agentProviderRecipes(), ...opts.namedProviders ?? {} });
            {
                const wsSource = betaWindow ? "anthropic-beta" : suffixWindow ? "model-suffix" : pluginWindow ? "plugin" : runtimeWindow ? "runtime-info" : launcherWindow ? "launcher" : configuredWindow ? "configured" : peekWindow ? "registry-peek" : native ? "table-or-registry" : "default";
                wsSourceForLog = wsSource;
                if (!windowSourceLogged.has(model)) {
                    windowSourceLogged.add(model);
                    // #2096: label what this value IS — the pre-reservation base.
                    // The output-headroom reservation below shrinks
                    // reqConfig.modelContextLimit per request; its result gets
                    // its own [headroom] line so one label can't carry two values.
                    log("info", `[window] model=${model} source=${wsSource} native=${native ?? "none"} base=${reqConfig.modelContextLimit} launcher=${launcherWindow ?? "none"} configured=${configuredWindow ?? "none"} peek=${peekWindow ?? "none"} fallback=${nativeFromFallback} upstream=${embeddedUrl ? hostIdForLog(embeddedUrl) : "none"} route=${routeLabel}`);
                    // #1569: a cooperating plugin is present but its configured
                    // window never arrived — the host's own limit.context is not
                    // reaching us, and nudge bands / emergency depth are being
                    // sized against a guessed denominator. Say so once per model
                    // instead of degrading silently into registry-peek.
                    if (runtimeAgent !== undefined && pluginWindow === undefined && runtimeWindow === undefined) {
                        log("warn", `[window] model=${model} agent=${runtimeAgent} sent no context window (x-bili-plugin-context-window absent, no matching runtime-info) — host-configured limit not reaching the proxy; sizing against ${wsSource}`);
                    }
                }
            }
            if (routeKey === undefined && providerKeys.length > 0) warnRouteMissIfNew(diagOrigin, model, providerKeys, log);
            resolvedNativeWindow = native;
            // 优先客户端声明及当前 Codex 缓存，再用发布时模型表对齐窗口，避免旧表误裁剪新模型。
            // An operator's explicit compress.modelContextLimit is exempt
            // (operator tuning is owned by the operator — never floored and
            // never clamped); the clamped value is authoritative for this
            // client (codex's own config), so it also clears the
            // low-confidence fallback flag.
            const aligned = operatorWindowTuned
                ? { limit: reqConfig.modelContextLimit, clamped: false }
                : codexAlignedWindow(reqConfig.modelContextLimit, model, req.headers, pluginWindow ?? runtimeWindow ?? launcherWindow);
            if (aligned.clamped) {
                const before = reqConfig.modelContextLimit;
                reqConfig = { ...reqConfig, modelContextLimit: aligned.limit };
                nativeFromFallback = false;
                windowShrinkReason = "codex";
                log("info", `[codex] effective window clamped ${before} → ${aligned.limit} (client-window alignment for model=${model}; current client metadata preferred over bundled fallback) upstream=${embeddedUrl ? hostIdForLog(embeddedUrl) : "none"} route=${routeLabel}`);
            } else if (operatorWindowTuned && native !== undefined && reqConfig.modelContextLimit < native) {
                windowShrinkReason = "operator";
            }
            const compressCfg = resolveCompress(opts.routes, embeddedUrl, model, opts.compress);
            // [#1207 owner decision] CCR is opt-in on every lane: the raw
            // three-level merge IS the arming decision — no `ccr` key at any
            // level leaves resolvedCcrCfg undefined and the session never
            // arms. Turn it on only by setting compress.ccr.enabled=true at
            // some config level, after local verification.
            resolvedCcrCfg = compressCfg.ccr;
            resolvedSearchPlanAware = compressCfg.search?.planAware === true;
            reqPrompts = resolveCompressPrompts(compressCfg);
            const surfaceRes = resolveCompressSurfaceDetailed(compressCfg);
            reqSurface = surfaceRes.surface;
            reqSurfacePack = surfaceRes.packName;
        }
    }
    let prepared: Prepared | null = null;
    // Whether this request has already been handed to forward(). `prepared`
    // cannot answer that: the codex compaction_trigger path deliberately skips
    // the kernel and forwards its own normalized body with `prepared === null`,
    // so the passthrough tail below would forward the raw body a second time.
    let forwarded = false;
    // #661: route-scoped passthrough — the global flag's semantics, limited to
    // requests whose upstream URL matches a provider route with
    // `passthrough: true` (upstreams that fingerprint the request body).
    const routePassthrough = !opts.passthrough && findRoute(opts.routes, providerDestUrl)?.passthrough === true;
    if (routePassthrough && hopMarker === undefined && protocol && parsed) {
        log("info", `[route-passthrough] ${maskUrlsInText(providerDestUrl)} matches a passthrough route — forwarding verbatim, kernel bypassed`);
    }
    // #300: `hopMarker !== undefined` means an upstream bili already processed
    // this request — skip the whole pipeline (prepared stays null) so the
    // passthrough path below forwards it verbatim. #1421: `chainSkip` is the
    // content-level twin of the same decision (verifiable checkpoint present).
    if (!opts.passthrough && !routePassthrough && !chainSkip && hopMarker === undefined && protocol && parsed && typeof parsed === "object") {
        const sessionHeader = headerValue(req, opts.sessionHeader);
        // Plugin mode (issue #1, "内外呼应"): a cooperative agent-side plugin
        // announces itself with x-bili-plugin. The proxy then treats the
        // session's tool surface as NATIVE (plugin-registered from the
        // manifest) — wire tool injection is suppressed and the compress loop
        // never intercepts proxy-named tool calls. Philosophy prompt + nudge
        // keep flowing from here; state + folding stay proxy-owned.
        //
        // Launcher mode (#162) is the header-less variant: hosts that cannot
        // attach per-request headers (claude/codex spawned by `bili claude`
        // / `bili codex`) POST /__bili/plugin/register first (Claude Code
        // SessionStart hook / codex spawn). The FIRST request that creates a
        // NEW session consumes the pending register — that session is plugin
        // mode from then on, keyed by the registered conversation id, and the
        // binding sticks via session.metadata.pluginAgent. stats.requests
        // increments inside prepare() below, so === 0 here means first sight.
        let pluginAgent = pluginAgentHeader(req.headers);
        let pluginConversation = pluginConversationHeader(req.headers);
        // The client's own conversation header (x-session-id / x-session-affinity
        // / x-opencode-session / x-acp-session) is the STRONGEST signal that two
        // requests belong to the same conversation — much stronger than the
        // content-fingerprint fallback. Prefer it over opts.sessionHeader and
        // over content hashing, so IDE clients (ZCode/Cursor) that inject a
        // fixed system-reminder into every new conversation don't collide on a
        // shared 200-char prefix and leak compression state across sessions.
        const clientConv = clientConversationHeader(req.headers);
        const convHeader = clientConv ?? sessionHeader;
        // Codex turn-metadata partitioning (#316 / PR-A): when the explicit
        // Codex turn metadata is present and cross-checked against the
        // thread-id header, partition compression state by thread_source.
        // Root ("user") turns keep the session-id header (current semantics,
        // stable across turns); subagents get their own thread-id (fresh
        // independent state per thread, #150). Untrusted metadata (absent /
        // unparseable / mismatched / unknown thread_source) → undefined, and
        // the legacy chain below is unchanged.
        const codexTurn = protocol === "responses" ? codexTurnIdentity(req.headers) : undefined;
        // Claude Code subagent discriminator (#970): subagent requests carry
        // the agent headers AND lack the main agent's system-prefix block
        // (see claudeSubagentAgentId for the two-signal contract). Hoisted so
        // the conversation split, the pending-register guard, and the plugin
        // conversation binding below all test the same signal.
        const systemTextsForSplit: string[] =
            typeof (parsed as { system?: unknown }).system === "string"
                ? [(parsed as { system: string }).system]
                : Array.isArray((parsed as { system?: unknown }).system)
                  ? (parsed as { system: { text?: unknown }[] }).system
                        .map((b) => (typeof b?.text === "string" ? b.text : ""))
                        .filter((t) => t.length > 0)
                  : [];
        const claudeSub = protocol === "anthropic" ? claudeSubagentAgentId(req.headers, systemTextsForSplit) : undefined;
        const responsesIdentity = protocol === "responses"
            ? (codexTurn
                ? { value: codexTurn.value, source: "header" as const, clientProvided: true }
                : preferPromptCacheKeyIdentity(
                      conversationIdentityResponses(parsed as ResponsesRequestBody, convHeader),
                      parsed as ResponsesRequestBody,
                  ))
            : undefined;
        // OpenAI chat mirrors the responses pck promotion: clients that replay
        // full history statelessly (omp chat-completions via a relay) send NO
        // conversation headers, so the kernel's openai signal falls to a hash of
        // the first user message that never matches the session id the agent
        // plugin registered (identity register is keyed by the omp session
        // uuid). prompt_cache_key (stamped by the omp plugin, or sent natively)
        // is the client's own stable per-conversation id — promote it over the
        // fingerprint only; a real conversation header stays stronger.
        const openaiSignal = protocol === "openai"
            ? conversationSignalOpenai(parsed as OpenAIRequestBody, convHeader)
            : "";
        const openaiIdentity = protocol === "openai"
            ? preferPromptCacheKeyIdentity(
                  convHeader
                    ? { value: openaiSignal, source: "header" as const, clientProvided: true }
                    : { value: openaiSignal, source: "content-fingerprint" as const, clientProvided: false },
                  parsed as { prompt_cache_key?: unknown },
              )
            : undefined;
        // Anthropic mirrors the openai pck promotion (#268): the omp plugin
        // stamps prompt_cache_key on every chat-shaped payload — it cannot
        // tell the anthropic wire apart by shape (both carry max_tokens). The
        // proxy consumes the field on this wire too (identity + mapping);
        // prepareAnthropic strips it before the real Anthropic sees it.
        const anthropicSignal = protocol === "anthropic"
            ? conversationSignalAnthropic(parsed as AnthropicRequestBody, convHeader)
            : "";
        const anthropicIdentity = protocol === "anthropic"
            ? preferPromptCacheKeyIdentity(
                  convHeader
                    ? { value: anthropicSignal, source: "header" as const, clientProvided: true }
                    : { value: anthropicSignal, source: "content-fingerprint" as const, clientProvided: false },
                  parsed as { prompt_cache_key?: unknown },
              )
            : undefined;
        // Gemini native wire: no conversation-header convention, and no
        // prompt_cache_key to promote (a Gemini body has no such field, so the
        // omp plugin cannot stamp one). Identity therefore rests on the
        // client's own conversation header when it sends one, and on content
        // prefix affinity over `contents` otherwise (anonymous branch, #309).
        const googleSignal = protocol === "google"
            ? conversationSignalGoogle(parsed as GoogleRequestBody, convHeader)
            : "";
        // #3129: v1internal has no conversation header; its stable per-conversation
        // UUID (from the system instruction) is treated as a client-provided id.
        // Without this, every Antigravity window shares the anonymous branch and
        // collides on the constant FNV-1a sessionId / empty-prefix affinity.
        const googleIdentity = protocol === "google"
            ? {
                  value: v1ConvId ?? googleSignal,
                  source: v1ConvId || convHeader ? ("header" as const) : ("content-fingerprint" as const),
                  clientProvided: !!v1ConvId || !!convHeader,
              }
            : undefined;
        // #2156: a request that will ride the #388 side passthrough further
        // down must NEVER participate in persona namespace resolution.
        // subagentNamespace's first-seen-system anchor is mutable process
        // state: whichever request arrives first under an identity claims the
        // raw key. A side request carries kernel-no-touch status, yet anchoring
        // it lets its utility system claim the raw key and fork every real
        // main turn onto `|sub:<fp>` — the host-stamped bare id then finds
        // zero refs and compress fails permanently (this issue). Side requests
        // therefore resolve VERBATIM: they neither read nor write the anchor
        // and share the main session key per the #388 contract (before the
        // fix, once any main turn had anchored, they instead rode junk
        // `|sub:<fp(side)>` sessions). Mirrors the #388 lane condition below
        // minus publicForkPrefix, which needs the session resolved AFTER this
        // point: a public-fork child arrives under a FRESH childConversationId
        // where first-seen anchoring returns the raw key anyway, so omitting
        // the veto cannot move any key. Under an ALREADY-anchored fork child
        // the verbatim key is still correct BECAUSE the lane below diverts
        // intent-certain side requests to the passthrough even under fork
        // receipts (kernel-no-touch, #388) — the two gates move together.
        // detectAcpArtifacts stays last — it
        // re-encodes the whole history and must only run for the all-bili
        // subset (same short-circuit discipline as the demotedSide gate below;
        // proxy-mode traffic never reaches it because the plugin header gate
        // fails first).
        const sideAgent = pluginRequestAgentHeader(req.headers);
        const sideRequestLike = !countTokens && !responsesCompact && protocol !== null
            && (isSideRequest(parsed, sideAgent)
                // #2503: dsh title sidecar — its output budget grew past the
                // <=200 heuristic on dsh 0.2.1-alpha.2 (preset 64 -> 4096);
                // recognize it by system text so it keeps the raw key instead
                // of forking onto a persisted |sub: ghost (#2241 scenario A).
                 || (pluginAgentHeader(req.headers) === "dsh" && sideAgent !== "main"
                     && isDshTitleRequest(parsed))
                 // #4438: dsh auto-review sidecar (classifyRisk). Live-stamp gate
                 // like the title clause: an UNSTAMPED review already keys verbatim
                 // here (dshPersona is false without the header), so this disjunct
                 // only matters for STAMPED reviews — it keeps them on the raw key
                 // instead of forking onto a persisted |sub:<fp> lane (#1916 path,
                 // superseded by the stateless passthrough). The LANE-side clause
                 // below carries the sticky-binding leg that covers the unstamped
                 // incident topology.
                 || (pluginAgentHeader(req.headers) === "dsh" && sideAgent !== "main"
                     && isDshAutoReviewRequest(protocol, parsed))
                 || (pluginAgentHeader(req.headers) !== undefined && sideAgent !== "main"
                     && req.headers["x-bili-ws-lane"] === undefined
                     && hasLeakedBiliToolsOnly(parsed)
                     && detectAcpArtifacts(bodyBuffer, parsed) === null));
        // #1916/#1307/#1314: the dsh persona fingerprint — dsh stamps ONE
        // conversation id on every model request of a session, INCLUDING the
        // auto-review classifyRisk() calls (fixed REVIEW_POLICY system + a
        // freshly-flattened user blob, fired before every tool call under the
        // Auto permission tier). Keying dsh traffic by id + system hash splits
        // those review requests onto their own `|sub:<fp>` session so they
        // stop overwriting the main session's usage baseline (#1916) and
        // evicting its remembered snapshots (#1307), while successive review
        // calls still share ONE forked session. Allowlisted by plugin agent
        // (evidence-per-client discipline, see dshPersonaFingerprintApplies)
        // because for everyone else system drift mid-id means "same
        // conversation, evolved" and forking would reset compression for no
        // defending bug (#1106). The kernel's anchor semantics keep the FIRST
        // system seen under the id on the raw key — the main turn claims it,
        // reviews fork; an empty system is non-anchoring (verbatim key), so
        // system-less auxiliary calls keep riding the main session.
        const dshPersona = dshPersonaFingerprintApplies(req.headers);
        const personaSystemText = protocol === "openai"
            ? openaiSystemTextForPersona(parsed as OpenAIRequestBody)
            : protocol === "anthropic"
              ? systemTextsForSplit.join("\n\n")
              : protocol === "google"
                ? googleSystemText(parsed as GoogleRequestBody)
                : "";
        const conversation = protocol === "google"
            // #2730: the google lane is persona-aware too — dsh stamps its one
            // conversation id on every wire including gemini (`x-bili-plugin: dsh`
            // is wire-agnostic, dsh-native.ts; MODEL_API_SUFFIX routes google
            // paths), so a review persona would otherwise merge into the main
            // session exactly like #1916/#2203 did on the other wires. #3134:
            // the same v2 order resolver as the other lanes since #3060 (fork
            // keys are byte-compatible, so persisted fork lanes survive). An
            // empty systemInstruction is non-anchoring (kernel anchor
            // semantics): ride the verbatim id — never route empty-tag
            // traffic through the order resolver.
            ? (dshPersona && !sideRequestLike
                ? (personaSystemText === ""
                      ? (googleIdentity?.value ?? googleSignal)
                      : personaConversationOrder(
                          googleIdentity?.value ?? googleSignal,
                          (parsed as GoogleRequestBody).contents,
                          personaSystemText,
                          pluginReportedModel(req.headers),
                      ))
                : (googleIdentity?.value ?? googleSignal))
            : protocol === "anthropic"
            ? // #970: a subagent's conversation value gets its own
              // `<id>|sub:<agent-id>` namespace so it lands on its own session
              // (own lock chain, own compression state) instead of queueing
              // behind the main turn. The identity itself is NOT rewritten:
              // affinityToken/clientLabel below keep consuming the raw value
              // so upstream prefix caches and the UI label stay continuous
              // across main and subagent sessions.
              (claudeSub !== undefined && opts.subagentSplit !== false
                  ? claudeSubagentSplit(anthropicIdentity?.value ?? anthropicSignal, req.headers, systemTextsForSplit)
                  : dshPersona && !sideRequestLike
                    // #2241: continuity-aware anchor — a system change whose
                    // history continues the raw key's prefix-affinity chain
                    // (model switch) MIGRATES the anchor instead of forking
                    // the main lane off the raw key; only history-discontinuous
                    // requests (review blobs) still fork onto `|sub:<fp>`.
                    ? (personaSystemText === ""
                          // An empty system is non-anchoring (kernel anchor
                          // semantics): ride the verbatim id — never route
                          // empty-tag traffic through the order resolver
                          // (codex turn-1 shape keys by its session header).
                          ? (anthropicIdentity?.value ?? anthropicSignal)
                          : personaConversationOrder(
                              anthropicIdentity?.value ?? anthropicSignal,
                              (parsed as AnthropicRequestBody).messages,
                              personaSystemText,
                              pluginReportedModel(req.headers),
                          ))
                    : anthropicIdentity?.value ?? anthropicSignal)
            : protocol === "openai"
              ? (dshPersona && !sideRequestLike && personaSystemText !== ""
                    ? personaConversationOrder(
                          openaiIdentity?.value ?? openaiSignal,
                          (parsed as OpenAIRequestBody).messages,
                          personaSystemText,
                          pluginReportedModel(req.headers),
                      )
                    : openaiIdentity?.value ?? openaiSignal)
              : codexTurn
                // Trusted Codex turn id enters the verbatim session chain
                // directly — do NOT route it through subagentNamespace (the
                // kernel's empty-instructions non-anchoring path is left
                // untouched for metadata-less clients).
                ? codexTurn.value
                 : dshPersona && !sideRequestLike && ((parsed as ResponsesRequestBody).instructions ?? "") !== ""
                   // #2203/#2241: parity with the anthropic/openai lanes —
                   // dsh-over-Responses rides the same continuity-aware persona
                   // anchor: a model switch (history continues the raw key's
                   // chain) migrates the anchor on the raw key; a history-
                   // discontinuous auto-review blob forks onto `|sub:<fp>`.
                   // Must sit BEFORE the stableSystemAnchor branch below so a
                   // plugin request never takes the plain-proxy verbatim anchor.
                   // Empty instructions = non-anchoring (verbatim id).
                    ? personaConversationOrder(
                          responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader),
                          (parsed as ResponsesRequestBody).input,
                          (parsed as ResponsesRequestBody).instructions ?? "",
                          pluginReportedModel(req.headers),
                      )
                 : opts.stableSystemAnchor && pluginAgentHeader(req.headers) === undefined
                   // #1085: with anchoring on (plain-proxy mode only — see the
                   // prepare* gates), instruction drift is the expected event —
                   // the sticky head-system anchor absorbs it (trailing update
                   // notes), so keying a changed-instructions request into a
                   // `|sub:<fp>` session would orphan the anchor state and
                   // defeat the feature. Plugin requests keep default identity
                   // derivation because they never get anchored. Same
                   // verbatim-identity treatment as the trusted codexTurn
                   // branch above.
                   ? (responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader))
                   : instructionsFingerprintApplies(req.headers)
                     // #1106: the instructions fingerprint is an inverted
                     // allowlist — it applies ONLY to codex traffic (root
                     // threads / older builds; subagent threads key by thread-id
                     // above) and claude-over-Responses (#150/#970 id-sharing
                     // personas). Everyone else (opencode #1102, grok/mcode,
                     // plugin lanes, generic x-session-id / body session_id)
                     // keys verbatim: instructions drift there means the same
                     // conversation evolved (upgrade / plugin / AGENTS.md),
                     // not a new persona. See instructionsFingerprintApplies
                     // in src/session-id.ts.
                      ? (!sideRequestLike
                          ? // #2250: same continuity resolver as the dsh lanes
                            // — an instructions drift whose history continues
                            // the raw key's chain (model switch / AGENTS.md
                            // edit / -c override / upgrade reassembly) MIGRATES
                            // the anchor instead of forking the main lane off
                            // its compression state; a genuinely fresh task
                            // reusing the id (#150) still forks `|sub:<fp>`.
                            // Empty instructions = non-anchoring: ride the
                            // verbatim id (codex turn-1 / metadata-less roots).
                            ((parsed as ResponsesRequestBody).instructions ?? "") === ""
                              ? (responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader))
                              : personaConversationOrder(
                                responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader),
                                (parsed as ResponsesRequestBody).input,
                                (parsed as ResponsesRequestBody).instructions ?? "",
                                pluginReportedModel(req.headers),
                          )
                          : (responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader)))
                      : (responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader));
        // #1916/#1307: true when the dsh persona fingerprint actually split
        // this request onto a suffixed session key (kernel anchor mismatch).
        // Used by the recordPluginSession branch below so the fork records
        // under its split id instead of stealing the raw conversation key
        // from the main session (same single-valued-map discipline as #970).
        const rawPersonaIdentity = protocol === "openai"
            ? (openaiIdentity?.value ?? openaiSignal)
            : protocol === "anthropic"
              ? (anthropicIdentity?.value ?? anthropicSignal)
              : protocol === "google" && dshPersona
                // #2730: the google lane records its fork under the suffixed id
                // too (same #970 discipline as openai/anthropic/responses above)
                // so the conversations map keeps the raw key owned by the main
                // session.
                ? (googleIdentity?.value ?? googleSignal)
                : protocol === "responses" && dshPersona
                // #2203: the responses lane is persona-aware too — dsh's
                // auto-review rides `instructions` under the same conversation id
                // as its main turns, and the fork must record itself under its
                // suffixed id so the single-valued conversations map keeps the raw
                // key owned by the main session (#970 discipline).
                ? (responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader))
                : undefined;
        const personaForked = rawPersonaIdentity !== undefined && conversation !== rawPersonaIdentity;
        // #2170 measure 4: stamp sessions deliberately namespaced onto a
        // `|sub:` key — #970 claude subagents, #1916/#1307/#1314 dsh persona-
        // fork reviews, codex/claude-over-Responses instructions personas —
        // so the split-session canary can tell a DESIGNED split from the
        // #2165 drift shape (see splitSessionWarnings in src/session.ts).
        // personaForked covers the anthropic/openai/google wires plus
        // dsh-over-Responses (#2203/#2730); the explicit responses clause
        // below stays for the codex/claude instructions personas (codexTurn
        // keys verbatim and must not count).
        const designNamespaced = personaForked
            || (protocol === "responses"
                && codexTurn === undefined
                && instructionsFingerprintApplies(req.headers)
                && !sideRequestLike
                && responsesIdentity !== undefined
                && conversation !== responsesIdentity.value);
        // The session ID is the client-provided conversation value VERBATIM —
        // no hash, no protocol/credential/upstream dimensions (#286): those
        // are all mutable mid-conversation (bearer rotation, relay switching,
        // protocol translation), and only the client's own conversation id is
        // bound to the conversation. Requests without a client-provided
        // identity are rejected: content-fingerprint sessions have a real
        // collision surface and would silently orphan state.
        const clientProvided = protocol === "responses"
            ? (responsesIdentity?.clientProvided ?? false)
            : protocol === "openai"
              ? (openaiIdentity?.clientProvided ?? false)
              : protocol === "anthropic"
                ? (anthropicIdentity?.clientProvided ?? false)
                : protocol === "google"
                  ? (googleIdentity?.clientProvided ?? false)
                  : !!convHeader;
        // Anonymous fallback (#309): clients with no identity signal at all
        // (no headers, no session_id/prompt_cache_key) still replay their full
        // history — resolve them by longest-prefix affinity instead of the
        // #286 hard 400. Resolution is content-only (#286 lesson): protocol,
        // upstream and credentials are mutable mid-conversation and MUST NOT
        // fork the session. Requests with no usable conversation signal
        // (empty / system-only) keep the explicit 400.
        // #1486: the conversation message list for hashing — extracted lazily
        // once per request and shared by the anonymous resolver below and the
        // identified-session tracking / resume detection further down. Lazy on
        // purpose: an unparseable body must not be touched on paths that never
        // need it (the anonymous path keeps its exact historical behavior).
        let affinityMessagesCache: unknown[] | null = null;
        const affinityMessageList = (): unknown[] => {
            if (affinityMessagesCache !== null) return affinityMessagesCache;
            const raw = protocol === "responses"
                ? ((parsed as { input?: unknown }).input ?? [])
                : protocol === "google"
                  ? ((parsed as GoogleRequestBody).contents ?? [])
                  : ((parsed as { messages?: unknown }).messages ?? []);
            affinityMessagesCache = Array.isArray(raw) ? raw : [];
            return affinityMessagesCache;
        };
        let anonAffinity: AnonymousAffinity | null = null;
        // #2879: captured on the MINT request only (see the else branch below)
        // so the pfa-* ledger's producer stays attributable after the fact.
        let anonProvenance: AnonymousProvenance | undefined;
        if (!clientProvided) {
            anonAffinity = prefixAffinity.resolve(affinityMessageList());
            if (!anonAffinity) {
                log("warn", `400: no stable conversation identity on ${protocol} request → ${maskUrlsInText(upstreamOrigin)}; refusing to create a content-fingerprint session (#286)`);
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify(protocol === "anthropic"
                    ? { type: "error", error: { type: "invalid_request_error", message: NO_IDENTITY_MESSAGE } }
                    : { error: { type: "invalid_request_error", message: NO_IDENTITY_MESSAGE } }));
                return;
            }
            if (anonAffinity.via === "simhash" && anonAffinity.adoption) {
                // #2265: the exact chain broke (client-side decorative rewrite,
                //  e.g. Trae re-stamping model tags) but chain-level similarity
                //  re-attached the EXISTING session — fold state survives.
                log("info", `[prefix-affinity] simhash adoption: anonymous ${protocol} request → session ${anonAffinity.sessionId} (chain rewritten client-side; ${Math.round(anonAffinity.adoption.coverage * 100)}% of ${anonAffinity.matchedDepth} positions similar, mean Hamming ${anonAffinity.adoption.meanHamming.toFixed(1)} — re-attaching, compression state preserved #2265)`);
                loggerLog("info", `[prefix-affinity] session ${anonAffinity.sessionId} re-attached via simhash alignment (coverage ${Math.round(anonAffinity.adoption.coverage * 100)}%, depth ${anonAffinity.matchedDepth}/${anonAffinity.incomingDepth})`);
            } else if (anonAffinity.matchedDepth > 0) {
                log("info", `[prefix-affinity] anonymous ${protocol} request → session ${anonAffinity.sessionId} (prefix match depth=${anonAffinity.matchedDepth}/${anonAffinity.incomingDepth}, tail=${anonAffinity.tailHash.slice(0, 8)}; fork semantics: diverged histories split on their next request)`);
                loggerLog("info", `[prefix-affinity] session ${anonAffinity.sessionId} matched at depth ${anonAffinity.matchedDepth}/${anonAffinity.incomingDepth} (tail=${anonAffinity.tailHash.slice(0, 8)})`);
            } else {
                // #2879: this fresh mint is the ONE observable moment the
                // producer exists — capture its fingerprint here or the pfa-*
                // ledger is forever unattributable (H1/H2 could not be told
                // apart from #2847's files). First-writer-wins downstream.
                anonProvenance = buildAnonymousProvenance(req.headers, affinityMessageList(), req.socket?.remoteAddress);
                const provSuffix = `; ua=${JSON.stringify(anonProvenance.ua ?? "-")} plugin=${anonProvenance.pluginAgent ?? "-"} first=${JSON.stringify(anonProvenance.firstMsg ?? "-")}`;
                const lineage = anonAffinity.lineage ? `; lineage=${anonAffinity.lineage.reason} of ${anonAffinity.lineage.parents.join(",")}` : "";
                log("info", `[prefix-affinity] new anonymous session ${anonAffinity.sessionId} (depth=${anonAffinity.incomingDepth}, tail=${anonAffinity.tailHash.slice(0, 8)}${lineage}${provSuffix})`);
                loggerLog("info", `[prefix-affinity] new session ${anonAffinity.sessionId} at depth ${anonAffinity.incomingDepth} (tail=${anonAffinity.tailHash.slice(0, 8)}${lineage}${provSuffix})`);
                // A verified anonymous history replay is evidence of possible
                // identity loss, not proof that the identified client moved.
                if (anonAffinity.orphanSuspect !== undefined && anonAffinity.orphanSuspect.length > 0) {
                    const suspects = anonAffinity.orphanSuspect.join(", ");
                    log("warn", `[prefix-affinity] anonymous ${protocol} replay matches a full history prefix of identified session(s) ${suspects} — possible identity loss; original session state retained (#2791 family)`);
                    for (const sid of anonAffinity.orphanSuspect) {
                        const suspect = peekSession(sid);
                        if (!suspect) continue;
                        recordConflict(suspect, "identity-orphan", `anonymous ${protocol} request replayed a verified full history prefix without client identity (incoming depth ${anonAffinity.incomingDepth}); served as ${anonAffinity.sessionId} — possible identity loss, original session state retained (#2791 family)`);
                    }
                }
            }
        }
        const sessionId = anonAffinity ? anonAffinity.sessionId : conversation;
        // Tag every downstream log line of THIS request with the session id
        // ([sess=<id>] via AsyncLocalStorage — zero call-site changes across the
        // codebase): the web log view and plain grep can now pull process-level
        // context around a session instead of only the few call sites that
        // embed the id manually. One statement, runs in this request's own
        // async context, so concurrent requests never cross-contaminate.
        enterSessionContext(sessionId);
        // #1086/#1357: content-fallback chain observation, now that identity is known.
        // Artifacts + processed local state ⇒ self-produced: process normally.
        // Artifacts + NO local state ⇒ ADVISORY observation (#1357 Phase 1): the
        // content may be user-authored (AGENTS.md examples, docs, pastes), so it
        // no longer forces byte-identical passthrough — record one observation for
        // /acp diagnostics and fall through to processTurn so this session
        // establishes its own ownership state. Decisive verbatim passthrough
        // stays reserved for the x-bili-hop header (above).
        if (artifactSeed) {
            const artifactKind = detectAcpArtifacts(bodyBuffer, parsed);
            // #1197: a cooperative plugin announces itself with x-bili-plugin —
            // its protocol RE-SENDS bili's compression artifacts (the compress
            // tool call + result live in the agent's own re-sent history by
            // design), so content-shape evidence can never outrank that
            // announcement. The #1086 fallback guards NON-cooperative clients
            // chained behind a header-stripping middlebox; a plugin client that
            // is ALSO double-chained through another bili AND had the hop header
            // stripped is contrived, and weighing it against silently losing
            // compression + /acp for every resumed plugin session (the #1197
            // incident) says: process.
            const pluginAnnounced = pluginAgentHeader(req.headers) !== undefined;
            if (artifactKind !== null && !pluginAnnounced && !hasProcessedState(sessionId, { protocol })) {
                // #1357 Phase 1: historical ACP content is ADVISORY, never
                // decisive. It can be user-authored (AGENTS.md / docs / CCR
                // lossless originals / pastes), so judging it a foreign chain
                // and forwarding verbatim here permanently locked FRESH sessions
                // into passthrough — the decision returned before any session was
                // created, so no ownership state ever existed to clear the next
                // request. Record the observation for /acp diagnostics and fall
                // through to processTurn so this session establishes ownership.
                // Decisive passthrough stays reserved for the authenticated
                // x-bili-hop header (above + at the passthrough tail). Trade-off:
                // a bili→bili relay that STRIPS x-bili-hop double-processes until
                // both sides ship the request checkpoint (#1421) — once stamped,
                // the content-level gate above catches it regardless of headers.
                // #1218: recorded under the session id AND the client's own
                // conversation value when they differ (same key space /acp
                // status probes use) so the observation is visible to the client.
                const firstVerdict = recordChainVerdict(sessionId, artifactKind, protocol);
                if (clientConv !== undefined && clientConv !== sessionId) recordChainVerdict(clientConv, artifactKind, protocol);
                if (firstVerdict) {
                    log("warn", `[chain] inbound ${protocol} request carries ACP compression artifacts (${artifactKind}) but neither ${BILI_HOP_HEADER} nor local compression state for session ${sessionId}. Historical ACP content is advisory-only — continuing to processTurn so this session establishes ownership (#1357); a header-stripping bili→bili relay may now double-process until both sides ship the request checkpoint (#1421).`);
                }
            } else if (artifactKind !== null) {
                log("debug", `[chain] ACP artifacts (${artifactKind}) belong to this instance's own session ${sessionId} — self-produced, processing normally (#1086)`);
            }
        }
        // Two separate uses of the conversation signal:
        //  - `affinity`: a client-supplied identity value forwarded upstream
        //    as x-session-id for sticky-routing / cache pools. Proxy-generated
        //    identities (content fingerprints, pfa-* prefix-affinity ids) stay
        //    internal: affinityToken() returns undefined for them, so a
        //    header-less client (pi) adds no upstream identity (#286).
        //  - `label`: human-readable display in the web UI / stats. We store
        //    ONLY the client's own value (opencode x-session-affinity, codex
        //    body.session_id), so a user can tell at a glance which client
        //    owns a session. Pi sends nothing: prefix-affinity-resolved
        //    sessions get the "prefix-affinity <tail8>" label — suffixed with
        //    the MINT request's tail fragment (#2879) so N parallel anonymous
        //    ledgers stop sharing one identical label, the shape #2847
        //    misread as twin files of a single session. First-write-wins keeps
        //    it stable for the session's life; pre-#2879 sessions keep the
        //    bare label (no migration). Others stay empty ("—" in the UI).
        const bodyIdentity = responsesIdentity ?? openaiIdentity ?? anthropicIdentity ?? googleIdentity;
        const affinity = affinityToken(bodyIdentity ?? {
            value: clientConv ?? conversation,
            source: clientConv ? "header" : "generated",
            clientProvided: !!clientConv,
        });
        const clientLabel = bodyIdentity?.clientProvided
            ? bodyIdentity.value
            : clientConversationHeader(req.headers);
        const session = getSession(sessionId, { protocol, upstreamOrigin, label: clientLabel ?? (anonAffinity ? `prefix-affinity ${anonAffinity.tailHash.slice(0, 8)}` : undefined) });
        memProbe(opts.debug, log, sessionId, "inbound-parsed", bodyBuffer.length);
        if (designNamespaced && session.metadata.personaNamespace !== true) session.metadata.personaNamespace = true;
        let publicForkPrefix = false;
        if (!countTokens && !responsesCompact && session.metadata.publicForkReceipt !== undefined) {
            acquireInFlight(session);
            try {
                const accepted = await withSessionLock(session, () => {
                    const verdict = publicForkInputCheck(session, protocol, parsed);
                    if (verdict.ok || session.stats.requests > 0) {
                        publicForkPrefix = true;
                        return true;
                    }
                    // #3741 resolution (owner decision): the ordered-prefix gate is
                    // now ADVISORY, not blocking. The session-id binding above is
                    // what actually wakes the fork child (client conversation id →
                    // registered child session), and fold reconcile — #3641's
                    // order-over-hash doctrine — repairs coverage drift on resent
                    // history, so a byte-exact pre-gate adds no correctness the
                    // pipeline below doesn't already enforce. What it DID add was a
                    // permanent 409 dead-end: any drift the gate couldn't tolerate
                    // (in-place proxy upgrade re-keying message ids — #3741's field
                    // report, host body rewrite, legacy-hash adoption) stuck the
                    // child conversation forever, because the rejected first request
                    // never increments stats.requests, so every retry re-hit the same
                    // gate with no clear or TTL path. Adopt with a classified warn
                    // (reason taxonomy from the #3743 diagnostics) and let reconcile
                    // settle the inherited folds; a divergent child's first request
                    // goes out unfolded — a one-time token spike, never corruption.
                    // publicForkPrefix stays false on mismatch: the side-lane
                    // heuristics below keep their normal say instead of trusting an
                    // unverified inherited prefix to veto demotion.
                    loggerLog("warn", `[fork-prefix] ${sessionId}: inherited prefix mismatch — adopting anyway (${verdict.reason}; protocol=${protocol})`);
                    return true;
                });
                if (!accepted) return;
            } finally {
                releaseInFlight(session);
            }
        }
        // Audit stamp (#730 forensics): the effective pack for the most recent
        // request (route/model can change it — latest wins). Persisted with the
        // session so post-hoc forensics never needs config-mtime archaeology.
        session.meta.activePack = reqSurfacePack;
        if (externalSummaryEnabled(reqConfig)) session.meta.summaryInstructions = buildCompressSystemPrompt(reqPrompts, reqSurface?.promptSections);
        else delete session.meta.summaryInstructions;
        // #1082: rebuild-cost signal for the session-file GC — token estimate
        // of the RAW wire payload (full history as received, pre-fold/injection).
        // Text + images: image bytes are skipped by estimateRawBodyTokens but
        // they DO ride every re-send, so an image-heavy idle session must not
        // look cheap to the sweep (review: 400K image + 50K text was recorded
        // as 50K). Latest wins: history grows monotonically within a session
        // and shrinks after native compaction boundaries, which is when the
        // re-send really gets cheaper.
        if (parsed !== null && typeof parsed === "object") {
            session.metadata.rawInputTokens = estimateRawBodyTokens(parsed) + imageTokensInParsedBody(protocol, parsed, imageBillingFor(opts, upstreamOrigin), imageTokenCapFor(opts, upstreamOrigin));
        }
        if (anonAffinity) {
            prefixAffinity.note(sessionId, anonAffinity.incomingDepth, anonAffinity.tailHash, anonAffinity.itemHashes, false, anonAffinity.sketches, anonAffinity.userFlags, undefined, anonAffinity.tailFragments);
            scheduleAffinityPersist();
            // The rest of this stamp is latest-wins; `producer` is NOT — the
            // mint request's fingerprint must survive every later turn (#2879).
            const existingProducer = (session.metadata.anonymousPrefixAffinity as { producer?: AnonymousProvenance } | undefined)?.producer;
            session.metadata.anonymousPrefixAffinity = {
                depth: anonAffinity.incomingDepth,
                tailHash: anonAffinity.tailHash,
                via: anonAffinity.via,
                ...(anonAffinity.lineage ? { lineage: anonAffinity.lineage } : {}),
                ...(existingProducer ? { producer: existingProducer } : anonProvenance ? { producer: anonProvenance } : {}),
            };
        } else if (clientProvided) {
            // #1486: track identified clients' chains too, so a resume that
            // forks a NEW client id (cc --resume) can be matched back to its
            // parent across requests and proxy restarts (the #499 snapshot
            // carries these entries verbatim). Append-only discipline (#1075):
            // side requests reuse the session id with FEWER messages — never
            // shrink the tracked chain; a longer-or-equal payload extends or
            // rewrites it (both are newer truth). A shrunken rewrite (native
            // /compact echo) intentionally does NOT update the chain: that
            // resume degrades to today's fresh-start behavior rather than
            // risking a side-request clobber.
            const fp = prefixAffinity.chainFingerprint(affinityMessageList());
            if (fp) {
                const tracked = prefixAffinity.peekChain(sessionId);
                // #2791: a pre-upgrade (raw-hash) entry is always
                //  re-anchored — its depth counts raw wire messages, not
                //  neutral turns, so the append-only comparison would
                //  misjudge a version migration as a shrink.
                if (!tracked || tracked.hv !== 2 || fp.depth >= tracked.depth) {
                    prefixAffinity.note(sessionId, fp.depth, fp.tailHash, fp.itemHashes, true, undefined, undefined, fp.normTailHash, fp.tailFrags);
                    scheduleAffinityPersist();
                }
            }
        }
        // Fork block-adoption (#629): a fresh anonymous session born from a
        // mid-history fork inherits the parent's fully-present compression
        // blocks (copy-on-fork) instead of restarting with zero state. Runs
        // BEFORE the prepare*/processTurn below so the seeded refs are there
        // for reconciliation; only on the session's first request so a replay
        // can never re-adopt. Always safe to call — it logs the adoptable
        // inventory even when adoption is disabled (the #629 measurement).
        if (anonAffinity?.via === "new" && anonAffinity.lineage?.reason === "forked" && session.stats.requests === 0) {
            try {
                maybeAdoptForkBlocks({
                    session,
                    parentId: anonAffinity.lineage.parents[0]!,
                    protocol,
                    parsed,
                    upstreamOrigin,
                    enabled: opts.forkAdoption === true,
                    log,
                });
            } catch (err) {
                log("warn", `[fork-adoption] failed (${String(err)}); continuing with fresh state (#629)`);
            }
        }
        // Launcher-mode binding (#162): prefer identity — claude code sends
        // x-claude-code-session-id on every request, equal to the
        // CLAUDE_CODE_SESSION_ID the MCP shell registered, so binding is
        // race-free. Fall back to the headless pending queue (codex spawn)
        // for the first request that creates a new session.
        let derivedParent: string | undefined;
        if (!pluginAgent && !anonAffinity) {
            const identityAgent = consumePluginRegisterFor(clientConv ?? conversation);
            if (identityAgent) {
                pluginAgent = identityAgent.agent;
                pluginConversation = clientConv ?? conversation;
                derivedParent = identityAgent.parentConversationId;
            }
        }
        if (!pluginAgent && session.stats.requests === 0 && codexTurnIdentity(req.headers) === undefined && claudeSub === undefined) {
            // A codex subagent thread mints a fresh session too, but it must
            // not claim the ROOT conversation's pending register (the plugin
            // binding belongs to the root session, #317). Same for a split
            // Claude Code subagent session (#970): its first request looks
            // brand-new, but the root's register is not its to claim.
            // An MCP registration is claimable only by a request declaring the
            // fixed mcp__bili__ server tools. A stale MCP shim must not bind
            // an unrelated native wire session to plugin mode and suppress
            // tool injection. Other launcher registrations keep their
            // headless binding contract.
            const pending = declaresMcpBiliToolsOnWire(parsed)
                ? takePendingPluginRegister((candidate) => candidate.agent === "mcp")
                : takePendingPluginRegister((candidate) => candidate.agent !== "mcp");
            if (pending) {
                pluginAgent = pending.agent;
                pluginConversation = pending.conversationId;
                derivedParent = pending.parentConversationId;
            }
        }
        if (!pluginAgent && typeof session.metadata.pluginAgent === "string") pluginAgent = session.metadata.pluginAgent;
        if (pluginAgent && !pluginConversation) pluginConversation = conversation;
        // #1426 web UI: persist which client this session came from, first hit wins.
        // Plugin agents are already recorded above as metadata.pluginAgent; non-plugin
        // clients fall back to header sniffing, then to a truncated User-Agent hint.
        if (!pluginAgent && !session.metadata.clientHint) {
            const uaRaw = req.headers["user-agent"];
            const ua = typeof uaRaw === "string" ? uaRaw : Array.isArray(uaRaw) ? String(uaRaw[0] ?? "") : "";
            const hint = sniffScanClient(req.headers) ?? (ua ? ua.slice(0, 120) : undefined);
            if (hint) session.metadata.clientHint = hint;
        }
        // #4571: which engine served this session — "inline" (pi\u2019s in-process
        // engine, no server process) or "server" (a standalone proxy process,
        // spawned or attached). First hit wins like clientHint so the badge
        // reflects the lane the session was born in; the web UI surfaces it so
        // “did this run inline?” is answerable at a glance instead of from logs.
        if (session.metadata.engineLane === undefined) {
            session.metadata.engineLane = opts.inlineLane === true ? "inline" : "server";
        }
        // [#1333] Real pi plugin traffic arrives pre-stamped: `x-bili-plugin`
        // + `x-bili-plugin-conversation` (set by the extension, pi.ts:127)
        // set pluginAgent/pluginConversation from headers above, so the
        // identity branch never runs for it. The identity register (which
        // carries the derived child's parentConversationId) is keyed by that
        // same conversation id and has already landed — the extension awaits
        // the register POST inside registerTools before the first stamped
        // request is sent (#1214) — so consult it here too. Link-only: on
        // non-derived conversations parentConversationId is absent and this
        // is a no-op.
        if (derivedParent === undefined && pluginAgent !== undefined && pluginConversation !== undefined && !anonAffinity) {
            const stamped = consumePluginRegisterFor(pluginConversation);
            if (stamped?.parentConversationId !== undefined) derivedParent = stamped.parentConversationId;
        }
        if (pluginAgent) {
            if (session.metadata.pluginAgent !== pluginAgent) session.metadata.pluginAgent = pluginAgent;
            // #970: for a split subagent session, record it under its split
            // conversation id — recording under the raw conversation value
            // would flip the single-valued conversations map between the main
            // and subagent sessions on every interleaved request, breaking
            // /acp lookups and MCP tool routing (last writer wins). The raw
            // key keeps pointing at the MAIN session; the subagent session
            // stays reachable via its verbatim split id and its canonical
            // pfa-* (printed in wire notes). personaForked (#1916/#1307:
            // dsh review persona split onto a `|sub:<fp>` session) gets the
            // same discipline — the fork records under its suffixed id and
            // the raw key stays owned by the main session.
            recordPluginSession((claudeSub !== undefined || personaForked) ? conversation : (pluginConversation ?? conversation), session.id);
        }
        // #1206: first request of this session — identify the client and scan
        // its plugin registry for a co-resident THIRD-PARTY compression plugin
        // (two compressors on one conversation double-compress and corrupt
        // refs). Best-effort: any failure is logged once, never disturbs the
        // request path. Findings land in the session conflict ledger so they
        // stay visible in acp_status / web UI / stats for the whole session.
        if (session.stats.requests === 0 && conflictScanEnabled(process.env)) {
            try {
                const client = pluginAgent ?? sniffScanClient(req.headers);
                if (client !== undefined) {
                    const res = scanClientPlugins(client, { env: process.env, cwd: process.cwd() });
                    for (const f of res.findings) {
                        if (isDesignBenign(f, pluginAgent)) continue;
                        const risk = f.match === "known"
                            ? "it is bili's sibling compressor — two compressors on one conversation will double-compress and corrupt message refs"
                            : "its name matches compression keywords — IF it also compresses context, the two compressors will double-compress and corrupt message refs";
                        recordConflict(session, "third-party-plugin", `${f.client}: ${f.entry} (${f.source})${f.match === "keyword" ? " [suspected]" : ""}`);
                        log("warn", `[conflict] co-resident compression plugin detected on ${f.client}: ${f.entry} (${f.source}) — ${risk} (#1206). Remove or disable the other plugin, or route this client exclusively through bili.`);
                    }
                }
            } catch (err) {
                log("warn", `[conflict] third-party plugin scan failed: ${String(err)} (#1206)`);
            }
        }
        // #1486: resume-fork inheritance for identified clients. Clients such
        // as Claude Code fork a FRESH client-provided session id on --resume
        // while replaying the full transcript; verbatim identity keying would
        // start the resumed conversation at zero compression state and
        // renumber refs from m00001, so the model's stale citations (its own
        // earlier text cites old refs) either fail loudly or — worse —
        // silently resolve onto DIFFERENT messages. Match the incoming history
        // byte-exactly against tracked chains (head-anchored, survives proxy
        // restarts via the persisted snapshot) and inherit: every ref
        // assignment whose raw id is present (refs are content-addressed — a
        // seeded ref always denotes the exact bytes the model saw), the
        // fully-present blocks (#1834: adopted together with this inheritance —
        // losing them on resume meant the folded originals came back on the
        // wire; forkAdoption only gates anonymous forks, #629), and the
        // derivedFrom lineage (decompress/search_context fall back to the parent chain).
        // First request only: the state copy must land before processTurn
        // assigns refs. #2408: this match runs BEFORE the #1333 explicit
        // parent link below — a DECLARED parent (claude --fork-session
        // SessionStart register, opencode derived register) scopes the match
        // to that parent's chain (findResumeParentWithin), and on a hit the
        // richer inheritance wins while the link gate (derivedFromSessionId
        // now set) skips the redundant read-only link; on a miss the link
        // lands on the SAME first request (pi RLM children: no replay, link
        // as before — no deferral, no timing change).
        if (clientProvided && !anonAffinity && session.stats.requests === 0 && session.metadata.derivedFromSessionId === undefined && session.metadata.publicForkReceipt === undefined && opts.resumeInheritance !== false) {
            const loadParent = (id: string): Session | undefined => peekSession(id) ?? getStore().loadSync(id, { protocol, upstreamOrigin }) ?? undefined;
            // Claude Code records its fork parent in the transcript
            // (forkedFrom) — authoritative where the byte-exact prefix match
            // below fails: equal-length resumes and re-decorated tails (a
            // resume-time reminder appended to the last messages) made it
            // fall back to a far older ancestor, dropping every block folded
            // since. Main lane only (a `|sub:` split is not the transcript's
            // session), loopback only (the transcript is a local file).
            let resume: { sessionId: string; sharedDepth: number; via: string } | null = null;
            const claudeHeader = conversationHeaderSource(req.headers);
            if (protocol === "anthropic" && claudeHeader?.name === "x-claude-code-session-id" && claudeHeader.value === sessionId && isLoopbackAddress(req.socket.remoteAddress)) {
                try {
                    const lineage = resolveClaudeTranscriptLineage(sessionId, (id) => id !== sessionId && loadParent(id) !== undefined);
                    if (lineage.parentId !== undefined) {
                        resume = { sessionId: lineage.parentId, sharedDepth: 0, via: `transcript forkedFrom (${lineage.hops} hop${lineage.hops === 1 ? "" : "s"})` };
                    } else if (lineage.reason !== "no-transcript" && lineage.reason !== "no-fork-marker" && lineage.reason !== "invalid-id") {
                        log("info", `[${sessionId}] [resume-inheritance] transcript lineage unusable (${lineage.reason}); falling back to prefix match (#1486)`);
                    }
                } catch (err) {
                    log("warn", `[${sessionId}] [resume-inheritance] transcript lineage lookup failed (${String(err)}); falling back to prefix match (#1486)`);
                }
            }
            if (!resume) {
                const affinityList = affinityMessageList();
                const matched = derivedParent !== undefined
                    ? prefixAffinity.findResumeParentWithin(derivedParent, affinityList, sessionId)
                    : prefixAffinity.findResumeParent(affinityList, sessionId);
                if (matched) {
                    resume = { sessionId: matched.sessionId, sharedDepth: matched.sharedDepth, via: `${matched.sharedDepth} msg(s) byte-exact prefix` };
                } else {
                    // #4264: a miss must not be silent — equal-depth replay,
                    // parent-chain absence and head break need completely
                    // different fixes, so name the closest near-miss.
                    // Diagnostics only: matching above is untouched.
                    const miss = derivedParent !== undefined
                        ? prefixAffinity.diagnoseResumeMiss(affinityList, sessionId, derivedParent)
                        : prefixAffinity.diagnoseResumeMiss(affinityList, sessionId);
                    log(miss.best !== undefined ? "info" : "debug", `[${sessionId}] [resume-inheritance] miss: ${describeResumeMiss(miss)} (#4264)`);
                }
            }
            if (resume) {
                const resumeParent = loadParent(resume.sessionId);
                if (resumeParent && resumeParent !== session) {
                    session.metadata.derivedFrom = resumeParent.id;
                    session.metadata.derivedFromSessionId = resumeParent.id;
                    markDirty(session);
                    persistLineageLinkNow(session);
                    log("info", `[${sessionId}] [resume-inheritance] ${resume.via} of ${resumeParent.id} — inheriting refs/blocks/lineage (#1486)`);
                    try {
                        maybeAdoptResume({
                            session,
                            parent: resumeParent,
                            sharedDepth: resume.sharedDepth,
                            protocol,
                            parsed,
                            upstreamOrigin,
                            blocksEnabled: true, // #1834: this branch is already gated on resumeInheritance — identified resume-forks adopt blocks by default; forkAdoption only gates anonymous forks (#629)
                            log,
                        });
                    } catch (err) {
                        log("warn", `[resume-inheritance] failed (${String(err)}); continuing with fresh state (#1486)`);
                    }
                } else {
                    log("info", `[${sessionId}] [resume-inheritance] matched tracked chain ${resume.sessionId} but the parent session is not loadable — starting fresh (#1486)`);
                }
            }
        } else if (clientProvided && session.stats.requests === 0) {
            // #4264: a SKIPPED gate must not be silent either — without this
            // line, zero [resume-inheritance] output stays ambiguous between
            // "gate skipped" and "pre-#4265 build / silent miss". First
            // request only: stats.requests increments later in the prepare
            // lanes, so this fires at most once per session. anonAffinity is
            // structurally null here (only the anonymous lane sets it),
            // leaving exactly three skip reasons.
            const skipReason = session.metadata.derivedFromSessionId !== undefined ? "derivedFromSessionId"
                : session.metadata.publicForkReceipt !== undefined ? "publicForkReceipt"
                : "resumeInheritance=false";
            log("debug", `[${sessionId}] [resume-inheritance] skipped: ${skipReason} (#4264)`);
        }
        // [#1333] explicitly derived conversations (pi RLM child, omp fork,
        // opencode subagent: the plugin reported its parent at register)
        // record the parent link once — normally on the child's first request,
        // but the register POST can land AFTER it (the extension flips
        // tools-ready before the register completes), so late requests of the
        // same session may record it (#1362). No state is copied — acp-kernel's
        // syncBlocks deactivates blocks whose source messages are absent from
        // the child's wire, so seeding blocks into an empty-history child never
        // sticks. Instead decompress/search_context fall back to the linked
        // parent chain at read time (src/decompress-shared.ts, depth cap 8).
        // Late binding is harmless (the link copies nothing at link time), so
        // the gate is idempotence, not first-request. Runs AFTER the #1486
        // resume match above: a replay-fork child that already inherited has
        // derivedFromSessionId set and skips this link.
        if (derivedParent !== undefined && session.metadata.derivedFromSessionId === undefined && session.metadata.publicForkReceipt === undefined) {
            try {
                const parentSession = resolveConversation(derivedParent)?.session;
                if (parentSession) {
                    session.metadata.derivedFrom = derivedParent;
                    session.metadata.derivedFromSessionId = parentSession.id;
                    markDirty(session);
                    persistLineageLinkNow(session);
                    maybeAdoptDerivedFork({ session, parent: parentSession, protocol, parsed, upstreamOrigin, enabled: opts.resumeInheritance !== false, log });
                    log("info", `[${session.id}] [derived] linked to parent session ${parentSession.id} (conversation ${derivedParent}) — decompress/search_context fall back to it read-only (#1333)`);
                } else if (session.metadata.derivedLinkMissLogged !== true) {
                    // The relaxed gate retries resolution on EVERY request until the link
                    // lands — cap the miss signal at one line per session per proxy
                    // process (in-memory flag: a restart re-warns once, which is useful).
                    session.metadata.derivedLinkMissLogged = true;
                    log("warn", `[${session.id}] [derived] parent conversation ${derivedParent} is unknown to this proxy — no inheritance; continuing fresh (#1333)`);
                }
            } catch (err) {
                if (session.metadata.derivedLinkMissLogged !== true) session.metadata.derivedLinkMissLogged = true;
                log("warn", `[${session.id}] [derived] parent link from ${derivedParent} failed (${String(err)}); continuing fresh (#1333)`);
            }
        }
        // Responses, OpenAI-chat AND Anthropic-wire clients that send their
        // own session id as `prompt_cache_key` (omp) get that conversation
        // recorded even WITHOUT the x-bili-plugin header, so the /acp command
        // — which looks the session up by the client's session id — can find
        // it. The session id itself now ALSO derives from prompt_cache_key (the
        // preferPromptCacheKeyIdentity calls above, which only kick in when the
        // kernel would have fallen to a per-request content fingerprint) — this
        // lookup binding remains for clients that send a real conversation
        // header or session_id.
        if (protocol === "responses" || protocol === "openai" || protocol === "anthropic") {
            const pck = (parsed as { prompt_cache_key?: unknown }).prompt_cache_key;
            if (typeof pck === "string" && pck.trim().length > 0) {
                recordPluginSession(pck.trim(), session.id);
            }
        }
        // Two compression modes, decided here per request and bound per session
        // (see TECHNICAL-NOTES.md "Two compression modes"):
        //  - pluginMode (x-bili-plugin header / registered agent): the ACP-native
        //    agent (pi/omp) OWNS compression — it executes `compress` locally, the
        //    call+result live in its own re-sent history, and the summary carrier
        //    is the TOOL CALL. The proxy suppresses tool injection (injectTools
        //    below) and the agent's view never renders the kernel's acp_summary.
        //  - proxy mode (no header): a plain client can't run `compress`, so the
        //    proxy executes it server-side; the tool call is ephemeral (never in
        //    the client's history) and preflight blocks have none, so the summary
        //    carrier is the acp_summary message — which systemToUser re-voices as
        //    a USER message (leaving it at its anchor) so strict backends (SGLang:
        //    exactly one system at index 0, #377) accept it and the head system
        //    message stays byte-stable for the prefix cache.
        //
        //    #2155 self-heal degrade: a plugin-bound session whose live plugin
        //    lane died (plugin removed, MCP subprocess gone) is flipped here
        //    back to proxy mode — the proxy re-injects the ACP tools wire-side
        //    and owns compression again, instead of nudging a session whose
        //    tools are gone. The binding (metadata.pluginAgent) is kept so the
        //    session can be restored when the lane returns.
        // NOTE: the restore signal is the LIVE HEADER, not pluginAgent — the
        // sticky binding keeps pluginAgent defined on headerless zombie
        // requests, and restoring on that would clear the degrade one round
        // after arming it (the session never actually degraded).
        if (pluginAgent !== undefined) pluginLaneRestore(session, pluginAgentHeader(req.headers) !== undefined, log);
        // #2268: pi-subagents children whose role allowlist grants none of the ACP
        // context tools are served through the proxy-style channel instead of pure
        // plugin mode (mechanism + scope: src/server/pi-subagent-channel.ts).
        // Session identity stays plugin-bound either way — only the compression
        // channel flips, per request (stateless: whitelist changes self-heal).
        // Like the #2155 degrade above it only ever demotes plugin→proxy, so the
        // two signals compose conjunctively below.
        const subagentFallback = pluginAgent === "pi" ? piSubagentChannelFallback(bodyBuffer, parsed) : { present: false as const };
        if (subagentFallback.present) {
            if (session.metadata.subagentFallbackNotified !== true) {
                session.metadata.subagentFallbackNotified = true;
                markDirty(session);
                log("info", `[${sessionId}] [pi-subagents] child "${subagentFallback.agent ?? "unknown"}" role allowlist lacks ACP context tools — serving proxy-style compression channel (#2268)`);
            }
        }
        const pluginMode = pluginAgent !== undefined && !pluginLaneDegraded(session) && !subagentFallback.present;
        // [#1097/#1271] Stamp the resolved CCR policy. acp_retrieve needs a tool
        // channel that can round-trip the full original, so CCR arms only where
        // that channel exists and is resolvable: proxy mode always (the proxy
        // executes compress/retrieve server-side), and — #1271 — plugin mode on
        // the anthropic/openai wires (the agent advertises acp_retrieve from the
        // manifest and rides the full text back via the request-only injection in
        // prepare*). Every processTurn site strips `ccr` from the loop config
        // unless this stamp says armed — the kernel's ccr-store node must never
        // substitute placeholders the wire cannot resolve (we must never emit a
        // placeholder the model cannot retrieve = silent loss).
        // The responses wire stays out even in plugin mode: its developer-message /
        // strict-alternation injection mechanics have no proven request-only carrier
        // here (and no real plugin lane uses it), so arming it would risk silent loss.
        // The responses text/marker protocol has no native tool channel either
        // (absorb/rules strip themselves there for the same reason), and
        // ACP_NO_INJECT_TOOL disables all injection on that wire — both would
        // leave placeholders unretrievable.
        const storeChannelOk = protocol !== "responses" ||
            (!knobNoInjectTool() && !FORCE_TEXT_PROTOCOL && resolveCompressProtocol(opts.routes, upstreamOrigin) !== "marker");
        // [#1345/#1273] Plugin mode: the static manifest (handlePluginManifest
        // sees opts.compress.ccr, never the route/model-scoped merge) is the ONLY
        // declaration of the retrieve surface, so the executed policy must be the
        // base block verbatim — arm iff base enabled=true, whole block
        // (toolName + thresholds) from base. Any provider/model ccr.* override
        // splits declared from dispatched: toolName renames the session gate away
        // from the registered name (calls 400 as unknown), enabled=false disarms
        // a session whose manifest advertises (stored content unreachable,
        // placeholders dangling). Provider/model ccr.* overrides are therefore
        // proxy-lane-only (the proxy declares+dispatches per request under the
        // merged block, per-route renames intact); findCcrPluginDivergences warns
        // at config load about every divergent level/field.
        const pluginCcrStamp = pluginMode
            ? (ccrPluginWireOk(protocol) && opts.compress.ccr?.enabled === true ? opts.compress.ccr : undefined)
            : (resolvedCcrCfg?.enabled === true ? resolvedCcrCfg : undefined);
        // [#3272/#3266] Same structural gate as the removed image_full restore channel (#3270):
        // the codex host rejects bili-injected tools at its tool router and records a
        // synthetic "unsupported call" output in its own resent history — every
        // acp_retrieve round-trip permanently forks that history from ours (prefix-cache
        // collapse) and leaves placeholderized content unretrievable (silent loss). Disarm
        // CCR on that host so neither an unreachable tool declaration nor a dangling
        // placeholder is ever emitted; regular compress/decompress folding is unaffected
        // (the codex lane simply keeps large tool results verbatim until they are folded).
        // #3686: host policy, not wire profile — declared plugin hosts register bili's tools natively.
        storeEffectiveCcr(session, opts.compress.injectTool && storeChannelOk && !(protocol === "responses" && isCodexHost(req.headers)) ? pluginCcrStamp : undefined);
        // #3400: acp_read_original_image arms where the model can actually reach
        // it — the injection lanes (proxy owns tool execution) or the plugin
        // lanes (the agent registers it natively from handlePluginManifest,
        // base-config gated like every other opt-in tool, #1192). Never on the
        // codex lane: it rejects bili-injected tools ("unsupported call",
        // #3270), so there the annotation degrades to size-only.
        // #3686: host policy, not wire profile — declared plugin hosts register bili's tools natively.
        const imageRescaleArmed = imageRescaleEnabled()
            && !(protocol === "responses" && isCodexHost(req.headers))
            && ((opts.compress.injectTool && storeChannelOk) || pluginMode);
        storeEffectiveImageRescale(session, imageRescaleArmed || undefined);
        // [#1336] no channel gating: search_context is already available on
        // whichever mode served this session and the re-rank is pure output-
        // side policy on its result — both proxy and plugin lanes apply it.
        storeEffectiveSearchPlanAware(session, resolvedSearchPlanAware);
        // #1897: omp-style hosts register bili's ACP tools as first-class extension
        // tools and include them in EVERY model request — including side requests
        // (title-gen), which carry no host action tools of their own. omp titles with
        // max_tokens=1024 (> the 200 budget gate) and stamps no persona header, so
        // neither existing signal sees the request and the title payload rides
        // processTurn under the main session id (refs/usage pollution + ~4K of billed
        // tool tokens per session start). A request whose ENTIRE tools array is bili's
        // own context-management set has no action surface: it is a side request with
        // leaked bili tools, not an agent turn — except when its output budget is
        // starved (<=200), which per #546 must stay a main turn so
        // restoreOutputBudget can rescue it. The signal is plugin-lane-only: the
        // leak mechanism (host registers bili's tools as extension tools) cannot
        // exist in proxy mode, where an all-bili array means the client itself
        // declared those tools — such manually-configured clients keep their
        // #546/#1665 rescue semantics untouched. Strip the leak BEFORE
        // restoreOutputBudget and route demoted requests through the side
        // passthrough below.
        // #1197/#1086: all-bili tools alone cannot mean "side request" — a live
        // plugin session also re-sends its compression artifacts in HISTORY and must
        // run through the kernel. Veto on real history artifacts (detectAcpArtifacts
        // is history-scoped, never the top-level tools declarations), so a fresh
        // title-gen still demotes. Read-only; ordered BEFORE the mutating strip.
        // #1467 WS lanes: envelopes rebuilt from a WebSocket upgrade carry the
        // bridge's x-bili-ws-lane marker. The #1897 leak mechanism (an omp-style
        // HTTP host registering bili's tools as extension tools) cannot produce
        // them, the WS lane is that conversation's mainline, and a side
        // passthrough cannot speak the lane's upstream transport — so the
        // all-bili-tools demotion is vetoed for them (side requests on this lane
        // are identified by the #1699 persona header instead).
        const wsLaneEnvelope = req.headers["x-bili-ws-lane"] !== undefined;
        const requestAgent = pluginRequestAgentHeader(req.headers);
        // #2170 measure 1: the gate conjuncts live in side-request.ts as the
        // pure, truth-table-tested demoteGate(); the two request-body effects
        // stay here and stay lazy — detectAcpArtifacts only runs when the cheap
        // gate holds, the strip only when the artifact scan came back clean.
        // Explicit main intent and a verified public-fork prefix each veto heuristic demotion.
        const demotedSide = demoteGate({ countTokens, responsesCompact, protocol, pluginMode, requestAgent, wsLaneEnvelope, publicForkPrefix })
            && detectAcpArtifacts(bodyBuffer, parsed) === null
            && stripLeakedBiliTools(parsed);
        // #2500: Claude Code's WebSearch sub-request is a host-internal utility
        // call under the MAIN session id (single message, every tool a
        // server-executed web_search_/web_fetch_ version). It rides the #388
        // side passthrough below via isSideRequest, and must ALSO skip
        // restoreOutputBudget here — its max_tokens sizes the search response,
        // not a main turn, and seeding outputBudgetHighWater from it would
        // poison the first starved restore (same class as the #1897 skip).
        const serverToolUtility = isServerToolUtilityCall(parsed);
        // #546: restore a client-shrunk output budget BEFORE the side gate so a
        // tool-carrying main request re-enters the pipeline at full budget (see
        // restoreOutputBudget for the starvation mechanism). #1665/#1840: the
        // best-known model output ceiling (runtime-info > launcher > declared >
        // registry — resolveKnownOutputCeiling) floors the restore target; a
        // warn fires when no source knows one at all.
        // #1897: demoted side requests are skipped entirely — their budget sizes a
        // utility call (omp titles at a fixed 1024), not a main turn, and seeding
        // outputBudgetHighWater from it would poison the first starved restore
        // (title requests arrive FIRST, at session start). Starved all-bili requests
        // never reach here demoted: stripLeakedBiliTools vetoes them per #546.
        if (!demotedSide && !serverToolUtility) {
            // #3438: the dsh host contract (pi-ai buildBaseOptions) stamps the model-declared
            // maxTokens on every main turn, so on this lane a below-ceiling tool-carrying
            // budget is a raw-history collapse, not intent — arm the mid-band rescue.
            // The plugin-stamped lane is the live path; the clientHint arm is defensive —
            // it matches only if some dsh build's wire identity is literally "dsh".
            const dshRestoreLane = pluginAgent === "dsh" || session.metadata.clientHint === "dsh";
            restoreOutputBudget(parsed, session, log, resolveKnownOutputCeiling(req.headers, parsed as Record<string, unknown>, opts.routes, providerDestUrl, opts.sessionHeader, requestModel), dshRestoreLane);
        }
        // #896: the per-scope output-headroom cap (compress.outputHeadroomMaxPct,
        // three-level merge; default 0.25, aligned with billion-context-pi).
        // Resolved once here so the side-request guard below AND the main-path
        // reservation measure against the SAME capped window.
        const headroomCap = resolveOutputHeadroomCap(resolveCompress(opts.routes, providerDestUrl, (parsed as { model?: string }).model, opts.compress).outputHeadroomMaxPct);
        // #1729: dsh native compaction guard — a compaction summarize call
        // (replayed prefix + COMPACTION_INSTRUCTION as the final user message)
        // is refused BEFORE any pipeline work: not forwarded, kernel state
        // untouched. MARKER-DECISIVE since #2193: message count no longer gates
        // — rc.2 replays the full shadowed region (~1100+ msgs) and the old ≤4
        // bar made the guard silently pass through, letting a checkpoint land
        // and destroy the compression substrate. Protocol coverage (#2360):
        // openai + anthropic + responses lanes are all marker-decisive — the
        // pre-#2360 whitelist short-circuited responses (dsh desktop's actual
        // wire) before the marker was ever examined. Unconditional (#3651
        // removed the #2028 opt-out) — auto pressure, overflow recovery, and
        // manual /compact share one envelope, and a landed checkpoint durably
        // shadows the raw history (irreversible), while every cost of refusing
        // is dsh-side, caught, and recoverable. Runs before the #388
        // side-request lane: the compaction call is a full-budget request, so
        // only this guard can catch it.
        if (protocol !== null && isDshCompactionCall(protocol, parsed)) {
            // #3733: AUTHORED compaction — when the knob is on and the session
            // holds active fold blocks, answer the call LOCALLY with our folded
            // snapshot instead of refusing: zero egress (autoModeForge #2740
            // discipline), dsh records our tagged checkpoint and its file shrinks
            // (#3723), and the recorded content is exactly what the upstream
            // already sees. Replaces the default refusal only — since #3651
            // removed the #2028 opt-out there is no native-forward path left:
            // an authored answer is bili answering the call, never passing it
            // through. Undecidable shapes (null forge) fall through to the
            // refusal below.
            const authored = dshAuthoredCompactionEnabled() && session.state.blocks.some((b) => b.active)
                ? buildDshCompactionForgeBody(protocol as "openai" | "anthropic" | "responses", renderDshAuthoredCheckpoint(session), { inputTokens: Math.max(1, Math.round(inboundBytes / 4)), outputTokens: 0 }, (parsed as { stream?: unknown }).stream === true)
                : null;
            if (authored !== null) {
                log("info", `[${session.id}] dsh compaction call identified (final user message = COMPACTION_INSTRUCTION, ${inboundMsgs} msgs) — ANSWERED LOCALLY with the bili snapshot (#3733 authored checkpoint): upstream not contacted, dsh records our tagged checkpoint; originals stay recoverable via CCR/export`);
            } else if (session.metadata.dshCompactionRefused !== true) {
                session.metadata.dshCompactionRefused = true;
                const shapeDrift = inboundMsgs !== null && inboundMsgs > DSH_COMPACTION_SHAPE_MSGS ? `, shape drifted from the ≤${DSH_COMPACTION_SHAPE_MSGS}-msg rc.1 envelope — rc.2 replays the full shadowed region (#2193)` : "";
                log("warn", `[${session.id}] dsh native compaction call identified (final user message = COMPACTION_INSTRUCTION, ${inboundMsgs} msgs${shapeDrift}) — REFUSED, not forwarded: bili owns compression on this lane; a landed dsh checkpoint would durably shadow the raw history (#1729, cf. #1206/#1772)`);
            }
            // #2490: remember the replayed envelope SIZE. The host's raw ledger is
            // invisible to bili's folded view (folds never shrink what dsh itself
            // counts), so the next turn's output clamp must plan against the raw
            // scale or a monster output rides a small folded input out the door
            // (the 384K-token/7.5MB turn-37 single-message kill chain). High-water
            // mark, not a sum: the replay is the whole ledger every time, so the
            // max already bounds every future re-send; a sum would compound on each
            // retry. Write-only by design: nothing decays or clears this value —
            // dshLedgerFloorTokens() in budget.ts documents why the mark stays
            // sticky and consumes it.
            const prevBytes = typeof session.metadata["dshCompactionRefusedBytes"] === "number" ? session.metadata["dshCompactionRefusedBytes"] as number : 0;
            session.metadata["dshCompactionRefusedBytes"] = Math.max(prevBytes, inboundBytes);
            if (authored !== null) {
                // #3733 counters + the same raw-ledger high-water as a refusal
                // (the envelope still proves the raw scale the output clamp must
                // plan against); NOT counted in dshCompactionRefusals.
                session.metadata["dshAuthoredCompactions"] = (typeof session.metadata["dshAuthoredCompactions"] === "number" ? session.metadata["dshAuthoredCompactions"] as number : 0) + 1;
                markDirty(session);
                if (!res.headersSent && !res.writableEnded && !res.destroyed) {
                    res.writeHead(200, { "content-type": authored.contentType });
                    res.end(authored.body);
                }
                logRequestCost(log, session.id, inboundMsgs, inboundBytes, reqT0);
                return;
            }
            session.metadata["dshCompactionRefusals"] = (typeof session.metadata["dshCompactionRefusals"] === "number" ? session.metadata["dshCompactionRefusals"] as number : 0) + 1;
            // #3013/#3022 (A3): after the once-warn above, refusals were fully
            // silent — the field storm burned 5051 refusals with zero further
            // log lines while the user saw a stuck "生成中". Every
            // DSH_REFUSAL_STORM_LOG_EVERY-th refusal re-surfaces with the
            // running count and the actual levers.
            if ((session.metadata["dshCompactionRefusals"] as number) % DSH_REFUSAL_STORM_LOG_EVERY === 0) {
                log("info", `[${session.id}] dsh native compaction refusal #${session.metadata["dshCompactionRefusals"]} on this session (raw-ledger high-water ${(session.metadata["dshCompactionRefusedBytes"] as number)} bytes) — dsh keeps retrying because its own raw pressure ledger never shrinks (#2490), and every retry of this call will be refused (terminal, #3013). Disable dsh auto-compaction (profile recipe #2474) or manage context via bili's compress. If bili's own compression looks idle while this repeats, the nudge channel may be dead — report it (#3004/#3013).`);
            }
            markDirty(session);
            const refusal = dshCompactionRefusal(protocol);
            if (!res.headersSent && !res.writableEnded && !res.destroyed) {
                res.writeHead(refusal.status, { "content-type": "application/json" });
                res.end(JSON.stringify(refusal.body));
            }
            logRequestCost(log, session.id, inboundMsgs, inboundBytes, reqT0);
            return;
        }
        // #388: side requests (title-gen etc.) share the main session key but
        // must not touch kernel state (processTurn/snapshot/usage would pollute
        // the main view). Forward with a minimal prepared marked sidePassthrough:
        // the #460 render-tag strip pipes still run (response hygiene), while
        // preflight / fake-completion retry / the loop / usage sniffing are all
        // skipped. processedMessages stays empty so the loop can never engage.
        // #1699: opencode v2 title-gen requests carry no max_tokens, so the budget
        // heuristic alone misses them. The host stamps its per-request persona id
        // (x-bili-plugin-agent); a known side-request agent routes verbatim by intent.
        // #2740: Claude Code auto-mode safety-classifier one-shots — intercepted
        // BEFORE any lane split: the small-budget stage-1 shapes are caught by
        // the side-request heuristics below and would never reach
        // prepareAnthropic, while the no-stop s2 shape takes the normal lane.
        // Answer locally with a forged allow verdict (zero egress, zero billing
        // for the O(n²) full-transcript-resend lane). Kill switch
        // (BILI_AUTO_MODE_FORGE=0) or an undecidable flavor falls through to
        // today's behavior byte-identically — never emit a malformed verdict.
        if (protocol === "anthropic" && !countTokens && !responsesCompact && isAutoModeClassifier(parsed as AnthropicRequestBody)) {
            const amParsed = parsed as AnthropicRequestBody;
            const variant = autoModeForgeEnabled() ? classifierForgeVariant(amParsed) : null;
            if (variant !== null) {
                const { body: forgeBody, contentType } = buildForgeResponse({ parsed: amParsed, variant });
                // Session-level notice (persisted; surfaced by the web UI badge):
                // this session's auto-mode verdicts are bili-local, not model judgments.
                const prevForge = session.metadata.autoModeForge as { count?: number; lastAt?: number; lastVariant?: string } | undefined;
                session.metadata.autoModeForge = { count: (prevForge?.count ?? 0) + 1, lastAt: Date.now(), lastVariant: variant };
                markDirty(session);
                // Audit line (safety rail): every forged verdict is logged with
                // the action summary, timestamp (logger's), estimate, and model.
                log("info", `[${session.id}] [auto-mode-forge] forged local ${variant} verdict upstream-not-contacted estTokens=${estimateCjkTokens(requestText(amParsed))} reqBytes=${bodyBuffer.length} model=${typeof amParsed.model === "string" ? amParsed.model : "?"} action=${JSON.stringify(summarizeAction(amParsed))}`);
                const amPrepared: Prepared = {
                    body: bodyBuffer,
                    session,
                    processedMessages: [],
                    originalMessages: [],
                    protocol: "anthropic",
                    stream: amParsed.stream === true,
                    compressInjected: false,
                    autoModeForge: { variant, body: forgeBody, contentType },
                };
                logRequestCost(log, session.id, inboundMsgs, inboundBytes, reqT0, bodyBuffer);
                await forward(req, res, opts, bodyBuffer, amPrepared, core, reqConfig, log, route, instanceId, affinity);
                return;
            }
        }
        // #2503: dsh's title-gen sidecar grew past the <=200 budget heuristic on
        // dsh 0.2.1-alpha.2 (preset maxOutputTokens 64 -> 4096); recognize it by
        // system text so it keeps the raw key instead of forking onto a persisted
        // |sub: ghost (#2241 scenario A). Explicit main intent still vetoes.
        const dshTitleSidecar = pluginAgentHeader(req.headers) === "dsh" && requestAgent !== "main" && isDshTitleRequest(parsed);
        // #4438: the review blob must ride the #388 passthrough (kernel state
        // untouched, usage never settles the main baseline) regardless of stamp.
        // Shape + dsh EVIDENCE: the live plugin stamp, or the session's sticky
        // dsh binding — the incident topology: the extension client arrives
        // UNSTAMPED while main turns keep the binding, so every live-header gate
        // missed it while the sticky-bound #2432 rebase gate stayed armed on the
        // main session. With NO evidence at all (a fresh session whose first aux
        // call precedes any stamped main turn) the request falls through to the
        // full pipeline: no folded blocks exist yet, so the #2432 rebase gate is
        // inert there — documented residual, not a silent hole.
        const dshReviewSidecar = requestAgent !== "main" && isDshAutoReviewRequest(protocol, parsed)
            && (pluginAgentHeader(req.headers) === "dsh"
                || (typeof session.metadata.pluginAgent === "string" && session.metadata.pluginAgent === "dsh"));
        const sideIntent = isSideRequest(parsed, requestAgent) || dshTitleSidecar || dshReviewSidecar;
        // #388/#2157 follow-up: side requests must not touch kernel state under
        // a public-fork receipt either. The receipt's first-request check above
        // has already accepted this request (inherited prefix matched, or live
        // traffic, or an advisory adoption per #3741), and a side request reads
        // none of the kernel state fork adoption maintains — so the historical
        // !publicForkPrefix veto here only had the effect of running
        // full-history-replaying side calls (dsh title-gen under a forked
        // conversation: the host resends the ENTIRE current history plus the
        // title instruction, so the prefix always matches) through the FULL
        // pipeline on the fork child's MAIN session: junk turns into the
        // snapshot, usage-baseline pollution (#1916 class), stats inflation.
        // With #2157's verbatim sideRequestLike keying this became a live
        // regression (pre-#2157 the same request forked onto an isolated
        // `|sub:<fp>` junk session — ugly but clean); diverting it here
        // restores the #388 kernel-no-touch contract for fork children too.
        // demotedSide keeps its own !publicForkPrefix veto deliberately: the
        // all-bili-tools leak shape is heuristic, and a fork child's early
        // mainline turns (raw inherited prefix, no artifacts yet, no agent
        // header) can false-positive it — only intent-certain side
        // identification (declared side agent, a tool-less tiny budget, or the
        // #2500 server-tool utility shape) diverts under a receipt.
        // #2170 measure 1: the decision itself is resolveSideLane() (pure,
        // truth-table-tested); demotedSide ⊆ lane==="side" by construction.
        const sideLane = resolveSideLane({ countTokens, responsesCompact, protocol, stripApplied: demotedSide, sideIntent, requestAgent, sideLabel: serverToolUtility ? "server-tool utility call (#2500)" : dshTitleSidecar ? "dsh title-gen sidecar (#2503)" : dshReviewSidecar ? "dsh auto-review sidecar (#4438)" : undefined });
        if (sideLane.lane === "side") {
            // #554: the passthrough below skips EVERY input-side guard by design
            // (#388) — a full-history side request over the window is a
            // guaranteed upstream 400 (and title-gen/probe clients re-issue it,
            // hammering the upstream). Gate on the raw body estimate and fail
            // fast locally instead of forwarding (#301 precedent).
            const reqModel = requestModel;
            // #1110: only a genuine overflow arm bounds the guard — never the
            // nudge baseline (lastInputTokens). A healthy compressed host turn
            // keeps that baseline low, which permanently 413'd an unrelated
            // in-process caller's fixed-size request even though it fit the
            // model's real window. overflowArmTokens is set ONLY by an upstream
            // context-overflow 400 and cleared by the next real usage report.
            const armedForGuard = typeof session.stats.overflowArmTokens === "number" && session.stats.overflowArmTokens > 0 ? session.stats.overflowArmTokens : 0;
            const guard = sideRequestGuard(parsed, protocol, reqConfig.modelContextLimit, imageBillingFor(opts, route?.rewrittenUrl ?? upstreamOrigin), imageTokenCapFor(opts, route?.rewrittenUrl ?? upstreamOrigin), headroomCap, armedForGuard, imageReserveFor(session, protocol, parsed, opts, route?.rewrittenUrl ?? upstreamOrigin), shouldReserveOutputHeadroom(protocol, normalizeUpstreamOrigin(route?.rewrittenUrl ?? upstreamOrigin), requestModel));
            if (guard.blocked) {
                log("warn", `[${session.id}] side request (~${guard.estimate} tokens) ≥ effective window ${guard.limit} (model=${reqModel ?? "?"}) — NOT forwarded: guaranteed upstream 400 (side requests bypass preflight by design, #388)`);
                if (!res.headersSent && !res.writableEnded && !res.destroyed) {
                    res.writeHead(413, { "content-type": "application/json" });
                    res.end(JSON.stringify({
                        error: {
                            type: "server_error",
                            code: "side_request_payload_too_large",
                            message: `side request payload ~${guard.estimate} tokens reaches the effective context window ${guard.limit} (model=${reqModel ?? "unknown"}); NOT forwarded — side requests bypass compression by design (#388). Shrink the conversation or raise the model's context window.`,
                            retryable: false,
                        },
                    }));
                }
                logRequestCost(log, session.id, inboundMsgs, inboundBytes, reqT0);
                return;
            }
            const sideReason = sideLane.reason;
            log("info", `[${session.id}] side request (${sideReason}) → passthrough + tag strip only, kernel state untouched`);
            // #1897: a demoted request was mutated (tools stripped) — re-serialize
            // the parsed body so the leak is actually gone from the wire.
            let sideBody = scrubAnthropicPck(protocol, demotedSide ? Buffer.from(JSON.stringify(parsed)) : bodyBuffer, log);
            const sideInput = (parsed as ResponsesRequestBody).input;
            if (protocol === "responses" && Array.isArray(sideInput)) {
                const { items, replaced, dropped } = replaceBiliCompactionItems(sideInput);
                if (replaced + dropped > 0) {
                    sideBody = Buffer.from(JSON.stringify({ ...parsed, input: items }));
                    log("info", `[${session.id}] side request normalized bili compaction handoffs (replaced=${replaced}, dropped=${dropped})`);
                }
            }
            sideBody = scrubCompatDrop(sideBody, compatDropPaths, log);
            const sidePrepared: Prepared = {
                body: sideBody,
                session,
                processedMessages: [],
                originalMessages: [],
                protocol,
                stream: (parsed as { stream?: unknown }).stream === true,
                compressInjected: false,
                sidePassthrough: true,
            };
            logRequestCost(log, session.id, inboundMsgs, inboundBytes, reqT0, bodyBuffer);
            await forward(req, res, opts, sideBody, sidePrepared, core, reqConfig, log, route, instanceId, affinity);
            return;
        }
        // #2170 measure 4 (runtime canary): every legitimately side-shaped
        // LANE-ELIGIBLE request returned inside the lane above. count_tokens,
        // /responses/compact and session-less (protocol-less) requests are
        // deliberately NOT lane-eligible — they route to their own handling
        // below, so they are excluded here (ework review finding B). If a
        // lane-eligible side-intent or demoted request reaches the full
        // pipeline anyway, the lane contract is broken (the #2157/#2164
        // regression class: side traffic touching kernel state). Count it on
        // the session and say it loudly — with the pure resolveSideLane()
        // this is unreachable by construction; any future drift trips it.
        if (!countTokens && !responsesCompact && protocol !== null && (sideIntent || demotedSide)) {
            session.metadata.sideEffectLeaks = (typeof session.metadata.sideEffectLeaks === "number" ? session.metadata.sideEffectLeaks : 0) + 1;
            log("warn", `[${session.id}] SIDE-EFFECT LEAK (#2170 canary): ${sideLane.reason} request entered the full pipeline — expected the #388 side passthrough; kernel state pollution likely (cf. #2156/#2164)`);
        }
        // #987: the window is NEVER learned from traffic — no self-heal read
        // here. Only the one-shot emergency shrink (armed on the overflow
        // itself) reacts to a wrong declared window.
        // Reserve the model's OUTPUT budget for this turn from the window so the
        // kernel's nudge/truncate bands sit below (window - reserved) and a
        // context+output overflow can't happen on a small window (e.g. 100k with a
        // large max_tokens — the most common "context blew up" cause; none of the
        // three layers reserved room for the output before this). #4205: EVERY
        // wire reserves unless the route carries positive evidence of a separate
        // output budget (real-Claude routing — api.anthropic.com or a claude-*
        // model id; see shouldReserveOutputHeadroom / hasSeparateOutputBudgetEvidence).
        // The old blanket anthropic exemption is what let wrapper providers on
        // that wire (DeepSeek /anthropic bills completion against the same
        // window) 400 at the wall (#3900); proven-share learning (#3973) composes
        // here later. The request's own budget field is the exact
        // output budget requested for THIS turn, so it is precise and per-request;
        // when the harness omits every budget field (#924 fallback below) the
        // model's declared max output stands in for it.
        // #896: headroomCap (compress.outputHeadroomMaxPct, default 0.25, aligned
        // with billion-context-pi #207) caps the reservation at headroomCap × window
        // — reserved = min(maxOutput, headroomCap × window). Replies longer than the
        // reservation overflow once; the self-heal above recovers it next turn.
        // Only reserve when it leaves a usable window (maxOutput < window);
        // otherwise the request is degenerate (output >= whole window) and the
        // self-heal above handles the resulting overflow. Feeds reqConfig (→
        // processTurn `config`), so diagNudge shows the reserved window (no extra log).
        const nativeWindow = reqConfig.modelContextLimit;
        const headroomOrigin = normalizeUpstreamOrigin(route?.rewrittenUrl ?? upstreamOrigin);
        // #3450 follow-up (#3973): a 400 that stated a completion share disproves
        // any separate-wall evidence for this origin+model — judging input against
        // the full window would re-earn the same 400 every turn (#3738: nudge and
        // preflight must judge on a number the upstream will accept). #4205 made
        // the reservation the default for every wire without separate-budget
        // evidence, so the proven share now forces the reservation where that
        // evidence exists and clamps the resulting window below (see provenWindow).
        const provenReserve = provenCompletionReserve(
            session.stats,
            headroomOrigin,
            (parsed as { model?: string }).model,
        );
        if (shouldReserveOutputHeadroom(protocol, headroomOrigin, requestModel) || provenReserve > 0) {
            const p = parsed as Record<string, unknown>;
            const rawMax = p.max_tokens ?? p.max_completion_tokens ?? p.max_output_tokens;
            let maxOutput = typeof rawMax === "number" ? rawMax : 0;
            // #924: harnesses that omit every output-budget field (Codex native
            // Responses sends no max_output_tokens — openai/codex#36180) still get
            // the upstream's own default output cap applied, so reserving nothing
            // leaves the nudge/truncate bands able to overflow with one long
            // reply. Fall back to the model's declared max output — per-route
            // config first (operator-declared, outranks auto-fetched data, same
            // order as the window resolution #344), then the models.dev registry
            // ceiling (cache-only + bundled-snapshot floor, never fetches — the
            // source preflight's summary cap uses, #853) — through the SAME capped
            // reservation below. Unknown model → 0 → today's behavior.
            if (!(maxOutput > 0)) {
                // Runtime-info protocol (#955): the plugin reported the client's
                // CONFIGURED max output (or the model's declared default, e.g.
                // dsh's defaultMaxTokens) for exactly this model — outranks
                // configured/registry because it is what the client will
                // actually ask the upstream for. Still only a fallback: a
                // max_tokens on the wire beat it above.
                const fbModel0 = (parsed as { model?: string }).model;
                // #1531: same dual lookup as the window chain above — header
                // agent wins exclusively, header-less agents resolve by
                // conversation signal.
                const fbAgent = pluginAgentHeader(req.headers);
                const runtimeMax = (pluginHeadersMatchModel(req.headers, fbModel0) ? pluginReportedMaxOutput(req.headers) : undefined)
                    ?? (fbAgent !== undefined
                        ? pluginRuntimeInfoFor(fbAgent, fbModel0)?.maxOutput
                        : pluginRuntimeInfoForConversation(runtimeConversationId(req.headers, parsed, opts.sessionHeader), fbModel0)?.maxOutput);
                if (typeof runtimeMax === "number" && runtimeMax > 0) {
                    maxOutput = runtimeMax;
                    if (!headroomFallbackLogged.has(`${fbModel0 ?? "?"}|runtime-info`)) {
                        headroomFallbackLogged.add(`${fbModel0 ?? "?"}|runtime-info`);
                        log("info", `[headroom] model=${fbModel0 ?? "?"}: request carries no output budget; reserving against runtime-info max output ${runtimeMax} (#955)`);
                    }
                }
            }
            if (!(maxOutput > 0)) {
                // Launcher env channel (#971): the client's OWN config declares
                // this model's output ceiling (codex model_max_output_tokens,
                // pi/omp maxTokens, opencode limit.output, codebuddy
                // maxOutputTokens) — handed over at launch time. Below
                // runtime-info (per-request plugin truth) but above the
                // generic configured/registry sources, same rank order as the
                // window chain's launcher tier (1b).
                const fbLauncher = (parsed as { model?: string }).model;
                const launcherMax = fbLauncher !== undefined ? launcherMaxOutput(fbLauncher) : undefined;
                if (typeof launcherMax === "number" && launcherMax > 0) {
                    maxOutput = launcherMax;
                    if (!headroomFallbackLogged.has(`${fbLauncher}|launcher`)) {
                        headroomFallbackLogged.add(`${fbLauncher}|launcher`);
                        log("info", `[headroom] model=${fbLauncher}: request carries no output budget; reserving against launcher max output ${launcherMax} (#971)`);
                    }
                }
            }
            if (!(maxOutput > 0)) {
                const fbModel = (parsed as { model?: string }).model;
                if (fbModel) {
                    let host: string | undefined;
                    try { host = providerDestUrl ? new URL(providerDestUrl).host : undefined; } catch { host = undefined; }
                    const cfgOut = resolveConfiguredOutputLimit(opts.routes, providerDestUrl, fbModel);
                    const regOut = peekRegistryOutputLimit(fbModel, host);
                    const budget = cfgOut !== undefined ? cfgOut : regOut;
                    if (typeof budget === "number" && budget > 0) {
                        maxOutput = budget;
                        const source = cfgOut !== undefined ? "configured" : "registry";
                        if (!headroomFallbackLogged.has(`${fbModel}|${source}`)) {
                            headroomFallbackLogged.add(`${fbModel}|${source}`);
                            log("info", `[headroom] model=${fbModel}: request carries no output budget; reserving against ${source} max output ${budget} (#924)`);
                        }
                    }
                }
            }
            if (provenReserve > 0 && !shouldReserveOutputHeadroom(protocol, headroomOrigin, requestModel)) {
                // Proven share outranks the client-side fallbacks: it is what
                // the upstream already counted into a rejection on this exact
                // origin+model, so window − proven share is the input it accepts.
                if (provenReserve > maxOutput) maxOutput = provenReserve;
                const proofModel = (parsed as { model?: string }).model ?? "?";
                if (!headroomFallbackLogged.has(`${proofModel}|proven-completion`)) {
                    headroomFallbackLogged.add(`${proofModel}|proven-completion`);
                    log("info", `[headroom] model=${proofModel}: reserving the PROVEN completion share ${provenReserve} although protocol ${protocol ?? "unknown"} is exempt (#3450) — this origin+model billed completion inside the wall in an earlier rejection; judging input against ${nativeWindow} - ${provenReserve}`);
                }
            }
            // #2283 sub-defect 1: emit [window-change] when the per-session resolution
            // triple (model/source/base) moves mid-session. Placed pre output-headroom so
            // #2096's per-request max_tokens reservation can't read as a base change.
            {
                const curRes = { m: reqModelId ?? "?", s: wsSourceForLog ?? "?", b: reqConfig.modelContextLimit };
                const prevRes = session.metadata?.lastWindowResolution as { m: string; s: string; b: number } | undefined;
                if (prevRes !== undefined && (prevRes.m !== curRes.m || prevRes.s !== curRes.s || prevRes.b !== curRes.b)) {
                    log("info", `[${session.id}] [window-change] ${prevRes.m}/${prevRes.s}/${prevRes.b} -> ${curRes.m}/${curRes.s}/${curRes.b} (mid-session window resolution changed; nudge/preflight now judge against base ${curRes.b} pre-output-headroom, source=${curRes.s}) (#2283)`);
                }
                if (session.metadata) session.metadata.lastWindowResolution = curRes;
            }
            let reserved = reserveOutputHeadroom(reqConfig.modelContextLimit, maxOutput, headroomCap);
            // Fallback-derived windows are optimistic guesses: never let the
            // output-headroom reservation push the effective window below the
            // floor (issue #282: 128k table − 64k max_tokens → 64k effective
            // for a 1M-window model). If the real window is smaller, the first
            // upstream overflow self-heals it.
            if (nativeFromFallback && reserved < FALLBACK_EFFECTIVE_WINDOW_FLOOR) {
                log("info", `[${session.id}] fallback context window floored: ${reserved} → ${FALLBACK_EFFECTIVE_WINDOW_FLOOR} (model=${String(requestModel ?? "?")} not authoritatively identified; self-heal corrects it if the real window is smaller)`);
                reserved = FALLBACK_EFFECTIVE_WINDOW_FLOOR;
            }
            // The #896 cap bounds GUESSED budgets; a proven share is measured —
            // the upstream already counted it in a rejection on this origin+model —
            // so the window may never stay above (declared window − proven share).
            if (provenReserve > 0 && nativeWindow > provenReserve) {
                const provenWindow = nativeWindow - provenReserve;
                if (provenWindow < reserved) reserved = provenWindow;
            }
            if (reserved !== reqConfig.modelContextLimit) {
                reqConfig = { ...reqConfig, modelContextLimit: reserved };
                // #2096: the [window] line above already went out with the
                // pre-reservation base — surface the value nudge/preflight
                // actually judge against, once per model|value. The clamp's
                // native-window guarantee is stated here so the two windows
                // can't be read as one in an incident log.
                const headroomModel = String(requestModel ?? "?");
                if (!headroomEffectiveLogged.has(`${headroomModel}|${reserved}`)) {
                    headroomEffectiveLogged.add(`${headroomModel}|${reserved}`);
                    log("info", `[headroom] model=${headroomModel}: effective window ${nativeWindow} -> ${reserved} (reserved ${nativeWindow - reserved} for max output ${maxOutput}, cap ${headroomCap} via compress.outputHeadroomMaxPct) — nudge/preflight judge input against ${reserved}; the outgoing max_tokens clamp still guards the full ${nativeWindow} (#2096, #3837)`);
                }
            }
        }
        // #4205 caliber: status surfaces record the UNRESERVED window (post
        // self-heal, pre output-headroom) — the wall the client/upstream
        // declares, stable across turns regardless of per-request max_tokens.
        // The reserved judging window (what nudge/truncate/preflight actually
        // judge against) rides reqConfig into the kernel AND the per-request
        // twin below: request-scoped consumers read the twin instead (#3738's
        // arm clamp must clamp to the limit the kernel judges, not display N).
        // #393: both were previously one value set post-self-heal only for
        // plugin sessions, so wire-mode panels fell back to a hardcoded 200K.
        session.metadata.effectiveContextLimit = nativeWindow;
        session.metadata.reservedContextLimit = reqConfig.modelContextLimit;
        // #955 runtime-info: record the model id + window source for this
        // session so /__bili/plugin/status can show them pre-first-request and
        // post-hoc forensics can tell which source sized the window.
        if (reqModelId !== undefined) session.metadata.lastModel = reqModelId;
        session.metadata.lastWindowSource = wsSourceForLog ?? null;
        // #833: remember the FINAL resolved Config (post self-heal + headroom,
        // same instant as effectiveContextLimit above) so request-context-free
        // display paths (/__bili/plugin/status Nudge line, plugin tool API)
        // render from the values the kernel actually used this turn.
        // #2446/#2419/#2447/#2481: per-lane durable-state carriers, projected
        // to `durable/<name>` virtual tool paths (KDD#9 evidence-permitlist).
        // Stamp the CLONE-SAFE config first — a function inside
        // session.metadata.effectiveConfig would break fork-adoption structuredClone
        // and disk persistence — then attach the classifier+default policy to this
        // turn's reqConfig so processTurn protects the carriers now.
        // effectiveConfig() re-resolves both from the lane id at read time, so
        // /__bili/plugin/tool sees them too.
        storeEffectiveConfig(session, reqConfig);
        const durableClassifier = pluginAgent ? durableMessageToolPaths[pluginAgent] : undefined;
        if (durableClassifier !== undefined) reqConfig = withDurableProtection(reqConfig, durableClassifier);
        // acquireInFlight must precede the lock so evictOldest() cannot flush
        // this session between getSession and lock acquisition (inFlight===0
        // window). Released in the outer finally after forward completes.
        acquireInFlight(session);
        try {
            // #970: lock covers ONLY the fast state-mutating prep (prepare +
            // preflight). forward() runs UNLOCKED below on purpose — holding it
            // here would head-of-line-block every concurrent request sharing this
            // session id (Claude Code subagents) behind one slow upstream stream.
            // forward() re-acquires the lock around its own discrete mutation
            // sections; do not re-wrap the whole forward in this lock.
            // #1195: prepare + preflight run as a REUSABLE closure so an upstream
            // overflow can re-run the stage mid-request (see the overflowRefold
            // wiring below): the caller re-enters it under the session lock with
            // the window the upstream STATED, forcing the fold the declared
            // window could never trigger. respondFailFast=false (the overflow
            // retry path) suppresses the fail-fast response — forward() answers
            // with the original upstream 400 instead, preserving today's
            // client-visible contract when the payload cannot be rescued.
            // #2155: self-heal evaluates once per HTTP request — the refold
            // re-runs prepare below but must not double-count a round.
            let selfHealRoundDone = false;
            const runPreparedPipeline = async (
                respondFailFast: boolean,
                overflowWindow?: number,
            ): Promise<{ body: string | Buffer; prepared: Prepared | null } | null> => {
                const runPrepare = async (): Promise<Prepared> => {
                    // #1820: this prepare consumes one unit of post-rebuild anchor
                    // validity (the last one deletes it — see session.ts).
                    tickPostRebuildAnchor(session);
                    const cs = resolveCompress(opts.routes, providerDestUrl, requestModel, opts.compress);
                    // #2228: model-decided nudge timing — resolved through the standard
                    // three-level compress cascade; presence of the object enables the
                    // side-call decision path at tier-1 arms (off unless explicitly set).
                    const decide = cs.nudgeModelDecided === true
                        ? { maxTokens: typeof cs.nudgeDecisionMaxTokens === "number" && cs.nudgeDecisionMaxTokens > 0 ? Math.floor(cs.nudgeDecisionMaxTokens) : DEFAULT_DECIDE_MAX_TOKENS }
                        : undefined;
                    // #1279: stamp this request's effective cache-economics price
                    // profile on the session so request-context-free report faces
                    // (acp_cache / /acp-cache / __bili/cache-report) price folds
                    // with the profile that governed this turn; unset clears it
                    // (latest-wins, like activePack). User config at any level wins
                    // wholesale; when no level configures one, fall back to the
                    // model's models.dev price (absolute $/Mtok) so out-of-box
                    // reports read in real money instead of Anthropic-ratio
                    // guesses. Report-only — no trigger impact.
                    if (cs.priceProfile !== undefined && Object.keys(cs.priceProfile).length > 0) session.metadata.cachePriceProfile = cs.priceProfile;
                    else {
                        const priceHost = (() => { try { return new URL(route?.rewrittenUrl ?? upstreamOrigin).host; } catch { return undefined; } })();
                        const registryProfile = peekRegistryPriceProfile(requestModel, priceHost);
                        if (registryProfile !== undefined) session.metadata.cachePriceProfile = registryProfile;
                        else delete session.metadata.cachePriceProfile;
                    }
                    const visibilityMarkers = cs.visibilityMarkers ?? true;
                    const reasoningCfg = cs.reasoning;
                    // #1995/#2607: index recoverable historical images by ref from the RAW
                    // inbound body on every request — archivable media folds by default
                    // and decompress({ imageRef }) must reach those pixels after they
                    // leave the wire; latest-wins per request. The post-prepare refresh
                    // below merges in refs assigned during this turn's prepare.
                    // (The former `stripImages` wire-side removal is gone — default
                    // folding is the only path that drops media now. count_tokens
                    // requests skip the (pure bookkeeping) index rebuild.)
                    // #2824: a provably image-free body yields an empty index
                    // without the full-history conversion (today's no-image
                    // result, minus the wasted wire→core pass).
                    // Eviction rides along (best-effort, throttled to once a minute).
                    if (protocol && !countTokens) {
                        session.incomingImageIndex = bodyMayCarryImages
                            ? buildIncomingImageIndex(parsed, protocol, session.state, session.id)
                            : new Map<string, IndexedImage[]>();
                        if (session.lastImgPrune === undefined || Date.now() - session.lastImgPrune > 60_000) {
                            session.lastImgPrune = Date.now();
                            pruneRetrieveImgExports(session.id);
                        }
                    } else if (session.incomingImageIndex) {
                        session.incomingImageIndex = undefined;
                    }
                    const work = parsed;
                    // #3211: pair this request's per-route k̂ calibration policy
                    // (providers[<key>].calibration) onto the session so the NEXT
                    // usage settle applies it at k̂ publication time — same
                    // latest-wins, origin-gated pairing discipline as
                    // lastLocalTextEstimate(+Origin). Resolved by the FULL
                    // destination URL (mitm:// keys included, like every other
                    // provider field); an absent policy stores undefined and
                    // clears any stale slot from a previous route.
                    {
                        const destUrl = providerDestUrl;
                        const calibPolicy = findRoute(opts.routes, destUrl)?.calibration;
                        session.stats.lastCalibrationPolicy = calibPolicy;
                        session.stats.lastCalibrationPolicyOrigin = calibPolicy ? destUrl : undefined;
                    }
                    if (countTokens) {
                        return protocol === "google"
                            ? prepareGoogleCountTokens(work as GoogleRequestBody, core, reqConfig, log, session)
                            : prepareCountTokens(work as AnthropicRequestBody, core, reqConfig, log, session);
                    }
                    if (protocol === "google") {
                        // Both the model and the stream flag live in the URL path
                        // for this wire (the body carries neither), so they are
                        // derived here instead of read off `work`. #3280: on the
                        // v1internal dialect the model rides in the envelope meta
                        // instead of the path — fall back to it so Prepared carries
                        // a real model (the loop's synthetic frames read it back).
                        return await prepareGoogle(work as GoogleRequestBody, opts, core, reqConfig, reqPrompts, reqSurface, log, session, pluginMode, nativeWindow, googleModel ?? v1Model, googlePathKind(urlPath) === "stream-generate", visibilityMarkers, upstreamOrigin, req, decide);
                    }
                    const preparedOut = protocol === "anthropic"
                        ? await prepareAnthropic(work as AnthropicRequestBody, req, opts, core, reqConfig, reqPrompts, reqSurface, log, session, pluginMode, upstreamOrigin, reasoningCfg, visibilityMarkers, requestModel, decide)
                        : protocol === "openai"
                          ? await prepareOpenai(work as OpenAIRequestBody, req, opts, core, reqConfig, reqPrompts, reqSurface, log, session, pluginMode, upstreamOrigin, nativeWindow, reasoningCfg, visibilityMarkers, route?.rewrittenUrl, decide)
                          : responsesCompact
                            // #618: when no bili compaction item is present,
                            // prepareResponsesCompact falls back to the raw bodyBuffer —
                            // forward it unchanged (byte-identical passthrough).
                            ? prepareResponsesCompact(bodyBuffer, work as ResponsesRequestBody, session, req, core, reqConfig, log)
                            : await prepareResponses(work as ResponsesRequestBody, req, opts, core, reqConfig, reqPrompts, reqSurface, log, session, responsesIdentity!, pluginMode, upstreamOrigin, nativeWindow, reasoningCfg, visibilityMarkers, route?.rewrittenUrl, decide);
                    // The resolved model rides with the prepared request: on the
                    // Anthropic-on-Vertex wire the body carries none, and the
                    // relay's compress-loop rebuild reads it from here.
                    preparedOut.model = requestModel;
                    return preparedOut;
                };
                // #332: codex's native remote-compaction request (trigger form)
                // is dispatched BEFORE prepare/preflight. When it is not
                // intercepted, preserve what codex sent except for local bili
                // compaction markers: a preflight-compressed/rebuilt payload
                // diverges from codex's local history, non-OpenAI backends 400 the
                // compaction_trigger item, and folding bili's state as a side
                // effect of handling codex's own compaction is wrong.
                // #3686: host policy, not wire profile — declared plugin hosts are exempt.
                const isCodexCompactTrigger =
                    protocol === "responses" &&
                    !responsesCompact &&
                    isCodexHost(req.headers) &&
                    hasCompactionTrigger((parsed as ResponsesRequestBody).input);
                if (isCodexCompactTrigger) {
                    const mode = codexCompactMode();
                    const gatePre = codexCompactGatePre(session, reqConfig.modelContextLimit);
                    if (mode === "intercept" && gatePre) prepared = await runPrepare();
                    if (prepared) memProbe(opts.debug, log, session.id, "prepared", typeof prepared.body === "string" ? Buffer.byteLength(prepared.body) : prepared.body.byteLength);
                    if (prepared?.codexForge) {
                        logRequestCost(log, session.id, inboundMsgs, inboundBytes, reqT0, prepared.body);
                        return { body: prepared.body, prepared };
                    }
                    // runPrepare may have mutated parsed before failing to forge.
                    // Normalize the original wire input only: fc_bili_* records
                    // are local summaries, not valid upstream compaction items.
                    const original = JSON.parse(bodyBuffer.toString("utf8")) as ResponsesRequestBody;
                    const { items, replaced, dropped } = replaceBiliCompactionItems(Array.isArray(original.input) ? original.input : []);
                    const normalized = replaced + dropped > 0;
                    const forwardBody = normalized ? Buffer.from(JSON.stringify({ ...original, input: items })) : bodyBuffer;
                    const why = mode !== "intercept" ? "BILI_CODEX_COMPACT=pass" : !gatePre ? "gate preconditions not met" : "transform/forge failed";
                    log("info", `[${session.id}] codex compaction_trigger request not intercepted (${why}) — forwarding ${normalized ? `with bili summaries normalized (replaced=${replaced}, dropped=${dropped})` : "verbatim"} (no preflight, no rebuild, no window clamp)`);
                    logRequestCost(log, session.id, inboundMsgs, inboundBytes, reqT0, forwardBody);
                    return { body: forwardBody, prepared: null };
                }
                // #3450: ONE wall per request — on the refold path the
                // prepare/nudge stage must judge against the same window the
                // preflight stage folds on. min(declared, stated): the
                // operator/host declaration and the upstream's own proof bound
                // each other; neither may outrank the other within one
                // request (the two-walls split let "usage=105%" and
                // "target 1048576" coexist in the same second). Downward only
                // — a stated ceiling above the declaration never loosens it.
                if (overflowWindow !== undefined && typeof reqConfig.modelContextLimit === "number" && reqConfig.modelContextLimit > 0 && overflowWindow < reqConfig.modelContextLimit) {
                    reqConfig = { ...reqConfig, modelContextLimit: overflowWindow };
                }
                prepared = await runPrepare();
                memProbe(opts.debug, log, session.id, "prepared", typeof prepared.body === "string" ? Buffer.byteLength(prepared.body) : prepared.body.byteLength);
                // [#2926] anthropic Threads lane: prepare mirrored the turn and
                // may have armed a reforge (mirror estimate crossed the window
                // on a continue, rollout flag on). Execute it now — one summary
                // side-call on the client's auth, then swap the continue for a
                // fresh create. Runs inside the same session lock so no
                // interleaved turn can race the mirror. Fail-open: on failure
                // `body` keeps the original continue and the forward proceeds.
                if (prepared.threadsReforge !== undefined) {
                    const route0 = route;
                    // #3569: the side-call must hit the SAME endpoint as the
                    // main forward — full URL incl. path/query plus the same
                    // proxy decision. The bare origin 404s on real providers,
                    // so the fold never completed.
                    const reforgeTarget = buildForwardTarget(req, opts, route0);
                    const outcome = await executeThreadsReforge(
                        prepared.threadsReforge,
                        session,
                        req,
                        reforgeTarget.upstreamUrl,
                        reforgeTarget.proxyUrl,
                        parsed as { model?: unknown; stream?: unknown; max_tokens?: unknown; temperature?: unknown; top_p?: unknown; messages?: unknown },
                        prepared.anthropicBillingBlock,
                        log,
                    );
                    if (outcome.ok && outcome.body !== undefined) {
                        prepared.body = outcome.body;
                        // The old thread is dead: no id in it can ever be a
                        // useful retarget again (#2701 tail tracking).
                        resetThreadTailTracking(session);
                    }
                    prepared.threadsReforge = undefined;
                }
                // #2607: prepare just assigned numeric refs to this turn's new
                // messages (archivable media folds by default) — archive their
                // pixels before preflight or the model can fold them away.
                // #2824: skipped for provably image-free bodies — the rebuild
                // would find nothing regardless of which refs prepare just
                // assigned (refs gate indexing; they cannot create images).
                if (!countTokens && !responsesCompact && protocol && prepared && bodyMayCarryImages) {
                    session.incomingImageIndex = refreshIncomingImageIndex(parsed, protocol, session.state, session.id, session.incomingImageIndex);
                }
                // #2155 self-heal round: one evaluation per request, on the
                // nudge-carrying prepared result (bypass lanes have nudge
                // undefined and the hook no-ops inside). Side requests
                // (title-gen etc.) never carry a nudge, so they cannot burn
                // zombie credit either. #3004: nudgeActive is the POST-GATE
                // delivery fact (prepared.nudgeOutcome === "injected") — the
                // pre-gate expression credited rounds whose nudge the decide
                // gate later vetoed, arming suppress-nudge on a channel the
                // model never received. Actual injection subsumes every factor
                // the old expression listed: gated-off rounds (suppression /
                // breaker / gate off / no arm) leave it undefined or yield
                // "vetoed"/"skipped" — never "injected". #3461: "gated" joins
                // "injected" as active — a pressure round held only by the
                // emergency backoff still counts, otherwise the rate limit
                // starves the streaks (#2155 zombie degrade, D1 suppression)
                // that exist precisely for sessions pinned under continuous
                // pressure.
                if (!selfHealRoundDone && prepared.nudge !== undefined) {
                    selfHealRoundDone = true;
                    evaluateSelfHealRound(session, {
                        pluginHeaderPresent: pluginAgentHeader(req.headers) !== undefined,
                        biliToolsDeclared: biliToolsDeclaredOnWire(parsed, protocol),
                        nudgeActive: prepared.nudgeOutcome === "injected" || prepared.nudgeOutcome === "gated",
                        biliToolUses: countBiliToolUses(prepared.processedMessages),
                        degradeAvailable: opts.compress.injectTool && !knobNoInjectTool(),
                    }, log);
                }
                // A locally-served codex compaction forge never reaches an
                // upstream: preflight would burn summarization rounds for a
                // reply that is already forged (#3008 prompt form).
                if (!countTokens && !responsesCompact && !prepared.codexForge && !prepared.threadsLane) {
                    const outcome = await preflightCompressIfNeeded(
                        prepared,
                        runPrepare,
                        req,
                        bodyBuffer,
                        res,
                        opts,
                        core,
                        // #3450: no per-stage override anymore — the wall was
                        // unified above (min of declared and upstream-stated),
                        // so prepare/nudge and preflight judge on one number.
                        reqConfig,
                        nativeWindow,
                        requestModel,
                        resolvedNativeWindow,
                        windowShrinkReason,
                        route,
                        affinity,
                        anonAffinity !== null,
                        log,
                        instanceId,
                    );
                    if (isPreflightFailFast(outcome)) {
                        // #301: the payload still overflows the window and
                        // preflight could not fix it — answer with a
                        // structured error instead of forwarding.
                        if (respondFailFast && outcome.respond && !res.destroyed) {
                            if (res.headersSent) {
                                // #568: the hold already committed 200 early — the status
                                // can no longer change, so deliver the same error in-band
                                // (protocol error event for SSE, identical JSON body for
                                // non-stream) instead of a status code we lost.
                                if (prepared!.stream) {
                                    emitPreflightError(res, prepared!.protocol, { message: outcome.message, retryable: outcome.retryable }, (m) => log("warn", m));
                                } else {
                                    try {
                                        res.end(JSON.stringify({
                                            error: {
                                                type: "server_error",
                                                code: "preflight_compress_failed",
                                                message: outcome.message,
                                                retryable: outcome.retryable,
                                            },
                                        }));
                                    } catch { /* client gone */ }
                                }
                            } else {
                                // Retry-After on the 503 (rate-limited) path: gives
                                // well-behaved clients a backoff signal instead of
                                // hammering the rate-limited upstream (#301).
                                res.writeHead(outcome.status, {
                                    "content-type": "application/json",
                                    ...(outcome.status === 503 ? { "retry-after": "30" } : {}),
                                });
                                res.end(JSON.stringify({
                                    error: {
                                        type: "server_error",
                                        code: "preflight_compress_failed",
                                        message: outcome.message,
                                        retryable: outcome.retryable,
                                    },
                                }));
                            }
                        }
                        logRequestCost(log, session.id, inboundMsgs, inboundBytes, reqT0);
                        return null;
                    }
                    prepared = outcome;
                }
                // #1266: capture the CLIENT's raw incoming wire AFTER session
                // binding so the filename carries the session id — INCOMING↔REQ
                // dumps pair by id for `bili acp-cache diff`. Moved from the
                // pre-prepare site where no session was bound yet. Requests
                // rejected before prepare lose their INCOMING dump — fine, they
                // never reach upstream and produce no REQ dump either.
                // Bypass/passthrough requests DO reach upstream (their REQ dump
                // lands under sid "unknown") but no longer get an INCOMING dump;
                // acceptable because in those modes the proxy rewrites nothing,
                // so the incoming side adds no attribution signal.
                if (bodyDumpEnabled() && parsed && typeof parsed === "object") {
                    try {
                        const rawDir = knobRawDumpDir();
                        try { fs.mkdirSync(rawDir, { recursive: true }); } catch { /* best-effort */ }
                        const hdrs = maskHeadersForLog(
                            Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)])),
                        );
                        const hdrText = Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join("\n");
                        fs.writeFileSync(path.join(rawDir, `${Date.now()}-${safeSessionId(session.id)}-INCOMING.txt`), `${DUMP_PLAINTEXT_BANNER}\n${req.method} ${maskUrlsInText(req.url ?? "")}\n${hdrText}\n\n${bodyBuffer.toString("utf8")}`);
                        gcDumpDirIfConfigured(rawDir);
                    } catch (err) { logDumpFailure("INCOMING dump", err); }
                }
                logRequestCost(log, session.id, inboundMsgs, inboundBytes, reqT0, prepared!.body);
                return { body: prepared!.body, prepared: prepared! };
            };
            // #1884/#2090 (un-armed signed traffic): a request that already
            // carries a body-covering signature (SDK-HMAC-SHA256 family —
            // CodeArts APIG, or any gateway-invented scheme the shape-based
            // detector catches, e.g. x-ofm-signature) and arrives WITHOUT a
            // working re-sign arm cannot survive any body rewrite: prepare*
            // injects the compress tool + system notes, and the compress loop
            // re-sends rebuilt rounds, so the upstream rejects every mutated
            // request with 401 (APIG.0301 body-hash mismatch /
            // SignatureDoesNotMatch). Without a working re-sign arm the
            // request is REFUSED locally for EVERY scheme (403, actionable
            // message naming the exact opt-in) — #2090 owner ruling: bili's
            // contract is "installed = compressed, or the user explicitly
            // knows a link runs uncompressed"; the explicit passthrough
            // opt-in IS that acknowledgment (byte-untouched, no compression).
            // Refusals are remembered (recordSignedRefusal) so bili startups
            // keep listing unresolved schemes until configured away.
            // BILI_RESIGN=0 / resign["<scheme>"].enabled=false un-deploy the
            // guard (pre-#1884 handling: the request rides the normal
            // rewrite path — and clears the scheme's refusal memory).
            const guardScheme = inboundSignedScheme(req.headers);
            const resignMarker = String(Array.isArray(req.headers[APIG_RESIGN_HEADER]) ? req.headers[APIG_RESIGN_HEADER][0] ?? "" : req.headers[APIG_RESIGN_HEADER] ?? "");
            // An armed request is only ARMABLE when its credential marker decodes:
            // a mangled/missing credential cannot be re-signed, so it must take
            // the same refuse/opt-in-passthrough path as an un-armed signed
            // request instead of entering the rewrite pipeline with a stale
            // signature that is guaranteed to 401 upstream (APIG.0301).
            const resignArmable = resignMarker === APIG_RESIGN_SCHEME && decodeApigCredential(Array.isArray(req.headers[APIG_RESIGN_CREDENTIAL_HEADER]) ? req.headers[APIG_RESIGN_CREDENTIAL_HEADER][0] : req.headers[APIG_RESIGN_CREDENTIAL_HEADER]) !== undefined;
            // Route-first (#1884): the provider is resolved before the action —
            // the guard consults the matched route entry's `resign` block, so
            // policy follows the provider/model scoping the rest of the system
            // uses (env > providers.<url>.resign > global resign root).
            const guardResign = resignSettingsFor(opts, route?.rewrittenUrl ?? upstreamOrigin, guardScheme);
            if (
                guardScheme !== undefined &&
                !resignArmable &&
                guardResign.enabled
            ) {
                // #2090 owner ruling ("compress or refuse"): the only
                // pass-through outcome left is the pre-existing #1884 escape
                // hatch on the BUILT-IN scheme itself; every other scheme is
                // ALWAYS refused — its refusal has no user-side fix yet, only
                // bili shipping the re-signer. Passthrough settings are inert
                // for those schemes.
                if (guardScheme === APIG_RESIGN_SCHEME && guardResign.passthrough) {
                    clearSignedRefusal(guardScheme);
                    log("warn", `[signed-passthrough] built-in-scheme request without a working re-sign arm forwarded byte-untouched, no compression (#1884 escape hatch via resign["sdk-hmac-sha256"].passthrough / BILI_RESIGN_PASSTHROUGH — the user has acknowledged this link runs uncompressed)`);
                    forwarded = true;
                    await forward(req, res, opts, bodyBuffer, null, core, reqConfig, log, route, instanceId, undefined);
                    return;
                }
                recordSignedRefusal(guardScheme, upstreamOrigin);
                log("warn", `[signed-refused] request carries a ${guardScheme} body-covering signature without a working re-sign arm${resignMarker === APIG_RESIGN_SCHEME ? " (arm marker present but credential does not decode)" : ""} — refusing per the compress-or-refuse contract (${guardScheme === APIG_RESIGN_SCHEME ? "provide a signing credential to make bili re-sign, #1884" : "no re-signer exists for this scheme yet — it stays refused until bili ships one; passthrough settings do not apply"}). Remembered — bili will keep reminding at startup.`);
                const refusal = signedRefusal(guardScheme, (req.url ?? "").endsWith("/messages") ? "anthropic" : "openai");
                forwarded = true;
                res.writeHead(refusal.status, { "content-type": refusal.contentType, "x-bili-resign": "unavailable" });
                res.end(refusal.body);
                return;
            }
            if (guardScheme !== undefined && !resignArmable && !guardResign.enabled) {
                clearSignedRefusal(guardScheme);
            }
            const pendingForward = await withSessionLock(session, () => runPreparedPipeline(true));
            if (pendingForward) {
                forwarded = true;
                // #1195: wire clients (omp/pi on the plain proxy path) treat an
                // upstream overflow 400 as fatal and end the session — the armed
                // emergency shrink then never gets its "next turn". When forward()
                // sees a context overflow it calls this hook: re-run prepare+
                // preflight under the lock with the window the upstream STATED
                // (per-call limit override — nothing is learned, #987 keeps
                // governing), folding the payload below the REAL window and
                // re-sending it within this same request. An unchanged body
                // (nothing foldable) returns null and forward() passes the
                // original 400 through verbatim.
                const overflowRefold = pendingForward.prepared
                    ? async (realWindow: number | undefined): Promise<{ body: string | Buffer; prepared: Prepared | null } | null> => {
                          const next = await withSessionLock(session, () => runPreparedPipeline(false, realWindow));
                          if (!next || String(next.body) === String(pendingForward.body)) return null;
                          pendingForward.body = next.body;
                          pendingForward.prepared = next.prepared;
                          return next;
                      }
                    : undefined;
                await forward(req, res, opts, pendingForward.body, pendingForward.prepared, core, reqConfig, log, route, instanceId, affinity, overflowRefold, v1Meta);
                // Remember for ALL modes (not just plugin): wire clients (dsh,
                // hermes, unplug'd pi) read the same panel via /__bili/plugin/status
                // and need the nudge/breakdown sections too; locked so a racing
                // plugin tool call sees a consistent window.
                if (pendingForward.prepared) {
                    const preparedToRemember = pendingForward.prepared;
                    await withSessionLock(session, () => rememberPluginMessages(sessionId, preparedToRemember.processedMessages, preparedToRemember.originalMessages, preparedToRemember.nudge, bodyBuffer));
                }
            }
        } finally {
            releaseInFlight(session);
        }
    }
    if (!prepared && !forwarded) {
        if (protocol === null && !opts.passthrough && !routePassthrough && !isModelDiscoveryPath(urlPath) && !isV1InternalControlPlanePath(urlPath)) {
            logUnrecognizedPath(log, req.url ?? "");
        }
        await forward(req, res, opts, scrubCompatDrop(scrubAnthropicPck(protocol, bodyBuffer, log), compatDropPaths, log), null, core, reqConfig, log, route, instanceId, undefined);
    }
}
