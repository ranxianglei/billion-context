import type { BiliMessage } from "./bili-message.js";
import { hashId } from "./util.js";
import { ClusterCounter, deriveMessageId } from "./message-id.js";

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

export type AnthropicRequestBody = {
  model?: string;
  max_tokens?: number;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
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
    const blocks =
      typeof m.content === "string"
        ? [{ type: "text" as const, text: m.content }]
        : m.content;
    for (const b of blocks) {
      switch (b.type) {
        case "text": {
          const base = deriveMessageId(m.role, "text", b.text);
          const id = clusters.next(base);
          msgs.push({ id, role: m.role, contentType: "text", text: b.text });
          if (b.cache_control) cacheControls.set(id, b.cache_control);
          break;
        }
        case "tool_use": {
          const base = deriveMessageId(
            "assistant",
            "tool-call",
            safeStringify(b.input),
            {
              toolCallId: b.id,
              toolName: b.name,
            },
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
          const base = deriveMessageId("tool", "tool-result", text, {
            toolCallId: b.tool_use_id,
          });
          const id = clusters.next(base);
          const name = toolNames.get(b.tool_use_id);
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
          const base = deriveMessageId("assistant", "reasoning", b.thinking);
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
          const base = deriveMessageId(m.role, "text", "[image]");
          msgs.push({
            id: clusters.next(base),
            role: m.role,
            contentType: "text",
            text: "[image]",
            rawAnthropicBlock: b,
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
          const base = deriveMessageId(m.role, "text", "[redacted_thinking]");
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
          // document/PDF) used to fall out of this switch silently — user
          // content lost on every rebuild, no warning. Ride the sidecar like
          // image/redacted_thinking (#366): coreToAnthropic re-emits
          // rawAnthropicBlock verbatim, cache_control included.
          const unknownType = (b as { type?: unknown }).type;
          const label =
            typeof unknownType === "string" ? `[${unknownType}]` : "[unknown]";
          const base = deriveMessageId(m.role, "text", label);
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

export function coreToAnthropic(
  messages: BiliMessage[],
  cacheControls?: Map<string, unknown>,
): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
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
