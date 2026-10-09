import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyAbsorb, buildStoredPlaceholder, createContentStore, defaultConfig, DEFAULT_ABSORB_CONFIG, DEFAULT_CCR_CONFIG, storeOriginal } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest, rememberPluginMessages, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest, getSession } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { recordToolWitness, resetToolRingForTest } from "../src/tool-ring.ts";
import { contentStoreOf } from "../src/store.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-fork-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

interface SnapshotResponse {
    status: string;
    code?: string;
    sessionId: string;
    parentRevision: string;
    orderedMessages: { rawId: string; ref: string; identityHash: string }[];
    messages: { text?: string; ref: string; toolIsError: boolean }[];
}

interface ForkResponse {
    status: string;
    code?: string;
    childConversationId: string;
    inheritedBlocks: { id: string }[];
    expandedBlocks: string[];
    replayed: boolean;
}

interface StatusResponse {
    sessionId: string | null;
    sessionRevision: string | null;
    fallback?: boolean;
    contextTokensSource: "usage" | "estimate" | "unavailable";
    contextTokens: number | null;
    contextTokensAt: number | null;
    contextGeneration: string | null;
    compressCreditTokens: number;
    inputTokens: number;
    contextLimit: number | null;
    compressibleRanges: { startRef: string; endRef: string; count: number }[] | null;
}

type PluginResponse<Path extends string> = Path extends "/__bili/plugin/manifest"
    ? { tools: { openai: { type: "function"; function: { name: string; parameters: Record<string, unknown> } }[] }; capabilities: { fork: { protocolVersion: number; endpoint: string; snapshotEndpoint: string } } }
    : Path extends "/__bili/plugin/fork" ? ForkResponse
    : Path extends "/__bili/plugin/tool" ? { result: string; code?: string; conversationId?: string }
    : Path extends `/__bili/plugin/status${string}` ? StatusResponse
    : SnapshotResponse;

async function responseBody<Path extends string>(response: Response, _path: Path): Promise<PluginResponse<Path>> {
    const body: unknown = await response.json();
    assert(body !== null && typeof body === "object" && !Array.isArray(body));
    // Success fields follow the endpoint fixture; failures are checked via status/code.
    return body as PluginResponse<Path>;
}

