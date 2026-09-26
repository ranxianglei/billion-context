// #1359: absorb plugin-lane tool-name divergence (same class as #1345/#1360 CCR).
// The manifest must advertise the SAME name the per-session gate adjudicates.
// Plugin lane governs the whole absorb block by the BASE config (provider/model
// overrides are proxy-lane-only); proxy lane follows the per-request merged block.
// Regression pinned here: a base-level rename advertised the static name while the
// gate expected the renamed one, so the host-registered tool 400'd on the plugin lane.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig, type Config } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, getSession } from "../src/session.ts";
import { handlePluginManifest } from "../src/plugin.ts";
import { effectiveAbsorbConfig, storeEffectiveAbsorb, isProxyToolFor } from "../src/absorb.ts";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { findAbsorbPluginDivergences } from "../src/config.ts";

const MODEL = "test-model";

function readManifest(config: Parameters<typeof handlePluginManifest>[1]): { toolNames: string[]; tools: Record<string, unknown[]> } {
    let body = "";
    const res = { writeHead: () => {}, end: (b: string) => { body = b; } } as unknown as Parameters<typeof handlePluginManifest>[0];
    handlePluginManifest(res, config);
    return JSON.parse(body) as { toolNames: string[]; tools: Record<string, unknown[]> };
}

function namesOnWire(wire: unknown[]): string[] {
    return wire.map((t) => {
        const o = t as Record<string, unknown>;
        return typeof o.name === "string" ? o.name : String((o.function as { name?: unknown } | undefined)?.name ?? "");
    });
}

// — manifest advertising follows base absorb.toolName (the #1359 core) —

test("handlePluginManifest: absorb NOT advertised when disabled", () => {
    const m = readManifest(defaultConfig(200_000));
    assert.ok(!m.toolNames.includes("absorb"), "disabled by default → not advertised");
});

test("handlePluginManifest: enabled absorb with default name advertises 'absorb'", () => {
    const m = readManifest({ ...defaultConfig(200_000), absorb: { enabled: true } });
    assert.ok(m.toolNames.includes("absorb"), "default name advertised");
    for (const wire of ["anthropic", "openai", "responses"]) {
        assert.ok(namesOnWire(m.tools[wire] ?? []).includes("absorb"), `${wire} carries 'absorb'`);
    }
});

test("handlePluginManifest: base absorb.toolName rename is advertised, not the static name", () => {
    const m = readManifest({ ...defaultConfig(200_000), absorb: { enabled: true, toolName: "my_absorb" } });
    assert.ok(m.toolNames.includes("my_absorb"), "renamed tool advertised");
    assert.ok(!m.toolNames.includes("absorb"), "static name no longer advertised after rename");
    for (const wire of ["anthropic", "openai", "responses"]) {
        const names = namesOnWire(m.tools[wire] ?? []);
        assert.ok(names.includes("my_absorb"), `${wire} carries the renamed tool`);
        assert.ok(!names.includes("absorb"), `${wire} must not carry the static name`);
    }
});

// — per-session gate: the advertised (renamed) name is the only accepted one —

test("gate: plugin-lane stamp makes the renamed name the sole accepted absorb tool", () => {
    const base = defaultConfig(200_000);
    const renamed: Config = { ...base, absorb: { enabled: true, toolName: "my_absorb", minToolTokens: 1 } };
    const s = getSession(`t-absorb-plugin-${Math.random().toString(36).slice(2)}`);
    storeEffectiveAbsorb(s, renamed);
    assert.equal(isProxyToolFor("my_absorb", s, base), true, "renamed (advertised) name accepted");
    assert.equal(isProxyToolFor("absorb", s, base), false, "static name rejected after rename");
});

// — load-time per-field divergence diagnostic —

test("findAbsorbPluginDivergences: aligned / unset levels report nothing", () => {
    const u = "http://u";
    assert.deepEqual(findAbsorbPluginDivergences({ [u]: {} }, { enabled: true, minToolTokens: 100 }), []);
    assert.deepEqual(findAbsorbPluginDivergences({ [u]: { compress: { absorb: undefined } } }, { enabled: true }), []);
    assert.deepEqual(findAbsorbPluginDivergences({ [u]: { compress: { absorb: { enabled: true } } } }, { enabled: true }), []);
});

test("findAbsorbPluginDivergences: route-level rename diverges from base", () => {
    const u = "http://u";
    const divs = findAbsorbPluginDivergences(
        { [u]: { compress: { absorb: { enabled: true, toolName: "route_absorb" } } } },
        { enabled: true },
    );
    assert.equal(divs.length, 1, `expected exactly the toolName field, got ${JSON.stringify(divs)}`);
    assert.match(divs[0]!, /toolName=\s*"route_absorb"/);
});

test("findAbsorbPluginDivergences: model-level field diverges; only fields the level SETS are reported", () => {
    const u = "http://u";
    const divs = findAbsorbPluginDivergences(
        { [u]: { models: { m1: { compress: { absorb: { minToolTokens: 999 } } } } } },
        { minToolTokens: 100, contextThresholdPct: 0.5, excludeTools: ["bash"] },
    );
    assert.equal(divs.length, 1, `only the set field (minToolTokens) diverges, got ${JSON.stringify(divs)}`);
    assert.match(divs[0]!, /m1\.absorb\.minToolTokens=\s*999/);
    assert.ok(!divs.join("").includes("contextThresholdPct"), "unset-at-level field not reported");
    assert.ok(!divs.join("").includes("excludeTools"), "unset-at-level field not reported");
});

