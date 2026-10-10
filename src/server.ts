import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createCore, type CompressionCore, type CompressionState, type Config, type CoreMessage, type NudgeDecision, type Prompts, type PackSurface, defaultPrompts, deactivateBlock } from "acp-kernel";
import { DEFAULT_STRIP_IMAGES_KEEP_RECENT, resolveCompress, resolveCompressPrompts, resolveCompressSurfaceDetailed, resolveRequestConfig, type ResolvedKernelConfig } from "./compress-settings.js";
import { dropCompressReasoning, type CompressReasoningConfig } from "./reasoning-drop.js";
import type { ProxyOptions, ResignSettings } from "./config.js";
export type { ProxyOptions } from "./config.js";
import { loadNamedProviders, loadOptions, loadRoutes } from "./config.js";
import { resetProxyCache } from "./upstream-proxy.js";
import { FALLBACK_EFFECTIVE_WINDOW_FLOOR, findRoute, findRouteKey, lookupContextLimit, resolveConfiguredContextLimit, resolveConfiguredOutputLimit, resolveCompressProtocol, resolveResignSettings } from "./config.js";
import { contextFromRegistry, loadRegistry, peekRegistryContext, peekRegistryOutputLimit, peekRegistryPriceProfile } from "./registry.js";
import { codexAlignedWindow } from "./codex-models.js";
import { fetchWithTimeout, MAX_REQUEST_BYTES, upstreamTimeoutMs } from "./fetch-util.js";
import { getUpstreamConnectionStatus, resolveProxy, resolveProxyDecision, proxyDispatcher, type UpstreamProxyDecision } from "./upstream-proxy.js";
import { getUpstreamAlerts } from "./upstream-alerts.js";
import { hostIdForLog, maskHostPortForLog, setMaskHostsEnabled, maskUrlForLog, maskUrlsInText } from "./log-mask.js";
// Protocol codecs + the historical-image strip primitive live in the kernel now
// (single source of truth shared with the omp/pi adapters): import from
// "acp-kernel/wire" (kernel #215).
import {
    anthropicToCore,
    coreToAnthropic,
    conversationSignalAnthropic,
    extractSystem,
    buildSystem,
    stripHistoricalImages,
    type AnthropicRequestBody,
} from "acp-kernel/wire";
import {
    openaiToCore,
    coreToOpenai,
    injectOpenaiSystem,
    conversationSignalOpenai,
    type OpenAIRequestBody,
    type OpenAITool,
} from "acp-kernel/wire";
import {
    type ResponsesRequestBody,
    type ResponseInputItem,
    type ResponsesProjection,
    injectResponsesDeveloperMessage,
    conversationIdentityResponses,
    conversationSignalResponses,
} from "acp-kernel/wire";
import { responsesToCoreWithToolImages as responsesToCore, patchResponsesInputWithToolImages as patchResponsesInput, mergeAdjacentConfigurationUpdates } from "./responses-tool-output.js";
import { prepareAnthropic } from "./server/prepare-anthropic.js";
import { prepareOpenai } from "./server/prepare-openai.js";
import { prepareGoogle, prepareGoogleCountTokens } from "./server/prepare-google.js";
import { prepareResponses, prepareResponsesCompact } from "./server/prepare-responses.js";
import { FORCE_TEXT_PROTOCOL } from "./server/inject.js";
export { isChatGptCodexUpstream, isCodexResponsesLite, resolvePromptCacheKey, shouldInjectPromptCacheKey } from "./server/prepare-responses.js";
import { reconcileFoldCoverage, noteSystemPromptFingerprint, resolveFoldReconcileMode } from "./fold-reconcile.js";
import { biliToolsDeclaredOnWire, countBiliToolUses, evaluateSelfHealRound, nudgeSuppressed, pluginLaneDegraded, pluginLaneRestore } from "./session-self-heal.js";
import { getSession, hasProcessedState, listSessions, peekSession, type PendingRetrieval, type Session, initSessions, markDirty, flushAllSessions, acquireInFlight, releaseInFlight, totalInFlight, reconcileNativeCompactionBoundary, snapshotMessages, applyCompactionArchive, detectUnannouncedHistoryRewrite, markCompactionBoundary, ensureCanonicalId, storeEffectiveConfig, foldCoverage, postRebuildAnchorTokens, setPostRebuildAnchor, tickPostRebuildAnchor, splitSessionWarnings, REWRITE_MIN_INCOMING_TOTAL } from "./session.js";
import { detectStaleInstall } from "./update.js";
import { getAdvisoryState, cannotResolveTarget } from "./advisory.js";
import { PACKAGE_NAME, VERSION } from "./version.js";
import {
    coreToGoogle,
    googleToCore,
    googleSystemText,
    injectGoogleSystem,
    conversationSignalGoogle,
    type GoogleContent,
    type GoogleFunctionDeclaration,
    type GoogleRequestBody,
    type GoogleSystemInstruction,
    type GoogleTool,
} from "acp-kernel/wire";
import { ABSORB_TOOL_NAME, COMPRESS_TOOL, BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE, BILI_ACP_TOOLS_GOOGLE, BILI_ACP_TOOLS_GOOGLE_NO_RANGE, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_OPENAI_NO_RANGE, BILI_ACP_TOOLS_RESPONSES, BILI_ACP_TOOLS_RESPONSES_NO_RANGE, BILI_ACP_READONLY_TOOLS_RESPONSES, BILI_ACP_READONLY_TOOLS_RESPONSES_NO_RANGE, COMPRESS_TOOL_NAME, IMAGE_FULL_TOOL, IMAGE_FULL_TOOL_GOOGLE, IMAGE_FULL_TOOL_OPENAI, IMAGE_FULL_TOOL_RESPONSES, RULE_TOOL, RULE_TOOL_GOOGLE, RULE_TOOL_OPENAI, RULE_TOOL_RESPONSES, absorbToolsFor, retrieveToolsFor, buildAcpTagsOnlyPrompt } from "./compress-tool.js";
import { absorbEnabled, storeEffectiveAbsorb } from "./absorb.js";
import { ccrEnabled, ccrLoopConfig, ccrPluginWireOk, contentStoreOf, executeRetrieve, pruneExpiredRetrievals, reconcileReloadedRetrievals, renderRetrievalNotes, retrieveToolName, snapshotPendingRetrievals, snapshotRetrievalNotes, storeEffectiveCcr, type CcrSettings } from "./store.js";
import { buildIncomingImageIndex, foldAnchoredCutoff, pruneRetrieveImgExports } from "./image-restore.js";
import { imageCompressionEnabled, storeEffectiveImageCompression, type ImageCompressionSettings } from "./image-compress.js";
import { rulesEnabled, storeEffectiveRules } from "./rules-feature.js";
import { storeEffectiveSearchPlanAware } from "./decompress-shared.js";
import { armAutoFoldBackoff, autoFoldEngaged, AUTO_FOLD_BACKOFF_MS, externalQueueDroppedAll, withExternalSummaryTools } from "./external-summary-surface.js";
import { AUTO_FOLD_TARGET_MIN } from "./external-summary-settings.js";
import { applyRanges } from "./stream.js";
import { attachSubagentSessions } from "./subagent-sessions.js";
import { buildSessionCacheReport, handleAcpCache, learnedImageReserve, noteClientAbort, readKeySwitchStats, readModelSwitchStats, settleUsageReport } from "./cache-ledger.js";
import { extractBillingAttributionBlock, extractSummaryFromSse, preflightCompress, estimateCoreMessages, estimateCoreMessagesUpper, estimateCoreMessagesUpperBytes, estimateRawBodyTokens, type PreflightResult } from "./preflight.js";
import { buildDecisionPrompt, buildDirectiveText, consumeFallback, DEFAULT_DECIDE_MAX_TOKENS, DECIDE_TIMEOUT_MS, extractDecisionText, ladderMode, parseDecision, recordDecision, resolveDecisionRange, type DecideConfig, type DecisionOutcome } from "./nudge-decide.js";
import { gcConfigFromEnv, gcSessionFiles } from "./session-gc.js";
import { countImagesInParsedBody, countImagesInRawBody, imageTokensInRawBody, imageTokensInParsedBody, resolveImageBilling, upstreamHost, type ResolvedImageBilling } from "./image-tokens.js";
import { APIG_RESIGN_HEADER, APIG_RESIGN_CREDENTIAL_HEADER, APIG_RESIGN_SCHEME, KNOWN_SIGNATURE_SCHEMES, clearSignedRefusal, decodeApigCredential, inboundSignedScheme, readPendingRefusals, recordSignedRefusal, resignApig, signedRefusal, unresolvedRefusals } from "./apig-resign.js";
import { renderUI, handleConfigGet, handleConfigPut, handleSummaryCredentialPut, buildOverview, buildSessionList, buildSessionPage, buildSessionDetail, hiddenEmptyCount } from "./web/index.js";
import { reapOrphanBlocks } from "./orphan-gc.js";
import { conflictScanEnabled, isDesignBenign, scanClientPlugins, sniffScanClient } from "./thirdparty-scan.js";
import { clearConflictEvents, recordConflict, summarizeConflicts } from "./conflict-watch.js";
import { getStore } from "./persist.js";
import { log as loggerLog, configureLogger, getLogPath, closeLogger, isStreamWriteError, isBenignSocketRaceError, enterSessionContext } from "./logger.js";
import { queryLogLines } from "./web/logs-query.js";
import { configFile, defaultLogFile, stateDir } from "./paths.js";
import { atomicWriteInstanceFile, clearProxyInstanceFile, entryScriptFingerprint, findSameLanePredecessor, isPidAlive, listInstances, registerInstanceAndWarn, unregisterInstance, warnOnNewPeers, type ProxyInstanceFile } from "./instance.js";
import { hoistTrappedToolItems } from "./tool-pair-order.js";
import { computeAnthropicMessageMarks, stampAnthropicSystemCacheControl, anthropicToolsCarryCacheControl } from "./loop/cache-control.js";
import { reconcileSystemAnchor } from "./system-anchor.js";
import { isStrictReasoningEcho, modelIdOf, normalizeStrictEchoReasoning, normalizeStrictEchoResponsesInput } from "./strict-echo.js";
export { isStrictReasoningEcho, normalizeStrictEchoReasoning, normalizeStrictEchoResponsesInput };
import { sanitizeResponsesInputIds, dropWhitespaceResponsesMessages, normalizeResponsesMessageItems } from "./loop/adapter-responses.js";
import { CODEX_COMPACT_HEALTH_RATIO, codexCompactMode, isCodexClient, hasCompactionTrigger, stripBiliCompactionItems, replaceBiliCompactionItems, codexCompactGate, codexCompactGatePre, buildTriggerForgeBody, mergeForgedSummaries } from "./codex-compact.js";
import { stripAcpPanelMessages, stripAcpPanelResponsesInput, stripAcpStatusMarkers } from "./acp-panel.js";
import { emitPreflightError } from "./stream-error.js";
import { agentProviderRecipes } from "./agent-providers.js";
import { affinityToken, claudeSubagentAgentId, claudeSubagentSplit, clientConversationHeader, codexTurnIdentity, conversationHeaderSource, dshPersonaFingerprintApplies, instructionsFingerprintApplies, openaiSystemTextForPersona, preferPromptCacheKeyIdentity, shouldStampRelayAffinityPck, type ConversationIdentity } from "./session-id.js";
import { personaNamespace } from "./persona-anchor.js";
import { prefixAffinity, type AnonymousAffinity } from "./prefix-affinity.js";
import { maybeAdoptForkBlocks, maybeAdoptResume } from "./fork-adoption.js";
import { publicForkInputMatches } from "./plugin.js";
import { flushPrefixAffinity, hydratePrefixAffinity, scheduleAffinityPersist } from "./affinity-persist.js";
import { setSimhashAdoptionEnabled } from "./prefix-affinity.js";
import { consumePluginRegisterFor, flushConversations, handlePluginCompact, handlePluginManifest, handlePluginFork, handlePluginSnapshot, handlePluginRegister, handlePluginRuntimeInfo, handlePluginStatus, handlePluginTool, isPluginFoldCallId, loadConversations, pluginAgentHeader, pluginConversationHeader, pluginHeadersMatchModel, pluginReportedContextWindow, pluginReportedMaxOutput, pluginRequestAgentHeader, pluginRuntimeInfoFor, pluginRuntimeInfoForConversation, recordChainVerdict, recordPluginSession, rememberPluginMessages, resolveConversation, runtimeConversationId, takePendingPluginRegister } from "./plugin.js";
import { setupMitm, readMitmUpstream, getBlindTunnelStats, liveBlindTunnels, MITM_RAW_SOCKET_KEY } from "./mitm.js";
import { evaluateChain, extractChainCarriers, stripEmbeddedChainCarriers } from "./chain-checkpoint.js";
import type { BiliMessage } from "acp-kernel/wire";
import { appendSystemText, applyEstimateCalibration, currentCalibrationFactor, BILI_PASSTHROUGH_HEADER, BILI_PLUGIN_BYPASS_HEADER, hardenOpenaiAssistantContent, isLoopbackAddress, normalizeUpstreamOrigin, reserveOutputHeadroom, resolveOutputHeadroomCap, shouldReserveOutputHeadroom, systemToUser, strippedResponseIdWarning, type WireProtocol } from "./util.js";

import { BILI_TUNNEL_HEADER, checkTunnelDestination, classifyIp, localMachineIps, normalizeIpLiteral, parseIpLiteral, tunnelAllowlistFromEnv } from "./tunnel-guard.js";

import { decodeRequestBody, DecompressedTooLargeError } from "./content-encoding.js";
import { dropCompatFieldsJson } from "./compat-drop.js";
import { handleAdminRoute } from "./server/admin.js";
import { handle } from "./server/handle.js";
import { bodyDumpEnabled, getUnrecognizedPathStats, isModelDiscoveryPath, logDumpFailure, logUnrecognizedPath } from "./server/observability.js";
import {
    clientErrorBackstopMs as knobClientErrorBackstopMs,
    countTokensPassthrough as knobCountTokensPassthrough,
    exposureLogIntervalMs as knobExposureLogIntervalMs,
    forceTextProtocol as knobForceTextProtocol,
    keepAliveTimeoutMs as knobKeepAliveTimeoutMs,
    keepResponseId as knobKeepResponseId,
    noCompressPrompt as knobNoCompressPrompt,
    noInjectTool as knobNoInjectTool,
    postResponseLingerMs as knobPostResponseLingerMs,
    preflightDeadEndCooldownMs as knobPreflightDeadEndCooldownMs,
    preflightHoldGraceMs as knobPreflightHoldGraceMs,
    renderNone as knobRenderNone,
    requestWatchdogBudgetMs as knobRequestWatchdogBudgetMs,
    streamKeepAliveMs as knobStreamKeepAliveMs,
} from "./knobs.js";
import { BILI_HOP_HEADER, anthropicBetaContextWindow, capRegistryWindowByStandard, expandedContextSuffixWindow, LAUNCHER_MODEL_WINDOWS, LAUNCHER_MODEL_MAX_OUTPUTS, launcherContextWindow, launcherMaxOutput, parseLauncherModelWindows, windowSourceLogged } from "./server/context-window.js";
import { connectionNamedHeaders, NO_IDENTITY_MESSAGE, UPSTREAM_HOP_HEADERS } from "./server/headers.js";
import { installWebSocketBridge } from "./ws-bridge.js";
import { codexResponsesCodec, responsesCodec } from "./responses-ws.js";
import { currentFetchTransport } from "./fetch-transport.js";
import { demoteGate, hasLeakedBiliToolsOnly, isSideRequest, outputBudgetField, resolveSideLane, restoreOutputBudget, SIDE_REQUEST_MAX_TOKENS, sideRequestGuard, stripLeakedBiliTools } from "./server/side-request.js";
import { DSH_COMPACTION_SHAPE_MSGS, dshCompactionRefusal, isDshCompactionCall } from "./server/dsh-compaction-guard.js";
import { clampOutgoingOutput, countSystemAndToolsTokens, emergencyNudge, estimateInputTokens, estimateWireOverhead, projectThinkingMass } from "./server/budget.js";
import { pipeThrough } from "./server/stream-io.js";
import { artifactSeedHit, detectAcpArtifacts } from "./server/chain-artifacts.js";
import { piSubagentChannelFallback } from "./server/pi-subagent-channel.js";
import { droppedOpenaiParts } from "./wire-drop-warn.js";
export { forward } from "./server/relay.js";

// #1086/#1218: the per-session chain-verdict memory moved to plugin.ts
// (`chainVerdicts`) so the /acp status path can read it — a session judged an
// external chain is passed through with NO local state, and /acp must be able
// to explain that instead of the misleading armed-idle notice. Warn-once
// semantics preserved: recordChainVerdict returns true on the first verdict
// for a session. Re-exported under the old names for tests.
export { WARNED_CHAIN_SESSION_CAP, _resetChainVerdictsForTest as _resetChainWarningsForTest, _chainVerdictMapForTest as _chainWarnSetForTest } from "./plugin.js";

// #1205: sessions already warned about codec-dropped content parts (e.g.
// DeepSeek Files API file refs) — one warn per session per distinct type-set;
// attachment flows resend the same history every turn. Same bounded-FIFO shape
// as warnedChainSessions above.
const warnedWireDropKeys = new Set<string>();
const WARNED_WIREDROP_KEY_CAP = 4096;
export function _resetWireDropWarningsForTest(): void {
    warnedWireDropKeys.clear();
}
export function warnDroppedOpenaiParts(parsed: unknown, sessionId: string, log: (level: string, msg: string) => void): void {
    const report = droppedOpenaiParts(parsed);
    if (!report) return;
    const key = `${sessionId}:${report.types.join(",")}`;
    if (warnedWireDropKeys.has(key)) return;
    warnedWireDropKeys.add(key);
    if (warnedWireDropKeys.size > WARNED_WIREDROP_KEY_CAP) {
        warnedWireDropKeys.delete(warnedWireDropKeys.values().next().value as string);
    }
    log("warn", `[${sessionId}] wire codec will drop ${report.count} non-user content part(s) with unrecognized type(s) [${report.types.join(", ")}] (first at message #${report.firstIndex}) — kernel 0.0.85+ preserves all user-message parts (DeepSeek Files API refs included, #1205/#1188), but parts riding system/assistant/tool messages still reduce to text-only`);
}

// #1284: upstream targets already warned about a "not a model conversation →
// relaying verbatim" verdict — misrouted third-party endpoints can retry in
// tight loops. Bounded FIFO, same shape as warnedWireDropKeys.
export const NON_CONVERSATION_RELAY_WARN_CAP = 4096;
export const nonConversationRelayWarned = new Set<string>();

// #1073: a forward-proxy-style (absolute-form) request whose authority IS this
// instance's own listening endpoint — e.g. a health prober configured with our
// port as its http_proxy asking for http://127.0.0.1:<self-port>/__bili/health.
// Fetching that URL means serving it locally; routing it through the tunnel
// path would only trip bili's own self-layer / admin gate with a 403 instead of
// returning real health state. Returns the stripped origin-form path when the
// request qualifies, else undefined. Management prefixes only — model-style
// paths keep the loud self-layer 403 (#562). Hostname destinations other than
// the literal loopback names stay conservative (tunnel classification decides).
export function selfAdminProbePath(reqUrl: string, localPort: number | undefined): string | undefined {
    if (!reqUrl.startsWith("http://") && !reqUrl.startsWith("https://")) return undefined;
    if (localPort === undefined) return undefined;
    try {
        const u = new URL(reqUrl);
        const port = u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
        if (port !== localPort) return undefined;
        const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        const mine = host === "0.0.0.0" || host === "::" || host === "localhost" || localMachineIps().has(normalizeIpLiteral(host));
        if (!mine) return undefined;
        const p = u.pathname;
        if (p === "/__bili/" || p.startsWith("/__bili/") || p === "/__acp/" || p.startsWith("/__acp/")) return p + u.search;
    } catch {
        // malformed absolute URL — not a probe
    }
    return undefined;
}

