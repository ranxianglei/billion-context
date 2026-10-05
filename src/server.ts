import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createCore, type CompressionCore, type CompressionState, type Config, type AbsorbConfig, type CoreMessage, type NudgeDecision, type Prompts, type PackSurface, type ToolPrompts, applyAcpToolOverrides, defaultPrompts, defaultCountTokens, renderNudgeText, deactivateBlock, viableRanges, resolveOutputSteeringConfig } from "acp-kernel";
import { DEFAULT_STRIP_IMAGES_KEEP_RECENT, applyCompressSettings, resolveAbsorbSettings, resolveCompress, resolveCompressPrompts, resolveCompressSurfaceDetailed, resolveRequestConfig } from "./compress-settings.js";
import { dropCompressReasoning, type CompressReasoningConfig } from "./reasoning-drop.js";
import type { CompressSettings, ProxyOptions, ResignSettings } from "./config.js";
export type { ProxyOptions } from "./config.js";
import { loadOptions, loadRoutes } from "./config.js";
import { resetProxyCache } from "./upstream-proxy.js";
import { FALLBACK_EFFECTIVE_WINDOW_FLOOR, findRoute, lookupContextLimit, resolveConfiguredContextLimit, resolveConfiguredOutputLimit, resolveCompressProtocol, resolveDeclaredProtocol, resolveResignSettings } from "./config.js";
import { contextFromRegistry, loadRegistry, peekRegistryContext, peekRegistryOutputLimit, peekRegistryPriceProfile } from "./registry.js";
import { codexAlignedWindow } from "./codex-models.js";
import { fetchWithTimeout, fetchWithTransportRetry, MAX_REQUEST_BYTES, upstreamTimeoutMs } from "./fetch-util.js";
import { formatUpstreamError, getUpstreamConnectionStatus, recordUpstreamConnection, resolveProxy, resolveProxyDecision, proxyDispatcher, type UpstreamProxyDecision } from "./upstream-proxy.js";
import { clearUpstreamAlertsForHost, getUpstreamAlerts, recordUpstreamAlert } from "./upstream-alerts.js";
import { CREDENTIAL_HEADER_RE, maskHeaderForLog, maskHeadersForLog, maskHostPortForLog, setMaskHostsEnabled, maskUrlForLog, maskUrlsInText } from "./log-mask.js";
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
    subagentNamespace,
} from "acp-kernel/wire";
import { responsesToCoreWithToolImages as responsesToCore, patchResponsesInputWithToolImages as patchResponsesInput, mergeAdjacentConfigurationUpdates } from "./responses-tool-output.js";
import { reconcileFoldCoverage, noteSystemPromptFingerprint, resolveFoldReconcileMode } from "./fold-reconcile.js";
import { diagnoseSuccessWithoutUsage, getSession, hasProcessedState, listSessions, peekSession, type PendingRetrieval, type Session, initSessions, markDirty, flushAllSessions, acquireInFlight, releaseInFlight, totalInFlight, withSessionLock, markNativeCompactionBoundary, reconcileNativeCompactionBoundary, snapshotMessages, applyCompactionArchive, detectUnannouncedHistoryRewrite, markCompactionBoundary, storeEffectiveConfig, foldCoverage, REWRITE_MIN_INCOMING_TOTAL } from "./session.js";
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
import { ABSORB_TOOL_NAME, COMPRESS_TOOL, BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE, BILI_ACP_TOOLS_GOOGLE, BILI_ACP_TOOLS_GOOGLE_NO_RANGE, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_OPENAI_NO_RANGE, BILI_ACP_TOOLS_RESPONSES, BILI_ACP_TOOLS_RESPONSES_NO_RANGE, BILI_ACP_READONLY_TOOLS_RESPONSES, BILI_ACP_READONLY_TOOLS_RESPONSES_NO_RANGE, COMPRESS_TOOL_NAME, IMAGE_FULL_TOOL, IMAGE_FULL_TOOL_GOOGLE, IMAGE_FULL_TOOL_OPENAI, IMAGE_FULL_TOOL_RESPONSES, RULE_TOOL, RULE_TOOL_GOOGLE, RULE_TOOL_OPENAI, RULE_TOOL_RESPONSES, absorbToolsFor, retrieveToolsFor, buildAbsorbSystemPrompt, buildAcpTagsOnlyPrompt, buildCompressSystemPrompt, buildCompressHybridSystemPrompt, withMarkerIntegrityNote, withStagedCompressGuidance, withSummaryBudgetNote } from "./compress-tool.js";
import { applyAbsorbView, absorbEnabled, absorbToolName, storeEffectiveAbsorb } from "./absorb.js";
import { adoptContentStore, ccrEnabled, ccrLoopConfig, ccrPluginWireOk, commitRetrievals, commitRetrievalNotes, contentStoreOf, dropRetrievals, executeRetrieve, pruneExpiredRetrievals, reconcileReloadedRetrievals, renderRetrievalNotes, retrieveToolName, snapshotPendingRetrievals, snapshotRetrievalNotes, storeEffectiveCcr, type CcrSettings } from "./store.js";
import { applyImageCompressionPass, imageCompressionEnabled, imageFullTrailingNote, imageUsageSuffix, storeEffectiveImageCompression, type ImageCompressionSettings } from "./image-compress.js";
import { rulesEnabled, storeEffectiveRules } from "./rules-feature.js";
import { storeEffectiveSearchPlanAware } from "./decompress-shared.js";
import { rewriteJsonResponse, type RewriteCtx } from "./stream.js";
import { applyRanges } from "./stream.js";
import { attachSubagentSessions } from "./subagent-sessions.js";
import { buildSessionCacheReport, handleAcpCache, learnedImageReserve, noteClientAbort, noteForwardedBody, noteForwardedImageFacts, readModelSwitchStats, settleUsageReport } from "./cache-ledger.js";
import { warnCacheCollapse } from "./cache-warn.js";
import { preflightCompress, estimateCoreMessages, estimateCoreMessagesUpper, estimateRawBodyTokens, type PreflightResult } from "./preflight.js";
import { gcConfigFromEnv, gcSessionFiles } from "./session-gc.js";
import { countImagesInParsedBody, countImagesInRawBody, imageTokensInRawBody, imageTokensInParsedBody, resolveImageBilling, upstreamHost, type ResolvedImageBilling } from "./image-tokens.js";
import { APIG_RESIGN_HEADER, APIG_RESIGN_CREDENTIAL_HEADER, APIG_RESIGN_SCHEME, decodeApigCredential, inboundSignedScheme, resignApig, signedRefusal } from "./apig-resign.js";
import { renderUI, handleConfigGet, handleConfigPut, buildOverview, buildSessionList, buildSessionDetail, hiddenEmptyCount } from "./web/index.js";
import { reapOrphanBlocks } from "./orphan-gc.js";
import { conflictScanEnabled, isDesignBenign, scanClientPlugins, sniffScanClient } from "./thirdparty-scan.js";
import { clearConflictEvents, recordConflict, summarizeConflicts } from "./conflict-watch.js";
import { getStore } from "./persist.js";
import { log as loggerLog, configureLogger, getLogPath, closeLogger, isStreamWriteError, isBenignSocketRaceError, enterSessionContext } from "./logger.js";
import { queryLogLines } from "./web/logs-query.js";
import { configFile, defaultLogFile, dumpsDir, stateDir } from "./paths.js";
import { atomicWriteInstanceFile, clearProxyInstanceFile, entryScriptFingerprint, findSameLanePredecessor, isPidAlive, listInstances, registerInstanceAndWarn, unregisterInstance, type ProxyInstanceFile } from "./instance.js";
import { compressLoopResponsesJson } from "./compress-loop-responses.js";
import { hoistTrappedToolItems } from "./tool-pair-order.js";
import { runCompressLoop, pickAdapter } from "./loop/index.js";
import { computeAnthropicMessageMarks, stampAnthropicSystemCacheControl, anthropicToolsCarryCacheControl } from "./loop/cache-control.js";
import { reconcileSystemAnchor } from "./system-anchor.js";
import { containsToolCallXmlFragment } from "./loop/tag-echo-filter.js";
import { isStrictReasoningEcho, modelIdOf, normalizeStrictEchoReasoning, normalizeStrictEchoResponsesInput } from "./strict-echo.js";
export { isStrictReasoningEcho, normalizeStrictEchoReasoning, normalizeStrictEchoResponsesInput };
import { isFakeCompletion, injectFakeCompletionHint, maxFakeCompletionRetries, fakeBufCap } from "./fake-completion.js";
import { makeContinuationRefetch } from "./degenerate-retry.js";
import { reasoningGuardEngages, runReasoningGuard } from "./reasoning-guard.js";
import { sanitizeResponsesInputIds, dropWhitespaceResponsesMessages, normalizeResponsesMessageItems } from "./loop/adapter-responses.js";
import { CODEX_COMPACT_HEALTH_RATIO, codexCompactMode, isCodexClient, hasCompactionTrigger, stripBiliCompactionItems, replaceBiliCompactionItems, codexCompactGate, codexCompactGatePre, buildTriggerForgeBody, mergeForgedSummaries } from "./codex-compact.js";
import { stripAcpPanelMessages, stripAcpPanelResponsesInput, stripAcpStatusMarkers } from "./acp-panel.js";
import { rewriteOpenaiJsonResponse } from "./stream-openai.js";
import { rewriteGoogleJsonResponse } from "./stream-google.js";
import { rewriteResponsesJsonResponse } from "./stream-responses.js";
import { observeResponsesTerminalState } from "./stream-terminal.js";
import { emitPreflightError, emitStreamError } from "./stream-error.js";
import { affinityToken, claudeSubagentAgentId, claudeSubagentSplit, clientConversationHeader, codexTurnIdentity, dshPersonaFingerprintApplies, instructionsFingerprintApplies, openaiSystemTextForPersona, preferPromptCacheKeyIdentity, type ConversationIdentity } from "./session-id.js";
import { prefixAffinity, type AnonymousAffinity } from "./prefix-affinity.js";
import { maybeAdoptForkBlocks, maybeAdoptResume } from "./fork-adoption.js";
import { publicForkInputMatches } from "./plugin.js";
import { flushPrefixAffinity, hydratePrefixAffinity, scheduleAffinityPersist } from "./affinity-persist.js";
import { consumePluginRegisterFor, flushConversations, handlePluginCompact, handlePluginManifest, handlePluginFork, handlePluginSnapshot, handlePluginRegister, handlePluginRuntimeInfo, handlePluginStatus, handlePluginTool, isPluginFoldCallId, loadConversations, pipePluginChatWithStrip, pipePluginJson, pipePluginResponsesWithStrip, pluginAgentHeader, pluginConversationHeader, pluginHeadersMatchModel, pluginReportedContextWindow, pluginReportedMaxOutput, pluginRequestAgentHeader, pluginRuntimeInfoFor, pluginRuntimeInfoForConversation, recordChainVerdict, recordPluginSession, rememberPluginMessages, resolveConversation, runtimeConversationId, takePendingPluginRegister } from "./plugin.js";
import { setupMitm, readMitmUpstream, getBlindTunnelStats, liveBlindTunnels, MITM_RAW_SOCKET_KEY } from "./mitm.js";
import { evaluateChain, extractChainCarriers, stampOutbound, stripEmbeddedChainCarriers } from "./chain-checkpoint.js";
import type { BiliMessage } from "acp-kernel/wire";
import { appendSystemText, applyEstimateCalibration, BILI_PASSTHROUGH_HEADER, BILI_PLUGIN_BYPASS_HEADER, hardenOpenaiAssistantContent, isLoopbackAddress, inspectContextOverflow, normalizeUpstreamOrigin, reserveOutputHeadroom, resolveOutputHeadroomCap, shouldReserveOutputHeadroom, systemToUser, usageOutputTotal, usageTotals, strippedResponseIdWarning, type ContextOverflowInfo, type WireProtocol } from "./util.js";
import { safePrefix, safeSuffix } from "./text-safe.js";

import { BILI_TUNNEL_HEADER, checkTunnelDestination, classifyIp, localMachineIps, normalizeIpLiteral, parseIpLiteral, tunnelAllowlistFromEnv } from "./tunnel-guard.js";
import { dumpRejectedBody } from "./error-dump.js";

