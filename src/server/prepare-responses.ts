import http from "node:http";
import type { AbsorbConfig, CompressionCore, Config, CoreMessage, NudgeDecision, PackSurface, Prompts } from "acp-kernel";
import { defaultCountTokens, renderNudgeText, viableRanges } from "acp-kernel";
import { injectResponsesDeveloperMessage, type BiliMessage, type ResponseInputItem, type ResponsesProjection, type ResponsesRequestBody } from "acp-kernel/wire";
import type { CompressReasoningConfig } from "../reasoning-drop.js";
import { resolveAbsorbSettings } from "../compress-settings.js";
import { resolveCompressProtocol, type CompressSettings, type ProxyOptions } from "../config.js";
import { currentCalibrationFactor, strippedResponseIdWarning } from "../util.js";
import { diagNudge, diagTagSummary, deriveTitle, effectiveTokenCount, imageBillingFor, imageReserveFor, imageTokenCapFor, isAutoInjectedNotification, repairResponsesAssistantOrdering, reapOrphansLogged, runNudgeDecision, stripKernelSummaries, usageGradeInputBaseline, warnResponsesReasoningPairs, withReasoningDrop, type Prepared } from "../server.js";
import { buildDecisionPrompt, buildDirectiveText, consumeFallback, ladderMode, resolveDecisionRange, type DecideConfig } from "../nudge-decide.js";
import { mergeAdjacentConfigurationUpdates, patchResponsesInputWithToolImages as patchResponsesInput, responsesToCoreWithToolImages as responsesToCore } from "../responses-tool-output.js";
import { dropWhitespaceResponsesMessages, normalizeResponsesMessageItems, sanitizeResponsesInputIds } from "../loop/adapter-responses.js";
import { reconcileFoldCoverage, noteSystemPromptFingerprint, resolveFoldReconcileMode } from "../fold-reconcile.js";
import { nudgeSuppressed } from "../session-self-heal.js";
import { compressBreakerArmed } from "../stream.js";
import { coveredRealHistoryIds, foldCoverage, markDirty, markNativeCompactionBoundary, reconcileNativeCompactionBoundary, REWRITE_MIN_INCOMING_TOTAL, snapshotMessages, type Session } from "../session.js";
import { carriesDshLocalCompactionSummary, DSH_LOCAL_COMPACTION_MIN_MISSING } from "./dsh-compaction-guard.js";
import { recordConflict } from "../conflict-watch.js";
import { ABSORB_TOOL_NAME, BILI_ACP_READONLY_TOOLS_RESPONSES, BILI_ACP_READONLY_TOOLS_RESPONSES_NO_RANGE, BILI_ACP_TOOLS_RESPONSES, BILI_ACP_TOOLS_RESPONSES_NO_RANGE, IMAGE_FULL_TOOL_RESPONSES, RULE_TOOL_RESPONSES, absorbToolsFor, buildAbsorbSystemPrompt, buildAcpTagsOnlyPrompt, buildCompressHybridSystemPrompt, buildCompressSystemPrompt, retrieveToolsFor, withFirstSightDrain, withMarkerIntegrityNote, withSummaryBudgetNote } from "../compress-tool.js";
import { absorbToolName, applyAbsorbView, storeEffectiveAbsorb } from "../absorb.js";
import { adoptContentStore, ccrEnabled, ccrLoopConfig, contentStoreOf, retrieveToolName } from "../store.js";
import { applyImageCompressionPass, imageCompressionEnabled, imageFullTrailingNote } from "../image-compress.js";
import { rulesEnabled, storeEffectiveRules } from "../rules-feature.js";
import { autoFoldEngaged, externalSummaryEnabled, growthFoldingArmed } from "../external-summary-surface.js";
import { attachSubagentSessions } from "../subagent-sessions.js";
import { estimateCoreMessages, estimateCoreMessagesUpper } from "../preflight.js";
import { hoistTrappedToolItems } from "../tool-pair-order.js";
import { isStrictReasoningEcho, modelIdOf, normalizeStrictEchoResponsesInput } from "../strict-echo.js";
import { reconcileSystemAnchor } from "../system-anchor.js";
import { buildTriggerForgeBody, carriesCodexLocalCompactionSummary, codexCompactGate, codexCompactGatePre, codexCompactMode, hasCompactionTrigger, isCodexClient, mergeForgedSummaries, replaceBiliCompactionItems, stripBiliCompactionItems, CODEX_COMPACT_HEALTH_RATIO, CODEX_LOCAL_COMPACTION_MIN_MISSING } from "../codex-compact.js";
import { stripAcpPanelResponsesInput, stripAcpStatusMarkers } from "../acp-panel.js";
import type { ConversationIdentity } from "../session-id.js";
import { stripEmbeddedChainCarriers } from "../chain-checkpoint.js";
import { keepResponseId as knobKeepResponseId, noCompressPrompt as knobNoCompressPrompt, noInjectTool as knobNoInjectTool, renderNone as knobRenderNone } from "../knobs.js";
import { clampOutgoingOutput, countLoadedToolTokens, countSystemAndToolsTokens, dshLedgerFloorTokens, emergencyNudge, modelVisibleTools } from "./budget.js";
import { FORCE_TEXT_PROTOCOL, injectResponsesTool, injectTool } from "./inject.js";

