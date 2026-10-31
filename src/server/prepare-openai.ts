import http from "node:http";
import type { CompressionCore, Config, CoreMessage, NudgeDecision, PackSurface, Prompts } from "acp-kernel";
import { isRenderedSummaryMessage, renderNudgeText, viableRanges } from "acp-kernel";
import { coreToOpenai, injectOpenaiSystem, openaiToCore, type BiliMessage, type OpenAIRequestBody, type OpenAITool } from "acp-kernel/wire";
import type { CompressReasoningConfig } from "../reasoning-drop.js";
import type { ProxyOptions } from "../config.js";
import { effectivePromptCacheRouting } from "../config.js";
import { currentCalibrationFactor, hardenOpenaiAssistantContent, systemToUser } from "../util.js";
import { conversationHeaderSource, resolveRelayAffinityPck } from "../session-id.js";
import { pluginAgentHeader } from "../plugin.js";
import { applyReasoningDrop, diagNudge, diagTagSummary, deriveTitle, effectiveTokenCount, imageBillingFor, imageReserveFor, imageTokenCapFor, isAutoInjectedNotification, planReasoningDrop, reapOrphansLogged, resolveKnownOutputCeiling, runNudgeDecision, stripKernelSummaries, warnDroppedOpenaiParts, warnReasoningPairs, type Prepared } from "../server.js";
import { yieldToEventLoop } from "../yield-loop.js";
import { buildDecisionPrompt, buildDirectiveText, consumeFallback, ladderMode, resolveDecisionRange, stripDecisionReasoningFields, type DecideConfig } from "../nudge-decide.js";
import { excludeDeadRefRanges } from "../acp-status.js";
import { reconcileFoldCoverage, noteSystemPromptFingerprint, resolveFoldReconcileMode } from "../fold-reconcile.js";
import { maybeSnapshotView } from "./snapshot-render.js";
import { storedMessagesFor } from "../fold-decomposition-lookup.js";
import { nudgeSuppressed } from "../session-self-heal.js";
import { compressBreakerArmed } from "../stream.js";
import { applyCompactionArchive, coveredRealHistoryIds, detectUnannouncedHistoryRewrite, foldCoverage, markCompactionBoundary, markDirty, markNativeCompactionBoundary, reconcileNativeCompactionBoundary, REWRITE_MIN_INCOMING_TOTAL, snapshotMessages, type PendingRetrieval, type Session } from "../session.js";
import { carriesDshLocalCompactionSummary, DSH_LOCAL_COMPACTION_MIN_MISSING } from "./dsh-compaction-guard.js";
import { carriesBiliSnapshotCheckpoint } from "./dsh-authored-compaction.js";
import { ABSORB_TOOL_NAME, READ_ORIGINAL_IMAGE_TOOL_OPENAI, RULE_TOOL_OPENAI, absorbToolsFor, buildAbsorbSystemPrompt, buildAcpTagsOnlyPrompt, buildCompressSystemPrompt, retrieveToolsFor, withFirstSightDrain, withMarkerIntegrityNote, withMcpDialectNote, withSummaryBudgetNote, withProjectAttribution } from "../compress-tool.js";
import { absorbToolName, applyAbsorbView, storeEffectiveAbsorb } from "../absorb.js";
import { adoptContentStore, ccrEnabled, ccrLoopConfig, contentStoreOf, dropRetrievals, imageRescaleToolArmed, pruneExpiredRetrievals, reconcileReloadedRetrievals, renderRetrievalNotes, retrieveToolName, snapshotPendingRetrievals, snapshotRetrievalNotes } from "../store.js";
import { rulesEnabled, storeEffectiveRules } from "../rules-feature.js";
import { autoFoldEngaged, autoFoldFloor, conversationPromptSections, externalSummaryEnabled, growthFoldingArmed, messageTimestampSections } from "../external-summary-surface.js";
import { filterDeadRanges } from "../dead-ranges.js";
import { detectGenerationBoundary, GENERATION_BOUNDARY_NOTE } from "../generation-boundary.js";
import { attachSubagentSessions } from "../subagent-sessions.js";
import { estimateCoreMessages, estimateCoreMessagesUpper } from "../preflight.js";
import { dshNativeCompactionWitness, recordConflict } from "../conflict-watch.js";
import { isStrictReasoningEcho, modelIdOf, normalizeStrictEchoReasoning } from "../strict-echo.js";
import { reconcileSystemAnchor } from "../system-anchor.js";
import { logRawStripCounts, markerArtifactCount, stripRawStage } from "../marker/engine.js";
import { imageRescaleMaxDim, renderNone as knobRenderNone } from "../knobs.js";
import { applyImageRescalePass } from "../image-rescale.js";
import { clampOutgoingOutput, countSystemAndToolsTokens, dshLedgerFloorTokens, emergencyNudge, emergencyNudgeArmed } from "./budget.js";
import { effectiveAbsorbBlock } from "./prepare-responses.js";
import { injectOpenaiTool, injectTool } from "./inject.js";
import { nudgeOn, resolveLaneDecisions, surfaceOffDetail } from "./lane-decisions.js";
import { collectRequestIds, probeRequestMembership } from "../request-membership.js";

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
    const inboundMessageCount = Array.isArray(parsed.messages) ? parsed.messages.length : 1;
    ++session.stats.requests;
    let openaiSystemText = "";
    let sysNotes: string[] = [];
    let openaiOutboundSystem: string | undefined;
    let processedMessages: CoreMessage[] = [];
    // #3222: #651's reasoning-drop plan, computed on the INBOUND history before
    // core.processTurn — see planReasoningDrop for why the post-turn view is
    // too late (the kernel hides consumed call+result pairs inside it).
    let reasoningPlan = new Set<string>();
    let attachedRetrievals: PendingRetrieval[] = [];
    let attachedRetrievalNoteIds: string[] = [];
    let originalMessages: CoreMessage[] = [];
    let judgeBaseline: readonly CoreMessage[] | undefined;
    let nudge: NudgeDecision | undefined;
    let nudgeOutcome: Prepared["nudgeOutcome"];
    let rebuiltMessages = parsed.messages;
    let toolsOut = parsed.tools;
    // #2483: single source for the effective render strategy — processTurn, the
    // diag log and Prepared must all report what was actually rendered (the
    // log label used to hardcode "text-only" and lie under renderNone).
    const renderStrategy = knobRenderNone() ? "none" : "text-only";

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
    // #3177: DSH registers bili's ACP tools host-scope (invisible to the preset
    // agent — 0/3939 request headers carry them), so model-driven compression is
    // structurally unreachable there. Drop the model-side compress surface (system
    // prompt + nudge) for DSH plugin sessions; otherwise the nudge tells the model
    // to call a tool it can never see ("unknown tool \"compress\""). pi/omp/opencode
    // keep it — their extensions expose the tools to the agent.
    // #3417: that judgement now lives in lane-decisions (observed reachability
    // overrides the dsh default — #3401); alias kept for the remaining reads.
    const laneDecisions = resolveLaneDecisions({ protocol: "openai", pluginMode, pluginAgent: typeof session.metadata["pluginAgent"] === "string" ? session.metadata["pluginAgent"] as string : undefined, parsed, shouldInject, pluginHeaderPresent: pluginAgentHeader(req.headers) !== undefined });

    const markerCounts = stripRawStage(parsed, "openai");
    logRawStripCounts(markerCounts, log, sessionId);

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
        // #3756 snapshot render: the outbound prefix renders from the unified
        // transcript (server-authoritative, fold-time ids — immune to identity
        // re-mints #3752); only the live tail keeps the client's bytes.
        // No-op returns `msgs` when the lane is inactive/degraded.
        // reconcileFoldCoverage below still observes the CLIENT view.
        const renderMsgs = maybeSnapshotView(session, msgs, { sessionId, pluginMode, log });
        // #4241: the render lane replaced the view (reference-inequality is the
        // discriminator — maybeSnapshotView returns the SAME array when idle),
        // so the judged baseline is the rendered transcript, not the inbound.
        judgeBaseline = renderMsgs !== msgs ? renderMsgs : undefined;
        // #1001: pre-turn snapshot — processTurn below assigns fresh refs to every
        // previously-unknown id, which would make rewrite detection read 1.0.
        const knownRefsBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
        // tokenCount = upstream's real input_tokens from the previous turn
        // tokenCount = upstream's real input_tokens from the previous turn
        // (see anthropic branch comment + its #553-follow-up exception).
        const { tokens: tokenCount, source: tokenCountSource } = effectiveTokenCount(session, renderMsgs, imageReserveFor(session, "openai", parsed, opts, billingUpstream ?? upstreamOrigin));

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
        if (!isTitleGen && laneDecisions.profile.compactsClientSide && session.state.blocks.some((b) => b.active)) {
            const coveredBeforeDshCompact = coveredRealHistoryIds(session.state.blocks);
            const dshGap = foldCoverage(coveredBeforeDshCompact, msgs.map((m) => m.id));
            // #2621: pass the pre-turn ref map so the framing match also demands
            // NOVELTY — a freshly-landed checkpoint is a NEW id, while every
            // historical quote/replay of the marker string hits an old id.
            if (dshGap && (carriesDshLocalCompactionSummary(msgs, knownRefsBefore) || carriesBiliSnapshotCheckpoint(msgs, knownRefsBefore))) {
                const missing = dshGap.expected - dshGap.matched;
                if (missing >= DSH_LOCAL_COMPACTION_MIN_MISSING && missing * 2 >= dshGap.expected) {
                    // #3733: a checkpoint carrying our <bili-snapshot v1 …/> tag is one
                    // WE authored (answered locally at the #1729 guard) — same rebase
                    // as a foreign one, but recorded + logged as the intended event.
                    const authored = carriesBiliSnapshotCheckpoint(msgs, knownRefsBefore);
                    if (authored) session.metadata.dshAuthoredCheckpointLanded = true;
                    recordConflict(session, "native-compaction", `dsh native compaction: ${missing}/${dshGap.expected} covered id(s) replaced by the compacted history; ACP state rebased (#2432)`);
                    log(authored ? "info" : "warn", `[${sessionId}] dsh ${authored ? "AUTHORED checkpoint landed" : "native compaction detected"} (${dshGap.matched}/${dshGap.expected} covered id(s) retained, checkpoint framing in resent history) — ${authored ? "rebasing ACP state onto the authored bili-snapshot checkpoint (#3733)" : "rebasing ACP state onto the compacted history (#2432)"}`);
                    markNativeCompactionBoundary(session);
                    dshRebased = reconcileNativeCompactionBoundary(session);
                }
            }
        }
        // [#1921] re-anchor fold coverage onto churned-but-same messages
        // before the #1195 snapshot, so covered ids surviving a client
        // re-serialization stay covered (src/fold-reconcile.ts). The verdict
        // feeds the #4131 rewrite gate below (explained churn ≠ destruction).
        // #3301: stored decompositions for pre-#2644 anchors whose wire-side
        // backfill can never fire after a wire-shape flip.
        const foldMode = resolveFoldReconcileMode(process.env, opts.compress.reconcile);
        const reconcileOutcome = reconcileFoldCoverage(session, msgs, { mode: foldMode, sessionId, log, markerStripped: markerArtifactCount(markerCounts), inboundMessageCount, storedMessages: foldMode === "off" ? undefined : storedMessagesFor(session, sessionId, msgs) });
        if (!isTitleGen) noteSystemPromptFingerprint(session, systemText, { sessionId, log });
        // #1195: pre-turn snapshot of the fold's covered ids — syncBlocks inside
        // processTurn may deactivate fully-drifted blocks, erasing them.
        const foldCoveredBefore = session.stats.pendingFoldUsage === true
            ? coveredRealHistoryIds(session.state.blocks)
            : null;
        // #3222: BEFORE processTurn — its hide-compress-calls node removes
        // inactive call+result pairs inside, which would strip the anchors
        // this pass needs (the leak applies to the bare name too).
        reasoningPlan = planReasoningDrop(renderMsgs, reasoning, isStrictReasoningEcho(session, upstreamOrigin, modelIdOf(parsed)));
        // #4528: processTurn is the largest single synchronous pass over the
        // resent history; yield before it so UI/API requests that queued during
        // this turn are served, not frozen behind the whole turn.
        await yieldToEventLoop();
        const turn = core.processTurn({ messages: renderMsgs, state: session.state, config: loopConfig, tokenCount, renderTags: renderStrategy, contentStore: contentStoreOf(session) });
        session.state = turn.state;
        adoptContentStore(session, turn.contentStore);
        // #4528: split the kernel pass from its post-processing scan passes so
        // each is a bounded synchronous stretch rather than one long block.
        await yieldToEventLoop();
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
        // #3204: also drop DEAD-ref-bracketing spans at this single point so
        // every downstream consumer (decision prompt + directive, prose nudge,
        // emergency override, preflight length gates) sees only spans the
        // submit gate can accept — no surface advertises a doomed span.
        // #2638: also drop remembered structurally-dead spans (kernel preview
        // returned "no new compressible messages") — a nudge advertising them
        // steers the model into an atomically-refused compress call.
        if (turn.nudge) turn.nudge.compressibleRanges = filterDeadRanges(session, excludeDeadRefRanges(viableRanges(turn.nudge.compressibleRanges), session.state.deadRefs));
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
        session.stats.contextTokensSource = tokenCountSource;
        if (!session.meta.title || isAutoInjectedNotification(session.meta.title)) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, renderStrategy));
        // #3004: a tier-1 arm that would route through the model-decided gate.
        // Two post-gate facts hang off it: the label (PENDING until the gate
        // answers) and the fallback override below.
        const decideTier1Arm = decide !== undefined && !!turn.nudge && turn.nudge.tier === 1 && turn.nudge.breakdown.emergencyOverride !== 1;
        // #3004: the decide ladder's fallback is the failure-recovery path — it
        // must reach the model even while self-heal suppression is latched, or
        // the two mechanisms dead-lock: suppression gates willInjectNudge, which
        // gates the very branch that breaks it, and release waits on compression
        // that only a nudge could prompt (field report: 4h12m latch at zero
        // blocks). Self-limiting by construction: consumeFallback resets the
        // counter on the same round, so at most ONE legacy advisory punches
        // through per DECIDE_FALLBACK_THRESHOLD consecutive decision failures.
        const decideFallbackOverride = decideTier1Arm && ladderMode(session.metadata) === "fallback";
        const nudgeEligible = opts.compress.injectNudge && !!turn.nudge && laneDecisions.compressSurfaceOn && (!nudgeSuppressed(session) || decideFallbackOverride) && !compressBreakerArmed(session) && !(autoFoldEngaged(loopConfig, session) && growthFoldingArmed(loopConfig, undefined, autoFoldFloor(session)));
        // #3461: pressure admitted by every standing gate but held by the backoff
        // is still an active nudge round — self-heal credit (#2155/#3004) must
        // not starve because we chose not to re-inject this round.
        const emergencyPressureHeld = nudgeEligible && !!turn.nudge && !turn.nudge.shouldInject && emergencyNudge(turn.nudge, undefined, loopConfig.compress.minCompressRange);
        // #3482 Step 2.5: the ONE nudge gate (lane-decisions). No compaction trigger
        // and no intercept health window on this wire — those differences are
        // explicit inputs on the responses lane. The standalone `shouldInject`
        // conjunct is subsumed by compressSurfaceOn (=== shouldInject &&
        // compressReachable).
        const willInjectNudge = nudgeOn({
            injectNudge: opts.compress.injectNudge,
            hasNudgePlan: !!turn.nudge,
            compressSurfaceOn: laneDecisions.compressSurfaceOn,
            compactionTrigger: false,
            suppressionBypassed: !nudgeSuppressed(session) || decideFallbackOverride,
            breakerArmed: compressBreakerArmed(session),
            autoFoldEngaged: autoFoldEngaged(loopConfig, session),
            growthFoldingArmed: growthFoldingArmed(loopConfig, undefined, autoFoldFloor(session)),
            modelWantsIt: turn.nudge !== undefined && (turn.nudge.shouldInject || emergencyNudgeArmed(session, turn.nudge, loopConfig.compress.minCompressRange, tokenCount, loopConfig.nudge.growthFloor)),
        });
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, parsed.model, willInjectNudge, decideTier1Arm && !decideFallbackOverride, surfaceOffDetail(laneDecisions, opts.compress.injectTool)));
        processedMessages = applyReasoningDrop(stripKernelSummaries(turn.messages, turn.state), reasoningPlan, log, sessionId);
        // #1001: a silent client history rewrite takes the same archive+prune path
        // as an announced /compact boundary — syncBlocks above has already
        // deactivated the blocks whose sources left the context. Skipped when
        // the rewrite was just classified as dsh native compaction above
        // (#2432): it is already recorded as "native-compaction" and rebased —
        // a second "unannounced-rewrite" entry beside it would present the
        // substrate destruction as "another compressor fighting you".
        if (!dshRebased) {
            const rewrite = detectUnannouncedHistoryRewrite(session, knownRefsBefore, msgs.map((m) => m.id), reconcileOutcome);
            if (rewrite.churnExplained) {
                // #4131: cross-build id re-mint (#3642) — fold-reconcile found every
                // covered id on the wire; adopt instead of destroying.
                recordConflict(session, "id-churn-adoption", `${rewrite.knownIncoming}/${rewrite.incomingTotal} incoming message(s) carry pre-turn refs of ${rewrite.knownBefore} known; fold-reconcile re-anchored every covered id (0 unmatched) — bili-side id re-mint across builds (#3642), not a client rewrite — no compaction boundary (#4131)`);
                log("info", `[${sessionId}] cross-build id churn adopted: hash-identity collapse (${rewrite.knownIncoming}/${rewrite.incomingTotal} pre-turn refs of ${rewrite.knownBefore} known) explained by fold-reconcile full re-anchor (0 unmatched) — skipping compaction boundary (#4131/#3642)`);
            } else if (rewrite.detected) {
                // #2709: attribute a framing-absent rewrite to client-native compaction when bili witnessed the client's own compaction being refused — stops the phantom-second-compressor errand.
                const dshWitness = dshNativeCompactionWitness(session, { incomingTotal: rewrite.incomingTotal, knownBefore: rewrite.knownBefore });
                log("warn", `[${sessionId}] ${dshWitness !== undefined ? "client-native compaction landing (framing absent; attributed from refusal ledger)" : "unannounced client history rewrite"} detected (${rewrite.knownIncoming}/${rewrite.incomingTotal} incoming message(s) carry pre-turn refs of ${rewrite.knownBefore} known) — marking compaction boundary (#1001${dshWitness !== undefined ? "/#2709" : ""})`);
                if (dshWitness !== undefined) {
                    recordConflict(session, "native-compaction-inferred", `framing absent on replay; bili refused ${dshWitness} client-native compaction call(s) this session (#1729/#2028) — attributed to client-native compaction [inferred] (${rewrite.knownIncoming}/${rewrite.incomingTotal} incoming carry pre-turn refs of ${rewrite.knownBefore} known, #2709)`);
                } else {
                    recordConflict(session, "unannounced-rewrite", `${rewrite.knownIncoming}/${rewrite.incomingTotal} incoming message(s) carry pre-turn refs of ${rewrite.knownBefore} known`);
                }
                markCompactionBoundary(session);
            }
        }
        applyCompactionArchive(session, activeBefore, new Set(msgs.map((m) => m.id)), log);
        reapOrphansLogged(session, msgs, log, sessionId);
        // [#1271/#1343] plugin mode: acp_retrieve already acked via the tool API; snapshot
        // the queued full text onto THIS forward (stays in the queue until commit/drop, so an
        // upstream failure drops-and-logs it instead of vanishing it).
        if (pluginMode && ccrEnabled(session)) {
            reconcileReloadedRetrievals(session);
            pruneExpiredRetrievals(session);
            attachedRetrievals = snapshotPendingRetrievals(session);
            if (attachedRetrievals.length > 0) processedMessages = [...processedMessages, ...attachedRetrievals.map((i) => i.injection)];
        }
        // #3400: egress image rescale — outbound copies only; the originals
        // stay in session state/persistence untouched.
        const egressMessages = await applyImageRescalePass(processedMessages as BiliMessage[], { session, sessionId, log, maxDim: imageRescaleMaxDim(), toolArmed: imageRescaleToolArmed(session) });
        // #4166: re-voice ONLY bili's own summary carriers (isRenderedSummaryMessage).
        // Client-origin mid system/developer messages (DSH tool_addition and
        // friends) are conversation data — they re-emit verbatim through the
        // kernel's rawOpenaiMessage sidecar and must never change voice (#4159).
        rebuiltMessages = hardenOpenaiAssistantContent(coreToOpenai(systemToUser(egressMessages, (m) => isRenderedSummaryMessage(m))));

        // ONLY the static compress prompt goes into the system message — the
        // system prompt is the prefix-cache anchor and must be byte-stable
        // across turns. The nudge (which changes every turn: token count,
        // growth %, dynamic example) is appended as a trailing user message
        // instead, mirroring pai-acp's design. Putting the nudge in system
        // would invalidate the cache every turn.
        const sysParts: string[] = [];
        if (openaiSystemText) sysParts.push(openaiSystemText);
        let acpStandingPushed = false;
        if (laneDecisions.compressSurfaceOn) { sysParts.push(withProjectAttribution(withMcpDialectNote(withMarkerIntegrityNote(withSummaryBudgetNote(buildCompressSystemPrompt(prompts, messageTimestampSections(conversationPromptSections(surface?.promptSections, externalSummaryEnabled(config)))), externalSummaryEnabled(config)), visibilityMarkers), laneDecisions.mcpDialect))); acpStandingPushed = true; }
        else if (!isTitleGen && !knobRenderNone()) {
            // #1881: the NEVER-echo prohibition follows the rendered tags, not the tool switch.
            const tagsOnly = buildAcpTagsOnlyPrompt("function", prompts, messageTimestampSections(surface?.promptSections));
            if (tagsOnly) { sysParts.push(tagsOnly); acpStandingPushed = true; }
        }
        // #4305: standing generation-boundary note — rides the ACP standing block,
        // byte-stable once detected; never on a view that carries no ACP surface.
        if (acpStandingPushed && detectGenerationBoundary(session, processedMessages, log)) sysParts.push(GENERATION_BOUNDARY_NOTE);
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
            toolsOut = injectOpenaiTool(parsed.tools, [...(absorbActive ? [absorbTools.openai] : []), ...(rulesActive ? [RULE_TOOL_OPENAI] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).openai] : []), ...(imageRescaleToolArmed(session) ? [READ_ORIGINAL_IMAGE_TOOL_OPENAI] : [])], surface?.toolPrompts, ccrEnabled(session), externalSummaryEnabled(config));
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
                    const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections, "openai");
                    const renderedWithPayload = rendered.text;
                    if (rendered.text) {
                        rebuiltMessages = [...rebuiltMessages, { role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withFirstSightDrain(renderedWithPayload, turn.nudge.reason, externalSummaryEnabled(config)), externalSummaryEnabled(config)), visibilityMarkers) }];
                        nudgeOutcome = "injected";
                    } else {
                        nudgeOutcome = "skipped";
                    }
                } catch {
                    nudgeOutcome = "skipped";
                }
            } else if (useDecide) {
                const ranges = turn.nudge.compressibleRanges ?? [];
                // Mirror the post-try strict-echo repair on the stable prefix so
                // the side call's bytes match the main request's cache line.
                const stable = normalizeStrictEchoReasoning([...rebuiltMessages], isStrictReasoningEcho(session, upstreamOrigin, modelIdOf(parsed)), log, sessionId);
                const sideBody: Record<string, unknown> = { ...parsed, messages: [...stable, { role: "user", content: buildDecisionPrompt(ranges) }], tools: toolsOut as OpenAITool[] | undefined, stream: false };
                sideBody[typeof (parsed as Record<string, unknown>).max_completion_tokens === "number" ? "max_completion_tokens" : "max_tokens"] = decide.maxTokens;
                delete sideBody.prompt_cache_retention;
                stripDecisionReasoningFields("openai", sideBody);
                const outcome = await runNudgeDecision({ req, opts, protocol: "openai", sideBody, session, log });
                if (outcome.kind === "yes") {
                    const span = resolveDecisionRange(outcome, ranges);
                    if (span) {
                        rebuiltMessages = [...rebuiltMessages, { role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withFirstSightDrain(buildDirectiveText(span.startRef, span.endRef, outcome.topic), turn.nudge.reason, externalSummaryEnabled(config)), externalSummaryEnabled(config)), visibilityMarkers) }];
                        nudgeOutcome = "injected";
                    } else {
                        nudgeOutcome = "skipped";
                        log("info", `[${sessionId}] [acp-decide] yes but no live range left to target — skipping injection`);
                    }
                } else {
                    nudgeOutcome = "vetoed";
                    // #3004: the verdict line above names the CALL's outcome; this
                    // one names the NUDGE ARM's — a vetoed arm must be greppable
                    // as "nothing was sent" (the pre-fix log claimed INJECT).
                    log("info", `[${sessionId}] [acp-decide] tier-1 nudge arm not injected (${outcome.kind === "failed" ? `decision failed: ${outcome.detail}` : "model declined"}) — nothing sent this round`);
                }
            } else {
                try {
                    const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections, "openai");
                    const renderedWithPayload = rendered.text;
                    if (rendered.text) {
                        rebuiltMessages = [...rebuiltMessages, { role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withFirstSightDrain(renderedWithPayload, turn.nudge.reason, externalSummaryEnabled(config)), externalSummaryEnabled(config)), visibilityMarkers) }];
                        nudgeOutcome = "injected";
                    } else {
                        nudgeOutcome = "skipped";
                    }
                } catch {
                    nudgeOutcome = "skipped";
                }
            }
        } else if (emergencyPressureHeld) {
            nudgeOutcome = "gated";
        }
        // #4521: armed-but-silent window — same carrier + rationale as the
        // anthropic lane (ephemeral trailing user message, current refs
        // instead of model-guessed ones).
        if (turn.statusLine) {
            rebuiltMessages = [...rebuiltMessages, { role: "user", content: turn.statusLine }];
        }
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
    clampOutgoingOutput(rebuilt as Record<string, unknown>, typeof (parsed as Record<string, unknown>).max_completion_tokens === "number" ? "max_completion_tokens" : "max_tokens", { systemText: openaiSystemText, tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, lastInputTokensSource: session.stats.lastInputTokensSource, nativeWindow, headroomWindow: config.modelContextLimit, imageTokens: imageReserveFor(session, "openai", rebuilt, opts, billingUpstream ?? upstreamOrigin), kFactor: currentCalibrationFactor(session.stats, session.metadata?.lastModel), kOrigin: session.stats.calibratedEstimateOrigin, origin: billingUpstream ?? upstreamOrigin, ledgerFloorTokens: dshLedgerFloorTokens(session.metadata), knownOutputCeiling: resolveKnownOutputCeiling(req.headers, parsed as Record<string, unknown>, opts.routes, billingUpstream ?? upstreamOrigin, opts.sessionHeader, modelIdOf(parsed)) }, sessionId, log, (c) => { session.stats.lastOutputClamp = { ...c, at: Date.now() }; });
    // prompt_cache_retention is an OpenAI-host-only cache directive; the dsh
    // launcher forces PI_CACHE_RETENTION=long (for the session-id
    // prompt_cache_key) which makes the client also emit it. Third-party
    // OpenAI-compatible upstreams may reject unknown fields, and cache policy
    // is the upstream's business — strip it. prompt_cache_key itself passes
    // through: upstreams that ignore it lose nothing, upstreams that use it
    // get a per-conversation routing hint.
    delete (rebuilt as Record<string, unknown>).prompt_cache_retention;
    // #2218/#2645/#5079: body-only relay affinity for plugin hosts. dsh
    // desktop's only identity signal is the bili-internal
    // x-bili-plugin-conversation header (already forwarded as x-session-id by
    // buildForwardTarget); body-keyed relays (workbuddy panel) can't read
    // headers, so stamping writes the conversation id into prompt_cache_key.
    // #5079 gated the stamp behind promptCache.routing (default now DISABLED —
    // most upstreams neither use nor tolerate the field): auto/enabled keep
    // the #2645 default-on-for-every-destination behavior with the egress 400
    // A/B seam as the rejection backstop; disabled never emits a bili-owned
    // key but still forwards genuine client keys verbatim (and still honors
    // an A/B ablation against them).
    const pckDecision = resolveRelayAffinityPck(conversationHeaderSource(req.headers)?.name, parsed.prompt_cache_key, billingUpstream, upstreamOrigin, effectivePromptCacheRouting(opts.promptCache), session.id, modelIdOf(parsed));
    if (pckDecision === "stamp") {
        rebuilt.prompt_cache_key = session.id;
    } else if (pckDecision === "drop") {
        delete (rebuilt as Record<string, unknown>).prompt_cache_key;
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
        // One tree walk shared by both calibers (see the anthropic lane).
        const imageReserve = imageReserveFor(session, "openai", rebuilt, opts, billingUpstream ?? upstreamOrigin);
        session.stats.localInputEstimate = estimateCoreMessagesUpper(processedMessages.length > 0 ? processedMessages : originalMessages)
            + countSystemAndToolsTokens(openaiOutboundSystem || openaiSystemText, toolsOut)
            + imageReserve;
        // #1933 F1: billed-caliber twin (chars/4) for the k̂ learning pair —
        // see the anthropic-lane counterpart above.
        session.stats.lastLocalTextEstimate = estimateCoreMessages(processedMessages.length > 0 ? processedMessages : originalMessages)
            + countSystemAndToolsTokens(openaiOutboundSystem || openaiSystemText, toolsOut)
            + imageReserve;
        const openaiPairOrigin = billingUpstream ?? upstreamOrigin;
        if (openaiPairOrigin) session.stats.lastLocalTextEstimateOrigin = openaiPairOrigin;
        // #4805: id-membership evidence for the settle gate (see the
        // anthropic-lane counterpart) — chat wire has no msgid envelope, so
        // evidence is the tool-call ids resent in the history.
        probeRequestMembership(session, collectRequestIds(undefined, processedMessages.length > 0 ? processedMessages : originalMessages), session.stats.localInputEstimate ?? 0);
    }
    snapshotMessages(session, originalMessages);
    markDirty(session);
    return { body: JSON.stringify(rebuilt), parsedBody: rebuilt, session, attachedRetrievals, attachedRetrievalNoteIds, processedMessages, originalMessages, judgeBaseline, protocol: "openai", stream, compressInjected: injectTools, pluginMode, mcpDialectNote: laneDecisions.mcpDialect, nudge, nudgeOutcome, prompts, surface, openaiSystemText, systemNotes: sysNotes, renderTags: renderStrategy, dropReasoning: (msgs: BiliMessage[]) => applyReasoningDrop(msgs, reasoningPlan, log, sessionId) } as Prepared;
}

/** Append the ephemeral nudge to a Gemini `contents` array. Gemini is
 *  strict about role alternation, so a trailing user turn is merged into
 *  rather than appended to (the nudge then reads as the model's last input,
 *  which is where it belongs); a model-final history gets a fresh user turn
 *  because a request must not end on the model side. */
