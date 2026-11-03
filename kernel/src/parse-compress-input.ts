// Single lenient parser for compress tool arguments, with structured
// diagnostics for the failure shapes that actually occur in production.
//
// Models and LLM gateways do not always emit strict JSON for the compress
// tool call. Observed shapes:
//   - fenced JSON: "```json ... ```"
//   - trailing commas
//   - raw newlines inside string values (line-wrapped summaries)
//   - the whole arguments object stringified by the gateway (vLLM,
//     billion-context#176)
//   - single-quoted JSON: {'content': [...]} (weak local models,
//     billion-context#603 / omp#121)
//   - a single entry OBJECT where the content array belongs (retry drift,
//     billion-context#1494 / acp-kernel#470)
//   - the stream cut off mid-arguments, leaving a truncated JSON prefix
//
// Hosts parse this on their own today: rebuild.ts (strict, silent skip),
// the billion-context proxy (strict, silent {}), billion-context-pi
// (strict, throw), billion-context-omp (strict, silent null). This module
// is the shared implementation the adapters converge on (acp-kernel#108).
//
// Salvage semantics: for truncated input, the complete entries of the
// `content` array are recovered from the surviving prefix. A partially
// written entry is dropped, never guessed. Diagnostics are data, not logs:
// adapters decide where to emit them (log line, debug event, tool text).

import { clampPrefix } from "./truncate.js";
import type { CompressRangeSpec } from "./types.js";

export type CompressParseKind =
  | "ok"
  | "empty-input"
  | "not-object"
  | "missing-content"
  | "content-not-array"
  | "malformed-json"
  | "truncated"
  | "no-valid-ranges";

export interface CompressParseDiagnostics {
  /** true only when at least one range was recovered. */
  ok: boolean;
  /** Why the input parsed the way it did. */
  kind: CompressParseKind;
  /** True when the winning parse came from single→double quote repair. */
  quoteSalvage?: boolean;
  /** True when a flat single-range call carried its summary text in the
   * `content` STRING alongside top-level refs ({content, startId, endId})
   * — the two schema-advertised shapes merged — and was recovered. */
  flatSummarySalvage?: boolean;
  /** True when a non-array `content` value (single entry object or nested
   *  `ranges` array) was recovered into the canonical array form (#470). */
  contentSalvage?: boolean;
  /** First 800 chars of the raw string input (string inputs only). */
  rawPrefix?: string;
  /** Raw string input length (string inputs only). */
  length?: number;
  /** Top-level keys of the parsed object — catches `content` vs `ranges` drift. */
  keys?: string[];
  /** Entries dropped because they were not valid ranges. */
  invalidItems: number;
  /** One human-readable reason per dropped entry (index-prefixed). */
  invalidReasons?: string[];
}

export interface ParsedCompressInput {
  ranges: CompressRangeSpec[];
  diagnostics: CompressParseDiagnostics;
}

/**
 * Parse compress tool arguments in any host wire shape.
 *
 * Accepts a decoded object, a JSON string (possibly fenced, trailing-comma,
 * raw-newline, or double-stringified), or a truncated JSON prefix (salvage
 * mode). Invalid entries are skipped, never fatal; the reason is in
 * `diagnostics.kind`.
 */
export function parseCompressArgs(
  input: unknown,
  opts?: { callId?: string },
): ParsedCompressInput {
  const callId = opts?.callId;
  const diag: CompressParseDiagnostics = {
    ok: false,
    kind: "ok",
    invalidItems: 0,
  };

  if (input === null || input === undefined) {
    diag.kind = "empty-input";
    return finish([], diag);
  }

  if (typeof input === "string") {
    return parseStringInput(input, callId, diag);
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    diag.kind = "not-object";
    return finish([], diag);
  }

  return parseObjectValue(input as Record<string, unknown>, callId, diag);
}