test("findAbsorbPluginDivergences: percent form normalizes to the fraction form", () => {
    const u = "http://u";
    assert.deepEqual(
        findAbsorbPluginDivergences({ [u]: { compress: { absorb: { contextThresholdPct: "80%" } } } }, { contextThresholdPct: 0.8 }),
        [],
        "'80%' == 0.8 → no divergence",
    );
    const divs = findAbsorbPluginDivergences({ [u]: { compress: { absorb: { contextThresholdPct: "90%" } } } }, { contextThresholdPct: 0.8 });
    assert.equal(divs.length, 1, "'90%' != 0.8 → divergence");
});

// — e2e lane governance (real server through the proxy) —

type Rig = { proxyPort: number; upstreamPort: number; forwards: string[]; proxy: http.Server; upstream: http.Server };

function okJson(): string {
    return JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    });
}

async function startRig(baseCompress: Record<string, unknown>, routeCompress?: Record<string, unknown>): Promise<Rig> {
    const forwards: string[] = [];
    const upstream = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
            forwards.push(b);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port as number;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const url = `http://127.0.0.1:${upstreamPort}`;
    const routes = routeCompress ? { [url]: { compress: routeCompress } } : { [url]: {} };
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes,
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: baseCompress,
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxyPort: proxy.address().port as number, upstreamPort, forwards, proxy, upstream };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

async function post(rig: Rig, convId: string, pluginMode: boolean, messages: unknown[]): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": convId };
    if (pluginMode) headers["x-bili-plugin"] = "test-agent";
    const res = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages }),
    });
    const txt = await res.text();
    if (res.status !== 200) throw new Error(`proxy returned ${res.status}: ${txt}`);
}

const SIMPLE_MSGS = (): unknown[] => [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
];

test("e2e: base rename → plugin lane advertises, stamps, and executes the renamed tool", async () => {
    const baseCompress = { injectTool: true, injectNudge: false, absorb: { enabled: true, toolName: "my_absorb", minToolTokens: 1 } };
    const rig = await startRig(baseCompress);
    try {
        // Manifest (built from the base config, as server.ts does) advertises the rename.
        const m = readManifest(applyCompressSettings(defaultConfig(200_000), 200_000, baseCompress as Parameters<typeof applyCompressSettings>[2]));
        assert.ok(m.toolNames.includes("my_absorb"), "manifest advertises the base-renamed tool");

        // A plugin-mode turn stamps the session with the base (renamed) name.
        await post(rig, "abs-e2e-a", true, SIMPLE_MSGS());
        const sess = listSessions().find((s) => effectiveAbsorbConfig(s, defaultConfig(200_000))?.enabled === true);
        assert.ok(sess, "a session armed absorb");
        assert.equal(effectiveAbsorbConfig(sess!, defaultConfig(200_000))?.toolName, "my_absorb", "plugin lane stamps the base (renamed) name");

        // THE core repro: the advertised tool runs through the REAL plugin endpoint
        // (pre-fix it 400'd because the gate expected the renamed name while the
        // manifest advertised the static one).
        const tr = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: "abs-e2e-a", tool: "my_absorb", args: { ref: "m00001", summary: "x" } }),
        });
        const tj = JSON.parse(await tr.text()) as { ok: boolean; error?: string };
        assert.equal(tr.status, 200, `advertised tool must not 400; got ${tr.status}: ${JSON.stringify(tj)}`);
        assert.equal(tj.ok, true, "gate accepts the advertised (renamed) absorb tool");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: route rename → plugin lane stays on base, proxy lane honors the override", async () => {
    const baseCompress = { injectTool: true, injectNudge: false, absorb: { enabled: true, minToolTokens: 1 } };
    const routeCompress = { absorb: { enabled: true, toolName: "route_absorb", minToolTokens: 1 } };
    const rig = await startRig(baseCompress, routeCompress);
    try {
        // Plugin lane: the route override must NOT leak into the base-governed stamp.
        const beforeP = new Set(listSessions().map((s) => s.id));
        await post(rig, "abs-e2e-b1", true, SIMPLE_MSGS());
        const pSess = listSessions().find((s) => !beforeP.has(s.id));
        assert.ok(pSess, "plugin turn created a session");
        assert.equal(effectiveAbsorbConfig(pSess!, defaultConfig(200_000))?.toolName, "absorb", "plugin lane follows the BASE name, ignoring the route override");

        // Proxy lane: the merged (route) name governs, and the injected schema carries it.
        const beforeX = new Set(listSessions().map((s) => s.id));
        await post(rig, "abs-e2e-b2", false, SIMPLE_MSGS());
        const xSess = listSessions().find((s) => !beforeX.has(s.id));
        assert.ok(xSess, "proxy turn created a session");
        assert.equal(effectiveAbsorbConfig(xSess!, defaultConfig(200_000))?.toolName, "route_absorb", "proxy lane honors the route override");
        const lastFwd = rig.forwards[rig.forwards.length - 1]!;
        assert.ok(lastFwd.includes('"route_absorb"'), "proxy wire injects the renamed absorb tool");
    } finally {
        await closeRig(rig);
    }
});
