// #1995/#2607: recovery channel for folded images. Default folding archives
// media off the wire (#2640) and decompress is text-only, so without this
// module the model could never see folded-away pixels again. The client
// re-sends full raw history every turn, so the original bytes are always
// present in the incoming request; this module indexes them by
// kernel-assigned mNNNNN ref (via each message's stable id) so
// decompress({ imageRef }) can pull a specific image back. Delivery is
// file-first (a host-readable path the model opens with its read tool) — uniform
// across all four wires, no per-protocol inline-image rendering required.
// (The former `compress.stripImages` sliding-window strip — and its
// fold-anchored anthropic cutoff — was removed: it broke the prompt cache
// every turn on three of four wires and duplicated what default folding now
// does cache-safely.)
//
// Scope note: this only recovers images bili itself can see in the inbound
// request. A plugin-mode agent that folded an image away in its OWN local store
// sends no such bytes to the proxy, so those belong to the agent's in-process
// recovery (cf. billion-context-pi#594), not here.

import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
    anthropicToCore,
    googleToCore,
    openaiToCore,
    parseDataUrl,
    responsesToCore,
    type AnthropicRequestBody,
    type BiliMessage,
    type GoogleRequestBody,
    type OpenAIRequestBody,
    type ResponsesRequestBody,
} from "acp-kernel/wire";
import type { CompressionState, CoreMessage } from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import { stateDir } from "./paths.js";
import { decodeImageDims } from "./image-tokens.js";
import type { WireProtocol } from "./util.js";

/** One recoverable image: base64 payload plus enough metadata to name the file
 *  and describe it. `bytes` is the DECODED length (base64 length × 3/4), not the
 *  b64 string length. */
export interface RestorableImage {
    mediaType: string;
    b64: string;
    bytes: number;
}

/** A spilled image as retained in the session index: metadata plus the on-disk
 *  path, but NO base64 — the bytes live in the file, so a long image-heavy
 *  session pins only O(refs) of metadata in memory instead of every pixel
 *  (unbounded-residency finding from the #1995 review). */
