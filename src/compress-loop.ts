import {
    buildStatusReport,
    collectBlockContent,
    deactivateBlock,
    estimateTokensFast,
    type CompressionCore,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Session } from "./session.js";
import { parseCompressInput, PROXY_TOOL_NAMES } from "./compress-tool.js";
import { applyRanges } from "./stream.js";
import { fetchWithTimeout } from "./fetch-util.js";
import { normalizeSseLineEndings } from "./sse-util.js";

interface CompressLoopCtx {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
}

interface RequestOptions {
    url: string;
    headers: Record<string, string>;
}

interface ToolCallAccumulator {
    index: number;
    id: string;
    name: string;
    arguments: string;
}

function executeProxyTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: CompressLoopCtx,
): string {
    if (toolName === "compress") {
        return applyRanges(parseCompressInput(args), ctx);
    }
    if (toolName === "decompress") {
        const rawBlockId = args.blockId;
        if (typeof rawBlockId !== "string" || rawBlockId.length === 0) {
            return "[decompress FAILED: blockId is required]";
        }
        const blockId = rawBlockId.trim();
        const block = ctx.core.decompress(blockId, ctx.session.state);
        if (!block) return `[Block ${blockId} not found]`;
        const full = args.full === true;
        const collected = collectBlockContent(ctx.session.state, block, ctx.messages, { full });
        ctx.session.state = deactivateBlock(ctx.session.state, [blockId]);
        const header = `[Restored block ${blockId} — ${collected.count} item(s)${full ? ", full" : ""}]`;
        const body = collected.text || block.summary;
        // Security: never honor args.toFile in proxy mode — it is an
        // untrusted path from the model/client and enables path traversal
        // (e.g. overwriting ~/.bashrc or project source). Always write to a
        // temp dir when the body is large.
        const safeBlockId = blockId.replace(/[^a-zA-Z0-9_-]/g, "-");
        const outPath = body.length > 10000 ? join(tmpdir(), `acp-decompress-${safeBlockId}-${Date.now()}.txt`) : null;
        if (outPath) {
            try {
                mkdirSync(dirname(outPath), { recursive: true });
                writeFileSync(outPath, body, "utf8");
                return `${header}\nContent (${body.length} chars) written to: ${outPath}\nUse the read tool to access it.`;
            } catch (e) {
                return `${header}\n[Failed to write to ${outPath}: ${String(e)}]\n${body.slice(0, 4000)}...`;
            }
        }
        return `${header}\n${body}`;
    }
    if (toolName === "search_context") {
        const query = typeof args.query === "string" ? args.query : "";
        if (query.length === 0) return "[search_context FAILED: query is required]";
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
        const blocks = ctx.core.search(query, ctx.session.state).slice(0, limit);
        if (blocks.length === 0) return `[No blocks matched "${query}"]`;
        const lines = blocks.map((b) => {
            const topic = b.topic ?? "(no topic)";
            const preview = b.summary.length > 200 ? b.summary.slice(0, 200) + "..." : b.summary;
            return `${b.blockId} (T${b.tier}) "${topic}"\n  ${preview}`;
        });
        return `Found ${blocks.length} block(s) for "${query}":\n\n${lines.join("\n\n")}`;
    }
    if (toolName === "acp_status") {
        return buildStatusReport(ctx.session.state, ctx.messages, estimateTokensFast);
    }
    return `[Unknown proxy tool: ${toolName}]`;
}

interface EventDisposition {
    yieldChunk?: Buffer;
    contentDelta?: string;
    finishReason?: string;
    usage?: Record<string, unknown> | null;
    done?: boolean;
    toolCalls?: ToolCallAccumulator[];
}

function classifySseEvent(eventStr: string): EventDisposition {
    const dataLine = eventStr.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) return {};
    const jsonStr = dataLine.slice(5).trim();
    if (jsonStr === "[DONE]") return { done: true };
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(jsonStr);
    } catch {
        return {};
    }
    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) return {};
    const delta = choice.delta as Record<string, unknown> | undefined;
    const finishReason = choice.finish_reason as string | null;
    const out: EventDisposition = {};
    if (finishReason) {
        out.finishReason = finishReason;
        out.usage = (parsed.usage ?? null) as Record<string, unknown> | null;
    }
    if (!delta) return out;
    if (delta.tool_calls) {
        const tcs = delta.tool_calls as Array<Record<string, unknown>>;
        const toolCalls: ToolCallAccumulator[] = [];
        for (const tc of tcs) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            const fn = tc.function as Record<string, unknown> | undefined;
            const name = typeof fn?.name === "string" ? fn.name : "";
            const id = typeof tc.id === "string" ? tc.id : "";
            const args = typeof fn?.arguments === "string" ? fn.arguments : "";
            toolCalls.push({ index: idx, id, name, arguments: args });
        }
        if (typeof delta.content === "string" && delta.content.length > 0) {
            out.contentDelta = delta.content;
        }
        out.toolCalls = toolCalls;
        return out;
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
        out.contentDelta = delta.content;
        out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
        return out;
    }
    if (delta.role || (Object.keys(delta).length === 0 && !finishReason)) {
        out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
    }
    return out;
}

