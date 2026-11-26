import type { CoreMessage } from "acp-kernel";
import { coreToGoogle } from "acp-kernel/wire";
import type { GooglePart } from "acp-kernel/wire";
import { buildVisibilityMarker } from "./core.js";
import { ACP_NAME_ALT, composeStreamFilters, createBiliArtifactFilter, createMarkerLineFilter, createTagEchoFilter } from "./tag-echo-filter.js";
import { degenerateTurnWarning } from "../degenerate-turn.js";
import { log as loggerLog } from "../logger.js";
import { createSseFramer, sseEventData } from "../sse-util.js";

import type {
    CompressLoopAdapter,
    EmitCompletionOpts,
    ParsedStreamEvent,
    ToolCallEmit,
} from "./core.js";

const PROXY_TOOL_SET = new Set([
    "compress", "decompress", "search_context", "acp_status",
    // #5765: function-only tools added after the original four must be listed
    // here or their chunks raw-replay to the client as "real" calls. acp_cache
    // had the same gap before this change.
    "acp_retire", "acp_restore", "acp_rewrite", "acp_cache",
    "acp_rule", "acp_read_original_image",
    "bili_compress", "bili_decompress", "bili_search_context", "bili_status",
]);

// Gemini's own finish vocabulary. The loop hands emitCompletion whatever the
// round's `done` event carried, which may be another wire's word ("length"
// from a proxy-side truncation, "tool_calls" from the openai adapter) — every
// value must land on a real Gemini reason because the client THROWS on a
// stream that ends without one.
const GOOGLE_FINISH_REASONS: Record<string, true> = {
    STOP: true,
    MAX_TOKENS: true,
    SAFETY: true,
    RECITATION: true,
    OTHER: true,
    BLOCKLIST: true,
    PROHIBITED_CONTENT: true,
    SPII: true,
    MALFORMED_FUNCTION_CALL: true,
    IMAGE_SAFETY: true,
    LANGUAGE: true,
    FINISH_REASON_UNSPECIFIED: true,
};

function googleFinishReason(reason: string | undefined): string {
    if (!reason) return "STOP";
    const upper = reason.toUpperCase();
    if (GOOGLE_FINISH_REASONS[upper] === true) return upper;
    if (upper === "LENGTH") return "MAX_TOKENS";
    if (upper === "END_TURN" || upper === "TOOL_CALLS" || upper === "TOOL_USE" || upper === "COMPLETED" || upper === "STOP_SEQUENCE") return "STOP";
    return "OTHER";
}

function readUsageMetadata(usage: Record<string, unknown>): {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
} {
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const candidates = num(usage.candidatesTokenCount);
    const thoughts = num(usage.thoughtsTokenCount);
    return {
        inputTokens: num(usage.promptTokenCount),
        cachedTokens: num(usage.cachedContentTokenCount),
        // Thinking tokens are billed as output; the client's own accounting
        // reads a single output number, so they are folded in here.
        outputTokens: candidates === undefined && thoughts === undefined ? undefined : (candidates ?? 0) + (thoughts ?? 0),
    };
}

function sseFrame(parsed: Record<string, unknown>): Buffer {
    return Buffer.from(`data: ${JSON.stringify(parsed)}\n\n`, "utf8");
}

// One chunk is edited in place — its parts replaced, and/or an early
// finishReason dropped. A forwarded chunk must never carry a finishReason
// unless it IS the round's completion: the loop may run another upstream round
// after this one (core.ts reRequest), and a leaked early finish makes every
// later token "content after the finish reason" to the client.
function cloneChunk(
    parsed: Record<string, unknown>,
    edit: { parts?: GooglePart[]; dropFinishReason?: boolean },
): Record<string, unknown> {
    const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
    if (!candidates || candidates.length === 0) return parsed;
    const candidate = { ...candidates[0] };
    if (edit.dropFinishReason) delete candidate.finishReason;
    if (edit.parts) {
        candidate.content = { role: "model", ...(candidate.content as Record<string, unknown> | undefined), parts: edit.parts };
    }
    return { ...parsed, candidates: [candidate, ...candidates.slice(1)] };
}

interface FunctionCallBuffer {
    index: number;
    id: string;
    name: string;
    args: string;
    signature: string;
}

// A decision per buffered chunk that carried functionCall parts: "keep" = every
// call in it is real and needs no signature promotion (replay verbatim,
// preserving signatures/ids/order), null = only proxy calls (drop — the proxy
// executes them server-side), or a rewritten copy keeping the chunk's other
// parts plus its real calls (promoting a stripped proxy call's thoughtSignature
// onto the first surviving real functionCall part when Gemini placed the turn
// signature on the leading proxy call).
function filterRealCallChunk(
    parsed: Record<string, unknown>,
    realIndexes: Set<number>,
    callIndexes: number[],
    promoteSig?: { callIndex: number; signature: string },
): "keep" | null | Record<string, unknown> {
    const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
    const parts = (candidates?.[0]?.content as { parts?: GooglePart[] } | undefined)?.parts;
    if (!Array.isArray(parts)) return "keep";
    let anyReal = false;
    let anyProxy = false;
    let sigPromoted = false;
    const outParts: GooglePart[] = [];
    let call = 0;
    for (const part of parts) {
        if (part && typeof part === "object" && part.functionCall) {
            const callIdx = callIndexes[call] ?? -1;
            const real = realIndexes.has(callIdx);
            call += 1;
            if (real) {
                anyReal = true;
                if (
                    promoteSig &&
                    callIdx === promoteSig.callIndex &&
                    (typeof part.thoughtSignature !== "string" || part.thoughtSignature.length === 0)
                ) {
                    outParts.push({ ...part, thoughtSignature: promoteSig.signature });
                    sigPromoted = true;
                } else {
                    outParts.push(part);
                }
            } else {
                anyProxy = true;
            }
        } else {
            outParts.push(part);
        }
    }
    if (!anyProxy && !sigPromoted) return "keep";
    if (!anyReal) return null;
    return cloneChunk(parsed, { parts: outParts });
}

