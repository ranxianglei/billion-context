import type http from "node:http";

/**
 * Emit a minimal SSE error + finish sequence so a streaming client sees the
 * failure and ends cleanly, instead of a bare socket close.
 *
 * WHY: server.ts forward() routes streams through protocol rewriters
 * (runCompressLoop / the tag-echo passthrough pipes). If a
 * rewriter throws (e.g. executeProxyTool hits an edge case, JSON.parse fails),
 * the `for await` loop aborts and — without this — `res.end()` is skipped,
 * leaving the client with a truncated stream and no finish event. The request
 * handler wraps each loop in try/catch and calls this on failure.
 *
 * Format per protocol (#1455 default = protocol-native failure frames, same
 * shapes as emitPreflightError/emitUpstreamTruncation):
 *  - openai:    top-level `error` in a data frame, then `[DONE]`.
 *  - anthropic: `event: error` (the SDK's standard API-error channel).
 *  - responses: `event: error` (Responses SSE spec).
 *  - google:    an in-stream `{"error":{code,message,status}}` frame — Gemini's
 *               own error channel, which its SDK throws on; the stream then
 *               ends (there is no separate terminal byte to synthesize).
 * compat.streamErrorShape="completion" restores the legacy shapes (failure text
 * delivered inside a synthesized successful completion), for hosts whose SDK
 * cannot surface an in-band error event.
 *
 * Best-effort: if writing the error itself throws (client already gone), we
 * still attempt res.end(). Never throws.
 */

type Protocol = "anthropic" | "openai" | "responses" | "google";

function safeWrite(res: http.ServerResponse, chunk: string): void {
    try {
        res.write(chunk);
    } catch {
        /* client gone */
    }
}