function parseStringInput(
  raw: string,
  callId: string | undefined,
  diag: CompressParseDiagnostics,
): ParsedCompressInput {
  diag.rawPrefix = clampPrefix(raw, 800);
  diag.length = raw.length;
  const cleaned = stripFence(raw.trim());
  const first = parseStringCore(cleaned, callId, diag);
  // Weak local models emit single-quoted args ({'content': [...]}). The
  // salvage regex only recognizes double-quoted "content", so a truncated
  // single-quoted prefix recovers nothing on the first pass. Retry once
  // with the quotes normalized; the retry wins only if it recovers strictly
  // more ranges, so valid input is never rewritten.
  if (first.ranges.length === 0 || first.diagnostics.invalidItems > 0) {
    const normalized = normalizeSingleQuotes(cleaned);
    if (normalized !== undefined) {
      const retryDiag: CompressParseDiagnostics = {
        ok: false,
        kind: "ok",
        invalidItems: 0,
      };
      retryDiag.rawPrefix = diag.rawPrefix;
      retryDiag.length = diag.length;
      const retry = parseStringCore(normalized, callId, retryDiag);
      if (retry.ranges.length > first.ranges.length) {
        retryDiag.quoteSalvage = true;
        return retry;
      }
    }
  }
  return first;
}

function parseStringCore(
  cleaned: string,
  callId: string | undefined,
  diag: CompressParseDiagnostics,
): ParsedCompressInput {
  if (cleaned === "") {
    diag.kind = "empty-input";
    return finish([], diag);
  }

  let value: unknown = tryParseLenient(cleaned);
  // One level of double-stringification: the host wrapped an already
  // stringified argument in another JSON string.
  if (typeof value === "string") {
    const inner = tryParseLenient(stripFence(value));
    if (inner !== undefined) value = inner;
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return parseObjectValue(value as Record<string, unknown>, callId, diag);
  }
  if (value !== undefined) {
    // Parsed, but not to an object: bare array, number, boolean, null.
    diag.kind = "not-object";
    return finish([], diag);
  }

  // Unparseable prefix: salvage the complete content-array entries.
  const entries = salvageContentEntries(cleaned);
  return finishSalvage(entries, callId, diag, looksTruncated(cleaned));
}

