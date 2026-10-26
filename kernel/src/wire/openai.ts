import { splitDemotedThinking } from "./demoted-thinking.js";
import { isSummaryMessageId } from "../prune.js";
import {
  CANONICAL_IMAGE_TEXT,
  canonicalToolArgs,
  deriveCanonicalMessageId,
  imageMediaFingerprint,
} from "./identity.js";
import { hashId } from "./util.js";
import { ClusterCounter } from "./message-id.js";
import { parseDataUrl, type BiliMessage } from "./bili-message.js";

/** #3751: ordered image fingerprints for a legacy plural-sidecar part list —
 *  data-URL images hash their base64 payload, URL images hash the URL,
 *  non-image parts contribute nothing (the legacy id of an image-free opaque
 *  core is preserved verbatim). */
function imageFingerprintsOfParts(parts: unknown[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: unknown; image_url?: { url?: unknown } };
    if (p.type !== "image_url") continue;
    const url = typeof p.image_url?.url === "string" ? p.image_url.url : undefined;
    if (!url) continue;
    const parsed = parseDataUrl(url);
    out.push(imageMediaFingerprint(parsed ? parsed.base64 : url));
  }
  return out;
}

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: string; [k: string]: unknown };

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAIMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | null | OpenAIContentPart[];
  reasoning_content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type OpenAITool = {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
};

export type OpenAIRequestBody = {
  model?: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  stream?: boolean;
  [key: string]: unknown;
};

type Flat = { msgs: BiliMessage[]; systemText: string };

/** Hoist the contiguous leading system/developer prefix out of the fold
 *  space (openai-chat variant of the responses codec's systemParts and the
 *  anthropic codec's top-level `system` field). The system prompt is host
 *  runtime state: its content varies across restarts (injected reminders,
 *  host-composed instructions), so keeping it inside the id space made every
 *  downstream fingerprint spanning it unstable, and a compress range that
 *  covered it removed the model's system prompt from the rebuilt wire
 *  entirely. Mid-conversation system messages (rare, host-synthetic) stay in
 *  the fold space unchanged. */
