import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { apply, _resetRegisterForTest } from "../src/agent/dsh-native.ts";
import { rmrf } from "./tmp-rm.ts";

// The node:test runner sets NODE_TEST_CONTEXT itself (see tests/e2e/README.md);
// set it defensively so a direct single-file run also stands down the spawn
// bootstrap and the global fetch intercept (the relay handler must exercise
// the REAL fetch — that is the hop the admin gate sees).
process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT ?? "1";

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const prev: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
        prev[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return await fn();
    } finally {
        for (const [key, value] of Object.entries(prev)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

type RouteRow = { kind: string; path: string; handler: (req: unknown, res: RelayRes) => void | Promise<void> };

class RelayRes {
    status?: number;
    headers?: Record<string, string>;
    chunks: string[] = [];
    writeHead(status: number, headers?: Record<string, string>): void {
        this.status = status;
        this.headers = headers;
    }
    write(chunk: string | Uint8Array): boolean {
        this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
    }
    end(body?: string | Uint8Array): void {
        if (body !== undefined) this.chunks.push(typeof body === "string" ? body : Buffer.from(body).toString("utf8"));
    }
    get body(): string {
        return this.chunks.join("");
    }
}

function fakeReq(method: string, url: string, headers: Record<string, string>, bodyChunks: string[] = []): unknown {
    return {
        method,
        url,
        headers,
        async *[Symbol.asyncIterator]() {
            for (const chunk of bodyChunks) yield chunk;
        },
    };
}

/** A browser admin call as it arrives on the dsh entry: the browser's Origin
 *  and cookies describe the ENTRY, not the proxy — the relay must drop both
 *  so the forwarded hop reads as a local non-browser client (#1538 gate). */
const browserHeaders = (): Record<string, string> => ({
    "content-type": "application/json",
    host: "dsh.example:443",
    origin: "https://dsh.example",
    cookie: "dsh-session=secret",
    referer: "https://dsh.example/settings",
    "user-agent": "relay-test",
});

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

function startAdminStub(): Promise<{ origin: string; seen: Seen[]; close: () => void }> {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => {
            body += c.toString("utf8");
        });
        req.on("end", () => {
            seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
            if ((req.url ?? "").startsWith("/__bili/config")) {
                res.writeHead(200, { "content-type": "application/json", "x-bili-relay": "yes" });
                res.end(JSON.stringify({ ok: true, echoed: body }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end("{}");
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            resolve({ origin: `http://127.0.0.1:${port}`, seen, close: () => server.close() });
        });
    });
}

function collectRoutes(): RouteRow[] {
    const routes: RouteRow[] = [];
    const ctx = {
        tools: { register: (_t: unknown) => {} },
        commands: { register: (_c: unknown) => {} },
        agents: { currentInitiator: () => ({ session: { id: "s-3373" } }) },
        inject: (_deps: readonly string[], cb: (sub: unknown) => void) => {
            cb({ webServer: { register: (r: RouteRow) => routes.push(r) } });
        },
        on: (_event: string, _listener: unknown) => {},
    };
    apply(ctx as Parameters<typeof apply>[0]);
    return routes;
}

function relayRoute(routes: RouteRow[]): RouteRow {
    const route = routes.find((r) => r.path === "/__bili");
    assert.ok(route !== undefined, "the /__bili prefix route must be registered");
    assert.equal(route.kind, "prefix");
    return route;
}

function writeConfig(home: string, body: string): string {
    const file = path.join(home, "bili-config.json");
    fs.writeFileSync(file, body);
    return file;
}

test("#3373: the admin relay stays fail-closed while security.adminRelay is off — even with a bound proxy and the route mounted", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-relay-"));
    try {
        // register.base points at a port with nothing listening: if the relay
        // ever left the fail-closed branch it would 502, not 404.
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: writeConfig(home, "{}") }, async () => {
            _resetRegisterForTest("http://127.0.0.1:1");
            const route = relayRoute(collectRoutes());
            const res = new RelayRes();
            await route.handler(fakeReq("GET", "/__bili/config", browserHeaders()), res);
            assert.equal(res.status, 404);
            assert.deepEqual(JSON.parse(res.body), { error: "admin relay disabled" });
        });
    } finally {
        rmrf(home);
    }
});

test("#3373: with the gate on but no proxy bound, the relay answers 503 instead of pretending", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-relay-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: writeConfig(home, JSON.stringify({ security: { adminRelay: true } })) }, async () => {
            _resetRegisterForTest(undefined);
            const route = relayRoute(collectRoutes());
            const res = new RelayRes();
            await route.handler(fakeReq("GET", "/__bili/config", browserHeaders()), res);
            assert.equal(res.status, 503);
            assert.deepEqual(JSON.parse(res.body), { error: "bili proxy not running" });
        });
    } finally {
        rmrf(home);
    }
});

