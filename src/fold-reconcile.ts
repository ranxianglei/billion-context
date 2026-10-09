// [#1921] Fold-state reconciliation.
//
// The compression fold identifies messages by CONTENT hash (kernel
// deriveMessageId: sha256 over role+contentType+toolCallId+toolName+text, plus
// a within-pass cluster suffix for duplicates). That identity is exact-match
// only: when a client re-serializes its stored history (agent restart/resume,
// tool_result re-encoding, whitespace churn), every churned message's hash
// changes, the fold's covered ids stop matching, and the ORIGINALS silently
// re-enter the wire unfolded while the summaries stay — the #1908 death
// spiral. Up to now the drift was only observed (#1195 WARN), never repaired.
//
// This module adds the reconciliation layer: on every resent history it
//   1. anchors the old and new pass on exact-id prefix/suffix runs,
//   2. matches each MISSING covered id against an inbound candidate via
//      a) its protocol-stable toolCallId (tool_use.id survives re-serialization), or
//      b) its normalized identity (NFC + whitespace-collapsed text equality,
//         k-th occurrence to k-th occurrence inside the churn region — the
//         same discipline the kernel's cluster suffix uses, but at a
//         normalization level that formatting churn cannot disturb),
//   3. in "repair" mode rewrites the fold blocks' effective/direct message ids
//      old→new, so syncBlocks/prune see the churned messages as covered again.
//
// Anything that does not match (real edits, deletions, new content) stays
// unmatched and honestly re-enters the wire unfolded, exactly as before.
// Matching is deliberately conservative: a claim requires either a
// protocol-unique tool id or full normalized-text equality at the same
// duplicate-ordinal inside the aligned churn region — never fuzzy similarity.
//
// A third signal is DETECTION-ONLY (#2396): a host may REWRITE authoritative
// tool-call ids itself (a provider projection re-sanitizing stored composite
// ids — Prime switching one conversation from Codex to a foreign Responses
// provider turned call_x|fc_0 into call_x_fc_0 on both sides of every pair).
// That defeats both claim passes by construction, because both key on the
// toolCallId. Pairing old→new without host knowledge would be guessing, and
// misattribution is the expensive failure mode (MESSAGE-IDENTITY.md), so the
// pass only COUNTS such cases (an inbound twin with identical normalized
// content under a different toolCallId) and the drift log line names the
// cause instead of reading as "mutation or deletion".
//
// Modes (config `compress.reconcile`, env BILI_FOLD_RECONCILE):
//   "off"    — disabled (pre-#1921 behavior).
//   "warn"   — compute + log only, no rewrite.
//   "repair" — rewrite block ids (default).
import { createHash } from "node:crypto";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "./session.js";

type FoldReconcileMode = "off" | "warn" | "repair";

const METADATA_ANCHORS = "foldAnchors";
const METADATA_ORDER = "foldAnchorOrder";
/** #1921: last-noted system-prompt fingerprint ({fp, size}), consumed by both
 *  the fold-reconcile drift alert and the cache ledger's prompt-rewrite
 *  attribution (#2350). */
export const METADATA_SYSTEM_FP = "systemFp";
/** Anchors are only kept for covered ids; 16k covered messages is far beyond
 *  any folded session, the cap only bounds pathological metadata. */
const MAX_ANCHORS = 16384;
/** Full-pass id order kept as the alignment backbone (oldest dropped beyond
 *  the cap — alignment is content-addressed, so a trimmed head only shifts
 *  where the exact-prefix run starts). */
const MAX_ORDER = 32768;
const METADATA_DRIFT_STREAK = "foldDriftStreak";
const METADATA_DRIFT_SINCE = "foldDriftSince";
/** Exported so the compress-failure receipt can sharpen its cause label into
 *  the substrate-destruction verdict (#2360 §2.4) without hardcoding a second
 *  copy of the key here. */
export const METADATA_DRIFT_ESCALATED = "foldDriftEscalated";
/** #2193: total-loss drift (covered ids missing with ZERO reanchoring) across
 *  this many consecutive passes means the fold state can never recover —
 *  escalate once from warn to error and name the suspect cause instead of
 *  letting the same warn print hundreds of times. */
const FOLD_DRIFT_ESCALATE_PASSES = 3;
/** Below this many permanently-missing ids the loss is small enough (a few
 *  edited/deleted messages) to stay at warn level. */
const FOLD_DRIFT_ESCALATE_MIN_UNMATCHED = 10;
/** #2202: per-block coverage evidence, consumed by the cache ledger's
 *  conditional avoided-token accrual (src/cache-ledger.ts). */
export const METADATA_FOLD_COVERAGE = "foldCoverageByBlock";
/** #2202: passes carrying fewer inbound messages than this are auxiliary
 *  side-requests (#1075: title-gen / WebSearch refinement "carry only a
 *  handful of brand-new messages") — no drift evidence is taken from them.
 *  Same value as REWRITE_MIN_INCOMING_TOTAL (src/session.ts), which the #1195
 *  sibling warn guards with; kept local so this module stays dependency-free
 *  beyond its type import. */
