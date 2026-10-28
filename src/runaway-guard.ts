import { ACP_NAME_ALT } from "./loop/tag-echo-filter.js";
import { DEFAULT_TEXT_RUN_THRESHOLD, guardrailTextRunThreshold } from "./knobs.js";

// Runaway-enumeration intrinsic termination (#2346). One assistant message can
// degenerate into hundreds of echoed markers (render tags / tool-call XML) with no
// semantic stop, running to the output limit or a manual cutoff (instance A: 265 acp
// tags m02040..m02304; instance B: ~8.7k antml fragments). This gives the stream an
// INTRINSIC scale-based terminator. Scale, never shape/malformed-tag: legit turns top
// out at ~11 tags, and turns with a few DEGENERATE tags still complete normally — those
// must never be co-blocked. Ref-validity is NOT a signal (instance A's refs were all
// valid) and frame-kind counting is not used (it misfires on tool turns). INVARIANT
// (#1039): counts RAW bytes only, never rewrites/drops/reorders a forwarded byte, sends
// no corrective re-request nudge; on trip the caller aborts the upstream, which also
// sets the loop signal and so suppresses the one-shot retries (all gated on !aborted).
//
// Third lane (#3260): single-codepoint repetition in the decoded MODEL TEXT — port of
// pi's findDegenerateRuns minRun semantics (production-tuned in billion-context-pi):
// a model stuck in a symbol loop (#3946: one symbol string for ~22 minutes) runs ONE
// codepoint >= 200 times. Detection runs on DECODED text payloads only (per-frame JSON,
// text-family keys), never on raw wire bytes: a low-entropy base64 blob or a
// tool-argument payload of 300 '=' must not read as a text run (#1039). Scale, never
// shape: legit prose/code tops out far below 200 consecutive identical codepoints.
// Every frame is parsed — there is deliberately NO raw pre-gate: token-granular
// streaming interleaves framing bytes between identical characters, so a raw
// run-length arm would stay blind to the exact incident shape (#3946). A
// structure-only frame costs a parse plus a short walk; nothing it carries enters
// the run tracker.

export interface RunawayVerdict {
    tripped: boolean;
    reason?: "acp-enumeration" | "tool-xml-flood" | "text-run";
    detail?: {
        acpTags: number;
        toolXmlFragments: number;
        toolXmlGapBytes: number;
        maxMonotonicRefRun: number;
        zeroTokenFraction: number;
        maxTextRun: number;
        textRunChar?: string;
        /** #5036: the threshold this guard instance actually enforced — lets the trip log name the effective knob value. */
        textRunThreshold?: number;
    };
}

interface RunawayGuard {
    /** Feed one chunk of RAW wire text (utf8-decoded SSE/JSON body). Stateful across chunk boundaries. */
    feed(chunkText: string): RunawayVerdict;
    /** Count chunk bytes toward the tool-xml gap average WITHOUT scanning (the
     *  no-angle-bracket fast path): skipping them would under-count gaps and
     *  bias the corroborator toward false trips on legit turns whose prose and
     *  fragments alternate across chunks (#2451 review). */
    feedGapOnly(chunkText: string): void;
    /** Feed decoded model TEXT (assistant text/thinking deltas ONLY — never tool-call
     *  arguments): stateful single-codepoint run tracking across calls (#3260). */
    feedText(text: string): RunawayVerdict;
}

