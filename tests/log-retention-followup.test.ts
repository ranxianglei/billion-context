import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { WriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    configureLogRetention,
    defaultLogRetentionPolicy,
    generationStamp,
    logGenerations,
    LOG_DIR_MODE,
    sealActiveLog,
} from "../src/log-retention.ts";
import { closeLogger, configureLogger, log, logRetentionStatus } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

/** P22 follow-ups. Each case separates a property that is PROVEN BY
 *  CONSTRUCTION here (same-stamp destination claim from distinct sources; a
 *  buffered tail that a gated drain must not outrun) from the shared-active-
 *  pathname race, which stays an explicit issue5494 risk: an exclusive
 *  destination name is NOT exclusive source ownership, and no fixture change
 *  may make it look fixed. */

function tmpDir(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `bili-ret-followup-${tag}-`));
}

/** Every generation directory under the archive, including empty ones (a seal
 *  in flight) — the reader enumeration skips those, so conservation checks must
 *  not rely on it. */
function archiveDirs(logPath: string): string[] {
    try {
        return fs.readdirSync(`${logPath}.archive`)
            .filter((n) => /^\d{8}T\d{9}-\d{1,10}-\d{1,9}$/.test(n))
            .sort()
            .map((n) => path.join(`${logPath}.archive`, n));
    } catch {
        return [];
    }
}

/** Readable archive state: a failed conservation assertion must name a MISSING,
 *  UNREADABLE or RENAMED payload, not just a count mismatch. */
function describeArchive(logPath: string): string {
    const dirs = archiveDirs(logPath);
    if (dirs.length === 0) return "(archive empty)";
    return dirs.map((d) => {
        const payload = path.join(d, "bili.log");
        if (!fs.existsSync(payload)) return `  ${path.basename(d)}: MISSING payload`;
        try {
            return `  ${path.basename(d)}: ${fs.readFileSync(payload, "utf8").length}B`;
        } catch (err) {
            return `  ${path.basename(d)}: UNREADABLE payload (${(err as Error).message})`;
        }
    }).join("\n");
}

test("destination claim: four distinct same-stamp sources each own a generation, bytes exactly conserved", () => {
    // Deterministic claim regression: no spawns, no timing, no cross-process
    // write interleaving. Four DISTINCT source files (different inodes, distinct
    // payloads) are sealed into ONE destination namespace at ONE fixed stamp.
    // Each must claim its own counter slot and carry exactly its own bytes —
    // the property the atomic mkdir buys. Four writers racing the SAME active
    // pathname is a different, still-open property (issue5494, asserted below);
    // this case must never be read as covering it.
    const dir = tmpDir("claim");
    const at = Date.UTC(2026, 10, 1, 0, 0, 0, 0);
    const base = path.join(dir, "bili.log");
    const payloads = [0, 1, 2, 3].map((i) => `source-${i}-${"z".repeat(63 - i)}\n`);
    const sealed: { path: string; payload: string }[] = [];
    try {
        // Seal each distinct source in turn. `sealActiveLog` renames the file it
        // is given, so writing a NEW file between rounds is a NEW source, not a
        // re-seal of the same one; the archive namespace stays shared because it
        // derives from the base name.
        payloads.forEach((payload, i) => {
            fs.writeFileSync(base, payload);
            const { sealed: sealedPath } = sealActiveLog(base, at);
            assert.ok(sealedPath, `source ${i} must claim a generation, not fail silently:\n${describeArchive(base)}`);
            assert.equal(fs.existsSync(base), false, `the claimed source must be renamed away (round ${i})`);
            sealed.push({ path: sealedPath!, payload });
        });

        const stamp = generationStamp(at);
        const names = sealed.map((s) => path.basename(path.dirname(s.path)));
        // Distinct sources never share a name: four claims, four directories.
        assert.equal(new Set(names).size, names.length, `two sources shared a generation directory: ${names.join(", ")}`);
        // The counter is what makes a same-stamp, same-pid set unique.
        assert.deepEqual(names.map((n) => Number(n.split("-").at(-1))), [1, 2, 3, 4], `same-stamp claims must consume counters in order: ${names.join(", ")}`);
        for (const name of names) assert.ok(name.startsWith(`${stamp}-`), `every claim carries the fixed stamp: ${name}`);

        // Exact payload conservation: each generation holds precisely its own
        // source, in seal order. A blend or truncation fails here, and the
        // message names the mismatch instead of only the count.
        sealed.forEach((s, i) => {
            const onDisk = fs.readFileSync(s.path, "utf8");
            assert.equal(onDisk, s.payload, `generation ${i} does not hold its own complete source:\n  expected ${JSON.stringify(s.payload)}\n  actual   ${JSON.stringify(onDisk)}`);
        });

        // All four are enumerable as real (non-empty) generations, oldest first
        // by counter; nothing was reclaimed and no empty attempt directory is
        // mistaken for a generation.
        const enumerated = logGenerations(base).filter((g) => !g.active);
        assert.equal(enumerated.length, sealed.length, `archive generation count != claimed count:\n${describeArchive(base)}`);
        assert.deepEqual(enumerated.map((g) => g.seq), [1, 2, 3, 4], `enumeration order must follow the claim counters:\n${describeArchive(base)}`);
    } finally {
        rmrf(dir);
    }
});

