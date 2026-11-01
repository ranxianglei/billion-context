import type { Config, PackSurface, Prompts, ToolPrompts } from "acp-kernel";
import { applyAcpToolOverrides, defaultPrompts } from "acp-kernel";
import type { ProxyOptions } from "../config.js";
import { type AnthropicRequestBody, type GoogleFunctionDeclaration, type GoogleTool, type OpenAITool } from "acp-kernel/wire";
import { appendSystemText } from "../util.js";
import { absorbEnabled, absorbToolName } from "../absorb.js";
import { BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE, BILI_ACP_TOOLS_GOOGLE, BILI_ACP_TOOLS_GOOGLE_NO_RANGE, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_OPENAI_NO_RANGE, BILI_ACP_TOOLS_RESPONSES, buildAbsorbSystemPrompt, buildAcpTagsOnlyPrompt, buildCompressSystemPrompt, packOwnsDescription, ptcNoteMode, withAcpNotes, withAcpNotesOpenAI, withMarkerIntegrityNote, withMcpDialectNote, withSummaryBudgetNote, withProjectAttribution } from "../compress-tool.js";
import { conversationPromptSections, externalSummaryEnabled, messageTimestampSections, withExternalSummaryTools } from "../external-summary-surface.js";
import { forceTextProtocol as knobForceTextProtocol, renderNone as knobRenderNone } from "../knobs.js";
import { GENERATION_BOUNDARY_NOTE } from "../generation-boundary.js";

export function injectSystem(
    parsed: AnthropicRequestBody,
    opts: ProxyOptions,
    prompts: Prompts = defaultPrompts,
    config: Config,
    surface?: PackSurface,
    visibilityMarkers = true,
    suppressCompressPrompt = false,
    mcpDialectNote = false,
    generationBoundaryActive = false,
): string | AnthropicRequestBody["system"] {
    // ONLY the static compress prompt goes into the system block — it is the
    // prefix-cache anchor and must stay byte-stable across turns. The nudge
    // (which changes every turn) is appended as a trailing user message by
    // the caller (prepareAnthropic), never merged into system.
    const parts: string[] = [];
    let acpStandingPushed = false;
    if (opts.compress.injectTool && !suppressCompressPrompt) { parts.push(withProjectAttribution(withMcpDialectNote(withMarkerIntegrityNote(withSummaryBudgetNote(buildCompressSystemPrompt(prompts, messageTimestampSections(conversationPromptSections(surface?.promptSections, externalSummaryEnabled(config)))), externalSummaryEnabled(config)), visibilityMarkers), mcpDialectNote))); acpStandingPushed = true; }
    else if (!knobRenderNone()) {
        // #1881: the NEVER-echo prohibition follows the rendered tags, not the tool switch.
        const tagsOnly = buildAcpTagsOnlyPrompt("function", prompts, messageTimestampSections(surface?.promptSections));
        if (tagsOnly) { parts.push(tagsOnly); acpStandingPushed = true; }
    }
    // #4305: standing generation-boundary note — rides the ACP standing block,
    // byte-stable once detected; never on a view that carries no ACP surface.
    if (generationBoundaryActive && acpStandingPushed) parts.push(GENERATION_BOUNDARY_NOTE);
    if (opts.compress.injectTool && absorbEnabled(config)) parts.push(buildAbsorbSystemPrompt(absorbToolName(config)));
    if (parts.length === 0) return parsed.system;
    // #1876: APPEND the prompt as a trailing block (client blocks byte-exact)
    // instead of merging everything into one block via kernel buildSystem.
    return appendSystemText(parts.join("\n\n"), parsed.system);
}

// #920: in proxy mode bili OWNS the compression tool names. Agent-side tools
// with the same name (opencode-acp's statically-registered DCP set ships in
// every opencode request body — the v1 tool registry is process-global and
// cannot be filtered per request) are dropped here so the upstream sees
// exactly one definition per name, and it is bili's (its arg schemas are what
// the compress loop dispatches on). Plugin mode never calls the wrappers below.
// Shared merge core for the flat-shape wrappers (anthropic/openai/responses):
// wanted = acp ∪ extras; input entries whose nameOf hits wanted are dropped;
// result = kept + wanted.
function mergeOwnedTools<T>(tools: readonly T[] | undefined, acp: readonly T[], extras: readonly T[], nameOf: (t: T) => unknown): T[] {
    const owned = new Set<string>();
    for (const t of [...acp, ...extras]) {
        const n = nameOf(t);
        if (typeof n === "string") owned.add(n);
    }
    if (!Array.isArray(tools)) return [...acp, ...extras];
    const kept = tools.filter((t) => {
        const n = nameOf(t);
        return typeof n !== "string" || !owned.has(n);
    });
    return [...kept, ...acp, ...extras];
}

