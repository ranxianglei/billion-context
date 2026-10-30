import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { isModelTrafficOriginFormPath, startServer, type ProxyOptions } from "../src/server.ts";
import { loadRoutes } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getRefusedForeignPathStats, logRefusedForeignPath } from "../src/server/observability.js";
import { rmrf } from "./tmp-rm.ts";

// #5211 regression suite: an origin-form request to a path that is neither a
// model API shape nor a declared destination must be refused LOCALLY (404),
// never spliced onto the configured upstream — before this fix the caller's
// private payload (e.g. a host's local /api/dsh-im/delivery/messages body) was
// forwarded verbatim to api.anthropic.com and left the machine.

// ─── unit: isModelTrafficOriginFormPath ────────────────────────────────────

for (const p of [
    "/v1/messages", "/messages", "/messages/", "/v2/messages", "/v1/messages?beta=1",
    "/v1/messages/count_tokens", "/messages/count_tokens",
    "/v1/chat/completions", "/chat/completions",
    "/llm_raw_chat", "/v1/llm_raw_chat",
    "/v1/responses", "/responses", "/responses/compact",
    "/models", "/v1/models", "/models?limit=20",
    "/v1beta/models/gemini-x:generateContent",
    "/v1beta/models/gemini-x:streamGenerateContent?alt=sse",
    "/v1beta/models/gemini-x:countTokens",
    "/v1/projects/p/locations/l/publishers/anthropic/models/m:rawPredict",
    "/v1/projects/p/locations/l/publishers/anthropic/models/m:streamRawPredict",
]) {
    test(`isModelTrafficOriginFormPath: allows ${p}`, () => {
        assert.equal(isModelTrafficOriginFormPath(p), true);
    });
}

for (const p of [
    "/api/dsh-im/delivery/messages", // THE issue repro — trailing /messages on a foreign base
    "/api/dsh-im/delivery/models", // trailing /models must NOT read as discovery (not root-anchored)
    "/api/v1/event/report", // telemetry-class path (#362)
    "/v1/files", "/v1/embeddings",
    "/x/v1/messages", // prefixed base — needs a providers.* declaration
    "/internal/tools/chat/completions",
    "", "/", "/totally-unknown-xyz",
]) {
    test(`isModelTrafficOriginFormPath: refuses ${p || "(empty)"}`, () => {
        assert.equal(isModelTrafficOriginFormPath(p), false);
    });
}

// ─── unit: refusal log rate limit + stats ──────────────────────────────────

test("logRefusedForeignPath: warns on first 3, one info suppression notice, then silent; query does not split keys", () => {
    const calls: Array<{ level: string; msg: string }> = [];
    const log = (level: string, msg: string) => { calls.push({ level, msg }); };
    for (let i = 0; i < 5; i++) logRefusedForeignPath(log, "/issue5211/unit-rate/a");
    assert.deepEqual(calls.map((c) => c.level), ["warn", "warn", "warn", "info"]);
    assert.ok(calls[0].msg.includes("refused foreign path /issue5211/unit-rate/a locally (404)"));

    logRefusedForeignPath(log, "/issue5211/unit-q/x?ts=1");
    logRefusedForeignPath(log, "/issue5211/unit-q/x?ts=2");
    const stats = getRefusedForeignPathStats();
    assert.equal(stats.paths["/issue5211/unit-q/x"], 2, "varying query stays one key");
    assert.equal(stats.paths["/issue5211/unit-rate/a"], 5);
});

// ─── e2e harness ────────────────────────────────────────────────────────────

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface SeenRequest {
    path: string;
    body: string;
    headers: http.IncomingHttpHeaders;
}

function upstreamServer(onRequest: (req: SeenRequest) => void): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            onRequest({ path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

interface Harness {
    proxyPort: number;
    stop: () => Promise<void>;
    cleanup: () => void;
}

async function startProxy(upstreamPort: number, providers: Record<string, unknown>, passthrough = false): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-issue5211-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" as const },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough,
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

const DELIVERY_BODY = JSON.stringify({ botId: "bot-1", targetId: "target-1", text: "local-only message" });
const OPENAI_BODY = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "ping" }] });
const ANTHROPIC_BODY = JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "ping" }] });

// ─── e2e: the issue repro and its neighbors ────────────────────────────────

