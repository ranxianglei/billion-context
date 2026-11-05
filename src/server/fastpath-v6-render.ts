// #5664 fastpath v6 render-snapshot plane — the "render station" of the
// three-station model (owner ruling 2026-11-04):
//
//   station 1  inbound / identity finalize (per turn, existing #5652 lane)
//   station 2  this snapshot: steady rounds APPEND one captured row per new
//               element; full-path rounds (arm/audit/fallback) DIFF against
//               the stored rows and APPEND the tail on growth. A RECAST IS
//               FORBIDDEN IN EVERY SCENARIO (owner ruling 2026-11-05):
//               any divergence requiring a stored-row rewrite/deletion — or
//               any post-death rebuild — KILLS the plane for that sid
//               permanently and the session rides the legacy full path.
//   station 3  outbound emit: prefix rows pass through verbatim from disk;
//               only the bounded window tail runs a kernel pass per request.
//
// Governing guarantees (contract i5664-plan.md, locked):
//
//  G0 byte-equivalence is verified, not assumed — every fast round re-runs
//     a BOUNDED kernel pass (last W frozen cores + this turn's new cores)
//     under a scratch state clone and compares its mapped first-F elements
//     against the last F stored rows byte-for-byte. Any mismatch falls back
//     to the full legacy path for THIS turn only (P7: disk is the source of
//     truth; the mirror loss costs one re-read).
//  G1 conservative conjunction gate — ANY red condition (title-gen, active
//     blocks, pending fold usage, absorb, fold-mode on, pressure, CCR on,
//     non-zero markers, snapshot-lane substitution, caps mismatch, audit
//     due…) keeps the ENTIRE pre-#5664 code path verbatim. The fallback is
//     structurally identical to "this feature does not exist".
//  G2 capture point = the exact array the baseline emits (rebuiltMessages
//     before system/ephemeral injection); steady capture stores raw strings
//     + parsed caches so the prefix never gets re-parsed or re-stringified.
//  G3 death verdict — a checksum-corrupt checkpoint, a structurally
//     diverged capture, or any unverifiable pre-existing snapshot kills the
//     plane for that sid PERMANENTLY (persisted as a kind='dead' log entry,
//     surviving restarts). No recast, no re-arm: byte-safety comes from
//     stopping, not from repairing. Never guess, never forward corrupt bytes.
//  P7 mirrors are caches (LRU byte budget); losing one = DB re-read.
import type { SessionStore } from "../persist.js";
import type { Session } from "../session.js";

type LogFn = (level: string, msg: string) => void;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Bounded render window W (frozen cores fed to the scratch kernel pass).
 *  Probe evidence (three strategies × mixed transcript × 28 turns): the
 *  suffix-only W-pass reproduces every element's outbound bytes exactly, so
 *  8 is plenty; env-tunable for operators. */
const PF_RENDER_WINDOW: number = (() => {
    const n = Number(process.env["BILI_PF_RENDER_WINDOW"] ?? 8);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 64) : 8;
})();

/** Every N engaged hit-turns force ONE full legacy pass whose capture diff
 *  re-verifies the stored rows end-to-end (the scheduled audit). */
export const PF_RENDER_AUDIT_EVERY: number = (() => {
    const n = Number(process.env["BILI_PF_RENDER_AUDIT_EVERY"] ?? 8);
    return Number.isFinite(n) && n >= 2 ? Math.min(Math.floor(n), 1024) : 8;
})();

/** tokenCount ≥ ratio × modelContextLimit ⇒ emergency pressure ⇒ legacy
 *  (the fold/expand machinery must see the whole view when the model is
 *  anywhere near its ceiling). */
const PF_RENDER_EMERGENCY_RATIO = 0.9;

/** In-memory mirror byte budget (raw row bytes summed); oldest world evicted
 *  first when over (P7 — re-hydrate from disk later, zero correctness cost). */
const MIRROR_BYTE_BUDGET = 256 * 1024 * 1024;
let mirrorBytes = 0;

/** Identity fingerprint — the ONLY dimensions that may change the stored
 *  row contents: the kernel-side rewrite surface (render strategy,
 *  reasoning-drop predicate) plus the core-shape class (multimodal).
 *  Any change red-gates that turn (caps-mismatch); if a subsequent legacy
 *  full pass then diverges from the stored rows the plane is killed for
 *  this sid (no-recast regime). model/maxDim/toolArmed are DELIBERATELY
 *  ABSENT: they are per-turn mapping-layer inputs (#5643 ruling §5, owner
 *  2026-11-05) — rows hold the post-rewrite generic core form, which no
 *  mapping input can alter, so a within-family model switch simply re-maps
 *  next turn with zero events and never touches snapshot validity. */
