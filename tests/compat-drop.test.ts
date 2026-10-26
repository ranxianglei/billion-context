import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { loadRoutes, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { applyCompatDropFields, dropCompatFieldsJson, parseCompatDropFields, resolveCompatDropFields } from "../src/compat-drop.ts";
import { rmrf } from "./tmp-rm.ts";

// #1757: opt-in removal of client-fixed request fields that strict-schema
// upstreams reject (SenseNova's Responses gateway 400s pi-ai's fixed
// reasoning.summary). Units pin the contract (dot-paths, additive merge,
// structural-only deletion, byte-for-byte no-op); the e2e cases pin both
// application points — the processed final boundary and the verbatim fallback.

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

test("parseCompatDropFields: valid dot-paths kept, malformed entries dropped individually", () => {
    assert.equal(parseCompatDropFields(undefined), undefined);
    assert.equal(parseCompatDropFields("reasoning.summary"), undefined);
    assert.equal(parseCompatDropFields({}), undefined);
    assert.equal(parseCompatDropFields([]), undefined);
    assert.deepEqual(parseCompatDropFields(["reasoning.summary", "store", "reasoning.summary"]), ["reasoning.summary", "store"]);
    assert.deepEqual(parseCompatDropFields(["reasoning.summary", "a.*", "tools[0].x", "a..b", "", "a b", 42, {}]), ["reasoning.summary"]);
    assert.equal(parseCompatDropFields(["a.*", 42]), undefined);
    assert.deepEqual(parseCompatDropFields(["  store  "]), ["store"]);
});

test("resolveCompatDropFields: additive union — provider adds but never retracts global", () => {
    const routes = {
        "https://api.a.com": { compat: { dropFields: ["reasoning.summary"] } },
    };
    assert.deepEqual(resolveCompatDropFields(routes, "https://api.b.com/v1/responses", undefined), []);
    assert.deepEqual(resolveCompatDropFields(routes, undefined, undefined), []);
    assert.deepEqual(resolveCompatDropFields(routes, "https://api.a.com/v1/responses", undefined), ["reasoning.summary"]);
    assert.deepEqual(resolveCompatDropFields(routes, "https://api.a.com/v1/responses", ["store"]), ["store", "reasoning.summary"]);
    // Same path in both levels collapses to one entry.
    assert.deepEqual(resolveCompatDropFields(routes, "https://api.a.com/v1/responses", ["reasoning.summary"]), ["reasoning.summary"]);
});

test("dropCompatFieldsJson: structural deletion only, missing nodes skipped, counts actual deletions", () => {
    const parsed = {
        model: "m",
        reasoning: { effort: "high", summary: "auto" },
        store: true,
        tools: [{ type: "function", name: "f", parameters: { type: "object", properties: {} } }],
        input: [{ type: "message", role: "user", content: 'write "reasoning.summary" verbatim' }],
    } as Record<string, unknown>;
    const dropped = dropCompatFieldsJson(parsed, ["reasoning.summary", "store", "nope.x"]);
    assert.equal(dropped, 2, "only reasoning.summary + store exist; nope.x skipped");
    const r = parsed.reasoning as Record<string, unknown>;
    assert.ok(!("summary" in r));
    assert.equal(r.effort, "high", "sibling key untouched");
    assert.ok(!("store" in parsed));
    // String leaves are never read or written (§7.3 wire fidelity).
    assert.equal((parsed.input as Array<{ content: string }>)[0].content, 'write "reasoning.summary" verbatim');
});

test("dropCompatFieldsJson: array/string intermediates skipped silently, never throws", () => {
    const parsed = { reasoning: "auto", items: [{ summary: "keep" }] } as Record<string, unknown>;
    assert.equal(dropCompatFieldsJson(parsed, ["reasoning.summary", "items.0.summary"]), 0);
    assert.deepEqual(parsed.items, [{ summary: "keep" }]);
    assert.equal(parsed.reasoning, "auto");
});

test("applyCompatDropFields: original string identity on every no-op", () => {
    const body = JSON.stringify({ model: "m", reasoning: { effort: "high" } });
    assert.deepEqual(applyCompatDropFields(body, []), { body, dropped: 0 });
    assert.equal(applyCompatDropFields(body, ["reasoning.summary"]).body, body, "no match ⇒ same string, no re-stringify");
    const bad = "{not json";
    assert.equal(applyCompatDropFields(bad, ["reasoning.summary"]).body, bad);
    const arr = "[1,2]";
    assert.equal(applyCompatDropFields(arr, ["0"]).body, arr);
});

test("applyCompatDropFields: re-serializes only when something was dropped", () => {
    const body = JSON.stringify({ model: "m", reasoning: { effort: "high", summary: "auto" }, keep: 1 });
    const out = applyCompatDropFields(body, ["reasoning.summary"]);
    assert.equal(out.dropped, 1);
    assert.notEqual(out.body, body);
    const parsed = JSON.parse(out.body) as Record<string, unknown>;
    assert.equal(parsed.model, "m");
    assert.equal(parsed.keep, 1);
    const r = parsed.reasoning as Record<string, unknown>;
    assert.equal(r.effort, "high");
    assert.ok(!("summary" in r));
});

function upstreamServer(status: number, onBody: (path: string, body: unknown) => void): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: unknown = null;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignore */ }
            onBody(req.url ?? "", parsed);
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

