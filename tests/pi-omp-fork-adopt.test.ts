import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type CoreMessage } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { incomingCoreMessages } from "../src/fork-adoption.ts";
import { anthropicBodyToCore, chatBodyToCore, createForkAdopter, forkIdentityHashOf, openaiBodyToCore, resetForkCapabilityCacheForTest, responsesBodyToCore, tryForkAdoption, type ForkAdoptInput } from "../src/agent/fork-adopt.ts";
import { FORK_SEED_MIN_REPLAYED_MESSAGES, createBiliPlugin, replayedMessageCount } from "../src/agent/pi.ts";
import { closeServers } from "./server-close-guard.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-piomp-fork-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const anthropicBody = {
    model: "claude-test",
    system: "system prompt",
    max_tokens: 1024,
    messages: [
        { role: "user", content: [{ type: "text", text: "first original " }] },
        { role: "assistant", content: [{ type: "text", text: "second original " }, { type: "tool_use", id: "tu-1", name: "run", input: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "tool output" }] },
        { role: "user", content: [{ type: "text", text: "tail original" }] },
    ],
};

test("anthropicBodyToCore projects identically to the server's incomingCoreMessages anthropic branch (#2399 parity)", () => {
    const client = anthropicBodyToCore(anthropicBody);
    const server = incomingCoreMessages("anthropic", anthropicBody);
    assert.notEqual(client, null);
    assert.notEqual(server, null);
    assert.equal(client!.length, server!.length);
    for (let i = 0; i < client!.length; i += 1) {
        assert.equal(forkIdentityHashOf(client![i]!), forkIdentityHashOf(server![i]!), `message ${i} identity diverged`);
    }
    assert.equal(client![0]!.role, "user");
    assert.equal(client!.some((m) => m.role === "system"), false, "leading system stays hoisted out of the fold space");
});

test("chatBodyToCore discriminates the dialects; only google stays unprojected (#2399/#2469)", () => {
    assert.notEqual(chatBodyToCore({ messages: [{ role: "user", content: "hi" }] }), null, "openai projects");
    assert.notEqual(chatBodyToCore(anthropicBody), null, "anthropic projects");
    assert.notEqual(chatBodyToCore({ model: "gpt", input: [{ type: "message", role: "user", content: "hi" }] }), null, "responses projects");
    assert.deepEqual(chatBodyToCore({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }), null, "google skipped");
    const openai = { messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] };
    assert.equal(chatBodyToCore(openai)!.length, openaiBodyToCore(openai)!.length, "openai keeps the stage-1 projection");
});

// #2469 regression coverage (issue checklist): plain text, function
// call/output, raw ids and identity hashes must match the server's pipeline —
// "仅增加'支持'分支或借用文本字段不足以证明继承正确". The corpus exercises
// every pre-projection mutation the replicas carry.
test("responsesBodyToCore projects identically to the server's incomingCoreMessages responses branch (#2469 parity)", () => {
    const corpus = [
        // plain-text user/assistant turns
        [
            { type: "message", role: "user", content: "first original " },
            { type: "message", role: "assistant", content: "second original " },
            { type: "message", role: "user", content: "tail original" },
        ],
        // function call + output round-trip (raw call id must survive both sides)
        [
            { type: "message", role: "user", content: "check the weather" },
            { type: "function_call", name: "get_weather", arguments: "{\"city\":\"SF\"}", call_id: "call-1" },
            { type: "function_call_output", call_id: "call-1", output: "sunny, 18C" },
            { type: "message", role: "assistant", content: "It is sunny." },
        ],
        // omp untyped user item + whitespace-only delta + bili-id healing
        [
            { role: "user", content: "untyped omp prompt" },
            { type: "message", role: "assistant", content: "   \t  " },
            { type: "message", role: "assistant", id: `msg-proxy-${"x".repeat(80)}`, content: "healed reply" },
            { type: "reasoning", id: `msg-proxy-${"y".repeat(80)}`, summary: [] },
        ],
        // bili compaction echo: sentinel blob → handoff message; marker-only → drop
        [
            { type: "compaction", id: "fc_bili-abc", encrypted_content: "bili:acp:folded head summary" },
            { type: "compaction", id: "fc_bili-old" },
            { type: "message", role: "user", content: "post-compaction turn" },
        ],
        // mixed content parts (input_text / output_text / text)
        [
            { type: "message", role: "user", content: [{ type: "input_text", text: "part one " }, { type: "text", text: "part two" }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "mixed parts reply" }] },
        ],
    ];
    for (let i = 0; i < corpus.length; i += 1) {
        const body = { model: "gpt-test", input: corpus[i] };
        const client = responsesBodyToCore(body);
        const server = incomingCoreMessages("responses", body);
        assert.notEqual(client, null, `corpus ${i}: client projected`);
        assert.notEqual(server, null, `corpus ${i}: server projected`);
        assert.equal(client!.length, server!.length, `corpus ${i}: message count diverged`);
        for (let j = 0; j < client!.length; j += 1) {
            assert.equal(forkIdentityHashOf(client![j]!), forkIdentityHashOf(server![j]!), `corpus ${i} message ${j} identity diverged`);
        }
    }
});

