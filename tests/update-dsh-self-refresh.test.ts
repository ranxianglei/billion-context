// #1196: a billion-context copy installed through dsh's plugin market has no
// global bili driving refreshDshProfileBundles — the process running FROM the
// profile copy must drive dsh's own plugin channel itself. isDshProfileCopy
// classifies install dirs; refreshDshProfileCopy gates on staleness, the
// shared update lock, and registry-vs-local pins before spawning dsh.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../src/logger.ts";
import type { DshPlan } from "../src/dsh-channel.ts";
import { rmrf } from "./tmp-rm.ts";
import { supportsDirectorySymlink } from "./platform-capabilities.ts";

// LOCK_FILE is frozen at update.ts module load — redirect the cache tree
// BEFORE importing it (same discipline as auto-restart.test.ts).
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-selfrefresh-")));
process.env.XDG_CACHE_HOME = path.join(root, "cache");

const { refreshDshProfileCopy } = await import("../src/update.ts");
const { isDshProfileCopy, _setDshRunnersForTest } = await import("../src/dsh-channel.ts");

after(() => {
    delete process.env.XDG_CACHE_HOME;
    rmrf(root);
});

// — isDshProfileCopy classification ————————————————————————————————————

test("isDshProfileCopy: dsh profile layouts yes, everything else no", () => {
    const base = fs.mkdtempSync(path.join(root, "classify-"));
    try {
        const dshHome = path.join(base, "dsh");
        // dsh profile bundle as pnpm materializes it (literal store path)
        const storeCopy = path.join(dshHome, "profiles", "web", "node_modules", ".pnpm", "billion-context@0.1.139", "node_modules", "billion-context");
        assert.equal(isDshProfileCopy(storeCopy, { DSH_HOME: dshHome }), true);
        // profile top-level node_modules (hoisted / symlinked dev pin)
        assert.equal(isDshProfileCopy(path.join(dshHome, "profiles", "web", "node_modules", "billion-context"), { DSH_HOME: dshHome }), true);
        // DSH_HOME relocation is honored
        assert.equal(isDshProfileCopy(path.join(base, "elsewhere", "profiles", "a", "node_modules", "billion-context"), { DSH_HOME: path.join(base, "elsewhere") }), true);
        // pnpm global outside a dsh home
        assert.equal(isDshProfileCopy(path.join(base, "pnpm", "global", "5", ".pnpm", "billion-context@0.1.139", "node_modules", "billion-context"), { DSH_HOME: dshHome }), false);
        // npm global layout
        assert.equal(isDshProfileCopy(path.join(base, "home", ".local", "lib", "node_modules", "billion-context"), { DSH_HOME: dshHome }), false);
        // dsh home WITHOUT the profiles segment is not a profile copy
        assert.equal(isDshProfileCopy(path.join(dshHome, "plugins", "billion-context"), { DSH_HOME: dshHome }), false);
    } finally {
        rmrf(base);
    }
});

test("isDshProfileCopy: follows symlinked copies into the profiles tree", (t) => {
    if (!supportsDirectorySymlink()) {
        t.skip("directory symlinks require Developer Mode or junction support on this Windows host");
        return;
    }
    const base = fs.mkdtempSync(path.join(root, "classify-sym-"));
    try {
        // a pnpm-style profile: node_modules/billion-context is a symlink to
        // the .pnpm virtual store — the REALPATH must still classify.
        const dshHome = path.join(base, "dsh");
        const real = path.join(dshHome, "profiles", "web", "node_modules", ".pnpm", "billion-context@0.1.139", "node_modules", "billion-context");
        const link = path.join(dshHome, "profiles", "web", "node_modules", "billion-context");
        fs.mkdirSync(real, { recursive: true });
        fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
        assert.equal(isDshProfileCopy(link, { DSH_HOME: dshHome }), true);
    } finally {
        rmrf(base);
    }
});

// — refreshDshProfileCopy ———————————————————————————————————————————————

interface Fixture {
    base: string;
    dshHome: string;
    installDir: string;
    env: NodeJS.ProcessEnv;
    cleanup(): void;
}

/** A dsh home with profile `a` (registry-pinned, the running copy at
 *  `version`) and profile `b` (link:-pinned dev lane). */
