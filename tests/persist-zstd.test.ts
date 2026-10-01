import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { SessionStore } from "../src/persist.ts";
import { createStorageCodec, ENCRYPT_MAGIC, ZSTD_MAGIC, _setZstdAvailableForTest } from "../src/encrypt.ts";
import type { Session } from "../src/session.ts";
import { createInitialState } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

const KEY = randomBytes(32).toString("hex");

// Static zstd frame produced by node:zlib zstdCompressSync; decoding it with
// the hook forced off exercises the bundled fzstd fallback for good.
const ZSTD_FIXTURE_B64 = "KLUv/SAlKQEAYWNwLWtlcm5lbC1maXh0dXJlLXBheWxvYWQtMDEyMzQ1Njc4OQ==";
const ZSTD_FIXTURE_PLAIN = "acp-kernel-fixture-payload-0123456789";

const NATIVE_ZSTD = typeof zlib.zstdCompressSync === "function" && typeof zlib.zstdDecompressSync === "function";

type LogLine = { level: string; msg: string };

function makeSession(id: string, fill = 0, fillRandom = false): Session {
    return {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://upstream" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: fill > 0 ? { fill: fillRandom ? randomBytes(fill).toString("hex") : "x".repeat(fill) } : {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

interface Harness {
    dir: string;
    logs: LogLine[];
}

async function withTempDir(name: string, fn: (h: Harness) => Promise<void>): Promise<void> {
    await test(name, async () => {
        const dir = mkdtempSync(join(tmpdir(), "bili-zstd-"));
        const logs: LogLine[] = [];
        const h = { dir, logs };
        try {
            await fn(h);
        } finally {
            delete process.env.BILI_ENCRYPTION_KEY;
            delete process.env.BILI_PERSIST_ZSTD;
            _setZstdAvailableForTest(null);
            rmrf(dir);
        }
    });
}

function newStore(h: Harness, debounceMs = 0): SessionStore {
    return new SessionStore({
        dir: h.dir,
        debounceMs,
        enabled: true,
        log: (level, msg) => h.logs.push({ level, msg }),
    });
}

function filePath(dir: string, id: string): string {
    return join(dir, "openai", "upstream_" + createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24) + ".json");
}

test("codec: plain roundtrip is deterministic and carries the BILIZSTD1 header", () => {
    const codec = createStorageCodec({ compress: true })!;
    // Compressible payload large enough that framing strictly shrinks it (the
    // size guard frames only when compression actually wins).
    const json = JSON.stringify({ hello: "world ".repeat(400) });
    const enc = Buffer.from(codec.encode(json));
    assert.ok(enc.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC), "magic prefix");
    assert.equal(enc[9], 0x01, "format version byte");
    assert.equal(codec.decode(enc), json, "roundtrip");
    assert.deepEqual(Buffer.from(codec.encode(json)), enc, "no nonce -> deterministic bytes");
});

test("codec: config matrix — plain JSON by default, key or opt-in produce a codec", () => {
    assert.equal(createStorageCodec({}), undefined, "default opts: no key, no compression -> plain JSON");
    assert.equal(createStorageCodec({ compress: false }), undefined);
    assert.equal(createStorageCodec({ key: null, compress: false }), undefined);
    assert.ok(createStorageCodec({ key: randomBytes(32) }), "key alone");
    assert.ok(createStorageCodec({ compress: true }), "compression alone");
});

test("codec: legacy plaintext passthrough + magic dispatch across trees", () => {
    const plain = createStorageCodec({ compress: true })!;
    const keyed = createStorageCodec({ key: Buffer.from(KEY, "hex") })!;
    const json = JSON.stringify({ a: 1 });
    assert.equal(plain.decode(Buffer.from(json, "utf8")), json, "legacy plaintext passes through");
    const zBuf = Buffer.from(plain.encode(json));
    assert.equal(keyed.decode(zBuf), json, "keyed codec still reads unencrypted BILIZSTD1 files");
    const eBuf = Buffer.from(keyed.encode(json));
    assert.ok(eBuf.subarray(0, 8).equals(ENCRYPT_MAGIC));
    assert.throws(() => plain.decode(eBuf), /BILI_ENCRYPTION_KEY/, "reading encrypted without a key says exactly that");
});