export interface IndexedImage {
    mediaType: string;
    bytes: number;
    width?: number;
    height?: number;
    path: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

function dataUrlRef(url: unknown): { mediaType?: string; b64?: string } | undefined {
    if (typeof url !== "string") return undefined;
    const d = parseDataUrl(url);
    return d ? { mediaType: d.mediaType, b64: d.base64 } : undefined;
}

function b64Bytes(b64: string): number {
    return Math.floor((Buffer.byteLength(b64, "base64") || 0));
}

/** The base64 images this core message carries, in wire order, across all four
 *  protocols (anthropic / openai / responses / google) — INCLUDING images nested
 *  in tool results (anthropic tool_result.content, Responses function_call_output
 *  .output, Gemini functionResponse.parts), which the strip side also removes:
 *  every stripped shape must have a recovery path or it is lost forever (#1995).
 *  URL/fileData-sourced images whose bytes we cannot obtain yield no entry —
 *  only carryable base64 payloads are indexed. Returns [] for plain-text
 *  messages (the common case). */
export function messageImageBytes(m: CoreMessage): RestorableImage[] {
    const mm = m as BiliMessage;
    const out: RestorableImage[] = [];
    // Anthropic: each image block becomes its own core message; the same sidecar
    // field also carries structured tool_results, so gate on type === "image".
    const ab = mm.rawAnthropicBlock;
    if (isObj(ab) && ab.type === "image") {
        const s = ab.source;
        const mediaType = isObj(s) && typeof s.media_type === "string" ? s.media_type : "image/png";
        if (isObj(s)) {
            if (s.type === "base64" && typeof s.data === "string") {
                out.push({ mediaType, b64: s.data, bytes: b64Bytes(s.data) });
            } else if (s.type === "url") {
                const r = dataUrlRef(s.url);
                if (r?.b64) out.push({ mediaType: r.mediaType ?? mediaType, b64: r.b64, bytes: b64Bytes(r.b64) });
            }
        }
        return out;
    }
    // Anthropic tool_results carry images NESTED in their content array — the
    // strip side removes them (stripNestedImages), so they must be indexed here
    // too or that whole class would be stripped-but-unrecoverable (#1995).
    if (isObj(ab) && ab.type === "tool_result" && Array.isArray(ab.content)) {
        for (const c of ab.content) {
            if (!isObj(c) || c.type !== "image") continue;
            const s = c.source;
            const mediaType = isObj(s) && typeof s.media_type === "string" ? s.media_type : "image/png";
            if (!isObj(s)) continue;
            if (s.type === "base64" && typeof s.data === "string") {
                out.push({ mediaType, b64: s.data, bytes: b64Bytes(s.data) });
            } else if (s.type === "url") {
                const r = dataUrlRef(s.url);
                if (r?.b64) out.push({ mediaType: r.mediaType ?? mediaType, b64: r.b64, bytes: b64Bytes(r.b64) });
            }
        }
        return out;
    }
    // Responses: the original item keeps every input_image part (the singular
    // imageBase64 sidecar covers only the first), so walk the item's content.
    // Tool outputs (function_call_output / custom_tool_call_output) keep their
    // parts in `.output` instead of `.content` — the strip side reads them from
    // there, so the index must too (#1995 nested-tool-image parity).
    const ri = mm.rawResponsesItem;
    if (isObj(ri)) {
        const arr = ri.type === "function_call_output" || ri.type === "custom_tool_call_output"
            ? (Array.isArray(ri.output) ? ri.output : undefined)
            : (Array.isArray(ri.content) ? ri.content : undefined);
        if (arr) {
            for (const part of arr) {
                if (!isObj(part) || part.type !== "input_image") continue;
                const u = isObj(part.image_url) ? part.image_url.url : part.image_url;
                const r = dataUrlRef(u);
                if (r?.b64) out.push({ mediaType: r.mediaType ?? "image/png", b64: r.b64, bytes: b64Bytes(r.b64) });
            }
            if (out.length > 0) return out;
        }
    }
    // Multi-part sources come FIRST: the shared singular imageBase64 sidecar is
    // set by every protocol for a single data-URL image, so checking it earlier
    // would shadow the multi-part fields and drop every image after the first.
    // Google: inlineData parts (raw base64 in .data, mime in .mimeType), plus
    // images NESTED in functionResponse.parts — the strip side removes those
    // too (image-mime inlineData/fileData there). fileData entries are remote
    // references with no carried bytes, so only inlineData is indexable.
    if (Array.isArray(mm.rawGoogleParts)) {
        for (const part of mm.rawGoogleParts as unknown[]) {
            if (!isObj(part)) continue;
            const inline = part.inlineData;
            if (isObj(inline) && typeof inline.data === "string") {
                const mediaType = typeof inline.mimeType === "string" ? inline.mimeType : "image/png";
                out.push({ mediaType, b64: inline.data, bytes: b64Bytes(inline.data) });
            }
            const fr = part.functionResponse;
            if (isObj(fr) && Array.isArray(fr.parts)) {
                // Review ⑤: mirror the strip side's Gemini-3 $ref guard (from the
                // removed kernel strip-images.ts; kept for parity) — when
                // `response` points at a part via
                // {"$ref": displayName} the bytes are not inline,
                // so there is nothing to restore: skip indexing (harmless waste,
                // not corruption).
                const refGuarded = JSON.stringify(fr.response ?? null).includes('"$ref"');
                if (!refGuarded) {
                    for (const np of fr.parts) {
                        if (!isObj(np)) continue;
                        const ni = np.inlineData;
                        if (isObj(ni) && typeof ni.data === "string" && typeof ni.mimeType === "string" && ni.mimeType.startsWith("image/")) {
                            out.push({ mediaType: ni.mimeType, b64: ni.data, bytes: b64Bytes(ni.data) });
                        }
                    }
                }
            }
        }
        if (out.length > 0) return out;
    }
    // OpenAI chat: multi-image → rawOpenaiContentParts; a lone image_url may also
    // sit in rawOpenaiContent.
    if (Array.isArray(mm.rawOpenaiContentParts)) {
        for (const p of mm.rawOpenaiContentParts) {
            if (!isObj(p) || p.type !== "image_url") continue;
            const u = isObj(p.image_url) ? p.image_url.url : undefined;
            const r = dataUrlRef(u);
            if (r?.b64) out.push({ mediaType: r.mediaType ?? "image/png", b64: r.b64, bytes: b64Bytes(r.b64) });
        }
        if (out.length > 0) return out;
    }
    if (isObj(mm.rawOpenaiContent) && mm.rawOpenaiContent.type === "image_url") {
        const u = isObj(mm.rawOpenaiContent.image_url) ? mm.rawOpenaiContent.image_url.url : undefined;
        const r = dataUrlRef(u);
        if (r?.b64) out.push({ mediaType: r.mediaType ?? "image/png", b64: r.b64, bytes: b64Bytes(r.b64) });
        if (out.length > 0) return out;
    }
    // Singular fallback: the shared imageBase64 sidecar (one data-URL image).
    if (typeof mm.imageBase64 === "string") {
        out.push({ mediaType: typeof mm.imageMediaType === "string" ? mm.imageMediaType : "image/png", b64: mm.imageBase64, bytes: b64Bytes(mm.imageBase64) });
    }
    return out;
}

/** Extract the core-message array from a protocol toCore() result, tolerating
 *  both `{ msgs }` object returns and bare arrays. Returns undefined when the
 *  shape is unrecognized (caller degrades to an empty index). */
function coreMsgsOf(result: unknown): CoreMessage[] | undefined {
    if (Array.isArray(result)) return result as CoreMessage[];
    if (isObj(result) && Array.isArray((result as { msgs?: unknown }).msgs)) {
        return (result as { msgs: CoreMessage[] }).msgs;
    }
    return undefined;
}

// #2824: raw-text pre-check — can this body carry indexable image bytes at
// ALL? buildIncomingImageIndex pays a full wire→core conversion of the whole
// history (twice per request with the post-prepare refresh) only to discover
// there are no images; on a 32MiB no-image session that was ~170ms of the
// 0.1.193 local-time regression per turn. OVER-APPROXIMATE BY DESIGN: a false
// positive costs one wasted conversion, a false negative would silently drop
// image recovery. The markers mirror EVERY shape messageImageBytes indexes:
//   - openai/responses (+anthropic source.url): data-URL strings (the exact
//     domain parseDataUrl accepts — any media type, `;base64` optional);
//   - anthropic source.type "base64": raw base64 payload, NO data: prefix;
//   - google inlineData parts (top-level AND nested in functionResponse):
//     raw base64 .data field, NO data: prefix.
// Keyed markers tolerate JSON whitespace ("type": "base64" vs "type":"base64").
export function bodyMightCarryImages(bodyText: string, protocol: WireProtocol): boolean {
    switch (protocol) {
        case "anthropic":
            return /"data:[^;,"]+(?:;base64)?,/i.test(bodyText) || /"type"\s*:\s*"base64"/.test(bodyText);
        case "google":
            return /"inlineData"\s*:/.test(bodyText);
        default:
            return /"data:[^;,"]+(?:;base64)?,/i.test(bodyText);
    }
}

