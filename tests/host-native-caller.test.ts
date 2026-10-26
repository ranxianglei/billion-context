// #2072: host-native ACP tool calls misrouted across subagent sessions —
// every host-native agent (pi / dsh / opencode) forwarded its session-manager
// id WITHOUT the nativeCaller stamp, so the proxy's outbound-witness rung
// (#1685) could redirect a stale sibling record over the caller's own id
// (live repro: Pi subagents, #2063 — a sibling child's compressed block was
// served to another child; on post-#2016 master the same shape hard-fails
// 409 instead of misrouting). Pins the fix at two layers:
//   A. client contract — the REAL src/agent/shared.ts forwardTool stamps
//      nativeCaller only when asked AND the id is non-empty; the unflagged
//      wire stays byte-for-byte the legacy shape;
//   B. e2e through the real startServer — a flagged host-native caller gets
//      ITS OWN session despite a conflicting unique sibling witness (the
//      incident shape); the unflagged same call fails closed (409, #2016);
//      an unknown flagged id still fails loudly with no witness rescue.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { after } from "node:test";
import type { ProxyOptions } from "../src/config.ts";

// XDG env BEFORE importing the server (auto-restart.test.ts pattern): boot's
// loadConversations() would otherwise hydrate the developer's live production
// conversations into the routing table.
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-e2e-host-native-caller-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

// Imported AFTER the XDG env above.
const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { resetToolRingForTest } = await import("../src/tool-ring.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
const { forwardTool } = await import("../src/agent/shared.ts");

after(() => {
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
});

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

type Relay = {
    server: http.Server;
};

/** Deterministic fake chat upstream. A request whose user text carries
 *  `WITNESS:<tool>` is answered with a NON-STREAM JSON assistant message
 *  containing that tool call (recording lane 5, #1692); everything else gets
 *  a plain text answer. (Same relay contract as mcp-native-thread.test.ts.) */
function startRelay(): Relay {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const marker = /WITNESS:([a-z_]+)/.exec(body)?.[1];
            res.writeHead(200, { "content-type": "application/json" });
            if (marker) {
                res.end(JSON.stringify({
                    id: "r1", object: "chat.completion",
                    choices: [{
                        index: 0,
                        message: { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: marker, arguments: "{}" } }] },
                        finish_reason: "tool_calls",
                    }],
                    usage: { prompt_tokens: 100, completion_tokens: 2 },
                }));
                return;
            }
            res.end(JSON.stringify({
                id: "r1", object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "plain reply" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 5 },
            }));
        });
    });
    server.listen(0, "127.0.0.1");
    return { server };
}

type Harness = {
    baseUrl: string;
    chatUrl: string;
    relay: Relay;
    stop: () => Promise<void>;
};

async function boot(): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    resetToolRingForTest();
    _resetPluginStateForTest();
    const relay = startRelay();
    await listen(relay.server);
    const relayPort = (relay.server.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${relayPort}`]: { models: { "gpt-test": { context: 1_000_000 } }, compressProtocol: "marker" } } as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, {}),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        baseUrl: `http://127.0.0.1:${proxyPort}`,
        chatUrl: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`,
        relay,
        stop: async () => {
            await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
            await new Promise<void>((resolve, reject) => relay.server.close((e) => (e ? reject(e) : resolve())));
        },
    };
}

async function modelTurn(h: Harness, conv: string, userText: string): Promise<void> {
    const res = await fetch(h.chatUrl, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bili-plugin": "pi",
            "x-bili-plugin-conversation": conv,
            "x-bili-plugin-model": "gpt-test",
        },
        body: JSON.stringify({ model: "gpt-test", stream: false, messages: [{ role: "user", content: userText }] }),
    });
    assert.equal(res.status, 200, `model turn for ${conv} must succeed`);
    await res.json();
}

async function toolPost(h: Harness, body: Record<string, unknown>): Promise<{ status: number; json: { ok?: boolean; result?: string; error?: string; code?: string } | null }> {
    const res = await fetch(`${h.baseUrl}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as { ok?: boolean; result?: string; error?: string; code?: string } | null };
}

/** The served session's Web UI deep link (contains its session id) — the
 *  oracle for WHICH conversation a tool execution ran against. acp_cache
 *  prefixes its result with the link (handlePluginTool, #acp-cache deep link). */
async function webUrlOf(h: Harness, conv: string): Promise<string> {
    const res = await fetch(`${h.baseUrl}/__bili/plugin/status?conversationId=${encodeURIComponent(conv)}`);
    assert.equal(res.status, 200, `status for ${conv} must resolve`);
    const json = (await res.json()) as { webUrl?: string | null };
    assert.ok(typeof json.webUrl === "string" && json.webUrl.length > 0, `status for ${conv} must expose its webUrl`);
    return json.webUrl;
}

// ─────────────────────────── Part A: client contract ─────────────────────────

