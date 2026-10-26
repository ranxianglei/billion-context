import { resolveBlockSpan } from "./block-map.js";
import { SUMMARY_HEADER } from "./prune.js";
import { clampPrefix } from "./truncate.js";
import type {
  CompressionBlock,
  CompressionState,
  CoreMessage,
} from "./types.js";

export function parseBlockIdArg(arg: string): string | null {
  const normalized = arg.trim().toLowerCase();
  const refMatch = /^b0*(\d+)$/.exec(normalized);
  if (refMatch && refMatch[1] !== undefined) return `b${refMatch[1]}`;
  const numMatch = /^(\d+)$/.exec(normalized);
  if (numMatch && numMatch[1] !== undefined) return `b${numMatch[1]}`;
  return null;
}

export function findBlocksOverlappingMessages(
  state: CompressionState,
  messageIds: Set<string>,
): CompressionBlock[] {
  if (messageIds.size === 0) return [];
  const matched: CompressionBlock[] = [];
  for (const block of state.blocks) {
    if (!block.active) continue;
    if (block.effectiveMessageIds.some((id) => messageIds.has(id))) {
      matched.push(block);
    }
  }
  return matched.sort(
    (a, b) => numericPart(a.blockId) - numericPart(b.blockId),
  );
}

export function findActiveAncestor(
  state: CompressionState,
  blockId: string,
): string | null {
  const start = state.blocks.find((b) => b.blockId === blockId);
  if (!start) return null;
  const queue: string[] = [...start.directBlockIds];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const current = state.blocks.find((b) => b.blockId === currentId);
    if (!current) continue;
    if (current.active) return current.blockId;
    for (const ancestorId of current.directBlockIds) {
      if (!visited.has(ancestorId)) queue.push(ancestorId);
    }
  }
  return null;
}

export interface DeactivateOptions {
  deep?: boolean;
}

export function deactivateBlock(
  state: CompressionState,
  blockIds: string[],
  options: DeactivateOptions = {},
): CompressionState {
  const targets = new Set(blockIds);

  const updated = state.blocks.map((block) => {
    if (!targets.has(block.blockId) || !block.active) return block;
    return {
      ...block,
      active: false,
      durationMs: block.durationMs,
      createdAt: block.createdAt,
    };
  });

  let final = updated;
  if (options.deep) {
    const visited = new Set<string>();
    const queue: string[] = [];
    for (const id of blockIds) {
      const block = updated.find((b) => b.blockId === id);
      if (block) queue.push(...block.directBlockIds);
    }
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      final = final.map((block) => {
        if (block.blockId !== id) return block;
        queue.push(...block.directBlockIds);
        return block.active ? { ...block, active: false } : block;
      });
    }
  }

  return { ...state, blocks: final };
}

export interface RestoredPreviewResult {
  preview: string;
  restoredCount: number;
}

export function buildRestoredContentPreview(
  messages: CoreMessage[],
  beforeActiveMessageIds: Set<string>,
  state: CompressionState,
): RestoredPreviewResult {
  const restored: CoreMessage[] = [];
  for (const message of messages) {
    if (!beforeActiveMessageIds.has(message.id)) continue;
    const stillCovered = state.blocks.some(
      (b) => b.active && b.effectiveMessageIds.includes(message.id),
    );
    if (!stillCovered) restored.push(message);
  }

  if (restored.length === 0) return { preview: "", restoredCount: 0 };

  const lines: string[] = [];
  let totalLength = 0;
  const MAX_PREVIEW = 2000;
  const MAX_PER_MESSAGE = 200;

  for (const message of restored) {
    if (totalLength >= MAX_PREVIEW) break;
    const text = message.text ?? "";
    const truncated =
      text.length > MAX_PER_MESSAGE
        ? clampPrefix(text, MAX_PER_MESSAGE) + "..."
        : text;
    const label =
      message.toolName && message.contentType !== "text"
        ? `${message.toolName}: ${truncated}`
        : `[${message.role}] ${truncated}`;
    lines.push(label);
    totalLength += label.length + 1;
  }

  return { preview: lines.join("\n"), restoredCount: restored.length };
}

export interface CollectedContentResult {
  /** Rendered, human-readable content string (empty when count is 0). */
  text: string;
  /** Number of items rendered: direct messages + nested summaries (full=false) or all messages (full=true). */
  count: number;
}

export interface CollectContentOptions {
  /** When true, recurse through all nested tiers to original messages. Default: false (one tier up — nested active children stay folded, their summaries shown). */
  full?: boolean;
}

