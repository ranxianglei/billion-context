import type { Config, CoreMessage } from "./types.js";

/** Tools that are ALWAYS protected, regardless of user config. These are ACP's
 *  own metadata tools whose records must remain in context: compress calls
 *  carry the summaries that decompress/search rely on, and the system prompt
 *  treats past compress calls as load-bearing metadata. acp_rule calls record
 *  persistent user rules that are re-injected every turn — compressing them
 *  away would silently lose what the rules state. Letting any of these be
 *  compressed away breaks decompress and the "summary is historical" contract. */
export const ALWAYS_PROTECTED_TOOLS = ["compress", "acp_rule"] as const;

/** Tool results that must NEVER participate in the soft-protected recent zone
 *  (preserveRecentMessages / preserveRecentTokens / last user message).
 *
 *  These tools return large content (restored blocks, search hits, file bodies,
 *  command output). If such a result lands in the last-N window it becomes
 *  un-compressible: the model cannot reclaim that context, and it never appears
 *  in the compressible-ranges recommendation list. Excluding these tools from
 *  the protected zone lets the model compress them again immediately, while
 *  still leaving them visible (the host's preserveRecent is about not
 *  compressing the active working set, not about which tool results are in
 *  scope).
 *
 *  - `decompress`: large restored content as an inline tool result.
 *  - `search_context`: large result lists (10 ranked hits with previews).
 *  - `read`: file/image contents — the largest common source of context bloat.
 *  - `bash`: command output (build/test/logs) — frequently large and spent.
 *
 *  Note: this only affects the recent-zone computation. Such messages remain
 *  fully visible and compressible like any ordinary message. */
export const NEVER_PRESERVE_RECENT_TOOLS = [
  "decompress",
  "search_context",
  "read",
  "bash",
] as const;

/** True for tool-call / tool-result messages whose toolName matches one of
 *  the recent-zone exclusion patterns — i.e. tool results (like decompress)
 *  that should be excluded from the soft-protected recent zone.
 *
 *  `patterns` defaults to NEVER_PRESERVE_RECENT_TOOLS when omitted/undefined
 *  (the built-in list stays the default behavior); an explicit array —
 *  including `[]` — replaces it verbatim. Patterns use the same glob-suffix
 *  matching as protectedTools; exact names behave exactly as before.
 *
 *  `preservePatterns` (config.preserveRecentTools) is then SUBTRACTED from
 *  that effective list (glob-suffix matching against the list entries), so
 *  `preserveRecentTools: ["read"]` protects fresh read results without
 *  restating the built-in list (upstream billion-context #1198/#1277).
 *  Unset or empty = no subtraction. */
export function isNeverPreserveRecent(
  msg: CoreMessage,
  patterns?: readonly string[],
  preservePatterns?: readonly string[],
): boolean {
  if (msg.contentType !== "tool-call" && msg.contentType !== "tool-result") {
    return false;
  }
  if (!msg.toolName) return false;
  const base =
    patterns === undefined
      ? (NEVER_PRESERVE_RECENT_TOOLS as readonly string[])
      : patterns;
  const list =
    preservePatterns === undefined || preservePatterns.length === 0
      ? base
      : base.filter(
          (tool) => !preservePatterns.some((p) => matchToolPattern(tool, p)),
        );
  for (const pattern of list) {
    if (matchToolPattern(msg.toolName, pattern)) return true;
  }
  return false;
}

/** Match a tool name against a pattern: an exact name or a trailing-`*` prefix
 *  glob. CASE-INSENSITIVE on both sides — client hosts disagree on tool-name
 *  casing (opencode `read` vs Claude/ZCode `Read`), so every knob built on this
 *  matcher must treat them as equal (billion-context#1725). Monotonic: only adds
 *  matches, never removes one that held under exact matching. */
export function matchToolPattern(toolName: string, pattern: string): boolean {
  const name = toolName.toLowerCase();
  const pat = pattern.toLowerCase();
  if (pat.endsWith("*")) {
    return name.startsWith(pat.slice(0, -1));
  }
  return name === pat;
}

