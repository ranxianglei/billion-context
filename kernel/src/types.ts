import type { MessageContentStore } from "./content-store.js";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageContentType =
  "text" | "tool-call" | "tool-result" | "reasoning";

export interface CoreMessage {
  id: string;
  role: MessageRole;
  contentType: MessageContentType;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  /** Host-projected token count of the reasoning/thinking payload that rides
   *  along with this message every request but is NOT part of `text` (e.g. Pi's
   *  `{type:"thinking"}` parts, which are resent each turn but invisible in the
   *  visible text projection). Metering-only: never rendered, truncated, or
   *  indexed. The host MUST attach it to exactly one core per original message
   *  (e.g. the first emitted core) — split tool-call cores sharing a base id
   *  must not repeat it or totals are multiplied. */
  thinkingTokens?: number;
  /** Host-declared checkpoint carrier (#335): this message is the host's own
   *  rendered summary of an earlier compression block (e.g. a host-managed
   *  surface that does not use the kernel's prune/rebuild pipeline). The value
   *  is the distilled block's id. Semantics: a plain message-ref range does
   *  NOT supersede that block, so the kernel keeps a carrier of a still-active
   *  block visible (excluded from folding); block-ref boundaries (bN..bM,
   *  T2/T3 distillation) fold it like any message. A carrier of an
   *  inactive/unknown block folds normally. Reserved-prefix ids
   *  (`acp_summary_*`) stay kernel-internal and never need this marker. */
  summaryOfBlockId?: string;
}

export type CompressionTier = 1 | 2 | 3;

export type BlockGeneration = "young" | "old";

export interface CompressionBlock {
  blockId: string;
  runId: string;
  tier: CompressionTier;
  topic?: string;
  summary: string;
  directMessageIds: string[];
  effectiveMessageIds: string[];
  directBlockIds: string[];
  /** Token count of the original messages compressed by this block (for accurate reporting). */
  compressedTokens: number;
  createdAt: number;
  survivedCount: number;
  generation: BlockGeneration;
  active: boolean;
  /** Host-set: the user explicitly decompressed (expanded) this block, so its
   *  deactivated state is intentional and must survive syncBlocks re-activation.
   *  Absent/false for blocks deactivated by other means (orphan GC, tier
   *  distillation, consumed-by-parent) — those keep the legacy resurrection
   *  behavior. */
  expanded?: boolean;
  /** Refold-in-place marker (#398): the block's content was restored into the
   *  live context by an inline decompress, so its folded state is temporary.
   *  compress() updates such a block IN PLACE (same id, replaced summary, flag
   *  cleared) when a request spans its full content and every active ancestor
   *  is likewise restored — instead of rejecting it as "already compressed".
   *  Optional: old persisted states lack the field, which reads as false. */
  restoredInline?: boolean;
  durationMs?: number;
  compressCallId?: string;
  startRef?: string;
  endRef?: string;
}

/** A compression block's current ref span, pre-resolved for display. */
export interface BlockSpan {
  blockId: string;
  tier: CompressionTier;
  startRef: string;
  endRef: string;
}

export interface MessageRefMap {
  byRaw: Record<string, string>;
  byRef: Record<string, string>;
}

export interface NudgeState {
  lastPerMessageNudgeTokens: number;
  lastNudgeShownTokens: number;
  baselineTokens: number;
  anchors: Record<string, unknown>;
  /** Per-tier cadence baseline: the tokenCount at which that tier last had a
   *  nudge injected. A tier is allowed to inject again only once
   *  `tokenCount - lastShownByTier[tier] >= growthFloor`, independent of other
   *  tiers. Using a record (not N named fields) so adding tier 4+ needs no
   *  schema change. */
  lastShownByTier: Record<number, number>;
  /** Last tier that received a nudge slot (growth or pressure path). Unlike
   *  lastShownByTier this is NOT cleared by a successful applyCompression: it
   *  is the rotation memory that keeps an explicitly configured
   *  tier2Trigger/tier3Trigger alternating with T1 instead of being starved by
   *  a persistently high T1 pending (#509). Optional for pre-#509 persisted
   *  states (absent = null = legacy T1-first). */
  lastInjectedTier?: CompressionTier | null;
}

