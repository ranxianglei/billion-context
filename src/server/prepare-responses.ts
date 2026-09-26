// Responses-API protocol prepare pipeline (extracted verbatim from
// src/server.ts — #1440 P2 four-cut disassembly, cut 2).

import { absorbToolName, applyAbsorbView, storeEffectiveAbsorb } from "../absorb.js";
import { stripAcpPanelResponsesInput, stripAcpStatusMarkers } from "../acp-panel.js";
import { buildTriggerForgeBody, codexCompactGate, codexCompactGatePre, codexCompactMode, hasCompactionTrigger, isCodexClient, mergeForgedSummaries, replaceBiliCompactionItems, stripBiliCompactionItems } from "../codex-compact.js";
import { ABSORB_TOOL_NAME, BILI_ACP_READONLY_TOOLS_RESPONSES, BILI_ACP_TOOLS_RESPONSES, IMAGE_FULL_TOOL_RESPONSES, RULE_TOOL_RESPONSES, absorbToolsFor, buildAbsorbSystemPrompt, buildCompressHybridSystemPrompt, buildCompressSystemPrompt, retrieveToolsFor, withConversationIdNote, withMarkerIntegrityNote, withStagedCompressGuidance, withSummaryBudgetNote } from "../compress-tool.js";
import { ProxyOptions, resolveCompressProtocol } from "../config.js";
import { applyImageCompressionPass, imageCompressionEnabled, imageFullTrailingNote } from "../image-compress.js";
import { imageTokensInParsedBody } from "../image-tokens.js";
import { dropWhitespaceResponsesMessages, normalizeResponsesMessageItems, sanitizeResponsesInputIds } from "../loop/adapter-responses.js";
import { estimateCoreMessagesUpper } from "../preflight.js";
import { CompressReasoningConfig } from "../reasoning-drop.js";
import { patchResponsesInputWithToolImages as patchResponsesInput, responsesToCoreWithToolImages as responsesToCore } from "../responses-tool-output.js";
import { rulesEnabled, storeEffectiveRules } from "../rules-feature.js";
import { clampOutgoingOutput, countSystemAndToolsTokens, emergencyNudge } from "../server/budget.js";
import { ConversationIdentity } from "../session-id.js";
import { REWRITE_MIN_INCOMING_TOTAL, Session, ensureCanonicalId, foldCoverage, markDirty, reconcileNativeCompactionBoundary, snapshotMessages } from "../session.js";
import { adoptContentStore, ccrEnabled, ccrLoopConfig, contentStoreOf, retrieveToolName } from "../store.js";
import { isStrictReasoningEcho, modelIdOf } from "../strict-echo.js";
import { reconcileSystemAnchor } from "../system-anchor.js";
import { hoistTrappedToolItems } from "../tool-pair-order.js";
import { CompressionCore, Config, CoreMessage, NudgeDecision, PackSurface, Prompts, defaultCountTokens, renderNudgeText, viableRanges } from "acp-kernel";
import { BiliMessage, ResponseInputItem, ResponsesProjection, ResponsesRequestBody, injectResponsesDeveloperMessage } from "acp-kernel/wire";
import http from "node:http";
import { injectResponsesTool, injectTool } from "./inject.js";
import { Prepared, deriveTitle, diagNudge, diagTagSummary, effectiveAbsorbBlock, effectiveTokenCount, imageBillingFor, reapOrphansLogged, stripKernelSummaries, withReasoningDrop } from "./prepare-shared.js";

/** [#684] Responses-wire twin: function_call item with no reasoning item
 *  immediately preceding it while other turns carry reasoning. */
export function warnResponsesReasoningPairs(
    input: unknown[],
    log: (level: string, msg: string) => void,
    sessionId: string,
): void {
    let withReasoning = 0;
    let split = 0;
    let prevWasReasoning = false;
    for (const item of input) {
        const it = item as { type?: string };
        if (it?.type === "reasoning") {
            withReasoning++;
            prevWasReasoning = true;
            continue;
        }
        if (it?.type === "function_call" && !prevWasReasoning) split++;
        prevWasReasoning = false;
    }
    if (withReasoning > 0 && split > 0) {
        log("warn", `[${sessionId}] reasoning-pair-violated: ${split} function_call item(s) lack a preceding reasoning item while ${withReasoning} exist — strict-echo upstreams will reject the request (#684)`);
    }
}

