// #3842 — Outbound-invariant judge (the "attribution layer").
//
// Decides, for ONE request, whether bili rewrote the client's own history on
// the way out. It reconciles the INBOUND core (what the client sent) against
// the OUTBOUND core (what bili forwarded) at the kernel canonical-core level
// (#3658) — wire-neutral, so same-wire and cross-wire share one code path.
//
// Invariants (owner design, #3842):
//   I1 (no fold): every inbound stable message appears at the outbound in
//     order, normalized-equal. Only legal diffs: (a) tail appends, (b) the
//     named, count-bounded exemption list — chain checkpoint / acp_summary
//     carriers (outbound-injected, or inbound-ECHOED by stateful hosts, which
//     match their own twin by identity), policy reasoning drops, crush
//     envelopes.
//   I2 (fold): all divergence is confined to [earliest-fold-start, end); the
//     bytes before the fold point stay identical, and the fold carrier stays
//     pinned (anchor drift is a violation too).
//   Plugin carrier regime (#4401): in plugin lanes the client's own re-sent
//     compress pair IS the wire carrier (KDD#7/#1567) — while the pair rides,
//     the kernel anchor is stripped, so the exit can carry NO acp_summary
//     marker. A successful compress receipt marks the folded regime; cells
//     covered by active blocks (host state, `coveredIds`) are expected
//     absences, not drops; the zero-carrier anomaly (no anchor AND no pair)
//     stays red.
//
// Single-request independence: the inbound core IS the client ground truth, so
// the judge needs no cross-request state — structurally avoiding the process-
// local seam pairing's restart blindness (#2773).
//
// Division of labor (kept separate on purpose): this judge = attribution
// ("whose fault"); seamLcp (#2131, consecutive outbound-vs-previous-outbound)
// = miss detection ("money lost"). A client restart/id-change passes I1
// correctly yet still breaks the provider prefix cache — that layer owns it.
//
// normalize-on-compare (renderTags=text-only, #2483/#3842): render tags are
// re-stamped onto historical assistant text EVERY request, so they are stripped
// from BOTH sides before comparison. This closes the exemption list WITHOUT
// changing a single outbound byte (zero behavior change).
//
// Pure: no I/O, no mutation. `judgeInboundOutbound` never throws on well-formed
// input; the runtime wrapper records events only and never blocks traffic.

import { COMPRESS_TOOL_NAME, type CompressionState, type CoreMessage } from "acp-kernel";
import { openaiToCore, anthropicToCore, responsesToCore, googleToCore } from "acp-kernel/wire";
import { log as loggerLog } from "./logger.js";
import { invariantJudgeEnabled } from "./knobs.js";
import { normalizeEchoArtifacts } from "./loop/tag-echo-filter.js";

// `<acp tokens="N" type="T">ref</acp>`; angle brackets hex-escaped per KDD#2.
// An optional leading newline is consumed too — the renderer injects the tag on
// its own line, so leaving it behind would false-positive every re-tagged turn.
const RENDER_TAG_RE = /\n?\x3cacp\s[^>]*\x3e[\s\S]*?\x3c\/acp\x3e/g;
const CHAIN_TAG_PREFIX = "\x3cbili-chain ";
const SUMMARY_MARKER = "[Compressed conversation section]";
// kernel/src/crush.ts CRUSH_KEY — a tool-result decoding to an object with this
// key was legitimately crushed (lossless, deterministic), not rewritten.
const CRUSH_KEY = "__acp_crush";
// #4401: plugin-lane folds (KDD#7/#1567) ride their summary in the client's own
// re-sent compress pair — while that pair rides, stripKernelSummaries removes
// the kernel anchor, so a steady-state folded plugin session carries ZERO
// acp_summary markers on the wire. The tool-RESULT half of a SUCCESSFUL
// compress call (the receipt built at src/stream.ts:1108) is therefore a summary
// carrier of exactly the same rank as the anchor: it marks the folded regime.
// Gated on the success prefix on purpose — refused/failed receipts
// ("[Compression refused/FAILED…") folded nothing, so they must NOT mark the
// regime (drops behind them stay visible). Every wire codec backfills toolName
// onto paired results (kernel/src/wire/*), so this is wire-neutral.
const COMPRESS_RECEIPT_PREFIX = "[Compressed ";

