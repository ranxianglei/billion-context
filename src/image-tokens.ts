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
//   bytes  — ceil(base64/4), EXPLICIT opt-in for byte-counting relays only
//            (#1843: as an implicit default it was the 15× poison — every window
//            gate inherited its ±1500% error bar);
//   pixels — parse the container header (PNG/JPEG/WebP/GIF/BMP) for real
//            dimensions and charge the OpenAI high-detail tile model
//            (85 + 170×tiles, ≤ 2805); unparsable formats fall back to a flat
//            PIXEL_IMAGE_FALLBACK_TOKENS. Mode resolution: explicit config wins;
//            "auto" (the default) resolves to pixels for EVERY host (#1843 L2):
//            ~3K/screenshot is the right order of magnitude for all known vision
//            encoders, while base64/4 can be off by 15× either way. Operators
//            serving a true byte-billing relay set imageBilling:"bytes" on that
//            route (or BILI_IMAGE_BILLING=bytes).

import { responsesToolImageParts } from "./responses-tool-output.js";

export const REMOTE_IMAGE_TOKENS = 4096;

/** #767: flat per-image cost in pixels mode when the container has no parsable
 *  dimensions. Sits well above both published first-party ceilings (OpenAI
 *  high-detail max 85 + 170×16 = 2805; Anthropic ~1534) while staying far below
 *  base64/4 for any inline image over ~64KB. */
export const PIXEL_IMAGE_FALLBACK_TOKENS = 16_384;

export type ImageBillingMode = "auto" | "pixels" | "bytes";
export type ResolvedImageBilling = "pixels" | "bytes";

/** #1843 L2: explicit "pixels"/"bytes" always win; "auto" (or unset) resolves to
 *  pixels for EVERY host. The old first-party-host classification is gone: the
 *  pixel-tile prior is the right order of magnitude for all known vision
 *  encoders, and base64/4 as an implicit default was the 15× estimate poison
 *  (#1800 incident: 278,161 estimated vs 18,870 real). Byte-billing relays are
 *  now reached only by explicit configuration (route/global imageBilling:"bytes"
 *  or BILI_IMAGE_BILLING=bytes). */
export function resolveImageBilling(mode: ImageBillingMode | undefined, _upstreamUrl?: string): ResolvedImageBilling {
    if (mode === "bytes") return "bytes";
    return "pixels";
}

/** #1843 L3: per-image cost ceiling chain — env BILI_IMAGE_TOKEN_CAP (live-read,
 *  unchanged) wins over the CONFIG-level cap resolved by the caller (per-route
 *  imageTokenCap > global imageTokenCap, see server.ts imageTokenCapFor); 0 = no
 *  cap. The env tier stays here so unit callers that pass no config cap keep the
 *  historical env-only behavior exactly. */
function effectiveCap(configuredCap?: number): number {
    const v = Number(process.env.BILI_IMAGE_TOKEN_CAP ?? "");
    if (Number.isInteger(v) && v > 0) return v;
    return typeof configuredCap === "number" && Number.isInteger(configuredCap) && configuredCap > 0 ? configuredCap : 0;
}