// #564: folding + stripKernelSummaries can merge two assistant turns into one
// run, which Responses rejects (run order reasoning* -> message* ->
// function_call*, <=1 reasoning). Rebuild boundaries from the ORIGINAL history
// AFTER dedup: drop a reasoning whose turn body was wholly folded away (keep
// originally-reasoning-only turns), else separate the runs with a user marker.
const RESPONSES_TURN_SEPARATOR = "[The exchange between these two assistant turns was compressed.]";

export function repairResponsesAssistantOrdering(folded: CoreMessage[], original: CoreMessage[]): CoreMessage[] {
    const runOf = new Map<string, number>();
    const runHasBody = new Map<number, boolean>();
    let run = 0;
    let inRun = false;
    for (const m of original) {
        if (m.role === "assistant") {
            if (!inRun) { run++; inRun = true; }
            runOf.set(m.id, run);
            if (m.contentType !== "reasoning") runHasBody.set(run, true);
        } else {
            inRun = false;
        }
    }
    const survivorCount = new Map<number, number>();
    for (const m of folded) {
        const r = m.role === "assistant" ? runOf.get(m.id) : undefined;
        if (r !== undefined) survivorCount.set(r, (survivorCount.get(r) ?? 0) + 1);
    }

    const out: CoreMessage[] = [];
    let phase = -1;
    let seenReasoning = false;
    let sepSeq = 0;
    const pushSeparator = (): void => {
        sepSeq++;
        out.push({ id: `acp_turn_sep_${sepSeq}`, role: "user", contentType: "text", text: RESPONSES_TURN_SEPARATOR });
        phase = -1;
        seenReasoning = false;
    };
    for (const m of folded) {
        if (m.role !== "assistant") {
            out.push(m);
            phase = -1;
            seenReasoning = false;
            continue;
        }
        const kind = m.contentType === "reasoning" ? "reasoning" : m.contentType === "tool-call" ? "tool-call" : "message";
        const r = runOf.get(m.id);
        if (kind === "reasoning" && r !== undefined && runHasBody.get(r) && survivorCount.get(r) === 1) continue;
        if ((kind === "reasoning" && (phase > 0 || seenReasoning)) || (kind === "message" && phase === 2)) pushSeparator();
        out.push(m);
        if (kind === "reasoning") { phase = Math.max(phase, 0); seenReasoning = true; }
        else if (kind === "message") phase = Math.max(phase, 1);
        else phase = Math.max(phase, 2);
    }
    return out;
}

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
    const renderTags: "text-only" | "none" = process.env.ACP_RENDER_NONE || isCompactionTrigger ? "none" : "text-only";

    try {
        const projection = responsesToCore(parsed);
        responsesProjection = projection;
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
        if (process.env.ACP_DEBUG) {
            log("info", `[${sessionId}] input items: ${Array.isArray(parsed.input) ? parsed.input.map((i: ResponseInputItem) => i.type).join(",") : "(string)"}`);
        }
        const tokenCount = effectiveTokenCount(session, msgs, imageTokensInParsedBody("responses", parsed, imageBillingFor(opts, billingUpstream ?? upstreamOrigin)));
        // Absorb markers ride in the kernel's processTurn output (gated by
        // config.absorb). The marker/text protocol has no native tool channel,
        // so strip absorb from the loop config there (both modes).
        const absorbBlock = effectiveAbsorbBlock(pluginMode, config, opts.compress.absorb);
        const absorbTools = absorbToolsFor(absorbBlock?.toolName ?? ABSORB_TOOL_NAME);
        const absorbActive = absorbBlock?.enabled === true && shouldInject && !isCompactionTrigger && !responsesTextProtocol;
        const rulesActive = rulesEnabled(config) && shouldInject && !isCompactionTrigger && !responsesTextProtocol;
        const loopConfig = ccrLoopConfig(session, { ...config, absorb: absorbActive ? absorbBlock : undefined });
        // #1195: pre-turn snapshot of the fold's covered ids — syncBlocks inside
        // processTurn may deactivate fully-drifted blocks, erasing them.
        const foldCoveredBefore = session.stats.pendingFoldUsage === true
            ? new Set(session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])))
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
        const willInjectNudge = opts.compress.injectNudge && !!turn.nudge && shouldInject && !isCompactionTrigger && (turn.nudge.shouldInject || emergencyNudge(turn.nudge));
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, parsed.model, willInjectNudge));
        processedMessages = repairResponsesAssistantOrdering(stripReasoning(stripKernelSummaries(turn.messages, turn.state)), originalMessages);
        reapOrphansLogged(session, msgs, log, sessionId);
        // [#1095] arrival-time image downscale (see prepareAnthropic).
        await applyImageCompressionPass(session, processedMessages as BiliMessage[], { config, billing: imageBillingFor(opts, billingUpstream ?? upstreamOrigin), log });
        rebuiltInput = patchResponsesInput(projection, processedMessages);
        if (Array.isArray(rebuiltInput)) rebuiltInput = hoistTrappedToolItems(rebuiltInput);
        // Fallback path: when the echo did NOT come back this turn (client
        // dropped it / restarted), the history-borne handoff is absent and the
        // forge-time captured summaries are re-injected into the developer
        // message so the pre-compaction content is never lost. When the echo
        // DID come back, the replacement message carries the summaries and
        // the injection is suppressed to avoid duplicating them.
        const forgedSummaries = echoReplaced
            ? []
            : (session.metadata.codexForgedSummaries as string[] | undefined) ?? [];
        if (shouldInject && !isCompactionTrigger && !process.env.ACP_NO_COMPRESS_PROMPT) {
            const prompt = withConversationIdNote(withMarkerIntegrityNote(withSummaryBudgetNote(responsesTextProtocol ? buildCompressHybridSystemPrompt(prompts, surface?.promptSections) : buildCompressSystemPrompt(prompts, surface?.promptSections)), visibilityMarkers), ensureCanonicalId(session));
            const devParts = [...projection.systemParts, ...forgedSummaries, prompt];
            if (absorbActive) devParts.push(buildAbsorbSystemPrompt(absorbToolName(loopConfig)));
            const devContent = devParts.join("\n\n---\n\n");
            responsesDevContent = devContent;
            rebuiltInput = injectResponsesDeveloperMessage(rebuiltInput, devContent);
            if (!process.env.ACP_NO_INJECT_TOOL && injectTools) {
                const respExtra = [...(absorbActive ? [absorbTools.responses] : []), ...(rulesActive ? [RULE_TOOL_RESPONSES] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).responses] : []), ...(imageCompressionEnabled(session) ? [IMAGE_FULL_TOOL_RESPONSES] : [])];
                toolsOut = responsesTextProtocol
                    ? injectResponsesTool(parsed.tools, BILI_ACP_READONLY_TOOLS_RESPONSES, surface?.toolPrompts)
                    : injectResponsesTool(parsed.tools, respExtra.length > 0 ? [...BILI_ACP_TOOLS_RESPONSES, ...respExtra] : BILI_ACP_TOOLS_RESPONSES, surface?.toolPrompts);
            }
        } else if (projection.systemParts.length > 0 || forgedSummaries.length > 0) {
            const devContent = [...projection.systemParts, ...forgedSummaries].join("\n\n---\n\n");
            responsesDevContent = devContent;
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
            try {
                const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections);
                if (rendered.text) {
                    const inputItems: ResponseInputItem[] = typeof rebuiltInput === "string"
                        ? [{ type: "message", role: "user", content: rebuiltInput }]
                        : rebuiltInput;
                    inputItems.push({ type: "message", role: "user", content: withMarkerIntegrityNote(withSummaryBudgetNote(withStagedCompressGuidance(rendered.text)), visibilityMarkers) });
                    rebuiltInput = inputItems;
                }
            } catch {
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

    const rebuilt: ResponsesRequestBody = { ...parsed, input: rebuiltInput, tools: toolsOut };
    warnResponsesReasoningPairs(Array.isArray(rebuiltInput) ? rebuiltInput : [], log, sessionId);
    if (!isCompactionTrigger) {
        clampOutgoingOutput(rebuilt as Record<string, unknown>, "max_output_tokens", { systemText: (responsesProjection?.systemParts ?? []).join("\n"), tools: toolsOut, processedMessages, lastInputTokens: session.stats.lastInputTokens, nativeWindow, imageTokens: imageTokensInParsedBody("responses", rebuilt, imageBillingFor(opts, billingUpstream ?? upstreamOrigin)) }, sessionId, log);
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
    // ACP_KEEP_RESPONSE_ID=1 to preserve it (diagnostic only). `instructions`
    // was already lifted into the developer message at input[1]; forwarding it
    // again here double-sends it and violates the responses_lite contract
    // (top-level instructions must stay empty for code_mode tool exposure).
    if (process.env.ACP_KEEP_RESPONSE_ID !== "1") delete rebuilt.previous_response_id;
    delete rebuilt.instructions;
    // Same rationale as prepareOpenai: strip the OpenAI-host-only cache
    // directive; keep prompt_cache_key. Sent by hermes' codex transport and
    // by any PI_CACHE_RETENTION=long client.
    delete (rebuilt as Record<string, unknown>).prompt_cache_retention;
    // Log the final tools we forward upstream so we can confirm ACP tools are
    // present. Distinguishes "compress" (top-level function) from Codex
    // namespace items (type:namespace/custom).
    if (process.env.ACP_DEBUG) {
        const fwdTools = (Array.isArray(toolsOut) ? toolsOut : []).map((t) => {
            const r = t as Record<string, unknown>;
            const sub = Array.isArray(r.tools) ? `(${r.tools.length} sub)` : "";
            return `${r.type as string}:${(r.name as string) ?? "?"}${sub}`;
        });
        log("info", `[${sessionId}] responses forward tools=[${fwdTools.join(",")}] injectTool=${injectTools}${pluginMode ? " (plugin mode: wire injection suppressed)" : ""} NO_INJECT_TOOL=${!!process.env.ACP_NO_INJECT_TOOL} NO_COMPRESS_PROMPT=${!!process.env.ACP_NO_COMPRESS_PROMPT}`);
    }
    // #532: measure the outbound developer(system)+tools overhead for the panel.
    // On this wire the system rides the injected developer message outside the
    // fold space, so counting devContent + tools does not double-count the
    // mid-history items the kernel already classifies.
    if (transformOk) {
        session.metadata.systemPromptTokens = countSystemAndToolsTokens(responsesDevContent ?? "", toolsOut);
    }
    // #728: record this turn's outbound payload upper bound as the fallback
    // token source for upstreams that never report usage (see effectiveTokenCount).
    // Compaction-trigger requests are the compression mechanism itself — no
    // incremental decision hangs off them, so don't leave a stale reading.
    if (!isCompactionTrigger) {
        session.stats.localInputEstimate = estimateCoreMessagesUpper(processedMessages.length > 0 ? processedMessages : originalMessages)
            + countSystemAndToolsTokens(responsesDevContent ?? "", toolsOut)
            + imageTokensInParsedBody("responses", rebuilt, imageBillingFor(opts, billingUpstream ?? upstreamOrigin));
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
        const turn = core.processTurn({ messages: projection.msgs, state: session.state, config: compactConfig, tokenCount: session.stats.lastInputTokens, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only", contentStore: contentStoreOf(session) });
        session.state = turn.state;
        adoptContentStore(session, turn.contentStore);
        transformOk = true;
        if (!codexCompactGate(session, config.modelContextLimit, transformOk)) {
            session.state = prevState;
            session.contentStore = prevStore;
            session.contentStoreDirty = prevStoreDirty;
            return base;
        }
        const viewed = applyAbsorbView(turn.messages, turn.state, compactConfig, session.stats.lastInputTokens);
        const processed = repairResponsesAssistantOrdering(stripKernelSummaries(viewed, turn.state), projection.msgs);
        let output = patchResponsesInput(projection, processed);
        if (typeof output === "string") {
            session.state = prevState;
            session.contentStore = prevStore;
            session.contentStoreDirty = prevStoreDirty;
            return base;
        }
        output = hoistTrappedToolItems(output);
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

/** When true, the Responses path teaches compression via a text trigger
 *  instead of a function tool. Used for hosts (OpenAI Codex code_mode) whose
 *  server-side tools are disabled the moment any `tools` entry is declared.
 *  In text mode we keep `tools` untouched (undefined) so code_mode stays
 *  active, and detect the trigger in the output_text stream instead. */
export const FORCE_TEXT_PROTOCOL = process.env.ACP_COMPRESS_PROTOCOL === "text";
