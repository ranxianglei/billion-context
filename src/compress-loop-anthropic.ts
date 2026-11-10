// #5957: non-stream Anthropic Messages proxy-tool loop.
//
// stream:true runs runCompressLoop (src/loop/core.ts): it executes every
// proxy-owned tool server-side, feeds the result back as a tool_result, and
// re-requests until the model yields text or a real client tool call
// (reRequest = proxyResults.length > 0 && realCalls === 0, core.ts:1531).
// stream:false previously ran a ONE-SHOT rewriter (stream.ts rewriteJsonSteps)
// that replaced each proxy tool_use with its result text and set
// stop_reason "end_turn" when no client tool call was present — so a compress
// round ended the client turn with the receipt and the model never saw the
// fold result. Anthropic analogue of #4019 / PR #4037 (OpenAI chat-completions).
//
// Per round (the gate mirrors the streaming decision):
//   no proxy tool_use            -> terminal: return unrewritten; the relay's
//                                   one-shot rewriter finishes the turn (tag
//                                   strip, receipts).
//   proxy + real client tool_use -> terminal: same — the one-shot rewriter
//                                   executes the proxy calls, surfaces them as
//                                   text blocks, keeps the real calls, and does
//                                   NOT re-request (mirrors the realCalls === 0
//                                   gate).
//   proxy tool_use only          -> execute through the SAME executors the
//                                   one-shot rewriter uses (raw result text, so
//                                   the model-facing carrier matches the stream
//                                   lane), append the original assistant content
//                                   plus a tool_result user turn to the forwarded
//                                   body, and re-request so the model sees the
//                                   result.
// Bounded by MAX_LOOP_ROUNDS; at the limit the last response falls through to
// the one-shot rewriter — bounded degradation identical to the pre-fix shape,
// never undeclared proxy tool_use handed to the client. Each upstream response
// is executed by exactly ONE executor (this loop or the one-shot rewriter), so
// no call is ever run twice.
//
// Like #4037 the re-request resends the UNFOLDED body; the fold materializes on
// the next client request (prefix-cache friendly). The continuation always ends
// on the tool_result USER turn (#5605: never an assistant prefill), and the
// replayed assistant turn carries its content verbatim — signed thinking blocks
// included (KDD #10).
//
// No visibility markers on this lane: the non-stream tag-echo strip removes
// marker lines from any text block, so a prepended marker would surface as an
// empty text block. The model-facing carrier is the tool_result itself.

import { MAX_LOOP_ROUNDS } from "./loop/index.js";
import { isProxyToolFor } from "./absorb.js";
import { withSessionLock } from "./session.js";
import { drainPendingRetrievals } from "./store.js";
import { fetchWithRetry, UpstreamHttpError } from "./fetch-util.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import { COMPRESS_TOOL_NAME } from "./compress-tool.js";
import { applyConfiguredCompression } from "./external-summary-compress.js";
import { executeAnthropicProxyTool, type RewriteCtx } from "./stream.js";

interface Block {
    type?: string;
    name?: string;
    id?: string;
    input?: unknown;
}

interface CompressLoopAnthropicOptions {
    signal?: AbortSignal;
    /** Resolved upstream proxy URL (http://host:port) or undefined for direct. */
    proxyUrl?: string;
}

interface CompressLoopAnthropicRequestOptions {
    url: string;
    headers: Record<string, string>;
    /** Final-stage wire transform (compat.roles, #552) — same contract as the
     *  unified loop's RequestOptions.wireTransform. */
    wireTransform?: (body: Record<string, unknown>) => Record<string, unknown>;
    /** #1884: re-sign hook for the armed tunnel — same contract as the unified
     *  loop's RequestOptions.resign (loop/core.ts). */
    resign?: (headers: Record<string, string>, body: string | Buffer) => void;
    /** #6003 phase 2: user egress-transform pipeline hook — runs after the round
     *  body is built and before resign so the signature covers shipped bytes.
     *  undefined when unconfigured (exact no-op). */
    egress?: (body: string | Buffer) => Promise<string | Buffer>;
}