import { decodeRequestBody, DecompressedTooLargeError } from "./content-encoding.js";
import { applyCompatRoles, applyCompatRolesJson, detectRoleRejection, detectSystemPlacementError, hasOffHeadSystem, resolveCompatRoles, type CompatRoles } from "./compat-roles.js";
import { applyCompatDropFields, dropCompatFieldsJson, resolveCompatDropFields } from "./compat-drop.js";
import { applyOutputSteering, applyOutputSteeringJson } from "./output-steering.js";
import { bodyDumpEnabled, getUnrecognizedPathStats, isModelDiscoveryPath, logDumpFailure, logUnrecognizedPath } from "./server/observability.js";
import {
    clientErrorBackstopMs as knobClientErrorBackstopMs,
    countTokensPassthrough as knobCountTokensPassthrough,
    dumpReqAllowed as knobDumpReqAllowed,
    exposureLogIntervalMs as knobExposureLogIntervalMs,
    forceTextProtocol as knobForceTextProtocol,
    keepAliveTimeoutMs as knobKeepAliveTimeoutMs,
    keepResponseId as knobKeepResponseId,
    noCompressPrompt as knobNoCompressPrompt,
    noInjectTool as knobNoInjectTool,
    postResponseLingerMs as knobPostResponseLingerMs,
    preflightDeadEndCooldownMs as knobPreflightDeadEndCooldownMs,
    preflightHoldGraceMs as knobPreflightHoldGraceMs,
    rawDumpDir as knobRawDumpDir,
    renderNone as knobRenderNone,
    requestWatchdogBudgetMs as knobRequestWatchdogBudgetMs,
    streamKeepAliveMs as knobStreamKeepAliveMs,
} from "./knobs.js";
import { BILI_HOP_HEADER, anthropicBetaContextWindow, capRegistryWindowByStandard, expandedContextSuffixWindow, LAUNCHER_MODEL_WINDOWS, LAUNCHER_MODEL_MAX_OUTPUTS, launcherContextWindow, launcherMaxOutput, parseLauncherModelWindows, windowSourceLogged } from "./server/context-window.js";
import { buildForwardHeaders, connectionNamedHeaders, NO_IDENTITY_MESSAGE, RESPONSE_ONLY_STRIP_HEADERS, safeSessionId, UPSTREAM_HOP_HEADERS } from "./server/headers.js";
import { installWebSocketBridge } from "./ws-bridge.js";
import { codexResponsesCodec, responsesCodec } from "./responses-ws.js";
import { currentFetchTransport } from "./fetch-transport.js";
import { isSideRequest, outputBudgetField, restoreOutputBudget, SIDE_REQUEST_MAX_TOKENS, sideRequestGuard, stripLeakedBiliTools } from "./server/side-request.js";
import { dshCompactionRefusal, isDshCompactionCall } from "./server/dsh-compaction-guard.js";
import { clampOutgoingOutput, countSystemAndToolsTokens, emergencyNudge, estimateInputTokens, estimateWireOverhead, projectThinkingMass } from "./server/budget.js";
import { awaitDrain, bufferToStream, dumpStreamToFile, pipeThrough, readStreamToBuffer } from "./server/stream-io.js";
import { artifactSeedHit, detectAcpArtifacts } from "./server/chain-artifacts.js";
import { droppedOpenaiParts } from "./wire-drop-warn.js";

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
export const WARNED_WIREDROP_KEY_CAP = 4096;
export function _resetWireDropWarningsForTest(): void {
    warnedWireDropKeys.clear();
}
export function _wireDropWarnSetForTest(): Set<string> {
    return warnedWireDropKeys;
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
const NON_CONVERSATION_RELAY_WARN_CAP = 4096;
const nonConversationRelayWarned = new Set<string>();

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

function registerRequestAbort(res: http.ServerResponse, ac: AbortController): void {
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
export type GooglePathKind = "stream-generate" | "generate" | "count-tokens";

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
    const dispatch = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
        armRequestWatchdog(req, res, log);
        const connRec = connRecords.get(req.socket);
        if (connRec) {
            connRec.requests++;
            res.on("finish", () => { connRec.lastResponseEndAt = Date.now(); });
        }
        try {
            await handle(req, res, opts, core, config, log, instanceId, instanceStartedAt, proxyWatchers, initialWatcherPid);
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
        registerInstanceAndWarn(registryRecord, (msg) => log("warn", `[instances] ${msg}`));
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

type Prepared = {
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
    anthropicCacheMarks?: Map<string, { type: "ephemeral" }>;
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
function imageBillingFor(opts: ProxyOptions, upstreamUrl: string | undefined): ResolvedImageBilling {
    const env = process.env.BILI_IMAGE_BILLING;
    const configured = env === "pixels" || env === "bytes" ? env : findRoute(opts.routes, upstreamUrl)?.imageBilling ?? opts.imageBilling ?? "auto";
    return resolveImageBilling(configured, upstreamUrl);
}

// #1843 L3: per-request per-image token ceiling — per-route imageTokenCap wins
// over the global config level; env BILI_IMAGE_TOKEN_CAP wins over both (the
// env tier is applied inside image-tokens.ts so callers only resolve config).
// 0 = no cap.
function imageTokenCapFor(opts: ProxyOptions, upstreamUrl: string | undefined): number {
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
function resignSettingsFor(opts: ProxyOptions, upstreamUrl: string | undefined, scheme: string = APIG_RESIGN_SCHEME): ResignSettings {
    return resolveResignSettings(process.env, findRoute(opts.routes, upstreamUrl)?.resign, scheme);
}

// #1843 L1: the IMAGE-channel reserve for a payload — the prior-based estimate
// (pixels/bytes per the resolved billing + cap) upgraded to LEARNED truth when
// this session holds fresh usage-learned evidence for this route (per-image
// cost x current image count), else the prior unchanged. Every window gate
// consumes its image mass through here so one learning layer serves them all.
function imageReserveFor(
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

// #1537: reduce a Host-header value or a URL hostname to its bare lowercase
// name — strip a trailing :port and the [..] brackets around an IPv6 literal.
// Returns undefined for empty/unparseable input. The admin-origin gate uses it
// to match on the hostname alone (see isTrustedAdminOrigin).
function normalizeAdminHostname(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const v = value.trim().toLowerCase();
    if (!v) return undefined;
    if (v.startsWith("[")) {
        const end = v.indexOf("]");
        if (end === -1) return undefined;
        return v.slice(1, end);
    }
    // Bare IPv6 literal (no brackets): more than one colon means there is no
    // host:port split to perform — return it untouched.
    if ((v.match(/:/g) ?? []).length > 1) return v;
    const idx = v.lastIndexOf(":");
    if (idx !== -1) return v.slice(0, idx);
    return v;
}

function isTrustedAdminOrigin(origin: string | undefined, host: string | undefined, trustedHostnames: Set<string>): boolean {
    // Host must name one of OUR loopback identities regardless of whether an
    // Origin header is present. A same-origin browser GET/fetch (the DNS
    // rebinding read path: evil.com → 127.0.0.1) often carries NO Origin
    // header, so gating on Origin alone would leave config reads exposed.
    // #1537: match on the bare hostname and IGNORE the port — an SSH forward
    // (ssh -L 18787:127.0.0.1:8787) legitimately presents a different local
    // port while still arriving from loopback. The anti-rebinding property is
    // preserved because an attacker's rebound domain (evil.com) can never equal
    // a loopback NAME; only the port is relaxed.
    const hn = normalizeAdminHostname(host);
    if (!hn || !trustedHostnames.has(hn)) return false;
    if (!origin) return true; // non-browser client (curl, CLI UI) on a trusted Host
    try {
        const parsed = new URL(origin);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
        const ohn = normalizeAdminHostname(parsed.hostname);
        return ohn !== undefined && trustedHostnames.has(ohn);
    } catch {
        return false;
    }
}

/** The set of hostnames we accept on management endpoints. DNS rebinding
 *  (attacker resolves evil.com → 127.0.0.1) can make a browser request carry
 *  Origin == Host == evil.com:port and still reach loopback; only pinning the
 *  Host to a loopback NAME defeats it. #1537: the port is deliberately NOT part
 *  of the identity — SSH port-forwarding (ssh -L <local>:127.0.0.1:<remote>)
 *  changes the local port while the connection still arrives from loopback, so
 *  matching the port would reject every forwarded session. Every previously
 *  accepted Host carried a loopback hostname, so dropping the port admits no
 *  non-loopback identity. */
function adminTrustedHostnames(bindHost: string): Set<string> {
    const names = ["localhost", "127.0.0.1", "::1"];
    const bound = normalizeAdminHostname(bindHost);
    if (bound && bound !== "0.0.0.0" && bound !== "::" && !names.includes(bound)) {
        names.push(bound);
    }
    return new Set(names);
}

// #924: one-time-per-model log for the output-budget fallback (request carries
// no budget → configured/registry max output) — same pattern as windowSourceLogged.
const headroomFallbackLogged = new Set<string>();

// #2096: dedupe the post-reservation effective-window line per model|value —
// the reserved window varies per request (max_tokens), so key on both.
const headroomEffectiveLogged = new Set<string>();

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

async function handle(
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
): Promise<void> {
    // SECURITY: the /__bili/ management endpoints (config read/write, reload,
    // session stats) are privileged — a remote caller who can reach them can
    // rewrite upstream routing to exfiltrate API keys (MITM). Restrict them
    // to loopback connections. The proxy default host is 127.0.0.1 (loopback
    // only), but a user can set --host 0.0.0.0 to share the proxy on a LAN —
    // in that case we still must NOT expose management to the LAN. Only the
    // proxy /bili/ and CONNECT (model traffic) endpoints remain open to all.
    // #1073: an absolute-form request addressed to THIS instance's own endpoint
    // is a fetch of us, not a tunnel — strip the authority so the admin gate
    // below sees a normal origin-form request and answers with real health
    // state instead of 403ing via the tunnel path.
    const selfProbePath = selfAdminProbePath(req.url ?? "", req.socket.localPort);
    if (selfProbePath !== undefined) req.url = selfProbePath;
    const isAdminPath = req.url === "/__bili/" || req.url?.startsWith("/__bili/") || req.url === "/__acp/" || req.url?.startsWith("/__acp/");
    // #409: management must never be reachable THROUGH the bili tunnel, not
    // even from a loopback client: the tunnel's inner connection originates
    // from the proxy itself, so the remoteAddress gate alone is satisfied and
    // a `--host 0.0.0.0` peer could otherwise PUT /__bili/config over the
    // tunnel. forward() stamps this marker on every /bili/ absolute-URL
    // forward; clients have no legitimate reason to send it, and a spoofed
    // value only locks the spoofer out of admin paths.
    if (isAdminPath && headerValue(req, BILI_TUNNEL_HEADER) !== undefined) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "management endpoints are not reachable through the bili tunnel" }));
        return;
    }
    if (isAdminPath && !isLoopbackAddress(req.socket.remoteAddress)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "management endpoints are loopback-only; access denied for " + (req.socket.remoteAddress ?? "unknown") }));
        return;
    }
    // localPort, not opts.port: when listening on port 0 (dynamic assignment,
    // programmatic embedding, tests) the real port differs from opts.port and
    // pinning to the configured value would 403 every admin request.
    if (isAdminPath && !isTrustedAdminOrigin(req.headers.origin, req.headers.host, adminTrustedHostnames(opts.host))) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "management request origin does not match the local bili UI" }));
        return;
    }
    if (req.method === "GET" && req.url === "/__bili/stats") return sendStats(res);
    if (req.method === "GET" && req.url?.startsWith("/__bili/cache-report")) return sendCacheReport(res, req.url);
    if (req.method === "GET" && req.url === "/__bili/status") return sendStatus(res, opts);
    if (req.method === "GET" && req.url === "/__bili/overview") return sendOverview(res, opts);
    if (req.method === "GET" && req.url === "/__bili/sessions") return sendWebSessions(res);
    if (req.method === "GET" && req.url?.startsWith("/__bili/logs")) return sendWebLogs(res, req);
    if (req.method === "GET" && req.url?.startsWith("/__bili/sessions/") && req.url.endsWith("/detail")) return sendWebSessionDetail(res, req.url);
    if (req.method === "GET" && req.url === "/") {
        // Browser visits root → redirect to the web UI. curl / health probes
        // (Accept: */* or no Accept) still get the JSON health check so
        // existing scripts and Docker-style health probes keep working.
        const accept = req.headers.accept ?? "";
        if (accept.includes("text/html")) {
            res.writeHead(302, { location: "/__bili/" });
            res.end();
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, upstream: opts.upstream }));
        return;
    }
    if (req.method === "GET" && req.url === "/__bili/health") {
        res.writeHead(200, { "content-type": "application/json" });
        // #1322: watchdog state is part of the health contract — attachers and
        // operators can see whether this proxy dies with its sessions (armed)
        // or outlives them all (daemon squatting a stable port).
        res.end(JSON.stringify({ ok: true, upstream: opts.upstream, instanceId, pid: process.pid, startedAt: instanceStartedAt, blindTunnels: getBlindTunnelStats(), watchdog: { armed: initialWatcherPid !== null, parentPid: initialWatcherPid ?? undefined, watchers: [...proxyWatchers] } }));
        return;
    }
    // Web config UI (served as HTML, separate from the JSON health check above).
    if (req.method === "GET" && req.url === "/__bili/") {
        const origin = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderUI(origin));
        return;
    }
    if (req.method === "GET" && req.url === "/__bili/config") return handleConfigGet(res);
    if (req.method === "PUT" && req.url === "/__bili/config") {
        return handleConfigPut(req, res, () => {
            const fresh = loadOptions();
            if (fresh.passthrough !== opts.passthrough) {
                log(
                    fresh.passthrough ? "warn" : "info",
                    `[passthrough] ${fresh.passthrough ? "compression turned OFF via web config — forwarding verbatim" : "compression re-enabled via web config"}`,
                );
            }
            opts.passthrough = fresh.passthrough;
            opts.passthroughSource = fresh.passthroughSource;
            opts.proxy = fresh.proxy;
            opts.proxyMode = fresh.proxyMode;
            opts.proxySource = fresh.proxySource;
            opts.proxyFallback = fresh.proxyFallback;
            opts.auxProxyFallback = fresh.auxProxyFallback;
            opts.compress = fresh.compress;
            opts.compat = fresh.compat;
            resetProxyCache();
            for (const k of Object.keys(opts.routes)) delete opts.routes[k];
            Object.assign(opts.routes, loadRoutes());
        }, opts.port);
    }
    if (req.method === "POST" && req.url === "/__bili/config/reload") return handleConfigReload(opts, res, log);
    // #2102: wipe the diagnostic conflict ledgers (global, or one session via
    // ?session=<id>). Loopback + trusted-origin gated like every /__bili/ path.
    if (req.method === "POST" && req.url?.startsWith("/__bili/conflicts/clear")) return handleConflictsClear(req.url, res, log);
    if (req.method === "GET" && req.url === "/__bili/upstream") {
        const target = opts.upstream;
        const decision = resolveProxyDecision(opts.routes, opts.proxy, target, opts.proxyFallback);
        const connection = getUpstreamConnectionStatus();
        const connectionMatchesTarget = (() => {
            if (!connection.url) return false;
            try { return new URL(connection.url).origin === new URL(target).origin; } catch { return false; }
        })();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            target,
            proxy: decision.proxy ?? null,
            source: decision.source,
            mode: opts.proxyMode ?? "auto",
            autoConfigUrl: decision.autoConfigUrl ?? null,
            connected: connectionMatchesTarget ? connection.connected : undefined,
            error: connectionMatchesTarget ? connection.error : undefined,
            checkedAt: connectionMatchesTarget ? connection.checkedAt : undefined,
            connectionUrl: connection.url,
            connectionProxy: connection.proxy,
        }));
        return;
    }
    if (req.method === "POST" && req.url === "/__bili/upstream/test") {
        const target = opts.upstream;
        const targetUrl = new URL(target).origin;
        const proxyUrl = resolveProxyDecision(opts.routes, opts.proxy, target, opts.proxyFallback).proxy;
        try {
            const result = await fetchWithTimeout(targetUrl, {
                method: "HEAD",
                redirect: "follow",
                ...(proxyUrl ? { dispatcher: proxyDispatcher(proxyUrl, 15_000) } : {}),
            }, 15_000);
            result.clearTimer();
            recordUpstreamConnection(targetUrl, proxyUrl);
            // #1682: a successful probe clears active alerts for this host so
            // the banner reflects the fix immediately, without waiting for traffic.
            clearUpstreamAlertsForHost(targetUrl);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, status: result.response.status, target: targetUrl, proxy: proxyUrl ?? null }));
        } catch (error) {
            // #1682: probe failures deliberately do NOT feed the alert table —
            // they are user-initiated diagnostics, not live-traffic evidence.
            recordUpstreamConnection(targetUrl, proxyUrl, error);
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: formatUpstreamError(error, targetUrl, proxyUrl) }));
        }
        return;
    }

    // Cooperative plugin protocol (see src/plugin.ts + PLUGIN.md): the
    // manifest serves the exact tool schemas the wire injector uses, and the
    // tool endpoint lets an agent-side plugin execute compress/decompress/
    // search_context/acp_status against the session the plugin drives. Both
    // live under the /__bili/ loopback + trusted-origin gate above.
    if (req.method === "GET" && req.url === "/__bili/plugin/manifest") {
        // [#1271/#1278] kernelConfig carries no file/global compress settings; resolve the
        // GLOBAL view exactly like the request path does (applyCompressSettings) so every
        // opt-in tool — acp_retrieve (#1271), absorb (#1278) — is advertised exactly when the
        // operator enabled it at the global level. Unset fields floor to kernel defaults
        // (DEFAULT_CCR_CONFIG et al. inside applyCompressSettings); per-request/route overrides
        // are still enforced at execution time, so the manifest stays conservative as #1192
        // requires. Do not "simplify" this back to `config`.
        return handlePluginManifest(res, applyCompressSettings(config, opts.modelContextLimit, opts.compress));
    }
    if (req.method === "GET" && req.url?.split("?")[0] === "/__bili/plugin/snapshot") {
        return await handlePluginSnapshot(new URL(req.url, "http://localhost").searchParams.get("conversationId") ?? "", res);
    }
    if (req.method === "POST" && req.url === "/__bili/plugin/fork") {
        try {
            return await handlePluginFork((await readBody(req)).toString("utf8"), res);
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, code: "INVALID_REQUEST", error: String(err) }));
            return;
        }
    }
    if (req.method === "GET" && req.url?.startsWith("/__bili/plugin/status")) {
        const query = req.url.slice(req.url.indexOf("?") + 1);
        const params = new URLSearchParams(query);
        const conversationId = params.get("conversationId")?.trim() ?? "";
        if (!conversationId) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "conversationId query parameter is required" }));
            return;
        }
        // Web UI origin as the user's browser dials it: the ACTUAL bound port
        // (req.socket.localPort differs from opts.port when listening on port 0).
        const webOrigin = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${req.socket?.localPort ?? opts.port}`;
        return handlePluginStatus(conversationId, res, { core, config, log, webOrigin }, params.get("fallback") === "latest");
    }
    if (req.method === "POST" && req.url === "/__bili/watcher") {
        // #7: an ATTACHING claude session registers its host pid so the shared
        // proxy outlives the first spawner's exit. Only proxies started in
        // parent-watch mode (BILI_PARENT_PID) take watchers — daemons stay
        // daemons, and a rejected registration leaves behavior unchanged.
        try {
            const body = await readBody(req);
            const parsed = JSON.parse(body.toString("utf8")) as { pid?: unknown };
            const pid = parsed.pid;
            if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "expected { pid: <integer> }" }));
            } else if (initialWatcherPid === null) {
                res.writeHead(409, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "watchdog not armed (no parent pid) — this proxy does not take watchers" }));
            } else {
                proxyWatchers.add(pid);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, watchers: proxyWatchers.size }));
            }
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    if (req.method === "POST" && req.url === "/__bili/plugin/tool") {
        try {
            const body = await readBody(req);
            const webOrigin = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${req.socket?.localPort ?? opts.port}`;
            return await handlePluginTool(body.toString("utf8"), res, { core, config, log, webOrigin });
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    if (req.method === "POST" && req.url === "/__bili/plugin/register") {
        try {
            const body = await readBody(req);
            handlePluginRegister(body.toString("utf8"), res);
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    if (req.method === "POST" && req.url === "/__bili/plugin/runtime-info") {
        try {
            const body = await readBody(req);
            handlePluginRuntimeInfo(body.toString("utf8"), res);
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    if (req.method === "POST" && req.url === "/__bili/plugin/compact") {
        try {
            const body = await readBody(req);
            handlePluginCompact(body.toString("utf8"), res);
            return;
        } catch (err) {
            res.writeHead(err instanceof BodyTooLargeError ? 413 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
            return;
        }
    }
    // Unknown /__bili/ or /__acp/ path → 404 locally. These are bili's own
    // management prefixes; forwarding would leak the internal path to the
    // upstream (which 403s it) — #346.
    if (isAdminPath) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "not_found", message: "no such management endpoint" } }));
        return;
    }

    // NOTE: WebSocket upgrades are answered by the dedicated 'upgrade' listener
    // in startServer() (above), which is the only reliable path — Node routes
    // upgrade requests there and never to this request handler.
    let bodyBuffer: Buffer;
    let urlPath: string;
    let responsesCompact: boolean;
    let route: ReturnType<typeof resolveUpstream>;
    let upstreamOrigin: string;
    let protocol: WireProtocol | null;
    /** Gemini's model, resolved from the request path (its body never carries
     *  one). Undefined for every other protocol. */
    let googleModel: string | undefined;
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
        // Issue #99: decode body only for known protocols — passthrough requests
        // (e.g. GET /models) must forward raw bytes without content-encoding decode.
        if (!passthroughMark && protocol !== null && bodyBuffer.length > 0) {
            try {
                const decoded = await decodeRequestBody(headerValue(req, "content-encoding"), bodyBuffer, MAX_REQUEST_BYTES);
                bodyBuffer = decoded.body;
                if (decoded.decoded) delete req.headers["content-encoding"];
            } catch (decErr) {
                if (decErr instanceof DecompressedTooLargeError) throw decErr;
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
        if (err instanceof BodyTooLargeError || err instanceof DecompressedTooLargeError) {
            log("warn", `413: request body exceeds ${err.limit} bytes`);
            res.writeHead(413, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { type: "request_too_large", message: err.message } }));
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
    if (protocol && bodyBuffer.length > 0) {
        try {
            parsed = JSON.parse(bodyBuffer.toString("utf8"));
        } catch {
            parsed = null;
        }
    }
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
    // except Gemini, whose URL path holds it (`/v1beta/models/<model>:…`).
    const bodyModel = parsed && typeof parsed === "object" && "model" in parsed && typeof parsed.model === "string" ? parsed.model : undefined;
    const requestModel = bodyModel ?? googleModel;
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
    let resolvedImageCompressionCfg: ImageCompressionSettings | undefined;
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
            const embeddedUrl = route?.rewrittenUrl;
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
            reqConfig = resolveRequestConfig(config, opts.routes, embeddedUrl, model, native, opts.compress);
            {
                const wsSource = betaWindow ? "anthropic-beta" : suffixWindow ? "model-suffix" : pluginWindow ? "plugin" : runtimeWindow ? "runtime-info" : launcherWindow ? "launcher" : configuredWindow ? "configured" : peekWindow ? "registry-peek" : native ? "table-or-registry" : "default";
                wsSourceForLog = wsSource;
                if (!windowSourceLogged.has(model)) {
                    windowSourceLogged.add(model);
                    // #2096: label what this value IS — the pre-reservation base.
                    // The output-headroom reservation below shrinks
                    // reqConfig.modelContextLimit per request; its result gets
                    // its own [headroom] line so one label can't carry two values.
                    log("info", `[window] model=${model} source=${wsSource} native=${native ?? "none"} base=${reqConfig.modelContextLimit} launcher=${launcherWindow ?? "none"} configured=${configuredWindow ?? "none"} peek=${peekWindow ?? "none"} fallback=${nativeFromFallback}`);
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
            resolvedNativeWindow = native;
            // #321 PR-E1: a codex client carries its OWN window perception
            // (bundled model table + 272K unknown-model fallback) and
            // auto-compacts at 90% of it. If bili's budget exceeds what codex
            // believes, codex's native compaction fires first — the #292
            // misalignment. Cap the effective window at codex's perception.
            // An operator's explicit compress.modelContextLimit is exempt
            // (operator tuning is owned by the operator — never floored and
            // never clamped); the clamped value is authoritative for this
            // client (codex's own config), so it also clears the
            // low-confidence fallback flag.
            const aligned = operatorWindowTuned
                ? { limit: reqConfig.modelContextLimit, clamped: false }
                : codexAlignedWindow(reqConfig.modelContextLimit, model, req.headers);
            if (aligned.clamped) {
                const before = reqConfig.modelContextLimit;
                reqConfig = { ...reqConfig, modelContextLimit: aligned.limit };
                nativeFromFallback = false;
                windowShrinkReason = "codex";
                log("info", `[codex] effective window clamped ${before} → ${aligned.limit} (codex's own perception for model=${model}; ACP now compresses before codex's native auto-compact)`);
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
        resolvedImageCompressionCfg = compressCfg.imageCompression;
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
    const routePassthrough = !opts.passthrough && findRoute(opts.routes, route?.rewrittenUrl)?.passthrough === true;
    if (routePassthrough && hopMarker === undefined && protocol && parsed) {
        log("info", `[route-passthrough] ${maskUrlsInText(route?.rewrittenUrl ?? "")} matches a passthrough route — forwarding verbatim, kernel bypassed`);
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
        const googleIdentity = protocol === "google"
            ? {
                  value: googleSignal,
                  source: convHeader ? ("header" as const) : ("content-fingerprint" as const),
                  clientProvided: !!convHeader,
              }
            : undefined;
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
              : "";
        const conversation = protocol === "google"
            ? (googleIdentity?.value ?? googleSignal)
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
                  : dshPersona
                    ? subagentNamespace(anthropicIdentity?.value ?? anthropicSignal, personaSystemText)
                    : anthropicIdentity?.value ?? anthropicSignal)
            : protocol === "openai"
              ? (dshPersona
                    ? subagentNamespace(openaiIdentity?.value ?? openaiSignal, personaSystemText)
                    : openaiIdentity?.value ?? openaiSignal)
              : codexTurn
                // Trusted Codex turn id enters the verbatim session chain
                // directly — do NOT route it through subagentNamespace (the
                // kernel's empty-instructions non-anchoring path is left
                // untouched for metadata-less clients).
                ? codexTurn.value
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
                     ? subagentNamespace(
                           responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader),
                           (parsed as ResponsesRequestBody).instructions,
                       )
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
              : undefined;
        const personaForked = rawPersonaIdentity !== undefined && conversation !== rawPersonaIdentity;
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
            if (anonAffinity.matchedDepth > 0) {
                log("info", `[prefix-affinity] anonymous ${protocol} request → session ${anonAffinity.sessionId} (prefix match depth=${anonAffinity.matchedDepth}/${anonAffinity.incomingDepth}, tail=${anonAffinity.tailHash.slice(0, 8)}; fork semantics: diverged histories split on their next request)`);
                loggerLog("info", `[prefix-affinity] session ${anonAffinity.sessionId} matched at depth ${anonAffinity.matchedDepth}/${anonAffinity.incomingDepth} (tail=${anonAffinity.tailHash.slice(0, 8)})`);
            } else {
                const lineage = anonAffinity.lineage ? `; lineage=${anonAffinity.lineage.reason} of ${anonAffinity.lineage.parents.join(",")}` : "";
                log("info", `[prefix-affinity] new anonymous session ${anonAffinity.sessionId} (depth=${anonAffinity.incomingDepth}, tail=${anonAffinity.tailHash.slice(0, 8)}${lineage})`);
                loggerLog("info", `[prefix-affinity] new session ${anonAffinity.sessionId} at depth ${anonAffinity.incomingDepth} (tail=${anonAffinity.tailHash.slice(0, 8)}${lineage})`);
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
        //    sessions get the "prefix-affinity" label, others stay empty
        //    (shown as "—" in the UI).
        const bodyIdentity = responsesIdentity ?? openaiIdentity ?? anthropicIdentity ?? googleIdentity;
        const affinity = affinityToken(bodyIdentity ?? {
            value: clientConv ?? conversation,
            source: clientConv ? "header" : "generated",
            clientProvided: !!clientConv,
        });
        const clientLabel = bodyIdentity?.clientProvided
            ? bodyIdentity.value
            : clientConversationHeader(req.headers);
        const session = getSession(sessionId, { protocol, upstreamOrigin, label: clientLabel ?? (anonAffinity ? "prefix-affinity" : undefined) });
        let publicForkPrefix = false;
        if (!countTokens && !responsesCompact && session.metadata.publicForkReceipt !== undefined) {
            acquireInFlight(session);
            try {
                const accepted = await withSessionLock(session, () => {
                    publicForkPrefix = publicForkInputMatches(session, protocol, parsed);
                    if (publicForkPrefix || session.stats.requests > 0) return true;
                    res.writeHead(409, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, code: "FORK_PREFIX_CONFLICT", error: "first child request does not match its inherited ordered prefix" }));
                    return false;
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
            prefixAffinity.note(sessionId, anonAffinity.incomingDepth, anonAffinity.tailHash, anonAffinity.itemHashes);
            scheduleAffinityPersist();
            session.metadata.anonymousPrefixAffinity = {
                depth: anonAffinity.incomingDepth,
                tailHash: anonAffinity.tailHash,
                via: anonAffinity.via,
                ...(anonAffinity.lineage ? { lineage: anonAffinity.lineage } : {}),
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
                if (!tracked || fp.depth >= tracked.depth) {
                    prefixAffinity.note(sessionId, fp.depth, fp.tailHash, fp.itemHashes, true);
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
            const pending = takePendingPluginRegister();
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
        // the gate is idempotence, not first-request.
        if (derivedParent !== undefined && session.metadata.derivedFromSessionId === undefined && session.metadata.publicForkReceipt === undefined) {
            try {
                const parentSession = resolveConversation(derivedParent)?.session;
                if (parentSession) {
                    session.metadata.derivedFrom = derivedParent;
                    session.metadata.derivedFromSessionId = parentSession.id;
                    markDirty(session);
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
        // assigns refs. A resolved explicit plugin-reported lineage above wins
        // (gate on derivedFromSessionId); this content match is the fallback
        // signal for clients that report no lineage.
        if (clientProvided && !anonAffinity && session.stats.requests === 0 && session.metadata.derivedFromSessionId === undefined && session.metadata.publicForkReceipt === undefined && opts.resumeInheritance !== false) {
            const resume = prefixAffinity.findResumeParent(affinityMessageList(), sessionId);
            if (resume) {
                const resumeParent = peekSession(resume.sessionId) ?? getStore().loadSync(resume.sessionId, { protocol, upstreamOrigin }) ?? undefined;
                if (resumeParent && resumeParent !== session) {
                    session.metadata.derivedFrom = resumeParent.id;
                    session.metadata.derivedFromSessionId = resumeParent.id;
                    markDirty(session);
                    log("info", `[${sessionId}] [resume-inheritance] ${resume.sharedDepth} msg(s) byte-exact prefix of ${resumeParent.id} — inheriting refs/blocks/lineage (#1486)`);
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
        const pluginMode = pluginAgent !== undefined;
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
        storeEffectiveCcr(session, opts.compress.injectTool && storeChannelOk ? pluginCcrStamp : undefined);
        // [#1095] same channel/plugin-mode gating as CCR: image_full's restore
        // round-trip needs a tool channel on this wire; without one the model
        // could request originals it never gets back (silent-loss trap).
        storeEffectiveImageCompression(session, opts.compress.injectTool && !pluginMode && storeChannelOk && resolvedImageCompressionCfg?.enabled === true ? resolvedImageCompressionCfg : undefined);
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
        // Explicit main intent and a verified public-fork prefix each veto heuristic demotion.
        const demotedSide = !countTokens && !responsesCompact && protocol !== null && pluginMode
            && requestAgent !== "main" && !wsLaneEnvelope && !publicForkPrefix
            && detectAcpArtifacts(bodyBuffer, parsed) === null
            && stripLeakedBiliTools(parsed);
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
        if (!demotedSide) {
            restoreOutputBudget(parsed, session, log, resolveKnownOutputCeiling(req.headers, parsed as Record<string, unknown>, opts.routes, route?.rewrittenUrl, opts.sessionHeader));
        }
        // #896: the per-scope output-headroom cap (compress.outputHeadroomMaxPct,
        // three-level merge; default 0.25, aligned with billion-context-pi).
        // Resolved once here so the side-request guard below AND the main-path
        // reservation measure against the SAME capped window.
        const headroomCap = resolveOutputHeadroomCap(resolveCompress(opts.routes, route?.rewrittenUrl, (parsed as { model?: string }).model, opts.compress).outputHeadroomMaxPct);
        // #1729: dsh native compaction guard — a compaction summarize call
        // (replayed prefix + COMPACTION_INSTRUCTION as the final user message,
        // ≤4 messages) is refused BEFORE any pipeline work: not forwarded, kernel
        // state untouched. Unconditional by design — auto pressure, overflow
        // recovery, and manual /compact share one envelope, and a landed
        // checkpoint durably shadows the raw history (irreversible), while every
        // cost of refusing is dsh-side, caught, and recoverable. Runs before the
        // #388 side-request lane: the compaction call is a full-budget request,
        // so only this guard can catch it.
        if (protocol !== null && isDshCompactionCall(protocol, parsed, inboundMsgs)) {
            if (session.metadata.dshCompactionRefused !== true) {
                session.metadata.dshCompactionRefused = true;
                log("warn", `[${session.id}] dsh native compaction call identified (final user message = COMPACTION_INSTRUCTION, ${inboundMsgs} msgs) — REFUSED, not forwarded: bili owns compression on this lane; a landed dsh checkpoint would durably shadow the raw history (#1729, cf. #1206/#1772)`);
            }
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
        if (!countTokens && !responsesCompact && protocol !== null && !publicForkPrefix && (demotedSide || isSideRequest(parsed, requestAgent))) {
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
            const guard = sideRequestGuard(parsed, protocol, reqConfig.modelContextLimit, imageBillingFor(opts, route?.rewrittenUrl ?? upstreamOrigin), imageTokenCapFor(opts, route?.rewrittenUrl ?? upstreamOrigin), headroomCap, armedForGuard, imageReserveFor(session, protocol, parsed, opts, route?.rewrittenUrl ?? upstreamOrigin));
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
            const sideReason = demotedSide ? "leaked bili tools stripped (#1897)" : requestAgent !== undefined ? `agent=${requestAgent}` : `max_tokens<=${SIDE_REQUEST_MAX_TOKENS}`;
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
        // #987: the window is NEVER learned from traffic — no self-heal read
        // here. Only the one-shot emergency shrink (armed on the overflow
        // itself) reacts to a wrong declared window.
        // Reserve the model's OUTPUT budget for this turn from the window so the
        // kernel's nudge/truncate bands sit below (window - reserved) and a
        // context+output overflow can't happen on a small window (e.g. 100k with a
        // large max_tokens — the most common "context blew up" cause; none of the
        // three layers reserved room for the output before this). Anthropic is
        // exempt from this proactive reservation: it counts max_tokens against
        // the window too (#1908), but its overflow is covered at forward time by
        // the outgoing clamp in prepareAnthropic; reserving would additionally
        // shift every band down by maxOutput on every anthropic session — an
        // open product decision, see shouldReserveOutputHeadroom. The request's
        // own budget field is the exact
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
        if (shouldReserveOutputHeadroom(protocol)) {
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
                    try { host = route?.rewrittenUrl ? new URL(route.rewrittenUrl).host : undefined; } catch { host = undefined; }
                    const cfgOut = resolveConfiguredOutputLimit(opts.routes, route?.rewrittenUrl, fbModel);
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
            let reserved = reserveOutputHeadroom(reqConfig.modelContextLimit, maxOutput, headroomCap);
            // Fallback-derived windows are optimistic guesses: never let the
            // output-headroom reservation push the effective window below the
            // floor (issue #282: 128k table − 64k max_tokens → 64k effective
            // for a 1M-window model). If the real window is smaller, the first
            // upstream overflow self-heals it.
            if (nativeFromFallback && reserved < FALLBACK_EFFECTIVE_WINDOW_FLOOR) {
                log("info", `[${session.id}] fallback context window floored: ${reserved} → ${FALLBACK_EFFECTIVE_WINDOW_FLOOR} (model=${String(p.model ?? "?")} not authoritatively identified; self-heal corrects it if the real window is smaller)`);
                reserved = FALLBACK_EFFECTIVE_WINDOW_FLOOR;
            }
            if (reserved !== reqConfig.modelContextLimit) {
                reqConfig = { ...reqConfig, modelContextLimit: reserved };
                // #2096: the [window] line above already went out with the
                // pre-reservation base — surface the value nudge/preflight
                // actually judge against, once per model|value. The clamp's
                // native-window guarantee is stated here so the two windows
                // can't be read as one in an incident log.
                const headroomModel = String(p.model ?? "?");
                if (!headroomEffectiveLogged.has(`${headroomModel}|${reserved}`)) {
                    headroomEffectiveLogged.add(`${headroomModel}|${reserved}`);
                    log("info", `[headroom] model=${headroomModel}: effective window ${nativeWindow} -> ${reserved} (reserved ${nativeWindow - reserved} for max output ${maxOutput}, cap ${headroomCap}) — nudge/preflight judge input against ${reserved}; the outgoing max_tokens clamp still guards the full ${nativeWindow} (#2096)`);
                }
            }
        }
        // Record the FINAL effective window (post self-heal + output-headroom)
        // so the status panel / acp_status show the window the kernel is actually
        // using, in every mode (plugin AND wire). #393: previously this was set
        // pre-self-heal and only for plugin sessions, so wire-mode panels fell
        // back to a hardcoded 200K.
        session.metadata.effectiveContextLimit = reqConfig.modelContextLimit;
        // #955 runtime-info: record the model id + window source for this
        // session so /__bili/plugin/status can show them pre-first-request and
        // post-hoc forensics can tell which source sized the window.
        if (reqModelId !== undefined) session.metadata.lastModel = reqModelId;
        session.metadata.lastWindowSource = wsSourceForLog ?? null;
        // #833: remember the FINAL resolved Config (post self-heal + headroom,
        // same instant as effectiveContextLimit above) so request-context-free
        // display paths (/__bili/plugin/status Nudge line, plugin tool API)
        // render from the values the kernel actually used this turn.
        storeEffectiveConfig(session, reqConfig);
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
            const runPreparedPipeline = async (
                respondFailFast: boolean,
                overflowWindow?: number,
            ): Promise<{ body: string | Buffer; prepared: Prepared | null } | null> => {
                const runPrepare = async (): Promise<Prepared> => {
                    const cs = resolveCompress(opts.routes, route?.rewrittenUrl, requestModel, opts.compress);
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
                    const keepRecent = cs.stripImagesKeepRecent ?? DEFAULT_STRIP_IMAGES_KEEP_RECENT;
                    const stripped = cs.stripImages
                        ? stripHistoricalImages(parsed, protocol, keepRecent)
                        : { body: parsed, removed: 0 };
                    if (opts.debug && stripped.removed > 0) {
                        log("info", `[debug] strip-images: dropped ${stripped.removed} historical image part(s), kept last ${keepRecent} (session=${session.id})`);
                    }
                    const work = stripped.body;
                    if (countTokens) {
                        return protocol === "google"
                            ? prepareGoogleCountTokens(work as GoogleRequestBody, core, reqConfig, log, session)
                            : prepareCountTokens(work as AnthropicRequestBody, core, reqConfig, log, session);
                    }
                    if (protocol === "google") {
                        // Both the model and the stream flag live in the URL path
                        // for this wire (the body carries neither), so they are
                        // derived here instead of read off `work`.
                        return await prepareGoogle(work as GoogleRequestBody, opts, core, reqConfig, reqPrompts, reqSurface, log, session, pluginMode, nativeWindow, googleModel, googlePathKind(urlPath) === "stream-generate", visibilityMarkers, upstreamOrigin);
                    }
                    return protocol === "anthropic"
                        ? await prepareAnthropic(work as AnthropicRequestBody, req, opts, core, reqConfig, reqPrompts, reqSurface, log, session, pluginMode, upstreamOrigin, nativeWindow, reasoningCfg, visibilityMarkers)
                        : protocol === "openai"
                          ? await prepareOpenai(work as OpenAIRequestBody, req, opts, core, reqConfig, reqPrompts, reqSurface, log, session, pluginMode, upstreamOrigin, nativeWindow, reasoningCfg, visibilityMarkers, route?.rewrittenUrl)
                          : responsesCompact
                            // #618 review nit: when no bili compaction item is present,
                            // prepareResponsesCompact falls back to the raw bodyBuffer — forward
                            // the re-serialized post-strip work instead so dropped images don't
                            // ride along. Unchanged bodies keep the original buffer byte-identical.
                            ? prepareResponsesCompact(stripped.removed > 0 ? Buffer.from(JSON.stringify(work)) : bodyBuffer, work as ResponsesRequestBody, session, req, core, reqConfig, log)
                            : await prepareResponses(work as ResponsesRequestBody, req, opts, core, reqConfig, reqPrompts, reqSurface, log, session, responsesIdentity!, pluginMode, upstreamOrigin, nativeWindow, reasoningCfg, visibilityMarkers, route?.rewrittenUrl);
                };
                // #332: codex's native remote-compaction request (trigger form)
                // is dispatched BEFORE prepare/preflight. When it is not
                // intercepted, preserve what codex sent except for local bili
                // compaction markers: a preflight-compressed/rebuilt payload
                // diverges from codex's local history, non-OpenAI backends 400 the
                // compaction_trigger item, and folding bili's state as a side
                // effect of handling codex's own compaction is wrong.
                const isCodexCompactTrigger =
                    protocol === "responses" &&
                    !responsesCompact &&
                    isCodexClient(req.headers) &&
                    hasCompactionTrigger((parsed as ResponsesRequestBody).input);
                if (isCodexCompactTrigger) {
                    const mode = codexCompactMode();
                    const gatePre = codexCompactGatePre(session, reqConfig.modelContextLimit);
                    if (mode === "intercept" && gatePre) prepared = await runPrepare();
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
                prepared = await runPrepare();
                if (!countTokens && !responsesCompact) {
                    const outcome = await preflightCompressIfNeeded(
                        prepared,
                        runPrepare,
                        req,
                        bodyBuffer,
                        res,
                        opts,
                        core,
                        overflowWindow !== undefined ? { ...reqConfig, modelContextLimit: overflowWindow } : reqConfig,
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
                        fs.writeFileSync(path.join(rawDir, `${Date.now()}-${safeSessionId(session.id)}-INCOMING.txt`), `${req.method} ${maskUrlsInText(req.url ?? "")}\n${hdrText}\n\n${bodyBuffer.toString("utf8")}`);
                    } catch (err) { logDumpFailure("INCOMING dump", err); }
                }
                logRequestCost(log, session.id, inboundMsgs, inboundBytes, reqT0, prepared!.body);
                return { body: prepared!.body, prepared: prepared! };
            };
            // #1884 (un-armed signed traffic): a request that already carries a
            // body-covering signature (SDK-HMAC-SHA256 family — CodeArts APIG)
            // and arrives WITHOUT the re-sign arm cannot survive any body
            // rewrite: prepare* injects the compress tool + system notes, and
            // the compress loop re-sends rebuilt rounds, so the upstream
            // rejects every mutated request with 401 (APIG.0301 body-hash
            // mismatch). Default: REFUSE (403, actionable message) — silently
            // forwarding byte-untouched would silently disable compression;
            // the user opted into bili, not into a pass-through tunnel.
            // BILI_RESIGN_PASSTHROUGH=1 opts in to byte-untouched forwarding
            // (no session, no compression, signature intact — the /bili/-
            // prefix twin of the native lane's #1886 fallback);
            // BILI_RESIGN=0 un-deploys the guard entirely (pre-resign
            // handling: the request rides the normal rewrite path).
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
                if (guardResign.passthrough) {
                    log("warn", `[signed-passthrough] request carries a body-covering signature without the re-sign arm — forwarding byte-untouched, no compression (#1884; resign["${guardScheme}"].passthrough for this provider, BILI_RESIGN_PASSTHROUGH, or the global resign block)`);
                    forwarded = true;
                    await forward(req, res, opts, bodyBuffer, null, core, reqConfig, log, route, instanceId, undefined);
                    return;
                }
                log("warn", `[signed-refused] request carries a ${guardScheme} body-covering signature without a working re-sign arm${resignMarker === APIG_RESIGN_SCHEME ? " (arm marker present but credential does not decode)" : ""} — refusing instead of silently dropping compression. Set resign["${guardScheme}"].passthrough for this provider (or BILI_RESIGN_PASSTHROUGH / the global resign block) for byte-untouched forwarding, or provide a signing credential (#1884)`);
                const refusal = signedRefusal(guardScheme, (req.url ?? "").endsWith("/messages") ? "anthropic" : "openai");
                forwarded = true;
                res.writeHead(refusal.status, { "content-type": refusal.contentType, "x-bili-resign": "unavailable" });
                res.end(refusal.body);
                return;
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
                    ? async (realWindow: number | undefined): Promise<string | Buffer | null> => {
                          const next = await withSessionLock(session, () => runPreparedPipeline(false, realWindow));
                          if (!next || String(next.body) === String(pendingForward.body)) return null;
                          pendingForward.body = next.body;
                          pendingForward.prepared = next.prepared;
                          return next.body;
                      }
                    : undefined;
                await forward(req, res, opts, pendingForward.body, pendingForward.prepared, core, reqConfig, log, route, instanceId, affinity, overflowRefold);
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
        if (protocol === null && !opts.passthrough && !routePassthrough && !isModelDiscoveryPath(urlPath)) {
            logUnrecognizedPath(log, req.url ?? "");
        }
        await forward(req, res, opts, scrubCompatDrop(scrubAnthropicPck(protocol, bodyBuffer, log), compatDropPaths, log), null, core, reqConfig, log, route, instanceId, undefined);
    }
}

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

function diagTagSummary(messages: CoreMessage[], sessionId: string, strategy: string): string {
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

function diagNudge(turn: { nudge?: { shouldInject: boolean; reason: string; contextUsage: number; tier: number | null; breakdown?: Record<string, number> } | null }, sessionId: string, tokenCount: number, limit: number, model: string | undefined, willInject: boolean): string {
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
function effectiveTokenCount(session: Session, msgs: CoreMessage[], inboundImageTokens = 0): { tokens: number; source: "usage" | "estimate" } {
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
function usageGradeInputBaseline(session: Session): number {
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
function scrubAnthropicPck(protocol: WireProtocol | null, bodyBuffer: Buffer, log: (level: string, msg: string) => void): Buffer {
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
function scrubCompatDrop(bodyBuffer: Buffer, dropPaths: readonly string[], log: (level: string, msg: string) => void): Buffer {
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

async function prepareAnthropic(
    parsed: AnthropicRequestBody,
    req: http.IncomingMessage,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    prompts: Prompts,
    surface: PackSurface,
    log: (level: string, msg: string) => void,
    session: Session,
    pluginMode: boolean,
    upstreamOrigin: string,
    nativeWindow: number,
    reasoning: CompressReasoningConfig | undefined,
    visibilityMarkers: boolean,
): Promise<Prepared> {
    const sessionId = session.id;
    const stream = parsed.stream === true;
    ++session.stats.requests;
    const injectTools = opts.compress.injectTool && !pluginMode;
    const stripReasoning = (msgs: BiliMessage[]): BiliMessage[] => withReasoningDrop(msgs, reasoning, log, sessionId, isStrictReasoningEcho(session, upstreamOrigin, modelIdOf(parsed)));

    if (isAutoModeClassifier(parsed)) {
        log("info", `[${sessionId}] auto-mode classifier passthrough (skipping compress injection)`);
        return { body: JSON.stringify(parsed), session, processedMessages: [], originalMessages: [], anthropicSystem: parsed.system, protocol: "anthropic", stream, compressInjected: false, pluginMode, nudge: undefined, prompts, surface } as Prepared;
    }

    let processedMessages: CoreMessage[] = [];
    let attachedRetrievals: PendingRetrieval[] = [];
    let attachedRetrievalNoteIds: string[] = [];
    let originalMessages: CoreMessage[] = [];
    let nudge: NudgeDecision | undefined;
    let rebuiltMessages = parsed.messages;
    let anthropicCacheMarks: Map<string, { type: "ephemeral" }> | undefined;
    let systemOut = parsed.system;
    let toolsOut = parsed.tools;

    // #1085: sticky head-system anchor — freeze the client's own `system` text
    // at first sight and forward it byte-stable; detected changes ride as
    // trailing user notes. Mutating parsed.system in place makes every
    // downstream consumer (injectSystem, Prepared.anthropicSystem → loop)
    // inherit the anchor, and the failure path below keeps forwarding it too.
    let sysNotes: string[] = [];
    // [#1930-3] The client's own system captured BEFORE the anchor
    // replacement below — fingerprinting the post-anchor value tracks bili's
    // managed text and hides client-side drift (same rationale as the
    // responses site; keeps all four wires on one semantic).
    const clientSystem = parsed.system;
    // Plugin-mode agents own their context management and may already apply
    // their own cache-friendly head handling (#1085 scope: plain-proxy mode
    // only) — anchoring them would double-process.
    if (opts.stableSystemAnchor && !pluginMode) {
        const fresh = extractSystem(parsed.system);
        const outcome = reconcileSystemAnchor(session, "anthropic", fresh, sessionId, log);
        sysNotes = outcome.notes;
        if (outcome.outbound !== fresh) {
            parsed.system = buildSystem(outcome.outbound, parsed.system);
        }
    }

    // The classifier passthrough above and prepareResponsesCompact return before
    // this strip; no client emits an ACP panel on those paths, so that's safe.
    const strippedPanels = stripAcpPanelMessages(parsed.messages);
    if (strippedPanels > 0) {
        log("info", `[${sessionId}] stripped ${strippedPanels} ACP panel message(s) before projection (UI-only, issue #359)`);
    }
    const strippedMarkerLines = stripAcpStatusMarkers(parsed.messages);
    if (strippedMarkerLines > 0) {
        log("info", `[${sessionId}] stripped ${strippedMarkerLines} ACP status marker line(s) from incoming history (ephemeral proxy status, issue #1029)`);
    }
    const strippedCarriers = stripEmbeddedChainCarriers(parsed, "anthropic");
    if (strippedCarriers > 0) {
        log("info", `[${sessionId}] stripped ${strippedCarriers} embedded chain checkpoint(s) from incoming history (leaked egress control data, issue #1542)`);
    }

    try {
        const { msgs, cacheControls } = anthropicToCore(parsed);
        originalMessages = msgs;
        // #1320: signature-only thinking blocks bill restored thinking tokens upstream
        // but project as empty text locally — attribute the provider-vs-local residual
        // to them so every meter sees the billed context (metering-only, wire untouched).
        const inboundImageTokens = imageReserveFor(session, "anthropic", parsed, opts, upstreamOrigin);
        projectThinkingMass(msgs, {
            providerInputTokens: session.stats.lastInputTokens,
            measured: session.stats.lastInputTokensSource === "usage",
            systemText: extractSystem(parsed.system),
            tools: parsed.tools,
            imageTokens: inboundImageTokens,
            storedOverhead: typeof session.metadata.systemPromptTokens === "number" ? session.metadata.systemPromptTokens : undefined,
        });
        // #1001: pre-turn snapshot — processTurn below assigns fresh refs to every
        // previously-unknown id, which would make rewrite detection read 1.0.
        const knownRefsBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
        // tokenCount drives the nudge decision ("should we compress?"). It MUST
        // be the real context size, never an estimate — estimates undercount
        // CJK text 3-4x and never trigger compression for Chinese sessions.
        // Use the upstream's own input_tokens from the PREVIOUS turn (known by
        // now — the response came back). First turn has no history → 0 (never
        // triggers anyway). extractSystem is still called so sysText flows into
        // the fallback path below if we ever need it, but we no longer feed
        // estimates to the kernel.
        extractSystem(parsed.system);
        // #553-follow-up exception to the "never estimates" rule above: anonymous
        // zero-baseline forks replay their FULL raw history with no measurement,
        // so feeding 0 blinds the nudge (usage 0%, growth ref 0) and no
        // compression trigger fires until overflow. See effectiveTokenCount.
        const { tokens: tokenCount, source: tokenCountSource } = effectiveTokenCount(session, msgs, inboundImageTokens);
        const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
        // Absorb markers are injected by the kernel's processTurn from
        // config.absorb. With no channel to call the tool (injection off),
        // strip absorb from the loop config so the REQUIRED instruction never
        // reaches the wire. Hiding recorded absorptions is unaffected
        // (applyAbsorbView hides regardless of enablement).
        const absorbBlock = effectiveAbsorbBlock(pluginMode, config, opts.compress.absorb);
        const absorbTools = absorbToolsFor(absorbBlock?.toolName ?? ABSORB_TOOL_NAME);
        const absorbActive = absorbBlock?.enabled === true && opts.compress.injectTool;
        // acp_rule has no processTurn side effect (no markers/instructions are
        // ever injected into messages), so unlike absorb it needs no loop-
        // config stripping — only tool availability matters.
        const rulesActive = rulesEnabled(config) && opts.compress.injectTool;
        // [#1097] the kernel ccr-store node ID-references oversized tool results
        // BEFORE absorb (ID-reference wins over distill); armed policy is
        // stamped per-request — strip `ccr` from the loop config when disarmed
        // (plugin mode / no tool channel) so placeholders never hit the wire.
        const loopConfig = ccrLoopConfig(session, { ...config, absorb: absorbActive ? absorbBlock : undefined });
        // [#1921] re-anchor fold coverage onto churned-but-same messages
        // before the #1195 snapshot, so covered ids surviving a client
        // re-serialization stay covered (src/fold-reconcile.ts).
        reconcileFoldCoverage(session, msgs, { mode: resolveFoldReconcileMode(process.env, opts.compress.reconcile), sessionId, log });
        noteSystemPromptFingerprint(session, clientSystem, { sessionId, log });
        // #1195: pre-turn snapshot of the fold's covered ids — syncBlocks inside
        // processTurn may deactivate fully-drifted blocks, erasing them.
        const foldCoveredBefore = session.stats.pendingFoldUsage === true
            ? new Set(session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])))
            : null;
        const turn = core.processTurn({ messages: msgs, state: session.state, config: loopConfig, tokenCount, renderTags: knobRenderNone() ? "none" : "text-only", contentStore: contentStoreOf(session) });
        session.state = turn.state;
        adoptContentStore(session, turn.contentStore);
        // The fold from last turn's compress has now materialized in state —
        // future usage reports are post-fold reality, drop the credit.
        session.stats.compressCreditTokens = 0;
        if (foldCoveredBefore !== null && msgs.length >= REWRITE_MIN_INCOMING_TOTAL) {
            const gap = foldCoverage(foldCoveredBefore, msgs.map((m) => m.id));
            if (gap) log("warn", `[${sessionId}] [acp-drift] fold coverage mismatch: ${gap.matched}/${gap.expected} covered message id(s) present in resent history — ${gap.expected - gap.matched} covered id(s) missing from resent history — mutation (content edit invalidates content-hash refs, fold silently lost) or client-side deletion/truncation (benign, message no longer on the wire); observability complement to the #1328 overflow rescue (#1195)`);
        }
        storeEffectiveAbsorb(session, loopConfig);
        storeEffectiveRules(session, config);
        turn.messages = applyAbsorbView(turn.messages, session.state, loopConfig, tokenCount);
        turn.messages = attachSubagentSessions(turn.messages, session);
        // Drop sub-viability fragments before any consumer sees them: a tiny
        // range in the list makes batched compress attempts fail atomically
        // (kernel validates the whole batch). Mirrors billion-context-pi.
        if (turn.nudge) turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
        session.stats.contextTokensSource = tokenCountSource;
        if (!session.meta.title) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        const willInjectNudge = opts.compress.injectNudge && !!turn.nudge && (turn.nudge.shouldInject || emergencyNudge(turn.nudge));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, parsed.model, willInjectNudge));
        processedMessages = stripReasoning(stripKernelSummaries(turn.messages, turn.state));
        // #1001: a silent client history rewrite takes the same archive+prune path
        // as an announced /compact boundary — syncBlocks above has already
        // deactivated the blocks whose sources left the context.
        {
            const rewrite = detectUnannouncedHistoryRewrite(session, knownRefsBefore, msgs.map((m) => m.id));
            if (rewrite.detected) {
                log("warn", `[${sessionId}] unannounced client history rewrite detected (${rewrite.knownIncoming}/${rewrite.incomingTotal} incoming message(s) carry pre-turn refs of ${rewrite.knownBefore} known) — marking compaction boundary (#1001)`);
                recordConflict(session, "unannounced-rewrite", `${rewrite.knownIncoming}/${rewrite.incomingTotal} incoming message(s) carry pre-turn refs of ${rewrite.knownBefore} known`);
                markCompactionBoundary(session);
            }
        }
        applyCompactionArchive(session, activeBefore, new Set(msgs.map((m) => m.id)), log);
        reapOrphansLogged(session, msgs, log, sessionId);
        // [#1095] downscale screenshot-like images ONCE at arrival (kernel routing
        // decision + recipe; originals cached for the image_full restore channel).
        // Deterministic encode ⇒ re-runs are byte-stable for the prefix cache.
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, upstreamOrigin), cap: imageTokenCapFor(opts, upstreamOrigin), log });
        // [#1271/#1343] plugin mode: acp_retrieve already acked via the tool API; snapshot
        // the queued full text onto THIS forward (stays in the queue until commit/drop, so an
        // upstream failure drops-and-logs it instead of vanishing it).
        if (pluginMode && ccrEnabled(session)) {
            reconcileReloadedRetrievals(session);
            pruneExpiredRetrievals(session);
            attachedRetrievals = snapshotPendingRetrievals(session);
            if (attachedRetrievals.length > 0) processedMessages = [...processedMessages, ...attachedRetrievals.map((i) => i.injection)];
        }
        // #1637: cumulative cache_control marks applied through the kernel's own
        // applier (same machine the round-2 adapter uses); marks ride the last
        // STABLE message — ephemeral tails (retrievals/sysNotes/nudge/id note)
        // never carry a breakpoint. Client-managed controls (message blocks,
        // tools entries — WC-010's combined budget) pass through untouched.
        anthropicCacheMarks = cacheControls.size > 0 || anthropicToolsCarryCacheControl(parsed.tools)
            ? undefined
            : computeAnthropicMessageMarks(processedMessages as { id?: string }[], attachedRetrievals.length, session);
        rebuiltMessages = coreToAnthropic(processedMessages as BiliMessage[], anthropicCacheMarks ?? cacheControls);
        if (sysNotes.length > 0) {
            rebuiltMessages = [...rebuiltMessages, ...sysNotes.map((text) => ({ role: "user" as const, content: text }))];
        }

        systemOut = injectSystem(parsed, opts, prompts, loopConfig, surface, visibilityMarkers);
        // #1637: stamp the steady body's system. NOTE: parsed.system stays the
        // #1085 frozen CLIENT head (injectSystem's in-place view) — the round-2
        // adapter consumes that frozen head and stamps its own rebuild, so NO
        // write-back here (writing the full systemOut back would double-append
        // the compress prompt on round-2, the exact F2 seam the matrix pins).
        systemOut = stampAnthropicSystemCacheControl(systemOut, anthropicCacheMarks !== undefined);
        if (injectTools) {
            toolsOut = injectTool(parsed.tools, [...(absorbActive ? [absorbTools.anthropic] : []), ...(rulesActive ? [RULE_TOOL] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).anthropic] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL] : [])], surface?.toolPrompts, ccrEnabled(session));
        }
        // Nudge as a separate trailing user message (cache-friendly): the
        // system block stays byte-stable so the prefix cache survives.
        // Injected in BOTH modes (#451): in plugin mode the agent supplies the
        // ACP tools but has NO nudge channel of its own, so this proxy-side
        // nudge IS the proactive trigger — preflight alone only fires at the
        // hard limit. Ephemeral user message: not persisted, never enters the
        // agent's re-sent history, safe for the prefix-cache anchor.
        if (willInjectNudge && turn.nudge) {
            try {
                const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections);
                if (rendered.text) {
                    rebuiltMessages = [...rebuiltMessages, { role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withStagedCompressGuidance(rendered.text)), visibilityMarkers) }];
                }
            } catch {
            }
        }
        // [#1095] restore-channel guidance — ephemeral trailing user message
        // (see prepareAnthropic for why not system).
        const imgNote = imageFullTrailingNote(session);
        if (imgNote) rebuiltMessages = [...rebuiltMessages, { role: "user", content: imgNote }];
        // [#1343/#1457] surface any earlier undelivered retrieve as an ephemeral
        // trailing user note (kept last so it never reorders cached messages).
        // Snapshot WITHOUT consuming: forward() commits the ids only once
        // upstream accepts this request; on failure they ride the next one.
        const retrNotes = snapshotRetrievalNotes(session);
        const retrNote = renderRetrievalNotes(retrNotes);
        if (retrNote) {
            rebuiltMessages = [...rebuiltMessages, { role: "user", content: retrNote }];
            attachedRetrievalNoteIds = retrNotes.map((n) => n.id);
        }
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        if (attachedRetrievals.length > 0) dropRetrievals(session, attachedRetrievals.map((i) => i.ref), "prepare failed; forwarded unprocessed");
        processedMessages = [];
    }
    // #532: measure the outbound system+tools overhead for the status panel's
    // SysPrompt row — the kernel breakdown classifies messages only, and on
    // this wire the system rides the top-level `system` field outside the fold.
    session.metadata.systemPromptTokens = countSystemAndToolsTokens(extractSystem(systemOut), toolsOut);
    snapshotMessages(session, originalMessages);
    markDirty(session);

    const rebuilt: AnthropicRequestBody = { ...parsed, messages: rebuiltMessages, system: systemOut, tools: toolsOut };
    warnAnthropicThinkingPairs(parsed.messages, rebuiltMessages, log, sessionId);
    // prompt_cache_key is the omp plugin's session id stamped for the proxy's
    // identity chain (#268), not part of the Anthropic Messages API — strip it
    // so the real upstream never sees a field it doesn't know.
    delete (rebuilt as Record<string, unknown>).prompt_cache_key;
    // #728: record the char-count upper bound of THIS turn's outbound payload
    // (post-fold messages + system/tools overhead + images) as the fallback
    // token source for upstreams that never report usage — read only while
    // lastInputTokens == 0 (effectiveTokenCount). When the kernel transform
    // above failed, processedMessages is empty and the forwarded body is the
    // UNPROCESSED projection — measure that instead so the fallback isn't
    // blinded to a system+tools-only floor.
    session.stats.localInputEstimate = estimateCoreMessagesUpper(processedMessages.length > 0 ? processedMessages : originalMessages)
        + countSystemAndToolsTokens(extractSystem(systemOut), toolsOut)
        + imageReserveFor(session, "anthropic", rebuilt, opts, upstreamOrigin);
    // #1933 F1: billed-caliber twin of the row above (chars/4 instead of
    // char-count upper bound) — settleUsageReport pairs it with this turn's
    // usage report to learn the per-route estimate-calibration factor k̂.
    session.stats.lastLocalTextEstimate = estimateCoreMessages(processedMessages.length > 0 ? processedMessages : originalMessages)
        + countSystemAndToolsTokens(extractSystem(systemOut), toolsOut)
        + imageReserveFor(session, "anthropic", rebuilt, opts, upstreamOrigin);
    if (upstreamOrigin) session.stats.lastLocalTextEstimateOrigin = upstreamOrigin;
    // #1908 mechanism 3: cap outgoing max_tokens so input + max_tokens <= window.
    // Anthropic was the one wire missing this — its headroom reservation was skipped
    // on the false premise that it enforces input independently of max_tokens (it does not).
    clampOutgoingOutput(rebuilt as Record<string, unknown>, "max_tokens", { systemText: extractSystem(systemOut), tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, lastInputTokensSource: session.stats.lastInputTokensSource, nativeWindow, headroomWindow: config.modelContextLimit, imageTokens: imageReserveFor(session, "anthropic", rebuilt, opts, upstreamOrigin) }, sessionId, log);
    return { body: JSON.stringify(rebuilt), session, attachedRetrievals, attachedRetrievalNoteIds, processedMessages, originalMessages, anthropicSystem: parsed.system, anthropicCacheMarks, systemNotes: sysNotes, protocol: "anthropic", stream, compressInjected: injectTools, pluginMode, nudge, prompts, surface, renderTags: knobRenderNone() ? "none" : "text-only", dropReasoning: stripReasoning } as Prepared;
}

async function prepareOpenai(
    parsed: OpenAIRequestBody,
    req: http.IncomingMessage,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    prompts: Prompts,
    surface: PackSurface,
    log: (level: string, msg: string) => void,
    session: Session,
    pluginMode: boolean,
    upstreamOrigin: string,
    nativeWindow: number,
    reasoning: CompressReasoningConfig | undefined,
    visibilityMarkers: boolean,
    billingUpstream?: string,
): Promise<Prepared> {
    const sessionId = session.id;
    const stream = parsed.stream === true;
    ++session.stats.requests;
    let openaiSystemText = "";
    let sysNotes: string[] = [];
    const stripReasoning = (msgs: BiliMessage[]): BiliMessage[] => withReasoningDrop(msgs, reasoning, log, sessionId, isStrictReasoningEcho(session, upstreamOrigin, modelIdOf(parsed)));
    let openaiOutboundSystem: string | undefined;
    let processedMessages: CoreMessage[] = [];
    let attachedRetrievals: PendingRetrieval[] = [];
    let attachedRetrievalNoteIds: string[] = [];
    let originalMessages: CoreMessage[] = [];
    let nudge: NudgeDecision | undefined;
    let rebuiltMessages = parsed.messages;
    let toolsOut = parsed.tools;

    const maxTokens = typeof parsed.max_tokens === "number" ? parsed.max_tokens : 8192;
    // Title-generation requests (tiny max_tokens) get no compress tooling so
    // the model produces a clean short title. We do NOT key this off message
    // count: a 2-message request is just turn 1 of a real conversation, and
    // flipping shouldInject false→true between turn 1 and turn 2+ rewrites the
    // system prompt bytes (compress prompt added/removed) — which breaks the
    // provider prefix cache for every subsequent turn.
    const isTitleGen = maxTokens <= 200;
    const shouldInject = opts.compress.injectTool && !isTitleGen;
    const injectTools = shouldInject && !pluginMode;

    const strippedPanels = stripAcpPanelMessages(parsed.messages);
    if (strippedPanels > 0) {
        log("info", `[${sessionId}] stripped ${strippedPanels} ACP panel message(s) before projection (UI-only, issue #359)`);
    }
    const strippedMarkerLines = stripAcpStatusMarkers(parsed.messages);
    if (strippedMarkerLines > 0) {
        log("info", `[${sessionId}] stripped ${strippedMarkerLines} ACP status marker line(s) from incoming history (ephemeral proxy status, issue #1029)`);
    }
    const strippedCarriers = stripEmbeddedChainCarriers(parsed, "openai");
    if (strippedCarriers > 0) {
        log("info", `[${sessionId}] stripped ${strippedCarriers} embedded chain checkpoint(s) from incoming history (leaked egress control data, issue #1542)`);
    }

    try {
        // Kernel 0.0.37 hoists the contiguous leading system/developer prefix
        // OUT of the fold space: system content is host runtime state and
        // must not feed ids/fingerprints. Capture it and re-inject below —
        // otherwise the proxy would forward payloads without any system.
        const { msgs, systemText } = openaiToCore(parsed);
        openaiSystemText = systemText;
        warnDroppedOpenaiParts(parsed, sessionId, log);
        // Title-gen side-requests carry their own tiny system — reconciling
        // them would pollute the conversation's anchor state.
        if (opts.stableSystemAnchor && !pluginMode && !isTitleGen) {
            const outcome = reconcileSystemAnchor(session, "openai", systemText, sessionId, log);
            sysNotes = outcome.notes;
            openaiSystemText = outcome.outbound;
        }
        originalMessages = msgs;
        // #1001: pre-turn snapshot — processTurn below assigns fresh refs to every
        // previously-unknown id, which would make rewrite detection read 1.0.
        const knownRefsBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
        // tokenCount = upstream's real input_tokens from the previous turn
        // tokenCount = upstream's real input_tokens from the previous turn
        // (see anthropic branch comment + its #553-follow-up exception).
        const { tokens: tokenCount, source: tokenCountSource } = effectiveTokenCount(session, msgs, imageReserveFor(session, "openai", parsed, opts, billingUpstream ?? upstreamOrigin));

        const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
        // Absorb markers ride in the kernel's processTurn output (gated by
        // config.absorb). Title-gen requests skip ALL injection for
        // prefix-cache stability, so strip absorb from the loop config there.
        const absorbBlock = effectiveAbsorbBlock(pluginMode, config, opts.compress.absorb);
        const absorbTools = absorbToolsFor(absorbBlock?.toolName ?? ABSORB_TOOL_NAME);
        const absorbActive = absorbBlock?.enabled === true && shouldInject;
        const rulesActive = rulesEnabled(config) && shouldInject;
        const loopConfig = ccrLoopConfig(session, { ...config, absorb: absorbActive ? absorbBlock : undefined });
        // [#1921] re-anchor fold coverage onto churned-but-same messages
        // before the #1195 snapshot, so covered ids surviving a client
        // re-serialization stay covered (src/fold-reconcile.ts).
        reconcileFoldCoverage(session, msgs, { mode: resolveFoldReconcileMode(process.env, opts.compress.reconcile), sessionId, log });
        if (!isTitleGen) noteSystemPromptFingerprint(session, systemText, { sessionId, log });
        // #1195: pre-turn snapshot of the fold's covered ids — syncBlocks inside
        // processTurn may deactivate fully-drifted blocks, erasing them.
        const foldCoveredBefore = session.stats.pendingFoldUsage === true
            ? new Set(session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])))
            : null;
        const turn = core.processTurn({ messages: msgs, state: session.state, config: loopConfig, tokenCount, renderTags: knobRenderNone() ? "none" : "text-only", contentStore: contentStoreOf(session) });
        session.state = turn.state;
        adoptContentStore(session, turn.contentStore);
        // The fold from last turn's compress has now materialized in state —
        // future usage reports are post-fold reality, drop the credit.
        session.stats.compressCreditTokens = 0;
        if (foldCoveredBefore !== null && !isTitleGen && msgs.length >= REWRITE_MIN_INCOMING_TOTAL) {
            const gap = foldCoverage(foldCoveredBefore, msgs.map((m) => m.id));
            if (gap) log("warn", `[${sessionId}] [acp-drift] fold coverage mismatch: ${gap.matched}/${gap.expected} covered message id(s) present in resent history — ${gap.expected - gap.matched} covered id(s) missing from resent history — mutation (content edit invalidates content-hash refs, fold silently lost) or client-side deletion/truncation (benign, message no longer on the wire); observability complement to the #1328 overflow rescue (#1195)`);
        }
        storeEffectiveAbsorb(session, loopConfig);
        storeEffectiveRules(session, config);
        turn.messages = applyAbsorbView(turn.messages, session.state, loopConfig, tokenCount);
        turn.messages = attachSubagentSessions(turn.messages, session);
        // Drop sub-viability fragments before any consumer sees them: a tiny
        // range in the list makes batched compress attempts fail atomically
        // (kernel validates the whole batch). Mirrors billion-context-pi.
        if (turn.nudge) turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
        session.stats.contextTokensSource = tokenCountSource;
        if (!session.meta.title) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        const willInjectNudge = opts.compress.injectNudge && !!turn.nudge && shouldInject && (turn.nudge.shouldInject || emergencyNudge(turn.nudge));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, parsed.model, willInjectNudge));
        processedMessages = stripReasoning(stripKernelSummaries(turn.messages, turn.state));
        // #1001: a silent client history rewrite takes the same archive+prune path
        // as an announced /compact boundary — syncBlocks above has already
        // deactivated the blocks whose sources left the context.
        {
            const rewrite = detectUnannouncedHistoryRewrite(session, knownRefsBefore, msgs.map((m) => m.id));
            if (rewrite.detected) {
                log("warn", `[${sessionId}] unannounced client history rewrite detected (${rewrite.knownIncoming}/${rewrite.incomingTotal} incoming message(s) carry pre-turn refs of ${rewrite.knownBefore} known) — marking compaction boundary (#1001)`);
                recordConflict(session, "unannounced-rewrite", `${rewrite.knownIncoming}/${rewrite.incomingTotal} incoming message(s) carry pre-turn refs of ${rewrite.knownBefore} known`);
                markCompactionBoundary(session);
            }
        }
        applyCompactionArchive(session, activeBefore, new Set(msgs.map((m) => m.id)), log);
        reapOrphansLogged(session, msgs, log, sessionId);
        // [#1095] arrival-time image downscale (see prepareAnthropic) — one
        // deterministic encode per fingerprint; byte-stable re-runs.
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, billingUpstream ?? upstreamOrigin), cap: imageTokenCapFor(opts, billingUpstream ?? upstreamOrigin), log });
        // [#1271/#1343] plugin mode: acp_retrieve already acked via the tool API; snapshot
        // the queued full text onto THIS forward (stays in the queue until commit/drop, so an
        // upstream failure drops-and-logs it instead of vanishing it).
        if (pluginMode && ccrEnabled(session)) {
            reconcileReloadedRetrievals(session);
            pruneExpiredRetrievals(session);
            attachedRetrievals = snapshotPendingRetrievals(session);
            if (attachedRetrievals.length > 0) processedMessages = [...processedMessages, ...attachedRetrievals.map((i) => i.injection)];
        }
        rebuiltMessages = systemToUser(hardenOpenaiAssistantContent(coreToOpenai(processedMessages as BiliMessage[])));

        // ONLY the static compress prompt goes into the system message — the
        // system prompt is the prefix-cache anchor and must be byte-stable
        // across turns. The nudge (which changes every turn: token count,
        // growth %, dynamic example) is appended as a trailing user message
        // instead, mirroring pai-acp's design. Putting the nudge in system
        // would invalidate the cache every turn.
        const sysParts: string[] = [];
        if (openaiSystemText) sysParts.push(openaiSystemText);
        if (shouldInject) sysParts.push(withMarkerIntegrityNote(withSummaryBudgetNote(buildCompressSystemPrompt(prompts, surface?.promptSections)), visibilityMarkers));
        else if (!isTitleGen && !knobRenderNone()) {
            // #1881: the NEVER-echo prohibition follows the rendered tags, not the tool switch.
            const tagsOnly = buildAcpTagsOnlyPrompt("function", prompts, surface?.promptSections);
            if (tagsOnly) sysParts.push(tagsOnly);
        }
        if (absorbActive) sysParts.push(buildAbsorbSystemPrompt(absorbToolName(loopConfig)));
        rebuiltMessages = injectOpenaiSystem(rebuiltMessages, sysParts);
        if (sysNotes.length > 0) {
            rebuiltMessages = [...rebuiltMessages, ...sysNotes.map((text) => ({ role: "user" as const, content: text }))];
        }
        // #532: capture what bili injects outside the fold space (client system
        // + compress prompt). A head system message already in the rebuilt view
        // is classified by the kernel breakdown — counting only these parts
        // avoids double-counting it.
        openaiOutboundSystem = sysParts.join("\n\n");
        if (injectTools) {
            toolsOut = injectOpenaiTool(parsed.tools, [...(absorbActive ? [absorbTools.openai] : []), ...(rulesActive ? [RULE_TOOL_OPENAI] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).openai] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL_OPENAI] : [])], surface?.toolPrompts, ccrEnabled(session));
        }
        // Nudge as a separate trailing user message (cache-friendly). Injected
        // in BOTH modes (#451): plugin agents supply the ACP tools but have no
        // nudge channel of their own, so this proxy-side nudge is the proactive
        // trigger (preflight alone fires only at the hard limit). Ephemeral user
        // message — not persisted, never enters the agent's re-sent history,
        // prefix-cache-anchor safe.
        if (willInjectNudge && turn.nudge) {
            try {
                const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections);
                if (rendered.text) {
                    rebuiltMessages = [...rebuiltMessages, { role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withStagedCompressGuidance(rendered.text)), visibilityMarkers) }];
                }
            } catch {
            }
        }
        // [#1095] restore-channel guidance — ephemeral trailing user message
        // (same pattern as prepareAnthropic/Google/Responses).
        const imgNote = imageFullTrailingNote(session);
        if (imgNote) rebuiltMessages = [...rebuiltMessages, { role: "user", content: imgNote }];
        // [#1343/#1457] surface any earlier undelivered retrieve as an ephemeral
        // trailing user note (kept last so it never reorders cached messages).
        // Snapshot WITHOUT consuming: forward() commits the ids only once
        // upstream accepts this request; on failure they ride the next one.
        const retrNotes = snapshotRetrievalNotes(session);
        const retrNote = renderRetrievalNotes(retrNotes);
        if (retrNote) {
            rebuiltMessages = [...rebuiltMessages, { role: "user", content: retrNote }];
            attachedRetrievalNoteIds = retrNotes.map((n) => n.id);
        }
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        if (attachedRetrievals.length > 0) dropRetrievals(session, attachedRetrievals.map((i) => i.ref), "prepare failed; forwarded unprocessed");
        processedMessages = [];
    }

    // #762: repair the strict-echo rejection class BEFORE the sentinel sees
    // the array — a normalized body must not fire its own canary.
    rebuiltMessages = normalizeStrictEchoReasoning(rebuiltMessages, isStrictReasoningEcho(session, upstreamOrigin, modelIdOf(parsed)), log, sessionId);
    const rebuilt: OpenAIRequestBody = { ...parsed, messages: rebuiltMessages, tools: toolsOut as OpenAITool[] | undefined };
    warnReasoningPairs(rebuiltMessages, log, sessionId);
    clampOutgoingOutput(rebuilt as Record<string, unknown>, typeof (parsed as Record<string, unknown>).max_completion_tokens === "number" ? "max_completion_tokens" : "max_tokens", { systemText: openaiSystemText, tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, lastInputTokensSource: session.stats.lastInputTokensSource, nativeWindow, headroomWindow: config.modelContextLimit, imageTokens: imageReserveFor(session, "openai", rebuilt, opts, billingUpstream ?? upstreamOrigin) }, sessionId, log);
    // prompt_cache_retention is an OpenAI-host-only cache directive; the dsh
    // launcher forces PI_CACHE_RETENTION=long (for the session-id
    // prompt_cache_key) which makes the client also emit it. Third-party
    // OpenAI-compatible upstreams may reject unknown fields, and cache policy
    // is the upstream's business — strip it. prompt_cache_key itself passes
    // through: upstreams that ignore it lose nothing, upstreams that use it
    // get a per-conversation routing hint.
    delete (rebuilt as Record<string, unknown>).prompt_cache_retention;
    // OpenAI Chat Completions only emits a usage object in the final stream
    // chunk when the client sets stream_options.include_usage=true. Without
    // it, streaming sessions never learn their real input_tokens →
    // lastInputTokens stays 0 → compression never fires. Force it on for any
    // streaming request that doesn't already opt in. (Anthropic/Responses
    // emit usage unconditionally, so this is OpenAI-specific.)
    if (stream && (rebuilt as Record<string, unknown>).stream_options === undefined) {
        (rebuilt as Record<string, unknown>).stream_options = { include_usage: true };
    }
    // #532: title-gen side requests carry their own tiny system and would
    // clobber the conversation's measured overhead — skip them.
    if (!isTitleGen && openaiOutboundSystem !== undefined) {
        session.metadata.systemPromptTokens = countSystemAndToolsTokens(openaiOutboundSystem, toolsOut);
    }
    // #728: record this turn's outbound payload upper bound as the fallback
    // token source for upstreams that never report usage (see effectiveTokenCount).
    // Title-gen side requests are skipped like the overhead row above — their
    // tiny payload would clobber the conversation's measurement.
    if (!isTitleGen) {
        session.stats.localInputEstimate = estimateCoreMessagesUpper(processedMessages.length > 0 ? processedMessages : originalMessages)
            + countSystemAndToolsTokens(openaiOutboundSystem || openaiSystemText, toolsOut)
            + imageReserveFor(session, "openai", rebuilt, opts, billingUpstream ?? upstreamOrigin);
        // #1933 F1: billed-caliber twin (chars/4) for the k̂ learning pair —
        // see the anthropic-lane counterpart above.
        session.stats.lastLocalTextEstimate = estimateCoreMessages(processedMessages.length > 0 ? processedMessages : originalMessages)
            + countSystemAndToolsTokens(openaiOutboundSystem || openaiSystemText, toolsOut)
            + imageReserveFor(session, "openai", rebuilt, opts, billingUpstream ?? upstreamOrigin);
        const openaiPairOrigin = billingUpstream ?? upstreamOrigin;
        if (openaiPairOrigin) session.stats.lastLocalTextEstimateOrigin = openaiPairOrigin;
    }
    snapshotMessages(session, originalMessages);
    markDirty(session);
    return { body: JSON.stringify(rebuilt), session, attachedRetrievals, attachedRetrievalNoteIds, processedMessages, originalMessages, protocol: "openai", stream, compressInjected: injectTools, pluginMode, nudge, prompts, surface, openaiSystemText, systemNotes: sysNotes, renderTags: knobRenderNone() ? "none" : "text-only", dropReasoning: stripReasoning } as Prepared;
}