type CapturedBody = { conversationId?: unknown; tool?: unknown; args?: unknown; nativeCaller?: unknown };

function startCapture(): Promise<{ url: string; bodies: CapturedBody[]; stop: () => Promise<void> }> {
    const bodies: CapturedBody[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push((raw ? JSON.parse(raw) : {}) as CapturedBody);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, result: "captured" }));
        });
    });
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => ({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        bodies,
        stop: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    }));
}

test("#2072 client: forwardTool stamps nativeCaller only for confirmed host ids", async () => {
    const cap = await startCapture();
    try {
        await forwardTool(cap.url, "host-sid-1", "acp_status", {}, undefined, true);
        await forwardTool(cap.url, "host-sid-2", "acp_status", {});
        await forwardTool(cap.url, "", "acp_status", {}, undefined, true);
        // A host can pass a non-string id despite the static type — the guard
        // must degrade to the legacy id-less wire (no throw, no stamp), not crash.
        await forwardTool(cap.url, undefined as unknown as string, "acp_status", {}, undefined, true);
        assert.equal(cap.bodies.length, 4);
        assert.deepEqual(
            cap.bodies.map((b) => b.nativeCaller),
            [true, undefined, undefined, undefined],
            "flagged+id stamps; default stays byte-identical to the legacy wire; an empty or missing id is never claimed as host-stamped",
        );
        assert.ok(!("conversationId" in cap.bodies[3]), "a missing id drops out of the wire exactly as pre-#2072");
        assert.equal(cap.bodies[0].conversationId, "host-sid-1");
        assert.equal(cap.bodies[0].tool, "acp_status");
        assert.deepEqual(cap.bodies[0].args, {});
    } finally {
        await cap.stop();
    }
});

// ─────────────────────── Part B: e2e through the real proxy ──────────────────

test("#2072 e2e: flagged host-native caller routes home past a stale sibling witness (Pi subagent incident shape)", async () => {
    const h = await boot();
    try {
        // Two concurrent pi subagents behind one proxy (the #2063 repro):
        await modelTurn(h, "hs-a", "alpha plain turn");
        // hs-b streams the very (acp_cache, {}) call we will POST — its unique
        // witness names hs-b, conflicting with the caller hs-a.
        await modelTurn(h, "hs-b", "WITNESS:acp_cache beta streams the tool call");
        const urlA = await webUrlOf(h, "hs-a");
        const urlB = await webUrlOf(h, "hs-b");
        assert.notEqual(urlA, urlB);

        // The incident: child A asks for ITS OWN cache report while child B's
        // identical (acp_cache, {}) call left a fresher unique witness. The
        // host-stamped id must win — A sees A's panel, never B's blocks.
        const outA = await forwardTool(h.baseUrl, "hs-a", "acp_cache", {}, undefined, true);
        assert.equal(outA.failed, false, "a served cache report is not a business failure");
        assert.ok(outA.text.includes(urlA), "the caller's own session must be served");
        assert.ok(!outA.text.includes(urlB), "the witnessing sibling's state must NOT leak into the reply");

        // Control leg: the SAME call on the legacy (unflagged) wire shape
        // fails closed on current master instead of misrouting (#2016) — the
        // stamp is what turns this error back into correct routing.
        resetToolRingForTest();
        await modelTurn(h, "hs-b", "WITNESS:acp_cache second beta witness turn");
        const r = await toolPost(h, { tool: "acp_cache", args: {}, conversationId: "hs-a" });
        assert.equal(r.status, 409, "unmarked resolvable body id contradicted by a unique witness must fail closed (#2016)");
        assert.equal((r.json as Record<string, unknown> | null)?.code, "TOOL_CONVERSATION_CONFLICT");

        // No regression to the common path: a flagged caller whose own witness
        // agrees with its id serves normally.
        resetToolRingForTest();
        await modelTurn(h, "hs-a", "WITNESS:acp_cache alpha's own witness turn");
        const outOwn = await forwardTool(h.baseUrl, "hs-a", "acp_cache", {}, undefined, true);
        assert.ok(outOwn.text.includes(urlA), "agreeing witness + stamped id must still serve the caller's session");
    } finally {
        await h.stop();
    }
});

test("#2072 e2e: unknown flagged caller fails loudly even with a fresh sibling witness — no rescue, no adoption", async () => {
    const h = await boot();
    try {
        await modelTurn(h, "hs-a", "alpha plain turn");
        await modelTurn(h, "hs-b", "WITNESS:acp_cache beta witness turn");
        await assert.rejects(
            forwardTool(h.baseUrl, "hs-never-seen", "acp_cache", {}, undefined, true),
            /no model request has arrived/,
            "#1158 diagnostic must point at the unknown id — stamping grants precedence, never existence",
        );
    } finally {
        await h.stop();
    }
});