test("issue5494: a shared active pathname is NOT exclusive source ownership", () => {
    // Executed documentation-by-assertion: the destination claim is a directory
    // `mkdir`, which says nothing about who owns the SOURCE. Two writers
    // appending to one pathname still lose bytes on the rename, and no fixture
    // may claim otherwise.
    const dir = tmpDir("shared-source-contract");
    const shared = path.join(dir, "shared.log");
    const at = Date.UTC(2026, 10, 1, 0, 0, 0, 0);
    try {
        fs.writeFileSync(shared, "writer-a\n");
        assert.ok(sealActiveLog(shared, at).sealed, "the first seal wins its destination");
        assert.equal(fs.existsSync(shared), false, "the rename removes the shared pathname");
        assert.equal(sealActiveLog(shared, at).sealed, null, "no source means no seal — never a fabricated archive");
        assert.equal(archiveDirs(shared).length, 1, "the losing sealer adds no generation");
    } finally {
        rmrf(dir);
    }
});

test("a held tail in the just-sealed generation survives the deferred reclamation", async () => {
    const dir = tmpDir("held-tail");
    const file = path.join(dir, "bili.log");
    const originalEnd = fs.WriteStream.prototype.end;
    const releaseCallbacks: Array<() => void> = [];
    const flushed: Promise<void>[] = [];
    const heldBytes: number[] = [];
    let finished = 0;
    const SEED_BYTES = 64;
    configureLogRetention({ segmentBytes: SEED_BYTES, budgetBytes: 1024 * 1024 });
    try {
        // configureLogger() writes its coverage diagnostic. With this tiny segment,
        // the first application line rotates that diagnostic and the second rotates
        // the sealed line: two real replaced streams must drain before reclamation.
        configureLogger(file);
        // Plant after the startup retention pass; only a deferred pass can remove it.
        const history = path.join(dir, "bili.log.archive", "20200101T000000000-1-1", "bili.log");
        fs.mkdirSync(path.dirname(history), { recursive: true, mode: LOG_DIR_MODE });
        fs.writeFileSync(history, "h".repeat(2 * 1024 * 1024));

        // Let each real end() flush its bytes, but hold its completion callback.
        // The finish events prove durable writes; only the callbacks open the
        // pendingRetentionDrains gate.
        fs.WriteStream.prototype.end = function (this: WriteStream, callback?: () => void) {
            if (callback) releaseCallbacks.push(callback);
            heldBytes.push(this.writableLength);
            const { promise, resolve } = Promise.withResolvers<void>();
            flushed.push(promise);
            this.once("finish", () => { finished++; resolve(); });
            const real = originalEnd as (this: WriteStream, cb?: () => void) => WriteStream;
            return real.call(this);
        } as typeof originalEnd;

        const sealedLine = `held-tail-sealed-${"s".repeat(SEED_BYTES)}`;
        log("info", sealedLine);
        const activeLine = "held-tail-in-new-active";
        log("info", activeLine);

        assert.equal(releaseCallbacks.length, 2, "both replaced streams must subscribe their completion callbacks");
        assert.equal(flushed.length, 2);
        assert.ok(heldBytes[1]! > 0, `the sealed-line stream must still hold buffered bytes (got ${String(heldBytes[1])})`);
        await Promise.all(flushed);
        assert.equal(finished, 2, "both real stream flushes completed while their callbacks were held");

        const beforeRelease = logGenerations(file).filter((g) => !g.active);
        assert.ok(fs.existsSync(history), `reclamation must wait for every replaced stream:\n${describeArchive(file)}`);
        const sealedTextBefore = beforeRelease.map((g) => fs.readFileSync(g.path, "utf8")).join("");
        assert.equal((sealedTextBefore.match(new RegExp(sealedLine, "g")) ?? []).length, 1, `the sealed line must appear exactly once before release:\n${describeArchive(file)}`);

        const firstDone = releaseCallbacks.shift()!;
        const lastDone = releaseCallbacks.shift()!;
        firstDone();
        assert.ok(fs.existsSync(history), "one still-pending drain must keep the retention gate closed");
        lastDone();
        assert.equal(fs.existsSync(history), false, `the final drain must run the deferred retention pass synchronously:\n${describeArchive(file)}`);

        const sealedTextAfter = logGenerations(file).filter((g) => !g.active).map((g) => fs.readFileSync(g.path, "utf8")).join("");
        assert.match(sealedTextAfter, new RegExp(sealedLine), `the sealed line must survive the deferred pass:\n${describeArchive(file)}`);
        fs.appendFileSync(file, "direct-append-after-drain\n");
        assert.match(fs.readFileSync(file, "utf8"), /direct-append-after-drain/, "direct appends still land on the active path");
        assert.match(fs.readFileSync(file, "utf8"), new RegExp(activeLine), "the post-rotation line stays on the active path");
    } finally {
        fs.WriteStream.prototype.end = originalEnd;
        await closeLogger();
        configureLogRetention(defaultLogRetentionPolicy());
        rmrf(dir);
    }
});

test("closeLogger drains its buffered tail before resolving", async () => {
    const dir = tmpDir("close-drain");
    const file = path.join(dir, "bili.log");
    configureLogger(file);
    try {
        log("info", "buffered-before-close");
        await closeLogger();
        assert.match(fs.readFileSync(file, "utf8"), /buffered-before-close/, "close resolves only after every buffered line drained");
        assert.equal(logRetentionStatus()?.available, true, "the retained set stays readable after close");
    } finally {
        configureLogRetention(defaultLogRetentionPolicy());
        rmrf(dir);
    }
});
