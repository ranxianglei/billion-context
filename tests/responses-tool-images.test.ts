import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { responsesToCore as kernelResponsesToCore, type ResponseInputItem } from "acp-kernel/wire";
import { responsesToCoreWithToolImages as responsesToCore, patchResponsesInputWithToolImages as patchResponsesInput, coreToResponsesWithToolImages as coreToResponses } from "../src/responses-tool-output.ts";
import { imageTokensInParsedBody } from "../src/image-tokens.ts";
import { imagePlaceholders } from "../src/image-note.ts";
import { createResponsesAdapter } from "../src/loop/adapter-responses.ts";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

process.env.NODE_ENV = "test";

function pngUrl(width: number, height: number, fill = 0): string {
    const bytes = Buffer.alloc(300_000, fill);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return `data:image/png;base64,${bytes.toString("base64")}`;
}

const imageUrl = pngUrl(2048, 1152);
const parts = [{ type: "input_text", text: "The screenshot shows a failure." }, { type: "input_image", image_url: imageUrl, detail: "high" }];

function toolBody(type: string, output: unknown = parts): { input: ResponseInputItem[] } {
    return { input: [{ type, call_id: "screenshot-call", output }] };
}

test("Responses tool output images are charged by pixels or bytes, not ignored", () => {
    for (const type of ["function_call_output", "custom_tool_call_output"]) {
        const body = toolBody(type);
        assert.equal(imageTokensInParsedBody("responses", body, "pixels"), 2125);
        assert.equal(imageTokensInParsedBody("responses", body, "bytes"), 100_000);
    }
});

test("Responses tool projection excludes image encodings while retaining images and identity", () => {
    for (const type of ["function_call_output", "custom_tool_call_output"]) {
        const body = toolBody(type);
        const projected = responsesToCore(body);
        assert.equal(projected.msgs[0].text, "The screenshot shows a failure.");
        assert.deepEqual(imagePlaceholders(projected.msgs[0]), ["[image: png 2048x1152]"]);
        assert.deepEqual(patchResponsesInput(projected, projected.msgs), body.input);
        assert.deepEqual(coreToResponses(projected.msgs, projected.customToolCallIds), body.input);
        const imageOnly = responsesToCore(toolBody(type, [parts[1]]));
        assert.equal(imageOnly.msgs.length, 1);
        assert.equal(imageOnly.msgs[0].text, "");
        assert.deepEqual(imagePlaceholders(imageOnly.msgs[0]), ["[image: png 2048x1152]"]);
    }
});

test("Responses tool image repair preserves existing ids and distinguishes different screenshots", () => {
    const body = toolBody("custom_tool_call_output");
    const id = kernelResponsesToCore(body).msgs[0].id;
    assert.equal(responsesToCore(body).msgs[0].id, id);
    assert.equal(responsesToCore(structuredClone(body)).msgs[0].id, id);
    const changed = toolBody("custom_tool_call_output", [parts[0], { ...parts[1], image_url: pngUrl(2048, 1152, 1) }]);
    assert.notEqual(responsesToCore(changed).msgs[0].id, id);
});

test("Responses rebuild patches tool text without losing images, metadata, or folding behavior", () => {
    for (const type of ["function_call_output", "custom_tool_call_output"]) {
        const output = [
            { type: "input_text", text: "first", annotations: ["retain"] },
            parts[1],
            { type: "input_text", text: "second" },
            { ...parts[1], image_url: "https://example.test/second.png", detail: "low" },
        ];
        const body = toolBody(type, output);
        body.input[0].id = "output-id";
        body.input[0].status = "completed";
        const projection = responsesToCore(body);
        const updated = [{ ...projection.msgs[0], text: "updated screenshot explanation" }];
        const expected = [{ ...body.input[0], output: [{ ...output[0], text: updated[0].text }, output[1], { ...output[2], text: "" }, output[3]] }];
        assert.deepEqual(patchResponsesInput(projection, updated), expected);
        assert.deepEqual(coreToResponses(updated, projection.customToolCallIds), expected);
        for (const layout of [projection, undefined]) {
            const request = createResponsesAdapter(false, layout).buildRequest(updated, "instructions", body);
            const rebuilt = (request.input as ResponseInputItem[]).filter((item) => item.type === type);
            assert.deepEqual(rebuilt, expected);
        }
        assert.deepEqual(patchResponsesInput(projection, []), [], "folded outputs must not be resurrected");
        const imageOnly = responsesToCore(toolBody(type, [parts[1]]));
        const tagged = [{ ...imageOnly.msgs[0], text: "screenshot note" }];
        const restored = patchResponsesInput(imageOnly, tagged) as ResponseInputItem[];
        assert.deepEqual(restored[0].output, [{ type: "input_text", text: "screenshot note" }, parts[1]]);
    }
});

