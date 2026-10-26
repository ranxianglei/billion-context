// #2325: `bili plugin list` gains a version column showing each lane's actual
// on-disk billion-context copy version (not the CLI version). Covers the render
// mapping (— / unknown / resolved, alignment, never-CLI-version) and the
// per-copy resolution through pluginStatusAll() (independent copies each show
// their own version; absent lanes show none; dsh multi-profile drift is joined).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pluginStatusAll, renderPluginList, type PluginStatusRow } from "../src/plugin-install.ts";
import { VERSION } from "../src/version.ts";
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

// A fully isolated home so no real-host install leaks into the probe.
function isolatedHome(base: string): Record<string, string | undefined> {
    return {
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
    };
}

test("renderPluginList maps status → version cell and aligns the column", () => {
    const rows: PluginStatusRow[] = [
        { agent: "alpha", status: "installed", channel: "chan-alpha", copyVersion: "9.8.7" },
        { agent: "bravo", status: "not installed", channel: "chan-bravo" },
        { agent: "charlie", status: "installed (dsh bundle in all 2 profiles)", channel: "chan-charlie" },
        { agent: "delta", status: "error: boom", channel: "chan-delta" },
    ];
    const out = renderPluginList(rows);
    assert.ok(out.endsWith("\n"));
    const lines = out.replace(/\n$/, "").split("\n");
    assert.equal(lines.length, 5);

    const header = lines[0];
    assert.ok(header.includes("agent") && header.includes("status") && header.includes("version") && header.includes("updates via"));

    // installed + resolvable → the copy version + its update channel
    assert.ok(lines[1].includes("9.8.7"));
    assert.ok(lines[1].includes("chan-alpha"));
    // not installed → em dash, channel suppressed
    assert.ok(lines[2].includes("—"));
    assert.ok(!lines[2].includes("chan-bravo"));
    // installed but unresolvable → unknown, channel kept
    assert.ok(lines[3].includes("unknown"));
    assert.ok(lines[3].includes("chan-charlie"));
    // probe error → em dash, channel suppressed
    assert.ok(lines[4].includes("—"));
    assert.ok(!lines[4].includes("chan-delta"));

    // The version token starts at the same index in every data row (aligned column).
    const vAlpha = lines[1]!.indexOf("9.8.7");
    const vBravo = lines[2]!.indexOf("—");
    const vCharlie = lines[3]!.indexOf("unknown");
    const vDelta = lines[4]!.indexOf("—");
    assert.equal(vAlpha, vBravo);
    assert.equal(vBravo, vCharlie);
    assert.equal(vCharlie, vDelta);

    // The running CLI version must never leak into the output as a fallback.
    assert.ok(!out.includes(VERSION), `output must not fall back to the CLI version ${VERSION}`);
});

test("renderPluginList caps the status column so one long row cannot stretch the table", () => {
    const long = `error: ${"x".repeat(140)}`; // well over the cap; must be shown in full
    const rows: PluginStatusRow[] = [
        { agent: "aaa", status: "installed", channel: "ch-a", copyVersion: "1.0.0" },
        { agent: "bbb", status: long, channel: "ch-b" },
        { agent: "ccc", status: "not installed", channel: "ch-c" },
    ];
    const lines = renderPluginList(rows).replace(/\n$/, "").split("\n");
    assert.equal(lines.length, 4);
    // The over-long status lives on its own row and is shown in full, never truncated.
    assert.ok(lines[2]!.includes(long), "a long status must be shown in full, never truncated");
    // The two short rows keep an aligned version column despite the long middle row.
    assert.equal(lines[1]!.indexOf("1.0.0"), lines[3]!.indexOf("—"));
});

