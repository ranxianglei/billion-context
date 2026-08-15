import http from "node:http";
import { once } from "node:events";

type ResponsesTool = {
    type?: string;
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
};

type ResponsesInputItem = {
    type?: string;
    role?: string;
    content?: unknown;
    name?: string;
    call_id?: string;
    arguments?: string;
    output?: string;
    summary?: unknown;
};

type ChatMessage = {
    role: string;
    content?: string | null;
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
};

export type ChatRelayOptions = {
    upstream: string;
    host?: string;
    port?: number;
};

export type ChatRelay = {
    server: http.Server;
    port: number;
    close(): Promise<void>;
};

function joinText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part) => {
            if (part && typeof part === "object" && "text" in part) {
                return String((part as { text?: unknown }).text ?? "");
            }
            return "";
        })
        .join("");
}

function responsesToChat(body: Record<string, unknown>): Record<string, unknown> {
    const messages: ChatMessage[] = [];
    const instructions = body.instructions;
    if (typeof instructions === "string" && instructions.length > 0) {
        messages.push({ role: "system", content: instructions });
    }
    const input = body.input;
    const items: ResponsesInputItem[] =
        typeof input === "string" ? [{ type: "message", role: "user", content: input }] : Array.isArray(input) ? (input as ResponsesInputItem[]) : [];
    let lastAssistant: ChatMessage | null = null;
    for (const item of items) {
        if (item.type === "message") {
            const role = item.role === "assistant" ? "assistant" : item.role === "system" || item.role === "developer" ? "system" : "user";
            const text = joinText(item.content);
            const msg: ChatMessage = { role, content: text };
            messages.push(msg);
            lastAssistant = role === "assistant" ? msg : null;
        } else if (item.type === "function_call") {
            const call = {
                id: item.call_id ?? "",
                type: "function",
                function: { name: item.name ?? "", arguments: item.arguments ?? "" },
            };
            if (lastAssistant && lastAssistant.tool_calls) {
                lastAssistant.tool_calls.push(call);
            } else {
                const msg: ChatMessage = { role: "assistant", content: null, tool_calls: [call] };
                messages.push(msg);
                lastAssistant = msg;
            }
        } else if (item.type === "function_call_output") {
            messages.push({ role: "tool", tool_call_id: item.call_id ?? "", content: item.output ?? "" });
            lastAssistant = null;
        }
    }
    const tools: Array<Record<string, unknown>> = [];
    for (const tool of (body.tools as ResponsesTool[] | undefined) ?? []) {
        if (tool.type === "function" && tool.name) {
            const fn: Record<string, unknown> = { name: tool.name };
            if (tool.description) fn.description = tool.description;
            if (tool.parameters) fn.parameters = tool.parameters;
            tools.push({ type: "function", function: fn });
        }
    }
    const out: Record<string, unknown> = {
        model: body.model,
        messages,
        stream: body.stream ?? false,
    };
    if (tools.length > 0) out.tools = tools;
    if (typeof body.tool_choice === "string") out.tool_choice = body.tool_choice;
    if (typeof body.temperature === "number") out.temperature = body.temperature;
    if (typeof body.max_output_tokens === "number") out.max_tokens = body.max_output_tokens;
    return out;
}

type ToolCallState = {
    itemId: string;
    callId: string;
    name: string;
    arguments: string;
    done: boolean;
};

type BridgeStreamState = {
    created: boolean;
    reasoningOpen: string | null;
    messageOpen: string | null;
    toolCalls: Map<number, ToolCallState>;
    finishedItems: Array<Record<string, unknown>>;
    usage: { input_tokens: number; output_tokens: number };
};

