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
    readZcodeConfig,
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
        const cfg = readZcodeConfig(tmp);
        assert.equal(cfg.providers.p.baseURL, "https://z.example.com/api");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("readZcodeConfig: missing dir or unparseable file → empty providers", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-zcode-"));
    try {
        assert.deepEqual(readZcodeConfig(tmp), { providers: {} });
        fs.mkdirSync(path.join(tmp, "v2"), { recursive: true });
        fs.writeFileSync(path.join(tmp, "v2", "config.json"), "not-json{");
        assert.deepEqual(readZcodeConfig(tmp), { providers: {} });
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
        };
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
        writeZcodeConfig(home, ["https://v1.example.com"]);
        _resetDiscoveryCacheForTest();
        const first = discoverMitmDomains(env);
        assert.ok(first.includes("v1.example.com"));

        writeZcodeConfig(home, ["https://v2.example.com"]);

        const withinTtl = discoverMitmDomains(env);
        assert.strictEqual(withinTtl, first, "within TTL: still cached");

        await new Promise<void>((r) => setTimeout(r, 2100));

        const after = discoverMitmDomains(env);
        assert.ok(after.includes("v2.example.com"), `v2 present after rescan: ${after.join(",")}`);
        assert.ok(!after.includes("v1.example.com"), `v1 gone: ${after.join(",")}`);
        assert.notStrictEqual(after, first);
    });
});
