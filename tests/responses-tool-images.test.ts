import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createCore, defaultConfig } from "acp-kernel";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { responsesToCore as kernelResponsesToCore, type ResponseInputItem } from "acp-kernel/wire";
import { responsesToCoreWithToolImages as responsesToCore, patchResponsesInputWithToolImages as patchResponsesInput, coreToResponsesWithToolImages as coreToResponses } from "../src/responses-tool-output.ts";
import { imageTokensInParsedBody } from "../src/image-tokens.ts";
import { imagePlaceholders } from "../src/image-note.ts";
import { createResponsesAdapter } from "../src/loop/adapter-responses.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession, listSessions, _resetSessionsForTest } from "../src/session.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
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

function userImageBody(n: number): { input: ResponseInputItem[] } {
    return { input: [{ type: "message", role: "user", content: Array.from({ length: n }, (_, i) => [
        { type: "input_text", text: `caption ${i}`, annotations: [`keep-${i}`] },
        { type: "input_image", image_url: `https://example.test/image-${i}.png`, detail: i % 2 ? "low" : "high" },
    ]).flat() }] };
}

test("full encoding binds each multipart image to its source, including partial and duplicate retention", () => {
    const first = { type: "message", role: "user", content: [
        { type: "input_text", text: "first source", custom: "keep-text-metadata" },
        { type: "input_image", image_url: imageUrl, detail: "low" },
        { type: "input_image", image_url: imageUrl, detail: "high" },
    ] };
    const second = { type: "message", role: "user", content: [
        { type: "input_text", text: "second source" },
        { type: "input_image", image_url: pngUrl(128, 256), detail: "auto" },
    ] };
    const projection = responsesToCore({ input: [first, second] });
    assert.deepEqual(coreToResponses(projection.msgs), [first, second], "complete carriers round-trip once each");
    const partial = projection.msgs.filter((_, index) => index !== 1);
    const rebuilt = coreToResponses(partial);
    assert.deepEqual(rebuilt[0]!.content, [first.content[0], first.content[2]], "retained duplicate keeps its own detail rather than taking the first image");
    assert.deepEqual(rebuilt[1], second, "a neighboring source keeps its own image");
    const summary = { id: "summary-carrier", role: "system" as const, contentType: "text" as const, text: "A new summary between retained image parts." };
    const split = coreToResponses([projection.msgs[1]!, summary, projection.msgs[4]!]);
    assert.deepEqual(split[0]!.content, [first.content[1]]);
    assert.equal(split[1]!.role, "developer", "ordinary system item stays between the image sources");
    assert.deepEqual(split[2]!.content, [second.content[1]]);
});

function toolBody(type: string, output: unknown = parts): { input: ResponseInputItem[] } {
    return { input: [{ type, call_id: "screenshot-call", output }] };
}

test("#4767: full encoding preserves one multi-image carrier instead of repeating it per core", () => {
    for (const n of [26, 2, 1]) {
        const body = userImageBody(n);
        const projection = responsesToCore(body);
        assert.deepEqual(coreToResponses(projection.msgs, projection.customToolCallIds), body.input);
        for (const textProtocol of [false, true]) {
            const request = createResponsesAdapter(textProtocol).buildRequest(projection.msgs, "", body);
            assert.deepEqual((request.input as ResponseInputItem[]).filter((item) => item.role === "user"), body.input);
        }
    }
});

test("#4767: ordinary multipart runs stay intact on both sides of image tool outputs", () => {
    for (const type of ["function_call_output", "custom_tool_call_output"]) {
        const before = userImageBody(2).input;
        const tool = { type, call_id: "image-call", output: parts };
        const after = userImageBody(3).input;
        const body = { input: [...before, tool, ...after] };
        const projection = responsesToCore(body);
        const edited = projection.msgs.map((m) => m.role === "tool" ? { ...m, text: "changed" } : m);
        assert.deepEqual(coreToResponses(edited, projection.customToolCallIds), [
            ...before, { ...tool, output: [{ ...parts[0], text: "changed" }, parts[1]] }, ...after,
        ]);
    }
});

test("#4767: full encoding preserves repeated identical image instances", () => {
    const body = userImageBody(2);
    const first = body.input[0];
    assert.ok(Array.isArray(first.content));
    first.content[3] = { ...first.content[1] };
    const projection = responsesToCore(body);
    assert.deepEqual(coreToResponses(projection.msgs, projection.customToolCallIds), body.input);
});

test("#4767: batching adjacent source carriers must not lose the later carrier's images", () => {
    const later = userImageBody(3).input;
    const body = { input: [...userImageBody(2).input, ...later] };
    const projection = responsesToCore(body);
    const rebuilt = coreToResponses(projection.msgs, projection.customToolCallIds);
    assert.deepEqual(rebuilt, body.input, "each adjacent source keeps its own parts without duplication");
});

test("#4767: full encoding preserves empty history and surrounding plain history", () => {
    assert.deepEqual(coreToResponses([]), []);
    const body = { input: [
        { type: "message", role: "assistant", content: "plain before" },
        ...userImageBody(2).input,
        { type: "message", role: "assistant", content: "plain after" },
    ] };
    const projection = responsesToCore(body);
    assert.deepEqual(coreToResponses(projection.msgs, projection.customToolCallIds), body.input);
});

test("#4767: summary carriers stay separate from a neighboring multipart source", () => {
    const body = userImageBody(2);
    const projection = responsesToCore(body);
    const summary = { id: "acp_summary_b1", role: "system" as const, contentType: "text" as const, text: "folded history" };
    const summaryInput = [{ type: "message", role: "user", content: "folded history" }];
    assert.deepEqual(coreToResponses([summary, ...projection.msgs, summary], projection.customToolCallIds), [
        ...summaryInput, ...body.input, ...summaryInput,
    ]);
});


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