type CtxShape = Parameters<typeof replayedMessageCount>[0];

test("replayedMessageCount counts only conversation entries and fails soft (#2469)", () => {
    const base = (sm: unknown): CtxShape => ({ sessionManager: sm } as CtxShape);
    assert.equal(replayedMessageCount(base(undefined)), undefined, "no sessionManager");
    assert.equal(replayedMessageCount(base({})), undefined, "no getBranch");
    assert.equal(replayedMessageCount(base({ getBranch: () => "not-an-array" })), undefined);
    assert.equal(replayedMessageCount(base({ getBranch: () => { throw new Error("boom"); } })), undefined);
    const branch = [
        { type: "message", message: { role: "user", content: "a" } },
        { type: "compaction", firstKeptEntryId: "x" },
        { type: "label", label: "y" },
        { type: "message", message: { role: "assistant", content: "b" } },
        { type: "branch_summary", summary: "z" },
    ];
    assert.equal(replayedMessageCount(base({ getBranch: () => branch })), 2, "only type==='message' entries count");
});

// ---------------------------------------------------------------------------
// createForkAdopter coordinator: gate/skip matrix, once-per-child, single
// flight — with a recording fake fetch.
// ---------------------------------------------------------------------------

type Recorded = { method: string; url: string; body?: unknown };
function fakeFetchRouting(routes: Array<{ match: (call: Recorded) => boolean; respond: () => Response | Promise<Response> }>): { fetchImpl: typeof fetch; calls: Recorded[] } {
    const calls: Recorded[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const call: Recorded = { method: init?.method ?? "GET", url };
        if (typeof init?.body === "string") call.body = JSON.parse(init.body);
        calls.push(call);
        for (const route of routes) {
            if (route.match(call)) return await route.respond();
        }
        return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

const manifestRoute = { match: (c: Recorded) => c.url.endsWith("/__bili/plugin/manifest"), respond: () => Response.json({ capabilities: { fork: { protocolVersion: 1 } } }) };
const snapshotRoute = { match: (c: Recorded) => c.url.includes("/__bili/plugin/snapshot"), respond: () => Response.json({ ok: true, protocolVersion: 1, status: "exact", parentRevision: hash("rev1"), orderHash: hash("full"), orderedMessages: [{ rawId: "a", ref: "m00001", identityHash: "x1" }] }) };
const forkRoute = { match: (c: Recorded) => c.url.endsWith("/__bili/plugin/fork"), respond: () => new Response(JSON.stringify({ ok: true }), { status: 201 }) };

const adoptInput = (over: Partial<ForkAdoptInput> = {}): ForkAdoptInput => ({ base: "http://px", parent: "p1", child: "c1", body: { messages: [{ role: "user", content: "hi" }] }, ...over });

test("createForkAdopter skips without consuming anything on ineligible input", async () => {
    const { fetchImpl, calls } = fakeFetchRouting([manifestRoute, snapshotRoute, forkRoute]);
    const adopter = createForkAdopter(() => undefined, { fetchImpl });
    await adopter.maybeAdopt(undefined);
    await adopter.maybeAdopt(adoptInput({ parent: "c1" }));
    await adopter.maybeAdopt(adoptInput({ parent: "" }));
    await adopter.maybeAdopt(adoptInput({ child: "" }));
    await adopter.maybeAdopt(adoptInput({ base: "" }));
    // A body-less request (opencode V2 ws handshake's synthetic Request) must
    // not burn an attempt slot: repeated handshakes would otherwise close the
    // window before the first real model request (#2403 review).
    for (let i = 0; i < 5; i += 1) await adopter.maybeAdopt(adoptInput({ body: undefined }));
    assert.equal(calls.length, 0);
    const after = adoptInput();
    await adopter.maybeAdopt(after);
    assert.ok(calls.some((c) => c.url.includes("snapshot")), "the window is still open for the first real body");
});

test("createForkAdopter marks done on manifest-incapable proxies and never refetches", async () => {
    resetForkCapabilityCacheForTest();
    const { fetchImpl, calls } = fakeFetchRouting([{ match: manifestRoute.match, respond: () => Response.json({ capabilities: {} }) }]);
    const lines: string[] = [];
    const adopter = createForkAdopter((l) => lines.push(l), { fetchImpl });
    await adopter.maybeAdopt(adoptInput());
    await adopter.maybeAdopt(adoptInput());
    assert.equal(calls.filter((c) => c.url.includes("manifest")).length, 1, "manifest probed once");
    assert.equal(calls.filter((c) => c.url.includes("snapshot") || c.url.includes("fork")).length, 0);
    assert.ok(lines.some((l) => l.includes("does not advertise the fork capability")));
});

test("createForkAdopter degrades once on prefix mismatch and stays done", async () => {
    resetForkCapabilityCacheForTest();
    const { fetchImpl, calls } = fakeFetchRouting([manifestRoute, snapshotRoute, forkRoute]);
    const lines: string[] = [];
    const adopter = createForkAdopter((l) => lines.push(l), { fetchImpl });
    // The snapshot identity hash "x1" matches nothing in the openai projection
    // of this body (ids differ), so branchPoint === 0 → degrade, no fork POST.
    await adopter.maybeAdopt(adoptInput());
    await adopter.maybeAdopt(adoptInput());
    assert.equal(calls.filter((c) => c.url.includes("snapshot")).length, 1);
    assert.equal(calls.filter((c) => c.url.endsWith("/__bili/plugin/fork")).length, 0);
    assert.ok(lines.some((l) => l.includes("degraded (no prefix match)")));
});

test("createForkAdopter ends google children before any network request (#2469)", async () => {
    resetForkCapabilityCacheForTest();
    const { fetchImpl, calls } = fakeFetchRouting([manifestRoute, snapshotRoute, forkRoute]);
    const lines: string[] = [];
    const adopter = createForkAdopter((l) => lines.push(l), { fetchImpl });
    const google = adoptInput({ child: "c-ggl", body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } });
    await adopter.maybeAdopt(google);
    await adopter.maybeAdopt(google);
    assert.equal(calls.length, 0, "no manifest probe, no snapshot GET, no fork POST — the capability check precedes the network");
    assert.ok(lines.some((l) => l.includes("c-ggl") && l.includes("wire requests are not supported") && l.includes("google")));
});

test("createForkAdopter lets responses children reach the protocol — no terminal wire skip (#2469 stage 2)", async () => {
    resetForkCapabilityCacheForTest();
    const { fetchImpl, calls } = fakeFetchRouting([manifestRoute, snapshotRoute, forkRoute]);
    const lines: string[] = [];
    const adopter = createForkAdopter((l) => lines.push(l), { fetchImpl });
    const responses = adoptInput({ child: "c-resp", body: { model: "gpt", input: [{ type: "message", role: "user", content: "hi" }] } });
    await adopter.maybeAdopt(responses);
    assert.ok(calls.some((c) => c.url.includes("manifest")), "the responses child reaches the manifest probe");
    assert.ok(calls.some((c) => c.url.includes("snapshot")), "...and the snapshot GET (identity 'x1' matches nothing → degrades, no fork POST)");
    assert.equal(calls.filter((c) => c.url.endsWith("/__bili/plugin/fork")).length, 0);
    assert.ok(!lines.some((l) => l.includes("wire requests are not supported")), "no unsupported-wire skip for responses");
});

test("createForkAdopter never throws — an exploding network soft-degrades and closes the window", async () => {
    resetForkCapabilityCacheForTest();
    const boom = (async () => { throw new Error("network exploded"); }) as unknown as typeof fetch;
    const lines: string[] = [];
    const adopter = createForkAdopter((l) => lines.push(l), { fetchImpl: boom });
    // manifestForkCapable swallows the explosion (false = not capable), so the
    // child degrades on the capability line and maybeAdopt never rejects.
    await adopter.maybeAdopt(adoptInput());
    assert.ok(lines.some((l) => l.includes("does not advertise the fork capability")), "the failure is logged, not thrown");
    const callsBefore = lines.length;
    await adopter.maybeAdopt(adoptInput());
    assert.equal(lines.length, callsBefore, "the child is done after the first terminal outcome");
});

test("createForkAdopter retries transient failures until the cap, then closes (#2403 review)", async () => {
    resetForkCapabilityCacheForTest();
    const core = openaiBodyToCore(adoptInput().body as Record<string, unknown>)!;
    const matchSnapshot = { match: snapshotRoute.match, respond: () => Response.json({ ok: true, protocolVersion: 1, status: "exact", parentRevision: hash("rev1"), orderHash: hash("full"), orderedMessages: [{ rawId: "a", ref: "m00001", identityHash: forkIdentityHashOf(core[0]!) }] }) };
    const { fetchImpl, calls } = fakeFetchRouting([
        manifestRoute,
        matchSnapshot,
        { match: (c) => c.url.endsWith("/__bili/plugin/fork"), respond: () => new Response("upstream melted", { status: 503 }) },
    ]);
    const adopter = createForkAdopter(() => undefined, { fetchImpl });
    await adopter.maybeAdopt(adoptInput());
    await adopter.maybeAdopt(adoptInput());
    await adopter.maybeAdopt(adoptInput());
    assert.equal(calls.filter((c) => c.url.endsWith("/__bili/plugin/fork")).length, 3, "each attempt within the cap re-posts");
    await adopter.maybeAdopt(adoptInput());
    assert.equal(calls.filter((c) => c.url.endsWith("/__bili/plugin/fork")).length, 3, "past the cap the window is closed");
});

test("createForkAdopter skips side-shaped bodies without consuming the attempt budget (#2399 gate ④)", async () => {
    resetForkCapabilityCacheForTest();
    const core = openaiBodyToCore(adoptInput().body as Record<string, unknown>)!;
    const matchSnapshot = { match: snapshotRoute.match, respond: () => Response.json({ ok: true, protocolVersion: 1, status: "exact", parentRevision: hash("rev1"), orderHash: hash("full"), orderedMessages: [{ rawId: "a", ref: "m00001", identityHash: forkIdentityHashOf(core[0]!) }] }) };
    const { fetchImpl, calls } = fakeFetchRouting([manifestRoute, matchSnapshot, forkRoute]);
    const adopter = createForkAdopter(() => undefined, { fetchImpl });
    const side = adoptInput({ body: { messages: [{ role: "user", content: "title please" }], max_tokens: 64 } });
    await adopter.maybeAdopt(side);
    await adopter.maybeAdopt(side);
    assert.equal(calls.length, 0, "a title sidecar neither fetches nor burns attempts");
    const main = adoptInput();
    await adopter.maybeAdopt(main);
    assert.equal(calls.filter((c) => c.url.endsWith("/__bili/plugin/fork")).length, 1, "the next real main request adopts normally");
});

test("createForkAdopter single-flights concurrent adoptions for the same child", async () => {
    resetForkCapabilityCacheForTest();
    let releaseSnapshot: (() => void) | undefined;
    const { fetchImpl, calls } = fakeFetchRouting([
        manifestRoute,
        { match: (c) => c.url.includes("/__bili/plugin/snapshot"), respond: () => new Promise<Response>((resolve) => { releaseSnapshot = () => resolve(Response.json({ parentRevision: hash("rev1"), orderHash: hash("full"), orderedMessages: [] })); }) },
        forkRoute,
    ]);
    const adopter = createForkAdopter(() => undefined, { fetchImpl });
    const first = adopter.maybeAdopt(adoptInput());
    const second = adopter.maybeAdopt(adoptInput());
    await new Promise((r) => setTimeout(r, 10));
    releaseSnapshot?.();
    await Promise.all([first, second]);
    assert.equal(calls.filter((c) => c.url.includes("snapshot")).length, 1, "the second caller rides the inflight adoption");
});

// ---------------------------------------------------------------------------
// Real-proxy harness (mirrors tests/dsh-fork-adopt.test.ts): a stamped
// OpenAI-wire parent, then extension-driven adoption from the pi/omp plugin
// wiring, then the child replay must be accepted.
// ---------------------------------------------------------------------------

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    return { dir, store, upstreamUrl, origin: `http://127.0.0.1:${paddr.port}`, close: async () => { store.cancelAll(); await closeServers([proxy, upstream], "fork-adopt harness"); } };
}

