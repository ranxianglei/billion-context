import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PORT_LOG_MAX_BYTES, rotatePortLogIfNeeded } from "../src/launcher.ts";
import { rmrf } from "./tmp-rm.ts";

test("port log under the cap is left untouched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-portlog-"));
    const file = path.join(dir, "bili-proxy-18792.log");
    fs.writeFileSync(file, "x".repeat(PORT_LOG_MAX_BYTES - 1));
    try {
        rotatePortLogIfNeeded(file);
        assert.equal(fs.statSync(file).size, PORT_LOG_MAX_BYTES - 1);
        assert.ok(!fs.existsSync(`${file}.old`));
    } finally {
        rmrf(dir);
    }
});

test("port log at/over the cap rotates to a single .old generation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-portlog-"));
    const file = path.join(dir, "bili-proxy-18792.log");
    fs.writeFileSync(file, "gen1");
    try {
        // first rotation: nothing to do (small)
        rotatePortLogIfNeeded(file);
        assert.ok(!fs.existsSync(`${file}.old`));

        fs.writeFileSync(file, "gen1".repeat(1024 * 1024), { flag: "a" });
        fs.appendFileSync(file, "x".repeat(PORT_LOG_MAX_BYTES - fs.statSync(file).size + 1));
        rotatePortLogIfNeeded(file);
        assert.ok(!fs.existsSync(file), "rotated file must be gone until the next spawn reopens it");
        assert.ok(fs.statSync(`${file}.old`).size >= PORT_LOG_MAX_BYTES);

        // second rotation replaces .old — no unbounded generation chain
        fs.writeFileSync(file, "gen2");
        fs.appendFileSync(file, "y".repeat(PORT_LOG_MAX_BYTES));
        rotatePortLogIfNeeded(file);
        assert.ok(!fs.existsSync(`${file}.old.old`));
        const old = fs.readFileSync(`${file}.old`, "utf8");
        assert.ok(old.startsWith("gen2"), ".old must hold the newest generation only");
    } finally {
        rmrf(dir);
    }
});

test("missing or unreadable port log: no throw", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-portlog-"));
    try {
        rotatePortLogIfNeeded(path.join(dir, "never-created.log"));
    } finally {
        rmrf(dir);
    }
});