export interface CompressionStats {
  tokensCompressed: number;
  compressionCount: number;
  /** Cumulative tokens reclaimed by absorb (instant tool-result hiding). Optional for pre-absorb persisted states. */
  absorbedTokens?: number;
  /** Cumulative images downscaled at arrival (image pre-compression, #353). Optional for pre-feature persisted states. */
  imagesShrunk?: number;
  /** Cumulative decoded-byte savings from image downsampling. */
  imageBytesSaved?: number;
  /** Cumulative estimated-token savings from image downsampling. */
  imageTokensSaved?: number;
  /** Cumulative messages stored in the CCR content store. Optional for pre-CCR persisted states. */
  storedCount?: number;
  /** Cumulative successful acp_retrieve calls. Optional for pre-CCR persisted states. */
  retrievalCount?: number;
}

/** One instant tool-result absorption: the original tool-call + tool-result
 *  pair is hidden from view once recorded; the model's absorb call (carrying
 *  the distilled summary) remains as the durable record. */
export interface AbsorbRecord {
  toolCallId: string;
  callMessageId: string;
  resultMessageId: string;
  absorbCallId?: string;
  summary: string;
  tokensReclaimed: number;
  createdAt: number;
}

export interface AbsorbConfig {
  enabled: boolean;
  /** Model-facing absorb tool name (adapters may rename, e.g. acp_absorb). */
  toolName: string;
  /** Only tool results >= this many tokens get the forced absorb prompt. 0 = all. */
  minToolTokens: number;
  /** Only prompt when context usage >= this fraction of modelContextLimit. 0 = size gate alone. */
  contextThresholdPct: number;
  /** Tool-name patterns (glob suffix allowed) never absorbable, independent of protectedTools. */
  excludeTools: string[];
}

/** Emitted when the session's irreducible floor (system prompt + block
 *  summaries + protected zones + small uncompressible tail) exceeds
 *  modelContextLimit: usage stayed at/above truncate.threshold for N
 *  consecutive events while no tier could reclaim the benefit floor AND
 *  emergency truncation saved nothing (#300). Hosts surface this ONCE (UI +
 *  one-time model-side message) instead of repeating the emergency nudge
 *  forever — the kernel keeps emitting it every event while the condition
 *  holds; deduplication is the host's job. */
export interface TerminalEscapeSignal {
  /** Model/host-facing guidance text. */
  message: string;
  usage: number;
  tokenCount: number;
  modelContextLimit: number;
  /** Consecutive events the terminal condition has held. */
  stuckEvents: number;
}

/** A persistent reminder recorded via the acp_rule tool (see rules.ts).
 *  Injected into the system prompt every turn by the adapter and hard-protected
 *  from compression. Ids are never re-issued (see nextRuleId). */
export interface RuleRecord {
  id: string;
  text: string;
}

/** Persistent-rule ("acp_rule") feature settings (see rules.ts). Absent or
 *  enabled !== true = feature off — the adapter never injects the tool; kernel
 *  protection is unconditional but side-effect-free without acp_rule messages.
 *  Deviates from kernel#282's original "no Config field" stance: hosts gate the
 *  feature and carry their limit overrides through the resolved Config
 *  (billion-context#750 reads config.rules.enabled + resolveRuleLimits). */
export interface RulesConfig {
  enabled?: boolean;
  maxRules?: number;
  maxRuleChars?: number;
}

export interface CrushStrategyOverride {
  /** Set false to disable this strategy even when crush is enabled. Default true. */
  enabled?: boolean;
  /** Tool-name patterns (glob suffix allowed) this strategy skips. */
  excludeTools?: string[];
}

