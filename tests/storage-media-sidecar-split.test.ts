/**
 * #4069 / #4242: raw wire sidecars (rawOpenaiContent & friends) used to carry
 * the original image payload a SECOND time as a data URL, capping media CAS
 * dedup at ~1.89×. The split now swaps every payload ≥2 KiB for its CAS hash
 * and hydration restores it byte-identically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createInitialState } from "acp-kernel";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_CONFIG_FILE = join(mkdtempSync(join(tmpdir(), "msplit-")), "missing.json");

const BIG = "QUJD".repeat(700); // 2800 base64 chars ≥ 2048 — gets split
const BIG_HASH = createHash("sha256").update(BIG).digest("hex");
const URL = `data:image/png;base64,${BIG}`;

function sha256(s: string): string {
    return createHash("sha256").update(s).digest("hex");
}

function sessionOf(id: string, messages: unknown[]): LegacySessionLike {
    const state = { ...createInitialState(), requests: messages.length };
    return {
        id,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        meta: { label: id, protocol: "openai", upstreamOrigin: "https://api.openai.com" },
        stats: { requests: messages.length },
        metadata: { pluginAgent: "dsh" },
        state: state as never,
        blockContents: new Map(),
        lastMessages: messages as never,
        lastMessagesFolded: false,
    };
}

test("#4069: raw-sidecar data URLs ride the media CAS and hydrate byte-identically", () => {
    const original = JSON.stringify({
        id: "m00001",
        role: "user",
        contentType: "text",
        text: "look at this",
        wireIndex: 0,
        rawOpenaiContent: { type: "image_url", image_url: { url: URL } },
    });
    const dir = mkdtempSync(join(tmpdir(), "msp-"));
    try {
        const store = UnifiedStore.open(join(dir, "index.db"));
        const plan = planIngest(sessionOf("media-split-1", [JSON.parse(original)]));

        // 1. the plan's stored content no longer embeds the payload
        const entry = (plan.messages as unknown as { content: string }[])[0];
        assert.ok(!entry.content.includes(BIG), "payload is not stored inline");
        assert.ok(entry.content.includes(`data:image/png;base64,{$media:${BIG_HASH}}`), "marker carries the CAS hash");
        assert.deepEqual(
            (plan.messages as unknown as { media?: { hash: string }[] }[])[0].media?.map((m) => m.hash),
            [BIG_HASH],
            "media rides the plan",
        );

        // 2. ingest: payload lands in the CAS exactly once
        store.ingestSession(plan);
        const raw = (
            store as unknown as { db: { prepare: (q: string) => { all: () => { bytes?: string; refcount?: number }[] } } }
        ).db.prepare("SELECT bytes, refcount FROM content").all();
        assert.equal(raw.filter((r) => Buffer.from(r.bytes as unknown as Uint8Array).toString() === BIG).length, 1, "payload CAS row exists exactly once");

        // 3. hydrate: round-trip is byte-identical
        const msgs = store.getMessages("media-split-1");
        assert.equal(msgs.length, 1);
        assert.equal(msgs[0].content, original, "hydrated content is byte-identical to the original");

        // 4. dedup: the same payload as a top-level imageBase64 hits the SAME row
        const second = JSON.stringify({
            id: "m00002",
            role: "user",
            contentType: "text",
            text: "same image again",
            wireIndex: 0,
            imageBase64: BIG,
        });
        store.ingestSession(planIngest(sessionOf("media-split-2", [JSON.parse(second)])));
        const after = (
            store as unknown as { db: { prepare: (q: string) => { all: () => { bytes?: string; refcount?: number }[] } } }
        ).db.prepare("SELECT bytes, refcount FROM content").all();
        const payloadRows = after.filter((r) => Buffer.from(r.bytes as unknown as Uint8Array).toString() === BIG);
        assert.equal(payloadRows.length, 1, "shared payload stays one CAS row");
        assert.equal(payloadRows[0].refcount, 2, "refcount covers both messages");

        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#4069: small payloads (<2 KiB) stay inline — no CAS row, no join", () => {
    const small = "QUJD".repeat(100); // 400 chars < 2048
    const original = JSON.stringify({
        id: "m00001",
        role: "user",
        contentType: "text",
        text: "tiny icon",
        wireIndex: 0,
        rawOpenaiContent: { type: "image_url", image_url: { url: `data:image/png;base64,${small}` } },
    });
    const dir = mkdtempSync(join(tmpdir(), "mss-"));
    try {
        const store = UnifiedStore.open(join(dir, "index.db"));
        const plan = planIngest(sessionOf("media-split-small", [JSON.parse(original)]));
        const entry = (plan.messages as unknown as { content: string; media?: unknown[] }[])[0];
        assert.ok(entry.content.includes(small), "small payload stays inline");
        assert.equal(entry.media, undefined, "no media entries for small payloads");
        store.ingestSession(plan);
        assert.equal(store.getMessages("media-split-small")[0].content, original);
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
