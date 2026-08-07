import http from "node:http";
import fs from "node:fs";
import { createCore, type CompressionCore, type Config, type CoreMessage, type NudgeDecision, estimateTokensFast, renderNudgeText } from "acp-kernel";
import type { ProxyOptions } from "./config.js";
import { lookupContextLimit } from "./config.js";
import { fetchWithTimeout, MAX_REQUEST_BYTES } from "./fetch-util.js";
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
    condenseOldToolResults,
    type CondenseOptions,
    type OpenAIRequestBody,
    type OpenAITool,
} from "./openai.js";
import {
    type ResponsesRequestBody,
    type ResponseInputItem,
    responsesToCore,
    coreToResponses,
    injectResponsesInstructions,
    deriveSessionIdResponses,
} from "./responses.js";
import { getSession, listSessions, type Session } from "./session.js";
import { COMPRESS_TOOL, COMPRESS_TOOL_RESPONSES, ACP_TOOLS_OPENAI, COMPRESS_TOOL_NAME, buildCompressSystemPrompt, buildCompressTextSystemPrompt } from "./compress-tool.js";
import { rewriteSseStream, rewriteJsonResponse, type RewriteCtx } from "./stream.js";
import { compressLoopStream } from "./compress-loop.js";
import { compressLoopResponsesStream } from "./compress-loop-responses.js";
import { rewriteOpenaiJsonResponse } from "./stream-openai.js";
import { rewriteResponsesSseStream, rewriteResponsesJsonResponse } from "./stream-responses.js";

const UPSTREAM_HOP_HEADERS = new Set([
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
]);

export function resolveUpstream(opts: ProxyOptions, reqUrl: string): { upstream: string; rewrittenUrl: string; provider: string } | undefined {
    const names = Object.keys(opts.routes);
    if (names.length === 0) return undefined;
    // Provider names that coincide with common API path segments are rejected
    // so they can't swallow real segments. If a user really names a route
    // "chat" or "v1" they'd collide with every request, so we treat those as
    // configuration errors and skip them.
    const RESERVED = new Set(["v1", "v2", "v4", "chat", "completions", "messages", "models", "api"]);
    // Match a provider name as a standalone path segment anywhere in the URL.
    // Examples: /v1/glm/chat/completions → glm; /anthropic/v1/messages → anthropic.
    // Names are sorted longest-first so a name like "openai" can't be shadowed
    // by a shorter segment it contains.
    const sorted = [...names].sort((a, b) => b.length - a.length);
    const segments = reqUrl.split("/");
    for (const name of sorted) {
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) continue;
        if (RESERVED.has(name.toLowerCase())) continue;
        const idx = segments.indexOf(name);
        if (idx < 0) continue;
        const base = opts.routes[name].replace(/\/$/, "");
        // Drop the single provider-name segment, keep the rest.
        const rest = [...segments.slice(0, idx), ...segments.slice(idx + 1)].join("/");
        const rewrittenUrl = base + rest;
        return { upstream: base, rewrittenUrl, provider: name };
    }
    return undefined;
}

export function startServer(opts: ProxyOptions): http.Server {
    const core = createCore();
    const config: Config = opts.kernelConfig;
    const log = (level: string, msg: string) => logMsg(opts, level, msg);
    const server = http.createServer(async (req, res) => {
        try {
            await handle(req, res, opts, core, config, log);
        } catch (err) {
            const msg = String(err);
            log("error", msg);
            if (!res.headersSent) {
                const status = msg.includes("exceeds") ? 413 : 502;
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "acp-proxy failure", detail: msg }));
            } else {
                res.end();
            }
        }
    });
    server.listen(opts.port, opts.host, () => {
        log(
            "info",
            `acp-proxy listening on http://${opts.host}:${opts.port}` +
                (Object.keys(opts.routes).length
                    ? ` — routes: ${Object.entries(opts.routes)
                          .map(([n, u]) => `${n}=${u}`)
                          .join(", ")}`
                    : ` → ${opts.upstream}`),
        );
    });
    return server;
}

