import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as zlib from "node:zlib";
import type { StateStoreCodec } from "acp-kernel/persist";

/**
 * Session-file encryption at rest (#708): AES-256-GCM over an optionally
 * zstd-compressed JSON envelope, applied around every StateStore write/read.
 *
 * THREAT MODEL: the proxy may run on untrusted nodes; session files hold
 * block summaries plus up to ~16k tokens of folded conversation per session
 * — effectively full conversation content (code, pasted credentials). The
 * key comes ONLY from the BILI_ENCRYPTION_KEY environment variable: a key
 * file next to the data sits on the same untrusted filesystem and defeats
 * the purpose.
 *
 * FORMAT (v1):
 *   offset 0..7    magic "BILIENC1"
 *   offset 8       format version (0x01)
 *   offset 9       body mode (0x00 raw, 0x01 zstd)
 *   offset 10..21  GCM nonce (random per write)
 *   offset 22..    AES-256-GCM ciphertext, final 16 bytes = auth tag
 *
 * Compression runs BEFORE encryption (GCM ciphertext is incompressible).
 * node:zlib gained zstd in Node 22.15; on older runtimes the mode byte
 * records a raw body so every supported version can still decrypt it.
 */

export const ENCRYPT_MAGIC = Buffer.from("BILIENC1", "utf8");
const FORMAT_VERSION = 0x01;
const MODE_RAW = 0x00;
const MODE_ZSTD = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = ENCRYPT_MAGIC.length + 2 + NONCE_LEN;
const MIN_ENCRYPTED_LEN = HEADER_LEN + TAG_LEN;

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

function zstdAvailable(): boolean {
    return typeof zlib.zstdCompressSync === "function" && typeof zlib.zstdDecompressSync === "function";
}

/** Build the StateStore codec for encrypted session files. decode() passes
 *  buffers without the magic through untouched (legacy plaintext), so mixed
 *  plaintext+encrypted trees load fine and the boot-time migration can peek
 *  the magic before rewriting. A decode failure (wrong key, corruption)
 *  throws and the kernel store treats the file as corrupt (warn + skip). */
export function createSessionCodec(key: Buffer): StateStoreCodec {
    return {
        encode(data: string): Buffer {
            const plain = Buffer.from(data, "utf8");
            const useZstd = zstdAvailable();
            const body = useZstd ? zlib.zstdCompressSync(plain) : plain;
            const nonce = randomBytes(NONCE_LEN);
            const cipher = createCipheriv("aes-256-gcm", key, nonce);
            const ct = Buffer.concat([cipher.update(body), cipher.final()]);
            return Buffer.concat([
                ENCRYPT_MAGIC,
                Buffer.from([FORMAT_VERSION, useZstd ? MODE_ZSTD : MODE_RAW]),
                nonce,
                ct,
                cipher.getAuthTag(),
            ]);
        },
        decode(buf: Buffer): string {
            if (buf.length < ENCRYPT_MAGIC.length || !buf.subarray(0, ENCRYPT_MAGIC.length).equals(ENCRYPT_MAGIC)) {
                return buf.toString("utf8");
            }
            if (buf.length < MIN_ENCRYPTED_LEN || buf[ENCRYPT_MAGIC.length] !== FORMAT_VERSION) {
                throw new Error(`[encrypt] unsupported session file format version ${buf[ENCRYPT_MAGIC.length]}`);
            }
            const mode = buf[ENCRYPT_MAGIC.length + 1];
            const nonce = buf.subarray(HEADER_LEN - NONCE_LEN, HEADER_LEN);
            const tag = buf.subarray(buf.length - TAG_LEN);
            const ct = buf.subarray(HEADER_LEN, buf.length - TAG_LEN);
            const decipher = createDecipheriv("aes-256-gcm", key, nonce);
            decipher.setAuthTag(tag);
            const body = Buffer.concat([decipher.update(ct), decipher.final()]);
            const plain = mode === MODE_ZSTD ? zlib.zstdDecompressSync(body) : body;
            return plain.toString("utf8");
        },
    };
}
