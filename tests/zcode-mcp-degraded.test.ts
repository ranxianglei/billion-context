// #1892: the zcode mcp-entry must never die before the MCP handshake when
// native routing has nothing to wrap (empty personal store / signing wall /
// no store). Master exited with code 0 pre-initialize — the client saw
// "Connection closed". The degraded entry stays a valid MCP server: idle
// (empty tool list, loud isError on tools/call) with no healthy proxy, and
// serves the REAL ACP tools through any live proxy it can find (cert-MITM
// boxes). Real-process e2e against the tsx source, sandboxed XDG + zcode
// data dir so the child can never touch the developer's real stores.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { AddressInfo } from "node:net";
import { rmrf } from "./tmp-rm.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const ENTRY = path.join(ROOT, "src", "zcode", "mcp-entry.ts");

interface Harness {
    child: ChildProcess;
    lines: string[];
    send(msg: unknown): void;
    exit: Promise<number | null>;
}

function sandboxEnv(sandbox: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
        "BILLION_CONTEXT_PROXY",
        "BILLION_CONTEXT_ATTACH",
        "BILLION_CONTEXT_PLUGIN",
        "BILI_MCP_PROXY",
        "BILI_MCP_DEFAULT_ORIGIN",
        "BILI_PROVIDER_REWRITES",
        "BILI_MITM_HOSTS",
        "BILI_ZCODE_ROUTE",
        "NODE_TEST_CONTEXT",
    ]) {
        delete env[key];
    }
    env.XDG_STATE_HOME = sandbox;
    env.XDG_CACHE_HOME = path.join(sandbox, "cache");
    env.XDG_DATA_HOME = path.join(sandbox, "data");
    env.XDG_CONFIG_HOME = path.join(sandbox, "config");
    return { ...env, ...extra };
}

function spawnEntry(env: NodeJS.ProcessEnv): Harness {
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
    const lines: string[] = [];
    child.stdout!.on("data", (d: Buffer) => {
        for (const l of d.toString().split("\n")) if (l.trim()) lines.push(l.trim());
    });
    child.stderr!.on("data", () => {});
    const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    return { child, lines, send: (msg) => child.stdin!.write(JSON.stringify(msg) + "\n"), exit };
}

function byId(lines: string[], n: number): Record<string, unknown> {
    return JSON.parse(lines.find((l) => (JSON.parse(l) as { id?: number }).id === n) ?? "{}");
}

async function waitFor(cond: () => boolean, what: string, ms = 15000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timeout waiting for ${what}; lines: ${lines_json(linesHolder!)}`);
}
let linesHolder: string[] | undefined;
function lines_json(l: string[]): string {
    return JSON.stringify(l.slice(-5));
}

/** Empty personal provider store (the #1892 reporter's world): v2 dir with a
 *  valid provider_config.json whose providerRules is []. */
function writeEmptyPersonalStore(sandbox: string): void {
    const zcode = path.join(sandbox, "zcode-data", ".zcode");
    mkdirSync(path.join(zcode, "v2"), { recursive: true });
    writeFileSync(
        path.join(zcode, "v2", "provider_config.json"),
        JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [] } } }) + "\n",
    );
}

test("mcp-entry serves an idle handshake instead of dying pre-initialize (#1892 empty store, no proxy)", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "zcode-degraded-idle-"));
    try {
        writeEmptyPersonalStore(sandbox);
        const env = sandboxEnv(sandbox, { ZCODE_DATA_BASE_DIR: path.join(sandbox, "zcode-data"), BILI_MCP_DEFAULT_ORIGIN: "http://127.0.0.1:1" });
        const h = spawnEntry(env);
        linesHolder = h.lines;
        try {
            h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
            h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
            h.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
            h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "compress", arguments: {} } });
            await waitFor(() => h.lines.length >= 3, "initialize + tools/list + tools/call responses");
            const init = byId(h.lines, 1) as { result?: { serverInfo?: { name?: string } } };
            assert.equal(init.result?.serverInfo?.name, "bili");
            const list = byId(h.lines, 2) as { result?: { tools?: unknown[] } };
            assert.deepEqual(list.result?.tools, []);
            const call = byId(h.lines, 3) as { result?: { isError?: boolean; content?: { type: string; text: string }[] } };
            assert.equal(call.result?.isError, true);
            assert.match(call.result?.content?.[0]?.text ?? "", /bili is idle/);
            // Alive until the host closes stdin — the #1892 regression on
            // master was exit(0) BEFORE initialize answered.
            assert.equal(h.child.exitCode, null);
            h.child.stdin!.end();
            assert.equal(await h.exit, 0);
        } finally {
            if (h.child.exitCode === null) h.child.kill();
        }
    } finally {
        rmrf(sandbox);
    }
});

test("mcp-entry degraded with a healthy proxy still serves the real ACP tools (#1892 cert-MITM box)", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "zcode-degraded-mitm-"));
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url.startsWith("/__bili/plugin/manifest")) {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ tools: { anthropic: [{ name: "compress", description: "fold", input_schema: { type: "object" } }] } }));
            return;
        }
        if (url.startsWith("/__bili/plugin/status")) {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const port = (server.address() as AddressInfo).port;
        writeEmptyPersonalStore(sandbox);
        const env = sandboxEnv(sandbox, {
            ZCODE_DATA_BASE_DIR: path.join(sandbox, "zcode-data"),
            BILI_MCP_PROXY: `http://127.0.0.1:${port}`,
        });
        const h = spawnEntry(env);
        linesHolder = h.lines;
        try {
            h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
            h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
            h.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
            await waitFor(() => h.lines.length >= 2, "initialize + tools/list responses");
            const list = byId(h.lines, 2) as { result?: { tools?: { name?: string }[] } };
            assert.equal(list.result?.tools?.[0]?.name, "compress");
            h.child.stdin!.end();
            assert.equal(await h.exit, 0);
        } finally {
            if (h.child.exitCode === null) h.child.kill();
        }
    } finally {
        server.close();
        rmrf(sandbox);
    }
});