test("#3373: gate on + proxy bound — the relay forwards to loopback as a local non-browser client (no Origin/Cookie/Referer, fetch-derived loopback Host), passes method/url/body/status/headers through, and streams the response", async () => {
    const stub = await startAdminStub();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-relay-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: writeConfig(home, JSON.stringify({ security: { adminRelay: true } })) }, async () => {
            _resetRegisterForTest(stub.origin);
            const route = relayRoute(collectRoutes());

            const get = new RelayRes();
            await route.handler(fakeReq("GET", "/__bili/config", browserHeaders()), get);
            assert.equal(get.status, 200);
            assert.equal(get.headers?.["content-type"], "application/json");
            assert.equal(get.headers?.["x-bili-relay"], "yes");
            assert.equal(JSON.parse(get.body).ok, true);

            const post = new RelayRes();
            await route.handler(fakeReq("POST", "/__bili/config", browserHeaders(), ["{", '"a":1}']), post);
            assert.equal(post.status, 200);
            assert.equal(JSON.parse(post.body).echoed, '{"a":1}', "request body rides through byte-exact");

            // apply() also probes the bound proxy (manifest/liveness) — count
            // only the relayed admin calls.
            const admin = stub.seen.filter((h) => h.url.startsWith("/__bili/config"));
            assert.equal(admin.length, 2);
            const first = admin[0];
            assert.equal(first.method, "GET");
            assert.equal(first.url, "/__bili/config", "the full /__bili path is preserved");
            const second = admin[1];
            assert.equal(second.method, "POST");
            assert.equal(second.body, '{"a":1}');
            for (const hit of [first, second]) {
                assert.equal(hit.headers.host, new URL(stub.origin).host, "Host is the fetch-derived loopback host, not the browser's entry host");
                assert.equal(hit.headers.origin, undefined, "the browser's Origin header must not reach the admin gate");
                assert.equal(hit.headers.cookie, undefined, "entry cookies must not leak into the proxy");
                assert.equal(hit.headers.referer, undefined);
                assert.equal(hit.headers["user-agent"], "relay-test", "ordinary headers ride through");
            }
        });
    } finally {
        stub.close();
        rmrf(home);
    }
});

test("#3373: an unreachable proxy behind the gate surfaces as 502 JSON, not a crash", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-relay-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: writeConfig(home, JSON.stringify({ security: { adminRelay: true } })) }, async () => {
            _resetRegisterForTest("http://127.0.0.1:1");
            const route = relayRoute(collectRoutes());
            const res = new RelayRes();
            await route.handler(fakeReq("GET", "/__bili/config", browserHeaders()), res);
            assert.equal(res.status, 502);
            assert.deepEqual(JSON.parse(res.body), { error: "bili proxy unreachable" });
        });
    } finally {
        rmrf(home);
    }
});

test("#3373 review: dot-segment traversal is contained — literal and %2e-encoded \"..\" are rejected with 400 and never reach the proxy", async () => {
    const stub = await startAdminStub();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-relay-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: writeConfig(home, JSON.stringify({ security: { adminRelay: true } })) }, async () => {
            _resetRegisterForTest(stub.origin);
            const route = relayRoute(collectRoutes());
            // apply() itself probes the bound proxy — baseline after mount so
            // only relay hops are counted.
            const baseline = stub.seen.length;
            for (const url of ["/__bili/../__acp/sessions", "/__bili/%2e%2e/config", "/__bili/a/../../status"]) {
                const res = new RelayRes();
                await route.handler(fakeReq("GET", url, browserHeaders()), res);
                assert.equal(res.status, 400, url);
                assert.deepEqual(JSON.parse(res.body), { error: "bad request path" });
            }
            assert.equal(stub.seen.length, baseline, "rejected paths must not produce any upstream hop");
        });
    } finally {
        stub.close();
        rmrf(home);
    }
});

test("#3373 review: gate off + proxy unbound still presents 404 (fail-closed beats state disclosure)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-relay-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: writeConfig(home, "{}") }, async () => {
            _resetRegisterForTest(undefined);
            const route = relayRoute(collectRoutes());
            const res = new RelayRes();
            await route.handler(fakeReq("GET", "/__bili/config", browserHeaders()), res);
            assert.equal(res.status, 404);
            assert.deepEqual(JSON.parse(res.body), { error: "admin relay disabled" });
        });
    } finally {
        rmrf(home);
    }
});

test("#3373 review: oversized bodies are rejected with 413 before any upstream hop", async () => {
    const stub = await startAdminStub();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-relay-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: writeConfig(home, JSON.stringify({ security: { adminRelay: true } })) }, async () => {
            _resetRegisterForTest(stub.origin);
            const route = relayRoute(collectRoutes());
            const baseline = stub.seen.length;
            const res = new RelayRes();
            // 8 MiB cap + 1 byte (RELAY_MAX_BODY_BYTES in dsh-native.ts)
            await route.handler(fakeReq("POST", "/__bili/config", browserHeaders(), ["x".repeat(8 * 1024 * 1024 + 1)]), res);
            assert.equal(res.status, 413);
            assert.deepEqual(JSON.parse(res.body), { error: "request body too large" });
            assert.equal(stub.seen.length, baseline, "an oversized body must not be forwarded");
        });
    } finally {
        stub.close();
        rmrf(home);
    }
});
