/**
 * Deterministic Anchor Sidecar — pure lower-triangular kernel module.
 *
 * Complements model-authored prose summaries with a compact, bounded,
 * mechanically-extracted ANCHORS section recording exact file paths (with line
 * numbers), failure/error signatures, and durable identifiers (PR/issue refs,
 * commit SHAs, semver tags) from folded messages — and carries them forward
 * across T2/T3 distillation and refolds without relying on model obedience.
 *
 * Design invariants:
 * - Zero LLM calls, pure O(N) single-pass extraction, strictly bounded by
 *   maxAnchors (default 16) and maxSectionChars (default 1200).
 * - Opt-in (`config.anchorSidecar?.enabled === true`): off = byte-identical
 *   block summaries for all existing callers and golden tests.
 * - Orthogonal to `#5620` MEDIA REFS: distinct marker + blank-line boundary so
 *   both parsers/appenders compose commutatively without bleeding or duplication.
 * - Fail-closed secret hygiene: never emits tokens, auth headers, private keys,
 *   pre-signed URLs, or high-entropy base64 blobs.
 */
import type {
  AnchorSidecarConfig,
  CompressionBlock,
  CoreMessage,
} from "./types.js";

export type AnchorKind = "path" | "error" | "id";

export interface DeterministicAnchor {
  readonly kind: AnchorKind;
  readonly value: string;
}

export const DEFAULT_ANCHOR_SIDECAR_MAX_ANCHORS = 16;
export const DEFAULT_ANCHOR_SIDECAR_MAX_CHARS = 1200;

/** Deterministic header of the mechanically-appended anchor section. Exact
 *  line match is the parse boundary — idempotent across append/strip/parse. */
export const ANCHOR_SIDECAR_MARKER =
  "ANCHORS (deterministic verbatim index — preserve when distilling):";

const SECRET_RE =
  /(?:sk-[A-Za-z0-9_-]{12,}|gh[pou]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|-----BEGIN\s+[A-Z ]*PRIVATE KEY|(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*\S+)/i;

const HIGH_ENTROPY_B64_RE = /[A-Za-z0-9+/=_-]{48,}/;

const SKIP_PATH_RE =
  /^(?:https?:|data:|file:|mailto:|node_modules\/|\/tmp\/|\/proc\/|\/dev\/|\/sys\/)/i;

const FILE_PATH_RE =
  /(?<![A-Za-z0-9_.:/@-])(\/?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?)?)/g;

const TOOL_PATH_FIELD_RE =
  /"(?:file_path|filePath|path|notebook_path|target_file)"\s*:\s*"([^"\n]{2,240})"/g;

const ERROR_LINE_RE =
  /\b(?:AssertionError|TypeError|SyntaxError|ReferenceError|RangeError|EvalError|URIError|PipelineError|BoundaryNotFoundError|ERR_[A-Z0-9_]{3,}|HTTP\s+[45]\d\d\b|ENOENT\b|EACCES\b|EPERM\b|ECONNREFUSED\b|ETIMEDOUT\b|exit(?:\s+code)?\s+[1-9]\d*\b|FAILED\b|FATAL\b)/;

const BENIGN_SUMMARY_LINE_RE =
  /^\s*(?:ℹ\s+)?(?:fail\s+0|0\s+fail(?:ed|ing)?|errors?\s*[:=]\s*0)\b/i;

const PR_ISSUE_RE = /(?<![A-Za-z0-9_/-])#(\d{2,6})\b/g;
const COMMIT_SHA_RE =
  /(?:\bcommit\s+|@)([0-9a-f]{7,12})(?![0-9a-f])/gi;
const SEMVER_RE = /\bv(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\b/g;

function sanitizeValue(raw: string, maxLen: number): string {
  // Strip lone UTF-16 surrogates + control chars and collapse whitespace.
  let clean = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < raw.length ? raw.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        clean += raw[i]! + raw[i + 1]!;
        i++;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    if (code < 0x20 && code !== 0x09) {
      clean += " ";
      continue;
    }
    clean += raw[i]!;
  }
  clean = clean.replace(/\s+/g, " ").trim();
  if (clean.length > maxLen) clean = clean.slice(0, maxLen - 1).trimEnd() + "…";
  return clean;
}

