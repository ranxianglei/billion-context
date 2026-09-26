import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as zlib from "node:zlib";
import { Decompress as ZstdWasmDecompress } from "fzstd";
import type { StateStoreCodec } from "acp-kernel/persist";

/**
 * Session-file storage encoding at rest: AES-256-GCM encryption (#708) and
 * zstd compression (#1080), applied around every StateStore write/read and
 * configured INDEPENDENTLY of each other.
 *
 * THREAT MODEL (#708): the proxy may run on untrusted nodes; session files
 * hold block summaries plus up to ~16k tokens of folded conversation per
 * session — effectively full conversation content (code, pasted credentials).
 * The key comes ONLY from the BILI_ENCRYPTION_KEY environment variable: a key
 * file next to the data sits on the same untrusted filesystem and defeats the
 * purpose.
 *
 * COMPRESSION (#1080, owner decision): session JSON is zstd-compressed only
 * when opted in (BILI_PERSIST_ZSTD=1/true); the default stays plain JSON for
 * recoverability and downgrade safety. Clients and tools never see the
 * on-disk format — the store decodes transparently and `bili export` renders
 * plaintext.
 *
 * FORMATS (v1):
 *   encrypted (BILIENC1):
 *     offset 0..7    magic "BILIENC1"
 *     offset 8       format version (0x01)
 *     offset 9       body mode (0x00 raw, 0x01 zstd)
 *     offset 10..21  GCM nonce (random per write)
 *     offset 22..    AES-256-GCM ciphertext, final 16 bytes = auth tag
 *   compressed (BILIZSTD1):
 *     offset 0..8    magic "BILIZSTD1"
 *     offset 9       format version (0x01)
 *     offset 10      body mode (0x00 raw, 0x01 zstd)
 *     offset 11..    body (JSON or zstd stream)
 *
 * Compression runs BEFORE encryption (GCM ciphertext is incompressible); the
 * mode byte records which, so each concern stays independently configurable.
 * node:zlib gained zstd in Node 22.15; on older runtimes the writer falls
 * back to a raw body and the reader uses the bundled fzstd WASM decoder, so a
 * file written by any supported version reads back on every supported one.
 */

export const ENCRYPT_MAGIC = Buffer.from("BILIENC1", "utf8");
export const ZSTD_MAGIC = Buffer.from("BILIZSTD1", "utf8");
const FORMAT_VERSION = 0x01;
const MODE_RAW = 0x00;
const MODE_ZSTD = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const ENCRYPT_HEADER_LEN = ENCRYPT_MAGIC.length + 2 + NONCE_LEN;
const MIN_ENCRYPTED_LEN = ENCRYPT_HEADER_LEN + TAG_LEN;
const PLAIN_HEADER_LEN = ZSTD_MAGIC.length + 2;

/** Parse the BILI_ENCRYPTION_KEY value: hex or base64, must decode to
 *  exactly 32 bytes. Hex wins when both parse (a base64 string made only of
 *  hex digits is ambiguous — hex-first is the documented rule). Throws with
 *  an actionable message; the caller surfaces it as a startup crash (fail
 *  fast — never run silently unencrypted when the operator asked for it). */
export function parseEncryptionKey(value: string): Buffer {
    const v = value.trim();
    let buf: Buffer | null = null;
    if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) {
        buf = Buffer.from(v, "hex");
    } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(v)) {
        buf = Buffer.from(v, "base64");
    }
    if (!buf || buf.length !== 32) {
        const got = buf ? `${buf.length} bytes` : "an undecodable value";
        throw new Error(
            `[encrypt] BILI_ENCRYPTION_KEY must be exactly 32 bytes encoded as hex (64 chars) or base64 — got ${got}`,
        );
    }
    return buf;
}

let zstdOverride: false | null = null;

/** Test hook: simulate runtimes without native zstd (pre-Node-22.15). Can
 *  only claim ABSENCE, never presence — encoding then falls back to a raw
 *  body and decoding uses the WASM path. */
export function _setZstdAvailableForTest(v: false | null): void {
    zstdOverride = v;
}

function zstdAvailable(): boolean {
    if (zstdOverride === false) return false;
    return typeof zlib.zstdCompressSync === "function" && typeof zlib.zstdDecompressSync === "function";
}

/** Decompress a zstd-mode body: native node:zlib when present, otherwise the
 *  bundled fzstd WASM decoder — keeps newer-runtime files readable on older
 *  ones (#1080). */
