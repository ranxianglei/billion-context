/**
 * #5874 — snapshot-table compression foundation: shared types.
 *
 * This module is the TYPE-ONLY surface of the foundation. It deliberately
 * depends on nothing but the kernel's public types so it can be imported from
 * any layer (storage, server, tests) without creating a cycle. The six-stage
 * fixed chain (§0 of the proposal) is:
 *
 *   raw bytes → protocol convert (common core) → rewrite (compress) →
 *   snapshot-table apply → egress map → outbound
 *
 * The rows store the COMMON-CORE form on the RIGHT of the rewrite layer
 * (invariant v: wire bytes are never cached). The `pos` is the absolute
 * ledger position of one host envelope element (append-only, never reused).
 */

/** The five event kinds the rewrite layer may emit (§4.2). Addressed ONLY by
 *  kernel-pipeline evidence (block coverage / ledgerSeq / frame boundary) —
 *  never by fuzzy similarity. An unexplained diff yields NO events this turn
 *  (the whole turn degrades to legacy, red gate R2). */
export type SnapEventKind = "cast" | "append" | "update" | "delete" | "compact";

/** One structured event from the rewrite layer. `pos` is the addressed ledger
 *  position (1-based envelope slot). `coreIds` are the common-core ids that
 *  address the row (kernel-pipeline evidence). `evidence` records WHICH kernel
 *  fact addressed it (block id / seq span) so the audit stream is grep-able. */
export interface SnapEvent {
    kind: SnapEventKind;
    pos: number;
    coreIds: string[];
    /** The kernel fact that addressed this row (e.g. a blockId for compact,
     *  "new" for append, a content-hash change tag for update). */
    evidence: string;
    /** For `compact`: the block that absorbs the covered segment. */
    blockId?: string;
    /** For `update`: the sha256 digest of the PRE form's CAS body (ruling A). */
    preHash?: string;
}

/** World-match verdicts for stage 0 (§4.0). Executed in order; first hit wins.
 *  - `echo`: the host's returned ids match the server canon positionally (and
 *    the sampled witness passes) → adopt directly.
 *  - `probe`: the stored envelope is a strict prefix of the incoming one →
 *    the client grew; extend the canon (same world).
 *  - `issue`: no stored world for this sess_raw → issue a fresh ledger
 *    identity and pay one arming turn.
 *  - `diverge`: the head of the envelope changed (client rewrote history) →
 *    this turn runs legacy and re-stamps; the canon is NOT updated.
 *  - `resync`: an explicit re-baseline (mode switch / ledger re-issue). */
/** One entry in the standing canon envelope: a host msgid bound to the
 *  append-only ledger pos it was first issued at (pos is never reused —
 *  the DDL invariant). The canon is stored as an ordered [{id, pos}] list so
 *  the L1 table is self-contained (world = id + pos, §4.0 ruling G). */
export interface WorldEnvelopeEntry {
    id: string;
    pos: number;
}

/** World-match verdicts for stage 0 (§4.0). Executed in order; first hit
 *  wins. The envelope is the host msgid list in host order; each known msgid
 *  keeps its append-only pos, each NEW msgid is issued a fresh pos (maxPos+
 *  1..), so NEW elements may be scattered at any body position (§4.1 span
 *  parse) without disturbing the stored rows.
 *  - `echo`: the incoming id sequence matches the stored one positionally →
 *    adopt directly (witness spot-check).
 *  - `probe`: the stored id sequence is a strict PREFIX of the incoming one
 *    → tail append (the common case; the v5-proven shape).
 *  - `scatter`: known ids keep their relative order but NEW ids are inserted
 *    in the middle / at any position → the span-parse case (T5 byte pin).
 *  - `issue`: no stored world for this sess_raw → issue a fresh ledger
 *    identity and pay one arming turn.
 *  - `diverge`: the HEAD of the envelope changed, or a KNOWN id changed its
 *    relative order (the client rewrote history) → this turn runs legacy and
 *    re-stamps; the canon is NOT updated (the client converges in one turn).
 *  - `resync`: an explicit re-baseline (mode switch / ledger re-issue).
 *
 *  Deletions (a stored id absent from the incoming) are orthogonal to the
 *  mode and are reported via `goneIds` → the reconcile turns them into
 *  `delete` events (they are not a divergence as long as the head and the
 *  relative order of the survivors are unchanged). */
export type WorldMode = "echo" | "probe" | "scatter" | "issue" | "diverge" | "resync";

