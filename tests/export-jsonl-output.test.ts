import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import { exportSession } from "../src/export.ts";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";

function session(): Session {
    return {
        id: "jsonl-output", meta: { title: "Export output", protocol: "responses" },
        stats: { requests: 1, tokensSaved: 0, inputTokens: 10, cachedTokens: 0, outputTokens: 0,
            cacheSamples: 0, lastInputTokens: 10, contextTokens: 10, compressCreditTokens: 0,
            retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {}, createdAt: 1, lastSeen: 2, state: createInitialState(), pendingRetrievals: [],
        blockContents: new Map(), inFlight: 0, persisted: false, lastMessagesFolded: false,
        lastMessages: [{ id: "message", role: "user", contentType: "text", text: "original prompt" }],
    };
}

for (const mode of ["legacy", "full"]) {
    test(`JSONL output writes exactly the exported records in ${mode} storage`, async () => {
        const previous = process.env.BILI_STORAGE_UNIFIED;
        process.env.BILI_STORAGE_UNIFIED = mode;
        const dir = mkdtempSync(join(tmpdir(), "jsonl-output-"));
        const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
        try {
            await store.writeNow(session());
            for (const full of [false, true]) {
                const expected = await exportSession("jsonl-output", { dir, jsonl: true, full });
                const output = join(dir, "exports", `session-${full}.jsonl`);
                const result = await exportSession("jsonl-output", { dir, jsonl: true, full, output });
                assert.equal(result, `written to ${output}`);
                assert.equal(readFileSync(output, "utf8"), expected);
                const records = expected.trimEnd().split("\n").map((line) => JSON.parse(line));
                assert.equal(records[0].type, "session");
                assert.equal(records[0].source, mode === "full" ? "unified" : "legacy-tail");
                assert.equal(records[0].sessionId, "jsonl-output");
                assert.ok(records.some((record) => record.type === "message"));
            }
        } finally {
            store.closeQuietly();
            rmSync(dir, { recursive: true, force: true });
            if (previous === undefined) delete process.env.BILI_STORAGE_UNIFIED;
            else process.env.BILI_STORAGE_UNIFIED = previous;
        }
    });
}

test("JSONL destination failures propagate and a session listing creates no output file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jsonl-destination-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    try {
        await store.writeNow(session());
        const output = join(dir, "existing-directory");
        mkdirSync(output);
        await assert.rejects(() => exportSession("jsonl-output", { dir, jsonl: true, output }), { code: "EISDIR" });
        const listingOutput = join(dir, "listing.jsonl");
        assert.match(await exportSession(undefined, { dir, jsonl: true, output: listingOutput }), /Persisted sessions:/);
        assert.equal(existsSync(listingOutput), false);
    } finally {
        store.closeQuietly();
        rmSync(dir, { recursive: true, force: true });
    }
});