const SIDE_REQUEST_MAX_MSGS = 10;

/** #2193 follow-up: clear the drift-episode state. The main path resets it on
 *  every non-total-loss pass; the early exits of reconcileFoldCoverage must do
 *  the same, or a stale foldDriftStreak survives an episode boundary (all fold
 *  blocks archived away, reconcile toggled off) and inflates the next episode's
 *  consecutive-pass count — the error line would claim more passes than the
 *  episode actually had. */
function resetFoldDriftState(session: Session): void {
    const md = session.metadata;
    if (!md) return;
    delete md[METADATA_DRIFT_STREAK];
    delete md[METADATA_DRIFT_SINCE];
    delete md[METADATA_DRIFT_ESCALATED];
}

/** Per-covered-id anchor recorded from the last pass in which the id was seen.
 *  Stored in session.metadata.foldAnchors (persisted, free-form field). */
export interface FoldAnchor {
    /** sha256-16 of role\0contentType\0toolName\0toolCallId\0normalizedText. */
    n: string;
    /** #2396: sha256-16 of role\0contentType\0toolName\0normalizedText (no
     *  toolCallId) — set alongside `t`; pairs a missing id with an inbound
     *  twin whose only difference is a rewritten toolCallId. Anchors
     *  persisted before #2396 lack it and are backfilled while their bytes
     *  are still on the wire (see the seed loop below). */
    m?: string;
    /** Message role at anchor time (tool-claim cross-check). */
    r?: string;
    /** Protocol-stable tool id (tool_use.id / tool_call_id) when present. */
    t?: string;
    /** Length of the anchor-time text — collision guard for norm claims. */
    b: number;
    /** #2454: protocol-invariant canonical fingerprint for tool calls/results —
     *  sha256-16 of role\0toolName\0canonicalArgs, EXCLUDING the protocol-volatile
     *  toolCallId and arg/result serialization. Lets a cross-protocol switch
     *  (openai↔anthropic↔…) re-anchor a covered tool message whose exact id AND
      *  normalized identity both drifted while its logical (name, args) is intact.
      *  Undefined for non-tool messages and anchors persisted before this field. */
     c?: string;
     /** #2454/#2396 boundary: raw-bytes tool fingerprint — sha256-16 of
      *  role\0contentType\0toolName\0RAW-text (no toolCallId, NO normalization).
      *  Unlike `c` (logical args) and `m` (normalized text), it is sensitive to
      *  the exact bytes a codec switch changes, so pass 3 uses it to tell a host
      *  id-rewrite (bytes identical, only the id changed → defer to #2396) from a
      *  cross-protocol re-serialization (bytes differ → reclaim). Undefined for
      *  non-tool messages and anchors persisted before this field. */
     h?: string;
 }

interface ReconciliationPlan {
    /** old covered id → new inbound id it was matched to. */
    claims: Map<string, string>;
    byTool: number;
    byNorm: number;
    byCanon: number;
    /** Covered ids missing from the resent history with no match — either
     *  mutation (originals re-enter the wire unfolded) or benign client-side
     *  deletion/truncation (originals no longer on the wire) (#2297/#1195). */
    unmatched: string[];
    /** #2396: subset of `unmatched` whose anchor (no-toolCallId norm) matches
     *  an unclaimed inbound twin carrying a different toolCallId — suspected
     *  host-side rewrite of authoritative tool-call ids across provider
     *  projections. Detection only: never claimed, never repaired. */
    idRewriteSuspects: number;
}

interface FoldReconcileResult {
    kind: "off" | "noop" | "resend" | "reanchored" | "unmatched";
    missing: number;
    claims: number;
    byTool: number;
    byNorm: number;
    byCanon: number;
    unmatched: number;
}

/** #2202: last qualifying pass's per-block coverage evidence — how much of the
 *  block's covered set is still on the resent wire. The cache ledger books a
 *  fold's avoided tokens as (S−σ)×requestsAfter and may only grow that counter
 *  while the covered bytes are actually still being spared; this record is the
 *  cross-check that conditions the accrual (src/cache-ledger.ts). */
export interface FoldBlockCoverage {
    /** Covered ids present verbatim in the pass. */
    p: number;
    /** Covered ids reclaimed via reanchor onto churned bytes in the pass
     *  (still spared — honest coverage, not loss). */
    r: number;
    /** Total covered ids of the block when recorded. */
    t: number;
    /** 1 once ANY covered id was observed present-or-reclaimed since tracking
     *  began. Distinguishes VERIFIED loss (was present, now gone → freeze the
     *  accrual) from structural absence (view-folding hosts whose resends never
     *  carry raw originals → unverifiable, keep status-quo booking). */
    e?: 1;
}

const seenInvalidEnv = new Set<string>();

export function resolveFoldReconcileMode(env: NodeJS.ProcessEnv, configured?: FoldReconcileMode): FoldReconcileMode {
    const raw = env.BILI_FOLD_RECONCILE;
    if (raw !== undefined && raw !== "") {
        if (raw === "off" || raw === "warn" || raw === "repair") return raw;
        if (!seenInvalidEnv.has(raw)) {
            seenInvalidEnv.add(raw);
            // Never fatal: an operator typo must not take the proxy down.
            console.warn(`[fold-reconcile] ignoring invalid BILI_FOLD_RECONCILE="${raw}" (expected off|warn|repair)`);
        }
    }
    if (configured === "off" || configured === "warn" || configured === "repair") return configured;
    return "repair";
}

