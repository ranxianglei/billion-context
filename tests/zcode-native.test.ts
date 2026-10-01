import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    activateZcodePluginMode,
    bootstrapZcodeNative,
    handoffZcodeRoutingOnExit,
    planNativeZcode,
    probeProxyHealth,
    repairSharedStoreDrift,
    restoreZcodeBackup,
    routeZcodeConfig,
    unrouteZcode,
} from "../src/zcode/native.ts";
import { detectCurrentZcodeOrigin, zcodeStoreCandidates } from "../src/zcode/json-edit.ts";
import { rmrf } from "./tmp-rm.ts";

// #1145: the per-session bootstrap lifecycle — plan decision table, health
// probe, routing with #1002 snapshot discipline, stamp, unroute, restore.
// Ports always come from listen(0) so the suite stays deterministic (#360).

const UPSTREAM = "https://open.bigmodel.cn/api/anthropic";

function dataDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "zcode-native-"));
    mkdirSync(path.join(dir, "v2"), { recursive: true });
    writeFileSync(
        zcodeStoreCandidates(dir, "legacy", {})[0],
        JSON.stringify({ provider: { "builtin:bigmodel-coding-plan": { options: { baseURL: UPSTREAM } } } }) + "\n",
    );
    return dir;
}

async function withHealthServer<T>(fn: (origin: string) => Promise<T>): Promise<T> {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    try {
        return await fn(`http://127.0.0.1:${addr.port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
    }
}

async function deadOrigin(): Promise<string> {
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    await new Promise<void>((r) => server.close(() => r()));
    return `http://127.0.0.1:${addr.port}`;
}

test("planNativeZcode resolves kill-switches > attach > spawn", () => {
    assert.deepEqual(planNativeZcode({}), { mode: "spawn" });
    assert.deepEqual(planNativeZcode({ BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeZcode({ BILI_NATIVE_ZCODE: "0" }), { mode: "off" });
    assert.deepEqual(planNativeZcode({ BILI_PROVIDER_REWRITES: "" }), { mode: "off" });
    assert.deepEqual(planNativeZcode({ BILLION_CONTEXT_ATTACH: "http://127.0.0.1:9999/" }), { mode: "attach", attachOrigin: "http://127.0.0.1:9999" });
    assert.deepEqual(planNativeZcode({ BILLION_CONTEXT_PROXY: "https://127.0.0.1:8787" }), { mode: "attach", attachOrigin: "https://127.0.0.1:8787" });
    assert.deepEqual(
        planNativeZcode({ BILLION_CONTEXT_ATTACH: "http://127.0.0.1:9999", BILLION_CONTEXT_PROXY: "https://127.0.0.1:8787" }),
        { mode: "attach", attachOrigin: "http://127.0.0.1:9999" },
    );
    assert.deepEqual(planNativeZcode({ BILLION_CONTEXT_ATTACH: "not-a-url" }), { mode: "spawn" });
});

test("probeProxyHealth accepts any live proxy answer and rejects failures", async () => {
    await withHealthServer(async (origin) => {
        assert.equal(await probeProxyHealth(origin), true);
    });
    assert.equal(await probeProxyHealth(await deadOrigin()), false);
    const bad = http.createServer((_req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"ok":true}');
    });
    await new Promise<void>((r) => bad.listen(0, "127.0.0.1", r));
    const badAddr = bad.address();
    if (badAddr === null || typeof badAddr === "string") throw new Error("no port");
    try {
        assert.equal(await probeProxyHealth(`http://127.0.0.1:${badAddr.port}`), false);
    } finally {
        bad.closeAllConnections();
        await new Promise<void>((r) => bad.close(() => r()));
    }
});

test("routeZcodeConfig wraps the store and snapshots pre-bili state once", async () => {
    const dir = dataDir();
    try {
        const original = readFileSync(zcodeStoreCandidates(dir, "legacy", {})[0], "utf8");
        const logs: string[] = [];
        const applied = await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: (m) => logs.push(m) });
        assert.ok(applied);
        assert.equal(applied.kind, "legacy");
        assert.equal(applied.port, 18787);
        assert.equal(applied.upstream, UPSTREAM);
        assert.deepEqual(applied.wrapped, [{ id: "builtin:bigmodel-coding-plan", upstream: UPSTREAM }]);
        assert.match(readFileSync(applied.file, "utf8"), /http:\/\/127\.0\.0\.1:18787\/bili\//);
        assert.equal(readFileSync(`${applied.file}.bili-bak`, "utf8"), original);

        const rerouted = await routeZcodeConfig({ origin: "http://127.0.0.1:28787", dataDir: dir, log: (m) => logs.push(m) });
        assert.ok(rerouted);
        assert.match(readFileSync(rerouted.file, "utf8"), /http:\/\/127\.0\.0\.1:28787\/bili\//);
        assert.equal(readFileSync(`${rerouted.file}.bili-bak`, "utf8"), original);
    } finally {
        rmrf(dir);
    }
});

test("routeZcodeConfig re-snapshots user edits made while native mode is active", async () => {
    const dir = dataDir();
    try {
        const file = zcodeStoreCandidates(dir, "legacy", {})[0];
        await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: () => {} });
        const userEdited = JSON.stringify({ provider: { "builtin:bigmodel-coding-plan": { options: { baseURL: "https://api.user-edit.example/v1" } }, note: "user edit" } }) + "\n";
        // (route:"all" wraps what exists — a usable baseURL re-routes; an
        // entry stripped of its baseURL is skipped, not default-filled.)
        writeFileSync(file, userEdited);
        await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: () => {} });
        assert.equal(readFileSync(`${file}.bili-bak`, "utf8"), userEdited);
        const restored = restoreZcodeBackup({ dataDir: dir, log: () => {} });
        assert.deepEqual(restored, { restored: true });
        assert.equal(readFileSync(file, "utf8"), userEdited);
    } finally {
        rmrf(dir);
    }
});

