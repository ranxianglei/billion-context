import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SNAPSHOT_PAYLOAD, journalDirOf } from "../src/snapshot-journal.js";

/**
 * Concurrent snapshot publication. The defect these cover: both state
 * snapshots (prefix-affinity, session-order) rewrote ONE shared
 * `<name>.json.tmp` and renamed it over `<name>.json`, so two instances on the
 * same state dir did whole-file read-modify-write against a single name. The
 * process-local `writing` flag guarded nothing across processes, so the second
 * renamer silently dropped the first's merged chains/skeletons.
 *
 * The journal (src/snapshot-journal.ts) replaces that with immutable
 * publication: a private staging DIRECTORY holding one fsynced payload is
 * renamed onto a never-reused `pub-*` name, the journal dir is fsynced, and
 * only then are the exact input publications whose records the new output
 * contains deleted.
 *
 * The journal directory is `<snapshot>.journal` (see `journalDirOf`). A test
 * that stages inputs must place them THERE, in `pub-*` directories containing `snapshot.json`, or it
 * measures an empty store.
 *
 * Everything here is deterministic: the multi-process test gates every writer
 * on a shared read barrier (IPC, not sleeps or fixed ports), and the crash
 * cases construct the exact on-disk states a crash can leave behind rather
 * than racing a real kill.
 */

const REPO = fileURLToPath(new URL("../", import.meta.url));
const JOURNAL = pathToFileURL(path.join(REPO, "src/snapshot-journal.ts")).href;
const AFFINITY = pathToFileURL(path.join(REPO, "src/affinity-persist.ts")).href;
const AFFINITY_RESOLVER = pathToFileURL(path.join(REPO, "src/prefix-affinity.ts")).href;
const ORDER = pathToFileURL(path.join(REPO, "src/order-persist.ts")).href;
const ORDER_RESOLVER = pathToFileURL(path.join(REPO, "src/session-resolve.ts")).href;
/** The repo's own runner flag: `node --import tsx`. Children load the same TS
 *  sources as this process, so a spawned writer runs the real journal code. */
const TSX_IMPORT = "tsx";

interface Rec {
    id: string;
    value: number;
    seen: number;
}

let root: string;

before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-journal-"));
});

after(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function freshDir(tag: string): string {
    const dir = path.join(root, tag);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Stage input publications into the journal dir. `leaves` maps a publication
 *  name to the raw payload text written inside it. */
function stageJournal(snapshot: string, leaves: Record<string, string>): string {
    const dir = journalDirOf(snapshot);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(leaves)) {
        fs.mkdirSync(path.join(dir, name), { recursive: true });
        fs.writeFileSync(path.join(dir, name, SNAPSHOT_PAYLOAD), body);
    }
    return dir;
}

function publishedNames(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((n) => n.startsWith("pub-"))
        .sort();
}

function stagingNames(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => n.startsWith(".staging-"));
}

/** Read every published input in a journal dir and union them — the reader
 *  contract the journal's whole design rests on. */
function readAll(dir: string): Rec[] {
    const byId = new Map<string, Rec>();
    for (const name of publishedNames(dir)) {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, name, SNAPSHOT_PAYLOAD), "utf8")) as { entries: Rec[] };
        for (const e of doc.entries) {
            const cur = byId.get(e.id);
            if (!cur || e.seen >= cur.seen) byId.set(e.id, e);
        }
    }
    return [...byId.values()];
}

/** A journal over `snapshot` whose parse/encode/merge/covers are the two
 *  stores' generic equivalents: union by id, fresher `seen` wins, and an output
 *  covers an input only when it carries that id at `seen >= input.seen`. No
 *  test restates a retention policy the journal itself owns. */
function journalScript(snapshot: string): string {
    return `
const { openSnapshotJournal } = await import(${JSON.stringify(JOURNAL)});
const journal = openSnapshotJournal({
    snapshotPath: ${JSON.stringify(snapshot)},
    parse: (raw) => {
        if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) throw new Error("not a snapshot");
        return raw.entries;
    },
    encode: (entries) => ({ version: 1, entries }),
    merge: (a, b) => {
        const byId = new Map(a.map((e) => [e.id, e]));
        for (const e of b) { const cur = byId.get(e.id); if (!cur || e.seen >= cur.seen) byId.set(e.id, e); }
        return [...byId.values()];
    },
    // Reclaim only what the published bytes still hold; a cap that dropped a
    // record leaves its input uncovered (and therefore on disk). Indexed once
    // per published output, like the real stores: the journal passes the same
    // reference for every leaf.
    covers: (() => {
        let forOutput = null, byId = new Map();
        return (output, input) => {
            if (forOutput !== output) {
                byId = new Map(output.map((e) => [e.id, e]));
                forOutput = output;
            }
            return input.every((e) => { const kept = byId.get(e.id); return kept !== undefined && kept.seen >= e.seen; });
        };
    })(),
});
`;
}

// ─── publication mechanics ───

test("a publication names its output uniquely and never rewrites the legacy baseline", async () => {
    const dir = freshDir("publish-basics");
    const snapshot = path.join(dir, "affinity.json");
    const journalDir = journalDirOf(snapshot);
    fs.writeFileSync(snapshot, JSON.stringify({ version: 1, entries: [{ id: "legacy", value: 1, seen: 1 }] }));
    const legacyBytes = fs.readFileSync(snapshot);

    const script = `
${journalScript(snapshot)}
const census = journal.census([]);
const first = journal.publish([{ id: "a", value: 1, seen: 1 }], census);
// A fresh read that saw nothing reclaimable: its \`leaves\` empty.
const second = journal.publish([{ id: "b", value: 1, seen: 1 }], { leaves: [] });
console.log(JSON.stringify({ first, second, baselineConsumed: census.leaves.map((l) => l.name) }));
`;
    const out = await runChild(script);

    assert.ok(out.first.published, "the first publish reports a publication name");
    assert.notEqual(out.first.published, out.second.published, "every publication gets its own name");
    assert.equal(out.first.reclaimed, 0, "the baseline is not a reclaimable input");
    assert.equal(out.second.reclaimed, 0, "empty leaves reclaim nothing");
    assert.deepEqual(out.baselineConsumed, [], "the legacy file is never offered for reclamation");

    assert.ok(publishedNames(journalDir).includes(out.first.published), "the published output exists");
    assert.ok(publishedNames(journalDir).includes(out.second.published), "both publications exist — a later publish never removes an earlier name");
    assert.deepEqual(stagingNames(journalDir), [], "no staging dir survives a completed publication");
    assert.deepEqual(fs.readFileSync(snapshot), legacyBytes, "the legacy baseline is byte-identical — read, never rewritten");
    assert.equal(fs.existsSync(snapshot), true, "the legacy baseline is never deleted");
});