async function testProxy(window: number, run: (url: string, forwarded: RequestBody[], summaries: RequestBody[]) => Promise<void>, store = new SessionStore({ enabled: false })): Promise<void> {
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
    _setStoreForTest(store);
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "image-test": { context: window } } } },
        modelContextLimit: window, kernelConfig: defaultConfig(window),
        compress: { injectTool: true, injectNudge: true }, imageBilling: "pixels",
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, passthroughSource: null, autoUpdate: false,
        autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        compat: { roles: {} }, streamErrorShape: "protocol",
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

test("a persisted partial compression block keeps its summary, correct live image and archived original on raw resends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-partial-block-"));
    let store = new SessionStore({ enabled: true, dir });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const a = { type: "input_image", image_url: `data:image/png;base64,${png}`, detail: "low" };
    const b = { type: "input_image", image_url: `data:image/png;base64,${png}`, detail: "high" };
    const opaque = { type: "compaction", encrypted_content: "opaque-client-state" };
    const input: ResponseInputItem[] = [
        { type: "message", role: "user", content: "Preserve independent opening." },
        { type: "message", role: "assistant", content: "Ready." },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Archived A decisions and constraints. ".repeat(200) }, a,
            { type: "input_text", text: "Current B facts." }, b] },
        opaque, { type: "message", role: "assistant", content: "Continue." },
    ];
    const config = { ...defaultConfig(100_000), preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const summary = "A established the accepted decisions and constraints. Those findings remain authoritative while continuing from B.";
    try {
        await testProxy(100_000, async (url, forwarded) => {
            const send = async (history: ResponseInputItem[] = input): Promise<void> => {
                const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ model: "image-test", stream: true, session_id: "persisted-partial-block", input: history }) });
                assert.equal(response.status, 200, await response.text());
                await new Promise<void>(resolve => setImmediate(resolve));
            };
            await send();
            const session = listSessions().find(item => item.meta.label === "persisted-partial-block");
            assert.ok(session);
            const projection = responsesToCore({ input });
            const folded = createCore().applyCompression({ messages: projection.msgs, state: session.state, config,
                ranges: [{ startRef: session.state.messageRefs.byRaw[projection.msgs[2]!.id]!,
                    endRef: session.state.messageRefs.byRaw[projection.msgs[3]!.id]!, summary }] });
            assert.equal(folded.result.blocksCreated, 1, JSON.stringify(folded.result));
            session.state = folded.state;
            const blockId = session.state.blocks.at(-1)!.blockId;
            const check = (): void => {
                const wire = forwarded.at(-1)!.input!;
                const pictures = wire.flatMap(item => Array.isArray(item.content) ? item.content.filter(part => part.type === "input_image") : []);
                assert.deepEqual(pictures, [b], "A stays folded; B remains exactly once with its own detail");
                assert.equal(JSON.stringify(wire).split(summary).length - 1, 1, "one block has one visible summary");
                assert.deepEqual(wire.find(item => item.type === "compaction"), opaque, "untracked client state survives reconstruction");
                assert.ok(getSession(session.id).state.blocks.some(block => block.blockId === blockId && block.active));
            };
            await send(); check();
            // A temporary short view must not make the subsequent full echo
            // resurrect the originals hidden by this same compression block.
            await send([input[0]!, input[1]!, opaque, input.at(-1)!]);
            await send(); check();
            // Conversely, a new identical upload outside the covered span is
            // current user content, not an echo to suppress by pixel hash.
            await send([...input, { type: "message", role: "user", content: [a] }]);
            const withNewImage = forwarded.at(-1)!.input!.flatMap(item => Array.isArray(item.content)
                ? item.content.filter(part => part.type === "input_image") : []);
            assert.deepEqual(withNewImage, [b, a], "the genuinely new identical image remains once");
            await send(); check();
            await store.writeNow(getSession(session.id));
            await store.closeQuietlyAsync();
            _resetSessionsForTest();
            store = new SessionStore({ enabled: true, dir });
            _setStoreForTest(store);
            await send(); check();
            const restoredSession = getSession(session.id);
            const imageRef = restoredSession.state.messageRefs.byRaw[projection.msgs[3]!.id];
            assert.ok(imageRef && imageRef !== "BLOCKED");
            const restored = resolveDecompress({ imageRef }, { core: createCore(), config, messages: [], session: restoredSession, log: () => {} });
            assert.equal(restored.outcome, "success", restored.text);
            const path = restored.text.match(/\n  (.+\.png)/)?.[1];
            assert.ok(path, restored.text);
            assert.deepEqual(readFileSync(path), Buffer.from(png, "base64"));
            await send(); check();
        }, store);
    } finally {
        await store.closeQuietlyAsync();
        rmSync(dir, { recursive: true, force: true });
    }
});

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
        // #1995: summary notes now carry the ref ("... · mNNNNN") so the fold's
        // own text points at the decompress imageRef restore channel.
        assert.equal((summaryInput.match(/\[image: png 2048x1152 · m\d+\]/g) ?? []).length, 2);
        assert.ok(summaryInput.includes("The screenshot shows a failure."));
        assert.ok(!summaryInput.includes("data:image"));
        assert.ok(!summaryInput.includes(imageUrl.slice(22, 80)));
        assert.equal(forwarded.length, 1);
    });
});