function parseObjectValue(
  value: Record<string, unknown>,
  callId: string | undefined,
  diag: CompressParseDiagnostics,
): ParsedCompressInput {
  diag.keys = Object.keys(value);
  const content = value["content"];
  if (content === undefined) {
    // Model drift: a single range at the top level (no content array).
    // The proxy defends against this shape; the kernel now owns it.
    const single = validateEntry(value, callId);
    if ("range" in single) {
      diag.kind = "ok";
      return finish([single.range], diag);
    }
    diag.kind = "missing-content";
    return finish([], diag);
  }

  let entries: unknown[];
  let salvaged = false;

  if (Array.isArray(content)) {
    entries = content;
  } else if (typeof content === "string") {
    // Stringified content array: vLLM-style gateways stringify nested
    // arrays, so `content` arrives as a JSON string of the array.
    const parsed = parseContentArray(content);
    if (
      parsed === null ||
      (parsed.entries.length === 0 && content.trim().length > 0)
    ) {
      // Not a JSON array (or nothing salvageable): bare line-form text.
      // Strip JSON-wrapper residue (stringified ["…"] with broken
      // escaping) — the line form needs structure only in the refs
      // header line, so the summary body never has to parse.
      const bare = stripJsonWrapperResidue(content);
      const entries = splitLineEntries(bare);
      const { ranges, invalid, reasons } = validateEntries(entries, callId);
      if (ranges.length > 0) {
        diag.invalidItems = invalid;
        if (reasons.length > 0) diag.invalidReasons = reasons;
        diag.kind = "ok";
        return finish(ranges, diag);
      }
      if (entries.length === 0 || entries.every(isHeaderlessLineEntry)) {
        // No refs headers inside the string: the text may be the SUMMARY of
        // a single flat range whose bounds sit at the TOP level — the two
        // schema-advertised shapes ("content = ONE plain string" + the
        // {startId, endId} single-range form) merged into one call.
        // Observed live as bursts of identical `content-not-array`
        // rejections while the model retried the same valid-intent call.
        const flat = flatSingleRangeFromContent(value, content, callId);
        if (flat !== undefined) {
          diag.flatSummarySalvage = true;
          diag.kind = "ok";
          return finish([flat], diag);
        }
      }
      // Refs-bearing entries that failed validation are a real line-form
      // attempt (report no-valid-ranges + reasons); all-headerless text was
      // never line-form (keep the generic content-not-array classification).
      diag.invalidItems = invalid;
      if (reasons.length > 0) diag.invalidReasons = reasons;
      diag.kind = entries.some((e) => !isHeaderlessLineEntry(e))
        ? "no-valid-ranges"
        : "content-not-array";
      return finish([], diag);
    }
    entries = parsed.entries;
    salvaged = parsed.salvaged;
    if (parsed.quoteRepaired) diag.quoteSalvage = true;
  } else if (content !== null && typeof content === "object") {
    // #470: a single entry OBJECT in the content slot instead of a
    // one-element array — the SAME drift the top level already recovers
    // (bare entry without content, above). Wrap it so the shared
    // validation applies unchanged; a nested `ranges` array is unwrapped
    // instead. Mirrors the proxy-lane normalization (billion-context#1497)
    // so both lanes converge on this ladder.
    const obj = content as Record<string, unknown>;
    const nested = obj["ranges"];
    entries = Array.isArray(nested) ? nested : [obj];
    diag.contentSalvage = true;
  } else {
    diag.kind = "content-not-array";
    return finish([], diag);
  }

  const { ranges, invalid, reasons } = validateEntries(entries, callId);
  // Top-level fallbacks: topic and summaryMaxChars apply to every range
  // that does not specify its own (omp/pi schemas define both at the top
  // level; per-entry values win).
  const topTopic = stringOr(value["topic"]);
  const topMaxChars = value["summaryMaxChars"];
  const hasTopMaxChars =
    typeof topMaxChars === "number" && Number.isFinite(topMaxChars);
  if (topTopic !== undefined || hasTopMaxChars) {
    for (const r of ranges) {
      if (r.topic === undefined && topTopic !== undefined) r.topic = topTopic;
      if (r.summaryMaxChars === undefined && hasTopMaxChars)
        r.summaryMaxChars = topMaxChars;
    }
  }
  diag.invalidItems = invalid;
  if (reasons.length > 0) diag.invalidReasons = reasons;
  diag.kind = salvaged
    ? "truncated"
    : ranges.length > 0
      ? "ok"
      : "no-valid-ranges";
  return finish(ranges, diag);
}

// A split line entry whose first line carries NO refs at all — pure prose.
// Only headerless content is eligible for the flat single-range recovery
// below (text with refs headers must keep its line-form reading, whatever
// its validation outcome).
function isHeaderlessLineEntry(e: unknown): boolean {
  if (typeof e !== "string") return false;
  const nl = e.indexOf("\n");
  const head = (nl === -1 ? e : e.slice(0, nl)).trim();
  return !REF_PAIR_IN_LINE.test(head) && !SINGLE_REF_IN_LINE.test(head);
}

// Flat single-range recovery: summary text in the `content` STRING with
// bounds at the top level ({content, startId, endId, topic?}). Applies only
// when the content string carries NO refs headers of its own — a line-form
// string with headers was already parsed (or reported) above. A JSON-encoded
// {summary, topic} object inside the string (gateway double-encode) is
// unwrapped first. Returns undefined when the shape does not fit.
function flatSingleRangeFromContent(
  value: Record<string, unknown>,
  content: string,
  callId: string | undefined,
): CompressRangeSpec | undefined {
  const start =
    stringOr(value["startRef"]) ??
    stringOr(value["startId"]) ??
    stringOr(value["messageId"]);
  const end =
    stringOr(value["endRef"]) ??
    stringOr(value["endId"]) ??
    stringOr(value["messageId"]);
  if (start === undefined || end === undefined) return undefined;
  let summary = stringOr(value["summary"]);
  let topic = stringOr(value["topic"]);
  if (summary === undefined) {
    const inner = tryParseLenient(stripFence(content.trim()));
    if (
      inner !== null &&
      typeof inner === "object" &&
      !Array.isArray(inner)
    ) {
      const o = inner as Record<string, unknown>;
      summary = stringOr(o["summary"]);
      if (topic === undefined) topic = stringOr(o["topic"]);
    }
    if (summary === undefined) {
      const text = content.trim();
      if (text.length > 0) summary = text;
    }
  }
  if (summary === undefined) return undefined;
  const entry: Record<string, unknown> = { startRef: start, endRef: end, summary };
  if (topic !== undefined) entry["topic"] = topic;
  const outcome = validateEntry(entry, callId);
  return "range" in outcome ? outcome.range : undefined;
}