export async function prepareResponses(
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
    decide?: DecideConfig,
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
        // #2372/#2432: LOCAL auto-compaction — the client compacts on its own
        // and the call never transits the proxy; the first the proxy hears of
        // it is this request replaying [compaction summary, retained tail…].
        // Without a boundary here the folded head's covered ids simply vanish:
        // syncBlocks keeps partially-alive blocks active forever, fold anchors
        // self-destruct on the first pass, and every later turn logs coverage
        // drift without recovering (the #2193 escalation is observe-only).
        // TWO producers replay that shape on this wire: codex (rollout event
        // type:"compacted", #2372) and dsh desktop's compaction-basic
        // checkpoint (#2432) — CONFIGURATION.md names responses "the lane dsh
        // desktop's compaction actually rides" (#2360), yet before the #2451
        // review this slot covered codex only and the dsh desktop scenario
        // fell back into the pre-#2432 death spiral. Detect (client identity
        // + summary template in a resent message + decimated fold coverage)
        // and rebase through the same reset the /responses/compact endpoint
        // path uses — mark + reconcile back-to-back resets NOW, so this turn's
        // processTurn assigns fresh refs onto the compacted view instead of
        // poisoning anchors first.
        const codexLane = !isCompactionTrigger && isCodexClient(req.headers);
        const dshLane = !isCompactionTrigger && session.metadata["pluginAgent"] === "dsh";
        if ((codexLane || dshLane) && session.state.blocks.some((b) => b.active)) {
            const coveredBeforeLocalCompact = coveredRealHistoryIds(session.state.blocks);
            const localGap = foldCoverage(coveredBeforeLocalCompact, msgs.map((m) => m.id));
            const codexHit = codexLane && carriesCodexLocalCompactionSummary(msgs);
            const dshHit = dshLane && carriesDshLocalCompactionSummary(msgs);
            if (localGap && (codexHit || dshHit)) {
                const missing = localGap.expected - localGap.matched;
                const minMissing = dshHit ? DSH_LOCAL_COMPACTION_MIN_MISSING : CODEX_LOCAL_COMPACTION_MIN_MISSING;
                if (missing >= minMissing && missing * 2 >= localGap.expected) {
                    if (dshHit) {
                        recordConflict(session, "native-compaction", `dsh native compaction: ${missing}/${localGap.expected} covered id(s) replaced by the compacted history; ACP state rebased (#2432)`);
                        log("warn", `[${sessionId}] dsh native compaction detected (${localGap.matched}/${localGap.expected} covered id(s) retained, checkpoint framing in resent history) — rebasing ACP state onto the compacted history (#2432)`);
                    } else {
                        recordConflict(session, "native-compaction", `codex local auto-compaction: ${missing}/${localGap.expected} covered id(s) replaced by the compacted history; rebasing ACP state (#2372)`);
                        log("warn", `[${sessionId}] codex local auto-compaction detected (${localGap.matched}/${localGap.expected} covered ids retained) — rebasing ACP state onto the compacted history (#2372)`);
                    }
                    markNativeCompactionBoundary(session);
                    reconcileNativeCompactionBoundary(session);
                }
            }
        }
        // [#1921] re-anchor fold coverage onto churned-but-same messages
        // before the #1195 snapshot, so covered ids surviving a client
        // re-serialization stay covered (src/fold-reconcile.ts).
        reconcileFoldCoverage(session, msgs, { mode: resolveFoldReconcileMode(process.env, opts.compress.reconcile), sessionId, log });
        if (!isCompactionTrigger) noteSystemPromptFingerprint(session, responsesClientSystem, { sessionId, log });
        // #1195: pre-turn snapshot of the fold's covered ids — syncBlocks inside
        // processTurn may deactivate fully-drifted blocks, erasing them.
        const foldCoveredBefore = session.stats.pendingFoldUsage === true
            ? coveredRealHistoryIds(session.state.blocks)
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
        if (!session.meta.title || isAutoInjectedNotification(session.meta.title)) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        const willInjectNudge = opts.compress.injectNudge && !!turn.nudge && shouldInject && !isCompactionTrigger && !nudgeSuppressed(session) && !compressBreakerArmed(session) && !(autoFoldEngaged(loopConfig, session) && growthFoldingArmed(loopConfig, codexLane && codexCompactMode() === "intercept" ? loopConfig.modelContextLimit * CODEX_COMPACT_HEALTH_RATIO : undefined)) && (turn.nudge.shouldInject || emergencyNudge(turn.nudge, undefined, loopConfig.compress.minCompressRange));
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
            const prompt = withMarkerIntegrityNote(withSummaryBudgetNote(responsesTextProtocol ? buildCompressHybridSystemPrompt(prompts, surface?.promptSections) : buildCompressSystemPrompt(prompts, surface?.promptSections), externalSummaryEnabled(config)), visibilityMarkers);
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
                    ? injectResponsesTool(parsed.tools, ccrOn ? BILI_ACP_READONLY_TOOLS_RESPONSES : BILI_ACP_READONLY_TOOLS_RESPONSES_NO_RANGE, surface?.toolPrompts, externalSummaryEnabled(config))
                    : injectResponsesTool(parsed.tools, respExtra.length > 0 ? [...(ccrOn ? BILI_ACP_TOOLS_RESPONSES : BILI_ACP_TOOLS_RESPONSES_NO_RANGE), ...respExtra] : (ccrOn ? BILI_ACP_TOOLS_RESPONSES : BILI_ACP_TOOLS_RESPONSES_NO_RANGE), surface?.toolPrompts, externalSummaryEnabled(config));
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
                        const inputItems: ResponseInputItem[] = typeof rebuiltInput === "string"
                            ? [{ type: "message", role: "user", content: rebuiltInput }]
                            : rebuiltInput;
                        inputItems.push({ type: "message", role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withFirstSightDrain(renderedWithPayload, turn.nudge.reason, externalSummaryEnabled(config)), externalSummaryEnabled(config)), visibilityMarkers) });
                        rebuiltInput = inputItems;
                        log("debug", `[${sessionId}] [inject] ephemeral nudge appended as trailing user turn (${rendered.text.length} chars)`);
                    }
                } catch {
                }
            } else if (useDecide) {
                const ranges = turn.nudge.compressibleRanges ?? [];
                // Mirror the post-try strict-echo repair on the stable prefix so
                // the side call's bytes match the main request's cache line.
                const stableItems: ResponseInputItem[] = typeof rebuiltInput === "string"
                    ? [{ type: "message", role: "user", content: rebuiltInput }]
                    : normalizeStrictEchoResponsesInput([...rebuiltInput], isStrictReasoningEcho(session, upstreamOrigin, modelIdOf(parsed)), log, sessionId);
                const sideBody: Record<string, unknown> = { ...parsed, input: [...stableItems, { type: "message", role: "user", content: buildDecisionPrompt(ranges) }], tools: toolsOut, stream: false, max_output_tokens: decide.maxTokens };
                const outcome = await runNudgeDecision({ req, opts, protocol: "responses", sideBody, session, log });
                if (outcome.kind === "yes") {
                    const span = resolveDecisionRange(outcome, ranges);
                    if (span) {
                        const inputItems: ResponseInputItem[] = typeof rebuiltInput === "string"
                            ? [{ type: "message", role: "user", content: rebuiltInput }]
                            : [...stableItems];
                        inputItems.push({ type: "message", role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withFirstSightDrain(buildDirectiveText(span.startRef, span.endRef, outcome.topic), turn.nudge.reason, externalSummaryEnabled(config)), externalSummaryEnabled(config)), visibilityMarkers) });
                        rebuiltInput = inputItems;
                        log("debug", `[${sessionId}] [inject] compress directive appended as trailing user turn`);
                    } else {
                        log("info", `[${sessionId}] [acp-decide] yes but no live range left to target — skipping injection`);
                    }
                }
            } else {
                try {
                    const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections);
                    const renderedWithPayload = rendered.text;
                    if (rendered.text) {
                        const inputItems: ResponseInputItem[] = typeof rebuiltInput === "string"
                            ? [{ type: "message", role: "user", content: rebuiltInput }]
                            : rebuiltInput;
                        inputItems.push({ type: "message", role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withFirstSightDrain(renderedWithPayload, turn.nudge.reason, externalSummaryEnabled(config)), externalSummaryEnabled(config)), visibilityMarkers) });
                        rebuiltInput = inputItems;
                        log("debug", `[${sessionId}] [inject] ephemeral nudge appended as trailing user turn (${rendered.text.length} chars)`);
                    }
                } catch {
                }
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
        clampOutgoingOutput(rebuilt as Record<string, unknown>, "max_output_tokens", { systemText: (responsesProjection?.systemParts ?? []).join("\n"), tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, lastInputTokensSource: session.stats.lastInputTokensSource, nativeWindow, headroomWindow: config.modelContextLimit, imageTokens: imageReserveFor(session, "responses", rebuilt, opts, billingUpstream ?? upstreamOrigin), kFactor: currentCalibrationFactor(session.stats, session.metadata?.lastModel), kOrigin: session.stats.calibratedEstimateOrigin, origin: billingUpstream ?? upstreamOrigin, ledgerFloorTokens: dshLedgerFloorTokens(session.metadata) }, sessionId, log);
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
    const loadedToolTokens = countLoadedToolTokens(rebuilt);
    if (transformOk) {
        session.metadata.systemPromptTokens = countSystemAndToolsTokens(responsesDevContent ?? "", toolsOut) + loadedToolTokens;
        const catalogTokens = defaultCountTokens(JSON.stringify(toolsOut ?? []));
        const visibleTokens = defaultCountTokens(JSON.stringify(modelVisibleTools(toolsOut)));
        if (catalogTokens >= 50_000 || catalogTokens !== visibleTokens || loadedToolTokens > 0) {
            log("info", `[${sessionId}] tool-budget catalog~${catalogTokens} visible~${visibleTokens} loaded~${loadedToolTokens} instruction~${defaultCountTokens(responsesDevContent ?? "")} tokens (estimates; definitions preserved)`);
        }
    }
    // #728: record this turn's outbound payload upper bound as the fallback
    // token source for upstreams that never report usage (see effectiveTokenCount).
    // Compaction-trigger requests are the compression mechanism itself — no
    // incremental decision hangs off them, so don't leave a stale reading.
    if (!isCompactionTrigger) {
        session.stats.localInputEstimate = estimateCoreMessagesUpper(processedMessages.length > 0 ? processedMessages : originalMessages)
            + countSystemAndToolsTokens(responsesDevContent ?? "", toolsOut)
            + loadedToolTokens
            + imageReserveFor(session, "responses", rebuilt, opts, billingUpstream ?? upstreamOrigin);
        // #1933 F1: billed-caliber twin (chars/4) for the k̂ learning pair —
        // see the anthropic-lane counterpart above.
        session.stats.lastLocalTextEstimate = estimateCoreMessages(processedMessages.length > 0 ? processedMessages : originalMessages)
            + countSystemAndToolsTokens(responsesDevContent ?? "", toolsOut)
            + loadedToolTokens
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


export function prepareResponsesCompact(
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

// #1359: which absorb block governs a session, by lane. Proxy lane keeps the
// per-request merged block (provider/model overrides apply); plugin lane uses
// the base block so the manifest's advertised name and the gate's adjudicated
// name always agree — provider/model absorb.* overrides are proxy-lane-only.
export function effectiveAbsorbBlock(pluginMode: boolean, config: Config, baseAbsorb?: CompressSettings["absorb"]): AbsorbConfig | undefined {
    return pluginMode ? resolveAbsorbSettings(baseAbsorb) : config.absorb;
}
