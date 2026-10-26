// #3701/#3909: egress byte shedding for the WS lane and the plain/proxy/pi-native HTTP relay
// lane. The compression pipeline makes folding decisions in TOKEN space, but upstreams reject
// in BYTE space — the WS gateway answers close 1009 with zero events (#3701), edge runtimes
// 503 on tens of MiB of base64 / pixel-decode CPU (#3909) — at 30–40% token usage no token gate
// fires while outbound carries >16 MiB of mostly base64 images. This module is the byte-space
// backstop: when the FINAL serialized request exceeds its lane's budget (network.wsOutboundBytes
// on the WS lane, network.httpOutboundBytes on the HTTP relay; managed non-WS transports are
// never shed, #3701 Finding 1), images are
// shed from the OUTBOUND COPY ONLY, in two rungs — (A) archive the oldest non-protected
// images to placeholder notes (originals stay in session storage + the incoming-image
// index, so read_original_image / decompress({imageRef}) still reach them, and the client
// keeps its own history intact), then (B) boundedly downscale whatever remains through the
// jimp maxDim ladder. Deterministic per input+target (oldest-first walk, fixed ladder) so
// repeated resends of the same history produce stable bytes (prefix cache). Kernel state
// is NEVER mutated here — same outbound-copy-only discipline as the #3400 image rescale.

import { parseDataUrl } from "acp-kernel/wire";
import type { Session } from "./session.js";
import type { WireProtocol } from "./util.js";
import { currentFetchTransport, isWsLaneTransport } from "./fetch-transport.js";
import { limitsHttpOutboundBytes, limitsWsOutboundBytes } from "./knobs.js";
import { decodeImageDims } from "./image-tokens.js";
import { READ_ORIGINAL_IMAGE_TOOL_NAME } from "./compress-tool.js";
import { matchesOriginalImageReceipt, refForItemBytes, shedDownscaleImage } from "./image-rescale.js";
import { ResponsesWsUpstreamError } from "./responses-ws.js";

type Part = Record<string, unknown>;