export interface RenderCaps {
    v: 1;
    strategy: string;
    droppable: boolean;
    multimodal: boolean;
}

function capsEqual(a: RenderCaps, b: RenderCaps): boolean {
    return (
        a.v === b.v &&
        a.strategy === b.strategy &&
        a.droppable === b.droppable &&
        a.multimodal === b.multimodal
    );
}

/** Stable serialization of the kernel's ACTIVE-block multiset — the structural-
 *  event witness at the snapshot boundary (#5643 补充裁定：快照必须随压缩演进).
 *  Block ids are never reused and `generation` advances on refold, so this
 *  string changes iff the fold layer changed the history layout since the
 *  last recorded signature. Pure server-side evidence; no client inference. */
export function activeBlocksSignature(blocks: readonly { blockId: string; generation?: string | number; active?: boolean }[]): string {
    const parts: string[] = [];
    for (const b of blocks) if (b.active) parts.push(`${b.blockId}:${b.generation ?? 0}`);
    parts.sort();
    return parts.join("|");
}

interface RenderMeta {
    v: 1;
    caps: RenderCaps;
    rowCount: number;
    estCum: number;
    textCum: number;
    imgCum: number;
    /** Active-block signature at this checkpoint (absent on pre-#5643补充裁定
     *  checkpoints ⇒ ""). Folded forward by post-ckpt 'rebase'/'append' log
     *  entries during hydration. */
    blocksSig?: string;
}

export interface RenderWorld {
    sid: string;
    /** Canonical post-kernel-rewrite generic core-form JSON per rendered
     *  ordinal (contiguous 0..n-1 over surviving elements). NEVER mapped
     *  wire bytes: the outbound message is re-mapped from these cores EVERY
     *  turn with that turn's model/mapping inputs (#5643 ruling §5 ②). */
    rows: string[];
    /** Parsed caches of `rows` (same index) — the green round splices these
     *  core rows ahead of the window output; they double as next round's
     *  verify baseline, so no downstream consumer may alias-mutate them. */
    rowsParsed: unknown[];
    caps: RenderCaps;
    /** Active-block signature recorded at the LAST commit ("" until any). The
     *  gate compares it against the live session: a move means the fold layer
     *  rewrote the layout since we last synchronized — one red "blocks-changed"
     *  round, then the full pass's diverged capture rebases the table (only
     *  when THAT round also carries a witness; see commitRenderCapture). */
    blocksSig: string;
    /** Cumulative Σ estimateCoreMessagesUpper over all current rows. */
    estCum: number;
    /** Cumulative Σ estimateCoreMessages over all current rows. */
    textCum: number;
    /** Cumulative image-reserve contribution of frozen rows. */
    imgCum: number;
    /** Set when this sid's plane is dead (no-recast regime) — diagnostic. */
    dead?: boolean;
    /** Green (fast-served) engaged-turn tick — % PF_RENDER_AUDIT_EVERY === 0
     *  ⇒ audit due. Consumed (zeroed) by ANY legacy full-capture round served,
     *  which IS the audit (the full byte path ran to completion).
     *  Invariant: a red-for-audit-due turn always lands in a legacy capture,
     *  so the obligation cannot stall the lane after N ticks. */
    auditTick: number;
}

const mirrors = new Map<string, RenderWorld>();
/** relay session id → pf sids owned by it (teardown sweep). */
const sessionSids = new Map<string, Set<string>>();

/** Owner rulings 2026-11-05. (#5689 review) NO UNWITNESSED recast in ANY
 *  scenario: structural divergence WITHOUT server-side evidence of a
 *  structural event, S4 corruption, row-table inconsistency, unverifiable
 *  pre-existing snapshots — all land here and stay dead forever. The #5643
 *  补充裁定 opened exactly one door OUT of that candidate set BEFORE death:
 *  a WITNESSED diverged capture rebases the table (commitRenderCapture's
 *  'rebase' op) instead of dying. Caps changes cannot alter stored bytes
 *  anymore (mapping inputs sit outside the fingerprint, #5643 ruling §5 ③):
 *  their failure mode is a red gate turn, absorbed by the audit cadence.
 *  A dead sid NEVER arms, hydrates, gates green, or commits again. The
 *  verdict is persisted as a kind='dead' log entry so every future process
 *  instance reaches the same conclusion. */
const deadSids = new Set<string>();