function dataLine(frame: string): string | null {
    return sseEventData(frame)?.trim() ?? null;
}

interface GoogleChunk {
    /** The chunk's own SSE text, or a synthesized one in JSON-array mode. */
    frame: string;
    json: string;
}

// Gemini streams either as SSE (`?alt=sse`, what the real client asks for) or,
// without that query parameter, as one JSON array whose elements are the same
// chunk objects. Both forms are read here: the first non-whitespace byte of the
// body decides which, and array elements are emitted as they complete so text
// still reaches the client incrementally.
async function* iterGoogleChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<GoogleChunk> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const framer = createSseFramer();
    let buf = "";
    let mode: "unknown" | "sse" | "array" = "unknown";
    let cursor = 0;
    let started = false;
    let elementStart = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let arrayDone = false;
    try {
        while (true) {
            let done: boolean;
            let value: Uint8Array | undefined;
            try {
                ({ done, value } = await reader.read());
            } catch {
                break;
            }
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            if (mode === "unknown") {
                const lead = buf.replace(/^[\uFEFF\s]+/, "");
                if (lead.length === 0) continue;
                if (lead.startsWith("[")) {
                    mode = "array";
                    cursor = buf.indexOf("[") + 1;
                } else {
                    mode = "sse";
                }
            }
            if (mode === "sse") {
                for (const raw of framer.push(buf)) {
                    const json = dataLine(raw);
                    if (json !== null) yield { frame: raw, json };
                }
                buf = "";
                continue;
            }
            for (; cursor < buf.length && !arrayDone; cursor++) {
                const ch = buf[cursor];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (ch === "\\") escaped = true;
                    else if (ch === '"') inString = false;
                    continue;
                }
                if (!started) {
                    if (ch === "," || /\s/.test(ch)) continue;
                    if (ch === "]") {
                        arrayDone = true;
                        break;
                    }
                    started = true;
                    elementStart = cursor;
                }
                if (ch === '"') inString = true;
                else if (ch === "{" || ch === "[") depth += 1;
                else if (ch === "}" || ch === "]") {
                    depth -= 1;
                    if (depth === 0) {
                        const json = buf.slice(elementStart, cursor + 1);
                        started = false;
                        elementStart = -1;
                        yield { frame: `data: ${json.replace(/\r\n|\r|\n/g, "\ndata: ")}`, json };
                    }
                }
            }
            // Keep only the unfinished element across reads. Retaining completed
            // prefixes can repeatedly copy the history during concatenation/indexing.
            if (arrayDone) {
                buf = "";
                cursor = 0;
            } else {
                const consumed = started ? elementStart : cursor;
                if (consumed > 0) {
                    buf = buf.slice(consumed);
                    cursor -= consumed;
                    if (started) elementStart = 0;
                }
            }
        }
        if (mode === "sse") {
            for (const raw of framer.finish()) {
                const json = dataLine(raw);
                if (json !== null) yield { frame: raw, json };
            }
        }
    } finally {
        reader.releaseLock();
    }
}

// ─── #7416: hallucinated turn-bleed circuit breaker ────────────────────────
// Long Google sessions condition the model on the per-message render tags, so
// it occasionally misses its native turn stop and emits plain-text "\nuser\n"
// followed by a second synthetic render tag and a hallucinated user-turn
// envelope, then continues into a hallucinated next assistant turn that emits
// real functionCall parts in the same response. The tag-echo filter strips the
// echoed tags but cannot see the turn boundary: the fake user prose and the
// post-bleed calls would both pass through, and the loop would execute the
// calls as unauthorized tool calls. This breaker watches the VISIBLE text
// channel only (part.thought !== true, unsigned parts — the same channel the
// tag-echo filter owns; signed text is signature-bound per KDD #10 and is
// never truncated, only fence-synced). Outside fenced code blocks, a "user"
// line followed by a render tag or a client user-turn envelope ends the
// assistant turn: everything from the "\n" before "user" on is dropped, the
// stream is cancelled early, and the round settles with finishReason STOP.
// Tool-call arguments are never touched here (#1039): only prose is cut, and
// only calls buffered AFTER the bleed are suppressed — a genuine call from
// the real turn, buffered before the bleed, still settles normally.
const BLEED_ACP_FOLLOWER = new RegExp("^\\x3c" + ACP_NAME_ALT + "(?=[\\s/>=])");
const BLEED_ENVELOPE_FOLLOWER = new RegExp("^\\x3c(?:USER_REQUEST|ADDITIONAL_METADATA|SYSTEM_MESSAGE)(?=[\\s>])", "i");
const BLEED_SENTENCE_FOLLOWER = new RegExp("^The following is a \\x3cSYSTEM_MESSAGE\\x3e", "i");
const BLEED_ENVELOPE_LITERALS = ["\x3cUSER_REQUEST", "\x3cADDITIONAL_METADATA", "\x3cSYSTEM_MESSAGE"];
const BLEED_SENTENCE_LITERAL = "The following is a \x3cSYSTEM_MESSAGE\x3e";