export function resolveUpstream(_opts: ProxyOptions, reqUrl: string, req?: http.IncomingMessage): { upstream: string; rewrittenUrl: string; explicitProtocol?: WireProtocol; tunnel?: boolean } | undefined {
    // MITM mode: the request arrived over a CONNECT tunnel we terminated
    // locally (client set HTTP_PROXY and issued CONNECT host:443). The socket
    // carries the real upstream origin; the request path has no /bili/ prefix
    // — it's a bare /api/anthropic/v1/messages. Reconstruct the full upstream
    // URL so handle()/forward() route to the host the CONNECT targeted. The
    // client's Authorization header (OAuth token for the subscription) is
    // forwarded verbatim → subscription auth preserved, no MITM of creds.
    const mitmUpstream = readMitmUpstream(req?.socket);
    if (mitmUpstream) {
        // Use a `mitm://` scheme in rewrittenUrl so per-URL config (proxy,
        // context overrides) can DISTINGUISH MITM traffic from /bili/ path
        // traffic to the SAME host. The real upstream stays https:// (in
        // `upstream`) for the actual fetch; forward() strips the mitm:// scheme
        // back to https:// before calling fetch (fetch would reject mitm://).
        // Mapping is bijective: mitm://<host><path> ⟺ https://<host><path>.
        const mitmKey = mitmUpstream.replace(/^https:\/\//, "mitm://");
        return { upstream: mitmUpstream, rewrittenUrl: mitmKey + (reqUrl ?? "") };
    }
    // Zero-config mode: a request like `/bili/https://open.bigmodel.cn/api/anthropic`
    // embeds the full upstream URL after the `/bili/` prefix. Strip the prefix,
    // take the rest verbatim as the upstream. This is the ONLY routing mode —
    // there are no named providers. The `/bili/` prefix doubles as a signal:
    // client-side billion-context extensions (billion-context-pi / opencode-acp)
    // can detect it in their own baseUrl and self-disable, avoiding double
    // compression.
    const KNOWN_PROTOCOLS = ["responses", "anthropic", "openai", "google"] as const;
    if (reqUrl.startsWith("/bili/")) {
        let rest = reqUrl.slice(6);
        let explicitProtocol: WireProtocol | undefined;
        for (const p of KNOWN_PROTOCOLS) {
            const prefix = `${p}/`;
            if (rest.startsWith(prefix + "http://") || rest.startsWith(prefix + "https://")) {
                explicitProtocol = p;
                rest = rest.slice(prefix.length);
                break;
            }
        }
        if (rest.startsWith("http://") || rest.startsWith("https://")) {
            try {
                const u = new URL(rest);
                return { upstream: `${u.protocol}//${u.host}`, rewrittenUrl: rest, explicitProtocol, tunnel: true };
            } catch {
                // malformed embedded URL
            }
        }
    }
    // Forward-proxy mode (#535 phase 2): a client honoring an http_proxy env
    // sent this request in absolute form (`GET http://host/path HTTP/1.1`) —
    // exactly what httpx emits for plain-http base URLs through a proxy. Route
    // it like the /bili/ embedded form: the absolute URL IS the upstream, same
    // tunnel semantics.
    //
    // #562: do NOT decide "is this the proxy itself?" from the client-provided
    // Host header. In a real forward proxy the client sets Host to the UPSTREAM
    // (== the URL authority), so comparing u.host against req.headers.host
    // misclassified every legitimate forward-proxy request as a self-request
    // and dropped it to `undefined` — losing the per-upstream context-window
    // config (route?.rewrittenUrl undefined) while the fallback forward still
    // reached the upstream (chat kept working, the window silently didn't).
    // Self-targeting is decided by the ACTUAL listening endpoint instead: mark
    // this a tunnel and let checkTunnelDestination's self-layer (destination
    // port == our bound port AND a local-machine IP) 403 a genuine self-forward
    // before any forwarding — no silent fall-through to the fallback path.
    if (reqUrl.startsWith("http://") || reqUrl.startsWith("https://")) {
        try {
            const u = new URL(reqUrl);
            return { upstream: `${u.protocol}//${u.host}`, rewrittenUrl: reqUrl, tunnel: true };
        } catch {
            // malformed absolute URL
        }
    }
    return undefined;
}

// #806: request-scoped IDLE watchdog. A wedged request (accepted, logged
// "forward", then never dispatched/answered) had NO deadline of its own —
// undici timeouts don't apply across CONNECT tunnels and bili's fetch timer
// only arms once fetchWithTimeout is entered. Armed at ACCEPT (before handle());
// fires when the response goes silent for the whole budget. IDLE, not total:
// every res.write re-arms, so long healthy streams survive. Firing aborts the
// in-flight upstream fetch via the controller forward()/preflight registered on
// the response — closing the response alone would NOT abort it (the close
// handler only aborts when !writableEnded), leaving a zombie fetch holding its
// socket for the full upstream idle timeout.
const requestAborts = new WeakMap<http.ServerResponse, AbortController>();

export function registerRequestAbort(res: http.ServerResponse, ac: AbortController): void {
    requestAborts.set(res, ac);
}

export function requestWatchdogBudgetMs(): number {
    return knobRequestWatchdogBudgetMs();
}

function armRequestWatchdog(req: http.IncomingMessage, res: http.ServerResponse, log: (level: string, msg: string) => void): void {
    const budgetMs = requestWatchdogBudgetMs();
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) return; // operator opted out
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const fire = (): void => {
        timer = undefined;
        if (res.writableEnded || res.destroyed || !res.socket || res.socket.destroyed) return;
        const secs = Math.round((Date.now() - startedAt) / 1000);
        log("error", `[watchdog] ${req.method ?? "?"} ${maskUrlForLog(req.url ?? "")} produced no output for ${secs}s (idle budget ${Math.round(budgetMs / 1000)}s) — closing the request so the client can fail fast instead of hanging forever`);
        requestAborts.get(res)?.abort();
        try {
            if (!res.headersSent) {
                res.writeHead(504, { "content-type": "application/json", "connection": "close" });
                res.end(JSON.stringify({ error: { type: "gateway_timeout", message: `billion-context watchdog: no output within ${Math.round(budgetMs / 1000)}s; retry the request` } }));
            } else if (!res.writableEnded) {
                res.end();
            }
        } catch { /* client already gone */ }
    };
    const arm = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(fire, budgetMs);
        timer.unref?.();
    };
    // Re-arm on every byte written toward the client. Bind the original so the
    // patch is transparent to backpressure (returns the same boolean) and works
    // with any write signature (string/Buffer/Uint8Array, encoding, callback).
    const origWrite = res.write.bind(res);
    res.write = ((...args: Parameters<typeof origWrite>) => {
        arm();
        return origWrite(...args);
    }) as typeof res.write;
    res.on("close", () => { if (timer) clearTimeout(timer); });
    arm();
}

/** Classify a Gemini native request path. The model and the method both live
 *  in the path, never in the body: `/v1beta/models/<model>:streamGenerateContent`
 *  (streaming, usually with `alt=sse`), `:generateContent` (single shot) and
 *  `:countTokens`. Returns null for every other path (model listing, files,
 *  cachedContents, the OpenAI-compatible `/v1beta/openai/...` mirror). */
type GooglePathKind = "stream-generate" | "generate" | "count-tokens";

export function googlePathKind(urlPath: string): GooglePathKind | null {
    if (urlPath.includes(":streamGenerateContent")) return "stream-generate";
    if (urlPath.includes(":generateContent")) return "generate";
    if (urlPath.includes(":countTokens")) return "count-tokens";
    return null;
}

/** The Gemini request carries the model in the URL path, never in the body
 *  (`POST /v1beta/models/gemini-3.8-flash:streamGenerateContent`). Every
 *  model-keyed decision (window resolution, thresholds, the summarization
 *  adapter, degenerate-turn analysis) reads it from here instead of
 *  `parsed.model`. Returns undefined when the path carries no model or an
 *  undecodable one. */
export function googleModelFromPath(urlPath: string): string | undefined {
    const m = /\/models\/([^/:?]+):(?:streamGenerateContent|generateContent|countTokens)\b/.exec(urlPath);
    if (!m || !m[1]) return undefined;
    try {
        return decodeURIComponent(m[1]);
    } catch {
        return m[1];
    }
}


