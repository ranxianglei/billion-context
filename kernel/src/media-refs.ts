/**
 * #5620: ref-recoverable media — classification + mechanical ref preservation.
 *
 * hasUnrecoverableMediaPayload (protected.ts) historically pinned EVERY
 * message whose media bytes bili cannot store locally — remote-URL images,
 * DeepSeek Files API `{type:"file"}` refs, Google fileData/videoMetadata.
 * In an image-heavy workflow that conflation built the #5620 usage wall:
 * each such message became a permanent non-foldable anchor, turn integrity
 * pinned its partners, folds kept pace with growth but the context floor
 * climbed to ~70% of the window and never came down.
 *
 * The fix splits the class: a media message is FOLDABLE when it exposes at
 * least one extractable re-access handle (a non-data: URL, a file id, a
 * fileUri). Folding then loses nothing unrecoverable — the handles ride the
 * stored summary verbatim (collectFoldMediaRefs appends them mechanically at
 * apply time, below), and decompress restores the original message
 * losslessly regardless. Only media with NO extractable ref stays pinned,
 * as do control-plane structured system messages (different mechanism —
 * folding those un-declares tools; untouched here).
 *
 * Conservative by design: only KNOWN ref shapes are enumerated. Unknown
 * opaque parts keep pinning (pre-#5620 behavior) until their semantics are
 * established — the litmus is "can the payload be re-acquired from the
 * surviving text alone?", and an unenumerated shape answers that with no
 * evidence either way.
 *
 * #5865-P2 (PR #5865 review F2): the litmus also requires the handle to be
 * DURABLE. A pre-signed/expiring HTTP(S) URL (S3/GCS/Azure-SAS/CDN tokens)
 * satisfies "has a ref" but lapses — by the time a folded summary is
 * decompressed (hours later by definition of folding) the handle is dead and
 * the payload is gone, whereas pre-#5620 pinned such messages forever. Such
 * URLs are therefore classified as NON-recoverable (the message keeps
 * pinning). Deliberately over-eager: a false positive only re-pins one media
 * message; a false negative silently loses the payload.
 */
import type { CompressionBlock, CoreMessage } from "./types.js";

/** Same wire-sidecar view protected.ts uses — core modules must not import
 *  from src/wire/. */
