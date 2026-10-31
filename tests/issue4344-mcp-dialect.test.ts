import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { MCP_DIALECT_NOTE, withMcpDialectNote } from "../src/compress-tool.ts";
import { resolveLaneDecisions, surfaceOffDetail } from "../src/server/lane-decisions.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";

// #4344 (zcode rarely compresses): three gaps compounded —
//   1. the lane-decisions reachability gate read ONLY the bare `compress`
//      name, so an MCP-bridged host declaring `mcp__bili__compress` (zcode /
//      claude-code lanes, fixed shim server name "bili" per src/mcp.ts #2578)
//      was invisible to reachability;
//   2. zcode had NO host-profile entry and inherited ANONYMOUS's not-host-
//      scoped default — in plugin mode the surface was structurally ON
//      regardless of the wire, so the nudge advertised a tool the model could
//      not call (reporter log: 5+ T1 nudges at 21-29% usage, 0 compressions in
//      46 requests). (#4998 later removed the per-agent default entirely:
//      reachability is now observed for EVERY plugin lane.)
//   3. the standing prompt teaches the bare names while the model's tool
//      table holds the MCP-prefixed ones.
// The fix: dialect-aware reachability + a zcode profile entry (observed per
// request) + an MCP name-mapping note on the standing prompt when the wire
// declares the prefixed compress and NOT the bare one. This file pins all
// three through the unit surface (resolveLaneDecisions / withMcpDialectNote)
// and the real chain (openai wire, x-bili-plugin: zcode).
//
// NOT the fix (recorded for posterity, ework's 方案1 in the issue thread):
// injecting a bare `compress` into a plugin-mode tool table. Plugin-mode
// relay passes responses VERBATIM (src/server/relay.ts — the agent's native
// loop owns the tool surface), so a model call to the injected bare name
// would surface in zcode as an unknown tool; proxy-mode server-side
// interception (src/loop/core.ts isProxyToolFor) does not run for plugin
// sessions. 方案2's prompt-side mapping is what ships here.

process.env.NODE_ENV = "test";