type Prepared = {
    body: string;
    session: Session;
    processedMessages: CoreMessage[];
    protocol: "anthropic" | "openai" | "responses";
    stream: boolean;
    compressInjected: boolean;
};

/**
 * Apply condense to the kernel-processed messages and record stats on the
 * session. Previously `opts.condense` and `condenseOldToolResults` were wired
 * into config but never invoked — leaving a whole feature as dead code. This
 * is the single integration point for both protocols.
 */
function applyCondense(
    messages: CoreMessage[],
    opts: ProxyOptions,
    session: Session,
): CoreMessage[] {
    const condenseOpts: CondenseOptions = {
        enabled: opts.condense.enabled,
        keepRecent: opts.condense.keepRecentToolResults,
        minChars: opts.condense.minCharsToCondense,
        maxKeptChars: opts.condense.maxKeptChars,
    };
    const { messages: out, condensedCount, charsSaved } = condenseOldToolResults(messages, condenseOpts);
    if (condensedCount > 0) {
        session.condensedToolResults += condensedCount;
        session.tokensSaved += Math.ceil(charsSaved / 4);
    }
    return out;
}

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
    const protocol: "anthropic" | "openai" | "responses" | null =
        req.method === "POST" && bodyBuffer.length > 0
            ? url.endsWith("/chat/completions")
                ? "openai"
                : url.endsWith("/v1/messages") || url.endsWith("/messages")
                  ? "anthropic"
                  : url.endsWith("/responses")
                    ? "responses"
                    : null
            : null;
    // Per-request context limit: look up body.model in the built-in table.
    // Lets the proxy run with the right window per model without asking the
    // user to configure one. Falls back to the global default.
    let reqConfig = config;
    if (protocol && bodyBuffer.length > 0) {
        const m = bodyBuffer.toString("utf8").match(/"model"\s*:\s*"([^"]+)"/);
        if (m) {
            const limit = lookupContextLimit(m[1]);
            if (limit && limit !== config.modelContextLimit) {
                reqConfig = { ...config, modelContextLimit: limit };
            }
        }
    }
    const prepared = opts.passthrough
        ? null
        : protocol === "anthropic"
            ? prepareAnthropic(bodyBuffer, req, opts, core, reqConfig, log)
            : protocol === "openai"
              ? prepareOpenai(bodyBuffer, req, opts, core, reqConfig, log)
              : protocol === "responses"
                ? prepareResponses(bodyBuffer, req, opts, core, reqConfig, log)
                : null;
    const outBody: Buffer | string = prepared ? prepared.body : bodyBuffer;
    await forward(req, res, opts, outBody, prepared, core, reqConfig, log);
}

const ACP_TAG_MARK = "\x3cacp ";

