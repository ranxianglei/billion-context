import type { CoreMessage } from "./types.js";

/**
 * The single "tool message" definition for all accounting surfaces
 * (status report, compressible ranges, context breakdown). A message is a
 * tool message when it is a tool call OR its result — never by `toolName`
 * presence: wire converters only set toolName on the call side, so a
 * toolName-based check silently classifies every tool-result as text
 * (issue #390).
 */
export function isToolMessage(message: CoreMessage): boolean {
  return (
    message.contentType === "tool-call" || message.contentType === "tool-result"
  );
}
