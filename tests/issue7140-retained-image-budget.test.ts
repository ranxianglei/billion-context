import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { READ_ORIGINAL_IMAGE_TOOL_NAME } from "../src/compress-tool.ts";
import type { ProxyOptions } from "../src/config.ts";
import { shedWireImages, shedWireImagesToCount } from "../src/egress-shed.ts";
import { _setStoreForTest, SessionStore } from "../src/persist.ts";
import { startServer } from "../src/server.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import type { WireProtocol } from "../src/util.ts";
import { closeServers } from "./server-close-guard.ts";

const originals = [1, 2].map(n => Buffer.alloc(120, n).toString("base64"));
const ordinary = [3, 4, 5].map(n => Buffer.alloc(120, n).toString("base64"));
const dataUrl = (data: string) => `data:image/png;base64,${data}`;
const receipt = (data: string) => `Billion original image receipt v1 sha256=${createHash("sha256").update(Buffer.from(data, "base64")).digest("hex")}`;
const anthropicImage = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

function fixture(protocol: WireProtocol, viaReceipt = false, custom = false): Record<string, unknown> {
    if (protocol === "google") {
        return { contents: [{ role: "user", parts: [
            ...originals.flatMap(data => [{ text: receipt(data) }, { inlineData: { mimeType: "image/png", data } }]),
            ...ordinary.map(data => ({ inlineData: { mimeType: "image/png", data } })),
        ] }] };
    }
    if (protocol === "responses") {
        return { input: [
            ...originals.flatMap((data, i) => [
                { type: custom ? "custom_tool_call" : "function_call", call_id: `restore${i}`, name: viaReceipt ? "run_code" : READ_ORIGINAL_IMAGE_TOOL_NAME, arguments: "{}" },
                { type: custom ? "custom_tool_call_output" : "function_call_output", call_id: `restore${i}`, output: [
                    ...(viaReceipt ? [{ type: "input_text", text: receipt(data) }] : []),
                    { type: "input_image", image_url: dataUrl(data) },
                ] },
            ]),
            { type: "message", role: "user", content: ordinary.map(data => ({ type: "input_image", image_url: dataUrl(data) })) },
        ] };
    }
    if (protocol === "openai") {
        return { messages: [
            { role: "assistant", tool_calls: originals.map((_, i) => ({ id: `restore${i}`, type: "function", function: { name: READ_ORIGINAL_IMAGE_TOOL_NAME, arguments: "{}" } })) },
            ...originals.map((data, i) => ({ role: "tool", tool_call_id: `restore${i}`, content: [{ type: "image_url", image_url: { url: dataUrl(data) } }] })),
            { role: "user", content: ordinary.map(data => ({ type: "image_url", image_url: { url: dataUrl(data) } })) },
        ] };
    }
    return { messages: [
        { role: "user", content: "Retrieve the original images" },
        { role: "assistant", content: originals.map((_, i) => ({ type: "tool_use", id: `restore${i}`, name: viaReceipt ? "run_code" : READ_ORIGINAL_IMAGE_TOOL_NAME, input: { imageRef: `m0000${i + 1}` } })) },
        { role: "user", content: [
            ...originals.map((data, i) => ({ type: "tool_result", tool_use_id: `restore${i}`, content: [
                ...(viaReceipt ? [{ type: "text", text: receipt(data) }] : []),
                anthropicImage(data),
            ] })),
            ...ordinary.map(anthropicImage),
        ] },
    ] };
}

// A wire-shape oracle independent of the production collection/filter logic.
function countImages(value: unknown): number {
    if (Array.isArray(value)) return value.reduce((n, item) => n + countImages(item), 0);
    if (typeof value !== "object" || value === null) return 0;
    const part = value as Record<string, unknown>;
    if (part.type === "image" || part.type === "image_url" || part.type === "input_image") return 1;
    if (typeof part.inlineData === "object" && part.inlineData !== null && "mimeType" in part.inlineData
        && typeof part.inlineData.mimeType === "string" && part.inlineData.mimeType.startsWith("image/")) return 1;
    return Object.values(part).reduce<number>((n, item) => n + countImages(item), 0);
}

const cases: Array<{ protocol: WireProtocol; viaReceipt?: boolean; custom?: boolean }> = [
    { protocol: "anthropic" }, { protocol: "openai" }, { protocol: "responses" },
    { protocol: "responses", custom: true }, { protocol: "google" },
    { protocol: "anthropic", viaReceipt: true }, { protocol: "responses", viaReceipt: true },
];