// Scale thresholds sit far above any legitimate single-message maximum.
export const ACP_TAG_THRESHOLD = 50; // legit single-msg ceiling observed: 11
const MONO_REF_RUN_THRESHOLD = 50; // corroborator: consecutive +1 kernel refs
const ZERO_TOKEN_FRACTION = 0.9; // corroborator: >=90% of counted tags carry tokens="0"
export const TOOL_XML_THRESHOLD = 300; // legit multi-tool turns << this; runaway B ~= 8700
// #2451 review: corroborator for the tool-xml lane (the acp lane always had two):
// raw count alone must not abort a turn whose parameter payload legitimately
// CONTAINS tool-shape XML (transcript exports, protocol docs, test fixtures —
// #1039: tool args are user intent). A flood skeleton interleaves almost no
// non-fragment bytes per fragment (incident B ≈ 10–20 B/fragment, values are
// empty or single-token); real content spaces fragments with the payload.
// Trip requires count ≥ threshold AND average inter-fragment gap ≤ this floor.
const TOOL_XML_GAP_AVG_BYTES = 64;
// #3260: single-codepoint repetition lane. Parity with pi's findDegenerateRuns minRun
// (200) — the value billion-context-pi runs in production; legit text never carries
// 200 identical codepoints in a row, a symbol-loop model does (#3946). The default
// stayed internal through #3260; #3406 item 1 (from the #3331 review) added the
// guardrails.textRunThreshold knob — BILI_GUARDRAIL_TEXT_RUN_THRESHOLD > config file
// > this default, 0 disables the lane — so users whose models legitimately emit long
// same-char runs (code comment separators, ASCII rules) have an escape hatch. The
// EFFECTIVE threshold resolves per guard at creation; the exported constant is the
// documented default (kept stable for the tests that pin default behavior).
export const TEXT_RUN_THRESHOLD = DEFAULT_TEXT_RUN_THRESHOLD;
// Size at which the NDJSON fallback engages: a real SSE body separates every frame
// with a blank line long before this, so a buffer this large holding no blank line
// is not SSE-shaped.
const NDJSON_FALLBACK_MIN = 64 * 1024;
// Absolute cap on an unprocessed stream tail: beyond it the body is neither SSE nor
// NDJSON-shaped; drop rather than accumulate forever.
const FRAME_BUF_CAP = 8 * 1024 * 1024;

// Bounded carry-over so a marker split across two chunks is still seen whole. Longer
// than any single runaway marker (short tags with short attrs); a pathological long
// attr-run simply under-counts (fail-safe direction — it is not a runaway shape).
const TAIL_CAP = 256;

// A render-tag OPENING (<name …attrs…> or bare <name>). Reuses the SAME name mutation
// set the stripper uses (ACP_NAME_ALT) so the counter counts exactly what the system
// treats as a render tag. The attrs are the single capturing group (m[1]).
const ACP_OPEN_RE = new RegExp("\x3c" + ACP_NAME_ALT + "((?:\\s[^<>]*)?)>", "g");
// Tool-call XML template fragments (instance B carrier): any open/close invoke /
// parameter / function[_calls] / tool_call(s), antml-namespaced or not.
const TOOL_XML_RE = new RegExp("\\x3c\\/?(?:antml:)?(invoke|tool_calls|tool_call|parameter|parameters|function_calls|function)\\b", "gi");
const REF_RE = /m(\d{4,})/;
const TOKENS_ATTR_RE = /tokens\s*=\s*"(\d+)"/i;

// --- #3260 text-run lane: decoded-frame parsing (see header) ---
// SSE event separator (blank line), CRLF-tolerant.
const FRAME_SEP_RE = /\r?\n\r?\n/g;
const HAS_FRAME_SEP_RE = /\r?\n\r?\n/;
// Responses-wire cumulative SNAPSHOT events: .done / .completed / .incomplete re-send
// the FULL payload of a finished part. Feeding them on top of the deltas would
// double-count the run (a 150-run delivered as deltas, then re-sent in .completed,
// would read as 300). Deltas are the live generation; snapshots are not.
const SNAPSHOT_TYPE_RE = /\.(?:completed|incomplete|done)$/;
// Text-family LEAF keys: model-visible output text on every wire bili speaks (openai
// chat delta.content / delta.reasoning_content, anthropic delta.text_delta.text /
// thinking_delta.thinking, responses top-level "delta", google parts[].text).
// Everything else (ids, urls, roles, usage…) is structure, never output.
const TEXT_LEAF_KEYS: ReadonlySet<string> = new Set([
    "content", "text", "thinking", "reasoning", "reasoning_content", "delta",
]);
// Branches whose strings are NEVER model output. Tool-call arguments are user intent
// (#1039): a write-tool payload of 300 '=' must not abort the turn. `args` /
// `functionCall` cover the Google wire, where a tool call rides
// candidates[].content.parts[].functionCall.args and its payload fields are often
// named `content` — a TEXT_LEAF_KEYS name, so without the branch exclusion the
// argument bytes would be fed to the text-run lane (the openai `arguments` /
// responses `partial_json` keys were already excluded; Google events carry no
// top-level `type`, so the snapshot/function_call frame gate can't catch them).
const EXCLUDED_BRANCHES: ReadonlySet<string> = new Set([
    "arguments", "input", "partial_json", "tool_calls", "tools", "functions", "system",
    "instructions", "metadata", "usage", "usageMetadata", "logprobs", "annotations",
    "error", "id", "url", "args", "functionCall", "parameters",
]);

