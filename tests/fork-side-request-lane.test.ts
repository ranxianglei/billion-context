import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";

// #388/#2157 follow-up: side requests under a PUBLIC-FORK child must ride the
// #388 passthrough, never the full pipeline. #2157 keyed side requests
// verbatim (sideRequestLike) but left the lane's !publicForkPrefix veto in
// place, so a full-history-replaying title-gen under an anchored fork child
// ran processTurn on the child's MAIN session: junk turns into the snapshot,
// usage-baseline pollution (#1916 class), stats inflation. Pre-#2157 the same
// request forked onto an isolated `|sub:<fp>` junk session (ugly but clean).
// dsh title-gen is the realistic trigger: the host resends the ENTIRE current
// history plus the title instruction (so the inherited-prefix receipt always
// matches), on the anthropic wire (top-level system, messages replay raw).
process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-fork-side-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(req.url?.endsWith("/chat/completions")
                    ? { id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }
                    : { id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.close(); } }));
    });
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstream.url, routes: { [upstream.url]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const request = async (path: string, body?: unknown) => {
        const r = await fetch(origin + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() };
    };
    const messages = [
        { role: "user", content: "first original ".repeat(250) },
        { role: "assistant", content: "second original ".repeat(250) },
        { role: "user", content: "tail original" },
    ];
    // seed the parent on the ANTHROPIC wire (/v1/messages, top-level system) — dsh plugin lane
    const r = await fetch(`${origin}/bili/${upstream.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "parent", "x-bili-plugin-agent": "main" }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, system: "MAIN OPERATING SYSTEM", messages }) });
    assert.equal(r.status, 200);
    await r.text();
    // dsh-shaped request sender (anthropic wire: system is TOP-LEVEL, messages replay the raw conversation)
    const dshSend = async (conversationId: string, msgs: unknown[], agent: string, system: string, maxTokens = 1024) => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId, "x-bili-plugin-agent": agent };
        const response = await fetch(`${origin}/bili/${upstream.url}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ model: "claude-test", max_tokens: maxTokens, stream: false, system, messages: msgs }) });
        assert.equal(response.status, 200, await response.text());
    };
    return { request, messages, forwarded, dshSend, upstreamUrl: upstream.url, origin, close: async () => { store.cancelAll(); proxy.close(); upstream.close(); await new Promise((r2) => setTimeout(r2, 50)); } };
}

test("fork-child title-gen rides the #388 passthrough and never pollutes the child's main session", async () => {
    const h = await harness();
    try {
        // 1. fork parent -> child at the full 3-message prefix
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body as { status: string; parentRevision: string; orderedMessages: unknown[] };
        assert.ok(snapshot.status !== "error");
        const orderedMessages = snapshot.orderedMessages.slice(0, 3);
        const fork = await h.request("/__bili/plugin/fork", { protocolVersion: 1, parentConversationId: "parent", childConversationId: "forkchild", parentRevision: snapshot.parentRevision, branchPoint: { messageCount: 3, orderHash: hash(orderedMessages) }, orderedMessages, idempotencyKey: "fork-title-1" });
        assert.equal(fork.status, 201, JSON.stringify(fork.body));

        // 2. first child MAIN turn (dsh main persona) — anchors the child id with the main system
        const history = [...h.messages, { role: "assistant", content: "child continuation" }, { role: "user", content: "next question" }];
        await h.dshSend("forkchild", history, "main", "MAIN OPERATING SYSTEM", 256);
        const session = resolveConversation("forkchild").session!;
        assert.ok(session, "child session exists");
        assert.ok(session.metadata.publicForkReceipt !== undefined, "fork receipt recorded on the child session");
        const requestsBefore = session.stats.requests;
        const revBefore = ((await h.request("/__bili/plugin/snapshot?conversationId=forkchild")).body as { parentRevision: string }).parentRevision;
        const statusBefore = (await h.request("/__bili/plugin/status?conversationId=forkchild")).body as { contextTokens: number | null; inputTokens: number };

        // 3. title-gen under the SAME fork child (dsh side persona), replaying the
        //    FULL current child history + title instruction (realistic dsh shape).
        const titleMessages = [...history, { role: "user", content: "Generate a title." }];
        const upstreamHitsBefore = h.forwarded.length;
        await h.dshSend("forkchild", titleMessages, "title", "You generate short titles.", 1024);
        assert.equal(h.forwarded.length, upstreamHitsBefore + 1, "title request still reaches the upstream");

        const requestsAfter = session.stats.requests;
        const revAfter = ((await h.request("/__bili/plugin/snapshot?conversationId=forkchild")).body as { parentRevision: string }).parentRevision;
        const statusAfter = (await h.request("/__bili/plugin/status?conversationId=forkchild")).body as { contextTokens: number | null; inputTokens: number };
        assert.equal(requestsAfter, requestsBefore, `title-gen must not count as a fork-child main request (${requestsBefore} -> ${requestsAfter})`);
        assert.equal(revAfter, revBefore, `title-gen must not grow the fork-child session snapshot (${revBefore} -> ${revAfter})`);
        assert.equal(statusAfter.inputTokens, statusBefore.inputTokens, "title-gen must not touch the fork-child usage baseline");
        assert.equal(statusAfter.contextTokens, statusBefore.contextTokens, "title-gen must not touch the fork-child context estimate");
        assert.ok(!JSON.stringify(session.pluginSnapshot).includes("Generate a title."), "title instruction never lands in the child's kernel session");
        const titleForward = h.forwarded.at(-1)! as { messages?: { content: unknown }[] };
        assert.ok(titleForward.messages?.some((m) => JSON.stringify(m.content).includes("Generate a title.")), "the forwarded title request carries the title instruction");

        // 4. the child's NEXT main turn still runs the full pipeline (no over-diversion):
        //    agent=main is never side, so the fork child keeps compressing normally.
        await h.dshSend("forkchild", [...titleMessages, { role: "assistant", content: "A Title" }, { role: "user", content: "continue working" }], "main", "MAIN OPERATING SYSTEM", 256);
        assert.equal(session.stats.requests, requestsBefore + 1, "the next main turn DOES count as a fork-child main request");
    } finally {
        await h.close();
    }
});