/** Deterministic tool-result compression ("crush") — tier 1 of the absorb
 *  gate (see crush.ts). Absent/disabled = feature off. */
export interface CrushConfig {
  enabled: boolean;
  /** Minimum relative size reduction to accept a crushed result. In (0, 1]. */
  minReduction: number;
  /** Per-strategy toggles/exclusions keyed by plugin id (json-fold, code-trim, log-select, ...). */
  strategies?: Record<string, CrushStrategyOverride>;
}

export type ImageFormat = "webp" | "jpeg" | "png";

/** How upstream bills this image's payload: pixel-tile model (Anthropic / OpenAI high-detail) or raw byte counting (some relays). */
export type ImageBillingMode = "pixels" | "bytes";

/** Image pre-compression routing/downsample + image_full restore (#353). Hosts perform the three-level (global → provider → model) sub-field merge exactly like absorb. Default off: disabled ⇒ byte-identical pass-through. */
export interface ImageCompressionConfig {
  enabled: boolean;
  /** Only route images whose token estimate >= this. Default 512. */
  minTokens?: number;
  /** Longest side (px) of the downsample recipe. Default 1280. */
  maxDimension?: number;
  /** Lossy encode quality (1-100) of the downsample recipe. Default 80. */
  quality?: number;
  /** Encode format of the downsample recipe. Default "webp". */
  format?: ImageFormat;
}

/** One arrival-time image downsample, reported by the host after executing the kernel's recipe. Drives image_full validation and session stats. */
export interface ImageShrinkRecord {
  ref: string;
  rawMessageId: string;
  mediaType: string;
  format: ImageFormat;
  /** Decoded byte length of the original payload. */
  originalBytes: number;
  /** Decoded byte length after encoding. */
  shrunkBytes: number;
  /** Kernel token estimate of the original payload. */
  tokensBefore: number;
  /** Kernel token estimate of the shrunk payload. */
  tokensAfter: number;
  createdAt: number;
}

export interface CcrConfig {
  enabled: boolean;
  /** Model-facing retrieve tool name (adapters may rename, e.g. acp_retrieve). */
  toolName: string;
  /** Only tool results >= this many tokens are stored + replaced. 0 = all. */
  minToolTokens: number;
  /** Tool-name patterns (glob suffix allowed) never CCR-stored, independent of protectedTools. */
  excludeTools: string[];
  /** Max characters for the placeholder's head/command preview. */
  maxHeadChars: number;
  /** Retrieved originals below this many tokens are inlined into the
   *  acp_retrieve tool result; at/above it they are exported to a file under
   *  the host-provided export dir (pointer rides the tool result). Default
   *  4000 (RETRIEVE_INLINE_TOKENS_DEFAULT). */
  retrieveInlineTokens?: number;
}

