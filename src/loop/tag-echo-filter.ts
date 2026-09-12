// Streaming-safe stripper for model-emitted literal ACP render tags (#206).
// Compressed history is rendered to the model as render tags; models sometimes
// imitate them in visible output ("tag echo"), the client replays the echoed
// tags on later turns, and the imitation amplifies into unbounded repetition.
// Stripping render tags from outgoing text breaks the loop at the source.
// ONLY the render form (\x3c<name> attrs…\x3e, \x3c<name …/\x3e, \x3c/<name>\x3e) is stripped —
// the underscore-namespaced text-protocol triggers (\x3cacp_compress\x3e etc.) and
// ordinary prose containing \x3c pass through untouched.
// #673: models typo the 3-letter name when imitating (observed: acip/acpi,
// including mixed correct-open + typo'd-close), so <name> matches a bounded
// mutation set instead of the exact spelling: the three core letters in any
// order, plus at most ONE extra letter drawn from that set or an inserted i.
// Every match still requires the name to be followed by \s or > (attrs or
// close), so real words that merely contain the letters (acpi/acpi.h includes,
// caption, app, uppercase ACPI) never match; a false positive costs at most
// the same bounded caps as before (swallow ≤ SWALLOW_CAP, hold ≤ HOLD_LIMIT/TAG_OPEN_CAP).
function buildAcplikeName(): string {
    const cores = ["acp", "apc", "cap", "cpa", "pac", "pca"];
    const names = new Set<string>(cores);
    for (const c of cores) {
        for (const ch of ["a", "c", "p", "i"]) {
            for (let pos = 0; pos <= c.length; pos++) names.add(c.slice(0, pos) + ch + c.slice(pos));
        }
    }
    return [...names].sort((a, b) => b.length - a.length).join("|");
}

/** Longest-first alternation of every tolerated render-tag name (#673). */
export const ACP_NAME_ALT = `(?:${buildAcplikeName()})`;
const NAME = ACP_NAME_ALT;

// Opening-tag attrs are bounded: a render tag opening is short (tokens + type,
// \x3c 50 chars). An unbounded \x3c<name> …\x3e match would swallow a long prose span
// that merely starts with a tag head and contains a \x3e somewhere later.
const PAIRED = new RegExp("\x3c" + NAME + "\\s[^<>]{0,256}>([^<>]{0,64})\x3c\\/" + NAME + ">");
const LONE_OPEN = new RegExp("\x3c" + NAME + "(?:\\s[^<>]{0,256})?>");
const LONE_CLOSE = new RegExp("\x3c\\/" + NAME + "(?=[\\s>])[^<>]{0,32}>");
// A suffix of the buffer that could still grow into a render tag: either an
// unterminated \x3c<name> … opening (attrs so far, no \x3e yet) or a short
// ambiguous prefix like \x3c, \x3ca, \x3c/ac, \x3cacip, …
const PARTIAL_TAIL = new RegExp("(\x3c" + NAME + "\\s[^<>]*|\x3c\\/" + NAME + "(?:\\s[^<>]{0,32})?|\x3c\\/?[acip]*)$");
// An unterminated render-tag opening at the end of a string: \x3c<name> plus
// attrs, no \x3e — a truncated imitation, never prose (triggers use \x3cacp_).
const TRUNC_OPEN = new RegExp("\x3c" + NAME + "\\s[^<>]*$");
// A truncated render-tag CLOSE at the end of a string: \x3c/<name> optionally
// plus truncated attrs — a truncated imitation close, never prose. Mirrors
// TRUNC_OPEN on the close side.
const TRUNC_CLOSE = new RegExp("\x3c\\/" + NAME + "(?:\\s[^<>]{0,32})?$");
const DEFINITE_TAIL = new RegExp("^\x3c" + NAME + "\\s|^\x3c\\/" + NAME);
const OPEN_WITH_ATTRS = new RegExp("^\x3c" + NAME + "\\s");
const CLOSE_HEAD = "\x3c/";
const CLOSE_NAME_ANCHORED = new RegExp("^" + NAME);
const HOLD_LIMIT = 128;
// Hold cap for a definite unterminated opening tail — far beyond any real tag
// opening; beyond this the tail is dropped instead of held or passed through.
const TAG_OPEN_CAP = 4096;
const SWALLOW_CAP = 80;