function killRenderPlane(store: SessionStore, sid: string, reason: string, log?: LogFn): void {
    if (!deadSids.has(sid)) {
        deadSids.add(sid);
        const rw = mirrors.get(sid);
        if (rw) rw.dead = true;
        log?.("error", `[${sid}] #5664 render plane KILLED PERMANENTLY (no-recast regime): ${reason}`);
        try {
            store.pfRenderCommit(sid, { rows: [], logEntries: [{ kind: "dead", payloadJson: JSON.stringify({ reason }) }] });
        } catch {
            /* soft: the in-memory verdict still binds this process; a storage
             * failure means the NEXT process rediscovers the same condition
             * through its own integrity checks (S4 / row table / cast guard) */
        }
    }
}

// ---------------------------------------------------------------------------
// Mirror lifecycle
// ---------------------------------------------------------------------------

function touchMirror(rw: RenderWorld): void {
    // LRU refresh: re-insert to move to the tail (iteration head = oldest).
    if (mirrors.has(rw.sid)) {
        mirrors.delete(rw.sid);
        mirrorBytes -= rw.rows.reduce((s, r) => s + r.length, 0);
    }
    mirrors.set(rw.sid, rw);
    mirrorBytes += rw.rows.reduce((s, r) => s + r.length, 0);
    while (mirrorBytes > MIRROR_BYTE_BUDGET && mirrors.size > 1) {
        const oldest = mirrors.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const victim = mirrors.get(oldest);
        mirrors.delete(oldest);
        if (victim) mirrorBytes -= victim.rows.reduce((s, r) => s + r.length, 0);
        // #5664 note: eviction is silent by design (P7 cache semantics).
    }
}

function registerSidForSession(sessionId: string, sid: string): void {
    let set = sessionSids.get(sessionId);
    if (!set) {
        set = new Set();
        sessionSids.set(sessionId, set);
    }
    set.add(sid);
}

export function clearWatermarkV6Render(sessionId: string): void {
    const set = sessionSids.get(sessionId);
    if (!set) return;
    for (const sid of set) {
        const rw = mirrors.get(sid);
        if (rw) {
            mirrors.delete(sid);
            mirrorBytes -= rw.rows.reduce((s, r) => s + r.length, 0);
        }
    }
    sessionSids.delete(sessionId);
}

/** Hydrate from disk (G3): ckpt integrity check first (S4 death verdict),
 *  then current-truth rows + post-ckpt log fold for the cumulative sums.
 *  Returns null on ANY inconsistency — caller serves the baseline path. */
