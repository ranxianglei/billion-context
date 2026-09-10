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
import { parseCompressArgs, ABSORB_TOOL_OPENAI } from "acp-kernel";
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
    ABSORB_TOOL_NAME,
    ABSORB_TOOL,
    ABSORB_TOOL_OPENAI,
    buildAbsorbSystemPrompt,
} from "acp-kernel";
export type { ParsedRange, AbsorbConfig } from "acp-kernel";
export { ACP_TOOL_NAMES as PROXY_TOOL_NAMES, ACP_MUTATING_TOOLS as MUTATING_PROXY_TOOLS, ACP_READONLY_TOOLS as READONLY_PROXY_TOOLS } from "acp-kernel";

// The kernel ships no Responses-format absorb const (the four ACP tools have
// *_RESPONSES variants; absorb is host-registered opt-in). Synthesize it in
// the same flat shape as SEARCH_CONTEXT_TOOL_RESPONSES.
export const ABSORB_TOOL_RESPONSES = {
    type: "function",
    name: ABSORB_TOOL_OPENAI.function.name,
    description: ABSORB_TOOL_OPENAI.function.description,
    parameters: ABSORB_TOOL_OPENAI.function.parameters,
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
