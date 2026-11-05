import { test } from "node:test";
import assert from "node:assert/strict";
import {
    LAUNCH_CLIENTS,
    isLaunchClient,
    baseClientName,
    discoverRoutes,
    buildGeminiEnv,
    buildIflowEnv,
    buildQwenEnv,
    buildAntigravityEnv,
    launcherInjectMcp,
} from "../src/launcher.ts";
import {
    QWEN_DEFAULT_MODEL_HOSTS,
    readGeminiEnvConfig,
    readIflowEnvConfig,
    readAntigravityEnvConfig,
    loadClientConfig,
} from "../src/client-config.ts";

const ORIGIN = "http://127.0.0.1:8787";

const EMPTY_ROUTES = { httpsDomains: [] as string[], httpRewrites: [] as { key: string; realUpstream: string }[], httpsRewrites: [] as { key: string; realUpstream: string }[], httpEnvRoutes: [] as { key: string; realUpstream: string }[] };

test("launch client registry includes gemini/iflow/qwen (#1047)", () => {
    for (const c of ["gemini", "iflow", "qwen"] as const) {
        assert.equal(isLaunchClient(c), true);
        assert.equal(baseClientName(c), c);
        assert.ok(LAUNCH_CLIENTS.includes(c as (typeof LAUNCH_CLIENTS)[number]));
    }
});

test("launch client registry includes antigravity (#2115)", () => {
    assert.equal(isLaunchClient("antigravity"), true);
    assert.equal(baseClientName("antigravity"), "antigravity");
    assert.ok(LAUNCH_CLIENTS.includes("antigravity"));
});

test("discoverRoutes: gemini default → GOOGLE_GEMINI_BASE_URL /bili/ rewrite of generativelanguage", () => {
    assert.deepEqual(discoverRoutes("gemini", {}), {
        ...EMPTY_ROUTES,
        httpRewrites: [{ key: "GOOGLE_GEMINI_BASE_URL", realUpstream: "https://generativelanguage.googleapis.com" }],
    });
});

test("discoverRoutes: gemini relay-wrapped GOOGLE_GEMINI_BASE_URL unwraps back to the real upstream", () => {
    const wrapped = `${ORIGIN}/bili/https://generativelanguage.googleapis.com`;
    const routes = discoverRoutes("gemini", { gemini: { baseUrl: wrapped } });
    assert.deepEqual(routes.httpRewrites, [{ key: "GOOGLE_GEMINI_BASE_URL", realUpstream: "https://generativelanguage.googleapis.com" }]);
});

test("discoverRoutes: gemini custom plain upstream passes through unwrapped", () => {
    const routes = discoverRoutes("gemini", { gemini: { baseUrl: "http://llm.internal:9000/v1beta" } });
    assert.deepEqual(routes.httpRewrites, [{ key: "GOOGLE_GEMINI_BASE_URL", realUpstream: "http://llm.internal:9000/v1beta" }]);
    assert.deepEqual(routes.httpsDomains, []);
});

test("discoverRoutes: gemini unparseable GOOGLE_GEMINI_BASE_URL → empty routes (client keeps its own default)", () => {
    assert.deepEqual(discoverRoutes("gemini", { gemini: { baseUrl: "not a url" } }), EMPTY_ROUTES);
});

test("discoverRoutes: iflow default → IFLOW_BASE_URL /bili/ rewrite of apis.iflow.cn/v1", () => {
    assert.deepEqual(discoverRoutes("iflow", {}), {
        ...EMPTY_ROUTES,
        httpRewrites: [{ key: "IFLOW_BASE_URL", realUpstream: "https://apis.iflow.cn/v1" }],
    });
});

test("discoverRoutes: iflow relay-wrapped IFLOW_BASE_URL unwraps back to the real upstream", () => {
    const wrapped = `${ORIGIN}/bili/https://apis.iflow.cn/v1`;
    const routes = discoverRoutes("iflow", { iflow: { baseUrl: wrapped } });
    assert.deepEqual(routes.httpRewrites, [{ key: "IFLOW_BASE_URL", realUpstream: "https://apis.iflow.cn/v1" }]);
});

test("discoverRoutes: iflow custom plain upstream passes through unwrapped", () => {
    const routes = discoverRoutes("iflow", { iflow: { baseUrl: "http://llm.internal:9000/v1" } });
    assert.deepEqual(routes.httpRewrites, [{ key: "IFLOW_BASE_URL", realUpstream: "http://llm.internal:9000/v1" }]);
});

test("discoverRoutes: iflow unparseable IFLOW_BASE_URL → empty routes (client keeps its own default)", () => {
    assert.deepEqual(discoverRoutes("iflow", { iflow: { baseUrl: "not a url" } }), EMPTY_ROUTES);
});

