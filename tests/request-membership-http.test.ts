import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";

process.env.NODE_ENV = "test";
const root = mkdtempSync(join(tmpdir(), "bili-membership-http-"));
const envKeys = ["XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "BILI_CONFIG_FILE", "BILI_SESSIONS_DIR", "BILI_STORAGE_UNIFIED"] as const;
const previousEnv = envKeys.map((key) => process.env[key]);
for (const key of envKeys) process.env[key] = join(root, key);
process.env.BILI_STORAGE_UNIFIED = "legacy";
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { startServer } = await import("../src/server.ts");
const { _resetSessionsForTest, peekSession } = await import("../src/session.ts");
const { closeLogger } = await import("../src/logger.ts");
test.after(async () => {
    await closeLogger();
    envKeys.forEach((key, index) => {
        if (previousEnv[index] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[index];
    });
    rmSync(root, { recursive: true, force: true });
});

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function messages(id?: string): Record<string, unknown>[] {
    const history: Record<string, unknown>[] = [
        { role: "system", content: "You are a helpful coding assistant." },
        { role: "user", content: id?.includes("foreign") ? "Review this separate change. ".repeat(100) : "Review this project. ".repeat(1000) },
    ];
    if (id) history.push(
        { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", tool_call_id: id, content: `${id} project details. `.repeat(100) },
    );
    history.push({ role: "user", content: "Continue the review." });
    return history;
}

test("HTTP membership abstains on a no-ID request after either foreign or member evidence", async () => {
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    let usage = 100_000;
    let forwarded = 0;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            forwarded++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: `reply-${forwarded}`, object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "Reviewed." }, finish_reason: "stop" }],
                usage: { prompt_tokens: usage, completion_tokens: 5 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const opts: ProxyOptions = {
        port: 0, host: "127.0.0.1", upstream: origin,
        routes: { [origin]: { models: { "gpt-test": { context: 1_000_000 } } } },
        modelContextLimit: 1_000_000, kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
        autoUpdate: false, autoRestartOnUpdate: false, advisoryCheck: false, releaseNotesCheck: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
        updateTag: "latest", mitm: { enabled: false, domains: [] },
    };
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer(opts);
        if (!proxy.listening) await once(proxy, "listening");
        const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${origin}/v1/chat/completions`;
        async function turn(sessionId: string, ids: string | undefined, tokens: number): Promise<void> {
            usage = tokens;
            const response = await fetch(url, {
                method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId },
                body: JSON.stringify({ model: "gpt-test", stream: false, messages: messages(ids) }),
            });
            const body = await response.text();
            assert.equal(response.status, 200, body);
        }
        for (const prior of ["foreign", "member"] as const) {
            const sid = `membership-http-${prior}`;
            await turn(sid, "main-call", 100_000);
            const session = peekSession(sid);
            assert.ok(session, "the proxy must retain the explicitly named session");
            assert.equal(session.stats.lastInputTokens, 100_000);
            await turn(sid, "main-call", 100_000);
            assert.equal(session.transient?.latestKnownMsgId, "main-call");
            await turn(sid, prior === "foreign" ? "foreign-call" : "main-call", prior === "foreign" ? 5_000 : 110_000);
            assert.equal(session.transient?.requestMembership?.member, prior === "member");
            assert.equal(session.stats.lastInputTokens, prior === "foreign" ? 100_000 : 110_000);
            await turn(sid, undefined, 200_000);
            assert.equal(session.stats.lastInputTokens, 200_000, `${prior} verdict must not outlive its request`);
            assert.equal(session.transient?.requestMembership, undefined);
            await turn(sid, "another-foreign-call", 5_000);
            assert.equal(session.stats.lastInputTokens, 200_000, "a later evidenced foreign request is still refused");
        }
        assert.equal(forwarded, 10);
    } finally {
        if (proxy) await close(proxy);
        await close(upstream);
        _resetSessionsForTest();
    }
});
