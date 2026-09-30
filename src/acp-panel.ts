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
//  - wrapCacheReport (#800, /acp-cache): explicit plugin-owned markers around
//    the kernel's cache report — its shape is kernel-owned and variable-length
//    (LINE ITEMS table up to the sample cap), so we cannot anchor on the
//    renderer output the way we can for the two panels above.
//  - wrapRuleReport (#1251, /acp-rule): same marker scheme around the
//    executeRule output (a numbered list or a one-line add/list result).
import { MARKER_LINE, stripMarkerLines } from "./loop/tag-echo-filter.js";

const PANEL_BOX_TOP = "\u256d";
const PANEL_BOX_TITLE = "ACP Context Analysis";
export const PANEL_BOX_FOOTER = "Tag visibility: tags injected to LLM only (deep copy), not persisted in session, not shown in terminal.";
const PANEL_FALLBACK_HEADER = "\u{1f4ca} ACP status";

export const CACHE_REPORT_OPEN = "[acp-cache]";
export const CACHE_REPORT_CLOSE = "[/acp-cache]";
export const RULE_REPORT_OPEN = "[acp-rule]";
export const RULE_REPORT_CLOSE = "[/acp-rule]";

/** Wrap a cache report for persistent transcript display (see above). */
export function wrapCacheReport(report: string): string {
    return `${CACHE_REPORT_OPEN}\n${report}\n${CACHE_REPORT_CLOSE}`;
}

/** Wrap an acp_rule report for persistent transcript display (see above). */
export function wrapRuleReport(report: string): string {
    return `${RULE_REPORT_OPEN}\n${report}\n${RULE_REPORT_CLOSE}`;
}

export function isAcpPanelText(text: string): boolean {
    const t = text.trim();
    if (t.length === 0) return false;
    return isBoxPanel(t) || isFallbackPanel(t) || isCacheReport(t) || isRuleReport(t);
}

function isCacheReport(t: string): boolean {
    return t.startsWith(CACHE_REPORT_OPEN) && t.endsWith(CACHE_REPORT_CLOSE);
}

function isRuleReport(t: string): boolean {
    return t.startsWith(RULE_REPORT_OPEN) && t.endsWith(RULE_REPORT_CLOSE);
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

// #1029: ACP status markers ("❌ [ACP] …", "📦 [ACP] …") are ephemeral proxy
// status lines streamed into assistant text (#717). Clients that resend full
// history (e.g. DSH Desktop) carry them back on every turn, where they
// accumulate in the model context and the reading flow. Strip marker lines
// from incoming user/assistant text before projection (mirrors
// stripAcpPanelMessages above; line semantics shared with the outgoing
// tag-echo filter). Messages are NEVER deleted — a marker-only assistant
// message may still carry tool_calls whose tool results must not be orphaned;
// such text degrades to a single space instead.
export function stripAcpStatusMarkers(messages: unknown): number {
    if (!Array.isArray(messages)) return 0;
    let stripped = 0;
    for (const rec of messages) {
        if (rec === null || typeof rec !== "object") continue;
        const m = rec as Record<string, unknown>;
        if (m.role !== "user" && m.role !== "assistant") continue;
        const content = m.content;
        if (typeof content === "string") {
            const out = stripMarkerLines(content);
            if (out !== content) {
                m.content = out.trim().length > 0 ? out : " ";
                stripped += countMarkerLines(content);
            }
        } else if (Array.isArray(content)) {
            for (const part of content) {
                if (part === null || typeof part !== "object") continue;
                const p = part as Record<string, unknown>;
                const text = p.text;
                if (typeof text !== "string") continue;
                const out = stripMarkerLines(text);
                if (out !== text) {
                    p.text = out.trim().length > 0 ? out : " ";
                    stripped += countMarkerLines(text);
                }
            }
        }
    }
    return stripped;
}

function countMarkerLines(text: string): number {
    let n = 0;
    for (const _ of text.matchAll(MARKER_LINE)) n++;
    return n;
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
