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
  /** #4316 layer 3 — server-ledger numbering. Set by store-served views
   *  (snapshot-render prefix rows, incremental canonical rows): the unified
   *  transcript's (session, seq) for this message, assigned once at ingest
   *  and never re-minted. When present, assignRefs issues the ref as the
   *  direct display of this number, so client-side byte churn (model-switch
   *  re-stamps, image re-encodes) cannot renumber the model's citations.
   *  Callers must guarantee per-session uniqueness; a collision falls back
   *  to the counter path for the loser. Not serialized into wire payloads —
   *  it rides CoreMessage sidecars and the persisted store rows verbatim. */
  ledgerSeq?: number;
}

export type CompressionTier = 1 | 2 | 3;

export type BlockGeneration = "young" | "old";

/** One #3939 ③ emergency-truncation latch entry: the post-clip text of a
 *  message (keyed by its padded ref). See CompressionState.emergencyTruncateLatch. */
export interface EmergencyTruncateLatchEntry {
  ref: string;
  text: string;
}

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
  /** #4316 layer 3: the block's coverage as a unified-ledger seq interval
   *  [startSeq, endSeq] (inclusive, 1-based display space — same space as
   *  CoreMessage.ledgerSeq). Recorded ONLY when the fold can prove the claim
   *  exact: every direct folded message carried a ledgerSeq stamp, every
   *  consumed block carried its own bounds, and the union of those segments
   *  is one contiguous span (a hole means min/max would swallow uncovered
   *  messages, so no bounds are recorded — the id path stays authoritative).
   *  Undefined = unstamped traffic or provably-loose coverage; never guessed. */
  startSeq?: number;
  endSeq?: number;
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
}

export interface CompressionStats {
  tokensCompressed: number;
  compressionCount: number;
  /** Cumulative tokens reclaimed by absorb (instant tool-result hiding). Optional for pre-absorb persisted states. */
  absorbedTokens?: number;
  /** Cumulative messages stored in the CCR content store. Optional for pre-CCR persisted states. */
  storedCount?: number;
  /** Cumulative successful acp_retrieve calls. Optional for pre-CCR persisted states. */
  retrievalCount?: number;
}

