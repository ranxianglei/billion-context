// #1146: /acp-cache command hook shared by opencode V1 (launcher + native). The
// report is forwarded to the proxy's acp_cache tool and rendered as an ignored
// message wrapped in [acp-cache] markers, which is what lets the proxy strip it
// out of model context by content signature.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createAcpCommandHooks, type OpencodeClient } from "../src/agent/opencode-acp-command.ts";
import { wrapCacheReport } from "../src/acp-panel.ts";

type ToolCall = { conversationId: string; tool: string; args: unknown };
type Rendered = { sid: string; text: string };

function startToolProxy(result: string | undefined, error?: string): Promise<{ origin: string; calls: ToolCall[]; close(): Promise<void> }> {
    const calls: ToolCall[] = [];
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/tool" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const data = JSON.parse(body) as ToolCall;
                calls.push(data);
                res.writeHead(200, { "content-type": "application/json" });
                if (error !== undefined) res.end(JSON.stringify({ ok: false, error }));
                else res.end(JSON.stringify({ ok: true, result }));
            });
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => ({
        origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        calls,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }));
}

function makeCtx(prompts: Rendered[]): { client: OpencodeClient } {
    return {
        client: {
            session: {
                prompt: async ({ path, body }) => {
                    prompts.push({ sid: path.id, text: body.parts[0].text });
                },
            },
        },
    };
}

const HANDLED = /__BILI_ACP_HANDLED__/;

test("config registers both /acp and /acp-cache (#1146)", async () => {
    const hooks = createAcpCommandHooks(() => "http://127.0.0.1:1", {});
    const cfg: Record<string, unknown> = {};
    await hooks.config?.(cfg as never);
    const command = cfg.command as Record<string, { template: string; description?: string }>;
    assert.ok(command.acp, "/acp registered");
    assert.ok(command["acp-cache"], "/acp-cache registered");
    assert.match(command["acp-cache"].description!, /full/);
});

test("/acp-cache forwards acp_cache and renders the wrapped report via session.prompt (#1146)", async () => {
    const proxy = await startToolProxy("REPORT-BODY");
    try {
        const prompts: Rendered[] = [];
        const hooks = createAcpCommandHooks(() => proxy.origin, makeCtx(prompts));
        await assert.rejects(hooks["command.execute.before"]?.({ command: "acp-cache", sessionID: "ses_x" }), HANDLED);
        assert.deepEqual(proxy.calls, [{ conversationId: "ses_x", tool: "acp_cache", args: {} }]);
        assert.equal(prompts.length, 1);
        assert.equal(prompts[0].sid, "ses_x");
        assert.equal(prompts[0].text, wrapCacheReport("REPORT-BODY"));
    } finally {
        await proxy.close();
    }
});

test("/acp-cache full flag maps to detail=full (word boundary only) (#1146)", async () => {
    const cases: Array<[string, unknown]> = [
        ["full", { detail: "full" }],
        ["--full", { detail: "full" }],
        ["x full y", { detail: "full" }],
        ["fully", {}],
        ["", {}],
    ];
    for (const [args, expected] of cases) {
        const proxy = await startToolProxy("R");
        try {
            const hooks = createAcpCommandHooks(() => proxy.origin, {});
            await assert.rejects(hooks["command.execute.before"]?.({ command: "acp-cache", sessionID: "s", arguments: args }), HANDLED);
            assert.deepEqual(proxy.calls[0]?.args, expected, `arguments=${JSON.stringify(args)}`);
        } finally {
            await proxy.close();
        }
    }
});

test("/acp-cache with no proxy base renders a diagnostic and still handles (#1146)", async () => {
    const prompts: Rendered[] = [];
    const hooks = createAcpCommandHooks(() => undefined, makeCtx(prompts));
    await assert.rejects(hooks["command.execute.before"]?.({ command: "acp-cache", sessionID: "s" }), HANDLED);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].text, /no bili proxy detected/);
});

test("/acp-cache renders proxy-side failures unwrapped (#1146)", async () => {
    const proxy = await startToolProxy(undefined, "boom");
    try {
        const prompts: Rendered[] = [];
        const hooks = createAcpCommandHooks(() => proxy.origin, makeCtx(prompts));
        await assert.rejects(hooks["command.execute.before"]?.({ command: "acp-cache", sessionID: "s" }), HANDLED);
        assert.equal(prompts.length, 1);
        assert.match(prompts[0].text, /cache report failed/);
        assert.match(prompts[0].text, /boom/);
        assert.ok(!prompts[0].text.startsWith("[acp-cache]"), "errors are not wrapped");
    } finally {
        await proxy.close();
    }
});