function applyCap(cost: number, configuredCap?: number): number {
    const cap = effectiveCap(configuredCap);
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

function base64ImageCost(b64: string, billing: ResolvedImageBilling, configuredCap?: number): number {
    if (billing === "pixels") {
        const dims = decodeImageDims(b64);
        return applyCap(dims ? pixelTileEstimate(dims.w, dims.h) : PIXEL_IMAGE_FALLBACK_TOKENS, configuredCap);
    }
    return applyCap(Math.ceil(b64.length / 4), configuredCap);
}

function costForUrl(url: string, billing: ResolvedImageBilling, configuredCap?: number): number {
    if (url.startsWith("data:")) {
        const i = url.indexOf("base64,");
        if (i >= 0) return base64ImageCost(url.slice(i + "base64,".length), billing, configuredCap);
    }
    return applyCap(REMOTE_IMAGE_TOKENS, configuredCap);
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

function urlOf(v: unknown): string | undefined {
    if (typeof v === "string") return v;
    if (isObj(v) && typeof v.url === "string") return v.url;
    return undefined;
}

// #3398: payload bytes that bili forwards VERBATIM but no shape walker above
// recognizes — custom content parts ({type:"image",attachment:{…}} from hosts'
// own attachment flows), unknown google parts, nested tool_result media.
// Charged at serialized-bytes/4 in BOTH billing modes: the part's payload is an
// UNKNOWN shape (a 50-byte reference as often as an image container), so the
// flat PIXEL_IMAGE_FALLBACK_TOKENS overcharges small carriers by orders of
// magnitude and hard-blocks legitimate requests in fail-closed guards (the
// #554 side-request guard 413'd codex's tiny compaction handoff items — CI
// regression found on #3412 review); the proportional lower bound only delays
// folding when it undershoots, which is the safe direction for both gates.
// Call ONLY for parts the wire codec actually carries (each branch gates on its
// codec's preservation rule); parts the codec drops must not be charged.
function opaquePartCost(part: Record<string, unknown>, configuredCap?: number): number {
    return applyCap(Math.ceil(JSON.stringify(part).length / 4), configuredCap);
}

export function imageTokensInParsedBody(protocol: "anthropic" | "openai" | "responses" | "google", body: unknown, billing: ResolvedImageBilling = "bytes", configuredCap?: number): number {
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
                if (isObj(inline) && typeof inline.data === "string") { total += base64ImageCost(inline.data, billing, configuredCap); continue; }
                const file = part.fileData;
                if (isObj(file) && typeof file.fileUri === "string") { total += costForUrl(file.fileUri, billing, configuredCap); continue; }
                // #3398: unknown-shape content parts ride rawGoogleParts verbatim
                // (kernel google.ts: "Raw parts are preferred verbatim"). Text
                // and function carriers are already priced on their own
                // channels — skip them; everything else carrying bytes is charged.
                if (typeof part.text === "string" || isObj(part.functionCall) || isObj(part.functionResponse) || isObj(part.videoMetadata)) continue;
                total += opaquePartCost(part, configuredCap);
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
            if (!parts) {
                // #3398/#3412-review: unknown top-level item types are NOT
                // priced here — codex's control carriers (compaction,
                // compaction_trigger, additional_tools…) ride the preamble
                // verbatim but carry no media, and charging them 413'd a
                // legitimate side request (#554 guard). Only walked content
                // carriers below can hold media.
                continue;
            }
            for (const part of parts) {
                if (!isObj(part)) continue;
                if (part.type === "input_image") {
                    const url = urlOf(part.image_url);
                    if (url) total += costForUrl(url, billing, configuredCap);
                    continue;
                }
                // #3398: custom content parts on USER items ride the verbatim
                // raw-item round-trip (coreToResponses re-emits the original
                // item while display text matches); assistant/system items
                // degrade to text-only, so gate on role.
                if (item.type === "message" && item.role === "user" && part.type !== "input_text" && part.type !== "output_text") {
                    total += opaquePartCost(part, configuredCap);
                }
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
                if (part.type === "image_url") {
                    const url = urlOf(part.image_url);
                    if (url) total += costForUrl(url, billing, configuredCap);
                    continue;
                }
                // #1205: OpenAI-family file references — DeepSeek Files API
                // {"type":"file","file_id":"file-api-…"} and OpenAI's
                // {"type":"file","file":{…}}. Inline file_data is sized from
                // its base64 payload like any data URL; opaque id/url refs
                // cost the flat remote price (google fileData precedent).
                if (part.type === "file") {
                    const f = isObj(part.file) ? part.file : {};
                    const ref = typeof f.file_data === "string" ? f.file_data : typeof f.url === "string" ? f.url : undefined;
                    total += ref ? costForUrl(ref, billing, configuredCap) : applyCap(REMOTE_IMAGE_TOKENS, configuredCap);
                    continue;
                }
                // #3398: unrecognized part shapes ride rawOpenaiContentParts
                // VERBATIM on user messages (kernel openai.ts allNonTextParts,
                // #1205) — e.g. dsh read_image results {type:"image",attachment:{…}}.
                // Other roles reduce to text-only in the codec, so gate on
                // role==="user": charge exactly what is forwarded.
                if (part.type === "text") continue;
                if (m.role === "user") total += opaquePartCost(part, configuredCap);
                continue;
            } else {
                if (part.type === "image") {
                    const src = part.source;
                    if (isObj(src) && src.type === "base64" && typeof src.data === "string") total += base64ImageCost(src.data, billing, configuredCap);
                    else if (isObj(src) && src.type === "url" && typeof src.url === "string") total += costForUrl(src.url, billing, configuredCap);
                    continue;
                }
                // #3398: redacted_thinking carries an opaque base64 payload that
                // rides rawAnthropicBlock verbatim (kernel anthropic.ts) and is
                // invisible to msg.text.
                if (part.type === "redacted_thinking" && typeof part.data === "string") {
                    total += applyCap(Math.ceil((part.data as string).length / 4), configuredCap);
                    continue;
                }
                // #3398: tool_result blocks with non-text nested blocks ride the
                // WHOLE block verbatim (rawAnthropicBlock sidecar); the nested
                // media bytes sit outside msg.text and were unpriced.
                if (part.type === "tool_result" && Array.isArray(part.content)) {
                    for (const c of part.content) {
                        if (!isObj(c) || c.type === "text") continue;
                        const src = c.source;
                        if (isObj(src) && src.type === "base64" && typeof src.data === "string") total += base64ImageCost(src.data, billing, configuredCap);
                        else if (isObj(src) && src.type === "url" && typeof src.url === "string") total += costForUrl(src.url, billing, configuredCap);
                        else total += opaquePartCost(c, configuredCap);
                    }
                    continue;
                }
            }
        }
    }
    return total;
}

