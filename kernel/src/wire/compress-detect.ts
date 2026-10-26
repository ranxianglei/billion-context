/**
 * Compress-call detection and replay-guard on the wire/core stream
 * (Phase K2, moved from billion-context-omp `src/wire-fold.ts`).
 *
 * Two layers:
 *  - Detection: `compressToolArgs` accepts the two call shapes that exist in
 *    the wild (direct `compress`; legacy `write` to `xd://compress`, args
 *    JSON-encoded one or two levels deep), `findCompressCalls` /
 *    `findCompressCallsCore` turn a stream tool-call into validated ranges.
 *  - Guard: when compression state is REPLAYED against a rebuilt stream
 *    (restart, mirror divergence, host re-serialization), every recorded
 *    range must prove it still covers the same content — fingerprint match
 *    (first/last piece content key), position fallback for drifted
 *    boundaries, remap for dangling m-refs.
 *
 * Pure functions over BiliMessage/CoreMessage — no host types, no I/O.
 */

import { createHash } from "node:crypto";
import type { CoreMessage } from "../types.js";
import type { BiliMessage } from "./bili-message.js";

/** A compress call carried by a stream tool-call, normalized to validated
 *  ranges. `id` is the tool-call id (replay dedup key). */
export interface StreamCompressCall {
  id: string;
  ranges: {
    startRef: string;
    endRef: string;
    summary: string;
    topic?: string;
    summaryMaxChars?: number;
    compressCallId: string;
  }[];
}

/** Extract a compress tool's arguments from a stream toolCall. Two call
 *  shapes exist: (1) top-level — the tools are registered with
 *  loadMode:"essential" so hosts do NOT mount them as xd:// devices; the
 *  stream shows name:"compress" directly. (2) legacy xd:// — sessions
 *  recorded before that change (or hosts forcing discoverable mounting)
 *  invoked compress through the write tool with path "xd://compress" and
 *  the tool args JSON-encoded in the content field. Both shapes must replay
 *  from the stream. Returns normalized compress args (content array plus
 *  optional topic / summaryMaxChars from wherever they live). */
export function compressToolArgs(call: { name: string; arguments?: unknown }): {
  content: unknown[];
  topic?: unknown;
  summaryMaxChars?: unknown;
} | null {
  let args = call.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  if (call.name === "compress") {
    return Array.isArray(a.content)
      ? {
          content: a.content,
          topic: a.topic,
          summaryMaxChars: a.summaryMaxChars,
        }
      : null;
  }
  if (call.name !== "write") return null;
  const path =
    typeof a.path === "string" ? a.path.split("?")[0]!.replace(/\/+$/, "") : "";
  if (path !== "xd://compress") return null;
  let inner: unknown = a.content;
  if (typeof inner === "string") {
    try {
      inner = JSON.parse(inner);
    } catch {
      return null;
    }
  }
  if (!inner || typeof inner !== "object") return null;
  if (Array.isArray(inner)) return { content: inner };
  const ia = inner as Record<string, unknown>;
  return Array.isArray(ia.content)
    ? {
        content: ia.content,
        topic: ia.topic,
        summaryMaxChars: ia.summaryMaxChars,
      }
    : { content: [ia] };
}

/** toolCallId → toolName for every tool-call piece (protected-piece
 *  detection: compress + configured tools are never folded). */
export function toolCallNames(msgs: BiliMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of msgs) {
    if (m.contentType === "tool-call" && m.toolCallId && m.toolName)
      names.set(m.toolCallId, m.toolName);
  }
  return names;
}

/** toolCallId → result text for every tool-result piece (compress result
 *  rendering inside rebuilt payloads). */
export function toolResultTextsCore(msgs: BiliMessage[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const m of msgs) {
    if (m.contentType !== "tool-result" || !m.toolCallId) continue;
    results.set(m.toolCallId, m.text ?? "");
  }
  return results;
}

/** Compress calls carried by a core tool-call piece. Same two shapes as the
 *  AgentMessage stream (direct compress; legacy xd://compress via write),
 *  with the arguments JSON-encoded in the piece's text. */
