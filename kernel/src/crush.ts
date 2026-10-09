/**
 * Tool-result valuator + deterministic compression ("crush") channel (#354):
 * the two-tier absorb gate owned by the kernel. Tier 1: mechanical size
 * reduction of eligible oversized tool results via registered crush plugins;
 * tier 2: model distillation (the existing `[ACP absorb]` prompt path) only
 * when a result is still over threshold after crushing. Pure function of
 * (payload, config) — identical bytes on every turn a result is re-sent
 * (prefix-cache stable); view-only like the absorb prompt, no kernel state
 * is mutated.
 *
 * Plugin contract (CrushPluginDef.run): pure & deterministic, input never
 * mutated, fail-open on any anomaly, sub-minimum-size inputs untouched. The
 * kernel enforces what plugins must not each own: dispatch guards (JSON /
 * source / log payloads never reach a strategy for another kind), the
 * minReduction floor, and — for lossy log output — that every ERROR/FAIL line
 * of the input survives in the output verbatim, else the result is rejected
 * and the payload passes through unchanged.
 *
 * Default strategies (dispatched by content sniffing):
 *  - json-fold: field-variance folding (concept adapted from headroom
 *    SmartCrusher, headroomlabs-ai/headroom, Apache-2.0; implementation
 *    original TS). LOSSLESS BY CONSTRUCTION. Annotation vocabulary (reserved
 *    key `__acp_crush`):
 *      {"__acp_crush":"rows","rows":N,"const":{k:v,...},"items":[...]}
 *        array of N rows; every row = `const` merged with its `items` entry
 *        (same order); `items` omitted iff no row has a non-constant field.
 *      {"__acp_crush":"identical-run","count":N,"item":X}
 *        N consecutive identical elements X.
 *    Payloads legitimately containing a `__acp_crush` key cannot be told apart
 *    from crushed output — disable crush for them.
 *  - code-trim: structural trimmer (Python, JavaScript/TypeScript; sound for
 *    other // -comment languages). LOSSY: full-line comments, docstrings and
 *    blank-line runs are elided into one marker line (`# [acp-crush: elided N
 *    lines]` / `// [acp-crush: elided N lines]`) and NOT retained. Code lines,
 *    string literals and trailing comments stay byte-exact. A stronger AST
 *    implementation can register under kinds ["code"] to replace it.
 *  - log-select: build/test log condenser (ported from headroom LogCompressor,
 *    Apache-2.0): classifies every line (level / summary / stack-trace
 *    membership), keeps errors+fails first (within a keep budget; the kernel
 *    invariant above rejects any lossy result that drops an error line),
 *    deduped warnings, bounded stack traces (runtime frames collapsed to a
 *    marker), summary lines and ±3 context, caps the rest by score. LOSSY:
 *    noise lines are dropped, not retained. Upstream deviations: no CCR store
 *    — the omission footer carries honest counts instead of a retrieve hash;
 *    the keep budget is the fixed 100-line cap instead of headroom's adaptive
 *    Kneedle sizing (the cap only bounds output; the absorb gate and model
 *    compression already bound cost downstream). Only attempted when the
 *    payload is neither JSON-shaped nor confidently detected source code.
 *
 * Fail-open: parse errors, scanner bails (unterminated string/comment/
 * template), low-confidence language detection, plugin exceptions, or
 * reduction below the configured minimum leave the payload byte-identical.
 * Query-aware relevance selection (headroom layer b) is deliberately not
 * ported: hosts re-send tool results every turn, so the crush must stay
 * query-independent or provider prefix caches churn.
 */

import {
  ABSORB_PROMPT_MARKER,
  isAbsorbCandidate,
  resolveAbsorbConfig,
} from "./absorb.js";
import { collectProtectedToolCallIds, matchToolPattern } from "./protected.js";
import { defaultCountTokens, type TokenCountFn } from "./tokenize.js";
import type {
  Config,
  CoreMessage,
  CrushConfig,
  ResolvedAbsorbConfig,
} from "./types.js";

export const DEFAULT_CRUSH_CONFIG: CrushConfig = {
  enabled: false,
  minReduction: 0.1,
};

export type CrushKind = "json" | "code" | "log";

/** Caller context handed to every plugin run (tool identity etc.). */
export interface CrushMeta {
  toolName?: string;
}

export interface CrushOutput {
  text: string;
  strategy: string;
  lossy: boolean;
  stats?: Record<string, unknown>;
}

/** Narrow synchronous compression contract. `null` = pass-through. */
export interface CrushPluginDef {
  readonly id: string;
  /** Content kinds this plugin may be dispatched on; the kernel refuses others. */
  readonly kinds: readonly CrushKind[];
  run(text: string, meta: CrushMeta): Omit<CrushOutput, "strategy"> | null;
}

export interface CrushOptions {
  minReduction?: number;
  countTokens?: TokenCountFn;
  meta?: CrushMeta;
  /** Plugins to try, in order. Default: all registered, registry order. */
  plugins?: readonly CrushPluginDef[];
}

export type CrushDecisionKind = "skip" | "crushed" | "distill";

/** Valuator decision for one tool-result payload. */
export interface CrushEvaluation {
  kind: CrushDecisionKind;
  /** Final text: original for skip, crushed otherwise. */
  text: string;
  rawTokens: number;
  newTokens?: number;
  reduction?: number;
  strategy?: string;
  lossy?: boolean;
}

const MAX_INPUT_CHARS = 2_000_000;
const MAX_DEPTH = 12;
const MAX_FOLDS = 1000;
const RUN_MIN = 4;
const HOIST_MIN = 4;
const CODE_KEEP_RATIO = 0.97;

const CRUSH_KEY = "__acp_crush";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === null || p === Object.prototype;
}

export function classifyCrushText(text: string): CrushKind {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  )
    return "json";
  if (detectLanguage(text) !== null) return "code";
  return "log";
}

/** Single-call entry shared by the arrival path (processTurn crush node) and
 *  the future retrieve path (#1097): classify, dispatch in order to the first
 *  kind-matched plugin that produces an accepted result. `null` = pass-through. */
export function crushText(
  text: string,
  options: CrushOptions = {},
): CrushOutput | null {
  const countTokens = options.countTokens ?? defaultCountTokens;
  const minReduction =
    options.minReduction ?? DEFAULT_CRUSH_CONFIG.minReduction;
  const meta = options.meta ?? {};
  if (text.length === 0 || text.length > MAX_INPUT_CHARS) return null;
  const rawTok = countTokens(text);
  if (rawTok <= 0) return null;
  const kind = classifyCrushText(text);
  const wanted = options.plugins ?? registeredPlugins();
  for (const plugin of wanted) {
    let res: Omit<CrushOutput, "strategy"> | null;
    try {
      // Contract-violating host plugins (missing/malformed kinds, non-string
      // result text) must fail open like any other anomaly, not throw out of
      // the pipeline or poison msg.text with a non-string.
      if (!Array.isArray(plugin.kinds) || !plugin.kinds.includes(kind))
        continue;
      res = plugin.run(text, meta);
    } catch {
      continue;
    }
    if (
      !res ||
      typeof res.text !== "string" ||
      res.text === "" ||
      res.text === text
    )
      continue;
    const newTok = countTokens(res.text);
    const reduction = (rawTok - newTok) / rawTok;
    if (reduction < minReduction) continue;
    if (kind === "log" && res.lossy && !errorLinesSurvive(text, res.text))
      continue;
    const out: CrushOutput = {
      text: res.text,
      strategy: plugin.id,
      lossy: res.lossy,
    };
    if (res.stats) out.stats = res.stats;
    return out;
  }
  return null;
}