test("ordinary JSON tool outputs retain their existing projection and are not charged as images", () => {
    for (const output of [
        { content: parts },
        [{ result: { type: "input_image", image_url: imageUrl } }],
        [{ type: "input_text", text: "ordinary text" }],
        JSON.stringify(parts),
    ]) {
        const body = toolBody("function_call_output", output);
        assert.deepEqual(responsesToCore(body), kernelResponsesToCore(body));
        assert.equal(imageTokensInParsedBody("responses", body, "pixels"), 0);
        assert.deepEqual(patchResponsesInput(responsesToCore(body), responsesToCore(body).msgs), body.input);
    }
});

type RequestBody = { stream?: boolean; input?: ResponseInputItem[] };

async function testProxy(window: number, run: (url: string, forwarded: RequestBody[], summaries: RequestBody[]) => Promise<void>): Promise<void> {
    const forwarded: RequestBody[] = [];
    const summaries: RequestBody[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
            if (body.stream === false) {
                summaries.push(body);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ output_text: "PREFLIGHT SUMMARY: examined two screenshots and diagnostic records. Retain the task goal, implementation constraints, observed failures, tested results, and next steps. Screenshots were supplied as PNG images, including an image-only tool result." }));
            } else {
                forwarded.push(body);
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "test-response", status: "completed", output: [], usage: { input_tokens: 5000, output_tokens: 1 } } })}\n\n`);
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "image-test": { context: window } } } },
        modelContextLimit: window, kernelConfig: defaultConfig(window),
        compress: { injectTool: true, injectNudge: true }, imageBilling: "pixels",
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        await run(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, forwarded, summaries);
    } finally {
        for (const server of [proxy, upstream]) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }
}

function screenshotItems(): ResponseInputItem[] {
    return [
        { type: "message", role: "user", content: "Investigate the screenshot failure." },
        { type: "function_call", call_id: "function-shot", name: "screenshot", arguments: "{}" },
        { type: "function_call_output", call_id: "function-shot", output: parts },
        { type: "custom_tool_call", call_id: "custom-shot", name: "screenshot", input: "capture" },
        { type: "custom_tool_call_output", call_id: "custom-shot", output: [parts[1]] },
    ];
}

test("host Responses path forwards tool screenshots without false preflight, in proxy and plugin modes", async () => {
    await testProxy(40_000, async (url, forwarded, summaries) => {
        for (const plugin of [false, true]) {
            const input = screenshotItems();
            const response = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", ...(plugin ? { "x-bili-plugin": "test-agent" } : {}) },
                body: JSON.stringify({ model: "image-test", stream: true, session_id: `tool-image-forward-${plugin}`, input }),
            });
            assert.equal(response.status, 200);
            await response.text();
            const request = forwarded.at(-1);
            assert.ok(request);
            const outputs = request.input?.filter((item) => item.type.endsWith("_call_output"));
            assert.deepEqual(outputs, [input[2], input[4]], "original structured screenshots reach the upstream unchanged");
        }
        assert.equal(forwarded.length, 2);
        assert.equal(summaries.length, 0, "image encodings do not trigger spurious overflow summaries");
    });
});

test("host preflight includes notes for mixed and image-only tool outputs without sending base64 to the summary model", async () => {
    await testProxy(10_000, async (url, forwarded, summaries) => {
        const input = screenshotItems();
        for (let i = 0; i < 13; i++) {
            input.push({ type: "message", role: i % 2 === 0 ? "assistant" : "user", content: `Diagnostic record ${i}. ${`MARKER_${i}_content_`.repeat(250)}` });
        }
        const response = await fetch(url, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "image-test", stream: true, session_id: "tool-image-summary", input }),
        });
        assert.equal(response.status, 200);
        await response.text();
        assert.ok(summaries.length > 0, "genuine text pressure triggers preflight");
        const summaryInput = summaries.map((body) => JSON.stringify(body)).join("\n");
        assert.equal(summaryInput.split("[image: png 2048x1152]").length - 1, 2);
        assert.ok(summaryInput.includes("The screenshot shows a failure."));
        assert.ok(!summaryInput.includes("data:image"));
        assert.ok(!summaryInput.includes(imageUrl.slice(22, 80)));
        assert.equal(forwarded.length, 1);
    });
});
