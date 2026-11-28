// #7693: the core-space twin of the wire-level image shed (egress-shed.ts).
// The wire shed runs in the relay on the SERIALIZED body — an outbound copy
// that is rebuilt from scratch every turn. Under the egress plane
// (discussions/7398, docs/egress-plane.zh-CN.md) that is the wrong plane for
// an armed session: the op-log flow (kernel input + served wire + recorded
// bytes) still carries the FULL images while the wire copy carries
// placeholder notes, so every turn (1) the relay rewrites mid-context bytes
// (new cache seam), (2) the placeholder's image ref — resolved from the
// per-request resend bytes (session.incomingImageIndex) — drifts once the
// kernel folds the image-dense history (the ref points at a folded id), and
// (3) the kernel doom-math meters tokens the wire never sends, triggering
// compression over and over for a session that "cannot free up space"
// (issue #7693: 折叠空间/释放量越来越小).
//
// Fix: archive the image IN the recorded flow, where it belongs. Archiving a
// flow row rewrites that row's bytes under its SAME msgid — the existing
// `U` op of the diff engine carries it (zero new storage machinery), the row
// id (the mNNNNN ref) survives, the bytes are deterministic and stable
// across turns (no per-turn rewrite, no seam churn), and the kernel's token
// space finally matches what the wire carries. The originals stay
// reachable: the client re-sends its full context every turn (#2092
// contract) so the per-request incoming index still maps the bytes, and
// decompress({imageRef}) / acp_read_original_image work as before.
//
// Scope (v1): canonical split image-part rows — `imagePart === true` or a
// non-empty `imageBase64` sidecar (every codec sets the flag at parse
// time, #3642; rebuild keys off the flag). Mixed rows (rawOpenaiContentParts
// multi-image user messages, non-split legacy sidecars) are left alone:
// the relay's wire shed remains the backstop for those (and for the whole
// egress-off world, which this module never touches).
//
// Selection mirrors the wire shed's rung A: oldest first, a protected tail
// (the newest N entries — this turn's fresh images are always there) yields
// only for a hard COUNT wall (the upstream image-count cap, learned in the
// relay's 400 path, #4124). Exemptions mirror the wire shed:
// read_original_image outputs and receipt-verified originals must survive
// (archiving a restored original would break the receipt round-trip).
import { decodeImageDims } from "./image-tokens.js";
import { READ_ORIGINAL_IMAGE_TOOL_NAME } from "./compress-tool.js";
import { matchesOriginalImageReceipt } from "./image-rescale.js";

/** Minimal structural shape of a recordable row: canonical BiliMessage (all
 * lanes) or a lane's minimal record-source shape. The shed only READS the
 * optional sidecar fields below; everything else rides the spread clone
 * verbatim. The shed is generic over it, so callers keep their own row
 * type (BiliMessage stays BiliMessage). */
interface SheddableRow {
    id: string;
    role: string;
    contentType?: unknown;
    text?: unknown;
    imagePart?: true;
    imageBase64?: string;
    imageMediaType?: string;
    toolName?: string;
    toolCallId?: string;
}

/** Shed targets, resolved per turn by the caller (see
 * recordImageShedTargets in server/egress-lane-io.ts). Both optional: a
 * count target alone (learned cap) or a byte target alone (outbound budget)
 * each drive the shed; neither present = no shed. */
export interface CoreImageShedTargets {
    /** Keep at most this many image rows (hard wall — the upstream image
     * count cap minus one, the same convergence the relay applies
     * pre-send). */
    maxImages?: number;
    /** Keep the recorded conversation (row JSON bytes + system text + a
     * fixed wrapper allowance for the protocol scaffolding this estimate
     * cannot see) at or under this many bytes. */
    maxBytes?: number;
}

export interface CoreImageShedResult<T> {
    /** The conversation with archived rows rewritten in place (other rows
     * are the SAME object references — only rewritten rows are new
     * objects). Unchanged input → a new array of the same references. */
    rows: T[];
    archived: number;
    changed: boolean;
}

/** Newest-N rows the count wall may not archive in its first pass (the
 * current turn's fresh images ride at the tail). Same constant the wire
 * shed protects. */
const PROTECTED_TAIL_ENTRIES = 8;

/** Allowance for wire scaffolding the row-JSON estimate cannot see
 * (protocol wrapper, tool definitions, system blocks not in the row set).
 * Conservative in the safe direction: over-archiving a few old images is
 * harmless (originals stay reachable), under-archiving just means the relay
 * backstop fires once more. */
const WRAPPER_ALLOWANCE_BYTES = 512 * 1024;

/** The placeholder note an archived row's text becomes. The ref is the row's
 * OWN kernel id (the mNNNNN) — stable across folds, unlike the wire shed's
 * ref resolved from per-request bytes. */
export function coreImageShedNote(mediaType: string | undefined, b64: string | undefined, ref: string): string {
    const mime = mediaType ? mediaType.replace(/^image\//i, "") : "";
    const bits: string[] = [];
    if (mime) bits.push(mime);
    if (b64) {
        const dims = decodeImageDims(b64);
        if (dims) bits.push(`${dims.w}x${dims.h}`);
    }
    if (ref) bits.push(ref);
    return `[image: ${bits.join(" ")} omitted for size limit]`;
}

/** Matches a placeholder note produced by coreImageShedNote (the probe uses
 * this to exempt the by-design client-vs-server divergence: the client
 * still holds the original image row, the flow holds the note). */
export const CORE_IMAGE_SHED_NOTE_RE = /^\[image: [^\]\n]* omitted for size limit\]$/;

