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
): FoldSummaryCcrOutcome {
    let store = storeIn;
    let replaced = 0;
    const out = messages.map((m) => {
        if (!isRenderedSummaryMessage(m)) return m;
        const text = m.text ?? "";
        if (text.length === 0) return m;
        const blockId = m.id.slice(SUMMARY_ID_PREFIX.length);
        const ref = syntheticSummaryRef(blockId);
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
