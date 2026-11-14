import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState, defaultConfig } from "acp-kernel";
import { anthropicToCore, googleToCore, openaiToCore, responsesToCore } from "acp-kernel/wire";
import { bodyMightCarryImages, buildIncomingImageIndex } from "../src/image-restore.ts";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import type { WireProtocol } from "../src/util.ts";

const root = mkdtempSync(join(tmpdir(), "bili-image-markers-"));
process.env.XDG_STATE_HOME = join(root, "state");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.XDG_CONFIG_HOME = join(root, "config");
test.after(() => rmSync(root, { recursive: true, force: true }));

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const dataUrl = `data:image/png;base64,${PNG}`;
const openai = { model: "gpt-fixture", stream: false, messages: [{ role: "user", content: [{ type: "text", text: "Describe this image." }, { type: "image_url", image_url: { url: dataUrl } }] }] };
const fixtures: Array<{ protocol: WireProtocol; body: unknown; marker: string; escaped: string }> = [
    { protocol: "openai", body: openai, marker: "data:", escaped: "\\u0064ata\\u003a" },
    { protocol: "responses", body: { model: "gpt-fixture", input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: dataUrl }] }] }, marker: "data:", escaped: "\\u0064ata\\u003A" },
    { protocol: "anthropic", body: { model: "claude-fixture", max_tokens: 10, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }] }, marker: '"base64"', escaped: '"base\\u00364"' },
    { protocol: "google", body: { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] }] }, marker: "inlineData", escaped: "\\u0069nlineD\\u0061ta" },
];
const converters = { anthropic: anthropicToCore, openai: openaiToCore, responses: responsesToCore, google: googleToCore };

function escapeStrings(body: unknown): string {
    return JSON.stringify(body).replace(/"(?:\\.|[^"\\])*"/g, (token) => {
        const value = JSON.parse(token) as string;
        return `"${[...value].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`;
    });
}

for (const fixture of fixtures) {
    for (const escaped of [false, true]) {
        test(`${fixture.protocol} image indexing survives ${escaped ? "escaped" : "literal"} JSON markers`, () => {
            const plain = JSON.stringify(fixture.body);
            const wire = escaped ? plain.replace(fixture.marker, fixture.escaped) : plain;
            const parsed = JSON.parse(wire);
            assert.deepEqual(parsed, fixture.body);
            const converted = (converters[fixture.protocol] as (body: unknown) => unknown)(parsed);
            const messages = (Array.isArray(converted) ? converted : (converted as { msgs: unknown[] }).msgs) as Array<{ id: string }>;
            const state = createInitialState();
            messages.forEach((message, index) => { state.messageRefs.byRaw[message.id] = `m${String(index + 1).padStart(5, "0")}`; });
            const expected = buildIncomingImageIndex(parsed, fixture.protocol, state, `fixture-${fixture.protocol}`);
            assert.equal(expected.size, 1, "the protocol converter exposes actual recoverable image bytes");
            for (const images of expected.values()) assert.deepEqual(readFileSync(images[0]!.path), Buffer.from(PNG, "base64"));
            const guarded = bodyMightCarryImages(wire, fixture.protocol)
                ? buildIncomingImageIndex(parsed, fixture.protocol, state, `fixture-${fixture.protocol}`) : new Map();
            assert.deepEqual(guarded, expected);
        });
    }
    test(`${fixture.protocol} escaped text remains an image-free fast path`, () => {
        const text = '{"text":"\\u0068ello \\u4e16\\u754c and \\\\u0061 literal"}';
        assert.equal(bodyMightCarryImages(text, fixture.protocol), false);
    });
}

test("fully escaped JSON keys, media markers, and separators remain detectable", () => {
    for (const fixture of fixtures) {
        const wire = escapeStrings(fixture.body);
        assert.deepEqual(JSON.parse(wire), fixture.body);
        assert.equal(bodyMightCarryImages(wire, fixture.protocol), true, fixture.protocol);
    }
});

test("encoded data URL tokens keep the existing case-insensitive recognition", () => {
    const body = { image_url: `DATA:IMAGE/PNG;BASE64,${PNG}` };
    assert.equal(bodyMightCarryImages(JSON.stringify(body), "openai"), true);
    assert.equal(bodyMightCarryImages(escapeStrings(body), "openai"), true);
});

test("real HTTP preparation archives the same pixels with escaped and literal data URL markers", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = http.createServer(async (request, response) => {
        for await (const _chunk of request) { /* consume the actual forwarded request */ }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "fixture", object: "chat.completion", model: "gpt-fixture", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: origin, routes: { [origin]: { models: { "gpt-fixture": { context: 100_000 } } } }, modelContextLimit: 100_000, kernelConfig: defaultConfig(100_000), compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, passthroughSource: null, autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false, compat: { roles: {} }, streamErrorShape: "protocol", mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!proxy.listening) await once(proxy, "listening");
    try {
        for (const escaped of [false, true]) {
            const label = `image-markers-${escaped}`;
            const plain = JSON.stringify(openai);
            const wire = escaped ? plain.replace("data:", "\\u0064ata\\u003a") : plain;
            const response = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${origin}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": label }, body: wire, signal: AbortSignal.timeout(10_000) });
            assert.equal(response.status, 200, await response.text());
            const session = listSessions().find((candidate) => candidate.meta.label === label);
            assert.ok(session, "the real preparation path tracked the conversation");
            assert.equal(session.incomingImageIndex?.size, 1, label);
            const image = [...session.incomingImageIndex!.values()][0]![0]!;
            assert.deepEqual(readFileSync(image.path), Buffer.from(PNG, "base64"));
        }
    } finally {
        proxy.closeAllConnections(); upstream.closeAllConnections();
        await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    }
});
