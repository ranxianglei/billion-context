import { parseChainCheckpoint, TAG_OPEN } from "../chain-checkpoint.js";
import { CODEX_FORGED_HANDOFF_HEADER, FORGED_SUMMARY_HEADER } from "../codex-compact.js";

// Streaming-safe stripper for model-emitted literal ACP render tags (#206).
// Compressed history is rendered to the model as render tags; models sometimes
// imitate them in visible output ("tag echo"), the client replays the echoed
// tags on later turns, and the imitation amplifies into unbounded repetition.
// Stripping render tags from outgoing text breaks the loop at the source.
//
// The imitation has two shapes. The plain one is a copy of the rendered form
// (an opening with its attributes, a ref inside, a close); the wrapped one puts
// the model's whole turn, its tool call included, where the opening's
// attributes are still open, so no close is ever written and regex matching
// alone cannot see the span (see BROKEN_ATTRS, SWALLOW_CAP). Both end the same
// way: the span is swallowed, never handed to the client as orphan markup.
// ONLY the render form (\x3c<name> attrs…\x3e, \x3c<name …/\x3e, \x3c/<name>\x3e) is stripped —
// the underscore-namespaced text-protocol triggers (\x3cacp_compress\x3e etc.) and
// ordinary prose containing \x3c pass through untouched.
// #673: models typo the 3-letter name when imitating (observed: acip/acpi,
// including mixed correct-open + typo'd-close), so <name> matches a bounded
// mutation set instead of the exact spelling: the three core letters in any
// order, plus at most ONE extra letter drawn from that set or an inserted i.
// #1731: and the set folds case — models drift casing too, and uppercase
// echoes (\x3cACP …\x3e, \x3c/ACP\x3e) leaked verbatim because every name pattern was a
// lowercase literal. The folding is baked into the alternation itself as
// per-letter character classes rather than an `i` flag, so the .source-based
// reconstructions below (stripAcpTags, flush) stay behavior-identical: a
// flag would be silently dropped at every rebuild site. Every match still
// requires the name to be followed by \s or > (attrs or close), so real
// words that merely contain the letters (acpi/acpi.h includes, caption, app)
// never match; an angle-bracketed bare token like \x3cACPI\x3e is indistinguishable
// from a casing-drifted tag and is stripped, same trade as its lowercase form.
// A false positive costs at most the same bounded caps as before
// (swallow ≤ SWALLOW_CAP, hold ≤ HOLD_LIMIT/TAG_OPEN_CAP).
//
// ─── INVARIANT (#1039): tool-call arguments are user intent ─────────────────
// Anything the host will EXECUTE or PERSIST — tool-call arguments in every
// wire shape (openai tool_calls[].function.arguments fragments, anthropic
// input_json_delta.partial_json and tool_use.input, responses
// function_call_arguments.delta/.done and item.arguments) — is forwarded
// BYTE-EXACT. Never route it through any filter from this file, at fragment
// or whole-payload granularity, and never "clean" it because it contains a
// tag-shaped echo. A shape-based filter cannot distinguish a model-echoed
// render tag from a literal the user genuinely wants written (bash command
// strings, write/edit file contents): stripping arguments silently corrupts
// executed/persisted data (#1039). Echoed tags surfacing in a host TUI is
// cosmetic noise; that fix belongs on the injection side (host renderTags
// policy, #933), never here. The strippers below apply to model PROSE only
// (content/reasoning_content/reasoning/thinking/text/summary fields).
function buildAcplikeName(): string {
    const cores = ["acp", "apc", "cap", "cpa", "pac", "pca"];
    const ci = (ch: string) => `[${ch}${ch.toUpperCase()}]`;
    const fourLetter = new Set<string>();
    const threeLetter = new Set<string>();
    for (const c of cores) {
        threeLetter.add(ci(c.charAt(0)) + ci(c.charAt(1)) + ci(c.charAt(2)));
        for (let pos = 0; pos <= c.length; pos++) {
            fourLetter.add(
                c.slice(0, pos).split("").map(ci).join("") + "[aAcCpPiI]" + c.slice(pos).split("").map(ci).join(""),
            );
        }
    }
    return [...fourLetter, ...threeLetter].join("|");
}

/** Longest-first alternation of every tolerated render-tag name (#673), case-folded via letter classes (#1731). */
export const ACP_NAME_ALT = `(?:${buildAcplikeName()})`;
const NAME = ACP_NAME_ALT;

