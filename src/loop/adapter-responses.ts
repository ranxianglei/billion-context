import type { CoreMessage } from "acp-kernel";
import { injectResponsesDeveloperMessage, type ResponseInputItem, type ResponsesProjection } from "acp-kernel/wire";
import { keepResponseId as knobKeepResponseId } from "../knobs.js";
import { coreToResponsesWithToolImages as coreToResponses, patchResponsesInputWithToolImages as patchResponsesInput, mergeAdjacentConfigurationUpdates } from "../responses-tool-output.js";
import { buildVisibilityMarker } from "./core.js";
import { hoistTrappedToolItems } from "../tool-pair-order.js";
import { hashId, strippedResponseIdWarning } from "../util.js";
import { composeStreamFilters, createBiliArtifactFilter, createIdentityStreamFilter, createMarkerLineFilter, createTagEchoFilter, stripResponsesText, containsBiliInternalText, containsMarkerLineText, containsRenderTagText, containsToolCallEmissionText, ACP_NAME_ALT, type TagEchoFilter } from "./tag-echo-filter.js";
import { degenerateTurnWarning } from "../degenerate-turn.js";
import { log as loggerLog } from "../logger.js";
import { normalizeSseLineEndings, finalizeSseLineEndings } from "../sse-util.js";
import { extractResponsesTextTriggers, PROXY_TOOL_NAMES } from "../compress-tool.js";
import type { BiliMessage } from "acp-kernel/wire";
import type {
    CompressLoopAdapter,
    EmitCompletionOpts,
    ParsedStreamEvent,
    ToolCallEmit,
} from "./core.js";

interface FunctionCallBuffer {
    itemId: string;
    callId: string;
    name: string;
    arguments: string;
}

// Upstream rejects Responses input item ids longer than 64 chars. All
// proxy-synthesized ids stay well below this cap (#242).
const RESPONSES_ITEM_ID_MAX = 64;

// Client-visible message ids bili mints. The upstream requires message item
// ids to begin with "msg" (WC-015), so every message item — visibility
// markers included — is minted under this one prefix.
const PROXY_MESSAGE_ID_PREFIX = "msg-proxy-";
// Minted for visibility markers by releases before WC-015. Recognized only so
// rollouts those versions already poisoned heal at ingress instead of 400ing
// on every subsequent request.
const LEGACY_MARKER_MESSAGE_ID_PREFIX = "marker-";

function proxyMessageItemId(outputIndex: number): string {
    return `${PROXY_MESSAGE_ID_PREFIX}${Date.now()}-${outputIndex}`;
}

function isBiliMessageId(id: unknown): id is string {
    return typeof id === "string"
        && (id.startsWith(PROXY_MESSAGE_ID_PREFIX) || id.startsWith(LEGACY_MARKER_MESSAGE_ID_PREFIX));
}

export function normalizeResponsesMessageItems(input: unknown): number {
    if (!Array.isArray(input)) return 0;
    let typed = 0;
    for (const item of input) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        if (rec["type"] !== undefined) continue;
        if (rec["role"] !== "user" && rec["role"] !== "assistant") continue;
        if (rec["content"] === undefined) continue;
        // omp (pi-ai) sends user items without the spec-required "type" field;
        // responsesToCore switches on item.type and silently drops type-less
        // items, so user prompts never enter the kernel (no refs, never
        // compressible, invisible to nudge/preflight). Stamp the standard
        // type at ingress.
        rec["type"] = "message";
        typed++;
    }
    return typed;
}

/**
 * Heal client rollouts already poisoned with Bili-generated ids (they 400
 * every request otherwise). Only the namespaces bili owns are touched — in
 * place and deterministically, so repeated requests keep referencing the same
 * replacement id (#242). Provider-issued opaque ids (reasoning rs_*,
 * function_call fc_*, ...) validate against their owner's shape rules and
 * carry replay correspondence, so they must reach the upstream byte-identical
 * (#1474).
 */
export function sanitizeResponsesInputIds(input: unknown): void {
    if (!Array.isArray(input)) return;
    for (const item of input) {
        const rec = item as Record<string, unknown>;
        // Client-visible proxy ids are not upstream item identities; replay the full message instead.
        if (rec?.type === "message" && rec.role === "assistant"
            && isBiliMessageId(rec.id)
            && (typeof rec.content === "string" || Array.isArray(rec.content))) {
            delete rec.id;
            continue;
        }
        if (typeof rec?.id === "string" && rec.id.startsWith(PROXY_MESSAGE_ID_PREFIX)
            && rec.id.length > RESPONSES_ITEM_ID_MAX) {
            rec.id = `msg-fix-${hashId(rec.id)}`;
        }
    }
}

