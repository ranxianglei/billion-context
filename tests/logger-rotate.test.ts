import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureLogger, closeLogger, log } from "../src/logger.ts";

const MAX_BYTES = 10 * 1024 * 1024;

test("log rotation keeps at most one .old generation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logrot-"));
    const p = path.join(dir, "bili.log");
    try {
        // Round 1: a full-size file triggers rotation on the first write.
        fs.writeFileSync(p, Buffer.alloc(MAX_BYTES, 65));
        configureLogger(p);
        log("info", "gen-b");
        assert.ok(fs.existsSync(p + ".old"), "rotation produced .old");
        assert.ok(fs.statSync(p + ".old").size >= MAX_BYTES);
        closeLogger();

        // Round 2: a pre-existing .old (sentinel) must be dropped, not kept
        // alongside the new one.
        fs.writeFileSync(p, Buffer.alloc(MAX_BYTES, 66));
        fs.writeFileSync(p + ".old", "sentinel-old-generation");
        configureLogger(p);
        log("info", "gen-c");
        assert.ok(fs.existsSync(p + ".old"));
        const old = fs.readFileSync(p + ".old");
        assert.ok(!old.includes("sentinel"), "previous .old generation was deleted");
        assert.ok(old.length >= MAX_BYTES);
        closeLogger();
    } finally {
        closeLogger();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
