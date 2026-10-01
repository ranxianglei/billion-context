import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
    findRoute,
    loadRoutes,
    resolveConfiguredContextLimit,
    resolveNonHttpProviders,
} from "../src/config.js";
import { handleConfigPut, readProviders } from "../src/web/api.js";
import { setLogCapture } from "../src/logger.js";

function withConfigFile(t: test.TestContext, providers: unknown): string {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-named-bind-"));
    const p = path.join(dir, "billion-context.json");
    writeFileSync(p, JSON.stringify({ providers }, null, 2), "utf8");
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = p;
    t.after(() => {
        if (prev === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prev;
        rmSync(dir, { recursive: true, force: true });
    });
    return p;
}

function captureWarnings(t: test.TestContext): string[] {
    const lines: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") lines.push(msg); });
    t.after(() => setLogCapture(null));
    return lines;
}

async function putConfig(body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
    const req = new Readable({ read() {} });
    req.push(Buffer.from(JSON.stringify(body)));
    req.push(null);
    let status = 0;
    let payloadText = "";
    const res = {
        writeHead(s: number) { status = s; return this; },
        end(b?: string | Buffer) { payloadText = typeof b === "string" ? b : String(b ?? ""); },
    };
    await handleConfigPut(req as unknown as IncomingMessage, res as unknown as ServerResponse, undefined, 8787);
    return { status, payload: JSON.parse(payloadText) as Record<string, unknown> };
}

test("bind alias applies compress/models/proxy onto the bound URL lane", (t) => {
    const warnings = captureWarnings(t);
    withConfigFile(t, {
        "claude-bridge": {
            bind: "https://api.anthropic.com",
            compress: { maxContextLimitPct: 0.75 },
            models: { "claude-sonnet-4": { context: 200000, output: 8192 } },
            proxy: "http://127.0.0.1:9999",
        },
    });
    const routes = loadRoutes();
    assert.deepEqual(Object.keys(routes), ["https://api.anthropic.com"]);
    const lane = routes["https://api.anthropic.com"];
    assert.equal(lane.compress?.maxContextLimitPct, 0.75);
    assert.equal(lane.models?.["claude-sonnet-4"]?.context, 200000);
    assert.equal(lane.models?.["claude-sonnet-4"]?.output, 8192);
    assert.equal(lane.proxy, "http://127.0.0.1:9999");
    assert.equal(findRoute(routes, "https://api.anthropic.com/v1/messages")?.proxy, "http://127.0.0.1:9999");
    assert.equal(resolveConfiguredContextLimit(routes, "https://api.anthropic.com/v1/messages", "claude-sonnet-4"), 200000);
    assert.deepEqual(warnings, []);
});

test("explicit URL key beats alias fields, per field; gaps are filled", (t) => {
    const warnings = captureWarnings(t);
    withConfigFile(t, {
        "https://api.anthropic.com": {
            compress: { maxContextLimitPct: 0.5, emergencyThresholdPercent: 0.9 },
            models: { m1: { context: 1000, compress: { maxContextLimitPct: 0.6 } } },
            proxy: "http://127.0.0.1:1111",
            passthrough: false,
            compressProtocol: "tools",
            compat: { roles: { developer: "system" } },
            imageBilling: "bytes",
        },
        bridge: {
            bind: "https://api.anthropic.com/",
            compress: { maxContextLimitPct: 0.75, outputHeadroomMaxPct: 0.3 },
            models: {
                m1: { context: 2000, compress: { maxContextLimitPct: 0.8, nudgeGrowthTokens: 50000 } },
                m2: { context: 3000 },
            },
            proxy: "http://127.0.0.1:2222",
            passthrough: true,
            compressProtocol: "marker",
            compat: { roles: { assistant: "user" } },
            imageBilling: "pixels",
        },
    });
    const routes = loadRoutes();
    assert.deepEqual(Object.keys(routes), ["https://api.anthropic.com"]);
    const lane = routes["https://api.anthropic.com"];
    assert.equal(lane.compress?.maxContextLimitPct, 0.5);
    assert.equal(lane.compress?.emergencyThresholdPercent, 0.9);
    assert.equal(lane.compress?.outputHeadroomMaxPct, 0.3);
    assert.equal(lane.models?.m1?.context, 1000);
    assert.equal(lane.models?.m1?.compress?.maxContextLimitPct, 0.6);
    assert.equal(lane.models?.m1?.compress?.nudgeGrowthTokens, 50000);
    assert.equal(lane.models?.m2?.context, 3000);
    assert.equal(lane.proxy, "http://127.0.0.1:1111");
    assert.equal(lane.passthrough, false);
    assert.equal(lane.compressProtocol, "tools");
    assert.deepEqual(lane.compat?.roles, { developer: "system", assistant: "user" });
    assert.equal(lane.imageBilling, "bytes");
    assert.deepEqual(warnings, []);
});

test("arrays are taken wholesale from the URL lane, never element-merged", (t) => {
    captureWarnings(t);
    withConfigFile(t, {
        "https://a.example": { compress: { protectedTools: ["read"] } },
        aliasA: { bind: "https://a.example", compress: { protectedTools: ["write"] } },
    });
    const lane = loadRoutes()["https://a.example"];
    assert.deepEqual(lane.compress?.protectedTools, ["read"]);
});

test("name without bind stays routing-inert and warns naming the dead fields", (t) => {
    const warnings = captureWarnings(t);
    withConfigFile(t, {
        foo: {
            compress: { maxContextLimitPct: 0.8 },
            models: { x: { context: 100 } },
            proxy: "http://127.0.0.1:3333",
            passthrough: true,
        },
    });
    const routes = loadRoutes();
    assert.deepEqual(Object.keys(routes), ["foo"]);
    assert.equal(findRoute(routes, "https://foo.example/v1/chat/completions"), undefined);
    assert.equal(warnings.length, 1);
    for (const needle of ['"foo"', "compress", "models", "proxy", "passthrough", '"bind"']) {
        assert.ok(warnings[0].includes(needle), `warning should mention ${needle}: ${warnings[0]}`);
    }
});

test("invalid bind values warn and leave the entry inert", (t) => {
    const warnings = captureWarnings(t);
    withConfigFile(t, {
        bad1: { bind: "not-a-url", compress: { maxContextLimitPct: 0.7 } },
        bad2: { bind: "ftp://files.example", compress: { maxContextLimitPct: 0.7 } },
        bad3: { bind: 42, compress: { maxContextLimitPct: 0.7 } },
    });
    const routes = loadRoutes();
    assert.deepEqual(Object.keys(routes).sort(), ["bad1", "bad2", "bad3"]);
    assert.equal(Object.keys(routes).some((k) => k.includes("http")), false);
    // each entry warns twice: the invalid bind itself + its now-inert routing fields
    assert.equal(warnings.length, 6);
    assert.ok(warnings.some((w) => w.includes('"bad1"') && w.includes("not a valid http(s) base URL")));
    assert.ok(warnings.some((w) => w.includes('"bad2"') && w.includes("not a valid http(s) base URL")));
    assert.ok(warnings.some((w) => w.includes('"bad3"') && w.includes("must be a string")));
    for (const key of ["bad1", "bad2", "bad3"]) {
        assert.ok(warnings.some((w) => w.includes(`"${key}"`) && w.includes("carries routing fields without")), `inert warning for ${key}`);
    }
});

test("bind on a URL key warns and is ignored; the key keeps working as its own lane", (t) => {
    const warnings = captureWarnings(t);
    withConfigFile(t, {
        "https://x.example": { bind: "https://y.example", models: { a: { context: 500 } } },
    });
    const routes = loadRoutes();
    assert.deepEqual(Object.keys(routes), ["https://x.example"]);
    assert.equal(routes["https://x.example"].models?.a?.context, 500);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('"https://x.example"'));
    assert.ok(warnings[0].includes("ignored"));
});