test("a publication is a directory with one payload and no partial-visibility window", async () => {
    const dir = freshDir("publication-shape");
    const snapshot = path.join(dir, "affinity.json");
    const journalDir = journalDirOf(snapshot);

    const script = `
${journalScript(snapshot)}
const result = journal.publish([{ id: "a", value: 1, seen: 1 }], { leaves: [] });
console.log(JSON.stringify({ result }));
`;
    const out = await runChild(script);

    const pub = path.join(journalDir, out.result.published);
    assert.ok(fs.statSync(pub).isDirectory(), "a publication is a directory, so the rename that creates it is atomic");
    assert.deepEqual(fs.readdirSync(pub), [SNAPSHOT_PAYLOAD], "it holds exactly one payload — the bytes a reader opens were complete before the name existed");
});

test("a publication includes its legacy baseline, and only its exact inputs are reclaimed", async () => {
    const dir = freshDir("reclaim");
    const snapshot = path.join(dir, "affinity.json");
    fs.writeFileSync(snapshot, JSON.stringify({ version: 1, entries: [{ id: "legacy", value: 0, seen: 0 }] }));
    stageJournal(snapshot, {
        "pub-1-aaaaaaaaaaaaaaaa": JSON.stringify({ version: 1, entries: [{ id: "a", value: 1, seen: 1 }] }),
        "pub-2-bbbbbbbbbbbbbbbb": JSON.stringify({ version: 1, entries: [{ id: "b", value: 2, seen: 2 }] }),
    });
    const journalDir = journalDirOf(snapshot);

    const script = `
${journalScript(snapshot)}
const census = journal.census([]);
const result = journal.publish(census.records, census);
console.log(JSON.stringify({ census, result }));
`;
    const out = await runChild(script);

    assert.deepEqual(out.census.leaves.map((l: { name: string }) => l.name).slice().sort(), ["pub-1-aaaaaaaaaaaaaaaa", "pub-2-bbbbbbbbbbbbbbbb"], "the census offers exactly the inputs it parsed");
    assert.deepEqual(out.census.retained, [], "nothing was retained");
    assert.equal(out.result.reclaimed, 2, "both consumed inputs are reclaimed");
    assert.deepEqual(publishedNames(journalDir), [out.result.published], "only the new output remains — the old inputs are gone, not orphaned");
    const remaining = readAll(journalDir);
    assert.deepEqual(remaining.map((e: Rec) => e.id).sort(), ["a", "b", "legacy"], "the new output carries the baseline and both inputs");
});

test("a sibling-reclaimed input is neither reclaimed twice nor reported as retained", async () => {
    const dir = freshDir("sibling-reclaimed");
    const snapshot = path.join(dir, "affinity.json");
    const journalDir = stageJournal(snapshot, {
        "pub-1-aaaaaaaaaaaaaaaa": JSON.stringify({ version: 1, entries: [{ id: "a", value: 1, seen: 1 }] }),
    });
    const script = `
${journalScript(snapshot)}
const fs = await import("node:fs");
const census = journal.census([]);
fs.rmSync(${JSON.stringify(path.join(journalDir, "pub-1-aaaaaaaaaaaaaaaa"))}, { recursive: true });
const result = journal.publish(census.records, census);
console.log(JSON.stringify({ result }));
`;
    const out = await runChild(script);
    assert.equal(out.result.reclaimed, 0, "this writer did not delete the already-vanished leaf");
    assert.equal(out.result.uncovered, 0, "the output still covers the record");
    assert.equal(out.result.retained, 0, "a sibling's successful reclamation leaves nothing retained on disk");
});

test("a crash before publication leaves every input intact and no visible output", () => {
    const dir = freshDir("crash-pre-publish");
    const snapshot = path.join(dir, "affinity.json");
    // The exact state a SIGKILL inside publishAtomic leaves: a private staging
    // DIRECTORY whose payload fsync never completed. No publication, no delete.
    const journalDir = stageJournal(snapshot, {
        "pub-1000000-aaaaaaaaaaaaaaaa": JSON.stringify({ version: 1, entries: [{ id: "kept", value: 1, seen: 1 }] }),
    });
    fs.mkdirSync(path.join(journalDir, ".staging-1000000-deadbeefdeadbeef"));
    fs.writeFileSync(path.join(journalDir, ".staging-1000000-deadbeefdeadbeef", SNAPSHOT_PAYLOAD), '{"version":1,"entries":');

    assert.deepEqual(readAll(journalDir).map((e) => e.id), ["kept"], "the completed publication is readable");
    assert.deepEqual(publishedNames(journalDir), ["pub-1000000-aaaaaaaaaaaaaaaa"], "an unfinished staging dir is never mistaken for a publication");
    assert.equal(stagingNames(journalDir).length, 1, "the incomplete staging dir is inert but still there");
});

test("a crash after publication but before reclamation leaves a durable superset", () => {
    const dir = freshDir("crash-mid-reclaim");
    const snapshot = path.join(dir, "affinity.json");
    // Writer W parsed A and B, published C = A ∪ B, then died before deleting.
    const journalDir = stageJournal(snapshot, {
        "pub-1-aaaaaaaaaaaaaaaa": JSON.stringify({ version: 1, entries: [{ id: "a", value: 1, seen: 1 }] }),
        "pub-2-bbbbbbbbbbbbbbbb": JSON.stringify({ version: 1, entries: [{ id: "b", value: 2, seen: 2 }] }),
        "pub-3-cccccccccccccccc": JSON.stringify({ version: 1, entries: [{ id: "a", value: 1, seen: 2 }, { id: "b", value: 2, seen: 2 }] }),
    });

    assert.deepEqual(readAll(journalDir).map((e) => e.id).sort(), ["a", "b"], "a superset costs a re-merge, never a record");
});

