import type http from "node:http";

/**
 * Emit a minimal SSE error + finish sequence so a streaming client sees the
 * failure and ends cleanly, instead of a bare socket close.
 *
 * WHY: server.ts forward() routes streams through protocol rewriters
 * (rewriteSseStream / compressLoopStream / compressLoopResponsesStream). If a
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
            safeWrite(res, `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: visible })}\n\n`);
            safeWrite(res, `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`);
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
