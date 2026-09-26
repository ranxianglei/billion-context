/**
 * ACP tool surface — thin re-export from acp-kernel (Phase K1).
 *
 * The schemas, prompt builders, text tags and parseCompressInput moved to
 * acp-kernel `src/compress-tools.ts` verbatim; this module keeps the proxy's
 * historical import paths and names stable:
 *  - PROXY_TOOL_NAMES / MUTATING_PROXY_TOOLS / READONLY_PROXY_TOOLS alias the
 *    kernel's ACP_* names ("proxy" is a misnomer once shared);
 *  - parseCompressInput wires the kernel's onWarn hook into the proxy logger.
 *    (The #603 single-quote salvage lives in the kernel ladder since 0.0.59;
 *    this wrapper only surfaces its diagnostics.)
 */
import {
    parseCompressArgs,
    ABSORB_TOOL,
    ABSORB_TOOL_GOOGLE,
    ABSORB_TOOL_OPENAI,
    DECOMPRESS_TOOL,
    DECOMPRESS_TOOL_GOOGLE,
    DECOMPRESS_TOOL_NAME,
    DECOMPRESS_TOOL_OPENAI,
    DECOMPRESS_TOOL_RESPONSES,
    IMAGE_FULL_TOOL,
    IMAGE_FULL_TOOL_NAME,
    IMAGE_FULL_TOOL_OPENAI,
    IMAGE_FULL_TOOL_RESPONSES,
    RETRIEVE_TOOL_NAME,
    RULE_TOOL_NAME,
    SEARCH_CONTEXT_TOOL,
    SEARCH_CONTEXT_TOOL_GOOGLE,
    SEARCH_CONTEXT_TOOL_OPENAI,
    SEARCH_CONTEXT_TOOL_RESPONSES,
    SEARCH_CONTEXT_TOOL_NAME,
    ACP_TOOLS_ANTHROPIC,
    ACP_TOOLS_GOOGLE,
    ACP_TOOLS_OPENAI,
    ACP_TOOLS_RESPONSES,
    ACP_READONLY_TOOLS_RESPONSES,
} from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import { maxShrinkPerCompress } from "./fetch-util.js";

export {
    COMPRESS_TOOL_NAME,
    DECOMPRESS_TOOL_NAME,
    SEARCH_CONTEXT_TOOL_NAME,
    ACP_STATUS_TOOL_NAME,
    ACP_TEXT_OPEN,
    ACP_TEXT_CLOSE,
    ACP_STATUS_OPEN,
    ACP_STATUS_CLOSE,
    ACP_SEARCH_OPEN,
    ACP_SEARCH_CLOSE,
    ACP_DECOMPRESS_OPEN,
    ACP_DECOMPRESS_CLOSE,
    COMPRESS_TOOL,
    COMPRESS_TOOL_OPENAI,
    COMPRESS_TOOL_RESPONSES,
    COMPRESS_TOOL_GOOGLE,
    DECOMPRESS_TOOL,
    DECOMPRESS_TOOL_OPENAI,
    DECOMPRESS_TOOL_RESPONSES,
    DECOMPRESS_TOOL_GOOGLE,
    SEARCH_CONTEXT_TOOL,
    SEARCH_CONTEXT_TOOL_OPENAI,
    SEARCH_CONTEXT_TOOL_RESPONSES,
    SEARCH_CONTEXT_TOOL_GOOGLE,
    ACP_STATUS_TOOL,
    ACP_STATUS_TOOL_OPENAI,
    ACP_STATUS_TOOL_RESPONSES,
    ACP_STATUS_TOOL_GOOGLE,
    ACP_TOOLS_OPENAI,
    ACP_TOOLS_ANTHROPIC,
    ACP_TOOLS_RESPONSES,
    ACP_TOOLS_GOOGLE,
    ACP_READONLY_TOOLS_RESPONSES,
    buildCompressSystemPrompt,
    buildCompressTextSystemPrompt,
    buildCompressHybridSystemPrompt,
    ABSORB_TOOL_NAME,
    ABSORB_TOOL,
    ABSORB_TOOL_OPENAI,
    ABSORB_TOOL_GOOGLE,
    buildAbsorbSystemPrompt,
    RULE_TOOL_NAME,
} from "acp-kernel";
export type { ParsedRange, AbsorbConfig } from "acp-kernel";
export { ACP_TOOL_NAMES as PROXY_TOOL_NAMES, ACP_MUTATING_TOOLS as MUTATING_PROXY_TOOLS, ACP_READONLY_TOOLS as READONLY_PROXY_TOOLS } from "acp-kernel";

