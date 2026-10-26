import type { BiliMessage } from "./bili-message.js";
import {
  CANONICAL_IMAGE_TEXT,
  CANONICAL_REDACTED_THINKING_TEXT,
  canonicalToolArgs,
  deriveCanonicalMessageId,
  imageMediaFingerprint,
} from "./identity.js";
import { hashId } from "./util.js";
import { ClusterCounter } from "./message-id.js";
import { isPlainTextSystemMessage } from "../protected.js";

export type AnthropicTextBlock = {
  type: "text";
  text: string;
  cache_control?: unknown;
};
export type AnthropicToolUse = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  cache_control?: unknown;
};
export type AnthropicToolResult = {
  type: "tool_result";
  tool_use_id: string;
  content: string | (AnthropicTextBlock | AnthropicImage)[];
  is_error?: boolean;
  cache_control?: unknown;
};
export type AnthropicImage = { type: "image"; source: unknown };
export type AnthropicThinking = {
  type: "thinking";
  thinking: string;
  signature?: string;
};
export type AnthropicRedactedThinking = {
  type: "redacted_thinking";
  data: string;
  cache_control?: unknown;
};
export type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicToolUse
  | AnthropicToolResult
  | AnthropicImage
  | AnthropicThinking
  | AnthropicRedactedThinking;

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
};

export type AnthropicSystemMessage = {
  role: "system";
  content: string | AnthropicBlock[];
  [key: string]: unknown;
};

export type AnthropicWireMessage = AnthropicMessage | AnthropicSystemMessage;

export type AnthropicRequestBody = {
  model?: string;
  max_tokens?: number;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicWireMessage[];
  tools?: unknown[];
  stream?: boolean;
  temperature?: number;
  [key: string]: unknown;
};

export function extractSystem(system: AnthropicRequestBody["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n\n");
}

export function buildSystem(
  text: string,
  original: AnthropicRequestBody["system"],
): string | AnthropicTextBlock[] {
  if (Array.isArray(original) && original.length > 0) {
    const ccBlock = original.find((b) => b.cache_control);
    return [
      {
        type: "text",
        text,
        ...(ccBlock ? { cache_control: ccBlock.cache_control } : {}),
      },
    ];
  }
  return text;
}

type Flat = { msgs: BiliMessage[]; cacheControls: Map<string, unknown> };

