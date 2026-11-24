import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureLogger, closeLogger, log } from "../src/logger.ts";
import { configureLogRetention, logGenerations } from "../src/log-retention.ts";
import { rmrf } from "./tmp-rm.ts";

const MAX_BYTES = 10 * 1024 * 1024;

test("log rotation preserves legacy and newly appended records", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logrot-"));
    const p = path.join(dir, "bili.log");
    try {
        // Round 1: a full-size file is sealed on the first write, and the sealed
        // generation keeps every byte of the old active file.
        fs.writeFileSync(p, Buffer.alloc(MAX_BYTES, 65));
        configureLogger(p);
        log("info", "gen-b");
        let gens = logGenerations(p);
        assert.equal(gens.length, 2, "one sealed generation plus the active file");
        assert.equal(gens.at(-1)!.active, true, "active file enumerates last");
        assert.equal(gens[0]!.active, false);
        assert.ok(gens[0]!.sizeBytes >= MAX_BYTES, "sealed generation kept its bytes");
        assert.equal(fs.readFileSync(gens[0]!.path).subarray(0, 8).toString(), "AAAAAAAA");
        await closeLogger();

        // Round 2: a legacy .old is migrated into the generation set, not
        // deleted — history survives the upgrade.
        fs.writeFileSync(p, Buffer.alloc(MAX_BYTES, 66));
        fs.writeFileSync(p + ".old", "sentinel-old-generation\n");
        configureLogger(p);
        log("info", "gen-c");
        const after = logGenerations(p);
        assert.ok(after.length >= 3, "migrated legacy history + new sealed generation + active");
        assert.equal(new Set(after.map((g) => g.path)).size, after.length, "no retained generation is duplicated");
        const legacy = after.find((g) => fs.readFileSync(g.path, "utf8").includes("sentinel"));
        assert.ok(legacy, "legacy .old content was migrated, never dropped");
        assert.equal(fs.existsSync(p + ".old"), false, "the legacy name is consumed by migration");
        await closeLogger();
    } finally {
        closeLogger();
        rmrf(dir);
    }
});

test("a synchronous burst retains every record in order across rotations", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logord-"));
    const p = path.join(dir, "bili.log");
    try {
        // Same instant, increasing sequence: order must come from the name.
        configureLogRetention({ segmentBytes: 64, budgetBytes: 1024 * 1024 });
        configureLogger(p);
        for (let i = 0; i < 40; i++) log("info", `line-${i}-${"x".repeat(40)}`);
        await closeLogger();
        const gens = logGenerations(p);
        assert.ok(gens.length > 2, `expected several sealed generations, got ${gens.length}`);
        const retained = gens.map((g) => fs.readFileSync(g.path, "utf8")).join("");
        const records = [...retained.matchAll(/ line-(\d+)-x+/g)].map((match) => Number(match[1]));
        assert.deepEqual(records, Array.from({ length: 40 }, (_, i) => i));
        assert.equal(gens.at(-1)!.active, true, "active file is always last");
    } finally {
        closeLogger();
        configureLogRetention({});
        rmrf(dir);
    }
});

test("successive rotations retain distinct payloads without overwriting", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logseq-"));
    const p = path.join(dir, "bili.log");
    try {
        configureLogRetention({ segmentBytes: 128, budgetBytes: 1024 * 1024 });
        configureLogger(p);
        for (let i = 0; i < 12; i++) log("info", `rot-${i}-${"y".repeat(60)}`);
        await closeLogger();
        const generations = logGenerations(p);
        const retained = generations.map((g) => fs.readFileSync(g.path, "utf8")).join("");
        const records = [...retained.matchAll(/ rot-(\d+)-y+/g)].map((match) => Number(match[1]));
        assert.deepEqual(records, Array.from({ length: 12 }, (_, i) => i));
    } finally {
        closeLogger();
        configureLogRetention({});
        rmrf(dir);
    }
});
