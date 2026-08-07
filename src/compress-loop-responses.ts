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
import { buildVisibilityMarker } from "./compress-loop.js";

interface CompressLoopResponsesCtx {
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

interface FunctionCallAccumulator {
    itemId: string;
    callId: string;
    name: string;
    arguments: string;
}

function executeProxyTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: CompressLoopResponsesCtx,
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

function extractEventType(rawEvent: string): string | null {
    for (const l of rawEvent.split("\n")) {
        if (l.startsWith("event:")) return l.slice(6).trim();
    }
    return null;
}

function extractDataLine(rawEvent: string): string | null {
    for (const l of rawEvent.split("\n")) {
        if (l.startsWith("data:")) return l.slice(5).trim();
    }
    return null;
}

interface ResponsesEventDisposition {
    yieldChunk?: Buffer;
    contentDelta?: string;
    fcStart?: { itemId: string; callId: string; name: string };
    fcArgs?: { itemId: string; delta: string };
    fcDone?: { itemId: string };
    completed?: boolean;
    responseObj?: Record<string, unknown> | null;
}

function classifyResponsesSseEvent(eventStr: string): ResponsesEventDisposition {
    const type = extractEventType(eventStr);
    const dataLine = extractDataLine(eventStr);
    if (!type || !dataLine) return {};
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(dataLine);
    } catch {
        return {};
    }
    const out: ResponsesEventDisposition = {};
    switch (type) {
        case "response.created":
        case "response.in_progress":
        case "response.output_item.added": {
            const item = obj.item as Record<string, unknown> | undefined;
            if (type === "response.output_item.added" && item?.type === "function_call") {
                const name = typeof item.name === "string" ? item.name : "";
                out.fcStart = {
                    itemId: typeof item.id === "string" ? item.id : "",
                    callId: typeof item.call_id === "string" ? item.call_id : "",
                    name,
                };
                return out;
            }
            out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
            return out;
        }
        case "response.content_part.added":
        case "response.content_part.done":
        case "response.output_text.done":
            out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
            return out;
        case "response.output_text.delta": {
            const delta = typeof obj.delta === "string" ? obj.delta : "";
            if (delta) {
                out.contentDelta = delta;
                out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
            }
            return out;
        }
        case "response.function_call_arguments.delta": {
            const itemId = typeof obj.item_id === "string" ? obj.item_id : "";
            const delta = typeof obj.delta === "string" ? obj.delta : "";
            out.fcArgs = { itemId, delta };
            return out;
        }
        case "response.output_item.done": {
            const item = obj.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
                out.fcDone = { itemId: typeof item.id === "string" ? item.id : "" };
                return out;
            }
            out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
            return out;
        }
        case "response.completed":
            out.completed = true;
            out.responseObj = (obj.response as Record<string, unknown>) ?? null;
            return out;
        default:
            out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
            return out;
    }
}

function buildOutputTextDelta(itemId: string, outputIndex: number, text: string): string {
    return `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: outputIndex,
        delta: text,
    })}\n\n`;
}