function sseBlock(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function ensureCreated(state: BridgeStreamState, res: http.ServerResponse, responseId: string): void {
    if (state.created) return;
    state.created = true;
    res.write(sseBlock("response.created", { response: { id: responseId, status: "in_progress" } }));
    res.write(sseBlock("response.in_progress", { response: { id: responseId, status: "in_progress" } }));
}

function closeReasoning(state: BridgeStreamState, res: http.ServerResponse): void {
    if (!state.reasoningOpen) return;
    const id = state.reasoningOpen;
    state.reasoningOpen = null;
    res.write(sseBlock("response.reasoning_summary_part.done", { item_id: id, output_index: 0 }));
    res.write(
        sseBlock("response.output_item.done", {
            output_index: 0,
            item: { type: "reasoning", id, summary: [] },
        }),
    );
}

function closeMessage(state: BridgeStreamState, res: http.ServerResponse, fullText: string): void {
    if (!state.messageOpen) return;
    const id = state.messageOpen;
    state.messageOpen = null;
    res.write(sseBlock("response.output_text.done", { item_id: id, output_index: 0, text: fullText }));
    res.write(sseBlock("response.content_part.done", { item_id: id, output_index: 0, content_index: 0 }));
    res.write(
        sseBlock("response.output_item.done", {
            output_index: 0,
            item: { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText }] },
        }),
    );
    state.finishedItems.push({ type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText }] });
}

function closeToolCalls(state: BridgeStreamState, res: http.ServerResponse): void {
    for (const tc of state.toolCalls.values()) {
        if (tc.done) continue;
        tc.done = true;
        res.write(sseBlock("response.function_call_arguments.done", { item_id: tc.itemId, output_index: 0, arguments: tc.arguments }));
        const item = { type: "function_call", id: tc.itemId, call_id: tc.callId, name: tc.name, arguments: tc.arguments };
        res.write(sseBlock("response.output_item.done", { output_index: 0, item }));
        state.finishedItems.push(item);
    }
}

async function pipeStream(chatBody: Record<string, unknown>, upstream: string, res: http.ServerResponse, responseId: string): Promise<void> {
    const upstreamResp = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ ...chatBody, stream: true }),
    });
    if (!upstreamResp.ok || !upstreamResp.body) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `chat relay upstream ${upstreamResp.status}` } }));
        return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const state: BridgeStreamState = {
        created: false,
        reasoningOpen: null,
        messageOpen: null,
        toolCalls: new Map(),
        finishedItems: [],
        usage: { input_tokens: 0, output_tokens: 0 },
    };
    let messageText = "";
    let buffer = "";
    for await (const chunk of upstreamResp.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += Buffer.from(chunk).toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of block.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (payload === "[DONE]") {
                    closeReasoning(state, res);
                    closeMessage(state, res, messageText);
                    closeToolCalls(state, res);
                    res.write(
                        sseBlock("response.completed", {
                            response: { id: responseId, status: "completed", output: state.finishedItems, usage: state.usage },
                        }),
                    );
                    res.end();
                    return;
                }
                let obj: Record<string, unknown>;
                try {
                    obj = JSON.parse(payload) as Record<string, unknown>;
                } catch {
                    continue;
                }
                handleChatChunk(obj, state, res, responseId, (text) => {
                    messageText += text;
                }, messageText);
            }
        }
    }
    closeReasoning(state, res);
    closeMessage(state, res, messageText);
    closeToolCalls(state, res);
    res.write(
        sseBlock("response.completed", {
            response: { id: responseId, status: "completed", output: state.finishedItems, usage: state.usage },
        }),
    );
    res.end();
}