// #1455: protocol-native failure frames — same shapes as emitPreflightError
// (#568) / emitUpstreamTruncation (#721). A mid-stream failure must reach the
// client on the error channel, never as a synthesized successful completion
// (that silences client retry logic — see the loop adapters' emitError).
function nativeErrorChunk(protocol: Protocol, message: string): string {
    if (protocol === "openai") {
        return `data: ${JSON.stringify({ error: { type: "server_error", code: "stream_error", message } })}\n\ndata: [DONE]\n\n`;
    }
    if (protocol === "responses") {
        return `event: error\ndata: ${JSON.stringify({ type: "error", code: "stream_error", message })}\n\n`;
    }
    if (protocol === "google") {
        // Gemini's error object is `{code: number, message, status}` — a
        // numeric code + gRPC-style status, no free-form `type`.
        return `data: ${JSON.stringify({ error: { code: 500, message, status: "INTERNAL" } })}\n\n`;
    }
    return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "server_error", code: "stream_error", message } })}\n\n`;
}

/** #2689: caller-known state of the anthropic stream a legacy completion
 *  chunk lands in — `blockIndex` is the next free content-block index (the
 *  caller already forwarded that many blocks to the client), `messageStarted`
 *  whether the client already received the message_start that owns them. */
interface LegacyAnthropicState {
    blockIndex?: number;
    messageStarted?: boolean;
}

// Legacy shapes (#1455 opt-out via compat.streamErrorShape="completion"): the
// failure text delivered INSIDE a successful completion. Kept for hosts whose
// SDK cannot surface an in-band error event.
function legacyCompletionChunk(protocol: Protocol, visible: string, state?: LegacyAnthropicState): string {
    if (protocol === "openai") {
        return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: visible }, finish_reason: null }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
            `data: [DONE]\n\n`;
    }
    if (protocol === "responses") {
        // Responses requires a full item lifecycle: output_item.added →
        // content_part.added → output_text.delta → …done → item.done →
        // completed. A bare delta (the old shape) is orphan + malformed
        // (no item_id) and crashes strict clients (codex/gpt-5-codex).
        const itemId = "msg_acp_error";
        const oi = 0;
        const errorItem = { type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text: visible }] };
        return `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: oi, item: { type: "message", id: itemId, role: "assistant", content: [] } })}\n\n` +
            `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", item_id: itemId, output_index: oi, part: { type: "output_text", text: "" } })}\n\n` +
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: itemId, output_index: oi, delta: visible })}\n\n` +
            `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: itemId, output_index: oi, text: visible })}\n\n` +
            `event: response.content_part.done\ndata: ${JSON.stringify({ type: "response.content_part.done", item_id: itemId, output_index: oi, part: { type: "output_text", text: visible } })}\n\n` +
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: oi, item: errorItem })}\n\n` +
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [errorItem] } })}\n\n`;
    }
    if (protocol === "google") {
        return `data: ${JSON.stringify({ error: { code: 500, message: visible, status: "INTERNAL" } })}\n\n`;
    }
    // #2689: strict clients validate the full Anthropic SSE lifecycle — the old
    // bare delta had no numeric index and no owning block (orphan), so
    // schema-validating hosts rejected the whole turn (ZCode). Mirror the
    // compress-loop adapter's #413 pattern: synthesize message_start when the
    // stream never began, then a complete text-block lifecycle at the caller's
    // next free index (same shapes as buildSyntheticMessageStart/buildTextBlock).
    const blockIndex = state?.blockIndex ?? 0;
    const parts: string[] = [];
    if (!state?.messageStarted) {
        parts.push(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: `msg_acp_error_${Date.now()}`, type: "message", role: "assistant", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
    }
    parts.push(
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: visible } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    );
    return parts.join("");
}

export function emitStreamError(res: http.ServerResponse, protocol: Protocol, message: string, log?: (msg: string) => void, errorShape: "protocol" | "completion" = "protocol", state?: LegacyAnthropicState): void {
    const visible = `\n\u274C [ACP] stream error: ${message}`;
    log?.(`[acp-proxy: stream aborted mid-response: ${message}]`);
    const chunk = errorShape === "protocol"
        ? nativeErrorChunk(protocol, `[acp-proxy: ${message}]`)
        : legacyCompletionChunk(protocol, visible, state);
    try {
        safeWrite(res, chunk);
    } catch {
        /* best-effort */
    } finally {
        try {
            res.end();
        } catch {
            /* already closed */
        }
    }
}

/**
 * #721: the upstream stream ended without a terminal event — clean EOF with
 * no [DONE] / message_stop / completed-family event, or a read failure while
 * the client is still connected. Without intervention the client sees a bare
 * cut-off SSE and persists the partial turn as complete (the #719 chain).
 * Two shapes:
 *  - finished=true: a finish reason WAS delivered (OpenAI finish_reason chunk
 *    / Anthropic message_delta stop_reason); only the final terminal byte was
 *    lost → synthesize just that byte (silent completion).
 *  - finished=false: true mid-generation cut → protocol-native in-band error
 *    event, same shapes as emitPreflightError (#568): openai top-level `error`
 *    data frame + [DONE]; anthropic/responses `event: error`; google an
 *    `{"error":{code,message,status}}` frame. A fabricated
 *    response.failed lifecycle object is deliberately avoided — the pipe does
 *    not track the full output-item list, and strict clients (codex) crash on
 *    half-consistent terminal payloads (see emitStreamError). The responses
 *    wire has no separate finish-reason concept (terminal events carry the
 *    status), so !sawTerminal ⇒ finished=false always there. Gemini has the
 *    mirror-image property: its terminal event IS the finishReason chunk, so
 *    finished=true leaves nothing to synthesize (and finished=false is the
 *    only reachable case from a pipe that treats that chunk as terminal).
 *  - transparent=true (finished=false only): #2563 host-owned handling — the
 *    session's plugin host is on the evidence permitlist of hosts proven to
 *    classify a bare truncated SSE as a transient failure they retry
 *    themselves. No frame is synthesized; the partial stream ends clean so
 *    the host's native classifier decides. The diag still rides the log line
 *    (it just does not reach the wire).
 * Never throws.
 */
/** #2328 Q2: termination diagnostics carried on the in-band truncation
 *  error frame (`meta`) and in the log line, so "the upstream never sent a
 *  terminal event" (#721's no-terminal-seen) and "a terminal was arriving but
 *  its bytes never completed / were unrecognizable" can be told apart from
 *  the client side (#2347 forensics). Every field is plain-JSON safe. */
export interface TruncationDiag {
    /** Which pipe path fired: clean EOF without a terminal, or a read error. */
    cause: "eof" | "read-error";
    /** Q4 classification — see the helpers in plugin.ts that build this. */
    classification: "no-terminal-seen" | "terminal-bytes-unrecognized";
    /** Wire protocol of the truncated stream. */
    protocol: string;
    /** Parsed SSE events (incl. [DONE] frames; excl. unparseable raw forwards). */
    events: number;
    /** Frames forwarded verbatim because JSON.parse failed (#2190 audit twin). */
    unparseableForwarded: number;
    /** Sum of decoded upstream bytes across the whole stream. */
    bytes: number;
    /** Last ≤5 parsed event labels, oldest first (wire-native `type`, or a
     *  synthesized `chunk`/`chunk:finish=<r>` for wires without one). */
    lastEventTypes: string[];
    /** Dangling partial event left in the normalize buffer at EOF/cut. */
    eofBufferBytes: number;
    /** First ≤80 chars of that dangling buffer, newlines flattened. */
    eofBufferHead?: string;
    /** Finish reason already delivered before the cut (chat wires), if any. */
    finishReason?: string;
    /** Responses wire: status of the last completion-family frame, if any. */
    responseStatus?: string;
    /** Post-filter visible chars the client actually assembled. */
    visibleChars: number;
    /** The tag filter stripped echo markup somewhere in this stream. */
    sawStrippedEcho: boolean;
    /** The one-shot #2171 re-issue was already spent earlier in this request. */
    retryZeroByteCutSpent: boolean;
    /** The one-shot #732/#821 degenerate-turn re-issue was already spent. */
    retryDegenerateSpent: boolean;
    /** Held done-family frames still buffered at the cut (responses wire). */
    heldEvents?: number;
    /** Upstream HTTP status / content-type of the original response, when the
     *  caller still holds them (plugin lane re-fetches lose them by design). */
    upstreamStatus?: number;
    upstreamContentType?: string;
}

export function emitUpstreamTruncation(res: http.ServerResponse, protocol: Protocol, finished: boolean, log?: (msg: string) => void, diag?: TruncationDiag, transparent = false): void {
    const message = "upstream stream ended before a completion event; this turn may be incomplete";
    const action = finished
        ? protocol === "google" ? "finish reason already delivered, stream complete" : "finish reason seen, synthesizing missing terminal byte"
        : transparent ? "passing through raw (host owns truncation handling, #2563)" : "emitting in-band error";
    // #2328: the diag blob rides the log line too — one grep for
    // `upstream stream truncated` pulls the full classification + counters
    // without needing the client-side error frame.
    log?.(`[acp-proxy: upstream stream truncated (${protocol}) — ${action}${diag ? `; classification=${diag.classification} cause=${diag.cause}; diag=${JSON.stringify(diag)}` : ""}]`);
    // #2328: attach the diagnostics as `meta` on the in-band error object.
    // Wire-shape change (new field on an error-only frame) — human-merge item.
    const metaField = diag === undefined ? {} : { meta: diag };
    try {
        if (transparent && !finished) {
            // #2563: host-owned handling — deliver exactly what arrived
            // (clean end, nothing synthesized) and let the host's native
            // classifier take over.
        } else if (protocol === "openai") {
            if (finished) {
                safeWrite(res, "data: [DONE]\n\n");
            } else {
                safeWrite(res, `data: ${JSON.stringify({ error: { type: "server_error", code: "upstream_stream_truncated", message, ...metaField } })}\n\ndata: [DONE]\n\n`);
            }
        } else if (protocol === "responses") {
            safeWrite(res, `event: error\ndata: ${JSON.stringify({ type: "error", code: "upstream_stream_truncated", message, ...metaField })}\n\n`);
        } else if (protocol === "google") {
            // The finishReason chunk IS Gemini's stream terminator: when it was
            // delivered, the client is already done and an extra terminal
            // object would read as a second answer. Only the mid-flight cut
            // needs the error frame (503/UNAVAILABLE — an upstream-cut stream).
            if (!finished) safeWrite(res, `data: ${JSON.stringify({ error: { code: 503, message, status: "UNAVAILABLE", ...metaField } })}\n\n`);
        } else {
            if (finished) {
                safeWrite(res, `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
            } else {
                safeWrite(res, `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "server_error", code: "upstream_stream_truncated", message, ...metaField } })}\n\n`);
            }
        }
    } catch {
        /* best-effort */
    } finally {
        try {
            res.end();
        } catch {
            /* already closed */
        }
    }
}

