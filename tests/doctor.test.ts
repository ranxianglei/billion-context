// #1235: `bili doctor` — read-only audit of every install lane and registered
// proxy process. Verdict precedence, render format, per-lane presence probes
// (sandboxed homes), and the full runDoctor report (mocked registry).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { globalVerdict, laneVerdict, renderDoctorReport, runDoctor, type DoctorLane, type DoctorProcess, type DoctorReport } from "../src/doctor.ts";
import { PLUGIN_AGENTS, inspectLanePresence } from "../src/plugin-install.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> | void {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
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
        rmSync(base, { recursive: true, force: true });
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
        rmSync(base, { recursive: true, force: true });
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
        rmSync(base, { recursive: true, force: true });
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
        rmSync(base, { recursive: true, force: true });
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
        rmSync(base, { recursive: true, force: true });
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
        rmSync(base, { recursive: true, force: true });
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
        rmSync(base, { recursive: true, force: true });
    }
});
