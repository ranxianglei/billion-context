// Streaming-safe stripper for model-emitted literal ACP render tags (#206).
// Compressed history is rendered to the model as render tags; models sometimes
// imitate them in visible output ("tag echo"), the client replays the echoed
// tags on later turns, and the imitation amplifies into unbounded repetition.
// Stripping render tags from outgoing text breaks the loop at the source.
// ONLY the render form (`\x3cacp attrs…>` / exact `\x3c/acp>`) is stripped — the
// underscore-namespaced text-protocol triggers (`\x3cacp_compress>` etc.) and
// ordinary prose containing `<` pass through untouched.

// Opening-tag attrs are bounded: a render tag opening is short (tokens + type,
// < 50 chars). An unbounded \x3cacp …\x3e match would swallow a long prose span
// that merely starts with \x3cacp and contains a \x3e somewhere later.
const PAIRED = /\x3cacp\s[^<>]{0,256}>([^<>]{0,64})<\/acp>/;
const LONE_OPEN = /\x3cacp(?:\s[^<>]{0,256})?>/;
const LONE_CLOSE = /<\/acp(?=[\s>])[^<>]{0,32}>/;
// A suffix of the buffer that could still grow into a render tag: either an
// unterminated `\x3cacp …` opening (attrs so far, no `>` yet) or a short
// ambiguous prefix like `<`, `<a`, `</ac`, …
const PARTIAL_TAIL = /(\x3cacp\s[^<>]*|\x3c\/acp(?:\s[^<>]*)?|<\/?a?c?p?)$/;
// An unterminated render-tag opening at the end of a string: `<acp ` plus
// attrs, no `>` — a truncated imitation, never prose (triggers use `<acp_`).
const TRUNC_OPEN = /\x3cacp\s[^<>]*$/;
// A truncated render-tag CLOSE at the end of a string: `` or `` —
// a truncated imitation close, never prose. Mirrors TRUNC_OPEN on the close side.
const TRUNC_CLOSE = /\x3c\/acp(?:\s[^<>]*)?$/;
const CLOSE_TAG = "\x3c/acp";
const HOLD_LIMIT = 128;
// Hold cap for a definite unterminated opening tail — far beyond any real tag
// opening; beyond this the tail is dropped instead of held or passed through.
const TAG_OPEN_CAP = 4096;
const SWALLOW_CAP = 80;

export interface TagEchoFilter {
    push(delta: string): string;
    flush(): string;
    dropped(): boolean;
    /** True while the filter holds a partial-tag tail that a later push may complete. */
    pending(): boolean;
}

export function stripAcpTags(text: string): string {
    return text
        .replace(new RegExp(PAIRED.source, "g"), "")
        .replace(new RegExp(LONE_OPEN.source, "g"), "")
        .replace(new RegExp(LONE_CLOSE.source, "g"), "")
        .replace(new RegExp(TRUNC_OPEN.source), "")
        .replace(new RegExp(TRUNC_CLOSE.source), "");
}

// Cheap pre-check on a raw wire string (SSE event or JSON body): does it
// contain anything that looks like a render tag (literal or JSON-escaped
// `\u003c` form)? Callers use this to skip re-serializing chunks that need
// no stripping, preserving byte-identical passthrough.
const RENDER_TAG_DETECT = /\x3c\/?acp(?=[\s>])|\\u003c\/?acp(?=[\s>\\])/;
export function containsRenderTagText(s: string): boolean {
    return RENDER_TAG_DETECT.test(s);
}

// #468: some upstreams stream a model-imitated render tag in tokenizer-sized
// fragments ("\x3cac", "p tokens", ...) so no single chunk ever trips
// RENDER_TAG_DETECT. Per-chunk gates must also engage when the chunk contains
// or ends with the head of a render tag, so the streaming state machine can
// stitch it back together. Pure-prose chunks still skip the machine
// (byte-identical passthrough); only chunks with a `<`-head tail ("<", "</",
// "<a", "<ac", "<acp ...attrs", "\x3c/acp ...") engage it.
export function mayStartRenderTag(s: string): boolean {
    return RENDER_TAG_DETECT.test(s) || PARTIAL_TAIL.test(s);
}

