// #3400: egress image rescale — the simplified re-do of the removed #3295
// image pipeline. One shared pass over the decoded generic message structure
// (BiliMessage[]) at every egress point AFTER the kernel fold and BEFORE
// protocol encoding: big images are re-encoded SMALLER on the outbound copy
// only; session storage keeps the originals byte-exact (the wire received
// them, the storage holds them — we never rewrite history). A stable
// annotation rides beside each shrunken image telling the model both sizes
// and how to fetch the original (acp_read_original_image, registered only on
// lanes that support injected tools; codex gets sizes only).
//
// Design constraints (issue #3400):
//  - ZERO kernel changes: no version bump, no golden ledger, no kernel source.
//  - Deterministic: same input bytes → same output bytes AND same annotation
//    text, so the outbound body is byte-stable across rounds for the same
//    history (the #3266 75%→28% cache-hit lesson). A process-lifetime hash
//    cache encodes each unique image once.
//  - Structural loop guard: images carried by a acp_read_original_image tool
//    result are NEVER re-shrunk (that exemption is what kills the #3266
//    read→resend→re-shrink cycle). Zero state, survives restarts.
//  - Pure-JS encoder (jimp, optionalDependency loaded lazily at first use):
//    sharp stays out, zero native dependencies; jimp stays EXTERNAL to the
//    bundle because its transitive dep zod must never be statically linked
//    into dist (#3516 P0 — see tsup.config.ts). When jimp cannot be resolved
//    (file-copy installs without a node_modules tree) rescaling degrades to
//    pass-through: originals forward untouched, proxy fully functional.
//    png/jpeg/bmp are handled; gif/webp/unknown formats pass through
//    untouched (no reliable pure-JS round-trip).
//  - No system-prompt injection, no sticky-restore state machine, no shrink
//    records, no stats counters (logs are the observability surface).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseDataUrl, type BiliMessage } from "acp-kernel/wire";
import { decodeImageDims } from "./image-tokens.js";
import { imageRescaleEnabled, imageRescaleMaxDim } from "./knobs.js";
import { READ_ORIGINAL_IMAGE_TOOL_NAME } from "./compress-tool.js";
import { toolFail, toolOk, type ProxyToolResult } from "./proxy-tool-result.js";
import type { Session } from "./session.js";
import { log, type Logger } from "./logger.js";

/** Trigger gate: longest edge above maxDim OR decoded bytes above this. */
const RESCALE_TRIGGER_BYTES = 100 * 1024;
/** Keep-smaller rule: adopt the re-encoding only when it saves ≥20%. */
const KEEP_RATIO = 0.8;
/** Explicit JPEG quality — pinned so the output is deterministic. */
const JPEG_QUALITY = 80;
/** Process-lifetime encode cache cap (unique images per process). */
const ENCODE_CACHE_MAX = 512;

type RescaledMime = "image/png" | "image/jpeg" | "image/bmp";

const MIME_TO_JIMP: Record<string, RescaledMime> = {
    "image/png": "image/png",
    "image/jpeg": "image/jpeg",
    "image/jpg": "image/jpeg",
    "image/bmp": "image/bmp",
};

function normalizeMime(mediaType: string | undefined): RescaledMime | undefined {
    if (typeof mediaType !== "string") return undefined;
    return MIME_TO_JIMP[mediaType.trim().toLowerCase()];
}

/** Decoded byte length of a base64 payload (exact for valid base64). */
function b64Bytes(b64: string): number {
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor(b64.length / 4) * 3 - pad);
}

interface RescaledImage {
    base64: string;
    width: number;
    height: number;
    origWidth: number;
    origHeight: number;
    origBytes: number;
    newBytes: number;
    mime: string;
    /** True when this result came from an actual encode (cache miss). */
    fresh: boolean;
}

// hash → pending/finished encoding. A promise map doubles as the in-flight
// de-duplication: concurrent requests for the same image share one encode.
const encodeCache = new Map<string, Promise<RescaledImage | null>>();

type JimpModule = typeof import("jimp");

let jimpLoad: Promise<JimpModule | null> | undefined;

// #3516 P0: jimp is EXTERNAL to the bundle (see tsup.config.ts) — resolve it
// once at first use. A failed resolution is permanent for this process;
// rescaling then degrades to pass-through instead of crashing the proxy.
function loadJimp(): Promise<JimpModule | null> {
    if (jimpLoad === undefined) {
        jimpLoad = import("jimp").catch((err: unknown) => {
            log("warn", `[image-rescale] jimp unavailable (${err instanceof Error ? err.message : String(err)}) — image rescaling disabled for this process (originals pass through)`);
            return null;
        });
    }
    return jimpLoad;
}

