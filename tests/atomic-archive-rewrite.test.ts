import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

function session(id: string) {
    return planIngest({
        id, createdAt: 1, lastSeen: 2, meta: {}, stats: {}, metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
        blockContents: new Map(), lastMessages: [{ id: `m-${id}`, role: "user", contentType: "text", text: id }],
        lastMessagesFolded: false,
    } as unknown as LegacySessionLike);
}

test("a partial archive cleanup write cannot destroy other archived sessions", (t) => {
    const dir = fs.mkdtempSync(join(tmpdir(), "atomic-archive-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    try {
        const archiveDir = join(dir, "archive");
        for (const id of ["restore-me", "retain-me"]) {
            store.ingestSession(session(id));
            assert.equal(store.archiveSession(id, { archiveDir }).ok, true);
        }
        const file = join(archiveDir, UnifiedStore.ARCHIVE_LOG_NAME);
        const before = fs.readFileSync(file);
        const write = fs.writeFileSync;
        const injected = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
            const [target, data, options] = args;
            if (typeof target === "number" || target === file) {
                write(target, String(data).slice(0, 8), options);
                throw Object.assign(new Error("injected partial write"), { code: "ENOSPC" });
            }
            return write(...args);
        });
        syncBuiltinESMExports();
        try {
            assert.throws(() => store.restoreArchived("restore-me", { archiveDir }), /injected partial write/);
        } finally {
            injected.mock.restore();
            syncBuiltinESMExports();
        }
        assert.deepEqual(fs.readFileSync(file), before);
        assert.deepEqual(fs.readdirSync(archiveDir), [UnifiedStore.ARCHIVE_LOG_NAME]);
        assert.equal(store.restoreArchived("retain-me", { archiveDir }).ok, true);
        assert.equal(store.getMessages("retain-me")[0].msgId, "m-retain-me");
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("successful cleanup preserves records and POSIX archive permissions", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "atomic-archive-ok-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    try {
        const archiveDir = join(dir, "archive");
        for (const id of ["first", "second"]) {
            store.ingestSession(session(id));
            store.archiveSession(id, { archiveDir });
        }
        const file = join(archiveDir, UnifiedStore.ARCHIVE_LOG_NAME);
        const posixPermissions = process.platform !== "win32";
        if (posixPermissions) fs.chmodSync(file, 0o640);
        const previousUmask = posixPermissions ? process.umask(0o077) : undefined;
        try {
            assert.equal(store.restoreArchived("first", { archiveDir }).ok, true);
        } finally {
            if (previousUmask !== undefined) process.umask(previousUmask);
        }
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).sessionId, "second");
        if (posixPermissions) assert.equal(fs.statSync(file).mode & 0o777, 0o640);
        assert.deepEqual(fs.readdirSync(archiveDir), [UnifiedStore.ARCHIVE_LOG_NAME]);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
