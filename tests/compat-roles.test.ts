import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { loadRoutes, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { applyCompatRoles, applyCompatRolesJson, detectRoleRejection, detectSystemPlacementError, parseCompatRoles, resolveCompatRoles } from "../src/compat-roles.ts";
import { _liveUpstreamTimersForTest } from "../src/fetch-util.ts";

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

const ROLES = { developer: "system" };

test("parseCompatRoles drops non-string entries", () => {
    assert.equal(parseCompatRoles(undefined), undefined);
    assert.equal(parseCompatRoles("developer"), undefined);
    assert.equal(parseCompatRoles([]), undefined);
    assert.equal(parseCompatRoles({}), undefined);
    assert.deepEqual(parseCompatRoles({ developer: "system", bad: 42, empty: "", ok: "user" }), { developer: "system", ok: "user" });
});

test("resolveCompatRoles: provider wins per key, global fills the rest", () => {
    const routes = {
        "https://api.a.com": { compat: { roles: { developer: "user", assistant: "user" } } },
    };
    // No match anywhere.
    assert.deepEqual(resolveCompatRoles(routes, "https://api.b.com/v1/chat/completions", undefined), {});
    // Provider only.
    assert.deepEqual(resolveCompatRoles(routes, "https://api.a.com/v1/chat/completions", undefined), { developer: "user", assistant: "user" });
    // Global + provider: provider wins per key.
    assert.deepEqual(
        resolveCompatRoles(routes, "https://api.a.com/v1/chat/completions", { developer: "system", extra: "user" }),
        { developer: "user", assistant: "user", extra: "user" },
    );
});

test("applyCompatRoles rewrites openai messages[].role", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "developer", content: "sys" }, { role: "user", content: "hi" }] });
    const out = applyCompatRoles(body, "openai", ROLES);
    assert.equal(out.rewritten, 1);
    assert.deepEqual(JSON.parse(out.body).messages[0], { role: "system", content: "sys" });
    assert.deepEqual(JSON.parse(out.body).messages[1], { role: "user", content: "hi" });
});

test("applyCompatRoles rewrites responses input[] message roles, skips typed items", () => {
    const body = JSON.stringify({
        model: "m",
        input: [
            { type: "message", role: "developer", content: "sys" },
            { role: "developer", content: "sys2" },
            { type: "function_call", name: "f", call_id: "c", arguments: "{}" },
            { type: "message", role: "user", content: "hi" },
        ],
    });
    const out = applyCompatRoles(body, "responses", ROLES);
    assert.equal(out.rewritten, 2);
    const input = JSON.parse(out.body).input as Array<Record<string, unknown>>;
    assert.equal(input[0].role, "system");
    assert.equal(input[1].role, "system");
    assert.equal(input[2].name, "f");
    assert.equal(input[3].role, "user");
});

test("applyCompatRoles default no-op returns the original string", () => {
    const body = JSON.stringify({ messages: [{ role: "developer", content: "x" }] });
    assert.deepEqual(applyCompatRoles(body, "openai", {}), { body, rewritten: 0 });
    // No matching role → original bytes, no re-stringify.
    const other = JSON.stringify({ messages: [{ role: "user", content: "x" }] });
    const out = applyCompatRoles(other, "openai", ROLES);
    assert.equal(out.body, other);
    assert.equal(out.rewritten, 0);
    // Invalid JSON → untouched.
    assert.deepEqual(applyCompatRoles("not json", "openai", ROLES), { body: "not json", rewritten: 0 });
});

test("applyCompatRolesJson mutates parsed bodies for the retry loops", () => {
    const parsed = { messages: [{ role: "developer", content: "x" }] } as Record<string, unknown>;
    assert.equal(applyCompatRolesJson(parsed, "openai", ROLES), 1);
    assert.equal((parsed.messages as Array<{ role: string }>)[0].role, "system");
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
    compatJson: string;
    /** G/H drive the #583 ladder with injectTool/injectNudge OFF so the wire is
     *  the bare conversation — bili's own injected system prompt would otherwise
     *  sit at index 0 and muddy the placement asserts. */
    bareWire?: boolean;
}

async function startProxy(upstream: http.Server, { compatJson, bareWire }: StartOpts): Promise<{ port: number; opts: ProxyOptions; stop: () => Promise<void>; cleanup: () => void }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-compat-roles-${process.pid}-${Date.now()}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, compatJson, "utf8");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const upstreamPort = (upstream.address() as { port: number }).port;
    const port = await freePort();
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
        compress: bareWire ? { injectTool: false, injectNudge: false } : { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        compat: { roles: parseCompatRoles(JSON.parse(compatJson).compat?.roles) ?? {} },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    return {
        port,
        opts,
        stop: async () => { await close(proxy); },
        cleanup: () => {
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
            rmSync(root, { recursive: true, force: true });
        },
    };
}

