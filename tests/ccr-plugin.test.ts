// #1271: CCR enablement on host lanes (plugin mode). Covers the two NEW decision
// surfaces plus the round-trip:
//   1. the manifest advertises acp_retrieve ONLY while CCR is enabled (#1192
//      conservative rule) and only on the wires whose prepare* can ride the full
//      original back (anthropic/openai) — never responses;
//   2. the plugin-mode arming gate scopes CCR to exactly those wires, so a
//      placeholder is never emitted on a wire that cannot round-trip it
//      (silent loss, #1097);
//   3. a plugin-lane e2e proving an oversized tool result is stored + placeholdered
//      on the wire, then acp_retrieve rides the full original back on the next
//      forward (request-only, never persisted).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { ccrEnabled, ccrPluginWireOk, contentStoreOf, PLUGIN_CCR_WIRES, retrieveToolName } from "../src/store.ts";
import { handlePluginManifest } from "../src/plugin.ts";
import { findCcrPluginDivergences, loadOptions } from "../src/config.ts";
import { setLogCapture } from "../src/logger.ts";

const MODEL = "test-model";
const BIG_TEXT = "line of build output ".repeat(400);

// — manifest advertising (acceptance: "advertises only while enabled", #1192) —

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

test("handlePluginManifest: acp_retrieve NOT advertised by default (CCR off)", () => {
    const m = readManifest(defaultConfig(200_000));
    assert.ok(!m.toolNames.includes("acp_retrieve"), "default config must not advertise acp_retrieve");
    for (const wire of ["anthropic", "openai", "responses"]) {
        assert.ok(!namesOnWire(m.tools[wire] ?? []).includes("acp_retrieve"), `${wire} must not carry acp_retrieve when CCR off`);
    }
});

test("handlePluginManifest: acp_retrieve advertised on anthropic+openai only when CCR enabled", () => {
    const m = readManifest({ ...defaultConfig(200_000), ccr: { enabled: true } });
    assert.ok(m.toolNames.includes("acp_retrieve"), "enabled CCR advertises acp_retrieve");
    assert.ok(namesOnWire(m.tools.anthropic).includes("acp_retrieve"), "anthropic wire carries acp_retrieve");
    assert.ok(namesOnWire(m.tools.openai).includes("acp_retrieve"), "openai wire carries acp_retrieve");
    // #1192: the proxy disarms CCR on the responses wire in plugin mode, so it must
    // NOT be advertised there (advertising would guarantee a rejected call).
    assert.ok(!namesOnWire(m.tools.responses).includes("acp_retrieve"), "responses wire must NOT carry acp_retrieve");
});

test("handlePluginManifest: custom ccr.toolName is honored", () => {
    const m = readManifest({ ...defaultConfig(200_000), ccr: { enabled: true, toolName: "fetch_full" } });
    assert.ok(m.toolNames.includes("fetch_full"), "custom retrieve tool name advertised");
    assert.ok(namesOnWire(m.tools.anthropic).includes("fetch_full"));
});

// — plugin-mode arming gate: wire scoping (silent-loss boundary, #1097/#1271) —

test("plugin-mode CCR is scoped to exactly the anthropic/openai wires", () => {
    assert.deepEqual([...PLUGIN_CCR_WIRES].sort(), ["anthropic", "openai"]);
    assert.equal(ccrPluginWireOk("anthropic"), true);
    assert.equal(ccrPluginWireOk("openai"), true);
    assert.equal(ccrPluginWireOk("responses"), false, "responses cannot round-trip the retrieval");
    assert.equal(ccrPluginWireOk("google"), false, "google strict alternation cannot ride the injection");
});

// — plugin-lane e2e: store → placeholder → acp_retrieve → full text rides back —

type Rig = { proxyPort: number; upstreamPort: number; forwards: string[]; proxy: http.Server; upstream: http.Server };

function okJson(): string {
    return JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    });
}