test("codec: key + explicit compression keeps BILIENC1 in zstd mode (#708 behavior)", () => {
    if (!NATIVE_ZSTD) return;
    const keyed = createStorageCodec({ key: Buffer.from(KEY, "hex"), compress: true })!;
    const json = JSON.stringify({ a: "value ".repeat(500) });
    const enc = Buffer.from(keyed.encode(json));
    assert.ok(enc.subarray(0, ENCRYPT_MAGIC.length).equals(ENCRYPT_MAGIC));
    assert.equal(enc[8], 0x01, "format version");
    assert.equal(enc[9], 0x01, "mode byte records the zstd body");
    assert.equal(keyed.decode(enc), json);
    // Key alone defaults to an unframed raw body (compression is opt-in).
    const keyedDefault = createStorageCodec({ key: Buffer.from(KEY, "hex") })!;
    const encRaw = Buffer.from(keyedDefault.encode(json));
    assert.equal(encRaw[9], 0x00, "key alone -> raw body mode byte");
    assert.equal(keyedDefault.decode(encRaw), json);
});

test("fzstd fallback decodes node:zlib frames (static fixture)", () => {
    _setZstdAvailableForTest(false);
    try {
        const codec = createStorageCodec({ compress: true })!;
        const body = Buffer.from(ZSTD_FIXTURE_B64, "base64");
        const frame = Buffer.concat([ZSTD_MAGIC, Buffer.from([0x01, 0x01]), body]);
        assert.equal(codec.decode(frame), ZSTD_FIXTURE_PLAIN);
    } finally {
        _setZstdAvailableForTest(null);
    }
});

withTempDir("store: BILI_PERSIST_ZSTD=1 writes BILIZSTD1 and loads it back", async (h) => {
    process.env.BILI_PERSIST_ZSTD = "1";
    const store = newStore(h);
    await store.writeNow(makeSession("s-z"));
    store.cancelAll();
    const buf = readFileSync(filePath(h.dir, "s-z"));
    assert.ok(buf.subarray(0, 9).equals(ZSTD_MAGIC), "file on disk starts with BILIZSTD1");
    const loaded = await newStore(h).boot();
    assert.ok(loaded.has("s-z"), "loads back through the same codec");
    assert.ok(h.logs.some((l) => l.msg.includes("compression enabled")), "boot logs the opt-in codec");
});

withTempDir("store: default (env unset) writes bare JSON and loads it back", async (h) => {
    const store = newStore(h);
    await store.writeNow(makeSession("s-def"));
    store.cancelAll();
    const text = readFileSync(filePath(h.dir, "s-def"), "utf8");
    assert.equal(text[0], "{", "default stays plain JSON (compression is opt-in)");
    const loaded = await newStore(h).boot();
    assert.equal(loaded.size, 1);
    assert.ok(!h.logs.some((l) => l.msg.includes("compression enabled")));
});

withTempDir("store: large session shrinks vs the default plain-JSON baseline", async (h) => {
    if (!NATIVE_ZSTD) return;
    process.env.BILI_PERSIST_ZSTD = "1";
    const big = makeSession("s-big", 20_000);
    big.blockContents.set("b1", "acp-block-summary-content ".repeat(20_000));
    const first = newStore(h);
    await first.writeNow(big);
    first.cancelAll();
    const compressedSize = statSync(filePath(h.dir, "s-big")).size;
    process.env.BILI_PERSIST_ZSTD = "0";
    const second = newStore(h);
    await second.writeNow(big);
    second.cancelAll();
    const plainSize = statSync(filePath(h.dir, "s-big")).size;
    assert.ok(compressedSize * 4 < plainSize, `zstd ${compressedSize}B must beat plain ${plainSize}B`);
});

