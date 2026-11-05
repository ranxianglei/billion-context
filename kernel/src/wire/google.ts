import { hashId } from "./util.js";
import { ClusterCounter } from "./message-id.js";
import {
  CANONICAL_IMAGE_TEXT,
  canonicalToolArgs,
  deriveCanonicalMessageId,
  imageMediaFingerprint,
} from "./identity.js";
import type { BiliMessage } from "./bili-message.js";

// Gemini native wire (`generativelanguage.googleapis.com`, /v1beta/models/<m>:
// generateContent|streamGenerateContent|countTokens). Two properties of this
// dialect drive the whole codec:
//   - Gemini verifies what it sent: thoughtSignatures, functionCall ids and
//     every part variant it may re-emit must come back byte-identical, so a
//     part the core cannot represent field-by-field rides verbatim in
//     `BiliMessage.rawGoogleParts`.
//   - Gemini rejects non-alternating roles, so the reverse mapping MERGES
//     runs of same-side cores into one content (see coreToGoogle).

export type GooglePart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: unknown; id?: string };
  functionResponse?: {
    name: string;
    response?: unknown;
    id?: string;
    parts?: GooglePart[];
  };
  inlineData?: { mimeType: string; data: string };
  fileData?: { fileUri: string; mimeType?: string };
  [k: string]: unknown;
};

export type GoogleContent = { role?: string; parts: GooglePart[] };

export type GoogleFunctionDeclaration = {
  name: string;
  description?: string;
  parameters?: unknown;
  parametersJsonSchema?: unknown;
  response?: unknown;
  [k: string]: unknown;
};

export type GoogleTool = {
  functionDeclarations?: GoogleFunctionDeclaration[];
  [k: string]: unknown;
};

export type GoogleSystemInstruction = { parts?: GooglePart[]; role?: string };

export type GoogleRequestBody = {
  contents: GoogleContent[];
  systemInstruction?: GoogleSystemInstruction;
  tools?: GoogleTool[];
  toolConfig?: unknown;
  generationConfig?: Record<string, unknown>;
  cachedContent?: string;
  [k: string]: unknown;
};

export type GoogleFlat = { msgs: BiliMessage[]; systemText: string };

/** Hoist the system dimension out of the fold space. `systemInstruction` is
 *  host runtime state exactly like the openai codec's leading system prefix
 *  (see openaiToCore): its content varies across restarts, so keeping it
 *  inside the id space made every downstream fingerprint spanning it
 *  unstable, and a compress range that covered it deleted the model's system
 *  prompt from the rebuilt wire. The adapter re-injects it as
 *  `systemInstruction` at egress. */
export function googleSystemText(body: GoogleRequestBody): string {
  const parts = body.systemInstruction?.parts;
  if (!Array.isArray(parts)) return "";
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part.text === "string" && part.text.length > 0)
      texts.push(part.text);
  }
  return texts.join("\n\n");
}

/** Map a Gemini request body onto the kernel's message space. Mirrors
 *  openaiToCore's role handling: `content.role === "model"` is the assistant
 *  side, everything else the user side. A user content's functionResponse
 *  parts expand into `role:"tool"` cores emitted BEFORE that content's own
 *  user core — the client appends a second functionResponse to the previous
 *  user content instead of opening a new one, so those parts belong to the
 *  tool pair, not to the user text they sit next to. */
