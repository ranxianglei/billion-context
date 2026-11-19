/**
 * #5874 / 2×2 — stage 0 (identity / world match) decision glue.
 *
 * Sits at the head of the chain (raw bytes → **stage 0** → protocol
 * conversion → kernel → egress). It runs the pure `matchWindow`
 * (identity.ts) on the l1_world world cursor and carries the R3 identity
 * fault policy (red gate R3):
 *
 *   - a cohort host that DECLARED the dual-channel (per-element msgids) but
 *     did not collect them all → the request is HARD-REJECTED (400) BEFORE
 *     any table/kernel side effect, and the fault feeds a fastpath-style
 *     breaker (10-minute window, 3 strikes → a persistent per-sid latch that
 *     keeps rejecting until an operator clears it). #7064 D1/D2: the fault
 *     path NEVER fires for CONVERSATION-BOUND sessions (the host conversation
 *     identity IS the identity) — the cursor is bookkeeping there.
 *
 * The decision itself is pure (identity.ts); this module adds the storage
 * glue (read the stored cursor, persist the new window) — and only for
 * verdicts that moved the cursor (echo/replay persist nothing: no write per
 * steady-state turn). The gone-set and the ledger frontier are COMPUTED by
 * the store (messages × blocks coverage, max live seq) and passed in: the
 * pure core never touches a table (pure-incremental redesign: there is no
 * per-row plane to read).
 */
import { matchAppendWindow, matchWindow, windowOf } from "./identity.ts";
import { snapL1Lookup, snapL1WindowRead, snapL1WindowUpsert } from "../storage/snap.ts";
import type { DbLike } from "../storage/snap.ts";
import type { WorldDecision } from "./types.ts";

/** R3 identity fault — the lane rejects the request with HTTP 400 and takes
 *  NO side effect (no ledger write beyond the R1 mapping, no kernel run). */
export class FoundationRejectError extends Error {
    readonly status = 400;
    constructor(public readonly reason: string) {
        super(`[snapshot] R3 identity fault: ${reason}`);
        this.name = "FoundationRejectError";
    }
}

/** R3 breaker: a per-process fault window (10 minutes) with a strike cap
 *  (3). On the third strike within the window the sid gets a PERSISTENT
 *  latch (the caller persists it) and every subsequent R3 fault for that
 *  sid rejects immediately without re-counting. Mirrors the
 *  incremental-lane breaker discipline (the R3 reference). */
export class R3FaultTracker {
    private readonly faults = new Map<string, { count: number; firstAt: number }>();
    private readonly latched = new Set<string>();
    constructor(
        private readonly windowMs: number = 10 * 60 * 1000,
        // readonly-public: the pre-latch strike log (stage0.ts) cites the
        // cap in its message.
        public readonly strikeCap: number = 3,
    ) {}

    /** Record an R3 fault. Returns the persistent-latch verdict. */
    recordFault(sid: string, now: number = Date.now()): { latched: boolean } {
        if (this.latched.has(sid)) return { latched: true };
        let entry = this.faults.get(sid);
        if (!entry || now - entry.firstAt > this.windowMs) {
            entry = { count: 0, firstAt: now };
            this.faults.set(sid, entry);
        }
        entry.count += 1;
        if (entry.count >= this.strikeCap) {
            this.latched.add(sid);
            return { latched: true };
        }
        return { latched: false };
    }

    /** Strikes recorded in the CURRENT window (a cleared or expired window
     *  reads 0) — the pre-latch 400s log their progress toward the latch so
     *  an operator sees a miscounting host BEFORE the sid latches for good. */
    strikes(sid: string, now: number = Date.now()): number {
        const entry = this.faults.get(sid);
        if (!entry || now - entry.firstAt > this.windowMs) return 0;
        return entry.count;
    }

    isLatched(sid: string): boolean {
        return this.latched.has(sid);
    }

    /** Operator escape hatch (paired with the persisted-latch clear at the
     *  `/__bili/snapshot/r3-unlatch` admin route — that route calls this for
     *  every sid the latched row can resolve to, since the in-memory latch
     *  alone would survive a same-process "clear" that misses its key). */
    clearLatched(sid: string): void {
        this.latched.delete(sid);
        this.faults.delete(sid);
    }
}

/** The process-wide R3 fault tracker (one per process; the lane consults it
 *  before every stage-0 run and records on every fault). Exported so tests
 *  can inspect/reset it. */
