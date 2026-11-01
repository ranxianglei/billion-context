import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    applyLogRetention,
    chmodPrivateFile,
    configureLogRetention,
    defaultLogRetentionPolicy,
    generationStamp,
    logCoverage,
    logGenerations,
    LOG_DIR_MODE,
    LOG_FILE_MODE,
    LOG_RETENTION_BUDGET_BYTES,
    LOG_RETENTION_TARGET_MS,
    LOG_SEGMENT_BYTES,
    migrateLegacyOld,
    sealActiveLog,
    stampNewLog,
} from "../src/log-retention.ts";
import { continuityOf, formatWindow, oldestLogLineMs } from "../src/log-retention-coverage.ts";
import { rmrf } from "./tmp-rm.ts";

const HOUR = 60 * 60 * 1000;

function tmpDir(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `bili-ret-${tag}-`));
}

/** Archive directory the helper owns for a log path. */
function archiveOf(logPath: string): string {
    return `${logPath}.archive`;
}

/** Plant a sealed generation directly on disk, the way the helper lays one out:
 *  `<log>.archive/<stamp>-<pid>-<n>/bili.log`. Returns the payload path. */
function writeGeneration(logPath: string, at: number, bytes: number, counter: string, pid = 1111): string {
    const dir = path.join(archiveOf(logPath), `${generationStamp(at)}-${pid}-${counter}`);
    fs.mkdirSync(dir, { recursive: true, mode: LOG_DIR_MODE });
    const file = path.join(dir, "bili.log");
    const head = `${new Date(at).toISOString().slice(0, 23)} [info] [v=0] seal ${counter}\n`;
    fs.writeFileSync(file, head + "x".repeat(Math.max(0, bytes - head.length)));
    return file;
}

test("defaults: 48h target, 256 MiB budget, 10 MiB segments", () => {
    const p = defaultLogRetentionPolicy();
    assert.equal(p.targetMs, LOG_RETENTION_TARGET_MS);
    assert.equal(p.targetMs, 48 * HOUR);
    assert.equal(p.budgetBytes, LOG_RETENTION_BUDGET_BYTES);
    assert.equal(p.budgetBytes, 256 * 1024 * 1024);
    assert.equal(p.segmentBytes, LOG_SEGMENT_BYTES);
});

test("configureLogRetention falls back per field and caps a segment to the budget", () => {
    try {
        const p = configureLogRetention({ targetMs: 0, budgetBytes: Number.NaN, segmentBytes: 8 * 1024 * 1024 * 1024 });
        assert.equal(p.targetMs, LOG_RETENTION_TARGET_MS, "non-positive target falls back");
        assert.equal(p.budgetBytes, LOG_RETENTION_BUDGET_BYTES, "NaN budget falls back");
        assert.ok(p.segmentBytes <= p.budgetBytes, "a segment larger than the budget is capped");
    } finally {
        configureLogRetention({});
    }
});

test("budget wins: the chronologically oldest generations go first", () => {
    const dir = tmpDir("budget");
    const p = path.join(dir, "bili.log");
    try {
        const now = Date.now();
        const a = writeGeneration(p, now - 30 * HOUR, 1024 * 1024, "1");
        const b = writeGeneration(p, now - 20 * HOUR, 1024 * 1024, "2");
        const c = writeGeneration(p, now - 10 * HOUR, 1024 * 1024, "3");
        fs.writeFileSync(p, "active\n");
        const policy = { ...defaultLogRetentionPolicy(), budgetBytes: 2.5 * 1024 * 1024 };
        const r = applyLogRetention(p, policy, now);
        assert.deepEqual(r.removed, [a], "exactly the oldest generation was removed");
        assert.ok(fs.existsSync(b) && fs.existsSync(c), "newer generations survive");
        assert.ok(fs.existsSync(p), "the active file is never deleted");
        assert.equal(fs.existsSync(a), false, "the payload is gone");
        assert.equal(fs.existsSync(path.dirname(a)), false, "its emptied generation directory is gone too");
        assert.equal(r.coverage.targetSpanMet, false);
        assert.equal(r.coverage.shortfall, "budget", "a completed trim names the budget");
    } finally {
        rmrf(dir);
    }
});

