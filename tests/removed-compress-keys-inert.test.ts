import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfigFile, parseCompressSettings } from "../src/config.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

type Captured = { level: string; msg: string };

function captureLogs(): { captured: Captured[]; stop: () => void } {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    return { captured, stop: () => setLogCapture(null) };
}

function withConfigFile(body: string, fn: () => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-removed-keys-"));
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

// Warnings for the removed-key family only (other INERT emitters exist too).
const familyWarns = (captured: Captured[]) =>
    captured.filter((e) => e.level === "warn" && e.msg.includes("is INERT") && /absorb|imageCompression/.test(e.msg));

// `absorb` was removed by #3293 but REVIVED by #3402/#3422 — it parses again
// and is NOT inert; only imageCompression (#3266) stays in the removed family.
test("#3344: removed compress.imageCompression warns INERT once (root level) and is ignored; revived absorb parses", () => {
    const { captured, stop } = captureLogs();
    withConfigFile(
        `{"compress":{"absorb":{"enabled":true,"minToolTokens":500},"imageCompression":{"enabled":true,"quality":60}}}`,
        () => {
            const cfg = loadConfigFile();
            const cs = parseCompressSettings(cfg.compress ?? {});
            assert.deepEqual((cs as Record<string, unknown>).absorb, { enabled: true, minToolTokens: 500 });
            assert.equal((cs as Record<string, unknown>).imageCompression, undefined);
            const warns = familyWarns(captured);
            assert.equal(warns.length, 1, `expected exactly one family INERT warning, got: ${warns.map((w) => w.msg).join(" | ")}`);
            assert.doesNotMatch(warns[0]!.msg, /compress\.absorb/);
            assert.match(warns[0]!.msg, /compress\.imageCompression/);
            assert.match(warns[0]!.msg, /was removed/);
            // Second load of the SAME content: deduped (one notice per process).
            loadConfigFile();
            assert.equal(familyWarns(captured).length, 1);
        },
    );
    stop();
});

test("#3344: removed key at provider and model levels is named by full path; provider-level absorb does not warn", () => {
    const { captured, stop } = captureLogs();
    withConfigFile(
        `{"providers":{"https://u.example":{"compress":{"absorb":{"enabled":true}},"models":{"gpt-x":{"compress":{"imageCompression":{"enabled":true}}}}}}}`,
        () => {
            loadConfigFile();
            const warns = familyWarns(captured);
            assert.equal(warns.length, 1, `expected exactly one family INERT warning, got: ${warns.map((w) => w.msg).join(" | ")}`);
            assert.doesNotMatch(warns[0]!.msg, /compress\.absorb/);
            assert.match(warns[0]!.msg, /providers\["https:\/\/u\.example"\]\.models\["gpt-x"\]\.compress\.imageCompression/);
        },
    );
    stop();
});

test("#3344: configs without the removed keys stay silent", () => {
    const { captured, stop } = captureLogs();
    withConfigFile(`{"compress":{"ccr":{"enabled":true}}}`, () => {
        loadConfigFile();
        assert.equal(familyWarns(captured).length, 0);
    });
    stop();
});