export function googleToCore(body: GoogleRequestBody): GoogleFlat {
  const msgs: BiliMessage[] = [];
  const clusters = new ClusterCounter();
  // name -> toolCallIds of calls not yet answered, in wire order. A
  // functionResponse without an id pairs with the EARLIEST unmatched call of
  // the same name; calls always precede their responses on the wire, so one
  // forward pass is enough and the pairing is deterministic across passes.
  const unmatchedCalls = new Map<string, string[]>();
  const contents = Array.isArray(body.contents) ? body.contents : [];

  for (const [contentIndex, content] of contents.entries()) {
    const before = msgs.length;
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const isModel = content.role === "model";

    // 1. Tool results first: their cores precede the content's own user core
    //    (pairing order); the rebuild's PART order is normalized separately
    //    (coreToGoogle / #3159).
    for (const part of parts) {
      const fr = part.functionResponse;
      if (!fr || typeof fr.name !== "string") continue;
      // #3642: the canonical result text is the OUTPUT — a lone string
      // `output` field is the dominant MCP-ish shape, and unwrapping it
      // aligns google results with the other dialects (identical logical
      // result ⇒ identical core text ⇒ identical id). Structured responses
      // keep their compact-JSON text.
      const response = fr.response ?? {};
      const text =
        response &&
        typeof response === "object" &&
        !Array.isArray(response) &&
        Object.keys(response).length === 1 &&
        typeof (response as { output?: unknown }).output === "string"
          ? ((response as { output: string }).output)
          : jsonText(response);
      const wireId = typeof fr.id === "string" ? fr.id : undefined;
      const queue = unmatchedCalls.get(fr.name);
      let paired: string | undefined;
      if (wireId) {
        // An explicitly tagged response answers that call, so a later
        // id-less response of the same name cannot claim it.
        const i = queue ? queue.indexOf(wireId) : -1;
        if (queue && i >= 0) queue.splice(i, 1);
      } else if (queue && queue.length > 0) {
        paired = queue.shift();
      }
      // #3642: canonical result identity = toolName + text. The wire id /
      // pairing id stays on the toolCallId FIELD (pairing is untouched) but
      // is out of the seed — it is transport plumbing, not content.
      const base = deriveCanonicalMessageId("tool", "tool-result", text, {
        toolName: fr.name,
      });
      const id = clusters.next(base);
      msgs.push({
        id,
        role: "tool",
        contentType: "tool-result",
        toolName: fr.name,
        // No wire id and nothing to pair with: the core's own id
        // stands in, so the response is still identifiable and stable.
        toolCallId: wireId ?? paired ?? id,
        text,
        rawGoogleParts: [part],
      });
    }

    // 2. Thinking parts.
    for (const part of parts) {
      if (part.thought !== true || typeof part.text !== "string") continue;
      const base = deriveCanonicalMessageId(
        "assistant",
        "reasoning",
        part.text,
      );
      msgs.push({
        id: clusters.next(base),
        role: "assistant",
        contentType: "reasoning",
        text: part.text,
        rawGoogleParts: [part],
        ...signatureField("googleThoughtSignature", part.thoughtSignature),
      });
    }

    const rest = parts.filter(isContentPart);
    // 3. The content's own text/media cores — #3642 canonical granularity:
    //    every part is its own core (the anthropic codec's model), so the
    //    same logical conversation yields the same core array in every
    //    protocol. Each text part is a text core seeded on its own bytes;
    //    each media part (inlineData/fileData) is an image core carrying the
    //    canonical "[image]" marker with the raw part as its byte-fidelity
    //    sidecar. coreToGoogle's role-alternation accumulator merges the
    //    same-side run back into one content whose parts array preserves the
    //    part objects verbatim. A content made only of functionResponse
    //    parts yields none (its parts ride on the tool cores).
    let lastTextCore: BiliMessage | null = null;
    let leftover: GooglePart[] = [];
    for (const part of rest) {
      if (typeof part.text === "string" && part.thought !== true) {
        const base = deriveCanonicalMessageId(
          isModel ? "assistant" : "user",
          "text",
          part.text,
        );
        lastTextCore = {
          id: clusters.next(base),
          role: isModel ? "assistant" : "user",
          contentType: "text",
          text: part.text,
          rawGoogleParts: [part],
          ...signatureField(
            "googleThoughtSignature",
            part.thoughtSignature,
          ),
        };
        msgs.push(lastTextCore);
        continue;
      }
      const inline = part.inlineData;
      if (
        inline &&
        typeof inline.mimeType === "string" &&
        typeof inline.data === "string"
      ) {
        const base = deriveCanonicalMessageId(
          isModel ? "assistant" : "user",
          "text",
          CANONICAL_IMAGE_TEXT,
          {
            // #3751: payload-addressed ids — inlineData hashes its base64 payload.
            mediaFingerprint: imageMediaFingerprint(inline.data),
          },
        );
        msgs.push({
          id: clusters.next(base),
          role: isModel ? "assistant" : "user",
          contentType: "text",
          text: CANONICAL_IMAGE_TEXT,
          imagePart: true,
          imageMediaType: inline.mimeType,
          imageBase64: inline.data,
          rawGoogleParts: [part],
        });
        continue;
      }
      // Other opaque content parts (fileData, executableCode, …) attach to
      // the PRECEDING text core's raw sidecar so the verbatim rebuild keeps
      // them in place; with no text core to host them they wait, and a
      // message with leftovers but no text core keeps the legacy fallback
      // shape (one core, joined text — possibly "" — all leftovers raw).
      if (lastTextCore) {
        lastTextCore.rawGoogleParts = [
          ...(lastTextCore.rawGoogleParts ?? []),
          part,
        ];
      } else {
        leftover = [...leftover, part];
      }
    }
    if (leftover.length > 0) {
      const text = textPartsOf(leftover)
        .map((p) => p.text ?? "")
        .join("\n");
      const base = deriveCanonicalMessageId(
        isModel ? "assistant" : "user",
        "text",
        text,
      );
      msgs.push({
        id: clusters.next(base),
        role: isModel ? "assistant" : "user",
        contentType: "text",
        text,
        rawGoogleParts: leftover,
      });
    }

    // 4. Function calls last, so a call core sits immediately before the
    //    tool-result cores that answer it. Without a wire id the
    //    synthesized toolCallId is the core's own id, which its
    //    functionResponse reuses.
    for (const part of parts) {
      const fc = part.functionCall;
      if (!fc || typeof fc.name !== "string") continue;
      const text = jsonText(fc.args ?? {});
      const wireId = typeof fc.id === "string" ? fc.id : undefined;
      // #3642: canonical args in the seed (key-sorted, compact — the same
      // normalization openai/anthropic/responses apply, so an identical
      // logical call yields the same id in every protocol); the wire id
      // stays on the toolCallId FIELD only.
      const base = deriveCanonicalMessageId(
        "assistant",
        "tool-call",
        canonicalToolArgs(text),
        { toolName: fc.name },
      );
      const id = clusters.next(base);
      const toolCallId = wireId ?? id;
      const queue = unmatchedCalls.get(fc.name);
      if (queue) queue.push(toolCallId);
      else unmatchedCalls.set(fc.name, [toolCallId]);
      msgs.push({
        id,
        role: "assistant",
        contentType: "tool-call",
        toolName: fc.name,
        toolCallId,
        text,
        rawGoogleParts: [part],
        ...signatureField("googleThoughtSignature", part.thoughtSignature),
      });
    }
    for (let k = before; k < msgs.length; k++) {
      msgs[k]!.wireIndex = contentIndex;
    }
  }

  return { msgs, systemText: googleSystemText(body) };
}