/**
 * #568: deliver a preflight fail-fast error IN-BAND, after the proxy already
 * committed `200` early to hold the client through a long compression (see
 * beginPreflightHold in server.ts). The status line can no longer change, so
 * the failure rides on a protocol-native error event:
 *  - openai:    top-level `error` in a data frame, then `[DONE]`.
 *  - anthropic: `event: error` (the SDK's standard API-error channel).
 *  - responses: `event: error` (Responses SSE spec).
 *  - google:    an `{"error":{code,message,status}}` frame; the retryability
 *               survives as the numeric-code/status pair (503 UNAVAILABLE vs
 *               500 INTERNAL), Gemini having no free-form `type` field.
 * Never throws.
 */
export function emitPreflightError(res: http.ServerResponse, protocol: Protocol, error: { message: string; retryable: boolean }, log?: (msg: string) => void): void {
    const err = { type: "server_error", code: "preflight_compress_failed", message: error.message, retryable: error.retryable };
    log?.(`[acp-proxy: preflight failed after early response commit — delivering in-band: ${error.message}]`);
    try {
        if (protocol === "openai") {
            safeWrite(res, `data: ${JSON.stringify({ error: err })}\n\ndata: [DONE]\n\n`);
        } else if (protocol === "responses") {
            safeWrite(res, `event: error\ndata: ${JSON.stringify({ type: "error", code: err.code, message: err.message })}\n\n`);
        } else if (protocol === "google") {
            safeWrite(res, `data: ${JSON.stringify({ error: { code: error.retryable ? 503 : 500, message: error.message, status: error.retryable ? "UNAVAILABLE" : "INTERNAL" } })}\n\n`);
        } else {
            safeWrite(res, `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "server_error", code: err.code, message: err.message } })}\n\n`);
        }
    } catch {
        /* best-effort */
    } finally {
        try {
            res.end();
        } catch {
            /* already closed */
        }
    }
}