test("a half-deleted input reads as a vanished input, never as an empty store", async () => {
    const dir = freshDir("half-deleted");
    const snapshot = path.join(dir, "affinity.json");
    const journalDir = stageJournal(snapshot, {
        "pub-1-aaaaaaaaaaaaaaaa": JSON.stringify({ version: 1, entries: [{ id: "a", value: 1, seen: 1 }] }),
        "pub-2-bbbbbbbbbbbbbbbb": JSON.stringify({ version: 1, entries: [{ id: "b", value: 2, seen: 2 }] }),
    });
    // A crash between unlink(payload) and rmdir(dir): the publication name is
    // still listed but has no payload. Its records are already durable in the
    // output that deleted it, so a re-census is correct; treating it as empty
    // would silently drop the sibling's records instead.
    fs.unlinkSync(path.join(journalDir, "pub-1-aaaaaaaaaaaaaaaa", SNAPSHOT_PAYLOAD));

    const script = `
${journalScript(snapshot)}
const census = journal.census([]);
console.log(JSON.stringify({ census }));
`;
    const out = await runChild(script);
    assert.deepEqual(out.census.records.map((e: Rec) => e.id), ["b"], "the intact input's records survive; the half-deleted one contributes nothing");
    assert.deepEqual(out.census.leaves.map((l: { name: string }) => l.name), ["pub-2-bbbbbbbbbbbbbbbb"], "only the input actually parsed is offered for reclamation");
});

// ─── corruption: retained inputs and per-input conservation ───

test("an unreadable or ill-shaped input is retained while valid inputs are still reclaimed", async () => {
    const dir = freshDir("corrupt-leaf");
    const snapshot = path.join(dir, "affinity.json");
    const journalDir = stageJournal(snapshot, {
        "pub-1-aaaaaaaaaaaaaaaa": "{ not json",
        "pub-2-bbbbbbbbbbbbbbbb": JSON.stringify({ nonsense: true }),
        "pub-3-cccccccccccccccc": JSON.stringify({ version: 1, entries: [{ id: "good", value: 1, seen: 1 }] }),
    });

    const script = `
${journalScript(snapshot)}
const census = journal.census([]);
const result = journal.publish(journal.mergeWith(census.records, []), census);
console.log(JSON.stringify({ census, result }));
`;
    const out = await runChild(script);

    // Conservation: the corrupt inputs are not among the census `leaves`, so they cannot be
    // deleted; the valid one IS in `leaves` and its record is in the output.
    assert.deepEqual(out.census.leaves.map((l: { name: string }) => l.name), ["pub-3-cccccccccccccccc"], "only the parsed input is offered for reclamation");
    assert.deepEqual(out.census.retained.slice().sort(), ["pub-1-aaaaaaaaaaaaaaaa", "pub-2-bbbbbbbbbbbbbbbb"], "unparsed inputs are reported as retained");
    assert.equal(out.census.incomplete, true, "partial coverage is reported to the caller");
    assert.deepEqual(out.census.records.map((e: Rec) => e.id), ["good"], "readable inputs still merge");

    assert.equal(out.result.reclaimed, 1, "the valid input IS reclaimed — corrupt siblings do not block it");
    assert.ok(fs.existsSync(path.join(journalDir, "pub-1-aaaaaaaaaaaaaaaa", SNAPSHOT_PAYLOAD)), "the corrupt input is preserved for diagnosis");
    assert.ok(fs.existsSync(path.join(journalDir, "pub-2-bbbbbbbbbbbbbbbb", SNAPSHOT_PAYLOAD)), "the ill-shaped input is preserved for diagnosis");
    assert.ok(!fs.existsSync(path.join(journalDir, "pub-3-cccccccccccccccc")), "the input whose record is in the new output is gone");
    assert.ok(out.census.warnings.length >= 2, "both unusable inputs are reported");
    assert.ok(publishedNames(journalDir).includes(out.result.published), "the writer still publishes its own view");
});

test("a permanently corrupt input costs bounded debris, not unbounded growth", async () => {
    const dir = freshDir("corrupt-costs-debris");
    const snapshot = path.join(dir, "affinity.json");
    const journalDir = stageJournal(snapshot, { "pub-0-0000000000000000": "{ not json" });

    // Four write cycles: each publishes a view that still holds the previous
    // output's record, so the predecessor VALID output is genuinely covered.
    const script = `
${journalScript(snapshot)}
const ids = [];
for (let i = 1; i <= 4; i++) {
    const census = journal.census([]);
    const result = journal.publish(journal.mergeWith(census.records, [{ id: "r" + i, value: i, seen: i }]), census);
    ids.push({ published: result.published, reclaimed: result.reclaimed, retained: census.retained.length });
}
console.log(JSON.stringify({ ids }));
`;
    const out = await runChild(script);

    assert.equal(out.ids[0].reclaimed, 0, "the first cycle has no valid predecessor to reclaim");
    for (const step of out.ids.slice(1)) assert.equal(step.reclaimed, 1, "every later cycle reclaims exactly its valid predecessor");
    for (const step of out.ids) assert.equal(step.retained, 1, "the corrupt input is retained every time, unchanged");
    // 1 corrupt input + the one live publication.
    assert.equal(publishedNames(journalDir).length, 2, "only the corrupt input and the latest output survive — the corrupt one is not duplicated");
});