test("discoverRoutes: gemini/iflow blank base URL behaves like unset (default upstream)", () => {
    assert.deepEqual(discoverRoutes("gemini", { gemini: { baseUrl: "   " } }).httpRewrites,
        [{ key: "GOOGLE_GEMINI_BASE_URL", realUpstream: "https://generativelanguage.googleapis.com" }]);
    assert.deepEqual(discoverRoutes("iflow", { iflow: { baseUrl: "" } }).httpRewrites,
        [{ key: "IFLOW_BASE_URL", realUpstream: "https://apis.iflow.cn/v1" }]);
});

test("discoverRoutes: qwen default → cert-MITM whitelist of stock Qwen/DashScope + third-party hosts", () => {
    const routes = discoverRoutes("qwen", {});
    assert.deepEqual(routes.httpsDomains, QWEN_DEFAULT_MODEL_HOSTS.map((h) => h.toLowerCase()));
    assert.deepEqual(routes.httpRewrites, []);
    assert.deepEqual(routes.httpsRewrites, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
});

test("discoverRoutes: antigravity default → CLOUD_CODE_URL /bili/ rewrite of daily-cloudcode-pa.googleapis.com (#2115)", () => {
    assert.deepEqual(discoverRoutes("antigravity", {}), {
        ...EMPTY_ROUTES,
        httpRewrites: [{ key: "CLOUD_CODE_URL", realUpstream: "https://daily-cloudcode-pa.googleapis.com" }],
    });
});

test("discoverRoutes: antigravity relay-wrapped CLOUD_CODE_URL unwraps back to the real upstream", () => {
    const wrapped = `${ORIGIN}/bili/https://cloudcode-pa.googleapis.com`;
    const routes = discoverRoutes("antigravity", { antigravity: { baseUrl: wrapped } });
    assert.deepEqual(routes.httpRewrites, [{ key: "CLOUD_CODE_URL", realUpstream: "https://cloudcode-pa.googleapis.com" }]);
});

test("discoverRoutes: antigravity custom plain upstream passes through unwrapped", () => {
    const routes = discoverRoutes("antigravity", { antigravity: { baseUrl: "http://llm.internal:9000/v1beta" } });
    assert.deepEqual(routes.httpRewrites, [{ key: "CLOUD_CODE_URL", realUpstream: "http://llm.internal:9000/v1beta" }]);
    assert.deepEqual(routes.httpsDomains, []);
});

test("discoverRoutes: antigravity unparseable CLOUD_CODE_URL → empty routes (client keeps its own default)", () => {
    assert.deepEqual(discoverRoutes("antigravity", { antigravity: { baseUrl: "not a url" } }), EMPTY_ROUTES);
});

test("discoverRoutes: antigravity blank base URL behaves like unset (default upstream)", () => {
    assert.deepEqual(discoverRoutes("antigravity", { antigravity: { baseUrl: "   " } }).httpRewrites,
        [{ key: "CLOUD_CODE_URL", realUpstream: "https://daily-cloudcode-pa.googleapis.com" }]);
});

test("buildGeminiEnv: wraps the rewrite target under /bili/, no proxy/CA env (GATEWAY mode goes direct)", () => {
    const base: NodeJS.ProcessEnv = { GEMINI_API_KEY: "k", PATH: "/bin" };
    const env = buildGeminiEnv(
        ORIGIN,
        "/ca/root-ca.pem",
        [{ key: "GOOGLE_GEMINI_BASE_URL", realUpstream: "https://generativelanguage.googleapis.com" }],
        [],
        base,
    );
    assert.equal(env.GOOGLE_GEMINI_BASE_URL, `${ORIGIN}/bili/https://generativelanguage.googleapis.com`);
    assert.equal(env.BILLION_CONTEXT_PROXY, ORIGIN);
    assert.equal(env.GEMINI_API_KEY, "k");
    assert.equal(env.PATH, "/bin");
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.NODE_EXTRA_CA_CERTS, undefined);
});

test("buildGeminiEnv: never double-wraps an already-bili upstream", () => {
    const env = buildGeminiEnv(
        ORIGIN,
        "/ca/root-ca.pem",
        [{ key: "GOOGLE_GEMINI_BASE_URL", realUpstream: `${ORIGIN}/bili/https://generativelanguage.googleapis.com` }],
        [],
        {},
    );
    assert.equal(env.GOOGLE_GEMINI_BASE_URL, `${ORIGIN}/bili/https://generativelanguage.googleapis.com`);
});

test("buildIflowEnv: sets BOTH documented env spellings to the /bili/ wrapped upstream", () => {
    const env = buildIflowEnv(
        ORIGIN,
        "/ca/root-ca.pem",
        [{ key: "IFLOW_BASE_URL", realUpstream: "https://apis.iflow.cn/v1" }],
        [],
        {},
    );
    assert.equal(env.IFLOW_BASE_URL, `${ORIGIN}/bili/https://apis.iflow.cn/v1`);
    assert.equal(env.IFLOW_baseUrl, env.IFLOW_BASE_URL);
    assert.equal(env.BILLION_CONTEXT_PROXY, ORIGIN);
    assert.equal(env.HTTPS_PROXY, undefined);
});