// No boundary class before the name: `/home/u/skills/review-loop/SKILL.md`
// must capture `review-loop` (the segment immediately before the anchor), and
// the preceding `/` is exactly the case a boundary class would break. The
// separator runs on RAW JSON text, where a Windows `\` arrives escaped as a
// backslash PAIR — so accept `\\` (escaped pair), `\` (unescaped text) or `/`.
const SKILL_MD_ANCHOR_RE = /([A-Za-z0-9][A-Za-z0-9._-]*)(?:\\\\|\\|\/)SKILL\.md/i;

function isValidSkillName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  );
}

function skillNameFromCallText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const args = parsed as Record<string, unknown>;
  for (const key of ["skill", "name", "command"]) {
    const value = args[key];
    if (typeof value === "string" && isValidSkillName(value)) return value;
  }
  return undefined;
}

/** Canonical path of a tool exchange: skill loads project to `skill/<name>`,
 *  everything else is the bare tool name. Skill identity lives in the call
 *  input, not the tool name — opencode calls `skill({name})`, Claude
 *  Code/ZCode call `Skill({skill})`, and pi has no skill tool at all: any
 *  tool reading `<dir>/<name>/SKILL.md` loads one (#1947). Projection runs on
 *  tool-CALL input only; a tool-result projects to its bare tool name (the
 *  result half of a protected call is covered by toolCallId pairing). */
export function toolPathOf(msg: CoreMessage): string {
  const toolName = msg.toolName ?? "";
  if (!toolName || msg.contentType !== "tool-call") return toolName;
  if (toolName.toLowerCase() === "skill") {
    const name = skillNameFromCallText(msg.text);
    if (name) return `skill/${name}`;
  }
  const anchored = (msg.text ?? "").match(SKILL_MD_ANCHOR_RE)?.[1];
  if (anchored && isValidSkillName(anchored)) return `skill/${anchored}`;
  return toolName;
}

/** Match a canonical tool path against a protectedTools/protectedLatestTools
 *  pattern. Segments split on `/`; within a segment an exact name or a
 *  trailing-`*` prefix glob (case-insensitive like matchToolPattern — `*`
 *  never crosses `/`). A single-segment pattern matches the first path
 *  segment, i.e. the node and ALL its descendants: `skill` ≡ `skill/*`
 *  (#1947). */
export function matchToolPath(path: string, pattern: string): boolean {
  const patSegs = pattern.toLowerCase().split("/");
  const patFirst = patSegs[0] ?? "";
  const pathFirst = path.toLowerCase().split("/")[0] ?? "";
  if (patSegs.length === 1) {
    return matchToolPattern(pathFirst, patFirst);
  }
  const pathSegs = path.toLowerCase().split("/");
  if (patSegs.length === 2 && patSegs[1] === "*") {
    return matchToolPattern(pathFirst, patFirst);
  }
  return (
    patSegs.length === pathSegs.length &&
    patSegs.every((seg, i) => matchToolPattern(pathSegs[i] ?? "", seg))
  );
}

/** True when a protectedTools/protectedLatestTools pattern matches a tool
 *  exchange: by canonical path, or — monotonic fallback — by bare tool name,
 *  so every match that held before path syntax still holds (a `read` of
 *  SKILL.md keeps matching a plain `read` pattern; #1947). */
export function matchToolMessagePattern(
  msg: CoreMessage,
  pattern: string,
): boolean {
  const toolName = msg.toolName ?? "";
  if (!toolName) return false;
  return (
    matchToolPath(toolPathOf(msg), pattern) ||
    matchToolPattern(toolName, pattern)
  );
}

/** Host-projected virtual tool path for a non-tool message (billion-context
 *  #2446 family): plain-text durable-state carriers classified by the host
 *  run through the same pattern machinery as tool exchanges. Tool-call /
 *  tool-result messages are never re-projected — the classifier's domain is
 *  exactly the messages that carry no toolName, so a tool exchange keeps its
 *  existing semantics byte-for-byte. */
export function virtualToolPathOf(
  msg: CoreMessage,
  config: Pick<Config, "messagePathOf">,
): string | undefined {
  if (
    msg.contentType === "tool-call" ||
    msg.contentType === "tool-result"
  ) {
    return undefined;
  }
  return config.messagePathOf?.(msg);
}