/** Append the ephemeral nudge to a Gemini `contents` array. Gemini is
 *  strict about role alternation, so a trailing user turn is merged into
 *  rather than appended to (the nudge then reads as the model's last input,
 *  which is where it belongs); a model-final history gets a fresh user turn
 *  because a request must not end on the model side. */
function appendGoogleNudge(contents: GoogleContent[], text: string): GoogleContent[] {
    const last = contents[contents.length - 1];
    if (last && (last.role ?? "user") !== "model") {
        const parts = Array.isArray(last.parts) ? last.parts : [];
        return [...contents.slice(0, -1), { ...last, parts: [...parts, { text }] }];
    }
    return [...contents, { role: "user", parts: [{ text }] }];
}

/** Gemini native wire (`POST /v1beta/models/<model>:generateContent|
 *  :streamGenerateContent`): the OpenAI branch's twin — hoist the system
 *  dimension out of the fold space, fold, re-inject — with three wire-specific
 *  differences:
 *    - the model, and whether the reply streams, live in the URL PATH, so the
 *      caller passes both in (the body carries neither);
 *    - the system rides in `systemInstruction`, never inside `contents`;
 *    - Gemini rejects non-alternating roles, which coreToGoogle enforces by
 *      merging same-side core runs, so the nudge merges into the trailing user
 *      turn instead of starting a new one.
 *  #651's reasoning drop deliberately does NOT apply here: Gemini 3 validates
 *  the `thoughtSignature` of replayed parts, and dropping a thought part takes
 *  its signature with it (400 INVALID_ARGUMENT). */