function isUnsafeAnchor(s: string): boolean {
  if (!s) return true;
  if (SECRET_RE.test(s)) return true;
  if (HIGH_ENTROPY_B64_RE.test(s)) return true;
  if (/https?:\/\/\S+\?\S*(?:sig|token|auth|expires|x-amz|x-goog)/i.test(s)) {
    return true;
  }
  return false;
}

function looksLikePath(raw: string): boolean {
  if (!raw || raw.length < 3 || raw.length > 220) return false;
  if (SKIP_PATH_RE.test(raw)) return false;
  if (raw.includes("..")) return false;
  if (/^\d+\.\d+\.\d+/.test(raw)) return false; // IP/version
  if (!raw.includes("/")) return false;
  return true;
}

/** Extract deterministic anchors from a single CoreMessage.
 *  Pure, O(|text|), bounded scan cap (first 32KB per message) so giant logs
 *  cannot stall applyCompression. */
export function extractMessageAnchors(
  message: CoreMessage,
): DeterministicAnchor[] {
  const raw = typeof message.text === "string" ? message.text : "";
  if (raw.length === 0) return [];
  // Skip synthetic summary blocks — their anchors come via parseAnchorSidecarSection.
  if (raw.startsWith("[Compressed conversation section]")) return [];
  const text = raw.length > 32_768 ? raw.slice(0, 32_768) : raw;

  const out: DeterministicAnchor[] = [];
  const seen = new Set<string>();
  const push = (kind: AnchorKind, value: string, maxLen = 140): void => {
    const clean = sanitizeValue(value, maxLen);
    if (!clean || isUnsafeAnchor(clean)) return;
    const key = `${kind}:${clean}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value: clean });
  };

  // 1. High-signal paths from structured tool inputs (Read/Edit/Write/etc.)
  if (message.contentType === "tool-call") {
    for (const m of text.matchAll(TOOL_PATH_FIELD_RE)) {
      const p = m[1]!;
      if (looksLikePath(p)) push("path", p, 160);
    }
  }

  // 2. Explicit repo/filesystem paths with extension (and optional :line[-line])
  for (const m of text.matchAll(FILE_PATH_RE)) {
    const p = m[1]!;
    if (looksLikePath(p)) push("path", p, 160);
  }

  // 3. Failure / error lines (bounded to first 4 distinct lines per message)
  let errCount = 0;
  for (const line of text.split("\n")) {
    if (errCount >= 4) break;
    const trimmed = line.trim();
    if (trimmed.length < 8) continue;
    if (BENIGN_SUMMARY_LINE_RE.test(trimmed)) continue;
    const match = ERROR_LINE_RE.exec(trimmed);
    if (match) {
      const candidate = trimmed.length <= 400 ? trimmed : match[0].trim();
      push("error", candidate, 120);
      errCount++;
    }
  }

  // 4. Exact identifiers: PR/issue numbers, explicit git commit SHAs, semver
  for (const m of text.matchAll(PR_ISSUE_RE)) {
    push("id", `#${m[1]!}`, 24);
  }
  for (const m of text.matchAll(COMMIT_SHA_RE)) {
    push("id", m[1]!.toLowerCase(), 24);
  }
  for (const m of text.matchAll(SEMVER_RE)) {
    push("id", `v${m[1]!}`, 40);
  }

  return out;
}

function normalizeAnchorCap(cfg?: AnchorSidecarConfig): {
  maxAnchors: number;
  maxSectionChars: number;
} {
  const maxAnchors =
    typeof cfg?.maxAnchors === "number" &&
    Number.isInteger(cfg.maxAnchors) &&
    cfg.maxAnchors >= 1
      ? cfg.maxAnchors
      : DEFAULT_ANCHOR_SIDECAR_MAX_ANCHORS;
  const maxSectionChars =
    typeof cfg?.maxSectionChars === "number" &&
    Number.isInteger(cfg.maxSectionChars) &&
    cfg.maxSectionChars >= 120
      ? cfg.maxSectionChars
      : DEFAULT_ANCHOR_SIDECAR_MAX_CHARS;
  return { maxAnchors, maxSectionChars };
}