function handleChatChunk(
    obj: Record<string, unknown>,
    state: BridgeStreamState,
    res: http.ServerResponse,
    responseId: string,
    onText: (text: string) => void,
    messageText: string,
): void {
    const usage = obj.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (usage) {
        state.usage.input_tokens = usage.prompt_tokens ?? state.usage.input_tokens;
        state.usage.output_tokens = usage.completion_tokens ?? state.usage.output_tokens;
    }
    const choice = Array.isArray(obj.choices) ? (obj.choices[0] as Record<string, unknown> | undefined) : undefined;
    if (!choice) return;
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) return;
    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    if (reasoning) {
        ensureCreated(state, res, responseId);
        if (!state.reasoningOpen) {
            const id = "rs_1";
            state.reasoningOpen = id;
            res.write(sseBlock("response.output_item.added", { output_index: 0, item: { type: "reasoning", id, summary: [] } }));
            res.write(sseBlock("response.reasoning_summary_part.added", { item_id: id, output_index: 0 }));
        }
        res.write(sseBlock("response.reasoning_summary_text.delta", { item_id: state.reasoningOpen, delta: reasoning }));
    }
    const content = typeof delta.content === "string" ? delta.content : "";
    if (content) {
        ensureCreated(state, res, responseId);
        closeReasoning(state, res);
        if (!state.messageOpen) {
            const id = "msg_1";
            state.messageOpen = id;
            res.write(
                sseBlock("response.output_item.added", {
                    output_index: 0,
                    item: { type: "message", id, role: "assistant", status: "in_progress", content: [] },
                }),
            );
            res.write(sseBlock("response.content_part.added", { item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }));
        }
        res.write(sseBlock("response.output_text.delta", { item_id: state.messageOpen, output_index: 0, content_index: 0, delta: content }));
        onText(content);
    }
    const toolCalls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Array<Record<string, unknown>>) : [];
    for (const raw of toolCalls) {
        const index = typeof raw.index === "number" ? raw.index : 0;
        const fn = raw.function as { name?: string; arguments?: string } | undefined;
        let tc = state.toolCalls.get(index);
        if (!tc) {
            tc = {
                itemId: `fc_${index + 1}`,
                callId: typeof raw.id === "string" && raw.id ? raw.id : `call_${index + 1}`,
                name: fn?.name ?? "",
                arguments: "",
                done: false,
            };
            state.toolCalls.set(index, tc);
            ensureCreated(state, res, responseId);
            closeReasoning(state, res);
            closeMessage(state, res, messageText);
            res.write(
                sseBlock("response.output_item.added", {
                    output_index: 0,
                    item: { type: "function_call", id: tc.itemId, call_id: tc.callId, name: tc.name, arguments: "" },
                }),
            );
        }
        if (fn?.name && !tc.name) tc.name = fn.name;
        const args = fn?.arguments ?? "";
        if (args) {
            tc.arguments += args;
            res.write(sseBlock("response.function_call_arguments.delta", { item_id: tc.itemId, output_index: 0, delta: args }));
        }
    }
}

async function pipeJson(chatBody: Record<string, unknown>, upstream: string, res: http.ServerResponse, responseId: string): Promise<void> {
    const upstreamResp = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...chatBody, stream: false }),
    });
    const json = (await upstreamResp.json()) as Record<string, unknown>;
    const choice = Array.isArray(json.choices) ? (json.choices[0] as Record<string, unknown> | undefined) : undefined;
    const message = (choice?.message ?? {}) as Record<string, unknown>;
    const output: Array<Record<string, unknown>> = [];
    const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
    if (reasoning) output.push({ type: "reasoning", id: "rs_1", summary: [] });
    const content = typeof message.content === "string" ? message.content : "";
    if (content) {
        output.push({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: content }] });
    }
    const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
    calls.forEach((call, i) => {
        const fn = (call.function ?? {}) as { name?: string; arguments?: string };
        output.push({ type: "function_call", id: `fc_${i + 1}`, call_id: typeof call.id === "string" ? call.id : "", name: fn.name ?? "", arguments: fn.arguments ?? "" });
    });
    const usage = (json.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
    res.writeHead(upstreamResp.status, { "content-type": "application/json" });
    res.end(
        JSON.stringify({
            id: responseId,
            status: "completed",
            output,
            usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 },
        }),
    );
}

export async function startChatRelay(options: ChatRelayOptions): Promise<ChatRelay> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", async () => {
            const url = req.url ?? "";
            if (req.method !== "POST" || !url.endsWith("/responses")) {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: `chat relay: unsupported ${req.method} ${url}` } }));
                return;
            }
            let body: Record<string, unknown>;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            } catch {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "chat relay: invalid JSON" } }));
                return;
            }
            const chatBody = responsesToChat(body);
            const responseId = `resp_bridge_${Date.now()}`;
            try {
                if (body.stream === true) {
                    await pipeStream(chatBody, options.upstream, res, responseId);
                } else {
                    await pipeJson(chatBody, options.upstream, res, responseId);
                }
            } catch (error) {
                res.writeHead(502, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: `chat relay: ${(error as Error).message}` } }));
            }
        });
    });
    const host = options.host ?? "127.0.0.1";
    server.listen(options.port ?? 0, host);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    return {
        server,
        port,
        close: () =>
            new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
}
