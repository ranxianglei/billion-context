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
//     envelopes, CCR-stored tool results (canonical placeholder substitutes
//     the client's full text, #4186), emergency-truncation twins (kernel
//     prefix+marker+suffix clip of the same message, #4186).
//   I2 (fold): all divergence is confined to [earliest-fold-start, end); the
//     bytes before the fold point stay identical, and the fold carrier stays
//     pinned (anchor drift is a violation too).
//   I3 (egress pairing, #4862): the exit body must be protocol-SOUND on its
//     own — every tool-call answered by a same-id tool-result after it, every
//     tool-result preceded by a same-id tool-call. I1/I2 only reconcile
//     entry↔exit continuity, so a fold that eats ONE half of a pair used to
//     judge clean (the folded region is a free zone) right before the upstream
//     answered 400. I3 is exit-internal, fold-split agnostic, and
//     attribution-scoped (a half-pair the client itself sent broken is the
//     host's defect, not bili's).
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

import { parseStoredPlaceholder, type CoreMessage } from "acp-kernel";
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

type ViolationKind =
  | "mid-history-rewrite"
  | "mid-history-drop"
  | "mid-insertion"
  | "fold-boundary-drift"
  | "carrier-drift"
  | "exemption-overflow"
  | "unpaired-tool-call"
  | "unpaired-tool-result";

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
  exempt?: { carrier: number; reasoning: number; crush: number; ccr: number; truncate: number };
  /** Egress lane the verdict came from — main first-send vs loop round-2+. */
  lane?: "main" | "loop";
  /** #4241: true when judged in render-lane tail-fidelity mode (outbound prefix was server-rendered). */
  renderLane?: boolean;
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
  // #4241: when set (a finite number >= 0), THIS turn's outbound prefix was
  // server-rendered (snapshot-render lane) — the raw inbound prefix is NOT a
  // valid baseline (the engine intentionally replaced the covered region with
  // transcript rows + summary carriers). Validate only the client tail
  // entry[renderTailStart..] against the outbound; the rendered prefix is exempt
  // from the frozen-prefix requirement. Absent ⇒ legacy full inbound-vs-outbound.
  renderTailStart?: number;
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

function isCarrier(m: CoreMessage): boolean {
  if (m.summaryOfBlockId !== undefined) return true;
  const t = m.text ?? "";
  return t.startsWith(CHAIN_TAG_PREFIX) || t.includes(SUMMARY_MARKER);
}

