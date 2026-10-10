// #1440 P2 cut 4: upstream relay zone (forward) extracted verbatim from src/server.ts — pure move, zero behavior change.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { type CompressionCore, type Config, type CoreMessage, defaultCountTokens, defaultPrompts, resolveOutputSteeringConfig } from "acp-kernel";
import { type BiliMessage } from "acp-kernel/wire";
import { absorbToolName, applyAbsorbView } from "../absorb.js";
import { APIG_RESIGN_CREDENTIAL_HEADER, APIG_RESIGN_HEADER, APIG_RESIGN_SCHEME, decodeApigCredential, resignApig } from "../apig-resign.js";
import { credentialFingerprint, noteClientAbort, noteForwardedBody, noteForwardedImageFacts, settleUsageReport } from "../cache-ledger.js";
import { warnCacheCollapse } from "../cache-warn.js";
import { stampOutbound } from "../chain-checkpoint.js";
import { applyCompatDropFields, dropCompatFieldsJson, resolveCompatDropFields } from "../compat-drop.js";
import { applyCompatRoles, applyCompatRolesJson, detectRoleRejection, detectSystemPlacementError, hasOffHeadSystem, resolveCompatRoles, type CompatRoles } from "../compat-roles.js";
import { compressLoopResponsesJson } from "../compress-loop-responses.js";
import { resolveCompress } from "../compress-settings.js";
import { buildAbsorbSystemPrompt, buildCompressHybridSystemPrompt, buildCompressSystemPrompt, withMarkerIntegrityNote, withSummaryBudgetNote } from "../compress-tool.js";
import { findRoute, resolveDeclaredProtocol, type ProxyOptions } from "../config.js";
import { makeContinuationRefetch } from "../degenerate-retry.js";
import { dumpRejectedBody } from "../error-dump.js";
import { externalSummaryEnabled } from "../external-summary-surface.js";
import { fakeBufCap, injectFakeCompletionHint, isFakeCompletion, maxFakeCompletionRetries } from "../fake-completion.js";
import { fetchWithTimeout, fetchWithTransportRetry } from "../fetch-util.js";
import { currentFetchTransport } from "../fetch-transport.js";
import { applyImageCompressionPass, imageFullTrailingNote, imageUsageSuffix } from "../image-compress.js";
import { countImagesInRawBody, upstreamHost } from "../image-tokens.js";
import { log as loggerLog } from "../logger.js";
import { dumpReqAllowed as knobDumpReqAllowed, rawDumpDir as knobRawDumpDir } from "../knobs.js";
import { gcDumpDirIfConfigured } from "../state-gc.js";
import { applyLaneCredential, laneCredential } from "../lane-credentials.js";
import { CREDENTIAL_HEADER_RE, maskHeaderForLog, maskHeadersForLog, maskUrlForLog } from "../log-mask.js";
import { pickAdapter, runCompressLoop } from "../loop/index.js";
import { ABSORB_INSTRUCTION_MARKER, containsToolCallXmlFragment } from "../loop/tag-echo-filter.js";
import { dumpsDir } from "../paths.js";
import { pipePluginChatWithStrip, pipePluginJson, pipePluginResponsesWithStrip, type UpstreamMeta } from "../plugin.js";
import { estimateCoreMessages } from "../preflight.js";
import { reasoningGuardEngages, runReasoningGuard } from "../reasoning-guard.js";
import { wrapStreamWithRunawayGuard } from "../runaway-guard.js";
import { diagnoseSuccessWithoutUsage, markDirty, markNativeCompactionBoundary, withSessionLock, type Session } from "../session.js";
import { adoptContentStore, ccrLoopConfig, commitRetrievalNotes, commitRetrievals, contentStoreOf, dropRetrievals } from "../store.js";
import { emitStreamError } from "../stream-error.js";
import { rewriteGoogleJsonResponseAsync } from "../stream-google.js";
import { rewriteOpenaiJsonResponseAsync } from "../stream-openai.js";
import { rewriteResponsesJsonResponseAsync } from "../stream-responses.js";
import { observeResponsesTerminalState } from "../stream-terminal.js";
import { rewriteJsonResponseAsync, type RewriteCtx } from "../stream.js";
import { safePrefix, safeSuffix, scrubLoneSurrogatesOnWire } from "../text-safe.js";
import { clearUpstreamAlertsForHost, recordUpstreamAlert } from "../upstream-alerts.js";
import { formatUpstreamError, proxyDispatcher, recordUpstreamConnection } from "../upstream-proxy.js";
import { applyEstimateCalibration, currentCalibrationFactor, inspectContextOverflow, normalizeUpstreamOrigin, usageOutputTotal, usageTotals, type ContextOverflowInfo, type WireProtocol } from "../util.js";
import { applyOutputSteering, applyOutputSteeringJson } from "../output-steering.js";
import { estimateWireOverhead } from "./budget.js";
import { buildForwardHeaders, connectionNamedHeaders, RESPONSE_ONLY_STRIP_HEADERS, safeSessionId, UPSTREAM_HOP_HEADERS } from "./headers.js";
import { bodyDumpEnabled, logDumpFailure } from "./observability.js";
import { effectiveAbsorbBlock } from "./prepare-responses.js";
import { awaitDrain, bufferToStream, dumpStreamToFile, pipeThrough, readStreamToBuffer } from "./stream-io.js";
import { buildForwardTarget, outboundPayloadBreakdown, registerRequestAbort, beginStreamKeepalive, effectiveTokenCount, googlePathKind, imageBillingFor, imageTokenCapFor, outboundContextEstimates, repairResponsesAssistantOrdering, resignSettingsFor, resolveUpstream, stripKernelSummaries, usageGradeInputBaseline, type Prepared } from "../server.js";

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
        // The error path returns before forward()'s trailing markDirty — the
        // arm must schedule its OWN save or it is lost on restart.
        markDirty(s);
        log("warn", `[${s.id}] ${reason} with no usage report — armed emergency shrink with local estimate ${est} tokens`);
    }
}

