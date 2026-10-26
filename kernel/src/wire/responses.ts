import type { CoreMessage } from "../types.js";
import { splitDemotedThinking } from "./demoted-thinking.js";
import { ClusterCounter } from "./message-id.js";
import {
  CANONICAL_IMAGE_TEXT,
  canonicalOpaqueSeed,
  canonicalToolArgs,
  deriveCanonicalMessageId,
  imageMediaFingerprint,
} from "./identity.js";
import type { ConversationIdentity } from "./util.js";
import { hashId } from "./util.js";
import { parseDataUrl, type BiliMessage } from "./bili-message.js";

export type ResponseContentPart =
  | { type: "input_text"; text: string; [key: string]: unknown }
  | { type: "output_text"; text: string; [key: string]: unknown }
  | { type: "input_image"; image_url: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export type ResponseInputMessage = {
  type: "message";
  role: "system" | "developer" | "user" | "assistant";
  content: string | ResponseContentPart[];
  [key: string]: unknown;
};

export type ResponseFunctionCall = {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  [key: string]: unknown;
};

export type ResponseFunctionCallOutput = {
  type: "function_call_output";
  call_id: string;
  output: string;
  [key: string]: unknown;
};

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionCall
  | ResponseFunctionCallOutput
  | { type: string; [key: string]: unknown };

export type ResponsesRequestBody = {
  model?: string;
  input: string | ResponseInputItem[];
  instructions?: string;
  tools?: unknown[];
  stream?: boolean;
  session_id?: string;
  previous_response_id?: string;
  prompt_cache_key?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

type ResponseLayoutSlot = {
  original: ResponseInputItem;
  coreId?: string;
  /** #3642: canonical granularity splits one wire item into one core per
   *  content part. `coreId` stays the FIRST core (insertion anchoring);
   *  `coreIds` lists every core this item produced so the patch/replay path
   *  can drop the item only when ALL of its cores are folded, and rebuild a
   *  partial view when only some are (never resurrecting folded parts). */
  coreIds?: string[];
};

export type ResponsesProjection = {
  msgs: BiliMessage[];
  systemParts: string[];
  preamble: ResponseInputItem[];
  customToolCallIds: Set<string>;
  layout: ResponseLayoutSlot[];
  stringInput?: { original: string; coreId: string };
  /** Reasoning items dropped because ACP_REASONING_KEEP=none. 0 by default —
   *  reasoning is normally routed through the compression pipeline so it is
   *  hidden automatically once its turn is summarized. */
  droppedReasoning: number;
};

/** Item types that are host DIRECTIVES (tool/definition listings), not
 *  conversation history: preserved verbatim and re-prepended at input[0..].
 *  `additional_tools` carries the Codex code_mode exec/wait tool definitions
 *  and MUST stay at input[0]. `mcp_list_tools` is a stable per-session listing.
 *
 *  Only definitions belong here. Output/action items from a prior response
 *  (reasoning, computer_call, function_call, mcp_call, ...) ARE conversation
 *  history and are routed as tracked BiliMessages, so the compression pipeline
 *  hides them once their turn is summarized — preserving them verbatim in the
 *  preamble instead made them accumulate unbounded every turn and broke Codex's
 *  prompt-cache prefix. */
const OPAQUE_ITEM_TYPES = new Set(["additional_tools", "mcp_list_tools"]);

function isOpaqueItem(item: ResponseInputItem): boolean {
  return OPAQUE_ITEM_TYPES.has(item.type);
}

const EASY_INPUT_ROLES = new Set(["user", "assistant", "system", "developer"]);

/** OpenAI's EasyInputMessage shorthand legally omits `type` (e.g. omp sends
 *  `{ role: "user", content: "..." }`); without normalization those items fall
 *  through the switch's `default` into the preamble and are never folded. */
function normalizeEasyInputItem(item: ResponseInputItem): ResponseInputItem {
  if (typeof item.type === "string") return item;
  if (EASY_INPUT_ROLES.has(String((item as { role?: unknown }).role))) {
    return {
      ...(item as { [key: string]: unknown }),
      type: "message",
    } as ResponseInputMessage;
  }
  return item;
}

function shouldDropAllReasoning(): boolean {
  return (process.env.ACP_REASONING_KEEP ?? "").trim().toLowerCase() === "none";
}

function partText(part: ResponseContentPart): string {
  if (part.type === "input_text" || part.type === "output_text") {
    return typeof part.text === "string" ? part.text : "";
  }
  return "";
}

/** #4166: text view of a system/developer message item's content — same
 *  flatten responsesToCore applies (string, or parts joined with "\n"). */
function responsesTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}

/** #4166: true when content is a plain string or an all-text parts array —
 *  the shapes whose bytes live entirely in `text`, so a kernel text rewrite
 *  can re-lay them out without losing anything. */
function isPlainResponsesContent(content: unknown): boolean {
  if (content == null || typeof content === "string") return true;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (p) =>
        p &&
        typeof p === "object" &&
        ((p as { type?: string }).type === "input_text" ||
          (p as { type?: string }).type === "output_text") &&
        typeof (p as { text?: unknown }).text === "string",
    )
  );
}