export const r3FaultTracker = new R3FaultTracker();

/** The stage-0 input: the raw identity channel for one turn.
 *  @param db            the storage db (snap.ts DbLike surface).
 *  @param sessRaw       the raw host session id (P9: never truncated).
 *  @param ledgerId      the bili canonical ledger identity (the sid).
 *  @param incoming      the per-element msgids in host order.
 *  @param resync        true for an explicit re-baseline (mode switch).
 *  @param maxSeq        the ledger frontier: the max live stamped seq
 *                       (store-computed; 0 for an empty ledger). The M2
 *                       contiguity evidence anchors on it.
 *  @param explainedGone the ids that legally vanished from the envelope
 *                       head — stored messages covered by a live fold
 *                       block (store-computed from messages × blocks).
 *  @param now           clock (injectable for tests).
 */
interface Stage0Input {
    db: DbLike;
    sessRaw: string;
    ledgerId: string;
    incoming: string[];
    /** The `biliLedgerSeqs` carrier (M2 position locating, #4316 layer-3
     *  transport). When it is contiguous and starts exactly after the
     *  ledger frontier, an ALL-UNKNOWN incoming is a pure M2 append
     *  (matchAppend); without it, an all-unknown incoming is
     *  treated as a full (possibly re-minted) envelope → the normal
     *  matchWorld verdict (usually diverge → resync, one-round
     *  convergence). */
    seqs?: number[] | null;
    resync?: boolean;
    maxSeq: number;
    explainedGone: Set<string>;
    /** D2 (#7064): the session carries a host conversation identity — the
     *  per-turn id verdict is skipped entirely (the cursor follows the
     *  incoming unconditionally; no replay guard, no R3 fault). */
    convBound?: boolean;
    now?: number;
}

export interface Stage0Result {
    /** The pure world-match verdict (identity.ts). */
    decision: WorldDecision;
    /** The fold-explained gone set — exposed for the reconcile and tests. */
    explainedGone: Set<string>;
}

/** Run stage 0: read the stored world cursor, match the incoming ids
 *  against it (with the store-computed gone set + frontier), and persist
 *  the new window whenever it moved (echo/replay write nothing). #7064
 *  D1: NO verdict rejects or resets — the strongest move is `reanchor`
 *  (re-issue the cursor from the incoming, one cheap UPDATE).
 *
 *  The pos values the verdict issues are the LOGICAL append-only cursor
 *  positions (maxPos+1..); the physical ledger seq is assigned by the
 *  ingest in the same incoming order, so the two agree for tail-appends.
 *  For scatter (middle insertion) the ingest re-homes in the same
 *  transaction. */
