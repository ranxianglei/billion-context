import { randomUUID } from "node:crypto";

// #2411 Stage B: local forge for host-native compaction requests on the openai
// lane (TRAE Code / unified Trae client). When the host fires its own auto-compact
// it sends its ~6.9KB summarization template as the LAST user message on the
// normal chat endpoint; bili intercepts that request (nativeCompact predicate,
// src/server/native-compact-shape.ts) and serves its OWN fold summaries as the
// completion — upstream never contacted (zero-egress contract, same class as
// codexForge). E2 capture (reporter, #2411 floor 36): the backend's response to
// this request shape is an ORDINARY chat completion — no private progress
// frames, no pseudo-tool events, terminal shape = final data frame with
// finish_reason:"stop" + usage followed by `data: [DONE]`. So the forge is a
// standard chat.completion / chat.completion.chunk pair, nothing more. The
// id prefix marks bili-forged completions for downstream greps, mirroring
// codex's fc_bili_ sentinel.

export const OPENAI_COMPACT_ID_PREFIX = "chatcmpl_bili_";

interface OpenaiForgeUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

function usageJson(u: OpenaiForgeUsage): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
    return { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.totalTokens };
}

export function buildOpenaiCompactForgeBody(
    summaryText: string,
    model: string,
    usage: OpenaiForgeUsage,
    stream: boolean,
): { body: string; contentType: string } {
    const id = `${OPENAI_COMPACT_ID_PREFIX}${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    if (!stream) {
        const body = JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model,
            choices: [{ index: 0, message: { role: "assistant", content: summaryText }, finish_reason: "stop" }],
            usage: usageJson(usage),
        });
        return { body, contentType: "application/json" };
    }
    const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const base = { id, object: "chat.completion.chunk" as const, created, model };
    let body = "";
    body += frame({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    body += frame({ ...base, choices: [{ index: 0, delta: { content: summaryText }, finish_reason: null }] });
    body += frame({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "stop" }], usage: usageJson(usage) });
    body += "data: [DONE]\n\n";
    return { body, contentType: "text/event-stream" };
}
