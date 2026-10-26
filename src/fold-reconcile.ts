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
// Pass 0 (#2480) — POSITIONAL identity, self-stored canonical copy. The
// passes above re-derive identity from wire bytes, so a protocol switch that
// re-serializes the WHOLE history (openai<->anthropic arguments encoding,
// toolCallId scheme rewrite) churns every id and every anchor at once (#2454):
// the heuristics patch one boundary each and never finish. Positional layer:
// bili keeps `foldPositions` — a canonical fingerprint per message, aligned
// 1:1 with foldAnchorOrder (same rolling window and cap). Position in the
// resent array is the ownership evidence (the #2265 simhash header already
// said it: "the message COUNT lines up and every message stays ~99% similar
// ... full-list positional similarity is ownership evidence"); the
// fingerprint (role+toolName+canonical text, protocol-volatile toolCallId and
// contentType stripped) is a per-cell CONFIDENCE comparator that gates every
// claim, never an identity. Client-native compaction that truncates the head
// lands gracefully: the tail-aligned scan keeps the surviving tail covered
// while the vanished head ids fall into the honest unmatched/archive path —
// no death spiral, and the copy self-heals on the next full pass.
//
// #2915 — ORDER-CENTRIC upgrade (owner rule 2026-10-12: 顺序为中心，
// hash 为辅助). Identity hierarchy: order → content → id. Pass 0's scans
// used to STOP at the first fingerprint mismatch, so one changed cell (a
// re-serialized preamble, a single edited message) stranded every later cell
// between the break and the far flank — and with every id re-minted by a
// provider re-projection (#2821's dsh model switch) BOTH scans died at their
// first cells while the order was fully intact (byPos=0, 3289 missing,
// "substrate destroyed", all folds dropped). An order break is now a GAP,
// not a wall: each scan resyncs at the next run of MIN_RESYNC_RUN consecutive
// same-index agreements (bounded by MAX_RESYNC_GAPS) and keeps claiming
// verified spans; gap cells fall through to the content passes and the honest
// unmatched path. Tool-id twins (#2396) graduate from detection-only to a
// claim pass (1.5): exact normalized content equality under the rewritten
// toolCallId, k-th discipline, length-guarded — the id is a fast path, never
// a death sentence. The fingerprint stays a HARD per-cell gate (owner
// phrasing "hash 只是参考" means no GLOBAL kill-switch — a mismatch voids
// that cell only, never the whole history); escalation to "substrate
// destroyed" still exists but now counts only gaps that survived positional
// resync AND the twin/norm content passes.
//
// #2915 gap resolution — tiered fallback for the cells that fall OUT of
// Pass 0 (owner rule, same day: any channel matches → claim; none match but
// the flanks do → claim; order holds within the session → claim). After the
// exact content passes have had their bite, a same-index gap cell is
// resolved by (a) simhash corroboration — a re-rendered cell keeps its
// word-shingle mass (measured: JSON key reorder 8 bits, one-word edit of a
// long line 7, vs re-run "3 failed"→"all green" 11, JSON-vs-prose 30;
// threshold 8 keeps the churn inside and the re-runs outside), then (b)
// order bracket — the cell sits BETWEEN verified positional claims inside
// one session (reconcile is session-scoped by construction): same role,
// bounded length drift, and the fold asserts the SLOT, not the stale bytes.
// The one stale cell bracketing can carry (delete+insert at the same index)
// is the owner-sanctioned tradeoff for never losing a session to a
// re-rendered cell. Zero corroboration anywhere stays honest drift — "order
// is the same" is only a claim when something verified it.
//
// Pass 3 (#2636) — ASSISTANT-TURN key. A host replaying one conversation
// across models re-serializes every thinking-bearing assistant turn: the
// same-model replay carries reasoning in a structured field (kernel: adjacent
// reasoning + text cores), a cross-model replay inlines the thinking as plain
// text (kernel: ONE merged text core — the #64 tag-splitter cannot help,
// there is no dialect tag to split on). Same turn bytes, different core
// shapes: N↔1 and 1→N. Pass 0 stops at the first shape change (positions
// misalign), so the turn key matches the FULL normalized turn text either
// way — pair→merged (both member ids claim the one witness) and merged→pair
// (one old id claims both new ids). Exact normalized equality — never fuzzy.
//
// Pass 4 (#2636) — IMAGE-CAPABILITY variants. Replaying onto a text-only
// model replaces every image part with a fixed placeholder line (pi's
// NON_VISION_USER_IMAGE_PLACEHOLDER), and replaying back restores the real
// parts — so a covered user text flips between `text` and
// `text + "\n" + placeholder` across the switch. The variant pass tries one
// trailing placeholder line stripped/appended against the anchor's
// normalized identity.
//
// Reap (#2695) — ZOMBIE STREAK. When a host deletes or decimates history
// WITHOUT an announced boundary (no dsh framing, no /compact), the covered
// substrate of the affected blocks never comes back, but duplicate-content
// re-derivation keeps a residual id alive so syncBlocks re-activates the
// block forever: its acp_summary carrier keeps rendering (and flapping)
// mid-list every turn — a permanent prefix-cache buster. The per-block
// coverage record (METADATA_FOLD_COVERAGE) now streak-counts passes where a
// strict MAJORITY of the block's covered ids is absent (2*(p+r) < t), gated
// on verified presence (e === 1 — never-represent substrates like
// view-folding hosts keep their #2202 status-quo semantics). After
// FOLD_DRIFT_ESCALATE_PASSES consecutive majority-loss passes the block is
// REAPED — removed from state.blocks (not deactivated: syncBlocks would
// resurrect it) with #395 archive semantics, blockContents retained for the
// derived-decompress fallback. Proxy mode only: a plugin-mode fold
// legitimately replaces the covered history (the agent's own compress runs
// against its private state), so absence there is sanctioned.
//
// Modes (config `compress.reconcile`, env BILI_FOLD_RECONCILE):
//   "off"    — disabled (pre-#1921 behavior).
//   "warn"   — compute + log only, no rewrite.
//   "repair" — rewrite block ids (default).
import { createHash } from "node:crypto";
import { defaultCountTokens, type CoreMessage } from "acp-kernel";
import { simhashHex, hammingHex } from "./affinity-simhash.js";
import { reapDestroyedSubstrate, type Session } from "./session.js";
import { coveredRealHistoryIds, isResponsesTurnSeparatorId } from "./session.js";
import { dshNativeCompactionWitness, recordConflict } from "./conflict-watch.js";
import { log as loggerLog } from "./logger.js";

type FoldReconcileMode = "off" | "warn" | "repair";

export const METADATA_ANCHORS = "foldAnchors";
const METADATA_ORDER = "foldAnchorOrder";
/** #2480: positional identity copy — canonical fingerprint per message,
 *  aligned 1:1 with foldAnchorOrder (same rolling window, same cap, written
 *  in the same pass). `foldPositions[i]` is the fingerprint of the message
 *  whose id is `foldAnchorOrder[i]`; same-id-at-same-index reuses the stored
 *  fingerprint (same id = same bytes), so steady state computes nothing. */
const METADATA_POSITIONS = "foldPositions";
/** #1921: last-noted system-prompt fingerprint ({fp, size}), consumed by both
 *  the fold-reconcile drift alert and the cache ledger's prompt-rewrite
 *  attribution (#2350). */
export const METADATA_SYSTEM_FP = "systemFp";
/** #2867: last-noted CANONICAL incoming system/developer fingerprint ({fp, size}) —
 *  role + text + wire order straight off the inbound body, independent of the
 *  proxy's projection mode (plugin in-place vs proxy hoist). The cache ledger
 *  pairs it with METADATA_SYSTEM_FP (the forwarded-projection fingerprint) to
 *  tell a host rewrite from bili's own mode/projection switch (#2867). */
export const METADATA_CANONICAL_SYS_FP = "canonicalSysFp";
/** #2867: compression mode ("plugin" | "proxy") serving the responses lane's
 *  last prepared request — written by prepare-responses, read by the ledger
 *  settle for projection-switch forensics (the `pm` line field). */
export const METADATA_LAST_RESPONSES_MODE = "lastResponsesMode";
/** Anchors are only kept for covered ids; 16k covered messages is far beyond
 *  any folded session, the cap only bounds pathological metadata. */
const MAX_ANCHORS = 16384;
/** Full-pass id order kept as the alignment backbone (oldest dropped beyond
 *  the cap — alignment is content-addressed, so a trimmed head only shifts
 *  where the exact-prefix run starts). */
const MAX_ORDER = 32768;
const METADATA_DRIFT_STREAK = "foldDriftStreak";
const METADATA_DRIFT_SINCE = "foldDriftSince";
// #2815 marker-mint churn acceptance note: one info line per session
// lifetime (NOT part of resetFoldDriftState — a stateless client churns the
// same marker-minted ids every pass forever; the episode never "ends").
const METADATA_MARKER_CHURN_NOTED = "foldMarkerChurnNoted";
/** Exported so the compress-failure receipt can sharpen its cause label into
 *  the substrate-destruction verdict (#2360 §2.4) without hardcoding a second
 *  copy of the key here. */
export const METADATA_DRIFT_ESCALATED = "foldDriftEscalated";
/** #3641: total collapse (nothing on the wire matches the session's fold
 *  substrate anywhere) latches an epoch-confirmation request instead of
 *  silently resetting: new folds are suspended for the session until the
 *  user confirms the new epoch or the original identity returns on the wire
 *  (auto-clear). The old destroy verdict relabeled: the session asks, it
 *  never abandons the snapshot on its own. */
const METADATA_EPOCH_CONFIRM = "foldEpochConfirmPending";
/** #3641: one-per-episode info latches for benign verdicts (shape churn /
 *  truncation). Cleared with the rest of the drift state on recovery. */
const METADATA_SHAPE_NOTED = "foldShapeChurnNoted";
const METADATA_TRUNC_NOTED = "foldTruncationNoted";
/** #3724: one-per-episode info latch for TAIL truncation — the mirror of
 *  METADATA_TRUNC_NOTED for host rewind/undo (the newest turns deleted, the
 *  resent wire is a prefix-cut of the pre-rewind wire). Same benign class as
 *  head truncation; a distinct key so the log can name which end moved. */
const METADATA_TAIL_TRUNC_NOTED = "foldTailTruncationNoted";
/** #3641: the wire order frozen at the moment the drift episode began — the
 *  baseline against which truncation-vs-replacement is decided. */
const METADATA_EPISODE_ORDER = "foldEpisodeOrder";
/** #3641 helper: true while the session waits for epoch confirmation.
 *  Read through this helper (the preflight fold gate does), never the raw
 *  metadata key. */
export function epochConfirmPending(session: Session): boolean {
    return (session.metadata?.[METADATA_EPOCH_CONFIRM] as boolean | undefined) === true;
}
/** #2193: total-loss drift (covered ids missing with ZERO reanchoring) across
 *  this many consecutive passes means the fold state can never recover —
 *  escalate once from warn to error and name the suspect cause instead of
 *  letting the same warn print hundreds of times. */
const FOLD_DRIFT_ESCALATE_PASSES = 3;
/** #3641: the shape pass only fires on MASS churn — at least this many
 *  residual missing cells must sit in the churn region before order-pairing
 *  is admissible evidence. Below it, honest unmatched (per-pass warn) is
 *  the right diagnosis: single-cell churn is ordinary edits. */
const SHAPE_MASS_MIN = 4;
/** Below this many permanently-missing ids the loss is small enough (a few
 *  edited/deleted messages) to stay at warn level. */
const FOLD_DRIFT_ESCALATE_MIN_UNMATCHED = 10;
/** #2915: order-centric resync — an order break is a GAP, not a wall. A
 *  positional scan that stops at the first fingerprint mismatch strands every
 *  verified cell behind the break; with ids re-minted across a provider
 *  re-projection (#2821) BOTH flank scans died at their first cells and
 *  byPos read 0 while the order was fully intact. Each scan now resyncs at
 *  the next run of MIN_RESYNC_RUN consecutive same-index agreements and
 *  keeps claiming verified spans, bounded by MAX_RESYNC_GAPS breaks per scan
 *  so pathological inputs stay linear. The gap cells fall through to the
 *  content passes and the honest unmatched path. */
const MIN_RESYNC_RUN = 3;
const MAX_RESYNC_GAPS = 8;
/** #2915 gap resolution — simhash corroboration tier. Measured on the repo's
 *  own shingle simhash (src/affinity-simhash.ts, word-bigram features):
 *  JSON key reorder = 8, one-word edit of a long line = 7, while a re-run
 *  tool call ("3 failed" → "all green") = 11 and JSON-vs-prose = 30. The
 *  8-bit line keeps every observed formatting churn inside and every
 *  genuinely-different content outside; anything looser starts claiming
 *  re-runs. Bracket-only cells (tier below) catch what formatting churn
 *  cannot explain. */
const GAP_SIMHASH_MAX_HAMMING = 8;
/** #2202: per-block coverage evidence, consumed by the cache ledger's
 *  conditional avoided-token accrual (src/cache-ledger.ts). */
export const METADATA_FOLD_COVERAGE = "foldCoverageByBlock";
/** #2202: passes carrying fewer inbound messages than this are auxiliary
 *  side-requests (#1075: title-gen / WebSearch refinement "carry only a
 *  handful of brand-new messages") — no drift evidence is taken from them.
 *  Same value as REWRITE_MIN_INCOMING_TOTAL (src/session.ts), which the #1195
 *  sibling warn guards with; kept local so the module's only host imports
 *  stay the #2695 reap/ledger hooks below. */
