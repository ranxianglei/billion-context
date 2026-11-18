import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setStoreForTest, SessionStore } from "../src/persist.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { READ_ORIGINAL_IMAGE_TOOL_NAME } from "../src/compress-tool.ts";
import { closeServers } from "./server-close-guard.ts";

for (const plugin of [false, true]) {
    test(`the real ${plugin ? "plugin" : "proxy"} relay sheds ordinary images beside a restored original`, { timeout: 20_000 }, async () => {
        const oldBudget = process.env.BILI_HTTP_OUTBOUND_BYTES;
        process.env.BILI_HTTP_OUTBOUND_BYTES = "50000";
        _resetSessionsForTest();
        _setStoreForTest(new SessionStore({ enabled: false }));
        const received: string[] = [];
        const upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
                received.push(Buffer.concat(chunks).toString("utf8"));
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "msg-ok", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } }));
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
                log: false, debug: false, passthrough: false, autoUpdate: false,
                mitm: { enabled: false, domains: [] },
            } as ProxyOptions);
            await once(proxy, "listening");
            const port = (proxy.address() as import("node:net").AddressInfo).port;
            const restored = Buffer.alloc(3000, 3).toString("base64");
            const ordinary = Buffer.alloc(60000, 7).toString("base64");
            const image = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
            const messages = [
                { role: "user", content: "Inspect both pictures" },
                { role: "assistant", content: [
                    { type: "tool_use", id: "restore", name: READ_ORIGINAL_IMAGE_TOOL_NAME, input: { imageRef: "m00123" } },
                    { type: "tool_use", id: "screen", name: "screenshot", input: {} },
                ] },
                { role: "user", content: [
                    { type: "tool_result", tool_use_id: "restore", content: [image(restored)] },
                    { type: "tool_result", tool_use_id: "screen", content: [image(ordinary)] },
                ] },
                ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: `tail ${i}` })),
            ];
            const response = await fetch(`http://127.0.0.1:${port}/bili/${origin}/v1/messages`, {
                method: "POST", headers: { "content-type": "application/json", "x-acp-session": `tool-result-shed-${plugin}`,
                    ...(plugin ? { "x-bili-plugin": "pi" } : {}) },
                body: JSON.stringify({ model: "test", stream: false, max_tokens: 1024, messages }),
            });
            assert.equal(response.status, 200, await response.text());
            assert.equal(received.length, 1);
            assert.ok(Buffer.byteLength(received[0]) < 50000, "the actual transmitted request fits the byte budget");
            assert.match(received[0], /omitted for size limit/);
            assert.ok(received[0].includes(restored), "the restored original is still intact");
            assert.ok(!received[0].includes(ordinary), "the ordinary sibling is archived");
            assert.match(received[0], /tail 7/);
        } finally {
            if (oldBudget === undefined) delete process.env.BILI_HTTP_OUTBOUND_BYTES;
            else process.env.BILI_HTTP_OUTBOUND_BYTES = oldBudget;
            await closeServers(proxy ? [proxy, upstream] : [upstream], "tool-result image relay");
        }
    });
}
