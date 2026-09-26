// Wire-contract fake upstreams (#1304 item 1).
//
// Deterministic per-protocol fakes that stand in for the REAL upstreams in
// every test. Each fake enforces, on EVERY request it receives, the strictest
// known validation of the real upstream it imitates — so a request bili
// forwards that would 400 at api.anthropic.com / api.openai.com / generativelanguage
// dies HERE, in CI, with a rule id pointing at the ledger entry.
//
// The WIRE_RULES array below is the machine-readable half of the wire-
// constraint ledger. Provenance for each rule (where the constraint was
// learned) is documented alongside; AGENTS.md "Wire-constraint ledger" is the
// institutional rule: the ledger only grows — every new upstream rejection or
// documented constraint becomes an entry here + a validator clause inside the
// fixing PR.

import http from "node:http";
import { once } from "node:events";

export type Wire = "anthropic" | "openai-chat" | "responses" | "google";

export interface WireRule {
    readonly id: string;
    readonly wire: Wire;
    readonly summary: string;
    readonly provenance: string;
}

export const WIRE_RULES: readonly WireRule[] = [
    {
        id: "WC-001",
        wire: "anthropic",
        summary: "tools[].input_schema must not carry top-level oneOf/allOf/anyOf/not",
        provenance:
            "bili #1299 production 400 (api.anthropic.com: 'input_schema does not support oneOf, allOf, or anyOf at the top level'); fixed acp-kernel #404/#405 v0.0.89; policy codified in acp-kernel compress-tools.d.ts ('Wire-legality constraint')",
    },
    {
        id: "WC-002",
        wire: "anthropic",
        summary: "tools[].input_schema must be a JSON object with type:'object'",
        provenance:
            "bili #1299 production 400 ('Input schema should be an object'); Anthropic Messages API reference (tools[].input_schema)",
    },
    {
        id: "WC-003",
        wire: "anthropic",
        summary: "tool name must match ^[a-zA-Z0-9_-]{1,128}$",
        provenance: "Anthropic Messages API reference (tools[].name)",
    },
    {
        id: "WC-004",
        wire: "openai-chat",
        summary:
            "function tool name matches ^[a-zA-Z0-9_-]{1,64}$, function.parameters.type === 'object', and no top-level oneOf/allOf/anyOf/not",
        provenance:
            "OpenAI Chat Completions API reference (function calling; strict mode rejects parameter schemas that are not plain objects); top-level-combinator ban restored from the old #1302 gate (bili schema portability policy) — dropped during the #1305 consolidation, caught by review mutation C",
    },
    {
        id: "WC-005",
        wire: "responses",
        summary:
            "function tool name matches ^[a-zA-Z0-9_-]{1,64}$, parameters.type === 'object', and no top-level oneOf/allOf/anyOf/not",
        provenance:
            "OpenAI Responses API reference (tools[].name / tools[].parameters); top-level-combinator ban restored from the old #1302 gate (same portability policy as WC-004)",
    },
    {
        id: "WC-006",
        wire: "google",
        summary:
            "functionDeclarations[].name matches ^[a-zA-Z0-9_]+$ and parameters is a plain object (type:'object') with no top-level combinators",
        provenance:
            "Gemini API reference (function declaration naming: letters/digits/underscore); kernel deliberate combinator-free policy on this wire (acp-kernel compress-tools.d.ts)",
    },
    {
        id: "WC-007",
        wire: "anthropic",
        summary:
            "no top-level prompt_cache_key — not part of the Anthropic Messages API; strict-schema upstreams reject unknown fields ('Extra inputs are not permitted'). bili's omp plugin stamps it as the session id (#268), so the proxy strips it on EVERY forward path (processed + verbatim).",
        provenance:
            "bili #1403 production 400 (opencode zen https://opencode.ai/zen/v1/messages: 'prompt_cache_key: Extra inputs are not permitted', 2026-09-26); Anthropic Messages API reference (no such field)",
    },
];

