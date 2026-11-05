import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type CoreMessage } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest, forkMessageIdentityHash } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { forkIdentityHashOf, forkOrderHashOf, manifestForkCapable, matchForkPrefix, openaiBodyToCore, resetForkCapabilityCacheForTest, tryForkAdoption } from "../src/agent/fork-adopt.ts";
import { sideShapedBody } from "../src/agent/dsh-native.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-dsh-fork-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

// ---------------------------------------------------------------------------
// Hash parity with the server (#2399): the proxy's publicForkInputCheck
// rejects a child replay whose prefix hashes drift from the receipt, so the
// agent-side recipe must stay byte-identical to src/plugin.ts.
// ---------------------------------------------------------------------------

test("forkIdentityHashOf stays byte-identical to plugin.ts forkMessageIdentityHash (#2399 parity)", () => {
    const identityMatrix: Array<CoreMessage & { toolIsError?: boolean }> = [
        { id: "a", role: "user", contentType: "text", text: "hello" },
        { id: "b", role: "assistant", contentType: "text" },
        { id: "c", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "tc-1", text: "{}" },
        { id: "d", role: "tool", contentType: "tool-result", toolName: "compress", toolCallId: "tc-1", text: "ok", toolIsError: true },
        { id: "d2", role: "tool", contentType: "tool-result", toolName: "compress", toolCallId: "tc-1", text: "ok", toolIsError: false },
        { id: "e", role: "assistant", contentType: "reasoning", text: "hmm", thinkingTokens: 42 },
        { id: "f", role: "assistant", contentType: "text", text: "carrier", summaryOfBlockId: "b3" },
        { id: "g", role: "system", contentType: "text", text: "mid-history system" },
    ];
    for (const message of identityMatrix) {
        assert.equal(forkIdentityHashOf(message), forkMessageIdentityHash(message), JSON.stringify(message));
    }
});

test("forkOrderHashOf matches the plugin.ts recipe (plain JSON.stringify, literal key order)", () => {
    const identities = [
        { rawId: "a", ref: "m00001", identityHash: "x1" },
        { rawId: "b", ref: "m00002", identityHash: "x2" },
    ];
    assert.equal(forkOrderHashOf(identities), hash(identities));
});

// ---------------------------------------------------------------------------
// openaiBodyToCore: projects an outgoing OpenAI body exactly like the
// server's incomingCoreMessages openai branch.
// ---------------------------------------------------------------------------

test("openaiBodyToCore hoists the leading system prefix like the server projection", () => {
    const core = openaiBodyToCore({ model: "m", messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
    ] });
    assert.notEqual(core, null);
    assert.equal(core!.length, 2);
    assert.equal(core![0]!.role, "user");
    assert.equal(core![0]!.text, "hi");
});

test("openaiBodyToCore strips ACP status markers before projecting", () => {
    const marker = "\u{1F4E6} [ACP] Compressed m00001\u2013m00002\n";
    const core = openaiBodyToCore({ messages: [
        { role: "user", content: `${marker}real question` },
        { role: "assistant", content: marker },
    ] });
    assert.notEqual(core, null);
    assert.equal(core!.length, 2);
    assert.equal(core![0]!.text, "real question");
    assert.equal(core![1]!.text, " ");
});

test("openaiBodyToCore degrades malformed bodies to null", () => {
    assert.equal(openaiBodyToCore(null), null);
    assert.equal(openaiBodyToCore("string"), null);
    assert.equal(openaiBodyToCore({ model: "m" }), null);
    assert.equal(openaiBodyToCore({ messages: "not-an-array" }), null);
});

// ---------------------------------------------------------------------------
// matchForkPrefix
// ---------------------------------------------------------------------------

function identitiesOf(core: CoreMessage[]): Array<{ rawId: string; ref: string; identityHash: string }> {
    return core.map((m, i) => ({ rawId: m.id, ref: `m${String(i + 1).padStart(5, "0")}`, identityHash: forkIdentityHashOf(m) }));
}

const seedCore: CoreMessage[] = [
    { id: "a", role: "user", contentType: "text", text: "question one" },
    { id: "b", role: "assistant", contentType: "text", text: "answer one" },
    { id: "c", role: "user", contentType: "text", text: "question two" },
];

test("matchForkPrefix returns the longest hash-equal prefix", () => {
    const identities = identitiesOf(seedCore);
    assert.equal(matchForkPrefix(seedCore, identities), 3);
    const diverged: CoreMessage[] = [seedCore[0]!, seedCore[1]!, { id: "z", role: "user", contentType: "text", text: "different" }];
    assert.equal(matchForkPrefix(diverged, identities), 2);
    const unrelated: CoreMessage[] = [{ id: "q", role: "user", contentType: "text", text: "unrelated" }];
    assert.equal(matchForkPrefix(unrelated, identities), 0);
    assert.equal(matchForkPrefix([], identities), 0);
});

