import { assignRefs, highestUsedIndex, indexToRef } from "./refs.js";
import { remintCoveredLiveIds } from "./instance-reid.js";
import { prune } from "./prune.js";
import { syncBlocks } from "./sync.js";
import { advanceSurvival, activeBlocks, blockById } from "./state.js";
import { allocateBlockId, allocateRunId, createInitialState } from "./state.js";
import { countMessageTokens, defaultCountTokens } from "./tokenize.js";
import { validateConfig } from "./config.js";
import {
  BoundaryNotFoundError,
  resolveBoundaries,
  parseBoundary,
} from "./boundaries.js";
import type { ResolvedRange } from "./boundaries.js";
import { truncateLargeToolOutputs } from "./truncate-tools.js";
import { scrubLoneSurrogates } from "./truncate.js";
import { hideConsumedCompressCalls } from "./hide-consumed.js";
import { appendAbsorbPrompts, hideAbsorbedMessages } from "./absorb.js";
import { applyCrushToMessages } from "./crush.js";
import { applyRetrieve, ccrStoreNode, RETRIEVED_ID_PREFIX } from "./ccr.js";
import type { ApplyRetrieveResult, CcrEffect } from "./ccr.js";
import { createContentStore } from "./content-store.js";
import type { MessageContentStore } from "./content-store.js";
import { applyMessageFilters, listMessageFilters } from "./filter/index.js";
import { activeBlockSpans } from "./block-map.js";
import { createRenderRefsNode } from "./render-refs.js";
import type { RenderStrategy } from "./render-refs.js";
import {
  collectLatestProtected,
  collectProtectedToolCallIds,
  hasUnrecoverableMediaPayload,
  isMessageLatestProtected,
  isMessageProtected,
  isMessageProtectedWithPairing,
} from "./protected.js";
import { isToolMessage } from "./message-kind.js";
import { projectUnit, collectCoverage } from "./unit-projection.js";
import { evaluateRefold, type RefoldDecision } from "./refold.js";
import {
  computeProtectedRefs,
  buildCompressibleRanges,
  mergeRangesToThreshold,
  screenRecommendedUnits,
} from "./recommend.js";
import {
  runPipeline,
  type PipelineContext,
  type PipelineNode,
  type NodeIO,
  type NodeEffects,
} from "./pipeline.js";
import type {
  ApplyCompressionResult,
  CompressionBlock,
  CompressionState,
  CompressionTier,
  CompressRangeSpec,
  Config,
  ContextBreakdown,
  CoreMessage,
  NudgeConfig,
  NudgeDecision,
  PreviewCompressionInput,
  PreviewReport,
  ProcessTurnResult,
  RangePreview,
  Recommendation,
  StatusReport,
} from "./types.js";

export interface Ports {
  countTokens?: (text: string) => number;
}

export interface CompressionCore {
  processTurn(input: ProcessTurnInput): ProcessTurnResult;
  /** Kernel primitive behind acp_retrieve: resolve a ref to its stored
   *  original plus the wire-safe injection pair (see ccr.ts). */
  retrieve(store: MessageContentStore, ref: string): ApplyRetrieveResult;
  applyCompression(input: ApplyCompressionInput): ApplyCompressionResult;
  /** #3185: run each range's full pre-commit pipeline on a throwaway clone
   * and report what a real call would do — without allocating refs, writing
   * blocks or touching the caller's state. Repeated calls are idempotent. */
  previewCompression(input: PreviewCompressionInput): PreviewReport;
  defaultNodes(): PipelineNode[];
  decompress(
    blockId: string,
    state: CompressionState,
  ): CompressionBlock | undefined;
  search(query: string, state: CompressionState): CompressionBlock[];
  status(
    state: CompressionState,
    tokenCount: number,
    config: Config,
  ): StatusReport;
}

export interface ProcessTurnInput {
  messages: CoreMessage[];
  state: CompressionState;
  config: Config;
  tokenCount: number;
  /**
   * Which messages get an <acp> ref tag injected into their text
   * (the render-refs pipeline node). Refs are ALWAYS assigned regardless
   * (assign-refs node runs unconditionally).
   *   - "all" (default): tag every mapped message — in-process hosts
   *     like pai-acp want tags for the LLM to reference compress ranges.
   *   - "text-only": tag only user/assistant text; leave tool-call args
   *     and tool-result content pristine — proxy hosts where structured
   *     content must not be polluted.
   *   - "none": leave all text untouched — hosts that read the ref map
   *     directly from result.state.messageRefs.
   */
  renderTags?: RenderStrategy;
  /** Per-session CCR content store (pass result.contentStore back here).
   *  Omit for pre-CCR sessions — an empty store is used. */
  contentStore?: MessageContentStore;
  /** #3236: the EXACT message array class applyCompression will run on for
   * this lane. Hosts whose render view (`messages`) differs from the fold
   * view (pruned separators, host-side compaction tails) pass the unpruned
   * log here so recommendation screening and unit projection judge ranges on
   * the same class execute will — advertised and applied can't diverge.
   * Omit when `messages` already IS that class. */
  applyView?: CoreMessage[];
}

export interface ApplyCompressionInput {
  ranges: {
    startRef: string;
    endRef: string;
    summary: string;
    topic?: string;
    compressCallId?: string;
    summaryMaxChars?: number;
  }[];
  messages: CoreMessage[];
  state: CompressionState;
  config: Config;
  protectedMessageIds?: Set<string>;
}

/**
 * Per-range classification from a single resolveBoundaries pass. "ok" ranges
 * go on to applySingleRange (which re-resolves internally for tool-pair
 * adjustment); "consumed" means the refs existed but their messages were
 * hidden by an existing block; "unknown" means a ref never existed in this
 * session; "invalid" means a ref failed to parse (e.g. "foo").
 */
type RangeResolution =
  | { status: "ok"; resolved: ResolvedRange }
  | { status: "consumed"; error: BoundaryNotFoundError }
  | { status: "unknown"; error: BoundaryNotFoundError }
  | { status: "invalid"; error: Error };

function rangeError(
  spec: { startRef: string; endRef: string },
  message: string,
): string {
  return `range ${spec.startRef}..${spec.endRef}: ${message}`;
}

function numericBlockId(id: string): number {
  const parsed = /^b(\d+)$/.exec(id);
  return parsed ? Number(parsed[1]) : 0;
}

function refGateDiagnostics(
  state: CompressionState,
  requestedRanges: number,
  unknownCount: number,
): string {
  const highest = highestUsedIndex(state.messageRefs);
  const highestRef = highest > 0 ? indexToRef(highest) : "none";
  return `[diagnostics: session highest ref=${highestRef}, unknown ranges in request=${unknownCount}/${requestedRanges}, session history=${state.stats.compressionCount} compression(s), ${state.blocks.length} block(s)]`;
}

function danglingMessageRefs(
  state: CompressionState,
  messages: CoreMessage[],
  spec: { startRef: string; endRef: string },
): string[] {
  const visible = new Set(messages.map((m) => m.id));
  const dangling: string[] = [];
  for (const ref of [spec.startRef, spec.endRef]) {
    const parsed = parseBoundary(ref);
    if (!parsed || parsed.kind !== "message") continue;
    const rawId =
      state.messageRefs.byRef[parsed.raw] ??
      state.messageRefs.byRef[indexToRef(parsed.numericId)];
    if (!rawId || visible.has(rawId)) continue;
    const covered = state.blocks.some(
      (block) => block.active && block.effectiveMessageIds.includes(rawId),
    );
    if (!covered) dangling.push(parsed.raw);
  }
  return dangling;
}

// Active block(s) whose coverage includes any boundary ref of the spec.
// Unlike danglingMessageRefs (which only tests message refs), block-ref
// boundaries are expanded through their effectiveMessageIds so a stale bN
// ref resolves to the higher-tier block that now owns its content.
function coveringBlockIds(
  state: CompressionState,
  spec: { startRef: string; endRef: string },
): string[] {
  const found = new Set<string>();
  for (const ref of [spec.startRef, spec.endRef]) {
    const parsed = parseBoundary(ref);
    if (!parsed) continue;
    let rawIds: string[] = [];
    if (parsed.kind === "message") {
      const rawId =
        state.messageRefs.byRef[parsed.raw] ??
        state.messageRefs.byRef[indexToRef(parsed.numericId)];
      if (rawId) rawIds = [rawId];
    } else {
      rawIds =
        blockById(state, `b${parsed.numericId}`)?.effectiveMessageIds ?? [];
    }
    if (rawIds.length === 0) continue;
    for (const candidate of activeBlocks(state)) {
      if (rawIds.some((id) => candidate.effectiveMessageIds.includes(id))) {
        found.add(candidate.blockId);
      }
    }
  }
  return [...found].sort((x, y) => numericBlockId(x) - numericBlockId(y));
}

// Block-ID-boundary advice is only actionable when tier distillation is ready;
// emitting it otherwise sends the model to retry bN..bM ranges that cannot
// fire yet (the misleading hint behind ranxianglei/billion-context-pi#470).
function tierActionHint(config: Config, state: CompressionState): string {
  if (!config.tiers.enabled) return "";
  const t2 = activeBlocks(state).filter((b) => b.tier === 2);
  if (t2.length >= config.tiers.tier3Trigger) {
    return ` Tier condensation is actionable now: compress({ content: [{ startId: "${t2[0]!.blockId}", endId: "${t2[t2.length - 1]!.blockId}", summary: "...", topic: "..." }] }) merges those tier-2 blocks into one tier-3 block.`;
  }
  const t1 = activeBlocks(state).filter((b) => b.tier === 1);
  if (t1.length >= config.tiers.tier2Trigger) {
    return ` Tier distillation is actionable now: compress({ content: [{ startId: "${t1[0]!.blockId}", endId: "${t1[t1.length - 1]!.blockId}", summary: "...", topic: "..." }] }) merges those tier-1 blocks into one tier-2 block.`;
  }
  return "";
}


/** In-place refold (#398): same block id/coverage/tier, new summary (+topic),
 * fresh runId, restoredInline flag cleared. Summary passes the same length
 * checks as a fresh compression. */
function applyRefolds(input: {
  spec: ApplyCompressionInput["ranges"][number];
  state: CompressionState;
  runId: string;
  config: Config;
  blockIds: string[];
}): void {
  validateSummaryLength(input.spec, input.config.compress);
  applyRefoldMutations(
    input.state,
    input.spec,
    input.runId,
    input.blockIds,
  );
}