function isSummaryCarrier(m: CoreMessage): boolean {
  if (m.summaryOfBlockId !== undefined) return true;
  const t = m.text ?? "";
  return t.includes(SUMMARY_MARKER) || m.id.startsWith("acp_summary");
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

// #4186 G2: CCR-stored tool results ride outbound as canonical placeholders
// while the inbound twin is still the client's full text. Recognized via the
// kernel's STRICT whole-body parser (#1456 discipline) — never a substring scan.
function isCcrStoredResult(m: CoreMessage): boolean {
  return m.contentType === "tool-result" && parseStoredPlaceholder(m.text ?? "") !== null;
}

// #4186 G3: emergency truncation (kernel truncateLargeToolOutputs) clips an old
// message to prefix + marker line + suffix. Marker line shape mirrors
// kernel/src/truncate-tools.ts:109 — the token blurb after the marker may drift,
// the "...[truncated for context space]..." line does not. Non-global on purpose:
// at most one marker per message (the kernel skips already-truncated text).
const TRUNCATION_LINE_RE = /\n\.\.\.\[truncated for context space\][^\n]*\n/;

function isTruncationExit(m: CoreMessage): boolean {
  return TRUNCATION_LINE_RE.test(m.text ?? "");
}

// Directional structural proof that b is the sanctioned clip of a: b must be
// prefix(a) + marker + suffix(a), strictly shorter. A fabricated or rewritten
// body containing the marker fails the containment check and stays flagged.
function isTruncatedTwin(a: CoreMessage, b: CoreMessage): boolean {
  const bt = b.text ?? "";
  const m = TRUNCATION_LINE_RE.exec(bt);
  if (!m) return false;
  const at = a.text ?? "";
  if (!at || at.length <= bt.length) return false;
  const strip = (s: string): string => s.replace(RENDER_TAG_RE, "").trim();
  const pre = strip(bt.slice(0, m.index));
  const post = strip(bt.slice(m.index + m[0].length));
  const na = strip(at);
  return pre.length > 0 && post.length > 0 && na.startsWith(pre) && na.endsWith(post);
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
  if (a.contentType === "tool-result" && isCcrStoredResult(b)) return true; // #4186 G2
  if (isTruncatedTwin(a, b)) return true; // #4186 G3
  return normText(a) === normText(b);
}

// Lockstep with isMcpBiliCompress (src/config.ts, #2970/#3222): canonical bare
// form + MCP dialect form only. Inlined (not imported) so the judge stays a
// leaf — pure, no I/O, no config dependency.
function isCompressToolName(toolName: string | undefined): boolean {
  return toolName === "compress" || toolName === "mcp__bili__compress";
}

interface PairingState {
  /** ids declared by a tool-call but never answered by a later same-id result. */
  unansweredCallIds: Set<string>;
  /** ids carried by a tool-result but never declared by an earlier same-id call. */
  unopenedResultIds: Set<string>;
}

// Directional pairing walk, kernel-parity (kernel/src/prune.ts
// stripOrphanedToolResults / stripOrphanedToolCalls, #3046): a result is valid
// iff some call with the same id sits EARLIER; a call is valid iff some result
// with the same id sits LATER. Precedence-only — one call answers any number of
// same-id results and vice versa (Agent Teams `name:index` id reuse).
function pairingState(msgs: readonly CoreMessage[]): PairingState {
  const opened = new Set<string>();
  const unopenedResultIds = new Set<string>();
  for (const m of msgs) {
    if (m.contentType === "tool-call" && m.toolCallId) opened.add(m.toolCallId);
    else if (m.contentType === "tool-result" && m.toolCallId && !opened.has(m.toolCallId)) unopenedResultIds.add(m.toolCallId);
  }
  const answered = new Set<string>();
  const unansweredCallIds = new Set<string>();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.contentType === "tool-result" && m.toolCallId) answered.add(m.toolCallId);
    else if (m.contentType === "tool-call" && m.toolCallId && !answered.has(m.toolCallId)) unansweredCallIds.add(m.toolCallId);
  }
  return { unansweredCallIds, unopenedResultIds };
}

