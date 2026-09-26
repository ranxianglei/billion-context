import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import {
    KIMI_ALIAS,
    KIMI_MANAGED_BEGIN,
    KIMI_PROVIDER,
    applyKimiManagedConfig,
    extractBiliUpstream,
    kimiProxiedBaseUrl,
    resolveKimiRoute,
    stampKimiPluginHeader,
    stripKimiManagedBlock,
    unrouteKimiConfig,
    type KimiRouteState,
} from "../src/kimi/toml-edit.ts";
import {
    activateKimiPluginMode,
    bootstrapKimiNative,
    planNativeKimi,
    probeProxyHealth,
    unrouteKimi,
} from "../src/kimi/native.ts";
import { portableHookCommand, pluginInstall, pluginRemove, pluginStatusAll } from "../src/plugin-install.ts";

// #963: kimi native mode (plugin + per-session bootstrap). The config.toml
// surgery is the user-facing safety surface (§7.3: never clobber, fail loud),
// so every refusal path gets a test; the bootstrap lifecycle is exercised
// against a real proxy for the route → stamp → runtime-info → unroute cycle.

const SAMPLE_CONFIG = [
    'default_model = "kimi-k3"',
    "",
    '[providers."managed:kimi-code"]',
    'type = "kimi"',
    'base_url = "https://api.kimi.com/coding/v1"',
    'api_key = ""',
    "",
    '[providers."managed:kimi-code".oauth]',
    'storage = "file"',
    'key = "managed:kimi-code"',
    'oauth_host = "https://api.kimi.com"',
].join("\n") + "\n";

const STATE: KimiRouteState = {
    port: 9999,
    upstream: "https://api.kimi.com/coding/v1",
    modelId: "kimi-k3",
    authLines: [
        'api_key = ""',
        `[providers.${KIMI_PROVIDER}.oauth]`,
        'storage = "file"',
        'key = "managed:kimi-code"',
        'oauth_host = "https://api.kimi.com"',
    ],
};

function count(haystack: string, needle: string): number {
    let n = 0;
    let i = haystack.indexOf(needle);
    while (i >= 0) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
    return n;
}

function okOf(res: ReturnType<typeof resolveKimiRoute>): Extract<typeof res, { ok: true }> {
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    return res;
}

function reasonOf(res: ReturnType<typeof resolveKimiRoute>): string {
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("unreachable");
    return res.reason;
}