function buildToolCallSse(
    base: Record<string, unknown>,
    tc: ToolCallAccumulator,
): string {
    return `data: ${JSON.stringify({
        ...base,
        choices: [{
            index: 0,
            delta: {
                tool_calls: [{
                    index: tc.index,
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: tc.arguments },
                }],
            },
            finish_reason: null,
        }],
    })}\n\n`;
}

function buildFinishSse(
    base: Record<string, unknown>,
    finishReason: string,
    usage: Record<string, unknown> | null,
): string {
    return `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
    })}\n\n`;
}

function buildContentSse(
    id: string,
    model: string,
    content: string,
): string {
    return `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Date.now(),
        model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`;
}

export function buildVisibilityMarker(toolName: string, result: string): string {
    const lines = result.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const failed = lines.some((l) =>
        l.includes("FAILED")
        || l.includes("not found")
        || l.includes("is required")
        || l.includes("No blocks matched")
    );
    const icons: Record<string, string> = {
        compress: "📦",
        decompress: "📤",
        search_context: "🔍",
        acp_status: "📊",
    };
    const icon = failed ? "❌" : (icons[toolName] ?? "📦");

    if (toolName === "acp_status" && lines.length >= 2) {
        const dataLine = lines.slice(0, 3).join(" | ").replace(/\s+/g, " ");
        return `\n${icon} [ACP] ${dataLine}\n`;
    }

    const inner = (lines[0] ?? "").replace(/^\[/, "").replace(/\]$/, "").trim();
    return `\n${icon} [ACP] ${inner}\n`;
}

