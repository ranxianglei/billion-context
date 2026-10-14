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

interface WireRule {
    readonly id: string;
    readonly wire: Wire;
    /** Lane scope (e.g. "codex") — the constraint only holds on that client's lane, so its
     *  enforcement lives in the lane's own fake, not in the wire's shared VALIDATOR. */
    readonly lane?: string;
    readonly summary: string;
    readonly provenance: string;
}

export const WIRE_RULES: readonly WireRule[] = [
    {
        id: "WC-017",
        wire: "responses",
        lane: "codex",
        summary:
            "codex CLI Responses WebSocket create frames carry stream:true (required field in the client's WS request struct) plus optional stream_options — bili must forward both verbatim on the upstream egress; dropping them made chatgpt.com answer with a zero-output completed turn",
        provenance:
            "bili #3063 production silent failure (codex 0.162.0-alpha.17.2 through /bili/<chatgpt.com> prefix routing on bili 0.1.183+: upstream counted input tokens, produced zero output, turn ended completed; identical via --passthrough). Cross-checked against openai/codex source: codex-rs/codex-api/src/common.rs ResponseCreateWsRequest declares stream: bool as a required serialized field (no skip_serializing_if) and serializes stream_options when present; codex-rs/core/tests/suite/client_websockets.rs asserts body[\"stream\"] == true on the wire. Repair: src/responses-ws.ts re-attaches the client's transport fields at egress (egressTransportFields); supersedes WC-013's over-generalized scope for the codex lane.",
    },
    {
        id: "WC-018",
        wire: "openai-chat",
        summary:
            'openai-chat pairs assistant tool_calls with tool results BY ORDER, not by id-set membership: every role:"tool" message must be preceded by an assistant message declaring its tool_call_id, and every declared tool_calls[].id must be answered by exactly one later role:"tool" message for that id — a premature/undeclared tool result and an unanswered or double-answered declaration are both 400s',
        provenance:
            'bili 0.1.195/0.1.196 production traffic (upstream Kimi via the OpenAI-chat wire), two mirror 400 envelopes: \'Invalid request: tool_call_id  is not found\' — the offending body carried a role:"tool" message BEFORE the assistant message declaring that tool_call_id — and \'Invalid request: an assistant message with \\\'tool_calls\\\' must be followed by tool messages responding to each \\\'tool_call_id\\\'. The following tool_call_ids did not have response messages: send_message:1\' — an assistant tool_calls entry no later tool message answered. Trigger: DSH Agent Teams re-issues a per-tool index as the id (send_message:0 / send_message:1, list_agents:0), so one id names several distinct calls. Why half a pair reaches the wire: kernel/src/prune.ts stripOrphanedToolResults / stripOrphanedToolCalls pair by id-SET membership, not by order or multiplicity — each first collects every tool-call id (resp. every tool-result id) into one Set with position ignored, then filters — so a role:"tool" result survives whenever ANY assistant call carries its id, even one declared later or a same-id duplicate from another turn, and an assistant tool_calls survives whenever ANY earlier same-id result exists; both halves of a pair can therefore be split across turns and only one side is dropped.',
    },
    {
        id: "WC-016",
        wire: "anthropic",
        summary:
            'a cache_control breakpoint with scope:"global" is only valid while every preceding block is ALSO globally scoped — in render order (tool definitions render BEFORE system blocks, then message content blocks), a global breakpoint found after any unmarked or narrower-scope content is a 400; narrowing AFTER a global breakpoint (global → ephemeral) stays legal',
        provenance:
            'bili #2648 production 400 (Claude Desktop 2.31226.1 / embedded Claude Code 2.1.295 through cert-MITM proxy mode, beta prompt-caching-scope-2026-01-05): the host notification-classifier side call pinned its system blocks to scope:"global" and sent NO tools array; bili proxy-mode injection appended six unmarked ACP tools, which render ahead of the global system blocks → upstream rejected with \'cache_control.scope: "global" is only valid when every preceding block is also globally scoped. A block with scope: "global" was found after content with a narrower cache scope. Note that tool definitions render before system blocks, so scope: "global" on system[0] is not a true prefix when tools are present.\' Repair (PR #2650): whole-request passthrough when any SYSTEM block pins scope:"global" (hasGlobalScopeSystem, src/server/prepare-anthropic.ts). Boundary (recorded per KDD #9 evidence-permitlist discipline, not fixed here): that gate scans system blocks ONLY — a host pinning a global breakpoint on tools[] with no global system block is not covered yet, and mergeOwnedTools (src/server/inject.ts) appends bili\'s unmarked tools after the client\'s, which would 400 the same way; extend the predicate to tools[] only with traffic evidence (none observed — #2648 main-loop turns were healthy).',
    },
    {
        id: "WC-015",
        wire: "responses",
        summary: "a supplied message input item id must begin with msg",
        provenance:
            "#2374: user-reported production 400 on the ChatGPT Codex backend (Invalid 'input[59].id': 'marker-1791393957942-2'. Expected an ID that begins with 'msg'.) — the first ACP compression round emitted a visibility-marker message item minted with a 'marker-<ts>-<index>' id while emitText minted msg-proxy-; the client (pi-ai) encodes a message item id into the text block's textSignature and replays it on every later request, and the ingress heal recognized only the msg-proxy- namespace, so the poisoned session 400'd every turn. The prefix rule is the Codex backend's own validation, not a bili-specific one: the identical error is reported against Codex CLI-locally-synthesized ids (openai/codex#27928 'review_rollout_user', openai/codex#20783 a bare UUID), so any locally minted message item id must satisfy it.",
    },
    {
        id: "WC-013",
        wire: "responses",
        summary: "OpenCode V2 Responses WebSocket requests use response.create and omit HTTP-only stream/background/stream_options fields — that client's contract; the codex CLI lane instead REQUIRES stream on create frames (see WC-017)",
        provenance: "OpenAI WebSocket mode guide https://developers.openai.com/api/docs/guides/websocket-mode/ (transport-specific stream/background fields are not used); OpenCode v2.0.20 open-responses-channel.ts removes these fields; bili #1844 adds a WS transport rather than sending HTTP envelopes verbatim. Scope corrected per #3063 (2026-10-13): the rule was over-generalized from the OpenCode V2 client to all WS lanes — the codex CLI's own create frames carry stream:true as a required field, and chatgpt.com answers stream-less frames with a zero-output completed turn.",
    },
    {
        id: "WC-012",
        wire: "responses",
        summary: "a supplied compaction input item id must begin with cmp",
        provenance: "#1763: user-reported upstream rejection for an fc_bili_ compaction item, Expected an ID that begins with 'cmp'; reproduced with a strict loopback upstream in tests/codex-compact-e2e.test.ts.",
    },
    {
        id: "WC-009",
        wire: "responses",
        summary: "thinking-mode providers require prior-turn reasoning items echoed in resent history — an assistant run of calls/messages with no reasoning item gets 400 code 11155 reasoning_content_missing",
        provenance:
            "bili #762 (chat wire) and #1479 (responses wire) production 400s (code 11155 'the reasoning content from the previous turn must be passed back in thinking mode'); repair = src/strict-echo.ts blank-reasoning injection on both wires, learned per upstream origin",
    },
    {
        id: "WC-008",
        wire: "openai-chat",
        summary: "Copilot Gemini requires scalar schema types and self-contained typed anyOf alternatives",
        provenance: "OpenCode V2 + Copilot Gemini synthetic reproduction: compress content type array and required-only object alternatives cause 400 invalid_request_body; explicit typed alternatives succeed",
    },
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
    {
        id: "WC-011",
        wire: "responses",
        summary:
            "consecutive configuration_update items are rejected (400 unsupported_value 'Consecutive configuration_update items are not allowed') — bili folds each adjacent run into one last-wins deep-merged item at every responses-input rebuild/forward boundary",
        provenance:
            "bili #1733 production 400 (OMP client via CLIProxyAPI): history compression prunes the messages separating two mid-history configuration_update items (untracked layout slots survive layout shrinkage verbatim) making them adjacent; hoistTrappedToolItems (#766) can also batch two trapped updates together without any compression; fix = mergeAdjacentConfigurationUpdates in src/responses-tool-output.ts applied at patchResponsesInputWithToolImages + all hoistTrappedToolItems call sites",
    },
    {
        id: "WC-010",
        wire: "anthropic",
        summary:
            "at most 4 cache_control breakpoints per request, counted across system blocks + tools entries + message content blocks COMBINED; a 5th is a 400",
        provenance:
            "Anthropic prompt-caching API reference ('you can define up to 4 cache breakpoints'); surfaced by the #1639 review — the #1637 stamping emits 1 system + 3 message marks and anthropicToCore harvests client marks from message blocks only, so a client marking only its tools array would have combined into a 5th breakpoint; repair = tools-mark detection suppresses bili's stamps (src/loop/cache-control.ts anthropicToolsCarryCacheControl)",
    },
    {
        id: "WC-013",
        wire: "responses",
        summary:
            "no reasoning.summary — not part of the OpenAI Responses API (reasoning carries effort only); strict-schema upstreams reject the unknown field with 'json: unknown field \"summary\"'. Clients such as pi-ai always send reasoning:{effort,summary:\"auto\"} when a thinking tier is requested, so bili strips it via opt-in compat.dropFields (#1757) — unconfigured, it stays untouched.",
        provenance:
            "bili #1757 per-field measurement against SenseNova's Responses gateway https://token.sensenova.cn/v1/responses (2026-09-30): every pi-ai outbound field 200 except reasoning.summary → 400 code InvalidParameter; OpenAI Responses API reference (reasoning.effort is the only documented subfield)",
    },
    {
        id: "WC-014",
        wire: "responses",
        summary:
            "strict Jinja-template backends (Qwen family served by vLLM/SGLang) reject any role:\"system\" message that is not the first chat-producing item — or any second system — raising \"System message must be at the beginning.\" from chat_template.jinja; bili never emits such items itself (front block/anchors ride as developer, nudges/separators as user, top-level instructions stripped), so offenders are client-origin mid-history system items forwarded verbatim by the plugin-mode position-preserving pass-through (#1638); repair = learn-on-failure placement entry (src/compat-roles.ts hasOffHeadSystem → single system→user rewrite hop, remembered per session)",
        provenance:
            "bili #1996 production 400 (vLLM /v1/responses serving a Qwen model: artifact:chat_template.jinja Jinja Exception \"System message must be at the beginning.\", code invalid_prompt, every post-compression request of two OMP plugin-mode sessions, 2026-10-03); vLLM Responses→chat passes role-bearing items verbatim (vllm/entrypoints/openai/responses/utils.py _construct_message_from_response_item)",
    },
];

