import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    extractHttpsHosts,
    discoverMitmDomains,
    _resetDiscoveryCacheForTest,
} from "../src/discover.ts";
import {
    parseZcodeConfig,
    parseZcodePersonalConfig,
    TRAE_DEFAULT_MODEL_HOSTS,
    AIDER_DEFAULT_MODEL_HOSTS,
    readZcodeConfig,
    zcodeDataRoot,
    zcodeStoreFileFor,
    QODER_DEFAULT_MODEL_HOSTS,
    OPENCODE_DEFAULT_MODEL_HOSTS,
    type ClientConfig,
} from "../src/client-config.ts";

test("parseZcodeConfig: reads baseURL from each provider entry", () => {
    const obj = {
        provider: {
            "builtin:bigmodel": { options: { baseURL: "https://open.bigmodel.cn/api/anthropic" } },
            "builtin:zai": { options: { baseURL: "https://api.z.ai/api/anthropic" } },
            "custom:foo": { options: { baseURL: "https://custom.foo.example.com/v1" } },
        },
        selectedProviderId: "builtin:bigmodel",
    };
    const cfg = parseZcodeConfig(obj);
    assert.equal(Object.keys(cfg.providers).length, 3);
    assert.equal(cfg.providers["builtin:bigmodel"].baseURL, "https://open.bigmodel.cn/api/anthropic");
    assert.equal(cfg.providers["builtin:zai"].baseURL, "https://api.z.ai/api/anthropic");
    assert.equal(cfg.providers["custom:foo"].baseURL, "https://custom.foo.example.com/v1");
});

test("parseZcodeConfig: defensive — non-object / missing provider / non-string baseURL", () => {
    assert.deepEqual(parseZcodeConfig(null), { providers: {} });
    assert.deepEqual(parseZcodeConfig("nope"), { providers: {} });
    assert.deepEqual(parseZcodeConfig({}), { providers: {} });
    assert.deepEqual(parseZcodeConfig({ provider: "wrong" }), { providers: {} });
    const mixed = parseZcodeConfig({
        provider: {
            good: { options: { baseURL: "https://good.example.com" } },
            noOptions: { baseURL: "https://stripped.example.com" },
            noBase: { options: { somethingElse: 1 } },
            notObj: "x",
        },
    });
    assert.equal(mixed.providers.good?.baseURL, "https://good.example.com");
    assert.equal(mixed.providers.noOptions, undefined);
    assert.equal(mixed.providers.noBase, undefined);
    assert.equal(mixed.providers.notObj, undefined);
});

function withHome(home: string, fn: () => void): void {
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
        fn();
    } finally {
        if (saved === undefined) delete process.env.HOME;
        else process.env.HOME = saved;
    }
}