withTempDir("store: BILI_PERSIST_ZSTD=0 keeps files as plain JSON", async (h) => {
    process.env.BILI_PERSIST_ZSTD = "0";
    const store = newStore(h);
    await store.writeNow(makeSession("s-plain"));
    store.cancelAll();
    const text = readFileSync(filePath(h.dir, "s-plain"), "utf8");
    assert.equal(text[0], "{", "opt-out writes raw JSON");
    const loaded = await newStore(h).boot();
    assert.equal(loaded.size, 1);
    assert.ok(!h.logs.some((l) => l.msg.includes("compression enabled")));
});

withTempDir("store: opted-in runtime without native zstd falls back to unframed plain JSON", async (h) => {
    process.env.BILI_PERSIST_ZSTD = "1";
    _setZstdAvailableForTest(false);
    const store = newStore(h);
    await store.writeNow(makeSession("s-oldrt"));
    store.cancelAll();
    const buf = readFileSync(filePath(h.dir, "s-oldrt"));
    assert.equal(buf[0], 0x7b, `bare JSON, got head ${buf.subarray(0, 9).toString("utf8")}`);
    assert.ok(JSON.parse(buf.toString("utf8")), "parses as plain JSON");
    const loaded = await newStore(h).boot();
    assert.equal(loaded.size, 1, "plain file roundtrips");
});

withTempDir("store: old runtime reads files written by a newer one (fzstd path)", async (h) => {
    if (!NATIVE_ZSTD) return;
    process.env.BILI_PERSIST_ZSTD = "1";
    const writer = newStore(h);
    await writer.writeNow(makeSession("s-new"));
    writer.cancelAll();
    const buf = readFileSync(filePath(h.dir, "s-new"));
    assert.equal(buf[10], 0x01, "writer used the zstd body");
    _setZstdAvailableForTest(false);
    const loaded = await newStore(h).boot();
    assert.equal(loaded.size, 1, "fallback decoder handles the zstd body");
});

withTempDir("boot NEVER rewrites legacy plaintext files (downgrade safety, #1080 review)", async (h) => {
    const legacy = newStore(h);
    await legacy.writeNow(makeSession("s-1"));
    await legacy.writeNow(makeSession("s-2"));
    legacy.cancelAll();
    process.env.BILI_PERSIST_ZSTD = "1";
    const before = h.logs.length;
    const store = newStore(h);
    const loaded = await store.boot();
    assert.equal(loaded.size, 2, "both legacy sessions load under the compression-enabled codec");
    for (const id of ["s-1", "s-2"]) {
        const raw = readFileSync(filePath(h.dir, id));
        assert.ok(raw[0] === 0x7b /* '{' */, `${id} still plain JSON on disk after boot`);
        JSON.parse(raw.toString("utf8"));
    }
    assert.ok(!h.logs.slice(before).some((l) => l.msg.includes("re-encoded")), "no mass rewrite logged");
    store.cancelAll();
    // Organic conversion: the next real save re-encodes that one file.
    await store.writeNow(makeSession("s-1", 8_000));
    store.cancelAll();
    assert.ok(readFileSync(filePath(h.dir, "s-1")).subarray(0, 9).equals(ZSTD_MAGIC), "next save converts organically");
    assert.ok(readFileSync(filePath(h.dir, "s-2"))[0] === 0x7b, "untouched file stays plaintext");
});

withTempDir("mixed tree: legacy plaintext and BILIZSTD1 coexist until boot", async (h) => {
    const legacy = newStore(h);
    await legacy.writeNow(makeSession("s-old"));
    legacy.cancelAll();
    process.env.BILI_PERSIST_ZSTD = "1";
    const store = newStore(h);
    await store.writeNow(makeSession("s-new", 4_000));
    store.cancelAll();
    const loaded = await newStore(h).boot();
    assert.ok(loaded.has("s-old") && loaded.has("s-new"), "both formats readable in one tree");
    assert.ok(readFileSync(filePath(h.dir, "s-old"))[0] === 0x7b, "legacy side stays plaintext (no boot rewrite)");
    assert.ok(readFileSync(filePath(h.dir, "s-new")).subarray(0, 9).equals(ZSTD_MAGIC));
});