// ---------------------------------------------------------------------------
// Header-level upstream constraints (#2760). Orthogonal to the per-protocol
// BODY validators below: these bind on HTTP headers at a specific upstream
// host, not on the request body. Each rule has a matching header validator +
// validation-parity fake (tests/wire-contract-go-session.test.ts), checked by
// the ledger self-check in tests/wire-contract.test.ts. The ledger grows.
// ---------------------------------------------------------------------------

interface WireHeaderRule {
    readonly id: string;
    readonly summary: string;
    readonly provenance: string;
}

export const WIRE_HEADER_RULES: readonly WireHeaderRule[] = [
    {
        id: "WC-016",
        summary: "OpenCode Go (/zen/go) rejects any request lacking a stable x-opencode-session header — HTTP 400 MissingSessionID; bili's independent summary calls must stamp it plus bili's own user agent, derived from bili's own conversation id, never copied from the client's inbound session/auth headers",
        provenance: "#2760: user-reported production 400 against https://opencode.ai/zen/go/v1/chat/completions (real-call A/B, 2026-10-11) — a non-streaming Go summary call returns HTTP 400 MissingSessionID until a stable x-opencode-session is added; stream=true does NOT help. Official contract https://opencode.ai/docs/go/#where-can-i-use-it requires typical coding-agent traffic, the client's own user agent, and a per-conversation stable x-opencode-session for routing + prompt cache.",
    },
];

