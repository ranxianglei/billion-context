// #1196-class fix for the pi lane: the npm copy under <piHome>/npm is
// host-managed (#991 keeps the global updater out) and pi has no background
// package updater — the proxy running FROM the copy must drive pi's own
// `pi update --extension npm:billion-context` channel itself. isPiNpmCopy
// classifies install dirs; piNpmEntrySpec gates on the unpinned settings
// entry; refreshPiNpmCopy adds staleness + the shared update lock + registry
// reachability before ever spawning pi.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../src/logger.ts";
import type { PiPlan } from "../src/pi-channel.ts";
import { rmrf } from "./tmp-rm.ts";
import { supportsDirectorySymlink } from "./platform-capabilities.ts";

// LOCK_FILE is frozen at update.ts module load — redirect the cache tree
// BEFORE importing it (same discipline as update-dsh-self-refresh.test.ts).
// #3619: this suite pins pi-channel mechanics, not rollout timing — legacy
// immediate upgrades (stagger 0/0) + unroutable policy URL keep it hermetic.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bili-pi-selfrefresh-")));
process.env.XDG_CACHE_HOME = path.join(root, "cache");
// isolate the config tree too — a real bili config's update.registry would
// reroute the mocked registry lookups (see update-dsh-self-refresh.test.ts).
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.BILI_UPDATE_STAGGER_MIN_MS = "0";
process.env.BILI_UPDATE_STAGGER_MAX_MS = "0";
process.env.BILI_UPDATE_POLICY_URL = "http://127.0.0.1:1/no-policy.json";

const { refreshPiNpmCopy } = await import("../src/update.ts");
const { isPiNpmCopy, piNpmEntrySpec, resolvePiBinary, _setPiRunnersForTest } = await import("../src/pi-channel.ts");

after(() => {
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.BILI_UPDATE_STAGGER_MIN_MS;
    delete process.env.BILI_UPDATE_STAGGER_MAX_MS;
    delete process.env.BILI_UPDATE_POLICY_URL;
    rmrf(root);
});