async function prepareGoogle(
    parsed: GoogleRequestBody,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    prompts: Prompts,
    surface: PackSurface,
    log: (level: string, msg: string) => void,
    session: Session,
    pluginMode: boolean,
    nativeWindow: number,
    model: string | undefined,
    stream: boolean,
    visibilityMarkers: boolean,
    upstreamOrigin: string,
): Promise<Prepared> {
    const sessionId = session.id;
    ++session.stats.requests;
    let googleClientSystem = "";
    let sysNotes: string[] = [];
    let googleOutboundSystem: string | undefined;
    let systemInstruction: GoogleSystemInstruction | undefined = parsed.systemInstruction;
    let processedMessages: CoreMessage[] = [];
    let originalMessages: CoreMessage[] = [];
    let nudge: NudgeDecision | undefined;
    let rebuiltContents: GoogleContent[] = Array.isArray(parsed.contents) ? parsed.contents : [];
    let toolsOut: GoogleTool[] | undefined = parsed.tools;

    const genConfig = parsed.generationConfig;
    const declaredMax = genConfig ? genConfig.maxOutputTokens : undefined;
    const maxTokens = typeof declaredMax === "number" ? declaredMax : 8192;
    // Title-generation requests (tiny budget) get no compress tooling — same
    // heuristic and same prefix-cache rationale as prepareOpenai.
    const isTitleGen = maxTokens <= 200;
    const shouldInject = opts.compress.injectTool && !isTitleGen;
    const injectTools = shouldInject && !pluginMode;

    const strippedCarriers = stripEmbeddedChainCarriers(parsed, "google");
    if (strippedCarriers > 0) {
        log("info", `[${sessionId}] stripped ${strippedCarriers} embedded chain checkpoint(s) from incoming history (leaked egress control data, issue #1542)`);
    }

    try {
        const { msgs, systemText } = googleToCore(parsed);
        googleClientSystem = systemText;
        // Title-gen side-requests carry their own tiny system — reconciling
        // them would pollute the conversation's anchor state.
        if (opts.stableSystemAnchor && !pluginMode && !isTitleGen) {
            const outcome = reconcileSystemAnchor(session, "google", systemText, sessionId, log);
            sysNotes = outcome.notes;
            googleClientSystem = outcome.outbound;
        }
        originalMessages = msgs;
        const { tokens: tokenCount, source: tokenCountSource } = effectiveTokenCount(session, msgs, imageReserveFor(session, "google", parsed, opts, upstreamOrigin));
        const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
        const absorbBlock = effectiveAbsorbBlock(pluginMode, config, opts.compress.absorb);
        const absorbTools = absorbToolsFor(absorbBlock?.toolName ?? ABSORB_TOOL_NAME);
        const absorbActive = absorbBlock?.enabled === true && shouldInject;
        // acp_rule has no processTurn side effect (no markers/instructions are
        // ever injected into messages), so unlike absorb it needs no loop-
        // config stripping — only tool availability matters.
        const rulesActive = rulesEnabled(config) && shouldInject;
        const loopConfig = ccrLoopConfig(session, { ...config, absorb: absorbActive ? absorbBlock : undefined });
        // [#1921] re-anchor fold coverage onto churned-but-same messages
        // before the #1195 snapshot, so covered ids surviving a client
        // re-serialization stay covered (src/fold-reconcile.ts).
        reconcileFoldCoverage(session, msgs, { mode: resolveFoldReconcileMode(process.env, opts.compress.reconcile), sessionId, log });
        if (!isTitleGen) noteSystemPromptFingerprint(session, systemText, { sessionId, log });
        // #1195: pre-turn snapshot of the fold's covered ids — syncBlocks inside
        // processTurn may deactivate fully-drifted blocks, erasing them.
        const foldCoveredBefore = session.stats.pendingFoldUsage === true
            ? new Set(session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])))
            : null;
        const turn = core.processTurn({ messages: msgs, state: session.state, config: loopConfig, tokenCount, renderTags: "text-only", contentStore: contentStoreOf(session) });
        session.state = turn.state;
        adoptContentStore(session, turn.contentStore);
        // The fold from last turn's compress has materialized in state — future
        // usage reports are post-fold reality, drop the credit.
        session.stats.compressCreditTokens = 0;
        if (foldCoveredBefore !== null && !isTitleGen && msgs.length >= REWRITE_MIN_INCOMING_TOTAL) {
            const gap = foldCoverage(foldCoveredBefore, msgs.map((m) => m.id));
            if (gap) log("warn", `[${sessionId}] [acp-drift] fold coverage mismatch: ${gap.matched}/${gap.expected} covered message id(s) present in resent history — ${gap.expected - gap.matched} covered id(s) missing from resent history — mutation (content edit invalidates content-hash refs, fold silently lost) or client-side deletion/truncation (benign, message no longer on the wire); observability complement to the #1328 overflow rescue (#1195)`);
        }
        storeEffectiveAbsorb(session, loopConfig);
        storeEffectiveRules(session, config);
        turn.messages = applyAbsorbView(turn.messages, session.state, loopConfig, tokenCount);
        turn.messages = attachSubagentSessions(turn.messages, session);
        // Drop sub-viability fragments before any consumer sees them (the
        // kernel validates a compress batch atomically).
        if (turn.nudge) turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
        session.stats.contextTokensSource = tokenCountSource;
        if (!session.meta.title) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        const willInjectNudge = opts.compress.injectNudge && !!turn.nudge && shouldInject && (turn.nudge.shouldInject || emergencyNudge(turn.nudge));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, model, willInjectNudge));
        processedMessages = stripKernelSummaries(turn.messages, turn.state);
        applyCompactionArchive(session, activeBefore, new Set(msgs.map((m) => m.id)), log);
        reapOrphansLogged(session, msgs, log, sessionId);
        // [#1095] arrival-time image downscale (see prepareAnthropic).
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, upstreamOrigin), cap: imageTokenCapFor(opts, upstreamOrigin), log });
        rebuiltContents = coreToGoogle(processedMessages as BiliMessage[]);

        // ONLY the static compress prompt joins the client's system text — the
        // system instruction is the prefix-cache anchor and must stay
        // byte-stable across turns. The per-turn nudge is appended to the
        // trailing user content below (see prepareOpenai for the rationale).
        const sysParts: string[] = [];
        if (googleClientSystem) sysParts.push(googleClientSystem);
        // Same triple-wrap as every other wire (anthropic/responses/openai) and
        // as the folded re-request view (below): the notes are byte-stable
        // constants, so the system anchor stays identical across normal turns
        // and round-2 re-requests — skipping them here would fork the prefix
        // at every fold and collapse the upstream cache hit.
        if (shouldInject) sysParts.push(withMarkerIntegrityNote(withSummaryBudgetNote(buildCompressSystemPrompt(prompts, surface?.promptSections)), visibilityMarkers));
        else if (!isTitleGen) {
            // #1881: the NEVER-echo prohibition follows the rendered tags, not the tool switch.
            const tagsOnly = buildAcpTagsOnlyPrompt("function", prompts, surface?.promptSections);
            if (tagsOnly) sysParts.push(tagsOnly);
        }
        if (absorbActive) sysParts.push(buildAbsorbSystemPrompt(absorbToolName(loopConfig)));
        googleOutboundSystem = sysParts.join("\n\n");
        // Untouched when nothing was added beyond the client's own text: the
        // original `systemInstruction` object then rides through byte-identical
        // instead of being re-serialized into a new shape.
        const extraSystemParts = sysParts.slice(googleClientSystem ? 1 : 0);
        systemInstruction = extraSystemParts.length > 0 ? { parts: sysParts.map((text) => ({ text })) } : parsed.systemInstruction;
        if (injectTools) {
            toolsOut = injectGoogleTool(parsed.tools, [...(absorbActive ? [absorbTools.google] : []), ...(rulesActive ? [RULE_TOOL_GOOGLE] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).google] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL_GOOGLE] : [])], surface?.toolPrompts, ccrEnabled(session));
        }
        if (sysNotes.length > 0) {
            rebuiltContents = appendGoogleNudge(rebuiltContents, sysNotes.join("\n\n---\n\n"));
        }
        if (willInjectNudge && turn.nudge) {
            try {
                const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections);
                if (rendered.text) {
                    rebuiltContents = appendGoogleNudge(rebuiltContents, withMarkerIntegrityNote(withStagedCompressGuidance(rendered.text), visibilityMarkers));
                }
            } catch {
            }
        }
        // [#1095] restore-channel guidance — ephemeral trailing note (see prepareAnthropic).
        const imgNote = imageFullTrailingNote(session);
        if (imgNote) rebuiltContents = appendGoogleNudge(rebuiltContents, imgNote);
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    const rebuilt: GoogleRequestBody = { ...parsed, contents: rebuiltContents, tools: toolsOut, systemInstruction };
    clampOutgoingOutput(rebuilt as Record<string, unknown>, "generationConfig.maxOutputTokens", { systemText: googleClientSystem, tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, lastInputTokensSource: session.stats.lastInputTokensSource, nativeWindow, headroomWindow: config.modelContextLimit, imageTokens: imageReserveFor(session, "google", rebuilt, opts, upstreamOrigin) }, sessionId, log);
    // #532: title-gen side requests carry their own tiny system — skip them.
    if (!isTitleGen && googleOutboundSystem !== undefined) {
        session.metadata.systemPromptTokens = countSystemAndToolsTokens(googleOutboundSystem, toolsOut);
    }
    snapshotMessages(session, originalMessages);
    markDirty(session);
    return { body: JSON.stringify(rebuilt), session, processedMessages, originalMessages, protocol: "google", stream, compressInjected: injectTools, pluginMode, nudge, prompts, surface, google: { system: googleClientSystem, model }, systemNotes: sysNotes, renderTags: "text-only" } as Prepared;
}