export interface CompressionState {
  blocks: CompressionBlock[];
  messageRefs: MessageRefMap;
  /** First-render token count per message ref (mNNNNN). Written once when a
   *  message is first rendered, then read forever — stable across density
   *  recalibration so rendered <acp tokens> tags do not churn and bust the
   *  provider prefix cache. Keyed by ref (not raw id): refs survive restarts
   *  and omp live-N raw-id replacement. */
  tokenSnapshot: Record<string, number>;
  nudge: NudgeState;
  stats: CompressionStats;
  /** Instant tool-result absorption records. Optional: pre-absorb persisted states lack it. */
  absorbed?: AbsorbRecord[];
  /** Consecutive processTurn events at/above truncate.threshold where no tier
   *  could reclaim the benefit floor AND emergency truncation saved nothing
   *  (#300). Drives the terminalEscape signal; reset by usage dropping below
   *  threshold, viable compression appearing, truncation savings, or a
   *  successful applyCompression. Optional for pre-existing persisted states. */
  terminalStreak?: number;
  /** Persistent reminders recorded via acp_rule (see rules.ts). Optional:
   *  pre-rules persisted states lack it. */
  rules?: RuleRecord[];
  /** Monotonic rule-id counter (`rule${n}`). Never reset by remove/clear so an
   *  issued id is never re-issued with different content. Optional: defaults
   *  to 1 when absent on older persisted states. */
  nextRuleId?: number;
  /** image_full sticky-restore: refs whose images were restored to full resolution for the rest of the session. MUST be cleared on compaction reset (resetImageFullState) — refs are re-issued after state reset, so stale entries would misattribute. Optional: pre-feature persisted states lack it. */
  imageFullRestored?: string[];
  /** Arrival-time downsample records (#353). Optional: pre-feature persisted states lack it. */
  imageShrinks?: ImageShrinkRecord[];
  /** Padded refs (mNNNNN) of HIDDEN orphan compress call/result messages — the
   *  orphans beyond the keep-last-N window that hide-consumed removed from the
   *  visible view this turn. Written every processTurn by the hide-compress-calls
   *  node so boundary resolution can snap a range endpoint that lands on such a
   *  hidden-but-intact artifact to its adjacent visible message instead of
   *  dead-ending the whole range (#396). A drifted/dangling ref (#387) is NOT in
   *  this set and keeps the clear "cannot be anchored" error. Optional for
   *  pre-feature persisted states. */
  hiddenOrphanRefs?: string[];
  /** Padded refs (mNNNNN) proven UNREACHABLE (#2362): known in messageRefs but
   *  backing no visible or folded message — the client rewrote or dropped those
   *  messages (an edit reissues a new ref; a host-native compaction or bulk
   *  history rewrite drops them outright), so no range citing them can ever
   *  compress. Marked by applyCompression when a requested endpoint dangles;
   *  a tombstone lifts automatically once the ref's message reappears in an
   *  inbound view (processTurn / applyCompression). The refs themselves are
   *  NEVER removed from messageRefs (Kernel Contract: ids are never re-issued).
   *  Optional: pre-feature persisted states lack it. */
  deadRefs?: string[];
  /** Exact inbound ids of the PREVIOUS processTurn pass (pre-pipeline,
   * converter-derived). Continuity signal for reconcile-live-ids (#462): an
   * id that is covered by a fold but was present in the prior pass is the
   * folded original's RESEND (stateless hosts resend full history every
   * turn) and must keep its id so prune drops it; the same id absent from
   * the prior pass is a genuinely new identical instance and gets renumbered
   * (#1476). Optional: pre-feature persisted states lack it — one pass of
   * 0.0.95 semantics (renumber nothing), self-heals once written. Written
   * every processTurn. */
  lastPassIds?: string[];
  nextBlockId: number;
  nextRunId: number;
}

export interface TierConfig {
  enabled: boolean;
  /** Distill to tier 2 once the count of ACTIVE tier-1 blocks reaches this.
   *  Default 1000 (#379: block count is not a need signal, so the path
   *  defaults OFF; lowering it explicitly opts back in, and a count-ready
   *  tier then alternates slots with a ready T1 on the growth path instead
   *  of being short-circuited behind it — #509). Independent of raw-message
   *  pending: summaries are ~10:1 condensed, so a token-mass comparison
   *  against T1 pending would starve. */
  tier2Trigger: number;
  /** Condense to tier 3 once the count of ACTIVE tier-2 blocks reaches this.
   *  Default 2000 (#379, see tier2Trigger). */
  tier3Trigger: number;
}