test("routeZcodeConfig reports why it cannot route instead of guessing", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "zcode-native-empty-"));
    try {
        const logs: string[] = [];
        assert.equal(await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: empty, log: (m) => logs.push(m) }), undefined);
        assert.match(logs[0], /nothing to route/);
        mkdirSync(path.join(empty, "v2"), { recursive: true });
        logs.length = 0;
        assert.equal(await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: empty, log: (m) => logs.push(m) }), undefined);
        assert.match(logs[0], /nothing to route/);
    } finally {
        rmrf(empty);
    }
    await assert.rejects(routeZcodeConfig({ origin: "http://127.0.0.1", dataDir: dataDir(), log: () => {} }), /cannot derive a port/);
});

test("activateZcodePluginMode stamps the header into the routed entries", async () => {
    const dir = dataDir();
    try {
        const applied = await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: () => {} });
        assert.ok(applied);
        await activateZcodePluginMode(applied, { dataDir: dir, log: () => {} });
        const parsed = JSON.parse(readFileSync(applied.file, "utf8")) as { provider: Record<string, { options: { headers?: Record<string, string> } }> };
        assert.equal(parsed.provider["builtin:bigmodel-coding-plan"].options.headers?.["x-bili-plugin"], "zcode");
    } finally {
        rmrf(dir);
    }
});

test("unrouteZcode strips wrappers in place and drops snapshots", async () => {
    const dir = dataDir();
    try {
        const file = zcodeStoreCandidates(dir, "legacy", {})[0];
        await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: () => {} });
        unrouteZcode({ dataDir: dir, log: () => {} });
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { provider: Record<string, { options: { baseURL: string } }> };
        assert.equal(parsed.provider["builtin:bigmodel-coding-plan"].options.baseURL, UPSTREAM);
        assert.equal(existsSync(`${file}.bili-bak`), false);
        assert.equal(existsSync(`${file}.bili-last`), false);
    } finally {
        rmrf(dir);
    }
});

test("bootstrapZcodeNative honors the off plan without touching the proxy", async () => {
    const dir = dataDir();
    try {
        let called = false;
        const out = await bootstrapZcodeNative({
            env: { BILI_NATIVE_ZCODE: "0" },
            dataDir: dir,
            ensureProxy: async () => {
                called = true;
                return { origin: "http://127.0.0.1:1", attached: false };
            },
        });
        assert.deepEqual(out, { mode: "off" });
        assert.equal(called, false);
    } finally {
        rmrf(dir);
    }
});