export async function compressLoopAnthropicJson(
    initialResponse: Record<string, unknown>,
    ctx: RewriteCtx,
    options: CompressLoopAnthropicOptions,
    requestBody: Record<string, unknown>,
    requestOptions: CompressLoopAnthropicRequestOptions,
): Promise<Record<string, unknown>> {
    const { session, config, log } = ctx;
    let current = initialResponse;
    interface ProxyCall { id?: string; name: string; input: Record<string, unknown> }
    for (let round = 1; round <= MAX_LOOP_ROUNDS; round++) {
        const content = Array.isArray(current.content) ? (current.content as Block[]) : [];
        const proxyCalls: ProxyCall[] = [];
        let sawRealToolUse = false;
        for (const b of content) {
            if (b.type !== "tool_use") continue;
            if (typeof b.name === "string" && isProxyToolFor(b.name, session, config)) {
                proxyCalls.push({ id: b.id, name: b.name, input: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown> });
            } else {
                sawRealToolUse = true;
            }
        }
        // Re-request only on proxy-only rounds (core.ts:1531 gate). A mixed or
        // tool-free response returns here unrewritten; the relay's one-shot
        // rewriter then applies the pre-fix behavior.
        if (proxyCalls.length === 0 || sawRealToolUse) break;
        // Limit hit on a still-proxy-only response: do NOT execute here — the
        // one-shot rewriter below performs the single execution (receipt +
        // end_turn, the pre-fix shape). Executing now would double-run it.
        if (round >= MAX_LOOP_ROUNDS) {
            log(`[compress-loop-limit] ${session.id} hit MAX_LOOP_ROUNDS (${MAX_LOOP_ROUNDS}) on non-stream anthropic proxy loop; deferring to the one-shot rewriter`);
            break;
        }
        // rewriteJsonSteps maps every block 1:1, so the original array is the
        // exact replay of this response's assistant turn (thinking blocks
        // verbatim, KDD #10).
        const original = structuredClone(content);
        // Same executors the one-shot rewriter uses (rewriteJsonResponseAsync):
        // compress routes through applyConfiguredCompression, everything else
        // through executeAnthropicProxyTool. Raw result text rides the
        // tool_result below — the model-facing carrier matches the stream lane.
        const results: string[] = [];
        for (const call of proxyCalls) {
            const res = await withSessionLock(session, () => call.name === COMPRESS_TOOL_NAME
                ? applyConfiguredCompression(call.input, ctx, call.id, options.signal)
                : Promise.resolve(executeAnthropicProxyTool(call.name, call.input, ctx)));
            results.push(res.text);
        }
        // #1097: retrieval injections ride the re-request after their ack
        // (same channel as the streaming loop, core.ts:1467). Decompress/retrieve
        // results already carry theirs inline (executeAnthropicProxyTool), so
        // this sweep only picks up what the executor did not drain.
        const injections = drainPendingRetrievals(session);
        const userTurn: Array<Record<string, unknown>> = proxyCalls.map((call, i) => ({ type: "tool_result", tool_use_id: call.id ?? "", content: results[i] }));
        for (const inj of injections) userTurn.push({ type: "text", text: inj.text });
        const messages = Array.isArray(requestBody.messages) ? [...(requestBody.messages as unknown[])] : [];
        requestBody.messages = [
            ...messages,
            { role: "assistant", content: original },
            { role: "user", content: userTurn },
        ];
        let roundBody: string | Buffer = JSON.stringify(requestOptions.wireTransform ? requestOptions.wireTransform(requestBody) : requestBody);
        // #6003 phase 2: user egress-transform pipeline before the re-sign so the
        // signature covers the shipped bytes.
        if (requestOptions.egress) roundBody = await requestOptions.egress(roundBody);
        requestOptions.resign?.(requestOptions.headers, roundBody);
        log(`[acp-proxy: non-stream anthropic proxy-tool round ${round}; re-requesting so the model sees the result]`);
        const result = await fetchWithRetry(
            requestOptions.url,
            { method: "POST", headers: requestOptions.headers, body: roundBody, ...(options.proxyUrl ? { dispatcher: proxyDispatcher(options.proxyUrl) } : {}) },
            undefined,
            options.signal,
        ).catch((e) => {
            if (e instanceof UpstreamHttpError) log(`[acp-proxy: non-stream anthropic loop upstream error ${e.status}: ${e.body.slice(0, 200)}]`);
            throw e;
        });
        try {
            current = (await result.response.json()) as Record<string, unknown>;
        } finally {
            result.clearTimer();
        }
    }
    return current;
}