/** Warn-once dedupe for inbound-index conversion failures: the catch must
 * stay fail-open (empty index, request unaffected) but never SILENT — #2824
 * class. Keyed by protocol + error signature; bounded by distinct error
 * shapes, which is a handful per process. */
const conversionWarned = new Set<string>();

/** Parse the INBOUND wire body into core messages and index every carried image
 *  by its mNNNNN ref. A message is indexed only when it is already known to the
 *  session (`state.messageRefs.byRaw[message.id]` resolves) — brand-new tail
 *  messages have no ref yet and sit inside the protected tail anyway, so
 *  folding never archives them. Returns an empty map when nothing is
 *  recoverable (no images, no refs, or an unparseable body). */
export function buildIncomingImageIndex(
    parsed: unknown,
    protocol: WireProtocol,
    state: CompressionState,
    sessionId: string,
): Map<string, IndexedImage[]> {
    const index = new Map<string, IndexedImage[]>();
    const byRaw = state?.messageRefs?.byRaw;
    if (!byRaw) return index;
    let result: unknown;
    try {
        switch (protocol) {
            case "anthropic": result = anthropicToCore(parsed as AnthropicRequestBody); break;
            case "openai": result = openaiToCore(parsed as OpenAIRequestBody); break;
            case "google": result = googleToCore(parsed as GoogleRequestBody); break;
            case "responses": result = responsesToCore(parsed as ResponsesRequestBody); break;
        }
    } catch (e) {
        // Fail-open by design (an unparseable body must not kill the request),
        // but visible: a converter throw here silently disables image recovery
        // for every session carrying that shape — exactly how the #3642
        // single-object-content TypeError hid (#2824). One warn per signature
        // per process so a broken shape logs once, not twice per turn.
        const sig = `${protocol}:${String((e as Error)?.message ?? e).slice(0, 120)}`;
        if (!conversionWarned.has(sig)) {
            conversionWarned.add(sig);
            loggerLog("warn", `[image-restore] inbound index conversion failed — images in affected sessions are NOT recoverable until this wire shape is handled (${sig}; #2824 class — please report the body shape)`);
        }
        return index;
    }
    const msgs = coreMsgsOf(result);
    if (!msgs) return index;
    for (const m of msgs) {
        const ref = m.id ? byRaw[m.id] : undefined;
        if (!ref) continue;
        const imgs = messageImageBytes(m);
        if (imgs.length === 0) continue;
        const arr = index.get(ref) ?? [];
        if (!index.has(ref)) index.set(ref, arr);
        imgs.forEach((im, i) => {
            // #1995 review: spill at index-time so the session retains only
            // metadata + path (never base64). Skip-if-exists keeps the steady
            // state to one stat per image per turn, not a full decode + write.
            const path = writeRestoredImage(ref, i, im, sessionId);
            if (!path) return;
            let width: number | undefined;
            let height: number | undefined;
            try {
                const d = decodeImageDims(im.b64);
                if (d) { width = d.w; height = d.h; }
            } catch {}
            arr.push({ mediaType: im.mediaType, bytes: im.bytes, width, height, path });
        });
    }
    return index;
}

