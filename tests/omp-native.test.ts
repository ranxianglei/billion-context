import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import factory, { ompTrafficRidesBili, shouldBootstrapNativeOmp } from "../src/agent/omp-native.ts";
import { applyOmpFirstEventTimeout, nativeProxyScriptPath, ompFirstEventTimeoutValue, OMP_FIRST_EVENT_TIMEOUT_DEFAULT_MS, OMP_FIRST_EVENT_TIMEOUT_ENV } from "../src/agent/native-bootstrap.ts";
import { pluginInstall, pluginRemove, pluginStatusAll, selfPackageRoot, ompPluginLoadedFrom } from "../src/plugin-install.ts";
import { rmrf } from "./tmp-rm.ts";

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