export function isMessageProtected(
  msg: CoreMessage,
  config: Pick<Config, "protectedTools" | "isToolProtected" | "isMessageProtected" | "messagePathOf">,
): boolean {
  // Host-declared message-level protection (#2419): applies to ANY content
  // type and outranks everything below — the host owns the decision.
  if (config.isMessageProtected?.(msg)) return true;

  // tool-result carries the same toolName as its tool-call (the host projects
  // it), so checking toolName covers both sides of a tool exchange.
  if (
    (msg.contentType !== "tool-call" && msg.contentType !== "tool-result") ||
    !msg.toolName
  ) {
    // Host-projected virtual tool path (#2446 family): a plain-text carrier
    // matched by a protectedTools pattern is protected exactly like a tool
    // exchange would be. Path-pattern semantics are identical ("durable"
    // matches "durable/…" and its descendants; "*" never crosses "/").
    const virtualPath = virtualToolPathOf(msg, config);
    if (virtualPath) {
      for (const pattern of config.protectedTools) {
        if (matchToolPath(virtualPath, pattern)) return true;
      }
    }
    return false;
  }

  // Hard-coded protection: ACP metadata tools are never compressible.
  if ((ALWAYS_PROTECTED_TOOLS as readonly string[]).includes(msg.toolName)) {
    return true;
  }

  for (const pattern of config.protectedTools) {
    if (matchToolMessagePattern(msg, pattern)) return true;
  }

  if (config.isToolProtected?.(msg.toolName, msg.text)) return true;

  return false;
}

/** Build the set of toolCallIds whose tool-call is protected. Use this to also
 *  protect tool-results that lack a toolName (common when the host projects a
 *  tool-result with only toolCallId). Without it, the result half of a
 *  protected tool exchange leaks into compressible ranges. */
export function collectProtectedToolCallIds(
  messages: CoreMessage[],
  config: Pick<Config, "protectedTools" | "isToolProtected">,
): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (
      m.contentType === "tool-call" &&
      m.toolCallId &&
      isMessageProtected(m, config)
    ) {
      ids.add(m.toolCallId);
    }
  }
  return ids;
}

/** Like isMessageProtected, but also matches tool-results by toolCallId against
 *  the protected call set. Use when you have the full message list available. */
export function isMessageProtectedWithPairing(
  msg: CoreMessage,
  config: Pick<Config, "protectedTools" | "isToolProtected">,
  protectedCallIds: Set<string>,
): boolean {
  if (isMessageProtected(msg, config)) return true;
  if (
    msg.contentType === "tool-result" &&
    msg.toolCallId &&
    protectedCallIds.has(msg.toolCallId)
  ) {
    return true;
  }
  return false;
}

/** "Latest only" protection set: for each protectedLatestTools pattern, the
 *  LAST tool-call matching it (in message order) plus its paired result. Older
 *  instances of the same tool stay compressible. Use for cumulative-snapshot
 *  tools (e.g. todo_list) where only the newest result is the source of truth
 *  and every older result is strictly redundant.
 *
 *  `callIds` holds the latest calls' toolCallIds (pairing covers the result
 *  half, including results projected without a toolName); `msgIds` holds
 *  latest calls that lack a toolCallId (pairing impossible — protect by id). */
export interface LatestProtected {
  callIds: Set<string>;
  msgIds: Set<string>;
}

