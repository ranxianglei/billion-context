// #488: images are invisible to the kernel's token model (wire codecs move them
// out of CoreMessage.text into sidecars), yet they ARE forwarded verbatim — so
// every fit decision built on the text-only estimate undercounts image-bearing
// payloads up to 15×. This module estimates the image share of a RAW request
// body so callers can add it to the text estimate. Known base64 payloads are
// charged ceil(base64Length/4) — the same chars/4 rule defaultCountTokens uses,
// matching how byte-counting relays actually bill (#488: 7 screenshots ≈ 1.4M
// tokens); remote URLs we cannot size get a flat conservative cost. Pixel-tile
// upstreams (official Anthropic/OpenAI) will see an overestimate — set
// BILI_IMAGE_TOKEN_CAP to clamp the per-image cost.

export const REMOTE_IMAGE_TOKENS = 4096;

function imageTokenCap(): number {
    const v = Number(process.env.BILI_IMAGE_TOKEN_CAP ?? "");
    return Number.isInteger(v) && v > 0 ? v : 0;
}

function applyCap(cost: number): number {
    const cap = imageTokenCap();
    return cap > 0 ? Math.min(cost, cap) : cost;
}

function costForUrl(url: string): number {
    if (url.startsWith("data:")) {
        const i = url.indexOf("base64,");
        if (i >= 0) return applyCap(Math.ceil((url.length - i - "base64,".length) / 4));
    }
    return applyCap(REMOTE_IMAGE_TOKENS);
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

function urlOf(v: unknown): string | undefined {
    if (typeof v === "string") return v;
    if (isObj(v) && typeof v.url === "string") return v.url;
    return undefined;
}

export function imageTokensInParsedBody(protocol: "anthropic" | "openai" | "responses", body: unknown): number {
    if (!isObj(body)) return 0;
    let total = 0;
    if (protocol === "responses") {
        const input = body.input;
        if (!Array.isArray(input)) return 0;
        for (const item of input) {
            if (!isObj(item) || !Array.isArray(item.content)) continue;
            for (const part of item.content) {
                if (!isObj(part) || part.type !== "input_image") continue;
                const url = urlOf(part.image_url);
                if (url) total += costForUrl(url);
            }
        }
        return total;
    }
    const messages = body.messages;
    if (!Array.isArray(messages)) return 0;
    for (const m of messages) {
        if (!isObj(m) || !Array.isArray(m.content)) continue;
        for (const part of m.content) {
            if (!isObj(part)) continue;
            if (protocol === "openai") {
                if (part.type !== "image_url") continue;
                const url = urlOf(part.image_url);
                if (url) total += costForUrl(url);
            } else {
                if (part.type !== "image") continue;
                const src = part.source;
                if (isObj(src) && src.type === "base64" && typeof src.data === "string") total += applyCap(Math.ceil(src.data.length / 4));
                else if (isObj(src) && src.type === "url" && typeof src.url === "string") total += costForUrl(src.url);
            }
        }
    }
    return total;
}

// Cheap gate: most bodies carry no images — skip the JSON parse entirely then.
// prepared.body is bili's own compact JSON.stringify, but client raw buffers
// may carry spaces, so probe both forms.
export function imageTokensInRawBody(protocol: "anthropic" | "openai" | "responses", raw: string | Buffer): number {
    const s = typeof raw === "string" ? raw : raw.toString("utf8");
    const probe =
        protocol === "responses" ? s.includes("input_image")
        : protocol === "openai" ? s.includes("image_url")
        : s.includes('"type":"image"') || s.includes('"type": "image"');
    if (!probe) return 0;
    try {
        return imageTokensInParsedBody(protocol, JSON.parse(s));
    } catch {
        return 0;
    }
}