/**
 * Responses input flattens a mixed assistant turn (text + tool calls) into
 * separate items, so the whitespace-only text deltas SGLang/vllm-class models
 * emit before tool calls land as standalone 1-2 token message items (omp
 * serializes exactly this shape). Left alone, every one gets an acp render
 * tag — a 42-token wrapper around pure whitespace — and burns a message ref
 * the model later has to reason about. Content-free by definition, so drop
 * them before projection; deterministic per request, keeping refs stable.
 */
export function dropWhitespaceResponsesMessages(input: unknown): number {
    if (!Array.isArray(input)) return 0;
    let dropped = 0;
    for (let i = input.length - 1; i >= 0; i--) {
        const rec = input[i] as Record<string, unknown>;
        if (rec === null || typeof rec !== "object") continue;
        const type = rec.type;
        // message items carry type "message"; omp's user items omit the field
        // entirely (role + content only) — treat those as messages too.
        if (type !== "message" && type !== undefined) continue;
        const role = rec.role;
        if (role !== "user" && role !== "assistant") continue;
        const content = rec.content;
        let text: string | undefined;
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
            let mixed = false;
            let joined = "";
            for (const part of content) {
                const p = part as Record<string, unknown>;
                // Malformed parts (non-objects) make emptiness unknowable —
                // treat as mixed and preserve the item.
                if (p === null || typeof p !== "object") {
                    mixed = true;
                    break;
                }
                const pt = p.type;
                if (pt !== undefined && pt !== "input_text" && pt !== "output_text" && pt !== "text") {
                    mixed = true;
                    break;
                }
                if (typeof p.text === "string") joined += p.text;
            }
            if (!mixed) text = joined;
        }
        // Replay stickiness: an originally-whitespace message comes back on
        // every later request carrying the render tag a previous turn
        // stamped onto it (tag + whitespace, still semantically empty). A
        // tag wrapping a real ref over real content keeps the message alive;
        // only tag-over-nothing is droppable.
        if (text !== undefined && stripRenderTags(text).trim() === "") {
            input.splice(i, 1);
            dropped++;
        }
    }
    return dropped;
}

const RENDER_TAG_RE = new RegExp("\x3c" + ACP_NAME_ALT + "\\s[^\x3e]*\x3e[^\x3c]*\x3c\\/" + ACP_NAME_ALT + "\x3e|\x3c" + ACP_NAME_ALT + "\\s[^\x3e]*\\/\x3e", "g");

function stripRenderTags(text: string): string {
    return text.replace(RENDER_TAG_RE, "");
}

interface MappedItem {
    id: string;
    index: number;
}

function rewriteItemEvent(type: string, obj: Record<string, unknown>, mapped: MappedItem): Buffer {
    const item = { ...((obj.item as Record<string, unknown>) ?? {}), id: mapped.id };
    return Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ ...obj, output_index: mapped.index, item })}\n\n`, "utf8");
}

function rewriteRefEvent(type: string, obj: Record<string, unknown>, mapped: MappedItem): Buffer {
    return Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ ...obj, item_id: mapped.id, output_index: mapped.index })}\n\n`, "utf8");
}

function rebuildResponsesEvent(type: string, obj: Record<string, unknown>): Buffer {
    return Buffer.from(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`, "utf8");
}

async function* iterSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
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
            buf = normalizeSseLineEndings(buf);
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
                const raw = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (raw.trim().length > 0) yield raw;
            }
        }
        buf = finalizeSseLineEndings(buf);
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (raw.trim().length > 0) yield raw;
        }
        if (buf.trim().length > 0) yield buf;
    } finally {
        reader.releaseLock();
    }
}

function extractEventType(rawEvent: string): string | null {
    for (const l of rawEvent.split("\n")) {
        if (l.startsWith("event:")) return l.slice(6).trim();
    }
    return null;
}

function extractDataLine(rawEvent: string): string | null {
    const parts: string[] = [];
    for (const l of rawEvent.split("\n")) {
        if (l.startsWith("data:")) {
            let v = l.slice(5);
            if (v.startsWith(" ")) v = v.slice(1);
            parts.push(v);
        }
    }
    return parts.length ? parts.join("\n") : null;
}

function buildMessageItemSequence(itemId: string, outputIndex: number, text: string): Buffer {
    const item = { type: "message", id: itemId, role: "assistant", content: [] as unknown[] };
    const part = { type: "output_text", text: "" };
    const doneItem = {
        type: "message",
        id: itemId,
        role: "assistant",
        content: [{ type: "output_text", text }],
    };
    return Buffer.from(
        [
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: outputIndex, item })}\n\n`,
            `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", item_id: itemId, output_index: outputIndex, part })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: itemId, output_index: outputIndex, delta: text })}\n\n`,
            `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: itemId, output_index: outputIndex, text })}\n\n`,
            `event: response.content_part.done\ndata: ${JSON.stringify({ type: "response.content_part.done", item_id: itemId, output_index: outputIndex, part: { type: "output_text", text } })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: outputIndex, item: doneItem })}\n\n`,
        ].join(""),
        "utf8",
    );
}

