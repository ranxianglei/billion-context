import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistry } from "../src/registry.ts";
import { _resetPluginStateForTest, recordPluginSession, resolveConversation, loadConversations, flushConversations } from "../src/plugin.ts";
import { getSession } from "../src/session.ts";
import { stateDir } from "../src/paths.ts";

process.env.NODE_ENV = "test";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-parent-binding-"));
process.env.XDG_STATE_HOME = root;
after(() => { _resetPluginStateForTest(); fs.rmSync(root, { recursive: true, force: true }); });

for (const protocol of ["responses", "openai", "anthropic"] as const) {
    for (const pluginMode of [true, false]) {
        test(`native parent routing survives shared cache keys: ${protocol}, plugin=${pluginMode}`, { timeout: 20000 }, async () => {
            _resetPluginStateForTest();
            _setStoreForTest(new SessionStore({ enabled: false }));
            setRegistry({});
            const parent = `parent-${randomUUID()}`, child = `child-${randomUUID()}`, grandchild = `grandchild-${randomUUID()}`;
            const captured: Record<string, unknown>[] = [];
            const upstream = http.createServer(async (req, res) => {
                const chunks: Buffer[] = [];
                for await (const chunk of req) chunks.push(Buffer.from(chunk));
                captured.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
                res.writeHead(200, { "content-type": "application/json" });
                const input = captured.length === 1 ? 4000 : 800;
                if (protocol === "responses") res.end(JSON.stringify({ id: `resp_${captured.length}`, object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: input, output_tokens: 1, total_tokens: input + 1 } }));
                else if (protocol === "openai") res.end(JSON.stringify({ id: `chat_${captured.length}`, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: input, completion_tokens: 1, total_tokens: input + 1 } }));
                else res.end(JSON.stringify({ id: `msg_${captured.length}`, type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: input, output_tokens: 1 } }));
            });
            upstream.listen(0, "127.0.0.1");
            await once(upstream, "listening");
            const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
            const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamOrigin, routes: { [upstreamOrigin]: { models: { "binding-model": { context: 100000 } } } }, modelContextLimit: 100000, kernelConfig: defaultConfig(100000), compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false, mitm: { enabled: false, domains: [] } });
            await once(proxy, "listening");
            const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
            const endpoint = protocol === "responses" ? "responses" : protocol === "openai" ? "chat/completions" : "messages";
            const send = async (id: string) => {
                const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": id };
                if (pluginMode) Object.assign(headers, { "x-bili-plugin": "opencode", "x-bili-plugin-conversation": id });
                const content = [{ role: "user", content: `request from ${id}` }];
                const body = { model: "binding-model", stream: false, prompt_cache_key: parent, ...(protocol === "responses" ? { instructions: "routing test", input: content } : { messages: content, max_tokens: 1000 }) };
                const response = await fetch(`${base}/bili/${upstreamOrigin}/v1/${endpoint}`, { method: "POST", headers, body: JSON.stringify(body) });
                assert.equal(response.status, 200, await response.text());
            };
            const check = async () => {
                const response = await fetch(`${base}/__bili/plugin/status?conversationId=${parent}`);
                const status = await response.json() as { conversationId: string; webUrl: string };
                assert.equal(status.conversationId, parent);
                assert.ok(status.webUrl.endsWith(`/session/${parent}`), "parent lookup must retain the native parent source");
                assert.equal(resolveConversation(parent).session?.id, parent);
                assert.equal(resolveConversation(child).session?.id, child);
            };
            try {
                await send(parent);
                await send(child);
                await check();
                const registration = await fetch(`${base}/__bili/plugin/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: grandchild, agent: "opencode", identity: true, parentConversationId: parent }) });
                assert.equal(registration.status, 200);
                await send(grandchild);
                assert.equal(getSession(grandchild).metadata.derivedFromSessionId, parent, "lineage must not resolve the sibling");
                await send(parent);
                await send(child);
                await check();
                const tool = await fetch(`${base}/__bili/plugin/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: parent, tool: "acp_cache", args: {} }) });
                assert.equal(tool.status, 200);
                const receipt = await tool.json() as { conversationId: string; result: string };
                assert.equal(receipt.conversationId, parent);
                assert.ok(receipt.result.startsWith(`Web UI: ${base}/__bili/#/session/${parent}\n`));
                assert.ok(captured.every(body => body.prompt_cache_key === (protocol === "anthropic" ? undefined : parent)), "existing wire cache-key handling remains unchanged");
            } finally {
                proxy.closeAllConnections(); upstream.closeAllConnections();
                await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
            }
        });
    }
}

test("native lookup repairs a persisted bad mapping while preserving legitimate aliases", () => {
    _resetPluginStateForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    const parent = getSession(`parent-${randomUUID()}`), child = getSession(`child-${randomUUID()}`);
    const alias = `alias-${randomUUID()}`;
    fs.mkdirSync(stateDir(), { recursive: true });
    const file = path.join(stateDir(), "plugin-conversations.json");
    fs.writeFileSync(file, JSON.stringify({ [parent.id]: { sessionId: child.id, lastSeen: 1 }, [alias]: { sessionId: child.id, lastSeen: 1 } }));
    loadConversations();
    const resolved = resolveConversation(parent.id);
    assert.equal(resolved.session?.id, parent.id);
    assert.equal(resolved.entry?.sessionId, parent.id);
    assert.equal(resolveConversation(alias).session?.id, child.id);
    flushConversations();
    assert.equal((JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { sessionId: string }>)[parent.id].sessionId, parent.id);
});

test("registration cannot overwrite a native session, but ordinary aliases remain usable", () => {
    const parent = getSession(`parent-${randomUUID()}`), child = getSession(`child-${randomUUID()}`);
    recordPluginSession(parent.id, parent.id);
    recordPluginSession(parent.id, child.id);
    flushConversations();
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir(), "plugin-conversations.json"), "utf8")) as Record<string, { sessionId: string }>;
    assert.equal(saved[parent.id].sessionId, parent.id);
    const alias = `alias-${randomUUID()}`;
    recordPluginSession(alias, child.id);
    assert.equal(resolveConversation(alias).session?.id, child.id);
});

test("a known native binding remains reserved when its session is not resident", () => {
    const parentId = `absent-parent-${randomUUID()}`, child = getSession(`child-${randomUUID()}`);
    recordPluginSession(parentId, parentId);
    recordPluginSession(parentId, child.id);
    assert.equal(resolveConversation(parentId).session, undefined);
    flushConversations();
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir(), "plugin-conversations.json"), "utf8")) as Record<string, { sessionId: string }>;
    assert.equal(saved[parentId].sessionId, parentId);
});