export function findCompressCallsCore(msg: BiliMessage): StreamCompressCall[] {
  if (msg.contentType !== "tool-call" || !msg.toolName) return [];
  const args = compressToolArgs({ name: msg.toolName, arguments: msg.text });
  if (!args) return [];
  const content = args.content;
  if (!Array.isArray(content)) return [];
  const ranges: StreamCompressCall["ranges"] = [];
  const callTopic = typeof args.topic === "string" ? args.topic : undefined;
  for (const item of content) {
    const r = item as {
      startId?: unknown;
      endId?: unknown;
      summary?: unknown;
      topic?: unknown;
    };
    if (
      typeof r.startId !== "string" ||
      typeof r.endId !== "string" ||
      typeof r.summary !== "string" ||
      r.summary.length === 0
    )
      continue;
    ranges.push({
      startRef: r.startId,
      endRef: r.endId,
      summary: r.summary,
      topic: typeof r.topic === "string" ? r.topic : callTopic,
      summaryMaxChars:
        typeof args.summaryMaxChars === "number"
          ? args.summaryMaxChars
          : undefined,
      compressCallId: msg.toolCallId ?? "",
    });
  }
  return ranges.length > 0 ? [{ id: msg.toolCallId ?? "", ranges }] : [];
}

/** Content key of a core piece for span fingerprints (issue #91): role,
 *  contentType, toolName and the FIRST 4096 chars of text. The 4096 cap is
 *  deliberate: a host re-serialization that drifts only the tail (beyond
 *  char 4096, e.g. truncation of a long tool output) keeps the key intact,
 *  so the replay guard tells a benign tail drift from a genuine rewrite. */
export function corePieceKey(cm: CoreMessage): string {
  return `${cm.role}|${cm.contentType}|${cm.toolName ?? ""}|${(cm.text ?? "").slice(0, 4096)}`;
}

/** Span fingerprint in content-hash space: hash the content keys of the
 *  exact first/last covered pieces. Boundary ids are pre-resolved (byRef /
 *  block lookup) — unlike the pN-space spanFingerprint there is no position
 *  parsing, ids are unique per piece. */
export function spanFingerprintCore(
  coreMessages: CoreMessage[],
  startId: string,
  endId: string,
): string {
  const find = (id: string): CoreMessage | undefined =>
    coreMessages.find((cm) => cm.id === id);
  const first = find(startId);
  const last = find(endId);
  if (!first || !last) return "";
  return createHash("sha1")
    .update(`${corePieceKey(first)}\u0000${corePieceKey(last)}`)
    .digest("hex")
    .slice(0, 8);
}

/** Index-based span fingerprint (issue #91 replay fallback): hash the content
 *  keys of the pieces AT the given stream positions. The stored fp still
 *  decides keep/drop — the position is only a recovery hint for a drifted
 *  boundary whose content-hash id no longer matches, so a benign tail drift
 *  (first-4096 intact) is kept while a real rewrite mismatches. */
export function spanFingerprintCoreIdx(
  coreMessages: CoreMessage[],
  startIdx: number,
  endIdx: number,
): string {
  const first = coreMessages[startIdx];
  const last = coreMessages[endIdx];
  if (!first || !last) return "";
  return createHash("sha1")
    .update(`${corePieceKey(first)}\u0000${corePieceKey(last)}`)
    .digest("hex")
    .slice(0, 8);
}

/** Structural subset the boundary resolvers need from a compression block
 *  (kernel CompressionBlock satisfies this; keeps the guard usable from
 *  downstreams that carry lighter block records). */
export interface BlockLike {
  blockId: string;
  effectiveMessageIds: string[];
}

/** Resolve a range boundary to the exact id of the piece it names, in
 *  content-hash space. Message refs go through byRef; block refs resolve to
 *  the earliest (min) or latest (max) covered piece by STREAM ORDER
 *  (index in coreMessages — the hash ids carry no position). */
export function boundaryRawCore(
  ref: string,
  byRef: Record<string, string>,
  blocks: BlockLike[],
  coreMessages: CoreMessage[],
  pick: "min" | "max",
): string {
  const raw = byRef[ref];
  if (raw) return raw;
  const m = /^b(\d+)$/i.exec(ref.trim());
  if (!m) return "";
  const block = blocks.find((b) => b.blockId.toLowerCase() === `b${m[1]}`);
  if (!block) return "";
  const idx = (id: string): number =>
    coreMessages.findIndex((cm) => cm.id === (byRef[id] ?? id));
  let best = -1;
  for (const id of block.effectiveMessageIds) {
    const i = idx(id);
    if (i < 0) continue;
    if (best < 0 || (pick === "min" ? i < best : i > best)) best = i;
  }
  return best < 0 ? "" : (coreMessages[best]?.id ?? "");
}

