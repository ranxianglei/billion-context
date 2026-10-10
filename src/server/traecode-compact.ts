// #2411 Phase 1: TRAE Code native auto-compact instruction neutralizer.
//
// TRAE Code (ByteDance's closed-source AI IDE; no plugin system) ships its own
// native context compression and tells the model about it in its system prompt
// with the tracked sentence below: a bullet at char offset 1270 of a single
// 42,385-char role=system string on OpenAI Chat Completions
// (POST /v1/chat/completions). Routed through bili in proxy mode, that sentence
// reaches the model in the SAME request as bili's injected COMPRESS_PHILOSOPHY
// + acp tool surface — two mutually exclusive "who compresses" stories, and if
// the native compaction ever lands it rewrites history outside the kernel's
// knowledge, destroying the fold substrate (same mechanism family as dsh #2360,
// detection already in src/fold-reconcile.ts).
//
// The neutralizer removes the tracked bullet line from the system text exactly
// when bili presents its own compression surface into this request (the
// prepare-openai injectTools gate), so the model sees one philosophy.
//
// Evidence-permitlist discipline (KDD #9 / #970 precedent): the trigger is the
// exact tracked sentence itself — no UA or shape heuristics (at bili ingress
// the client's real headers terminate at TraeCode's sidecar; only
// Go-http-client is visible). Stability was verified by the reporter across 4
// dumps / 2 sessions (#2411): system sha256 prefix e477d92761e39731 byte-stable
// within and across sessions, so the deterministic removal keeps each session's
// head prefix byte-stable (prefix-cache neutral). If a future release rewords
// the sentence, the match simply misses and behavior degrades to the
// pre-fix passthrough — refresh TRAE_NATIVE_COMPACT_SENTENCE from a fresh dump.
//
// Line-shape guard: we delete only when the ENTIRE line is exactly a markdown
// bullet carrying the sentence ("  - <sentence>"). A future reflow that embeds
// the sentence mid-line sets shapeDrift instead of guessing at host-prompt
// surgery; the caller warns once per session. Parts-array system content
// degrades to no-op (evidence covers the plain-string form only).
//
// Phase 2 (trigger takeover if Case A / recovery if Case B) awaits a capture of
// a natural native-compaction event (#2411); this module is Phase 1 only.

export const TRAE_NATIVE_COMPACT_SENTENCE =
    "The system will automatically compress prior messages in your conversation as it approaches context limits. This means your conversation with the user is not limited by the context window.";

const BULLET_PREFIX = /^\s*[-*+]\s+/;

interface TraeNeutralizeResult {
    text: string;
    removed: number;
    /** tracked sentence present but not alone on its bullet line — NOT modified */
    shapeDrift: boolean;
}

/** Remove every line that is exactly a bullet carrying the tracked sentence. */
export function neutralizeTraeNativeCompactInstruction(systemText: string): TraeNeutralizeResult {
    let removed = 0;
    let shapeDrift = false;
    let text = systemText;
    for (;;) {
        const idx = text.indexOf(TRAE_NATIVE_COMPACT_SENTENCE);
        if (idx === -1) break;
        const lineStart = text.lastIndexOf("\n", idx - 1) + 1;
        const lineEndRaw = text.indexOf("\n", idx + TRAE_NATIVE_COMPACT_SENTENCE.length);
        const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
        const line = text.slice(lineStart, lineEnd);
        const m = line.match(BULLET_PREFIX);
        if (!m || line.slice(m[0].length).trim() !== TRAE_NATIVE_COMPACT_SENTENCE) {
            shapeDrift = true;
            break;
        }
        // delete the whole line including its trailing newline (or to EOF)
        text = text.slice(0, lineStart) + (lineEndRaw === -1 ? "" : text.slice(lineEndRaw + 1));
        removed++;
    }
    return { text, removed, shapeDrift };
}

/**
 * Neutralize the tracked instruction in place across an openai messages array.
 * Only role=system messages with STRING content are touched (see module
 * header). Returns how many lines were removed and whether any message showed
 * the drift shape (sentence present, line not exactly the tracked bullet).
 */
export function stripTraeCodeNativeCompactInstruction(messages: unknown): { neutralized: number; shapeDrift: boolean } {
    if (!Array.isArray(messages)) return { neutralized: 0, shapeDrift: false };
    let neutralized = 0;
    let shapeDrift = false;
    for (const rec of messages) {
        if (rec === null || typeof rec !== "object") continue;
        const msg = rec as Record<string, unknown>;
        if (msg.role !== "system") continue;
        if (typeof msg.content !== "string") continue;
        if (!msg.content.includes(TRAE_NATIVE_COMPACT_SENTENCE)) continue;
        const r = neutralizeTraeNativeCompactInstruction(msg.content);
        if (r.removed > 0) {
            msg.content = r.text;
            neutralized += r.removed;
        }
        if (r.shapeDrift) shapeDrift = true;
    }
    return { neutralized, shapeDrift };
}
