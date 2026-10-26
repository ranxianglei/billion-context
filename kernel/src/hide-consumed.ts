import { clampPrefix } from "./truncate.js";
import { BLOCKED_REF } from "./refs.js";
import { COMPRESS_TOOL_NAME } from "./compress-tools.js";
import type { CompressionState, CoreMessage } from "./types.js";

// Orphaned compress calls (no matching block — failed attempts, or historical
// calls whose blocks predate compressCallId recording) stay visible until a REAL
// fold gives a cache-safe place to remove them (#3769). Failures must remain
// observable or a deterministic model re-issues the same no-op compress forever
// (billion-context-pi #9: 3,849 identical calls over 5h13m under keep=0), AND a
// quiet turn must never move the cached prefix breakpoint forward just to delete
// a few hundred chars of old failure residue — the old keep-last-two rotation did
// exactly that (hid the oldest failure on EVERY turn, seam cost far exceeding the
// bytes removed). Now: between folds nothing is swept; on a fold the node sweeps
// orphans at/after the fold's earliest start ref onto the persistent
// sweptOrphanCallIds set (they stay hidden forever), leaving orphans before it
// visible. Residue is bounded by fold cadence, not a fixed pair count.

export interface HideConsumedResult {
  messages: CoreMessage[];
  hidden: number;
  /** Padded refs of ALL currently-hidden orphan compress call/result messages
   *  (the persistent swept set, not just this pass). Consumed by boundary
   *  resolution to snap a range endpoint onto a hidden-but-intact orphan (#396). */
  hiddenOrphanRefs: string[];
  /** Orphan call ids newly swept by THIS pass (only when a fold was pending);
   *  the node unions these into state.sweptOrphanCallIds. Empty on quiet turns. */
  newlySweptCallIds: string[];
}

function rangeKey(startRef: string, endRef: string): string {
  return `${startRef}::${endRef}`;
}