async function harness(persist = false, seedParent = true) {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: persist, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(req.url?.endsWith("/chat/completions")
                ? { id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }
                : { id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
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
    const origin = `http://127.0.0.1:${paddr.port}`;
    const request = async <Path extends string>(path: Path, body?: unknown) => {
        const r = await fetch(origin + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: await responseBody(r, path) };
    };
    const messages = [{ role: "user", content: "first original ".repeat(250) }, { role: "assistant", content: "second original ".repeat(250) }, { role: "user", content: "tail original" }];
    if (seedParent) {
        const r = await fetch(`${origin}/bili/${upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": "parent" }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages }) });
        assert.equal(r.status, 200);
        await r.text();
    }
    return { request, messages, forwarded, dir, store, upstreamUrl, origin, close: async () => { store.cancelAll(); proxy.close(); upstream.close(); await Promise.all([once(proxy, "close"), once(upstream, "close")]); } };
}

test("plain proxy panel snapshots do not change raw-history persistence", async () => {
    const h = await harness();
    try {
        const session = getSession("plain-panel");
        const messages = [{ id: "plain-message", role: "user" as const, contentType: "text" as const, text: "raw plain-proxy original" }];
        rememberPluginMessages(session.id, messages, messages);
        assert.equal(session.pluginSnapshot, undefined);
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=plain-panel")).status, 409);
    } finally { await h.close(); }
});

test("HTTP exposes a versioned snapshot and forks an exact ordered prefix", async () => {
    const h = await harness();
    try {
        const manifest = await h.request("/__bili/plugin/manifest");
        assert.deepEqual(manifest.body.capabilities.fork, { protocolVersion: 1, endpoint: "/__bili/plugin/fork", snapshotEndpoint: "/__bili/plugin/snapshot" });
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(snapshot.status, 200, JSON.stringify({ response: snapshot.body, session: resolveConversation("parent").session }));
        assert.equal(snapshot.body.orderedMessages.length, 3);
        assert.equal(snapshot.body.messages[0].text, h.messages[0].content);
        assert.equal(snapshot.body.messages[0].ref, snapshot.body.orderedMessages[0].ref);
        const orderedMessages = snapshot.body.orderedMessages.slice(0, 2);
        const request = { protocolVersion: 1, parentConversationId: "parent", childConversationId: "child", parentRevision: snapshot.body.parentRevision, branchPoint: { messageCount: 2, orderHash: hash(orderedMessages) }, orderedMessages, idempotencyKey: "fork-1" };
        const fork = await h.request("/__bili/plugin/fork", request);
        assert.equal(fork.status, 201);
        assert.equal(fork.body.childConversationId, "child");
        const child = await h.request("/__bili/plugin/snapshot?conversationId=child");
        assert.deepEqual(child.body.orderedMessages, orderedMessages);
        assert.notEqual(child.body.sessionId, snapshot.body.sessionId);
        assert.equal((await h.request("/__bili/plugin/fork", request)).status, 200);
    } finally { await h.close(); }
});

async function sendIntentModel(h: Awaited<ReturnType<typeof harness>>, conversationId: string, messages: unknown[], tools: unknown[], requestAgent?: string, maxTokens = 256, announcePlugin = true) {
    const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId };
    if (announcePlugin) {
        headers["x-bili-plugin"] = "ekko-agent";
        headers["x-bili-plugin-conversation"] = conversationId;
    }
    if (requestAgent !== undefined) headers["x-bili-plugin-agent"] = requestAgent;
    const response = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "claude-test", max_tokens: maxTokens, stream: false, messages, tools }) });
    assert.equal(response.status, 200, await response.text());
}

test("HTTP explicit main with only public ACP tools captures initial history, usage and first fork payload", async () => {
    const h = await harness(false, false);
    try {
        const tools = (await h.request("/__bili/plugin/manifest")).body.tools.openai;
        assert.deepEqual(tools.map((tool) => tool.function.name), ["compress", "decompress", "search_context", "acp_status", "acp_cache"]);
        await sendIntentModel(h, "parent", h.messages, tools, "main");
        assert.deepEqual(h.forwarded.at(-1)!.tools, tools, "main tools survive unchanged");
        assert.equal(h.forwarded.at(-1)!.max_tokens, 256);
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
        assert.deepEqual(snapshot.body.messages.map((message) => message.text), h.messages.map((message) => message.content));
        const status = (await h.request("/__bili/plugin/status?conversationId=parent")).body;
        assert.equal(status.contextTokensSource, "usage");
        assert.equal(status.contextTokens, 10000);
        assert.equal(resolveConversation("parent").session!.stats.requests, 1);
        const fork = await h.request("/__bili/plugin/fork", forkRequest(snapshot.body, "child", h.messages.length));
        assert.equal(fork.status, 201, JSON.stringify(fork.body));
        assert.equal(fork.body.status, "exact");
        const history = [...h.messages, { role: "assistant", content: "first fork continuation" }];
        await sendIntentModel(h, "child", history, tools, "main");
        assert.deepEqual(h.forwarded.at(-1)!.tools, tools, "first child request retains the public tools");
        const forwarded = h.forwarded.at(-1)!.messages as { role: string; content: string }[];
        assert.equal(forwarded[0].role, "system");
        assert.match(forwarded[0].content, /^Compression Philosophy:/);
        assert.deepEqual(forwarded.slice(1).map((message) => ({ role: message.role, content: message.content.replace(/^\x3cacp\b[^\n]*\x3c\/acp\x3e\n/, "") })), history, "the first fork payload retains the exact inherited history in order");
        const child = (await h.request("/__bili/plugin/snapshot?conversationId=child")).body;
        assert.deepEqual(child.orderedMessages.slice(0, h.messages.length), snapshot.body.orderedMessages);
        assert.deepEqual(child.messages.map((message) => message.text), history.map((message) => message.content));
        assert.equal((await h.request("/__bili/plugin/status?conversationId=child")).body.contextTokensSource, "usage");
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=parent")).body.parentRevision, snapshot.body.parentRevision);
    } finally { await h.close(); }
});

test("HTTP explicit main without tools survives a tiny output budget", async () => {
    const h = await harness(false, false);
    try {
        await sendIntentModel(h, "parent", h.messages, [], "main", 100);
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
        assert.deepEqual(snapshot.body.messages.map((message) => message.text), h.messages.map((message) => message.content));
        assert.equal((await h.request("/__bili/plugin/status?conversationId=parent")).body.contextTokensSource, "usage");
    } finally { await h.close(); }
});

test("HTTP title on the same plugin lane cannot replace the main snapshot or usage", async () => {
    const h = await harness();
    try {
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        const status = (await h.request("/__bili/plugin/status?conversationId=parent")).body;
        const session = resolveConversation("parent").session!;
        const before = JSON.stringify({ state: session.state, stats: session.stats, highWater: session.metadata.outputBudgetHighWater });
        const tools = (await h.request("/__bili/plugin/manifest")).body.tools.openai;
        const messages = [{ role: "user", content: "Generate a title." }];
        await sendIntentModel(h, "parent", messages, tools, "title", 1024);
        assert.equal(h.forwarded.at(-1)!.tools, undefined);
        assert.deepEqual(h.forwarded.at(-1)!.messages, messages);
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=parent")).body.parentRevision, snapshot.parentRevision);
        const after = (await h.request("/__bili/plugin/status?conversationId=parent")).body;
        for (const field of ["sessionRevision", "contextTokensSource", "contextTokens", "contextTokensAt", "contextGeneration", "inputTokens", "compressCreditTokens"] as const) assert.equal(after[field], status[field]);
        assert.equal(JSON.stringify({ state: session.state, stats: session.stats, highWater: session.metadata.outputBudgetHighWater }), before);
    } finally { await h.close(); }
});

test("HTTP missing or unknown intent keeps all-bili demotion; anonymous main cannot claim plugin intent", async () => {
    const h = await harness(false, false);
    try {
        const tools = (await h.request("/__bili/plugin/manifest")).body.tools.openai;
        for (const requestAgent of [undefined, "other"]) {
            const id = requestAgent ?? "missing-intent";
            await sendIntentModel(h, id, h.messages, tools, requestAgent);
            assert.equal(h.forwarded.at(-1)!.tools, undefined);
            assert.equal((await h.request(`/__bili/plugin/snapshot?conversationId=${id}`)).status, 409);
            assert.equal(resolveConversation(id).session!.stats.requests, 0);
        }
        await sendIntentModel(h, "anonymous-main", h.messages, [], "main", 100, false);
        assert.deepEqual(h.forwarded.at(-1)!.messages, h.messages, "unannounced persona must still pass through as a tiny utility request");
        assert.equal(getSession("anonymous-main").stats.requests, 0);
        assert.equal(getSession("anonymous-main").metadata.pluginAgent, undefined);
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=anonymous-main")).status, 409);
    } finally { await h.close(); }
});

function forkRequest(snapshot: { parentRevision: string; orderedMessages: unknown[] }, child = "child", count = 2) {
    const orderedMessages = snapshot.orderedMessages.slice(0, count);
    return { protocolVersion: 1, parentConversationId: "parent", childConversationId: child, parentRevision: snapshot.parentRevision, branchPoint: { messageCount: count, orderHash: hash(orderedMessages) }, orderedMessages, idempotencyKey: `fork-${child}` };
}

test("HTTP tool witnesses never override explicit parent, child or sibling identities", async () => {
    const h = await harness();
    try {
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        for (const id of ["child", "sibling"]) assert.equal((await h.request("/__bili/plugin/fork", forkRequest(snapshot, id, 3))).status, 201);
        const args = { content: [{ startId: "m00001", endId: "m00002", summary }] };
        const revisions = new Map<string, string>();
        for (const id of ["parent", "child", "sibling"]) revisions.set(id, (await h.request(`/__bili/plugin/snapshot?conversationId=${id}`)).body.parentRevision);
        for (const [witness, target] of [["parent", "child"], ["child", "parent"], ["child", "sibling"], ["sibling", "child"]]) {
            resetToolRingForTest();
            recordToolWitness(witness!, "compress", args);
            for (const expectedRevision of [undefined, revisions.get(target!)]) {
                const conflict = await h.request("/__bili/plugin/tool", { conversationId: target, tool: "compress", args, expectedRevision });
                assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
                assert.equal(conflict.body.code, "TOOL_CONVERSATION_CONFLICT");
            }
            for (const [id, revision] of revisions) assert.equal((await h.request(`/__bili/plugin/snapshot?conversationId=${id}`)).body.parentRevision, revision);
        }
        resetToolRingForTest();
        recordToolWitness("parent", "compress", args);
        recordToolWitness("child", "compress", args);
        assert.equal((await h.request("/__bili/plugin/tool", { conversationId: "child", tool: "compress", args })).status, 200);
        assert.equal(resolveConversation("child").session!.state.blocks.length, 1);
        assert.equal(resolveConversation("parent").session!.state.blocks.length, 0);
        assert.equal(resolveConversation("sibling").session!.state.blocks.length, 0);
        resetToolRingForTest();
        recordToolWitness("sibling", "compress", args);
        assert.equal((await h.request("/__bili/plugin/tool", { tool: "compress", args })).status, 200);
        assert.equal(resolveConversation("sibling").session!.state.blocks.length, 1);
        assert.equal(resolveConversation("parent").session!.state.blocks.length, 0);
    } finally { await h.close(); }
});

test("HTTP native callers honor fork identity and revision despite a sibling witness", async () => {
    const h = await harness();
    try {
        const parent = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        assert.equal((await h.request("/__bili/plugin/fork", forkRequest(parent, "child", 3))).status, 201);
        const child = (await h.request("/__bili/plugin/snapshot?conversationId=child")).body;
        const args = { content: [{ startId: "m00001", endId: "m00002", summary }] };
        recordToolWitness("parent", "compress", args);
        const payload = { conversationId: "child", tool: "compress", args, expectedRevision: child.parentRevision };
        const unconfirmed = await h.request("/__bili/plugin/tool", { ...payload, nativeCaller: "true" });
        assert.equal(unconfirmed.status, 409);
        assert.equal(unconfirmed.body.code, "TOOL_CONVERSATION_CONFLICT");
        const stale = await h.request("/__bili/plugin/tool", { ...payload, nativeCaller: true, expectedRevision: "0".repeat(64) });
        assert.equal(stale.status, 409);
        assert.equal(stale.body.code, "PARENT_REVISION_CONFLICT");
        const unknown = await h.request("/__bili/plugin/tool", { ...payload, conversationId: "unknown-child", nativeCaller: true });
        assert.equal(unknown.status, 404);
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=child")).body.parentRevision, child.parentRevision);
        const confirmed = await h.request("/__bili/plugin/tool", { ...payload, nativeCaller: true });
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
        assert.equal(confirmed.body.conversationId, "child");
        assert.equal(resolveConversation("child").session!.state.blocks.length, 1);
        assert.equal(resolveConversation("parent").session!.state.blocks.length, 0);
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=parent")).body.parentRevision, parent.parentRevision);
    } finally { await h.close(); }
});

test("HTTP snapshot normalizes tool error flags and rejects a success identity for a failed result", async () => {
    const h = await harness();
    try {
        const history = (isError?: boolean) => [
            { role: "user", content: "run checks" },
            { role: "assistant", content: [{ type: "tool_use", id: "check_1", name: "bash", input: { command: "npm test" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "check_1", content: "identical tool output", ...(isError === undefined ? {} : { is_error: isError }) }] },
            { role: "assistant", content: "checks reviewed" },
        ];
        await sendModel(h, "parent", history());
        const implicit = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        await sendModel(h, "parent", history(false));
        const success = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        await sendModel(h, "parent", history(true));
        const failed = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        assert.equal(implicit.messages[2].toolIsError, false);
        assert.equal(success.messages[2].toolIsError, false);
        assert.equal(failed.messages[2].toolIsError, true);
        assert.equal(implicit.orderedMessages[2].identityHash, success.orderedMessages[2].identityHash);
        assert.equal(failed.orderedMessages[2].rawId, success.orderedMessages[2].rawId);
        assert.notEqual(failed.orderedMessages[2].identityHash, success.orderedMessages[2].identityHash);
        const stale = forkRequest({ ...failed, orderedMessages: success.orderedMessages }, "wrong-error-identity", 3);
        assert.equal((await h.request("/__bili/plugin/fork", stale)).body.code, "BRANCH_POINT_CONFLICT");
        assert.equal((await h.request("/__bili/plugin/fork", forkRequest(failed, "error-child", 3))).status, 201);
        const child = (await h.request("/__bili/plugin/snapshot?conversationId=error-child")).body;
        assert.equal(child.messages[2].toolIsError, true);
        assert.equal(child.orderedMessages[2].identityHash, failed.orderedMessages[2].identityHash);
    } finally { await h.close(); }
});

test("HTTP fork fails closed on malformed, missing, stale and reordered boundaries", async () => {
    const h = await harness();
    try {
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        const req = forkRequest(snapshot);
        for (const payload of [null, [], { ...req, protocolVersion: 2 }, { ...req, childConversationId: "parent" }, { ...req, parentConversationId: " parent" }, { ...req, branchPoint: { ...req.branchPoint, messageCount: -1 } }]) {
            assert.equal((await h.request("/__bili/plugin/fork", payload)).status, 400);
        }
        assert.equal((await h.request("/__bili/plugin/fork", { ...req, parentConversationId: "missing" })).status, 404);
        assert.equal((await h.request("/__bili/plugin/fork", { ...req, parentRevision: "0".repeat(64) })).body.code, "PARENT_REVISION_CONFLICT");
        const reversed = [...req.orderedMessages].reverse();
        assert.equal((await h.request("/__bili/plugin/fork", { ...req, orderedMessages: reversed, branchPoint: { messageCount: 2, orderHash: hash(reversed) } })).body.code, "BRANCH_POINT_CONFLICT");
        assert.equal((await h.request("/__bili/plugin/fork", { ...req, branchPoint: { ...req.branchPoint, orderHash: "0".repeat(64) } })).body.code, "BRANCH_POINT_CONFLICT");
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=child")).status, 404);
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=parent")).body.parentRevision, snapshot.parentRevision);
        assert.equal((await h.request("/__bili/plugin/fork", req)).status, 201);
        assert.equal((await h.request("/__bili/plugin/fork", { ...req, idempotencyKey: "different" })).body.code, "CHILD_CONFLICT");
    } finally { await h.close(); }
});

test("HTTP concurrent identical forks publish once and conflicting parents cannot overwrite", async () => {
    const h = await harness();
    try {
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        const req = forkRequest(snapshot);
        const results = await Promise.all(Array.from({ length: 12 }, () => h.request("/__bili/plugin/fork", req)));
        assert.equal(results.filter((r) => r.status === 201).length, 1);
        assert.equal(results.filter((r) => r.status === 200).length, 11);
        const conflicts = await Promise.all(Array.from({ length: 4 }, (_, i) => h.request("/__bili/plugin/fork", { ...req, idempotencyKey: `collision-${i}` })));
        assert(conflicts.every((r) => r.status === 409));
        assert.deepEqual((await h.request("/__bili/plugin/snapshot?conversationId=child")).body.orderedMessages, req.orderedMessages);
        const empty = await h.request("/__bili/plugin/fork", forkRequest(snapshot, "empty", 0));
        assert.equal(empty.status, 201);
        assert.deepEqual((await h.request("/__bili/plugin/snapshot?conversationId=empty")).body.orderedMessages, []);
    } finally { await h.close(); }
});

const summary = "The preserved history contains the original request and response; all key content is available through the inherited block and its stable references.";
async function compress(h: Awaited<ReturnType<typeof harness>>, conversationId = "parent", startId = "m00001", endId = "m00002") {
    const r = await h.request("/__bili/plugin/tool", { conversationId, tool: "compress", args: { content: [{ startId, endId, summary }] } });
    assert.equal(r.status, 200);
    assert(!r.body.result.includes("FAILED"), r.body.result);
    return r;
}

test("HTTP compressed originals are isolated across parent and siblings and straddlers are excluded", async () => {
    const h = await harness();
    try {
        await compress(h);
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        const full = await h.request("/__bili/plugin/fork", forkRequest(snapshot));
        assert.equal(full.status, 201, JSON.stringify(full.body));
        assert.equal(full.body.inheritedBlocks.length, 1);
        const sibling = await h.request("/__bili/plugin/fork", forkRequest(snapshot, "sibling"));
        assert.equal(sibling.status, 201);
        const straddler = await h.request("/__bili/plugin/fork", forkRequest(snapshot, "straddler", 1));
        assert.equal(straddler.status, 201);
        assert.equal(straddler.body.status, "expanded");
        assert.deepEqual(straddler.body.inheritedBlocks, []);
        await sendModel(h, "straddler", [...h.messages.slice(0, 1), { role: "assistant", content: "expanded child first continuation" }]);
        const expandedOutbound = JSON.stringify(h.forwarded.at(-1)!.messages);
        assert.match(expandedOutbound, /first original/);
        assert(!expandedOutbound.includes("second original"), expandedOutbound);
        assert(!expandedOutbound.includes("tail original"), expandedOutbound);
        assert(!expandedOutbound.includes(summary), expandedOutbound);
        const original = await h.request("/__bili/plugin/tool", { conversationId: "child", tool: "decompress", args: { blockId: "b1", full: true } });
        assert.match(original.body.result, /first original/);
        assert.match(original.body.result, /second original/);
        assert(!original.body.result.includes("tail original"));
        const parentState = resolveConversation("parent").session!;
        const childState = resolveConversation("child").session!;
        const siblingState = resolveConversation("sibling").session!;
        assert.notEqual(childState.state.blocks[0], parentState.state.blocks[0]);
        assert.notEqual(childState.blockContents.get("b1"), siblingState.blockContents.get("b1"));
        childState.state.blocks[0].summary = "child only";
        childState.state.tokenSnapshot.m00001 = 1;
        childState.pluginSnapshot![0].text = "child only";
        assert.equal(parentState.state.blocks[0].summary, summary);
        assert.equal(siblingState.state.blocks[0].summary, summary);
        assert.notEqual(parentState.state.tokenSnapshot.m00001, 1);
        assert.match(parentState.pluginSnapshot![0].text!, /first original/);
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=parent")).body.parentRevision, snapshot.parentRevision);
    } finally { await h.close(); }
});

test("HTTP exact fork materializes its inherited summary with equivalent SDK text and bili-only tools", async () => {
    const h = await harness();
    try {
        await compress(h);
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        for (const withTools of [false, true]) {
            const id = withTools ? "sdk-tools-child" : "sdk-text-child";
            const fork = await h.request("/__bili/plugin/fork", forkRequest(snapshot, id));
            assert.equal(fork.status, 201);
            assert.equal(fork.body.status, "exact");
            assert.equal(fork.body.inheritedBlocks[0].id, "b1");
            const messages = [...h.messages.slice(0, 2).map((m) => ({ ...m, content: [{ type: "text", text: m.content }] })), { role: "user", content: [{ type: "text", text: "continue child" }] }];
            const response = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "ekko-agent", "x-bili-plugin-conversation": id }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, system: "SDK runtime system", stream: false, messages, ...(withTools ? { tools: [{ name: "compress", description: "Compress", input_schema: { type: "object", properties: {} } }] } : {}) }) });
            assert.equal(response.status, 200, await response.text());
            const forwarded = JSON.stringify(h.forwarded.at(-1)?.messages);
            assert(forwarded.includes(summary), JSON.stringify({ blocks: resolveConversation(id).session!.state.blocks, ids: resolveConversation(id).session!.pluginSnapshot?.map((m) => m.id), before: fork.body }));
            assert(!forwarded.includes("second original"), forwarded);
            const child = (await h.request(`/__bili/plugin/snapshot?conversationId=${id}`)).body;
            assert.deepEqual(child.orderedMessages.slice(0, 2), snapshot.orderedMessages.slice(0, 2));
            assert.equal(resolveConversation(id).session!.state.blocks[0].active, true);
        }
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=parent")).body.parentRevision, snapshot.parentRevision);
    } finally { await h.close(); }
});

test("HTTP first fork request rejects a mismatched inherited prefix without forwarding or mutating state", async () => {
    const h = await harness();
    try {
        await compress(h);
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        assert.equal((await h.request("/__bili/plugin/fork", forkRequest(snapshot))).status, 201);
        const child = (await h.request("/__bili/plugin/snapshot?conversationId=child")).body;
        const requests = h.forwarded.length;
        for (const messages of [
            [{ ...h.messages[0], content: "changed semantic content" }, h.messages[1], { role: "user", content: "continue child" }],
            [h.messages[1], h.messages[0], { role: "user", content: "reordered prefix" }],
            h.messages.slice(0, 1),
        ]) {
            const response = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "ekko-agent", "x-bili-plugin-conversation": "child" }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages }) });
            const body = await response.text();
            assert.equal(response.status, 409, body);
            assert.equal(JSON.parse(body).code, "FORK_PREFIX_CONFLICT");
            assert.equal(h.forwarded.length, requests);
            assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=child")).body.parentRevision, child.parentRevision);
            assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=parent")).body.parentRevision, snapshot.parentRevision);
        }
        await sendModel(h, "child", [...h.messages.slice(0, 2), { role: "user", content: "valid retry" }]);
        assert(JSON.stringify(h.forwarded.at(-1)).includes(summary));
    } finally { await h.close(); }
});

test("HTTP persistence failure leaves no child and retry can succeed", async () => {
    const h = await harness();
    try {
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        const req = forkRequest(snapshot);
        writeFileSync(h.dir + "/not-a-directory", "failure fixture");
        const failedStore = new SessionStore({ dir: h.dir + "/not-a-directory", enabled: true, log: () => {} });
        _setStoreForTest(failedStore);
        const failed = await h.request("/__bili/plugin/fork", req);
        assert.equal(failed.status, 503);
        assert.equal(resolveConversation("child").session, undefined);
        assert.equal(failedStore.loadSync("child"), null);
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=child")).status, 404);
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=parent")).body.parentRevision, snapshot.parentRevision);
        _setStoreForTest(h.store);
        assert.equal((await h.request("/__bili/plugin/fork", req)).status, 201);
    } finally { _setStoreForTest(h.store); await h.close(); }
});

test("HTTP CCR deleted index fails closed in memory after persistence", async () => {
    const h = await harness(true);
    try {
        const parent = resolveConversation("parent").session!;
        parent.metadata.effectiveCcr = { ...DEFAULT_CCR_CONFIG, enabled: true };
        parent.contentStore = storeOriginal(createContentStore(), { ref: "m00001", rawId: parent.pluginSnapshot![0].id, text: "retained CCR original", kind: "original", tokens: 10, head: "retained" });
        parent.contentStoreDirty = true;
        assert(h.store.flushSync(parent));
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        delete parent.contentStore.byRef.m00001;
        const before = JSON.stringify({ state: parent.state, messages: parent.pluginSnapshot, store: parent.contentStore });
        const unavailable = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(unavailable.status, 409);
        assert.equal(unavailable.body.code, "SNAPSHOT_UNAVAILABLE");
        const fork = await h.request("/__bili/plugin/fork", forkRequest(snapshot));
        assert.equal(fork.status, 409);
        assert.equal(fork.body.status, "unavailable");
        assert.equal(resolveConversation("child").session, undefined);
        assert.equal(h.store.loadSync("child"), null);
        assert.equal(JSON.stringify({ state: parent.state, messages: parent.pluginSnapshot, store: parent.contentStore }), before);
    } finally { await h.close(); }
});

test("HTTP CCR shared payload deletion fails closed before persistence", async () => {
    const h = await harness();
    try {
        const parent = resolveConversation("parent").session!;
        let store = createContentStore();
        for (const [i, message] of parent.pluginSnapshot!.slice(0, 2).entries()) {
            store = storeOriginal(store, { ref: `m0000${i + 1}`, rawId: message.id, text: "shared payload", kind: "original", tokens: 10, head: "shared" });
        }
        parent.contentStore = store;
        rememberPluginMessages(parent.id, parent.pluginSnapshot!, parent.pluginSnapshot!);
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        delete store.byRef.m00001;
        const before = JSON.stringify(parent);
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=parent")).status, 409);
        assert.equal((await h.request("/__bili/plugin/fork", forkRequest(snapshot))).status, 409);
        assert.equal(resolveConversation("child").session, undefined);
        assert.equal(JSON.stringify(parent), before);
    } finally { await h.close(); }
});

for (const corruption of ["missing-ref", "missing-payload", "orphan-payload", "wrong-raw-alias", "changed-payload"] as const) {
    test(`HTTP CCR ${corruption} fails closed after cold disk restore`, async () => {
        const h = await harness(true);
        try {
            const parent = resolveConversation("parent").session!;
            let store = createContentStore();
            for (const [i, message] of parent.pluginSnapshot!.slice(0, 2).entries()) {
                store = storeOriginal(store, { ref: `m0000${i + 1}`, rawId: message.id, text: "shared payload", kind: "original", tokens: 10, head: "shared" });
            }
            parent.contentStore = store;
            parent.contentStoreDirty = true;
            // #2077 lazy persistence: the raw snapshot only lands in the record
            // once it is an external contract — pin that contract here so this
            // test still exercises the corrupted-store detection path.
            parent.metadata.publicSnapshotRetained = true;
            assert(h.store.flushSync(parent));
            const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
            const namespace = join(h.dir, "sessions", parent.meta.protocol!);
            const filename = readdirSync(namespace).find((name) => name.endsWith(".content-store.json"));
            assert(filename);
            const path = join(namespace, filename);
            const disk = JSON.parse(readFileSync(path, "utf8")) as typeof store;
            const payloadHash = disk.byRef.m00001!.hash;
            switch (corruption) {
                case "missing-ref": delete disk.byRef.m00001; break;
                case "missing-payload": delete disk.byHash[payloadHash]; break;
                case "orphan-payload": disk.byHash[createHash("sha256").update("orphan").digest("hex")] = "orphan"; break;
                case "wrong-raw-alias": disk.byRef.m00001!.rawId = parent.pluginSnapshot![1].id; break;
                case "changed-payload": disk.byHash[payloadHash] = "corrupted original"; break;
            }
            writeFileSync(path, JSON.stringify(disk));
            h.store.cancelAll();
            _resetSessionsForTest();
            _resetPluginStateForTest();
            const restored = getSession("parent");
            contentStoreOf(restored);
            const parentState = () => JSON.stringify({ state: restored.state, messages: restored.pluginSnapshot, metadata: restored.metadata, store: restored.contentStore });
            const before = parentState();
            assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=parent")).status, 409);
            const fork = await h.request("/__bili/plugin/fork", forkRequest(snapshot));
            assert.equal(fork.status, 409);
            assert.equal(fork.body.status, "unavailable");
            assert.equal(resolveConversation("child").session, undefined);
            assert.equal(h.store.loadSync("child"), null);
            assert.equal(parentState(), before);
            assert.equal(readFileSync(path, "utf8"), JSON.stringify(disk));
        } finally { await h.close(); }
    });
}

test("HTTP fork revision and originals survive a new proxy process", async () => {
    const h = await harness(true);
    let child: ReturnType<typeof spawn> | undefined;
    try {
        await compress(h);
        const parent = resolveConversation("parent").session!;
        parent.metadata.effectiveCcr = { ...DEFAULT_CCR_CONFIG, enabled: true };
        parent.contentStore = storeOriginal(createContentStore(), { ref: "m00001", rawId: parent.pluginSnapshot![0].id, text: "CCR original retained independently after restart", kind: "original", tokens: 10, head: "CCR original" });
        parent.contentStoreDirty = true;
        assert(h.store.flushSync(parent));
        assert.deepEqual(JSON.parse(JSON.stringify(h.store.loadSync("parent")!.state)), JSON.parse(JSON.stringify({ ...parent.state, imageFullRestored: parent.state.imageFullRestored ?? [], imageShrinks: parent.state.imageShrinks ?? [] })));
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        const req = forkRequest(snapshot);
        const fork = await h.request("/__bili/plugin/fork", req);
        assert.equal(fork.status, 201);
        const childSnapshot = (await h.request("/__bili/plugin/snapshot?conversationId=child")).body;
        const code = `import {startServer} from './src/server.ts'; import {SessionStore,_setStoreForTest} from './src/persist.ts'; import {defaultConfig} from 'acp-kernel'; import {_setForTest} from './src/registry.ts'; _setForTest({}); _setStoreForTest(new SessionStore({dir:${JSON.stringify(h.dir + "/sessions")},enabled:true})); const s=await startServer({port:0,host:'127.0.0.1',upstream:${JSON.stringify(h.upstreamUrl)},modelContextLimit:400000,routes:{},kernelConfig:defaultConfig(400000),compress:{injectTool:true,injectNudge:true},promptCache:{routing:'auto'},sessionHeader:'x-acp-session',log:false,debug:false,passthrough:false,autoUpdate:false,mitm:{enabled:false,domains:[]}}); const ready=()=>process.stdout.write(JSON.stringify({port:s.address().port})+'\\n'); if(s.listening)ready();else s.once('listening',ready);`;
        child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr!.on("data", (b) => { stderr += b.toString(); });
        const port = await new Promise<number>((resolve, reject) => {
            let stdout = "";
            const timer = setTimeout(() => reject(new Error("restart timeout: " + stderr + stdout)), 15000);
            child!.stdout!.on("data", (b) => {
                stdout += b.toString();
                const port = stdout.match(/\{"port":(\d+)\}/);
                if (port) { clearTimeout(timer); resolve(Number(port[1])); }
            });
            child!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`restart exited ${code}: ${stderr}`)); });
            child!.once("error", (error) => { clearTimeout(timer); reject(error); });
        });
        const call = async <Path extends string>(path: Path, body?: unknown) => {
            const r = await fetch(`http://127.0.0.1:${port}` + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
            return { status: r.status, body: await responseBody(r, path) };
        };
        const restored = await call("/__bili/plugin/snapshot?conversationId=child");
        const restoredStatus = await call("/__bili/plugin/status?conversationId=parent&fallback=latest");
        assert.equal(restoredStatus.status, 200);
        assert.equal(restoredStatus.body.sessionId, "parent");
        assert.equal(restoredStatus.body.fallback, undefined);
        assert.equal(restoredStatus.body.sessionRevision, snapshot.parentRevision);
        assert.equal(restoredStatus.body.contextTokensSource, "estimate");
        assert.equal(restored.status, 200);
        assert.equal(restored.body.parentRevision, childSnapshot.parentRevision);
        assert.deepEqual(restored.body.orderedMessages, childSnapshot.orderedMessages);
        assert.equal((await call("/__bili/plugin/snapshot?conversationId=parent")).body.parentRevision, snapshot.parentRevision);
        const replay = await call("/__bili/plugin/fork", req);
        assert.equal(replay.status, 200);
        assert.equal(replay.body.replayed, true);
        const retrieved = await call("/__bili/plugin/tool", { conversationId: "child", tool: "acp_retrieve", args: { ref: "m00001" } });
        assert.equal(retrieved.status, 200);
        assert.match(retrieved.body.result, /CCR original retained independently after restart/);
        const original = await call("/__bili/plugin/tool", { conversationId: "child", tool: "decompress", args: { blockId: "b1", full: true } });
        assert.match(original.body.result, /first original/);
        assert.match(original.body.result, /second original/);
        assert(!original.body.result.includes("tail original"));
    } finally {
        if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
        await h.close();
    }
});

test("HTTP status separates real usage from a manual-compression estimate and changing generation", async () => {
    const h = await harness();
    try {
        const before = await h.request("/__bili/plugin/status?conversationId=parent");
        assert.equal(before.body.contextTokensSource, "usage");
        assert.equal(before.body.contextTokens, 10000);
        assert(typeof before.body.contextTokensAt === "number");
        assert(before.body.contextTokensAt > 0);
        assert.equal(typeof before.body.contextGeneration, "string");
        assert(Array.isArray(before.body.compressibleRanges));
        assert(before.body.compressibleRanges.length > 0);
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        for (const range of before.body.compressibleRanges) {
            assert(snapshot.orderedMessages.some(message => message.ref === range.startRef));
            assert(snapshot.orderedMessages.some(message => message.ref === range.endRef));
            assert(Number.isInteger(range.count) && range.count > 0);
        }
        assert.equal(before.body.sessionRevision, snapshot.parentRevision);
        const again = await h.request("/__bili/plugin/status?conversationId=parent");
        assert.deepEqual(again.body.compressibleRanges, before.body.compressibleRanges);
        assert.equal(again.body.contextTokensAt, before.body.contextTokensAt);
        assert.equal(again.body.contextGeneration, before.body.contextGeneration);
        const compressed = await h.request("/__bili/plugin/tool", { conversationId: "parent", tool: "compress", args: { content: [{ startId: "m00001", endId: "m00002", summary: "The prefix preserves the first user request and the second assistant response, with all original content retained for decompression." }] } });
        assert.equal(compressed.status, 200);
        assert(!compressed.body.result.includes("FAILED"), compressed.body.result);
        const after = await h.request("/__bili/plugin/status?conversationId=parent");
        assert(after.body.compressCreditTokens > 0);
        assert.equal(after.body.contextTokensSource, "estimate");
        assert.equal(after.body.contextTokens, Math.max(0, 10000 - after.body.compressCreditTokens));
        assert(typeof after.body.contextTokensAt === "number");
        assert(after.body.contextTokensAt >= before.body.contextTokensAt);
        assert.notEqual(after.body.contextGeneration, before.body.contextGeneration);
        assert.equal(after.body.inputTokens, 10000);
        assert.equal(after.body.contextLimit, 400000);
    } finally { await h.close(); }
});

test("HTTP manual compression renews an idle context observation without changing billing", async () => {
    const h = await harness();
    const realNow = Date.now;
    try {
        const before = (await h.request("/__bili/plugin/status?conversationId=parent")).body;
        assert(typeof before.contextTokensAt === "number");
        const commitTime = realNow() + 16 * 60 * 1000;
        Date.now = () => commitTime;
        await compress(h);
        const after = (await h.request("/__bili/plugin/status?conversationId=parent")).body;
        assert.equal(after.contextTokensAt, commitTime);
        assert.equal(after.contextTokensSource, "estimate");
        assert.notEqual(after.contextGeneration, before.contextGeneration);
        assert(typeof after.contextTokens === "number" && typeof before.contextTokens === "number");
        assert(after.contextTokens < before.contextTokens);
        assert.equal(after.inputTokens, before.inputTokens);
        const repeated = (await h.request("/__bili/plugin/status?conversationId=parent")).body;
        assert.equal(repeated.contextTokensAt, commitTime);
        assert.equal(repeated.contextGeneration, after.contextGeneration);
    } finally {
        Date.now = realNow;
        await h.close();
    }
});

test("HTTP compressed child effective estimate survives cold disk restore without replaying credit", async () => {
    const h = await harness(true);
    try {
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        assert.equal((await h.request("/__bili/plugin/fork", forkRequest(snapshot, "child", 3))).status, 201);
        assert.equal(resolveConversation("child").session!.metadata.contextTokensAt, undefined);
        await compress(h, "child");
        const before = (await h.request("/__bili/plugin/status?conversationId=child")).body;
        assert.equal(before.contextTokensSource, "estimate");
        assert(before.compressCreditTokens > 0);
        assert(h.store.flushSync(resolveConversation("child").session!));
        _resetPluginStateForTest();
        _resetSessionsForTest();
        const after = (await h.request("/__bili/plugin/status?conversationId=child")).body;
        assert.equal(after.contextTokens, before.contextTokens);
        assert.equal(after.contextTokensAt, before.contextTokensAt);
        assert.equal(after.contextGeneration, before.contextGeneration);
        assert.equal(after.sessionRevision, before.sessionRevision);
        assert.equal(after.compressCreditTokens, 0);
        const restored = resolveConversation("child").session!;
        assert.equal(restored.stats.contextTokens, before.contextTokens);
        assert.equal(restored.stats.contextTokensSource, "estimate");
        assert(h.store.flushSync(restored));
        _resetPluginStateForTest();
        _resetSessionsForTest();
        assert.equal((await h.request("/__bili/plugin/status?conversationId=child")).body.contextTokens, before.contextTokens);
    } finally { await h.close(); }
});

test("HTTP manual compress rejects a stale expectedRevision under the session lock", async () => {
    const h = await harness();
    try {
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        const payload = { conversationId: "parent", tool: "compress", expectedRevision: snapshot.parentRevision, args: { content: [{ startId: "m00001", endId: "m00002", summary }] } };
        const results = await Promise.all([h.request("/__bili/plugin/tool", payload), h.request("/__bili/plugin/tool", payload)]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal(results.find((r) => r.status === 409)!.body.code, "PARENT_REVISION_CONFLICT");
        assert.equal(resolveConversation("parent").session!.state.blocks.length, 1);
    } finally { await h.close(); }
});

test("HTTP missing nested originals and CCR payloads fail closed without publishing a child", async () => {
    const h = await harness();
    try {
        await compress(h);
        const parent = resolveConversation("parent").session!;
        parent.blockContents.delete("b1");
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        const result = await h.request("/__bili/plugin/fork", forkRequest(snapshot));
        assert.equal(result.status, 409);
        assert.equal(result.body.status, "unavailable");
        assert.equal(result.body.code, "PARENT_STATE_INCOMPLETE");
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=child")).status, 404);
        parent.contentStore = storeOriginal(createContentStore(), { ref: "m00001", rawId: parent.pluginSnapshot![0].id, text: "missing CCR fixture", kind: "original", tokens: 10, head: "missing CCR" });
        delete parent.contentStore.byHash[parent.contentStore.byRef.m00001.hash];
        const missingCcr = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(missingCcr.status, 409);
        assert.equal(missingCcr.body.code, "SNAPSHOT_UNAVAILABLE");
        assert.equal((await h.request("/__bili/plugin/fork", forkRequest(snapshot))).body.status, "unavailable");
    } finally { await h.close(); }
});

async function sendModel(h: Awaited<ReturnType<typeof harness>>, conversationId: string, messages: unknown[]) {
    const response = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": conversationId }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages }) });
    assert.equal(response.status, 200, await response.text());
}

test("HTTP multimodal snapshots are explicitly unavailable, not text-only matches", async () => {
    const h = await harness();
    try {
        const before = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        await sendModel(h, "parent", [...h.messages, { role: "user", content: [{ type: "text", text: "inspect the image" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] }]);
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(snapshot.status, 409);
        assert.equal(snapshot.body.status, "unavailable");
        assert.equal(snapshot.body.code, "SNAPSHOT_UNAVAILABLE");
        const fork = await h.request("/__bili/plugin/fork", forkRequest(before));
        assert.equal(fork.status, 409);
        assert.equal(fork.body.status, "unavailable");
        assert.equal(resolveConversation("child").session, undefined);
    } finally { await h.close(); }
});

test("HTTP CCR foreign placeholder ref cannot publish an exact empty-store child", async () => {
    const h = await harness(true);
    try {
        const baseline = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        const placeholder = buildStoredPlaceholder({ ref: "m00077", kind: "original", tokens: 100, head: "missing original", retrieveToolName: "acp_retrieve" });
        await sendModel(h, "foreign-placeholder", [{ role: "user", content: placeholder }, { role: "assistant", content: "retained tail" }]);
        const parent = resolveConversation("foreign-placeholder").session!;
        assert.equal(parent.state.messageRefs.byRaw[parent.pluginSnapshot![0].id], "m00001");
        assert.deepEqual(contentStoreOf(parent).byRef, {});
        const state = () => JSON.stringify({ state: parent.state, messages: parent.pluginSnapshot, metadata: parent.metadata, store: parent.contentStore });
        const before = state();
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=foreign-placeholder");
        assert.equal(snapshot.status, 409, JSON.stringify(snapshot.body));
        assert.equal(snapshot.body.code, "SNAPSHOT_UNAVAILABLE");
        const fork = await h.request("/__bili/plugin/fork", { ...forkRequest(baseline), parentConversationId: "foreign-placeholder" });
        assert.equal(fork.status, 409, JSON.stringify(fork.body));
        assert.equal(fork.body.status, "unavailable");
        assert.equal(resolveConversation("child").session, undefined);
        assert.equal(h.store.loadSync("child"), null);
        assert.equal(state(), before);
    } finally { await h.close(); }
});

for (const content of [null, "audio transcript"] as const) {
    test(`HTTP OpenAI assistant audio with ${content === null ? "null" : "text"} content is unavailable`, async () => {
        const h = await harness(true);
        try {
            const baseline = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
            const messages = [{ role: "user", content: "review the audio" }, { role: "assistant", content, audio: { id: "audio_fixture" } }, { role: "user", content: "continue" }];
            const response = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": "audio-parent" }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages }) });
            assert.equal(response.status, 200, await response.text());
            const parent = resolveConversation("audio-parent").session!;
            contentStoreOf(parent);
            const state = () => JSON.stringify({ state: parent.state, messages: parent.pluginSnapshot, metadata: parent.metadata, store: parent.contentStore });
            const before = state();
            const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=audio-parent");
            assert.equal(snapshot.status, 409, JSON.stringify(snapshot.body));
            assert.equal(snapshot.body.code, "SNAPSHOT_UNAVAILABLE");
            assert.equal(parent.metadata.publicSnapshotTextComparable, false);
            const fork = await h.request("/__bili/plugin/fork", { ...forkRequest(baseline), parentConversationId: "audio-parent" });
            assert.equal(fork.status, 409, JSON.stringify(fork.body));
            assert.equal(fork.body.status, "unavailable");
            assert.equal(resolveConversation("child").session, undefined);
            assert.equal(h.store.loadSync("child"), null);
            assert.equal(state(), before);
        } finally { await h.close(); }
    });
}

test("HTTP fork before absorb summary preserves the original pair on the first child request", async () => {
    const h = await harness();
    try {
        const toolOutput = "unique original build output ".repeat(250);
        const history = [
            { role: "user", content: "build the project" },
            { role: "assistant", content: [{ type: "tool_use", id: "build_1", name: "bash", input: { command: "npm test" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "build_1", content: toolOutput }] },
            { role: "assistant", content: [{ type: "tool_use", id: "absorb_1", name: "acp_absorb", input: { ref: "m00006", summary: "Build succeeded with all original checks." } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "absorb_1", content: "absorption recorded ".repeat(40) }] },
            { role: "assistant", content: "build complete" },
            { role: "user", content: "continue" },
        ];
        await sendModel(h, "parent", history);
        const parent = resolveConversation("parent").session!;
        const result = parent.pluginSnapshot!.find((m) => m.contentType === "tool-result" && m.toolCallId === "build_1")!;
        const outcome = applyAbsorb({ ref: parent.state.messageRefs.byRaw[result.id], summary: "Build succeeded with all original checks.", absorbCallId: "absorb_1", messages: parent.pluginSnapshot!, state: parent.state, config: { ...defaultConfig(400000), absorb: { ...DEFAULT_ABSORB_CONFIG, enabled: true, toolName: "acp_absorb" } } });
        assert.equal(outcome.ok, true, outcome.resultText);
        parent.state = outcome.state;
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        assert.equal((await h.request("/__bili/plugin/fork", forkRequest(snapshot, "before-absorb", 3))).status, 201);
        await sendModel(h, "before-absorb", [...history.slice(0, 3), { role: "assistant", content: "child continues before absorption" }]);
        const beforeView = JSON.stringify(h.forwarded.at(-1)!.messages);
        assert.match(beforeView, /unique original build output/);
        assert.match(beforeView, /build_1/);
        assert.deepEqual(resolveConversation("before-absorb").session!.state.absorbed, []);
        assert.equal(parent.state.absorbed!.length, 1);
        assert.equal((await h.request("/__bili/plugin/fork", forkRequest(snapshot, "after-absorb", 5))).status, 201);
        await sendModel(h, "after-absorb", [...history.slice(0, 5), { role: "assistant", content: "child continues after absorption" }]);
        const afterView = JSON.stringify(h.forwarded.at(-1)!.messages);
        assert(!afterView.includes("unique original build output"), afterView);
        assert.match(afterView, /Build succeeded with all original checks/);
        const after = resolveConversation("after-absorb").session!;
        assert.equal(after.state.absorbed!.length, 1);
        assert.notEqual(after.state.absorbed![0], parent.state.absorbed![0]);
        const carrier = parent.pluginSnapshot!.find((m) => m.contentType === "tool-call" && m.toolCallId === "absorb_1")!;
        const carrierResult = parent.pluginSnapshot!.find((m) => m.contentType === "tool-result" && m.toolCallId === "absorb_1")!;
        const hiddenCarrier = await h.request("/__bili/plugin/tool", { conversationId: "parent", tool: "compress", args: { content: [{ startId: parent.state.messageRefs.byRaw[carrier.id], endId: parent.state.messageRefs.byRaw[carrierResult.id], summary }] } });
        assert.equal(hiddenCarrier.status, 200);
        assert(!hiddenCarrier.body.result.includes("FAILED"), hiddenCarrier.body.result);
        const hiddenSnapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        assert.equal((await h.request("/__bili/plugin/fork", forkRequest(hiddenSnapshot, "hidden-carrier", 5))).status, 201);
        assert.deepEqual(resolveConversation("hidden-carrier").session!.state.absorbed, []);
        await sendModel(h, "hidden-carrier", [...history.slice(0, 5), { role: "assistant", content: "child continues with hidden summary carrier" }]);
        assert.match(JSON.stringify(h.forwarded.at(-1)!.messages), /unique original build output/);
        const blockSummary = `${summary} Build succeeded with all original checks.`;
        const folded = await h.request("/__bili/plugin/tool", { conversationId: "parent", tool: "compress", args: { content: [{ startId: parent.state.messageRefs.byRaw[parent.pluginSnapshot![0].id], endId: parent.state.messageRefs.byRaw[result.id], summary: blockSummary }] } });
        assert.equal(folded.status, 200);
        assert(!folded.body.result.includes("FAILED"), folded.body.result);
        const foldedSnapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        assert.equal((await h.request("/__bili/plugin/fork", forkRequest(foldedSnapshot, "block-summary", 3))).status, 201);
        const blockChild = resolveConversation("block-summary").session!;
        assert.equal(blockChild.state.absorbed!.length, 1);
        assert.equal(blockChild.state.blocks.length, 1);
        await sendModel(h, "block-summary", [...history.slice(0, 3), { role: "assistant", content: "child continues with block summary" }]);
        const blockView = JSON.stringify(h.forwarded.at(-1)!.messages);
        assert.match(blockView, /Build succeeded with all original checks/);
        assert(!blockView.includes("unique original build output"), blockView);
    } finally { await h.close(); }
});

test("HTTP different parents racing the same child publish exactly one identity", async () => {
    const h = await harness();
    try {
        await sendModel(h, "other-parent", h.messages);
        const a = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        const b = (await h.request("/__bili/plugin/snapshot?conversationId=other-parent")).body;
        const requestA = forkRequest(a);
        const requestB = { ...forkRequest(b), parentConversationId: "other-parent" };
        const responses = await Promise.all([h.request("/__bili/plugin/fork", requestA), h.request("/__bili/plugin/fork", requestB)]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
        assert.equal(responses.find((r) => r.status === 409)!.body.code, "CHILD_CONFLICT");
        assert.equal(resolveConversation("child").session!.metadata.parentConversationId, responses[0].status === 201 ? "parent" : "other-parent");
    } finally { await h.close(); }
});

test("HTTP fork registration and first model append preserve inherited state and refs", async () => {
    const h = await harness();
    try {
        await compress(h);
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        assert.equal((await h.request("/__bili/plugin/fork", forkRequest(snapshot))).status, 201);
        assert.equal((await h.request("/__bili/plugin/register", { conversationId: "child", agent: "test", identity: true, parentConversationId: "parent" })).status, 200);
        await sendModel(h, "child", [...h.messages.slice(0, 2), { role: "assistant", content: "the final response can arrive after the fork" }, { role: "user", content: "child continuation" }]);
        const child = resolveConversation("child").session!;
        assert.equal(child.id, "child");
        assert.equal(child.state.blocks[0].summary, summary);
        assert.equal(child.metadata.derivedFromSessionId, undefined);
        const after = (await h.request("/__bili/plugin/snapshot?conversationId=child")).body;
        assert.deepEqual(after.orderedMessages.slice(0, 2), snapshot.orderedMessages.slice(0, 2));
        assert.notEqual(after.orderedMessages[2].ref, snapshot.orderedMessages[2].ref);
        const original = await h.request("/__bili/plugin/tool", { conversationId: "child", tool: "decompress", args: { blockId: "b1", full: true } });
        assert.match(original.body.result, /first original/);
    } finally { await h.close(); }
});

test("HTTP nested summaries expand crossing ancestors and retain independent original caches", async () => {
    const h = await harness(true);
    try {
        const history = [...h.messages, { role: "assistant", content: "third response ".repeat(250) }, { role: "user", content: "fourth user turn ".repeat(250) }, { role: "assistant", content: "retained recent tail" }];
        await sendModel(h, "parent", history);
        await compress(h);
        await compress(h, "parent", "b1", "m00005");
        const parent = resolveConversation("parent").session!;
        assert.equal(parent.state.blocks.length, 2);
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        const exact = await h.request("/__bili/plugin/fork", forkRequest(snapshot, "nested", 5));
        assert.equal(exact.status, 201, JSON.stringify(exact.body));
        assert.equal(exact.body.status, "exact");
        assert.equal(exact.body.inheritedBlocks.length, 2);
        const restored = h.store.loadSync("nested")!;
        assert.deepEqual(restored.state.blocks, JSON.parse(JSON.stringify(resolveConversation("nested").session!.state.blocks)));
        assert.deepEqual(restored.blockContents, resolveConversation("nested").session!.blockContents);
        const expanded = await h.request("/__bili/plugin/fork", forkRequest(snapshot, "nested-prefix", 2));
        assert.equal(expanded.status, 201, JSON.stringify(expanded.body));
        assert.equal(expanded.body.status, "expanded");
        assert.deepEqual(expanded.body.expandedBlocks, ["b2"]);
        assert.equal(resolveConversation("nested-prefix").session!.state.blocks[0].expanded, true);
        assert.equal((await h.request("/__bili/plugin/fork", forkRequest(snapshot, "nested-sibling", 5))).status, 201);
        for (const id of ["nested", "nested-sibling"]) {
            await sendModel(h, id, [...history.slice(0, 5), { role: "assistant", content: `${id} first continuation` }]);
            const outbound = JSON.stringify(h.forwarded.at(-1)!.messages);
            assert(outbound.includes(summary), outbound);
            assert(outbound.includes(`${id} first continuation`), outbound);
            // Kernel prune preserves the first user anchor even when its block is folded.
            assert.match(outbound, /first original/);
            assert(!outbound.includes("second original"), outbound);
            assert(!outbound.includes("third response"), outbound);
            assert(!outbound.includes("retained recent tail"), outbound);
            const continued = (await h.request(`/__bili/plugin/snapshot?conversationId=${id}`)).body;
            assert.deepEqual(continued.orderedMessages.slice(0, 5), snapshot.orderedMessages.slice(0, 5));
            assert.equal(resolveConversation(id).session!.state.blocks[1].summary, summary);
            assert.equal(resolveConversation(id).session!.state.blocks[1].active, true);
        }
        assert.notEqual(resolveConversation("nested").session!.pluginSnapshot![5].text, resolveConversation("nested-sibling").session!.pluginSnapshot![5].text);
        assert.notEqual(resolveConversation("nested").session!.blockContents.get("b2"), resolveConversation("nested-sibling").session!.blockContents.get("b2"));
        await sendModel(h, "nested-prefix", [...history.slice(0, 2), { role: "user", content: "expanded nested first continuation" }]);
        const prefixOutbound = JSON.stringify(h.forwarded.at(-1)!.messages);
        assert.match(prefixOutbound, /first original/);
        assert.match(prefixOutbound, /second original/);
        assert(!prefixOutbound.includes("third response"), prefixOutbound);
        assert(!prefixOutbound.includes("retained recent tail"), prefixOutbound);
        assert(!prefixOutbound.includes(summary), prefixOutbound);
        assert.notEqual(parent.state.blocks[1].expanded, true);
        assert.notEqual(resolveConversation("nested-sibling").session!.state.blocks[1].expanded, true);
        const original = await h.request("/__bili/plugin/tool", { conversationId: "nested", tool: "decompress", args: { blockId: "b2", full: true } });
        const file = original.body.result.match(/written to: (.+)\n/)?.[1];
        const text = file ? readFileSync(file, "utf8") : original.body.result;
        if (file) rmSync(file, { force: true });
        assert.match(text, /first original/);
        assert.match(text, /third response/);
        assert(!text.includes("retained recent tail"));
        assert.notEqual(resolveConversation("nested").session!.state.blocks[1].directBlockIds, parent.state.blocks[1].directBlockIds);
    } finally { await h.close(); }
});

test("HTTP raw-snapshot retention cap fails closed instead of growing without bound (D-B)", async () => {
    // #2016 review: without a cap every plugin session retains its full raw
    // history forever. With BILI_PUBLIC_SNAPSHOT_CAP_BYTES set tiny, the
    // session refuses to retain the snapshot and the public endpoints answer
    // 409 SNAPSHOT_UNAVAILABLE with the capped reason — never a stale guess.
    const previous = process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES;
    process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES = "1";
    const h = await harness();
    try {
        const session = resolveConversation("parent").session!;
        assert.equal(session.pluginSnapshot, undefined, "an over-cap raw snapshot must not be retained");
        assert.equal(session.metadata.publicSnapshotCapped, true);
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(snapshot.status, 409);
        assert.equal((snapshot.body as { error?: string }).error, "Error: raw snapshot exceeded the retention cap (BILI_PUBLIC_SNAPSHOT_CAP_BYTES); fork is refused rather than retaining an unbounded raw copy");
        const fork = await h.request("/__bili/plugin/fork", { protocolVersion: 1, parentConversationId: "parent", childConversationId: "child", parentRevision: "a".repeat(64), branchPoint: { messageCount: 0, orderHash: createHash("sha256").update("[]").digest("hex") }, orderedMessages: [], idempotencyKey: "op-1" });
        assert.equal(fork.status, 409);
        assert.equal(fork.body.code, "SNAPSHOT_UNAVAILABLE");
    } finally {
        if (previous === undefined) delete process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES;
        else process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES = previous;
        await h.close();
    }
});

test("HTTP raw-snapshot retention cap lifts when the raw history shrinks below it again", async () => {
    const previous = process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES;
    process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES = "1";
    const h = await harness();
    try {
        const session = getSession("cap-recover");
        session.metadata.pluginAgent = "test";
        const messages = [{ id: "cap-recovered", role: "user" as const, contentType: "text" as const, text: "resending the whole history keeps ids stable" }];
        rememberPluginMessages(session.id, messages, messages);
        assert.equal(session.pluginSnapshot, undefined);
        assert.equal(session.metadata.publicSnapshotCapped, true);
        process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES = String(64 * 1024 * 1024);
        rememberPluginMessages(session.id, messages, messages);
        const recovered: unknown = session.pluginSnapshot;
        assert.equal(Array.isArray(recovered) && recovered.length, 1, "an under-cap resend must restore the retained snapshot");
        assert.equal(session.metadata.publicSnapshotCapped, undefined);
    } finally {
        if (previous === undefined) delete process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES;
        else process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES = previous;
        await h.close();
    }
});

// #2077 regression oracle: exact replica of src/plugin.ts stableJson — the
// tracked byte count must always equal the canonical serialization length.
function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

test("HTTP CoW snapshot extends in place with an exactly-tracked byte count", async () => {
    const h = await harness();
    try {
        const session = resolveConversation("parent").session!;
        const base = session.pluginSnapshot!;
        const baseBytes = session.metadata.publicSnapshotBytes as number;
        assert(Number.isFinite(baseBytes), "the first write must track the exact canonical size");
        assert.equal(baseBytes, stableJson(base).length);
        await sendModel(h, "parent", [...h.messages, { role: "assistant", content: "cow tail response" }, { role: "user", content: "cow tail follow-up" }]);
        assert.equal(session.pluginSnapshot, base, "a pure extension must reuse the stored array instead of re-cloning the history");
        assert.equal(base.length, 5);
        assert.equal(base[3].text, "cow tail response");
        assert.equal(base[4].text, "cow tail follow-up");
        assert.equal(session.metadata.publicSnapshotBytes, stableJson(base).length, "incremental accounting must stay exact");
        await sendModel(h, "parent", [...h.messages, { role: "assistant", content: "cow tail response" }, { role: "user", content: "cow tail follow-up" }]);
        assert.equal(session.pluginSnapshot, base);
        assert.equal(base.length, 5);
        assert.equal(session.metadata.publicSnapshotBytes, stableJson(base).length);
    } finally { await h.close(); }
});

test("HTTP legacy snapshots are remeasured once, then no-op resends stay O(1) while the cap keeps re-evaluating", async () => {
    const h = await harness();
    try {
        const session = getSession("legacy-cap");
        session.metadata.pluginAgent = "test";
        const messages = [{ id: "legacy-one", role: "user" as const, contentType: "text" as const, text: "legacy snapshot payload" }, { id: "legacy-two", role: "assistant" as const, contentType: "text" as const, text: "legacy second payload" }];
        session.pluginSnapshot = structuredClone(messages);
        const epochOf = () => session.revisionEpoch ?? 0;
        const epochBefore = epochOf();
        rememberPluginMessages(session.id, messages, messages);
        assert.equal(typeof session.metadata.publicSnapshotBytes, "number", "a legacy record must gain its byte count on the next change");
        const bytes = session.metadata.publicSnapshotBytes as number;
        assert.equal(bytes, stableJson(messages).length);
        assert.equal(epochOf(), epochBefore + 1, "the one-time measurement marks dirty exactly once");
        rememberPluginMessages(session.id, messages, messages);
        assert.equal(epochOf(), epochBefore + 1, "a tracked identical resend must not mark dirty");
        const previous = process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES;
        process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES = String(Math.max(1, bytes - 1));
        try {
            rememberPluginMessages(session.id, messages, messages);
            assert.equal(session.pluginSnapshot, undefined, "a knob shrink must drop the snapshot even without history change");
            assert.equal(session.metadata.publicSnapshotCapped, true);
        } finally {
            if (previous === undefined) delete process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES;
            else process.env.BILI_PUBLIC_SNAPSHOT_CAP_BYTES = previous;
        }
    } finally { await h.close(); }
});

test("HTTP the raw snapshot persists only once a fork makes it an external contract", async () => {
    const h = await harness(true);
    try {
        const parent = resolveConversation("parent").session!;
        assert(h.store.flushSync(parent));
        const beforeFork = h.store.loadSync("parent") as { pluginSnapshot?: unknown[]; metadata?: Record<string, unknown> } | null;
        assert(beforeFork);
        assert.equal(beforeFork.pluginSnapshot, undefined, "non-forking sessions must not pay the snapshot disk cost (#2077)");
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body;
        assert.equal((await h.request("/__bili/plugin/fork", forkRequest(snapshot))).status, 201);
        const afterFork = h.store.loadSync("parent") as { pluginSnapshot?: unknown[]; metadata?: Record<string, unknown> } | null;
        assert(afterFork);
        assert(Array.isArray(afterFork.pluginSnapshot) && afterFork.pluginSnapshot!.length === 3, "a forked parent must persist its raw snapshot");
        assert.equal(afterFork.metadata?.publicSnapshotRetained, true);
    } finally { await h.close(); }
});

test("HTTP a mid-history rewrite replaces the snapshot wholesale with an exact byte count", async () => {
    const h = await harness();
    try {
        const session = resolveConversation("parent").session!;
        const before = session.pluginSnapshot!;
        await sendModel(h, "parent", [...h.messages.slice(0, 2), { role: "user", content: "replacement third message" }]);
        const replaced = session.pluginSnapshot!;
        assert.notEqual(replaced, before, "a rewritten prefix must rebuild the snapshot, not extend it");
        assert.equal(replaced.length, 3);
        assert.equal(replaced[2].text, "replacement third message");
        assert.notEqual(replaced[2].id, before[2].id, "changed content changes the derived id, proving the replacement path ran");
        assert.equal(session.metadata.publicSnapshotBytes, stableJson(replaced).length);
    } finally { await h.close(); }
});

test("HTTP a lazily-persisted snapshot self-heals on the next model request after restart", async () => {
    const h = await harness(true);
    try {
        const parent = resolveConversation("parent").session!;
        assert(h.store.flushSync(parent));
        h.store.cancelAll();
        _resetSessionsForTest();
        _resetPluginStateForTest();
        const restored = getSession("parent");
        assert.equal(restored.pluginSnapshot, undefined, "a non-forked session restores without its raw snapshot");
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=parent")).status, 409);
        await sendModel(h, "parent", h.messages);
        assert.equal((await h.request("/__bili/plugin/snapshot?conversationId=parent")).status, 200);
        assert.equal(resolveConversation("parent").session!.pluginSnapshot!.length, 3);
    } finally { await h.close(); }
});