test("an advisory-adopted first request that is a declared side request still rides the #388 passthrough (#3741)", async () => {
    const h = await harness();
    try {
        // 1. fork parent -> child at the full 3-message prefix
        const snapshot = (await h.request("/__bili/plugin/snapshot?conversationId=parent")).body as { status: string; parentRevision: string; orderedMessages: unknown[] };
        assert.ok(snapshot.status !== "error");
        const orderedMessages = snapshot.orderedMessages.slice(0, 3);
        const fork = await h.request("/__bili/plugin/fork", { protocolVersion: 1, parentConversationId: "parent", childConversationId: "forkchild", parentRevision: snapshot.parentRevision, branchPoint: { messageCount: 3, orderHash: hash(orderedMessages) }, orderedMessages, idempotencyKey: "fork-title-adopted" });
        assert.equal(fork.status, 201, JSON.stringify(fork.body));
        const revBefore = ((await h.request("/__bili/plugin/snapshot?conversationId=forkchild")).body as { parentRevision: string }).parentRevision;

        // 2. FIRST child request is a dsh title-gen shape (agent=title) whose replayed history
        //    DRIFTS from the inherited prefix. Pre-#3757 this 409'd forever; now the advisory gate
        //    adopts it — and declared side intent must STILL divert it to the #388 passthrough
        //    (publicForkPrefix stays false on mismatch, so the lane heuristics keep their say).
        const driftedHistory = h.messages.map((m, i) => i === 0 ? { ...m, content: "drifted first message" } : m);
        const titleMessages = [...driftedHistory, { role: "assistant", content: "child continuation" }, { role: "user", content: "Generate a title." }];
        const upstreamHitsBefore = h.forwarded.length;
        await h.dshSend("forkchild", titleMessages, "title", "You generate short titles.", 1024);
        assert.equal(h.forwarded.length, upstreamHitsBefore + 1, "adopted side request still reaches the upstream");

        const session = resolveConversation("forkchild").session!;
        assert.ok(session.metadata.publicForkReceipt !== undefined, "fork receipt recorded on the child session");
        assert.equal(session.stats.requests, 0, "a declared side request never counts as a fork-child main request, even when adopted");
        const revAfter = ((await h.request("/__bili/plugin/snapshot?conversationId=forkchild")).body as { parentRevision: string }).parentRevision;
        assert.equal(revAfter, revBefore, "adopted title-gen must not grow the fork-child session snapshot");
        assert.ok(!JSON.stringify(session.pluginSnapshot).includes("Generate a title."), "title instruction never lands in the child's kernel session");
        const titleForward = h.forwarded.at(-1)! as { messages?: { content: unknown }[] };
        assert.ok(titleForward.messages?.some((m) => JSON.stringify(m.content).includes("Generate a title.")), "the forwarded title request carries the title instruction");

        // 3. the child's first MAIN turn afterwards still runs the full pipeline normally:
        //    the adoption was one-shot advisory signal, not a lane reclassification.
        await h.dshSend("forkchild", [...titleMessages, { role: "assistant", content: "A Title" }, { role: "user", content: "continue working" }], "main", "MAIN OPERATING SYSTEM", 256);
        assert.equal(session.stats.requests, 1, "the next main turn counts as a fork-child main request");
    } finally {
        await h.close();
    }
});