// #4862 I3: egress pairing — see header. Exit-internal, so it applies to every
// mode (legacy full-inbound, render-lane tail) and every lane (main first-send,
// loop rounds 2+): no prefix, rendered or frozen, is exempt from protocol
// soundness. Attribution scoping via the entry pairing state keeps the judge's
// "whose fault" charter: ids the client held paired (or never sent — id
// re-minting renames BOTH halves, #2821, so a re-minted half-pair still fires)
// become bili's the moment the exit ships one side of them alone.
function egressPairingViolations(entry: readonly CoreMessage[], exit: readonly CoreMessage[]): Violation[] {
  const client = pairingState(entry);
  const egress = pairingState(exit);
  const out: Violation[] = [];
  const countUnanswered = (msgs: readonly CoreMessage[], st: PairingState): number =>
    msgs.filter((m) => m.contentType === "tool-call" && m.toolCallId && st.unansweredCallIds.has(m.toolCallId) && !isCompressToolName(m.toolName)).length;
  // Volume guard (#2821): a host that itself ships a half-pair and then has
  // the id re-minted on projection produces exit-unpaired ids the entry never
  // named — per-id indistinguishable from a re-minted pair bili broke. Volume
  // arbitrates: bili can only be at fault for the EXCESS of unanswered calls it
  // ships over the ones the client sent.
  if (countUnanswered(exit, egress) > countUnanswered(entry, client)) {
    exit.forEach((m, i) => {
      if (m.contentType !== "tool-call" || !m.toolCallId || !egress.unansweredCallIds.has(m.toolCallId)) return;
      if (isCompressToolName(m.toolName)) return; // kernel parity: hideConsumedCompressCalls owns these results
      if (client.unansweredCallIds.has(m.toolCallId)) return; // host-sent broken, not ours to flag
      out.push({ kind: "unpaired-tool-call", index: i, detail: `outbound[${i}] tool-call #${m.toolCallId}${m.toolName ? ` (${m.toolName})` : ""} has no same-id tool-result after it — upstream rejects half-pairs with a 400 (#4862)` });
    });
  }
  const countUnopened = (msgs: readonly CoreMessage[], st: PairingState): number =>
    msgs.filter((m) => m.contentType === "tool-result" && m.toolCallId && st.unopenedResultIds.has(m.toolCallId)).length;
  if (countUnopened(exit, egress) > countUnopened(entry, client)) {
    exit.forEach((m, i) => {
      if (m.contentType !== "tool-result" || !m.toolCallId || !egress.unopenedResultIds.has(m.toolCallId)) return;
      if (client.unopenedResultIds.has(m.toolCallId)) return; // host-sent broken, not ours to flag
      out.push({ kind: "unpaired-tool-result", index: i, detail: `outbound[${i}] tool-result #${m.toolCallId} has no same-id tool-call before it — upstream rejects half-pairs with a 400 (#4862)` });
    });
  }
  return out;
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
  const violations: Violation[] = [];
  let matched = 0;
  let total = 0;

  // The fold point is the first summary carrier; everything before it is the
  // frozen prefix (must match), everything from it on is the fold/tail (free).
  const sumIdx = exit.findIndex(isSummaryCarrier);
  const folded = sumIdx !== -1;
  const freezeEnd = folded ? sumIdx : exit.length;
  let foldStart = -1;

  // #4241 render-lane tail-fidelity: when THIS turn's outbound prefix was
  // server-rendered (snapshot render active), the raw inbound prefix is NOT a
  // valid baseline — the engine intentionally replaced the covered region with
  // transcript rows + summary carriers (defined behavior, not a rewrite). Only
  // the client tail (entry[rts..]) is promised byte-intact, so validate exactly
  // that, in order; the rendered prefix is exempt from the frozen-prefix rule.
  // A real tail corruption/drop/reorder still goes red — I2 stays armed on the
  // part the render owns verbatim. Cross-turn prefix stability is seamLcp's /
  // shadow's job (outbound-vs-previous-outbound), not this inbound-vs-outbound.
  const rts = opts.renderTailStart;
  const renderLane = typeof rts === "number" && Number.isFinite(rts) && rts >= 0;

  let j = 0;
  if (renderLane) {
    let located = false; // have we matched at least one tail message yet?
    for (let i = rts!; i < entry.length; i++) {
      const e = entry[i];
      if (isReasoning(e)) continue;
      total++;
      const eCarrier = isCarrier(e);
      let found = -1;
      let nearTwin = false;
      let scanned = 0;
      // Until the tail is located, the scan spans the whole outbound (it must
      // cross the entire server-rendered prefix); once located, tail messages
      // are contiguous and the normal carrier-gap budget applies again.
      const cap = located ? maxGap : Number.POSITIVE_INFINITY;
      for (let k = j; k < exit.length; k++) {
        const x = exit[k];
        if (isReasoning(x)) continue;
        if (!eCarrier && isCarrier(x)) continue;
        scanned++;
        if (scanned > cap) break;
        if (stableEqual(e, x)) { found = k; break; }
        if (x.role === e.role && x.contentType === e.contentType && (!e.toolCallId || !x.toolCallId || x.toolCallId === e.toolCallId)) nearTwin = true;
      }
      if (found < 0) {
        violations.push({ kind: nearTwin ? "mid-history-rewrite" : "mid-history-drop", index: i, detail: `tail inbound[${i}] ${fp(e)} absent from outbound` });
        j++; // soft resync: one bad cell must not cascade into a total unfold (#2821)
        continue;
      }
      // Insertions count only AFTER the tail is located — the server prefix
      // before the first match is legitimately present, never an insertion.
      if (located) {
        for (let k = j; k < found; k++) {
          const x = exit[k];
          if (!isCarrier(x) && !isReasoning(x)) {
            violations.push({ kind: "mid-insertion", index: i, detail: `unexplained outbound element before tail inbound[${i}]: ${fp(x)}` });
          }
        }
      }
      matched++;
      j = found + 1;
      located = true;
    }
    foldStart = rts! > 0 ? 0 : -1;
  } else {
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
  }

  // The named exemptions are COUNT-BOUNDED (#3842): the ledger is the whole
  // outbound exempt volume (carriers + policy reasoning drops + crush
  // envelopes), independent of matching — a defect mass-producing exempt-
  // looking elements surfaces even when every stable message matched.
  const carrierExempt = exit.filter(isCarrier).length;
  const reasoningExempt = exit.filter(isReasoning).length;
  const crushExempt = exit.filter(isCrushedToolResult).length;
  const ccrExempt = exit.filter(isCcrStoredResult).length;
  const truncateExempt = exit.filter(isTruncationExit).length;
  const exemptTotal = carrierExempt + reasoningExempt + crushExempt + ccrExempt + truncateExempt;
  if (exemptTotal > maxExempt) {
    violations.push({
      kind: "exemption-overflow",
      index: -1,
      detail: `named-exemption volume ${exemptTotal} exceeds cap ${maxExempt} (carrier=${carrierExempt} reasoning=${reasoningExempt} crush=${crushExempt} ccr=${ccrExempt} truncate=${truncateExempt})`,
    });
  }

  // #4862 I3: egress pairing is exit-internal and fold-split agnostic — the
  // folded region stops being a free zone for protocol structure.
  violations.push(...egressPairingViolations(entry, exit));

  return {
    ok: violations.length === 0,
    folded,
    ...(folded && foldStart >= 0 ? { foldStart } : {}),
    matched,
    total,
    violations,
    exempt: { carrier: carrierExempt, reasoning: reasoningExempt, crush: crushExempt, ccr: ccrExempt, truncate: truncateExempt },
    ...(renderLane ? { renderLane: true } : {}),
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
  /** #4241: set when prepare's snapshot render served this turn's outbound prefix —
   *  the first client index of the live tail; the judge then validates only that
   *  suffix against the outbound (the rendered prefix is exempt). Absent ⇒ legacy. */
  renderTailStart?: number;
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
      // #4862: label by the invariant that actually fired — an I3 pairing
      // violation on a non-folded request must not read as "I1".
      const inv = head.kind === "unpaired-tool-call" || head.kind === "unpaired-tool-result" ? 3 : v.folded ? 2 : 1;
      loggerLog("warn", `${where} I${inv} violation: ${head.kind} @${head.index} — ${head.detail} (${v.violations.length} finding(s), matched ${v.matched}/${v.total}${v.exempt ? `, exempt carrier=${v.exempt.carrier} reasoning=${v.exempt.reasoning} crush=${v.exempt.crush} ccr=${v.exempt.ccr} truncate=${v.exempt.truncate}` : ``})`);
    } else {
      loggerLog("debug", `${where} clean ${v.folded ? "fold" : "growth"} verdict: matched ${v.matched}/${v.total}${v.exempt ? `, exempt carrier=${v.exempt.carrier} reasoning=${v.exempt.reasoning} crush=${v.exempt.crush} ccr=${v.exempt.ccr} truncate=${v.exempt.truncate}` : ``}`);
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
    const v = judgeInboundOutbound(entry, exitCores, { renderTailStart: input.renderTailStart });
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
