// Google (Gemini generateContent) protocol prepare pipeline (extracted
// verbatim from src/server.ts — #1440 P2 four-cut disassembly, cut 2).

import { absorbToolName, applyAbsorbView, storeEffectiveAbsorb } from "../absorb.js";
import { ABSORB_TOOL_NAME, IMAGE_FULL_TOOL_GOOGLE, RULE_TOOL_GOOGLE, absorbToolsFor, buildAbsorbSystemPrompt, buildCompressSystemPrompt, retrieveToolsFor, withMarkerIntegrityNote, withStagedCompressGuidance } from "../compress-tool.js";
import { ProxyOptions } from "../config.js";
import { applyImageCompressionPass, imageCompressionEnabled, imageFullTrailingNote } from "../image-compress.js";
import { imageTokensInParsedBody } from "../image-tokens.js";
import { rulesEnabled, storeEffectiveRules } from "../rules-feature.js";
import { clampOutgoingOutput, countSystemAndToolsTokens, emergencyNudge } from "../server/budget.js";
import { REWRITE_MIN_INCOMING_TOTAL, Session, applyCompactionArchive, foldCoverage, markDirty, snapshotMessages } from "../session.js";
import { adoptContentStore, ccrEnabled, ccrLoopConfig, contentStoreOf, retrieveToolName } from "../store.js";
import { reconcileSystemAnchor } from "../system-anchor.js";
import { CompressionCore, Config, CoreMessage, NudgeDecision, PackSurface, Prompts, renderNudgeText, viableRanges } from "acp-kernel";
import { BiliMessage, GoogleContent, GoogleRequestBody, GoogleSystemInstruction, GoogleTool, coreToGoogle, googleToCore } from "acp-kernel/wire";
import { injectGoogleTool, injectTool } from "./inject.js";
import { Prepared, deriveTitle, diagNudge, diagTagSummary, effectiveAbsorbBlock, effectiveTokenCount, imageBillingFor, reapOrphansLogged, stripKernelSummaries } from "./prepare-shared.js";

/** Append the ephemeral nudge to a Gemini `contents` array. Gemini is
 *  strict about role alternation, so a trailing user turn is merged into
 *  rather than appended to (the nudge then reads as the model's last input,
 *  which is where it belongs); a model-final history gets a fresh user turn
 *  because a request must not end on the model side. */
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
        const tokenCount = effectiveTokenCount(session, msgs, imageTokensInParsedBody("google", parsed, imageBillingFor(opts, upstreamOrigin)));
        const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
        const absorbBlock = effectiveAbsorbBlock(pluginMode, config, opts.compress.absorb);
        const absorbTools = absorbToolsFor(absorbBlock?.toolName ?? ABSORB_TOOL_NAME);
        const absorbActive = absorbBlock?.enabled === true && shouldInject;
        // acp_rule has no processTurn side effect (no markers/instructions are
        // ever injected into messages), so unlike absorb it needs no loop-
        // config stripping — only tool availability matters.
        const rulesActive = rulesEnabled(config) && shouldInject;
        const loopConfig = ccrLoopConfig(session, { ...config, absorb: absorbActive ? absorbBlock : undefined });
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
        // Drop sub-viability fragments before any consumer sees them (the
        // kernel validates a compress batch atomically).
        if (turn.nudge) turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
        nudge = turn.nudge;
        session.stats.contextTokens = tokenCount;
        if (!session.meta.title) {
            const t = deriveTitle(msgs);
            if (t) session.meta.title = t;
        }
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        const willInjectNudge = opts.compress.injectNudge && !!turn.nudge && shouldInject && (turn.nudge.shouldInject || emergencyNudge(turn.nudge));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, model, willInjectNudge));
        processedMessages = stripKernelSummaries(turn.messages, turn.state);
        applyCompactionArchive(session, activeBefore, new Set(msgs.map((m) => m.id)), log);
        reapOrphansLogged(session, msgs, log, sessionId);
        // [#1095] arrival-time image downscale (see prepareAnthropic).
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, upstreamOrigin), log });
        rebuiltContents = coreToGoogle(processedMessages as BiliMessage[]);

        // ONLY the static compress prompt joins the client's system text — the
        // system instruction is the prefix-cache anchor and must stay
        // byte-stable across turns. The per-turn nudge is appended to the
        // trailing user content below (see prepareOpenai for the rationale).
        const sysParts: string[] = [];
        if (googleClientSystem) sysParts.push(googleClientSystem);
        if (shouldInject) sysParts.push(withMarkerIntegrityNote(buildCompressSystemPrompt(prompts, surface?.promptSections), visibilityMarkers));
        if (absorbActive) sysParts.push(buildAbsorbSystemPrompt(absorbToolName(loopConfig)));
        googleOutboundSystem = sysParts.join("\n\n");
        // Untouched when nothing was added beyond the client's own text: the
        // original `systemInstruction` object then rides through byte-identical
        // instead of being re-serialized into a new shape.
        const extraSystemParts = sysParts.slice(googleClientSystem ? 1 : 0);
        systemInstruction = extraSystemParts.length > 0 ? { parts: sysParts.map((text) => ({ text })) } : parsed.systemInstruction;
        if (injectTools) {
            toolsOut = injectGoogleTool(parsed.tools, [...(absorbActive ? [absorbTools.google] : []), ...(rulesActive ? [RULE_TOOL_GOOGLE] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).google] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL_GOOGLE] : [])], surface?.toolPrompts);
        }
        if (sysNotes.length > 0) {
            rebuiltContents = appendGoogleNudge(rebuiltContents, sysNotes.join("\n\n---\n\n"));
        }
        if (willInjectNudge && turn.nudge) {
            try {
                const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections);
                if (rendered.text) {
                    rebuiltContents = appendGoogleNudge(rebuiltContents, withMarkerIntegrityNote(withStagedCompressGuidance(rendered.text), visibilityMarkers));
                }
            } catch {
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
    clampOutgoingOutput(rebuilt as Record<string, unknown>, "generationConfig.maxOutputTokens", { systemText: googleClientSystem, tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, nativeWindow, imageTokens: imageTokensInParsedBody("google", rebuilt) }, sessionId, log);
    // #532: title-gen side requests carry their own tiny system — skip them.
    if (!isTitleGen && googleOutboundSystem !== undefined) {
        session.metadata.systemPromptTokens = countSystemAndToolsTokens(googleOutboundSystem, toolsOut);
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
        const turn = core.processTurn({ messages: msgs, state: session.state, config: ccrLoopConfig(session, config), tokenCount: session.stats.lastInputTokens, renderTags: "text-only", contentStore: contentStoreOf(session) });
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