/** #2607: post-prepare refresh of the incoming-image index. prepare assigns
 *  numeric refs to this turn's NEW messages — and archivable media now folds by
 *  default — so their pixels must be archived BEFORE preflight or the model can
 *  fold them away unrecoverably. Re-indexes the same raw body against the
 *  post-prepare state and MERGES into the existing index (union by on-disk
 *  path): the entry-time pass already spilled files, and merging guards against
 *  any future ref pruning inside prepare. writeRestoredImage's skip-if-exists
 *  keeps the second pass to one stat per known image. */
export function refreshIncomingImageIndex(
    parsed: unknown,
    protocol: WireProtocol,
    state: CompressionState,
    sessionId: string,
    existing: Map<string, IndexedImage[]> | undefined,
): Map<string, IndexedImage[]> {
    const fresh = buildIncomingImageIndex(parsed, protocol, state, sessionId);
    if (fresh.size === 0) return existing ?? new Map();
    const merged = existing ? new Map(existing) : new Map<string, IndexedImage[]>();
    const seen = new Set<string>();
    for (const imgs of merged.values()) for (const im of imgs) seen.add(im.path);
    for (const [ref, imgs] of fresh) {
        const kept = imgs.filter((im) => !seen.has(im.path));
        if (kept.length === 0) continue;
        for (const im of kept) seen.add(im.path);
        const prev = merged.get(ref);
        merged.set(ref, prev ? [...prev, ...kept] : kept);
    }
    return merged;
}

/** Best-effort expiry for spilled restore files (#1995): `decompress imageRef`
 *  needs the bytes long after the wire dropped them, but sessions end and disk
 *  is not infinite — default TTL one week. Prunes only THIS session's export
 *  dir. Errors are swallowed (eviction must never take down a request). */
export function pruneRetrieveImgExports(sessionId: string, ttlMs = 7 * 24 * 3600 * 1000): number {
    const dir = restoreExportDir(sessionId);
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return 0;
    }
    const now = Date.now();
    let removed = 0;
    for (const name of entries) {
        const p = join(dir, name);
        try {
            const st = statSync(p);
            if (st.isFile() && now - st.mtimeMs > ttlMs) { unlinkSync(p); removed++; }
        } catch {}
    }
    if (removed > 0) {
        try {
            // Drop the dir too when we emptied it, so finished sessions leave
            // no residue.
            if (readdirSync(dir).length === 0) rmdirSync(dir);
        } catch {}
    }
    return removed;
}

