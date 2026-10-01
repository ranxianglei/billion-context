import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/persist.ts";
import { createStorageCodec, ENCRYPT_MAGIC, parseEncryptionKey } from "../src/encrypt.ts";
import type { Session } from "../src/session.ts";
import { createInitialState } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

const KEY = randomBytes(32).toString("hex");
const KEY_OTHER = randomBytes(32).toString("hex");

type LogLine = { level: string; msg: string };

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://upstream" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
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
        const dir = mkdtempSync(join(tmpdir(), "bili-encrypt-"));
        const logs: LogLine[] = [];
        const h = { dir, logs };
        try {
            await fn(h);
        } finally {
            delete process.env.BILI_ENCRYPTION_KEY;
            delete process.env.BILI_PERSIST_ZSTD;
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

test("parseEncryptionKey accepts hex and base64, rejects everything else", () => {
    const raw = randomBytes(32);
    assert.deepEqual(parseEncryptionKey(raw.toString("hex")), raw);
    assert.deepEqual(parseEncryptionKey(raw.toString("base64")), raw);
    assert.throws(() => parseEncryptionKey("beef"), /exactly 32 bytes/);
    assert.throws(() => parseEncryptionKey(""), /exactly 32 bytes/);
    assert.throws(() => parseEncryptionKey("!!!not-a-key!!!"), /exactly 32 bytes/);
    assert.throws(() => parseEncryptionKey(randomBytes(31).toString("hex")), /exactly 32 bytes/);
});

test("codec: roundtrip, magic prefix, per-write nonce, tamper and wrong-key rejection", () => {
    const codec = createStorageCodec({ key: Buffer.from(KEY, "hex") })!;
    const other = createStorageCodec({ key: Buffer.from(KEY_OTHER, "hex") })!;
    const json = JSON.stringify({ hello: "world", n: [1, 2, 3] });

    const enc = Buffer.isBuffer(codec.encode(json)) ? codec.encode(json) : Buffer.from(codec.encode(json));
    assert.ok(enc.subarray(0, ENCRYPT_MAGIC.length).equals(ENCRYPT_MAGIC), "file starts with BILIENC1 magic");
    assert.equal(codec.decode(enc), json);

    const enc2 = Buffer.from(codec.encode(json));
    assert.notDeepEqual(enc, enc2, "random nonce per write");
    assert.equal(codec.decode(enc2), json);

    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(() => codec.decode(tampered), undefined, "tampered tag must throw");
    assert.throws(() => other.decode(enc), undefined, "wrong key must throw");
});

test("codec passes legacy plaintext through untouched", () => {
    const codec = createStorageCodec({ key: Buffer.from(KEY, "hex") })!;
    const plain = JSON.stringify({ version: 3, savedAt: 1, id: "s", payload: { protocol: "openai" } });
    assert.equal(codec.decode(Buffer.from(plain, "utf8")), plain);
});

await withTempDir("writes are encrypted on disk when the key is set", async (h) => {
    process.env.BILI_ENCRYPTION_KEY = KEY;
    const store = newStore(h);
    try {
        await store.writeNow(makeSession("s-enc"));
        const file = join(h.dir, "openai", "upstream_" + createHash("sha256").update("s-enc", "utf8").digest("hex").slice(0, 24) + ".json");
        const head = readFileSync(file).subarray(0, ENCRYPT_MAGIC.length);
        assert.ok(head.equals(ENCRYPT_MAGIC), "on-disk file is BILIENC1-encrypted");
        const reloaded = store.loadSync("s-enc", { protocol: "openai", upstreamOrigin: "http://upstream" });
        assert.ok(reloaded, "session still loads through the codec");
        assert.ok(h.logs.some((l) => l.msg.includes("encryption enabled")));
    } finally {
        store.cancelAll();
    }
});

await withTempDir("boot never rewrites legacy plaintext files (downgrade safety)", async (h) => {
    // Phase 1: pre-#1080 plaintext tree (zstd opt-out = what older bili wrote).
    process.env.BILI_PERSIST_ZSTD = "0";
    const legacy = newStore(h);
    await legacy.writeNow(makeSession("s-1"));
    await legacy.writeNow(makeSession("s-2"));
    legacy.cancelAll();
    delete process.env.BILI_PERSIST_ZSTD;

    // Phase 2: boot with the key — files must load but stay byte-identical
    // plaintext. A boot-time mass rewrite (the #1083 draft) makes a
    // downgrade destroy history: old bili reads its own framing as
    // "corrupt", resumes into an empty session, and the next save
    // overwrites the real one.
    process.env.BILI_ENCRYPTION_KEY = KEY;
    const store = newStore(h);
    try {
        const loaded = await store.boot();
        assert.equal(loaded.size, 2, "both legacy sessions load through the codec fallback");
        assert.ok(loaded.has("s-1") && loaded.has("s-2"));
        for (const id of ["s-1", "s-2"]) {
            const file = join(h.dir, "openai", "upstream_" + createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24) + ".json");
            const head = readFileSync(file).subarray(0, ENCRYPT_MAGIC.length);
            assert.ok(!head.equals(ENCRYPT_MAGIC), `${id} file left untouched by boot`);
        }
        assert.ok(!h.logs.some((l) => l.msg.includes("re-encoded")), "no migration log");

        // Phase 3: organic conversion — the next real save of s-1 encodes it;
        // s-2 stays plaintext until it is saved too. Second boot loads both.
        await store.writeNow(loaded.get("s-1")!);
        store.cancelAll();
        const f1 = join(h.dir, "openai", "upstream_" + createHash("sha256").update("s-1", "utf8").digest("hex").slice(0, 24) + ".json");
        assert.ok(readFileSync(f1).subarray(0, ENCRYPT_MAGIC.length).equals(ENCRYPT_MAGIC), "s-1 converts on its next save");
        const again = newStore(h);
        try {
            const loaded2 = await again.boot();
            assert.equal(loaded2.size, 2, "mixed-format tree loads together");
        } finally {
            again.cancelAll();
        }
    } finally {
        store.cancelAll();
        delete process.env.BILI_ENCRYPTION_KEY;
    }
});