// #361: tool-call XML template fragments a model may echo from the context
// (same source as acp tag echo — the model "writes the tool call as text").
// Detected + warned for attribution, NOT stripped: a closing tool-XML tag
// cannot be distinguished from legitimate prose discussing tool-call code,
// so stripping would corrupt real content (see #295 review).
const TOOL_CALL_XML = /\x3c\/?(?:antml:)?(invoke|tool_calls|tool_call|parameter|parameters)\b[^<>]*\x3e|\\u003c\/?(?:antml:)?(invoke|tool_calls|tool_call|parameter|parameters)\b|\x3c\/?antml:[a-z_]+/i;
export function containsToolCallXmlFragment(s: string): boolean {
    return TOOL_CALL_XML.test(s);
}

export function createTagEchoFilter(onDrop?: (snippet: string) => void): TagEchoFilter {
    let held = "";
    let swallowUntilClose = false;
    let swallowed = "";
    let droppedAny = false;
    let notified = false;
    const drop = (snippet: string) => {
        droppedAny = true;
        if (onDrop && !notified) {
            notified = true;
            onDrop(snippet);
        }
    };
    const process = (input: string): string => {
        let buf = input;
        let out = "";
        for (;;) {
            if (swallowUntilClose) {
                const combined = swallowed + buf;
                const closeIdx = combined.indexOf(CLOSE_TAG);
                if (closeIdx >= 0 && combined[closeIdx + CLOSE_TAG.length] === ">") {
                    const end = closeIdx + CLOSE_TAG.length + 1;
                    drop(swallowed + combined.slice(0, end));
                    swallowed = "";
                    swallowUntilClose = false;
                    buf = combined.slice(end);
                    continue;
                }
                if (combined.length > SWALLOW_CAP) {
                    swallowed = "";
                    swallowUntilClose = false;
                    buf = combined;
                    continue;
                }
                swallowed = combined;
                return out;
            }
            const p = PAIRED.exec(buf);
            const o = LONE_OPEN.exec(buf);
            const c = LONE_CLOSE.exec(buf);
            let m: RegExpExecArray | null = null;
            for (const cand of [p, o, c]) {
                if (cand && (m === null || cand.index < m.index)) m = cand;
            }
            if (!m) {
                const t = PARTIAL_TAIL.exec(buf);
                if (t) {
                    // A definite \x3cacp opening is never prose — hold it far
                    // past HOLD_LIMIT (drop it past TAG_OPEN_CAP); a short
                    // ambiguous prefix stays on the small hold cap so prose
                    // is never delayed or lost.
                    const definite = /^\x3cacp\s/.test(t[0]) || /^\x3c\/acp/.test(t[0]);
                    const cap = definite ? TAG_OPEN_CAP : HOLD_LIMIT;
                    if (t[0].length <= cap) {
                        held = t[0];
                        out += buf.slice(0, buf.length - t[0].length);
                    } else if (definite) {
                        drop(t[0]);
                        out += buf.slice(0, buf.length - t[0].length);
                    } else {
                        out += buf;
                    }
                } else {
                    out += buf;
                }
                break;
            }
            drop(m[0]);
            out += buf.slice(0, m.index);
            buf = buf.slice(m.index + m[0].length);
            // A PAIRED match is by definition a complete open+content+close
            // span — only an attrs-bearing LONE_OPEN leaves the stream
            // mid-tag and needs to swallow until its close arrives.
            if (m === o && /^\x3cacp\s/.test(m[0])) {
                swallowUntilClose = true;
                swallowed = "";
            }
        }
        return out;
    };
    return {
        push(delta: string): string {
            const chunk = held + delta;
            held = "";
            return process(chunk);
        },
        flush(): string {
            const rest = swallowed + held;
            const wasSwallowing = swallowUntilClose;
            swallowed = "";
            held = "";
            swallowUntilClose = false;
            if (wasSwallowing) {
                // Stream ended inside an unclosed render tag: the held content
                // is tag content (a ref), not prose.
                if (rest.length > 0) drop(rest);
                return "";
            }
            const t = new RegExp(TRUNC_OPEN.source).exec(rest);
            if (t) {
                drop(t[0]);
                return rest.slice(0, t.index);
            }
            const tc = new RegExp(TRUNC_CLOSE.source).exec(rest);
            if (tc) {
                drop(tc[0]);
                return rest.slice(0, tc.index);
            }
            return rest;
        },
        dropped(): boolean {
            return droppedAny;
        },
        pending(): boolean {
            return held.length > 0 || swallowUntilClose;
        },
    };
}

