// #1920: `bili statusline` — origin resolution, the never-fail print path,
// and a spawn smoke of the real CLI entry (the exact command form the managed
// settings block bakes into claude).

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveStatuslineOrigin, runStatusline } from "../src/statusline.ts";

const WRAPPED = "http://127.0.0.1:48787/bili/https://api.anthropic.com";
const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(ENTRY));

test("resolveStatuslineOrigin: explicit override wins, trailing slash stripped", () => {
    assert.equal(resolveStatuslineOrigin({ origin: "http://127.0.0.1:9999/" }), "http://127.0.0.1:9999");
    assert.equal(
        resolveStatuslineOrigin({ origin: "http://127.0.0.1:9999", env: { BILI_MCP_PROXY: "http://127.0.0.1:8" } as NodeJS.ProcessEnv }),
        "http://127.0.0.1:9999",
    );
});

test("resolveStatuslineOrigin: BILI_MCP_PROXY beats ANTHROPIC_BASE_URL; wrapped URL unwraps to the proxy origin", () => {
    assert.equal(
        resolveStatuslineOrigin({ env: { BILI_MCP_PROXY: "http://127.0.0.1:7000", ANTHROPIC_BASE_URL: WRAPPED } as NodeJS.ProcessEnv }),
        "http://127.0.0.1:7000",
    );
    assert.equal(
        resolveStatuslineOrigin({ env: { ANTHROPIC_BASE_URL: WRAPPED } as NodeJS.ProcessEnv }),
        "http://127.0.0.1:48787",
    );
});

test("resolveStatuslineOrigin: kill switch suppresses the wrapped URL; foreign base URL falls to the lane port", async () => {
    // detectProxyBase reads process.env for the kill switch, so set the real env
    const saved = process.env.BILLION_CONTEXT_PLUGIN;
    process.env.BILLION_CONTEXT_PLUGIN = "0";
    try {
        // unique port: cannot collide with any fallback branch (sticky zone record / zone base)
        const off = resolveStatuslineOrigin({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:49991/bili/https://api.anthropic.com" } as NodeJS.ProcessEnv });
        assert.notEqual(off, "http://127.0.0.1:49991", "kill switch must ignore the wrapped URL");
        assert.match(off ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
        if (saved === undefined) delete process.env.BILLION_CONTEXT_PLUGIN; else process.env.BILLION_CONTEXT_PLUGIN = saved;
    }
    const foreign = resolveStatuslineOrigin({ env: { ANTHROPIC_BASE_URL: "https://relay.example/v1" } as NodeJS.ProcessEnv });
    assert.match(foreign ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
});

async function withFakeProxy(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ origin: string; close(): Promise<void> }> {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as net.AddressInfo).port;
    return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("runStatusline: prints the proxy-rendered min line for the stdin session id", async () => {
    const seen: string[] = [];
    const proxy = await withFakeProxy((req, res) => {
        seen.push(req.url ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, statusLine: { min: "bili 11% 96k/869k · saved 1.7M · 35blk · cache 96%", med: "longer" } }));
    });
    try {
        const line = await runStatusline({ origin: proxy.origin, readPayload: async () => JSON.stringify({ session_id: "sess-xyz" }) });
        assert.equal(line, "bili 11% 96k/869k · saved 1.7M · 35blk · cache 96%");
        assert.equal(seen[0], "/__bili/plugin/status?conversationId=sess-xyz");
    } finally {
        await proxy.close();
    }
});

test("runStatusline: never throws — 404, bad payload, dead origin all yield empty output", async () => {
    const proxy = await withFakeProxy((_req, res) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
    });
    try {
        assert.equal(await runStatusline({ origin: proxy.origin, readPayload: async () => JSON.stringify({ session_id: "s" }) }), "");
        assert.equal(await runStatusline({ origin: proxy.origin, readPayload: async () => "not json" }), "");
        assert.equal(await runStatusline({ origin: proxy.origin, readPayload: async () => "{}" }), "");
    } finally {
        await proxy.close();
    }
    // dead port: connect refused must still degrade to ""
    assert.equal(await runStatusline({ origin: "http://127.0.0.1:1", readPayload: async () => '{"session_id":"s"}' }), "");
});

test("runStatusline: old proxies without statusLine render nothing (graceful)", async () => {
    const proxy = await withFakeProxy((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, contextTokens: 1234 }));
    });
    try {
        assert.equal(await runStatusline({ origin: proxy.origin, readPayload: async () => '{"session_id":"s"}' }), "");
    } finally {
        await proxy.close();
    }
});

function spawnStatusline(args: string[], stdinPayload: string): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", ENTRY, "statusline", ...args], { cwd: REPO_ROOT });
        let stdout = "";
        const timer = setTimeout(() => child.kill(), 60_000);
        child.stdout.on("data", (d: Buffer) => (stdout += d));
        child.stderr.on("data", () => {});
        child.on("error", (err) => { clearTimeout(timer); reject(err); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout }); });
        child.stdin.on("error", () => {});
        child.stdin.end(stdinPayload);
    });
}

test("CLI smoke: `node src/index.ts statusline` prints the line end-to-end (real argv, real stdin)", async () => {
    const proxy = await withFakeProxy((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, statusLine: { min: "bili 42%" } }));
    });
    try {
        const { code, stdout } = await spawnStatusline(["--origin", proxy.origin], JSON.stringify({ session_id: "smoke-sid" }));
        assert.equal(code, 0);
        assert.equal(stdout, "bili 42%");
    } finally {
        await proxy.close();
    }
});

test("CLI smoke: no payload → empty stdout, exit 0 (never fail the host)", async () => {
    const { code, stdout } = await spawnStatusline([], "");
    assert.equal(code, 0);
    assert.equal(stdout, "");
});