export interface NudgeConfig {
  maxContextLimitPct: number;
  minContextLimitPct: number;
  frequency: number;
  iterationThreshold: number;
  force: "soft" | "strong";
  growthRatio: number;
  /** Adaptive growth threshold = modelContextLimit × this ratio, clamped to [growthFloor, growthCap]. Default 0.05 (5%). */
  growthFloor: number;
  /** Upper clamp for adaptive growth threshold. Default 50000. */
  growthCap: number;
  /** Anti-thrashing: suppress nudge unless growth ≥ max(minGrowthFloor, minGrowthRatio × growthTokens). Default 5000. */
  minGrowthFloor: number;
  /** Ratio for growth floor: max(minGrowthFloor, minGrowthRatio × growthTokens). Default 0.45. */
  minGrowthRatio: number;
  /** Emergency override: always nudge when usage ≥ this fraction. Default 0.98 (98%). */
  emergencyThresholdPct: number;
  /** Growth multiplier for the tier-2 trigger: T2 distillation fires when T2
   *  pending ≥ nudgeGrowthTokens × this multiplier AND T2 > T1 effective.
   *  Default 1.5. */
  tier2GrowthMultiplier: number;
  /** Per-tier growth thresholds in tokens (#2376): independent trigger sizes
   *  for the T1/T2/T3 token-mass paths. Each UNSET tier falls back to the
   *  derived default (T1 = resolved nudgeGrowthTokens, T2/T3 =
   *  nudgeGrowthTokens × tier2GrowthMultiplier), so an absent or empty object
   *  is fully backward compatible. Only the token-mass trigger comparisons
   *  change — count triggers, cadence floor, first-sight mass bypass and the
   *  pressure/emergency routing keep their existing bases. */
  tierGrowthTokens?: { t1?: number; t2?: number; t3?: number };
  /** Minimum tokens the pressure band (usage ≥ maxContextLimitPct /
   *  emergencyThresholdPct) must be able to reclaim before injecting. Below
   *  this, the rewrite reclaims almost nothing while high usage keeps the
   *  band hot — each "success" resets the baselines and re-injects next turn
   *  (zero-yield loop, #198). Default: max(5000, round(modelContextLimit ×
   *  0.01)). Set 0 to restore the legacy any-pending behavior. */
  minPressureBenefitTokens?: number;
}

export interface TruncateConfig {
  // Context-usage fraction that triggers the emergency tool-output truncation
  // node (the LAST safety valve of the pipeline). 1.0 = 100% of the model
  // context limit. Removed GC age-deactivation/summary-truncation are gone;
  // this is the only "context near full" fallback that remains.
  threshold: number;
  /** Consecutive processTurn events at/above threshold with no viable
   *  compression and zero truncation savings before terminalEscape fires
   *  (#300). Default 3. Set 0 to disable the signal. */
  terminalEscapeAfter?: number;
}

export interface CompressValidationConfig {
  /** Minimum total chars of original messages in a range to allow compression. 0 = disabled. Default 5000. */
  minCompressRange: number;
  /** Maximum summary length (chars). Summary exceeding this is rejected unless summaryMaxChars override is used. 0 = disabled. Default 20000. */
  maxSummaryLength: number;
  /** Minimum summary length (chars). Summary shorter than this is rejected. 0 = disabled. Default 50. */
  minSummaryLength: number;
}