async function seedParent(h: Awaited<ReturnType<typeof harness>>, conversationId: string) {
    const seed = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId },
        body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "first original ".repeat(250) },
            { role: "assistant", content: "second original ".repeat(250) },
            { role: "user", content: "tail original" },
        ] }),
    });
    assert.equal(seed.status, 200, await seed.text());
}

type RecordedTool = { name: string; parameters: unknown; execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> };
type FakePi = { events: Map<string, (event: unknown, ctx: unknown) => unknown>; tools: RecordedTool[]; on: (event: string, handler: (event: never, ctx: never) => unknown) => void; registerTool: (tool: RecordedTool) => void };

function makeFakePi(): FakePi {
    const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools: RecordedTool[] = [];
    return {
        events,
        tools,
        on: (event, handler) => {
            const h = handler as (event: unknown, ctx: unknown) => unknown;
            const prev = events.get(event);
            events.set(event, prev ? ((e, c) => { prev(e, c); return h(e, c); }) : h);
        },
        registerTool: (tool) => {
            const i = tools.findIndex((t) => t.name === tool.name);
            if (i >= 0) tools[i] = tool;
            else tools.push(tool);
        },
    };
}

function pluginCtx(h: Awaited<ReturnType<typeof harness>>, sid: string, parentSession: string): Record<string, unknown> {
    return {
        sessionManager: { getSessionId: () => sid, getHeader: () => ({ parentSession }) },
        model: { id: "claude-test", contextWindow: 1000000, baseUrl: `${h.origin}/bili/${h.upstreamUrl}/v1` },
        cwd: "/tmp",
    };
}