test("bootstrapZcodeNative attaches to a healthy proxy and routes", async () => {
    const dir = dataDir();
    try {
        await withHealthServer(async (origin) => {
            const out = await bootstrapZcodeNative({ env: { BILLION_CONTEXT_ATTACH: origin }, dataDir: dir, log: () => {} });
            assert.equal(out.mode, "active");
            if (out.mode !== "active") return;
            assert.equal(out.attached, true);
            assert.ok(out.routed);
            assert.equal(out.routed.origin, origin);
        });
    } finally {
        rmrf(dir);
    }
});

test("bootstrapZcodeNative fails closed on an unhealthy attach target", async () => {
    const dir = dataDir();
    try {
        const origin = await deadOrigin();
        await assert.rejects(
            bootstrapZcodeNative({ env: { BILLION_CONTEXT_ATTACH: origin }, dataDir: dir, log: () => {}, healthDeadlineMs: 300 }),
            /not healthy/,
        );
    } finally {
        rmrf(dir);
    }
});

test("bootstrapZcodeNative spawns through the injected ensureProxy seam", async () => {
    const dir = dataDir();
    try {
        await withHealthServer(async (origin) => {
            const out = await bootstrapZcodeNative({
                env: {},
                dataDir: dir,
                log: () => {},
                ensureProxy: async () => ({ origin, attached: false }),
            });
            assert.equal(out.mode, "active");
            if (out.mode !== "active") return;
            assert.equal(out.attached, false);
            assert.ok(out.routed);
            assert.equal(out.routed.origin, origin);
        });
    } finally {
        rmrf(dir);
    }
});

test("bootstrap honors upstream env relocation: ZCODE_DATA_BASE_DIR is a base dir (#1151)", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "zcode-native-base-"));
    try {
        const v2 = path.join(base, ".zcode", "v2");
        mkdirSync(v2, { recursive: true });
        const file = path.join(v2, "config.json");
        writeFileSync(file, JSON.stringify({ provider: { "builtin:bigmodel-coding-plan": { options: { baseURL: UPSTREAM } } } }) + "\n");
        const applied = await routeZcodeConfig({ origin: "http://127.0.0.1:18787", env: { ZCODE_DATA_BASE_DIR: base }, log: () => {} });
        assert.ok(applied);
        assert.equal(applied.file, file);
        assert.match(readFileSync(file, "utf8"), /http:\/\/127\.0\.0\.1:18787\/bili\//);
        assert.ok(restoreZcodeBackup({ env: { ZCODE_DATA_BASE_DIR: base }, log: () => {} }).restored);
        assert.doesNotMatch(readFileSync(file, "utf8"), /\/bili\//);
    } finally {
        rmrf(base);
    }
});

// #1621: the v3.14+ personal store generation ships ClientRequestSigningV4,
// which rejects the http loopback /bili/ origin at model creation — native
// routing must degrade to off on these builds instead of producing the
// "MCP connected but every coding-plan model fails" intermediate state.

function newStoreDir(): { dir: string; file: string; original: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "zcode-native-new-"));
    mkdirSync(path.join(dir, "v2"), { recursive: true });
    const file = zcodeStoreCandidates(dir, "new", {})[0];
    const original =
        JSON.stringify({
            schemaVersion: 1,
            config: {
                providerConfigRules: {
                    providerRules: [{ providerId: "account:bigmodel-individual-coding-plan", config: { api: { baseUrl: UPSTREAM } } }],
                },
            },
        }) + "\n";
    writeFileSync(file, original);
    return { dir, file, original };
}