// Opening-tag attrs carry NO length cap (#1731): [^<>] cannot cross an angle
// bracket, so these matchers stay linear for arbitrarily long attr runs, and
// a cap silently defined a bypass — a longer run escaped every open-tag
// matcher while the loose close still went, leaving orphan markup on the wire.
// Prose safety lives elsewhere: a terminated open is decided by the body's
// shape (#1720), an unterminated one by the definite-tail budget (TAG_OPEN_CAP)
// and the #644 release rules. Close-side tails keep their {0,32} bound — that
// one is load-bearing (#644: an unbounded close-side tail ate real content
// after a malformed close).
// A render tag wraps exactly one bare ref: the kernel emits <acp tokens="…"
// type="…">mNNNNN</acp> and nothing else between the tags (#1720). Content that
// is not a ref is prose wearing tags — the tags go, the content stays. No g
// flag: createTagEchoFilter drives it with exec() on a sliding buffer. It is
// flag-free by construction — case folding lives inside ACP_NAME_ALT's letter
// classes (#1731) — so every .source reconstruction below preserves behavior
// verbatim; an `i` flag would be silently dropped at each rebuild site.
const PAIRED = new RegExp("\x3c" + NAME + "\\s[^<>]*>(\\s*m\\d{4,}\\s*)\x3c\\/" + NAME + ">");
const REF_LIKE = /^\s*m\d{4,}\s*$/;
const LONE_OPEN = new RegExp("\x3c" + NAME + "(?:\\s[^<>]*)?>");
const LONE_CLOSE = new RegExp("\x3c\\/" + NAME + "(?=[\\s>])[^<>]{0,32}>");
// A suffix of the buffer that could still grow into a render tag: either an
// unterminated \x3c<name> … opening (attrs so far, no \x3e yet) or a short
// ambiguous prefix like \x3c, \x3ca, \x3c/ac, \x3cacip, …
const PARTIAL_TAIL = new RegExp("(\x3c" + NAME + "\\s[^<>]*|\x3c\\/" + NAME + "(?:\\s[^<>]{0,32})?|\x3c\\/?[aAcCpPiI]*)$");
// An unterminated render-tag opening at the end of a string: \x3c<name> plus
// attrs, no \x3e — a truncated imitation, never prose (triggers use \x3cacp_).
const TRUNC_OPEN = new RegExp("\x3c" + NAME + "\\s[^<>]*$");
// A truncated render-tag CLOSE at the end of a string: \x3c/<name> optionally
// plus truncated attrs — a truncated imitation close, never prose. Mirrors
// TRUNC_OPEN on the close side.
const TRUNC_CLOSE = new RegExp("\x3c\\/" + NAME + "(?:\\s[^<>]{0,32})?$");
// The wrapped-turn imitation: the model opens a render tag and writes its
// payload where the attributes are still open, so the attribute list runs into
// a `<` instead of ending at its `>`. The recorded shape (architect session
// 01a0a0cb, 2026-09-16T17:29:09) opens with `<acp tokens="1" text="text`
// immediately followed by the turn's own tool-call markup. No tag regex can
// match it — every attribute class stops at `<` — so the span is recognised by
// shape: a render-tag name, whitespace, then an attribute list bounded by the
// next `<`. A properly terminated opening never matches: its attribute list
// ends at a `>`, and no `<` can be reached from there within the class.
const BROKEN_ATTRS = new RegExp("\x3c" + NAME + "\\s[^<>]*(?=\x3c)");
const DEFINITE_TAIL = new RegExp("^\x3c" + NAME + "\\s|^\x3c\\/" + NAME);
const OPEN_WITH_ATTRS = new RegExp("^\x3c" + NAME + "\\s");
const CLOSE_HEAD = "\x3c/";
const CLOSE_NAME_ANCHORED = new RegExp("^" + NAME);
const HOLD_LIMIT = 128;
// Hold cap for a definite unterminated opening tail — far beyond any real tag
// opening; beyond this the tail is dropped instead of held or passed through.
const TAG_OPEN_CAP = 4096;
const SWALLOW_CAP = 80;
// Budget for a wrapped-turn imitation (see BROKEN_ATTRS), which is attested by
// shape rather than matched: the span is the imitation's payload, so passing
// the budget discards it instead of releasing it as prose (SWALLOW_CAP's #644
// rule, kept for the plain opening where an over-long tail is real content).
// It has to clear a whole turn — the recorded one ran 186 chars and held the
// turn's tool call.
const IMITATION_SWALLOW_CAP = 4096;

