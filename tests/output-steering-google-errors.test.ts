import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { applyOutputSteering, applyOutputSteeringJson, type OutputSteeringConfig } from "../src/output-steering.ts";

const effortOnly: OutputSteeringConfig = { enabled: true, verbosityLevel: 0, effortRouting: true };

function bodyFor(responses: Array<Record<string, unknown>>, budget = 8000): Record<string, unknown> {
    return {
        contents: [
            { role: "user", parts: [{ text: "Read the requested files and explain any problems." }] },
            { role: "model", parts: responses.map((_, i) => ({ functionCall: { name: `read_file_${i}`, args: { path: `file${i}` } } })) },
            { role: "user", parts: responses.map((response, i) => ({ functionResponse: { name: `read_file_${i}`, response } })) },
        ],
        generationConfig: { thinkingConfig: { thinkingBudget: budget } },
    };
}

for (const [name, responses] of [
    ["structured error", [{ error: { code: "PERMISSION_DENIED", message: "Cannot read file0." } }]],
    ["string error", [{ error: "File not found." }]],
    ["partial output", [{ output: "First page.", error: "Remaining pages unavailable." }]],
    ["error before a successful parallel result", [{ error: "Permission denied." }, { output: "Read file1." }]],
    ["error after a successful parallel result", [{ output: "Read file0." }, { error: "Permission denied." }]],
    ["explicit null error carrier", [{ error: null }]],
    ["explicit false error carrier", [{ error: false }]],
] as Array<[string, Array<Record<string, unknown>>]>) {
    test(`Google effort preserves the requested budget for ${name}`, () => {
        const original = bodyFor(responses);
        const body = JSON.stringify(original);
        assert.deepEqual(applyOutputSteering(body, "google", effortOnly), { body, changed: false, labels: [] });
        assert.deepEqual(applyOutputSteeringJson(original, "google", effortOnly), []);
        assert.equal(JSON.stringify(original), body);
    });
}

for (const [name, responses] of [
    ["output envelope", [{ output: "Read file0." }]],
    ["ordinary output object", [{ content: "Read file0." }]],
    ["error key inside output data", [{ output: { error: "The name of a log field." } }]],
    ["empty output object", [{}]],
    ["successful parallel results", [{ output: "Read file0." }, { output: "Read file1." }]],
] as Array<[string, Array<Record<string, unknown>>]>) {
    test(`Google effort still lowers a clean ${name}`, () => {
        const body = bodyFor(responses);
        const expected = bodyFor(responses, 128);
        const result = applyOutputSteering(JSON.stringify(body), "google", effortOnly);
        assert.deepEqual(JSON.parse(result.body), expected);
        assert.deepEqual(result.labels, ["effort:low"]);
    });
}

for (const [name, cfg, budget] of [
    ["disabled steering", { ...effortOnly, enabled: false }, 8000],
    ["disabled effort routing", { ...effortOnly, effortRouting: false }, 8000],
    ["dynamic budget", effortOnly, -1],
    ["budget already at the floor", effortOnly, 128],
] as Array<[string, OutputSteeringConfig, number]>) {
    test(`Google error handling leaves ${name} unchanged`, () => {
        const body = JSON.stringify(bodyFor([{ error: "Cannot read file0." }], budget));
        assert.deepEqual(applyOutputSteering(body, "google", cfg), { body, changed: false, labels: [] });
    });
}

test("Google failed tool effort survives the real HTTP forwarding path", { timeout: 15000 }, async t => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Observed the tool response." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address === "object");
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts: ProxyOptions = {
        port: 0, host: "127.0.0.1", upstream: `http://127.0.0.1:${address.port}`,
        routes: {}, proxy: "", proxyMode: "direct", proxySource: "direct",
        modelContextLimit: 200000, kernelConfig: defaultConfig(200000),
        compress: { injectTool: false, injectNudge: false, outputSteering: effortOnly },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, chainContentDetection: false,
        autoUpdate: false, mitm: { enabled: false, domains: [] },
    };
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer(opts);
        if (!proxy.listening) await once(proxy, "listening");
        const proxyAddress = proxy.address();
        assert.ok(proxyAddress && typeof proxyAddress === "object");
        for (const [name, result, budget] of [
            ["clean", { output: "Read file0." }, 128],
            ["failed", { error: { code: "PERMISSION_DENIED", message: "Cannot read file0." } }, 8000],
        ] as Array<[string, Record<string, unknown>, number]>) {
            await t.test(name, async () => {
                const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1beta/models/gemini-2.5-flash:generateContent`, {
                    method: "POST", headers: { "content-type": "application/json", "x-acp-session": `google-effort-${name}` },
                    body: JSON.stringify(bodyFor([result])),
                });
                assert.equal(response.status, 200);
                await response.text();
                const forwarded = seen.at(-1)!;
                assert.equal((forwarded.generationConfig as { thinkingConfig: { thinkingBudget: number } }).thinkingConfig.thinkingBudget, budget);
                assert.ok(JSON.stringify(forwarded.contents).includes(JSON.stringify(result)));
            });
        }
        assert.equal(seen.length, 2);
    } finally {
        if (proxy) { proxy.closeAllConnections(); await new Promise<void>((resolve, reject) => proxy!.close(error => error ? reject(error) : resolve())); }
        upstream.closeAllConnections();
        await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    }
});
