export const WIRE_FORMATS = [
  "anthropic",
  "openai",
  "responses",
  "google",
] as const;
export type WireFormat = (typeof WIRE_FORMATS)[number];

export function isWireFormat(value: unknown): value is WireFormat {
  return (
    typeof value === "string" &&
    (WIRE_FORMATS as readonly string[]).includes(value)
  );
}

/**
 * Classify a provider request body by the codec that can parse it.
 * Returns undefined when no codec handles the body — the caller must
 * pass such payloads through untransformed.
 */
export function detectWireFormat(payload: unknown): WireFormat | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  // Gemini native carries the conversation in `contents`; no other dialect
  // does, and it never has `input`/`messages`, so the check is unambiguous.
  if (Array.isArray(p.contents)) return "google";
  if (Array.isArray(p.input)) return "responses";
  const messages = p.messages;
  if (!Array.isArray(messages)) return undefined;
  if ("system" in p || "anthropic_version" in p) return "anthropic";
  for (const m of messages as Array<Record<string, unknown>>) {
    if (m === null || typeof m !== "object") continue;
    const c = m.content;
    if (Array.isArray(c)) {
      for (const b of c as Array<Record<string, unknown>>) {
        if (b && typeof b === "object" && typeof b.type === "string") {
          if (
            b.type === "tool_use" ||
            b.type === "tool_result" ||
            b.type === "thinking"
          )
            return "anthropic";
          if (b.type === "text" && "cache_control" in b) return "anthropic";
        }
      }
    }
    if (Array.isArray(m.tool_calls)) return "openai";
    if (m.role === "tool" && typeof m.tool_call_id === "string")
      return "openai";
    if (m.role === "system" || m.role === "developer") return "openai";
  }
  // Both chat formats share role+messages; default to openai — the safer
  // guess for OpenAI-compatible endpoints (GLM, DeepSeek, vLLM).
  return "openai";
}
