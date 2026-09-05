// ACP panel stripping for proxy mode (issue #359). The pi plugin's /acp emits
// the status panel as a persistent custom_message; in proxy mode pi's
// convertToLlm projects every custom message as an ordinary user message, so
// the panel would ride the recent zone to the model as if it were real
// conversation content. pi's projection drops the customType, so the proxy
// (which generates the panel itself via buildStatusPanel) strips it by content
// signature before it enters the compression state.
//
// The match must be WHOLE-MESSAGE, not a prefix: a user can copy a panel from
// pi-web and append a follow-up question in the same message — a prefix match
// would strip the user's question too (data loss, unrecoverable in-session).
// Each renderer is therefore anchored on BOTH its start and its end:
//  - buildStatusPanel (acp-kernel): starts with the U+256D top border + title
//    "ACP Context Analysis", and always ends with the "Tag visibility: ..."
//    footer (unconditional, last line pushed).
//  - renderAcpStatus (plugin fallback): first line exactly "📊 ACP status",
//    every other line an indented field.
const PANEL_BOX_TOP = "\u256d";
const PANEL_BOX_TITLE = "ACP Context Analysis";
const PANEL_BOX_FOOTER = "Tag visibility: tags injected to LLM only (deep copy), not persisted in session, not shown in terminal.";
const PANEL_FALLBACK_HEADER = "\u{1f4ca} ACP status";

export function isAcpPanelText(text: string): boolean {
    const t = text.trim();
    if (t.length === 0) return false;
    return isBoxPanel(t) || isFallbackPanel(t);
}

function isBoxPanel(t: string): boolean {
    return t.startsWith(PANEL_BOX_TOP) && t.includes(PANEL_BOX_TITLE) && t.endsWith(PANEL_BOX_FOOTER);
}

function isFallbackPanel(t: string): boolean {
    const lines = t.split("\n");
    if (lines[0] !== PANEL_FALLBACK_HEADER) return false;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 0 && !line.startsWith("  ")) return false;
    }
    return true;
}

// Plain text of a message's content (string or text-block array). Returns
// undefined for mixed/multimodal content — such a message can never be a
// panel, so it is preserved.
function messageText(content: unknown): string | undefined {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        let joined = "";
        for (const part of content) {
            const p = part as Record<string, unknown> | null;
            if (p === null || typeof p !== "object") return undefined;
            const pt = p.type;
            if (pt !== undefined && pt !== "text" && pt !== "input_text") return undefined;
            if (typeof p.text === "string") joined += p.text;
        }
        return joined;
    }
    return undefined;
}

// Strip ACP panel user messages from an anthropic/openai messages array (in
// place); returns the count removed.
export function stripAcpPanelMessages(messages: unknown): number {
    if (!Array.isArray(messages)) return 0;
    let stripped = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const rec = messages[i] as Record<string, unknown> | null;
        if (rec === null || typeof rec !== "object") continue;
        if (rec.role !== "user") continue;
        const text = messageText(rec.content);
        if (text !== undefined && isAcpPanelText(text)) {
            messages.splice(i, 1);
            stripped++;
        }
    }
    return stripped;
}

// Strip ACP panel user messages from a Responses input array (in place);
// returns the count removed. Type-less user items (omp wire form) count as
// messages, mirroring dropWhitespaceResponsesMessages.
export function stripAcpPanelResponsesInput(input: unknown): number {
    if (!Array.isArray(input)) return 0;
    let stripped = 0;
    for (let i = input.length - 1; i >= 0; i--) {
        const rec = input[i] as Record<string, unknown> | null;
        if (rec === null || typeof rec !== "object") continue;
        const type = rec.type;
        if (type !== "message" && type !== undefined) continue;
        if (rec.role !== "user") continue;
        const text = messageText(rec.content);
        if (text !== undefined && isAcpPanelText(text)) {
            input.splice(i, 1);
            stripped++;
        }
    }
    return stripped;
}
