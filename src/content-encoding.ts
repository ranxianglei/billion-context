import * as zlib from "node:zlib";
import { DecodedRequestBusyError } from "./request-body-budget.js";
import type { Duplex } from "node:stream";
import { Decompress as ZstdDecompress } from "fzstd";

/** Raised when a request body's DECOMPRESSED size would exceed the configured
 *  limit (decompression-bomb guard). Kept distinct from a corrupt/unsupported
 *  body so callers reject an oversized payload (413) while relaying genuinely
 *  undecodable ones verbatim (#619). */
export class DecompressedTooLargeError extends Error {
    constructor(public readonly limit: number) {
        super(`decompressed request exceeds ${limit} bytes`);
        this.name = "DecompressedTooLargeError";
    }
}

/** #5794 item 2: raised for a decoded body above the INGEST cost band
 *  (network.ingestBodyBytes / BILI_INGEST_BODY_BYTES, default 32 MiB). Distinct
 *  from DecompressedTooLargeError (a decode-cap bomb guard): this one bounds the
 *  JSON.parse + normalization sweep itself — a 51.2 MiB / 29,619-message body
 *  spent 5.5–7.2 s per round there (54.6% of local CPU → 747 s event-loop
 *  FATAL → every session's cache went cold). Any parseable body above the band
 *  is already ≥ ~8M tokens, beyond every real model window, so refusing it is
 *  free. The message is the operator-facing actionable guidance. */
export class IngestBodyTooLargeError extends Error {
    constructor(public readonly limit: number, public readonly bytes: number) {
        super(`request body ${bytes.toLocaleString("en-US")} B (after decode) exceeds the ingestion cost band ${limit.toLocaleString("en-US")} B (#5794: bodies this large are ≥ ~8M tokens — beyond every model window — and burn the event loop for seconds in the parse sweep). Reduce the session history — restart the session or rewind to an earlier point — and retry.`);
        this.name = "IngestBodyTooLargeError";
    }
}

/** Stream-decompress under a hard byte cap: rejects with DecompressedTooLargeError
 *  the instant output exceeds `max`, so a bomb never inflates in memory and the
 *  cap is enforced deterministically per codec. node's one-shot `maxOutputLength`
 *  instead reports overflow opaquely (ERR_BUFFER_TOO_LARGE for gzip/br; an
 *  ambiguous Z_DATA_ERROR for deflate that cannot be told apart from a corrupt
 *  stream), so counting the stream ourselves is the only reliable signal. */
interface DecodeOptions {
    signal?: AbortSignal;
    onBytes?: (bytes: number) => void;
}

function streamDecode(factory: () => Duplex, input: Buffer, max: number, options?: DecodeOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const decoder = factory();
        const abort = () => decoder.destroy(options?.signal?.reason ?? new Error("request decoding aborted"));
        decoder.once("close", () => options?.signal?.removeEventListener("abort", abort));
        decoder.on("data", (chunk: Buffer) => {
            if (decoder.destroyed) return;
            size += chunk.length;
            try {
                if (size > max) throw new DecompressedTooLargeError(max);
                options?.onBytes?.(size);
                chunks.push(chunk);
            } catch (err) {
                decoder.destroy(err instanceof Error ? err : new Error(String(err)));
            }
        });
        decoder.on("end", () => resolve(Buffer.concat(chunks, size)));
        decoder.on("error", (err: Error) => reject(err));
        if (options?.signal?.aborted) abort();
        else {
            options?.signal?.addEventListener("abort", abort, { once: true });
            decoder.end(input);
        }
    });
}

/** Frame boundaries from RFC 8878 section 3.1, without decompressing blocks.
 * Node 22's native decoder drops later frames in one input buffer and accepts
 * truncated frames (nodejs/node#64741, #64592). Validate their extent first,
 * then decode complete frames separately; native zstd still checks contents. */
