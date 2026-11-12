import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const root = mkdtempSync(path.join(tmpdir(), "bili-zcode-memory-"));
const envKeys = ["XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"];
const previous = envKeys.map((key) => process.env[key]);
for (const key of envKeys) process.env[key] = path.join(root, key);
after(() => envKeys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
}));
process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistry } = await import("../src/registry.ts");
const { _resetPluginStateForTest, resolveConversation } = await import("../src/plugin.ts");
const { resetToolRingForTest } = await import("../src/tool-ring.ts");
const { peekSession, listSessions, _resetSessionsForTest } = await import("../src/session.ts");
const { forwardTool } = await import("../src/agent/shared.ts");
const { zcodeMemoryConversation } = await import("../src/session-id.ts");
const { prefixAffinity } = await import("../src/prefix-affinity.ts");

const PARENT = "zcode-memory-test";
const attribution = (query = "q1"): Record<string, string> => ({
    "x-session-id": PARENT,
    "x-zcode-session-type": "other",
    "x-zcode-query-source": "project_memory_extract",
    "x-query-id": query,
});

test("ZCode memory identity requires explicit, consistent attribution", () => {
    const headers = attribution();
    const child = zcodeMemoryConversation(PARENT, headers);
    assert.equal(child, `${PARENT}|aux:zcode-memory:q1`);
    assert.equal(zcodeMemoryConversation(PARENT, { ...headers, "x-request-id": "retry" }), child);
    assert.notEqual(zcodeMemoryConversation(PARENT, attribution("q2")), child);
    for (const key of Object.keys(headers)) {
        const missing = { ...headers };
        delete missing[key];
        assert.equal(zcodeMemoryConversation(PARENT, missing), undefined, key);
        assert.equal(zcodeMemoryConversation(PARENT, { ...headers, [key]: [headers[key]!] }), undefined, key);
    }
    for (const query of ["", " ", "a|sub:evil", "x".repeat(129), "a,b"]) {
        assert.equal(zcodeMemoryConversation(PARENT, attribution(query)), undefined);
    }
    for (const source of ["main_turn", "agent_step", "title_generation", "context_compaction"]) {
        assert.equal(zcodeMemoryConversation(PARENT, { ...headers, "x-zcode-query-source": source }), undefined);
    }
    for (const type of ["main", "subagent", "side_chat"]) {
        assert.equal(zcodeMemoryConversation(PARENT, { ...headers, "x-zcode-session-type": type }), undefined);
    }
    assert.equal(zcodeMemoryConversation("another-parent", headers), undefined);
});

type Message = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string };
const history = (): Message[] => [
    { role: "system", content: "You are a coding assistant." },
    ...Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `History ${i}: ${"stable fixture content. ".repeat(100)}` })),
];

