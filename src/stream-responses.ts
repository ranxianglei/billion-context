import type { CompressionCore, Config, CoreMessage } from "acp-kernel";
import type { Session } from "./session.js";
import { COMPRESS_TOOL_NAME, parseCompressInput, ACP_TEXT_OPEN, ACP_TEXT_CLOSE } from "./compress-tool.js";
import { applyRanges, type RewriteCtx } from "./stream.js";
import { normalizeSseLineEndings } from "./sse-util.js";

/** Text-protocol mode mirrors the server flag so the rewriter only does text
 *  trigger detection when the host cannot coexist with a declared `tools`
 *  array (e.g. OpenAI Codex code_mode). */
const TEXT_PROTOCOL = process.env.ACP_COMPRESS_PROTOCOL === "text";

/**
 * Responses API streaming event rewriter.
 *
 * The Responses API emits typed events keyed by `type`, NOT the chat
 * completions `choices[].delta` shape. Function calls arrive via separate
 * events:
 *   - response.output_item.added      (item: {type:function_call, name, call_id})
 *   - response.function_call_arguments.delta  (item_id, delta: partial json)
 *   - response.output_item.done
 *   - response.completed             (response object with finish status)
 *
 * Strategy: when we see a function_call whose name is COMPRESS_TOOL_NAME,
 * buffer its arguments and suppress all its events. At response.completed,
 * synthesize the compress result as a visible text delta + force a clean
 * finish, exactly like the OpenAI chat rewriter.
 */

type StreamState = {
    /** item_id of each compress function_call we are suppressing. */
    compressItemIds: Set<string>;
    /** accumulated arguments per compress item_id. */
    args: Record<string, string>;
    converted: boolean;
    sawRealTool: boolean;
    /** Snapshot of the response object from the terminal event, to reuse its id. */
    responseObj: Record<string, unknown> | null;
    done: boolean;
    /** latest emitted response sequence number (Responses events carry a `v` counter). */
    // --- text-protocol state ---
    /** Held-back output_text not yet safe to emit (may contain partial trigger). */
    textPending: string;
    /** Currently buffering a trigger between OPEN and CLOSE. */
    inTrigger: boolean;
    /** Accumulated trigger JSON content. */
    triggerBuf: string;
    /** Completed trigger payloads awaiting execution at end of stream. */
    triggerPayloads: string[];
};

function newState(): StreamState {
    return {
        compressItemIds: new Set(),
        args: {},
        converted: false,
        sawRealTool: false,
        responseObj: null,
        done: false,
        textPending: "",
        inTrigger: false,
        triggerBuf: "",
        triggerPayloads: [],
    };
}

/** Drain safe-to-emit text from the pending buffer, holding back any partial
 *  or complete trigger region. Completed triggers are pushed onto
 *  state.triggerPayloads for execution at stream end. */
function drainText(state: StreamState): string {
    let out = "";
    while (state.textPending) {
        if (!state.inTrigger) {
            const openIdx = state.textPending.indexOf(ACP_TEXT_OPEN);
            if (openIdx === -1) {
                // Hold back a tail in case a partial OPEN tag spans a delta.
                const holdLen = Math.min(ACP_TEXT_OPEN.length - 1, state.textPending.length);
                const cut = state.textPending.length - holdLen;
                out += state.textPending.slice(0, cut);
                state.textPending = state.textPending.slice(cut);
                break;
            }
            out += state.textPending.slice(0, openIdx);
            state.textPending = state.textPending.slice(openIdx + ACP_TEXT_OPEN.length);
            state.inTrigger = true;
        } else {
            const closeIdx = state.textPending.indexOf(ACP_TEXT_CLOSE);
            if (closeIdx === -1) {
                // Keep buffering trigger content; cap to avoid unbounded growth.
                const take = Math.min(state.textPending.length, 65536 - state.triggerBuf.length);
                state.triggerBuf += state.textPending.slice(0, take);
                state.textPending = state.textPending.slice(take);
                break;
            }
            const payload = state.triggerBuf + state.textPending.slice(0, closeIdx);
            state.triggerBuf = "";
            state.textPending = state.textPending.slice(closeIdx + ACP_TEXT_CLOSE.length);
            state.inTrigger = false;
            if (payload.trim()) state.triggerPayloads.push(payload.trim());
        }
    }
    return out;
}