/** The exact upstream error Go answers when x-opencode-session is absent (#2760). */
export function goMissingSessionIdEnvelope(): { status: number; body: string } {
    return {
        status: 400,
        body: JSON.stringify({
            error: { type: "MissingSessionID", message: "Request is missing x-opencode-session and cannot be routed efficiently. Please see https://opencode.ai/docs/go/#where-can-i-use-it" },
        }),
    };
}

/** WC-016: models OpenCode Go's strictest header validation — a non-empty
 *  x-opencode-session is mandatory. Apply only to requests destined for Go. */
export function validateGoSessionHeaders(headers: Record<string, unknown>): string[] {
    const value = headers["x-opencode-session"];
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text !== "string" || text.trim().length === 0)
        return ["WC-016 OpenCode Go requires a stable x-opencode-session header (HTTP 400 MissingSessionID, #2760)"];
    return [];
}

const ANTHROPIC_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const OPENAI_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const GOOGLE_FN_NAME_RE = /^[a-zA-Z0-9_]+$/;
const TOP_LEVEL_COMBINATORS = ["oneOf", "allOf", "anyOf", "not"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** WC-001..WC-003, WC-007, WC-010, WC-016 on an Anthropic /v1/messages body. Returns violation strings. */
function validateAnthropicBody(body: unknown): string[] {
    const out: string[] = [];
    if (!isPlainObject(body)) return out;
    if ("prompt_cache_key" in body)
        out.push("WC-007 top-level prompt_cache_key is not part of the Anthropic Messages API (#1403)");
    // WC-010 runs before the tools early-return: breakpoints can live in
    // system blocks and message content blocks with no tools array at all.
    let breakpoints = 0;
    if (Array.isArray(body.system))
        for (const b of body.system) if (isPlainObject(b) && b.cache_control !== undefined) breakpoints++;
    if (Array.isArray(body.tools))
        for (const t of body.tools) if (isPlainObject(t) && t.cache_control !== undefined) breakpoints++;
    if (Array.isArray(body.messages))
        for (const m of body.messages) {
            if (!isPlainObject(m) || !Array.isArray(m.content)) continue;
            for (const b of m.content) if (isPlainObject(b) && b.cache_control !== undefined) breakpoints++;
        }
    if (breakpoints > 4)
        out.push(`WC-010 ${breakpoints} cache_control breakpoints (system + tools + messages combined) — Anthropic allows at most 4`);
    // WC-016 runs before the tools early-return: a violating global breakpoint
    // can sit in system or messages with no tools array at all. Render order is
    // tools → system → message content blocks (the API renders tool definitions
    // BEFORE system); a scope:"global" breakpoint stays legal only while every
    // preceding block is also globally scoped — unmarked blocks default to the
    // session scope, so they poison every later global breakpoint too (#2648).
    {
        let sawNonGlobal = false;
        const visit = (cc: unknown): void => {
            const scope = isPlainObject(cc) ? cc.scope : undefined;
            if (scope === "global") {
                if (sawNonGlobal)
                    out.push('WC-016 cache_control.scope:"global" found after content without a global scope — every preceding block must be globally scoped too (tools render before system, #2648)');
            } else sawNonGlobal = true;
        };
        if (Array.isArray(body.tools))
            for (const t of body.tools) visit(isPlainObject(t) ? t.cache_control : undefined);
        if (Array.isArray(body.system))
            for (const b of body.system) visit(isPlainObject(b) ? b.cache_control : undefined);
        if (Array.isArray(body.messages))
            for (const m of body.messages) {
                if (!isPlainObject(m) || !Array.isArray(m.content)) continue;
                for (const b of m.content) visit(isPlainObject(b) ? b.cache_control : undefined);
            }
    }
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
    if (!isPlainObject(body)) return out;
    // WC-018: runs before the tools early-return — tool/assistant pairing binds
    // on any messages array. Order + multiplicity, never id-set membership:
    // host-minted ids repeat (a name:index id names several distinct calls).
    if (Array.isArray(body.messages)) {
        const declared = new Map<string, number>();
        const answered = new Map<string, number>();
        body.messages.forEach((m, i) => {
            if (!isPlainObject(m)) return;
            const calls = m.role === "assistant" ? m.tool_calls : undefined;
            if (Array.isArray(calls)) {
                for (const tc of calls) {
                    if (!isPlainObject(tc) || typeof tc.id !== "string") continue;
                    declared.set(tc.id, (declared.get(tc.id) ?? 0) + 1);
                }
            } else if (m.role === "tool") {
                const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
                const pending = (declared.get(id) ?? 0) - (answered.get(id) ?? 0);
                if (pending <= 0)
                    out.push(`WC-018 messages[${i}]: tool_call_id "${id}" is not declared by a preceding assistant tool_calls (upstream: "tool_call_id ${id} is not found")`);
                else answered.set(id, (answered.get(id) ?? 0) + 1);
            }
        });
        const unanswered = [...declared].filter(([id, n]) => (answered.get(id) ?? 0) < n).map(([id]) => id);
        if (unanswered.length > 0)
            out.push(`WC-018 messages: assistant tool_calls ids not answered by a later tool message: ${unanswered.join(", ")} (upstream: an assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id')`);
    }
    if (!Array.isArray(body.tools)) return out;
    body.tools.forEach((t, i) => {
        if (!isPlainObject(t)) return;
        const fn = t.function;
        if (!isPlainObject(fn)) return; // non-function tool kinds are not validated here
        const label = `tools[${i}] (${fn.name ?? "?"})`;
        if (typeof fn.name !== "string" || !OPENAI_TOOL_NAME_RE.test(fn.name))
            out.push(`WC-004 ${label}: function.name must match ${OPENAI_TOOL_NAME_RE}`);
        const params = fn.parameters;
        if (typeof body.model === "string" && body.model.startsWith("gemini-")) {
            validateGeminiSchema(params, label, out);
        }
        if (!isPlainObject(params) || params.type !== "object")
            out.push(`WC-004 ${label}: function.parameters must be an object with type:"object"`);
        for (const kw of TOP_LEVEL_COMBINATORS) {
            if (isPlainObject(params) && kw in params)
                out.push(`WC-004 ${label}: top-level "${kw}" not portable — banned on every wire shape (#1302 policy, restored by #1305 review)`);
        }
    });
    return out;
}

function validateGeminiSchema(schema: unknown, path: string, out: string[]): void {
    if (!isPlainObject(schema)) return;
    if (Array.isArray(schema.type)) out.push(`WC-008 ${path}: type must be scalar`);
    if (Array.isArray(schema.anyOf)) {
        schema.anyOf.forEach((branch, i) => {
            if (!isPlainObject(branch) || typeof branch.type !== "string")
                out.push(`WC-008 ${path}.anyOf[${i}]: alternative must declare its type`);
            validateGeminiSchema(branch, `${path}.anyOf[${i}]`, out);
        });
    }
    if (isPlainObject(schema.properties)) {
        for (const [key, value] of Object.entries(schema.properties))
            validateGeminiSchema(value, `${path}.${key}`, out);
    }
    validateGeminiSchema(schema.items, `${path}.items`, out);
}

/** WC-005, WC-009, WC-011, WC-012, WC-013 on a Responses-API body (flat function entries). */
export function validateResponsesBody(body: unknown): string[] {
    const out: string[] = [];
    if (!isPlainObject(body)) return out;
    if (body.type === "response.create") out.push(...validateResponsesWsCreate(body));
    // WC-011 (#1733): runs before the tools early-return — the adjacency ban
    // applies to any array input, tools or not.
    if (Array.isArray(body.input)) {
        for (let i = 1; i < body.input.length; i++) {
            const prev = body.input[i - 1];
            const cur = body.input[i];
            if (isPlainObject(prev) && prev.type === "configuration_update" && isPlainObject(cur) && cur.type === "configuration_update")
                out.push(`WC-011 input[${i}]: consecutive configuration_update items are not allowed`);
        }
        body.input.forEach((item, i) => {
            if (isPlainObject(item) && item.type === "compaction" && item.id !== undefined
                && (typeof item.id !== "string" || !item.id.startsWith("cmp")))
                out.push(`WC-012 input[${i}].id: expected an ID that begins with 'cmp'`);
        });
        // WC-015: message items validate their id prefix too — bili's
        // visibility markers minted "marker-<ts>-<index>" until both emit
        // paths were unified onto the msg-proxy- namespace.
        body.input.forEach((item, i) => {
            if (!isPlainObject(item)) return;
            const isMessage = item.type === "message"
                || (item.type === undefined && (item.role === "user" || item.role === "assistant"));
            if (!isMessage || item.id === undefined) return;
            if (typeof item.id === "string" && item.id.startsWith("msg")) return;
            out.push(`WC-015 input[${i}].id: expected an ID that begins with 'msg'`);
        });
    }
    // WC-013 (#1757): runs before the tools early-return — reasoning.summary
    // exists on bodies without tools.
    if (isPlainObject(body.reasoning) && "summary" in body.reasoning)
        out.push('WC-013 reasoning.summary is not part of the OpenAI Responses API — strict-schema upstreams 400 (json: unknown field "summary"); drop it via compat.dropFields (#1757)');
    // WC-014 (#1996): runs before the tools early-return — strict Jinja
    // templates raise on any system message that is not the first
    // chat-producing item, or on a duplicate system. Mirrors
    // src/compat-roles.ts hasOffHeadSystem eligibility exactly; a non-empty
    // top-level instructions becomes a leading system upstream.
    if (Array.isArray(body.input)) {
        const wc14RoleProducing = new Set([
            "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "reasoning",
        ]);
        const hasInstructions = typeof body.instructions === "string" && body.instructions.length > 0;
        let systems = 0;
        let firstSlotIdx = -1;
        let firstSystemIdx = -1;
        body.input.forEach((item, i) => {
            if (!isPlainObject(item)) return;
            const t = item.type;
            const isMessage = t === undefined || t === "message";
            if (!isMessage && !wc14RoleProducing.has(t as string)) return;
            if (firstSlotIdx < 0) firstSlotIdx = i;
            if (isMessage && item.role === "system") {
                systems++;
                if (firstSystemIdx < 0) firstSystemIdx = i;
            }
        });
        if (systems > 1)
            out.push(`WC-014 ${systems} system messages — strict Jinja templates: system messages must be at the beginning, exactly one (#1996)`);
        else if (systems === 1 && (hasInstructions || firstSystemIdx !== firstSlotIdx))
            out.push(`WC-014 input[${firstSystemIdx}]: system message must be at the beginning (strict Jinja templates reject off-head system roles, #1996)`);
    }
    if (!Array.isArray(body.tools)) return out;
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
    // WC-009 (#762 chat / #1479 responses): thinking-mode providers reject resent
    // history where an assistant run (calls/messages) carries no reasoning item —
    // 400 code 11155 reasoning_content_missing. Validation-parity: the fake enforces
    // the strictest known shape; the repair (src/strict-echo.ts) injects a blank
    // reasoning item at orphan run starts before forwarding.
    if (Array.isArray(body.input)) {
        const RUN_ITEMS = new Set(["reasoning", "function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"]);
        let runStart = -1;
        let runHasReasoning = false;
        const closeRun = (endIdx: number): void => {
            if (runStart >= 0 && !runHasReasoning)
                out.push(`WC-009 input[${runStart}..${endIdx}]: assistant run carries no reasoning item — thinking-mode providers 400 code 11155 reasoning_content_missing`);
            runStart = -1;
            runHasReasoning = false;
        };
        body.input.forEach((it, i) => {
            if (!isPlainObject(it)) {
                closeRun(i - 1);
                return;
            }
            if (it.type === "reasoning") {
                if (runStart < 0) runStart = i;
                runHasReasoning = true;
                return;
            }
            if (RUN_ITEMS.has(it.type as string) || (it.type === "message" && it.role === "assistant")) {
                if (runStart < 0) runStart = i;
                return;
            }
            closeRun(i - 1);
        });
        closeRun(body.input.length - 1);
    }
    return out;
}

export function validateResponsesWsCreate(body: unknown): string[] {
    if (!isPlainObject(body) || body.type !== "response.create") return ["WC-013: expected response.create WebSocket event"];
    return ["stream", "stream_options", "background"].filter(key => key in body).map(key => `WC-013: HTTP-only ${key} must not reach WebSocket response.create`);
}

/** WC-017 on a codex-lane create frame: stream:true is REQUIRED (the client's request
 *  struct declares it without skip_serializing_if) — the inverse of WC-013's opencode lane. */
export function validateCodexResponsesWsCreate(body: unknown): string[] {
    if (!isPlainObject(body) || body.type !== "response.create") return ["WC-017: expected response.create WebSocket event"];
    const out: string[] = [];
    if (body.stream !== true) out.push("WC-017: codex response.create must carry stream:true — required field in the codex WS request struct; dropping it made chatgpt.com answer with a zero-output completed turn (#3063)");
    if (body.background !== undefined) out.push("WC-017: codex response.create must not carry background");
    return out;
}

/** WC-006 on a Gemini generateContent/streamGenerateContent body. */
function validateGoogleBody(body: unknown): string[] {
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

interface FakeUpstream {
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