export async function startServer(opts: ProxyOptions): Promise<http.Server> {
    // Configure the tee logger (file + stderr) BEFORE any logging so the very
    // first line (persist status) lands in the file too.
    const filePath = configureLogger(opts.logFile ?? defaultLogFile());
    const core = createCore();
    const config: Config = opts.kernelConfig;
    const log = (level: string, msg: string) => logMsg(opts, level, msg);
    // #300: per-server identity stamped into the x-bili-hop marker on outbound
    // forwards. Per-server (not module-level) so two servers in one process
    // (tests) are distinct instances; a restart changing the id is harmless
    // (the chain check only compares against the other running instance).
    const instanceId = randomUUID();
    const instanceStartedAt = Date.now();
    // #7 (shared stable-port proxy): the parent-gone watchdog watches a SET of
    // pids, not one. The spawning hook seeds it via BILI_PARENT_PID; every
    // ATTACHING session (POST /__bili/watcher) adds its claude host, so a
    // proxy shared across sessions dies when the LAST owner exits — not when
    // the first spawner does. Per-server like instanceId above; armed here
    // (before listen) so a racing first registration can never observe an
    // unarmed watchdog.
    const parentWatchPid = Number.parseInt(process.env.BILI_PARENT_PID ?? "", 10);
    const initialWatcherPid = Number.isInteger(parentWatchPid) && parentWatchPid > 0 && parentWatchPid !== process.pid ? parentWatchPid : null;
    const proxyWatchers = new Set<number>();
    if (initialWatcherPid !== null) proxyWatchers.add(initialWatcherPid);
    // Reload persisted compression state before accepting traffic so sessions
    // that survived a restart keep their folded view (otherwise long sessions
    // re-send oversized raw history and hang).
    await initSessions();
    loadConversations();
    log("info", `[persist] ${getStore().enabled ? "enabled" : "disabled"}`);
    // #1082: sweep stale small session files — boot pass + periodic. Runs
    // against the disk tree, not the in-memory map: evicted/capped sessions
    // leave files behind that only a disk walk sees.
    const gcCfg = gcConfigFromEnv();
    if (gcCfg.enabled && getStore().enabled) {
        void gcSessionFiles().catch((err) => log("warn", `[gc] sweep failed: ${String(err)}`));
        const gcTimer = setInterval(() => {
            void gcSessionFiles().catch((err) => log("warn", `[gc] sweep failed: ${String(err)}`));
        }, gcCfg.intervalMs);
        gcTimer.unref?.();
    }
    // #405 (silent env knobs): the tunnel allowlist is security-relevant —
    // surface it at startup so a remote-client deployment shows WHY private
    // destinations pass or fail.
    const tunnelAllowlist = tunnelAllowlistFromEnv();
    if (tunnelAllowlist.length > 0) log("info", `[tunnel] remote-client allowlist: ${tunnelAllowlist.join(", ")}`);
    if (filePath) {
        log("info", `[log] writing to ${filePath}`);
    }
    // Pre-fetch the models.dev registry in the background (non-blocking). Used
    // as the context-window source for zero-config `/p/` routes that have no
    // per-model config. A miss falls back to the prefix table + default.
    void loadRegistry();
    const adminCtx = { opts, core, config, log, instanceId, instanceStartedAt, proxyWatchers, initialWatcherPid };

    const dispatch = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
        armRequestWatchdog(req, res, log);
        const connRec = connRecords.get(req.socket);
        if (connRec) {
            connRec.requests++;
            res.on("finish", () => { connRec.lastResponseEndAt = Date.now(); });
        }
        try {
            await handle(req, res, opts, core, config, log, instanceId, instanceStartedAt, proxyWatchers, initialWatcherPid, adminCtx);
        } catch (err) {
            const msg = String(err);
            const e = err as { name?: string; message?: string };
            // #411: a client cancel aborts the upstream fetch via
            // res.on("close") — normal agent behavior, not a proxy failure.
            // With the client already gone it is logged as info instead of
            // feeding the context-free [error] AbortError storm.
            const clientAbort = (e?.name === "AbortError" || /abort/i.test(String(e?.message ?? ""))) && (res.destroyed || res.writableEnded);
            if (clientAbort) log("info", `client aborted mid-stream: ${msg}`);
            // #806: cap-include the stack on hard failures — the bare message
            // gave no clue where the handler died (wedged-request forensics).
            else if (err instanceof Error && err.stack) log("error", `${msg}\n${err.stack.split("\n").slice(1, 8).join("\n")}`);
            else log("error", msg);
            if (!res.headersSent) {
                const status = msg.includes("exceeds") ? 413 : 502;
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "acp-proxy failure", detail: msg }));
            } else {
                res.end();
            }
        }
    };
    const server = http.createServer(dispatch);
    // Generic WebSocket bridge: protocol codecs claim upgrades here (#1467
    // phase-2 shell); the Responses codec is the first (and currently only)
    // entry. Unclaimed upgrades still fall through to the 426 contract below.
    const wsUpgrade = installWebSocketBridge(server, dispatch, log, [responsesCodec, codexResponsesCodec], (url) => resolveProxyDecision(opts.routes, opts.proxy, url, opts.proxyFallback).proxy !== undefined);
    // Unclaimed upgrades retain the immediate HTTP fallback contract.
    // An explicit 'upgrade' listener is
    // required: without one Node's behavior is version-dependent (some
    // versions destroy the socket with no response), delaying clients with
    // built-in fast-fallback (e.g. Codex) that need a clean 426 to switch to
    // HTTP POST immediately.
    server.on("upgrade", (req, socket, head) => {
        if (wsUpgrade(req, socket, head)) return;
        log("info", `[ws] rejected ${req.method} ${maskUrlsInText(req.url ?? "")} host=${req.headers.host ? maskHostPortForLog(req.headers.host) : "?"} with 426`);
        socket.on("error", () => {}); // client may vanish mid-write; don't let ECONNRESET crash the process
        const body = JSON.stringify({ error: "WebSocket upgrades are not supported; use HTTP POST" });
        socket.end(
            "HTTP/1.1 426 Upgrade Required\r\n" +
                "Connection: close\r\n" +
                "Content-Type: application/json\r\n" +
                `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                "\r\n" +
                body,
        );
    });
    // #1452: explicit keep-alive idle budget. Node's implicit default is
    // 5000ms; the default here matches it exactly (zero behavior change), but
    // the knob exists so pooled clients can deliberately extend or shorten the
    // reuse window instead of guessing at Node internals.
    const keepAliveTimeoutMs = knobKeepAliveTimeoutMs();
    server.keepAliveTimeout = keepAliveTimeoutMs;
    // #1529: terminal backstop for the clientError drain path. After the bail
    // end(), a peer that never sends FIN holds the socket half-open on our
    // side indefinitely (the kat reaper keys off completed responses; Node
    // enables no SO_KEEPALIVE by default). Destroy after this much post-bail
    // silence instead. Safe against the #1452 RST signature: resume() has
    // drained the recv buffer for the whole window, so no unread residual
    // bytes ride the destroy. 0 restores hold-until-peer-death (status quo).
    const clientErrorBackstopMs = knobClientErrorBackstopMs();
    log("info", `[conn] keepAliveTimeout=${keepAliveTimeoutMs}ms clientErrorBackstop=${clientErrorBackstopMs}ms`);
    // #1714: BILI_STREAM_STALL_MS is retired (#1706 incident: a stale 400ms
    // export turned every thinking-phase silence into a false truncation).
    // The value is now ignored; name it once at startup so stale shell exports
    // announce themselves instead of silently dying.
    const retiredStallEnv = process.env.BILI_STREAM_STALL_MS;
    if (retiredStallEnv !== undefined && retiredStallEnv.trim() !== "") {
        log("warn", `[config] BILI_STREAM_STALL_MS=${retiredStallEnv} is no longer read (#1714) — ignored; upstream silence is bounded by the ${Math.round(upstreamTimeoutMs() / 60000)}-minute idle budget (BILI_UPSTREAM_TIMEOUT_MS)`);
    }
    // #1452: per-connection lifecycle ledger — turns "which side closed this
    // socket, and why" from forensic inference into one debug line per
    // connection (zero payload content). reason=destroyed means nobody ended
    // the socket deliberately: every intentional destroy path carries its own
    // dedicated log marker to correlate against.
    interface ConnRecord {
        id: number;
        kind: "tls" | "tcp";
        openedAt: number;
        requests: number;
        lastResponseEndAt: number | null;
        errored: string | null;
        serverEndAt: number | null;
        peerFinAt: number | null;
        /** #1529: the clientError drain disposition owns this socket (idempotence guard). */
        drainArmed: boolean;
        /** #1529: performance.now() when the post-bail backstop destroyed the socket (peer never FINned). */
        backstopAt: number | null;
        /** #1982: server-side end() was called on this socket (destroySoon stamp; distinguishes it from bare destroys). */
        ended: boolean;
        /** #1982: TLS handshake completed (plain-TCP legs start true — nothing to wait for). */
        secured: boolean;
        /** #1982: the other leg of a MITM connection (raw TCP ↔ terminated TLS); null elsewhere. */
        paired: ConnRecord | null;
        /** #1982: performance.now() when the post-response linger backstop destroyed the socket (peer never FINned). */
        lingerBackstopAt: number | null;
    }
    const connRecords = new Map<net.Socket, ConnRecord>();
    let connSeq = 0;
    // #1982: turn the proxy-initiated post-response close from abortive into
    // graceful. Node's destroySoon() — the Connection: close disposition in
    // resOnFinish — calls end() then destroy() on the SAME TICK (for flushed
    // responses writableFinished is already true, so destroy is not deferred),
    // while the response tail / TLS close_notify may still be unACKed in
    // flight. A kernel closing an fd with unacked send bytes (or unread recv
    // residual) answers RST instead of FIN; pooled downstream clients surface
    // it as ECONNRESET (#1982: 196 occurrences measured over two weeks on a
    // Windows downstream, two of them crashing its process).
    // Detection: end() is intercepted to stamp rec.ended — prefinish cannot be
    // used (it fires async, AFTER the same-tick destroy). The peer's close
    // signal (a TCP FIN, or a TLS close_notify that can only follow ours) is
    // proof our last byte was received+ACKed — it cannot be sent before
    // processing ours — so: intercept the destroy, resume() to drain the recv
    // side, wait for that signal, then destroy; a silent peer costs at most
    // one fd for the budget window (backstop). Plain-TCP and MITM TLS legs
    // share the same destroySoon race and get the same treatment.
    // Deliberately NOT applied to: error-driven destroys (the peer is already
    // gone — nothing left to protect), pre-handshake teardown, sockets owned
    // by the clientError drain (#1529), and bare destroys without end() (kat
    // reaper on idle sockets — empty queues, already clean).
    const installPostResponseLinger = (socket: net.Socket, rec: ConnRecord): void => {
        let armed = false;
        let backstopTimer: ReturnType<typeof setTimeout> | undefined;
        const origDestroy = socket.destroy.bind(socket);
        // Node's end() overloads don't compose under .call; flatten to one
        // signature at this interception boundary (all three call shapes covered).
        // bind() is load-bearing: called unbound, Socket.end reads
        // this._writableState off undefined (crash inside destroySoon).
        const origEnd = socket.end.bind(socket) as unknown as (chunk?: string | Uint8Array, enc?: BufferEncoding, cb?: () => void) => typeof socket;
        const wrappedEnd = (chunk?: string | Uint8Array, encOrCb?: BufferEncoding | (() => void), cb?: () => void): typeof socket => {
            rec.ended = true;
            if (typeof encOrCb === "function") return origEnd(chunk, undefined, encOrCb);
            return origEnd(chunk, encOrCb, cb);
        };
        Object.defineProperty(socket, "end", { value: wrappedEnd, writable: true, configurable: true });
        const finishLinger = (why: "peer-fin" | "backstop" | "error"): void => {
            if (!armed) return;
            armed = false;
            if (backstopTimer) clearTimeout(backstopTimer);
            if (socket.destroyed) return;
            if (why === "backstop") {
                rec.lingerBackstopAt = performance.now();
                log("warn", `[conn#${rec.id}] ${rec.kind} linger backstop: no peer close signal ${knobPostResponseLingerMs()}ms after post-response close — destroying (peer may see RST/ECONNRESET)`);
            } else if (why === "peer-fin") {
                log("debug", `[conn#${rec.id}] ${rec.kind} linger complete: peer close signal received — closing cleanly`);
            }
            origDestroy();
        };
        const wrappedDestroy = (err?: Error): net.Socket => {
            if (armed) return socket;
            if (err || rec.errored !== null || rec.drainArmed || !rec.secured || !rec.ended || rec.lastResponseEndAt === null) {
                return origDestroy(err);
            }
            // Peer closed first: its FIN already proved delivery, so the destroy
            // is clean — and waiting for an 'end' that already fired would only
            // dead-lock into the backstop.
            if (rec.peerFinAt !== null || socket.readableEnded) {
                return origDestroy();
            }
            armed = true;
            log("info", `[conn#${rec.id}] ${rec.kind} post-response close: lingering for peer close signal (budget ${knobPostResponseLingerMs()}ms)`);
            // http leaves the socket paused between requests; without resume()
            // the peer's EOF would never reach us and every linger would run
            // out on the backstop. Draining also removes unread recv residual
            // (the Linux RST trigger) across the whole window.
            socket.resume();
            socket.once("end", () => finishLinger("peer-fin"));
            socket.once("error", () => finishLinger("error"));
            backstopTimer = setTimeout(() => finishLinger("backstop"), knobPostResponseLingerMs());
            backstopTimer.unref?.();
            return socket;
        };
        Object.defineProperty(socket, "destroy", { value: wrappedDestroy, writable: true, configurable: true });
    };
    server.on("connection", (socket) => {
        const rec: ConnRecord = {
            id: ++connSeq,
            kind: socket instanceof tls.TLSSocket ? "tls" : "tcp",
            openedAt: Date.now(),
            requests: 0,
            lastResponseEndAt: null,
            errored: null,
            serverEndAt: null,
            peerFinAt: null,
            drainArmed: false,
            backstopAt: null,
            ended: false,
            secured: !(socket instanceof tls.TLSSocket),
            paired: null,
            lingerBackstopAt: null,
        };
        connRecords.set(socket, rec);
        if (socket instanceof tls.TLSSocket) {
            socket.once("secure", () => { rec.secured = true; });
            // doMitm stamps the raw TCP leg onto the TLS socket; pair the two
            // ledger records (raw leg always arrives first — real accept) so
            // each leg's close classifies with knowledge of the other.
            const rawLeg = (socket as unknown as Record<string, unknown>)[MITM_RAW_SOCKET_KEY] as net.Socket | undefined;
            const rawRec = rawLeg ? connRecords.get(rawLeg) : undefined;
            if (rawRec) {
                rec.paired = rawRec;
                rawRec.paired = rec;
            }
        }
        // prefinish fires when end() fully flushes — never on destroy(). That
        // makes it the reliable "server-initiated close" marker without patching
        // the socket object. performance.now() (µs) rather than Date.now():
        // both sides routinely close within the same millisecond — the receiver
        // of a FIN reacts by ending its own side — so only sub-ms resolution
        // preserves the causal order that decides who initiated (#1452).
        // Under load the clock's effective resolution can coarsen below the
        // end→prefinish gap, so both markers may come out EQUAL. Every
        // post-response prefinish producer is causally downstream of the peer
        // FIN read (socketOnEnd → end()), so a tie means peer-fin-first or
        // indistinguishable from it — classified as peer-fin via `<=` below
        // (a strict `<` mislabeled these as server-end, #1562).
        socket.on("prefinish", () => { rec.serverEndAt = performance.now(); });
        socket.on("end", () => { rec.peerFinAt = performance.now(); });
        socket.on("error", (err) => {
            const code = (err as NodeJS.ErrnoException).code;
            rec.errored = code ?? err.message;
        });
        socket.on("close", () => {
            connRecords.delete(socket);
            const now = Date.now();
            // Node's keep-alive reaper destroys() idle sockets — no prefinish,
            // no end (measured on v22: the server side sees only close, the
            // peer gets a clean FIN). So idle-timeout keys off the response
            // budget rather than the end marker; the requests>0 guard keeps
            // request-less closes out (the reaper only arms post-response).
            const idleForBudget = rec.requests > 0 && rec.lastResponseEndAt !== null && now - rec.lastResponseEndAt >= keepAliveTimeoutMs;
            // #1982: the raw TCP leg of a MITM connection is structurally
            // destroyed by Node's TLSWrap.close() even when the TLS leg closed
            // fully gracefully — classify it by what its PAIRED tls leg did
            // instead of reporting a false abortive "destroyed".
            const pairedClean = rec.paired !== null && rec.paired.secured && rec.paired.errored === null && rec.paired.lingerBackstopAt === null;
            const reason = rec.backstopAt !== null
                ? "clienterror-backstop"
                : rec.lingerBackstopAt !== null
                    ? "linger-backstop"
                    : rec.errored
                        ? `error(${rec.errored})`
                        : rec.kind === "tcp" && rec.paired !== null
                            ? (pairedClean ? "paired-clean" : "destroyed")
                            : rec.peerFinAt !== null && (rec.serverEndAt === null || rec.peerFinAt <= rec.serverEndAt)
                                ? "peer-fin"
                                : idleForBudget
                                    ? "idle-timeout"
                                    : rec.serverEndAt !== null
                                        ? "server-end"
                                        : "destroyed";
            // #1982: a bare "destroyed" means nobody ended the socket and no
            // other marker explains the close — the fd went away possibly with
            // bytes still in flight, i.e. the peer may have seen RST/ECONNRESET.
            // Elevate to warn (was debug) so a downstream "RST at T" report
            // reconciles against this line directly (#1982 request 2); every
            // intentional path carries its own dedicated marker above.
            if (reason === "destroyed") {
                log("warn", `[conn#${rec.id}] ${rec.kind} closed reason=destroyed age=${now - rec.openedAt}ms reqs=${rec.requests} [ABORTIVE — peer may see RST/ECONNRESET]`);
            } else {
                log("debug", `[conn#${rec.id}] ${rec.kind} closed reason=${reason} age=${now - rec.openedAt}ms reqs=${rec.requests}`);
            }
        });
        installPostResponseLinger(socket, rec);
    });
    // #1452: Node's default client-error disposition (no listener) writes a
    // bare `HTTP/1.1 400 Bad Request` / Connection: close reply and then
    // destroys the socket (measured Linux/Node 25). Depending on platform
    // and residual kernel recv-buffer state, that destroy surfaces as RST
    // (peer reads ECONNRESET — the #1452 incident signature) or strands the
    // peer's pooled connection with neither FIN nor RST ever (verified
    // matrix; Node 22/Linux measures as the strand case). We replace all of
    // it with drain-then-end: an immediate clean FIN, never destroy a
    // data-bearing socket. Wire delta vs Node default: a malformed request
    // gets a FIN instead of a 400 — intentional (unparseable input; PR
    // #1528 discloses it). One handler covers both plain TCP and MITM TLS
    // legs: the MITM socket enters through this same server instance.
    server.on("clientError", (err, socket) => {
        if (socket.destroyed) return;
        // Further parse failures on the same socket must not stack listeners
        // or timers — the first disposition owns the socket (#1529).
        const rec = socket instanceof net.Socket ? connRecords.get(socket) : undefined;
        if (rec?.drainArmed) return;
        if (rec) rec.drainArmed = true;
        log("warn", `[conn] clientError: ${err.message} — draining then closing`);
        socket.on("error", () => {});
        socket.resume();
        socket.once("end", () => socket.end());
        const bail = setTimeout(() => {
            if (socket.destroyed || socket.writableEnded) return;
            socket.end();
            // #1529: a peer that never FINs after our end() holds the socket
            // half-open on our side indefinitely — the kat reaper keys off
            // completed responses and Node enables no SO_KEEPALIVE. Terminal
            // backstop: resume() has drained the recv buffer for the whole
            // window, so the destroy carries no unread residual bytes and
            // cannot surface as the #1452 RST signature.
            if (clientErrorBackstopMs > 0) {
                const backstop = setTimeout(() => {
                    if (socket.destroyed || socket.readableEnded) return;
                    if (rec) {
                        rec.backstopAt = performance.now();
                        log("warn", `[conn#${rec.id}] clientError backstop: no peer FIN ${clientErrorBackstopMs}ms after drain-end — destroying`);
                    } else {
                        log("warn", `[conn] clientError backstop: no peer FIN ${clientErrorBackstopMs}ms after drain-end — destroying`);
                    }
                    socket.destroy();
                }, clientErrorBackstopMs);
                backstop.unref?.();
            }
        }, 300);
        bail.unref?.();
    });
    // #1452: long-lived-process exposure telemetry — both incidents died
    // inside one 36.7h process while fresh processes stayed clean under
    // higher load; fd/connection-table drift was unfalsifiable without
    // periodic ground truth. One info line per interval, zero payload.
    const exposureIntervalMs = knobExposureLogIntervalMs();
    if (exposureIntervalMs > 0) {
        const exposureStartedAt = Date.now();
        const exposureTimer = setInterval(() => {
            const handles = process.getActiveResourcesInfo();
            const tcpHandles = handles.reduce((n, h) => n + (h === "TCPWrap" || h === "TLSSocket" ? 1 : 0), 0);
            log("info", `[exposure] uptime=${Math.round(((Date.now() - exposureStartedAt) / 3_600_000) * 10) / 10}h liveConns=${connRecords.size} tcpHandles=${tcpHandles} handles=${handles.length} sessions=${listSessions().length} blindTunnels=${liveBlindTunnels()} inFlight=${totalInFlight()}`);
        }, exposureIntervalMs);
        exposureTimer.unref?.();
    }
    setMaskHostsEnabled(opts.maskHosts ?? true);
    if (opts.mitm.enabled) {
        // Non-loopback bind (--host 0.0.0.0 / LAN IP) opts into serving
        // remote clients: CONNECT is then allowed for non-loopback clients
        // (whitelisted model hosts only — see setupMitm). Loopback binds
        // keep the strict loopback-only CONNECT gate (#240).
        const allowRemoteConnect = opts.host === "0.0.0.0" || opts.host === "::" || !isLoopbackAddress(opts.host);
        // #1012: blind tunnels are client AUX traffic (MCP/web), not model
        // egress — they resolve with the aux fallback so the launcher-forwarded
        // user proxy (BILI_INHERITED_*) applies here and ONLY here; the model
        // paths below keep the clean-env direct semantics (e1c6c92).
        setupMitm(server, opts.mitm.domains, (msg) => log("info", msg), (host) => resolveProxy(opts.routes, opts.proxy, `https://${host}`, opts.auxProxyFallback ?? opts.proxyFallback), allowRemoteConnect);
    }
    // Launcher mode handshake (#407): the child self-binds and retries on
    // EADDRINUSE instead of dying, reporting the real origin via the instance
    // file (launchToken match). Manual `bili start` keeps fail-fast semantics.
    // #964: BILI_STRICT_PORT (claude SessionStart hook) opts OUT of the retry
    // — the native posture dials a static baked-in URL, so a port-hop
    // "success" would strand every model request on the dead original port.
    const launchToken = process.env.BILI_LAUNCH_TOKEN?.trim();
    const strictPort = process.env.BILI_STRICT_PORT === "1";
    // #1225: lane identity + code fingerprint recorded into the instance file
    // so later launches can decide reuse by WHO started us and WHICH code we
    // run — not just config shape (same-version stale dist kept serving after
    // a rebuild; different clients cross-wrote one shared proxy).
    const launcherLane = process.env.BILI_LAUNCHER_LANE?.trim() || undefined;
    const ownFingerprint = entryScriptFingerprint(process.argv[1]);
    const MAX_LISTEN_ATTEMPTS = 17;
    let listenAttempts = 0;
    let lastTriedPort = opts.port;
    // #1723 (#1660 follow-up): the upgrade-restart overlap. The launcher spawns
    // this child while the OLD build's instance of the same lane is still
    // draining (its host is exiting; the flush frees the port within seconds).
    // Laddering +1 there is what ratchets the sticky port up one slot per
    // auto-update forever. When EADDRINUSE hits a port held by a same-lane
    // predecessor running DIFFERENT code, rebind the SAME port on a tick until
    // it releases — bounded, so a holder that never leaves falls through to
    // the plain ladder (today's behavior) after the budget is spent.
    const PREDECESSOR_WAIT_TICKS = 10;
    const PREDECESSOR_WAIT_MS = 500;
    let predecessorTicksLeft = PREDECESSOR_WAIT_TICKS;
    let predecessorWaitAnnounced = false;
    const sameLanePredecessorHolds = (port: number): boolean => {
        const pred = findSameLanePredecessor(listInstances(), port, launcherLane, ownFingerprint);
        if (pred && !predecessorWaitAnnounced) {
            predecessorWaitAnnounced = true;
            log("warn", `port ${port} held by a same-lane predecessor (pid ${pred.pid}, different build) — waiting up to ${Math.round((PREDECESSOR_WAIT_TICKS * PREDECESSOR_WAIT_MS) / 1000)}s for it to release instead of drifting`);
        }
        return pred !== undefined;
    };
    const announceListening = (): void => {
        const actualPort = server.address() === null ? opts.port : (server.address() as { port: number }).port;
        const nonLoopbackBind = opts.host === "0.0.0.0" || opts.host === "::" || !isLoopbackAddress(opts.host);
        // Honest bind display: a wildcard bind shows as 0.0.0.0 (the user
        // chose to expose the proxy — hiding it behind "localhost" made
        // remote setups look broken in the log, see #240).
        const displayHost = nonLoopbackBind ? opts.host : opts.host === "0.0.0.0" ? "localhost" : opts.host;
        // Discovery origin local MCP shells dial: collapse wildcard
        // binds to loopback (localhost may resolve to ::1, where an
        // IPv4-only listener is absent) and bracket bare IPv6 literals
        // so the file always holds a valid URL.
        const originHost = opts.host === "0.0.0.0" || opts.host === "::" || opts.host === "localhost" ? "127.0.0.1" : opts.host.includes(":") && !opts.host.startsWith("[") ? `[${opts.host}]` : opts.host;
        const origin = `http://${originHost}:${actualPort}`;
        const instanceRecord: ProxyInstanceFile = {
            origin,
            instanceId,
            pid: process.pid,
            startedAt: instanceStartedAt,
            host: opts.host,
            port: actualPort,
            passthrough: opts.passthrough,
            mitmDomains: opts.mitm.enabled ? opts.mitm.domains : [],
            modelWindows: { ...LAUNCHER_MODEL_WINDOWS },
            modelMaxOutputs: Object.keys(LAUNCHER_MODEL_MAX_OUTPUTS).length > 0 ? { ...LAUNCHER_MODEL_MAX_OUTPUTS } : undefined,
            launchToken: launchToken || undefined,
            lane: launcherLane,
            codeFingerprint: ownFingerprint,
        };
        try {
            fs.mkdirSync(stateDir(), { recursive: true });
            // #2265: simhash chain-alignment adoption (identity ladder rung 2)
            //  — on by default; affinitySimhash: false / BILI_AFFINITY_SIMHASH=0
            //  restores the pre-#2265 exact-hash-only resolution (hot kill-switch).
            setSimhashAdoptionEnabled(opts.affinitySimhash ?? true);
            hydratePrefixAffinity();
            atomicWriteInstanceFile(instanceRecord);
        } catch {
            // best-effort discovery hint for host-spawned MCP shells
        }
        // #1232: the registry marker carries the same identity (minus the
        // launcher-private launchToken) so lane-aware attach discovery and
        // the #394 warning can reason about EVERY live instance — the single
        // proxy-origin file only reflects the last writer.
        const registryRecord = { ...instanceRecord };
        delete registryRecord.launchToken;
        const warnedAtRegistration = registerInstanceAndWarn(registryRecord, (msg) => log("warn", `[instances] ${msg}`));
        // #2401: registration warns the late starter only — a resident that is
        // ALREADY serving stays blind to a peer appearing later (the exact
        // dual-generation shape behind the stale-serving report). Rescan the
        // liveness registry on a slow unref'd tick; warn once per peer.
        {
            const warnedPeers = new Set<string>(warnedAtRegistration);
            const peerRescanMs = 60_000;
            const peerTimer = setInterval(() => {
                for (const id of warnOnNewPeers({ instanceId, lane: launcherLane }, warnedPeers, (msg) => log("warn", `[instances] ${msg}`))) {
                    warnedPeers.add(id);
                }
            }, peerRescanMs);
            peerTimer.unref?.();
        }
        const nOverrides = Object.keys(opts.routes).length;
        log(
            "info",
            `acp-proxy v${VERSION} listening on http://${displayHost}:${actualPort}` +
                ` — web UI: http://${displayHost}:${actualPort}/__bili/` +
                ` — zero-config: prefix any baseURL with http://${displayHost}:${actualPort}/bili/` +
                (nOverrides ? ` — context overrides for ${nOverrides} upstream URL(s)` : "")
                + (opts.mitm.enabled ? ` — MITM proxy on (whitelist)${opts.mitm.domains.length ? ` +${opts.mitm.domains.join(",")}` : ""}` : "")
                + (opts.passthrough ? " — PASSTHROUGH (compression OFF)" : ""),
        );
        if (opts.passthrough) {
            log(
                "warn",
                `[passthrough] compression is OFF — every request is forwarded verbatim, no tokens are saved ` +
                    `(source: ${opts.passthroughSource === "env" ? "ACP_PASSTHROUGH env var or --passthrough flag" : `config file ${configFile()}`}). ` +
                    (opts.passthroughSource === "env"
                        ? "Unset ACP_PASSTHROUGH (or drop --passthrough) and restart to re-enable compression."
                        : "Clear it in the web UI (概览 page) or remove \"passthrough\": true from the config file to re-enable compression."),
            );
        }
        // #2090 plan A: signed requests refused earlier that the user has not
        // configured away yet — surface them at EVERY startup, not only at
        // the next failure, with the exact opt-in line.
        {
            const unresolved = unresolvedRefusals();
            const entries = Object.entries(unresolved);
            if (entries.length > 0) {
                const list = entries.map(([scheme, e]) => `${scheme} (${e.origin}${e.count > 1 ? `, ${e.count}× since ${e.firstSeen.slice(0, 10)}` : ""})`).join("; ");
                log(
                    "warn",
                    `[resign] ${entries.length} signed request scheme(s) were refused earlier and remain UNRESOLVED: ${list}. ` +
                        `Per the compress-or-refuse contract they stay refused until bili ships a re-signer for each of them — no configuration can pass a signed body through unsigned. Also listed in the web UI: http://${displayHost}:${actualPort}/__bili/ (Configuration → Signed upstreams). ` +
                        "Set resign[\"<scheme>\"].enabled=false / BILI_RESIGN=0 only if you accept the upstream rejecting rewritten bodies.",
                );
            }
        }
        // #1723: residual zone drift is now an exception, not the norm — a
        // lane'd launch landing ABOVE its preferred port means that port was
        // held by something we must not wait on (foreign squatter, same-code
        // peer). Clients pinned to the old port (lane wrappers, firewall
        // rules, docs) point at air until they re-resolve; say so loudly.
        if (launcherLane && actualPort > opts.port) {
            log("warn", `[zone] lane "${launcherLane}" drifted ${opts.port} → ${actualPort} — the preferred port is still occupied by something else; anything pinned to ${opts.port} must re-resolve`);
        }
        const envKnobs: string[] = [];
        if (process.env.ACP_PASSTHROUGH !== undefined) envKnobs.push(`ACP_PASSTHROUGH=${process.env.ACP_PASSTHROUGH}`);
        if (process.env.ACP_MODEL_CONTEXT_LIMIT !== undefined) envKnobs.push(`ACP_MODEL_CONTEXT_LIMIT=${process.env.ACP_MODEL_CONTEXT_LIMIT}`);
        if (process.env.ACP_COMPRESS_TOOL !== undefined) envKnobs.push(`ACP_COMPRESS_TOOL=${process.env.ACP_COMPRESS_TOOL}`);
        if (process.env.ACP_COMPRESS_NUDGE !== undefined) envKnobs.push(`ACP_COMPRESS_NUDGE=${process.env.ACP_COMPRESS_NUDGE}`);
        if (process.env.BILI_PERSIST !== undefined) envKnobs.push(`BILI_PERSIST=${process.env.BILI_PERSIST}`);
        if (envKnobs.length > 0) {
            log("info", `[config] env overrides active (win over the config file): ${envKnobs.join(", ")}`);
        }
        if (nonLoopbackBind) {
            log(
                "warn",
                `[security] bound to ${opts.host} — proxy endpoints (/bili/, CONNECT for whitelisted model hosts) are reachable from the network with NO authentication; /__bili/ management endpoints stay loopback-only. Restrict access with a firewall on untrusted networks. Remote agents: point baseURL at http://<this-host>:${actualPort}/bili/`,
            );
        }
        if (opts.debug) {
            log("info", `[debug] build features: raw-HTTP-capture(${bodyDumpEnabled() ? "on" : "off"}) | remote_compaction_v2-strip(on) | cert-MITM-launcher(on) | strip-acp-summary(on) — seeing this line confirms the launcher build (not registry 0.1.34)`);
        }
    };
    const attemptListen = (port: number): void => {
        lastTriedPort = port;
        server.listen(port, opts.host, announceListening);
    };
    attemptListen(opts.port);
    // Listen errors (EADDRINUSE port taken, EACCES privileged port, EAFNOSUPPORT
    // bad host) surface as an 'error' event on the server. Without a listener
    // Node treats it as an unhandled 'error' and throws, aborting before the
    // graceful-shutdown flush can run. Catch, log a human-readable message,
    // flush sessions, and exit cleanly (exit code 1 so callers/scripts notice).
    server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && launchToken && !strictPort && listenAttempts < MAX_LISTEN_ATTEMPTS) {
            if (predecessorTicksLeft > 0 && sameLanePredecessorHolds(lastTriedPort)) {
                predecessorTicksLeft -= 1;
                setTimeout(() => attemptListen(lastTriedPort), PREDECESSOR_WAIT_MS);
                return;
            }
            listenAttempts += 1;
            const next = listenAttempts === MAX_LISTEN_ATTEMPTS ? 0 : lastTriedPort + 1;
            log("warn", `port ${lastTriedPort} busy — ${next === 0 ? "retrying on an ephemeral port" : `retrying on port ${next}`}`);
            attemptListen(next);
            return;
        }
        const hint =
            err.code === "EADDRINUSE"
                ? strictPort
                    ? ` — port ${lastTriedPort} is pinned (strict-port mode) but already in use. Free it or point the client at another port (e.g. BILI_CLAUDE_NATIVE_PORT for the claude native posture).`
                    : ` — port ${lastTriedPort} is already in use. Stop the other process or use --port <N>.`
                : err.code === "EACCES"
                  ? ` — port ${lastTriedPort} requires privileges. Use a port >= 1024.`
                  : "";
        log("error", `listen failed: ${err.code ?? ""} ${err.message}${hint}`);
        shuttingDown = true;
        server.close();
        flushConversations();
        void flushAllSessions().finally(() => {
            closeLogger();
            process.exit(1);
        });
    });
    // Catch stray rejections/throws from background work (compress loops,
    // auto-update, initSessions) that escape the per-request try/catch —
    // Node 20+ aborts the process on these by default. Log loudly and flush.
    let suppressedWriteErrors = 0;
    let suppressedRaceErrors = 0;
    process.on("uncaughtException", (err) => {
        if (isStreamWriteError(err)) {
            // Belt-and-suspenders for #1233: the logger's own stderr path is
            // guarded and never reaches here; a stream-write error that does
            // comes from some other writer hitting a dead stream. Log the
            // first, drop the rest — logging a storm through the logger would
            // only feed it.
            if (suppressedWriteErrors === 0) {
                log("error", `uncaughtException (stream-write; suppressing repeats): ${String(err?.stack ?? err)}`);
            }
            suppressedWriteErrors += 1;
            return;
        }
        if (isBenignSocketRaceError(err)) {
            // #1574: keep-alive/idle-cleanup race reaching an already-closed
            // socket — triage-verified benign (touches no live resource), so
            // it must not masquerade as a real error. First at debug level,
            // repeats counted away, mirroring the stream-write branch above.
            if (suppressedRaceErrors === 0) {
                log("debug", `uncaughtException (benign socket race #1574; suppressing repeats): ${String(err?.stack ?? err)}`);
            }
            suppressedRaceErrors += 1;
            return;
        }
        log("error", `uncaughtException: ${String(err?.stack ?? err)}`);
    });
    process.on("unhandledRejection", (reason) => {
        log("error", `unhandledRejection: ${String(reason)}`);
    });
    // Graceful shutdown: flush all dirty sessions to disk so a restart does
    // not lose recent compression state. SIGKILL/power loss cannot flush, but
    // debounced writes keep disk within ~500ms of in-memory state.
    let shuttingDown = false;
    const finishShutdown = (): void => {
        flushPrefixAffinity();
        clearProxyInstanceFile(instanceId);
        unregisterInstance(instanceId);
        closeLogger();
        process.exit(0);
    };
    const shutdown = (sig: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log("info", `${sig} received — flushing sessions…`);
        // Stop accepting new requests BEFORE flushing, otherwise a late request
        // could mutate state after its snapshot is taken and be lost.
        // server.close(cb) waits for all keep-alive connections to drain
        // before invoking cb, so in-flight SSE streams get a chance to finish
        // rather than being yanked mid-chunk.
        server.close(() => {
            flushConversations();
            void flushAllSessions().finally(finishShutdown);
        });
        // Hard fallback: if connections hang (client never closes), don't
        // block shutdown forever — force-exit after a grace window.
        setTimeout(() => {
            log("warn", `shutdown grace window elapsed; forcing exit (liveConns=${connRecords.size})`);
            flushConversations();
            void flushAllSessions().finally(finishShutdown);
        }, 10_000).unref?.();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    // Windows never delivers SIGTERM (Node can listen but the kernel won't
    // raise it). Ctrl+Break (and most service managers / `taskkill` / NSSM)
    // raise SIGBREAK, so hook it to the same graceful-shutdown path there.
    if (process.platform === "win32") {
        process.on("SIGBREAK", () => shutdown("SIGBREAK"));
    }
    // Launcher children have no console and TerminateProcess leaves no room
    // for a flush (#414): they watch the launcher pid and run the graceful
    // path themselves when it disappears (≤2s after the parent exits).
    // #7: the watch is a SET — attached sessions register their host via
    // POST /__bili/watcher — so shutdown fires only when every owner is
    // gone. The empty set must persist through WATCHER_IDLE_GRACE_MS first:
    // a spawner that exits right after a second session launches would
    // otherwise kill the proxy before the attacher's registration lands
    // (observed live: spawner died 1s into the second session). A single-
    // owner proxy still reports the historical `parent-gone (pid N)` reason;
    // multi-owner deaths log `watchers-gone`.
    if (initialWatcherPid !== null) {
        let idleSince: number | null = null;
        let lastDead: number[] = [];
        const watcher = setInterval(() => {
            const dead: number[] = [];
            for (const pid of proxyWatchers) {
                if (!isPidAlive(pid)) {
                    proxyWatchers.delete(pid);
                    dead.push(pid);
                }
            }
            if (dead.length > 0) lastDead = dead;
            if (proxyWatchers.size > 0) {
                idleSince = null;
                return;
            }
            if (idleSince === null) {
                idleSince = Date.now();
                return;
            }
            if (Date.now() - idleSince >= WATCHER_IDLE_GRACE_MS) {
                const reason = lastDead.length === 1 && lastDead[0] === initialWatcherPid ? `parent-gone (pid ${lastDead[0]})` : `watchers-gone (pids: ${lastDead.join(", ")})`;
                shutdown(reason);
            }
        }, 2_000);
        watcher.unref?.();
    }
    return server;
}