/** Exclusive end index (past the terminating \x3e) of the first loose close
 *  tag in s, or -1. #673: the close name may be a typo variant; termination
 *  still requires the strict \x3e right after the name — malformed closes are
 *  LONE_CLOSE's job, not the swallow terminator's. */
function looseCloseSpan(s: string): { start: number; end: number } | null {
    let idx = s.indexOf(CLOSE_HEAD);
    while (idx >= 0) {
        const m = CLOSE_NAME_ANCHORED.exec(s.slice(idx + 2));
        if (m && s[idx + 2 + m[0].length] === ">") return { start: idx, end: idx + 2 + m[0].length + 1 };
        idx = s.indexOf(CLOSE_HEAD, idx + 1);
    }
    return null;
}
function looseCloseEnd(s: string): number {
    const span = looseCloseSpan(s);
    return span === null ? -1 : span.end;
}

/** The span of one wrapped-turn imitation in `s`: where it starts, and the span
 *  that has to go — its head plus, when no loose close follows, the rest of the
 *  text (the model's whole turn lives inside it, tool call included). Returns
 *  null when no opening in `s` wraps the turn. An opening wraps the turn when
 *  its attribute list carries an odd number of quotes — a value was opened and
 *  never closed — or when the list runs into a `<` at all (BROKEN_ATTRS). Every
 *  genuine opening is balanced, e.g. `tokens="1" type="text"`. */