test("resolvePiBinary: finds a stock npm install's pi-stable(.cmd), prefers canonical pi, honors BILI_PI_BIN", () => {
    const binDir = fs.mkdtempSync(path.join(root, "bindir-"));
    const norm = (p: string): string => p.split(path.sep).join("/");

    // Stock `npm install -g pi-stable` on Windows lays down pi-stable.cmd in
    // %APPDATA%/npm — and NOT a `pi` shim. Probing only `pi` misses it.
    const appdata = fs.mkdtempSync(path.join(root, "appdata-"));
    const npmDir = path.join(appdata, "npm");
    fs.mkdirSync(npmDir);
    fs.writeFileSync(path.join(npmDir, "pi-stable.cmd"), "@echo off\r\n");
    const win = resolvePiBinary({ PATH: binDir, APPDATA: appdata, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32", fs.existsSync, "C:\\nodejs\\node.exe");
    assert.equal(norm(win), norm(path.join(npmDir, "pi-stable.cmd")));

    // Canonical `pi` wins when both exist in one dir: `pi` is probed ahead of
    // `pi-stable`. Synthetic dir + stubbed exists keeps this host-independent —
    // a real temp path carries a drive-letter ':' on Windows, which the linux
    // separator below would shred into non-matching fragments.
    const pref = resolvePiBinary(
        { PATH: "probedir" },
        "linux",
        (c) => c === "probedir/pi" || c === "probedir/pi-stable",
        process.execPath,
    );
    assert.equal(pref, "probedir/pi");

    // The override short-circuits everything.
    assert.equal(resolvePiBinary({ PATH: binDir, BILI_PI_BIN: "/opt/weird/pi-nightly" }, "linux", fs.existsSync, process.execPath), "/opt/weird/pi-nightly");

    // Nothing found → the bare name (spawn ENOENT is handled by the caller).
    assert.equal(resolvePiBinary({ PATH: binDir }, "linux", () => false, process.execPath), "pi");
});

// — isPiNpmCopy classification ————————————————————————————————————

test("isPiNpmCopy: pi npm layouts yes, everything else no", () => {
    const base = fs.mkdtempSync(path.join(root, "classify-"));
    try {
        const piHome = path.join(base, "pi");
        const copy = path.join(piHome, "npm", "node_modules", "billion-context");
        assert.equal(isPiNpmCopy(copy, { PI_CODING_AGENT_DIR: piHome }), true);
        // nested file inside the copy (findInstallDir walks up to the root,
        // but deeper paths still classify for robustness)
        assert.equal(isPiNpmCopy(path.join(copy, "dist", "index.js"), { PI_CODING_AGENT_DIR: piHome }), true);
        // PI_HOME relocation is honored
        assert.equal(isPiNpmCopy(copy, { PI_HOME: piHome }), true);
        // pi home WITHOUT the npm/node_modules segment is not the npm copy
        assert.equal(isPiNpmCopy(path.join(piHome, "extensions", "billion-context"), { PI_CODING_AGENT_DIR: piHome }), false);
        // a different package under the same tree is not ours
        assert.equal(isPiNpmCopy(path.join(piHome, "npm", "node_modules", "other-pkg"), { PI_CODING_AGENT_DIR: piHome }), false);
        // npm global layout
        assert.equal(isPiNpmCopy(path.join(base, "home", ".local", "lib", "node_modules", "billion-context"), { PI_CODING_AGENT_DIR: piHome }), false);
        // dsh profile copy is not a pi copy
        assert.equal(isPiNpmCopy(path.join(base, "dsh", "profiles", "a", "node_modules", "billion-context"), { PI_CODING_AGENT_DIR: piHome }), false);
    } finally {
        rmrf(base);
    }
});

test("isPiNpmCopy: follows a symlinked copy into the pi npm tree", (t) => {
    if (!supportsDirectorySymlink()) {
        t.skip("directory symlinks require Developer Mode or junction support on this Windows host");
        return;
    }
    const base = fs.mkdtempSync(path.join(root, "classify-sym-"));
    try {
        const piHome = path.join(base, "pi");
        const real = path.join(piHome, "npm", "node_modules", ".store", "billion-context");
        const link = path.join(piHome, "npm", "node_modules", "billion-context");
        fs.mkdirSync(real, { recursive: true });
        fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
        assert.equal(isPiNpmCopy(link, { PI_CODING_AGENT_DIR: piHome }), true);
    } finally {
        rmrf(base);
    }
});

// — piNpmEntrySpec ———————————————————————————————————————————————————

test("piNpmEntrySpec: unpinned and pinned entries, missing file, no entry", () => {
    const base = fs.mkdtempSync(path.join(root, "entry-"));
    try {
        const piHome = path.join(base, "pi");
        fs.mkdirSync(piHome, { recursive: true });
        const file = path.join(piHome, "settings.json");
        fs.writeFileSync(file, JSON.stringify({ packages: ["npm:other", "npm:billion-context"] }));
        assert.equal(piNpmEntrySpec({ PI_CODING_AGENT_DIR: piHome }), "npm:billion-context");
        fs.writeFileSync(file, JSON.stringify({ packages: ["npm:billion-context@0.1.150"] }));
        assert.equal(piNpmEntrySpec({ PI_CODING_AGENT_DIR: piHome }), "npm:billion-context@0.1.150");
        fs.writeFileSync(file, JSON.stringify({ packages: ["npm:billion-context-pi"] }));
        assert.equal(piNpmEntrySpec({ PI_CODING_AGENT_DIR: piHome }), undefined, "prefixed package is not ours");
        fs.writeFileSync(file, JSON.stringify({}));
        assert.equal(piNpmEntrySpec({ PI_CODING_AGENT_DIR: piHome }), undefined);
        assert.equal(piNpmEntrySpec({ PI_CODING_AGENT_DIR: path.join(base, "missing") }), undefined);
    } finally {
        rmrf(base);
    }
});

// — refreshPiNpmCopy —————————————————————————————————————————————————

interface Fixture {
    base: string;
    piHome: string;
    installDir: string;
    env: NodeJS.ProcessEnv;
    setEntry(entry: string | undefined): void;
    cleanup(): void;
}

/** A pi home with the settings entry (default: the unpinned npm form; null
 *  writes no packages entry) and the running copy at `version`. */
function makeFixture(version: string, entry: string | null = "npm:billion-context"): Fixture {
    const base = fs.mkdtempSync(path.join(root, "fx-"));
    const piHome = path.join(base, "pi");
    const installDir = path.join(piHome, "npm", "node_modules", "billion-context");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version }));
    const file = path.join(piHome, "settings.json");
    const setEntry = (e: string | null | undefined): void => {
        fs.writeFileSync(file, JSON.stringify(e === null ? {} : { packages: [e] }));
    };
    setEntry(entry);
    return {
        base,
        piHome,
        installDir,
        env: { ...process.env, PI_CODING_AGENT_DIR: piHome },
        setEntry,
        cleanup: () => rmrf(base),
    };
}