interface Occurrence<T> {
    index: number;
    m: T;
    b64: string | undefined;
    mediaType: string | undefined;
    exempt: boolean;
    archived: boolean;
}

function textOf(m: SheddableRow): string {
    return typeof m.text === "string" ? m.text : "";
}

function isImageRow(m: SheddableRow): boolean {
    return m.imagePart === true || (typeof m.imageBase64 === "string" && m.imageBase64.length > 0);
}

function isExemptRow(rows: readonly SheddableRow[], index: number, m: SheddableRow): boolean {
    // read_original_image output (its own row, or the row following the
    // tool call that issued it) — archiving a restored original would
    // break the receipt round-trip.
    if (m.toolName === READ_ORIGINAL_IMAGE_TOOL_NAME) return true;
    const prev = index > 0 ? rows[index - 1] : undefined;
    if (prev && m.toolCallId !== undefined && prev.toolName === READ_ORIGINAL_IMAGE_TOOL_NAME) return true;
    // Receipt-verified original: a "Billion original image receipt v1"
    // line adjacent to the image hashes this exact b64.
    if (typeof m.imageBase64 === "string" && m.imageBase64.length > 0) {
        const parts: unknown[] = [];
        for (let k = index - 2; k <= index + 2; k++) {
            if (k < 0 || k >= rows.length) continue;
            const t = textOf(rows[k]);
            if (t) parts.push({ text: t });
        }
        if (matchesOriginalImageReceipt(m.imageBase64, parts)) return true;
    }
    return false;
}

function rewriteRow<T extends SheddableRow>(m: T, ref: string): T {
    const clone: T = { ...m };
    const raw = clone as Record<string, unknown>;
    delete raw.imageBase64;
    delete raw.imageMediaType;
    delete raw.imagePart;
    delete raw.rawOpenaiContent;
    delete raw.rawOpenaiContentParts;
    delete raw.rawAnthropicBlock;
    delete raw.rawResponsesItem;
    delete raw.rawGoogleParts;
    clone.text = coreImageShedNote(m.imageMediaType, typeof m.imageBase64 === "string" ? m.imageBase64 : undefined, ref);
    // A split image row IS a text row content-wise (contentType "text");
    // the placeholder keeps the row foldable — a plain text note now.
    clone.contentType = "text";
    return clone;
}

function byteLen(s: string): number {
    return Buffer.byteLength(s);
}

/** Archive core-space images over the targets (pure; never mutates the
 * input — archived rows are replaced by placeholder clones). Deterministic
 * over (rows, targets): the same rows always yield the same output, which
 * is what makes the recorded bytes stable across turns. */
export function shedCoreImages<T extends SheddableRow>(
    conversation: readonly T[],
    targets: CoreImageShedTargets | undefined,
    systemTextBytes = 0,
): CoreImageShedResult<T> {
    if (!targets || (targets.maxImages === undefined && targets.maxBytes === undefined)) {
        return { rows: [...conversation], archived: 0, changed: false };
    }
    const occ: Occurrence<T>[] = [];
    conversation.forEach((m, index) => {
        if (!isImageRow(m)) return;
        occ.push({ index, m, b64: m.imageBase64, mediaType: m.imageMediaType, exempt: isExemptRow(conversation, index, m), archived: false });
    });
    if (occ.length === 0) return { rows: [...conversation], archived: 0, changed: false };

    const rows = [...conversation];
    const protectFrom = Math.max(0, conversation.length - PROTECTED_TAIL_ENTRIES);
    const imageCount = () => occ.filter((o) => !o.archived).length;

    // Count wall (hard): two passes, the protected tail yields in the
    // second (mirrors shedWireImagesToCount — the upstream rejects the
    // body either way, so the tail cannot refuse forever).
    if (targets.maxImages !== undefined) {
        for (const pass of [0, 1]) {
            for (const o of occ) {
                if (imageCount() <= targets.maxImages) break;
                if (o.exempt || o.archived) continue;
                if (pass === 0 && o.index >= protectFrom) continue;
                rows[o.index] = rewriteRow(o.m, o.m.id);
                o.archived = true;
            }
            if (imageCount() <= targets.maxImages) break;
        }
    }

    // Byte budget (rung-A only, tail protected — the relay backstop owns
    // rung B / the tail, exactly like the wire shed's division of labor).
    if (targets.maxBytes !== undefined && targets.maxBytes > 0) {
        let est = systemTextBytes + WRAPPER_ALLOWANCE_BYTES;
        for (const m of rows) est += byteLen(JSON.stringify(m));
        if (est > targets.maxBytes) {
            for (const o of occ) {
                if (est <= targets.maxBytes) break;
                if (o.exempt || o.archived || o.index >= protectFrom) continue;
                est -= byteLen(JSON.stringify(o.m));
                rows[o.index] = rewriteRow(o.m, o.m.id);
                o.archived = true;
            }
        }
    }

    const archived = occ.filter((o) => o.archived).length;
    return { rows, archived, changed: archived > 0 };
}
