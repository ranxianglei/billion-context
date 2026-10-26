export * from "./types.js";
export { createCore } from "./compress.js";
export type {
  Ports,
  CompressionCore,
  ProcessTurnInput,
  ApplyCompressionInput,
} from "./compress.js";
export {
  createInitialState,
  allocateBlockId,
  allocateRunId,
  blockById,
  activeBlocks,
  coveredMessageIds,
  highestActiveTier,
  advanceSurvival,
} from "./state.js";
export { defaultConfig, validateConfig } from "./config.js";
export * from "./compress-tools.js";
export {
  assignRefs,
  highestUsedIndex,
  emptyRefMap,
  indexToRef,
  refToIndex,
  orderedRefPair,
  refForRaw,
  rawForRef,
  BLOCKED_REF,
  restampRefsToLedger,
  type RefRestampOutcome,
} from "./refs.js";
export {
  prune,
  baseIdOf,
  isCovered,
  SUMMARY_HEADER,
  summaryMessageId,
  isSummaryMessageId,
  isRenderedSummaryMessage,
} from "./prune.js";
export { syncBlocks } from "./sync.js";
export {
  resolveBoundaries,
  parseBoundary,
  BoundaryNotFoundError,
  visibleBlockAnchor,
  blockVisibleInRange,
} from "./boundaries.js";
export {
  defaultCountTokens,
  estimateTokensFast,
  createBpeTokenizer,
  countMessageTokens,
} from "./tokenize.js";
export type { TokenCountFn } from "./tokenize.js";
export { renderNudgeText, formatRanges, ONE_CALL_HINT } from "./nudge-text.js";
export type {
  NudgeVoice,
  RenderedNudge,
  NudgePromptSections,
} from "./nudge-text.js";
export {
  resolveBlockSpan,
  activeBlockSpans,
  formatCreatedBlocks,
} from "./block-map.js";
export {
  COMPRESS_PHILOSOPHY,
  HOW_TO_COMPRESS_RULES,
  LANGUAGE_PRESERVATION_RULE,
  TIER2_DISTILL_RULES,
  TIER3_CONDENSE_RULES,
} from "./compression-rules.js";
export { defaultPrompts, resolvePrompts } from "./prompts.js";
export type { Prompts, ResolvePromptsOptions } from "./prompts.js";
export {
  applySectionOverrides,
  cloneWithDescriptions,
  applyAcpToolOverrides,
} from "./surface-config.js";
export type {
  SectionOverride,
  CompressPromptSections,
  ToolPromptOverrides,
  ToolPrompts,
  AcpToolLike,
} from "./surface-config.js";
export {
  isValidPackName,
  sanitizePackSurface,
  defaultPack,
  leanPack,
  LEAN_HOW_TO_COMPRESS,
  leanHowToCompress,
  builtinSource,
  createDirPackSource,
  createPackResolver,
  defaultPackSources,
} from "./packs.js";
export type {
  PromptPackFile,
  PackSurface,
  Pack,
  PackSource,
  PackResolver,
} from "./packs.js";
export { truncateLargeToolOutputs } from "./truncate-tools.js";
export type { TruncateOptions, TruncateResult } from "./truncate-tools.js";
export {
  parseBlockIdArg,
  findBlocksOverlappingMessages,
  findActiveAncestor,
  activeAncestorIds,
  deactivateBlock,
  buildRestoredContentPreview,
  collectBlockContent,
  markBlockRestoredInline,
} from "./decompress.js";
export type {
  DeactivateOptions,
  CollectedContentResult,
  CollectContentOptions,
  InlineRestoreResult,
} from "./decompress.js";
export { buildStatusReport, buildRecap } from "./report.js";
export type { StatusReportOptions, StatusReportMeta } from "./report.js";
export { segmentGroups } from "./segment.js";
export type { SegmentItem } from "./segment.js";
export {
  buildCacheReport,
  computeFoldEconomics,
  decomposeSample,
  FOLD_CLAIM_COLD_ROUNDS,
  FOLD_CLAIM_WARM_HIT_PCT,
  formatCacheReport,
  summarizeFoldEconomics,
} from "./cache-report.js";
export type {
  CacheSample,
  FoldEvent,
  FoldEconomicsInput,
  PriceProfile,
  SampleDecomposition,
  CacheTotals,
  FoldEconomics,
  EconomicsSummary,
  CacheReportLine,
  CacheReportOptions,
  CacheReport,
  FormatCacheReportOptions,
} from "./cache-report.js";
export { renderHandoff, renderMessage, matchSession } from "./handoff.js";
export type { HandoffInput, HandoffMeta, HandoffBlockFull } from "./handoff.js";
export { isToolMessage } from "./message-kind.js";
export { hideConsumedCompressCalls } from "./hide-consumed.js";
export type { HideConsumedResult } from "./hide-consumed.js";
export {
  ABSORB_TOOL_NAME,
  ABSORB_TOOL,
  ABSORB_TOOL_OPENAI,
} from "./compress-tools.js";
export {
  RETRIEVE_TOOL_NAME,
  RETRIEVE_TOOL,
  RETRIEVE_TOOL_OPENAI,
  RETRIEVE_TOOL_RESPONSES,
  RETRIEVE_TOOL_DESCRIPTION,
} from "./compress-tools.js";
export {
  createContentStore,
  hashContent,
  storeOriginal,
  retrieveByRef,
  hasStoredRef,
  contentStoreStats,
} from "./content-store.js";
export type {
  MessageContentStore,
  StoredEntry,
  StoreSpec,
  RetrieveResult,
  ContentStoreStats,
} from "./content-store.js";
export {
  DEFAULT_CCR_CONFIG,
  resolveCcrConfig,
  STORED_PLACEHOLDER_MARKER,
  RETRIEVED_ID_PREFIX,
  classifyKind,
  normalizeHead,
  extractCommand,
  buildStoredPlaceholder,
  parseStoredPlaceholder,
  isStoredPlaceholderText,
  restoreStoredPlaceholderText,
  retrievedMessageId,
  isRetrievedMessage,
  frameRetrievedOriginal,
  buildRetrievalPointer,
  RETRIEVE_INLINE_TOKENS_DEFAULT,
  applyRetrieve,
  storeLargeResults,
  storeCoveredOriginals,
  noteRetrieval,
  ccrStoreNode,
} from "./ccr.js";
export type {
  StoredPlaceholderInput,
  ParsedStoredPlaceholder,
  RetrievalExport,
  ApplyRetrieveInput,
  ApplyRetrieveResult,
  StoreLargeResultsInput,
  StoreLargeResultsResult,
  CcrEffect,
} from "./ccr.js";
export {
  ABSORB_PROMPT_MARKER,
  DEFAULT_ABSORB_CONFIG,
  resolveAbsorbConfig,
  buildAbsorbPrompt,
  buildAbsorbSystemPrompt,
  isAbsorbCandidate,
  hideAbsorbedMessages,
  appendAbsorbPrompts,
  parseAbsorbInput,
  applyAbsorb,
} from "./absorb.js";
export type {
  AbsorbInput,
  AbsorbOutcome,
  ParsedAbsorb,
  AppendAbsorbPromptsResult,
} from "./absorb.js";
export {
  RULE_TOOL_NAME,
  DEFAULT_RULE_LIMITS,
  RULES_USAGE_PROMPT,
  listRules,
  allocateRuleId,
  resolveRuleLimits,
  addRule,
  removeRule,
  clearRules,
  formatRulesForPrompt,
  formatRulesList,
} from "./rules.js";
export type {
  RuleLimits,
  AddRuleResult,
  RemoveRuleResult,
  ClearRulesResult,
} from "./rules.js";
export {
  DEFAULT_CRUSH_CONFIG,
  classifyCrushText,
  crushText,
  evaluateToolResult,
  applyCrushToMessages,
  resolveCrushConfig,
  registerCrushPlugin,
  unregisterCrushPlugin,
  listCrushPlugins,
  resetCrushPlugins,
  jsonFoldPlugin,
  codeTrimPlugin,
  logSelectPlugin,
} from "./crush.js";
export type {
  CrushKind,
  CrushMeta,
  CrushOutput,
  CrushOptions,
  CrushPluginDef,
  CrushDecisionKind,
  CrushEvaluation,
  EvaluateCrushInput,
  ApplyCrushResult,
} from "./crush.js";
export { rebuildCompressionState } from "./rebuild.js";
export type { RebuildResult, RebuildPorts } from "./rebuild.js";
export { parseCompressArgs } from "./parse-compress-input.js";
export type {
  CompressParseDiagnostics,
  CompressParseKind,
  ParsedCompressInput,
} from "./parse-compress-input.js";
export {
  renderVisibleRefs,
  renderRefsNode,
  createRenderRefsNode,
} from "./render-refs.js";
export type { RenderStrategy } from "./render-refs.js";
export { resolveTransformChannel } from "./transform-channel.js";
export type { TransformChannel } from "./transform-channel.js";
export {
  searchBlocks,
  searchBlocksAsync,
  blockDocs,
  messageDocs,
} from "./search.js";
export {
  clearDocFeatures,
  docCacheInfo,
  docFeatures,
  setDocCacheCap,
} from "./search.js";
export type {
  SearchResult,
  SearchOptions,
  SearchAlgorithm,
  AsyncSearchAlgorithm,
  AnySearchAlgorithm,
  SearchDoc,
  SearchDocKind,
  ScoredBlock,
  MessageRole,
  RoleWeights,
  MessageInput,
} from "./search.js";
export {
  DEFAULT_ALGORITHM,
  DEFAULT_ROLE_WEIGHTS,
  registerSearchAlgorithm,
  getSearchAlgorithm,
  listSearchAlgorithms,
} from "./search.js";
export {
  collectLatestProtected,
  collectProtectedToolCallIds,
  hasMediaPayload,
  hasUnrecoverableMediaPayload,
  isMessageLatestProtected,
  isMessageProtected,
  isMessageProtectedWithPairing,
  matchToolMessagePattern,
  matchToolPath,
  matchToolPattern,
  toolPathOf,
  type LatestProtected,
} from "./protected.js";
export {
  runPipeline,
  makeIO,
  type PipelineNode,
  type PipelineContext,
  type NodeIO,
  type NodeEffects,
} from "./pipeline.js";
export * from "./filter/index.js";

export { VIABLE_RANGE_MIN_TOKENS, viableRanges } from "./viable.js";
export {
  classifyTurn,
  verbosityDirective,
  renderSteeringBlock,
  applySteeringToPrompt,
  clampEffortToFloor,
  resolveVerbosityLevel,
  resolveOutputSteeringConfig,
  decideOutputSteering,
  VERBOSITY_LEVELS,
  EFFORT_LADDER,
  DEFAULT_OUTPUT_STEERING_CONFIG,
  DEFAULT_STEERING_SENTINEL,
  DEFAULT_VERBOSITY_LEVEL,
  MIN_VERBOSITY_LEVEL,
  MAX_VERBOSITY_LEVEL,
} from "./output-steering.js";
export type {
  TurnKind,
  StructuralMessage,
  StructuralBlock,
  OutputSteeringConfig,
  OutputSteeringDecision,
  SteeringPlacement,
  EffortValue,
} from "./output-steering.js";
