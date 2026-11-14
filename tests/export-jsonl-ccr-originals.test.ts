import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

const REF = "m00002";
const PLACEHOLDER = buildStoredPlaceholder({ ref: REF, kind: "file read", tokens: 7, head: "original head", retrieveToolName: "acp_retrieve" });

function session(original: string): Session {
    const hash = createHash("sha256").update(original).digest("hex");
    return {
        id: "jsonl-ccr-originals", meta: { protocol: "responses", title: "Original export" },
        stats: { requests: 1, tokensSaved: 0, inputTokens: 10, cachedTokens: 0, outputTokens: 0,
            cacheSamples: 0, lastInputTokens: 10, contextTokens: 10, compressCreditTokens: 0,
            retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {}, createdAt: 1, lastSeen: 2, state: createInitialState(), pendingRetrievals: [],
        blockContents: new Map(), inFlight: 0, persisted: false, lastMessagesFolded: false,
        lastMessages: [{ id: "original-message", role: "user", contentType: "text", text: PLACEHOLDER }],
        contentStore: {
            version: 1,
            byHash: { [hash]: original },
            byRef: { [REF]: { hash, rawId: "original-message", kind: "file read", tokens: 7, chars: original.length, head: "original head" } },
        },
        contentStoreDirty: true,
    };
}

function plan(value: Session) {
    return planIngest({ ...value, meta: { ...value.meta }, stats: { ...value.stats }, state: { ...value.state } });
}

function records(text: string): Record<string, unknown>[] {
    return text.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function message(text: string): Record<string, unknown> {
    return records(text).find((line) => line.type === "message")!.message as Record<string, unknown>;
}

for (const original of ["the complete original", "\r\n日本語 😀 \"quoted\"\n\t", ""]) {
    test(`full table export resolves the original bytes for ${JSON.stringify(original)}`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "jsonl-ccr-bytes-"));
        const store = UnifiedStore.open(join(dir, "index.db"));
        try {
            const value = session(original);
            store.ingestSession(plan(value));
            const before = store.getCcr(value.id);
            const backend = new SqliteBackend(store);
            assert.deepEqual(message(await renderSessionJsonlFromTables(backend, value.id, true)), {
                ...value.lastMessages![0], text: original, dereferencedFrom: REF,
            });
            assert.deepEqual(message(await renderSessionJsonlFromTables(backend, value.id, false)), value.lastMessages![0]);
            assert.deepEqual(store.getCcr(value.id), before);
        } finally {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
}

for (const mirror of ["missing hash", "missing ref", "null ref", "corrupt mirror"] as const) {
    test(`full export preserves the placeholder when the original has a ${mirror}`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "jsonl-ccr-missing-"));
        const store = UnifiedStore.open(join(dir, "index.db"));
        try {
            const value = session("unavailable original");
            const input = plan(value);
            const ccr = value.contentStore!;
            input.session.ccrJson = mirror === "corrupt mirror" ? "broken {" : JSON.stringify({
                version: 1,
                byHash: mirror === "missing hash" ? {} : ccr.byHash,
                byRef: mirror === "missing ref" ? {} : mirror === "null ref" ? { [REF]: null } : ccr.byRef,
            });
            store.ingestSession(input);
            assert.deepEqual(message(await renderSessionJsonlFromTables(new SqliteBackend(store), value.id, true)), value.lastMessages![0]);
        } finally {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
}

for (const missing of [false, true]) {
    test(`disk originals fill gaps without replacing indexed originals (missing=${missing})`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "jsonl-ccr-precedence-"));
        const store = UnifiedStore.open(join(dir, "index.db"));
        try {
            const value = session("indexed original");
            const input = plan(value);
            if (missing) input.session.ccrJson = null;
            store.ingestSession(input);
            const actual = message(await renderSessionJsonlFromTables(new SqliteBackend(store), value.id, true, new Map([[REF, "disk original"]])));
            assert.equal(actual.text, missing ? "disk original" : "indexed original");
            assert.equal(actual.dereferencedFrom, REF);
        } finally {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
}

test("plain exports and non-placeholder text remain verbatim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jsonl-ccr-verbatim-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    try {
        for (const [full, text] of [[false, PLACEHOLDER], [true, "ordinary text"], [true, `quoted: ${PLACEHOLDER}`]] as const) {
            const value = session("saved original");
            value.lastMessages![0]!.text = text;
            store.ingestSession(plan(value), undefined, { completeLog: true });
            const lines = records(await renderSessionJsonlFromTables(new SqliteBackend(store), value.id, full));
            const last = lines.filter((line) => line.type === "message").at(-1)!;
            assert.deepEqual(last.message, value.lastMessages![0]);
        }
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

for (const [mode, removeSidecar, missingBytes] of [["full", false, false], ["full", true, false], ["full", false, true], ["legacy", false, false]] as const) {
    test(`public full export in ${mode} storage (removeSidecar=${removeSidecar}, missingBytes=${missingBytes})`, async () => {
        const previous = process.env.BILI_STORAGE_UNIFIED;
        process.env.BILI_STORAGE_UNIFIED = mode;
        const dir = mkdtempSync(join(tmpdir(), "jsonl-ccr-public-"));
        const persisted = new SessionStore({ dir, enabled: true, debounceMs: 0 });
        try {
            const original = "first line\nexact original 日本語 😀\n";
            const value = session(original);
            if (missingBytes) value.contentStore!.byHash = {};
            await persisted.writeNow(value);
            if (removeSidecar) {
                const files = readdirSync(dir, { recursive: true }).filter((file) => String(file).endsWith(".content-store.json"));
                assert.ok(files.length > 0);
                for (const file of files) rmSync(join(dir, String(file)));
            }
            const text = await exportSession(value.id, { dir, jsonl: true, full: true });
            assert.equal(records(text)[0]!.source, mode === "full" ? "unified" : "legacy-tail");
            assert.deepEqual(message(text), missingBytes ? value.lastMessages![0] : { ...value.lastMessages![0], text: original, dereferencedFrom: REF });
        } finally {
            persisted.closeQuietly();
            rmSync(dir, { recursive: true, force: true });
            if (previous === undefined) delete process.env.BILI_STORAGE_UNIFIED;
            else process.env.BILI_STORAGE_UNIFIED = previous;
        }
    });
}