test("budget deletion never prefers a newer generation over older legacy bytes", () => {
    const dir = tmpDir("order");
    const p = path.join(dir, "bili.log");
    try {
        const now = Date.now();
        // Legacy history is the OLDEST thing on disk; a stamped generation is newer.
        fs.writeFileSync(`${p}.old`, `${new Date(now - 40 * HOUR).toISOString().slice(0, 23)} [info] legacy\n` + "y".repeat(1024 * 1024));
        fs.utimesSync(`${p}.old`, new Date(now - 40 * HOUR), new Date(now - 40 * HOUR));
        const newer = writeGeneration(p, now - 2 * HOUR, 1024 * 1024, "1");
        fs.writeFileSync(p, "active\n");
        const r = applyLogRetention(p, { ...defaultLogRetentionPolicy(), budgetBytes: 1.5 * 1024 * 1024 }, now);
        assert.deepEqual(r.removed, [`${p}.old`], "the oldest bytes (legacy) were reclaimed, not the newer generation");
        assert.ok(fs.existsSync(newer), "newer history is preserved");
    } finally {
        rmrf(dir);
    }
});

test("budget enforcement keeps going until under the cap", () => {
    const dir = tmpDir("budget2");
    const p = path.join(dir, "bili.log");
    try {
        const now = Date.now();
        for (let i = 1; i <= 5; i++) writeGeneration(p, now - (6 - i) * HOUR, 512 * 1024, String(i));
        fs.writeFileSync(p, "active\n");
        const policy = { ...defaultLogRetentionPolicy(), budgetBytes: 600 * 1024 };
        const r = applyLogRetention(p, policy, now);
        assert.ok(r.removed.length >= 3, `removed ${r.removed.length} of 5`);
        assert.ok(r.totalBytes <= policy.budgetBytes, `total ${r.totalBytes} within budget ${policy.budgetBytes}`);
        const gens = logGenerations(p);
        assert.equal(gens.filter((g) => g.active).length, 1);
        assert.deepEqual(gens.filter((g) => !g.active).map((g) => path.basename(g.path)), ["bili.log"], "the survivors are the newest generations");
    } finally {
        rmrf(dir);
    }
});

test("no trim when already within budget, and a young span is not blamed on the budget", () => {
    const dir = tmpDir("nobudget");
    const p = path.join(dir, "bili.log");
    try {
        const now = Date.now();
        writeGeneration(p, now - 2 * HOUR, 4096, "1");
        fs.writeFileSync(p, "active\n");
        const r = applyLogRetention(p, defaultLogRetentionPolicy(), now);
        assert.deepEqual(r.removed, []);
        assert.equal(r.coverage.targetSpanMet, false, "a 2h span does not reach the 48h target");
        assert.equal(r.coverage.shortfall, "unknown-history", "nothing was trimmed, so the budget is not blamed");
    } finally {
        rmrf(dir);
    }
});

test("a live file over budget is reported, never silently truncated or deleted", () => {
    const dir = tmpDir("activeonly");
    const p = path.join(dir, "bili.log");
    try {
        const now = Date.now();
        const policy = configureLogRetention({ budgetBytes: 4096 });
        // The active file alone exceeds the budget: nothing else exists to reclaim,
        // and the sink the logger appends to must never be deleted or truncated.
        fs.writeFileSync(p, "x".repeat(16 * 1024) + "\n");
        const r = applyLogRetention(p, policy, now);
        assert.deepEqual(r.removed, [], "the live sink is not a deletion candidate");
        assert.equal(r.activeOnlyExcess, true, "the excess is reported as its own fact");
        assert.ok(r.totalBytes > policy.budgetBytes);
        assert.ok(fs.existsSync(p));
        assert.equal(fs.statSync(p).size, 16 * 1024 + 1, "the active bytes are untouched");
        assert.match(r.coverage.message, /exceeds the 4 KiB budget/);
    } finally {
        configureLogRetention({});
        rmrf(dir);
    }
});

