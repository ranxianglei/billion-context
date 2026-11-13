import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, contentStoreRelPathFor, relPathFor, storageStatusLabel } from "../src/persist.ts";


/**
 * #2960 Phase 3 / #5988 contract gate: with `storage.jsonWriter = "off"`
 * (unified full), the sessions directory may gain a .json file ONLY through
 * the whitelisted materialization paths below. The off switch promises "the
 * SQLite index is the ONLY persistent copy" — any code that starts writing
 * JSON there (the CCR content-store sidecar used to, #5988) is a regression
 * of that contract and must fail CI, not wait for a human audit.
 *
 * Mechanism: snapshot diff, not fs interception. Before and after each phase
 * every *.json file in the store dir is hashed; added/modified entries are
 * checked against the whitelist. Whatever API the write path uses
 * (writeFileSync, rename, fd writes) shows up in the diff, so a new writer
 * cannot hide behind an un-intercepted syscall.
 *
 * Phases:
 *   A  first save of a fresh store            → ZERO .json writes
 *   B  restart, unified-first adopt + save    → ZERO .json writes
 *   C  replica + restore                      → the restored id's own
 *                                              materialized files ONLY
 *   D  control: switch ON, same first save    → the snapshot MUST see writes
 *                                              (guards against a vacuous gate)
 *
 * The whitelist: the ONLY .json writes off mode may make are the
 * materialization files of a restored id (its portable envelope + its CCR
 * sidecar), named by relPathFor / contentStoreRelPathFor — the index is not
 * a restore source, and it does not carry forked/restored CCR stores. Any
 * .json write outside that set (including one for a NON-restored id) is a
 * contract regression and fails here. Adding a new legitimate writer: name
 * the code path (file:function) and why the index cannot carry the bytes in
 * JSON_WRITE_WHITELIST and in the PR description.
 *
 * Scope: the sessions directory (this store). CLI-level state files under
 * stateDir() are a separate concern (#5757 migrates them into kv_store).
 */

// Same hermeticity pin as the sibling storage suites: pin BOTH tiers so each
// leg controls its own mode explicitly (absent now defaults to full, #3818).
process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jwgate-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

/** The categories of .json writes the off mode is allowed to make in the
 *  sessions dir. Each entry names the code path and why the index cannot
 *  carry the bytes. The concrete per-run file set is derived from the
 *  restored id via materializedFilesFor() — session FILES are named by a
 *  hash of the id (relPathFor), never by the id itself, so a regex over file
 *  names cannot anchor a restore. */
const JSON_WRITE_WHITELIST: ReadonlyArray<{ re: RegExp; reason: string }> = [
    // restoreReplica materialization (persist.ts restoreReplica → kernel
    // store.writeNow + writeContentStoreSidecar): the index is not a
    // restore source, and it does not carry forked/restored CCR stores —
    // buildRecord drops forkContentStore on the next live save, so the
    // sidecar is the durable copy for the restored id.
    { re: /^restore-.*\.json$/, reason: "restore materialization (portable envelope + CCR sidecar)" },
];

/** The concrete whitelist set for one restore: the restored id's envelope
 *  and CCR sidecar, named exactly as the writers name them. */
function materializedFilesFor(id: string, protocol: string, origin: string): Set<string> {
    return new Set([
        relPathFor(id, protocol, origin).split(path.sep).join("/"),
        contentStoreRelPathFor(id, protocol, origin).split(path.sep).join("/"),
    ]);
}

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

function loadCorpusCase(dir: string, name: string, id: string, protocol: string) {
    fs.cpSync(path.join(CORPUS_ROOT, name), path.join(dir, name), { recursive: true });
    const loader = new SessionStore({ dir: path.join(dir, name), debounceMs: 1, enabled: true });
    const loaded = loader.loadSync(id, { protocol, upstreamOrigin: "http://127.0.0.1:8199" });
    loader.cancelAll();
    loader.closeQuietly();
    assert.ok(loaded, `${name}: corpus loadSync returned null`);
    return loaded;
}

/** relpath → sha256 of every *.json file under dir (sidecars included). */
function jsonSnapshot(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (p: string) => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            const full = path.join(p, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith(".json"))
                out.set(path.relative(dir, full).split(path.sep).join("/"),
                    createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
        }
    };
    walk(dir);
    return out;
}

function jsonDiff(before: Map<string, string>, after: Map<string, string>) {
    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];
    for (const [f, h] of after) {
        if (!before.has(f)) added.push(f);
        else if (before.get(f) !== h) modified.push(f);
    }
    for (const f of before.keys()) if (!after.has(f)) removed.push(f);
    return { added, modified, removed };
}

function whitelistText(): string {
    return JSON_WRITE_WHITELIST.map((w) => `${w.re} — ${w.reason}`).join("\n");
}

/** Strict leg: a phase that may not touch ANY .json file. */
function assertNoJsonWrites(phase: string, diff: ReturnType<typeof jsonDiff>): void {
    const offenders = [...diff.added, ...diff.modified];
    assert.deepEqual(offenders.sort(), [],
        `${phase}: jsonWriter=off must write NO .json files into the sessions dir — offenders:\n  ${offenders.join("\n  ")}\nWhitelist (allowed only in the restore phase):\n${whitelistText()}`);
}

/** Restore leg: every write must be one of the restored id's own
 *  materialized files. */