function parseContentArray(
  s: string,
): { entries: unknown[]; salvaged: boolean; quoteRepaired?: boolean } | null {
  const cleaned = stripFence(s.trim());
  const direct = parseContentArrayCore(cleaned);
  if (direct !== null && direct.entries.length > 0) return direct;
  // Single-quoted array (weak local models): normalize once and re-run;
  // the retry is adopted only if it recovers strictly more entries.
  const normalized = normalizeSingleQuotes(cleaned);
  if (normalized !== undefined) {
    const retry = parseContentArrayCore(normalized);
    if (retry !== null && retry.entries.length > 0)
      return { ...retry, quoteRepaired: true };
  }
  return direct;
}

function parseContentArrayCore(
  s: string,
): { entries: unknown[]; salvaged: boolean } | null {
  let value: unknown = s === "" ? undefined : tryParseLenient(s);
  if (typeof value === "string") {
    value = tryParseLenient(stripFence(value));
  }
  if (Array.isArray(value)) {
    return { entries: value, salvaged: false };
  }
  if (value === undefined) {
    // Unparseable (usually truncated): recover the complete entries.
    const entries = salvageContentEntries('{"content": ' + s);
    return { entries, salvaged: entries.length > 0 };
  }
  return null;
}

function finish(
  ranges: CompressRangeSpec[],
  diag: CompressParseDiagnostics,
): ParsedCompressInput {
  diag.ok = ranges.length > 0;
  return { ranges, diagnostics: diag };
}

function finishSalvage(
  entries: unknown[],
  callId: string | undefined,
  diag: CompressParseDiagnostics,
  truncatedShape: boolean,
): ParsedCompressInput {
  const { ranges, invalid, reasons } = validateEntries(entries, callId);
  diag.invalidItems = invalid;
  if (reasons.length > 0) diag.invalidReasons = reasons;
  diag.kind =
    entries.length > 0 || truncatedShape ? "truncated" : "malformed-json";
  return finish(ranges, diag);
}

// #1001 (problem 3): models routinely split the documented line form across
// array elements — `["m00158–m01712 topic", "## TASK ..."]` — emitting the
// refs header and the summary as SIBLING strings instead of one multi-line
// string. Each half alone is invalid (header lacks a summary; the summary
// lacks refs), so the whole call dies with dropped=N even though the intent
// is unambiguous. Coalesce before validation: a refless string entry that
// follows a header-only string entry is its summary body. Complete entries
// (header + \n + body in one string) and object entries reset the pairing —
// a stray refless string after a complete entry stays invalid, as today.
function coalesceLineEntries(entries: unknown[]): unknown[] {
  const out: unknown[] = [];
  let headerOnlyIdx = -1;
  for (const e of entries) {
    if (typeof e === "string") {
      const nl = e.indexOf("\n");
      const head = (nl === -1 ? e : e.slice(0, nl)).trim();
      const hasRef =
        REF_PAIR_IN_LINE.test(head) || SINGLE_REF_IN_LINE.test(head);
      if (!hasRef && headerOnlyIdx >= 0) {
        out[headerOnlyIdx] = `${out[headerOnlyIdx] as string}\n${e}`;
        continue;
      }
      out.push(e);
      headerOnlyIdx = hasRef && nl === -1 ? out.length - 1 : -1;
    } else {
      out.push(e);
      headerOnlyIdx = -1;
    }
  }
  return out;
}

function validateEntries(
  entries: unknown[],
  callId: string | undefined,
): { ranges: CompressRangeSpec[]; invalid: number; reasons: string[] } {
  const ranges: CompressRangeSpec[] = [];
  const reasons: string[] = [];
  let invalid = 0;
  const items = coalesceLineEntries(entries);
  for (let i = 0; i < items.length; i++) {
    const outcome = validateEntry(items[i], callId);
    if ("range" in outcome) ranges.push(outcome.range);
    else {
      invalid++;
      reasons.push(`entry ${i}: ${outcome.reason}`);
    }
  }
  return { ranges, invalid, reasons };
}