test("an unlistable journal is not an empty journal", async () => {
    const dir = freshDir("unlistable");
    const snapshot = path.join(dir, "affinity.json");
    fs.writeFileSync(snapshot, JSON.stringify({ version: 1, entries: [{ id: "legacy", value: 1, seen: 1 }] }));
    // A journal path that exists as a FILE cannot be readdir'd — the exact
    // failure mode that must not be mistaken for "no journal yet".
    fs.writeFileSync(journalDirOf(snapshot), "not a directory");

    const script = `
${journalScript(snapshot)}
const census = journal.census([]);
console.log(JSON.stringify({ census }));
`;
    const out = await runChild(script);

    assert.equal(out.census.incomplete, true, "a journal we cannot list makes the census incomplete");
    assert.deepEqual(out.census.leaves.map((l: { name: string }) => l.name), [], "nothing is offered for reclamation");
    assert.deepEqual(out.census.records, [{ id: "legacy", value: 1, seen: 1 }], "readable legacy data remains available despite an unreadable journal");
    assert.ok(out.census.warnings.some((w: string) => w.includes("unreadable")), "the failure is reported, not swallowed");
});

for (const code of ["EPERM", "EIO"]) {
    test(`a failed directory barrier (${code}) publishes without reclaiming inputs`, async () => {
        const snapshot = path.join(freshDir(`barrier-${code}`), "affinity.json");
        const old = "pub-1-aaaaaaaaaaaaaaaa";
        const journalDir = stageJournal(snapshot, { [old]: JSON.stringify({ version: 1, entries: [{ id: "old", value: 1, seen: 1 }] }) });
        const script = `
${journalScript(snapshot)}
const fs = await import("node:fs").then(m => m.default);
const originalOpen = fs.openSync;
fs.openSync = (file, ...args) => {
    if (args[0] === "r" && typeof file === "string" && file.startsWith(${JSON.stringify(journalDir)}) && fs.statSync(file).isDirectory()) {
        throw Object.assign(new Error("injected directory barrier failure"), { code: ${JSON.stringify(code)} });
    }
    return originalOpen(file, ...args);
};
let result;
try {
    const census = journal.census([{ id: "new", value: 2, seen: 2 }]);
    result = journal.publish(census.records, census);
} finally { fs.openSync = originalOpen; }
console.log(JSON.stringify({ result, records: journal.census([]).records }));
`;
        const out = await runChild(script);
        assert.equal(out.result.reclaimed, 0);
        assert.equal(out.result.retained, 1);
        assert.ok(out.result.published, "complete bytes remain visible on platforms without directory fsync");
        assert.ok(fs.existsSync(path.join(journalDir, old, SNAPSHOT_PAYLOAD)), "prior input cannot be reclaimed without proven durability");
        assert.deepEqual(out.records.map((r: Rec) => r.id).sort(), ["new", "old"]);
    });
}

test("a corrupt legacy baseline is preserved and never flattened into an empty store", async () => {
    const dir = freshDir("corrupt-legacy");
    const snapshot = path.join(dir, "affinity.json");
    fs.writeFileSync(snapshot, "{ not json");

    const script = `
${journalScript(snapshot)}
const census = journal.census([]);
console.log(JSON.stringify({ census }));
`;
    const out = await runChild(script);

    assert.deepEqual(out.census.records, [], "an unreadable baseline contributes no records");
    assert.equal(out.census.incomplete, true, "an unreadable baseline makes the census incomplete — it may hold unseen records");
    assert.ok(out.census.warnings.some((w: string) => w.includes("corrupt")), "the corruption is surfaced to the caller");
    assert.equal(fs.readFileSync(snapshot, "utf8"), "{ not json", "the corrupt baseline is left exactly as found");
});

test("a corrupt legacy baseline still allows reclaiming valid publications", async () => {
    const dir = freshDir("corrupt-legacy-conservation");
    const snapshot = path.join(dir, "affinity.json");
    fs.writeFileSync(snapshot, "{ not json");
    const journalDir = stageJournal(snapshot, {
        "pub-1-aaaaaaaaaaaaaaaa": JSON.stringify({ version: 1, entries: [{ id: "a", value: 1, seen: 1 }] }),
    });

    const script = `
${journalScript(snapshot)}
const census = journal.census([]);
const result = journal.publish(journal.mergeWith(census.records, []), census);
console.log(JSON.stringify({ census, result }));
`;
    const out = await runChild(script);

    assert.deepEqual(out.census.leaves.map((l: { name: string }) => l.name), ["pub-1-aaaaaaaaaaaaaaaa"], "the parsed publication is reclaimable even though the baseline is corrupt");
    assert.equal(out.result.reclaimed, 1, "conservation is per-input, not all-or-nothing on any corruption");
    assert.equal(fs.readFileSync(snapshot, "utf8"), "{ not json", "the corrupt baseline itself is never deleted or rewritten");
});

// ─── concurrency: true multi-process disjoint publication ───

/** Spawn one writer that (1) opens its journal, (2) censuses, (3) reports
 *  `ready` and WAITS for the parent's `go`, then (4) merges its own record
 *  onto that census and publishes. The barrier makes every writer's read
 *  happen against the same pre-existing input set, which is the interleaving
 *  that used to bite: all readers see A, all write RMW. */
function spawnWriter(snapshot: string, id: string): { child: ChildProcess; ready: Promise<number> } {
    const script = `
${journalScript(snapshot)}
const census = journal.census([]);
process.send({ ready: true, consumed: census.leaves.length });
process.once("message", (msg) => {
    if (msg !== "go") return;
    const mine = [{ id: ${JSON.stringify(id)}, value: 1, seen: Date.now() }];
    try {
        const result = journal.publish(journal.mergeWith(census.records, mine), census);
        process.send({ done: true, published: result.published, reclaimed: result.reclaimed });
    } catch (e) {
        process.send({ done: false, error: String((e && e.message) || e) });
        process.exitCode = 1;
    }
});
`;
    const child = spawn(process.execPath, ["--import", TSX_IMPORT, "--input-type=module", "-e", script], {
        cwd: REPO,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const ready = new Promise<number>((resolve, reject) => {
        child.once("message", (msg: { ready?: boolean; consumed?: number }) => {
            if (msg?.ready) resolve(msg.consumed ?? 0);
            else reject(new Error(`unexpected first message ${JSON.stringify(msg)}`));
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`writer exited before its read barrier: ${code}`)));
    });
    return { child, ready };
}

type WriterResult = { done?: boolean; published?: string; reclaimed?: number; error?: string };

/** Node 20 has no `Promise.withResolvers` (added in 22), so tests build the
 *  deferred by hand — the supported floor is a hard constraint here. */
function deferred<V>(): { promise: Promise<V>; resolve: (v: V) => void; reject: (e: unknown) => void } {
    let resolve!: (v: V) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<V>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function onceMessage(child: ChildProcess): Promise<WriterResult> {
    const { promise, resolve, reject } = deferred<WriterResult>();
    child.once("message", (msg: WriterResult) => resolve(msg));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`writer exited ${code} before reporting`)));
    return promise;
}