test("external ACP_PROVIDERS outranks inline config at every level", (t) => {
    captureWarnings(t);
    const cfgPath = withConfigFile(t, {
        "https://e.example": { compress: { maxContextLimitPct: 0.3 } },
        inAlias: { bind: "https://e.example", compress: { maxContextLimitPct: 0.4, nudgeGrowthTokens: 777 } },
    });
    const dir = path.dirname(cfgPath);
    const extPath = path.join(dir, "external-providers.json");
    writeFileSync(extPath, JSON.stringify({
        "https://e.example": { compress: { maxContextLimitPct: 0.1 } },
        extAlias: { bind: "https://e.example", compress: { maxContextLimitPct: 0.2, outputHeadroomMaxPct: 0.2, nudgeGrowthTokens: 888 } },
    }), "utf8");
    const lane = loadRoutes({ ACP_PROVIDERS: extPath })["https://e.example"];
    assert.equal(lane.compress?.maxContextLimitPct, 0.1);
    assert.equal(lane.compress?.outputHeadroomMaxPct, 0.2);
    assert.equal(lane.compress?.nudgeGrowthTokens, 888);
});

test("compactionOptIn is still consumed alongside bind", (t) => {
    captureWarnings(t);
    withConfigFile(t, {
        "claude-bridge": { bind: "https://api.anthropic.com", compactionOptIn: true, compress: { maxContextLimitPct: 0.75 } },
        "optin-only": { compactionOptIn: true },
    });
    const ids = resolveNonHttpProviders({ BILI_NON_HTTP_PROVIDERS: "envopt" });
    for (const id of ["claude-bridge", "optin-only", "envopt"]) assert.ok(ids.includes(id));
    const routes = loadRoutes();
    assert.equal(routes["https://api.anthropic.com"]?.compress?.maxContextLimitPct, 0.75);
    assert.ok(!("claude-bridge" in routes));
    assert.ok("optin-only" in routes);
});

