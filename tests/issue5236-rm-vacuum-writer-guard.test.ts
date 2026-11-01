import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { runSessionsCommand } from "../src/storage-maintenance.ts";

/**
 * #5236 follow-up — `sessions rm` full-VACUUM online guard (same mechanism
 * family as #4612's gc guard).
 *
 * After the owner ruling 3a6ab628 (2026-10-31: a live foreign writer never
 * blocks startup), per-operation guards are the sole defense against an
 * O(db-size) exclusive VACUUM starving a co-resident instance. `storage gc`
 * has its up-front refusal (#4612); `sessions rm`'s default full vacuum had
 * none — while a proxy held index.db it could win the exclusive lock and
 * starve that proxy's writes across the whole rewrite. Fix under test: rm
 * skips ONLY the shrink when a live foreign writer holds the db (the deletion
 * is a short transaction and stays committed, same as the pre-existing
 * SQLITE_BUSY path) with an actionable note naming the pid; with no writer
 * the full vacuum still runs (negative gate, #3617 discipline).
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-5236-rm-guard-")),
    "no-config.json",
);

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

async function waitUntil(fn: () => boolean, ms: number, what: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** A live stand-in for "the other instance" (e.g. a running proxy). */
function spawnDummyWriter(): { pid: number; done(): Promise<void>; kill(): void } {
    const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const pid = child.pid!;
    return {
        pid,
        done: () => waitUntil(() => !alive(pid), 10_000, `dummy writer ${pid} to exit`),
        kill: () => child.kill("SIGTERM"),
    };
}

interface CoreMsg { id: string; role: string; contentType: string; text: string }
const mkMsg = (id: string, text: string): CoreMsg => ({ id, role: "user", contentType: "text", text });

const mkLegacy = (id: string, msgs: CoreMsg[], lastSeen: number): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen,
    meta: { protocol: "openai" },
    stats: {},
    metadata: {},
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

/** DB-direct seeding (no JSON files). */
function seedDb(dir: string, entries: Array<[string, CoreMsg[], number]>): void {
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    try {
        for (const [id, msgs, lastSeen] of entries) store.ingestSession(planIngest(mkLegacy(id, msgs, lastSeen)));
    } finally {
        store.close();
    }
}

test("#5236: sessions rm skips the default full VACUUM while a foreign holder is live; deletion still commits", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5236-rm-open-"));
    const dbPath = path.join(dir, "index.db");
    seedDb(dir, [
        ["rm-live-a", [mkMsg("m1", "hello a")], Date.now()],
        ["rm-live-b", [mkMsg("m1", "hello b")], Date.now()],
    ]);
    const dummy = spawnDummyWriter();
    try {
        await waitUntil(() => alive(dummy.pid), 10_000, "dummy writer to start");
        // The peer opened first: its lockfile entry is what our open() captures.
        fs.writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: dummy.pid, boot: Date.now() }));

        const res = await runSessionsCommand({ sub: "rm", target: "rm-live-a", dir });
        assert.equal(res.code, 0, "rm succeeds — the deletion is online-safe");
        assert.match(res.text, /removed session rm-live-a/, "deletion reported");
        assert.match(res.text, /shrink skipped: another process \(pid \d+\)/, "actionable skip note names the writer");
        assert.match(res.text, /actively writing index\.db/, "note says WHY the shrink was skipped");
        assert.doesNotMatch(res.text, /vacuum:\s+done/, "full VACUUM must NOT have run");

        // The deletion really happened even though the shrink was skipped.
        const again = await runSessionsCommand({ sub: "rm", target: "rm-live-a", dir });
        assert.equal(again.code, 1, "second rm finds nothing left");
        assert.match(again.text, /no session found: rm-live-a/);

        // JSON lane carries the skip honestly (vacuumed=false + note). Re-arm
        // the peer's lock entry first: every opener OVERWRITES <db>.lock with
        // its own pid on open (#4175), so the previous invocation's store
        // clobbered the armed entry — a real CLI re-run re-captures the live
        // proxy at ITS open, which this same-process test models by re-arming
        // (same fixture pattern as the #4612 T4 CLI-level cases).
        fs.writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: dummy.pid, boot: Date.now() }));
        const jsonRes = await runSessionsCommand({ sub: "rm", target: "rm-live-b", dir, json: true });
        assert.equal(jsonRes.code, 0);
        const data = JSON.parse(jsonRes.text) as { vacuumed: boolean; vacuumNote?: string };
        assert.equal(data.vacuumed, false, "json: no vacuum executed");
        assert.match(data.vacuumNote ?? "", /actively writing index\.db/);
    } finally {
        dummy.kill();
        await dummy.done().catch(() => {});
    }
});

test("#5236 negative: no foreign writer ⇒ the default full VACUUM still runs (gate must not over-suppress)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5236-rm-clean-"));
    seedDb(dir, [["rm-clean", [mkMsg("m1", "hello clean")], Date.now()]]);
    const res = await runSessionsCommand({ sub: "rm", target: "rm-clean", dir });
    assert.equal(res.code, 0);
    assert.match(res.text, /removed session rm-clean/);
    assert.match(res.text, /vacuum:\s+done/, "full vacuum proceeds without a live writer");
    assert.doesNotMatch(res.text, /shrink skipped/, "no spurious skip note");
});

test("#5236 negative: a dead holder is not a writer ⇒ vacuum proceeds (stale lockfile entry)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5236-rm-stale-"));
    const dbPath = path.join(dir, "index.db");
    seedDb(dir, [["rm-stale", [mkMsg("m1", "hello stale")], Date.now()]]);
    const dummy = spawnDummyWriter();
    await waitUntil(() => alive(dummy.pid), 10_000, "dummy writer to start");
    dummy.kill();
    await dummy.done();
    fs.writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: dummy.pid, boot: Date.now() }));
    const res = await runSessionsCommand({ sub: "rm", target: "rm-stale", dir });
    assert.equal(res.code, 0);
    assert.match(res.text, /removed session rm-stale/);
    assert.match(res.text, /vacuum:\s+done/, "dead pid must not block the shrink");
});
