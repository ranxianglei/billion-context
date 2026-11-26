// Content-encoding handling for the client degraded direct-send path (#7698).
// omp's Anthropic client sends the model body as a gzip-encoded Uint8Array with
// `content-encoding: gzip`. The oversize guard and the prompt_cache_key strip
// both used to read the COMPRESSED bytes: the guard undercounted tokens ~2.7×
// (a 1.88M-token body measured as ~557K and sailed past the 1M window), and the
// key strip's JSON.parse hit garbage so the stamped key survived into a strict
// upstream (400 "prompt_cache_key: Extra inputs are not permitted"). This module
// decodes / re-encodes the wire bytes so both consumers see the actual JSON.
//
// Self-contained node:zlib (no fzstd) so it can be imported by the shared
// native-intercept.ts and the pi/omp guard without pulling the server's
// stream-based decoder (src/content-encoding.ts, which inlines fzstd) into
// every agent bundle. Sync by design: the measurement and key-strip paths run
// on the request's own hot path and the body is already in memory.

import * as zlib from "node:zlib";

export type BodyContentEncoding = "gzip" | "deflate" | "br" | "zstd";

/** Decoded-size cap (zip-bomb guard). A body that decodes beyond this is far
 *  beyond any model window (512 MiB ≈ 128M tokens), so the guard can refuse on
 *  the cap alone. zlib allocates the output as needed (no pre-allocation), so a
 *  small body costs nothing regardless of the cap. */
export const BODY_DECODE_CAP_BYTES = 512 * 1024 * 1024;

/** Normalize a single content-encoding token to a known coding, or undefined
 *  for anything else (identity / unknown → treat the body as already decoded). */
function normalizeCoding(raw: string | undefined): BodyContentEncoding | undefined {
    if (raw === undefined) return undefined;
    const v = raw.trim().toLowerCase();
    if (v === "gzip" || v === "x-gzip") return "gzip";
    if (v === "deflate") return "deflate";
    if (v === "br") return "br";
    if (v === "zstd") return "zstd";
    return undefined;
}

/** The outermost content-encoding of a dispatch, from its outgoing headers
 *  (already lowercased — see outgoingHeadersOf). Multiple codings are
 *  comma-separated; only the outermost one wraps the whole body, so only it is
 *  decoded here. `identity` and unknown codings → undefined (body as-is). */
export function bodyContentEncodingOf(headers: Record<string, string> | undefined): BodyContentEncoding | undefined {
    if (headers === undefined) return undefined;
    const ce = headers["content-encoding"];
    if (ce === undefined) return undefined;
    const first = ce.split(",").map((s) => s.trim()).find((s) => s.length > 0 && s.toLowerCase() !== "identity");
    return normalizeCoding(first);
}

type DecodedBody =
    | { status: "decoded"; bytes: Uint8Array }
    | { status: "too-large" }
    | { status: "undecodable" };

/** Decode `bytes` per `encoding` under the size cap. `undefined` encoding
 *  (no content-encoding) returns the bytes unchanged. Distinguishes
 *  "too-large" (cap exceeded → the decoded body is provably over any window,
 *  so the guard refuses) from "undecodable" (corrupt / unsupported coding →
 *  fail open, the #4912/#2496 discipline: unknown data never triggers a
 *  refusal). */
export function decodeBodyBytes(bytes: Uint8Array, encoding: BodyContentEncoding | undefined): DecodedBody {
    if (encoding === undefined) return { status: "decoded", bytes };
    try {
        let out: Buffer;
        switch (encoding) {
            case "gzip":
                out = zlib.gunzipSync(bytes, { maxOutputLength: BODY_DECODE_CAP_BYTES });
                break;
            case "deflate":
                try {
                    out = zlib.inflateSync(bytes, { maxOutputLength: BODY_DECODE_CAP_BYTES });
                } catch (e) {
                    // RFC 1950 vs 1951: some clients label a RAW deflate stream
                    // as "deflate"; retry raw before giving up. Any other error
                    // is a genuine corrupt stream.
                    if ((e as NodeJS.ErrnoException).code === "Z_DATA_ERROR") {
                        out = zlib.inflateRawSync(bytes, { maxOutputLength: BODY_DECODE_CAP_BYTES });
                    } else {
                        throw e;
                    }
                }
                break;
            case "br":
                out = zlib.brotliDecompressSync(bytes, { maxOutputLength: BODY_DECODE_CAP_BYTES });
                break;
            case "zstd":
                // zstd landed in node:zlib in Node 22.15/23.5; engines is >=20,
                // so guard the binding — an older runtime fails open (undecodable).
                if (typeof zlib.zstdDecompressSync !== "function") return { status: "undecodable" };
                out = zlib.zstdDecompressSync(bytes, { maxOutputLength: BODY_DECODE_CAP_BYTES });
                break;
        }
        return { status: "decoded", bytes: new Uint8Array(out) };
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") return { status: "too-large" };
        return { status: "undecodable" };
    }
}

/** The decoded JSON text of a restored direct-send body (#7698). A string body
 *  is already decoded (the incremental lane restores the original uncompressed
 *  body); a Uint8Array body is content-encoded (the omp guard re-encoded the
 *  stripped body to its original coding) and is decoded here. Undecodable →
 *  undefined (fail open — the marker sniff / JSON consumers treat it as
 *  "no body text", the #4912/#2496 discipline). */
export function restoredBodyText(body: string | Uint8Array, encoding: BodyContentEncoding | undefined): string | undefined {
    if (typeof body === "string") return body;
    const decoded = decodeBodyBytes(body, encoding);
    if (decoded.status !== "decoded") return undefined;
    return new TextDecoder().decode(decoded.bytes);
}

/** Re-encode `bytes` with `encoding` so a rewritten body rides the SAME
 *  content-encoding the request already declared (the header stays valid).
 *  `undefined` encoding returns the bytes unchanged. Returns undefined when the
 *  coding is unsupported on this runtime (the caller then fails open and sends
 *  the original encoded body unchanged — the #4912/#2496 discipline). */
export function encodeBodyBytes(bytes: Uint8Array, encoding: BodyContentEncoding | undefined): Uint8Array | undefined {
    if (encoding === undefined) return bytes;
    try {
        let out: Buffer;
        switch (encoding) {
            case "gzip":
                out = zlib.gzipSync(bytes);
                break;
            case "deflate":
                out = zlib.deflateSync(bytes);
                break;
            case "br":
                out = zlib.brotliCompressSync(bytes);
                break;
            case "zstd":
                if (typeof zlib.zstdCompressSync !== "function") return undefined;
                out = zlib.zstdCompressSync(bytes);
                break;
        }
        return new Uint8Array(out);
    } catch {
        return undefined;
    }
}