export type Prepared = {
    body: string | Buffer;
    session: Session;
    processedMessages: CoreMessage[];
    /** Original CoreMessages from the protocol conversion, BEFORE processTurn
     *  folded/replaced anything. compress/decompress/acp_status need the raw
     *  text (collectBlockContent reads message text by id); processedMessages
     *  has compressed messages replaced with placeholders → empty content. */
    originalMessages: CoreMessage[];
    protocol: WireProtocol;
    stream: boolean;
    compressInjected: boolean;
    /** True when the session is driven by a cooperative agent-side plugin
     *  (x-bili-plugin header, see src/plugin.ts): tools are native, the
     *  response must pass through verbatim, and usage is sniffed instead of
     *  captured by the compress loop. */
    pluginMode?: boolean;
    responsesTextProtocol?: boolean;
    resetAfterSuccess?: boolean;
    responsesProjection?: ResponsesProjection;
    anthropicSystem?: AnthropicRequestBody["system"];
    /** #2189: the client's billing-attribution block captured from the INBOUND
     *  anthropic system (pre-anchor). Preflight summary calls must carry it —
     *  subscription-OAuth upstreams answer calls lacking it with 429
     *  rate_limit_error "Error" (#2189). See extractBillingAttributionBlock. */
    anthropicBillingBlock?: { type: "text"; text: string };
    anthropicCacheMarks?: Map<string, { type: "ephemeral" }>;
    /** #2499: the client's own harvested message-level cache_control breakpoints
     *  (keyed by content-hash id), returned verbatim by the steady path. The
     *  round-2 rebuild applies `anthropicCacheMarks ?? anthropicClientCacheControls`
     *  exactly like the steady path — a client-managed session (no bili marks)
     *  must re-stamp its own breakpoint on the trigger turn or the post-fold
     *  prefix is never written to the prefix cache. */
    anthropicClientCacheControls?: Map<string, unknown>;
    /** Original leading system/developer prefix text captured by the kernel's
     *  openai hoist (0.0.37). The fold space no longer carries it, so every
     *  rebuilt payload and compress-loop round must re-inject it. */
    openaiSystemText?: string;
    /** Google wire: the client's own `systemInstruction` text (the kernel hoists
     *  it out of the fold space) and the path-derived model. Both are needed to
     *  rebuild `systemInstruction` and to synthesize chunks on every compress
     *  loop round. */
    google?: { system?: string; model?: string };
    /** #1085: stable-system-anchor update notes for this turn — re-injected
     *  as trailing user messages so compress-loop rounds see the same
     *  updated-instructions context the main request did. */
    systemNotes?: string[];
    /** [#1343] Plugin-lane retrievals snapshotted onto THIS request's body.
     *  Carried so forward() commits them on upstream success or drops them
     *  (logged + corrective note) on failure — the ack is already out, so the
     *  full text must never vanish silently. */
    attachedRetrievals?: PendingRetrieval[];
    /** [#1457] ids of the corrective notes snapshotted onto THIS request's body.
     *  Committed ONLY when upstream accepts (2xx); on any failure they stay
     *  pending for the next request — a note must never be consumed before the
     *  correction actually reaches the model. */
    attachedRetrievalNoteIds?: string[];
    nudge?: NudgeDecision;
    /** Render strategy the prepare used for processTurn ("none" for codex
     *  compaction triggers / ACP_RENDER_NONE). The #422 fold-refresh hook in
     *  forward() re-runs processTurn with the same strategy so the re-request
     *  renders tags exactly like the request that produced it. */
    renderTags?: "text-only" | "none";
    /** [#1592] The exact reasoning-drop closure this wire's steady path applied
     *  (prepareAnthropic/prepareOpenai/prepareResponses capture theirs; google
     *  serializes thinking itself and leaves it unset). refreshFolded must
     *  apply the SAME drop the steady path used, or the folded re-request and
     *  the next client turn render one history with two shapes (mid-history
     *  byte-prefix break on every fold). */
    dropReasoning?: (msgs: BiliMessage[]) => BiliMessage[];
     /** Effective compression prompts for this request (three-level cascade,
      *  defaults to the kernel's defaultPrompts). Carried so the compress loop
      *  in forward() rebuilds the SAME system prompt the request was prepared
      *  with. */
    prompts?: Prompts;
    /** Effective pack surface (promptPack) for this request: tool prompts,
      *  system-prompt sections, nudge sections. Same carrying rationale as
      *  prompts — the compress loop must rebuild the identical surface. */
    surface?: PackSurface;
    /** #388: side request (title-gen etc.) — transport with render-tag strip
     *  only. Skips preflight (handle() returns before it), the fake-completion
     *  retry wrapper, the compress loop, and every usage-sniffing pipe; the
     *  #460 strip pipes in forward() run with session=undefined. */
    sidePassthrough?: boolean;
    /** Set when a codex native-compaction request was intercepted and a
     *  success response was forged locally (BILI_CODEX_COMPACT=intercept +
     *  gate passed). forward() serves `body` without contacting upstream. */
    codexForge?: { kind: "endpoint" | "trigger"; body: string; contentType: string };
};


// #767/#1843: per-request image billing mode — env BILI_IMAGE_BILLING (live)
// wins over the per-provider route entry, which wins over the global config
// level; "auto"/unset resolves to pixels for every host (#1843 L2). Every
// payload-size decision below consults this so one over-estimate cannot block
// all of them at once.
export function imageBillingFor(opts: ProxyOptions, upstreamUrl: string | undefined): ResolvedImageBilling {
    const env = process.env.BILI_IMAGE_BILLING;
    const configured = env === "pixels" || env === "bytes" ? env : findRoute(opts.routes, upstreamUrl)?.imageBilling ?? opts.imageBilling ?? "auto";
    return resolveImageBilling(configured, upstreamUrl);
}

// #1843 L3: per-request per-image token ceiling — per-route imageTokenCap wins
// over the global config level; env BILI_IMAGE_TOKEN_CAP wins over both (the
// env tier is applied inside image-tokens.ts so callers only resolve config).
// 0 = no cap.
export function imageTokenCapFor(opts: ProxyOptions, upstreamUrl: string | undefined): number {
    return findRoute(opts.routes, upstreamUrl)?.imageTokenCap ?? opts.imageTokenCap ?? 0;
}

// #1884: per-provider, per-scheme re-sign policy — the matched route
// entry's `resign["<scheme>"]` block (level 2) wins per-field over the
// global `resign` root, env over both, the same cascade family as
// imageBillingFor. Resolved AFTER routing so the provider (and its model
// filter) is known before the re-sign action runs — the repo's route-first
// ordering, not action-first-then-filter. `scheme` is the request's own
// Authorization scheme, so passthrough/refusal is pinned to exactly the
// signature on the wire. Host-side consumers (native intercept, dsh lane)
// run pre-route and keep the root cascade.
export function resignSettingsFor(opts: ProxyOptions, upstreamUrl: string | undefined, scheme: string = APIG_RESIGN_SCHEME): ResignSettings {
    return resolveResignSettings(process.env, findRoute(opts.routes, upstreamUrl)?.resign, scheme);
}

// #1843 L1: the IMAGE-channel reserve for a payload — the prior-based estimate
// (pixels/bytes per the resolved billing + cap) upgraded to LEARNED truth when
// this session holds fresh usage-learned evidence for this route (per-image
// cost x current image count), else the prior unchanged. Every window gate
// consumes its image mass through here so one learning layer serves them all.
export function imageReserveFor(
    session: Session,
    protocol: "anthropic" | "openai" | "responses" | "google",
    body: unknown,
    opts: ProxyOptions,
    upstreamUrl: string | undefined,
): number {
    const billing = imageBillingFor(opts, upstreamUrl);
    const cap = imageTokenCapFor(opts, upstreamUrl);
    const raw = typeof body === "string" || Buffer.isBuffer(body);
    const prior = raw
        ? imageTokensInRawBody(protocol, body as string | Buffer, billing, cap)
        : imageTokensInParsedBody(protocol, body, billing, cap);
    if (prior <= 0) return prior;
    const nImages = raw ? countImagesInRawBody(protocol, body as string | Buffer) : countImagesInParsedBody(protocol, body);
    if (nImages <= 0) return prior;
    return learnedImageReserve(session, upstreamHost(upstreamUrl), nImages, `${billing}:${cap}`, cap) ?? prior;
}

// #924: one-time-per-model log for the output-budget fallback (request carries
// no budget → configured/registry max output) — same pattern as windowSourceLogged.
export const headroomFallbackLogged = new Set<string>();

// #2096: dedupe the post-reservation effective-window line per model|value —
// the reserved window varies per request (max_tokens), so key on both.
export const headroomEffectiveLogged = new Set<string>();

// #1840: best-known OUTPUT ceiling for the request's model, resolved through
// the SAME source chain (and rank order) the output-headroom fallback uses
// (#955 runtime-info > #971 launcher channel > #924 operator-declared route
// value > #853 models.dev registry, cache-only with bundled-snapshot floor).
// Consumed as the #546/#1665 restore floor in restoreOutputBudget: a poisoned
// or missing high-water must not pin the session to a death-rattle budget when
// ANY source knows the model can do more. One resolution for "this model's
// output ceiling" keeps the reservation and the restore from ever disagreeing.
export function resolveKnownOutputCeiling(
    headers: Record<string, string | string[] | undefined>,
    parsed: Record<string, unknown>,
    routes: ProxyOptions["routes"],
    upstreamUrl: string | undefined,
    sessionHeaderName?: string,
): number | undefined {
    const model = typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model : undefined;
    if (!model) return undefined;
    const agent = pluginAgentHeader(headers);
    const runtimeMax = (pluginHeadersMatchModel(headers, model) ? pluginReportedMaxOutput(headers) : undefined)
        ?? (agent !== undefined
            ? pluginRuntimeInfoFor(agent, model)?.maxOutput
            : pluginRuntimeInfoForConversation(runtimeConversationId(headers, parsed, sessionHeaderName), model)?.maxOutput);
    if (typeof runtimeMax === "number" && runtimeMax > 0) return runtimeMax;
    const launcherMax = launcherMaxOutput(model);
    if (typeof launcherMax === "number" && launcherMax > 0) return launcherMax;
    const cfgOut = resolveConfiguredOutputLimit(routes, upstreamUrl, model);
    if (cfgOut !== undefined && cfgOut > 0) return cfgOut;
    let host: string | undefined;
    try { host = upstreamUrl !== undefined ? new URL(upstreamUrl).host : undefined; } catch { host = undefined; }
    return peekRegistryOutputLimit(model, host);
}

// #7: how long the shared-proxy watchdog stays up after its LAST watcher
// died. Long enough for a second session's registration to land when the
// spawner exits immediately after it starts; short enough that an abandoned
// proxy still disappears promptly.
const WATCHER_IDLE_GRACE_MS = 5_000;


const ACP_TAG_MARK = "\x3cacp ";

// acp-kernel injects an in-place `acp_summary_*` at the compressed range as a
// generic-library fallback. This host strips it ONLY when it is redundant: the
// block's compress tool-call also carries the summary (hideConsumedCompressCalls
// keeps active-block calls), and a mid-stream insertion would shift the upstream
// prefix-cache breakpoint. Blocks created without a tool call (preflight
// compression, src/preflight.ts — #247) have NO other carrier: their anchor is
// the only place the summary reaches the model, so it must survive.
//
// Per mode (see TECHNICAL-NOTES.md "Two compression modes"): in plugin/launcher mode the
// tool call is ALWAYS in the re-sent history (the agent owns compression), so
// this strips every acp_summary and the carrier is the tool call — recognized
// by the plugin_<ts> callId minted at the tool API (#1567: an id-match alone
// was unsatisfiable there); in proxy mode
// the tool call is usually absent (ephemeral server-side execution) or
// nonexistent (preflight), so acp_summary survives as the carrier and
// systemToUser later re-voices the survivors as USER messages (leaving them at
// their anchors) for strict backends (#377).
/** [#651] Strip oversized reasoning from closed compress turns (see
 *  src/reasoning-drop.ts) with an ops log line when anything was dropped. */
export function withReasoningDrop(
    msgs: BiliMessage[],
    reasoning: CompressReasoningConfig | undefined,
    log: (level: string, msg: string) => void,
    sessionId: string,
    strictEcho: boolean,
): BiliMessage[] {
    // [#684] strict-echo upstreams: reasoning must round-trip with tool_calls,
    // so #651's drop must not fire. Learned/static strictness both land here.
    if (strictEcho) return msgs;
    // [#1658] Anthropic-wire twin of that gate, detected from the payload
    // itself: a reasoning message carrying a signature is a SIGNED thinking
    // block on the wire (the kernel stamps thinkingSignature from the wire
    // signature; only the Anthropic codec does), and signed thinking must
    // round-trip with its tool_use sibling or the upstream rejects the pair
    // (#684 invariant). Dropping the pre-compress run would orphan it, so
    // any signed thinking in view disables the drop for this request.
    // Presence-based and per-request: Claude sessions without extended
    // thinking keep #651's savings.
    if (msgs.some((m) => m.contentType === "reasoning" && typeof m.thinkingSignature === "string" && m.thinkingSignature.length > 0)) return msgs;
    const out = dropCompressReasoning(msgs, reasoning);
    if (out.length !== msgs.length) {
        log("info", `[${sessionId}] compress-reasoning: dropped ${msgs.length - out.length} reasoning message(s) from closed compress turns (#651)`);
    }
    return out;
}

/** [#684] Exit sentinel: in a thinking session, an assistant tool_calls
 *  message WITHOUT reasoning_content while sibling turns carry it is the
 *  signature of a split turn — strict-echo upstreams reject the whole request.
 *  The kernel turn gate makes this unreachable; warn if a new path
 *  reintroduces it. [#762] presence, not emptiness: a BLANK echo ("") is what
 *  DeepSeek accepts — counting it as absent fired on every turn of every
 *  healthy thinking session (38× in one). Only a missing field is the
 *  rejection signature. */
export function warnReasoningPairs(
    wireMessages: unknown[],
    log: (level: string, msg: string) => void,
    sessionId: string,
): void {
    let withRc = 0;
    let split = 0;
    for (const m of wireMessages) {
        const msg = m as { role?: string; tool_calls?: unknown; reasoning_content?: unknown };
        if (msg?.role !== "assistant") continue;
        const hasRc = typeof msg.reasoning_content === "string";
        if (hasRc) withRc++;
        else if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) split++;
    }
    if (withRc > 0 && split > 0) {
        log("warn", `[${sessionId}] reasoning-pair-violated: ${split} assistant tool-call message(s) lack reasoning_content while ${withRc} carry it — strict-echo upstreams (DeepSeek thinking mode) will reject the request (#684)`);
    }
}

/** [#684] Anthropic-wire twin of the openai sentinel, narrowed by [#1327]:
 *  warn only when bili itself lost thinking — a tool_use block that rode an
 *  inbound assistant message WITH a thinking block now rides an outbound
 *  assistant message with none. Outbound-only asymmetry (some tool_use turns
 *  think, others don't) is ordinary Claude Code traffic: turns without
 *  extended thinking never carry a block. #651's dropCompressReasoning can no
 *  longer create this shape either — since [#1658] the drop is gated out
 *  whenever signed thinking is in view. Turns match by stable tool_use id
 *  (the kernel codec round-trips it verbatim); benign asymmetry stays fully
 *  silent. Any remaining fire means another path lost thinking (e.g. a fold
 *  pruned the block while preserving the tool_use) — investigate. */
export function warnAnthropicThinkingPairs(
    inboundMessages: unknown[],
    outboundMessages: unknown[],
    log: (level: string, msg: string) => void,
    sessionId: string,
): void {
    const thinkingIds = new Set<string>();
    for (const m of inboundMessages) {
        const msg = m as { role?: string; content?: Array<{ type?: string; id?: string }> };
        if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
        if (!msg.content.some((b) => b?.type === "thinking")) continue;
        for (const b of msg.content) {
            if (b?.type === "tool_use" && typeof b.id === "string") thinkingIds.add(b.id);
        }
    }
    if (thinkingIds.size === 0) return;
    let lost = 0;
    const lostIds: string[] = [];
    for (const m of outboundMessages) {
        const msg = m as { role?: string; content?: Array<{ type?: string; id?: string }> };
        if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
        if (msg.content.some((b) => b?.type === "thinking")) continue;
        for (const b of msg.content) {
            if (b?.type === "tool_use" && typeof b.id === "string" && thinkingIds.has(b.id)) {
                lost++;
                lostIds.push(b.id);
            }
        }
    }
    if (lost > 0) {
        log("warn", `[${sessionId}] thinking-pair-violated: ${lost} tool_use block(s) lost their inbound thinking block in the outbound rebuild (${[...new Set(lostIds)].slice(0, 3).join(", ")}) — a stripped signature pair is rejected by the API (#684)`);
    }
}

/** [#684,#1479] Responses-wire sentinel, run-based: the rejection signature on
 *  strict-echo upstreams is an assistant RUN (maximal consecutive stretch of
 *  reasoning / assistant message / function_call / custom_tool_call items) that
 *  carries a tool call but NO reasoning item. The old immediate-precedence check
 *  reset on every non-reasoning item and flagged every healthy [reasoning,
 *  message, function_call] turn and multi-call run (#1479: 798× in one session's
 *  log, mostly passing requests) — a message between the echo and the calls is
 *  normal run order, not a violation. Names the orphaned call_ids. */
export function warnResponsesReasoningPairs(
    input: unknown[],
    log: (level: string, msg: string) => void,
    sessionId: string,
): void {
    let withReasoning = 0;
    let split = 0;
    let runs = 0;
    const orphans: string[] = [];
    let runCalls = 0;
    let runReasoning = 0;
    let runIds: string[] = [];
    const closeRun = (): void => {
        if (runCalls > 0 && runReasoning === 0) {
            split += runCalls;
            runs++;
            orphans.push(...runIds);
        }
        runCalls = 0;
        runReasoning = 0;
        runIds = [];
    };
    for (const item of input) {
        const it = item as { type?: string; role?: string; call_id?: string };
        const t = it?.type;
        if (t === "reasoning") {
            withReasoning++;
            runReasoning++;
            continue;
        }
        if (t === "function_call" || t === "custom_tool_call") {
            runCalls++;
            if (typeof it.call_id === "string" && it.call_id) runIds.push(it.call_id);
            continue;
        }
        // a call's output belongs to the same assistant turn as the call
        if (t === "function_call_output" || t === "custom_tool_call_output") continue;
        if (t === "message" && it.role === "assistant") continue;
        closeRun();
    }
    closeRun();
    if (withReasoning > 0 && split > 0) {
        const named = orphans.slice(0, 3).join(", ") + (orphans.length > 3 ? `, …+${orphans.length - 3}` : "");
        log("warn", `[${sessionId}] reasoning-pair-violated: ${split} tool-call item(s) in ${runs} assistant run(s) lack any reasoning item while ${withReasoning} exist (${named}) — strict-echo upstreams will reject the request (#684)`);
    }
}

/** Carrier-evidence index for stripKernelSummaries (#2042).
 *
 *  #1567 hardening: a plugin-fold block's in-place anchor is redundant ONLY
 *  while the client's own compress pair for that exact fold actually rides
 *  the (post-prepare) history. The pair is recognized by tool name plus the
 *  folded range quoted in its call args — flat {startId,endId} or
 *  {content:[{startId,endId}]}, both accepted by the plugin tool API. This
 *  restores the self-verifying carrier handoff a raw prefix strip lost: a
 *  pruned or contract-violating client (pair absent) keeps the anchor, so an
 *  active fold never ends up with zero carriers. It also covers kernel-side
 *  pruning: hideConsumedCompressCalls (KEEP_LAST_ORPHANED) runs in the
 *  pipeline BEFORE this strip, so an older pair already hidden from the wire
 *  is absent here and its anchor correctly survives. Unparseable args count
 *  as no match (anchor kept — fail-safe direction). Blocks predating range
 *  recording (no startRef/endRef) degrade to "any compress call present",
 *  the pre-hardening prefix-strip behavior.
 *
 *  #2042: the evidence is collected in ONE pass over the (post-kernel)
 *  history instead of rescanning it per active block (O(B×N) → O(N+B+R)).
 *  It MUST be rebuilt from THIS history on every call — the kernel may have
 *  pruned earlier pairs since prepare, so no pre-prepare cache may be
 *  reused. Compress-call args are parsed lazily (only when an active plugin
 *  block with recorded refs needs exact matching) and each call's args are
 *  parsed at most ONCE, whereas the old per-block scan reparsed them for
 *  every block. */