/** Exclusive end index (past the terminating \x3e) of the first loose close
 *  tag in s, or -1. #673: the close name may be a typo variant; termination
 *  still requires the strict \x3e right after the name — malformed closes are
 *  LONE_CLOSE's job, not the swallow terminator's. */
function looseCloseEnd(s: string): number {
    let idx = s.indexOf(CLOSE_HEAD);
    while (idx >= 0) {
        const m = CLOSE_NAME_ANCHORED.exec(s.slice(idx + 2));
        if (m && s[idx + 2 + m[0].length] === ">") return idx + 2 + m[0].length + 1;
        idx = s.indexOf(CLOSE_HEAD, idx + 1);
    }
    return -1;
}

export interface TagEchoFilterStats {
    /** Raw chars pushed over the filter's lifetime (before stripping). */
    inputChars: number;
    /** Clean chars emitted (push outputs + flush output). */
    outputChars: number;
    /** Whether anything was dropped as an imitation. */
    dropped: boolean;
}

export interface TagEchoFilter {
    push(delta: string): string;
    flush(): string;
    dropped(): boolean;
    /** True while the filter holds a partial-tag tail that a later push may complete. */
    pending(): boolean;
    /** Lifetime accounting — feeds degenerate-turn detection (#673). Deliberately not reset by intermediate flushes. */
    stats(): TagEchoFilterStats;
}

