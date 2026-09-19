// #488: images are invisible to the kernel's token model (wire codecs move them
// out of CoreMessage.text into sidecars), yet they ARE forwarded verbatim — so
// every fit decision built on the text-only estimate undercounts image-bearing
// payloads up to 15×. This module estimates the image share of a RAW request
// body so callers can add it to the text estimate. Known base64 payloads are
// charged ceil(base64Length/4) — the same chars/4 rule defaultCountTokens uses,
// matching how byte-counting relays actually bill (#488: 7 screenshots ≈ 1.4M
// tokens); remote URLs we cannot size get a flat conservative cost. The billing
// mode (see #767 below) decides which of these applies per upstream.
// #767: that overestimate is not just cosmetic — when a session's historical
// lastInputTokens baseline sits above the window, BOTH safe-forward paths close
// at once (#496's forward-once requires a sub-window baseline; #300's
// stale-baseline fit requires payloadEstimate < limit, which base64/4 pushes
// past the window), leaving a 502 loop even though the real image bill is a few
// thousand tokens. The billing mode fixes the estimate at its source:
//   bytes  — ceil(base64/4), the conservative default for byte-counting relays;
//   pixels — parse the container header (PNG/JPEG/WebP/GIF/BMP) for real
//            dimensions and charge the OpenAI high-detail tile model
//            (85 + 170×tiles, ≤ 2805); unparsable formats fall back to a flat
//            PIXEL_IMAGE_FALLBACK_TOKENS. Mode resolution: explicit config wins;
//            "auto" classifies known first-party pixel-tile hosts.

import { responsesToolImageParts } from "./responses-tool-output.js";

export const REMOTE_IMAGE_TOKENS = 4096;

/** #767: flat per-image cost in pixels mode when the container has no parsable
 *  dimensions. Sits well above both published first-party ceilings (OpenAI
 *  high-detail max 85 + 170×16 = 2805; Anthropic ~1534) while staying far below
 *  base64/4 for any inline image over ~64KB. */
export const PIXEL_IMAGE_FALLBACK_TOKENS = 16_384;

export type ImageBillingMode = "auto" | "pixels" | "bytes";
export type ResolvedImageBilling = "pixels" | "bytes";

/** First-party upstreams that bill images by pixel tiles, not raw bytes.
 *  Suffix-matched so api.openai.com / *.openai.azure.com / chatgpt.com
 *  (backend-api/codex) all classify without an explicit override. */
const PIXEL_TILE_HOSTS = ["api.openai.com", "openai.com", "openai.azure.com", "chatgpt.com", "api.anthropic.com"];

/** Resolve a configured mode against the upstream URL. Explicit "pixels"/
 *  "bytes" always win; "auto" (or unset) classifies by host — unknown hosts
 *  stay on the conservative bytes estimate. */
export function resolveImageBilling(mode: ImageBillingMode | undefined, upstreamUrl: string | undefined): ResolvedImageBilling {
    if (mode === "pixels") return "pixels";
    if (mode === "bytes") return "bytes";
    if (!upstreamUrl) return "bytes";
    let host: string;
    try {
        host = new URL(upstreamUrl).hostname.toLowerCase();
    } catch {
        return "bytes";
    }
    for (const h of PIXEL_TILE_HOSTS) {
        if (host === h || host.endsWith("." + h)) return "pixels";
    }
    return "bytes";
}

function imageTokenCap(): number {
    const v = Number(process.env.BILI_IMAGE_TOKEN_CAP ?? "");
    return Number.isInteger(v) && v > 0 ? v : 0;
}

function applyCap(cost: number): number {
    const cap = imageTokenCap();
    return cap > 0 ? Math.min(cost, cap) : cost;
}

type Dims = { w: number; h: number };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];

function pngDims(b: Buffer): Dims | undefined {
    if (b.length < 24 || !PNG_SIG.every((v, i) => b[i] === v)) return undefined;
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    return w > 0 && h > 0 ? { w, h } : undefined;
}