type Captured = { body: Record<string, unknown>; headers: http.IncomingHttpHeaders };
async function rig(plugin = false) {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistry({});
    _resetPluginStateForTest();
    resetToolRingForTest();
    _resetSessionsForTest();
    const captured: Captured[] = [];
    let compressNext: { startId: string; endId: string } | undefined;
    const relay = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured.push({ body: JSON.parse(Buffer.concat(chunks).toString()), headers: req.headers });
            const worker = req.headers["x-zcode-query-source"] === "project_memory_extract";
            res.writeHead(200, { "content-type": "application/json" });
            if (compressNext) {
                const range = compressNext;
                compressNext = undefined;
                res.end(JSON.stringify({
                    id: "compress-worker", object: "chat.completion",
                    choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call-worker-fold", type: "function", function: { name: "compress", arguments: JSON.stringify({ content: [{ ...range, summary: "The memory worker read private facts and completed its intermediate analysis; the main conversation never contains this temporary tail." }] }) } }] }, finish_reason: "tool_calls" }],
                    usage: { prompt_tokens: 7000, completion_tokens: 40 },
                }));
                return;
            }
            res.end(JSON.stringify({
                id: "r1", object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "plain reply" }, finish_reason: "stop" }],
                usage: { prompt_tokens: worker ? 7000 : 20000, completion_tokens: 5 },
            }));
        });
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const upstream = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream,
        routes: { [upstream]: { models: { "gpt-test": { context: 1_000_000 } }, compressProtocol: "marker" } },
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, { preserveRecentMessages: 2, preserveRecentTokens: 400, compress: { minCompressRange: 200, minSummaryLength: 20, maxSummaryLength: 5000 } }),
        compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
        autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false, mitm: { enabled: false, domains: [] },
    } as Parameters<typeof startServer>[0]);
    await once(proxy, "listening");
    const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    return {
        base, captured,
        compressNext(startId: string, endId: string) { compressNext = { startId, endId }; },
        async turn(messages: Message[], headers: Record<string, string> = {}) {
            const response = await fetch(`${base}/bili/${upstream}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-session-id": PARENT, ...(plugin ? { "x-bili-plugin": "zcode", "x-bili-plugin-conversation": PARENT } : {}), ...headers },
                body: JSON.stringify({ model: "gpt-test", max_tokens: 64000, messages, prompt_cache_key: "original-cache-key" }),
            });
            assert.equal(response.status, 200, await response.text());
        },
        async close() {
            proxy.close();
            await once(proxy, "close");
            relay.close();
            await once(relay, "close");
        },
    };
}

async function fold(base: string, id: string, from: string, to: string) {
    const out = await forwardTool(base, id, "compress", { content: [{ startId: from, endId: to, summary: "The fixture recorded stable historical exchanges; preserve the completed work without repeating the filler text." }] });
    assert.equal(out.failed, false, out.text);
}

for (const plugin of [false, true]) test(`memory tool rounds isolate state and management routing (plugin=${plugin})`, async () => {
    const r = await rig(plugin);
    try {
        const main = history();
        await r.turn(main, { "x-zcode-session-type": "main", "x-query-id": "q1" });
        const parent = peekSession(PARENT)!;
        assert.ok(parent);
        const refs = Object.keys(parent.state.messageRefs.byRef);
        await fold(r.base, PARENT, refs[1]!, refs[5]!);
        assert.ok(parent.state.blocks.some((b) => b.active));
        await r.turn(main);
        const mainWireBefore = structuredClone(r.captured.at(-1)!.body.messages);
        const before = structuredClone({ state: parent.state, stats: parent.stats, lastMessages: parent.lastMessages, conflicts: parent.metadata.conflictEvents });
        const chainBefore = structuredClone(prefixAffinity.peekChain(PARENT));
        const childId = zcodeMemoryConversation(PARENT, attribution())!;
        const worker: Message[] = [...main, { role: "user", content: "Extract project memory from the preceding conversation." }];
        await r.turn(worker, attribution());
        const child = peekSession(childId)!;
        assert.ok(child);
        assert.equal(child.metadata.derivedFromSessionId, PARENT);
        assert.ok(child.state.blocks.some((b) => b.active));
        assert.notEqual(child.state.blocks[0], parent.state.blocks[0]);
        const workerWire = JSON.stringify(r.captured.at(-1)!.body.messages);
        assert.ok(workerWire.includes("The fixture recorded stable historical exchanges"), "inherited summary is rendered upstream");
        assert.ok(!workerWire.includes("History 1:"), "inherited originals stay folded");
        assert.equal(prefixAffinity.peekChain(childId), undefined, "workers must not become resume-parent candidates");
        for (const block of child.state.blocks.filter((b) => b.active)) {
            for (const raw of block.effectiveMessageIds) assert.equal(child.state.messageRefs.byRaw[raw], parent.state.messageRefs.byRaw[raw]);
        }
        worker.push(
            { role: "assistant", content: null, tool_calls: [{ id: "read-memory", type: "function", function: { name: "Read", arguments: '{"path":"memory.md"}' } }] },
            { role: "tool", tool_call_id: "read-memory", content: "Worker-only remembered facts. ".repeat(150) },
        );
        for (let i = 0; i < 3; i++) {
            worker.push({ role: "assistant", content: `Memory analysis ${i}. ${"private worker tail. ".repeat(80)}` });
            await r.turn(worker, { ...attribution(), "x-request-id": `request-${i}` });
        }
        assert.deepEqual({ state: parent.state, stats: parent.stats, lastMessages: parent.lastMessages, conflicts: parent.metadata.conflictEvents }, before);
        assert.deepEqual(prefixAffinity.peekChain(PARENT), chainBefore);
        assert.equal(resolveConversation("original-cache-key")?.session?.id, PARENT, "cache-key alias must stay on the main session");
        assert.equal(child.stats.lastInputTokens, 7000);
        assert.equal(parent.stats.lastInputTokens, 20000);
        const childOnlyRefs = Object.keys(child.state.messageRefs.byRef).filter((ref) => !(ref in before.state.messageRefs.byRef));
        r.compressNext(childOnlyRefs[0]!, childOnlyRefs[2]!);
        await r.turn(worker, attribution());
        assert.ok(child.state.blocks.length > parent.state.blocks.length, "model-issued compression executes in the worker, not the host-bound parent");
        assert.deepEqual(parent.state, before.state);
        const management = await forwardTool(r.base, PARENT, "acp_cache", {}, undefined, true);
        assert.equal(management.failed, false, management.text);
        assert.ok(!management.text.includes(childId), "main management must not follow the worker");
        const childState = structuredClone(child.state);
        for (let i = 0; i < 4; i++) await r.turn(main, { "x-zcode-session-type": "main", "x-query-id": `main-${i}` });
        assert.deepEqual(child.state, childState, "resumed main turns must not reap worker folds");
        assert.deepEqual(r.captured.at(-1)!.body.messages, mainWireBefore, "background work must not rewrite the repeated main request");
        assert.deepEqual(parent.state.blocks.map(({ survivedCount, generation, ...block }) => block), before.state.blocks.map(({ survivedCount, generation, ...block }) => block));
        assert.deepEqual(parent.metadata.conflictEvents, before.conflicts);
        await r.turn(worker, attribution("q2"));
        const sibling = peekSession(zcodeMemoryConversation(PARENT, attribution("q2"))!)!;
        assert.ok(sibling);
        assert.equal(sibling.metadata.derivedFromSessionId, PARENT, "new run inherits only the declared parent");
        assert.equal(sibling.state.blocks.length, parent.state.blocks.length);
        assert.equal(listSessions().length, 3);
        for (const request of r.captured) {
            assert.equal(request.headers["x-session-id"], PARENT);
            assert.equal(request.body.prompt_cache_key, "original-cache-key");
        }
    } finally { await r.close(); }
});

test("worker-first arrival does not claim main identity; ordinary other requests remain unchanged", async () => {
    const r = await rig();
    try {
        await r.turn(history(), attribution());
        assert.equal(peekSession(PARENT), undefined);
        const child = peekSession(zcodeMemoryConversation(PARENT, attribution())!)!;
        assert.ok(child);
        const before = structuredClone(child.state);
        await r.turn(history(), { "x-zcode-session-type": "main", "x-query-id": "q1" });
        await r.turn(history(), { ...attribution(), "x-zcode-query-source": "title_generation" });
        await r.turn(history(), { ...attribution(), "x-query-id": "" });
        assert.ok(peekSession(PARENT));
        assert.equal(listSessions().length, 2);
        assert.deepEqual(child.state, before);
    } finally { await r.close(); }
});