function hydrateMirror(store: SessionStore, sid: string, log?: LogFn): RenderWorld | null {
    try {
        if (deadSids.has(sid)) return null;
        if (!store.pfRenderCkptIntact(sid)) {
            killRenderPlane(store, sid, "S4 checkpoint checksum mismatch (corrupt metadata)", log);
            return null;
        }
        const rowsRaw = store.pfRenderRows(sid);
        if (rowsRaw.length === 0) return null;
        const metaRead = store.pfRenderMeta(sid);
        let estCum = 0;
        let textCum = 0;
        let imgCum = 0;
        let expectedCount = -1;
        let capsJson = "";
        let blocksSig = "";
        if (metaRead?.ckpt) {
            const m = JSON.parse(metaRead.ckpt.metaJson) as RenderMeta;
            estCum = m.estCum ?? 0;
            textCum = m.textCum ?? 0;
            imgCum = m.imgCum ?? 0;
            expectedCount = m.rowCount;
            blocksSig = m.blocksSig ?? "";
            capsJson = metaRead.ckpt.metaJson;
            for (const e of metaRead.log) {
                const p = JSON.parse(e.payloadJson) as { de?: number; dt?: number; di?: number; n?: number; capsJson?: string; reason?: string; sharedPrefix?: number; from?: number; to?: number } & Partial<RenderMeta>;
                if (e.kind === "dead") {
                    killRenderPlane(store, sid, `persisted death verdict: ${p.reason ?? "unknown"}`, log);
                    return null;
                }
                if (e.kind === "cast") {
                    estCum = p.estCum ?? 0;
                    textCum = p.textCum ?? 0;
                    imgCum = p.imgCum ?? 0;
                    expectedCount = p.rowCount ?? -1;
                } else if (e.kind === "append") {
                    estCum += p.de ?? 0;
                    textCum += p.dt ?? 0;
                    imgCum += p.di ?? 0;
                    if (expectedCount >= 0) expectedCount += p.n ?? 0;
                } else if (e.kind === "rebase") {
                    // Post-ckpt rebases carry their own fresh checkpoint meta
                    // (the fold deletes the log), so a surviving 'rebase'
                    // entry here means an interrupted fold — treat as count
                    // reset to its journaled target.
                    if (typeof p.to === "number") expectedCount = p.to;
                }
            }
        } else {
            capsJson = "";
        }
        const rows: string[] = new Array(rowsRaw.length);
        const rowsParsed: unknown[] = new Array(rowsRaw.length);
        for (let i = 0; i < rowsRaw.length; i++) {
            const rj = rowsRaw[i].rowJson;
            if (rj === null || rowsRaw[i].pos !== i) {
                killRenderPlane(store, sid, `row-table inconsistency at pos ${rowsRaw[i].pos} (expected contiguous ${i})`, log);
                return null;
            }
            rows[i] = rj;
            try {
                rowsParsed[i] = JSON.parse(rj);
            } catch {
                killRenderPlane(store, sid, `row parse failed at pos ${i}`, log);
                return null;
            }
        }
        if (expectedCount !== -1 && expectedCount !== rows.length) {
            // Base sums no longer line up with the row table — the log fold
            // disagrees with truth. Only a rewrite of stored rows could fix
            // that, which is forbidden: kill the plane permanently.
            killRenderPlane(store, sid, `log-fold disagrees with row table (expectedCount=${expectedCount}, rows=${rows.length})`, log);
            return null;
        }
        let caps: RenderCaps | undefined;
        if (capsJson) {
            // The log payload stores caps VERBATIM (JSON.stringify(caps)); the
            // checkpoint meta wraps them as RenderMeta.caps.
            const parsed = JSON.parse(capsJson) as RenderCaps & Partial<RenderMeta>;
            // Two storage shapes coexist: render-log payloads carry caps
            // VERBATIM ({v,model,...}); the checkpoint meta WRAPS them as
            // {v,caps:{...},rowCount,...}. Accept both.
            const inner = (parsed.caps as RenderCaps | undefined);
            caps = inner && inner.v === 1 ? inner : (parsed.v === 1 ? parsed : undefined);
        } else {
            killRenderPlane(store, sid, "stored rows without capabilities (cannot gate safely)", log);
            return null;
        }
        if (!caps || caps.v !== 1) {
            killRenderPlane(store, sid, "unparseable capabilities fingerprint", log);
            return null;
        }
        const rw: RenderWorld = { sid, rows, rowsParsed, caps, blocksSig, estCum, textCum, imgCum, auditTick: 0 };
        touchMirror(rw);
        return rw;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Gate (station entry — called once per engaged request, cheap probes only)
// ---------------------------------------------------------------------------

interface RenderGateArgs {
    sessionId: string;
    session: Session;
    store: SessionStore;
    /** PRE-TURN active-block signature of the live session ("" = none).
     *  Compared against the world's last-committed signature: folded sessions
     *  stay green (compressed history IS steady state once synchronized), a
     *  signature move lands exactly one "blocks-changed" red round. Optional
     *  only for the test harness; production callers must pass it. */
    blocksSig?: string;
    /** true iff this request is an engaged v6 HIT (v6Evaluated.hit !== null). */
    engagedHit: boolean;
    /** true on the arm turn (first registration) — always rides legacy. */
    armedTurn: boolean;
    isTitleGen: boolean;
    /** the render plane sid (x-bili-pf-session / probe owner). */
    sid: string;
    /** absolute position of the LAST identity element (plane 1 world.maxPos). */
    maxPos: number;
    tokenCount: number;
    modelContextLimit: number;
    caps: RenderCaps;
    /** #3756 snapshot lane substituted the kernel view for this turn. */
    snapshotLaneActive: boolean;
    absorbActive: boolean;
    ccrOn: boolean;
    foldUsagePending: boolean;
    markerNonZero: boolean;
    log?: LogFn;
}

export type RenderGateDecision =
    | { ok: false; reason: string }
    | { ok: true; rw: RenderWorld; F: number };

/** Stable red-reason vocabulary (test-pinned, one per condition): not-engaged,
 *  arm-turn, title-gen, plane-unavailable, pressure, snapshot-lane,
 *  blocks-changed, fold-pending, absorb-active, ccr-on, markers, lane-dead,
 *  hydrate-failed, caps-mismatch, audit-due, no-rows, no-plane-geometry,
 *  rows-misaligned. */

/** G1 conservative conjunction — every red condition returns the reason so
 *  the lane stays debuggable; the fallback path is unchanged baseline. */
export function renderPlaneGate(args: RenderGateArgs): RenderGateDecision {
    const off = (reason: string): RenderGateDecision => ({ ok: false, reason });
    if (!args.engagedHit) return off("not-engaged");
    if (args.armedTurn) return off("arm-turn");
    if (args.isTitleGen) return off("title-gen");
    if (!args.store.pfRenderAvailable()) return off("plane-unavailable");
    if (args.tokenCount >= PF_RENDER_EMERGENCY_RATIO * args.modelContextLimit) return off("pressure");
    if (args.snapshotLaneActive) return off("snapshot-lane");
    if (args.foldUsagePending) return off("fold-pending");
    if (args.absorbActive) return off("absorb-active");
    if (args.ccrOn) return off("ccr-on");
    if (args.markerNonZero) return off("markers");
    if (deadSids.has(args.sid)) return off("lane-dead");
    let rw = mirrors.get(args.sid);
    if (rw === undefined) rw = hydrateMirror(args.store, args.sid, args.log) ?? undefined;
    // hydrate's own integrity failures persist a death verdict before
    // returning null — report the durable reason, not the transient one.
    if (rw === undefined) return off(deadSids.has(args.sid) ? "lane-dead" : "hydrate-failed");
    if (!capsEqual(rw.caps, args.caps)) return off("caps-mismatch");
    // #5643 补充裁定：快照必须随压缩演进。 Replaces the old blanket
    // "blocks-active" red-out: a folded session KEEPS SERVING FAST as long as
    // nothing changed structurally since the table's own commit. A moved
    // block multiset (new fold / refold / archive / host-side native
    // compaction surfaced through the block state) turns the plane red ONCE;
    // the forced full pass either confirms alignment (equal/append) or
    // rebases the table on its witnessed diverged capture.
    if ((rw.blocksSig ?? "") !== (args.blocksSig ?? "")) return off("blocks-changed");
    if (rw.auditTick % PF_RENDER_AUDIT_EVERY === 0 && rw.auditTick > 0) return off("audit-due");
    if (rw.rows.length < 1) return off("no-rows");
    if (args.maxPos < 0) return off("no-plane-geometry");
    // Alignment invariant: rows are captured per engaged round and always
    // number one row per ledger element (row i ↔ pos i), so at GATE time —
    // which runs BEFORE this round's finalize advances the plane —
    // rows.length must equal maxPos+1. A mismatch means an earlier commit
    // failed soft (disk ahead/behind the mirror): fall back to the legacy
    // byte path; the plane cannot self-heal anymore (no-recast regime) —
    // a persistent misalignment will die its next structural diff.
    if (rw.rows.length !== args.maxPos + 1) return off("rows-misaligned");
    registerSidForSession(args.sessionId, args.sid);
    // Window input = last F identity elements (+ new cores added by caller);
    // positions are contiguous because the ledger grows forward only (P3).
    const F = Math.min(PF_RENDER_WINDOW, rw.rows.length);
    return { ok: true, rw, F };
}

/** Bumped once per GREEN round (prepare-openai gate block). The obligation is
 *  consumed by any legacy full-capture round (commitRenderCapture zeroes it).
 *  Cadence = "one full pass per PF_RENDER_AUDIT_EVERY fast rounds", red turns
 *  included among those full passes. */
export function bumpAuditTick(sid: string): void {
    const rw = mirrors.get(sid);
    if (rw) rw.auditTick += 1;
}

// ---------------------------------------------------------------------------
// Fast-round verification + splice (station 3)
// ---------------------------------------------------------------------------

/** Compare THIS round's first-F rewritten window cores against the stored
 *  suffix AT THE CORE-FORM BOUNDARY (#5643 ruling §5 ③: the tripwire sits
 *  on post-rewrite generic cores — never on mapped wire bytes; the mapping
 *  chain runs fresh every turn and its inputs are excluded from identity).
 *  Pure byte compare. Returns false on ANY difference (incl. length). */
export function verifyRenderWindow(fastEmitsJson: string[], rw: RenderWorld, F: number): boolean {
    if (fastEmitsJson.length < F) return false;
    const start = rw.rows.length - F;
    if (start < 0) return false;
    for (let i = 0; i < F; i++) {
        if (fastEmitsJson[i] !== rw.rows[start + i]) return false;
    }
    return true;
}

/** Splice: prefix parsed CORE rows (cached) + this round's rewritten core
 *  tail. Row indices align with rendered ordinals (probe-verified
 *  positional determinism; the core-form byte check above is the tripwire).
 *  The concatenated core sequence then passes through the FULL mapping
 *  chain fresh this turn (#5643 ruling §5 ②) — nothing mapped is cached. */
export function spliceOutboundRows<T>(rw: RenderWorld, F: number, tail: T[]): T[] {
    const prefixLen = rw.rows.length - F;
    if (prefixLen < 0) throw new Error("#5664 splice prefix underflow");
    const out: T[] = [];
    // rowsParsed entries are JSON.parse of THIS plane's previously captured
    // rows — exactly T elements by construction (capture stores what egress
    // emitted, and egress emitted T). Shallow-clone each cached object: these
    // doubles as next round's verify baseline, so no downstream consumer may
    // alias-mutate the mirror cache (review P2-5).
    for (const x of rw.rowsParsed.slice(0, prefixLen)) {
        const y: T = x !== null && typeof x === "object" ? ({ ...(x as object) } as T) : (x as T);
        out.push(y);
    }
    out.push(...tail);
    return out;
}

// ---------------------------------------------------------------------------
// Capture commits (station 2) — invoked at finalize on EVERY engaged turn
// ---------------------------------------------------------------------------

export interface CaptureSums {
    estCum: number;
    textCum: number;
    imgCum: number;
}

type CaptureMode = "steady" | "legacy";

interface CaptureArgs {
    sessionId: string;
    store: SessionStore;
    sid: string;
    mode: CaptureMode;
    caps: RenderCaps;
    /** true iff THIS turn carries server-side evidence of a structural event
     *  (block-multiset signature moved around the kernel pass, dsh native-
     *  compaction rebase fired, or fold usage consumed). Only a witnessed
     *  diverged capture may rebase the table; an unwitnessed one kills.
     *  #5643 补充裁定。 */
    witness?: boolean;
    /** Active-block signature AFTER this turn's passes — recorded with the
     *  commit so the gate's next comparison starts from this round's truth. */
    blocksSig?: string;
    /** steady: ONLY the new tail raw strings; legacy: the FULL captured rows. */
    rowStrings: string[];
    sums: CaptureSums; // steady: DELTAS for the tail; legacy: ABSOLUTE totals.
    log?: LogFn;
}

/** 'equal' | 'append' | 'diverged' — prefix-identical growth vs anything
 *  else (byte diff, shrink, non-monotonic growth). Under the no-recast
 *  ruling every 'diverged' verdict KILLS the plane. */
export function diffRowLists(prev: string[], cur: string[]): "equal" | "append" | "diverged" {
    if (prev.length === cur.length) {
        for (let i = 0; i < prev.length; i++) if (prev[i] !== cur[i]) return "diverged";
        return "equal";
    }
    if (cur.length > prev.length) {
        for (let i = 0; i < prev.length; i++) if (prev[i] !== cur[i]) return "diverged";
        return "append";
    }
    return "diverged";
}

/** sids whose row payload carried a literal NUL and were therefore refused
 *  persistence (node:sqlite silently TRUNCATES bound strings at the first \0
 *  — storing would corrupt the row with S4 unable to see it, since the
 *  checksum only covers checkpoint meta). Loud-once, then fail-soft per turn:
 *  the in-memory mirror keeps serving this process's lifetime; disk simply
 *  stops advancing until restart or caps change allows re-capture again. */
const nulRejectedSids = new Set<string>();

export function commitRenderCapture(args: CaptureArgs): { committed: boolean; op: "none" | "append" | "cast" | "rebase" } {
    const { store, sid, caps, log } = args;
    if (deadSids.has(sid)) {
        // Belt-and-braces behind the gate: a dead sid NEVER arms/commits again.
        return { committed: false, op: "none" };
    }
    const hasNul = args.rowStrings.some((rj) => rj.includes("\u0000"));
    if (hasNul) {
        if (!nulRejectedSids.has(sid)) {
            nulRejectedSids.add(sid);
            log?.("error", `[${sid}] #5664 render row carries a literal NUL (node:sqlite truncates it silently) — plane persistence disabled for this sid`);
        }
        return { committed: false, op: "none" };
    }
    let rw = mirrors.get(sid);
    if (rw === undefined && !mirrors.has(sid)) {
        const hydrated = hydrateMirror(store, sid, log);
        if (hydrated !== null) {
            mirrors.set(sid, hydrated);
            rw = hydrated;
        }
    }
    const metaJson = (m: RenderMeta): string => JSON.stringify(m);
    if (rw === undefined || rw.rows.length === 0) {
        // Arm cast — allowed ONLY onto an empty table. The snapshot is
        // forged exactly ONCE per sid (owner ruling 2026-11-05: no recast,
        // no post-death rebuild): if rows already exist on disk, we cannot
        // verify them here and rewriting them is forbidden ⇒ kill.
        if (args.mode === "legacy") {
            let preExisting: { pos: number; rowJson: string | null }[];
            try {
                preExisting = store.pfRenderRows(sid);
            } catch {
                // A THROWN read is a transient storage hiccup, not evidence of
                // divergence: defer the arm to the next round (fail soft)
                // instead of killing over it — and never propagate, station 2
                // runs outside prepare-openai's try block, a throw here would
                // fail the whole request.
                log?.("warn", `[${sid}] #5664 render arm deferred this round: row-table read threw`);
                return { committed: false, op: "none" };
            }
            if (preExisting.length > 0) {
                killRenderPlane(store, sid, `arm refused over non-empty rows (${preExisting.length} pre-existing, unverifiable)`, log);
                return { committed: false, op: "none" };
            }
            const rows = args.rowStrings;
            const m: RenderMeta = { v: 1, caps, rowCount: rows.length, estCum: args.sums.estCum, textCum: args.sums.textCum, imgCum: args.sums.imgCum, blocksSig: args.blocksSig ?? "" };
            const okSeq = store.pfRenderCommit(sid, {
                rows: rows.map((rj, pos) => ({ pos, rowJson: rj })),
                logEntries: [{ kind: "cast", payloadJson: JSON.stringify({ ...m, capsJson: JSON.stringify(caps) }) }],
                checkpointMetaJson: metaJson(m),
            });
            if (okSeq === null) return { committed: false, op: "none" };
            const parsed = rows.map((rj) => safeParse(rj));
            mirrors.set(sid, { sid, rows: [...rows], rowsParsed: parsed, caps: { ...caps }, blocksSig: args.blocksSig ?? "", estCum: args.sums.estCum, textCum: args.sums.textCum, imgCum: args.sums.imgCum, auditTick: 0 });
            registerSidForSession(args.sessionId, sid);
            return { committed: true, op: "cast" };
        }
        // Steady turns without a base cannot append into nothing: skip (the
        // identity lane already served; next legacy turn builds the base).
        return { committed: false, op: "none" };
    }
    if (args.mode === "steady") {
        const prevLen = rw.rows.length;
        const rows = args.rowStrings;
        const okSeq = store.pfRenderCommit(sid, {
            rows: rows.map((rj, i) => ({ pos: prevLen + i, rowJson: rj })),
            logEntries: [{ kind: "append", payloadJson: JSON.stringify({ de: args.sums.estCum, dt: args.sums.textCum, di: args.sums.imgCum, n: rows.length }) }],
        });
        if (okSeq === null) return { committed: false, op: "none" };
        const parsed = rows.map((rj) => safeParse(rj));
        rw.rows.push(...rows);
        rw.rowsParsed.push(...parsed);
        rw.estCum += args.sums.estCum;
        rw.textCum += args.sums.textCum;
        rw.imgCum += args.sums.imgCum;
        touchMirror(rw);
        return { committed: true, op: "append" };
    }
    // A full-path round IS the audit regardless of verdict (the legacy byte
    // path ran to completion) — consume the cadence obligation here, or a
    // clean long run would dead-lock on "audit-due" after N ticks.
    if (args.mode === "legacy") rw.auditTick = 0;
    // legacy full-capture: diff against truth, minimal commit.
    const verdict = diffRowLists(rw.rows, args.rowStrings);
    if (verdict === "equal") {
        rw.caps = { ...caps }; // keep caps fresh even when bytes match
        rw.blocksSig = args.blocksSig ?? rw.blocksSig;
        touchMirror(rw);
        return { committed: true, op: "none" };
    }
    if (verdict === "append") {
        const prevLen = rw.rows.length;
        const tail = args.rowStrings.slice(prevLen);
        const delta = {
            estCum: Math.max(0, args.sums.estCum - rw.estCum),
            textCum: Math.max(0, args.sums.textCum - rw.textCum),
            imgCum: Math.max(0, args.sums.imgCum - rw.imgCum),
        };
        const okSeq = store.pfRenderCommit(sid, {
            rows: tail.map((rj, i) => ({ pos: prevLen + i, rowJson: rj })),
            logEntries: [{ kind: "append", payloadJson: JSON.stringify({ de: delta.estCum, dt: delta.textCum, di: delta.imgCum, n: tail.length }) }],
        });
        if (okSeq === null) return { committed: false, op: "none" };
        const parsed = tail.map((rj) => safeParse(rj));
        rw.rows.push(...tail);
        rw.rowsParsed.push(...parsed);
        rw.estCum = args.sums.estCum;
        rw.textCum = args.sums.textCum;
        rw.imgCum = args.sums.imgCum;
        rw.caps = { ...caps };
        rw.blocksSig = args.blocksSig ?? rw.blocksSig;
        touchMirror(rw);
        return { committed: true, op: "append" };
    }
    // DIVERGED (byte diff at any position, or shrink): the ONLY repair the
    // old design offered was a recast — rewriting covered ordinals and
    // deleting the excess. Owner ruling 2026-11-05 forbids that in every
    // scenario: the plane is KILLED PERMANENTLY instead and the session
    // rides the legacy full path from here on (bytes stay correct; the
    // cache simply never serves this sid again).
    // DIVERGED (byte diff at any position, or shrink): the ORIGINAL design
    // offered only recast; the owner ruling of 2026-11-05 sealed that door,
    // and the #5643 补充裁定 re-opened EXACTLY ONE gate in it — a WITNESSED
    // structural event (the turn's server-side evidence that the fold layer
    // rewrote the layout: block-multiset signature moved around the kernel
    // pass, dsh native-compaction rebase, or fold usage consumed) authorizes
    // a REBASE: the whole table is replaced by THIS capture in one
    // transaction, journaled as kind='rebase' under a fresh checkpoint.
    // Without a witness, divergence is still substrate corruption and KILLS
    // the plane permanently — that semantics is byte-for-byte unchanged.
    if (args.witness === true) {
        let common = 0;
        while (common < rw.rows.length && common < args.rowStrings.length && rw.rows[common] === args.rowStrings[common]) common += 1;
        const prevLen = rw.rows.length;
        const m: RenderMeta = { v: 1, caps, rowCount: args.rowStrings.length, estCum: args.sums.estCum, textCum: args.sums.textCum, imgCum: args.sums.imgCum, blocksSig: args.blocksSig ?? rw.blocksSig };
        const okSeq = store.pfRenderCommit(sid, {
            replaceAll: true,
            rows: args.rowStrings.map((rj, pos) => ({ pos, rowJson: rj })),
            logEntries: [{ kind: "rebase", payloadJson: JSON.stringify({ sharedPrefix: common, from: prevLen, to: args.rowStrings.length }) }],
            checkpointMetaJson: metaJson(m),
        });
        if (okSeq === null) return { committed: false, op: "none" };
        const parsed = args.rowStrings.map((rj) => safeParse(rj));
        rw.rows = [...args.rowStrings];
        rw.rowsParsed = parsed;
        rw.caps = { ...caps };
        rw.blocksSig = args.blocksSig ?? rw.blocksSig;
        rw.estCum = args.sums.estCum;
        rw.textCum = args.sums.textCum;
        rw.imgCum = args.sums.imgCum;
        rw.auditTick = 0; // the rebase round IS the audit — start fresh
        touchMirror(rw);
        log?.("info", `[${sid}] #5664 render plane REBASED on witnessed structural event (shared prefix ${common} row(s), table ${prevLen} -> ${args.rowStrings.length} rows)`);
        return { committed: true, op: "rebase" };
    }
    killRenderPlane(store, sid, `structural divergence (stored=${rw.rows.length} rows, captured=${args.rowStrings.length})`, log);
    return { committed: false, op: "none" };
}

function safeParse(json: string): unknown {
    try {
        return JSON.parse(json);
    } catch {
        return {};
    }
}

// ---------------------------------------------------------------------------
// Diagnostics / test surface
// ---------------------------------------------------------------------------

interface RenderDebugWorld {
    sid: string;
    rows: number;
    dead: boolean;
    caps: RenderCaps | undefined;
    estCum: number;
    textCum: number;
    imgCum: number;
    auditTick: number;
}

export function watermarkV6RenderDebugState(sessionId: string): { sids: RenderDebugWorld[] } {
    const set = sessionSids.get(sessionId);
    const sids: RenderDebugWorld[] = [];
    if (set) {
        for (const sid of set) {
            const rw = mirrors.get(sid);
            sids.push({
                sid, rows: rw?.rows.length ?? 0, dead: deadSids.has(sid),
                caps: rw?.caps, estCum: rw?.estCum ?? 0, textCum: rw?.textCum ?? 0, imgCum: rw?.imgCum ?? 0, auditTick: rw?.auditTick ?? 0,
            });
        }
    }
    return { sids };
}

/** Test-only: reset every mirror (never call from production paths). */
export function _resetWatermarkV6RenderTestState(): void {
    mirrors.clear();
    sessionSids.clear();
    nulRejectedSids.clear();
    deadSids.clear();
    mirrorBytes = 0;
}