// #841: host-side conversation_id extension of search_context. Kernel constants
// are shared and never mutated; ALL wire-mode injection points must use these
// BILI_ arrays or the served schema drifts between wire mode and plugin mode
// (the plugin manifest reuses SEARCH_CONTEXT_CONVERSATION_ID_PARAM below).
export const SEARCH_CONTEXT_CONVERSATION_ID_PARAM = {
    type: "string",
    description: "Target bili conversation id. Defaults to the current conversation. May reference another historical pfa-* session for read-only search.",
};

type JsonSchemaObject = { type: string; properties?: Record<string, unknown>; required?: string[] };

function withConversationId(schema: JsonSchemaObject): JsonSchemaObject {
    return { ...schema, properties: { ...schema.properties, conversation_id: SEARCH_CONTEXT_CONVERSATION_ID_PARAM } };
}

export const BILI_SEARCH_CONTEXT_TOOL = {
    name: SEARCH_CONTEXT_TOOL.name,
    description: SEARCH_CONTEXT_TOOL.description,
    input_schema: withConversationId(SEARCH_CONTEXT_TOOL.input_schema),
};

export const BILI_SEARCH_CONTEXT_TOOL_OPENAI = {
    type: "function" as const,
    function: {
        name: SEARCH_CONTEXT_TOOL_OPENAI.function.name,
        description: SEARCH_CONTEXT_TOOL_OPENAI.function.description,
        parameters: withConversationId(SEARCH_CONTEXT_TOOL_OPENAI.function.parameters),
    },
};

export const BILI_SEARCH_CONTEXT_TOOL_RESPONSES = {
    type: "function" as const,
    name: SEARCH_CONTEXT_TOOL_RESPONSES.name,
    description: SEARCH_CONTEXT_TOOL_RESPONSES.description,
    parameters: withConversationId(SEARCH_CONTEXT_TOOL_RESPONSES.parameters),
};

export const BILI_SEARCH_CONTEXT_TOOL_GOOGLE = {
    name: SEARCH_CONTEXT_TOOL_GOOGLE.name,
    description: SEARCH_CONTEXT_TOOL_GOOGLE.description,
    parameters: withConversationId(SEARCH_CONTEXT_TOOL_GOOGLE.parameters),
};

// #1179 CCR v2: host-side range-restore extension of decompress. Optional
// startId/endId (mNNNNN refs) restore only the block's messages inside that
// span instead of the whole block. Served unconditionally on every wire + the
// plugin manifest (one definition, no drift — same rule as conversation_id
// above); execution is gated on CCR being armed for the session
// (resolveDecompressRange fails explicitly when it is not).
const DECOMPRESS_RANGE_PARAM_START = {
    type: "string",
    description: "Optional mNNNNN message ref, inclusive lower bound of a sub-range of this block. With endId, restores only that span instead of the whole block (requires CCR: compress.ccr.enabled).",
};
const DECOMPRESS_RANGE_PARAM_END = {
    type: "string",
    description: "Optional mNNNNN message ref, inclusive upper bound. Used together with startId.",
};

function withRangeParams(schema: JsonSchemaObject): JsonSchemaObject {
    return { ...schema, properties: { ...schema.properties, startId: DECOMPRESS_RANGE_PARAM_START, endId: DECOMPRESS_RANGE_PARAM_END } };
}

export const BILI_DECOMPRESS_TOOL = { name: DECOMPRESS_TOOL.name, description: DECOMPRESS_TOOL.description, input_schema: withRangeParams(DECOMPRESS_TOOL.input_schema) };
export const BILI_DECOMPRESS_TOOL_OPENAI = { type: "function" as const, function: { name: DECOMPRESS_TOOL_OPENAI.function.name, description: DECOMPRESS_TOOL_OPENAI.function.description, parameters: withRangeParams(DECOMPRESS_TOOL_OPENAI.function.parameters) } };
export const BILI_DECOMPRESS_TOOL_RESPONSES = { type: "function" as const, name: DECOMPRESS_TOOL_RESPONSES.name, description: DECOMPRESS_TOOL_RESPONSES.description, parameters: withRangeParams(DECOMPRESS_TOOL_RESPONSES.parameters) };
export const BILI_DECOMPRESS_TOOL_GOOGLE = { name: DECOMPRESS_TOOL_GOOGLE.name, description: DECOMPRESS_TOOL_GOOGLE.description, parameters: withRangeParams(DECOMPRESS_TOOL_GOOGLE.parameters) };