export interface Config {
  tiers: TierConfig;
  nudge: NudgeConfig;
  // young→old promotion after N survivals (drives merge-blocks). Age-based
  // deactivation is GONE — blocks are never dropped for being old.
  promotionThreshold: number;
  truncate: TruncateConfig;
  compress: CompressValidationConfig;
  protectedTools: string[];
  isToolProtected?: (toolName: string, toolInputText?: string) => boolean;
  /** Tool-name patterns (glob suffix allowed) protected in their LATEST
   *  instance only: the newest matching tool-call and its paired tool-result
   *  are protected from compression; older instances remain compressible. For
   *  cumulative-snapshot tools (e.g. todo_list) where only the newest result
   *  is the source of truth. */
  protectedLatestTools?: string[];
  /** Tool-name patterns (glob suffix allowed) excluded from the soft-protected
   *  recent zone (preserveRecentMessages / preserveRecentTokens / last user
   *  message). Matching tool calls/results stay compressible even while they
   *  sit in the recent tail, so large spent results (file bodies, command
   *  output) can be reclaimed immediately instead of aging out of the window.
   *  `undefined` = built-in default list (decompress/search_context/read/bash);
   *  an explicit array — including `[]` — replaces the default verbatim
   *  (`[]` excludes nothing: every recent tool result keeps its zone
   *  protection while in the window). */
  neverPreserveRecentTools?: string[];
  /** Tool-name patterns (glob suffix allowed) REMOVED from the effective
   *  never-preserve list — the positive-facing knob: "protect these tools in
   *  the recent zone" without restating the whole built-in list. The common
   *  remedy for the batch-read fold→re-read loop (upstream billion-context
   *  #1198/#1277) is `["read"]`: freshly-read files then age out of the
   *  window normally instead of folding immediately. Effective exclusion =
   *  `(neverPreserveRecentTools ?? built-in) minus preserveRecentTools`;
   *  unset or empty = no subtraction (pure no-op). */
  preserveRecentTools?: string[];
  preserveRecentMessages: number;
  preserveRecentTokens: number;
  modelContextLimit: number;
  /** Instant tool-result absorption (see absorb.ts). Absent/disabled = feature off. */
  absorb?: AbsorbConfig;
  /** Persistent acp_rule reminders (see rules.ts). Absent/disabled = feature off. */
  rules?: RulesConfig;
  /** Deterministic tool-result compression, tier 1 of the absorb gate (see crush.ts). Requires absorb enabled. */
  crush?: CrushConfig;
  /** Image pre-compression routing/downsample + image_full restore (see image-compress.ts). Absent/disabled = feature off. */
  imageCompression?: ImageCompressionConfig;
  /** Lossless content-cached retrieval for oversized tool results (see ccr.ts). Absent/disabled = feature off. */
  ccr?: CcrConfig;
  messageFilters?: import("./filter/types.js").MessageFiltersConfig;
}

export type CompressMode = "range" | "message";

export interface CompressRangeSpec {
  startRef: string;
  endRef: string;
  summary: string;
  topic?: string;
  compressCallId?: string;
  /** Per-call override for max summary length. Model can set this when content needs more detail. */
  summaryMaxChars?: number;
}

export interface CompressCall {
  mode: CompressMode;
  ranges: CompressRangeSpec[];
}

export interface CompressibleRange {
  startRef: string;
  endRef: string;
  count: number;
  tokens: number;
  /** Range size in characters (sum of message text lengths). The apply-side
   *  minCompressRange gate counts raw `msg.text.length`, so recommend-side
   *  gates must use this field — NOT `tokens` — or the two sides disagree
   *  whenever a host injects a tokenizer where tokens != chars/4 (e.g. a
   *  CJK-aware estimator: 1 token per char, making `tokens*4` a ~4x
   *  overestimate). Always set on ranges produced by buildCompressibleRanges
   *  / mergeRangesToThreshold; hand-built ranges without it fall back to the
   *  historical tokens*4 estimate for backwards compat. */
  chars?: number;
  toolPct: number;
  textPct: number;
  dangerous?: boolean;
  /** Count of user-role messages inside this range (set by
   *  buildCompressibleRanges / mergeRangesToThreshold). Summaries must capture
   *  every user request, so the count tells the model whether it needs a
   *  per-message listing before compressing. Absent on hand-built ranges. */
  userMsgs?: number;
  /** Messages-array index of this range's first message (buildCompressibleRanges
   *  / mergeBatch). formatRanges orders/merges by POSITION via these, never by
   *  ref number — ref order can be non-monotonic vs array order (subagent
   *  interleaving, mid-array summary nodes), and ref-number merging then yields
   *  endpoints resolveBoundaries collapses to a tiny slice (#887). Absent on
   *  hand-built ranges → formatRanges falls back to ref-number ordering. */
  startIndex?: number;
  /** Messages-array index of this range's last message. */
  endIndex?: number;
}