/** Resolve a range boundary to its STREAM INDEX in content-hash space. byRef /
 *  block lookup first (the exact piece it names, by array order); on a missed
 *  id (a drift re-hashed the piece so its carried ref dangles) fall back to
 *  the compress-time recorded index — the position hint, issue #91. -1 =
 *  unresolvable. */
export function boundaryIndexCore(
  ref: string,
  byRef: Record<string, string>,
  blocks: BlockLike[],
  coreMessages: CoreMessage[],
  pick: "min" | "max",
  fallbackIdx = -1,
): number {
  const id = boundaryRawCore(ref, byRef, blocks, coreMessages, pick);
  if (id) {
    const i = coreMessages.findIndex((cm) => cm.id === id);
    if (i >= 0) return i;
  }
  return fallbackIdx >= 0 && fallbackIdx < coreMessages.length
    ? fallbackIdx
    : -1;
}

/** Structured replay-guard verdict (issue #91, rework): the position
 *  fallback recovers the STREAM INDEX of a drifted boundary, but the kernel
 *  resolves ranges by REF — so when a recorded m-ref dangles, the replay
 *  must re-apply that boundary under the CURRENT ref of the recovered piece.
 *  `remap` carries exactly that (only dangling m-refs are remapped; block
 *  refs resolve themselves inside the kernel and are never touched). */
export type ReplayRangeVerdict = {
  /** Stale: the range must be dropped (master semantics, unchanged). */
  reject?: string;
  /** Dangling m-refs recovered by position, remapped to current refs. */
  remap?: { startRef?: string; endRef?: string };
  /** True when the result text carried a [pos=] pair for this range —
   *  with `reject` set it marks a RECOVERY FAILURE (always logged). */
  hint?: boolean;
  /** Diagnostics — always logged when a recovery happens. */
  recovered?: { pos: string; startIdx: number; endIdx: number };
};

/** Current m-ref of the piece at stream index idx (inverse byRef scan).
 *  "" when the piece has no ref (protected) — the replay must fail closed
 *  rather than hand the kernel a ref it does not know. Replay-time only
 *  (replayed compress calls), so the O(refs) scan stays off the hot path. */
export function refOfPieceCore(
  coreMessages: BiliMessage[],
  idx: number,
  byRef: Record<string, string>,
): string {
  const id = coreMessages[idx]?.id;
  if (!id) return "";
  for (const [ref, mapped] of Object.entries(byRef))
    if (mapped === id) return ref;
  return "";
}

