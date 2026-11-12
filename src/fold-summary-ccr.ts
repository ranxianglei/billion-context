import {
    buildStoredPlaceholder,
    defaultCountTokens,
    hasStoredRef,
    indexToRef,
    isRenderedSummaryMessage,
    normalizeHead,
    storeOriginal,
    type CoreMessage,
    type MessageContentStore,
} from "acp-kernel";
import { featureEnabled } from "./rollout.js";
import type { Session } from "./session.js";
import { ccrEnabled, contentStoreOf, effectiveCcr, retrieveToolName, adoptContentStore } from "./store.js";

// #6111 POC (from #6025): render proxy-mode fold summaries as CCR placeholders
// on the OUTBOUND view instead of inline prose. A wall of summary text re-voiced
// as a user message is what weak models misread as the current question; a short
// deterministic placeholder + on-demand acp_retrieve removes that confusion
// surface while keeping the prose one tool call away.
//
// Rendered summaries (id = "acp_summary_<blockId>") are VIEW-ONLY and never
// receive a kernel-assigned ref: assignRefs runs BEFORE prune renders them, so
// they cannot ride the standard "covered original by ref" path. We therefore mint
// a STABLE synthetic ref per blockId in a reserved high band far above any
// realistic counter ref (refs are allocated monotonically and realistically stay
// below ~10^5; the band starts at 5*10^6) and store the summary prose under it in
// the session content store. Retrieval resolves via the store's own byRef index
// (executeRetrieve → applyRetrieve → retrieveByRef), independent of messageRefs,
// so no kernel ref-space mutation is needed. blockId → summary is immutable (a
// re-fold creates a successor block, not an in-place edit), so first-write-wins
// storage stays correct for the life of the session.
//
// Outbound view only: this swaps text on egress copies and appends to the content
// store — session.state and the underlying message records are untouched, so the
// next compression pass is unaffected.

const SUMMARY_ID_PREFIX = "acp_summary_";
const SYNTHETIC_SUMMARY_REF_BASE = 5_000_000;
const SYNTHETIC_SUMMARY_REF_SPAN = 4_999_999; // [5_000_000, 9_999_998] ⊂ valid mNNNNN
const SUMMARY_PLACEHOLDER_KIND = "compressed history";

// Bounded-head default for the fold-summary placeholder. The tool-result CCR
// default is 96 chars, but a fold summary is the ONLY inline trace of a whole
// folded span — 96 chars is a header fragment with near-zero topical signal
// (measured on real folds). A larger bounded head gives prose folds (which have
// no literals for the inverted index to catch) a real topical hint. Still
// bounded: it is a hint, not the full prose (that stays one acp_retrieve away).
const FOLD_SUMMARY_DEFAULT_HEAD_CHARS = 256;

// Inverted-index cap: guards a pathological never-ending session from growing
// the persisted anchor map without bound. Anchors are cheap (a few dozen per
// summary); 16K is far beyond any realistic session and evicts nothing below it.
const FOLD_INDEX_MAX_ANCHORS = 16384;

/** Distinctive literal anchors in a fold summary — the "grep-able" tokens a
 *  weak model would query to localize the block. Backtick-quoted (code, config
 *  keys, values), CJK 「」-quoted (semantic keys), file paths (>=2 segments),
 *  hex tokens (hashes/ids), and #issue refs. Lowercased, deduped, trivially
 *  short (<3 chars) dropped. Deterministic — the same prose yields the same
 *  anchors, so the index is byte-stable across turns. */