function messageContent(content: string | ResponseContentPart[]): string {
  return typeof content === "string"
    ? content
    : content.map(partText).join("\n");
}

/** Kernel-side text for a user item: its text as given, or the "[image]"
 *  placeholder (anthropic codec precedent) when it carries image parts but no
 *  real text part — note ≥2 image parts join into a truthy "\n" that is not
 *  text. SINGLE SOURCE OF TRUTH for the encode side (responsesToCore) and the
 *  decode-side verbatim condition (coreToResponses): the two sides must agree
 *  byte-for-byte or the raw-item round-trip silently degrades to a text-only
 *  rebuild (#187/#291). */
function userDisplayText(
  content: string | ResponseContentPart[],
  text: string,
): string {
  if (typeof content === "string") return text;
  const hasImage = content.some((part) => part.type === "input_image");
  const hasTextPart = content.some(
    (part) => part.type === "input_text" || part.type === "output_text",
  );
  return !text || (hasImage && !hasTextPart) ? "[image]" : text;
}

/** Extract the reasoning text from a responses reasoning item. The host
 *  carries it in `content` (reasoning_text parts); the primeFold mirror
 *  carries it in `summary` (summary_text parts). Both must yield the same
 *  text so the kernel derives the same core id (issue #64, responses). */
function reasoningText(item: ResponseInputItem): string {
  const fromParts = (parts: unknown, type: string): string => {
    if (!Array.isArray(parts)) return "";
    const texts: string[] = [];
    for (const part of parts) {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        "text" in part
      ) {
        const rec = part as { type: unknown; text: unknown };
        if (rec.type === type && typeof rec.text === "string")
          texts.push(rec.text);
      }
    }
    return texts.join("\n");
  };
  const content = "content" in item ? item.content : undefined;
  const summary = "summary" in item ? item.summary : undefined;
  return (
    fromParts(content, "reasoning_text") || fromParts(summary, "summary_text")
  );
}

