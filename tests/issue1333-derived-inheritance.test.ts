import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import {
    createCore,
    createInitialState,
    defaultConfig,
    type CoreMessage,
} from "acp-kernel";
import { parentConversationIdOf } from "../src/agent/pi.ts";
import { consumePluginRegisterFor, handlePluginRegister, queuePluginRegister, takePendingPluginRegister, _resetPluginStateForTest as _reset_for_test } from "../src/plugin.ts";
import { getSession, listSessions, type Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { derivedAncestorSessions, executeSearchContextTarget, resolveDecompress, type ProxyToolCtx } from "../src/decompress-shared.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

/**
 * #1333: pi RLM inline spawns create DERIVED sessions — the child's pi
 * session header names its parent (parentSession = path of the parent
 * session file). Proxy-side, the child used to start at zero compression
 * state: decompress/search_context could not serve anything the parent had
 * folded. The fix reports the derivation at register time
 * (parentConversationId) and records the parent link on the child's first
 * request (metadata.derivedFromSessionId). No state is copied — the kernel's
 * syncBlocks deactivates blocks whose sources are absent from the child's
 * wire — instead decompress/search_context fall back to the parent chain at
 * read time (read-only, depth cap 8, parent untouched).
 */

const countTokens = (text: string) => Math.ceil(text.length / 4);

function freshSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

function residentFixture(id: string): Session {
    const messages: CoreMessage[] = [];
    for (let i = 1; i <= 6; i++) {
        messages.push({ id: `u${i}`, role: "user", contentType: "text", text: `user turn ${i} with enough prose to fold comfortably`.repeat(3) });
        messages.push({ id: `a${i}`, role: "assistant", contentType: "text", text: `assistant reply ${i} with enough prose to fold comfortably`.repeat(3) });
    }
    const core = createCore({ countTokens });
    const seeded = core.processTurn({ messages, state: createInitialState(), config: defaultConfig(100000), tokenCount: 500 });
    const compressed = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00008", summary: "fixture summary about early user turn exchanges of the derived inheritance test conversation" }],
        messages: seeded.messages,
        state: seeded.state,
        config: defaultConfig(100000, { compress: { minCompressRange: 0, minSummaryLength: 1, maxSummaryLength: 5000 }, preserveRecentMessages: 2, preserveRecentTokens: 0 }),
    });
    const session = getSession(id, { protocol: "openai", upstreamOrigin: "http://upstream" });
    session.state = compressed.state;
    for (const b of compressed.state.blocks) {
        if (b.active) session.blockContents.set(b.blockId, { one: { text: `one-level fixture content of ${b.blockId}`, count: 4 }, full: { text: `full fixture content of ${b.blockId}`, count: 8 } });
    }
    return session;
}

