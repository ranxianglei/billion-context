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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-strip-removal-"));
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

test("#2607 follow-up: removed compress.stripImages warns INERT once and is ignored", () => {
    const { captured, stop } = captureLogs();
    withConfigFile(
        `{"compress":{"stripImages":true,"stripImagesKeepRecent":7}}`,
        () => {
            const cfg = loadConfigFile();
            // The keys are gone from the typed surface — loadConfigFile returns
            // the raw object but parseCompressSettings no longer carries them.
            const cs = parseCompressSettings(cfg.compress ?? {});
            assert.equal((cs as Record<string, unknown>).stripImages, undefined);
            assert.equal((cs as Record<string, unknown>).stripImagesKeepRecent, undefined);
            const warns = captured.filter((e) => e.level === "warn" && e.msg.includes("is INERT") && e.msg.includes("stripImages"));
            assert.equal(warns.length, 1, `expected exactly one INERT warning, got: ${warns.map((w) => w.msg).join(" | ")}`);
            assert.match(warns[0]!.msg, /compress\.stripImages/);
            assert.match(warns[0]!.msg, /was removed/);
            // Second load of the SAME content: deduped (one notice per process).
            loadConfigFile();
            assert.equal(captured.filter((e) => e.level === "warn" && e.msg.includes("INERT")).length, 1);
        },
    );
    stop();
});

test("#2607 follow-up: configs without the removed keys stay silent", () => {
    const { captured, stop } = captureLogs();
    withConfigFile(`{"compress":{"visibilityMarkers":false}}`, () => {
        loadConfigFile();
        assert.equal(captured.filter((e) => e.level === "warn" && e.msg.includes("INERT")).length, 0);
    });
    stop();
});