export function responsesToCore(
  body: ResponsesRequestBody,
): ResponsesProjection {
  const msgs: BiliMessage[] = [];
  const systemParts: string[] = [];
  const preamble: ResponseInputItem[] = [];
  const customToolCallIds = new Set<string>();
  const layout: ResponseLayoutSlot[] = [];
  let droppedReasoning = 0;
  const clusters = new ClusterCounter();
  // Backfill toolName onto call outputs from their paired calls — kernel
  // guards are name-based. Not part of the identity seed (id stability).
  const toolNames = new Map<string, string>();
  let idx = 0;
  if (typeof body.instructions === "string" && body.instructions.trim())
    systemParts.push(body.instructions);
  if (typeof body.input === "string") {
    const id = clusters.next(
      deriveCanonicalMessageId("user", "text", body.input),
    );
    msgs.push({ id, role: "user", contentType: "text", text: body.input });
    return {
      msgs,
      systemParts,
      preamble,
      customToolCallIds,
      layout,
      droppedReasoning,
      stringInput: { original: body.input, coreId: id },
    };
  }
  let sysDevHead = true;
  for (const [wireIndex, raw] of body.input.entries()) {
    const item = normalizeEasyInputItem(raw);
    let coreId: string | undefined;
    const before = msgs.length;
    if (isOpaqueItem(item)) preamble.push(item);
    switch (item.type) {
      case "reasoning": {
        if (shouldDropAllReasoning()) {
          droppedReasoning++;
          continue;
        }
        // Key the reasoning piece on its TEXT (deterministic), consistent
        // with the anthropic/openai codecs. The host mints a per-request
        // item id that the primeFold mirror cannot reproduce; keying on it
        // put the mirror in a different ref/fingerprint space, so restart
        // replay rejected every in-stream compress call (issue #64,
        // responses variant).
        // #3642: an item with NO extractable text used to seed on the
        // provider's item id — unstable across resend. Seed on the
        // canonical opaque seed (item minus id/status, hashed) instead;
        // same bytes ⇒ same id in every future pass.
        const text = reasoningText(item);
        const rid = text.length > 0 ? text : canonicalOpaqueSeed(item);
        coreId = clusters.next(
          deriveCanonicalMessageId("assistant", "reasoning", rid),
        );
        msgs.push({
          id: coreId,
          role: "assistant",
          contentType: "reasoning",
          text: rid,
          rawResponsesItem: item,
        });
        break;
      }
      case "message": {
        const message = item as ResponseInputMessage;
        const text = messageContent(message.content);
        if (message.role === "system" || message.role === "developer") {
          if (sysDevHead) {
            systemParts.push(text);
            idx++;
            continue;
          }
          // #4166 (mirror of #3992): a MID-history system/developer item is
          // client data — position-preserve it as a sidecar core instead of
          // hoisting into systemParts (position destroyed + parts flattened).
          // The host #1638 re-typing trick covered plugin/codex clients only;
          // this is codec-native for every mode. Leading prefix still hoists
          // (strict single-system upstreams keep their merged head, #377).
          const midBase = deriveCanonicalMessageId(
            message.role,
            "text",
            text,
          );
          msgs.push({
            id: clusters.next(midBase),
            role: "system",
            contentType: "text",
            text,
            originalRole: message.role,
            rawResponsesItem: item,
          });
          break;
        } else if (
          message.role === "user" ||
          (message.role === "assistant" && text)
        ) {
          const role = message.role;
          // #3642 canonical granularity: split per content part (text parts
          // ⇒ text cores seeded on their own bytes; image parts ⇒ image
          // cores carrying the canonical "[image]" marker) so the same
          // logical conversation yields the same core ARRAY as every other
          // codec. Split text cores carry NO rawResponsesItem — the rebuild
          // run-accumulator decides verbatim-vs-filtered — while image
          // cores keep the raw item as their byte-fidelity sidecar. Messages
          // with unknown part types fall back to the legacy merged shape
          // (merged raw sidecar keeps unknown parts round-tripping,
          // openai #1205 class). Only USER messages split: assistant
          // message items in input are rare single-part text.
          const splittable =
            role === "user" &&
            Array.isArray(message.content) &&
            message.content.length > 1 &&
            message.content.every(
              (part) =>
                typeof part === "object" &&
                part !== null &&
                (part.type === "input_text" ||
                  part.type === "output_text" ||
                  part.type === "input_image"),
            );
          if (splittable) {
            for (const rawPart of message.content) {
              const part =
                typeof rawPart === "object" && rawPart !== null
                  ? rawPart
                  : undefined;
              if (!part) continue;
              if (
                (part.type === "input_text" || part.type === "output_text") &&
                typeof part.text === "string" &&
                part.text.length > 0
              ) {
                const base = deriveCanonicalMessageId(
                  "user",
                  "text",
                  part.text,
                );
                msgs.push({
                  id: clusters.next(base),
                  role: "user",
                  contentType: "text",
                  text: part.text,
                });
              } else if (
                part.type === "input_image" &&
                typeof part.image_url === "string"
              ) {
                const image = parseDataUrl(part.image_url);
                const base = deriveCanonicalMessageId(
                  "user",
                  "text",
                  CANONICAL_IMAGE_TEXT,
                  {
                    // #3751: payload-addressed ids — base64 payload when present, else URL.
                    mediaFingerprint: imageMediaFingerprint(
                      image ? image.base64 : part.image_url,
                    ),
                  },
                );
                msgs.push({
                  id: clusters.next(base),
                  role: "user",
                  contentType: "text",
                  text: CANONICAL_IMAGE_TEXT,
                  imagePart: true,
                  rawResponsesItem: item,
                  ...(image
                    ? {
                        imageMediaType: image.mediaType,
                        imageBase64: image.base64,
                      }
                    : {}),
                });
              }
            }
            break;
          }
          let effText = text;
          if (role === "assistant") {
            // Same normalization as openaiToCore: hosts that demote
            // prior-turn reasoning inline it as a dialect tag at the
            // head of the message text. Split it out before identity
            // derivation so the inline form and the separate
            // reasoning-item form of one turn share a single
            // core-id/fingerprint space.
            const split = splitDemotedThinking(text);
            if (split) {
              msgs.push({
                id: clusters.next(
                  deriveCanonicalMessageId(
                    "assistant",
                    "reasoning",
                    split.reasoning,
                  ),
                ),
                role: "assistant",
                contentType: "reasoning",
                text: split.reasoning,
                rawResponsesItem: item,
              });
              effText = split.text;
            }
          }
          // Image-only user items have no text of their own (≥2 image
          // parts join to a truthy "\n" — not real text). Track them
          // with the "[image]" placeholder so they enter the
          // compression space instead of vanishing from the rebuilt
          // input (#187/#291). displayText derives from effText
          // (post-split); for user items split never applies, so it
          // equals messageContent(content).
          const hasImage =
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === "input_image");
          if (effText || (role === "user" && hasImage)) {
            const displayText =
              role === "user"
                ? userDisplayText(message.content, effText)
                : effText;
            // #3751: payload-addressed ids — every input_image in the merged
            // shape contributes its fingerprint in order (single image ⇒ one
            // fingerprint, byte-identical to the split path's image core so
            // both forms of one logical message share one id; text-only legacy
            // cores keep their ids verbatim).
            const mediaFingerprint = Array.isArray(message.content)
              ? message.content
                  .flatMap((part) => {
                    if (
                      part?.type === "input_image" &&
                      typeof part.image_url === "string"
                    ) {
                      const raw = part.image_url;
                      const decoded = parseDataUrl(raw);
                      return [imageMediaFingerprint(decoded ? decoded.base64 : raw)];
                    }
                    return [];
                  })
                  .join(",") || undefined
              : undefined;
            coreId = clusters.next(
              deriveCanonicalMessageId(role, "text", displayText, {
                mediaFingerprint,
              }),
            );
            const imageUrl = Array.isArray(message.content)
              ? message.content.find(
                  (part) =>
                    part.type === "input_image" &&
                    typeof part.image_url === "string",
                )?.image_url
              : undefined;
            const image =
              typeof imageUrl === "string" ? parseDataUrl(imageUrl) : undefined;
            msgs.push({
              id: coreId,
              role,
              contentType: "text",
              text: displayText,
              rawResponsesItem: item,
              ...(image
                ? { imageMediaType: image.mediaType, imageBase64: image.base64 }
                : {}),
            });
          }
        }
        break;
      }
      case "function_call": {
        const call = item as ResponseFunctionCall;
        // #3642: canonical args in the seed (key-sorted, compact — same
        // normalization as the other codecs); the wire call_id stays on the
        // toolCallId FIELD (pairing) but is out of the seed.
        coreId = clusters.next(
          deriveCanonicalMessageId(
            "assistant",
            "tool-call",
            canonicalToolArgs(call.arguments ?? ""),
            { toolName: call.name },
          ),
        );
        msgs.push({
          id: coreId,
          role: "assistant",
          contentType: "tool-call",
          toolName: call.name,
          toolCallId: call.call_id,
          text: call.arguments ?? "",
          rawResponsesItem: item,
        });
        toolNames.set(call.call_id, call.name);
        break;
      }
      case "function_call_output": {
        const output = item as ResponseFunctionCallOutput;
        const text =
          typeof output.output === "string"
            ? output.output
            : JSON.stringify(output.output);
        coreId = clusters.next(
          deriveCanonicalMessageId("tool", "tool-result", text, {
            toolName: toolNames.get(output.call_id),
          }),
        );
        const name = toolNames.get(output.call_id);
        msgs.push({
          id: coreId,
          role: "tool",
          contentType: "tool-result",
          toolCallId: output.call_id,
          text,
          ...(name ? { toolName: name } : {}),
          rawResponsesItem: item,
        });
        break;
      }
      case "computer_call":
      case "computer_call_output":
      case "file_search_call":
      case "web_search_call":
      case "image_generation_call":
      case "code_interpreter_call":
      case "mcp_call": {
        // #3642: the provider's item id is unstable across resends — seed
        // on the canonical opaque seed (item minus id/status) instead.
        const rid = canonicalOpaqueSeed(item);
        coreId = clusters.next(
          deriveCanonicalMessageId("assistant", "responses-call", rid),
        );
        msgs.push({
          id: coreId,
          role: "assistant",
          contentType: "reasoning",
          text: rid,
          rawResponsesItem: item,
        });
        break;
      }
      case "custom_tool_call": {
        const ctc = item as {
          call_id?: string;
          name?: string;
          input?: string;
          arguments?: string;
        };
        const callId = ctc.call_id ?? `call_${idx}`;
        customToolCallIds.add(callId);
        const argText = ctc.input ?? ctc.arguments ?? "";
        coreId = clusters.next(
          deriveCanonicalMessageId("assistant", "tool-call", argText, {
            toolName: ctc.name ?? "custom",
          }),
        );
        msgs.push({
          id: coreId,
          role: "assistant",
          contentType: "tool-call",
          toolName: ctc.name ?? "custom",
          toolCallId: callId,
          text: argText,
          rawResponsesItem: item,
        });
        toolNames.set(callId, ctc.name ?? "custom");
        break;
      }
      case "custom_tool_call_output": {
        const ctco = item as { call_id?: string; output?: string };
        const callId = ctco.call_id ?? `call_${idx}`;
        customToolCallIds.add(callId);
        const outText =
          typeof ctco.output === "string"
            ? ctco.output
            : JSON.stringify(ctco.output ?? "");
        coreId = clusters.next(
          deriveCanonicalMessageId("tool", "tool-result", outText, {
            toolName: toolNames.get(callId),
          }),
        );
        const name = toolNames.get(callId);
        msgs.push({
          id: coreId,
          role: "tool",
          contentType: "tool-result",
          toolCallId: callId,
          text: outText,
          ...(name ? { toolName: name } : {}),
          rawResponsesItem: item,
        });
        break;
      }
      default:
        if (!isOpaqueItem(item)) preamble.push(item);
        break;
    }
    for (let k = before; k < msgs.length; k++) {
      msgs[k]!.wireIndex = wireIndex;
    }
    // #4166: the sys/dev hoisting head lasts only until the first
    // CONVERSATION item lands — mirroring the host #1638 head rule:
    // sys/dev message items and the head-neutral tooling declarations
    // (additional_tools / mcp_list_tools) do not break the head; anything
    // else does. Mid-history system/developer items after that become
    // positioned sidecar cores.
    const role = (item as { role?: unknown }).role;
    const isSysDevMsgItem =
      (item.type === undefined || item.type === "message") &&
      (role === "system" || role === "developer");
    if (
      !isSysDevMsgItem &&
      item.type !== "additional_tools" &&
      item.type !== "mcp_list_tools"
    )
      sysDevHead = false;
    const produced = msgs.slice(before).map((m) => m.id);
    layout.push({
      original: item,
      ...(produced.length > 0 ? { coreId: produced[0] } : {}),
      ...(produced.length > 1 ? { coreIds: produced } : {}),
    });
    idx++;
  }
  return {
    msgs,
    systemParts,
    preamble,
    customToolCallIds,
    layout,
    droppedReasoning,
  };
}