export interface ProtectedRange {
  startRef: string;
  endRef: string;
  count: number;
  tokens: number;
  tools: string[];
  /** Messages-array index of first message (see CompressibleRange.startIndex). */
  startIndex?: number;
  /** Messages-array index of last message. */
  endIndex?: number;
}

export interface ContextRanges {
  compressible: CompressibleRange[];
  protected: ProtectedRange[];
}

export interface Recommendation {
  contextRanges: ContextRanges;
  recommendedRanges: CompressibleRange[];
  nothingToCompress: boolean;
}

export interface ContextBreakdown {
  system: number;
  tool: number;
  summaries: number;
  code: number;
  text: number;
  total: number;
  growth: number;
}

export interface NudgeDecision {
  shouldInject: boolean;
  reason: string;
  compressibleRanges: CompressibleRange[];
  protectedRanges?: ProtectedRange[];
  /** Active blocks with their current ref spans (creation order), pre-resolved
   *  by decideNudge so renderers need no raw state. The nudge lists what to
   *  compress; this ledger tells where existing blocks already stand, so a
   *  remembered block boundary can be cross-checked without an acp_status
   *  round-trip (#251). */
  activeBlockSpans?: BlockSpan[];
  /** When `tier` is set, the active lower-tier blocks that should be distilled
   *  into a single higher-tier block. Empty when no tier nudge. */
  tierTargetBlocks?: CompressionBlock[];
  contextUsage: number;
  tier: CompressionTier | null;
  breakdown: NudgeBreakdown;
  contextBreakdown?: ContextBreakdown;
}

/** Numeric debug/reason fields exposed alongside a nudge decision. Keeping
 *  these typed (rather than a bare Record<string, number>) means adapters
 *  that read e.g. emergencyOverride get a compile-time signal if a key is
 *  renamed or removed. */
export interface NudgeBreakdown {
  usage: number;
  growth: number;
  growthReference: number;
  effectiveThreshold: number;
  nudgeGrowthTokens: number;
  growthFloor: number;
  hasPendingNudge: number;
  overLimit: number;
  emergencyOverride: number;
  pendingT1: number;
  pendingT2: number;
  pendingT3: number;
  /** Max pending across all tiers — compared against minPressureBenefit by the
   *  emergency-truncate node to detect a terminal floor (#300). */
  maxPending: number;
  [key: string]: number;
}

export interface ResolvedBoundary {
  startIndex: number;
  endIndex: number;
  protectedGaps: number[];
}

export interface ApplyCompressionResult {
  state: CompressionState;
  result: {
    blocksCreated: number;
    tokensCompressed: number;
    errors: string[];
    /** Non-fatal notices (e.g. protected messages excluded from a range).
     *  The compression still succeeded; the host should surface these to the
     *  model so it understands what was skipped. */
    warnings: string[];
    /** Kernel-side rewrites of the model's input (e.g. reversed refs
     *  normalized to ascending order), for hosts to render into the tool
     *  result so the model knows its input was changed (#310). Omitted when
     *  empty. */
    notes?: string[];
  };
}

export interface ProcessTurnResult {
  messages: CoreMessage[];
  state: CompressionState;
  nudge?: NudgeDecision;
  /** Terminal floor detected (#300): compression and truncation are both
   *  exhausted while usage stays at/above truncate.threshold. Emitted every
   *  event while the condition holds; hosts surface it once. */
  terminalEscape?: TerminalEscapeSignal;
  /** Set when emergency truncation ran at/above its threshold but reclaimed
   *  nothing — hosts should warn-log this (it was silent before, #300). */
  truncationSkipped?: string;
  /** Per-session content store after this turn (pass back as input.contentStore
   *  next turn and persist via the host's own mechanism). Always present;
   *  empty until CCR stores something. */
  contentStore: MessageContentStore;
}

export interface StatusReport {
  contextUsage: number;
  tokenCount: number;
  modelContextLimit: number;
  activeBlocks: number;
  totalBlocks: number;
  tokensCompressed: number;
  breakdown: Record<string, number>;
}
