export { runCompressLoop, executeProxyTool, MAX_LOOP_ROUNDS } from "./core.js";
export type {
    LoopCtx,
    RequestOptions,
    ParsedStreamEvent,
    CompressLoopAdapter,
    EmitCompletionOpts,
    ToolCallEmit,
    ExtractedTextTriggers,
} from "./core.js";
export { createResponsesAdapter } from "./adapter-responses.js";
export { createOpenaiAdapter } from "./adapter-openai.js";
export { createAnthropicAdapter } from "./adapter-anthropic.js";
import { createResponsesAdapter } from "./adapter-responses.js";
import { createOpenaiAdapter } from "./adapter-openai.js";
import { createAnthropicAdapter } from "./adapter-anthropic.js";
import type { CompressLoopAdapter } from "./core.js";

export function pickAdapter(
    protocol: "responses" | "openai" | "anthropic",
    requestBody: Record<string, unknown>,
): CompressLoopAdapter {
    if (protocol === "responses") return createResponsesAdapter();
    if (protocol === "openai") return createOpenaiAdapter(requestBody);
    return createAnthropicAdapter(requestBody);
}