test("parentConversationIdOf resolves the parent id from the child's parentSession header path (#1333)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-header-"));
    try {
        const parentFile = path.join(dir, "parent-session.jsonl");
        fs.writeFileSync(parentFile, `\n${JSON.stringify({ type: "session", version: 2, id: "pfa-parent-header", timestamp: Date.now(), cwd: dir, parentSession: undefined })}\n${JSON.stringify({ type: "message", id: "m1" })}\n`);
        const childFile = path.join(dir, "child-session.jsonl");
        fs.writeFileSync(childFile, JSON.stringify({ type: "session", version: 2, id: "pfa-child-header", timestamp: Date.now(), cwd: dir, parentSession: parentFile }));

        const ctx = { sessionManager: { getSessionId: () => "pfa-child-header", getHeader: () => ({ type: "session", id: "pfa-child-header", parentSession: parentFile }) } };
        assert.equal(parentConversationIdOf(ctx as never), "pfa-parent-header");

        // Root sessions (no parentSession) and non-string parents report undefined.
        assert.equal(parentConversationIdOf({ sessionManager: { getSessionId: () => "root", getHeader: () => ({ type: "session", id: "root" }) } } as never), undefined);
        assert.equal(parentConversationIdOf({ sessionManager: { getSessionId: () => "root", getHeader: () => ({ type: "session", id: "root", parentSession: 42 }) } } as never), undefined);
        // Missing parent file or no session manager: best-effort undefined.
        assert.equal(parentConversationIdOf({ sessionManager: { getSessionId: () => "root", getHeader: () => ({ type: "session", id: "root", parentSession: path.join(dir, "missing.jsonl") }) } } as never), undefined);
        assert.equal(parentConversationIdOf({} as never), undefined);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("parentConversationIdOf returns omp's bare session-id parentSession verbatim (#1362)", () => {
    // omp fork() records the parent's BARE SESSION ID in parentSession (not a
    // file path) — it IS the parent conversation id and is returned without any
    // file access. The discriminator mirrors omp's own gc-cli rule: only an
    // absolute path or a *.jsonl suffix is a file reference.
    assert.equal(
        parentConversationIdOf({ sessionManager: { getSessionId: () => "omp-child", getHeader: () => ({ type: "session", id: "omp-child", parentSession: "omp-parent-uuid" }) } } as never),
        "omp-parent-uuid",
    );
    // Surrounding whitespace trims before the shape check; blank reports nothing.
    assert.equal(
        parentConversationIdOf({ sessionManager: { getSessionId: () => "omp-child", getHeader: () => ({ id: "omp-child", parentSession: "  omp-parent-uuid  " }) } } as never),
        "omp-parent-uuid",
    );
    assert.equal(
        parentConversationIdOf({ sessionManager: { getSessionId: () => "omp-child", getHeader: () => ({ id: "omp-child", parentSession: "   " }) } } as never),
        undefined,
    );
});

test("identity and pending registers carry parentConversationId end to end (#1333)", () => {
    _reset_for_test();
    const written: string[] = [];
    const res = { writeHead: () => undefined, end: (body: string) => void written.push(body) } as unknown as import("node:http").ServerResponse;

    handlePluginRegister(JSON.stringify({ conversationId: "pfa-child-2", agent: "pi", identity: true, parentConversationId: "pfa-parent-2" }), res);
    assert.equal(written.length, 1);
    assert.ok(JSON.parse(written[0]!).ok, "register must succeed");
    assert.deepEqual(consumePluginRegisterFor("pfa-child-2"), { agent: "pi", parentConversationId: "pfa-parent-2" });
    // LRU refresh keeps the entry for rebinding (model switch).
    assert.deepEqual(consumePluginRegisterFor("pfa-child-2"), { agent: "pi", parentConversationId: "pfa-parent-2" });

    // Self-parent is refused at parse: a conversation cannot derive from itself.
    handlePluginRegister(JSON.stringify({ conversationId: "pfa-solo", agent: "pi", identity: false, parentConversationId: "pfa-solo" }), res);
    const pending = takePendingPluginRegister();
    assert.ok(pending, "pending register taken");
    assert.equal(pending!.conversationId, "pfa-solo");
    assert.equal(pending!.parentConversationId, undefined, "self-parent must be dropped");

    // Legacy registers without the field keep the undefined shape.
    queuePluginRegister("pfa-plain", "pi", true);
    assert.deepEqual(consumePluginRegisterFor("pfa-plain"), { agent: "pi" });
});

test("derivedAncestorSessions walks the recorded chain, caps depth and breaks cycles (#1333)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // A 10-deep chain: the walk must stop at the depth cap (8).
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(`pfa-anc-${run}-${i}`);
    for (let i = 0; i < 10; i++) {
        const s = getSession(ids[i]!, { protocol: "openai", upstreamOrigin: "http://upstream" });
        s.metadata.derivedFromSessionId = i + 1 < 10 ? ids[i + 1] : undefined;
    }
    const head = getSession(`pfa-anc-${run}-head`, { protocol: "openai", upstreamOrigin: "http://upstream" });
    head.metadata.derivedFromSessionId = ids[0]!;
    assert.equal(derivedAncestorSessions(head).length, 8, "depth cap 8");

    // Cycle guard: parent → child → parent must terminate with the parent once.
    const a = getSession(`pfa-cyc-a-${run}`, { protocol: "openai", upstreamOrigin: "http://upstream" });
    const b = getSession(`pfa-cyc-b-${run}`, { protocol: "openai", upstreamOrigin: "http://upstream" });
    a.metadata.derivedFromSessionId = b.id;
    b.metadata.derivedFromSessionId = a.id;
    assert.deepEqual(derivedAncestorSessions(a).map((s) => s.id), [b.id], "cycle terminates at the first repeat (the guard set starts with the child)");

    // Unresolvable parent id ends the walk; unlinked sessions walk nowhere.
    const orphan = freshSession(`pfa-orphan-${run}`);
    orphan.metadata.derivedFromSessionId = "pfa-never-persisted";
    assert.deepEqual(derivedAncestorSessions(orphan), [], "unknown parent resolves to nothing");
    const plain = freshSession(`pfa-plain-${run}`);
    assert.deepEqual(derivedAncestorSessions(plain), [], "unlinked session has no ancestors");
});

