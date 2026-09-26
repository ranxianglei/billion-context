// ACP tool/system injection helpers shared by the per-protocol prepare
// pipelines (extracted verbatim from src/server.ts — #1440 P2 four-cut
// disassembly, cut 2).

import { absorbEnabled, absorbToolName } from "../absorb.js";
import { BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_GOOGLE, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_RESPONSES, buildAbsorbSystemPrompt, buildCompressSystemPrompt, withConversationIdNote, withMarkerIntegrityNote, withSummaryBudgetNote } from "../compress-tool.js";
import { ProxyOptions } from "../config.js";
import { Config, PackSurface, Prompts, ToolPrompts, applyAcpToolOverrides, defaultPrompts } from "acp-kernel";
import { AnthropicRequestBody, GoogleFunctionDeclaration, GoogleTool, OpenAITool, buildSystem, extractSystem } from "acp-kernel/wire";

export function injectSystem(
    parsed: AnthropicRequestBody,
    opts: ProxyOptions,
    prompts: Prompts = defaultPrompts,
    config: Config,
    noteId: string,
    surface?: PackSurface,
    visibilityMarkers = true,
): string | AnthropicRequestBody["system"] {
    // ONLY the static compress prompt goes into the system block — it is the
    // prefix-cache anchor and must stay byte-stable across turns. The nudge
    // (which changes every turn) is appended as a trailing user message by
    // the caller (prepareAnthropic), never merged into system.
    const baseText = extractSystem(parsed.system);
    const parts: string[] = [];
    if (opts.compress.injectTool) parts.push(withConversationIdNote(withMarkerIntegrityNote(withSummaryBudgetNote(buildCompressSystemPrompt(prompts, surface?.promptSections)), visibilityMarkers), noteId));
    if (opts.compress.injectTool && absorbEnabled(config)) parts.push(buildAbsorbSystemPrompt(absorbToolName(config)));
    if (parts.length === 0) return parsed.system;
    const full = baseText ? `${baseText}\n\n---\n\n${parts.join("\n\n")}` : parts.join("\n\n");
    return buildSystem(full, parsed.system);
}

// #920: in proxy mode bili OWNS the compression tool names. Agent-side tools
// with the same name (opencode-acp's statically-registered DCP set ships in
// every opencode request body — the v1 tool registry is process-global and
// cannot be filtered per request) are dropped here so the upstream sees
// exactly one definition per name, and it is bili's (its arg schemas are what
// the compress loop dispatches on). Plugin mode never calls these helpers.
export function injectTool(tools: unknown[] | undefined, extras?: readonly { name: string }[], toolPrompts?: ToolPrompts): unknown[] {
    const acp = applyAcpToolOverrides(BILI_ACP_TOOLS_ANTHROPIC, toolPrompts);
    const list = extras ?? [];
    if (!Array.isArray(tools)) return [...acp, ...list];
    const owned = new Set<string>(acp.map((t) => t.name));
    for (const e of list) owned.add(e.name);
    const kept = tools.filter((t) => {
        const n = (t as { name?: string })?.name;
        return typeof n !== "string" || !owned.has(n);
    });
    return [...kept, ...acp, ...list];
}

export function injectOpenaiTool(tools: OpenAITool[] | undefined, extras?: readonly OpenAITool[], toolPrompts?: ToolPrompts): OpenAITool[] {
    const acp = applyAcpToolOverrides(BILI_ACP_TOOLS_OPENAI, toolPrompts) as OpenAITool[];
    const list = extras ?? [];
    if (!Array.isArray(tools)) return [...acp, ...list] as OpenAITool[];
    const owned = new Set<string>(acp.map((t) => t.function.name));
    for (const e of list) owned.add(e.function.name);
    const kept = tools.filter((t) => {
        const n = t?.function?.name;
        return typeof n !== "string" || !owned.has(n);
    });
    return [...kept, ...acp, ...list];
}

/** Merge the ACP declarations into the client's Gemini `tools` array. Gemini
 *  nests declarations one level deeper than the OpenAI shape
 *  (`tools[].functionDeclarations[]`), so presence is collected across every
 *  entry and the missing declarations are appended as one new entry. */
export function injectGoogleTool(tools: GoogleTool[] | undefined, extra?: { name: string }[], toolPrompts?: ToolPrompts): GoogleTool[] {
    const acp = applyAcpToolOverrides(BILI_ACP_TOOLS_GOOGLE, toolPrompts) as GoogleFunctionDeclaration[];
    const wanted: { name: string }[] = extra ? [...acp, ...extra] : [...acp];
    if (!Array.isArray(tools)) return [{ functionDeclarations: wanted as GoogleFunctionDeclaration[] }];
    const present = new Set<string>();
    for (const tool of tools) {
        for (const decl of tool?.functionDeclarations ?? []) {
            if (typeof decl?.name === "string") present.add(decl.name);
        }
    }
    const missing = wanted.filter((t) => !present.has(t.name));
    if (missing.length === 0) return tools;
    return [...tools, { functionDeclarations: missing as GoogleFunctionDeclaration[] }];
}

/** Inject all ACP tools (compress/decompress/search_context/acp_status) in
 *  Responses API flat format, matching the PROXY_TOOL_NAMES set the compress
 *  loop dispatches on. Idempotent. */
export function injectResponsesTool(tools: unknown[] | undefined, toolsToAdd: readonly { name: string }[] = BILI_ACP_TOOLS_RESPONSES, toolPrompts?: ToolPrompts): unknown[] {
    const base = applyAcpToolOverrides(toolsToAdd, toolPrompts);
    if (!Array.isArray(tools)) return [...base];
    // Same #920 rule as injectTool/injectOpenaiTool: bili owns these names.
    const owned = new Set<string>(base.map((t) => t.name));
    const kept = tools.filter((t) => {
        const n = (t as { name?: string })?.name;
        return typeof n !== "string" || !owned.has(n);
    });
    return [...kept, ...base];
}