export function extractFoldAnchors(text: string): string[] {
    const out = new Set<string>();
    const add = (raw: string | undefined): void => {
        if (!raw) return;
        const norm = raw.trim().toLowerCase();
        if (norm.length >= 3) out.add(norm);
    };
    let m: RegExpExecArray | null;
    const bt = /`([^`\n]+)`/g;
    while ((m = bt.exec(text))) add(m[1]);
    const cq = /「([^」\n]+)」/g;
    while ((m = cq.exec(text))) add(m[1]);
    const pp = /[\w.-]+(?:\/[\w.-]+){1,}/g;
    while ((m = pp.exec(text))) add(m[0]);
    const hx = /\b[0-9a-fA-F]{6,}\b/g;
    while ((m = hx.exec(text))) add(m[0]);
    const ir = /#[0-9]{2,}/g;
    while ((m = ir.exec(text))) add(m[0]);
    return [...out];
}

/** Persisted fold-summary inverted index: anchor (lowercased) → the synthetic
 *  refs of the fold summaries containing it. A plain object (not a Map) so it
 *  round-trips through session.metadata JSON unchanged. Absent == empty.
 *  Module-private: readFoldSummaryIndex is the only accessor (the keyword query
 *  in store.ts reads session.metadata directly to avoid a circular import). */
type FoldSummaryIndex = Record<string, string[]>;

export function readFoldSummaryIndex(session: Session): FoldSummaryIndex {
    const v = session.metadata.foldSummaryIndex;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as FoldSummaryIndex) : {};
}

/** Merge freshly-extracted anchors (anchor → refs) into the session's persisted
 *  index. Idempotent (a ref already listed for an anchor is not re-added) and
 *  bounded (stops adding once the anchor count hits the cap). */
function mergeFoldIndex(session: Session, indexOut: Map<string, Set<string>>): void {
    if (indexOut.size === 0) return;
    const existing = readFoldSummaryIndex(session);
    let anchorCount = Object.keys(existing).length;
    for (const [anchor, refs] of indexOut) {
        if (anchorCount >= FOLD_INDEX_MAX_ANCHORS) break;
        const arr = existing[anchor] ?? (existing[anchor] = []);
        for (const r of refs) if (!arr.includes(r)) arr.push(r);
        anchorCount++;
    }
    session.metadata.foldSummaryIndex = existing;
}

/** FNV-1a 32-bit over UTF-16 code units — pure arithmetic, platform-stable. */
function fnv1a(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** Deterministic synthetic ref for a fold summary, derived from its blockId.
 *  Canonical m-form (satisfies the CCR placeholder grammar) and collision-safe
 *  against counter refs by construction of the reserved band. */
export function syntheticSummaryRef(blockId: string): string {
    return indexToRef(SYNTHETIC_SUMMARY_REF_BASE + (fnv1a(blockId) % SYNTHETIC_SUMMARY_REF_SPAN));
}

interface FoldSummaryCcrOutcome {
    /** Egress view with rendered summaries swapped for placeholders. */
    messages: CoreMessage[];
    /** Content store with every touched summary's prose stored (append-only). */
    store: MessageContentStore;
    /** Number of summaries replaced this pass. */
    replaced: number;
}

/** Swap each rendered fold summary's prose for a deterministic CCR placeholder,
 *  storing the full prose under a stable synthetic ref for on-demand
 *  acp_retrieve. When a ref is already stored, the placeholder's metadata is read
 *  back from the STORED entry (not recomputed) so the wire bytes always mirror
 *  exactly what retrieval returns. Non-summary messages pass through unchanged
 *  (same object reference); a summary that becomes a placeholder is copied, never
 *  mutated in place. Returns `replaced: 0` and the same array when there is
 *  nothing to swap. */
export function foldSummariesToCcr(
    messages: CoreMessage[],
    storeIn: MessageContentStore,
    retrieveName: string,
    maxHeadChars: number,
    indexOut?: Map<string, Set<string>>,
): FoldSummaryCcrOutcome {
    let store = storeIn;
    let replaced = 0;
    const out = messages.map((m) => {
        if (!isRenderedSummaryMessage(m)) return m;
        const text = m.text ?? "";
        if (text.length === 0) return m;
        const blockId = m.id.slice(SUMMARY_ID_PREFIX.length);
        const ref = syntheticSummaryRef(blockId);
        if (indexOut) {
            for (const anchor of extractFoldAnchors(text)) {
                let s = indexOut.get(anchor);
                if (!s) { s = new Set(); indexOut.set(anchor, s); }
                s.add(ref);
            }
        }
        const existing = hasStoredRef(store, ref) ? store.byRef[ref] : undefined;
        if (existing) {
            replaced++;
            return {
                ...m,
                text: buildStoredPlaceholder({ ref, kind: existing.kind, tokens: existing.tokens, head: existing.head, retrieveToolName: retrieveName }),
            };
        }
        const tokens = defaultCountTokens(text);
        const head = normalizeHead(text, maxHeadChars);
        store = storeOriginal(store, { ref, rawId: m.id, text, kind: SUMMARY_PLACEHOLDER_KIND, tokens, head });
        replaced++;
        return {
            ...m,
            text: buildStoredPlaceholder({ ref, kind: SUMMARY_PLACEHOLDER_KIND, tokens, head, retrieveToolName: retrieveName }),
        };
    });
    return { messages: out, store, replaced };
}

/** Seam entry for the #6111 fold-summary→CCR-placeholder swap: applies
 *  foldSummariesToCcr to an egress view, gated on the rollout feature AND CCR
 *  being armed (a placeholder must stay retrievable — never point at an absent
 *  tool). Outbound view only; the session content store is adopted in place.
 *  Returns { applied: false } (same array) when the gate is off or there is
 *  nothing to swap. Both egress seams (prepare-openai / prepare-responses) call
 *  this so the gate lives in exactly one place. */
export function applyFoldSummaryCcr(
    messages: CoreMessage[],
    session: Session,
): { messages: CoreMessage[]; applied: boolean } {
    if (!featureEnabled("foldSummaryCcrPlaceholder") || !ccrEnabled(session)) {
        return { messages, applied: false };
    }
    const indexOut = new Map<string, Set<string>>();
    const folded = foldSummariesToCcr(messages, contentStoreOf(session), retrieveToolName(session), effectiveCcr(session)?.maxHeadChars ?? FOLD_SUMMARY_DEFAULT_HEAD_CHARS, indexOut);
    if (folded.replaced > 0) {
        adoptContentStore(session, folded.store);
        mergeFoldIndex(session, indexOut);
        return { messages: folded.messages, applied: true };
    }
    return { messages, applied: false };
}
