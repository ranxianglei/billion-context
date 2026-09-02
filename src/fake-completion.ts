import type { WireProtocol } from "./util.js";
import { containsToolCallXmlFragment } from "./loop/tag-echo-filter.js";

// #371 (root-cause follow-up to #361): a small model can WRITE a tool call as
// plain text (echoing the tool-call XML template from the context) instead of
// emitting a real tool block. With no tool block the agent ends the turn early
// — a "fake completion": the tool never ran but the client shows success. The
// proxy detects this shape (tool-call structure present + no real tool block)
// and retries once with a corrective hint, bounded per turn and per session.

export const FAKE_COMPLETION_HINT =
    "[billion-context] Your last reply described a tool call as plain text instead of invoking it, so no tool actually ran. " +
    "To act, invoke the tool through the proper tool-calling mechanism (emit a tool_use / tool_calls / function_call block). " +
    "Do not write tool-call markup as text in your reply.";

// One value serves two bounds: max retries within a single request, and the
// consecutive-fake-completion-turn cap after which a session stops retrying.
//
// DISABLED BY DEFAULT (0): the fallback must buffer the whole response before
// the client sees it (a fake completion is only knowable at end-of-stream),
// which defeats incremental streaming. That cost is only worth paying for the
// low-frequency fake-completion case (small models via gateways), so it is
// opt-in: set BILI_FAKE_COMPLETION_RETRIES=2 to enable. 0 = pre-#371 passthrough.
export function maxFakeCompletionRetries(): number {
    const n = Number.parseInt(process.env.BILI_FAKE_COMPLETION_RETRIES ?? "0", 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

// OOM guard for a pathological upstream; LLM responses are bounded by max_tokens
// and normally well under 1 MiB.
export function fakeBufCap(): number {
    const n = Number.parseInt(process.env.BILI_FAKE_BUF_CAP ?? String(16 * 1024 * 1024), 10);
    return Number.isFinite(n) && n > 0 ? n : 16 * 1024 * 1024;
}

// "Does this raw response (full SSE stream or JSON body) carry a REAL tool
// block?" A real block means the model actually invoked a tool → not a fake
// completion. Each protocol marks its tool block differently on the wire.
const ANTHROPIC_TOOL_BLOCK = /"type"\s*:\s*"tool_use"/;
const OPENAI_TOOL_BLOCK = /"tool_calls"\s*:\s*\[\s*\{/;
const RESPONSES_TOOL_BLOCK = /"type"\s*:\s*"function_call"/;

export function hasToolBlock(protocol: WireProtocol, rawText: string): boolean {
    switch (protocol) {
        case "anthropic":
            return ANTHROPIC_TOOL_BLOCK.test(rawText);
        case "openai":
            return OPENAI_TOOL_BLOCK.test(rawText);
        case "responses":
            return RESPONSES_TOOL_BLOCK.test(rawText);
    }
}

// Opening tool tag (no leading '/'): the model started writing a call as text —
// the strongest signal. Literal '<' or JSON-escaped '\u003c'; optional antml:
// namespace; case-insensitive, matching containsToolCallXmlFragment.
const TOOL_OPEN =
    /\x3c(?!\s*\/)(?:antml:)?(invoke|tool_calls|tool_call|parameter|parameters)\b|\\u003c(?!\s*\/)(?:antml:)?(invoke|tool_calls|tool_call|parameter|parameters)\b/i;

// Closing tool tags (global): an echoed template tail carries 2+ distinct
// closers (</invoke> + </tool_calls>) even when the openers were folded away
// earlier in the context (the #361 shape).
const TOOL_CLOSE_GLOBAL =
    /\x3c\/(?:antml:)?(invoke|tool_calls|tool_call|parameter|parameters)\b|\\u003c\/(?:antml:)?(invoke|tool_calls|tool_call|parameter|parameters)\b/gi;

// Structural guard on top of containsToolCallXmlFragment: require an opening
// tool tag OR 2+ distinct closing tags. A LONE closing tag in prose (a model
// discussing tool-call code) does not qualify — that is the false positive the
// plain fragment detector would otherwise trigger on.
export function hasToolCallStructure(text: string): boolean {
    if (!containsToolCallXmlFragment(text)) return false;
    if (TOOL_OPEN.test(text)) return true;
    const closes = new Set<string>();
    for (const m of text.matchAll(TOOL_CLOSE_GLOBAL)) {
        const name = m[1] ?? m[2];
        if (name) closes.add(name.toLowerCase());
    }
    return closes.size >= 2;
}

export function isFakeCompletion(protocol: WireProtocol, rawText: string): boolean {
    return hasToolCallStructure(rawText) && !hasToolBlock(protocol, rawText);
}

// Appends the hint as a trailing user message, merged into the last user
// message when present (avoids back-to-back user turns on strict providers).
// Returns the hinted JSON, or null if the body is unparseable (skip the retry).
export function injectFakeCompletionHint(protocol: WireProtocol, body: string | Buffer): string | null {
    const raw = typeof body === "string" ? body : body.toString("utf8");
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (protocol === "responses") {
        const input = obj.input;
        if (!Array.isArray(input)) return null;
        const arr = input as Record<string, unknown>[];
        const last = arr[arr.length - 1];
        if (last && typeof last === "object" && last.role === "user") {
            const c = last.content;
            if (typeof c === "string") last.content = `${c}\n\n${FAKE_COMPLETION_HINT}`;
            else if (Array.isArray(c)) last.content = [...c, { type: "input_text", text: FAKE_COMPLETION_HINT }];
            else last.content = FAKE_COMPLETION_HINT;
        } else {
            arr.push({ role: "user", content: [{ type: "input_text", text: FAKE_COMPLETION_HINT }] });
        }
        return JSON.stringify(obj);
    }
    const messages = obj.messages;
    if (!Array.isArray(messages)) return null;
    const arr = messages as Record<string, unknown>[];
    const last = arr[arr.length - 1];
    if (last && typeof last === "object" && last.role === "user") {
        const c = last.content;
        if (typeof c === "string") last.content = `${c}\n\n${FAKE_COMPLETION_HINT}`;
        else if (Array.isArray(c)) last.content = [...c, { type: "text", text: FAKE_COMPLETION_HINT }];
        else last.content = FAKE_COMPLETION_HINT;
    } else {
        arr.push({ role: "user", content: FAKE_COMPLETION_HINT });
    }
    return JSON.stringify(obj);
}
