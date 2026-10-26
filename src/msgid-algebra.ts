// #4491 plugin-lane server history: id-set algebra over client-pinned message ids.
//
// The unified store already performs the mechanical half at ingest time
// (append at max(seq)+1, retire-on-absence, reactivate-on-return at the
// original seq, branch order in tail_json.tailSeqs). This module is the
// host-side judgment the store cannot make: whether a vanished cohort died
// by compression or plain deletion, and whether a whole-generation refresh
// is an epoch flip (controlled rebuild) rather than ordinary churn.
//
// Pure over id lists — no storage, no session state — so the stake tests
// pin every row of the issue's alignment table without a fixture. Caller
// preconditions (enforced by src/msgid-pin.ts validation upstream): both
// lists contain unique ids.

type VanishReason = "compressed" | "deleted";

interface VanishedEntry {
    id: string;
    reason: VanishReason;
}

interface AlignStats {
    /** Mass id refresh: treat as a generation switch — the observed set
     *  rebuilds the ledger from scratch (old rows stay retired in the
     *  append-only table; numbering continues from max(seq)+1, never
     *  reusing freed slots), instead of per-cell alignment. */
    epoch: boolean;
    /** Observed ids already present in the ledger (seq preserved). */
    kept: number;
    /** Newly observed ids, in observation order (take max(seq)+1..). */
    appends: string[];
    /** Ids present on both sides whose content signature changed — an edit:
     *  same identity, new bytes (the historian row replaces the old one in
     *  the view; the id stays the unique key). Empty when no sigs given. */
    edits: string[];
    /** Ledger ids missing from this observation, with the tombstone reason. */
    vanished: VanishedEntry[];
}

/** Observed-list overlap ratio below which (both sides long enough) the
 *  alignment declares a generation switch. 0.5: when at least half of what
 *  the client shows us is unknown to the ledger, per-cell alignment has no
 *  anchor to resync on — exactly the #4316 1057-mismatch shape. */
export const EPOCH_OVERLAP_THRESHOLD = 0.5;
/** Short histories never epoch-flip: a handful of rewritten messages is an
 *  edit session, not a generation change. */
export const EPOCH_MIN_LEN = 8;
/** A summary-framed message landing in the same observation as ≥N vanished
 *  ids classifies that cohort as compressed even without server-side fold
 *  coverage (client-native compaction lanes announce themselves this way). */
export const SUMMARY_BATCH_MIN = 3;

interface AlignOptions {
    /** Server fold-coverage ground truth: ids an ACTIVE block covers are
     *  vanish-by-compression by definition. */
    coveredIds?: ReadonlySet<string>;
    /** A summary-framed message appeared among the observed messages. */
    summarySeen?: boolean;
    currentSigs?: ReadonlyMap<string, string>;
    observedSigs?: ReadonlyMap<string, string>;
}

/** A core message carrying compression framing: a kernel compress tool
 *  result or a rendered acp_summary anchor. Used only as corroboration for
 *  the cohort classification — never as identity. */
export function looksLikeSummaryCarrier(m: { toolName?: string; text?: string }): boolean {
    if (m.toolName === "compress") return true;
    return typeof m.text === "string" && m.text.includes("acp_summary");
}

export function alignIdSet(current: readonly string[], observed: readonly string[], opts: AlignOptions = {}): AlignStats {
    const seen = new Set(current);
    const common: string[] = [];
    const appends: string[] = [];
    for (const id of observed) {
        if (seen.has(id)) common.push(id);
        else appends.push(id);
    }
    const observedSet = new Set(observed);
    const vanishedAll: string[] = [];
    for (const id of current) if (!observedSet.has(id)) vanishedAll.push(id);

    const ratio = observed.length > 0 ? common.length / observed.length : 0;
    const epoch = current.length >= EPOCH_MIN_LEN && observed.length >= EPOCH_MIN_LEN && ratio < EPOCH_OVERLAP_THRESHOLD;

    const reasonFor = (id: string): VanishReason => {
        if (opts.coveredIds?.has(id)) return "compressed";
        if (opts.summarySeen === true && vanishedAll.length >= SUMMARY_BATCH_MIN) return "compressed";
        return "deleted";
    };

    let edits: string[] = [];
    if (!epoch && opts.currentSigs !== undefined && opts.observedSigs !== undefined) {
        edits = common.filter((id) => {
            const a = opts.currentSigs!.get(id);
            const b = opts.observedSigs!.get(id);
            return a !== undefined && b !== undefined && a !== b;
        });
    }

    const gone = epoch ? [...current] : vanishedAll;
    return {
        epoch,
        kept: epoch ? 0 : common.length,
        appends: epoch ? [...observed] : appends,
        edits,
        vanished: gone.map((id) => ({ id, reason: reasonFor(id) })),
    };
}