type EntryOutcome = { range: CompressRangeSpec } | { reason: string };

// Line-form entries (non-strict-tool providers): each entry is ONE string —
// first line "m00150–m00220 optional topic", remaining lines the markdown
// summary verbatim. No object shell, no per-range JSON escaping; the only
// hard requirement is refs at the START of the first line. Both patterns are
// anchored (^): summaries cite mNNNNN/bN refs routinely, so an unanchored
// scan would let a citation inside a headerless entry supply fake bounds.
const REF_PAIR_IN_LINE =
  /^([mb]\d{1,7})\s*(?:[-\u2013\u2014\u2026~\u2212\uFF0D]|\.\.\.|to)\s*([mb]\d{1,7})\b/i;
const SINGLE_REF_IN_LINE = /^([mb]\d{1,7})\b/i;
// An unrecognized divider between two refs (punctuation run + a ref right
// after) — the pair regex missed a separator variant. Folding as a single
// ref would silently compress ONE message of a many-message range.
const UNRECOGNIZED_REF_SEP_RE =
  /^\s*[^\p{L}\p{N}\s]{1,3}\s*[mb]\d{1,7}\b/iu;

function normalizeLineRef(raw: string): string {
  const lower = raw.toLowerCase();
  const digits = lower.slice(1);
  return lower[0]! === "b" ? `b${digits}` : `m${digits.padStart(5, "0")}`;
}

function parseLineEntry(
  entry: string,
  callId: string | undefined,
): EntryOutcome {
  const nl = entry.indexOf("\n");
  const head = (nl === -1 ? entry : entry.slice(0, nl)).trim();
  const summary = (nl === -1 ? "" : entry.slice(nl + 1)).trim();
  const pair = REF_PAIR_IN_LINE.exec(head);
  let startRef: string;
  let endRef: string;
  let afterRefs: number;
  if (pair !== null) {
    startRef = normalizeLineRef(pair[1]!);
    endRef = normalizeLineRef(pair[2]!);
    afterRefs = pair.index + pair[0].length;
  } else {
    const single = SINGLE_REF_IN_LINE.exec(head);
    if (single === null)
      return { reason: "line entry: no mNNNNN/bN refs in header" };
    // A second ref behind an unrecognized separator means this was meant to
    // be a PAIR — accept it as a single ref and the fold would silently
    // cover ONE message of a many-message range. Reject with a precise
    // reason so the caller restates the range with a known separator.
    const rest = head.slice(single.index + single[0].length);
    if (UNRECOGNIZED_REF_SEP_RE.test(rest))
      return {
        reason: "line entry: refs separator not recognized — refusing to narrow a ref pair to its first ref (use -, –, —, …, ~, .., or to)",
      };
    startRef = normalizeLineRef(single[1]!);
    endRef = startRef;
    afterRefs = single.index + single[0].length;
  }
  if (summary.length === 0)
    // #4521: name the two most common shapes behind this parse error — a
    // stray note line about an already-folded range, and a block rewrite
    // written as refs — so the model fixes the entry instead of resending it
    // verbatim (each resend was a full failed round-trip).
    return { reason: "line entry: missing summary after the refs header line (every entry needs refs THEN its summary text on the same or the next line; a note about an already-folded range does not belong in the batch — drop it; to rewrite an existing block use a bN..bM block-id header entry)" };
  const explicitTopic = head.slice(afterRefs).trim();
  const range: CompressRangeSpec = {
    startRef,
    endRef,
    summary,
    topic:
      explicitTopic.length > 0
        ? explicitTopic
        : deriveTopicFromSummary(summary),
  };
  if (callId !== undefined) range.compressCallId = callId;
  return { range };
}

/** Display/retrieval label for line-form entries without an explicit topic:
 *  the summary's first markdown heading, else its first non-empty line,
 *  truncated. The topic is metadata (panels, T2 source headers, search) —
 *  never load-bearing for correctness. */