type ViolationKind =
  | "mid-history-rewrite"
  | "mid-history-drop"
  | "mid-insertion"
  | "fold-boundary-drift"
  | "carrier-drift"
  | "exemption-overflow";

interface Violation {
  kind: ViolationKind;
  /** Inbound index implicated (-1 when the finding is positional on the exit side). */
  index: number;
  detail: string;
}

export interface JudgeVerdict {
  ok: boolean;
  folded: boolean;
  foldStart?: number;
  matched: number;
  total: number;
  violations: Violation[];
  /** Named-exemption volume consumed this request (#3842 count-bounded list). */
  exempt?: { carrier: number; reasoning: number; crush: number };
  /** Entry cells excused as fold-covered by host state (#4401). */
  covered?: number;
  /** Egress lane the verdict came from — main first-send vs loop round-2+. */
  lane?: "main" | "loop";
}

interface JudgeOptions {
  // Carriers are few per request; a wider gap than this before the next stable
  // match reads as a rewrite, not an injection. Default 4.
  maxCarrierGap?: number;
  // #3842 named exemptions are COUNT-BOUNDED: carrier/reasoning/crush volume
  // beyond this per request is itself a violation signal (a defect dressing up
  // as exemptions), even when every stable message matched. Default 128 — a
  // steady folded session stays far under it (≈ one carrier per live block +
  // one reasoning item per reasoning turn).
  maxExempt?: number;
  // #4401: ids of messages covered by ACTIVE fold blocks (host state). In the
  // plugin carrier regime their absence from the outbound IS the fold — an
  // entry cell whose id is here is expected-absent, not a drop. Only honored
  // when the exit actually carries fold evidence (anchor or success receipt);
  // zero carriers + missing covered cells is the anomaly that must stay red.
  coveredIds?: ReadonlySet<string>;
}

function normText(m: CoreMessage): string {
  // #3938 PR-D closure: normalize by the SAME artifact set the outbound
  // stream filters strip (case-drift #1731, typo drift #673, bare #1881,
  // degen/self-close #2190/#2348, mangled #2066, markers #717, chain carriers
  // #1634, dead ref-close #2862 …) so an echo shape one side legitimately
  // removed can never read as a mid-history rewrite. RENDER_TAG_RE stays as
  // a belt for the kernel's canonical render form.
  return normalizeEchoArtifacts((m.text ?? "").replace(RENDER_TAG_RE, "")).trim();
}

function isReasoning(m: CoreMessage): boolean {
  return m.contentType === "reasoning";
}

// #4401: the re-sent compress pair (KDD#7 plugin-lane carrier) is exempt volume
// like any injected artifact — the call half rides as client history, the
// successful result half marks the folded regime.
function isCompressToolMsg(m: CoreMessage): boolean {
  return (m.contentType === "tool-call" || m.contentType === "tool-result") && m.toolName === COMPRESS_TOOL_NAME;
}

function isCompressReceipt(m: CoreMessage): boolean {
  return isCompressToolMsg(m) && m.contentType === "tool-result" && (m.text ?? "").startsWith(COMPRESS_RECEIPT_PREFIX);
}

function isCarrier(m: CoreMessage): boolean {
  if (m.summaryOfBlockId !== undefined) return true;
  const t = m.text ?? "";
  return t.startsWith(CHAIN_TAG_PREFIX) || t.includes(SUMMARY_MARKER) || isCompressToolMsg(m);
}

function isSummaryCarrier(m: CoreMessage): boolean {
  if (m.summaryOfBlockId !== undefined) return true;
  const t = m.text ?? "";
  return t.includes(SUMMARY_MARKER) || m.id.startsWith("acp_summary") || isCompressReceipt(m);
}

function isCrushedToolResult(m: CoreMessage): boolean {
  if (m.contentType !== "tool-result") return false;
  const t = (m.text ?? "").trim();
  if (!t.startsWith("{")) return false;
  try {
    const o = JSON.parse(t) as unknown;
    return !!o && typeof o === "object" && Object.hasOwn(o as Record<string, unknown>, CRUSH_KEY);
  } catch {
    return false;
  }
}

