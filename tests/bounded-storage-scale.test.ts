import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

test("320 MB archive boots under a 128 MB heap and restores an older original", { timeout: 100_000 }, () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-bounded-scale-"));
    const dir = path.join(root, "sessions");
    const source = fileURLToPath(new URL("../", import.meta.url));
    const text = "synthetic archived original ".repeat(40000);
    try {
        mkdirSync(path.join(dir, "_unknown"), { recursive: true });
        for (let i = 0; i < 320; i++) {
            const id = `scale-session-${i}`;
            const hash = createHash("sha256").update(id).digest("hex").slice(0, 24);
            const record = {
                version: 3, savedAt: 1000 + i, id, meta: { label: id },
                state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} } },
                blockContents: { b1: { one: null, full: { text, count: 1 } } },
                stats: { requests: 1 }, createdAt: 1000 + i,
            };
            writeFileSync(path.join(dir, "_unknown", `${hash}.json`), JSON.stringify({ version: 3, savedAt: record.savedAt, id, payload: record }));
        }
        // No migration marker: the first boot must also stay bounded.
        const script = `
import assert from 'node:assert/strict';
const { SessionStore } = await import(${JSON.stringify(pathToFileURL(path.join(source, "src/persist.ts")).href)});
const store = new SessionStore({ dir: ${JSON.stringify(dir)}, enabled: true, debounceMs: 0 });
const loaded = await store.boot({ maxSessions: 8, maxBytes: 16 * 1024 * 1024 });
assert.ok(loaded.size <= 8);
assert.equal(store.loadSync('scale-session-0').blockContents.get('b1').full.text.length, ${text.length});
store.closeQuietly();
`;
        const entry = path.join(root, "check.mjs");
        writeFileSync(entry, script);
        const env: NodeJS.ProcessEnv = { ...process.env, BILI_PERSIST_ZSTD: "0", BILI_SESSIONS_DIR: dir };
        delete env.BILI_ENCRYPTION_KEY;
        delete env.BILI_STORAGE_UNIFIED;
        for (const kind of ["DATA", "STATE", "CONFIG", "CACHE"]) env[`XDG_${kind}_HOME`] = path.join(root, kind.toLowerCase());
        const result = spawnSync(process.execPath, ["--max-old-space-size=128", "--import", pathToFileURL(path.join(source, "node_modules/tsx/dist/loader.mjs")).href, entry], {
            env, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024,
        });
        assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stderr.slice(-5000)}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