function wrappedSpan(s: string): { start: number; end: number } | null {
    const broken = BROKEN_ATTRS.exec(s);
    const open = LONE_OPEN.exec(s);
    const spans: { start: number; end: number }[] = [];
    if (broken) spans.push({ start: broken.index, end: broken.index + broken[0].length });
    if (open && OPEN_WITH_ATTRS.test(open[0]) && ((open[0].match(/"/g) ?? []).length & 1) === 1) {
        spans.push({ start: open.index, end: open.index + open[0].length });
    }
    if (spans.length === 0) return null;
    const first = spans.reduce((a, b) => (b.start < a.start ? b : a));
    const rest = s.slice(first.end);
    const close = looseCloseEnd(rest);
    return { start: first.start, end: close >= 0 ? first.end + close : s.length };
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
export const MARKER_LINE = /^\p{So}(?:[ \t])?\[ACP\][^\n]*\n?/gmu;
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
    // A wrapped-turn imitation first, whole: it swallows the model's turn, and
    // leaving its payload behind hands the client the orphan markup that makes
    // the turn unusable. Each pass removes at least the head, so this ends.
    let out = text;
    for (;;) {
        const wrapped = wrappedSpan(out);
        if (wrapped === null) break;
        out = out.slice(0, wrapped.start) + out.slice(wrapped.end);
    }
    out = out
        .replace(new RegExp(PAIRED.source, "g"), "")
        .replace(new RegExp(LONE_OPEN.source, "g"), "")
        .replace(new RegExp(LONE_CLOSE.source, "g"), "")
        .replace(new RegExp(TRUNC_OPEN.source), "")
        .replace(new RegExp(TRUNC_CLOSE.source), "")
        .replace(MARKER_LINE, "");
    return stripBiliArtifacts(out);
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

// ─── #1634: bili-owned internal artifacts echoed by the model ───────────────
// The proxy injects three artifact families into model-visible payloads: the
// outbound checkpoint carrier (\x3cbili-chain \u2026/\x3e stamped onto forwarded requests),
// the forged-compaction handoff user message, and captured summary blocks (the
// latter two carry fixed header lines). Under sustained context pressure
// models were observed restating these verbatim as their answer to the user's
// turn, and the echoes persist turn over turn because they ride client
// history — the render-tag/marker strippers above know none of these shapes.
// Real carriers never traverse the model-output path (the proxy writes them
// itself), so any occurrence in model output is model-generated by definition:
// strip it, breaking the self-reinforcing loop. Recognition keys off the SAME
// constants the injectors use (single source of truth): chain spans validate
// through the frozen checkpoint parser, headers match literally at line start
// (a mid-line mention such as "the [Compressed conversation section] covers…"
// is prose and passes through).
const CHAIN_OPEN_ESCAPED = "\\u003c" + TAG_OPEN.slice(1);
const CHAIN_TERMINATORS = ['"/\x3e', "/\\u003e", "\\u002f\\u003e"];
// A real carrier runs \u2264~200 chars (parser ceiling 512); a longer
// unterminated opening is fabricated, not truncated-in-transit.
const CHAIN_TAIL_CAP = 640;

function unescapeBili(s: string): string {
    return s.replace(/\\u003c/g, "\x3c").replace(/\\u003e/g, "\x3e").replace(/\\u002f/g, "/");
}

/** Exclusive end index of the first chain-tag terminator in rest, or -1. */
function chainTerminatorEnd(rest: string): number {
    let best = -1;
    for (const t of CHAIN_TERMINATORS) {
        const i = rest.indexOf(t);
        if (i >= 0 && (best < 0 || i < best)) best = i + t.length;
    }
    return best;
}

/** Index of the first chain-tag opening (literal or \u003c-escaped form), or -1. */
function chainOpenIndex(s: string): number {
    const i = s.indexOf(TAG_OPEN);
    const ie = s.indexOf(CHAIN_OPEN_ESCAPED);
    if (ie >= 0 && (i < 0 || ie < i)) return ie;
    return i;
}

/** Span of the next WELL-FORMED checkpoint carrier in s (validated by the
 *  frozen parser after unescaping), or null. Malformed/unterminated openings
 *  are NOT spans here: they stay in place for the streaming tail logic, where
 *  under-budget truncations are released as prose (content preservation). */
export function nextChainSpan(s: string): { start: number; end: number } | null {
    const i = chainOpenIndex(s);
    if (i < 0) return null;
    const rest = s.slice(i);
    const end = chainTerminatorEnd(rest);
    if (end <= 0) return null;
    if (parseChainCheckpoint(unescapeBili(rest.slice(0, end))) === null) return null;
    return { start: i, end: i + end };
}

/** Cut point of a header-led block: position 0 or immediately after a newline
 *  where the text starts with either internal-artifact header — everything
 *  from the cut to the END of the text field is the block (streaming flush
 *  discards the remainder; whole-text slicing mirrors it). */
export function headBlockCut(s: string): number {
    if (s.startsWith(CODEX_FORGED_HANDOFF_HEADER) || s.startsWith(FORGED_SUMMARY_HEADER)) return 0;
    let nl = s.indexOf("\n");
    while (nl >= 0) {
        const p = nl + 1;
        if (s.startsWith(CODEX_FORGED_HANDOFF_HEADER, p) || s.startsWith(FORGED_SUMMARY_HEADER, p)) return p;
        nl = s.indexOf("\n", nl + 1);
    }
    return -1;
}

export function stripBiliArtifacts(text: string): string {
    let out = text;
    for (;;) {
        const span = nextChainSpan(out);
        if (span === null) break;
        out = out.slice(0, span.start) + out.slice(span.end);
    }
    const cut = headBlockCut(out);
    return cut >= 0 ? out.slice(0, cut) : out;
}

// Raw-wire pre-check (SSE event or JSON body): does it carry anything the
// bili-artifact stripper would act on? Literal and \u003c-escaped chain opens
// plus the two header lines (plain ASCII, survive JSON escaping unscathed).
export function containsBiliInternalText(s: string): boolean {
    return s.includes(TAG_OPEN)
        || s.includes(CHAIN_OPEN_ESCAPED)
        || s.includes(CODEX_FORGED_HANDOFF_HEADER)
        || s.includes(FORGED_SUMMARY_HEADER);
}

function reEscape(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prefixAlts(s: string, minLen: number): string[] {
    const out: string[] = [];
    for (let k = minLen; k < s.length; k++) out.push(reEscape(s.slice(0, k)));
    return out;
}

// Streaming tail probes: a buffer cut mid-opening ends in the opening's
// leading chars, so the held tail is any prefix of either open form (plus the
// complete forms); a last line that is still a prefix of a header is held
// from its first char — a lone line-start "[" must survive chunk boundaries
// because both headers begin with it and the decision splits on the second
// char (broad-hold/strict-decide, same trade as MARKER_HEAD_PREFIX).
const CHAIN_PARTIAL_TAIL = new RegExp("(" + [...new Set([
    ...prefixAlts(TAG_OPEN, 1),
    reEscape(TAG_OPEN),
    ...prefixAlts(CHAIN_OPEN_ESCAPED, 1),
    reEscape(CHAIN_OPEN_ESCAPED),
])].join("|") + ")$");
const HEAD_PREFIX_TAIL = new RegExp("(?:^|\n)(" + [...new Set([
    ...prefixAlts(CODEX_FORGED_HANDOFF_HEADER, 1),
    ...prefixAlts(FORGED_SUMMARY_HEADER, 1),
])].join("|") + ")$");

/** Fast-path gate for the streaming pipes: could this chunk contain a bili
 *  internal artifact, or leave one undecidable across the chunk boundary?
 *  Coarse by design — a false positive costs one no-op filter pass, but
 *  skipping a chunk that carries or starts an artifact forwards it raw. */
export function mayStartBiliInternal(s: string): boolean {
    return containsBiliInternalText(s) || CHAIN_PARTIAL_TAIL.test(s) || HEAD_PREFIX_TAIL.test(s);
}

function tailHoldLen(s: string): number {
    const m = CHAIN_PARTIAL_TAIL.exec(s);
    const h = HEAD_PREFIX_TAIL.exec(s);
    return Math.max(m ? m[0].length : 0, h ? h[0].length : 0);
}

export function createBiliArtifactFilter(onDrop?: (snippet: string) => void): TagEchoFilter {
    let buf = "";
    let swallowing = false;
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
        inputChars += input.length;
        if (swallowing) return "";
        buf += input;
        let out = "";
        let openHeld = false;
        for (;;) {
            const cut = headBlockCut(buf);
            if (cut >= 0) {
                out += buf.slice(0, cut);
                drop(buf.slice(cut));
                swallowing = true;
                buf = "";
                break;
            }
            const span = nextChainSpan(buf);
            if (span !== null) {
                out += buf.slice(0, span.start);
                drop(buf.slice(span.start, span.end));
                buf = buf.slice(span.end);
                continue;
            }
            const oi = chainOpenIndex(buf);
            if (oi >= 0) {
                out += buf.slice(0, oi);
                const tail = buf.slice(oi);
                if (tail.length > CHAIN_TAIL_CAP) {
                    // Over cap without a terminator: not a real carrier (those
                    // are bounded far below the cap) — release as prose, never
                    // drop (#1039 content preservation, cf. #644).
                    out += tail;
                    buf = "";
                } else {
                    buf = tail;
                    openHeld = true;
                }
                break;
            }
            break;
        }
        if (!swallowing && buf.length > 0 && !openHeld) {
            const hold = tailHoldLen(buf);
            if (hold > 0) {
                out += buf.slice(0, buf.length - hold);
                buf = buf.slice(buf.length - hold);
            } else {
                out += buf;
                buf = "";
            }
        }
        outputChars += out.length;
        return out;
    };
    return {
        push: process,
        flush(): string {
            let out = "";
            if (swallowing) {
                if (buf.length > 0) drop(buf);
                buf = "";
                swallowing = false;
            } else if (buf.length > 0) {
                out = buf;
                buf = "";
            }
            outputChars += out.length;
            return out;
        },
        dropped: () => droppedAny,
        pending: () => buf.length > 0 || swallowing,
        stats: () => ({ inputChars, outputChars, dropped: droppedAny }),
    };
}

export function createTagEchoFilter(onDrop?: (snippet: string) => void): TagEchoFilter {
    let held = "";
    let swallowUntilClose = false;
    let swallowed = "";
    /** Which budget the current swallow answers to (SWALLOW_CAP or
     *  IMITATION_SWALLOW_CAP). */
    let swallowLimit = SWALLOW_CAP;
    /** Whether passing that budget releases the span as prose — true for a plain
     *  opening, where an over-long tail is content (#644); false for a
     *  wrapped-turn imitation, which is attested by shape and whose payload must
     *  never reach the client. */
    let swallowReleases = true;
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
                const span = looseCloseSpan(combined);
                if (span !== null) {
                    // Only a ref-shaped body is tag content (#1720): a prose
                    // body between paired tags is released and just the close
                    // goes. An attested imitation (swallowReleases=false)
                    // discards whatever the body is.
                    const inner = combined.slice(0, span.start);
                    if (REF_LIKE.test(inner) || !swallowReleases) {
                        drop(combined.slice(0, span.end));
                    } else {
                        out += inner;
                        drop(combined.slice(span.start, span.end));
                    }
                    swallowed = "";
                    swallowUntilClose = false;
                    buf = combined.slice(span.end);
                    continue;
                }
                if (combined.length > swallowLimit) {
                    swallowed = "";
                    if (swallowReleases) {
                        swallowUntilClose = false;
                        buf = combined;
                        continue;
                    }
                    // The span is an attested imitation's payload: discard it and
                    // keep swallowing, so no part of it reaches the client.
                    drop(combined);
                    return out;
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
            // An opening whose attribute list never terminates (see
            // BROKEN_ATTRS): everything after it is the imitation's payload,
            // the turn's own tool call among it. Dropping the head alone
            // would hand the client the orphan markup that makes the turn
            // unusable, so the span is swallowed whole and the turn reaches
            // the client empty, where the degenerate-turn retry re-asks for
            // it (#732/#821). A loose close still ends the span, so genuine
            // prose after a closed imitation survives.
            // The span's payload runs THROUGH any later tag match — the
            // imitation's own markup, and the loose close that ends it, are
            // inside the span — so a broken opening starting FIRST owns the
            // buffer. Checked only under `!m`, a close sharing the chunk won the
            // earliest-match race and the imitation reached the client verbatim.
            // A properly terminated opening can never match here: its attribute
            // list ends at its `>`, which the class cannot cross.
            const broken = BROKEN_ATTRS.exec(buf);
            if (broken && (m === null || broken.index < m.index)) {
                drop(broken[0]);
                out += buf.slice(0, broken.index);
                buf = buf.slice(broken.index + broken[0].length);
                swallowUntilClose = true;
                swallowLimit = IMITATION_SWALLOW_CAP;
                swallowReleases = false;
                swallowed = "";
                continue;
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
                // An odd number of quotes means the opening's attribute list
                // never closed: the model wrapped its turn inside the value (the
                // sibling shape opens with such a value and then runs into a `<`,
                // which BROKEN_ATTRS catches). A wrapped span is the imitation's
                // payload — its tool call among it — so it is discarded rather
                // than released at the #644 budget. Every genuine opening has
                // balanced quotes: `tokens="1" type="text"`.
                const wrapped = ((m[0].match(/"/g) ?? []).length & 1) === 1;
                swallowUntilClose = true;
                swallowLimit = wrapped ? IMITATION_SWALLOW_CAP : SWALLOW_CAP;
                swallowReleases = !wrapped;
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
    if (!it || typeof it !== "object") return it;
    const io = it as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    const set = (k: string, v: unknown): void => {
        out ??= { ...io };
        out[k] = v;
    };
    if (Array.isArray(io.content)) set("content", stripParts(io.content));
    if (Array.isArray(io.summary)) {
        set(
            "summary",
            io.summary.map((s) =>
                s && typeof s === "object" && typeof (s as Record<string, unknown>).text === "string"
                    ? { ...(s as Record<string, unknown>), text: stripAcpTags((s as Record<string, unknown>).text as string) }
                    : s,
            ),
        );
    }
    return out ?? it;
}

function stripIfString(v: unknown): unknown {
    return typeof v === "string" ? stripAcpTags(v) : v;
}

// Plugin-passthrough parity for the OpenAI chat-completions wire (issue #14:
// pi + qwen echoed render tags through the verbatim plugin stream): strip the
// text fields a chat chunk / completion carries —
// `choices[].delta.{content,reasoning_content,reasoning}` on streams,
// `choices[].message.*` on non-streaming bodies. Tool-call arguments are
// deliberately left untouched (#1039): they carry user intent that hosts
// execute/persist, so a shape-based false positive would silently corrupt
// data — only model prose is stripped. Mutates in place, mirroring
// stripResponsesText.
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
// on response.completed. Tool-call arguments (`.arguments`, the `.delta`
// fragment carriers) are deliberately untouched (#1039): they carry user
// intent that hosts execute/persist, so a shape-based false positive would
// silently corrupt data — only model prose is stripped.
export function stripResponsesText<T>(obj: T): T {
    if (!obj || typeof obj !== "object") return obj;
    const o = obj as Record<string, unknown>;
    if (typeof o.text === "string") o.text = stripAcpTags(o.text);
    if (o.part && typeof o.part === "object" && typeof (o.part as Record<string, unknown>).text === "string") {
        o.part = { ...(o.part as Record<string, unknown>), text: stripAcpTags((o.part as Record<string, unknown>).text as string) };
    }
    if (o.item && typeof o.item === "object") {
        o.item = stripItemContent(o.item);
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
