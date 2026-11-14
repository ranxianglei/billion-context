// #6662 regression gate: bounded boot must build the per-root file index in
// O(N), not O(N^2).
//
// bootBounded() indexed each root with
//   filesByRoot.set(root, [...(filesByRoot.get(root) ?? []), file])
// which re-copies every previously-accepted path reference for every new file —
// O(N^2) copies per root, and the work runs even when maxSessions=0 disables
// the decode window (#5219), so that cap could not remove it. With maxSessions=0
// the index walk+build is the only significant pre-listen work, so this gate
// times boot() over a large file tree and asserts the linear cost. The
// degenerate O(N^2) build measured ~3.6s for 20k files/root on the reporter's
// machine; the linear build is ~250ms. A bound near the geometric middle of
// that 14x gap separates the two with wide margin while staying far above
// realistic linear-run CI variance.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../src/persist.ts";

const FILES_PER_ROOT = 20_000;
const BOOT_TIME_BOUND_MS = 1000;

test("#6662: bounded boot builds the per-root file index in O(N)", { timeout: 90_000 }, async () => {
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const root = mkdtempSync(path.join(tmpdir(), "bili-6662-"));
    const dir = path.join(root, "sessions");
    const cold = `${dir}-cold`;
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    try {
        // The index build only walks filenames (with maxSessions=0 it never
        // decodes pre-listen), so the payload is a parseable stub, not a full
        // session record — keeps the 40k-file fixture cheap to write.
        for (const base of [dir, cold]) {
            const bucket = path.join(base, "_unknown");
            mkdirSync(bucket, { recursive: true });
            for (let i = 0; i < FILES_PER_ROOT; i++) {
                writeFileSync(path.join(bucket, `${i}.json`), '{"version":3}');
            }
        }
        const t0 = performance.now();
        const loaded = await store.boot({ maxSessions: 0, maxBytes: 64 * 1024 * 1024 });
        const elapsed = performance.now() - t0;
        assert.equal(loaded.size, 0);
        assert.ok(
            elapsed < BOOT_TIME_BOUND_MS,
            `bounded boot took ${elapsed.toFixed(1)}ms for ${FILES_PER_ROOT * 2} files (O(N^2) index copy?); bound ${BOOT_TIME_BOUND_MS}ms`,
        );
    } finally {
        store.closeQuietly();
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        rmSync(root, { recursive: true, force: true });
    }
});