export function stage0Decide(input: Stage0Input): Stage0Result {
    const now = input.now ?? Date.now();
    const l1 = snapL1Lookup(input.db, input.sessRaw);
    const read = snapL1WindowRead(input.db, input.sessRaw);
    const explainedGone = input.explainedGone;
    const planeMaxSeq = input.maxSeq;

    const storedWindow = l1 && read !== null && read.window !== null ? read.window : null;
    const storedIssuedAt = l1 ? (read !== null ? read.issuedAt : l1.issuedAt) : 0;

    let decision: WorldDecision;
    const seqs = input.seqs ?? null;
    const storedSet = storedWindow !== null
        ? new Set([...storedWindow.headIds, ...storedWindow.tailIds])
        : null;

    // D2 (#7064): conversation-bound sessions skip the id verdict — the
    // host conversation identity IS the identity; the cursor follows the
    // incoming unconditionally (bookkeeping, never a reject).
    if (input.convBound) {
        const known = storedWindow !== null
            ? new Map<string, number>(storedWindow.tailIds.map((id, i) => [id, storedWindow.maxPos - storedWindow.tailIds.length + 1 + i]))
            : null;
        const incomingSet = new Set(input.incoming);
        let pos = storedWindow?.maxPos ?? 0;
        const newIdPos: Array<{ id: string; pos: number }> = [];
        for (const id of input.incoming) {
            if (known === null || known.get(id) === undefined) {
                pos += 1;
                newIdPos.push({ id, pos });
            }
        }
        // #6785 review (owner): an idempotent re-render (every incoming id
        // already windowed) moves the cursor NOWHERE — issue the same
        // zero-side-effect echo the non-bound replay path uses instead of
        // re-anchoring + upserting the unchanged row on every such turn.
        if (newIdPos.length === 0 && storedWindow !== null && input.incoming.length > 0 && !input.resync) {
            decision = {
                mode: "echo",
                replay: true,
                window: storedWindow,
                newIdPos: [],
                goneIds: [],
                issuedAt: storedIssuedAt,
                witness: "echo: conversation-bound, all ids known (cursor unchanged)",
            };
        } else {
            decision = {
                mode: "anchor",
                window: { ...windowOf(input.incoming, 0), maxPos: pos },
                newIdPos,
                goneIds: storedWindow !== null ? storedWindow.tailIds.filter((id) => !incomingSet.has(id)) : [],
                issuedAt: storedIssuedAt || now,
                witness: "anchor: conversation-bound, id verdict skipped",
            };
        }
    } else {
        // Review-round-2 Residual 1b: the host re-sent a body this proxy
        // already processed — every id is already in the stored windows and
        // the carrier seqs (when present) sit at/below the ledger frontier
        // (the original turn's in-request flush stamped them before its
        // response left). Zero side effects: the cursor is kept as-is, the
        // lane re-renders the SAME world (an idempotent kernel round).
        const replay =
            storedWindow !== null &&
            storedSet !== null &&
            !input.resync &&
            input.incoming.length > 0 &&
            input.incoming.every((id) => storedSet.has(id)) &&
            (seqs === null || seqs.every((s) => s <= planeMaxSeq));
        if (replay) {
            decision = {
                mode: "echo",
                replay: true,
                window: storedWindow,
                newIdPos: [],
                goneIds: [],
                issuedAt: storedIssuedAt,
                witness: `replay: all ${input.incoming.length} ids known (maxSeq ${seqs ? Math.max(...seqs) : "-"} <= frontier ${planeMaxSeq})`,
            };
        } else {
            // M2 pure append: the client sent ONLY new elements — every
            // incoming id is unknown to the windows — and the seqs carrier
            // says they land as a contiguous run starting exactly after the
            // ledger frontier. That is the 世界匹配定位序列位置 evidence:
            // issue append-only pos (maxPos+1..) without any head/order
            // risk. Anything less certain (missing seqs, a gap, a known id
            // mixed in) falls through to matchWindow — D1: the worst
            // outcome there is a reanchor, one cheap re-issue.
            const m2Candidate =
                storedWindow !== null &&
                !input.resync &&
                input.incoming.length > 0 &&
                seqs !== null &&
                seqs.length === input.incoming.length;
            let contig = m2Candidate && seqs![0] === planeMaxSeq + 1;
            if (contig) {
                for (let i = 1; i < seqs!.length; i++) {
                    if (seqs![i] !== seqs![i - 1] + 1) {
                        contig = false;
                        break;
                    }
                }
            }
            if (m2Candidate && contig && input.incoming.every((id) => !storedSet!.has(id))) {
                const appended = matchAppendWindow(storedWindow, input.incoming);
                decision = { ...appended, issuedAt: storedIssuedAt };
            } else {
                decision = matchWindow({
                    stored: storedWindow,
                    issuedAt: storedIssuedAt || now,
                    incoming: input.incoming,
                    sessRaw: input.sessRaw,
                    ledgerId: input.ledgerId,
                    now,
                    resync: input.resync,
                });
            }
        }
    }

    // Persist the window whenever it MOVED (echo/replay: no write per
    // steady-state turn — the cursor is unchanged by construction).
    if (decision.mode !== "echo") {
        snapL1WindowUpsert(input.db, input.sessRaw, decision.window);
    }

    return { decision, explainedGone };
}

/** The R3 identity check for a cohort host that DECLARED the dual-channel:
 *  the per-element msgid list must cover EVERY element of the body. A short
 *  (or empty, when the body is non-empty) collection is the identity gate
 *  fault → the caller throws FoundationRejectError (400, zero side effects)
 *  and records the fault on the tracker.
 *
 *  @param declared    the host profile declares per-element msgids (cohort).
 *  @param elementCount  the body element count (the msgs to be parsed).
 *  @param msgids      the collected per-element msgids (null/undefined =
 *                     the host sent none).
 *  @returns true when the turn may proceed (non-cohort, or full collection).
 */
export function checkR3Identity(
    declared: boolean,
    elementCount: number,
    msgids: string[] | null | undefined,
): boolean {
    if (!declared) return true; // non-cohort: sticky order>hash degrade
    if (elementCount === 0) return true;
    if (!msgids || msgids.length !== elementCount) return false;
    return true;
}