test("readZcodeConfig: reads <home>/v2/config.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-zcode-"));
    try {
        const v2 = path.join(tmp, "v2");
        fs.mkdirSync(v2, { recursive: true });
        fs.writeFileSync(
            path.join(v2, "config.json"),
            JSON.stringify({
                provider: { p: { options: { baseURL: "https://z.example.com/api" } } },
            }),
        );
        withHome(tmp, () => {
            const cfg = readZcodeConfig(tmp);
            assert.equal(cfg.providers.p.baseURL, "https://z.example.com/api");
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("readZcodeConfig: missing dir or unparseable file → empty providers", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-zcode-"));
    try {
        withHome(tmp, () => {
            assert.deepEqual(readZcodeConfig(tmp), { providers: {} });
            fs.mkdirSync(path.join(tmp, "v2"), { recursive: true });
            fs.writeFileSync(path.join(tmp, "v2", "config.json"), "not-json{");
            assert.deepEqual(readZcodeConfig(tmp), { providers: {} });
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

function zcodePersonalFixture(): unknown {
    return {
        schemaVersion: 1,
        config: {
            providerOrder: ["custom:foo"],
            providerConfigRules: {
                providerRules: [
                    {
                        providerId: "custom:foo",
                        providerName: "Foo Relay",
                        config: {
                            group: "standard-personal",
                            access: { type: "api-key", apiKey: "sk-test" },
                            api: { type: "openai", baseUrl: "https://custom.foo.example.com/v1" },
                        },
                    },
                    {
                        providerId: "builtin:bigmodel",
                        templateId: "bigmodel-coding-plan",
                        config: { access: { type: "zhipu-coding-plan-api-key", apiKey: "sk-test" } },
                    },
                    { config: { api: { baseUrl: "https://nokey.example.com" } } },
                    "garbage",
                ],
            },
        },
    };
}

test("parseZcodePersonalConfig: extracts api.baseUrl from providerRules (#1151)", () => {
    const cfg = parseZcodePersonalConfig(zcodePersonalFixture());
    assert.deepEqual(Object.keys(cfg.providers), ["custom:foo"]);
    assert.equal(cfg.providers["custom:foo"].baseURL, "https://custom.foo.example.com/v1");
});

test("parseZcodePersonalConfig: defensive — non-object / missing envelope / non-string baseUrl", () => {
    assert.deepEqual(parseZcodePersonalConfig(null), { providers: {} });
    assert.deepEqual(parseZcodePersonalConfig("nope"), { providers: {} });
    assert.deepEqual(parseZcodePersonalConfig({}), { providers: {} });
    assert.deepEqual(parseZcodePersonalConfig({ config: "wrong" }), { providers: {} });
    assert.deepEqual(parseZcodePersonalConfig({ config: { providerConfigRules: "wrong" } }), { providers: {} });
    assert.deepEqual(
        parseZcodePersonalConfig({ config: { providerConfigRules: { providerRules: [{ providerId: "p", config: { api: { baseUrl: 42 } } }] } } }),
        { providers: {} },
    );
});

test("zcodeStoreFileFor: upstream derivation — ZCODE_DATA_BASE_DIR is a base dir, personal override wins (#1151)", () => {
    assert.equal(zcodeStoreFileFor({ ZCODE_DATA_BASE_DIR: "/data" }, "legacy"), path.join("/data", ".zcode", "v2", "config.json"));
    assert.equal(zcodeStoreFileFor({ ZCODE_DATA_BASE_DIR: "/data" }, "new"), path.join("/data", ".zcode", "v2", "provider_config.json"));
    assert.equal(zcodeStoreFileFor({ ZCODE_DATA_BASE_DIR: "/data", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/alt/p.json" }, "new"), "/alt/p.json");
    assert.equal(zcodeStoreFileFor({ ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/alt/p.json" }, "legacy"), zcodeStoreFileFor({}, "legacy"));
});

test("readZcodeConfig: finds the legacy store under upstream env relocation (ZCODE_DATA_BASE_DIR as base dir, #1151)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-zcenv-"));
    try {
        const v2 = path.join(tmp, ".zcode", "v2");
        fs.mkdirSync(v2, { recursive: true });
        fs.writeFileSync(
            path.join(v2, "config.json"),
            JSON.stringify({ provider: { moved: { options: { baseURL: "https://moved.example.com/api" } } } }),
        );
        const cfg = readZcodeConfig(path.join(tmp, ".zcode"), { ZCODE_DATA_BASE_DIR: tmp });
        assert.equal(cfg.providers.moved.baseURL, "https://moved.example.com/api");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("readZcodeConfig: merges legacy config.json with provider_config.json, personal wins per key (#1151)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-zcode-"));
    try {
        const v2 = path.join(tmp, "v2");
        fs.mkdirSync(v2, { recursive: true });
        fs.writeFileSync(
            path.join(v2, "config.json"),
            JSON.stringify({
                provider: {
                    legacy: { options: { baseURL: "https://legacy.example.com/api" } },
                    shared: { options: { baseURL: "https://old.example.com/api" } },
                },
            }),
        );
        fs.writeFileSync(
            path.join(v2, "provider_config.json"),
            JSON.stringify({
                schemaVersion: 1,
                config: {
                    providerConfigRules: {
                        providerRules: [
                            { providerId: "custom:foo", config: { api: { baseUrl: "https://custom.foo.example.com/v1" } } },
                            { providerId: "shared", config: { api: { baseUrl: "https://new.example.com/api" } } },
                        ],
                    },
                },
            }),
        );
        withHome(tmp, () => {
            const cfg = readZcodeConfig(tmp);
            assert.equal(cfg.providers.legacy.baseURL, "https://legacy.example.com/api");
            assert.equal(cfg.providers["custom:foo"].baseURL, "https://custom.foo.example.com/v1");
            assert.equal(cfg.providers.shared.baseURL, "https://new.example.com/api");
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("readZcodeConfig: honors ZCODE_PERSONAL_PROVIDER_CONFIG_FILE override (#1151)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-zcode-"));
    try {
        const alt = path.join(tmp, "alt", "personal.json");
        fs.mkdirSync(path.dirname(alt), { recursive: true });
        fs.writeFileSync(
            alt,
            JSON.stringify({
                schemaVersion: 1,
                config: {
                    providerConfigRules: {
                        providerRules: [{ providerId: "custom:alt", config: { api: { baseUrl: "https://alt.example.com/v1" } } }],
                    },
                },
            }),
        );
        withHome(tmp, () => {
            const cfg = readZcodeConfig(tmp, { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: alt });
            assert.equal(cfg.providers["custom:alt"].baseURL, "https://alt.example.com/v1");
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("extractHttpsHosts: dedupes, lowercases, drops http, unwraps /bili/", () => {
    const config: ClientConfig = {
        claude: { anthropicBaseUrl: "https://Claude.Example.com/api" },
        codex: {
            openaiBaseUrl: "https://oai-codex.example.com/backend",
            providers: {
                a: { baseUrl: "https://codex.example.com/v1" },
                b: { baseUrl: "http://127.0.0.1:8787/bili/https://unwrapped.example.com/v1" },
                dup: { baseUrl: "https://codex.example.com/v2" },
                junk: { baseUrl: "not-a-url" },
            },
        },
        pi: {
            providers: {
                z: { baseUrl: "https://PI.Example.com" },
                local: { baseUrl: "http://localhost:1234" },
            },
        },
        zcode: {
            providers: {
                "builtin:x": { baseURL: "https://zcode.example.com/anthropic" },
                "builtin:y": { baseURL: "https://ZCODE.example.com/anthropic" },
            },
        },
    };
    const hosts = extractHttpsHosts(config);
    assert.deepEqual(hosts, [
        "claude.example.com",
        "codex.example.com",
        "unwrapped.example.com",
        "oai-codex.example.com",
        "pi.example.com",
        "zcode.example.com",
    ]);
});

test("extractHttpsHosts: empty config → []", () => {
    assert.deepEqual(extractHttpsHosts({}), []);
});

test("extractHttpsHosts: codebuddy base URL + models.json urls (https only, unwrapped)", () => {
    const config: ClientConfig = {
        codebuddy: {
            codebuddyBaseUrl: "https://CB.Example.com/v2",
            modelUrls: [
                "https://models.example.com/v1/chat/completions",
                "http://local.example.com/v1/chat/completions",
                "http://127.0.0.1:8787/bili/https://wrapped.example.com/v1",
            ],
        },
    };
    assert.deepEqual(extractHttpsHosts(config), [
        "cb.example.com",
        "models.example.com",
        "wrapped.example.com",
    ]);
});

test("extractHttpsHosts: qoder → default model hosts; modelServerHost replaces them (#653)", () => {
    assert.deepEqual(extractHttpsHosts({ qoder: {} }), QODER_DEFAULT_MODEL_HOSTS);
    assert.deepEqual(extractHttpsHosts({ qoder: { modelServerHost: "my-relay.example.com" } }), ["my-relay.example.com"]);
});

test("extractHttpsHosts: trae → default model hosts; modelApiHost replaces them (#655)", () => {
    assert.deepEqual(extractHttpsHosts({ trae: {} }), TRAE_DEFAULT_MODEL_HOSTS);
    assert.deepEqual(extractHttpsHosts({ trae: { modelApiHost: "my-relay.example.com" } }), ["my-relay.example.com"]);
});

test("extractHttpsHosts: aider → default hosts when undeclared; declared https URLs replace them (#1048)", () => {
    assert.deepEqual(extractHttpsHosts({ aider: {} }), AIDER_DEFAULT_MODEL_HOSTS);
    assert.deepEqual(
        extractHttpsHosts({ aider: { baseUrls: ["https://my-relay.example.com/v1", "http://127.0.0.1:8000/v1"] } }),
        ["my-relay.example.com"],
    );
});

test("extractHttpsHosts: opencode provider baseURL + omp provider baseUrl discovered, coexist with other lanes (#1411)", () => {
    const hosts = extractHttpsHosts({
        opencode: {
            providers: {
                myrelay: { baseURL: "https://custom.example.com/v1" },
                plain: { baseURL: "http://insecure.example.com" },
            },
        },
        omp: { providers: { relay2: { baseUrl: "https://OMP.RELAY.example.com/v1" } } },
        claude: { anthropicBaseUrl: "https://relay.example.com" },
    });
    assert.ok(hosts.includes("custom.example.com"), `opencode custom host present: ${hosts.join(",")}`);
    assert.ok(hosts.includes("omp.relay.example.com"), `omp custom host present (lowercased): ${hosts.join(",")}`);
    assert.ok(hosts.includes("relay.example.com"), `coexists with other lanes: ${hosts.join(",")}`);
    assert.ok(!hosts.includes("insecure.example.com"), `http dropped: ${hosts.join(",")}`);
});

test("extractHttpsHosts: partial opencode/omp configs are safe — seed present once #1405 lands (#1411)", () => {
    assert.deepEqual(extractHttpsHosts({ opencode: {} }), OPENCODE_DEFAULT_MODEL_HOSTS);
    assert.deepEqual(extractHttpsHosts({ omp: {} }), OPENCODE_DEFAULT_MODEL_HOSTS);

test("extractHttpsHosts: opencode/omp → zen gateway default host, coexists with other lanes (#1405)", () => {
    assert.deepEqual(extractHttpsHosts({ opencode: {} }), OPENCODE_DEFAULT_MODEL_HOSTS);
    assert.deepEqual(extractHttpsHosts({ omp: {} }), OPENCODE_DEFAULT_MODEL_HOSTS);
    assert.deepEqual(extractHttpsHosts({ opencode: {}, omp: {} }), OPENCODE_DEFAULT_MODEL_HOSTS);
    const mixed = extractHttpsHosts({
        opencode: { providers: { custom: { baseURL: "https://custom.example.com/v1" } } },
        claude: { anthropicBaseUrl: "https://relay.example.com" },
    });
    assert.ok(mixed.includes("opencode.ai"), `zen host present: ${mixed.join(",")}`);
    assert.ok(mixed.includes("relay.example.com"), `coexists with other lanes: ${mixed.join(",")}`);
});

async function withTempHome<T>(fn: (home: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-disc-"));
    const savedHome = process.env.HOME;
    process.env.HOME = tmp;
    try {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: tmp,
            CODEX_HOME: path.join(tmp, ".codex"),
            ZCODE_DATA_BASE_DIR: path.join(tmp, ".zcode"),
            PI_CODING_AGENT_DIR: path.join(tmp, ".pi", "agent"),
            CODEBUDDY_CONFIG_DIR: path.join(tmp, ".codebuddy"),
            XDG_CONFIG_HOME: path.join(tmp, ".config"),
        };
        delete env.OPENCODE_CONFIG;
        return await fn(tmp, env);
    } finally {
        process.env.HOME = savedHome;
        _resetDiscoveryCacheForTest();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function writeZcodeConfig(home: string, baseURLs: string[]): void {
    const v2 = path.join(home, ".zcode", "v2");
    fs.mkdirSync(v2, { recursive: true });
    const provider: Record<string, { options: { baseURL: string } }> = {};
    baseURLs.forEach((u, i) => { provider[`p${i}`] = { options: { baseURL: u } }; });
    fs.writeFileSync(path.join(v2, "config.json"), JSON.stringify({ provider }));
}

test("discoverMitmDomains: returns union of https hosts from client configs", async () => {
    await withTempHome((home, env) => {
        writeZcodeConfig(home, ["https://open.bigmodel.cn/api/anthropic"]);
        fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
        fs.writeFileSync(
            path.join(home, ".codex", "config.toml"),
            `[model_providers.openai]\nbase_url = "https://api.openai.com/v1"\n`,
        );
        _resetDiscoveryCacheForTest();
        const domains = discoverMitmDomains(env);
        assert.ok(domains.includes("open.bigmodel.cn"), `zcode host present: ${domains.join(",")}`);
        assert.ok(domains.includes("api.openai.com"), `codex host present: ${domains.join(",")}`);
        return Promise.resolve();
    });
});

test("discoverMitmDomains: seeds opencode zen gateway host even with no client configs (#1405)", async () => {
    await withTempHome((_home, env) => {
        _resetDiscoveryCacheForTest();
        const domains = discoverMitmDomains(env);
        assert.ok(domains.includes("opencode.ai"), `zen gateway host present: ${domains.join(",")}`);
        return Promise.resolve();
    });
});

test("discoverMitmDomains: codebuddy settings.json + models.json hosts discovered", async () => {
    await withTempHome((home, env) => {
        const cbDir = path.join(home, ".codebuddy");
        fs.mkdirSync(cbDir, { recursive: true });
        fs.writeFileSync(
            path.join(cbDir, "settings.json"),
            JSON.stringify({ env: { CODEBUDDY_BASE_URL: "https://codebuddy.example.com/v2" } }),
        );
        fs.writeFileSync(
            path.join(cbDir, "models.json"),
            JSON.stringify({ m1: { url: "https://models.example.com/v1/chat/completions", maxInputTokens: 100000 } }),
        );
        _resetDiscoveryCacheForTest();
        const domains = discoverMitmDomains(env);
        assert.ok(domains.includes("codebuddy.example.com"), `codebuddy host present: ${domains.join(",")}`);
        assert.ok(domains.includes("models.example.com"), `models.json host present: ${domains.join(",")}`);
        return Promise.resolve();
    });
});

test("discoverMitmDomains: two calls within TTL return the same array (cache hit, no re-stat)", async () => {
    await withTempHome((home, env) => {
        writeZcodeConfig(home, ["https://cached.example.com"]);
        _resetDiscoveryCacheForTest();
        const first = discoverMitmDomains(env);
        const second = discoverMitmDomains(env);
        assert.strictEqual(first, second);
        return Promise.resolve();
    });
});

test("discoverMitmDomains: mtime change + TTL expiry triggers re-scan", async () => {
    await withTempHome(async (home, env) => {
        const cfgPath = path.join(home, ".zcode", "v2", "config.json");
        writeZcodeConfig(home, ["https://v1.example.com"]);
        const baseMtime = Math.floor(fs.statSync(cfgPath).mtimeMs / 1000);
        _resetDiscoveryCacheForTest();
        const first = discoverMitmDomains(env);
        assert.ok(first.includes("v1.example.com"));

        writeZcodeConfig(home, ["https://v2.example.com"]);
        fs.utimesSync(cfgPath, baseMtime + 60, baseMtime + 60);
        const withinTtl = discoverMitmDomains(env);
        assert.strictEqual(withinTtl, first, "within TTL: still cached");

        await new Promise<void>((r) => setTimeout(r, 2100));

        const after = discoverMitmDomains(env);
        assert.ok(after.includes("v2.example.com"), `v2 present after rescan: ${after.join(",")}`);
        assert.ok(!after.includes("v1.example.com"), `v1 gone: ${after.join(",")}`);
        assert.notStrictEqual(after, first);
    });
});

test("discoverMitmDomains: discovers hosts from provider_config.json (new personal store, #1151)", async () => {
    await withTempHome(async (home, env) => {
        fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
        _resetDiscoveryCacheForTest();
        const before = discoverMitmDomains(env);
        assert.ok(!before.includes("newp.example.com"), `absent before GUI write: ${before.join(",")}`);

        const v2 = path.join(home, ".zcode", "v2");
        fs.mkdirSync(v2, { recursive: true });
        fs.writeFileSync(
            path.join(v2, "provider_config.json"),
            JSON.stringify({
                schemaVersion: 1,
                config: {
                    providerConfigRules: {
                        providerRules: [
                            { providerId: "custom:new", config: { api: { baseUrl: "https://newp.example.com/v1" } } },
                        ],
                    },
                },
            }),
        );

        await new Promise<void>((r) => setTimeout(r, 2100));

        const after = discoverMitmDomains(env);
        assert.ok(after.includes("newp.example.com"), `present after provider_config.json appears: ${after.join(",")}`);
    });
});

test("discoverMitmDomains: discovers opencode custom provider host from opencode.json, coexists with other lanes (#1411)", async () => {
    await withTempHome((home, env) => {
        const ocDir = path.join(home, ".config", "opencode");
        fs.mkdirSync(ocDir, { recursive: true });
        fs.writeFileSync(
            path.join(ocDir, "opencode.json"),
            JSON.stringify({
                provider: { myrelay: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://custom.example.com/v1" } } },
            }),
        );
        writeZcodeConfig(home, ["https://zlane.example.com/anthropic"]);
        _resetDiscoveryCacheForTest();
        const domains = discoverMitmDomains(env);
        assert.ok(domains.includes("custom.example.com"), `opencode custom provider host present: ${domains.join(",")}`);
        assert.ok(domains.includes("zlane.example.com"), `coexists with other lanes: ${domains.join(",")}`);
        return Promise.resolve();
    });
});

test("discoverMitmDomains: discovers omp provider baseUrl from models.yml (#1411)", async () => {
    await withTempHome((home, env) => {
        fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
        fs.writeFileSync(
            path.join(home, ".pi", "agent", "models.yml"),
            "providers:\n  myrelay:\n    baseUrl: https://omp.example.com/v1\n",
        );
        _resetDiscoveryCacheForTest();
        const domains = discoverMitmDomains(env);
        assert.ok(domains.includes("omp.example.com"), `omp provider host present: ${domains.join(",")}`);
        return Promise.resolve();
    });
});

test("discoverMitmDomains: OPENCODE_CONFIG file's provider host discovered (#1411)", async () => {
    await withTempHome((home, env) => {
        const custom = path.join(home, "my-opencode-config.jsonc");
        fs.writeFileSync(custom, '{ "provider": { "relay": { "options": { "baseURL": "https://explicit.example.com/v1" } } } }');
        env.OPENCODE_CONFIG = custom;
        _resetDiscoveryCacheForTest();
        const domains = discoverMitmDomains(env);
        assert.ok(domains.includes("explicit.example.com"), `OPENCODE_CONFIG host present: ${domains.join(",")}`);
        return Promise.resolve();
    });
});

test("discoverMitmDomains: opencode.json edit invalidates cache after TTL (#1411)", async () => {
    await withTempHome(async (home, env) => {
        const ocDir = path.join(home, ".config", "opencode");
        fs.mkdirSync(ocDir, { recursive: true });
        const cfgPath = path.join(ocDir, "opencode.json");
        const write = (url: string): void => {
            fs.writeFileSync(cfgPath, JSON.stringify({ provider: { r: { options: { baseURL: url } } } }));
        };
        write("https://v1.example.com");
        const baseMtime = Math.floor(fs.statSync(cfgPath).mtimeMs / 1000);
        _resetDiscoveryCacheForTest();
        const first = discoverMitmDomains(env);
        assert.ok(first.includes("v1.example.com"));

        write("https://v2.example.com");
        fs.utimesSync(cfgPath, baseMtime + 60, baseMtime + 60);
        const withinTtl = discoverMitmDomains(env);
        assert.strictEqual(withinTtl, first, "within TTL: still cached");

        await new Promise<void>((r) => setTimeout(r, 2100));

        const after = discoverMitmDomains(env);
        assert.ok(after.includes("v2.example.com"), `v2 present after rescan: ${after.join(",")}`);
        assert.ok(!after.includes("v1.example.com"), `v1 gone: ${after.join(",")}`);
    });
});