import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { defaultConfig } from "acp-kernel";
import { applyEgressTransforms, parseEgressTransformEntries, resetEgressModuleCache, type EgressTransformBase } from "../src/egress-transforms.js";
import type { ProxyOptions } from "../src/config.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import { startServer } from "../src/server.js";

const dir = mkdtempSync(join(tmpdir(), "bili-egress-body-"));
after(() => { resetEgressModuleCache(); rmSync(dir, { recursive: true, force: true }); });
let nextPlugin = 0;
function plugin(code: string): string {
    const path = join(dir, `plugin-${nextPlugin++}.mjs`);
    writeFileSync(path, code);
    return path;
}
function base(): EgressTransformBase {
    return { sessionId: "body-isolation", upstreamUrl: "https://example.com/upload", method: "POST",
        url: "/upload", headers: {}, protocol: "openai", model: "test", stage: "initial" };
}
const original = () => Buffer.from([0x00, 0xff, 0x20, 0x7f, 0x80, 0x42]);

for (const [name, outcome] of [
    ["throw", 'throw new Error("plugin failed");'],
    ["timeout", "await new Promise(() => {});"],
    ["invalid result", "return { body: 123 };"],
]) {
    test(`a plugin's Buffer mutations are discarded on ${name} before the next stage`, async () => {
        const input = original();
        const ctx = base();
        const entries = parseEgressTransformEntries([
            { module: plugin(`export default { timeoutMs: 20, async transform(c) { c.body.fill(0); ${outcome} } };`) },
            { module: plugin('export default { transform(c) { return { headers: { "x-observed": c.body.toString("hex") } }; } };') },
        ]);
        const result = await applyEgressTransforms(input, ctx, entries, () => {});
        assert.equal(result, input, "fail-open keeps the accepted body reference");
        assert.deepEqual(input, original(), "the caller's input is not corrupted");
        assert.equal(ctx.headers["x-observed"], original().toString("hex"));
    });
}

for (const outcome of ["undefined", "null"]) {
    test(`returning ${outcome} leaves Buffer bytes unchanged even after direct edits`, async () => {
        const input = original();
        const ctx = base();
        const entries = parseEgressTransformEntries([{ module: plugin(`export default { transform(c) {
            c.body.fill(0); c.headers["x-accepted"] = "yes"; return ${outcome};
        } };`) }]);
        assert.equal(await applyEgressTransforms(input, ctx, entries, () => {}), input);
        assert.deepEqual(input, original());
        assert.equal(ctx.headers["x-accepted"], "yes", "successful header-only edits still commit");
    });
}

test("returning a modified Buffer draft commits its bytes without modifying the caller's input", async () => {
    const input = original();
    const expected = original();
    expected[0] = 0x99;
    const entries = parseEgressTransformEntries([{ module: plugin('export default { transform(c) { c.body[0] = 0x99; return { body: c.body }; } };') }]);
    const result = await applyEgressTransforms(input, base(), entries, () => {});
    assert.deepEqual(result, expected);
    assert.deepEqual(input, original());
});

test("a later failed plugin cannot damage an earlier plugin's accepted Buffer", async () => {
    const entries = parseEgressTransformEntries([
        { module: plugin('export default { transform() { return { body: Buffer.from("accepted") }; } };') },
        { module: plugin('export default { transform(c) { c.body.fill(0); throw new Error("failed"); } };') },
    ]);
    const result = await applyEgressTransforms("initial string", base(), entries, () => {});
    assert.deepEqual(result, Buffer.from("accepted"));
});

test("a timed-out plugin cannot corrupt the returned body when it later resumes", async () => {
    const coordinator = plugin(`
        let release; let complete;
        export const gate = new Promise(resolve => { release = resolve; });
        export const done = new Promise(resolve => { complete = resolve; });
        export { release, complete };
    `);
    const control = await import(pathToFileURL(coordinator).href) as { release: () => void; done: Promise<void> };
    const late = plugin(`
        import { gate, complete } from ${JSON.stringify(pathToFileURL(coordinator).href)};
        export default { timeoutMs: 20, async transform(c) {
            await gate; c.body.fill(0); complete(); return { body: c.body };
        } };
    `);
    const input = original();
    let result: string | Buffer;
    try {
        result = await applyEgressTransforms(input, base(), parseEgressTransformEntries([{ module: late }]), () => {});
        assert.deepEqual(result, original());
    } finally {
        control.release();
        await control.done;
    }
    assert.deepEqual(result, original());
    assert.deepEqual(input, original());
});

test("an empty or unmatched pipeline preserves Buffer identity and bytes", async () => {
    const input = original();
    assert.equal(await applyEgressTransforms(input, base(), [], () => {}), input);
    const entries = parseEgressTransformEntries([{ match: { urlPrefix: "https://unmatched.invalid/" },
        module: plugin('export default { transform(c) { c.body.fill(0); return { body: c.body }; } };') }]);
    assert.equal(await applyEgressTransforms(input, base(), entries, () => {}), input);
    assert.deepEqual(input, original());
});

test("real proxy delivers the original binary payload after an egress plugin corrupts its draft and throws", async () => {
    const seen: Buffer[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const received = Buffer.concat(chunks);
            seen.push(received);
            res.writeHead(received.equals(original()) ? 200 : 400, { "content-type": "application/json" });
            res.end(JSON.stringify({ received: received.toString("hex") }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1", routes: {},
        modelContextLimit: 10_000, kernelConfig: defaultConfig(10_000), compress: { injectTool: false, injectNudge: false },
        sessionHeader: "x-acp-session", log: false, debug: false, passthrough: true, autoUpdate: false,
        mitm: { enabled: false, domains: [] }, egressTransforms: parseEgressTransformEntries([{ module: plugin(
            'export default { transform(c) { if (!Buffer.isBuffer(c.body)) throw new Error("expected binary Buffer"); c.body.fill(0); throw new Error("plugin failed"); } };',
        ) }]),
    } as unknown as ProxyOptions);
    await once(proxy, "listening");
    try {
        const response = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/http://127.0.0.1:${upstreamPort}/upload`, {
            method: "POST", headers: { "content-type": "application/octet-stream" }, body: original(), signal: AbortSignal.timeout(5_000),
        });
        await response.text();
        assert.deepEqual({ status: response.status, seen }, { status: 200, seen: [original()] });
    } finally {
        proxy.closeAllConnections(); upstream.closeAllConnections();
        await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
    }
});
