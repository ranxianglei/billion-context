import http from "node:http";
import type { CompressionCore, Config, CoreMessage, NudgeDecision, PackSurface, Prompts } from "acp-kernel";
import { renderNudgeText, viableRanges } from "acp-kernel";
import { coreToGoogle, googleToCore, normalizeGoogleUserPartOrder, type BiliMessage, type GoogleContent, type GoogleRequestBody, type GoogleSystemInstruction, type GoogleTool } from "acp-kernel/wire";
import type { ProxyOptions } from "../config.js";
import { pluginAgentHeader } from "../plugin.js";
import { currentCalibrationFactor } from "../util.js";
import { diagNudge, diagTagSummary, deriveTitle, effectiveTokenCount, imageBillingFor, imageReserveFor, imageTokenCapFor, isAutoInjectedNotification, reapOrphansLogged, resolveKnownOutputCeiling, runNudgeDecision, stripKernelSummaries, usageGradeInputBaseline, type Prepared } from "../server.js";
import { yieldToEventLoop } from "../yield-loop.js";
import { buildDecisionPrompt, buildDirectiveText, consumeFallback, ladderMode, resolveDecisionRange, stripDecisionReasoningFields, type DecideConfig } from "../nudge-decide.js";
import { excludeDeadRefRanges } from "../acp-status.js";
import { reconcileFoldCoverage, noteSystemPromptFingerprint, resolveFoldReconcileMode } from "../fold-reconcile.js";
import { maybeSnapshotView } from "./snapshot-render.js";
import { storedMessagesFor } from "../fold-decomposition-lookup.js";
import { nudgeSuppressed } from "../session-self-heal.js";
import { compressBreakerArmed } from "../stream.js";
import { applyCompactionArchive, coveredRealHistoryIds, detectUnannouncedHistoryRewrite, foldCoverage, markCompactionBoundary, markDirty, markNativeCompactionBoundary, reconcileNativeCompactionBoundary, REWRITE_MIN_INCOMING_TOTAL, snapshotMessages, type Session } from "../session.js";
import { recordConflict } from "../conflict-watch.js";
import { carriesDshLocalCompactionSummary, DSH_LOCAL_COMPACTION_MIN_MISSING } from "./dsh-compaction-guard.js";
import { carriesBiliSnapshotCheckpoint } from "./dsh-authored-compaction.js";
import { ABSORB_TOOL_NAME, READ_ORIGINAL_IMAGE_TOOL_GOOGLE, RULE_TOOL_GOOGLE, absorbToolsFor, buildAbsorbSystemPrompt, buildAcpTagsOnlyPrompt, buildCompressSystemPrompt, retrieveToolsFor, withFirstSightDrain, withMarkerIntegrityNote, withMcpDialectNote, withSummaryBudgetNote, withProjectAttribution } from "../compress-tool.js";
import { absorbToolName, applyAbsorbView, storeEffectiveAbsorb } from "../absorb.js";
import { adoptContentStore, ccrEnabled, ccrLoopConfig, contentStoreOf, imageRescaleToolArmed, retrieveToolName } from "../store.js";
import { rulesEnabled, storeEffectiveRules } from "../rules-feature.js";
import { autoFoldEngaged, autoFoldFloor, conversationPromptSections, externalSummaryEnabled, growthFoldingArmed } from "../external-summary-surface.js";
import { filterDeadRanges } from "../dead-ranges.js";
import { detectGenerationBoundary, GENERATION_BOUNDARY_NOTE } from "../generation-boundary.js";
import { attachSubagentSessions } from "../subagent-sessions.js";
import { reconcileSystemAnchor } from "../system-anchor.js";
import { logRawStripCounts, markerArtifactCount, stripRawStage } from "../marker/engine.js";
import { imageRescaleMaxDim, renderNone as knobRenderNone } from "../knobs.js";
import { applyImageRescalePass } from "../image-rescale.js";
import { clampOutgoingOutput, countSystemAndToolsTokens, dshLedgerFloorTokens, emergencyNudge, emergencyNudgeArmed } from "./budget.js";
import { estimateCoreMessages } from "../preflight.js";
import { effectiveAbsorbBlock } from "./prepare-responses.js";
import { injectGoogleTool, injectTool } from "./inject.js";
import { nudgeOn, resolveLaneDecisions, surfaceOffDetail } from "./lane-decisions.js";