function gifDims(b: Buffer): Dims | undefined {
    if (b.length < 10 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return undefined; // GIF87a/GIF89a
    const w = b.readUInt16LE(6), h = b.readUInt16LE(8);
    return w > 0 && h > 0 ? { w, h } : undefined;
}

function bmpDims(b: Buffer): Dims | undefined {
    if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4d) return undefined; // "BM"
    const w = b.readUInt32LE(18), h = Math.abs(b.readInt32LE(22));
    return w > 0 && h > 0 ? { w, h } : undefined;
}

function webpDims(b: Buffer): Dims | undefined {
    if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return undefined;
    const fourcc = b.toString("ascii", 12, 16);
    // RIFF(12) + FourCC(4) + ChunkSize(4) → chunk data starts at offset 20.
    if (fourcc === "VP8 ") {
        // RFC 6386 §9.1: frame tag(3) + sync code 9D 01 2A, then 14-bit dims.
        if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
        const w = b.readUInt16LE(26) & 0x3fff, h = b.readUInt16LE(28) & 0x3fff;
        return w > 0 && h > 0 ? { w, h } : undefined;
    }
    if (fourcc === "VP8L") {
        if (b[20] !== 0x2f) return undefined; // lossless signature byte
        // 32-bit little-endian pack after the signature: width-1 (14 bits) |
        // height-1 (14 bits) | version (4 bits) — width and height share byte 22.
        const w = ((b[22] & 0x3f) << 8 | b[21]) + 1, h = (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) + 1;
        return w > 0 && h > 0 ? { w, h } : undefined;
    }
    if (fourcc === "VP8X") {
        const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
        return w > 0 && h > 0 ? { w, h } : undefined;
    }
    return undefined;
}

function jpegDims(b: Buffer): Dims | undefined {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
    let off = 2;
    while (off + 4 <= b.length) {
        if (b[off] !== 0xff) { off += 1; continue; }
        const marker = b[off + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
        if (marker === 0xda) break; // SOS with no SOF before it — malformed
        const segLen = b.readUInt16BE(off + 2);
        if (segLen < 2) break;
        // SOFn (C0-C3, C5-C7, C9-CB, CD-CF): precision(1) height(2) width(2)…
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            if (off + 9 > b.length) break;
            const h = b.readUInt16BE(off + 5), w = b.readUInt16BE(off + 7);
            if (w > 0 && h > 0) return { w, h };
            break;
        }
        off += 2 + segLen;
    }
    return undefined;
}

// Decode budgets: everything except JPEG keeps its dimensions within the first
// 32 bytes; JPEG SOF can sit behind large EXIF APP segments, so scan deeper —
// capping the decode at ~260KB keeps the worst case sub-millisecond.
const HEADER_SCAN_CHARS = 64;
const JPEG_SCAN_CHARS = 350_000;

/** Parse image dimensions from a base64 payload WITHOUT decoding the whole
 *  image (only the leading decode budget). Returns undefined for unknown or
 *  truncated containers — callers fall back to the flat pixels-mode cost. */
export function decodeImageDims(b64: string): Dims | undefined {
    const head = Buffer.from(b64.slice(0, HEADER_SCAN_CHARS), "base64");
    for (const parse of [pngDims, gifDims, bmpDims, webpDims]) {
        const d = parse(head);
        if (d) return d;
    }
    if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) {
        return jpegDims(Buffer.from(b64.slice(0, JPEG_SCAN_CHARS), "base64"));
    }
    return undefined;
}

const TILE_EDGE = 512;
const TILE_SHORT_SIDE = 768;
const TILE_MAX_EDGE = 2048;

/** OpenAI high-detail tile model (published formula): short side scaled UP to
 *  768, long side capped at 2048, then 512px tiles at 170 tokens each plus an
 *  85-token base. Bounds: [~765, 2805]. Anthropic's own model (area ≤ 1.568M
 *  px², 170/tile + 4) tops out near 1534, so this overestimates both
 *  first-party billings for typical screenshots — the safe direction for gate
 *  decisions (an undercount would forward a genuinely over-window payload). */
