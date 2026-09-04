import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    atomicWriteInstanceFile,
    clearProxyInstanceFile,
    instanceFilePath,
    isPidAlive,
    isProxyInstanceFile,
    readProxyInstanceFile,
    registerInstanceAndWarn,
    unregisterInstance,
    type ProxyInstanceFile,
} from "../src/instance.ts";
import { resolveProxyOrigin } from "../src/mcp.ts";
import { loadConversations, recordPluginSession, flushConversations } from "../src/plugin.ts";
import { unpackDeadProxyUrlsInFile, liveProxyPorts, prepareOmpHttpRewrite } from "../src/launcher.ts";
import { pluginInstall } from "../src/plugin-install.ts";
import { setLogCapture } from "../src/logger.ts";

function tmpStateDir(): { dir: string; restore: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-inst-state-"));
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    return {
        dir,
        restore: () => {
            if (prev === undefined) delete process.env.XDG_STATE_HOME;
            else process.env.XDG_STATE_HOME = prev;
        },
    };
}

function sampleInstance(over: Partial<ProxyInstanceFile> = {}): ProxyInstanceFile {
    return {
        origin: "http://127.0.0.1:8787",
        instanceId: "inst-abc",
        pid: process.pid,
        startedAt: 1_000,
        host: "127.0.0.1",
        port: 8787,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        ...over,
    };
}

function deadPid(): number {
    return 4_000_000;
}

test("instance file: JSON round-trip, atomic write, legacy plain-string read", () => {
    const st = tmpStateDir();
    try {
        atomicWriteInstanceFile(sampleInstance());
        const read = readProxyInstanceFile();
        assert.ok(isProxyInstanceFile(read));
        assert.equal(read.instanceId, "inst-abc");
        assert.equal(read.pid, process.pid);
        assert.equal(read.port, 8787);
        const raw = fs.readFileSync(instanceFilePath(), "utf8");
        assert.ok(raw.trim().startsWith("{"), "file is JSON");
        assert.equal(fs.readdirSync(st.dir).filter((f) => f.endsWith(".tmp")).length, 0, "no leftover tmp");

        fs.writeFileSync(instanceFilePath(), "http://127.0.0.1:9999\n");
        const legacy = readProxyInstanceFile();
        assert.ok(!isProxyInstanceFile(legacy) && legacy !== undefined);
        assert.equal(legacy.origin, "http://127.0.0.1:9999");

        fs.writeFileSync(instanceFilePath(), "{{{garbage");
        assert.equal(readProxyInstanceFile(), undefined);
    } finally {
        st.restore();
    }
});

test("clearProxyInstanceFile: only removes its own record", () => {
    const st = tmpStateDir();
    try {
        atomicWriteInstanceFile(sampleInstance());
        clearProxyInstanceFile("other-instance");
        assert.ok(isProxyInstanceFile(readProxyInstanceFile()));
        clearProxyInstanceFile("inst-abc");
        assert.equal(readProxyInstanceFile(), undefined);
    } finally {
        st.restore();
    }
});

test("resolveProxyOrigin: env wins, JSON file parsed, default fallback", () => {
    const st = tmpStateDir();
    const prevEnv = process.env.BILI_MCP_PROXY;
    try {
        process.env.BILI_MCP_PROXY = "http://10.1.1.1:1";
        assert.equal(resolveProxyOrigin(), "http://10.1.1.1:1");
        delete process.env.BILI_MCP_PROXY;
        atomicWriteInstanceFile(sampleInstance({ origin: "http://127.0.0.1:4242" }));
        assert.equal(resolveProxyOrigin(), "http://127.0.0.1:4242");
        fs.writeFileSync(instanceFilePath(), "http://127.0.0.1:7777");
        assert.equal(resolveProxyOrigin(), "http://127.0.0.1:7777");
        fs.writeFileSync(instanceFilePath(), "garbage");
        assert.equal(resolveProxyOrigin(), "http://127.0.0.1:8787");
    } finally {
        if (prevEnv === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevEnv;
        st.restore();
    }
});

test("resolveProxyOrigin: dead-pid JSON record falls back to default, live pid honored", () => {
    const st = tmpStateDir();
    const prevEnv = process.env.BILI_MCP_PROXY;
    try {
        delete process.env.BILI_MCP_PROXY;
        atomicWriteInstanceFile(sampleInstance({ origin: "http://127.0.0.1:4242", pid: deadPid() }));
        assert.equal(resolveProxyOrigin(), "http://127.0.0.1:8787");
        atomicWriteInstanceFile(sampleInstance({ origin: "http://127.0.0.1:4242", pid: process.pid }));
        assert.equal(resolveProxyOrigin(), "http://127.0.0.1:4242");
        atomicWriteInstanceFile(sampleInstance({ origin: "http://127.0.0.1:4242", pid: 0 }));
        assert.equal(resolveProxyOrigin(), "http://127.0.0.1:4242");
    } finally {
        if (prevEnv === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevEnv;
        st.restore();
    }
});

test("isPidAlive: self alive, dead pid not", () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(deadPid()), false);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-1), false);
});