// #3769: does this call's args quote the folded range of an ACTIVE block? Such a
// re-sent pair IS that block's summary carrier — the host strips the in-place
// anchor only while it rides the history (stripKernelSummaries, #1567/#2042) —
// so the fold-gated sweep must leave it alone. Both arg shapes are accepted to
// mirror the host index ({content:[…]} AND the flat {startId,endId} models emit
// natively); parseCallText alone misses the flat form. Unparseable args fail
// safe as NOT a carrier (under-sweep is safe, over-sweep is not).
function quotesActiveBlock(
  text: string | undefined,
  activeRangeKeys: Set<string>,
): boolean {
  const raw = text ?? "";
  const start = raw.indexOf("{");
  if (start < 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  let entries: unknown[];
  if (Array.isArray(obj.content)) {
    entries = obj.content;
  } else if (typeof obj.content === "string") {
    try {
      const inner: unknown = JSON.parse(obj.content);
      entries = Array.isArray(inner) ? inner : [];
    } catch {
      return false;
    }
  } else {
    entries = [obj];
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const s =
      typeof e.startId === "string"
        ? e.startId
        : typeof e.messageId === "string"
          ? e.messageId
          : "";
    const end =
      typeof e.endId === "string"
        ? e.endId
        : typeof e.messageId === "string"
          ? e.messageId
          : "";
    if (s && end && activeRangeKeys.has(rangeKey(s, end))) return true;
  }
  return false;
}

// Numeric position of a padded ref (mNNNNN -> NNNNN); null when unmapped/blocked
// so the caller treats it as "position unknown" and never sweeps on a guess.
// Exported: applyCompression derives the fold sweep marker from covered message
// refs through the same helper so both sides agree on "unknown" (#3769).
export function refNum(ref: string | undefined): number | null {
  if (!ref || ref === BLOCKED_REF) return null;
  const n = Number(ref.replace(/\D/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Named return type (not inline): with the object literal in the signature,
// prettier's layout heuristic was not idempotent here (#416).
interface ParsedCallText {
  prefix: string;
  obj: Record<string, unknown>;
  content: unknown[];
  contentWasString: boolean;
}

// Adapters (pi) persist the rendered ref tag in front of the tool-call text,
// so the JSON args no longer start at index 0. Locate the first "{" instead of
// parsing the raw text — the prefix is preserved on output.
function parseCallText(text: string | undefined): ParsedCallText | null {
  const raw = text ?? "";
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  let content: unknown[] | null = null;
  let contentWasString = false;
  if (Array.isArray(obj.content)) {
    content = obj.content;
  } else if (typeof obj.content === "string") {
    // Non-strict-tool providers (qwen etc.) sometimes stringify the content
    // array inside the JSON args; the compress tool accepts it, so the
    // rewrite must too. Measured: ALL 52 calls in the billion-context-pi
    // #336 storm session used this form (#230).
    contentWasString = true;
    try {
      const inner: unknown = JSON.parse(obj.content);
      if (Array.isArray(inner)) content = inner;
    } catch {
      content = null;
    }
  }
  if (!content || content.length === 0) return null;
  return { prefix: raw.slice(0, start), obj, content, contentWasString };
}

// Range keys a compress call's args quote, using the same startId/endId
// (messageId fallback) extraction as rewriteCompressText so identity-by-range
// resolves against exactly what the live-range compaction compares.
function quotedRangeKeys(text: string | undefined): Set<string> {
  const parsed = parseCallText(text);
  if (!parsed) return new Set<string>();
  const out = new Set<string>();
  for (const entry of parsed.content) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const s =
      typeof e.startId === "string"
        ? e.startId
        : typeof e.messageId === "string"
          ? e.messageId
          : "";
    const end =
      typeof e.endId === "string"
        ? e.endId
        : typeof e.messageId === "string"
          ? e.messageId
          : "";
    if (s && end) out.add(rangeKey(s, end));
  }
  return out;
}

function rewriteCompressText(
  text: string | undefined,
  liveKeys: Set<string>,
): string | null {
  const parsed = parseCallText(text);
  if (!parsed) return null;
  const { prefix, obj, content, contentWasString } = parsed;

  const kept = content.filter((entry): entry is Record<string, unknown> => {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    const s =
      typeof e.startId === "string"
        ? e.startId
        : typeof e.messageId === "string"
          ? e.messageId
          : "";
    const end =
      typeof e.endId === "string"
        ? e.endId
        : typeof e.messageId === "string"
          ? e.messageId
          : "";
    return liveKeys.has(rangeKey(s, end));
  });

  if (kept.length === 0) return null;

  return prefix + serializeCompacted(obj, kept, contentWasString).text;
}

// Live compress-call args duplicate every range's full summary text while the
// rendered acp_summary message already carries it — on long sessions the
// duplication alone measured ~22K tokens (billion-context-pi #336). Keep a
// leading stub for recall; the block remains the durable record.
const SUMMARY_STUB_CHARS = 200;

function compactEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return entry;
  const e = entry as Record<string, unknown>;
  if (typeof e.summary !== "string" || e.summary.length <= SUMMARY_STUB_CHARS)
    return entry;
  return {
    ...e,
    summary: `${clampPrefix(e.summary, SUMMARY_STUB_CHARS - 1)}…`,
  };
}

function serializeCompacted(
  obj: Record<string, unknown>,
  content: unknown[],
  contentWasString: boolean,
): { text: string; changed: boolean } {
  let changed = false;
  const compacted = content.map((entry) => {
    const out = compactEntry(entry);
    if (out !== entry) changed = true;
    return out;
  });
  // Preserve the original shape: a stringified content array stays a string
  // so downstream text comparisons and replays are unaffected.
  const outContent = contentWasString ? JSON.stringify(compacted) : compacted;
  return { text: JSON.stringify({ ...obj, content: outContent }), changed };
}

function compactCompressText(text: string | undefined): string | null {
  const parsed = parseCallText(text);
  if (!parsed) return null;
  const { prefix, obj, content, contentWasString } = parsed;
  const { text: out, changed } = serializeCompacted(
    obj,
    content,
    contentWasString,
  );
  return changed ? prefix + out : null;
}

export function hideConsumedCompressCalls(
  state: CompressionState,
  messages: CoreMessage[],
  isCompressTool: (toolName: string) => boolean = (name) =>
    name === COMPRESS_TOOL_NAME,
): HideConsumedResult {
  const allBlockCallIds = new Set<string>();
  const activeCallIds = new Set<string>();
  const liveRangeKeysByCallId = new Map<string, Set<string>>();
  const legacyLiveByCallId = new Set<string>();
  // Range keys over ALL blocks / ACTIVE blocks only — identity-by-range for
  // foreign-name carriers whose synthetic block id never equals the re-sent
  // host call id (#2970). Only consulted for non-bare-name calls, so the
  // proxy / in-process path is untouched.
  const anyBlockRangeKeys = new Set<string>();
  const activeRangeKeys = new Set<string>();
  for (const block of state.blocks) {
    if (!block.compressCallId) continue;
    allBlockCallIds.add(block.compressCallId);
    if (block.startRef !== undefined && block.endRef !== undefined) {
      anyBlockRangeKeys.add(rangeKey(block.startRef, block.endRef));
    }
    if (!block.active) continue;
    activeCallIds.add(block.compressCallId);
    if (block.startRef === undefined || block.endRef === undefined) {
      legacyLiveByCallId.add(block.compressCallId);
      continue;
    }
    activeRangeKeys.add(rangeKey(block.startRef, block.endRef));
    let keys = liveRangeKeysByCallId.get(block.compressCallId);
    if (!keys) {
      keys = new Set<string>();
      liveRangeKeysByCallId.set(block.compressCallId, keys);
    }
    keys.add(rangeKey(block.startRef, block.endRef));
  }

  type Fate = "active" | "inactive" | "orphan";
  const resolveFate = (message: CoreMessage): Fate => {
    const id = message.toolCallId;
    if (id && activeCallIds.has(id)) return "active";
    if (id && allBlockCallIds.has(id)) return "inactive";
    // Foreign-name carriers resolve by the range they quote (their block's
    // startRef/endRef). Bare-name is always id-matched, so this branch is
    // unreachable for it — stated explicitly so it cannot drift onto that path.
    if (!id || message.toolName === COMPRESS_TOOL_NAME) return "orphan";
    const quoted = quotedRangeKeys(message.text);
    for (const k of quoted) if (activeRangeKeys.has(k)) return "active";
    for (const k of quoted) if (anyBlockRangeKeys.has(k)) return "inactive";
    return "orphan";
  };

  const infos: { isCompressCall: boolean; fate: Fate }[] = messages.map(
    (message) => {
      const isCompressCall =
        !!message.toolName &&
        isCompressTool(message.toolName) &&
        message.contentType === "tool-call";
      return {
        isCompressCall,
        fate: isCompressCall ? resolveFate(message) : "orphan",
      };
    },
  );

  // #3769: orphans are removed only where a real fold already moved the cached
  // breakpoint. sweptSet holds orphans removed on earlier folds (persistent +
  // monotonic across turns/restarts/upgrades); pendingOrphanSweepMinRef carries
  // this fold's earliest start ref so we additionally sweep orphans at/after it.
  // Orphans before it sit in the still-cached prefix and stay visible; with no
  // fold pending nothing new is swept, so a quiet turn never breaks the prefix.
  // Orphans quoting an ACTIVE block's folded range are that block's summary
  // carrier (#1567) and are exempt from the sweep (quotesActiveBlock).
  const sweptSet = new Set(state.sweptOrphanCallIds ?? []);
  const foldMinRef = state.pendingOrphanSweepMinRef;
  const newlySweptCallIds: string[] = [];

  const keepCallIds = new Set<string>();
  const hiddenCallIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const info = infos[i]!;
    const callId = messages[i]!.toolCallId;
    if (!info.isCompressCall || !callId) continue;
    let hide = false;
    if (info.fate === "inactive") {
      hide = true;
    } else if (info.fate === "orphan") {
      const ref = state.messageRefs.byRaw[messages[i]!.id];
      const rememberedHidden: string[] = state.hiddenOrphanRefs ?? [];
      if (sweptSet.has(callId)) {
        hide = true;
      } else if (ref && rememberedHidden.includes(ref)) {
        // Pre-#3769 states persisted the rotation's hidden set as message refs
        // (hiddenOrphanRefs). Honor it on upgrade: resurrecting a pair the old
        // kernel already removed would re-insert it mid-history and break the
        // cached prefix again. The set self-perpetuates — rememberHiddenRef
        // re-records these refs on every pass they stay hidden.
        hide = true;
      } else if (foldMinRef !== undefined && !quotesActiveBlock(messages[i]!.text, activeRangeKeys)) {
        const num = refNum(ref);
        if (num !== null && num >= foldMinRef) {
          hide = true;
          newlySweptCallIds.push(callId);
        }
      }
    }
    if (hide) hiddenCallIds.add(callId);
    else keepCallIds.add(callId);
  }

  const fateByCallId = new Map<string, Fate>();
  for (let i = 0; i < messages.length; i++) {
    const info = infos[i]!;
    const callId = messages[i]!.toolCallId;
    if (info.isCompressCall && callId) fateByCallId.set(callId, info.fate);
  }

  let hidden = 0;
  const hiddenOrphanRefs: string[] = [];
  const rememberHiddenRef = (message: CoreMessage): void => {
    const fate = message.toolCallId
      ? fateByCallId.get(message.toolCallId)
      : undefined;
    if (fate !== "orphan") return;
    const ref = state.messageRefs.byRaw[message.id];
    if (ref && ref !== BLOCKED_REF && !hiddenOrphanRefs.includes(ref)) {
      hiddenOrphanRefs.push(ref);
    }
  };
  const result: CoreMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const info = infos[i]!;
    if (
      info.isCompressCall &&
      (!message.toolCallId || hiddenCallIds.has(message.toolCallId))
    ) {
      hidden++;
      rememberHiddenRef(message);
      continue;
    }
    if (
      message.contentType === "tool-result" &&
      message.toolCallId &&
      hiddenCallIds.has(message.toolCallId)
    ) {
      hidden++;
      rememberHiddenRef(message);
      continue;
    }
    if (
      info.isCompressCall &&
      message.toolCallId &&
      keepCallIds.has(message.toolCallId)
    ) {
      let liveKeys = liveRangeKeysByCallId.get(message.toolCallId);
      if (
        !liveKeys &&
        !legacyLiveByCallId.has(message.toolCallId) &&
        message.toolName !== COMPRESS_TOOL_NAME
      ) {
        // Foreign-name carrier: derive live ranges from what it quotes (its own
        // block's active ranges) — the by-callId index is keyed on the synthetic
        // block id, not the host call id.
        const derived = new Set<string>();
        for (const k of quotedRangeKeys(message.text)) {
          if (activeRangeKeys.has(k)) derived.add(k);
        }
        liveKeys = derived;
      }
      if (
        liveKeys &&
        liveKeys.size > 0 &&
        !legacyLiveByCallId.has(message.toolCallId)
      ) {
        const rewritten = rewriteCompressText(message.text, liveKeys);
        if (rewritten !== null) {
          result.push({ ...message, text: rewritten });
          continue;
        }
      }
      const compacted = compactCompressText(message.text);
      if (compacted !== null) {
        result.push({ ...message, text: compacted });
        continue;
      }
    }
    result.push(message);
  }

  return { messages: result, hidden, hiddenOrphanRefs, newlySweptCallIds };
}
