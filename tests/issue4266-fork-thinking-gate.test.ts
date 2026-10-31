// #4266 mechanism 1 — the fork "thinking hard gate": any parent whose
// history carries thinking mass got 409 SNAPSHOT_UNAVAILABLE on EVERY
// fork/snapshot/status-poll call, so extended-thinking sessions (claude
// thinking blocks on the wire, or host-projected thinkingTokens metering)
// could never fork at all. Root: comparableHistory's block allow-list lacked
// the thinking family, and forkSnapshot refused snapshots carrying
// thinkingTokens. Both are comparable-by-view (anthropicToCore projects a
// thinking block to a named reasoning message; thinkingTokens is a numeric
// metering field forkMessageIdentityHash already digests), so the gate is
// gone. Pins both directions (#3617): thinking parents fork (snapshot 200,
// fork 201, grandchild fork 201, child follow-up round-trip 200, stamped
// thinkingTokens cells fork too), responses-wire typed reasoning items fork
// too, while genuinely uncomparable content (image blocks, payload-less
// thinking blocks) still refuses with SNAPSHOT_UNAVAILABLE. Fork identity
// itself pins both sides of the metering/signature split: a stamped
// signature-only cell passes the child's first-request prefix gate
// (one-sided thinkingTokens must not read as drift), while a rotated
// signature under an unchanged id DOES read as hash-drift-under-same-id.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _resetPluginStateForTest, publicForkInputCheck, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { closeServers } from "./server-close-guard.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-issue4266-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

interface SnapshotBody {
    status: string;
    code?: string;
    error?: string;
    parentRevision: string;
    orderedMessages: { rawId: string; ref: string; identityHash: string }[];
    messages: { contentType?: string }[];
}

