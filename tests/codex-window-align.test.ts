import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #321 PR-E1: a codex client (UA `codex_cli_rs/…`) carries its own window
// perception and auto-compacts at 90% of it. The proxy caps the effective
// window at codex's perception (min(bili, codex)), so ACP compresses before
// codex's native compaction can fire (the #292 misalignment). The cap is
// per-request (the UA may appear/disappear between requests of one session)
// and observable via the plugin-reported effectiveContextLimit.

const CODEX_UA = "codex_cli_rs/0.53.0 (linux 6.8.0; x86_64) cli";

function okJson(model: string): string {
    return JSON.stringify({ id: "msg_s", type: "message", role: "assistant", model, content: [{ type: "text", text: "s" }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 5 } });
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
}

async function startRig(): Promise<Rig> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let model = "gpt-5.5";
            try { model = (JSON.parse(raw) as { model?: string }).model ?? model; } catch { /* keep default */ }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson(model));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;
    return { proxyPort, upstreamPort, proxy, upstream };
}

function url(rig: Rig): string {
    return `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
}

async function post(rig: Rig, session: string, model: string, codex: boolean): Promise<number> {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-acp-session": session,
        "x-bili-plugin": "test-agent",
    };
    if (codex) headers["user-agent"] = CODEX_UA;
    const r = await fetch(url(rig), { method: "POST", headers, body: JSON.stringify({ model, max_tokens: 1024, stream: false, messages: [{ role: "user", content: "hi" }] }) });
    await r.text();
    return r.status;
}

function effectiveLimit(session: string): number | undefined {
    return listSessions().find((s) => s.meta.label === session)?.metadata.effectiveContextLimit;
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

test("e2e: codex UA + in-table model → window clamped to codex's perception", async () => {
    const rig = await startRig();
    try {
        assert.equal(await post(rig, "cw-in", "gpt-5.5", true), 200);
        assert.equal(effectiveLimit("cw-in"), 272_000, "gpt-5.5: bili table 400K clamped to codex 272K");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: non-codex client → no clamp", async () => {
    const rig = await startRig();
    try {
        assert.equal(await post(rig, "cw-plain", "gpt-5.5", false), 200);
        assert.equal(effectiveLimit("cw-plain"), 400_000, "control: built-in table 400K untouched");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: codex UA + prefix-matched model → clamped via longest-prefix", async () => {
    const rig = await startRig();
    try {
        assert.equal(await post(rig, "cw-prefix", "gpt-5.5-mini", true), 200);
        assert.equal(effectiveLimit("cw-prefix"), 272_000, "gpt-5.5-mini → gpt-5.5 (272K)");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: codex UA + not-in-table model → clamped to the 272K fallback", async () => {
    const rig = await startRig();
    try {
        assert.equal(await post(rig, "cw-fallback", "glm-5", true), 200);
        assert.equal(effectiveLimit("cw-fallback"), 272_000, "glm-5: bili table 1M clamped to codex's unknown-model 272K");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: codex UA + bili window below perception → untouched (min keeps bili's)", async () => {
    const rig = await startRig();
    try {
        assert.equal(await post(rig, "cw-below", "claude-sonnet-4-5", true), 200);
        assert.equal(effectiveLimit("cw-below"), 200_000, "200K < 272K perception → no clamp");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: per-request resolution — UA disappears, window reverts", async () => {
    const rig = await startRig();
    try {
        assert.equal(await post(rig, "cw-perreq", "gpt-5.5", true), 200);
        assert.equal(effectiveLimit("cw-perreq"), 272_000, "with codex UA → clamped");
        assert.equal(await post(rig, "cw-perreq", "gpt-5.5", false), 200);
        assert.equal(effectiveLimit("cw-perreq"), 400_000, "same session, UA gone → 400K again");
    } finally {
        await closeRig(rig);
    }
});