async function startRig(mode?: "route-scoped" | "name-divergent" | "enabled-divergent"): Promise<Rig> {
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
    // "route-scoped": CCR enabled ONLY under the route block — the base config
    // stays off, so the plugin manifest never advertises acp_retrieve (#1273
    // review regression rig). "name-divergent"/"enabled-divergent" (#1345):
    // base CCR on + a route-level override of a DIFFERENT field — the exact
    // config that used to split the advertised surface from the executed one.
    const routes = mode === "route-scoped"
        ? { [`http://127.0.0.1:${upstreamPort}`]: { compress: { ccr: { enabled: true, minToolTokens: 50 } } } }
        : mode === "name-divergent"
            ? { [`http://127.0.0.1:${upstreamPort}`]: { compress: { ccr: { toolName: "retrieve_original" } } } }
            : mode === "enabled-divergent"
                ? { [`http://127.0.0.1:${upstreamPort}`]: { compress: { ccr: { enabled: false } } } }
                : { [`http://127.0.0.1:${upstreamPort}`]: {} };
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes,
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: mode === "route-scoped"
            ? { injectTool: true, injectNudge: false }
            : { injectTool: true, injectNudge: false, ccr: { enabled: true, minToolTokens: 50 } },
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

// The SessionStore is file-global (closeRig only closes sockets), so every
// e2e test needs its own conversation id — reusing one inherits the earlier
// test's message refs/content store and the kernel treats re-sent messages as
// already-known instead of storing them fresh.
async function postOpenai(rig: Rig, messages: unknown[], convId = "ccr-e2e-conv"): Promise<void> {
    const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "test-agent", "x-acp-session": convId },
        // max_tokens must exceed SIDE_REQUEST_MAX_TOKENS or the side-request
        // guard forwards verbatim without touching kernel state (#554).
        body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages }),
    });
    const txt = await res.text();
    if (res.status !== 200) throw new Error(`proxy returned ${res.status}: ${txt}`);
}

const BASE_MSGS = (): unknown[] => [
    { role: "user", content: "run a big build" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"npm run build"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: BIG_TEXT },
];

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

test("e2e plugin lane: CCR arms, stores+placeholderes, and acp_retrieve rides full text back", async () => {
    const rig = await startRig();
    try {
        // Turn 1: agent sends history with an oversized tool result.
        await postOpenai(rig, BASE_MSGS());
        assert.equal(rig.forwards.length, 1, "one outbound forward after turn 1");
        const f1 = rig.forwards[0]!;
        assert.ok(f1.includes("[acp-stored"), "turn-1 wire carries the stored placeholder, got: " + f1.slice(0, 200));
        assert.ok(!f1.includes(BIG_TEXT), "full original must NOT leak onto the turn-1 wire");

        // Discover the armed session (only our plugin-mode session has CCR stamped).
        const armed = listSessions().filter((s) => ccrEnabled(s));
        assert.equal(armed.length, 1, "exactly one CCR-armed session exists");
        const sess = armed[0]!;
        assert.equal(retrieveToolName(sess), "acp_retrieve");
        const ref = Object.keys(contentStoreOf(sess).byRef)[0];
        assert.ok(ref, "oversized tool result was stored under a ref");

        // The agent calls acp_retrieve through the REAL plugin tool endpoint
        // (`POST /__bili/plugin/tool`, the same dispatch the MCP shim drives) —
        // covers the conversation gate (isProxyToolFor under the armed session)
        // and the ack round-trip, not just the inner executeRetrieve.
        const toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: "ccr-e2e-conv", tool: "acp_retrieve", args: { ref } }),
        });
        const toolJson = JSON.parse(await toolRes.text()) as { ok: boolean; result?: string; error?: string };
        assert.ok(toolRes.status === 200 && toolJson.ok === true, `plugin tool endpoint returned ${toolRes.status}: ${JSON.stringify(toolJson)}`);
        const ack = toolJson.result!;
        assert.match(ack, new RegExp(`retrieved ${ref}: [\\d,]+ tok`), "retrieve returns the ack receipt");

        // Turn 2: agent re-sends history plus the acp_retrieve call + ack. The
        // drained injection rides the full original back on this forward.
        const msgs2 = [
            ...BASE_MSGS(),
            { role: "assistant", content: null, tool_calls: [{ id: "call_r", type: "function", function: { name: "acp_retrieve", arguments: JSON.stringify({ ref }) } }] },
            { role: "tool", tool_call_id: "call_r", content: ack },
        ];
        await postOpenai(rig, msgs2);
        assert.equal(rig.forwards.length, 2, "second outbound forward after turn 2");
        const f2 = rig.forwards[1]!;
        assert.ok(f2.includes(BIG_TEXT.slice(0, 120)), "full original rides back onto the turn-2 wire");
    } finally {
        await closeRig(rig);
    }
});