await withTempDir("boot leaves foreign and corrupt files alone (no rewrites, no crashes)", async (h) => {
    mkdirSync(join(h.dir, "openai"), { recursive: true });
    const spill = join(h.dir, "openai", "s-spill.fb.json");
    const spillBody = JSON.stringify({ version: 3, savedAt: Date.now(), id: "s-spill", payload: {} });
    writeFileSync(spill, spillBody, "utf8");
    const corrupt = join(h.dir, "openai", "garbage_deadbeef.json");
    writeFileSync(corrupt, "%%% not json %%%", "utf8");

    process.env.BILI_ENCRYPTION_KEY = KEY;
    const store = newStore(h);
    try {
        const loaded = await store.boot();
        assert.equal(loaded.size, 0, "neither fake file is a valid session record");
        assert.equal(readFileSync(spill, "utf8"), spillBody, "foreign spill file byte-identical");
        assert.equal(readFileSync(corrupt, "utf8"), "%%% not json %%%", "unreadable file left in place");
    } finally {
        store.cancelAll();
        delete process.env.BILI_ENCRYPTION_KEY;
    }
});

await withTempDir("boot sweeps orphaned .tmp-enc-* temps left by a crashed write", async (h) => {
    // Pre-#1080 plaintext file (zstd opt-out), same as what older bili wrote.
    process.env.BILI_PERSIST_ZSTD = "0";
    const legacy = newStore(h);
    await legacy.writeNow(makeSession("s-crash"));
    legacy.cancelAll();
    delete process.env.BILI_PERSIST_ZSTD;

    // Simulate a process death between the temp write and the rename: a
    // stale temp sits next to an unencoded legacy file.
    const file = join(h.dir, "openai", "upstream_" + createHash("sha256").update("s-crash", "utf8").digest("hex").slice(0, 24) + ".json");
    const orphan = `${file}.tmp-enc-99999-1700000000000`;
    writeFileSync(orphan, "stale temp from a crashed write");

    process.env.BILI_ENCRYPTION_KEY = KEY;
    const store = newStore(h);
    try {
        const loaded = await store.boot();
        assert.equal(loaded.size, 1, "legacy session loads");
        assert.ok(!readFileSync(file).subarray(0, ENCRYPT_MAGIC.length).equals(ENCRYPT_MAGIC), "legacy file NOT rewritten by boot");
        assert.equal(existsSync(orphan), false, "orphaned temp swept on next boot");
    } finally {
        store.cancelAll();
        delete process.env.BILI_ENCRYPTION_KEY;
    }
});

await withTempDir("an encrypted tree booted with the WRONG key loses those sessions as corrupt (no crash)", async (h) => {
    process.env.BILI_ENCRYPTION_KEY = KEY;
    const writer = newStore(h);
    await writer.writeNow(makeSession("s-secret"));
    writer.cancelAll();

    process.env.BILI_ENCRYPTION_KEY = KEY_OTHER;
    const reader = newStore(h);
    try {
        const loaded = await reader.boot();
        assert.equal(loaded.has("s-secret"), false, "wrong key -> auth failure -> corrupt-file skip");
    } finally {
        reader.cancelAll();
    }
});

await withTempDir("invalid key fails fast at construction", async (h) => {
    process.env.BILI_ENCRYPTION_KEY = "beef";
    assert.throws(() => newStore(h), /BILI_ENCRYPTION_KEY.*exactly 32 bytes/);
});

await withTempDir("without a key and zstd opted out, files stay plaintext", async (h) => {
    process.env.BILI_PERSIST_ZSTD = "0";
    const store = newStore(h);
    try {
        await store.writeNow(makeSession("s-plain"));
        const file = join(h.dir, "openai", "upstream_" + createHash("sha256").update("s-plain", "utf8").digest("hex").slice(0, 24) + ".json");
        assert.equal(readFileSync(file, "utf8")[0], "{", "plain JSON on disk");
        const loaded = await store.boot();
        assert.equal(loaded.size, 1);
        assert.ok(!h.logs.some((l) => l.msg.includes("encryption enabled")));
    } finally {
        store.cancelAll();
    }
});