export interface WorldDecision {
    mode: WorldMode;
    /** The canon envelope to persist after this turn (host ids in host
     *  order, each bound to its append-only pos). For `diverge` this is the
     *  UNCHANGED stored canon. */
    envelope: WorldEnvelopeEntry[];
    /** sha256 of the id sequence (host order) — the fast mismatch before the
     *  positional walk. */
    envelopeChecksum: string;
    /** The NEW ids issued this turn (id → fresh pos), in incoming order.
     *  Empty for echo / diverge. */
    newIdPos: Array<{ id: string; pos: number }>;
    /** The stored ids ABSENT from the incoming (client deletions) — the
     *  reconcile turns these into `delete` events. Empty for issue / echo.
     *  Present for probe / scatter (a deletion is not a divergence while the
     *  head and survivor order are unchanged). */
    goneIds: string[];
    /** For `issue`: the freshly issued ledger identity (the existing sid
     *  keyspace, ruling D). Absent otherwise. */
    issuedLedgerId?: string;
    /** The world origin (issued_at) — carried so the caller can preserve it
     *  on a plain update (B1 trap: it never moves except on issue/resync). */
    issuedAt: number;
    /** The arming-turn marker set on `issue`/`resync`. */
    armedAt?: number;
    /** Diagnostic witness sample (echo spot-check) — warn stream only. */
    witness?: string;
}

/** The three-piece checkpoint meta (§4.3, ruling F+C): ① the serialized
 *  kernel session state (+ its own checksum) — the kernel has no
 *  deterministic "events → state" rebuild entry, so the state rides the
 *  checkpoint (zero kernel change + P7: memory is just a cache); ② the
 *  COVERAGE MAP (summary pos → covered pos interval) — the delete/compact
 *  payloads are absorbed by the ckpt, so after a fold this explicit map is
 *  the ONLY basis for decompress/GC; ③ the S4 aggregate checksum. */
export interface CheckpointMeta {
    v: 1;
    /** The serialized kernel CompressionState (mergeState-shaped). */
    kernelState: Record<string, unknown>;
    /** sha256 of the canonical kernelState serialization. */
    stateChecksum: string;
    /** summary pos → the contiguous covered pos interval [lo, hi] (inclusive)
     *  and the absorbing block id. */
    coverage: Record<string, { lo: number; hi: number; blockId: string }>;
    /** S4 aggregate over the active rows at fold time. */
    s4: string;
}

/** Plane health for one session. `green` = the snapshot plane is the source
 *  of truth for egress; `red` = fall back to the legacy kstate path. R1 (S4 /
 *  checksum bad) and R4 (structural-pending lost) are PERMANENT for the sid. */
export type PlaneHealth = "green" | "red";

export interface PlaneState {
    health: PlaneHealth;
    /** The red reason when health === "red" (R1 | R2 | R3 | R4 | "off" |
     *  "no-tables" | "unreadable"). */
    reason?: string;
    /** The L1 world (identity) for this session, when present. */
    world?: {
        ledgerId: string;
        /** The canon envelope (ordered {id, pos}, host order). */
        envelope: WorldEnvelopeEntry[];
        /** The msgid → append-only pos map (derived from the envelope). */
        posMap: Record<string, number>;
        envelopeChecksum: string;
        issuedAt: number;
        armedAt?: number;
    };
    /** The active rows (pos → cores), when readable. */
    rows?: Map<number, SnapshotRowView>;
    /** The latest checkpoint meta, when present. */
    meta?: CheckpointMeta;
    /** The committed event frontier (max over log and ckpt). */
    frontier: number;
    /** The wall-clock turn counter used for the ckpt cadence. */
    turnCount: number;
}

/** A read-side view of one snap_rows entry (deactivated rows carry their
 *  covering-block anchor for the GC lifecycle, ruling B). */
export interface SnapshotRowView {
    pos: number;
    coreIds: string[];
    /** The common-core form on the right of the rewrite layer (the only form
     *  that may be cached, invariant v). Serialized BiliMessage[]. */
    postJson: string;
    /** CAS digest of the PRE form (ruling A) — null when the row has no
     *  distinct pre form (a fresh append/cast). */
    preJson: string | null;
    tokensEst: number;
    active: boolean;
    coverRef: string | null;
    updatedAt: number;
}

/** The red-gate identifiers (§7). Each maps to a decision function in
 *  lane.ts so the lane-decisions matrix can assert them in positive/negative
 *  pairs (#3617 discipline). */
export type RedGate = "R1" | "R2" | "R3" | "R4";

/** The decision token vocabulary for the observability stream (§10): the
 *  lane decision is one of these, grep-able. */
export type DecisionToken =
    | "hit" // snapshot plane served the egress
    | "miss" // fell back to legacy (non-red)
    | `red:${RedGate}` // a red gate fired
    | "degrade" // non-cohort / order>hash sticky degrade write
    | "resync" // explicit re-baseline
    | "arm"; // new-identity arming turn

/** The input to the per-turn reconciliation (stages 2–3). Everything is
 *  derived by the server from the existing prepare run + the parsed body; the
 *  foundation only reconciles and commits. */