test("full chain: omp lane adopts behind its own identity register (#2399 stage 2 / B-plan)", { timeout: 60_000 }, async () => {
    resetForkCapabilityCacheForTest();
    const h = await harness();
    try {
        await seedParent(h, "parent-sid");
        const pi = makeFakePi();
        createBiliPlugin("omp")(pi as never);
        const handler = pi.events.get("before_provider_request");
        assert.ok(handler, "before_provider_request handler registered");
        const ctx = pluginCtx(h, "child-sid", "parent-sid");
        const body = { model: "claude-test", max_tokens: 1024, stream: false, messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "first original ".repeat(250) },
            { role: "assistant", content: "second original ".repeat(250) },
            { role: "user", content: "tail original" },
            { role: "user", content: "new fork tail" },
        ] };
        // registerTools (identity register for omp, WITH the parent) runs inside
        // this awaited handler BEFORE the adoption — so a successful snapshot
        // below proves the server-side same-parent exception let the fork
        // through the registeredIds claim.
        await handler({ payload: body }, ctx);
        assert.ok(pi.tools.length > 0, "tools registered against the real manifest");
        const childSnapshot = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=child-sid`);
        const childSnapshotText = await childSnapshot.text();
        assert.equal(childSnapshot.status, 200, childSnapshotText);
        const childBody = JSON.parse(childSnapshotText) as { orderedMessages: unknown[] };
        assert.equal(childBody.orderedMessages.length, 3, "child inherited the parent prefix");

        const replay = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "omp", "x-bili-plugin-conversation": "child-sid" },
            body: JSON.stringify(body),
        });
        assert.equal(replay.status, 200, await replay.text());
    } finally {
        await h.close();
    }
});

test("full chain: pi lane resolves a path-shaped parentSession header and adopts (#2399 stage 2)", { timeout: 60_000 }, async () => {
    resetForkCapabilityCacheForTest();
    const h = await harness();
    try {
        await seedParent(h, "pi-parent");
        const parentFile = join(h.dir, "parent-session.jsonl");
        writeFileSync(parentFile, JSON.stringify({ type: "session", id: "pi-parent" }) + "\n");
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        const handler = pi.events.get("before_provider_request");
        assert.ok(handler, "before_provider_request handler registered");
        const ctx = pluginCtx(h, "child-sid", parentFile);
        const body = { model: "claude-test", max_tokens: 1024, stream: false, messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "first original ".repeat(250) },
            { role: "assistant", content: "second original ".repeat(250) },
            { role: "user", content: "tail original" },
            { role: "user", content: "new fork tail" },
        ] };
        await handler({ payload: body }, ctx);
        const childSnapshot = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=child-sid`);
        const childSnapshotText = await childSnapshot.text();
        assert.equal(childSnapshot.status, 200, childSnapshotText);
        const childBody = JSON.parse(childSnapshotText) as { orderedMessages: unknown[] };
        assert.equal(childBody.orderedMessages.length, 3, "child inherited the parent prefix via the path-resolved id");
    } finally {
        await h.close();
    }
});

