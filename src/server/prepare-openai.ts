// OpenAI chat protocol prepare pipeline (extracted verbatim from
// src/server.ts — #1440 P2 four-cut disassembly, cut 2).

import { absorbToolName, applyAbsorbView, storeEffectiveAbsorb } from "../absorb.js";
import { stripAcpPanelMessages, stripAcpStatusMarkers } from "../acp-panel.js";
import { ABSORB_TOOL_NAME, IMAGE_FULL_TOOL_OPENAI, RULE_TOOL_OPENAI, absorbToolsFor, buildAbsorbSystemPrompt, buildCompressSystemPrompt, retrieveToolsFor, withConversationIdNote, withMarkerIntegrityNote, withStagedCompressGuidance, withSummaryBudgetNote } from "../compress-tool.js";
import { ProxyOptions } from "../config.js";
import { recordConflict } from "../conflict-watch.js";
import { applyImageCompressionPass, imageCompressionEnabled, imageFullTrailingNote } from "../image-compress.js";
import { imageTokensInParsedBody } from "../image-tokens.js";
import { estimateCoreMessagesUpper } from "../preflight.js";
import { CompressReasoningConfig } from "../reasoning-drop.js";
import { rulesEnabled, storeEffectiveRules } from "../rules-feature.js";
import { clampOutgoingOutput, countSystemAndToolsTokens, emergencyNudge } from "../server/budget.js";
import { PendingRetrieval, REWRITE_MIN_INCOMING_TOTAL, Session, applyCompactionArchive, detectUnannouncedHistoryRewrite, ensureCanonicalId, foldCoverage, markCompactionBoundary, markDirty, snapshotMessages } from "../session.js";
import { adoptContentStore, ccrEnabled, ccrLoopConfig, contentStoreOf, dropRetrievals, flushRetrievalNotes, pruneExpiredRetrievals, reconcileReloadedRetrievals, retrieveToolName, snapshotPendingRetrievals } from "../store.js";
import { isStrictReasoningEcho, modelIdOf, normalizeStrictEchoReasoning } from "../strict-echo.js";
import { reconcileSystemAnchor } from "../system-anchor.js";
import { hardenOpenaiAssistantContent, systemToUser } from "../util.js";
import { droppedOpenaiParts } from "../wire-drop-warn.js";
import { CompressionCore, Config, CoreMessage, NudgeDecision, PackSurface, Prompts, renderNudgeText, viableRanges } from "acp-kernel";
import { BiliMessage, OpenAIRequestBody, OpenAITool, coreToOpenai, injectOpenaiSystem, openaiToCore } from "acp-kernel/wire";
import http from "node:http";
import { injectOpenaiTool, injectTool } from "./inject.js";
import { Prepared, deriveTitle, diagNudge, diagTagSummary, effectiveAbsorbBlock, effectiveTokenCount, imageBillingFor, reapOrphansLogged, stripKernelSummaries, withReasoningDrop } from "./prepare-shared.js";

// #1205: sessions already warned about codec-dropped content parts (e.g.
// DeepSeek Files API file refs) — one warn per session per distinct type-set;
// attachment flows resend the same history every turn. Same bounded-FIFO shape
// as warnedChainSessions above.
const warnedWireDropKeys = new Set<string>();
export const WARNED_WIREDROP_KEY_CAP = 4096;
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

export async function prepareOpenai(
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
        const absorbBlock = effectiveAbsorbBlock(pluginMode, config, opts.compress.absorb);
        const absorbTools = absorbToolsFor(absorbBlock?.toolName ?? ABSORB_TOOL_NAME);
        const absorbActive = absorbBlock?.enabled === true && shouldInject;
        const rulesActive = rulesEnabled(config) && shouldInject;
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
        if (foldCoveredBefore !== null && !isTitleGen && msgs.length >= REWRITE_MIN_INCOMING_TOTAL) {
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
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, billingUpstream ?? upstreamOrigin), log });
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
        if (shouldInject) sysParts.push(withConversationIdNote(withMarkerIntegrityNote(withSummaryBudgetNote(buildCompressSystemPrompt(prompts, surface?.promptSections)), visibilityMarkers), ensureCanonicalId(session)));
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
            toolsOut = injectOpenaiTool(parsed.tools, [...(absorbActive ? [absorbTools.openai] : []), ...(rulesActive ? [RULE_TOOL_OPENAI] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).openai] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL_OPENAI] : [])], surface?.toolPrompts);
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
        // [#1343] surface any earlier undelivered retrieve as an ephemeral trailing
        // user note (kept last so it never reorders cached messages).
        const retrNote = flushRetrievalNotes(session);
        if (retrNote) rebuiltMessages = [...rebuiltMessages, { role: "user", content: retrNote }];
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
    return { body: JSON.stringify(rebuilt), session, attachedRetrievals, processedMessages, originalMessages, protocol: "openai", stream, compressInjected: injectTools, pluginMode, nudge, prompts, surface, openaiSystemText, systemNotes: sysNotes, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only" } as Prepared;
}
