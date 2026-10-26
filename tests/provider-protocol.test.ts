import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { findRoute, loadRoutes, parseRouteEntry, resolveDeclaredProtocol, type ProviderRoutes } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

// ─── unit: parseRouteEntry ────────────────────────────────────────────────

test("parseRouteEntry: protocol round-trips and coexists with other fields", () => {
    const route = parseRouteEntry({
        models: { "m1": { context: 100000 } },
        passthrough: false,
        compressProtocol: "marker",
        protocol: "openai",
    });
    assert.equal(route?.protocol, "openai");
    assert.equal(route?.compressProtocol, "marker");
    assert.equal(route?.passthrough, false);
    assert.ok(route?.models);
});

test("parseRouteEntry: absent protocol leaves the field absent", () => {
    const route = parseRouteEntry({ models: { "m": { context: 128000 } } });
    assert.equal(route?.protocol, undefined);
});

for (const [label, value] of [
    ["unknown protocol", { protocol: "mistral" }],
    ["not a string", { protocol: 42 }],
    ["null", { protocol: null }],
    ["empty string", { protocol: "" }],
] as const) {
    test(`parseRouteEntry: malformed protocol throws loudly (${label})`, () => {
        assert.throws(() => parseRouteEntry(value), /\[acp-config\] providers\.protocol/);
    });
}

// ─── unit: resolveDeclaredProtocol ────────────────────────────────────────

test("resolveDeclaredProtocol: deepest EXPLICIT declarer wins over a shallower one", () => {
    const routes: ProviderRoutes = {
        "https://relay.example.com": { protocol: "openai" },
        "https://relay.example.com/api": { protocol: "responses" },
    };
    assert.equal(resolveDeclaredProtocol(routes, "https://relay.example.com/api/custom"), "responses");
    assert.equal(resolveDeclaredProtocol(routes, "https://relay.example.com/other"), "openai");
});

test("resolveDeclaredProtocol: host declaration inherits onto a path key that stays silent (#1909 non-shadowing)", () => {
    const routes: ProviderRoutes = {
        "https://relay.example.com": { protocol: "openai", compress: {} as never },
        // A path-scoped entry carrying ONLY other fields must not shadow the
        // host's protocol — and must not need to duplicate it either.
        "https://relay.example.com/my/custom/complete": { models: { "m1": { context: 100000 } } },
    };
    assert.equal(resolveDeclaredProtocol(routes, "https://relay.example.com/my/custom/complete"), "openai");
    // findRoute keeps its single-entry semantics for the OTHER fields:
    assert.equal(findRoute(routes, "https://relay.example.com/my/custom/complete")?.protocol, undefined);
    assert.ok(findRoute(routes, "https://relay.example.com/my/custom/complete")?.models);
});

test("resolveDeclaredProtocol: path-scoped declaration beats the host key for its subtree only", () => {
    const routes: ProviderRoutes = {
        "https://relay.example.com": { protocol: "openai" },
        "https://relay.example.com/my/custom/complete": { protocol: "anthropic" },
    };
    assert.equal(resolveDeclaredProtocol(routes, "https://relay.example.com/my/custom/complete"), "anthropic");
    assert.equal(resolveDeclaredProtocol(routes, "https://relay.example.com/my/custom/complete/extra"), "anthropic");
    assert.equal(resolveDeclaredProtocol(routes, "https://relay.example.com/v1/messages"), "openai");
});

test("resolveDeclaredProtocol: boundary-safe prefix matching (no lookalike hosts)", () => {
    const routes: ProviderRoutes = { "https://x.com": { protocol: "openai" } };
    assert.equal(resolveDeclaredProtocol(routes, "https://x.com.evil/path"), undefined);
    assert.equal(resolveDeclaredProtocol(routes, "https://x.com"), "openai");
    assert.equal(resolveDeclaredProtocol(routes, "https://x.com/path"), "openai");
});

test("resolveDeclaredProtocol: query string is ignored (same as the built-in table)", () => {
    const routes: ProviderRoutes = { "https://relay.example.com/my/custom/complete": { protocol: "openai" } };
    assert.equal(resolveDeclaredProtocol(routes, "https://relay.example.com/my/custom/complete?api-version=3"), "openai");
});

