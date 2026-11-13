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
    // #2190 round 2: field-attested drift names OUTSIDE the core+insertion
    // set. Inclusion rule (round 3 decontamination): a name enters ONLY on
    // CLEAN spontaneous evidence — block-initial emission, tokens= attribute,
    // deduped n>=4 — because open-side grep counts are inflated by the model
    // quoting tag names inside its own reasoning. Qualifying: accessp, acacp,
    // acb. Considered and EXCLUDED: acpx (raw census ~217 fails the clean
    // filter — self-referential/constructed hits; one case-variant sighting
    // only) and acpaa (n=1). Excluded forms are not silent: the fast-path and
    // filter-release residue audits (#2190) warn on m\d{4,}</word> shapes, so
    // any production appearance is observable and can earn inclusion later.
    // Exact enumeration only — every character-class generalization that
    // covers these also matches real prose words (acgroup/acmap/acstep are
    // structurally identical to acacp).
    const attestedDrift = [
        "[aA][cC][cC][eE][sS][sS][pP]",
        "[aA][cC][aA][cC][pP]",
        "[aA][cC][bB]",
    ];
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
    return [...attestedDrift, ...fourLetter, ...threeLetter].join("|");
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
// A render tag wraps ONLY KERNEL REFS between its tags: the kernel emits <acp tokens="…"
// type="…">mNNNNN</acp> and nothing else between the tags (#1720). Content that
// is not refs-only is prose wearing tags — the tags go, the content stays
// (#1720/#2023). No g
// flag: createTagEchoFilter drives it with exec() on a sliding buffer. It is
// flag-free by construction — case folding lives inside ACP_NAME_ALT's letter
// classes (#1731) — so every .source reconstruction below preserves behavior
// verbatim; an `i` flag would be silently dropped at each rebuild site.
// Attrs are OPTIONAL: the kernel always emits them, but models imitate the
// bare form <name>mNNNNN</name> (#1881) — whole-span strip must cover it or
// the interior ref leaks as residue after the lone tags go.
const REF_TOKEN = "m\\d{4,}";
// One kernel ref, or a run of them joined by whitespace / dash / comma — the
// shapes the compress machinery prints (single ref, mNNNNN–mMMMMM ranges,
// comma-separated range lists) that models imitate inside or beside render
// tags (#2023). A bare run is never prose: prose cites ONE ref among words,
// never a sequence of them. The separator is written UNAMBIGUOUSLY — leading
// spaces, then optionally ONE joiner plus its trailing spaces — so a given
// span has exactly one parse. The equivalent two-arm form lets both \s*
// arms claim the same spaces; when a later alternative fails the engine
// replays 2^N partitions over an N-ref run (#4178: one push of 28
// space-joined refs took 11s; 34 refs ~ 1.2h — comma-joined was 2ms).
const REFS_RUN = REF_TOKEN + "(?:\\s*(?:[\u2013\u2014,\-]\\s*)?" + REF_TOKEN + ")*";
// Whole string is a refs run (optionally padded): tag content, not prose.
const REFS_ONLY = new RegExp("^\\s*" + REFS_RUN + "\\s*$");
// Superset: the run may also END on an incomplete ref prefix (m / m0 / m00…)
// or a dangling joiner — refs-shaped so far, verdict pending the next delta.
// The swallow cap defers its release-vs-drop decision while this holds, or
// the verdict flips with the chunk boundary (chunk-split determinism). The
// tail separator keeps the unambiguous one-parse-per-span form (#4178).
const PENDING_REF_SPAN = new RegExp("^\\s*" + REFS_RUN + "(?:\\s*(?:[\\u2013\\u2014,\\-]\\s*)?(?:m\\d{0,3})?)?\\s*$");
// Body of a paired render tag: refs-only or empty (#1720/#2023). Anything
// else is prose wearing tags — PAIRED must not match it.
const PAIRED_BODY = "\\s*(?:" + REFS_RUN + ")?\\s*";
const PAIRED = new RegExp("\x3c" + NAME + "(?:\\s[^<>]*)?>(" + PAIRED_BODY + ")" + "\x3c\\/" + NAME + ">");
// An orphan refs run sitting directly against a close tag: the open half was
// consumed by another branch (or never came), and stripping the close alone
// leaves the refs behind as residue (#2023). The unit — run plus close — is
// dead markup; the lookbehind keeps word-like tokens (xm01233) and refs
// adjacent to a tag terminator out of it — a run right after \x3e belongs to
// tag structure (an over-cap-dropped opening, #644) and stays lossless.
// Streaming: consulted only when no opening is live (the swallowing state
// owns paired closes, #1720). Whole-text: applied to UNMATCHED closes only
// (see orphanCloseSpans) so a ref cited inside a prose-wearing pair survives.
const ORPHAN_REF_CLOSE = new RegExp("(?<![\\w>])" + REFS_RUN + "\\s*\x3c\\/" + NAME + "(?=[\\s>])[^<>]{0,32}>");
// Same unit anchored to the END of a string: the refs run immediately
// preceding an unmatched close (whole-text orphan pass).
const ORPHAN_RUN_BEFORE = new RegExp("(?<![\\w>])" + REFS_RUN + "\\s*$");
const LONE_OPEN = new RegExp("\x3c" + NAME + "(?:\\s[^<>]*)?>");
const LONE_CLOSE = new RegExp("\x3c\\/" + NAME + "(?=[\\s>])[^<>]{0,32}>");
// #2190: a ref body closed by a DEGENERATE close name (any short word — the
// drift set is open; the attested census alone has p/a/ap/apc/cap/ck/div/
// warn/aph/ambient/apm). Whole-span strip only: the open must be a valid
// acplike name and the body exactly one bare ref, so genuine HTML prose such
// as "see </p>" or "<a>m1234 text</a>" is untouched. Runs BEFORE the lone
// passes in stripAcpTags so the pair dies atomically instead of leaving the
// ref behind. #2348 owner decision §4 (instance C): the close name class is
// widened to any non-angle-bracket run — the census also contains FULLWIDTH
// corrupt closes (`</｜｜DSML｜｜ parameter>`), which the ASCII class left as
// orphan residue after the lone-open pass. {1,32} keeps a MINIMUM of one char
// on purpose: an empty-name close (`m1234</>`) stays visible, it is more
// likely shredded normal text than echo. Risk profile unchanged — the gate
// still requires the valid acplike open AND the single-bare-ref body.
const DEGEN_PAIR = new RegExp("\x3c" + NAME + "(?:\\s[^<>]*)?>\\s*m\\d{4,}\\s*\x3c\\/[^<>]{1,32}>", "g");
// #2348: the self-closing render-tag imitation: <name …/> and the bare <name/>.
// The kernel never emits it (its emitter is paired-form only); the model
// truncates the shape mid-way. It is a COMPLETE unit — the '/' before '>'
// terminates the element — so it dies in place. Two failure modes when treated
// like other opens: (1) streaming handed it to the LONE_OPEN swallow state,
// whose EOF rule drops an attrs-bearing unclosed opening's tail — measured:
// 57-char input around one such tag emitted 3 chars, following prose lost;
// (2) the BARE form matched no matcher anywhere (every open-side pattern
// requires whitespace or '>' directly after the name, never '/'), so it rode
// every fast path verbatim with zero warns. The slash is MANDATORY here so a
// genuine unterminated opening (<name …>) still takes the swallow/hold path.
const SELF_CLOSE = new RegExp("\x3c" + NAME + "(?:\\s[^<>]*)?\\/>");
// A suffix of the buffer that could still grow into a render tag: either an
// unterminated \x3c<name> … opening (attrs so far, no \x3e yet — the
// mangled \x3c<name>=… form counts too, #2066), a short
// ambiguous prefix like \x3c, \x3ca, \x3c/ac, \x3cacip, …, a trailing refs
// run whose close may arrive in the next chunk (#2023 orphan unit) — alone or
// already followed by the tag fragment that opens the split close — or a
// partial ref prefix (a bare m or m + 1-3 digits) that may complete across
// the boundary.
// Refs right after a tag terminator (\x3e) are NOT held: they belong to tag
// structure (over-cap-dropped openings, #644) and stay lossless. Held on the
// small cap so a split unit can be stripped whole; a lone trailing ref with
// no tag context is released at EOF, prose-safe. The bare-run alternative
// tolerates the unit's growing tail — trailing whitespace, a dangling range
// joiner, and an incomplete next ref (m / m0 / m00): ORPHAN_REF_CLOSE matches
// run+\s*+joiner+\s*+ref+close, so a chunk boundary anywhere inside that tail
// must hold the run too, or the close arrives as its own unit and the refs
// leak as residue (chunk-split determinism — same input, any chunking, same
// output). Trailing whitespace is held too (and allowed to lead the partial
// ref): a dead unit NEVER consumes the whitespace around it (it is content),
// in either mode, so chunk-split parity needs no cross-push whitespace
// memory.
const PARTIAL_TAIL = new RegExp("(\x3c" + NAME + "\\s[^<>]*|\x3c" + NAME + "\\s*=\\s*[^<>]*|\x3c\\/" + NAME + "(?:\\s[^<>]{0,32})?|\x3c\\/?[aAcCpPiI]*(?:\/)?|(?<![\\w>])\\s*" + REFS_RUN + "\\s*\x3c[^<>]*|(?<![\\w>])\\s*" + REFS_RUN + "(?:\\s*(?:[\\u2013\\u2014,\\-]\\s*)?(?:m\\d{0,3})?)?\\s*|(?<![\\w>])\\s*m\\d{0,3})$");
// An unterminated render-tag opening at the end of a string: \x3c<name> plus
// attrs, no \x3e — a truncated imitation, never prose (triggers use \x3cacp_).
// The mangled \x3c<name>=… form counts too: once the `=` is there the tail is
// tag content, not an element.
const TRUNC_OPEN = new RegExp("\x3c" + NAME + "\\s[^<>]*$|\x3c" + NAME + "\\s*=\\s*[^<>]*$");
// A truncated render-tag CLOSE at the end of a string: \x3c/<name> optionally
// plus truncated attrs — a truncated imitation close, never prose. Mirrors
// TRUNC_OPEN on the close side.
const TRUNC_CLOSE = new RegExp("\x3c\\/" + NAME + "(?:\\s[^<>]{0,32})?$");