function diagTagSummary(messages: CoreMessage[], sessionId: string, strategy: string): string {
    let textTagged = 0;
    let toolTagged = 0;
    for (const m of messages) {
        const hasTag = (m.text ?? "").includes(ACP_TAG_MARK);
        if (!hasTag) continue;
        if (m.contentType === "tool-call" || m.contentType === "tool-result") toolTagged++;
        else textTagged++;
    }
    return `[${sessionId}] processTurn: ${messages.length} msgs, renderTags=${strategy}, ${textTagged} text tagged, ${toolTagged} tool tagged (should be 0 with text-only)`;
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
        const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount, renderTags: "text-only" });
        session.state = turn.state;
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        processedMessages = applyCondense(turn.messages, opts, session);
        rebuiltMessages = coreToAnthropic(processedMessages);

        systemOut = injectSystem(parsed, opts);
        if (opts.compress.injectTool) {
            toolsOut = injectTool(parsed.tools);
        }
        // Nudge as a separate trailing user message (cache-friendly): the
        // system block stays byte-stable so the prefix cache survives.
        if (turn.nudge?.shouldInject) {
            try {
                const rendered = renderNudgeText(turn.nudge);
                if (rendered.text) {
                    rebuiltMessages = [...rebuiltMessages, { role: "user", content: rendered.text }];
                }
            } catch {
            }
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
        const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount, renderTags: "text-only" });
        session.state = turn.state;
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        processedMessages = applyCondense(turn.messages, opts, session);
        rebuiltMessages = coreToOpenai(processedMessages);

        // ONLY the static compress prompt goes into the system message — the
        // system prompt is the prefix-cache anchor and must be byte-stable
        // across turns. The nudge (which changes every turn: token count,
        // growth %, dynamic example) is appended as a trailing user message
        // instead, mirroring pai-acp's design. Putting the nudge in system
        // would invalidate the cache every turn.
        const sysParts: string[] = [];
        if (shouldInject) sysParts.push(buildCompressSystemPrompt());
        rebuiltMessages = injectOpenaiSystem(rebuiltMessages, sysParts);
        if (shouldInject) {
            toolsOut = injectOpenaiTool(parsed.tools);
        }
        // Nudge as a separate trailing user message (cache-friendly).
        if (turn.nudge?.shouldInject && shouldInject) {
            try {
                const rendered = renderNudgeText(turn.nudge);
                if (rendered.text) {
                    rebuiltMessages = [...rebuiltMessages, { role: "user", content: rendered.text }];
                }
            } catch {
            }
        }
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    const rebuilt: OpenAIRequestBody = { ...parsed, messages: rebuiltMessages, tools: toolsOut as OpenAITool[] | undefined };
    return { body: JSON.stringify(rebuilt), session, processedMessages, protocol: "openai", stream, compressInjected: shouldInject };
}

function prepareResponses(
    bodyBuffer: Buffer,
    req: http.IncomingMessage,
    opts: ProxyOptions,
    core: CompressionCore,
    config: Config,
    log: (level: string, msg: string) => void,
): Prepared {
    const parsed = JSON.parse(bodyBuffer.toString("utf8")) as ResponsesRequestBody;
    const stream = parsed.stream === true;
    const sessionId = deriveSessionIdResponses(parsed, headerValue(req, opts.sessionHeader));
    const session = getSession(sessionId);
    session.requests++;

    let processedMessages: CoreMessage[] = [];
    let rebuiltInput: ResponseInputItem[] | string = parsed.input;
    let toolsOut = parsed.tools;

    const shouldInject = opts.compress.injectTool;

    try {
        const { msgs, systemParts, preamble, customToolCallIds } = responsesToCore(parsed);
        if (process.env.ACP_DEBUG) {
            log("info", `[${sessionId}] input items: ${Array.isArray(parsed.input) ? parsed.input.map((i: ResponseInputItem) => i.type).join(",") : "(string)"}`);
        }
        const tokenCount = estimateTokensFast(msgs.map((m) => m.text ?? "").join("\n"));
        const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount, renderTags: process.env.ACP_RENDER_NONE ? "none" : "text-only" });
        session.state = turn.state;
        log("info", diagTagSummary(turn.messages, sessionId, "text-only"));
        processedMessages = applyCondense(turn.messages, opts, session);
        // Rebuild input preserving the responses_lite contract:
        //   input[0]   = additional_tools (host directive, verbatim)
        //   input[1]   = developer message (base instructions + compress prompt)
        //   input[2..] = conversation history (compressed)
        //   top-level `instructions` is NEVER touched — it must stay empty for
        //   responses_lite. Setting it non-empty breaks code_mode tool exposure.
        const conversationItems = coreToResponses(processedMessages, customToolCallIds);
        if (preamble.length > 0) {
            log("info", `[${sessionId}] preserved ${preamble.length} opaque preamble item(s): ${preamble.map((p) => p.type).join(",")}`);
        }

        const inputItems: ResponseInputItem[] = [...preamble];
        if (shouldInject && !process.env.ACP_NO_COMPRESS_PROMPT) {
            const sysParts = [...systemParts, buildCompressSystemPrompt()];
            inputItems.push({ type: "message", role: "developer", content: sysParts.join("\n\n---\n\n") });
            if (!process.env.ACP_NO_INJECT_TOOL) {
                toolsOut = injectResponsesTool(parsed.tools);
            }
        } else if (systemParts.length > 0) {
            // No compress injection, but still restore the base instructions
            // that responsesToCore lifted out of the input.
            inputItems.push({ type: "message", role: "developer", content: systemParts.join("\n\n---\n\n") });
        }
        inputItems.push(...conversationItems);
        if (process.env.ACP_DEBUG) {
            const ctcs = conversationItems.filter((i) => i.type === "custom_tool_call").length;
            const ctcos = conversationItems.filter((i) => i.type === "custom_tool_call_output").length;
            log("info", `[${sessionId}] rebuilt: msgs=${msgs.length} -> conv=${conversationItems.length} (custom_tool_call=${ctcs} custom_tool_call_output=${ctcos})`);
        }
        if (turn.nudge?.shouldInject && shouldInject) {
            try {
                const rendered = renderNudgeText(turn.nudge);
                if (rendered.text) {
                    inputItems.push({ type: "message", role: "user", content: rendered.text });
                }
            } catch {
            }
        }
        rebuiltInput = inputItems;
    } catch (err) {
        log("warn", `[${sessionId}] kernel transform failed, forwarding unchanged: ${String(err)}`);
        processedMessages = [];
    }

    const rebuilt: ResponsesRequestBody = { ...parsed, input: rebuiltInput, tools: toolsOut };
    return { body: JSON.stringify(rebuilt), session, processedMessages, protocol: "responses", stream, compressInjected: shouldInject };
}