test("routeZcodeConfig refuses to wrap the v3.14+ store (#1621 client signing)", async () => {
    const { dir, file, original } = newStoreDir();
    try {
        const logs: string[] = [];
        assert.equal(await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, env: {}, log: (m) => logs.push(m) }), undefined);
        // #1622 route:"all" default: the signing account is skipped
        // per-entry with a logged reason; with nothing else routable the
        // store stays byte-identical and no snapshots appear.
        assert.match(logs.join(" "), /client[- ]signing/);
        assert.match(logs.join(" "), /cert-MITM/);
        assert.equal(readFileSync(file, "utf8"), original);
        assert.equal(existsSync(`${file}.bili-bak`), false);
        assert.equal(existsSync(`${file}.bili-last`), false);
    } finally {
        rmrf(dir);
    }
});

test("bootstrapZcodeNative degrades to off on the v3.14+ store without proxy bring-up (#1621)", async () => {
    const { dir, file } = newStoreDir();
    writeFileSync(file, readFileSync(file, "utf8").replace(UPSTREAM, `http://127.0.0.1:9999/bili/${UPSTREAM}`));
    try {
        let proxyTouched = false;
        const logs: string[] = [];
        const out = await bootstrapZcodeNative({
            // route:"plans" is the scope where the signing wall still blocks
            // the whole store (#1622): plan accounts ARE the signing accounts.
            env: { BILI_ZCODE_ROUTE: "plans" },
            dataDir: dir,
            log: (m) => logs.push(m),
            ensureProxy: async () => {
                proxyTouched = true;
                return { origin: "http://127.0.0.1:1", attached: false };
            },
        });
        assert.deepEqual(out, { mode: "off" });
        assert.equal(proxyTouched, false);
        assert.match(logs[0], /client signing/);
        // mcp-entry's off path runs unrouteZcode — a wrapper left by a
        // pre-#1621 bili version must be stripped, not stranded.
        unrouteZcode({ dataDir: dir, env: {}, log: () => {} });
        assert.doesNotMatch(readFileSync(file, "utf8"), /\/bili\//);
        const unwrapped = JSON.parse(readFileSync(file, "utf8")) as { config: { providerConfigRules: { providerRules: Array<{ config: { api: { baseUrl: string } } }> } } };
        assert.equal(unwrapped.config.providerConfigRules.providerRules[0].config.api.baseUrl, UPSTREAM);
    } finally {
        rmrf(dir);
    }
});

test("bootstrap honors ZCODE_PERSONAL_PROVIDER_CONFIG_FILE overrides (#1151)", async () => {
    const dir = dataDir();
    const alt = mkdtempSync(path.join(tmpdir(), "zcode-native-alt-"));
    try {
        const file = path.join(alt, "p.json");
        const original =
            JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [{ providerId: "account:bigmodel-individual-coding-plan", config: { api: { baseUrl: UPSTREAM } } }] } } }) + "\n";
        writeFileSync(file, original);
        const env = { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: file };
        // #1622 route:"all" default: the override points at a v3.14+
        // personal store whose only entry is a signing account, so it is
        // skipped per-entry — honoring the override is proven by the skip
        // naming the signing conflict AND the legacy store at dataDir
        // staying unwrapped instead of being routed.
        const logs: string[] = [];
        assert.equal(await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, env, log: (m) => logs.push(m) }), undefined);
        assert.match(logs.join(" "), /client[- ]signing/);
        assert.equal(readFileSync(file, "utf8"), original);
        assert.doesNotMatch(readFileSync(zcodeStoreCandidates(dir, "legacy", {})[0], "utf8"), /\/bili\//);
    } finally {
        rmrf(dir);
        rmrf(alt);
    }
});

// #1622: route scope + exemptions. Default "all" mirrors the in-process
// natives (pi/dsh): every provider rides compression, loopback targets are
// never re-proxied (#809), providers-route `direct: true` keys opt specific
// upstreams out, and the #1621 signing wall degrades to a per-entry skip
// instead of blocking the whole store.