// Cheap gate: most bodies carry no images — skip the JSON parse entirely then.
// prepared.body is bili's own compact JSON.stringify, but client raw buffers
// may carry spaces, so probe both forms.
function bodyHasImagesProbe(protocol: "anthropic" | "openai" | "responses" | "google", s: string): boolean {
    // #3398: custom-shape media carries no recognizable literal — on the
    // wires where content arrays are the multi-part marker (openai/responses)
    // the array form itself is the gate; anthropic adds its two opaque block
    // types. Array-content bodies are the minority case on these wires, so the
    // extra parses stay rare (#2824's 170ms/32MiB worst case is unchanged).
    return protocol === "google" ? s.includes("inlineData") || s.includes("fileData")
        : protocol === "responses" ? s.includes("input_image") || s.includes('"content":[') || s.includes('"content": [')
        : protocol === "openai" ? s.includes("image_url") || s.includes('"type":"file"') || s.includes('"type": "file"') || s.includes('"content":[') || s.includes('"content": [')
        : s.includes('"type":"image"') || s.includes('"type": "image"') || s.includes('"type":"redacted_thinking"') || s.includes('"type":"document"');
}

export function imageTokensInRawBody(protocol: "anthropic" | "openai" | "responses" | "google", raw: string | Buffer, billing: ResolvedImageBilling = "bytes", configuredCap?: number): number {
    const s = typeof raw === "string" ? raw : raw.toString("utf8");
    if (!bodyHasImagesProbe(protocol, s)) return 0;
    try {
        return imageTokensInParsedBody(protocol, JSON.parse(s), billing, configuredCap);
    } catch {
        return 0;
    }
}

/** #1843 L1: hostname key for per-route image-cost learning — the route's
 *  vision encoder is a property of the upstream host, not of the path. */
export function upstreamHost(url?: string): string {
    if (!url) return "unknown";
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return url.toLowerCase();
    }
}

// #1843 L1: image COUNT walkers — same branch shapes as the cost walkers above
// (they must stay in lockstep or learned per-image costs misattribute), used by
// the learning layer to turn a usage report into an observed per-image bill.
export function countImagesInParsedBody(protocol: "anthropic" | "openai" | "responses" | "google", body: unknown): number {
    if (!isObj(body)) return 0;
    let n = 0;
    if (protocol === "google") {
        const contents = body.contents;
        if (!Array.isArray(contents)) return 0;
        for (const c of contents) {
            if (!isObj(c) || !Array.isArray(c.parts)) continue;
            for (const part of c.parts) {
                if (!isObj(part)) continue;
                const inline = part.inlineData;
                if (isObj(inline) && typeof inline.data === "string") { n += 1; continue; }
                const file = part.fileData;
                if (isObj(file) && typeof file.fileUri === "string") { n += 1; continue; }
                // #3398 lockstep: same opaque-part gate as the cost walker.
                if (typeof part.text === "string" || isObj(part.functionCall) || isObj(part.functionResponse) || isObj(part.videoMetadata)) continue;
                n += 1;
            }
        }
        return n;
    }
    if (protocol === "responses") {
        const input = body.input;
        if (!Array.isArray(input)) return 0;
        for (const item of input) {
            if (!isObj(item)) continue;
            const parts = Array.isArray(item.content) ? item.content : responsesToolImageParts(item);
            if (!parts) continue; // #3398 lockstep: no opaque top-level-item charge (see cost walker).
            for (const part of parts) {
                if (!isObj(part)) continue;
                if (part.type === "input_image") {
                    if (urlOf(part.image_url)) n += 1;
                    continue;
                }
                // #3398 lockstep: custom parts on USER items only (codec drops them elsewhere).
                if (item.type === "message" && item.role === "user" && part.type !== "input_text" && part.type !== "output_text") n += 1;
            }
        }
        return n;
    }
    const messages = body.messages;
    if (!Array.isArray(messages)) return 0;
    for (const m of messages) {
        if (!isObj(m) || !Array.isArray(m.content)) continue;
        for (const part of m.content) {
            if (!isObj(part)) continue;
            if (protocol === "openai") {
                if (part.type === "image_url") {
                    if (urlOf(part.image_url)) n += 1;
                    continue;
                }
                if (part.type === "file") { n += 1; continue; }
                if (part.type === "text") continue;
                // #3398 lockstep: user-role opaque parts only (codec drops them on other roles).
                if (m.role === "user") n += 1;
                continue;
            } else {
                if (part.type === "image") {
                    const src = part.source;
                    if (isObj(src) && src.type === "base64" && typeof src.data === "string") n += 1;
                    else if (isObj(src) && src.type === "url" && typeof src.url === "string") n += 1;
                    continue;
                }
                // #3398 lockstep: redacted_thinking base64 + nested tool_result media.
                if (part.type === "redacted_thinking" && typeof part.data === "string") { n += 1; continue; }
                if (part.type === "tool_result" && Array.isArray(part.content)) {
                    for (const c of part.content) {
                        if (!isObj(c) || c.type === "text") continue;
                        n += 1;
                    }
                    continue;
                }
            }
        }
    }
    return n;
}

export function countImagesInRawBody(protocol: "anthropic" | "openai" | "responses" | "google", raw: string | Buffer): number {
    const s = typeof raw === "string" ? raw : raw.toString("utf8");
    if (!bodyHasImagesProbe(protocol, s)) return 0;
    try {
        return countImagesInParsedBody(protocol, JSON.parse(s));
    } catch {
        return 0;
    }
}