// [review #1273] Route-scoped CCR (base config off) must NOT arm the plugin
// lane: the manifest reads only the base config (server.ts:969 builds it from
// opts.compress.ccr), so arming from the route merge would emit placeholders
// advertising an acp_retrieve the host never registered — silent loss. The
// proxy lane keeps working: it injects the tool itself, per-request.
test("e2e route-scoped CCR: plugin lane stays verbatim, proxy lane arms", async () => {
    const rig = await startRig("route-scoped");
    try {
        // Plugin lane (x-bili-plugin header): the oversized tool result must
        // ride the wire byte-exact — no store, no placeholder, no arming.
        await postOpenai(rig, BASE_MSGS());
        assert.equal(rig.forwards.length, 1, "one outbound forward after the plugin turn");
        const f1 = rig.forwards[0]!;
        assert.ok(f1.includes(BIG_TEXT), "plugin lane forwards the oversized result verbatim when CCR is route-scoped only");
        assert.ok(!f1.includes("[acp-stored"), "no stored placeholder on the plugin wire");
        assert.equal(listSessions().filter((s) => ccrEnabled(s)).length, 0, "no session arms CCR from a route-scoped-only config on the plugin lane");

        // Proxy lane (no plugin header, fresh conversation id): the
        // route-level merge arms CCR and the proxy injects acp_retrieve.
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "ccr-e2e-conv-proxy" },
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: BASE_MSGS() }),
        });
        const txt = await res.text();
        assert.equal(res.status, 200, `proxy lane returned ${res.status}: ${txt}`);
        assert.equal(rig.forwards.length, 2, "second outbound forward after the proxy turn");
        const f2 = rig.forwards[1]!;
        assert.ok(f2.includes("[acp-stored"), "proxy lane arms CCR from the route-scoped config");
        assert.ok(!f2.includes(BIG_TEXT), "full original must not leak on the proxy wire");
    } finally {
        await closeRig(rig);
    }
});

// [#1345] In plugin mode the static manifest is the ONLY declaration of the
// retrieve surface, so the whole ccr block follows the base config: a
// route/model-level override of ANY field (toolName, enabled, thresholds)
// must not split the advertised surface from the executed policy. Provider/
// model ccr.* overrides stay proxy-lane-only (the proxy declares+dispatches
// per request under the merged block).