function makeFixture(version: string): Fixture {
    const base = fs.mkdtempSync(path.join(root, "fx-"));
    const dshHome = path.join(base, "dsh");
    const aDir = path.join(dshHome, "profiles", "a");
    const installDir = path.join(aDir, "node_modules", "billion-context");
    fs.mkdirSync(installDir, { recursive: true });
    fs.mkdirSync(path.join(dshHome, "profiles", "b"), { recursive: true });
    fs.writeFileSync(
        path.join(aDir, "package.json"),
        JSON.stringify({ private: true, dependencies: { "billion-context": `^${version}` } }),
    );
    fs.writeFileSync(
        path.join(dshHome, "profiles", "b", "package.json"),
        JSON.stringify({ private: true, dependencies: { "billion-context": `link:${path.join(base, "dev-bc")}` } }),
    );
    fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version }));
    return {
        base,
        dshHome,
        installDir,
        env: { ...process.env, DSH_HOME: dshHome },
        cleanup: () => rmrf(base),
    };
}

/** Stub the registry: `/billion-context/<tag>` → single-version doc; the bare
 *  `/billion-context` packument → `{versions}` keyed by every published version.
 *  `published` defaults to just the resolved `version` (so an inflated copy reads
 *  as unpublished, matching the #3160 incident). */
