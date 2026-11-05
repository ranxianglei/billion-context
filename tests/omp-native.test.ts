import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import factory, { ompTrafficRidesBili, shouldBootstrapNativeOmp, planNativeOmp, armNativeOmp, _resetNativeStateForTest, _setSpawnForTest, _stateRespawnForTest, _noteRoutedForTest } from "../src/agent/omp-native.ts";
import { applyOmpFirstEventTimeout, nativeProxyScriptPath, ompFirstEventTimeoutValue, OMP_FIRST_EVENT_TIMEOUT_DEFAULT_MS, OMP_FIRST_EVENT_TIMEOUT_ENV } from "../src/agent/native-bootstrap.ts";
import { pluginInstall, pluginRemove, pluginStatusAll, selfPackageRoot, ompPluginLoadedFrom } from "../src/plugin-install.ts";
import { rmrf } from "./tmp-rm.ts";

// #1135 wiring tests drive verifyAttachAndRecover against a dead target — cap
// the routed-evidence grace so the probe fails fast instead of paying the 5s default.
process.env.BILI_ATTACH_EVIDENCE_GRACE_MS = "30";

// #3501: a dev shell running omp through a launcher exports a live attach
// target; verifyAttachAndRecover reads BILLION_CONTEXT_ATTACH explicitly, so
// every suite below must start from a clean slate or it silently binds to the
// real proxy instead of the mock it set up.
delete process.env.BILLION_CONTEXT_ATTACH;
delete process.env.BILLION_CONTEXT_PROXY;

// #957 coexistence: markNativeHost must be set synchronously during module
// evaluation so any in-process bili extension backs off in THIS process.
test("module evaluation marks the process as a native omp host", () => {
    assert.equal(process.env.BILLION_CONTEXT_NATIVE, "omp");
});

test("shouldBootstrapNativeOmp: true in a bare host with no bili env", () => {
    assert.equal(shouldBootstrapNativeOmp({}), true);
});

test("shouldBootstrapNativeOmp: false when the plugin or native mode is opted out", () => {
    assert.equal(shouldBootstrapNativeOmp({ BILLION_CONTEXT_PLUGIN: "0" }), false);
    assert.equal(shouldBootstrapNativeOmp({ BILI_NATIVE_OMP: "0" }), false);
    assert.equal(shouldBootstrapNativeOmp({ BILI_NATIVE_PI: "0" }), true, "another host's opt-out does not affect omp");
});