// force (#3701 byte-shed ladder): skips the 100 KiB trigger gate and adopts ANY
// strict byte reduction (not just <80%). A within-maxDim image is NOT skipped
// here — a same-dim re-encode is adopted only if strictly smaller; the byte-shed
// caller pre-filters maxDim-fitting images before calling (egress-shed rung B).
async function doRescale(mime: RescaledMime, b64: string, origBytes: number, maxDim: number, force = false): Promise<RescaledImage | null> {
    try {
        const mod = await loadJimp();
        if (mod === null) return null;
        const img = await mod.Jimp.read(Buffer.from(b64, "base64"));
        const ow = img.width;
        const oh = img.height;
        // Re-check the gate against the AUTHORITATIVE dims (the header parse
        // may have failed for exotic containers).
        const scale = Math.min(1, maxDim / Math.max(ow, oh));
        if (scale >= 1 && (!force || origBytes <= RESCALE_TRIGGER_BYTES)) return null;
        const tw = Math.max(1, Math.round(ow * scale));
        const th = Math.max(1, Math.round(oh * scale));
        if (tw !== ow || th !== oh) await img.resize({ w: tw, h: th });
        const out = mime === "image/jpeg"
            ? await img.getBuffer("image/jpeg", { quality: JPEG_QUALITY })
            : await img.getBuffer(mime);
        if (force ? out.length >= origBytes : out.length >= origBytes * KEEP_RATIO) return null;
        return {
            base64: out.toString("base64"),
            width: tw,
            height: th,
            origWidth: ow,
            origHeight: oh,
            origBytes,
            newBytes: out.length,
            mime,
            fresh: true,
        };
    } catch {
        return null;
    }
}

/** Decide + encode ONE image occurrence. Returns null when the original must
 *  be forwarded untouched (unsupported format, below the gate, low benefit,
 *  or decode failure). Cached per content hash — each unique image encodes
 *  once per process. */
async function rescaleImage(mediaType: string, b64: string, maxDim: number): Promise<RescaledImage | null> {
    const mime = normalizeMime(mediaType);
    if (!mime || typeof b64 !== "string" || b64.length === 0) return null;
    const origBytes = b64Bytes(b64);
    const dims = decodeImageDims(b64);
    const gated = (dims !== undefined && Math.max(dims.w, dims.h) > maxDim) || origBytes > RESCALE_TRIGGER_BYTES;
    if (!gated) return null;
    const hash = createHash("sha256").update(b64, "utf8").digest("hex");
    let pending = encodeCache.get(hash);
    const cacheHit = pending !== undefined;
    if (!pending) {
        pending = doRescale(mime, b64, origBytes, maxDim);
        encodeCache.set(hash, pending);
        while (encodeCache.size > ENCODE_CACHE_MAX) {
            const oldest = encodeCache.keys().next().value;
            if (oldest === undefined || oldest === hash) break;
            encodeCache.delete(oldest);
        }
    }
    const result = await pending;
    // A cache hit serves the stored encode result again — mark it non-fresh so
    // the compression log fires exactly once per unique image (#3400 §8).
    if (result !== null && cacheHit) return { ...result, fresh: false };
    return result;
}

/** Test seam: drop the process-lifetime encode cache between cases. */
export function clearRescaleEncodeCache(): void {
    encodeCache.clear();
}

/** #3701 byte-shed ladder step: forced re-encode at an explicit longest-edge dim.
 *  Unlike rescaleImage there is no trigger gate and no keep-ratio floor — any strict
 *  reduction is adopted; images already within maxDim are left alone. Returns the new
 *  base64 (same mime) or null when nothing was saved (unsupported format, jimp absent,
 *  or the re-encode did not shrink). Cached per hash+dim. */