export function openaiToCore(body: OpenAIRequestBody): Flat {
  const msgs: BiliMessage[] = [];
  const systemParts: string[] = [];
  const clusters = new ClusterCounter();
  // Backfill toolName onto role:"tool" results from their paired tool_call —
  // kernel guards are name-based. Not part of the identity seed (id stability).
  const toolNames = new Map<string, string>();
  for (const [wireIndex, m] of body.messages.entries()) {
    const before = msgs.length;
    switch (m.role) {
      case "system":
      case "developer": {
        if (msgs.length === 0) {
          systemParts.push(stringContent(m.content));
          break;
        }
        // #4166 (mirror of #3992 on the anthropic wire): a mid-history
        // system/developer message is CLIENT DATA — keep the raw wire
        // message as a verbatim sidecar so coreToOpenai re-emits it
        // byte-exact (structured parts — DSH tool_addition-style blocks —
        // survive instead of being stringContent-flattened away). Kernel
        // text ops (truncation, matching) still ride `text`.
        const base = deriveCanonicalMessageId(
          m.role,
          "text",
          stringContent(m.content),
        );
        msgs.push({
          id: clusters.next(base),
          role: "system",
          contentType: "text",
          text: stringContent(m.content),
          originalRole: m.role,
          rawOpenaiMessage: m,
        } as BiliMessage);
        break;
      }
      case "user": {
        // #3642 canonical granularity: every content part is its own core
        // (the anthropic codec's model), so the same logical conversation
        // yields the same core ARRAY — ids AND counts — in every protocol.
        // Text parts become text cores; each image part becomes its own
        // image core (text = the canonical "[image]" marker, byte-fidelity
        // via the sidecars); unknown opaque parts (DeepSeek file refs,
        // #1205) attach to the preceding text core's plural sidecar so they
        // still round-trip verbatim. A message with only opaque parts keeps
        // the legacy single-core shape (text "" + plural sidecar).
        // Non-array non-string content (a lone part object, or any
        // degenerate shape some client emits) cannot be iterated — fall
        // through to the legacy empty-text core instead of throwing (#2824
        // corpus: wire tolerance). Legacy byte-compat: the pre-#3642 codec
        // mapped such messages to stringContent(content) === "" with no
        // sidecars, and ids seeded from "" stay identical.
        if (typeof m.content === "string" || m.content == null || !Array.isArray(m.content)) {
          const base = deriveCanonicalMessageId(
            "user",
            "text",
            typeof m.content === "string" ? m.content : "",
          );
          msgs.push({
            id: clusters.next(base),
            role: "user",
            contentType: "text",
            text: typeof m.content === "string" ? m.content : "",
          });
          break;
        }
        let lastTextCore: BiliMessage | null = null;
        let leadingOpaque: OpenAIContentPart[] | [] = [];
        let sawText = false;
        for (const part of m.content) {
          if (typeof part === "string") {
            const base = deriveCanonicalMessageId("user", "text", part);
            lastTextCore = {
              id: clusters.next(base),
              role: "user",
              contentType: "text",
              text: part,
            };
            msgs.push(lastTextCore);
            sawText = true;
            continue;
          }
          if (part?.type === "text" && typeof part.text === "string") {
            const base = deriveCanonicalMessageId("user", "text", part.text);
            lastTextCore = {
              id: clusters.next(base),
              role: "user",
              contentType: "text",
              text: part.text,
            };
            msgs.push(lastTextCore);
            sawText = true;
            continue;
          }
          if (part?.type === "image_url") {
            const url =
              (part as { image_url?: { url?: unknown } }).image_url?.url;
            const parsed =
              typeof url === "string" ? parseDataUrl(url) : undefined;
            const base = deriveCanonicalMessageId("user", "text", CANONICAL_IMAGE_TEXT, {
              // #3751: payload-addressed ids — data images hash their bytes,
              // URL images degrade to the URL string.
              mediaFingerprint: imageMediaFingerprint(
                parsed ? parsed.base64 : typeof url === "string" ? url : "",
              ),
            });
            msgs.push({
              id: clusters.next(base),
              role: "user",
              contentType: "text",
              text: CANONICAL_IMAGE_TEXT,
              imagePart: true,
              rawOpenaiContent: part,
              ...(parsed
                ? {
                    imageMediaType: parsed.mediaType,
                    imageBase64: parsed.base64,
                  }
                : {}),
            });
            continue;
          }
          // Unknown opaque part: never dropped (#1205). Attach to the
          // preceding text core; parts seen before any text core wait for
          // the first one so the rebuild's part order matches the wire.
          if (lastTextCore) {
            lastTextCore.rawOpenaiContentParts = [
              ...(lastTextCore.rawOpenaiContentParts ?? []),
              part,
            ];
          } else {
            leadingOpaque = [...leadingOpaque, part];
          }
        }
        if (leadingOpaque.length > 0) {
          if (sawText && msgs.length > 0) {
            const firstTextCore = msgs.find(
              (c, i) =>
                i >= before &&
                c.role === "user" &&
                c.contentType === "text" &&
                !c.rawOpenaiContent,
            );
            const host = firstTextCore ?? msgs[msgs.length - 1]!;
            // PREPEND: the host may already carry opaque parts accumulated
            // after it during the loop ([opaque, text, opaque]) — assigning
            // would silently drop them (#1205: unknown parts never dropped).
            host.rawOpenaiContentParts = [
              ...leadingOpaque,
              ...(host.rawOpenaiContentParts ?? []),
            ];
          } else {
            const base = deriveCanonicalMessageId("user", "text", "", {
              // #3751: the legacy plural core gets the ordered join of its
              // image fingerprints (if any) — zero images keeps the legacy id.
              mediaFingerprint: imageFingerprintsOfParts(leadingOpaque).join(",") || undefined,
            });
            msgs.push({
              id: clusters.next(base),
              role: "user",
              contentType: "text",
              text: "",
              rawOpenaiContentParts: leadingOpaque,
            });
          }
        }
        break;
      }
      case "assistant": {
        const rawReasoning = m.reasoning_content;
        const fieldPresent = typeof rawReasoning === "string";
        const fieldReasoning = fieldPresent ? rawReasoning : "";
        let reasoning = fieldReasoning;
        let text = stringContent(m.content);
        if (!reasoning) {
          // Hosts that cannot replay prior-turn reasoning as a
          // structured field inline it into content wrapped in a
          // dialect tag (<think>, <thinking>, ```thinking). Split
          // it back out BEFORE identity derivation so the inline
          // form and the reasoning_content field form of one turn
          // land in a single core-id/fingerprint space (issue #64
          // demoted variant).
          const split = splitDemotedThinking(text);
          if (split) {
            reasoning = split.reasoning;
            text = split.text;
          }
        }
        // Blank field, nothing inline: the host sent the key with an
        // empty value. Record that on the cores so coreToOpenai
        // re-emits the key instead of dropping it — strict-echo
        // thinking models reject the key's absence, not its emptiness.
        const blankEcho = fieldPresent && reasoning.length === 0;
        if (reasoning) {
          const base = deriveCanonicalMessageId(
            "assistant",
            "reasoning",
            reasoning,
          );
          msgs.push({
            id: clusters.next(base),
            role: "assistant",
            contentType: "reasoning",
            text: reasoning,
            reasoningContent: reasoning,
          });
        }
        if (text) {
          const base = deriveCanonicalMessageId("assistant", "text", text);
          msgs.push({
            id: clusters.next(base),
            role: "assistant",
            contentType: "text",
            text,
            ...(blankEcho ? { reasoningPresent: true } : {}),
          });
        }
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            // #3642: canonical args in the seed, wire toolCallId out of it
            // (transport plumbing, not content). `text` keeps the host's
            // verbatim arguments string so coreToOpenai rebuilds it
            // byte-stable.
            const base = deriveCanonicalMessageId(
              "assistant",
              "tool-call",
              canonicalToolArgs(tc.function.arguments ?? ""),
              { toolName: tc.function.name },
            );
            msgs.push({
              id: clusters.next(base),
              role: "assistant",
              contentType: "tool-call",
              toolName: tc.function.name,
              toolCallId: tc.id,
              text: tc.function.arguments ?? "",
              ...(blankEcho ? { reasoningPresent: true } : {}),
            });
            toolNames.set(tc.id, tc.function.name);
          }
        }
        break;
      }
      case "tool": {
        // #3642: canonical result identity = toolName + text; the wire
        // tool_call_id is out of the seed (transport plumbing).
        const base = deriveCanonicalMessageId(
          "tool",
          "tool-result",
          stringContent(m.content),
          { toolName: m.name || toolNames.get(m.tool_call_id ?? "") },
        );
        const name = m.name || toolNames.get(m.tool_call_id ?? "");
        msgs.push({
          id: clusters.next(base),
          role: "tool",
          contentType: "tool-result",
          toolCallId: m.tool_call_id ?? "",
          text: stringContent(m.content),
          ...(name ? { toolName: name } : {}),
        });
        break;
      }
    }
    for (let k = before; k < msgs.length; k++) {
      msgs[k]!.wireIndex = wireIndex;
    }
  }
  return { msgs, systemText: systemParts.join("\n\n") };
}