test("#5211 repro: POST /api/dsh-im/delivery/messages is refused locally — body never reaches the upstream", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer((r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {});
    try {
        const res = await fetch(`http://127.0.0.1:${harness.proxyPort}/api/dsh-im/delivery/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: DELIVERY_BODY,
        });
        assert.equal(res.status, 404);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        assert.equal(json.error?.type, "unknown_upstream_path");
        assert.ok(json.error?.message?.includes("/bili/<full-upstream-url>"), "error tells the caller how to reach model traffic");
        assert.equal(seen.length, 0, "the private payload must not be forwarded anywhere");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("#5211: GET foreign path is refused locally too, and both refusals surface in stats", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer((r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {});
    try {
        const r1 = await fetch(`http://127.0.0.1:${harness.proxyPort}/some/other/private`, { method: "GET" });
        assert.equal(r1.status, 404);
        await r1.text();

        const r2 = await fetch(`http://127.0.0.1:${harness.proxyPort}/api/dsh-im/delivery/messages?x=1`, { method: "POST", body: DELIVERY_BODY });
        assert.equal(r2.status, 404);
        await r2.text();

        assert.equal(seen.length, 0);
        const stats = getRefusedForeignPathStats();
        assert.ok(stats.paths["/some/other/private"], "GET refusal counted");
        assert.ok(stats.paths["/api/dsh-im/delivery/messages"], "query-stripped key counted");

        const adminRes = await fetch(`http://127.0.0.1:${harness.proxyPort}/__bili/stats`);
        assert.equal(adminRes.status, 200);
        const adminJson = (await adminRes.json()) as { refusedForeignPaths?: { total: number; paths: Record<string, number> } };
        assert.ok(adminJson.refusedForeignPaths?.paths["/some/other/private"], "admin stats expose refusedForeignPaths");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

// ─── e2e: model traffic is untouched ───────────────────────────────────────

test("control: POST /v1/messages still enters the pipeline (hop marker present)", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer((r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {});
    try {
        const res = await fetch(`http://127.0.0.1:${harness.proxyPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "i5211-ant" },
            body: ANTHROPIC_BODY,
        });
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(seen.length, 1);
        assert.ok(seen[0].headers["x-bili-hop"], "processed pipeline request carries the hop marker");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("control: POST /v1/chat/completions still enters the pipeline (hop marker present)", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer((r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {});
    try {
        const res = await fetch(`http://127.0.0.1:${harness.proxyPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "i5211-oai" },
            body: OPENAI_BODY,
        });
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(seen.length, 1);
        assert.ok(seen[0].headers["x-bili-hop"]);
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("control: GET /v1/models discovery still forwards verbatim (no hop marker)", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer((r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {});
    try {
        const res = await fetch(`http://127.0.0.1:${harness.proxyPort}/v1/models`, { method: "GET" });
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(seen.length, 1);
        assert.equal(seen[0].path, "/v1/models");
        assert.equal(seen[0].headers["x-bili-hop"], undefined, "verbatim discovery has no hop marker");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("control: vertex anthropic rawPredict origin-form still forwards (path-carried model shape)", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer((r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {});
    try {
        const res = await fetch(`http://127.0.0.1:${harness.proxyPort}/v1/projects/p/locations/l/publishers/anthropic/models/m:rawPredict`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ anthropic_version: "vertex-2023-10-16", max_tokens: 10, messages: [{ role: "user", content: "ping" }] }),
        });
        assert.equal(res.status, 200, "vertex shape must not be refused by the new gate");
        await res.text();
        assert.equal(seen.length, 1);
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

// ─── e2e: escape hatches keep their behavior ───────────────────────────────

test("escape hatch: providers.* declaration admits an exotic origin-form path as verbatim relay", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer((r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, { [`http://127.0.0.1:${upstreamPort}/my/custom/complete`]: {} });
    try {
        const res = await fetch(`http://127.0.0.1:${harness.proxyPort}/my/custom/complete`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: OPENAI_BODY,
        });
        assert.equal(res.status, 200, "declared destination is exempt from the refusal");
        await res.text();
        assert.equal(seen.length, 1);
        assert.equal(seen[0].path, "/my/custom/complete");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("escape hatch: x-bili-passthrough mark relays an unknown path verbatim (#1117)", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer((r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {});
    try {
        const res = await fetch(`http://127.0.0.1:${harness.proxyPort}/marked/private/path`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-passthrough": "1" },
            body: DELIVERY_BODY,
        });
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(seen.length, 1);
        assert.equal(seen[0].body, DELIVERY_BODY, "byte-untouched relay");
        assert.equal(seen[0].headers["x-bili-hop"], undefined);
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("escape hatch: x-bili-hop chain skip relays an unknown path verbatim (#300)", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer((r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {});
    try {
        const res = await fetch(`http://127.0.0.1:${harness.proxyPort}/hopped/path`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-hop": "1" },
            body: OPENAI_BODY,
        });
        assert.equal(res.status, 200);
        await res.text();
        assert.equal(seen.length, 1);
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("escape hatch: global passthrough mode forwards everything (design intent)", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer((r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {}, true);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.proxyPort}/global/passthrough/path`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: DELIVERY_BODY,
        });
        assert.equal(res.status, 200, "passthrough mode relays by design — the gate must not fire there");
        await res.text();
        assert.equal(seen.length, 1);
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("control: zero-config /bili/<full-url> tunnel is unchanged for an undeclared custom path", async () => {
    const seen: SeenRequest[] = [];
    const upstream = await upstreamServer((r) => seen.push(r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const harness = await startProxy(upstreamPort, {});
    try {
        const url = `http://127.0.0.1:${harness.proxyPort}/bili/http://127.0.0.1:${upstreamPort}/my/custom/complete`;
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: OPENAI_BODY });
        assert.equal(res.status, 200, "routed form carries its own destination — the gate must not touch it");
        await res.text();
        assert.equal(seen.length, 1);
        assert.equal(seen[0].path, "/my/custom/complete");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});