// ---------------------------------------------------------------------------
// sideShapedBody (#2399 spec gate ④): an early sidecar must not consume the
// per-sid adoption budget, or it N=0-degrades the sid before the real replay
// can adopt.
// ---------------------------------------------------------------------------

test("sideShapedBody: no tools + small budget is side-shaped; tools or big budget are not (#2399)", () => {
    assert.equal(sideShapedBody({ messages: [{ role: "user", content: "t" }], max_tokens: 100 }), true);
    assert.equal(sideShapedBody({ messages: [], max_tokens: 200 }), true);
    assert.equal(sideShapedBody({ messages: [], max_completion_tokens: 150 }), true);
    assert.equal(sideShapedBody({ messages: [], max_completion_tokens: 201 }), false);
    assert.equal(sideShapedBody({ messages: [], tools: [{ type: "function", function: { name: "x" } }], max_tokens: 100 }), false);
    assert.equal(sideShapedBody({ messages: [], tools: [], max_tokens: 4096 }), false);
    assert.equal(sideShapedBody({ messages: [] }), false);
    assert.equal(sideShapedBody(null), false);
    assert.equal(sideShapedBody("not-an-object"), false);
});

// ---------------------------------------------------------------------------
// tryForkAdoption against a scripted proxy (mock fetch).
// ---------------------------------------------------------------------------

type Recorded = { url: string; method: string; body?: unknown };

function routerFetch(handlers: { snapshot: () => Response; fork?: (payload: unknown) => Response }, calls: Recorded[]): typeof fetch {
    return (async (input: unknown, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        const raw = init?.body;
        const body = typeof raw === "string" ? JSON.parse(raw) as unknown : undefined;
        calls.push({ url, method: init?.method ?? "GET", body });
        if (url.includes("/__bili/plugin/snapshot")) return handlers.snapshot();
        if (url.includes("/__bili/plugin/fork")) return handlers.fork !== undefined ? handlers.fork(body) : new Response("{}", { status: 404 });
        return new Response("{}", { status: 404 });
    }) as typeof fetch;
}

function jsonRes(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function snapshotFixture(core: CoreMessage[], parentRevision = "rev-1"): unknown {
    const orderedMessages = identitiesOf(core);
    return { ok: true, protocolVersion: 1, status: "exact", sessionId: "parent-session", parentRevision, orderHash: hash(orderedMessages), orderedMessages };
}

function bodyFor(messages: unknown[]): unknown {
    return { model: "m", stream: false, messages };
}

const parentBody = bodyFor([
    { role: "system", content: "system prompt" },
    { role: "user", content: "question one" },
    { role: "assistant", content: "answer one" },
    { role: "user", content: "question two" },
]);

test("tryForkAdoption adopts a full prefix and reuses the snapshot orderHash", async () => {
    const calls: Recorded[] = [];
    const snapshot = snapshotFixture(seedCore);
    const fetchImpl = routerFetch({ snapshot: () => jsonRes(snapshot), fork: () => jsonRes({ ok: true, childConversationId: "child" }, 201) }, calls);
    const result = await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: parentBody, fetchImpl });
    assert.deepEqual(result, { outcome: "adopted", branchPoint: 3, replayed: false });
    const fork = calls.find((c) => c.url.includes("/__bili/plugin/fork"));
    assert.notEqual(fork, undefined);
    const payload = fork!.body as { protocolVersion: number; parentConversationId: string; childConversationId: string; parentRevision: string; branchPoint: { messageCount: number; orderHash: string }; orderedMessages: unknown[]; idempotencyKey: string };
    assert.equal(payload.protocolVersion, 1);
    assert.equal(payload.parentConversationId, "parent");
    assert.equal(payload.childConversationId, "child");
    assert.equal(payload.parentRevision, "rev-1");
    assert.equal(payload.branchPoint.messageCount, 3);
    assert.equal(payload.branchPoint.orderHash, (snapshot as { orderHash: string }).orderHash);
    assert.deepEqual(payload.orderedMessages, (snapshot as { orderedMessages: unknown[] }).orderedMessages);
    assert.equal(payload.idempotencyKey, "fork:child");
});