function patchTextParts(
  parts: ResponseContentPart[],
  text: string,
): ResponseContentPart[] {
  const textIndexes = parts.flatMap((part, index) =>
    part.type === "input_text" || part.type === "output_text" ? [index] : [],
  );
  if (textIndexes.length === 0) return [{ type: "input_text", text }, ...parts];
  const first = textIndexes[0];
  const remaining = new Set(textIndexes.slice(1));
  // Consolidate all text into the FIRST text part and DROP the others — never
  // leave them as text:"" placeholders: strict Responses backends reject an
  // empty input_text.text with 400 "text is required" (#3089).
  const out: ResponseContentPart[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part || remaining.has(index)) continue;
    out.push(index === first ? { ...part, text } : part);
  }
  return out;
}

function patchOriginalItem(
  original: ResponseInputItem,
  source: CoreMessage,
  next: CoreMessage,
): ResponseInputItem {
  if (
    source.text === next.text &&
    source.toolName === next.toolName &&
    source.toolCallId === next.toolCallId &&
    source.role === next.role &&
    source.contentType === next.contentType
  )
    return original;
  if (original.type === "message") {
    const message = original as ResponseInputMessage;
    const content =
      typeof message.content === "string"
        ? (next.text ?? "")
        : patchTextParts(message.content, next.text ?? "");
    return { ...message, content };
  }
  if (original.type === "function_call") {
    return {
      ...original,
      name: next.toolName ?? String(original.name ?? "unknown"),
      call_id: next.toolCallId ?? String(original.call_id ?? ""),
      arguments: next.text ?? "",
    };
  }
  if (original.type === "function_call_output") {
    return {
      ...original,
      call_id: next.toolCallId ?? String(original.call_id ?? ""),
      output: next.text ?? "",
    };
  }
  return original;
}