test("synchronized writers publishing disjoint records never drop one another", { timeout: 60_000 }, async () => {
    const dir = freshDir("concurrent");
    const snapshot = path.join(dir, "affinity.json");
    fs.writeFileSync(snapshot, JSON.stringify({ version: 1, entries: [{ id: "baseline", value: 0, seen: 0 }] }));
    // One pre-existing publication every writer reads at the barrier.
    const journalDir = stageJournal(snapshot, {
        "pub-0-0000000000000000": JSON.stringify({ version: 1, entries: [{ id: "shared", value: 0, seen: 0 }] }),
    });

    const ids = ["w0", "w1", "w2", "w3"];
    const writers = ids.map((id) => spawnWriter(snapshot, id));
    // Common read barrier: every writer has censused the SAME input set.
    for (const consumed of await Promise.all(writers.map((w) => w.ready))) {
        assert.equal(consumed, 1, "every writer read the same single pre-existing input — that is the interleaving under test");
    }
    const reports = writers.map((w) => onceMessage(w.child));
    for (const w of writers) w.child.send("go");

    const results = await Promise.all(reports);
    for (const r of results) assert.ok(r.done, `writer completed: ${JSON.stringify(r)}`);

    // Only the first reclaimer deletes the shared input; siblings find it gone
    // (ENOENT is not an error) and report 0. Every record must still survive.
    const published = new Set(results.map((r) => r.published));
    assert.equal(published.size, ids.length, "every writer published a DISTINCT never-reused name");
    assert.ok(results.some((r) => r.reclaimed === 1), "the winner reclaimed the shared input");
    assert.deepEqual(stagingNames(journalDir), [], "no writer left a staging dir behind");

    const seen = new Set(readAll(journalDir).map((e) => e.id));
    for (const id of ids) assert.ok(seen.has(id), `${id} survived concurrent publication`);
    assert.ok(seen.has("shared"), "the pre-existing input's record survived every publication");
});

// ─── the two real stores on top of the journal ───

test("affinity persistence publishes, round-trips and never rewrites the legacy file", { timeout: 30_000 }, async () => {
    const state = freshDir("affinity-store");
    const script = `
process.env.XDG_STATE_HOME = ${JSON.stringify(state)};
const fs = await import("node:fs");
const path = await import("node:path");
const { prefixAffinity } = await import(${JSON.stringify(AFFINITY_RESOLVER)});
const { flushPrefixAffinity, hydratePrefixAffinity } = await import(${JSON.stringify(AFFINITY)});

// A legacy baseline written by a pre-journal client.
const dir = path.join(${JSON.stringify(state)}, "billion-context");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "prefix-affinity.json"), JSON.stringify({ version: 1, entries: [
    { sessionId: "legacy-chain", depth: 3, tailHash: "t", itemHashes: ["h1"], lastSeen: 1 },
] }));
const legacyBytes = fs.readFileSync(path.join(dir, "prefix-affinity.json"), "utf8");

prefixAffinity.importSnapshot([{ sessionId: "new-chain", depth: 2, tailHash: "u", itemHashes: ["h2"], lastSeen: Date.now() }]);
flushPrefixAffinity();

const journalDir = path.join(dir, "prefix-affinity.json.journal");
const leaves = fs.existsSync(journalDir) ? fs.readdirSync(journalDir).filter((n) => n.startsWith("pub-")) : [];
const legacyAfter = fs.readFileSync(path.join(dir, "prefix-affinity.json"), "utf8");
const written = leaves.length > 0
    ? JSON.parse(fs.readFileSync(path.join(journalDir, leaves[0], ${JSON.stringify(SNAPSHOT_PAYLOAD)}), "utf8")).entries.map((e) => e.sessionId).sort()
    : [];

prefixAffinity.forget("new-chain");
hydratePrefixAffinity();
const hydrated = prefixAffinity.trackedSessionIds();
console.log(JSON.stringify({ leaves: leaves.length, legacyUnchanged: legacyAfter === legacyBytes, written, hydrated }));
`;
    const out = await runChild(script);
    assert.ok(out.leaves >= 1, "the flush published a journal output");
    assert.equal(out.legacyUnchanged, true, "the legacy baseline is byte-identical after a journal write");
    assert.deepEqual(out.written, ["legacy-chain", "new-chain"], "the published output carries both the baseline and the live chain");
    assert.ok(out.hydrated.includes("legacy-chain"), "hydrate reads the legacy baseline");
    assert.ok(out.hydrated.includes("new-chain"), "hydrate reads the journal output — a restart reattaches the chain");
});