// #2348 v4 corpus (owner EMIT-COUNTS): the `</ap` missing-`>` family (213
// ref-adjacent hits, 4th most common attested shape) ends a turn with a bare
// ref flush against a close cut mid-name at the hard stream boundary. Ref
// adjacency is the gate — prose never puts mNNNNN directly against a dangling
// </word — so the rule drops [ref][truncated close] together instead of
// leaving an orphan residue like the acplike-named case does. ASCII names
// ≤32 mirror the §4 close-name class minus non-ASCII breadth (unattested
// without the final >); the $ anchor keeps mid-text occurrences visible.
const TRUNC_REF_CLOSE = new RegExp("m\\d{4,}\\s*\\x3c\\/([a-zA-Z]{0,32})$");

// #2862: a DEAD ref-close unit — a refs run glued to a close-tag head whose
// \x3e never arrives (no terminator within the 32 non-angle window that
// LONE_CLOSE / ORPHAN_REF_CLOSE need, and not at the $ anchor TRUNC_REF_CLOSE
// covers). Same residue family as #2190/#2348: genuine prose never puts
// mNNNNN directly against \x3c/word, so once a tag-echo is attested in the
// same response the ref + unterminated close head are dead markup TOGETHER,
// while the prose after the head is content and survives. The name class is
// the open ASCII set ([a-zA-Z]{0,32}, TRUNC_REF_CLOSE width): #2190's census
// showed the close-name drift set is open (ap/ck/ak/fullwidth …). Two
// lookaheads keep live closes out: a letter means the name is still growing
// (the longer match owns it), and \x3e within the LONE_CLOSE window means the
// close terminates — those belong to the existing close rules. The
// [\w>] lookbehind mirrors ORPHAN_REF_CLOSE: word-adjacent runs (xm01233) and
// runs right after a tag terminator (\x3e, #644) are not this unit.
const DEAD_REF_CLOSE = new RegExp("(?<![\\w>])m\\d{4,}\\s*\\x3c\\/[a-zA-Z]{0,32}(?![a-zA-Z])(?![^\\x3c\\x3e]{0,32}\\x3e)", "g");
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
// A mangled render-tag OPENING: the name, then `=` where the attribute list's
// first whitespace belongs, e.g. `<acp=1>`. The kernel never emits it — the
// model mangles the framing it learned from the wire (production session
// ses_efe4cfcbdffe, 2026-10-03: 5 assistant turns opening with `<acp=1>`).
// The `=` anchor is what keeps plain HTML safe: `<caption>`, `<font>` and any
// real element name carry no `=`, and a properly formed render tag matches
// LONE_OPEN/PAIRED, not this.
const MANGLED_OPEN = new RegExp("\x3c" + NAME + "\\s*=\\s*[^<>]*>");
const DEFINITE_TAIL = new RegExp("^\x3c" + NAME + "\\s|^\x3c" + NAME + "=|^\x3c\\/" + NAME);
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
// #2190: models imitate the CLOSE with arbitrary short words instead of an
// acplike name — field census (session-A, 2026-10-05): ap/p/a/apc/cap/ck/div/
// warn/aph/ambient/apm, an open set a whitelist cannot keep up with. Accepted
// as a swallow terminator ONLY when the whole body since the opening is one
// bare ref (the kernel's emit shape, #1720): ref-body + any short close is an
// echo, never prose — a prose body stays indistinguishable from legitimate
// markup and keeps the existing hold/budget/flush behavior. Strict >
// termination, same discipline as looseCloseSpan (a partial close at the
// buffer end is still undecidable and stays held).
// #2348 §4: widened to any non-angle-bracket run so the streaming swallow
// ends on fullwidth corrupt closes too — same {1,32} class as DEGEN_PAIR, so
// both modes agree on where the span dies. The termination still routes
// through drop(), i.e. the existing [tag-echo] warn callback (owner §4(b)).
const DEGEN_CLOSE_NAME = /^[^<>]{1,32}>/;
// Single bare ref, exactly one (#2190 DEGEN_PAIR body rule); standalone const so
// this stays valid when the master REF_* token constants churn (#2025 stack compat, #2229).
const SINGLE_REF_BODY = /^\s*m\d{4,}\s*$/;
function degenCloseAfterRef(s: string): { start: number; end: number } | null {
    let idx = s.indexOf(CLOSE_HEAD);
    while (idx >= 0) {
        const m = DEGEN_CLOSE_NAME.exec(s.slice(idx + 2));
        if (m && SINGLE_REF_BODY.test(s.slice(0, idx))) return { start: idx, end: idx + 2 + m[0].length };
        idx = s.indexOf(CLOSE_HEAD, idx + 1);
    }
    return null;
}

/** Spans of every close tag in s with NO unmatched open before it (#2023).
 *  Opens and closes are paired greedily in document order (echoed tags are
 *  flat; kernel tags are well-nested), and only depth-zero closes count as
 *  orphans — a close inside any pair protects the refs run it terminates
 *  (#1720 prose-wearing pairs keep their content). */
function orphanCloseSpans(s: string): { start: number; end: number }[] {
    const events: { idx: number; open: boolean }[] = [];
    const reO = new RegExp(LONE_OPEN.source, "g");
    const reC = new RegExp(LONE_CLOSE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = reO.exec(s)) !== null) events.push({ idx: m.index, open: true });
    while ((m = reC.exec(s)) !== null) events.push({ idx: m.index, open: false });
    events.sort((a, b) => a.idx - b.idx);
    const spans: { start: number; end: number }[] = [];
    let depth = 0;
    for (const ev of events) {
        if (ev.open) {
            depth++;
        } else if (depth === 0) {
            const cm = new RegExp(LONE_CLOSE.source).exec(s.slice(ev.idx));
            if (cm) spans.push({ start: ev.idx, end: ev.idx + cm[0].length });
        } else {
            depth--;
        }
    }
    return spans;
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
    /** Stripped echo artifacts (one per logical occurrence — a pair split across
     *  pushes or a multi-chunk imitation counts once), lifetime. #2405(c). */
    dropCount: number;
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
// acp_status variant only has its head line stripped HERE too: the body is
// owned by the INCOMING-history path (stripAcpStatusBlocks, acp-panel.ts),
// which strips the [acp-status] sentinel pair exactly (#2789) and consumes
// pre-#2789 legacy bodies by report grammar. This FORGED-marker path must
// stay head-only: a forged body carries no trustworthy terminator, and
// swallowing past a guessed one risks eating real prose (#717).
export const MARKER_HEAD = /^\p{So}(?:[ \t])?\[ACP\]/u;
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