test('route:"all" wraps every non-exempt provider and reports skips (#1622)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zcode-native-all-"));
    mkdirSync(path.join(dir, "v2"), { recursive: true });
    const file = zcodeStoreCandidates(dir, "new", {})[0];
    writeFileSync(
        file,
        JSON.stringify({
            schemaVersion: 1,
            config: {
                providerConfigRules: {
                    providerRules: [
                        { providerId: "account:deepseek", config: { api: { baseUrl: "https://api.deepseek.com/v1" } } },
                        { providerId: "account:bigmodel-individual-coding-plan", config: { api: { baseUrl: "https://open.bigmodel.cn/api/paas/v4" } } },
                        { providerId: "account:local-relay", config: { api: { baseUrl: "http://localhost:8080/v1" } } },
                        { providerId: "account:kimi", config: { api: { baseUrl: "https://api.moonshot.cn/v1" } } },
                        { providerId: "account:no-base-url", config: { name: "configured elsewhere" } },
                    ],
                },
            },
        }) + "\n",
    );
    try {
        const logs: string[] = [];
        const applied = await routeZcodeConfig({
            origin: "http://127.0.0.1:18787",
            dataDir: dir,
            env: {},
            log: (m) => logs.push(m),
            policy: { route: "all", directPrefixes: ["https://api.moonshot.cn/v1"], assumeSigningFixed: false },
        });
        assert.ok(applied);
        assert.deepEqual(applied.wrapped, [{ id: "account:deepseek", upstream: "https://api.deepseek.com/v1" }]);
        const doc = JSON.parse(readFileSync(file, "utf8")) as { config: { providerConfigRules: { providerRules: Array<{ providerId: string; config?: { api?: { baseUrl?: string } } }> } } };
        const byId = new Map(doc.config.providerConfigRules.providerRules.map((r) => [r.providerId, r.config?.api?.baseUrl]));
        assert.equal(byId.get("account:deepseek"), "http://127.0.0.1:18787/bili/https://api.deepseek.com/v1");
        assert.equal(byId.get("account:bigmodel-individual-coding-plan"), "https://open.bigmodel.cn/api/paas/v4");
        assert.equal(byId.get("account:local-relay"), "http://localhost:8080/v1");
        assert.equal(byId.get("account:kimi"), "https://api.moonshot.cn/v1");
        const joined = logs.join(" ");
        assert.match(joined, /client[- ]signing/);
        assert.match(joined, /loopback target/);
        assert.match(joined, /direct exemption/);
        assert.match(joined, /no usable http/);
    } finally {
        rmrf(dir);
    }
});

test('route:"all" on the legacy store wraps non-plan providers and unroute strips them (#1622)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zcode-native-legacy-all-"));
    mkdirSync(path.join(dir, "v2"), { recursive: true });
    const file = zcodeStoreCandidates(dir, "legacy", {})[0];
    writeFileSync(
        file,
        JSON.stringify({
            provider: {
                "builtin:bigmodel-coding-plan": { options: { baseURL: UPSTREAM } },
                "custom:other-vendor": { options: { baseURL: "https://api.other.example/v1" } },
                "custom:local": { options: { baseURL: "http://127.0.0.1:9997/v1" } },
            },
        }) + "\n",
    );
    try {
        const applied = await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, env: {}, log: () => {} });
        assert.ok(applied);
        assert.equal(applied.kind, "legacy");
        assert.deepEqual(applied.wrapped, [
            { id: "builtin:bigmodel-coding-plan", upstream: UPSTREAM },
            { id: "custom:other-vendor", upstream: "https://api.other.example/v1" },
        ]);
        const doc = JSON.parse(readFileSync(file, "utf8")) as { provider: Record<string, { options?: { baseURL?: string } }> };
        assert.equal(doc.provider["builtin:bigmodel-coding-plan"].options?.baseURL, `http://127.0.0.1:18787/bili/${UPSTREAM}`);
        assert.equal(doc.provider["custom:other-vendor"].options?.baseURL, "http://127.0.0.1:18787/bili/https://api.other.example/v1");
        assert.equal(doc.provider["custom:local"].options?.baseURL, "http://127.0.0.1:9997/v1");
        // Non-plan wrappers must be stripped too — unroute can't know which
        // policy wrote them.
        unrouteZcode({ dataDir: dir, env: {}, log: () => {} });
        assert.doesNotMatch(readFileSync(file, "utf8"), /\/bili\//);
    } finally {
        rmrf(dir);
    }
});