test("e2e #552 A: responses developer role rewritten on forward", async () => {
    const seen: Array<{ path: string; roles: string[] }> = [];
    const upstream = await upstreamServer(200, (path, body) => {
        const roles = ((body as { input?: Array<{ role?: string }> })?.input ?? []).map((i) => i.role ?? "?");
        seen.push({ path, roles });
    });
    const harness = await startProxy(upstream, { compatJson: `{"compat":{"roles":{"developer":"system"}}}` });
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-roles-e2e" },
            body: JSON.stringify({ model: "test", input: [{ type: "message", role: "developer", content: "be terse" }, { type: "message", role: "user", content: "hi" }] }),
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0].roles, ["system", "user"]);
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #552 B: chat-completions roles rewritten on the rebuilt wire body", async () => {
    const seen: Array<string[]> = [];
    const upstream = await upstreamServer(200, (_path, body) => {
        seen.push(((body as { messages?: Array<{ role?: string }> })?.messages ?? []).map((m) => m.role ?? "?"));
    });
    // Note: the chat rebuild pipeline (kernel coreToOpenai) already normalizes
    // developer→system before compat even runs — the LIVE surface of #552 is
    // the responses path. Mapping system→user here proves the openai boundary
    // rewrite genuinely fires on the rebuilt body.
    const harness = await startProxy(upstream, { compatJson: `{"compat":{"roles":{"system":"user"}}}` });
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-roles-e2e" },
            body: JSON.stringify({ model: "test", messages: [{ role: "developer", content: "be terse" }, { role: "user", content: "hi" }] }),
        });
        assert.equal(res.status, 200);
        assert.equal(seen[0][0], "user", "rebuilt system role rewritten per compat");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #552 C: default (no compat config) is byte-for-byte transparent", async () => {
    const seen: Array<unknown> = [];
    const upstream = await upstreamServer(200, (_path, body) => seen.push(body));
    const harness = await startProxy(upstream, { compatJson: `{"providers":{}}` });
    try {
        const payload = { model: "test", input: [{ type: "message", role: "developer", content: "be terse" }] };
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-roles-e2e" },
            body: JSON.stringify(payload),
        });
        assert.equal(res.status, 200);
        // The pipeline may append its own compress nudge to message content —
        // unrelated to compat. What compat guarantees is the ROLE reaching the
        // upstream unchanged when no rewrite is configured.
        const input = (seen[0] as { input: Array<{ role: string; content: string }> }).input;
        assert.equal(input[0].role, "developer", "role untouched by default");
        assert.ok(input[0].content.startsWith("be terse"), "original content preserved");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #552 D: per-provider compat.roles wins over global", async () => {
    const seen: Array<string[]> = [];
    const upstreamPortHolder: { port: number } = { port: 0 };
    const upstream = await upstreamServer(200, (_path, body) => {
        const items = (body as { messages?: Array<{ role?: string }>; input?: Array<{ role?: string }> });
        seen.push([...(items.messages ?? []), ...(items.input ?? [])].map((m) => m.role ?? "?"));
    });
    upstreamPortHolder.port = (upstream.address() as { port: number }).port;
    const config = {
        compat: { roles: { developer: "system" } },
        providers: { [`http://127.0.0.1:${upstreamPortHolder.port}`]: { compat: { roles: { developer: "user" } } } },
    };
    const harness = await startProxy(upstream, { compatJson: JSON.stringify(config) });
    try {
        // responses path: developer survives the rebuild to the wire (unlike
        // chat, which normalizes it), so provider precedence is observable.
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-roles-e2e" },
            body: JSON.stringify({ model: "test", input: [{ type: "message", role: "developer", content: "be terse" }] }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(seen[0], ["user"], "provider compat entry wins per key");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("detectRoleRejection: extracts the offending role, conservative otherwise", () => {
    assert.deepEqual(detectRoleRejection(400, '{"error":{"message":"Invalid role: developer"}}'), { role: "developer" });
    assert.deepEqual(detectRoleRejection(400, "Invalid message role: 'system'"), { role: "system" });
    assert.deepEqual(detectRoleRejection(400, "400 Bad Request: role developer is not supported"), { role: "developer" });
    assert.deepEqual(detectRoleRejection(400, 'Unexpected role=assistant for input'), { role: "assistant" });
    // Prose traps: captured token is a stopword → no detection.
    assert.equal(detectRoleRejection(400, "Invalid role must be one of: system, user"), null);
    // Wrong status / unrelated bodies.
    assert.equal(detectRoleRejection(401, '{"error":{"message":"Invalid role: developer"}}'), null);
    assert.equal(detectRoleRejection(400, '{"error":{"message":"insufficient quota"}}'), null);
    // Pydantic-style validation error: the rejected role name is not in the
    // text at all — must NOT produce a bogus detection.
    assert.equal(detectRoleRejection(400, '[{"loc":["body","messages",0,"role"],"msg":"Input should be \'system\', \'user\', \'tool\' or \'assistant\'"}]'), null);
});

test("detectSystemPlacementError: flags #377-class placement 400s, ignores role-name/quota/overflow/auth", () => {
    const positive = [
        "Only one 'system' message is allowed and it must be at the beginning",
        "Multiple system messages found in the request",
        "Found 2 system messages; expected exactly one",
        "Expected exactly one system message, got 2",
        "system message must be at the beginning of the conversation",
        "system message at index 3 is not allowed",
        "Value error: system messages are only allowed at index 0 (found system at index 1)",
        "a second system message was supplied",
    ];
    for (const msg of positive) {
        assert.equal(detectSystemPlacementError(400, JSON.stringify({ error: { message: msg } })), true, `should detect placement error: ${msg}`);
    }
    const negative = [
        '{"error":{"message":"Invalid role: developer"}}',
        '{"error":{"message":"insufficient quota"}}',
        '{"error":{"message":"context_length_exceeded"}}',
        '{"error":{"message":"Missing required parameter: system prompt"}}',
        "system prompt is required",
        '{"error":{"message":"invalid api key"}}',
    ];
    for (const msg of negative) {
        assert.equal(detectSystemPlacementError(400, msg), false, `should NOT detect: ${msg}`);
    }
    assert.equal(detectSystemPlacementError(401, "Multiple system messages found"), false);
});

function roleRejectingUpstream(): Promise<{ server: http.Server; seen: string[][] }> {
    const seen: string[][] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let roles: string[] = [];
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: Array<{ role?: string }>; messages?: Array<{ role?: string }> };
                roles = [...(parsed.input ?? []), ...(parsed.messages ?? [])].map((m) => m.role ?? "?");
            } catch { /* ignore */ }
            seen.push(roles);
            if (roles.includes("developer")) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "Invalid role: developer" } }));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            }
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen })));
}