/** #3159 — Vertex rejects a request whose user content carries plain text
 *  AFTER a functionResponse part ("Requests ending with a model turn are not
 *  supported"); text-before-functionResponse is accepted (controlled A/B on
 *  the official endpoint, gemini-4-argon). When a movable plain-text part
 *  trails a functionResponse, stable-partition the unsigned non-thought plain
 *  text ahead of every non-text part; otherwise return the input untouched so
 *  already-safe shapes stay byte-identical (prefix-cache anchor). Signed text
 *  parts, thought parts and all non-text parts keep their relative order —
 *  nothing is dropped, renamed or rewritten. */
export function normalizeGoogleUserPartOrder(parts: GooglePart[]): GooglePart[] {
  const firstFr = parts.findIndex((p) => p.functionResponse !== undefined);
  if (firstFr === -1) return parts;
  const movable = (p: GooglePart) =>
    typeof p.text === "string" &&
    p.thought !== true &&
    typeof p.thoughtSignature !== "string";
  let reorder = false;
  for (let i = firstFr; i < parts.length; i++) {
    if (movable(parts[i]!)) {
      reorder = true;
      break;
    }
  }
  if (!reorder) return parts;
  const moved: GooglePart[] = [];
  const rest: GooglePart[] = [];
  for (const p of parts) (movable(p) ? moved : rest).push(p);
  return [...moved, ...rest];
}