function buildFunctionCallEvents(fc: ToolCallEmit, itemId: string, outputIndex: number): Buffer {
    const args = fc.arguments;
    return Buffer.from(
        [
            `event: response.output_item.added\ndata: ${JSON.stringify({
                type: "response.output_item.added",
                output_index: outputIndex,
                item: { type: "function_call", id: itemId, call_id: fc.callId, name: fc.name, arguments: "" },
            })}\n\n`,
            `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
                type: "response.function_call_arguments.delta",
                item_id: itemId,
                delta: args,
            })}\n\n`,
            `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
                type: "response.function_call_arguments.done",
                item_id: itemId,
                arguments: args,
            })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({
                type: "response.output_item.done",
                output_index: outputIndex,
                item: { type: "function_call", id: itemId, call_id: fc.callId, name: fc.name, arguments: args },
            })}\n\n`,
        ].join(""),
        "utf8",
    );
}

function buildCompleted(responseObj: Record<string, unknown> | null): Buffer {
    const resp = responseObj ?? { id: `resp-proxy-${Date.now()}`, status: "completed", output: [] };
    return Buffer.from(
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: resp })}\n\n`,
        "utf8",
    );
}

export function createResponsesAdapter(textProtocol?: boolean, projection?: ResponsesProjection, absorbName?: string, notes?: string[]): CompressLoopAdapter {
    const suppressTextLifecycle = !!textProtocol;
    let outputIndex = 0;
    let responseObj: Record<string, unknown> | null = null;
    let terminalRaw: Buffer | null = null;
    let terminalKind: string | null = null;
    // #440: response.failed with no preceding response.created is an orphan that
    // crashes strict clients (codex) — same class as the anthropic gap (#413).
    let createdForwarded = false;
    let createdRespId: string | null = null;
    // m00885: the client request bytes as shipped (user messages included,
    // kernel prompt section excluded) — buildRequest runs before parseStream,
    // so the filters below can echo-check an emission-shaped span against it.
    let shippedRequestText: string | undefined;
    const ensureCreated = (): Buffer | null => {
        if (createdForwarded) return null;
        createdForwarded = true;
        if (!createdRespId) createdRespId = `resp-proxy-${Date.now()}`;
        return Buffer.from(
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: createdRespId, status: "in_progress", output: [] } })}\n\n`,
            "utf8",
        );
    };

    return {
        buildRequest(coreMessages, systemPrompt, requestBody) {
            shippedRequestText = JSON.stringify(requestBody);
            const customToolCallIds = new Set<string>();
            for (const m of coreMessages) {
                const bm = m as BiliMessage;
                const raw = bm?.rawResponsesItem as Record<string, unknown> | undefined;
                if (raw && (raw.type === "custom_tool_call" || raw.type === "custom_tool_call_output")) {
                    const id = typeof raw.call_id === "string" ? raw.call_id : (typeof raw.id === "string" ? raw.id : "");
                    if (id) customToolCallIds.add(id);
                }
            }
            let inputItems: ResponseInputItem[];
            if (projection) {
                const rebuiltInput = patchResponsesInput(projection, coreMessages);
                inputItems = typeof rebuiltInput === "string"
                    ? [{ type: "message", role: "user", content: rebuiltInput }]
                    : rebuiltInput;
            } else {
                inputItems = coreToResponses(coreMessages, customToolCallIds);
            }
            inputItems = mergeAdjacentConfigurationUpdates(hoistTrappedToolItems(inputItems));
            const devParts = projection && projection.systemParts.length > 0
                ? [...projection.systemParts, systemPrompt]
                : [systemPrompt];
            const withDev = injectResponsesDeveloperMessage(inputItems, devParts.join("\n\n---\n\n"));
            const finalInput = notes && notes.length > 0
                ? [...withDev, ...notes.map((text) => ({ type: "message" as const, role: "user" as const, content: text }))]
                : withDev;
            const rebuilt: Record<string, unknown> = { ...requestBody, input: finalInput };
            // #1954: same as the HTTP path — warn when we strip a non-empty
            // chain ref, since a delta continuation then loses its history silently.
            if (!knobKeepResponseId()) {
                const chainWarn = strippedResponseIdWarning(rebuilt.previous_response_id);
                if (chainWarn) loggerLog("warn", `[acp-responses] ${chainWarn}`);
                delete rebuilt.previous_response_id;
            }
            delete rebuilt.instructions;
            return rebuilt;
        },

        async *parseStream(upstream, round) {
            const pending = new Map<string, FunctionCallBuffer>();
            // #1501 option C: nameless function_call items fall into raw replay
            // below — their bytes reach the client untouched (#1039). Track them
            // so the round-end settle can emit one diag warn (#1484 class); the
            // observed rate settles the drop-vs-keep policy without surgery.
            const namelessFc = new Map<string, { callId: string; argsLen: number; frags: number }>();
            const settleNamelessDiag = function* (): Generator<ParsedStreamEvent> {
                if (namelessFc.size === 0) return;
                const parts = [...namelessFc.entries()].map(([itemId, fc]) => `item=${itemId || "-"}${fc.callId ? ` id=${fc.callId}` : ""} argsLen=${fc.argsLen} frags=${fc.frags}`);
                yield { kind: "diag", level: "warn", message: `[acp-responses] round ${round}: ${parts.length} nameless function_call(s) forwarded verbatim: ${parts.join(" | ")} (#1501 observe-only)` } as ParsedStreamEvent;
                namelessFc.clear();
            };
            const remapped = new Map<string, MappedItem>();
            // #206: render-tag echo filter — deltas stream through the filter;
            // full-text events (.done / output_item.done / completed response)
            // are stripped wholesale via stripResponsesText. #1881: reasoning
            // summaries stream through their own per-summary filters — the old
            // generic raw passthrough leaked model-emitted tags on this wire.
            // m00885: whole-field absorb-emission drop is armed only when this
            // request instructed the model about absorb (server-side provenance
            // — the absorb section exists on this request's wire iff absorbName
            // was resolved for it).
            const absorbArmedLocal = absorbName !== undefined;
            const makeFilter = () => composeStreamFilters(
                composeStreamFilters(
                    createTagEchoFilter((snippet) => {
                        loggerLog("warn", `[tag-echo] stripped model-emitted render tag: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                    }, (snippet) => {
                        // #2190: residue audit — log-only, see plugin.ts twins.
                        loggerLog("warn", `[tag-echo] filter released echo-residue-shaped bytes (#2190): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                    }, absorbArmedLocal, shippedRequestText),
                    createMarkerLineFilter((snippet) => {
                        loggerLog("warn", `[marker-echo] stripped model-emitted ACP confirmation marker: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                    }),
                ),
                createBiliArtifactFilter((snippet) => {
                    loggerLog("warn", `[bili-artifact] stripped model-emitted internal artifact: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                }),
            );
            const tagFilter = makeFilter();
            // Unified ACP invariant: reasoning summaries are the thinking channel —
            // identity filters, byte-verbatim (never rewritten; matches the
            // openai adapter's reasoning_filter and #1960/KDD#10).
            const reasoningFilters = new Map<string, { filter: TagEchoFilter; ref: { itemId: string; outputIndex: number; summaryIndex: number } }>();
            let lastTextRef: { itemId: string; outputIndex: number } | null = null;
            const flushFilter = function* (): Generator<ParsedStreamEvent> {
                const tail = tagFilter.flush();
                if (tail.length > 0) {
                    const raw = lastTextRef
                        ? rebuildResponsesEvent("response.output_text.delta", { type: "response.output_text.delta", item_id: lastTextRef.itemId, output_index: lastTextRef.outputIndex, delta: tail })
                        : undefined;
                    yield { kind: "text", delta: tail, ...(raw ? { raw } : {}) } as ParsedStreamEvent;
                }
                for (const entry of reasoningFilters.values()) {
                    const rtail = entry.filter.flush();
                    if (rtail.length > 0) {
                        yield {
                            kind: "meta",
                            chunk: rebuildResponsesEvent("response.reasoning_summary_text.delta", {
                                type: "response.reasoning_summary_text.delta",
                                item_id: entry.ref.itemId,
                                output_index: entry.ref.outputIndex,
                                summary_index: entry.ref.summaryIndex,
                                delta: rtail,
                            }),
                            firstRoundOnly: true,
                        } as ParsedStreamEvent;
                    }
                }
            };
            let sawReasoning = false;
            let toolCallsEmitted = 0;
            let degenerateWarned = false;
            const maybeWarnDegenerate = (reason: string | undefined) => {
                if (degenerateWarned) return;
                // #1881: the gate reads the TEXT channel only — reasoning
                // presence reaches it via sawReasoning, and counting reasoning
                // chars as visible output would silence a tag-echo-only turn.
                const msg = degenerateTurnWarning({ reason, terminalReason: "completed", toolCalls: toolCallsEmitted, text: tagFilter.stats(), sawThinking: sawReasoning, wire: "responses" });
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
            for await (const eventStr of iterSseEvents(upstream)) {
                const explicitType = extractEventType(eventStr);
                const dataLine = extractDataLine(eventStr);
                if (!dataLine) continue;
                let obj: Record<string, unknown>;
                try {
                    obj = JSON.parse(dataLine);
                } catch {
                    continue;
                }
                // #549: `event:` is optional per the WHATWG SSE spec (defaults to
                // "message"); many OpenAI-compatible gateways emit pure data: frames.
                // Responses payloads carry a `type` equal to the event name — fall
                // back to it when no event: line is present (explicit line still wins).
                const type = explicitType ?? (typeof obj.type === "string" ? obj.type : null);
                if (!type) continue;
                if (type.startsWith("response.reasoning")) sawReasoning = true;
                const rawBuf = Buffer.from(eventStr + "\n\n", "utf8");
                if (round === 1 && typeof obj.output_index === "number") {
                    outputIndex = Math.max(outputIndex, obj.output_index + 1);
                }

                if (type === "response.created" || type === "response.in_progress") {
                    if (type === "response.created") {
                        const resp = obj.response as Record<string, unknown> | undefined;
                        if (resp && typeof resp.id === "string") createdRespId = resp.id;
                        if (round === 1) createdForwarded = true;
                    }
                    yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                } else if (type === "response.output_item.added") {
                    const item = obj.item as Record<string, unknown> | undefined;
                    if (item?.type === "function_call") {
                        const fcName = typeof item.name === "string" ? item.name : "";
                        // absorb is deliberately outside PROXY_TOOL_NAMES (kernel ACP_TOOL_NAMES);
                        // without absorbName it would be raw-replayed as a real call and never executed.
                        if (PROXY_TOOL_NAMES.has(fcName) || fcName === absorbName) {
                            const itemId = typeof item.id === "string" ? item.id : "";
                            pending.set(itemId, {
                                itemId,
                                callId: typeof item.call_id === "string" ? item.call_id : "",
                                name: fcName,
                                arguments: "",
                            });
                        } else {
                            if (fcName.length === 0) {
                                namelessFc.set(typeof item.id === "string" ? item.id : "", { callId: typeof item.call_id === "string" ? item.call_id : "", argsLen: 0, frags: 1 });
                            }
                            yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                        }
                    } else if (item?.type === "custom_tool_call") {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                    } else if (item?.type === "message" && round > 1 && !suppressTextLifecycle) {
                        const origId = typeof item.id === "string" ? item.id : "";
                        const mapped = { id: `${PROXY_MESSAGE_ID_PREFIX}${round}-${hashId(origId || String(outputIndex))}`, index: outputIndex++ };
                        if (origId) remapped.set(origId, mapped);
                        yield { kind: "meta", chunk: rewriteItemEvent(type, obj, mapped), firstRoundOnly: false } as ParsedStreamEvent;
                    } else if (item?.type !== "message" || !suppressTextLifecycle) {
                        // #1881: reasoning items carry whole-text summaries in
                        // this fallthrough — strip on detection like the message
                        // branches above (stripResponsesText never touches tool
                        // argument fields).
                        const chunk = (containsRenderTagText(eventStr) || containsMarkerLineText(eventStr) || containsBiliInternalText(eventStr) || (absorbArmedLocal && containsToolCallEmissionText(eventStr))) ? rebuildResponsesEvent(type, stripResponsesText(obj, absorbArmedLocal, shippedRequestText)) : rawBuf;
                        yield { kind: "meta", chunk, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else if (
                    type === "response.content_part.added" ||
                    type === "response.content_part.done" ||
                    type === "response.output_text.done"
                ) {
                    const mapped = remapped.get(typeof obj.item_id === "string" ? obj.item_id : "");
                    if (mapped) {
                        yield { kind: "meta", chunk: rewriteRefEvent(type, stripResponsesText(obj), mapped), firstRoundOnly: false } as ParsedStreamEvent;
                    } else if (!suppressTextLifecycle) {
                        const chunk = (containsRenderTagText(eventStr) || containsMarkerLineText(eventStr) || containsBiliInternalText(eventStr) || (absorbArmedLocal && containsToolCallEmissionText(eventStr))) ? rebuildResponsesEvent(type, stripResponsesText(obj, absorbArmedLocal, shippedRequestText)) : rawBuf;
                        yield { kind: "meta", chunk, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else if (type === "response.output_text.delta") {
                    const delta = typeof obj.delta === "string" ? obj.delta : "";
                    if (delta.length > 0) {
                        const itemId = typeof obj.item_id === "string" ? obj.item_id : "";
                        const outputIndex = typeof obj.output_index === "number" ? obj.output_index : 0;
                        const mapped = remapped.get(itemId);
                        lastTextRef = { itemId: mapped ? mapped.id : itemId, outputIndex: mapped ? mapped.index : outputIndex };
                        const clean = tagFilter.push(delta);
                        if (clean.length > 0) {
                            if (mapped) {
                                yield { kind: "text", delta: clean, raw: rewriteRefEvent(type, { ...obj, delta: clean }, mapped) } as ParsedStreamEvent;
                            } else if (round === 1) {
                                const raw = clean === delta ? rawBuf : rebuildResponsesEvent(type, { ...obj, delta: clean });
                                yield { kind: "text", delta: clean, raw } as ParsedStreamEvent;
                            } else {
                                yield { kind: "text", delta: clean } as ParsedStreamEvent;
                            }
                        }
                    }
                } else if (type === "response.function_call_arguments.delta") {
                    const itemId = typeof obj.item_id === "string" ? obj.item_id : "";
                    const delta = typeof obj.delta === "string" ? obj.delta : "";
                    const fc = pending.get(itemId);
                    if (fc) fc.arguments += delta;
                    else {
                        const nf = namelessFc.get(itemId);
                        if (nf) { nf.argsLen += delta.length; nf.frags++; }
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                    }
                } else if (type === "response.function_call_arguments.done") {
                    const itemId = typeof obj.item_id === "string" ? obj.item_id : "";
                    const args = typeof obj.arguments === "string" ? obj.arguments : "";
                    const fc = pending.get(itemId);
                    if (fc && args) fc.arguments = args;
                    else {
                        const nf = namelessFc.get(itemId);
                        if (nf && args) { nf.argsLen = args.length; nf.frags++; }
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                    }
                } else if (type === "response.custom_tool_call_input.delta" || type === "response.custom_tool_call_input.done") {
                    // #1864: forward every round like the function_call_arguments siblings (the catch-all drops them in re-request rounds).
                    yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                } else if (type === "response.output_item.done") {
                    const item = obj.item as Record<string, unknown> | undefined;
                    if (item?.type === "function_call") {
                        const itemId = typeof item.id === "string" ? item.id : "";
                        const fc = pending.get(itemId);
                        if (fc) {
                            if (typeof item.arguments === "string" && item.arguments) fc.arguments = item.arguments;
                            pending.delete(itemId);
                            toolCallsEmitted++;
                            // #1039 invariant: arguments are user intent, verbatim — see tag-echo-filter.ts header.
                            yield {
                                kind: "tool_call",
                                name: fc.name,
                                callId: fc.callId,
                                arguments: fc.arguments,
                            } as ParsedStreamEvent;
                        } else {
                            if (typeof item.name !== "string" || item.name.length === 0) {
                                const nf = namelessFc.get(itemId) ?? { callId: "", argsLen: 0, frags: 0 };
                                nf.callId = typeof item.call_id === "string" ? item.call_id : nf.callId;
                                if (typeof item.arguments === "string") nf.argsLen = item.arguments.length;
                                nf.frags++;
                                namelessFc.set(itemId, nf);
                            }
                            yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                            toolCallsEmitted++;
                            yield {
                                kind: "tool_call",
                                name: typeof item.name === "string" ? item.name : "",
                                callId: typeof item.call_id === "string" ? item.call_id : "",
                                arguments: typeof item.arguments === "string" ? item.arguments : "",
                                passthrough: true,
                            } as ParsedStreamEvent;
                        }
                    } else if (item?.type === "custom_tool_call") {
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: false } as ParsedStreamEvent;
                        // #1862: a completed custom tool call IS executable output — count it
                        // like function_call so the degenerate-retry gate (calls.length === 0)
                        // does not treat a reasoning+custom-tool turn as an empty turn and
                        // re-issue the request (duplicating the action). Passthrough: the wire
                        // bytes already reached the client verbatim above, so the loop must not
                        // re-emit it via emitToolCall. `input` is the custom-tool argument field.
                        toolCallsEmitted++;
                        yield {
                            kind: "tool_call",
                            name: typeof item.name === "string" ? item.name : "",
                            callId: typeof item.call_id === "string" ? item.call_id : "",
                            arguments: typeof item.input === "string" ? item.input : "",
                            passthrough: true,
                        } as ParsedStreamEvent;
                    } else if (item?.type === "message") {
                        const origId = typeof item.id === "string" ? item.id : "";
                        const mapped = remapped.get(origId);
                        if (mapped) {
                            remapped.delete(origId);
                            yield { kind: "meta", chunk: rewriteItemEvent(type, stripResponsesText(obj), mapped), firstRoundOnly: false } as ParsedStreamEvent;
                        } else if (!suppressTextLifecycle) {
                            const chunk = (containsRenderTagText(eventStr) || containsMarkerLineText(eventStr) || containsBiliInternalText(eventStr) || (absorbArmedLocal && containsToolCallEmissionText(eventStr))) ? rebuildResponsesEvent(type, stripResponsesText(obj, absorbArmedLocal, shippedRequestText)) : rawBuf;
                            yield { kind: "meta", chunk, firstRoundOnly: true } as ParsedStreamEvent;
                        }
                    } else if (item?.type !== "message" || !suppressTextLifecycle) {
                        // #1881: reasoning items carry whole-text summaries in
                        // this fallthrough — strip on detection like the message
                        // branches above (stripResponsesText never touches tool
                        // argument fields).
                        const chunk = (containsRenderTagText(eventStr) || containsMarkerLineText(eventStr) || containsBiliInternalText(eventStr) || (absorbArmedLocal && containsToolCallEmissionText(eventStr))) ? rebuildResponsesEvent(type, stripResponsesText(obj, absorbArmedLocal, shippedRequestText)) : rawBuf;
                        yield { kind: "meta", chunk, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else if (type === "response.completed") {
                    yield* flushFilter();
                    yield* settleNamelessDiag();
                    responseObj = stripResponsesText((obj.response as Record<string, unknown>) ?? null, absorbArmedLocal, shippedRequestText);
                    terminalKind = "completed";
                    terminalRaw = null;
                    const respUsage = (responseObj as Record<string, unknown> | null)?.usage as
                        | Record<string, unknown>
                        | undefined;
                    const pd = respUsage?.input_tokens_details as Record<string, unknown> | undefined;
                    yield {
                        kind: "usage",
                        inputTokens: typeof respUsage?.input_tokens === "number" ? respUsage.input_tokens : undefined,
                        outputTokens: typeof respUsage?.output_tokens === "number" ? respUsage.output_tokens : undefined,
                        cachedTokens: typeof pd?.cached_tokens === "number" ? pd.cached_tokens : undefined,
                    } as ParsedStreamEvent;
                    maybeWarnDegenerate("completed");
                    maybeSummarizeStrips();
                    yield { kind: "done", finishReason: "completed", thinking: sawReasoning } as ParsedStreamEvent;
                } else if (type === "response.incomplete") {
                    yield* flushFilter();
                    yield* settleNamelessDiag();
                    terminalKind = "incomplete";
                    terminalRaw = rawBuf;
                    // #2904: a max-output truncation that left nothing visible is
                    // degenerate too (budget spent on reasoning before any
                    // prose/tool call). The completed branch already warns; the
                    // incomplete one did not — that gap is why #2904's
                    // reasoning-only length turns logged no degenerate signal.
                    const incDetails = (obj.response as Record<string, unknown> | undefined)?.incomplete_details as Record<string, unknown> | undefined;
                    maybeWarnDegenerate(typeof incDetails?.reason === "string" ? incDetails.reason : "incomplete");
                    yield { kind: "done", finishReason: "incomplete" } as ParsedStreamEvent;
                } else if (type === "response.failed" || type === "response.error") {
                    yield* flushFilter();
                    yield* settleNamelessDiag();
                    terminalKind = "failed";
                    terminalRaw = rawBuf;
                    yield { kind: "done", finishReason: "failed" } as ParsedStreamEvent;
                } else if (type.startsWith("response.reasoning")) {
                    // #1881: reasoning prose (summaries) streams through its own
                    // per-summary filter instead of the raw passthrough this
                    // used to fall into. firstRoundOnly keeps multi-round
                    // forwarding semantics unchanged — only the bytes are cleaned.
                    const rsDelta = typeof obj.delta === "string" ? obj.delta : "";
                    if (rsDelta.length > 0) {
                        const key = `${typeof obj.item_id === "string" ? obj.item_id : ""}:${typeof obj.summary_index === "number" ? obj.summary_index : 0}`;
                        let entry = reasoningFilters.get(key);
                        if (!entry) {
                            entry = {
                                filter: createIdentityStreamFilter(),
                                ref: {
                                    itemId: typeof obj.item_id === "string" ? obj.item_id : "",
                                    outputIndex: typeof obj.output_index === "number" ? obj.output_index : 0,
                                    summaryIndex: typeof obj.summary_index === "number" ? obj.summary_index : 0,
                                },
                            };
                            reasoningFilters.set(key, entry);
                        }
                        const clean = entry.filter.push(rsDelta);
                        if (clean.length > 0) {
                            const chunk = clean === rsDelta ? rawBuf : rebuildResponsesEvent(type, { ...obj, delta: clean });
                            yield { kind: "meta", chunk, firstRoundOnly: true } as ParsedStreamEvent;
                        }
                    } else {
                        // Unified ACP invariant: non-delta reasoning-summary
                        // events (.done with whole text) are thinking channel —
                        // byte-verbatim, no strip pass.
                        yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                    }
                } else {
                    yield { kind: "meta", chunk: rawBuf, firstRoundOnly: true } as ParsedStreamEvent;
                }
            }
            if (!terminalKind) {
                yield* settleNamelessDiag();
                yield { kind: "done", finishReason: "failed", truncated: true } as ParsedStreamEvent;
            }
        },

        emitText(delta) {
            return buildMessageItemSequence(proxyMessageItemId(outputIndex), outputIndex++, delta);
        },

        emitToolCall(call) {
            const buf = buildFunctionCallEvents(call, `fc-proxy-${Date.now()}-${outputIndex}`, outputIndex);
            outputIndex += 1;
            return buf;
        },

        emitMarker(toolName, result) {
            return buildMessageItemSequence(
                proxyMessageItemId(outputIndex),
                outputIndex++,
                buildVisibilityMarker(toolName, result),
            );
        },

        emitCompletion(opts?: EmitCompletionOpts) {
            if (terminalRaw && (terminalKind === "failed" || terminalKind === "incomplete")) {
                return terminalRaw;
            }
            if (!responseObj && opts?.finishReason === "failed") {
                const parts: Buffer[] = [];
                const created = ensureCreated();
                if (created) parts.push(created);
                const failed = {
                    id: createdRespId ?? `resp-error-${Date.now()}`,
                    status: "failed",
                    error: { code: "server_error", message: "upstream returned no response" },
                };
                parts.push(Buffer.from(
                    `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: failed })}\n\n`,
                    "utf8",
                ));
                return Buffer.concat(parts);
            }
            let resp = responseObj
                ? ({ ...responseObj } as Record<string, unknown>)
                : { id: `resp-proxy-${Date.now()}`, status: "completed", output: [] };
            if (opts?.usage) {
                const usage: Record<string, unknown> = {
                    ...(typeof (resp as Record<string, unknown>).usage === "object"
                        ? ((resp as Record<string, unknown>).usage as Record<string, unknown>)
                        : {}),
                };
                if (typeof opts.usage.inputTokens === "number") usage.input_tokens = opts.usage.inputTokens;
                if (typeof opts.usage.outputTokens === "number") usage.output_tokens = opts.usage.outputTokens;
                if (typeof opts.usage.cachedTokens === "number") {
                    usage.input_tokens_details = {
                        ...((usage.input_tokens_details as Record<string, unknown>) ?? {}),
                        cached_tokens: opts.usage.cachedTokens,
                    };
                }
                resp = { ...resp, usage };
            }
            return buildCompleted(resp);
        },

        emitError(message) {
            const parts: Buffer[] = [];
            const created = ensureCreated();
            if (created) parts.push(created);
            const resp = {
                id: createdRespId ?? `resp-error-${Date.now()}`,
                status: "failed",
                error: { code: "server_error", message },
            };
            parts.push(Buffer.from(
                `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: resp })}\n\n`,
                "utf8",
            ));
            return Buffer.concat(parts);
        },

        extractTextTriggers(text) {
            return extractResponsesTextTriggers(text);
        },
    };
}
