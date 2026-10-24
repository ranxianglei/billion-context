import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfigFile } from "../src/config.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

type Captured = { level: string; msg: string };

function captureLogs(): { captured: Captured[]; stop: () => void } {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    return { captured, stop: () => setLogCapture(null) };
}

function withConfigFile(body: string, fn: () => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-deadend-key-"));
    const file = path.join(dir, "billion-context.json");
    fs.writeFileSync(file, body);
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = file;
    try {
        fn();
    } finally {
        if (prev === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prev;
        rmrf(dir);
    }
}

const keyWarns = (captured: Captured[]) =>
    captured.filter((e) => e.level === "warn" && e.msg.includes("network.preflightDeadEndCooldownMs"));

test("#4105 follow-up: removed network.preflightDeadEndCooldownMs warns INERT once and is ignored", () => {
    const { captured, stop } = captureLogs();
    withConfigFile(
        `{"network":{"preflightHoldMs":30000,"preflightDeadEndCooldownMs":300000}}`,
        () => {
            const cfg = loadConfigFile();
            assert.equal((cfg.network as Record<string, unknown>).preflightHoldMs, 30000);
            const warns = keyWarns(captured);
            assert.equal(warns.length, 1, `expected exactly one INERT warning, got: ${warns.map((w) => w.msg).join(" | ")}`);
            assert.match(warns[0]!.msg, /is INERT/);
            assert.match(warns[0]!.msg, /#4079\/#4105/);
            // Second load of the SAME content: deduped (one notice per process).
            loadConfigFile();
            assert.equal(keyWarns(captured).length, 1);
        },
    );
    stop();
});

test("#4105 follow-up: configs without the removed key stay silent", () => {
    const { captured, stop } = captureLogs();
    withConfigFile(`{"network":{"preflightHoldMs":30000}}`, () => {
        loadConfigFile();
        assert.equal(keyWarns(captured).length, 0);
    });
    stop();
});
