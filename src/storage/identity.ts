/**
 * #4390: identity helpers for the unified store.
 *
 * The messages table carries TWO hashes with different jobs:
 *  - content_hash: the CAS key of the stored bytes (byte-faithful, includes
 *    sidecars; putContent refcounts by it). NEVER migrates.
 *  - identity: the cross-save JOIN key ("is this the message I already
 *    know?"). Its input STRIPS position metadata — m.id itself and the
 *    wireIndex the wire codecs stamp on every parse — because those change
 *    when the client truncates/edits ANYWHERE in the resent history while
 *    the message's logical content does not (#4390 D4-1: one head-truncation
 *    used to re-mint the whole surviving generation: new hashes, new seqs,
 *    block interval bounds built on sand).
 *
 * Same identity ⇒ same logical message ⇒ same row, same seq. A re-arrival
 * with different bytes but the same identity (sidecar drift, a stale
 * wireIndex after a head truncation, external CAS corruption) is healed by
 * the FULL ingest path, which adopts the fresher bytes at the SAME seq —
 * the parity oracle must observe the authoritative view again (#4390
 * review); the append-only delta path never rewrites stored rows. A real
 * edit changes the content-derived id and therefore the identity.
 */
import { createHash } from "node:crypto";

function sha256Hex(bytes: string | Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Media payloads below this size ride inline even inside raw sidecars —
 * splitting them costs a CAS row + a join for a few hundred bytes (#4069).
 */
const MIN_MEDIA_URL_SPLIT_BYTES = 2048;
/** data:<mime>;base64,<payload> with the payload swapped for its CAS hash. */
const MEDIA_URL_MARKER_RE = new RegExp(
    `data:([a-zA-Z0-9.+\\/-]+);base64,([A-Za-z0-9+/=]{${MIN_MEDIA_URL_SPLIT_BYTES},})`,
    "g",
);

export function splitMediaContent(content: string): { content: string; hash: string; media: { hash: string; bytes: string }[] } {
    let media: { hash: string; bytes: string }[] = [];
    let split = content;
    if (content.includes("\"imageBase64\"")) {
        let parsed: { imageBase64?: unknown };
        try {
            parsed = JSON.parse(content) as { imageBase64?: unknown };
        } catch {
            parsed = undefined as unknown as { imageBase64?: unknown };
        }
        if (parsed) {
            const bytes = parsed.imageBase64;
            if (typeof bytes === "string" && bytes.length > 0) {
                const mediaHash = sha256Hex(bytes);
                parsed.imageBase64 = { $media: mediaHash };
                split = JSON.stringify(parsed);
                media.push({ hash: mediaHash, bytes });
            }
        }
    }
    // #4069: raw wire sidecars (rawOpenaiContent / rawOpenaiContentParts /
    // rawResponsesItem / rawGoogleParts, …) carry the ORIGINAL part verbatim —
    // for image parts that means the same base64 payload a second time, as a
    // data URL. Swap every sufficiently large payload for its CAS hash, mime
    // prefix and JSON structure untouched, so hydration is byte-identical.
    if (split.includes(";base64,")) {
        const byHash = new Map(media.map((m) => [m.hash, m.bytes]));
        split = split.replace(MEDIA_URL_MARKER_RE, (_all: string, mime: string, payload: string) => {
            const mediaHash = sha256Hex(payload);
            if (!byHash.has(mediaHash)) {
                byHash.set(mediaHash, payload);
                media = [...media, { hash: mediaHash, bytes: payload }];
            }
            return `data:${mime};base64,{$media:${mediaHash}}`;
        });
    }
    return { content: split, hash: sha256Hex(split), media };
}

/** Strip the position/identity metadata from a serialized CoreMessage.
 *  JSON.parse preserves key insertion order, so the stripped serialization
 *  is deterministic for the same object shape. ledgerSeq is stripped for
 *  the same reason as wireIndex: it is a POSITION stamp the server adds
 *  late (#4316 PR2/3 stamps the in-memory canonical during the wrap-up),
 *  not logical content — keeping it would re-mint the row identity on
 *  every turn and re-append the whole view as fresh rows. */
function identityInputOf(raw: string): string {
    let parsed: { id?: unknown; wireIndex?: unknown; ledgerSeq?: unknown };
    try {
        parsed = JSON.parse(raw) as { id?: unknown; wireIndex?: unknown; ledgerSeq?: unknown };
    } catch {
        return raw;
    }
    if (parsed.id === undefined && parsed.wireIndex === undefined && parsed.ledgerSeq === undefined) return raw;
    delete parsed.id;
    delete parsed.wireIndex;
    delete parsed.ledgerSeq;
    return JSON.stringify(parsed);
}

/** Identity from a STORED content column (already media-split; may still
 *  carry id/wireIndex from pre-#4390 bytes). Strip and media-split
 *  commute, so this equals the identity the live intern pass computes for
 *  the same message — the migration backfill and the direct-caller
 *  fallbacks in store.ts rely on that equivalence. */
export function identityOfStoredContent(content: string): string {
    return sha256Hex(identityInputOf(content));
}