test("a span reaching the target still refuses to claim continuity", () => {
    const dir = tmpDir("complete");
    const p = path.join(dir, "bili.log");
    try {
        const now = Date.now();
        writeGeneration(p, now - 50 * HOUR, 4096, "1");
        fs.writeFileSync(p, "active\n");
        const cov = logCoverage(p, defaultLogRetentionPolicy(), now);
        assert.equal(cov.targetSpanMet, true, "the measured span reaches the target");
        assert.equal(cov.shortfall, null);
        assert.equal(cov.continuity, "unknown", "no lineage evidence proves the window is unbroken");
        assert.ok(formatWindow(cov.spanMs).startsWith("2d"), `span renders as a window: ${formatWindow(cov.spanMs)}`);
    } finally {
        rmrf(dir);
    }
});

test("out-of-order stamps are NOT evidence of missing history", () => {
    const dir = tmpDir("gap");
    const p = path.join(dir, "bili.log");
    try {
        const now = Date.now();
        writeGeneration(p, now - 10 * HOUR, 64, "1");
        // A LATER-named generation holding OLDER lines. Clock steps, overlapping
        // writers and legacy migration all produce this without losing anything,
        // so continuity must stay unknown rather than accusing the set of a hole.
        writeGeneration(p, now - 40 * HOUR, 64, "2");
        fs.writeFileSync(p, "active\n");
        assert.equal(continuityOf(logGenerations(p)), "unknown", "an inverted stamp is not proof of loss");
        const cov = logCoverage(p, defaultLogRetentionPolicy(), now);
        assert.equal(cov.continuity, "unknown");
        assert.equal(cov.targetSpanMet, false, "the 40h measured span is short of the 48h target");
    } finally {
        rmrf(dir);
    }
});

test("an unreadable generation leaves a lower bound, and availability is a separate fact", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
    const dir = tmpDir("unreadable");
    const p = path.join(dir, "bili.log");
    let blocked = "";
    try {
        const now = Date.now();
        writeGeneration(p, now - 50 * HOUR, 64, "1");
        // Enumerated as a file but unopenable: the read path must notice, not skip.
        blocked = writeGeneration(p, now - 1 * HOUR, 64, "2");
        fs.chmodSync(blocked, 0o000);
        fs.writeFileSync(p, "active\n");
        const cov = logCoverage(p, defaultLogRetentionPolicy(), now);
        assert.equal(cov.unreadable, 1, "the unreadable generation is counted");
        assert.equal(cov.available, false, "availability is reported separately");
        assert.equal(cov.targetSpanMet, true, "the span over the readable subset still measures 50h — span and availability are independent facts");
        assert.match(cov.message, /unreadable/, "the message states the lower bound");
        assert.match(cov.message, /lower bound/);
    } finally {
        if (blocked) { try { fs.chmodSync(blocked, 0o600); } catch { /* already gone */ } }
        rmrf(dir);
    }
});

test("no readable history at all reports unavailability, not a healthy empty window", () => {
    const dir = tmpDir("novisible");
    const p = path.join(dir, "bili.log");
    try {
        const now = Date.now();
        const only = writeGeneration(p, now - 50 * HOUR, 64, "1");
        fs.rmSync(only);
        fs.mkdirSync(only); // a payload name that is not a readable file
        const cov = logCoverage(p, defaultLogRetentionPolicy(), now);
        assert.equal(cov.targetSpanMet, false);
        assert.equal(cov.shortfall, "unknown-history");
        assert.match(cov.message, /no dated log history|retained history unavailable/);
    } finally {
        rmrf(dir);
    }
});

