import http from "node:http";
import type { CompressionCore, Config, CoreMessage, NudgeDecision, PackSurface, Prompts } from "acp-kernel";
import { renderNudgeText, viableRanges } from "acp-kernel";
import { anthropicToCore, buildSystem, coreToAnthropic, extractSystem, type AnthropicRequestBody, type BiliMessage } from "acp-kernel/wire";
import { rewriteInboundThreadContinue } from "./thread-tracking.js";
import { captureThreadsTurn, estimateThreadsTokens, isThreadsBody, threadsReforgeEnabled } from "./threads-lane.js";
import type { CompressReasoningConfig } from "../reasoning-drop.js";
import type { ProxyOptions } from "../config.js";
import { pluginAgentHeader } from "../plugin.js";
import { applyReasoningDrop, diagNudge, diagTagSummary, deriveTitle, effectiveTokenCount, imageBillingFor, imageReserveFor, imageTokenCapFor, isAutoInjectedNotification, planReasoningDrop, reapOrphansLogged, runNudgeDecision, stripKernelSummaries, warnAnthropicThinkingPairs, type Prepared } from "../server.js";
import { buildDecisionPrompt, buildDirectiveText, consumeFallback, ladderMode, resolveDecisionRange, stripDecisionReasoningFields, type DecideConfig } from "../nudge-decide.js";
import { excludeDeadRefRanges } from "../acp-status.js";
import { outboundBiliSurface, reconcileFoldCoverage, noteBiliToolSurface, noteSystemPromptFingerprint, resolveFoldReconcileMode } from "../fold-reconcile.js";
import { maybeSnapshotView } from "./snapshot-render.js";
import { storedMessagesFor } from "../fold-decomposition-lookup.js";
import { nudgeSuppressed } from "../session-self-heal.js";
import { compressBreakerArmed } from "../stream.js";
import { applyCompactionArchive, coveredRealHistoryIds, detectUnannouncedHistoryRewrite, foldCoverage, markCompactionBoundary, markDirty, markNativeCompactionBoundary, reconcileNativeCompactionBoundary, REWRITE_MIN_INCOMING_TOTAL, snapshotMessages, type PendingRetrieval, type Session } from "../session.js";
import { carriesDshLocalCompactionSummary, DSH_LOCAL_COMPACTION_MIN_MISSING } from "./dsh-compaction-guard.js";
import { carriesBiliSnapshotCheckpoint } from "./dsh-authored-compaction.js";
import { ABSORB_TOOL_NAME, READ_ORIGINAL_IMAGE_TOOL, RULE_TOOL, absorbToolsFor, retrieveToolsFor, withFirstSightDrain, withMarkerIntegrityNote, withSummaryBudgetNote } from "../compress-tool.js";
import { applyAbsorbView, storeEffectiveAbsorb } from "../absorb.js";
import { adoptContentStore, ccrEnabled, ccrLoopConfig, contentStoreOf, dropRetrievals, imageRescaleToolArmed, pruneExpiredRetrievals, reconcileReloadedRetrievals, renderRetrievalNotes, retrieveToolName, snapshotPendingRetrievals, snapshotRetrievalNotes } from "../store.js";
import { rulesEnabled, storeEffectiveRules } from "../rules-feature.js";
import { autoFoldEngaged, autoFoldFloor, externalSummaryEnabled, growthFoldingArmed } from "../external-summary-surface.js";
import { filterDeadRanges } from "../dead-ranges.js";
import { detectGenerationBoundary } from "../generation-boundary.js";
import { attachSubagentSessions } from "../subagent-sessions.js";
import { estimateCoreMessages, estimateCoreMessagesUpper, extractBillingAttributionBlock } from "../preflight.js";
import { dshNativeCompactionWitness, recordConflict } from "../conflict-watch.js";
import { anthropicToolsCarryCacheControl, computeAnthropicMessageMarks, stampAnthropicSystemCacheControl } from "../loop/cache-control.js";
import { reconcileSystemAnchor } from "../system-anchor.js";
import { isStrictReasoningEcho, modelIdOf } from "../strict-echo.js";
import { logRawStripCounts, markerArtifactCount, stripRawStage } from "../marker/engine.js";
import { imageRescaleMaxDim, renderNone as knobRenderNone } from "../knobs.js";
import { applyImageRescalePass } from "../image-rescale.js";
import { isAutoModeClassifier } from "../auto-mode-forge.js";
import { countSystemAndToolsTokens, emergencyNudge, emergencyNudgeArmed, projectThinkingMass } from "./budget.js";
import { effectiveAbsorbBlock } from "./prepare-responses.js";
import { injectSystem, injectTool } from "./inject.js";
import { nudgeOn, resolveLaneDecisions, surfaceOffDetail } from "./lane-decisions.js";
import { featureEnabled } from "../rollout.js";
import { MSG_IDS_BODY_FIELD, MSG_SEQS_BODY_FIELD, applyMsgIdPin, applyMsgSeqStamps, validateMsgIds, validateMsgSeqs } from "../msgid-pin.js";
import { collectRequestIds, probeRequestMembership } from "../request-membership.js";
import { alignIdSet, looksLikeSummaryCarrier } from "../msgid-algebra.js";
import { yieldToEventLoop } from "../yield-loop.js";

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
    /** The route's resolved model, when the caller already has one. On the
     *  Anthropic-on-Vertex wire the body carries `anthropic_version` and no
     *  `model`, so the diag line below would otherwise print `undefined`. */
    resolvedModel?: string,
    decide?: DecideConfig,
): Promise<Prepared> {
    const sessionId = session.id;
    const stream = parsed.stream === true;
    const inboundMessageCount = Array.isArray(parsed.messages) ? parsed.messages.length : 1;
    // #4491: bili-namespaced msgid channel. Stripped UNCONDITIONALLY — the real
    // upstream must never see a field it doesn't know (same discipline as
    // prompt_cache_key below); pinning happens after core conversion, gated.
    const incomingMsgIds = (parsed as Record<string, unknown>)[MSG_IDS_BODY_FIELD];
    delete (parsed as Record<string, unknown>)[MSG_IDS_BODY_FIELD];
    const incomingMsgSeqs = (parsed as Record<string, unknown>)[MSG_SEQS_BODY_FIELD];
    delete (parsed as Record<string, unknown>)[MSG_SEQS_BODY_FIELD];
    ++session.stats.requests;
    const injectTools = opts.compress.injectTool && !pluginMode;
    // #3417: lane decisions (profile + per-wire observation) own the
    // surface gates; the dsh* alias stays for the remaining reads in this
    // file (Step 3 of #3417 renames the consumers).
    const laneDecisions = resolveLaneDecisions({
        protocol: "anthropic",
        pluginMode,
        pluginAgent: typeof session.metadata["pluginAgent"] === "string" ? session.metadata["pluginAgent"] as string : undefined,
        parsed,
        shouldInject: opts.compress.injectTool,
        pluginHeaderPresent: pluginAgentHeader(req.headers) !== undefined,
    });
    // #3222: #651's reasoning-drop plan, computed on the INBOUND history before
    // core.processTurn — see planReasoningDrop for why the post-turn view is too late.
    let reasoningPlan = new Set<string>();

    if (isAutoModeClassifier(parsed)) {
        log("info", `[${sessionId}] auto-mode classifier passthrough (skipping compress injection)`);
        return { body: JSON.stringify(parsed), session, processedMessages: [], originalMessages: [], anthropicSystem: parsed.system, protocol: "anthropic", stream, compressInjected: false, pluginMode, nudge: undefined, prompts, surface } as Prepared;
    }

    // [#2926] anthropic Threads lane — BEFORE the #2648 global-scope stand-down:
    // Claude Code's own main loop runs threads with a global-scope system
    // block, so the ordering decides which lane claims the turn (#2884: the
    // stand-down swallowed whole CC sessions and silently disabled folding).
    // Threads state lives server-side; `continue` bodies carry only deltas,
    // so bili's history-rewrite lever does not exist here. Mirror the turn
    // into the unified store (capture is always on where the sidecar lives),
    // forward byte-faithfully, and arm a reforge when the mirror crossed the
    // window — the only channel that can deliver a fold to a server-side
    // thread is a fresh `create`. handle.ts executes the plan.
    if (!pluginMode && isThreadsBody(parsed)) {
        const mirror = captureThreadsTurn(sessionId, parsed, log);
        const prepared: Prepared = {
            body: JSON.stringify(parsed),
            session,
            processedMessages: [],
            originalMessages: [],
            anthropicSystem: parsed.system,
            protocol: "anthropic",
            stream,
            compressInjected: false,
            pluginMode,
            nudge: undefined,
            prompts,
            surface,
            threadsLane: true,
        } as Prepared;
        const threadsWindow = opts.modelContextLimit && opts.modelContextLimit > 0 ? opts.modelContextLimit : 200_000;
        if (
            mirror.available &&
            (parsed.thread as { type?: unknown }).type === "continue" &&
            threadsReforgeEnabled() &&
            estimateThreadsTokens(mirror.meta, mirror.entries) > threadsWindow
        ) {
            prepared.threadsReforge = {
                sessionId,
                entries: mirror.entries,
                meta: mirror.meta,
                windowTokens: threadsWindow,
            };
        }
        return prepared;
    }

    // #2648: when the host pins a system block to cache_control.scope:"global",
    // Anthropic renders tools BEFORE system, so the six ACP tools bili injects here
    // (narrower scope) land ahead of a global block → upstream 400 ("scope:global …
    // found after content with a narrower cache scope"). Global-scope caching is the
    // host's own cross-prompt posture; bili's per-session injection cannot sit ahead
    // of it, so stand down (forward untouched) rather than 400. Healthy main turns
    // use ephemeral/unscoped system, so they keep full compression.
    if (!pluginMode && hasGlobalScopeSystem(parsed)) {
        log("info", `[${sessionId}] global-scope system passthrough (skipping compress injection, #2648)`);
        return { body: JSON.stringify(parsed), session, processedMessages: [], originalMessages: [], anthropicSystem: parsed.system, protocol: "anthropic", stream, compressInjected: false, pluginMode, nudge: undefined, prompts, surface } as Prepared;
    }

    // #2701: anthropic Threads — retarget an inbound continue whose target
    // the proxy itself already consumed (compress-loop internal rounds) to
    // the tracked tail, and reset tracking on a create. Runs BEFORE any
    // rebuild so the mutation rides the {...parsed} spread into every
    // downstream body. Ids the proxy never observed pass through untouched.
    rewriteInboundThreadContinue(parsed as unknown as { thread?: unknown }, session, log, sessionId);

    let processedMessages: CoreMessage[] = [];
    let attachedRetrievals: PendingRetrieval[] = [];
    let attachedRetrievalNoteIds: string[] = [];
    let originalMessages: CoreMessage[] = [];
    let judgeBaseline: readonly CoreMessage[] | undefined;
    let nudge: NudgeDecision | undefined;
    let nudgeOutcome: Prepared["nudgeOutcome"];
    let rebuiltMessages = parsed.messages;
    let anthropicCacheMarks: Map<string, { type: "ephemeral" }> | undefined;
    let clientCacheControls: Map<string, unknown> | undefined;
    let systemOut = parsed.system;
    let toolsOut = parsed.tools;
    // #2483: single source for the effective render strategy — processTurn, the
    // diag log and Prepared must all report what was actually rendered (the
    // log label used to hardcode "text-only" and lie under renderNone).
    const renderStrategy = knobRenderNone() ? "none" : "text-only";

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
    // #2189: from clientSystem (pre-anchor) — the anchor buildSystem below may
    // collapse the block array, and subscription-OAuth upstreams 429 summary
    // calls whose system lacks this block.
    // #3482 site 1: the billing-attribution block (#2189) moves with the
    // session summary calls — policy in the registry (dsh declares it),
    // observation over defaults: a request observed carrying the block keeps
    // it honored on every lane. Extraction stays here (anthropic is the only
    // wire whose system is a block array); the decision is lane-decisions'.
    const anthropicBillingBlock = laneDecisions.billingBlockWanted ? extractBillingAttributionBlock(clientSystem) : undefined;
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
    const markerCounts = stripRawStage(parsed, "anthropic");
    logRawStripCounts(markerCounts, log, sessionId);

    try {
        const converted = anthropicToCore(parsed);
        let msgs = converted.msgs;
        const cacheControls = converted.cacheControls;
        originalMessages = msgs;
        // #4491: pin identity to client-supplied ids (plugin lanes only — pure
        // proxy traffic has no msgid channel and stays on snapshot render D).
        // Everything downstream keys off these ids: kernel ref assignment,
        // fold coverage, and the unified-table rows the rawTail ingest writes.
        if (pluginMode && (incomingMsgIds !== undefined || incomingMsgSeqs !== undefined)) {
            if (featureEnabled("pluginLaneServerHistory")) {
                const v = incomingMsgIds === undefined ? undefined : validateMsgIds(incomingMsgIds, msgs.length);
                if (v !== undefined && v.ok) {
                    msgs = applyMsgIdPin(msgs, v.ids);
                    originalMessages = msgs;
                    noteMsgIdObservation(session, v.ids, msgs, log, sessionId);
                } else if (v !== undefined) {
                    log("warn", `[${sessionId}] [msgid] pin rejected (${v.reason}) — falling back to content-derived ids (#4491)`);
                }
                // #4316 PR2/3: re-attach the ledger seq stamps the lane sent —
                // the same parallel-array lifecycle as the ids (strip →
                // validate → apply), so fold coverage can key on seq
                // intervals and refs can connect to the unified log.
                const sv = incomingMsgSeqs === undefined ? undefined : validateMsgSeqs(incomingMsgSeqs, msgs.length);
                if (sv !== undefined && sv.ok) {
                    msgs = applyMsgSeqStamps(msgs, sv.seqs);
                    originalMessages = msgs;
                } else if (sv !== undefined) {
                    log("warn", `[${sessionId}] [msgid] ledger seq stamps rejected (${sv.reason}) — folding back to unstamped messages (#4316)`);
                }
            } else {
                log("info", `[${sessionId}] [msgid] biliMsgIds present but pluginLaneServerHistory rollout is off for this install — field stripped, ids not pinned (#4491)`);
            }
        }
        // #3756 snapshot render: outbound prefix from the unified transcript
        // (fold-time ids, immune to identity re-mints); live tail keeps the
        // client's bytes. No-op when the lane is inactive/degraded; the
        // reconcile call below still observes the CLIENT view.
        const renderMsgs = maybeSnapshotView(session, msgs, { sessionId, pluginMode, log });
        // #4241: the render lane replaced the view (reference-inequality is the
        // discriminator — maybeSnapshotView returns the SAME array when idle),
        // so the judged baseline is the rendered transcript, not the inbound.
        judgeBaseline = renderMsgs !== msgs ? renderMsgs : undefined;
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
        const { tokens: tokenCount, source: tokenCountSource } = effectiveTokenCount(session, renderMsgs, inboundImageTokens);
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
        // #2432/#2658: dsh desktop's native compaction can LAND without ever
        // transiting bili — its summarizer calls ctx.llm.stream() directly and
        // manual /compact / idle-session paths have no ALS attribution, so the
        // plugin's takeover gate sends them DIRECT past the proxy. First notice
        // = this request replaying [checkpoint summary, retained tail…] against
        // the same session id. The openai/responses lanes rebase on that
        // signature (#2432/#2451); this lane had the server-side REFUSAL gate
        // but not the post-landing recovery, so any checkpoint landing here
        // (direct bypass, future gate mismatch) left the ACP
        // state permanently unrebased — the cannot-be-anchored death spiral plus
        // persistent prefix-cache loss (#2596). Same signature+rebase as the
        // twin lanes: detection runs BEFORE reconcileFoldCoverage/processTurn;
        // either signal alone stays on the existing paths (framing paste with
        // intact history has no gap; a gap without framing falls through to
        // detectUnannouncedHistoryRewrite below). Title-gen side requests are
        // skipped like on the openai lane (same tiny-budget heuristic).
        let dshRebased = false;
        const anthropicTitleGen = typeof parsed.max_tokens === "number" && parsed.max_tokens <= 200;
        if (!anthropicTitleGen && laneDecisions.profile.compactsClientSide && session.state.blocks.some((b) => b.active)) {
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
                    dshRebased = reconcileNativeCompactionBoundary(session);
                }
            }
        }
        // [#1921] re-anchor fold coverage onto churned-but-same messages
        // before the #1195 snapshot, so covered ids surviving a client
        // re-serialization stay covered (src/fold-reconcile.ts).
        const foldMode = resolveFoldReconcileMode(process.env, opts.compress.reconcile);
        const reconcileOutcome = reconcileFoldCoverage(session, msgs, { mode: foldMode, sessionId, log, markerStripped: markerArtifactCount(markerCounts), inboundMessageCount, storedMessages: foldMode === "off" ? undefined : storedMessagesFor(session, sessionId, msgs) });
        noteSystemPromptFingerprint(session, clientSystem, { sessionId, log });
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
        // #2155: a self-heal-suppressed session (nudge idle / zombie fallback)
        // stops nagging — including the emergency path, per session. #3004: the
        // decide ladder's fallback is the ONE exception — it is the failure-
        // recovery path and must reach the model even while suppression is
        // latched, or the two mechanisms dead-lock (suppression gates this flag,
        // which gates the branch that breaks it; release waits on compression
        // only a nudge could prompt). Self-limiting: consumeFallback resets on
        // the same round, so at most one advisory punches through per 3
        // consecutive decision failures.
        const decideTier1Arm = decide !== undefined && !!turn.nudge && turn.nudge.tier === 1 && turn.nudge.breakdown.emergencyOverride !== 1;
        const decideFallbackOverride = decideTier1Arm && ladderMode(session.metadata) === "fallback";
        const nudgeEligible = opts.compress.injectNudge && !!turn.nudge && laneDecisions.compressSurfaceOn && (!nudgeSuppressed(session) || decideFallbackOverride) && !compressBreakerArmed(session) && !(autoFoldEngaged(loopConfig, session) && growthFoldingArmed(loopConfig, undefined, autoFoldFloor(session)));
        // #3461: pressure admitted by every standing gate but held by the backoff
        // is still an active nudge round — self-heal credit (#2155/#3004) must
        // not starve because we chose not to re-inject this round.
        const emergencyPressureHeld = nudgeEligible && !!turn.nudge && !turn.nudge.shouldInject && emergencyNudge(turn.nudge, undefined, loopConfig.compress.minCompressRange);
        // #3482 Step 2.5: the ONE nudge gate. This lane has no compaction
        // trigger and no intercept health window — those differences are
        // explicit inputs on the responses lane.
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
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, resolvedModel ?? parsed.model, willInjectNudge, decideTier1Arm && !decideFallbackOverride, surfaceOffDetail(laneDecisions, opts.compress.injectTool)));
        processedMessages = applyReasoningDrop(stripKernelSummaries(turn.messages, turn.state), reasoningPlan, log, sessionId);
        // #1001: a silent client history rewrite takes the same archive+prune path
        // as an announced /compact boundary — syncBlocks above has already
        // deactivated the blocks whose sources left the context. Skipped when
        // the rewrite was just classified as dsh native compaction above
        // (#2432/#2658): it is already recorded as "native-compaction" and
        // rebased — a second "unannounced-rewrite" entry beside it would present
        // the substrate destruction as "another compressor fighting you".
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
        // #1637: cumulative cache_control marks applied through the kernel's own
        // applier (same machine the round-2 adapter uses); marks ride the last
        // STABLE message — ephemeral tails (retrievals/sysNotes/nudge/id note)
        // never carry a breakpoint. Client-managed controls (message blocks,
        // tools entries — WC-010's combined budget) pass through untouched.
        anthropicCacheMarks = cacheControls.size > 0 || anthropicToolsCarryCacheControl(parsed.tools)
            ? undefined
            : computeAnthropicMessageMarks(processedMessages as { id?: string }[], attachedRetrievals.length, session);
        // #2499: hand the round-2 adapter the SAME marks source the steady path
        // uses — `anthropicCacheMarks ?? cacheControls`. The client's harvested
        // map is the fallback the rebuild applies when bili adds no marks of its
        // own (a client-managed session), so its trigger-turn breakpoint survives.
        clientCacheControls = cacheControls;
        // #3400: egress image rescale — outbound copies only; the originals
        // stay in session state/persistence untouched.
        const egressMessages = await applyImageRescalePass(processedMessages as BiliMessage[], { session, sessionId, log, maxDim: imageRescaleMaxDim(), toolArmed: imageRescaleToolArmed(session) });
        rebuiltMessages = coreToAnthropic(egressMessages, anthropicCacheMarks ?? cacheControls);
        if (sysNotes.length > 0) {
            rebuiltMessages = [...rebuiltMessages, ...sysNotes.map((text) => ({ role: "user" as const, content: text }))];
        }

        systemOut = injectSystem(parsed, opts, prompts, loopConfig, surface, visibilityMarkers, laneDecisions.compressSurfaceOff, laneDecisions.mcpDialect, detectGenerationBoundary(session, processedMessages, log));
        // #1637: stamp the steady body's system. NOTE: parsed.system stays the
        // #1085 frozen CLIENT head (injectSystem's in-place view) — the round-2
        // adapter consumes that frozen head and stamps its own rebuild, so NO
        // write-back here (writing the full systemOut back would double-append
        // the compress prompt on round-2, the exact F2 seam the matrix pins).
        systemOut = stampAnthropicSystemCacheControl(systemOut, anthropicCacheMarks !== undefined);
        if (injectTools) {
            toolsOut = injectTool(parsed.tools, [...(absorbActive ? [absorbTools.anthropic] : []), ...(rulesActive ? [RULE_TOOL] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).anthropic] : []), ...(imageRescaleToolArmed(session) ? [READ_ORIGINAL_IMAGE_TOOL] : [])], surface?.toolPrompts, ccrEnabled(session), externalSummaryEnabled(config));
        }
        // #4789: observe the FINAL outbound array — in plugin lanes the proxy injects nothing, so host-declared presence must be read off the artifact itself.
        noteBiliToolSurface(session, outboundBiliSurface(toolsOut, retrieveToolName(session)), { sessionId, log });
        // Nudge as a separate trailing user message (cache-friendly): the
        // system block stays byte-stable so the prefix cache survives.
        // Injected in BOTH modes (#451): in plugin mode the agent supplies the
        // ACP tools but has NO nudge channel of its own, so this proxy-side
        // nudge IS the proactive trigger — preflight alone only fires at the
        // hard limit. Ephemeral user message: not persisted, never enters the
        // agent's re-sent history, safe for the prefix-cache anchor.
        if (willInjectNudge && turn.nudge) {
            // #2228: model-decided timing. Only gentle/over-limit T1 arms ask
            // the model (a cheap side call over the session's cached prefix)
            // whether compressing NOW serves the current task; a strict-JSON
            // yes injects an explicit directive with a program-finalized span,
            // anything else injects nothing this round. EMERGENCY arms and
            // tier>=2 distillation keep the legacy advisory below.
            const useDecide = decide !== undefined && turn.nudge.tier === 1 && turn.nudge.breakdown.emergencyOverride !== 1;
            if (useDecide && ladderMode(session.metadata) === "fallback") {
                consumeFallback(session.metadata);
                try {
                    const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections, "anthropic");
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
                const sideBody: Record<string, unknown> = { ...parsed, messages: [...rebuiltMessages, { role: "user", content: buildDecisionPrompt(ranges) }], system: systemOut, tools: toolsOut, stream: false, max_tokens: decide.maxTokens };
                delete sideBody.prompt_cache_key;
                stripDecisionReasoningFields("anthropic", sideBody);
                const outcome = await runNudgeDecision({ req, opts, protocol: "anthropic", sideBody, session, log });
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
                    // #3004: arm-level delivery truth (see the openai-lane note).
                    log("info", `[${sessionId}] [acp-decide] tier-1 nudge arm not injected (${outcome.kind === "failed" ? `decision failed: ${outcome.detail}` : "model declined"}) — nothing sent this round`);
                }
            } else {
                try {
                    const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections, "anthropic");
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
    // #4805: id-membership evidence for the settle gate — the envelope ids
    // when the lane sends them (any rollout state), else the tool-call ids
    // resent in the history. Placed after the payload row above so the
    // main-scale tiebreak sees this request's own upper bound.
    probeRequestMembership(session, collectRequestIds(incomingMsgIds, originalMessages), session.stats.localInputEstimate ?? 0);
    if (upstreamOrigin) session.stats.lastLocalTextEstimateOrigin = upstreamOrigin;
    return { body: JSON.stringify(rebuilt), session, attachedRetrievals, attachedRetrievalNoteIds, processedMessages, originalMessages, judgeBaseline, anthropicSystem: parsed.system, anthropicBillingBlock, anthropicCacheMarks, anthropicClientCacheControls: clientCacheControls, systemNotes: sysNotes, protocol: "anthropic", stream, compressInjected: injectTools, pluginMode, mcpDialectNote: laneDecisions.mcpDialect, nudge, nudgeOutcome, prompts, surface, renderTags: renderStrategy, dropReasoning: (msgs: BiliMessage[]) => applyReasoningDrop(msgs, reasoningPlan, log, sessionId) } as Prepared;
}

