import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import { once } from "node:events";
import { startServer } from "../src/server.ts";
import { defaultConfig } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { shouldStampRelayAffinityPck } from "../src/session-id.ts";
import type { ProxyOptions } from "../src/config.ts";
import type { Server } from "node:http";

interface Captured {
    headers: Record<string, string | string[] | undefined>;
    body: Record<string, unknown>;
}

function chatSse(): string {
    return (
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: { content: "pong" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n"
    );
}

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: Captured[];
    close(): Promise<void>;
}

async function startHarness(routes: ProxyOptions["routes"] | undefined): Promise<Harness> {
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let body: Record<string, unknown> = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep {} */ }
            captured.push({ headers: req.headers, body });
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end(chatSse());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy: Server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes ?? {},
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        captured,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

function chatBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hello " + Math.random() }],
        ...extra,
    };
}

test("#2218/#2645 unit: shouldStampRelayAffinityPck gate matrix", () => {
    const loop = "http://127.0.0.1:7864/v1";
    const localhost = "http://localhost:7864/v1";
    const nvidia = "https://integrate.api.nvidia.com/v1/chat/completions";
    // plugin lane + no client pck + loopback destination → stamp
    assert.equal(shouldStampRelayAffinityPck("x-bili-plugin-conversation", undefined, loop), true);
    // literal "localhost" counts as loopback (#2218)
    assert.equal(shouldStampRelayAffinityPck("x-bili-plugin-conversation", undefined, localhost), true);
    // plugin lane + no client pck + REMOTE destination (strict direct API, NVIDIA NIM #2645) → no stamp
    assert.equal(shouldStampRelayAffinityPck("x-bili-plugin-conversation", undefined, nvidia), false);
    // the tunnel / forward-proxy lane sets a full destination URL (path included) for the
    // user's OWN remote host too — that must NOT flip the gate to stamp (#2645)
    assert.equal(shouldStampRelayAffinityPck("x-bili-plugin-conversation", undefined, "https://relay.example.com/v1"), false);
    // client's own prompt_cache_key always wins
    assert.equal(shouldStampRelayAffinityPck("x-bili-plugin-conversation", "pck-own", loop), false);
    // non-plugin identity sources (codex session-id header, plain clients) stay unstamped
    assert.equal(shouldStampRelayAffinityPck("session-id", undefined, loop), false);
    assert.equal(shouldStampRelayAffinityPck(undefined, undefined, loop), false);
    // unparseable origin is not a deliberate deployment → no stamp
    assert.equal(shouldStampRelayAffinityPck("x-bili-plugin-conversation", undefined, "not-a-url"), false);
});

test("#2218 regression: plain client body pck still forwards x-session-id + body pck", async () => {
    const h = await startHarness(undefined);
    try {
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chatBody({ prompt_cache_key: "pck-abc" })) });
        assert.equal(r.status, 200);
        await r.text();
        const [a] = h.captured;
        assert.equal(a.headers["x-session-id"], "pck-abc");
        assert.equal(a.body.prompt_cache_key, "pck-abc");
    } finally {
        await h.close();
    }
});

test("#2218 fix: dsh plugin lane reaches relays with BOTH header and body session signal", async () => {
    const h = await startHarness(undefined);
    try {
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        // dsh native lane shape: plugin marker + conversation header, NO body pck
        const r = await fetch(base, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "dsh-sid-1" },
            body: JSON.stringify(chatBody()),
        });
        assert.equal(r.status, 200);
        await r.text();
        const [b] = h.captured;
        // header-reading relays (workbuddy hub, sub2api openai wire) see x-session-id
        assert.equal(b.headers["x-session-id"], "dsh-sid-1");
        // body-only relays (workbuddy panel) see prompt_cache_key = the dsh conversation id
        assert.equal(b.body.prompt_cache_key, "dsh-sid-1");
    } finally {
        await h.close();
    }
});