export function createRunawayGuard(): RunawayGuard {
    // #3406: resolve the text-run threshold ONCE per guard — a stream keeps the
    // threshold it started with even if the knob flips mid-flight. 0 = lane off.
    const textRunThreshold = guardrailTextRunThreshold();
    let pending = "";
    let acpTags = 0;
    let toolXml = 0;
    // Bytes fed but not consumed by a tool-xml match. Fed bytes count as gap the
    // feed they arrive in; a match completing over pending-carry bytes subtracts
    // exactly its full length (those bytes were counted once when originally
    // fed). Bytes dropped past TAIL_CAP stay counted — over-counting gaps is the
    // fail-safe direction (a miss, never a false corroboration). Render-tag
    // bytes are deliberately NOT subtracted: mixing lanes only inflates the gap
    // average, and the acp lane has its own corroborators.
    let toolGapBytes = 0;
    let zeroTokens = 0;
    let lastRef: number | null = null;
    let monoRun = 0;
    let maxMonoRun = 0;
    let tripped = false;
    // #3260 text-run lane state.
    let lastCp: string | null = null;
    let textRun = 0;
    let maxTextRun = 0;
    let textRunChar: string | undefined;

    const detail = (): NonNullable<RunawayVerdict["detail"]> => {
        const d: NonNullable<RunawayVerdict["detail"]> = {
            acpTags,
            toolXmlFragments: toolXml,
            toolXmlGapBytes: toolGapBytes,
            maxMonotonicRefRun: maxMonoRun,
            zeroTokenFraction: acpTags > 0 ? zeroTokens / acpTags : 0,
            maxTextRun,
            textRunThreshold,
        };
        if (textRunChar !== undefined) d.textRunChar = textRunChar;
        return d;
    };

    const feed = (chunkText: string): RunawayVerdict => {
        if (tripped) return { tripped: true, reason: undefined, detail: detail() };
        if (chunkText.length === 0) return { tripped: false };
        const scan = pending + chunkText;
        toolGapBytes += chunkText.length;
        let lastEnd = 0;

        ACP_OPEN_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = ACP_OPEN_RE.exec(scan)) !== null) {
            acpTags += 1;
            const end = m.index + m[0].length;
            if (end > lastEnd) lastEnd = end;
            const tm = TOKENS_ATTR_RE.exec(m[1] ?? "");
            if (tm && tm[1] === "0") zeroTokens += 1;
            // The kernel ref sits immediately after the opening (<…>mNNNNN</…>); read a
            // short window past the ">". A ref split at a chunk boundary is missed (its
            // open tag already left pending) — that only ever SHORTENS a monotonic run,
            // i.e. fail-safe direction: a miss, never a false corroboration.
            const rm = REF_RE.exec(scan.slice(end, end + 48));
            if (rm) {
                const n = Number.parseInt(rm[1], 10);
                monoRun = lastRef !== null && n === lastRef + 1 ? monoRun + 1 : 1;
                lastRef = n;
                if (monoRun > maxMonoRun) maxMonoRun = monoRun;
            }
        }

        TOOL_XML_RE.lastIndex = 0;
        while ((m = TOOL_XML_RE.exec(scan)) !== null) {
            toolXml += 1;
            toolGapBytes -= m[0].length;
            const end = m.index + m[0].length;
            if (end > lastEnd) lastEnd = end;
        }

        // Retain only the unconsumed tail (past the last full match) so nothing already
        // counted is re-scanned next chunk, yet a partial head still completes across the
        // boundary. Pure-prose chunks (no "<") skip feed() upstream, leaving pending intact.
        pending = scan.slice(lastEnd);
        if (pending.length > TAIL_CAP) pending = pending.slice(-TAIL_CAP);

        const zeroFraction = acpTags > 0 ? zeroTokens / acpTags : 0;
        if (acpTags >= ACP_TAG_THRESHOLD && (maxMonoRun >= MONO_REF_RUN_THRESHOLD || zeroFraction >= ZERO_TOKEN_FRACTION)) {
            tripped = true;
            return { tripped: true, reason: "acp-enumeration", detail: detail() };
        }
        if (toolXml >= TOOL_XML_THRESHOLD && toolGapBytes / toolXml <= TOOL_XML_GAP_AVG_BYTES) {
            tripped = true;
            return { tripped: true, reason: "tool-xml-flood", detail: detail() };
        }
        // Always expose the running counts (even below threshold) so callers can log
        // near-misses and the thresholds stay tunable against live traffic (#2346/#2347).
        return { tripped: false, detail: detail() };
    };

    // #3260: stateful single-codepoint run over decoded model text. `for..of` iterates by
    // CODE POINT, so an astral character (emoji) counts as one unit, not two surrogates.
    const feedText = (text: string): RunawayVerdict => {
        if (tripped) return { tripped: true, reason: undefined, detail: detail() };
        if (text.length === 0 || textRunThreshold <= 0) return { tripped: false };
        for (const cp of text) {
            if (cp === lastCp) {
                textRun += 1;
                if (textRun > maxTextRun) {
                    maxTextRun = textRun;
                    textRunChar = cp;
                }
            } else {
                lastCp = cp;
                textRun = 1;
            }
            if (textRun >= textRunThreshold) {
                tripped = true;
                return { tripped: true, reason: "text-run", detail: detail() };
            }
        }
        return { tripped: false, detail: detail() };
    };

    const feedGapOnly = (chunkText: string): void => {
        toolGapBytes += chunkText.length;
    };

    return { feed, feedGapOnly, feedText };
}