test("full chain: pi lane skips adoption when no parent is declared", { timeout: 60_000 }, async () => {
    resetForkCapabilityCacheForTest();
    const h = await harness();
    try {
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        const handler = pi.events.get("before_provider_request");
        assert.ok(handler);
        const ctx = pluginCtx(h, "plain-sid", "");
        await handler({ payload: { model: "claude-test", messages: [{ role: "user", content: "hi" }] } }, ctx);
        const snapshot = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=plain-sid`);
        assert.equal(snapshot.status, 404, "no fork was posted for a root session");
    } finally {
        await h.close();
    }
});

test("pi lane: lineage-only child is skipped before any snapshot/fork call (#2469)", { timeout: 60_000 }, async () => {
    resetForkCapabilityCacheForTest();
    const h = await harness();
    try {
        await seedParent(h, "lineage-parent");
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        const handler = pi.events.get("before_provider_request");
        assert.ok(handler);
        // A spawned subagent: parentSession is set (lineage) but its own branch
        // holds only its task prompt — below FORK_SEED_MIN_REPLAYED_MESSAGES.
        const ctx: Record<string, unknown> = {
            ...pluginCtx(h, "sub-sid", "lineage-parent"),
            sessionManager: { getSessionId: () => "sub-sid", getHeader: () => ({ parentSession: "lineage-parent" }), getBranch: () => [{ type: "message", message: { role: "user", content: "do the task" } }] },
        };
        const termLines: string[] = [];
        const originalWarn = console.warn;
        console.warn = (line: unknown) => { termLines.push(String(line)); };
        try {
            const payload = { model: "claude-test", max_tokens: 1024, stream: false, messages: [{ role: "user", content: "do the task" }] };
            await handler({ payload }, ctx);
            await handler({ payload: { ...payload, messages: [{ role: "user", content: "do the task again" }] } }, ctx);
        } finally {
            console.warn = originalWarn;
        }
        const skipLogPath = join(h.dir, "billion-context", "bili.log");
        const skipLines = (existsSync(skipLogPath) ? readFileSync(skipLogPath, "utf8") : "").split("\n").filter((l) => l.length > 0 && l.includes("lineage-only child"));
        assert.equal(skipLines.length, 1, "the verdict is computed once per sid, not per request");
        assert.ok(skipLines[0]!.includes("sub-sid"));
        assert.equal(termLines.filter((w) => w.includes("lineage-only child")).length, 0, "#2831: must not reach the terminal surface");
        assert.ok(pi.tools.length > 0, "the read-only derivedFrom link still registers");
        const snapshot = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=sub-sid`);
        if (snapshot.status === 200) {
            const body = JSON.parse(await snapshot.text()) as { orderedMessages: unknown[] };
            assert.equal(body.orderedMessages.length, 0, "no inherited compression state");
        } else {
            assert.equal(snapshot.status, 404, "no fork was posted for a lineage-only child");
        }
    } finally {
        await h.close();
    }
});