test("decompress and search_context fall back to the parent chain read-only (#1333)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const parent = residentFixture(`pfa-parent-ro-${run}`);
    const parentId = parent.state.blocks.filter((b) => b.active).map((b) => b.blockId);
    assert.ok(parentId.length >= 1, "fixture must fold a block");
    const blockId = parentId[0]!;

    const child = getSession(`pfa-child-ro-${run}`, { protocol: "openai", upstreamOrigin: "http://upstream" });
    child.metadata.derivedFromSessionId = parent.id;
    const core = createCore({ countTokens });
    const config = defaultConfig(100000);
    const ctx: ProxyToolCtx = { core, config, messages: [], session: child, log: () => undefined };

    // Child-local decompress of the PARENT's block id: read-only fallback.
    const out = resolveDecompress({ blockId }, ctx);
    assert.match(out, new RegExp(`read-only from derived session ${parent.id.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")} \\(#1333\\)`), "decompress must name the derived source");
    assert.match(out, new RegExp(`one-level fixture content of ${blockId}`), "cached one-level view is served");

    // full flag serves the cached full view.
    const full = resolveDecompress({ blockId, full: true }, ctx);
    assert.match(full, new RegExp(`full fixture content of ${blockId}`));

    // Range restore against a parent block is refused with guidance.
    assert.match(resolveDecompress({ blockId, startId: "m00001" }, ctx), /range restore .*derived-parent blocks is not supported/);

    // search_context with no conversation_id falls back to the parent's blocks
    // (query needs >= 3 summary terms to clear the kernel's 0.1 relevance floor).
    const search = executeSearchContextTarget({ query: "user turn exchanges" }, core, child.id, child.state);
    assert.match(search, /Found \d+ block\(s\)/, "search must surface parent blocks");
    assert.match(search, new RegExp(blockId));

    // Without the link the same lookups are local-only misses.
    const lone = residentFixture(`pfa-lone-ro-${run}`);
    const loneChild = getSession(`pfa-lone-child-${run}`, { protocol: "openai", upstreamOrigin: "http://upstream" });
    const loneBlock = lone.state.blocks.filter((b) => b.active)[0]!.blockId;
    const loneCtx: ProxyToolCtx = { core, config, messages: [], session: loneChild, log: () => undefined };
    assert.equal(resolveDecompress({ blockId: loneBlock }, loneCtx), `[Block ${loneBlock} not found]`);
    assert.match(executeSearchContextTarget({ query: "user turn" }, core, loneChild.id, loneChild.state), /^\[No compressed blocks exist yet/);

    // Read-only: the parent state and cache are untouched by the fallback.
    assert.equal(parent.state.blocks.filter((b) => b.active).length, parentId.length);
    assert.ok(parent.blockContents.has(blockId));
});

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function sseLine(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null = null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

const FILLER = "the quick brown fox jumps over the lazy dog again and again. ";

type RelayState = { upstreamReqs: string[]; compressed: boolean };

function startMockUpstream(state: RelayState): http.Server {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            state.upstreamReqs.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const refIds = parseRefIds(body);
            if (!state.compressed && refIds.length >= 5) {
                state.compressed = true;
                const from = refIds[1]!;
                const to = refIds[refIds.length - 3]!;
                res.write(
                    sseLine({
                        id: "c1",
                        object: "chat.completion.chunk",
                        choices: [
                            {
                                index: 0,
                                delta: {
                                    role: "assistant",
                                    content: null,
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: "call_compress_1",
                                            type: "function",
                                            function: {
                                                name: "compress",
                                                arguments: JSON.stringify({
                                                    content: [
                                                        {
                                                            startId: from,
                                                            endId: to,
                                                            topic: "derived inheritance fixture",
                                                            summary: `folded early turns of the #1333 fixture conversation: the user asked numbered questions, the assistant answered with filler prose, and several exchanges accumulated before the context was folded. No decisions were made; the content is early-session chatter. Range ${from}..${to}.`,
                                                        },
                                                    ],
                                                }),
                                            },
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                );
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 500, completion_tokens: 2 } }));
            } else {
                let lastUser = "";
                try {
                    const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
                    const msgs = parsed.messages ?? [];
                    for (let i = msgs.length - 1; i >= 0; i--) {
                        if (msgs[i]!.role === "user") {
                            lastUser = msgs[i]!.content;
                            break;
                        }
                    }
                } catch {
                    /* fall through with empty echo */
                }
                const text = `reply ${state.upstreamReqs.length} to <${lastUser.slice(0, 48)}>: ${FILLER.repeat(10)}`;
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] }));
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 50 } }));
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