test("buildQwenEnv: HTTPS_PROXY + additive root CA + loopback NO_PROXY (undici EnvHttpProxyAgent route)", () => {
    const env = buildQwenEnv(ORIGIN, "/ca/root-ca.pem", { HOME: "/home/u" });
    assert.equal(env.HTTPS_PROXY, ORIGIN);
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/ca/root-ca.pem");
    assert.equal(env.BILLION_CONTEXT_PROXY, ORIGIN);
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.equal(env.no_proxy, "localhost,127.0.0.1,::1");
    assert.equal(env.HOME, "/home/u");
});

test("buildAntigravityEnv: wraps CLOUD_CODE_URL under /bili/, no proxy/CA env (the override IS the route) (#2115)", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/bin" };
    const env = buildAntigravityEnv(
        ORIGIN,
        "/ca/root-ca.pem",
        [{ key: "CLOUD_CODE_URL", realUpstream: "https://cloudcode-pa.googleapis.com" }],
        [],
        base,
    );
    assert.equal(env.CLOUD_CODE_URL, `${ORIGIN}/bili/https://cloudcode-pa.googleapis.com`);
    assert.equal(env.BILLION_CONTEXT_PROXY, ORIGIN);
    assert.equal(env.PATH, "/bin");
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.NODE_EXTRA_CA_CERTS, undefined);
});

test("buildAntigravityEnv: never double-wraps an already-bili upstream", () => {
    const env = buildAntigravityEnv(
        ORIGIN,
        "/ca/root-ca.pem",
        [{ key: "CLOUD_CODE_URL", realUpstream: `${ORIGIN}/bili/https://cloudcode-pa.googleapis.com` }],
        [],
        {},
    );
    assert.equal(env.CLOUD_CODE_URL, `${ORIGIN}/bili/https://cloudcode-pa.googleapis.com`);
});

test("launcherInjectMcp: gemini/iflow/qwen/antigravity stay wire-only (closed/unverified MCP surfaces, v1 pure wire)", () => {
    for (const base of ["gemini", "iflow", "qwen", "antigravity"]) {
        assert.equal(launcherInjectMcp({}, base), false);
    }
    assert.equal(launcherInjectMcp({}, "claude"), true);
    assert.equal(launcherInjectMcp({ BILI_LAUNCHER_PLUGIN: "0" }, "claude"), false);
});

test("readGeminiEnvConfig: captures user-exported GOOGLE_GEMINI_BASE_URL as relay source", () => {
    assert.equal(readGeminiEnvConfig({ GOOGLE_GEMINI_BASE_URL: "http://llm.internal:9000/v1beta" }).baseUrl, "http://llm.internal:9000/v1beta");
    assert.equal(readGeminiEnvConfig({}).baseUrl, undefined);
    assert.equal(readGeminiEnvConfig({ GOOGLE_GEMINI_BASE_URL: "   " }).baseUrl, undefined);
});

test("readIflowEnvConfig: IFLOW_BASE_URL wins over IFLOW_baseUrl", () => {
    assert.equal(readIflowEnvConfig({ IFLOW_BASE_URL: "https://a.example/v1", IFLOW_baseUrl: "https://b.example/v1" }).baseUrl, "https://a.example/v1");
    assert.equal(readIflowEnvConfig({ IFLOW_baseUrl: "https://b.example/v1" }).baseUrl, "https://b.example/v1");
    assert.equal(readIflowEnvConfig({}).baseUrl, undefined);
});

test("readAntigravityEnvConfig: captures user-exported CLOUD_CODE_URL as relay source (#2115)", () => {
    assert.equal(readAntigravityEnvConfig({ CLOUD_CODE_URL: "http://llm.internal:9000/v1beta" }).baseUrl, "http://llm.internal:9000/v1beta");
    assert.equal(readAntigravityEnvConfig({}).baseUrl, undefined);
    assert.equal(readAntigravityEnvConfig({ CLOUD_CODE_URL: "   " }).baseUrl, undefined);
});

test("loadClientConfig: exposes gemini/iflow/antigravity sections from env", () => {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        GOOGLE_GEMINI_BASE_URL: "http://x.example:9000/v1beta",
        IFLOW_BASE_URL: "https://y.example/v1",
        CLOUD_CODE_URL: "https://z.example",
    };
    const cfg = loadClientConfig(env, process.cwd());
    assert.equal(cfg.gemini?.baseUrl, "http://x.example:9000/v1beta");
    assert.equal(cfg.iflow?.baseUrl, "https://y.example/v1");
    assert.equal(cfg.antigravity?.baseUrl, "https://z.example");
});
