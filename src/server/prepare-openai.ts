import http from "node:http";
import type { CompressionCore, Config, CoreMessage, NudgeDecision, PackSurface, Prompts } from "acp-kernel";
import { isRenderedSummaryMessage, renderNudgeText, viableRanges } from "acp-kernel";
import { recordNudgeInject } from "../cache-ledger.js";
import { coreToOpenai, injectOpenaiSystem, openaiToCore, type BiliMessage, type OpenAIRequestBody, type OpenAITool } from "acp-kernel/wire";
import type { CompressReasoningConfig } from "../reasoning-drop.js";
import type { ProxyOptions } from "../config.js";
import { effectivePromptCacheRouting } from "../config.js";
import { currentCalibrationFactor, hardenOpenaiAssistantContent, systemToUser } from "../util.js";
import { conversationHeaderSource, resolveRelayAffinityPck } from "../session-id.js";
import { MSG_IDS_BODY_FIELD, MSG_SEQS_BODY_FIELD, MSGID_MODE_HEADER, applyMsgSeqStamps, incomingSeqsOf, validateMsgSeqs } from "../msgid-pin.js";
import { pluginAgentHeader } from "../plugin.js";
import { applyReasoningDrop, diagNudge, diagTagSummary, deriveTitle, effectiveTokenCount, imageBillingFor, imageReserveFor, imageTokenCapFor, isAutoInjectedNotification, planReasoningDrop, reapOrphansLogged, resolveKnownOutputCeiling, runNudgeDecision, stripKernelSummaries, warnDroppedOpenaiParts, warnReasoningPairs, type Prepared } from "../server.js";
import { isSubagentPrompt } from "../session-title.js";
import { recordNudgeObservation } from "../context-analysis.js";
import { yieldToEventLoop } from "../yield-loop.js";
import { buildDecisionPrompt, buildDirectiveText, consumeFallback, ladderMode, resolveDecisionRange, stripDecisionReasoningFields, type DecideConfig } from "../nudge-decide.js";
import { emitNudgeInjected, nudgeDebugMeta } from "../nudge-debug.js";
import { excludeDeadRefRanges } from "../acp-status.js";
import { reconcileFoldCoverage, noteSystemPromptFingerprint, resolveFoldReconcileMode } from "../fold-reconcile.js";
import { maybeSnapshotView, probeTranscriptAlignment } from "./snapshot-render.js";
import { storedMessagesFor, storedRowLookupFor } from "../fold-decomposition-lookup.js";
import { nudgeSuppressed } from "../session-self-heal.js";
import { compressBreakerArmed } from "../stream.js";
import { absorbAbortedTurnGrowth, nudgeStampsOf, restoreNudgeStamps, applyCompactionArchive, coveredRealHistoryIds, detectUnannouncedHistoryRewrite, foldCoverage, markCompactionBoundary, markDirty, markNativeCompactionBoundary, reconcileNativeCompactionBoundary, REWRITE_MIN_INCOMING_TOTAL, snapshotMessages, type PendingRetrieval, type Session } from "../session.js";
import { getStore } from "../persist.js";
import { carriesDshLocalCompactionSummary, DSH_LOCAL_COMPACTION_MIN_MISSING } from "./dsh-compaction-guard.js";
import { carriesBiliSnapshotCheckpoint } from "./dsh-authored-compaction.js";
import { carriesCodexLocalCompactionSummary, CODEX_LOCAL_COMPACTION_MIN_MISSING, isCodexHost } from "../codex-compact.js";
import { ABSORB_TOOL_NAME, READ_ORIGINAL_IMAGE_TOOL_OPENAI, RULE_TOOL_OPENAI, absorbToolsFor, blockOpsTools, buildAbsorbSystemPrompt, buildAcpTagsOnlyPrompt, buildCompressSystemPrompt, retrieveToolsFor, withFirstSightDrain, withMarkerIntegrityNote, withMcpDialectNote, withSummaryBudgetNote, withProjectAttribution } from "../compress-tool.js";
import { absorbToolName, applyAbsorbView, storeEffectiveAbsorb } from "../absorb.js";
import { storeEffectiveBlockOps } from "../acp-block-ops.js";
import { buildBlockOpsSystemPrompt } from "acp-kernel";
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
import { logRawStripCounts, markerArtifactCount, stripRawStage, type RawStripCounts } from "../marker/engine.js";
import { egressPlaneGateOn, imageRescaleMaxDim, renderNone as knobRenderNone } from "../knobs.js";
import { SessionStore } from "../persist.js";
import { FoundationRejectError } from "../snapshot/plane.js";
import { runStage0 } from "../snapshot/stage0.js";
import { applyImageRescalePass } from "../image-rescale.js";
import { clampOutgoingOutput, countSystemAndToolsTokens, dshLedgerFloorTokens, emergencyNudgeArmed, emergencyNudgeForConfig } from "./budget.js";
import { effectiveAbsorbBlock, effectiveBlockOpsEnabled } from "./prepare-responses.js";
import { injectOpenaiTool, injectTool } from "./inject.js";
import { nudgeOn, resolveLaneDecisions, surfaceOffDetail } from "./lane-decisions.js";
import { featureEnabled } from "../rollout.js";
import { recordEgressTurn, EgressAuthorityRejectError } from "../storage/egress-record.js";
import type { EgressViewRow } from "../storage/egress-state.js";
// Structural mirror of egress-record.ts's EgressSourceMsg (kept private
// there by the unused-export gate): the recording seam only reads this shape.
interface EgressRecordSourceMsg {
    id: string;
    role: string;
    contentType?: unknown;
    text?: unknown;
}
import { rebuildOutboundFromLog } from "../storage/egress-serve.js";
import { resolveEgressAuthority, egressAuthorityArmed, egressBlockLedgerFor, stampEgressSeqs } from "./egress-lane-io.js";
import { EgressConcurrentWriteError } from "../storage/egress-state.js";
import { DeltaReanchorError, PF_TAIL_IDS_HEADER, evaluateDeltaResend, evaluateWatermarkFastpath, finalizeWatermarkTurn, parseTailIdsForPin, type FastpathHit, type FastpathOutcome } from "./fastpath.js";
import { collectRequestIds, probeRequestMembership } from "../request-membership.js";

