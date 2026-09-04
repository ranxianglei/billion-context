import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claimProxyOrigin, probeOrigin, readPointerLease, readPointerOrigin, releaseProxyOrigin, proxyOriginPath, proxyLeasePath } from "../src/proxy-origin.ts";

function withStateDir<T>(fn: (stateDir: string) => Promise<T> | T): Promise<T> {
    const state = mkdtempSync(path.join(tmpdir(), "bili-state-"));
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    return Promise.resolve(fn(state)).finally(() => {
        if (prev === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prev;
        rmSync(state, { recursive: true, force: true });
    });
}

function stateFile(stateDir: string, name: string): string {
    return path.join(stateDir, "billion-context", name);
}

interface LiveProbe {
    server: http.Server;
    origin: string;
    close: () => Promise<void>;
}

async function startBiliStub(instanceId: string): Promise<LiveProbe> {
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, upstream: "https://upstream.example", instanceId }));
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

const silentLog = (): void => {};

test("readPointerOrigin: absent / valid / garbage", async () => {
    await withStateDir(async (state) => {
        assert.equal(readPointerOrigin(), null);
        const file = stateFile(state, "proxy-origin");
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "http://127.0.0.1:9999\n");
        assert.equal(readPointerOrigin(), "http://127.0.0.1:9999");
        writeFileSync(file, "ftp://bad\ngarbage");
        assert.equal(readPointerOrigin(), null);
    });
});

test("readPointerLease: absent / valid / malformed", async () => {
    await withStateDir(async (state) => {
        assert.equal(readPointerLease(), null);
        const lease = stateFile(state, "proxy-origin.lease");
        mkdirSync(path.dirname(lease), { recursive: true });
        writeFileSync(lease, JSON.stringify({ v: 2, origin: "http://127.0.0.1:8787", pid: 42, bootedAt: 123, instanceId: "abc" }) + "\n");
        assert.deepEqual(readPointerLease(), { v: 2, origin: "http://127.0.0.1:8787", pid: 42, bootedAt: 123, instanceId: "abc" });
        writeFileSync(lease, "{ not json");
        assert.equal(readPointerLease(), null);
        writeFileSync(lease, JSON.stringify({ v: 2, origin: 5 }) + "\n");
        assert.equal(readPointerLease(), null);
    });
});

test("probeOrigin: live with instanceId / dead port / non-ok health", async () => {
    const stub = await startBiliStub("instance-xyz");
    try {
        const live = await probeOrigin(stub.origin);
        assert.equal(live.live, true);
        assert.equal(live.instanceId, "instance-xyz");
        const dead = await probeOrigin("http://127.0.0.1:1");
        assert.equal(dead.live, false);
        assert.equal(dead.instanceId, undefined);
    } finally {
        await stub.close();
    }
});

test("claimProxyOrigin: absent pointer is claimed (file + lease written)", async () => {
    await withStateDir(async (state) => {
        const claimed = await claimProxyOrigin("http://127.0.0.1:8787", { origin: "http://127.0.0.1:8787", pid: process.pid, bootedAt: 111, instanceId: "owner-1" }, silentLog);
        assert.equal(claimed, true);
        assert.equal(readPointerOrigin(), "http://127.0.0.1:8787");
        assert.equal(readPointerLease()?.instanceId, "owner-1");
        assert.equal(existsSync(proxyLeasePath()), true);
    });
});

test("claimProxyOrigin: healthy existing owner keeps the pointer (#405)", async () => {
    const stub = await startBiliStub("other-instance");
    try {
        await withStateDir(async (state) => {
            const file = stateFile(state, "proxy-origin");
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, `${stub.origin}\n`);
            const claimed = await claimProxyOrigin("http://127.0.0.1:59999", { origin: "http://127.0.0.1:59999", pid: process.pid, bootedAt: 222, instanceId: "latecomer" }, silentLog);
            assert.equal(claimed, false, "did not take the pointer");
            assert.equal(readPointerOrigin(), stub.origin, "existing owner's pointer untouched");
            assert.equal(readPointerLease(), null, "no lease written by the non-claiming instance");
        });
    } finally {
        await stub.close();
    }
});

test("claimProxyOrigin: dead existing pointer is reclaimed", async () => {
    await withStateDir(async (state) => {
        const file = stateFile(state, "proxy-origin");
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "http://127.0.0.1:1\n");
        const claimed = await claimProxyOrigin("http://127.0.0.1:8787", { origin: "http://127.0.0.1:8787", pid: process.pid, bootedAt: 333, instanceId: "reclaimer" }, silentLog);
        assert.equal(claimed, true);
        assert.equal(readPointerOrigin(), "http://127.0.0.1:8787");
        assert.equal(readPointerLease()?.instanceId, "reclaimer");
    });
});

test("claimProxyOrigin: same origin is idempotent (rewrite, still claimed)", async () => {
    await withStateDir(async (state) => {
        const args = { origin: "http://127.0.0.1:8787", pid: process.pid, bootedAt: 444, instanceId: "same" };
        assert.equal(await claimProxyOrigin(args.origin, args, silentLog), true);
        assert.equal(await claimProxyOrigin(args.origin, { ...args, bootedAt: 555 }, silentLog), true);
        assert.equal(readPointerOrigin(), "http://127.0.0.1:8787");
        assert.equal(readPointerLease()?.bootedAt, 555);
    });
});

test("releaseProxyOrigin: removes our pointer (file or lease ownership)", async () => {
    await withStateDir(async (state) => {
        await claimProxyOrigin("http://127.0.0.1:8787", { origin: "http://127.0.0.1:8787", pid: process.pid, bootedAt: 1, instanceId: "owner" }, silentLog);
        releaseProxyOrigin("http://127.0.0.1:8787", "owner", silentLog);
        assert.equal(existsSync(proxyOriginPath()), false);
        assert.equal(existsSync(proxyLeasePath()), false);
    });
});

test("releaseProxyOrigin: leaves a foreign pointer alone", async () => {
    await withStateDir(async (state) => {
        await claimProxyOrigin("http://127.0.0.1:8787", { origin: "http://127.0.0.1:8787", pid: process.pid, bootedAt: 1, instanceId: "owner-a" }, silentLog);
        releaseProxyOrigin("http://127.0.0.1:9999", "owner-b", silentLog);
        assert.equal(readPointerOrigin(), "http://127.0.0.1:8787", "foreign pointer untouched");
        assert.equal(readPointerLease()?.instanceId, "owner-a");
    });
});

test("releaseProxyOrigin: no-op when nothing was ever written", async () => {
    await withStateDir(async () => {
        assert.doesNotThrow(() => releaseProxyOrigin("http://127.0.0.1:8787", "nobody", silentLog));
        assert.equal(readPointerOrigin(), null);
    });
});