test('bootstrapZcodeNative respects zcode route:"none" without proxy bring-up (#1622)', async () => {
    const dir = dataDir();
    try {
        let proxyTouched = false;
        const logs: string[] = [];
        const out = await bootstrapZcodeNative({
            env: { BILI_ZCODE_ROUTE: "none" },
            dataDir: dir,
            log: (m) => logs.push(m),
            ensureProxy: async () => {
                proxyTouched = true;
                return { origin: "http://127.0.0.1:1", attached: false };
            },
        });
        assert.deepEqual(out, { mode: "off" });
        assert.equal(proxyTouched, false);
        assert.match(logs[0], /none/);
        assert.doesNotMatch(readFileSync(zcodeStoreCandidates(dir, "legacy", {})[0], "utf8"), /\/bili\//);
    } finally {
        rmrf(dir);
    }
});

test("resolveZcodeNativePort: env-only explicit override, undefined without one (#1622/#1660)", async () => {
    const { resolveZcodeNativePort, zcodeDirectPrefixes } = await import("../src/config.ts");
    assert.equal(resolveZcodeNativePort({ BILI_ZCODE_PORT: "41234" }), 41234);
    assert.equal(resolveZcodeNativePort({ BILI_ZCODE_PORT: "not-a-port" }), undefined);
    assert.equal(resolveZcodeNativePort({ BILI_ZCODE_PORT: "70000" }), undefined);
    assert.equal(resolveZcodeNativePort({}), undefined, "#1660: no default — the zcode lane rides the zone preference");
    const dir = mkdtempSync(path.join(tmpdir(), "zcode-native-config-"));
    const cfg = path.join(dir, "providers.json");
    writeFileSync(cfg, JSON.stringify({
        "https://api.moonshot.cn/v1": { direct: true },
        "https://api.deepseek.com/v1": {},
    }));
    try {
        const prefixes = zcodeDirectPrefixes({ ACP_PROVIDERS: cfg });
        assert.ok(prefixes.includes("https://api.moonshot.cn/v1"));
        assert.ok(!prefixes.includes("https://api.deepseek.com/v1"));
    } finally {
        rmrf(dir);
    }
});

// #1623: the shared provider store is a last-writer-wins pointer across all
// instances; an instance that dies without handoff leaves it pointing at a
// dead port. Drift repair + exit handoff must keep that pointer live.

const DEAD_SELF = "http://127.0.0.1:1";
const NO_LOG = () => {};

function storeFile(dir: string): string {
    return zcodeStoreCandidates(dir, "legacy", {})[0];
}

test("detectCurrentZcodeOrigin reads back the managed wrapper origin (#1623)", async () => {
    const dir = dataDir();
    try {
        assert.equal(detectCurrentZcodeOrigin(dir), undefined);
        await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: NO_LOG });
        assert.equal(detectCurrentZcodeOrigin(dir), "http://127.0.0.1:18787");
        unrouteZcode({ dataDir: dir, log: NO_LOG });
        assert.equal(detectCurrentZcodeOrigin(dir), undefined);
    } finally {
        rmrf(dir);
    }
});

test("repairSharedStoreDrift no-ops for unmanaged and self pointers (#1623)", async () => {
    const dir = dataDir();
    try {
        assert.equal(
            await repairSharedStoreDrift({ selfOrigin: DEAD_SELF, dataDir: dir, log: NO_LOG, probe: async () => true }),
            "unmanaged",
        );
        await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: NO_LOG });
        assert.equal(
            await repairSharedStoreDrift({ selfOrigin: "http://127.0.0.1:18787", dataDir: dir, log: NO_LOG, probe: async () => true }),
            "self",
        );
    } finally {
        rmrf(dir);
    }
});

test("repairSharedStoreDrift repoints a dead foreign pointer at the healthy self (#1623)", async () => {
    await withHealthServer(async (selfOrigin) => {
        const dir = dataDir();
        try {
            const dead = await deadOrigin();
            await routeZcodeConfig({ origin: dead, dataDir: dir, log: NO_LOG });
            assert.equal(await repairSharedStoreDrift({ selfOrigin, dataDir: dir, log: NO_LOG }), "repointed-self");
            assert.equal(detectCurrentZcodeOrigin(dir), selfOrigin);
        } finally {
            rmrf(dir);
        }
    });
});