async function withRegistry<T>(version: string | undefined, fn: (fetches: { count: number }) => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    const fetches = { count: 0 };
    // Only registry traffic is counted/mocked; anything else (e.g. the #3619
    // update-policy fetch) passes through to the real fetch untouched.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).includes("registry.npmjs.org")) return original(input, init);
        fetches.count += 1;
        return version === undefined
            ? Promise.resolve(new Response("nope", { status: 500 }))
            : Promise.resolve(new Response(JSON.stringify({ version })));
    }) as unknown as typeof fetch;
    try {
        return await fn(fetches);
    } finally {
        globalThis.fetch = original;
    }
}

/** Records `pi update …` invocations (platform-neutral, mirroring
 *  update-dsh-self-refresh.test.ts's recorder). */
function recordingAsyncRunner(calls: string[]): (plan: PiPlan) => Promise<{ stdout: string; stderr: string }> {
    return async (plan) => {
        const base = path.basename(plan.command).toLowerCase();
        const tokens = base === "cmd.exe" || base === "cmd"
            ? (plan.args[3] ?? "").replace(/^"|"$/g, "").split(" ").map((t) => t.replace(/^"|"$/g, "")).filter((t) => t.length > 0).slice(1)
            : [...plan.args];
        calls.push(tokens.join(" "));
        return { stdout: "", stderr: "" };
    };
}

function failingAsyncRunner(detail: string): (plan: PiPlan) => Promise<{ stdout: string; stderr: string }> {
    return async () => {
        throw Object.assign(new Error("exit 1"), { status: 1, stderr: detail });
    };
}

function makeLog(): { log: Logger; entries: string[] } {
    const entries: string[] = [];
    return { log: (level, msg) => { entries.push(`${level}: ${msg}`); }, entries };
}

const OPTS = { packageName: "billion-context", currentVersion: "0.1.139", autoUpdate: true };

test("refreshPiNpmCopy: stale unpinned copy refreshes via pi's channel", async () => {
    const fx = makeFixture("0.1.139");
    const calls: string[] = [];
    const { log, entries } = makeLog();
    try {
        _setPiRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry("0.1.140", async (fetches) => {
            await refreshPiNpmCopy(fx.installDir, OPTS, fx.env, log);
            assert.equal(fetches.count, 1, "one registry lookup");
        });
        assert.deepEqual(calls, ["update --extension npm:billion-context"]);
        assert.ok(entries.some((l) => l.includes("stale (0.1.139") && l.includes("0.1.140")), "stale transition logged");
        assert.ok(entries.some((l) => l.includes("refreshed to 0.1.140") && l.includes("restart pi")), "restart hint logged");
    } finally {
        _setPiRunnersForTest(undefined);
        fx.cleanup();
    }
});

test("refreshPiNpmCopy: up-to-date copy never spawns pi", async () => {
    const fx = makeFixture("0.1.140");
    const calls: string[] = [];
    const { log, entries } = makeLog();
    try {
        _setPiRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry("0.1.140", async () => {
            await refreshPiNpmCopy(fx.installDir, OPTS, fx.env, log);
        });
        assert.deepEqual(calls, []);
        assert.ok(entries.some((l) => l.includes("up to date")));
    } finally {
        _setPiRunnersForTest(undefined);
        fx.cleanup();
    }
});