export function patchResponsesInput(
  projection: ResponsesProjection,
  messages: CoreMessage[],
): string | ResponseInputItem[] {
  if (projection.stringInput) {
    const original = projection.msgs.find(
      (message) => message.id === projection.stringInput?.coreId,
    );
    const next = messages.find(
      (message) => message.id === projection.stringInput?.coreId,
    );
    if (
      original &&
      next &&
      messages.length === 1 &&
      next.role === "user" &&
      next.contentType === "text"
    ) {
      return next.text === original.text
        ? projection.stringInput.original
        : (next.text ?? "");
    }
    return coreToResponses(messages, projection.customToolCallIds);
  }
  const sourceById = new Map(
    projection.msgs.map((message) => [message.id, message]),
  );
  const nextById = new Map(messages.map((message) => [message.id, message]));
  const slotById = new Map<string, number>();
  projection.layout.forEach((slot, index) => {
    if (slot.coreId) slotById.set(slot.coreId, index);
  });
  const insertions = new Map<number, ResponseInputItem[]>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (sourceById.has(message.id)) continue;
    let target = projection.layout.length;
    for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex++) {
      const slot = slotById.get(messages[nextIndex]!.id);
      if (slot !== undefined) {
        target = slot;
        break;
      }
    }
    const generated = coreToResponses([message], projection.customToolCallIds);
    if (generated.length > 0)
      insertions.set(target, [...(insertions.get(target) ?? []), ...generated]);
  }
  const out: ResponseInputItem[] = [];
  projection.layout.forEach((slot, index) => {
    out.push(...(insertions.get(index) ?? []));
    if (slot.coreIds && slot.coreIds.length > 1) {
      // #3642 split item: drop only when ALL cores folded; partial survival
      // rebuilds a filtered view (never resurrecting folded parts).
      const entries = slot.coreIds.map((id) => ({
        core: sourceById.get(id),
        next: nextById.get(id),
      }));
      if (entries.every((entry) => entry.next === undefined)) return;
      const original = slot.original as ResponseInputMessage;
      const allSurvive = entries.every((entry) => entry.next !== undefined);
      const changed = entries.some(
        (entry) =>
          entry.core &&
          entry.next &&
          (entry.core.text ?? "") !== (entry.next.text ?? ""),
      );
      if (allSurvive && !changed) {
        out.push(slot.original);
        return;
      }
      const imageParts = Array.isArray(original.content)
        ? original.content.filter((part) => part.type === "input_image")
        : [];
      let img = 0;
      const parts: ResponseContentPart[] = [];
      for (const entry of entries) {
        if (!entry.next) continue;
        const bili = entry.next as BiliMessage;
        // The SOURCE core decides image-ness: render/ref-tag injection may
        // rewrite the marker text, and a wire image part has no text slot.
        if (entry.core?.imagePart || bili.text === CANONICAL_IMAGE_TEXT) {
          const part = imageParts[img++];
          if (part) parts.push(part);
        } else if (bili.text) {
          parts.push({ type: "input_text", text: bili.text });
        }
      }
      if (parts.length > 0)
        out.push({ ...original, content: parts } as ResponseInputItem);
      return;
    }
    if (!slot.coreId) {
      out.push(slot.original);
      return;
    }
    const source = sourceById.get(slot.coreId);
    const next = nextById.get(slot.coreId);
    if (source && next)
      out.push(patchOriginalItem(slot.original, source, next));
  });
  out.push(...(insertions.get(projection.layout.length) ?? []));
  return out;
}