/** #5036: operator-facing remediation appended to a text-run trip log — names the escape-hatch
 *  knob + env override + the value this guard actually enforced, so a Gemini-family long-newline
 *  turn cut mid-stream tells the operator exactly which setting to raise (0 disables the lane).
 *  Returns "" for every other lane — they have no user-facing knob. */
export function textRunTripHint(v: RunawayVerdict): string {
    if (v.reason !== "text-run") return "";
    const eff = v.detail?.textRunThreshold;
    const effTxt = eff !== undefined ? String(eff) : "?";
    return ` [legit long same-char output? raise guardrails.textRunThreshold / BILI_GUARDRAIL_TEXT_RUN_THRESHOLD above ${effTxt} (0 disables this lane)]`;
}

/** Tee a raw response stream through a runaway guard. Bytes are forwarded BYTE-EXACT;
 *  on trip it fires onTrip (caller aborts the upstream), closes the downstream cleanly
 *  (EOF, not an error), and releases the source reader. */
export function wrapStreamWithRunawayGuard<T extends Uint8Array>(
    source: ReadableStream<T>,
    onTrip: (verdict: RunawayVerdict) => void,
): ReadableStream<T> {
    const guard = createRunawayGuard();
    const reader = source.getReader();
    const decoder = new TextDecoder();
    let settled = false;

    // #3260 text-run lane state.
    let frameBuf = ""; // unprocessed tail: complete frames + at most one partial frame
    let walkTripped = false;
    let tripVerdict: RunawayVerdict | null = null;

    // Recursive walker over a parsed frame: feeds ONLY text-family leaves that sit
    // outside excluded branches into the guard's run tracker.
    const collectText = (node: unknown, key: string, excluded: boolean): void => {
        if (walkTripped) return;
        if (typeof node === "string") {
            if (!excluded && TEXT_LEAF_KEYS.has(key)) {
                const v = guard.feedText(node);
                if (v.tripped) {
                    walkTripped = true;
                    tripVerdict = v;
                }
            }
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) {
                collectText(item, key, excluded);
                if (walkTripped) return;
            }
            return;
        }
        if (typeof node === "object" && node !== null) {
            const ex = excluded || EXCLUDED_BRANCHES.has(key);
            for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
                collectText(v, k, ex);
                if (walkTripped) return;
            }
        }
    };

    const processParsed = (obj: unknown): void => {
        if (typeof obj !== "object" || obj === null) return;
        const t = (obj as Record<string, unknown>)["type"];
        if (typeof t === "string") {
            if (SNAPSHOT_TYPE_RE.test(t)) return; // cumulative snapshot: deltas already counted it
            if (t.includes("function_call") || t.includes("custom_tool_call")) return; // argument bytes (#1039)
        }
        walkTripped = false;
        tripVerdict = null;
        collectText(obj, "", false);
    };

    const processSseFrame = (frame: string): void => {
        let data: string | null = null;
        for (const lineRaw of frame.split("\n")) {
            const line = lineRaw.endsWith("\r") ? lineRaw.slice(0, -1) : lineRaw;
            if (!line.startsWith("data:")) continue;
            const v = line.charAt(5) === " " ? line.slice(6) : line.slice(5);
            data = data === null ? v : `${data}\n${v}`;
        }
        if (data === null || data === "[DONE]") return;
        let obj: unknown;
        try {
            obj = JSON.parse(data);
        } catch {
            return; // comment/event/id-only frame or non-JSON payload — nothing to count
        }
        processParsed(obj);
    };

    const pumpFrames = (): void => {
        // NDJSON fallback: some OpenAI-compatible servers separate events with bare
        // newlines and never emit a blank line. Engages only once the buffer is large
        // enough that standard SSE framing is clearly absent (a real SSE body separates
        // every frame long before NDJSON_FALLBACK_MIN).
        if (frameBuf.length >= NDJSON_FALLBACK_MIN && frameBuf.includes("\n") && !HAS_FRAME_SEP_RE.test(frameBuf)) {
            const lines = frameBuf.split("\n");
            frameBuf = "";
            for (const lineRaw of lines) {
                const line = lineRaw.endsWith("\r") ? lineRaw.slice(0, -1) : lineRaw;
                if (line.length === 0 || (line.charAt(0) !== "{" && line.charAt(0) !== "[")) continue;
                let obj: unknown;
                try {
                    obj = JSON.parse(line);
                } catch {
                    continue;
                }
                processParsed(obj);
                if (walkTripped) return;
            }
            return;
        }
        if (frameBuf.length > FRAME_BUF_CAP) {
            frameBuf = "";
            return;
        }
        FRAME_SEP_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = FRAME_SEP_RE.exec(frameBuf)) !== null) {
            const frame = frameBuf.slice(0, m.index);
            frameBuf = frameBuf.slice(m.index + m[0].length);
            processSseFrame(frame);
            if (walkTripped) return;
            if (frameBuf.length > FRAME_BUF_CAP) {
                frameBuf = "";
                return;
            }
        }
    };

    const trip = (controller: ReadableStreamDefaultController<T>): void => {
        settled = true;
        onTrip(tripVerdict ?? { tripped: true });
        controller.close();
        reader.cancel().catch(() => {});
    };

    return new ReadableStream<T>({
        async pull(controller) {
            if (settled) return;
            const r = await reader.read();
            if (r.done) {
                settled = true;
                controller.close();
                return;
            }
            const value = r.value;
            // Cheap pre-gate: a chunk with no angle bracket cannot start a marker, so it
            // needs no regex pass (pending stays intact for a later completing chunk) —
            // but its bytes still count toward the tool-xml gap average (#2451 review:
            // skipping them would under-count gaps on prose/fragment-alternating turns
            // and bias the corroborator toward false trips).
            const text = decoder.decode(value, { stream: true });
            if (text.length > 0) {
                if (text.includes("\x3c")) {
                    const v = guard.feed(text);
                    if (v.tripped) {
                        tripVerdict = v;
                        trip(controller);
                        return;
                    }
                } else {
                    guard.feedGapOnly(text);
                }
                // #3260 text-run lane: assemble frames and feed decoded text leaves to
                // the run tracker (see header for why every frame is parsed).
                frameBuf += text;
                pumpFrames();
                if (walkTripped) {
                    trip(controller);
                    return;
                }
            }
            controller.enqueue(value);
        },
        cancel(reason) {
            settled = true;
            reader.cancel(reason).catch(() => {});
        },
    });
}