interface ForkBody {
    ok?: boolean;
    status?: string;
    code?: string;
    error?: string;
    childConversationId?: string;
}

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            void chunks;
            res.writeHead(200, { "content-type": "application/json" });
            if (req.url?.endsWith("/v1/responses")) {
                res.end(JSON.stringify({ id: "resp_1", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }], usage: { input_tokens: 10000, output_tokens: 10 } }));
                return;
            }
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
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
    const request = async (path: string, body?: unknown): Promise<{ status: number; body: SnapshotBody & ForkBody }> => {
        const r = await fetch(origin + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: (await r.json()) as SnapshotBody & ForkBody };
    };
    const sendModel = async (conversationId: string, messages: unknown[]) => {
        const response = await fetch(`${origin}/bili/${upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": conversationId }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages }) });
        const text = await response.text();
        assert.equal(response.status, 200, text);
    };
    const sendResponsesModel = async (conversationId: string, input: unknown[]) => {
        const response = await fetch(`${origin}/bili/${upstreamUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": conversationId }, body: JSON.stringify({ model: "claude-test", max_output_tokens: 1024, input }) });
        const text = await response.text();
        assert.equal(response.status, 200, text);
    };
    return { request, sendModel, sendResponsesModel, origin, upstreamUrl, close: async () => { await closeServers([proxy, upstream], "issue4266 harness"); } };
}

function forkRequest(snapshot: SnapshotBody, parent: string, child: string, count = 3) {
    const orderedMessages = snapshot.orderedMessages.slice(0, count);
    return { protocolVersion: 1, parentConversationId: parent, childConversationId: child, parentRevision: snapshot.parentRevision, branchPoint: { messageCount: count, orderHash: hash(orderedMessages) }, orderedMessages, idempotencyKey: `fork-${child}` };
}

const thinkingHistory = () => [
    { role: "user", content: "first original ".repeat(250) },
    { role: "assistant", content: [
        { type: "thinking", thinking: "chain of thought ".repeat(200), signature: "sig-v1-4266" },
        { type: "text", text: "visible answer ".repeat(120) },
    ] },
    { role: "user", content: "tail original" },
];

test("a thinking-block parent forks: snapshot 200, fork 201, grandchild fork 201, child round-trip 200", { timeout: 60_000 }, async () => {
    const h = await harness();
    try {
        await h.sendModel("parent", thinkingHistory());
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
        assert.ok(snapshot.body.messages.some((m: { contentType?: string }) => m.contentType === "reasoning"), "the thinking block must ride the snapshot as a reasoning message");
        const fork = await h.request("/__bili/plugin/fork", forkRequest(snapshot.body, "parent", "child"));
        assert.equal(fork.status, 201, JSON.stringify(fork.body));
        const childSession = resolveConversation("child").session!;
        assert.ok(childSession.pluginSnapshot!.some((m) => m.contentType === "reasoning"), "the child inherits the parent's reasoning message");
        const childSnapshot = await h.request("/__bili/plugin/snapshot?conversationId=child");
        assert.equal(childSnapshot.status, 200, JSON.stringify(childSnapshot.body));
        const grandchild = await h.request("/__bili/plugin/fork", forkRequest(childSnapshot.body, "child", "grandchild"));
        assert.equal(grandchild.status, 201, JSON.stringify(grandchild.body));
        await h.sendModel("child", [...thinkingHistory(), { role: "user", content: "child follow-up" }]);
    } finally { await h.close(); }
});

test("host-projected thinkingTokens cells no longer refuse the fork", { timeout: 60_000 }, async () => {
    const h = await harness();
    try {
        await h.sendModel("parent", thinkingHistory());
        const parentSession = resolveConversation("parent").session!;
        for (const cell of parentSession.pluginSnapshot!) cell.thinkingTokens = 9;
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
        const fork = await h.request("/__bili/plugin/fork", forkRequest(snapshot.body, "parent", "child2"));
        assert.equal(fork.status, 201, JSON.stringify(fork.body));
        const childSession = resolveConversation("child2").session!;
        assert.equal(childSession.pluginSnapshot![0].thinkingTokens, 9, "projected metering mass rides the clone");
    } finally { await h.close(); }
});

test("genuinely uncomparable content still refuses: image blocks stay SNAPSHOT_UNAVAILABLE", { timeout: 60_000 }, async () => {
    const h = await harness();
    try {
        await h.sendModel("parent", thinkingHistory());
        const before = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(before.status, 200);
        await h.sendModel("parent", [...thinkingHistory(), { role: "user", content: [{ type: "text", text: "inspect the image" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] }]);
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(snapshot.status, 409);
        assert.equal(snapshot.body.code, "SNAPSHOT_UNAVAILABLE");
        const fork = await h.request("/__bili/plugin/fork", forkRequest(before.body, "parent", "child3"));
        assert.equal(fork.status, 409);
        assert.equal(fork.body.status, "unavailable");
        assert.equal(resolveConversation("child3").session, undefined, "no child may leak out of a refused fork");
    } finally { await h.close(); }
});

test("responses-wire typed reasoning items no longer refuse the fork (#4589 residual)", { timeout: 60_000 }, async () => {
    const h = await harness();
    try {
        await h.sendResponsesModel("parent", [
            { type: "message", role: "user", content: [{ type: "input_text", text: "first original ".repeat(250) }] },
            { type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "chain of thought ".repeat(200) }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible answer ".repeat(120) }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "tail original" }] },
        ]);
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
        assert.ok(snapshot.body.messages.some((m) => m.contentType === "reasoning"), "the reasoning item must ride the snapshot as a reasoning message");
        const fork = await h.request("/__bili/plugin/fork", forkRequest(snapshot.body, "parent", "child4"));
        assert.equal(fork.status, 201, JSON.stringify(fork.body));
        const childSession = resolveConversation("child4").session!;
        assert.ok(childSession.pluginSnapshot!.some((m) => m.contentType === "reasoning"), "the child inherits the parent's reasoning message");
    } finally { await h.close(); }
});

test("stamped signature-only thinking passes the child's first-request prefix gate; a rotated signature reads as drift", { timeout: 60_000 }, async () => {
    const h = await harness();
    try {
        const shapeB = () => [
            { role: "user", content: "open task ".repeat(50) },
            { role: "assistant", content: [{ type: "thinking", signature: "sig-only-shape-b-4266" }] },
            { role: "user", content: "next step" },
        ];
        // Two requests so the provider usage report exists before mass projection stamps.
        // Unique ids: the unified store outlives individual harnesses in-process, and
        // earlier tests in this file already registered "child".
        await h.sendModel("parent-sigb", shapeB().slice(0, 2));
        await h.sendModel("parent-sigb", shapeB());
        const parentSession = resolveConversation("parent-sigb").session!;
        const reasoningCells = parentSession.pluginSnapshot!.filter((m) => m.contentType === "reasoning");
        assert.ok(reasoningCells.length > 0, "the signature-only block must ride the snapshot as a reasoning message");
        assert.ok(reasoningCells.every((m) => typeof m.thinkingTokens === "number" && m.thinkingTokens > 0), "mass projection must have stamped the signature-only cell — precondition for the spurious-drift bug");
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=parent-sigb");
        assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
        const fork = await h.request("/__bili/plugin/fork", forkRequest(snapshot.body, "parent-sigb", "child-sigb"));
        assert.equal(fork.status, 201, JSON.stringify(fork.body));
        const childSession = resolveConversation("child-sigb").session!;
        // The child's first request replays the inherited prefix verbatim plus its own turn.
        const firstRequest = { model: "claude-test", max_tokens: 1024, stream: false, messages: [...shapeB(), { role: "user", content: "child first turn" }] };
        assert.deepEqual(publicForkInputCheck(childSession, "anthropic", firstRequest), { ok: true }, "one-sided metering mass must not read as identity drift");
        const rotated = structuredClone(firstRequest);
        for (const block of (rotated.messages[1] as { content: { type: string; signature?: string }[] }).content) if (block.type === "thinking") block.signature = "sig-rotated-4266";
        const verdict = publicForkInputCheck(childSession, "anthropic", rotated);
        assert.equal(verdict.ok, false, JSON.stringify(verdict));
        if (!verdict.ok) assert.match(verdict.reason, /hash-drift-under-same-id/, verdict.reason);
    } finally { await h.close(); }
});

test("payload-less thinking block keeps the session non-comparable (fail-closed)", { timeout: 60_000 }, async () => {
    const h = await harness();
    try {
        await h.sendModel("parent", [
            { role: "user", content: "first original ".repeat(50) },
            { role: "assistant", content: [{ type: "thinking" }, { type: "text", text: "visible answer ".repeat(50) }] },
        ]);
        const snapshot = await h.request("/__bili/plugin/snapshot?conversationId=parent");
        assert.equal(snapshot.status, 409, JSON.stringify(snapshot.body));
        assert.equal(snapshot.body.code, "SNAPSHOT_UNAVAILABLE");
    } finally { await h.close(); }
});
