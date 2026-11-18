import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { closeServers } from "./server-close-guard.ts";

async function harness(plugin: boolean, passthrough: boolean, exercise: (send: (body: string, identity?: boolean) => Promise<{ status: number; body: string; received: string | undefined }>) => Promise<void>, endpoint: string): Promise<void> {
    const received: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            received.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(202, { "content-type": "application/json" });
            res.end('{"accepted":true}');
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const origin = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}`;
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer({
            port: 0, host: "127.0.0.1", upstream: origin, routes: {},
            modelContextLimit: 200_000, kernelConfig: defaultConfig(200_000),
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
            log: false, debug: false, passthrough, autoUpdate: false,
            mitm: { enabled: false, domains: [] },
        } as ProxyOptions);
        await once(proxy, "listening");
        const port = (proxy.address() as import("node:net").AddressInfo).port;
        await exercise(async (body, identity = true) => {
            const response = await fetch(`http://127.0.0.1:${port}/bili/${origin}${endpoint}`, {
                method: "POST", headers: { "content-type": "application/json",
                    ...(identity ? { "x-acp-session": "root-array-fixture" } : {}),
                    ...(plugin ? { "x-bili-plugin": "pi" } : {}) }, body,
            });
            return { status: response.status, body: await response.text(), received: received.at(-1) };
        });
    } finally {
        await closeServers(proxy ? [proxy, upstream] : [upstream], "root-array relay");
    }
}

for (const endpoint of ["/v1/responses", "/v1beta/models/test:generateContent"]) {
    for (const plugin of [false, true]) {
        test(`root JSON arrays are relayed intact with or without conversation identity (${endpoint}, ${plugin ? "plugin" : "proxy"})`, { timeout: 20_000 }, async () => {
            await harness(plugin, false, async send => {
                for (const identity of [true, false]) {
                    for (const body of [' [1, {"field":"untouched"}]\n', "[]"]) {
                        const result = await send(body, identity);
                        assert.equal(result.status, 202, result.body);
                        assert.equal(result.received, body);
                    }
                }
            }, endpoint);
        });
    }
    test(`explicit passthrough retains the same root-array bytes (${endpoint})`, { timeout: 20_000 }, async () => {
        await harness(false, true, async send => {
            const body = ' [1, {"field":"untouched"}]\n';
            const result = await send(body, false);
            assert.equal(result.status, 202, result.body);
            assert.equal(result.received, body);
        }, endpoint);
    });
    test(`valid object conversations with nested arrays still enter preparation (${endpoint})`, { timeout: 20_000 }, async () => {
        await harness(false, false, async send => {
            const body = endpoint.includes("responses")
                ? { model: "test", input: [{ role: "user", content: "hello" }], instructions: "control system" }
                : { contents: [{ role: "user", parts: [{ text: "hello" }] }] };
            const result = await send(JSON.stringify(body));
            assert.equal(result.status, 202, result.body);
            const forwarded: unknown = JSON.parse(result.received!);
            assert.ok(forwarded && typeof forwarded === "object" && !Array.isArray(forwarded));
            const record = forwarded as Record<string, unknown>;
            assert.ok(Array.isArray(endpoint.includes("responses") ? record.input : record.contents));
            assert.match(result.received!, /hello/);
            assert.match(result.received!, /ACP TAGS/);
        }, endpoint);
    });
}