function* zstdFrames(input: Buffer): Generator<Buffer> {
    let offset = 0;
    const requireBytes = (count: number): void => {
        if (count > input.length - offset) throw new Error("truncated zstd frame");
    };
    do {
        const start = offset;
        requireBytes(4);
        const magic = input.readUInt32LE(offset);
        if ((magic & 0xfffffff0) === 0x184d2a50) {
            requireBytes(8);
            const size = input.readUInt32LE(offset + 4);
            offset += 8;
            requireBytes(size);
            offset += size;
        } else {
            if (magic !== 0xfd2fb528) throw new Error("invalid zstd frame magic");
            requireBytes(5);
            const descriptor = input[offset + 4];
            if (descriptor & 8) throw new Error("reserved zstd frame bit");
            const singleSegment = (descriptor & 32) !== 0;
            const dictionaryFlag = descriptor & 3;
            const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
            const sizeFlag = descriptor >>> 6;
            const sizeBytes = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag;
            offset += 5;
            const remainingHeader = (singleSegment ? 0 : 1) + dictionaryBytes + sizeBytes;
            requireBytes(remainingHeader);
            offset += remainingHeader;
            let lastBlock: boolean;
            do {
                requireBytes(3);
                const header = input.readUIntLE(offset, 3);
                offset += 3;
                lastBlock = (header & 1) !== 0;
                const blockType = (header >>> 1) & 3;
                if (blockType === 3) throw new Error("reserved zstd block type");
                const size = blockType === 1 ? 1 : header >>> 3;
                requireBytes(size);
                offset += size;
            } while (!lastBlock);
            if (descriptor & 4) {
                requireBytes(4);
                offset += 4;
            }
        }
        yield input.subarray(start, offset);
    } while (offset < input.length);
}

async function decodeZstd(input: Buffer, max: number, options?: DecodeOptions): Promise<Buffer> {
    if (typeof zlib.createZstdDecompress === "function") {
        const chunks: Buffer[] = [];
        let size = 0;
        for (const frame of zstdFrames(input)) {
            options?.signal?.throwIfAborted();
            const body = await streamDecode(zlib.createZstdDecompress, frame, max, {
                signal: options?.signal,
                onBytes: (bytes) => {
                    const total = size + bytes;
                    if (total > max) throw new DecompressedTooLargeError(max);
                    options?.onBytes?.(total);
                },
            });
            chunks.push(body);
            size += body.length;
        }
        return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const decoder = new ZstdDecompress((chunk) => {
        size += chunk.byteLength;
        if (size > max) throw new DecompressedTooLargeError(max);
        options?.signal?.throwIfAborted();
        options?.onBytes?.(size);
        chunks.push(Buffer.from(chunk));
    });
    decoder.push(input, true);
    return Buffer.concat(chunks, size);
}

async function decodeOne(coding: string, input: Buffer, max: number, options?: DecodeOptions): Promise<Buffer> {
    if (coding === "gzip" || coding === "x-gzip") return streamDecode(zlib.createGunzip, input, max, options);
    if (coding === "br") return streamDecode(zlib.createBrotliDecompress, input, max, options);
    if (coding === "zstd") return decodeZstd(input, max, options);
    if (coding === "deflate") {
        try {
            return await streamDecode(zlib.createInflate, input, max, options);
        } catch (err) {
            if (err instanceof DecompressedTooLargeError || err instanceof DecodedRequestBusyError || options?.signal?.aborted) throw err;
            return streamDecode(zlib.createInflateRaw, input, max, options);
        }
    }
    throw new Error(`unsupported request content-encoding: ${coding}`);
}

export async function decodeRequestBody(
    contentEncoding: string | undefined,
    input: Buffer,
    maxOutputBytes: number,
    options?: DecodeOptions,
): Promise<{ body: Buffer; decoded: boolean }> {
    options?.signal?.throwIfAborted();
    const codings = (contentEncoding ?? "")
        .split(",")
        .map((coding) => coding.trim().toLowerCase())
        .filter((coding) => coding && coding !== "identity");
    if (codings.length === 0) return { body: input, decoded: false };
    let body = input;
    for (const coding of codings.reverse()) {
        body = await decodeOne(coding, body, maxOutputBytes, options);
        if (body.byteLength > maxOutputBytes) throw new DecompressedTooLargeError(maxOutputBytes);
    }
    return { body, decoded: true };
}