const ANTHROPIC_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const OPENAI_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const GOOGLE_FN_NAME_RE = /^[a-zA-Z0-9_]+$/;
const TOP_LEVEL_COMBINATORS = ["oneOf", "allOf", "anyOf", "not"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** WC-001..WC-003, WC-007 on an Anthropic /v1/messages body. Returns violation strings. */
export function validateAnthropicBody(body: unknown): string[] {
    const out: string[] = [];
    if (!isPlainObject(body)) return out;
    if ("prompt_cache_key" in body)
        out.push("WC-007 top-level prompt_cache_key is not part of the Anthropic Messages API (#1403)");
    if (!Array.isArray(body.tools)) return out;
    body.tools.forEach((t, i) => {
        if (!isPlainObject(t)) {
            out.push(`WC-002 tools[${i}]: tool entry must be an object`);
            return;
        }
        const label = `tools[${i}]${typeof t.name === "string" ? ` (${t.name})` : ""}`;
        if (typeof t.name !== "string" || !ANTHROPIC_TOOL_NAME_RE.test(t.name))
            out.push(`WC-003 ${label}: name must match ${ANTHROPIC_TOOL_NAME_RE}`);
        const schema = t.input_schema;
        if (!isPlainObject(schema)) {
            out.push(`WC-002 ${label}: input_schema must be a JSON object`);
            return;
        }
        if (schema.type !== "object") out.push(`WC-002 ${label}: input_schema.type must be "object"`);
        for (const kw of TOP_LEVEL_COMBINATORS) {
            if (kw in schema) out.push(`WC-001 ${label}: top-level "${kw}" rejected by Anthropic (#1299)`);
        }
    });
    return out;
}

/** WC-004 on an OpenAI chat/completions body (only function-typed entries). */
export function validateOpenAiChatBody(body: unknown): string[] {
    const out: string[] = [];
    if (!isPlainObject(body) || !Array.isArray(body.tools)) return out;
    body.tools.forEach((t, i) => {
        if (!isPlainObject(t)) return;
        const fn = t.function;
        if (!isPlainObject(fn)) return; // non-function tool kinds are not validated here
        const label = `tools[${i}] (${fn.name ?? "?"})`;
        if (typeof fn.name !== "string" || !OPENAI_TOOL_NAME_RE.test(fn.name))
            out.push(`WC-004 ${label}: function.name must match ${OPENAI_TOOL_NAME_RE}`);
        const params = fn.parameters;
        if (!isPlainObject(params) || params.type !== "object")
            out.push(`WC-004 ${label}: function.parameters must be an object with type:"object"`);
        for (const kw of TOP_LEVEL_COMBINATORS) {
            if (isPlainObject(params) && kw in params)
                out.push(`WC-004 ${label}: top-level "${kw}" not portable — banned on every wire shape (#1302 policy, restored by #1305 review)`);
        }
    });
    return out;
}

/** WC-005 on a Responses-API body (flat function entries). */
export function validateResponsesBody(body: unknown): string[] {
    const out: string[] = [];
    if (!isPlainObject(body) || !Array.isArray(body.tools)) return out;
    body.tools.forEach((t, i) => {
        if (!isPlainObject(t)) return;
        if (t.type !== "function") return;
        const label = `tools[${i}] (${t.name ?? "?"})`;
        if (typeof t.name !== "string" || !OPENAI_TOOL_NAME_RE.test(t.name))
            out.push(`WC-005 ${label}: name must match ${OPENAI_TOOL_NAME_RE}`);
        const params = t.parameters;
        if (!isPlainObject(params) || params.type !== "object")
            out.push(`WC-005 ${label}: parameters must be an object with type:"object"`);
        for (const kw of TOP_LEVEL_COMBINATORS) {
            if (isPlainObject(params) && kw in params)
                out.push(`WC-005 ${label}: top-level "${kw}" not portable — banned on every wire shape (#1302 policy, restored by #1305 review)`);
        }
    });
    return out;
}

/** WC-006 on a Gemini generateContent/streamGenerateContent body. */
export function validateGoogleBody(body: unknown): string[] {
    const out: string[] = [];
    if (!isPlainObject(body) || !Array.isArray(body.tools)) return out;
    body.tools.forEach((entry, i) => {
        if (!isPlainObject(entry) || !Array.isArray(entry.functionDeclarations)) return;
        entry.functionDeclarations.forEach((d, j) => {
            if (!isPlainObject(d)) return;
            const label = `tools[${i}].functionDeclarations[${j}] (${d.name ?? "?"})`;
            if (typeof d.name !== "string" || !GOOGLE_FN_NAME_RE.test(d.name))
                out.push(`WC-006 ${label}: name must match ${GOOGLE_FN_NAME_RE}`);
            const params = d.parameters;
            if (params === undefined) return;
            if (!isPlainObject(params) || params.type !== "object") {
                out.push(`WC-006 ${label}: parameters must be an object with type:"object"`);
                return;
            }
            for (const kw of TOP_LEVEL_COMBINATORS) {
                if (kw in params) out.push(`WC-006 ${label}: top-level "${kw}" not used on this wire (kernel policy)`);
            }
        });
    });
    return out;
}

export const VALIDATORS: Record<Wire, (body: unknown) => string[]> = {
    anthropic: validateAnthropicBody,
    "openai-chat": validateOpenAiChatBody,
    responses: validateResponsesBody,
    google: validateGoogleBody,
};

export interface CapturedRequest {
    url: string;
    body: unknown;
}

export interface FakeUpstream {
    wire: Wire;
    port: number;
    url: string;
    requests: CapturedRequest[];
    violations: string[];
    close(): Promise<void>;
}

function sse(res: http.ServerResponse, events: Array<[string, unknown]>): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    // OpenAI streams carry no `event:` line at all — only Anthropic/Gemini name their events.
    for (const [ev, data] of events) {
        if (ev) res.write(`event: ${ev}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
}

function anthropicReply(res: http.ServerResponse, text: string): void {
    sse(res, [
        ["message_start", { type: "message_start", message: { id: "msg_fake", role: "assistant", usage: { input_tokens: 10 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
        ["message_stop", { type: "message_stop" }],
    ]);
}

function openAiChatReply(res: http.ServerResponse, parsed: Record<string, unknown>, text: string): void {
    if (parsed.stream === true) {
        sse(res, [
            ["", { id: "chatcmpl_fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }],
            ["", { id: "chatcmpl_fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }],
        ]);
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        id: "chatcmpl_fake",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }));
}

function responsesReply(res: http.ServerResponse, parsed: Record<string, unknown>, text: string): void {
    const msgId = "msg_fake";
    const msg = { type: "message", id: msgId, role: "assistant", content: [{ type: "output_text", text }] };
    if (parsed.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            id: "resp_fake", object: "response", status: "completed", output: [msg],
            usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        }));
        return;
    }
    sse(res, [
        ["response.created", { type: "response.created", response: { id: "resp_fake", status: "in_progress", output: [] } }],
        ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", id: msgId, role: "assistant", content: [] } }],
        ["response.content_part.added", { type: "response.content_part.added", item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }],
        ["response.output_text.delta", { type: "response.output_text.delta", item_id: msgId, output_index: 0, content_index: 0, delta: text }],
        ["response.output_text.done", { type: "response.output_text.done", item_id: msgId, output_index: 0, content_index: 0, text }],
        ["response.content_part.done", { type: "response.content_part.done", item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text } }],
        ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: msg }],
        ["response.completed", { type: "response.completed", response: { id: "resp_fake", status: "completed", output: [msg], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } }],
    ]);
}

function googleReply(res: http.ServerResponse, text: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, index: 0 }], modelVersion: "fake" })}\n\n`);
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [] }, index: 0, finishReason: "STOP" }], modelVersion: "fake", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } })}\n\n`);
    res.end();
}

function errorEnvelope(wire: Wire, message: string): { status: number; body: string } {
    switch (wire) {
        case "anthropic":
            return { status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }) };
        case "google":
            return { status: 400, body: JSON.stringify({ error: { code: 400, message, status: "INVALID_ARGUMENT" } }) };
        default:
            return { status: 400, body: JSON.stringify({ error: { message, type: "invalid_request_error" } }) };
    }
}

const PATH_MATCHERS: Record<Wire, (url: string) => boolean> = {
    anthropic: (u) => u.startsWith("/v1/messages"),
    "openai-chat": (u) => u.startsWith("/v1/chat/completions"),
    responses: (u) => u.startsWith("/v1/responses"),
    google: (u) => /\/v1beta\/models\/[^/:]+:(streamGenerateContent|generateContent)/.test(u),
};

/** Start a deterministic fake upstream for one wire protocol on a random loopback port. */
export async function startFakeUpstream(wire: Wire, opts?: { replyText?: string }): Promise<FakeUpstream> {
    const replyText = opts?.replyText ?? "ok";
    const requests: CapturedRequest[] = [];
    const violations: string[] = [];
    const validate = VALIDATORS[wire];
    const pathOk = PATH_MATCHERS[wire];

    const server = http.createServer((req, res) => {
        if (req.method === "GET" && wire === "responses" && req.url?.startsWith("/v1/models")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ object: "list", data: [] }));
            return;
        }
        if (req.method !== "POST" || !req.url || !pathOk(req.url.split("?")[0])) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "not found" } }));
            return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: unknown = {};
            try {
                parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            } catch { /* non-JSON body: nothing to validate */ }
            const found = validate(parsed);
            requests.push({ url: req.url ?? "", body: parsed });
            if (found.length > 0) {
                violations.push(...found);
                const env = errorEnvelope(wire, `wire-contract violation(s): ${found.join("; ")}`);
                res.writeHead(env.status, { "content-type": "application/json" });
                res.end(env.body);
                return;
            }
            const p = isPlainObject(parsed) ? parsed : {};
            switch (wire) {
                case "anthropic": anthropicReply(res, replyText); break;
                case "openai-chat": openAiChatReply(res, p, replyText); break;
                case "responses": responsesReply(res, p, replyText); break;
                case "google": googleReply(res, replyText); break;
            }
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    return {
        wire,
        port,
        url: `http://127.0.0.1:${port}`,
        requests,
        violations,
        close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
}