type BleedFollower = "match" | "ambiguous" | "no";

/** What the text after a "user" line (leading whitespace skipped) proves:
 *  a follower opener starts it ("match"), it is still a strict prefix of a
 *  follower opener so the next chunk must decide ("ambiguous"), or it rules
 *  every follower out ("no" — the "user" line was ordinary prose). */
function bleedFollowerStatus(rest: string): BleedFollower {
    if (rest.length === 0) return "ambiguous";
    if (BLEED_ACP_FOLLOWER.test(rest) || BLEED_ENVELOPE_FOLLOWER.test(rest) || BLEED_SENTENCE_FOLLOWER.test(rest)) return "match";
    const upper = rest.toUpperCase();
    for (const lit of BLEED_ENVELOPE_LITERALS) {
        if (lit.startsWith(upper)) return "ambiguous";
    }
    if (BLEED_SENTENCE_LITERAL.toUpperCase().startsWith(upper)) return "ambiguous";
    // "\x3c" plus a still-growing tag name: an acp-style name or an envelope
    // name may still complete in the next chunk.
    if (/^\x3c[A-Za-z]{0,7}$/.test(rest)) return "ambiguous";
    return "no";
}

interface TurnBleedFence {
    inFence: boolean;
    char: string;
    len: number;
}

/** CommonMark fenced-code delimiter on one complete line, or null. A closing
 *  fence needs the same char, at least the opening length, and nothing but
 *  whitespace after it; a backtick opening's info string must hold no
 *  backtick. */
function bleedFenceDelimiter(line: string, st: TurnBleedFence): TurnBleedFence | null {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m === null) return null;
    const run = m[1];
    const ch = run[0];
    const rest = line.slice(m[0].length);
    if (st.inFence) {
        if (ch !== st.char || run.length < st.len) return null;
        if (rest.trim() !== "") return null;
        return { inFence: false, char: "", len: 0 };
    }
    if (ch === "`" && rest.includes("`")) return null;
    return { inFence: true, char: ch, len: run.length };
}

/** Whether an incomplete line could still grow into the "user" line
 *  (a strict prefix of it, or the full word plus trailing spaces/tabs). */
function bleedCouldBeUserLine(s: string): boolean {
    return /^(?:[Uu]|[Uu][Ss]|[Uu][Ss][Ee]|[Uu][Ss][Ee][Rr][ \t]*)$/.test(s);
}

/** Whether an incomplete line could still grow into a fence delimiter:
 *  a fence run is already there (its verdict needs the completed line), or
 *  only spaces plus at most two fence chars have arrived so far. */