test("quiet periods between generations are not gaps", () => {
    const dir = tmpDir("quiet");
    const p = path.join(dir, "bili.log");
    try {
        const now = Date.now();
        writeGeneration(p, now - 30 * HOUR, 64, "1");
        writeGeneration(p, now - 1 * HOUR, 64, "2"); // 29h with no writes at all
        fs.writeFileSync(p, "active\n");
        assert.equal(continuityOf(logGenerations(p)), "unknown", "silence is normal, not evidence of a hole");
    } finally {
        rmrf(dir);
    }
});

test("a read-time shortfall never guesses the cause", () => {
    const dir = tmpDir("read");
    const p = path.join(dir, "bili.log");
    try {
        const now = Date.now();
        writeGeneration(p, now - 3 * HOUR, 4096, "1");
        fs.writeFileSync(p, "active\n");
        const cov = logCoverage(p, defaultLogRetentionPolicy(), now);
        assert.equal(cov.targetSpanMet, false);
        assert.equal(cov.shortfall, "incomplete", "a probe cannot tell young history from a budget trim");
    } finally {
        rmrf(dir);
    }
});

test("empty history is honest, not complete", () => {
    const dir = tmpDir("empty");
    try {
        const cov = logCoverage(path.join(dir, "bili.log"), defaultLogRetentionPolicy(), Date.now());
        assert.equal(cov.targetSpanMet, false);
        assert.equal(cov.oldestLineMs, null);
        assert.equal(cov.oldestAgeMs, null);
        assert.equal(cov.shortfall, "unknown-history");
    } finally {
        rmrf(dir);
    }
});

test("legacy .old is migrated under its OWN stamp, keeping its place in history", () => {
    const dir = tmpDir("legacy");
    const p = path.join(dir, "bili.log");
    try {
        const now = Date.now();
        const at = now - 26 * HOUR;
        fs.writeFileSync(`${p}.old`, `${new Date(at).toISOString()} [info] legacy line\n`);
        fs.utimesSync(`${p}.old`, new Date(at), new Date(at));
        const alreadySealed = writeGeneration(p, now - 2 * HOUR, 64, "1");
        fs.writeFileSync(p, "active\n");
        assert.equal(logGenerations(p).find((g) => g.legacy)?.path, `${p}.old`, "the legacy artifact is enumerated before migration");

        const m = migrateLegacyOld(p);
        assert.ok(m.sealed, "migration produced a generation");
        assert.equal(fs.existsSync(`${p}.old`), false, "the legacy name is consumed");

        const gens = logGenerations(p);
        assert.ok(!gens.some((g) => g.legacy), "no legacy artifact remains");
        const order = gens.filter((g) => !g.active).map((g) => g.path);
        assert.deepEqual(order, [m.sealed, alreadySealed], "older legacy bytes order BEFORE the newer generation they predate");
        const oldest = oldestLogLineMs(gens).oldest;
        assert.ok(oldest !== null && Math.abs(oldest - at) < 2000, "migrated history keeps its own age, not the migration time");

        assert.equal(migrateLegacyOld(p).sealed, null, "idempotent: a second call is a no-op");
    } finally {
        rmrf(dir);
    }
});

test("sealing renames (never copies) and leaves the active path free for the next session", () => {
    const dir = tmpDir("seal");
    const p = path.join(dir, "bili.log");
    try {
        fs.writeFileSync(p, "line-a\nline-b\n");
        const { sealed } = sealActiveLog(p);
        assert.ok(sealed);
        assert.equal(fs.readFileSync(sealed!, "utf8"), "line-a\nline-b\n");
        assert.equal(fs.existsSync(p), false, "the active path is gone until the logger reopens it");
        assert.equal(fs.statSync(path.dirname(sealed!)).isDirectory(), true, "the payload lives inside its own generation directory");
        assert.equal(sealActiveLog(p).sealed, null, "sealing nothing is a no-op");
    } finally {
        rmrf(dir);
    }
});