export async function shedDownscaleImage(mediaType: string, b64: string, maxDim: number): Promise<string | null> {
    const mime = normalizeMime(mediaType);
    if (!mime || typeof b64 !== "string" || b64.length === 0 || !Number.isFinite(maxDim) || maxDim <= 0) return null;
    const dim = Math.floor(maxDim);
    const hash = createHash("sha256").update(`${dim}:${b64}`, "utf8").digest("hex");
    let pending = encodeCache.get(hash);
    if (!pending) {
        pending = doRescale(mime, b64, b64Bytes(b64), dim, true);
        encodeCache.set(hash, pending);
        while (encodeCache.size > ENCODE_CACHE_MAX) {
            const oldest = encodeCache.keys().next().value;
            if (oldest === undefined || oldest === hash) break;
            encodeCache.delete(oldest);
        }
    }
    const r = await pending;
    return r === null ? null : r.base64;
}

function formatKb(bytes: number): number {
    return Math.round(bytes / 1024);
}

/** Deterministic annotation text beside a shrunken image. Derived ONLY from
 *  the image dims/bytes and the message ref — no timestamps, no counters —
 *  so the same history always produces the same outbound bytes. */
export function buildRescaleNote(opts: {
    ref?: string;
    toolArmed: boolean;
    width: number;
    height: number;
    kb: number;
    origWidth: number;
    origHeight: number;
    origKb: number;
    ratio: number;
}): string {
    const head = `[bili] 本图已降采样:当前 ${opts.width}×${opts.height} / ${opts.kb}KB;原图 ${opts.origWidth}×${opts.origHeight} / ${opts.origKb}KB`;
    if (opts.ref !== undefined && opts.toolArmed) {
        return `${head}(约 ${opts.ratio.toFixed(1)} 倍)。需要原分辨率细节(小字、颜色、对齐)时,调用 acp_read_original_image("${opts.ref}") 读取原图。原图较大,按需读取。`;
    }
    return `${head}。`;
}

function noteFor(ctx: RescaleCtx, ref: string | undefined, r: RescaledImage): string {
    return buildRescaleNote({
        ref,
        toolArmed: ctx.toolArmed,
        width: r.width,
        height: r.height,
        kb: formatKb(r.newBytes),
        origWidth: r.origWidth,
        origHeight: r.origHeight,
        origKb: formatKb(r.origBytes),
        ratio: r.newBytes > 0 ? r.origBytes / r.newBytes : 0,
    });
}

interface RescaleCtx {
    session: Session;
    sessionId: string;
    log: Logger;
    /** Longest-edge target; resolved from the knob by the caller. */
    maxDim: number;
    /** True when acp_read_original_image is registered for this session's lane —
     *  the annotation then carries the invocation entry; otherwise (codex,
     *  plugin mode) it reports sizes only. */
    toolArmed: boolean;
}

function refFor(session: Session, id: string | undefined): string | undefined {
    if (typeof id !== "string" || id.length === 0) return undefined;
    const ref = session.state.messageRefs.byRaw[id];
    return typeof ref === "string" && ref.length > 0 ? ref : undefined;
}

function logCompression(ctx: RescaleCtx, ref: string | undefined, r: RescaledImage): void {
    // Spec (#3400 §8): the compression log fires ONCE per unique image — a
    // hash-cache hit serves the same bytes without re-logging.
    if (!r.fresh) return;
    ctx.log("info", `[${ctx.sessionId}] [image-rescale] ${r.mime}${ref !== undefined ? ` ${ref}` : ""} ${r.origWidth}x${r.origHeight}/${formatKb(r.origBytes)}KB -> ${r.width}x${r.height}/${formatKb(r.newBytes)}KB`);
}

type Part = Record<string, unknown>;

function asPart(v: unknown): Part | undefined {
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Part) : undefined;
}

// ---------------------------------------------------------------------------
// Per-shape writers. Each returns a COPY (or copies) of the message with the
// shrunk bytes + annotation attached; the input array and its objects are
// never mutated (session state and persistence keep the originals).
// ---------------------------------------------------------------------------

/** Non-security, caller-fabricable convention: only exact decoded image bytes in
 *  this tool output match. The receipt line may ride any text part of the same
 *  output — typed on the Anthropic/Responses wires ({type:"text"} /
 *  {type:"input_text"}), untyped on the Google wire ({text}) — so the scan is
 *  shape-agnostic over string .text fields. Never search other messages or
 *  cache an exemption. */