export function deriveTopicFromSummary(summary: string): string | undefined {
  const heading = /^#{1,6}\s+(.+)$/m.exec(summary);
  const source =
    heading !== null
      ? heading[1]!
      : (summary.split("\n").find((l) => l.trim().length > 0) ?? "");
  const text = source.trim().replace(/^[\u2022\-*]\s+/, "");
  if (text.length === 0) return undefined;
  return text.length > 60 ? clampPrefix(text, 60).trimEnd() : text;
}

const LINE_ENTRY_REFS_RE =
  /[mb]\d{1,7}\s*(?:[-\u2013\u2014\u2026~\u2212\uFF0D]|\.\.\.|to)\s*[mb]\d{1,7}\b/iy;
const WHITESPACE_RE = /\s/;

function skipWhitespace(s: string, i: number): number {
  while (i < s.length && WHITESPACE_RE.test(s[i]!)) i++;
  return i;
}

function isQuote(ch: string | undefined): boolean {
  return ch === '"' || ch === "'";
}

function refsHeaderAt(s: string, i: number): boolean {
  LINE_ENTRY_REFS_RE.lastIndex = i;
  return LINE_ENTRY_REFS_RE.test(s);
}

// Deterministic form of `\s*(?:["']\s*,\s*)?["']?\s*<refs>` at `i`, which
// sits just past the leading whitespace run.
function startsLineEntry(s: string, i: number): boolean {
  if (!isQuote(s[i])) return refsHeaderAt(s, i);
  const afterQuote = skipWhitespace(s, i + 1);
  if (s[afterQuote] !== ",") return refsHeaderAt(s, afterQuote);
  const afterComma = skipWhitespace(s, afterQuote + 1);
  if (!isQuote(s[afterComma])) return refsHeaderAt(s, afterComma);
  return refsHeaderAt(s, skipWhitespace(s, afterComma + 1));
}

/** Split a bare string content (not a JSON array) into line-form entries: a
 *  line that starts a ref pair begins a new entry. The split tolerates
 *  stringified-element residue (the previous element's closing quote, the
 *  separating comma, the next element's opening quote) before the next refs
 *  header — batch payloads that lost their JSON escaping still split on their
 *  headers. Fallback path only — arrays of strings are the primary line-form
 *  transport.
 *
 *  Security: the content is model-written. A regex lookahead with adjacent
 *  `\s*` runs backtracks cubically over a long whitespace run, so the header
 *  test is a linear scan. Every newline in one whitespace run reaches the same
 *  next non-space character, so the test runs once per run. */
