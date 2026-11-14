import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionsCommand } from "../src/storage-maintenance.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";

function seed(dir: string): void {
    const store = UnifiedStore.open(join(dir, "index.db"));
    try {
        store.ingestSession(planIngest({
            id: "parent", createdAt: 1000, lastSeen: 2000,
            meta: { protocol: "openai" }, stats: {}, metadata: {},
            state: {
                nextBlockId: 4, nextRunId: 4, messageRefs: { byRaw: {}, byRef: {} },
                blocks: ["healthy", "foreign-a", "foreign-b"].map((blockId, i) => ({
                    blockId, runId: i + 1, createdAt: 1000, tier: 1, active: true,
                    summary: `summary of ${blockId}`, kind: "fold", reason: "test",
                    effectiveMessageIds: [i === 0 ? "own-message" : `other-${i}`], directMessageIds: [],
                })),
            },
            blockContents: new Map(),
            lastMessages: [{ id: "own-message", role: "user", contentType: "text", text: "parent history" }],
            lastMessagesFolded: false, pluginSnapshot: undefined, contentStore: undefined,
        } as unknown as LegacySessionLike));
    } finally { store.close(); }
}

function blockIds(dir: string): string[] {
    const store = UnifiedStore.open(join(dir, "index.db"));
    try { return store.getBlocks("parent").map((b) => b.blockId).sort(); }
    finally { store.close(); }
}

for (const json of [false, true]) {
    test(`foreign-blocks reports archive write failure and remains retryable (${json ? "JSON" : "text"})`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "bili-sweep-exit-"));
        try {
            seed(dir);
            const obstruction = join(dir, "archive", UnifiedStore.BLOCK_ARCHIVE_LOG_NAME);
            mkdirSync(obstruction, { recursive: true });
            const failed = await runSessionsCommand({ sub: "foreign-blocks", apply: true, json, dir });
            if (json) {
                const report = JSON.parse(failed.text);
                assert.equal(report.result.archived.length, 0);
                assert.equal(report.result.failed.length, 2);
                assert.deepEqual(report.result.failed.map((f: { finding: { blockId: string } }) => f.finding.blockId).sort(), ["foreign-a", "foreign-b"]);
            } else {
                assert.match(failed.text, /failed:\s+2/);
                assert.match(failed.text, /foreign-a/);
                assert.match(failed.text, /foreign-b/);
            }
            assert.deepEqual(blockIds(dir), ["foreign-a", "foreign-b", "healthy"]);
            assert.equal(failed.code, 1, "an unsuccessful archive sweep must not signal success");

            rmSync(obstruction, { recursive: true });
            const retried = await runSessionsCommand({ sub: "foreign-blocks", apply: true, json, dir });
            assert.equal(retried.code, 0);
            assert.deepEqual(blockIds(dir), ["healthy"]);
            assert.equal((await runSessionsCommand({ sub: "foreign-blocks", apply: true, json, dir })).code, 0);
        } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    });
}

test("foreign-blocks dry-run remains successful and does not touch the archive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-sweep-dry-exit-"));
    try {
        seed(dir);
        mkdirSync(join(dir, "archive", UnifiedStore.BLOCK_ARCHIVE_LOG_NAME), { recursive: true });
        for (const json of [false, true]) {
            const result = await runSessionsCommand({ sub: "foreign-blocks", json, dir });
            assert.equal(result.code, 0);
        }
        assert.deepEqual(blockIds(dir), ["foreign-a", "foreign-b", "healthy"]);
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