export function matchesOriginalImageReceipt(b64: string, parts: unknown[]): boolean {
    const hashes = new Set<string>();
    for (const part of parts) {
        const p = asPart(part);
        if (typeof p?.text !== "string") continue;
        for (const line of p.text.split(/\r?\n/)) {
            const match = /^Billion original image receipt v1 sha256=([a-f0-9]{64})$/.exec(line);
            if (match) hashes.add(match[1]);
        }
    }
    if (hashes.size === 0) return false;
    return hashes.has(createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex"));
}

async function rescaleAnthropic(m: BiliMessage, ctx: RescaleCtx): Promise<BiliMessage[] | undefined> {
    const block = asPart(m.rawAnthropicBlock);
    if (!block) return undefined;
    if (block.type === "image") {
        const src = asPart(block.source);
        if (!src || src.type !== "base64" || typeof src.data !== "string") return undefined;
        const r = await rescaleImage(typeof src.media_type === "string" ? src.media_type : "image/png", src.data, ctx.maxDim);
        if (!r) return undefined;
        const ref = refFor(ctx.session, m.id);
        logCompression(ctx, ref, r);
        const copy: BiliMessage = { ...m, rawAnthropicBlock: { ...block, source: { ...src, data: r.base64 } } };
        // The codec drops m.text ("[image]") when rawAnthropicBlock is set, so
        // the annotation rides a SEPARATE adjacent core message: same role →
        // coreToAnthropic merges both into one wire message [image, text].
        const noteMsg: BiliMessage = { id: `acp_imgnote_${m.id}`, role: m.role, contentType: "text", text: noteFor(ctx, ref, r) };
        return [copy, noteMsg];
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
        const content = block.content as unknown[];
        const changed: unknown[] = [];
        let any = false;
        const ref = refFor(ctx.session, m.id);
        for (const part of content) {
            const p = asPart(part);
            if (p?.type === "image") {
                const src = asPart(p.source);
                if (src?.type === "base64" && typeof src.data === "string" && !matchesOriginalImageReceipt(src.data, content)) {
                    const r = await rescaleImage(typeof src.media_type === "string" ? src.media_type : "image/png", src.data, ctx.maxDim);
                    if (r) {
                        any = true;
                        logCompression(ctx, ref, r);
                        changed.push({ ...p, source: { ...src, data: r.base64 } });
                        changed.push({ type: "text", text: noteFor(ctx, ref, r) });
                        continue;
                    }
                }
            }
            changed.push(part);
        }
        if (!any) return undefined;
        return [{ ...m, rawAnthropicBlock: { ...block, content: changed } }];
    }
    return undefined;
}

async function rescaleOpenaiParts(m: BiliMessage, ctx: RescaleCtx): Promise<BiliMessage[] | undefined> {
    const ref = refFor(ctx.session, m.id);
    if (Array.isArray(m.rawOpenaiContentParts)) {
        const parts = m.rawOpenaiContentParts as unknown[];
        const changed: unknown[] = [];
        let any = false;
        for (const part of parts) {
            const p = asPart(part);
            if (p?.type === "image_url") {
                const url = asPart(p.image_url)?.url;
                if (typeof url === "string" && url.startsWith("data:")) {
                    const d = parseDataUrl(url);
                    if (d) {
                        const r = await rescaleImage(d.mediaType, d.base64, ctx.maxDim);
                        if (r) {
                            any = true;
                            logCompression(ctx, ref, r);
                            changed.push({ ...p, image_url: { ...(asPart(p.image_url) ?? {}), url: `data:${d.mediaType};base64,${r.base64}` } });
                            changed.push({ type: "text", text: noteFor(ctx, ref, r) });
                            continue;
                        }
                    }
                }
            }
            changed.push(part);
        }
        if (!any) return undefined;
        return [{ ...m, rawOpenaiContentParts: changed }];
    }
    if (m.rawOpenaiContent !== undefined) {
        const p = asPart(m.rawOpenaiContent);
        if (!p || p.type !== "image_url") return undefined;
        const url = asPart(p.image_url)?.url;
        if (typeof url !== "string" || !url.startsWith("data:")) return undefined;
        const d = parseDataUrl(url);
        if (!d) return undefined;
        const r = await rescaleImage(d.mediaType, d.base64, ctx.maxDim);
        if (!r) return undefined;
        logCompression(ctx, ref, r);
        // Convert the singular sidecar to the plural one carrying the note —
        // the codec prefers rawOpenaiContentParts when present, so the copy
        // drops the singular fields instead of double-rendering.
        const copy: BiliMessage = {
            ...m,
            rawOpenaiContentParts: [
                { ...p, image_url: { ...(asPart(p.image_url) ?? {}), url: `data:${d.mediaType};base64,${r.base64}` } },
                { type: "text", text: noteFor(ctx, ref, r) },
            ],
        };
        delete copy.rawOpenaiContent;
        delete copy.imageBase64;
        delete copy.imageMediaType;
        return [copy];
    }
    return undefined;
}

async function rescaleGoogle(m: BiliMessage, ctx: RescaleCtx): Promise<BiliMessage[] | undefined> {
    if (!Array.isArray(m.rawGoogleParts)) return undefined;
    const parts = m.rawGoogleParts as unknown[];
    const changed: unknown[] = [];
    let any = false;
    const notes: string[] = [];
    const ref = refFor(ctx.session, m.id);
    for (const part of parts) {
        const p = asPart(part);
        const inline = p ? asPart(p.inlineData) : undefined;
        if (inline && typeof inline.data === "string" && !matchesOriginalImageReceipt(inline.data, parts)) {
            const r = await rescaleImage(typeof inline.mimeType === "string" ? inline.mimeType : "image/png", inline.data, ctx.maxDim);
            if (r) {
                any = true;
                logCompression(ctx, ref, r);
                changed.push({ ...p, inlineData: { ...inline, data: r.base64 } });
                notes.push(noteFor(ctx, ref, r));
                continue;
            }
        }
        changed.push(part);
    }
    if (!any) return undefined;
    // The note appends to the core TEXT (never as a raw text part): the
    // codec's re-render path drops raw text parts whose joined value diverges
    // from m.text, but a changed m.text re-renders cleanly with every
    // non-text part kept verbatim.
    const text = (m.text ?? "") + ((m.text ?? "").length > 0 ? "\n\n" : "") + notes.join("\n");
    return [{ ...m, rawGoogleParts: changed, text }];
}

async function rescaleResponsesItem(m: BiliMessage, ctx: RescaleCtx): Promise<BiliMessage[] | undefined> {
    const item = asPart(m.rawResponsesItem);
    if (!item) return undefined;
    const toolOutput = item.type === "function_call_output" || item.type === "custom_tool_call_output";
    const partsKey = toolOutput ? "output" : item.type === "message" ? "content" : undefined;
    if (partsKey === undefined || !Array.isArray(item[partsKey])) return undefined;
    const content = item[partsKey] as unknown[];
    const changed: unknown[] = [];
    let first: RescaledImage | undefined;
    const ref = refFor(ctx.session, m.id);
    for (const part of content) {
        const p = asPart(part);
        if (p?.type === "input_image" && typeof p.image_url === "string" && p.image_url.startsWith("data:")) {
            const d = parseDataUrl(p.image_url);
            if (d && !(toolOutput && matchesOriginalImageReceipt(d.base64, content))) {
                const r = await rescaleImage(d.mediaType, d.base64, ctx.maxDim);
                if (r) {
                    if (!first) first = r;
                    logCompression(ctx, ref, r);
                    changed.push({ ...p, image_url: `data:${d.mediaType};base64,${r.base64}` });
                    // NO note part inside the item: coreToResponses' verbatim
                    // condition compares the item's display text against
                    // m.text — an inserted text part breaks the round-trip and
                    // silently drops the image. The annotation rides a
                    // separate adjacent message instead.
                    continue;
                }
            }
        }
        changed.push(part);
    }
    if (!first) return undefined;
    const copy: BiliMessage = { ...m, rawResponsesItem: { ...item, [partsKey]: changed } };
    if (toolOutput) return [{ ...copy, text: `${m.text ?? ""}\n\n${noteFor(ctx, ref, first)}` }];
    const noteMsg: BiliMessage = { id: `acp_imgnote_${m.id}`, role: "user", contentType: "text", text: noteFor(ctx, ref, first) };
    return [copy, noteMsg];
}

async function rescaleBareSidecar(m: BiliMessage, ctx: RescaleCtx): Promise<BiliMessage[] | undefined> {
    if (typeof m.imageBase64 !== "string" || m.imageBase64.length === 0) return undefined;
    const r = await rescaleImage(m.imageMediaType ?? "image/png", m.imageBase64, ctx.maxDim);
    if (!r) return undefined;
    const ref = refFor(ctx.session, m.id);
    logCompression(ctx, ref, r);
    const note = noteFor(ctx, ref, r);
    const text = (m.text ?? "") + ((m.text ?? "").length > 0 ? "\n\n" : "") + note;
    return [{ ...m, imageBase64: r.base64, text }];
}

/** The shared egress pass: walks the generic message structure once and
 *  returns a NEW array (untouched messages keep their object identity).
 *  No-op (same array) when the feature is disabled or nothing qualifies. */
export async function applyImageRescalePass(messages: BiliMessage[], ctx: RescaleCtx): Promise<BiliMessage[]> {
    if (!imageRescaleEnabled()) return messages;
    const out: BiliMessage[] = [];
    for (const m of messages) {
        // STRUCTURAL LOOP GUARD: a acp_read_original_image result carries the
        // original bytes by design — re-shrinking it would recreate the #3266
        // read→resend→re-shrink cycle. Zero state: the marker is the tool
        // name on the message itself.
        if (m.toolName === READ_ORIGINAL_IMAGE_TOOL_NAME) {
            out.push(m);
            continue;
        }
        let handled: BiliMessage[] | undefined;
        if (m.rawAnthropicBlock !== undefined) handled = await rescaleAnthropic(m, ctx);
        else if (Array.isArray(m.rawGoogleParts)) handled = await rescaleGoogle(m, ctx);
        else if (m.rawResponsesItem !== undefined) handled = await rescaleResponsesItem(m, ctx);
        else if (m.rawOpenaiContentParts !== undefined || m.rawOpenaiContent !== undefined) handled = await rescaleOpenaiParts(m, ctx);
        else if (m.imageBase64 !== undefined) handled = await rescaleBareSidecar(m, ctx);
        if (handled) out.push(...handled);
        else out.push(m);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Responses-API item-level walker (steady path only). patchResponsesInput
// rebuilds wire items from the RAW parsed input (input_image parts always come
// from slot.original), so the BiliMessage-level pass cannot reach the steady
// responses egress — this walker applies the same engine to the final
// ResponseInputItem[] instead. Annotations ride an input_text part directly
// after each shrunk input_image part in the same item's content/output array.
// ---------------------------------------------------------------------------

/** Resolve the mNNNNN ref of an image by matching its bytes against the
 *  session's incoming-image index (rebuilt from the raw inbound body every
 *  request). Ambiguous matches (same image under several refs) degrade to a
 *  size-only note rather than guess. Exported for the #3701 byte-shed
 *  placeholders, which quote the same refs. */
export async function refForItemBytes(session: Session, mediaType: string, b64: string): Promise<string | undefined> {
    const index = session.incomingImageIndex;
    if (!index) return undefined;
    const want = b64Bytes(b64);
    const candidates: Array<{ ref: string; mediaType: string; bytes: number; path: string }> = [];
    for (const [ref, entries] of index.entries()) {
        for (const e of entries) {
            if (e.bytes === want && e.mediaType === mediaType) candidates.push({ ref, mediaType: e.mediaType, bytes: e.bytes, path: e.path });
        }
    }
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0].ref;
    let matched: string | undefined;
    for (const c of candidates) {
        try {
            const buf = await readFile(c.path);
            if (buf.toString("base64") === b64) {
                if (matched !== undefined && matched !== c.ref) return undefined;
                matched = c.ref;
            }
        } catch {
            // evicted spill — not the match
        }
    }
    return matched;
}

/** Egress pass for the responses steady path (see module header). No-op
 *  (same array) when disabled or nothing qualifies. */
export async function applyImageRescaleItems(items: unknown[], ctx: RescaleCtx): Promise<unknown[]> {
    if (!imageRescaleEnabled()) return items;
    // call_id → tool name, for the structural exemption on tool outputs.
    const nameByCallId = new Map<string, string>();
    for (const item of items) {
        const i = asPart(item);
        if ((i?.type === "function_call" || i?.type === "custom_tool_call") && typeof i.call_id === "string" && typeof i.name === "string") {
            nameByCallId.set(i.call_id, i.name);
        }
    }
    const out: unknown[] = [];
    for (const item of items) {
        const i = asPart(item);
        // Structural loop guard, item form: an output answering a
        // acp_read_original_image call carries the original image by design.
        if (i && (i.type === "function_call_output" || i.type === "custom_tool_call_output")
            && typeof i.call_id === "string"
            && nameByCallId.get(i.call_id) === READ_ORIGINAL_IMAGE_TOOL_NAME) {
            out.push(item);
            continue;
        }
        // Image-bearing shapes on the Responses wire: user/message items
        // (content array) and tool outputs (output array — see
        // responsesToolImageParts, which models both).
        const partsKey = i?.type === "message" ? "content" : i?.type === "function_call_output" || i?.type === "custom_tool_call_output" ? "output" : undefined;
        if (partsKey !== undefined && i !== undefined && Array.isArray(i[partsKey])) {
            const parts = i[partsKey] as unknown[];
            const changed: unknown[] = [];
            let any = false;
            for (const part of parts) {
                const p = asPart(part);
                if (p?.type === "input_image" && typeof p.image_url === "string" && p.image_url.startsWith("data:")) {
                    const d = parseDataUrl(p.image_url);
                    if (d && !(partsKey === "output" && matchesOriginalImageReceipt(d.base64, parts))) {
                        const r = await rescaleImage(d.mediaType, d.base64, ctx.maxDim);
                        if (r) {
                            any = true;
                            const ref = await refForItemBytes(ctx.session, d.mediaType, d.base64);
                            logCompression(ctx, ref, r);
                            changed.push({ ...p, image_url: `data:${d.mediaType};base64,${r.base64}` });
                            changed.push({ type: "input_text", text: noteFor(ctx, ref, r) });
                            continue;
                        }
                    }
                }
                changed.push(part);
            }
            if (any) {
                out.push({ ...i, [partsKey]: changed });
                continue;
            }
        }
        out.push(item);
    }
    return out;
}

// ---------------------------------------------------------------------------
// acp_read_original_image execution.
// ---------------------------------------------------------------------------

const REF_PATTERN = /^m\d{5,}$/;

/** Execute acp_read_original_image: fetch the ORIGINAL bytes for a message ref
 *  from the local session storage (incoming-image index + spill dir) and
 *  return them as an image attachment — the tool result itself stays TEXT.
 *  Direct callers use the structural toolName exemption. PTC hosts must forward
 *  the receipt text beside the actual image in the SAME tool output. The digest
 *  is a caller-fabricable convention, not authenticated restore provenance. */
export async function executeReadOriginalImage(
    args: Record<string, unknown>,
    session: Session,
    log: Logger,
): Promise<ProxyToolResult & { image?: { base64: string; mediaType: string } }> {
    const ref = typeof args.ref === "string" ? args.ref.trim() : "";
    if (!REF_PATTERN.test(ref)) {
        return toolFail(`acp_read_original_image: invalid ref "${ref}" — pass the mNNNNN message ref quoted in the [bili] note beside the shrunken image.`);
    }
    const entries = session.incomingImageIndex?.get(ref);
    if (!entries || entries.length === 0) {
        return toolFail(`acp_read_original_image: no original image stored for ${ref} (it may no longer ride the conversation history). Work from the downscaled version you already have.`);
    }
    const entry = entries[0];
    let buf: Buffer;
    try {
        buf = await readFile(entry.path);
    } catch {
        return toolFail(`acp_read_original_image: the original for ${ref} was evicted from local storage; it becomes readable again while the image rides the resent history.`);
    }
    const counterMeta = session.metadata.imageRescaleReads;
    const counter = counterMeta && typeof counterMeta === "object"
        ? (counterMeta as { count: number; bytes: number })
        : { count: 0, bytes: 0 };
    counter.count += 1;
    counter.bytes += buf.length;
    session.metadata.imageRescaleReads = counter;
    log("info", `[${session.id}] [image-rescale] acp_read_original_image ${ref}: ${entry.width ?? "?"}x${entry.height ?? "?"}/${formatKb(buf.length)}KB session-cumulative ${counter.count} read(s)/${formatKb(counter.bytes)}KB`);
    // The receipt always names the local spill path: on the loop/injection
    // lanes the bytes also ride an ephemeral carrier message (see the loop's
    // proxyResults handling), but on the plugin lane the string tool protocol
    // carries TEXT only — the host agent opens this file with its own tools.
    const dims = `${entry.width ?? "?"}x${entry.height ?? "?"}`;
    return {
        ...toolOk(`Original image for ${ref} restored (${dims}, ${formatKb(buf.length)}KB${entry.mediaType ? `, ${entry.mediaType}` : ""}). Local copy: ${entry.path}. It is larger than the downscaled copy you saw — use it for fine detail (small text, colors, alignment).\nBillion original image receipt v1 sha256=${createHash("sha256").update(buf).digest("hex")}`),
        image: { base64: buf.toString("base64"), mediaType: entry.mediaType },
    };
}