// #717: model-emitted ACP CONFIRMATION MARKERS. After executing a proxy tool
// call bili emits a visibility marker ("\n📦 [ACP] Compressed m00120–m0300 →
// 1 block(s), ~12K tokens saved.") as a standalone text block; in client
// history it looks like ordinary assistant text. Under sustained context
// pressure a model was observed writing these markers itself — 17 fake
// "compressions" that never reached the proxy (#717). Real markers never pass
// through the model-output path (the proxy injects them itself), so any
// marker-shaped line in upstream model output is by definition forged: strip
// the line and warn, breaking the self-reinforcing loop. Shape: line start +
// exactly one Unicode symbol char (\p{So} — every real marker icon is a single
// So code point; letters such as CJK hanzi are prose, not markers, so a line
// like "见[ACP]标记的含义" must survive) + optional single space/tab + literal
// "[ACP]". Strictly no leading whitespace: an indented occurrence is quoting
// the format (code block, docs) and must pass through. The multi-line
// acp_status variant only has its head line stripped — without the head the
// body reads as unattributed prose, and no reliable terminator exists to
// swallow it safely.
const MARKER_HEAD = /^\p{So}(?:[ \t])?\[ACP\]/u;
// Deliberately BROADER than MARKER_HEAD: the streaming state machine must
// hold ANY non-ASCII line-start prefix (CJK, accented letters, and lone
// surrogates produced when a chunk boundary splits an astral icon) because
// it cannot know whether the next chunk completes a forged head. Holding is
// cheap and lossless (flush/content-preservation resolves it); the strict
// \p{So} decision happens only in MARKER_HEAD, so prose is never stripped.
const MARKER_HEAD_PREFIX = /^[^\x00-\x7F](?:[ \t])?(?:\[ACP\]|\[ACP|\[AC|\[A|\[)?$/u;
const MARKER_LINE = /^\p{So}(?:[ \t])?\[ACP\][^\n]*\n?/gmu;
// Conservative tail probe for the streaming fast-path gate below: the chunk's
// last line is still an undecidable marker-head prefix (icon alone, or icon +
// partial "[ACP"), so the next chunk must flow through the filter. Any
// non-ASCII lead is accepted here on purpose — over-pushing costs one no-op
// filter pass, under-pushing leaks a forged marker.
const MARKER_TAIL = /(?:^|\n)[^\x00-\x7F](?:[ \t])?(?:\[ACP|\[AC|\[A|\[)?$/u;

/** Fast-path gate for the streaming pipes (#717): could this chunk contain a
 *  forged marker line, or leave a marker head undecidable across the chunk
 *  boundary? Coarse by design — a false positive costs one no-op filter pass,
 *  but skipping a chunk that carries or starts a forged line forwards it raw. */
export function mayStartMarkerLine(s: string): boolean {
    return s.includes("[ACP]") || MARKER_TAIL.test(s);
}

export function stripMarkerLines(text: string): string {
    return text.replace(MARKER_LINE, "");
}

export function stripAcpTags(text: string): string {
    return text
        .replace(new RegExp(PAIRED.source, "g"), "")
        .replace(new RegExp(LONE_OPEN.source, "g"), "")
        .replace(new RegExp(LONE_CLOSE.source, "g"), "")
        .replace(new RegExp(TRUNC_OPEN.source), "")
        .replace(new RegExp(TRUNC_CLOSE.source), "")
        .replace(MARKER_LINE, "");
}

// Raw-wire pre-check for forged confirmation markers (#717): the literal
// "[ACP]" survives JSON escaping unscathed (brackets are not escaped), so a
// plain includes() on the raw SSE/JSON string is sound and cheap. The
// false-positive cost is one no-op re-serialize; the strict line-anchored
// match decides what actually gets removed.
export function containsMarkerLineText(s: string): boolean {
    return s.includes("[ACP]");
}

// Cheap pre-check on a raw wire string (SSE event or JSON body): does it
// contain anything that looks like a render tag (literal or JSON-escaped
// \u003c form)? Callers use this to skip re-serializing chunks that need
// no stripping, preserving byte-identical passthrough.
const RENDER_TAG_DETECT = new RegExp("\x3c\\/?" + NAME + "(?=[\\s>])|\\\\u003c\\/?" + NAME + "(?=[\\s>\\\\])");
export function containsRenderTagText(s: string): boolean {
    return RENDER_TAG_DETECT.test(s);
}

// #468: some upstreams stream a model-imitated render tag in tokenizer-sized
// fragments ("\x3cac", "p tokens", ...) so no single chunk ever trips
// RENDER_TAG_DETECT. Per-chunk gates must also engage when the chunk contains
// or ends with the head of a render tag, so the streaming state machine can
// stitch it back together. Pure-prose chunks still skip the machine
// (byte-identical passthrough); only chunks with a tag-head tail ("\x3c", "\x3c/",
// "\x3ca", "\x3cac", "\x3cacp ...attrs", "\x3c/acp ...") engage it.
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
    let inputChars = 0;
    let outputChars = 0;
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
                const end = looseCloseEnd(combined);
                if (end >= 0) {
                    drop(combined.slice(0, end));
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
                    // A definite \x3c<name> opening is never prose — hold it far
                    // past HOLD_LIMIT (drop it past TAG_OPEN_CAP); a short
                    // ambiguous prefix stays on the small hold cap so prose
                    // is never delayed or lost.
                    const definite = DEFINITE_TAIL.test(t[0]);
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
            if (m === o && OPEN_WITH_ATTRS.test(m[0])) {
                swallowUntilClose = true;
                swallowed = "";
            }
        }
        return out;
    };
    return {
        push(delta: string): string {
            inputChars += delta.length;
            const chunk = held + delta;
            held = "";
            const r = process(chunk);
            outputChars += r.length;
            return r;
        },
        flush(): string {
            const rest = swallowed + held;
            const wasSwallowing = swallowUntilClose;
            swallowed = "";
            held = "";
            swallowUntilClose = false;
            let result: string;
            if (wasSwallowing) {
                // Stream ended inside an unclosed render tag: the held content
                // is tag content (a ref), not prose.
                if (rest.length > 0) drop(rest);
                result = "";
            } else {
                const t = new RegExp(TRUNC_OPEN.source).exec(rest);
                if (t) {
                    drop(t[0]);
                    result = rest.slice(0, t.index);
                } else {
                    const tc = new RegExp(TRUNC_CLOSE.source).exec(rest);
                    if (tc) {
                        drop(tc[0]);
                        result = rest.slice(0, tc.index);
                    } else {
                        result = rest;
                    }
                }
            }
            outputChars += result.length;
            return result;
        },
        dropped(): boolean {
            return droppedAny;
        },
        pending(): boolean {
            return held.length > 0 || swallowUntilClose;
        },
        stats(): TagEchoFilterStats {
            return { inputChars, outputChars, dropped: droppedAny };
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

// #717 streaming counterpart of stripMarkerLines. Same contract as
// createTagEchoFilter: push deltas, emit clean text, hold back at most the
// undecidable line-start prefix (~8 chars) until a later push decides it,
// flush resolves at block/stream end. A swallowed marker line is dropped
// whole (its \n included) so surrounding lines rejoin cleanly.
export function createMarkerLineFilter(onDrop?: (snippet: string) => void): TagEchoFilter {
    let buf = "";
    let atLineStart = true;
    let swallowing = false;
    let droppedAny = false;
    let notified = false;
    let inputChars = 0;
    let outputChars = 0;

    const noteDrop = (snippet: string) => {
        droppedAny = true;
        if (!notified) {
            notified = true;
            onDrop?.(snippet);
        }
    };

    const process = (chunk: string): string => {
        buf += chunk;
        inputChars += chunk.length;
        let out = "";
        while (buf.length > 0) {
            if (swallowing) {
                const nl = buf.indexOf("\n");
                if (nl < 0) return out;
                noteDrop(buf.slice(0, nl));
                buf = buf.slice(nl + 1);
                swallowing = false;
                atLineStart = true;
                continue;
            }
            if (atLineStart) {
                if (MARKER_HEAD.test(buf)) {
                    swallowing = true;
                    continue;
                }
                if (MARKER_HEAD_PREFIX.test(buf)) return out;
                out += buf[0];
                buf = buf.slice(1);
                atLineStart = false;
                continue;
            }
            const nl = buf.indexOf("\n");
            if (nl >= 0) {
                out += buf.slice(0, nl + 1);
                buf = buf.slice(nl + 1);
                atLineStart = true;
            } else {
                out += buf;
                buf = "";
            }
        }
        outputChars += out.length;
        return out;
    };

    return {
        push(delta: string): string {
            return process(delta);
        },
        flush(): string {
            let out = "";
            if (buf.length > 0) {
                if (swallowing || MARKER_HEAD.test(buf)) {
                    noteDrop(buf);
                    buf = "";
                } else {
                    // Undecidable prefix or plain tail: content preservation.
                    out = buf;
                    buf = "";
                }
            }
            swallowing = false;
            atLineStart = true;
            outputChars += out.length;
            return out;
        },
        dropped: () => droppedAny,
        pending: () => buf.length > 0,
        stats: () => ({ inputChars, outputChars, dropped: droppedAny }),
    };
}

/** Run two streaming filters in sequence (input flows a→b), so the
 *  marker-line stripper (#717) layers onto the render-tag echo filter
 *  (#206/#673) without touching call sites. Stats merge: input from a,
 *  output from b, dropped/pending OR'd. */
export function composeStreamFilters(a: TagEchoFilter, b: TagEchoFilter): TagEchoFilter {
    return {
        push: (delta: string) => b.push(a.push(delta)),
        flush: () => {
            const tail = a.flush();
            return tail === "" ? b.flush() : b.push(tail) + b.flush();
        },
        dropped: () => a.dropped() || b.dropped(),
        pending: () => a.pending() || b.pending(),
        stats: () => ({
            inputChars: a.stats().inputChars,
            outputChars: b.stats().outputChars,
            dropped: a.dropped() || b.dropped(),
        }),
    };
}