export function anthropicToCore(body: AnthropicRequestBody): Flat {
  const msgs: BiliMessage[] = [];
  const cacheControls = new Map<string, unknown>();
  const clusters = new ClusterCounter();
  // Backfill toolName onto tool-results from their paired tool_use: the wire
  // format only carries the call id on results, but kernel guards
  // (excludeTools / protectedTools / isNeverPreserveRecent) are name-based.
  // Not part of the result identity seed — ids must stay stable across versions.
  const toolNames = new Map<string, string>();
  for (const [wireIndex, m] of body.messages.entries()) {
    // #1995: record the source wire ordinal so host-side strip anchoring can
    // map fold coverage (core-message space) back to wire positions without
    // re-deriving the converter's block-split behavior.
    const before = msgs.length;
    if (m.role === "system") {
      const core = systemMessageCore(m, clusters);
      core.wireIndex = wireIndex;
      msgs.push(core);
      // Harvest the client's breakpoint like any text block's: the host's
      // client-managed-caching detection (#1637) and WC-010's 4-mark budget
      // both read this map, not the verbatim sidecar.
      const mark = systemMessageMark(m);
      if (mark) cacheControls.set(core.id, mark);
      continue;
    }
    const blocks =
      typeof m.content === "string"
        ? [{ type: "text" as const, text: m.content }]
        : m.content;
    for (const b of blocks) {
      switch (b.type) {
        case "text": {
          // #3642 canonical identity: the 5-slot seed keeps its layout with
          // the toolCallId slot empty, so text ids are byte-identical to the
          // legacy derivation (zero churn on the busiest lane).
          const base = deriveCanonicalMessageId(m.role, "text", b.text);
          const id = clusters.next(base);
          msgs.push({ id, role: m.role, contentType: "text", text: b.text });
          if (b.cache_control) cacheControls.set(id, b.cache_control);
          break;
        }
        case "tool_use": {
          // #3642: the seed uses canonical (key-sorted, compact) args and
          // drops the wire toolCallId from the seed — it is transport
          // plumbing, not content; the ClusterCounter's `_N` keeps duplicate
          // calls distinct. `text` KEEPS the host's insertion order so
          // coreToAnthropic rebuilds byte-stable input objects.
          const base = deriveCanonicalMessageId(
            "assistant",
            "tool-call",
            canonicalToolArgs(safeStringify(b.input)),
            { toolName: b.name },
          );
          const id = clusters.next(base);
          msgs.push({
            id,
            role: "assistant",
            contentType: "tool-call",
            toolName: b.name,
            toolCallId: b.id,
            text: safeStringify(b.input),
          });
          toolNames.set(b.id, b.name);
          if (b.cache_control) cacheControls.set(id, b.cache_control);
          break;
        }
        case "tool_result": {
          // Non-text blocks (image) carry bytes outside msg.text; ride
          // the sidecar so coreToAnthropic re-emits them verbatim (#366).
          const hasNonText =
            Array.isArray(b.content) &&
            b.content.some((c) => c.type !== "text");
          const text =
            typeof b.content === "string"
              ? b.content
              : b.content
                  .map((c) => (c.type === "text" ? c.text : ""))
                  .join("\n");
          // #3642: canonical result identity = toolName + text (the wire
          // tool_use_id is transport plumbing). toolName is backfilled from
          // the paired tool_use above; a result whose call is not in this
          // pass keeps an empty toolName slot.
          const name = toolNames.get(b.tool_use_id);
          const base = deriveCanonicalMessageId("tool", "tool-result", text, {
            toolName: name,
          });
          const id = clusters.next(base);
          msgs.push({
            id,
            role: "tool",
            contentType: "tool-result",
            toolCallId: b.tool_use_id,
            text,
            ...(name ? { toolName: name } : {}),
            ...(b.is_error === true ? { toolIsError: true } : {}),
            ...(hasNonText ? { rawAnthropicBlock: b } : {}),
          });
          if (b.cache_control) cacheControls.set(id, b.cache_control);
          break;
        }
        case "thinking": {
          const base = deriveCanonicalMessageId(
            "assistant",
            "reasoning",
            b.thinking,
          );
          msgs.push({
            id: clusters.next(base),
            role: "assistant",
            contentType: "reasoning",
            text: b.thinking,
            ...(b.signature ? { thinkingSignature: b.signature } : {}),
          });
          break;
        }
        case "image": {
          const source =
            b.source &&
            typeof b.source === "object" &&
            !Array.isArray(b.source)
              ? (b.source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown })
              : undefined;
          const mediaSidecar =
            source?.type === "base64" &&
            typeof source.media_type === "string" &&
            typeof source.data === "string"
              ? {
                  imageMediaType: source.media_type,
                  imageBase64: source.data,
                }
              : {};
          const base = deriveCanonicalMessageId(m.role, "text", CANONICAL_IMAGE_TEXT, {
            // #3751: payload-addressed ids — base64 source hashes its bytes,
            // URL source degrades to the URL string, unknown shapes keep the
            // shared legacy base.
            mediaFingerprint:
              source?.type === "base64" && typeof source.data === "string"
                ? imageMediaFingerprint(source.data)
                : typeof source?.url === "string"
                  ? imageMediaFingerprint(source.url)
                  : undefined,
          });
          msgs.push({
            id: clusters.next(base),
            role: m.role,
            contentType: "text",
            text: CANONICAL_IMAGE_TEXT,
            imagePart: true,
            rawAnthropicBlock: b,
            ...mediaSidecar,
          });
          break;
        }
        case "redacted_thinking": {
          // Opaque payload (base64). Anthropic verifies it verbatim on replay
          // and rejects any modification of the latest assistant message that
          // carries thinking-family blocks ("thinking blocks ... cannot be
          // modified"). Dropping it here silently rewrites that message, so it
          // rides the sidecar exactly like images (#366) — coreToAnthropic
          // re-emits rawAnthropicBlock verbatim.
          const base = deriveCanonicalMessageId(
            m.role,
            "text",
            CANONICAL_REDACTED_THINKING_TEXT,
          );
          msgs.push({
            id: clusters.next(base),
            role: m.role,
            contentType: "text",
            text: "[redacted_thinking]",
            rawAnthropicBlock: b,
          });
          break;
        }
        default: {
          // #3410: unknown top-level block types (in the wild today:
          // document/PDF) used to fall out of this switch silently — the
          // payload vanished on every rebuild with no warning. Ride the
          // sidecar like image/redacted_thinking: coreToAnthropic re-emits
          // rawAnthropicBlock verbatim (cache_control included) and never
          // renders the label text, so the round trip is byte-exact.
          const unknownType = (b as { type?: unknown }).type;
          const label =
            typeof unknownType === "string" ? `[${unknownType}]` : "[unknown]";
          const base = deriveCanonicalMessageId(m.role, "text", label);
          msgs.push({
            id: clusters.next(base),
            role: m.role,
            contentType: "text",
            text: label,
            rawAnthropicBlock: b,
          });
          break;
        }
      }
    }
    for (let k = before; k < msgs.length; k++) {
      (msgs[k] as BiliMessage).wireIndex = wireIndex;
    }
  }
  return { msgs, cacheControls };
}