export function injectTool(tools: unknown[] | undefined, extras?: readonly { name: string }[], toolPrompts?: ToolPrompts, ccrOn = false, externalOn = false): unknown[] {
    // #1712: decompress's startId/endId execute only on CCR-armed sessions
    // (#1179), so serve the no-range schema when CCR is off.
    // #3252: when the client's own tools are code-mode-shaped (run_code
    // present), the ACP entries get the exempt note — see compress-tool.ts.
    const mode = ptcNoteMode((tools ?? []).map((t) => (t as { name?: string })?.name));
    const acp = withAcpNotes(withExternalSummaryTools(applyAcpToolOverrides(ccrOn ? BILI_ACP_TOOLS_ANTHROPIC : BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE, toolPrompts), externalOn), mode, packOwnsDescription(toolPrompts));
    return mergeOwnedTools<unknown>(tools, acp, extras ?? [], (t) => (t as { name?: string })?.name);
}

export function injectOpenaiTool(tools: OpenAITool[] | undefined, extras?: readonly OpenAITool[], toolPrompts?: ToolPrompts, ccrOn = false, externalOn = false): OpenAITool[] {
    // #3252: exempt note when the client tools are run_code-shaped.
    const mode = ptcNoteMode((tools ?? []).map((t) => t?.function?.name));
    const acp = withAcpNotesOpenAI(withExternalSummaryTools(applyAcpToolOverrides(ccrOn ? BILI_ACP_TOOLS_OPENAI : BILI_ACP_TOOLS_OPENAI_NO_RANGE, toolPrompts), externalOn) as OpenAITool[], mode, packOwnsDescription(toolPrompts));
    return mergeOwnedTools<OpenAITool>(tools, acp, extras ?? [], (t) => t?.function?.name);
}

/** Merge the ACP declarations into the client's Gemini `tools` array. Gemini
 *  nests declarations one level deeper than the OpenAI shape
 *  (`tools[].functionDeclarations[]`), so presence is collected across every
 *  entry and the missing declarations are appended as one new entry. */
export function injectGoogleTool(tools: GoogleTool[] | undefined, extra?: { name: string }[], toolPrompts?: ToolPrompts, ccrOn = false, externalOn = false): GoogleTool[] {
    // #3252: exempt note when the client tools are run_code-shaped.
    const clientNames: (string | undefined)[] = [];
    for (const tool of tools ?? []) for (const decl of tool?.functionDeclarations ?? []) clientNames.push(decl?.name);
    const mode = ptcNoteMode(clientNames);
    const acp = withAcpNotes(withExternalSummaryTools(applyAcpToolOverrides(ccrOn ? BILI_ACP_TOOLS_GOOGLE : BILI_ACP_TOOLS_GOOGLE_NO_RANGE, toolPrompts), externalOn) as GoogleFunctionDeclaration[], mode, packOwnsDescription(toolPrompts));
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

/** When true, the Responses path teaches compression via a text trigger
 *  instead of a function tool. Used for hosts (OpenAI Codex code_mode) whose
 *  server-side tools are disabled the moment any `tools` entry is declared.
 *  In text mode we keep `tools` untouched (undefined) so code_mode stays
 *  active, and detect the trigger in the output_text stream instead. */
export const FORCE_TEXT_PROTOCOL = knobForceTextProtocol();
/** Inject all ACP tools (compress/decompress/search_context/acp_status) in
 *  Responses API flat format, matching the PROXY_TOOL_NAMES set the compress
 *  loop dispatches on. Idempotent. */
export function injectResponsesTool(tools: unknown[] | undefined, toolsToAdd: readonly { name: string }[] = BILI_ACP_TOOLS_RESPONSES, toolPrompts?: ToolPrompts, externalOn = false): unknown[] {
    // #920 rule via mergeOwnedTools: bili owns these names (see core above).
    // #3252: exempt note when the client tools are run_code-shaped.
    const mode = ptcNoteMode((tools ?? []).map((t) => (t as { name?: string })?.name));
    const base = withAcpNotes(withExternalSummaryTools(applyAcpToolOverrides(toolsToAdd, toolPrompts), externalOn), mode, packOwnsDescription(toolPrompts));
    return mergeOwnedTools<unknown>(tools, base, [], (t) => (t as { name?: string })?.name);
}