function isObj(v: unknown): v is Part {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Top-level entries whose images are never archived (rung A) — the model may be looking
 *  at them right now. They can still be downscaled (rung B) as a last resort. */
const PROTECTED_TAIL_ENTRIES = 8;
/** Longest-edge ladder for rung B, coarsest first. */
const DOWNSCALE_DIM_LADDER = [1024, 768, 512, 384];
/** Work bound: never queue more than this many images through jimp per request. */
const MAX_SHED_IMAGES = 64;

export interface ShedStats {
    originalBytes: number;
    finalBytes: number;
    archived: number;
    downscaled: number;
    changed: boolean;
}

interface ShedOptions {
    /** Best-effort mNNNNN resolver (session incoming-image index); placeholders quote it. */
    resolveRef?: (mediaType: string, b64: string) => Promise<string | undefined>;
}

interface Occurrence {
    /** Top-level entry index (chronological order). */
    entryIndex: number;
    b64: string;
    mediaType: string;
    protectedTail: boolean;
    /** Set once rung A replaced this occurrence — rung B must never shrink a detached part. */
    archived: boolean;
    applyArchive: (note: string) => void;
    applyShrink: (b64: string) => void;
}

function byteLen(s: string): number {
    return Buffer.byteLength(s);
}

export function formatMiB(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(1);
}

function dataUrl(mediaType: string, b64: string): string {
    return `data:${mediaType};base64,${b64}`;
}

async function shedNote(mediaType: string, b64: string, resolveRef: ShedOptions["resolveRef"]): Promise<string> {
    const mime = mediaType.replace(/^image\//i, "");
    const bits: string[] = [];
    if (mime) bits.push(mime);
    const dims = decodeImageDims(b64);
    if (dims) bits.push(`${dims.w}x${dims.h}`);
    const ref = await resolveRef?.(mediaType, b64);
    if (ref) bits.push(ref);
    return `[image: ${bits.join(" ")} omitted for size limit]`;
}

/** call_id → tool name, so read_original_image outputs stay exempt (archiving them would
 *  recreate the read→archive cycle the #3400 structural guard prevents). */
function callNameMap(protocol: WireProtocol, body: Part): Map<string, string> {
    const map = new Map<string, string>();
    if (protocol === "responses") {
        const input = body.input;
        if (!Array.isArray(input)) return map;
        for (const item of input) {
            if (!isObj(item)) continue;
            if ((item.type === "function_call" || item.type === "custom_tool_call") && typeof item.call_id === "string" && typeof item.name === "string") {
                map.set(item.call_id, item.name);
            }
        }
        return map;
    }
    const messages = body.messages;
    if (!Array.isArray(messages)) return map;
    for (const m of messages) {
        if (!isObj(m)) continue;
        if (protocol === "openai") {
            const calls = m.tool_calls;
            if (Array.isArray(calls)) {
                for (const c of calls) {
                    if (isObj(c) && typeof c.id === "string" && isObj(c.function) && typeof c.function.name === "string") {
                        map.set(c.id, c.function.name);
                    }
                }
            }
        } else {
            const content = m.content;
            if (Array.isArray(content)) {
                for (const b of content) {
                    if (isObj(b) && b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
                        map.set(b.id, b.name);
                    }
                }
            }
        }
    }
    return map;
}

function isExemptOutput(protocol: WireProtocol, item: Part, names: Map<string, string>): boolean {
    const id = protocol === "responses" ? item.call_id : protocol === "openai" ? item.tool_call_id : item.tool_use_id;
    return typeof id === "string" && names.get(id) === READ_ORIGINAL_IMAGE_TOOL_NAME;
}

function collectOccurrences(protocol: WireProtocol, body: Part): Occurrence[] {
    const occ: Occurrence[] = [];
    const addAnthropicImages = (parts: unknown[], entryIndex: number, toolOutput: boolean): void => {
        parts.forEach((part, pos) => {
            if (!isObj(part) || part.type !== "image") return;
            const src = part.source;
            if (!isObj(src) || src.type !== "base64" || typeof src.data !== "string" || src.data.length === 0) return;
            if (toolOutput && matchesOriginalImageReceipt(src.data, parts)) return;
            const mediaType = typeof src.media_type === "string" ? src.media_type : "image/png";
            occ.push({
                entryIndex,
                b64: src.data,
                mediaType,
                protectedTail: false,
                archived: false,
                applyArchive: (note) => { parts[pos] = { type: "text", text: note }; },
                applyShrink: (b64) => { src.data = b64; },
            });
        });
    };
    if (protocol === "google") {
        const contents = body.contents;
        if (!Array.isArray(contents)) return occ;
        contents.forEach((c, entryIndex) => {
            if (!isObj(c) || !Array.isArray(c.parts)) return;
            const parts = c.parts as unknown[];
            parts.forEach((part, pos) => {
                if (!isObj(part)) return;
                const inline = part.inlineData;
                if (!isObj(inline) || typeof inline.data !== "string" || inline.data.length === 0) return;
                if (matchesOriginalImageReceipt(inline.data, parts)) return;
                const mediaType = typeof inline.mimeType === "string" ? inline.mimeType : "image/png";
                occ.push({
                    entryIndex,
                    b64: inline.data,
                    mediaType,
                    protectedTail: false,
                    archived: false,
                    applyArchive: (note) => { parts[pos] = { text: note }; },
                    applyShrink: (b64) => { inline.data = b64; },
                });
            });
        });
        return occ;
    }
    if (protocol === "responses") {
        const input = body.input;
        if (!Array.isArray(input)) return occ;
        const names = callNameMap(protocol, body);
        input.forEach((item, entryIndex) => {
            if (!isObj(item)) return;
            const partsKey = item.type === "message" ? "content" : item.type === "function_call_output" || item.type === "custom_tool_call_output" ? "output" : undefined;
            if (partsKey === undefined || !Array.isArray(item[partsKey])) return;
            if ((item.type === "function_call_output" || item.type === "custom_tool_call_output") && isExemptOutput(protocol, item, names)) return;
            const parts = item[partsKey] as unknown[];
            parts.forEach((part, pos) => {
                if (!isObj(part) || part.type !== "input_image" || typeof part.image_url !== "string") return;
                const d = parseDataUrl(part.image_url);
                if (!d || (partsKey === "output" && matchesOriginalImageReceipt(d.base64, parts))) return;
                occ.push({
                    entryIndex,
                    b64: d.base64,
                    mediaType: d.mediaType,
                    protectedTail: false,
                    archived: false,
                    applyArchive: (note) => { parts[pos] = { type: "input_text", text: note }; },
                    applyShrink: (b64) => { part.image_url = dataUrl(d.mediaType, b64); },
                });
            });
        });
        return occ;
    }
    // openai + anthropic share messages[].content[]
    const messages = body.messages;
    if (!Array.isArray(messages)) return occ;
    const names = callNameMap(protocol, body);
    messages.forEach((m, entryIndex) => {
        if (!isObj(m)) return;
        if (protocol === "openai" && m.role === "tool" && isExemptOutput(protocol, m, names)) return;
        if (protocol === "anthropic" && Array.isArray(m.content) && m.content.some((b) => isObj(b) && b.type === "tool_result" && isExemptOutput(protocol, b, names))) return;
        if (!Array.isArray(m.content)) return;
        const content = m.content as unknown[];
        if (protocol === "anthropic") addAnthropicImages(content, entryIndex, false);
        content.forEach((part, pos) => {
            const p = isObj(part) ? part : undefined;
            if (!p) return;
            if (protocol === "openai") {
                if (p.type !== "image_url") return;
                const iu = p.image_url;
                const url = typeof iu === "string" ? iu : isObj(iu) && typeof iu.url === "string" ? iu.url : undefined;
                if (typeof url !== "string") return;
                const d = parseDataUrl(url);
                if (!d) return;
                occ.push({
                    entryIndex,
                    b64: d.base64,
                    mediaType: d.mediaType,
                    protectedTail: false,
                    archived: false,
                    applyArchive: (note) => { content[pos] = { type: "text", text: note }; },
                    applyShrink: (b64) => { p.image_url = typeof iu === "string" ? dataUrl(d.mediaType, b64) : { ...(iu ?? {}), url: dataUrl(d.mediaType, b64) }; },
                });
            } else if (p.type === "tool_result" && Array.isArray(p.content)) {
                addAnthropicImages(p.content, entryIndex, true);
            }
        });
    });
    return occ;
}

/** Shed images from an over-budget serialized request until it fits targetBytes.
 *  Pure on the STRING (the input is never mutated); returns the original body unchanged
 *  when nothing was sheddable or the body did not parse. */
export async function shedWireImages(
    body: string,
    protocol: WireProtocol,
    targetBytes: number,
    opts: ShedOptions = {},
): Promise<{ body: string; stats: ShedStats }> {
    const originalBytes = byteLen(body);
    const noop: ShedStats = { originalBytes, finalBytes: originalBytes, archived: 0, downscaled: 0, changed: false };
    if (targetBytes <= 0 || originalBytes <= targetBytes) return { body, stats: noop };
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return { body, stats: noop };
    }
    if (!isObj(parsed)) return { body, stats: noop };
    const occurrences = collectOccurrences(protocol, parsed);
    if (occurrences.length === 0) return { body, stats: noop };

    const totalEntries = protocol === "google" ? (Array.isArray(parsed.contents) ? parsed.contents.length : 0)
        : protocol === "responses" ? (Array.isArray(parsed.input) ? parsed.input.length : 0)
            : Array.isArray(parsed.messages) ? parsed.messages.length : 0;
    const protectFrom = Math.max(0, totalEntries - PROTECTED_TAIL_ENTRIES);
    for (const o of occurrences) o.protectedTail = o.entryIndex >= protectFrom;

    let est = originalBytes;
    let archived = 0;
    let downscaled = 0;
    const work = occurrences.slice(0, MAX_SHED_IMAGES);

    // Rung A: archive oldest non-protected images to placeholder notes until under target.
    for (const o of work) {
        if (est <= targetBytes) break;
        if (o.protectedTail) continue;
        const note = await shedNote(o.mediaType, o.b64, opts.resolveRef);
        o.applyArchive(note);
        o.archived = true;
        // the serialized value being removed is the whole data URL, not the bare base64
        est += byteLen(JSON.stringify(note)) - byteLen(dataUrl(o.mediaType, o.b64));
        archived++;
    }

    // Rung B: downscale whatever still rides the wire (protected tail included) through
    // the dim ladder; stop as soon as the estimate fits.
    if (est > targetBytes) {
        outer: for (const dim of DOWNSCALE_DIM_LADDER) {
            for (const o of work) {
                if (est <= targetBytes) break;
                // an archived occurrence's part was already replaced by the note — shrinking
                // it would write into a detached object and double-count savings in est
                if (o.archived) continue;
                const dims = decodeImageDims(o.b64);
                if (dims !== undefined && Math.max(dims.w, dims.h) <= dim) continue;
                const smaller = await shedDownscaleImage(o.mediaType, o.b64, dim);
                if (smaller === null || smaller.length >= o.b64.length) continue;
                o.applyShrink(smaller);
                est += smaller.length - o.b64.length;
                o.b64 = smaller;
                downscaled++;
            }
            if (est <= targetBytes) break outer;
        }
    }

    if (archived === 0 && downscaled === 0) return { body, stats: noop };
    const next = JSON.stringify(parsed);
    return {
        body: next,
        stats: { originalBytes, finalBytes: byteLen(next), archived, downscaled, changed: true },
    };
}

/** #4124: shed images from a serialized request until at most maxImages remain.
 *  Count-space twin of shedWireImages — RUNG A ONLY, because archiving is the only
 *  action that reduces COUNT (rung B downscaling leaves the image count untouched).
 *  Same placeholder/archive machinery, so every original stays reachable via
 *  decompress({imageRef}). Two deliberate differences from shedWireImages:
 *   - the work list is NOT sliced at MAX_SHED_IMAGES — that bound caps jimp CPU,
 *     while archiving is a cheap string swap and a 165→29 convergence needs ~136;
 *   - the protected tail YIELDS to the cap: an upstream count wall is HARD (sending
 *     over it fails the whole request), unlike the WS byte budget which is soft —
 *     once non-tail images are exhausted, tail images are archived too (oldest-first).
 *  Exempt read_original_image occurrences never enter the walk (collectOccurrences
 *  skips them); if exempt images alone exceed the cap the body cannot be brought
 *  under it and the rejection stays visible. Pure on the string; byte-identical
 *  passthrough when the count is already within maxImages or nothing was sheddable. */
export async function shedWireImagesToCount(
    body: string,
    protocol: WireProtocol,
    maxImages: number,
    opts: ShedOptions = {},
): Promise<{ body: string; stats: ShedStats }> {
    const originalBytes = byteLen(body);
    const noop: ShedStats = { originalBytes, finalBytes: originalBytes, archived: 0, downscaled: 0, changed: false };
    if (!Number.isInteger(maxImages) || maxImages < 0) return { body, stats: noop };
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return { body, stats: noop };
    }
    if (!isObj(parsed)) return { body, stats: noop };
    const occurrences = collectOccurrences(protocol, parsed);
    if (occurrences.length <= maxImages) return { body, stats: noop };

    const totalEntries = protocol === "google" ? (Array.isArray(parsed.contents) ? parsed.contents.length : 0)
        : protocol === "responses" ? (Array.isArray(parsed.input) ? parsed.input.length : 0)
            : Array.isArray(parsed.messages) ? parsed.messages.length : 0;
    const protectFrom = Math.max(0, totalEntries - PROTECTED_TAIL_ENTRIES);
    for (const o of occurrences) o.protectedTail = o.entryIndex >= protectFrom;

    let remaining = occurrences.length;
    let archived = 0;
    for (const allowTail of [false, true]) {
        if (remaining <= maxImages) break;
        for (const o of occurrences) {
            if (remaining <= maxImages) break;
            if (o.archived) continue;
            if (!allowTail && o.protectedTail) continue;
            const note = await shedNote(o.mediaType, o.b64, opts.resolveRef);
            o.applyArchive(note);
            o.archived = true;
            remaining--;
            archived++;
        }
    }

    if (archived === 0) return { body, stats: noop };
    const next = JSON.stringify(parsed);
    return { body: next, stats: { originalBytes, finalBytes: byteLen(next), archived, downscaled: 0, changed: true } };
}