function stripAnchorSidecarSection(summary: string): string {
  const lines = summary.split("\n");
  const idx = lines.findIndex((l) => l.trim() === ANCHOR_SIDECAR_MARKER);
  if (idx === -1) return summary;
  let end = idx + 1;
  while (end < lines.length && lines[end]!.startsWith("- ")) end++;
  lines.splice(idx, end - idx);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Parse a mechanically-appended ANCHORS section back into typed anchors.
 *  Returns empty array when absent. */
export function parseAnchorSidecarSection(
  summary: string,
): DeterministicAnchor[] {
  const lines = summary.split("\n");
  const idx = lines.findIndex((l) => l.trim() === ANCHOR_SIDECAR_MARKER);
  if (idx === -1) return [];
  const out: DeterministicAnchor[] = [];
  const seen = new Set<string>();
  for (let i = idx + 1; i < lines.length && lines[i]!.startsWith("- "); i++) {
    const body = lines[i]!.slice(2).trim();
    const match = /^(path|error|id):\s*(.+)$/.exec(body);
    if (!match) continue;
    const kind = match[1] as AnchorKind;
    const value = sanitizeValue(match[2]!, kind === "path" ? 160 : 120);
    if (!value || isUnsafeAnchor(value)) continue;
    const key = `${kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, value });
  }
  return out;
}

/** Collect deterministic anchors for a fold: extracted from newly-folded
 *  direct messages + carried forward from consumed blocks (so T2/T3
 *  distillation never drops anchors). Deterministic priority order:
 *  errors → paths → ids, bounded by maxAnchors. */
export function collectFoldAnchors(
  directMessages: readonly (CoreMessage | undefined)[],
  consumedBlocks: readonly (CompressionBlock | undefined)[],
  cfg?: AnchorSidecarConfig,
): DeterministicAnchor[] {
  const { maxAnchors } = normalizeAnchorCap(cfg);
  const buckets: Record<AnchorKind, string[]> = {
    error: [],
    path: [],
    id: [],
  };
  const seen = new Set<string>();
  const add = (a: DeterministicAnchor): void => {
    const key = `${a.kind}:${a.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    buckets[a.kind].push(a.value);
  };

  for (const m of directMessages) {
    if (m) for (const a of extractMessageAnchors(m)) add(a);
  }
  for (const b of consumedBlocks) {
    if (b) for (const a of parseAnchorSidecarSection(b.summary)) add(a);
  }

  // Balanced priority allocation: reserve room for errors & paths first so a
  // flood of #issue ids never crowds out file paths or failure signatures.
  const maxErrors = Math.max(2, Math.floor(maxAnchors * 0.35));
  const maxPaths = Math.max(4, Math.floor(maxAnchors * 0.45));
  const selected: DeterministicAnchor[] = [];
  for (const v of buckets.error.slice(0, maxErrors)) {
    selected.push({ kind: "error", value: v });
  }
  for (const v of buckets.path.slice(0, maxPaths)) {
    selected.push({ kind: "path", value: v });
  }
  const remaining = Math.max(0, maxAnchors - selected.length);
  for (const v of buckets.id.slice(0, remaining)) {
    selected.push({ kind: "id", value: v });
  }
  // If id bucket was smaller than remaining, top up with extra paths then errors.
  for (const v of buckets.path.slice(maxPaths)) {
    if (selected.length >= maxAnchors) break;
    selected.push({ kind: "path", value: v });
  }
  for (const v of buckets.error.slice(maxErrors)) {
    if (selected.length >= maxAnchors) break;
    selected.push({ kind: "error", value: v });
  }
  return selected.slice(0, maxAnchors);
}

/** Append the canonical ANCHORS section idempotently (replacing any prior
 *  ANCHORS section so repeated calls never duplicate). Bounded by
 *  maxSectionChars. Returns input unchanged when anchors is empty. */
export function appendAnchorSidecarSection(
  summary: string,
  anchors: readonly DeterministicAnchor[],
  cfg?: AnchorSidecarConfig,
): string {
  if (anchors.length === 0) return summary;
  const { maxAnchors, maxSectionChars } = normalizeAnchorCap(cfg);
  const lines: string[] = [ANCHOR_SIDECAR_MARKER];
  let usedChars = ANCHOR_SIDECAR_MARKER.length;
  for (const a of anchors.slice(0, maxAnchors)) {
    const line = `- ${a.kind}: ${a.value}`;
    if (usedChars + 1 + line.length > maxSectionChars) break;
    lines.push(line);
    usedChars += 1 + line.length;
  }
  if (lines.length === 1) return summary;
  const base = stripAnchorSidecarSection(summary).replace(/\n+$/, "");
  const section = lines.join("\n");
  return base ? `${base}\n\n${section}` : section;
}