export function collectLatestProtected(
  messages: CoreMessage[],
  config: Pick<Config, "protectedLatestTools" | "messagePathOf">,
): LatestProtected {
  const callIds = new Set<string>();
  const msgIds = new Set<string>();
  const patterns = config.protectedLatestTools ?? [];
  if (patterns.length === 0) return { callIds, msgIds };
  for (const pattern of patterns) {
    // Path patterns (containing `/`) protect the latest instance PER PATH —
    // `skill/*` keeps the newest load of every skill, not just one (#1947),
    // and `durable/*` keeps the newest instance of every host-projected
    // durable carrier identity. Plain tool-name patterns keep the
    // single-latest semantics.
    if (pattern.includes("/")) {
      const lastByPath = new Map<string, CoreMessage>();
      for (const m of messages) {
        if (m.contentType === "tool-call" && m.toolName) {
          if (!matchToolMessagePattern(m, pattern)) continue;
          lastByPath.set(toolPathOf(m), m);
          continue;
        }
        const virtualPath = virtualToolPathOf(m, config);
        if (virtualPath && matchToolPath(virtualPath, pattern)) {
          lastByPath.set(virtualPath, m);
        }
      }
      for (const last of lastByPath.values()) {
        if (last.toolCallId) callIds.add(last.toolCallId);
        else msgIds.add(last.id);
      }
      continue;
    }
    let last: CoreMessage | undefined;
    for (const m of messages) {
      if (m.contentType === "tool-call" && m.toolName) {
        if (matchToolMessagePattern(m, pattern)) {
          last = m;
        }
        continue;
      }
      const virtualPath = virtualToolPathOf(m, config);
      if (virtualPath && matchToolPath(virtualPath, pattern)) {
        last = m;
      }
    }
    if (!last) continue;
    if (last.toolCallId) callIds.add(last.toolCallId);
    else msgIds.add(last.id);
  }
  return { callIds, msgIds };
}

/** True when msg is a latest-protected tool-call, or the tool-result paired to
 *  one (by toolCallId). msgIds entries may also be latest TEXT carriers
 *  (host-projected virtual tool paths carry no toolCallId), so the id
 *  membership check runs for every content type. */
export function isMessageLatestProtected(
  msg: CoreMessage,
  latest: LatestProtected,
): boolean {
  if (latest.msgIds.has(msg.id)) return true;
  if (
    (msg.contentType === "tool-call" || msg.contentType === "tool-result") &&
    msg.toolCallId &&
    latest.callIds.has(msg.toolCallId)
  ) {
    return true;
  }
  return false;
}

/** Wire-sidecar fields carrying media/attachment payloads whose bytes live
 *  OUTSIDE msg.text (images, image blocks inside a structured Anthropic
 *  tool_result, or opaque file refs such as DeepSeek Files API
 *  `{type:"file"}`). Folding such a message into a summary destroys the
 *  payload permanently: hosts rebuild requests from their own history and the
 *  kernel holds no server-side archive (billion-context#1188). Typed
 *  structurally rather than as BiliMessage because core modules must not
 *  import from src/wire/. */
interface MediaSidecar {
  imageBase64?: string;
  rawOpenaiContent?: unknown;
  rawOpenaiContentParts?: unknown[];
  rawAnthropicBlock?: unknown;
  rawResponsesItem?: unknown;
  rawGoogleParts?: unknown[];
}

export function hasMediaPayload(msg: CoreMessage): boolean {
  const m = msg as CoreMessage & MediaSidecar;
  if (typeof m.imageBase64 === "string" && m.imageBase64.length > 0)
    return true;
  if (m.rawOpenaiContent != null) return true;
  if (
    Array.isArray(m.rawOpenaiContentParts) &&
    m.rawOpenaiContentParts.length > 0
  )
    return true;
  const ab = m.rawAnthropicBlock;
  if (isObjWith(ab, "type", "image")) return true;
  // A structured tool_result sidecar is media only when its content array
  // holds non-text blocks (images); text-only structured results carry no
  // bytes outside msg.text.
  if (isObjWith(ab, "type", "tool_result")) {
    const content = (ab as { content?: unknown }).content;
    if (Array.isArray(content))
      return content.some((p) => !isObjWith(p, "type", "text"));
  }
  // #3410: unknown top-level block types (in the wild: document/PDF) ride the
  // sidecar with their full payload — media like image, not text.
  const abType = asObj(ab)?.type;
  if (
    typeof abType === "string" &&
    abType !== "image" &&
    abType !== "tool_result" &&
    abType !== "redacted_thinking"
  )
    return true;
  const item = m.rawResponsesItem;
  if (isObjWith(item, "type", "input_image")) return true;
  if (item && typeof item === "object") {
    const content = (item as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content.some((p) => isObjWith(p, "type", "input_image"));
    }
  }
  return false;
}

