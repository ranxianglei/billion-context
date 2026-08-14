import type http from "node:http";

/**
 * Emit a minimal SSE error + finish sequence so a streaming client sees the
 * failure and ends cleanly, instead of a bare socket close.
 *
 * WHY: server.ts forward() routes streams through protocol rewriters
 * (rewriteSseStream / runCompressLoop). If a
 * rewriter throws (e.g. executeProxyTool hits an edge case, JSON.parse fails),
 * the `for await` loop aborts and — without this — `res.end()` is skipped,
 * leaving the client with a truncated stream and no finish event. The request
 * handler wraps each loop in try/catch and calls this on failure.
 *
 * Format per protocol:
 *  - openai:    a `choices[].delta` with the error text, then a `finish_reason:
 *               "stop"` chunk, then `data: [DONE]`.
 *  - anthropic: a `content_block_delta` text_delta, then `message_stop`.
 *  - responses: `response.output_text.delta`, then `response.completed`.
 *
 * Best-effort: if writing the error itself throws (client already gone), we
 * still attempt res.end(). Never throws.
 */

type Protocol = "anthropic" | "openai" | "responses";

function safeWrite(res: http.ServerResponse, chunk: string): void {
    try {
        res.write(chunk);
    } catch {
        /* client gone */
    }
}

export function emitStreamError(res: http.ServerResponse, protocol: Protocol, message: string, log?: (msg: string) => void): void {
    const visible = `\n\u274c [ACP] stream error: ${message}`;
    log?.(`[acp-proxy: stream aborted mid-response: ${message}]`);
    try {
        if (protocol === "openai") {
            safeWrite(res, `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: visible }, finish_reason: null }] })}\n\n`);
            safeWrite(res, `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
            safeWrite(res, "data: [DONE]\n\n");
        } else if (protocol === "responses") {
            // Responses requires a full item lifecycle: output_item.added →
            // content_part.added → output_text.delta → …done → item.done →
            // completed. A bare delta (the old shape) is orphan + malformed
            // (no item_id) and crashes strict clients (codex/gpt-5-codex).
            const itemId = "msg_acp_error";
            const oi = 0;
            const errorItem = { type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text: visible }] };
            safeWrite(res, `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: oi, item: { type: "message", id: itemId, role: "assistant", content: [] } })}\n\n`);
            safeWrite(res, `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", item_id: itemId, output_index: oi, part: { type: "output_text", text: "" } })}\n\n`);
            safeWrite(res, `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: itemId, output_index: oi, delta: visible })}\n\n`);
            safeWrite(res, `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: itemId, output_index: oi, text: visible })}\n\n`);
            safeWrite(res, `event: response.content_part.done\ndata: ${JSON.stringify({ type: "response.content_part.done", item_id: itemId, output_index: oi, part: { type: "output_text", text: visible } })}\n\n`);
            safeWrite(res, `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: oi, item: errorItem })}\n\n`);
            safeWrite(res, `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [errorItem] } })}\n\n`);
        } else {
            // anthropic
            safeWrite(res, `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: visible } })}\n\n`);
            safeWrite(res, `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`);
            safeWrite(res, `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
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