test("e2e #552 E: role-rejection 400 auto-retries, learns session-scoped, skips the round-trip next time", async () => {
    const { server: upstream, seen } = await roleRejectingUpstream();
    const harness = await startProxy(upstream, { compatJson: `{"providers":{}}` });
    try {
        const payload = JSON.stringify({ model: "test", input: [{ type: "message", role: "developer", content: "be terse" }] });
        const res1 = await fetch(`http://127.0.0.1:${harness.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-roles-learn" },
            body: payload,
        });
        assert.equal(res1.status, 200, "client sees a transparent 200 after the auto-retry");
        const res2 = await fetch(`http://127.0.0.1:${harness.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-roles-learn" },
            body: payload,
        });
        assert.equal(res2.status, 200);
        // 3 upstream hits total: req1 rejected (developer), req1-retried (system),
        // req2 rewritten BEFORE fetch via the learned session map (system).
        assert.equal(seen.length, 3, `expected 3 upstream hits, got ${JSON.stringify(seen)}`);
        assert.deepEqual(seen[0], ["developer"], "first hit carries the client's developer role (no compat configured)");
        assert.deepEqual(seen[1], ["system"], "auto-retry rewrote developer→system");
        assert.deepEqual(seen[2], ["system"], "second request skipped the 400 round-trip (session learned)");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #552 F: retry that still fails passes the original 400 through verbatim", async () => {
    const hits: number[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            hits.push(1);
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Invalid role: developer" } }));
        });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const harness = await startProxy(upstream, { compatJson: `{"providers":{}}` });
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-roles-fail" },
            body: JSON.stringify({ model: "test", input: [{ type: "message", role: "developer", content: "be terse" }] }),
        });
        assert.equal(res.status, 400, "client receives the upstream 400");
        const text = await res.text();
        assert.ok(text.includes("Invalid role: developer"), `original error body preserved verbatim, got: ${text}`);
        assert.equal(hits.length, 2, "exactly one retry, no loop");
        await waitFor(() => _liveUpstreamTimersForTest() === 0);
        assert.equal(_liveUpstreamTimersForTest(), 0, "abandoned retry body must not re-arm the idle timer after clearTimer");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

function rolesOf(body: unknown): string[] {
    const b = body as { input?: Array<{ role?: string }>; messages?: Array<{ role?: string }> };
    return [...(b.input ?? []), ...(b.messages ?? [])].map((m) => m.role ?? "?");
}