/** True when msg carries media whose bytes bili CANNOT store locally —
 *  remote-URL images and opaque file references (DeepSeek Files API
 *  `{type:"file"}`, Google `fileData`/`videoMetadata`) — so folding it would
 *  destroy the payload permanently with no decompress({ imageRef }) restore
 *  behind it (billion-context#1188; the missing Google detection was #2609).
 *  Archivable media (inline base64 / data: URLs, which the host spills to disk
 *  at arrival time) is deliberately NOT unrecoverable: since #2607 such
 *  messages fold like ordinary text and stay citable by their mNNNNN ref.
 *  The data-URL test mirrors the host archive channel (image-restore.ts
 *  messageImageBytes) exactly, so "recoverable here" ⇔ "bytes actually
 *  spilled there". */
export function hasUnrecoverableMediaPayload(msg: CoreMessage): boolean {
  const m = msg as CoreMessage & MediaSidecar;

  const roc = m.rawOpenaiContent;
  if (roc != null) {
    const part = asObj(roc);
    const url =
      part?.type === "image_url" ? asObj(part.image_url)?.url : undefined;
    if (!isInlineDataUrl(url)) return true;
  }

  if (Array.isArray(m.rawOpenaiContentParts)) {
    for (const p of m.rawOpenaiContentParts) {
      const part = asObj(p);
      const url =
        part?.type === "image_url" ? asObj(part.image_url)?.url : undefined;
      if (!isInlineDataUrl(url)) return true;
    }
  }

  const ab = asObj(m.rawAnthropicBlock);
  if (ab) {
    if (ab.type === "image" && !anthropicSourceArchivable(asObj(ab.source)))
      return true;
    if (ab.type === "tool_result") {
      const content = ab.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          const blk = asObj(b);
          if (!blk || blk.type === "text") continue;
          if (blk.type === "image") {
            if (!anthropicSourceArchivable(asObj(blk.source))) return true;
            continue;
          }
          return true;
        }
      }
    }
    // #3410: unknown top-level block types (document/PDF ...) — the host
    // archives no such payload to disk, so folding destroys it permanently.
    if (
      typeof ab.type === "string" &&
      ab.type !== "image" &&
      ab.type !== "tool_result" &&
      ab.type !== "redacted_thinking"
    )
      return true;
    // redacted_thinking shares this field — ignored, parity with hasMediaPayload
  }

  const item = asObj(m.rawResponsesItem);
  if (item) {
    const parts: unknown[] = [];
    if (item.type === "input_image") parts.push(item);
    for (const key of ["content", "output"] as const) {
      const arr = item[key];
      if (Array.isArray(arr))
        for (const p of arr) if (asObj(p)?.type === "input_image") parts.push(p);
    }
    for (const p of parts) {
      if (!isInlineDataUrl(asObj(p)?.image_url)) return true;
    }
  }

  // Google: inlineData carries bytes (archived); fileData URI refs and
  // videoMetadata references do not. Unknown part types fold as today —
  // pinning them would over-block future benign shapes.
  if (Array.isArray(m.rawGoogleParts)) {
    for (const p of m.rawGoogleParts) {
      const part = asObj(p);
      if (!part) continue;
      if (part.fileData != null || part.videoMetadata != null) return true;
      const fr = asObj(part.functionResponse);
      if (fr && Array.isArray(fr.parts)) {
        for (const np of fr.parts) {
          const sub = asObj(np);
          if (sub && (sub.fileData != null || sub.videoMetadata != null))
            return true;
        }
      }
    }
  }

  return false;
}

function anthropicSourceArchivable(
  source: Record<string, unknown> | undefined,
): boolean {
  if (!source) return false;
  if (source.type === "base64") return typeof source.data === "string";
  // A data: URL in the url source still carries its bytes inline.
  if (source.type === "url") return isInlineDataUrl(source.url);
  return false;
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Inline-bytes test mirroring parseDataUrl's shape (kernel core must not
 *  import from src/wire/): only these URLs hold recoverable bytes. */
function isInlineDataUrl(u: unknown): boolean {
  return typeof u === "string" && /^data:[^;,]+(?:;base64)?,.+$/i.test(u);
}

function isObjWith(v: unknown, key: string, value: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>)[key] === value
  );
}