// #4106: input-side attestation for the DEAD_REF_CLOSE gate. Evidence produced
// by channels that run AFTER the gate (a truncated open at EOF, a forged
// marker line, a bili chain carrier / header block) is computed ONCE on the
// original text here, before any pass mutates it. The old gate (`out !==
// text`, evaluated mid-pipeline) only saw what earlier channels had already
// deleted, so a marker line stripped later in the SAME call never attested —
// and a second cleanup call shrank the bytes further: the verdict depended on
// prior cleanup state, not on content. Close-side channels (TRUNC_CLOSE /
// TRUNC_REF_CLOSE) are deliberately NOT attestation: they are the same
// close-only family the gate protects (#1760/#644 — a lone truncated close
// without other echo evidence stays content-preserved, bare ref included).
const MARKER_LINE_PROBE = new RegExp(MARKER_LINE.source, "mu"); // MARKER_LINE is /gmu — .test() on it is lastIndex-stateful
function laterChannelAttested(text: string): boolean {
    return TRUNC_OPEN.test(text)
        || MARKER_LINE_PROBE.test(text)
        || nextChainSpan(text) !== null
        || headBlockCut(text) >= 0;
}

/** One application of the full channel pipeline over one field. `attested`
 *  carries the input-side evidence computed once on the ORIGINAL text
 *  (#4106); `out !== text` adds this pass's own earlier-channel removals as
 *  evidence. */
function stripPass(text: string, dropToolCallEmission: boolean, requestText: string | undefined, attested: boolean): string {
    // A whole-field tool-call emission first: the field IS the call, so the
    // span goes whole (see toolCallEmissionSpan). Gated by the caller; the
    // m00885 echo check keeps a span the user asked to be emitted verbatim.
    if (dropToolCallEmission) {
        const span = toolCallEmissionSpan(text);
        if (span !== null && !emissionEchoesRequest(text.slice(span.start, span.end), requestText)) {
            text = text.slice(span.end);
        }
    }
    // A wrapped-turn imitation first, whole: it swallows the model's turn, and
    // leaving its payload behind hands the client the orphan markup that makes
    // the turn unusable. Each pass removes at least the head, so this ends.
    let out = text;
    for (;;) {
        const wrapped = wrappedSpan(out);
        if (wrapped === null) break;
        out = out.slice(0, wrapped.start) + out.slice(wrapped.end);
    }
    out = out.replace(new RegExp(PAIRED.source, "g"), "");
    // #2023: a refs run sitting directly against an UNMATCHED close is residue
    // (its open was consumed elsewhere or never came) and goes with the close.
    // A close inside any pair — even a prose-wearing one — belongs to that
    // pair's content and stays (#1720), so only depth-zero closes qualify.
    // Delete right-to-left so earlier offsets stay valid.
    {
        const spans = orphanCloseSpans(out);
        for (let i = spans.length - 1; i >= 0; i--) {
            const sp = spans[i];
            const pre = out.slice(0, sp.start);
            const rm = ORPHAN_RUN_BEFORE.exec(pre);
            if (!rm) continue;
            out = out.slice(0, pre.length - rm[0].length) + out.slice(sp.end);
        }
    }
    out = out
        .replace(new RegExp(PAIRED.source, "g"), "")
        .replace(DEGEN_PAIR, "")
        .replace(new RegExp(SELF_CLOSE.source, "g"), "")
        .replace(new RegExp(LONE_OPEN.source, "g"), "")
        .replace(new RegExp(MANGLED_OPEN.source, "g"), "")
        .replace(new RegExp(LONE_CLOSE.source, "g"), "")
    // #2862: dead ref-close units (ref + unterminated close head, mid-text or
    // at EOF). Position matters twice: BEFORE the truncate passes — TRUNC_CLOSE
    // eats the \x3c/name tail first and would leave the bare ref behind (the
    // #2348 v4 shadow) — and AFTER the paired/degen/self/lone-open/lone-close
    // passes: their removals ARE the same-text attestation (an unclosed open or
    // a degen pair count too, not just an already-stripped span), and stripping
    // an open also un-glues a ref that sat right after its \x3e so the [\w>]
    // lookbehind admits it. The gate is `attested || out !== text`: this pass's
    // own earlier-channel removals, plus the input-side evidence computed once
    // on the original text (#4106 — later channels' shapes count too, so the
    // verdict rides the CONTENT, not on what an earlier cleanup already did).
    // A close-only shape with no other echo evidence leaves both terms false
    // and stays content-preserved (#1760); such sightings remain observable via
    // the residue audits.
    if (attested || out !== text) {
        out = out.replace(new RegExp(DEAD_REF_CLOSE.source, "g"), "");
    }
    out = out
        .replace(new RegExp(TRUNC_OPEN.source), "")
        .replace(new RegExp(TRUNC_CLOSE.source), "")
        .replace(new RegExp(TRUNC_REF_CLOSE.source), "")
        .replace(MARKER_LINE, "");
    return stripBiliArtifacts(out);
}

// Cascade cap for the fixed-point walk below: every non-stable pass strictly
// shortens the text, so the walk terminates anyway; the cap bounds adversarial
// cascade depth (cross-stage exposures layered more than this deep keep their
// residue rather than burn CPU on attacker-shaped fields).
const STRIP_PASS_CAP = 8;

/** Whole-text ACP artifact strip. Returns a FIXED POINT whenever the exposure
 *  cascade settles within STRIP_PASS_CAP passes (all attested shapes and every
 *  observed cascade do — one call then does everything repeat calls would,
 *  #4106, so retry/rebuild paths re-normalizing already-cleaned messages ship
 *  stable bytes). Beyond the cap — attacker-shaped fields layering more
 *  cross-stage exposures than this deep — the walk stops and keeps its
 *  residue; a repeated call may peel further (the CPU bound outranks
 *  completeness there, see the STRIP_PASS_CAP note above). */
export function stripAcpTags(text: string, dropToolCallEmission = false, requestText?: string): string {
    const attested = laterChannelAttested(text);
    let out = text;
    for (let i = 0; i < STRIP_PASS_CAP; i++) {
        const next = stripPass(out, dropToolCallEmission, requestText, attested);
        if (next === out) return out;
        out = next;
    }
    return out;
}

/** Whole-text echo normalization for parity judges (the invariant judge,
 * #3938 PR-D): apply the SAME artifact set the outbound stream filters strip,
 * so entry-vs-exit comparisons never false-positive on shapes one side
 * legitimately removed. Single source of truth by construction — when the
 * filter family grows, the judge's normalization grows with it. Content-
 * preserving for prose (paired shapes keep their payload; only tag bytes go),
 * and the tool-call emission span is deliberately NOT touched (args are user
 * intent, #1039). */
