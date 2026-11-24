import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { watchdogTick, type MutableWatchdogState, type WatchdogDeps } from "../src/claude-mcp-entry.ts";
import { forwardTool } from "../src/mcp.ts";
import { readClaudeManagedBaseUrl, repinClaudeManagedBaseUrl } from "../src/plugin-install.ts";
import { rmrf } from "./tmp-rm.ts";

type HealthReply = { status: number; body: string; contentType?: string; stall?: "headers" | "body" };
type Request = { listener: "old" | "replacement"; url: string; body?: Record<string, unknown> };

async function fixture(t: TestContext, initialReply: HealthReply) {
    let reply = initialReply;
    const requests: Request[] = [];
    const servers: http.Server[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-health-payload-"));
    const env = { CLAUDE_CONFIG_DIR: dir };
    const previousPin = process.env.BILI_MCP_PROXY;
    t.after(async () => {
        if (previousPin === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = previousPin;
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        rmrf(dir);
    });

    const listen = async (listener: "old" | "replacement"): Promise<string> => {
        const server = http.createServer(async (req, res) => {
            let raw = "";
            for await (const chunk of req) raw += chunk;
            const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
            requests.push({ listener, url: req.url ?? "", body });
            if (req.url === "/__bili/health" && listener === "old") {
                if (reply.stall === "headers") return;
                res.writeHead(reply.status, { "content-type": reply.contentType ?? "application/json" });
                if (reply.stall === "body") {
                    res.write(reply.body);
                    return;
                }
                res.end(reply.body);
                return;
            }
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(req.url === "/__bili/plugin/tool"
                ? { ok: true, result: `ACP receipt from ${listener}`, outcome: "success" }
                : { ok: true, version: "0.1.216" }));
        });
        servers.push(server);
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address === "object");
        return `http://127.0.0.1:${address.port}`;
    };

    const origin = await listen("old");
    const replacement = await listen("replacement");
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
        env: { ANTHROPIC_BASE_URL: `${origin}/bili/https://api.anthropic.com`, KEEP_SETTING: "unchanged" },
        permissions: { allow: ["Read"] },
    }));
    process.env.BILI_MCP_PROXY = origin;
    const state: MutableWatchdogState = { origin, failures: 0 };
    let ensureCalls = 0;
    const deps: WatchdogDeps = {
        ensure: async (opts) => {
            ensureCalls += 1;
            assert.equal(opts.port, 0);
            assert.equal(opts.strictPort, false);
            assert.equal(opts.lane, "claude");
            return { origin: replacement, port: Number(new URL(replacement).port), attached: true };
        },
        repin: (next) => repinClaudeManagedBaseUrl(next, env),
    };
    const tick = () => watchdogTick(state, { port: 0, strict: false }, deps, () => {});
    const assertRouting = async (listener: "old" | "replacement") => {
        const expected = listener === "replacement" ? replacement : origin;
        assert.equal(state.origin, expected);
        assert.equal(process.env.BILI_MCP_PROXY, expected);
        assert.equal(readClaudeManagedBaseUrl(env), expected);
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        assert.equal(settings.env.KEEP_SETTING, "unchanged");
        assert.deepEqual(settings.permissions, { allow: ["Read"] });
        const receipt = await forwardTool("acp_status", { detail: "preserved" }, 2_000, "health-payload-session");
        assert.equal(receipt.text, `ACP receipt from ${listener}`);
        const posts = requests.filter((request) => request.url === "/__bili/plugin/tool");
        assert.equal(posts.length, 1);
        assert.equal(posts[0].listener, listener);
        assert.equal(posts[0].body?.conversationId, "health-payload-session");
        assert.deepEqual(posts[0].body?.args, { detail: "preserved" });
    };
    return { state, tick, assertRouting, ensureCalls: () => ensureCalls, setReply: (next: HealthReply) => { reply = next; } };
}

for (const [name, reply] of [
    ["HTML with status 200", { status: 200, body: "<!doctype html><html>Development app</html>", contentType: "text/html" }],
    ["an explicit not-ok reply", { status: 200, body: '{"ok":false}' }],
    ["a string ok flag", { status: 200, body: '{"ok":"true"}' }],
    ["a numeric ok flag", { status: 200, body: '{"ok":1}' }],
    ["a missing ok flag", { status: 200, body: '{"version":"other-service"}' }],
    ["JSON null", { status: 200, body: "null" }],
    ["a JSON primitive", { status: 200, body: "true" }],
    ["malformed JSON", { status: 200, body: '{"ok":true' }],
    ["an empty 204 reply", { status: 204, body: "" }],
] satisfies Array<[string, HealthReply]>) {
    test(`Claude watchdog recovers after three health replies containing ${name}`, async (t) => {
        const f = await fixture(t, reply);
        await f.tick();
        assert.equal(f.state.failures, 1);
        await f.tick();
        assert.equal(f.state.failures, 2);
        assert.equal(f.ensureCalls(), 0);
        await f.tick();
        assert.equal(f.ensureCalls(), 1);
        assert.equal(f.state.failures, 0);
        await f.assertRouting("replacement");
        await f.tick();
        assert.equal(f.ensureCalls(), 1, "the replacement's valid health response prevents another recovery");
    });
}

for (const contentType of ["application/json", "text/plain"]) {
    test(`Claude watchdog accepts a valid health object served as ${contentType}`, async (t) => {
        const f = await fixture(t, { status: 200, body: '{"ok":true,"version":"0.1.216"}', contentType });
        f.state.failures = 2;
        await f.tick();
        assert.equal(f.state.failures, 0);
        assert.equal(f.ensureCalls(), 0);
        await f.assertRouting("old");
    });
}

test("Claude watchdog still rejects an HTTP error even with an ok payload", async (t) => {
    const f = await fixture(t, { status: 503, body: '{"ok":true}' });
    for (let i = 0; i < 3; i++) await f.tick();
    assert.equal(f.ensureCalls(), 1);
    await f.assertRouting("replacement");
});

test("Claude watchdog requires consecutive invalid payloads after a healthy reset", async (t) => {
    const f = await fixture(t, { status: 200, body: '{"ok":false}' });
    await f.tick();
    await f.tick();
    assert.equal(f.state.failures, 2);
    f.setReply({ status: 200, body: '{"ok":true}' });
    await f.tick();
    assert.equal(f.state.failures, 0);
    f.setReply({ status: 200, body: '{"ok":false}' });
    await f.tick();
    await f.tick();
    assert.equal(f.ensureCalls(), 0);
    await f.tick();
    assert.equal(f.ensureCalls(), 1);
    await f.assertRouting("replacement");
});

for (const stall of ["headers", "body"] as const) {
    test(`Claude watchdog bounds a stalled health ${stall} with its existing timeout`, { timeout: 10_000 }, async (t) => {
        const f = await fixture(t, { status: 200, body: '{"ok":', stall });
        f.state.failures = 2;
        await f.tick();
        assert.equal(f.ensureCalls(), 1, "an incomplete health reply cannot reset the failure counter");
        assert.equal(f.state.failures, 0);
        await f.assertRouting("replacement");
    });
}
