import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRoutes, warnUnknownTopLevelKeys } from "../src/config.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

type Captured = { level: string; msg: string };

const WARN_PREFIX = "[acp-config] ignoring unknown top-level config key(s): ";

function unknownKeyWarns(captured: Captured[]): Captured[] {
    return captured.filter((e) => e.level === "warn" && e.msg.startsWith(WARN_PREFIX));
}

function captureLogs(): { captured: Captured[]; stop: () => void } {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    return { captured, stop: () => setLogCapture(null) };
}

function withConfigFile(body: string, fn: (file: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue1815-"));
    const file = path.join(dir, "billion-context.json");
    fs.writeFileSync(file, body);
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = file;
    try {
        fn(file);
    } finally {
        if (prev === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prev;
        rmrf(dir);
    }
}

test("#1815: unknown top-level key warns once per unique key set, with compress-placement hint", () => {
    const { captured, stop } = captureLogs();
    try {
        warnUnknownTopLevelKeys({ typoedKey: 1 });
        let warns = unknownKeyWarns(captured);
        assert.equal(warns.length, 1, `expected 1 warning, got: ${captured.map((e) => e.msg).join(" | ")}`);
        assert.ok(warns[0].msg.includes("typoedKey"), warns[0].msg);
        assert.ok(!warns[0].msg.includes('belongs under "compress"'), "non-compress key must not get the compress hint");

        warnUnknownTopLevelKeys({ typoedKey: 1 });
        assert.equal(unknownKeyWarns(captured).length, 1, "identical key set must not repeat the warning");

        warnUnknownTopLevelKeys({ nudgeGrowthTokens: 50000 });
        warns = unknownKeyWarns(captured);
        assert.equal(warns.length, 2, "different key set is a different signature and warns again");
        assert.ok(warns[1].msg.includes('"nudgeGrowthTokens" belongs under "compress" (did you mean "compress.nudgeGrowthTokens"?)'), warns[1].msg);
    } finally {
        stop();
    }
});

test("#1815: root-level promptPack (issue repro) warns through the real config-load path", () => {
    const { captured, stop } = captureLogs();
    try {
        withConfigFile(JSON.stringify({ debug: true, providers: {}, promptPack: "lean" }), () => {
            const first = loadRoutes();
            const second = loadRoutes();
            const warns = unknownKeyWarns(captured);
            assert.equal(warns.length, 1, `expected exactly 1 warning across two loads, got: ${captured.map((e) => e.msg).join(" | ")}`);
            assert.ok(warns[0].msg.includes("promptPack"), warns[0].msg);
            assert.ok(!warns[0].msg.includes("debug") && !warns[0].msg.includes("providers"), "known keys must not be flagged");
            assert.ok(warns[0].msg.includes('"promptPack" belongs under "compress" (did you mean "compress.promptPack"?)'), warns[0].msg);
            assert.deepEqual(Object.keys(first), Object.keys(second), "routes must parse identically with or without the warning");
        });
    } finally {
        stop();
    }
});

test("#3876: bare top-level externalSummary gets the compress-placement hint", () => {
    const { captured, stop } = captureLogs();
    try {
        warnUnknownTopLevelKeys({ externalSummary: { enabled: true, targets: ["p/m"] } });
        const warns = unknownKeyWarns(captured);
        assert.equal(warns.length, 1, `expected 1 warning, got: ${captured.map((e) => e.msg).join(" | ")}`);
        assert.ok(warns[0].msg.includes('"externalSummary" belongs under "compress" (did you mean "compress.externalSummary"?)'), warns[0].msg);
    } finally {
        stop();
    }
});

test("#1815: multiple unknown keys list together; fixing some re-warns about the rest", () => {
    const { captured, stop } = captureLogs();
    try {
        withConfigFile(
            JSON.stringify({ providers: {}, promptPack: "lean", nudgeGrowthTokens: 50000, typoedKey: 1 }),
            (file) => {
                loadRoutes();
                let warns = unknownKeyWarns(captured);
                assert.equal(warns.length, 1, `expected 1 warning, got: ${captured.map((e) => e.msg).join(" | ")}`);
                for (const key of ["promptPack", "nudgeGrowthTokens", "typoedKey"]) {
                    assert.ok(warns[0].msg.includes(key), `warning must list ${key}: ${warns[0].msg}`);
                }
                assert.ok(warns[0].msg.includes('"promptPack" belongs under "compress"'), warns[0].msg);
                assert.ok(warns[0].msg.includes('"nudgeGrowthTokens" belongs under "compress"'), warns[0].msg);

                fs.writeFileSync(file, JSON.stringify({ providers: {}, nudgeGrowthTokens: 50000, typoedKey: 1 }));
                loadRoutes();
                warns = unknownKeyWarns(captured);
                assert.equal(warns.length, 2, "changed key set must re-warn");
                assert.ok(!warns[1].msg.includes("promptPack"), "fixed key must not be re-listed");
                assert.ok(warns[1].msg.includes("nudgeGrowthTokens") && warns[1].msg.includes("typoedKey"), warns[1].msg);
            },
        );
    } finally {
        stop();
    }
});

test("#1815: the full documented top-level surface produces no warning (#2062)", () => {
    const { captured, stop } = captureLogs();
    try {
        withConfigFile(
            JSON.stringify({
                port: 8787, host: "127.0.0.1", upstream: "https://api.example.com/v1",
                providersPath: "./providers.json", providers: {}, proxy: "http://127.0.0.1:7890",
                modelContextLimit: 200000, sessionHeader: true, log: true, debug: true, dumpSse: false,
                passthrough: {}, autoUpdate: true, autoRestartOnUpdate: true, updateTag: "latest",
                advisoryCheck: false, advisoryUrl: "", releaseNotesCheck: false, releaseNotesUrl: "",
                upstreamProxy: "", upstreamProxyMode: "direct",
                logFile: "", compress: { promptPack: "lean" }, promptCache: {}, mitm: {}, maskHosts: true,
                subagentSplit: true, forkAdoption: false, resumeInheritance: true,
                chainContentDetection: true, chainEgressStamp: false, stableSystemAnchor: false,
                dsh: {},
                compat: {}, imageBilling: "auto", imageTokenCap: 4096,
                resign: {}, claude: { nativePort: 8901 }, native: { attachExternal: false },
                network: { upstreamTimeoutMs: 60000 }, persist: { enabled: true },
                sessions: { max: 64 }, plugin: { snapshotCapBytes: 1048576 },
                update: { checkIntervalMs: 180000 }, diagnostics: { dumpBody: false },
                fakeCompletion: { retries: 0 }, codexCompact: "intercept",
                ccrRetrievalTtlMs: 600000, decompressTmpCap: 50,
            }),
            () => {
                loadRoutes();
                assert.equal(unknownKeyWarns(captured).length, 0, `no warning expected for the documented surface: ${captured.map((e) => e.msg).join(" | ")}`);
            },
        );
    } finally {
        stop();
    }
});
