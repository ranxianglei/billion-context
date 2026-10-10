// #1440 P2 cut 3: proxy request pipeline (handle) extracted verbatim from src/server.ts — pure move, zero behavior change.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { defaultPrompts, type CompressionCore, type Config, type PackSurface, type Prompts } from "acp-kernel";
import { conversationSignalAnthropic, conversationSignalGoogle, conversationSignalOpenai, conversationIdentityResponses, conversationSignalResponses, stripHistoricalImages, type AnthropicRequestBody, type GoogleRequestBody, type OpenAIRequestBody, type ResponsesRequestBody } from "acp-kernel/wire";
import { DEFAULT_STRIP_IMAGES_KEEP_RECENT, resolveCompress, resolveCompressPrompts, resolveCompressSurfaceDetailed, resolveRequestConfig } from "../compress-settings.js";
import { FALLBACK_EFFECTIVE_WINDOW_FLOOR, findRoute, findRouteKey, lookupContextLimit, resolveConfiguredContextLimit, resolveConfiguredOutputLimit, resolveCompressProtocol, resolveDeclaredProtocol, type ProxyOptions } from "../config.js";
import { resolveProxyDecision } from "../upstream-proxy.js";
import { contextFromRegistry, peekRegistryContext, peekRegistryOutputLimit, peekRegistryPriceProfile } from "../registry.js";
import { codexAlignedWindow } from "../codex-models.js";
import { MAX_REQUEST_BYTES } from "../fetch-util.js";
import { hostIdForLog, maskHeadersForLog, maskUrlForLog, maskUrlsInText } from "../log-mask.js";
import { buildIncomingImageIndex, foldAnchoredCutoff, pruneRetrieveImgExports } from "../image-restore.js";
import { durableMessageGuards } from "../durable-message-guards.js";
import { biliToolsDeclaredOnWire, countBiliToolUses, evaluateSelfHealRound, nudgeSuppressed, pluginLaneDegraded, pluginLaneRestore } from "../session-self-heal.js";
import { compressBreakerArmed } from "../stream.js";
import { acquireInFlight, getSession, hasProcessedState, markDirty, peekSession, releaseInFlight, storeEffectiveConfig, tickPostRebuildAnchor, withSessionLock, type Session } from "../session.js";
import { buildCompressSystemPrompt } from "../compress-tool.js";
import { storeEffectiveImageCompression, type ImageCompressionSettings } from "../image-compress.js";
import { storeEffectiveSearchPlanAware } from "../decompress-shared.js";
import { externalSummaryEnabled } from "../external-summary-surface.js";
import { estimateRawBodyTokens } from "../preflight.js";
import { imageTokensInParsedBody } from "../image-tokens.js";
import { APIG_RESIGN_CREDENTIAL_HEADER, APIG_RESIGN_HEADER, APIG_RESIGN_SCHEME, clearSignedRefusal, decodeApigCredential, inboundSignedScheme, recordSignedRefusal, signedRefusal } from "../apig-resign.js";
import { conflictScanEnabled, isDesignBenign, scanClientPlugins, sniffScanClient } from "../thirdparty-scan.js";
import { recordConflict } from "../conflict-watch.js";
import { getStore } from "../persist.js";
import { enterSessionContext, log as loggerLog } from "../logger.js";
import { codexCompactGatePre, codexCompactMode, hasCompactionTrigger, isCodexClient, replaceBiliCompactionItems } from "../codex-compact.js";
import { emitPreflightError } from "../stream-error.js";
import { agentProviderRecipes } from "../agent-providers.js";
import { affinityToken, conversationHeaderSource, claudeSubagentAgentId, claudeSubagentSplit, clientConversationHeader, codexTurnIdentity, dshPersonaFingerprintApplies, instructionsFingerprintApplies, openaiSystemTextForPersona, preferPromptCacheKeyIdentity } from "../session-id.js";
import { personaNamespace } from "../persona-anchor.js";
import { prefixAffinity, type AnonymousAffinity } from "../prefix-affinity.js";
import { maybeAdoptForkBlocks, maybeAdoptResume } from "../fork-adoption.js";
import { resolveClaudeTranscriptLineage } from "../claude-transcript-lineage.js";
import { consumePluginRegisterFor, pluginAgentHeader, pluginConversationHeader, pluginHeadersMatchModel, pluginReportedContextWindow, pluginReportedMaxOutput, pluginRequestAgentHeader, pluginRuntimeInfoFor, pluginRuntimeInfoForConversation, publicForkInputMatches, recordChainVerdict, recordPluginSession, rememberPluginMessages, resolveConversation, runtimeConversationId, takePendingPluginRegister } from "../plugin.js";
import { scheduleAffinityPersist } from "../affinity-persist.js";
import { evaluateChain, extractChainCarriers } from "../chain-checkpoint.js";
import { BILI_PASSTHROUGH_HEADER, BILI_PLUGIN_BYPASS_HEADER, isLoopbackAddress, reserveOutputHeadroom, resolveOutputHeadroomCap, shouldReserveOutputHeadroom, type WireProtocol } from "../util.js";
import { checkTunnelDestination, tunnelAllowlistFromEnv } from "../tunnel-guard.js";
import { resolveCompatDropFields } from "../compat-drop.js";
import { DecompressedTooLargeError, decodeRequestBody } from "../content-encoding.js";
import { noInjectTool as knobNoInjectTool, rawDumpDir as knobRawDumpDir } from "../knobs.js";
import { anthropicBetaContextWindow, BILI_HOP_HEADER, capRegistryWindowByStandard, expandedContextSuffixWindow, launcherContextWindow, launcherMaxOutput, windowSourceLogged } from "./context-window.js";
import { NO_IDENTITY_MESSAGE, safeSessionId } from "./headers.js";
import { demoteGate, hasLeakedBiliToolsOnly, isServerToolUtilityCall, isSideRequest, resolveSideLane, restoreOutputBudget, sideRequestGuard, stripLeakedBiliTools } from "./side-request.js";
import { DSH_COMPACTION_SHAPE_MSGS, dshCompactionRefusal, isDshCompactionCall } from "./dsh-compaction-guard.js";
import { emergencyNudge } from "./budget.js";
import { artifactSeedHit, detectAcpArtifacts } from "./chain-artifacts.js";
import { piSubagentChannelFallback } from "./pi-subagent-channel.js";
import { FORCE_TEXT_PROTOCOL } from "./inject.js";
import { prepareAnthropic } from "./prepare-anthropic.js";
import { prepareOpenai } from "./prepare-openai.js";
import { prepareGoogle, prepareGoogleCountTokens } from "./prepare-google.js";
import { prepareResponses, prepareResponsesCompact } from "./prepare-responses.js";
import { bodyDumpEnabled, isModelDiscoveryPath, logDumpFailure, logUnrecognizedPath } from "./observability.js";
import { handleAdminRoute } from "./admin.js";
import { ccrPluginWireOk, storeEffectiveCcr, type CcrSettings } from "../store.js";
import { DEFAULT_DECIDE_MAX_TOKENS } from "../nudge-decide.js";
import { BodyTooLargeError, forward, forwardUpstreamUrl, googleModelFromPath, googlePathKind, headroomEffectiveLogged, headroomFallbackLogged, headerValue, imageBillingFor, imageReserveFor, imageTokenCapFor, isCountTokensRequest, isPreflightFailFast, logRequestCost, NON_CONVERSATION_RELAY_WARN_CAP, nonConversationRelayWarned, prepareCountTokens, preflightCompressIfNeeded, readBody, resolveKnownOutputCeiling, resolveUpstream, resignSettingsFor, scrubAnthropicPck, scrubCompatDrop, warnRouteMissIfNew, type Prepared } from "../server.js";

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
            // #321 PR-E1: a codex client carries its OWN window perception and
            // auto-compacts at 90% of it. If bili's budget exceeds what codex
            // believes, codex's native compaction fires first — the #292
            // misalignment. Cap the effective window at codex's perception. For a
            // LOCAL codex peer (loopback) with no fresher report that perception
            // is read from this proxy's own CODEX_HOME live cache/base-config
            // (#2593); otherwise the release-time bundled table + 272K fallback.
            // An operator's explicit compress.modelContextLimit is exempt
            // (operator tuning is owned by the operator — never floored and
            // never clamped); the clamped value is authoritative for this
            // client (codex's own config), so it also clears the
            // low-confidence fallback flag.
            const localPeer = isLoopbackAddress(req.socket.remoteAddress);
            const aligned = operatorWindowTuned
                ? { limit: reqConfig.modelContextLimit, clamped: false }
                : codexAlignedWindow(reqConfig.modelContextLimit, model, req.headers, { localPeer });
            if (aligned.clamped) {
                const before = reqConfig.modelContextLimit;
                reqConfig = { ...reqConfig, modelContextLimit: aligned.limit };
                nativeFromFallback = false;
                windowShrinkReason = "codex";
                log("info", `[codex] effective window clamped ${before} → ${aligned.limit} (codex's own perception for model=${model}; ACP now compresses before codex's native auto-compact) upstream=${embeddedUrl ? hostIdForLog(embeddedUrl) : "none"} route=${routeLabel}`);
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
                  : dshPersona && !sideRequestLike
                    // #2241: continuity-aware anchor — a system change whose
                    // history continues the raw key's prefix-affinity chain
                    // (model switch) MIGRATES the anchor instead of forking
                    // the main lane off the raw key; only history-discontinuous
                    // requests (review blobs) still fork onto `|sub:<fp>`.
                    ? personaNamespace(
                          anthropicIdentity?.value ?? anthropicSignal,
                          personaSystemText,
                          (parsed as AnthropicRequestBody).messages,
                          log,
                      )
                    : anthropicIdentity?.value ?? anthropicSignal)
            : protocol === "openai"
              ? (dshPersona && !sideRequestLike
                    ? personaNamespace(
                          openaiIdentity?.value ?? openaiSignal,
                          personaSystemText,
                          (parsed as OpenAIRequestBody).messages,
                          log,
                      )
                    : openaiIdentity?.value ?? openaiSignal)
              : codexTurn
                // Trusted Codex turn id enters the verbatim session chain
                // directly — do NOT route it through subagentNamespace (the
                // kernel's empty-instructions non-anchoring path is left
                // untouched for metadata-less clients).
                ? codexTurn.value
                 : dshPersona && !sideRequestLike
                   // #2203/#2241: parity with the anthropic/openai lanes —
                   // dsh-over-Responses rides the same continuity-aware persona
                   // anchor: a model switch (history continues the raw key's
                   // chain) migrates the anchor on the raw key; a history-
                   // discontinuous auto-review blob forks onto `|sub:<fp>`.
                   // Must sit BEFORE the stableSystemAnchor branch below so a
                   // plugin request never takes the plain-proxy verbatim anchor.
                    ? personaNamespace(
                          responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader),
                          (parsed as ResponsesRequestBody).instructions ?? "",
                          (parsed as ResponsesRequestBody).input,
                          log,
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
                            personaNamespace(
                                responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader),
                                (parsed as ResponsesRequestBody).instructions ?? "",
                                (parsed as ResponsesRequestBody).input,
                                log,
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
              : protocol === "responses" && dshPersona
                // #2203: dsh-responses forks record under their suffixed id
                // (recordPluginSession keys on personaForked); without this
                // case a fork would record under the raw id and steal the
                // main session's entry from the single-valued conversations
                // map (#970). Scoped to dsh: codexTurn keys verbatim and
                // must keep personaForked false.
                ? (responsesIdentity?.value ?? conversationSignalResponses(parsed as ResponsesRequestBody, convHeader))
                : undefined;
        const personaForked = rawPersonaIdentity !== undefined && conversation !== rawPersonaIdentity;
        // #2170 measure 4: stamp sessions deliberately namespaced onto a
        // `|sub:` key — #970 claude subagents, #1916/#1307/#1314 dsh persona-
        // fork reviews, codex/claude-over-Responses instructions personas —
        // so the split-session canary can tell a DESIGNED split from the
        // #2165 drift shape (see splitSessionWarnings in src/session.ts).
        // personaForked covers the anthropic/openai wires plus dsh-over-
        // Responses (#2203); the explicit responses clause below stays for
        // the codex/claude instructions personas (codexTurn keys verbatim
        // and must not count).
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
        if (designNamespaced && session.metadata.personaNamespace !== true) session.metadata.personaNamespace = true;
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
            prefixAffinity.note(sessionId, anonAffinity.incomingDepth, anonAffinity.tailHash, anonAffinity.itemHashes, false, anonAffinity.sketches, anonAffinity.userFlags);
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
                const matched = derivedParent !== undefined
                    ? prefixAffinity.findResumeParentWithin(derivedParent, affinityMessageList(), sessionId)
                    : prefixAffinity.findResumeParent(affinityMessageList(), sessionId);
                if (matched) resume = { sessionId: matched.sessionId, sharedDepth: matched.sharedDepth, via: `${matched.sharedDepth} msg(s) byte-exact prefix` };
            }
            if (resume) {
                const resumeParent = loadParent(resume.sessionId);
                if (resumeParent && resumeParent !== session) {
                    session.metadata.derivedFrom = resumeParent.id;
                    session.metadata.derivedFromSessionId = resumeParent.id;
                    markDirty(session);
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
            restoreOutputBudget(parsed, session, log, resolveKnownOutputCeiling(req.headers, parsed as Record<string, unknown>, opts.routes, route?.rewrittenUrl, opts.sessionHeader));
        }
        // #896: the per-scope output-headroom cap (compress.outputHeadroomMaxPct,
        // three-level merge; default 0.25, aligned with billion-context-pi).
        // Resolved once here so the side-request guard below AND the main-path
        // reservation measure against the SAME capped window.
        const headroomCap = resolveOutputHeadroomCap(resolveCompress(opts.routes, route?.rewrittenUrl, (parsed as { model?: string }).model, opts.compress).outputHeadroomMaxPct);
        // #1729: dsh native compaction guard — a compaction summarize call
        // (replayed prefix + COMPACTION_INSTRUCTION as the final user message)
        // is refused BEFORE any pipeline work: not forwarded, kernel state
        // untouched. MARKER-DECISIVE since #2193: message count no longer gates
        // — rc.2 replays the full shadowed region (~1100+ msgs) and the old ≤4
        // bar made the guard silently pass through, letting a checkpoint land
        // and destroy the compression substrate. Protocol coverage (#2360):
        // openai + anthropic + responses lanes are all marker-decisive — the
        // pre-#2360 whitelist short-circuited responses (dsh desktop's actual
        // wire) before the marker was ever examined. Active by default, explicitly
        // opt-out-able (#2028) — auto pressure, overflow recovery, and manual
        // /compact share one envelope, and a landed checkpoint durably shadows
        // the raw history (irreversible), while every cost of refusing is
        // dsh-side, caught, and recoverable; allowDshCompaction lifts the
        // refusal for users who accept that trade. Runs before the #388
        // side-request lane: the compaction call is a full-budget request, so
        // only this guard can catch it.
        if (protocol !== null && opts.allowDshCompaction !== true && isDshCompactionCall(protocol, parsed)) {
            if (session.metadata.dshCompactionRefused !== true) {
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
            // retry. Consumed by dshLedgerFloorTokens() in budget.ts.
            const prevBytes = typeof session.metadata["dshCompactionRefusedBytes"] === "number" ? session.metadata["dshCompactionRefusedBytes"] as number : 0;
            session.metadata["dshCompactionRefusedBytes"] = Math.max(prevBytes, inboundBytes);
            session.metadata["dshCompactionRefusals"] = (typeof session.metadata["dshCompactionRefusals"] === "number" ? session.metadata["dshCompactionRefusals"] as number : 0) + 1;
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
        const sideIntent = isSideRequest(parsed, requestAgent);
        // #388/#2157 follow-up: side requests must not touch kernel state under
        // a public-fork receipt either. The receipt's first-request 409
        // discipline above has already accepted this request (inherited prefix
        // matched, or the child has live traffic), and a side request reads
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
        const sideLane = resolveSideLane({ countTokens, responsesCompact, protocol, stripApplied: demotedSide, sideIntent, requestAgent, sideLabel: serverToolUtility ? "server-tool utility call (#2500)" : undefined });
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
        // #2419: per-lane durable-state message guard (KDD#9 evidence-permitlist).
        // Stamp the CLONE-SAFE config first — a function inside
        // session.metadata.effectiveConfig would break fork-adoption structuredClone
        // and disk persistence — then attach it to this turn's reqConfig so
        // processTurn protects the message now. effectiveConfig() re-resolves the
        // guard from the lane id at read time, so /__bili/plugin/tool sees it too.
        storeEffectiveConfig(session, reqConfig);
        const durableGuard = pluginAgent ? durableMessageGuards[pluginAgent] : undefined;
        if (durableGuard !== undefined) reqConfig = { ...reqConfig, isMessageProtected: durableGuard };
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
                    const cs = resolveCompress(opts.routes, route?.rewrittenUrl, requestModel, opts.compress);
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
                    const keepRecent = cs.stripImagesKeepRecent ?? DEFAULT_STRIP_IMAGES_KEEP_RECENT;
                    // #1995 gap 2: when an active fold exists (anthropic only —
                    // see foldAnchoredCutoff for the id-stability proof), anchor
                    // the strip boundary to fold coverage instead of the sliding
                    // window so the stripped prefix is byte-stable between folds
                    // and the prompt cache survives turn-over-turn. Falls back to
                    // the sliding window when there is nothing to anchor to.
                    const anchoredCutoff = cs.stripImages && protocol
                        ? foldAnchoredCutoff(parsed, protocol, session.state)
                        : undefined;
                    const stripped = cs.stripImages
                        ? stripHistoricalImages(parsed, protocol, keepRecent, anchoredCutoff !== undefined ? { cutoffIndex: anchoredCutoff } : undefined)
                        : { body: parsed, removed: 0 };
                    // #1995: index recoverable historical images by ref from the UNSTRIPPED
                    // body before stripping drops them, so decompress({ imageRef }) can pull
                    // specific pixels back later. Gated on stripImages (recovery is only
                    // meaningful when stripping removes something); latest-wins per request.
                    // count_tokens requests skip the (pure bookkeeping) index rebuild but
                    // still strip with the same cutoff, so token counts stay representative
                    // of what the model turn would send. Eviction rides along (best-effort,
                    // throttled to once a minute).
                    if (cs.stripImages && protocol && !countTokens) {
                        session.incomingImageIndex = buildIncomingImageIndex(parsed, protocol, session.state, session.id);
                        if (session.lastImgPrune === undefined || Date.now() - session.lastImgPrune > 60_000) {
                            session.lastImgPrune = Date.now();
                            pruneRetrieveImgExports(session.id);
                        }
                    } else if (session.incomingImageIndex) {
                        session.incomingImageIndex = undefined;
                    }
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
                        return await prepareGoogle(work as GoogleRequestBody, opts, core, reqConfig, reqPrompts, reqSurface, log, session, pluginMode, nativeWindow, googleModel, googlePathKind(urlPath) === "stream-generate", visibilityMarkers, upstreamOrigin, req, decide);
                    }
                    return protocol === "anthropic"
                        ? await prepareAnthropic(work as AnthropicRequestBody, req, opts, core, reqConfig, reqPrompts, reqSurface, log, session, pluginMode, upstreamOrigin, reasoningCfg, visibilityMarkers, decide)
                        : protocol === "openai"
                          ? await prepareOpenai(work as OpenAIRequestBody, req, opts, core, reqConfig, reqPrompts, reqSurface, log, session, pluginMode, upstreamOrigin, nativeWindow, reasoningCfg, visibilityMarkers, route?.rewrittenUrl, decide)
                          : responsesCompact
                            // #618 review nit: when no bili compaction item is present,
                            // prepareResponsesCompact falls back to the raw bodyBuffer — forward
                            // the re-serialized post-strip work instead so dropped images don't
                            // ride along. Unchanged bodies keep the original buffer byte-identical.
                            ? prepareResponsesCompact(stripped.removed > 0 ? Buffer.from(JSON.stringify(work)) : bodyBuffer, work as ResponsesRequestBody, session, req, core, reqConfig, log)
                            : await prepareResponses(work as ResponsesRequestBody, req, opts, core, reqConfig, reqPrompts, reqSurface, log, session, responsesIdentity!, pluginMode, upstreamOrigin, nativeWindow, reasoningCfg, visibilityMarkers, route?.rewrittenUrl, decide);
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
                // #2155 self-heal round: one evaluation per request, on the
                // nudge-carrying prepared result (bypass lanes have nudge
                // undefined and the hook no-ops inside). Side requests
                // (title-gen etc.) never carry a nudge, so they cannot burn
                // zombie credit either.
                if (!selfHealRoundDone && prepared.nudge !== undefined) {
                    selfHealRoundDone = true;
                    evaluateSelfHealRound(session, {
                        pluginHeaderPresent: pluginAgentHeader(req.headers) !== undefined,
                        biliToolsDeclared: biliToolsDeclaredOnWire(parsed, protocol),
                        nudgeActive: opts.compress.injectNudge && !nudgeSuppressed(session) && !compressBreakerArmed(session) && (prepared.nudge.shouldInject || emergencyNudge(prepared.nudge, undefined, config.compress.minCompressRange)),
                        biliToolUses: countBiliToolUses(prepared.processedMessages),
                        degradeAvailable: opts.compress.injectTool && !knobNoInjectTool(),
                    }, log);
                }
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