function fp(m: CoreMessage): string {
  const id = m.toolCallId ? `#${m.toolCallId}` : "";
  const name = m.contentType === "tool-call" && m.toolName ? `:${m.toolName}` : "";
  const t = normText(m).replace(/\s+/g, " ").trim().slice(0, 80);
  return `${m.role}/${m.contentType}${name}${id}|${t}`;
}

// Identity is content-primary: tool-call ids are re-minted on re-projection
// (#2821) while bytes stay identical, so a differing toolCallId never vetoes a
// content-equal pair (order-centric, KDD#11). toolName stays a hard gate.
function stableEqual(a: CoreMessage, b: CoreMessage): boolean {
  if (a.role !== b.role || a.contentType !== b.contentType) return false;
  if (a.contentType === "tool-call" && a.toolName && b.toolName && a.toolName !== b.toolName) return false;
  if (isCrushedToolResult(b)) return true;
  return normText(a) === normText(b);
}

/**
 * Reconcile one request's inbound core against its outbound core. Returns a
 * structured verdict; never throws on well-formed input. On a corrupted stream
 * it may report several related violations — `ok` is authoritative, details aid triage.
 */
export function judgeInboundOutbound(
  entry: readonly CoreMessage[],
  exit: readonly CoreMessage[],
  opts: JudgeOptions = {},
): JudgeVerdict {
  const maxGap = opts.maxCarrierGap ?? 4;
  const maxExempt = opts.maxExempt ?? 128;
  const coveredIds = opts.coveredIds;
  const violations: Violation[] = [];
  let matched = 0;
  let total = 0;
  let covered = 0;

  // The fold point is the first summary carrier; everything before it is the
  // frozen prefix (must match), everything from it on is the fold/tail (free).
  const sumIdx = exit.findIndex(isSummaryCarrier);
  const folded = sumIdx !== -1;
  const freezeEnd = folded ? sumIdx : exit.length;
  let foldStart = -1;

  let j = 0;
  for (let i = 0; i < entry.length; i++) {
    const e = entry[i];
    if (isReasoning(e)) continue;
    if (folded && j >= freezeEnd) { foldStart = i; break; } // remainder is the folded region
    total++;

    // Stateful hosts re-send previously-injected carriers in their inbound
    // history; such an entry must match its own twin by identity — skipping
    // exit carriers for it would false-positive every steady-state post-fold
    // turn. The gap budget counts NON-carrier elements only: a stack of
    // injected carriers between stable messages is exempt volume, not drift.
    const eCarrier = isCarrier(e);
    let found = -1;
    let nearTwin = false;
    let scanned = 0;
    for (let k = j; k < freezeEnd; k++) {
      const x = exit[k];
      if (isReasoning(x)) continue;
      if (!eCarrier && isCarrier(x)) continue;
      scanned++;
      if (scanned > maxGap) break;
      if (stableEqual(e, x)) { found = k; break; }
      if (x.role === e.role && x.contentType === e.contentType && (!e.toolCallId || !x.toolCallId || x.toolCallId === e.toolCallId)) nearTwin = true;
    }

    if (found < 0) {
      // #4401: an active block covers this cell — its absence IS the fold, not a
      // drop. Gated on `folded`: no carrier in the exit means the fold left no
      // evidence at all, and that anomaly must stay red. Consumes nothing on the
      // exit side (j stays put — the cell has no outbound twin to resume after).
      if (folded && coveredIds?.has(e.id)) {
        covered++;
        continue;
      }
      violations.push({
        kind: nearTwin ? "mid-history-rewrite" : "mid-history-drop",
        index: i,
        detail: `inbound[${i}] ${fp(e)} absent from outbound frozen prefix`,
      });
      j++; // soft resync: one bad cell must not cascade into a total unfold (#2821)
      continue;
    }

    for (let k = j; k < found; k++) {
      const x = exit[k];
      if (!isCarrier(x) && !isReasoning(x)) {
        violations.push({ kind: "mid-insertion", index: i, detail: `unexplained outbound element before inbound[${i}]: ${fp(x)}` });
      }
    }
    matched++;
    j = found + 1;
  }

  // Carrier pinning (I2): a non-carrier element sitting before the fold carrier
  // that exceeds the matched frozen prefix means the anchor drifted.
  if (folded && sumIdx > matched) {
    for (let k = matched; k < sumIdx; k++) {
      const x = exit[k];
      if (!isCarrier(x) && !isReasoning(x)) {
        violations.push({ kind: "carrier-drift", index: -1, detail: `element before fold carrier at outbound[${k}]: ${fp(x)}` });
        break;
      }
    }
  }

  // The named exemptions are COUNT-BOUNDED (#3842): the ledger is the whole
  // outbound exempt volume (carriers + policy reasoning drops + crush
  // envelopes), independent of matching — a defect mass-producing exempt-
  // looking elements surfaces even when every stable message matched.
  const carrierExempt = exit.filter(isCarrier).length;
  const reasoningExempt = exit.filter(isReasoning).length;
  const crushExempt = exit.filter(isCrushedToolResult).length;
  const exemptTotal = carrierExempt + reasoningExempt + crushExempt;
  if (exemptTotal > maxExempt) {
    violations.push({
      kind: "exemption-overflow",
      index: -1,
      detail: `named-exemption volume ${exemptTotal} exceeds cap ${maxExempt} (carrier=${carrierExempt} reasoning=${reasoningExempt} crush=${crushExempt})`,
    });
  }

  return {
    ok: violations.length === 0,
    folded,
    ...(folded && foldStart >= 0 ? { foldStart } : {}),
    matched,
    total,
    ...(covered > 0 ? { covered } : {}),
    violations,
    exempt: { carrier: carrierExempt, reasoning: reasoningExempt, crush: crushExempt },
  };
}