interface FoldStats {
  folds: number;
}

function canonOf(v: unknown, cache: Map<object, string>): string {
  if (!isPlainObject(v) && !Array.isArray(v))
    return JSON.stringify(v) ?? "null";
  const key = v as object;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let s: string;
  if (Array.isArray(v)) {
    s = `[${v.map((e) => canonOf(e, cache)).join(",")}]`;
  } else {
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${JSON.stringify(k)}:${canonOf(val, cache)}`)
      .sort();
    s = `{${entries.join(",")}}`;
  }
  cache.set(key, s);
  return s;
}

function strLen(v: unknown): number {
  return JSON.stringify(v).length;
}

function compactValue(
  v: unknown,
  depth: number,
  stats: FoldStats,
  cache: Map<object, string>,
): unknown {
  if (depth > MAX_DEPTH || stats.folds >= MAX_FOLDS) return v;
  if (Array.isArray(v)) return compactArray(v, depth, stats, cache);
  if (isPlainObject(v)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const nv = compactValue(val, depth + 1, stats, cache);
      out[k] = nv;
      if (nv !== val) changed = true;
    }
    return changed ? out : v;
  }
  return v;
}

function compactArray(
  arr: unknown[],
  depth: number,
  stats: FoldStats,
  cache: Map<object, string>,
): unknown {
  const n = arr.length;
  if (n < RUN_MIN && n < HOIST_MIN)
    return arr.map((e) => compactValue(e, depth + 1, stats, cache));
  if (stats.folds >= MAX_FOLDS) return arr;

  const plainStats: FoldStats = { folds: 0 };
  const plain = arr.map((e) => compactValue(e, depth + 1, plainStats, cache));
  let winner: unknown = plain;
  let winnerLen = strLen(plain);
  let winnerFolds = plainStats.folds;

  if (n >= RUN_MIN) {
    const rf = buildRunFold(arr, depth, cache);
    if (rf && rf.len < winnerLen) {
      winner = rf.value;
      winnerLen = rf.len;
      winnerFolds = rf.folds;
    }
  }
  if (n >= HOIST_MIN && arr.every((e) => isPlainObject(e))) {
    const hc = buildConstHoist(arr, depth, cache);
    if (hc && hc.len < winnerLen) {
      winner = hc.value;
      winnerLen = hc.len;
      winnerFolds = hc.folds;
    }
  }
  stats.folds += winnerFolds;
  return winner;
}

interface FoldCandidate {
  value: unknown;
  len: number;
  folds: number;
}

function isRunMarker(
  v: unknown,
): v is { [CRUSH_KEY]: "identical-run"; count: number; item: unknown } {
  return (
    isPlainObject(v) &&
    (v as Record<string, unknown>)[CRUSH_KEY] === "identical-run"
  );
}

function buildRunFold(
  arr: unknown[],
  depth: number,
  cache: Map<object, string>,
): FoldCandidate | null {
  const n = arr.length;
  const canon = arr.map((e) => canonOf(e, cache));
  const segs: unknown[] = [];
  let runs = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && canon[j + 1] === canon[i]) j++;
    const runLen = j - i + 1;
    if (runLen >= RUN_MIN) {
      segs.push({ [CRUSH_KEY]: "identical-run", count: runLen, item: arr[i] });
      runs++;
    } else {
      for (let k = i; k <= j; k++) segs.push(arr[k]);
    }
    i = j + 1;
  }
  if (runs === 0) return null;
  const inner: FoldStats = { folds: 0 };
  const final = segs.map((s) =>
    isRunMarker(s)
      ? { ...s, item: compactValue(s.item, depth + 1, inner, cache) }
      : compactValue(s, depth + 1, inner, cache),
  );
  return { value: final, len: strLen(final), folds: runs + inner.folds };
}

function buildConstHoist(
  arr: Record<string, unknown>[],
  depth: number,
  cache: Map<object, string>,
): FoldCandidate | null {
  const n = arr.length;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const e of arr) {
    for (const k of Object.keys(e)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const first = arr[0];
  if (!first) return null;
  const constKeys: string[] = [];
  for (const k of keys) {
    // A key absent from row 0 must not be hoisted: canonOf(undefined) ===
    // canonOf(null), so "absent in row 0, null elsewhere" would pass the
    // const check, then JSON.stringify drops the undefined constObj value and
    // the field vanishes from every decoded row (losslessness violation).
    if (!(k in first)) continue;
    const c0 = canonOf(first[k], cache);
    let constant = true;
    for (let i = 1; i < n; i++) {
      const row = arr[i]!;
      if (!(k in row) || canonOf(row[k], cache) !== c0) {
        constant = false;
        break;
      }
    }
    if (constant) constKeys.push(k);
  }
  if (constKeys.length === 0) return null;
  const constSet = new Set(constKeys);
  const constObj: Record<string, unknown> = {};
  for (const k of constKeys) constObj[k] = first[k];
  const items = arr.map((e) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) {
      if (!constSet.has(k)) o[k] = v;
    }
    return o;
  });
  const hasVarying = items.some((o) => Object.keys(o).length > 0);
  const inner: FoldStats = { folds: 0 };
  const env: Record<string, unknown> = {
    [CRUSH_KEY]: "rows",
    rows: n,
    const: compactValue(constObj, depth + 1, inner, cache),
  };
  if (hasVarying)
    env.items = items.map((it) => compactValue(it, depth + 1, inner, cache));
  const len = strLen(env);
  if (len >= strLen(arr)) return null;
  return { value: env, len, folds: 1 + inner.folds };
}

export function crushJson(text: string): string | null {
  const parsed: unknown = JSON.parse(text);
  const cache = new Map<object, string>();
  const stats: FoldStats = { folds: 0 };
  const out = compactValue(parsed, 0, stats, cache);
  if (stats.folds === 0) return null;
  const s = JSON.stringify(out);
  return s.length < text.length ? s : null;
}

type Lang = "python" | "js";

function detectLanguage(text: string): Lang | null {
  const sample = text.split(/\r?\n/).slice(0, 300);
  let py = 0;
  let js = 0;
  for (const line of sample) {
    if (/^\s*#!.*python/.test(line)) py += 4;
    if (/^\s*(async\s+)?def\s+\w/.test(line) || /^\s*class\s+\w/.test(line))
      py += 2;
    if (/\bfrom\s+['"]/.test(line) || /^\s*import\s+['"]/.test(line)) js += 2;
    else if (/^\s*(import|from)\s+[A-Za-z_]\w*/.test(line)) py += 1;
    if (/^\s*(function\b|const\s|let\s|var\s)/.test(line)) js += 2;
    if (/=>/.test(line)) js += 1;
    if (/^\s*(public|private|protected|static|final|void|return)\b/.test(line))
      js += 1;
    if (/;\s*$/.test(line) && line.trim().length > 0) js += 1;
    if (/\bself\./.test(line) || /^\s*(elif|except|yield)\b/.test(line))
      py += 1;
    if (/\bconsole\.log\b|\brequire\s*\(|module\.exports|\bawait\s/.test(line))
      js += 1;
  }
  const MARGIN = 1.5;
  if (py >= 3 && py > js * MARGIN) return "python";
  if (js >= 4 && js > py * MARGIN) return "js";
  return null;
}

function finalizeTrimmed(original: string, emitted: string[]): string | null {
  if (emitted.length >= original.split(/\r?\n/).length) return null;
  const out = emitted.join("\n") + (original.endsWith("\n") ? "\n" : "");
  return out.length < original.length * CODE_KEEP_RATIO ? out : null;
}

function trimPython(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const emitted: string[] = [];
  let pending = 0;
  const flush = () => {
    if (pending > 0) {
      emitted.push(
        `# [acp-crush: elided ${pending} line${pending === 1 ? "" : "s"}]`,
      );
      pending = 0;
    }
  };
  let state: "code" | "triple" = "code";
  let quote = "";
  let isDocstring = false;
  let blankRun = 0;
  let atModuleStart = true;
  let pendingDefClass = false;
  let docstringSlot = false;

  const classifySig = (codePart: string) => {
    const t = codePart.trim();
    if (/^(async\s+)?(def|class)\b/.test(t)) pendingDefClass = true;
    if (t.endsWith(":")) {
      docstringSlot = pendingDefClass;
      pendingDefClass = false;
    } else if (t.length > 0 && !t.startsWith("@")) {
      docstringSlot = false;
    }
    atModuleStart = false;
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (state === "triple") {
      const close = findTripleClose(line, quote);
      if (close === -1) {
        if (isDocstring) pending++;
        else emitted.push(line);
        continue;
      }
      state = "code";
      const rest = line.slice(close + 3).trim();
      if (rest.length > 0) {
        flush();
        emitted.push(line);
        classifySig(rest);
      } else {
        if (isDocstring) pending++;
        else emitted.push(line);
      }
      isDocstring = false;
      docstringSlot = false;
      pendingDefClass = false;
      atModuleStart = false;
      blankRun = 0;
      continue;
    }
    if (line.trim().length === 0) {
      blankRun++;
      if (blankRun >= 3) {
        flush();
        emitted.push("");
        blankRun = 1;
      }
      continue;
    }
    if (li === 0 && line.startsWith("#!")) {
      flush();
      emitted.push(line);
      blankRun = 0;
      continue;
    }
    const m = line.match(/^\s*("""|''')/);
    if (m) {
      flush();
      // m.index points at the leading whitespace (\s* in the regex) —
      // the triple itself starts further right; slicing from m.index
      // would make closeOnSameLine find the opening triple itself.
      const q = m[1]!;
      const opensHere = line.indexOf(q);
      const closeOnSameLine = findTripleClose(line.slice(opensHere + 3), q);
      if (closeOnSameLine !== -1) {
        const restAfter = line
          .slice(opensHere + 3 + closeOnSameLine + 3)
          .trim();
        if (restAfter.length > 0) {
          emitted.push(line);
          classifySig(restAfter);
        } else if (atModuleStart || docstringSlot) {
          pending++;
          atModuleStart = false;
          docstringSlot = false;
          pendingDefClass = false;
        } else {
          emitted.push(line);
        }
        blankRun = 0;
        continue;
      }
      state = "triple";
      quote = q;
      isDocstring = atModuleStart || docstringSlot;
      atModuleStart = false;
      docstringSlot = false;
      if (!isDocstring) emitted.push(line);
      blankRun = 0;
      continue;
    }
    const probe = findCommentOrTriple(line);
    if (probe.kind === "comment-full") {
      pending++;
      continue;
    }
    if (probe.kind === "triple-mid") {
      flush();
      state = "triple";
      quote = probe.quote;
      isDocstring = false;
      emitted.push(line);
      classifySig(line.slice(0, probe.idx));
      blankRun = 0;
      continue;
    }
    flush();
    emitted.push(line);
    classifySig(line);
    blankRun = 0;
  }
  if (state === "triple") return null;
  flush();
  return finalizeTrimmed(text, emitted);
}

function findTripleClose(line: string, quote: string): number {
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line.startsWith(quote, i)) return i;
    i++;
  }
  return -1;
}

function findCommentOrTriple(line: string): {
  kind: "none" | "comment-full" | "triple-mid";
  idx: number;
  quote: string;
} {
  let i = 0;
  let inStr: string | null = null;
  while (i < line.length) {
    const c = line[i];
    if (inStr) {
      if (c === "\\") i += 2;
      else if (c === inStr) inStr = null;
      else i++;
      continue;
    }
    if (c === "'" || c === '"') {
      inStr = c;
      i++;
      continue;
    }
    if (c === "#") {
      return {
        kind: line.slice(0, i).trim().length === 0 ? "comment-full" : "none",
        idx: i,
        quote: "",
      };
    }
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      return { kind: "triple-mid", idx: i, quote: line.slice(i, i + 3) };
    }
    i++;
  }
  return { kind: "none", idx: -1, quote: "" };
}

interface TmplState {
  mode: "tpl" | "expr" | "str";
  quote: string;
  depth: number;
}

function scanTemplateRest(
  line: string,
  from: number,
  st: TmplState,
): TmplState & { closed: boolean; bail: boolean; consumed: number } {
  let m = st.mode;
  let q = st.quote;
  let d = st.depth;
  let i = from;
  while (i < line.length) {
    const c = line[i];
    if (m === "str") {
      if (c === "\\") i += 2;
      else if (c === q) m = "expr";
      else i++;
      continue;
    }
    if (m === "expr") {
      if (c === "'" || c === '"') {
        q = c;
        m = "str";
        i++;
        continue;
      }
      if (c === "`")
        return {
          mode: m,
          quote: q,
          depth: d,
          closed: false,
          bail: true,
          consumed: 0,
        };
      if (c === "{") d++;
      else if (c === "}") {
        d--;
        if (d === 0) m = "tpl";
      }
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`")
      return {
        mode: "tpl",
        quote: "",
        depth: 0,
        closed: true,
        bail: false,
        consumed: i - from + 1,
      };
    if (c === "$" && line[i + 1] === "{") {
      m = "expr";
      d = 1;
      i += 2;
      continue;
    }
    i++;
  }
  return {
    mode: m,
    quote: q,
    depth: d,
    closed: false,
    bail: false,
    consumed: 0,
  };
}

type JsLineKind =
  | "code"
  | "comment-full"
  | "block-open-only"
  | "block-open-mid"
  | "template-open";

// A `/` can start a regex literal only where an expression is expected. If the
// previous significant char ends a token (identifier char, `.`, quote, `)`,
// `]`), the `/` is division — parsing a regex there would misread ordinary
// arithmetic, so the attempt is skipped.
function regexAllowedAfter(prev: string | null): boolean {
  if (prev === null) return true;
  if (/[A-Za-z0-9_]/.test(prev)) return false;
  return !".'\"`) ]".includes(prev);
}

function prevSigChar(line: string, i: number): string | null {
  for (let j = i - 1; j >= 0; j--) {
    const c = line[j]!;
    if (c === " " || c === "\t") continue;
    return c;
  }
  return null;
}

// Scan a JS regex literal starting at line[i] === "/". Returns the index just
// past the closing slash and its flags, or null when it does not close on this
// line (regex literals never span lines) — i.e. the `/` was division, not a
// regex. Honors backslash escapes and [..] character classes (a `/` inside a
// class does not close the literal).
function scanRegexLiteral(line: string, i: number): number | null {
  let j = i + 1;
  let inClass = false;
  while (j < line.length) {
    const c = line[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "/") {
      let f = j + 1;
      while (f < line.length && /[a-z]/i.test(line[f]!)) f++;
      return f;
    }
    j++;
  }
  return null;
}

function scanJsCodeLine(line: string): {
  kind: JsLineKind;
  tmpl?: TmplState;
  bail?: boolean;
} {
  let i = 0;
  let inStr: string | null = null;
  while (i < line.length) {
    const c = line[i];
    if (inStr) {
      if (c === "\\") i += 2;
      else if (c === inStr) inStr = null;
      else i++;
      continue;
    }
    if (c === "'" || c === '"') {
      inStr = c;
      i++;
      continue;
    }
    if (c === "`") {
      const r = scanTemplateRest(line, i, { mode: "tpl", quote: "", depth: 0 });
      if (r.bail) return { kind: "code", bail: true };
      if (!r.closed)
        return {
          kind: "template-open",
          tmpl: { mode: r.mode, quote: r.quote, depth: r.depth },
        };
      i += r.consumed;
      continue;
    }
    if (c === "/") {
      const nxt = line[i + 1];
      if (nxt === "/") {
        return {
          kind: line.slice(0, i).trim().length === 0 ? "comment-full" : "code",
        };
      }
      if (nxt !== "*") {
        // A regex pattern may not start with `*` ("Nothing to repeat"), so
        // `/*` is unambiguously a comment open. Any other `/` where an
        // expression is expected may start a regex literal — consume it whole
        // so patterns like /[/*]/ cannot open a fake block comment later.
        if (regexAllowedAfter(prevSigChar(line, i))) {
          const end = scanRegexLiteral(line, i);
          if (end !== null) {
            i = end;
            continue;
          }
        }
        i++;
        continue;
      }
      const close = line.indexOf("*/", i + 2);
      const before = line.slice(0, i).trim().length > 0;
      if (close === -1)
        return { kind: before ? "block-open-mid" : "block-open-only" };
      const rest = line.slice(close + 2).trim();
      if (rest.length === 0) return { kind: before ? "code" : "comment-full" };
      i = close + 2;
      continue;
    }
    i++;
  }
  return { kind: "code" };
}

function trimJsTs(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const emitted: string[] = [];
  let pending = 0;
  const flush = () => {
    if (pending > 0) {
      emitted.push(
        `// [acp-crush: elided ${pending} line${pending === 1 ? "" : "s"}]`,
      );
      pending = 0;
    }
  };
  let state: "code" | "block" | "template" = "code";
  let tmpl: TmplState = { mode: "tpl", quote: "", depth: 0 };
  let blankRun = 0;

  for (const line of lines) {
    if (state === "block") {
      const close = line.indexOf("*/");
      if (close === -1) {
        pending++;
        continue;
      }
      state = "code";
      if (line.slice(close + 2).trim().length === 0) pending++;
      else {
        flush();
        emitted.push(line);
      }
      blankRun = 0;
      continue;
    }
    if (state === "template") {
      const r = scanTemplateRest(line, 0, tmpl);
      if (r.bail) return null;
      tmpl = { mode: r.mode, quote: r.quote, depth: r.depth };
      if (r.closed) state = "code";
      emitted.push(line);
      blankRun = 0;
      continue;
    }
    if (line.trim().length === 0) {
      blankRun++;
      if (blankRun >= 3) {
        flush();
        emitted.push("");
        blankRun = 1;
      }
      continue;
    }
    const scan = scanJsCodeLine(line);
    if (scan.bail) return null;
    if (scan.kind === "comment-full") {
      pending++;
      continue;
    }
    if (scan.kind === "block-open-only") {
      pending++;
      state = "block";
      continue;
    }
    if (scan.kind === "block-open-mid") {
      flush();
      state = "block";
      emitted.push(line);
      blankRun = 0;
      continue;
    }
    if (scan.kind === "template-open") {
      flush();
      state = "template";
      tmpl = scan.tmpl ?? { mode: "tpl", quote: "", depth: 0 };
      emitted.push(line);
      blankRun = 0;
      continue;
    }
    flush();
    emitted.push(line);
    blankRun = 0;
  }
  if (state !== "code") return null;
  flush();
  return finalizeTrimmed(text, emitted);
}

export function crushCode(text: string): string | null {
  const lang = detectLanguage(text);
  if (lang === null) return null;
  if (lang === "python") return trimPython(text);
  return trimJsTs(text);
}

// ── Log strategy (ported from headroom LogCompressor, Apache-2.0) ──────────

const LOG_MIN_LINES = 50;
const LOG_MAX_TOTAL_LINES = 100;
// Keep budget for error/fail lines. The kernel invariant rejects any lossy
// result that drops an error line, so logs with more distinct errors than
// this budget fail open to pass-through rather than losing error content.
const LOG_MAX_ERRORS = 20;
const LOG_ERROR_CONTEXT = 3;
const LOG_MAX_WARNINGS = 5;
const LOG_MAX_STACK_TRACES = 3;
const LOG_STACK_MAX_LINES = 20;
const LOG_TRACE_HEAD_FRAMES = 3;
const LOG_TRACE_APP_FRAMES = 5;
const LOG_CLASSIFIED_GATE = 5;
const LOG_SUMMARY_GATE = 3;

type LogLevelName =
  "error" | "fail" | "warn" | "info" | "debug" | "trace" | "unknown";

interface LogLine {
  i: number;
  content: string;
  level: LogLevelName;
  isStack: boolean;
  isSummary: boolean;
  score: number;
}

// Pattern priority (higher severity wins), not leftmost match: a line
// containing both a warn- and an error-word must classify as error so it is
// kept by the error budget rather than dropped as noise.
const LEVEL_PATTERNS: Array<[LogLevelName, RegExp]> = [
  ["error", /\b(ERROR|FATAL|CRITICAL)\b/i],
  ["fail", /\b(FAIL|FAILED)\b/i],
  ["warn", /\b(WARN|WARNING)\b/i],
  ["info", /\bINFO\b/i],
  ["debug", /\bDEBUG\b/i],
  ["trace", /\bTRACE\b/i],
];

function classifyLevel(line: string): LogLevelName {
  for (const [level, re] of LEVEL_PATTERNS) {
    if (re.test(line)) return level;
  }
  return "unknown";
}

function isLogSummaryLine(line: string): boolean {
  if (line.startsWith("===") || line.startsWith("---")) return true;
  let d = 0;
  while (
    d < line.length &&
    line.charCodeAt(d) >= 48 &&
    line.charCodeAt(d) <= 57
  )
    d++;
  if (d > 0 && line[d] === " ") {
    const rest = line.slice(d + 1);
    if (
      rest.startsWith("passed") ||
      rest.startsWith("failed") ||
      rest.startsWith("skipped") ||
      rest.startsWith("error") ||
      rest.startsWith("warning")
    )
      return true;
  }
  for (const prefix of [
    "Test ",
    "Tests ",
    "Tests:",
    "Test:",
    "Suite ",
    "Suites ",
    "Suites:",
    "Suite:",
  ]) {
    if (line.startsWith(prefix)) {
      const m = line.slice(prefix.length).match(/\S/);
      if (m !== null && m[0].charCodeAt(0) >= 48 && m[0].charCodeAt(0) <= 57)
        return true;
    }
  }
  if (
    line.startsWith("TOTAL") ||
    line.startsWith("Total") ||
    line.startsWith("Summary")
  )
    return true;
  for (const prefix of ["Build", "Compile", "Test"]) {
    if (
      line.startsWith(prefix) &&
      (line.includes("succeeded") ||
        line.includes("failed") ||
        line.includes("complete"))
    )
      return true;
  }
  return false;
}

function isDigitChar(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isAsciiAlnum(c: string): boolean {
  const n = c.charCodeAt(0);
  return (n >= 97 && n <= 122) || (n >= 65 && n <= 90) || (n >= 48 && n <= 57);
}

function hasLineColSuffix(s: string): boolean {
  for (let i = 0; i + 1 < s.length; i++) {
    if (s[i] === ":" && isDigitChar(s[i + 1]!)) {
      let j = i + 1;
      while (j < s.length && isDigitChar(s[j]!)) j++;
      if (j + 1 < s.length && s[j] === ":" && isDigitChar(s[j + 1]!))
        return true;
    }
  }
  return false;
}

type TraceFlavor =
  | "py"
  | "js"
  | "java"
  | "dotnet"
  | "rust-error"
  | "rust-backtrace"
  | "go-panic";

function isPythonFileFrame(s: string): boolean {
  return (
    s.startsWith('File "') &&
    s.includes('", line ') &&
    s.length > 0 &&
    isDigitChar(s[s.length - 1]!)
  );
}

function isJsAtFrame(s: string): boolean {
  return (
    s.startsWith("at ") &&
    s.includes("(") &&
    s.includes(")") &&
    hasLineColSuffix(s)
  );
}

function isJavaAtFrame(s: string): boolean {
  if (!s.startsWith("at ") || !s.includes("(")) return false;
  const open = s.indexOf("(");
  const body = s.slice(3, open);
  if (body.length === 0) return false;
  for (const c of body) {
    if (!(isAsciiAlnum(c) || c === "." || c === "_" || c === "$" || c === "/"))
      return false;
  }
  return true;
}

function isRustPanicOpener(s: string): boolean {
  return s.startsWith("thread '") && s.includes("panicked at");
}

function isGoroutineHeader(line: string): boolean {
  if (!line.startsWith("goroutine ")) return false;
  const rest = line.slice(10);
  let d = 0;
  while (d < rest.length && isDigitChar(rest[d]!)) d++;
  return d > 0 && rest.slice(d).startsWith(" [");
}

function isGoPanicOpener(line: string): boolean {
  return (
    line.startsWith("panic: ") ||
    line.startsWith("fatal error: ") ||
    isGoroutineHeader(line)
  );
}

function isGoFileFrame(line: string): boolean {
  return (
    line.startsWith("\t") && line.includes(".go:") && line.includes(" +0x")
  );
}

function isGoCallFrame(line: string): boolean {
  if (line.startsWith("created by ")) return true;
  if (line.startsWith(" ") || line.startsWith("\t") || !line.endsWith(")"))
    return false;
  const open = line.indexOf("(");
  if (open === -1) return false;
  const symbol = line.slice(0, open);
  if (symbol.length === 0 || !symbol.includes(".")) return false;
  for (const c of symbol) {
    if (!(isAsciiAlnum(c) || c === "." || c === "_" || c === "/" || c === "*"))
      return false;
  }
  return true;
}

function isDotnetFrame(s: string): boolean {
  return s.startsWith("at ") && s.includes(") in ") && s.includes(":line ");
}

function isDotnetExceptionHead(trimmed: string): boolean {
  const colon = trimmed.indexOf(":");
  if (colon === -1) return false;
  const head = trimmed.slice(0, colon);
  if (!head.endsWith("Exception") || !head.includes(".")) return false;
  for (const c of head) {
    if (!(isAsciiAlnum(c) || c === "." || c === "_" || c === "`" || c === "+"))
      return false;
  }
  return true;
}

function isRustBacktraceFrame(s: string): boolean {
  const t = s.trimStart();
  let i = 0;
  while (i < t.length && isDigitChar(t[i]!)) i++;
  if (i === 0 || t[i] !== ":") return false;
  i++;
  while (i < t.length && t[i] === " ") i++;
  const rest = t.slice(i);
  if (!rest.startsWith("0x")) return false;
  let h = 0;
  for (const c of rest.slice(2)) {
    if (
      (c >= "0" && c <= "9") ||
      (c >= "a" && c <= "f") ||
      (c >= "A" && c <= "F")
    )
      h++;
    else break;
  }
  return h > 0;
}

function isJavaMoreSummary(trimmed: string): boolean {
  if (!trimmed.startsWith("... ")) return false;
  const rest = trimmed.slice(4);
  let d = 0;
  while (d < rest.length && isDigitChar(rest[d]!)) d++;
  return d > 0 && rest.slice(d).trim() === "more";
}

function traceFlavorFor(line: string): TraceFlavor | null {
  const t = line.trimStart();
  if (t.startsWith("Traceback (most recent call last)") || isPythonFileFrame(t))
    return "py";
  // Before js/java: .NET `at Ns.Class.Method(...) in File.cs:line N` also
  // satisfies the Java `at <dotted>(` shape.
  if (t.startsWith("Unhandled exception.") || isDotnetFrame(t)) return "dotnet";
  if (isJsAtFrame(t)) return "js";
  if (isJavaAtFrame(t)) return "java";
  if (t.startsWith("--> ") && hasLineColSuffix(t)) return "rust-error";
  if (
    isRustPanicOpener(t) ||
    t.startsWith("stack backtrace:") ||
    isRustBacktraceFrame(line)
  )
    return "rust-backtrace";
  if (isGoPanicOpener(line)) return "go-panic";
  return null;
}

function traceTerminates(
  flavor: TraceFlavor,
  line: string,
  linesSoFar: number,
): boolean {
  const t = line.trimStart();
  switch (flavor) {
    case "py": {
      const indentedOrBlank =
        line.startsWith(" ") || line.startsWith("\t") || line.length === 0;
      const continuation =
        t.startsWith("Traceback") ||
        t.startsWith("File ") ||
        t.startsWith("During handling") ||
        t.startsWith("The above exception");
      if (indentedOrBlank || continuation) return false;
      return !(t.length > 0 && t[0]! >= "A" && t[0]! <= "Z");
    }
    case "js":
      return !t.startsWith("at ") && line.length !== 0;
    case "java": {
      const chain =
        t.startsWith("Caused by:") ||
        t.startsWith("Suppressed:") ||
        isJavaMoreSummary(t);
      return !t.startsWith("at ") && !chain && line.length !== 0;
    }
    case "dotnet": {
      if (line.length === 0) return false;
      const continues =
        t.startsWith("at ") ||
        t.startsWith("--->") ||
        t.startsWith("--- End of") ||
        isDotnetExceptionHead(t);
      return !continues;
    }
    case "rust-error":
      return !t.startsWith("--> ") && line.length !== 0;
    case "rust-backtrace": {
      if (line.length === 0 || linesSoFar === 1) return false;
      const isFrame = t.length > 0 && isDigitChar(t[0]!);
      const continuation =
        line.startsWith(" ") ||
        line.startsWith("\t") ||
        t.startsWith("stack backtrace:") ||
        t.startsWith("note: run with");
      return !isFrame && !continuation;
    }
    case "go-panic": {
      if (line.length === 0) return false;
      const continues =
        line.startsWith("\t") ||
        isGoroutineHeader(line) ||
        isGoCallFrame(line) ||
        line.startsWith("panic: ") ||
        line.startsWith("fatal error: ") ||
        line.startsWith("[signal ");
      return !continues;
    }
  }
}

function scoreLogLine(l: LogLine): number {
  const base =
    l.level === "error" || l.level === "fail"
      ? 1.0
      : l.level === "warn"
        ? 0.5
        : l.level === "info" || l.level === "unknown"
          ? 0.1
          : l.level === "debug"
            ? 0.05
            : 0.02;
  return Math.min(base + (l.isStack ? 0.3 : 0) + (l.isSummary ? 0.4 : 0), 1.0);
}

function parseLogLines(lines: string[]): LogLine[] {
  const out: LogLine[] = new Array(lines.length);
  let active: TraceFlavor | null = null;
  let traceLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const entry: LogLine = {
      i,
      content: line,
      level: classifyLevel(line),
      isStack: false,
      isSummary: isLogSummaryLine(line),
      score: 0,
    };
    if (active !== null) {
      const flavor: TraceFlavor = active;
      if (
        traceLines >= LOG_STACK_MAX_LINES ||
        traceTerminates(flavor, line, traceLines)
      ) {
        const capHit = traceLines >= LOG_STACK_MAX_LINES;
        active = null;
        traceLines = 0;
        const nf = traceFlavorFor(line);
        if (nf !== null) {
          active = nf;
          traceLines = 1;
          entry.isStack = true;
        } else if (capHit && !traceTerminates(flavor, line, 2)) {
          // A capped trace does not end at its own cap line: chained
          // traces reopen on the same line.
          active = flavor;
          traceLines = 1;
          entry.isStack = true;
        }
      } else {
        entry.isStack = true;
        traceLines++;
      }
    } else {
      const f = traceFlavorFor(line);
      if (f !== null) {
        active = f;
        traceLines = 1;
        entry.isStack = true;
      }
    }
    entry.score = scoreLogLine(entry);
    out[i] = entry;
  }
  return out;
}

function selectWithFirstLast(arr: LogLine[], maxCount: number): LogLine[] {
  if (arr.length <= maxCount) return arr.slice();
  const out: LogLine[] = [];
  const seen = new Set<number>();
  const push = (l: LogLine) => {
    if (seen.add(l.i)) out.push(l);
  };
  push(arr[0]!);
  push(arr[arr.length - 1]!);
  if (out.length < maxCount) {
    const byScore = arr.slice().sort((a, b) => b.score - a.score || a.i - b.i);
    for (const l of byScore) {
      if (!seen.has(l.i)) {
        push(l);
        if (out.length >= maxCount) break;
      }
    }
  }
  return out;
}

// Conservative dedupe key: the message identifier before the first `:`/`=`
// stays intact; only variable parts (digits, addresses, paths) in the suffix
// are normalised, so distinct messages sharing a trailing shape stay distinct.
function normalizeForDedupe(content: string): string {
  let splitAt = content.length;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === ":" || content[i] === "=") {
      splitAt = i;
      break;
    }
  }
  const suffix = content
    .slice(splitAt)
    .replace(/\d+/g, "N")
    .replace(/0x[0-9a-fA-F]+/g, "ADDR")
    .replace(/\/[\w/]+\//g, "/PATH/");
  return content.slice(0, splitAt) + suffix;
}

const RUNTIME_FRAME_PREFIXES = [
  "at java.",
  "at jdk.",
  "at sun.",
  "at javax.",
  "at scala.",
  "at System.",
  "at Microsoft.",
  "runtime.",
  "created by runtime.",
];
const RUNTIME_FRAME_MARKERS = [
  "site-packages/",
  "/usr/lib/python",
  "lib/python3.",
  "node:internal/",
  "node_modules/",
  "(internal/",
  "core::",
  "std::",
  "alloc::",
  "rust_begin_unwind",
  "__rust_",
  "/rustc/",
  "/usr/local/go/src/",
  "/libexec/src/runtime/",
];

function isFrameLine(content: string): boolean {
  const t = content.trimStart();
  return (
    t.startsWith("at ") ||
    (t.startsWith('File "') && t.includes('", line ')) ||
    isRustBacktraceFrame(content) ||
    isGoFileFrame(content) ||
    isGoCallFrame(content)
  );
}

function isChainHeadLine(content: string): boolean {
  const t = content.trimStart();
  return (
    t.startsWith("Caused by:") ||
    t.startsWith("Suppressed:") ||
    t.startsWith("... ") ||
    t.startsWith("--->") ||
    t.startsWith("--- End of") ||
    t.startsWith("During handling") ||
    t.startsWith("The above exception")
  );
}

function isRuntimeFrame(content: string): boolean {
  const t = content.trimStart();
  return (
    RUNTIME_FRAME_PREFIXES.some((p) => t.startsWith(p)) ||
    RUNTIME_FRAME_MARKERS.some((m) => content.includes(m))
  );
}

interface CollapsedTrace {
  kept: LogLine[];
  dropped: Set<number>;
}

function collapseTraceFrames(
  stack: LogLine[],
  headFrames: number,
  appFrames: number,
): CollapsedTrace {
  const kept: LogLine[] = [];
  const dropped = new Set<number>();
  let framesSeen = 0;
  let appKept = 0;
  let runStart = -1;
  let runLen = 0;
  let prevDropped = false;
  const flushRun = () => {
    if (runStart !== -1) {
      kept.push({
        i: runStart,
        content: `      [... ${runLen} frames collapsed]`,
        level: "unknown",
        isStack: true,
        isSummary: false,
        score: 0.8,
      });
      runStart = -1;
      runLen = 0;
    }
  };
  for (const line of stack) {
    if (isFrameLine(line.content) && !isChainHeadLine(line.content)) {
      framesSeen++;
      const runtime = isRuntimeFrame(line.content);
      const keep =
        framesSeen <= headFrames || (!runtime && appKept < appFrames);
      if (keep) {
        if (!runtime) appKept++;
        flushRun();
        kept.push(line);
        prevDropped = false;
      } else {
        if (runStart === -1) runStart = line.i;
        runLen++;
        dropped.add(line.i);
        prevDropped = true;
      }
    } else if (
      prevDropped &&
      (line.content.startsWith(" ") || line.content.startsWith("\t")) &&
      !isChainHeadLine(line.content)
    ) {
      runLen++;
      dropped.add(line.i);
    } else {
      flushRun();
      kept.push(line);
      prevDropped = false;
    }
  }
  flushRun();
  return { kept, dropped };
}

function selectLogLines(all: LogLine[]): LogLine[] {
  const errors: LogLine[] = [];
  const fails: LogLine[] = [];
  const warnings: LogLine[] = [];
  const summaries: LogLine[] = [];
  const stacks: LogLine[][] = [];
  let current: LogLine[] = [];
  for (const l of all) {
    if (l.level === "error") errors.push(l);
    else if (l.level === "fail") fails.push(l);
    else if (l.level === "warn") warnings.push(l);
    if (l.isStack) current.push(l);
    else if (current.length > 0) {
      stacks.push(current);
      current = [];
    }
    if (l.isSummary) summaries.push(l);
  }
  if (current.length > 0) stacks.push(current);

  const selected = new Map<number, LogLine>();
  for (const l of selectWithFirstLast(errors, LOG_MAX_ERRORS))
    selected.set(l.i, l);
  for (const l of selectWithFirstLast(fails, LOG_MAX_ERRORS))
    selected.set(l.i, l);
  const seenWarn = new Set<string>();
  const dedupedWarnings: LogLine[] = [];
  for (const w of warnings) {
    const key = normalizeForDedupe(w.content);
    if (!seenWarn.has(key)) {
      seenWarn.add(key);
      dedupedWarnings.push(w);
    }
  }
  for (const w of dedupedWarnings.slice(0, LOG_MAX_WARNINGS))
    selected.set(w.i, w);
  for (const stack of stacks.slice(0, LOG_MAX_STACK_TRACES)) {
    if (stack.length > LOG_STACK_MAX_LINES) {
      const collapsed = collapseTraceFrames(
        stack,
        LOG_TRACE_HEAD_FRAMES,
        LOG_TRACE_APP_FRAMES,
      );
      for (const i of collapsed.dropped) selected.delete(i);
      for (const l of collapsed.kept.slice(0, LOG_STACK_MAX_LINES))
        selected.set(l.i, l);
    } else {
      for (const l of stack) selected.set(l.i, l);
    }
  }
  for (const s of summaries) selected.set(s.i, s);

  for (const idx of Array.from(selected.keys())) {
    const lo = Math.max(0, idx - LOG_ERROR_CONTEXT);
    const hi = Math.min(all.length, idx + LOG_ERROR_CONTEXT + 1);
    for (let i = lo; i < hi; i++) {
      if (i !== idx && !selected.has(i)) selected.set(i, all[i]!);
    }
  }

  let ordered = Array.from(selected.values());
  if (ordered.length > LOG_MAX_TOTAL_LINES) {
    ordered.sort((a, b) => b.score - a.score || a.i - b.i);
    ordered = ordered.slice(0, LOG_MAX_TOTAL_LINES);
    ordered.sort((a, b) => a.i - b.i);
  }
  return ordered;
}

function formatLogOutput(selected: LogLine[], all: LogLine[]): string {
  const count = (lv: LogLevelName) =>
    all.reduce((n, l) => (l.level === lv ? n + 1 : n), 0);
  const output = selected.map((l) => l.content);
  const omitted = all.length - selected.length;
  if (omitted > 0) {
    const parts: string[] = [];
    const e = count("error");
    const f = count("fail");
    const w = count("warn");
    const inf = count("info");
    if (e > 0) parts.push(`${e} ERROR`);
    if (f > 0) parts.push(`${f} FAIL`);
    if (w > 0) parts.push(`${w} WARN`);
    if (inf > 0) parts.push(`${inf} INFO`);
    if (parts.length > 0)
      output.push(`[${omitted} lines omitted: ${parts.join(", ")}]`);
  }
  return output.join("\n");
}

const LOG_FORMAT_TABLE: Array<[string, string[]]> = [
  [
    "pytest",
    [
      "=== FAILURES",
      "=== ERRORS",
      "=== test session",
      "=== short test summary",
      "PASSED [",
      "FAILED [",
      "ERROR [",
      "SKIPPED [",
      "collected ",
    ],
  ],
  ["npm", ["npm ERR!", "npm WARN", "npm info", "npm http"]],
  ["cargo", ["Compiling ", "Finished ", "Running ", "warning: ", "error[E"]],
  ["jest", ["PASS ", "FAIL ", "Test Suites:"]],
  ["make", ["make[", "make:", "gcc ", "g++ ", "clang "]],
];

function detectLogFormat(lines: string[]): string {
  const sample = lines.slice(0, 100);
  let best = "generic";
  let bestScore = 0;
  for (const [name, pats] of LOG_FORMAT_TABLE) {
    let score = 0;
    for (const line of sample) {
      if (pats.some((p) => line.includes(p))) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return best;
}

export function crushLog(text: string): string | null {
  const lines = text.split(/\r?\n/);
  if (lines.length < LOG_MIN_LINES) return null;
  let classified = 0;
  let summaries = 0;
  let traces = 0;
  for (const line of lines) {
    const lv = classifyLevel(line);
    if (lv !== "unknown") classified++;
    if (isLogSummaryLine(line)) summaries++;
    if (traceFlavorFor(line) !== null) traces++;
  }
  // Gate: require positive log structure before any line may be dropped —
  // prose and structured data must never reach the selector.
  if (!(
    classified >= LOG_CLASSIFIED_GATE ||
    traces >= 1 ||
    summaries >= LOG_SUMMARY_GATE ||
    detectLogFormat(lines) !== "generic"
  ))
    return null;
  const parsed = parseLogLines(lines);
  const selected = selectLogLines(parsed);
  if (selected.length >= lines.length) return null;
  const out = formatLogOutput(selected, parsed);
  if (out.length >= text.length) return null;
  return out;
}

function errorLinesSurvive(input: string, output: string): boolean {
  const kept = new Set(
    output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
  for (const line of input.split(/\r?\n/)) {
    const level = classifyLevel(line);
    if (level !== "error" && level !== "fail") continue;
    const t = line.trim();
    if (t.length > 0 && !kept.has(t)) return false;
  }
  return true;
}

export const jsonFoldPlugin: CrushPluginDef = {
  id: "json-fold",
  kinds: ["json"],
  run(text) {
    const out = crushJson(text);
    return out ? { text: out, lossy: false } : null;
  },
};

export const codeTrimPlugin: CrushPluginDef = {
  id: "code-trim",
  kinds: ["code"],
  run(text) {
    const out = crushCode(text);
    return out ? { text: out, lossy: true } : null;
  },
};

export const logSelectPlugin: CrushPluginDef = {
  id: "log-select",
  kinds: ["log"],
  run(text) {
    const out = crushLog(text);
    return out ? { text: out, lossy: true } : null;
  },
};

const builtInPlugins: readonly CrushPluginDef[] = [
  jsonFoldPlugin,
  codeTrimPlugin,
  logSelectPlugin,
];
const crushRegistry = new Map<string, CrushPluginDef>();
for (const p of builtInPlugins) crushRegistry.set(p.id, p);

export function registerCrushPlugin(def: CrushPluginDef): void {
  crushRegistry.set(def.id, def);
}

export function unregisterCrushPlugin(id: string): void {
  crushRegistry.delete(id);
}

export function listCrushPlugins(): Array<
  Pick<CrushPluginDef, "id" | "kinds">
> {
  return Array.from(crushRegistry.values()).map((p) => ({
    id: p.id,
    kinds: p.kinds,
  }));
}

/** Test support: restore the built-in set exactly, in built-in order. */
export function resetCrushPlugins(): void {
  crushRegistry.clear();
  for (const p of builtInPlugins) crushRegistry.set(p.id, p);
}

function registeredPlugins(): readonly CrushPluginDef[] {
  return Array.from(crushRegistry.values());
}

export function resolveCrushConfig(config: Config): CrushConfig {
  return { ...DEFAULT_CRUSH_CONFIG, ...(config.crush ?? {}) };
}

function effectivePlugins(
  crush: CrushConfig,
  meta: CrushMeta,
): readonly CrushPluginDef[] {
  const toolName = meta.toolName;
  return registeredPlugins().filter((p) => {
    const ov = crush.strategies?.[p.id];
    if (ov?.enabled === false) return false;
    if (
      toolName &&
      ov?.excludeTools?.some((pat) => matchToolPattern(toolName, pat))
    )
      return false;
    return true;
  });
}

export interface EvaluateCrushInput {
  text: string;
  absorb: ResolvedAbsorbConfig;
  crush: CrushConfig;
  /** Current context token count (context-pressure signal). */
  tokenCount: number;
  modelContextLimit: number;
  meta?: CrushMeta;
  countTokens?: TokenCountFn;
}

/** Two-tier gate decision for one tool-result payload. Pure: same input ⇒
 *  same bytes. `skip` = under the absorb gates; `crushed` = deterministic
 *  compression brought it under minToolTokens (no model round-trip);
 *  `distill` = still over (or uncrushable) — hand `text` to the absorb prompt
 *  path; when crushing succeeded `text` is the crushed payload. */
export function evaluateToolResult(input: EvaluateCrushInput): CrushEvaluation {
  const { absorb, crush, tokenCount, modelContextLimit, meta = {} } = input;
  const countTokens = input.countTokens ?? defaultCountTokens;
  const text = input.text;
  const rawTokens = countTokens(text);
  if (
    absorb.contextThresholdPct > 0 &&
    modelContextLimit > 0 &&
    tokenCount < absorb.contextThresholdPct * modelContextLimit
  ) {
    return { kind: "skip", text, rawTokens };
  }
  if (rawTokens < absorb.minToolTokens) {
    return { kind: "skip", text, rawTokens };
  }
  const out = crushText(text, {
    minReduction: crush.minReduction,
    countTokens,
    meta,
    plugins: effectivePlugins(crush, meta),
  });
  if (!out) return { kind: "distill", text, rawTokens };
  const newTokens = countTokens(out.text);
  return {
    kind: newTokens < absorb.minToolTokens ? "crushed" : "distill",
    text: out.text,
    rawTokens,
    newTokens,
    reduction: (rawTokens - newTokens) / rawTokens,
    strategy: out.strategy,
    lossy: out.lossy,
  };
}

export interface ApplyCrushResult {
  messages: CoreMessage[];
  /** Results crushed below minToolTokens (no model round-trip). */
  crushedCount: number;
  /** Results forwarded to the absorb prompt path with crushed text. */
  distilledCount: number;
}

/** Pipeline-facing application: view-only, deterministic per turn. Runs
 *  between absorb-hide and absorb-prompt so the prompt node re-decides on
 *  post-crush sizes in the same turn (atomic two-tier gate). Returns the
 *  input array unchanged when nothing qualifies. */
export function applyCrushToMessages(
  messages: CoreMessage[],
  config: Config,
  tokenCount: number,
  countTokens: TokenCountFn,
): ApplyCrushResult {
  const absorb = resolveAbsorbConfig(config);
  const crush = resolveCrushConfig(config);
  const protectedCallIds = collectProtectedToolCallIds(messages, config);
  let crushedCount = 0;
  let distilledCount = 0;
  let changed = false;
  const out: CoreMessage[] = [];
  for (const msg of messages) {
    if (!isAbsorbCandidate(msg, config, undefined, protectedCallIds)) {
      out.push(msg);
      continue;
    }
    const text = msg.text ?? "";
    // If a marker is present anyway (host-resent rendered text), crush the
    // payload only and drop the stale marker — appendAbsorbPrompts
    // re-decides on the post-crush size later in this turn.
    const markerAt = text.indexOf(ABSORB_PROMPT_MARKER);
    const payload = markerAt >= 0 ? text.slice(0, markerAt) : text;
    const ev = evaluateToolResult({
      text: payload,
      absorb,
      crush,
      tokenCount,
      modelContextLimit: config.modelContextLimit,
      meta: { toolName: msg.toolName },
      countTokens,
    });
    if (ev.kind === "skip") {
      out.push(msg);
      continue;
    }
    changed = true;
    if (ev.kind === "crushed") crushedCount++;
    else distilledCount++;
    out.push({ ...msg, text: ev.text });
  }
  return { messages: changed ? out : messages, crushedCount, distilledCount };
}