function splitLineEntries(content: string): unknown[] {
  const chunks: string[] = [];
  let chunkStart = 0;
  let nl = content.indexOf("\n");
  while (nl !== -1) {
    const runEnd = skipWhitespace(content, nl + 1);
    if (startsLineEntry(content, runEnd)) {
      for (let p = nl; p < runEnd; p++) {
        if (content[p] !== "\n") continue;
        chunks.push(content.slice(chunkStart, p));
        chunkStart = p + 1;
      }
    }
    nl = content.indexOf("\n", runEnd);
  }
  chunks.push(content.slice(chunkStart));
  const parts = chunks
    .map((p) =>
      p
        .trim()
        .replace(/^(?:["']\s*,?\s*)+/, "")
        .replace(/["']\s*$/, ""),
    )
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : [content.trim()];
}

// Remove the leftover shell of a stringified-but-unescaped array/element:
// leading [ and a quote, trailing ] and a quote. Salvage-context only — it
// runs after JSON.parse has already failed, so these chars are residue, not
// content. Anything deeper and the line form stops being the right tool.
function stripJsonWrapperResidue(s: string): string {
  let t = s.trim();
  if (t.startsWith("[")) t = t.replace(/^\[+\s*/, "");
  t = t.replace(/^"/, "");
  if (t.endsWith("]")) {
    let end = t.length;
    while (end > 0 && t[end - 1] === "]") end--;
    t = t.slice(0, end).trimEnd();
  }
  t = t.replace(/"$/, "");
  return t.trim();
}

function validateEntry(
  entry: unknown,
  callId: string | undefined,
): EntryOutcome {
  if (typeof entry === "string") return parseLineEntry(entry, callId);
  if (entry === null || typeof entry !== "object" || Array.isArray(entry))
    return { reason: "not an object" };
  const e = entry as Record<string, unknown>;
  // Field-name variants: startRef/endRef are canonical; startId/endId is
  // model drift (and the legacy rebuild.ts spelling); messageId is the
  // startId-less messageRef from the historical API.
  const start =
    stringOr(e["startRef"]) ??
    stringOr(e["startId"]) ??
    stringOr(e["messageId"]);
  const end =
    stringOr(e["endRef"]) ?? stringOr(e["endId"]) ?? stringOr(e["messageId"]);
  if (start === undefined || end === undefined) {
    return {
      reason: "missing range bounds (need startRef/startId and endRef/endId)",
    };
  }
  const summary = stringOr(e["summary"]);
  if (summary === undefined) return { reason: "missing summary" };
  const range: CompressRangeSpec = { startRef: start, endRef: end, summary };
  const topic = stringOr(e["topic"]);
  if (topic !== undefined) range.topic = topic;
  const maxChars = e["summaryMaxChars"];
  if (typeof maxChars === "number" && Number.isFinite(maxChars))
    range.summaryMaxChars = maxChars;
  if (callId !== undefined) range.compressCallId = callId;
  return { range };
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// --- tolerant JSON parsing -------------------------------------------------

function tryParseLenient(s: string): unknown {
  if (s === "") return undefined;
  try {
    return JSON.parse(s);
  } catch {
    // keep trying the repaired variants below
  }
  const noTrailingCommas = stripTrailingCommas(s);
  if (noTrailingCommas !== s) {
    try {
      return JSON.parse(noTrailingCommas);
    } catch {
      // keep trying
    }
  }
  const fixed = escapeRawNewlinesInStrings(noTrailingCommas);
  if (fixed !== noTrailingCommas) {
    try {
      return JSON.parse(fixed);
    } catch {
      // fall through to salvage
    }
  }
  // Unescaped inner quotes and markdown backslash escapes (\`, \-) defeat
  // the string state machines above; the parser's own error position
  // pinpoints the real offending characters. Repair exactly where it says
  // and iterate.
  const ctrlFixed = repairAtParserPositions(noTrailingCommas);
  if (ctrlFixed !== noTrailingCommas) {
    try {
      return JSON.parse(ctrlFixed);
    } catch {
      // fall through to salvage
    }
  }
  return undefined;
}

// State machine that converts single-quoted strings to double-quoted ones.
// Apostrophes inside double-quoted strings are data and are copied verbatim;
// control characters inside single-quoted regions become JSON escapes.
// Returns undefined when nothing was converted (input unchanged).
// Ported from billion-context compress-tool.ts (#603/#610): pure text repair —
// it never invents structure, so anything it cannot make into valid JSON
// simply stays unrecovered.
function normalizeSingleQuotes(raw: string): string | undefined {
  if (!raw.includes("'") || (!raw.includes("{") && !raw.includes("[")))
    return undefined;
  let out = "";
  let changed = false;
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (inDouble) {
      out += ch;
      if (ch === "\\" && i + 1 < raw.length) {
        out += raw.charAt(i + 1);
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "\\" && i + 1 < raw.length) {
        const next = raw.charAt(i + 1);
        out += next === "'" ? "'" : "\\" + next;
        i++;
        continue;
      }
      if (ch === "'") {
        out += '"';
        inSingle = false;
        changed = true;
        continue;
      }
      if (ch === '"') {
        out += '\\"';
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += '"';
      changed = true;
      continue;
    }
    out += ch;
  }
  return changed ? out : undefined;
}

function stripFence(s: string): string {
  if (!s.startsWith("```")) return s;
  const firstNewline = s.indexOf("\n");
  if (firstNewline === -1) return s;
  const bodyStart = firstNewline + 1;
  const end = s.lastIndexOf("```");
  return end > bodyStart
    ? s.slice(bodyStart, end).trim()
    : s.slice(bodyStart).trim();
}

// Drop commas that sit immediately before a closing brace/bracket
// (outside string literals).
function stripTrailingCommas(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (
        j < s.length &&
        (s.charAt(j) === " " ||
          s.charAt(j) === "\t" ||
          s.charAt(j) === "\n" ||
          s.charAt(j) === "\r")
      )
        j++;
      if (j < s.length && (s.charAt(j) === "}" || s.charAt(j) === "]"))
        continue;
    }
    out += ch;
  }
  return out;
}

// Raw \n, \r, \t inside string literals are invalid JSON; escape them.
// Outside strings they are legal whitespace and left alone.
function escapeRawNewlinesInStrings(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") {
      out += "\\r";
      continue;
    }
    if (ch === "\t") {
      out += "\\t";
      continue;
    }
    if (ch === '"') inString = false;
    out += ch;
  }
  return out;
}

// Repair control characters and invalid escapes exactly where JSON.parse
// reports them. Each iteration fixes the single offending char at the
// parser's stated position — \n/\r/\t/\u00XX for control chars (position =
// the char), doubling the backslash for bad escapes like \` (position = the
// char AFTER the backslash, so the value keeps it literally) — and retries;
// stops when the parse passes or the error is neither class. Uses the
// parser's own view of string state, so unescaped inner quotes and markdown
// backslashes — which defeat the hand-rolled state machines — cannot mislead
// it. Compound damage (raw newlines AND \` escapes in one string) needs
// several rounds; the cap bounds pathological loops.
function repairAtParserPositions(s: string): string {
  let cur = s;
  for (let i = 0; i < 500; i++) {
    let err: unknown;
    try {
      JSON.parse(cur);
      return cur;
    } catch (e) {
      err = e;
    }
    const msg = err instanceof Error ? err.message : String(err);
    const posMatch = /position (\d+)/.exec(msg);
    if (posMatch === null) return cur;
    const pos = Number(posMatch[1]);
    if (!Number.isInteger(pos) || pos < 0 || pos >= cur.length) return cur;
    if (/control character/i.test(msg)) {
      const ch = cur.charAt(pos);
      let esc: string | undefined;
      if (ch === "\n") esc = "\\n";
      else if (ch === "\r") esc = "\\r";
      else if (ch === "\t") esc = "\\t";
      else if (ch.charCodeAt(0) < 32)
        esc = "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
      if (esc === undefined) return cur;
      cur = cur.slice(0, pos) + esc + cur.slice(pos + 1);
    } else if (/Bad escaped character/i.test(msg)) {
      const b =
        cur.charAt(pos - 1) === "\\"
          ? pos - 1
          : cur.charAt(pos) === "\\"
            ? pos
            : -1;
      if (b < 0) return cur;
      cur = cur.slice(0, b) + "\\\\" + cur.slice(b + 1);
    } else {
      return cur;
    }
  }
  return cur;
}

// Unbalanced brackets or an unterminated string at end of input is the
// signature of a mid-stream cutoff (as opposed to balanced garbage).
function looksTruncated(s: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return depth > 0 || inString;
}

/**
 * Recover the complete entries of the `content` array from a truncated JSON
 * prefix. Walks the prefix with a small state machine (string / escape /
 * bracket depth); every object that opens and closes at depth 1 is
 * re-parsed leniently and kept only if it still parses. Partial entries are
 * dropped — the parser never invents model content.
 */
function salvageContentEntries(raw: string): unknown[] {
  const match = /"content"\s*:\s*\[/.exec(raw);
  if (match === null) return [];
  const arrayStart = match.index + match[0].length - 1;
  const entries: unknown[] = [];
  let depth = 0; // brackets nested inside the content array
  let inString = false;
  let escaped = false;
  let entryStart = -1;
  for (let i = arrayStart + 1; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0 && ch === "{" && entryStart === -1) entryStart = i;
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth < 0) break; // the content array itself closed
      if (depth === 0 && entryStart !== -1) {
        const entrySlice = raw.slice(entryStart, i + 1);
        entryStart = -1;
        const parsed = tryParseLenient(entrySlice);
        if (parsed !== undefined) entries.push(parsed);
      }
    }
  }
  return entries;
}