test("tryForkAdoption hashes a partial prefix locally", async () => {
    const core: CoreMessage[] = [seedCore[0]!, seedCore[1]!];
    const snapshot = snapshotFixture(seedCore);
    const calls: Recorded[] = [];
    const fetchImpl = routerFetch({ snapshot: () => jsonRes(snapshot), fork: () => jsonRes({ ok: true }, 201) }, calls);
    const result = await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: bodyFor([
        { role: "system", content: "system prompt" },
        { role: "user", content: "question one" },
        { role: "assistant", content: "answer one" },
        { role: "user", content: "a different tail" },
    ]), fetchImpl });
    assert.deepEqual(result, { outcome: "adopted", branchPoint: 2, replayed: false });
    const payload = calls.find((c) => c.url.includes("/__bili/plugin/fork"))!.body as { branchPoint: { orderHash: string }; orderedMessages: Array<{ rawId: string }> };
    assert.equal(payload.branchPoint.orderHash, hash(identitiesOf(core)));
    assert.deepEqual(payload.orderedMessages.map((m) => m.rawId), ["a", "b"]);
});

test("tryForkAdoption never posts a fork when the prefix does not match", async () => {
    const calls: Recorded[] = [];
    const fetchImpl = routerFetch({ snapshot: () => jsonRes(snapshotFixture(seedCore)) }, calls);
    const result = await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: bodyFor([{ role: "user", content: "unrelated history" }]), fetchImpl });
    assert.deepEqual(result, { outcome: "degraded", reason: "no prefix match" });
    assert.equal(calls.some((c) => c.url.includes("/__bili/plugin/fork")), false);
});

test("tryForkAdoption degrades on snapshot failures without posting", async () => {
    const calls: Recorded[] = [];
    const notFound = routerFetch({ snapshot: () => new Response("{}", { status: 404 }) }, calls);
    assert.deepEqual(await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: parentBody, fetchImpl: notFound }), { outcome: "degraded", reason: "snapshot http 404" });
    const malformed = routerFetch({ snapshot: () => jsonRes({ ok: true, orderedMessages: "nope" }) }, calls);
    assert.deepEqual(await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: parentBody, fetchImpl: malformed }), { outcome: "degraded", reason: "snapshot malformed" });
    const throwing = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const degraded = await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: parentBody, fetchImpl: throwing });
    assert.equal(degraded.outcome, "degraded");
    assert.match((degraded as { reason: string }).reason, /snapshot error/);
    assert.equal(calls.some((c) => c.url.includes("/__bili/plugin/fork")), false);
});

test("tryForkAdoption surfaces bounded snapshot diagnostics instead of a bare status (#2469)", async () => {
    const calls: Recorded[] = [];
    const unavailable = routerFetch({ snapshot: () => new Response(JSON.stringify({ ok: false, status: "unavailable", code: "SNAPSHOT_UNAVAILABLE", error: "Error: multimodal or opaque content cannot be compared by text" }), { status: 409, headers: { "content-type": "application/json" } }) }, calls);
    const result = await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: parentBody, fetchImpl: unavailable });
    assert.deepEqual(result, { outcome: "degraded", reason: "snapshot http 409 SNAPSHOT_UNAVAILABLE (Error: multimodal or opaque content cannot be compared by text)" });
    assert.equal(calls.length, 1, "one snapshot attempt, no fork POST");
    assert.equal(calls.every((c) => !c.url.includes("/__bili/plugin/fork")), true);
});

test("tryForkAdoption sanitizes control characters out of snapshot diagnostics (#2469)", async () => {
    const dirty = { ok: false, code: "SNAP\x00SHOT\r\nCODE", error: "a\x01b\tc long ".repeat(10) };
    const calls: Recorded[] = [];
    const fetchImpl = routerFetch({ snapshot: () => new Response(JSON.stringify(dirty), { status: 409 }) }, calls);
    const result = await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: parentBody, fetchImpl });
    assert.equal(result.outcome, "degraded");
    const reason = (result as { reason: string }).reason;
    assert.ok(!/[\u0000-\u001f\u007f]/.test(reason), "no control characters survive into the log line");
    // "SNAP\x00SHOT\r\nCODE" -> "SNAP SHOT CODE"; each "a\x01b\tc long " iteration
    // becomes "a b c long " (11 chars x10 = 109, under the 120 cap: no ellipsis).
    assert.match(reason, /^snapshot http 409 SNAP SHOT CODE \(a b c long( a b c long){9}\)$/);
});

