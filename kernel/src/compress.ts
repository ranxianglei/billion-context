import { assignRefs, highestUsedIndex, indexToRef } from "./refs.js";
import { remintCoveredLiveIds } from "./instance-reid.js";
import { prune, isSummaryMessageId } from "./prune.js";
import { syncBlocks } from "./sync.js";
import { advanceSurvival, activeBlocks, blockById } from "./state.js";
import { allocateBlockId, allocateRunId, createInitialState } from "./state.js";
import { countMessageTokens, defaultCountTokens } from "./tokenize.js";
import { validateConfig } from "./config.js";
import {
  BoundaryNotFoundError,
  resolveBoundaries,
  blockVisibleInRange,
  parseBoundary,
} from "./boundaries.js";
import type { ResolvedRange } from "./boundaries.js";
import { activeAncestorIds } from "./decompress.js";
import { truncateLargeToolOutputs } from "./truncate-tools.js";
import { hideConsumedCompressCalls } from "./hide-consumed.js";
import { appendAbsorbPrompts, hideAbsorbedMessages } from "./absorb.js";
import { applyCrushToMessages } from "./crush.js";
import { applyRetrieve, ccrStoreNode, RETRIEVED_ID_PREFIX } from "./ccr.js";
import type { ApplyRetrieveResult, CcrEffect } from "./ccr.js";
import { createContentStore } from "./content-store.js";
import type { MessageContentStore } from "./content-store.js";
import { applyMessageFilters, listMessageFilters } from "./filter/index.js";
import { activeBlockSpans, resolveBlockSpan } from "./block-map.js";
import { createRenderRefsNode } from "./render-refs.js";
import type { RenderStrategy } from "./render-refs.js";
import {
  collectLatestProtected,
  collectProtectedToolCallIds,
  hasMediaPayload,
  isMessageLatestProtected,
  isMessageProtected,
  isMessageProtectedWithPairing,
} from "./protected.js";
import { isToolMessage } from "./message-kind.js";
import { adjustBoundariesForToolPairs } from "./tool-pairs.js";
import { adjustBoundariesForReasoningPairs } from "./reasoning-pairs.js";
import { computeIntegrityWithdrawals } from "./turn-integrity.js";
import {
  computeProtectedRefs,
  buildCompressibleRanges,
  mergeRangesToThreshold,
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
  Config,
  ContextBreakdown,
  CoreMessage,
  NudgeConfig,
  NudgeDecision,
  ProcessTurnResult,
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

type RefoldDecision =
  | { kind: "refold"; blocks: CompressionBlock[] }
  | { kind: "blocked"; reasons: string[] };

/** Ref-number span [lo, hi] of a spec boundary: m-refs contribute their
 * number, block refs expand through resolveBlockSpan. */
function requestedRefoldSpan(
  state: CompressionState,
  spec: { startRef: string; endRef: string },
): { lo: number; hi: number } | null {
  const nums: number[] = [];
  for (const ref of [spec.startRef, spec.endRef]) {
    const parsed = parseBoundary(ref);
    if (!parsed) return null;
    if (parsed.kind === "message") {
      nums.push(parsed.numericId);
      continue;
    }
    const block = blockById(state, `b${parsed.numericId}`);
    if (!block) return null;
    const span = resolveBlockSpan(block, state.messageRefs.byRaw);
    if (!span) return null;
    const lo = parseBoundary(span.startRef);
    const hi = parseBoundary(span.endRef);
    if (!lo || !hi) return null;
    nums.push(lo.numericId, hi.numericId);
  }
  return { lo: Math.min(...nums), hi: Math.max(...nums) };
}

/** #398 refold-in-place gate for a consumed range: every active block inside
 * the requested span must be restored-inline (with a fully restored ancestor
 * chain) and at least one must be — then it updates those in place instead of
 * rejecting as "already compressed". Otherwise the blocking blocks are listed
 * by id ("blocked by bN (not restored)" / "partially covered bN"). */
function evaluateRefold(
  state: CompressionState,
  spec: { startRef: string; endRef: string },
): RefoldDecision {
  const span = requestedRefoldSpan(state, spec);
  if (!span) return { kind: "blocked", reasons: [] };
  const reasons: string[] = [];
  const blocks: CompressionBlock[] = [];
  for (const block of state.blocks) {
    if (!block.active) continue;
    const resolved = resolveBlockSpan(block, state.messageRefs.byRaw);
    if (!resolved) {
      reasons.push(`partially covered ${block.blockId}`);
      continue;
    }
    const ownLo = parseBoundary(resolved.startRef)?.numericId;
    const ownHi = parseBoundary(resolved.endRef)?.numericId;
    if (ownLo === undefined || ownHi === undefined) continue;
    if (ownHi < span.lo || ownLo > span.hi) continue;
    if (!block.restoredInline) {
      reasons.push(`blocked by ${block.blockId} (not restored)`);
      continue;
    }
    // Overlapping but not fully contained in the request: part of the block
    // would keep the stale summary while the range gets a new one.
    if (ownLo < span.lo || ownHi > span.hi) {
      reasons.push(`partially covered ${block.blockId}`);
      continue;
    }
    const blockers = activeAncestorIds(state, block.blockId).filter(
      (ancestorId) => !blockById(state, ancestorId)?.restoredInline,
    );
    if (blockers.length > 0) {
      for (const id of blockers)
        reasons.push(`blocked by ${id} (not restored)`);
      continue;
    }
    blocks.push(block);
  }
  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length > 0)
    return { kind: "blocked", reasons: uniqueReasons };
  if (blocks.length > 0) return { kind: "refold", blocks };
  return { kind: "blocked", reasons: [] };
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
  const targets = new Set(input.blockIds);
  input.state.blocks = input.state.blocks.map((block) =>
    targets.has(block.blockId)
      ? {
          ...block,
          summary: input.spec.summary,
          topic: input.spec.topic ?? block.topic,
          runId: input.runId,
          restoredInline: false,
        }
      : block,
  );
}