const root = mkdtempSync(join(tmpdir(), "bili-4344-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
for (const key of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;

function openaiTools(names: string[]): unknown[] {
    return names.map((name) => ({ type: "function", function: { name, description: "d", parameters: { type: "object", properties: {} } } }));
}

test("unit: zcode reachability is observed per request, in BOTH dialects (#4344)", () => {
    const decide = (tools: unknown[], pluginAgent = "zcode") =>
        resolveLaneDecisions({ protocol: "openai", pluginMode: true, pluginAgent, parsed: { model: "m", messages: [], tools }, shouldInject: true });

    // Bridge absent (zcode agent mode gating MCP tools / degraded shim serving
    // an EMPTY tool list): surface OFF, honest — advertising `compress` against
    // a tool table that holds no such tool is the #3177 "unknown tool" shape.
    const absent = decide([]);
    assert.equal(absent.compressSurfaceOn, false, "no-tools zcode drops the surface");
    assert.equal(absent.mcpDialect, false);
    assert.equal(surfaceOffDetail(absent, true), "surface=off(no-tools)");

    // Hostile single regular tool: still off (precision retained).
    const regular = decide(openaiTools(["get_weather"]));
    assert.equal(regular.compressSurfaceOn, false, "single non-bili tool stays off");
    assert.equal(surfaceOffDetail(regular, true), "surface=off(top-level=[get_weather])");

    // Healthy bridge (MCP dialect): reachable — dialect-aware, the #4344 fix.
    const bridged = decide(openaiTools(["mcp__bili__compress", "mcp__bili__acp_status", "get_weather"]));
    assert.equal(bridged.compressSurfaceOn, true, "mcp__bili__compress reads reachable");
    assert.equal(bridged.mcpDialect, true, "prefixed-only declaration flips the dialect note");

    // Bare declaration (a host that surfaces the bare names): reachable, and
    // the note stays off — the prompt already names a callable tool.
    const bare = decide(openaiTools(["compress", "get_weather"]));
    assert.equal(bare.compressSurfaceOn, true);
    assert.equal(bare.mcpDialect, false);

    // BOTH dialects declared: bare wins the note (both names callable, the
    // kernel prompt's bare wording is already actionable).
    const both = decide(openaiTools(["compress", "mcp__bili__compress"]));
    assert.equal(both.compressSurfaceOn, true);
    assert.equal(both.mcpDialect, false);
});

test("unit: dialect observation is lane-independent and proxy mode never flags it (#4344)", () => {
    const mcpTable = openaiTools(["mcp__bili__compress"]);

    // Any host-scoped lane declaring the prefixed compress reads reachable —
    // same as #3401's bare-name observation on dsh.
    const dsh = resolveLaneDecisions({ protocol: "openai", pluginMode: true, pluginAgent: "dsh", parsed: { model: "m", messages: [], tools: mcpTable }, shouldInject: true });
    assert.equal(dsh.compressSurfaceOn, true, "dsh mcp-dialect reads reachable");
    assert.equal(dsh.mcpDialect, true);

    // Lane-independence runs both ways under observation-only reachability
    // (#4998): a pi wire carrying ONLY the prefixed compress reads reachable
    // AND arms the note — the same verdict as dsh above. What the wire
    // declares is what gets advertised; no per-lane delivery assumption.
    const pi = resolveLaneDecisions({ protocol: "openai", pluginMode: true, pluginAgent: "pi", parsed: { model: "m", messages: [], tools: mcpTable }, shouldInject: true });
    assert.equal(pi.compressSurfaceOn, true, "pi mcp-dialect reads reachable");
    assert.equal(pi.mcpDialect, true, "note arms on pi too (observation-only, #4998)");

    // A toolless pi round (cold-start / drop shape) goes silent — and an empty
    // table cannot arm the note.
    const piEmpty = resolveLaneDecisions({ protocol: "openai", pluginMode: true, pluginAgent: "pi", parsed: { model: "m", messages: [], tools: [] }, shouldInject: true });
    assert.equal(piEmpty.compressSurfaceOn, false, "pi no-tools drops the surface (#4998)");
    assert.equal(piEmpty.mcpDialect, false);

    // Proxy mode: bili injects the BARE tools itself, so the dialect note is
    // never armed there regardless of what the client's table happens to carry.
    const proxy = resolveLaneDecisions({ protocol: "openai", pluginMode: false, pluginAgent: undefined, parsed: { model: "m", messages: [], tools: mcpTable }, shouldInject: true });
    assert.equal(proxy.compressSurfaceOn, true, "proxy mode is structurally on");
    assert.equal(proxy.mcpDialect, false, "proxy mode never arms the MCP note");
});

test("unit: withMcpDialectNote appends the mapping only when armed (#4344)", () => {
    const prompt = "HOW TO COMPRESS: call compress.";
    assert.equal(withMcpDialectNote(prompt, false), prompt, "off is identity");
    const noted = withMcpDialectNote(prompt, true);
    assert.notEqual(noted, prompt);
    assert.ok(noted.includes(MCP_DIALECT_NOTE), "carries the mapping note");
    assert.ok(noted.startsWith(prompt), "note is appended after the prompt, never rewrites it");
    assert.ok(MCP_DIALECT_NOTE.includes("mcp__bili__compress"), "note names the callable tool");
});

// ---------------------------------------------------------------------------
// Real-chain pins: through startServer on the openai wire.
// ---------------------------------------------------------------------------

interface ChainResult {
    forwarded: Record<string, unknown>[];
}

async function chainOnce(lane: "zcode" | "pi", toolNames: string[]): Promise<ChainResult> {
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    _setForTest({});
    const store = new SessionStore({ dir: join(root, "sessions"), enabled: false });
    _setStoreForTest(store);
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chat_fixture", choices: [{ message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: upstreamUrl,
        routes: { [upstreamUrl]: { models: { "model-test": { context: 64_000 } } } },
        modelContextLimit: 200_000, kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    const origin = `http://127.0.0.1:${paddr.port}`;
    try {
        const r = await fetch(`${origin}/bili/${upstreamUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": `s4344-${lane}-${toolNames.join("-") || "notools"}`, "x-bili-plugin": lane },
            body: JSON.stringify({
                model: "model-test",
                messages: [{ role: "user", content: "hello" }],
                ...(toolNames.length > 0 ? { tools: openaiTools(toolNames) } : {}),
                max_tokens: 1024, stream: false,
            }),
        });
        const bodyText = await r.text();
        assert.equal(r.status, 200, bodyText);
        return { forwarded };
    } finally {
        store.cancelAll();
        proxy.close(); proxy.closeIdleConnections?.(); proxy.closeAllConnections?.();
        upstream.close(); upstream.closeIdleConnections?.(); upstream.closeAllConnections?.();
        await Promise.all([once(proxy, "close").catch(() => {}), once(upstream, "close").catch(() => {})]);
    }
}

test("chain: zcode with a healthy bridge gets the MCP name-mapping on the standing prompt (#4344)", async () => {
    const { forwarded } = await chainOnce("zcode", ["mcp__bili__compress", "mcp__bili__acp_status", "read_file"]);
    assert.equal(forwarded.length, 1);
    const msgs = forwarded[0]!["messages"] as { role?: string; content?: unknown }[];
    const first = msgs[0];
    assert.equal(first?.role, "system", "standing prompt is the head system anchor");
    const sys = String(first?.content ?? "");
    assert.ok(sys.includes("HOW TO COMPRESS"), "standing compress prompt present");
    assert.ok(sys.includes(MCP_DIALECT_NOTE), "prompt carries the MCP name mapping");
    // The wire's own tool table passes through untouched in plugin mode — no
    // bare `compress` injection next to the bridged names (injecting one
    // would strand an unknown tool in zcode: relay is verbatim, #4344).
    const tools = forwarded[0]!["tools"] as { function?: { name?: string } }[];
    const names = tools.map((t) => t.function?.name);
    assert.ok(names.includes("mcp__bili__compress"), "bridged tool forwarded untouched");
    assert.ok(!names.includes("compress"), "no bare compress injected in plugin mode");
});

test("chain: zcode without a bridge goes silent — no prompt, no note, no injection (#4344)", async () => {
    const { forwarded } = await chainOnce("zcode", []);
    assert.equal(forwarded.length, 1);
    const msgs = forwarded[0]!["messages"] as { role?: string; content?: unknown }[];
    const first = msgs[0];
    const sys = first?.role === "system" ? String(first?.content ?? "") : "";
    assert.ok(!sys.includes(MCP_DIALECT_NOTE), "no dialect note without the bridge");
    assert.ok(!sys.includes("acp_status"), "no standing compress prompt advertising unreachable tools");
    assert.equal(forwarded[0]!["tools"], undefined, "nothing injected into the tool table");
});

test("chain: pi keeps the bare-name prompt with no MCP note (negative control)", async () => {
    // #4998: reachability is observed per request — the negative control must
    // declare the bare names to earn the full standing prompt (a toolless pi
    // round is a cold-start/drop shape and goes silent now). The host tool
    // rides along so the body stays a main turn (#1897 vetoes bili-only tables).
    const { forwarded } = await chainOnce("pi", ["compress", "read_file"]);
    assert.equal(forwarded.length, 1);
    const msgs = forwarded[0]!["messages"] as { role?: string; content?: unknown }[];
    const first = msgs[0];
    assert.equal(first?.role, "system", "standing prompt present (bare names declared on the wire)");
    const sys = String(first?.content ?? "");
    assert.ok(sys.includes("acp_status"), "full standing prompt");
    assert.ok(!sys.includes(MCP_DIALECT_NOTE), "no MCP note on a bare-name lane");
});