function appendGoogleNudge(contents: GoogleContent[], text: string): GoogleContent[] {
    const last = contents[contents.length - 1];
    if (last && (last.role ?? "user") !== "model") {
        const parts = Array.isArray(last.parts) ? last.parts : [];
        // #3159: a plain-text tail after a functionResponse part 400s on
        // Vertex — normalize so the new text leads.
        return [
            ...contents.slice(0, -1),
            { ...last, parts: normalizeGoogleUserPartOrder([...parts, { text }]) },
        ];
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
export async function prepareGoogle(
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
    req: http.IncomingMessage,
    decide?: DecideConfig,
): Promise<Prepared> {
    const sessionId = session.id;
    ++session.stats.requests;
    const inboundMessageCount = Array.isArray(parsed.contents) ? parsed.contents.length : 1;
    let googleClientSystem = "";
    let sysNotes: string[] = [];
    let googleOutboundSystem: string | undefined;
    let systemInstruction: GoogleSystemInstruction | undefined = parsed.systemInstruction;
    let processedMessages: CoreMessage[] = [];
    let originalMessages: CoreMessage[] = [];
    let judgeBaseline: readonly CoreMessage[] | undefined;
    let nudge: NudgeDecision | undefined;
    let nudgeOutcome: Prepared["nudgeOutcome"];
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
    // #3417: surface gating lives in lane-decisions (observed reachability
    // overrides the dsh default, #3401); alias kept for the remaining reads.
    const laneDecisions = resolveLaneDecisions({ protocol: "google", pluginMode, pluginAgent: typeof session.metadata["pluginAgent"] === "string" ? session.metadata["pluginAgent"] as string : undefined, parsed, shouldInject, pluginHeaderPresent: pluginAgentHeader(req.headers) !== undefined });
    // #2483: this lane used to ignore renderNone entirely (hardcoded "text-only"
    // in processTurn, Prepared and countTokens) — the knob was dead config on /v1beta.
    const renderStrategy = knobRenderNone() ? "none" : "text-only";

    // #2798: google previously only stripped chain carriers — panels, status
    // marker lines and report bodies rode the rebuild unseen (the old generic
    // walk cannot read content.parts). stripRawStage owns the google walk.
    const markerCounts = stripRawStage(parsed, "google");
    logRawStripCounts(markerCounts, log, sessionId);

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
        // #3756 snapshot render: the outbound prefix renders from the unified
        // transcript (server-authoritative, fold-time ids — immune to identity
        // re-mints #3752); only the live tail keeps the client's bytes.
        // No-op returns `msgs` when the lane is inactive/degraded.
        // reconcileFoldCoverage below still observes the CLIENT view.
        // (#651 keeps reasoning-drop off this wire — Gemini validates
        // thoughtSignature — so only tokenCount + processTurn consume the
        // render view, unlike the openai/responses lanes' third consumer.)
        const renderMsgs = maybeSnapshotView(session, msgs, { sessionId, pluginMode, log });
        // #4241: the render lane replaced the view (reference-inequality is the
        // discriminator — maybeSnapshotView returns the SAME array when idle),
        // so the judged baseline is the rendered transcript, not the inbound.
        judgeBaseline = renderMsgs !== msgs ? renderMsgs : undefined;
        // #1001: pre-turn snapshot — processTurn below assigns fresh refs to every
        // previously-unknown id, which would make rewrite detection read 1.0.
        const knownRefsBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
        const { tokens: tokenCount, source: tokenCountSource } = effectiveTokenCount(session, renderMsgs, imageReserveFor(session, "google", parsed, opts, upstreamOrigin));
        const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
        const absorbBlock = effectiveAbsorbBlock(pluginMode, config, opts.compress.absorb);
        const absorbTools = absorbToolsFor(absorbBlock?.toolName ?? ABSORB_TOOL_NAME);
        const absorbActive = absorbBlock?.enabled === true && shouldInject;
        // acp_rule has no processTurn side effect (no markers/instructions are
        // ever injected into messages), so unlike absorb it needs no loop-
        // config stripping — only tool availability matters.
        const rulesActive = rulesEnabled(config) && shouldInject;
        const loopConfig = ccrLoopConfig(session, { ...config, absorb: absorbActive ? absorbBlock : undefined });
        // #2432/#2658: same post-landing recovery as the openai/responses/
        // anthropic lanes — dsh desktop's native compaction can land without
        // transiting bili (direct-bypass / future gate mismatch); first notice =
        // this request replaying [checkpoint summary,
        // retained tail…] against the same session id. Before #2658 every lane
        // except openai/responses left such a landing unrebased (cannot-be-
        // anchored death spiral + prefix-cache loss). Dual signal only:
        // checkpoint framing in resent history AND decimated fold coverage;
        // detection runs BEFORE reconcileFoldCoverage/processTurn. No known
        // dsh+google traffic yet — this closes the same hole on the fourth wire.
        if (!isTitleGen && laneDecisions.profile.compactsClientSide && session.state.blocks.some((b) => b.active)) {
            const coveredBeforeDshCompact = coveredRealHistoryIds(session.state.blocks); // #2627: same real-history caliber
            const dshGap = foldCoverage(coveredBeforeDshCompact, msgs.map((m) => m.id));
            if (dshGap && (carriesDshLocalCompactionSummary(msgs) || carriesBiliSnapshotCheckpoint(msgs))) {
                const missing = dshGap.expected - dshGap.matched;
                if (missing >= DSH_LOCAL_COMPACTION_MIN_MISSING && missing * 2 >= dshGap.expected) {
                    // #3733: our own <bili-snapshot v1 …/> tag = authored checkpoint.
                    const authored = carriesBiliSnapshotCheckpoint(msgs);
                    if (authored) session.metadata.dshAuthoredCheckpointLanded = true;
                    recordConflict(session, "native-compaction", `dsh native compaction: ${missing}/${dshGap.expected} covered id(s) replaced by the compacted history; ACP state rebased (#2432)`);
                    log(authored ? "info" : "warn", `[${sessionId}] dsh ${authored ? "AUTHORED checkpoint landed" : "native compaction detected"} (${dshGap.matched}/${dshGap.expected} covered id(s) retained, checkpoint framing in resent history) — ${authored ? "rebasing ACP state onto the authored bili-snapshot checkpoint (#3733)" : "rebasing ACP state onto the compacted history (#2432)"}`);
                    markNativeCompactionBoundary(session);
                    reconcileNativeCompactionBoundary(session);
                }
            }
        }
        // [#1921] re-anchor fold coverage onto churned-but-same messages
        // before the #1195 snapshot, so covered ids surviving a client
        // re-serialization stay covered (src/fold-reconcile.ts).
        const foldMode = resolveFoldReconcileMode(process.env, opts.compress.reconcile);
        const reconcileOutcome = reconcileFoldCoverage(session, msgs, { mode: foldMode, sessionId, log, markerStripped: markerArtifactCount(markerCounts), inboundMessageCount, storedMessages: foldMode === "off" ? undefined : storedMessagesFor(session, sessionId, msgs) });
        if (!isTitleGen) noteSystemPromptFingerprint(session, systemText, { sessionId, log });
        // #1195: pre-turn snapshot of the fold's covered ids — syncBlocks inside
        // processTurn may deactivate fully-drifted blocks, erasing them.
        const foldCoveredBefore = session.stats.pendingFoldUsage === true
            ? coveredRealHistoryIds(session.state.blocks)
            : null;
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
        // #2155: a self-heal-suppressed session stops nagging. #3004: the decide
        // ladder's fallback is the ONE exception — it is the failure-recovery path
        // and must reach the model even while suppression is latched, or the two
        // mechanisms dead-lock (suppression gates this flag, which gates the branch
        // that breaks it; release waits on compression only a nudge could prompt).
        // Self-limiting: consumeFallback resets on the same round, so at most one
        // advisory punches through per 3 consecutive decision failures.
        const decideTier1Arm = decide !== undefined && !!turn.nudge && turn.nudge.tier === 1 && turn.nudge.breakdown.emergencyOverride !== 1;
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
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, model, willInjectNudge, decideTier1Arm && !decideFallbackOverride, surfaceOffDetail(laneDecisions, opts.compress.injectTool)));
        processedMessages = stripKernelSummaries(turn.messages, turn.state);
        // #1001: a silent client history rewrite takes the same archive+prune path
        // as an announced /compact boundary — syncBlocks above has already
        // deactivated the blocks whose sources left the context.
        {
            const rewrite = detectUnannouncedHistoryRewrite(session, knownRefsBefore, msgs.map((m) => m.id), reconcileOutcome);
            if (rewrite.churnExplained) {
                // #4131: cross-build id re-mint (#3642) — fold-reconcile found every
                // covered id on the wire; adopt instead of destroying.
                recordConflict(session, "id-churn-adoption", `${rewrite.knownIncoming}/${rewrite.incomingTotal} incoming message(s) carry pre-turn refs of ${rewrite.knownBefore} known; fold-reconcile re-anchored every covered id (0 unmatched) — bili-side id re-mint across builds (#3642), not a client rewrite — no compaction boundary (#4131)`);
                log("info", `[${sessionId}] cross-build id churn adopted: hash-identity collapse (${rewrite.knownIncoming}/${rewrite.incomingTotal} pre-turn refs of ${rewrite.knownBefore} known) explained by fold-reconcile full re-anchor (0 unmatched) — skipping compaction boundary (#4131/#3642)`);
            } else if (rewrite.detected) {
                log("warn", `[${sessionId}] unannounced client history rewrite detected (${rewrite.knownIncoming}/${rewrite.incomingTotal} incoming message(s) carry pre-turn refs of ${rewrite.knownBefore} known) — marking compaction boundary (#1001)`);
                recordConflict(session, "unannounced-rewrite", `${rewrite.knownIncoming}/${rewrite.incomingTotal} incoming message(s) carry pre-turn refs of ${rewrite.knownBefore} known`);
                markCompactionBoundary(session);
            }
        }
        applyCompactionArchive(session, activeBefore, new Set(msgs.map((m) => m.id)), log);
        reapOrphansLogged(session, msgs, log, sessionId);
        // #3400: egress image rescale — outbound copies only; the originals
        // stay in session state/persistence untouched.
        const egressMessages = await applyImageRescalePass(processedMessages as BiliMessage[], { session, sessionId, log, maxDim: imageRescaleMaxDim(), toolArmed: imageRescaleToolArmed(session) });
        rebuiltContents = coreToGoogle(egressMessages);

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
        let acpStandingPushed = false;
        if (laneDecisions.compressSurfaceOn) { sysParts.push(withProjectAttribution(withMcpDialectNote(withMarkerIntegrityNote(withSummaryBudgetNote(buildCompressSystemPrompt(prompts, conversationPromptSections(surface?.promptSections, externalSummaryEnabled(config))), externalSummaryEnabled(config)), visibilityMarkers), laneDecisions.mcpDialect))); acpStandingPushed = true; }
        else if (!isTitleGen && renderStrategy !== "none") {
            // #1881: the NEVER-echo prohibition follows the rendered tags, not the tool switch.
            const tagsOnly = buildAcpTagsOnlyPrompt("function", prompts, surface?.promptSections);
            if (tagsOnly) { sysParts.push(tagsOnly); acpStandingPushed = true; }
        }
        // #4305: standing generation-boundary note — rides the ACP standing block,
        // byte-stable once detected; never on a view that carries no ACP surface.
        if (acpStandingPushed && detectGenerationBoundary(session, processedMessages, log)) sysParts.push(GENERATION_BOUNDARY_NOTE);
        if (absorbActive) sysParts.push(buildAbsorbSystemPrompt(absorbToolName(loopConfig)));
        googleOutboundSystem = sysParts.join("\n\n");
        // Untouched when nothing was added beyond the client's own text: the
        // original `systemInstruction` object then rides through byte-identical
        // instead of being re-serialized into a new shape.
        const extraSystemParts = sysParts.slice(googleClientSystem ? 1 : 0);
        systemInstruction = extraSystemParts.length > 0 ? { parts: sysParts.map((text) => ({ text })) } : parsed.systemInstruction;
        if (injectTools) {
            toolsOut = injectGoogleTool(parsed.tools, [...(absorbActive ? [absorbTools.google] : []), ...(rulesActive ? [RULE_TOOL_GOOGLE] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).google] : []), ...(imageRescaleToolArmed(session) ? [READ_ORIGINAL_IMAGE_TOOL_GOOGLE] : [])], surface?.toolPrompts, ccrEnabled(session), externalSummaryEnabled(config));
        }
        if (sysNotes.length > 0) {
            rebuiltContents = appendGoogleNudge(rebuiltContents, sysNotes.join("\n\n---\n\n"));
        }
        if (willInjectNudge && turn.nudge) {
            // #2228: model-decided timing (see prepareAnthropic for the policy):
            // gentle/over-limit T1 arms ask the model first; EMERGENCY and
            // tier>=2 keep the legacy advisory.
            const useDecide = decide !== undefined && turn.nudge.tier === 1 && turn.nudge.breakdown.emergencyOverride !== 1;
            if (useDecide && ladderMode(session.metadata) === "fallback") {
                consumeFallback(session.metadata);
                try {
                    const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections, "google");
                    const renderedWithPayload = rendered.text;
                    if (rendered.text) {
                        rebuiltContents = appendGoogleNudge(rebuiltContents, withMarkerIntegrityNote(withFirstSightDrain(renderedWithPayload, turn.nudge.reason, externalSummaryEnabled(config)), visibilityMarkers));
                        nudgeOutcome = "injected";
                    } else {
                        nudgeOutcome = "skipped";
                    }
                } catch {
                    nudgeOutcome = "skipped";
                }
            } else if (useDecide) {
                const ranges = turn.nudge.compressibleRanges ?? [];
                const sideBody: Record<string, unknown> = { ...parsed, contents: [...rebuiltContents, { role: "user", parts: [{ text: buildDecisionPrompt(ranges) }] }], tools: toolsOut, systemInstruction, generationConfig: { ...(parsed.generationConfig ?? {}), maxOutputTokens: decide.maxTokens } };
                stripDecisionReasoningFields("google", sideBody);
                const outcome = await runNudgeDecision({ req, opts, protocol: "google", sideBody, session, log });
                if (outcome.kind === "yes") {
                    const span = resolveDecisionRange(outcome, ranges);
                    if (span) {
                        rebuiltContents = appendGoogleNudge(rebuiltContents, withMarkerIntegrityNote(withFirstSightDrain(buildDirectiveText(span.startRef, span.endRef, outcome.topic), turn.nudge.reason, externalSummaryEnabled(config)), visibilityMarkers));
                        nudgeOutcome = "injected";
                    } else {
                        nudgeOutcome = "skipped";
                        log("info", `[${sessionId}] [acp-decide] yes but no live range left to target — skipping injection`);
                    }
                } else {
                    nudgeOutcome = "vetoed";
                    // #3004: arm-level delivery truth (see the openai-lane note).
                    log("info", `[${sessionId}] [acp-decide] tier-1 nudge arm not injected (${outcome.kind === "failed" ? `decision failed: ${outcome.detail}` : "model declined"}) — nothing sent this round`);
                }
            } else {
                try {
                    const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections, "google");
                    const renderedWithPayload = rendered.text;
                    if (rendered.text) {
                        rebuiltContents = appendGoogleNudge(rebuiltContents, withMarkerIntegrityNote(withFirstSightDrain(renderedWithPayload, turn.nudge.reason, externalSummaryEnabled(config)), visibilityMarkers));
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
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    const rebuilt: GoogleRequestBody = { ...parsed, contents: rebuiltContents, tools: toolsOut, systemInstruction };
    clampOutgoingOutput(rebuilt as Record<string, unknown>, "generationConfig.maxOutputTokens", { systemText: googleClientSystem, tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, lastInputTokensSource: session.stats.lastInputTokensSource, nativeWindow, headroomWindow: config.modelContextLimit, imageTokens: imageReserveFor(session, "google", rebuilt, opts, upstreamOrigin), kFactor: currentCalibrationFactor(session.stats, session.metadata?.lastModel), kOrigin: session.stats.calibratedEstimateOrigin, origin: upstreamOrigin, ledgerFloorTokens: dshLedgerFloorTokens(session.metadata), knownOutputCeiling: resolveKnownOutputCeiling(req.headers, parsed as Record<string, unknown>, opts.routes, upstreamOrigin, opts.sessionHeader, model) }, sessionId, log, (c) => { session.stats.lastOutputClamp = { ...c, at: Date.now() }; });
    // #532: title-gen side requests carry their own tiny system — skip them.
    if (!isTitleGen && googleOutboundSystem !== undefined) {
        session.metadata.systemPromptTokens = countSystemAndToolsTokens(googleOutboundSystem, toolsOut);
    }
    // #1933 F1 + #2407: billed-caliber denominator of the k̂ learning pair.
    // The Google lane was the only one of the four never recording it, so
    // Gemini-native routes could never learn the calibration factor and
    // stayed raw-estimate caliber forever. Mirrors the anthropic/openai/
    // responses lanes (same estimateCoreMessages caliber, projected thinking
    // mass included); title-gen side requests skip like the rows above.
    if (!isTitleGen) {
        session.stats.lastLocalTextEstimate = estimateCoreMessages(processedMessages.length > 0 ? processedMessages : originalMessages)
            + countSystemAndToolsTokens(googleOutboundSystem ?? "", toolsOut)
            + imageReserveFor(session, "google", rebuilt, opts, upstreamOrigin);
        if (upstreamOrigin) session.stats.lastLocalTextEstimateOrigin = upstreamOrigin;
    }
    snapshotMessages(session, originalMessages);
    markDirty(session);
    return { body: JSON.stringify(rebuilt), session, processedMessages, originalMessages, judgeBaseline, protocol: "google", stream, compressInjected: injectTools, pluginMode, mcpDialectNote: laneDecisions.mcpDialect, nudge, nudgeOutcome, prompts, surface, google: { system: googleClientSystem, model }, systemNotes: sysNotes, renderTags: renderStrategy } as Prepared;
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
        const turn = core.processTurn({ messages: msgs, state: session.state, config: ccrLoopConfig(session, config), tokenCount: usageGradeInputBaseline(session), renderTags: knobRenderNone() ? "none" : "text-only", contentStore: contentStoreOf(session) });
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