test("order skeletons persist through the journal across a restart", { timeout: 30_000 }, async () => {
    const state = freshDir("order-store");
    const script = `
process.env.XDG_STATE_HOME = ${JSON.stringify(state)};
const fs = await import("node:fs");
const path = await import("node:path");
const { orderSnapshot, resetSessionOrderForTest, applyOrderSnapshot } = await import(${JSON.stringify(ORDER_RESOLVER)});
const { flushOrderSkeletons, hydrateOrderSkeletons } = await import(${JSON.stringify(ORDER)});

resetSessionOrderForTest();
applyOrderSnapshot([{ id: "conv-a", kinds: ["user", "assistant"], frags: ["f1", "f2"], tagHash: "tag", lastSeen: Date.now() }]);
flushOrderSkeletons();

const dir = path.join(${JSON.stringify(state)}, "billion-context");
const journalDir = path.join(dir, "session-order.json.journal");
const leaves = fs.existsSync(journalDir) ? fs.readdirSync(journalDir).filter((n) => n.startsWith("pub-")) : [];

resetSessionOrderForTest();
const cold = orderSnapshot().length;
hydrateOrderSkeletons();
const after = orderSnapshot();
console.log(JSON.stringify({ leaves: leaves.length, cold, after }));
`;
    const out = await runChild(script);
    assert.ok(out.leaves >= 1, "the flush published an output");
    assert.equal(out.cold, 0, "the registry was cold before hydration");
    assert.equal(out.after.length, 1, "hydrate restored the skeleton");
    assert.equal(out.after[0].id, "conv-a");
    assert.deepEqual(out.after[0].kinds, ["user", "assistant"]);
});

// ─── policy controls ───

test("a crashed writer's staging dir stays inert and is never age-reaped", () => {
    const dir = freshDir("staging-inert");
    const snapshot = path.join(dir, "affinity.json");
    // A staging dir left by a crashed writer must never be read as state, and
    // must never be deleted from under a live writer's age guess.
    const journalDir = stageJournal(snapshot, {
        "pub-1-aaaaaaaaaaaaaaaa": JSON.stringify({ version: 1, entries: [{ id: "a", value: 1, seen: 1 }] }),
    });
    const staging = path.join(journalDir, ".staging-1-stale0000000000");
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, SNAPSHOT_PAYLOAD), '{"version":1,"entries":');

    assert.deepEqual(readAll(journalDir).map((e) => e.id), ["a"], "an incomplete staging dir is invisible to readers");
    assert.equal(stagingNames(journalDir).length, 1, "staging dirs are left for their owner, never age-reaped");
});

test("the caller's retention policy is applied before the bytes hit disk", async () => {
    const dir = freshDir("bounds");
    const snapshot = path.join(dir, "affinity.json");
    const journalDir = journalDirOf(snapshot);
    const script = `
const { openSnapshotJournal } = await import(${JSON.stringify(JOURNAL)});
const journal = openSnapshotJournal({
    snapshotPath: ${JSON.stringify(snapshot)},
    parse: (raw) => {
        if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) throw new Error("not a snapshot");
        return raw.entries;
    },
    encode: (entries) => ({ version: 1, entries }),
    // The store's own write-path normalization: freshest 4 win.
    merge: (a, b) => {
        const byId = new Map(a.map((e) => [e.id, e]));
        for (const e of b) { const cur = byId.get(e.id); if (!cur || e.seen >= cur.seen) byId.set(e.id, e); }
        return [...byId.values()].sort((x, y) => y.seen - x.seen).slice(0, 4);
    },
    covers: (() => {
        let forOutput = null, byId = new Map();
        return (output, input) => {
            if (forOutput !== output) {
                byId = new Map(output.map((e) => [e.id, e]));
                forOutput = output;
            }
            return input.every((e) => { const kept = byId.get(e.id); return kept !== undefined && kept.seen >= e.seen; });
        };
    })(),
});
const many = Array.from({ length: 20 }, (_, i) => ({ id: "r" + i, value: i, seen: i }));
const normalized = journal.mergeWith(many, []);
journal.publish(normalized, { leaves: [] });
const fs = await import("node:fs");
const leaves = fs.readdirSync(${JSON.stringify(journalDir)}).filter((n) => n.startsWith("pub-"));
const published = JSON.parse(fs.readFileSync(${JSON.stringify(journalDir)} + "/" + leaves[0] + "/" + ${JSON.stringify(SNAPSHOT_PAYLOAD)}, "utf8")).entries;
console.log(JSON.stringify({ count: published.length, ids: published.map((e) => e.id) }));
`;
    const out = await runChild(script);
    assert.equal(out.count, 4, "the caller's cap is enforced before the bytes hit disk");
    assert.deepEqual(out.ids, ["r19", "r18", "r17", "r16"], "the cap keeps the freshest records");
});

// ─── bounded outputs: a capped view reclaims only what it still covers ───

/** A journal whose write path mirrors both real stores: merge by id (fresher
 *  `seen` wins), then cap to `cap` records. The cap is the whole point — a
 *  merged view is allowed to drop a record that one input held alone. */
function cappedJournalScript(snapshot: string, cap: number): string {
    return `
const { openSnapshotJournal } = await import(${JSON.stringify(JOURNAL)});
const cap = ${cap};
const merge = (a, b) => {
    const byId = new Map(a.map((e) => [e.id, e]));
    for (const e of b) { const cur = byId.get(e.id); if (!cur || e.seen >= cur.seen) byId.set(e.id, e); }
    return [...byId.values()];
};
const journal = openSnapshotJournal({
    snapshotPath: ${JSON.stringify(snapshot)},
    parse: (raw) => {
        if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) throw new Error("not a snapshot");
        return raw.entries;
    },
    encode: (entries) => ({ version: 1, entries }),
    merge,
    covers: (() => {
        let forOutput = null, byId = new Map();
        return (output, input) => {
            if (forOutput !== output) {
                byId = new Map(output.map((e) => [e.id, e]));
                forOutput = output;
            }
            return input.every((e) => { const kept = byId.get(e.id); return kept !== undefined && kept.seen >= e.seen; });
        };
    })(),
});
const publishWrite = (mine) => {
    const census = journal.census([]);
    const merged = merge(mine, census.records).sort((x, y) => y.seen - x.seen).slice(0, cap);
    return { census, result: journal.publish(merged, census) };
};
`;
}