test("/acp-cache on an unknown conversation renders the friendly no-session notice (#1146)", async () => {
    const proxy = await startToolProxy(undefined, 'unknown plugin conversation id "s" (no model request has arrived with this conversation id yet)');
    try {
        const prompts: Rendered[] = [];
        const hooks = createAcpCommandHooks(() => proxy.origin, makeCtx(prompts));
        await assert.rejects(hooks["command.execute.before"]?.({ command: "acp-cache", sessionID: "s" }), HANDLED);
        assert.equal(prompts.length, 1);
        assert.match(prompts[0].text, /no ACP session yet/);
    } finally {
        await proxy.close();
    }
});

test("execute.before ignores other commands without touching the proxy (#1146)", async () => {
    const proxy = await startToolProxy("R");
    try {
        const prompts: Rendered[] = [];
        const hooks = createAcpCommandHooks(() => proxy.origin, makeCtx(prompts));
        await hooks["command.execute.before"]?.({ command: "other", sessionID: "s" });
        assert.equal(proxy.calls.length, 0);
        assert.equal(prompts.length, 0);
    } finally {
        await proxy.close();
    }
});

// #1603: /acp must surface a stale install (on-disk newer than running code) so
// a long-lived host user can act. Serves both status endpoints the hook reads.
function startAcpProxy(opts: { panel?: string; ok?: boolean; status?: object | null }): Promise<{ origin: string; close(): Promise<void> }> {
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url.startsWith("/__bili/plugin/status")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: opts.ok ?? true, panel: opts.panel ?? "" }));
            return;
        }
        if (url.startsWith("/__bili/status")) {
            if (opts.status === null) {
                res.writeHead(500);
                res.end("{}");
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(opts.status ?? { version: "1.0.0", diskVersion: "1.0.0", stale: false }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => ({
        origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }));
}

test("/acp appends a staleness notice when the on-disk install is newer (#1603)", async () => {
    const proxy = await startAcpProxy({
        panel: "ACP-PANEL",
        status: { version: "1.0.0", diskVersion: "2.0.0", stale: true, autoRestartOnUpdate: false },
    });
    try {
        const prompts: Rendered[] = [];
        const hooks = createAcpCommandHooks(() => proxy.origin, makeCtx(prompts));
        await assert.rejects(hooks["command.execute.before"]?.({ command: "acp", sessionID: "s" }), HANDLED);
        assert.equal(prompts.length, 1);
        assert.ok(prompts[0].text.includes("ACP-PANEL"), "panel is preserved");
        assert.match(prompts[0].text, /is stale/);
        assert.match(prompts[0].text, /v1\.0\.0/);
        assert.match(prompts[0].text, /v2\.0\.0/);
        assert.match(prompts[0].text, /restart the host/i);
    } finally {
        await proxy.close();
    }
});

test("/acp omits the notice when the running install matches disk (#1603)", async () => {
    const proxy = await startAcpProxy({
        panel: "ACP-PANEL",
        status: { version: "2.0.0", diskVersion: "2.0.0", stale: false },
    });
    try {
        const prompts: Rendered[] = [];
        const hooks = createAcpCommandHooks(() => proxy.origin, makeCtx(prompts));
        await assert.rejects(hooks["command.execute.before"]?.({ command: "acp", sessionID: "s" }), HANDLED);
        assert.equal(prompts.length, 1);
        assert.equal(prompts[0].text, "ACP-PANEL");
    } finally {
        await proxy.close();
    }
});

test("/acp still renders when the /__bili/status probe is unreachable (#1603)", async () => {
    const proxy = await startAcpProxy({ panel: "ACP-PANEL", status: null });
    try {
        const prompts: Rendered[] = [];
        const hooks = createAcpCommandHooks(() => proxy.origin, makeCtx(prompts));
        await assert.rejects(hooks["command.execute.before"]?.({ command: "acp", sessionID: "s" }), HANDLED);
        assert.equal(prompts.length, 1);
        assert.equal(prompts[0].text, "ACP-PANEL");
    } finally {
        await proxy.close();
    }
});