test("instance registry: registers, warns on a second live instance, prunes dead, unregisters", () => {
    const st = tmpStateDir();
    const warnings: string[] = [];
    setLogCapture((_level, msg) => warnings.push(msg));
    try {
        registerInstanceAndWarn(
            { instanceId: "a", pid: process.pid, port: 1, origin: "http://127.0.0.1:1", startedAt: 1 },
            (msg) => warnings.push(msg),
        );
        assert.equal(warnings.length, 0);
        registerInstanceAndWarn(
            { instanceId: "b", pid: process.pid, port: 2, origin: "http://127.0.0.1:2", startedAt: 2 },
            (msg) => warnings.push(msg),
        );
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /another bili instance is running/);
        const file = path.join(st.dir, "billion-context", "instances.json");
        const after = JSON.parse(fs.readFileSync(file, "utf8")) as { instances: { instanceId: string }[] };
        assert.equal(after.instances.length, 2);

        unregisterInstance("a");
        const after2 = JSON.parse(fs.readFileSync(file, "utf8")) as { instances: { instanceId: string }[] };
        assert.deepEqual(after2.instances.map((e) => e.instanceId), ["b"]);
    } finally {
        setLogCapture(null);
        st.restore();
    }
});

test("plugin-conversations: clean state does not rewrite the file; corrupt file is preserved, not zeroed", () => {
    const st = tmpStateDir();
    const logged: string[] = [];
    setLogCapture((_level, msg) => logged.push(msg));
    try {
        const file = () => path.join(st.dir, "billion-context", "plugin-conversations.json");
        fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(file(), JSON.stringify({ "c1": { sessionId: "s1", lastSeen: 5 } }));
        loadConversations();
        fs.writeFileSync(file(), "SENTINEL-UNTOUCHED");
        flushConversations();
        assert.equal(fs.readFileSync(file(), "utf8"), "SENTINEL-UNTOUCHED", "no dirty flag → no write");

        recordPluginSession("c2", "s2");
        flushConversations();
        const obj = JSON.parse(fs.readFileSync(file(), "utf8")) as Record<string, { sessionId: string }>;
        assert.equal(obj.c1.sessionId, "s1");
        assert.equal(obj.c2.sessionId, "s2");

        fs.writeFileSync(file(), "{corrupt-bytes");
        loadConversations();
        const backups = fs.readdirSync(path.dirname(file())).filter((f) => f.startsWith("plugin-conversations.json.corrupt-"));
        assert.equal(backups.length, 1, "corrupt bytes preserved beside the original");
        assert.ok(logged.some((m) => m.includes("plugin-conversations.json is corrupt")));
    } finally {
        setLogCapture(null);
        st.restore();
    }
});

test("unpackDeadProxyUrlsInFile: dead-origin wraps unpacked, live-origin wraps kept", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-unpack-"));
    const st = tmpStateDir();
    try {
        const models = path.join(dir, "models.yml");
        fs.writeFileSync(
            models,
            [
                "providers:",
                "  relay:",
                "    baseUrl: http://127.0.0.1:8787/bili/https://ps.air-outer.com/v1",
                "  live:",
                "    baseUrl: http://127.0.0.1:9001/bili/https://keep.example.com/v1",
                "",
            ].join("\n"),
        );
        atomicWriteInstanceFile(sampleInstance({ origin: "http://127.0.0.1:9001", port: 9001 }));
        const livePorts = liveProxyPorts();
        assert.ok(livePorts.has(9001));
        assert.equal(livePorts.has(8787), false);
        const changed = unpackDeadProxyUrlsInFile(models, livePorts);
        assert.equal(changed, 1);
        const out = fs.readFileSync(models, "utf8");
        assert.match(out, /baseUrl: https:\/\/ps\.air-outer\.com\/v1/, "dead-origin wrap unpacked");
        assert.match(out, /baseUrl: http:\/\/127\.0\.0\.1:9001\/bili\/https:\/\/keep\.example\.com\/v1/, "live-origin wrap kept");
    } finally {
        st.restore();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("omp overlay: nested generated models.yml is never promoted into the real home (#410)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-omp-nest-"));
    const overlay = `${home}-bili`;
    fs.writeFileSync(path.join(home, "models.yml"), ["providers:", "  a:", "    baseUrl: http://example.com/v1"].join("\n"));
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(overlay, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(overlay, "sessions", "models.yml"), "providers:\n  poisoned:\n    baseUrl: http://127.0.0.1:8787/bili/http://evil.example.com/v1\n");
    let tmp: string | undefined;
    try {
        tmp = prepareOmpHttpRewrite(home, "http://127.0.0.1:8787", [{ key: "a", realUpstream: "http://example.com/v1" }], []);
        assert.ok(tmp);
        assert.equal(fs.existsSync(path.join(home, "sessions", "models.yml")), false, "nested generated file NOT promoted");
        const real = fs.readFileSync(path.join(home, "models.yml"), "utf8");
        assert.ok(!real.includes("poisoned"), "real models.yml clean");
    } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
        try {
            fs.rmSync(overlay, { recursive: true, force: true });
        } catch {}
    }
});

test("plugin install: refuses to freeze a dead or missing proxy origin (#403)", () => {
    const st = tmpStateDir();
    const prevCodex = process.env.CODEX_HOME;
    const prevEnv = process.env.BILI_MCP_PROXY;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-home-"));
    process.env.CODEX_HOME = home;
    delete process.env.BILI_MCP_PROXY;
    try {
        assert.throws(() => pluginInstall("codex"), /no bili proxy origin found/);
        atomicWriteInstanceFile(sampleInstance({ pid: deadPid() }));
        assert.throws(() => pluginInstall("codex"), /is not running/);

        atomicWriteInstanceFile(sampleInstance());
        const msg = pluginInstall("codex");
        assert.match(msg, /codex:/);
        const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
        assert.match(toml, /BILI_MCP_PROXY = "http:\/\/127\.0\.0\.1:8787"/);
    } finally {
        if (prevCodex === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = prevCodex;
        if (prevEnv !== undefined) process.env.BILI_MCP_PROXY = prevEnv;
        st.restore();
        fs.rmSync(home, { recursive: true, force: true });
    }
});
