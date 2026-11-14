import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { createGoogleAdapter } from "../src/loop/index.ts";
import type { ParsedStreamEvent } from "../src/loop/index.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

type Part = Record<string, unknown>;
const tag = '\x3cacp tokens="2" type="text"\x3em00001\x3c/acp\x3e';
const thought = `  思考🔥\n${tag}\n[ACP] quoted marker  `;
const signature = "c3ludGhldGljLXNpZ25hdHVyZQ==";
const image: Part = { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJKsAAAAASUVORK5CYII=" } };
const code: Part = { executableCode: { language: "PYTHON", code: "print(1 + 1)" } };
const result: Part = { codeExecutionResult: { outcome: "OUTCOME_OK", output: "2\n" } };

function candidate(parts: Part[], finishReason?: string): Record<string, unknown> {
    return { candidates: [{ index: 0, content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }] };
}

function sse(value: Record<string, unknown>): string {
    return `data: ${JSON.stringify(value)}\n\n`;
}

function framesOf(wire: string): Array<Record<string, unknown>> {
    return wire.split("\n\n").filter(frame => frame.startsWith("data:")).map(frame => JSON.parse(frame.slice(5)) as Record<string, unknown>);
}

function partsOf(frames: Array<Record<string, unknown>>): Part[] {
    return frames.flatMap(frame => (frame.candidates as Array<{ content?: { parts?: Part[] } }> | undefined)?.[0]?.content?.parts ?? []);
}

function forwarded(events: ParsedStreamEvent[]): string {
    return events.map(event => "raw" in event && event.raw ? event.raw.toString() : event.kind === "meta" ? event.chunk.toString() : "").join("");
}

async function collect(values: Array<Record<string, unknown>>, mode: "sse" | "array" = "sse"): Promise<ParsedStreamEvent[]> {
    const wire = mode === "sse" ? values.map(sse).join("") : JSON.stringify(values);
    const adapter = createGoogleAdapter({}, undefined, undefined, "gemini-test");
    const events: ParsedStreamEvent[] = [];
    for await (const event of adapter.parseStream(new Response(wire).body!, 1)) events.push(event);
    return events;
}

for (const mode of ["sse", "array"] as const) {
    test(`Google ${mode}: one frame forwards ordered text/thought parts exactly once`, async () => {
        const parts = [{ text: "First 你好. " }, { thought: true, text: thought, thoughtSignature: signature }, { text: "Second 🔥." }];
        const events = await collect([candidate(parts), candidate([], "STOP")], mode);
        assert.deepEqual(partsOf(framesOf(forwarded(events))), parts);
        assert.deepEqual(events.filter(event => event.kind === "text" || event.kind === "reasoning").map(event => event.delta), parts.map(part => part.text));
    });

    test(`Google ${mode}: edits to all prose siblings are applied before one frame is forwarded`, async () => {
        const events = await collect([candidate([{ text: `${tag} First. ` }, { text: `${tag} Second.` }]), candidate([], "STOP")], mode);
        const wire = forwarded(events);
        const text = partsOf(framesOf(wire)).map(part => part.text ?? "").join("");
        const structured = events.filter(event => event.kind === "text").map(event => event.delta).join("");
        assert.equal(text, structured);
        assert.equal(text, " First.  Second.", "existing prose filtering preserves surrounding spaces");
        assert.ok(!wire.includes("acp tokens"));
    });
}

test("Google: a held prose tail cannot ride a sibling signed thought frame", async () => {
    const events = await collect([
        candidate([{ text: '\x3cacp tokens="2"' }, { thought: true, text: thought, thoughtSignature: signature }]),
        candidate([{ text: ' type="text"\x3em00001\x3c/acp\x3e Answer.' }]), candidate([], "STOP"),
    ]);
    const parts = partsOf(framesOf(forwarded(events)));
    assert.deepEqual(parts.filter(part => part.thought === true), [{ thought: true, text: thought, thoughtSignature: signature }]);
    assert.equal(parts.filter(part => part.thought !== true).map(part => part.text ?? "").join(""), " Answer.");
});

test("Google: a frame containing only opaque output parts is forwarded verbatim", async () => {
    const frame = candidate([image, code, result]);
    frame.modelVersion = "gemini-test";
    frame.responseId = "response-output-parts";
    const events = await collect([frame, candidate([], "STOP")]);
    assert.equal(forwarded(events), sse(frame));
});

test("Google: filtered proxy-call siblings retain opaque output but never leak held prose", async () => {
    const events = await collect([
        candidate([{ text: tag }, image, { functionCall: { name: "acp_status", args: {} } }]), candidate([], "STOP"),
    ]);
    const wire = forwarded(events);
    assert.deepEqual(partsOf(framesOf(wire)).filter(part => part.inlineData !== undefined), [image]);
    assert.ok(!wire.includes("acp tokens"));
    assert.ok(!wire.includes("functionCall"));
    assert.equal(events.filter(event => event.kind === "tool_call").length, 1);
});

test("Google: mixed real/proxy calls retain cleaned siblings once", async () => {
    const real: Part = { functionCall: { id: "real", name: "lookup", args: { query: `literal ${tag}` } }, thoughtSignature: "real-call-signature" };
    const events = await collect([
        candidate([{ text: tag }, image, real, { functionCall: { name: "acp_status", args: {} } }]), candidate([], "STOP"),
    ]);
    const parts = partsOf(framesOf(forwarded(events)));
    assert.deepEqual(parts.filter(part => part.functionCall !== undefined), [real]);
    assert.deepEqual(parts.filter(part => part.inlineData !== undefined), [image]);
    assert.equal(parts.map(part => part.text ?? "").join(""), "");
});

test("Google: a final text frame after a real call is not replayed with the terminal", async () => {
    const events = await collect([
        candidate([{ functionCall: { name: "lookup", args: {} } }]), candidate([{ text: "Terminal sibling." }], "STOP"),
    ]);
    const frames = framesOf(forwarded(events));
    assert.equal(partsOf(frames).map(part => part.text ?? "").join(""), "Terminal sibling.");
    assert.equal(frames.filter(frame => (frame.candidates as Array<Record<string, unknown>>)[0]?.finishReason !== undefined).length, 1);
});

test("Google: a real-call terminal frame delivers one call and one finish reason", async () => {
    const call = { functionCall: { name: "lookup", args: {} } };
    const frames = framesOf(forwarded(await collect([candidate([call], "STOP")])));
    assert.deepEqual(partsOf(frames), [call]);
    assert.equal(frames.filter(frame => (frame.candidates as Array<Record<string, unknown>>)[0]?.finishReason !== undefined).length, 1);
});

test("Google control: an unedited single-part frame keeps its exact wire bytes", async () => {
    const frame = candidate([{ text: "Single-part control." }]);
    frame.responseId = "control";
    const events = await collect([frame, candidate([], "STOP")]);
    assert.equal(forwarded(events), sse(frame));
});

test("Google control: signature-only parts and proxy-only tool suppression remain intact", async () => {
    const events = await collect([
        candidate([{ thoughtSignature: signature }]),
        candidate([{ functionCall: { name: "acp_status", args: {} } }], "STOP"),
    ]);
    assert.deepEqual(partsOf(framesOf(forwarded(events))), [{ thoughtSignature: signature }]);
    assert.equal(events.filter(event => event.kind === "standalone_signature").length, 1);
    assert.ok(!forwarded(events).includes("finishReason"));
});

async function close(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}

async function throughProxy(rounds: Array<Array<Record<string, unknown>>>): Promise<{ calls: Array<Record<string, unknown>>; wire: string }> {
    const calls: Array<Record<string, unknown>> = [];
    const upstream = http.createServer(async (req, res) => {
        const buffers: Buffer[] = [];
        for await (const chunk of req) buffers.push(Buffer.from(chunk));
        calls.push(JSON.parse(Buffer.concat(buffers).toString()) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end((rounds[calls.length - 1] ?? [candidate([{ text: "Unexpected retry." }], "STOP")]).map(sse).join(""));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1", routes: {},
        modelContextLimit: 10_000, kernelConfig: defaultConfig(10_000),
        compress: { injectTool: true, injectNudge: true }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
        autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false,
        releaseNotesCheck: false, mitm: { enabled: false, domains: [] },
    } as unknown as ProxyOptions);
    if (!proxy.listening) await once(proxy, "listening");
    try {
        const upstreamPort = (upstream.address() as import("node:net").AddressInfo).port;
        const proxyPort = (proxy.address() as import("node:net").AddressInfo).port;
        const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, {
            method: "POST", headers: { "content-type": "application/json", "x-acp-session": `complete-frame-${proxyPort}` },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Report status then answer." }] }] }),
        });
        const wire = await response.text();
        assert.equal(response.status, 200);
        return { calls, wire };
    } finally {
        await close(proxy);
        await close(upstream);
    }
}

test("Google HTTP proxy: complete frames are sent once in both rounds and signed replay stays exact", async () => {
    const firstParts = [{ thought: true, text: thought, thoughtSignature: signature }, { text: "Before status." }];
    const finalThought = { thought: true, text: "  Final signed thought.  ", thoughtSignature: "ZmluYWwtc2lnbmF0dXJl" };
    const { calls, wire } = await throughProxy([
        [candidate(firstParts), candidate([{ functionCall: { id: "status", name: "acp_status", args: {} }, thoughtSignature: "c3RhdHVzLXNpZw==" }], "STOP")],
        [candidate([{ text: "Final first. " }, finalThought, { text: "Final second." }]), candidate([], "STOP")],
    ]);
    assert.equal(calls.length, 2);
    const visible = partsOf(framesOf(wire));
    assert.deepEqual(visible.filter(part => part.thought === true), [firstParts[0], finalThought]);
    for (const text of ["Before status.", "Final first. ", "Final second."]) {
        assert.equal(visible.filter(part => part.text === text).length, 1, `${text} appears exactly once`);
    }
    const replay = (calls[1]!.contents as Array<{ parts: Part[] }>).flatMap(content => content.parts);
    assert.deepEqual(replay.filter(part => part.thought === true), [firstParts[0]]);
    assert.equal(replay.find(part => part.functionCall !== undefined)?.thoughtSignature, "c3RhdHVzLXNpZw==");
    assert.equal(framesOf(wire).filter(frame => (frame.candidates as Array<Record<string, unknown>> | undefined)?.[0]?.finishReason !== undefined).length, 1);
});

test("Google HTTP proxy: output-only parts reach the client without a retry", async () => {
    const { calls, wire } = await throughProxy([[candidate([image, code, result]), candidate([], "STOP")]]);
    assert.equal(calls.length, 1);
    assert.deepEqual(partsOf(framesOf(wire)), [image, code, result]);
});

test("Google HTTP proxy: buffered continuation parts are not synthesized ahead of their call frame", async () => {
    const parts = [{ text: "Buffered first. " }, { thought: true, text: thought, thoughtSignature: signature }, { text: "Buffered second." },
        { functionCall: { name: "lookup", args: { query: "exact" } }, thoughtSignature: "dG9vbC1zaWduYXR1cmU=" }];
    const { calls, wire } = await throughProxy([
        [candidate([{ functionCall: { name: "acp_status", args: {} } }], "STOP")],
        [candidate(parts, "STOP")],
    ]);
    assert.equal(calls.length, 2);
    const frames = framesOf(wire);
    assert.deepEqual(partsOf(frames).filter(part => part.text === "Buffered first. " || part.text === "Buffered second." || part.thought === true || part.functionCall !== undefined), parts);
    assert.equal(frames.filter(frame => (frame.candidates as Array<Record<string, unknown>> | undefined)?.[0]?.finishReason !== undefined).length, 1);
});

test("Google HTTP control: single-part replies remain single-part", async () => {
    const { calls, wire } = await throughProxy([[candidate([{ text: "Control answer." }]), candidate([], "STOP")]]);
    assert.equal(calls.length, 1);
    assert.deepEqual(partsOf(framesOf(wire)), [{ text: "Control answer." }]);
});
