import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { shouldBootstrapNative, nativeProxyScriptPath } from "../src/agent/pi-native.ts";
import { ensureProxyRunning, type SpawnChild, type SpawnFn } from "../src/launcher.ts";

test("shouldBootstrapNative: true in a bare host with no bili env", () => {
    assert.equal(shouldBootstrapNative({}), true);
});

test("shouldBootstrapNative: false when the plugin or native mode is opted out", () => {
    assert.equal(shouldBootstrapNative({ BILLION_CONTEXT_PLUGIN: "0" }), false);
    assert.equal(shouldBootstrapNative({ BILI_NATIVE_PI: "0" }), false);
});

test("shouldBootstrapNative: false when a bili launch already owns a proxy", () => {
    assert.equal(shouldBootstrapNative({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485" }), false);
    assert.equal(shouldBootstrapNative({ BILLION_CONTEXT_PROXY: "  " }), true);
    assert.equal(shouldBootstrapNative({ BILI_PROVIDER_REWRITES: '{"vllm":"http://127.0.0.1:1/bili/http://x"}' }), false);
});

test("nativeProxyScriptPath: dist/agent/pi-native.js resolves to the package bin", () => {
    const resolved = nativeProxyScriptPath("file:///opt/pkg/dist/agent/pi-native.js");
    assert.equal(resolved, path.resolve("/opt/pkg/dist/index.js"));
});

function makeFakeChild(pid: number): SpawnChild {
    return {
        pid,
        unref() {},
        kill() {
            return true;
        },
        on() {},
    };
}

test("ensureProxyRunning: deps.scriptPath overrides process.argv[1] for the spawned proxy (#519)", async () => {
    let spawnScriptArg = "";
    const spawnImpl: SpawnFn = (_command, args) => {
        spawnScriptArg = args[0];
        return makeFakeChild(42431);
    };
    await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        { fetchImpl: async () => ({ ok: true }), spawnImpl, readInstanceFile: () => undefined, scriptPath: "/opt/pkg/dist/index.js" },
    );
    assert.equal(spawnScriptArg, "/opt/pkg/dist/index.js");
});