test("#2218 fix: dsh plugin lane stamps pck on a loopback destination even without a configured route", async () => {
    // The /bili/-embedded-URL form always resolves a route (rewrittenUrl set),
    // so this case pins the gate's route-rewrite leg with an EMPTY admin
    // provider table; the bare loopback leg (route undefined + loopback
    // origin) is pinned by the unit matrix above.
    const h = await startHarness(undefined);
    try {
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        const r = await fetch(base, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "dsh-sid-2" },
            body: JSON.stringify(chatBody()),
        });
        assert.equal(r.status, 200);
        await r.text();
        const [b] = h.captured;
        assert.equal(b.body.prompt_cache_key, "dsh-sid-2");
    } finally {
        await h.close();
    }
});

test("#2218 fix: client's own prompt_cache_key on the dsh lane is never overwritten", async () => {
    const h = await startHarness(undefined);
    try {
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        const r = await fetch(base, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "dsh-sid-3" },
            body: JSON.stringify(chatBody({ prompt_cache_key: "pck-dsh-own" })),
        });
        assert.equal(r.status, 200);
        await r.text();
        const [b] = h.captured;
        assert.equal(b.body.prompt_cache_key, "pck-dsh-own");
    } finally {
        await h.close();
    }
});

test("#2218 regression: readable client conversation headers still suppress the x-session-id duplicate", async () => {
    const h = await startHarness(undefined);
    try {
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        // codex-style session-id header: the upstream reads it directly — the
        // proxy must not mint a second header, and the non-plugin lane never
        // gets a body stamp.
        const r = await fetch(base, {
            method: "POST",
            headers: { "content-type": "application/json", "session-id": "codex-thread-1" },
            body: JSON.stringify(chatBody()),
        });
        assert.equal(r.status, 200);
        await r.text();
        const [b] = h.captured;
        assert.equal(b.headers["x-session-id"], undefined);
        assert.equal(b.body.prompt_cache_key, undefined);
    } finally {
        await h.close();
    }
});

// #2645 regression: a dsh plugin-lane request tunneled to a REMOTE (non-loopback)
// destination must NOT carry a stamped prompt_cache_key — strict-schema upstreams
// (NVIDIA NIM) answer 400 on the unknown field. The mock below enforces exactly
// that schema, so the pre-fix behaviour reproduces as a real 400 rather than a
// mere missing-field check.
function nonLoopbackIPv4(): string | undefined {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const i of ifaces[name] ?? []) {
            if (i.family === "IPv4" && !i.internal) return i.address;
        }
    }
    return undefined;
}

test("#2645 regression: dsh plugin lane to a strict REMOTE upstream is not stamped (no 400)", async (t) => {
    const destIp = nonLoopbackIPv4();
    if (!destIp) { t.skip("no non-loopback IPv4 interface available in this environment"); return; }

    const captured: Captured[] = [];
    // Strict upstream: rejects the unknown param, mirroring NVIDIA NIM's
    // `Validation: Unsupported parameter(s): prompt_cache_key` 400.
    const strictUpstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let body: Record<string, unknown> = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep {} */ }
            captured.push({ headers: req.headers, body });
            if ("prompt_cache_key" in body) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "Validation: Unsupported parameter(s): `prompt_cache_key`", type: "Bad Request", code: 400 } }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end(chatSse());
        });
    });
    await new Promise<void>((resolve) => strictUpstream.listen(0, "0.0.0.0", resolve));
    const upstreamPort = (strictUpstream.address() as { port: number }).port;

    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy: Server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        // Tunnel to the machine's NON-loopback address: bili sees a remote
        // destination (isLoopbackAddress=false) even though the socket lands on
        // this same host — exactly the NVIDIA NIM shape from the issue.
        const base = `http://127.0.0.1:${proxyPort}/bili/http://${destIp}:${upstreamPort}/v1/chat/completions`;
        const r = await fetch(base, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "dsh-nvidia-1" },
            body: JSON.stringify(chatBody()),
        });
        // Before the fix bili stamped prompt_cache_key → the strict upstream 400'd.
        assert.equal(r.status, 200);
        await r.text();
        const [b] = captured;
        assert.ok(b, "request reached the strict upstream");
        assert.ok(!("prompt_cache_key" in b.body), "prompt_cache_key must NOT be stamped onto a remote destination");
        // header relay still works (workbuddy hub / sub2api read x-session-id)
        assert.equal(b.headers["x-session-id"], "dsh-nvidia-1");
    } finally {
        proxy.close();
        await once(proxy, "close");
        strictUpstream.close();
        await once(strictUpstream, "close");
    }
});