test("refreshPiNpmCopy: pinned settings entry is left alone before any registry fetch", async () => {
    const fx = makeFixture("0.1.139", "npm:billion-context@0.1.139");
    const calls: string[] = [];
    const { log, entries } = makeLog();
    try {
        _setPiRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry("0.1.140", async (fetches) => {
            await refreshPiNpmCopy(fx.installDir, OPTS, fx.env, log);
            assert.equal(fetches.count, 0, "pinned entry never consults the registry");
        });
        assert.deepEqual(calls, []);
        assert.ok(entries.some((l) => l.includes("npm:billion-context@0.1.139") && l.includes("leaving the pi copy alone")));
    } finally {
        _setPiRunnersForTest(undefined);
        fx.cleanup();
    }
});

test("refreshPiNpmCopy: missing settings entry is left alone", async () => {
    const fx = makeFixture("0.1.139", null);
    const calls: string[] = [];
    try {
        _setPiRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry("0.1.140", async (fetches) => {
            await refreshPiNpmCopy(fx.installDir, OPTS, fx.env, () => {});
            assert.equal(fetches.count, 0, "no entry, no fetch");
        });
        assert.deepEqual(calls, []);
    } finally {
        _setPiRunnersForTest(undefined);
        fx.cleanup();
    }
});

test("refreshPiNpmCopy: registry unreachable → warn, no spawn, no throw", async () => {
    const fx = makeFixture("0.1.139");
    const calls: string[] = [];
    const { log, entries } = makeLog();
    try {
        _setPiRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry(undefined, async () => {
            await refreshPiNpmCopy(fx.installDir, OPTS, fx.env, log);
        });
        assert.deepEqual(calls, []);
        assert.ok(entries.some((l) => l.startsWith("warn") && l.includes("could not resolve")));
    } finally {
        _setPiRunnersForTest(undefined);
        fx.cleanup();
    }
});

test("refreshPiNpmCopy: non-pi install dir returns before any registry fetch", async () => {
    const base = fs.mkdtempSync(path.join(root, "noop-"));
    try {
        const installDir = path.join(base, "lib", "node_modules", "billion-context");
        fs.mkdirSync(installDir, { recursive: true });
        fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.139" }));
        const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(base, "pi") };
        const calls: string[] = [];
        _setPiRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry("0.1.140", async (fetches) => {
            await refreshPiNpmCopy(installDir, OPTS, env, () => {});
            assert.equal(fetches.count, 0, "no registry fetch for a non-pi copy");
        });
        assert.deepEqual(calls, []);
    } finally {
        _setPiRunnersForTest(undefined);
        rmrf(base);
    }
});

test("refreshPiNpmCopy: a failed pi run warns with the manual fix and never throws", async () => {
    const fx = makeFixture("0.1.139");
    const { log, entries } = makeLog();
    try {
        _setPiRunnersForTest({ async: failingAsyncRunner("npm ERR! network") });
        await withRegistry("0.1.140", async () => {
            await refreshPiNpmCopy(fx.installDir, OPTS, fx.env, log);
        });
        assert.ok(entries.some((l) => l.startsWith("warn") && l.includes("failed") && l.includes("pi update --extension npm:billion-context") && l.includes("BILI_PI_BIN")), "actionable warn logged");
    } finally {
        _setPiRunnersForTest(undefined);
        fx.cleanup();
    }
});

test("refreshPiNpmCopy: a live update lock defers the refresh to the next cycle", async () => {
    const fx = makeFixture("0.1.139");
    const calls: string[] = [];
    const { log, entries } = makeLog();
    const lockDir = path.join(process.env.XDG_CACHE_HOME!, "billion-context");
    const lockFile = path.join(lockDir, ".update-lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: "wx" });
    try {
        _setPiRunnersForTest({ async: recordingAsyncRunner(calls) });
        await withRegistry("0.1.140", async () => {
            await refreshPiNpmCopy(fx.installDir, OPTS, fx.env, log);
        });
        assert.deepEqual(calls, []);
        assert.ok(entries.some((l) => l.includes("another process is updating")));
    } finally {
        _setPiRunnersForTest(undefined);
        fs.rmSync(lockFile, { force: true });
        fx.cleanup();
    }
});
