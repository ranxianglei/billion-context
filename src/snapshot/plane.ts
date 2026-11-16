/**
 * #5874 / 2×2 — stage 0 (identity / world match) decision glue.
 *
 * Sits at the head of the chain (raw bytes → **stage 0** → protocol
 * conversion → kernel → egress). It runs the pure `matchWorld`
 * (identity.ts) on the l1_world element envelope and carries the R3 identity
 * fault policy (red gate R3):
 *
 *   - a cohort host that DECLARED the dual-channel (per-element msgids) but
 *     did not collect them all → the request is HARD-REJECTED (400) BEFORE
 *     any table/kernel side effect, and the fault feeds a fastpath-style
 *     breaker (10-minute window, 3 strikes → a persistent per-sid latch that
 *     keeps rejecting until an operator clears it).
 *
 * The decision itself is pure (identity.ts); this module adds the storage
 * glue (read the stored envelope, persist the new canon) — and ONLY for
 * non-diverge verdicts (a diverge turn has zero side effects by
 * construction). The gone-set and the ledger frontier are COMPUTED by the
 * store (messages × blocks coverage, max live seq) and passed in: the pure
 * core never touches a table (pure-incremental redesign: there is no
 * per-row plane to read).
 */
import { matchAppend, matchWorld, parseEnvelope } from "./identity.ts";
import { snapL1EnvelopeRead, snapL1EnvelopeUpsert, snapL1Lookup } from "../storage/snap.ts";
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
    now?: number;
}

export interface Stage0Result {
    /** The pure world-match verdict (identity.ts). */
    decision: WorldDecision;
    /** True when the verdict is `diverge` — the caller runs this turn on the
     *  legacy path with ZERO identity side effects (the canon is untouched;
     *  the client converges one turn later). */
    diverge: boolean;
    /** The fold-explained gone set — exposed for the reconcile and tests. */
    explainedGone: Set<string>;
}

/** Run stage 0: read the stored element envelope, match the incoming ids
 *  against it (with the store-computed gone set + frontier), and (for every
 *  verdict except `diverge`) persist the new canon. A `diverge` turn writes
 *  NOTHING (zero side effects).
 *
 *  The pos values the verdict issues are the LOGICAL append-only envelope
 *  positions (maxPos+1..); the physical ledger seq is assigned by the
 *  ingest in the same incoming order, so the two agree for tail-appends.
 *  For scatter (middle insertion) the ingest re-homes in the same
 *  transaction. */
export function stage0Decide(input: Stage0Input): Stage0Result {
    const now = input.now ?? Date.now();
    const l1 = snapL1Lookup(input.db, input.sessRaw);
    const env = snapL1EnvelopeRead(input.db, input.sessRaw);
    const explainedGone = input.explainedGone;
    const planeMaxSeq = input.maxSeq;

    const stored =
        l1 && env && env.envelopeJson !== null && env.envelopeChecksum !== null
            ? {
                  ledgerId: l1.ledgerId,
                  envelope: parseEnvelope(env.envelopeJson).envelope,
                  envelopeChecksum: env.envelopeChecksum,
                  issuedAt: l1.issuedAt,
                  armedAt: l1.armedAt ?? undefined,
              }
            : null;

    let decision: WorldDecision;
    const seqs = input.seqs ?? null;
    const storedSet = stored !== null ? new Set(stored.envelope.map((e) => e.id)) : null;
    // Review-round-2 Residual 1b: the host re-sent a body this proxy already
    // processed — every id is already in the stored canon and the carrier
    // seqs (when present) sit at/below the ledger frontier (the original
    // turn's in-request flush stamped them before its response left). Zero
    // side effects: the canon is kept as-is, the lane re-renders the SAME
    // world (an idempotent kernel round). Without this guard the M2 retry
    // ([m5] vs head m1) would headMove → diverge → envelope reset: a
    // harmless retry would WIPE the identity canon.
    if (
        stored !== null &&
        storedSet !== null &&
        !input.resync &&
        input.incoming.length > 0 &&
        input.incoming.every((id) => storedSet.has(id)) &&
        (seqs === null || seqs.every((s) => s <= planeMaxSeq))
    ) {
        decision = {
            mode: "echo",
            replay: true,
            envelope: stored.envelope,
            envelopeChecksum: stored.envelopeChecksum,
            newIdPos: [],
            goneIds: [],
            issuedAt: stored.issuedAt,
            witness: `replay: all ${input.incoming.length} ids known (maxSeq ${seqs ? Math.max(...seqs) : "-"} <= frontier ${planeMaxSeq})`,
        };
    } else {
        // M2 pure append: the client sent ONLY new elements — every
        // incoming id is unknown to the canon — and the seqs carrier says
        // they land as a contiguous run starting exactly after the ledger
        // frontier. That is the 世界匹配定位序列位置 evidence: issue
        // append-only pos (maxPos+1..) without any head/order risk.
        // Anything less certain (missing seqs, a gap, a known id mixed in)
        // falls through to matchWorld — an all-unknown full array there is
        // usually a re-mint and diverges → resync, one-round convergence.
        // Never guess.
        const m2Candidate =
            stored !== null &&
            !input.resync &&
            input.incoming.length > 0 &&
            seqs !== null &&
            seqs.length === input.incoming.length;
        if (m2Candidate) {
            const allUnknown = input.incoming.every((id) => !storedSet!.has(id));
            let contig = seqs![0] === planeMaxSeq + 1;
            if (contig) {
                for (let i = 1; i < seqs!.length; i++) {
                    if (seqs![i] !== seqs![i - 1] + 1) {
                        contig = false;
                        break;
                    }
                }
            }
            decision = allUnknown && contig
                ? matchAppend(stored, input.incoming)
                : matchWorld({
                      stored,
                      incoming: input.incoming,
                      explainedGone,
                      sessRaw: input.sessRaw,
                      ledgerId: input.ledgerId,
                      now,
                      resync: input.resync,
                  });
        } else {
            decision = matchWorld({
                stored,
                incoming: input.incoming,
                explainedGone,
                sessRaw: input.sessRaw,
                ledgerId: input.ledgerId,
                now,
                resync: input.resync,
            });
        }
    }

    // Persist the canon for every verdict EXCEPT diverge (zero side effects).
    if (decision.mode !== "diverge") {
        snapL1EnvelopeUpsert(
            input.db,
            input.sessRaw,
            JSON.stringify(decision.envelope),
            decision.envelopeChecksum,
        );
    }

    return { decision, diverge: decision.mode === "diverge", explainedGone };
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