export async function* rewriteResponsesSseStream(
    upstream: ReadableStream<Uint8Array>,
    ctx: RewriteCtx,
): AsyncGenerator<Buffer> {
    const reader = upstream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    const state = newState();
    let output = "";
    let eventNum = 0;
    const flush = (): Buffer => {
        const out = Buffer.from(output, "utf8");
        output = "";
        return out;
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            buf = normalizeSseLineEndings(buf);
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
                const rawEvent = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                eventNum++;
                const routed = routeResponsesEvent(rawEvent, state);
                if (ctx.debug) {
                    const dl = rawEvent.split("\n").find((l) => l.startsWith("data:"));
                    const data = dl ? dl.slice(5).trim() : "";
                    let summary = data.slice(0, 80);
                    try {
                        const obj = JSON.parse(data);
                        const t = obj.type ?? "?";
                        const it = obj.item;
                        if (it?.type === "function_call") summary = `${t} fn=${it.name}`;
                        else summary = `${t}`;
                    } catch {
                        /* best-effort */
                    }
                    ctx.log(`sse[${eventNum}] routed=${routed === null ? "SUPPRESS" : "pass"} | ${summary}`);
                }
                if (routed === null) continue;
                output += routed;
                if (output.length >= 8192) yield flush();
            }
        }
        output += buildResponsesTail(state, ctx);
        if (output) yield flush();
    } finally {
        reader.releaseLock();
    }
}

function routeResponsesEvent(rawEvent: string, state: StreamState): string | null {
    // The Responses API carries the event type in the SSE `event:` line, NOT
    // in the JSON data body (unlike chat completions which has no event
    // line and embeds everything in data). Parse both.
    const typeFromEvent = extractEventType(rawEvent);
    const dataLine = extractDataLine(rawEvent);
    if (dataLine === null) return rawEvent + "\n\n";
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(dataLine);
    } catch {
        return rawEvent + "\n\n";
    }
    const t = typeFromEvent ?? (obj.type as string | undefined);

    // A new output item appears. If it's a function_call named compress,
    // start suppressing it.
    if (t === "response.output_item.added" || t === "response.output_item.done") {
        const item = obj.item as { type?: string; name?: string; id?: string } | undefined;
        if (item?.type === "function_call") {
            if (typeof item.name === "string" && item.id) {
                if (item.name === COMPRESS_TOOL_NAME) {
                    state.compressItemIds.add(item.id);
                    state.converted = true;
                    return null;
                }
                state.sawRealTool = true;
            }
        }
        // Suppress the compress item's own added/done envelope entirely.
        if (item?.id && state.compressItemIds.has(item.id)) return null;
        return rawEvent + "\n\n";
    }

    // Incremental arguments for a function_call. Buffer compress ones, pass others.
    if (t === "response.function_call_arguments.delta") {
        const itemId = obj.item_id as string | undefined;
        if (itemId && state.compressItemIds.has(itemId)) {
            const frag = obj.delta as string | undefined;
            if (typeof frag === "string") state.args[itemId] = (state.args[itemId] ?? "") + frag;
            return null;
        }
        return rawEvent + "\n\n";
    }

    // Text-protocol: buffer ALL output_text deltas, suppress streaming, and
    // process the full text once at stream end. This sacrifices streaming for
    // correctness (trigger may span deltas; completion ordering). Acceptable
    // for the feasibility test.
    if (TEXT_PROTOCOL && t === "response.output_text.delta") {
        const delta = obj.delta as string | undefined;
        if (typeof delta === "string") state.textPending += delta;
        return null;
    }
    if (TEXT_PROTOCOL && t === "response.output_text.done") {
        return null;
    }

    // Terminal event: capture the response object so we can forge a clean tail.
    if (t === "response.completed" || t === "response.incomplete") {
        state.responseObj = (obj.response as Record<string, unknown>) ?? null;
        state.done = true;
        // In text protocol we always re-emit completed at the tail (after
        // flushing buffered text + executing triggers).
        if (TEXT_PROTOCOL) return null;
        if (!state.converted) return rawEvent + "\n\n";
        return null;
    }

    return rawEvent + "\n\n";
}