export function normalizeEchoArtifacts(text: string): string {
    if (
        !containsRenderTagText(text) &&
        !containsMarkerLineText(text) &&
        !containsBiliInternalText(text)
    ) {
        return text;
    }
    return stripAcpTags(text);
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
// #2348: the self-closing alternatives match through the '/' only — a chunk
// cut right after it is held by PARTIAL_TAIL instead, and over-engaging costs
// one no-op pass while under-engaging forwards the tag raw.
const RENDER_TAG_DETECT = new RegExp("\x3c\\/?" + NAME + "(?=[\\s>])|\\\\u003c\\/?" + NAME + "(?=[\\s>\\\\])|\x3c" + NAME + "\\s*\\/|\\\\u003c" + NAME + "\\s*\\/");
export function containsRenderTagText(s: string): boolean {
    return RENDER_TAG_DETECT.test(s);
}

// #2190: post-audit shape check — a bare ref immediately followed by ANY close
// tag is echo residue by construction (genuine prose never puts mNNNNN right
// before </word>; the kernel wraps refs in tags, so a naked ref IS the leak).
// Used where bytes bypassed or escaped the filter and must be logged, not
// dropped: fast-path gate sites and filter release points.
const ECHO_RESIDUE = /m\d{4,}\s*\x3c\/[a-zA-Z]/;
export function containsEchoResidue(s: string): boolean {
    return ECHO_RESIDUE.test(s);
}

// #468: some upstreams stream a model-imitated render tag in tokenizer-sized
// fragments ("\x3cac", "p tokens", ...) so no single chunk ever trips
// RENDER_TAG_DETECT. Per-chunk gates must also engage when the chunk contains
// or ends with the head of a render tag, so the streaming state machine can
// stitch it back together. Pure-prose chunks still skip the machine
// (byte-identical passthrough); only chunks with a tag-head tail ("\x3c", "\x3c/",
// "\x3ca", "\x3cac", "\x3cacp ...attrs", "\x3c/acp ...") engage it.
export function mayStartRenderTag(s: string): boolean {
    // MANGLED_OPEN carries its own ">" (PARTIAL_TAIL only sees unterminated
    // tails), so it is tested directly: a chunk with a complete mangled open
    // must engage the machine to drop it.
    return RENDER_TAG_DETECT.test(s) || MANGLED_OPEN.test(s) || PARTIAL_TAIL.test(s);
}

// #2190: a BROADER ambiguous head, used by the streaming gate and the filter's
// hold decision only. Degenerate imitations drift the name beyond the acplike
// mutation set (the observed close census already proves free-form name drift),
// so a head like \x3cck must engage the state machine or the rest of the tag
// rides the fast path verbatim. Deliberately NOT folded into PARTIAL_TAIL /
// mayStartRenderTag: isOrphanMarkupText (#1760) consumes those for
// degenerate-turn accounting, where a prose tail such as "a<b" must stay
// prose, not residue.
const BROAD_TAG_HEAD_TAIL = new RegExp("\x3c\\/?[A-Za-z0-9]{0,16}$");
export function mayStartDegenerateRenderTag(s: string): boolean {
    return BROAD_TAG_HEAD_TAIL.test(s);
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

// ─── Whole-field tool-call EMISSION (production 2026-10-03) ────────────────
// The #361 fragments above are tool-call markup QUOTED inside prose —
// legitimate content, detect + warn only. A different shape exists: the
// model writes the whole call as the prose field's body (the "hybrid"
// emission in opencode session ses_efe4cfcbdffe, 2026-10-03:
// \n<parameter=ref>\nm00608\n</parameter>\n<parameter=summary>…prose…\n
// </parameter>\n</function>\n</function_calls> standing alone in the prose
// channel). That field IS the call, not prose quoting a call. Its shape is
// the absorb tool's signature — the only bili tool with a ref+summary
// parameter pair — so a whole-field shape is a tight discriminator: a
// tool-call open at the field start, a ref parameter whose body is a kernel
// ref, a summary parameter, and a call close. Embedded quotes never start
// the field, so they are untouched. Dropping the span is additionally
// gated on provenance (the request carried the [ACP absorb] instruction);
// shape alone never decides.
export const ABSORB_INSTRUCTION_MARKER = "[ACP absorb]";
const TC_OPEN_AT_START = /^\x3c(?:antml:)?(?:function_calls|function|parameter|parameters|invoke|tool_calls|tool_call)\b/;
const TC_PARAM_REF = /\x3c(?:antml:)?parameter(?:\s*=\s*["']?ref["']?|\s+name\s*=\s*["']ref["'])?[^<>]*\x3e\s*m\d{4,}\s*\x3c\/(?:antml:)?parameter/i;
const TC_PARAM_SUMMARY = /\x3c(?:antml:)?parameter(?:\s*=\s*["']?summary["']?|\s+name\s*=\s*["']summary["'])?[^<>]*\x3e/i;
const TC_CLOSE = /\x3c\/(?:antml:)?(?:function_calls|function|parameter|parameters|invoke|tool_calls|tool_call)\b[^<>]*\x3e/i;
const TC_ORPHAN_HEAD = /^\s*\x3c\/(?:antml:)?(?:function_calls|function|parameter|parameters|invoke|tool_calls|tool_call)\b/;
const TC_TAG_STRIP = /\x3c\/?(?:antml:)?(?:function_calls|function|parameter|parameters|invoke|tool_calls|tool_call)\b[^<>]*\x3e/gi;
// Raw-wire whitespace: inside a JSON body, the gap between the markup and
// the ref body arrives as two-char escape pairs (\n \r \t) that \s cannot
// see. Brackets are never JSON-escaped, so a raw presence test is sound.
const RAW_WS = "(?:\\\\[a-z]|\\s|\\\\)*";
const TC_PARAM_REF_RAW = new RegExp(
    "\\x3c(?:antml:)?parameter(?:\\s*=\\s*[\"']?ref[\"']?|\\s+name\\s*=\\s*[\"']ref[\"'])?[^<>]*\\x3e" + RAW_WS + "m\\d{4,}" + RAW_WS + "\\x3c\\/(?:antml:)?parameter",
    "i"
);

/** Span of a whole-field tool-call emission: from the field start (after
 *  leading whitespace) through the last call close. Null when the field is
 *  not shaped as one. Pure shape — the caller gates the drop on
 *  provenance. */
export function toolCallEmissionSpan(text: string): { start: number; end: number } | null {
    const lead = text.length - text.trimStart().length;
    const t = text.slice(lead);
    if (t.length === 0 || !TC_OPEN_AT_START.test(t)) return null;
    if (!TC_PARAM_REF.test(t) || !TC_PARAM_SUMMARY.test(t)) return null;
    let end = -1;
    for (const m of t.matchAll(new RegExp(TC_CLOSE.source, "gi"))) end = m.index + m[0].length;
    if (end === -1) return null;
    return { start: lead, end: lead + end };
}

/** Whole field is a tool-call emission (see above). */
export function isToolCallEmission(text: string): boolean {
    return toolCallEmissionSpan(text) !== null;
}

/** A field that opens on a tool-call CLOSE whose remainder is nothing but
 *  refs and whitespace — the tail half of an emission split across a field
 *  boundary (defensive; no production record yet). */
export function isOrphanToolCallTail(text: string): boolean {
    if (!TC_ORPHAN_HEAD.test(text)) return false;
    return /^\s*(?:m\d{4,}\s*)*$/.test(text.replace(TC_TAG_STRIP, ""));
}

/** Raw-wire pre-check for the emission shape inside an SSE/JSON body (the
 *  gate runs before parsing; the exact field-level decision is
 *  toolCallEmissionSpan on parsed field text). */
export function containsToolCallEmissionText(s: string): boolean {
    return TC_PARAM_REF_RAW.test(s) && TC_PARAM_SUMMARY.test(s) && TC_CLOSE.test(s);
}

// Canonical comparison form for the m00885 echo check. The request side is
// JSON text, where a newline in the user's quote is the two-char escape
// pair `\n` — dropping the backslash alone would leave a stray `n` between
// the markup and the ref body and break containment, so escape pairs are
// resolved first (\uXXXX to the char, \n \t \r and the other pairs to a
// space) and only then do backslashes and whitespace vanish. Both sides
// end up in the same form, so a fragment quoted in the request and
// re-emitted by the model — literal, JSON-escaped, or re-spaced — compares
// equal.
function canonicalEmissionForm(t: string): string {
    return t
        .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\n/g, " ")
        .replace(/\\t/g, " ")
        .replace(/\\r/g, " ")
        .replace(/\\[\"\\/btf]/g, " ")
        .replace(/[\\\s]/g, "");
}

/** m00885: an emission-shaped span is KEPT when it echoes the shipped
 *  request — the user asked the model to output a tool-call-shaped fragment
 *  verbatim as the response, so the fragment is user intent, not a leaked
 *  internal call. The span (markup + ref body + summary + close) must be
 *  contained in the request bytes, whitespace/escape-insensitively; a
 *  model-invented emission (the production shape, where the ref points at a
 *  tool result the user never wrote) cannot match. */
export function emissionEchoesRequest(spanText: string, requestText: string | undefined): boolean {
    if (typeof requestText !== "string" || requestText.length === 0 || spanText.length === 0) return false;
    if (requestText.includes(spanText)) return true;
    const needle = canonicalEmissionForm(spanText);
    if (needle.length === 0) return false;
    return canonicalEmissionForm(requestText).includes(needle);
}

const TC_OPEN_NAMES = ["function_calls", "function", "tool_calls", "tool_call", "parameters", "parameter", "invoke"];

/** Whether an accumulated field head could still be, or already is, the
 *  start of a tool call: "open" when a name head has reached its boundary
 *  (space/=/>), "prefix" while it may still grow into one, "none" when no
 *  name head remains possible. */
export function toolCallOpenStatus(s: string): "none" | "prefix" | "open" {
    let prefix = false;
    for (const name of TC_OPEN_NAMES) {
        for (const head of ["\x3c" + name, "\x3cantml:" + name]) {
            if (s === head) {
                prefix = true;
                continue;
            }
            if (s.startsWith(head)) {
                const nxt = s[head.length];
                if (nxt === undefined) {
                    prefix = true;
                    continue;
                }
                if (nxt === " " || nxt === "\t" || nxt === "\n" || nxt === "\r" || nxt === "=" || nxt === ">") return "open";
            } else if (head.startsWith(s)) {
                prefix = true;
            }
        }
    }
    return prefix ? "prefix" : "none";
}

/** Per-chunk gate: does the chunk contain or end with a tool-call open, so
 *  the streaming machine must engage to decide whether the field is a
 *  whole-field emission? */
export function mayStartToolCallEmission(s: string): boolean {
    for (let i = s.indexOf("\x3c"); i !== -1; i = s.indexOf("\x3c", i + 1)) {
        if (toolCallOpenStatus(s.slice(i)) !== "none") return true;
    }
    return false;
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
function nextChainSpan(s: string): { start: number; end: number } | null {
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
function headBlockCut(s: string): number {
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

// #1760: classify a tail the streaming filters RELEASED at stream end. A
// released tail is content preservation — the filters never drop an undecidable
// prefix — but a tail still shaped like orphan markup (partial render tag,
// literal marker line, truncated internal-artifact open/header) is dead to the
// host like an empty turn, so degenerate-turn detection counts it as residue;
// plain prose (CJK leads included) is visible output, not residue.
// #2023 review: the probe is PARTIAL_TAIL's \x3c -prefixed alternatives ONLY.
// Its refs-run alternatives match genuine citations released at EOF; counting
// those as residue made every bare-citation answer read as degenerate and fire
// the one-shot retry (#732/#821) on a healthy turn. Tagged echoes need no help
// here: their drop already sets sawStrippedEcho upstream.
const TAG_PARTIAL_TAIL = new RegExp("(\x3c" + NAME + "\\s[^<>]*|\x3c\\/" + NAME + "(?:\\s[^<>]{0,32})?|\x3c\\/?[aAcCpPiI]*(?:\/)?)$");
export function isOrphanMarkupText(s: string): boolean {
    return RENDER_TAG_DETECT.test(s) || TAG_PARTIAL_TAIL.test(s) || containsMarkerLineText(s) || mayStartBiliInternal(s);
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
    let dropCount = 0;
    const drop = (snippet: string) => {
        droppedAny = true;
        dropCount++;
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
        stats: () => ({ inputChars, outputChars, dropped: droppedAny, dropCount }),
    };
}

export function createTagEchoFilter(onDrop?: (snippet: string) => void, onResidueWarn?: (snippet: string) => void, absorbInstructed?: boolean, requestText?: string): TagEchoFilter {
    let held = "";
    /** Settled prose deferred alongside a NON-definite tag-head tail: it
     *  carries a dead ref-close unit whose verdict is content-determined
     *  only at the tail's resolution — a resolved tag records a drop (gate
     *  opens, unit stripped) while a prose tail leaves the gate closed
     *  (#1760). Folded back at process() entry so the main loop re-runs
     *  adjudication once the tail resolves (#4107 family, fifth shape). */
    let preHeld = "";
    /** Last character actually emitted ("" at stream start). Extends the
     *  [\w>] orphan-unit lookbehind ACROSS chunk boundaries: a refs run
     *  arriving at the buffer head was preceded by whatever was emitted
     *  before, and a \x3e there marks tag-structure residue (#644). */
    let lastEmitted = "";
    // Whole-field tool-call emission hold: when the request carried the
    // [ACP absorb] instruction, the first non-whitespace head of each field
    // that could be a tool-call open is held until the field is complete, so
    // the emission decision runs on the WHOLE field (a mid-stream shape
    // check could never see the closing tags). "pending" = not yet seen a
    // non-whitespace byte; "committed" = a tool-call open is in the head;
    // "off" = decided not one (or no instruction in the request).
    let tcHold: "off" | "pending" | "committed" = absorbInstructed === true ? "pending" : "off";
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
    /** Whether the current swallow started from a BARE opening (<name>, no
     *  attribute list). Only bare opens may be prose wearing a tag (#1881);
     *  an attrs-bearing open's tail is tag content even when never closed. */
    let swallowBareOpen = false;
    let droppedAny = false;
    let notified = false;
    let inputChars = 0;
    let outputChars = 0;
    let dropCount = 0;
    // #2405(c) review: count LOGICAL ARTIFACTS, not state-machine drop calls.
    // A pair split across pushes drops its opening and its completion as two
    // calls yet is one artifact (SSE deltas split tags arbitrarily, so call
    // counting would double most production tags); a wrapped imitation past
    // the cap drops repeatedly until its close. swallowSessionCounted keeps
    // any one swallow session at exactly one count.
    let swallowSessionCounted = false;
    const recordDrop = (snippet: string) => {
        droppedAny = true;
        if (onDrop && !notified) {
            notified = true;
            onDrop(snippet);
        }
    };
    /** One self-contained artifact resolved by a single drop call. */
    const drop = (snippet: string) => {
        dropCount += 1;
        recordDrop(snippet);
    };
    /** Any drop inside a live swallow session — the session counts once. */
    const dropSwallowSpan = (snippet: string) => {
        if (!swallowSessionCounted) {
            dropCount += 1;
            swallowSessionCounted = true;
        }
        recordDrop(snippet);
    };
    /** #2862: strip dead ref-close units (ref + unterminated close head) from
     *  a span about to be RELEASED as prose; each unit is one self-contained
     *  artifact. Only when a tag-echo is already attested in this response
     *  (droppedAny, or forced by the caller when the attesting match wins in
     *  THIS buffer but has not been recorded yet) — a close-only shape with
     *  no attested echo stays content-preserved (#1760). The head-boundary
     *  check mirrors charBeforeRun: a run at the released span's head that
     *  was preceded by an emitted word char (xm01233 across a chunk boundary)
     *  or \x3e (#644) is not this unit. */
    const stripDeadRefCloses = (s: string, attested = false): string => {
        if ((!attested && !droppedAny) || !s.includes("\x3c/")) return s;
        const re = new RegExp(DEAD_REF_CLOSE.source, "g");
        let out = "";
        let last = 0;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(s)) !== null) {
            if (mm.index === 0 && lastEmitted !== "" && /[\w>]/.test(lastEmitted)) continue;
            out += s.slice(last, mm.index);
            last = mm.index + mm[0].length;
            drop(mm[0]);
        }
        return out + s.slice(last);
    };
    const deadUnitIn = (s: string): boolean => {
        if (!s.includes("\x3c/")) return false;
        const re = new RegExp(DEAD_REF_CLOSE.source, "g");
        return re.exec(s) !== null;
    };
    /** Character immediately before the refs run of an orphan-unit match —
     *  within the buffer, or the last emitted char when the run sits at the
     *  buffer head (chunk boundary). */
    const charBeforeRun = (mm: RegExpExecArray, s: string): string => {
        const lead = mm[0].match(/^\s*/)?.[0].length ?? 0;
        const pos = mm.index + lead;
        return pos === 0 ? lastEmitted : s[pos - 1];
    };
    const process = (input: string): string => {
        // Deferred settled prose re-enters ahead of fresh input so its dead
        // unit takes the verdict of whatever the pending tail resolves to.
        let buf = preHeld + input;
        preHeld = "";
        let out = "";
        for (;;) {
            if (swallowUntilClose) {
                const combined = swallowed + buf;
                // #2190/#4107: a completed degenerate unit at the payload
                // head (single-ref body against any short close) dies
                // atomically in whole-text (DEGEN_PAIR) whatever else follows
                // — including a later acplike close, which would otherwise win
                // the resolution race and release the body as prose with its
                // dead close still inside (#4107 family, seventh shape).
                // Consume such units before the loose-close resolution; the
                // session ends here exactly as on the no-acplike-close path.
                if (swallowReleases) {
                    const dspan = degenCloseAfterRef(combined);
                    if (dspan !== null) {
                        dropSwallowSpan(combined.slice(0, dspan.end));
                        swallowed = "";
                        swallowUntilClose = false;
                        buf = combined.slice(dspan.end);
                        continue;
                    }
                }
                const span = looseCloseSpan(combined);
                // #4163: a NEW opening inside the live bare-open span is the
                // cross-chunk form of the #1720 nesting evidence ("more tag
                // structure follows in this same chunk"): the whole-buffer
                // path would have dropped THIS opening alone and released
                // whatever sat between it and the inner markup as prose.
                // Without the check the inner opening accumulates into
                // `swallowed`, and the close-resolution release branch or the
                // EOF bare-release (#1881) hands it to the client verbatim —
                // same logical output, different persisted bytes per chunking
                // (#3198). Split only when the opening precedes any close
                // terminator: a close first resolves the pair on the existing
                // path and the remainder (opening included) loops normally.
                // Gated to bare-open release sessions: an attrs-bearing tail
                // is tag content end-to-end (#644 EOF rule), and a wrapped
                // turn discards its payload wholesale — neither re-adjudicates
                // its interior.
                if (swallowBareOpen && swallowReleases) {
                    const o = LONE_OPEN.exec(combined);
                    if (o !== null) {
                        const d = degenCloseAfterRef(combined);
                        const term = span !== null ? span.start : d !== null ? d.start : -1;
                        if (term === -1 || o.index < term) {
                            out += stripDeadRefCloses(combined.slice(0, o.index), true);
                            dropSwallowSpan(o[0]);
                            swallowed = "";
                            swallowUntilClose = false;
                            buf = combined.slice(o.index);
                            continue;
                        }
                    }
                }
                if (span !== null) {
                    // Only a refs-only body is tag content (#1720/#2023): a
                    // prose body between paired tags is released and just the
                    // close goes — a ref cited inside such a body survives.
                    // An attested imitation (swallowReleases=false) discards
                    // whatever the body is.
                    const inner = combined.slice(0, span.start);
                    if (REFS_ONLY.test(inner) || !swallowReleases) {
                        dropSwallowSpan(combined.slice(0, span.end));
                        buf = combined.slice(span.end);
                    } else {
                        // #4169: the body is released as prose, but its own
                        // tag-shaped echoes take the SAME verdicts as any other
                        // text — whole-text strips a nested bare open inside an
                        // attrs payload (LONE_OPEN pass), and streaming must
                        // agree on the same bytes. Consume only the close and
                        // splice the body back ahead of the remainder so the
                        // main loop re-adjudicates it. A nested open left
                        // TRUNCATED at the body's end is one broken attrs run
                        // with this close (whole-text wrappedSpan semantics) —
                        // drop both together instead of holding the head past
                        // the close for content that arrived before it.
                        const t = TRUNC_OPEN.exec(inner);
                        if (t !== null) {
                            out += stripDeadRefCloses(inner.slice(0, t.index));
                            dropSwallowSpan(combined.slice(t.index, span.end));
                            buf = combined.slice(span.end);
                        } else {
                            dropSwallowSpan(combined.slice(span.start, span.end));
                            buf = inner + combined.slice(span.end);
                        }
                    }
                    swallowed = "";
                    swallowUntilClose = false;
                    continue;
                }
                if (combined.length > swallowLimit) {
                    if (swallowReleases) {
                        // A span that is refs-shaped so far (a run, optionally
                        // ending on an incomplete ref / dangling joiner) is an
                        // imitated marker list in the making, and its verdict
                        // is content-determined only at resolution — the
                        // close (drop whole, matching the whole-text PAIRED
                        // strip) or the first non-ref char (mixed content,
                        // release). Deciding at the budget boundary instead
                        // flips the verdict with the chunk boundary and leaks
                        // the post-budget remainder as residue (chunk-split
                        // determinism). Bounded by the imitation cap: past it
                        // the span is decisively a marker list — drop and
                        // keep discarding until the close (attested
                        // semantics). Mixed tails keep the #644 release
                        // semantics (existing contract: prose flows, and the
                        // EOF flush of a never-closed attrs-bearing span is
                        // tag content, not prose).
                        if (PENDING_REF_SPAN.test(combined)) {
                            if (combined.length <= IMITATION_SWALLOW_CAP) {
                                swallowed = combined;
                                return out;
                            }
                            swallowed = "";
                            swallowReleases = false;
                            dropSwallowSpan(combined);
                            return out;
                        }
                        swallowed = "";
                        swallowUntilClose = false;
                        buf = combined;
                        if (onResidueWarn && containsEchoResidue(combined)) onResidueWarn(combined);
                        continue;
                    }
                    // The span is an attested imitation's payload: discard it and
                    // keep swallowing, so no part of it reaches the client.
                    swallowed = "";
                    dropSwallowSpan(combined);
                    return out;
                }
                swallowed = combined;
                return out;
            }
            const p = PAIRED.exec(buf);
            // #2348: listed before o — at equal index the complete self-closing
            // unit wins over LONE_OPEN's unclosed-opening interpretation.
            const s = SELF_CLOSE.exec(buf);
            const o = LONE_OPEN.exec(buf);
            const c = LONE_CLOSE.exec(buf);
            // Orphan unit (#2023): only reached when no opening is live — a
            // close inside a swallow belongs to that pair's content (#1720).
            // The lookbehind class extends across the chunk boundary: a run at
            // the buffer head preceded by an emitted word char is word-like
            // (xm01233), and one preceded by \x3e is tag-structure residue
            // (#644) — neither is an orphan. Voiding that HEAD match must not
            // abandon the run: REFS_RUN may start at ANY ref (joiners are not
            // \w), so a valid MID-RUN start (a ref preceded by a joiner) can sit
            // inside the voided span. Re-scan from just past the voided head so
            // that start is found instead of lost — otherwise the drop depends
            // on where the chunk boundary fell (#4179). Any match at index \x3e 0
            // already passes the lookbehind gate by construction, so one re-scan
            // suffices.
            let r = ORPHAN_REF_CLOSE.exec(buf);
            if (r !== null && /[\w>]/.test(charBeforeRun(r, buf))) {
                const rescan = new RegExp(ORPHAN_REF_CLOSE.source, "g");
                rescan.lastIndex = r.index + 1;
                r = rescan.exec(buf);
            }
            // A mangled open (<name=...>) is a complete self-contained tag:
            // drop it in place, no swallow (a following close dies via
            // LONE_CLOSE on its own).
            const g = MANGLED_OPEN.exec(buf);
            let m: RegExpExecArray | null = null;
            for (const cand of [p, s, o, c, r, g]) {
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
                swallowSessionCounted = false;
                recordDrop(broken[0]);
                // The broken open is attested (recorded above) — clean any
                // settled dead unit out of the prose before it, and kill any
                // settle held pending a tail that just completed into it
                // (#4164).
                out += stripDeadRefCloses(buf.slice(0, broken.index));
                buf = buf.slice(broken.index + broken[0].length);
                swallowUntilClose = true;
                swallowLimit = IMITATION_SWALLOW_CAP;
                swallowReleases = false;
                swallowed = "";
                continue;
            }
            if (!m) {
                const t = PARTIAL_TAIL.exec(buf) ?? BROAD_TAG_HEAD_TAIL.exec(buf);
                if (t) {
                    // A definite \x3c<name> opening is never prose — hold it far
                    // past HOLD_LIMIT (drop it past TAG_OPEN_CAP); a short
                    // ambiguous prefix stays on the small hold cap so prose
                    // is never delayed or lost. A refs-run tail (bare run, or
                    // run + open/close head) is tag content in the making
                    // (#2023/#644): it can be arbitrarily long (a 13-ref
                    // citation list), and releasing it at the small cap just
                    // because the chunk boundary landed mid-run leaks the run
                    // as residue (chunk-split determinism) — hold it on the
                    // imitation cap instead.
                    const definite = DEFINITE_TAIL.test(t[0]);
                    const refsShaped = /^\s*m/.test(t[0]);
                    const cap = definite ? TAG_OPEN_CAP : refsShaped ? IMITATION_SWALLOW_CAP : HOLD_LIMIT;
                    // The settled prefix may already hold a dead unit while
                    // only the trailing head stays held — clean it on release.
                    // A definite tail is guaranteed attestation: it always
                    // resolves into a recorded drop (complete tag → match
                    // drop, a second \x3c → broken-attrs drop, EOF →
                    // TRUNC_OPEN/TRUNC_CLOSE flush drop), so force the gate
                    // for the prefix ahead of it — otherwise a unit settling
                    // before the tail survives when the tail's closing \x3e
                    // lands in a later chunk, while whole-text strips it
                    // (#4107 family, third shape).
                    // A NON-definite tail may still resolve either way, so a
                    // unit settled ahead of it cannot be judged yet: defer
                    // the whole prefix with the tail (preHeld) and let the
                    // main loop re-adjudicate at resolution — a resolved
                    // tag records a drop and opens the gate, a prose tail
                    // leaves it closed (#1760) (#4107 family, fifth shape).
                    const rawPre = buf.slice(0, buf.length - t[0].length);
                    if (t[0].length <= cap) {
                        held = t[0];
                        if (definite) {
                            preHeld = "";
                            out += stripDeadRefCloses(rawPre, true);
                        } else {
                            preHeld = deadUnitIn(rawPre) ? rawPre : "";
                            if (preHeld === "") out += rawPre;
                        }
                    } else if (definite) {
                        drop(t[0]);
                        // The dropped tail IS this response's attestation even
                        // though its drop was only just recorded — force the
                        // gate or a settled unit ahead of it leaks raw.
                        preHeld = "";
                        out += stripDeadRefCloses(rawPre, true);
                    } else {
                        // Same release-as-prose semantics as the short path:
                        // a settled dead unit dies when an echo is attested.
                        preHeld = "";
                        out += stripDeadRefCloses(buf);
                    }
                } else {
                    // #2862: release as prose, minus any dead ref-close unit
                    // (an echo is already attested in this response). A still-
                    // held settle resolves to prose here too (#4164) and
                    // precedes this buffer in input order.
                    const rel = stripDeadRefCloses(buf);
                    const resolved = rel;
                    if (onResidueWarn && containsEchoResidue(resolved)) onResidueWarn(resolved);
                    out += resolved;
                }
                break;
            }
            // The winning match itself attests an echo in this response even
            // though its drop has not been recorded yet — force the gate for
            // the prose released ahead of it, and kill any settle held pending
            // the tail that just completed into this tag (#4164).
            out += stripDeadRefCloses(buf.slice(0, m.index), true);
            buf = buf.slice(m.index + m[0].length);
            // A PAIRED match is by definition a complete open+content+close
            // span — only a LONE_OPEN leaves the stream mid-tag and needs to
            // swallow until its close arrives. An attrs-bearing opening always
            // swallows (its attribute list may still be growing). A BARE
            // opening swallows too — its close may arrive in a later chunk
            // (the bare-pair imitation, #1881) — UNLESS more tag structure
            // follows in this same chunk: then the bare open wraps or sits
            // beside inner markup, so drop it alone and let the loop decide
            // the inner structure on its own merits (#1720 nesting).
            // Artifact counting (#2405c review): a session-starting open is
            // recorded without counting here — its artifact completes at the
            // session's first counted span; every other match is self-contained.
            if (m === o) {
                const bare = !OPEN_WITH_ATTRS.test(m[0]);
                if (bare) {
                    // A single-ref body against any short close is a
                    // degenerate pair: whole-text drops the unit WHOLE
                    // (DEGEN_PAIR) whatever else shares the chunk — dropping
                    // only the open here would leave the body's fate to
                    // whether a later open landed in the same buffer
                    // (#4107 family). One logical artifact: the open records,
                    // the body+close counts.
                    const dspan = degenCloseAfterRef(buf);
                    if (dspan !== null) {
                        recordDrop(m[0]);
                        drop(buf.slice(0, dspan.end));
                        buf = buf.slice(dspan.end);
                        continue;
                    }
                }
                if (bare && (PAIRED.exec(buf) !== null || LONE_OPEN.exec(buf) !== null)) {
                    drop(m[0]);
                    continue;
                }
                swallowSessionCounted = false;
                recordDrop(m[0]);
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
                swallowBareOpen = bare;
                swallowed = "";
            } else {
                drop(m[0]);
            }
        }
        return out;
    };
    return {
        push(delta: string): string {
            inputChars += delta.length;
            if (tcHold !== "off") {
                held += delta;
                const t = held.trimStart();
                if (t.length === 0) return "";
                if (t[0] !== "\x3c") tcHold = "off";
                else {
                    const st = toolCallOpenStatus(t);
                    if (st === "open") tcHold = "committed";
                    else if (st === "none") tcHold = "off";
                }
                if (tcHold !== "off") return "";
                // Clear BEFORE processing: process() can stash a partial tag-head
                // tail into the shared held buffer (PARTIAL_TAIL hold); clearing
                // after would wipe it and re-emit the tag head as fresh prose on
                // the next delta (#2267 review fix, mirrors normal-push/flush paths).
                const chunk = held;
                held = "";
                const r = process(chunk);
                outputChars += r.length;
                return r;
            }
            const chunk = held + delta;
            held = "";
            const r = process(chunk);
            if (r.length > 0) lastEmitted = r[r.length - 1];
            outputChars += r.length;
            return r;
        },
        flush(): string {
            let preOut = "";
            if (tcHold !== "off") {
                // The field ended while its head was held: decide the whole
                // field, then hand any non-emission rest to the settle below.
                // No early returns of process() output here: process can leave
                // a partial tail in held or a live swallow session, and
                // returning directly dropped both silently at EOF.
                tcHold = "off";
                const field = held;
                held = "";
                const t = field.trimStart();
                if (t.length > 0 && t[0] === "\x3c") {
                    const span = toolCallEmissionSpan(field);
                    if (span !== null) {
                        if (!emissionEchoesRequest(field.slice(span.start, span.end), requestText)) {
                            drop(field.slice(0, span.end));
                            preOut += process(field.slice(span.end));
                        } else {
                            // The span mirrors the request verbatim (m00885):
                            // the user asked for this fragment as the whole
                            // response — it is user intent, so it flows
                            // through untouched.
                            preOut += process(field);
                        }
                    } else if (isOrphanToolCallTail(field)) {
                        drop(field);
                        return "";
                    } else {
                        preOut += process(field);
                    }
                } else {
                    preOut += process(field);
                }
            }
            // #2862: dead ref-close units die before the truncate branches —
            // TRUNC_CLOSE would otherwise eat the \x3c/name tail at EOF and
            // shadow the unit down to a bare ref (#2348 v4 ordering).
            const rest = stripDeadRefCloses(preHeld + swallowed + held);
            const wasSwallowing = swallowUntilClose;
            preHeld = "";
            swallowed = "";
            held = "";
            swallowUntilClose = false;
            let result: string;
            if (wasSwallowing && (!swallowReleases || !swallowBareOpen)) {
                // Stream ended inside an unclosed render tag: a wrapped-turn
                // imitation (never released, #1720), or an attrs-bearing
                // opening whose tail never closed — that tail is tag content
                // (a ref, possibly truncated), not prose (#644 EOF rule).
                if (rest.length > 0) dropSwallowSpan(rest);
                result = "";
            } else if (wasSwallowing) {
                // A BARE opening (#1881): prose may genuinely wear one, so an
                // over-budget-or-EOF tail is content unless it is refs-only —
                // an imitated marker list (#2023), not a citation; only a
                // truncated open/close tail is dead markup.
                const t = new RegExp(TRUNC_OPEN.source).exec(rest);
                if (t) {
                    dropSwallowSpan(t[0]);
                    result = rest.slice(0, t.index);
                } else {
                    const tc = new RegExp(TRUNC_CLOSE.source).exec(rest);
                    if (tc) {
                        dropSwallowSpan(tc[0]);
                        result = rest.slice(0, tc.index);
                    } else if (REFS_ONLY.test(rest)) {
                        dropSwallowSpan(rest);
                        result = "";
                    } else {
                        // Payload accumulated under the session may carry
                        // COMPLETE structures the main loop never saw (they
                        // arrived in later pushes while the session held) —
                        // whole-text strips them, verbatim release leaked
                        // them raw (#4107 family, sixth shape). Re-run the
                        // main loop over the payload and drain whatever it
                        // defers at true EOF with the same verdicts.
                        let r = "";
                        let payload = rest;
                        let prev = "";
                        for (let guard = 0; ; guard++) {
                            const emitted = process(payload);
                            if (emitted.length > 0) lastEmitted = emitted[emitted.length - 1];
                            r += emitted;
                            payload = preHeld + swallowed + held;
                            preHeld = "";
                            swallowed = "";
                            held = "";
                            swallowUntilClose = false;
                            if (payload === "") break;
                            const t2 = new RegExp(TRUNC_OPEN.source).exec(payload);
                            if (t2 !== null) {
                                dropSwallowSpan(t2[0]);
                                r += payload.slice(0, t2.index);
                                break;
                            }
                            const tc2 = new RegExp(TRUNC_CLOSE.source).exec(payload);
                            if (tc2 !== null) {
                                dropSwallowSpan(tc2[0]);
                                r += payload.slice(0, tc2.index);
                                break;
                            }
                            // Refs-only drop applies to the WHOLE payload only
                            // (an imitated marker list, #2023) — once prose
                            // ahead of a refs tail was emitted, the tail is a
                            // prose-cited ref and must be released (#1760).
                            if (r === "" && REFS_ONLY.test(payload)) {
                                dropSwallowSpan(payload);
                                break;
                            }
                            if (payload === prev || guard >= 64) {
                                // No progress possible (pure partial tail) or
                                // pathological nesting — release what remains.
                                r += payload;
                                break;
                            }
                            prev = payload;
                        }
                        result = r;
                    }
                }
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
            // #2348 v4: same hard-cut tail as the whole-text TRUNC_REF_CLOSE
            // pass, applied to whatever survives the branch above so both
            // modes agree at true EOF.
            const cut = TRUNC_REF_CLOSE.exec(result);
            if (cut !== null) {
                drop(result.slice(cut.index));
                result = result.slice(0, cut.index);
            }
            // #4164: EOF resolves any still-held settle as prose — no tag ever
            // completed to attest it, so the units survive (#1760), in input
            // order ahead of the settled tail. preOut (tcHold path) precedes
            // both.
            result = preOut + result;
            if (result.length > 0) lastEmitted = result[result.length - 1];
            if (result.length > 0 && onResidueWarn && containsEchoResidue(result)) onResidueWarn(result);
            outputChars += result.length;
            return result;
        },
        dropped(): boolean {
            return droppedAny;
        },
        pending(): boolean {
            return held.length > 0 || preHeld.length > 0 || swallowUntilClose;
        },
        stats(): TagEchoFilterStats {
            return { inputChars, outputChars, dropped: droppedAny, dropCount };
        },
    };
}

function stripParts(content: unknown, drop: boolean, requestText?: string): unknown {
    if (!Array.isArray(content)) return content;
    return content.map((part) => {
        if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
            return { ...(part as Record<string, unknown>), text: stripAcpTags((part as Record<string, unknown>).text as string, drop, requestText) };
        }
        return part;
    });
}

function stripItemContent(it: unknown, drop: boolean, requestText?: string): unknown {
    if (!it || typeof it !== "object") return it;
    const io = it as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    const set = (k: string, v: unknown): void => {
        out ??= { ...io };
        out[k] = v;
    };
    if (Array.isArray(io.content)) set("content", stripParts(io.content, drop, requestText));
    // Unified ACP invariant: reasoning summaries are the thinking channel —
    // byte-verbatim, never rewritten (matches stripOpenaiChatText leaving
    // reasoning_content alone and the adapters' identity filters).
    // `content` on a message item is visible prose and stays strippable.
    return out ?? it;
}

function stripIfString(v: unknown, drop: boolean, requestText?: string): unknown {
    return typeof v === "string" ? stripAcpTags(v, drop, requestText) : v;
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
export function stripOpenaiChatText<T>(obj: T, drop: boolean = false, requestText?: string): T {
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
                hh["content"] = stripIfString(hh["content"], drop, requestText);
                // Unified ACP invariant (owner directive, #2229): the
                // thinking/reasoning channel is byte-verbatim — it is the
                // model's private channel, not prose, and reasoning replay
                // (DeepSeek-style) or signature checks can validate it. Only
                // the visible text channel is ever rewritten.
                ch[holder] = hh;
            }
        }
        return ch;
    });
    return obj;
}

// Plugin-passthrough parity for the Anthropic wire: strip `delta.text` on
// content_block_delta streams and `content[].text` on non-streaming message
// bodies. Signed `thinking` / `redacted_thinking` blocks are LEFT byte-for-byte
// (#1960/KDD#10): they are verified against their signature on replay, so any
// rewrite desyncs them and bricks the session — matching the loop adapters'
// "prose filters never touch thinking" treatment. Mutates in place.
export function stripAnthropicText<T>(obj: T, drop: boolean = false, requestText?: string): T {
    if (!obj || typeof obj !== "object") return obj;
    const o = obj as Record<string, unknown>;
    const d = o["delta"];
    if (d && typeof d === "object") {
        const dd = { ...(d as Record<string, unknown>) };
        dd["text"] = stripIfString(dd["text"], drop, requestText);
        o["delta"] = dd;
    }
    if (Array.isArray(o["content"])) {
        o["content"] = (o["content"] as unknown[]).map((c) => {
            if (!c || typeof c !== "object") return c;
            const cc = c as Record<string, unknown>;
            if (typeof cc["text"] !== "string") return c;
            return { ...cc, text: stripIfString(cc["text"], drop, requestText) };
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
export function stripResponsesText<T>(obj: T, drop: boolean = false, requestText?: string): T {
    if (!obj || typeof obj !== "object") return obj;
    const o = obj as Record<string, unknown>;
    if (typeof o.text === "string") o.text = stripAcpTags(o.text, drop, requestText);
    if (o.part && typeof o.part === "object" && typeof (o.part as Record<string, unknown>).text === "string") {
        o.part = { ...(o.part as Record<string, unknown>), text: stripAcpTags((o.part as Record<string, unknown>).text as string, drop, requestText) };
    }
    if (o.item && typeof o.item === "object") {
        o.item = stripItemContent(o.item, drop, requestText);
    }
    if (o.response && typeof o.response === "object") {
        const resp = { ...(o.response as Record<string, unknown>) };
        if (Array.isArray(resp.output)) {
            resp.output = (resp.output as unknown[]).map((it) => stripItemContent(it, drop, requestText));
        }
        o.response = resp;
    }
    if (Array.isArray(o.output)) {
        o.output = (o.output as unknown[]).map((it) => stripItemContent(it, drop, requestText));
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
    let dropCount = 0;

    const noteDrop = (snippet: string) => {
        droppedAny = true;
        dropCount++;
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
        stats: () => ({ inputChars, outputChars, dropped: droppedAny, dropCount }),
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
            dropCount: a.stats().dropCount + b.stats().dropCount,
        }),
    };
}

// #1960/KDD#10 — signature-verified channels (signed Anthropic `thinking`
// deltas, Gemini `thought` parts) must ride byte-for-byte: any rewrite
// desyncs them from their signature and bricks replay. This identity filter
// passes every delta through unchanged while keeping honest char accounting,
// so degenerate-turn detection (#673) still sees real input/output sizes.
export function createIdentityStreamFilter(): TagEchoFilter {
    let inputChars = 0;
    let outputChars = 0;
    return {
        push: (delta: string) => {
            inputChars += delta.length;
            outputChars += delta.length;
            return delta;
        },
        flush: () => "",
        dropped: () => false,
        pending: () => false,
        stats: () => ({ inputChars, outputChars, dropped: false, dropCount: 0 }),
    };
}