type ChatMsg = { role: string; content: string };

async function chat(url: string, messages: ChatMsg[], conversation: string, extraHeaders: Record<string, string> = {}): Promise<string> {
    const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
    if (conversation) headers["x-acp-session"] = conversation;
    const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
    });
    if (!res.ok) assert.fail(`HTTP ${res.status}: ${await res.text()}`);
    let raw = "";
    for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
    let reply = "";
    for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
            const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
            reply += parsed.choices?.[0]?.delta?.content ?? "";
        } catch {
            /* ignore keepalives */
        }
    }
    return reply;
}

function proxyOpts(relayPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {} as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 400,
            compress: { minCompressRange: 200, minSummaryLength: 20, maxSummaryLength: 5000 },
        }),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        forkAdoption: false,
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
}

test("pi child conversation links its parent and serves its blocks read-only (#1333 e2e)", async () => {
    // Two child wire shapes must both record the link: the anonymous shape
    // (session header only — identity register drives binding) and the REAL
    // pi plugin shape (x-bili-plugin + x-bili-plugin-conversation stamped by
    // the extension — pluginAgent comes from the header, the identity branch
    // is skipped, and the register must be consulted through the stamped
    // conversation id instead).
    for (const shape of ["anonymous", "stamped"] as const) {
        await runDerivedInheritanceE2E(shape);
    }
});

