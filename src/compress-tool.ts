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
import { parseCompressArgs } from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import { maxShrinkPerCompress } from "./fetch-util.js";
import {
    ACP_READONLY_TOOLS_RESPONSES as _ACP_READONLY_TOOLS_RESPONSES,
    ACP_STATUS_TOOL,
    ACP_STATUS_TOOL_NAME,
    ACP_STATUS_TOOL_OPENAI,
    ACP_STATUS_TOOL_RESPONSES,
    ACP_TEXT_OPEN,
    ACP_TEXT_CLOSE,
    ACP_STATUS_OPEN,
    ACP_STATUS_CLOSE,
    ACP_SEARCH_OPEN,
    ACP_SEARCH_CLOSE,
    ACP_DECOMPRESS_OPEN,
    ACP_DECOMPRESS_CLOSE,
    ACP_TOOLS_ANTHROPIC as _ACP_TOOLS_ANTHROPIC,
    ACP_TOOLS_OPENAI as _ACP_TOOLS_OPENAI,
    ACP_TOOLS_RESPONSES as _ACP_TOOLS_RESPONSES,
    COMPRESS_TOOL,
    COMPRESS_TOOL_NAME,
    COMPRESS_TOOL_OPENAI,
    COMPRESS_TOOL_RESPONSES,
    DECOMPRESS_TOOL,
    DECOMPRESS_TOOL_NAME,
    DECOMPRESS_TOOL_OPENAI,
    DECOMPRESS_TOOL_RESPONSES,
    SEARCH_CONTEXT_TOOL as _SEARCH_CONTEXT_TOOL,
    SEARCH_CONTEXT_TOOL_NAME,
    SEARCH_CONTEXT_TOOL_OPENAI as _SEARCH_CONTEXT_TOOL_OPENAI,
    SEARCH_CONTEXT_TOOL_RESPONSES as _SEARCH_CONTEXT_TOOL_RESPONSES,
} from "acp-kernel";

export type { ParsedRange } from "acp-kernel";
export { ACP_TOOL_NAMES as PROXY_TOOL_NAMES, ACP_MUTATING_TOOLS as MUTATING_PROXY_TOOLS, ACP_READONLY_TOOLS as READONLY_PROXY_TOOLS } from "acp-kernel";
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
    ACP_STATUS_TOOL,
    ACP_STATUS_TOOL_OPENAI,
    ACP_STATUS_TOOL_RESPONSES,
    buildCompressSystemPrompt,
    buildCompressTextSystemPrompt,
    buildCompressHybridSystemPrompt,
} from "acp-kernel";

// The proxy's search_context searches active summary blocks AND the visible
// conversation (src/search-context.ts); the kernel schema only promises
// blocks, so the description is overridden to match the implementation.
const SEARCH_CONTEXT_DESCRIPTION =
    "Searches compressed block summaries AND visible conversation messages by keyword (English + Chinese/CJK). Use BEFORE decompressing to find the right block, or to locate content still in context.";

export const SEARCH_CONTEXT_TOOL = { ..._SEARCH_CONTEXT_TOOL, description: SEARCH_CONTEXT_DESCRIPTION };
export const SEARCH_CONTEXT_TOOL_OPENAI = {
    ..._SEARCH_CONTEXT_TOOL_OPENAI,
    function: { ..._SEARCH_CONTEXT_TOOL_OPENAI.function, description: SEARCH_CONTEXT_DESCRIPTION },
};
export const SEARCH_CONTEXT_TOOL_RESPONSES = { ..._SEARCH_CONTEXT_TOOL_RESPONSES, description: SEARCH_CONTEXT_DESCRIPTION };

export const ACP_TOOLS_OPENAI = _ACP_TOOLS_OPENAI.map((t) =>
    t.function.name === SEARCH_CONTEXT_TOOL_NAME
        ? { ...t, function: { ...t.function, description: SEARCH_CONTEXT_DESCRIPTION } }
        : t,
);
export const ACP_TOOLS_ANTHROPIC = _ACP_TOOLS_ANTHROPIC.map((t) =>
    t.name === SEARCH_CONTEXT_TOOL_NAME ? { ...t, description: SEARCH_CONTEXT_DESCRIPTION } : t,
);
export const ACP_TOOLS_RESPONSES = _ACP_TOOLS_RESPONSES.map((t) =>
    t.name === SEARCH_CONTEXT_TOOL_NAME ? { ...t, description: SEARCH_CONTEXT_DESCRIPTION } : t,
);
export const ACP_READONLY_TOOLS_RESPONSES = _ACP_READONLY_TOOLS_RESPONSES.map((t) =>
    t.name === SEARCH_CONTEXT_TOOL_NAME ? { ...t, description: SEARCH_CONTEXT_DESCRIPTION } : t,
);

export function parseCompressInput(input: unknown, callId?: string) {
    const { ranges, diagnostics } = parseCompressArgs(input, { callId });
    if (!diagnostics.ok && diagnostics.kind !== "ok") {
        loggerLog("warn", `[acp-compress-input] rejected: kind=${diagnostics.kind} invalidItems=${diagnostics.invalidItems}${diagnostics.keys ? ` keys=[${diagnostics.keys.join(",")}]` : ""}${diagnostics.length !== undefined ? ` len=${diagnostics.length}` : ""}${diagnostics.invalidReasons && diagnostics.invalidReasons.length > 0 ? ` reasons=[${diagnostics.invalidReasons.join(" | ")}]` : ""}`);
    }
    return { ranges, diagnostics };
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
