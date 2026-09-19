// #617: opt-in removal of HISTORICAL image payloads. Old base64 screenshots
// otherwise ride along verbatim on every request (the wire codecs move them
// out of CoreMessage.text into sidecars, so compression folds the TEXT but the
// raw image bytes are forwarded anyway — see #488). When enabled, every message
// EXCEPT the most recent `keepRecent` has its image parts dropped before the
// wire rebuild; image-only content collapses to a "[image]" text placeholder so
// message count / role ordering stay stable. Recent-N images survive untouched.
//
// Pure function over the RAW parsed request body (mirrors the per-protocol
// traversal in src/image-tokens.ts, so a stripped body drives
// imageTokensInRawBody → 0 and clears the #488 image floor). Returns the input
// reference unchanged when nothing changed, so an image-free or disabled body
// is byte-identical downstream. Content-hash message ids shift once per message
// when it ages out of the recent-N window (self-healing via orphan-GC).

export type StripProtocol = "anthropic" | "openai" | "responses" | "google" | null;

export interface StripResult {
    body: unknown;
    /** Number of image parts removed (0 when the body is returned unchanged). */
    removed: number;
}

export const DEFAULT_STRIP_IMAGES_KEEP_RECENT = 5;

const IMAGE_PLACEHOLDER = "[image]";

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

function isImagePart(protocol: Exclude<StripProtocol, null>, part: unknown): boolean {
    if (!isObj(part)) return false;
    // Gemini has no per-part `type` discriminator: an image IS a part carrying
    // an inlineData / fileData payload.
    if (protocol === "google") return part.inlineData !== undefined || part.fileData !== undefined;
    if (protocol === "responses") return part.type === "input_image";
    if (protocol === "openai") return part.type === "image_url";
    return part.type === "image";
}

/** A single text part standing in for a dropped image-only payload. Responses
 *  uses `input_text`; OpenAI chat + Anthropic use `text`; Gemini parts are
 *  undiscriminated — a bare `{text}` part. */
function placeholderContent(protocol: Exclude<StripProtocol, null>): Record<string, unknown>[] {
    if (protocol === "google") return [{ text: IMAGE_PLACEHOLDER }];
    const type = protocol === "responses" ? "input_text" : "text";
    return [{ type, text: IMAGE_PLACEHOLDER }];
}

export function stripHistoricalImages(body: unknown, protocol: StripProtocol, keepRecent: number): StripResult {
    if (!protocol || !isObj(body)) return { body, removed: 0 };
    const recentCount = Math.max(0, Math.floor(keepRecent));

    if (protocol === "responses") {
        const input = body.input;
        if (!Array.isArray(input)) return { body, removed: 0 };
        const cutoff = input.length - recentCount;
        let removed = 0;
        let touched = false;
        const nextInput = input.map((item, i) => {
            if (i < cutoff && isObj(item) && Array.isArray(item.content)) {
                const content = item.content as unknown[];
                const imgs = content.filter((p) => isImagePart("responses", p)).length;
                if (imgs > 0) {
                    removed += imgs;
                    touched = true;
                    const kept = content.filter((p) => !isImagePart("responses", p));
                    return { ...item, content: kept.length > 0 ? kept : placeholderContent("responses") };
                }
            }
            return item;
        });
        if (!touched) return { body, removed: 0 };
        return { body: { ...body, input: nextInput }, removed };
    }

    if (protocol === "google") {
        // Gemini images are inlineData / fileData PARTS inside a content's
        // parts array — dropping them leaves the surrounding text parts of the
        // same content intact (the analogue of the per-message content arrays).
        const contents = body.contents;
        if (!Array.isArray(contents)) return { body, removed: 0 };
        const cutoff = contents.length - recentCount;
        let removed = 0;
        let touched = false;
        const nextContents = contents.map((c, i) => {
            if (i < cutoff && isObj(c) && Array.isArray(c.parts)) {
                const parts = c.parts as unknown[];
                const imgs = parts.filter((p) => isImagePart("google", p)).length;
                if (imgs > 0) {
                    removed += imgs;
                    touched = true;
                    const kept = parts.filter((p) => !isImagePart("google", p));
                    return { ...c, parts: kept.length > 0 ? kept : placeholderContent("google") };
                }
            }
            return c;
        });
        if (!touched) return { body, removed: 0 };
        return { body: { ...body, contents: nextContents }, removed };
    }

    const messages = body.messages;
    if (!Array.isArray(messages)) return { body, removed: 0 };
    const cutoff = messages.length - recentCount;
    let removed = 0;
    let touched = false;
    const nextMessages = messages.map((m, i) => {
        if (i < cutoff && isObj(m) && Array.isArray(m.content)) {
            const content = m.content as unknown[];
            const imgs = content.filter((p) => isImagePart(protocol, p)).length;
            if (imgs > 0) {
                removed += imgs;
                touched = true;
                const kept = content.filter((p) => !isImagePart(protocol, p));
                return { ...m, content: kept.length > 0 ? kept : placeholderContent(protocol) };
            }
        }
        return m;
    });
    if (!touched) return { body, removed: 0 };
    return { body: { ...body, messages: nextMessages }, removed };
}
