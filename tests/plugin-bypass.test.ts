// #920 legacy lane: requests marked x-bili-plugin-bypass are forwarded
// VERBATIM — no wire tool injection, no nudge, no session binding — because
// the absorbed opencode-acp owns compression for those sessions.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { resolvePluginBypass } from "../src/knobs.ts";
import { setLogCapture } from "../src/logger.ts";
import { _resetPluginBypassForceWarnForTest } from "../src/server/handle.ts";
import { closeServers } from "./server-close-guard.ts";

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: { body: string; headers: Record<string, string | string[] | undefined> }[];
    close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
    const captured: Harness["captured"] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push({ body: Buffer.concat(chunks).toString(), headers: { ...req.headers } });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_bypass", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, output_tokens: 1 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "test-model": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        // log: true + logFile: "off" (established pattern, e.g. tests/codex-responses-ws.test.ts):
        // engine logging live (engine log is a no-op when log: false) but no log file
        // opened; the warn-capture test observes the stream via setLogCapture.
        log: true,
        logFile: "off",
        debug: false,
        passthrough: false,
        autoUpdate: false,
autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    return {
        proxyPort,
        upstreamPort,
        captured,
        close: async () => {
            await closeServers([proxy, upstream], "plugin-bypass harness");
        },
    };
}

let h: Harness | undefined;

beforeEach(async () => {
    h = await startHarness();
});
afterEach(async () => {
    delete process.env["BILI_PLUGIN_BYPASS"];
    setLogCapture(null);
    await h?.close();
    h = undefined;
});

async function post(model: string, withHeader = false) {
    const before = h!.captured.length;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (withHeader) headers["x-bili-plugin-bypass"] = "1";
    const body = { model, stream: false, messages: [{ role: "user", content: "env switch probe" }] };
    const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
    assert.equal(resp.status, 200);
    assert.equal(h!.captured.length, before + 1, `exactly one upstream request per post (before=${before} after=${h!.captured.length})`);
    const entry = h!.captured[before];
    if (!entry) throw new Error(`captured[${before}] missing; length=${h!.captured.length}`);
    return JSON.parse(entry.body) as { tools?: unknown[] };
}

function toolNames(seen: { tools?: unknown[] }): string[] {
    return (seen.tools ?? []).map((t) => (t as { function?: { name?: string } }).function?.name ?? "?");
}

describe("plugin bypass header (#920)", () => {
    it("bypassed requests are forwarded verbatim — no tool injection, no nudge", { timeout: 60_000 }, async () => {
        const body = { model: "test-model", stream: false, messages: [{ role: "user", content: "hello legacy session" }] };
        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-bypass": "1" },
            body: JSON.stringify(body),
        });
        assert.equal(resp.status, 200);
        assert.equal(h!.captured.length, 1);
        const seen = JSON.parse(h!.captured[0]!.body) as { tools?: unknown[]; messages: unknown[] };
        assert.equal(seen.tools, undefined);
        assert.deepEqual(seen.messages, body.messages);
        assert.equal(h!.captured[0]!.headers["x-bili-plugin-bypass"], "1");
    });

    it("without the header the same request gets the plugin pipeline (tools injected)", { timeout: 60_000 }, async () => {
        const body = { model: "test-model", stream: false, messages: [{ role: "user", content: "hello new session" }] };
        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        assert.equal(resp.status, 200);
        const seen = JSON.parse(h!.captured[0]!.body) as { tools?: { function?: { name?: string } }[] };
        const names = (seen.tools ?? []).map((t) => t.function?.name);
        assert.ok(names.includes("compress"), `expected compress in ${JSON.stringify(names)}`);
    });
});

describe("BILI_PLUGIN_BYPASS force switch (#6220)", () => {
    beforeEach(() => {
        // the warn-once set is process-global (first request that sees a
        // forced state pays the loud line) — start each test clean
        _resetPluginBypassForceWarnForTest();
    });
    it("resolver: tri-state + invalid classification", () => {
        assert.equal(resolvePluginBypass({}), "auto");
        assert.equal(resolvePluginBypass({ BILI_PLUGIN_BYPASS: "" }), "auto");
        assert.equal(resolvePluginBypass({ BILI_PLUGIN_BYPASS: "auto" }), "auto");
        for (const v of ["1", "true", "on", " ON ", "On"]) assert.equal(resolvePluginBypass({ BILI_PLUGIN_BYPASS: v }), "on");
        for (const v of ["0", "false", "off", " OFF ", "Off"]) assert.equal(resolvePluginBypass({ BILI_PLUGIN_BYPASS: v }), "off");
        for (const v of ["banana", "2", "yes", "bypass"] ) assert.equal(resolvePluginBypass({ BILI_PLUGIN_BYPASS: v }), "invalid");
    });

    it("=1 forces bypass even WITHOUT the header (raw passthrough, no tools)", { timeout: 60_000 }, async () => {
        process.env["BILI_PLUGIN_BYPASS"] = "1";
        const seen = await post("test-model");
        assert.equal(seen.tools, undefined);
    });

    it("=0 ignores the header — plugin pipeline runs (tools injected)", { timeout: 60_000 }, async () => {
        process.env["BILI_PLUGIN_BYPASS"] = "0";
        const seen = await post("test-model", true);
        assert.ok(toolNames(seen).includes("compress"), `expected compress in ${JSON.stringify(toolNames(seen))}`);
    });

    it("=auto and unrecognized values keep per-request header behavior", { timeout: 120_000 }, async () => {
        process.env["BILI_PLUGIN_BYPASS"] = "auto";
        let seen = await post("test-model");
        assert.ok(toolNames(seen).includes("compress"), "no header + auto => no bypass, pipeline should run");
        seen = await post("test-model", true);
        assert.equal(seen.tools, undefined, "header + auto => bypass");

        // unrecognized value behaves like auto: header still decides
        process.env["BILI_PLUGIN_BYPASS"] = "banana";
        seen = await post("test-model", true);
        assert.equal(seen.tools, undefined, "header + invalid env => bypass (auto semantics)");
    });

    it("forced states warn loudly, once each; invalid warns about the typo", { timeout: 120_000 }, async () => {
        const lines: { level: string; msg: string }[] = [];
        setLogCapture((level, msg) => { lines.push({ level, msg }); });

        process.env["BILI_PLUGIN_BYPASS"] = "1";
        await post("test-model");
        await post("test-model"); // second request: must not repeat the warn
        const onWarns = lines.filter((l) => l.level === "warn" && l.msg.includes("BILI_PLUGIN_BYPASS=on"));
        assert.equal(onWarns.length, 1, `expected exactly one forced-on warn, got ${JSON.stringify(onWarns)}`);
        assert.ok(onWarns[0]!.msg.includes("UNCOMPRESSED"), "forced-on warn must name the no-compression risk");

        process.env["BILI_PLUGIN_BYPASS"] = "0";
        await post("test-model", true);
        const offWarns = lines.filter((l) => l.level === "warn" && l.msg.includes("BILI_PLUGIN_BYPASS=off"));
        assert.equal(offWarns.length, 1);
        assert.ok(offWarns[0]!.msg.includes("read-only archive"), "forced-off warn must name the legacy-history risk");

        process.env["BILI_PLUGIN_BYPASS"] = "banana";
        await post("test-model", true);
        const invalidWarns = lines.filter((l) => l.level === "warn" && l.msg.includes("unrecognized value"));
        assert.equal(invalidWarns.length, 1);
    });
});