function assertWhitelistedJsonWrites(phase: string, diff: ReturnType<typeof jsonDiff>, allowed: Set<string>): void {
    const offenders = [...diff.added, ...diff.modified].filter((f) => !allowed.has(f)).sort();
    assert.deepEqual(offenders, [],
        `${phase}: .json write outside the whitelist:\n  ${offenders.join("\n  ")}\nWhitelist categories:\n${whitelistText()}\nAllowed files for this restore:\n  ${[...allowed].join("\n  ")}\nIf the write is legitimate, extend JSON_WRITE_WHITELIST with the code path and the reason the index cannot carry the bytes.`);
}

/** Windows: an ephemeral stray handle must not fail CI — best-effort delete
 *  with bounded retries, swallowed on persistent EBUSY/EPERM. */
function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

test("jsonWriter=off: only whitelisted .json files may be written in the sessions dir", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "off";
    try {
        assert.equal(storageStatusLabel(), "storage: full (unified-only, json envelope off)");
        const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jwgate-seed-"));
        // The ccr corpus case: a non-trivial content store, so any CCR write
        // regression shows up as bytes in the diff.
        const session = loadCorpusCase(seed, "ccr", "corpus-ccr", "responses");
        session.contentStore = {
            version: 1,
            byHash: { h1: "THE ORIGINAL LONG TEXT" },
            byRef: { m00001: { hash: "h1", rawId: "raw-1", kind: "file read", tokens: 5, chars: 22, head: "ORIGINAL HEAD" } },
        } as typeof session.contentStore;
        session.contentStoreDirty = true;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jwgate-full-"));
        try {
            // Phase A: first save of a fresh store — the index-only landing.
            {
                const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
                const before = jsonSnapshot(dir);
                await store.writeNow(session);
                store.cancelAll();
                store.closeQuietly();
                assertNoJsonWrites("phase A (first save)", jsonDiff(before, jsonSnapshot(dir)));
                assert.ok(fs.existsSync(path.join(dir, "index.db")), "the durable copy must be the index");
            }

            // Phase B: restart — unified-first adopt of the index-only
            // session, then a save that does real work.
            {
                const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
                const before = jsonSnapshot(dir);
                const adopted = store.loadSync(session.id, { protocol: "responses", upstreamOrigin: "http://127.0.0.1:8199" });
                assert.ok(adopted, "index-only session must adopt after restart");
                await store.writeNow(adopted);
                store.cancelAll();
                store.closeQuietly();
                assertNoJsonWrites("phase B (restart adopt + save)", jsonDiff(before, jsonSnapshot(dir)));
            }

            // Phase C: replica + restore — the ONLY phase allowed .json
            // writes, and only the whitelisted materialization.
            {
                const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
                const before = jsonSnapshot(dir);
                await store.loadSync(session.id, { protocol: "responses", upstreamOrigin: "http://127.0.0.1:8199" });
                const cp = await store.createReplica(session.id, { label: "json-writer-off-gate" });
                // NO sessionId — the default `restore-<uuid8>` id.
                const restored = await store.restoreReplica(cp.cp_id);
                assert.ok(restored.sessionId.startsWith("restore-"), "default restore id must start with restore-");
                assert.equal(restored.restoredFrom, session.id);
                store.cancelAll();
                store.closeQuietly();
                const diff = jsonDiff(before, jsonSnapshot(dir));
                const allowed = materializedFilesFor(restored.sessionId, "responses", "http://127.0.0.1:8199");
                assertWhitelistedJsonWrites("phase C (replica + restore)", diff, allowed);
                // Portability is the reason the materialization is
                // whitelisted — it must actually happen, not just be allowed.
                assert.ok(diff.added.includes(relPathFor(restored.sessionId, "responses", "http://127.0.0.1:8199").split(path.sep).join("/")),
                    "restore must materialize a portable JSON envelope");
            }

            // No transient files may be left behind by any phase.
            const leftover: string[] = [];
            const walk = (p: string) => {
                for (const e of fs.readdirSync(p, { withFileTypes: true })) {
                    const full = path.join(p, e.name);
                    if (e.isDirectory()) walk(full);
                    else if (e.name.startsWith(".tmp-")) leftover.push(full);
                }
            };
            walk(dir);
            assert.deepEqual(leftover, [], "no .tmp-* transients may remain");
        } finally {
            rmBestEffort(dir);
            rmBestEffort(seed);
        }
    } finally {
        delete process.env.BILI_STORAGE_JSON_WRITER;
        process.env.BILI_STORAGE_UNIFIED = prevMode;
    }
});

test("control: with jsonWriter=on the same first save DOES write .json (gate is not vacuous)", async () => {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    delete process.env.BILI_STORAGE_JSON_WRITER; // switch on
    try {
        const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jwgate-seed-"));
        const session = loadCorpusCase(seed, "folded", "corpus-folded", "anthropic");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-jwgate-on-"));
        try {
            const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
            const before = jsonSnapshot(dir);
            await store.writeNow(session);
            store.cancelAll();
            store.closeQuietly();
            const diff = jsonDiff(before, jsonSnapshot(dir));
            assert.ok([...diff.added, ...diff.modified].length > 0,
                "the on-control must produce .json writes — an empty diff means the snapshot mechanism is broken");
        } finally {
            rmBestEffort(dir);
            rmBestEffort(seed);
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevMode;
    }
});