export const BILI_ACP_TOOLS_ANTHROPIC = ACP_TOOLS_ANTHROPIC.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL : t));
export const BILI_ACP_TOOLS_OPENAI = ACP_TOOLS_OPENAI.map((t) => (t.function.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_OPENAI : t.function.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL_OPENAI : t));
export const BILI_ACP_TOOLS_RESPONSES = ACP_TOOLS_RESPONSES.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_RESPONSES : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL_RESPONSES : t));
export const BILI_ACP_TOOLS_GOOGLE = ACP_TOOLS_GOOGLE.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_GOOGLE : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL_GOOGLE : t));
export const BILI_ACP_READONLY_TOOLS_RESPONSES = ACP_READONLY_TOOLS_RESPONSES.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_RESPONSES : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL_RESPONSES : t));

// The kernel ships no Responses-format absorb const (the four ACP tools have
// *_RESPONSES variants; absorb is host-registered opt-in). Synthesize it in
// the same flat shape as SEARCH_CONTEXT_TOOL_RESPONSES.
export const ABSORB_TOOL_RESPONSES = {
    type: "function",
    name: ABSORB_TOOL_OPENAI.function.name,
    description: ABSORB_TOOL_OPENAI.function.description,
    parameters: ABSORB_TOOL_OPENAI.function.parameters,
};

// #1359: absorb wire shapes parameterized by name so registration (manifest +
// per-request injection) follows the resolved `absorb.toolName` in BOTH lanes —
// a renamed tool must be advertised, injected, and adjudicated under one name.
// At the default name this is byte-identical to the static consts above.
export function absorbToolsFor(name: string) {
    return {
        anthropic: { name, description: ABSORB_TOOL.description, input_schema: ABSORB_TOOL.input_schema },
        openai: { type: "function" as const, function: { name, description: ABSORB_TOOL_OPENAI.function.description, parameters: ABSORB_TOOL_OPENAI.function.parameters } },
        responses: { type: "function" as const, name, description: ABSORB_TOOL_OPENAI.function.description, parameters: ABSORB_TOOL_OPENAI.function.parameters },
        google: { name, description: ABSORB_TOOL_GOOGLE.description, parameters: ABSORB_TOOL_GOOGLE.parameters },
    };
}

// The reconciled kernel (acp-kernel#332) ships RULE_TOOL_NAME + the rule state
// helpers but no wire tool objects. Synthesize all four wire shapes here so
// every injection point (wire helpers, plugin manifest) serves one definition.
const RULE_TOOL_DESCRIPTION = "Record a short, principle-level reminder so it survives context compression — the call and its result are protected and stay in context. Record when: the user calls out or repeatedly emphasizes a lesson; the user asks you to remember or follow a behavior; you personally hit a major pitfall worth remembering long-term. Keep each rule to one short line. Omit the rule argument to list recorded rules. To remove a recorded rule pass delete with its id (e.g. \"rule3\"); to remove every recorded rule pass clear: true. delete and clear are mutually exclusive with each other and with rule — use one operation per call.";
const RULE_PARAM_SCHEMA = {
    type: "object",
    properties: {
        rule: { type: "string", description: "Short principle-level reminder to record. Omit to list recorded rules." },
        delete: { type: "string", description: "Id of a recorded rule to remove (e.g. \"rule3\"). Mutually exclusive with rule and clear." },
        clear: { type: "boolean", description: "Remove every recorded rule at once. Mutually exclusive with rule and delete." },
    },
};
export const RULE_TOOL = { name: RULE_TOOL_NAME, description: RULE_TOOL_DESCRIPTION, input_schema: RULE_PARAM_SCHEMA };
export const RULE_TOOL_OPENAI = { type: "function" as const, function: { name: RULE_TOOL_NAME, description: RULE_TOOL_DESCRIPTION, parameters: RULE_PARAM_SCHEMA } };
export const RULE_TOOL_RESPONSES = { type: "function" as const, name: RULE_TOOL_NAME, description: RULE_TOOL_DESCRIPTION, parameters: RULE_PARAM_SCHEMA };
export const RULE_TOOL_GOOGLE = { name: RULE_TOOL_NAME, description: RULE_TOOL_DESCRIPTION, parameters: RULE_PARAM_SCHEMA };

