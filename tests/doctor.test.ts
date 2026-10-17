// #1235: `bili doctor` — read-only audit of every install lane and registered
// proxy process. Verdict precedence, render format, per-lane presence probes
// (sandboxed homes), and the full runDoctor report (mocked registry).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dshBundleShadowWarning, dshOutOfBandCopyWarning, globalVerdict, laneVerdict, renderDoctorReport, runDoctor, type DoctorLane, type DoctorProcess, type DoctorReport } from "../src/doctor.ts";
import { PLUGIN_AGENTS, inspectLanePresence } from "../src/plugin-install.ts";
import { rmrf } from "./tmp-rm.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> | void {
    const effective: Record<string, string | undefined> = { ...vars };
    // Windows os.homedir() resolves through USERPROFILE, not HOME — mirror the
    // sandboxed HOME there or real-machine config (~/.dsh, ~/.zcode, …) leaks
    // into tests that believe they are running in an empty home.
    if (process.platform === "win32" && effective.HOME !== undefined && effective.USERPROFILE === undefined) {
        effective.USERPROFILE = effective.HOME;
    }
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(effective)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    const restore = (): void => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };
    const r = fn();
    return r instanceof Promise ? r.finally(restore) : (restore(), undefined);
}

function mockFetch(handler: (url: string) => Response | Promise<Response>): (fn: () => Promise<void>) => Promise<void> {
    const original = globalThis.fetch;
    return (fn) => {
        globalThis.fetch = ((url: unknown) => Promise.resolve(handler(String(url)))) as unknown as typeof fetch;
        return fn().finally(() => {
            globalThis.fetch = original;
        });
    };
}

test("laneVerdict precedence: absent < broken < frozen < stale < ok", () => {
    assert.equal(laneVerdict({ installed: false, targetMissing: true, frozen: true }), "absent");
    assert.equal(laneVerdict({ installed: true, targetMissing: true, frozen: true, copyVersion: "0.1.1", registryVersion: "999.0.0" }), "broken");
    assert.equal(laneVerdict({ installed: true, targetMissing: false, frozen: true, copyVersion: "0.1.1", registryVersion: "999.0.0" }), "frozen");
    assert.equal(laneVerdict({ installed: true, targetMissing: false, frozen: false, copyVersion: "0.1.1", registryVersion: "999.0.0" }), "stale");
    assert.equal(laneVerdict({ installed: true, targetMissing: false, frozen: false, copyVersion: "999.0.0", registryVersion: "0.1.1" }), "ok");
    // Freshness is only claimed when both versions are resolvable — an
    // unreachable registry must never produce a false-stale verdict.
    assert.equal(laneVerdict({ installed: true, targetMissing: false, frozen: false, copyVersion: "0.1.1" }), "ok");
});

test("globalVerdict: checkout is frozen regardless of registry; registry newer than disk is stale", () => {
    assert.equal(globalVerdict({ form: "checkout", diskVersion: "0.1.143", registryVersion: "999.0.0" }), "frozen");
    assert.equal(globalVerdict({ form: "npm", diskVersion: "0.1.143", registryVersion: "0.1.144" }), "stale");
    assert.equal(globalVerdict({ form: "npm", diskVersion: "0.1.143", registryVersion: "0.1.143" }), "ok");
    assert.equal(globalVerdict({ form: "host-managed", diskVersion: "0.1.143" }), "ok");
});

test("#2891: dshBundleShadowWarning fires only when a machine-global copy coexists with a divergent profile copy", () => {
    assert.equal(dshBundleShadowWarning({ packageName: "billion-context", globalInstallDir: "/g/bc", globalDiskVersion: "0.1.135", profileName: "web", bundleInstalled: false, profileCopyVersion: undefined }), undefined);
    assert.equal(dshBundleShadowWarning({ packageName: "billion-context", globalInstallDir: undefined, globalDiskVersion: undefined, profileName: "web", bundleInstalled: true, profileCopyVersion: "0.1.194" }), undefined);
    assert.equal(dshBundleShadowWarning({ packageName: "billion-context", globalInstallDir: "/g/bc", globalDiskVersion: "0.1.194", profileName: "web", bundleInstalled: true, profileCopyVersion: "0.1.194" }), undefined);
    const w = dshBundleShadowWarning({ packageName: "billion-context", globalInstallDir: "/g/bc", globalDiskVersion: "0.1.135", profileName: "web", bundleInstalled: true, profileCopyVersion: "0.1.194" });
    assert.ok(typeof w === "string" && w.includes("v0.1.135") && w.includes("v0.1.194") && w.includes("installation-anchor-first") && w.includes("dsh --profile web --dump-config"), `expected divergent-version shadow warning, got: ${w}`);
    assert.ok(dshBundleShadowWarning({ packageName: "billion-context", globalInstallDir: "/g/bc", globalDiskVersion: undefined, profileName: "web", bundleInstalled: true, profileCopyVersion: "0.1.194" }) !== undefined);
});

