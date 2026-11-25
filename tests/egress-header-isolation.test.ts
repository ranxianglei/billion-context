import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { defaultConfig } from "acp-kernel";
import { applyEgressTransforms, parseEgressTransformEntries, type EgressTransformBase } from "../src/egress-transforms.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startServer } from "../src/server.ts";

const dir = mkdtempSync(join(tmpdir(), "bili-egress-isolation-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let nextPlugin = 0;
function plugin(code: string): string {
    const path = join(dir, `plugin-${nextPlugin++}.mjs`);
    writeFileSync(path, code);
    return path;
}
const original = () => ({ authorization: "Bearer accepted-test-key", "x-keep": "keep" });
function base(headers: Record<string, string>): EgressTransformBase {
    return { sessionId: "isolation", upstreamUrl: "https://example.com/v1/chat/completions", method: "POST",
        url: "https://example.com/v1/chat/completions", headers, protocol: "openai", model: "test", stage: "initial" };
}
const mutate = 'c.headers.authorization = "Bearer rejected-test-key"; delete c.headers["x-keep"]; c.headers["x-partial"] = "partial";';

for (const [name, outcome] of [
    ["throw", 'throw new Error("plugin failed");'],
    ["timeout", "await new Promise(() => {});"],
    ["invalid body", "return { body: 123 };"],
]) {
    test(`failed plugin header edits are discarded on ${name} before the next plugin`, async () => {
        const headers = original();
        const entries = parseEgressTransformEntries([
            { module: plugin(`export default { timeoutMs: 20, async transform(c) { ${mutate} ${outcome} } };`) },
            { module: plugin('export default { transform(c) { return { body: JSON.stringify(c.headers) }; } };') },
        ]);
        const body = await applyEgressTransforms("body", base(headers), entries, () => {});
        assert.deepEqual(JSON.parse(String(body)), original());
        assert.deepEqual(headers, original());
    });
}

test("a timed-out plugin cannot mutate outgoing headers after it eventually resumes", async () => {
    const coordinator = plugin(`
        let release; let complete;
        export const gate = new Promise(resolve => { release = resolve; });
        export const done = new Promise(resolve => { complete = resolve; });
        export { release, complete };
    `);
    const control = await import(pathToFileURL(coordinator).href) as {
        release: () => void; done: Promise<void>;
    };
    const late = plugin(`
        import { gate, complete } from ${JSON.stringify(pathToFileURL(coordinator).href)};
        export default { timeoutMs: 20, async transform(c) {
            await gate;
            ${mutate}
            complete();
            return { body: "too late" };
        } };
    `);
    const headers = original();
    try {
        assert.equal(await applyEgressTransforms("body", base(headers), parseEgressTransformEntries([{ module: late }]), () => {}), "body");
        assert.deepEqual(headers, original());
    } finally {
        control.release();
        await control.done;
    }
    assert.deepEqual(headers, original());
});

for (const result of ["undefined", "null"]) {
    test(`successful direct header mutations still commit when the plugin returns ${result}`, async () => {
        const headers = original();
        const context = base(headers);
        const entries = parseEgressTransformEntries([{ module: plugin(`export default { transform(c) { ${mutate} return ${result}; } };`) }]);
        assert.equal(await applyEgressTransforms("body", context, entries, () => {}), "body");
        assert.equal(context.headers, headers, "callers retain their original live header map");
        assert.deepEqual(headers, { authorization: "Bearer rejected-test-key", "x-partial": "partial" });
    });
}

test("successful direct edits and returned header patches reach the next plugin together", async () => {
    const headers = original();
    const entries = parseEgressTransformEntries([
        { module: plugin(`export default { transform(c) { ${mutate} return { body: "changed", headers: { authorization: "Bearer final-test-key", "x-returned": "yes" } }; } };`) },
        { module: plugin('export default { transform(c) { return { body: c.body + JSON.stringify(c.headers) }; } };') },
    ]);
    const expected = { authorization: "Bearer final-test-key", "x-partial": "partial", "x-returned": "yes" };
    const body = await applyEgressTransforms("body", base(headers), entries, () => {});
    assert.match(String(body), /^changed/);
    assert.deepEqual(JSON.parse(String(body).slice("changed".length)), expected);
    assert.deepEqual(headers, expected);
});

test("real proxy retains a working credential when an egress plugin fails after changing it", async () => {
    const seen: string[] = [];
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            const authorization = req.headers.authorization ?? "";
            seen.push(authorization);
            const ok = authorization === "Bearer accepted-test-key";
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
        egressTransforms: parseEgressTransformEntries([{ module: plugin(`export default { transform(c) { ${mutate} throw new Error("plugin failed"); } };`) }]),
    } as unknown as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
            method: "POST", headers: { "content-type": "application/json", authorization: "Bearer accepted-test-key" },
            body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hello" }] }),
            signal: AbortSignal.timeout(5_000),
        });
        await response.text();
        assert.deepEqual({ status: response.status, seen }, { status: 200, seen: ["Bearer accepted-test-key"] });
    } finally {
        proxy.close();
        upstream.close();
    }
});
