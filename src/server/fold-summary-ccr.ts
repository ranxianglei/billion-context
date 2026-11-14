import {
    BLOCKED_REF,
    buildStoredPlaceholder,
    countMessageTokens,
    isRenderedSummaryMessage,
    normalizeHead,
    parseStoredPlaceholder,
    refForRaw,
    storeOriginal,
    type CompressionState,
    type CoreMessage,
    type MessageContentStore,
} from "acp-kernel";

const KIND = "compressed history";
const HEAD_CHARS = 96;

interface FoldSummaryCcrResult {
    messages: CoreMessage[];
    store: MessageContentStore;
    changed: boolean;
}

/**
 * #6111 POC (#6025): carry rendered fold summaries out as deterministic CCR
 * placeholders instead of inline prose. In proxy mode the summary rides as a
 * user-voiced prose block indistinguishable from current input, which weak
 * models misread as the task. A `[acp-stored …]` placeholder cannot be read
 * that way and hands retrieval back to the model via acp_retrieve.
 *
 * EGRESS-VIEW ONLY: returns fresh message objects and never mutates session
 * state, so the stored original and any later compression are untouched. The
 * summary's OWN prose is stored under its own ref — storeCoveredOriginals only
 * covers the folded-away originals, not the surviving summary.
 */
export function foldSummariesToCcrPlaceholders(
    messages: CoreMessage[],
    state: CompressionState,
    store: MessageContentStore,
    retrieveToolName: string,
): FoldSummaryCcrResult {
    let current = store;
    let changed = false;
    const out = messages.map((message) => {
        if (!isRenderedSummaryMessage(message)) return message;
        const ref = refForRaw(state.messageRefs, message.id);
        if (!ref || ref === BLOCKED_REF) return message;
        const text = message.text ?? "";
        if (text.trim().length === 0) return message;
        // Already a canonical placeholder for this ref (idempotent re-egress).
        if (parseStoredPlaceholder(text)?.ref === ref) return message;
        const tokens = countMessageTokens(message);
        const head = normalizeHead(text, HEAD_CHARS);
        if (!current.byRef[ref]) {
            current = storeOriginal(current, {
                ref,
                rawId: message.id,
                text,
                kind: KIND,
                tokens,
                head,
            });
            changed = true;
        }
        return {
            ...message,
            text: buildStoredPlaceholder({ ref, kind: KIND, tokens, head, retrieveToolName }),
        };
    });
    return { messages: out, store: current, changed };
}
