/**
 * ACP tool surface — thin re-export from acp-kernel (Phase K1).
 *
 * The schemas, prompt builders, text tags and parseCompressInput moved to
 * acp-kernel `src/compress-tools.ts` verbatim; this module keeps the proxy's
 * historical import paths and names stable:
 *  - PROXY_TOOL_NAMES / MUTATING_PROXY_TOOLS / READONLY_PROXY_TOOLS alias the
 *    kernel's ACP_* names ("proxy" is a misnomer once shared);
 *  - parseCompressInput wires the kernel's onWarn hook into the proxy logger.
 */
import { parseCompressArgs, ACP_TOOLS_ANTHROPIC, ACP_TOOLS_OPENAI, ACP_TOOLS_RESPONSES, ACP_TOOL_NAMES } from "acp-kernel";
import { log as loggerLog } from "./logger.js";

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
    DECOMPRESS_TOOL,
    DECOMPRESS_TOOL_OPENAI,
    DECOMPRESS_TOOL_RESPONSES,
    SEARCH_CONTEXT_TOOL,
    SEARCH_CONTEXT_TOOL_OPENAI,
    SEARCH_CONTEXT_TOOL_RESPONSES,
    ACP_STATUS_TOOL,
    ACP_STATUS_TOOL_OPENAI,
    ACP_STATUS_TOOL_RESPONSES,
    ACP_TOOLS_OPENAI,
    ACP_TOOLS_ANTHROPIC,
    ACP_TOOLS_RESPONSES,
    ACP_READONLY_TOOLS_RESPONSES,
    buildCompressSystemPrompt,
    buildCompressTextSystemPrompt,
    buildCompressHybridSystemPrompt,
} from "acp-kernel";
export type { ParsedRange } from "acp-kernel";
export { ACP_TOOL_NAMES as PROXY_TOOL_NAMES, ACP_MUTATING_TOOLS as MUTATING_PROXY_TOOLS, ACP_READONLY_TOOLS as READONLY_PROXY_TOOLS } from "acp-kernel";

/**
 * bili_* tool-name aliases — the proxy's wire-level rename of the 4 ACP tools.
 *
 * Why: a user who has BOTH billion-context and billion-context-pi installed
 * would see two sets of identically-named tools (compress/decompress/...).
 * Renaming the proxy's tools to bili_* disambiguates them at the wire level.
 * The kernel's prompt text is parameterized separately (withToolNames).
 */
export const BILI_TOOL_NAMES: Record<string, string> = {
    compress: "bili_compress",
    decompress: "bili_decompress",
    search_context: "bili_search_context",
    acp_status: "bili_status",
};

const BILI_TOOL_ALIASES: Record<string, string> = Object.fromEntries(
    Object.entries(BILI_TOOL_NAMES).map(([original, bili]) => [bili, original]),
);

/** Map a wire-level tool name (possibly bili_*) back to the kernel's canonical name. */
export function biliToolName(name: string): string {
    return BILI_TOOL_ALIASES[name] ?? name;
}

type NamedTool = { name: string; [k: string]: unknown };
type OpenAIFunctionTool = { type: "function"; function: { name: string; [k: string]: unknown }; [k: string]: unknown };

function renameTools<T extends NamedTool>(tools: readonly T[]): T[] {
    return tools.map((t) => ({ ...t, name: BILI_TOOL_NAMES[t.name] ?? t.name }));
}

function renameOpenaiTools<T extends OpenAIFunctionTool>(tools: readonly T[]): T[] {
    return tools.map((t) => ({ ...t, function: { ...t.function, name: BILI_TOOL_NAMES[t.function.name] ?? t.function.name } }));
}

export const BILI_ACP_TOOLS_ANTHROPIC = renameTools(ACP_TOOLS_ANTHROPIC);
export const BILI_ACP_TOOLS_OPENAI = renameOpenaiTools(ACP_TOOLS_OPENAI);
export const BILI_ACP_TOOLS_RESPONSES = renameTools(ACP_TOOLS_RESPONSES);

/**
 * Detection set for the compress loop: matches BOTH the canonical kernel names
 * and the bili_* wire names, so a model call to either form is recognized as a
 * proxy tool. executeProxyTool maps bili_* → canonical before dispatch.
 */
export const BILI_PROXY_TOOL_NAMES: ReadonlySet<string> = new Set([
    ...ACP_TOOL_NAMES,
    ...Object.values(BILI_TOOL_NAMES),
]);

export function parseCompressInput(input: unknown, callId?: string) {
    const { ranges, diagnostics } = parseCompressArgs(input, { callId });
    if (!diagnostics.ok && diagnostics.kind !== "ok") {
        loggerLog("warn", `[acp-compress-input] rejected: kind=${diagnostics.kind} invalidItems=${diagnostics.invalidItems}${diagnostics.keys ? ` keys=[${diagnostics.keys.join(",")}]` : ""}${diagnostics.length !== undefined ? ` len=${diagnostics.length}` : ""}`);
    }
    return ranges;
}