export function coreToResponses(
  messages: CoreMessage[],
  customToolCallIds: Set<string> = new Set(),
): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  // #3642: canonical granularity splits one user item into one core per
  // part, so consecutive user cores are a RUN that rebuilds as ONE wire
  // item. Full coverage (every part's core present, run length == part
  // count) rebuilds the original item VERBATIM — byte-exact for the
  // untouched case. A partial run (some parts' cores folded away) rebuilds
  // a FILTERED view: only the surviving parts, never resurrecting folded
  // content from the raw sidecar.
  const flushUserRun = (run: CoreMessage[]) => {
    if (run.length === 0) return;
    if (run.length === 1) {
      const message = run[0]!;
      const raw = (message as BiliMessage)
        .rawResponsesItem as ResponseInputItem | undefined;
      const rawMessage =
        raw?.type === "message" ? (raw as ResponseInputMessage) : undefined;
      if (
        rawMessage &&
        userDisplayText(
          rawMessage.content,
          messageContent(rawMessage.content),
        ) === (message.text ?? "")
      )
        out.push(rawMessage);
      else if (
        ((message as BiliMessage).imagePart ||
          (message as BiliMessage).text === CANONICAL_IMAGE_TEXT) &&
        rawMessage &&
        Array.isArray(rawMessage.content)
      )
        out.push({
          type: "message",
          role: "user",
          content: rawMessage.content.filter(
            (part) => part.type === "input_image",
          ),
        });
      else
        out.push({
          type: "message",
          role: "user",
          content: message.text ?? "",
        });
      return;
    }
    const rawCarrier = run.find(
      (m) => (m as BiliMessage).rawResponsesItem !== undefined,
    ) as BiliMessage | undefined;
    const rawItem = rawCarrier?.rawResponsesItem as
      | ResponseInputItem
      | undefined;
    const rawMessage =
      rawItem?.type === "message"
        ? (rawItem as ResponseInputMessage)
        : undefined;
    const fullCover =
      rawMessage &&
      Array.isArray(rawMessage.content) &&
      rawMessage.content.length === run.length;
    if (fullCover && rawMessage) {
      out.push(rawMessage);
      return;
    }
    const imageParts =
      rawMessage && Array.isArray(rawMessage.content)
        ? rawMessage.content.filter((part) => part.type === "input_image")
        : [];
    let img = 0;
    const parts: ResponseContentPart[] = [];
    for (const message of run) {
      const bili = message as BiliMessage;
      // Image-ness is structural (parse-time flag), never text equality:
      // render/ref-tag injection rewrites the marker, and image parts have
      // no text slot to carry a tag.
      if (bili.imagePart && bili.rawResponsesItem) {
        const part = imageParts[img++];
        if (part) parts.push(part);
      } else if (bili.text) {
        parts.push({ type: "input_text", text: bili.text });
      }
    }
    out.push({
      type: "message",
      role: "user",
      content: parts.length > 0 ? parts : "",
    });
  };
  let userRun: CoreMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      userRun.push(message);
      continue;
    }
    flushUserRun(userRun);
    userRun = [];
    const biliMessage = message as BiliMessage;
    const raw = biliMessage.rawResponsesItem as ResponseInputItem | undefined;
    if (message.role === "system") {
      // #4166: a client mid-history system/developer item re-emits its raw
      // item byte-exact (position + structured parts). Kernel text rewrites
      // (emergency truncation) re-lay plain-text content; structured items
      // are unfoldable-by-protection, so verbatim still. Cores WITHOUT a
      // sidecar are kernel-rendered summary carriers — keep the legacy
      // developer rebuild (their wire shape is golden-pinned).
      const rawMsg = raw as
        | { type?: string; role?: string; content?: unknown }
        | undefined;
      const isSysDevRaw =
        rawMsg != null &&
        (rawMsg.type === undefined || rawMsg.type === "message") &&
        (rawMsg.role === "system" || rawMsg.role === "developer");
      if (isSysDevRaw) {
        const text = message.text ?? "";
        if (
          text !== responsesTextOf(rawMsg.content) &&
          isPlainResponsesContent(rawMsg.content)
        ) {
          out.push({
            type: "message",
            role: rawMsg.role,
            content:
              typeof rawMsg.content === "string"
                ? text
                : [{ type: "input_text", text }],
          } as ResponseInputItem);
        } else {
          out.push(raw as ResponseInputItem);
        }
      } else {
        out.push({
          type: "message",
          role: "developer",
          content: message.text ?? "",
        });
      }
      } else if (message.role === "assistant") {
      if (message.contentType === "text") {
        out.push({
          type: "message",
          role: "assistant",
          content: message.text ?? "",
        });
      } else if (message.contentType === "tool-call") {
        const callId = message.toolCallId ?? `call_${message.id}`;
        if (customToolCallIds.has(callId)) {
          out.push({
            type: "custom_tool_call",
            call_id: callId,
            name: message.toolName ?? "unknown",
            input: message.text ?? "",
            status: "completed",
          } as ResponseInputItem);
        } else {
          out.push({
            type: "function_call",
            call_id: callId,
            name: message.toolName ?? "unknown",
            arguments: message.text ?? "",
          });
        }
      } else if (message.contentType === "reasoning") {
        if (raw) out.push(raw);
      }
    } else if (message.role === "tool") {
      const callId = message.toolCallId ?? "";
      if (customToolCallIds.has(callId)) {
        out.push({
          type: "custom_tool_call_output",
          call_id: callId,
          output: message.text ?? "",
        } as ResponseInputItem);
      } else {
        out.push({
          type: "function_call_output",
          call_id: callId,
          output: message.text ?? "",
        });
      }
    }
  }
  flushUserRun(userRun);
  return out;
}

