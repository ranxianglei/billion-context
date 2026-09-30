import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { shouldBootstrapNative, nativeProxyScriptPath, singleFlight, isLegacyBcpEntry, legacyBcpEntriesIn } from "../src/agent/pi-native.ts";
import { ensureProxyRunning, type SpawnChild, type SpawnFn } from "../src/launcher.ts";

// #820 coexistence: standalone billion-context-pi checks env at load time, so
// the marker must be set synchronously during module evaluation (before our
// async bootstrap writes BILLION_CONTEXT_PROXY) for its action-time back-off.
test("module evaluation marks the process as a native pi host", () => {
    assert.equal(process.env.BILLION_CONTEXT_NATIVE, "pi");
});

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
    // Build the from-URL from a platform-native absolute path: a hardcoded
    // file:///opt/... URL is invalid on Windows (no drive letter —
    // fileURLToPath throws ERR_INVALID_FILE_URL_PATH).
    const agentFile = path.resolve(path.sep, "opt", "pkg", "dist", "agent", "pi-native.js");
    const resolved = nativeProxyScriptPath(pathToFileURL(agentFile).href);
    assert.equal(resolved, path.resolve(path.sep, "opt", "pkg", "dist", "index.js"));
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

test("singleFlight: concurrent callers share one in-flight run, then re-arm", async () => {
    let runs = 0;
    const start = singleFlight(async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 20));
        return "http://127.0.0.1:40001";
    });
    const [a, b, c] = await Promise.all([start(), start(), start()]);
    assert.equal(runs, 1, "three concurrent callers → one bootstrap");
    assert.deepEqual([a, b, c], ["http://127.0.0.1:40001", "http://127.0.0.1:40001", "http://127.0.0.1:40001"]);
    // after settling, the next call starts fresh (a later respawn is allowed)
    const d = await start();
    assert.equal(runs, 2);
    assert.equal(d, "http://127.0.0.1:40001");
});

test("ensureProxyRunning: deps.scriptPath overrides process.argv[1] for the spawned proxy (#519)", async () => {
    let spawnScriptArg = "";
    const spawnImpl: SpawnFn = (_command, args) => {
        spawnScriptArg = args[0];
        return makeFakeChild(42431);
    };
    await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: 42431 }), spawnImpl, readInstanceFile: () => undefined, scriptPath: "/opt/pkg/dist/index.js" },
    );
    assert.equal(spawnScriptArg, "/opt/pkg/dist/index.js");
});

// #939 co-residence net: a legacy billion-context-pi entry that survived the
// installer (project scope, or installed after `bili plugin install pi`)
// double-compresses silently — 0.1.71's BILLION_CONTEXT_PROXY check runs at
// factory time, before this entry's async bootstrap writes it, and the
// fetch-layer rewrite keeps the baseUrl clean. The scan is the only voice in
// that window, so its matcher must catch every legacy form and nothing else.
test("isLegacyBcpEntry: every legacy install form, no false positives", () => {
    for (const legacy of [
        "npm:billion-context-pi",
        "npm:billion-context-pi@0.1.71",
        "/home/x/.local/lib/node_modules/billion-context-pi",
        "C:\\Users\\x\\node_modules\\billion-context-pi\\dist\\agent\\pi.js",
        "git:github.com/ranxianglei/billion-context-pi",
        "/home/x/.pi/agent/git/github.com/ranxianglei/billion-context-pi",
        "./billion-context-pi",
    ]) {
        assert.equal(isLegacyBcpEntry(legacy), true, `legacy form recognized: ${legacy}`);
    }
    for (const ours of [
        "npm:billion-context",
        "npm:billion-context@0.1.118",
        "/home/x/projects/billion-context",
        "/home/x/.pi/agent/npm/node_modules/billion-context",
        "some-other-package",
        "npm:billion-context-pi-lookalike",
    ]) {
        assert.equal(isLegacyBcpEntry(ours), false, `not legacy: ${ours}`);
    }
});

test("legacyBcpEntriesIn: reads packages[], tolerates missing/broken files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-coexist-"));
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ packages: ["npm:billion-context", "npm:billion-context-pi@0.1.71", "other"] }));
    assert.deepEqual(legacyBcpEntriesIn(file), ["npm:billion-context-pi@0.1.71"]);
    fs.writeFileSync(file, JSON.stringify({ theme: "dark" }));
    assert.deepEqual(legacyBcpEntriesIn(file), []);
    fs.writeFileSync(file, "{ not json");
    assert.deepEqual(legacyBcpEntriesIn(file), []);
    assert.deepEqual(legacyBcpEntriesIn(path.join(dir, "missing.json")), []);
});