test("concurrent sealers never share a generation directory", async () => {
    const dir = tmpDir("race");
    const p = path.join(dir, "bili.log");
    try {
        const at = Date.UTC(2026, 10, 1, 0, 0, 0, 0);
        // The name claim is an atomic mkdir, so REAL concurrent sealers (separate
        // processes, same instant) must each land in their own generation. A
        // sequential same-process loop would not test the claim at all: the
        // second seal would simply see the first name already taken.
        const helper = path.join(dir, "seal-worker.ts");
        // A literal, author-time specifier is not possible here: the helper runs in
        // a temp directory, so it must resolve the module by absolute URL.
        const retentionUrl = new URL("../src/log-retention.ts", import.meta.url).href;
        fs.writeFileSync(helper, [
            'import { writeFileSync } from "node:fs";',
            `import { sealActiveLog } from ${JSON.stringify(retentionUrl)};`,
            "const [logPath, at] = process.argv.slice(2);",
            'writeFileSync(logPath, `payload-${process.pid}\\n`);',
            "process.stdout.write(JSON.stringify({ sealed: sealActiveLog(logPath, Number(at)).sealed }));",
        ].join("\n"));
        // Launch all sealers before any is reaped: they race on the same instant
        // and the same active path, which is the condition the mkdir claim must
        // survive. (They still serialize on the payload write; what matters is
        // that no two of them can claim one archive name.)
        const kids = [0, 1, 2, 3].map(() =>
            spawn(process.execPath, ["--import", "tsx", helper, p, String(at)], { stdio: ["ignore", "pipe", "pipe"] }));
        const outs = await Promise.all(kids.map((k) => {
            const { promise, resolve, reject } = Promise.withResolvers<string>();
            let out = "";
            let err = "";
            k.stdout.on("data", (d: Buffer) => { out += d.toString(); });
            k.stderr.on("data", (d: Buffer) => { err += d.toString(); });
            k.on("error", reject);
            k.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`sealer exited ${code}: ${err}`))));
            return promise;
        }));
        const sealed: string[] = [];
        for (const out of outs) {
            const parsed = JSON.parse(out) as { sealed: string | null };
            // A racer that lost both the rename and the payload is expected to report
            // null; what must hold is that no two winners name one directory.
            if (parsed.sealed) sealed.push(parsed.sealed);
        }
        // Only the sealers that actually won a name report one; what must never
        // happen is two winners pointing at the same directory.
        assert.ok(sealed.length >= 1, "at least one concurrent sealer won a generation name");
        assert.equal(new Set(sealed).size, sealed.length, "no two sealers shared a generation directory");
        for (const f of sealed) {
            assert.equal(path.basename(f), "bili.log", "each payload sits in its own directory");
            assert.match(path.basename(path.dirname(f)), /^\d{8}T\d{9}-\d+-\d+$/);
        }
        // Every claimed generation is enumerable after the race.
        assert.equal(logGenerations(p).filter((g) => !g.active).length, sealed.length, "the archive holds exactly the claimed generations");
    } finally {
        rmrf(dir);
    }
});

test("an existing generation directory is never taken over", () => {
    const dir = tmpDir("owned");
    const p = path.join(dir, "bili.log");
    try {
        const at = Date.UTC(2026, 10, 1, 0, 0, 0, 0);
        // Occupy every name this process would try, exactly as a competing writer
        // would: the seal must fail to claim rather than overwrite.
        const archive = archiveOf(p);
        fs.mkdirSync(archive, { recursive: true, mode: LOG_DIR_MODE });
        const stamp = generationStamp(at);
        for (let counter = 1; counter <= 1000; counter++) {
            fs.mkdirSync(path.join(archive, `${stamp}-${process.pid}-${counter}`), { mode: LOG_DIR_MODE });
        }
        fs.writeFileSync(p, "payload\n");
        assert.equal(sealActiveLog(p, at).sealed, null, "no free name means no seal");
        assert.equal(fs.readFileSync(p, "utf8"), "payload\n", "the active file is untouched when the seal cannot own a name");
    } finally {
        rmrf(dir);
    }
});

