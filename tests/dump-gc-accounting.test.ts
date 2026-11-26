import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gcDebugDir } from "../src/state-gc.ts";
import { rmrf } from "./tmp-rm.ts";

for (const withAge of [false, true]) {
    test(`failed unlink stays in byte accounting (age pass: ${withAge})`, (t) => {
        const dir = fs.mkdtempSync(path.join(tmpdir(), "bili-gc-failed-unlink-"));
        const now = Date.parse("2026-11-09T00:00:00Z");
        const locked = path.join(dir, "old-locked.txt");
        const originalUnlink = fs.unlinkSync;
        try {
            for (const [name, size, age] of [
                ["old-locked.txt", 90, 3_600_000],
                ["middle.txt", 60, 2_000],
                ["newest.txt", 60, 1_000],
            ] as const) {
                const file = path.join(dir, name);
                fs.writeFileSync(file, Buffer.alloc(size));
                const time = new Date(now - age);
                fs.utimesSync(file, time, time);
            }
            t.mock.method(fs, "unlinkSync", (file: fs.PathLike): void => {
                if (file === locked) throw Object.assign(new Error("locked"), { code: "EPERM" });
                originalUnlink(file);
            });
            syncBuiltinESMExports();
            const removed = gcDebugDir(dir, { maxBytes: 100, ...(withAge ? { maxAgeMs: 60_000 } : {}) }, now);
            assert.equal(removed, 2);
            assert.deepEqual(fs.readdirSync(dir), ["old-locked.txt"]);
            assert.equal(fs.statSync(locked).size, 90);
        } finally {
            t.mock.restoreAll();
            syncBuiltinESMExports();
            rmrf(dir);
        }
    });
}