/** Rebuild Gemini `contents` from kernel messages. Runs of same-side cores
 *  are merged into ONE content (Gemini rejects non-alternating roles): an
 *  assistant run becomes a single `{"role":"model"}` content whose parts are
 *  ordered reasoning, text, tool-call; a user-side run (user + tool-result)
 *  becomes a single `{"role":"user"}` content normalized by
 *  normalizeGoogleUserPartOrder (#3159: plain text leads, functionResponse
 *  parts trail). Mid-conversation system cores (host-synthetic; Gemini has no
 *  system role inside contents) ride on the user side as a text part.
 *
 *  Byte-stability contract (#3938 / #3939⑥): for alternating-role histories
 *  (the only shape Gemini accepts), this function is PURE in the core array
 *  — same shape, same bytes, every request; any drift breaks the upstream
 *  prefix cache mid-session. The canonical part orders ARE the merge rules
 *  above: model runs emit reasoning → text → tool-call; user runs emit
 *  functionResponse parts then content parts, re-normalized by
 *  normalizeGoogleUserPartOrder (#3159). Merging same-role runs into one
 *  content is the required normalization (Gemini rejects non-alternating
 *  roles), and its output order is the canonical one. Do not reorder this
 *  emission without moving the pins in
 *  kernel/tests/issue3939-wire-byte-stability.test.ts. */
export function coreToGoogle(messages: BiliMessage[]): GoogleContent[] {
  const out: GoogleContent[] = [];
  let model: {
    reasoning: GooglePart[];
    text: GooglePart[];
    calls: GooglePart[];
  } | null = null;
  let user: { responses: GooglePart[]; content: GooglePart[] } | null = null;
  const flushModel = () => {
    if (!model) return;
    const parts = [...model.reasoning, ...model.text, ...model.calls];
    model = null;
    if (parts.length > 0) out.push({ role: "model", parts });
  };
  const flushUser = () => {
    if (!user) return;
    const parts = normalizeGoogleUserPartOrder([
      ...user.responses,
      ...user.content,
    ]);
    user = null;
    if (parts.length > 0) out.push({ role: "user", parts });
  };
  for (const m of messages) {
    if (m.role === "assistant") {
      flushUser();
      if (!model) model = { reasoning: [], text: [], calls: [] };
      if (m.contentType === "reasoning") model.reasoning.push(reasoningPart(m));
      else if (m.contentType === "tool-call") model.calls.push(toolCallPart(m));
      else model.text.push(...contentParts(m));
    } else {
      flushModel();
      if (!user) user = { responses: [], content: [] };
      if (m.role === "tool" || m.contentType === "tool-result")
        user.responses.push(...toolResultParts(m));
      else user.content.push(...contentParts(m));
    }
  }
  flushModel();
  flushUser();
  return out;
}

/** Text-protocol/fallback system injection. `contents` has no top-level
 *  system slot, so the prompt becomes the first part of the leading user
 *  content, or a new leading user content when none is there. The adapter and
 *  the server inject the real system via `systemInstruction` instead (see the
 *  proxy's createGoogleAdapter) — this exists for the path where no system
 *  channel is wanted. */
export function injectGoogleSystem(
  contents: GoogleContent[],
  parts: string[],
): GoogleContent[] {
  if (parts.length === 0) return contents;
  const extra = parts.join("\n\n");
  const head = contents[0];
  if (head && head.role === "user")
    return [
      { ...head, parts: [{ text: extra }, ...head.parts] },
      ...contents.slice(1),
    ];
  return [{ role: "user", parts: [{ text: extra }] }, ...contents];
}

/** Extract the conversation dimension for Gemini: a client-provided session
 *  header if present (omp sends none for this protocol), else a content
 *  fingerprint of the first user content. See conversationSignalAnthropic for
 *  the full rationale. */
export function conversationSignalGoogle(
  body: GoogleRequestBody,
  headerValue?: string,
): string {
  if (headerValue && headerValue.trim()) return headerValue.trim();
  const contents = Array.isArray(body.contents) ? body.contents : [];
  const firstUser = contents.find((c) => c.role !== "model");
  const parts =
    firstUser && Array.isArray(firstUser.parts) ? firstUser.parts : [];
  const seed = firstUser
    ? parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("\n")
    : "default";
  return hashId(seed);
}

/** A reasoning core: its raw thought part verbatim (text refreshed — the
 *  kernel re-renders core text with ref tags/truncation), else a
 *  reconstructed `{thought:true}` part carrying the sidecar signature. */
function reasoningPart(m: BiliMessage): GooglePart {
  const text = m.text ?? "";
  const head = rawParts(m)[0];
  if (head) return { ...head, text, thought: true };
  return {
    text,
    thought: true,
    ...signatureField("thoughtSignature", m.googleThoughtSignature),
  };
}