function refNum(ref: string): number {
    const m = /^m(\d+)$/i.exec(ref.trim());
    return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** Human-readable one-line-per-image listing of what is currently restorable
 *  ("m00042 [png 1024x768 · 240KB]"), sorted by ref then position. Capped so a
 *  very image-heavy history cannot blow up the tool result. */
export function describeRestorable(index: Map<string, IndexedImage[]>, cap = 50): string[] {
    const lines: string[] = [];
    const refs = [...index.keys()].sort((a, b) => refNum(a) - refNum(b));
    outer: for (const ref of refs) {
        const imgs = index.get(ref)!;
        for (let i = 0; i < imgs.length; i++) {
            const im = imgs[i];
            let note = im.mediaType.includes("/") ? im.mediaType.split("/").pop()! : im.mediaType;
            if (im.width != null && im.height != null) note += ` ${im.width}x${im.height}`;
            note += ` · ${Math.max(1, Math.round(im.bytes / 1024))}KB`;
            lines.push(`${ref}${i > 0 ? `[-${i}]` : ""} [${note}]`);
            if (lines.length >= cap) break outer;
        }
    }
    return lines;
}

/** Directory restored images are written to: <stateDir>/retrieve/img/<sessionId>/.
 *  mNNNNN refs are PER-SESSION sequence numbers, so the session id MUST be part
 *  of the path — a flat retrieve/img/ would let two sessions' same-numbered refs
 *  collide, and with skip-if-exists the first session's pixels would be served
 *  for the second session's ref forever (cross-session finding from review). */
/** Directory name (not path) for a session's spill tree — exported so the
 *  session GC can address the same dir under a test-provided root. */
export function restoreExportDirName(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
    // Review ①: distinct raw ids that sanitize to the same safe form ("a/b" vs
    // "a-b", or a >100-char truncation) must not share a directory — salt with
    // a short hash of the RAW id whenever the sanitizer changed anything. The
    // salt is deterministic, so the path survives restarts, and post-salt the
    // map id -> dir is injective (two ids can only collide when both sanitize
    // AND hash identically). Unsalted ids keep their historical path.
    return safe === sessionId
        ? (safe || "session")
        : `${safe || "session"}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 8)}`;
}

export function restoreExportDir(sessionId: string): string {
    return join(stateDir(), "retrieve", "img", restoreExportDirName(sessionId));
}

function extFor(mediaType: string): string {
    const sub = (mediaType.split("/")[1] ?? "").toLowerCase();
    const map: Record<string, string> = { png: "png", jpeg: "jpg", jpg: "jpg", gif: "gif", webp: "webp", svg: "svg" };
    return map[sub] ?? "img";
}

/** Write one restorable image to disk (decoded bytes, 0600 — conversation
 *  content is not world-readable on multi-user hosts) and return its absolute
 *  path. Addressed by session + ref (+index) — refs alone are per-session, so
 *  the session id is what keeps concurrent sessions from overwriting each
 *  other. The filename additionally carries a short hash of the bytes: mNNNNN
 *  numbering restarts at m00001 on a rebase (resetSessionCompression) while old
 *  spill files survive on disk, so a ref-only name plus skip-if-exists would
 *  silently return the PREVIOUS generation's pixels for a new image under a
 *  reused ref (#1995 review F1). With the content salt, same name implies same
 *  bytes — the skip stays a correct idempotency check — and different content
 *  lands in a different file, so a stale hit is impossible (orphaned old-gen
 *  files age out via the 7d prune). Returns null on write failure. */
export function writeRestoredImage(ref: string, idx: number, img: RestorableImage, sessionId: string): string | null {
    const safeRef = ref.replace(/[^a-zA-Z0-9_-]/g, "-");
    const dir = restoreExportDir(sessionId);
    const body = Buffer.from(img.b64, "base64");
    const digest = createHash("sha256").update(body).digest("hex").slice(0, 8);
    const path = join(dir, `${safeRef}${idx > 0 ? `-${idx}` : ""}-${digest}.${extFor(img.mediaType)}`);
    try {
        if (existsSync(path)) return path;
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, body, { mode: 0o600 });
        return path;
    } catch (e) {
        loggerLog("warn", `[image-restore] write failed (${path}): ${String(e)}`);
        return null;
    }
}
