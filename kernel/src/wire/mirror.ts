import { anthropicToCore } from "./anthropic.js";
import { openaiToCore } from "./openai.js";
import { responsesToCore } from "./responses.js";
import type { BiliMessage } from "./bili-message.js";

/**
 * Mirror constructors: rebuild the WIRE-SHAPE projection of a persisted
 * conversation (the mirror of "what the host will put on the wire after a
 * restart") for each protocol family, then fold it through the matching
 * `*ToCore` codec so the projection lands in the same identity/fingerprint
 * space as the live request.
 *
 * This used to live as three hand-rolled builders in the omp plugin
 * (wire-fold.ts) — protocol knowledge scattered across consumers is exactly
 * how the issue-#64 class of restart divergences happened (one place fixed,
 * another broke). The wire layouts now live here, next to the codecs that
 * define their identity space.
 *
 * CONTRACT: the caller maps its own persisted message shape into
 * {@link MirrorMessage} FIRST and normalizes text there (e.g. ref-tag
 * stripping is a host-app concern, not a wire concern). Builders only apply
 * host-encoder wire rules:
 *   - thinking rides each wire the way the live encoder sends it
 *     (openai: `reasoning_content` field — hosts that demote inline as
 *     `<think>…</think>` land in the same identity space anyway because
 *     `openaiToCore` normalizes the inline form; anthropic: signed
 *     `{type:"thinking"}` blocks; responses: `{type:"reasoning"}` items);
 *   - whitespace-only text survives on the openai wire, is dropped on the
 *     anthropic/responses wires (host encoder behaviour);
 *   - tool calls/results map to each wire's native shape.
 */

export type MirrorBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "toolCall"; id?: string; name?: string; arguments?: unknown };

export type MirrorMessage = {
  /** `meta` is anything the host sends as out-of-band/system-ish traffic. */
  role: "user" | "assistant" | "toolResult" | "meta";
  blocks?: MirrorBlock[];
  /** toolResult only. */
  toolCallId?: string;
  /** meta only: extracted text or summary. */
  text?: string;
};

function textBlocks(blocks: MirrorBlock[] | undefined): string[] {
  const out: string[] = [];
  for (const b of blocks ?? []) if (b.type === "text") out.push(b.text);
  return out;
}

/** Openai wire text: text blocks joined with "\n" (whitespace-only kept). */
function joinText(blocks: MirrorBlock[] | undefined): string {
  return textBlocks(blocks).join("\n");
}

function thinkingText(blocks: MirrorBlock[] | undefined): string {
  return (
    blocks
      ?.filter((b) => b.type === "thinking" && b.thinking.trim().length > 0)
      .map((b) => (b as { thinking: string }).thinking)
      .join("\n") ?? ""
  );
}

/** Openai/completions mirror: system message first, then the conversation
 * with thinking as the `reasoning_content` field (issue #103). */
export function mirrorOpenaiMessages(
  view: MirrorMessage[],
  systemText: string,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemText },
  ];
  for (const message of view) {
    if (message.role === "user") {
      const text = joinText(message.blocks);
      if (text) messages.push({ role: "user", content: text });
    } else if (message.role === "assistant") {
      const calls = (message.blocks ?? []).filter(
        (b) => b.type === "toolCall",
      ) as Array<{ id?: string; name?: string; arguments?: unknown }>;
      const reasoning = thinkingText(message.blocks);
      const text = joinText(message.blocks);
      if (calls.length > 0) {
        messages.push({
          role: "assistant",
          content: text,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: {
              name: c.name ?? "",
              arguments: JSON.stringify(c.arguments ?? {}),
            },
          })),
        });
      } else if (text || reasoning) {
        messages.push({
          role: "assistant",
          content: text,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        });
      }
    } else if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: joinText(message.blocks),
      });
    } else {
      const text = message.text ?? "";
      if (text) messages.push({ role: "developer", content: text });
    }
  }
  return messages;
}

/** Anthropic/messages mirror: no system message (the live request carries it
 * as the top-level `system` field, out of the fold space — issue #64), tool
 * results folded into user messages, thinking as signed `{type:"thinking"}`
 * blocks (issue #103). Unsigned thinking is demoted to text by the live
 * encoder; sending it as a thinking block diverges, so callers that persist
 * unsigned thinking should send it as a text block instead. */