/** `POST /v1beta/models/<model>:countTokens` — the fold-prune twin of
 *  prepareCountTokens: the client measures the payload the proxy would
 *  actually forward. Gemini's endpoint reads `contents`/`systemInstruction`
 *  and answers `{totalTokens}`, so only the contents array is rewritten. */
export function prepareGoogleCountTokens(
    parsed: GoogleRequestBody,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
    session: Session,
): Prepared {
    const sessionId = session.id;
    try {
        const { msgs } = googleToCore(parsed);
        // Read-only preview: the store rides in so placeholder substitution is
        // counted, but nothing is adopted (state is discarded here too).
        const turn = core.processTurn({ messages: msgs, state: session.state, config: ccrLoopConfig(session, config), tokenCount: usageGradeInputBaseline(session), renderTags: "text-only", contentStore: contentStoreOf(session) });
        const stripped = stripKernelSummaries(turn.messages, turn.state);
        const rebuilt: GoogleRequestBody = { ...parsed, contents: coreToGoogle(stripped as BiliMessage[]) };
        log("info", `[${sessionId}] countTokens pruned: ${msgs.length} → ${stripped.length} msgs`);
        return {
            body: JSON.stringify(rebuilt),
            session,
            processedMessages: [],
            originalMessages: msgs,
            protocol: "google",
            stream: false,
            compressInjected: false,
        };
    } catch (err) {
        log("warn", `[${sessionId}] countTokens prune failed, forwarding unchanged: ${String(err)}`);
        return {
            body: JSON.stringify({ ...parsed }),
            session,
            processedMessages: [],
            originalMessages: [],
            protocol: "google",
            stream: false,
            compressInjected: false,
        };
    }
}