for (const options of cases) {
    test(`#7140 ${options.protocol} ${options.viaReceipt ? "receipt" : options.custom ? "custom tool" : "original"} images consume count capacity`, async () => {
        const body = JSON.stringify(fixture(options.protocol, options.viaReceipt, options.custom));
        const result = await shedWireImagesToCount(body, options.protocol, 3, { resolveRef: async () => "m00042" });
        assert.equal(result.stats.archived, 2);
        assert.equal(countImages(JSON.parse(result.body)), 3);
        for (const data of originals) assert.ok(result.body.includes(data), "protected original bytes survive");
        assert.ok(!result.body.includes(ordinary[0]));
        assert.ok(!result.body.includes(ordinary[1]));
        assert.ok(result.body.includes(ordinary[2]), "oldest-first removal retains the newest ordinary image");
        assert.match(result.body, /m00042/);
        assert.equal((await shedWireImagesToCount(result.body, options.protocol, 3)).body, result.body, "a converged resend is byte-stable");
        assert.equal(JSON.stringify(fixture(options.protocol, options.viaReceipt, options.custom)), body);
    });
}

test("#7140 a fitting mixed request is byte-identical and performs no restoration lookup", async () => {
    for (const { protocol, viaReceipt, custom } of cases) {
        const body = JSON.stringify(fixture(protocol, viaReceipt, custom), null, 2);
        const result = await shedWireImagesToCount(body, protocol, 5, { resolveRef: async () => assert.fail("under-cap lookup") });
        assert.equal(result.body, body);
        assert.equal(result.stats.changed, false);
    }
});

test("#7140 an unattainable cap keeps all originals and archives every eligible image", async () => {
    const body = JSON.stringify(fixture("anthropic"));
    const result = await shedWireImagesToCount(body, "anthropic", 0);
    assert.equal(result.stats.archived, 3);
    assert.equal(countImages(JSON.parse(result.body)), 2);
    for (const data of originals) assert.ok(result.body.includes(data));
    assert.equal((await shedWireImagesToCount(result.body, "anthropic", 0)).body, result.body);
});

test("#7140 byte shedding still excludes restored originals from its worklist", async () => {
    const parsed = fixture("anthropic");
    const messages = parsed.messages as unknown[];
    messages.push(...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: `tail ${i}` })));
    const body = JSON.stringify(parsed);
    const result = await shedWireImages(body, "anthropic", 1);
    assert.equal(result.stats.archived, 3);
    assert.equal(result.stats.downscaled, 0);
    for (const data of originals) assert.ok(result.body.includes(data));
    assert.equal(countImages(JSON.parse(result.body)), 2);
});

test("#7140 Google audio is not charged against the image cap", async () => {
    const audio = { inlineData: { mimeType: "audio/wav", data: Buffer.alloc(120, 9).toString("base64") } };
    const body = JSON.stringify({ contents: [{ parts: [audio, { inlineData: { mimeType: "image/png", data: ordinary[0] } }] }] });
    const result = await shedWireImagesToCount(body, "google", 1);
    assert.equal(result.body, body);
    assert.equal(result.stats.changed, false);
});

for (const plugin of [false, true]) {
    test(`#7140 real ${plugin ? "plugin" : "proxy"} relay rescues and remembers a cap with restored originals`, { timeout: 20_000 }, async () => {
        _resetSessionsForTest();
        _setStoreForTest(new SessionStore({ enabled: false }));
        const received: string[] = [];
        const upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                received.push(body);
                const count = countImages(JSON.parse(body));
                res.writeHead(count > 4 ? 400 : 200, { "content-type": "application/json" });
                res.end(count > 4
                    ? JSON.stringify({ error: { message: `Too many images in request: ${count} > 4` } })
                    : JSON.stringify({ id: "msg-ok", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } }));
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
            const messages = fixture("anthropic").messages as unknown[];
            for (let turn = 0; turn < 2; turn++) {
                const response = await fetch(`http://127.0.0.1:${port}/bili/${origin}/v1/messages`, {
                    method: "POST", headers: { "content-type": "application/json", "x-acp-session": `retained-budget-${plugin}`,
                        ...(plugin ? { "x-bili-plugin": "pi" } : {}) },
                    body: JSON.stringify({ model: "test", stream: false, max_tokens: 1024, messages }),
                });
                assert.equal(response.status, 200, await response.text());
                assert.equal(received.length, turn + 2, "first turn retries once; the learned cap avoids the next rejection");
                messages.push({ role: "assistant", content: "ok" }, { role: "user", content: "continue" });
            }
            assert.deepEqual(received.map(body => countImages(JSON.parse(body))), [5, 3, 3]);
            for (const body of received) for (const data of originals) assert.ok(body.includes(data), "even the reduced sends preserve restored originals");
            assert.equal(countImages(messages), 5, "client-owned history retains every image");
        } finally {
            await closeServers(proxy ? [proxy, upstream] : [upstream], "retained image count relay");
        }
    });
}