withTempDir("keyed boot leaves BILIZSTD1 files untouched and readable", async (h) => {
    process.env.BILI_PERSIST_ZSTD = "1";
    const store = newStore(h);
    await store.writeNow(makeSession("s-z"));
    store.cancelAll();
    const before = readFileSync(filePath(h.dir, "s-z"));
    process.env.BILI_ENCRYPTION_KEY = KEY;
    const loaded = await newStore(h).boot();
    assert.ok(loaded.has("s-z"), "unencrypted file loads fine under an encryption-enabled boot");
    assert.deepEqual(readFileSync(filePath(h.dir, "s-z")), before, "migration never rewrites what it can already read");
});

withTempDir("no-key boot reports BILIENC1 files as unreadable instead of corrupt garbage", async (h) => {
    process.env.BILI_PERSIST_ZSTD = "1";
    process.env.BILI_ENCRYPTION_KEY = KEY;
    const writer = newStore(h);
    await writer.writeNow(makeSession("s-secret"));
    writer.cancelAll();
    delete process.env.BILI_ENCRYPTION_KEY;
    const reader = newStore(h);
    const loaded = await reader.boot();
    assert.equal(loaded.has("s-secret"), false, "undecodable file is skipped");
    assert.ok(
        h.logs.some((l) => l.level === "warn" && l.msg.includes("BILI_ENCRYPTION_KEY")),
        h.logs.map((l) => l.level + " " + l.msg).join("\n"),
    );
    assert.ok(readFileSync(filePath(h.dir, "s-secret")).subarray(0, 8).equals(ENCRYPT_MAGIC), "file left untouched");
});

withTempDir("decoupling: key + BILI_PERSIST_ZSTD=0 keeps BILIENC1 with a raw body", async (h) => {
    process.env.BILI_ENCRYPTION_KEY = KEY;
    process.env.BILI_PERSIST_ZSTD = "0";
    const store = newStore(h);
    await store.writeNow(makeSession("s-rawenc"));
    store.cancelAll();
    const buf = readFileSync(filePath(h.dir, "s-rawenc"));
    assert.ok(buf.subarray(0, 8).equals(ENCRYPT_MAGIC));
    assert.equal(buf[8], 0x01, "format version");
    assert.equal(buf[9], 0x00, "mode byte records the raw body");
    const reloaded = newStore(h).loadSync("s-rawenc", { protocol: "openai", upstreamOrigin: "http://upstream" });
    assert.ok(reloaded, "raw-body encrypted file roundtrips");
});

test("codec: payloads that do not shrink stay unframed plain JSON (size guard)", () => {
    const codec = createStorageCodec({ compress: true })!;
    // Small enough that zstd framing (magic + header + frame overhead)
    // cannot beat the bare payload — the guard must return it verbatim.
    const tiny = JSON.stringify({ hello: "world", n: [1, 2, 3] });
    const enc = Buffer.from(codec.encode(tiny));
    assert.equal(enc[0], 0x7b, `bare JSON head, got ${enc.subarray(0, 9).toString("utf8")}`);
    assert.equal(enc.toString("utf8"), tiny, "byte-identical plaintext (no framing)");
    assert.equal(codec.decode(enc), tiny, "decode accepts unframed plaintext");
    // And the store still round-trips such a file (loadAll -> decode -> JSON).
    const big = "x".repeat(20_000);
    assert.notEqual(Buffer.from(codec.encode(big)).subarray(0, 9).toString("utf8"), big.slice(0, 9), "compressible payload still frames");
});
