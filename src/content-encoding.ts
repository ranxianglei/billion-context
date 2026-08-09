import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate, inflateRaw } from "node:zlib";
import { Decompress as ZstdDecompress } from "fzstd";

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const inflateRawAsync = promisify(inflateRaw);
const brotliAsync = promisify(brotliDecompress);

async function decodeZstd(input: Buffer, maxOutputBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    const decoder = new ZstdDecompress((chunk) => {
        size += chunk.byteLength;
        if (size > maxOutputBytes) throw new Error(`decompressed request exceeds ${maxOutputBytes} bytes`);
        chunks.push(Buffer.from(chunk));
    });
    decoder.push(input, true);
    return Buffer.concat(chunks, size);
}

async function decodeOne(coding: string, input: Buffer, maxOutputBytes: number): Promise<Buffer> {
    const options = { maxOutputLength: maxOutputBytes };
    if (coding === "gzip" || coding === "x-gzip") return gunzipAsync(input, options);
    if (coding === "br") return brotliAsync(input, options);
    if (coding === "zstd") return decodeZstd(input, maxOutputBytes);
    if (coding === "deflate") {
        try {
            return await inflateAsync(input, options);
        } catch {
            return inflateRawAsync(input, options);
        }
    }
    throw new Error(`unsupported request content-encoding: ${coding}`);
}

export async function decodeRequestBody(
    contentEncoding: string | undefined,
    input: Buffer,
    maxOutputBytes: number,
): Promise<{ body: Buffer; decoded: boolean }> {
    const codings = (contentEncoding ?? "")
        .split(",")
        .map((coding) => coding.trim().toLowerCase())
        .filter((coding) => coding && coding !== "identity");
    if (codings.length === 0) return { body: input, decoded: false };
    let body = input;
    for (const coding of codings.reverse()) {
        body = await decodeOne(coding, body, maxOutputBytes);
        if (body.byteLength > maxOutputBytes) {
            throw new Error(`decompressed request exceeds ${maxOutputBytes} bytes`);
        }
    }
    return { body, decoded: true };
}
