import http from "node:http";
import type { CompressionCore, Config, CoreMessage, NudgeDecision, PackSurface, Prompts } from "acp-kernel";
import { renderNudgeText, viableRanges } from "acp-kernel";
import { anthropicToCore, buildSystem, coreToAnthropic, extractSystem, type AnthropicRequestBody, type BiliMessage } from "acp-kernel/wire";
import type { CompressReasoningConfig } from "../reasoning-drop.js";
import type { ProxyOptions } from "../config.js";
import { diagNudge, diagTagSummary, deriveTitle, effectiveTokenCount, imageBillingFor, imageReserveFor, imageTokenCapFor, isAutoInjectedNotification, reapOrphansLogged, runNudgeDecision, stripKernelSummaries, warnAnthropicThinkingPairs, withReasoningDrop, type Prepared } from "../server.js";
import { buildDecisionPrompt, buildDirectiveText, consumeFallback, ladderMode, resolveDecisionRange, type DecideConfig } from "../nudge-decide.js";
import { reconcileFoldCoverage, noteSystemPromptFingerprint, resolveFoldReconcileMode } from "../fold-reconcile.js";
import { nudgeSuppressed } from "../session-self-heal.js";
import { compressBreakerArmed } from "../stream.js";
import { applyCompactionArchive, detectUnannouncedHistoryRewrite, foldCoverage, markCompactionBoundary, markDirty, markNativeCompactionBoundary, reconcileNativeCompactionBoundary, REWRITE_MIN_INCOMING_TOTAL, snapshotMessages, type PendingRetrieval, type Session } from "../session.js";
import { carriesDshLocalCompactionSummary, DSH_LOCAL_COMPACTION_MIN_MISSING } from "./dsh-compaction-guard.js";
import { ABSORB_TOOL_NAME, IMAGE_FULL_TOOL, RULE_TOOL, absorbToolsFor, retrieveToolsFor, withFirstSightDrain, withMarkerIntegrityNote, withSummaryBudgetNote } from "../compress-tool.js";
import { applyAbsorbView, storeEffectiveAbsorb } from "../absorb.js";
import { adoptContentStore, ccrEnabled, ccrLoopConfig, contentStoreOf, dropRetrievals, pruneExpiredRetrievals, reconcileReloadedRetrievals, renderRetrievalNotes, retrieveToolName, snapshotPendingRetrievals, snapshotRetrievalNotes } from "../store.js";
import { applyImageCompressionPass, imageCompressionEnabled, imageFullTrailingNote } from "../image-compress.js";
import { rulesEnabled, storeEffectiveRules } from "../rules-feature.js";
import { autoFoldEngaged, externalSummaryEnabled, growthFoldingArmed } from "../external-summary-surface.js";
import { attachSubagentSessions } from "../subagent-sessions.js";
import { estimateCoreMessages, estimateCoreMessagesUpper, extractBillingAttributionBlock } from "../preflight.js";
import { recordConflict } from "../conflict-watch.js";
import { anthropicToolsCarryCacheControl, computeAnthropicMessageMarks, stampAnthropicSystemCacheControl } from "../loop/cache-control.js";
import { reconcileSystemAnchor } from "../system-anchor.js";
import { isStrictReasoningEcho, modelIdOf } from "../strict-echo.js";
import { stripAcpPanelMessages, stripAcpStatusMarkers } from "../acp-panel.js";
import { stripEmbeddedChainCarriers } from "../chain-checkpoint.js";
import { renderNone as knobRenderNone } from "../knobs.js";
import { countSystemAndToolsTokens, emergencyNudge, projectThinkingMass } from "./budget.js";
import { effectiveAbsorbBlock } from "./prepare-responses.js";
import { injectSystem, injectTool } from "./inject.js";

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
    decide?: DecideConfig,
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
    let attachedRetrievalNoteIds: string[] = [];
    let originalMessages: CoreMessage[] = [];
    let nudge: NudgeDecision | undefined;
    let rebuiltMessages = parsed.messages;
    let anthropicCacheMarks: Map<string, { type: "ephemeral" }> | undefined;
    let clientCacheControls: Map<string, unknown> | undefined;
    let systemOut = parsed.system;
    let toolsOut = parsed.tools;

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
    const anthropicBillingBlock = extractBillingAttributionBlock(clientSystem);
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
    const strippedCarriers = stripEmbeddedChainCarriers(parsed, "anthropic");
    if (strippedCarriers > 0) {
        log("info", `[${sessionId}] stripped ${strippedCarriers} embedded chain checkpoint(s) from incoming history (leaked egress control data, issue #1542)`);
    }

    try {
        const { msgs, cacheControls } = anthropicToCore(parsed);
        originalMessages = msgs;
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
        const { tokens: tokenCount, source: tokenCountSource } = effectiveTokenCount(session, msgs, inboundImageTokens);
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
        // (direct bypass, allowDshCompaction, future gate mismatch) left the ACP
        // state permanently unrebased — the cannot-be-anchored death spiral plus
        // persistent prefix-cache loss (#2596). Same signature+rebase as the
        // twin lanes: detection runs BEFORE reconcileFoldCoverage/processTurn;
        // either signal alone stays on the existing paths (framing paste with
        // intact history has no gap; a gap without framing falls through to
        // detectUnannouncedHistoryRewrite below). Title-gen side requests are
        // skipped like on the openai lane (same tiny-budget heuristic).
        let dshRebased = false;
        const anthropicTitleGen = typeof parsed.max_tokens === "number" && parsed.max_tokens <= 200;
        if (!anthropicTitleGen && session.metadata["pluginAgent"] === "dsh" && session.state.blocks.some((b) => b.active)) {
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
        noteSystemPromptFingerprint(session, clientSystem, { sessionId, log });
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
        if (turn.nudge) turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
        session.stats.contextTokensSource = tokenCountSource;
        if (!session.meta.title || isAutoInjectedNotification(session.meta.title)) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        // #2155: a self-heal-suppressed session (nudge idle / zombie fallback)
        // stops nagging — including the emergency path, per session.
        const willInjectNudge = opts.compress.injectNudge && !!turn.nudge && !nudgeSuppressed(session) && !compressBreakerArmed(session) && !(autoFoldEngaged(loopConfig, session) && growthFoldingArmed(loopConfig)) && (turn.nudge.shouldInject || emergencyNudge(turn.nudge, undefined, loopConfig.compress.minCompressRange));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, parsed.model, willInjectNudge));
        processedMessages = stripReasoning(stripKernelSummaries(turn.messages, turn.state));
        // #1001: a silent client history rewrite takes the same archive+prune path
        // as an announced /compact boundary — syncBlocks above has already
        // deactivated the blocks whose sources left the context. Skipped when
        // the rewrite was just classified as dsh native compaction above
        // (#2432/#2658): it is already recorded as "native-compaction" and
        // rebased — a second "unannounced-rewrite" entry beside it would present
        // the substrate destruction as "another compressor fighting you".
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
        // [#1095] downscale screenshot-like images ONCE at arrival (kernel routing
        // decision + recipe; originals cached for the image_full restore channel).
        // Deterministic encode ⇒ re-runs are byte-stable for the prefix cache.
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, upstreamOrigin), cap: imageTokenCapFor(opts, upstreamOrigin), log });
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
        rebuiltMessages = coreToAnthropic(processedMessages as BiliMessage[], anthropicCacheMarks ?? cacheControls);
        if (sysNotes.length > 0) {
            rebuiltMessages = [...rebuiltMessages, ...sysNotes.map((text) => ({ role: "user" as const, content: text }))];
        }

        systemOut = injectSystem(parsed, opts, prompts, loopConfig, surface, visibilityMarkers);
        // #1637: stamp the steady body's system. NOTE: parsed.system stays the
        // #1085 frozen CLIENT head (injectSystem's in-place view) — the round-2
        // adapter consumes that frozen head and stamps its own rebuild, so NO
        // write-back here (writing the full systemOut back would double-append
        // the compress prompt on round-2, the exact F2 seam the matrix pins).
        systemOut = stampAnthropicSystemCacheControl(systemOut, anthropicCacheMarks !== undefined);
        if (injectTools) {
            toolsOut = injectTool(parsed.tools, [...(absorbActive ? [absorbTools.anthropic] : []), ...(rulesActive ? [RULE_TOOL] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).anthropic] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL] : [])], surface?.toolPrompts, ccrEnabled(session), externalSummaryEnabled(config));
        }
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
                    const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections);
                    const renderedWithPayload = rendered.text;
                    if (rendered.text) {
                        rebuiltMessages = [...rebuiltMessages, { role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withFirstSightDrain(renderedWithPayload, turn.nudge.reason, externalSummaryEnabled(config)), externalSummaryEnabled(config)), visibilityMarkers) }];
                    }
                } catch {
                }
            } else if (useDecide) {
                const ranges = turn.nudge.compressibleRanges ?? [];
                const sideBody: Record<string, unknown> = { ...parsed, messages: [...rebuiltMessages, { role: "user", content: buildDecisionPrompt(ranges) }], system: systemOut, tools: toolsOut, stream: false, max_tokens: decide.maxTokens };
                delete sideBody.prompt_cache_key;
                const outcome = await runNudgeDecision({ req, opts, protocol: "anthropic", sideBody, session, log });
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
        // (see prepareAnthropic for why not system).
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
    if (upstreamOrigin) session.stats.lastLocalTextEstimateOrigin = upstreamOrigin;
    return { body: JSON.stringify(rebuilt), session, attachedRetrievals, attachedRetrievalNoteIds, processedMessages, originalMessages, anthropicSystem: parsed.system, anthropicBillingBlock, anthropicCacheMarks, anthropicClientCacheControls: clientCacheControls, systemNotes: sysNotes, protocol: "anthropic", stream, compressInjected: injectTools, pluginMode, nudge, prompts, surface, renderTags: knobRenderNone() ? "none" : "text-only", dropReasoning: stripReasoning } as Prepared;
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