export interface ReconcileInput {
    sessionId: string;
    /** The CURRENT row ledger (pos → view), active AND inactive (so a re-fold
     *  can see what is already deactivated). */
    currentRows: Map<number, SnapshotRowView>;
    /** The host msgid ENVELOPE for this turn (host order, one entry per body
     *  element). Index i → element i. */
    envelope: string[];
    /** The msgid → append-only pos map for this turn (the world decision's
     *  canon AFTER issuing the NEW pos). Element i's pos is
     *  `posMap[envelope[i]]`. pos is append-only and never reused (a middle
     *  insertion does NOT shift stored rows). */
    posMap: Record<string, number>;
    /** The per-element parsed cores from stage 1 (index i → element i). In
     *  mode A this is the full-array parse (every element's cores); in mode B
     *  the span parse only fills the NEW elements (the rest are empty — their
     *  cores are read from the rows). */
    parsedCores: Array<Array<{ id: string; toolName?: string; toolCallId?: string }>>;
    /** The core ids that each ACTIVE kernel block covers (the block id →
     *  covered core ids), plus the fold's tool-call id. `compressCallId`
     *  is the kernel block's tool-call attribution — the evidence that an
     *  envelope element is the HIDDEN CARRIER of a fold (the kernel drops
     *  the compress tool-call/result pair from the model view; the pair's
     *  call id === the block's compressCallId). Only active blocks address
     *  rows. */
    blockCoverage: Array<{ blockId: string; coreIds: string[]; compressCallId?: string | null }>;
    /** The model-visible cores AFTER the rewrite (the flat view prepare
     *  produced). Used to source the per-element post-rewrite form so the
     *  stored bytes are byte-identical to what the model saw (T4). */
    modelView: Array<{ id: string }>;
    /** Whether a fold happened THIS turn (a new block was created). */
    foldedThisTurn: boolean;
    /** The serialized kernel CompressionState AFTER the rewrite (the ckpt
     *  meta's first piece; mergeState-shaped). The kernel has no
     *  deterministic "events → state" rebuild entry, so the state rides the
     *  checkpoint (ruling F, P7: memory is just a cache). */
    kernelState: Record<string, unknown>;
    now: number;
    turnCount: number;
    /** Fold cadence: emit a ckpt every N turns (bounded log lifetime). */
    ckptEveryNTurns: number;
    /** Full-scope commit (a model request: the envelope spans the whole
     *  client view) vs FOLD-ONLY commit (the plugin endpoint: no envelope —
     *  the fold hook knows only the covered range). A fold-only commit has
     *  NO authority over the tail: un-covered rows are carried forward
     *  unchanged (they stay in the ckpt's S4 aggregate) and the
     *  "active row absent from desired → delete" sweep is skipped. */
    scopeFull?: boolean;
    /** The core ids the kernel keeps VISIBLE despite block coverage: the
     *  pinned opening user core run (rebuildMessages never hides the first
     *  user message's wire run, even when a fold covers it). A covered row
     *  whose core is in this set stays ACTIVE (it still renders to the
     *  egress) while carrying the covering block as its lifecycle anchor.
     *  Without this the table egress would drop the pinned head and the
     *  bytes would diverge from the legacy view (T4). */
    pinnedHeadIds?: readonly string[];
}

/** The output of reconciliation: the events to commit, the upsert rows, and
 *  (optionally) the checkpoint. `joinOk` is false when the join chain broke
 *  (R2): the caller commits NOTHING and runs the whole turn legacy. */
export interface ReconcileOutput {
    events: SnapEvent[];
    /** The rows to upsert (evidence-addressed only — a no-op turn upserts
     *  nothing). */
    rows: Array<{
        pos: number;
        coreIds: string[];
        postJson: string;
        preJson: string | null;
        tokensEst: number;
        active: boolean;
        coverRef: string | null;
    }>;
    /** CAS bodies to put in the same transaction (ruling A). */
    preContents: Array<{ hash: string; content: string }>;
    /** Set when the ckpt cadence fired (or a fold happened): the meta to
     *  checkpoint. */
    ckpt?: { meta: CheckpointMeta; s4: string };
    joinOk: boolean;
}

/** Egress input (stage 4): the active rows IN HOST ENVELOPE ORDER (the model
 *  message order — for the append-only common case host order == pos order;
 *  for a scattered insertion host order is the correct model order) plus the
 *  cores parsed this turn for the NEW elements. The caller orders the rows by
 *  the world's host envelope. */
export interface EgressInput {
    /** Active rows in HOST ENVELOPE ORDER (deactivated rows excluded). */
    activeRows: Array<{ pos: number; postJson: string }>;
    /** The common-core form for the NEW elements, in host order (the envelope
     *  elements not yet in the ledger this turn). */
    tailCores: Array<Array<unknown>>;
}

export interface EgressOutput {
    /** The flat egress view (stage 4): active rows' cores ++ tail cores. This
     *  is what coreToX maps to the target wire protocol. */
    cores: unknown[];
    /** How many cores came from the stable prefix (rows) vs the fresh tail —
     *  diagnostic for the observability stream. */
    prefixCount: number;
    tailCount: number;
}