test("repairSharedStoreDrift leaves a live foreign pointer alone (#1623)", async () => {
    await withHealthServer(async (foreign) => {
        const dir = dataDir();
        try {
            await routeZcodeConfig({ origin: foreign, dataDir: dir, log: NO_LOG });
            const before = readFileSync(storeFile(dir), "utf8");
            assert.equal(
                await repairSharedStoreDrift({ selfOrigin: DEAD_SELF, dataDir: dir, log: NO_LOG, probe: async (o) => o === foreign }),
                "foreign-live",
            );
            assert.equal(readFileSync(storeFile(dir), "utf8"), before);
        } finally {
            rmrf(dir);
        }
    });
});

test("repairSharedStoreDrift falls through to a live replacement when self is down (#1623)", async () => {
    await withHealthServer(async (replacement) => {
        const dir = dataDir();
        try {
            await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: NO_LOG });
            assert.equal(
                await repairSharedStoreDrift({
                    selfOrigin: DEAD_SELF,
                    dataDir: dir,
                    log: NO_LOG,
                    probe: async (o) => o === replacement,
                    findReplacement: async () => ({ origin: replacement }),
                }),
                "repointed-replacement",
            );
            assert.equal(detectCurrentZcodeOrigin(dir), replacement);
        } finally {
            rmrf(dir);
        }
    });
});

test("repairSharedStoreDrift reverts to direct when nothing live remains (#1623)", async () => {
    const dir = dataDir();
    try {
        await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: NO_LOG });
        assert.equal(
            await repairSharedStoreDrift({
                selfOrigin: DEAD_SELF,
                dataDir: dir,
                log: NO_LOG,
                probe: async () => false,
                findReplacement: async () => undefined,
            }),
            "reverted-direct",
        );
        const text = readFileSync(storeFile(dir), "utf8");
        assert.ok(text.includes(UPSTREAM));
        assert.doesNotMatch(text, /\/bili\//);
    } finally {
        rmrf(dir);
    }
});

test("handoffZcodeRoutingOnExit leaves a foreign pointer untouched (#1623)", async () => {
    const dir = dataDir();
    try {
        await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: NO_LOG });
        const before = readFileSync(storeFile(dir), "utf8");
        assert.equal(
            await handoffZcodeRoutingOnExit({
                ownOrigin: DEAD_SELF,
                dataDir: dir,
                log: NO_LOG,
                findReplacement: async () => ({ origin: "http://127.0.0.1:28787" }),
            }),
            "not-ours",
        );
        assert.equal(readFileSync(storeFile(dir), "utf8"), before);
    } finally {
        rmrf(dir);
    }
});

test("handoffZcodeRoutingOnExit hands our pointer to a live replacement (#1623)", async () => {
    const dir = dataDir();
    try {
        await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: NO_LOG });
        assert.equal(
            await handoffZcodeRoutingOnExit({
                ownOrigin: "http://127.0.0.1:18787",
                dataDir: dir,
                log: NO_LOG,
                findReplacement: async () => ({ origin: "http://127.0.0.1:28787" }),
            }),
            "handed-off",
        );
        assert.equal(detectCurrentZcodeOrigin(dir), "http://127.0.0.1:28787");
    } finally {
        rmrf(dir);
    }
});

test("handoffZcodeRoutingOnExit reverts to direct when no replacement lives (#1623)", async () => {
    const dir = dataDir();
    try {
        await routeZcodeConfig({ origin: "http://127.0.0.1:18787", dataDir: dir, log: NO_LOG });
        assert.equal(
            await handoffZcodeRoutingOnExit({
                ownOrigin: "http://127.0.0.1:18787",
                dataDir: dir,
                log: NO_LOG,
                findReplacement: async () => undefined,
            }),
            "reverted-direct",
        );
        const text = readFileSync(storeFile(dir), "utf8");
        assert.ok(text.includes(UPSTREAM));
        assert.doesNotMatch(text, /\/bili\//);
    } finally {
        rmrf(dir);
    }
});