// #1097: acp_retrieve — resolve a stored ID-referenced message back to its full
// original. Kernel-owned tool (RETRIEVE_TOOL_NAME); synthesized in all four
// wire shapes here so every injection point (wire helpers, plugin manifest)
// serves one definition. Takes a single `ref` (the mNNNNN id printed in the
// [acp-stored] placeholder). Read-only with respect to context: the fetched content
// rides the ephemeral tool-result channel and consumes no message ref.
const RETRIEVE_TOOL_DESCRIPTION = "Retrieve the full original text of a stored message by its id. Large tool results are replaced on the wire with a placeholder shaped like \"📦 [acp-stored #m00423 · shell output · 4,213 tok] `npm run build`\n   → acp_retrieve(\"m00423\") returns the full text\". Call this with that ref to read the complete original back into context. Leaving the placeholder costs nothing; retrieving costs one call — fetch only when the detail matters to the current step.";
const RETRIEVE_PARAM_SCHEMA = {
    type: "object" as const,
    properties: {
        ref: { type: "string", description: "The stored message id to retrieve (an mNNNNN ref from an [acp-stored] placeholder)." },
    },
    required: ["ref"],
};
export { RETRIEVE_TOOL_NAME };
/** Wire tool shapes for the retrieve tool; name follows the session's resolved
 *  `ccr.toolName` (default acp_retrieve) so registration, dispatch, and the
 *  kernel placeholder hint all agree. */
export function retrieveToolsFor(name: string) {
    return {
        anthropic: { name, description: RETRIEVE_TOOL_DESCRIPTION, input_schema: RETRIEVE_PARAM_SCHEMA },
        openai: { type: "function" as const, function: { name, description: RETRIEVE_TOOL_DESCRIPTION, parameters: RETRIEVE_PARAM_SCHEMA } },
        responses: { type: "function" as const, name, description: RETRIEVE_TOOL_DESCRIPTION, parameters: RETRIEVE_PARAM_SCHEMA },
        google: { name, description: RETRIEVE_TOOL_DESCRIPTION, parameters: RETRIEVE_PARAM_SCHEMA },
    };
}

// #1095: image_full (restore original-resolution images for a previously
// downscaled message). Kernel-owned tool; the kernel ships anthropic/openai/
// responses shapes — synthesize the missing Google variant in its flat shape
// so every injection point serves one definition.
export { IMAGE_FULL_TOOL, IMAGE_FULL_TOOL_OPENAI, IMAGE_FULL_TOOL_RESPONSES };
export const IMAGE_FULL_TOOL_GOOGLE = {
    name: IMAGE_FULL_TOOL_OPENAI.function.name,
    description: IMAGE_FULL_TOOL_OPENAI.function.description,
    parameters: IMAGE_FULL_TOOL_OPENAI.function.parameters,
};

export function parseCompressInput(input: unknown, callId?: string) {
    const parsed = parseCompressArgs(input, { callId });
    if (parsed.diagnostics.quoteSalvage === true) {
        loggerLog("warn", `[acp-compress-input] quote-salvage: recovered ${parsed.ranges.length} range(s) after single->double quote normalization (kind=${parsed.diagnostics.kind})`);
    }
    if (!parsed.diagnostics.ok && parsed.diagnostics.kind !== "ok") {
        loggerLog("warn", `[acp-compress-input] rejected: kind=${parsed.diagnostics.kind} invalidItems=${parsed.diagnostics.invalidItems}${parsed.diagnostics.keys ? ` keys=[${parsed.diagnostics.keys.join(",")}]` : ""}${parsed.diagnostics.length !== undefined ? ` len=${parsed.diagnostics.length}` : ""}${parsed.diagnostics.invalidReasons && parsed.diagnostics.invalidReasons.length > 0 ? ` reasons=[${parsed.diagnostics.invalidReasons.join(" | ")}]` : ""}`);
    }
    return { ranges: parsed.ranges, diagnostics: parsed.diagnostics };
}

// #189 staged-compression / prefix-survival guidance, appended to the nudge
// text ONLY when BILI_MAX_SHRINK_PER_COMPRESS is set (the "smooth transition"
// switch). It steers the model — at the moment it is choosing the range —
// toward smaller, tail-biased folds so the stable prefix (m00001..foldPoint)
// survives for prefix caching and each round's request-shape change stays
// gentle (the sharp change is what trips provider risk-control, GLM 3007).
const STAGED_COMPRESS_GUIDANCE =
    "\n\n[Smooth-transition guidance: when you compress, prefer a SMALLER, TAIL-biased range — compress the most recent large content and keep the stable prefix (the earliest messages) intact. A large single rewrite changes the request shape sharply and can trip provider risk-control; smaller tail-biased folds keep the prefix cache alive and the transition gentle.]";

/** Append the staged-compress guidance to a rendered nudge text. Returns the
 *  input unchanged when the smooth-transition switch is off (default). */
export function withStagedCompressGuidance(text: string): string {
    if (maxShrinkPerCompress() === undefined) return text;
    return text + STAGED_COMPRESS_GUIDANCE;
}

