/**
 * Search — re-exports from the modular src/search/ implementation.
 */
export {
  searchBlocks,
  searchBlocksAsync,
  blockDocs,
  messageDocs,
} from "./search/index.js";
export {
  clearDocFeatures,
  docCacheInfo,
  docFeatures,
  setDocCacheCap,
} from "./search/index.js";
export type { DocFeatures } from "./search/index.js";
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
} from "./search/types.js";
export { DEFAULT_ALGORITHM, DEFAULT_ROLE_WEIGHTS } from "./search/types.js";
export {
  registerSearchAlgorithm,
  getSearchAlgorithm,
  listSearchAlgorithms,
} from "./search/registry.js";