export function pixelTileEstimate(w: number, h: number): number {
    let sw = w, sh = h;
    const shortSide = Math.min(sw, sh);
    if (shortSide > 0 && shortSide < TILE_SHORT_SIDE) {
        const s = TILE_SHORT_SIDE / shortSide;
        sw *= s; sh *= s;
    }
    const longSide = Math.max(sw, sh);
    if (longSide > TILE_MAX_EDGE) {
        const s = TILE_MAX_EDGE / longSide;
        sw *= s; sh *= s;
    }
    const tiles = Math.ceil(sw / TILE_EDGE) * Math.ceil(sh / TILE_EDGE);
    return 85 + 170 * tiles;
}

function base64ImageCost(b64: string, billing: ResolvedImageBilling): number {
    if (billing === "pixels") {
        const dims = decodeImageDims(b64);
        return applyCap(dims ? pixelTileEstimate(dims.w, dims.h) : PIXEL_IMAGE_FALLBACK_TOKENS);
    }
    return applyCap(Math.ceil(b64.length / 4));
}

function costForUrl(url: string, billing: ResolvedImageBilling): number {
    if (url.startsWith("data:")) {
        const i = url.indexOf("base64,");
        if (i >= 0) return base64ImageCost(url.slice(i + "base64,".length), billing);
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

export function imageTokensInParsedBody(protocol: "anthropic" | "openai" | "responses" | "google", body: unknown, billing: ResolvedImageBilling = "bytes"): number {
    if (!isObj(body)) return 0;
    let total = 0;
    if (protocol === "google") {
        // Gemini carries images as `inlineData` (raw base64 in `data`) or
        // `fileData` (a remote `fileUri`) PARTS of `contents[].parts` — there is
        // no separate content-array layer and no `type` discriminator.
        const contents = body.contents;
        if (!Array.isArray(contents)) return 0;
        for (const c of contents) {
            if (!isObj(c) || !Array.isArray(c.parts)) continue;
            for (const part of c.parts) {
                if (!isObj(part)) continue;
                const inline = part.inlineData;
                if (isObj(inline) && typeof inline.data === "string") total += base64ImageCost(inline.data, billing);
                const file = part.fileData;
                if (isObj(file) && typeof file.fileUri === "string") total += costForUrl(file.fileUri, billing);
            }
        }
        return total;
    }
    if (protocol === "responses") {
        const input = body.input;
        if (!Array.isArray(input)) return 0;
        for (const item of input) {
            if (!isObj(item)) continue;
            const parts = Array.isArray(item.content) ? item.content : responsesToolImageParts(item);
            if (!parts) continue;
            for (const part of parts) {
                if (!isObj(part) || part.type !== "input_image") continue;
                const url = urlOf(part.image_url);
                if (url) total += costForUrl(url, billing);
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
                if (url) total += costForUrl(url, billing);
            } else {
                if (part.type !== "image") continue;
                const src = part.source;
                if (isObj(src) && src.type === "base64" && typeof src.data === "string") total += base64ImageCost(src.data, billing);
                else if (isObj(src) && src.type === "url" && typeof src.url === "string") total += costForUrl(src.url, billing);
            }
        }
    }
    return total;
}

// Cheap gate: most bodies carry no images — skip the JSON parse entirely then.
// prepared.body is bili's own compact JSON.stringify, but client raw buffers
// may carry spaces, so probe both forms.
export function imageTokensInRawBody(protocol: "anthropic" | "openai" | "responses" | "google", raw: string | Buffer, billing: ResolvedImageBilling = "bytes"): number {
    const s = typeof raw === "string" ? raw : raw.toString("utf8");
    const probe =
        protocol === "google" ? s.includes("inlineData") || s.includes("fileData")
        : protocol === "responses" ? s.includes("input_image")
        : protocol === "openai" ? s.includes("image_url")
        : s.includes('"type":"image"') || s.includes('"type": "image"');
    if (!probe) return 0;
    try {
        return imageTokensInParsedBody(protocol, JSON.parse(s), billing);
    } catch {
        return 0;
    }
}