const SIDE_REQUEST_MAX_MSGS = 10;
/** pi's NON_VISION_USER_IMAGE_PLACEHOLDER (pi-stable-ai transform-messages):
 *  replaying a conversation onto a text-only model replaces every image
 *  part with this fixed line — the byte-stable seam pass 4 matches. Kept in
 *  sync with the host constant; it has never changed since introduction.
 *  Exported for prefix-affinity's #2601 normalized tail fingerprint, which
 *  must project the appended/placeholder-stripped replay as equal. */
export const USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";

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
    // #3641: a clean pass (any covered id present or re-anchored) IS the
    // confirmation — the histories realigned, so the epoch ask and the
    // one-per-episode info latches clear with the rest of the drift state.
    delete md[METADATA_EPOCH_CONFIRM];
    delete md[METADATA_SHAPE_NOTED];
    delete md[METADATA_TRUNC_NOTED];
    delete md[METADATA_TAIL_TRUNC_NOTED];
    delete md[METADATA_EPISODE_ORDER];
}

/** Per-covered-id anchor recorded from the last pass in which the id was seen.
 *  Stored in session.metadata.foldAnchors (persisted, free-form field). */
export interface FoldAnchor {
    /** sha256-16 of role\0contentType\0toolName\0toolCallId\0normalizedText.
     *  Absent on #3752 lite anchors (minted beyond the MAX_ANCHORS window,
     *  hash-free by construction) — every norm-keyed pass skips them. */
    n?: string;
    /** #2396: sha256-16 of role\0contentType\0toolName\0normalizedText (no
     *  toolCallId) — set alongside `t`; pairs a missing id with an inbound
     *  twin whose only difference is a rewritten toolCallId. Anchors
     *  persisted before #2396 lack it and are backfilled while their bytes
     *  are still on the wire (see the seed loop below). */
    m?: string;
    /** Message role at anchor time (tool-claim cross-check). */
    r?: string;
    /** Core contentType at anchor time ("text"/"reasoning"/…). Refreshed
     *  every pass while the id is present, so a later disappearance can be
     *  classified (pure reasoning drops are sanctioned host behavior —
     *  cross-model replay discards structured thinking while every
     *  text/tool core keeps its id; see the drift check, #2193 follow-up). */
    c?: string;
    /** Protocol-stable tool id (tool_use.id / tool_call_id) when present. */
    t?: string;
    /** Length of the anchor-time text — collision guard for norm claims. */
    b: number;
    /** #2636: assistant-turn key — normalized full-turn text (reasoning +
     *  seam + reply) of the turn this core belonged to, whichever wire form
     *  the turn was replayed in. Bare assistant cores only. */
    p?: string;
    /** #2636: second seam form of the turn key (pi concatenates the parts
     *  with "", some hosts emit a "\n") — set only when the two differ
     *  after normalization. */
    p2?: string;
    /** #2636: sibling core of the same turn (the text core of a reasoning
     *  core and vice versa) — lets a pair claim collapse onto one merged
     *  witness without a second lookup. */
    x?: string;
    /** 64-bit simhash (16 hex, affinity-simhash) of the canonical text at
     *  anchor time — #2915 gap-resolution corroboration: near-duplicate
     *  detection for re-rendered cells whose normalized bytes changed
     *  (formatting churn that NFC/whitespace/canonical-Json normalization
     *  still misses). Absent on anchors minted before the field existed
     *  (tier degrades gracefully) and on reasoning cores (their core text
     *  is the provider item id, not content). */
    sh?: string;
    /** Order-independent word-bag digest (sum of per-word 53-bit hashes) of
     *  the SAME canonical text — the edit-honesty gate on the simhash tier
     *  (#2480/#1908/#1921): a re-render (key reorder, whitespace/bracket
     *  churn, template re-stamp of punctuation) preserves the word multiset,
     *  while ANY user edit of prose changes it ("Turn 2" → "Turn 2 [GOLDEN-
     *  EDIT-SENTINEL]:" adds words). Simhash distance alone cannot separate
     *  the two (measured: reorder 8 vs one-word edit 7 — both inside the
     *  8-bit bar); the word bag can. Absent alongside `sh` with the same
     *  graceful degradation. */
    wh?: number;
}

interface ReconciliationPlan {
    /** old covered id → new inbound id(s) it was matched to. One→many: a
     *  merged core stands in for a reasoning+text pair (model switch, #2636).
     *  Many→one maps both members to the same single target. */
    claims: Map<string, string[]>;
    byPos: number;
    byTool: number;
    byTwin: number;
    bySim: number;
    byOrder: number;
    byNorm: number;
    byTurn: number;
    byImage: number;
    /** #3641: claims made by the shape-census pass — mass churn (protocol
     *  switch, image offload) where word evidence survives but EVERY exact
     *  channel starved (no fence, no bracket, norms changed with the shape).
     *  Order-paired under wordbag + simhash corroboration, or k-th family
     *  pairing for textless anchors; only fires on mass events (≥4 cells). */
    byShape: number;
    /** #2915: order breaks the positional scans resynced over (gaps claimed
     *  as order-carried spans past a fingerprint break) — observability for
     *  the order-centric doctrine, surfaced in the drift log line. */
    resyncs: number;
    /** Covered ids missing from the resent history with no match — either
     *  mutation (originals re-enter the wire unfolded) or benign client-side
     *  deletion/truncation (originals no longer on the wire) (#2297/#1195). */
    unmatched: string[];
    /** #2396: subset of `unmatched` whose anchor (no-toolCallId norm) matches
     *  an unclaimed inbound twin carrying a different toolCallId — suspected
     *  host-side rewrite of authoritative tool-call ids across provider
     *  projections. Detection only: never claimed, never repaired. */
    idRewriteSuspects: number;
    /** #2480: this pass's id order and positional fingerprints, for the
     *  caller's write-back (foldAnchorOrder / foldPositions rolling copy). */
    newOrder: string[];
    nextCanon: string[] | undefined;
    /** #4390 p3: stored positional copy present with matching lengths but ids
     *  not 1:1 aligned with the order backbone → Pass 0 self-disabled. Flagged
     *  for the caller to log (the planner core stays pure). */
    pass0Desync?: boolean;
    /** #3641 census of the RESIDUAL unmatched (after every claim pass,
     * including the shape pass): `absentEverywhere` = no unclaimed inbound
     * candidate carries loose word evidence (the content is truly off the
     *  wire — host truncation / sanctioned deletion); `nearDupResidual` =
     *  loose evidence exists but stayed unclaimable (duplicate mass beyond
     *  the family discipline). The verdict classifier reads these: transform
     *  churn re-anchors, absence is benign, only zero-evidence-everywhere
     *  still accrues the collapse streak. */
    absentEverywhere: string[];
    nearDupResidual: string[];
    /** #2283: sum of defaultCountTokens over every churn-region candidate — the
     *  raw mass riding unfolded in the drift zone this pass. Undefined when there
     *  is no drift (the missing.length === 0 early return skips this). */
    churnTokens?: number;
    /** #2283: subset of churnTokens whose candidate was re-covered by a claim.
     *  In repair mode rewriteBlocks applies the claims so those are covered again;
     *  in warn mode nothing is rewritten, so all churnTokens unfold. */
    claimedChurnTokens?: number;
}

export interface FoldReconcileResult {
    kind: "off" | "noop" | "resend" | "reanchored" | "unmatched";
    missing: number;
    claims: number;
    byPos: number;
    byTool: number;
    byTwin: number;
    bySim: number;
    byOrder: number;
    byNorm: number;
    byTurn: number;
    byImage: number;
    /** #3641: cells re-anchored by the shape-census pass (mass churn with
     *  word evidence: protocol switch, image offload). */
    byShape: number;
    /** #2695: fold blocks reaped this pass (removed from state.blocks after
     *  a majority-loss zombie streak). */
    reaped: number;
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
    /** #2695: consecutive passes with a strict MAJORITY of covered ids absent
     *  (2*(p+r) < t), counted only for verified substrates (e === 1). A
     *  healthy proxy-mode fold re-receives its covered originals every turn
     *  (p+r = t resets this to 0); model-switch churn reclaims most ids via
     *  anchors (p+r ≈ t likewise). When z reaches FOLD_DRIFT_ESCALATE_PASSES
     *  the substrate is taken for destroyed by an unannounced client rewrite
     *  and the block is reaped (reapDestroyedSubstrate, src/session.ts). */
    z?: number;
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

/** Identity-layout hash over an arbitrary replacement text — used by the
 *  image-capability pass to compare an anchor against a candidate whose text
 *  has a placeholder line stripped/appended. */
function identityWithText(message: CoreMessage, text: string): string {
    normalizedIdentityWork++;
    const h = createHash("sha256");
    h.update(`${message.role}\u0000${message.contentType}\u0000${message.toolName ?? ""}\u0000${message.toolCallId ?? ""}\u0000${normalizeMessageText(text)}`);
    return h.digest("hex").slice(0, 16);
}

/** #2636: assistant-turn key — the turn's full normalized text, whichever
 *  wire form it was replayed in. Split form contributes reasoning + seam +
 *  reply; merged form (thinking inlined as plain text by a cross-model host
 *  replay) contributes its own text — which IS that same join, except the
 *  seam byte is host-specific (pi concatenates the parts with "", some
 *  hosts emit a "\n"), so pairs carry a second seam-less key (p2) and the
 *  matcher probes both. Equal only when normalization collapses the
 *  difference. */
 function turnKeyOf(reasoning: string | undefined, text: string | undefined): string {
    normalizedIdentityWork++;
    const joined = reasoning !== undefined && reasoning !== "" && text !== undefined && text !== ""
        ? `${reasoning}\n${text}`
        : (reasoning ?? "") + (text ?? "");
    const h = createHash("sha256");
    h.update(`turn\u0000${normalizeMessageText(joined)}`);
    return h.digest("hex").slice(0, 16);
}

function turnKeyOfSeamless(reasoning: string | undefined, text: string | undefined): string {
    normalizedIdentityWork++;
    const joined = (reasoning ?? "") + (text ?? "");
    const h = createHash("sha256");
    h.update(`turn\u0000${normalizeMessageText(joined)}`);
    return h.digest("hex").slice(0, 16);
}

/** #3301: split tagged thinking-merge text (host metadata refresh re-serializes
 *  split-form turns as tagged reasoning spliced into content). MIRRORS
 *  kernel/src/wire/demoted-thinking.ts FORMS + splitDemotedThinking in lockstep
 *  (not exported from the kernel root) — keep both lists in sync. Offset-0 tag
 *  start is the only position demotion renderers produce. Auxiliary evidence
 *  for turn-key derivation ONLY — never identity minting. */
const THINKING_MERGE_FORMS: readonly { open: string; close: string }[] = [
    { open: "\x3cthink\x3e\n", close: "\n\x3c/think\x3e" },
    { open: "\x3cthinking\x3e\n", close: "\n\x3c/thinking\x3e" },
    { open: "```thinking\n", close: "\n```" },
];

export function extractThinkingMerge(text: string | undefined): { reasoning: string; text: string } | null {
    if (text === undefined || text === "") return null;
    let rest = text;
    const parts: string[] = [];
    for (;;) {
        let matched = false;
        for (const form of THINKING_MERGE_FORMS) {
            if (!rest.startsWith(form.open)) continue;
            const end = rest.indexOf(form.close, form.open.length);
            if (end < 0) continue;
            const inner = rest.slice(form.open.length, end);
            if (inner.length === 0) continue;
            parts.push(inner);
            rest = rest.slice(end + form.close.length);
            if (rest.startsWith("\n")) rest = rest.slice(1);
            matched = true;
            break;
        }
        if (!matched) break;
    }
    if (parts.length === 0) return null;
    return { reasoning: parts.join("\n"), text: rest };
}

/** Turn context for the anchor seed loop: per assistant-core id, the turn
 *  key(s) and (for split-form turns) the sibling core id. Built lazily — a
 *  steady-state pass reuses stored anchors and never pays this. */
interface TurnCtx { p?: string; p2?: string; x?: string }
export function turnContexts(msgs: CoreMessage[]): Map<string, TurnCtx> {
    const ctx = new Map<string, TurnCtx>();
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.id === undefined || m.role !== "assistant" || (m.toolCallId !== undefined && m.toolCallId !== "")) continue;
        if (m.contentType === "reasoning") {
            const next = msgs[i + 1];
            if (next !== undefined && next.id !== undefined && next.role === "assistant" && next.contentType === "text" &&
                (next.toolCallId === undefined || next.toolCallId === "")) {
                const key = turnKeyOf(m.text, next.text);
                const seamless = turnKeyOfSeamless(m.text, next.text);
                ctx.set(m.id, seamless !== key ? { p: key, p2: seamless, x: next.id } : { p: key, x: next.id });
                ctx.set(next.id, seamless !== key ? { p: key, p2: seamless, x: m.id } : { p: key, x: m.id });
            } else {
                ctx.set(m.id, { p: turnKeyOf(m.text, undefined) });
            }
        } else if (m.contentType === "text") {
            const prev = msgs[i - 1];
            if (prev === undefined || prev.id === undefined || prev.role !== "assistant" || prev.contentType !== "reasoning" ||
                (prev.toolCallId !== undefined && prev.toolCallId !== "")) {
                // #3301: merged-form core — its text may be tagged reasoning + reply.
                // The extracted pair key bridges anchors seeded from the split form
                // (same turn, different wire shape); the raw full-text key stays for
                // identical resends of this exact form.
                const ex = extractThinkingMerge(m.text);
                if (ex !== null) {
                    const key = turnKeyOf(ex.reasoning, ex.text);
                    const seamless = turnKeyOfSeamless(ex.reasoning, ex.text);
                    ctx.set(m.id, seamless !== key ? { p: key, p2: seamless } : { p: key });
                } else {
                    ctx.set(m.id, { p: turnKeyOf(undefined, m.text) });
                }
            }
        }
    }
    return ctx;
}