async function prepareResponses(
    parsed: ResponsesRequestBody,
    req: http.IncomingMessage,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    prompts: Prompts,
    surface: PackSurface,
    log: (level: string, msg: string) => void,
    session: Session,
    identity: ConversationIdentity,
    pluginMode: boolean,
    upstreamOrigin: string,
    nativeWindow: number,
    reasoning: CompressReasoningConfig | undefined,
    visibilityMarkers: boolean,
    billingUpstream?: string,
): Promise<Prepared> {
    const sessionId = session.id;
    const stream = parsed.stream === true;
    ++session.stats.requests;
    const stripReasoning = (msgs: BiliMessage[]): BiliMessage[] => withReasoningDrop(msgs, reasoning, log, sessionId, isStrictReasoningEcho(session, upstreamOrigin, modelIdOf(parsed)));
    if (reconcileNativeCompactionBoundary(session)) {
        log("info", `[${sessionId}] reconciled ACP state after native Responses compact boundary`);
    }

    // A codex client echoes our forged compaction item back in the next
    // request; replace it with a plain summary-carrying user message so the
    // handoff rides the replayable history (kernel-compressible, retained by
    // codex's own user-message rule) instead of a foreign opaque blob. Real
    // OpenAI blobs carry no bili marker and pass through untouched.
    let echoReplaced = false;
    if (Array.isArray(parsed.input)) {
        const { items, replaced, dropped } = replaceBiliCompactionItems(parsed.input);
        if (replaced + dropped > 0) {
            // Only a real replacement carries a summary into the history; a
            // drop-only echo removed a marker blob without inserting one, so the
            // forge-time captured summaries must still be re-injected (#1064).
            if (replaced > 0) echoReplaced = true;
            log("info", `[${sessionId}] replaced ${replaced} echoed bili compaction item(s) with summary handoff message(s)${dropped > 0 ? `, dropped ${dropped} legacy marker item(s)` : ""}`);
            parsed.input = items as typeof parsed.input;
        }
    }

    let processedMessages: CoreMessage[] = [];
    let originalMessages: CoreMessage[] = [];
    let nudge: NudgeDecision | undefined;
    let responsesProjection: ResponsesProjection | undefined;
    let rebuiltInput: ResponseInputItem[] | string = parsed.input;
    let toolsOut = parsed.tools;
    let transformOk = false;
    let responsesDevContent: string | undefined;
    let sysNotes: string[] = [];

    // #242: over-long input item ids (poisoned rollouts) 400 upstream on every
    // request; rewrite them to short deterministic ids before anything reads
    // or replays the input.
    // omp-style type-less user items must be typed before the projection
    // drops them (see normalizeResponsesMessageItems) — before id sanitize and
    // whitespace drop so those see the canonical form.
    const typedItems = normalizeResponsesMessageItems(parsed.input);
    if (typedItems > 0) {
        log("info", `[${sessionId}] stamped type:"message" on ${typedItems} type-less input item(s) before projection (omp wire form)`);
    }
    sanitizeResponsesInputIds(parsed.input);

    const droppedEmpty = dropWhitespaceResponsesMessages(parsed.input);
    if (droppedEmpty > 0) {
        log("info", `[${sessionId}] dropped ${droppedEmpty} whitespace-only message item(s) before projection (flattened-turn artifact)`);
    }

    const strippedPanels = stripAcpPanelResponsesInput(parsed.input);
    if (strippedPanels > 0) {
        log("info", `[${sessionId}] stripped ${strippedPanels} ACP panel message(s) before projection (UI-only, issue #359)`);
    }
    const strippedMarkerLines = stripAcpStatusMarkers(parsed.input);
    if (strippedMarkerLines > 0) {
        log("info", `[${sessionId}] stripped ${strippedMarkerLines} ACP status marker line(s) from incoming history (ephemeral proxy status, issue #1029)`);
    }
    const strippedCarriers = stripEmbeddedChainCarriers(parsed, "responses");
    if (strippedCarriers > 0) {
        log("info", `[${sessionId}] stripped ${strippedCarriers} embedded chain checkpoint(s) from incoming history (leaked egress control data, issue #1542)`);
    }

    const shouldInject = opts.compress.injectTool;
    const injectTools = shouldInject && !pluginMode;
    // Codex native remote-compact request: no compress prompt/tools (the model
    // produces the compaction itself), no acp tags, plain passthrough so the
    // response terminal state can gate the rebase marker.
    const isCompactionTrigger = hasCompactionTrigger(parsed.input);
    // Route config is keyed by the upstream THIS request goes to (#286: a
    // session can outlive its first relay — session.meta.upstreamOrigin is
    // first-wins and would silently ignore the new relay's route settings).
    const responsesTextProtocol = FORCE_TEXT_PROTOCOL ||
        resolveCompressProtocol(opts.routes, upstreamOrigin) === "marker";
    const renderTags: "text-only" | "none" = knobRenderNone() || isCompactionTrigger ? "none" : "text-only";

    try {
        // [#1638] Plugin mode: position-preserve mid-history system/developer
        // items. Clients like OMP append custom_message-derived developer
        // notifications mid-history and re-send them every turn; the kernel
        // hoists system/developer content from ANY position into
        // projection.systemParts, so the merged developer block injected at
        // the front of the rebuilt input churns every turn and breaks the
        // upstream prefix cache (sawtooth down to the instructions-only
        // residual). Marking the non-head items with an unknown type just for
        // the duration of responsesToCore keeps them out of systemParts and
        // puts them in the projection layout as coreId-less slots, which
        // patchResponsesInput re-emits verbatim in their original position —
        // the position-preserved semantics the openai-chat wire already has
        // (head-only hoist, kernel src/wire/openai.ts). Proxy mode (native
        // codex) keeps the hoist-and-anchor behavior (#1085).
        const inplaceSysDev: { item: { type?: string; role?: unknown }; type: string | undefined }[] = [];
        if (pluginMode && Array.isArray(parsed.input)) {
            let head = true;
            for (const rawItem of parsed.input) {
                const item = rawItem as { type?: string; role?: unknown };
                const isSysDevMsg = (item.type === undefined || item.type === "message") &&
                    (item.role === "system" || item.role === "developer");
                if (isSysDevMsg) {
                    if (head) continue;
                    inplaceSysDev.push({ item, type: item.type });
                    item.type = "__bili_inplace_sysdev";
                    continue;
                }
                if (item.type === "additional_tools" || item.type === "mcp_list_tools") continue;
                head = false;
            }
        }
        const projection = responsesToCore(parsed);
        for (const { item, type } of inplaceSysDev) {
            if (type === undefined) delete item.type;
            else item.type = type;
        }
        responsesProjection = projection;
        // Client's own system text captured BEFORE the anchor reconciliation
        // below can replace systemParts — fingerprinting the post-anchor value
        // would track bili's managed text and hide client-side drift (#1930-3).
        const responsesClientSystem = projection.systemParts.join("\n\n---\n\n");
        // Compaction-trigger requests are the compression mechanism itself —
        // their payload shape must not gain anchor state or note items.
        if (opts.stableSystemAnchor && !pluginMode && !isCompactionTrigger) {
            const fresh = projection.systemParts.join("\n\n---\n\n");
            const outcome = reconcileSystemAnchor(session, "responses", fresh, sessionId, log);
            sysNotes = outcome.notes;
            if (outcome.outbound !== fresh) projection.systemParts = outcome.outbound ? [outcome.outbound] : [];
        }
        const { msgs } = projection;
        originalMessages = msgs;
        if (opts.debug) {
            log("info", `[${sessionId}] input items: ${Array.isArray(parsed.input) ? parsed.input.map((i: ResponseInputItem) => i.type).join(",") : "(string)"}`);
        }
        const { tokens: tokenCount, source: tokenCountSource } = effectiveTokenCount(session, msgs, imageReserveFor(session, "responses", parsed, opts, billingUpstream ?? upstreamOrigin));
        // Absorb markers ride in the kernel's processTurn output (gated by
        // config.absorb). The marker/text protocol has no native tool channel,
        // so strip absorb from the loop config there (both modes).
        const absorbBlock = effectiveAbsorbBlock(pluginMode, config, opts.compress.absorb);
        const absorbTools = absorbToolsFor(absorbBlock?.toolName ?? ABSORB_TOOL_NAME);
        const absorbActive = absorbBlock?.enabled === true && shouldInject && !isCompactionTrigger && !responsesTextProtocol;
        const rulesActive = rulesEnabled(config) && shouldInject && !isCompactionTrigger && !responsesTextProtocol;
        const loopConfig = ccrLoopConfig(session, { ...config, absorb: absorbActive ? absorbBlock : undefined });
        // [#1921] re-anchor fold coverage onto churned-but-same messages
        // before the #1195 snapshot, so covered ids surviving a client
        // re-serialization stay covered (src/fold-reconcile.ts).
        reconcileFoldCoverage(session, msgs, { mode: resolveFoldReconcileMode(process.env, opts.compress.reconcile), sessionId, log });
        if (!isCompactionTrigger) noteSystemPromptFingerprint(session, responsesClientSystem, { sessionId, log });
        // #1195: pre-turn snapshot of the fold's covered ids — syncBlocks inside
        // processTurn may deactivate fully-drifted blocks, erasing them.
        const foldCoveredBefore = session.stats.pendingFoldUsage === true
            ? new Set(session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])))
            : null;
        const turn = core.processTurn({ messages: msgs, state: session.state, config: loopConfig, tokenCount, renderTags, contentStore: contentStoreOf(session) });
        session.state = turn.state;
        adoptContentStore(session, turn.contentStore);
        // The fold from last turn's compress has now materialized in state —
        // future usage reports are post-fold reality, drop the credit.
        session.stats.compressCreditTokens = 0;
        if (foldCoveredBefore !== null && !isCompactionTrigger && msgs.length >= REWRITE_MIN_INCOMING_TOTAL) {
            const gap = foldCoverage(foldCoveredBefore, msgs.map((m) => m.id));
            if (gap) log("warn", `[${sessionId}] [acp-drift] fold coverage mismatch: ${gap.matched}/${gap.expected} covered message id(s) present in resent history — ${gap.expected - gap.matched} covered id(s) missing from resent history — mutation (content edit invalidates content-hash refs, fold silently lost) or client-side deletion/truncation (benign, message no longer on the wire); observability complement to the #1328 overflow rescue (#1195)`);
        }
        storeEffectiveAbsorb(session, loopConfig);
        storeEffectiveRules(session, config);
        turn.messages = applyAbsorbView(turn.messages, session.state, loopConfig, tokenCount);
        turn.messages = attachSubagentSessions(turn.messages, session);
        // Drop sub-viability fragments before any consumer sees them: a tiny
        // range in the list makes batched compress attempts fail atomically
        // (kernel validates the whole batch). Mirrors billion-context-pi.
        if (turn.nudge) turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
        session.stats.contextTokensSource = tokenCountSource;
        if (!session.meta.title) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        const willInjectNudge = opts.compress.injectNudge && !!turn.nudge && shouldInject && !isCompactionTrigger && (turn.nudge.shouldInject || emergencyNudge(turn.nudge));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, parsed.model, willInjectNudge));
        processedMessages = repairResponsesAssistantOrdering(stripReasoning(stripKernelSummaries(turn.messages, turn.state)), originalMessages);
        reapOrphansLogged(session, msgs, log, sessionId);
        // [#1095] arrival-time image downscale (see prepareAnthropic).
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, billingUpstream ?? upstreamOrigin), cap: imageTokenCapFor(opts, billingUpstream ?? upstreamOrigin), log });
        rebuiltInput = patchResponsesInput(projection, processedMessages);
        if (Array.isArray(rebuiltInput)) rebuiltInput = mergeAdjacentConfigurationUpdates(hoistTrappedToolItems(rebuiltInput));
        // Fallback path: when the echo did NOT come back this turn (client
        // dropped it / restarted), the history-borne handoff is absent and the
        // forge-time captured summaries are re-injected into the developer
        // message so the pre-compaction content is never lost. When the echo
        // DID come back, the replacement message carries the summaries and
        // the injection is suppressed to avoid duplicating them.
        const forgedSummaries = echoReplaced
            ? []
            : (session.metadata.codexForgedSummaries as string[] | undefined) ?? [];
        // #1881: the NEVER-echo prohibition follows the rendered tags, not the tool switch.
        const tagsOnlyPrompt = !shouldInject && !isCompactionTrigger && !knobNoCompressPrompt() && !knobRenderNone()
            ? buildAcpTagsOnlyPrompt(responsesTextProtocol ? "hybrid" : "function", prompts, surface?.promptSections)
            : "";
        if (shouldInject && !isCompactionTrigger && !knobNoCompressPrompt()) {
            const prompt = withMarkerIntegrityNote(withSummaryBudgetNote(responsesTextProtocol ? buildCompressHybridSystemPrompt(prompts, surface?.promptSections) : buildCompressSystemPrompt(prompts, surface?.promptSections)), visibilityMarkers);
            const devParts = [...projection.systemParts, ...forgedSummaries, prompt];
            if (absorbActive) devParts.push(buildAbsorbSystemPrompt(absorbToolName(loopConfig)));
            const devContent = devParts.join("\n\n---\n\n");
            responsesDevContent = devContent;
            if (forgedSummaries.length > 0) log("debug", `[${sessionId}] [inject] ${forgedSummaries.length} captured summary block(s) re-injected into developer message`);
            rebuiltInput = injectResponsesDeveloperMessage(rebuiltInput, devContent);
            if (!knobNoInjectTool() && injectTools) {
                // #1712: decompress's startId/endId execute only on CCR-armed
                // sessions (#1179) — serve the no-range schema otherwise.
                const ccrOn = ccrEnabled(session);
                const respExtra = [...(absorbActive ? [absorbTools.responses] : []), ...(rulesActive ? [RULE_TOOL_RESPONSES] : []), ...(ccrOn ? [retrieveToolsFor(retrieveToolName(session)).responses] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL_RESPONSES] : [])];
                toolsOut = responsesTextProtocol
                    ? injectResponsesTool(parsed.tools, ccrOn ? BILI_ACP_READONLY_TOOLS_RESPONSES : BILI_ACP_READONLY_TOOLS_RESPONSES_NO_RANGE, surface?.toolPrompts)
                    : injectResponsesTool(parsed.tools, respExtra.length > 0 ? [...(ccrOn ? BILI_ACP_TOOLS_RESPONSES : BILI_ACP_TOOLS_RESPONSES_NO_RANGE), ...respExtra] : (ccrOn ? BILI_ACP_TOOLS_RESPONSES : BILI_ACP_TOOLS_RESPONSES_NO_RANGE), surface?.toolPrompts);
            }
        } else if (tagsOnlyPrompt !== "" || projection.systemParts.length > 0 || forgedSummaries.length > 0) {
            const devContent = [...projection.systemParts, ...forgedSummaries, ...(tagsOnlyPrompt !== "" ? [tagsOnlyPrompt] : [])].join("\n\n---\n\n");
            responsesDevContent = devContent;
            if (forgedSummaries.length > 0) log("debug", `[${sessionId}] [inject] ${forgedSummaries.length} captured summary block(s) re-injected into developer message`);
            rebuiltInput = injectResponsesDeveloperMessage(rebuiltInput, devContent);
        }
        if (sysNotes.length > 0) {
            const inputItems: ResponseInputItem[] = typeof rebuiltInput === "string"
                ? [{ type: "message", role: "user", content: rebuiltInput }]
                : rebuiltInput;
            for (const text of sysNotes) {
                inputItems.push({ type: "message", role: "user", content: text });
            }
            rebuiltInput = inputItems;
        }
        // A nudge appended after a trailing `compaction_trigger` would break
        // the upstream's "must be the final input item" requirement and is
        // redundant — the native compact IS the compression. Otherwise injected
        // in BOTH modes (#451): plugin agents supply the ACP tools but have no
        // nudge channel of their own, so this proxy-side nudge is the proactive
        // trigger (preflight alone fires only at the hard limit). Ephemeral user
        // message — not persisted, prefix-cache-anchor safe.
        if (willInjectNudge && turn.nudge) {
            try {
                const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections);
                if (rendered.text) {
                    const inputItems: ResponseInputItem[] = typeof rebuiltInput === "string"
                        ? [{ type: "message", role: "user", content: rebuiltInput }]
                        : rebuiltInput;
                    inputItems.push({ type: "message", role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withStagedCompressGuidance(rendered.text)), visibilityMarkers) });
                    rebuiltInput = inputItems;
                    log("debug", `[${sessionId}] [inject] ephemeral nudge appended as trailing user turn (${rendered.text.length} chars)`);
                }
            } catch {
            }
        }
        // [#1095] restore-channel guidance — ephemeral trailing note (see
        // prepareAnthropic). Never after a compaction_trigger: that item must
        // stay the final input item (#283/#209), and the forge path for trigger
        // requests builds its own body anyway.
        const imgNote = imageFullTrailingNote(session);
        if (imgNote && !isCompactionTrigger) {
            const inputItems: ResponseInputItem[] = typeof rebuiltInput === "string"
                ? [{ type: "message", role: "user", content: rebuiltInput }]
                : rebuiltInput;
            inputItems.push({ type: "message", role: "user", content: imgNote });
            rebuiltInput = inputItems;
            log("debug", `[${sessionId}] [inject] image-full restore note appended as trailing user turn (${imgNote.length} chars)`);
        }
        transformOk = true;
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    // E2 trigger form: codex's native remote-compaction request (final input item
    // is compaction_trigger). When the kill-switch is on, the client is codex, and
    // the safety gate passes, forge a success SSE (one compaction item +
    // response.completed) and skip upstream — a deterministic handoff to the ACP
    // state instead of a foreign compaction blob.
    let codexForge: Prepared["codexForge"] | undefined;
    if (transformOk
        && codexCompactMode() === "intercept"
        && isCodexClient(req.headers)
        && hasCompactionTrigger(parsed.input)
        && codexCompactGate(session, config.modelContextLimit, transformOk)) {
        const summaries = session.state.blocks.filter((b) => b.active).map((b) => b.summary);
        const prevForged = session.metadata.codexForgedSummaries as string[] | undefined;
        const captured = mergeForgedSummaries(prevForged, session.state.blocks);
        if (captured.length !== (prevForged?.length ?? 0)) {
            session.metadata.codexForgedSummaries = captured;
            markDirty(session);
        }
        // Codex recomputes its ledger from the next real request, but the
        // usage we mint here must not read as an empty context: fall back to
        // estimating the trigger payload itself when lastInputTokens is
        // stale/zero. The reply honors parsed.stream (JSON body when not
        // streaming).
        const est = defaultCountTokens(typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input ?? ""));
        const total = Math.max(session.stats.lastInputTokens, est, 1);
        codexForge = {
            kind: "trigger",
            ...buildTriggerForgeBody(summaries.join("\n\n"), { inputTokens: total, outputTokens: 0, totalTokens: total }, stream),
        };
        log("info", `[${sessionId}] codex compact intercepted (trigger); forged SSE with ${summaries.length} block summary(s), upstream not contacted`);
    }

    // #1479: Responses-wire twin of the #762 repair — fold + kernel round-trip
    // can leave a tool-call run without its reasoning item. Repair BEFORE the
    // sentinel sees the array (a normalized body must not fire its own canary).
    if (Array.isArray(rebuiltInput)) rebuiltInput = normalizeStrictEchoResponsesInput(rebuiltInput, isStrictReasoningEcho(session, upstreamOrigin, modelIdOf(parsed)), log, sessionId);
    const rebuilt: ResponsesRequestBody = { ...parsed, input: rebuiltInput, tools: toolsOut };
    warnResponsesReasoningPairs(Array.isArray(rebuiltInput) ? rebuiltInput : [], log, sessionId);
    if (!isCompactionTrigger) {
        clampOutgoingOutput(rebuilt as Record<string, unknown>, "max_output_tokens", { systemText: (responsesProjection?.systemParts ?? []).join("\n"), tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, lastInputTokensSource: session.stats.lastInputTokensSource, nativeWindow, headroomWindow: config.modelContextLimit, imageTokens: imageReserveFor(session, "responses", rebuilt, opts, billingUpstream ?? upstreamOrigin) }, sessionId, log);
    }
    // Route with the upstream THIS request goes to — session.meta.upstreamOrigin
    // is first-wins and would keep injecting pck toward a relay we switched
    // away from (same class of bug as the compressProtocol fix above, #286).
    const promptCacheKey = resolvePromptCacheKey(
        rebuilt.prompt_cache_key,
        identity,
        opts.promptCache.routing,
        upstreamOrigin,
    );
    if (promptCacheKey && !rebuilt.prompt_cache_key) rebuilt.prompt_cache_key = promptCacheKey;
    // This adapter is stateless: we replay the FULL conversation in `input`.
    // Strip Responses' native chaining field so the upstream does not resolve
    // stored server-side state ON TOP of the input we already sent (which would
    // duplicate history for clients that use store:true + chaining). Empirically
    // codex sends store:false and never sets previous_response_id, so this is a
    // no-op for codex — kept defensively for any client that does chain. Set
    // ACP_KEEP_RESPONSE_ID=1 / compat.keepResponseId=true to preserve it (diagnostic only). `instructions`
    // was already lifted into the developer message at input[1]; forwarding it
    // again here double-sends it and violates the responses_lite contract
    // (top-level instructions must stay empty for code_mode tool exposure).
    // #1954: stripping is only lossless when input already holds the full
    // conversation. Warn when we strip a non-empty id so a native-chaining
    // (delta) continuation that loses its history is visible, not silent 200s.
    if (!knobKeepResponseId()) {
        const chainWarn = strippedResponseIdWarning(rebuilt.previous_response_id);
        if (chainWarn) log("warn", `[${sessionId}] ${chainWarn}`);
        delete rebuilt.previous_response_id;
    }
    delete rebuilt.instructions;
    // Same rationale as prepareOpenai: strip the OpenAI-host-only cache
    // directive; keep prompt_cache_key. Sent by hermes' codex transport and
    // by any PI_CACHE_RETENTION=long client.
    delete (rebuilt as Record<string, unknown>).prompt_cache_retention;
    // Log the final tools we forward upstream so we can confirm ACP tools are
    // present. Distinguishes "compress" (top-level function) from Codex
    // namespace items (type:namespace/custom).
    if (opts.debug) {
        const fwdTools = (Array.isArray(toolsOut) ? toolsOut : []).map((t) => {
            const r = t as Record<string, unknown>;
            const sub = Array.isArray(r.tools) ? `(${r.tools.length} sub)` : "";
            return `${r.type as string}:${(r.name as string) ?? "?"}${sub}`;
        });
        log("info", `[${sessionId}] responses forward tools=[${fwdTools.join(",")}] injectTool=${injectTools}${pluginMode ? " (plugin mode: wire injection suppressed)" : ""} NO_INJECT_TOOL=${knobNoInjectTool()} NO_COMPRESS_PROMPT=${knobNoCompressPrompt()}`);
    }
    // #532: measure the outbound developer(system)+tools overhead for the panel.
    // On this wire the system rides the injected developer message outside the
    // fold space, so counting devContent + tools does not double-count the
    // mid-history items the kernel already classifies.
    if (transformOk) {
        session.metadata.systemPromptTokens = countSystemAndToolsTokens(responsesDevContent ?? "", toolsOut);
    }
    // #728: record this turn's outbound payload upper bound as the fallback
    // token source for upstreams that never report usage (see effectiveTokenCount).
    // Compaction-trigger requests are the compression mechanism itself — no
    // incremental decision hangs off them, so don't leave a stale reading.
    if (!isCompactionTrigger) {
        session.stats.localInputEstimate = estimateCoreMessagesUpper(processedMessages.length > 0 ? processedMessages : originalMessages)
            + countSystemAndToolsTokens(responsesDevContent ?? "", toolsOut)
            + imageReserveFor(session, "responses", rebuilt, opts, billingUpstream ?? upstreamOrigin);
        // #1933 F1: billed-caliber twin (chars/4) for the k̂ learning pair —
        // see the anthropic-lane counterpart above.
        session.stats.lastLocalTextEstimate = estimateCoreMessages(processedMessages.length > 0 ? processedMessages : originalMessages)
            + countSystemAndToolsTokens(responsesDevContent ?? "", toolsOut)
            + imageReserveFor(session, "responses", rebuilt, opts, billingUpstream ?? upstreamOrigin);
        const responsesPairOrigin = billingUpstream ?? upstreamOrigin;
        if (responsesPairOrigin) session.stats.lastLocalTextEstimateOrigin = responsesPairOrigin;
    }
    snapshotMessages(session, originalMessages);
    markDirty(session);
    return {
        body: JSON.stringify(rebuilt),
        session,
        processedMessages,
        originalMessages,
        responsesProjection,
        systemNotes: sysNotes,
        protocol: "responses",
        stream,
        compressInjected: injectTools && !isCompactionTrigger,
        pluginMode,
        responsesTextProtocol,
        nudge,
        prompts,
        surface,
        renderTags,
        resetAfterSuccess: isCompactionTrigger,
        codexForge,
        dropReasoning: stripReasoning,
    };
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

function prepareResponsesCompact(
    body: Buffer,
    parsed: ResponsesRequestBody,
    session: Session,
    req: http.IncomingMessage,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
): Prepared {
    ++session.stats.requests;
    // A bili-forged compaction item is never for the upstream (it carries our
    // sentinel blob) — strip it on every forwarding path, same as the normal
    // /responses pipeline does.
    const cleaned = Array.isArray(parsed.input) ? stripBiliCompactionItems(parsed.input) : parsed.input;
    const stripped = Array.isArray(parsed.input) && cleaned.length !== parsed.input.length;
    const forgeBody: ResponsesRequestBody = { ...parsed, input: cleaned };
    const base: Prepared = {
        body: stripped ? Buffer.from(JSON.stringify(forgeBody)) : body,
        session,
        processedMessages: [],
        originalMessages: [],
        protocol: "responses",
        stream: parsed.stream === true,
        compressInjected: false,
        resetAfterSuccess: true,
    };
    // #332: gate preconditions BEFORE the transform — when they fail the
    // request passes through verbatim without running processTurn (no state
    // mutation as a side effect of a compact that will not be intercepted).
    if (codexCompactMode() !== "intercept" || !isCodexClient(req.headers) || !Array.isArray(parsed.input)
        || !codexCompactGatePre(session, config.modelContextLimit)) {
        return base;
    }
    // The state commit below is all-or-nothing: every non-forge path restores
    // the pre-turn state so a passthrough compact is not raced against a
    // half-applied fold (the upstream's own compaction boundary is handled by
    // markNativeCompactionBoundary + rebase instead).
    const prevState = session.state;
    const prevStore = session.contentStore;
    const prevStoreDirty = session.contentStoreDirty === true;
    // E2 endpoint form: /responses/compact. When the gate passes, run the same
    // fold pipeline as a normal turn and forge the compacted history as
    // {"output": [...]} — a deterministic handoff to the ACP state instead of a
    // foreign compaction blob.
    let transformOk = false;
    try {
        const projection = responsesToCore(forgeBody);
        // The forged handoff is one-shot with no tool channel: strip absorb so
        // no [ACP absorb] instruction bakes into the forged history, and run
        // the absorb view so absorbed pairs stay hidden in it (wire parity).
        const compactConfig = ccrLoopConfig(session, { ...config, absorb: undefined });
        const turn = core.processTurn({ messages: projection.msgs, state: session.state, config: compactConfig, tokenCount: usageGradeInputBaseline(session), renderTags: knobRenderNone() ? "none" : "text-only", contentStore: contentStoreOf(session) });
        session.state = turn.state;
        adoptContentStore(session, turn.contentStore);
        transformOk = true;
        if (!codexCompactGate(session, config.modelContextLimit, transformOk)) {
            session.state = prevState;
            session.contentStore = prevStore;
            session.contentStoreDirty = prevStoreDirty;
            return base;
        }
        const viewed = applyAbsorbView(turn.messages, turn.state, compactConfig, usageGradeInputBaseline(session));
        const processed = repairResponsesAssistantOrdering(stripKernelSummaries(viewed, turn.state), projection.msgs);
        let output = patchResponsesInput(projection, processed);
        if (typeof output === "string") {
            session.state = prevState;
            session.contentStore = prevStore;
            session.contentStoreDirty = prevStoreDirty;
            return base;
        }
        output = mergeAdjacentConfigurationUpdates(hoistTrappedToolItems(output));
        snapshotMessages(session, projection.msgs);
        markDirty(session);
        log("info", `[${session.id}] codex compact intercepted (endpoint); forged history with ${output.length} item(s), upstream not contacted`);
        return { ...base, codexForge: { kind: "endpoint", body: JSON.stringify({ output }), contentType: "application/json" } };
    } catch (err) {
        session.state = prevState;
        session.contentStore = prevStore;
        session.contentStoreDirty = prevStoreDirty;
        log("warn", `[${session.id}] codex compact forge failed (${String(err)}); passing through to upstream`);
        return base;
    }
}