test("#3160: dshOutOfBandCopyWarning fires only for a registry-form copy AHEAD of the registry latest", () => {
    // inflated out-of-band copy → warn, naming both versions and the issue
    const w = dshOutOfBandCopyWarning({ packageName: "billion-context", profileName: "desktop", pinned: false, copyVersion: "1.2.9", registryVersion: "0.1.197" });
    assert.ok(typeof w === "string" && w.includes("#3160") && w.includes("v1.2.9") && w.includes("v0.1.197"), `expected out-of-band warning, got: ${w}`);
    // in step → silent
    assert.equal(dshOutOfBandCopyWarning({ packageName: "billion-context", profileName: "web", pinned: false, copyVersion: "0.1.197", registryVersion: "0.1.197" }), undefined);
    // behind (normal stale — already covered by the verdict) → not out-of-band
    assert.equal(dshOutOfBandCopyWarning({ packageName: "billion-context", profileName: "web", pinned: false, copyVersion: "0.1.190", registryVersion: "0.1.197" }), undefined);
    // deliberate local pin → never out-of-band
    assert.equal(dshOutOfBandCopyWarning({ packageName: "billion-context", profileName: "dev", pinned: true, copyVersion: "1.2.9", registryVersion: "0.1.197" }), undefined);
    // missing either version → no false positive
    assert.equal(dshOutOfBandCopyWarning({ packageName: "billion-context", profileName: "web", pinned: false, copyVersion: undefined, registryVersion: "0.1.197" }), undefined);
    assert.equal(dshOutOfBandCopyWarning({ packageName: "billion-context", profileName: "web", pinned: false, copyVersion: "1.2.9", registryVersion: undefined }), undefined);
});

