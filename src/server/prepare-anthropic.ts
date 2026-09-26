// Anthropic protocol prepare pipeline (extracted verbatim from
// src/server.ts — #1440 P2 four-cut disassembly, cut 2).

import { applyAbsorbView, storeEffectiveAbsorb } from "../absorb.js";
import { stripAcpPanelMessages, stripAcpStatusMarkers } from "../acp-panel.js";
import { ABSORB_TOOL_NAME, IMAGE_FULL_TOOL, RULE_TOOL, absorbToolsFor, retrieveToolsFor, withMarkerIntegrityNote, withStagedCompressGuidance, withSummaryBudgetNote } from "../compress-tool.js";
import { ProxyOptions } from "../config.js";
import { recordConflict } from "../conflict-watch.js";
import { applyImageCompressionPass, imageCompressionEnabled, imageFullTrailingNote } from "../image-compress.js";
import { imageTokensInParsedBody } from "../image-tokens.js";
import { estimateCoreMessagesUpper } from "../preflight.js";
import { CompressReasoningConfig } from "../reasoning-drop.js";
import { rulesEnabled, storeEffectiveRules } from "../rules-feature.js";
import { countSystemAndToolsTokens, emergencyNudge, projectThinkingMass } from "../server/budget.js";
import { PendingRetrieval, REWRITE_MIN_INCOMING_TOTAL, Session, applyCompactionArchive, detectUnannouncedHistoryRewrite, ensureCanonicalId, foldCoverage, markCompactionBoundary, markDirty, snapshotMessages } from "../session.js";
import { adoptContentStore, ccrEnabled, ccrLoopConfig, contentStoreOf, dropRetrievals, flushRetrievalNotes, pruneExpiredRetrievals, reconcileReloadedRetrievals, retrieveToolName, snapshotPendingRetrievals } from "../store.js";
import { isStrictReasoningEcho, modelIdOf } from "../strict-echo.js";
import { reconcileSystemAnchor } from "../system-anchor.js";
import { CompressionCore, Config, CoreMessage, NudgeDecision, PackSurface, Prompts, renderNudgeText, viableRanges } from "acp-kernel";
import { AnthropicRequestBody, BiliMessage, anthropicToCore, buildSystem, coreToAnthropic, extractSystem } from "acp-kernel/wire";
import http from "node:http";
import { injectSystem, injectTool } from "./inject.js";
import { Prepared, deriveTitle, diagNudge, diagTagSummary, effectiveAbsorbBlock, effectiveTokenCount, imageBillingFor, reapOrphansLogged, stripKernelSummaries, withReasoningDrop } from "./prepare-shared.js";

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

export async function prepareAnthropic(
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
    let attachedRetrievals: PendingRetrieval[] = [];
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
        // #1195: pre-turn snapshot of the fold's covered ids — syncBlocks inside
        // processTurn may deactivate fully-drifted blocks, erasing them.
        const foldCoveredBefore = session.stats.pendingFoldUsage === true
            ? new Set(session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])))
            : null;
        const turn = core.processTurn({ messages: msgs, state: session.state, config: loopConfig, tokenCount, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only", contentStore: contentStoreOf(session) });
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
                recordConflict(session, "unannounced-rewrite", `${rewrite.knownIncoming}/${rewrite.incomingTotal} incoming message(s) carry pre-turn refs of ${rewrite.knownBefore} known`);
                markCompactionBoundary(session);
            }
        }
        applyCompactionArchive(session, activeBefore, new Set(msgs.map((m) => m.id)), log);
        reapOrphansLogged(session, msgs, log, sessionId);
        // [#1095] downscale screenshot-like images ONCE at arrival (kernel routing
        // decision + recipe; originals cached for the image_full restore channel).
        // Deterministic encode ⇒ re-runs are byte-stable for the prefix cache.
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, upstreamOrigin), log });
        // [#1271/#1343] plugin mode: acp_retrieve already acked via the tool API; snapshot
        // the queued full text onto THIS forward (stays in the queue until commit/drop, so an
        // upstream failure drops-and-logs it instead of vanishing it).
        if (pluginMode && ccrEnabled(session)) {
            reconcileReloadedRetrievals(session);
            pruneExpiredRetrievals(session);
            attachedRetrievals = snapshotPendingRetrievals(session);
            if (attachedRetrievals.length > 0) processedMessages = [...processedMessages, ...attachedRetrievals.map((i) => i.injection)];
        }
        rebuiltMessages = coreToAnthropic(processedMessages as BiliMessage[], cacheControls);
        if (sysNotes.length > 0) {
            rebuiltMessages = [...rebuiltMessages, ...sysNotes.map((text) => ({ role: "user" as const, content: text }))];
        }

        systemOut = injectSystem(parsed, opts, prompts, loopConfig, ensureCanonicalId(session), surface, visibilityMarkers);
        if (injectTools) {
            toolsOut = injectTool(parsed.tools, [...(absorbActive ? [absorbTools.anthropic] : []), ...(rulesActive ? [RULE_TOOL] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).anthropic] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL] : [])], surface?.toolPrompts);
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
        // [#1343] surface any earlier undelivered retrieve as an ephemeral trailing
        // user note (kept last so it never reorders cached messages).
        const retrNote = flushRetrievalNotes(session);
        if (retrNote) rebuiltMessages = [...rebuiltMessages, { role: "user", content: retrNote }];
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
        + imageTokensInParsedBody("anthropic", rebuilt, imageBillingFor(opts, upstreamOrigin));
    return { body: JSON.stringify(rebuilt), session, attachedRetrievals, processedMessages, originalMessages, anthropicSystem: parsed.system, systemNotes: sysNotes, protocol: "anthropic", stream, compressInjected: injectTools, pluginMode, nudge, prompts, surface, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only" } as Prepared;
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
        const turn = core.processTurn({ messages: msgs, state: session.state, config: ccrLoopConfig(session, config), tokenCount: session.stats.lastInputTokens, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only", contentStore: contentStoreOf(session) });
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