// --- Runtime wiring (advisory, armed by default — #3938 decision ②) --------
// L1 advisory: armed by default (invariantJudgeEnabled knob: env
// BILI_INVARIANT_JUDGE=0/false or config diagnostics.invariantJudge=false to
// disarm). It reconciles every request through the real path, reports verdicts
// to the sink (default: violations at warn, clean verdicts at debug), and
// never mutates the body or throws out. Owner design: #3842, enablement
// decision recorded in #3938.
interface InvariantJudgeInput {
  /** Inbound cores (what the client sent) — already computed by prepare. */
  originalMessages?: readonly CoreMessage[];
  /** Outbound request body (the exact bytes forwarded) — re-parsed to core here. */
  body?: string | Buffer;
  protocol?: string;
  sessionId?: string;
  /** #4401: active-block coverage from host state (see JudgeOptions.coveredIds). */
  coveredIds?: ReadonlySet<string>;
}

// Host-state side of #4401: the ids an ACTIVE fold block covers. These are the
// exact cells processTurn replaced with carriers THIS request, in the same
// canonical-id namespace as the inbound cores (the ids reconcileFoldCoverage
// already matches against the resent history). undefined when nothing is
// covered — growth-only requests pay no allocation.
export function activeBlockCoveredIds(state: CompressionState | null | undefined): Set<string> | undefined {
  if (!state || state.blocks.length === 0) return undefined;
  let set: Set<string> | undefined;
  for (const b of state.blocks) {
    if (!b.active || b.effectiveMessageIds.length === 0) continue;
    (set ??= new Set());
    for (const id of b.effectiveMessageIds) set.add(id);
  }
  return set;
}

// Re-parse the ACTUAL outbound body through its own wire codec so the exit side
// reflects exactly what crossed the wire. prepare builds the body from
// rebuiltMessages, NOT from processedMessages — comparing those internal
// snapshots diverges for reasons unrelated to the invariant (token estimation,
// ref re-minting, ordering repairs). Same codec on both sides ⇒ directly
// comparable and wire-neutral, which is also what makes cross-wire work.
function parseExitCores(body: string | Buffer | undefined, protocol: string | undefined): CoreMessage[] | null {
  if (!body || !protocol) return null;
  const text = typeof body === "string" ? body : body.toString("utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  try {
    switch (protocol) {
      case "openai": return openaiToCore(parsed as Parameters<typeof openaiToCore>[0]).msgs;
      case "anthropic": return anthropicToCore(parsed as Parameters<typeof anthropicToCore>[0]).msgs;
      case "responses": return responsesToCore(parsed as Parameters<typeof responsesToCore>[0]).msgs;
      case "google": return googleToCore(parsed as Parameters<typeof googleToCore>[0]).msgs;
      default: return null;
    }
  } catch { return null; }
}