async function runDerivedInheritanceE2E(shape: "anonymous" | "stamped"): Promise<void> {
    _reset_for_test();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const parentConv = `pfa-parent-${run}`;
    const childConv = `pfa-child-${run}`;

    const state: RelayState = { upstreamReqs: [], compressed: false };
    const relay = startMockUpstream(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const proxy = await startServer(proxyOpts(relayPort));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`;

    const preExisting = new Set(listSessions().map((s) => s.id));
    const newSessions = () => listSessions().filter((s) => !preExisting.has(s.id));
    try {
        // Grow the parent under its own conversation id until a block folds.
        const history: ChatMsg[] = [];
        for (let i = 1; i <= 8; i++) {
            history.push({ role: "user", content: `run ${run} parent turn ${i}: ${FILLER.repeat(12)}` });
            const reply = await chat(url, history, parentConv);
            assert.ok(reply.length > 0, `parent turn ${i} must produce a reply`);
            history.push({ role: "assistant", content: reply });
        }
        const parent = newSessions()[0]!;
        const parentActive = parent.state.blocks.filter((b) => b.active);
        assert.ok(parentActive.length >= 1, `parent must have a folded block (got ${parentActive.length})`);
        const blockId = parentActive[0]!.blockId;

        // The child reports its derivation at register (identity mode, like
        // the pi plugin does on a session whose header names a parent).
        const reg = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: childConv, agent: "pi", identity: true, parentConversationId: parentConv }),
        });
        assert.ok(reg.ok, "register must succeed");

        // The child's FIRST request carries an EMPTY history (fresh derived
        // conversation) — it records the parent link, it does NOT copy state
        // (the kernel's syncBlocks would deactivate copied blocks anyway).
        // The stamped shape mirrors what the real pi extension sends.
        const childHeaders = shape === "stamped"
            ? { "x-bili-plugin": "pi", "x-bili-plugin-conversation": childConv }
            : {};
        const childReply = await chat(url, [{ role: "user", content: `run ${run} child first turn (${shape}): ${FILLER.repeat(12)}` }], childConv, childHeaders);
        assert.ok(childReply.length > 0, "child turn must produce a reply");

        const child = newSessions().find((s) => s.id !== parent.id);
        assert.ok(child, "child conversation must resolve to its own session");
        assert.equal(child.metadata.derivedFromSessionId, parent.id, "child records the parent session link");
        assert.equal(child.metadata.derivedFrom, parentConv, "child records the parent conversation id");
        assert.equal(child.state.blocks.filter((b) => b.active).length, 0, "no state is copied into the child");

        // Plugin-lane decompress of the PARENT's block via the CHILD
        // conversation: served read-only from the linked parent.
        const dec = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: childConv, tool: "decompress", args: { blockId } }),
        });
        const decJson = JSON.parse(await dec.text()) as { ok: boolean; result?: string };
        assert.ok(decJson.ok, `decompress via plugin tool API failed: ${JSON.stringify(decJson)}`);
        assert.match(decJson.result ?? "", new RegExp(`read-only from derived session ${parent.id}`), "decompress must fall back to the parent");

        // search_context from the child finds the parent's blocks.
        const search = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: childConv, tool: "search_context", args: { query: "derived inheritance fixture" } }),
        });
        const searchJson = JSON.parse(await search.text()) as { ok: boolean; result?: string };
        assert.ok(searchJson.ok, `search_context via plugin tool API failed: ${JSON.stringify(searchJson)}`);
        assert.match(searchJson.result ?? "", /Found \d+ block\(s\)/, "search must surface parent blocks");
        assert.match(searchJson.result ?? "", new RegExp(blockId));

        // Unknown block ids still miss cleanly.
        const miss = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: childConv, tool: "decompress", args: { blockId: "b999" } }),
        });
        const missJson = JSON.parse(await miss.text()) as { ok: boolean; result?: string };
        assert.ok(missJson.ok);
        assert.match(missJson.result ?? "", /\[Block b999 not found\]/);

        // Read-only: the parent is untouched by the child's lookups.
        assert.equal(parent.state.blocks.filter((b) => b.active).length, parentActive.length, "parent blocks stay active");
    } finally {
        await close(proxy);
        await close(relay);
    }
}

test("child whose requests carry the real plugin wire shape links its parent (#1362)", async () => {
    _reset_for_test();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const parentConv = `pfa-parent-${run}`;
    const childConv = `pfa-child-wire-${run}`;

    const state: RelayState = { upstreamReqs: [], compressed: false };
    const relay = startMockUpstream(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const proxy = await startServer(proxyOpts(relayPort));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`;

    const preExisting = new Set(listSessions().map((s) => s.id));
    const newSessions = () => listSessions().filter((s) => !preExisting.has(s.id));
    try {
        const history: ChatMsg[] = [];
        for (let i = 1; i <= 8; i++) {
            history.push({ role: "user", content: `run ${run} parent turn ${i}: ${FILLER.repeat(12)}` });
            const reply = await chat(url, history, parentConv);
            assert.ok(reply.length > 0, `parent turn ${i} must produce a reply`);
            history.push({ role: "assistant", content: reply });
        }
        const parent = newSessions()[0]!;
        const parentActive = parent.state.blocks.filter((b) => b.active);
        assert.ok(parentActive.length >= 1, `parent must have a folded block (got ${parentActive.length})`);
        const blockId = parentActive[0]!.blockId;

        const reg = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: childConv, agent: "pi", identity: true, parentConversationId: parentConv }),
        });
        assert.ok(reg.ok, "register must succeed");

        // The child's requests carry the REAL pi wire shape — before_provider_headers
        // stamps x-bili-plugin + x-bili-plugin-conversation on every request, so the
        // server-side identity branch is skipped and only the header-announced consume
        // path can pick up the parent link (#1356 review blocker). No x-acp-session.
        const piHeaders = { "x-bili-plugin": "pi", "x-bili-plugin-conversation": childConv };
        const childReply = await chat(url, [{ role: "user", content: `run ${run} child first turn: ${FILLER.repeat(12)}` }], "", piHeaders);
        assert.ok(childReply.length > 0, "child turn must produce a reply");

        const child = newSessions().find((s) => s.id !== parent.id);
        assert.ok(child, "child conversation must resolve to its own session");
        assert.equal(child.metadata.derivedFromSessionId, parent.id, "header-announced child records the parent session link");
        assert.equal(child.metadata.derivedFrom, parentConv, "child records the parent conversation id");
        assert.equal(child.state.blocks.filter((b) => b.active).length, 0, "no state is copied into the child");

        // The user-visible defect of #1333 on the real wire shape: decompress from
        // the child serves the parent's folded content read-only.
        const dec = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: childConv, tool: "decompress", args: { blockId } }),
        });
        const decJson = JSON.parse(await dec.text()) as { ok: boolean; result?: string };
        assert.ok(decJson.ok, `decompress via plugin tool API failed: ${JSON.stringify(decJson)}`);
        assert.match(decJson.result ?? "", new RegExp(`read-only from derived session ${parent.id}`), "decompress must fall back to the parent");
    } finally {
        await close(proxy);
        await close(relay);
    }
});