// Mid-conversation system messages (Pi's tool_addition / tool_removal
// deltas, message-level output_config) are host control-plane state: one
// core per wire message, re-emitted verbatim, never split into the
// user/assistant block stream.
function systemMessageCore(
  m: AnthropicSystemMessage,
  clusters: ClusterCounter,
): BiliMessage {
  const label = systemMessageText(m);
  // A single-text-block message keeps the legacy per-block id (zero churn
  // for Claude Code's trailing environment message).
  const base = deriveCanonicalMessageId("system", "text", label);
  return {
    id: clusters.next(base),
    role: "system",
    contentType: "text",
    text: label,
    rawAnthropicMessage: m,
  };
}

function systemMessageText(m: AnthropicSystemMessage): string {
  const text =
    typeof m.content === "string"
      ? m.content
      : m.content
          .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
          .join("\n");
  return text.length > 0 ? text : "[system]";
}

function systemMessageMark(m: AnthropicSystemMessage): unknown {
  if (typeof m.content === "string") return undefined;
  let mark: unknown;
  for (const b of m.content as { cache_control?: unknown }[])
    if (b.cache_control) mark = b.cache_control;
  return mark;
}

// Verbatim unless the kernel rewrote the text (e.g. emergency truncation of
// a plain-text message) — re-emitting the original would undo it. A mark the
// original lacks (host-stamped, #1637) lands on the last block.
function rebuildSystemMessage(
  m: BiliMessage,
  mark: unknown,
): AnthropicSystemMessage {
  const raw = m.rawAnthropicMessage as AnthropicSystemMessage;
  const cc = mark ? { cache_control: mark } : {};
  const text = m.text ?? "";
  if (text !== systemMessageText(raw) && isPlainTextSystemMessage(raw)) {
    return { role: "system", content: [{ type: "text", text, ...cc }] };
  }
  if (!mark || systemMessageMark(raw) || typeof raw.content === "string") {
    return raw;
  }
  const last = raw.content.length - 1;
  if (last < 0) return raw;
  return {
    ...raw,
    content: raw.content.map((b, i) => (i === last ? { ...b, ...cc } : b)),
  };
}

// #4292 hardening, kept for #4457's backstop: a directive-only system
// (empty content + output_config) is accepted at ANY position by
// Anthropic's mid-conversation-system rule, so it is never healed; demoting
// it would mint an empty-content user message that 400s on its own
// (mirrors the reporter's isAnthropicDirectiveOnlySystem).
function isDirectiveOnlySystem(e: AnthropicWireMessage): boolean {
  return (
    e.role === "system" &&
    Array.isArray(e.content) &&
    e.content.length === 0 &&
    (e as { output_config?: unknown }).output_config != null
  );
}

// #4457: Anthropic accepts a mid-conversation system only immediately
// before an assistant message or at the end of the array — any other
// position 400s the whole request, permanently killing the session (a run
// of consecutive systems is judged by the run's first non-system follower:
// Pi's trailing tool-delta + effort-marker runs are legal at array end).
// The fold layer keeps sidecar systems OUT of folds (kernel/src/protected.ts
// never-fold carve): their tool deltas are FUNCTIONAL under Anthropic's
// mid-conversation-tool-changes contract — tools[] stays static for cache
// stability and the deltas control which tools are offered (defer_loading
// surfacing, by-value definitions, removals, MCP toolsets) — so folding them
// would silently alter the effective tool set. Orphans still arise when a
// fold covers the assistant that legitimized one; this position-based
// backstop heals whatever still arrives illegal: sessions folded by older
// builds and positionally-illegal client input. Demotion re-voices to user
// with tool_addition/tool_removal blocks stripped first (WC-022 forbids them
// outside system) and drops the entry when nothing remains; a
// directive-only system (empty content + output_config) is accepted at ANY
// position, so it is never healed. Fresh objects only — sidecars stay
// intact for future verbatim emission once re-legitimized.
function isToolUpdateBlock(b: { type?: unknown }): boolean {
  return b.type === "tool_addition" || b.type === "tool_removal";
}

