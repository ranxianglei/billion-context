import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/persist.ts";
import { createSessionCodec, ENCRYPT_MAGIC, parseEncryptionKey } from "../src/encrypt.ts";
import type { Session } from "../src/session.ts";
import { createInitialState } from "acp-kernel";

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
            rmSync(dir, { recursive: true, force: true });
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
    const codec = createSessionCodec(Buffer.from(KEY, "hex"));
    const other = createSessionCodec(Buffer.from(KEY_OTHER, "hex"));
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
    const codec = createSessionCodec(Buffer.from(KEY, "hex"));
    const json = '{"version":3,"id":"x"}';
    assert.equal(codec.decode(Buffer.from(json, "utf8")), json);
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

await withTempDir("boot migrates legacy plaintext files to encrypted in place", async (h) => {
    // Phase 1: legacy plaintext tree written by an unencrypted store.
    const legacy = newStore(h);
    await legacy.writeNow(makeSession("s-1"));
    await legacy.writeNow(makeSession("s-2"));
    legacy.cancelAll();

    // Phase 2: boot with the key — every unencoded file must be taken over.
    process.env.BILI_ENCRYPTION_KEY = KEY;
    const store = newStore(h);
    try {
        const loaded = await store.boot();
        assert.equal(loaded.size, 2, "both legacy sessions load");
        assert.ok(loaded.has("s-1") && loaded.has("s-2"));
        for (const id of ["s-1", "s-2"]) {
            const file = join(h.dir, "openai", "upstream_" + createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24) + ".json");
            const head = readFileSync(file).subarray(0, ENCRYPT_MAGIC.length);
            assert.ok(head.equals(ENCRYPT_MAGIC), `${id} file re-encoded in place`);
        }
        assert.ok(h.logs.some((l) => l.msg.includes("re-encoded 2 legacy session file(s)")), "migration logged");

        // Phase 3: second boot is a no-op (no double-wrap, no re-migration log).
        store.cancelAll();
        const logs2: LogLine[] = [];
        const again = new SessionStore({ dir: h.dir, debounceMs: 0, enabled: true, log: (level, msg) => logs2.push({ level, msg }) });
        try {
            const loaded2 = await again.boot();
            assert.equal(loaded2.size, 2, "still exactly 2 sessions — no double encoding");
            assert.ok(!logs2.some((l) => l.msg.includes("re-encoded")), "no migration on an already-encoded tree");
        } finally {
            again.cancelAll();
        }
    } finally {
        store.cancelAll();
    }
});

await withTempDir("migration covers spill-style .fb.json files and leaves corrupt files alone", async (h) => {
    mkdirSync(join(h.dir, "openai"), { recursive: true });
    const spill = join(h.dir, "openai", "s-spill.fb.json");
    writeFileSync(spill, JSON.stringify({ version: 3, savedAt: Date.now(), id: "s-spill", payload: {} }), "utf8");
    const corrupt = join(h.dir, "openai", "garbage_deadbeef.json");
    writeFileSync(corrupt, "%%% not json %%%", "utf8");

    process.env.BILI_ENCRYPTION_KEY = KEY;
    const store = newStore(h);
    try {
        const loaded = await store.boot();
        assert.equal(loaded.size, 0, "neither fake file is a valid session record");
        assert.ok(readFileSync(spill).subarray(0, ENCRYPT_MAGIC.length).equals(ENCRYPT_MAGIC), "spill file re-encoded");
        assert.equal(readFileSync(corrupt, "utf8"), "%%% not json %%%", "unreadable file left in place");
        assert.ok(h.logs.some((l) => l.level === "warn" && l.msg.includes("leaving unreadable file in place")));
    } finally {
        store.cancelAll();
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

await withTempDir("without a key, files stay plaintext (zero behavior change)", async (h) => {
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
