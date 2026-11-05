// Marker anchors shared by emitters and strippers (single-source discipline).
//
// The integrity note and the silence clause are appended to host-rendered
// surfaces (compress-tool.ts) AND recognized by the inbound stripper
// (marker/anchors.ts::isNudgeEchoText). They used to live as private
// constants in compress-tool.ts; declaring them here keeps the emitter and
// the recognizer from drifting apart — the same discipline the chain
// carriers and the panel wrappers follow (acp-panel.ts, chain-checkpoint.ts).
//
// Leaf module: zero imports.

// Appended to nudge text (compress-tool.ts appendIntegrityNote) so the model
// never emits proxy markers as its own text. The tail doubles as the anchor
// for the inbound nudge-echo matcher below.
export const MARKER_INTEGRITY_NOTE =
    "\n\n[ACP marker integrity: lines shaped like '📦 [ACP] Compressed …' or '❌ [ACP] … FAILED' are CONFIRMATION MARKERS emitted by the bili proxy itself, right after it executes a compress/decompress/search_context/acp_status call. They are not something you write. NEVER emit such a line as your own text — writing one fakes a state change that did not happen, and the proxy strips it. To compress, call the compress tool. To verify a compression landed, call acp_status and confirm the block count increased — a confirmation line you wrote yourself proves nothing.";

// Appended after the integrity note when visibility markers are on
// (compress.visibilityMarkers default). Marks the possible tail of a nudge.
export const MARKER_SILENCE_CLAUSE =
    " Execute these calls silently: no announcement or preamble before the call, and no completion summary, status line, or marker-style line after it — when the tool returns, continue the task directly as if the call had not happened.]";

// Whole-message nudge echo (#2811 leak matrix, nudge_echo class). A rendered
// nudge always ENDS with the integrity note (optionally followed by the
// silence clause), regardless of which pack overrode the nudge's opening
// sections — the tail is the stable anchor. A client that persisted a
// rebuilt body (or a model that copied a nudge verbatim into its own turn)
// resends that text on every turn; matching the TAIL keeps the rule whole-
// message conservative: prose that merely QUOTES part of a nudge, or a
// nudge followed by the user's own words, does not end with the note and is
// preserved. Dogfood evidence: 440+ session corpus, zero user-role resends
// carrying nudge text — the class is latent, the matcher is cheap insurance.
export function isNudgeEchoText(text: string): boolean {
    const t = text.trim();
    if (t.length === 0) return false;
    return t.endsWith(MARKER_INTEGRITY_NOTE) || t.endsWith(MARKER_SILENCE_CLAUSE);
}
