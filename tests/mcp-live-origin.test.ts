import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_PROXY_ORIGIN, _resetMcpLiveOriginForTest, forgetLiveOrigin, resolveLiveOrigin } from "../src/mcp.ts";

interface LiveProbe {
    server: http.Server;
    origin: string;
    close: () => Promise<void>;
}

async function startBiliStub(): Promise<LiveProbe> {
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, upstream: "https://upstream.example", instanceId: "stub-instance" }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${addr.port}`;
    return {
        server,
        origin,
        close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    };
}

function pointerFile(stateDir: string): string {
    return path.join(stateDir, "billion-context", "proxy-origin");
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        prev[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

function freshStateDir(): string {
    const state = mkdtempSync(path.join(tmpdir(), "bili-mcp-state-"));
    mkdirSync(path.dirname(pointerFile(state)), { recursive: true });
    return state;
}

test("resolveLiveOrigin: dead env origin falls through to live pointer-file origin (#405)", async () => {
    const stub = await startBiliStub();
    const state = freshStateDir();
    let captured = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
        captured += String(chunk);
        return true;
    }) as typeof process.stderr.write;
    try {
        writeFileSync(pointerFile(state), `${stub.origin}\n`);
        await withEnv({ XDG_STATE_HOME: state, BILI_MCP_PROXY: "http://127.0.0.1:1" }, async () => {
            _resetMcpLiveOriginForTest();
            assert.equal(await resolveLiveOrigin(), stub.origin, "skips the dead env origin");
            assert.match(captured, /rebound http:\/\/127\.0\.0\.1:1 -> /, "rebind declared on stderr");
        });
    } finally {
        process.stderr.write = origWrite;
        rmSync(state, { recursive: true, force: true });
        await stub.close();
    }
});

test("resolveLiveOrigin: result is cached (no re-probe on later calls)", async () => {
    const stub = await startBiliStub();
    const state = freshStateDir();
    const realFetch = globalThis.fetch;
    let healthProbes = 0;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/__bili/health")) healthProbes++;
        return realFetch(input, init);
    }) as typeof fetch;
    try {
        writeFileSync(pointerFile(state), `${stub.origin}\n`);
        await withEnv({ XDG_STATE_HOME: state, BILI_MCP_PROXY: stub.origin }, async () => {
            _resetMcpLiveOriginForTest();
            assert.equal(await resolveLiveOrigin(), stub.origin);
            assert.equal(await resolveLiveOrigin(), stub.origin);
            assert.equal(await resolveLiveOrigin(), stub.origin);
            assert.equal(healthProbes, 1, "only the first resolution probes");
        });
    } finally {
        globalThis.fetch = realFetch;
        rmSync(state, { recursive: true, force: true });
        await stub.close();
    }
});

test("resolveLiveOrigin: after the cached instance dies, re-resolution finds the next live one (#405 self-heal)", async () => {
    const a = await startBiliStub();
    const b = await startBiliStub();
    const state = freshStateDir();
    try {
        writeFileSync(pointerFile(state), `${b.origin}\n`);
        await withEnv({ XDG_STATE_HOME: state, BILI_MCP_PROXY: a.origin }, async () => {
            _resetMcpLiveOriginForTest();
            assert.equal(await resolveLiveOrigin(), a.origin, "env origin wins while alive");
            await a.close();
            forgetLiveOrigin();
            assert.equal(await resolveLiveOrigin(), b.origin, "next call re-resolves to the live pointer-file origin");
        });
    } finally {
        rmSync(state, { recursive: true, force: true });
        await b.close();
    }
});

test("resolveLiveOrigin: all candidates dead → first candidate returned, no throw", async () => {
    const state = freshStateDir();
    try {
        writeFileSync(pointerFile(state), "http://127.0.0.1:2\n");
        await withEnv({ XDG_STATE_HOME: state, BILI_MCP_PROXY: "http://127.0.0.1:1" }, async () => {
            _resetMcpLiveOriginForTest();
            assert.equal(await resolveLiveOrigin(), "http://127.0.0.1:1", "callers get a dial target even when everything is down");
        });
    } finally {
        rmSync(state, { recursive: true, force: true });
    }
});

test("DEFAULT_PROXY_ORIGIN is the stable 8787 default (never ephemeral)", () => {
    assert.equal(DEFAULT_PROXY_ORIGIN, "http://127.0.0.1:8787");
});
