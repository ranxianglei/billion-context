import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { shouldBootstrapNative, nativeProxyScriptPath, singleFlight, isLegacyBcpEntry, legacyBcpEntriesIn, planNativePi, armNativePi, _resetNativeStateForTest, _setSpawnForTest, _stateRespawnForTest, _noteRoutedForTest } from "../src/agent/pi-native.ts";
import { INLINE_ORIGIN } from "../src/inline-engine.ts";
import { ensureProxyRunning, type SpawnChild, type SpawnFn } from "../src/launcher.ts";

// #1135 wiring tests drive verifyAttachAndRecover against a dead target — cap
// the routed-evidence grace so the probe fails fast instead of paying the 5s default.
process.env.BILI_ATTACH_EVIDENCE_GRACE_MS = "30";

// #3501: a dev shell running pi through a launcher exports a live attach
// target; verifyAttachAndRecover reads BILLION_CONTEXT_ATTACH explicitly, so
// every suite below must start from a clean slate or it silently binds to the
// real proxy instead of the mock it set up.
delete process.env.BILLION_CONTEXT_ATTACH;
delete process.env.BILLION_CONTEXT_PROXY;

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

test("planNativePi: default is the in-process inline lane (#4571); opt-out and /bili/ launches are off", () => {
    // plain `pi` with the plugin and no signals plans the spawned proxy —
    // inline is OPT-IN (#4687 reverts the #4571 default flip; owner rule:
    // never change defaults). Explicit opt-out paths also plan the server.
    assert.deepEqual(planNativePi({}), { mode: "spawn" }, "default stays spawn (no default flip)");
    assert.deepEqual(planNativePi({ BILI_PI_INLINE: "0" }), { mode: "spawn" });
    assert.deepEqual(planNativePi({}, false), { mode: "spawn" });
    assert.deepEqual(planNativePi({}, true), { mode: "inline" });
    assert.deepEqual(planNativePi({ BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativePi({ BILI_NATIVE_PI: "0" }), { mode: "off" });
    assert.deepEqual(planNativePi({ BILI_PROVIDER_REWRITES: '{"vllm":"http://127.0.0.1:1/bili/http://x"}' }), { mode: "off" });
});

test("planNativePi: a preset BILLION_CONTEXT_PROXY is an attach target, not a stand-down", () => {
    // #1795 regression: the pseudo-attach hole used to resolve a preset proxy
    // to "off" (gate closed), disarming the fetch intercept entirely so every
    // model request went direct and uncompressed.
    assert.deepEqual(
        planNativePi({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485" }),
        { mode: "attach", attachOrigin: "http://127.0.0.1:36485" },
    );
    assert.deepEqual(
        planNativePi({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485/" }),
        { mode: "attach", attachOrigin: "http://127.0.0.1:36485" },
    );
    // kill switches and a /bili/ launch still win over the preset
    assert.deepEqual(planNativePi({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativePi({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILI_PROVIDER_REWRITES: "{}" }), { mode: "off" });
    // a garbage / blank preset falls back to self-managed — the spawned
    // server (historical default), never dead-off
    assert.deepEqual(planNativePi({ BILLION_CONTEXT_PROXY: "garbage" }), { mode: "spawn" });
    assert.deepEqual(planNativePi({ BILLION_CONTEXT_PROXY: "  " }), { mode: "spawn" });
});

test("planNativePi: explicit BILLION_CONTEXT_ATTACH wins over the env preset", () => {
    assert.deepEqual(
        planNativePi({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485", BILLION_CONTEXT_ATTACH: "http://10.0.0.5:9000" }),
        { mode: "attach", attachOrigin: "http://10.0.0.5:9000" },
    );
});

test("#3278: BILI_PI_INLINE plans the no-server lane and outranks ambient attach envs", () => {
    assert.deepEqual(planNativePi({ BILI_PI_INLINE: "1" }), { mode: "inline" });
    assert.deepEqual(planNativePi({ BILI_PI_INLINE: "true" }), { mode: "inline" });
    // explicit opt-in beats a preset proxy / explicit attach — it decides WHERE
    // compression runs, not which proxy to use
    assert.deepEqual(
        planNativePi({ BILI_PI_INLINE: "1", BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485" }),
        { mode: "inline" },
    );
    assert.deepEqual(
        planNativePi({ BILI_PI_INLINE: "1", BILLION_CONTEXT_ATTACH: "http://10.0.0.5:9000" }),
        { mode: "inline" },
    );
    // kill switches and /bili/ launches still win over everything
    assert.deepEqual(planNativePi({ BILI_PI_INLINE: "1", BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativePi({ BILI_PI_INLINE: "1", BILI_NATIVE_PI: "0" }), { mode: "off" });
    assert.deepEqual(planNativePi({ BILI_PI_INLINE: "1", BILI_PROVIDER_REWRITES: "{}" }), { mode: "off" });
    // unset / off values keep today's postures untouched
    assert.deepEqual(planNativePi({ BILI_PI_INLINE: "0" }), { mode: "spawn" });
    assert.deepEqual(planNativePi({}), { mode: "spawn" }, "default stays spawn (no default flip)");
});

test("#3278: pi.inline (config file) enables the lane; env resolves over it", () => {
    // file value alone enables; it also outranks ambient attach envs like the env does
    assert.deepEqual(planNativePi({}, true), { mode: "inline" });
    assert.deepEqual(
        planNativePi({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:36485" }, true),
        { mode: "inline" },
    );
    // explicit env off disables over the file
    assert.deepEqual(planNativePi({ BILI_PI_INLINE: "0" }, true), { mode: "spawn" });
    assert.deepEqual(planNativePi({ BILI_PI_INLINE: "false" }, true), { mode: "spawn" });
    // explicit env on enables over a false file value
    assert.deepEqual(planNativePi({ BILI_PI_INLINE: "1" }, false), { mode: "inline" });
    assert.deepEqual(planNativePi({}, false), { mode: "spawn" });
    // kill switches and /bili/ launches still win over the file
    assert.deepEqual(planNativePi({ BILLION_CONTEXT_PLUGIN: "0" }, true), { mode: "off" });
    assert.deepEqual(planNativePi({ BILI_NATIVE_PI: "0" }, true), { mode: "off" });
    assert.deepEqual(planNativePi({ BILI_PROVIDER_REWRITES: "{}" }, true), { mode: "off" });
});

test("#3278: armNativePi(inline) freezes the pseudo-origin synchronously without spawning", () => {
    const savedProxy = process.env.BILLION_CONTEXT_PROXY;
    try {
        _resetNativeStateForTest();
        armNativePi({ mode: "inline" });
        assert.equal(process.env.BILLION_CONTEXT_PROXY, INLINE_ORIGIN);
        assert.equal(process.env.BILLION_CONTEXT_NATIVE, "pi");
        // armed but LAZY under NODE_TEST_CONTEXT — invoking it here would
        // bootstrap a real engine against the ambient XDG dirs
        assert.equal(typeof _stateRespawnForTest(), "function", "respawn seam armed");
    } finally {
        _resetNativeStateForTest();
        if (savedProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = savedProxy;
    }
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
        armNativePi({ mode: "attach", attachOrigin: "http://127.0.0.1:9" });
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
        armNativePi({ mode: "attach", attachOrigin: `http://127.0.0.1:${port}` });
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
        armNativePi({ mode: "attach", attachOrigin });
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
        armNativePi({ mode: "attach", attachOrigin });
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