// #717 anti-forgery rule for ACP confirmation markers. Under sustained
// context pressure a model was observed writing the proxy's own marker format
// ("📦 [ACP] Compressed …") as plain assistant text — 17 fake compressions,
// none reaching the proxy, usage climbing to 89% while the model believed
// compression was working. The rule states the marker contract explicitly and
// is appended to every nudge (the moment of highest temptation) and to the
// injected philosophy prompt (persistent; byte-stable constant, so
// prefix-cache safe). #862 added the silence clause: in that deployment the
// model also NARRATED around genuine proxy executions — its own marker-style
// confirmation lines plus preambles/summaries (incl. non-English commentary)
// before and after each real compression.
const MARKER_INTEGRITY_NOTE =
    "\n\n[ACP marker integrity: lines shaped like '📦 [ACP] Compressed …' or '❌ [ACP] … FAILED' are CONFIRMATION MARKERS emitted by the bili proxy itself, right after it executes a compress/decompress/search_context/acp_status call. They are not something you write. NEVER emit such a line as your own text — writing one fakes a state change that did not happen, and the proxy strips it. To compress, call the compress tool. To verify a compression landed, call acp_status and confirm the block count increased — a confirmation line you wrote yourself proves nothing.";
const MARKER_SILENCE_CLAUSE =
    " Execute these calls silently: no announcement or preamble before the call, and no completion summary, status line, or marker-style line after it — when the tool returns, continue the task directly as if the call had not happened.]";

/** Append the marker-integrity rule to a nudge or system-prompt text.
 *  The anti-forgery segment is unconditional (unlike withStagedCompressGuidance):
 *  the rule must hold in every configuration where a marker can be seen in
 *  history. The #862 silence clause rides along only while markers are
 *  visible (#913): with compress.visibilityMarkers=false the client never
 *  sees a marker, so there is nothing to imitate or narrate around, and the
 *  clause is dropped. */
export function withMarkerIntegrityNote(text: string, visibilityMarkers = true): string {
    return text + MARKER_INTEGRITY_NOTE + (visibilityMarkers ? MARKER_SILENCE_CLAUSE : "");
}

// #760: per-call conversation_id for MCP tools. Hosts that share ONE MCP shim
// process across several concurrent conversations (kimi web et al.) have no
// env/meta session channel, so the proxy prints its own resolved session id
// and the model echoes it back as the conversation_id argument of every
// mcp__bili__ call. Session-stable, so it rides the static system-prompt part
// (prefix-cache safe) next to MARKER_INTEGRITY_NOTE, in BOTH modes.
export function withConversationIdNote(text: string, conversationId: string): string {
    return text + `\n\n[Your bili conversation id: ${conversationId}. When calling the bili compression tools, pass this value as the conversation_id argument so a shared MCP process can route the call to THIS session.]`;
}

// #888 per-summary length budget. acp-kernel rejects a compress call atomically
// when ANY single range's summary exceeds compress.maxSummaryLength (default
// 20000 chars) — "Summary too long (…)". Under dense workloads (many subagent
// results, long tool outputs) a model is tempted to fold a large range into ONE
// monolithic summary that blows the cap, failing the whole call. This rule
// steers the model — at the moment it picks the range and in the persistent
// philosophy prompt — to split large/dense ranges into several smaller ranges,
// each with its own concise summary, batched in one call. Byte-stable constant
// (no dynamic values) so the prefix-cache anchor stays intact; phrased without
// a hard number so it stays correct regardless of the configured cap (the exact
// limit is already reported verbatim in the kernel's failure message).
const SUMMARY_BUDGET_NOTE =
    "\n\n[Per-summary length budget: every compress summary has a hard character cap, and a single oversized summary fails the WHOLE compress call — nothing gets folded. Dense content (many subagent results, long tool outputs) tempts you into writing one giant summary for a big range; don't. When a range is large or dense, SPLIT it into several smaller ranges at logical boundaries and give EACH its own concise, scannable summary, then batch all the ranges in one compress call (content: [{startId,endId,summary}, {…}]). Prefer several tight blocks over one bloated block: each stays under the cap, and smaller blocks are cheaper to re-send and independently searchable/decompressible.]";

/** Append the per-summary length-budget rule to a nudge or system-prompt text.
 *  Unconditional (like withMarkerIntegrityNote): the cap always exists, so the
 *  guidance must be present whenever compression is possible. */
export function withSummaryBudgetNote(text: string): string {
    return text + SUMMARY_BUDGET_NOTE;
}