/** State mutation shared by applyRefolds (real commit) and the dry-run
 * preview (#3185), which applies refolds on its throwaway clone for batch
 * fidelity without validating a summary it deliberately does not carry. */
function applyRefoldMutations(
  state: CompressionState,
  spec: { summary: string; topic?: string },
  runId: string,
  blockIds: string[],
): void {
  const targets = new Set(blockIds);
  state.blocks = state.blocks.map((block) =>
    targets.has(block.blockId)
      ? {
          ...block,
          summary: spec.summary,
          topic: spec.topic ?? block.topic,
          runId,
          restoredInline: false,
        }
      : block,
  );
}

/** Shared "already compressed / DEAD refs" skip warning (real path and
 * dry-run preview must render identical text). */
function consumedRangeWarning(
  spec: { startRef: string; endRef: string },
  decision: RefoldDecision | undefined,
  dangling: string[] | undefined,
): string {
  const reasons = decision?.kind === "blocked" ? decision.reasons : [];
  return dangling && dangling.length > 0
    ? `Skipped range (${spec.startRef}..${spec.endRef}) — its refs ${dangling.join(", ")} are DEAD (the client rewrote or dropped those messages); this range can never compress, do not retry it.`
    : `Skipped range (${spec.startRef}..${spec.endRef}) — already compressed${reasons.length > 0 ? `: ${reasons.join("; ")}` : " (messages consumed by existing block(s))"}; nothing to compress.`;
}

function rawToRefs(rawIds: string[], state: CompressionState): string[] {
  return rawIds.map((id) => state.messageRefs.byRaw[id] ?? id);
}

interface BatchPrep {
  /** Working clone. Identical to input.state unless the gate rejected — then
   * it differs only in dead-ref tombstones (#2362), matching the historical
   * return shapes of applyCompression. */
  state: CompressionState;
  protectedMessageIds: Set<string>;
  preExistingCoverage: Set<string>;
  classifications: Map<CompressRangeSpec, RangeResolution>;
  classificationErrors: string[];
  consumedRanges: CompressRangeSpec[];
  danglingBySpec: Map<CompressRangeSpec, string[]>;
  resolvableCount: number;
  unknownCount: number;
  refoldDecisions: Map<CompressRangeSpec, RefoldDecision>;
  allRefold: boolean;
  skipSpecs: Set<CompressRangeSpec>;
  /** Overlap-skip warnings in generation (sorted-range) order. */
  skipWarnings: { spec: CompressRangeSpec; text: string }[];
  gate: { kind: "pass" } | { kind: "reject"; message: string | null };
}

/** Everything applyCompression does BEFORE its per-range loop: clone, scrub,
 * classification, dead-ref tombstones, refold decisions, overlap detection
 * and the minCompressRange gate. Extracted so the dry-run preview (#3185)
 * reuses the exact same pre-commit computations instead of a drifting copy.
 * Mutates only the clone and the caller's range specs' summaries (scrub),
 * never the caller's state. */