/** Rebuild OpenAI Chat messages from kernel messages.
 *
 * Byte-stability contract (#3938 / #3939⑥): this function is PURE in the
 * core array — the same logical shape must serialize to identical bytes on
 * every request, because any drift breaks the upstream prefix cache
 * mid-session. The canonical emission for a user run is FIXED: a lone
 * plain-text run rebuilds as string content; any run carrying sidecars
 * rebuilds as a parts array in CORE order where each sidecar core emits its
 * text first, then its rawOpenaiContentParts in array order. The parse side
 * (openaiToCore's leading-opaque PREPEND) makes that order stable for
 * [opaque, text, opaque] shapes: every opaque part lands on one text core,
 * so the rebuild always emits [text, opq1, opq2] regardless of the input
 * interleaving. Do not reorder this emission without moving the pins in
 * kernel/tests/issue3939-wire-byte-stability.test.ts. */
export function coreToOpenai(messages: BiliMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  let userRun: BiliMessage[] = [];
  // #3642: rebuild a run of consecutive user cores as ONE wire message —
  // parts array when any core carries media/opaque sidecars, plain string
  // when the run is a lone text core (the dominant shape stays
  // byte-identical to the legacy codec's output).
  const flushUserRun = () => {
    if (userRun.length === 0) return;
    const parts: OpenAIContentPart[] = [];
    let plain = true;
    for (const m of userRun) {
      if (m.rawOpenaiContentParts && m.rawOpenaiContentParts.length > 0) {
        if (m.text) parts.push({ type: "text", text: m.text });
        for (const part of m.rawOpenaiContentParts)
          parts.push(part as OpenAIContentPart);
        plain = false;
      } else if (m.rawOpenaiContent) {
        if (m.text && !m.imagePart)
          parts.push({ type: "text", text: m.text });
        parts.push(m.rawOpenaiContent as OpenAIContentPart);
        plain = false;
      } else if (m.imageBase64 && m.imageMediaType) {
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${m.imageMediaType};base64,${m.imageBase64}`,
          },
        });
        plain = false;
      } else {
        parts.push({ type: "text", text: m.text ?? "" });
      }
    }
    if (plain && userRun.length === 1) {
      out.push({ role: "user", content: userRun[0]!.text ?? "" });
    } else {
      out.push({ role: "user", content: parts });
    }
    userRun = [];
  };
  let pending: {
    text: string | null;
    toolCalls: OpenAIToolCall[];
    reasoning: string | null;
    reasoningPresent: boolean;
  } | null = null;
  const flush = () => {
    if (!pending) return;
    const reasoning =
      pending.reasoning !== null && pending.reasoning.length > 0
        ? pending.reasoning
        : undefined;
    // A blank field means the host sent the key with an empty value and
    // expects it back: strict-echo thinking models reject its absence.
    const reasoningField =
      reasoning !== undefined
        ? { reasoning_content: reasoning }
        : pending.reasoningPresent
          ? { reasoning_content: "" }
          : {};
    if (pending.toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: pending.text ?? null,
        tool_calls: pending.toolCalls,
        ...reasoningField,
      });
    } else if (pending.text !== null) {
      out.push({ role: "assistant", content: pending.text, ...reasoningField });
    } else if (reasoning) {
      out.push({
        role: "assistant",
        content: null,
        reasoning_content: reasoning,
      });
    }
    pending = null;
  };
  for (const m of messages) {
    if (m.role === "assistant") {
      // An assistant core NEVER joins a user run — flush the run first so
      // emission order always matches core order (a run left open across an
      // assistant turn would emit after it and scramble the conversation).
      flushUserRun();
      if (!pending)
        pending = {
          text: null,
          toolCalls: [],
          reasoning: null,
          reasoningPresent: false,
        };
      if (m.reasoningPresent) pending.reasoningPresent = true;
      if (m.contentType === "reasoning") {
        pending.reasoning =
          (pending.reasoning ?? "") + (m.reasoningContent ?? m.text ?? "");
      } else if (m.contentType === "text") {
        pending.text = (pending.text ?? "") + (m.text ?? "");
      } else if (m.contentType === "tool-call") {
        pending.toolCalls.push({
          id: m.toolCallId ?? `call_${m.id}`,
          type: "function",
          function: { name: m.toolName ?? "unknown", arguments: m.text ?? "" },
        });
      }
    } else {
      if (m.role !== "user") {
        // A user message never terminates the user run — consecutive user
        // cores accumulate into ONE wire message (#3642). Everything else
        // (system/tool) closes the run first.
        flush();
        flushUserRun();
      }
      if (m.role === "system") {
        // #4166: a core carrying the raw sidecar re-emits it byte-exact
        // (client mid-history system data). If kernel ops rewrote the text
        // (emergency truncation), a plain-text sidecar re-lays out its text;
        // a structured one is unfoldable-by-protection, so verbatim still.
        const raw = (m as BiliMessage & { rawOpenaiMessage?: unknown })
          .rawOpenaiMessage as OpenAIMessage | undefined;
        if (raw) {
          const text = m.text ?? "";
          if (
            text !== stringContent(raw.content) &&
            isPlainStringOrTextParts(raw.content)
          ) {
            out.push({
              role: m.originalRole === "developer" ? "developer" : "system",
              content: typeof raw.content === "string" ? text : [{ type: "text", text }],
            });
          } else {
            out.push(raw);
          }
        } else {
          out.push({
            role: m.originalRole === "developer" ? "developer" : "system",
            content: m.text ?? "",
          });
        }
      } else if (
        m.role === "user" &&
        isSummaryMessageId(m.id) &&
        m.contentType === "text"
      ) {
        // #4166/#377: a re-voiced summary carrier is bili's own artifact,
        // not a member of any client wire run — it emits as its OWN message
        // so the pinned first-user message (#3642/#2733 prefix-cache anchor)
        // never merges with (and never has its bytes prefixed by) the
        // carrier text. Ids with the reserved summary prefix can only be
        // kernel-minted here (client echoes re-hash to raw ids), so the
        // role-agnostic id+contentType match is exact — isRenderedSummaryMessage
        // would miss it because the host re-voice already flipped the role.
        flush();
        flushUserRun();
        out.push({ role: "user", content: m.text ?? "" });
      } else if (m.role === "user") {
        // #3642: canonical granularity gives one core per content part, so
        // user cores from ONE wire message are a RUN that rebuilds as ONE
        // wire message (multi-part content array when any core carries
        // media/opaque sidecars, plain string otherwise). A wireIndex step
        // (or a core without one — kernel-rendered) still joins the run;
        // cores from DIFFERENT wire messages (both indexed) rebuild as
        // separate messages, byte-shaped like the host sent them. The
        // assistant run closes here first (mirror of the assistant branch).
        flush();
        const prev = userRun[userRun.length - 1];
        if (prev && prev.wireIndex !== undefined && m.wireIndex !== undefined && prev.wireIndex !== m.wireIndex) {
          flushUserRun();
        }
        userRun.push(m);
      } else if (m.role === "tool") {
        out.push({
          role: "tool",
          tool_call_id: m.toolCallId ?? "",
          content: m.text ?? "",
        });
      }
    }
  }
  flush();
  flushUserRun();
  return out;
}

export function injectOpenaiSystem(
  messages: OpenAIMessage[],
  parts: string[],
): OpenAIMessage[] {
  if (parts.length === 0) return messages;
  const extra = parts.join("\n\n");
  if (
    messages.length > 0 &&
    (messages[0]?.role === "system" || messages[0]?.role === "developer")
  ) {
    const head = messages[0] as OpenAIMessage;
    const base = stringContent(head.content);
    const merged = base ? `${base}\n\n---\n\n${extra}` : extra;
    return [{ ...head, content: merged }, ...messages.slice(1)];
  }
  return [{ role: "system", content: extra }, ...messages];
}

/** Extract the conversation dimension for OpenAI Chat: a client-provided
 *  session header if present, else a content fingerprint of the first user
 *  message. See conversationSignalAnthropic for the full rationale. */
export function conversationSignalOpenai(
  body: OpenAIRequestBody,
  headerValue?: string,
): string {
  if (headerValue && headerValue.trim()) return headerValue.trim();
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const firstUser = msgs.find((m) => m?.role === "user");
  const seed = firstUser ? stringContent(firstUser.content) : "default";
  return hashId(seed);
}

/** #4166: true when content is a plain string or an all-text parts array —
 *  the shapes whose bytes live entirely in `text`, so a kernel text rewrite
 *  can re-lay them out without losing anything. */
function isPlainStringOrTextParts(
  content: OpenAIMessage["content"],
): boolean {
  if (content == null || typeof content === "string") return true;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        (p as { type?: string }).type === "text",
    )
  );
}

function stringContent(content: OpenAIMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === "string"
          ? p
          : p.type === "text"
            ? ((p as { text?: string }).text ?? "")
            : "",
      )
      .join("\n");
  }
  return "";
}

