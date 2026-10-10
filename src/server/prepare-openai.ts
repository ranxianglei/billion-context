import http from "node:http";
import type { CompressionCore, Config, CoreMessage, NudgeDecision, PackSurface, Prompts } from "acp-kernel";
import { renderNudgeText, viableRanges } from "acp-kernel";
import { coreToOpenai, injectOpenaiSystem, openaiToCore, type BiliMessage, type OpenAIRequestBody, type OpenAITool } from "acp-kernel/wire";
import type { CompressReasoningConfig } from "../reasoning-drop.js";
import type { ProxyOptions } from "../config.js";
import { currentCalibrationFactor, hardenOpenaiAssistantContent, systemToUser } from "../util.js";
import { conversationHeaderSource, shouldStampRelayAffinityPck } from "../session-id.js";
import { diagNudge, diagTagSummary, deriveTitle, effectiveTokenCount, imageBillingFor, imageReserveFor, imageTokenCapFor, isAutoInjectedNotification, reapOrphansLogged, runNudgeDecision, stripKernelSummaries, warnDroppedOpenaiParts, warnReasoningPairs, withReasoningDrop, type Prepared } from "../server.js";
import { buildDecisionPrompt, buildDirectiveText, consumeFallback, ladderMode, resolveDecisionRange, type DecideConfig } from "../nudge-decide.js";
import { reconcileFoldCoverage, noteSystemPromptFingerprint, resolveFoldReconcileMode } from "../fold-reconcile.js";
import { nudgeSuppressed } from "../session-self-heal.js";
import { compressBreakerArmed } from "../stream.js";
import { applyCompactionArchive, detectUnannouncedHistoryRewrite, foldCoverage, markCompactionBoundary, markDirty, markNativeCompactionBoundary, reconcileNativeCompactionBoundary, REWRITE_MIN_INCOMING_TOTAL, snapshotMessages, type PendingRetrieval, type Session } from "../session.js";
import { carriesDshLocalCompactionSummary, DSH_LOCAL_COMPACTION_MIN_MISSING } from "./dsh-compaction-guard.js";
import { ABSORB_TOOL_NAME, IMAGE_FULL_TOOL_OPENAI, RULE_TOOL_OPENAI, absorbToolsFor, buildAbsorbSystemPrompt, buildAcpTagsOnlyPrompt, buildCompressSystemPrompt, retrieveToolsFor, withFirstSightDrain, withMarkerIntegrityNote, withSummaryBudgetNote } from "../compress-tool.js";
import { absorbToolName, applyAbsorbView, storeEffectiveAbsorb } from "../absorb.js";
import { adoptContentStore, ccrEnabled, ccrLoopConfig, contentStoreOf, dropRetrievals, pruneExpiredRetrievals, reconcileReloadedRetrievals, renderRetrievalNotes, retrieveToolName, snapshotPendingRetrievals, snapshotRetrievalNotes } from "../store.js";
import { applyImageCompressionPass, imageCompressionEnabled, imageFullTrailingNote } from "../image-compress.js";
import { rulesEnabled, storeEffectiveRules } from "../rules-feature.js";
import { autoFoldEngaged, externalSummaryEnabled, growthFoldingArmed } from "../external-summary-surface.js";
import { attachSubagentSessions } from "../subagent-sessions.js";
import { estimateCoreMessages, estimateCoreMessagesUpper } from "../preflight.js";
import { recordConflict } from "../conflict-watch.js";
import { isStrictReasoningEcho, modelIdOf, normalizeStrictEchoReasoning } from "../strict-echo.js";
import { reconcileSystemAnchor } from "../system-anchor.js";
import { stripAcpPanelMessages, stripAcpStatusMarkers } from "../acp-panel.js";
import { stripEmbeddedChainCarriers } from "../chain-checkpoint.js";
import { renderNone as knobRenderNone } from "../knobs.js";
import { clampOutgoingOutput, countSystemAndToolsTokens, dshLedgerFloorTokens, emergencyNudge } from "./budget.js";
import { effectiveAbsorbBlock } from "./prepare-responses.js";
import { injectOpenaiTool, injectTool } from "./inject.js";

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
    decide?: DecideConfig,
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
        // #2432: dsh desktop's native compaction can LAND without ever
        // transiting bili — its summarizer calls ctx.llm.stream() directly,
        // and manual /compact / idle-session paths have no ALS attribution so
        // the plugin's takeover gate sends them DIRECT past the proxy
        // (src/agent/dsh-native.ts); the server-side guard only sees calls
        // that DO transit. First notice = this request replaying
        // [checkpoint summary, retained tail…] against the same session id.
        // Same signature+rebase pattern as codex local compaction (#2373):
        // dsh-bound session + checkpoint framing in resent history + decimated
        // fold coverage → mark AND rebase NOW so this turn's processTurn seeds
        // fresh refs onto the compacted view instead of poisoning anchors
        // first (without it: syncBlocks keeps partially-alive blocks forever,
        // fold anchors self-destruct, and every later compress fails "cannot
        // be anchored" — the #2432 death spiral). Detection runs BEFORE
        // reconcileFoldCoverage/processTurn for exactly the reason the codex
        // lane does (#2373 commit note). Either signal alone stays on the
        // existing paths: framing paste with intact history has no gap; a gap
        // without framing falls through to detectUnannouncedHistoryRewrite.
        let dshRebased = false;
        if (!isTitleGen && session.metadata["pluginAgent"] === "dsh" && session.state.blocks.some((b) => b.active)) {
            const coveredBeforeDshCompact = new Set(session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
            const dshGap = foldCoverage(coveredBeforeDshCompact, msgs.map((m) => m.id));
            if (dshGap && carriesDshLocalCompactionSummary(msgs)) {
                const missing = dshGap.expected - dshGap.matched;
                if (missing >= DSH_LOCAL_COMPACTION_MIN_MISSING && missing * 2 >= dshGap.expected) {
                    recordConflict(session, "native-compaction", `dsh native compaction: ${missing}/${dshGap.expected} covered id(s) replaced by the compacted history; ACP state rebased (#2432)`);
                    log("warn", `[${sessionId}] dsh native compaction detected (${dshGap.matched}/${dshGap.expected} covered id(s) retained, checkpoint framing in resent history) — rebasing ACP state onto the compacted history (#2432)`);
                    markNativeCompactionBoundary(session);
                    dshRebased = reconcileNativeCompactionBoundary(session);
                }
            }
        }
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
        if (!session.meta.title || isAutoInjectedNotification(session.meta.title)) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        const willInjectNudge = opts.compress.injectNudge && !!turn.nudge && shouldInject && !nudgeSuppressed(session) && !compressBreakerArmed(session) && !(autoFoldEngaged(loopConfig, session) && growthFoldingArmed(loopConfig)) && (turn.nudge.shouldInject || emergencyNudge(turn.nudge, undefined, loopConfig.compress.minCompressRange));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, parsed.model, willInjectNudge));
        processedMessages = stripReasoning(stripKernelSummaries(turn.messages, turn.state));
        // #1001: a silent client history rewrite takes the same archive+prune path
        // as an announced /compact boundary — syncBlocks above has already
        // deactivated the blocks whose sources left the context. Skipped when
        // the rewrite was just classified as dsh native compaction above
        // (#2432): it is already recorded as "native-compaction" and rebased —
        // a second "unannounced-rewrite" entry beside it would present the
        // substrate destruction as "another compressor fighting you".
        if (!dshRebased) {
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
        if (shouldInject) sysParts.push(withMarkerIntegrityNote(withSummaryBudgetNote(buildCompressSystemPrompt(prompts, surface?.promptSections), externalSummaryEnabled(config)), visibilityMarkers));
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
            toolsOut = injectOpenaiTool(parsed.tools, [...(absorbActive ? [absorbTools.openai] : []), ...(rulesActive ? [RULE_TOOL_OPENAI] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).openai] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL_OPENAI] : [])], surface?.toolPrompts, ccrEnabled(session), externalSummaryEnabled(config));
        }
        // Nudge as a separate trailing user message (cache-friendly). Injected
        // in BOTH modes (#451): plugin agents supply the ACP tools but have no
        // nudge channel of their own, so this proxy-side nudge is the proactive
        // trigger (preflight alone fires only at the hard limit). Ephemeral user
        // message — not persisted, never enters the agent's re-sent history,
        // prefix-cache-anchor safe.
        if (willInjectNudge && turn.nudge) {
            // #2228: model-decided timing (see prepareAnthropic for the policy):
            // gentle/over-limit T1 arms ask the model first; EMERGENCY and
            // tier>=2 keep the legacy advisory.
            const useDecide = decide !== undefined && turn.nudge.tier === 1 && turn.nudge.breakdown.emergencyOverride !== 1;
            if (useDecide && ladderMode(session.metadata) === "fallback") {
                consumeFallback(session.metadata);
                try {
                    const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections);
                    const renderedWithPayload = rendered.text;
                    if (rendered.text) {
                        rebuiltMessages = [...rebuiltMessages, { role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withFirstSightDrain(renderedWithPayload, turn.nudge.reason, externalSummaryEnabled(config)), externalSummaryEnabled(config)), visibilityMarkers) }];
                    }
                } catch {
                }
            } else if (useDecide) {
                const ranges = turn.nudge.compressibleRanges ?? [];
                // Mirror the post-try strict-echo repair on the stable prefix so
                // the side call's bytes match the main request's cache line.
                const stable = normalizeStrictEchoReasoning([...rebuiltMessages], isStrictReasoningEcho(session, upstreamOrigin, modelIdOf(parsed)), log, sessionId);
                const sideBody: Record<string, unknown> = { ...parsed, messages: [...stable, { role: "user", content: buildDecisionPrompt(ranges) }], tools: toolsOut as OpenAITool[] | undefined, stream: false };
                sideBody[typeof (parsed as Record<string, unknown>).max_completion_tokens === "number" ? "max_completion_tokens" : "max_tokens"] = decide.maxTokens;
                delete sideBody.prompt_cache_retention;
                const outcome = await runNudgeDecision({ req, opts, protocol: "openai", sideBody, session, log });
                if (outcome.kind === "yes") {
                    const span = resolveDecisionRange(outcome, ranges);
                    if (span) {
                        rebuiltMessages = [...rebuiltMessages, { role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withFirstSightDrain(buildDirectiveText(span.startRef, span.endRef, outcome.topic), turn.nudge.reason, externalSummaryEnabled(config)), externalSummaryEnabled(config)), visibilityMarkers) }];
                    } else {
                        log("info", `[${sessionId}] [acp-decide] yes but no live range left to target — skipping injection`);
                    }
                }
            } else {
                try {
                    const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections);
                    const renderedWithPayload = rendered.text;
                    if (rendered.text) {
                        rebuiltMessages = [...rebuiltMessages, { role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withFirstSightDrain(renderedWithPayload, turn.nudge.reason, externalSummaryEnabled(config)), externalSummaryEnabled(config)), visibilityMarkers) }];
                    }
                } catch {
                }
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
    clampOutgoingOutput(rebuilt as Record<string, unknown>, typeof (parsed as Record<string, unknown>).max_completion_tokens === "number" ? "max_completion_tokens" : "max_tokens", { systemText: openaiSystemText, tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, lastInputTokensSource: session.stats.lastInputTokensSource, nativeWindow, headroomWindow: config.modelContextLimit, imageTokens: imageReserveFor(session, "openai", rebuilt, opts, billingUpstream ?? upstreamOrigin), kFactor: currentCalibrationFactor(session.stats, session.metadata?.lastModel), kOrigin: session.stats.calibratedEstimateOrigin, origin: billingUpstream ?? upstreamOrigin, ledgerFloorTokens: dshLedgerFloorTokens(session.metadata) }, sessionId, log);
    // prompt_cache_retention is an OpenAI-host-only cache directive; the dsh
    // launcher forces PI_CACHE_RETENTION=long (for the session-id
    // prompt_cache_key) which makes the client also emit it. Third-party
    // OpenAI-compatible upstreams may reject unknown fields, and cache policy
    // is the upstream's business — strip it. prompt_cache_key itself passes
    // through: upstreams that ignore it lose nothing, upstreams that use it
    // get a per-conversation routing hint.
    delete (rebuilt as Record<string, unknown>).prompt_cache_retention;
    // #2218/#2645: body-only relay affinity for plugin hosts. dsh desktop's
    // only identity signal is the bili-internal x-bili-plugin-conversation
    // header (already forwarded as x-session-id by buildForwardTarget);
    // body-keyed relays (workbuddy panel) can't read headers, so stamp the
    // conversation id into prompt_cache_key too. Gated to LOOPBACK
    // destinations only — strict direct APIs can 400 unknown body params
    // (#1403), and the /bili/ tunnel sets a route for the user's own REMOTE
    // destination too (#2645), so "a URL was embedded" must NOT imply stamping.
    if (shouldStampRelayAffinityPck(conversationHeaderSource(req.headers)?.name, parsed.prompt_cache_key, upstreamOrigin)) {
        rebuilt.prompt_cache_key = session.id;
    }
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