function buildResponsesTail(state: StreamState, ctx: RewriteCtx): string {
    let out = "";
    // Text protocol: drain buffered text (splitting out any trigger), execute
    // triggers, then re-emit completion. Runs even without a trigger so the
    // buffered text is flushed and a clean completed is emitted.
    if (TEXT_PROTOCOL) {
        const safeText = drainText(state);
        if (safeText) {
            out += sse("response.output_text.delta", { item_id: "msg_acp", output_index: 0, delta: safeText });
        }
        if (state.triggerPayloads.length > 0) {
            for (const payload of state.triggerPayloads) {
                let parsed: unknown = {};
                try {
                    parsed = JSON.parse(payload);
                } catch {
                    ctx.log(`text-trigger: malformed JSON payload, skipping`);
                    continue;
                }
                const note = applyRanges(parseCompressInput(parsed), ctx);
                ctx.log(`text-trigger: executed compress → ${note.split("\n")[0].slice(0, 80)}`);
                out += sse("response.output_text.delta", { item_id: "msg_acp_note", output_index: 0, delta: "\n" + note + "\n" });
            }
        }
        const base = (state.responseObj ?? { id: "resp_acp" }) as Record<string, unknown>;
        const respId = typeof base.id === "string" ? base.id : "resp_acp";
        out += sse("response.completed", { response: { ...base, id: respId, status: "completed", output: [] } });
        return out;
    }
    if (!state.converted) return "";
    const base = (state.responseObj ?? { id: "resp_acp" }) as Record<string, unknown>;
    const respId = typeof base.id === "string" ? base.id : "resp_acp";
    const ids = [...state.compressItemIds];
    for (const itemId of ids) {
        const raw = state.args[itemId] ?? "";
        let parsed: unknown = {};
        try {
            parsed = raw ? JSON.parse(raw) : {};
        } catch {
            parsed = {};
        }
        const note = applyRanges(parseCompressInput(parsed), ctx);
        // Emit the compress result as a visible text delta so the client
        // (Codex) renders it as an assistant message.
        out += sse("response.output_text.delta", { item_id: itemId, output_index: 0, delta: note + "\n" });
        out += sse("response.output_text.done", { item_id: itemId, output_index: 0, text: note + "\n" });
    }
    out += sse("response.completed", {
        response: {
            ...base,
            id: respId,
            status: "completed",
            output: [],
        },
    });
    return out;
}

function sse(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function extractDataLine(rawEvent: string): string | null {
    const lines = rawEvent.split("\n");
    for (const l of lines) {
        if (l.startsWith("data:")) {
            return l.slice(5).trim();
        }
    }
    return null;
}

function extractEventType(rawEvent: string): string | null {
    const lines = rawEvent.split("\n");
    for (const l of lines) {
        if (l.startsWith("event:")) {
            return l.slice(6).trim();
        }
    }
    return null;
}

function safeJsonParse(s: string): unknown {
    try {
        return s ? JSON.parse(s) : {};
    } catch {
        return {};
    }
}

export function rewriteResponsesJsonResponse(body: unknown, ctx: RewriteCtx): unknown {
    if (!body || typeof body !== "object") return body;
    const b = body as {
        output?: Array<Record<string, unknown>>;
        status?: string;
    };
    if (!Array.isArray(b.output)) return body;
    let converted = false;
    let sawReal = false;
    const noteParts: string[] = [];
    const keep: Record<string, unknown>[] = [];
    for (const item of b.output) {
        if (item.type === "function_call" && item.name === COMPRESS_TOOL_NAME) {
            converted = true;
            noteParts.push(applyRanges(parseCompressInput(safeJsonParse(String(item.arguments ?? ""))), ctx));
        } else {
            if (item.type === "function_call") sawReal = true;
            keep.push(item);
        }
    }
    if (!converted) return body;
    const note = noteParts.join("\n");
    if (note) {
        keep.unshift({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: note }],
        });
    }
    b.output = keep;
    if (!sawReal) b.status = "completed";
    return body;
}

export type { CompressionCore, Config, CoreMessage, Session };
