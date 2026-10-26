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
    systemNotes?: string[],
    streamErrorShape?: "protocol" | "completion",
    anthropicCacheMarks?: Map<string, { type: "ephemeral" }>,
    anthropicClientCacheControls?: Map<string, unknown>,
    absorbArmed?: boolean,
): CompressLoopAdapter {
    // #1455: how upstream stream failures are presented to the client —
    // protocol-native error frames (default) or legacy synthesized completion.
    const shape = streamErrorShape ?? "protocol";
    if (protocol === "responses") return createResponsesAdapter(textProtocol, responsesProjection, absorbName, systemNotes);
    if (protocol === "openai") return createOpenaiAdapter(requestBody, openaiSystem, absorbName, systemNotes, shape);
    if (protocol === "anthropic") return createAnthropicAdapter(requestBody, anthropicSystem, systemNotes, shape, anthropicCacheMarks, anthropicClientCacheControls, absorbArmed);
    if (protocol === "google") return createGoogleAdapter(requestBody, google?.system, absorbName, google?.model, systemNotes);
    throw new Error(`[acp-loop] unknown protocol: ${protocol}`);
}