test("tryForkAdoption degrades safely on non-JSON or oversized snapshot error bodies (#2469)", async () => {
    const nonJson = routerFetch({ snapshot: () => new Response("<html>gateway exploded</html>", { status: 409 }) }, []);
    assert.deepEqual(await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: parentBody, fetchImpl: nonJson }), { outcome: "degraded", reason: "snapshot http 409" });
    // A body past the 1KB read cap is truncated mid-JSON: parsing must fail
    // closed to the status-only reason, never hang or buffer unboundedly.
    const oversized = routerFetch({ snapshot: () => new Response(JSON.stringify({ ok: false, code: "BIG", error: "x".repeat(5000) }), { status: 409 }) }, []);
    assert.deepEqual(await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: parentBody, fetchImpl: oversized }), { outcome: "degraded", reason: "snapshot http 409" });
});

test("tryForkAdoption ends google children before any network request; responses go through the protocol (#2469)", async () => {
    // Responses is projected client-side now (#2469 stage 2): the child gets a
    // real snapshot GET and degrades on the identity match like any other wire.
    const responsesCalls: Recorded[] = [];
    const responsesFetch = routerFetch({ snapshot: () => jsonRes(snapshotFixture(seedCore)), fork: () => jsonRes({ ok: true }, 201) }, responsesCalls);
    const responses = await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: { model: "gpt", input: [{ type: "message", role: "user", content: "hi" }] }, fetchImpl: responsesFetch });
    assert.deepEqual(responses, { outcome: "degraded", reason: "no prefix match" });
    assert.equal(responsesCalls.filter((c) => c.url.includes("snapshot")).length, 1, "the responses child reaches the snapshot");
    assert.equal(responsesCalls.filter((c) => c.url.endsWith("/__bili/plugin/fork")).length, 0, "...but posts no fork receipt for a mismatch");
    const googleCalls: Recorded[] = [];
    const googleFetch = routerFetch({ snapshot: () => jsonRes(snapshotFixture(seedCore)) }, googleCalls);
    const google = await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] }, fetchImpl: googleFetch });
    assert.deepEqual(google, { outcome: "degraded", reason: "wire unsupported (google)" });
    assert.equal(googleCalls.length, 0);
});

test("tryForkAdoption surfaces fork rejections and replays", async () => {
    const conflict = routerFetch({ snapshot: () => jsonRes(snapshotFixture(seedCore)), fork: () => jsonRes({ ok: false, code: "CHILD_CONFLICT" }, 409) }, []);
    const rejected = await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: parentBody, fetchImpl: conflict });
    assert.deepEqual(rejected, { outcome: "degraded", reason: "fork http 409 CHILD_CONFLICT" });
    const replay = routerFetch({ snapshot: () => jsonRes(snapshotFixture(seedCore)), fork: () => jsonRes({ ok: true, replayed: true }, 200) }, []);
    const replayed = await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: parentBody, fetchImpl: replay });
    assert.deepEqual(replayed, { outcome: "adopted", branchPoint: 3, replayed: true });
});

test("tryForkAdoption retries once on PARENT_REVISION_CONFLICT with a fresh snapshot", async () => {
    const calls: Recorded[] = [];
    let revision = "rev-1";
  const fetchImpl = routerFetch({
        snapshot: () => jsonRes(snapshotFixture(seedCore, revision)),
        fork: () => {
            if (revision === "rev-1") {
                revision = "rev-2";
                return jsonRes({ ok: false, code: "PARENT_REVISION_CONFLICT" }, 409);
            }
            return jsonRes({ ok: true }, 201);
        },
    }, calls);
    const result = await tryForkAdoption({ base: "http://proxy", parentConversationId: "parent", childConversationId: "child", body: parentBody, fetchImpl });
    assert.deepEqual(result, { outcome: "adopted", branchPoint: 3, replayed: false });
    assert.equal(calls.filter((c) => c.url.includes("/__bili/plugin/snapshot")).length, 2);
    const forks = calls.filter((c) => c.url.includes("/__bili/plugin/fork"));
    assert.equal(forks.length, 2);
    assert.equal((forks[1]!.body as { parentRevision: string }).parentRevision, "rev-2");
});

// ---------------------------------------------------------------------------
// manifestForkCapable
// ---------------------------------------------------------------------------