function buildCarrierIndex(messages: BiliMessage[]): { callIds: Set<string>; compressCalls: BiliMessage[]; ensureRangePairs: () => Map<string, Set<string>> } {
    const callIds = new Set<string>();
    const compressCalls: BiliMessage[] = [];
    for (const m of messages) {
        if (m.contentType !== "tool-call") continue;
        if (m.toolCallId) callIds.add(m.toolCallId);
        if (m.toolName === COMPRESS_TOOL_NAME) compressCalls.push(m);
    }
    let rangePairs: Map<string, Set<string>> | null = null;
    const ensureRangePairs = (): Map<string, Set<string>> => {
        if (!rangePairs) {
            rangePairs = new Map<string, Set<string>>();
            for (const c of compressCalls) {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(c.text ?? "");
                } catch {
                    continue;
                }
                const obj = parsed as { startId?: string; endId?: string; content?: unknown };
                const ranges: Array<{ startId?: string; endId?: string }> = Array.isArray(obj?.content) ? (obj.content as Array<{ startId?: string; endId?: string }>) : [obj];
                for (const r of ranges) {
                    if (typeof r?.startId !== "string" || !r.startId || typeof r?.endId !== "string" || !r.endId) continue;
                    let ends = rangePairs.get(r.startId);
                    if (!ends) { ends = new Set<string>(); rangePairs.set(r.startId, ends); }
                    ends.add(r.endId);
                }
            }
        }
        return rangePairs;
    };
    return { callIds, compressCalls, ensureRangePairs };
}

export function stripKernelSummaries(messages: BiliMessage[], state: CompressionState): BiliMessage[] {
    const { callIds, compressCalls, ensureRangePairs } = buildCarrierIndex(messages);
    const carried = new Set<string>();
    for (const b of state.blocks) {
        if (!b.active || !b.compressCallId) continue;
        // #1567: plugin tool API folds are minted a synthetic plugin_<ts> callId
        // the client can never echo, so the plain id match is unsatisfiable for
        // them — yet the client's own re-sent compress pair IS their carrier by
        // contract, making the in-place anchor redundant. Strip it, but only
        // while that pair actually rides the (post-prepare) history: a pruned
        // or contract-violating client must never lose the summary outright
        // (zero carriers).
        // Preflight blocks (no compressCallId) keep skipping above: no tool
        // call exists for them, so their anchor is the only carrier.
        const present = isPluginFoldCallId(b.compressCallId)
            ? (!b.startRef || !b.endRef ? compressCalls.length > 0 : ensureRangePairs().get(b.startRef)?.has(b.endRef) ?? false)
            : callIds.has(b.compressCallId);
        if (present) {
            carried.add(`acp_summary_${b.blockId}`);
        }
    }
    return messages.filter((m) => !(m.id ?? "").startsWith("acp_summary_") || !carried.has(m.id));
}

// #564: folding + stripKernelSummaries can merge two assistant turns into one
// run, which Responses rejects (run order reasoning* -> message* ->
// function_call*, <=1 reasoning). Rebuild boundaries from the ORIGINAL history
// AFTER dedup: drop a reasoning whose turn body was wholly folded away (keep
// originally-reasoning-only turns), else separate the runs with a user marker.
const RESPONSES_TURN_SEPARATOR = "[The exchange between these two assistant turns was compressed.]";

export function repairResponsesAssistantOrdering(folded: CoreMessage[], original: CoreMessage[]): CoreMessage[] {
    const runOf = new Map<string, number>();
    const runHasBody = new Map<number, boolean>();
    let run = 0;
    let inRun = false;
    for (const m of original) {
        if (m.role === "assistant") {
            if (!inRun) { run++; inRun = true; }
            runOf.set(m.id, run);
            if (m.contentType !== "reasoning") runHasBody.set(run, true);
        } else {
            inRun = false;
        }
    }
    const survivorCount = new Map<number, number>();
    for (const m of folded) {
        const r = m.role === "assistant" ? runOf.get(m.id) : undefined;
        if (r !== undefined) survivorCount.set(r, (survivorCount.get(r) ?? 0) + 1);
    }

    const out: CoreMessage[] = [];
    let phase = -1;
    let seenReasoning = false;
    let sepSeq = 0;
    const pushSeparator = (): void => {
        sepSeq++;
        out.push({ id: `acp_turn_sep_${sepSeq}`, role: "user", contentType: "text", text: RESPONSES_TURN_SEPARATOR });
        phase = -1;
        seenReasoning = false;
    };
    for (const m of folded) {
        if (m.role !== "assistant") {
            out.push(m);
            phase = -1;
            seenReasoning = false;
            continue;
        }
        const kind = m.contentType === "reasoning" ? "reasoning" : m.contentType === "tool-call" ? "tool-call" : "message";
        const r = runOf.get(m.id);
        if (kind === "reasoning" && r !== undefined && runHasBody.get(r) && survivorCount.get(r) === 1) continue;
        if ((kind === "reasoning" && (phase > 0 || seenReasoning)) || (kind === "message" && phase === 2)) pushSeparator();
        out.push(m);
        if (kind === "reasoning") { phase = Math.max(phase, 0); seenReasoning = true; }
        else if (kind === "message") phase = Math.max(phase, 1);
        else phase = Math.max(phase, 2);
    }
    return out;
}

export function diagTagSummary(messages: CoreMessage[], sessionId: string, strategy: string): string {
    let textTagged = 0;
    let toolTagged = 0;
    for (const m of messages) {
        const hasTag = (m.text ?? "").includes(ACP_TAG_MARK);
        if (!hasTag) continue;
        if (m.contentType === "tool-call" || m.contentType === "tool-result") toolTagged++;
        else textTagged++;
    }
    return `[${sessionId}] processTurn: ${messages.length} msgs, renderTags=${strategy}, ${textTagged} text tagged, ${toolTagged} tool tagged (should be 0 with text-only)`;
}

export function diagNudge(turn: { nudge?: { shouldInject: boolean; reason: string; contextUsage: number; tier: number | null; breakdown?: Record<string, number> } | null }, sessionId: string, tokenCount: number, limit: number, model: string | undefined, willInject: boolean): string {
    const n = turn.nudge;
    if (!n) return `[${sessionId}] nudge: unavailable`;
    const b = n.breakdown ?? {};
    const pct = limit > 0 ? `${Math.round((tokenCount / limit) * 100)}%` : "?";
    const growth = b["growth"] ?? 0;
    const floor = b["growthFloor"] ?? 0;
    const interval = b["nudgeGrowthTokens"] ?? 0;
    const pendingT1 = b["pendingT1"] ?? 0;
    const ref = b["growthReference"] ?? 0;
    // "INJECT" only when the nudge actually reaches the upstream payload. When
    // armed but suppressed by config/mode, say so explicitly so the log never
    // lies about delivery (#451, same class as #413).
    const inject = willInject
        ? (n.shouldInject ? `INJECT T${n.tier ?? "?"}` : `INJECT-ESC T${n.tier ?? "?"}`)
        : (n.shouldInject ? `ARMED-SUPPRESSED T${n.tier ?? "?"}` : "idle");
    const modelTag = model ? ` model=${model}` : "";
    return `[${sessionId}] nudge ${inject}: usage=${pct} (${tokenCount}/${limit}), growth=${growth}/${floor} (ref=${ref}, interval=${interval}), pendingT1=${pendingT1}/${interval}${modelTag}, reason="${n.reason.slice(0, 120)}"`;
}

// Zero-baseline sessions are judged conservatively ONLY when they arrived
// anonymously AND hold no usage-grade anchor yet (prefix-affinity
// mints/forks/reloads, #553): they carry the full raw history but no
// measurement yet, so feeding 0 blinds the nudge (usage 0%, growth ref 0)
// and no compression trigger fires until overflow. An anchored anonymous
// session continues a MEASURED lineage — it sizes on the anchor exactly like
// an explicit session (#2033); the raw-history bound remains ONLY for the
// genuinely anchor-less case below. Explicit-identity zero-baseline sessions
// previously stayed at 0 on the assumption
// that they "self-heal via the next measured usage report" — an assumption
// that breaks for upstreams that NEVER report usage (ChatGPT-login backends,
// #728): lastInputTokens stays 0 for the whole session, and the kernel's
// decideNudge is structurally unfireable at tokenCount == 0 (growth ref falls
// back to tokenCount itself → growth ≡ 0; firstSightMassReady/pressure bands
// all require usage >= their pct lines). #728 fix: such sessions fall back to
// the PREVIOUS turn's locally-measured outbound payload upper bound
// (session.stats.localInputEstimate, recorded in prepare* each turn). The
// estimator only errs EARLY (char-count upper bound → compress earlier, never
// later), is active only while lastInputTokens == 0 (a real usage report takes
// precedence immediately — same invariant as #604's armFailureShrink
// exception), and self-corrects after every fold (the post-fold payload
// shrinks → the next estimate drops). Turn 1 of a fresh explicit session
// still feeds 0 (nothing measured yet; nothing pending either), so
// first-turn behavior is byte-identical to pre-#728.
export function effectiveTokenCount(session: Session, msgs: CoreMessage[], inboundImageTokens = 0): { tokens: number; source: "usage" | "estimate" } {
    // #1492: only usage-grade baselines are authoritative sizing inputs. An
    // estimate-sourced value describes ONE turn's outbound — possibly the FULL
    // raw history on an unfolded fallback turn — and pinning the nudge to it
    // misreads a folded ~160K payload as 1.27M for every later failed turn.
    // Fall through to the per-turn local measurements, which track the actual
    // outbound view (post-fold normally, raw when the transform failed).
    // #1839: an overflow arm rides in here too — it is evidence, not billing,
    // but it is bounded by the declared/stated window so it cannot produce
    // the >100% ghost class, and the next real usage report overwrites it.
    if (session.stats.lastInputTokens > 0 && (session.stats.lastInputTokensSource === "usage" || session.stats.lastInputTokensSource === "overflow-arm")) return { tokens: session.stats.lastInputTokens, source: "usage" };
    // #1820: right after a preflight rebuild the usage-grade baseline above is
    // momentarily absent (the rebuild request's own report hasn't landed yet,
    // or the upstream never reports), and every branch below sizes on the
    // INCOMING RAW history — the very mass the rebuild just folded away —
    // inflating the meter ~3.4× (char-count upper bound) and firing a phantom
    // EMERGENCY nudge into an already-at-window context. Decide against the
    // rebuilt payload's measured size instead (same quantity the preflight fit
    // gate checked); setPostRebuildAnchor bounds the lifetime so never-
    // reporting upstreams fall back to legacy sizing rather than a frozen meter.
    const anchored = postRebuildAnchorTokens(session);
    if (anchored > 0) return { tokens: anchored, source: "estimate" };
    const raw = estimateCoreMessagesUpper(msgs) + inboundImageTokens;
    // #1569/#1839: while the latest baseline is not usage-grade (the transient
    // window right after a failed turn), sizing on ANY re-derived view is how
    // ghosts enter: #1569 first tried min(est, raw) — the char-count upper
    // bound, ~3.5× high on code/JSON — then the calibrated estimate of the
    // INBOUND msgs; but msgs is the client's FULL resubmitted history, which
    // carries unfolded raw content that server-side folding/CCR never shrank
    // (#1839: one aborted turn armed 719521 and this branch re-amplified it to
    // 2939167 in the same decision — 20.5× above the real 143419). The only
    // number available without inflation is the last REAL usage report
    // itself. Growth between reports is backstopped by preflight (it measures
    // the actual outbound payload before every forward) and the nudge
    // reference re-anchors as soon as the next usage lands (#1595).
    // #2033: this check runs BEFORE the anonymous-prefix-affinity fallback so
    // an anchored anonymous session (a measured lineage continued through pfa-*
    // resolution) sizes on the anchor too — pre-fix the anonymous early return
    // handed it the full raw-history bound right after one failed turn, the
    // exact ghost path #1839 closed for explicit sessions. Never-reporting
    // upstreams (#553/#728) are unaffected: their anchor stays absent, so the
    // fail-closed upper bounds below still apply.
    const grade = session.stats.lastUsageGradeTokens;
    if (grade !== undefined && grade > 0) return { tokens: grade, source: "usage" };
    // #553: zero-baseline ANCHOR-LESS anonymous sessions (prefix-affinity
    // mints/forks/reloads) fall back to the raw-history upper bound — see the
    // function header for why feeding 0 blinds them.
    if (session.metadata.anonymousPrefixAffinity) return { tokens: raw, source: "estimate" };
    const est = session.stats.localInputEstimate ?? 0;
    if (est <= 0) return { tokens: 0, source: "estimate" };
    return { tokens: Math.min(est, raw), source: "estimate" };
}

/** #1492: secondary processTurn feeds (count-token previews, the codex
 *  forged-compact handoff, the absorb view) must not light the kernel's
 *  emergency bands on an estimate-grade poison — only a usage-grade baseline
 *  describes real billing. 0 reads as "unknown" to the kernel. */
export function usageGradeInputBaseline(session: Session): number {
    return session.stats.lastInputTokensSource === "usage" ? session.stats.lastInputTokens : 0;
}

// #1403: top-level prompt_cache_key is NOT part of the Anthropic Messages API.
// It is the omp plugin's session id stamped for the proxy's identity chain
// (#268); the fully-processed path strips it (prepareAnthropic), but every
// VERBATIM forward branch (side-request passthrough #388, hop-marker chain
// passthrough, bypass/passthrough marks, route/global passthrough #661,
// decode-fail fallback) used to ship the raw buffer through — strict-schema upstreams
// (opencode zen: "prompt_cache_key: Extra inputs are not permitted") 400'd
// the request. Strip on those branches too. A body WITHOUT the field passes
// back byte-identical, so #661's fingerprinting contract is untouched in the
// normal case.
export function scrubAnthropicPck(protocol: WireProtocol | null, bodyBuffer: Buffer, log: (level: string, msg: string) => void): Buffer {
    if (protocol !== "anthropic" || bodyBuffer.length === 0) return bodyBuffer;
    let parsed: unknown;
    try {
        parsed = JSON.parse(bodyBuffer.toString("utf8"));
    } catch {
        return bodyBuffer;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return bodyBuffer;
    const p = parsed as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(p, "prompt_cache_key")) return bodyBuffer;
    delete p.prompt_cache_key;
    log("debug", `stripped prompt_cache_key from verbatim anthropic forward (#1403)`);
    return Buffer.from(JSON.stringify(p), "utf8");
}

