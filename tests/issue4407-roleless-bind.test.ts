import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { openBackend, type StorageBackend } from "../src/storage/backend.ts";
import { setPreferredSqliteEngineForTests } from "../src/storage/driver.ts";
import type { UnifiedStore } from "../src/storage/store.ts";

/**
 * #4407 — a stored message whose view row carries NO `role` field reached the
 * node:sqlite insert as `undefined`, throwing
 *   TypeError: Provided value cannot be bound to SQLite parameter 6.
 * which latched the process into degraded mode after three saves. The fix
 * stores the sentinel "unknown" in the NOT NULL column at the source AND the
 * bind site while leaving verbatim content untouched (every reader re-parses
 * content and drops non-string-role rows, so the sentinel never reaches the
 * model line). This suite reproduces the exact failure through the real sqlite
 * ingest on the builtin engine and asserts no throw, the sentinel column, and
 * that a normally-roled row keeps its real role.
 */

interface CoreMsg { id: string; role?: string; contentType: string; text: string }

const mkSession = (id: string, msgs: CoreMsg[]): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen: 2_000,
    meta: { protocol: "openai", label: `label-${id}` },
    stats: {},
    metadata: {},
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

function scratch(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "bili-4407-roleless-"));
}

test("#4407: a stored message with no role survives unified sqlite ingest (no bind throw, no latch)", async () => {
    // Pin the builtin node:sqlite engine (the one that throws on an undefined
    // bind) so the repro is deterministic regardless of host detection.
    setPreferredSqliteEngineForTests("node:sqlite");
    const dir = scratch();
    try {
        const backend = await openBackend("sqlite", path.join(dir, "index.db"));
        try {
            const roleless = { id: "m-roleless", contentType: "text", text: "dsh view row with no role" };
            const roled = { id: "m-roled", role: "assistant", contentType: "text", text: "normal assistant turn" };
            // Before the fix this rejected with the param-6 bind TypeError;
            // now both rows commit.
            await backend.ingestSession(planIngest(mkSession("sess-4407", [roleless, roled])));

            const rows = await backend.getMessages("sess-4407");
            assert.equal(rows.length, 2, "both rows landed (no throw aborted the transaction)");

            const [r0, r1] = rows;
            assert.equal(r0!.msgId, "m-roleless");
            assert.equal(r1!.msgId, "m-roled");

            const parsed0 = JSON.parse(r0!.content) as { id?: string; role?: string };
            assert.equal(parsed0.id, "m-roleless");
            assert.ok(!("role" in parsed0), "content bytes stay verbatim (roleless), not rewritten");
            assert.equal(r0!.role, "unknown", "roleless row stores the 'unknown' sentinel in the column");
            assert.equal(r1!.role, "assistant", "a valid role is left untouched by the normalization");

            // verifyProjections re-parses content (roleless -> sentinel) and must
            // agree with the stored sentinel column, not flag the row corrupt.
            const store = (backend as unknown as { store: UnifiedStore }).store;
            const verdict = store.verifyProjections("sess-4407");
            assert.equal(verdict.ok, true, `verifyProjections passed: ${verdict.ok ? "" : verdict.error}`);
        } finally {
            await backend.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        setPreferredSqliteEngineForTests(null);
    }
});