test("e2e #1345 toolName divergence: plugin lane executes the BASE name, proxy lane keeps the override", async () => {
    const rig = await startRig("name-divergent");
    try {
        // The live manifest advertises only the base name — never the route override.
        const mfRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/manifest`);
        const mf = JSON.parse(await mfRes.text()) as { toolNames: string[] };
        assert.ok(mf.toolNames.includes("acp_retrieve"), "manifest advertises the base acp_retrieve");
        assert.ok(!mf.toolNames.includes("retrieve_original"), "manifest must not advertise the route-level rename");

        // Plugin lane: stored + placeholdered under the BASE name.
        await postOpenai(rig, BASE_MSGS(), "ccr-e2e-name-conv");
        assert.equal(rig.forwards.length, 1, "one outbound forward after the plugin turn");
        const f1 = rig.forwards[0]!;
        // Quotes are JSON-escaped in the forwarded body (\") — match accordingly.
        assert.ok(f1.includes("[acp-stored"), "plugin lane stores the oversized result");
        assert.ok(!f1.includes(BIG_TEXT), "full original must not leak on the plugin wire");
        assert.ok(f1.includes('acp_retrieve(\\"'), "placeholder hint uses the BASE retrieve name");
        assert.ok(!f1.includes("retrieve_original"), "placeholder hint must not use the route-level rename");
        const sess = listSessions().find((s) => s.id === "ccr-e2e-name-conv");
        assert.ok(sess && ccrEnabled(sess), "plugin session armed CCR from the base config");
        assert.equal(retrieveToolName(sess!), "acp_retrieve", "session gate keeps the base name");
        const ref = Object.keys(contentStoreOf(sess!).byRef)[0]!;
        assert.ok(ref, "oversized result stored under a ref");

        // The registered (base-name) tool works through the plugin endpoint...
        let toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: "ccr-e2e-name-conv", tool: "acp_retrieve", args: { ref } }),
        });
        let toolJson = JSON.parse(await toolRes.text()) as { ok: boolean; result?: string };
        assert.ok(toolRes.status === 200 && toolJson.ok === true, `base-name retrieve returned ${toolRes.status}: ${JSON.stringify(toolJson)}`);
        assert.match(toolJson.result!, new RegExp(`retrieved ${ref}: [\\d,]+ tok`), "base-name retrieve returns the ack receipt");

        // ...while the overridden name is unknown to this session.
        toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: "ccr-e2e-name-conv", tool: "retrieve_original", args: { ref } }),
        });
        assert.equal(toolRes.status, 400, "route-level rename must not be executable on the plugin lane");

        // Proxy lane (no plugin header, fresh conversation): the merged block
        // governs there — per-route renames keep working.
        const res = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "ccr-e2e-proxy-name" },
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: BASE_MSGS() }),
        });
        const txt = await res.text();
        assert.equal(res.status, 200, `proxy lane returned ${res.status}: ${txt}`);
        assert.equal(rig.forwards.length, 2, "second outbound forward after the proxy turn");
        const f2 = rig.forwards[1]!;
        assert.ok(f2.includes("[acp-stored"), "proxy lane arms CCR from the merged config");
        assert.ok(f2.includes('retrieve_original(\\"'), "proxy-lane placeholder hint uses the route-level rename");
        assert.ok(!f2.includes(BIG_TEXT), "full original must not leak on the proxy wire");
    } finally {
        await closeRig(rig);
    }
});

test("e2e #1345 enabled divergence: plugin lane stays ARMED (base governs), proxy lane disarms", async () => {
    const rig = await startRig("enabled-divergent");
    try {
        // Plugin lane: base ccr.enabled=true governs — the route-level
        // enabled=false must NOT disarm a session whose manifest advertises
        // acp_retrieve (old behavior forwarded verbatim here: silent loss).
        await postOpenai(rig, BASE_MSGS(), "ccr-e2e-enabled-conv");
        assert.equal(rig.forwards.length, 1, "one outbound forward after the plugin turn");
        const f1 = rig.forwards[0]!;
        assert.ok(f1.includes("[acp-stored"), "plugin lane stores despite the route-level enabled=false");
        assert.ok(!f1.includes(BIG_TEXT), "full original must not leak on the plugin wire");
        const sess = listSessions().find((s) => s.id === "ccr-e2e-enabled-conv");
        assert.ok(sess && ccrEnabled(sess), "plugin session stays armed from the base config");
        const ref = Object.keys(contentStoreOf(sess!).byRef)[0]!;
        assert.ok(ref, "oversized result stored under a ref");
        const toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: "ccr-e2e-enabled-conv", tool: "acp_retrieve", args: { ref } }),
        });
        const toolJson = JSON.parse(await toolRes.text()) as { ok: boolean; result?: string };
        assert.ok(toolRes.status === 200 && toolJson.ok === true, `retrieve returned ${toolRes.status}: ${JSON.stringify(toolJson)}`);
        assert.match(toolJson.result!, new RegExp(`retrieved ${ref}: [\\d,]+ tok`), "stored content stays reachable on the plugin lane");

        // Proxy lane: the three-level merge still applies — enabled=false wins.
        const res = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "ccr-e2e-proxy-enabled" },
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: BASE_MSGS() }),
        });
        const txt = await res.text();
        assert.equal(res.status, 200, `proxy lane returned ${res.status}: ${txt}`);
        assert.equal(rig.forwards.length, 2, "second outbound forward after the proxy turn");
        const f2 = rig.forwards[1]!;
        assert.ok(f2.includes(BIG_TEXT), "proxy lane honors the route-level enabled=false (verbatim)");
        assert.ok(!f2.includes("[acp-stored"), "no placeholder on the disarmed proxy lane");
    } finally {
        await closeRig(rig);
    }
});

const DIV_URL = "https://api.example.com/v1";

test("#1345 findCcrPluginDivergences: per-field report, silent when base disabled", () => {
    // Base disabled → no plugin session can arm → nothing diverges (#1273
    // route-scoped-only enablement is intended proxy-lane-only, no warning).
    assert.deepEqual(findCcrPluginDivergences({ [DIV_URL]: { compress: { ccr: { enabled: true, toolName: "x" } } } }), []);
    assert.deepEqual(findCcrPluginDivergences({ [DIV_URL]: { compress: { ccr: { enabled: true } } } }, { ccr: { enabled: false } }), []);

    // Base enabled → every divergent field reported per level (field order stable).
    const routes = {
        [DIV_URL]: {
            compress: { ccr: { toolName: "retrieve_original", minToolTokens: 999 } },
            models: { "m-big": { compress: { ccr: { enabled: false, excludeTools: ["bash"] } } } },
        },
    };
    assert.deepEqual(findCcrPluginDivergences(routes, { ccr: { enabled: true } }), [
        { level: `provider ${DIV_URL}`, field: "toolName", value: "retrieve_original", effective: "acp_retrieve" },
        { level: `provider ${DIV_URL}`, field: "minToolTokens", value: 999, effective: 4000 },
        { level: `provider ${DIV_URL} model m-big`, field: "enabled", value: false, effective: true },
        { level: `provider ${DIV_URL} model m-big`, field: "excludeTools", value: ["bash"], effective: [] },
    ]);

    // Equal values are not divergences; unset fields are not reported.
    assert.deepEqual(findCcrPluginDivergences({ [DIV_URL]: { compress: { ccr: { toolName: "acp_retrieve" } } } }, { ccr: { enabled: true } }), []);
    // A base-set value is the effective reference, not the kernel default.
    assert.deepEqual(
        findCcrPluginDivergences({ [DIV_URL]: { compress: { ccr: { toolName: "other" } } } }, { ccr: { enabled: true, toolName: "mine" } }),
        [{ level: `provider ${DIV_URL}`, field: "toolName", value: "other", effective: "mine" }],
    );
});

test("#1345 load-time diagnostic: one warn per divergent field at config load", () => {
    const dir = mkdtempSync(path.join(process.env.TMPDIR ?? ".", "bili-1345-"));
    const cfgPath = path.join(dir, "billion-context.json");
    writeFileSync(cfgPath, JSON.stringify({
        providers: {
            [DIV_URL]: {
                compress: { ccr: { toolName: "retrieve_original" } },
                models: { "m-big": { compress: { ccr: { enabled: false } } } },
            },
        },
        compress: { ccr: { enabled: true } },
    }));
    const prevCfg = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = cfgPath;
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    try {
        loadOptions();
        const hits = warns.filter((w) => w.includes("ccr override ignored in plugin sessions"));
        assert.equal(hits.length, 2, `expected exactly two divergence warnings, got: ${JSON.stringify(warns)}`);
        assert.match(hits[0]!, new RegExp(`provider ${DIV_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ccr\\.toolName="retrieve_original"`));
        assert.match(hits[0]!, /plugin sessions use "acp_retrieve"/);
        assert.match(hits[1]!, /model m-big ccr\.enabled=false/);
        assert.match(hits[1]!, /plugin sessions use true/);
    } finally {
        setLogCapture(null);
        if (prevCfg === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevCfg;
        rmSync(dir, { recursive: true, force: true });
    }
});
