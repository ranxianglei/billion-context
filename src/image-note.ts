// #781: images ride the wire in BiliMessage sidecars (rawAnthropicBlock /
// rawOpenaiContent(Parts) / rawResponsesItem + imageBase64/imageMediaType),
// invisible to CoreMessage.text — so preflight's renderRange dropped them from
// summary input: openai image-only messages had empty text and were skipped
// entirely, responses dropped image-only items at toCore time, and anthropic
// left only the codec's bare "[image]" literal (no media type, no size). This
// module emits one explicit placeholder per carried image so tier-1 summaries
// record that the folded range contained an image instead of losing it
// silently. Placeholder-only by design: sending real pixels to the
// summarization model costs billed image tokens (#488/#496 territory) and
// fails outright when the configured compress model has no vision support.

import type { CoreMessage } from "acp-kernel";
import { parseDataUrl, type BiliMessage } from "acp-kernel/wire";
import { decodeImageDims } from "./image-tokens.js";
import { responsesToolImageParts } from "./responses-tool-output.js";

/** The codec's own placeholder for an anthropic image block (wire/index.js).
 *  renderRange replaces exactly this string with the richer note below. */
export const IMAGE_PLACEHOLDER = "[image]";

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

interface ImageRef {
    mediaType?: string;
    b64?: string;
    // #3398: non-pixel opaque payload bili forwards verbatim but cannot spill
    // to disk (unknown shape — no known field holds the bytes). The placeholder
    // records type + size so the fold does not lose it silently; there is no
    // decompress({ imageRef }) restore for these.
    label?: string;
}

function refFromDataUrl(url: unknown): ImageRef | undefined {
    if (typeof url !== "string") return undefined;
    const d = parseDataUrl(url);
    return d ? { mediaType: d.mediaType, b64: d.base64 } : undefined;
}

function opaqueLabel(part: Record<string, unknown>): string {
    const t = typeof part.type === "string" ? part.type : "media";
    const kb = Math.max(1, Math.round(JSON.stringify(part).length / 1024));
    return `${t} ~${kb}KB`;
}

/** The images this core message carries, in wire order. Empty for plain-text
 *  messages (the common case — this is called per message per chunk). */
export function messageImages(m: CoreMessage): ImageRef[] {
    const mm = m as BiliMessage;
    // Anthropic: each image block becomes its own core message; the same
    // sidecar field also carries structured tool_results, so gate on type.
    const ab = mm.rawAnthropicBlock;
    if (isObj(ab) && ab.type === "image") {
        const s = ab.source;
        const mediaType = isObj(s) && typeof s.media_type === "string" ? s.media_type : undefined;
        if (isObj(s) && s.type === "base64" && typeof s.data === "string") {
            return [{ mediaType, b64: s.data }];
        }
        if (isObj(s) && s.type === "url") {
            return [refFromDataUrl(s.url) ?? { mediaType }];
        }
        return [{ mediaType }];
    }
    // #3398: tool_result blocks with non-text nested blocks ride the same
    // sidecar whole; each nested block gets its own placeholder so a folded
    // range does not lose them silently.
    if (isObj(ab) && ab.type === "tool_result" && Array.isArray(ab.content)) {
        const refs: ImageRef[] = [];
        for (const c of ab.content) {
            if (!isObj(c) || c.type === "text") continue;
            const s = c.source;
            if (isObj(s) && s.type === "base64" && typeof s.data === "string") {
                refs.push({ mediaType: isObj(s) && typeof s.media_type === "string" ? s.media_type : undefined, b64: s.data });
            } else if (isObj(s) && s.type === "url") {
                refs.push(refFromDataUrl(s.url) ?? {});
            } else {
                refs.push({ label: opaqueLabel(c) });
            }
        }
        if (refs.length > 0) return refs;
    }
    // Responses: the original item keeps every input_image part (the singular
    // imageBase64 sidecar covers only the first), so walk it when present.
    const ri = mm.rawResponsesItem;
    const responseParts = isObj(ri) && Array.isArray(ri.content) ? ri.content : responsesToolImageParts(ri);
    if (responseParts) {
        const refs: ImageRef[] = [];
        for (const part of responseParts) {
            if (!isObj(part) || part.type !== "input_image") continue;
            refs.push(refFromDataUrl(part.image_url) ?? {});
        }
        if (refs.length > 0) return refs;
    }
    // OpenAI chat: a single data-URL image lands in imageBase64 (+media type),
    // multi-image messages in rawOpenaiContentParts. rawOpenaiContent can also
    // be a developer-role message object — gate on the part shape. Checked
    // after responses fields because they never coexist on one message.
    if (typeof mm.imageBase64 === "string") {
        return [{ mediaType: mm.imageMediaType, b64: mm.imageBase64 }];
    }
    if (Array.isArray(mm.rawOpenaiContentParts)) {
        const refs: ImageRef[] = [];
        for (const p of mm.rawOpenaiContentParts) {
            if (!isObj(p)) continue;
            if (p.type === "image_url") {
                refs.push(refFromDataUrl(isObj(p.image_url) ? p.image_url.url : undefined) ?? {});
                continue;
            }
            // #3398: custom-shape media parts (e.g. {type:"image",attachment:{…}})
            // ride this sidecar verbatim too — record them as labelled media so
            // the fold does not lose them silently.
            refs.push({ label: opaqueLabel(p) });
        }
        if (refs.length > 0) return refs;
    }
    if (isObj(mm.rawOpenaiContent) && mm.rawOpenaiContent.type === "image_url") {
        return [refFromDataUrl(isObj(mm.rawOpenaiContent.image_url) ? mm.rawOpenaiContent.image_url.url : undefined) ?? {}];
    }
    return [];
}

/** One placeholder per carried image: `[image: png 1024x768]`, degrading to
 *  `[image: png]` / `[image]` as detail becomes unavailable. Dimensions come
 *  from decodeImageDims (container-header scan only — no full decode). */
export function imagePlaceholders(m: CoreMessage): string[] {
    return messageImages(m).map((ref) => {
        // #3398: opaque payloads have no pixels to describe — a distinct
        // `[media: …]` marker so readers don't mistake them for restorable images.
        if (ref.label && !ref.b64) return `[media: ${ref.label}]`;
        let note = "";
        if (ref.mediaType) note += ref.mediaType.includes("/") ? ref.mediaType.split("/").pop()! : ref.mediaType;
        if (ref.b64) {
            const dims = decodeImageDims(ref.b64);
            if (dims) note += `${note ? " " : ""}${dims.w}x${dims.h}`;
        }
        return note ? `[image: ${note}]` : IMAGE_PLACEHOLDER;
    });
}

/** #1995: summary-side placeholders with the message's mNNNNN ref appended
 *  (`[image: png 1024x768 · m00042]`). The fold's summary is what SURVIVES —
 *  once the range is compressed the live wire no longer carries these images,
 *  so recording the ref in the summary text is what tells a later turn that
 *  `decompress({ imageRef: "m00042" })` can pull the pixels back (the
 *  #2022 restore channel indexes by exactly this ref). `ref` undefined →
 *  plain placeholders (callers without a ref mapping degrade gracefully). */
export function imagePlaceholdersForSummary(m: CoreMessage, ref: string | undefined): string[] {
    const notes = imagePlaceholders(m);
    if (ref === undefined) return notes;
    return notes.map((n) => `${n.slice(0, -1)} · ${ref}]`);
}