/** Normalization that formatting-level churn (CRLF, trailing spaces, blank
 *  line runs, unicode composition) cannot disturb — but real edits can. */
export function normalizeMessageText(text: string | undefined): string {
    if (text === undefined || text === "") return "";
    return text
        .normalize("NFC")
        .replace(/\r\n?/g, "\n")
        .replace(/[^\S\n]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim();
}

/** #2334: full-text normalized-identity computations performed by this module
 *  (anchor seeding/rebuild + churn-region candidate norms). A measurement seam
 *  for the work-count pins in tests/fold-reconcile.test.ts — the over-cap
 *  defect paid O(overflow) normalizations per steady-state pass while returning
 *  byte-identical results, so wall-clock thresholds alone cannot prove the work
 *  is gone. */
let normalizedIdentityWork = 0;
export function resetNormalizedIdentityWork(): void {
    normalizedIdentityWork = 0;
}
export function normalizedIdentityWorkCount(): number {
    return normalizedIdentityWork;
}

export function normalizedIdentity(message: CoreMessage): string {
    normalizedIdentityWork++;
    const h = createHash("sha256");
    h.update(`${message.role}\u0000${message.contentType}\u0000${message.toolName ?? ""}\u0000${message.toolCallId ?? ""}\u0000${normalizeMessageText(message.text)}`);
    return h.digest("hex").slice(0, 16);
}

/** #2396: normalized identity with the toolCallId factor removed — pairs a
 *  message with an inbound twin carrying identical content under a rewritten
 *  tool-call id. Same work-count seam as normalizedIdentity (#2334). */
export function normalizedIdentityNoToolCallId(message: CoreMessage): string {
    normalizedIdentityWork++;
    const h = createHash("sha256");
    h.update(`${message.role}\u0000${message.contentType}\u0000${message.toolName ?? ""}\u0000${normalizeMessageText(message.text)}`);
    return h.digest("hex").slice(0, 16);
}

/** #2454: parse-normalize a tool payload into a deterministic byte form. JSON
 *  values collapse via recursive key-sort (so openai's raw `arguments` string
 *  and anthropic's safeStringify(input) of the SAME object agree); non-JSON text
 *  (typical tool RESULTS: raw command/file output) falls back to whitespace+
 *  unicode normalization. */
export function canonicalArgs(text: string | undefined): string {
    const t = text ?? "";
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { parsed = undefined; }
    if (t !== "" && parsed !== null && typeof parsed === "object") return canonicalJson(parsed);
    return normalizeMessageText(t);
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${parts.join(",")}}`;
}

/** #2454: protocol-invariant identity for a tool call (role assistant + toolName)
 *  or result (role tool). Excludes toolCallId (call_ vs toolu_) and contentType
 *  (literals differ per codec) so it is stable across a codec switch; returns
 *  undefined for non-tool messages. */
export function canonicalToolFingerprint(message: CoreMessage): string | undefined {
    const isCall = message.toolName !== undefined && message.toolName !== "";
    const isResult = message.role === "tool";
    if (!isCall && !isResult) return undefined;
    const h = createHash("sha256");
    h.update(`${message.role}\u0000${message.toolName ?? ""}\u0000${canonicalArgs(message.text)}`);
    return h.digest("hex").slice(0, 16);
}

/** #2454/#2396 boundary: raw-bytes identity for a tool call/result — same tool
 *  predicate as canonicalToolFingerprint but over the EXACT bytes (role,
 *  contentType, toolName, un-normalized text; no toolCallId). Sensitive to the
 *  serialization a codec switch changes, unlike `c`/`m`; plain createHash so it
 *  adds no normalizedIdentityWork. Lets pass 3 defer byte-identical host id-
 *  rewrites (same fp) to the #2396 detector while still reclaiming cross-protocol
 *  drift (different fp). */
export function rawToolFingerprint(message: CoreMessage): string | undefined {
    const isCall = message.toolName !== undefined && message.toolName !== "";
    const isResult = message.role === "tool";
    if (!isCall && !isResult) return undefined;
    const h = createHash("sha256");
    h.update(`${message.role}\u0000${message.contentType}\u0000${message.toolName ?? ""}\u0000${message.text ?? ""}`);
    return h.digest("hex").slice(0, 16);
}

function anchorFrom(message: CoreMessage): FoldAnchor {
    const t = message.toolCallId !== undefined && message.toolCallId !== "" ? message.toolCallId : undefined;
    const anchor: FoldAnchor = { n: normalizedIdentity(message), r: message.role, b: message.text?.length ?? 0 };
    if (t !== undefined) {
        anchor.t = t;
        anchor.m = normalizedIdentityNoToolCallId(message);
    }
    const c = canonicalToolFingerprint(message);
    if (c !== undefined) anchor.c = c;
    const h = rawToolFingerprint(message);
    if (h !== undefined) anchor.h = h;
    return anchor;
}

interface BlockLike {
    blockId?: string;
    active?: boolean;
    effectiveMessageIds?: string[];
    directMessageIds?: string[];
}

/** #2297: only LIVE blocks count as covered. The kernel deactivates a block
 *  (consumed into a newer fold, host-expanded, or drifted out of the resent
 *  history) by setting active=false while KEEPING its effectiveMessageIds —
 *  those dead-lineage ids can never re-anchor and would sit in `missing`
 *  permanently, inflating the drift warn ~2x (#2293). Same caliber as the
 *  #1195 pre-turn snapshot. */
function coveredIdsOf(blocks: BlockLike[]): Set<string> {
    const covered = new Set<string>();
    for (const block of blocks) {
        if (!block.active) continue;
        for (const id of block.effectiveMessageIds ?? []) covered.add(id);
    }
    return covered;
}

/** Pure core: plan the reconciliation between the previous pass order and the
 *  incoming messages. Exposed for unit tests. */
export function planReconciliation(
    oldOrder: string[],
    anchors: Record<string, FoldAnchor>,
    msgs: CoreMessage[],
    covered: Set<string>,
): ReconciliationPlan {
    const plan: ReconciliationPlan = { claims: new Map(), byTool: 0, byNorm: 0, byCanon: 0, unmatched: [], idRewriteSuspects: 0 };
    const newOrder: string[] = [];
    const byId = new Map<string, CoreMessage>();
    for (const m of msgs) {
        if (m.id === undefined) continue;
        newOrder.push(m.id);
        byId.set(m.id, m);
    }
    const missing: string[] = [];
    const missingSet = new Set<string>();
    for (const id of covered) {
        if (!byId.has(id)) {
            missing.push(id);
            missingSet.add(id);
        }
    }
    if (missing.length === 0) return plan;

    // Anchor the neighborhoods: longest exact-id run from the head and from
    // the tail. Churn is local in practice (a re-serialized block, an edited
    // message), so the middles stay small; appended turns sit after the old
    // tail and simply fail suffix matching at their first element.
    let prefix = 0;
    while (prefix < oldOrder.length && prefix < newOrder.length && oldOrder[prefix] === newOrder[prefix]) prefix++;
    let suffix = 0;
    while (
        suffix < oldOrder.length - prefix && suffix < newOrder.length - prefix &&
        oldOrder[oldOrder.length - 1 - suffix] === newOrder[newOrder.length - 1 - suffix]
    ) suffix++;

    // Candidates: inbound messages inside the churn region whose id is not
    // already covered (covered-present ids are exact matches of other old ids
    // and must not be claimed twice).
    // #2334: norms are computed LAZILY — pass 1 (toolCallId) never needs them,
    // so a fully tool-claimable churn region pays zero normalizations; pass 2
    // computes each norm once, only for the candidates pass 1 left behind.
    const candidates: { id: string; message: CoreMessage; norm?: string }[] = [];
    for (let i = prefix; i < newOrder.length - suffix; i++) {
        const id = newOrder[i];
        if (covered.has(id)) continue;
        const message = byId.get(id);
        if (message === undefined) continue;
        candidates.push({ id, message });
    }
    const claimedCandidates = new Set<string>();

    // Missing covered ids inside the churn region, in previous-pass order.
    const missingMiddle: string[] = [];
    for (let i = prefix; i < oldOrder.length - suffix; i++) {
        const id = oldOrder[i];
        if (missingSet.has(id)) missingMiddle.push(id);
    }

    // Pass 1 — tool anchors. tool_use.id / tool_call_id are protocol-unique
    // per conversation and survive client re-serialization verbatim; a unique
    // unclaimed candidate with the same toolCallId and role is the same
    // message with rewritten bytes. No length guard: the protocol id is
    // authoritative (clients may legitimately re-encode tool_result content).
    if (missingMiddle.length > 0 && candidates.length > 0) {
        const byToolCallId = new Map<string, typeof candidates>();
        for (const cand of candidates) {
            const t = cand.message.toolCallId;
            if (t === undefined || t === "") continue;
            const bucket = byToolCallId.get(t);
            if (bucket === undefined) byToolCallId.set(t, [cand]);
            else bucket.push(cand);
        }
        for (const oldId of missingMiddle) {
            const anchor = anchors[oldId];
            if (anchor === undefined || anchor.t === undefined || anchor.r === undefined) continue;
            const bucket = byToolCallId.get(anchor.t);
            if (bucket === undefined) continue;
            const usable = bucket.filter((c) => !claimedCandidates.has(c.id) && c.message.role === anchor.r);
            if (usable.length !== 1) continue; // ambiguous or exhausted → skip
            plan.claims.set(oldId, usable[0].id);
            claimedCandidates.add(usable[0].id);
            plan.byTool++;
        }
    }

    // Pass 2 — normalized identity, k-th occurrence to k-th occurrence inside
    // the churn region (duplicate-cluster discipline at the normalized level:
    // deleting one of N identical messages shifts the survivors together, and
    // order-preserving pairing claims exactly the survivors, leaving the
    // deleted one unmatched — which is correct, it is not on the wire).
    const normGroups = new Map<string, { ids: string[]; anchors: FoldAnchor[] }>();
    for (const cand of candidates) {
        if (claimedCandidates.has(cand.id)) continue;
        const norm = cand.norm ?? (cand.norm = normalizedIdentity(cand.message));
        const g = normGroups.get(norm);
        if (g === undefined) normGroups.set(norm, { ids: [cand.id], anchors: [] });
        else g.ids.push(cand.id);
    }
    for (const oldId of missingMiddle) {
        if (plan.claims.has(oldId)) continue;
        const anchor = anchors[oldId];
        if (anchor === undefined) continue;
        const g = normGroups.get(anchor.n);
        if (g === undefined) continue;
        if (g.anchors.length >= g.ids.length) continue;
        const newId = g.ids[g.anchors.length];
        const message = byId.get(newId);
        if (message === undefined) continue;
        // Collision guard: normalized equality at a hash slice plus a sane
        // length ratio — reformatting cannot move length by 4x.
        const len = message.text?.length ?? 0;
        if (Math.abs(len - anchor.b) > Math.max(256, anchor.b >> 2)) continue;
        g.anchors.push(anchor);
        plan.claims.set(oldId, newId);
        claimedCandidates.add(newId);
        plan.byNorm++;
    }

    // Pass 3 — #2454 cross-protocol canonical fingerprint. A codec switch
    // (openai↔anthropic↔…) re-serializes tool calls/results so BOTH the exact
    // id (toolCallId scheme call_ vs toolu_) AND normalizedIdentity (which embeds
    // toolCallId + raw arg bytes) drift, while the logical (role, toolName,
    // args-object) is unchanged. Re-anchor such a covered tool message onto the
    // positionally-aligned candidate sharing its canonical fingerprint. Fires
    // only after passes 1-2 left the id unmatched and only for tool messages
    // (anchor.c set): prose keeps exact/norm-only matching, and a REAL edit
    // (different args → different fingerprint) stays unmatched. Same k-th→k-th
    // occurrence discipline + length-ratio guard as pass 2.
    if (missingMiddle.length > 0 && candidates.length > 0) {
        const canonGroups = new Map<string, string[]>();
        for (const cand of candidates) {
            if (claimedCandidates.has(cand.id)) continue;
            const fp = canonicalToolFingerprint(cand.message);
            if (fp === undefined) continue;
            const g = canonGroups.get(fp);
            if (g === undefined) canonGroups.set(fp, [cand.id]);
            else g.push(cand.id);
        }
        const canonUsed = new Map<string, number>();
        for (const oldId of missingMiddle) {
            if (plan.claims.has(oldId)) continue;
            const anchor = anchors[oldId];
            if (anchor === undefined || anchor.c === undefined) continue;
            const g = canonGroups.get(anchor.c);
            if (g === undefined) continue;
            const used = canonUsed.get(anchor.c) ?? 0;
            if (used >= g.length) continue;
            const newId = g[used];
            const message = byId.get(newId);
            if (message === undefined) continue;
            const len = message.text?.length ?? 0;
            if (Math.abs(len - anchor.b) > Math.max(256, anchor.b >> 2)) continue;
            // #2396 boundary: a raw-byte-identical twin (same rawToolFingerprint)
            // is a host tool-call-id REWRITE, not a codec switch — pairing it
            // without host knowledge is guessing (misattribution is the expensive
            // failure mode), so defer it to the detection-only pass below.
            if (anchor.h !== undefined && rawToolFingerprint(message) === anchor.h) continue;
            canonUsed.set(anchor.c, used + 1);
            plan.claims.set(oldId, newId);
            claimedCandidates.add(newId);
            plan.byCanon++;
        }
    }

    for (const id of missing) {
        if (!plan.claims.has(id)) plan.unmatched.push(id);
    }

    // #2396 — detection-only rewrite suspects. Both claim passes key on the
    // toolCallId itself, so a host that rewrites authoritative tool-call ids
    // defeats them by construction; pairing old→new without host knowledge
    // would be guessing (misattribution is the expensive failure mode). Cost:
    // one no-toolCallId norm per unclaimed candidate carrying a toolCallId,
    // drift passes only — steady state early-returns above (#2334 discipline).
    if (plan.unmatched.length > 0) {
        const noToolWitnesses = new Map<string, string[]>();
        for (const cand of candidates) {
            if (claimedCandidates.has(cand.id)) continue;
            const t = cand.message.toolCallId;
            if (t === undefined || t === "") continue;
            const nt = normalizedIdentityNoToolCallId(cand.message);
            const bucket = noToolWitnesses.get(nt);
            if (bucket === undefined) noToolWitnesses.set(nt, [t]);
            else bucket.push(t);
        }
        for (const id of plan.unmatched) {
            const anchor = anchors[id];
            if (anchor === undefined || anchor.m === undefined || anchor.t === undefined) continue;
            const witnesses = noToolWitnesses.get(anchor.m);
            if (witnesses === undefined) continue;
            if (witnesses.some((w) => w !== anchor.t)) plan.idRewriteSuspects++;
        }
    }
    return plan;
}

function rewriteBlocks(blocks: BlockLike[], claims: Map<string, string>): boolean {
    if (claims.size === 0) return false;
    let touched = false;
    for (const block of blocks) {
        const lists = [block.effectiveMessageIds, block.directMessageIds] as (string[] | undefined)[];
        for (const list of lists) {
            if (list === undefined) continue;
            for (let i = 0; i < list.length; i++) {
                const replacement = claims.get(list[i]);
                if (replacement !== undefined) {
                    list[i] = replacement;
                    touched = true;
                }
            }
        }
    }
    return touched;
}

export interface ReconcileOptions {
    mode?: FoldReconcileMode;
    sessionId?: string;
    log?: (level: string, msg: string) => void;
}

/** Entry point wired into the four wire sites, immediately BEFORE the
 *  #1195 pre-turn snapshot (so the snapshot reflects reanchored ids and the
 *  drift WARN only reports the honest residual). */
export function reconcileFoldCoverage(session: Session, msgs: CoreMessage[], opts: ReconcileOptions = {}): FoldReconcileResult {
    const mode = opts.mode ?? resolveFoldReconcileMode(process.env);
    if (mode === "off") {
        resetFoldDriftState(session);
        return { kind: "off", missing: 0, claims: 0, byTool: 0, byNorm: 0, byCanon: 0, unmatched: 0 };
    }
    const blocks = (session.state?.blocks ?? []) as BlockLike[];
    const covered = coveredIdsOf(blocks);
    if (covered.size === 0) {
        resetFoldDriftState(session);
        return { kind: "noop", missing: 0, claims: 0, byTool: 0, byNorm: 0, byCanon: 0, unmatched: 0 };
    }
    // #2202: auxiliary side-requests (title-gen, WebSearch refinement — #1075)
    // share the conversation id but do not carry the conversation. Reconciling
    // one would roll the order backbone onto their few ids, so the NEXT real
    // pass anchors against the wrong tail: its missing covered ids land outside
    // the aligned churn region, skip both claim passes (which iterate the
    // middle only) and fall straight into unmatched — phantom total-loss that
    // would feed the #2193 drift streak and the #2202 coverage records. No
    // evidence is taken from such a pass; skipping is NOT recovery either, so
    // the episode state is left exactly as found (the resets above stay
    // reserved for true episode boundaries: reconcile off / no folds at all).
    if (msgs.length < SIDE_REQUEST_MAX_MSGS) {
        return { kind: "noop", missing: 0, claims: 0, byTool: 0, byNorm: 0, byCanon: 0, unmatched: 0 };
    }
    if (!session.metadata) return { kind: "noop", missing: 0, claims: 0, byTool: 0, byNorm: 0, byCanon: 0, unmatched: 0 };

    const anchors: Record<string, FoldAnchor> =
        (session.metadata[METADATA_ANCHORS] as Record<string, FoldAnchor> | undefined) ?? {};
    const oldOrder: string[] = (session.metadata[METADATA_ORDER] as string[] | undefined) ?? [];

    const plan = planReconciliation(oldOrder, anchors, msgs, covered);

    // Seed/refresh anchors for covered ids present in this pass (including
    // freshly claimed ones — the next churn must re-anchor from post-churn
    // bytes), prune anchors for ids no longer covered, and roll the order
    // backbone forward to this pass.
    const byId = new Map<string, CoreMessage>();
    for (const m of msgs) if (m.id !== undefined) byId.set(m.id, m);
    const nextAnchors: Record<string, FoldAnchor> = {};
    let anchorCount = 0;
    for (const id of covered) {
        // #2334: enforce the cap WHILE building. The old build-all-then-delete
        // form computed a full normalization + sha256 for every covered id and
        // discarded the overflow — and the discarded ids had no stored anchor
        // to reuse, so EVERY subsequent pass recomputed and dropped them again
        // (a 20k-id session paid 3616 wasted hashes per request). Breaking at
        // the cap keeps exactly the old survivor set (first MAX_ANCHORS in
        // covered order — the deletion loop removed precisely the tail) and the
        // key order; ids past the cap still get no anchor, as before.
        if (anchorCount >= MAX_ANCHORS) break;
        const claimed = plan.claims.get(id);
        if (claimed !== undefined) {
            const message = byId.get(claimed);
            if (message !== undefined) {
                nextAnchors[claimed] = anchorFrom(message);
                anchorCount++;
            }
            continue;
        }
        // An unchanged id means unchanged bytes (kernel deriveMessageId hashes
        // exactly the fields normalizedIdentity covers), so the stored anchor is
        // necessarily still valid — reuse it instead of re-normalizing +
        // re-hashing the full text every pass (#1930-2: keeps steady-state
        // rounds near-free on 8K-message histories).
        const prior = anchors[id];
        if (prior !== undefined) {
            // #2396: anchors persisted before the no-toolCallId norm existed lack
            // `m`; #2454: those persisted before FoldAnchor.c/h lacked them. Backfill
            // each while the bytes are still on the wire — one-time, subsequent
            // passes hit the fast path with the fields set. `m` rides the exact
            // anchorFrom rebuild (same-id ⇒ same identity fields); `c`/`h` are free
            // shallow patches (both fingerprints pay no normalizedIdentity work), so
            // non-tool / missing ids stay near-free (#1930-2/#2334 discipline).
            let next = prior;
            if (prior.t !== undefined && prior.m === undefined) {
                const message = byId.get(id);
                if (message !== undefined) next = anchorFrom(message);
            }
            if (next.c === undefined || next.h === undefined) {
                const m = byId.get(id);
                if (m !== undefined) {
                    const patch: Partial<FoldAnchor> = {};
                    if (next.c === undefined) {
                        const c = canonicalToolFingerprint(m);
                        if (c !== undefined) patch.c = c;
                    }
                    if (next.h === undefined) {
                        const h = rawToolFingerprint(m);
                        if (h !== undefined) patch.h = h;
                    }
                    if (patch.c !== undefined || patch.h !== undefined) next = { ...next, ...patch };
                }
            }
            nextAnchors[id] = next;
            anchorCount++;
            continue;
        }
        const message = byId.get(id);
        if (message !== undefined) {
            nextAnchors[id] = anchorFrom(message);
            anchorCount++;
        }
    }
    const nextOrder = msgs.map((m) => m.id).filter((id): id is string => id !== undefined).slice(-MAX_ORDER);

    // #2202: per-block coverage evidence for the ledger's conditional accrual
    // (METADATA_FOLD_COVERAGE). Present = verbatim on this pass's wire;
    // reclaimed = matched onto churned bytes (still spared — honest coverage).
    // Computed BEFORE the repair rewrite below so old ids classify against the
    // plan instead of post-rewrite bytes. The cumulative ever-present flag is
    // what lets the ledger tell verified loss from structural absence.
    const prevCov = (session.metadata[METADATA_FOLD_COVERAGE] as Record<string, FoldBlockCoverage> | undefined) ?? {};
    const nextCov: Record<string, FoldBlockCoverage> = {};
    let covCount = 0;
    for (const block of blocks) {
        const bid = block.blockId;
        if (bid === undefined || bid === "") continue;
        const ids = block.effectiveMessageIds ?? [];
        if (ids.length === 0) continue;
        let p = 0, r = 0;
        for (const id of ids) {
            if (byId.has(id)) p++;
            else if (plan.claims.has(id)) r++;
        }
        const rec: FoldBlockCoverage = { p, r, t: ids.length };
        if (prevCov[bid]?.e === 1 || p + r > 0) rec.e = 1;
        if (covCount >= MAX_ANCHORS) continue;
        nextCov[bid] = rec;
        covCount++;
    }
    session.metadata[METADATA_FOLD_COVERAGE] = nextCov;

    if (plan.claims.size > 0 && mode === "repair") {
        rewriteBlocks(blocks, plan.claims);
        // The kernel pipeline runs reconcileLiveIdsNode (remintCoveredLiveIds)
        // BEFORE syncBlocks/prune: a live message whose id exactly matches a
        // covered id but was absent from the previous pass gets its id
        // re-minted (the verbatim re-send protection) — which would defeat the
        // rewrite above. Merging the claimed ids into lastPassIds marks them
        // "already seen live", so remint leaves them and prune strips them as
        // covered. From this pass on the kernel maintains lastPassIds itself.
        const prior = new Set(session.state?.lastPassIds ?? []);
        for (const newId of plan.claims.values()) prior.add(newId);
        (session.state as { lastPassIds?: string[] }).lastPassIds = [...prior];
    }

    session.metadata[METADATA_ANCHORS] = nextAnchors;
    session.metadata[METADATA_ORDER] = nextOrder;
    // The wire sites already schedule a save on every turn (state replacement
    // + markDirty); the metadata ride that existing save.

    // #2193: escalate persistent TOTAL-loss drift. A single pass with
    // unmatched ids is ordinary churn (edits, deletions, re-serialization
    // gaps) — the per-pass warn below covers it. But when covered ids keep
    // staying missing with ZERO reanchoring across consecutive passes, that
    // slice of fold state can never recover: consistent with a host-native
    // compaction landing outside
    // bili's knowledge (dsh native compaction, #1729/#2193) or a bulk client-
    // side history rewrite. One error line per episode names it instead of
    // letting the identical warn print hundreds of times.
    const tag = opts.sessionId === undefined ? "" : `[${opts.sessionId}] `;
    const totalDrift = plan.claims.size === 0 && plan.unmatched.length > 0;
    const prevStreak = (session.metadata[METADATA_DRIFT_STREAK] as number | undefined) ?? 0;
    if (!totalDrift) {
        if (prevStreak !== 0) resetFoldDriftState(session);
    } else {
        const streak = prevStreak + 1;
        session.metadata[METADATA_DRIFT_STREAK] = streak;
        if (prevStreak === 0) session.metadata[METADATA_DRIFT_SINCE] = Date.now();
        if (streak >= FOLD_DRIFT_ESCALATE_PASSES && plan.unmatched.length >= FOLD_DRIFT_ESCALATE_MIN_UNMATCHED
                && session.metadata[METADATA_DRIFT_ESCALATED] !== true) {
            session.metadata[METADATA_DRIFT_ESCALATED] = true;
            const since = session.metadata[METADATA_DRIFT_SINCE] as number | undefined;
            const span = typeof since === "number" ? `, ${Math.max(1, Math.round((Date.now() - since) / 60000))} min so far` : "";
            if (opts.log !== undefined) {
                opts.log("error", `${tag}[fold-reconcile] compression substrate appears destroyed: ${plan.unmatched.length} covered id(s) missing with NO anchor match for ${streak} consecutive passes${span} — consistent with a host-native compaction landing outside bili's knowledge (dsh native compaction, #1729/#2193), a bulk client-side history rewrite${plan.idRewriteSuspects > 0 ? `, or host-rewritten tool-call ids (${plan.idRewriteSuspects} of them have an inbound twin with identical content under a different toolCallId — keep tool-call ids byte-stable per conversation, #2396)` : ""}; bili folds can no longer cover the resent history (#1921)`);
            }
        }
    }

    if (plan.unmatched.length === 0 && plan.claims.size === 0) {
        return { kind: "resend", missing: 0, claims: 0, byTool: 0, byNorm: 0, byCanon: 0, unmatched: 0 };
    }
    if (opts.log !== undefined) {
        if (plan.claims.size > 0 && mode === "repair") {
            opts.log(plan.unmatched.length > 0 ? "warn" : "info",
                `${tag}[fold-reconcile] resent history drifted: ${plan.claims.size + plan.unmatched.length} covered id(s) missing — reanchored ${plan.claims.size} (${plan.byTool} by toolCallId, ${plan.byNorm} by normalized identity, ${plan.byCanon} by canonical fingerprint) onto churned bytes, ${plan.unmatched.length} unmatched re-enter the wire unfolded${plan.idRewriteSuspects > 0 ? `; ${plan.idRewriteSuspects} suspected host-rewritten tool-call ids (identical content under a different toolCallId — #2396)` : ""} (#1921/#2454)`);
        } else if (plan.claims.size > 0) {
            opts.log("warn",
                `${tag}[fold-reconcile] resent history drifted: ${plan.claims.size + plan.unmatched.length} covered id(s) missing, ${plan.claims.size} matchable by anchor (${plan.byTool} toolCallId, ${plan.byNorm} normalized, ${plan.byCanon} canonical) but reconcile=warn made no repair (#1921/#2454)`);
        } else if (session.metadata[METADATA_DRIFT_ESCALATED] !== true) {
            // #2297: once the episode escalated, the single error line IS the
            // report — repeating this warn per pass contradicts the #2193
            // contract ("one error line per episode ... instead of letting the
            // identical warn print hundreds of times"). Recovery resets the
            // latch, so a later episode reports fresh; the persisted latch also
            // keeps a restarted process silent mid-episode (#2293 terminal state).
            opts.log("warn",
                `${tag}[fold-reconcile] resent history drifted: ${plan.unmatched.length} covered id(s) missing with no anchor match — mutation (content edit invalidates content-hash refs, fold silently lost) or client-side deletion/truncation (benign, message no longer on the wire)${plan.idRewriteSuspects > 0 ? `; ${plan.idRewriteSuspects} of them have an inbound twin with identical normalized content under a different toolCallId — consistent with the host rewriting authoritative tool-call ids across provider projections (host contract: keep tool-call ids byte-stable per conversation, #2396)` : ""} (#1921)`);
        }
    }
    return {
        kind: plan.claims.size > 0 ? (mode === "repair" ? "reanchored" : "unmatched") : "unmatched",
        missing: plan.claims.size + plan.unmatched.length,
        claims: plan.claims.size,
        byTool: plan.byTool,
        byNorm: plan.byNorm,
        byCanon: plan.byCanon,
        unmatched: plan.unmatched.length,
    };
}

/** [#1921] System-prompt-only changes must not be mistaken for history churn
 *  (the system block is not part of message identity, so fold state is
 *  unaffected by construction — this just makes the case observable). */
export function noteSystemPromptFingerprint(session: Session, system: unknown, opts: ReconcileOptions = {}): void {
    if (!session.metadata) return;
    const text = system === undefined || system === null ? "" : JSON.stringify(system) ?? "";
    const fp = system === undefined || system === null ? "-" : createHash("sha256").update(text).digest("hex").slice(0, 16);
    const prev = session.metadata[METADATA_SYSTEM_FP] as { fp: string; size: number } | undefined;
    if (prev !== undefined && prev.fp !== fp) {
        if (opts.log !== undefined) {
            opts.log("info", `${opts.sessionId === undefined ? "" : `[${opts.sessionId}] `}[fold-reconcile] system prompt changed (${prev.size} → ${text.length} chars); fold state unaffected (#1921)`);
        }
    }
    session.metadata[METADATA_SYSTEM_FP] = { fp, size: text.length };
}