// #1757: protocol-neutral companion to scrubAnthropicPck for opt-in
// compat.dropFields — client-fixed fields some strict-schema gateways reject
// (SenseNova Responses 400 'json: unknown field "summary"' on pi-ai's fixed
// reasoning.summary). Structural key deletion only (string leaves such as
// tool-call arguments are never touched); a body with none of the configured
// paths passes back byte-identical, so #661's fingerprinting contract is
// untouched in the normal case (same guarantee as #1403).
export function scrubCompatDrop(bodyBuffer: Buffer, dropPaths: readonly string[], log: (level: string, msg: string) => void): Buffer {
    if (dropPaths.length === 0 || bodyBuffer.length === 0) return bodyBuffer;
    let parsed: unknown;
    try {
        parsed = JSON.parse(bodyBuffer.toString("utf8"));
    } catch {
        return bodyBuffer;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return bodyBuffer;
    const dropped = dropCompatFieldsJson(parsed as Record<string, unknown>, dropPaths);
    if (dropped === 0) return bodyBuffer;
    log("info", `stripped ${dropped} field(s) per compat.dropFields (${dropPaths.join(", ")}) from verbatim forward (#1757)`);
    return Buffer.from(JSON.stringify(parsed), "utf8");
}

export function isCountTokensRequest(method: string, urlPath: string, hasBody: boolean): boolean {
    return (
        method === "POST" &&
        hasBody &&
        !knobCountTokensPassthrough() &&
        (urlPath.endsWith("/messages/count_tokens") || googlePathKind(urlPath) === "count-tokens")
    );
}

export function prepareCountTokens(
    parsed: AnthropicRequestBody,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
    session: Session,
): Prepared {
    const sessionId = session.id;
    try {
        const { msgs, cacheControls } = anthropicToCore(parsed);
        // Read-only preview: same policy as the google twin above.
        const turn = core.processTurn({ messages: msgs, state: session.state, config: ccrLoopConfig(session, config), tokenCount: usageGradeInputBaseline(session), renderTags: knobRenderNone() ? "none" : "text-only", contentStore: contentStoreOf(session) });
        const stripped = stripKernelSummaries(turn.messages as BiliMessage[], turn.state);
        const rebuiltMessages = coreToAnthropic(stripped, cacheControls);
        log("info", `[${sessionId}] count_tokens pruned: ${msgs.length} → ${stripped.length} msgs`);
        const rebuilt: AnthropicRequestBody = { ...parsed, messages: rebuiltMessages };
        delete (rebuilt as Record<string, unknown>).prompt_cache_key;
        return {
            body: JSON.stringify(rebuilt),
            session,
            processedMessages: [],
            originalMessages: msgs,
            protocol: "anthropic",
            stream: false,
            compressInjected: false,
        };
    } catch (err) {
        log("warn", `[${sessionId}] count_tokens prune failed, forwarding unchanged: ${String(err)}`);
        const fallback: AnthropicRequestBody = { ...parsed };
        delete (fallback as Record<string, unknown>).prompt_cache_key;
        return {
            body: JSON.stringify(fallback),
            session,
            processedMessages: [],
            originalMessages: [],
            protocol: "anthropic",
            stream: false,
            compressInjected: false,
        };
    }
}

type ForwardTarget = {
    upstreamUrl: string;
    headers: Record<string, string>;
    proxyUrl: string | undefined;
};

// Log each unique (host, proxy, source) upstream-proxy decision once so the
// proxy choice is visible without per-request spam. Catches the "silent proxy"
// case where an env/system proxy is picked up unexpectedly.
const loggedUpstreamProxyDecisions = new Set<string>();
function logUpstreamProxyDecision(opts: ProxyOptions, upstreamUrl: string | undefined, decision: UpstreamProxyDecision): void {
    if (!upstreamUrl) return;
    let host = upstreamUrl;
    try {
        host = new URL(upstreamUrl).host;
    } catch {
        /* keep the raw url as the key */
    }
    // Dedup key uses the real host (internal, never logged); the log line masks
    // non-public hosts (#255) so a private upstream/proxy address never leaks.
    const key = `${host}|${decision.proxy ?? ""}|${decision.source}`;
    if (loggedUpstreamProxyDecisions.has(key)) return;
    loggedUpstreamProxyDecisions.add(key);
    const via = decision.proxy ? `via ${maskUrlForLog(decision.proxy)}` : "direct";
    logMsg(opts, "info", `[upstream-proxy] ${maskHostPortForLog(host)} ${via} (source=${decision.source})`);
}

// #1757: the destination URL exactly as buildForwardTarget will fetch it.
// Shared by the early verbatim branches, which resolve compat.dropFields
// before reaching forward()'s final-boundary resolution — both sides must
// derive the same URL or per-provider drops would mismatch.
export function forwardUpstreamUrl(req: http.IncomingMessage, opts: ProxyOptions, route: ReturnType<typeof resolveUpstream>): string {
    // route.rewrittenUrl may use a `mitm://` scheme (for config-lookup
    // distinction — see resolveUpstream). fetch needs the real https://
    // scheme, so strip mitm:// back to https:// for the actual upstream request.
    const reqUrl = req.url ?? "";
    const isAbsoluteUrl = /^https?:\/\//i.test(reqUrl);
    const rewritten = route ? route.rewrittenUrl : isAbsoluteUrl ? reqUrl : opts.upstream + reqUrl;
    return rewritten.replace(/^mitm:\/\//, "https://");
}

export function buildForwardTarget(
    req: http.IncomingMessage,
    opts: ProxyOptions,
    route: ReturnType<typeof resolveUpstream>,
    affinity?: string,
    hopMarker?: string,
): ForwardTarget {
    const upstreamUrl = forwardUpstreamUrl(req, opts, route);
    const headers: Record<string, string> = {};
    const reqConnNamed = connectionNamedHeaders(req.headers["connection"]);
    for (const [k, v] of Object.entries(req.headers)) {
        const lower = k.toLowerCase();
        if (UPSTREAM_HOP_HEADERS.has(lower) || reqConnNamed.has(lower) || v === undefined) continue;
        // #1884: loopback re-sign markers are internal to the bili tunnel —
        // they must never reach the upstream (they carry the credential).
        if (lower === APIG_RESIGN_HEADER || lower === APIG_RESIGN_CREDENTIAL_HEADER) continue;
        headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    // #300: stamp the chain marker AFTER copying inbound headers so it wins
    // over any inbound value (only set when this instance processed the
    // request; a passthrough leaves the inbound marker — if any — intact so it
    // keeps propagating down the chain).
    if (hopMarker !== undefined) headers[BILI_HOP_HEADER] = hopMarker;
    // #409: mark every /bili/ absolute-URL forward so a management plane
    // reached through this tunnel (self, NAT hairpin, chained bili) can
    // recognize and reject it — see the admin gate in handle().
    // #1073: exception — loopback peer → loopback IP-literal destination on a
    // management path: any same-machine process can already connect straight
    // to that destination's port, so the marker adds no protection there while
    // it 403s legitimate inter-instance probes (health checks between sibling
    // instances). Remote peers and non-literal hostnames keep the marker
    // unconditionally (NAT-hairpin / DNS-rebinding protection intact).
    if (route?.tunnel) {
        let destLoopback = false;
        let destAdminPath = false;
        try {
            const du = new URL(upstreamUrl);
            const lit = parseIpLiteral(du.hostname.replace(/^\[|\]$/g, ""));
            destLoopback = lit !== null && classifyIp(lit) === "loopback";
            const dp = du.pathname;
            destAdminPath = dp === "/__bili/" || dp.startsWith("/__bili/") || dp === "/__acp/" || dp.startsWith("/__acp/");
        } catch {
            // unparseable upstream URL — stamp defensively
        }
        if (!(isLoopbackAddress(req.socket.remoteAddress) && destLoopback && destAdminPath)) headers[BILI_TUNNEL_HEADER] = "1";
    }
    headers["host"] = new URL(upstreamUrl).host;
    // codex advertises its own server-side context compaction via this beta
    // feature. It conflicts with bili's client-side compress (bili IS the
    // compression layer) and third-party aggregators reject it with
    // "invalid range / ref not found". Strip it so bili's compress is the
    // sole mechanism.
    const betaKey = Object.keys(headers).find((h) => h.toLowerCase() === "x-codex-beta-features");
    if (betaKey) {
        const kept = headers[betaKey]
            .split(",")
            .map((s) => s.trim())
            .filter((f) => f && f !== "remote_compaction_v2");
        if (kept.length > 0) headers[betaKey] = kept.join(",");
        else delete headers[betaKey];
    }
    // Forward a client-provided Responses session identity only when it was
    // carried in the body rather than an existing request header.
    // #2218/#1931: the plugin-protocol header x-bili-plugin-conversation is
    // bili-internal — no third-party upstream can read it — so a plugin host
    // (dsh desktop) whose ONLY identity signal it is would otherwise arrive
    // at a relay with zero usable session signal and lose sticky routing /
    // cache pools (workbuddy hub and sub2api both key off x-session-id).
    // Treat it like "no header": forward the affinity as x-session-id.
    const convSource = conversationHeaderSource(req.headers);
    if (affinity && (!convSource || convSource.name === "x-bili-plugin-conversation")) {
        headers["x-session-id"] = affinity;
    }
    const decision = resolveProxyDecision(opts.routes, opts.proxy, route?.rewrittenUrl ?? upstreamUrl, opts.proxyFallback);
    logUpstreamProxyDecision(opts, upstreamUrl, decision);
    return { upstreamUrl, headers, proxyUrl: decision.proxy };
}

// #2228: model-decided nudge timing — the side-channel decision call. It
// reuses the main request's forward target (same URL/headers/proxy/resign
// arm) so the session's stable prefix lands on the SAME cache line as the
// main turn; only the tail differs (one neutral question, small output
// budget). The answer never enters any history — it only decides whether the
// main request gets a directive or nothing. Timeout-bounded (no client abort
// handle exists at prepare time): a hung decision degrades to "inject
// nothing this round", and repeated hard failures fall back to the legacy
// advisory nudge via the ladder in nudge-decide.ts.
export async function runNudgeDecision(args: {
    req: http.IncomingMessage;
    opts: ProxyOptions;
    protocol: "anthropic" | "openai" | "google" | "responses";
    sideBody: Record<string, unknown>;
    session: Session;
    log: (level: string, msg: string) => void;
}): Promise<DecisionOutcome> {
    const { req, opts, protocol, sideBody, session, log } = args;
    let outcome: DecisionOutcome;
    try {
        const route = resolveUpstream(opts, req.url ?? "", req);
        const target = buildForwardTarget(req, opts, route);
        let url = target.upstreamUrl;
        if (protocol === "google" && url.includes(":streamGenerateContent")) {
            url = url.replace(":streamGenerateContent", ":generateContent");
        }
        const bodyStr = JSON.stringify(sideBody);
        const headers: Record<string, string> = { "content-type": "application/json", ...target.headers };
        const fwdResign = resignSettingsFor(opts, target.upstreamUrl);
        const resignCtx =
            fwdResign.enabled && String(Array.isArray(req.headers[APIG_RESIGN_HEADER]) ? req.headers[APIG_RESIGN_HEADER][0] ?? "" : req.headers[APIG_RESIGN_HEADER] ?? "") === APIG_RESIGN_SCHEME
                ? decodeApigCredential(Array.isArray(req.headers[APIG_RESIGN_CREDENTIAL_HEADER]) ? req.headers[APIG_RESIGN_CREDENTIAL_HEADER][0] : req.headers[APIG_RESIGN_CREDENTIAL_HEADER])
                : undefined;
        if (resignCtx !== undefined) {
            try {
                resignApig(headers, resignCtx, "POST", target.upstreamUrl, bodyStr, findRoute(opts.routes, target.upstreamUrl));
            } catch (err) {
                log("warn", `[acp-decide] session=${session.id} re-sign failed; sending the previous signature: ${String(err)}`);
            }
        }
        const { response, clearTimer } = await fetchWithTimeout(url, { method: "POST", headers, body: bodyStr, dispatcher: proxyDispatcher(target.proxyUrl) }, DECIDE_TIMEOUT_MS);
        try {
            if (!response.ok) {
                outcome = { kind: "failed", detail: `HTTP ${response.status}` };
            } else {
                const text = await response.text();
                let json: Record<string, unknown> | null = null;
                try {
                    json = JSON.parse(text) as Record<string, unknown>;
                } catch {
                    json = null;
                }
                outcome = parseDecision(json !== null ? extractDecisionText(protocol, json) : extractSummaryFromSse(protocol, text));
            }
        } finally {
            clearTimer();
        }
    } catch (e) {
        outcome = { kind: "failed", detail: String(e) };
    }
    recordDecision(session.metadata, outcome.kind !== "failed");
    markDirty(session);
    log(
        outcome.kind === "failed" ? "warn" : "info",
        `[acp-decide] session=${session.id} ${protocol}: ${outcome.kind === "failed" ? outcome.detail : outcome.kind === "yes" ? `yes${outcome.range ? ` (${outcome.range})` : ""}` : "no"}`,
    );
    return outcome;
}

// #247: context exceeds the (new) model's window — usually right after a
// mid-session model switch. The payload would overflow at forward time and
// the reactive nudge could never fire (the request itself is rejected before
// the model sees it), so the session would be stuck. Compress oldest
// compressible ranges first (summarization calls sized to fit the smaller
// window), then rebuild the payload.
/** Fail-fast outcome (#301): the payload still overflows the window and
 *  preflight could not fix it, so the proxy answers with a structured error
 *  instead of forwarding a guaranteed-400 payload (wasted quota + retry
 *  storms). */
interface PreflightFailFast {
    failFast: true;
    status: number;
    message: string;
    retryable: boolean;
    /** False when the client already disconnected — there is nothing to write. */
    respond: boolean;
}

export function isPreflightFailFast(outcome: Prepared | PreflightFailFast): outcome is PreflightFailFast {
    return "failFast" in outcome;
}

// #568: preflight compression sends ZERO bytes to the client while it runs, so
// undici's default headersTimeout (300s) kills any multi-round compression that
// crosses it — the proxy then aborts on the detected disconnect and the client
// retries into the same wall (5-minute death loop). Once the work outlives this
// grace period the response is committed early (200 + protocol framing) and the
// client is held with periodic keep-alive bytes until the real response exists.
// 30s protects every client whose header deadline exceeds 30s (undici's 300s
// default included); shorter preflights keep full status-code fidelity.
const PREFLIGHT_KEEPALIVE_MS = 15_000;

function preflightHoldGraceMs(): number {
    return knobPreflightHoldGraceMs();
}

// Cache exhausted walks and non-transient HTTP rejections only for the same
// forwarded body. Transport failures do not establish a content dead end.
function preflightDeadEndCooldownMs(): number {
    return knobPreflightDeadEndCooldownMs();
}

/** #568: commit the response early so a long preflight cannot lose the client
 *  to its header timeout. Streaming clients get an SSE stream with keep-alive
 *  comment lines (`: bili-preflight` — a spec-mandated no-op for every SSE
 *  consumer, same pattern as OpenAI's SSE pings); non-streaming clients get
 *  chunked JSON padded with whitespace (valid JSON padding). Each byte resets
 *  undici's bodyTimeout (inactivity-based), holding the client for the whole
 *  compression. Returns a stop() ending the keep-alive, or undefined when
 *  nothing could be committed (headers already sent / socket gone — the
 *  existing res "close" abort then handles cancellation). */
function beginPreflightHold(res: http.ServerResponse, prepared: Prepared, log: (level: string, msg: string) => void): (() => void) | undefined {
    if (res.headersSent || res.destroyed || res.writableEnded) return undefined;
    const sid = prepared.session.id;
    const keepAlive = prepared.stream ? ": bili-preflight\n\n" : " ";
    try {
        if (prepared.stream) {
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                "x-accel-buffering": "no",
                "x-bili-preflight": "compressing",
            });
        } else {
            res.writeHead(200, { "content-type": "application/json", "x-bili-preflight": "compressing" });
        }
    } catch {
        return undefined;
    }
    log("info", `[${sid}] preflight still running after ${preflightHoldGraceMs()}ms grace — committed early ${prepared.stream ? "SSE" : "JSON"} headers + keep-alive to hold the client (#568)`);
    try {
        res.write(keepAlive);
    } catch { /* client gone */ }
    const iv = setInterval(() => {
        try {
            res.write(keepAlive);
        } catch {
            clearInterval(iv);
        }
    }, PREFLIGHT_KEEPALIVE_MS);
    return () => clearInterval(iv);
}

// #1647: sibling of the #568 hold, covering the STREAMING phase. After the 2xx
// commit, bili keeps consuming upstream bytes that never reach the client — the
// rewriter/strip pipes swallow SSE comment pings (`: ping`, which llama.cpp &
// friends emit precisely to keep intermediate hops alive), and the
// fake-completion backstop + compress loop buffer whole rounds before emitting.
// The CLIENT-side undici default bodyTimeout (300s, inactivity-based; Node's
// built-in fetch cannot override it per-request) then kills any prefill longer
// than 300s even though leg 2 (#551/#556) survived it — and wrappers misread
// that death as a dead proxy and silently re-send DIRECT (losing compression).
// Hold the client exactly like #568 does: while zero bytes reach the socket,
// emit one SSE comment line (a spec-mandated no-op for every SSE consumer).
// Armed once per response at the 2xx commit point; self-clears on res close,
// so no stop() needs threading through the pipe branches below. Safe under any
// framing: content-length is a hop header stripped from respHeaders, so the
// response is always chunked downstream.
function streamKeepaliveMs(): number {
    return knobStreamKeepAliveMs();
}

export function beginStreamKeepalive(res: http.ServerResponse, sid: string, log: (level: string, msg: string) => void): void {
    const idleMs = streamKeepaliveMs();
    if (idleMs <= 0 || res.destroyed || res.writableEnded) return;
    const sock = res.socket;
    if (!sock) return;
    let baseline = sock.bytesWritten;
    let warned = false;
    let stopped = false;
    // Line-boundary guard: an SSE comment is a no-op ONLY when it starts at a
    // line boundary. Every processed pipe in this file re-emits whole events,
    // but the raw pipeThrough lanes (title-gen, classifier bypass,
    // ACP_NO_INJECT_TOOL — server.ts !useRewriter branch) forward upstream
    // chunks verbatim, so a partial `data:` line can sit un-terminated on the
    // wire when the interval fires. Injecting a comment there splices it into
    // the client's JSON. Track the last byte written and skip the beat while
    // mid-line; the 300s budget tolerates skips, corruption does not.
    // `__biliKeepaliveBoundary` (on the res) is the live boundary state so a
    // second arming on the same res shares one truth; undefined = not yet patched.
    const anyRes = res as unknown as { __biliKeepaliveBoundary?: boolean };
    let origWrite: typeof res.write;
    if (anyRes.__biliKeepaliveBoundary === undefined) {
        origWrite = res.write.bind(res);
        anyRes.__biliKeepaliveBoundary = true; // headers just committed — at a boundary
        res.write = ((...args: Parameters<typeof origWrite>) => {
            const chunk = args[0];
            try {
                if (typeof chunk === "string") {
                    if (chunk.length > 0) anyRes.__biliKeepaliveBoundary = chunk.endsWith("\n");
                } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
                    if (chunk.length > 0) anyRes.__biliKeepaliveBoundary = chunk[chunk.length - 1] === 0x0a;
                }
            } catch { /* observation must never break the write */ }
            return origWrite(...args);
        }) as typeof res.write;
    }
    const stop = (): void => {
        if (stopped) return;
        stopped = true;
        clearInterval(iv);
        res.removeListener("close", stop);
    };
    res.once("close", stop);
    // Check cadence: idleMs/3 keeps worst-case gap-to-first-keepalive well
    // inside the threshold even with timer drift; the 50ms floor only matters
    // for tiny opt-in values (tests / exotic setups).
    const iv = setInterval(() => {
        try {
            if (res.destroyed || res.writableEnded || !res.socket) {
                stop();
                return;
            }
            const written = res.socket.bytesWritten;
            if (written > baseline) {
                baseline = written;
                return;
            }
            // Mid-line: skip this beat. No baseline mutation, so the next tick
            // re-checks; when the pending line completes, its own write flips
            // the flag and keep-alives resume. (Note: a keep-alive write itself
            // bumps bytesWritten, so the following tick sees "progress" and
            // skips — effective cadence ≈ 2×interval. Harmless vs the 300s
            // budget; noted here so the 2× isn't mistaken for a bug.)
            if (anyRes.__biliKeepaliveBoundary === false) return;
            res.write(": bili-keepalive\n\n");
            if (!warned) {
                warned = true;
                log("info", `[${sid}] stream silent ${idleMs}ms — holding client with SSE keep-alive comments past its undici body timeout (#1647)`);
            }
        } catch {
            stop();
        }
    }, Math.max(50, Math.floor(idleMs / 3)));
}

/** #1493: the OUTBOUND payload size (what would actually be sent upstream):
 *  post-fold message content + wire overhead + images. Single source of truth —
 *  BOTH preflightCompressIfNeeded (trigger floor + fit gates) and armFailureShrink
 *  (no-usage arming) measure this, or they diverge (arming once counted the raw
 *  JSON body → raw-history scale, firing preflight on a payload that fit).
 *  Terms: #488 images are invisible to the kernel text model; #470 system+tools
 *  ride the wire too; #767 images billed by resolved mode (buildForwardTarget fallback). */