test("planNativeKimi: kill-switches > attach > spawn (#963)", () => {
    assert.deepEqual(planNativeKimi({}), { mode: "spawn" });
    assert.deepEqual(planNativeKimi({ BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeKimi({ BILI_NATIVE_KIMI: "0" }), { mode: "off" });
    assert.deepEqual(planNativeKimi({ BILI_PROVIDER_REWRITES: "1" }), { mode: "off" });
    assert.deepEqual(planNativeKimi({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787/" }), { mode: "attach", attachOrigin: "http://127.0.0.1:8787" });
    assert.deepEqual(
        planNativeKimi({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:9999", BILLION_CONTEXT_ATTACH: "http://127.0.0.1:8787/" }),
        { mode: "attach", attachOrigin: "http://127.0.0.1:8787" },
    );
    assert.deepEqual(planNativeKimi({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
});

test("applyKimiManagedConfig routes the active model and records the previous default (#963)", () => {
    const applied = applyKimiManagedConfig(SAMPLE_CONFIG, STATE);
    assert.ok(applied.startsWith(`default_model = "${KIMI_ALIAS}"\n`));
    assert.ok(applied.includes(`[providers.${KIMI_PROVIDER}]`));
    assert.ok(applied.includes(`base_url = "${kimiProxiedBaseUrl(9999, STATE.upstream)}"`));
    assert.equal(count(applied, 'storage = "file"'), 2, "oauth sub-table cloned verbatim into the managed block");
    assert.ok(applied.includes('# bili prev-default-model = "kimi-k3"'));
    assert.ok(applied.includes('[providers."managed:kimi-code"]'), "user content preserved");
});

test("applyKimiManagedConfig is idempotent and keeps the pre-native default across bootstraps (#963)", () => {
    const onceApplied = applyKimiManagedConfig(SAMPLE_CONFIG, STATE);
    const twiceApplied = applyKimiManagedConfig(onceApplied, STATE);
    assert.equal(twiceApplied, onceApplied);
    assert.ok(twiceApplied.includes('# bili prev-default-model = "kimi-k3"'));
    assert.equal(unrouteKimiConfig(twiceApplied), SAMPLE_CONFIG);
});

test("re-apply respects a default_model the user switched to by hand (#963)", () => {
    const applied = applyKimiManagedConfig(SAMPLE_CONFIG, STATE).replace(`default_model = "${KIMI_ALIAS}"`, 'default_model = "kimi-k2"');
    const reapplied = applyKimiManagedConfig(applied, STATE);
    assert.ok(reapplied.startsWith('default_model = "kimi-k2"\n'), "user's manual switch must not be yanked back to the alias");
    assert.ok(reapplied.includes('# bili prev-default-model = "kimi-k3"'));
    assert.ok(unrouteKimiConfig(reapplied).startsWith('default_model = "kimi-k2"'));
});

test("unrouteKimiConfig restores the original file byte-for-byte (#963)", () => {
    assert.equal(unrouteKimiConfig(applyKimiManagedConfig(SAMPLE_CONFIG, STATE)), SAMPLE_CONFIG);
});

test("unrouteKimiConfig keeps a manual default_model change made during native mode (#963)", () => {
    const applied = applyKimiManagedConfig(SAMPLE_CONFIG, STATE).replace(`default_model = "${KIMI_ALIAS}"`, 'default_model = "kimi-k2"');
    const reverted = unrouteKimiConfig(applied);
    assert.ok(reverted.startsWith('default_model = "kimi-k2"'));
    assert.ok(!reverted.includes(KIMI_MANAGED_BEGIN));
});

test("applyKimiManagedConfig refuses a user-owned [providers.bili] or [models.bili-kimi] (#963)", () => {
    assert.throws(() => applyKimiManagedConfig(`${SAMPLE_CONFIG}\n[providers.bili]\ntype = "kimi"\n`, STATE), /already defines \[providers\.bili\]/);
    assert.throws(() => applyKimiManagedConfig(`${SAMPLE_CONFIG}\n[models.bili-kimi]\nmodel = "x"\n`, STATE), /already defines \[models\.bili-kimi\]/);
});

test("stripKimiManagedBlock rejects tampered markers instead of guessing (#963)", () => {
    assert.throws(() => stripKimiManagedBlock(`${SAMPLE_CONFIG}# bili end\n`), /stray/);
    assert.throws(() => stripKimiManagedBlock(`${SAMPLE_CONFIG}${KIMI_MANAGED_BEGIN}\n`), /truncated/);
});

test("resolveKimiRoute resolves a logged-in managed provider with its oauth clone (#963)", () => {
    const res = okOf(resolveKimiRoute(SAMPLE_CONFIG, {}));
    assert.equal(res.upstream, "https://api.kimi.com/coding/v1");
    assert.equal(res.modelId, "kimi-k3");
    assert.equal(res.authSource, "managed:kimi-code");
    assert.deepEqual(res.authLines, STATE.authLines);
});

test("resolveKimiRoute refuses to guess when routing is impossible (#963)", () => {
    assert.match(reasonOf(resolveKimiRoute('[providers.x]\ntype = "kimi"\n', {})), /no default_model/);
    const missingProvider = 'default_model = "my-model"\n\n[models.my-model]\nprovider = "custom-x"\nmodel = "m1"\n';
    assert.match(reasonOf(resolveKimiRoute(missingProvider, {})), /is not defined/);
    const noCreds = [
        'default_model = "my-model"',
        "",
        "[models.my-model]",
        'model = "m1"',
        "",
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        'base_url = "https://api.kimi.com/coding/v1"',
    ].join("\n") + "\n";
    assert.match(reasonOf(resolveKimiRoute(noCreds, {})), /has no api_key/);
});

test("resolveKimiRoute honors KIMI_CODE_BASE_URL over the provider base_url (#963)", () => {
    const res = okOf(resolveKimiRoute(SAMPLE_CONFIG, { KIMI_CODE_BASE_URL: "https://custom.example/v1/" }));
    assert.equal(res.upstream, "https://custom.example/v1");
});

test("resolveKimiRoute is idempotent on an already-routed config (#963)", () => {
    const applied = applyKimiManagedConfig(SAMPLE_CONFIG, STATE);
    const res = okOf(resolveKimiRoute(applied, {}));
    assert.equal(res.upstream, STATE.upstream);
    assert.equal(res.modelId, "kimi-k3");
    assert.equal(res.authSource, KIMI_PROVIDER);
});

test("resolveKimiRoute fails closed on a corrupted managed block (#963)", () => {
    const applied = applyKimiManagedConfig(SAMPLE_CONFIG, STATE);
    const brokenUrl = applied.replace(kimiProxiedBaseUrl(9999, STATE.upstream), "https://api.kimi.com/coding/v1");
    assert.match(reasonOf(resolveKimiRoute(brokenUrl, {})), /no longer embeds a bili route/);
    const brokenAuth = applied.replace('api_key = ""\n[providers.bili.oauth]\nstorage = "file"\nkey = "managed:kimi-code"\noauth_host = "https://api.kimi.com"\n', "");
    assert.match(reasonOf(resolveKimiRoute(brokenAuth, {})), /lost its credentials/);
});

test("stampKimiPluginHeader inserts then replaces in place, no-op without a block (#963)", () => {
    const applied = applyKimiManagedConfig(SAMPLE_CONFIG, STATE);
    const stamped = stampKimiPluginHeader(applied);
    const lines = stamped.split("\n");
    const sectionIdx = lines.findIndex((l) => l.trim() === `[providers.${KIMI_PROVIDER}]`);
    assert.equal(lines[sectionIdx + 1], 'custom_headers = { x-bili-plugin = "kimi" }');
    assert.equal(count(stamped, "x-bili-plugin"), 1);
    assert.equal(stampKimiPluginHeader(stamped), stamped);
    assert.equal(stampKimiPluginHeader(SAMPLE_CONFIG), SAMPLE_CONFIG);
});

test("kimiProxiedBaseUrl / extractBiliUpstream round-trip (#963)", () => {
    assert.equal(extractBiliUpstream(kimiProxiedBaseUrl(8787, "https://api.kimi.com/coding/v1")), "https://api.kimi.com/coding/v1");
    assert.equal(kimiProxiedBaseUrl(8787, "https://x.example/"), "http://127.0.0.1:8787/bili/https://x.example");
    assert.equal(extractBiliUpstream("https://api.kimi.com/coding/v1"), undefined);
});

interface FakeHome { home: string; cleanup: () => void }

/** Deterministic fake $KIMI_CODE_HOME: PATH is REPLACED (not prepended) with
 *  a dir holding a `kimi --version` shim, so host-installed Kimi Code can't
 *  leak into these tests. */
function fakeKimiHome(version: string | null): FakeHome {
    const home = path.join(tmpdir(), `bili-kimi-home-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(home, { recursive: true });
    if (version !== null) {
        const bin = path.join(home, "fakebin");
        mkdirSync(bin);
        const shim = path.join(bin, "kimi");
        writeFileSync(shim, `#!/bin/sh\necho "${version}"\n`);
        chmodSync(shim, 0o755);
        if (process.platform === "win32") writeFileSync(path.join(bin, "kimi.cmd"), `@echo off\r\necho ${version}\r\n`);
        process.env.PATH = bin;
    } else {
        process.env.PATH = "";
    }
    const prevPath = process.env.PATH;
    const prevHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = home;
    let done = false;
    return {
        home,
        cleanup: () => {
            if (done) return;
            done = true;
            process.env.PATH = prevPath;
            if (prevHome === undefined) delete process.env.KIMI_CODE_HOME;
            else process.env.KIMI_CODE_HOME = prevHome;
            rmSync(home, { recursive: true, force: true });
        },
    };
}

test("pluginInstall / pluginRemove round-trip for kimi under a fake home (#963)", () => {
    const fake = fakeKimiHome("2.0.1");
    try {
        assert.match(pluginInstall("kimi"), /wrote the billion-context plugin into/);
        const dir = path.join(fake.home, "plugins", "managed", "billion-context");
        interface KimiManifest {
            name: string;
            mcpServers: { bili: { command: string; args: string[]; cwd: string } };
            hooks: Array<{ event: string; command: string; timeout: number }>;
        }
        const manifest = JSON.parse(readFileSync(path.join(dir, "kimi.plugin.json"), "utf8")) as KimiManifest;
        assert.equal(manifest.name, "billion-context");
        assert.equal(manifest.mcpServers.bili.command, "node");
        assert.equal(manifest.mcpServers.bili.args.length, 1);
        assert.ok(manifest.mcpServers.bili.args[0].endsWith(path.join("dist", "kimi", "native-mcp.js")));
        assert.equal(manifest.mcpServers.bili.cwd, "./");
        assert.equal(manifest.hooks[0].event, "SessionStart");
        // The MCP args above keep the platform separator (they cross as an argv
        // array, nothing re-parses them). The hook is the one place kimi hands a
        // shell a STRING, and a Windows path is eaten there as escapes. Exact
        // equality against the portable form (derived from the shared root) so
        // spaced install paths — which quote the argument — still pass.
        const bootstrapArg = manifest.mcpServers.bili.args[0].replace(/native-mcp\.js$/, "bootstrap-hook.js");
        assert.equal(manifest.hooks[0].command, portableHookCommand("node", [bootstrapArg]));
        assert.ok(!manifest.hooks[0].command.includes("\\"), manifest.hooks[0].command);
        interface KimiRegistry { version: number; plugins: Array<{ id: string; root: string; source: string; enabled: boolean }> }
        const reg = JSON.parse(readFileSync(path.join(fake.home, "plugins", "installed.json"), "utf8")) as KimiRegistry;
        assert.equal(reg.version, 1);
        assert.equal(reg.plugins.length, 1);
        assert.equal(reg.plugins[0].id, "billion-context");
        assert.equal(reg.plugins[0].root, dir);
        assert.equal(reg.plugins[0].source, "local-path");
        assert.equal(reg.plugins[0].enabled, true);
        assert.equal(pluginStatusAll().find((s) => s.agent === "kimi")?.status, "installed");

        // Reinstall must upsert, not duplicate the registry record.
        pluginInstall("kimi");
        const reg2 = JSON.parse(readFileSync(path.join(fake.home, "plugins", "installed.json"), "utf8")) as KimiRegistry;
        assert.equal(reg2.plugins.length, 1);

        pluginRemove("kimi");
        assert.equal(existsSync(dir), false);
        assert.equal(pluginStatusAll().find((s) => s.agent === "kimi")?.status, "not installed");
    } finally {
        fake.cleanup();
    }
});

test("pluginInstall kimi enforces the v2 engine floor and binary presence (#963)", () => {
    const old = fakeKimiHome("1.9.0");
    try {
        assert.throws(() => pluginInstall("kimi"), /too old/);
    } finally {
        old.cleanup();
    }
    const missing = fakeKimiHome(null);
    try {
        assert.throws(() => pluginInstall("kimi"), /not found/);
    } finally {
        missing.cleanup();
    }
});

test("bootstrapKimiNative routes config.toml through a live proxy, stamps, reports, unreoutes (#963)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = mkdtempSync(path.join(tmpdir(), "bili-kimi-native-"));
    const biliCfg = path.join(root, "billion-context.json");
    writeFileSync(biliCfg, '{"providers":{}}', "utf8");
    const prevCfgFile = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliCfg;
    const home = path.join(root, "kimi-home");
    mkdirSync(home);
    const cfgPath = path.join(home, "config.toml");
    writeFileSync(cfgPath, SAMPLE_CONFIG, "utf8");

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

    const runtimeInfo: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/__bili/plugin/runtime-info") && init?.body) runtimeInfo.push(JSON.parse(String(init.body)));
        return realFetch(input, init);
    }) as typeof fetch;

    try {
        assert.equal(await probeProxyHealth(origin), true);
        const mode = await bootstrapKimiNative({ env: {}, kimiHome: home, log: () => {}, ensureProxy: async () => ({ origin, attached: false }) });
        assert.equal(mode.mode, "active");
        if (mode.mode !== "active") return;
        assert.equal(mode.attached, false);
        assert.ok(mode.routed);
        assert.equal(mode.routed.upstream, "https://api.kimi.com/coding/v1");
        assert.equal(mode.routed.modelId, "kimi-k3");
        assert.equal(mode.routed.port, Number(new URL(origin).port));

        const written = readFileSync(cfgPath, "utf8");
        assert.ok(written.includes(`base_url = "${kimiProxiedBaseUrl(Number(new URL(origin).port), "https://api.kimi.com/coding/v1")}"`));
        assert.equal(readFileSync(path.join(home, "config.toml.bili-bak"), "utf8"), SAMPLE_CONFIG);

        // A second bootstrap must be a byte-stable no-op (idempotent re-apply).
        const again = await bootstrapKimiNative({ env: {}, kimiHome: home, log: () => {}, ensureProxy: async () => ({ origin, attached: false }) });
        assert.equal(readFileSync(cfgPath, "utf8"), written);
        assert.equal(again.mode === "active" ? again.routed?.upstream : undefined, "https://api.kimi.com/coding/v1");

        await activateKimiPluginMode(mode.routed, { env: {}, kimiHome: home, log: () => {} });
        assert.ok(readFileSync(cfgPath, "utf8").includes('custom_headers = { x-bili-plugin = "kimi" }'));
        assert.equal(runtimeInfo.length, 1);
        assert.deepEqual(runtimeInfo[0], { agent: "kimi", model: "kimi-k3", baseURL: "https://api.kimi.com/coding/v1", source: "native-bootstrap" });

        unrouteKimi({ env: {}, kimiHome: home, log: () => {} });
        assert.equal(readFileSync(cfgPath, "utf8"), SAMPLE_CONFIG);
        assert.equal(existsSync(path.join(home, "config.toml.bili-bak")), false);
    } finally {
        globalThis.fetch = realFetch;
        if (prevCfgFile === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevCfgFile;
        proxy.closeAllConnections?.();
        await new Promise<void>((resolve, reject) => proxy.close((err) => (err ? reject(err) : resolve())));
        rmSync(root, { recursive: true, force: true });
    }
});

test("BILI_NATIVE_KIMI=0 leaves everything untouched (#963)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bili-kimi-off-"));
    const cfgPath = path.join(home, "config.toml");
    writeFileSync(cfgPath, SAMPLE_CONFIG, "utf8");
    let spawned = false;
    try {
        const mode = await bootstrapKimiNative({
            env: { BILI_NATIVE_KIMI: "0" },
            kimiHome: home,
            log: () => {},
            ensureProxy: async () => { spawned = true; return { origin: "http://127.0.0.1:9", attached: false }; },
        });
        assert.deepEqual(mode, { mode: "off" });
        assert.equal(spawned, false);
        assert.equal(readFileSync(cfgPath, "utf8"), SAMPLE_CONFIG);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("bootstrapKimiNative attach waits for health and fails closed on a dead target (#963)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bili-kimi-attach-"));
    const cfgPath = path.join(home, "config.toml");
    writeFileSync(cfgPath, SAMPLE_CONFIG, "utf8");
    try {
        await assert.rejects(
            bootstrapKimiNative({ env: { BILLION_CONTEXT_ATTACH: "http://127.0.0.1:1" }, kimiHome: home, log: () => {}, healthDeadlineMs: 500 }),
            /is not healthy/,
        );
        assert.equal(readFileSync(cfgPath, "utf8"), SAMPLE_CONFIG);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