test("register landing after the child's first request still links late (#1362)", async () => {
    _reset_for_test();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const parentConv = `pfa-parent-${run}`;
    const childConv = `pfa-child-late-${run}`;

    const state: RelayState = { upstreamReqs: [], compressed: false };
    const relay = startMockUpstream(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const proxy = await startServer(proxyOpts(relayPort));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`;

    const preExisting = new Set(listSessions().map((s) => s.id));
    const newSessions = () => listSessions().filter((s) => !preExisting.has(s.id));
    try {
        const history: ChatMsg[] = [];
        for (let i = 1; i <= 8; i++) {
            history.push({ role: "user", content: `run ${run} parent turn ${i}: ${FILLER.repeat(12)}` });
            const reply = await chat(url, history, parentConv);
            history.push({ role: "assistant", content: reply });
        }
        const parent = newSessions()[0]!;
        assert.ok(parent.state.blocks.filter((b) => b.active).length >= 1, "parent must have a folded block");

        // The extension flips tools-ready BEFORE the register POST completes, so the
        // child's first model request can reach the proxy before any register exists.
        const piHeaders = { "x-bili-plugin": "pi", "x-bili-plugin-conversation": childConv };
        const firstTurn = [{ role: "user", content: `run ${run} child first turn: ${FILLER.repeat(12)}` }] as ChatMsg[];
        const reply1 = await chat(url, firstTurn, "", piHeaders);
        assert.ok(reply1.length > 0, "child first turn must produce a reply");
        let child = newSessions().find((s) => s.id !== parent.id);
        assert.ok(child, "child conversation must resolve to its own session");
        assert.equal(child.metadata.derivedFromSessionId, undefined, "no register yet — nothing to link");

        const reg = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: childConv, agent: "pi", identity: true, parentConversationId: parentConv }),
        });
        assert.ok(reg.ok, "late register must succeed");

        // Second request of the same session re-derives the parent and records the
        // link even though this is no longer the session's first request.
        firstTurn.push({ role: "assistant", content: reply1 });
        firstTurn.push({ role: "user", content: `run ${run} child second turn: ${FILLER.repeat(12)}` });
        const reply2 = await chat(url, firstTurn, "", piHeaders);
        assert.ok(reply2.length > 0, "child second turn must produce a reply");
        child = newSessions().find((s) => s.id !== parent.id);
        assert.equal(child?.metadata.derivedFromSessionId, parent.id, "link recorded on the second request (late-link guard)");
        assert.equal(child?.metadata.derivedFrom, parentConv);
    } finally {
        await close(proxy);
        await close(relay);
    }
});
