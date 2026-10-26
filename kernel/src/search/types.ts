/**
 * Search type definitions.
 *
 * Two data sources are searchable:
 *  - Compressed blocks (summary text; ref = "b{id}")
 *  - Historical messages (original text from the append-only session log;
 *    ref = "m{NNNNN}"). These let the model locate detail that compression
 *    turned into a short summary — search to pinpoint, then decompress the
 *    owning block for the full content.
 *
 * A SearchAlgorithm is a stateless scorer over a unified SearchDoc[]. Roles
 * carry a configurable weight (user intent > assistant reasoning > tool noise).
 */

/** Where a searchable document came from. */
export type SearchDocKind = "block" | "message";

export type MessageRole = "user" | "assistant" | "tool";

/** A unified searchable document — either a block summary or a message. */
export interface SearchDoc {
  kind: SearchDocKind;
  /** Stable ref for decompress: "b3" for a block, "m00350" for a message. */
  ref: string;
  /** Text this doc is scored against (topic+summary for blocks; content for messages). */
  text: string;
  /** For preview/title display. */
  title: string;
  /** Message role (messages only); undefined for blocks. Drives role weighting. */
  role?: MessageRole;
  /** Block owning this doc. For blocks: the block itself. For messages: the block
   *  that compressed it (so the model knows which block to decompress for detail). */
  blockId?: string;
  /** Tier of the owning block (display + grouping). */
  tier?: number;
  /** Approx token size (for "how big is this" display). */
  tokens?: number;
}

/** Per-role score multipliers. Defaults favor user intent over tool noise. */
export interface RoleWeights {
  user?: number;
  assistant?: number;
  tool?: number;
  block?: number;
}

export const DEFAULT_ROLE_WEIGHTS: Required<RoleWeights> = {
  user: 1.5,
  assistant: 1.0,
  tool: 0.6,
  block: 1.0,
};

export interface ScoredBlock {
  ref: string;
  score: number;
}

export interface SearchAlgorithm {
  name: string;
  description: string;
  score(docs: SearchDoc[], query: string): ScoredBlock[];
}

export interface AsyncSearchAlgorithm {
  name: string;
  description: string;
  score(docs: SearchDoc[], query: string): Promise<ScoredBlock[]>;
}

export type AnySearchAlgorithm = SearchAlgorithm | AsyncSearchAlgorithm;

export interface SearchResult {
  /** "block" or "message". */
  kind: SearchDocKind;
  /** Ref to pass to decompress: "b3" or "m00350". */
  ref: string;
  /** Owning block id (for messages: the block that compressed it). */
  blockId?: string;
  tier: number;
  score: number;
  title: string;
  preview: string;
  role?: MessageRole;
  tokens?: number;
}

export interface SearchOptions {
  algorithm?: string;
  limit?: number;
  previewLength?: number;
  minScore?: number;
  /** Per-role weights (default DEFAULT_ROLE_WEIGHTS). */
  roleWeights?: RoleWeights;
}

/** Host-supplied historical message, turned into a message SearchDoc. */
export interface MessageInput {
  ref: string;
  role: MessageRole;
  text: string;
  tokens?: number;
  /** Block id that compressed this message (undefined if still visible). */
  blockId?: string;
  tier?: number;
}

export const DEFAULT_ALGORITHM = "hybrid";