test("named-provider warnings fire once per signature across reloads", (t) => {
    const warnings = captureWarnings(t);
    withConfigFile(t, { stale: { compress: { maxContextLimitPct: 0.8 } } });
    loadRoutes();
    loadRoutes();
    loadRoutes();
    assert.equal(warnings.filter((w) => w.includes('"stale"')).length, 1);
});

test("web config API round-trips named entries verbatim (no silent drop)", async (t) => {
    captureWarnings(t);
    const cfgPath = withConfigFile(t, {
        "claude-bridge": { bind: "https://api.anthropic.com", compactionOptIn: true, compress: { maxContextLimitPct: 0.75 } },
        "https://openai.example": { models: { gpt: { context: 128000 } } },
    });
    const shown = readProviders();
    assert.deepEqual(shown["claude-bridge"], { bind: "https://api.anthropic.com", compactionOptIn: true, compress: { maxContextLimitPct: 0.75 } });
    const r = await putConfig({ providers: shown });
    assert.equal(r.status, 200);
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf8")) as { providers: Record<string, unknown> };
    assert.deepEqual(onDisk.providers["claude-bridge"], { bind: "https://api.anthropic.com", compactionOptIn: true, compress: { maxContextLimitPct: 0.75 } });
    assert.deepEqual(loadRoutes()["https://api.anthropic.com"]?.compress, { maxContextLimitPct: 0.75 });
});

test("web config API still rejects legacy, invalid-proxy, and non-object entries", async (t) => {
    captureWarnings(t);
    withConfigFile(t, {});
    assert.equal((await putConfig({ providers: { legacy: "https://old.example" } })).status, 400);
    assert.equal((await putConfig({ providers: { "https://p.example": { proxy: "socks5://127.0.0.1:1080" } } })).status, 400);
    assert.equal((await putConfig({ providers: [{ bind: "https://z.example" }] })).status, 400);
    const ok = await putConfig({ providers: { bridge: { bind: "https://ok.example", compactionOptIn: true } } });
    assert.equal(ok.status, 200);
});