test("#3160: runDoctor surfaces the out-of-band warning on a dsh profile whose copy outruns the registry, without changing its verdict", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-oob-run-"));
    const runWithFetch = mockFetch(() => new Response(JSON.stringify({ name: "billion-context", version: "0.1.197" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    try {
        await runWithFetch(async () => {
            const home = path.join(base, "oob");
            const profileDir = path.join(home, "dsh", "profiles", "desktop");
            const copyDir = path.join(profileDir, "node_modules", "billion-context");
            mkdirSync(copyDir, { recursive: true });
            writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({ dependencies: { "billion-context": "^0.1.196" }, dsh: { profile: { bundles: ["billion-context"] } } }));
            // inflated out-of-band copy: reports 1.2.9 while the registry latest is 0.1.197
            writeFileSync(path.join(copyDir, "package.json"), JSON.stringify({ name: "billion-context", version: "1.2.9" }));
            await withEnv({ ...doctorSandboxEnv(home), DSH_HOME: path.join(home, "dsh") }, async () => {
                const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.196" });
                const lane = report.lanes.find((l) => l.agent === "dsh:desktop");
                assert.ok(lane !== undefined, "dsh:desktop lane present");
                // the verdict stays "ok" (nothing newer than it exists) — the finding rides a warning
                assert.equal(lane?.verdict, "ok");
                assert.ok(lane?.warnings?.some((w) => w.startsWith("out-of-band copy:") && w.includes("v1.2.9") && w.includes("v0.1.197")), `expected an out-of-band warning, got: ${JSON.stringify(lane?.warnings)}`);
                assert.match(renderDoctorReport(report), /⚠️ out-of-band copy/);
            });
        });
    } finally {
        rmrf(base);
    }
});

test("#2891: a dsh lane carrying the shadow warning renders under its row without touching the verdict", () => {
    const text = renderDoctorReport(syntheticReport({
        lanes: [
            { agent: "dsh:web", kind: "host-managed", installed: true, detail: "dep spec: ^0.1.194", copyVersion: "0.1.194", verdict: "stale", registryVersion: "0.1.195", warnings: ["shadowed copy: a machine-global billion-context (/g/bc, v0.1.135) coexists with this profile's own copy (v0.1.194)"] },
        ],
    }));
    assert.match(text, /⚠️ shadowed copy/);
    assert.match(text, /dsh:web\s+stale \(v0\.1\.194 → v0\.1\.195\)\s+host-managed/);
});

test("#2891: runDoctor wires the shadow warning onto the divergent dsh profile lane and stays silent when versions match", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-shadow-run-"));
    const runWithFetch = mockFetch(() => new Response(JSON.stringify({ name: "billion-context", version: "999.0.0" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    // For runDoctor the running test process IS the machine-global copy: findInstallDir
    // walks up from src/update.ts to this repo root (#1628). Pin the profile fixture
    // against that real disk version — divergent vs equal — instead of faking a global dir.
    const repoPkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    const repoVersion = typeof repoPkg.version === "string" ? repoPkg.version : undefined;
    assert.ok(repoVersion, "the repo package.json must carry its own version");
    try {
        await runWithFetch(async () => {
            const cases: Array<[string, string]> = [["divergent", "999.999.999"], ["equal", repoVersion]];
            for (const [profileName, copyVersion] of cases) {
                const home = path.join(base, profileName);
                const profileDir = path.join(home, "dsh", "profiles", profileName);
                const copyDir = path.join(profileDir, "node_modules", "billion-context");
                mkdirSync(copyDir, { recursive: true });
                writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({ dependencies: { "billion-context": "^0.1.140" }, dsh: { profile: { bundles: ["billion-context"] } } }));
                writeFileSync(path.join(copyDir, "package.json"), JSON.stringify({ name: "billion-context", version: copyVersion }));
                await withEnv({ ...doctorSandboxEnv(home), DSH_HOME: path.join(home, "dsh") }, async () => {
                    const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
                    const lane = report.lanes.find((l) => l.agent === `dsh:${profileName}`);
                    assert.ok(lane !== undefined, `dsh:${profileName} lane present`);
                    if (copyVersion === repoVersion) {
                        assert.equal(lane?.warnings, undefined, `matching versions must not warn: ${JSON.stringify(lane?.warnings)}`);
                    } else {
                        assert.ok(lane?.warnings?.some((w) => w.startsWith("shadowed copy:") && w.includes(`v${repoVersion}`)), `divergent versions must warn, got: ${JSON.stringify(lane?.warnings)}`);
                        assert.match(renderDoctorReport(report), /⚠️ shadowed copy/);
                    }
                });
            }
        });
    } finally {
        rmrf(base);
    }
});

function syntheticReport(overrides?: { lanes?: DoctorLane[]; processes?: DoctorProcess[] }): DoctorReport {
    return {
        generatedAt: Date.parse("2026-09-24T00:00:00Z"),
        packageName: "billion-context",
        global: { installDir: "/x/node_modules/billion-context", form: "npm", diskVersion: "0.1.143", runningVersion: "0.1.143", registryVersion: "0.1.143", updateTag: "latest", lastCheckTime: Date.parse("2026-09-24T00:00:00Z"), verdict: "ok" },
        lanes: overrides?.lanes ?? [],
        processes: overrides?.processes ?? [],
    };
}

test("renderDoctorReport: verdict lines carry the issue-specified formats", () => {
    const text = renderDoctorReport(syntheticReport({
        lanes: [
            { agent: "omp", kind: "reference", installed: true, detail: "/old/dist/agent/omp-native.js", channel: "the global bili install (entry points at it)", verdict: "stale", copyVersion: "0.1.1", registryVersion: "0.1.2" },
            { agent: "dsh:dev", kind: "host-managed", installed: true, detail: "dep spec: link:/local/x (local pin — dev lane, manual)", verdict: "frozen", reason: "local-pin dep spec — no live update path; point it at a registry version or rebuild manually (AGENTS.md install-lane contract)" },
            { agent: "pi", kind: "host-managed", installed: false, detail: "not installed", verdict: "absent" },
        ],
        processes: [
            { instanceId: "abc", pid: 4242, port: 8787, origin: "http://127.0.0.1:8787", startedAt: Date.parse("2026-09-24T00:00:00Z"), alive: true, runningFrom: "/x/node_modules/billion-context/dist/index.js" },
            { instanceId: "def", pid: 5555, port: 8788, origin: "http://127.0.0.1:8788", startedAt: Date.parse("2026-09-24T00:00:00Z"), alive: false },
        ],
    }));
    assert.match(text, /stale \(v0\.1\.1 → v0\.1\.2\)/);
    assert.match(text, /frozen/);
    assert.match(text, /zombie \(process gone, marker left behind\)/);
    assert.match(text, /summary: 0 ok, 1 stale, 1 frozen, 0 broken, 1 absent; processes: 1 live, 1 zombie/);
    assert.match(text, /updates via: the global bili install \(entry points at it\)/);
});

test("inspectLanePresence omp: dead entry is a broken lane, live entry resolves its copy version", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-omp-"));
    try {
        const ompHome = path.join(base, "omp");
        const deadEntry = path.join(base, "dead", "dist", "agent", "omp-native.js");
        const liveRoot = path.join(base, "fakepkg");
        const liveEntry = path.join(liveRoot, "dist", "agent", "omp-native.js");
        mkdirSync(path.join(ompHome), { recursive: true });
        mkdirSync(path.dirname(liveEntry), { recursive: true });
        writeFileSync(liveEntry, "export {};\n");
        writeFileSync(path.join(liveRoot, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.143" }));
        const cfg = (entries: string[]): string => ["extensions:", ...entries.map((e) => `  - ${e}`)].join("\n") + "\n";
        writeFileSync(path.join(ompHome, "config.yml"), cfg([deadEntry]));
        withEnv({ PI_CODING_AGENT_DIR: ompHome }, () => {
            const dead = inspectLanePresence("omp");
            assert.equal(dead.installed, true);
            assert.deepEqual(dead.targets, [deadEntry]);
            assert.equal(laneVerdict({ installed: dead.installed, targetMissing: !existsSync(deadEntry), frozen: false, copyVersion: dead.copyVersion, registryVersion: "999.0.0" }), "broken");
        });
        writeFileSync(path.join(ompHome, "config.yml"), cfg([liveEntry]));
        withEnv({ PI_CODING_AGENT_DIR: ompHome }, () => {
            const live = inspectLanePresence("omp");
            assert.equal(live.installed, true);
            assert.equal(live.copyVersion, "0.1.143");
            assert.ok(live.targets.every((t) => existsSync(t)));
        });
    } finally {
        rmrf(base);
    }
});

test("inspectLanePresence dsh: local pin flags a frozen dev lane, registry pin resolves bundle version", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-dsh-"));
    try {
        const dshHome = path.join(base, "dsh");
        const devDir = path.join(dshHome, "profiles", "dev");
        const mainDir = path.join(dshHome, "profiles", "main");
        const mainCopy = path.join(mainDir, "node_modules", "billion-context");
        mkdirSync(devDir, { recursive: true });
        mkdirSync(mainCopy, { recursive: true });
        writeFileSync(path.join(devDir, "package.json"), JSON.stringify({ dependencies: { "billion-context": "link:/local/x" }, dsh: { profile: { bundles: ["billion-context"] } } }));
        writeFileSync(path.join(mainDir, "package.json"), JSON.stringify({ dependencies: { "billion-context": "^0.1.140" }, dsh: { profile: { bundles: ["billion-context"] } } }));
        writeFileSync(path.join(mainCopy, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.140" }));
        withEnv({ DSH_HOME: dshHome }, () => {
            const p = inspectLanePresence("dsh");
            assert.equal(p.installed, true);
            assert.equal(p.form, "local-path");
            const dev = p.profiles?.find((x) => x.name === "dev");
            assert.equal(dev?.pinned, true);
            assert.equal(dev?.spec, "link:/local/x");
            assert.equal(laneVerdict({ installed: true, targetMissing: false, frozen: dev?.pinned === true, copyVersion: dev?.copyVersion, registryVersion: "999.0.0" }), "frozen");
            const main = p.profiles?.find((x) => x.name === "main");
            assert.equal(main?.pinned, false);
            assert.equal(main?.copyVersion, "0.1.140");
            assert.equal(laneVerdict({ installed: true, targetMissing: false, frozen: false, copyVersion: main?.copyVersion, registryVersion: "999.0.0" }), "stale");
        });
    } finally {
        rmrf(base);
    }
});

test("#2850: inspectLanePresence pi: npm lane resolves the real copy root for every spec form", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-pi-npm-"));
    try {
        const piHome = path.join(base, "pi");
        const realCopy = path.join(piHome, "npm", "node_modules", "billion-context");
        mkdirSync(realCopy, { recursive: true });
        writeFileSync(path.join(realCopy, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.143" }));
        // Decoy at the OLD buggy probe path (<piHome>/agent/npm/...) — must never be read.
        const decoy = path.join(piHome, "agent", "npm", "node_modules", "billion-context");
        mkdirSync(decoy, { recursive: true });
        writeFileSync(path.join(decoy, "package.json"), JSON.stringify({ name: "billion-context", version: "9.9.9" }));
        mkdirSync(piHome, { recursive: true });
        const settings = (packages: string[]): void => writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages }));
        for (const spec of ["npm:billion-context", "npm:billion-context@0.1.150", "npm:billion-context@latest"]) {
            settings([spec]);
            withEnv({ PI_CODING_AGENT_DIR: piHome }, () => {
                const p = inspectLanePresence("pi");
                assert.equal(p.installed, true);
                assert.equal(p.form, "npm");
                assert.deepEqual(p.targets, [realCopy], `${spec}: target must be the real pi materialization dir`);
                assert.equal(p.copyVersion, "0.1.143", `${spec}: the decoy at the old wrong path must not leak`);
            });
        }
        // Copy not materialized yet → empty targets (the doctor hint applies), still installed/npm.
        settings(["npm:billion-context"]);
        rmrf(realCopy);
        withEnv({ PI_CODING_AGENT_DIR: piHome }, () => {
            const p = inspectLanePresence("pi");
            assert.equal(p.installed, true);
            assert.equal(p.form, "npm");
            assert.deepEqual(p.targets, []);
            assert.equal(p.copyVersion, undefined);
        });
    } finally {
        rmrf(base);
    }
});

test("#2850: inspectLanePresence pi: absolute-path entry keeps local-path semantics; corrupt settings stays a probe failure", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-pi-abs-"));
    try {
        const piHome = path.join(base, "pi");
        // A real dev checkout is named billion-context — the recognition regex
        // keys off that basename (or a node_modules/billion-context segment).
        const absRoot = path.join(base, "billion-context");
        mkdirSync(absRoot, { recursive: true });
        mkdirSync(piHome, { recursive: true });
        writeFileSync(path.join(absRoot, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.142" }));
        writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: [absRoot] }));
        withEnv({ PI_CODING_AGENT_DIR: piHome }, () => {
            const p = inspectLanePresence("pi");
            assert.equal(p.installed, true);
            assert.equal(p.form, "local-path");
            assert.deepEqual(p.targets, [absRoot]);
            assert.equal(p.copyVersion, "0.1.142");
        });
        // Corrupt settings: single-source probe propagates the parse error (no false absent).
        writeFileSync(path.join(piHome, "settings.json"), "{ not json");
        withEnv({ PI_CODING_AGENT_DIR: piHome }, () => {
            assert.throws(() => inspectLanePresence("pi"), /not valid JSON/);
        });
    } finally {
        rmrf(base);
    }
});

test("#2850: runDoctor pi npm lane verdicts off the real copy and drops the false materialize hint", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-pi-run-"));
    const piHome = path.join(base, "pi");
    const realCopy = path.join(piHome, "npm", "node_modules", "billion-context");
    mkdirSync(realCopy, { recursive: true });
    writeFileSync(path.join(realCopy, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.143" }));
    writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: ["npm:billion-context"] }));
    const registryDoc = (version: string): Response => new Response(JSON.stringify({ name: "billion-context", version }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
        await mockFetch(() => registryDoc("999.0.0"))(async () => {
            await withEnv({ ...doctorSandboxEnv(base), PI_CODING_AGENT_DIR: piHome }, async () => {
                const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
                const pi = report.lanes.find((l) => l.agent === "pi");
                assert.equal(pi?.installed, true);
                assert.equal(pi?.copyVersion, "0.1.143");
                assert.equal(pi?.verdict, "stale");
                assert.match(renderDoctorReport(report), /stale \(v0\.1\.143 → v999\.0\.0\)/);
                assert.ok(!(pi?.detail ?? "").includes("materializes"), `copy exists — no false hint: ${pi?.detail}`);
            });
        });
        // Copy genuinely absent → the pre-materialization hint applies again.
        rmrf(realCopy);
        await mockFetch(() => registryDoc("999.0.0"))(async () => {
            await withEnv({ ...doctorSandboxEnv(base), PI_CODING_AGENT_DIR: piHome }, async () => {
                const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
                const pi = report.lanes.find((l) => l.agent === "pi");
                assert.equal(pi?.installed, true);
                assert.match(pi?.detail ?? "", /pi materializes the npm copy on next startup/);
            });
        });
    } finally {
        rmrf(base);
    }
});

test("inspectLanePresence hermes: baked plugin.yaml version is the freshness signal", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-hermes-"));
    try {
        const hermesHome = path.join(base, "hermes");
        const pluginDir = path.join(hermesHome, "plugins", "billion-context");
        const proxyScript = path.join(base, "global", "dist", "index.js");
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(path.join(pluginDir, "__init__.py"), "");
        writeFileSync(path.join(pluginDir, "plugin.yaml"), "id: billion-context\nversion: 0.1.100\nname: Billion Context\n");
        writeFileSync(path.join(pluginDir, "bili.json"), JSON.stringify({ proxyScript, nodePath: "node" }));
        withEnv({ HERMES_HOME: hermesHome }, () => {
            const p = inspectLanePresence("hermes");
            assert.equal(p.installed, true);
            assert.equal(p.form, "local-path");
            assert.equal(p.copyVersion, "0.1.100");
            assert.deepEqual(p.targets, [proxyScript]);
            assert.equal(laneVerdict({ installed: true, targetMissing: false, frozen: false, copyVersion: p.copyVersion, registryVersion: "999.0.0" }), "stale");
        });
    } finally {
        rmrf(base);
    }
});