test("resolveDeclaredProtocol: no declaration / no route / no url → undefined (builtin fallback)", () => {
    const routes: ProviderRoutes = {
        "https://relay.example.com": { models: { "m": { context: 1 } } },
        "https://other.example.com": {},
    };
    assert.equal(resolveDeclaredProtocol(routes, "https://relay.example.com/x"), undefined);
    assert.equal(resolveDeclaredProtocol(routes, "https://unconfigured.example.com/x"), undefined);
    assert.equal(resolveDeclaredProtocol(routes, undefined), undefined);
    assert.equal(resolveDeclaredProtocol({}, "https://relay.example.com/x"), undefined);
});

test("resolveDeclaredProtocol: mitm:// keys match only mitm-form lookups (same keying as other provider fields)", () => {
    const routes: ProviderRoutes = { "mitm://desktop.example.com": { protocol: "openai" } };
    assert.equal(resolveDeclaredProtocol(routes, "mitm://desktop.example.com/v1/code/sessions"), "openai");
    assert.equal(resolveDeclaredProtocol(routes, "https://desktop.example.com/v1/code/sessions"), undefined);
});

// ─── e2e harness ──────────────────────────────────────────────────────────

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface SeenRequest {
    path: string;
    body: string;
    headers: http.IncomingHttpHeaders;
}

function upstreamServer(response: Record<string, unknown>, onBody: (req: SeenRequest) => void): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            onBody({ path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(response));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

interface Harness {
    proxyPort: number;
    stop: () => Promise<void>;
    cleanup: () => void;
}

async function startProxy(upstreamPort: number, providers: Record<string, unknown>, injectTool = true): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-provider-protocol-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, JSON.stringify({ providers }), "utf8");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: loadRoutes(),
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool, injectNudge: false },
        promptCache: { routing: "auto" as const },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol" as const,
        updateTag: "latest",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        stop: async () => { await close(proxy); },
        cleanup: () => {
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
            rmrf(root);
        },
    };
}

const OPENAI_BODY = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "ping" }] });
const OPENAI_RESPONSE = {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

const ANTHROPIC_BODY = JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "ping" }] });
const ANTHROPIC_RESPONSE = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "pong" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 2 },
};

// ─── e2e: pipeline ownership ──────────────────────────────────────────────

