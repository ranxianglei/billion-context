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
        log: false,
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
    await h?.close();
    h = undefined;
});

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
