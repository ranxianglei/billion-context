import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { DSH_TITLE_SYSTEM_PREFIX } from "../src/server/side-request.ts";

// #2503 handle-level pin (complements the pure-predicate pin in
// tests/dsh-title-side-lane.test.ts): on dsh 0.2.1-alpha.2 the title sidecar
// carries max_completion_tokens=4096 and NO persona agent header, so it slips
// past the legacy isSideRequest heuristic (budget <= SIDE_REQUEST_MAX_TOKENS)
// and is treated as a main turn — under the #1916 dsh persona fingerprint it
// then either claims the raw anchor before the first main turn arrives
// (#2156/#2160 ordering hazard) or forks onto a persisted |sub:<fp> ghost
// session. The fix routes it through the #388 verbatim passthrough under the
// raw key via a structural predicate wired into handle() at BOTH decision
// points. This test drives that wiring hermetically (no real dsh binary
// needed): title-FIRST ordering, the OpenAI wire (dsh's actual shape),
// byte-verbatim forwarding, zero kernel-state impact, and no ghost minted at
// any point. Delete either disjunct in src/server/handle.ts and this goes red.
process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-dsh-title-side-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const TITLE_SYSTEM = `${DSH_TITLE_SYSTEM_PREFIX} from the supplied human messages.\nReturn only the title on one line.`;
const MAIN_SYSTEM = "MAIN OPERATING SYSTEM";

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    mkdirSync(join(dir, "billion-context", "sessions"), { recursive: true });
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
                const anthropicWire = (req.url ?? "").includes("/messages");
                res.end(JSON.stringify(anthropicWire
                    ? { id: "msg_test", type: "message", role: "assistant", model: "fake-a", content: [{ type: "text", text: "answer" }], stop_reason: "end_turn", usage: { input_tokens: 10000, output_tokens: 10 } }
                    : { id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.close(); } }));
    });
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstream.url, routes: { [upstream.url]: { models: { "fake-a": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    // dsh shape: x-bili-plugin + conversation headers always; the persona agent
    // header is stamped on MAIN turns only — the title sidecar arrives without
    // it (that absence is part of what blinded the legacy heuristic).
    const dshSend = async (conversationId: string, body: Record<string, unknown>, agent?: string) => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId };
        if (agent !== undefined) headers["x-bili-plugin-agent"] = agent;
        const response = await fetch(`${origin}/bili/${upstream.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(response.status, 200, await response.text());
    };
    const dshSendAnthropic = async (conversationId: string, body: Record<string, unknown>, agent?: string) => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId };
        if (agent !== undefined) headers["x-bili-plugin-agent"] = agent;
        const response = await fetch(`${origin}/bili/${upstream.url}/v1/messages`, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(response.status, 200, await response.text());
    };
    const sessionIds = async () => ((await (await fetch(origin + "/__bili/sessions")).json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    const subSessions = async (prefix: string) => (await sessionIds()).filter((id) => id.startsWith(prefix + "|sub:"));
    const status = async (conversationId: string) => (await (await fetch(`${origin}/__bili/plugin/status?conversationId=${conversationId}`)).json()) as { contextTokens: number | null; inputTokens: number };
    return { forwarded, dshSend, dshSendAnthropic, subSessions, status, origin, close: async () => { store.cancelAll(); proxy.close(); upstream.close(); await new Promise((r2) => setTimeout(r2, 50)); } };
}

test("dsh alpha.2 title sidecar rides the #388 passthrough under the raw key (no |sub: ghost)", async () => {
    const h = await harness();
    try {
        const history = [
            { role: "user", content: "set up the workspace" },
            { role: "assistant", content: "done" },
        ];
        const titleBody = (msgs: unknown[]) => ({ model: "fake-a", max_completion_tokens: 4096, stream: false, messages: [{ role: "system", content: TITLE_SYSTEM }, ...msgs] });

        // 1. the title sidecar fires at session start — BEFORE any main turn has
        //    anchored the id (#2156/#2160 ordering hazard). alpha.2 shape:
        //    budget 4096, no tools, no agent header.
        const t1Body = titleBody([...history, { role: "user", content: `[${JSON.stringify(history)}]` }]);
        await h.dshSend("conv1", t1Body);
        assert.deepEqual(h.forwarded.at(-1), t1Body, "title sidecar forwarded verbatim (alpha.2 budget intact, nothing injected)");
        assert.deepEqual(await h.subSessions("conv1"), [], "the first sidecar mints no |sub: ghost and claims no fork");

        // 2. first real main turn — full pipeline on the raw key (the sidecar
        //    must not have claimed the anchor with its title system prompt).
        await h.dshSend("conv1", { model: "fake-a", max_completion_tokens: 8192, stream: false, messages: [{ role: "system", content: MAIN_SYSTEM }, ...history, { role: "assistant", content: "ok" }, { role: "user", content: "now configure ci" }], tools: [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object", properties: {} } } }] }, "main");
        let session = resolveConversation("conv1").session!;
        assert.ok(session, "raw-key session exists");
        assert.equal(session.stats.requests, 1, "the main turn runs the full pipeline exactly once");
        assert.deepEqual(await h.subSessions("conv1"), [], "the main turn stays on the raw key (no persona fork)");

        // 3. second sidecar after anchoring — still verbatim, kernel state untouched.
        const statusBefore = await h.status("conv1");
        const t3Body = titleBody([...history, { role: "assistant", content: "ok" }, { role: "user", content: "now configure ci" }, { role: "user", content: `[${JSON.stringify(history)}]` }]);
        await h.dshSend("conv1", t3Body);
        assert.deepEqual(h.forwarded.at(-1), t3Body, "post-anchor sidecar still forwarded verbatim");
        session = resolveConversation("conv1").session!;
        assert.equal(session.stats.requests, 1, "the second sidecar must not count as a main request");
        const statusAfter = await h.status("conv1");
        assert.equal(statusAfter.inputTokens, statusBefore.inputTokens, "sidecar must not touch the usage baseline");
        assert.equal(statusAfter.contextTokens, statusBefore.contextTokens, "sidecar must not touch the context estimate");
        assert.ok(!JSON.stringify(session.pluginSnapshot).includes(DSH_TITLE_SYSTEM_PREFIX), "title instruction never lands in the kernel session");
        assert.deepEqual(await h.subSessions("conv1"), [], "still no |sub: ghost after anchoring");
    } finally {
        await h.close();
    }
});

// #3149: on the anthropic wire the title prompt rides the TOP-LEVEL `system`
// field (messages[] holds only the user blob). #2503 read messages[] only, so
// here the sidecar claimed the raw anchor and forked the conversation onto a
// persisted |sub:<fp> ghost — one DSH session listed twice in the Web UI.
test("dsh alpha.2 title sidecar on the anthropic wire keeps the raw key — no |sub: ghost (#3149)", async () => {
    const h = await harness();
    try {
        const history = [
            { role: "user", content: "set up the workspace" },
            { role: "assistant", content: "done" },
        ];
        // 1. title sidecar first, anthropic shape: budget 4096, no tools, no
        //    agent header, system at the top level (nothing in messages[]).
        const t1Body = { model: "fake-a", max_tokens: 4096, system: TITLE_SYSTEM, messages: [{ role: "user", content: `[${JSON.stringify(history)}]` }] };
        await h.dshSendAnthropic("conv-anthropic", t1Body);
        assert.deepEqual(h.forwarded.at(-1), t1Body, "title sidecar forwarded verbatim on the anthropic wire");
        assert.deepEqual(await h.subSessions("conv-anthropic"), [], "the anthropic sidecar mints no |sub: ghost");
        const sideSession = resolveConversation("conv-anthropic").session;
        assert.equal(sideSession?.stats.requests ?? 0, 0, "the sidecar claims no anchor and runs no kernel request");

        // 2. first real main turn — real top-level system + tools; it must claim
        //    the raw key rather than fork behind a title-prompt anchor.
        const mainBody = {
            model: "fake-a",
            max_tokens: 8192,
            system: MAIN_SYSTEM,
            messages: [...history, { role: "assistant", content: "ok" }, { role: "user", content: "now configure ci" }],
            tools: [{ name: "bash", description: "run a command", input_schema: { type: "object", properties: {} } }],
        };
        await h.dshSendAnthropic("conv-anthropic", mainBody, "main");
        const session = resolveConversation("conv-anthropic").session;
        assert.ok(session, "raw-key session exists");
        assert.equal(session.stats.requests, 1, "the main turn runs the full pipeline exactly once on the raw key");
        assert.deepEqual(await h.subSessions("conv-anthropic"), [], "the main conversation stays on the raw key — no |sub:<fp> ghost");
    } finally {
        await h.close();
    }
});