/** View-latch entry shape (#3939 ⑤) — see CompressionState.viewLatches. */
export interface ViewLatchEntry {
  text: string | null;
  hidden?: boolean;
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
  /** #3402: when true, only image-bearing tool results are candidates, and they bypass minToolTokens. */
  mediaOnly?: boolean;
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
  /** Padded refs (mNNNNN) of HIDDEN orphan compress call/result messages — the
   *  orphans beyond the keep-last-N window that hide-consumed removed from the
   *  visible view this turn. Written every processTurn by the hide-compress-calls
   *  node so boundary resolution can snap a range endpoint that lands on such a
   *  hidden-but-intact artifact to its adjacent visible message instead of
   *  dead-ending the whole range (#396). A drifted/dangling ref (#387) is NOT in
   *  this set and keeps the clear "cannot be anchored" error. Optional for
   *  pre-feature persisted states. */
  hiddenOrphanRefs?: string[];
  /** Persistent, MONOTONIC set of orphan compress-call ids permanently swept
   *  (#3769). An orphan (a failed compress call/result with no matching block)
   *  is only removed from the visible view when a REAL fold gives a cache-safe
   *  place to do it: the hide node sweeps orphans at/after the fold's earliest
   *  start ref onto this set, and they stay hidden forever — across the next
   *  turn, repeated processTurn calls, restarts and upgrades. Monotonic (never
   *  shrinks) so a previously-hidden record can never reappear once the client
   *  resends full history. Replaces the old keep-last-two rotation, which hid
   *  the oldest failure on EVERY quiet turn and moved the cached prefix
   *  breakpoint forward for no new fold. Optional: pre-feature persisted states
   *  lack it (nothing was permanently hidden under the old per-pass rule). */
  sweptOrphanCallIds?: string[];
  /** Numeric part (mNNNNN -> NNNNN) of the EARLIEST start ref of the most
   *  recent fold that has not yet been consumed by an orphan sweep (#3769).
   *  Written by applyCompression when it creates >=1 block (min over the newly
   *  created blocks' startRef); consumed + cleared by the hide-compress-calls
   *  node on the next processTurn, which then sweeps orphans with ref >= this
   *  value (orphans before it sit in the still-cached prefix and stay visible).
   *  Carries the position so the sweep is cache-neutral: it only removes records
   *  the fold already invalidated. Optional: absent until the first post-fix fold. */
  pendingOrphanSweepMinRef?: number;
  /** Emergency-truncation latch (#3939 ③/#3691): the clipped texts (post-clip
   *  bytes, keyed by padded ref) of messages clipped by the emergency-truncate
   *  node. The watermark decision is made ONCE — replaying these clips on every
   *  later turn keeps the outbound bytes stable when the token estimate
   *  fluctuates across the threshold (the #3691 full↔clipped oscillation was a
   *  mid-history rewrite on every request). Entries retire when their message
   * leaves the resent view (folded/edited-away) and the whole latch resets on
   *  the next successful fold (applyCompression) — after a fold the watermark
   *  re-evaluates from scratch. Optional: pre-feature states have none (the
   *  pre-latch node clipped from scratch each turn). */
  /** #3939 ③: emergency truncation latch entries (see above). Optional:
     pre-existing persisted states lack it. */
  emergencyTruncateLatch?: EmergencyTruncateLatchEntry[];
  /** #4316 layer 3 PR3/3: refs have been aligned onto the unified ledger
     (ref = store row seq + 1) exactly once. Set by restampRefsToLedger;
     assignRefs' stamp path keeps new arrivals aligned from then on. */
  refLedgerAligned?: boolean;
  /** Ref-migration render deferral (#3939 ②/#3805): padded refs minted by the
   *  BLOCKED→numeric migration (assignRefs, #2607). The number exists (citable
   *  via decompress({ imageRef }) bookkeeping) but the carrier message keeps
   *  its pre-migration, UNTAGGED bytes until the next successful fold —
   *  stamping the <acp> tag on the migration turn would rewrite an old
   *  message mid-history on an otherwise quiet turn (a prefix-cache breaker:
   *  #3805 durable carriers flipping bytes with no fold in sight). Cleared by
   *  applyCompression on fold success; entries are inert once their message
   *  leaves the view (ids are never re-issued). Optional: absent until the
   *  first migration. */
  renderDeferredRefs?: string[];
  /** Fold-gated view latch (#3939 ⑤): post-transform view bytes per padded
   *  ref, replayed VERBATIM on quiet turns. The opt-in mid-history rewriters
   *  (absorb-hide, crush, filter keepLastOnly) re-derive their output every
   *  pass from state/context (absorb records growing, crush responding to
   *  token pressure, keep-last-only demotions as new occurrences arrive) —
   *  without a latch each change flips OLD message bytes on an otherwise
   *  quiet turn (the #3805 prefix-cache breaker class). Structural, not
   *  per-feature: every transform output is latched at first application and
   *  replays until the next successful fold (applyCompression resets the
   *  whole map — the refresh rides the fold's own history rewrite); new or
   *  edited messages (new ref) latch fresh at their arrival boundary. ccr
   *  needs no latch (replace-once-at-arrival, byte-stable by design #1460).
   *  Entry: text=null = passthrough (source bytes stand); text=string =
   *  transformed bytes; hidden=true = dropped from the view. Optional:
   *  absent until the first latched transform. */
  viewLatches?: Record<string, ViewLatchEntry>;
  /** #3939 ⑤: digest of the transform-relevant config slices (absorb/crush/
   *  message-filters). A config edit is a user action boundary — matching
   *  ①'s fold/refold/user-action rule, the latch releases when the digest
   *  changes so enabling a transform applies on the next turn (one rewrite
   *  riding the config change), never on a quiet turn. */
  viewLatchConfigDigest?: string;
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
   *  Default 5. Independent of raw-message pending: summaries are ~10:1
   *  condensed, so a token-mass comparison against T1 pending would starve. */
  tier2Trigger: number;
  /** Condense to tier 3 once the count of ACTIVE tier-2 blocks reaches this.
   *  Default 10. */
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
  /** Host-declared set of tool NAMES that count as a `compress` call for the
   *  consumed-call lifecycle pass (hideConsumedCompressCalls). The kernel
   *  hardcodes only the canonical bare name ("compress"); hosts that expose
   *  compression under a dialect name (e.g. MCP's "mcp__bili__compress")
   *  inject a predicate recognizing both so those calls get the SAME inactive
   *  cleanup + live-range arg reduction as the bare form instead of bypassing
   *  it (billion-context#2970). Unset = bare-name only (byte-identical to
   *  before). Must be pure and cheap: runs once per message per pass. */
  isCompressTool?: (toolName: string) => boolean;
  /** Host-declared message-level hard protection (billion-context#2419):
   *  when set, ANY message for which the predicate returns true is excluded
   *  from compression exactly like a protectedTools hit — BLOCKED ref in
   *  assignRefs (never advertised, never foldable-by-ref) AND dropped from
   *  effectiveMessageIds in applyCompression (stays fully visible; the
   *  summary reflects only what was actually folded). Applies to every
   *  content type; the tool-exchange checks below run additionally, not
   *  instead. Use for host-injected DURABLE STATE carried as ordinary
   *  conversation messages — e.g. dsh's skill catalog, which DSH
   *  fingerprint-gates (sha256 over name+description) and never resends
   *  while unchanged, so folding it loses skill visibility permanently.
   *  Unset = byte-identical behavior to before (only tool exchanges and
   *  media payloads are protectable). Must be pure and cheap: it runs once
   *  per message per turn. */
  isMessageProtected?: (msg: CoreMessage) => boolean;
  /** Host-projected VIRTUAL TOOL PATH for messages that are not tool
   *  exchanges (plain-text durable-state carriers, billion-context#2446
   *  family): when set, the host classifier maps a message to a canonical
   *  path such as "durable/skill-catalog", and the SAME protectedTools /
   *  protectedLatestTools pattern machinery that governs tool exchanges then
   *  governs these messages too — all-instance protection via protectedTools,
   *  latest-per-path via protectedLatestTools. This keeps the POLICY in
   *  config while the host only owns the dialect→identity translation (the
   *  same projection principle as #1947's skill/<name>). Tool-call /
   *  tool-result messages are NEVER re-projected — the classifier's domain is
   *  exactly the messages that carry no toolName. Must be pure and cheap: it
   *  runs once per message per protection scan. */
  messagePathOf?: (msg: CoreMessage) => string | undefined;
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
  /** #3192/#3205: buildCompressibleRanges sets this when the range opens right
   *  after a dead-ref hole. A dropped message leaves NO array slot, so the hole
   *  has no index gap and the index check alone would let mergeRangesToThreshold
   *  bridge back into one doomed span bracketing the dead ref. */
  noMergeBefore?: boolean;
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
  /** #3192/#3205: see CompressibleRange.noMergeBefore — set when this protected
   *  range opens right after a dead-ref hole, so formatRanges does not bridge a
   *  preceding compressible range across the hole into one doomed span. */
  noMergeBefore?: boolean;
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
    /** True when every requested range resolved legally but NOTHING needed
     *  folding — all content already covered by active blocks or inside the
     *  protected zone (#4521 no-op class). Not an error: the model
     *  re-submitting an already-folded bill of work gets an idempotent
     *  success-shaped receipt instead of a refusal, so the retry ladder that
     *  used to spin on "Batch rejected before folding any range" dies at the
     *  source. Hosts render it with the "[Compression no-op:" prefix and fold
     *  the exchange away like other zero-applied compress results (#4289). */
    noop?: true;
  };
}

export interface ProcessTurnResult {
  messages: CoreMessage[];
  state: CompressionState;
  nudge?: NudgeDecision;
  /** Compact always-current boundary line, present only on turns where a
   *  compression round is live (nudge plan with offered ranges) but the
   *  advisory banner itself is NOT being delivered this request. Carries the
   *  session's highest allocated ref and the currently offered ranges so the
   *  model never has to guess refs between banner deliveries (#4521). Hosts
   *  append it as an ephemeral trailing user message, same carrier as a
   *  nudge. */
  statusLine?: string;
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