function injectSystem(
    parsed: AnthropicRequestBody,
    opts: ProxyOptions,
): string | AnthropicRequestBody["system"] {
    // ONLY the static compress prompt goes into the system block — it is the
    // prefix-cache anchor and must stay byte-stable across turns. The nudge
    // (which changes every turn) is appended as a trailing user message by
    // the caller (prepareAnthropic), never merged into system.
    const baseText = extractSystem(parsed.system);
    const parts: string[] = [];
    if (opts.compress.injectTool) parts.push(buildCompressSystemPrompt());
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

/** When true, the Responses path teaches compression via a text trigger
 *  instead of a function tool. Used for hosts (OpenAI Codex code_mode) whose
 *  server-side tools are disabled the moment any `tools` entry is declared.
 *  In text mode we keep `tools` untouched (undefined) so code_mode stays
 *  active, and detect the trigger in the output_text stream instead. */
const TEXT_PROTOCOL = process.env.ACP_COMPRESS_PROTOCOL === "text";
function injectResponsesTool(tools: unknown[] | undefined): unknown[] {
    if (!Array.isArray(tools)) return [COMPRESS_TOOL_RESPONSES];
    const present = new Set(
        tools
            .map((t) => (t as { name?: string })?.name)
            .filter((n): n is string => typeof n === "string"),
    );
    if (present.has(COMPRESS_TOOL_NAME)) return tools;
    return [...tools, COMPRESS_TOOL_RESPONSES];
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
    const route = resolveUpstream(opts, req.url ?? "");
    const upstreamUrl = route ? route.rewrittenUrl : opts.upstream + (req.url ?? "");
    log("info", `forward ${req.method} ${req.url ?? ""} → ${upstreamUrl}${route ? ` (${route.provider})` : ""}`);
    if (opts.debug && typeof body === "string") {
        try {
            const parsed = JSON.parse(body);
            const toolNames = (parsed.tools ?? []).map((t: Record<string, unknown>) => {
                const fn = t.function as { name?: string } | undefined;
                return fn?.name ?? "?";
            });
            log("info", `[debug] tools=[${toolNames.join(",")}] msgs=${parsed.messages?.length ?? 0} stream=${parsed.stream ?? false} system_len=${JSON.stringify(parsed.messages?.find((m: Record<string, string>) => m.role === "system")?.content ?? "").length}`);
            if (process.env.ACP_DUMP_REQ === "1") {
                const out = `/tmp/acp-proxy-debug-req-${Date.now()}.json`;
                fs.writeFileSync(out, body.slice(0, 50000));
                log("info", `[debug] forwarded body written to ${out}`);
            }
        } catch { /* best-effort */ }
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (UPSTREAM_HOP_HEADERS.has(k.toLowerCase()) || v === undefined) continue;
        headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    headers["host"] = new URL(route ? route.upstream : opts.upstream).host;
    const init: RequestInit = {
        method: req.method ?? "GET",
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    };
    const upstream = await fetchWithTimeout(upstreamUrl, init);
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
    // We only rewrite when THIS request actually had the compress tool
    // injected (per-request). For the OpenAI title-gen path
    // (`compressInjected === false`) we must NOT route the stream into a
    // rewriter — `rewriteSseStream` below is the *Anthropic* SSE rewriter
    // and would mishandle OpenAI `choices[].delta` events. Plain passthrough
    // is correct there.
    const useRewriter =
        prepared !== null &&
        prepared.compressInjected &&
        prepared.processedMessages.length > 0;
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
        if (prepared.protocol === "openai") {
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
                {
                    const s = chunk.toString("utf8");
                    if (s.includes("\x3cacp ") || s.includes("\x3c/acp")) {
                        log("warn", `[${prepared.session.id}] tag echo: openai response stream contains <acp tag`);
                    }
                }
                if (!res.write(chunk)) await new Promise<void>((r) => res.once("drain", () => r()));
            }
        } else if (prepared.protocol === "responses") {
            const parsedReq = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
            const reqHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(headers)) {
                if (k.toLowerCase() === "content-length" || k.toLowerCase() === "host") continue;
                reqHeaders[k] = v;
            }
            reqHeaders["content-type"] = "application/json";
            const loop = compressLoopResponsesStream(
                streamToRead,
                { core, config, messages: prepared.processedMessages, session: prepared.session, log: ctx.log },
                parsedReq,
                { url: upstreamUrl, headers: reqHeaders },
            );
            for await (const chunk of loop) {
                {
                    const s = chunk.toString("utf8");
                    if (s.includes("\x3cacp ") || s.includes("\x3c/acp")) {
                        log("warn", `[${prepared.session.id}] tag echo: responses response stream contains <acp tag`);
                    }
                }
                if (!res.write(chunk)) await new Promise<void>((r) => res.once("drain", () => r()));
            }
        } else {
            const rewriter = rewriteSseStream(streamToRead, ctx);
            for await (const chunk of rewriter) {
                {
                    const s = chunk.toString("utf8");
                    if (s.includes("\x3cacp ") || s.includes("\x3c/acp")) {
                        log("warn", `[${prepared.session.id}] tag echo: anthropic response stream contains <acp tag`);
                    }
                }
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
            } else if (prepared.protocol === "responses") {
                rewriteResponsesJsonResponse(json, ctx);
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
        let size = 0;
        let aborted = false;
        req.on("data", (c: Buffer) => {
            if (aborted) return;
            size += c.length;
            if (size > MAX_REQUEST_BYTES) {
                aborted = true;
                reject(new Error(`request body exceeds ${MAX_REQUEST_BYTES} bytes`));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => { if (!aborted) resolve(Buffer.concat(chunks)); });
        req.on("error", (e) => { if (!aborted) reject(e); });
    });
}

function logMsg(opts: ProxyOptions, level: string, msg: string): void {
    if (!opts.log) return;
    const ts = new Date().toISOString();
    console.error(`${ts} [${level}] ${msg}`);
}