export async function* compressLoopStream(
    initialUpstream: ReadableStream<Uint8Array>,
    ctx: CompressLoopCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
): AsyncGenerator<Buffer> {
    let upstream = initialUpstream;
    let activeClearTimer: (() => void) | null = null;
    const model = (requestBody.model as string) ?? "unknown";
    let responseId = `chatcmpl-proxy-${Date.now()}`;
    const makeBase = () => ({
        id: responseId,
        object: "chat.completion.chunk" as const,
        created: Date.now(),
        model,
    });
    let loopCount = 0;

    for (;;) {
        loopCount++;
        if (loopCount > 10) {
            ctx.log("[acp-proxy: compress loop limit (10) reached, forwarding as-is]");
            yield Buffer.from(buildFinishSse(makeBase(), "stop", null), "utf8");
            yield Buffer.from("data: [DONE]\n\n", "utf8");
            return;
        }

        const toolCallByIndex = new Map<number, ToolCallAccumulator>();
        let contentText = "";
        let finishReason: string | null = null;
        let usage: Record<string, unknown> | null = null;
        const isFirstRound = loopCount === 1;

        const reader = upstream.getReader();
        const decoder = new TextDecoder("utf-8");
        let sseBuffer = "";
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                sseBuffer += decoder.decode(value, { stream: true });
                sseBuffer = normalizeSseLineEndings(sseBuffer);
                let sep: number;
                while ((sep = sseBuffer.indexOf("\n\n")) >= 0) {
                    const eventStr = sseBuffer.slice(0, sep);
                    sseBuffer = sseBuffer.slice(sep + 2);
                    if (!eventStr.trim()) continue;
                    const d = classifySseEvent(eventStr);
                    if (d.done) {
                        continue;
                    }
                    if (isFirstRound) {
                        if (d.yieldChunk) {
                            if (!responseId) {
                                const dataLine = eventStr.split("\n").find((l) => l.startsWith("data:"));
                                if (dataLine) {
                                    try {
                                        const p = JSON.parse(dataLine.slice(5).trim());
                                        if (typeof p.id === "string") responseId = p.id;
                                    } catch { /* ignore */ }
                                }
                            }
                            yield d.yieldChunk;
                        }
                    } else {
                        if (d.contentDelta) {
                            yield Buffer.from(buildContentSse(responseId, model, d.contentDelta), "utf8");
                        }
                    }
                    if (d.contentDelta) contentText += d.contentDelta;
                    if (d.finishReason) finishReason = d.finishReason;
                    if (d.usage !== undefined) usage = d.usage;
                    if (d.toolCalls) {
                        for (const tc of d.toolCalls) {
                            const existing = toolCallByIndex.get(tc.index);
                            if (existing) {
                                if (tc.name) existing.name = tc.name;
                                if (tc.id) existing.id = tc.id;
                                existing.arguments += tc.arguments;
                            } else {
                                toolCallByIndex.set(tc.index, tc);
                            }
                        }
                    }
                }
            }
            sseBuffer += decoder.decode();
            sseBuffer = normalizeSseLineEndings(sseBuffer);
            // Drain any events still in the residual buffer (a well-formed
            // stream ends with \n\n, but some upstreams omit the final
            // blank line; processing the tail avoids losing the last event).
            let resSep: number;
            while ((resSep = sseBuffer.indexOf("\n\n")) >= 0) {
                const eventStr = sseBuffer.slice(0, resSep);
                sseBuffer = sseBuffer.slice(resSep + 2);
                if (!eventStr.trim()) continue;
                const d = classifySseEvent(eventStr);
                if (d.done) continue;
                if (isFirstRound) {
                    if (d.yieldChunk) yield d.yieldChunk;
                } else {
                    if (d.contentDelta) yield Buffer.from(buildContentSse(responseId, model, d.contentDelta), "utf8");
                }
                if (d.contentDelta) contentText += d.contentDelta;
                if (d.finishReason) finishReason = d.finishReason;
                if (d.usage !== undefined) usage = d.usage;
                if (d.toolCalls) {
                    for (const tc of d.toolCalls) {
                        const existing = toolCallByIndex.get(tc.index);
                        if (existing) {
                            if (tc.name) existing.name = tc.name;
                            if (tc.id) existing.id = tc.id;
                            existing.arguments += tc.arguments;
                        } else {
                            toolCallByIndex.set(tc.index, tc);
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        const sortedIndices = [...toolCallByIndex.keys()].sort((a, b) => a - b);
        const toolCalls: ToolCallAccumulator[] = sortedIndices
            .map((i) => {
                const tc = toolCallByIndex.get(i)!;
                return { ...tc, id: tc.id || `call_${tc.index}` };
            })
            .filter((tc) => tc.name.length > 0);

        const proxyCalls = toolCalls.filter((tc) => PROXY_TOOL_NAMES.has(tc.name));
        const realCalls = toolCalls.filter((tc) => !PROXY_TOOL_NAMES.has(tc.name));

        const hasOnlyProxy = proxyCalls.length > 0 && realCalls.length === 0;

        if (!hasOnlyProxy) {
            for (const tc of realCalls) {
                yield Buffer.from(buildToolCallSse(makeBase(), tc), "utf8");
            }
            const fr = realCalls.length > 0 ? "tool_calls" : (finishReason ?? "stop");
            yield Buffer.from(buildFinishSse(makeBase(), fr, usage), "utf8");
            yield Buffer.from("data: [DONE]\n\n", "utf8");
            return;
        }

        const names = proxyCalls.map((c) => c.name).join(", ");
        ctx.log(`[acp-proxy: round ${loopCount} — ${proxyCalls.length} proxy call(s): ${names}]`);

        const messages = (requestBody.messages as Array<Record<string, unknown>>) ?? [];

        messages.push({
            role: "assistant",
            content: contentText || null,
            tool_calls: proxyCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.arguments },
            })),
        });

        for (const tc of proxyCalls) {
            let args: Record<string, unknown> = {};
            try {
                args = JSON.parse(tc.arguments) as Record<string, unknown>;
            } catch {
                args = {};
            }
            const result = executeProxyTool(tc.name, args, ctx);
            const preview = result.length > 120 ? result.slice(0, 120) + "..." : result;
            ctx.log(`[acp-proxy: ${tc.name} (${tc.id}) → ${preview.replace(/\n/g, " ")}]`);
            yield Buffer.from(
                buildContentSse(responseId, model, buildVisibilityMarker(tc.name, result)),
                "utf8",
            );
            messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: result,
            });
        }

        requestBody.messages = messages;

        const { response: resp, clearTimer } = await fetchWithTimeout(requestOptions.url, {
            method: "POST",
            headers: requestOptions.headers,
            body: JSON.stringify(requestBody),
        });

        if (!resp.ok || !resp.body) {
            const errText = await resp.text().catch(() => "upstream error");
            ctx.log(`[acp-proxy: compress loop upstream error ${resp.status}: ${errText.slice(0, 200)}]`);
            yield Buffer.from(
                `data: ${JSON.stringify({
                    ...makeBase(),
                    choices: [{
                        index: 0,
                        delta: { content: `\n[acp-proxy: upstream error ${resp.status}]\n` },
                        finish_reason: null,
                    }],
                })}\n\n`,
                "utf8",
            );
            yield Buffer.from(buildFinishSse(makeBase(), "stop", null), "utf8");
            yield Buffer.from("data: [DONE]\n\n", "utf8");
            return;
        }

        upstream = resp.body as ReadableStream<Uint8Array>;
        activeClearTimer = clearTimer;
    }
}