export function mirrorAnthropicMessages(
  view: MirrorMessage[],
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const message of view) {
    if (message.role === "user") {
      const text = joinText(message.blocks);
      if (text)
        messages.push({ role: "user", content: [{ type: "text", text }] });
    } else if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      for (const b of message.blocks ?? []) {
        if (b.type === "thinking" && b.thinking.trim().length > 0) {
          content.push({
            type: "thinking",
            thinking: b.thinking,
            ...(typeof b.signature === "string" && b.signature
              ? { signature: b.signature }
              : {}),
          });
        } else if (b.type === "text" && b.text.trim().length > 0) {
          content.push({ type: "text", text: b.text });
        } else if (b.type === "toolCall") {
          let input: unknown = {};
          try {
            input =
              b.arguments && typeof b.arguments === "object"
                ? b.arguments
                : JSON.parse(JSON.stringify(b.arguments ?? {}));
          } catch {
            input = {};
          }
          content.push({
            type: "tool_use",
            id: b.id,
            name: b.name ?? "",
            input,
          });
        }
      }
      if (content.length > 0) messages.push({ role: "assistant", content });
    } else if (message.role === "toolResult") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? "",
            content: joinText(message.blocks),
          },
        ],
      });
    } else {
      const text = message.text ?? "";
      if (text)
        messages.push({ role: "user", content: [{ type: "text", text }] });
    }
  }
  return messages;
}

/** Responses mirror: the live /v1/responses request carries the system
 * prompt in the top-level `instructions` field and the conversation as an
 * `input` item array (issue #64, responses variant). Assistant blocks are
 * emitted in content order so the core sequence matches the live wire
 * (issue #103 parity). */
export function mirrorResponsesInput(
  view: MirrorMessage[],
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of view) {
    if (message.role === "user") {
      const text = joinText(message.blocks);
      if (text)
        input.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        });
    } else if (message.role === "assistant") {
      for (const b of message.blocks ?? []) {
        if (b.type === "thinking" && b.thinking.trim().length > 0) {
          input.push({
            type: "reasoning",
            summary: [{ type: "summary_text", text: b.thinking }],
          });
        } else if (b.type === "text" && b.text.trim().length > 0) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: b.text }],
          });
        } else if (b.type === "toolCall") {
          let args = "{}";
          try {
            args = JSON.stringify(b.arguments ?? {});
          } catch {
            args = "{}";
          }
          input.push({
            type: "function_call",
            call_id: b.id ?? "",
            name: b.name ?? "",
            arguments: args,
          });
        }
      }
    } else if (message.role === "toolResult") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? "",
        output: joinText(message.blocks),
      });
    } else {
      const text = message.text ?? "";
      if (text)
        input.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        });
    }
  }
  return input;
}

/** Fold the openai mirror through `openaiToCore`. */
export function mirrorOpenaiToCore(
  view: MirrorMessage[],
  systemText: string,
): BiliMessage[] {
  const { msgs } = openaiToCore({
    model: "prime-fold",
    messages: mirrorOpenaiMessages(view, systemText) as Parameters<
      typeof openaiToCore
    >[0]["messages"],
  });
  return msgs;
}

/** Fold the anthropic mirror through `anthropicToCore`. */
export function mirrorAnthropicToCore(view: MirrorMessage[]): BiliMessage[] {
  const { msgs } = anthropicToCore({
    model: "prime-fold",
    messages: mirrorAnthropicMessages(view) as Parameters<
      typeof anthropicToCore
    >[0]["messages"],
  });
  return msgs;
}

/** Fold the responses mirror through `responsesToCore`. */
export function mirrorResponsesToCore(
  view: MirrorMessage[],
  systemText: string,
): BiliMessage[] {
  const { msgs } = responsesToCore({
    model: "prime-fold",
    instructions: systemText,
    input: mirrorResponsesInput(view) as Parameters<
      typeof responsesToCore
    >[0]["input"],
  });
  return msgs;
}