test("pi lane: seeded child at the branch-length boundary still adopts (#2469)", { timeout: 60_000 }, async () => {
    resetForkCapabilityCacheForTest();
    const h = await harness();
    try {
        await seedParent(h, "seed-parent");
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        const handler = pi.events.get("before_provider_request");
        assert.ok(handler);
        // Exactly FORK_SEED_MIN_REPLAYED_MESSAGES conversation entries in the
        // child's own branch: the >= boundary admits it to the attempt, and the
        // hash prefix match then does the real work.
        const ctx: Record<string, unknown> = {
            ...pluginCtx(h, "seed-child", "seed-parent"),
            sessionManager: {
                getSessionId: () => "seed-child",
                getHeader: () => ({ parentSession: "seed-parent" }),
                getBranch: () => Array.from({ length: FORK_SEED_MIN_REPLAYED_MESSAGES }, (_, i) => ({ type: "message", message: { role: i % 2 === 0 ? "user" : "assistant", content: `replayed ${i}` } })),
            },
        };
        const body = { model: "claude-test", max_tokens: 1024, stream: false, messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "first original ".repeat(250) },
            { role: "assistant", content: "second original ".repeat(250) },
            { role: "user", content: "tail original" },
            { role: "user", content: "new fork tail" },
        ] };
        await handler({ payload: body }, ctx);
        const childSnapshot = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=seed-child`);
        const childSnapshotText = await childSnapshot.text();
        assert.equal(childSnapshot.status, 200, childSnapshotText);
        const childBody = JSON.parse(childSnapshotText) as { orderedMessages: unknown[] };
        assert.equal(childBody.orderedMessages.length, 3, "the boundary child inherited the parent prefix");
    } finally {
        await h.close();
    }
});

test("pi lane: an exploding getBranch fails toward capability and still adopts (#2469)", { timeout: 60_000 }, async () => {
    resetForkCapabilityCacheForTest();
    const h = await harness();
    try {
        await seedParent(h, "throw-parent");
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        const handler = pi.events.get("before_provider_request");
        assert.ok(handler);
        const ctx: Record<string, unknown> = {
            ...pluginCtx(h, "throw-child", "throw-parent"),
            sessionManager: { getSessionId: () => "throw-child", getHeader: () => ({ parentSession: "throw-parent" }), getBranch: () => { throw new Error("host exploded"); } },
        };
        const body = { model: "claude-test", max_tokens: 1024, stream: false, messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "first original ".repeat(250) },
            { role: "assistant", content: "second original ".repeat(250) },
            { role: "user", content: "tail original" },
            { role: "user", content: "new fork tail" },
        ] };
        await handler({ payload: body }, ctx);
        const childSnapshot = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=throw-child`);
        const childSnapshotText = await childSnapshot.text();
        assert.equal(childSnapshot.status, 200, childSnapshotText);
        const childBody = JSON.parse(childSnapshotText) as { orderedMessages: unknown[] };
        assert.equal(childBody.orderedMessages.length, 3, "unknown seeding evidence keeps today's always-attempt behavior");
    } finally {
        await h.close();
    }
});