test("a bounded output keeps the input leaf holding a record the cap dropped", async () => {
    const dir = freshDir("bounded-uncovered");
    const snapshot = path.join(dir, "affinity.json");
    // `unique` is fresh but not fresh enough to survive a cap of 2 while this
    // process's two own records are newer. It lives ONLY in this leaf.
    const journalDir = stageJournal(snapshot, {
        "pub-1-aaaaaaaaaaaaaaaa": JSON.stringify({ version: 1, entries: [{ id: "unique", value: 7, seen: 7 }] }),
        "pub-2-bbbbbbbbbbbbbbbb": JSON.stringify({ version: 1, entries: [{ id: "m1", value: 0, seen: 1 }] }),
    });

    const script = `
${cappedJournalScript(snapshot, 2)}
const run = publishWrite([{ id: "m1", value: 1, seen: 100 }, { id: "m2", value: 2, seen: 99 }]);
const fs = await import("node:fs");
const dir = ${JSON.stringify(journalDir)};
const readable = (name) => fs.existsSync(dir + "/" + name + "/" + ${JSON.stringify(SNAPSHOT_PAYLOAD)});
console.log(JSON.stringify({
    result: run.result,
    published: JSON.parse(fs.readFileSync(dir + "/" + run.result.published + "/" + ${JSON.stringify(SNAPSHOT_PAYLOAD)}, "utf8")).entries.map((e) => e.id),
    uniqueLeaf: readable("pub-1-aaaaaaaaaaaaaaaa"),
    oldLeaf: readable("pub-2-bbbbbbbbbbbbbbbb"),
    uniqueAfter: journal.census([]).records.find((e) => e.id === "unique"),
}));
`;
    const out = await runChild(script);

    assert.deepEqual(out.published.sort(), ["m1", "m2"], "the cap drops the unique input while the newer m1 supersedes the other leaf");
    assert.equal(out.result.uncovered, 1, "the leaf holding a capped-out record is reported uncovered");
    assert.equal(out.uniqueLeaf, true, "its payload is still on disk: the cap did not license deleting the record's only source");
    assert.equal(out.oldLeaf, false, "the leaf whose record the output still dominates IS reclaimed");
    assert.deepEqual(out.uniqueAfter, { id: "unique", value: 7, seen: 7 }, "the surviving leaf is still readable by the next census");

    // One bounded warning, and it names the gap rather than claiming completeness.
    assert.equal(out.result.reclaimed, 1, "exactly the dominated leaf was deleted");
    assert.equal(out.result.uncovered, 1, "the capped-out leaf stays and is counted");
    assert.equal(out.result.retained, out.result.uncovered, "retained is the parseable inputs left in place, i.e. the uncovered ones here");
});

test("a capped-out record survives a later wider census and is reclaimed only once covered", async () => {
    const dir = freshDir("bounded-widens");
    const snapshot = path.join(dir, "affinity.json");
    const journalDir = stageJournal(snapshot, {
        "pub-1-aaaaaaaaaaaaaaaa": JSON.stringify({ version: 1, entries: [{ id: "unique", value: 7, seen: 7 }] }),
    });

    const script = `
${journalScript(snapshot)}
const fs = await import("node:fs");
const dir = ${JSON.stringify(journalDir)};
const uniqueId = ${JSON.stringify("pub-1-aaaaaaaaaaaaaaaa")};
const present = () => fs.existsSync(dir + "/" + uniqueId + "/" + ${JSON.stringify(SNAPSHOT_PAYLOAD)});
const out = [];

// 1. A bounded write: cap 1 keeps only the in-memory record, so the leaf's
//    unique record is NOT in the published bytes.
const firstCensus = journal.census([]);
out.push({ step: "bounded", result: journal.publish([{ id: "m1", value: 1, seen: 100 }], firstCensus), present: present() });

// 2. A later WIDER census still sees the record — the cap cost a write, not a record.
const widen = journal.census([]);
out.push({ step: "wider", ids: widen.records.map((e) => e.id).sort(), consumed: widen.leaves.length });

// 3. Publishing that wider set now dominates the leaf, so it is reclaimed.
const wide = journal.publish(widen.records, widen);
out.push({ step: "covered", result: wide, present: present(), remaining: journal.census([]).records.map((e) => e.id).sort() });
console.log(JSON.stringify({ out }));
`;
    const out = await runChild(script);

    assert.equal(out.out[0].result.uncovered, 1, "the bounded write reports the leaf it could not cover");
    assert.equal(out.out[0].present, true, "and leaves its bytes alone");
    assert.deepEqual(out.out[1].ids, ["m1", "unique"], "the later census still sees the capped-out record — nothing was lost");
    assert.equal(out.out[1].consumed, 2, "both leaves are candidates for the wider write");
    assert.equal(out.out[2].result.reclaimed, 2, "the genuine superset reclaims both inputs");
    assert.equal(out.out[2].result.uncovered, 0, "a covering output reports no gap");
    assert.equal(out.out[2].present, false, "only now is the record's leaf reclaimed");
    assert.deepEqual(out.out[2].remaining, ["m1", "unique"], "the output itself is the single durable source of both records");
});

test("an uncovered input is never deleted even when the caller nominates it after publishing", async () => {
    const dir = freshDir("bounded-nominate");
    const snapshot = path.join(dir, "affinity.json");
    // The consumer hands back every name the census parsed while its own bound
    // dropped the records those names hold. Coverage, not the caller's word,
    // decides what is reclaimed.
    const journalDir = stageJournal(snapshot, {
        "pub-1-aaaaaaaaaaaaaaaa": JSON.stringify({ version: 1, entries: [{ id: "keep-1", value: 1, seen: 1 }] }),
        "pub-2-bbbbbbbbbbbbbbbb": JSON.stringify({ version: 1, entries: [{ id: "keep-2", value: 2, seen: 2 }] }),
    });

    const script = `
${cappedJournalScript(snapshot, 1)}
const run = publishWrite([{ id: "only", value: 0, seen: 500 }]);
console.log(JSON.stringify({ censusLeaves: run.census.leaves.map((l) => l.name).sort(), result: run.result }));
`;
    const out = await runChild(script);

    assert.deepEqual(out.censusLeaves, ["pub-1-aaaaaaaaaaaaaaaa", "pub-2-bbbbbbbbbbbbbbbb"], "both inputs were nominated for reclamation");
    assert.equal(out.result.uncovered, 2, "and both are refused: the cap-1 output covers neither");
    assert.equal(out.result.reclaimed, 0, "a bounded output reclaims nothing it cannot dominate");
    assert.deepEqual(publishedNames(journalDir).sort(), ["pub-1-aaaaaaaaaaaaaaaa", "pub-2-bbbbbbbbbbbbbbbb", out.result.published].sort(), "every input survives beside the new output");
    assert.deepEqual(readAll(journalDir).map((e) => e.id).sort(), ["keep-1", "keep-2", "only"], "no record was lost");
});