interface ShedContext {
    sessionId?: string;
    session?: Session;
    log?: (level: string, message: string) => void;
    phase?: string;
}

/** Pre-send egress byte-budget gate — one shared two-rung image shed, keyed per lane off the
 *  transport actually riding the request (#3701 WS lane, #3909 HTTP relay lane):
 *   - WS lane: transport tagged markWsLaneTransport (responses-ws.ts) vs network.wsOutboundBytes —
 *     the gateway answers an oversized frame with close 1009 and zero events.
 *   - plain/proxy/pi-native HTTP relay: NO transport installed (global fetch) vs
 *     network.httpOutboundBytes — an image-dense session forwards tens of MiB of base64 that
 *     upstreams reject on raw bytes / pixel-decode CPU (Cloudflare Worker 503) while token-space
 *     folding stays below its trigger, so every retry resends the same pixels forever.
 *  A MANAGED-but-not-WS transport (inline-engine / dsh-inline) is NEVER shed here (#3701 Finding 1):
 *  it delivers large bodies fine (16 MiB observed). On a shed, records session.metadata.*ByteShed
 *  and logs the exact before→after bytes. */
export async function shedEgressIfOverBudget(
    body: string,
    protocol: WireProtocol,
    ctx: ShedContext,
): Promise<{ body: string; stats: ShedStats }> {
    const originalBytes = byteLen(body);
    const t = currentFetchTransport();
    let budget: number;
    let lane: "ws" | "http";
    if (isWsLaneTransport(t)) {
        budget = limitsWsOutboundBytes();
        lane = "ws";
    } else if (t === undefined) {
        budget = limitsHttpOutboundBytes();
        lane = "http";
    } else {
        // managed-but-not-WS transport (inline-engine / dsh-inline): pass through untouched
        // (#3701 Finding 1 — large bodies deliver fine over it; never shed).
        return { body, stats: { originalBytes, finalBytes: originalBytes, archived: 0, downscaled: 0, changed: false } };
    }
    if (budget <= 0 || originalBytes <= budget) {
        return { body, stats: { originalBytes, finalBytes: originalBytes, archived: 0, downscaled: 0, changed: false } };
    }
    const tag = `${lane}-byte-shed`;
    const metaKey = lane === "ws" ? "wsByteShed" : "httpByteShed";
    const { body: next, stats } = await shedWireImages(body, protocol, budget, {
        resolveRef: ctx.session ? (mt, b64) => refForItemBytes(ctx.session!, mt, b64) : undefined,
    });
    if (!stats.changed) {
        ctx.log?.("warn", `[${ctx.sessionId ?? "?"}] [${tag}] ${ctx.phase ?? "send"}: outbound ${formatMiB(originalBytes)} MiB over budget ${formatMiB(budget)} MiB but no sheddable images outside the protected tail — sending as-is`);
        return { body, stats };
    }
    if (ctx.session) {
        ctx.session.metadata[metaKey] = {
            at: Date.now(),
            phase: ctx.phase ?? "send",
            fromBytes: stats.originalBytes,
            toBytes: stats.finalBytes,
            archived: stats.archived,
            downscaled: stats.downscaled,
        };
    }
    if (stats.finalBytes <= budget) {
        ctx.log?.("info", `[${ctx.sessionId ?? "?"}] [${tag}] ${ctx.phase ?? "send"}: ${formatMiB(stats.originalBytes)} -> ${formatMiB(stats.finalBytes)} MiB (archived=${stats.archived} downscaled=${stats.downscaled} budget=${formatMiB(budget)} MiB) — originals stay in session storage`);
    } else {
        ctx.log?.("warn", `[${ctx.sessionId ?? "?"}] [${tag}] ${ctx.phase ?? "send"}: shed to ${formatMiB(stats.finalBytes)} MiB but still over budget ${formatMiB(budget)} MiB (protected recent messages hold the rest) — sending anyway; hard cap network.outboundBodyBytes unchanged`);
    }
    return { body: next, stats };
}

/** Walk the cause chain for a typed WS oversize rejection: close 1009 with ZERO events
 *  received is a size verdict on our frame — NOT endpoint death and NOT a stream drop.
 *  Any other close code / any received events / close_code none are deliberately not
 *  matched (they must keep their existing circuit/alert treatment). */
export function extractWsOversizeError(error: unknown): ResponsesWsUpstreamError | undefined {
    let cur: unknown = error;
    for (let hop = 0; cur !== null && typeof cur === "object" && hop < 4; hop++) {
        if (cur instanceof ResponsesWsUpstreamError && cur.closeCode === 1009 && cur.receivedEvents === 0) {
            return cur;
        }
        cur = (cur as { cause?: unknown }).cause;
    }
    return undefined;
}