function inflateZstd(body: Buffer): Buffer {
    if (zstdAvailable()) return zlib.zstdDecompressSync(body);
    const chunks: Buffer[] = [];
    new ZstdWasmDecompress((chunk) => chunks.push(Buffer.from(chunk))).push(body, true);
    return Buffer.concat(chunks);
}

interface StorageCodecOptions {
    /** AES-256-GCM key (#708). Without one, BILIENC1 files cannot be read —
     *  they surface as an actionable corrupt-file error instead of garbage. */
    key?: Buffer | null;
    /** zstd-compress bodies (#1080, default true) — applies to BOTH formats;
     *  the mode byte records it, so compression stays independent of
     *  encryption. */
    compress?: boolean;
}

/** Build the StateStore codec for session files, or undefined when neither
 *  encryption nor compression applies (plain JSON on disk). decode()
 *  dispatches on magic — BILIENC1 → AES-256-GCM, BILIZSTD1 → zstd/raw,
 *  anything else passes through untouched (legacy plaintext) — so mixed
 *  trees load fine under any codec configuration.
 *  A decode failure throws and the kernel store treats the file as corrupt
 *  (warn + skip). */
export function createStorageCodec(opts: StorageCodecOptions = {}): StateStoreCodec | undefined {
    const key = opts.key ?? null;
    const compress = opts.compress ?? false;
    if (!key && !compress) return undefined;
    return {
        encode(data: string): Buffer {
            const plain = Buffer.from(data, "utf8");
            // Size guard (#1080 review): only frame-and-compress when it
            // actually shrinks the payload. Tiny sessions would otherwise
            // grow by the magic+header overhead, and — more important — an
            // uncompressed MODE_RAW body has no reason to be framed at all
            // when no key is set: unframed plain JSON maximizes backward
            // compatibility (a downgrade reads it natively).
            const useZstd = compress && zstdAvailable();
            let body = plain;
            let mode = MODE_RAW;
            if (useZstd) {
                const z = zlib.zstdCompressSync(plain);
                if (z.length < plain.length) {
                    body = z;
                    mode = MODE_ZSTD;
                }
            }
            if (!key && mode === MODE_RAW) return plain;
            const header = Buffer.from([FORMAT_VERSION, mode]);
            if (!key) {
                return Buffer.concat([ZSTD_MAGIC, header, body]);
            }
            const nonce = randomBytes(NONCE_LEN);
            const cipher = createCipheriv("aes-256-gcm", key, nonce);
            const ct = Buffer.concat([cipher.update(body), cipher.final()]);
            return Buffer.concat([ENCRYPT_MAGIC, header, nonce, ct, cipher.getAuthTag()]);
        },
        decode(buf: Buffer): string {
            if (buf.length >= ENCRYPT_MAGIC.length && buf.subarray(0, ENCRYPT_MAGIC.length).equals(ENCRYPT_MAGIC)) {
                return decryptEnvelope(buf, key);
            }
            if (buf.length >= ZSTD_MAGIC.length && buf.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
                return decompressEnvelope(buf);
            }
            return buf.toString("utf8");
        },
    };
}

function decryptEnvelope(buf: Buffer, key: Buffer | null): string {
    if (!key) {
        throw new Error("[storage] session file is BILIENC1-encrypted but no BILI_ENCRYPTION_KEY is set — cannot read it");
    }
    if (buf.length < MIN_ENCRYPTED_LEN || buf[ENCRYPT_MAGIC.length] !== FORMAT_VERSION) {
        throw new Error(`[encrypt] unsupported session file format version ${buf[ENCRYPT_MAGIC.length]}`);
    }
    const mode = buf[ENCRYPT_MAGIC.length + 1];
    const nonce = buf.subarray(ENCRYPT_HEADER_LEN - NONCE_LEN, ENCRYPT_HEADER_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const ct = buf.subarray(ENCRYPT_HEADER_LEN, buf.length - TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const body = Buffer.concat([decipher.update(ct), decipher.final()]);
    const plain = mode === MODE_ZSTD ? inflateZstd(body) : body;
    return plain.toString("utf8");
}

function decompressEnvelope(buf: Buffer): string {
    if (buf.length < PLAIN_HEADER_LEN || buf[ZSTD_MAGIC.length] !== FORMAT_VERSION) {
        throw new Error(`[storage] unsupported session file format version ${buf[ZSTD_MAGIC.length]}`);
    }
    const mode = buf[ZSTD_MAGIC.length + 1];
    const body = buf.subarray(PLAIN_HEADER_LEN);
    const plain = mode === MODE_ZSTD ? inflateZstd(body) : body;
    return plain.toString("utf8");
}