export function injectResponsesDeveloperMessage(
  input: string | ResponseInputItem[],
  content: string,
): ResponseInputItem[] {
  const items: ResponseInputItem[] =
    typeof input === "string"
      ? [{ type: "message", role: "user", content: input }]
      : [...input];
  let index = 0;
  while (items[index]?.type === "additional_tools") index++;
  items.splice(index, 0, { type: "message", role: "developer", content });
  return items;
}

export function conversationIdentityResponses(
  body: ResponsesRequestBody,
  headerValue?: string,
): ConversationIdentity {
  if (headerValue?.trim())
    return {
      value: headerValue.trim(),
      source: "header",
      clientProvided: true,
    };
  if (typeof body.session_id === "string" && body.session_id.trim()) {
    return {
      value: body.session_id.trim(),
      source: "body-session",
      clientProvided: true,
    };
  }
  const metadataSession = body.metadata?.session_id;
  if (typeof metadataSession === "string" && metadataSession.trim()) {
    return {
      value: metadataSession.trim(),
      source: "metadata-session",
      clientProvided: true,
    };
  }
  if (
    typeof body.previous_response_id === "string" &&
    body.previous_response_id.trim()
  ) {
    return {
      value: body.previous_response_id.trim(),
      source: "previous-response",
      clientProvided: false,
    };
  }
  return {
    value: hashId(JSON.stringify(body.input ?? [])),
    source: "content-fingerprint",
    clientProvided: false,
  };
}