test("manifestForkCapable caches per base and resets for tests", async () => {
    resetForkCapabilityCacheForTest();
    let manifestCalls = 0;
    const capable = (async () => { manifestCalls += 1; return jsonRes({ capabilities: { fork: { protocolVersion: 1 } } }); }) as unknown as typeof fetch;
    assert.equal(await manifestForkCapable("http://capable-proxy", capable), true);
    assert.equal(await manifestForkCapable("http://capable-proxy", capable), true);
    assert.equal(manifestCalls, 1);
    assert.equal(await manifestForkCapable("http://no-fork", (async () => jsonRes({ capabilities: {} })) as unknown as typeof fetch), false);
    assert.equal(await manifestForkCapable("http://404", (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch), false);
    resetForkCapabilityCacheForTest();
    assert.equal(await manifestForkCapable("http://capable-proxy", capable), true);
    assert.equal(manifestCalls, 2);
});

test("manifestForkCapable accepts fork protocol v2 manifests (#2671 Phase 2b)", async () => {
    resetForkCapabilityCacheForTest();
    // A v2 proxy (current server) must stay fork-capable from the adoption
    // client's point of view; unknown future majors stay gated off.
    const v2 = (async () => jsonRes({ capabilities: { fork: { protocolVersion: 2, acceptsProtocolVersions: [1, 2] } } })) as unknown as typeof fetch;
    assert.equal(await manifestForkCapable("http://v2-proxy", v2), true);
    const v3 = (async () => jsonRes({ capabilities: { fork: { protocolVersion: 3 } } })) as unknown as typeof fetch;
    assert.equal(await manifestForkCapable("http://v3-proxy", v3), false);
    resetForkCapabilityCacheForTest();
});

// ---------------------------------------------------------------------------
// Full chain against a real proxy: an OpenAI-wire dsh parent, adoption via
// tryForkAdoption, then the child's replayed request must be ACCEPTED (the
// server's publicForkInputCheck binds the receipt) and a divergent second
// fork for the same child id must be refused.
// ---------------------------------------------------------------------------

async function fullChainHarness() {
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
    return { store, upstreamUrl, origin: `http://127.0.0.1:${paddr.port}`, close: async () => { store.cancelAll(); proxy.close(); proxy.closeIdleConnections?.(); upstream.close(); upstream.closeIdleConnections?.(); await Promise.all([once(proxy, "close"), once(upstream, "close")]); } };
}

test("full chain: dsh fork child adopts the parent state and its replay is accepted (#2399)", async () => {
    const h = await fullChainHarness();
    try {
        const parentMessages = [
            { role: "system", content: "system prompt" },
            { role: "user", content: "first original ".repeat(250) },
            { role: "assistant", content: "second original ".repeat(250) },
            { role: "user", content: "tail original" },
        ];
        const seed = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "parent-sid" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: parentMessages }),
        });
        assert.equal(seed.status, 200, await seed.text());

        const childMessages = [...parentMessages, { role: "user", content: "new fork tail" }];
        const adoption = await tryForkAdoption({ base: h.origin, parentConversationId: "parent-sid", childConversationId: "child-sid", body: { model: "claude-test", max_tokens: 1024, stream: false, messages: childMessages } });
        assert.deepEqual(adoption, { outcome: "adopted", branchPoint: 3, replayed: false });

        const childSnapshot = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=child-sid`);
        const childSnapshotText = await childSnapshot.text();
        assert.equal(childSnapshot.status, 200, childSnapshotText);
        const childBody = JSON.parse(childSnapshotText) as { orderedMessages: unknown[]; sessionId: string };
        assert.equal(childBody.orderedMessages.length, 3);
        const parentSnapshot = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=parent-sid`);
        const parentBody = await parentSnapshot.json() as { sessionId: string; parentRevision: string; orderedMessages: Array<{ rawId: string; ref: string; identityHash: string }> };
        assert.deepEqual(childBody.orderedMessages, parentBody.orderedMessages);
        assert.notEqual(childBody.sessionId, parentBody.sessionId);

        // The child's replayed request must be accepted — a projection drift
        // between fork-adopt.ts and the server would 409 FORK_PREFIX_CONFLICT
        // here and permanently poison the child conversation.
        const replay = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "child-sid" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: childMessages }),
        });
        assert.equal(replay.status, 200, await replay.text());

        // A divergent fork for the same child id is refused — the child id is
        // single-owner, so a second, different derivation must not rewrite it.
        const divergentPrefix = parentBody.orderedMessages.slice(0, 1);
        const divergent = await fetch(`${h.origin}/__bili/plugin/fork`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ protocolVersion: 1, parentConversationId: "parent-sid", childConversationId: "child-sid", parentRevision: parentBody.parentRevision, branchPoint: { messageCount: 1, orderHash: hash(divergentPrefix) }, orderedMessages: divergentPrefix, idempotencyKey: "fork:child-sid-2" }),
        });
        assert.equal(divergent.status, 409);
        const divergentBody = await divergent.json() as { code?: string };
        assert.equal(divergentBody.code, "CHILD_CONFLICT");
    } finally {
        await h.close();
    }
});
