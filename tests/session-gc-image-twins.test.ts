import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { SessionStore, relPathFor } from "../src/persist.ts";
import { gcSessionFiles } from "../src/session-gc.ts";
import { restoreExportDirName } from "../src/image-restore.ts";

const now = Date.now();
const day = 86_400_000;
const root = mkdtempSync(path.join(tmpdir(), "bili-gc-image-twins-"));
const env = {
    BILI_CONFIG_FILE: path.join(root, "no-config.json"), BILI_STORAGE_UNIFIED: "legacy",
    BILI_PERSIST_ZSTD: "0", BILI_SESSION_GC: "1", BILI_SESSION_GC_MAX_AGE_DAYS: "7",
    BILI_SESSION_GC_MAX_TOKENS: "1000000",
};
const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
after(() => {
    for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
});

async function fixture(exercise: (f: {
    session: (id: string, protocol: string | undefined, old: boolean, corrupt?: boolean) => string;
    image: (id: string, old?: boolean) => string;
    sweep: () => ReturnType<typeof gcSessionFiles>;
}) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(path.join(root, "case-"));
    const imgRoot = path.join(dir, "spills");
    const sessionDir = path.join(dir, "sessions");
    const store = new SessionStore({ dir: sessionDir });
    try {
        await exercise({
            session: (id, protocol, old, corrupt = false) => {
                const file = path.join(sessionDir, relPathFor(id, protocol, "https://api.example.test"));
                mkdirSync(path.dirname(file), { recursive: true });
                const savedAt = old ? now - 10 * day : now;
                writeFileSync(file, corrupt ? "not JSON" : JSON.stringify({ version: 1, id, savedAt, state: { blocks: [] }, contextTokens: 12 }));
                utimesSync(file, new Date(savedAt), new Date(savedAt));
                return file;
            },
            image: (id, old = false) => {
                const folder = path.join(imgRoot, restoreExportDirName(id));
                mkdirSync(folder, { recursive: true });
                const file = path.join(folder, "m00002.png");
                writeFileSync(file, "fresh image bytes");
                const at = new Date(old ? now - 10 * day : now);
                utimesSync(folder, at, at);
                return file;
            },
            sweep: () => gcSessionFiles({ dir: sessionDir, store, now, imgRoot }),
        });
    } finally {
        store.closeQuietly();
    }
}

for (const oldProtocol of [undefined, "anthropic"]) {
    test(`removing a stale ${oldProtocol ?? "unknown"} twin keeps the surviving session's fresh image`, async () => {
        await fixture(async ({ session, image, sweep }) => {
            const id = "migrated-image-session";
            const stale = session(id, oldProtocol, true);
            const live = session(id, oldProtocol === undefined ? "anthropic" : undefined, false);
            const file = image(id);
            const result = await sweep();
            assert.equal(result.removed, 1);
            assert.equal(existsSync(stale), false);
            assert.equal(existsSync(live), true);
            assert.equal(readFileSync(file, "utf8"), "fresh image bytes");
            assert.equal(result.imgDirsRemoved, 0);
        });
    });
}

test("an unreadable surviving twin conservatively keeps fresh image exports", async () => {
    await fixture(async ({ session, image, sweep }) => {
        const id = "unreadable-twin";
        session(id, undefined, true);
        session(id, "openai", false, true);
        const file = image(id);
        assert.equal((await sweep()).removed, 1);
        assert.equal(readFileSync(file, "utf8"), "fresh image bytes");
    });
});

test("the last deleted twin releases the shared export directory once", async () => {
    await fixture(async ({ session, image, sweep }) => {
        const id = "both-old";
        session(id, undefined, true);
        session(id, "anthropic", true);
        const file = image(id);
        const result = await sweep();
        assert.equal(result.removed, 2);
        assert.equal(existsSync(file), false);
        assert.equal(result.imgDirsRemoved, 1);
    });
});

test("an unrelated surviving session does not retain the deleted session's fresh exports", async () => {
    await fixture(async ({ session, image, sweep }) => {
        session("old-only", undefined, true);
        session("other-live", "anthropic", false);
        const file = image("old-only");
        assert.equal((await sweep()).removed, 1);
        assert.equal(existsSync(file), false);
    });
});

test("a surviving twin does not disable the existing stale-export age policy", async () => {
    await fixture(async ({ session, image, sweep }) => {
        const id = "stale-export";
        session(id, undefined, true);
        session(id, "openai", false);
        const file = image(id, true);
        const result = await sweep();
        assert.equal(result.removed, 1);
        assert.equal(existsSync(file), false);
        assert.equal(result.imgDirsRemoved, 1);
    });
});