test("a same-id input is reclaimed only when the output dominates that exact record", async () => {
    const dir = freshDir("bounded-same-id");
    const snapshot = path.join(dir, "affinity.json");
    const journalDir = stageJournal(snapshot, {
        // Same id as the write, but NEWER than the output it would be merged
        // into: merging is not dominance, so this leaf must survive.
        "pub-1-aaaaaaaaaaaaaaaa": JSON.stringify({ version: 1, entries: [{ id: "s", value: 2, seen: 50 }] }),
    });

    const script = `
${journalScript(snapshot)}
const fs = await import("node:fs");
const LEAF = ${JSON.stringify(path.join(journalDir, "pub-1-aaaaaaaaaaaaaaaa", SNAPSHOT_PAYLOAD))};
// One real read: the census parses pub-1's record (seen 50) and offers it.
const read = journal.census([]);
const stale = journal.publish([{ id: "s", value: 1, seen: 10 }], read);
const survivedStale = fs.existsSync(LEAF);
const fresh = journal.publish([{ id: "s", value: 3, seen: 90 }], read);
console.log(JSON.stringify({ stale, survivedStale, fresh, survivedFresh: fs.existsSync(LEAF) }));
`;
    const out = await runChild(script);

    assert.equal(out.stale.uncovered, 1, "an output older than the input's record does not cover it");
    assert.equal(out.stale.reclaimed, 0, "and reclaims nothing");
    assert.equal(out.survivedStale, true, "the leaf survives the older output");
    assert.equal(out.fresh.uncovered, 0, "the newer output does dominate that record");
    assert.equal(out.survivedFresh, false, "so the leaf it covered is gone");
});

test("the real affinity store keeps a durable leaf its write bound capped out", { timeout: 60_000 }, async () => {
    const state = freshDir("store-bounds");
    const script = `
process.env.XDG_STATE_HOME = ${JSON.stringify(state)};
const fs = await import("node:fs");
const path = await import("node:path");
const { prefixAffinity } = await import(${JSON.stringify(AFFINITY_RESOLVER)});
const { flushPrefixAffinity } = await import(${JSON.stringify(AFFINITY)});

const dir = path.join(${JSON.stringify(state)}, "billion-context");
const journalDir = path.join(dir, "prefix-affinity.json.journal");
fs.mkdirSync(journalDir, { recursive: true });
// A foreign leaf holding a chain this process never saw. Give it the OLDEST
// lastSeen so the store's 1024-chain cap drops it from the next write.
const leaf = "pub-1-aaaaaaaaaaaaaaaa";
fs.mkdirSync(path.join(journalDir, leaf));
fs.writeFileSync(path.join(journalDir, leaf, ${JSON.stringify(SNAPSHOT_PAYLOAD)}), JSON.stringify({ version: 1, entries: [
    { sessionId: "capped-out", depth: 1, tailHash: "t", itemHashes: ["h"], lastSeen: 1 },
]}));

// Fill the in-memory store past the cap with strictly newer chains, so the
// write's normalizeForWrite drops the foreign one.
const many = Array.from({ length: 1100 }, (_, i) => ({ sessionId: "s" + i, depth: 1, tailHash: "t" + i, itemHashes: ["h" + i], lastSeen: 1000 + i }));
prefixAffinity.importSnapshot(many);
flushPrefixAffinity();

const leavesAfter = fs.readdirSync(journalDir).filter((n) => n.startsWith("pub-"));
const cappedOutStillThere = fs.existsSync(path.join(journalDir, leaf, ${JSON.stringify(SNAPSHOT_PAYLOAD)}));
const retained = JSON.parse(fs.readFileSync(path.join(journalDir, leaf, ${JSON.stringify(SNAPSHOT_PAYLOAD)}), "utf8"));
const cappedOutReadable = retained.entries.some((entry) => entry.sessionId === "capped-out");
console.log(JSON.stringify({ leavesAfter: leavesAfter.length, cappedOutStillThere, cappedOutReadable }));
`;
    const out = await runChild(script);

    assert.equal(out.cappedOutStillThere, true, "the store's own chain cap dropped that record, so its leaf stayed on disk");
    assert.equal(out.cappedOutReadable, true, "the retained generation still contains the complete capped-out record");
});

// ─── child harness ───

/** Run `script` in a fresh Node process with the repo's TS loader and return
 *  its single JSON verdict line. Children are used because each test pins its
 *  own XDG state dir before the store modules load, and because the journal's
 *  module-scope state must start cold. */
/** The child's verdict is dynamic JSON (nested census/publish shapes), so it is
 *  typed loosely here and narrowed at each assertion. */
type ChildVerdict = Record<string, any>;

function runChild(script: string): Promise<ChildVerdict> {
    const { promise, resolve, reject } = deferred<ChildVerdict>();
    const child = spawn(process.execPath, ["--import", TSX_IMPORT, "--input-type=module", "-e", script], {
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
        err += d.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
        if (code !== 0) {
            reject(new Error(`child exited ${code}\n${err.slice(-4000)}`));
            return;
        }
        const line = out
            .trim()
            .split("\n")
            .filter((l) => l.startsWith("{"))
            .pop();
        if (!line) {
            reject(new Error(`child printed no JSON\nstdout: ${out.slice(-2000)}\nstderr: ${err.slice(-2000)}`));
            return;
        }
        resolve(JSON.parse(line) as ChildVerdict);
    });
    return promise;
}