export function isChatGptCodexUpstream(upstream: string | undefined): boolean {
    if (!upstream) return false;
    try {
        return new URL(upstream).hostname.toLowerCase() === "chatgpt.com";
    } catch {
        return false;
    }
}

export function isCodexResponsesLite(headers: http.IncomingHttpHeaders, _body: ResponsesRequestBody): boolean {
    // additional_tools is NOT a lite signal: codex always sends it and it coexists
    // with injected `tools` (verified end-to-end). Only the explicit header counts.
    if (headers["x-openai-internal-codex-responses-lite"] !== undefined) return true;
    return false;
}

export function shouldInjectPromptCacheKey(
    routing: ProxyOptions["promptCache"]["routing"],
    upstream: string | undefined,
): boolean {
    if (routing === "enabled") return true;
    if (routing === "disabled" || !upstream) return false;
    try {
        return new URL(upstream).hostname.toLowerCase() === "api.openai.com";
    } catch {
        return false;
    }
}

export function resolvePromptCacheKey(
    explicit: string | undefined,
    identity: ConversationIdentity,
    routing: ProxyOptions["promptCache"]["routing"],
    upstream: string | undefined,
): string | undefined {
    if (explicit?.trim()) return explicit;
    if (!identity.clientProvided || !shouldInjectPromptCacheKey(routing, upstream)) return undefined;
    return identity.value;
}

// Claude Code's auto-mode safety classifier one-shots expect a strict XML
// verdict — the default `xml_2stage` mode stops the response at `</severity>`
// or `</block>`. These are not compressible conversations: the compress
// system-prompt + ACP tools (or the kernel round-trip) derailed the small model
// from that verdict, so the classifier reported "could not evaluate" (#353).
// The magic stop sequences are the only in-body signal; forward them untouched.
const AUTO_MODE_CLASSIFIER_STOPS = new Set(["</severity>", "</block>"]);

function isAutoModeClassifier(parsed: AnthropicRequestBody): boolean {
    const stops = parsed.stop_sequences;
    if (!Array.isArray(stops)) return false;
    return stops.some((s) => typeof s === "string" && AUTO_MODE_CLASSIFIER_STOPS.has(s));
}

// #1359: which absorb block governs a session, by lane. Proxy lane keeps the
// per-request merged block (provider/model overrides apply); plugin lane uses
// the base block so the manifest's advertised name and the gate's adjudicated
// name always agree — provider/model absorb.* overrides are proxy-lane-only.
function effectiveAbsorbBlock(pluginMode: boolean, config: Config, baseAbsorb?: CompressSettings["absorb"]): AbsorbConfig | undefined {
    return pluginMode ? resolveAbsorbSettings(baseAbsorb) : config.absorb;
}

function injectSystem(
    parsed: AnthropicRequestBody,
    opts: ProxyOptions,
    prompts: Prompts = defaultPrompts,
    config: Config,
    surface?: PackSurface,
    visibilityMarkers = true,
): string | AnthropicRequestBody["system"] {
    // ONLY the static compress prompt goes into the system block — it is the
    // prefix-cache anchor and must stay byte-stable across turns. The nudge
    // (which changes every turn) is appended as a trailing user message by
    // the caller (prepareAnthropic), never merged into system.
    const parts: string[] = [];
    if (opts.compress.injectTool) parts.push(withMarkerIntegrityNote(withSummaryBudgetNote(buildCompressSystemPrompt(prompts, surface?.promptSections)), visibilityMarkers));
    else if (!knobRenderNone()) {
        // #1881: the NEVER-echo prohibition follows the rendered tags, not the tool switch.
        const tagsOnly = buildAcpTagsOnlyPrompt("function", prompts, surface?.promptSections);
        if (tagsOnly) parts.push(tagsOnly);
    }
    if (opts.compress.injectTool && absorbEnabled(config)) parts.push(buildAbsorbSystemPrompt(absorbToolName(config)));
    if (parts.length === 0) return parsed.system;
    // #1876: APPEND the prompt as a trailing block (client blocks byte-exact)
    // instead of merging everything into one block via kernel buildSystem.
    return appendSystemText(parts.join("\n\n"), parsed.system);
}

// #920: in proxy mode bili OWNS the compression tool names. Agent-side tools
// with the same name (opencode-acp's statically-registered DCP set ships in
// every opencode request body — the v1 tool registry is process-global and
// cannot be filtered per request) are dropped here so the upstream sees
// exactly one definition per name, and it is bili's (its arg schemas are what
// the compress loop dispatches on). Plugin mode never calls these helpers.
function injectTool(tools: unknown[] | undefined, extras?: readonly { name: string }[], toolPrompts?: ToolPrompts, ccrOn = false): unknown[] {
    // #1712: decompress's startId/endId execute only on CCR-armed sessions
    // (#1179), so serve the no-range schema when CCR is off.
    const acp = applyAcpToolOverrides(ccrOn ? BILI_ACP_TOOLS_ANTHROPIC : BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE, toolPrompts);
    const list = extras ?? [];
    if (!Array.isArray(tools)) return [...acp, ...list];
    const owned = new Set<string>(acp.map((t) => t.name));
    for (const e of list) owned.add(e.name);
    const kept = tools.filter((t) => {
        const n = (t as { name?: string })?.name;
        return typeof n !== "string" || !owned.has(n);
    });
    return [...kept, ...acp, ...list];
}

function injectOpenaiTool(tools: OpenAITool[] | undefined, extras?: readonly OpenAITool[], toolPrompts?: ToolPrompts, ccrOn = false): OpenAITool[] {
    const acp = applyAcpToolOverrides(ccrOn ? BILI_ACP_TOOLS_OPENAI : BILI_ACP_TOOLS_OPENAI_NO_RANGE, toolPrompts) as OpenAITool[];
    const list = extras ?? [];
    if (!Array.isArray(tools)) return [...acp, ...list] as OpenAITool[];
    const owned = new Set<string>(acp.map((t) => t.function.name));
    for (const e of list) owned.add(e.function.name);
    const kept = tools.filter((t) => {
        const n = t?.function?.name;
        return typeof n !== "string" || !owned.has(n);
    });
    return [...kept, ...acp, ...list];
}

/** Merge the ACP declarations into the client's Gemini `tools` array. Gemini
 *  nests declarations one level deeper than the OpenAI shape
 *  (`tools[].functionDeclarations[]`), so presence is collected across every
 *  entry and the missing declarations are appended as one new entry. */
function injectGoogleTool(tools: GoogleTool[] | undefined, extra?: { name: string }[], toolPrompts?: ToolPrompts, ccrOn = false): GoogleTool[] {
    const acp = applyAcpToolOverrides(ccrOn ? BILI_ACP_TOOLS_GOOGLE : BILI_ACP_TOOLS_GOOGLE_NO_RANGE, toolPrompts) as GoogleFunctionDeclaration[];
    const wanted: { name: string }[] = extra ? [...acp, ...extra] : [...acp];
    if (!Array.isArray(tools)) return [{ functionDeclarations: wanted as GoogleFunctionDeclaration[] }];
    const present = new Set<string>();
    for (const tool of tools) {
        for (const decl of tool?.functionDeclarations ?? []) {
            if (typeof decl?.name === "string") present.add(decl.name);
        }
    }
    const missing = wanted.filter((t) => !present.has(t.name));
    if (missing.length === 0) return tools;
    return [...tools, { functionDeclarations: missing as GoogleFunctionDeclaration[] }];
}

/** When true, the Responses path teaches compression via a text trigger
 *  instead of a function tool. Used for hosts (OpenAI Codex code_mode) whose
 *  server-side tools are disabled the moment any `tools` entry is declared.
 *  In text mode we keep `tools` untouched (undefined) so code_mode stays
 *  active, and detect the trigger in the output_text stream instead. */
const FORCE_TEXT_PROTOCOL = knobForceTextProtocol();
/** Inject all ACP tools (compress/decompress/search_context/acp_status) in
 *  Responses API flat format, matching the PROXY_TOOL_NAMES set the compress
 *  loop dispatches on. Idempotent. */
