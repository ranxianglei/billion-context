import http from "node:http";
import fs from "node:fs";
import { createCore, type CompressionCore, type Config, type CoreMessage, type NudgeDecision, estimateTokensFast, renderNudgeText } from "acp-kernel";
import type { ProxyOptions } from "./config.js";
import {
    anthropicToCore,
    coreToAnthropic,
    deriveSessionId,
    extractSystem,
    buildSystem,
    type AnthropicRequestBody,
} from "./anthropic.js";
import {
    openaiToCore,
    coreToOpenai,
    injectOpenaiSystem,
    deriveSessionIdOpenai,
    type OpenAIRequestBody,
    type OpenAITool,
} from "./openai.js";
import { getSession, listSessions, type Session } from "./session.js";
import { COMPRESS_TOOL, ACP_TOOLS_OPENAI, COMPRESS_TOOL_NAME, buildCompressSystemPrompt } from "./compress-tool.js";
import { rewriteSseStream, rewriteJsonResponse, type RewriteCtx } from "./stream.js";
import { compressLoopStream } from "./compress-loop.js";
import { rewriteOpenaiJsonResponse } from "./stream-openai.js";

const UPSTREAM_HOP_HEADERS = new Set([
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
]);

function resolveUpstream(opts: ProxyOptions, authHeader: string | undefined): string | undefined {
    if (!opts.routes.length || !authHeader) return undefined;
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return undefined;
    const match = opts.routes.find((r) => r.apiKey && r.apiKey === token);
    return match?.baseURL.replace(/\/$/, "");
}

export function startServer(opts: ProxyOptions): http.Server {
    const core = createCore();
    const config: Config = opts.kernelConfig;
    const log = (level: string, msg: string) => logMsg(opts, level, msg);
    const server = http.createServer(async (req, res) => {
        try {
            await handle(req, res, opts, core, config, log);
        } catch (err) {
            log("error", String(err));
            if (!res.headersSent) {
                res.writeHead(502, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "acp-proxy failure", detail: String(err) }));
            } else {
                res.end();
            }
        }
    });
    server.listen(opts.port, opts.host, () => {
        log("info", `acp-proxy listening on http://${opts.host}:${opts.port} → ${opts.upstream}`);
    });
    return server;
}

type Prepared = {
    body: string;
    session: Session;
    processedMessages: CoreMessage[];
    protocol: "anthropic" | "openai";
    stream: boolean;
    compressInjected: boolean;
};

async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
): Promise<void> {
    if (req.method === "GET" && req.url === "/__acp/stats") return sendStats(res);
    if (req.method === "GET" && (req.url === "/" || req.url === "/__acp/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, upstream: opts.upstream }));
        return;
    }
    const bodyBuffer = await readBody(req);
    const url = req.url ?? "";
    const protocol: "anthropic" | "openai" | null =
        req.method === "POST" && bodyBuffer.length > 0
            ? url.endsWith("/chat/completions")
                ? "openai"
                : url.endsWith("/v1/messages") || url.endsWith("/messages")
                  ? "anthropic"
                  : null
            : null;
    const prepared = opts.passthrough
        ? null
        : protocol === "anthropic"
            ? prepareAnthropic(bodyBuffer, req, opts, core, config, log)
            : protocol === "openai"
              ? prepareOpenai(bodyBuffer, req, opts, core, config, log)
              : null;
    const outBody: Buffer | string = prepared ? prepared.body : bodyBuffer;
    await forward(req, res, opts, outBody, prepared, core, config, log);
}

const ACP_TAG_RE = /^\x3cacp [^>]*\x3e[^\x3c]*\x3c\/acp\x3e\n?/;

function stripToolTags(messages: CoreMessage[]): void {
    for (const m of messages) {
        if (m.contentType === "tool-call" || m.contentType === "tool-result") {
            m.text = (m.text ?? "").replace(ACP_TAG_RE, "");
        }
    }
}

function prepareAnthropic(
    bodyBuffer: Buffer,
    req: http.IncomingMessage,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
): Prepared {
    const parsed = JSON.parse(bodyBuffer.toString("utf8")) as AnthropicRequestBody;
    const stream = parsed.stream === true;
    const sessionId = deriveSessionId(parsed, headerValue(req, opts.sessionHeader));
    const session = getSession(sessionId);
    session.requests++;

    let processedMessages: CoreMessage[] = [];
    let rebuiltMessages = parsed.messages;
    let systemOut = parsed.system;
    let toolsOut = parsed.tools;

    try {
        const { msgs } = anthropicToCore(parsed);
        const tokenCount = estimateTokensFast(msgs.map((m) => m.text ?? "").join("\n"));
        const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount });
        session.state = turn.state;
        stripToolTags(turn.messages);
        processedMessages = turn.messages;
        rebuiltMessages = coreToAnthropic(turn.messages);

        systemOut = injectSystem(parsed, turn.nudge, opts);
        if (opts.compress.injectTool) {
            toolsOut = injectTool(parsed.tools);
        }
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    const rebuilt: AnthropicRequestBody = { ...parsed, messages: rebuiltMessages, system: systemOut, tools: toolsOut };
    return { body: JSON.stringify(rebuilt), session, processedMessages, protocol: "anthropic", stream, compressInjected: opts.compress.injectTool };
}

