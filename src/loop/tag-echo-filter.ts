// Streaming-safe stripper for model-emitted literal ACP render tags (#206).
// Compressed history is rendered to the model as render tags; models sometimes
// imitate them in visible output ("tag echo"), the client replays the echoed
// tags on later turns, and the imitation amplifies into unbounded repetition.
// Stripping render tags from outgoing text breaks the loop at the source.
// ONLY the render form (`\x3cacp attrs…>` / exact `\x3c/acp>`) is stripped — the
// underscore-namespaced text-protocol triggers (`\x3cacp_compress>` etc.) and
// ordinary prose containing `<` pass through untouched.

const PAIRED = /\x3cacp\s[^<>]*>([^<>]{0,64})<\/acp>/;
const LONE = /<\/?acp(?=[\s>])[^<>]*>/;
// A suffix of the buffer that could still grow into a render tag: either an
// unterminated `\x3cacp …` opening (attrs so far, no `>` yet) or a short
// ambiguous prefix like `<`, `<a`, `</ac`, …
const PARTIAL_TAIL = /(\x3cacp\s[^<>]*|<\/?a?c?p?)$/;
// An unterminated render-tag opening that already shows a quoted tokens=
// attribute — always an imitation truncated mid-tag, never prose.
const TRUNCATED_TAG = /\x3cacp\s[^<>]*tokens\s*=\s*"[^<>"]*"[^<>]*$/;
const CLOSE_TAG = "\x3c/acp";
const HOLD_LIMIT = 128;
const SWALLOW_CAP = 80;

export interface TagEchoFilter {
    push(delta: string): string;
    flush(): string;
    dropped(): boolean;
}

export function stripAcpTags(text: string): string {
    return text
        .replace(new RegExp(PAIRED.source, "g"), "")
        .replace(new RegExp(LONE.source, "g"), "")
        .replace(new RegExp(TRUNCATED_TAG.source), "");
}

// Cheap pre-check on a raw wire string (SSE event or JSON body): does it
// contain anything that looks like a render tag (literal or JSON-escaped
// `\u003c` form)? Callers use this to skip re-serializing chunks that need
// no stripping, preserving byte-identical passthrough.
export function containsRenderTagText(s: string): boolean {
    return /\x3c\/?acp(?=[\s>])/.test(s) || /\\u003c\/?acp(?=[\s>\\])/.test(s);
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
            const l = LONE.exec(buf);
            let m: RegExpExecArray | null;
            if (p && l) m = p.index <= l.index ? p : l;
            else m = p ?? l;
            if (!m) {
                const t = PARTIAL_TAIL.exec(buf);
                if (t && t[0].length <= HOLD_LIMIT) {
                    held = t[0];
                    out += buf.slice(0, buf.length - t[0].length);
                } else {
                    out += buf;
                }
                break;
            }
            drop(m[0]);
            out += buf.slice(0, m.index);
            buf = buf.slice(m.index + m[0].length);
            // A PAIRED match is by definition a complete open+content+close
            // span — only a LONE opening tag leaves the stream mid-tag and
            // needs to swallow until its close arrives.
            const wasPaired = m === p;
            if (!wasPaired && /^\x3cacp\s/.test(m[0])) {
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
            let rest = swallowed + held;
            swallowed = "";
            held = "";
            swallowUntilClose = false;
            const t = new RegExp(TRUNCATED_TAG.source).exec(rest);
            if (t) {
                drop(t[0]);
                rest = rest.slice(0, t.index);
            }
            return rest;
        },
        dropped(): boolean {
            return droppedAny;
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