function toolCallPart(m: BiliMessage): GooglePart {
  const head = rawParts(m)[0];
  if (head && head.functionCall) return head;
  return {
    functionCall: {
      name: m.toolName ?? "unknown",
      args: jsonValue(m.text),
      ...(m.toolCallId ? { id: m.toolCallId } : {}),
    },
    ...signatureField("thoughtSignature", m.googleThoughtSignature),
  };
}

function toolResultParts(m: BiliMessage): GooglePart[] {
  const raw = rawParts(m);
  if (raw.length > 0 && raw.every((p) => p.functionResponse)) return raw;
  return [
    {
      functionResponse: {
        name: m.toolName ?? "unknown",
        response: jsonValue(m.text),
        ...(m.toolCallId ? { id: m.toolCallId } : {}),
      },
    },
  ];
}

/** Parts for a text/media core. Raw parts are preferred verbatim — they carry
 *  signatures, inlineData/fileData, videoMetadata and any unknown field the
 *  wire sent — EXCEPT where they carry the text the kernel owns: core text is
 *  rewritten in flight (ref tags, truncation, absorb prompts), so a raw text
 *  part must never override it. Unchanged text means the raw array goes out
 *  untouched; changed text means the text parts are re-rendered from the core
 *  text while every non-text raw part stays verbatim. */
function contentParts(m: BiliMessage): GooglePart[] {
  const text = m.text ?? "";
  const raw = rawParts(m);
  if (raw.length === 0) {
    const parts: GooglePart[] =
      text && text !== CANONICAL_IMAGE_TEXT && !m.imagePart
        ? [
            {
              text,
              ...signatureField("thoughtSignature", m.googleThoughtSignature),
            },
          ]
        : [];
    // The image sidecars are separate from the raw parts, so an image
    // survives even a core that lost its raw array (rebased/persisted).
    if (m.imageBase64 && m.imageMediaType)
      parts.push({
        inlineData: { mimeType: m.imageMediaType, data: m.imageBase64 },
      });
    return parts;
  }
  const rawTexts = textPartsOf(raw);
  if (rawTexts.map((p) => p.text ?? "").join("\n") === text) return raw;
  // #3642: the canonical "[image]" marker never re-renders as a text part —
  // an image core's payload IS its raw non-text part(s)/sidecar bytes.
  const parts: GooglePart[] =
    text && text !== CANONICAL_IMAGE_TEXT && !m.imagePart
      ? [
          {
            text,
            ...signatureField("thoughtSignature", m.googleThoughtSignature),
          },
        ]
      : [];
  for (const part of raw) {
    if (!rawTexts.includes(part)) parts.push(part);
  }
  return parts;
}

function rawParts(m: BiliMessage): GooglePart[] {
  const raw = m.rawGoogleParts;
  if (!Array.isArray(raw)) return [];
  const out: GooglePart[] = [];
  for (const item of raw) {
    if (typeof item === "object" && item !== null) out.push(item as GooglePart);
  }
  return out;
}

/** The parts whose text the core projects into `BiliMessage.text`. */
function textPartsOf(parts: GooglePart[]): GooglePart[] {
  return parts.filter((p) => typeof p.text === "string" && p.thought !== true);
}

/** Parts a text/media core owns: everything that is not a tool pair member or
 *  a thinking part with text (which get cores of their own). */
function isContentPart(part: GooglePart): boolean {
  if (part.functionCall !== undefined || part.functionResponse !== undefined)
    return false;
  if (part.thought === true && typeof part.text === "string") return false;
  return true;
}

/** Gemini's signature field is `thoughtSignature` on the wire but
 *  `googleThoughtSignature` on the core sidecar; each direction derives it from
 *  what the other end carried. */
function signatureField(
  key: "thoughtSignature" | "googleThoughtSignature",
  signature: unknown,
): { [k: string]: string } {
  return typeof signature === "string" ? { [key]: signature } : {};
}

/** The wire's args/response are JSON objects; the core carries them as text so
 *  the kernel's text pipeline (truncation, refs, absorb) can render them. */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Reverse of jsonText on the reconstruction path (a core with no raw parts).
 *  Unparseable text — a host set the core text by hand — degrades to
 *  `{ output: text }` instead of dropping the payload. */
function jsonValue(text: string | undefined): unknown {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value === null ? {} : value;
  } catch {
    return { output: text };
  }
}