function healIllegalSystemPositions(out: AnthropicWireMessage[]): void {
  for (let j = 0; j < out.length; j++) {
    const e = out[j];
    if (!e || e.role !== "system" || isDirectiveOnlySystem(e)) continue;
    let k = j + 1;
    while (k < out.length && out[k]!.role === "system") k++;
    const next = out[k];
    if (!next || next.role === "assistant") continue;
    if (typeof e.content === "string") {
      // An empty string demoted to user would mint an empty-content user
      // message, which 400s on its own — drop instead.
      if (e.content === "") {
        out.splice(j, 1);
        j--;
      } else {
        out[j] = { role: "user", content: e.content };
      }
      continue;
    }
    const kept = e.content.filter(
      (b) => !isToolUpdateBlock(b as { type?: unknown }),
    );
    if (kept.length === 0) {
      out.splice(j, 1);
      j--;
      continue;
    }
    out[j] = { role: "user", content: kept };
  }
}

export function coreToAnthropic(
  messages: BiliMessage[],
  cacheControls?: Map<string, unknown>,
): AnthropicWireMessage[] {
  const out: AnthropicWireMessage[] = [];
  let current: { role: "user" | "assistant"; blocks: AnthropicBlock[] } | null =
    null;
  const flush = () => {
    if (current && current.blocks.length > 0) {
      out.push({ role: current.role, content: current.blocks });
    }
    current = null;
  };
  const cc = (id: string): { cache_control?: unknown } => {
    const v = cacheControls?.get(id);
    return v ? { cache_control: v } : {};
  };
  for (const m of messages) {
    if (m.rawAnthropicMessage) {
      flush();
      out.push(rebuildSystemMessage(m, cacheControls?.get(m.id)));
      continue;
    }
    // #4292/#4457: fold-orphaned and client-illegal system positions are
    // healed by the position-based backstop after assembly (see below) —
    // no shape matching here.
    const target: "user" | "assistant" =
      m.role === "assistant" ? "assistant" : "user";
    if (!current || current.role !== target) {
      flush();
      current = { role: target, blocks: [] };
    }
    switch (m.contentType) {
      case "text": {
        if (m.rawAnthropicBlock) {
          current.blocks.push(m.rawAnthropicBlock as AnthropicBlock);
          break;
        }
        current.blocks.push({ type: "text", text: m.text ?? "", ...cc(m.id) });
        break;
      }
      case "tool-call":
        current.blocks.push({
          type: "tool_use",
          id: m.toolCallId ?? `call_${m.id}`,
          name: m.toolName ?? "unknown",
          input: safeParse(m.text),
          ...cc(m.id),
        });
        break;
      case "tool-result":
        if (m.rawAnthropicBlock) {
          current.blocks.push(m.rawAnthropicBlock as AnthropicBlock);
          break;
        }
        current.blocks.push({
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: m.text ?? "",
          ...(m.toolIsError ? { is_error: true } : {}),
          ...cc(m.id),
        });
        break;
      case "reasoning":
        current.blocks.push({
          type: "thinking",
          thinking: m.text ?? "",
          ...(m.thinkingSignature ? { signature: m.thinkingSignature } : {}),
        });
        break;
    }
  }
  flush();
  healIllegalSystemPositions(out);
  return out;
}

/** Extract the conversation dimension for Anthropic: a client-provided
 *  session header if present, else a content fingerprint of the first user
 *  message. The protocol+upstream+key dimensions are mixed in by the caller
 *  (server.ts) via deriveSessionId() — this function contributes only the
 *  conversation axis. */
export function conversationSignalAnthropic(
  body: AnthropicRequestBody,
  headerValue?: string,
): string {
  if (headerValue && headerValue.trim()) return headerValue.trim();
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const firstUser = msgs.find((m) => m?.role === "user");
  const seed = firstUser ? JSON.stringify(firstUser.content) : "default";
  return hashId(seed);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "{}";
  }
}

function safeParse(s: string | undefined): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