function prepareOpenai(
    bodyBuffer: Buffer,
    req: http.IncomingMessage,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
): Prepared {
    const parsed = JSON.parse(bodyBuffer.toString("utf8")) as OpenAIRequestBody;
    const stream = parsed.stream === true;
    const sessionId = deriveSessionIdOpenai(parsed, headerValue(req, opts.sessionHeader));
    const session = getSession(sessionId);
    session.requests++;

    let processedMessages: CoreMessage[] = [];
    let rebuiltMessages = parsed.messages;
    let toolsOut = parsed.tools;

    const maxTokens = typeof parsed.max_tokens === "number" ? parsed.max_tokens : 8192;
    const isTitleGen = maxTokens <= 200 || parsed.messages.length <= 2;
    const shouldInject = opts.compress.injectTool && !isTitleGen;

    try {
        const { msgs } = openaiToCore(parsed);
        const tokenCount = estimateTokensFast(msgs.map((m) => m.text ?? "").join("\n"));
        const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount });
        session.state = turn.state;
        stripToolTags(turn.messages);
        processedMessages = turn.messages;
        rebuiltMessages = coreToOpenai(turn.messages);

        const sysParts: string[] = [];
        if (shouldInject) sysParts.push(buildCompressSystemPrompt());
        if (turn.nudge?.shouldInject && shouldInject) {
            try {
                const rendered = renderNudgeText(turn.nudge);
                if (rendered.text) sysParts.push(rendered.text);
            } catch {
            }
        }
        rebuiltMessages = injectOpenaiSystem(rebuiltMessages, sysParts);
        if (shouldInject) {
            toolsOut = injectOpenaiTool(parsed.tools);
        }
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    const rebuilt: OpenAIRequestBody = { ...parsed, messages: rebuiltMessages, tools: toolsOut as OpenAITool[] | undefined };
    return { body: JSON.stringify(rebuilt), session, processedMessages, protocol: "openai", stream, compressInjected: shouldInject };
}

function injectSystem(
    parsed: AnthropicRequestBody,
    nudge: NudgeDecision | undefined,
    opts: ProxyOptions,
): string | AnthropicRequestBody["system"] {
    const baseText = extractSystem(parsed.system);
    const parts: string[] = [];
    if (opts.compress.injectTool) parts.push(buildCompressSystemPrompt());
    if (nudge?.shouldInject) {
        try {
            const rendered = renderNudgeText(nudge);
            if (rendered.text) parts.push(rendered.text);
        } catch {
        }
    }
    if (parts.length === 0) return parsed.system;
    const full = baseText ? `${baseText}\n\n---\n\n${parts.join("\n\n")}` : parts.join("\n\n");
    return buildSystem(full, parsed.system);
}

function injectTool(tools: unknown[] | undefined): unknown[] {
    if (!Array.isArray(tools)) return [COMPRESS_TOOL];
    if (tools.some((t) => (t as { name?: string })?.name === COMPRESS_TOOL_NAME)) return tools;
    return [...tools, COMPRESS_TOOL];
}

function injectOpenaiTool(tools: OpenAITool[] | undefined): OpenAITool[] {
    if (!Array.isArray(tools)) return [...ACP_TOOLS_OPENAI] as OpenAITool[];
    const present = new Set(
        tools
            .map((t) => t?.function?.name)
            .filter((n): n is string => typeof n === "string"),
    );
    const additions = ACP_TOOLS_OPENAI.filter((t) => !present.has(t.function.name));
    return [...tools, ...(additions as OpenAITool[])];
}