test("protocol: path-scoped declaration makes a custom-path POST enter the pipeline (was verbatim passthrough)", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer(OPENAI_RESPONSE, (r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {
        [`http://127.0.0.1:${upstreamPort}/my/custom/complete`]: { protocol: "openai" },
    });
    try {
        const url = `http://127.0.0.1:${harness.proxyPort}/bili/http://127.0.0.1:${upstreamPort}/my/custom/complete`;
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: OPENAI_BODY });
        assert.equal(res.status, 200, "processed request must still reach the client cleanly");
        await res.text();
        assert.equal(seen.length, 1);
        assert.equal(seen[0].path, "/my/custom/complete");
        assert.ok(seen[0].headers["x-bili-hop"], "pipeline-processed requests carry the x-bili-hop marker — proof this was NOT a verbatim passthrough");
        const forwarded = JSON.parse(seen[0].body) as { tools?: Array<{ function?: { name?: string } }> };
        assert.ok(forwarded.tools?.some((t) => t.function?.name === "compress"), "declared-openai endpoint gets the compress tool injected");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("control: same custom path without any declaration stays a verbatim passthrough", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer(OPENAI_RESPONSE, (r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {});
    try {
        const url = `http://127.0.0.1:${harness.proxyPort}/bili/http://127.0.0.1:${upstreamPort}/my/custom/complete`;
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: OPENAI_BODY });
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(seen.length, 1);
        assert.equal(seen[0].headers["x-bili-hop"], undefined, "unrecognized path must stay a passthrough (no hop marker)");
        assert.equal(seen[0].body, OPENAI_BODY, "passthrough relays the original bytes untouched");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("protocol: host-level declaration inherits onto custom paths (a bare host key covers the whole subtree)", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer(OPENAI_RESPONSE, (r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {
        [`http://127.0.0.1:${upstreamPort}`]: { protocol: "openai" },
    });
    try {
        const url = `http://127.0.0.1:${harness.proxyPort}/bili/http://127.0.0.1:${upstreamPort}/some/unlisted/path`;
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: OPENAI_BODY });
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(seen.length, 1);
        assert.ok(seen[0].headers["x-bili-hop"], "host declaration owns every path under the host");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

const RESPONSES_BODY = JSON.stringify({
    model: "gpt-5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
});
const RESPONSES_RESPONSE = {
    id: "resp_test",
    object: "response",
    created_at: 1700000000,
    status: "completed",
    model: "gpt-5",
    output: [],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
};

test("protocol: a path-scoped declaration does not shadow the host key's OTHER settings (#1909)", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer(RESPONSES_RESPONSE, (r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {
        // Host key carries compressProtocol=marker (a Responses-protocol
        // flavor resolved from the ORIGIN); the path key declares the
        // protocol. BOTH must apply at once: pipeline-owned (hop marker) AND
        // marker-mode (no tools field) — the host entry is not shadowed.
        [`http://127.0.0.1:${upstreamPort}`]: { compressProtocol: "marker" },
        [`http://127.0.0.1:${upstreamPort}/my/custom/complete`]: { protocol: "responses" },
    });
    try {
        const url = `http://127.0.0.1:${harness.proxyPort}/bili/http://127.0.0.1:${upstreamPort}/my/custom/complete`;
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: RESPONSES_BODY });
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(seen.length, 1);
        assert.ok(seen[0].headers["x-bili-hop"], "path-declared protocol owns the request (pipeline)");
        const forwarded = JSON.parse(seen[0].body) as { tools?: Array<{ function?: { name?: string }; name?: string }> };
        const toolNames = (forwarded.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean) as string[];
        assert.ok(toolNames.includes("decompress"), "compress surface is present (read-only shape)");
        assert.ok(!toolNames.includes("compress"), "host key's compressProtocol=marker still applies (read-only tool set, no compress tool) — not shadowed");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("protocol: /bili/<protocol>/ explicit marker outranks the declaration", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer(OPENAI_RESPONSE, (r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {
        [`http://127.0.0.1:${upstreamPort}`]: { protocol: "anthropic" },
    });
    try {
        // The host declares anthropic, the URL marker says openai — the marker
        // must win: the openai-shaped body is processed as openai (hop marker
        // + tools), not #1284-verbatim-relayed as a non-anthropic body.
        const url = `http://127.0.0.1:${harness.proxyPort}/bili/openai/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: OPENAI_BODY });
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(seen.length, 1);
        assert.ok(seen[0].headers["x-bili-hop"], "the explicit /bili/ marker must win over the provider declaration");
        const forwarded = JSON.parse(seen[0].body) as { tools?: Array<{ function?: { name?: string } }> };
        assert.ok(forwarded.tools?.some((t) => t.function?.name === "compress"), "processed as openai (tools injected)");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("protocol: declared anthropic owns a custom path end-to-end", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer(ANTHROPIC_RESPONSE, (r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {
        [`http://127.0.0.1:${upstreamPort}/claude-bridge/complete`]: { protocol: "anthropic" },
    });
    try {
        const url = `http://127.0.0.1:${harness.proxyPort}/bili/http://127.0.0.1:${upstreamPort}/claude-bridge/complete`;
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: ANTHROPIC_BODY });
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(seen.length, 1);
        assert.ok(seen[0].headers["x-bili-hop"], "the anthropic pipeline owns the declared path");
        const forwarded = JSON.parse(seen[0].body) as { messages?: unknown };
        assert.ok(Array.isArray(forwarded.messages), "forwarded through the anthropic wire shape (messages preserved)");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("protocol: a GET without a body never becomes a declared protocol (POST-only, like the built-in table)", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer({ object: "list", data: [] }, (r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {
        [`http://127.0.0.1:${upstreamPort}`]: { protocol: "openai" },
    });
    try {
        const url = `http://127.0.0.1:${harness.proxyPort}/bili/http://127.0.0.1:${upstreamPort}/my/models`;
        const res = await fetch(url, { method: "GET" });
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(seen.length, 1);
        assert.equal(seen[0].headers["x-bili-hop"], undefined, "GETs stay passthrough even on a declared host");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});