test("shouldBootstrapNativeOmp: false when a bili launch already owns a proxy", () => {
    assert.equal(shouldBootstrapNativeOmp({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485" }), false);
    assert.equal(shouldBootstrapNativeOmp({ BILLION_CONTEXT_PROXY: "  " }), true);
    assert.equal(shouldBootstrapNativeOmp({ BILI_PROVIDER_REWRITES: '{"vllm":"http://127.0.0.1:1/bili/http://x"}' }), false);
});

test("ompTrafficRidesBili: true for self-bootstrap, launcher proxy, /bili/ rewrites", () => {
    assert.equal(ompTrafficRidesBili({}), true, "bare host: gate passes, self-bootstrap will own the proxy");
    assert.equal(ompTrafficRidesBili({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787" }), true, "launcher/MITM launch");
    assert.equal(ompTrafficRidesBili({ BILI_PROVIDER_REWRITES: '{"vllm":"http://127.0.0.1:1/bili/http://x"}' }), true, "/bili/-rewrite launch");
    assert.equal(ompTrafficRidesBili({ BILI_NATIVE_OMP: "0", BILLION_CONTEXT_PROXY: "  " }), false, "opted out + blank proxy — traffic goes direct");
    assert.equal(ompTrafficRidesBili({ BILI_NATIVE_OMP: "0" }), false, "opted out — traffic goes direct");
    assert.equal(ompTrafficRidesBili({ BILI_NATIVE_OMP: "0", BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787" }), true, "launcher wins over the native opt-out");
});

test("#1774 first-event timeout value: default when unset, user-pinned values (incl. 0) win", () => {
    assert.equal(OMP_FIRST_EVENT_TIMEOUT_DEFAULT_MS, 1_800_000);
    assert.equal(ompFirstEventTimeoutValue({}), "1800000");
    assert.equal(ompFirstEventTimeoutValue({ [OMP_FIRST_EVENT_TIMEOUT_ENV]: "60000" }), undefined);
    assert.equal(ompFirstEventTimeoutValue({ [OMP_FIRST_EVENT_TIMEOUT_ENV]: "0" }), undefined, "explicit disable sentinel respected");
    assert.equal(ompFirstEventTimeoutValue({ [OMP_FIRST_EVENT_TIMEOUT_ENV]: "   " }), "1800000", "blank counts as unset");
});

test("#1774 applyOmpFirstEventTimeout: stamps only when unpinned, idempotent on stamped env", () => {
    const clean: NodeJS.ProcessEnv = {};
    applyOmpFirstEventTimeout(clean);
    assert.equal(clean[OMP_FIRST_EVENT_TIMEOUT_ENV], "1800000");
    applyOmpFirstEventTimeout(clean);
    assert.equal(clean[OMP_FIRST_EVENT_TIMEOUT_ENV], "1800000");
    const pinned: NodeJS.ProcessEnv = { [OMP_FIRST_EVENT_TIMEOUT_ENV]: "45000" };
    applyOmpFirstEventTimeout(pinned);
    assert.equal(pinned[OMP_FIRST_EVENT_TIMEOUT_ENV], "45000");
});

test("nativeProxyScriptPath: dist/agent/omp-native.js resolves to the package bin", () => {
    const agentFile = path.resolve(path.sep, "opt", "pkg", "dist", "agent", "omp-native.js");
    const resolved = nativeProxyScriptPath(pathToFileURL(agentFile).href);
    assert.equal(resolved, path.resolve(path.sep, "opt", "pkg", "dist", "index.js"));
});

test("default export is an ExtensionFactory (loaded by omp's extensions loader)", () => {
    assert.equal(typeof factory, "function");
});

// — installer: `bili plugin install omp` targets the native entry (#957) ——

const NATIVE_ENTRY = path.join(selfPackageRoot(), "dist", "agent", "omp-native.js");

function withOmpHome(fn: () => void | Promise<void>): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-native-home-"));
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = home;
    if (!fs.existsSync(NATIVE_ENTRY)) {
        fs.mkdirSync(path.dirname(NATIVE_ENTRY), { recursive: true });
        fs.writeFileSync(NATIVE_ENTRY, "// test stub\n");
    }
    return Promise.resolve(fn()).finally(() => {
        if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prev;
        rmrf(home);
    });
}

function ompConfigFileIn(home: string): string {
    return path.join(home, "config.yml");
}

function ompStatusOf(): string {
    return pluginStatusAll().find((s) => s.agent === "omp")?.status ?? "<missing>";
}

test("pluginInstall('omp'): fresh install writes exactly one native entry", () => withOmpHome(() => {
    const msg = pluginInstall("omp");
    assert.match(msg, /^omp: installed -> .*extensions \+= .+[\\/]dist[\\/]agent[\\/]omp-native\.js$/);
    const file = ompConfigFileIn(process.env.PI_CODING_AGENT_DIR!);
    assert.equal(fs.readFileSync(file, "utf8"), `extensions:\n  - ${NATIVE_ENTRY}\n`);
}));

test("pluginInstall('omp'): idempotent — re-install leaves the file untouched", () => withOmpHome(() => {
    pluginInstall("omp");
    const file = ompConfigFileIn(process.env.PI_CODING_AGENT_DIR!);
    const before = fs.readFileSync(file, "utf8");
    const msg = pluginInstall("omp");
    assert.match(msg, /already installed/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
}));

test("pluginInstall('omp'): migrates a pre-#957 thin dist/agent/omp.js entry to the native one", () => withOmpHome(() => {
    const home = process.env.PI_CODING_AGENT_DIR!;
    const thin = path.join(home, "old", "dist", "agent", "omp.js");
    fs.mkdirSync(path.dirname(thin), { recursive: true });
    fs.writeFileSync(thin, "// thin\n");
    const file = ompConfigFileIn(home);
    fs.writeFileSync(file, `theme: dark\nextensions:\n  - ${thin}\n`);
    const msg = pluginInstall("omp");
    assert.match(msg, /replaced .*[\\/]dist[\\/]agent[\\/]omp\.js/);
    assert.equal(fs.readFileSync(file, "utf8"), `theme: dark\nextensions:\n  - ${NATIVE_ENTRY}\n`);
}));

test("pluginInstall('omp'): collapses duplicate native entries into one", () => withOmpHome(() => {
    const home = process.env.PI_CODING_AGENT_DIR!;
    const file = ompConfigFileIn(home);
    fs.writeFileSync(file, `extensions:\n  - ${NATIVE_ENTRY}\n  - ${NATIVE_ENTRY}\n`);
    pluginInstall("omp");
    assert.equal(fs.readFileSync(file, "utf8"), `extensions:\n  - ${NATIVE_ENTRY}\n`);
}));

test("pluginRemove('omp'): removes both entry forms, keeps foreign entries", () => withOmpHome(() => {
    const home = process.env.PI_CODING_AGENT_DIR!;
    const thin = path.join(home, "old", "dist", "agent", "omp.js");
    fs.mkdirSync(path.dirname(thin), { recursive: true });
    fs.writeFileSync(thin, "// thin\n");
    const other = path.join(home, "other-ext.js");
    fs.writeFileSync(other, "// other\n");
    const file = ompConfigFileIn(home);
    fs.writeFileSync(file, `extensions:\n  - ${other}\n  - ${thin}\n  - ${NATIVE_ENTRY}\n`);
    const msg = pluginRemove("omp");
    assert.match(msg, /removed from/);
    assert.equal(fs.readFileSync(file, "utf8"), `extensions:\n  - ${other}\n`);
}));

test("pluginStatusAll('omp'): installed for either loadable form, broken for a stale path", () => withOmpHome(() => {
    const home = process.env.PI_CODING_AGENT_DIR!;
    const file = ompConfigFileIn(home);
    const thin = path.join(home, "old", "dist", "agent", "omp.js");
    const stale = "/no/such/dir/dist/agent/omp-native.js";
    fs.mkdirSync(path.dirname(thin), { recursive: true });
    fs.writeFileSync(thin, "// thin\n");
    fs.writeFileSync(file, `extensions:\n  - ${stale}\n  - ${thin}\n`);
    assert.equal(ompStatusOf(), "installed");
    fs.writeFileSync(file, `extensions:\n  - ${stale}\n`);
    assert.equal(ompStatusOf(), "broken");
    fs.writeFileSync(file, `extensions:\n  - ${path.join(home, "foreign.js")}\n`);
    assert.equal(ompStatusOf(), "not installed");
}));

test("ompPluginLoadedFrom: launcher skips -e only for a loadable entry (either form)", () => withOmpHome(() => {
    const home = process.env.PI_CODING_AGENT_DIR!;
    const file = ompConfigFileIn(home);
    const thin = path.join(home, "old", "dist", "agent", "omp.js");
    fs.mkdirSync(path.dirname(thin), { recursive: true });
    fs.writeFileSync(thin, "// thin\n");
    fs.writeFileSync(file, `extensions:\n  - ${thin}\n`);
    assert.equal(ompPluginLoadedFrom(home), true, "loadable thin entry counts (pre-#957 installs keep working)");
    fs.writeFileSync(file, `extensions:\n  - /no/such/dir/dist/agent/omp-native.js\n`);
    assert.equal(ompPluginLoadedFrom(home), false, "stale entry → launcher must supply -e itself");
    fs.writeFileSync(file, `extensions:\n  - ${NATIVE_ENTRY}\n`);
    if (fs.existsSync(NATIVE_ENTRY)) assert.equal(ompPluginLoadedFrom(home), true, "loadable native entry counts");
}));

// —— #1795: preset BILLION_CONTEXT_PROXY is an attach target, never a stand-down ——

test("planNativeOmp: default is spawn; opt-out and /bili/ launches are off", () => {
    assert.deepEqual(planNativeOmp({}), { mode: "spawn" });
    assert.deepEqual(planNativeOmp({ BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeOmp({ BILI_NATIVE_OMP: "0" }), { mode: "off" });
    assert.deepEqual(planNativeOmp({ BILI_PROVIDER_REWRITES: '{"vllm":"http://127.0.0.1:1/bili/http://x"}' }), { mode: "off" });
});

test("planNativeOmp: a preset BILLION_CONTEXT_PROXY is an attach target, not a stand-down", () => {
    // #1795 regression: the pseudo-attach hole used to resolve a preset proxy
    // to "off" (gate closed), disarming the fetch intercept entirely so every
    // model request went direct and uncompressed.
    assert.deepEqual(
        planNativeOmp({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485" }),
        { mode: "attach", attachOrigin: "http://127.0.0.1:36485" },
    );
    assert.deepEqual(
        planNativeOmp({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485/" }),
        { mode: "attach", attachOrigin: "http://127.0.0.1:36485" },
    );
    // kill switches and a /bili/ launch still win over the preset
    assert.deepEqual(planNativeOmp({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeOmp({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILI_PROVIDER_REWRITES: "{}" }), { mode: "off" });
    // a garbage / blank preset falls back to spawn (self-managed), never dead-off
    assert.deepEqual(planNativeOmp({ BILLION_CONTEXT_PROXY: "garbage" }), { mode: "spawn" });
    assert.deepEqual(planNativeOmp({ BILLION_CONTEXT_PROXY: "  " }), { mode: "spawn" });
});

test("planNativeOmp: explicit BILLION_CONTEXT_ATTACH wins over the env preset", () => {
    assert.deepEqual(
        planNativeOmp({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILLION_CONTEXT_ATTACH: "http://10.0.0.5:9000" }),
        { mode: "attach", attachOrigin: "http://10.0.0.5:9000" },
    );
});

test("#1135 wiring: a dead attach target falls back to a spawned proxy", async () => {
    const savedProxy = process.env.BILLION_CONTEXT_PROXY;
    try {
        _resetNativeStateForTest();
        let spawned = 0;
        _setSpawnForTest(async () => {
            spawned++;
            return "http://127.0.0.1:7777";
        });
        armNativeOmp({ mode: "attach", attachOrigin: "http://127.0.0.1:9" });
        assert.equal(typeof _stateRespawnForTest(), "function", "respawn seam armed at load");
        // port 9 refuses connections instantly — the manifest probe fails fast,
        // the fallback spawn lands and replaces the env origin
        const landed = await _stateRespawnForTest()!();
        assert.equal(landed, "http://127.0.0.1:7777");
        assert.ok(spawned >= 1);
        assert.equal(process.env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:7777");
    } finally {
        if (savedProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = savedProxy;
        _resetNativeStateForTest();
    }
});

test("#1135 wiring: a healthy attach target stays attached (no migration, no spawn)", async () => {
    const savedProxy = process.env.BILLION_CONTEXT_PROXY;
    const server = createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ version: "0.1.175", tools: [] }));
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
        _resetNativeStateForTest();
        let spawned = 0;
        _setSpawnForTest(async () => {
            spawned++;
            return "http://127.0.0.1:7778";
        });
        armNativeOmp({ mode: "attach", attachOrigin: `http://127.0.0.1:${port}` });
        const landed = await _stateRespawnForTest()!();
        assert.equal(landed, `http://127.0.0.1:${port}`, "healthy target resolves to itself");
        assert.equal(spawned, 0, "no fallback spawn for a healthy target");
        assert.equal(process.env.BILLION_CONTEXT_PROXY, `http://127.0.0.1:${port}`);
    } finally {
        server.close();
        if (savedProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = savedProxy;
        _resetNativeStateForTest();
    }
});

// — #3501: an explicit attach endpoint stays authoritative over routed model-origin evidence —

const R3501_UPSTREAM = "https://api.deepseek.com/v1/chat/completions";

async function startGatedModelOrigin(): Promise<{ origin: string; close: () => void; manifestHits: () => number }> {
    let hits = 0;
    const server = createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") hits++;
        res.statusCode = 403;
        res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return {
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => { server.closeAllConnections?.(); void server.close(); },
        manifestHits: () => hits,
    };
}

test("#3501 wiring: pre-planted routed evidence from an admin-gated origin does not displace an explicit attach", async () => {
    const attach = createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ version: "0.1.175", tools: [] }));
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    await new Promise<void>((r) => attach.listen(0, "127.0.0.1", () => r()));
    const attachOrigin = `http://127.0.0.1:${(attach.address() as AddressInfo).port}`;
    const model = await startGatedModelOrigin();
    try {
        _resetNativeStateForTest();
        process.env.BILLION_CONTEXT_ATTACH = attachOrigin;
        _noteRoutedForTest(`${model.origin}/bili/${R3501_UPSTREAM}`);
        let spawned = 0;
        _setSpawnForTest(async () => {
            spawned++;
            return "http://127.0.0.1:7777";
        });
        armNativeOmp({ mode: "attach", attachOrigin });
        const landed = await _stateRespawnForTest()!();
        assert.equal(landed, attachOrigin, "recovery probes the explicit plugin endpoint, not the model-only origin");
        assert.equal(spawned, 0, "a second proxy must not be spawned for an API-only model route");
        assert.equal(model.manifestHits(), 0, "pre-existing model-route evidence must not override explicit attach");
        assert.equal(process.env.BILLION_CONTEXT_PROXY, attachOrigin);
    } finally {
        attach.closeAllConnections?.();
        attach.close();
        model.close();
        delete process.env.BILLION_CONTEXT_ATTACH;
        delete process.env.BILLION_CONTEXT_PROXY;
        _setSpawnForTest(undefined);
        _resetNativeStateForTest();
    }
});

test("#3501 wiring: late routed evidence from an admin-gated origin does not rebind away from a healthy explicit attach", async () => {
    const attach = createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ version: "0.1.175", tools: [] }));
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    await new Promise<void>((r) => attach.listen(0, "127.0.0.1", () => r()));
    const attachOrigin = `http://127.0.0.1:${(attach.address() as AddressInfo).port}`;
    const model = await startGatedModelOrigin();
    try {
        _resetNativeStateForTest();
        process.env.BILLION_CONTEXT_ATTACH = attachOrigin;
        let spawned = 0;
        _setSpawnForTest(async () => {
            spawned++;
            return "http://127.0.0.1:7777";
        });
        armNativeOmp({ mode: "attach", attachOrigin });
        const landed = await _stateRespawnForTest()!();
        assert.equal(landed, attachOrigin, "healthy explicit target resolves to itself");
        _noteRoutedForTest(`${model.origin}/bili/${R3501_UPSTREAM}`);
        const deadline = Date.now() + 5000;
        while (model.manifestHits() < 1 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
        }
        assert.equal(model.manifestHits(), 1, "the hook liveness-probes the late routed origin exactly once");
        assert.equal(process.env.BILLION_CONTEXT_PROXY, attachOrigin, "a failing probe must not rebind off the healthy explicit endpoint");
        assert.equal(spawned, 0);
    } finally {
        attach.closeAllConnections?.();
        attach.close();
        model.close();
        delete process.env.BILLION_CONTEXT_ATTACH;
        delete process.env.BILLION_CONTEXT_PROXY;
        _setSpawnForTest(undefined);
        _resetNativeStateForTest();
    }
});