export function createCore(ports: Ports = {}): CompressionCore {
  const countTokens = ports.countTokens ?? defaultCountTokens;

  function applyCompression(
    input: ApplyCompressionInput,
  ): ApplyCompressionResult {
    const state: CompressionState = cloneState(input.state);
    // Lazy run-id allocation (#2370): never advance nextRunId on a no-op
    // failure — the host forkSnapshot fingerprint hashes full state, so a bump
    // here would churn contextGeneration on every failed manual tool.
    let allocatedRunId: string | null = null;
    const runIdOf = (): string => (allocatedRunId ??= allocateRunId(state));
    let blocksCreated = 0;
    let tokensCompressed = 0;
    const errors: string[] = [];
    const warnings: string[] = [];
    const notes: string[] = [];

    // Default to the soft-protected zone (recent-N + last user message) when the
    // caller doesn't pass an explicit set. This makes applyCompression safe by
    // default; applySingleRange enforces it as a hard backstop.
    const protectedMessageIds =
      input.protectedMessageIds ??
      computeProtectedRefs(
        input.messages,
        input.state,
        input.config,
        countTokens,
      );

    const preExistingCoverage = collectCoverage(state);

    // Classify every requested range ONCE. The result feeds overlap
    // skipSpecs, the minCompressRange pre-check, and the per-range loop —
    // previously each re-resolved and silently swallowed failures, so
    // consumed/unknown ranges produced misleading "too small" errors.
    const classifications = new Map<
      (typeof input.ranges)[number],
      RangeResolution
    >();
    const classificationErrors: string[] = [];
    const consumedRanges: typeof input.ranges = [];
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
            rangeError(
              spec,
              error instanceof Error ? error.message : String(error),
            ),
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
    const danglingBySpec = new Map<(typeof input.ranges)[number], string[]>();
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
    const refoldDecisions = new Map<
      (typeof input.ranges)[number],
      RefoldDecision
    >();
    const isRefoldCandidate = (resolution: RangeResolution): boolean =>
      resolution.status === "consumed" ||
      (resolution.status === "ok" &&
        resolution.resolved.boundaryKind !== "block" &&
        resolution.resolved.messageIds.every((id) =>
          preExistingCoverage.has(id),
        ));
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
      spec: (typeof input.ranges)[number];
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
    const skipSpecs = new Set<(typeof input.ranges)[number]>();
    let acceptedMaxIndex = -1;
    for (const entry of sortedRanges) {
      if (entry.start <= acceptedMaxIndex) {
        skipSpecs.add(entry.spec);
        warnings.push(
          `Skipped range (${entry.spec.startRef}..${entry.spec.endRef}) — overlaps an earlier range in the batch; the earlier range takes precedence. Keep ranges disjoint.`,
        );
        continue;
      }
      if (entry.end > acceptedMaxIndex) acceptedMaxIndex = entry.end;
    }

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
        const diagnostics = refGateDiagnostics(
          state,
          input.ranges.length,
          unknownCount,
        );
        const firstConsumed = consumedRanges[0];
        const covering = firstConsumed
          ? coveringBlockIds(state, firstConsumed)
          : [];
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
        if (gateMessage === null) {
          // No range was counted (every spec failed classification, e.g.
          // unparseable refs). The per-range errors name the real cause; a
          // "too small" verdict here would mislead the model into combining
          // more messages instead of fixing its refs (#310).
          return {
            state: input.state,
            result: {
              blocksCreated: 0,
              tokensCompressed: 0,
              errors: [...classificationErrors],
              warnings: [],
            },
          };
        }
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

        // Rejected batches still carry their side effect: the dead-ref
        // tombstones marked above (#2362). The clone differs from input.state
        // ONLY in that field before the gate, so returning it is safe.
        return {
          state,
          result: {
            blocksCreated: 0,
            tokensCompressed: 0,
            errors: [gateMessage, ...classificationErrors],
            warnings: [],
          },
        };
      }
    }

    for (const spec of input.ranges) {
      if (skipSpecs.has(spec)) continue;
      const resolution = classifications.get(spec);
      if (resolution === undefined) continue;
      if (resolution.status === "consumed") {
        const decision = refoldDecisions.get(spec);
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
        const reasons = decision?.kind === "blocked" ? decision.reasons : [];
        const dangling = danglingBySpec.get(spec);
        warnings.push(
          dangling && dangling.length > 0
            ? `Skipped range (${spec.startRef}..${spec.endRef}) — its refs ${dangling.join(", ")} are DEAD (the client rewrote or dropped those messages); this range can never compress, do not retry it.`
            : `Skipped range (${spec.startRef}..${spec.endRef}) — already compressed${reasons.length > 0 ? `: ${reasons.join("; ")}` : " (messages consumed by existing block(s))"}; nothing to compress.`,
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
          protectedMessageIds,
          countTokens,
          preExistingCoverage,
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
      effects: {},
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
    // Media payloads (image/file sidecars) ride outside msg.text; folding one
    // destroys it permanently (#1188), so media messages always get a BLOCKED
    // ref — never advertised, never folded — regardless of tool-protection config.
    const protectedFn = (m: CoreMessage) =>
      hasMediaPayload(m) ||
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
  run(io) {
    return { ...io, messages: prune(io.messages, io.state) };
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
  run(io) {
    const hidden = hideConsumedCompressCalls(io.state, io.messages);
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
    const contextRanges = buildCompressibleRanges(
      io.messages,
      io.state,
      ctx.config,
      protectedRefs,
      ctx.countTokens,
    );
    const nothingToCompress = contextRanges.compressible.length === 0;
    const recommendation: Recommendation = {
      contextRanges,
      recommendedRanges: mergeRangesToThreshold(
        contextRanges.compressible,
        ctx.config.compress.minCompressRange,
      ),
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
        // Rotation memory (#509): survives the compression-success reset so a
        // compliant model draining raw ranges cannot restart every T1/T2 tie.
        stamped.lastInjectedTier = nudge.tier;
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

function applySingleRange(input: SingleRangeInput): SingleRangeOutcome {
  const warnings: string[] = [];
  const resolved = resolveBoundaries({
    startRef: input.spec.startRef,
    endRef: input.spec.endRef,
    messages: input.messages,
    state: input.state,
  });

  // Host checkpoint carriers (#335): a host that renders its own compression
  // summaries marks each carrier with `summaryOfBlockId`. A plain message-ref
  // range does not go through the block-distillation path, so folding a live
  // carrier would silently drop the previous distillation from the visible
  // context while the result reports nothing superseded. Keep carriers of
  // still-active blocks visible; stale carriers (block already consumed, or
  // unknown id) fold like ordinary messages. Block-ref boundaries deliberately
  // distill across checkpoints and keep folding carriers.
  const plainRange = resolved.boundaryKind !== "block";
  const liveCarrierIds = new Set<string>();
  if (plainRange) {
    for (const message of input.messages) {
      const carrierOf = message.summaryOfBlockId;
      if (carrierOf === undefined) continue;
      if (blockById(input.state, carrierOf)?.active) {
        liveCarrierIds.add(message.id);
      }
    }
  }
  const adjustedIds = applyPairBoundaryAdjustments(resolved, input.messages);
  const skippedCarriers = adjustedIds.filter((id) => liveCarrierIds.has(id));
  if (skippedCarriers.length > 0) {
    warnings.push(
      `Excluded ${skippedCarriers.length} checkpoint message(s) ${skippedCarriers.join(
        ", ",
      )} from the compression range — they carry the visible summary of still-active block(s), which a plain message-ref range does not supersede. The checkpoints stay visible; to fold them, reference the block ids (bN..bM) instead.`,
    );
  }
  const rangeMessageIds = adjustedIds.filter(
    (id) => !isSummaryMessageId(id) && !liveCarrierIds.has(id),
  );

  // Re-scan for nested blocks in the ADJUSTED range (tool-pair extension may
  // have pulled in messages that are anchors of existing blocks).
  if (rangeMessageIds.length > resolved.messageIds.length) {
    const indexByMessageId = new Map<string, number>();
    input.messages.forEach((m, i) => indexByMessageId.set(m.id, i));
    const adjustedStart =
      rangeMessageIds.length > 0
        ? (indexByMessageId.get(rangeMessageIds[0]!) ?? resolved.startIndex)
        : resolved.startIndex;
    const adjustedEnd =
      rangeMessageIds.length > 0
        ? (indexByMessageId.get(rangeMessageIds[rangeMessageIds.length - 1]!) ??
          resolved.endIndex)
        : resolved.endIndex;
    const nestedSeen = new Set(resolved.nestedBlockIds);
    for (const block of activeBlocks(input.state)) {
      if (nestedSeen.has(block.blockId)) continue;
      if (
        blockVisibleInRange(block, indexByMessageId, adjustedStart, adjustedEnd)
      ) {
        nestedSeen.add(block.blockId);
        resolved.nestedBlockIds.push(block.blockId);
      }
    }
  }

  const isBlockBoundary = resolved.boundaryKind === "block";
  const targetTier = resolveTargetTier(
    input.state,
    resolved.nestedBlockIds,
    isBlockBoundary,
  );
  const outputTier = isBlockBoundary
    ? (Math.min(3, targetTier + 1) as CompressionTier)
    : 1;

  const consumedBlockIds = resolved.nestedBlockIds.filter((id) => {
    const block = blockById(input.state, id);
    return block?.active && block.tier === targetTier;
  });

  const effectiveMessageIds = new Set<string>(rangeMessageIds);
  for (const consumedId of consumedBlockIds) {
    const consumed = blockById(input.state, consumedId);
    if (consumed) {
      for (const id of consumed.effectiveMessageIds)
        effectiveMessageIds.add(id);
    }
  }

  const directMessageIds = [...effectiveMessageIds].filter(
    (id) => !input.preExistingCoverage.has(id),
  );

  let filteredIds = filterProtectedToolMessages(
    directMessageIds,
    input.messages,
    input.config,
  );

  // filterProtectedToolMessages drops protected tool calls (and their paired
  // results) from the compressible set. They must also leave effectiveMessageIds,
  // otherwise the block would record them as covered and hide them from view.
  // (Bug 39: protected tool messages folded into a block.)
  if (filteredIds.length < directMessageIds.length) {
    const kept = new Set(filteredIds);
    for (const id of directMessageIds) {
      if (!kept.has(id)) effectiveMessageIds.delete(id);
    }
  }

  const mediaExcluded = directMessageIds.filter((id) => {
    const msg = input.messages.find((m) => m.id === id);
    return !!msg && hasMediaPayload(msg);
  });
  if (mediaExcluded.length > 0) {
    warnings.push(
      `Excluded ${mediaExcluded.length} message(s) carrying image/attachment payload(s) from compression range — their bytes are unrecoverable once folded (billion-context#1188); enable stripImages to release old ones.`,
    );
  }

  // SOFT PROTECTION: the recent-N / last-user-message zone is advisory-only at
  // compress time. Instead of failing the whole range when it brushes protected
  // messages, exclude those messages and proceed with the rest (so the model
  // isn't blocked when it picks a range that slightly overlaps the recent
  // window). If excluding them empties the range entirely AND there are no
  // consumed blocks to merge, we still fail — there is genuinely nothing to
  // compress. `protectedMessageIds` holds REF ids (mNNNNN) from
  // computeProtectedRefs; filteredIds holds RAW message ids, so convert via
  // state.messageRefs.byRaw before testing membership.
  const protectedRefs = input.protectedMessageIds;
  const hitProtectedRaw = protectedRefs
    ? filteredIds.filter((id) => {
        const ref = input.state.messageRefs.byRaw[id];
        return ref !== undefined && protectedRefs.has(ref);
      })
    : [];
  if (hitProtectedRaw.length > 0) {
    const protectedSet = new Set(hitProtectedRaw);
    filteredIds = filteredIds.filter((id) => !protectedSet.has(id));
    // Remove protected messages from effective coverage too, so they are NOT
    // hidden by the new block (they must stay fully visible).
    for (const id of hitProtectedRaw) effectiveMessageIds.delete(id);

    const hitRefs = hitProtectedRaw
      .map((id) => input.state.messageRefs.byRaw[id])
      .filter((v): v is string => typeof v === "string");

    if (filteredIds.length === 0 && consumedBlockIds.length === 0) {
      const recentN = input.config.preserveRecentMessages;
      throw new Error(
        `Range is entirely within the protected zone (the last ${recentN} messages and/or the most recent user message): ${hitRefs.join(
          ", ",
        )}. Adjust startId/endId to older messages.`,
      );
    }
    warnings.push(
      `Excluded ${hitProtectedRaw.length} protected message(s) ${hitRefs.join(
        ", ",
      )} from compression range (recent/last-user zone) — they stay visible outside the new block; do not target them in another compress call.`,
    );
  }

  // TURN-INTEGRITY GATE (#684): the protected carve above (and the protected
  // tool filter before it) remove individual messages AFTER
  // applyPairBoundaryAdjustments completed the range, which can split a turn.
  // The DIRECTIONAL invariant that strict-echo providers enforce: an assistant
  // tool-call message that survives the fold must keep its reasoning run
  // (DeepSeek thinking mode: "reasoning_content ... must be passed back").
  // The reverse split — reasoning + text kept while the call and result fold —
  // leaves a valid message stream and stays allowed (#564 depends on it), so
  // only turns whose KEPT side carries a tool-call while the FOLDED side
  // carries the reasoning are withdrawn, entirely (all members stay visible).
  // The same carve can also strip a call and its result onto opposite sides of
  // the fold. Either half alone is invalid — a visible call whose result folded
  // is an unanswered tool_call_id, a visible result whose call folded answers
  // nothing — so those pairs are withdrawn together, both halves staying
  // visible. Whole pairs may still fold while the turn's reasoning and text
  // stay visible (#564).
  //
  // Both invariants are re-checked to a fixed point inside
  // computeIntegrityWithdrawals: withdrawing a pair for the result half can
  // strand a turn whose reasoning still folds and whose call now stays visible.
  // The recommendation side calls the same helper, so it never advertises a
  // range this gate always empties.
  {
    const {
      withdrawn: withdrawIds,
      splitTurnCount,
      splitPairCount,
    } = computeIntegrityWithdrawals(input.messages, effectiveMessageIds);
    if (withdrawIds.size > 0) {
      for (const id of withdrawIds) effectiveMessageIds.delete(id);
      const beforeWithdraw = filteredIds.length;
      filteredIds = filteredIds.filter((id) => !withdrawIds.has(id));
      const splitDesc = [
        splitTurnCount > 0 ? `${splitTurnCount} turn(s)` : null,
        splitPairCount > 0
          ? `${splitPairCount} tool call/result pair(s)`
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" and ");
      if (filteredIds.length === 0 && consumedBlockIds.length === 0) {
        throw new Error(
          `Range would split ${splitDesc} at the protected-zone boundary: a visible tool-call must keep its reasoning run and its results (strict providers reject a rebuilt request that lost either). Shrink the range to end before the turn starts, or wait until the whole turn ages out of the protected zone.`,
        );
      }
      warnings.push(
        `Withdrawn ${beforeWithdraw - filteredIds.length} message(s) from compression range to keep ${splitDesc} intact (visible tool-call would lose its reasoning run or its results).`,
      );
    }
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
      applyRefolds({
        spec: input.spec,
        state: input.state,
        runId: input.runId,
        config: input.config,
        blockIds: decision.blocks.map((block) => block.blockId),
      });
      return {
        tokens: 0,
        warnings,
        refolded: decision.blocks.map((block) => block.blockId),
      };
    }
    const first = consumedBlockIds[0]!;
    const last = consumedBlockIds[consumedBlockIds.length - 1]!;
    throw new Error(
      `Range ${input.spec.startRef}..${input.spec.endRef} contains no new compressible messages — every message in it is already covered by active block(s) ${consumedBlockIds.join(
        ", ",
      )}. Nothing was compressed. To rewrite or merge those blocks, reference them by block ID (${first}..${last}); otherwise run acp_status and compress a range it reports as compressible.`,
    );
  }

  validateCompressionRange(input, filteredIds, consumedBlockIds.length);

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

  const blockId = allocateBlockId(input.state);
  const block: CompressionBlock = {
    blockId,
    runId: input.runId,
    tier: outputTier,
    topic: input.spec.topic,
    summary: input.spec.summary,
    directMessageIds: filteredIds,
    effectiveMessageIds: [...effectiveMessageIds],
    directBlockIds: [...consumedBlockIds],
    compressedTokens,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
    compressCallId: input.spec.compressCallId,
    startRef: input.spec.startRef,
    endRef: input.spec.endRef,
  };
  input.state.blocks.push(block);

  for (const consumedId of consumedBlockIds) {
    const consumed = blockById(input.state, consumedId);
    if (consumed) consumed.active = false;
  }

  return { tokens: compressedTokens, warnings };
}

function applyPairBoundaryAdjustments(
  resolved: {
    startIndex: number;
    endIndex: number;
    messageIds: string[];
    boundaryKind: string;
  },
  messages: CoreMessage[],
): string[] {
  if (resolved.boundaryKind === "block") {
    return resolved.messageIds;
  }
  // Compose tool-pair and reasoning-pair boundary adjustments to a fixpoint
  // (≤2 passes). Reasoning may pull in a tool-call whose result tool-pairs
  // then extends for; tool-pairs may pull in a tool-call whose preceding
  // reasoning is then drawn in. Both only ever WIDEN the range.
  let startIndex = resolved.startIndex;
  let endIndex = resolved.endIndex;
  for (let pass = 0; pass < 2; pass++) {
    const reasoningAdjusted = adjustBoundariesForReasoningPairs(
      startIndex,
      endIndex,
      messages,
    );
    const toolAdjusted = adjustBoundariesForToolPairs(
      reasoningAdjusted.startIndex,
      reasoningAdjusted.endIndex,
      messages,
    );
    const changed =
      toolAdjusted.startIndex !== startIndex ||
      toolAdjusted.endIndex !== endIndex;
    startIndex = toolAdjusted.startIndex;
    endIndex = toolAdjusted.endIndex;
    if (!changed) break;
  }
  if (startIndex === resolved.startIndex && endIndex === resolved.endIndex) {
    return resolved.messageIds;
  }
  const ids: string[] = [];
  for (let i = startIndex; i <= endIndex; i++) {
    const msg = messages[i];
    if (msg) ids.push(msg.id);
  }
  return ids;
}

function validateCompressionRange(
  input: SingleRangeInput,
  directMessageIds: string[],
  consumedBlockCount: number,
): void {
  const cfg = input.config.compress;
  validateSummaryLength(input.spec, cfg);

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

function filterProtectedToolMessages(
  directMessageIds: string[],
  messages: CoreMessage[],
  config: Config,
): string[] {
  // Protected tool calls (and their results, paired by toolCallId) stay in
  // visible context and are simply dropped from the compressible set. They are
  // NOT folded into the summary — the summary reflects what the author wrote,
  // nothing auto-appended.
  const protectedCallIds = new Set<string>();
  const removedIds = new Set<string>();
  const latest = collectLatestProtected(messages, config);
  for (const id of latest.callIds) protectedCallIds.add(id);
  for (const msg of messages) {
    if (isMessageProtected(msg, config) && msg.toolCallId) {
      protectedCallIds.add(msg.toolCallId);
    }
  }

  for (const id of directMessageIds) {
    const msg = messages.find((m) => m.id === id);
    if (!msg) continue;
    if (
      hasMediaPayload(msg) ||
      isMessageProtected(msg, config) ||
      isMessageLatestProtected(msg, latest)
    ) {
      removedIds.add(id);
      if (msg.toolCallId) protectedCallIds.add(msg.toolCallId);
    }
  }

  for (const id of directMessageIds) {
    if (removedIds.has(id)) continue;
    const msg = messages.find((m) => m.id === id);
    if (!msg) continue;
    if (
      msg.contentType === "tool-result" &&
      msg.toolCallId &&
      protectedCallIds.has(msg.toolCallId)
    ) {
      removedIds.add(id);
    }
  }

  return directMessageIds.filter((id) => !removedIds.has(id));
}

function resolveTargetTier(
  state: CompressionState,
  nestedBlockIds: string[],
  isBlockBoundary: boolean,
): CompressionTier {
  if (!isBlockBoundary) return 1;
  if (nestedBlockIds.length === 0) return 1;
  let minTier: CompressionTier = 3;
  for (const id of nestedBlockIds) {
    const block = blockById(state, id);
    if (block && block.tier < minTier) minTier = block.tier;
  }
  return minTier;
}

function collectCoverage(state: CompressionState): Set<string> {
  const coverage = new Set<string>();
  for (const block of activeBlocks(state)) {
    for (const id of block.effectiveMessageIds) coverage.add(id);
  }
  return coverage;
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
  // On the growth path a count-ready tier is NEVER short-circuited behind a
  // ready T1 (#509): slots alternate — T1 keeps first pick until it has gone
  // (nudge.lastInjectedTier), then the count-ready tier with the oldest
  // cadence stamp wins (never-shown = oldest; tie -> lower tier) — so an
  // explicitly lowered trigger is heard in sessions whose raw pending stays
  // high, and neither side starves even if the model keeps ignoring or
  // complying with one of them.
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
    // Explicit count-triggered candidates (#509): reachable on the growth path
    // REGARDLESS of t1Eff. The old T1-first short-circuit made an explicitly
    // lowered tier2Trigger/tier3Trigger dead in any session whose raw
    // compressible mass stayed >= nudgeGrowthTokens (billion-context-pi#628:
    // 22 T1 blocks, t1Eff 100K-400K, zero T2 nudges across the session).
    // Token-mass paths keep the legacy cascade below (implicit-vs-implicit,
    // #379); with the default triggers (1000/2000) this pool stays empty ->
    // byte-identical default behavior.
    const countCandidates: CompressionTier[] = [];
    if (config.tiers.enabled) {
      if (t2CountReady) {
        const lastShown = state.nudge.lastShownByTier[2] ?? 0;
        if (lastShown === 0 || tokenCount - lastShown >= growthFloor) {
          countCandidates.push(2);
        }
      }
      if (t3CountReady) {
        const lastShown = state.nudge.lastShownByTier[3] ?? 0;
        if (lastShown === 0 || tokenCount - lastShown >= growthFloor) {
          countCandidates.push(3);
        }
      }
    }
    if (countCandidates.length > 0) {
      // Slot rotation (#509): T1 keeps first pick until it has gone
      // (lastInjectedTier !== 1 — fresh state, or the previous slot was a
      // distill); then the slot hands to a count-ready tier, oldest cadence
      // stamp first (never-shown = oldest, tie -> lower tier), and back to T1
      // the next cycle. lastInjectedTier survives the compression-success
      // reset, so a model that keeps draining raw ranges cannot restart every
      // tie at T1 (the billion-context-pi#628 shape).
      const t1Ready = t1Eff >= tierThresholds[1];
      let chosen: CompressionTier;
      if (t1Ready && (state.nudge.lastInjectedTier ?? null) !== 1) {
        chosen = 1;
      } else {
        chosen = countCandidates[0]!;
        let chosenStamp = state.nudge.lastShownByTier[chosen] ?? 0;
        for (let i = 1; i < countCandidates.length; i++) {
          const stamp = state.nudge.lastShownByTier[countCandidates[i]!] ?? 0;
          if (stamp < chosenStamp) {
            chosenStamp = stamp;
            chosen = countCandidates[i]!;
          }
        }
      }
      injectedTier = chosen;
      injectedReason =
        chosen === 1
          ? `T1 effective ${t1Eff} >= ${tierThresholds[1]}, growth ${growthSinceReference}, usage ${Math.round(usage * 100)}%`
          : chosen === 2
            ? `T2 distill ready: ${t2Count} tier-1 blocks >= tier2Trigger ${config.tiers.tier2Trigger} (${t2Pen} tokens), usage ${Math.round(usage * 100)}%`
            : `T3 condense ready: ${t3Count} tier-2 blocks >= tier3Trigger ${config.tiers.tier3Trigger} (${t3Pen} tokens), usage ${Math.round(usage * 100)}%`;
    } else if (t1Eff >= tierThresholds[1]) {
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