test("pluginStatusAll resolves each lane's own on-disk copy version (shared vs independent)", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-pluginlist-versions-"));
    try {
        // omp: an extensions entry pointing at a fake package root whose
        // package.json pins its own version (an independent copy).
        const ompHome = path.join(base, "omp");
        const ompRoot = path.join(base, "fakepkg-omp");
        const ompEntry = path.join(ompRoot, "dist", "agent", "omp-native.js");
        mkdirSync(ompHome, { recursive: true });
        mkdirSync(path.dirname(ompEntry), { recursive: true });
        writeFileSync(ompEntry, "export {};\n");
        writeFileSync(path.join(ompRoot, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.143" }));
        writeFileSync(path.join(ompHome, "config.yml"), [`extensions:`, `  - ${ompEntry}`].join("\n") + "\n");

        // hermes: a baked plugin whose plugin.yaml carries a DIFFERENT version
        // (a second, independent copy) — proves each lane shows its own version.
        const hermesHome = path.join(base, "hermes");
        const hermesPlugin = path.join(hermesHome, "plugins", "billion-context");
        const proxyScript = path.join(base, "global", "dist", "index.js");
        mkdirSync(hermesPlugin, { recursive: true });
        writeFileSync(path.join(hermesPlugin, "__init__.py"), "");
        writeFileSync(path.join(hermesPlugin, "plugin.yaml"), "id: billion-context\nversion: 0.1.100\nname: Billion Context\n");
        writeFileSync(path.join(hermesPlugin, "bili.json"), JSON.stringify({ proxyScript, nodePath: "node" }));

        withEnv({ ...isolatedHome(base), PI_CODING_AGENT_DIR: ompHome, HERMES_HOME: hermesHome }, () => {
            const rows = pluginStatusAll();
            const installed = rows.filter((r) => r.status.startsWith("installed")).map((r) => r.agent).sort();
            assert.deepEqual(installed, ["hermes", "omp"]);
            assert.equal(rows.find((r) => r.agent === "omp")!.copyVersion, "0.1.143");
            assert.equal(rows.find((r) => r.agent === "hermes")!.copyVersion, "0.1.100");
            // Every non-installed lane must carry no version (renders as "—").
            for (const r of rows) {
                if (!r.status.startsWith("installed")) {
                    assert.equal(r.copyVersion, undefined, `${r.agent} (${r.status}) must not leak a version`);
                }
            }
        });
    } finally {
        rmrf(base);
    }
});

test("#2850: pluginStatusAll pi reads the pi-managed npm copy's own version for every spec form (decoy at the old wrong path ignored)", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-pluginlist-pi-"));
    try {
        const piHome = path.join(base, "pi");
        const realCopy = path.join(piHome, "npm", "node_modules", "billion-context");
        // Decoy at the OLD buggy probe path (<piHome>/agent/npm/...) with a
        // different version — proves the fix reads the real materialized copy.
        const decoy = path.join(piHome, "agent", "npm", "node_modules", "billion-context");
        mkdirSync(realCopy, { recursive: true });
        mkdirSync(decoy, { recursive: true });
        writeFileSync(path.join(realCopy, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.143" }));
        writeFileSync(path.join(decoy, "package.json"), JSON.stringify({ name: "billion-context", version: "9.9.9" }));
        const settings = (packages: string[]): void => {
            mkdirSync(piHome, { recursive: true });
            writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages }));
        };
        for (const spec of ["npm:billion-context", "npm:billion-context@0.1.150", "npm:billion-context@latest"]) {
            settings([spec]);
            withEnv({ ...isolatedHome(base), PI_CODING_AGENT_DIR: piHome }, () => {
                const row = pluginStatusAll().find((r) => r.agent === "pi")!;
                assert.ok(row.status.startsWith("installed"), `${spec}: ${row.status}`);
                assert.equal(row.copyVersion, "0.1.143", `${spec}: must read the real copy — never the decoy, the spec string, or the CLI version`);
            });
        }
        // Copy not materialized yet → installed but unresolvable ("unknown").
        settings(["npm:billion-context"]);
        rmrf(realCopy);
        withEnv({ ...isolatedHome(base), PI_CODING_AGENT_DIR: piHome }, () => {
            const row = pluginStatusAll().find((r) => r.agent === "pi")!;
            assert.ok(row.status.startsWith("installed"));
            assert.equal(row.copyVersion, undefined, "missing copy must stay unknown, never fall back to the CLI version");
        });
    } finally {
        rmrf(base);
    }
});

test("#2850: pluginStatusAll pi resolves the copy under the default home and PI_HOME overrides", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-pluginlist-pihome-"));
    try {
        const place = (piHome: string, version: string): void => {
            const copy = path.join(piHome, "npm", "node_modules", "billion-context");
            mkdirSync(copy, { recursive: true });
            writeFileSync(path.join(copy, "package.json"), JSON.stringify({ name: "billion-context", version }));
            writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: ["npm:billion-context"] }));
        };
        // Default layout: <HOME>/.pi/agent
        place(path.join(base, "home", ".pi", "agent"), "0.1.140");
        withEnv(isolatedHome(base), () => {
            const row = pluginStatusAll().find((r) => r.agent === "pi")!;
            assert.ok(row.status.startsWith("installed"));
            assert.equal(row.copyVersion, "0.1.140");
        });
        // PI_HOME override (PI_CODING_AGENT_DIR unset)
        const ph = path.join(base, "pihome");
        place(ph, "0.1.141");
        withEnv({ ...isolatedHome(base), PI_HOME: ph }, () => {
            const row = pluginStatusAll().find((r) => r.agent === "pi")!;
            assert.equal(row.copyVersion, "0.1.141");
        });
    } finally {
        rmrf(base);
    }
});

test("pluginStatusAll dsh joins distinct per-profile copy versions so drift is visible", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-pluginlist-dsh-"));
    try {
        const dshHome = path.join(base, "dsh");
        const profile = (name: string, spec: string, version: string): void => {
            const dir = path.join(dshHome, "profiles", name);
            const copy = path.join(dir, "node_modules", "billion-context");
            mkdirSync(copy, { recursive: true });
            writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { "billion-context": spec }, dsh: { profile: { bundles: ["billion-context"] } } }));
            writeFileSync(path.join(copy, "package.json"), JSON.stringify({ name: "billion-context", version }));
        };
        profile("main", "^0.1.140", "0.1.140");
        profile("beta", "^0.1.141", "0.1.141");

        withEnv({ ...isolatedHome(base), DSH_HOME: dshHome }, () => {
            const dsh = pluginStatusAll().find((r) => r.agent === "dsh")!;
            assert.ok(dsh.status.startsWith("installed"), `dsh should be installed, got: ${dsh.status}`);
            assert.ok(dsh.copyVersion !== undefined, "dsh multi-profile install must resolve a version");
            assert.deepEqual(dsh.copyVersion!.split(",").sort(), ["0.1.140", "0.1.141"]);
        });
    } finally {
        rmrf(base);
    }
});