async function withRegistry<T>(
    version: string | undefined,
    fn: (fetches: { count: number; packument: number }) => Promise<T>,
    published?: string[],
): Promise<T> {
    const original = globalThis.fetch;
    const fetches = { count: 0, packument: 0 };
    const pubList = published ?? (version ? [version] : []);
    globalThis.fetch = ((url: unknown) => {
        fetches.count += 1;
        if (version === undefined) return Promise.resolve(new Response("nope", { status: 500 }));
        const u = String(url);
        if (/\/billion-context$/.test(u)) {
            fetches.packument += 1;
            return Promise.resolve(new Response(JSON.stringify({ name: "billion-context", versions: Object.fromEntries(pubList.map((v) => [v, {}])) })));
        }
        if (/\/billion-context\/[^/]+$/.test(u)) {
            return Promise.resolve(new Response(JSON.stringify({ version })));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${u}`));
    }) as unknown as typeof fetch;
    try {
        return await fn(fetches);
    } finally {
        globalThis.fetch = original;
    }
}

/** Records `dsh plugin …` invocations (platform-neutral, mirroring
 *  dsh-refresh.test.ts's recorder). */
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

const OPTS = { packageName: "billion-context", currentVersion: "0.1.139", autoUpdate: true };

test("refreshDshProfileCopy: stale registry-pinned profile refreshes via dsh's channel; link: pins untouched", async () => {
    const fx = makeFixture("0.1.139");
    const calls: string[] = [];
    const { log, entries } = makeLog();
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry("0.1.140", async (fetches) => {
            await refreshDshProfileCopy(fx.installDir, OPTS, fx.env, log);
            assert.equal(fetches.count, 1, "one registry lookup");
        });
        assert.deepEqual(calls, ["plugin --profile a add billion-context@0.1.140"]);
        assert.ok(entries.some((l) => l.includes("stale (0.1.139") && l.includes("0.1.140")), "stale transition logged");
    } finally {
        _setDshRunnersForTest(undefined);
        fx.cleanup();
    }
});

test("refreshDshProfileCopy: up-to-date copy never spawns dsh", async () => {
    const fx = makeFixture("0.1.140");
    const calls: string[] = [];
    const { log, entries } = makeLog();
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry("0.1.140", async () => {
            await refreshDshProfileCopy(fx.installDir, OPTS, fx.env, log);
        });
        assert.deepEqual(calls, []);
        assert.ok(entries.some((l) => l.includes("up to date")));
    } finally {
        _setDshRunnersForTest(undefined);
        fx.cleanup();
    }
});

test("refreshDshProfileCopy: an inflated out-of-band copy (local > registry) is left untouched + warned, never auto-downgraded (#3160)", async () => {
    const fx = makeFixture("1.2.9"); // profile a declares ^1.2.9 and reports 1.2.9 on disk
    const calls: string[] = [];
    const { log, entries } = makeLog();
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry("0.1.197", async () => {
            await refreshDshProfileCopy(fx.installDir, OPTS, fx.env, log);
        });
        assert.deepEqual(calls, [], "an ahead copy must NOT be auto-downgraded (may be a deliberate local build)");
        assert.ok(entries.some((l) => l.startsWith("warn") && l.includes("#3160") && l.includes("NOT auto-downgrade")), `expected a defer hint, got: ${entries.join(" | ")}`);
        assert.ok(!entries.some((l) => l.includes("up to date")), "an ahead copy must not be reported as up to date");
    } finally {
        _setDshRunnersForTest(undefined);
        fx.cleanup();
    }
});

test("refreshDshProfileCopy: a PUBLISHED-but-ahead copy is NOT auto-downgraded — deferred with a hint (#3160 owner-feedback)", async () => {
    const fx = makeFixture("0.1.198"); // profile a declares ^0.1.198 and reports 0.1.198 on disk
    const calls: string[] = [];
    const { log, entries } = makeLog();
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        // registry's tracked latest is 0.1.197, but 0.1.198 IS published (e.g. on `next`)
        await withRegistry("0.1.197", async () => {
            await refreshDshProfileCopy(fx.installDir, OPTS, fx.env, log);
        }, ["0.1.197", "0.1.198"]);
        assert.deepEqual(calls, [], "a genuinely-published ahead copy must not be downgraded");
        assert.ok(entries.some((l) => l.startsWith("warn") && l.includes("#3160") && l.includes("NOT auto-downgrade")), `expected a defer hint, got: ${entries.join(" | ")}`);
    } finally {
        _setDshRunnersForTest(undefined);
        fx.cleanup();
    }
});

test("refreshDshProfileCopy: an ahead copy under a local pin stays put (info) while sibling registry-pinned profiles still refresh (#3160)", async () => {
    const base = fs.mkdtempSync(path.join(root, "fx-"));
    const dshHome = path.join(base, "dsh");
    const aDir = path.join(dshHome, "profiles", "a");
    const installDir = path.join(aDir, "node_modules", "billion-context");
    const bDir = path.join(dshHome, "profiles", "b");
    fs.mkdirSync(installDir, { recursive: true });
    fs.mkdirSync(bDir, { recursive: true });
    // profile a: link:-pinned (deliberate dev pin) but its on-disk copy reports 1.2.9;
    // profile b: registry-pinned ^0.1.196 with no copy yet — must still be refreshed.
    fs.writeFileSync(path.join(aDir, "package.json"), JSON.stringify({ private: true, dependencies: { "billion-context": `link:${path.join(base, "dev-bc")}` } }));
    fs.writeFileSync(path.join(bDir, "package.json"), JSON.stringify({ private: true, dependencies: { "billion-context": "^0.1.196" } }));
    fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version: "1.2.9" }));
    const calls: string[] = [];
    const { log, entries } = makeLog();
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry("0.1.197", async () => {
            await refreshDshProfileCopy(installDir, OPTS, { ...process.env, DSH_HOME: dshHome }, log);
        });
        assert.deepEqual(calls, ["plugin --profile b add billion-context@0.1.197"], "pinned profile untouched, sibling still refreshed");
        assert.ok(entries.some((l) => l.startsWith("info") && l.includes("intentional dev pin")), `expected the dev-pin info log, got: ${entries.join(" | ")}`);
        assert.ok(!entries.some((l) => l.startsWith("warn") && l.includes("#3160")), "a deliberate pin must not raise the out-of-band warning");
    } finally {
        _setDshRunnersForTest(undefined);
        rmrf(base);
    }
});

test("refreshDshProfileCopy: registry unreachable → warn, no spawn, no throw", async () => {
    const fx = makeFixture("0.1.139");
    const calls: string[] = [];
    const { log, entries } = makeLog();
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry(undefined, async () => {
            await refreshDshProfileCopy(fx.installDir, OPTS, fx.env, log);
        });
        assert.deepEqual(calls, []);
        assert.ok(entries.some((l) => l.startsWith("warn") && l.includes("could not resolve")));
    } finally {
        _setDshRunnersForTest(undefined);
        fx.cleanup();
    }
});

test("refreshDshProfileCopy: non-dsh install dir returns before any registry fetch", async () => {
    const base = fs.mkdtempSync(path.join(root, "noop-"));
    try {
        const installDir = path.join(base, "lib", "node_modules", "billion-context");
        fs.mkdirSync(installDir, { recursive: true });
        fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.139" }));
        const env = { ...process.env, DSH_HOME: path.join(base, "dsh") };
        const calls: string[] = [];
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry("0.1.140", async (fetches) => {
            await refreshDshProfileCopy(installDir, OPTS, env, () => {});
            assert.equal(fetches.count, 0, "no registry fetch for a non-dsh copy");
        });
        assert.deepEqual(calls, []);
    } finally {
        _setDshRunnersForTest(undefined);
        rmrf(base);
    }
});

test("refreshDshProfileCopy: a live update lock defers the refresh to the next cycle", async () => {
    const fx = makeFixture("0.1.139");
    const calls: string[] = [];
    const { log, entries } = makeLog();
    const lockDir = path.join(process.env.XDG_CACHE_HOME!, "billion-context");
    const lockFile = path.join(lockDir, ".update-lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: "wx" });
    try {
        _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry("0.1.140", async () => {
            await refreshDshProfileCopy(fx.installDir, OPTS, fx.env, log);
        });
        assert.deepEqual(calls, []);
        assert.ok(entries.some((l) => l.includes("another process is updating")));
    } finally {
        _setDshRunnersForTest(undefined);
        fs.rmSync(lockFile, { force: true });
        fx.cleanup();
    }
});