export function staleRangeCore(
  r: { startRef: string; endRef: string },
  rangeIndex: number,
  resultText: string,
  coreMessages: BiliMessage[],
  callIndex: number,
  byRef: Record<string, string>,
  blocks: BlockLike[],
): ReplayRangeVerdict {
  // Compress-time boundary positions (issue #91): the stream index each
  // boundary sat at when the call was recorded. A drift that re-hashes a
  // boundary piece dangles its carried ref — the position recovers it, and
  // the fingerprint below still decides keep/drop.
  const pm = resultText.match(/\[pos=([0-9,-]+)\]/);
  const pair = pm ? (pm[1]!.split(",")[rangeIndex] ?? "-") : "-";
  const hinted = pair !== "-";
  const [ps, pe] = pair === "-" ? ["", ""] : pair.split("-");
  const fbStart = ps && ps !== "" ? Number.parseInt(ps, 10) : -1;
  const fbEnd = pe && pe !== "" ? Number.parseInt(pe, 10) : -1;

  // Raw resolution (id → stream index) separately from the fallback, so a
  // dangling m-ref recovered by position can be flagged for remapping.
  const startRaw = boundaryRawCore(
    r.startRef,
    byRef,
    blocks,
    coreMessages,
    "min",
  );
  const endRaw = boundaryRawCore(r.endRef, byRef, blocks, coreMessages, "max");
  const rawStartIdx = startRaw
    ? coreMessages.findIndex((cm) => cm.id === startRaw)
    : -1;
  const rawEndIdx = endRaw
    ? coreMessages.findIndex((cm) => cm.id === endRaw)
    : -1;
  const startIdx =
    rawStartIdx >= 0
      ? rawStartIdx
      : fbStart >= 0 && fbStart < coreMessages.length
        ? fbStart
        : -1;
  const endIdx =
    rawEndIdx >= 0
      ? rawEndIdx
      : fbEnd >= 0 && fbEnd < coreMessages.length
        ? fbEnd
        : -1;
  if (startIdx < 0 || endIdx < 0) {
    if (!/^b\d+$/i.test(r.startRef.trim()) && !/^b\d+$/i.test(r.endRef.trim()))
      return {
        reject: `unresolved ${r.startRef}..${r.endRef} -> ${startIdx}..${endIdx}`,
        ...(hinted ? { hint: true } : {}),
      };
    return {}; // block ref(s): the kernel resolves them itself (master)
  }
  // The end piece must precede the call that issued it — a rewrite moved
  // the call and the fingerprint check below is meaningless either way.
  if (endIdx > callIndex)
    return {
      reject: `end idx ${endIdx} > callIndex ${callIndex}`,
      ...(hinted ? { hint: true } : {}),
    };
  const m = resultText.match(/\[fp=([0-9a-f,-]+)\]/);
  if (m) {
    const want = m[1]!.split(",")[rangeIndex];
    if (want !== undefined && want !== "-") {
      const got = spanFingerprintCoreIdx(coreMessages, startIdx, endIdx);
      if (want !== got)
        return {
          reject: `fp ${r.startRef}..${r.endRef} want ${want} got ${got} @${startIdx}..${endIdx}`,
          ...(hinted ? { hint: true } : {}),
        };
    }
  }
  // Remap only the boundaries that actually dangled (m-refs whose recorded id
  // no longer resolves); resolved boundaries keep their recorded ref, block
  // refs are the kernel's to resolve.
  const remap: { startRef?: string; endRef?: string } = {};
  if (/^m\d+$/i.test(r.startRef.trim()) && rawStartIdx < 0) {
    const ref = refOfPieceCore(coreMessages, startIdx, byRef);
    if (!ref)
      return {
        reject: `recovered ${r.startRef} @${startIdx} has no ref (protected piece)`,
        ...(hinted ? { hint: true } : {}),
      };
    remap.startRef = ref;
  }
  if (/^m\d+$/i.test(r.endRef.trim()) && rawEndIdx < 0) {
    const ref = refOfPieceCore(coreMessages, endIdx, byRef);
    if (!ref)
      return {
        reject: `recovered ${r.endRef} @${endIdx} has no ref (protected piece)`,
        ...(hinted ? { hint: true } : {}),
      };
    remap.endRef = ref;
  }
  if (!remap.startRef && !remap.endRef) return {};
  return { remap, recovered: { pos: pair, startIdx, endIdx } };
}

/** One fingerprint per range for the replay guard, content-hash space
 *  (mirrors rangeFingerprints for the pN space). */
export function rangeFingerprintsCore(
  ranges: Array<{ startRef: string; endRef: string }>,
  coreMessages: BiliMessage[],
  byRef: Record<string, string>,
  blocks: BlockLike[],
): string[] {
  return ranges.map((r) => {
    const start = boundaryRawCore(
      r.startRef,
      byRef,
      blocks,
      coreMessages,
      "min",
    );
    const end = start
      ? boundaryRawCore(r.endRef, byRef, blocks, coreMessages, "max")
      : "";
    if (start && end) {
      const fp = spanFingerprintCore(coreMessages, start, end);
      if (fp.length > 0) return fp;
    }
    return "-";
  });
}

/** One boundary-index pair per range for the replay fallback (issue #91),
 *  aligned with rangeFingerprintsCore: the stream index of each range's exact
 *  first/last covered piece at record time ("-1" pair when a boundary can't
 *  be positioned), so the replay can recover a drifted boundary by position. */
export function rangePositionsCore(
  ranges: Array<{ startRef: string; endRef: string }>,
  coreMessages: CoreMessage[],
  byRef: Record<string, string>,
  blocks: BlockLike[],
): string[] {
  return ranges.map((r) => {
    const s = boundaryIndexCore(r.startRef, byRef, blocks, coreMessages, "min");
    const e =
      s >= 0
        ? boundaryIndexCore(r.endRef, byRef, blocks, coreMessages, "max")
        : -1;
    return s >= 0 && e >= 0 ? `${s}-${e}` : "-";
  });
}
