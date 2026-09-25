import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createCore, type CompressionCore, type CompressionState, type Config, type CoreMessage, type NudgeDecision, type Prompts, type PackSurface, type ToolPrompts, applyAcpToolOverrides, defaultPrompts, defaultCountTokens, estimateTokensFast, renderNudgeText, deactivateBlock, viableRanges, resolveOutputSteeringConfig } from "acp-kernel";
import { DEFAULT_STRIP_IMAGES_KEEP_RECENT, applyCompressSettings, resolveCompress, resolveCompressPrompts, resolveCompressSurfaceDetailed, resolveRequestConfig } from "./compress-settings.js";
import { dropCompressReasoning, type CompressReasoningConfig } from "./reasoning-drop.js";
import type { ProxyOptions } from "./config.js";
import { loadOptions, loadRoutes } from "./config.js";
import { resetProxyCache } from "./upstream-proxy.js";
import { FALLBACK_EFFECTIVE_WINDOW_FLOOR, findRoute, lookupContextLimit, resolveConfiguredContextLimit, resolveConfiguredOutputLimit, resolveCompressProtocol } from "./config.js";
import { contextFromRegistry, loadRegistry, peekRegistryContext, peekRegistryOutputLimit } from "./registry.js";
import { codexAlignedWindow } from "./codex-models.js";
import { fetchWithTimeout, MAX_REQUEST_BYTES, upstreamTimeoutMs } from "./fetch-util.js";
import { formatUpstreamError, getUpstreamConnectionStatus, recordUpstreamConnection, resolveProxy, resolveProxyDecision, proxyDispatcher, type UpstreamProxyDecision } from "./upstream-proxy.js";
import { maskHeaderForLog, maskHeadersForLog, maskHostPortForLog, setMaskHostsEnabled, maskUrlForLog, maskUrlsInText } from "./log-mask.js";
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
import { responsesToCoreWithToolImages as responsesToCore, patchResponsesInputWithToolImages as patchResponsesInput } from "./responses-tool-output.js";
import { getSession, hasProcessedState, listSessions, type Session, initSessions, markDirty, flushAllSessions, acquireInFlight, releaseInFlight, totalInFlight, withSessionLock, markNativeCompactionBoundary, reconcileNativeCompactionBoundary, snapshotMessages, applyCompactionArchive, detectUnannouncedHistoryRewrite, markCompactionBoundary, ensureCanonicalId, storeEffectiveConfig } from "./session.js";
import { detectStaleInstall } from "./update.js";
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
import { ABSORB_TOOL, ABSORB_TOOL_GOOGLE, ABSORB_TOOL_OPENAI, ABSORB_TOOL_RESPONSES, COMPRESS_TOOL, BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_GOOGLE, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_RESPONSES, BILI_ACP_READONLY_TOOLS_RESPONSES, COMPRESS_TOOL_NAME, IMAGE_FULL_TOOL, IMAGE_FULL_TOOL_GOOGLE, IMAGE_FULL_TOOL_OPENAI, IMAGE_FULL_TOOL_RESPONSES, RULE_TOOL, RULE_TOOL_GOOGLE, RULE_TOOL_OPENAI, RULE_TOOL_RESPONSES, retrieveToolsFor, buildAbsorbSystemPrompt, buildCompressSystemPrompt, buildCompressHybridSystemPrompt, withConversationIdNote, withMarkerIntegrityNote, withStagedCompressGuidance, withSummaryBudgetNote } from "./compress-tool.js";
import { applyAbsorbView, absorbEnabled, absorbToolName, storeEffectiveAbsorb } from "./absorb.js";
import { adoptContentStore, ccrEnabled, ccrPluginWireOk, contentStoreOf, drainPendingRetrievals, executeRetrieve, retrieveToolName, storeEffectiveCcr, type CcrSettings } from "./store.js";
import { applyImageCompressionPass, imageCompressionEnabled, imageFullTrailingNote, storeEffectiveImageCompression, type ImageCompressionSettings } from "./image-compress.js";
import { rulesEnabled, storeEffectiveRules } from "./rules-feature.js";
import { rewriteJsonResponse, type RewriteCtx } from "./stream.js";
import { applyRanges } from "./stream.js";
import { buildSessionCacheReport } from "./cache-ledger.js";
import { preflightCompress, estimateCoreMessages, estimateCoreMessagesUpper, estimateRawBodyTokens, type PreflightResult } from "./preflight.js";
import { gcConfigFromEnv, gcSessionFiles } from "./session-gc.js";
import { imageTokensInRawBody, imageTokensInParsedBody, resolveImageBilling, type ResolvedImageBilling } from "./image-tokens.js";
import { renderUI, handleConfigGet, handleConfigPut } from "./web/index.js";
import { reapOrphanBlocks } from "./orphan-gc.js";
import { getStore } from "./persist.js";
import { log as loggerLog, configureLogger, getLogPath, closeLogger, isStreamWriteError } from "./logger.js";
import { configFile, defaultLogFile, dumpsDir, stateDir } from "./paths.js";
import { atomicWriteInstanceFile, clearProxyInstanceFile, entryScriptFingerprint, isPidAlive, registerInstanceAndWarn, unregisterInstance, type ProxyInstanceFile } from "./instance.js";
import { compressLoopResponsesJson } from "./compress-loop-responses.js";
import { hoistTrappedToolItems } from "./tool-pair-order.js";
import { runCompressLoop, pickAdapter } from "./loop/index.js";
import { reconcileSystemAnchor } from "./system-anchor.js";
import { containsToolCallXmlFragment } from "./loop/tag-echo-filter.js";
import { isStrictReasoningEcho, modelIdOf, normalizeStrictEchoReasoning } from "./strict-echo.js";
export { isStrictReasoningEcho, normalizeStrictEchoReasoning };
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
import { affinityToken, claudeSubagentAgentId, claudeSubagentSplit, clientConversationHeader, codexTurnIdentity, instructionsFingerprintApplies, preferPromptCacheKeyIdentity, type ConversationIdentity } from "./session-id.js";
import { prefixAffinity, type AnonymousAffinity } from "./prefix-affinity.js";
import { maybeAdoptForkBlocks } from "./fork-adoption.js";
import { flushPrefixAffinity, hydratePrefixAffinity, scheduleAffinityPersist } from "./affinity-persist.js";
import { consumePluginRegisterFor, flushConversations, handlePluginCompact, handlePluginManifest, handlePluginRegister, handlePluginRuntimeInfo, handlePluginStatus, handlePluginTool, loadConversations, pipePluginChatWithStrip, pipePluginJson, pipePluginResponsesWithStrip, pluginAgentHeader, pluginConversationHeader, pluginHeadersMatchModel, pluginReportedContextWindow, pluginReportedMaxOutput, pluginRuntimeInfoFor, recordChainVerdict, recordPluginSession, rememberPluginMessages, takePendingPluginRegister } from "./plugin.js";
import { setupMitm, readMitmUpstream, getBlindTunnelStats } from "./mitm.js";
import type { BiliMessage } from "acp-kernel/wire";
import { BILI_PASSTHROUGH_HEADER, BILI_PLUGIN_BYPASS_HEADER, hardenOpenaiAssistantContent, isLoopbackAddress, inspectContextOverflow, reserveOutputHeadroom, resolveOutputHeadroomCap, shouldReserveOutputHeadroom, systemToUser, usageOutputTotal, usageTotals, type ContextOverflowInfo, type WireProtocol } from "./util.js";

import { BILI_TUNNEL_HEADER, checkTunnelDestination, classifyIp, localMachineIps, normalizeIpLiteral, parseIpLiteral, tunnelAllowlistFromEnv } from "./tunnel-guard.js";
import { dumpRejectedBody } from "./error-dump.js";

