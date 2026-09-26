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

interface DroppedOpenaiPartsReport {
    count: number;
    types: string[];
    firstIndex: number;
}

// Kernel 0.0.85+: non-user roles still go through text-only reduction
// (stringContent), so only text survives there.
const DEFAULT_PRESERVED = new Set(["text"]);

export function droppedOpenaiParts(body: unknown): DroppedOpenaiPartsReport | null {
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
