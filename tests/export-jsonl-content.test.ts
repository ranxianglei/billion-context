import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStoredPlaceholder, createInitialState } from "acp-kernel";
import { exportSession, renderSessionJsonlFromTables } from "../src/export.ts";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { SqliteBackend } from "../src/storage/backend.ts";
import { planIngest } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

function session(): Session {
    return {
        id: "jsonl-content", meta: { title: "Historical content", protocol: "responses" },
        stats: { requests: 1, tokensSaved: 0, inputTokens: 10, cachedTokens: 0, outputTokens: 0,
            cacheSamples: 0, lastInputTokens: 10, contextTokens: 10, compressCreditTokens: 0,
            retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {}, createdAt: 1, lastSeen: 2, state: createInitialState(), pendingRetrievals: [],
        blockContents: new Map(), inFlight: 0, persisted: false, lastMessagesFolded: false,
        lastMessages: [
            { id: "historical", role: "user", contentType: "text", text: "old content" },
            { id: "current", role: "user", contentType: "text", text: "current prompt" },
        ],
    };
}

function plan(value: Session) {
    return planIngest({ ...value, meta: { ...value.meta }, stats: { ...value.stats }, state: { ...value.state } });
}

function seed(store: UnifiedStore, value: Session, raw: string, retired: boolean): void {
    const initial = plan(value);
    const historical = initial.messages[0]!;
    historical.content = raw;
    delete historical.contentHash;
    delete historical.identity;
    store.ingestSession(initial, undefined, { completeLog: true });
    if (retired) {
        value.lastMessages = value.lastMessages!.slice(1);
        value.stats.requests++;
        store.ingestSession(plan(value), undefined, { completeLog: true });
        assert.ok(store.getMessages(value.id, { includeRetired: true })[0]!.retiredAt != null);
    }
}

function records(text: string): Record<string, unknown>[] {
    return text.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

for (const [name, raw, expected] of [
    ["null", "null", null],
    ["whitespace-padded null", " \nnull\t", null],
    ["boolean", "false", false],
    ["number", "42", 42],
    ["string", '"saved text"', "saved text"],
    ["array", '[{"text":"nested"}]', [{ text: "nested" }]],
    ["object without text", '{"text":null,"metadata":{"saved":true}}', { text: null, metadata: { saved: true } }],
    ["invalid JSON", "incomplete {", { raw: "incomplete {" }],
] as const) {
    test(`full table export preserves ${name} content and subsequent messages`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "jsonl-content-"));
        const store = UnifiedStore.open(join(dir, "index.db"));
        try {
            const value = session();
            seed(store, value, raw, false);
            const before = store.getMessages(value.id, { includeRetired: true });
            const output = records(await renderSessionJsonlFromTables(new SqliteBackend(store), value.id, true));
            assert.equal(output[0]!.source, "unified");
            const messages = output.filter((line) => line.type === "message");
            assert.equal(messages.length, 2);
            assert.deepEqual(messages[0]!.message, expected);
            assert.deepEqual(messages[1]!.message, value.lastMessages![1]);
            assert.deepEqual(store.getMessages(value.id, { includeRetired: true }), before);
        } finally {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
}

for (const full of [false, true]) {
    test(`public JSONL export retains a retired null row with full=${full}`, async () => {
        const previous = process.env.BILI_STORAGE_UNIFIED;
        process.env.BILI_STORAGE_UNIFIED = "legacy";
        const dir = mkdtempSync(join(tmpdir(), "jsonl-retired-content-"));
        const store = UnifiedStore.open(join(dir, "index.db"));
        const persisted = new SessionStore({ dir, enabled: true, debounceMs: 0 });
        try {
            const value = session();
            seed(store, value, "null", true);
            const before = store.getMessages(value.id, { includeRetired: true });
            await persisted.writeNow(value);
            const output = join(dir, "export.jsonl");
            assert.equal(await exportSession(value.id, { dir, jsonl: true, full, output }), `written to ${output}`);
            const lines = records(readFileSync(output, "utf8"));
            assert.equal(lines[0]!.source, "unified", "a readable index must not degrade to its shorter live tail");
            const messages = lines.filter((line) => line.type === "message");
            assert.deepEqual(messages.map((line) => line.rawId), ["historical", "current"]);
            assert.equal(messages[0]!.message, null);
            assert.equal(messages[0]!.retiredAt, before[0]!.retiredAt);
            assert.equal(messages[1]!.retiredAt, undefined);
            assert.deepEqual(messages[1]!.message, value.lastMessages![0]);
            assert.deepEqual(store.getMessages(value.id, { includeRetired: true }), before);
        } finally {
            persisted.closeQuietly();
            store.close();
            rmSync(dir, { recursive: true, force: true });
            if (previous === undefined) delete process.env.BILI_STORAGE_UNIFIED;
            else process.env.BILI_STORAGE_UNIFIED = previous;
        }
    });
}

test("full export still resolves object placeholders after a non-object row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jsonl-content-ccr-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    try {
        const value = session();
        const placeholder = buildStoredPlaceholder({ ref: "m00002", kind: "file read", tokens: 5, head: "head", retrieveToolName: "acp_retrieve" });
        value.lastMessages![1]!.text = placeholder;
        seed(store, value, "null", false);
        const ccr = new Map([["m00002", "original content\nwith Unicode 日本語"]]);
        for (const full of [false, true]) {
            const output = records(await renderSessionJsonlFromTables(new SqliteBackend(store), value.id, full, ccr));
            const messages = output.filter((line) => line.type === "message");
            assert.equal(messages[0]!.message, null);
            assert.deepEqual(messages[1]!.message, full
                ? { ...value.lastMessages![1], text: ccr.get("m00002"), dereferencedFrom: "m00002" }
                : value.lastMessages![1]);
        }
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
