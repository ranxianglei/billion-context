import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Cross-process lock for tests that mutate a shared dist/ fixture file.
//
// tests/launcher.test.ts and tests/launcher-pi-inline.test.ts both juggle the
// same path <packageRoot>/dist/agent/pi.js: the "-e injected" tests create an
// empty stub when the checkout has no build, and the "refuses" tests rename
// the file away (or rm it) to force absence. scripts/run-ci-tests.mjs runs
// files with --test-concurrency 4 and the CI test job never builds dist/, so
// the two files routinely overlap: one test's rename/rm lands inside a
// concurrent test's runLaunch window, its fs.existsSync(piExt) check misses,
// the -e injection is skipped, and the assertion fails (flaky red on PR
// #6785, test ubuntu-22-1: "injected only when not installed" saw []).
//
// Presence and absence are mutually exclusive states of one path, so the
// fixture sites must run one at a time. node --test runs each file in its
// own process, so the lock must be cross-process (O_EXCL create). A crashed
// holder is handled by the stale mtime cutoff; release only removes a lock
// whose recorded pid is still ours, so a stolen lock is never deleted from
// under its new holder.
//
// LOCK_DIR is read at module load — before any test body mutates
// HOME/USERPROFILE — so the lock path is stable on every platform.
const LOCK_DIR = tmpdir();
const STALE_MS = 5 * 60 * 1000;
const WAIT_TIMEOUT_MS = 120 * 1000;
const RETRY_MS = 50;

// "wx" fails with EEXIST on POSIX and EPERM on Windows when the file already
// exists — both mean "someone holds the lock".
const LOCK_HELD_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

function lockPathFor(fixturePath: string): string {
    return path.join(LOCK_DIR, `bili-test-dist-fixture-${path.basename(fixturePath)}.lock`);
}

/**
 * Serialize access to a shared dist/ fixture file across concurrently
 * running test files. Call it BEFORE the first fixture read (existsSync /
 * stub create / rename away) and invoke the returned release in the test's
 * finally, AFTER the last fixture write (rmSync / rename back). Bounded
 * wait: a test that cannot acquire within WAIT_TIMEOUT_MS fails loudly
 * instead of hanging the shard.
 */
export async function acquireDistFixtureLock(fixturePath: string): Promise<() => void> {
    const lockPath = lockPathFor(fixturePath);
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    for (;;) {
        try {
            const fd = openSync(lockPath, "wx");
            writeFileSync(fd, `${process.pid}\n`);
            closeSync(fd);
            break;
        } catch (err) {
            if (!LOCK_HELD_CODES.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
            try {
                if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) {
                    unlinkSync(lockPath);
                    continue;
                }
            } catch {
                // lock vanished between the failed open and the stat — retry
            }
            if (Date.now() > deadline) {
                throw new Error(
                    `timed out after ${WAIT_TIMEOUT_MS}ms waiting for the dist fixture lock on ${fixturePath} (stale holder? lock: ${lockPath})`,
                );
            }
            await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        }
    }
    return () => {
        try {
            const content = readFileSync(lockPath, "utf8");
            if (content.startsWith(`${process.pid}\n`)) unlinkSync(lockPath);
        } catch {
            // lock already gone (stale-steal or manual cleanup) — nothing to release
        }
    };
}