/**
 * Collect a block's content as a readable string WITHOUT modifying state.
 *
 * This is the cache-safe decompress primitive: the block stays compressed
 * (folded), its summary stays in place, and the full content is returned as
 * text for the caller to surface (e.g. as a tool result appended to the
 * conversation). Unlike deactivateBlock + prune, this does not mutate the
 * message-array prefix, so prompt cache is preserved.
 *
 * full=false (default): one tier up. Nested ACTIVE children of this block
 *   stay folded; their summaries are rendered in place of their messages.
 *   The block's own direct messages (not covered by any active child) are
 *   rendered in full.
 * full=true: recurse through all nested tiers; every effective message is
 *   rendered in full.
 *
 * Returns { text: "", count: 0 } when the block covers no messages.
 */
export function collectBlockContent(
  state: CompressionState,
  block: CompressionBlock,
  messages: CoreMessage[],
  options: CollectContentOptions = {},
): CollectedContentResult {
  const full = options.full ?? false;
  const targetIds = new Set(block.effectiveMessageIds);

  if (full) {
    const msgs = messages.filter((m) => targetIds.has(m.id));
    if (msgs.length === 0) return { text: "", count: 0 };
    return { text: msgs.map(formatMessage).join("\n\n"), count: msgs.length };
  }

  // One tier up: messages covered by nested ACTIVE children stay folded
  // (their summaries shown); the block's own direct messages shown in full.
  const nestedChildren: CompressionBlock[] = [];
  const nestedCovered = new Set<string>();
  for (const childId of block.directBlockIds) {
    const child = state.blocks.find((b) => b.blockId === childId);
    if (!child?.active) continue;
    nestedChildren.push(child);
    for (const id of child.effectiveMessageIds) nestedCovered.add(id);
  }

  const parts: string[] = [];
  for (const child of nestedChildren) {
    const label = child.topic
      ? `${child.blockId}: ${child.topic}`
      : child.blockId;
    parts.push(`${SUMMARY_HEADER} — ${label}\n${child.summary}`);
  }

  let directCount = 0;
  for (const m of messages) {
    if (targetIds.has(m.id) && !nestedCovered.has(m.id)) {
      parts.push(formatMessage(m));
      directCount++;
    }
  }

  const count = directCount + nestedChildren.length;
  if (count === 0) return { text: "", count: 0 };
  return { text: parts.join("\n\n"), count };
}

function formatMessage(message: CoreMessage): string {
  const text = message.text ?? "";
  if (message.toolName && message.contentType !== "text") {
    return `[${message.role} • ${message.toolName}]\n${text}`;
  }
  return `[${message.role}]\n${text}`;
}

function numericPart(blockId: string): number {
  const match = /^b(\d+)$/.exec(blockId);
  return match && match[1] !== undefined ? Number(match[1]) : 0;
}

export interface InlineRestoreResult {
  restored: true;
  blockId: string;
  /** m-ref of the block span's first message; omitted when not derivable
   *  (e.g. a multi-segment restore), in which case the adapter degrades to a
   *  generic re-fold hint. */
  restoredStartRef?: string;
  /** m-ref of the block span's last message (see restoredStartRef). */
  restoredEndRef?: string;
}

/** Inline-decompress marker for refold-in-place (#398): flags a block whose
 *  content was restored into the live conversation so compress() may refold it
 *  in place later. The block stays ACTIVE and no refs or ids move — only the
 *  flag flips, so ref immutability holds. Returns metadata for the host's
 *  re-fold guidance; `result` is null when the block does not exist. */
export function markBlockRestoredInline(
  state: CompressionState,
  blockId: string,
): { state: CompressionState; result: InlineRestoreResult | null } {
  const existing = state.blocks.find((b) => b.blockId === blockId);
  if (!existing) return { state, result: null };
  const blocks = state.blocks.map((block) =>
    block.blockId === blockId ? { ...block, restoredInline: true } : block,
  );
  const span = resolveBlockSpan(existing, state.messageRefs.byRaw);
  const result: InlineRestoreResult = {
    restored: true,
    blockId,
    ...(span
      ? { restoredStartRef: span.startRef, restoredEndRef: span.endRef }
      : {}),
  };
  return { state: { ...state, blocks }, result };
}

/** All ACTIVE ancestors of a block (#398), nearest generation first: a block
 *  P is an ancestor when its directBlockIds (the blocks it folded) reach
 *  blockId; the walk keeps climbing through inactive intermediates up to live
 *  parents. Used to enforce the refold rule that no unrecovered folded tier
 *  sits above a restored block. */
export function activeAncestorIds(
  state: CompressionState,
  blockId: string,
): string[] {
  const out: string[] = [];
  const visited = new Set<string>([blockId]);
  let frontier: string[] = [blockId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const block of state.blocks) {
      if (visited.has(block.blockId)) continue;
      if (!block.directBlockIds.some((id) => frontier.includes(id))) continue;
      visited.add(block.blockId);
      if (block.active) out.push(block.blockId);
      next.push(block.blockId);
    }
    frontier = next;
  }
  return out;
}