type Sink = (v: JudgeVerdict) => void;
// Test-only fault injector: simulates a bili defect in the exit core so the
// wired path can be proven to detect it without depending on an unfixed bug.
// It operates on a throwaway copy — the relayed body is never touched.
type Fault = (exitCores: CoreMessage[]) => CoreMessage[];
let armedOverride: boolean | null = null;
let sink: Sink | null = null;
let fault: Fault | null = null;

function defaultSink(sessionId: string | undefined, lane: "main" | "loop"): Sink {
  return (v) => {
    const where = `[${sessionId ?? "unknown"}] [invariant-judge${v.lane ? `/${v.lane}` : ``}]`;
    if (!v.ok) {
      const head = v.violations[0];
      loggerLog("warn", `${where} I${v.folded ? 2 : 1} violation: ${head.kind} @${head.index} — ${head.detail} (${v.violations.length} finding(s), matched ${v.matched}/${v.total}${v.covered ? `, covered ${v.covered}` : ``}${v.exempt ? `, exempt carrier=${v.exempt.carrier} reasoning=${v.exempt.reasoning} crush=${v.exempt.crush}` : ``})`);
    } else {
      loggerLog("debug", `${where} clean ${v.folded ? "fold" : "growth"} verdict: matched ${v.matched}/${v.total}${v.covered ? `, covered ${v.covered}` : ``}${v.exempt ? `, exempt carrier=${v.exempt.carrier} reasoning=${v.exempt.reasoning} crush=${v.exempt.crush}` : ``}`);
    }
  };
}

export function _setInvariantJudgeForTest(enabled: boolean, s?: Sink): void {
  armedOverride = enabled ? true : false;
  sink = enabled ? (s ?? null) : null;
}

export function _setInvariantJudgeFaultForTest(fn?: Fault | null): void {
  fault = fn ?? null;
}

function armed(): boolean {
  if (armedOverride !== null) return armedOverride;
  return invariantJudgeEnabled();
}

export function maybeRunInvariantJudge(input: InvariantJudgeInput): void {
  if (!armed()) return;
  try {
    const entry = input.originalMessages ?? [];
    const exitCores0 = parseExitCores(input.body, input.protocol);
    if (!exitCores0) return; // unparseable/unknown wire → skip, never false-positive
    const exitCores = fault ? fault([...exitCores0]) : exitCores0;
    const v = judgeInboundOutbound(entry, exitCores, { coveredIds: input.coveredIds });
    // Every judged request reports its verdict (ok or not): consumers must be
    // able to see folded-but-clean traffic too, not just violations — that is
    // how the live I2 path proves a real fold stayed green (#3842).
    (sink ?? defaultSink(input.sessionId, "main"))({ ...v, lane: "main" });
  } catch {
    // advisory layer: a judge failure must never disturb the request
  }
}

// Loop rounds 2+ rebuild the body from bili's OWN accumulated state, not from
// the client's inbound — the entry ground truth for them is the PREVIOUS
// outbound (I1: only tail appends + named exemptions may differ). `prev` is
// the last sent body's retained full copy (clipped/oversized bodies are
// absent and the check silently skips — no false positives from partial
// forensics). Same-wire by construction; a mid-session wire switch fails the
// parse/pair loudly, which is exactly the #3849 signal.
export function maybeJudgeContinuity(
  prev: string | Buffer | null | undefined,
  body: string | Buffer,
  protocol: string | undefined,
  sessionId?: string,
): void {
  if (!armed() || !prev) return;
  try {
    const entry = parseExitCores(prev, protocol);
    const exitCores0 = parseExitCores(body, protocol);
    if (!entry || !exitCores0) return;
    const exitCores = fault ? fault([...exitCores0]) : exitCores0;
    const v = judgeInboundOutbound(entry, exitCores);
    (sink ?? defaultSink(sessionId, "loop"))({ ...v, lane: "loop" });
  } catch {
    // advisory layer: a judge failure must never disturb the request
  }
}
