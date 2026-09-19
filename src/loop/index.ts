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
export { createGoogleAdapter } from "./adapter-google.js";
import { createResponsesAdapter } from "./adapter-responses.js";
import { createOpenaiAdapter } from "./adapter-openai.js";
import { createAnthropicAdapter } from "./adapter-anthropic.js";
import { createGoogleAdapter } from "./adapter-google.js";
import type { CompressLoopAdapter } from "./core.js";
import type { ResponsesProjection } from "acp-kernel/wire";
import type { AnthropicRequestBody } from "acp-kernel/wire";

export function pickAdapter(
    protocol: "responses" | "openai" | "anthropic" | "google",
    requestBody: Record<string, unknown>,
    textProtocol?: boolean,
    responsesProjection?: ResponsesProjection,
    anthropicSystem?: AnthropicRequestBody["system"],
    openaiSystem?: string,
    absorbName?: string,
    google?: { system?: string; model?: string },
): CompressLoopAdapter {
    if (protocol === "responses") return createResponsesAdapter(textProtocol, responsesProjection, absorbName);
    if (protocol === "openai") return createOpenaiAdapter(requestBody, openaiSystem, absorbName);
    if (protocol === "anthropic") return createAnthropicAdapter(requestBody, anthropicSystem);
    if (protocol === "google") return createGoogleAdapter(requestBody, google?.system, absorbName, google?.model);
    throw new Error(`[acp-loop] unknown protocol: ${protocol}`);
}