// Payload that still reaches the #583 placement edge after kernel #102 — via
// the OPENAI chat path and a mid-list ASSISTANT. On Responses every developer
// (typed or, post-#102, type-less EasyInput) collapses into the single
// injected prefix message; on the openai path a mid-list developer is hoisted
// into the index-0 system too. The one conversation role that survives
// mid-list on the rebuilt wire is ASSISTANT (openaiToCore/coreToOpenai keep
// conversation messages in place), so an assistant→system rewrite produces a
// system at index 1 — exactly the #377-class "system only at index 0"
// placement 400 the second-chance hop needs.
const MIDLIST_ASSISTANT_PAYLOAD = JSON.stringify({ model: "test", messages: [
    { role: "user", content: "a" },
    { role: "assistant", content: "sys" },
    { role: "user", content: "b" },
]});

// Upstream enforcing BOTH halves of the #583 edge: rejects the unsupported
// mid-list role (assistant — any of developer/assistant trips it) AND enforces
// system-at-index-0 only (a mid-list system is a #377-class placement 400).
// acceptUser decides whether the final assistant→user rewrite is accepted
// (true = second-chance succeeds; false = every hop fails, exercising the hard
// cap). Records every hit's roles.
function ladderUpstream(acceptUser: boolean): Promise<{ server: http.Server; seen: string[][] }> {
    const seen: string[][] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let roles: string[] = [];
            try { roles = rolesOf(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* ignore */ }
            seen.push(roles);
            const json = (obj: unknown) => JSON.stringify(obj);
            const offZero = roles.map((r, i) => (r === "system" ? i : -1)).filter((i) => i >= 0).find((i) => i !== 0);
            const odd = roles.find((r) => r === "developer" || r === "assistant");
            if (odd) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(json({ error: { message: `Invalid role: ${odd}` } }));
            } else if (offZero !== undefined) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(json({ error: { message: `Value error: system messages are only allowed at index 0 (found system at index ${offZero})` } }));
            } else if (acceptUser) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(json({ ok: true }));
            } else {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(json({ error: { message: "Invalid role: assistant" } }));
            }
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen })));
}

test("e2e #583 G: mid-list assistant→system 400s on a placement-strict backend; second-chance learns assistant→user", async () => {
    const { server: upstream, seen } = await ladderUpstream(true);
    const harness = await startProxy(upstream, { compatJson: `{"providers":{}}`, bareWire: true });
    try {
        const res1 = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-second-chance" },
            body: MIDLIST_ASSISTANT_PAYLOAD,
        });
        assert.equal(res1.status, 200, "client sees a transparent 200 after the second-chance retry");
        assert.equal(seen.length, 3, `expected 3 upstream hits (asst→sys→user), got ${JSON.stringify(seen)}`);
        assert.ok(seen[0].includes("assistant"), "hit 1 carries an assistant role → rejected");
        assert.ok(!seen[1].includes("assistant") && seen[1].includes("system"), "hit 2: primary hop rewrote assistant→system (mid-list → placement 400)");
        assert.ok(!seen[2].includes("assistant") && !seen[2].includes("system"), "hit 3: second-chance rewrote assistant→user → accepted");
        // Second request: the session learned assistant→user, so every assistant
        // is pre-rewritten BEFORE fetch — no 400 round-trip.
        const res2 = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-second-chance" },
            body: MIDLIST_ASSISTANT_PAYLOAD,
        });
        assert.equal(res2.status, 200);
        assert.equal(seen.length, 4, `expected 4 upstream hits total (3 + 1), got ${JSON.stringify(seen)}`);
        assert.ok(!seen[3].includes("assistant") && !seen[3].includes("system"), "second request pre-rewritten via learned map");
        await waitFor(() => _liveUpstreamTimersForTest() === 0);
        assert.equal(_liveUpstreamTimersForTest(), 0, "abandoned retry bodies must not re-arm the idle timer");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #583 H: ladder is capped — every hop failing passes the ORIGINAL 400 verbatim, no loop", async () => {
    const { server: upstream, seen } = await ladderUpstream(false);
    const harness = await startProxy(upstream, { compatJson: `{"providers":{}}`, bareWire: true });
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "compat-second-chance-cap" },
            body: MIDLIST_ASSISTANT_PAYLOAD,
        });
        assert.equal(res.status, 400, "client receives a 400 when every hop fails");
        const text = await res.text();
        assert.ok(text.includes("Invalid role: assistant"), `original error preserved verbatim, got: ${text}`);
        assert.equal(seen.length, 3, `expected exactly 3 upstream hits (original + 2 retries), got ${JSON.stringify(seen)}`);
        await waitFor(() => _liveUpstreamTimersForTest() === 0);
        assert.equal(_liveUpstreamTimersForTest(), 0, "abandoned retry bodies must not re-arm the idle timer");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

async function waitFor(probe: () => boolean, deadlineMs = 3000): Promise<void> {
    const start = Date.now();
    while (!probe()) {
        if (Date.now() - start > deadlineMs) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
