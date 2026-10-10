import { markDirty, type Session } from "./session.js";

// #2638: session-level memory of spans whose preflight preview returned the kernel's
// STRUCTURAL "no new compressible messages" verdict. The kernel keeps advertising such spans
// (its recommend side does not mirror applySingleRange's live-carrier carve-out — see the
// issue for the minimal geometry), so without this memory every request re-nominates and
// re-rejects them: wasted preview work, warn spam, and — because the span's mass can never
// fold through plain refs — an auto-fold no-progress backoff cycle that resurrects classic
// nudges pointing the model at the same dead span. Entries are keyed by the exact
// startRef:endRef the kernel resolved; chunk-boundary shifts across turns self-heal through
// one extra preview (record again), and the cap bounds total memory.

const MAX_DEAD_RANGES = 64;
const STORAGE_KEY = "preflightDeadRanges";

interface DeadRangeEntry {
    key: string;
    startRef: string;
    endRef: string;
    /** Block ids named in the verdict ("covered by active block(s) b3, b5") — diagnostics
     *  only; invalidation deliberately does NOT trust the name list (see activeSnapshot). */
    blocks: string[];
    /** Sorted active block ids at record time. The entry stays dead only while EVERY one of
     *  them is still active (subsumption). */
    activeSnapshot: string[];
}

function readStore(session: Session): DeadRangeEntry[] {
    const raw = session.metadata?.[STORAGE_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is DeadRangeEntry =>
        !!e && typeof e === "object"
        && typeof (e as DeadRangeEntry).key === "string"
        && typeof (e as DeadRangeEntry).startRef === "string"
        && typeof (e as DeadRangeEntry).endRef === "string"
        && Array.isArray((e as DeadRangeEntry).blocks)
        && Array.isArray((e as DeadRangeEntry).activeSnapshot));
}

function writeStore(session: Session, store: DeadRangeEntry[]): void {
    (session.metadata ?? (session.metadata = {}))[STORAGE_KEY] = store;
    markDirty(session);
}

function activeBlockIds(session: Session): string[] {
    return session.state.blocks.filter((b) => b.active).map((b) => b.blockId).sort();
}

/** Both structural-empty wordings the kernel emits for a span with zero foldable content:
 *  - the #199 livelock guard: "...contains no new compressible messages — every message in it
 *    is already covered by active block(s) b3..."
 *  - validateCompressionRange: "Range contains no compressible messages — all are already
 *    covered by active blocks or protected."
 * Returns the named covering blocks ([] for the unnamed variant); null when the verdict is
 * NOT structural-empty — transient, zone, min-gate and length rejections must stay retryable
 * (they can clear mid-invocation or next turn). Feed the RAW kernel error strings, not a
 * truncated/joined rendering: the named-block list must survive intact. */
export function parseStructuralEmptyVerdict(verdict: string): string[] | null {
    if (!/no (?:new )?compressible messages/.test(verdict)) return null;
    const named = /active block\(s\) ([A-Za-z0-9]+(?:,\s*[A-Za-z0-9]+)*)/.exec(verdict)?.[1] ?? "";
    return named ? named.split(/,\s*/).filter(Boolean) : [];
}

export function recordDeadRange(session: Session, startRef: string, endRef: string, namedBlocks: string[]): void {
    const key = `${startRef}:${endRef}`;
    const store = readStore(session).filter((e) => e.key !== key);
    store.push({ key, startRef, endRef, blocks: namedBlocks, activeSnapshot: activeBlockIds(session) });
    while (store.length > MAX_DEAD_RANGES) store.shift();
    writeStore(session, store);
}

/** Keys still dead under the current state. Prunes invalidated entries in place.
 *
 * Invalidation is SNAPSHOT SUBSUMPTION, not the verdict's name list: the livelock guard names
 * only the NESTED blocks whose coverage made the span empty, but the span's deadness also
 * rests on whatever else carved its members out — notably LIVE CARRIER blocks (a checkpoint
 * message's summaryOfBlockId target must stay active or the carrier becomes plain-foldable
 * again), and those targets are never named in the verdict. Any active block dying anywhere
 * in the session (consumed by a distillation, deactivated, expanded) therefore wakes every
 * entry conservatively; append-only message growth never does, and a false wake costs exactly
 * one CPU-only preview before the entry re-records itself. */
export function deadSkipKeys(session: Session): Set<string> {
    const current = new Set(activeBlockIds(session));
    const seen = readStore(session);
    const kept = seen.filter((e) => e.activeSnapshot.every((id) => current.has(id)));
    if (kept.length !== seen.length) writeStore(session, kept);
    return new Set(kept.map((e) => e.key));
}

/** Drop remembered-dead ranges from an advertised list (nudge surface, preflight candidates).
 *  Exact key match only — a wider advertised range that merely CONTAINS a dead chunk stays:
 *  its live members outside the chunk are genuinely foldable. */
export function filterDeadRanges<T extends { startRef: string; endRef: string }>(session: Session, ranges: readonly T[]): T[] {
    const dead = deadSkipKeys(session);
    return ranges.filter((r) => !dead.has(`${r.startRef}:${r.endRef}`));
}