async function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts: ProxyOptions,
    body: Buffer | string,
    prepared: Prepared | null,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
): Promise<void> {
    const base = resolveUpstream(opts, req.headers.authorization) ?? opts.upstream;
    const upstreamUrl = base + (req.url ?? "");
    log("info", `forward ${req.method} ${req.url ?? ""} → ${upstreamUrl}`);
    if (opts.debug && typeof body === "string") {
        try {
            const parsed = JSON.parse(body);
            const toolNames = (parsed.tools ?? []).map((t: Record<string, unknown>) => {
                const fn = t.function as { name?: string } | undefined;
                return fn?.name ?? "?";
            });
            log("info", `[debug] tools=[${toolNames.join(",")}] msgs=${parsed.messages?.length ?? 0} stream=${parsed.stream ?? false} system_len=${JSON.stringify(parsed.messages?.find((m: Record<string, string>) => m.role === "system")?.content ?? "").length}`);
            const out = `/tmp/acp-proxy-debug-req-${Date.now()}.json`;
            fs.writeFileSync(out, body.slice(0, 50000));
            log("info", `[debug] forwarded body written to ${out}`);
        } catch { /* best-effort */ }
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (UPSTREAM_HOP_HEADERS.has(k.toLowerCase()) || v === undefined) continue;
        headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    headers["host"] = new URL(base).host;
    const init: RequestInit = {
        method: req.method ?? "GET",
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    };
    const upstream = await fetch(upstreamUrl, init);
    const respHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
        if (UPSTREAM_HOP_HEADERS.has(k.toLowerCase())) return;
        respHeaders[k] = v;
    });
    res.writeHead(upstream.status, respHeaders);
    if (!upstream.body) {
        res.end();
        return;
    }
    const useRewriter =
        prepared !== null &&
        prepared.processedMessages.length > 0 &&
        opts.compress.injectTool;
    if (!useRewriter || prepared === null) {
        await pipeThrough(upstream.body, res);
        return;
    }
    const ctx: RewriteCtx = {
        core,
        config,
        messages: prepared.processedMessages,
        session: prepared.session,
        log: (msg: string) => log("info", `[${prepared.session.id}] ${msg}`),
        debug: opts.debug,
    };
    if (prepared.stream) {
        let streamToRead = upstream.body as ReadableStream<Uint8Array>;
        let dumpRaw: Promise<void> | undefined;
        if (opts.dumpSse) {
            const [a, b] = (upstream.body as ReadableStream<Uint8Array>).tee();
            streamToRead = a;
            dumpRaw = dumpStreamToFile(b, opts.dumpSse, `${Date.now()}-${prepared.session.id}-raw.sse`);
        }
        const ctx: RewriteCtx = {
            core,
            config,
            messages: prepared.processedMessages,
            session: prepared.session,
            log: (msg: string) => log("info", `[${prepared.session.id}] ${msg}`),
            debug: opts.debug,
        };
        if (prepared.protocol === "openai" && prepared.compressInjected) {
            const parsedReq = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
            const reqHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(headers)) {
                if (k.toLowerCase() === "content-length" || k.toLowerCase() === "host") continue;
                reqHeaders[k] = v;
            }
            reqHeaders["content-type"] = "application/json";
            const loop = compressLoopStream(
                streamToRead,
                { core, config, messages: prepared.processedMessages, session: prepared.session, log: ctx.log },
                parsedReq,
                { url: upstreamUrl, headers: reqHeaders },
            );
            for await (const chunk of loop) {
                if (!res.write(chunk)) await new Promise<void>((r) => res.once("drain", () => r()));
            }
        } else {
            const rewriter = rewriteSseStream(streamToRead, ctx);
            for await (const chunk of rewriter) {
                if (!res.write(chunk)) await new Promise<void>((r) => res.once("drain", () => r()));
            }
        }
        res.end();
        if (dumpRaw) await dumpRaw;
    } else {
        const buf = await upstream.arrayBuffer();
        const text = Buffer.from(buf).toString("utf8");
        try {
            const json = JSON.parse(text);
            if (prepared.protocol === "openai") {
                rewriteOpenaiJsonResponse(json, ctx);
            } else {
                rewriteJsonResponse(json, ctx);
            }
            res.end(JSON.stringify(json));
        } catch {
            res.end(text);
        }
    }
}

async function pipeThrough(stream: ReadableStream<Uint8Array>, res: http.ServerResponse): Promise<void> {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) {
                await new Promise<void>((r) => res.once("drain", () => r()));
            }
        }
    } finally {
        reader.releaseLock();
        res.end();
    }
}

async function dumpStreamToFile(stream: ReadableStream<Uint8Array>, dir: string, name: string): Promise<void> {
    const { mkdirSync, createWriteStream } = await import("node:fs");
    const { join } = await import("node:path");
    try {
        mkdirSync(dir, { recursive: true });
        const ws = createWriteStream(join(dir, name));
        const reader = stream.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                ws.write(Buffer.from(value));
            }
        } finally {
            reader.releaseLock();
            ws.end();
        }
    } catch {
        // best-effort dump
    }
}

function sendStats(res: http.ServerResponse): void {
    const sessions = listSessions().map((s) => ({
        id: s.id,
        requests: s.requests,
        condensedToolResults: s.condensedToolResults,
        tokensSaved: s.tokensSaved,
        lastSeen: new Date(s.lastSeen).toISOString(),
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions }, null, 2));
}

function headerValue(req: http.IncomingMessage, name: string): string | undefined {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
    }
    return undefined;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function logMsg(opts: ProxyOptions, level: string, msg: string): void {
    if (!opts.log) return;
    const ts = new Date().toISOString();
    console.error(`${ts} [${level}] ${msg}`);
}
