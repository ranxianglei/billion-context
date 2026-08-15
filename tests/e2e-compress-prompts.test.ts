import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// E2E for the configurable compression prompts (PR #157): spins up the REAL
// proxy (startServer) against a mock upstream and asserts the resolved prompt
// text actually reaches the wire — i.e. the system message the upstream
// receives contains the configured override text, not the kernel defaults.
// Covers: (a) provider+model sub-field merged override end-to-end, (b) the
// acknowledgePromptsRisk gate keeping overrides inert at the HTTP layer.

type Captured = { body: string };

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** A marker that only exists in the kernel's default compressPhilosophy. */
const DEFAULT_MARKER = "Compress by need, not by percentage";

async function runProxyWithPrompts(routeCompress: ProxyOptions["routes"][string]): Promise<{ system: string | undefined; messages: { role: string }[] }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured.push({ body: Buffer.concat(chunks).toString("utf8") });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "r1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: routeCompress,
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const resp = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "gpt-test",
                stream: false,
                messages: [{ role: "user", content: "hello" }],
            }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        assert.equal(captured.length, 1, `expected exactly 1 upstream request, got ${captured.length}`);
        const sent = JSON.parse(captured[0]!.body) as { messages: { role: string; content: string }[] };
        const system = sent.messages.find((m) => m.role === "system")?.content;
        return { system, messages: sent.messages };
    } finally {
        await close(proxy);
        await close(upstream);
    }
}

test("e2e compress prompts: provider+model sub-field merged override reaches the wire", async () => {
    const { system } = await runProxyWithPrompts({
        compress: { prompts: { compressPhilosophy: "CUSTOM-E2E-PHILOSOPHY" } },
        models: {
            "gpt-test": {
                context: 400_000,
                compress: { prompts: { howToCompressRules: "CUSTOM-E2E-RULES" }, acknowledgePromptsRisk: true },
            },
        },
    });
    assert.ok(system, "upstream request has no system message — compress prompt not injected");
    // Model-level override present...
    assert.ok(system.includes("CUSTOM-E2E-RULES"), "model-level howToCompressRules override missing from wire");
    // ...AND provider-level sub-field survived the merge (deepest-wins is per SUB-field, not per object).
    assert.ok(system.includes("CUSTOM-E2E-PHILOSOPHY"), "provider-level compressPhilosophy override missing from wire");
    // Defaults are replaced by the overrides, not concatenated.
    assert.ok(!system.includes(DEFAULT_MARKER), "default compressPhilosophy still present alongside override");
    // The rest of the injected prompt (protocol section, tool docs) is intact.
    assert.ok(system.includes("compress"), "protocol section missing from injected prompt");
});

test("e2e compress prompts: without acknowledgePromptsRisk the override is inert (defaults on the wire)", async () => {
    const { system } = await runProxyWithPrompts({
        compress: { prompts: { compressPhilosophy: "CUSTOM-E2E-PHILOSOPHY" } },
        models: { "gpt-test": { context: 400_000 } },
    });
    assert.ok(system, "upstream request has no system message — compress prompt not injected");
    assert.ok(!system.includes("CUSTOM-E2E-PHILOSOPHY"), "override leaked to wire without acknowledgePromptsRisk");
    assert.ok(system.includes(DEFAULT_MARKER), "kernel default compressPhilosophy missing — gate broke the default path");
});

test("e2e compress prompts: no prompts configured → byte-identical default prompt on the wire", async () => {
    const { system } = await runProxyWithPrompts({
        models: { "gpt-test": { context: 400_000 } },
    });
    assert.ok(system, "upstream request has no system message — compress prompt not injected");
    assert.ok(system.includes(DEFAULT_MARKER), "kernel default compressPhilosophy missing with no config");
    assert.ok(!system.includes("CUSTOM-E2E"), "unexpected custom text with no config");
});