function injectResponsesTool(tools: unknown[] | undefined, toolsToAdd: readonly { name: string }[] = BILI_ACP_TOOLS_RESPONSES, toolPrompts?: ToolPrompts): unknown[] {
    const base = applyAcpToolOverrides(toolsToAdd, toolPrompts);
    if (!Array.isArray(tools)) return [...base];
    // Same #920 rule as injectTool/injectOpenaiTool: bili owns these names.
    const owned = new Set<string>(base.map((t) => t.name));
    const kept = tools.filter((t) => {
        const n = (t as { name?: string })?.name;
        return typeof n !== "string" || !owned.has(n);
    });
    return [...kept, ...base];
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

// #1757: the destination URL exactly as buildForwardTarget will fetch it.
// Shared by the early verbatim branches, which resolve compat.dropFields
// before reaching forward()'s final-boundary resolution — both sides must
// derive the same URL or per-provider drops would mismatch.
function forwardUpstreamUrl(req: http.IncomingMessage, opts: ProxyOptions, route: ReturnType<typeof resolveUpstream>): string {
    // route.rewrittenUrl may use a `mitm://` scheme (for config-lookup
    // distinction — see resolveUpstream). fetch needs the real https://
    // scheme, so strip mitm:// back to https:// for the actual upstream request.
    const reqUrl = req.url ?? "";
    const isAbsoluteUrl = /^https?:\/\//i.test(reqUrl);
    const rewritten = route ? route.rewrittenUrl : isAbsoluteUrl ? reqUrl : opts.upstream + reqUrl;
    return rewritten.replace(/^mitm:\/\//, "https://");
}

function buildForwardTarget(
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
    if (affinity && !clientConversationHeader(req.headers)) {
        headers["x-session-id"] = affinity;
    }
    const decision = resolveProxyDecision(opts.routes, opts.proxy, route?.rewrittenUrl ?? upstreamUrl, opts.proxyFallback);
    logUpstreamProxyDecision(opts, upstreamUrl, decision);
    return { upstreamUrl, headers, proxyUrl: decision.proxy };
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

function isPreflightFailFast(outcome: Prepared | PreflightFailFast): outcome is PreflightFailFast {
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
function outboundPayloadBreakdown(
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
export function outboundContextEstimate(
    prepared: Prepared,
    wireBody: string,
    opts: ProxyOptions,
    upstream: string,
    parsed?: Record<string, unknown> | null,
): number {
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
    return estimateCoreMessagesUpper(msgs) + estimateWireOverhead(prepared.protocol, raw)
        + imageReserveFor(prepared.session, prepared.protocol, raw, opts, upstream);
}

async function preflightCompressIfNeeded(
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
    const compressionTarget = prepared.protocol === "responses" && isCodexClient(req.headers) && codexCompactMode() === "intercept"
        ? limit * CODEX_COMPACT_HEALTH_RATIO
        : limit;
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
        log("info", `[${session.id}] preflight usage-baseline ~${baselineFloor} tok was measured on ${baselineOrigin}, request now routes to ${currentOrigin} — demoting to untrusted, judging by this payload's own estimate (#1933)`);
        baselineFloor = 0;
    }
    // #1933 F1: scale the local text estimate by the per-route calibration
    // factor k̂ learned from this session's own usage reports (local estimate ÷
    // what upstream actually billed, EMA, clamped 0.25–1 — one-way, deflate
    // only; see settleUsageReport). Unknown/mismatched origin → raw estimate,
    // i.e. today's behavior.
    const kFactor = session.stats.calibratedEstimate;
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
    if (limit <= 0 || !model || !triggerFires) return prepared;
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
        const shrinkNote = windowShrinkReason !== undefined && resolvedNativeWindow !== undefined && limit < resolvedNativeWindow
            ? ` Note: bili's effective window ${limit} is below the model's full window ${resolvedNativeWindow} — ` +
                (windowShrinkReason === "codex"
                    ? `it was aligned down to codex's own window perception; set compress.modelContextLimit explicitly if your upstream serves the larger window.`
                    : `your compress.modelContextLimit setting overrides it; if the upstream actually serves the larger window, raise or remove that setting (hot-reloaded, no session restart needed).`)
            : "";
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
    log("warn", `[${session.id}] context ${tokenCount} tokens reached preflight target ${compressionTarget} (model window ${limit}, model=${model}; usage-baseline=${baselineFloor > 0 ? baselineFloor : "none"} local-est=${Math.round(calibratedText)}${kFactor !== undefined ? ` raw=${Math.round(textEstimate + overheadEstimate)} k̂=${kFactor.toFixed(2)}` : ""}); preflight compressing before forward`);
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
    let result: PreflightResult;
    try {
        result = await preflightCompress(
            {
                core,
                session,
                config,
                compressionTarget,
                prompts: prepared.prompts ?? defaultPrompts,
                surface: prepared.surface,
                protocol: prepared.protocol,
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
        log("warn", `[${session.id}] preflight made no progress but the payload fits; forwarding as-is`);
        return prepared;
    }
    const f = result.failure;
    if (f?.kind === "aborted") {
        log("warn", `[${session.id}] preflight aborted (${f.detail}); not forwarding`);
        return { failFast: true, status: 0, message: f.detail, retryable: false, respond: false };
    }
    // #1800: still over-window after compression, but the residual excess is carried
    // ENTIRELY by the image estimate (text+overhead fits on its own) and we hold no
    // upstream overflow evidence. Forward for the upstream to arbitrate billing
    // instead of fail-fasting a payload whose real bill likely fits (#496). The text
    // portion was already folded above when foldable; we do NOT re-loop.
    if (imageArbitration) {
        const outText = estimateCoreMessages(outbound.processedMessages);
        if (outText + overheadEstimate < limit && outText + overheadEstimate + imageTokens >= limit) {
            log("info", `[${session.id}] preflight folded ${result.compressedRanges} range(s) but images alone (~${imageTokens} tokens) keep the estimate over window ${limit} with no upstream overflow evidence — forwarding for the upstream to arbitrate billing (#496/#1800)`);
            return outbound;
        }
    }
    // The payload still overflows the window: fail fast with a diagnostic
    // error instead of forwarding a guaranteed-400 payload (#301).
    const status = f?.kind === "upstream" && f.status === 429 ? 503 : 502;
    const retryable = f?.retryable === true || (f?.kind === "upstream" && f.status !== undefined && (f.status === 429 || f.status >= 500));
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
    if (est > s.stats.lastInputTokens) {
        s.stats.lastInputTokens = est;
        s.stats.lastInputTokensSource = "estimate";
        // The error path returns before forward()'s trailing markDirty — the
        // arm must schedule its OWN save or it is lost on restart.
        markDirty(s);
        log("warn", `[${s.id}] ${reason} with no usage report — armed emergency shrink with local estimate ${est} tokens`);
    }
}

async function forward(
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
    overflowRefold?: (realWindow: number | undefined) => Promise<string | Buffer | null>,
): Promise<void> {
    const forwardStartedAt = Date.now();
    // E2: a codex native-compaction request intercepted in prepare() carries a
    // forged success response — serve it without contacting upstream.
    if (prepared?.codexForge) {
        log("info", `[${prepared.session.id}] codex compact served locally (${prepared.codexForge.kind}); upstream not contacted`);
        if (!res.headersSent) res.writeHead(200, { "content-type": prepared.codexForge.contentType });
        res.end(prepared.codexForge.body);
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
    const { upstreamUrl, headers, proxyUrl } = buildForwardTarget(req, opts, route, affinity, prepared !== null ? instanceId : undefined);
    // #1884 re-sign arm: the native lane tunneled this request with the
    // signing credential (x-bili-resign markers — stripped in
    // buildForwardTarget, they must never reach the upstream). Every egress
    // body below — initial send, role-ladder retry, overflow refold,
    // compress-loop rounds, degenerate continuation refetch — is re-signed
    // just before it hits the wire, so the rewritten body and the signature
    // always agree. A failed re-sign logs and sends the previous signature:
    // the upstream's 401 stays visible instead of a synthetic bili error.
    const fwdResign = resignSettingsFor(opts, upstreamUrl);
    const resignCtx =
        fwdResign.enabled && String(Array.isArray(req.headers[APIG_RESIGN_HEADER]) ? req.headers[APIG_RESIGN_HEADER][0] ?? "" : req.headers[APIG_RESIGN_HEADER] ?? "") === APIG_RESIGN_SCHEME
            ? decodeApigCredential(Array.isArray(req.headers[APIG_RESIGN_CREDENTIAL_HEADER]) ? req.headers[APIG_RESIGN_CREDENTIAL_HEADER][0] : req.headers[APIG_RESIGN_CREDENTIAL_HEADER])
            : undefined;
    if (resignCtx !== undefined) {
        log("info", `[${prepared?.session.id ?? "passthrough"}] [resign] re-sign arm active (${APIG_RESIGN_SCHEME}) — every egress body is re-signed (#1884)`);
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
    // #552: wire transform shared by ALL re-send paths (compress-retry loops
    // below) so re-sent bodies carry the same rewrite as the initial forward —
    // otherwise a developer-role 400 would hit mid-stream on the first retry.
    // Reads compatRoles at CALL time: a role learned mid-request (retry below)
    // applies to later re-sends within the same request.
    const wireTransform = compatProtocol || (steerCfg !== null && steerCfg.enabled) || compatDropPaths.length > 0
        ? (b: Record<string, unknown>): Record<string, unknown> => {
            if (compatProtocol && compatRoles) applyCompatRolesJson(b, compatProtocol, compatRoles);
            if (steerCfg && steerCfg.enabled && steerProtocol) applyOutputSteeringJson(b, steerProtocol, steerCfg);
            if (compatDropPaths.length > 0) dropCompatFieldsJson(b, compatDropPaths);
            return b;
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
    if (typeof wireBody === "string" && (opts.debug || bodyDumpEnabled())) {
        try {
            const parsed = JSON.parse(wireBody);
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
                    const pretty = JSON.stringify(JSON.parse(wireBody), null, 2);
                    fs.writeFileSync(out, pretty);
                } catch {
                    fs.writeFileSync(out, wireBody);
                }
                log("info", `[debug] forwarded body written to ${out}`);
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
    // ACP_DUMP_BODY=1 (credential header values + non-public hosts masked).
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
            fs.writeFileSync(reqPath, `${req.method ?? "POST"} ${maskUrlForLog(upstreamUrl)}\n${hdrText}\n\n${bodyText}`);
            log("info", `[debug] RAW request dump: ${reqPath}`);
        } catch (err) { logDumpFailure("REQ dump", err); }
    }
    const dispatcher = proxyDispatcher(proxyUrl);
    // #1884: sign the FINAL wire body right before the send — everything
    // upstream of this point (prepare* injection, compat, steering) already
    // mutated it, so any inbound signature is stale here.
    if (req.method !== "GET" && req.method !== "HEAD") applyResign(headers, wireBody);
    const init: Omit<RequestInit, "dispatcher"> & { dispatcher?: object } = {
        method: req.method ?? "GET",
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : wireBody,
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
        const nImages = countImagesInRawBody(prepared.protocol, wireBody);
        if (nImages > 0) {
            const learnUpstream = route?.rewrittenUrl ?? (/^https?:\/\//i.test(req.url ?? "") ? req.url ?? undefined : opts.upstream);
            const msgs = prepared.processedMessages.length > 0 ? prepared.processedMessages : prepared.originalMessages;
            noteForwardedImageFacts(prepared.session, {
                nImages,
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
        const estimate = outboundContextEstimate(prepared, sentBody, opts, upstreamUrl, sentParsed);
        prepared.session.stats.localInputEstimate = estimate;
        prepared.session.stats.contextTokens = estimate;
        prepared.session.stats.contextTokensSource = "estimate";
        // #2131: exact message count for seam forensics (sentParsed is the one
        // shared parse above — Responses carries "input", Google native "contents").
        const sentArr = sentParsed !== null ? (sentParsed.messages ?? sentParsed.input ?? sentParsed.contents) : null;
        noteForwardedBody(prepared.session, sentBody, Array.isArray(sentArr) ? (sentArr as unknown[]).length : null);
    }
    let upstreamResult: Awaited<ReturnType<typeof fetchWithTimeout>>;
    try {
        upstreamResult = await fetchWithTransportRetry(upstreamUrl, init, undefined, clientAbort.signal, (info) => {
            log("warn", `[${prepared?.session.id ?? "unknown"}] [acp-proxy] upstream ${info.detail}; retrying in ${info.delayMs}ms (attempt ${info.attempt}/${info.maxAttempts})`);
        });
        recordUpstreamConnection(upstreamUrl, proxyUrl);
        // #1682: any resolved response proves the host is reachable again.
        clearUpstreamAlertsForHost(upstreamUrl);
    } catch (error) {
        recordUpstreamConnection(upstreamUrl, proxyUrl, error);
        recordUpstreamAlert(upstreamUrl, error, proxyUrl !== undefined);
        // #604: a network-level failure (socket reset, timeout abort) also never
        // reports usage — arm the emergency shrink like the 5xx branch below.
        if (prepared && req.method !== "GET" && req.method !== "HEAD") armFailureShrink(prepared, log, "network failure", outboundPayloadBreakdown(prepared, opts, route, req.url ?? "").armEstimate);
        // [#1343] no response means the attached full text never reached the model —
        // drop-and-log it (a corrective note surfaces on the next qualifying request).
        if (prepared && prepared.attachedRetrievals && prepared.attachedRetrievals.length > 0) dropRetrievals(prepared.session, prepared.attachedRetrievals.map((i) => i.ref), "upstream network failure");
        throw new Error(`upstream request failed: ${formatUpstreamError(error, upstreamUrl, proxyUrl)}`, { cause: error });
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
                        r = await fetchWithTimeout(upstreamUrl, { ...init, body: fixed.body }, undefined, clientAbort.signal);
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
            s.stats.lastInputTokens = info.window;
            s.stats.lastInputTokensSource = "overflow-arm";
            // #1110: record the arm SEPARATELY so the side-request guard
            // can read it without ever touching the nudge baseline.
            s.stats.overflowArmTokens = info.window;
            log("warn", `[${s.id}] upstream context overflow (model=${reqModel ?? "unknown"}) — window ${info.window} stated upstream; armed emergency shrink, declared window unchanged (#987)`);
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
            const declared = typeof s.metadata.effectiveContextLimit === "number" ? s.metadata.effectiveContextLimit : 0;
            let est = 0;
            try {
                // #1492: same CJK-aware lower bound as armFailureShrink.
                est = defaultCountTokens(rawBody ?? "");
            } catch { est = 0; }
            const arm = Math.max(0, Math.min(declared, Number.isFinite(est) ? est : declared));
            if (arm > 0) {
                s.stats.lastInputTokens = arm;
                // #1839: an estimate promoted to "usage" would enter the nudge
                // denominator unconditionally — tag it "overflow-arm" instead
                // (still accepted by effectiveTokenCount + the #496 gate).
                s.stats.lastInputTokensSource = "overflow-arm";
                s.stats.overflowArmTokens = arm; // #1110: guard reads this, not the baseline
            }
            log("warn", `[${s.id}] upstream context overflow (window not parseable, model=${reqModel ?? "unknown"}) — armed emergency shrink at ~${arm} tokens (min of declared ${declared} and payload estimate), nothing learned (#987): ${info.message}`);
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
            if (overflowInfo.isOverflow) {
                armOverflowShrink(overflowInfo);
                const refolded = await overflowRefold(overflowInfo.window).catch(() => null);
                if (refolded) {
                    try {
                        applyResign(headers, refolded);
                        const retried = await fetchWithTimeout(upstreamUrl, { ...init, body: refolded }, undefined, clientAbort.signal);
                        if (retried.response.ok) {
                            upstreamResult.clearTimer();
                            wireBody = refolded; // #1900: track the accepted re-send as the wire base
                            upstreamResult = retried;
                            log("info", `[${prepared.session.id}] context overflow — refolded and re-sent within the same request, upstream accepted (#1195)`);
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
            const info = inspectContextOverflow(upstream.status, errBody.toString("utf8"));
            if (info.isOverflow) {
                armOverflowShrink(info);
            }
            // #762: learn strict-echo on the MAIN request path too. The loop-only
            // learner (src/loop/core.ts) never sees client-originated 400s, so a
            // first post-fold rejection left strictReasoningEcho unset — #651 kept
            // dropping reasoning and every following turn split again.
            if (upstream.status === 400 && /reasoning_content/i.test(errBody.toString("utf8"))) {
                if (s.metadata.strictReasoningEcho !== true) {
                    s.metadata.strictReasoningEcho = true;
                    markDirty(s);
                    log("warn", `[${s.id}] upstream 400 mentions reasoning_content — learned strictReasoningEcho for this session (#684/#762); reasoning-drop disabled`);
                }
            }
        }
        // #604: relay/gateway 5xx — no usage report will arrive, so arm the
        // emergency shrink with a local estimate of the wire body we just sent
        // (see armFailureShrink for the deadlock this breaks). Generic relay
        // errors (new_api_error etc.) are not overflow signatures and carry no
        // window number, so this is the only self-heal path for them;
        // inspectContextOverflow never matches 5xx (400/413 only), so the
        // overflow path above could not have handled this response.
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
    if (!res.headersSent) res.writeHead(upstream.status, respHeaders);
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
    // Plugin mode: the agent's native loop owns the tool surface — pass the
    // response through VERBATIM (a model-emitted compress call must reach the
    // plugin untouched) while sniffing usage so lastInputTokens (the input to
    // the next nudge decision) keeps tracking reality. The one exception: the
    // opt-in #371 fake-completion backstop buffers + retries first, same as
    // proxy mode (#473).
    if (prepared?.pluginMode) {
        // #411: clear the idle timer on every path — resolveFakeCompletion and
        // other failures still escape these pipes; without a finally each one
        // leaked a live idle timer. (#721: the SSE pipes themselves no longer
        // rethrow an upstream cut — they emit an in-band truncation signal.)
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
            if (prepared.stream) {
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
                    );
                }
            } else {
                await pipePluginJson(pluginBody, res, prepared.session, prepared.protocol, targetOrigin);
            }
        } finally {
            clearUpstreamTimer();
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
                upstreamUrl,
                reqHeaders: buildForwardHeaders(headers), resign: applyResign,
                proxyUrl,
                signal: clientAbort.signal,
                session: prepared.session,
                log,
            });
            responseBody = bufferToStream(resolvedBuf);
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
                        upstreamUrl,
                        reqHeaders: buildForwardHeaders(headers), resign: applyResign,
                        proxyUrl,
                        dispatcher,
                        signal: clientAbort.signal,
                        log,
                        label: p.session.id,
                    }),
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
            await pipePluginJson(responseBody, res, undefined, prepared.protocol);
        } else {
            await pipeThrough(responseBody, res);
        }
        return;
    }
    const ctx: RewriteCtx = {
        core,
        config,
        messages: prepared.originalMessages,
        session: prepared.session,
        log: (msg: string) => log("info", `[${prepared.session.id}] ${msg}`),
        debug: opts.debug,
    };
    if (prepared.stream) {
        let streamToRead = responseBody;
        let dumpRaw: Promise<void> | undefined;
        if (opts.dumpSse) {
            const [a, b] = responseBody.tee();
            streamToRead = a;
            dumpRaw = dumpStreamToFile(b, opts.dumpSse, `${Date.now()}-${safeSessionId(prepared.session.id)}-raw.sse`);
        }
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
            const visibilityMarkers = resolveCompress(opts.routes, route?.rewrittenUrl, (parsedReq as { model?: string }).model, opts.compress).visibilityMarkers ?? true;
            const systemPrompt = withMarkerIntegrityNote(withSummaryBudgetNote(textProtocol ? buildCompressHybridSystemPrompt(prepared.prompts ?? defaultPrompts, prepared.surface?.promptSections) : buildCompressSystemPrompt(prepared.prompts ?? defaultPrompts, prepared.surface?.promptSections)), visibilityMarkers) + absorbSection;
            const adapter = pickAdapter(prepared.protocol, parsedReq, textProtocol, prepared.responsesProjection, prepared.anthropicSystem, prepared.openaiSystemText, absorbActive ? absorbToolName(loopConfig) : undefined, prepared.google, prepared.systemNotes, opts.streamErrorShape, prepared.anthropicCacheMarks);
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
                    // [#1095] the folded re-request must carry the SAME bytes the
                    // model saw (deterministic encode + per-fingerprint cache) —
                    // applied after the ordering repair, matching the steady
                    // paths' sequence.
                    await applyImageCompressionPass(prepared.session, ordered as BiliMessage[], { config: loopConfig, billing: imageBillingFor(opts, route?.rewrittenUrl), cap: imageTokenCapFor(opts, route?.rewrittenUrl), log: ctx.log });
                    const imgNote = imageFullTrailingNote(prepared.session);
                    if (imgNote) (ordered as BiliMessage[]).push({ id: "bili_image_full_note", role: "user", contentType: "text", text: imgNote });
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
                streamToRead,
                { core, config, messages: prepared.processedMessages.length > 0 ? prepared.processedMessages : prepared.originalMessages, compressMessages: prepared.originalMessages, session: prepared.session, log: ctx.log, proxyUrl, upstreamOrigin: targetOrigin, protocol: prepared.protocol, textProtocol, debug: opts.debug, refreshFolded, visibilityMarkers, dumpSse: loopDumpDir ? (name, stream) => dumpStreamToFile(stream, loopDumpDir, name) : undefined, imageLearn: { host: upstreamHost(loopBillingUpstream), fp: `${imageBillingFor(opts, loopBillingUpstream)}:${imageTokenCapFor(opts, loopBillingUpstream)}` } },
                parsedReq,
                { url: upstreamUrl, headers: reqHeaders, wireTransform, resign: applyResign },
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
                        log("warn", `[${prepared.session.id}] tag echo: ${prepared.protocol} response stream contains \x3cacp tag`);
                    } else if (!protocolFragmentWarned && containsToolCallXmlFragment(s)) {
                        protocolFragmentWarned = true;
                        log("warn", `[${prepared.session.id}] tag echo: ${prepared.protocol} response stream contains tool-call XML fragment (possible tag echo; not stripped)`);
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
            const buf = await upstream.arrayBuffer();
            const text = Buffer.from(buf).toString("utf8");
            try {
                let json = JSON.parse(text) as Record<string, unknown>;
                if (prepared.protocol === "responses" && prepared.responsesTextProtocol) {
                    const requestBody = JSON.parse(typeof body === "string" ? body : body.toString("utf8")) as Record<string, unknown>;
                    const requestHeaders = buildForwardHeaders(headers);
                    const visibilityMarkers = resolveCompress(opts.routes, route?.rewrittenUrl, (requestBody as { model?: string }).model, opts.compress).visibilityMarkers ?? true;
                    json = await compressLoopResponsesJson(
                        json,
                        { core, config, messages: prepared.originalMessages, session: prepared.session, log: ctx.log, proxyUrl, textProtocol: true, visibilityMarkers },
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
                const { total, cached } = usageTotals(prepared.protocol, u);
                const out = usageOutputTotal(prepared.protocol, u);
                // #1547: settle through the shared path — stats AND the cache
                // ledger. Before this, this branch updated stats only, so
                // stream:false sessions produced zero ledger lines and were
                // invisible to /acp-cache, __bili/cache-report and the
                // invalidation attribution built on them (#1536).
                const reportedCached: number | null = typeof cached === "number" ? cached : null;
                const billed = typeof total === "number" ? total : 0;
                if (billed > 0 || reportedCached !== null) {
                    // wireBody — not prepared.body — is what actually went out
                    // (compat-role / steering / chain-stamp rewrites apply after
                    // prepare); the main chokepoint above already noted it, this
                    // keeps the pair byte-exact if that ever moves (#1891).
                    noteForwardedBody(prepared.session, typeof wireBody === "string" ? wireBody : wireBody.toString("utf8"));
                    settleUsageReport(prepared.session, { total: billed, reportedCached, output: out, protocol: prepared.protocol, upstream: targetOrigin });
                    if (reportedCached !== null) warnCacheCollapse(prepared.session, billed, reportedCached);
                    const hitPct = reportedCached !== null && billed > 0 ? Math.round((100 * reportedCached) / billed) : undefined;
                    loggerLog("info", `[${prepared.session.id}] [acp-usage] input=${billed} ${hitPct === undefined ? "(no cache report)" : `cached=${reportedCached} (cache hit ${hitPct}%)`}${billed <= 0 ? " (zero-total: lastInputTokens kept)" : ""}${imageUsageSuffix(prepared.session)}`);
                } else {
                    diagnoseSuccessWithoutUsage(prepared.session, "proxy-json");
                }
                if (typeof out === "number") prepared.session.stats.outputTokens += out;
                if (prepared.protocol === "openai") {
                    await withSessionLock(prepared.session, () => rewriteOpenaiJsonResponse(json, ctx));
                } else if (prepared.protocol === "responses") {
                    await withSessionLock(prepared.session, () => rewriteResponsesJsonResponse(json, ctx));
                } else if (prepared.protocol === "google") {
                    await withSessionLock(prepared.session, () => rewriteGoogleJsonResponse(json, ctx));
                } else {
                    await withSessionLock(prepared.session, () => rewriteJsonResponse(json, ctx));
                }
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
            opts.log("warn", `[${sid}] fake completion (tool-call XML, no tool block); retry ${attempt}/${max} with corrective hint`);
            let r: Awaited<ReturnType<typeof fetchWithTimeout>>;
            try {
                opts.resign?.(opts.reqHeaders, hinted);
                r = await fetchWithTimeout(
                    opts.upstreamUrl,
                    {
                        method: "POST",
                        headers: opts.reqHeaders,
                        body: hinted,
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

/** Derive a short human-readable title from the first real user text message.
 *  Used so the web UI can show "Fix auth bug" instead of an opaque hash.
 *  Contextual fragments (#2118) are skipped — if no real question has arrived
 *  yet, no title is set and derivation retries on later requests. */
export function deriveTitle(messages: CoreMessage[]): string | undefined {
    for (const m of messages) {
        if (m.role !== "user" || m.contentType !== "text") continue;
        const raw = m.text ?? "";
        if (!raw.trim()) continue;
        if (isContextualUserFragment(raw)) continue;
        const clean = raw.replace(/\s+/g, " ").trim();
        return clean.length > 60 ? clean.slice(0, 57) + "\u2026" : clean;
    }
    return undefined;
}

function handleConfigReload(opts: ProxyOptions, res: http.ServerResponse, log: (level: string, msg: string) => void): void {
    // Hot-reload routes from the config file into the running process — no
    // restart needed. Routes and the global compress block are re-read;
    // port/host/upstream stay as-is (the listen socket is already bound).
    // Mutates opts.routes in place so all in-flight handle() closures that
    // captured `opts` see the new routes.
    const fresh = loadRoutes();
    // Clear and refill the SAME object reference so resolveUpstream/resolveContextLimit
    // (which read opts.routes) pick up the new entries without needing reassignment.
    for (const k of Object.keys(opts.routes)) delete opts.routes[k];
    Object.assign(opts.routes, fresh);
    const reloaded = loadOptions();
    opts.compress = reloaded.compress;
    opts.compat = reloaded.compat;
    opts.imageBilling = reloaded.imageBilling;
    opts.imageTokenCap = reloaded.imageTokenCap;
    // Release cached ProxyAgents so agents for proxy URLs that were
    // removed/changed don't leak for the process lifetime. The next request
    // re-creates the needed agent lazily via proxyDispatcher().
    resetProxyCache();
    const names = Object.keys(fresh);
    log("info", `[acp-web] routes hot-reloaded (${names.length} providers): ${names.join(", ") || "(none)"}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: names.length, routes: names }));
}

function sendCacheReport(res: http.ServerResponse, url: string): void {
    const sessionParam = new URL(url, "http://localhost").searchParams.get("session");
    let sessions = listSessions();
    if (sessionParam !== null) {
        const hit = sessions.filter((s) => s.id === sessionParam);
        if (hit.length === 0) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: `unknown session: ${sessionParam}` }));
            return;
        }
        sessions = hit;
    } else {
        sessions = sessions.slice().sort((a, b) => b.lastSeen - a.lastSeen);
    }
    res.writeHead(200, { "content-type": "application/json" });
    // Same markdown the acp_cache MCP tool emits (handleAcpCache = formatCacheReport),
    // so web copy/download matches /acp-cache output exactly.
    res.end(JSON.stringify({ reports: sessions.map((s) => ({ id: s.id, report: handleAcpCache(s, { detail: "full" }).text })) }, null, 2));
}

// #1206: orphan reaping was silent — blocks deactivated because their source
// messages vanished from client history are the strongest runtime signal that
// something outside bili (client auto-compaction or another compression plugin)
// rewrote the conversation. Log it and record it in the session ledger.
function reapOrphansLogged(session: Session, msgs: CoreMessage[], log: (level: string, msg: string) => void, sessionId: string): void {
    const { reaped } = reapOrphanBlocks(session, msgs, deactivateBlock);
    if (reaped.length === 0) return;
    log("warn", `[${sessionId}] orphan-gc deactivated ${reaped.length} block(s) whose source messages left the client history (${reaped.join(", ")}) — the client or another compression plugin deleted summarized content; those summaries can no longer be decompressed (#1206)`);
    recordConflict(session, "orphan-reap", `${reaped.length} block(s) deactivated: ${reaped.join(", ")}`);
}

// #2102: wipe diagnostic conflict ledgers — global, or one session via ?session=<id>.
// Gated by the /__bili/* admin gate above (loopback + trusted origin only);
// wiping loses no conversation data, only the evidence notes (#1206 design).
function handleConflictsClear(url: string, res: http.ServerResponse, log: (level: string, msg: string) => void): void {
    const sessionId = new URL(url, "http://localhost").searchParams.get("session");
    const sessions = listSessions();
    if (sessionId !== null && sessionId !== "" && !sessions.some((s) => s.id === sessionId)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `unknown session: ${sessionId}` }, null, 2));
        return;
    }
    const cleared = clearConflictEvents(sessions, sessionId || undefined);
    log("info", `[conflict] ledger cleared via web UI: ${cleared.events} event(s) across ${cleared.sessions} session(s)${sessionId ? ` (session ${sessionId})` : ""}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, cleared }, null, 2));
}

function sendStats(res: http.ServerResponse): void {
    const all = listSessions();
    const sessions = all.map((s) => {
        const sw = readModelSwitchStats(s);
        return {
            id: s.id,
            protocol: s.meta.protocol,
            upstream: s.meta.upstreamOrigin,
            label: s.meta.label,
            title: s.meta.title,
            requests: s.stats.requests,
            contextTokens: s.stats.contextTokens,
            contextTokensSource: s.stats.contextTokensSource,
            inputTokens: s.stats.inputTokens,
            cachedTokens: s.stats.cachedTokens,
            outputTokens: s.stats.outputTokens,
            cacheSamples: s.stats.cacheSamples,
            cacheHitPct: s.stats.cacheSamples > 0 && s.stats.inputTokens > 0 ? Math.round(s.stats.cachedTokens / s.stats.inputTokens * 100) : null,
            lastModel: typeof s.metadata.lastModel === "string" ? s.metadata.lastModel : undefined,
            modelSwitches: sw?.count ?? 0,
            switchMissedTokens: sw?.missedTokens ?? 0,
            // #901: window credibility — trusted (configured/registry) window vs the
            // largest input recent successful turns actually got through. A wide gap
            // means the provider overstates its window.
            contextWindow: typeof s.metadata.effectiveContextLimit === "number" ? s.metadata.effectiveContextLimit : undefined,
            lastSeen: new Date(s.lastSeen).toISOString(),
            restored: s.restored === true,
        };
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions, blindTunnels: getBlindTunnelStats(), unrecognizedPaths: getUnrecognizedPathStats(), conflicts: summarizeConflicts(all) }, null, 2));
}

/** Stale-install state for the web UI badge (#811): whether the on-disk
 *  version is newer than the running process, plus the opt-in flag state and
 *  the live in-flight request count. */
async function sendStatus(res: http.ServerResponse, opts: ProxyOptions): Promise<void> {
    let diskVersion: string | undefined;
    let stale = false;
    try {
        ({ diskVersion, stale } = await detectStaleInstall(PACKAGE_NAME, VERSION));
    } catch {
        // fs hiccup: report running state only, never fail the status endpoint
    }
    res.writeHead(200, { "content-type": "application/json" });
    const adv = getAdvisoryState();
    const advisory = adv.active ? { ...adv.active, targetFailed: cannotResolveTarget(adv.lastError) } : null;
    res.end(JSON.stringify({ version: VERSION, diskVersion, stale, autoRestartOnUpdate: opts.autoRestartOnUpdate, advisory, inFlight: totalInFlight(), conflicts: summarizeConflicts(listSessions()) }, null, 2));
}

async function sendOverview(res: http.ServerResponse, opts: ProxyOptions): Promise<void> {
    let diskVersion: string | undefined;
    let stale = false;
    try {
        ({ diskVersion, stale } = await detectStaleInstall(PACKAGE_NAME, VERSION));
    } catch {
        // fs hiccup: report running state only, never fail the overview endpoint
    }
    const overview = await buildOverview();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        overview,
        version: VERSION,
        diskVersion,
        stale,
        autoRestartOnUpdate: opts.autoRestartOnUpdate,
        inFlight: totalInFlight(),
        blindTunnels: getBlindTunnelStats(),
        conflicts: summarizeConflicts(listSessions()),
        passthrough: { enabled: !!opts.passthrough, source: opts.passthroughSource },
        alerts: getUpstreamAlerts(),
    }, null, 2));
}

async function sendWebSessions(res: http.ServerResponse): Promise<void> {
    const sessions = await buildSessionList();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions, hiddenEmpty: hiddenEmptyCount() }, null, 2));
}

/** #1426 web UI run-log viewer: tail of the rotated logger files (bili.log.old
 *  + bili.log), optionally filtered by a case-insensitive substring (?q=).
 *  ?lines= caps the tail at 2000; ?raw=1 streams the same tail as a .txt download. */
async function sendWebLogs(res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const u = new URL(req.url ?? "/__bili/logs", "http://localhost");
    const q = (u.searchParams.get("q") ?? "").trim();
    const fullDownload = u.searchParams.get("raw") === "1" && u.searchParams.get("all") === "1";
    let n = Number(u.searchParams.get("lines") ?? "500");
    if (!Number.isFinite(n) || n <= 0) n = 500;
    // Full download is the forensic escape hatch: ignore `lines`, capped only
    // by the memory guard below so users can export the whole .old + cur pair.
    n = fullDownload ? 100_000 : Math.min(Math.floor(n), 2000);
    // Context expansion (ctx=N rows around each hit) and time window (win=Ss
    // around [firstHit, lastHit]) — selection logic lives in web/logs-query.ts
    // (unit-tested pure function); win wins over ctx when both are given.
    let ctx = Number(u.searchParams.get("ctx") ?? "0");
    if (!Number.isFinite(ctx) || ctx < 0) ctx = 0;
    ctx = Math.min(Math.floor(ctx), 50);
    let win = Number(u.searchParams.get("win") ?? "0");
    if (!Number.isFinite(win) || win < 0) win = 0;
    win = Math.min(Math.floor(win), 3600);
    const logFile = getLogPath() ?? defaultLogFile();
    // Cross-platform dir extraction: a naive "/" split yields "" on Windows
    // paths and the candidates would silently resolve against cwd.
    const dir = logFile ? path.dirname(logFile) + path.sep : "";
    const candidates = [dir + "bili.log.old", dir + "bili.log"];
    const existing = candidates.filter((f) => {
        try { return fs.statSync(f).isFile(); } catch { return false; }
    });
    let all: string[] = [];
    for (const f of existing) {
        let text: string;
        try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
        all = all.concat(text.split("\n").filter((l) => l.length > 0));
    }
    const r = queryLogLines(all, q, { ctx, winSec: win, n });
    if (u.searchParams.get("raw") === "1") {
        res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": `attachment; filename="${fullDownload ? "billion-context-full-log.txt" : "billion-context-log.txt"}"`,
        });
        res.end(r.lines.join("\n"));
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        path: logFile,
        total: r.total,
        shown: r.shown,
        omitted: r.omitted,
        lines: r.lines,
        ...(r.isMatch ? { isMatch: r.isMatch } : {}),
    }, null, 2));
}

async function sendWebSessionDetail(res: http.ServerResponse, url: string): Promise<void> {
    const prefix = "/__bili/sessions/";
    const suffix = "/detail";
    let id = "";
    try {
        id = decodeURIComponent(url.slice(prefix.length, -suffix.length));
    } catch {
        // malformed percent-encoding → treat as unknown session (404 below)
    }
    const detail = await buildSessionDetail(id);
    if (!detail) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `unknown session: ${id}` }));
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(detail, null, 2));
}

function headerValue(req: http.IncomingMessage, name: string): string | undefined {
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
function logRequestCost(log: (level: string, msg: string) => void, sessionId: string, msgs: number | null, inboundBytes: number, t0: number, outbound?: string | Buffer): void {
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