export async function forward(
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
                    fs.writeFileSync(out, pretty);
                } catch {
                    fs.writeFileSync(out, wireText);
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
            gcDumpDirIfConfigured(path.dirname(rawBase));
        } catch (err) { logDumpFailure("REQ dump", err); }
    }
    const dispatcher = proxyDispatcher(proxyUrl);
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
        const est = outboundContextEstimates(prepared, sentBody, opts, upstreamUrl, sentParsed);
        prepared.session.stats.localInputEstimate = est.upperBound;
        // The char-count upper bound stays the published context value: it is
        // the fail-closed caliber decision paths and legacy displays trust for
        // never-reporting upstreams (#553/#728/#1493). #2117 additionally
        // publishes the billing-caliber estimate of THIS send — preflight's own
        // formula (CJK-aware text + wire overhead), k̂-scaled only where the
        // factor's route+model provenance matches (#1933 F1 / #2117 B), plus
        // the image reserve — so display surfaces can show a calibrated reading
        // instead of the ~2–3.5× over-counting bound. Display-only field.
        const kFactor = currentCalibrationFactor(prepared.session.stats, prepared.session.metadata?.lastModel);
        const scaledText = applyEstimateCalibration(est.textOverhead, kFactor, prepared.session.stats.calibratedEstimateOrigin, normalizeUpstreamOrigin(upstreamUrl));
        prepared.session.stats.contextEstimateTokens = Math.round(scaledText + est.imageTokens);
        prepared.session.stats.contextEstimateCalibrated = scaledText !== est.textOverhead;
        prepared.session.stats.contextTokens = est.upperBound;
        prepared.session.stats.contextTokensSource = "estimate";
        // #2131: exact message count for seam forensics (sentParsed is the one
        // shared parse above — Responses carries "input", Google native "contents").
        const sentArr = sentParsed !== null ? (sentParsed.messages ?? sentParsed.input ?? sentParsed.contents) : null;
        noteForwardedBody(prepared.session, sentBody, Array.isArray(sentArr) ? (sentArr as unknown[]).length : null, credentialFingerprint(headers));
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
        // #2465: tag the classified transport envelope so the dispatch catch
        // logs it as ONE line — formatUpstreamError already carries
        // kind/code/errno/syscall/address/port/hint; the stack adds no signal.
        throw Object.assign(new Error(`upstream request failed: ${formatUpstreamError(error, upstreamUrl, proxyUrl)}`, { cause: error }), { biliTransportFailure: true });
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
            // #2313: the rejection came from THIS upstream — stamp the
            // evidence origin so the #1933 F2 route gate (and the #2313
            // probe-forward gate) treat the arm as current-route evidence
            // instead of demoting it against a stale settle origin.
            s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(upstreamUrl);
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
                s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(upstreamUrl); // #2313: same-route evidence, see the window branch above
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
                        // #816 family: the refold rebuilds the body from state
                        // summaries — scrub string bodies again so a lone
                        // surrogate can't poison the retry (see the #1884 seam).
                        const wireRefolded = typeof refolded === "string" ? scrubLoneSurrogatesOnWire(refolded) : refolded;
                        applyResign(headers, wireRefolded);
                        const retried = await fetchWithTimeout(upstreamUrl, { ...init, body: wireRefolded }, undefined, clientAbort.signal);
                        if (retried.response.ok) {
                            upstreamResult.clearTimer();
                            wireBody = wireRefolded; // #1900: track the accepted re-send as the wire base
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
            const info = inspectContextOverflow(upstream.status, errBody.toString("utf8"));
            if (info.isOverflow) {
                armOverflowShrink(info);
            }
            // #762: learn strict-echo on the MAIN request path too. The loop-only
            // learner (src/loop/core.ts) never sees client-originated 400s, so a
            // first post-fold rejection left strictReasoningEcho unset — #651 kept
            // dropping reasoning and every following turn split again.
            // #2169: match BOTH field spellings — the chat wire says
            // reasoning_content, DeepSeek's Responses wire says reasoning_text.
            if (upstream.status === 400 && /reasoning_(?:content|text)/i.test(errBody.toString("utf8"))) {
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
                    log("error", `[${prepared.session.id}] runaway enumeration detected (${v.reason}; ${JSON.stringify(v.detail)}) — aborting upstream stream`);
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
                    );
                }
            } else {
                await pipePluginJson(pluginBody, res, prepared.session, prepared.protocol, targetOrigin, absorbInstructed, wireBodyText);
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
                    undefined,
                    undefined,
                    undefined,
                    upstreamMeta,
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
            log("error", `[${prepared.session.id}] runaway enumeration detected (${v.reason}; ${JSON.stringify(v.detail)}) — aborting upstream stream`);
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
            const visibilityMarkers = resolveCompress(opts.routes, route?.rewrittenUrl, (parsedReq as { model?: string }).model, opts.compress).visibilityMarkers ?? true;
            const systemPrompt = withMarkerIntegrityNote(withSummaryBudgetNote(textProtocol ? buildCompressHybridSystemPrompt(prepared.prompts ?? defaultPrompts, prepared.surface?.promptSections) : buildCompressSystemPrompt(prepared.prompts ?? defaultPrompts, prepared.surface?.promptSections), externalSummaryEnabled(config)), visibilityMarkers) + absorbSection;
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
                responseBody,
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
                    await withSessionLock(prepared.session, () => rewriteOpenaiJsonResponseAsync(json, ctx, clientAbort.signal));
                } else if (prepared.protocol === "responses") {
                    await withSessionLock(prepared.session, () => rewriteResponsesJsonResponseAsync(json, ctx, clientAbort.signal));
                } else if (prepared.protocol === "google") {
                    await withSessionLock(prepared.session, () => rewriteGoogleJsonResponseAsync(json, ctx, clientAbort.signal));
                } else {
                    await withSessionLock(prepared.session, () => rewriteJsonResponseAsync(json, ctx, clientAbort.signal));
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
