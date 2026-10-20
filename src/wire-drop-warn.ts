// #1205: the acp-kernel openai wire codec used to keep only text parts —
// plus image_url parts on user messages — silently dropping every other
// content-part type on the parse→rebuild round trip (DeepSeek's default
// attachment flow sends {"type":"file","file_id":…} parts, so the model
// never saw the pixels). acp-kernel 0.0.85 (PR #365) fixed the dominant
// class: user-message content parts are ALL carried through verbatim via the
// rawOpenaiContentParts sidecar, so user messages no longer drop anything.
// The remaining drop class is NON-user roles: the codec still reduces e.g.
// assistant content to text-only (stringContent), so parts riding those
// messages (assistant-carried images/attachments some clients emit) still
// vanish. This detector scans the RAW body for that surviving drop class so
// the proxy can log a one-time warn instead of staying silent.

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

interface WireDropReport {
    count: number;
    types: string[];
    firstIndex: number;
}

// Kernel 0.0.85+: non-user roles still go through text-only reduction
// (stringContent), so only text survives there.
const DEFAULT_PRESERVED = new Set(["text"]);

export function droppedOpenaiParts(body: unknown): WireDropReport | null {
    if (!isObj(body)) return null;
    const messages = body.messages;
    if (!Array.isArray(messages)) return null;
    let count = 0;
    const types = new Set<string>();
    let firstIndex = -1;
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!isObj(m) || !Array.isArray(m.content)) continue;
        if (m.role === "user") continue;
        for (const p of m.content) {
            if (!isObj(p) || DEFAULT_PRESERVED.has(typeof p.type === "string" ? p.type : "<no-type>")) continue;
            count++;
            types.add(typeof p.type === "string" ? p.type : "<no-type>");
            if (firstIndex < 0) firstIndex = i;
        }
    }
    return count > 0 ? { count, types: [...types].sort(), firstIndex } : null;
}

// #3410: the anthropic codec used to drop every top-level block type outside
// the known six — in the wild today that means document/PDF blocks vanished
// on each rebuild with no trace. The kernel now rides unknown blocks on the
// rawAnthropicBlock sidecar and re-emits them verbatim, so nothing is dropped
// anymore; this detector scans the RAW body for those types so the proxy can
// log a one-time notice (the user may not know their client sent a PDF, and
// such blocks are excluded from folding since bili cannot archive them).
const ANTHROPIC_KNOWN_BLOCKS = new Set([
    "text",
    "tool_use",
    "tool_result",
    "thinking",
    "image",
    "redacted_thinking",
]);

export function unknownAnthropicBlocks(body: unknown): WireDropReport | null {
    if (!isObj(body)) return null;
    const messages = body.messages;
    if (!Array.isArray(messages)) return null;
    let count = 0;
    const types = new Set<string>();
    let firstIndex = -1;
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!isObj(m) || !Array.isArray(m.content)) continue;
        for (const b of m.content) {
            if (!isObj(b) || typeof b.type !== "string") continue;
            if (ANTHROPIC_KNOWN_BLOCKS.has(b.type)) continue;
            count++;
            types.add(b.type);
            if (firstIndex < 0) firstIndex = i;
        }
    }
    return count > 0 ? { count, types: [...types].sort(), firstIndex } : null;
}