test("tryForkAdoption rejects a responses child whose prefix matches nothing (#2469 stage 2)", { timeout: 60_000 }, async () => {
    const { fetchImpl, calls } = fakeFetchRouting([snapshotRoute]);
    const result = await tryForkAdoption({ base: "http://px", parentConversationId: "p1", childConversationId: "c1", body: { model: "gpt", input: [{ type: "message", role: "user", content: "completely unrelated" }] }, fetchImpl });
    assert.deepEqual(result, { outcome: "degraded", reason: "no prefix match" });
    assert.equal(calls.filter((c) => c.url.endsWith("/__bili/plugin/fork")).length, 0, "no fork receipt is posted for a mismatch");
});

test("full chain: responses-wire child adopts an openai-seeded parent (#2469 stage 2)", { timeout: 60_000 }, async () => {
    resetForkCapabilityCacheForTest();
    const h = await harness();
    try {
        await seedParent(h, "resp-parent");
        const pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        const handler = pi.events.get("before_provider_request");
        assert.ok(handler);
        // The reporter's exact shape (#2469): pi on codex-class providers sends
        // the responses wire; the parent was seeded through the openai chat
        // lane. Plain-text ids align across wires (kernel emits contentType
        // "text" in both converters), so the prefix must match cross-wire.
        const ctx: Record<string, unknown> = {
            ...pluginCtx(h, "resp-child", "resp-parent"),
            sessionManager: {
                getSessionId: () => "resp-child",
                getHeader: () => ({ parentSession: "resp-parent" }),
                getBranch: () => Array.from({ length: FORK_SEED_MIN_REPLAYED_MESSAGES }, (_, i) => ({ type: "message", message: { role: i % 2 === 0 ? "user" : "assistant", content: `replayed ${i}` } })),
            },
        };
        const body = {
            model: "claude-test", max_tokens: 1024, stream: false,
            input: [
                { type: "message", role: "user", content: "first original ".repeat(250) },
                { type: "message", role: "assistant", content: "second original ".repeat(250) },
                { type: "message", role: "user", content: "tail original" },
                { type: "message", role: "user", content: "new fork tail" },
            ],
        };
        await handler({ payload: body }, ctx);
        const childSnapshot = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=resp-child`);
        const childSnapshotText = await childSnapshot.text();
        assert.equal(childSnapshot.status, 200, childSnapshotText);
        const childBody = JSON.parse(childSnapshotText) as { orderedMessages: unknown[] };
        assert.equal(childBody.orderedMessages.length, 3, "the responses child inherited the parent prefix across wires");
        // Replay acceptance (no FORK_PREFIX_CONFLICT on the child's first
        // stamped request) needs a mock that speaks the responses SSE wire;
        // it is covered generically by the openai full chain above plus the
        // parity test pinning this body's client/server identity equality —
        // exactly what publicForkInputCheck compares.
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// Server-side B-plan semantics: the registeredIds claim a host makes at
// session_start must yield only for the SAME parent declaration.
// ---------------------------------------------------------------------------

test("fork endpoint: identity-registered child yields only for the same parent (#2399 B-plan)", { timeout: 60_000 }, async () => {
    resetForkCapabilityCacheForTest();
    const h = await harness();
    try {
        await seedParent(h, "parent-sid");
        const register = (conversationId: string, parentConversationId?: string) => fetch(`${h.origin}/__bili/plugin/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId, agent: "omp", identity: true, ...(parentConversationId !== undefined ? { parentConversationId } : {}) }),
        });
        assert.equal((await register("child-same", "parent-sid")).status, 200);
        const adopted = await tryForkAdoption({ base: h.origin, parentConversationId: "parent-sid", childConversationId: "child-same", body: { model: "claude-test", max_tokens: 1024, stream: false, messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "first original ".repeat(250) },
            { role: "assistant", content: "second original ".repeat(250) },
            { role: "user", content: "tail original" },
            { role: "user", content: "new tail" },
        ] } });
        assert.deepEqual(adopted, { outcome: "adopted", branchPoint: 3, replayed: false }, "same-parent register claim yields to the fork");

        assert.equal((await register("child-diff", "some-other-parent")).status, 200);
        const conflicted = await tryForkAdoption({ base: h.origin, parentConversationId: "parent-sid", childConversationId: "child-diff", body: { model: "claude-test", max_tokens: 1024, stream: false, messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "first original ".repeat(250) },
        ] } });
        assert.deepEqual(conflicted, { outcome: "degraded", reason: "fork http 409 CHILD_CONFLICT" }, "different-parent claim stays a conflict");

        assert.equal((await register("child-bare")).status, 200);
        const bare = await tryForkAdoption({ base: h.origin, parentConversationId: "parent-sid", childConversationId: "child-bare", body: { model: "claude-test", max_tokens: 1024, stream: false, messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "first original ".repeat(250) },
        ] } });
        assert.deepEqual(bare, { outcome: "degraded", reason: "fork http 409 CHILD_CONFLICT" }, "parentless claim stays a conflict");
    } finally {
        await h.close();
    }
});