export function conversationSignalResponses(
  body: ResponsesRequestBody,
  headerValue?: string,
): string {
  return conversationIdentityResponses(body, headerValue).value;
}

// Codex subagents (guardian approval reviewer, etc.) reuse the main
// conversation's body.session_id, so identity alone collapses their requests
// onto the main session's compression state — a compressed subagent request
// loses the verbatim user authorization it must read back (#150). Subagent
// requests carry their own `instructions` (the agent's role prompt), so the
// FIRST instructions seen for an identity anchor the main namespace (it never
// changes for the conversation, even if the main prompt drifts), and any other
// instructions value maps to a separate `|sub:` namespace with its own empty
// compression state. Subagent requests are self-contained replays, so the
// fresh namespace is lossless.
export interface SubagentNamespaces {
  /** Resolve the compression-state namespace for a request: the identity
   *  itself for the anchored (main) instructions, `identity|sub:<fp>` for
   *  any other instructions value. First-seen instructions anchor. */
  namespaceFor(identityValue: string, instructions: unknown): string;
}

/** Host-owned subagent-namespace store.
 *
 * The anchor map is per-conversation mutable state, so it belongs to the
 * host — NOT to a library module global. Create one instance and keep it for
 * the process lifetime (or persist it alongside your session store if you
 * need namespaces to survive restarts: a fresh instance re-anchors on the
 * first request it sees, which after a restart may be a subagent request,
 * orphaning the main conversation's stored compression state). */
export function createSubagentNamespaces(): SubagentNamespaces {
  const anchors = new Map<string, string>();
  return {
    namespaceFor(identityValue: string, instructions: unknown): string {
      if (typeof instructions !== "string" || instructions.trim().length === 0)
        return identityValue;
      const fp = hashId(instructions);
      const anchor = anchors.get(identityValue);
      if (anchor === undefined) {
        anchors.set(identityValue, fp);
        return identityValue;
      }
      return anchor === fp ? identityValue : `${identityValue}|sub:${fp}`;
    },
  };
}

// Convenience singleton for single-process proxies that don't manage
// per-session state themselves. Hosts needing isolation between
// conversations, deterministic namespaces across restarts, or a bound on
// anchor memory should create their own instance via
// createSubagentNamespaces() and own its lifecycle.
const defaultNamespaces = createSubagentNamespaces();

export function subagentNamespace(
  identityValue: string,
  instructions: unknown,
): string {
  return defaultNamespaces.namespaceFor(identityValue, instructions);
}