test("new files are 0600, sealed payloads are 0600 and directories are 0700", { skip: process.platform === "win32" }, () => {
    const dir = tmpDir("perm");
    const p = path.join(dir, "bili.log");
    try {
        stampNewLog(p, "first line\n");
        assert.equal(fs.statSync(p).mode & 0o777, LOG_FILE_MODE, "created owner-only regardless of umask");
        fs.chmodSync(p, 0o644);
        assert.equal(fs.statSync(p).mode & 0o777, 0o644);
        chmodPrivateFile(p);
        assert.equal(fs.statSync(p).mode & 0o777, LOG_FILE_MODE, "an adopted file is repaired");

        const { sealed } = sealActiveLog(p);
        assert.ok(sealed);
        assert.equal(fs.statSync(sealed!).mode & 0o777, LOG_FILE_MODE, "a sealed payload is owner-only");
        assert.equal(fs.statSync(path.dirname(sealed!)).mode & 0o777, LOG_DIR_MODE, "its generation directory is traversable by the owner");
        assert.equal(fs.statSync(archiveOf(p)).mode & 0o777, LOG_DIR_MODE, "the archive directory is traversable by the owner");
    } finally {
        rmrf(dir);
    }
});

test("generation names are filename-safe, sortable and parse back", () => {
    const at = Date.UTC(2026, 10, 1, 9, 3, 12, 345);
    assert.equal(generationStamp(at), "20261101T090312345");
    assert.ok(!generationStamp(at).includes(":"), "no NTFS-illegal colon");
    const dir = tmpDir("name");
    const p = path.join(dir, "bili.log");
    try {
        writeGeneration(p, at, 64, "42", 7);
        const gens = logGenerations(p);
        assert.equal(gens.length, 1);
        assert.equal(gens[0]!.sealedAt, at, "the UTC stamp in the name is the ordering key");
        assert.equal(gens[0]!.seq, 42, "the creation counter breaks same-instant ties");
        assert.equal(path.basename(path.dirname(gens[0]!.path)), `${generationStamp(at)}-7-42`, "the directory name carries stamp, owner pid and counter");
    } finally {
        rmrf(dir);
    }
});

test("a foreign entry in the archive directory is ignored, not misread", () => {
    const dir = tmpDir("foreign");
    const p = path.join(dir, "bili.log");
    try {
        fs.mkdirSync(path.join(archiveOf(p), "not-a-generation"), { recursive: true });
        fs.writeFileSync(path.join(archiveOf(p), "not-a-generation", "bili.log"), "x\n");
        fs.writeFileSync(path.join(archiveOf(p), "stray.txt"), "x\n");
        assert.deepEqual(logGenerations(p), [], "only well-formed generation directories are enumerated");
    } finally {
        rmrf(dir);
    }
});

test("a generation directory without its payload is a seal in flight, not a generation", () => {
    const dir = tmpDir("inflight");
    const p = path.join(dir, "bili.log");
    try {
        const at = Date.now();
        fs.mkdirSync(path.join(archiveOf(p), `${generationStamp(at)}-1-1`), { recursive: true });
        assert.deepEqual(logGenerations(p), []);
    } finally {
        rmrf(dir);
    }
});

test("the active file is enumerated last and no generation is ever reported twice", () => {
    const dir = tmpDir("enum");
    const p = path.join(dir, "bili.log");
    try {
        const now = Date.now();
        writeGeneration(p, now - 5 * HOUR, 64, "1");
        writeGeneration(p, now - 3 * HOUR, 64, "2");
        fs.writeFileSync(p, "active\n");
        fs.writeFileSync(`${p}.old`, "legacy\n");
        const gens = logGenerations(p);
        assert.equal(gens.length, 4);
        assert.equal(gens.at(-1)!.active, true);
        assert.equal(gens.filter((g) => g.active).length, 1);
        assert.equal(new Set(gens.map((g) => g.path)).size, gens.length);
    } finally {
        rmrf(dir);
    }
});