test("inspectLanePresence: corrupt single-source config is a probe failure, not a false absent", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-corrupt-"));
    try {
        const ocDir = path.join(base, "opencode");
        mkdirSync(ocDir, { recursive: true });
        writeFileSync(path.join(ocDir, "opencode.json"), "{ not json");
        withEnv({ OPENCODE_CONFIG: path.join(ocDir, "opencode.json") }, () => {
            assert.throws(() => inspectLanePresence("opencode"), /not valid JSON/);
        });
        // zcode resolves its config via os.homedir(), which follows $HOME on
        // POSIX but not on Windows — sandboxable only where $HOME rules.
        if (process.platform !== "win32") {
            const zcDir = path.join(base, "home", ".zcode", "cli");
            mkdirSync(zcDir, { recursive: true });
            writeFileSync(path.join(zcDir, "config.json"), "{ not json");
            withEnv({ HOME: path.join(base, "home") }, () => {
                assert.throws(() => inspectLanePresence("zcode"), /not valid JSON/);
            });
        }
    } finally {
        rmrf(base);
    }
});

test("runDoctor: corrupt lane config surfaces as a broken probe row, not absent", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-corrupt-run-"));
    const ocCfg = path.join(base, "opencode.json");
    writeFileSync(ocCfg, "{ not json");
    const runWithFetch = mockFetch(() => new Response(JSON.stringify({ name: "billion-context", version: "999.0.0" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    try {
        await runWithFetch(async () => {
            await withEnv({
                HOME: path.join(base, "home"),
                XDG_CONFIG_HOME: path.join(base, "xdg-config"),
                XDG_DATA_HOME: path.join(base, "xdg-data"),
                XDG_CACHE_HOME: path.join(base, "xdg-cache"),
                XDG_STATE_HOME: path.join(base, "xdg-state"),
                PI_CODING_AGENT_DIR: undefined,
                PI_HOME: undefined,
                DSH_HOME: undefined,
                HERMES_HOME: undefined,
                KIMI_CODE_HOME: undefined,
                CODEX_HOME: undefined,
                CLAUDE_CONFIG_DIR: undefined,
                OPENCODE_CONFIG: ocCfg,
            }, async () => {
                const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
                const oc = report.lanes.find((l) => l.agent === "opencode");
                assert.equal(oc?.verdict, "broken");
                assert.match(oc?.detail ?? "", /probe failed: .*not valid JSON/);
                for (const l of report.lanes.filter((x) => x.agent !== "opencode")) {
                    assert.equal(l.verdict, "absent", `${l.agent} should be absent in an empty sandbox`);
                }
                assert.match(renderDoctorReport(report), /probe failed/);
            });
        });
    } finally {
        rmrf(base);
    }
});

test("#2199: opencode npm lane surfaces the cache copy path + disk version and goes stale only when the registry leads", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-oc-cache-"));
    const ocCfg = path.join(base, "opencode.json");
    writeFileSync(ocCfg, JSON.stringify({ plugin: ["billion-context"] }));
    const cacheRoot = path.join(base, "xdg-cache", "opencode", "npm", "billion-context@latest", "1760000000000", "node_modules", "billion-context");
    mkdirSync(cacheRoot, { recursive: true });
    writeFileSync(path.join(cacheRoot, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.143" }));
    const registryDoc = (version: string): Response => new Response(JSON.stringify({ name: "billion-context", version }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
        await mockFetch(() => registryDoc("999.0.0"))(async () => {
            await withEnv({
                HOME: path.join(base, "home"),
                XDG_CONFIG_HOME: path.join(base, "xdg-config"),
                XDG_DATA_HOME: path.join(base, "xdg-data"),
                XDG_CACHE_HOME: path.join(base, "xdg-cache"),
                XDG_STATE_HOME: path.join(base, "xdg-state"),
                PI_CODING_AGENT_DIR: undefined, PI_HOME: undefined, DSH_HOME: undefined,
                HERMES_HOME: undefined, KIMI_CODE_HOME: undefined, CODEX_HOME: undefined, CLAUDE_CONFIG_DIR: undefined,
                OPENCODE_CONFIG: ocCfg,
            }, async () => {
                const presence = inspectLanePresence("opencode");
                assert.equal(presence.form, "npm");
                assert.equal(presence.targets[0], cacheRoot);
                assert.equal(presence.copyVersion, "0.1.143");
                const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
                const oc = report.lanes.find((l) => l.agent === "opencode");
                assert.equal(oc?.copyVersion, "0.1.143");
                assert.equal(oc?.verdict, "stale");
                assert.match(oc?.detail ?? "", /cache copy \(/);
                assert.ok((oc?.detail ?? "").includes(presence.targets[0]!), `detail must carry the actual load path: ${oc?.detail}`);
                assert.match(oc?.detail ?? "", /reload\/restart OpenCode/);
                assert.match(renderDoctorReport(report), /stale \(v0\.1\.143 → v999\.0\.0\)/);
            });
        });
        // Same layout, registry at the same version as disk — must stay ok (no false-stale).
        await mockFetch(() => registryDoc("0.1.143"))(async () => {
            await withEnv({
                HOME: path.join(base, "home"),
                XDG_CONFIG_HOME: path.join(base, "xdg-config"),
                XDG_DATA_HOME: path.join(base, "xdg-data"),
                XDG_CACHE_HOME: path.join(base, "xdg-cache"),
                XDG_STATE_HOME: path.join(base, "xdg-state"),
                PI_CODING_AGENT_DIR: undefined, PI_HOME: undefined, DSH_HOME: undefined,
                HERMES_HOME: undefined, KIMI_CODE_HOME: undefined, CODEX_HOME: undefined, CLAUDE_CONFIG_DIR: undefined,
                OPENCODE_CONFIG: ocCfg,
            }, async () => {
                const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
                const oc = report.lanes.find((l) => l.agent === "opencode");
                assert.equal(oc?.verdict, "ok");
            });
        });
    } finally {
        rmrf(base);
    }
});

test("renderDoctorReport: lane warnings render under the lane row without touching the verdict", () => {
    const text = renderDoctorReport(syntheticReport({
        lanes: [
            { agent: "claude", kind: "reference", installed: true, detail: "installed", verdict: "ok", warnings: ["Claude Desktop detected on this machine: its Code tab overrides ANTHROPIC_BASE_URL"] },
            { agent: "pi", kind: "host-managed", installed: false, detail: "not installed", verdict: "absent" },
        ],
    }));
    assert.match(text, /⚠️ Claude Desktop detected/);
    assert.match(text, /claude\s+ok\s+reference/);
});

test("#2290: claude lane surfaces the last hook-detected routing bypass from the state marker", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-claude-warn-"));
    const cfgDir = path.join(base, "claude-cfg");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(path.join(cfgDir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:48787/bili/https://api.anthropic.com", DISABLE_AUTO_COMPACT: "1" } }));
    const stateLane = path.join(base, "xdg-state", "billion-context");
    mkdirSync(stateLane, { recursive: true });
    writeFileSync(path.join(stateLane, "claude-routing-warning.json"), JSON.stringify({ at: Date.parse("2026-10-07T00:00:00Z"), reasons: ["CLAUDE_CODE_ENTRYPOINT=claude-desktop — this host sets its own ANTHROPIC_BASE_URL"] }));
    try {
        await mockFetch(() => new Response(JSON.stringify({ name: "billion-context", version: "999.0.0" }), { status: 200, headers: { "Content-Type": "application/json" } }))(async () => {
            await withEnv({
                HOME: path.join(base, "home"),
                XDG_CONFIG_HOME: path.join(base, "xdg-config"),
                XDG_DATA_HOME: path.join(base, "xdg-data"),
                XDG_CACHE_HOME: path.join(base, "xdg-cache"),
                XDG_STATE_HOME: path.join(base, "xdg-state"),
                PI_CODING_AGENT_DIR: undefined, PI_HOME: undefined, DSH_HOME: undefined,
                HERMES_HOME: undefined, KIMI_CODE_HOME: undefined, CODEX_HOME: undefined,
                CLAUDE_CONFIG_DIR: cfgDir,
                OPENCODE_CONFIG: undefined,
            }, async () => {
                const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
                const cl = report.lanes.find((l) => l.agent === "claude");
                assert.equal(cl?.installed, true);
                assert.ok(cl?.warnings?.some((w) => w.includes("routing bypass") && w.includes("CLAUDE_CODE_ENTRYPOINT=claude-desktop")), `warnings: ${JSON.stringify(cl?.warnings)}`);
                assert.match(renderDoctorReport(report), /⚠️ .*routing bypass/);
            });
        });
        // Corrupt marker: surfaced as nothing, never as a probe failure.
        writeFileSync(path.join(stateLane, "claude-routing-warning.json"), "{ not json");
        await mockFetch(() => new Response(JSON.stringify({ name: "billion-context", version: "999.0.0" }), { status: 200, headers: { "Content-Type": "application/json" } }))(async () => {
            await withEnv({
                HOME: path.join(base, "home"),
                XDG_CONFIG_HOME: path.join(base, "xdg-config"),
                XDG_DATA_HOME: path.join(base, "xdg-data"),
                XDG_CACHE_HOME: path.join(base, "xdg-cache"),
                XDG_STATE_HOME: path.join(base, "xdg-state"),
                PI_CODING_AGENT_DIR: undefined, PI_HOME: undefined, DSH_HOME: undefined,
                HERMES_HOME: undefined, KIMI_CODE_HOME: undefined, CODEX_HOME: undefined,
                CLAUDE_CONFIG_DIR: cfgDir,
                OPENCODE_CONFIG: undefined,
            }, async () => {
                const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
                const cl = report.lanes.find((l) => l.agent === "claude");
                assert.equal(cl?.verdict, "ok");
                assert.ok(!cl?.warnings?.some((w) => w.includes("routing bypass")), `corrupt marker must not surface: ${JSON.stringify(cl?.warnings)}`);
            });
        });
    } finally {
        rmrf(base);
    }
});

test("runDoctor: full report against a mocked registry, sandboxed homes", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-run-"));
    const urls: string[] = [];
    const runWithFetch = mockFetch((url) => {
        urls.push(url);
        return new Response(JSON.stringify({ name: "billion-context", version: "999.0.0" }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    try {
        await runWithFetch(async () => {
            await withEnv({
                HOME: path.join(base, "home"),
                XDG_CONFIG_HOME: path.join(base, "xdg-config"),
                XDG_DATA_HOME: path.join(base, "xdg-data"),
                XDG_CACHE_HOME: path.join(base, "xdg-cache"),
                XDG_STATE_HOME: path.join(base, "xdg-state"),
                PI_CODING_AGENT_DIR: undefined,
                PI_HOME: undefined,
                DSH_HOME: undefined,
                HERMES_HOME: undefined,
                KIMI_CODE_HOME: undefined,
                CODEX_HOME: undefined,
                CLAUDE_CONFIG_DIR: undefined,
                OPENCODE_CONFIG: undefined,
            }, async () => {
                const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
                assert.ok(urls.some((u) => u.includes("registry.npmjs.org/billion-context/latest")), `registry URL hit: ${urls.join(", ")}`);
                assert.equal(report.global.registryVersion, "999.0.0");
                assert.equal(report.global.updateTag, "latest");
                assert.deepEqual(report.lanes.map((l) => l.agent).sort(), [...PLUGIN_AGENTS].sort());
                for (const lane of report.lanes) {
                    assert.equal(lane.installed, false, `${lane.agent} should be absent in an empty sandbox`);
                    assert.equal(lane.verdict, "absent");
                    assert.equal(lane.registryVersion, "999.0.0");
                }
                assert.deepEqual(report.processes, []);
                if (report.global.form === "checkout") {
                    assert.equal(report.global.verdict, "frozen");
                } else {
                    assert.ok(["ok", "stale"].includes(report.global.verdict));
                }
                const parsed = JSON.parse(JSON.stringify(report, null, 2)) as DoctorReport;
                assert.equal(parsed.global.registryVersion, "999.0.0");
                assert.ok(renderDoctorReport(parsed).includes("bili doctor"));
            });
        });
    } finally {
        rmrf(base);
    }
});

test("runDoctor: unreachable registry never produces a false-stale verdict", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-run-"));
    const runWithFetch = mockFetch(() => Promise.reject(new Error("ENOTFOUND")));
    try {
        await runWithFetch(async () => {
            await withEnv({
                HOME: path.join(base, "home"),
                XDG_CONFIG_HOME: path.join(base, "xdg-config"),
                XDG_DATA_HOME: path.join(base, "xdg-data"),
                XDG_CACHE_HOME: path.join(base, "xdg-cache"),
                XDG_STATE_HOME: path.join(base, "xdg-state"),
                PI_CODING_AGENT_DIR: undefined,
                PI_HOME: undefined,
                DSH_HOME: undefined,
                HERMES_HOME: undefined,
                KIMI_CODE_HOME: undefined,
                CODEX_HOME: undefined,
                CLAUDE_CONFIG_DIR: undefined,
                OPENCODE_CONFIG: undefined,
            }, async () => {
                const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
                assert.equal(report.global.registryVersion, undefined);
                assert.match(report.global.reason ?? "", /registry unreachable/);
                for (const lane of report.lanes) {
                    assert.notEqual(lane.verdict, "stale");
                }
            });
        });
    } finally {
        rmrf(base);
    }
});

function advisoryDocFor(entries: Array<{ id: string; affected: string; target: string; reason: string }>): Record<string, unknown> {
    return { billionContextAdvisories: { schema: 1, updated: "2026-09-28", advisories: entries } };
}

const ADVISORY_URL = "https://registry.test/bc-advisories.json";

function doctorSandboxEnv(base: string): Record<string, string | undefined> {
    return {
        HOME: path.join(base, "home"),
        XDG_CONFIG_HOME: path.join(base, "xdg-config"),
        XDG_DATA_HOME: path.join(base, "xdg-data"),
        XDG_CACHE_HOME: path.join(base, "xdg-cache"),
        XDG_STATE_HOME: path.join(base, "xdg-state"),
        PI_CODING_AGENT_DIR: undefined, PI_HOME: undefined, DSH_HOME: undefined, HERMES_HOME: undefined,
        KIMI_CODE_HOME: undefined, CODEX_HOME: undefined, CLAUDE_CONFIG_DIR: undefined, OPENCODE_CONFIG: undefined,
    };
}

test("#1577: bili doctor reports an active advisory against the on-disk version", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-adv-"));
    const advDoc = advisoryDocFor([{ id: "bc-2026-001", affected: ">=0.0.0", target: "99.0.0", reason: "corrupts tool-call arguments" }]);
    const runWithFetch = mockFetch((url) =>
        url.includes("bc-advisories.json")
            ? new Response(JSON.stringify(advDoc))
            : new Response(JSON.stringify({ name: "billion-context", version: "999.0.0" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    try {
        await runWithFetch(async () => {
            await withEnv(doctorSandboxEnv(base), async () => {
                const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143", advisoryUrl: ADVISORY_URL });
                assert.equal(report.global.advisory?.error, undefined);
                assert.equal(report.global.advisory?.active?.id, "bc-2026-001");
                assert.equal(report.global.advisory?.active?.currentVersion, report.global.diskVersion ?? "0.1.143");
                const text = renderDoctorReport(report);
                assert.match(text, /advisory      ⚠️ \[bc-2026-001\] .*corrupts tool-call arguments/);
                assert.ok(text.includes("npm install -g billion-context@99.0.0"));
            });
        });
    } finally {
        rmrf(base);
    }
});

test("#1577: bili doctor reports a clean advisory state as 'none' and a failed source as unknown", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-doctor-adv-none-"));
    const cleanDoc = advisoryDocFor([]);
    const runClean = mockFetch((url) =>
        url.includes("bc-advisories.json")
            ? new Response(JSON.stringify(cleanDoc))
            : new Response(JSON.stringify({ name: "billion-context", version: "999.0.0" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    try {
        await runClean(async () => {
            await withEnv(doctorSandboxEnv(base), async () => {
                const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143", advisoryUrl: ADVISORY_URL });
                assert.equal(report.global.advisory?.active, undefined);
                assert.equal(report.global.advisory?.error, undefined);
                assert.match(renderDoctorReport(report), /advisory      none/);
            });
        });
        const runFail = mockFetch(() => Promise.reject(new Error("ENOTFOUND")));
        await runFail(async () => {
            await withEnv(doctorSandboxEnv(base), async () => {
                const report = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143", advisoryUrl: ADVISORY_URL });
                assert.equal(report.global.advisory?.active, undefined);
                assert.match(report.global.advisory?.error ?? "", /ENOTFOUND|fetch/i);
                assert.match(renderDoctorReport(report), /advisory      check failed .*— status unknown/);
            });
        });
    } finally {
        rmrf(base);
    }
});