function prepareBatch(
  input: ApplyCompressionInput,
  countTokens: (text: string) => number,
): BatchPrep {
  const state: CompressionState = cloneState(input.state);
  // #816 family: a model-authored summary can carry an unpaired surrogate
  // half — e.g. the model copies a literal \uXXXX escape out of tool output
  // into the tool-call argument, and JSON.parse of that argument yields a
  // real lone code unit. Stored verbatim, it poisons every later request
  // body that re-serializes the state (strict upstreams reject the whole
  // body, non-retryable). Scrub at ingest so state never carries one. The
  // wire layer (loop fetchUpstream / relay forward) scrubs again as the
  // belt-and-braces for already-poisoned persisted state.
  for (const spec of input.ranges) {
    if (spec.summary) spec.summary = scrubLoneSurrogates(spec.summary);
  }

  // Default to the soft-protected zone (recent-N + last user message) when the
  // caller doesn't pass an explicit set. This makes applyCompression safe by
  // default; applySingleRange enforces it as a hard backstop.
  const protectedMessageIds =
    input.protectedMessageIds ??
    computeProtectedRefs(input.messages, input.state, input.config, countTokens);

  const preExistingCoverage = collectCoverage(state);

  // Classify every requested range ONCE. The result feeds overlap
  // skipSpecs, the minCompressRange pre-check, and the per-range loop —
  // previously each re-resolved and silently swallowed failures, so
  // consumed/unknown ranges produced misleading "too small" errors.
  const classifications = new Map<CompressRangeSpec, RangeResolution>();
  const classificationErrors: string[] = [];
  const consumedRanges: CompressRangeSpec[] = [];
  for (const spec of input.ranges) {
    try {
      const resolved = resolveBoundaries({
        startRef: spec.startRef,
        endRef: spec.endRef,
        messages: input.messages,
        state,
      });
      classifications.set(spec, { status: "ok", resolved });
    } catch (error) {
      if (error instanceof BoundaryNotFoundError) {
        classifications.set(
          spec,
          error.kind === "unknown"
            ? { status: "unknown", error }
            : { status: "consumed", error },
        );
        if (error.kind === "consumed") {
          consumedRanges.push(spec);
        } else {
          classificationErrors.push(rangeError(spec, error.message));
        }
      } else {
        classifications.set(spec, {
          status: "invalid",
          error: error instanceof Error ? error : new Error(String(error)),
        });
        classificationErrors.push(
          rangeError(spec, error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  // #2362: dead-ref tracking. A requested endpoint whose ref is known to
  // this session but backs no visible or folded message is unreachable —
  // the client rewrote or dropped that message. Record it so every later
  // receipt and acp_status says DEAD instead of inviting another doomed
  // retry (the self-amplifying failure loop). Tombstone-with-clear: refs
  // are never removed from byRef (Kernel Contract), and a tombstone lifts
  // once its message reappears in the view.
  const visibleIdsForDead = new Set(input.messages.map((m) => m.id));
  let deadRefs: string[] = (state.deadRefs ?? []).filter((ref) => {
    const rawId = state.messageRefs.byRef[ref];
    return !(rawId !== undefined && visibleIdsForDead.has(rawId));
  });
  const danglingBySpec = new Map<CompressRangeSpec, string[]>();
  for (const spec of input.ranges) {
    const resolution = classifications.get(spec);
    if (resolution === undefined || resolution.status !== "consumed") continue;
    const dangling = danglingMessageRefs(state, input.messages, spec);
    if (dangling.length === 0) continue;
    danglingBySpec.set(spec, dangling);
    for (const ref of dangling) {
      if (!deadRefs.includes(ref)) deadRefs.push(ref);
    }
  }
  if (deadRefs.length > 0) {
    state.deadRefs = [...new Set(deadRefs)].sort(
      (a, b) => Number(a.replace(/^m/, "")) - Number(b.replace(/^m/, "")),
    );
  } else {
    state.deadRefs = undefined;
  }

  let resolvableCount = 0;
  let unknownCount = 0;
  for (const resolution of classifications.values()) {
    if (resolution.status === "ok") resolvableCount++;
    else if (resolution.status === "unknown") unknownCount++;
  }

  // Refold-in-place (#398/#400): classify ranges against the restored-inline
  // rule BEFORE the size gate so a pure refold never trips minCompressRange
  // (it re-summarizes an already-folded block, no fresh messages involved).
  // #400: full-log hosts (Pi) keep inline-restored originals in the view, so
  // the same request RESOLVES (status ok, every id already covered) instead
  // of classifying as consumed — a resolving range whose whole span is
  // covered is a refold candidate too, otherwise the gate rejects the batch
  // before the per-range loop can reach the refold path.
  const refoldDecisions = new Map<CompressRangeSpec, RefoldDecision>();
  const isRefoldCandidate = (resolution: RangeResolution): boolean =>
    resolution.status === "consumed" ||
    (resolution.status === "ok" &&
      resolution.resolved.boundaryKind !== "block" &&
      resolution.resolved.messageIds.every((id) => preExistingCoverage.has(id)));
  for (const [spec, resolution] of classifications) {
    if (isRefoldCandidate(resolution)) {
      refoldDecisions.set(spec, evaluateRefold(state, spec));
    }
  }
  const allRefold =
    input.ranges.length > 0 &&
    unknownCount === 0 &&
    [...classifications.entries()].every(
      ([spec, resolution]) =>
        isRefoldCandidate(resolution) &&
        refoldDecisions.get(spec)?.kind === "refold",
    );

  // Overlap detection uses resolved boundary indices, not messageIds: a
  // summary-only range (block refs over a pruned view) has empty
  // messageIds after synthetic-id filtering but still occupies its
  // [startIndex, endIndex] span.
  const rangeSpans: {
    spec: CompressRangeSpec;
    start: number;
    end: number;
  }[] = [];
  for (const [spec, resolution] of classifications) {
    if (resolution.status !== "ok") continue;
    rangeSpans.push({
      spec,
      start: resolution.resolved.startIndex,
      end: resolution.resolved.endIndex,
    });
  }
  const sortedRanges = [...rangeSpans].sort((a, b) => a.start - b.start);
  // Overlapping ranges warn+skip (earliest wins) rather than aborting the
  // whole batch — see ISSUE-42 / dog/billion-context-pi#21.
  const skipSpecs = new Set<CompressRangeSpec>();
  const skipWarnings: { spec: CompressRangeSpec; text: string }[] = [];
  let acceptedMaxIndex = -1;
  for (const entry of sortedRanges) {
    if (entry.start <= acceptedMaxIndex) {
      skipSpecs.add(entry.spec);
      skipWarnings.push({
        spec: entry.spec,
        text: `Skipped range (${entry.spec.startRef}..${entry.spec.endRef}) — overlaps an earlier range in the batch; the earlier range takes precedence. Keep ranges disjoint.`,
      });
      continue;
    }
    if (entry.end > acceptedMaxIndex) acceptedMaxIndex = entry.end;
  }

  let gate: BatchPrep["gate"] = { kind: "pass" };
  if (input.config.compress.minCompressRange > 0 && input.ranges.length > 0) {
    let totalRangeChars = 0;
    let hasBlockBoundaryRange = false;
    let countedRanges = 0;
    for (const [spec, resolution] of classifications) {
      if (resolution.status !== "ok" || skipSpecs.has(spec)) continue;
      if (resolution.resolved.boundaryKind === "block") {
        hasBlockBoundaryRange = true;
        continue;
      }
      countedRanges++;
      for (const id of resolution.resolved.messageIds) {
        const msg = input.messages.find((m) => m.id === id);
        totalRangeChars += msg?.text?.length ?? 0;
      }
    }
    if (
      !allRefold &&
      !hasBlockBoundaryRange &&
      totalRangeChars < input.config.compress.minCompressRange
    ) {
      const diagnostics = refGateDiagnostics(state, input.ranges.length, unknownCount);
      const firstConsumed = consumedRanges[0];
      const covering = firstConsumed ? coveringBlockIds(state, firstConsumed) : [];
      const coverDetail =
        covering.length > 0
          ? `its content is already summarized in active block(s) ${covering.join(", ")}${covering.length === 1 ? ` — use search_context or decompress ${covering[0]} if you need details from it` : ""}`
          : `its refs no longer point to directly compressible content (stale block ref(s) distilled or consumed by higher-tier blocks)`;
      // All consumed ranges contribute blockers (deduped), not just the first:
      // a later blocked range must still be named when the batch is rejected.
      const refoldReasons = [
        ...new Set(
          consumedRanges.flatMap((spec) => {
            const decision = refoldDecisions.get(spec);
            return decision?.kind === "blocked" ? decision.reasons : [];
          }),
        ),
      ];
      const refoldSuffix = (reasons: string[]) =>
        reasons.length > 0
          ? ` Refold blocked: ${reasons.join("; ")}. Restore the affected block(s) inline (decompress with inline:true), then recompressing the same range updates them in place`
          : "";
      const refoldDetail = refoldSuffix(refoldReasons);
      // #402: under full-log hosts a covered span RESOLVES (status ok)
      // instead of classifying as consumed, so its blockers never reach
      // refoldReasons above — without them the bare "too small" hint below
      // hides the real fix (restore the covering block inline).
      const okBlockedReasons = [
        ...new Set(
          [...classifications.entries()].flatMap(([spec, resolution]) => {
            if (skipSpecs.has(spec) || resolution.status !== "ok") return [];
            const decision = refoldDecisions.get(spec);
            return decision?.kind === "blocked" ? decision.reasons : [];
          }),
        ),
      ];
      const danglingRefs = consumedRanges.flatMap(
        (spec) => danglingBySpec.get(spec) ?? [],
      );
      let gateMessage =
        resolvableCount === 0 &&
        consumedRanges.length === 0 &&
        unknownCount > 0
          ? `None of the ${input.ranges.length} requested range(s) resolved — every ref is unknown to this session. Refs are per-session snapshots, assigned once when a message is first rendered; no compress reassigns them, so unknown refs cannot come from an earlier compress in this session. They come from a different generation: a previous session instance (switching model or upstream mid-conversation starts a fresh session whose refs restart at m00001), the generation before a native-compaction rebase (which also resets refs to m00001), or a typo. ${diagnostics} Run acp_status, then call the compress tool again using only the refs it reports.`
          : consumedRanges.length > 0
            ? danglingRefs.length > 0
              ? `Requested range(s) cannot be anchored (e.g. ${firstConsumed!.startRef}..${firstConsumed!.endRef}): refs ${danglingRefs.join(", ")} are known to this session but no longer back any visible or folded message — the client rewrote or dropped those messages (an edit reissues a new ref; host-native compaction or a bulk history rewrite drops them outright), and no active block covers them. These refs are now recorded as DEAD: no range that includes them can compress now or later, whatever the neighbors. Do not retry this range in any form — run acp_status and target only the live refs it reports. ${diagnostics}`
              : `Requested range(s) already compressed (e.g. ${firstConsumed!.startRef}..${firstConsumed!.endRef}) — ${coverDetail}${refoldDetail}. Nothing new to compress in that window. ${diagnostics} Continue the task, or run acp_status and target one of the CURRENT compressible ranges it reports.${tierActionHint(input.config, state)}`
            : countedRanges > 0
              ? `Total compressible content too small (${totalRangeChars} chars across ${countedRanges} range(s), min ${input.config.compress.minCompressRange}). Combine more messages into your range(s) to meet the threshold.${refoldSuffix(okBlockedReasons)}`
              : null;
      if (gateMessage !== null) {
        const reversalNotes: string[] = [];
        for (const [spec, resolution] of classifications) {
          if (resolution.status === "ok" && !skipSpecs.has(spec)) {
            const note = resolution.resolved.reversedNote;
            if (note) reversalNotes.push(note);
          }
        }
        if (reversalNotes.length > 0) {
          gateMessage += ` ${reversalNotes.join(" ")}`;
        }
      }
      gate = { kind: "reject", message: gateMessage };
    }
  }

  return {
    state,
    protectedMessageIds,
    preExistingCoverage,
    classifications,
    classificationErrors,
    consumedRanges,
    danglingBySpec,
    resolvableCount,
    unknownCount,
    refoldDecisions,
    allRefold,
    skipSpecs,
    skipWarnings,
    gate,
  };
}

export function createCore(ports: Ports = {}): CompressionCore {
  const countTokens = ports.countTokens ?? defaultCountTokens;

  function applyCompression(
    input: ApplyCompressionInput,
  ): ApplyCompressionResult {
    const prep = prepareBatch(input, countTokens);
    // Lazy run-id allocation (#2370): never advance nextRunId on a no-op
    // failure — the host forkSnapshot fingerprint hashes full state, so a bump
    // here would churn contextGeneration on every failed manual tool.
    let allocatedRunId: string | null = null;
    let blocksCreated = 0;
    let tokensCompressed = 0;
    const errors: string[] = [];
    const warnings: string[] = [];
    const notes: string[] = [];

    if (prep.gate.kind === "reject") {
      if (prep.gate.message === null) {
        // No range was counted (every spec failed classification, e.g.
        // unparseable refs). The per-range errors name the real cause; a
        // "too small" verdict here would mislead the model into combining
        // more messages instead of fixing its refs (#310).
        return {
          state: input.state,
          result: {
            blocksCreated: 0,
            tokensCompressed: 0,
            errors: [...prep.classificationErrors],
            warnings: [],
          },
        };
      }
      // Rejected batches still carry their side effect: the dead-ref
      // tombstones marked in prepareBatch (#2362). The clone differs from
      // input.state ONLY in that field before the gate, so returning it is
      // safe.
      return {
        state: prep.state,
        result: {
          blocksCreated: 0,
          tokensCompressed: 0,
          errors: [prep.gate.message, ...prep.classificationErrors],
          warnings: [],
        },
      };
    }

    const state = prep.state;
    const runIdOf = (): string => (allocatedRunId ??= allocateRunId(state));
    for (const entry of prep.skipWarnings) warnings.push(entry.text);

    for (const spec of input.ranges) {
      if (prep.skipSpecs.has(spec)) continue;
      const resolution = prep.classifications.get(spec);
      if (resolution === undefined) continue;
      if (resolution.status === "consumed") {
        const decision = prep.refoldDecisions.get(spec);
        if (decision?.kind === "refold") {
          try {
            applyRefolds({
              spec,
              state,
              runId: runIdOf(),
              config: input.config,
              blockIds: decision.blocks.map((block) => block.blockId),
            });
            blocksCreated += decision.blocks.length;
          } catch (error) {
            errors.push(
              rangeError(
                spec,
                error instanceof Error ? error.message : String(error),
              ),
            );
          }
          continue;
        }
        warnings.push(
          consumedRangeWarning(spec, decision, prep.danglingBySpec.get(spec)),
        );
        continue;
      }
      if (resolution.status === "unknown" || resolution.status === "invalid") {
        errors.push(rangeError(spec, resolution.error.message));
        continue;
      }
      warnings.push(...resolution.resolved.snappedBoundaries);
      const note = resolution.resolved.reversedNote;
      if (note) notes.push(note);
      try {
        const outcome = applySingleRange({
          spec,
          messages: input.messages,
          state,
          runId: runIdOf(),
          config: input.config,
          protectedMessageIds: prep.protectedMessageIds,
          countTokens,
          preExistingCoverage: prep.preExistingCoverage,
        });
        blocksCreated += outcome.refolded ? outcome.refolded.length : 1;
        tokensCompressed += outcome.tokens;
        warnings.push(...outcome.warnings);
      } catch (error) {
        errors.push(
          rangeError(
            spec,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }

    state.stats.compressionCount += blocksCreated;
    state.stats.tokensCompressed += tokensCompressed;

    if (blocksCreated > 0) {
      // Compress succeeded: clear the growth baseline so the next turn
      // re-establishes it at the new (lower) token count. Without this the
      // nudge re-fires in a feedback loop (the §5.7 baseline-reset bug).
      state.nudge.lastPerMessageNudgeTokens = 0;
      state.nudge.lastNudgeShownTokens = 0;
      // Clearing the per-tier cadence too: after a successful compression
      // (which may have consumed blocks of tier N to produce tier N+1), every
      // tier should be eligible to re-evaluate from the new token count.
      state.nudge.lastShownByTier = {};
      // A successful compression is by definition viable progress — restart
      // the terminal-floor streak so the escape signal can only fire again
      // after N fresh stuck events (#300).
      state.terminalStreak = 0;
    }

    return {
      state,
      result: {
        blocksCreated,
        tokensCompressed,
        errors,
        warnings,
        ...(notes.length > 0 ? { notes } : {}),
      },
    };
  }

  // #3185: dry-run preview. Runs each range's exact pre-commit pipeline on a
  // throwaway clone and reports what a real call would do. Zero side effects
  // on the caller's state: nothing is committed, no ref allocated, no ledger
  // entry, no dirty mark — the clone (including the sequential refold
  // mutations needed for batch fidelity) is discarded, so repeated previews
  // of the same input return identical reports.
  function previewCompression(
    input: PreviewCompressionInput,
  ): PreviewReport {
    const ranges: CompressRangeSpec[] = input.ranges.map((range) => ({
      startRef: range.startRef,
      endRef: range.endRef,
      summary: "",
      topic: range.topic,
      compressCallId: range.compressCallId,
      summaryMaxChars: range.summaryMaxChars,
    }));
    const prep = prepareBatch(
      {
        ranges,
        messages: input.messages,
        state: input.state,
        config: input.config,
        protectedMessageIds: input.protectedMessageIds,
      },
      countTokens,
    );

    const reports: RangePreview[] = [];
    if (prep.gate.kind === "reject") {
      for (const spec of ranges) {
        const resolution = prep.classifications.get(spec);
        if (resolution === undefined) continue;
        if (resolution.status === "ok") {
          reports.push({
            startRef: spec.startRef,
            endRef: spec.endRef,
            error: null,
          });
          continue;
        }
        if (resolution.status === "consumed") {
          reports.push({
            startRef: spec.startRef,
            endRef: spec.endRef,
            error: null,
            alreadyCovered: true,
            warnings: [
              consumedRangeWarning(
                spec,
                prep.refoldDecisions.get(spec),
                prep.danglingBySpec.get(spec),
              ),
            ],
          });
          continue;
        }
        reports.push({
          startRef: spec.startRef,
          endRef: spec.endRef,
          error: rangeError(spec, resolution.error.message),
        });
      }
      return { batchError: prep.gate.message, ranges: reports };
    }

    const state = prep.state;
    let allocatedRunId: string | null = null;
    const runIdOf = (): string => (allocatedRunId ??= allocateRunId(state));

    for (const spec of ranges) {
      if (prep.skipSpecs.has(spec)) {
        const text = prep.skipWarnings.find((entry) => entry.spec === spec)
          ?.text;
        reports.push({
          startRef: spec.startRef,
          endRef: spec.endRef,
          error: null,
          skippedOverlap: true,
          ...(text ? { warnings: [text] } : {}),
        });
        continue;
      }
      const resolution = prep.classifications.get(spec);
      if (resolution === undefined) continue;
      if (resolution.status === "consumed") {
        const decision = prep.refoldDecisions.get(spec);
        if (decision?.kind === "refold") {
          applyRefoldMutations(
            state,
            spec,
            runIdOf(),
            decision.blocks.map((block) => block.blockId),
          );
          reports.push({
            startRef: spec.startRef,
            endRef: spec.endRef,
            error: null,
            wouldRefold: decision.blocks.map((block) => block.blockId),
          });
          continue;
        }
        reports.push({
          startRef: spec.startRef,
          endRef: spec.endRef,
          error: null,
          alreadyCovered: true,
          warnings: [
            consumedRangeWarning(
              spec,
              decision,
              prep.danglingBySpec.get(spec),
            ),
          ],
        });
        continue;
      }
      if (resolution.status === "unknown" || resolution.status === "invalid") {
        reports.push({
          startRef: spec.startRef,
          endRef: spec.endRef,
          error: rangeError(spec, resolution.error.message),
        });
        continue;
      }
      const warnings: string[] = [...resolution.resolved.snappedBoundaries];
      if (resolution.resolved.reversedNote)
        warnings.push(resolution.resolved.reversedNote);
      try {
        const plan = planSingleRange({
          spec,
          messages: input.messages,
          state,
          config: input.config,
          protectedMessageIds: prep.protectedMessageIds,
          countTokens,
          preExistingCoverage: prep.preExistingCoverage,
          skipSummaryValidation: true,
        });
        warnings.push(...plan.warnings);
        if (plan.kind === "refold") {
          applyRefoldMutations(
            state,
            spec,
            runIdOf(),
            plan.blocks.map((block) => block.blockId),
          );
          reports.push({
            startRef: spec.startRef,
            endRef: spec.endRef,
            error: null,
            wouldRefold: plan.blocks.map((block) => block.blockId),
            ...(warnings.length > 0 ? { warnings } : {}),
          });
          continue;
        }
        commitFoldedRange(state, spec, plan, runIdOf());
        const excluded: NonNullable<RangePreview["excluded"]> = {};
        if (plan.excludedProtectedTools.length > 0) {
          excluded.protectedTools = rawToRefs(plan.excludedProtectedTools, state);
        }
        if (plan.excludedRecentZone.length > 0) {
          excluded.recentZone = rawToRefs(plan.excludedRecentZone, state);
        }
        if (plan.excludedCarriers.length > 0) {
          excluded.checkpointCarriers = rawToRefs(plan.excludedCarriers, state);
        }
        if (plan.excludedMedia.length > 0) {
          excluded.media = rawToRefs(plan.excludedMedia, state);
        }
        reports.push({
          startRef: spec.startRef,
          endRef: spec.endRef,
          error: null,
          wouldFold: rawToRefs(plan.filteredIds, state),
          ...(Object.keys(excluded).length > 0 ? { excluded } : {}),
          ...(plan.withdrawnIds.length > 0 ||
          plan.splitTurnCount > 0 ||
          plan.splitPairCount > 0
            ? {
                withdrawn: {
                  refs: rawToRefs(plan.withdrawnIds, state),
                  splitTurns: plan.splitTurnCount,
                  splitPairs: plan.splitPairCount,
                },
              }
            : {}),
          ...(plan.consumedBlockIds.length > 0
            ? { consumedBlocks: [...plan.consumedBlockIds] }
            : {}),
          estimatedTokensSaved: plan.compressedTokens,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (error) {
        reports.push({
          startRef: spec.startRef,
          endRef: spec.endRef,
          error: rangeError(
            spec,
            error instanceof Error ? error.message : String(error),
          ),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      }
    }

    return { batchError: null, ranges: reports };
  }

  function processTurn(input: ProcessTurnInput): ProcessTurnResult {
    const configErrors = validateConfig(input.config);
    if (configErrors.length > 0) {
      console.warn(
        `[acp-kernel] Config validation warnings: ${configErrors.join("; ")}. Thresholds may not fire correctly.`,
      );
    }
    const contentStore = input.contentStore ?? createContentStore();
    const ctx: PipelineContext = {
      config: input.config,
      tokenCount: input.tokenCount,
      countTokens,
      contentStore,
    };
    const initial: NodeIO = {
      messages: input.messages,
      state: input.state,
      effects: { applyView: input.applyView },
    };
    // Conversion (assign-refs) and rendering (render-refs) are separate
    // concerns. Refs are always assigned; renderTags only controls which
    // message texts receive an <acp> tag.
    const strategy: RenderStrategy = input.renderTags ?? "all";
    const nodes = buildNodes(strategy);
    // #462: snapshot the raw inbound ids BEFORE any node runs — reconcile-
    // live-ids consumes the PREVIOUS pass's snapshot (echo continuity), and the
    // returned state carries THIS pass's snapshot for the next one.
    const inboundIds = input.messages.map((m) => m.id);
    const result = runPipeline(nodes, initial, ctx);
    // #2362: lift dead-ref tombstones whose messages came back into the resent
    // view (tombstone-with-clear — types.CompressionState.deadRefs).
    let deadRefs = result.state.deadRefs;
    if (deadRefs && deadRefs.length > 0) {
      const inboundSet = new Set(inboundIds);
      const kept = deadRefs.filter((ref) => {
        const rawId = result.state.messageRefs.byRef[ref];
        return !(rawId !== undefined && inboundSet.has(rawId));
      });
      deadRefs = kept.length > 0 ? kept : undefined;
    }
    const state = { ...result.state, lastPassIds: inboundIds, deadRefs };
    const ccrEffect = result.effects.ccr as CcrEffect | undefined;
    return {
      messages: result.messages,
      state,
      nudge: result.effects.nudge,
      terminalEscape: result.effects.terminalEscape,
      truncationSkipped: result.effects.truncationSkipped,
      contentStore: ccrEffect?.store ?? contentStore,
    };
  }

  function retrieve(
    store: MessageContentStore,
    ref: string,
    opts?: { exportDir?: string; inlineTokenLimit?: number },
  ): ApplyRetrieveResult {
    return applyRetrieve({ store, ref, ...opts });
  }

  function decompress(blockId: string, state: CompressionState) {
    return blockById(state, blockId);
  }

  function search(query: string, state: CompressionState): CompressionBlock[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);
    if (terms.length === 0) return [];
    const scored = activeBlocks(state)
      .map((block) => ({ block, score: scoreRelevance(block, terms) }))
      // No relevance floor: precision comes from ranking + the caller's limit.
      // A floor >= 0.04 would silently drop the scorer's minimum positive
      // signal (one summary occurrence) — #2158.
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
    return scored.map((entry) => entry.block);
  }

  function status(
    state: CompressionState,
    tokenCount: number,
    config: Config,
  ): StatusReport {
    const active = activeBlocks(state);
    const usage =
      config.modelContextLimit > 0 ? tokenCount / config.modelContextLimit : 0;
    return {
      contextUsage: usage,
      tokenCount,
      modelContextLimit: config.modelContextLimit,
      activeBlocks: active.length,
      totalBlocks: state.blocks.length,
      tokensCompressed: state.stats.tokensCompressed,
      breakdown: {
        active: active.length,
        total: state.blocks.length,
        storedMessages: state.stats.storedCount ?? 0,
        retrievals: state.stats.retrievalCount ?? 0,
      },
    };
  }

  function defaultNodes(): PipelineNode[] {
    return buildNodes("all");
  }

  /** Build the pipeline node list for a given render strategy. "none" omits
   *  the render-refs node entirely; "all"/"text-only" append a render-refs
   *  node bound to that strategy. */
  function buildNodes(strategy: RenderStrategy): PipelineNode[] {
    const base: PipelineNode[] = [
      reconcileLiveIdsNode,
      assignRefsNode,
      syncBlocksNode,
      pruneNode,
      ccrStoreNode,
      absorbHideNode,
      crushNode,
      absorbPromptNode,
      filterNode,
      hideCompressCallsNode,
      recommendNode,
      nudgeNode,
      emergencyTruncateNode,
    ];
    if (strategy === "none") return base;
    return [...base, createRenderRefsNode(strategy)];
  }

  return {
    processTurn,
    retrieve,
    applyCompression,
    previewCompression,
    defaultNodes,
    decompress,
    search,
    status,
  };
}

// --- Pipeline nodes -------------------------------------------------------
// Each node owns ONE concern. The ref map has a SINGLE writer (assignRefsNode);
// tags are DERIVED at the end (renderRefsNode) — no dual source of truth, so
// the old stripHallucinations band-aid is gone. Truncation is the LAST
// token-reducing safety valve; render-refs is the final annotation pass.

const reconcileLiveIdsNode: PipelineNode = {
  name: "reconcile-live-ids",
  run(io) {
    return { ...io, messages: remintCoveredLiveIds(io.messages, io.state) };
  },
};

const assignRefsNode: PipelineNode = {
  name: "assign-refs",
  run(io, ctx) {
    const hasProtection =
      ctx.config.protectedTools.length > 0 ||
      !!ctx.config.isToolProtected ||
      !!ctx.config.isMessageProtected ||
      (ctx.config.protectedLatestTools?.length ?? 0) > 0;
    const latest = hasProtection
      ? collectLatestProtected(io.messages, ctx.config)
      : undefined;
    // Refs keep the exact pre-#1947 layout for name-only patterns (a
    // protected call's unnamed result keeps a foldable ref; actual folding
    // paths pair via filterProtectedToolMessages). #1947 path patterns
    // ("skill/<name>") carry the skill identity in the CALL's input only, so
    // with any "/" pattern the refs pair as well — no pre-#1947 config can
    // contain "/", so the legacy layout stays byte-for-byte unchanged.
    const hasPathPatterns = (ctx.config.protectedTools ?? []).some((p) =>
      p.includes("/"),
    );
    const pathProtectedCallIds =
      hasProtection && hasPathPatterns
        ? collectProtectedToolCallIds(io.messages, ctx.config)
        : undefined;
    // Unrecoverable media (remote URLs / file refs with no stored bytes) ride
    // outside msg.text; folding one destroys it permanently with no restore
    // behind it (#1188/#2609), so those messages get a BLOCKED ref — never
    // advertised, never folded. Archivable inline images fold like text and
    // stay citable by their numeric ref for decompress({ imageRef }) (#2607).
    const protectedFn = (m: CoreMessage) =>
      hasUnrecoverableMediaPayload(m) ||
      (hasProtection
        ? (pathProtectedCallIds
            ? isMessageProtectedWithPairing(m, ctx.config, pathProtectedCallIds)
            : isMessageProtected(m, ctx.config)) ||
          (latest ? isMessageLatestProtected(m, latest) : false)
        : false);
    const refResult = assignRefs(io.messages, {
      existing: io.state.messageRefs,
      nextIndex: highestUsedIndex(io.state.messageRefs) + 1,
      isProtected: protectedFn,
      // Ephemeral retrieval injections never consume a ref slot.
      shouldSkip: (m) => m.id.startsWith(RETRIEVED_ID_PREFIX),
    });
    return { ...io, state: { ...io.state, messageRefs: refResult.map } };
  },
};

const syncBlocksNode: PipelineNode = {
  name: "sync-blocks",
  run(io, ctx) {
    const synced = syncBlocks(io.messages, io.state);
    advanceSurvival(synced.state, ctx.config.promotionThreshold);
    return { ...io, state: synced.state };
  },
};

const pruneNode: PipelineNode = {
  name: "prune",
  run(io, ctx) {
    return {
      ...io,
      messages: prune(io.messages, io.state, {
        isCompressTool: ctx.config.isCompressTool,
      }),
      // #2663: keep the pre-prune resent array reachable so recommend can
      // judge foldability on the same input class applyCompression sees.
      effects: { ...io.effects, originalMessages: io.messages },
    };
  },
};

const absorbHideNode: PipelineNode = {
  name: "absorb-hide",
  enabled: (io) => (io.state.absorbed?.length ?? 0) > 0,
  run(io) {
    return { ...io, messages: hideAbsorbedMessages(io.messages, io.state) };
  },
};

const absorbPromptNode: PipelineNode = {
  name: "absorb-prompt",
  enabled: (_io, ctx) => ctx.config.absorb?.enabled === true,
  run(io, ctx) {
    const applied = appendAbsorbPrompts(
      io.messages,
      io.state,
      ctx.config,
      ctx.tokenCount,
      ctx.countTokens,
    );
    return {
      ...io,
      messages: applied.messages,
      effects: { ...io.effects, absorbPromptedCount: applied.promptedCount },
    };
  },
};

// Tier 1 of the two-tier absorb gate: deterministic compression of eligible
// oversized tool results. Runs after absorb-hide (already-absorbed pairs are
// gone) and before absorb-prompt, which then re-decides on post-crush sizes —
// results crushed below minToolTokens stop triggering model round-trips.
const crushNode: PipelineNode = {
  name: "crush",
  enabled: (_io, ctx) =>
    ctx.config.crush?.enabled === true && ctx.config.absorb?.enabled === true,
  run(io, ctx) {
    const applied = applyCrushToMessages(
      io.messages,
      ctx.config,
      ctx.tokenCount,
      ctx.countTokens,
    );
    return {
      ...io,
      messages: applied.messages,
      effects: {
        ...io.effects,
        crushCount: applied.crushedCount,
        crushDistilledCount: applied.distilledCount,
      },
    };
  },
};

const filterNode: PipelineNode = {
  name: "filter",
  enabled: (_io, ctx) =>
    !!ctx.config.messageFilters?.enabled && listMessageFilters().length > 0,
  run(io, ctx) {
    const applied = applyMessageFilters(io.messages, ctx.config.messageFilters);
    return { ...io, messages: applied.messages };
  },
};

const hideCompressCallsNode: PipelineNode = {
  name: "hide-compress-calls",
  run(io, ctx) {
    const hidden = hideConsumedCompressCalls(
      io.state,
      io.messages,
      ctx.config.isCompressTool,
    );
    return {
      ...io,
      messages: hidden.messages,
      state: { ...io.state, hiddenOrphanRefs: hidden.hiddenOrphanRefs },
    };
  },
};

const recommendNode: PipelineNode = {
  name: "recommend",
  run(io, ctx) {
    const protectedRefs = computeProtectedRefs(
      io.messages,
      io.state,
      ctx.config,
      ctx.countTokens,
    );
    // #3236: screening must judge on the exact array class applyCompression
    // runs on — the host's applyView when provided, else the pre-prune
    // original (#2663 integritySource), else the view itself.
    const screenArray =
      io.effects.applyView ?? io.effects.originalMessages ?? io.messages;
    const contextRanges = buildCompressibleRanges(
      io.messages,
      io.state,
      ctx.config,
      protectedRefs,
      ctx.countTokens,
      screenArray,
    );
    const nothingToCompress = contextRanges.compressible.length === 0;
    // #3236: re-screen each merged unit through the SAME judgment
    // applySingleRange executes (unit-projection.ts). A unit that would be
    // rejected wholesale (zone-only span, turn/pair split, nothing new to
    // fold) is demoted to a gap instead of advertised — global screening
    // alone passed turns whose partners sit in another advertised unit, so
    // every submission of such a range threw (permanent advertise/reject
    // loop in production).
    const recommendedRanges = screenRecommendedUnits(
      mergeRangesToThreshold(
        contextRanges.compressible,
        ctx.config.compress.minCompressRange,
      ),
      screenArray,
      io.state,
      ctx.config,
      computeProtectedRefs(screenArray, io.state, ctx.config, ctx.countTokens),
    );
    const recommendation: Recommendation = {
      contextRanges,
      recommendedRanges,
      nothingToCompress,
    };
    return { ...io, effects: { ...io.effects, recommendation } };
  },
};

const nudgeNode: PipelineNode = {
  name: "nudge-inject",
  run(io, ctx) {
    const nudge = decideNudge({
      tokenCount: ctx.tokenCount,
      config: ctx.config,
      state: io.state,
      messages: io.messages,
      recommendation: io.effects.recommendation,
      countTokens: ctx.countTokens,
    });

    const baseline = io.state.nudge.lastPerMessageNudgeTokens;
    const shownAtDecision = io.state.nudge.lastNudgeShownTokens;
    const nudgeGrowthTokens = resolveAdaptiveGrowth(
      ctx.config.modelContextLimit,
      ctx.config.nudge,
    );

    let stamped = { ...io.state.nudge };

    if (
      (baseline > 0 && ctx.tokenCount < baseline - nudgeGrowthTokens) ||
      (shownAtDecision > 0 &&
        ctx.tokenCount < shownAtDecision - nudgeGrowthTokens)
    ) {
      stamped.lastPerMessageNudgeTokens = ctx.tokenCount;
      stamped.lastNudgeShownTokens = 0;
      // The context shrank dramatically — host compaction, or a tokenCount
      // scale switch (an adapter moving from session-tree accounting to
      // sent-view estimation). Per-tier cadence stamps recorded at the old
      // scale would otherwise make `tokenCount - lastShownByTier[t] >=
      // growthFloor` unreachable (a stamp above the window never re-arms),
      // suppressing mid-band nudges until the absolute overLimit band fires.
      // Restart tier cadence from the new baseline, mirroring the full stamp
      // reset a successful applyCompression performs.
      // The second clause is load-bearing (#478): decideNudge keys growth to
      // lastNudgeShownTokens whenever it is non-zero, so an estimate-grade
      // overshoot pinned far above the baseline dead-zones every growth-gated
      // inject in [baseline - interval, shown + floor) unless a sustained
      // real drop below the shown reference re-anchors the cadence here.
      stamped.lastShownByTier = {};
    }

    if (stamped.lastPerMessageNudgeTokens === 0) {
      stamped.lastPerMessageNudgeTokens = ctx.tokenCount;
    }

    if (nudge.shouldInject) {
      stamped.lastNudgeShownTokens = ctx.tokenCount;
      // Record the injected tier's own cadence baseline. Shared baseline
      // (lastNudgeShownTokens) suppresses lower-priority tiers within this
      // turn; the per-tier entry throttles re-firing of the SAME tier.
      if (nudge.tier !== null) {
        stamped.lastShownByTier = {
          ...stamped.lastShownByTier,
          [nudge.tier]: ctx.tokenCount,
        };
      }
    }

    return {
      ...io,
      state: { ...io.state, nudge: stamped },
      effects: { ...io.effects, nudge },
    };
  },
};

const emergencyTruncateNode: PipelineNode = {
  name: "emergency-truncate",
  run(io, ctx) {
    const usage =
      ctx.config.modelContextLimit > 0
        ? ctx.tokenCount / ctx.config.modelContextLimit
        : 0;
    const prevStreak = io.state.terminalStreak ?? 0;
    if (usage < ctx.config.truncate.threshold) {
      return prevStreak > 0
        ? { ...io, state: { ...io.state, terminalStreak: 0 } }
        : io;
    }
    const trunc = truncateLargeToolOutputs(
      io.messages,
      ctx.tokenCount,
      ctx.config,
      ctx.countTokens,
      {
        protectRecentMessages: ctx.config.preserveRecentMessages,
        includeTextMessages: true,
      },
    );

    // Terminal-floor detection (#300): usage at/above the last-resort
    // threshold while NO tier can reclaim the benefit floor AND truncation
    // saved nothing means the irreducible floor exceeds the limit — no
    // kernel-side action can bring this session back under it. Track a
    // streak so one noisy turn doesn't declare terminality; N consecutive
    // stuck events emit the escape signal for the host to surface once.
    const nudge = io.effects.nudge;
    const minBenefit = nudge?.breakdown.minPressureBenefit ?? 0;
    const maxPending = nudge?.breakdown.maxPending ?? 0;
    const noViableCompression =
      nudge !== undefined &&
      (minBenefit > 0 ? maxPending < minBenefit : maxPending <= 0);
    const stuck = noViableCompression && trunc.savedTokens <= 0;
    const streak = stuck ? prevStreak + 1 : 0;
    const escapeAfter = ctx.config.truncate.terminalEscapeAfter ?? 3;
    const triggered = stuck && escapeAfter > 0 && streak >= escapeAfter;

    const effects: NodeEffects = {
      ...io.effects,
      truncatedCount: trunc.truncatedCount,
    };
    if (trunc.savedTokens <= 0) {
      effects.truncationSkipped =
        trunc.candidatesFound === 0
          ? `emergency-truncate ran at ${Math.round(usage * 100)}% usage but found no truncatable content (no oversized tool-result or text message outside the last ${ctx.config.preserveRecentMessages} messages)`
          : `emergency-truncate found ${trunc.candidatesFound} candidate(s) at ${Math.round(usage * 100)}% usage but none were large enough to save tokens`;
    }
    if (triggered) {
      effects.terminalEscape = {
        message: `Usage at ${Math.round(usage * 100)}% (${ctx.tokenCount}/${ctx.config.modelContextLimit} tokens) persists with nothing compressible above the benefit floor and no truncatable content: compression cannot reduce this context below the limit. Start a new session or use native compaction.`,
        usage,
        tokenCount: ctx.tokenCount,
        modelContextLimit: ctx.config.modelContextLimit,
        stuckEvents: streak,
      };
    }
    return {
      ...io,
      messages: trunc.messages,
      state: { ...io.state, terminalStreak: streak },
      effects,
    };
  },
};

interface SingleRangeInput {
  spec: {
    startRef: string;
    endRef: string;
    summary: string;
    topic?: string;
    compressCallId?: string;
    summaryMaxChars?: number;
  };
  messages: CoreMessage[];
  state: CompressionState;
  runId: string;
  config: Config;
  protectedMessageIds?: Set<string>;
  countTokens: (text: string) => number;
  preExistingCoverage: Set<string>;
}

interface SingleRangeOutcome {
  tokens: number;
  warnings: string[];
  /** #400: set when the range ended as an in-place refold instead of creating
   * a fresh block — the ids of the blocks updated (caller counts these, not 1). */
  refolded?: string[];
}

interface PlanSingleRangeInput {
  spec: CompressRangeSpec;
  messages: CoreMessage[];
  state: CompressionState;
  config: Config;
  protectedMessageIds?: Set<string>;
  countTokens: (text: string) => number;
  preExistingCoverage: Set<string>;
  /** #3185: previews carry no summary (it is ignored downstream), so the
   * summary-length checks are skipped; the empty-range check still applies. */
  skipSummaryValidation?: boolean;
}

type SingleRangePlan =
  | {
      kind: "refold";
      blocks: CompressionBlock[];
      warnings: string[];
    }
  | {
      kind: "commit";
      warnings: string[];
      filteredIds: string[];
      effectiveMessageIds: Set<string>;
      consumedBlockIds: string[];
      targetTier: CompressionTier;
      outputTier: CompressionTier;
      compressedTokens: number;
      excludedProtectedTools: string[];
      excludedRecentZone: string[];
      excludedCarriers: string[];
      excludedMedia: string[];
      withdrawnIds: string[];
      splitTurnCount: number;
      splitPairCount: number;
    };

/** Pre-commit computation shared by applySingleRange (real path) and
 * previewCompression (#3185): boundary resolution, carrier/pair adjustment,
 * protected carve, turn-integrity withdrawals, livelock guard, validation
 * and token accounting — everything BEFORE any state mutation. Throws like
 * the historical single-range pass did; callers catch and wrap with
 * rangeError. */
function planSingleRange(input: PlanSingleRangeInput): SingleRangePlan {
  const warnings: string[] = [];
  // #3236: the pre-block sequence runs as ONE shared projection
  // (unit-projection.ts) that the recommendation side screens with — same
  // definition for advertise and execute; fatal errors are thrown verbatim.
  const projection = projectUnit({
    messages: input.messages,
    state: input.state,
    config: input.config,
    startRef: input.spec.startRef,
    endRef: input.spec.endRef,
    preExistingCoverage: input.preExistingCoverage,
    protectedMessageIds: input.protectedMessageIds,
    warnings,
  });
  if (projection.fatal) throw projection.fatal.error;
  const {
    filteredIds,
    consumedBlockIds,
    effectiveMessageIds,
    outputTier,
    isBlockBoundary,
    targetTier,
    directMessageIds,
    skippedCarrierIds,
    splitTurnCount,
    splitPairCount,
    withdrawnIds: withdrawnSet,
  } = projection;

  // Preview exclusion categories (#3185): UnitProjection exposes aggregates
  // only, so re-partition the direct ids that did not fold with the same
  // per-category predicates in original pipeline order — media first, then
  // recent-zone refs; whatever else the protected-tool filter dropped is
  // reported as a protected tool. Advisory display only: the apply path
  // reports these same exclusions through its warnings.
  const msgById = new Map(input.messages.map((m) => [m.id, m]));
  const keptSet = new Set(filteredIds);
  const mediaExcluded: string[] = [];
  const hitProtectedRaw: string[] = [];
  const excludedProtectedTools: string[] = [];
  for (const id of directMessageIds) {
    if (keptSet.has(id) || withdrawnSet.has(id)) continue;
    const msg = msgById.get(id);
    if (msg && hasUnrecoverableMediaPayload(msg)) {
      mediaExcluded.push(id);
      continue;
    }
    const ref = input.state.messageRefs.byRaw[id];
    if (ref !== undefined && input.protectedMessageIds?.has(ref)) {
      hitProtectedRaw.push(id);
      continue;
    }
    excludedProtectedTools.push(id);
  }

  // Livelock guard (billion-context-pi#199): a message-ref range whose entire
  // content is already owned by active block(s) — its raw ids are all covered
  // or dropped as protected tool pairs — resolves with zero NEW direct
  // messages. Creating a block here would be an empty same-tier rewrite
  // (directMessageIds: []) that still reports blocksCreated>0: fake success.
  // The caller's view does not change, so a model driven by that report
  // repeats the identical call forever. Promote/merge must go through
  // explicit block-boundary refs (bN..bM) instead.
  if (
    !isBlockBoundary &&
    filteredIds.length === 0 &&
    consumedBlockIds.length > 0
  ) {
    // Refold-in-place under full-log hosts (#398/#400): the range RESOLVED
    // (inline-restored originals are still in the view) yet adds no NEW
    // direct messages — the pruned-host equivalent of this range classifies
    // as "consumed". Consult the same restored-inline rule here so both host
    // worlds share one entry point: a valid refold updates the in-span
    // blocks in place; everything else keeps the legacy rejection verbatim.
    const decision = evaluateRefold(input.state, input.spec);
    if (decision.kind === "refold") {
      return { kind: "refold", blocks: decision.blocks, warnings };
    }
    const first = consumedBlockIds[0]!;
    const last = consumedBlockIds[consumedBlockIds.length - 1]!;
    throw new Error(
      `Range ${input.spec.startRef}..${input.spec.endRef} contains no new compressible messages — every message in it is already covered by active block(s) ${consumedBlockIds.join(
        ", ",
      )}. Nothing was compressed. To rewrite or merge those blocks, reference them by block ID (${first}..${last}); otherwise run acp_status and compress a range it reports as compressible.`,
    );
  }

  validateCompressionRange(input, filteredIds, consumedBlockIds.length, {
    skipSummaryValidation: input.skipSummaryValidation,
  });

  let compressedTokens = 0;
  for (const id of filteredIds) {
    const message = input.messages.find((entry) => entry.id === id);
    compressedTokens += message
      ? countMessageTokens(message, input.countTokens)
      : 0;
  }
  for (const consumedId of consumedBlockIds) {
    const consumed = blockById(input.state, consumedId);
    if (consumed) {
      compressedTokens += input.countTokens(consumed.summary);
    }
  }

  return {
    kind: "commit",
    warnings,
    filteredIds,
    effectiveMessageIds,
    consumedBlockIds,
    targetTier,
    outputTier,
    compressedTokens,
    excludedProtectedTools,
    excludedRecentZone: hitProtectedRaw,
    excludedCarriers: skippedCarrierIds,
    excludedMedia: mediaExcluded,
    withdrawnIds: [...withdrawnSet],
    splitTurnCount,
    splitPairCount,
  };
}

/** Commit half of a planned fold: allocate the block, record coverage,
 * deactivate absorbed blocks — the historical tail of the single-range pass. */
function commitFoldedRange(
  state: CompressionState,
  spec: CompressRangeSpec,
  plan: Extract<SingleRangePlan, { kind: "commit" }>,
  runId: string,
): void {
  const blockId = allocateBlockId(state);
  const block: CompressionBlock = {
    blockId,
    runId,
    tier: plan.outputTier,
    topic: spec.topic,
    summary: spec.summary,
    directMessageIds: plan.filteredIds,
    effectiveMessageIds: [...plan.effectiveMessageIds],
    directBlockIds: [...plan.consumedBlockIds],
    compressedTokens: plan.compressedTokens,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
    compressCallId: spec.compressCallId,
    startRef: spec.startRef,
    endRef: spec.endRef,
  };
  state.blocks.push(block);

  for (const consumedId of plan.consumedBlockIds) {
    const consumed = blockById(state, consumedId);
    if (consumed) consumed.active = false;
  }
}

function applySingleRange(input: SingleRangeInput): SingleRangeOutcome {
  const plan = planSingleRange({
    spec: input.spec,
    messages: input.messages,
    state: input.state,
    config: input.config,
    protectedMessageIds: input.protectedMessageIds,
    countTokens: input.countTokens,
    preExistingCoverage: input.preExistingCoverage,
  });
  if (plan.kind === "refold") {
    applyRefolds({
      spec: input.spec,
      state: input.state,
      runId: input.runId,
      config: input.config,
      blockIds: plan.blocks.map((block) => block.blockId),
    });
    return {
      tokens: 0,
      warnings: plan.warnings,
      refolded: plan.blocks.map((block) => block.blockId),
    };
  }
  commitFoldedRange(input.state, input.spec, plan, input.runId);
  return { tokens: plan.compressedTokens, warnings: plan.warnings };
}

function validateCompressionRange(
  input: { spec: CompressRangeSpec; config: Config },
  directMessageIds: string[],
  consumedBlockCount: number,
  options?: { skipSummaryValidation?: boolean },
): void {
  const cfg = input.config.compress;
  if (!options?.skipSummaryValidation) validateSummaryLength(input.spec, cfg);

  if (directMessageIds.length === 0 && consumedBlockCount === 0) {
    throw new Error(
      "Range contains no compressible messages — all are already covered by active blocks or protected.",
    );
  }
}

function validateSummaryLength(
  spec: { summary: string; summaryMaxChars?: number },
  cfg: Config["compress"],
): void {
  const summary = spec.summary?.trim() ?? "";

  if (summary.length === 0) {
    throw new Error(
      "Summary is empty — provide a meaningful summary of the compressed range.",
    );
  }

  if (cfg.minSummaryLength > 0 && summary.length < cfg.minSummaryLength) {
    throw new Error(
      `Summary too short (${summary.length} chars, min ${cfg.minSummaryLength}). The summary must capture the compressed range's key information.`,
    );
  }

  const effectiveMax = spec.summaryMaxChars ?? cfg.maxSummaryLength;
  if (effectiveMax > 0 && summary.length > effectiveMax) {
    throw new Error(
      `Summary too long (${summary.length} chars, max ${effectiveMax}). Strip noise — keep critical paths, decisions, errors, and code references. Or pass summaryMaxChars to increase the limit — don't lose critical info just to fit.`,
    );
  }
}

interface NudgeInput {
  tokenCount: number;
  config: Config;
  state: CompressionState;
  messages: CoreMessage[];
  recommendation?: Recommendation;
  countTokens: (t: string) => number;
}

function resolveAdaptiveGrowth(
  modelContextLimit: number,
  nudge: NudgeConfig,
): number {
  if (!modelContextLimit || modelContextLimit <= 0) return nudge.growthFloor;
  return Math.min(
    nudge.growthCap,
    Math.max(
      nudge.growthFloor,
      Math.round(modelContextLimit * nudge.growthRatio),
    ),
  );
}

/** Minimum reclaimable tokens for a pressure-band nudge to be worth injecting.
 *  A sub-threshold rewrite (e.g. re-distilling a 232-token summary at near-
 *  equal size) resets the nudge baselines on success, re-arming the still-hot
 *  band next turn — a zero-yield loop (#198). Scales with the window so an
 *  inflated host tokenCount can never make a tiny pending look actionable:
 *  max(5000, round(limit × 0.01)); explicit 0 restores legacy any-pending. */
function resolveMinPressureBenefit(
  modelContextLimit: number,
  nudge: NudgeConfig,
): number {
  return (
    nudge.minPressureBenefitTokens ??
    Math.max(5000, Math.round(modelContextLimit * 0.01))
  );
}

/** Compressible amount for each tier. T1 = EFFECTIVE merged-range tokens —
 *  only ranges whose real char count >= minCompressRange count (avoids
 *  inflation from fragmentation; matches the apply-side gate, which counts
 *  raw `msg.text.length`, so a nudge never offers a range the kernel would
 *  atomically reject — see CompressibleRange.chars); T2 = total summary
 *  tokens of all active tier-1 blocks; T3 = total summary tokens of all
 *  active tier-2 blocks. */
function pendingByTier(
  state: CompressionState,
  recommendation: Recommendation | undefined,
  countTokens: (t: string) => number,
  minCompressRange: number,
): Record<number, { pending: number; targetBlocks: CompressionBlock[] }> {
  const out: Record<
    number,
    { pending: number; targetBlocks: CompressionBlock[] }
  > = {};
  const merged = recommendation?.recommendedRanges ?? [];
  const effective =
    minCompressRange > 0
      ? merged.filter((r) => (r.chars ?? r.tokens * 4) >= minCompressRange)
      : merged;
  out[1] = {
    pending: effective.reduce((s, r) => s + r.tokens, 0),
    targetBlocks: [],
  };
  const active = activeBlocks(state);
  const t1 = active.filter((b) => b.tier === 1);
  const t2 = active.filter((b) => b.tier === 2);
  out[2] = {
    pending: t1.reduce((s, b) => s + countTokens(b.summary), 0),
    targetBlocks: t1,
  };
  out[3] = {
    pending: t2.reduce((s, b) => s + countTokens(b.summary), 0),
    targetBlocks: t2,
  };
  return out;
}

function decideNudge(input: NudgeInput): NudgeDecision {
  const { config, state, tokenCount, recommendation, countTokens } = input;
  const limit = config.modelContextLimit;
  const usage = limit > 0 ? tokenCount / limit : 0;

  const nudgeGrowthTokens = resolveAdaptiveGrowth(limit, config.nudge);
  const minPressureBenefit = resolveMinPressureBenefit(limit, config.nudge);

  const overLimit = usage >= config.nudge.maxContextLimitPct;
  const emergencyOverride = usage >= config.nudge.emergencyThresholdPct;
  // High-pressure band: over maxContextLimitPct (subsumes the emergency
  // threshold). Bypasses growth gate + cadence; gated on effective pending.
  const pressure = overLimit || emergencyOverride;

  const baseline = state.nudge.lastPerMessageNudgeTokens;
  const hadPendingNudge = state.nudge.lastNudgeShownTokens > 0;

  const hasPendingNudge = hadPendingNudge;
  const effectiveThreshold = hasPendingNudge
    ? Math.floor(nudgeGrowthTokens / 2)
    : nudgeGrowthTokens;

  const growthReference =
    state.nudge.lastNudgeShownTokens > 0
      ? state.nudge.lastNudgeShownTokens
      : baseline > 0
        ? baseline
        : tokenCount;

  const growthFloor = Math.max(
    config.nudge.minGrowthFloor,
    config.nudge.minGrowthRatio * nudgeGrowthTokens,
  );

  const growthSinceReference = tokenCount - growthReference;

  const rec = recommendation;
  const tiers = pendingByTier(
    state,
    rec,
    countTokens,
    config.compress.minCompressRange,
  );

  // Tier arbitration. Emergency (usage >= emergencyThresholdPct) ignores tier
  // priority and picks the tier with the MAX pending. Non-emergency defaults to
  // T1; T2/T3 override via either path: (a) COUNT — the number of active
  // lower-tier blocks reached tiers.tier2Trigger/tier3Trigger (the documented
  // block-count trigger; summaries are ~10:1 condensed so a token comparison
  // against raw pending starves), or (b) TOKEN MASS — crossed the per-tier
  // threshold AND exceeds the effective pending of every lower tier (T2 > T1
  // effective; T3 > T2 and > T1 effective). Per-tier thresholds (#2376):
  // nudge.tierGrowthTokens.{t1,t2,t3} may pin each mass trigger independently;
  // each unset tier keeps its derived default (T1 = growth step, T2/T3 = the
  // shared multiplier threshold), so absent config decides byte-identically.
  const tier2Threshold = Math.round(
    nudgeGrowthTokens * (config.nudge.tier2GrowthMultiplier ?? 1.5),
  );
  const tierThresholds: Record<CompressionTier, number> = {
    1: config.nudge.tierGrowthTokens?.t1 ?? nudgeGrowthTokens,
    2: config.nudge.tierGrowthTokens?.t2 ?? tier2Threshold,
    3: config.nudge.tierGrowthTokens?.t3 ?? tier2Threshold,
  };
  let injectedTier: CompressionTier | null = null;
  let injectedReason = "";
  let bestPending = 0;
  const t1Eff = tiers[1]?.pending ?? 0;
  const t2Pen = tiers[2]?.pending ?? 0;
  const t3Pen = tiers[3]?.pending ?? 0;
  const maxPending = Math.max(0, t1Eff, t2Pen, t3Pen);
  // First-sight mass bypass (#194): growthReference seeds to tokenCount when
  // no baseline exists, so a session that ARRIVES with a huge ready mass
  // (stateless full-history ingest / restored state) shows growthSinceReference
  // ≈ 0 and waits for a full floor of NEW tokens before its first compress —
  // #351 sat 934K-ready for 18 idle minutes and died ~4 min short of the floor.
  // The floor paces WITHIN a backlog; it must not gate draining one. The bypass
  // re-arms after every SUCCESSFUL compression (which clears the baseline):
  // still-in-band with ready mass over threshold keeps nudging the backlog
  // down, one compress per re-fire — no growth debt between compressions.
  // Guardrails: while the model IGNORES a nudge the shown stamp stays set, so
  // this never re-fires on an unresponsive session; a fresh session below the
  // usage band still waits, as before; and the tier branches below apply
  // unchanged.
  const firstSightMassReady =
    state.nudge.lastNudgeShownTokens === 0 &&
    baseline === 0 &&
    usage >= config.nudge.minContextLimitPct &&
    Math.max(t1Eff, t2Pen, t3Pen) >= nudgeGrowthTokens;
  const growthReady =
    firstSightMassReady || growthSinceReference >= growthFloor;
  const t2Count = tiers[2]?.targetBlocks.length ?? 0;
  const t3Count = tiers[3]?.targetBlocks.length ?? 0;

  // Count-triggered tier distillation (#379): block COUNT is not a need
  // signal — 10:1-condensed summaries can stack 5 blocks of almost nothing
  // to reclaim, and each distillation rewrites the wire from the fold anchor
  // onward (prefix-cache loss, billion-context#1249). The count path defaults
  // OFF (tier2Trigger 1000 / tier3Trigger 2000) and fires on pure count when
  // explicitly configured — no usage gate: growth/token-mass are the need
  // signal, percentages are not (#379 deletes the #238 gate).
  const t2CountReady = t2Count >= config.tiers.tier2Trigger;
  const t3CountReady = t3Count >= config.tiers.tier3Trigger;
  if (pressure) {
    // High pressure: pick the tier with the MAX pending so pressure can route
    // to distillation when that reclaims the most tokens. Gated on effective
    // pending (real chars >= minCompressRange for T1) so we never offer ranges
    // the kernel would atomically reject. emergency vs over-limit only
    // changes the reason label/voice; truncate.threshold remains the
    // independent last resort when there is genuinely nothing to compress.
    const candidates: CompressionTier[] = [1];
    if (config.tiers.enabled) {
      candidates.push(2, 3);
    }
    let best: CompressionTier | null = null;
    for (const t of candidates) {
      const p = tiers[t]?.pending ?? 0;
      if (p > bestPending) {
        bestPending = p;
        best = t;
      }
    }
    // Minimum-benefit gate (#198): a sub-threshold pending can never look
    // actionable, no matter how hot the band is — otherwise every "success"
    // resets the baselines and the same EMERGENCY nudge re-injects each turn.
    if (best !== null && bestPending >= minPressureBenefit) {
      injectedTier = best;
      const label = emergencyOverride ? "EMERGENCY" : "OVER-LIMIT";
      injectedReason =
        best === 1
          ? `${label} T1: max effective pending ${bestPending}, usage ${Math.round(usage * 100)}%`
          : `${label} T${best} distill: max pending ${bestPending} (T1 effective ${t1Eff}, T2 ${t2Pen}, T3 ${t3Pen}), usage ${Math.round(usage * 100)}%`;
    }
  } else if (growthReady) {
    if (t1Eff >= tierThresholds[1]) {
      injectedTier = 1;
      injectedReason = `T1 effective ${t1Eff} >= ${tierThresholds[1]}, growth ${growthSinceReference}, usage ${Math.round(usage * 100)}%`;
    } else if (
      config.tiers.enabled &&
      (t2CountReady || (t2Pen >= tierThresholds[2] && t2Pen > t1Eff))
    ) {
      const lastShown = state.nudge.lastShownByTier[2] ?? 0;
      const cadenceMet =
        lastShown === 0 || tokenCount - lastShown >= growthFloor;
      if (cadenceMet) {
        injectedTier = 2;
        injectedReason = t2CountReady
          ? `T2 distill ready: ${t2Count} tier-1 blocks >= tier2Trigger ${config.tiers.tier2Trigger} (${t2Pen} tokens), usage ${Math.round(usage * 100)}%`
          : `T2 distill ready: ${tiers[2]!.targetBlocks.length} tier-1 blocks (${t2Pen} tokens) >= ${tierThresholds[2]}${config.nudge.tierGrowthTokens?.t2 === undefined ? " (1.5x)" : ""} and > T1 effective ${t1Eff}, usage ${Math.round(usage * 100)}%`;
      }
    } else if (
      config.tiers.enabled &&
      (t3CountReady ||
        (t3Pen >= tierThresholds[3] && t3Pen > t2Pen && t3Pen > t1Eff))
    ) {
      const lastShown = state.nudge.lastShownByTier[3] ?? 0;
      const cadenceMet =
        lastShown === 0 || tokenCount - lastShown >= growthFloor;
      if (cadenceMet) {
        injectedTier = 3;
        injectedReason = t3CountReady
          ? `T3 condense ready: ${t3Count} tier-2 blocks >= tier3Trigger ${config.tiers.tier3Trigger} (${t3Pen} tokens), usage ${Math.round(usage * 100)}%`
          : `T3 condense ready: ${tiers[3]!.targetBlocks.length} tier-2 blocks (${t3Pen} tokens) >= ${tierThresholds[3]}${config.nudge.tierGrowthTokens?.t3 === undefined ? " (1.5x)" : ""} and > T2 ${t2Pen} and > T1 effective ${t1Eff}, usage ${Math.round(usage * 100)}%`;
      }
    }
  }

  const shouldInject = injectedTier !== null;
  if (shouldInject && firstSightMassReady) {
    injectedReason += " [first-sight mass]";
  }

  let reason: string;
  if (injectedTier !== null) {
    reason = injectedReason;
  } else if (pressure) {
    const label = emergencyOverride ? "EMERGENCY" : "OVER-LIMIT";
    reason =
      bestPending === 0
        ? `${label}: usage ${Math.round(usage * 100)}% but no tier has effective compressible content (T1 effective ${t1Eff}, T2 ${t2Pen}, T3 ${t3Pen}) — nudge suppressed to avoid offering ranges below minCompressRange`
        : `${label}: usage ${Math.round(usage * 100)}% but max pending ${bestPending} < min benefit ${minPressureBenefit} tokens (T1 effective ${t1Eff}, T2 ${t2Pen}, T3 ${t3Pen}) — suppressed: rewriting below the benefit floor reclaims almost nothing while usage stays high; truncate.threshold remains the safety valve`;
  } else {
    const tiersList = [1, 2, 3] as const;
    const eligible = tiersList.filter((t) => config.tiers.enabled || t === 1);
    const countReady = (t: 1 | 2 | 3) =>
      t === 2
        ? t2Count >= config.tiers.tier2Trigger
        : t === 3
          ? t3Count >= config.tiers.tier3Trigger
          : false;
    const ready = eligible
      .filter((t) => (tiers[t]?.pending ?? 0) >= tierThresholds[t])
      .map((t) => `T${t} ${tiers[t]!.pending}`);
    const readyCount = eligible
      .filter(
        (t) => (tiers[t]?.pending ?? 0) < tierThresholds[t] && countReady(t),
      )
      .map((t) => `T${t} ${t === 2 ? t2Count : t3Count} blocks (count)`);
    const readyAll = [...ready, ...readyCount];
    const readyHint =
      readyAll.length > 0 ? `, ready: ${readyAll.join(", ")}` : "";
    const blocked = eligible
      .filter(
        (t) =>
          ((tiers[t]?.pending ?? 0) >= tierThresholds[t] || countReady(t)) &&
          (state.nudge.lastShownByTier[t] ?? 0) > 0 &&
          tokenCount - (state.nudge.lastShownByTier[t] ?? 0) < growthFloor,
      )
      .map((t) => `T${t} (cadence)`);
    const blockedHint =
      blocked.length > 0 ? `, blocked: ${blocked.join(", ")}` : "";
    // Report the ACTUAL blocking condition, not a fixed template. A session
    // can have plenty to compress (pending >= threshold) but still not
    // inject because growth/floor/cadence isn't met — the old fixed
    // "< threshold" string lied in that case.
    // The floor below which NO tier can fire by mass; with all tiers unset
    // this is exactly nudgeGrowthTokens (the T1 threshold is the minimum).
    const minTierThreshold = Math.min(
      tierThresholds[1],
      tierThresholds[2],
      tierThresholds[3],
    );
    const pendingShort = maxPending < minTierThreshold;
    const growthShort = growthSinceReference < growthFloor;
    const parts: string[] = [];
    if (pendingShort)
      parts.push(`max compressible ${maxPending} < threshold ${minTierThreshold}`);
    if (growthShort)
      parts.push(`growth ${growthSinceReference} < floor ${growthFloor}`);
    if (parts.length === 0)
      parts.push(
        `max compressible ${maxPending}, growth ${growthSinceReference}`,
      );
    reason = `${parts.join("; ")}${readyHint}${blockedHint}`;
  }

  const ctxBreakdown = computeContextBreakdown(
    input.messages,
    tokenCount,
    growthSinceReference,
    countTokens,
  );

  return {
    shouldInject,
    reason,
    compressibleRanges: rec?.recommendedRanges ?? [],
    protectedRanges: rec?.contextRanges.protected ?? [],
    activeBlockSpans: activeBlockSpans(state),
    tierTargetBlocks: injectedTier ? tiers[injectedTier]!.targetBlocks : [],
    contextUsage: usage,
    tier: injectedTier,
    breakdown: {
      usage,
      growth: growthSinceReference,
      growthReference,
      effectiveThreshold,
      nudgeGrowthTokens,
      growthFloor,
      hasPendingNudge: hasPendingNudge ? 1 : 0,
      overLimit: overLimit ? 1 : 0,
      emergencyOverride: emergencyOverride ? 1 : 0,
      minPressureBenefit,
      pendingT1: tiers[1]!.pending,
      pendingT2: tiers[2]!.pending,
      pendingT3: tiers[3]!.pending,
      maxPending,
    },
    contextBreakdown: ctxBreakdown,
  };
}

function computeContextBreakdown(
  messages: CoreMessage[],
  total: number,
  growth: number,
  countTokens: (t: string) => number,
): ContextBreakdown {
  const count = countTokens ?? ((t: string) => Math.ceil(t.length / 4));
  let system = 0,
    tool = 0,
    summaries = 0,
    code = 0,
    text = 0;
  for (const msg of messages) {
    const tokens = countMessageTokens(msg, count);
    if (msg.text?.startsWith("[Compressed conversation section]")) {
      summaries += tokens;
    } else if (isToolMessage(msg)) {
      tool += tokens;
    } else if (msg.role === "system") {
      system += tokens;
    } else if (msg.text?.includes("```")) {
      code += tokens;
    } else {
      text += tokens;
    }
  }
  return { system, tool, summaries, code, text, total, growth };
}

function cloneState(state: CompressionState): CompressionState {
  return {
    blocks: state.blocks.map((block) => ({
      ...block,
      directMessageIds: [...block.directMessageIds],
      effectiveMessageIds: [...block.effectiveMessageIds],
      directBlockIds: [...block.directBlockIds],
    })),
    messageRefs: {
      byRaw: { ...state.messageRefs.byRaw },
      byRef: { ...state.messageRefs.byRef },
    },
    tokenSnapshot: { ...(state.tokenSnapshot ?? {}) },
    nudge: { ...state.nudge, anchors: { ...state.nudge.anchors } },
    stats: { ...state.stats },
    absorbed: (state.absorbed ?? []).map((record) => ({ ...record })),
    rules: (state.rules ?? []).map((rule) => ({ ...rule })),
    nextRuleId: state.nextRuleId,
    terminalStreak: state.terminalStreak,
    nextBlockId: state.nextBlockId,
    nextRunId: state.nextRunId,
    hiddenOrphanRefs: state.hiddenOrphanRefs
      ? [...state.hiddenOrphanRefs]
      : undefined,
    deadRefs: state.deadRefs ? [...state.deadRefs] : undefined,
    lastPassIds: state.lastPassIds ? [...state.lastPassIds] : undefined,
  };
}

function scoreRelevance(block: CompressionBlock, terms: string[]): number {
  const topic = (block.topic ?? "").toLowerCase();
  const summary = block.summary.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const topicHits = countOccurrences(topic, term);
    if (topicHits > 0) score += Math.min(topicHits * 0.15, 0.45);
    const summaryHits = countOccurrences(summary, term);
    if (summaryHits > 0) score += Math.min(summaryHits * 0.04, 0.2);
  }
  return Math.min(score, 1);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) !== -1) {
    count++;
    position += needle.length;
  }
  return count;
}

export { createInitialState };