/** #7398: put the conversation array back into a body whose parse handle.ts
 *  deferred. Everything else is kept EXACTLY as it stands on `parsed`.
 *
 *  Under the deferral gate `parsed` is the span-scan synthesis (every
 *  top-level field decoded, `messages` = null marker), and handle.ts has
 *  since mutated it in place: the dsh client-extension strip (#7168/#7439),
 *  stale chain-carrier removal, the leaked-tool veto, the #6752 output-budget
 *  restore, and — at the top of prepareOpenai — the bili msg-id/seqs body
 *  fields deleted so the real upstream never sees them. Rebuilding the
 *  top-level object from the raw wire text (what this function replaced)
 *  resurrected every one of those: a watermark hit forwarded a stripped
 *  `dsh_session_log` again and a starved max_tokens until #6752 special-cased
 *  the budget. Taking the fields from `parsed` and only `messages` from the
 *  wire covers all of them, present and future.
 *
 *  `wireOrder` is the wire key order (JSON.parse order, duplicate keys keep
 *  their first position) so the re-serialized body stays byte-identical to
 *  the non-deferred path — a moved `messages` key would cost the upstream
 *  prefix cache the whole conversation. A key `parsed` no longer carries was
 *  removed on purpose and stays removed. */
function materializeDeferredBody(parsed: OpenAIRequestBody, wireOrder: Iterable<string>, messages: unknown): OpenAIRequestBody {
    const top = parsed as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of wireOrder) {
        if (key === "messages") out[key] = messages;
        else if (key in top) out[key] = top[key];
    }
    return out as unknown as OpenAIRequestBody;
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
    decide?: DecideConfig,
    bodyText?: string,
    bodyParseDeferred = false,
): Promise<Prepared> {
    const sessionId = session.id;
    const stream = parsed.stream === true;
    // #5825/#4491 parity: bili-namespaced msgid channel on the openai wire.
    // Stripped UNCONDITIONALLY — same discipline as the anthropic twin:
    // the real upstream must never see a field it does not know. Sources:
    // host body stamps (pi incremental lane) or the #5825 handle-seam
    // re-stamp of stamped-header/harvested ids.
    const incomingMsgIds = (parsed as Record<string, unknown>)[MSG_IDS_BODY_FIELD];
    // #5874 2×2: the seqs carrier (biliLedgerSeqs) — the M2 incremental
    // join evidence. An optimization channel, not an identity channel:
    // malformed/absent → the M2 fast path is disabled (the full-resend
    // matchWorld path still works); it never 400s. (Stamped once msgs
    // exists, below.)
    const incomingSeqsRaw = incomingSeqsOf(parsed);
    delete parsed[MSG_SEQS_BODY_FIELD];
    delete (parsed as Record<string, unknown>)[MSG_IDS_BODY_FIELD];
    // #7064 §8: the INCREMENTAL pin reuses the watermark's bounded tail-ids
    // header — the same bytes that ride the wire for the hit verdict pin the
    // prefix when the full list is absent. Three-state handoff to stage 0
    // (undefined = header absent, null = malformed → degrade, array = valid,
    // "?" slots kept). The fastpath re-parses the header itself for its own
    // verdict — one parser, one rule (parseTailIdsForPin).
    // #6785 review note (owner): this parse is DELIBERATELY ungated by
    // pluginMsgIdIncremental — a flag-OFF server must still READ a client's
    // tail-ids declaration, because the rollback self-heal signal ("full")
    // is derived from it (stage 0's tail-ids branch). Gating the parse
    // behind the flag would strand upgraded clients after a rollback.
    const rawTailIdsHeader = req.headers[PF_TAIL_IDS_HEADER];
    const incomingTailIds: string[] | null | undefined =
        rawTailIdsHeader === undefined ? undefined
        : typeof rawTailIdsHeader === "string" ? parseTailIdsForPin(rawTailIdsHeader)
        : null;
    // Real wire element count; a watermark hit overrides it with the measured
    // total T (see the #5403/#5418 block below).
    let inboundMessageCount = Array.isArray(parsed.messages) ? parsed.messages.length : 1;
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
    let nudgeStampsBefore: Prepared["nudgeStampsBefore"];
    let rebuiltMessages = parsed.messages;
    let toolsOut = parsed.tools;
    // #7398 seg 4: the legacy core-portion elements (captured at the
    // :coreToOpenai chain) — the shadow comparison target for serve-from-log.
    let legacyCoreElements: unknown = undefined;
    let egressBaseRows: EgressViewRow[] | null = null;
    let egressBaseSeq = 0;
    let egressSwapApplied = false;
    let egressBootstrap = false;
    let egressArmed = false;
    let egressServedFromLog = false;
    // The EXACT array fed to the outbound chain (post reasoning-drop / ccr /
    // image-rescale) — segment 3 records this, not processedMessages, so the
    // log view is position-for-position what outbound saw.
    let egressRecordSource: readonly EgressRecordSourceMsg[] | undefined;
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
    // zed cloud wire: the response is NDJSON byte-passthrough, so an in-stream
    // acp loop is structurally unreachable (same reasoning as DSH #3177) — the
    // model-side compress surface (tools + standing prompt + nudge) is off.
    const zedLane = req.headers["x-bili-zed-lane"] !== undefined;
    const shouldInject = opts.compress.injectTool && !isTitleGen && !zedLane;
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

    // #5403/#5418 watermark fastpath (rollout-gated; plugin lane only): a
    // verified hit ASSERTS the re-sent prefix is unchanged, so this turn skips
    // the full-body re-strip/re-convert below — the prefix view comes from the
    // seed stash minted on identical bytes last turn (#3642 deterministic ids),
    // while head + tail fragments and scalar fields are decoded from raw
    // slices. Every miss falls through to the legacy path byte-identically.
    let wpHit: FastpathHit | undefined;
    let wpOutcome: FastpathOutcome | null = null;
    let wpFullText: string | undefined;
    const wpModel = typeof parsed.model === "string" ? parsed.model : "";
    if (bodyText !== undefined && pluginMode && !isTitleGen && featureEnabled("pluginFullResendWatermark")) {
        wpFullText = bodyText;
        // Delta arm first: a delta claim is EXCLUSIVE — the body carries only
        // the tail slice, so the full-body lane cannot evaluate it at all. A
        // satisfiable claim yields the same FastpathHit the full lane would;
        // an unsatisfiable one throws the 400 re-anchor (handle.ts).
        const wpDelta = evaluateDeltaResend(parsed, bodyText, req, session, { pluginMode, titleGen: isTitleGen, model: wpModel }, log);
        if (wpDelta !== null) {
            if ("reanchor" in wpDelta) throw new DeltaReanchorError(wpDelta.reanchor);
            wpOutcome = { hit: wpDelta.hit, measuredT: wpDelta.hit.totalT, decision: "delta-hit", creditedMiss: false, receivedTailIds: wpDelta.receivedTailIds };
            log("debug", `[${session.id}] fastpath ${wpOutcome.decision} T=${wpDelta.hit.totalT}`);
        } else {
            wpOutcome = evaluateWatermarkFastpath(bodyText, req, session, { pluginMode, titleGen: isTitleGen, model: wpModel }, log);
            log("debug", `[${session.id}] fastpath ${wpOutcome.hit ? "HIT" : wpOutcome.decision}${wpOutcome.creditedMiss ? "(credited)" : ""}${wpOutcome.measuredT !== undefined ? ` T=${wpOutcome.measuredT}` : ""}`);
        }
    }
    // #7398 perf: the deferral gate in handle.ts skipped the full JSON.parse
    // (150-600ms on a 155MiB resend), so `parsed` is still the span-scan
    // synthesis — every top-level field decoded, the conversation array left
    // as the null marker. Two ways to materialize it, both keeping every
    // OTHER field exactly as it stands on `parsed` (see materializeDeferredBody):
    //   hit   — the window view; no prefix byte is ever decoded;
    //   else  — the gate stayed closed (non-plugin lane, title-gen, rollout
    //           flag off) or the lanes missed: the legacy path needs the whole
    //           array, parsed exactly once here. A throw equals the legacy
    //           parse failure (same catch in handle.ts).
    if (wpOutcome?.hit) {
        wpHit = wpOutcome.hit;
        parsed = materializeDeferredBody(parsed, wpHit.fieldSpans.keys(), wpHit.windowMessages);
        inboundMessageCount = wpHit.totalT;
    } else if (bodyParseDeferred && !Array.isArray(parsed.messages) && bodyText !== undefined) {
        const full = JSON.parse(bodyText) as OpenAIRequestBody;
        parsed = materializeDeferredBody(parsed, Object.keys(full), full.messages);
        inboundMessageCount = Array.isArray(parsed.messages) ? parsed.messages.length : 1;
    }
    // Full-body text for the whole-wire image accounting (window-only bodies
    // would under-count pre-existing images).
    const reserveBody: OpenAIRequestBody | string = wpHit !== undefined && wpFullText !== undefined ? wpFullText : parsed;
    let wpSeedSystemText = "";
    let wpTurnStrip: RawStripCounts | undefined;
    // On a watermark hit no walk runs this turn — the cached counts describe
    // the window's logical view, so report zero wall time for THIS turn (#6018).
    const markerCounts = wpHit !== undefined ? { ...wpHit.markerCounts, strippedMs: 0 } : stripRawStage(parsed, "openai");
    logRawStripCounts(markerCounts, log, sessionId);

    // #5874 P2-final: in-request snapshot flush verdict (set after processTurn,
    // read at end-of-prepare to decide whether the debounce still needs a shot).
    let snapFlush: { ok: boolean; epoch: number | undefined } | undefined;
    // #7064 §8: hoisted so the end-of-prepare response-header block can stamp
    // the pin-mode signal (stage 0 runs inside the try below).
    let s0PinMode: "full" | "incremental" | null = null;
    try {
        // Kernel 0.0.37 hoists the contiguous leading system/developer prefix
        // OUT of the fold space: system content is host runtime state and
        // must not feed ids/fingerprints. Capture it and re-inject below —
        // otherwise the proxy would forward payloads without any system.
        const converted = wpHit !== undefined ? { msgs: wpHit.view, systemText: wpHit.systemText } : openaiToCore(parsed);
        let msgs = converted.msgs;
        // #5874 2×2: stamp the M2 seqs carrier onto the converted array
        // (parallel to messages; malformed/absent → null → M2 fast path
        // disabled, the full-resend path still works).
        const incomingSeqs: number[] | null =
            incomingSeqsRaw !== undefined && incomingSeqsRaw.length === msgs.length && validateMsgSeqs(incomingSeqsRaw, msgs.length).ok
                ? incomingSeqsRaw
                : null;
        if (incomingSeqs !== null) applyMsgSeqStamps(msgs, incomingSeqs);
        let systemText = converted.systemText;
        openaiSystemText = systemText;
        wpSeedSystemText = systemText;
        wpTurnStrip = markerCounts;
        warnDroppedOpenaiParts(parsed, sessionId, log);
        // Title-gen side-requests carry their own tiny system — reconciling
        // them would pollute the conversation's anchor state.
        if (opts.stableSystemAnchor && !pluginMode && !isTitleGen) {
            const outcome = reconcileSystemAnchor(session, "openai", systemText, sessionId, log);
            sysNotes = outcome.notes;
            openaiSystemText = outcome.outbound;
        }
        originalMessages = msgs;
        // #4491/#5825 + #5874 2×2 stage 0 (brief 19544722 / #6181): the
        // SHARED pin + world-match + kernel-input assembly for cohort
        // traffic (src/snapshot/stage0.ts — the responses lane runs the
        // SAME helper, same red gate, same one-round-convergence
        // contract). Runs BEFORE processTurn, so a thrown
        // FoundationRejectError (R3) carries zero kernel side effects
        // (the server funnel maps it to the hard 400); every other fault
        // → the legacy full path (one-round convergence).
        const s0 = runStage0({
            sessionId,
            lane: "openai",
            msgs,
            incomingMsgIds,
            incomingSeqs,
            incomingTailIds,
            pluginMode,
            // Identity consolidation (discussions/7591): egress-on sessions
            // carry no conversations row — the in-memory metadata field is
            // the row's source of truth, use it instead of the store lookup.
            // Predicate mirrors the row write verbatim (ingest.ts namespace =
            // the pluginAgent when a non-empty string, else "proxy") so the
            // two cannot drift apart.
            convBound: session.metadata["egressAuthority"] === true ? (typeof session.metadata["pluginAgent"] === "string" && session.metadata["pluginAgent"] !== "") : undefined,
            wpHit,
            log,
        });
        s0PinMode = s0.pinMode;
        if (s0.pinned !== null) {
            msgs = s0.pinned;
            originalMessages = msgs;
        }
        // #7064 D3 (尾锚常活): the stage-0 cursor may have advanced BEFORE
        // processTurn — bump the session revision so the per-turn snapshot
        // flush below (snapFlush epoch proof) observes the advance. A fork
        // taken between the cursor write and the flush otherwise reads a
        // STALE parent revision and lands the child on the wrong lane.
        if (s0.anchorAdvanced) markDirty(session);
        // Ruling 7439-5 (owner strategy decision, discussions/7439 §1) — the
        // server egress flow is the SOLE authority over conversation content.
        // This is the ONE prepare-layer seam where the client's resend is
        // demoted to what it is after turn 1: the identity/order channel (the
        // probe below) and the byte source for NEW messages only. On a pinned
        // plugin-lane turn with a live op-log flow, every EXISTING row below
        // carries the bytes the SERVER recorded last turn; a client byte edit
        // under a stable msgid is a divergence event (logged + warned), the
        // server bytes win, and — because the outbound is served from the same
        // log below — the client converges on its next echo. Legitimate client
        // edits need the egress update API (follow-up, not in this PR). This
        // OVERRIDES the pre-PR plugin-lane stance (snapshot-render.ts: "plugin
        // lane: client-authoritative by design"). Scope is deliberately the
        // PINNED plugin lane (both modes reasoned): bare proxy clients are
        // tamper-evident by construction — their ids ARE content hashes, so a
        // byte edit changes the id and already lands in the rewrite/drift
        // gates — and proxy-lane kernel input must stay the RAW history (the
        // kernel folds internally; a post-fold replay view would double-fold
        // and trip #1001/#2432/#4521). The proxy lane gets ruling 5 on the
        // EGRESS side (outbound served from the log); the pinned plugin lane
        // gets it end-to-end (kernel input + outbound).
        // Degrade (never guess, never client-as-authority): store missing or
        // an unrebuildable view → the swap simply does not happen this turn
        // (record still runs — see below — and the next turn re-attempts).
        // Hard failure (ruling 7439-5's one non-negotiable): NO healthy flow
        // point at all → the request fails, it does NOT run on client bytes
        // (a divergent client being served as authority is the exact
        // condition the ruling forbids); the marker latches for the operator
        // and the client's retry hits the same error until recovery.
        // Bootstrap: an armed turn with an EMPTY flow is the turn-1 cold start
        // the ruling allows — the client bytes enter the flow exactly once
        // (the record below), from turn 2 the log is the content source.
        egressArmed = egressAuthorityArmed({ pluginMode, pinned: s0.pinned !== null, sideRequest: isTitleGen });
        if (egressArmed) {
            // The single shared authority seam (egress-lane-io): latch,
            // recover, hard-fail, bootstrap / swap / legacy — one code path
            // for all four lanes. This lane sits PRE-kernel: the swapped
            // core becomes kernel input, and the record is deferred to the
            // post-kernel segment below with this turn's exact outbound
            // array (egressRecordSource), diffed against auth.base.
            const st = getStore().egressOpLogStore();
            if (st) {
                const auth = resolveEgressAuthority({ session, st, sessionId, core: msgs, log, armed: true });
                egressBaseRows = auth.base;
                egressBaseSeq = auth.baseSeq;
                egressBootstrap = auth.bootstrapping;
                if (auth.swappedCore !== null) {
                    msgs = auth.swappedCore;
                    originalMessages = msgs;
                    egressSwapApplied = true;
                }
            }
        }
        // #5403/#5418 v6 (R1) confirmation layer: on a watermark MISS turn
        // the full parse is already paid — let the CANONICAL transcript
        // confirm/contradict the ledger's view with a light identity-rows-only
        // probe (no content bytes), one log per session at most.
        if (wpOutcome !== null && wpHit === undefined && featureEnabled("snapshotRender")
                && session.state.blocks.some((b) => b.active)
                && session.metadata["pfV6ConfirmLogged"] !== true) {
            session.metadata["pfV6ConfirmLogged"] = true;
            const probe = probeTranscriptAlignment(session, originalMessages);
            log("debug", `[${session.id}] [pf-v6] transcript-alignment confirmation after watermark miss (${wpOutcome.decision}): ${probe.anchored ? `anchored (join row ${probe.joinRow})` : `not anchored (${probe.reason ?? "unknown"})`}`);
        }
        // #3756 snapshot render: the outbound prefix renders from the unified
        // transcript (server-authoritative, fold-time ids — immune to identity
        // re-mints #3752); only the live tail keeps the client's bytes.
        // No-op returns `msgs` when the lane is inactive/degraded.
        // reconcileFoldCoverage below still observes the CLIENT view.
        let renderMsgs = maybeSnapshotView(session, msgs, { sessionId, pluginMode, log });
        // #7439 follow-up (C6): egress-on sequence authority — canonical 1-based
        // flow message numbers on the kernel-visible cores (same reference when
        // the plane does not record this session; the id path stays authoritative).
        renderMsgs = stampEgressSeqs(getStore()?.egressOpLogStore(), sessionId, renderMsgs);

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
        const { tokens: tokenCount, source: tokenCountSource } = effectiveTokenCount(session, renderMsgs, imageReserveFor(session, "openai", reserveBody, opts, billingUpstream ?? upstreamOrigin));

        const activeBefore = new Set(session.state.blocks.filter((b) => b.active).map((b) => b.blockId));
        // Absorb markers ride in the kernel's processTurn output (gated by
        // config.absorb). Title-gen requests skip ALL injection for
        // prefix-cache stability, so strip absorb from the loop config there.
        const absorbBlock = effectiveAbsorbBlock(pluginMode, config, opts.compress.absorb);
        const absorbTools = absorbToolsFor(absorbBlock?.toolName ?? ABSORB_TOOL_NAME);
        const absorbActive = absorbBlock?.enabled === true && shouldInject;
        // #5765: block-lifecycle tools — one switch, off by default.
        const blockOps = blockOpsTools();
        const blockOpsActive = effectiveBlockOpsEnabled(pluginMode, config, opts.compress.blockOps) && shouldInject;
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
        // #4521: codex's local auto-compaction lands on THIS wire too — a codex
        // configured for chat completions (wire_api=chat, or a declared
        // providers[].protocol=openai outranking the URL heuristics, #1909)
        // never transits /v1/responses, so the #2372 detector there cannot see
        // it. Before this it fell into the generic unannounced-rewrite path
        // below: misclassified (unconfirmed-signal tier instead of handled
        // native-compaction) and WITHOUT the immediate rebase — partially-alive
        // blocks survived syncBlocks and only the #2695 zombie reap cleaned them
        // up passes later, leaving a dead-anchor window in between. Same
        // signature+rebase as the responses lane (#2372): codex identity + its
        // summary template prefix in resent history + decimated fold coverage →
        // mark AND rebase NOW so this turn's processTurn seeds fresh refs onto
        // the compacted view instead of poisoning anchors first (the #2432
        // death spiral). Runs after the dsh block so a profile matching both
        // keeps the dsh precedence the responses lane has (dshHit wins there).
        let codexRebased = false;
        if (!dshRebased && !isTitleGen && isCodexHost(req.headers) && session.state.blocks.some((b) => b.active)) {
            const coveredBeforeCodexCompact = coveredRealHistoryIds(session.state.blocks);
            const codexGap = foldCoverage(coveredBeforeCodexCompact, msgs.map((m) => m.id));
            if (codexGap && carriesCodexLocalCompactionSummary(msgs)) {
                const missing = codexGap.expected - codexGap.matched;
                if (missing >= CODEX_LOCAL_COMPACTION_MIN_MISSING && missing * 2 >= codexGap.expected) {
                    recordConflict(session, "native-compaction", `codex local auto-compaction: ${missing}/${codexGap.expected} covered id(s) replaced by the compacted history; rebasing ACP state (#2372)`);
                    log("warn", `[${sessionId}] codex local auto-compaction detected (${codexGap.matched}/${codexGap.expected} covered ids retained) — rebasing ACP state onto the compacted history (#2372/#4521)`);
                    markNativeCompactionBoundary(session);
                    codexRebased = reconcileNativeCompactionBoundary(session);
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
        const reconcileOutcome = reconcileFoldCoverage(session, msgs, { mode: foldMode, sessionId, log, markerStripped: markerArtifactCount(markerCounts), inboundMessageCount, storedMessages: foldMode === "off" ? undefined : storedMessagesFor(session, sessionId, msgs), storedRowLookup: foldMode === "off" ? undefined : storedRowLookupFor(sessionId) });
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
        // #5293: re-anchor the nudge growth reference after a user-aborted turn (no-op otherwise).
        absorbAbortedTurnGrowth(session, tokenCount);
        // #6531: snapshot before the kernel pass so a 4xx reject of the
        // nudge-carrying request rolls the cadence back to pre-turn (lane
        // mirror of the anthropic-lane fix).
        nudgeStampsBefore = nudgeStampsOf(session);
        const turn = core.processTurn({ messages: renderMsgs, state: session.state, config: loopConfig, tokenCount, tokenCountSource, renderTags: renderStrategy, contentStore: contentStoreOf(session) });
        session.state = turn.state;
        const nudgeHeldAfterReject = session.transient?.nudgeHeldAfterReject === true;
        if (nudgeHeldAfterReject) restoreNudgeStamps(session, nudgeStampsBefore);
        adoptContentStore(session, turn.contentStore);
        // In-request ledger flush: the transcript up to THIS user message is
        // durable before the model call (#3397 durability-before-render) and
        // the stage-0 envelope / M2 evidence read a current ledger.
        // snapshotMessages first: the persist build reads session.lastMessages
        // — and it stays the RAW client resend (never the D-lane view: its
        // synthetic acp_summary anchor is not a transcript message). The
        // watermark window pin is preserved.
        // #7366: on a pinned HIT turn the ledger window must carry the
        // DECLARED ids, not the window cores' fresh content-hash ids.
        // wpHit.windowCores is the tail fragment re-converted by openaiToCore
        // (fresh h_… mints), while s0.pinned is the SAME view with the id
        // field re-stamped to the client-declared host msgids (stage 0).
        // Ingesting the raw window cores wrote h_… into the ledger for every
        // post-seed row (msg_id is write-once — INSERT OR IGNORE on
        // (session_id, seq)), so the next turn's KDD#22 tail-overlap check
        // compared declared host ids against h_… rows → guaranteed drift →
        // full form every turn. pinned is element-wise a map of the same
        // view (ids only), so its tail slice aligns position-for-position
        // with windowCores; the length guard falls back to the legacy cores
        // on any shape anomaly, and unpinned turns are byte-identical.
        const ledgerWindow =
            wpHit !== undefined && s0.pinned !== null && s0.pinned.length === wpHit.totalT
                ? s0.pinned.slice(s0.pinned.length - wpHit.windowCores.length)
                : wpHit?.windowCores;
        snapshotMessages(session, ledgerWindow ?? originalMessages);
        // #7064 ledger drain: on a watermark-HIT turn that snapshot is the
        // ~2-row tail WINDOW — a verified suffix of the ledger (head check +
        // pf-seq vouch for the prefix), NOT the complete log. Claiming rawness
        // (lastMessagesFolded=false) makes the save present it as the raw tail,
        // and the #3285 authoritative-set sweep then retires every prefix row
        // the window omits — draining the msgid pin ledger (snapMsgIdLiveIds)
        // to the window, so tryIncrementalPin sees ledger≈2 and the KDD#22
        // tail form degrades to the full form every turn (full-list body +
        // 100k id validation + path=full ingest, alternating with window turns).
        // Mark the tail non-raw: persist presents the envelope view, the sweep
        // stays off, and the ledger keeps the watermark-protected prefix live
        // (KDD#21 水位线以下存活行). Every consumer of the flag already treats
        // "pruned view, not raw log" as the skip-sweep / skip-append contract
        // (persist tail selection, ingest tail_json, handoff stash, export).
        if (wpHit !== undefined) session.lastMessagesFolded = true;
        snapFlush = await SessionStore.flushOrSkip(session);
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
        storeEffectiveBlockOps(session, loopConfig);
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
        if (!session.meta.title || isAutoInjectedNotification(session.meta.title) || isSubagentPrompt(session.meta.title)) {
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
        const emergencyPressureHeld = nudgeEligible && !!turn.nudge && !turn.nudge.shouldInject && emergencyNudgeForConfig(turn.nudge, loopConfig);
        // #3482 Step 2.5: the ONE nudge gate (lane-decisions). No compaction trigger
        // and no intercept health window on this wire — those differences are
        // explicit inputs on the responses lane. The standalone `shouldInject`
        // conjunct is subsumed by compressSurfaceOn (=== shouldInject &&
        // compressReachable).
        const willInjectNudge = !nudgeHeldAfterReject && nudgeOn({
            injectNudge: opts.compress.injectNudge,
            hasNudgePlan: !!turn.nudge,
            compressSurfaceOn: laneDecisions.compressSurfaceOn,
            compactionTrigger: false,
            suppressionBypassed: !nudgeSuppressed(session) || decideFallbackOverride,
            breakerArmed: compressBreakerArmed(session),
            autoFoldEngaged: autoFoldEngaged(loopConfig, session),
            growthFoldingArmed: growthFoldingArmed(loopConfig, undefined, autoFoldFloor(session)),
            modelWantsIt: turn.nudge !== undefined && (turn.nudge.shouldInject || emergencyNudgeArmed(session, turn.nudge, loopConfig.compress.minCompressRange, tokenCount, loopConfig.nudge.growthFloor, loopConfig.nudge.maxContextLimitPct)),
        });
        const caLine = recordNudgeObservation(sessionId, turn, tokenCount, config.modelContextLimit, willInjectNudge, decideTier1Arm && !decideFallbackOverride, surfaceOffDetail(laneDecisions, opts.compress.injectTool));
        if (caLine) log("info", caLine);
        log("info", diagNudge(turn, sessionId, tokenCount, config.modelContextLimit, parsed.model, willInjectNudge, decideTier1Arm && !decideFallbackOverride, surfaceOffDetail(laneDecisions, opts.compress.injectTool)));
        processedMessages = applyReasoningDrop(stripKernelSummaries(turn.messages, turn.state), reasoningPlan, log, sessionId);
        // #1001: a silent client history rewrite takes the same archive+prune path
        // as an announced /compact boundary — syncBlocks above has already
        // deactivated the blocks whose sources left the context. Skipped when
        // the rewrite was just classified as dsh native compaction above
        // (#2432) or codex local auto-compaction (#2372/#4521): it is already
        // recorded as "native-compaction" and rebased — a second
        // "unannounced-rewrite" entry beside it would present the substrate
        // destruction as "another compressor fighting you".
        if (!dshRebased && !codexRebased) {
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
        // #7398 seg 4b: egress serve-from-log decision. The sysParts block that
        // used to follow this line is computed FIRST (moved up) because the
        // op-log recording stores the outbound system text and the rebuild
        // replaces the conversation elements below.
        const sysParts: string[] = [];
        if (openaiSystemText) sysParts.push(openaiSystemText);
        let acpStandingPushed = false;
        if (laneDecisions.compressSurfaceOn) { sysParts.push(withProjectAttribution(withMcpDialectNote(withMarkerIntegrityNote(withSummaryBudgetNote(buildCompressSystemPrompt(prompts, messageTimestampSections(conversationPromptSections(surface?.promptSections, externalSummaryEnabled(config)))), externalSummaryEnabled(config)), visibilityMarkers), laneDecisions.mcpDialect, blockOpsActive))); acpStandingPushed = true; }
        else if (!isTitleGen && !knobRenderNone()) {
            // #1881: the NEVER-echo prohibition follows the rendered tags, not the tool switch.
            const tagsOnly = buildAcpTagsOnlyPrompt("function", prompts, messageTimestampSections(surface?.promptSections));
            if (tagsOnly) { sysParts.push(tagsOnly); acpStandingPushed = true; }
        }
        // #4305: standing generation-boundary note — rides the ACP standing block,
        // byte-stable once detected; never on a view that carries no ACP surface.
        if (acpStandingPushed && detectGenerationBoundary(session, processedMessages, log)) sysParts.push(GENERATION_BOUNDARY_NOTE);
        if (absorbActive) sysParts.push(buildAbsorbSystemPrompt(absorbToolName(loopConfig)));
        if (blockOpsActive) sysParts.push(buildBlockOpsSystemPrompt("function"));
        openaiOutboundSystem = sysParts.join("\n\n");
        if (!isTitleGen && egressPlaneGateOn() && !(egressArmed && !egressSwapApplied)) {
            const st = getStore().egressOpLogStore();
            if (st) {
                try {
                    const view = recordEgressTurn({
                        store: st,
                        sessionId,
                        prev: egressBaseRows ?? undefined,
                        baseSeq: egressBaseSeq,
                        conversation: egressMessages,
                        systemText: openaiOutboundSystem,
                        nowMs: Date.now(),
                        blockLedger: egressBlockLedgerFor(session),
                        refMap: session.state.messageRefs,
                    });
                    const reb = rebuildOutboundFromLog(view);
                    if (reb !== null) {
                        rebuiltMessages = reb.elements;
                        egressServedFromLog = true;
                        log("info", `[${sessionId}] egress-serve: served ${view.length} rows from op-log`);
                    }
                } catch (err) {
                    egressServedFromLog = false;
                    log("warn", `[${sessionId}] egress-serve rebuild failed — legacy kept: ${String(err)}`);
                }
            }
        }
        if (!egressServedFromLog) {
            rebuiltMessages = hardenOpenaiAssistantContent(coreToOpenai(systemToUser(egressMessages, (m) => isRenderedSummaryMessage(m))));
        }
        legacyCoreElements = rebuiltMessages;
        egressRecordSource = egressMessages;

        // ONLY the static compress prompt goes into the system message — the
        // system prompt is the prefix-cache anchor and must be byte-stable
        // across turns. The nudge (which changes every turn: token count,
        // growth %, dynamic example) is appended as a trailing user message
        // instead, mirroring pai-acp's design. Putting the nudge in system
        // would invalidate the cache every turn.
        // sysParts was computed above (seg 4b serve decision needs it).
        rebuiltMessages = injectOpenaiSystem(rebuiltMessages, sysParts);
        if (sysNotes.length > 0) {
            rebuiltMessages = [...rebuiltMessages, ...sysNotes.map((text) => ({ role: "user" as const, content: text }))];
        }
        // #532: openaiOutboundSystem was captured above (seg 4b moved it up so
        // the op-log recording stores the outbound system text).
        if (injectTools) {
            toolsOut = injectOpenaiTool(parsed.tools, [...(absorbActive ? [absorbTools.openai] : []), ...(rulesActive ? [RULE_TOOL_OPENAI] : []), ...(ccrEnabled(session) ? [retrieveToolsFor(retrieveToolName(session)).openai] : []), ...(imageRescaleToolArmed(session) ? [READ_ORIGINAL_IMAGE_TOOL_OPENAI] : []), ...(blockOpsActive ? blockOps.openai : [])], surface?.toolPrompts, ccrEnabled(session), externalSummaryEnabled(config));
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
            // Nudge debug record fields (billion-context-pi #326 parity) —
            // computed from the PRE-nudge array so the turnKey is the user
            // message, stable across the turn's re-injections.
            const nudgeMeta = nudgeDebugMeta(turn.nudge, rebuiltMessages);
            if (useDecide && ladderMode(session.metadata) === "fallback") {
                consumeFallback(session.metadata);
                try {
                    const rendered = renderNudgeText(turn.nudge, prompts, surface?.nudgeSections, "openai");
                    const renderedWithPayload = rendered.text;
                    if (rendered.text) {
                        const wireText = withMarkerIntegrityNote(withSummaryBudgetNote(withFirstSightDrain(renderedWithPayload, turn.nudge.reason, externalSummaryEnabled(config)), externalSummaryEnabled(config)), visibilityMarkers);
                        rebuiltMessages = [...rebuiltMessages, { role: "user", content: wireText }];
                        nudgeOutcome = "injected";
                        emitNudgeInjected({ sessionId, protocol: "openai", kind: "fallback", text: wireText, ts: Date.now(), ...nudgeMeta });
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
                        const wireText = withMarkerIntegrityNote(withSummaryBudgetNote(withFirstSightDrain(buildDirectiveText(span.startRef, span.endRef, outcome.topic), turn.nudge.reason, externalSummaryEnabled(config)), externalSummaryEnabled(config)), visibilityMarkers);
                        rebuiltMessages = [...rebuiltMessages, { role: "user", content: wireText }];
                        nudgeOutcome = "injected";
                        emitNudgeInjected({ sessionId, protocol: "openai", kind: "directive", text: wireText, ts: Date.now(), ...nudgeMeta });
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
                        const wireText = withMarkerIntegrityNote(withSummaryBudgetNote(withFirstSightDrain(renderedWithPayload, turn.nudge.reason, externalSummaryEnabled(config)), externalSummaryEnabled(config)), visibilityMarkers);
                        rebuiltMessages = [...rebuiltMessages, { role: "user", content: wireText }];
                        nudgeOutcome = "injected";
                        emitNudgeInjected({ sessionId, protocol: "openai", kind: "advisory", text: wireText, ts: Date.now(), ...nudgeMeta });
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
        // #6181 B1: the R3 identity fault is a HARD reject, not a degrade —
        // rethrow it to the server funnel (400 + x-bili-snapshot:identity)
        // BEFORE the generic 503; zero kernel side effects by construction
        // (it throws before processTurn).
        if (err instanceof FoundationRejectError) throw err;
        // Ruling 7439-5: an unreadable op-log on a pinned session is a hard
        // fail (500 + x-bili-egress: unreadable) — the generic forward
        // below would send the CLIENT'S bytes, which the ruling forbids.
        if (err instanceof EgressAuthorityRejectError) throw err;
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
    // #5403/#5418: on a watermark hit pin only this turn's window — the
    // stashed prefix lives OUTSIDE the Session by design; the fold machinery
    // applies to the pin exactly as it already does for folded sessions.
    // #3397 durability-before-render (see prepare-anthropic.ts): rows durable NOW, before the model call.
    getStore().ingestRowsNow(session);
    // #5874 P2-final: the in-request snapshot flush above already persisted
    // this revision; re-arm the debounce only if the session mutated since
    // (stats probes land at the next flush) or the flush never landed.
    if (!snapFlush || !snapFlush.ok || (session.revisionEpoch ?? 0) !== snapFlush.epoch) markDirty(session);
    let wpResponseHeaders: Record<string, string> | undefined;
    if (wpFullText !== undefined && wpOutcome !== null && wpTurnStrip !== undefined) {
        wpResponseHeaders = finalizeWatermarkTurn(session, wpOutcome, {
            model: wpModel,
            legacyCores: originalMessages,
            rawSystemText: wpHit !== undefined ? wpHit.systemText : wpSeedSystemText,
            turnStripCounts: wpTurnStrip,
        });
        // #7064 §8: the pin-mode signal rides WITH the watermark headers —
        // the client relearns the mode exactly when it relearns T (same
        // chokepoint, one round-trip). "incremental" is gated on the flag
        // (off ⇒ the upgrade never travels); the "full" DOWNGRADE signal
        // travels even when the flag is off — that is the rollback
        // self-heal (#6785 review fix): an already-upgraded client must be
        // told to go back to the full form when the flag is rolled back,
        // or it keeps suppressing the full list while the server pins
        // nothing (silent pin loss until compaction/restart).
        if (s0PinMode === "full" || (featureEnabled("pluginMsgIdIncremental") && s0PinMode !== null)) {
            wpResponseHeaders[MSGID_MODE_HEADER] = s0PinMode;
        }
        if (Object.keys(wpResponseHeaders).length === 0) wpResponseHeaders = undefined;
    }
    if (nudgeOutcome === "injected") recordNudgeInject(session, nudge);
    // #7398 seg 3: record this turn's outbound conversation view as sparse
    // ops (rollout-gated, default off — zero rows, zero cost). Skipped when
    // the serve path already ran or when the authority seam ran but did not
    // swap (ruling 7439-5: never advance the flow with untrusted client
    // bytes); a corrupt log skips this turn and self-heals next.
    // The bootstrap exception (ruling 7439-5 turn 1): an armed turn with an
    // empty flow records the client view ONCE — that is the cold start, not
    // "untrusted bytes advancing the flow" (there is no flow to advance
    // against; from turn 2 the armed gate is fully enforced again).
    if (!isTitleGen && egressPlaneGateOn() && !egressServedFromLog && !(egressArmed && !egressSwapApplied && !egressBootstrap)) {
        try {
            const st = getStore().egressOpLogStore();
            if (st) {
                recordEgressTurn({
                    store: st,
                    sessionId,
                    prev: egressBaseRows ?? undefined,
                    baseSeq: egressBaseSeq,
                    conversation: egressRecordSource ?? (processedMessages.length > 0 ? processedMessages : originalMessages),
                    systemText: openaiOutboundSystem ?? openaiSystemText,
                    nowMs: Date.now(),
                    blockLedger: egressBlockLedgerFor(session),
                    refMap: session.state.messageRefs,
                });
            }
        } catch (err) {
            if (err instanceof EgressConcurrentWriteError) {
                log("warn", `[${sessionId}] egress op-log recording skipped this turn (another request on this session recorded first): ${String(err)}`);
            } else {
                log("warn", `[${sessionId}] egress op-log recording skipped this turn (corrupt log point — self-heals next turn): ${String(err)}`);
            }
        }
    }
    // #7398 seg 4a: SHADOW comparison — rebuild the outbound core portion
    // from the log and byte-compare against the legacy elements. NO
    // swap: the pipeline always sends the legacy bytes; this measures the
    // identity rate the swap will rely on (rollout egressPlane, default 0;
    // reads the hydrated flow view — on a bootstrap turn that is the view
    // the record above just wrote, i.e. an exact self-compare).
    if (!isTitleGen && egressPlaneGateOn() && !egressServedFromLog) {
        try {
            const st = getStore().egressOpLogStore();
            const view = egressBaseRows ?? (st ? st.egressStateView(sessionId) : undefined);
            if (st && view && legacyCoreElements !== undefined) {
                const reb = rebuildOutboundFromLog(view);
                if (reb === null) {
                    log("info", `[${sessionId}] egress-serve shadow: unrebuildable (log gap or out-of-scope row) — legacy kept`);
                } else {
                    const same = JSON.stringify(reb.elements) === JSON.stringify(legacyCoreElements);
                    log("info", `[${sessionId}] egress-serve shadow: ${same ? "IDENTICAL" : "DIVERGENT"} (${view.length} rows)`);
                }
            }
        } catch (err) {
            log("warn", `[${sessionId}] egress-serve shadow comparison failed: ${String(err)}`);
        }
    }
    return { body: JSON.stringify(rebuilt), parsedBody: rebuilt, session, attachedRetrievals, attachedRetrievalNoteIds, processedMessages, originalMessages, judgeBaseline, protocol: "openai", stream, compressInjected: injectTools, pluginMode, mcpDialectNote: laneDecisions.mcpDialect, nudge, nudgeOutcome, nudgeStampsBefore: nudgeOutcome === "injected" ? nudgeStampsBefore : undefined, prompts, surface, openaiSystemText, systemNotes: sysNotes, renderTags: renderStrategy, responseExtraHeaders: wpResponseHeaders, dropReasoning: (msgs: BiliMessage[]) => applyReasoningDrop(msgs, reasoningPlan, log, sessionId) } as Prepared;
}

/** Append the ephemeral nudge to a Gemini `contents` array. Gemini is
 *  strict about role alternation, so a trailing user turn is merged into
 *  rather than appended to (the nudge then reads as the model's last input,
 *  which is where it belongs); a model-final history gets a fresh user turn
 *  because a request must not end on the model side. */
