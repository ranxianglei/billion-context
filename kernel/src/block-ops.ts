import { parseBlockIdArg } from "./decompress.js";
import type { CompressionState } from "./types.js";

/** #5765: per-id outcome of a retire/restore/rewrite operation.
 *  `applied` = state changed; `noop` = already in the requested state
 *  (idempotent); `failed` = rejected with a model-readable reason. */
export interface BlockOpOutcome {
  applied: string[];
  noop: string[];
  failed: Array<{ id: string; reason: string }>;
}

interface ResolvedTarget {
  blockId: string;
  state: CompressionState;
}

/** Normalize a user-supplied block ref ("b5", "005", "5") and resolve it to an
 *  ACTIVE block. Active-only on purpose: a consumed/inactive block's summary is
 *  not resident (it was distilled into a parent tier), so retiring/restoring/
 *  rewriting it would have no visible effect — reject instead of faking one. */
function resolveActiveBlock(
  state: CompressionState,
  raw: string,
): ResolvedTarget | { error: string } {
  const normalized = typeof raw === "string" ? raw.trim() : "";
  const blockId = parseBlockIdArg(normalized);
  if (!blockId) {
    return { error: `"${normalized}" is not a valid block id (expected e.g. b5)` };
  }
  const block = state.blocks.find((b) => b.blockId === blockId);
  if (!block) {
    return { error: `${blockId} does not exist in this session — run acp_status for the current block list` };
  }
  if (!block.active) {
    return { error: `${blockId} is not active (distilled into a higher tier or deactivated) — only active blocks can be operated on` };
  }
  return { blockId, state };
}

/** #5765 retire: mark active blocks retired — their summaries leave the
 *  resident view (prune skips their anchors) while folded messages stay
 *  covered and decompress/search_context keep working. Idempotent. */
export function retireBlocks(
  state: CompressionState,
  rawIds: string[],
): BlockOpOutcome {
  const outcome: BlockOpOutcome = { applied: [], noop: [], failed: [] };
  for (const raw of rawIds) {
    const target = resolveActiveBlock(state, raw);
    if ("error" in target) {
      outcome.failed.push({ id: String(raw).trim(), reason: target.error });
      continue;
    }
    const block = state.blocks.find((b) => b.blockId === target.blockId)!;
    if (block.retired) {
      outcome.noop.push(block.blockId);
    } else {
      block.retired = true;
      outcome.applied.push(block.blockId);
    }
  }
  return outcome;
}

/** #5765 restore: undo retire — the block's summary re-enters the resident
 *  view on the next rebuild. Idempotent. */
export function restoreBlocks(
  state: CompressionState,
  rawIds: string[],
): BlockOpOutcome {
  const outcome: BlockOpOutcome = { applied: [], noop: [], failed: [] };
  for (const raw of rawIds) {
    const target = resolveActiveBlock(state, raw);
    if ("error" in target) {
      outcome.failed.push({ id: String(raw).trim(), reason: target.error });
      continue;
    }
    const block = state.blocks.find((b) => b.blockId === target.blockId)!;
    if (block.retired) {
      block.retired = false;
      outcome.applied.push(block.blockId);
    } else {
      outcome.noop.push(block.blockId);
    }
  }
  return outcome;
}

/** #5765 rewrite: replace an active block's summary with externally supplied
 *  text — no re-compression, no regeneration. The previous summary is kept one
 *  step deep (`previousSummary`) so the operation is roll-backable; a further
 *  rewrite overwrites that slot. `compressedTokens` is untouched (it records
 *  the original fold's input size, not the summary's). Returns the char counts
 *  before/after for the receipt. */
export function rewriteBlockSummary(
  state: CompressionState,
  raw: string,
  newSummary: string,
):
  | { ok: true; blockId: string; prevChars: number; newChars: number }
  | { ok: false; id: string; reason: string } {
  const target = resolveActiveBlock(state, raw);
  if ("error" in target) return { ok: false, id: String(raw).trim(), reason: target.error };
  const block = state.blocks.find((b) => b.blockId === target.blockId)!;
  const next = typeof newSummary === "string" ? newSummary.trim() : "";
  if (!next) {
    return { ok: false, id: block.blockId, reason: "summary must be non-empty text" };
  }
  if (next === block.summary.trim()) {
    return { ok: false, id: block.blockId, reason: "new summary is identical to the current one — nothing to do" };
  }
  block.previousSummary = block.summary;
  block.summary = next;
  block.rewrittenAt = Date.now();
  return { ok: true, blockId: block.blockId, prevChars: block.previousSummary.length, newChars: next.length };
}