// #2648: true when any system block pins cache_control.scope:"global". bili's
// narrower-scope ACP-tool injection renders ahead of such a block and 400s
// upstream (see the passthrough gate above), so the host must be left untouched.
function hasGlobalScopeSystem(parsed: AnthropicRequestBody): boolean {
    const sys = parsed.system;
    if (!Array.isArray(sys)) return false;
    return sys.some((b) => (b.cache_control as { scope?: unknown } | undefined)?.scope === "global");
}

// #4491: id-set algebra over the pinned observation. The unified store does
// the mechanical append/tombstone/reactivate at ingest; this is the judgment
// layer — vanish-reason classification (compressed vs deleted) and epoch
// detection — surfaced as logs + bounded session metadata counters. Best
// effort by design: an observability failure must never disturb the turn.
const MSGID_OBSERVED_CAP = 65_536;

function noteMsgIdObservation(session: Session, ids: string[], msgs: BiliMessage[], log: (level: string, msg: string) => void, sessionId: string): void {
    try {
        const prevRaw = session.metadata["msgidObserved"];
        const prev = Array.isArray(prevRaw) ? (prevRaw as string[]) : [];
        const covered = new Set<string>();
        for (const b of session.state.blocks) if (b.active) for (const id of b.effectiveMessageIds) covered.add(id);
        const summarySeen = msgs.some((m) => looksLikeSummaryCarrier(m));
        const stats = alignIdSet(prev, ids, { coveredIds: covered, summarySeen });
        if (stats.epoch) {
            session.metadata["msgidEpochs"] = ((session.metadata["msgidEpochs"] as number | undefined) ?? 0) + 1;
            log("warn", `[${sessionId}] [msgid] generation switch detected (${String(prev.length)}→${String(ids.length)} ids overlap-ratio below threshold) — controlled rebuild, tombstones keep history (#4491)`);
        } else if (stats.vanished.length > 0 || stats.appends.length > 0 || stats.edits.length > 0) {
            const compressed = stats.vanished.filter((v) => v.reason === "compressed").length;
            log("info", `[${sessionId}] [msgid] aligned kept=${String(stats.kept)} appends=${String(stats.appends.length)} vanished=${String(stats.vanished.length)}(compressed=${String(compressed)}) edits=${String(stats.edits.length)}`);
        }
        session.metadata["msgidObserved"] = ids.length <= MSGID_OBSERVED_CAP ? ids : [];
    } catch (err) {
        log("warn", `[${sessionId}] [msgid] observation accounting failed: ${String(err)}`);
    }
}
