import type { WireProtocol } from "./util.js";
import { containsToolCallXmlFragment } from "./loop/tag-echo-filter.js";
import { appendTrailingUserText } from "./wire-body.js";
import { fakeCompletionRetries as knobFakeCompletionRetries, fakeBufCapBytes as knobFakeBufCapBytes } from "./knobs.js";

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
// opt-in: set BILI_FAKE_COMPLETION_RETRIES=2 / fakeCompletion.retries=2 to
// enable. 0 = pre-#371 passthrough.
export function maxFakeCompletionRetries(): number {
    return knobFakeCompletionRetries();
}

// OOM guard for a pathological upstream; LLM responses are bounded by max_tokens
// and normally well under 1 MiB.
export function fakeBufCap(): number {
    return knobFakeBufCapBytes();
}

// "Does this raw response (full SSE stream or JSON body) carry a REAL tool
// block?" A real block means the model actually invoked a tool → not a fake
// completion. Each protocol marks its tool block differently on the wire.
const ANTHROPIC_TOOL_BLOCK = /"type"\s*:\s*"tool_use"/;
const OPENAI_TOOL_BLOCK = /"tool_calls"\s*:\s*\[\s*\{/;
const RESPONSES_TOOL_BLOCK = /"type"\s*:\s*"function_call"/;
// Gemini has no `type` discriminator: a real invocation is a functionCall PART
// (`"functionCall":{"name":…}`) inside candidates[*].content.parts.
const GOOGLE_TOOL_BLOCK = /"functionCall"\s*:\s*\{/;

export function hasToolBlock(protocol: WireProtocol, rawText: string): boolean {
    switch (protocol) {
        case "anthropic":
            return ANTHROPIC_TOOL_BLOCK.test(rawText);
        case "openai":
            return OPENAI_TOOL_BLOCK.test(rawText);
        case "responses":
            return RESPONSES_TOOL_BLOCK.test(rawText);
        case "google":
            return GOOGLE_TOOL_BLOCK.test(rawText);
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

// #2348: scale gate — a runaway enumeration (a model stuck looping thousands of
// tool-XML closer pairs; instance B measured 3 openers / 8745 closers in one
// response) used to read as "structurally complete" through BOTH branches below.
// A genuine fake-completion echo is a handful of calls written as prose; past
// this total-closer budget the shape is enumeration, not structure, so it must
// not be retried as a fake completion (buffering the flood + hinting "use the
// tool mechanism" only feeds the loop). Internal constant on purpose: no config
// surface for a detector threshold (#2030 discipline).
const TOOL_CLOSE_SCALE_CAP = 32;

// Structural guard on top of containsToolCallXmlFragment: require an opening
// tool tag OR 2+ distinct closing tags. A LONE closing tag in prose (a model
// discussing tool-call code) does not qualify — that is the false positive the
// plain fragment detector would otherwise trigger on.
export function hasToolCallStructure(text: string): boolean {
    if (!containsToolCallXmlFragment(text)) return false;
    const closes = new Set<string>();
    let closeCount = 0;
    for (const m of text.matchAll(TOOL_CLOSE_GLOBAL)) {
        closeCount++;
        const name = m[1] ?? m[2];
        if (name) closes.add(name.toLowerCase());
    }
    if (closeCount > TOOL_CLOSE_SCALE_CAP) return false;
    if (TOOL_OPEN.test(text)) return true;
    return closes.size >= 2;
}

export function isFakeCompletion(protocol: WireProtocol, rawText: string): boolean {
    return hasToolCallStructure(rawText) && !hasToolBlock(protocol, rawText);
}

/** Append the fake-completion hint to the request body as a trailing user turn
 *  (per-wire shapes live in `appendTrailingUserText`). Returns the hinted JSON,
 *  or null if the body is unparseable, in which case the retry is skipped. */
export function injectFakeCompletionHint(protocol: WireProtocol, body: string | Buffer): string | null {
    return appendTrailingUserText(protocol, body, FAKE_COMPLETION_HINT);
}