function buildFunctionCallEvents(
    fc: FunctionCallAccumulator,
    outputIndex: number,
): string {
    return [
        `event: response.output_item.added\ndata: ${JSON.stringify({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { type: "function_call", id: fc.itemId, call_id: fc.callId, name: fc.name, arguments: "" },
        })}\n\n`,
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
            type: "response.function_call_arguments.delta",
            item_id: fc.itemId,
            delta: fc.arguments,
        })}\n\n`,
        `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
            type: "response.function_call_arguments.done",
            item_id: fc.itemId,
            arguments: fc.arguments,
        })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({
            type: "response.output_item.done",
            output_index: outputIndex,
            item: { type: "function_call", id: fc.itemId, call_id: fc.callId, name: fc.name, arguments: fc.arguments },
        })}\n\n`,
    ].join("");
}

function buildCompleted(responseObj: Record<string, unknown> | null): string {
    const resp = responseObj ?? { id: `resp-proxy-${Date.now()}`, status: "completed", output: [] };
    return `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: resp,
    })}\n\n`;
}

export async function* compressLoopResponsesStream(
    initialUpstream: ReadableStream<Uint8Array>,
    ctx: CompressLoopResponsesCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
): AsyncGenerator<Buffer> {
    let upstream = initialUpstream;
    let loopCount = 0;
    let responseObj: Record<string, unknown> | null = null;
    const msgItemId = `msg_acp_${Date.now()}`;
    let outputIndexForContent = 0;

    for (;;) {
        loopCount++;
        if (loopCount > 5) {
            ctx.log("[acp-proxy: responses compress loop limit (5) reached, forwarding completion as-is]");
            yield Buffer.from(buildOutputTextDelta(msgItemId, outputIndexForContent, "\n[acp-proxy: compress loop limit reached]\n"), "utf8");
            yield Buffer.from(buildCompleted(responseObj), "utf8");
            return;
        }

        const fcByItemId = new Map<string, FunctionCallAccumulator>();
        let contentText = "";
        let completed = false;
        const isFirstRound = loopCount === 1;

        const reader = upstream.getReader();
        const decoder = new TextDecoder("utf-8");
        let sseBuffer = "";
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                sseBuffer += decoder.decode(value, { stream: true });
                let sep: number;
                while ((sep = sseBuffer.indexOf("\n\n")) >= 0) {
                    const eventStr = sseBuffer.slice(0, sep);
                    sseBuffer = sseBuffer.slice(sep + 2);
                    if (!eventStr.trim()) continue;
                    const d = classifyResponsesSseEvent(eventStr);
                    if (isFirstRound) {
                        if (d.yieldChunk) yield d.yieldChunk;
                    } else {
                        if (d.contentDelta) {
                            yield Buffer.from(buildOutputTextDelta(msgItemId, outputIndexForContent, d.contentDelta), "utf8");
                        }
                    }
                    if (d.contentDelta) contentText += d.contentDelta;
                    if (d.fcStart) {
                        fcByItemId.set(d.fcStart.itemId, {
                            itemId: d.fcStart.itemId,
                            callId: d.fcStart.callId,
                            name: d.fcStart.name,
                            arguments: "",
                        });
                    }
                    if (d.fcArgs) {
                        const existing = fcByItemId.get(d.fcArgs.itemId);
                        if (existing) existing.arguments += d.fcArgs.delta;
                    }
                    if (d.fcDone) {
                        const existing = fcByItemId.get(d.fcDone.itemId);
                        if (existing && !existing.arguments) {
                            const item = JSON.parse(extractDataLine(eventStr) ?? "{}").item as Record<string, unknown> | undefined;
                            const args = typeof item?.arguments === "string" ? item.arguments : "";
                            existing.arguments = args;
                        }
                    }
                    if (d.completed) {
                        completed = true;
                        responseObj = d.responseObj ?? null;
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        const allCalls = [...fcByItemId.values()].filter((c) => c.name.length > 0);
        const proxyCalls = allCalls.filter((c) => PROXY_TOOL_NAMES.has(c.name));
        const realCalls = allCalls.filter((c) => !PROXY_TOOL_NAMES.has(c.name));
        const hasOnlyProxy = proxyCalls.length > 0 && realCalls.length === 0;

        if (!hasOnlyProxy) {
            let oi = outputIndexForContent;
            for (const fc of realCalls) {
                yield Buffer.from(buildFunctionCallEvents(fc, oi), "utf8");
                oi++;
            }
            if (!completed && contentText.length === 0 && realCalls.length === 0) {
                ctx.log("[acp-proxy: responses stream ended without completion]");
            }
            yield Buffer.from(buildCompleted(responseObj), "utf8");
            return;
        }

        const names = proxyCalls.map((c) => c.name).join(", ");
        ctx.log(`[acp-proxy: responses round ${loopCount} — ${proxyCalls.length} proxy call(s): ${names}]`);

        const inputItems = Array.isArray(requestBody.input) ? [...(requestBody.input as unknown[])] : [];
        if (contentText) {
            inputItems.push({
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: contentText }],
            });
        }
        for (const fc of proxyCalls) {
            inputItems.push({
                type: "function_call",
                id: fc.itemId || `fc_${Date.now()}`,
                call_id: fc.callId || `call_${Date.now()}`,
                name: fc.name,
                arguments: fc.arguments,
            });
        }
        for (const fc of proxyCalls) {
            let args: Record<string, unknown> = {};
            try {
                args = JSON.parse(fc.arguments) as Record<string, unknown>;
            } catch {
                args = {};
            }
            const result = executeProxyTool(fc.name, args, ctx);
            const preview = result.length > 120 ? result.slice(0, 120) + "..." : result;
            ctx.log(`[acp-proxy: responses ${fc.name} (${fc.callId}) → ${preview.replace(/\n/g, " ")}]`);
            yield Buffer.from(
                buildOutputTextDelta(msgItemId, outputIndexForContent, buildVisibilityMarker(fc.name, result)),
                "utf8",
            );
            inputItems.push({
                type: "function_call_output",
                call_id: fc.callId || `call_${Date.now()}`,
                output: result,
            });
        }

        requestBody.input = inputItems;
        if (!("stream" in requestBody)) requestBody.stream = true;

        const resp = await fetch(requestOptions.url, {
            method: "POST",
            headers: requestOptions.headers,
            body: JSON.stringify(requestBody),
        });

        if (!resp.ok || !resp.body) {
            const errText = await resp.text().catch(() => "upstream error");
            ctx.log(`[acp-proxy: responses compress loop upstream error ${resp.status}: ${errText.slice(0, 200)}]`);
            yield Buffer.from(
                buildOutputTextDelta(msgItemId, outputIndexForContent, `\n[acp-proxy: upstream error ${resp.status}]\n`),
                "utf8",
            );
            yield Buffer.from(buildCompleted(responseObj), "utf8");
            return;
        }

        upstream = resp.body as ReadableStream<Uint8Array>;
    }
}