interface StartOpts {
    configJson: string;
}

async function startProxy(upstream: http.Server, { configJson }: StartOpts): Promise<{ port: number; stop: () => Promise<void>; cleanup: () => void }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-compat-drop-${process.pid}-${Date.now()}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, configJson, "utf8");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const upstreamPort = (upstream.address() as { port: number }).port;
    const port = await freePort();
    const cfg = JSON.parse(configJson) as { compat?: { roles?: unknown; dropFields?: unknown } };
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: loadRoutes(),
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        compat: { roles: {}, dropFields: parseCompatDropFields(cfg.compat?.dropFields) ?? [] },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        passthroughSource: null,
        streamErrorShape: "protocol",
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    return {
        port,
        stop: async () => { await close(proxy); },
        cleanup: () => {
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
            rmrf(root);
        },
    };
}

const PI_AI_BODY = { model: "test", reasoning: { effort: "high", summary: "auto" }, input: [{ type: "message", role: "user", content: "hi" }] };

test("e2e #1757 A: per-provider compat.dropFields strips the field on the processed responses path", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer(200, (_path, body) => seen.push(body as Record<string, unknown>));
    const upUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const harness = await startProxy(upstream, { configJson: JSON.stringify({ providers: { [upUrl]: { compat: { dropFields: ["reasoning.summary"] } } } }) });
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-drop-a" },
            body: JSON.stringify(PI_AI_BODY),
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        const fwd = seen[0];
        const r = fwd.reasoning as Record<string, unknown>;
        assert.equal(r.effort, "high", "reasoning.effort survives");
        assert.ok(!("summary" in r), "reasoning.summary stripped before forward");
        const input = fwd.input as Array<{ type?: string; role?: string; content?: unknown }>;
        assert.ok(input.some((it) => it.role === "user" && JSON.stringify(it.content).includes("hi")), "conversation intact");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #1757 B: verbatim fallback (unknown path) strips configured fields too", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer(200, (_path, body) => seen.push(body as Record<string, unknown>));
    const upUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const harness = await startProxy(upstream, { configJson: JSON.stringify({ providers: { [upUrl]: { compat: { dropFields: ["reasoning.summary"] } } } }) });
    try {
        // /v1/custom is not a recognized protocol path → protocol null → the
        // request relays raw through the final fallback, where scrubCompatDrop
        // runs (#1757 owner detail: same call sites as scrubAnthropicPck).
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/custom`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "m", reasoning: { effort: "high", summary: "auto" }, opaque: { keep: 1 } }),
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        const fwd = seen[0];
        const r = fwd.reasoning as Record<string, unknown>;
        assert.equal(r.effort, "high");
        assert.ok(!("summary" in r), "verbatim fallback stripped reasoning.summary");
        assert.deepEqual(fwd.opaque, { keep: 1 }, "everything else relayed untouched");
        assert.equal(fwd.model, "m");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #1757 C: unconfigured ⇒ transparent (opt-in pinned — default behavior unchanged)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer(200, (_path, body) => seen.push(body as Record<string, unknown>));
    const harness = await startProxy(upstream, { configJson: `{"providers":{}}` });
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-drop-c" },
            body: JSON.stringify(PI_AI_BODY),
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        const r = seen[0].reasoning as Record<string, unknown>;
        assert.equal(r.summary, "auto", "no config ⇒ the client's field reaches the upstream untouched");
        assert.equal(r.effort, "high");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #1757 D: global ∪ per-provider additive — both configured paths stripped", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer(200, (_path, body) => seen.push(body as Record<string, unknown>));
    const upUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const config = {
        compat: { dropFields: ["store"] },
        providers: { [upUrl]: { compat: { dropFields: ["reasoning.summary"] } } },
    };
    const harness = await startProxy(upstream, { configJson: JSON.stringify(config) });
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-drop-d" },
            body: JSON.stringify({ ...PI_AI_BODY, store: true }),
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        const fwd = seen[0];
        const r = fwd.reasoning as Record<string, unknown>;
        assert.ok(!("summary" in r), "provider-configured path stripped");
        assert.equal(r.effort, "high");
        assert.ok(!("store" in fwd), "global-configured path stripped");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #1757 E: string leaves containing the literal path text survive byte-exact", async () => {
    const LITERAL = 'the field "reasoning.summary" with {"summary":"auto"} must survive';
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer(200, (_path, body) => seen.push(body as Record<string, unknown>));
    const upUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const harness = await startProxy(upstream, { configJson: JSON.stringify({ providers: { [upUrl]: { compat: { dropFields: ["reasoning.summary"] } } } }) });
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-drop-e" },
            body: JSON.stringify({ model: "test", reasoning: { effort: "high", summary: "auto" }, input: [{ type: "message", role: "user", content: LITERAL }] }),
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        const input = seen[0].input as Array<{ content?: unknown }>;
        const texts = input.map((it) => typeof it.content === "string" ? it.content : JSON.stringify(it.content));
        assert.ok(texts.some((t) => t.includes(LITERAL)), "prose mentioning the path is not a deletion target");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});