export function outboundPayloadBreakdown(
    prepared: Prepared,
    opts: ProxyOptions,
    route: ReturnType<typeof resolveUpstream>,
    reqUrl: string,
): { textEstimate: number; overheadEstimate: number; imageTokens: number; payloadEstimate: number; armEstimate: number } {
    const billingUpstream = route?.rewrittenUrl ?? (/^https?:\/\//i.test(reqUrl) ? reqUrl : opts.upstream);
    const imageTokens = imageReserveFor(prepared.session, prepared.protocol, prepared.body, opts, billingUpstream);
    // #1498-F2: a kernel-transform failure leaves processedMessages empty while
    // the outbound IS the raw client body — measure that view instead of arming
    // at wire overhead only (the mirror of localInputEstimate's fallback).
    const msgs = prepared.processedMessages.length > 0 ? prepared.processedMessages : prepared.originalMessages;
    const textEstimate = estimateCoreMessages(msgs);
    const overheadEstimate = estimateWireOverhead(prepared.protocol, prepared.body);
    // #1498-F1: the arm value is not only a preflight floor — the kernel's
    // tool-result truncation loop consumes it as its remaining-depth input, so
    // an optimistic text estimate (chars/4 undercounts dense JSON/code by up to
    // ~4x, #553) stops the loop one candidate early and re-breaks the #604
    // relay rescue. The arming quantity is therefore floored by the text char
    // bound, which never undershoots and deliberately does NOT count image
    // base64 — image-heavy payloads keep the billing-accurate payloadEstimate
    // (#1493) while text-dominated near-window payloads arm deep enough for the
    // truncation loop to clear hidden upstream tolerances (#604).
    const armEstimate = Math.max(textEstimate, estimateCoreMessagesUpper(msgs)) + overheadEstimate + imageTokens;
    return { textEstimate, overheadEstimate, imageTokens, payloadEstimate: textEstimate + overheadEstimate + imageTokens, armEstimate };
}

/** #2078: `parsed` carries the caller's pre-parsed send body so forward() does
 *  not pay a second full JSON.parse of the largest payload in flight per
 *  request. Three states: undefined = parse here (legacy callers), object =
 *  project from it (numbers identical to re-parsing the same string), null =
 *  caller already tried and failed → keep the prepared projection and skip the
 *  doomed re-parses inside the helpers (they return 0 on unparseable input). */
/** #2117: both calibers of one outbound send, computed in ONE projection pass.
 *  upperBound is the char-count upper bound (every character counts as one
 *  token — never undershoots; the fail-closed decision/display caliber, and
 *  the legacy outboundContextEstimate value). textOverhead is the billing
 *  caliber preflight calibrates with k̂ (#1933 F1): CJK-aware
 *  estimateCoreMessages + system/tools wire overhead. imageTokens is the
 *  separate image term (learned per-route #1843/#1857), kept out of both so
 *  callers can recombine per channel. */
interface OutboundContextEstimates {
    upperBound: number;
    textOverhead: number;
    imageTokens: number;
}

/** #2078: `parsed` carries the caller's pre-parsed send body so forward() does
 *  not pay a second full JSON.parse of the largest payload in flight per
 *  request. Three states: undefined = parse here (legacy callers), object =
 *  project from it (numbers identical to re-parsing the same string), null =
 *  caller already tried and failed → keep the prepared projection and skip the
 *  doomed re-parses inside the helpers (they return 0 on unparseable input). */
export function outboundContextEstimates(
    prepared: Prepared,
    wireBody: string,
    opts: ProxyOptions,
    upstream: string,
    parsed?: Record<string, unknown> | null,
): OutboundContextEstimates {
    let msgs = prepared.processedMessages.length > 0 ? prepared.processedMessages : prepared.originalMessages;
    const project = (value: unknown): void => {
        switch (prepared.protocol) {
            case "anthropic": msgs = anthropicToCore(value as AnthropicRequestBody).msgs; break;
            case "openai": msgs = openaiToCore(value as OpenAIRequestBody).msgs; break;
            case "responses": msgs = responsesToCore(value as ResponsesRequestBody).msgs; break;
            case "google": msgs = googleToCore(value as GoogleRequestBody).msgs; break;
        }
    };
    let raw: string | Record<string, unknown>;
    if (parsed === undefined) {
        try { project(JSON.parse(wireBody)); } catch { /* Preserve the prepared projection if the wire codec cannot project a provider extension. */ }
        raw = wireBody;
    } else if (parsed !== null) {
        try { project(parsed); } catch { /* Preserve the prepared projection if the wire codec cannot project a provider extension. */ }
        raw = parsed;
    } else {
        raw = "";
    }
    const overhead = estimateWireOverhead(prepared.protocol, raw);
    const imageTokens = imageReserveFor(prepared.session, prepared.protocol, raw, opts, upstream);
    return {
        upperBound: estimateCoreMessagesUpper(msgs) + overhead + imageTokens,
        textOverhead: estimateCoreMessages(msgs) + overhead,
        imageTokens,
    };
}

export function outboundContextEstimate(
    prepared: Prepared,
    wireBody: string,
    opts: ProxyOptions,
    upstream: string,
    parsed?: Record<string, unknown> | null,
): number {
    return outboundContextEstimates(prepared, wireBody, opts, upstream, parsed).upperBound;
}

// #2317 — route-miss diagnostics. A providers table that exists but matches NONE
// of a request's upstream silently drops every per-provider override (context,
// compress.*, …) for that request while the registry value looks plausible, and
// the preflight 502 then points at the one knob the operator already set under a
// DIFFERENT key. Make the miss loud (once per upstream+model) and make the 502
// advice name the real cause instead of the misleading "set modelContextLimit".
const routeMissWarned = new Set<string>();

export function _resetRouteMissWarnedForTest(): void {
    routeMissWarned.clear();
}

/** #2317: warn at most once per (upstream-origin, model). Origin (scheme+host+port)
 *  keys the dedupe so two relays on one host with different ports each warn — a
 *  hostname-only key would collide across them. */
export function warnRouteMissIfNew(
    origin: string | undefined,
    model: string | undefined,
    knownKeys: string[],
    log: (level: string, msg: string) => void,
): boolean {
    if (!origin || !model || knownKeys.length === 0) return false;
    const key = `${origin}\u0000${model}`;
    if (routeMissWarned.has(key)) return false;
    routeMissWarned.add(key);
    const hosts = knownKeys.map((k) => hostIdForLog(k));
    log("warn", `[route] no provider route matched ${hostIdForLog(origin)} (model=${model}) — its per-provider settings (context/compress/…) are IGNORED; known providers keys: ${hosts.join(", ")}. Add a matching key to the providers block in ~/.config/billion-context/billion-context.json.`);
    return true;
}

/** #736 / #2317: the preflight fail-fast "effective window below native" note. The
 *  operator and codex-route-hit texts are preserved byte-for-byte; the new
 *  codex-route-miss branch fires when the shrink is codex-driven AND the request's
 *  upstream matched NO configured providers key (so the operator's pinned window was
 *  never consulted — advising "set modelContextLimit" would be wrong). */
export function buildWindowShrinkNote(args: {
    reason: "operator" | "codex" | undefined;
    limit: number;
    nativeWindow?: number;
    routeMissedConfigured?: boolean;
    upstreamEndpoint?: string;
    knownKeys?: string[];
}): string {
    if (args.reason === undefined || args.nativeWindow === undefined || args.limit >= args.nativeWindow) return "";
    const head = ` Note: bili's effective window ${args.limit} is below the model's full window ${args.nativeWindow} — `;
    if (args.reason === "operator") {
        return head + `your compress.modelContextLimit setting overrides it; if the upstream actually serves the larger window, raise or remove that setting (hot-reloaded, no session restart needed).`;
    }
    if (args.routeMissedConfigured) {
        const up = args.upstreamEndpoint ? hostIdForLog(args.upstreamEndpoint) : "this upstream";
        const keys = (args.knownKeys ?? []).map((k) => hostIdForLog(k)).join(", ");
        return head + `it was aligned down to codex's own window perception, and your upstream (${up}) matched NO configured providers key${keys ? ` — your pinned context/modelContextLimit sit under: ${keys}` : ""}. Add a providers entry for this upstream so the pinned window applies here.`;
    }
    return head + `it was aligned down to codex's own window perception; set compress.modelContextLimit explicitly if your upstream serves the larger window.`;
}

export async function preflightCompressIfNeeded(
    prepared: Prepared,
    runPrepare: () => Promise<Prepared>,
    req: http.IncomingMessage,
    inboundBody: Buffer,
    res: http.ServerResponse,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    configuredWindow: number,
    model: string | undefined,
    resolvedNativeWindow: number | undefined,
    windowShrinkReason: "operator" | "codex" | undefined,
    route: ReturnType<typeof resolveUpstream>,
    affinity: string | undefined,
    anonymous: boolean,
    log: (level: string, msg: string) => void,
    instanceId: string,
): Promise<Prepared | PreflightFailFast> {
    const session = prepared.session;
    const limit = config.modelContextLimit;
    const overflowTarget = prepared.protocol === "responses" && isCodexClient(req.headers) && codexCompactMode() === "intercept"
        ? limit * CODEX_COMPACT_HEALTH_RATIO
        : limit;
    // [#autoFold] Growth folding: with externalSummary.autoFold on (and the
    // chain resolvable — an unresolvable target collapses the rail to
    // enabled=false), the operator asked for a LEAN context, not just a
    // fitting one: lower the walk target from the window to the growth
    // floor so the SAME preflight machinery (external chain, kernel-chosen
    // ranges, zero model involvement) folds at the nudge-arm point instead
    // of only at overflow. The model never sees a nudge (the wire prepare
    // suppresses injection while autoFold is active) and never drafts
    // compression plans. Fail-open rule: every FAIL-FAST below is an
    // overflow concept — a growth-armed payload still fits the real window,
    // so failures forward as-is instead of refusing the request.
    const autoFoldOn = autoFoldEngaged(config, session);
    // The implicit half-window default must respect the documented
    // [8192, 10M] target range too: a window below ~16K would otherwise arm a
    // floor under the documented minimum. Clamping to the minimum disarms
    // auto-fold on sub-8K windows outright (target >= overflow ⇒ growthArmed
    // false), which matches the documented feature scope.
    const autoFoldTarget = autoFoldOn
        ? Math.max(AUTO_FOLD_TARGET_MIN, Math.min((config as ResolvedKernelConfig).externalSummary?.autoFoldTargetTokens ?? (overflowTarget > 0 ? Math.round(overflowTarget / 2) : 0), overflowTarget))
        : undefined;
    const growthArmed = autoFoldOn && autoFoldTarget !== undefined && autoFoldTarget > 0 && autoFoldTarget < overflowTarget; // narrowing form of growthFoldingArmed(config, overflowTarget) — keep in sync (PR #2581 review)
    const compressionTarget = growthArmed ? autoFoldTarget : overflowTarget;
    // A fresh session (id rotated, e.g. after a model switch) has
    // lastInputTokens = 0 while still carrying a full raw history; size the
    // trigger on the real post-fold payload too. outboundPayloadBreakdown is the
    // single source of truth for that size (#1493) — armFailureShrink measures
    // the same quantity so a no-usage failure can't arm lastInputTokens to raw-
    // history scale and fire preflight on a payload that actually fits.
    const { textEstimate, overheadEstimate, imageTokens } = outboundPayloadBreakdown(prepared, opts, route, req.url ?? "");
    // #553: anonymous requests resolve their session by prefix affinity. After
    // an ACP compression breaks the chain hash, the client's replay mints a NEW
    // session id (a fork) whose lastInputTokens is 0 — yet it carries the full
    // raw history. Judging that on the optimistic chars/4 estimate undercounts
    // code/JSON replays by up to ~4x, so an over-window payload triggers
    // nothing and is forwarded raw (upstream 400 / long-prefill timeout). Judge
    // exactly those sessions by the char-count upper bound (never undershoots;
    // the image/wire floors still apply — #488/#470 postdate the fork).
    // Sessions with a client-provided identity keep the optimistic path: their
    // 0-baseline means a genuinely new conversation or a post-native-compaction
    // replay, both small enough to self-heal via the learned-window path.
    const unknownBaseline = anonymous && session.stats.lastInputTokens <= 0;
    // #1492: floor the trigger on the baseline only while it is authoritative
    // for THIS payload. A usage-grade baseline measures what upstream billed
    // (it can legitimately exceed every local estimate — invisible thinking/
    // cache components). An overflow-armed baseline (#1839 "overflow-arm") is
    // upstream REJECTION evidence at that size — floor it too, or the #1195
    // in-request refold and #987 next-turn fold lose their trigger whenever
    // the payload's own calibrated estimate undershoots. ANY baseline is the
    // best signal when the current payload is unmeasured (kernel transform
    // failed → the outbound IS the raw body). An estimate-sourced failure arm
    // (#604) on a measured (folded) payload describes a different view and
    // must not pull preflight into multi-minute runs over a payload whose own
    // post-fold estimate fits the window.
    const baselineFloorRaw = prepared.processedMessages.length > 0
        ? ((session.stats.lastInputTokensSource === "usage" || session.stats.lastInputTokensSource === "overflow-arm") ? session.stats.lastInputTokens : 0)
        : session.stats.lastInputTokens;
    // #1933 F2: a usage baseline is only authoritative for the route that
    // measured it — provider billing scales differ per upstream (the incident:
    // ~257K local estimate vs 59-63% real usage on one route; after a mid-
    // session model switch the stale cross-route baseline kept arming preflight
    // on payloads the new upstream billed far below the window). Demote to
    // untrusted when the request now routes elsewhere; the payload's own
    // (calibrated) estimate then judges it. Unprovenanced baselines (sessions
    // started before this field existed) keep the legacy behavior.
    let baselineFloor = baselineFloorRaw;
    const currentOrigin = normalizeUpstreamOrigin(route?.upstream);
    const baselineOrigin = normalizeUpstreamOrigin(session.stats.lastInputTokensOrigin);
    if (baselineFloor > 0 && currentOrigin !== undefined && baselineOrigin !== undefined && baselineOrigin !== currentOrigin) {
        log("info", `[${session.id}] preflight usage-baseline ~${baselineFloor} tok was measured on ${maskUrlForLog(baselineOrigin)}, request now routes to ${maskUrlForLog(currentOrigin)} — demoting to untrusted, judging by this payload's own estimate (#1933)`);
        baselineFloor = 0;
    }
    // #1933 F1: scale the local text estimate by the per-route calibration
    // factor k̂ learned from this session's own usage reports (local estimate ÷
    // what upstream actually billed; clamped 0.25–4, two-way since #2366 — see
    // settleUsageReport). Unknown/mismatched origin → raw estimate, i.e. the
    // uncalibrated legacy behavior. #2117 B: the model dimension gates too — a
    // factor learned on another model acts as absent here rather than deciding
    // with a cross-model billing scale (currentCalibrationFactor).
    const kFactor = currentCalibrationFactor(session.stats, session.metadata?.lastModel);
    const kOrigin = session.stats.calibratedEstimateOrigin;
    const calibratedText = applyEstimateCalibration(textEstimate + overheadEstimate, kFactor, kOrigin, currentOrigin);
    const calibratedPayload = calibratedText + imageTokens;
    const tokenCount = unknownBaseline
        ? estimateCoreMessagesUpper(prepared.processedMessages) + overheadEstimate + imageTokens
        : Math.max(baselineFloor, calibratedPayload);
    // #1843 dual-channel accounting: the trigger runs on the TEXT channel —
    // text vs `target − imageReserve`. Exact algebraic rewrite of the old
    // total-view trigger: subtracting the constant reserve from both sides of
    // max(B, T + R) >= C gives max(B − R, T) >= C − R, and flooring the
    // baseline projection at zero only matters when C − R < 0 — a case where
    // the old trigger fired unconditionally anyway (images alone clear the
    // whole window). Which requests fire is unchanged; what changes is what
    // can MOVE the decision: an image-estimate error (±15x on non-pixel-tile
    // upstreams, #1800) can no longer arm preflight over a text payload that
    // fits, nor keep it armed after the text has been folded down.
    const textChannel = unknownBaseline
        ? estimateCoreMessagesUpper(prepared.processedMessages) + overheadEstimate
        : calibratedText;
    const textBudget = Math.max(0, compressionTarget - imageTokens);
    const decisionTrigger = Math.max(Math.max(0, baselineFloor - imageTokens), textChannel);
    const triggerFires = imageTokens >= compressionTarget || decisionTrigger >= textBudget;
    // #2283 sub-defect 2: pair upstream billing with the same-payload local estimate on
    // EVERY request (not only when preflight triggers) — the offline data source for the
    // chars/4 deviation distribution behind the #2273 RC2 calibration decision.
    if (opts.debug) {
        const billed = session.stats.lastInputTokens > 0 && session.stats.lastInputTokensSource === "usage" ? session.stats.lastInputTokens : "none";
        log("debug", `[${session.id}] [usage-vs-est] upstream-billed=${billed} est=${Math.round(textEstimate)} k̂=${kFactor !== undefined ? kFactor.toFixed(2) : "n/a"} route=${currentOrigin === undefined ? "?" : maskUrlForLog(currentOrigin)} model=${model ?? "?"} baseline-grade=${session.stats.lastInputTokensSource ?? "none"} (#2283)`);
    }
    if (limit <= 0 || !model || !triggerFires) return prepared;
    // #2313: an estimate may not block the forward. The trigger above can
    // fire on the calibrated chars/4 estimate alone; when the current
    // upstream's billing scale diverges from the estimator's caliber
    // (incident #2313: a local OpenAI-compatible shim billed ~200 B/token —
    // the trigger read 7.3M-10.3M against a real 305K input, ~24-34x over),
    // calibration cannot correct it (k̂ is two-way since #2366 but clamped
    // 0.25-4, and a 24-34x shim sits far outside the clamp; consistent
    // samples below CALIBRATION_SAMPLE_MIN are discarded), so
    // estimate-driven folding demands unreachable targets, cannot finish
    // inside client stream patience (~300s idle abort), and never lets a
    // forward through — 0 successful forwards in 12h while every failed
    // turn ratchets the estimate-sourced meter higher: the livelock. Rule:
    // when the session carries a nonzero baseline NONE of which is upstream
    // evidence for THIS route (estimate-sourced, or usage/overflow-arm
    // demoted by #1933 F2 — in both cases baselineFloor === 0), forward once
    // and let the upstream arbitrate size instead of folding first: success
    // settles a usage baseline, a 4xx overflow arms one (armOverflowShrink
    // stamps the evidence origin so the arm survives F2 on this route).
    // Either outcome re-arms honest metering and fail-fast semantics resume
    // from the next request. Generalizes the #496/#1800 forward-once image
    // arbitration to the estimate channel. Fresh sessions
    // (lastInputTokens <= 0 / unknownBaseline #553) keep the fold-first
    // judgment — they hold no known-wrong meter to replace.
    // [#autoFold] a growth trigger is operator intent, not a billing guess —
    // it never needs upstream evidence and must fold on the FIRST armed
    // request, so the #2313 estimate-only forward-once never skips it.
    const probeForEvidence = !growthArmed && !unknownBaseline && session.stats.lastInputTokens > 0 && baselineFloor <= 0 && prepared.processedMessages.length > 0;
    if (probeForEvidence) {
        // #2490: mathematically-doomed probe guard. The forward-once below bets
        // one request on "the estimator might be wrong about size"; that bet has
        // positive expected value only while SOME tokenizer could make the
        // payload fit. Price the bet in UTF-8 BYTES of the core text against TWO
        // bars — window×7.5 (densest live-route billing observed: ~6.8 B/token,
        // #2122's calibrated shim) AND an absolute 2MB floor. The floor keeps
        // synthetic-but-legal dense payloads probing (the #1001 rewrite test
        // rides 86KB at 8.6 B/tok against a 10K window — repetitive text real
        // tokenizers DO compress past 7.5 B/token): below 2MB the probe costs
        // one small request and density assumptions deserve the benefit of the
        // doubt; past it (incident #2490: a 7.5MB single assistant turn against
        // a 1M window) forwarding "for evidence" is a guaranteed 400 with a
        // multi-MB body, not an experiment — fail fast with the byte math so
        // the operator can verify it by hand. Bytes, not chars: CJK monsters
        // are char-cheap (1 char ≈ 1 token already) but byte-doomed; every legit
        // fitting English payload sits ~4× under the ratio bar.
        const coreTextBytes = estimateCoreMessagesUpperBytes(prepared.processedMessages);
        const DOOMED_PROBE_BYTES_PER_TOKEN = 7.5;
        const DOOMED_PROBE_ABSOLUTE_BYTES = 2_000_000;
        if (coreTextBytes > Math.max(DOOMED_PROBE_ABSOLUTE_BYTES, limit * DOOMED_PROBE_BYTES_PER_TOKEN)) {
            const byteFloorTokens = Math.ceil(coreTextBytes / DOOMED_PROBE_BYTES_PER_TOKEN);
            const doomedMessage = `payload core text alone is ~${coreTextBytes} bytes — even at the densest tokenizer density observed on a live route (~${DOOMED_PROBE_BYTES_PER_TOKEN} bytes/token, #2122) that is ≥ ~${byteFloorTokens} tokens vs the model window ${limit} (model=${model}); no upstream can accept it, so it was NOT forwarded even for evidence. Remove or trim the oversized content (e.g. a giant paste or tool result) and retry.`;
            log("error", `[${session.id}] preflight fail-fast 502 (retryable=false): ${doomedMessage}`);
            return { failFast: true, status: 502, message: doomedMessage, retryable: false, respond: !res.writableEnded };
        }
        log("info", `[${session.id}] preflight trigger fired on estimate only (~${Math.round(textChannel)} text + ~${imageTokens} image vs window ${limit}); baseline ${session.stats.lastInputTokens} (${session.stats.lastInputTokensSource ?? "unprovenanced"}) carries no current-route upstream evidence — forwarding once to acquire usage/overflow evidence before compressing (#2313)`);
        return prepared;
    }
    const payloadFitsWindow = (unknownBaseline ? tokenCount : calibratedPayload) < limit;
    // #496 forward-once-then-learn: the default image cost (base64/4) matches byte
    // relays (#488) but overestimates pixel-tile upstreams (a 400KB JPEG ≈ 1.6K real
    // tokens, not ~133K), so an image-dominated payload can clear the window on ESTIMATE
    // alone. When images are the sole over-window component (text fits) and we hold no
    // upstream overflow evidence, forward once and let the upstream arbitrate billing:
    // tile upstreams accept it; byte relays reject it (400) → the rejection
    // arms the emergency shrink (at the stated window, or the declared one
    // when the body carries no number) → later requests fail-fast.
    // #488's 400 loop stays broken (exactly one rejected forward). Evidence signals:
    // A usage-grounded or overflow-armed baseline ≥ window is evidence (#1839:
    // "overflow-arm" IS upstream overflow evidence — the rejection itself
    // proved the payload overflows; without it the arm would no longer close
    // the hatch and #488's 400 loop reopens); an estimate-derived or
    // legacy-unmarked baseline is NOT (#857: preflight used to write image
    // estimates back into lastInputTokens, which permanently closed this
    // hatch on pixel-billing upstreams). With evidence present we trust the
    // estimate and fall through to fold / fail-fast below.
    const noOverflowEvidence = session.stats.lastInputTokens < limit
        || (session.stats.lastInputTokensSource !== "usage" && session.stats.lastInputTokensSource !== "overflow-arm");
    // #1800/#1843: the TEXT channel fits the window but `text + imageReserve`
    // does not, and we hold no overflow evidence → the image reserve clears the
    // window on ESTIMATE alone while the real bill may be far smaller (pixel-tile
    // upstreams charge ~3K/screenshot, not the bytes-billing estimate), so we let
    // the upstream arbitrate billing instead of fail-fast'ing. But do NOT unconditionally
    // short-circuit here: that permanently disabled auto-compression — preflight
    // never ran while the inflated estimate sat over-window, so a growing text
    // payload was folded 0× for the whole session (#1800). Only take the immediate
    // forward when there is literally NOTHING compressible; otherwise remember the
    // arbitration and let preflightCompress fold the text portion first, re-applying
    // this same forward-instead-of-fail-fast decision after compression (below).
    const imageArbitration = imageTokens > 0 && textChannel < limit && textChannel + imageTokens >= limit && noOverflowEvidence;
    if (imageArbitration && (prepared.nudge?.compressibleRanges ?? []).length === 0) {
        log("warn", `[${session.id}] image-dominated payload (~${textEstimate} text + ~${imageTokens} image tokens) exceeds window ${limit} by estimate only, nothing compressible, no upstream overflow evidence — forwarding for the upstream to arbitrate billing (#496/#1800)`);
        return prepared;
    }
    // #301: forwarding as-is is safe ONLY when the payload's own estimate
    // fits the window. The trigger (and the loop's fit check) floor on
    // session.stats.lastInputTokens, which can be stale — e.g. a
    // double-counted usage report (#300) — and must not turn a fitting
    // payload into a fail-fast false positive.
    // #869 review: quote the POST-FOLD size once folding happened — reporting
    // only the original tokenCount reads as "nothing happened" even when 16
    // folds removed hundreds of thousands of tokens. foldedTokens/rangesLeft
    // stay undefined when no fold ran, so the original phrasing holds there.
    const failFast = (status: number, detail: string, retryable: boolean, foldedTokens?: number, rangesLeft?: number): PreflightFailFast => {
        const imageNote = imageTokens >= limit
            ? ` Images alone account for ~${imageTokens} tokens (≥ window ${limit}); compression cannot remove them — shrink or remove the images, or raise the window.`
            : "";
        const sizeClause = foldedTokens !== undefined && foldedTokens < tokenCount
            ? `context ~${foldedTokens} tokens (down from ~${tokenCount} before preflight) exceeds the model window ${limit}`
            : `context ~${tokenCount} tokens exceeds the model window ${limit}`;
        const rangesClause = rangesLeft !== undefined ? `, with ${rangesLeft} compressible range(s) still visible` : "";
        // #736: when the wall is bili's own shrunken window, say so — "raise the
        // model context window" otherwise sends operators to the upstream when
        // their compress.modelContextLimit is the actual ceiling. Gate on
        // windowShrinkReason (set ONLY by the operator-override and codex-align
        // paths) — NOT just on limit < resolvedNativeWindow: the per-request
        // output-headroom reservation (reserveOutputHeadroom) also lowers
        // reqConfig.modelContextLimit below native for every non-Anthropic turn
        // with a max_tokens, so comparing alone would emit this note for a
        // setting the operator never touched (#737 review).
        const ffEmbeddedUrl = route?.rewrittenUrl;
        const ffProviderKeys = Object.keys(opts.routes);
        const shrinkNote = buildWindowShrinkNote({
            reason: windowShrinkReason,
            limit,
            nativeWindow: resolvedNativeWindow,
            routeMissedConfigured: ffProviderKeys.length > 0 && findRouteKey(opts.routes, ffEmbeddedUrl) === undefined,
            upstreamEndpoint: ffEmbeddedUrl,
            knownKeys: ffProviderKeys,
        });
        const message =
            `${sizeClause} (model=${model})${rangesClause} ` +
            `and preflight compression could not bring it under: ${detail.replace(/\.\s*$/, "")}.` +
            imageNote +
            shrinkNote +
            ` The over-window payload was NOT forwarded.`;
        log("error", `[${session.id}] preflight fail-fast ${status} (retryable=${retryable}): ${message}`);
        return { failFast: true, status, message, retryable, respond: !res.writableEnded };
    };
    if ((prepared.nudge?.compressibleRanges ?? []).length === 0) {
        // Headroom or a stale baseline can trigger preflight on a fitting payload.
        // Anonymous sessions need the conservative upper bound to prove that fit.
        if (payloadFitsWindow) {
            log("info", `[${session.id}] preflight target reached (~${tokenCount}) but the payload fits with no compressible ranges (~${Math.round(calibratedPayload)}/${limit}${kFactor !== undefined ? `, k̂=${kFactor.toFixed(2)}` : ""}); forwarding as-is`);
            return prepared;
        }
        if (unknownBaseline) {
            return failFast(502, "no part of the conversation is compressible (nothing left to fold)", false);
        }
        // Known-baseline over-window: fall through to preflightCompress — its
        // relax path (#330) folds the soft-protected recent zone when that is
        // the only foldable content, and its exhaustion detail carries the
        // operator remedy wording.
    }
    // #726: dead-end cooldown — an identical over-window state already failed
    // preflight without folding anything, so re-running the walk is doomed; fail
    // fast with the cached diagnosis and spend ZERO upstream summarization calls.
    // Sits AFTER every safe-forward path above (#496 image arbitration, #300
    // stale-baseline fit): those return without running the walk, so the
    // cooldown must not convert a fitting payload into a false fail-fast while
    // a marker from a larger earlier request is still warm.
    // #726 identity is the CLIENT request, not the rebuilt wire body: proxy-side
    // injections vary turn to turn (the nudge text changes every turn; #728's
    // silent-backend fallback arms the nudge on exactly these never-report-usage
    // upstreams), so hashing prepared.body misses the cooldown on retry and
    // re-burns upstream quota — the failure #726 exists to prevent.
    const deadEndKey = `${model}\u0000${limit}\u0000${createHash("sha256").update(inboundBody).digest("hex")}`;
    const deadEnd = session.metadata.preflightDeadEnd;
    if (deadEnd && typeof deadEnd === "object") {
        const de = deadEnd as Record<string, unknown>;
        if (de.key === deadEndKey && typeof de.until === "number" && de.until > Date.now() && typeof de.message === "string") {
            if (payloadFitsWindow) return prepared;
            log("warn", `[${session.id}] preflight dead-end cooldown active (${Math.ceil((de.until - Date.now()) / 1000)}s left); failing fast without upstream calls (#726)`);
            return { failFast: true, status: typeof de.status === "number" ? de.status : 502, message: de.message, retryable: de.retryable === true, respond: !res.writableEnded };
        }
        delete session.metadata.preflightDeadEnd;
        markDirty(session);
    }
    // #330: the payload overflows the window (or nothing is foldable in the
    // normal pass but it doesn't fit). Let preflightCompress try to fold it —
    // it relaxes the soft-protected recent zone when nothing is foldable
    // outside it, and fails fast with an actionable error only when truly
    // nothing is foldable (no summarization call is spent in that case). The
    // old pre-check failed fast here on the normal-config compressibleRanges,
    // which excluded the soft zone — bricking the #330 livelock.
    // #1933 F4: the trigger line now carries both measurement scales — the
    // provider-billed baseline and the (calibrated) local estimate — so a
    // false trigger is diagnosable from the log alone instead of requiring a
    // cross-reference between gate and nudge lines.
    log("warn", `[${session.id}] context ${tokenCount} tokens reached preflight target ${compressionTarget}${growthArmed ? " (auto-fold growth floor)" : ""} (model window ${limit}, model=${model}; usage-baseline=${baselineFloor > 0 ? baselineFloor : "none"} local-est=${Math.round(calibratedText)}${kFactor !== undefined ? ` raw=${Math.round(textEstimate + overheadEstimate)} k̂=${kFactor.toFixed(2)}` : ""}); preflight compressing before forward`);
    // #300: stamp the chain marker so a downstream bili skips these
    // summarization calls too (preflight always processes).
    const { upstreamUrl, headers, proxyUrl } = buildForwardTarget(req, opts, route, affinity, instanceId);
    const clientAbort = new AbortController();
    registerRequestAbort(res, clientAbort);
    res.on("close", () => {
        if (!res.writableEnded) {
            clientAbort.abort();
            noteClientAbort(session);
        }
    });
    const started = Date.now();
    let stopHold: (() => void) | undefined;
    const holdTimer = setTimeout(() => {
        stopHold = beginPreflightHold(res, prepared, log);
    }, preflightHoldGraceMs());
    holdTimer.unref();
    // #2133: compress.streamSummary (same three-level cascade as this request's
    // own reqConfig resolution) forces SSE summarization — the error-driven
    // learn path can't see gateway timeouts (524/503), so operators behind such
    // gateways need a deterministic escape hatch.
    const forceStreamSummary = resolveCompress(opts.routes, route?.rewrittenUrl, model, opts.compress).streamSummary === true;
    // #2155: the same cascade resolved FALSE is an explicit operator opt-out —
    // neither learn path (400 "stream required" nor the 524/504 first-hit
    // learn) may arm streaming summaries for this request's session lane.
    const streamSummaryOff = resolveCompress(opts.routes, route?.rewrittenUrl, model, opts.compress).streamSummary === false;
    let result: PreflightResult;
    try {
        result = await preflightCompress(
            {
                core,
                session,
                config,
                compressionTarget,
                compressReason: growthArmed ? "growth" : "overflow",
                prompts: prepared.prompts ?? defaultPrompts,
                surface: prepared.surface,
                protocol: prepared.protocol,
                billingBlock: prepared.anthropicBillingBlock,
                url: upstreamUrl,
                headers,
                model,
                proxyUrl,
                signal: clientAbort.signal,
                log,
                imageReserve: imageTokens,
                wireOverhead: overheadEstimate,
                unknownBaseline,
                upstreamOrigin: currentOrigin,
                forceStreamSummary,
                streamSummaryOff,
            },
            prepared.originalMessages,
        );
    } finally {
        clearTimeout(holdTimer);
        stopHold?.();
    }
    // #726: a preflight that did not end in failure clears any dead-end marker
    // — the state changed (conversation shrank, upstream recovered).
    if (!result.failure) delete session.metadata.preflightDeadEnd;
    // #2662: zero progress caused purely by queue drops (batches submitted, no
    // attempt dispatched) is scheduler congestion, not a chain failure — it
    // must not burn 10 minutes of auto-fold. Undefined for classic preflights.
    const queueDroppedAll = externalQueueDroppedAll(result.externalDispatch);
    // #330: decide forward/fail on the payload actually forwarded, not
    // result.payloadEstimate — the preflight's relaxed-zone processTurn trims
    // that estimate more than the normal-config prepare does, which can turn a
    // guaranteed-400 forward into a false "fits". Images ride the payload
    // verbatim (#488): add their cost back or #496's image-dominated payload
    // would look "fitting" on its text estimate alone. Unknown-baseline
    // sessions keep the loop's own upper-bound judgment (result.fitsWindow,
    // #553) — the optimistic re-estimate is exactly what that regime distrusts.
    let outbound: Prepared = prepared;
    if (result.compressedRanges > 0) {
        const rebuilt = await runPrepare();
        // runPrepare re-incremented stats.requests; the rebuild is internal
        // to this single client request.
        session.stats.requests -= 1;
        outbound = rebuilt;
        // #1987: anchor the usage baseline to what ACTUALLY ships — the rebuilt
        // normal-config payload (text + wire overhead; images excluded per the
        // #857 never-persist-the-image-floor rule: a bytes-mode image floor
        // overestimates pixel-billing upstreams ~100× and would poison the
        // upward window self-heal). The preflight-side anchor used the kernel's
        // no-emergency-truncate view, which keeps tool outputs prepare() trims
        // near the window edge — so the post-compression reading could EXCEED
        // the trigger-time reading ("~42619 tokens saved (2309870 → 2818817)")
        // and inflate every later meter until a real usage report landed.
        // Same measurement the fit gate below uses — the view that actually
        // goes out (processedMessages empty ⇒ kernel transform failure ⇒ the
        // raw body rides; mirror outboundPayloadBreakdown's fallback).
        const rebuiltMsgs = rebuilt.processedMessages.length > 0 ? rebuilt.processedMessages : rebuilt.originalMessages;
        const rebuiltTextSize = estimateCoreMessages(rebuiltMsgs) + overheadEstimate;
        if (rebuiltTextSize > session.stats.lastInputTokens) {
            session.stats.lastInputTokens = rebuiltTextSize;
            session.stats.lastInputTokensSource = "estimate";
        }
        log("info", `[${session.id}] preflight compressed ${result.compressedRanges} range(s), ~${result.savedTokens} tokens saved (${tokenCount} → ${session.stats.lastInputTokens}) in ${Date.now() - started}ms`);
        // Same calibrated caliber as the trigger above — gate, per-round exit
        // and this final fit must judge the payload on one scale (#1933 F1).
        // The baseline anchor above stays raw deliberately: it is a floor for
        // future meters, and a deflated (k̂ < 1) value would only delay the
        // next trigger, never advance it.
        const fits = unknownBaseline
            ? result.fitsWindow
            : applyEstimateCalibration(rebuiltTextSize, kFactor, kOrigin, currentOrigin) + imageTokens < limit;
        // #1820: anchor the meter to the rebuilt payload's measured size — the
        // rebuild request's own usage report (the only sample that can supersede
        // this) hasn't landed yet, and the meter's fallback branches would size
        // on the incoming raw history, firing a phantom EMERGENCY nudge into an
        // already-at-window context. Raw caliber (images included, no k̂
        // deflation) mirrors the fit-gate quantity; lifetime is bounded (see
        // session.ts) so never-reporting upstreams fall back to legacy sizing.
        setPostRebuildAnchor(session, rebuiltTextSize + imageTokens);
        if (fits) return rebuilt;
        // #1839: the two measurements disagree — preflight's own final view
        // (post-fold content + images + wire overhead) fits, but the fresh
        // normal-config rebuild measures over. That divergence produced the
        // self-contradictory fail-fast ("context ~44231 … exceeds window
        // 253725"). Forward once and let the upstream arbitrate (the #496
        // house pattern): a genuinely over-window payload is rejected once
        // and armOverflowShrink recovers with real evidence; a fitting
        // payload is no longer refused on a stale measurement. One forward
        // only — the #330 relaxed-zone caveat still bounds the risk.
        if (!unknownBaseline && result.failure?.kind !== "aborted" && result.payloadEstimate < limit) {
            log("warn", `[${session.id}] preflight view fits (~${result.payloadEstimate}/${limit}) but the rebuilt payload measures over — forwarding once for upstream arbitration (#1839)`);
            return rebuilt;
        }
    } else if (unknownBaseline
        ? result.fitsWindow
        : estimateCoreMessages(prepared.processedMessages) + overheadEstimate + imageTokens < limit) {
        // [#autoFold] A growth-armed payload fits the real window by definition,
        // so a zero-progress fold is not an error — but it does mean the chain
        // could not deliver at all. Arm the cooldown right here (the arm branch
        // below is unreachable from this path — it sits after this return) so
        // classic nudges resume instead of re-attempting the dead chain every
        // turn. The arm is deliberately NOT gated on the calibrated payload:
        // a calibration straddle (estimate < limit <= calibrated) used to skip
        // it, re-firing the trigger every turn with a guaranteed-400 forward
        // and no recovery (PR #2581 review) — now the straddle arms too, and
        // the forwarded request's 400 arms overflow-shrink with real evidence.
        // Exception (#2662): when NO attempt was ever dispatched the chain did
        // not fail — the shared pool dropped every batch in the queue, which
        // clears on its own; backing off here would cost 10 minutes of
        // auto-fold exactly while the host is congested.
        if (growthArmed) {
            if (queueDroppedAll) {
                log("warn", `[${session.id}] auto-fold made no progress (0 range(s) folded) — no summary attempt was ever dispatched (shared pool saturated / deadline expired before dispatch); congestion, not a chain failure — NOT backing off, auto-fold retries next turn (#2662); forwarding as-is (estimate fits the model window ${limit})`);
            } else {
                log("warn", `[${session.id}] auto-fold made no progress (0 range(s) folded) — forwarding as-is (estimate fits the model window ${limit}); backing off auto-fold for ${Math.round(AUTO_FOLD_BACKOFF_MS / 60_000)}m so classic nudges resume`);
                armAutoFoldBackoff(session);
                markDirty(session);
            }
        } else {
            log("warn", `[${session.id}] preflight made no progress but the payload fits; forwarding as-is`);
        }
        return prepared;
    }
    const f = result.failure;
    if (f?.kind === "aborted") {
        log("warn", `[${session.id}] preflight aborted (${f.detail}); not forwarding`);
        return { failFast: true, status: 0, message: f.detail, retryable: false, respond: false };
    }
    // [#autoFold] fail-fast is an OVERFLOW concept: a growth-armed payload
    // fits the real window by definition, so a fold that could not reach the
    // lean target forwards anyway — the session stays functional and the
    // next growth-armed request retries the fold (a dead-end cooldown is
    // never armed for growth: the key comparison paths above returned
    // earlier, and the contentDeadEnd arm below is unreachable from here).
    // Exception (#2662): pure queue drops (no attempt dispatched) are pool
    // congestion, not a chain failure — they skip the cooldown so the very
    // next turn retries instead of idling 10 minutes.
    if (growthArmed && payloadFitsWindow) {
        if (queueDroppedAll) {
            log("warn", `[${session.id}] auto-fold did not reach the growth target ${compressionTarget} (${result.compressedRanges} range(s) folded) — no summary attempt was ever dispatched (shared pool saturated / deadline expired before dispatch); congestion, not a chain failure — NOT backing off, auto-fold retries next turn (#2662); forwarding anyway (payload fits the model window ${limit})`);
        } else {
            log("warn", `[${session.id}] auto-fold did not reach the growth target ${compressionTarget} (${result.compressedRanges} range(s) folded) — forwarding anyway (payload fits the model window ${limit}); backing off auto-fold for ${Math.round(AUTO_FOLD_BACKOFF_MS / 60_000)}m so classic nudges resume`);
            armAutoFoldBackoff(session);
            markDirty(session);
        }
        return outbound;
    }
    // #1800: still over-window after compression, but the residual excess is carried
    // ENTIRELY by the image estimate (text+overhead fits on its own) and we hold no
    // upstream overflow evidence. Forward for the upstream to arbitrate billing
    // instead of fail-fasting a payload whose real bill likely fits (#496). The text
    // portion was already folded above when foldable; we do NOT re-loop.
    if (imageArbitration) {
        // Same fallback as the fit-gate measurement above: processedMessages
        // empty ⇒ kernel transform failure ⇒ the raw body rides.
        const outMsgs = outbound.processedMessages.length > 0 ? outbound.processedMessages : outbound.originalMessages;
        const outText = estimateCoreMessages(outMsgs);
        if (outText + overheadEstimate < limit && outText + overheadEstimate + imageTokens >= limit) {
            log("info", `[${session.id}] preflight folded ${result.compressedRanges} range(s) but images alone (~${imageTokens} tokens) keep the estimate over window ${limit} with no upstream overflow evidence — forwarding for the upstream to arbitrate billing (#496/#1800)`);
            return outbound;
        }
    }
    // The payload still overflows the window: fail fast with a diagnostic
    // error instead of forwarding a guaranteed-400 payload (#301).
    const status = f?.kind === "upstream" && f.status === 429 ? 503 : 502;
    // #2189: an explicit retryable=false from preflight (credential-shape
    // rejection — deterministic for the identical payload) overrides the
    // status-based heuristic below; every other path keeps today's mapping.
    const retryable = f?.retryable === false ? false : f?.retryable === true || (f?.kind === "upstream" && f.status !== undefined && (f.status === 429 || f.status >= 500));
    const ff = failFast(status, f?.detail ?? "the payload still exceeds the window after preflight compression", retryable, result.compressedRanges > 0 ? session.stats.lastInputTokens : undefined, result.rangesRemaining);
    const contentDeadEnd = f?.kind === "exhausted" || (f?.kind === "upstream" && f.status !== undefined && f.status >= 400 && f.status < 500 && !retryable);
    if (contentDeadEnd && result.compressedRanges === 0) {
        const cooldownMs = preflightDeadEndCooldownMs();
        if (cooldownMs > 0) {
            ff.message += ` Preflight will not call the upstream again for the next ${Math.max(1, Math.round(cooldownMs / 60_000))}m for this identical request. Change the request or wait for the cooldown before retrying.`;
            session.metadata.preflightDeadEnd = { key: deadEndKey, until: Date.now() + cooldownMs, status: ff.status, retryable: ff.retryable, message: ff.message };
            markDirty(session);
        }
    }
    return ff;
}

// Host-injected contextual user fragments: machine-generated context sent as
// USER-role messages ahead of the first real question (codex: AGENTS.md
// instructions, environment context). Using one as the session title locks the
// title to launch boilerplate forever (#2118). Evidence-permitlist mirroring
// codex's own type_markers (openai/codex codex-rs/context-fragments/src/fragment.rs
// matches_marked_text: trimmed text starts with open AND ends with close, ASCII
// case-insensitive) — extend only with source evidence, never keyword filters.
const CONTEXTUAL_USER_FRAGMENT_MARKERS: ReadonlyArray<readonly [string, string]> = [
    ["# AGENTS.md instructions", "</INSTRUCTIONS>"],
    ["<environment_context>", "</environment_context>"],
];

function asciiCI(hay: string, needle: string): boolean {
    if (hay.length !== needle.length) return false;
    for (let i = 0; i < hay.length; i++) {
        const h = hay.charCodeAt(i);
        const n = needle.charCodeAt(i);
        if (h === n) continue;
        const hl = h >= 65 && h <= 90 ? h + 32 : h;
        const nl = n >= 65 && n <= 90 ? n + 32 : n;
        if (hl !== nl) return false;
    }
    return true;
}

export function isContextualUserFragment(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    return CONTEXTUAL_USER_FRAGMENT_MARKERS.some(([open, close]) =>
        asciiCI(t.slice(0, open.length), open) && asciiCI(t.slice(t.length - close.length), close));
}

// Host-injected notification user fragments (dsh / deepseek-harness): machine-
// generated notices spliced into the conversation as USER-role messages ahead
// of the first real question — using one locks the set-once title to launch
// boilerplate forever (#2286). Same evidence-permitlist discipline as #2118 —
// extend only with source evidence, never keyword filters. Sources
// (deepseek-ai/deepseek-harness, MIT):
//   packages/interaction/user-approval/src/index.ts:
//     `The approval policy changed from "${previous}" to "${policy}" ...`
//   packages/core/system-prompt/src/index.ts joinContextSections +
//   packages/core/agent-loop/src/runtime-context.ts CLEARED:
//     `Current runtime context ...`
//   packages/context/time-context/src/index.ts:
//     `Time sampled while preparing turn N, step M: <ts>` — its
//     `Browser time zone for this request:` line is embedded in that ONE
//     message, never sent standalone, so no separate prefix for it.
const AUTO_INJECTED_NOTIFICATION_PREFIXES: ReadonlyArray<string> = [
    "The approval policy changed from",
    "Current runtime context",
    "Time sampled while preparing turn",
];

export function isAutoInjectedNotification(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    return AUTO_INJECTED_NOTIFICATION_PREFIXES.some((p) => asciiCI(t.slice(0, p.length), p));
}

/** Derive a short human-readable title from the first real user text message.
 *  Used so the web UI can show "Fix auth bug" instead of an opaque hash.
 *  Contextual fragments (#2118) and host-injected notifications (#2286) are
 *  skipped — if no real question has arrived yet, no title is set and
 *  derivation retries on later requests. */
export function deriveTitle(messages: CoreMessage[]): string | undefined {
    for (const m of messages) {
        if (m.role !== "user" || m.contentType !== "text") continue;
        const raw = m.text ?? "";
        if (!raw.trim()) continue;
        if (isContextualUserFragment(raw)) continue;
        if (isAutoInjectedNotification(raw)) continue;
        const clean = raw.replace(/\s+/g, " ").trim();
        return clean.length > 60 ? clean.slice(0, 57) + "\u2026" : clean;
    }
    return undefined;
}

// #1206: orphan reaping was silent — blocks deactivated because their source
// messages vanished from client history are the strongest runtime signal that
// something outside bili (client auto-compaction or another compression plugin)
// rewrote the conversation. Log it and record it in the session ledger.
export function reapOrphansLogged(session: Session, msgs: CoreMessage[], log: (level: string, msg: string) => void, sessionId: string): void {
    const { reaped } = reapOrphanBlocks(session, msgs, deactivateBlock);
    if (reaped.length === 0) return;
    log("warn", `[${sessionId}] orphan-gc deactivated ${reaped.length} block(s) whose source messages left the client history (${reaped.join(", ")}) — the client or another compression plugin deleted summarized content; those summaries can no longer be decompressed (#1206)`);
    recordConflict(session, "orphan-reap", `${reaped.length} block(s) deactivated: ${reaped.join(", ")}`);
}

export function headerValue(req: http.IncomingMessage, name: string): string | undefined {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
    }
    return undefined;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MiB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GiB`;
}

// #903: per-request local-cost line, logged at every point where bili finishes
// its own processing and hands the request off (upstream forward, forged local
// response, or fail-fast error) — see handle(). outbound is the exact body value
// handed to forward() (string OR Buffer — Prepared.body is string|Buffer); wire
// bytes are counted with Buffer.byteLength since undici sends UTF-8 bytes even
// for string bodies (.length would count UTF-16 chars and undercount any
// non-ASCII injection). Omitted on paths that fail fast without forwarding.
export function logRequestCost(log: (level: string, msg: string) => void, sessionId: string, msgs: number | null, inboundBytes: number, t0: number, outbound?: string | Buffer): void {
    const ms = Math.max(0, Math.round(performance.now() - t0));
    const outboundField = outbound !== undefined ? `, outbound=${formatBytes(Buffer.byteLength(outbound))}` : "";
    const view = currentFetchTransport() ? ", view=ws-expanded" : "";
    log("info", `[${sessionId}] request: ${msgs ?? "?"} msgs, inbound=${formatBytes(inboundBytes)}${outboundField}, local=${ms}ms${view}`);
}

/** Thrown by readBody when the request body exceeds MAX_REQUEST_BYTES.
 *  handle() catches this and attempts a 413 response; readBody also destroys
 *  the request socket so a client that keeps streaming a pathological body
 *  cannot hold the connection open. */
export class BodyTooLargeError extends Error {
    constructor(public readonly limit: number) {
        super(`request body exceeds ${limit} bytes`);
        this.name = "BodyTooLargeError";
    }
}

export function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let aborted = false;
        req.on("data", (c: Buffer) => {
            if (aborted) return;
            size += c.length;
            if (size > MAX_REQUEST_BYTES) {
                aborted = true;
                req.destroy();
                reject(new BodyTooLargeError(MAX_REQUEST_BYTES));
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => { if (!aborted) resolve(Buffer.concat(chunks)); });
        req.on("error", (e) => { if (!aborted) reject(e); });
    });
}

function logMsg(opts: ProxyOptions, level: string, msg: string): void {
    if (!opts.log) return;
    loggerLog(level, msg);
}

export { getUnrecognizedPathStats, logDumpFailure, logUnrecognizedPath } from "./server/observability.js";
export { BILI_HOP_HEADER, parseLauncherModelWindows, anthropicBetaContextWindow, capRegistryWindowByStandard, expandedContextSuffixWindow } from "./server/context-window.js";
export { BILI_TOOL_NAMES, isSideRequest, outputBudgetField, restoreOutputBudget, sideRequestGuard, stripLeakedBiliTools, _resetNoOutputCeilingWarningsForTest, type OutputBudgetField } from "./server/side-request.js";
export { countSystemAndToolsTokens, estimateInputTokens, estimateWireOverhead, clampOutputBudget, emergencyNudge, projectThinkingMass, type ThinkingMassInput } from "./server/budget.js";
