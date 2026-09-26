// #1086: content fallback for bili→bili chain detection. When a middlebox
// strips bili's x-bili-hop header, the only remaining signal that an upstream
// bili instance already compressed the payload is the ACP artifacts inside
// the body itself: render tags (\x3cacp …\x3emNNNNN\x3c/acp\x3e) and the ACP
// tool names (acp_status / search_context) that bili's own plugins register.
//
// v0.1.133 (#1079) seeded this fallback on shapes bili PRODUCES for its own
// clients — the client re-sends render tags verbatim, and the tool names sit
// in the tools array of every plugin-mode request even when never called —
// so a single-instance setup judged EVERY turn as a chain and the compression
// kernel stopped running permanently (#1086). Two corrections:
//   1. Tool names only count when they appear in HISTORY tool-call items
//      (an actual prior invocation), never from the tools declaration array
//      alone — declarations are the normal shape of a bili-managed client.
//   2. The DECISION (pass-through vs process) happens in server.ts AFTER
//      session identity is resolved: when THIS instance holds processed
//      compression state for the session, the artifacts are self-produced
//      and the request runs through the kernel normally.

const ACP_TAG_RE = /\x3cacp\s+tokens=\\"?[0-9]+(?:\.[0-9]+)?K?\\"?\s+type=\\"?[^\\"]*\\"?\s*\x3em[0-9]{1,8}\x3c\/acp\x3e/;

type AcpArtifactKind = "tags" | "tool-history";

/** Allocation-free byte pre-filter: true when either artifact family could
 *  be present. A miss is definitive (both seeds are literal substrings of
 *  the positive forms); a hit only costs one decode in detectAcpArtifacts. */
export function artifactSeedHit(body: Buffer): boolean {
    if (body.length === 0) return false;
    const tagSeed = body.includes("\x3cacp ");
    const toolSeed = body.includes('"acp_status"') && body.includes('"search_context"');
    return tagSeed || toolSeed;
}

/** Verify which ACP artifact family is actually present in the request.
 *  `parsed` is the already-parsed body (null when unparseable — then only
 *  the legacy whole-buffer tag check can fire). Returns null when neither
 *  family is present.
 *
 *  #1197: the tags family scans HISTORY message content only. bili's
 *  compression artifacts (render tags, the re-voiced acp_summary, plugin
 *  compress tool results) always live in history items — never in the
 *  system/developer/instructions section. Tag-shaped text there is
 *  client-authored context (AGENTS.md/CLAUDE.md/README quoting the wire
 *  format — the billion-context repo itself carries literal examples) and
 *  is not chain evidence. */
export function detectAcpArtifacts(body: Buffer, parsed: unknown): AcpArtifactKind | null {
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // ACP_TAG_RE matches the JSON-escaped form (tokens=\"…\") because it
        // was born scanning the raw wire buffer; re-encode the parsed history
        // text so both paths share one regex.
        const encoded = JSON.stringify(historyTextOf(parsed as Record<string, unknown>));
        if (encoded.includes("\x3cacp ") && ACP_TAG_RE.test(encoded)) return "tags";
    } else if (body.includes("\x3cacp ") && ACP_TAG_RE.test(body.toString("utf8"))) {
        return "tags";
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const names = historyToolCallNames(parsed as Record<string, unknown>);
        if (names.has("acp_status") && names.has("search_context")) return "tool-history";
    }
    return null;
}

/** Text of HISTORY items only (messages/input/contents), excluding
 *  system/developer-role messages; the top-level system / instructions
 *  fields are never visited. Mirrors the container walk of
 *  historyToolCallNames. */
function historyTextOf(parsed: Record<string, unknown>): string {
    const parts: string[] = [];
    const container = Array.isArray(parsed.messages) ? parsed.messages
        : Array.isArray(parsed.input) ? parsed.input
        : Array.isArray(parsed.contents) ? parsed.contents
        : null;
    if (container) {
        for (const item of container) collectHistoryText(item, parts);
    }
    return parts.join("\n");
}

function collectHistoryText(item: unknown, out: string[]): void {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const it = item as Record<string, unknown>;
    if (it.role === "system" || it.role === "developer") return;
    const content = it.content;
    if (typeof content === "string") out.push(content);
    else if (Array.isArray(content)) {
        for (const block of content) {
            if (block && typeof block === "object" && !Array.isArray(block) && typeof (block as Record<string, unknown>).text === "string") {
                out.push((block as Record<string, unknown>).text as string);
            }
        }
    }
    const parts = it.parts;
    if (Array.isArray(parts)) {
        for (const part of parts) {
            if (part && typeof part === "object" && !Array.isArray(part) && typeof (part as Record<string, unknown>).text === "string") {
                out.push((part as Record<string, unknown>).text as string);
            }
        }
    }
}

/** Collect tool names invoked in HISTORY items only: OpenAI
 *  messages[].tool_calls[].function.name, Anthropic content blocks
 *  {type:"tool_use",name}, Responses input[] {type:"function_call",name},
 *  Gemini contents[].parts[].functionCall.name. The top-level `tools`
 *  declaration array is deliberately NOT scanned — a declaration without a
 *  historical call is the normal shape of a bili-managed client, not
 *  evidence of another bili instance (#1086 group E). Prose mentioning the
 *  names is likewise not counted. */
function historyToolCallNames(parsed: Record<string, unknown>): Set<string> {
    const names = new Set<string>();
    const container = Array.isArray(parsed.messages) ? parsed.messages
        : Array.isArray(parsed.input) ? parsed.input
        : Array.isArray(parsed.contents) ? parsed.contents
        : null;
    if (!container) return names;
    for (const item of container) visitHistoryItem(item, names);
    return names;
}

function visitHistoryItem(item: unknown, names: Set<string>): void {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const it = item as Record<string, unknown>;
    const toolCalls = it.tool_calls;
    if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
            if (!tc || typeof tc !== "object" || Array.isArray(tc)) continue;
            const fn = (tc as Record<string, unknown>).function;
            if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof (fn as Record<string, unknown>).name === "string") {
                names.add((fn as Record<string, unknown>).name as string);
            }
        }
    }
    if (it.type === "function_call" && typeof it.name === "string") names.add(it.name);
    const content = it.content;
    if (Array.isArray(content)) {
        for (const block of content) {
            if (block && typeof block === "object" && !Array.isArray(block)
                && (block as Record<string, unknown>).type === "tool_use"
                && typeof (block as Record<string, unknown>).name === "string") {
                names.add((block as Record<string, unknown>).name as string);
            }
        }
    }
    const parts = it.parts;
    if (Array.isArray(parts)) {
        for (const part of parts) {
            if (!part || typeof part !== "object" || Array.isArray(part)) continue;
            const fc = (part as Record<string, unknown>).functionCall;
            if (fc && typeof fc === "object" && !Array.isArray(fc) && typeof (fc as Record<string, unknown>).name === "string") {
                names.add((fc as Record<string, unknown>).name as string);
            }
        }
    }
}
