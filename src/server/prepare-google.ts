import http from "node:http";
import type { CompressionCore, Config, CoreMessage, NudgeDecision, PackSurface, Prompts } from "acp-kernel";
import { renderNudgeText, viableRanges } from "acp-kernel";
import { coreToGoogle, googleToCore, type BiliMessage, type GoogleContent, type GoogleRequestBody, type GoogleSystemInstruction, type GoogleTool } from "acp-kernel/wire";
import type { ProxyOptions } from "../config.js";
import { currentCalibrationFactor } from "../util.js";
import { diagNudge, diagTagSummary, deriveTitle, effectiveTokenCount, imageBillingFor, imageReserveFor, imageTokenCapFor, isAutoInjectedNotification, reapOrphansLogged, runNudgeDecision, stripKernelSummaries, usageGradeInputBaseline, type Prepared } from "../server.js";
import { buildDecisionPrompt, buildDirectiveText, consumeFallback, ladderMode, resolveDecisionRange, type DecideConfig } from "../nudge-decide.js";
import { reconcileFoldCoverage, noteSystemPromptFingerprint, resolveFoldReconcileMode } from "../fold-reconcile.js";
import { nudgeSuppressed } from "../session-self-heal.js";
import { compressBreakerArmed } from "../stream.js";
import { applyCompactionArchive, foldCoverage, markDirty, markNativeCompactionBoundary, reconcileNativeCompactionBoundary, REWRITE_MIN_INCOMING_TOTAL, snapshotMessages, type Session } from "../session.js";
import { recordConflict } from "../conflict-watch.js";
import { carriesDshLocalCompactionSummary, DSH_LOCAL_COMPACTION_MIN_MISSING } from "./dsh-compaction-guard.js";
import { ABSORB_TOOL_NAME, IMAGE_FULL_TOOL_GOOGLE, RULE_TOOL_GOOGLE, absorbToolsFor, buildAbsorbSystemPrompt, buildAcpTagsOnlyPrompt, buildCompressSystemPrompt, retrieveToolsFor, withFirstSightDrain, withMarkerIntegrityNote, withSummaryBudgetNote } from "../compress-tool.js";
import { absorbToolName, applyAbsorbView, storeEffectiveAbsorb } from "../absorb.js";
import { adoptContentStore, ccrEnabled, ccrLoopConfig, contentStoreOf, retrieveToolName } from "../store.js";
import { applyImageCompressionPass, imageCompressionEnabled, imageFullTrailingNote } from "../image-compress.js";
import { rulesEnabled, storeEffectiveRules } from "../rules-feature.js";
import { autoFoldEngaged, externalSummaryEnabled, growthFoldingArmed } from "../external-summary-surface.js";
import { attachSubagentSessions } from "../subagent-sessions.js";
import { reconcileSystemAnchor } from "../system-anchor.js";
import { stripAcpPanelMessages, stripAcpStatusMarkers } from "../acp-panel.js";
import { stripEmbeddedChainCarriers } from "../chain-checkpoint.js";
import { clampOutgoingOutput, countSystemAndToolsTokens, dshLedgerFloorTokens, emergencyNudge } from "./budget.js";
import { estimateCoreMessages } from "../preflight.js";
import { effectiveAbsorbBlock } from "./prepare-responses.js";
import { injectGoogleTool, injectTool } from "./inject.js";