import { decodeRequestBody, DecompressedTooLargeError } from "./content-encoding.js";
import { applyCompatRoles, applyCompatRolesJson, detectRoleRejection, detectSystemPlacementError, resolveCompatRoles, type CompatRoles } from "./compat-roles.js";
import { applyOutputSteering, applyOutputSteeringJson } from "./output-steering.js";
import { bodyDumpEnabled, getUnrecognizedPathStats, isModelDiscoveryPath, logDumpFailure, logUnrecognizedPath } from "./server/observability.js";
import { BILI_HOP_HEADER, anthropicBetaContextWindow, capRegistryWindowByStandard, expandedContextSuffixWindow, LAUNCHER_MODEL_WINDOWS, LAUNCHER_MODEL_MAX_OUTPUTS, launcherContextWindow, launcherMaxOutput, parseLauncherModelWindows, windowSourceLogged } from "./server/context-window.js";
import { buildForwardHeaders, connectionNamedHeaders, NO_IDENTITY_MESSAGE, RESPONSE_ONLY_STRIP_HEADERS, safeSessionId, UPSTREAM_HOP_HEADERS } from "./server/headers.js";
import { isSideRequest, outputBudgetField, restoreOutputBudget, SIDE_REQUEST_MAX_TOKENS, sideRequestGuard } from "./server/side-request.js";
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
    const raw = process.env.BILI_REQUEST_WATCHDOG_MS;
    if (!raw) return 2 * upstreamTimeoutMs();
    const v = Number(raw);
    return Number.isFinite(v) ? Math.floor(v) : 2 * upstreamTimeoutMs();
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
    const server = http.createServer(async (req, res) => {
        armRequestWatchdog(req, res, log);
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
    });
    // Bili does not support WebSocket. An explicit 'upgrade' listener is
    // required: without one Node's behavior is version-dependent (some
    // versions destroy the socket with no response), delaying clients with
    // built-in fast-fallback (e.g. Codex) that need a clean 426 to switch to
    // HTTP POST immediately.
    server.on("upgrade", (req, socket) => {
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
            `acp-proxy listening on http://${displayHost}:${actualPort}` +
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
    process.on("uncaughtException", (err) => {
        if (isStreamWriteError(err)) {
            // Belt-and-suspenders for #1233: the logger's own stderr path is
            // guarded and never reaches here; a stream-write error that does
            // comes from some other writer hitting a dead stream. Log the
            // first, drop the rest — logging a storm through the logger would
            // only feed it.
            if (suppressedWriteErrors === 0) {
                log("error", `uncaughtException (stream-write; suppressing repeats): ${String(err?.stack ?? err)}`);
            } else {
                suppressedWriteErrors += 1;
            }
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
            log("warn", "shutdown grace window elapsed; forcing exit");
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
    nudge?: NudgeDecision;
    /** Render strategy the prepare used for processTurn ("none" for codex
     *  compaction triggers / ACP_RENDER_NONE). The #422 fold-refresh hook in
     *  forward() re-runs processTurn with the same strategy so the re-request
     *  renders tags exactly like the request that produced it. */
    renderTags?: "text-only" | "none";
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


// #767: per-request image billing mode — env BILI_IMAGE_BILLING (live, like
// BILI_IMAGE_TOKEN_CAP) wins over the per-provider route entry, which wins over
// the global config level; "auto"/unset classifies known first-party pixel-tile
// hosts by upstream URL. Every payload-size decision below consults this so one
// over-estimate cannot block all of them at once.
function imageBillingFor(opts: ProxyOptions, upstreamUrl: string | undefined): ResolvedImageBilling {
    const env = process.env.BILI_IMAGE_BILLING;
    const configured = env === "pixels" || env === "bytes" ? env : findRoute(opts.routes, upstreamUrl)?.imageBilling ?? opts.imageBilling ?? "auto";
    return resolveImageBilling(configured, upstreamUrl);
}

function isTrustedAdminOrigin(origin: string | undefined, host: string | undefined, trustedHosts: Set<string>): boolean {
    // Host must be one of OUR listen identities regardless of whether an
    // Origin header is present. A same-origin browser GET/fetch (the DNS
    // rebinding read path: evil.com → 127.0.0.1) often carries NO Origin
    // header, so gating on Origin alone would leave config reads exposed.
    if (!host || !trustedHosts.has(host.toLowerCase())) return false;
    if (!origin) return true; // non-browser client (curl, CLI UI) on a trusted Host
    try {
        const parsed = new URL(origin);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
        return trustedHosts.has(parsed.host.toLowerCase());
    } catch {
        return false;
    }
}

/** The set of Host header values we accept on management endpoints. DNS
 *  rebinding (attacker resolves evil.com → 127.0.0.1) can make a browser
 *  request carry Origin == Host == evil.com:port and still reach loopback;
 *  only pinning Host to our own listen address defeats it. */
function adminTrustedHosts(bindHost: string, port: number): Set<string> {
    const p = String(port);
    const names = ["localhost", "127.0.0.1", "[::1]"];
    if (bindHost && bindHost !== "0.0.0.0" && bindHost !== "::" && !names.includes(bindHost)) {
        names.push(bindHost);
    }
    const set = new Set<string>();
    for (const n of names) {
        set.add(`${n}:${p}`.toLowerCase());
        if (p === "80") set.add(n.toLowerCase());
    }
    return set;
}

// #924: one-time-per-model log for the output-budget fallback (request carries
// no budget → configured/registry max output) — same pattern as windowSourceLogged.
const headroomFallbackLogged = new Set<string>();

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
    if (isAdminPath && !isTrustedAdminOrigin(req.headers.origin, req.headers.host, adminTrustedHosts(opts.host, req.socket.localPort ?? opts.port))) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "management request origin does not match the local bili UI" }));
        return;
    }
    if (req.method === "GET" && req.url === "/__bili/stats") return sendStats(res);
    if (req.method === "GET" && req.url?.startsWith("/__bili/cache-report")) return sendCacheReport(res, req.url);
    if (req.method === "GET" && req.url === "/__bili/status") return sendStatus(res, opts);
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
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, status: result.response.status, target: targetUrl, proxy: proxyUrl ?? null }));
        } catch (error) {
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
    if (req.method === "GET" && req.url?.startsWith("/__bili/plugin/status")) {
        const query = req.url.slice(req.url.indexOf("?") + 1);
        const params = new URLSearchParams(query);
        const conversationId = params.get("conversationId")?.trim() ?? "";
        if (!conversationId) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "conversationId query parameter is required" }));
            return;
        }
        return handlePluginStatus(conversationId, res, { core, config, log }, params.get("fallback") === "latest");
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
            return await handlePluginTool(body.toString("utf8"), res, { core, config, log });
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
            });
            if (!verdict.ok) {
                log("warn", `[tunnel] denied ${maskUrlsInText(route.upstream)}: ${verdict.message}`);
                res.writeHead(403, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: verdict.message, code: "tunnel_destination_denied", detail: verdict.code }));
                return;
            }
        }
        upstreamOrigin = route ? route.upstream : /^https?:\/\//i.test(url) ? new URL(url).origin : opts.upstream;
        protocol =
            route?.explicitProtocol
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
                log("warn", `decode body failed (${String(decErr)}) - forwarding raw body verbatim to ${upstreamOrigin}`);
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
    // #1117: an unattributed in-process caller (native patch marked it — its
    // URL was already /bili/-routed by the settings overlay, so refusal was
    // impossible client-side) relays byte-untouched, mirroring a direct send
    // without the overlay: no session, no injection, no guard. Same raw
    // forward as the #920 bypass.
    if (passthroughMark) {
        log("debug", `passthrough: ${req.method ?? "?"} ${maskUrlForLog(req.url ?? "")} — unattributed in-process caller (#1117), relaying verbatim`);
        await forward(req, res, opts, bodyBuffer, null, core, config, log, route, instanceId, undefined);
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
        await forward(req, res, opts, bodyBuffer, null, core, config, log, route, instanceId, undefined);
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
            await forward(req, res, opts, bodyBuffer, null, core, config, log, route, instanceId, undefined);
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
    if (bodyDumpEnabled() && parsed && typeof parsed === "object") {
        try {
            const rawDir = process.env.ACP_RAW_DUMP_DIR || path.join(stateDir(), "raw");
            try { fs.mkdirSync(rawDir, { recursive: true }); } catch { /* best-effort */ }
            const hdrs = maskHeadersForLog(
                Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)])),
            );
            const hdrText = Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join("\n");
            fs.writeFileSync(path.join(rawDir, `${Date.now()}-INCOMING.txt`), `${req.method} ${maskUrlsInText(req.url ?? "")}\n${hdrText}\n\n${bodyBuffer.toString("utf8")}`);
        } catch (err) { logDumpFailure("INCOMING dump", err); }
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
            // request's plugin sent no window header AND the agent's latest
            // runtime-info entry matches THIS request's model — a stale
            // post-switch entry must never size a different model.
            const runtimeEntry = pluginRuntimeInfoFor(pluginAgentHeader(req.headers), model);
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
                    log("info", `[window] model=${model} source=${wsSource} native=${native ?? "none"} effective=${reqConfig.modelContextLimit} launcher=${launcherWindow ?? "none"} configured=${configuredWindow ?? "none"} peek=${peekWindow ?? "none"} fallback=${nativeFromFallback}`);
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
    // passthrough path below forwards it verbatim.
    if (!opts.passthrough && !routePassthrough && hopMarker === undefined && protocol && parsed && typeof parsed === "object") {
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
                  : anthropicIdentity?.value ?? anthropicSignal)
            : protocol === "openai"
              ? openaiIdentity?.value ?? openaiSignal
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
        let anonAffinity: AnonymousAffinity | null = null;
        if (!clientProvided) {
            const anonMessages = protocol === "responses"
                ? ((parsed as { input?: unknown }).input ?? [])
                : protocol === "google"
                  ? ((parsed as GoogleRequestBody).contents ?? [])
                  : ((parsed as { messages?: unknown }).messages ?? []);
            anonAffinity = prefixAffinity.resolve(Array.isArray(anonMessages) ? anonMessages : []);
            if (!anonAffinity) {
                log("warn", `400: no stable conversation identity on ${protocol} request → ${upstreamOrigin}; refusing to create a content-fingerprint session (#286)`);
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
        // #1086: content-fallback chain verdict, now that identity is known.
        // Artifacts + processed local state ⇒ self-produced: process normally.
        // Artifacts + NO local state ⇒ an upstream bili already compressed
        // this payload and its headers were stripped: forward verbatim and
        // create no session state (same contract as the hop-marker path).
        // Returning before getSession also skips note()/register consumption,
        // so a foreign session leaves no trace in this instance.
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
                // #1218: record the verdict under the session id AND the
                // client's own conversation value when they differ — /acp
                // status probes arrive keyed by the client's value (the same
                // key space resolveConversation uses), and the session-bound
                // id alone would be invisible to the client.
                const firstVerdict = recordChainVerdict(sessionId, artifactKind, protocol);
                if (clientConv !== undefined && clientConv !== sessionId) recordChainVerdict(clientConv, artifactKind, protocol);
                if (firstVerdict) {
                    log("warn", `[chain] inbound ${protocol} request carries ACP compression artifacts (${artifactKind}) but neither ${BILI_HOP_HEADER} nor local compression state for session ${sessionId} — likely a bili→bili chain whose headers were stripped. Passing through without processing; if this is your own client, disable the content fallback with chainContentDetection=false (env BILI_CHAIN_CONTENT=0).`);
                }
                await forward(req, res, opts, bodyBuffer, null, core, config, log, route, instanceId, undefined);
                return;
            }
            if (artifactKind !== null) {
                log("debug", `[chain] ACP artifacts (${artifactKind}) belong to this instance's own session ${sessionId} — self-produced, processing normally (#1086)`);
            }
        }
        // Two separate uses of the conversation signal:
        //  - `affinity`: header value forwarded upstream for sticky-routing /
        //    cache pools. Synthesized as ses_<conversation> when the client
        //    sent none (pi), so upstream still gets a stable key.
        //  - `label`: human-readable display in the web UI / stats. We store
        //    ONLY the client's own value (opencode x-session-affinity, codex
        //    body.session_id) — never the synthetic one — so a user can tell
        //    at a glance which client owns a session. pi sends nothing, so its
        //    label stays empty (shown as "—" in the UI).
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
            session.metadata.rawInputTokens = estimateRawBodyTokens(parsed) + imageTokensInParsedBody(protocol, parsed);
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
        if (!pluginAgent && !anonAffinity) {
            const identityAgent = consumePluginRegisterFor(clientConv ?? conversation);
            if (identityAgent) {
                pluginAgent = identityAgent;
                pluginConversation = clientConv ?? conversation;
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
            }
        }
        if (!pluginAgent && typeof session.metadata.pluginAgent === "string") pluginAgent = session.metadata.pluginAgent;
        if (pluginAgent && !pluginConversation) pluginConversation = conversation;
        if (pluginAgent) {
            if (session.metadata.pluginAgent !== pluginAgent) session.metadata.pluginAgent = pluginAgent;
            // #970: for a split subagent session, record it under its split
            // conversation id — recording under the raw conversation value
            // would flip the single-valued conversations map between the main
            // and subagent sessions on every interleaved request, breaking
            // /acp lookups and MCP tool routing (last writer wins). The raw
            // key keeps pointing at the MAIN session; the subagent session
            // stays reachable via its verbatim split id and its canonical
            // pfa-* (printed in wire notes).
            recordPluginSession(claudeSub !== undefined ? conversation : (pluginConversation ?? conversation), session.id);
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
        // (see README "Two compression modes"):
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
            (!process.env.ACP_NO_INJECT_TOOL && !FORCE_TEXT_PROTOCOL && resolveCompressProtocol(opts.routes, upstreamOrigin) !== "marker");
        // [review #1273] The plugin arm MUST gate on the BASE config because that
        // is the only source the manifest reads (handlePluginManifest sees
        // opts.compress.ccr, never the route/model-scoped merge). Route-scoped
        // enablement without a base-level enabled flag would otherwise arm the
        // store and emit placeholders while the manifest never advertised
        // acp_retrieve — the model would see "→ acp_retrieve(...)" with no
        // retrieval channel (silent loss). Route-scoped-only enablement stays
        // proxy-mode-only (the proxy injects the tool itself, per-request).
        const pluginCcrOk = !pluginMode || (ccrPluginWireOk(protocol) && opts.compress.ccr?.enabled === true);
        storeEffectiveCcr(session, opts.compress.injectTool && pluginCcrOk && storeChannelOk && resolvedCcrCfg?.enabled === true ? resolvedCcrCfg : undefined);
        // [#1095] same channel/plugin-mode gating as CCR: image_full's restore
        // round-trip needs a tool channel on this wire; without one the model
        // could request originals it never gets back (silent-loss trap).
        storeEffectiveImageCompression(session, opts.compress.injectTool && !pluginMode && storeChannelOk && resolvedImageCompressionCfg?.enabled === true ? resolvedImageCompressionCfg : undefined);
        // #546: restore a client-shrunk output budget BEFORE the side gate so a
        // tool-carrying main request re-enters the pipeline at full budget (see
        // restoreOutputBudget for the starvation mechanism).
        restoreOutputBudget(parsed, session, log);
        // #896: the per-scope output-headroom cap (compress.outputHeadroomMaxPct,
        // three-level merge; default 0.25, aligned with billion-context-pi).
        // Resolved once here so the side-request guard below AND the main-path
        // reservation measure against the SAME capped window.
        const headroomCap = resolveOutputHeadroomCap(resolveCompress(opts.routes, route?.rewrittenUrl, (parsed as { model?: string }).model, opts.compress).outputHeadroomMaxPct);
        // #388: side requests (title-gen etc.) share the main session key but
        // must not touch kernel state (processTurn/snapshot/usage would pollute
        // the main view). Forward with a minimal prepared marked sidePassthrough:
        // the #460 render-tag strip pipes still run (response hygiene), while
        // preflight / fake-completion retry / the loop / usage sniffing are all
        // skipped. processedMessages stays empty so the loop can never engage.
        if (!countTokens && !responsesCompact && protocol !== null && isSideRequest(parsed)) {
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
            const guard = sideRequestGuard(parsed, protocol, reqConfig.modelContextLimit, imageBillingFor(opts, route?.rewrittenUrl ?? upstreamOrigin), headroomCap, armedForGuard);
            if (guard.blocked) {
                log("warn", `[${session.id}] side request (~${guard.estimate} tokens) ≥ effective window ${guard.limit} (model=${reqModel ?? "?"}) — NOT forwarded: guaranteed upstream 400 (side requests bypass preflight by design, #388)`);
                if (!res.headersSent && !res.writableEnded && !res.destroyed) {
                    res.writeHead(413, { "content-type": "application/json" });
                    res.end(JSON.stringify({
                        error: {
                            type: "server_error",
                            code: "side_request_payload_too_large",
                            message: `side request payload ~${guard.estimate} tokens reaches the effective context window ${guard.limit} (model=${reqModel ?? "unknown"}); NOT forwarded — side requests (max_tokens<=${SIDE_REQUEST_MAX_TOKENS}) bypass compression by design (#388). Shrink the conversation or raise the model's context window.`,
                            retryable: false,
                        },
                    }));
                }
                logRequestCost(log, session.id, inboundMsgs, inboundBytes, reqT0);
                return;
            }
            log("info", `[${session.id}] side request (max_tokens<=${SIDE_REQUEST_MAX_TOKENS}) → passthrough + tag strip only, kernel state untouched`);
            const sidePrepared: Prepared = {
                body: bodyBuffer,
                session,
                processedMessages: [],
                originalMessages: [],
                protocol,
                stream: (parsed as { stream?: unknown }).stream === true,
                compressInjected: false,
                sidePassthrough: true,
            };
            logRequestCost(log, session.id, inboundMsgs, inboundBytes, reqT0, bodyBuffer);
            await forward(req, res, opts, bodyBuffer, sidePrepared, core, reqConfig, log, route, instanceId, affinity);
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
        // exempt: its input limit is enforced independently of max_tokens
        // (separate output budget), so reserving would shift every band down by
        // maxOutput on every session for no safety gain — see
        // shouldReserveOutputHeadroom. The request's own budget field is the exact
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
                const runtimeMax = (pluginHeadersMatchModel(req.headers, fbModel0) ? pluginReportedMaxOutput(req.headers) : undefined) ?? pluginRuntimeInfoFor(pluginAgentHeader(req.headers), fbModel0)?.maxOutput;
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
            if (reserved !== reqConfig.modelContextLimit) reqConfig = { ...reqConfig, modelContextLimit: reserved };
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
                        ? await prepareAnthropic(work as AnthropicRequestBody, req, opts, core, reqConfig, reqPrompts, reqSurface, log, session, pluginMode, upstreamOrigin, reasoningCfg, visibilityMarkers)
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
                logRequestCost(log, session.id, inboundMsgs, inboundBytes, reqT0, prepared!.body);
                return { body: prepared!.body, prepared: prepared! };
            };
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
                    await withSessionLock(session, () => rememberPluginMessages(sessionId, preparedToRemember.processedMessages, preparedToRemember.originalMessages, preparedToRemember.nudge));
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
        await forward(req, res, opts, bodyBuffer, null, core, reqConfig, log, route, instanceId, undefined);
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
// Per mode (see README "Two compression modes"): in plugin/launcher mode the
// tool call is ALWAYS in the re-sent history (the agent owns compression), so
// this strips every acp_summary and the carrier is the tool call; in proxy mode
// the tool call is usually absent (ephemeral server-side execution) or
// nonexistent (preflight), so acp_summary survives as the carrier and
// systemToUser later re-voices the survivors as USER messages (leaving them at
// their anchors) for strict backends (#377).
/** [#651] Strip oversized reasoning from closed compress turns (see
 *  src/reasoning-drop.ts) with an ops log line when anything was dropped. */
function withReasoningDrop(
    msgs: BiliMessage[],
    reasoning: CompressReasoningConfig | undefined,
    log: (level: string, msg: string) => void,
    sessionId: string,
    strictEcho: boolean,
): BiliMessage[] {
    // [#684] strict-echo upstreams: reasoning must round-trip with tool_calls,
    // so #651's drop must not fire. Learned/static strictness both land here.
    if (strictEcho) return msgs;
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
 *  extended thinking never carry a block, and #651's dropCompressReasoning
 *  creates the same shape by design — the old heuristic warned on every
 *  healthy multi-turn session. Turns match by stable tool_use id (the kernel
 *  codec round-trips it verbatim); benign asymmetry stays fully silent. */
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

/** [#684] Responses-wire twin: function_call item with no reasoning item
 *  immediately preceding it while other turns carry reasoning. */
export function warnResponsesReasoningPairs(
    input: unknown[],
    log: (level: string, msg: string) => void,
    sessionId: string,
): void {
    let withReasoning = 0;
    let split = 0;
    let prevWasReasoning = false;
    for (const item of input) {
        const it = item as { type?: string };
        if (it?.type === "reasoning") {
            withReasoning++;
            prevWasReasoning = true;
            continue;
        }
        if (it?.type === "function_call" && !prevWasReasoning) split++;
        prevWasReasoning = false;
    }
    if (withReasoning > 0 && split > 0) {
        log("warn", `[${sessionId}] reasoning-pair-violated: ${split} function_call item(s) lack a preceding reasoning item while ${withReasoning} exist — strict-echo upstreams will reject the request (#684)`);
    }
}

export function stripKernelSummaries(messages: BiliMessage[], state: CompressionState): BiliMessage[] {
    const carried = new Set<string>();
    for (const b of state.blocks) {
        if (!b.active || !b.compressCallId) continue;
        if (messages.some((m) => m.contentType === "tool-call" && m.toolCallId === b.compressCallId)) {
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
// anonymously (prefix-affinity forks/reloads, #553): they carry the full raw
// history but no measurement yet, so feeding 0 blinds the nudge (usage 0%,
// growth ref 0) and no compression trigger fires until overflow. Explicit-
// identity zero-baseline sessions previously stayed at 0 on the assumption
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
function effectiveTokenCount(session: Session, msgs: CoreMessage[], inboundImageTokens = 0): number {
    if (session.stats.lastInputTokens > 0) return session.stats.lastInputTokens;
    // The inbound upper bound carries the image term in BOTH zero-baseline
    // regimes (#1119/#1137): the wire codecs move images out of
    // CoreMessage.text into sidecars, so a text-only bound drops them.
    // #1137: an anonymous prefix-affinity fork (#553) replays its FULL raw
    // history — images included — in this one request, so this request's
    // image mass IS the history's image mass; returning the text-only bound
    // there left image-heavy forks reading single-digit usage % and nudging
    // only at overflow.
    const raw = estimateCoreMessagesUpper(msgs) + inboundImageTokens;
    if (session.metadata.anonymousPrefixAffinity) return raw;
    const est = session.stats.localInputEstimate ?? 0;
    if (est <= 0) return 0;
    // Cap by THIS request's inbound upper bound: the recorded estimate lags by
    // one turn, so after a client-side shrink (native compaction echo, history
    // edit) the previous turn's payload can be larger than what is in front of
    // us now — never claim more context than the current request could hold.
    // In steady state est <= raw bound always (the outbound fold is never
    // larger than the inbound history), so this is a no-op there. A
    // client-side shrink still shrinks the bound (fewer messages AND fewer
    // images), preserving the stale-high invariant.
    return Math.min(est, raw);
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
    let originalMessages: CoreMessage[] = [];
    let nudge: NudgeDecision | undefined;
    let rebuiltMessages = parsed.messages;
    let systemOut = parsed.system;
    let toolsOut = parsed.tools;

    // #1085: sticky head-system anchor — freeze the client's own `system` text
    // at first sight and forward it byte-stable; detected changes ride as
    // trailing user notes. Mutating parsed.system in place makes every
    // downstream consumer (injectSystem, Prepared.anthropicSystem → loop)
    // inherit the anchor, and the failure path below keeps forwarding it too.
    let sysNotes: string[] = [];
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

    try {
        const { msgs, cacheControls } = anthropicToCore(parsed);
        originalMessages = msgs;
        // #1320: signature-only thinking blocks bill restored thinking tokens upstream
        // but project as empty text locally — attribute the provider-vs-local residual
        // to them so every meter sees the billed context (metering-only, wire untouched).
        const inboundImageTokens = imageTokensInParsedBody("anthropic", parsed, imageBillingFor(opts, upstreamOrigin));
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
        const tokenCount = effectiveTokenCount(session, msgs, inboundImageTokens);
        const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
        // Absorb markers are injected by the kernel's processTurn from
        // config.absorb. With no channel to call the tool (injection off),
        // strip absorb from the loop config so the REQUIRED instruction never
        // reaches the wire. Hiding recorded absorptions is unaffected
        // (applyAbsorbView hides regardless of enablement).
        const absorbActive = absorbEnabled(config) && opts.compress.injectTool;
        // acp_rule has no processTurn side effect (no markers/instructions are
        // ever injected into messages), so unlike absorb it needs no loop-
        // config stripping — only tool availability matters.
        const rulesActive = rulesEnabled(config) && opts.compress.injectTool;
        // [#1097] the kernel ccr-store node ID-references oversized tool results
        // BEFORE absorb (ID-reference wins over distill); armed policy is
        // stamped per-request — strip `ccr` from the loop config when disarmed
        // (plugin mode / no tool channel) so placeholders never hit the wire.
        const loopConfig = { ...(absorbActive ? config : { ...config, absorb: undefined }), ...(ccrEnabled(session) ? {} : { ccr: undefined }) };
        const turn = core.processTurn({ messages: msgs, state: session.state, config: loopConfig, tokenCount, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only", contentStore: contentStoreOf(session) });
        session.state = turn.state;
        adoptContentStore(session, turn.contentStore);
        // The fold from last turn's compress has now materialized in state —
        // future usage reports are post-fold reality, drop the credit.
        session.stats.compressCreditTokens = 0;
        storeEffectiveAbsorb(session, loopConfig);
        storeEffectiveRules(session, config);
        turn.messages = applyAbsorbView(turn.messages, session.state, loopConfig, tokenCount);
        // Drop sub-viability fragments before any consumer sees them: a tiny
        // range in the list makes batched compress attempts fail atomically
        // (kernel validates the whole batch). Mirrors billion-context-pi.
        if (turn.nudge) turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
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
                markCompactionBoundary(session);
            }
        }
        applyCompactionArchive(session, activeBefore, new Set(msgs.map((m) => m.id)), log);
        reapOrphanBlocks(session, msgs, deactivateBlock);
        // [#1095] downscale screenshot-like images ONCE at arrival (kernel routing
        // decision + recipe; originals cached for the image_full restore channel).
        // Deterministic encode ⇒ re-runs are byte-stable for the prefix cache.
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, upstreamOrigin), log });
        // [#1271] plugin mode: acp_retrieve ran via the tool API; ride the full original
        // back on this forward as a request-only trailing message (ephemeral, never persisted).
        if (pluginMode && ccrEnabled(session)) {
            const retrInj = drainPendingRetrievals(session);
            if (retrInj.length > 0) processedMessages = [...processedMessages, ...retrInj];
        }
        rebuiltMessages = coreToAnthropic(processedMessages as BiliMessage[], cacheControls);
        if (sysNotes.length > 0) {
            rebuiltMessages = [...rebuiltMessages, ...sysNotes.map((text) => ({ role: "user" as const, content: text }))];
        }

        systemOut = injectSystem(parsed, opts, prompts, loopConfig, ensureCanonicalId(session), surface, visibilityMarkers);
        if (injectTools) {
            toolsOut = injectTool(parsed.tools, [...(absorbActive ? [ABSORB_TOOL] : []), ...(rulesActive ? [RULE_TOOL] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).anthropic] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL] : [])], surface?.toolPrompts);
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
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
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
        + imageTokensInParsedBody("anthropic", rebuilt, imageBillingFor(opts, upstreamOrigin));
    return { body: JSON.stringify(rebuilt), session, processedMessages, originalMessages, anthropicSystem: parsed.system, systemNotes: sysNotes, protocol: "anthropic", stream, compressInjected: injectTools, pluginMode, nudge, prompts, surface, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only" } as Prepared;
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
        const tokenCount = effectiveTokenCount(session, msgs, imageTokensInParsedBody("openai", parsed, imageBillingFor(opts, billingUpstream ?? upstreamOrigin)));
        const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
        // Absorb markers ride in the kernel's processTurn output (gated by
        // config.absorb). Title-gen requests skip ALL injection for
        // prefix-cache stability, so strip absorb from the loop config there.
        const absorbActive = absorbEnabled(config) && shouldInject;
        const rulesActive = rulesEnabled(config) && shouldInject;
        const loopConfig = { ...(absorbActive ? config : { ...config, absorb: undefined }), ...(ccrEnabled(session) ? {} : { ccr: undefined }) };
        const turn = core.processTurn({ messages: msgs, state: session.state, config: loopConfig, tokenCount, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only", contentStore: contentStoreOf(session) });
        session.state = turn.state;
        adoptContentStore(session, turn.contentStore);
        // The fold from last turn's compress has now materialized in state —
        // future usage reports are post-fold reality, drop the credit.
        session.stats.compressCreditTokens = 0;
        storeEffectiveAbsorb(session, loopConfig);
        storeEffectiveRules(session, config);
        turn.messages = applyAbsorbView(turn.messages, session.state, loopConfig, tokenCount);
        // Drop sub-viability fragments before any consumer sees them: a tiny
        // range in the list makes batched compress attempts fail atomically
        // (kernel validates the whole batch). Mirrors billion-context-pi.
        if (turn.nudge) turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
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
                markCompactionBoundary(session);
            }
        }
        applyCompactionArchive(session, activeBefore, new Set(msgs.map((m) => m.id)), log);
        reapOrphanBlocks(session, msgs, deactivateBlock);
        // [#1095] arrival-time image downscale (see prepareAnthropic) — one
        // deterministic encode per fingerprint; byte-stable re-runs.
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, billingUpstream ?? upstreamOrigin), log });
        // [#1271] plugin mode: acp_retrieve ran via the tool API; ride the full original
        // back on this forward as a request-only trailing message (ephemeral, never persisted).
        if (pluginMode && ccrEnabled(session)) {
            const retrInj = drainPendingRetrievals(session);
            if (retrInj.length > 0) processedMessages = [...processedMessages, ...retrInj];
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
        if (shouldInject) sysParts.push(withConversationIdNote(withMarkerIntegrityNote(withSummaryBudgetNote(buildCompressSystemPrompt(prompts, surface?.promptSections)), visibilityMarkers), ensureCanonicalId(session)));
        if (absorbActive) sysParts.push(buildAbsorbSystemPrompt(absorbToolName(config)));
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
            toolsOut = injectOpenaiTool(parsed.tools, [...(absorbActive ? [ABSORB_TOOL_OPENAI] : []), ...(rulesActive ? [RULE_TOOL_OPENAI] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).openai] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL_OPENAI] : [])], surface?.toolPrompts);
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
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    // #762: repair the strict-echo rejection class BEFORE the sentinel sees
    // the array — a normalized body must not fire its own canary.
    rebuiltMessages = normalizeStrictEchoReasoning(rebuiltMessages, isStrictReasoningEcho(session, upstreamOrigin, modelIdOf(parsed)), log, sessionId);
    const rebuilt: OpenAIRequestBody = { ...parsed, messages: rebuiltMessages, tools: toolsOut as OpenAITool[] | undefined };
    warnReasoningPairs(rebuiltMessages, log, sessionId);
    clampOutgoingOutput(rebuilt as Record<string, unknown>, typeof (parsed as Record<string, unknown>).max_completion_tokens === "number" ? "max_completion_tokens" : "max_tokens", { systemText: openaiSystemText, tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, nativeWindow, imageTokens: imageTokensInParsedBody("openai", rebuilt, imageBillingFor(opts, billingUpstream ?? upstreamOrigin)) }, sessionId, log);
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
            + imageTokensInParsedBody("openai", rebuilt, imageBillingFor(opts, billingUpstream ?? upstreamOrigin));
    }
    snapshotMessages(session, originalMessages);
    markDirty(session);
    return { body: JSON.stringify(rebuilt), session, processedMessages, originalMessages, protocol: "openai", stream, compressInjected: injectTools, pluginMode, nudge, prompts, surface, openaiSystemText, systemNotes: sysNotes, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only" } as Prepared;
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
        const tokenCount = effectiveTokenCount(session, msgs, imageTokensInParsedBody("google", parsed, imageBillingFor(opts, upstreamOrigin)));
        const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
        const absorbActive = absorbEnabled(config) && shouldInject;
        // acp_rule has no processTurn side effect (no markers/instructions are
        // ever injected into messages), so unlike absorb it needs no loop-
        // config stripping — only tool availability matters.
        const rulesActive = rulesEnabled(config) && shouldInject;
        const loopConfig = { ...(absorbActive ? config : { ...config, absorb: undefined }), ...(ccrEnabled(session) ? {} : { ccr: undefined }) };
        const turn = core.processTurn({ messages: msgs, state: session.state, config: loopConfig, tokenCount, renderTags: "text-only", contentStore: contentStoreOf(session) });
        session.state = turn.state;
        adoptContentStore(session, turn.contentStore);
        // The fold from last turn's compress has materialized in state — future
        // usage reports are post-fold reality, drop the credit.
        session.stats.compressCreditTokens = 0;
        storeEffectiveAbsorb(session, loopConfig);
        storeEffectiveRules(session, config);
        turn.messages = applyAbsorbView(turn.messages, session.state, loopConfig, tokenCount);
        // Drop sub-viability fragments before any consumer sees them (the
        // kernel validates a compress batch atomically).
        if (turn.nudge) turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
        if (!session.meta.title) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        const willInjectNudge = opts.compress.injectNudge && !!turn.nudge && shouldInject && (turn.nudge.shouldInject || emergencyNudge(turn.nudge));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, model, willInjectNudge));
        processedMessages = stripKernelSummaries(turn.messages, turn.state);
        applyCompactionArchive(session, activeBefore, new Set(msgs.map((m) => m.id)), log);
        reapOrphanBlocks(session, msgs, deactivateBlock);
        // [#1095] arrival-time image downscale (see prepareAnthropic).
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, upstreamOrigin), log });
        rebuiltContents = coreToGoogle(processedMessages as BiliMessage[]);

        // ONLY the static compress prompt joins the client's system text — the
        // system instruction is the prefix-cache anchor and must stay
        // byte-stable across turns. The per-turn nudge is appended to the
        // trailing user content below (see prepareOpenai for the rationale).
        const sysParts: string[] = [];
        if (googleClientSystem) sysParts.push(googleClientSystem);
        if (shouldInject) sysParts.push(withMarkerIntegrityNote(buildCompressSystemPrompt(prompts, surface?.promptSections), visibilityMarkers));
        if (absorbActive) sysParts.push(buildAbsorbSystemPrompt(absorbToolName(config)));
        googleOutboundSystem = sysParts.join("\n\n");
        // Untouched when nothing was added beyond the client's own text: the
        // original `systemInstruction` object then rides through byte-identical
        // instead of being re-serialized into a new shape.
        const extraSystemParts = sysParts.slice(googleClientSystem ? 1 : 0);
        systemInstruction = extraSystemParts.length > 0 ? { parts: sysParts.map((text) => ({ text })) } : parsed.systemInstruction;
        if (injectTools) {
            toolsOut = injectGoogleTool(parsed.tools, [...(absorbActive ? [ABSORB_TOOL_GOOGLE] : []), ...(rulesActive ? [RULE_TOOL_GOOGLE] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).google] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL_GOOGLE] : [])], surface?.toolPrompts);
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
    clampOutgoingOutput(rebuilt as Record<string, unknown>, "generationConfig.maxOutputTokens", { systemText: googleClientSystem, tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, nativeWindow, imageTokens: imageTokensInParsedBody("google", rebuilt) }, sessionId, log);
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
        const turn = core.processTurn({ messages: msgs, state: session.state, config: ccrEnabled(session) ? config : { ...config, ccr: undefined }, tokenCount: session.stats.lastInputTokens, renderTags: "text-only", contentStore: contentStoreOf(session) });
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
    const renderTags: "text-only" | "none" = process.env.ACP_RENDER_NONE || isCompactionTrigger ? "none" : "text-only";

    try {
        const projection = responsesToCore(parsed);
        responsesProjection = projection;
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
        if (process.env.ACP_DEBUG) {
            log("info", `[${sessionId}] input items: ${Array.isArray(parsed.input) ? parsed.input.map((i: ResponseInputItem) => i.type).join(",") : "(string)"}`);
        }
        const tokenCount = effectiveTokenCount(session, msgs, imageTokensInParsedBody("responses", parsed, imageBillingFor(opts, billingUpstream ?? upstreamOrigin)));
        // Absorb markers ride in the kernel's processTurn output (gated by
        // config.absorb). The marker/text protocol has no native tool channel,
        // so strip absorb from the loop config there (both modes).
        const absorbActive = absorbEnabled(config) && shouldInject && !isCompactionTrigger && !responsesTextProtocol;
        const rulesActive = rulesEnabled(config) && shouldInject && !isCompactionTrigger && !responsesTextProtocol;
        const loopConfig = { ...(absorbActive ? config : { ...config, absorb: undefined }), ...(ccrEnabled(session) ? {} : { ccr: undefined }) };
        const turn = core.processTurn({ messages: msgs, state: session.state, config: loopConfig, tokenCount, renderTags, contentStore: contentStoreOf(session) });
        session.state = turn.state;
        adoptContentStore(session, turn.contentStore);
        // The fold from last turn's compress has now materialized in state —
        // future usage reports are post-fold reality, drop the credit.
        session.stats.compressCreditTokens = 0;
        storeEffectiveAbsorb(session, loopConfig);
        storeEffectiveRules(session, config);
        turn.messages = applyAbsorbView(turn.messages, session.state, loopConfig, tokenCount);
        // Drop sub-viability fragments before any consumer sees them: a tiny
        // range in the list makes batched compress attempts fail atomically
        // (kernel validates the whole batch). Mirrors billion-context-pi.
        if (turn.nudge) turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
        if (!session.meta.title) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        const willInjectNudge = opts.compress.injectNudge && !!turn.nudge && shouldInject && !isCompactionTrigger && (turn.nudge.shouldInject || emergencyNudge(turn.nudge));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, parsed.model, willInjectNudge));
        processedMessages = repairResponsesAssistantOrdering(stripReasoning(stripKernelSummaries(turn.messages, turn.state)), originalMessages);
        reapOrphanBlocks(session, msgs, deactivateBlock);
        // [#1095] arrival-time image downscale (see prepareAnthropic).
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, billingUpstream ?? upstreamOrigin), log });
        rebuiltInput = patchResponsesInput(projection, processedMessages);
        if (Array.isArray(rebuiltInput)) rebuiltInput = hoistTrappedToolItems(rebuiltInput);
        // Fallback path: when the echo did NOT come back this turn (client
        // dropped it / restarted), the history-borne handoff is absent and the
        // forge-time captured summaries are re-injected into the developer
        // message so the pre-compaction content is never lost. When the echo
        // DID come back, the replacement message carries the summaries and
        // the injection is suppressed to avoid duplicating them.
        const forgedSummaries = echoReplaced
            ? []
            : (session.metadata.codexForgedSummaries as string[] | undefined) ?? [];
        if (shouldInject && !isCompactionTrigger && !process.env.ACP_NO_COMPRESS_PROMPT) {
            const prompt = withConversationIdNote(withMarkerIntegrityNote(withSummaryBudgetNote(responsesTextProtocol ? buildCompressHybridSystemPrompt(prompts, surface?.promptSections) : buildCompressSystemPrompt(prompts, surface?.promptSections)), visibilityMarkers), ensureCanonicalId(session));
            const devParts = [...projection.systemParts, ...forgedSummaries, prompt];
            if (absorbActive) devParts.push(buildAbsorbSystemPrompt(absorbToolName(config)));
            const devContent = devParts.join("\n\n---\n\n");
            responsesDevContent = devContent;
            rebuiltInput = injectResponsesDeveloperMessage(rebuiltInput, devContent);
            if (!process.env.ACP_NO_INJECT_TOOL && injectTools) {
                const respExtra = [...(absorbActive ? [ABSORB_TOOL_RESPONSES] : []), ...(rulesActive ? [RULE_TOOL_RESPONSES] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).responses] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL_RESPONSES] : [])];
                toolsOut = responsesTextProtocol
                    ? injectResponsesTool(parsed.tools, BILI_ACP_READONLY_TOOLS_RESPONSES, surface?.toolPrompts)
                    : injectResponsesTool(parsed.tools, respExtra.length > 0 ? [...BILI_ACP_TOOLS_RESPONSES, ...respExtra] : BILI_ACP_TOOLS_RESPONSES, surface?.toolPrompts);
            }
        } else if (projection.systemParts.length > 0 || forgedSummaries.length > 0) {
            const devContent = [...projection.systemParts, ...forgedSummaries].join("\n\n---\n\n");
            responsesDevContent = devContent;
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

    const rebuilt: ResponsesRequestBody = { ...parsed, input: rebuiltInput, tools: toolsOut };
    warnResponsesReasoningPairs(Array.isArray(rebuiltInput) ? rebuiltInput : [], log, sessionId);
    if (!isCompactionTrigger) {
        clampOutgoingOutput(rebuilt as Record<string, unknown>, "max_output_tokens", { systemText: (responsesProjection?.systemParts ?? []).join("\n"), tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, nativeWindow, imageTokens: imageTokensInParsedBody("responses", rebuilt, imageBillingFor(opts, billingUpstream ?? upstreamOrigin)) }, sessionId, log);
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
    // ACP_KEEP_RESPONSE_ID=1 to preserve it (diagnostic only). `instructions`
    // was already lifted into the developer message at input[1]; forwarding it
    // again here double-sends it and violates the responses_lite contract
    // (top-level instructions must stay empty for code_mode tool exposure).
    if (process.env.ACP_KEEP_RESPONSE_ID !== "1") delete rebuilt.previous_response_id;
    delete rebuilt.instructions;
    // Same rationale as prepareOpenai: strip the OpenAI-host-only cache
    // directive; keep prompt_cache_key. Sent by hermes' codex transport and
    // by any PI_CACHE_RETENTION=long client.
    delete (rebuilt as Record<string, unknown>).prompt_cache_retention;
    // Log the final tools we forward upstream so we can confirm ACP tools are
    // present. Distinguishes "compress" (top-level function) from Codex
    // namespace items (type:namespace/custom).
    if (process.env.ACP_DEBUG) {
        const fwdTools = (Array.isArray(toolsOut) ? toolsOut : []).map((t) => {
            const r = t as Record<string, unknown>;
            const sub = Array.isArray(r.tools) ? `(${r.tools.length} sub)` : "";
            return `${r.type as string}:${(r.name as string) ?? "?"}${sub}`;
        });
        log("info", `[${sessionId}] responses forward tools=[${fwdTools.join(",")}] injectTool=${injectTools}${pluginMode ? " (plugin mode: wire injection suppressed)" : ""} NO_INJECT_TOOL=${!!process.env.ACP_NO_INJECT_TOOL} NO_COMPRESS_PROMPT=${!!process.env.ACP_NO_COMPRESS_PROMPT}`);
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
            + imageTokensInParsedBody("responses", rebuilt, imageBillingFor(opts, billingUpstream ?? upstreamOrigin));
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
    };
}

export function isCountTokensRequest(method: string, urlPath: string, hasBody: boolean): boolean {
    return (
        method === "POST" &&
        hasBody &&
        process.env.ACP_COUNT_TOKENS_PASSTHROUGH !== "1" &&
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
        const turn = core.processTurn({ messages: msgs, state: session.state, config: ccrEnabled(session) ? config : { ...config, ccr: undefined }, tokenCount: session.stats.lastInputTokens, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only", contentStore: contentStoreOf(session) });
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
        const compactConfig = { ...config, absorb: undefined, ...(ccrEnabled(session) ? {} : { ccr: undefined }) };
        const turn = core.processTurn({ messages: projection.msgs, state: session.state, config: compactConfig, tokenCount: session.stats.lastInputTokens, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only", contentStore: contentStoreOf(session) });
        session.state = turn.state;
        adoptContentStore(session, turn.contentStore);
        transformOk = true;
        if (!codexCompactGate(session, config.modelContextLimit, transformOk)) {
            session.state = prevState;
            session.contentStore = prevStore;
            session.contentStoreDirty = prevStoreDirty;
            return base;
        }
        const viewed = applyAbsorbView(turn.messages, turn.state, compactConfig, session.stats.lastInputTokens);
        const processed = repairResponsesAssistantOrdering(stripKernelSummaries(viewed, turn.state), projection.msgs);
        let output = patchResponsesInput(projection, processed);
        if (typeof output === "string") {
            session.state = prevState;
            session.contentStore = prevStore;
            session.contentStoreDirty = prevStoreDirty;
            return base;
        }
        output = hoistTrappedToolItems(output);
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

function injectSystem(
    parsed: AnthropicRequestBody,
    opts: ProxyOptions,
    prompts: Prompts = defaultPrompts,
    config: Config,
    noteId: string,
    surface?: PackSurface,
    visibilityMarkers = true,
): string | AnthropicRequestBody["system"] {
    // ONLY the static compress prompt goes into the system block — it is the
    // prefix-cache anchor and must stay byte-stable across turns. The nudge
    // (which changes every turn) is appended as a trailing user message by
    // the caller (prepareAnthropic), never merged into system.
    const baseText = extractSystem(parsed.system);
    const parts: string[] = [];
    if (opts.compress.injectTool) parts.push(withConversationIdNote(withMarkerIntegrityNote(withSummaryBudgetNote(buildCompressSystemPrompt(prompts, surface?.promptSections)), visibilityMarkers), noteId));
    if (opts.compress.injectTool && absorbEnabled(config)) parts.push(buildAbsorbSystemPrompt(absorbToolName(config)));
    if (parts.length === 0) return parsed.system;
    const full = baseText ? `${baseText}\n\n---\n\n${parts.join("\n\n")}` : parts.join("\n\n");
    return buildSystem(full, parsed.system);
}

// #920: in proxy mode bili OWNS the compression tool names. Agent-side tools
// with the same name (opencode-acp's statically-registered DCP set ships in
// every opencode request body — the v1 tool registry is process-global and
// cannot be filtered per request) are dropped here so the upstream sees
// exactly one definition per name, and it is bili's (its arg schemas are what
// the compress loop dispatches on). Plugin mode never calls these helpers.
function injectTool(tools: unknown[] | undefined, extras?: readonly { name: string }[], toolPrompts?: ToolPrompts): unknown[] {
    const acp = applyAcpToolOverrides(BILI_ACP_TOOLS_ANTHROPIC, toolPrompts);
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

function injectOpenaiTool(tools: OpenAITool[] | undefined, extras?: readonly OpenAITool[], toolPrompts?: ToolPrompts): OpenAITool[] {
    const acp = applyAcpToolOverrides(BILI_ACP_TOOLS_OPENAI, toolPrompts) as OpenAITool[];
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
function injectGoogleTool(tools: GoogleTool[] | undefined, extra?: { name: string }[], toolPrompts?: ToolPrompts): GoogleTool[] {
    const acp = applyAcpToolOverrides(BILI_ACP_TOOLS_GOOGLE, toolPrompts) as GoogleFunctionDeclaration[];
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
const FORCE_TEXT_PROTOCOL = process.env.ACP_COMPRESS_PROTOCOL === "text";
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

function buildForwardTarget(
    req: http.IncomingMessage,
    opts: ProxyOptions,
    route: ReturnType<typeof resolveUpstream>,
    affinity?: string,
    hopMarker?: string,
): ForwardTarget {
    // rewrittenUrl may use a `mitm://` scheme (for config-lookup distinction
    // — see resolveUpstream). fetch needs the real https:// scheme, so strip
    // mitm:// back to https:// for the actual upstream request.
    const reqUrl = req.url ?? "";
    const isAbsoluteUrl = /^https?:\/\//i.test(reqUrl);
    const rewritten = route ? route.rewrittenUrl : isAbsoluteUrl ? reqUrl : opts.upstream + reqUrl;
    const upstreamUrl = rewritten.replace(/^mitm:\/\//, "https://");
    const headers: Record<string, string> = {};
    const reqConnNamed = connectionNamedHeaders(req.headers["connection"]);
    for (const [k, v] of Object.entries(req.headers)) {
        const lower = k.toLowerCase();
        if (UPSTREAM_HOP_HEADERS.has(lower) || reqConnNamed.has(lower) || v === undefined) continue;
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
const PREFLIGHT_HOLD_GRACE_DEFAULT_MS = 30_000;
const PREFLIGHT_KEEPALIVE_MS = 15_000;

function preflightHoldGraceMs(): number {
    const raw = process.env.BILI_PREFLIGHT_HOLD_MS;
    if (!raw) return PREFLIGHT_HOLD_GRACE_DEFAULT_MS;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : PREFLIGHT_HOLD_GRACE_DEFAULT_MS;
}

// Cache exhausted walks and non-transient HTTP rejections only for the same
// forwarded body. Transport failures do not establish a content dead end.
const PREFLIGHT_DEAD_END_COOLDOWN_DEFAULT_MS = 5 * 60_000;

function preflightDeadEndCooldownMs(): number {
    const raw = process.env.BILI_PREFLIGHT_DEAD_END_COOLDOWN_MS;
    if (!raw) return PREFLIGHT_DEAD_END_COOLDOWN_DEFAULT_MS;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : PREFLIGHT_DEAD_END_COOLDOWN_DEFAULT_MS;
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
    // trigger on the real post-fold payload too.
    // #488: images are forwarded verbatim but invisible to the kernel's text model —
    // add their cost to every size decision here (trigger, fit gates, self-heal).
    // #767: bill them by the resolved mode (same upstream-URL fallback as buildForwardTarget).
    const preflightReqUrl = req.url ?? "";
    const billingUpstream = route?.rewrittenUrl ?? (/^https?:\/\//i.test(preflightReqUrl) ? preflightReqUrl : opts.upstream);
    const imageTokens = imageTokensInRawBody(prepared.protocol, prepared.body, imageBillingFor(opts, billingUpstream));
    const textEstimate = estimateCoreMessages(prepared.processedMessages);
    // #470: system + tool definitions ride the wire too but are invisible to
    // estimateCoreMessages — without them the trigger fires late (text alone
    // under the window while the billed input already overflows it).
    const overheadEstimate = estimateWireOverhead(prepared.protocol, prepared.body);
    const payloadEstimate = textEstimate + overheadEstimate + imageTokens;
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
    const tokenCount = unknownBaseline
        ? estimateCoreMessagesUpper(prepared.processedMessages) + overheadEstimate + imageTokens
        : Math.max(session.stats.lastInputTokens, payloadEstimate);
    if (limit <= 0 || !model || tokenCount < compressionTarget) return prepared;
    const payloadFitsWindow = (unknownBaseline ? tokenCount : payloadEstimate) < limit;
    // #496 forward-once-then-learn: the default image cost (base64/4) matches byte
    // relays (#488) but overestimates pixel-tile upstreams (a 400KB JPEG ≈ 1.6K real
    // tokens, not ~133K), so an image-dominated payload can clear the window on ESTIMATE
    // alone. When images are the sole over-window component (text fits) and we hold no
    // upstream overflow evidence, forward once and let the upstream arbitrate billing:
    // tile upstreams accept it; byte relays reject it (400) → the rejection
    // arms the emergency shrink (at the stated window, or the declared one
    // when the body carries no number) → later requests fail-fast.
    // #488's 400 loop stays broken (exactly one rejected forward). Evidence signals:
    // A usage-grounded baseline ≥ window is evidence; an estimate-derived or
    // legacy-unmarked baseline is NOT (#857: preflight used to write image
    // estimates back into lastInputTokens, which permanently closed this
    // hatch on pixel-billing upstreams). With evidence present we trust the
    // estimate and fall through to fold / fail-fast below.
    const noOverflowEvidence = session.stats.lastInputTokens < limit || session.stats.lastInputTokensSource !== "usage";
    if (imageTokens > 0 && payloadEstimate >= limit && textEstimate < limit && noOverflowEvidence) {
        log("warn", `[${session.id}] image-dominated payload (~${textEstimate} text + ~${imageTokens} image tokens) exceeds window ${limit} by estimate only, no upstream overflow evidence — forwarding once so the upstream arbitrates billing (#496)`);
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
            log("warn", `[${session.id}] preflight target reached (~${tokenCount}) but the payload fits with no compressible ranges (~${payloadEstimate}/${limit}); forwarding as-is`);
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
    log("warn", `[${session.id}] context ${tokenCount} tokens reached preflight target ${compressionTarget} (model window ${limit}, model=${model}); preflight compressing before forward`);
    // #300: stamp the chain marker so a downstream bili skips these
    // summarization calls too (preflight always processes).
    const { upstreamUrl, headers, proxyUrl } = buildForwardTarget(req, opts, route, affinity, instanceId);
    const clientAbort = new AbortController();
    registerRequestAbort(res, clientAbort);
    res.on("close", () => {
        if (!res.writableEnded) clientAbort.abort();
    });
    const started = Date.now();
    let stopHold: (() => void) | undefined;
    const holdTimer = setTimeout(() => {
        stopHold = beginPreflightHold(res, prepared, log);
    }, preflightHoldGraceMs());
    holdTimer.unref();
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
                imageFloor: imageTokens,
                wireOverhead: overheadEstimate,
                unknownBaseline,
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
    if (result.compressedRanges > 0) {
        log("info", `[${session.id}] preflight compressed ${result.compressedRanges} range(s), ~${result.savedTokens} tokens saved (${tokenCount} → ${session.stats.lastInputTokens}) in ${Date.now() - started}ms; rebuilding payload`);
        const rebuilt = await runPrepare();
        // runPrepare re-incremented stats.requests; the rebuild is internal
        // to this single client request.
        session.stats.requests -= 1;
        const fits = unknownBaseline
            ? result.fitsWindow
            : estimateCoreMessages(rebuilt.processedMessages) + overheadEstimate + imageTokens < limit;
        if (fits) return rebuilt;
    } else if (unknownBaseline
        ? result.fitsWindow
        : estimateCoreMessages(prepared.processedMessages) + overheadEstimate + imageTokens < limit) {
        log("warn", `[${session.id}] preflight made no progress but the payload fits; forwarding as-is`);
        return prepared;
    }
    // The payload still overflows the window: fail fast with a diagnostic
    // error instead of forwarding a guaranteed-400 payload (#301).
    const f = result.failure;
    if (f?.kind === "aborted") {
        log("warn", `[${session.id}] preflight aborted (${f.detail}); not forwarding`);
        return { failFast: true, status: 0, message: f.detail, retryable: false, respond: false };
    }
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

/** #604: arm the emergency shrink after an upstream failure that will never
 *  report usage (relay/gateway 5xx, network-level failure). A failed turn
 *  produces no usage report, so session.stats.lastInputTokens — the input to
 *  every usage-driven trigger (preflight floor, nudge bands, the kernel's
 *  emergency nudge + tool-result truncate at truncate.threshold) — stays
 *  frozen at the last SUCCESSFUL turn's value. A client that retries verbatim
 *  therefore re-sends the identical payload into the identical rejection
 *  forever (the relay-5xx deadlock). Raising lastInputTokens to a local
 *  estimate of the wire body we just sent breaks the loop: the next prepare()
 *  lands in the kernel's emergency band and truncates large tool results
 *  server-side without model cooperation; the next successful usage report
 *  overwrites the armed value.
 *
 *  Deliberate exception to the "tokenCount must be real usage" invariant: the
 *  estimate RAISES the value only (a lower bound → compress earlier, never
 *  later), the kernel no-ops below its thresholds, and real usage overwrites
 *  it on success. markDirty is required because both call sites return before
 *  forward()'s trailing save — without it the arm is lost on restart. */
function armFailureShrink(prepared: Prepared, log: (level: string, msg: string) => void, reason: string): void {
    const s = prepared.session;
    let est: number;
    try {
        const text = typeof prepared.body === "string" ? prepared.body : prepared.body.toString("utf8");
        est = estimateTokensFast(text);
    } catch {
        return; // non-text body — nothing to estimate
    }
    if (!Number.isFinite(est) || est <= 0) return;
    if (est > s.stats.lastInputTokens) {
        s.stats.lastInputTokens = est;
        // #857: the body includes base64 images, so this estimate carries the
        // same b64/4 over-count as the preflight image floor — tag it so the
        // evidence-grade consumers (self-heal, #496 gate, retraction) skip it.
        s.stats.lastInputTokensSource = "estimate";
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
    const { upstreamUrl, headers, proxyUrl } = buildForwardTarget(req, opts, route, affinity, prepared !== null ? instanceId : undefined);
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
        const protocol = prepared?.protocol ?? route?.explicitProtocol ?? inferWireProtocol(req.url ?? "");
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
    }
    // #552: wire transform shared by ALL re-send paths (compress-retry loops
    // below) so re-sent bodies carry the same rewrite as the initial forward —
    // otherwise a developer-role 400 would hit mid-stream on the first retry.
    // Reads compatRoles at CALL time: a role learned mid-request (retry below)
    // applies to later re-sends within the same request.
    const wireTransform = compatProtocol || (steerCfg !== null && steerCfg.enabled)
        ? (b: Record<string, unknown>): Record<string, unknown> => {
            if (compatProtocol && compatRoles) applyCompatRolesJson(b, compatProtocol, compatRoles);
            if (steerCfg && steerCfg.enabled && steerProtocol) applyOutputSteeringJson(b, steerProtocol, steerCfg);
            return b;
        }
        : undefined;
    // Show the final proxied URL (where the request actually lands) as the
    // primary signal. The provider label is appended only for named routes —
    // zero-config requests have a single routing mode now, so the final
    // proxied URL is the only useful signal in the log.
    log("info", `forward ${req.method} → ${maskUrlForLog(upstreamUrl)}`);
    if (process.env.ACP_DEBUG && prepared) {
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
                const masked = /key|auth|token/i.test(k) ? s.slice(0, 8) + "..." + s.slice(-4) + ` (${s.length} chars)` : s.slice(0, 60);
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
            if (bodyDumpEnabled() && process.env.ACP_DUMP_REQ !== "0") {
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
                      const rawDir = process.env.ACP_RAW_DUMP_DIR || path.join(stateDir(), "raw");
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
    const init: Omit<RequestInit, "dispatcher"> & { dispatcher?: object } = {
        method: req.method ?? "GET",
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : wireBody,
    };
    if (dispatcher) init.dispatcher = dispatcher;
    // Must be created before fetchWithTimeout: the signal aborts the upstream
    // request when the client disconnects (IDE cancel), otherwise the proxy
    // keeps reading upstream and holds the per-session lock. Also passed to
    // the rewriter loop below so fetch and loop stop together.
    const clientAbort = new AbortController();
    registerRequestAbort(res, clientAbort);
    res.on("close", () => {
        if (!res.writableEnded) clientAbort.abort();
    });
    let upstreamResult: Awaited<ReturnType<typeof fetchWithTimeout>>;
    try {
        upstreamResult = await fetchWithTimeout(upstreamUrl, init, undefined, clientAbort.signal);
        recordUpstreamConnection(upstreamUrl, proxyUrl);
    } catch (error) {
        recordUpstreamConnection(upstreamUrl, proxyUrl, error);
        // #604: a network-level failure (socket reset, timeout abort) also never
        // reports usage — arm the emergency shrink like the 5xx branch below.
        if (prepared && req.method !== "GET" && req.method !== "HEAD") armFailureShrink(prepared, log, "network failure");
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
            const rejection = detectRoleRejection(upstreamResult.response.status, roleErrText);
            if (rejection && rejection.role !== "system") {
                // Learn-on-failure ladder — primary hop (#552: offending role →
                // "system") plus a SECOND-CHANCE hop (#583: → "user") fired only
                // when the system hop 400'd with a #377-class system-PLACEMENT
                // error (backend accepts the role name but forbids system off
                // index 0, so a mid-list developer→system still 400s). Each hop
                // rewrites the one offending role to a single target and forwards
                // exactly once; the sequence is fixed (never a loop), hard-capped
                // at original + 2 retries. Any other failure stops the ladder and
                // the original 400 passes through verbatim.
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
                    const providerKey = new URL(upstreamUrl).origin;
                    log("info", `[${prepared?.session.id ?? "passthrough"}] [compat] upstream rejected role "${rejection.role}" — auto-rewrote ${rewritten} message role(s) to "${target}", retry OK (remembered for this session only). To make permanent, add: {"providers":{"${providerKey}":{"compat":{"roles":{"${rejection.role}":"${target}"}}}}`);
                };
                type HopOutcome = "ok" | "placement-400" | "other";
                const hop = async (target: string): Promise<HopOutcome> => {
                    const fixed = applyCompatRoles(wb, cp, { [rejection.role]: target });
                    if (fixed.rewritten === 0) return "other";
                    let r: Awaited<ReturnType<typeof fetchWithTimeout>>;
                    try {
                        r = await fetchWithTimeout(upstreamUrl, { ...init, body: fixed.body }, undefined, clientAbort.signal);
                    } catch {
                        return "other"; // transport failure — keep the original 400
                    }
                    if (r.response.ok) {
                        upstreamResult.clearTimer();
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
                if ((await hop("system")) === "placement-400") await hop("user");
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
            // must fire. #857: a number the upstream itself stated is
            // usage-grade provenance (not a content estimate); a real
            // usage report on the next successful turn overwrites it.
            s.stats.lastInputTokens = info.window;
            s.stats.lastInputTokensSource = "usage";
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
                est = estimateTokensFast(rawBody ?? "");
            } catch { est = 0; }
            const arm = Math.max(0, Math.min(declared, Number.isFinite(est) ? est : declared));
            if (arm > 0) {
                s.stats.lastInputTokens = arm;
                s.stats.lastInputTokensSource = "usage";
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
                        const retried = await fetchWithTimeout(upstreamUrl, { ...init, body: refolded }, undefined, clientAbort.signal);
                        if (retried.response.ok) {
                            upstreamResult.clearTimer();
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
            armFailureShrink(prepared, log, `upstream ${upstream.status}`);
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
                emitStreamError(res, prepared.protocol, `upstream HTTP ${upstream.status}: ${snippet}`, (m) => loggerLog("info", m));
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
                const resolvedBuf = await resolveFakeCompletion(pluginBody, {
                    protocol: prepared.protocol,
                    body,
                    upstreamUrl,
                    reqHeaders: buildForwardHeaders(headers),
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
                            reqHeaders: buildForwardHeaders(headers),
                            proxyUrl,
                            dispatcher,
                            signal: clientAbort.signal,
                            log,
                            label: prepared.session.id,
                        }),
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
                            reqHeaders: buildForwardHeaders(headers),
                            proxyUrl,
                            dispatcher,
                            signal: clientAbort.signal,
                            log,
                            label: prepared.session.id,
                        }),
                    );
                }
            } else {
                await pipePluginJson(pluginBody, res, prepared.session, prepared.protocol);
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
                    reqHeaders: buildForwardHeaders(headers),
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
            const resolvedBuf = await resolveFakeCompletion(upstream.body, {
                protocol: prepared.protocol,
                body,
                upstreamUrl,
                reqHeaders: buildForwardHeaders(headers),
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
                        reqHeaders: buildForwardHeaders(headers),
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
                        reqHeaders: buildForwardHeaders(headers),
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
                        reqHeaders: buildForwardHeaders(headers),
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
            const absorbActive = absorbEnabled(config) && opts.compress.injectTool && !textProtocol;
            const loopConfig = { ...(absorbActive ? config : { ...config, absorb: undefined }), ...(ccrEnabled(prepared.session) ? {} : { ccr: undefined }) };
            const absorbSection = absorbActive
                ? `\n\n---\n\n${buildAbsorbSystemPrompt(absorbToolName(loopConfig))}`
                : "";
            const visibilityMarkers = resolveCompress(opts.routes, route?.rewrittenUrl, (parsedReq as { model?: string }).model, opts.compress).visibilityMarkers ?? true;
            const systemPrompt = withConversationIdNote(withMarkerIntegrityNote(withSummaryBudgetNote(textProtocol ? buildCompressHybridSystemPrompt(prepared.prompts ?? defaultPrompts, prepared.surface?.promptSections) : buildCompressSystemPrompt(prepared.prompts ?? defaultPrompts, prepared.surface?.promptSections)), visibilityMarkers), ensureCanonicalId(prepared.session)) + absorbSection;
            const adapter = pickAdapter(prepared.protocol, parsedReq, textProtocol, prepared.responsesProjection, prepared.anthropicSystem, prepared.openaiSystemText, absorbActive ? absorbToolName(loopConfig) : undefined, prepared.google, prepared.systemNotes);
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
                        tokenCount: prepared.session.stats.lastInputTokens,
                        renderTags: prepared.renderTags ?? "text-only",
                        contentStore: contentStoreOf(prepared.session),
                    });
                    prepared.session.state = turn.state;
                    adoptContentStore(prepared.session, turn.contentStore);
                    const viewed = applyAbsorbView(turn.messages, turn.state, loopConfig, prepared.session.stats.lastInputTokens);
                    const records = current.filter((m) => typeof m.id === "string" && m.id.startsWith("acp_loop_"));
                    const out = stripKernelSummaries([...viewed, ...records] as BiliMessage[], turn.state);
                    // [#1095] the folded re-request must carry the SAME bytes the
                    // model saw (deterministic encode + per-fingerprint cache).
                    await applyImageCompressionPass(prepared.session, out, { config: loopConfig, billing: imageBillingFor(opts, route?.rewrittenUrl), log: ctx.log });
                    const imgNote = imageFullTrailingNote(prepared.session);
                    if (imgNote) out.push({ id: "bili_image_full_note", role: "user", contentType: "text", text: imgNote });
                    return repairResponsesAssistantOrdering(out, prepared.originalMessages);
                });
            };
            const loop = runCompressLoop(
                streamToRead,
                { core, config, messages: prepared.processedMessages.length > 0 ? prepared.processedMessages : prepared.originalMessages, compressMessages: prepared.originalMessages, session: prepared.session, log: ctx.log, proxyUrl, protocol: prepared.protocol, textProtocol, debug: opts.debug, refreshFolded, visibilityMarkers },
                parsedReq,
                { url: upstreamUrl, headers: reqHeaders, wireTransform },
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
            emitStreamError(res, prepared.protocol, (e as Error)?.message ?? String(e), (m) => log("error", `[${prepared.session.id}] ${m}`));
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
                        { url: upstreamUrl, headers: requestHeaders, wireTransform },
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
                if (typeof total === "number") {
                    prepared.session.stats.inputTokens += total;
                    // lastInputTokens = true TOTAL context (protocol-correct),
                    // net of this turn's compress savings (see stream.ts
                    // applyRanges — the fold lands on the NEXT request).
                    prepared.session.stats.lastInputTokens = Math.max(
                        0,
                        total - (prepared.session.stats.compressCreditTokens ?? 0),
                    );
                    prepared.session.stats.lastInputTokensSource = "usage";
                    // #1110: a real usage report retires the one-shot overflow arm.
                    delete prepared.session.stats.overflowArmTokens;
                    if (typeof cached === "number") {
                        prepared.session.stats.cachedTokens += cached;
                        prepared.session.stats.cacheSamples += 1;
                    }
                    const out = usageOutputTotal(prepared.protocol, u);
                    if (typeof out === "number") prepared.session.stats.outputTokens += out;
                }
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
async function resolveFakeCompletion(
    stream: ReadableStream<Uint8Array>,
    opts: {
        protocol: WireProtocol;
        body: string | Buffer;
        upstreamUrl: string;
        reqHeaders: Record<string, string>;
        proxyUrl?: string;
        signal: AbortSignal;
        session: Session;
        log: (level: string, msg: string) => void;
    },
): Promise<Buffer> {
    let buffer = await readStreamToBuffer(stream, fakeBufCap());
    const max = maxFakeCompletionRetries();
    const sid = opts.session.id;
    const priorStreak = (opts.session.metadata.fakeCompletionStreak as number | undefined) ?? 0;
    if (max > 0 && priorStreak < max && isFakeCompletion(opts.protocol, buffer.toString("utf8"))) {
        for (let attempt = 1; attempt <= max && !opts.signal.aborted; attempt++) {
            const hinted = injectFakeCompletionHint(opts.protocol, opts.body);
            if (hinted === null) break;
            opts.log("warn", `[${sid}] fake completion (tool-call XML, no tool block); retry ${attempt}/${max} with corrective hint`);
            let r: Awaited<ReturnType<typeof fetchWithTimeout>>;
            try {
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

/** Derive a short human-readable title from the first user text message.
 *  Used so the web UI can show "Fix auth bug" instead of an opaque hash. */
function deriveTitle(messages: CoreMessage[]): string | undefined {
    for (const m of messages) {
        if (m.role !== "user" || m.contentType !== "text") continue;
        const clean = (m.text ?? "").replace(/\s+/g, " ").trim();
        if (clean) return clean.length > 60 ? clean.slice(0, 57) + "\u2026" : clean;
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
    opts.compress = loadOptions().compress;
    opts.compat = loadOptions().compat;
    opts.imageBilling = loadOptions().imageBilling;
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
    res.end(JSON.stringify({ reports: sessions.map((s) => ({ id: s.id, report: buildSessionCacheReport(s) })) }, null, 2));
}

function sendStats(res: http.ServerResponse): void {
    const sessions = listSessions().map((s) => ({
        id: s.id,
        protocol: s.meta.protocol,
        upstream: s.meta.upstreamOrigin,
        label: s.meta.label,
        title: s.meta.title,
        requests: s.stats.requests,
        contextTokens: s.stats.contextTokens,
        inputTokens: s.stats.inputTokens,
        cachedTokens: s.stats.cachedTokens,
        outputTokens: s.stats.outputTokens,
        cacheSamples: s.stats.cacheSamples,
        cacheHitPct: s.stats.cacheSamples > 0 && s.stats.inputTokens > 0 ? Math.round(s.stats.cachedTokens / s.stats.inputTokens * 100) : null,
        // #901: window credibility — trusted (configured/registry) window vs the
        // largest input recent successful turns actually got through. A wide gap
        // means the provider overstates its window.
        contextWindow: typeof s.metadata.effectiveContextLimit === "number" ? s.metadata.effectiveContextLimit : undefined,
        lastSeen: new Date(s.lastSeen).toISOString(),
        restored: s.restored === true,
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions, blindTunnels: getBlindTunnelStats(), unrecognizedPaths: getUnrecognizedPathStats() }, null, 2));
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
    res.end(JSON.stringify({ version: VERSION, diskVersion, stale, autoRestartOnUpdate: opts.autoRestartOnUpdate, inFlight: totalInFlight() }, null, 2));
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
    log("info", `[${sessionId}] request: ${msgs ?? "?"} msgs, inbound=${formatBytes(inboundBytes)}${outboundField}, local=${ms}ms`);
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
export { isSideRequest, outputBudgetField, restoreOutputBudget, sideRequestGuard, type OutputBudgetField } from "./server/side-request.js";
export { countSystemAndToolsTokens, estimateInputTokens, estimateWireOverhead, clampOutputBudget, emergencyNudge, projectThinkingMass, type ThinkingMassInput } from "./server/budget.js";