/** #2480: canonical JSON — recursively key-sorted, whitespace-free projection
 *  of a wire payload, so a codec switch that re-serializes tool-call arguments
 *  (key order, spacing, unicode escaping) cannot move it. Never throws:
 *  pathological nesting (RangeError in recursion or in JSON.parse) is caught
 *  by the caller's fallback to raw bytes. */
export function canonicalJson(value: unknown): string {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
    if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
    if (typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>).sort();
        const parts: string[] = [];
        for (const k of keys) {
            parts.push(`${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
        }
        return `{${parts.join(",")}}`;
    }
    return JSON.stringify(String(value)); // undefined / symbol / bigint edge
}

/** #2480: canonical text for the positional fingerprint. JSON-shaped payloads
 *  (tool-call arguments) project through canonicalJson; everything else
 *  (prose, XML-ish tool results) projects through normalizeMessageText (NFC +
 *  CR→LF + whitespace collapse) — formatting churn must not break the pairing,
 *  while any real content edit survives normalization and still mismatches
 *  (#2487's prose discipline, adopted). */
export function canonicalTextOf(text: string): string {
    const t = text.trimStart();
    if (!t.startsWith("{") && !t.startsWith("[")) return normalizeMessageText(text);
    try {
        return canonicalJson(JSON.parse(t));
    } catch {
        return normalizeMessageText(text);
    }
}

/** Order-independent word-bag digest of a canonical text (#2915 simhash-tier
 *  edit-honesty gate): sum of per-word hashes over the lowercase alphanumeric
 *  word tokens, seeded at 1. Addition and summation are commutative, so any
 *  reordering of the same words digests identically; punctuation, brackets,
 *  whitespace and JSON structure contribute nothing (a re-render keeps the
 *  bag); any added or removed word changes it (an edit does not keep the bag).
 *  Always a non-negative integer below 2^53 (double-safe). The accumulator
 *  seed of 1 separates the empty bag (digest 1) from any real bag, which
 *  would have to sum to exactly the modulus to collide with it.
 *  #2944 review finding ③: the previous finalizer mixed via JS `^`, which
 *  coerces both operands to int32 — it kept only the low 32 bits of the sum
 *  and could produce negative digests. Changing the digest re-records every
 *  persisted `wh` anchor on first sight (mismatch = refuse, the conservative
 *  edit-honest direction; anchors re-write as sessions re-anchor). */
export function wordBagDigest(text: string): number {
    let acc = 1;
    for (const m of text.toLowerCase().matchAll(/\p{L}+|\p{N}+/gu)) {
        acc = (acc + wordHash(m[0])) % 0x1fffffffffffff;
    }
    return acc;
}

function wordHash(w: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < w.length; i++) {
        h ^= w.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

let positionalFingerprintWork = 0;
export function resetPositionalFingerprintWork(): void {
    positionalFingerprintWork = 0;
}
export function positionalFingerprintWorkCount(): number {
    return positionalFingerprintWork;
}

/** #2480: protocol-invariant positional fingerprint — role + toolName +
 *  canonical text. Deliberately excludes toolCallId and contentType, the
 *  protocol-volatile fields that made content-hash identity drift on codec
 *  switches (#2454). This is a CONFIDENCE comparator for the positional
 *  identity layer, never an identity itself: positions pair only while their
 *  fingerprints agree, and the pairing lives in position space. */
export function positionalFingerprint(message: CoreMessage): string {
    positionalFingerprintWork++;
    const h = createHash("sha256");
    // #2480: reasoning items are id-carrier messages — the responses wire
    // adapter projects the PROVIDER-ITEM ID itself as the core text (probe:
    // responsesToCore([{type:"reasoning",id:"rs_0",...}]) yields
    // text="rs_0"; the encrypted blob never reaches core). The id is exactly
    // the protocol-volatile token this layer exists to survive, so hashing it
    // would break the pairing at the first reasoning message of every churn
    // (observed live: Pass 0 head scan stopped at index 1, byPos=0,
    // unmatched=12 on the responses lane). Fingerprint reasoning on role
    // alone: position still anchors the pairing, and consecutive reasoning
    // blobs are opaque by construction — claiming across a reasoning deletion
    // folds an equivalent-by-role message into the covered span, the same
    // “equivalent content” discipline as duplicate prose turns.
    if (message.contentType === "reasoning") {
        h.update(`${message.role}\u0000reasoning-id-carrier\u0000`);
        return h.digest("hex").slice(0, 16);
    }
    h.update(`${message.role}\u0000${message.toolName ?? ""}\u0000${canonicalTextOf(message.text ?? "")}`);
    return h.digest("hex").slice(0, 16);
}

function anchorFrom(message: CoreMessage, ctx?: TurnCtx): FoldAnchor {
    const t = message.toolCallId !== undefined && message.toolCallId !== "" ? message.toolCallId : undefined;
    const anchor: FoldAnchor = { n: normalizedIdentity(message), r: message.role, c: message.contentType, b: message.text?.length ?? 0 };
    if (t !== undefined) {
        anchor.t = t;
        anchor.m = normalizedIdentityNoToolCallId(message);
    }
    if (message.text !== undefined && message.text !== "" && message.contentType !== "reasoning") {
        anchor.sh = simhashHex(canonicalTextOf(message.text));
        anchor.wh = wordBagDigest(canonicalTextOf(message.text));
    }
    if (ctx?.p !== undefined) anchor.p = ctx.p;
    if (ctx?.p2 !== undefined) anchor.p2 = ctx.p2;
    if (ctx?.x !== undefined) anchor.x = ctx.x;
    return anchor;
}

// #3752: hash-free anchor for tool cores minted beyond the MAX_ANCHORS window.
// The window exists to bound per-pass hashing (#2334), but ids past it lost
// EVERY channel except the positional scan, which dies after MAX_RESYNC_GAPS
// accumulated breaks — so on long sessions a bili-side identity re-key left
// thousands of tool cores unrecoverable (the #3752 incident). Pass 1 consumes
// exactly {t, r}; {c, b} keep the drift classifier and length guards honest.
function liteToolAnchorFrom(message: CoreMessage): FoldAnchor {
    return {
        r: message.role,
        c: message.contentType,
        t: message.toolCallId as string,
        b: message.text?.length ?? 0,
    };
}

interface BlockLike {
    blockId?: string;
    active?: boolean;
    effectiveMessageIds?: string[];
    directMessageIds?: string[];
    /** Host-decompressed block — the kernel keeps it inactive by design. */
    expanded?: boolean;
}

/** #2297: only LIVE blocks count as covered. The kernel deactivates a block
 *  (consumed into a newer fold, host-expanded, or drifted out of the resent
 *  history) by setting active=false while KEEPING its effectiveMessageIds —
 *  those dead-lineage ids can never re-anchor and would sit in `missing`
 *  permanently, inflating the drift warn ~2x (#2293). Delegates to
 *  coveredRealHistoryIds so the single real-history caliber (#2627) is
 *  implemented exactly once. reconcileFoldCoverage additionally feeds the
 *  retained view-deactivated lineage back in via recoveryCandidateIds
 *  (#4050) — different question, same file; this caliber stays active-only. */
function coveredIdsOf(blocks: BlockLike[]): Set<string> {
    return coveredRealHistoryIds(blocks);
}

/** #4050: coverage of RETAINED folds that are inactive only because the last
 *  view skipped their span (kernel syncBlocks deactivation after a short
 *  request, #3844/#3845). That lineage is RECOVERABLE, not dead: the span's
 *  bytes may come back under churned ids (client re-serialization), and only
 *  the claim ladder can re-key them — but it never runs if they stay out of
 *  `covered` (coveredRealHistoryIds skips inactive blocks → covered.size===0
 *  → noop → stale ids never re-anchor → syncBlocks can never find them again
 *  → permanent coverage loss, folded originals re-sent every turn). The claim
 *  ladder decides PER CELL with multi-channel corroboration, so nothing is
 *  restored blindly: corroborated cells get re-keyed (syncBlocks then
 *  re-activates the block on the next pipeline run), non-corroborated cells
 *  stay honestly unmatched and complete the existing lifecycle (z-streak reap
 *  for verified substrates #2695, truncation suppression, epoch verdict
 *  #3641). Excluded: `expanded` blocks — the host decompressed them ON PURPOSE
 *  (the originals ride the wire verbatim and a fresh compress creates a NEW
 *  block, kernel/src/sync.ts), so there is nothing to restore and including
 *  their ids would feed #2293-style missing inflation when the whole wire
 *  re-serializes. Consumed (merged-away) blocks need no exclusion: their ids
 *  duplicate the surviving parent's ids, which the Set dedupes, and they stay
 *  inactive regardless via the consumed guard in kernel/src/sync.ts. */
function recoveryCandidateIds(blocks: ReadonlyArray<BlockLike>): Set<string> {
    const ids = new Set<string>();
    for (const block of blocks) {
        if (block.active || block.expanded === true) continue;
        for (const id of block.effectiveMessageIds ?? []) {
            if (!isResponsesTurnSeparatorId(id)) ids.add(id);
        }
    }
    return ids;
}

/** Pure core: plan the reconciliation between the previous pass order and the
 *  incoming messages. Exposed for unit tests. `positions` (#2480) is the
 *  stored positional fingerprint copy {ids, canon} (#2487's self-contained
 *  storage shape, adopted); Pass 0 claims by position + canonical fingerprint
 *  before the anchor passes run. */
export function planReconciliation(
    oldOrder: string[],
    anchors: Record<string, FoldAnchor>,
    msgs: CoreMessage[],
    covered: Set<string>,
    positions?: { ids: string[]; canon: string[] },
): ReconciliationPlan {
    const plan: ReconciliationPlan = { claims: new Map(), byPos: 0, byTool: 0, byTwin: 0, bySim: 0, byOrder: 0, byNorm: 0, byTurn: 0, byImage: 0, unmatched: [], idRewriteSuspects: 0, newOrder: [], nextCanon: undefined, resyncs: 0, byShape: 0, absentEverywhere: [], nearDupResidual: [] };
    // #2480: the positional copy is built on EVERY pass, so the first pass
    // after an upgrade establishes it and every later drift is
    // position-claimable. The fast path is reuse-by-ID (#2487): same id =
    // same bytes = same fingerprint, wherever the message now sits — steady
    // state pays zero projections even when positions shift (head deletion,
    // truncation), not just when the array is byte-identical.
    const canonById = new Map<string, string>();
    if (positions !== undefined) {
        const pids = positions.ids;
        const pcanon = positions.canon;
        for (let i = 0; i < pids.length && i < pcanon.length; i++) canonById.set(pids[i], pcanon[i]);
    }
    // Pass 0's old-side coordinate system is only valid when the stored copy's
    // ids align 1:1 with the order backbone. Self-contained storage makes the
    // check exact: a desync (backbone semantics drift, partial write) disables
    // Pass 0 instead of silently misaligning fingerprints. #4390 p3: flag it —
    // the caller logs; this core stays pure.
    let stored: string[] | undefined;
    if (positions !== undefined && positions.ids.length === oldOrder.length && positions.canon.length === oldOrder.length) {
        if (positions.ids.every((id, i) => id === oldOrder[i])) {
            stored = positions.canon;
        } else {
            plan.pass0Desync = true;
        }
    }
    const canon: string[] = [];
    const newOrder: string[] = [];
    const byId = new Map<string, CoreMessage>();
    for (const m of msgs) {
        if (m.id === undefined) continue;
        const i = newOrder.length;
        newOrder.push(m.id);
        byId.set(m.id, m);
        const priorCanon = canonById.get(m.id);
        canon.push(priorCanon !== undefined ? priorCanon : positionalFingerprint(m));
    }
    plan.newOrder = newOrder;
    plan.nextCanon = canon;
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
    const candidates: { id: string; message: CoreMessage; pos: number; norm?: string }[] = [];
    for (let i = prefix; i < newOrder.length - suffix; i++) {
        const id = newOrder[i];
        if (covered.has(id)) continue;
        const message = byId.get(id);
        if (message === undefined) continue;
        candidates.push({ id, message, pos: i });
    }
    const claimedCandidates = new Set<string>();

    // Missing covered ids inside the churn region, in previous-pass order.
    const missingMiddle: string[] = [];
    for (let i = prefix; i < oldOrder.length - suffix; i++) {
        const id = oldOrder[i];
        if (missingSet.has(id)) missingMiddle.push(id);
    }

    // Pass 0 — positional identity (#2480), order-centric since #2915. A
    // codec switch mints new ids for unchanged content, but the array COUNT
    // and ORDER survive; bili's stored canonical copy is the coordinate
    // system. Scan head-aligned from the exact-prefix run and tail-aligned
    // from the exact-suffix run; claim a missing covered id onto the inbound
    // id at the SAME index only while the canonical fingerprints agree. An
    // order break is a GAP, not a wall (#2915): on mismatch each scan
    // resyncs at the next run of MIN_RESYNC_RUN consecutive same-index
    // agreements (bounded by MAX_RESYNC_GAPS) and keeps claiming verified
    // spans — the dual flanks absorb any NET offset (insertion, deletion,
    // compaction), so same-index agreement inside a flank's region is
    // ownership evidence, and the full-content fingerprint gates every
    // claim, so consecutive duplicate messages can only pair onto identical
    // content — harmless either way. Gap cells stay honestly unmatched and
    // fall through to the content passes. The tail scan is also the graceful
    // landing for client-native compaction (truncated head, surviving tail):
    // tail blocks keep coverage while the vanished head ids fall into the
    // honest unmatched path.
    // #2915 gap-resolution evidence: same-index (oldId, newId) pairs recorded
    // at Pass-0 fingerprint breaks + the old indices that WERE positionally
    // claimed. A gap cell is bracketed when verified claims exist on both
    // sides — order ownership that the tiers below may corroborate.
    const gapPairs: { oldIdx: number; oldId: string; newId: string }[] = [];
    const claimedIdx: number[] = [];
    const recordGap = (oldIdx: number, oldId: string, newId: string): void => {
        if (oldId !== newId && missingSet.has(oldId) && !covered.has(newId) && !claimedCandidates.has(newId)) {
            gapPairs.push({ oldIdx, oldId, newId });
        }
    };
    if (stored !== undefined) {
        const head = Math.min(oldOrder.length, newOrder.length) - suffix;
        let gaps = 0;
        let i = prefix;
        // #2915 gap resolution evidence lives above the stored block so the
        // tier (below Pass 4) can see it.
        while (i < head) {
            if (canon[i] !== stored[i]) {
                recordGap(i, oldOrder[i]!, newOrder[i]!);
                let r = -1;
                for (let k = i + 1; k + MIN_RESYNC_RUN <= head; k++) {
                    if (canon[k] === stored[k] && canon[k + 1] === stored[k + 1] && canon[k + 2] === stored[k + 2]) { r = k; break; }
                }
                if (r === -1 || ++gaps > MAX_RESYNC_GAPS) break;
                plan.resyncs++;
                i = r;
                continue;
            }
            const oldId = oldOrder[i];
            const newId = newOrder[i];
            if (oldId === newId || !missingSet.has(oldId) || covered.has(newId) || claimedCandidates.has(newId)) { i++; continue; }
            plan.claims.set(oldId, [newId]);
            claimedCandidates.add(newId);
            plan.byPos++;
            claimedIdx.push(i);
            i++;
        }
        const tail = Math.min(oldOrder.length, newOrder.length) - prefix;
        gaps = 0;
        let j = 1;
        while (j <= tail) {
            const iOld = oldOrder.length - j;
            const iNew = newOrder.length - j;
            if (stored[iOld] !== canon[iNew]) {
                recordGap(iOld, oldOrder[iOld]!, newOrder[iNew]!);
                let r = -1;
                for (let k = j + 1; k + MIN_RESYNC_RUN - 1 <= tail; k++) {
                    let ok = true;
                    for (let u = 0; u < MIN_RESYNC_RUN; u++) {
                        if (stored[oldOrder.length - (k + u)] !== canon[newOrder.length - (k + u)]) { ok = false; break; }
                    }
                    if (ok) { r = k; break; }
                }
                if (r === -1 || ++gaps > MAX_RESYNC_GAPS) break;
                plan.resyncs++;
                j = r;
                continue;
            }
            const oldId = oldOrder[iOld];
            const newId = newOrder[iNew];
            if (oldId === newId || !missingSet.has(oldId) || covered.has(newId) || claimedCandidates.has(newId) || plan.claims.has(oldId)) { j++; continue; }
            plan.claims.set(oldId, [newId]);
            claimedCandidates.add(newId);
            plan.byPos++;
            claimedIdx.push(iOld);
            j++;
        }
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
            plan.claims.set(oldId, [usable[0].id]);
            claimedCandidates.add(usable[0].id);
            plan.byTool++;
        }
    }

    // Pass 1.5 — tool-id twins (#2915, promoting #2396's detection-only
    // buckets to a claim pass — owner rule 2026-10-12: order/content first,
    // the id is a fast path, never a death sentence). A provider
    // re-projection re-mints the authoritative toolCallId while the content
    // stays byte-stable (dsh model switch: call_x|fc_0 → call_x_fc_0 on every
    // pair, #2821). Pass 1 keys on exactly the field that was rewritten and
    // misses by construction; the anchor's no-toolCallId norm (m) pairs it
    // with an unclaimed inbound twin whose ONLY difference is the id. Same
    // misattribution discipline as Pass 2: exact normalized content equality
    // (role+contentType+toolName+text are all hash factors), k-th occurrence
    // to k-th occurrence in conversation order, and the 4x/256 length
    // collision guard — never fuzzy. A genuinely re-run tool call whose
    // content differs never matches; an identical-content duplicate claims
    // onto semantically identical bytes (harmless by content). Anchors
    // persisted before #2396 lack `m` and skip this pass (backfilled while
    // present verbatim — see the seed loop; pre-#2396 residue otherwise, an
    // empty set in practice).
    if (missingMiddle.length > 0 && candidates.length > 0) {
        const twinBuckets = new Map<string, { k: number; ids: string[]; messages: CoreMessage[] }>();
        for (const cand of candidates) {
            if (claimedCandidates.has(cand.id)) continue;
            const t = cand.message.toolCallId;
            if (t === undefined || t === "") continue;
            const nt = normalizedIdentityNoToolCallId(cand.message);
            const b = twinBuckets.get(nt);
            if (b === undefined) twinBuckets.set(nt, { k: 0, ids: [cand.id], messages: [cand.message] });
            else { b.ids.push(cand.id); b.messages.push(cand.message); }
        }
        if (twinBuckets.size > 0) {
            for (const oldId of missingMiddle) {
                if (plan.claims.has(oldId)) continue;
                const anchor = anchors[oldId];
                if (anchor === undefined || anchor.t === undefined || anchor.m === undefined) continue;
                const b = twinBuckets.get(anchor.m);
                if (b === undefined || b.k >= b.ids.length) continue; // absent or exhausted → skip
                const message = b.messages[b.k];
                // Collision guard (Pass 2's): normalized equality at a hash
                // slice plus a sane length ratio — reformatting cannot move
                // length by 4x.
                const len = message.text?.length ?? 0;
                if (Math.abs(len - anchor.b) > Math.max(256, anchor.b >> 2)) continue;
                plan.claims.set(oldId, [b.ids[b.k]]);
                claimedCandidates.add(b.ids[b.k]);
                b.k++;
                plan.byTwin++;
            }
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
        if (anchor === undefined || anchor.n === undefined) continue;
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
        plan.claims.set(oldId, [newId]);
        claimedCandidates.add(newId);
        plan.byNorm++;
    }

    // Pass 3 — assistant-turn key (#2636). Both forms carry the same turn
    // bytes, so the normalized turn key matches them in either direction:
    // pair→merged (both member ids claim the one witness) and merged→pair
    // (one old id claims both new ids). Exact normalized equality of the
    // FULL turn — never fuzzy; ambiguous keys (duplicated turns) skip.
    if (missingMiddle.length > 0 && candidates.length > 0) {
        const byPos = new Map<number, (typeof candidates)[number]>();
        for (const cand of candidates) byPos.set(cand.pos, cand);
        const singleTurnKeys = new Map<string, string[]>();
        const pairTurnKeys = new Map<string, [string, string][]>();
        const isBareAssistantCore = (m: CoreMessage): boolean =>
            m.role === "assistant" && (m.toolCallId === undefined || m.toolCallId === "");
        for (const cand of candidates) {
            if (claimedCandidates.has(cand.id)) continue;
            if (!isBareAssistantCore(cand.message)) continue;
            if (cand.message.contentType === "text") {
                // #3301: a merged-form core stands in for the whole turn —
                // register the raw full-text key AND the extracted pair key(s)
                // so anchors seeded from either wire form match.
                const keys = new Set<string>([turnKeyOf(undefined, cand.message.text)]);
                const ex = extractThinkingMerge(cand.message.text);
                if (ex !== null) {
                    keys.add(turnKeyOf(ex.reasoning, ex.text));
                    keys.add(turnKeyOfSeamless(ex.reasoning, ex.text));
                }
                for (const key of keys) {
                    const bucket = singleTurnKeys.get(key);
                    if (bucket === undefined) singleTurnKeys.set(key, [cand.id]);
                    else bucket.push(cand.id);
                }
            } else if (cand.message.contentType === "reasoning") {
                const next = byPos.get(cand.pos + 1);
                if (next !== undefined && !claimedCandidates.has(next.id) && isBareAssistantCore(next.message) && next.message.contentType === "text") {
                    const pair = [cand.id, next.id] as [string, string];
                    for (const key of new Set([turnKeyOf(cand.message.text, next.message.text), turnKeyOfSeamless(cand.message.text, next.message.text)])) {
                        const bucket = pairTurnKeys.get(key);
                        if (bucket === undefined) pairTurnKeys.set(key, [pair]);
                        else bucket.push(pair);
                    }
                } else {
                    // thinking-only turn kept in same-model shape: the reasoning
                    // core IS the whole turn (mirrors turnContexts' isolated case).
                    const key = turnKeyOf(cand.message.text, undefined);
                    const bucket = singleTurnKeys.get(key);
                    if (bucket === undefined) singleTurnKeys.set(key, [cand.id]);
                    else bucket.push(cand.id);
                }
            }
        }
        if (singleTurnKeys.size > 0 || pairTurnKeys.size > 0) {
            const candById = new Map(candidates.map((c) => [c.id, c] as const));
            for (const oldId of missingMiddle) {
                if (plan.claims.has(oldId)) continue;
                const anchor = anchors[oldId];
                if (anchor === undefined || anchor.p === undefined) continue;
                const probeKeys = new Set([anchor.p, anchor.p2].filter((k): k is string => k !== undefined));
                const singles: string[] = [];
                const pairs: [string, string][] = [];
                for (const key of probeKeys) {
                    for (const id of singleTurnKeys.get(key) ?? []) {
                        const c = candById.get(id);
                        if (c !== undefined && !claimedCandidates.has(id) && !singles.includes(id)
                            && (c.message.text?.length ?? 0) + 64 >= anchor.b) singles.push(id);
                    }
                    for (const p of pairTurnKeys.get(key) ?? []) {
                        if (pairs.some(([a, b]) => a === p[0] && b === p[1])) continue;
                        if (claimedCandidates.has(p[0]) || claimedCandidates.has(p[1])) continue;
                        const ca = candById.get(p[0]);
                        const cb = candById.get(p[1]);
                        if (ca === undefined || cb === undefined) continue;
                        const joined = (ca.message.text?.length ?? 0) + (cb.message.text?.length ?? 0) + 1;
                        if (Math.abs(joined - anchor.b) <= Math.max(256, anchor.b >> 2)) pairs.push(p);
                    }
                }
                if (singles.length + pairs.length !== 1) continue; // absent or ambiguous → skip
                const claimSibling = (targets: string[]): void => {
                    if (anchor.x === undefined || !missingSet.has(anchor.x) || plan.claims.has(anchor.x)) return;
                    plan.claims.set(anchor.x, targets);
                };
                if (singles.length === 1) {
                    plan.claims.set(oldId, [singles[0]]);
                    claimedCandidates.add(singles[0]);
                    claimSibling([singles[0]]);
                } else {
                    const [a, b] = pairs[0];
                    plan.claims.set(oldId, [a, b]);
                    claimedCandidates.add(a);
                    claimedCandidates.add(b);
                    claimSibling([a, b]);
                }
                plan.byTurn++;
            }
        }
    }

    // Pass 4 — image-capability variants (#2636). Try the candidate with one
    // trailing placeholder line stripped, and the candidate with one
    // appended, against the anchor's normalized identity. User cores only:
    // tool results carry a toolCallId and pass 1 already re-anchors them
    // without a length guard.
    if (missingMiddle.length > 0 && candidates.length > 0) {
        const stripVariants = new Map<string, string[]>();
        const appendVariants = new Map<string, string[]>();
        for (const cand of candidates) {
            if (claimedCandidates.has(cand.id)) continue;
            const m = cand.message;
            if (m.role !== "user" || m.contentType !== "text" || (m.toolCallId !== undefined && m.toolCallId !== "")) continue;
            const raw = m.text ?? "";
            const suffix = `\n${USER_IMAGE_PLACEHOLDER}`;
            if (raw.endsWith(suffix)) {
                const key = identityWithText(m, raw.slice(0, raw.length - suffix.length));
                const bucket = stripVariants.get(key);
                if (bucket === undefined) stripVariants.set(key, [cand.id]);
                else bucket.push(cand.id);
            }
            const appendKey = identityWithText(m, raw + suffix);
            const bucket2 = appendVariants.get(appendKey);
            if (bucket2 === undefined) appendVariants.set(appendKey, [cand.id]);
            else bucket2.push(cand.id);
        }
        const candById = new Map(candidates.map((c) => [c.id, c] as const));
        if (stripVariants.size > 0 || appendVariants.size > 0) {
            for (const oldId of missingMiddle) {
                if (plan.claims.has(oldId)) continue;
                const anchor = anchors[oldId];
                if (anchor === undefined || anchor.t !== undefined || anchor.n === undefined) continue;
                const normKey = anchor.n;
                const take = (map: Map<string, string[]>): string | undefined => {
                    const bucket = map.get(normKey);
                    if (bucket === undefined) return undefined;
                    const usable = bucket.filter((id) => {
                        const c = candById.get(id);
                        return c !== undefined && !claimedCandidates.has(id) && (c.message.text?.length ?? 0) + USER_IMAGE_PLACEHOLDER.length + 64 >= anchor.b;
                    });
                    return usable.length === 1 ? usable[0] : undefined;
                };
                const target = take(stripVariants) ?? take(appendVariants);
                if (target === undefined) continue;
                plan.claims.set(oldId, [target]);
                claimedCandidates.add(target);
                plan.byImage++;
            }
            // Identical-content families (pi's "Attached image(s) from tool
            // result:" wrapper repeats verbatim) defeat the unique-witness
            // guard above — K anchors and K candidates all share one variant
            // key. Fall back to k-th pairing in conversation order, the same
            // discipline as the normalized-identity pass: claim only when the
            // anchor count equals the candidate count for the key.
            const familyClaim = (map: Map<string, string[]>): void => {
                const byNorm = new Map<string, string[]>();
                for (const oldId of missingMiddle) {
                    if (plan.claims.has(oldId)) continue;
                    const anchor = anchors[oldId];
                    if (anchor === undefined || anchor.t !== undefined || anchor.n === undefined) continue;
                    const bucket = byNorm.get(anchor.n);
                    if (bucket === undefined) byNorm.set(anchor.n, [oldId]);
                    else bucket.push(oldId);
                }
                for (const [key, bucket] of map) {
                    const usable = bucket.filter((id) => !claimedCandidates.has(id));
                    const oldIds = byNorm.get(key) ?? [];
                    if (oldIds.length === 0 || oldIds.length !== usable.length) continue;
                    for (let k = 0; k < usable.length; k++) {
                        const anchor = anchors[oldIds[k]]!;
                        const c = candById.get(usable[k]);
                        if (c === undefined
                            || (c.message.text?.length ?? 0) + USER_IMAGE_PLACEHOLDER.length + 64 < anchor.b) continue;
                        plan.claims.set(oldIds[k], [usable[k]]);
                        claimedCandidates.add(usable[k]);
                        plan.byImage++;
                    }
                }
            };
            familyClaim(stripVariants);
            familyClaim(appendVariants);
        }
    }

    // #2915 gap resolution — owner rule 2026-10-12 (tiered fallback for
    // Pass-0 gap cells: “任何通道匹配就认领;都不匹配但前后匹配也认领;
    // 顺序在且同 session 就兜底”). The exact content passes (byTool /
    // byTwin / byNorm / byTurn / byImage) run BELOW Pass 0, so by the time
    // this tier sees a gap cell every exact channel has already had its
    // bite — what remains is tiered corroboration, in order of evidence
    // strength:
    //   (a) simhash: a re-rendered cell (formatting churn normalization
    //       still misses — key reordering beyond canonical-Json's reach,
    //       template re-stamps) keeps its word-shingle mass, so a 64-bit
    //       sketch within GAP_SIMHASH_MAX_HAMMING bits corroborates
    //       “same content, different bytes”; a re-run or edited message
    //       does not (measured: reorder 8, edit 7 vs re-run 11, JSON-vs-
    //       prose 30). Role/contentType cross-check + the byNorm length
    //       guard. Fence-independent: near-identical shingles at the SAME
    //       INDEX are ownership evidence on their own.
    //   (b) order bracket: the gap sits at the same index between
    //       VERIFIED positional claims (order was proven by fingerprint
    //       agreement on both flanks, within this session — reconcile is
    //       session-scoped by construction, which is the owner's
    //       “sessionid 也一样” premise). A replaced-in-place cell keeps
    //       its slot: same role, same toolName family, bounded length
    //       drift → the fold asserts the slot, not the stale bytes. The
    //       one stale cell this can carry (delete+insert at the same
    //       index) is the owner-sanctioned tradeoff for never losing the
    //       session to a single re-rendered cell (#2821).
    //   Zero corroboration anywhere (no fences, no sketch match, no exact
    //   channel) stays honest drift — “order is the same” is only a claim
    //   when something verified it.
    if (gapPairs.length > 0) {
        const fenced = plan.byPos > 0 || plan.resyncs > 0;
        const minClaimed = claimedIdx.length > 0 ? Math.min(...claimedIdx) : -1;
        const maxClaimed = claimedIdx.length > 0 ? Math.max(...claimedIdx) : -1;
        for (const gap of gapPairs) {
            if (plan.claims.has(gap.oldId) || claimedCandidates.has(gap.newId)) continue;
            const anchor = anchors[gap.oldId];
            const message = byId.get(gap.newId);
            if (anchor === undefined || message === undefined) continue;
            if (anchor.r !== undefined && anchor.r !== message.role) continue;
            const len = message.text?.length ?? 0;
            if (Math.abs(len - anchor.b) > Math.max(256, anchor.b >> 2)) continue;
            // (a) simhash corroboration
            if (anchor.sh !== undefined) {
                const sketch = simhashHex(canonicalTextOf(message.text ?? ""));
                if (hammingHex(anchor.sh, sketch) >= 0 && hammingHex(anchor.sh, sketch) <= GAP_SIMHASH_MAX_HAMMING) {
                    // Edit-honesty gate (#2480/#1908/#1921): the sketch says
                    // "near-duplicate", but near is not equal — a one-word
                    // edit of a long line sits INSIDE the 8-bit hamming bar
                    // (measured 7) and would silently swallow the edit into
                    // the fold. Only word-preserving churn (reorder, bracket/
                    // whitespace/template punctuation re-stamps) may claim;
                    // any prose change falls through to honest re-entry.
                    if (anchor.wh === undefined || anchor.wh === wordBagDigest(canonicalTextOf(message.text ?? ""))) {
                        plan.claims.set(gap.oldId, [gap.newId]);
                        claimedCandidates.add(gap.newId);
                        plan.bySim++;
                        continue;
                    }
                }
            }
            // (b) order bracket — same index, claims verified on both sides
            if (fenced && gap.oldIdx > minClaimed && gap.oldIdx < maxClaimed) {
                const loose = Math.abs(len - anchor.b) > Math.max(1024, anchor.b);
                if (loose) continue;
                if (anchor.t !== undefined && (message.toolCallId === undefined || message.toolCallId === "")) continue;
                plan.claims.set(gap.oldId, [gap.newId]);
                claimedCandidates.add(gap.newId);
                plan.byOrder++;
            }
        }
    }

    for (const id of missing) {
        if (!plan.claims.has(id)) plan.unmatched.push(id);
    }

    // #3641 — shape census pass. Mass churn (protocol switch #3640, image
    // offload #3588) defeats EVERY exact channel at once: ids re-minted,
    // norms changed with the wire shape, no positional fence ever verifies,
    // gap cells never recorded — so hundreds of covered ids land here with
    // the words still on the wire. Doctrine (order carries, content gates,
    // the id is only a hint): when a MISSING MASSES of cells still carry
    // word evidence, pair them in order instead of diagnosing destruction.
    //   prose anchors: wordbag equality + simhash ≤ GAP bar (the same
    //     edit-honesty gate as the sim tier) — role-checked, length-guarded;
    //   textless anchors (image families, no sh/wh by construction): k-th
    //     family pairing, only when the anchor/candidate counts per
    //     (role, class) bucket match EXACTLY — the byImage discipline,
    //     generalized past bili's own placeholder variant.
    // Only fires on mass events (≥ SHAPE_MASS_MIN residual cells): small
    // churn keeps the honest unmatched path below.
    const residualMiddle = missingMiddle.filter((id) => !plan.claims.has(id));
    if (residualMiddle.length >= SHAPE_MASS_MIN) {
        const looseProse = (anchor: FoldAnchor, m: CoreMessage): boolean => {
            if (anchor.wh === undefined || anchor.sh === undefined) return false;
            if (anchor.r !== undefined && anchor.r !== m.role) return false;
            const len = m.text?.length ?? 0;
            if (Math.abs(len - anchor.b) > Math.max(256, anchor.b >> 2)) return false;
            const wh = wordBagDigest(canonicalTextOf(m.text ?? ""));
            if (wh !== anchor.wh) return false;
            const dist = hammingHex(anchor.sh, simhashHex(canonicalTextOf(m.text ?? "")));
            return dist >= 0 && dist <= GAP_SIMHASH_MAX_HAMMING;
        };
        // prose pairing — order-preserving: walk anchors in conversation
        // order, take the first unclaimed loose candidate (also in order),
        // so pairs never cross when both sides are locally order-stable.
        for (const oldId of residualMiddle) {
            const anchor = anchors[oldId];
            if (anchor === undefined || anchor.sh === undefined || anchor.wh === undefined) continue;
            const cand = candidates.find((c) => !claimedCandidates.has(c.id) && looseProse(anchor, c.message));
            if (cand === undefined) continue;
            plan.claims.set(oldId, [cand.id]);
            claimedCandidates.add(cand.id);
            plan.byShape++;
        }
        // Textless family pairing — the #3588 incident shape: a contiguous
        // family of image-only cells (text "" → no sh/wh by construction)
        // rewritten into placeholder strings by the host's offload component.
        // Empty text cannot carry word evidence, so the ONLY admissible
        // evidence is positional: bracket the family in the PREVIOUS wire
        // order by stable flanks (ids present or re-anchored this pass),
        // take the unclaimed candidate cells strictly between the same
        // flanks on the CURRENT wire, and pair k-th to k-th — counts must
        // match exactly (the byImage family discipline, generalized past
        // bili's own placeholder variant to ANY rewrite, #3641).
        const textless = residualMiddle.filter((id) => {
            const anchor = anchors[id];
            return anchor !== undefined && anchor.sh === undefined && anchor.wh === undefined;
        });
        if (textless.length > 0) {
            const posInOld = new Map<string, number>();
            oldOrder.forEach((id, i) => posInOld.set(id, i));
            const newIndexOf = new Map<string, number>();
            plan.newOrder.forEach((id, i) => newIndexOf.set(id, i));
            const candById = new Map<string, (typeof candidates)[number]>();
            for (const c of candidates) candById.set(c.id, c);
            // runs of contiguous textless anchors in the previous wire order
            const placed = textless
                .map((id) => ({ id, at: posInOld.get(id) }))
                .filter((x): x is { id: string; at: number } => x.at !== undefined)
                .sort((a, b) => a.at - b.at);
            const runs: Array<Array<{ id: string; at: number }>> = [];
            for (const item of placed) {
                const last = runs[runs.length - 1];
                if (last !== undefined && item.at === last[last.length - 1]!.at + 1) last.push(item);
                else runs.push([item]);
            }
            const wireIndexOf = (id: string): number => {
                const direct = newIndexOf.get(id);
                if (direct !== undefined) return direct;
                const claimed = plan.claims.get(id);
                if (claimed !== undefined) {
                    for (const nid of claimed) {
                        const at = newIndexOf.get(nid);
                        if (at !== undefined) return at;
                    }
                }
                return -1;
            };
            for (const run of runs) {
                const lo = run[0]!.at;
                const hi = run[run.length - 1]!.at;
                // nearest stable flanks: previous-order ids before/after the
                // run that survive on the current wire (present or claimed)
                let left = -1;
                for (let j = lo - 1; j >= 0; j--) {
                    const at = wireIndexOf(oldOrder[j]!);
                    if (at >= 0) { left = at; break; }
                }
                let right = -1;
                for (let j = hi + 1; j < oldOrder.length; j++) {
                    const at = wireIndexOf(oldOrder[j]!);
                    if (at >= 0) { right = at; break; }
                }
                // BOTH flanks are mandatory: a run touching either end of the
                // previous wire order has no fence on that side, and pairing
                // into open space is guessing, not evidence (a brand-new
                // conversation tail must never claim a vanished family).
                if (left < 0 || right < 0) continue;
                if (left >= right) continue; // flanks inverted (reorder) — unpairable
                const familyCands: Array<(typeof candidates)[number]> = [];
                for (let at = left + 1; at < right; at++) {
                    const id = plan.newOrder[at]!;
                    const c = candById.get(id);
                    if (c === undefined || claimedCandidates.has(id) || covered.has(id)) continue;
                    familyCands.push(c);
                }
                if (familyCands.length !== run.length) continue; // off-by-one → no guessing
                for (let k = 0; k < run.length; k++) {
                    plan.claims.set(run[k]!.id, [familyCands[k]!.id]);
                    claimedCandidates.add(familyCands[k]!.id);
                    plan.byShape++;
                }
            }
        }
    }
    // #3641 census of what STILL did not claim — the verdict classifier's
    // evidence: absentEverywhere (content truly off the wire → benign
    // truncation / sanctioned deletion) vs nearDupResidual (word evidence
    // exists but stayed unclaimable — duplicate mass, transform churn the
    // family discipline could not pair).
    {
        const residualClasses = new Set(["text", "tool-call", "tool-result", "image", "reasoning", "code"]);
        const classCarrying = plan.unmatched.filter((id) => {
            const anchor = anchors[id];
            return anchor !== undefined && anchor.c !== undefined && anchor.c !== "reasoning";
        });
        for (const id of classCarrying) {
            const anchor = anchors[id]!;
            const loose = candidates.some((c) =>
                !claimedCandidates.has(c.id)
                && (anchor.r === undefined || anchor.r === c.message.role)
                && (
                    (anchor.wh !== undefined && anchor.sh !== undefined
                        && wordBagDigest(canonicalTextOf(c.message.text ?? "")) === anchor.wh
                        && (() => { const d = hammingHex(anchor.sh!, simhashHex(canonicalTextOf(c.message.text ?? ""))); return d >= 0 && d <= GAP_SIMHASH_MAX_HAMMING; })())
                ));
            // textless anchors (no sh/wh — image cells, #3588) carry NO
            // evidence channel: claimable families were already claimed by
            // the flanked k-th discipline above, so a textless residual is
            // proof-less absence, never "near-duplicate evidence".
            if (loose) plan.nearDupResidual.push(id);
            else plan.absentEverywhere.push(id);
        }
    }

    // #2396 — residual rewrite suspects. Pass 1 keys on the toolCallId itself
    // and misses rewritten ids by construction; Pass 1.5 (#2915) claims the
    // content-identical twins, so what reaches here survived EVERY claim pass
    // (length-guard rejects, exhausted duplicate families, real edits) —
    // suspect evidence, never a repair target: pairing old→new beyond verified
    // content equality would be guessing (misattribution is the expensive
    // failure mode). Cost: one no-toolCallId norm per unclaimed candidate
    // carrying a toolCallId, drift passes only — steady state early-returns
    // above (#2334 discipline).
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

    // #2283: token estimate of the re-entering unfolded mass (drift-only path, post
    // missing.length===0 early return — stays near-free on large steady-state histories).
    let churnTokens = 0;
    for (const c of candidates) churnTokens += defaultCountTokens(c.message.text ?? "");
    let claimedChurnTokens = 0;
    for (const cid of claimedCandidates) {
        const m = byId.get(cid);
        if (m !== undefined) claimedChurnTokens += defaultCountTokens(m.text ?? "");
    }
    plan.churnTokens = churnTokens;
    plan.claimedChurnTokens = claimedChurnTokens;
    return plan;
}

function rewriteBlocks(blocks: BlockLike[], claims: Map<string, string[]>): boolean {
    if (claims.size === 0) return false;
    let touched = false;
    for (const block of blocks) {
        const lists = [block.effectiveMessageIds, block.directMessageIds] as (string[] | undefined)[];
        for (const list of lists) {
            if (list === undefined) continue;
            for (let i = 0; i < list.length; i++) {
                const replacement = claims.get(list[i]);
                if (replacement === undefined || replacement.length === 0) continue;
                // Claims map 1→N (a merged core stands in for a reasoning+text
                // pair) and N→1 (both pair members claim one merged witness).
                // Splice the targets in and drop any already present — a
                // block must never list the same message id twice. When the
                // replacement is already in the list (the second member of an
                // N→1 collapse), the old id is removed, not kept: two covered
                // ids collapsing onto one live id is exactly the model-switch
                // pair→merged shape (#2636).
                const keep = replacement.filter((t) => !list.includes(t));
                if (keep.length === 0) {
                    list.splice(i, 1);
                    i--;
                    touched = true;
                    continue;
                }
                list.splice(i, 1, ...keep);
                i += keep.length - 1;
                touched = true;
            }
        }
    }
    return touched;
}

export interface ReconcileOptions {
    mode?: FoldReconcileMode;
    sessionId?: string;
    log?: (level: string, msg: string) => void;
    /** Raw-stage marker artifacts stripped from THIS inbound body
     *  (markerArtifactCount of src/marker/engine.ts). When > 0 the pass saw
     *  bili's own echoes riding the resent history: covered ids minted from
     *  artifact-laden bytes (pre-#2815 clients) churn once the strip engine
     *  cleans the resend — benign churn that must not feed the #2193 destroy
     *  streak. #2815/#2789. */
    markerStripped?: number;
    /** Inbound wire items before codec expansion; auxiliary requests can
     *  project a few items into dozens of cores without carrying history. */
    inboundMessageCount?: number;
    /** #3301: stored message decompositions for anchors that predate turn-key
     *  backfill (pre-#2644) — after a wire-shape flip the wire-side backfill
     *  can never fire (the old id is gone from the wire), so eligible anchors
     *  are rebuilt from these rows BEFORE the reconciliation plan runs and the
     *  flip pass itself claims. Latest-seq-per-id, neighbors included;
     *  undefined = no source available (legacy-only mode). */
    storedMessages?: CoreMessage[];
}

/** Entry point wired into the four wire sites, immediately BEFORE the
 *  #1195 pre-turn snapshot (so the snapshot reflects reanchored ids and the
 *  drift WARN only reports the honest residual). */
export function reconcileFoldCoverage(session: Session, msgs: CoreMessage[], opts: ReconcileOptions = {}): FoldReconcileResult {
    const mode = opts.mode ?? resolveFoldReconcileMode(process.env);
    if (mode === "off") {
        resetFoldDriftState(session);
        return { kind: "off", missing: 0, claims: 0, byPos: 0, byTool: 0, byTwin: 0, bySim: 0, byOrder: 0, byNorm: 0, byTurn: 0, byImage: 0, byShape: 0, reaped: 0, unmatched: 0 };
    }
    const blocks = (session.state?.blocks ?? []) as BlockLike[];
    // Active coverage first (the anchor cap's survivor order, #2334), then the
    // retained view-deactivated lineage re-fed into the claim ladder (#4050);
    // see recoveryCandidateIds for what is excluded and why.
    const covered = coveredIdsOf(blocks);
    for (const id of recoveryCandidateIds(blocks)) covered.add(id);
    if (covered.size === 0) {
        resetFoldDriftState(session);
        return { kind: "noop", missing: 0, claims: 0, byPos: 0, byTool: 0, byTwin: 0, bySim: 0, byOrder: 0, byNorm: 0, byTurn: 0, byImage: 0, byShape: 0, reaped: 0, unmatched: 0 };
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
    if (msgs.length < SIDE_REQUEST_MAX_MSGS || (opts.inboundMessageCount !== undefined && opts.inboundMessageCount < SIDE_REQUEST_MAX_MSGS)) {
        return { kind: "noop", missing: 0, claims: 0, byPos: 0, byTool: 0, byTwin: 0, bySim: 0, byOrder: 0, byNorm: 0, byTurn: 0, byImage: 0, byShape: 0, reaped: 0, unmatched: 0 };
    }
    if (!session.metadata) return { kind: "noop", missing: 0, claims: 0, byPos: 0, byTool: 0, byTwin: 0, bySim: 0, byOrder: 0, byNorm: 0, byTurn: 0, byImage: 0, byShape: 0, reaped: 0, unmatched: 0 };

    let anchors: Record<string, FoldAnchor> =
        (session.metadata[METADATA_ANCHORS] as Record<string, FoldAnchor> | undefined) ?? {};
    const oldOrder: string[] = (session.metadata[METADATA_ORDER] as string[] | undefined) ?? [];
    // #2480: self-contained positional copy {ids, canon} (#2487's storage
    // shape, adopted) — the pair is internally consistent even if the order
    // backbone's semantics change later. The brief plain-canon[] form from
    // the #2488 merge window is still accepted (aligned against oldOrder):
    // unreleased, but sessions written by local builds keep reconciling.
    const storedRaw = session.metadata[METADATA_POSITIONS] as { ids?: unknown; canon?: unknown } | string[] | undefined;
    let positions: { ids: string[]; canon: string[] } | undefined;
    if (Array.isArray(storedRaw)) {
        positions = storedRaw.length === oldOrder.length ? { ids: oldOrder, canon: storedRaw } : undefined;
    } else if (storedRaw !== undefined && Array.isArray(storedRaw.ids) && Array.isArray(storedRaw.canon)) {
        positions = { ids: storedRaw.ids as string[], canon: storedRaw.canon as string[] };
    }

    const byId = new Map<string, CoreMessage>();
    for (const m of msgs) if (m.id !== undefined) byId.set(m.id, m);
    // #3301: a wire-shape flip puts legacy (pre-#2644, no p/x) ids off the wire
    // on the FIRST post-flip pass — and this same pass rolls the order backbone
    // forward without them, so any backfill landing later can never claim (the
    // claim passes only iterate ids still in the backbone). Rebuild eligible
    // anchors from the stored decomposition BEFORE the plan runs so the flip
    // pass itself can claim. Wire bytes always win: an id present on this pass
    // keeps its live-bytes path untouched.
    if (opts.storedMessages !== undefined && opts.storedMessages.length > 0) {
        const sById = new Map<string, CoreMessage>();
        for (const m of opts.storedMessages) if (m.id !== undefined) sById.set(m.id, m);
        const sCtx = turnContexts(opts.storedMessages);
        let changed = false;
        const upgraded: Record<string, FoldAnchor> = {};
        for (const [id, a] of Object.entries(anchors)) {
            if (a.p === undefined && a.r === "assistant" && a.t === undefined && !byId.has(id)) {
                const sm = sById.get(id);
                if (sm !== undefined) {
                    upgraded[id] = anchorFrom(sm, sCtx.get(id));
                    changed = true;
                    continue;
                }
            }
            upgraded[id] = a;
        }
        if (changed) anchors = upgraded;
    }

    const plan = planReconciliation(oldOrder, anchors, msgs, covered, positions);
    if (plan.pass0Desync) {
        loggerLog("warn", `[fold-reconcile] Pass 0 disabled: stored positional copy desynced from order backbone (session=${session.id}, copyIds=${positions?.ids.length ?? -1}, backbone=${oldOrder.length})`);
    }
    if (process.env.FOLD_RECONCILE_DEBUG === "1") {
        const active = blocks.filter((b) => b.active).length;
        const sample = msgs.slice(0, 6).map((m) => `${m.role}/${m.contentType ?? "-"}/${m.id ?? "?"}`);
        process.stderr.write(`[fold-reconcile-dbg] blocks=${blocks.length} active=${active} covered=${covered.size} oldOrder=${oldOrder.length} positions=${positions?.canon.length ?? -1} missing=${plan.unmatched.length + plan.claims.size} claims=${plan.claims.size} byPos=${plan.byPos} resyncs=${plan.resyncs} byTool=${plan.byTool} byTwin=${plan.byTwin} bySim=${plan.bySim} byOrder=${plan.byOrder} byNorm=${plan.byNorm} byTurn=${plan.byTurn} byImage=${plan.byImage} unmatched=${plan.unmatched.length} | msgs[0..5]=${sample.join(" | ")}\n`);
    }

    // Seed/refresh anchors for covered ids present in this pass (including
    // freshly claimed ones — the next churn must re-anchor from post-churn
    // bytes), prune anchors for ids no longer covered, and roll the order
    // backbone forward to this pass.
    // #2636: turn keys for freshly seeded anchors — built lazily so
    // steady-state passes (no churn) never pay the per-core normalization
    // (#2334). Only bare assistant cores can carry a turn key
    // (turnContexts skips every other role), so the lookup is gated on that
    // shape too: querying a user/tool anchor would build the map for
    // nothing, every pass.
    let turnCtx: Map<string, TurnCtx> | undefined;
    const ctxOf = (id: string): TurnCtx | undefined => {
        if (turnCtx === undefined) turnCtx = turnContexts(msgs);
        return turnCtx.get(id);
    };
    const turnCtxFor = (message: CoreMessage | undefined): TurnCtx | undefined =>
        message !== undefined && message.id !== undefined && message.role === "assistant"
        && (message.toolCallId === undefined || message.toolCallId === "")
            ? ctxOf(message.id) : undefined;
    const nextAnchors: Record<string, FoldAnchor> = {};
    let anchorCount = 0;
    for (const id of covered) {
        // #2334: enforce the cap WHILE building. The old build-all-then-delete
        // form computed a full normalization + sha256 for every covered id and
        // discarded the overflow — and the discarded ids had no stored anchor
        // to reuse, so EVERY subsequent pass recomputed and dropped them again
        // (a 20k-id session paid 3616 wasted hashes per request). Capping at
        // MAX_ANCHORS keeps exactly the old survivor set (first MAX_ANCHORS in
        // covered order — the deletion loop removed precisely the tail) and the
        // key order.
        // #3752: ids PAST the cap no longer fall out entirely — tool cores get
        // a hash-free lite anchor ({r, c, t, b}) so Pass 1's toolCallId channel
        // reaches them at any session length. Before this, the positional scan
        // was their only path, and it dies after MAX_RESYNC_GAPS accumulated
        // breaks — on long sessions with weeks of genuine drift that turned
        // bili's own identity re-key (#3658) into a mass unfold (the incident
        // that opened #3752). Non-tool cores past the cap keep the old status
        // quo (positional-only): their channels need text hashes, exactly the
        // cost the window bounds.
        const claimed = plan.claims.get(id);
        if (claimed !== undefined) {
            for (const nid of new Set(claimed)) {
                if (nextAnchors[nid] !== undefined) continue;
                const message = byId.get(nid);
                if (message === undefined) continue;
                if (anchorCount < MAX_ANCHORS) {
                    nextAnchors[nid] = anchorFrom(message, turnCtxFor(message));
                    anchorCount++;
                } else if (message.toolCallId !== undefined && message.toolCallId !== "") {
                    nextAnchors[nid] = liteToolAnchorFrom(message);
                }
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
            if (anchorCount >= MAX_ANCHORS) {
                // Reuse verbatim, no backfill: past the window the stored
                // anchor (full or lite) already carries everything any
                // reachable channel needs, and backfilling would pay hashes
                // for nothing (#2334 steady-state contract, extended to the
                // tail).
                nextAnchors[id] = prior;
                continue;
            }
            // #2396: anchors persisted before the no-toolCallId norm existed
            // lack `m`; backfill it while the bytes are still on the wire —
            // one extra normalization per such anchor, once (same-id means
            // same identity fields, so recomputing from live bytes is exact).
            if (prior.t !== undefined && prior.m === undefined) {
                const message = byId.get(id);
                nextAnchors[id] = message !== undefined ? anchorFrom(message) : prior;
            } else if (prior.p === undefined && prior.r === "assistant" && prior.t === undefined) {
                // #2636: anchor persisted before turn keys existed: backfill
                // p/x while the bytes are still on the wire (same-id ⇒ same
                // identity fields, so recomputing from live bytes is exact) —
                // once per anchor, then reuse resumes (#2396 backfill
                // pattern). Bare assistant anchors only: user/tool anchors
                // never carry a turn key, so "p === undefined" is their
                // steady shape — rebuilding them every pass would break the
                // #2334 zero-work steady-state contract.
                const message = byId.get(id);
                nextAnchors[id] = message !== undefined ? anchorFrom(message, ctxOf(id)) : prior;
            } else if (prior.c === undefined) {
                // #2732 review supplement: anchors persisted before FoldAnchor.c
                // existed carry no content-type class and would stay classified
                // as non-reasoning forever — session state outlives the process,
                // so pre-upgrade sessions would never reach the reasoning-drop
                // tolerance. Same backfill pattern as #2396/#2636: recompute
                // from live bytes once (same-id ⇒ same identity fields incl.
                // contentType), then steady-state reuse resumes.
                const message = byId.get(id);
                nextAnchors[id] = message !== undefined ? anchorFrom(message, turnCtxFor(message)) : prior;
            } else {
                nextAnchors[id] = prior;
            }
            anchorCount++;
            continue;
        }
        const message = byId.get(id);
        if (message !== undefined) {
            if (anchorCount < MAX_ANCHORS) {
                nextAnchors[id] = anchorFrom(message, turnCtxFor(message));
                anchorCount++;
            } else if (message.toolCallId !== undefined && message.toolCallId !== "") {
                nextAnchors[id] = liteToolAnchorFrom(message);
            }
        }
    }
    const nextOrder = plan.newOrder.slice(-MAX_ORDER);
    // #2480: roll the positional copy forward in the same window as the order
    // backbone (same slice, same pass), stored self-contained as {ids, canon}
    // so the pair can never desync from itself (#2487's shape).
    if (plan.nextCanon !== undefined) {
        session.metadata[METADATA_POSITIONS] = { ids: nextOrder, canon: plan.nextCanon.slice(-MAX_ORDER) };
    }

    // #2202: per-block coverage evidence for the ledger's conditional accrual
    // (METADATA_FOLD_COVERAGE). Present = verbatim on this pass's wire;
    // reclaimed = matched onto churned bytes (still spared — honest coverage).
    // Computed BEFORE the repair rewrite below so old ids classify against the
    // plan instead of post-rewrite bytes. The cumulative ever-present flag is
    // what lets the ledger tell verified loss from structural absence.
    // #3641 census set, consumed by the z-accrual suppression below (and the
    // verdict classifier after the loop).
    const absentSet = new Set(plan.absentEverywhere);
    // #3641 wire-continuity witness: the wire order frozen at the moment the
    // drift episode began (frozen once per episode, cleared on recovery).
    // Truncation is benign ONLY when the current wire is a SUFFIX-CONTINUATION
    // of that witness: the surviving ids form the witness's tail AND the
    // inbound head (a client that dropped its old history and kept talking).
    // A wholesale replacement (foreign ids sharing nothing with the witness)
    // fails continuity on every pass of the episode — the witness is frozen,
    // so the foreign wire can never "become" the baseline mid-episode.
    let witness = session.metadata[METADATA_EPISODE_ORDER] as string[] | undefined;
    const episodeActive = ((session.metadata[METADATA_DRIFT_STREAK] as number | undefined) ?? 0) > 0;
    if (witness === undefined && episodeActive && oldOrder.length > 0) {
        // mid-episode freeze (episode predates this pass): adopt the previous
        // wire as baseline — persisted so later passes compare against the
        // SAME baseline.
        witness = oldOrder.slice(-MAX_ORDER);
        session.metadata[METADATA_EPISODE_ORDER] = witness;
    }
    // Before an episode starts there is nothing persisted: judge continuity
    // transiently against the previous wire (oldOrder). The drift branch
    // below persists the witness when the episode actually starts, so a
    // foreign wire can never quietly become the baseline mid-episode.
    const continuityBaseline = witness ?? oldOrder;
    let wireContinuity = false;
    // #3724: the MIRROR of wireContinuity — TAIL truncation (host rewind/undo
    // deletes the NEWEST turns instead of the oldest). The resent wire is a
    // clean PREFIX-CUT of the baseline: the shared ids (commonInbound, in
    // inbound order) form a contiguous run at the FRONT of both the baseline
    // and the inbound wire, AND the baseline extended beyond that prefix
    // (commonPrefix < baseline length ⇒ something was cut off the newest end).
    // Head truncation above keeps the tail; this keeps the head. A plain
    // append keeps the whole baseline (prefix == baseline, not strictly
    // shorter) so it never fires; a mid-history edit or wholesale replacement
    // breaks the contiguous-front check and stays honest drift.
    let tailTruncated = false;
    if (continuityBaseline.length > 0) {
        const witness = continuityBaseline;
        const inboundSet = new Set(plan.newOrder);
        const witnessSet = new Set(witness);
        const commonWitness = witness.filter((id) => inboundSet.has(id));
        const commonInbound = plan.newOrder.filter((id) => witnessSet.has(id));
        wireContinuity = commonWitness.length > 0
            && witness.slice(witness.length - commonWitness.length).every((id) => inboundSet.has(id))
            && plan.newOrder.slice(0, commonInbound.length).every((id) => witnessSet.has(id));
        const commonPrefix = commonInbound;
        tailTruncated = commonPrefix.length > 0
            && commonPrefix.length < witness.length
            && witness.slice(0, commonPrefix.length).every((id) => inboundSet.has(id))
            && plan.newOrder.slice(0, commonPrefix.length).every((id) => witnessSet.has(id));
    }
    // #2815: id churn explained by raw-stage marker stripping. Covered ids
    // minted BEFORE the marker engine (or by any client that keeps resending
    // the artifact-laden bytes) hash marker-laden content; once stripRawStage
    // cleans the resent history every marker-bearing covered message arrives
    // under a fresh id (clean bytes), every pass, forever, on a stateless
    // client. The covered CONTENT is still on the wire (benign churn that
    // re-folds self-heal — probe-verified: user ids verbatim, positional
    // anchors hold, nothing reaped), so feeding the #2193 destroy streak
    // here would misdiagnose exactly the #2789 victim population as
    // "substrate destroyed" while compression is healthy. Same shape as the
    // reasoning-only-drop sanction above: per-pass evidence, and a pass
    // without stripped markers still escalates on its own streak.
    const markerChurnExplained = (opts.markerStripped ?? 0) > 0;
    // Per-wire model-switch audit (#2193 follow-up): a PURE reasoning drop is
    // sanctioned host behavior, not substrate destruction. Cross-model replay
    // discards structured thinking (anthropic thinking blocks, responses
    // reasoning items, google thought parts) while every text/tool core keeps
    // its id — kernel ids are seeded blind to thinking siblings. When the
    // ONLY missing covered ids are reasoning anchors and nothing needed
    // reanchoring (every other covered id is present verbatim), the fold is
    // fully alive: do not accrue the destroy streak, do not latch the
    // escalation.
    const reasoningOnlyDrop = plan.claims.size === 0 && plan.unmatched.length > 0
        && plan.unmatched.every((id) => anchors[id]?.c === "reasoning");
    // Dead reasoning ids after a sanctioned drop are permanent residents of
    // the unmatched set; they must not count toward the destroy threshold
    // either — otherwise "model switch + one honest user edit" (10 dead
    // reasoning ids + 1 dead user id) would cry destruction three passes
    // later while the fold is healthy.
    // #2903: also exclude LEGACY anchors — persisted by ≤0.1.191 builds before
    // FoldAnchor.c existed (no content-type class). Their keys sit outside the
    // current id space, so they read as missing every pass and can never be
    // backfilled once off the wire (the #2732 backfill needs live bytes). The
    // old `!== "reasoning"` classified that permanent bili self-debt as
    // non-reasoning and latched foldDriftEscalated on healthy long sessions
    // after 3 passes. Only a KNOWN non-reasoning class counts: a genuine
    // client-side rewrite/deletion still carries a concrete `c`, so real loss
    // still escalates — pure-legacy debt alone never does.
    const nonReasoningUnmatched = plan.unmatched.filter((id) => {
        const cls = anchors[id]?.c;
        return cls !== undefined && cls !== "reasoning";
    }).length;
    // #3641 verdict classifier — the census evidence names the phenomenon
    // before any streak accrues:
    //   shapeExplained: word evidence survived on the wire under churned ids
    //     (protocol switch #3640, image offload #3588) — the shape pass
    //     re-anchored some cells (byShape > 0) or the residual mass still
    //     carries near-duplicate word evidence (≥60% of class-carrying
    //     residual). Transform, not destruction: no streak, one info.
    //   truncationExplained: EVERY class-carrying residual is absent with
    //     zero word evidence anywhere, while some covered substrate is still
    //     present (resent or re-anchored) — the client dropped old history
    //     (sanctioned truncation #2695/#2297). Absence, not destruction: the
    //     snapshot is kept (z suppressed below), no streak, one info.
    // Everything else (genuine rewrite with real content change, wholesale
    // replacement by foreign history) keeps the #2193 streak — and its
    // terminal verdict is now an epoch confirmation, not "destroyed".
    const classCarryingResidual = plan.unmatched.filter((id) => {
        const cls = anchors[id]?.c;
        return cls !== undefined && cls !== "reasoning";
    });
    const shapeExplained = plan.byShape > 0
        || (classCarryingResidual.length > 0 && plan.nearDupResidual.length >= 0.6 * classCarryingResidual.length);
    const truncationExplained = classCarryingResidual.length > 0
        && plan.nearDupResidual.length === 0
        && classCarryingResidual.every((id) => absentSet.has(id))
        && wireContinuity;
    // #3724: MIRROR — every class-carrying residual absent with zero word
    // evidence AND the wire is a clean prefix-cut = host rewound/undid the
    // newest turns (deleting a freshly-folded span). Same sanctioned-deletion
    // class as head truncation: snapshot retained (z suppressed above), no
    // destroy streak, one distinct info line. Without this the all-covered-
    // rewound case read as total-loss drift → false "epoch confirmation"
    // escalation (+ false proxy-mode reap), or went silent when re-anchoring
    // kept claims > 0.
    const tailTruncationExplained = classCarryingResidual.length > 0
        && plan.nearDupResidual.length === 0
        && classCarryingResidual.every((id) => absentSet.has(id))
        && tailTruncated;
    const totalDrift = plan.claims.size === 0 && plan.unmatched.length > 0 && !reasoningOnlyDrop && !markerChurnExplained
        && !shapeExplained && !truncationExplained && !tailTruncationExplained;
    // Classify before reaping: the epoch-confirm gate promises to retain the
    // snapshot, even on the pass that first reaches the escalation threshold.
    const epochProtected = session.metadata[METADATA_EPOCH_CONFIRM] === true
        || (totalDrift && nonReasoningUnmatched >= FOLD_DRIFT_ESCALATE_MIN_UNMATCHED);
    const prevCov = (session.metadata[METADATA_FOLD_COVERAGE] as Record<string, FoldBlockCoverage> | undefined) ?? {};
    const nextCov: Record<string, FoldBlockCoverage> = {};
    let covCount = 0;
    for (const block of blocks) {
        const bid = block.blockId;
        if (bid === undefined || bid === "") continue;
        // #2627: evidence counts REAL history only — separator ids can never
        // be present or claimed, so including them in `t` would stall the
        // ledger's p+r>=t accrual for polluted blocks forever.
        const ids = (block.effectiveMessageIds ?? []).filter((id) => !isResponsesTurnSeparatorId(id));
        if (ids.length === 0) continue;
        let p = 0, r = 0;
        for (const id of ids) {
            if (byId.has(id)) p++;
            else if (plan.claims.has(id)) r++;
        }
        const rec: FoldBlockCoverage = { p, r, t: ids.length };
        if (prevCov[bid]?.e === 1 || p + r > 0) rec.e = 1;
        // #2695: zombie streak — strict majority of covered ids absent, only
        // for VERIFIED substrates (e === 1). Never-represent substrates keep
        // their #2202 structural-absence semantics (no streak, no reap).
        // #2732: sanctioned reasoning drops (drop-keep model switches)
        // permanently remove thinking cores from the resent history while
        // their text/tool siblings ride verbatim. Those ids must never read
        // as substrate loss, so the majority test runs on the non-reasoning
        // covered ids only; a span with no non-reasoning ids at all never
        // reads as gone (safe side — real fold spans carry user turns).
        const hardIds = ids.filter((id) => anchors[id]?.c !== "reasoning");
        const gone = hardIds.length > 0 && 2 * (p + r) < hardIds.length;
        // #3641: every absent hard id absent with ZERO word evidence anywhere
        // while the session still carries other substrate = sanctioned
        // truncation (client dropped old history), not zombie substrate. The
        // #2695 reap streak would destroy the last remaining snapshot of
        // history the host legitimately deleted from ITS view — bili keeps it
        // (the fold IS the session's memory of the covered span).
        const absentHard = hardIds.filter((id) => !byId.has(id) && !plan.claims.has(id));
        // #3724: tail truncation (host rewind) is the same sanctioned-deletion
        // class as head truncation for reap purposes — a fully-rewound span's
        // absence is user deletion, not zombie substrate, so suppress the
        // streak here too or the #2695 arm reaps the last snapshot of history
        // the host legitimately rewound away. (Same global-signal residual as
        // wireContinuity above: it self-corrects on the next stable pass.)
        const structurallyAbsent = absentHard.length > 0 && absentHard.every((id) => absentSet.has(id)) && (wireContinuity || tailTruncated);
        if (gone && !structurallyAbsent) {
            if (rec.e === 1) rec.z = (prevCov[bid]?.z ?? 0) + 1;
        } else {
            rec.z = 0;
        }
        if (covCount >= MAX_ANCHORS) continue;
        nextCov[bid] = rec;
        covCount++;
    }

    // #2695: reap blocks whose covered substrate stayed majority-absent for
    // FOLD_DRIFT_ESCALATE_PASSES consecutive passes. REMOVAL from
    // state.blocks — not deactivation: syncBlocks re-activates any block
    // whose id set still intersects the wire (kernel/src/sync.ts sets
    // active=true before the stillPresent check), and duplicate-content
    // re-derivation keeps exactly that intersection alive forever, which is
    // how the zombie carrier kept rendering (and flapping) every turn.
    // Proxy mode only (plugin folds legitimately replace covered history —
    // the agent's own compress runs against its private state); repair mode
    // only (warn observes). Runs BEFORE the backbone persistence below so
    // the reaped ids are stripped from the same objects that get stored.
    let reapedCount = 0;
    if (mode === "repair" && session.metadata.pluginAgent === undefined && !epochProtected) {
        const ripe = new Set<string>();
        for (const block of blocks) {
            const bid = block.blockId;
            if (bid !== undefined && (nextCov[bid]?.z ?? 0) >= FOLD_DRIFT_ESCALATE_PASSES) ripe.add(bid);
        }
        if (ripe.size > 0) {
            const liveRawIds = new Set(msgs.map((m) => m.id));
            const reaped = reapDestroyedSubstrate(session, ripe, liveRawIds, opts.log ?? (() => {}));
            reapedCount = reaped.length;
            if (reapedCount > 0) {
                // Strip the reaped blocks from the coverage/backbone records
                // this pass persists, so nothing seeds or positions their ids
                // again (nextOrder is the array METADATA_POSITIONS already
                // references — mutate in place).
                const deadIds = new Set<string>();
                for (const block of blocks) {
                    if (block.blockId === undefined || !ripe.has(block.blockId)) continue;
                    delete nextCov[block.blockId];
                    for (const id of block.effectiveMessageIds ?? []) deadIds.add(id);
                    for (const id of block.directMessageIds ?? []) deadIds.add(id);
                }
                for (const id of deadIds) delete nextAnchors[id];
                for (let i = nextOrder.length - 1; i >= 0; i--) {
                    if (deadIds.has(nextOrder[i])) nextOrder.splice(i, 1);
                }
                const storedPositions = session.metadata[METADATA_POSITIONS] as { ids?: string[] } | undefined;
                const positionIds = storedPositions?.ids;
                if (Array.isArray(positionIds) && positionIds !== nextOrder) {
                    for (let i = positionIds.length - 1; i >= 0; i--) {
                        if (deadIds.has(positionIds[i])) positionIds.splice(i, 1);
                    }
                }
                recordConflict(session, "orphan-reap", `reaped ${reapedCount} zombie fold block(s) [${reaped.join(", ")}]: covered substrate majority-absent for ${FOLD_DRIFT_ESCALATE_PASSES} consecutive passes (#2695)`);
            }
        }
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
        for (const targets of plan.claims.values()) {
            for (const newId of targets) prior.add(newId);
        }
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
    const unfoldedDrift = mode === "repair"
        ? Math.max(0, (plan.churnTokens ?? 0) - (plan.claimedChurnTokens ?? 0))
        : (plan.churnTokens ?? 0);
    const driftTok = unfoldedDrift > 0 ? ` (~${unfoldedDrift} tok unfolded in churn region)` : "";
    const prevStreak = (session.metadata[METADATA_DRIFT_STREAK] as number | undefined) ?? 0;
    if (!totalDrift) {
        if (prevStreak !== 0) resetFoldDriftState(session);
        // #3641: name the phenomenon once per episode — transform churn and
        // sanctioned truncation are EXPECTED host behaviors, not warnings.
        if (shapeExplained && session.metadata[METADATA_SHAPE_NOTED] !== true) {
            session.metadata[METADATA_SHAPE_NOTED] = true;
            opts.log?.("info", `${tag}[fold-reconcile] ${classCarryingResidual.length} covered id(s) churned shape (protocol switch / offload) with word evidence intact — re-anchored ${plan.byShape}, ${plan.nearDupResidual.length} near-duplicate residual kept under watch (#3641); fold state retained`);
        }
        // #3724: head and tail truncation are the same benign class — note
        // whichever fired first and stay quiet for the rest of the episode.
        // Without the cross-gate, once the backbone rebounds to the shortened
        // wire every stable resend reads as a trivial suffix-continuation and
        // would log a second, differently-worded line for the SAME rewind.
        if (tailTruncationExplained && session.metadata[METADATA_TAIL_TRUNC_NOTED] !== true && session.metadata[METADATA_TRUNC_NOTED] !== true) {
            session.metadata[METADATA_TAIL_TRUNC_NOTED] = true;
            opts.log?.("info", `${tag}[fold-reconcile] ${classCarryingResidual.length} covered id(s) no longer on the wire with no replacement evidence and the resent history is a prefix of the pre-rewind wire — host rewind/undo removed the newest turns (incl. a folded span); fold snapshot retained, nothing reaped (#3724)`);
        } else if (truncationExplained && session.metadata[METADATA_TRUNC_NOTED] !== true && session.metadata[METADATA_TAIL_TRUNC_NOTED] !== true) {
            session.metadata[METADATA_TRUNC_NOTED] = true;
            opts.log?.("info", `${tag}[fold-reconcile] ${classCarryingResidual.length} covered id(s) no longer on the wire with no replacement evidence and remaining substrate present — host-side truncation/dropped history, fold snapshot retained (#2695/#3641)`);
        }
    } else {
        const streak = prevStreak + 1;
        // #3641: persist the wire baseline the moment the episode starts —
        // every later pass of this episode judges truncation-vs-replacement
        // against the wire AS IT WAS at episode start, never against a
        // mid-episode (possibly already-replaced) wire.
        if (prevStreak === 0 && oldOrder.length > 0 && session.metadata[METADATA_EPISODE_ORDER] === undefined) {
            session.metadata[METADATA_EPISODE_ORDER] = oldOrder.slice(-MAX_ORDER);
        }
        session.metadata[METADATA_DRIFT_STREAK] = streak;
        if (prevStreak === 0) session.metadata[METADATA_DRIFT_SINCE] = Date.now();
        if (streak >= FOLD_DRIFT_ESCALATE_PASSES && nonReasoningUnmatched >= FOLD_DRIFT_ESCALATE_MIN_UNMATCHED
                && session.metadata[METADATA_DRIFT_ESCALATED] !== true) {
            session.metadata[METADATA_DRIFT_ESCALATED] = true;
            // #2709: take a ledger action at the destruction point (not just log) — attribute
            // framing-absent total-loss drift to client-native compaction when witnessed. One
            // event per episode: the ESCALATED latch above guards re-entry.
            const dshWitness = dshNativeCompactionWitness(session);
            if (dshWitness !== undefined) {
                recordConflict(session, "native-compaction-inferred", `compression substrate destroyed (total-loss drift, no checkpoint marker); bili refused ${dshWitness} client-native compaction call(s) this session (#1729/#2028) — attributed to client-native compaction [inferred] (${plan.unmatched.length} covered id(s) missing, #2193/#2709)`);
            }
            const since = session.metadata[METADATA_DRIFT_SINCE] as number | undefined;
            const span = typeof since === "number" ? `, ${Math.max(1, Math.round((Date.now() - since) / 60000))} min so far` : "";
            // #3641: the terminal verdict is an EPOCH CONFIRMATION, not an
            // abandonment. The snapshot is bili's memory of the covered span;
            // a wholesale replacement with no word evidence anywhere means
            // alignment is impossible — so folding STOPS (passthrough, the
            // preflight gate reads epochConfirmPending) and the session asks
            // the user once: re-anchor onto the new history (new epoch) or
            // restore the old one. Either alignment event clears the latch
            // automatically (resetFoldDriftState on the first clean pass).
            session.metadata[METADATA_EPOCH_CONFIRM] = true;
            if (opts.log !== undefined) {
                opts.log("error", `${tag}[fold-reconcile] fold epoch confirmation required: ${plan.unmatched.length} covered id(s) missing with NO anchor match and NO word evidence for ${streak} consecutive passes${span} — the resent history shares nothing with the fold substrate (wholesale replacement: host-native compaction outside bili's knowledge #1729/#2193, or a brand-new conversation on the same session id). Folding is paused for this session until the histories realign (old history resent or a fresh fold on the new one starts a new epoch); bili keeps the existing snapshot — nothing is deleted (#3641)${driftTok}`);
            }
        }
    }

    if (plan.unmatched.length === 0 && plan.claims.size === 0) {
        return { kind: "resend", missing: 0, claims: 0, byPos: 0, byTool: 0, byTwin: 0, bySim: 0, byOrder: 0, byNorm: 0, byTurn: 0, byImage: 0, byShape: 0, reaped: reapedCount, unmatched: 0 };
    }
    if (opts.log !== undefined) {
        if (plan.claims.size > 0 && mode === "repair") {
            opts.log(plan.unmatched.length > 0 ? "warn" : "info",
                `${tag}[fold-reconcile] resent history drifted: ${plan.claims.size + plan.unmatched.length} covered id(s) missing — reanchored ${plan.claims.size} (${plan.byPos} positional${plan.resyncs > 0 ? `, ${plan.resyncs} order break(s) resynced` : ""}, ${plan.byTool} by toolCallId${plan.byTwin > 0 ? `, ${plan.byTwin} by toolCallId twin` : ""}${plan.bySim > 0 ? `, ${plan.bySim} by simhash corroboration` : ""}${plan.byOrder > 0 ? `, ${plan.byOrder} by order bracket` : ""}, ${plan.byNorm} by normalized identity${plan.byTurn > 0 ? `, ${plan.byTurn} by assistant-turn key` : ""}${plan.byImage > 0 ? `, ${plan.byImage} by image-capability variant` : ""}${plan.byShape > 0 ? `, ${plan.byShape} by shape census` : ""}) onto churned bytes, ${plan.unmatched.length} unmatched re-enter the wire unfolded${plan.idRewriteSuspects > 0 ? `; ${plan.idRewriteSuspects} suspected host-rewritten tool-call ids (identical content under a different toolCallId — #2396)` : ""} (#1921)${driftTok}`);
        } else if (plan.claims.size > 0) {
            opts.log("warn",
                `${tag}[fold-reconcile] resent history drifted: ${plan.claims.size + plan.unmatched.length} covered id(s) missing, ${plan.claims.size} matchable by anchor (${plan.byPos} positional${plan.resyncs > 0 ? `, ${plan.resyncs} resynced` : ""}, ${plan.byTool} toolCallId${plan.byTwin > 0 ? `, ${plan.byTwin} twin` : ""}${plan.bySim > 0 ? `, ${plan.bySim} simhash` : ""}${plan.byOrder > 0 ? `, ${plan.byOrder} order-bracket` : ""}, ${plan.byNorm} normalized${plan.byTurn > 0 ? `, ${plan.byTurn} turn key` : ""}${plan.byImage > 0 ? `, ${plan.byImage} image` : ""}) but reconcile=warn made no repair (#1921)${driftTok}`);
        } else if (reasoningOnlyDrop) {
            opts.log("info",
                `${tag}[fold-reconcile] ${plan.unmatched.length} covered reasoning core(s) dropped by the host (cross-model replay discards structured thinking; every text/tool core intact) — fold substrate healthy, tolerated (#2193 follow-up)`);
        } else if (markerChurnExplained) {
            // #2815: the per-pass "no anchor match" warn names mutation or
            // client-side deletion — both WRONG for marker-mint churn. Note
            // the benign cause once per session (a stateless client churns
            // the same ids every pass; the note is acceptance, not repair —
            // re-folds re-cover the content on their own schedule).
            if (session.metadata[METADATA_MARKER_CHURN_NOTED] !== true) {
                session.metadata[METADATA_MARKER_CHURN_NOTED] = true;
                opts.log("info",
                    `${tag}[fold-reconcile] ${plan.unmatched.length} covered id(s) missing with no anchor match, but this pass stripped ${opts.markerStripped} raw marker artifact(s) — covered ids minted from marker-laden bytes churn once the strip engine cleans the resent history; benign on stateless resend (content still on the wire, re-folds re-cover), tolerated (#2815/#2789)`);
            }
        } else if (session.metadata[METADATA_DRIFT_ESCALATED] !== true) {
            // #2297: once the episode escalated, the single error line IS the
            // report — repeating this warn per pass contradicts the #2193
            // contract ("one error line per episode ... instead of letting the
            // identical warn print hundreds of times"). Recovery resets the
            // latch, so a later episode reports fresh; the persisted latch also
            // keeps a restarted process silent mid-episode (#2293 terminal state).
            opts.log("warn",
                `${tag}[fold-reconcile] resent history drifted: ${plan.unmatched.length} covered id(s) missing with no anchor match — mutation (content edit invalidates content-hash refs, fold silently lost) or client-side deletion/truncation (benign, message no longer on the wire)${plan.idRewriteSuspects > 0 ? `; ${plan.idRewriteSuspects} of them have an inbound twin with identical normalized content under a different toolCallId — consistent with the host rewriting authoritative tool-call ids across provider projections (host contract: keep tool-call ids byte-stable per conversation, #2396)` : ""} (#1921)${driftTok}`);
        }
    }
    return {
        kind: plan.claims.size > 0 ? (mode === "repair" ? "reanchored" : "unmatched") : "unmatched",
        missing: plan.claims.size + plan.unmatched.length,
        claims: plan.claims.size,
        byPos: plan.byPos,
        byTool: plan.byTool,
        byTwin: plan.byTwin,
        bySim: plan.bySim,
        byOrder: plan.byOrder,
        byNorm: plan.byNorm,
        byTurn: plan.byTurn,
        byImage: plan.byImage,
        byShape: plan.byShape,
        reaped: reapedCount,
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

/** #2867: canonical INCOMING system/developer fingerprint — the mode-independent
 *  twin of noteSystemPromptFingerprint's forwarded-projection value. The ledger
 *  pairs the two: projection flipped + canonical stable ⇒ bili's own
 *  mode/projection switch (self-heal degrade-to-proxy), NOT a host rewrite.
 *  Silent by design — the projection-side change above already logs the flip;
 *  this one only stores the classification input. */
export function noteCanonicalSystemFingerprint(session: Session, canonical: unknown): void {
    if (!session.metadata) return;
    const text = canonical === undefined || canonical === null ? "" : JSON.stringify(canonical) ?? "";
    const fp = canonical === undefined || canonical === null ? "-" : createHash("sha256").update(text).digest("hex").slice(0, 16);
    session.metadata[METADATA_CANONICAL_SYS_FP] = { fp, size: text.length };
}