interface MediaSidecar {
  rawOpenaiContent?: unknown;
  rawOpenaiContentParts?: unknown[];
  rawAnthropicBlock?: unknown;
  rawResponsesItem?: unknown;
  rawGoogleParts?: unknown[];
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Inline-bytes test mirroring protected.ts / parseDataUrl's shape: only
 *  data: URLs hold recoverable bytes — everything else is a REFERENCE. */
function isInlineDataUrl(u: unknown): boolean {
  return typeof u === "string" && /^data:[^;,]+(?:;base64)?,.+$/i.test(u);
}

/** #5865-P2: query-parameter NAMES that mark an HTTP(S) URL as a
 *  pre-signed/expiring handle — the enumerated families:
 *  - cloud-provider signing prefixes (S3 v4 `X-Amz-*`, GCS `X-Goog-*`,
 *    Azure Blob SAS `X-MS-*`, R2/Cloudflare `X-CF-*`/`X-R2-*`, Aliyun OSS
 *    `X-OSS-*`… via the generic provider-prefix pattern — including the
 *    Huawei OBS `X-OBS-*`, Tencent COS `X-COS-*` and Baidu BCE `X-BCE-*`
 *    families);
 *  - explicit expiry keys (`Expires`/`expiry`/`exp`/`ttl` — covers S3 v1
 *    pre-signing and generic signed-CDN schemes);
 *  - credential/session keys (`Signature`/`sig`/`token`/`session-token`/
 *    `security-token`/`auth` — session-bound tokens on private CDNs).
 *  Non-HTTP refs (DeepSeek `file_id`, `gs://` URIs, bare ids) never match —
 *  they are durable by definition of the #5620 split. */
const EPHEMERAL_QUERY_PARAM =
  /^(?:x-(?:amz|goog|ms|cf|r2|oss|azure|obs|cos|bce)-.*|(?:expires?|expiry|exp|ttl|signature|sig|session-token|security-token|token|auth))$/i;

/** #5865-P2: true when the ref is an HTTP(S) URL whose query carries a
 *  signed/expiring marker — its re-access is time-bounded, so it must not
 *  count as a durable re-access handle (see module header). */
export function looksEphemeralSignedUrl(ref: string): boolean {
  if (!/^https?:\/\//i.test(ref)) return false;
  const q = ref.indexOf("?");
  if (q === -1) return false;
  for (const pair of ref.slice(q + 1).split("&")) {
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    if (name !== "" && EPHEMERAL_QUERY_PARAM.test(name)) return true;
  }
  return false;
}

function pushRef(refs: string[], ref: unknown): void {
  if (typeof ref !== "string" || ref.length === 0 || isInlineDataUrl(ref)) return;
  // #5865-P2: an expiring handle is not a re-access handle — keep the
  // message pinned (pre-#5620 behavior) rather than folding bytes whose only
  // surviving copy dies with the URL.
  if (looksEphemeralSignedUrl(ref)) return;
  refs.push(ref);
}

/** Collect every re-access handle (non-data: URL / file id / fileUri) a
 *  message exposes across all five wire sidecar families, in stable
 *  sidecar-then-part order, deduplicated. Empty array = no extractable
 *  handle (the message's media, if any, is byteless-and-refless). */
export function extractMediaRefs(message: CoreMessage): string[] {
  const m = message as CoreMessage & MediaSidecar;
  const refs: string[] = [];

  const roc = asObj(m.rawOpenaiContent);
  if (roc) {
    if (roc.type === "image_url") pushRef(refs, asObj(roc.image_url)?.url);
    else if (roc.type === "file") {
      pushRef(refs, roc.file_id);
      pushRef(refs, roc.url);
    }
  }
  if (Array.isArray(m.rawOpenaiContentParts)) {
    for (const p of m.rawOpenaiContentParts) {
      const part = asObj(p);
      if (!part) continue;
      if (part.type === "image_url") pushRef(refs, asObj(part.image_url)?.url);
      else if (part.type === "file") {
        pushRef(refs, part.file_id);
        pushRef(refs, part.url);
      }
    }
  }

  const ab = asObj(m.rawAnthropicBlock);
  if (ab) {
    if (ab.type === "image") {
      const source = asObj(ab.source);
      if (source?.type === "url") pushRef(refs, source.url);
    } else if (ab.type === "tool_result" && Array.isArray(ab.content)) {
      for (const b of ab.content) {
        const blk = asObj(b);
        if (blk?.type !== "image") continue;
        const source = asObj(blk.source);
        if (source?.type === "url") pushRef(refs, source.url);
      }
    }
  }

  const item = asObj(m.rawResponsesItem);
  if (item) {
    const parts: Record<string, unknown>[] = [];
    if (item.type === "input_image") parts.push(item);
    for (const key of ["content", "output"] as const) {
      const arr = item[key];
      if (Array.isArray(arr))
        for (const p of arr) {
          const o = asObj(p);
          if (o?.type === "input_image") parts.push(o);
        }
    }
    for (const p of parts) pushRef(refs, p.image_url);
  }

  if (Array.isArray(m.rawGoogleParts)) {
    const walk = (parts: unknown[]): void => {
      for (const p of parts) {
        const part = asObj(p);
        if (!part) continue;
        pushRef(refs, asObj(part.fileData)?.fileUri);
        const fr = asObj(part.functionResponse);
        if (fr && Array.isArray(fr.parts)) walk(fr.parts);
      }
    };
    walk(m.rawGoogleParts);
  }

  return [...new Set(refs)];
}

/** True when msg carries at least one extractable re-access handle — the
 *  #5620 split of hasUnrecoverableMediaPayload's media class. */
export function hasRefRecoverableMediaPayload(message: CoreMessage): boolean {
  return extractMediaRefs(message).length > 0;
}

/** Deterministic header of the mechanically-appended summary section. Exact
 *  match is the parse boundary — models are told to preserve it verbatim,
 *  and the append/strip/parse trio below is idempotent on it. */
export const MEDIA_REFS_MARKER =
  "MEDIA REFS (verbatim re-access handles — preserve when distilling):";

function stripMediaRefsSection(summary: string): string {
  const lines = summary.split("\n");
  const idx = lines.findIndex((l) => l.trim() === MEDIA_REFS_MARKER);
  if (idx === -1) return summary;
  let end = idx + 1;
  while (end < lines.length && lines[end]!.startsWith("- ")) end++;
  lines.splice(idx, end - idx);
  return lines.join("\n");
}

/** Parse the mechanically-appended section back out (empty when absent —
 *  summaries written before #5620 carry none). */
export function parseMediaRefsSection(summary: string): string[] {
  const lines = summary.split("\n");
  const idx = lines.findIndex((l) => l.trim() === MEDIA_REFS_MARKER);
  if (idx === -1) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < lines.length && lines[i]!.startsWith("- "); i++)
    out.push(lines[i]!.slice(2).trim());
  return out;
}

/** Append the canonical section (replacing any model-written twin, so a
 *  fold re-applied over the same content never double-lists). Returns the
 *  input unchanged when refs is empty. */
export function appendMediaRefsSection(
  summary: string,
  refs: readonly string[],
): string {
  if (refs.length === 0) return summary;
  const base = stripMediaRefsSection(summary).replace(/\n+$/, "");
  const section = `${MEDIA_REFS_MARKER}\n${refs.map((r) => `- ${r}`).join("\n")}`;
  return base ? `${base}\n\n${section}` : section;
}

/** Union of the re-access handles a fold must record: extracted from the
 *  newly-folded direct messages, plus carried forward from every consumed
 *  block's stored summary (merges/distillations must not drop handles their
 *  sources already recorded). Stable order: direct-message order, then
 *  consumed-block order, deduplicated. */
export function collectFoldMediaRefs(
  directMessages: readonly (CoreMessage | undefined)[],
  consumedBlocks: readonly (CompressionBlock | undefined)[],
): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  const add = (r: string): void => {
    if (!seen.has(r)) {
      seen.add(r);
      refs.push(r);
    }
  };
  for (const m of directMessages)
    if (m) for (const r of extractMediaRefs(m)) add(r);
  // #5865 review: block summaries written by OLDER builds can carry refs
  // that looksEphemeralSignedUrl would reject today — the carry-forward must
  // apply the same filter or a dead signed URL survives forever via the
  // merged block's MEDIA REFS section even though no live message holds it.
  for (const b of consumedBlocks)
    if (b) for (const r of parseMediaRefsSection(b.summary)) if (!looksEphemeralSignedUrl(r)) add(r);
  return refs;
}