function appendGoogleNudge(contents: GoogleContent[], text: string): GoogleContent[] {
    const last = contents[contents.length - 1];
    if (last && (last.role ?? "user") !== "model") {
        const parts = Array.isArray(last.parts) ? last.parts : [];
        return [...contents.slice(0, -1), { ...last, parts: [...parts, { text }] }];
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
    let googleClientSystem = "";
    let sysNotes: string[] = [];
    let googleOutboundSystem: string | undefined;
    let systemInstruction: GoogleSystemInstruction | undefined = parsed.systemInstruction;
    let processedMessages: CoreMessage[] = [];
    let originalMessages: CoreMessage[] = [];
    let nudge: NudgeDecision | undefined;
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

    const strippedCarriers = stripEmbeddedChainCarriers(parsed, "google");
    if (strippedCarriers > 0) {
        log("info", `[${sessionId}] stripped ${strippedCarriers} embedded chain checkpoint(s) from incoming history (leaked egress control data, issue #1542)`);
    }

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
        const { tokens: tokenCount, source: tokenCountSource } = effectiveTokenCount(session, msgs, imageReserveFor(session, "google", parsed, opts, upstreamOrigin));
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
        // transiting bili (direct-bypass / allowDshCompaction / future gate
        // mismatch); first notice = this request replaying [checkpoint summary,
        // retained tail…] against the same session id. Before #2658 every lane
        // except openai/responses left such a landing unrebased (cannot-be-
        // anchored death spiral + prefix-cache loss). Dual signal only:
        // checkpoint framing in resent history AND decimated fold coverage;
        // detection runs BEFORE reconcileFoldCoverage/processTurn. No known
        // dsh+google traffic yet — this closes the same hole on the fourth wire.
        if (!isTitleGen && session.metadata["pluginAgent"] === "dsh" && session.state.blocks.some((b) => b.active)) {
            const coveredBeforeDshCompact = new Set(session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
            const dshGap = foldCoverage(coveredBeforeDshCompact, msgs.map((m) => m.id));
            if (dshGap && carriesDshLocalCompactionSummary(msgs)) {
                const missing = dshGap.expected - dshGap.matched;
                if (missing >= DSH_LOCAL_COMPACTION_MIN_MISSING && missing * 2 >= dshGap.expected) {
                    recordConflict(session, "native-compaction", `dsh native compaction: ${missing}/${dshGap.expected} covered id(s) replaced by the compacted history; ACP state rebased (#2432)`);
                    log("warn", `[${sessionId}] dsh native compaction detected (${dshGap.matched}/${dshGap.expected} covered id(s) retained, checkpoint framing in resent history) — rebasing ACP state onto the compacted history (#2432)`);
                    markNativeCompactionBoundary(session);
                    reconcileNativeCompactionBoundary(session);
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
        const turn = core.processTurn({ messages: msgs, state: session.state, config: loopConfig, tokenCount, renderTags: "text-only", contentStore: contentStoreOf(session) });
        session.state = turn.state;
        adoptContentStore(session, turn.contentStore);
        // The fold from last turn's compress has materialized in state — future
        // usage reports are post-fold reality, drop the credit.
        session.stats.compressCreditTokens = 0;
        if (foldCoveredBefore !== null && !isTitleGen && msgs.length >= REWRITE_MIN_INCOMING_TOTAL) {
            const gap = foldCoverage(foldCoveredBefore, msgs.map((m) => m.id));
            if (gap) log("warn", `[${sessionId}] [acp-drift] fold coverage mismatch: ${gap.matched}/${gap.expected} covered message id(s) present in resent history — ${gap.expected - gap.matched} covered id(s) missing from resent history — mutation (content edit invalidates content-hash refs, fold silently lost) or client-side deletion/truncation (benign, message no longer on the wire); observability complement to the #1328 overflow rescue (#1195)`);
        }
        storeEffectiveAbsorb(session, loopConfig);
        storeEffectiveRules(session, config);
        turn.messages = applyAbsorbView(turn.messages, session.state, loopConfig, tokenCount);
        turn.messages = attachSubagentSessions(turn.messages, session);
        // Drop sub-viability fragments before any consumer sees them (the
        // kernel validates a compress batch atomically).
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
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, model, willInjectNudge));
        processedMessages = stripKernelSummaries(turn.messages, turn.state);
        applyCompactionArchive(session, activeBefore, new Set(msgs.map((m) => m.id)), log);
        reapOrphansLogged(session, msgs, log, sessionId);
        // [#1095] arrival-time image downscale (see prepareAnthropic).
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, upstreamOrigin), cap: imageTokenCapFor(opts, upstreamOrigin), log });
        rebuiltContents = coreToGoogle(processedMessages as BiliMessage[]);

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
        if (shouldInject) sysParts.push(withMarkerIntegrityNote(withSummaryBudgetNote(buildCompressSystemPrompt(prompts, surface?.promptSections), externalSummaryEnabled(config)), visibilityMarkers));
        else if (!isTitleGen) {
            // #1881: the NEVER-echo prohibition follows the rendered tags, not the tool switch.
            const tagsOnly = buildAcpTagsOnlyPrompt("function", prompts, surface?.promptSections);
            if (tagsOnly) sysParts.push(tagsOnly);
        }
        if (absorbActive) sysParts.push(buildAbsorbSystemPrompt(absorbToolName(loopConfig)));
        googleOutboundSystem = sysParts.join("\n\n");
        // Untouched when nothing was added beyond the client's own text: the
        // original `systemInstruction` object then rides through byte-identical
        // instead of being re-serialized into a new shape.
        const extraSystemParts = sysParts.slice(googleClientSystem ? 1 : 0);
        systemInstruction = extraSystemParts.length > 0 ? { parts: sysParts.map((text) => ({ text })) } : parsed.systemInstruction;
        if (injectTools) {
            toolsOut = injectGoogleTool(parsed.tools, [...(absorbActive ? [absorbTools.google] : []), ...(rulesActive ? [RULE_TOOL_GOOGLE] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).google] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL_GOOGLE] : [])], surface?.toolPrompts, ccrEnabled(session), externalSummaryEnabled(config));
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
                    const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections);
                    const renderedWithPayload = rendered.text;
                    if (rendered.text) {
                        rebuiltContents = appendGoogleNudge(rebuiltContents, withMarkerIntegrityNote(withFirstSightDrain(renderedWithPayload, turn.nudge.reason, externalSummaryEnabled(config)), visibilityMarkers));
                    }
                } catch {
                }
            } else if (useDecide) {
                const ranges = turn.nudge.compressibleRanges ?? [];
                const sideBody: Record<string, unknown> = { ...parsed, contents: [...rebuiltContents, { role: "user", parts: [{ text: buildDecisionPrompt(ranges) }] }], tools: toolsOut, systemInstruction, generationConfig: { ...(parsed.generationConfig ?? {}), maxOutputTokens: decide.maxTokens } };
                const outcome = await runNudgeDecision({ req, opts, protocol: "google", sideBody, session, log });
                if (outcome.kind === "yes") {
                    const span = resolveDecisionRange(outcome, ranges);
                    if (span) {
                        rebuiltContents = appendGoogleNudge(rebuiltContents, withMarkerIntegrityNote(withFirstSightDrain(buildDirectiveText(span.startRef, span.endRef, outcome.topic), turn.nudge.reason, externalSummaryEnabled(config)), visibilityMarkers));
                    } else {
                        log("info", `[${sessionId}] [acp-decide] yes but no live range left to target — skipping injection`);
                    }
                }
            } else {
                try {
                    const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections);
                    const renderedWithPayload = rendered.text;
                    if (rendered.text) {
                        rebuiltContents = appendGoogleNudge(rebuiltContents, withMarkerIntegrityNote(withFirstSightDrain(renderedWithPayload, turn.nudge.reason, externalSummaryEnabled(config)), visibilityMarkers));
                    }
                } catch {
                }
            }
        }
        // [#1095] restore-channel guidance — ephemeral trailing note (see prepareAnthropic).
        const imgNote = imageFullTrailingNote(session);
        if (imgNote) rebuiltContents = appendGoogleNudge(rebuiltContents, imgNote);
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    const rebuilt: GoogleRequestBody = { ...parsed, contents: rebuiltContents, tools: toolsOut, systemInstruction };
    clampOutgoingOutput(rebuilt as Record<string, unknown>, "generationConfig.maxOutputTokens", { systemText: googleClientSystem, tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, lastInputTokensSource: session.stats.lastInputTokensSource, nativeWindow, headroomWindow: config.modelContextLimit, imageTokens: imageReserveFor(session, "google", rebuilt, opts, upstreamOrigin), kFactor: currentCalibrationFactor(session.stats, session.metadata?.lastModel), kOrigin: session.stats.calibratedEstimateOrigin, origin: upstreamOrigin, ledgerFloorTokens: dshLedgerFloorTokens(session.metadata) }, sessionId, log);
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
    return { body: JSON.stringify(rebuilt), session, processedMessages, originalMessages, protocol: "google", stream, compressInjected: injectTools, pluginMode, nudge, prompts, surface, google: { system: googleClientSystem, model }, systemNotes: sysNotes, renderTags: "text-only" } as Prepared;
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
        const turn = core.processTurn({ messages: msgs, state: session.state, config: ccrLoopConfig(session, config), tokenCount: usageGradeInputBaseline(session), renderTags: "text-only", contentStore: contentStoreOf(session) });
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