function bleedCouldBeFenceLine(s: string, inFence: boolean): boolean {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(s);
    if (m !== null) {
        const rest = s.slice(m[0].length);
        if (m[1][0] === "`" && rest.includes("`")) return false;
        if (inFence && rest.trim() !== "") return false;
        return true;
    }
    return /^ {0,3}[`~]{0,2}$/.test(s);
}

interface TurnBleedScan {
    /** Index of the "\n" before the "user" line (0 when the bleed starts the
     *  buffer), once a follower proves the bleed. */
    cutAt: number | null;
    /** Index from which bytes must be held: the undecided tail. */
    holdFrom: number;
    /** Fence state at holdFrom. */
    stateAtHold: TurnBleedFence;
}

function scanTurnBleed(buf: string, start: TurnBleedFence): TurnBleedScan {
    let st: TurnBleedFence = { ...start };
    let pos = 0;
    for (;;) {
        const nl = buf.indexOf("\n", pos);
        if (nl === -1) {
            const tail = buf.slice(pos);
            const mustHold = bleedCouldBeUserLine(tail) || bleedCouldBeFenceLine(tail, st.inFence);
            return { cutAt: null, holdFrom: mustHold ? pos : buf.length, stateAtHold: st };
        }
        const rawLine = buf.slice(pos, nl);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        const lineState: TurnBleedFence = { ...st };
        const next = bleedFenceDelimiter(line, st);
        if (next !== null) {
            st = next;
            pos = nl + 1;
            continue;
        }
        if (!st.inFence && line.replace(/[ \t]+$/, "").toLowerCase() === "user") {
            let cut = pos === 0 ? 0 : pos - 1;
            if (cut > 0 && buf[cut - 1] === "\r") cut -= 1;
            const after = buf.slice(nl + 1).replace(/^[ \t\r\n]*/, "");
            const status = bleedFollowerStatus(after);
            if (status === "match") return { cutAt: cut, holdFrom: buf.length, stateAtHold: st };
            if (status === "ambiguous") return { cutAt: null, holdFrom: cut, stateAtHold: lineState };
        }
        pos = nl + 1;
    }
}

interface TurnBleedFeed {
    /** Decided-safe prefix: push it through the tag-echo filter. */
    emit: string;
    bled: boolean;
}

/** Streaming turn-bleed breaker over the visible text channel. feed() holds
 *  back only the undecided tail — a line that could still become "user", a
 *  fence delimiter still forming, or a "user" line whose follower has not
 *  arrived yet — so a bleed split across SSE chunk boundaries is still cut
 *  whole, and ordinary prose streams with no added delay. flush() releases
 *  the held tail at stream end, when no follower can still arrive; once the
 *  bleed is proven, feed() keeps returning empty and flush() discards the
 *  held tail. */
function createTurnBleedBreaker(): {
    feed(text: string): TurnBleedFeed;
    flush(): string;
    fenceSync(text: string): void;
} {
    let buf = "";
    let fence: TurnBleedFence = { inFence: false, char: "", len: 0 };
    let bled = false;
    return {
        feed(text: string): TurnBleedFeed {
            if (bled) return { emit: "", bled: true };
            buf += text;
            const scan = scanTurnBleed(buf, fence);
            if (scan.cutAt !== null) {
                bled = true;
                const emit = buf.slice(0, scan.cutAt);
                buf = "";
                return { emit, bled: true };
            }
            const emit = buf.slice(0, scan.holdFrom);
            buf = buf.slice(scan.holdFrom);
            fence = scan.stateAtHold;
            return { emit, bled: false };
        },
        flush(): string {
            if (bled) {
                buf = "";
                return "";
            }
            const out = buf;
            buf = "";
            return out;
        },
        // Signature-bound text rides verbatim (KDD #10), so it cannot pass
        // through feed() — but its fence lines still move the stream's fence
        // state. Best-effort sync over its complete lines only; a fence line
        // split across the signed/unsigned boundary is a known blind spot
        // (it can only misjudge a later bleed, never truncate real text on
        // its own — the cut still needs a proven follower).
        fenceSync(text: string): void {
            let st: TurnBleedFence = { ...fence };
            let pos = 0;
            for (;;) {
                const nl = text.indexOf("\n", pos);
                if (nl === -1) break;
                const rawLine = text.slice(pos, nl);
                const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
                const next = bleedFenceDelimiter(line, st);
                if (next !== null) st = next;
                pos = nl + 1;
            }
            fence = st;
        },
    };
}

export function createGoogleAdapter(
    requestBody: Record<string, unknown>,
    clientSystem?: string,
    absorbName?: string,
    model?: string,
    notes?: string[],
): CompressLoopAdapter {
    // Gemini carries the model in the URL path, not the body, so the server
    // hands it in; the body lookup only covers hand-built requests.
    const modelVersion = model ?? (typeof requestBody.model === "string" ? requestBody.model : undefined);

    const buildChunk = (
        parts: GooglePart[],
        extra: { candidate?: Record<string, unknown>; top?: Record<string, unknown> } = {},
    ): Buffer =>
        sseFrame({
            ...(modelVersion ? { modelVersion } : {}),
            candidates: [{ content: { role: "model", parts }, index: 0, ...(extra.candidate ?? {}) }],
            ...(extra.top ?? {}),
        });

    const buildToolArgs = (args: string): unknown => {
        if (args.length === 0) return {};
        try {
            const parsed: unknown = JSON.parse(args);
            return parsed === null || typeof parsed !== "object" ? {} : parsed;
        } catch {
            loggerLog("warn", "[google-adapter] tool-call arguments were not valid JSON; emitting an empty args object");
            return {};
        }
    };

    return {
        buildRequest(coreMessages, systemPrompt, body) {
            const contents = coreToGoogle(coreMessages, { model: modelVersion });
            if (notes && notes.length > 0) {
                for (const text of notes) contents.push({ role: "user", parts: [{ text }] });
            }
            const rebuilt: Record<string, unknown> = { ...body, contents };
            // The model lives in the URL path, `alt=sse` in the query, and the
            // output cap in generationConfig.maxOutputTokens — a body carrying
            // any of these keys is rejected upstream.
            delete rebuilt.model;
            delete rebuilt.stream;
            delete rebuilt.max_tokens;
            const parts = [clientSystem, systemPrompt]
                .filter((p): p is string => typeof p === "string" && p.length > 0)
                .map((text) => ({ text }));
            if (parts.length > 0) rebuilt.systemInstruction = { parts };
            return rebuilt;
        },

        async *parseStream(upstream, _round) {
            const pending = new Map<number, FunctionCallBuffer>();
            const rawCallChunks: { json: string; parsed: Record<string, unknown>; callIndexes: number[] }[] = [];
            // #206/#717: strip model-imitated render tags and forged ACP
            // confirmation markers from prose parts; filters may hold back a
            // short tail, flushed on finish (and at stream end).
            // #1960: there is deliberately NO filter instance for thought parts —
            // thought text is signed (thoughtSignature is verified byte-for-byte
            // on replay, the same fatality class as Anthropic thinking), so any
            // filtering of the forwarded or accumulated bytes desynchronizes
            // text from signature and bricks the session. Thought echoes are
            // forwarded verbatim; cosmetic leaks inside a thought pane are
            // accepted (#1960 verdict).
            // m00885: whole-field absorb-emission drop is armed only when this
            // request instructed the model about absorb (server-side provenance
            // — the absorb section exists on this request's wire iff absorbName
            // was resolved for it).
            const absorbArmedLocal = absorbName !== undefined;
            // m00885: the shipped request text lets the filter keep an
            // emission-shaped span the user asked to be output verbatim.
            const requestText = JSON.stringify(requestBody);
            const makeFilter = () => composeStreamFilters(
                composeStreamFilters(
                    createTagEchoFilter((snippet, duringDrain) => {
                        const what = duringDrain === true ? "held head dropped during drain" : "stripped model-emitted render tag";
                        loggerLog("warn", `[tag-echo] ${what}: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                    }, (snippet) => {
                        // #2190: residue audit — log-only, see plugin.ts twins.
                        loggerLog("warn", `[tag-echo] filter released echo-residue-shaped bytes (#2190): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                    }, absorbArmedLocal, requestText),
                    createMarkerLineFilter((snippet) => {
                        loggerLog("warn", `[marker-echo] stripped model-emitted ACP confirmation marker: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                    }),
                ),
                createBiliArtifactFilter((snippet) => {
                    loggerLog("warn", `[bili-artifact] stripped model-emitted internal artifact: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                }),
            );
            const tagFilter = makeFilter();
            const flushFilter = function* (): Generator<ParsedStreamEvent> {
                const tail = tagFilter.flush();
                if (tail.length > 0) {
                    yield { kind: "text", delta: tail, raw: buildChunk([{ text: tail }]) } as ParsedStreamEvent;
                }
            };
            // #7416: the turn-bleed breaker watches the visible text channel
            // ahead of the tag-echo filter (it needs the raw follower bytes
            // the filter strips). turnBled ends the round once proven.
            const bleed = createTurnBleedBreaker();
            let turnBled = false;
            const flushBleed = function* (): Generator<ParsedStreamEvent> {
                const tail = bleed.flush();
                if (tail.length > 0) {
                    const clean = tagFilter.push(tail);
                    if (clean.length > 0) {
                        yield { kind: "text", delta: clean, raw: buildChunk([{ text: clean }]) } as ParsedStreamEvent;
                    }
                }
            };
            let callIndex = 0;
            let sawReasoning = false;
            let toolCallsEmitted = 0;
            let degenerateWarned = false;
            let lastUsage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } | null = null;
            let usageEmitted = false;
            let sawDone = false;
            let sawRealToolCall = false;
            const maybeWarnDegenerate = (reason: string | undefined) => {
                if (degenerateWarned) return;
                // #1881: the gate reads the TEXT channel only — thought
                // presence reaches it via sawReasoning, and counting thought
                // chars as visible output would silence a tag-echo-only turn.
                const msg = degenerateTurnWarning({
                    reason,
                    terminalReason: "STOP",
                    toolCalls: toolCallsEmitted,
                    text: tagFilter.stats(),
                    sawThinking: sawReasoning,
                    wire: "google",
                });
                if (msg) {
                    degenerateWarned = true;
                    loggerLog("warn", msg);
                }
            };
            // #2405(c): per-response strip total — see plugin.ts twin. n==1 is
            // covered by its one-shot detail line, so stay silent there.
            let stripSummarized = false;
            const maybeSummarizeStrips = () => {
                if (stripSummarized) return;
                stripSummarized = true;
                const total = tagFilter.stats().dropCount;
                if (total > 1) loggerLog("warn", `[tag-echo] stripped ${total} occurrence(s) total in this response`);
            };
            const usageEvent = (): ParsedStreamEvent => ({ kind: "usage", ...(lastUsage ?? {}) }) as ParsedStreamEvent;
            const flushPendingAsStructured = function* (): Generator<ParsedStreamEvent> {
                for (const [, tc] of pending) {
                    if (tc.name.length > 0 || tc.id.length > 0) {
                        toolCallsEmitted++;
                        yield {
                            kind: "tool_call",
                            name: tc.name,
                            callId: tc.id,
                            arguments: tc.args,
                            ...(tc.signature ? { signature: tc.signature } : {}),
                        } as ParsedStreamEvent;
                    }
                }
                pending.clear();
            };
            // #1881: a call chunk's non-call parts. Such a chunk was withheld from
            // immediate forwarding on the assumption it would be replayed whole
            // at settle; when settle decides nothing replays, the prose still
            // has to reach the client (master lost even UNEDITED sibling text
            // in all-proxy chunks through this same path). #3158: standalone
            // thoughtSignature parts count too — a resynthesized chunk must not
            // strip them either. Opaque output (media/code/results) also belongs
            // to the complete frame and must survive proxy-call removal.
            const nonCallPartsOf = (obj: Record<string, unknown>): GooglePart[] => {
                const cands = obj.candidates as Array<Record<string, unknown>> | undefined;
                const ps = (cands?.[0]?.content as { parts?: GooglePart[] } | undefined)?.parts;
                if (!Array.isArray(ps)) return [];
                return ps.filter((p): p is GooglePart => !!p && typeof p === "object" && p.functionCall === undefined
                    && (typeof p.text !== "string" || p.text.length > 0 || p.thought === true
                        || (typeof p.thoughtSignature === "string" && p.thoughtSignature.length > 0)));
            };
            // #3158: parts whose only payload is a thoughtSignature — no text,
            // no functionCall. They model no structured event and were silently
            // dropped from the client's stream; the loop also records them so a
            // proxy-tool rebuild carries them back on the re-request.
            const standaloneSigParts = (obj: Record<string, unknown>): Array<GooglePart & { thoughtSignature: string }> => {
                const cands = obj.candidates as Array<Record<string, unknown>> | undefined;
                const ps = (cands?.[0]?.content as { parts?: GooglePart[] } | undefined)?.parts;
                if (!Array.isArray(ps)) return [];
                return ps.filter((p): p is GooglePart & { thoughtSignature: string } => !!p && typeof p === "object" && p.functionCall === undefined
                    && (typeof p.text !== "string" || p.text.length === 0)
                    && typeof p.thoughtSignature === "string" && p.thoughtSignature.length > 0);
            };
            // Decide proxy-vs-real from the buffered calls and emit events: real
            // calls → raw part replay (verbatim parts, original signatures/ids)
            // + passthrough-flagged structured events so the loop counts them;
            // proxy calls → structured events (executed server-side).
            const settleToolCalls = function* (): Generator<ParsedStreamEvent> {
                const realIndexes = new Set<number>();
                for (const [idx, tc] of pending) {
                    // absorb joins PROXY_TOOL_SET dynamically: its name is
                    // configurable per session, and misclassifying it as real
                    // would raw-replay its part to the client.
                    if (tc.name.length > 0 && !PROXY_TOOL_SET.has(tc.name) && tc.name !== absorbName) realIndexes.add(idx);
                }
                sawRealToolCall = realIndexes.size > 0;
                if (!sawRealToolCall) {
                    yield* flushPendingAsStructured();
                    for (const { parsed } of rawCallChunks) {
                        const parts = nonCallPartsOf(parsed);
                        if (parts.length > 0) yield { kind: "meta", chunk: sseFrame(cloneChunk(parsed, { parts, dropFinishReason: true })) } as ParsedStreamEvent;
                        for (const sp of standaloneSigParts(parsed)) {
                            yield { kind: "standalone_signature", signature: sp.thoughtSignature } as ParsedStreamEvent;
                        }
                    }
                    return;
                }
                // Gemini attaches thoughtSignature only to the FIRST functionCall
                // part in a parallel-call turn. When a stripped proxy call (e.g.
                // compress) led the turn and carried that signature, the first
                // surviving real functionCall part becomes the turn's leading call
                // on client replay and must inherit the signature or Gemini 3/4
                // rejects the next turn with 400 INVALID_ARGUMENT (missing
                // thought_signature).
                let firstRealIdx: number | undefined;
                let firstProxySig = "";
                for (const [idx, tc] of pending) {
                    if (realIndexes.has(idx)) {
                        if (firstRealIdx === undefined && tc.name.length > 0) firstRealIdx = idx;
                    } else if (firstProxySig.length === 0 && tc.signature.length > 0) {
                        firstProxySig = tc.signature;
                    }
                }
                const firstRealTc = firstRealIdx !== undefined ? pending.get(firstRealIdx) : undefined;
                const promoteSig =
                    firstRealIdx !== undefined && firstRealTc && firstRealTc.signature.length === 0 && firstProxySig.length > 0
                        ? { callIndex: firstRealIdx, signature: firstProxySig }
                        : undefined;
                for (const [idx, tc] of pending) {
                    if (realIndexes.has(idx) && tc.name.length > 0) {
                        toolCallsEmitted++;
                        const sig = tc.signature || (promoteSig?.callIndex === idx ? promoteSig.signature : "");
                        yield {
                            kind: "tool_call",
                            name: tc.name,
                            callId: tc.id,
                            arguments: tc.args,
                            passthrough: true,
                            ...(sig ? { signature: sig } : {}),
                        } as ParsedStreamEvent;
                    }
                }
                for (const { json, parsed, callIndexes } of rawCallChunks) {
                    const filtered = filterRealCallChunk(parsed, realIndexes, callIndexes, promoteSig);
                    if (filtered === "keep") {
                        yield { kind: "meta", chunk: Buffer.from(`data: ${json.replace(/\r\n|\r|\n/g, "\ndata: ")}\n\n`, "utf8") } as ParsedStreamEvent;
                    } else if (filtered !== null) {
                        yield { kind: "meta", chunk: sseFrame(filtered) } as ParsedStreamEvent;
                    } else {
                        // #1881: proxy-only chunk — its frame is dropped, but
                        // its withheld prose still has to reach the client.
                        const parts = nonCallPartsOf(parsed);
                        if (parts.length > 0) yield { kind: "meta", chunk: sseFrame(cloneChunk(parsed, { parts, dropFinishReason: true })) } as ParsedStreamEvent;
                    }
                    // #3158: every classification above keeps this chunk's
                    // standalone signature parts on the wire; record them once
                    // so a proxy-tool rebuild carries them back too.
                    for (const sp of standaloneSigParts(parsed)) {
                        yield { kind: "standalone_signature", signature: sp.thoughtSignature } as ParsedStreamEvent;
                    }
                }
                for (const [idx, tc] of pending) {
                    if (!realIndexes.has(idx) && tc.name.length > 0) {
                        toolCallsEmitted++;
                        yield {
                            kind: "tool_call",
                            name: tc.name,
                            callId: tc.id,
                            arguments: tc.args,
                            ...(tc.signature ? { signature: tc.signature } : {}),
                        } as ParsedStreamEvent;
                    }
                }
                pending.clear();
            };

            for await (const { frame, json } of iterGoogleChunks(upstream)) {
                let parsed: Record<string, unknown>;
                try {
                    parsed = JSON.parse(json) as Record<string, unknown>;
                } catch {
                    continue;
                }
                const rawBuf = Buffer.from(`${frame}\n\n`, "utf8");
                const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
                const candidate = candidates?.[0];
                const content = candidate?.content as { parts?: GooglePart[] } | undefined;
                const parts = Array.isArray(content?.parts) ? content.parts : [];
                const finishReason = typeof candidate?.finishReason === "string" ? candidate.finishReason : undefined;
                const feedback = parsed.promptFeedback as { blockReason?: unknown } | undefined;
                const blockReason = typeof feedback?.blockReason === "string" ? feedback.blockReason : undefined;
                const usageMetadata = parsed.usageMetadata as Record<string, unknown> | undefined;
                if (usageMetadata) lastUsage = readUsageMetadata(usageMetadata);

                const streamError = parsed.error;
                if (streamError !== undefined && streamError !== null) {
                    yield* flushBleed();
                    yield* flushFilter();
                    if (lastUsage && !usageEmitted) {
                        usageEmitted = true;
                        yield usageEvent();
                    }
                    let message: string;
                    if (typeof streamError === "object") {
                        const error = streamError as Record<string, unknown>;
                        const detail = typeof error.message === "string" ? error.message : JSON.stringify(streamError);
                        const status = typeof error.status === "string" ? error.status : undefined;
                        const code = typeof error.code === "number" || typeof error.code === "string" ? String(error.code) : undefined;
                        const prefix = [status, code ? `(${code})` : undefined].filter(Boolean).join(" ");
                        message = prefix ? `${prefix}: ${detail}` : detail;
                    } else {
                        message = String(streamError);
                    }
                    yield { kind: "error", message } as ParsedStreamEvent;
                    return;
                }

                // A prompt the safety filter refused up front carries no
                // candidate at all; the client needs the reason as a terminal.
                if (blockReason && !candidate && !sawDone) {
                    yield* flushBleed();
                    yield* flushFilter();
                    sawDone = true;
                    yield { kind: "meta", chunk: rawBuf } as ParsedStreamEvent;
                    yield { kind: "done", finishReason: blockReason } as ParsedStreamEvent;
                    continue;
                }
                if (!candidate) {
                    if (usageMetadata && !usageEmitted) {
                        usageEmitted = true;
                        yield usageEvent();
                    } else if (!usageMetadata) {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                    continue;
                }

                const callIndexes: number[] = [];
                // Whether THIS chunk carries a functionCall part anywhere, not
                // only before the part being forwarded: a chunk that will be
                // replayed whole at settle must not also hand the client its
                // text or reasoning now, and its sibling call parts must not
                // ride along in an edited copy (a proxy call would leak there
                // even when settle drops the chunk).
                const hasCallPart = parts.some((p) => p && typeof p === "object" && p.functionCall !== undefined);
                const partEvents: Array<Extract<ParsedStreamEvent, { kind: "text" | "reasoning" }>> = [];
                // #1881: cleaned copies of the prose parts this chunk carried.
                // When a call chunk's sibling prose was filtered, the settle-time
                // replay must carry the CLEANED bytes (the stored entry is
                // rebuilt from this), and the filtered part is NOT forwarded
                // ahead of settle (no double-send, no original-bytes leak).
                let editedParts: GooglePart[] | null = null;
                for (let i = 0; i < parts.length; i++) {
                    const part = parts[i];
                    if (!part || typeof part !== "object") continue;
                    // #7416: after a proven bleed the whole tail — prose and
                    // functionCall parts alike — belongs to a turn that never
                    // happened. Drop every later part in this chunk.
                    if (turnBled) continue;
                    const fc = part.functionCall as { name?: unknown; args?: unknown; id?: unknown } | undefined;
                    if (fc) {
                        const idx = callIndex++;
                        callIndexes.push(idx);
                        pending.set(idx, {
                            index: idx,
                            id: typeof fc.id === "string" ? fc.id : "",
                            name: typeof fc.name === "string" ? fc.name : "",
                            args: typeof fc.args === "string" ? fc.args : JSON.stringify(fc.args ?? {}),
                            signature: typeof part.thoughtSignature === "string" ? part.thoughtSignature : "",
                        });
                        continue;
                    }
                    if (typeof part.text !== "string" || part.text.length === 0) continue;
                    if (part.thought === true) {
                        sawReasoning = true;
                        // #1960: thought parts replay VERBATIM — never filtered
                        // (thoughtSignature is verified byte-for-byte; see the
                        // makeFilter note above).
                        partEvents.push({
                            kind: "reasoning",
                            delta: part.text,
                            rawHandled: true,
                            ...(typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0
                                ? { signature: part.thoughtSignature }
                                : {}),
                        });
                        continue;
                    }
                    // A signature may belong to ordinary text, without thought:true.
                    // Preserve its bytes and part boundary on both replay paths.
                    const signed = typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0;
                    let clean: string;
                    if (signed) {
                        // #1960: signature-bound text is forwarded verbatim —
                        // it cannot be truncated without desyncing the
                        // signature. Only its fence lines are tracked.
                        bleed.fenceSync(part.text);
                        clean = part.text;
                    } else {
                        const fed = bleed.feed(part.text);
                        if (fed.bled) turnBled = true;
                        clean = tagFilter.push(fed.emit);
                    }
                    if (clean !== part.text) {
                        editedParts ??= [...parts];
                        editedParts[i] = { ...part, text: clean };
                    }
                    if (clean.length === 0) continue;
                    partEvents.push({ kind: "text", delta: clean, rawHandled: true, ...(signed ? { rawGooglePart: part } : {}) });
                }
                // Decide wire output only after every prose sibling has been
                // cleaned. Each complete frame belongs to one event, regardless
                // of how many structured deltas it supplies to the loop.
                const storedParsed = editedParts || finishReason
                    ? cloneChunk(parsed, { ...(editedParts ? { parts: editedParts } : {}), dropFinishReason: true })
                    : parsed;
                if (callIndexes.length > 0) {
                    rawCallChunks.push({ json: storedParsed === parsed ? json : JSON.stringify(storedParsed), parsed: storedParsed, callIndexes });
                } else if (!hasCallPart && nonCallPartsOf(storedParsed).length > 0) {
                    if (partEvents.length === 0 && standaloneSigParts(parsed).length > 0) yield* flushFilter();
                    const raw = storedParsed === parsed ? rawBuf : sseFrame(storedParsed);
                    // A frame carrying prose is visible for the loop's retry
                    // gate even when its first part is a signed thought.
                    const carrier = partEvents.find(event => event.kind === "text") ?? partEvents[0];
                    if (carrier) carrier.raw = raw;
                    else yield { kind: "meta", chunk: raw } as ParsedStreamEvent;
                }
                yield* partEvents;
                // #3158: standalone thoughtSignature parts modeled no event above
                // and vanished from the client's stream. The complete frame
                // above now owns their wire bytes; record the signatures once
                // for the proxy-tool rebuild as well.
                if (callIndexes.length === 0) {
                    const sigParts = standaloneSigParts(parsed);
                    if (sigParts.length > 0) {
                        for (const sp of sigParts) {
                            yield { kind: "standalone_signature", signature: sp.thoughtSignature } as ParsedStreamEvent;
                        }
                    }
                }
                if (callIndexes.length === 0 && !finishReason && parts.length === 0) {
                    yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                }

                if (finishReason && !sawDone) {
                    yield* flushBleed();
                    yield* flushFilter();
                    yield* settleToolCalls();
                    if (lastUsage && !usageEmitted) {
                        usageEmitted = true;
                        yield usageEvent();
                    }
                    sawDone = true;
                    maybeWarnDegenerate(finishReason);
                    maybeSummarizeStrips();
                    const truncated = finishReason === "MAX_TOKENS";
                    if (sawRealToolCall) {
                        // A finish chunk that also carried the functionCall was
                        // already replayed by settleToolCalls; re-sending it
                        // verbatim would duplicate the call on the wire.
                        // #1881: settle already delivered this chunk's parts in
                        // every classification ("keep" replays the stored/cleaned
                        // json, a filtered rewrite keeps the non-call parts, and
                        // a dropped proxy-only chunk delivers its withheld prose),
                        // so the stub carries NO parts — resending them duplicates
                        // the prose on the wire.
                        const finishChunk = parts.length > 0 ? sseFrame(cloneChunk(parsed, { parts: [] })) : rawBuf;
                        yield { kind: "meta", chunk: finishChunk } as ParsedStreamEvent;
                        yield { kind: "done", finishReason, suppressCompletion: true, ...(truncated ? { truncated: true } : {}) } as ParsedStreamEvent;
                    } else {
                        yield { kind: "done", finishReason, ...(truncated ? { truncated: true } : {}) } as ParsedStreamEvent;
                    }
                }
                // #7416: the turn bled — stop reading the upstream here; the
                // post-loop block settles the round with STOP.
                if (turnBled) break;
            }

            // #7416: a hallucinated turn bleed ends the round here. The
            // post-bleed parts never entered pending, so settle only sees
            // the real turn's calls; the held bleed tail is discarded.
            if (turnBled && !sawDone) {
                void upstream.cancel().catch(() => {});
                yield* flushFilter();
                yield* settleToolCalls();
                if (lastUsage && !usageEmitted) {
                    usageEmitted = true;
                    yield usageEvent();
                }
                sawDone = true;
                maybeWarnDegenerate("STOP");
                maybeSummarizeStrips();
                loggerLog("warn", "[tag-echo] turn-bleed: truncated response at hallucinated user turn");
                yield { kind: "done", finishReason: "STOP" } as ParsedStreamEvent;
            }
            // A stream that died mid-flight still has to hand the client the
            // usage it reported, and a held-back filter tail must not be lost.
            yield* flushBleed();
            yield* flushFilter();
            if (!sawDone && lastUsage && !usageEmitted) {
                usageEmitted = true;
                yield usageEvent();
            }
        },

        emitText(delta) {
            return buildChunk([{ text: delta }]);
        },

        emitReasoning(delta) {
            return buildChunk([{ text: delta, thought: true }]);
        },

        emitToolCall(call: ToolCallEmit) {
            return buildChunk([{
                functionCall: {
                    name: call.name,
                    args: buildToolArgs(call.arguments),
                    ...(call.callId ? { id: call.callId } : {}),
                },
                ...(call.signature ? { thoughtSignature: call.signature } : {}),
            }]);
        },

        emitMarker(toolName, result) {
            return buildChunk([{ text: buildVisibilityMarker(toolName, result) }]);
        },

        emitCompletion(opts?: EmitCompletionOpts) {
            const usage = opts?.usage
                ? {
                      usageMetadata: {
                          promptTokenCount: opts.usage.inputTokens ?? 0,
                          candidatesTokenCount: opts.usage.outputTokens ?? 0,
                          totalTokenCount: (opts.usage.inputTokens ?? 0) + (opts.usage.outputTokens ?? 0),
                          ...(typeof opts.usage.cachedTokens === "number"
                              ? { cachedContentTokenCount: opts.usage.cachedTokens }
                              : {}),
                      },
                  }
                : {};
            return buildChunk([], { candidate: { finishReason: googleFinishReason(opts?.finishReason) }, top: usage });
        },

        emitError(message) {
            return sseFrame({ error: { code: 500, message, status: "INTERNAL" } });
        },
    };
}
