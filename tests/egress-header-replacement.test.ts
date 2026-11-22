import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { defaultConfig } from "acp-kernel";
import { applyEgressTransforms, parseEgressTransformEntries, type EgressTransformBase } from "../src/egress-transforms.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startServer } from "../src/server.ts";

const dir = mkdtempSync(join(tmpdir(), "bili-egress-headers-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let nextPlugin = 0;
function plugin(headers: string): string {
    const path = join(dir, `headers-${nextPlugin++}.mjs`);
    writeFileSync(path, `export default { transform() { return { headers: ${headers} }; } };`);
    return path;
}
function base(headers: Record<string, string>): EgressTransformBase {
    return { sessionId: "headers", upstreamUrl: "https://example.com/v1/chat/completions", method: "POST",
        url: "https://example.com/v1/chat/completions", headers, protocol: "openai", model: "test", stage: "initial" };
}
async function run(headers: Record<string, string>, patches: string[]): Promise<void> {
    const entries = parseEgressTransformEntries(patches.map(patch => ({ module: plugin(patch) })));
    assert.equal(await applyEgressTransforms("body", base(headers), entries, () => {}), "body");
}

for (const [existing, replacement] of [["authorization", "Authorization"], ["Authorization", "authorization"]]) {
    test(`returned ${replacement} replaces existing ${existing} on the HTTP header set`, async () => {
        const headers = { [existing]: "Bearer original-test-key", "x-unrelated": "keep" };
        await run(headers, [JSON.stringify({ [replacement]: "Bearer replacement-test-key" })]);
        assert.equal(new Headers(headers).get("authorization"), "Bearer replacement-test-key");
        assert.equal(new Headers(headers).get("x-unrelated"), "keep");
    });
}

test("a replacement removes every pre-existing casing of the same field", async () => {
    const headers = { "X-Route": "old-a", "x-route": "old-b", "x-keep": "keep" };
    await run(headers, ['{ "X-ROUTE": "new" }']);
    assert.equal(new Headers(headers).get("x-route"), "new");
    assert.equal(new Headers(headers).get("x-keep"), "keep");
});

test("multiple returned casings retain the last field update", async () => {
    const headers = {};
    await run(headers, ['{ "X-Route": "first", "x-route": "last" }']);
    assert.equal(new Headers(headers).get("x-route"), "last");
});

test("later plugins replace earlier values regardless of header casing", async () => {
    const headers = { "x-route": "original" };
    await run(headers, ['{ "X-Route": "first" }', '{ "X-ROUTE": "second" }']);
    assert.equal(new Headers(headers).get("x-route"), "second");
});

test("undefined header values still remove a field case-insensitively", async () => {
    const headers = { "X-Remove": "one", "x-remove": "two", "x-keep": "keep" };
    await run(headers, ['{ "X-REMOVE": undefined }']);
    assert.equal(new Headers(headers).get("x-remove"), null);
    assert.equal(new Headers(headers).get("x-keep"), "keep");
});

test("same-case replacement and explicit comma-separated values remain intact", async () => {
    const headers = { "x-route": "original" };
    await run(headers, ['{ "x-route": "first, second" }']);
    assert.deepEqual(headers, { "x-route": "first, second" });
});

test("an unconfigured pipeline leaves headers and Buffer identity untouched", async () => {
    const headers = { "X-Route": "one", "x-route": "two" };
    const body = Buffer.from("body");
    assert.equal(await applyEgressTransforms(body, base(headers), [], () => {}), body);
    assert.deepEqual(headers, { "X-Route": "one", "x-route": "two" });
});

test("real proxy sends only the replacement credential returned by an egress plugin", async () => {
    const seen: string[] = [];
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            const authorization = req.headers.authorization ?? "";
            seen.push(authorization);
            const ok = authorization === "Bearer replacement-test-key";
            res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
            res.end(JSON.stringify(ok
                ? { choices: [{ message: { role: "assistant", content: "accepted" }, finish_reason: "stop" }] }
                : { error: { message: "unexpected credential", type: "authentication_error" } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1", routes: {},
        modelContextLimit: 10_000, kernelConfig: defaultConfig(10_000),
        compress: { injectTool: false, injectNudge: false }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: true, passthroughSource: null, autoUpdate: false,
        autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        compat: { roles: {} }, streamErrorShape: "protocol", mitm: { enabled: false, domains: [] },
        egressTransforms: parseEgressTransformEntries([{ module: plugin('{ Authorization: "Bearer replacement-test-key" }') }]),
    } as unknown as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
            method: "POST", headers: { "content-type": "application/json", authorization: "Bearer original-test-key" },
            body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hello" }] }),
            signal: AbortSignal.timeout(5_000),
        });
        await response.text();
        assert.deepEqual({ status: response.status, seen }, { status: 200, seen: ["Bearer replacement-test-key"] });
    } finally {
        proxy.close();
        upstream.close();
    }
});
