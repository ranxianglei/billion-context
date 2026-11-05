import { prune } from "./prune.js";
import type { CompressionState, CoreMessage } from "./types.js";

export interface HandoffMeta {
  title?: string;
  label?: string;
  sessionId: string;
  contextTokens?: number;
  extraBullets?: string[];
}

export interface HandoffBlockFull {
  blockId: string;
  topic?: string;
  count: number;
  fullText: string;
}

export interface HandoffInput {
  coreMessages: CoreMessage[];
  state: CompressionState;
  full: boolean;
  /** coreMessages is an already-pruned persisted snapshot (#401 bounded
   *  folded tail): render it as-is instead of re-running prune() — its
   *  message ids no longer align with the state ranges, so pruning would
   *  resurrect dropped summaries at index 0. */
  folded?: boolean;
  /** Original messages per active block, recovered from the block content
   *  cache. Appended after the conversation when full && folded — the
   *  folded snapshot itself no longer carries the folded ranges' originals. */
  blocksFull?: HandoffBlockFull[];
  meta: HandoffMeta;
}

export function renderMessage(m: CoreMessage): string {
  const parts: string[] = [];
  switch (m.contentType) {
    case "text":
      parts.push(m.text ?? "");
      break;
    case "tool-call":
      parts.push(
        `\`${m.toolName ?? "?"}(${m.toolCallId ?? ""})\` args: ${m.text ?? ""}`,
      );
      break;
    case "tool-result":
      parts.push(
        `\`${m.toolName ?? "?"}(${m.toolCallId ?? ""})\` → ${m.text ?? ""}`,
      );
      break;
    case "reasoning":
      parts.push(`_reasoning_: ${m.text ?? ""}`);
      break;
  }
  const body = parts.join("\n").trim();
  return body === "" ? "_(empty)_" : body + "\n";
}

export function renderHandoff(input: HandoffInput): string {
  const { coreMessages, state, full, meta } = input;
  const lines: string[] = [];
  lines.push("# billion-context session handoff");
  lines.push("");
  lines.push(`- title: ${meta.title ?? "(untitled)"}`);
  if (meta.label) lines.push(`- label: ${meta.label}`);
  lines.push(`- session id: ${meta.sessionId}`);
  for (const bullet of meta.extraBullets ?? []) lines.push(bullet);
  if (meta.contextTokens)
    lines.push(`- last context tokens: ~${meta.contextTokens}`);
  lines.push(
    `- compression blocks: ${state.blocks.length} (active ${state.blocks.filter((b) => b.active).length})`,
  );
  lines.push("");
  const folded = input.folded === true;
  const view =
    full || folded
      ? coreMessages
      : // Handoff docs have no provider prefix cache at stake: keep the
        // chronological head placement for summaries of older, absent material
        // (#2733 made the request path pin-safe instead).
        prune(coreMessages, state, { headSummaryAnchors: true });
  lines.push(
    full && !folded
      ? `## Full conversation (${coreMessages.length} messages)`
      : folded
        ? `## Conversation (persisted folded snapshot, ${coreMessages.length} messages)`
        : `## Conversation (folded view as the model saw it, ${coreMessages.length} client messages)`,
  );
  lines.push("");
  if (view.length === 0) {
    lines.push("No conversation messages to export.");
    lines.push("");
  }
  let lastRole = "";
  for (const m of view) {
    if (m.role !== lastRole) {
      lines.push(`### ${m.role}`);
      lines.push("");
      lastRole = m.role;
    }
    lines.push(renderMessage(m));
  }
  lines.push("");
  if (full && folded) {
    for (const b of input.blocksFull ?? []) {
      lines.push(`## Block ${b.blockId}${b.topic ? ` — ${b.topic}` : ""}`);
      lines.push("");
      lines.push(`### Original messages (${b.count})`);
      lines.push("");
      lines.push(b.fullText.trim());
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function matchSession<T extends { id: string }>(
  sessions: T[],
  selector: string,
  labelOf: (s: T) => string | undefined,
): T[] {
  const exact = sessions.filter((s) => s.id === selector);
  if (exact.length > 0) return exact;
  const byLabel = sessions.filter((s) => labelOf(s) === selector);
  if (byLabel.length > 0) return byLabel;
  return sessions.filter(
    (s) => s.id.startsWith(selector) || (labelOf(s) ?? "").startsWith(selector),
  );
}