function stripParts(content: unknown): unknown {
    if (!Array.isArray(content)) return content;
    return content.map((part) => {
        if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
            return { ...(part as Record<string, unknown>), text: stripAcpTags((part as Record<string, unknown>).text as string) };
        }
        return part;
    });
}

function stripItemContent(it: unknown): unknown {
    if (it && typeof it === "object" && Array.isArray((it as Record<string, unknown>).content)) {
        return { ...(it as Record<string, unknown>), content: stripParts((it as Record<string, unknown>).content) };
    }
    return it;
}

function stripIfString(v: unknown): unknown {
    return typeof v === "string" ? stripAcpTags(v) : v;
}

// Plugin-passthrough parity for the OpenAI chat-completions wire (issue #14:
// pi + qwen echoed render tags through the verbatim plugin stream): strip the
// text fields a chat chunk / completion carries — `choices[].delta.{content,
// reasoning_content, reasoning}` on streams and `choices[].message.*` on
// non-streaming bodies. Mutates in place, mirroring stripResponsesText.
export function stripOpenaiChatText<T>(obj: T): T {
    if (!obj || typeof obj !== "object") return obj;
    const o = obj as Record<string, unknown>;
    if (!Array.isArray(o["choices"])) return obj;
    o["choices"] = (o["choices"] as unknown[]).map((c) => {
        if (!c || typeof c !== "object") return c;
        const ch = c as Record<string, unknown>;
        for (const holder of ["delta", "message"]) {
            const h = ch[holder];
            if (h && typeof h === "object") {
                const hh = { ...(h as Record<string, unknown>) };
                hh["content"] = stripIfString(hh["content"]);
                hh["reasoning_content"] = stripIfString(hh["reasoning_content"]);
                hh["reasoning"] = stripIfString(hh["reasoning"]);
                ch[holder] = hh;
            }
        }
        return ch;
    });
    return obj;
}

// Plugin-passthrough parity for the Anthropic wire: strip `delta.{text,
// thinking}` on content_block_delta streams and `content[].{text,thinking}`
// on non-streaming message bodies. Mutates in place.
export function stripAnthropicText<T>(obj: T): T {
    if (!obj || typeof obj !== "object") return obj;
    const o = obj as Record<string, unknown>;
    const d = o["delta"];
    if (d && typeof d === "object") {
        const dd = { ...(d as Record<string, unknown>) };
        dd["text"] = stripIfString(dd["text"]);
        dd["thinking"] = stripIfString(dd["thinking"]);
        o["delta"] = dd;
    }
    if (Array.isArray(o["content"])) {
        o["content"] = (o["content"] as unknown[]).map((c) => {
            if (!c || typeof c !== "object") return c;
            const cc = c as Record<string, unknown>;
            if (typeof cc["text"] !== "string" && typeof cc["thinking"] !== "string") return c;
            return { ...cc, text: stripIfString(cc["text"]), thinking: stripIfString(cc["thinking"]) };
        });
    }
    return obj;
}

// Strip render tags from the text fields of a Responses-API event/response
// object (mutates in place). Handles the shapes that carry literal text:
// output_text.done `.text`, content_part.done `.part.text`,
// output_item.done `.item.content[].text`, and `.response.output[].content[]`
// on response.completed.
export function stripResponsesText<T>(obj: T): T {
    if (!obj || typeof obj !== "object") return obj;
    const o = obj as Record<string, unknown>;
    if (typeof o.text === "string") o.text = stripAcpTags(o.text);
    if (o.part && typeof o.part === "object" && typeof (o.part as Record<string, unknown>).text === "string") {
        o.part = { ...(o.part as Record<string, unknown>), text: stripAcpTags((o.part as Record<string, unknown>).text as string) };
    }
    if (o.item && typeof o.item === "object") {
        const item = { ...(o.item as Record<string, unknown>) };
        if (Array.isArray(item.content)) item.content = stripParts(item.content);
        o.item = item;
    }
    if (o.response && typeof o.response === "object") {
        const resp = { ...(o.response as Record<string, unknown>) };
        if (Array.isArray(resp.output)) {
            resp.output = resp.output.map(stripItemContent);
        }
        o.response = resp;
    }
    if (Array.isArray(o.output)) {
        o.output = o.output.map(stripItemContent);
    }
    return obj;
}
