// #1803: dsh's CLI reads the bili bundle yml from the GLOBAL install but
// resolves the entry module from each profile's own node_modules — a profile
// copy left behind the global version makes the bare-name entry resolve to
// the old package's empty CLI root and hard-crashes dsh at boot (which also
// blocks the profile copy's own #1196 self-heal). The global install's
// periodic check must converge stale profile copies through dsh's plugin
// channel, every cycle, without touching dev pins.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../src/logger.ts";
import type { DshPlan } from "../src/dsh-channel.ts";
import { rmrf } from "./tmp-rm.ts";

// LOCK_FILE is frozen at update.ts module load — redirect the cache tree
// BEFORE importing it (same discipline as update-dsh-self-refresh.test.ts).
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-converge-")));
process.env.XDG_CACHE_HOME = path.join(root, "cache");

const { checkForUpdate, convergeDshProfileBundles } = await import("../src/update.ts");
const { _setDshRunnersForTest } = await import("../src/dsh-channel.ts");

after(() => {
    delete process.env.XDG_CACHE_HOME;
    rmrf(root);
});

interface World {
    base: string;
    dshHome: string;
    globalDir: string;
    webCopyPkg: string;
    env: NodeJS.ProcessEnv;
    cleanup(): void;
}

/** A dsh home with four profiles — web (registry dep, installed at
 *  `webVersion`), headless (registry dep, in step with the global 0.1.176),
 *  dev (link:-pinned lane, old copy), ghost (registry dep declared but never
 *  installed) — plus a global install at 0.1.176. */
function makeWorld(webVersion: string): World {
    const base = fs.mkdtempSync(path.join(root, "w-"));
    const dshHome = path.join(base, "dsh");
    const mkProfile = (name: string, dep: string | undefined) => {
        const dir = path.join(dshHome, "profiles", name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, "package.json"),
            JSON.stringify({ private: true, ...(dep === undefined ? {} : { dependencies: { "billion-context": dep } }) }),
        );
        return dir;
    };
    const webDir = mkProfile("web", `^${webVersion}`);
    const headlessDir = mkProfile("headless", "^0.1.176");
    const devDir = mkProfile("dev", `link:${path.join(base, "dev-bc")}`);
    mkProfile("ghost", "^0.1.176");
    mkProfile("unrelated", undefined);
    const webCopyPkg = path.join(webDir, "node_modules", "billion-context", "package.json");
    const installCopy = (dir: string, version: string) => {
        const copy = path.join(dir, "node_modules", "billion-context");
        fs.mkdirSync(copy, { recursive: true });
        fs.writeFileSync(path.join(copy, "package.json"), JSON.stringify({ name: "billion-context", version }));
    };
    installCopy(webDir, webVersion);
    installCopy(headlessDir, "0.1.176");
    installCopy(devDir, "0.1.175");
    const globalDir = path.join(base, "global-install");
    fs.mkdirSync(path.join(globalDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(globalDir, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.176", type: "module", bin: { bili: "./dist/index.js" } }));
    fs.writeFileSync(path.join(globalDir, "dist", "index.js"), "export const loaded = true;\n");
    return {
        base,
        dshHome,
        globalDir,
        webCopyPkg,
        env: { ...process.env, DSH_HOME: dshHome },
        cleanup: () => rmrf(base),
    };
}

function recordingAsyncRunner(calls: string[]): (plan: DshPlan) => Promise<{ stdout: string; stderr: string }> {
    return async (plan) => {
        const base = path.basename(plan.command).toLowerCase();
        const tokens = base === "cmd.exe" || base === "cmd"
            ? (plan.args[3] ?? "").replace(/^"|"$/g, "").split(" ").map((t) => t.replace(/^"|"$/g, "")).filter((t) => t.length > 0).slice(1)
            : [...plan.args];
        calls.push(tokens.join(" "));
        return { stdout: "", stderr: "" };
    };
}

function makeLog(): { log: Logger; entries: string[] } {
    const entries: string[] = [];
    return { log: (level, msg) => { entries.push(`${level}: ${msg}`); }, entries };
}

async function withRegistry<T>(version: string, fn: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ version })))) as unknown as typeof fetch;
    try {
        return await fn();
    } finally {
        globalThis.fetch = original;
    }
}

test("convergeDshProfileBundles: stale registry copy + declared-but-missing mount refresh — dev pins and in-step copies untouched", async () => {
    const w = makeWorld("0.1.175");
    const calls: string[] = [];
    const { log, entries } = makeLog();
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        await convergeDshProfileBundles(w.globalDir, "0.1.176", w.env, log);
        assert.deepEqual(calls, ["plugin --profile ghost add billion-context@0.1.176", "plugin --profile web add billion-context@0.1.176"]);
        assert.ok(entries.some((l) => l.includes("behind the global copy (web@0.1.175") && l.includes("0.1.176")), "stale transition logged");
    } finally {
        _setDshRunnersForTest(undefined);
        w.cleanup();
    }
});

test("convergeDshProfileBundles: in-step world stays silent and spawn-free", async () => {
    const w = makeWorld("0.1.176");
    const calls: string[] = [];
    const { entries } = makeLog();
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        await convergeDshProfileBundles(w.globalDir, "0.1.176", w.env, entries.push.bind(entries) as unknown as Logger);
        assert.deepEqual(calls, []);
        assert.equal(entries.length, 0, "no log lines for a healthy machine");
    } finally {
        _setDshRunnersForTest(undefined);
        w.cleanup();
    }
});

test("convergeDshProfileBundles: missing installDir or version is a no-op", async () => {
    const w = makeWorld("0.1.175");
    const calls: string[] = [];
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        await convergeDshProfileBundles(undefined, "0.1.176", w.env);
        await convergeDshProfileBundles(w.globalDir, undefined, w.env);
        assert.deepEqual(calls, []);
    } finally {
        _setDshRunnersForTest(undefined);
        w.cleanup();
    }
});

test("checkForUpdate: an up-to-date global still converges stale dsh profile copies (#1803)", async () => {
    const w = makeWorld("0.1.175");
    const calls: string[] = [];
    const prevDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = w.dshHome;
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        process.env.XDG_CACHE_HOME = path.join(w.base, "cache");
        await withRegistry("0.1.176", async () => {
            await checkForUpdate({ packageName: "billion-context", currentVersion: "0.1.176", autoUpdate: true, installDir: w.globalDir }, true);
        });
        assert.deepEqual(calls, ["plugin --profile ghost add billion-context@0.1.176", "plugin --profile web add billion-context@0.1.176"]);
    } finally {
        _setDshRunnersForTest(undefined);
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        w.cleanup();
    }
});

test("checkForUpdate: in-step profiles spawn nothing on the up-to-date path", async () => {
    const w = makeWorld("0.1.176");
    const calls: string[] = [];
    const prevDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = w.dshHome;
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        process.env.XDG_CACHE_HOME = path.join(w.base, "cache");
        await withRegistry("0.1.176", async () => {
            await checkForUpdate({ packageName: "billion-context", currentVersion: "0.1.176", autoUpdate: true, installDir: w.globalDir }, true);
        });
        assert.deepEqual(calls, []);
    } finally {
        _setDshRunnersForTest(undefined);
        process.env.XDG_CACHE_HOME = path.join(root, "cache");
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        w.cleanup();
    }
});
