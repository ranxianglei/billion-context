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

interface HarnessOpts {
    /** Bind address of the mock upstream. Non-loopback addresses make bili see a
     *  REMOTE destination (the #2645/#2649 shape) while the socket still lands on
     *  this host. */
    bindAddress?: string;
    /** Strict-schema mode (#2645): answer 400 on any prompt_cache_key in the body,
     *  mirroring NVIDIA NIM's `Validation: Unsupported parameter(s)` rejection, so
     *  a leaked/stamped field reproduces as a real 400 instead of a field check. */
    rejectPck?: boolean;
}

async function startHarness(routes: ProxyOptions["routes"] | undefined, opts: HarnessOpts = {}): Promise<Harness> {
    const { bindAddress = "127.0.0.1", rejectPck = false } = opts;
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let body: Record<string, unknown> = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep {} */ }
            captured.push({ headers: req.headers, body });
            if (rejectPck && "prompt_cache_key" in body) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "Validation: Unsupported parameter(s): `prompt_cache_key`", type: "Bad Request", code: 400 } }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end(chatSse());
        });
    });
    upstream.listen(0, bindAddress);
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
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
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

test("#2218 unit: shouldStampRelayAffinityPck gate matrix", () => {
    const loop = "http://127.0.0.1:7864/v1";
    const remote = "https://relay.example.com/v1";
    // #2649: plugin lane + no client pck + non-loopback destination → NO
    // stamp. A rewritten/embedded route URL is deliberately NOT an input to
    // this gate (the /bili/ tunnel rewrites the user's own remote
    // destination too; verbatim stamps 400'd strict upstreams, #2645), so
    // loopback is the only destination-shape proof of a relay.
    assert.equal(shouldStampRelayAffinityPck("x-bili-plugin-conversation", undefined, remote), false);
    // plugin lane + no client pck + loopback destination → stamp
    assert.equal(shouldStampRelayAffinityPck("x-bili-plugin-conversation", undefined, loop), true);
    // client's own prompt_cache_key always wins
    assert.equal(shouldStampRelayAffinityPck("x-bili-plugin-conversation", "pck-own", loop), false);
    // non-plugin identity sources (codex session-id header, plain clients) stay unstamped
    assert.equal(shouldStampRelayAffinityPck("session-id", undefined, loop), false);
    assert.equal(shouldStampRelayAffinityPck(undefined, undefined, loop), false);
    assert.equal(shouldStampRelayAffinityPck("x-bili-plugin-conversation", undefined, "http://localhost:7864/v1"), true);
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
    // Pins the /bili/-tunnel lane end-to-end with an EMPTY admin provider
    // table: the tunnel rewrites the user's own destination too (#2645), so
    // the stamp here comes from the LOOPBACK destination shape, not from a
    // rewritten route; the bare loopback leg is pinned by the unit matrix.
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

// #2645: a dsh plugin-lane request tunneled to a REMOTE (non-loopback)
// destination must NOT carry a stamped prompt_cache_key — strict-schema
// upstreams (NVIDIA NIM) answer 400 on the unknown field. A machine
// non-loopback IPv4 address stands in for the remote host: bili sees a
// remote destination while the socket still lands on this host.
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
    const h = await startHarness(undefined, { bindAddress: destIp, rejectPck: true });
    try {
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://${destIp}:${h.upstreamPort}/v1/chat/completions`;
        const r = await fetch(base, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "dsh-nvidia-1" },
            body: JSON.stringify(chatBody()),
        });
        // Before the fix bili stamped prompt_cache_key → the strict upstream 400'd.
        assert.equal(r.status, 200);
        await r.text();
        const [b] = h.captured;
        assert.ok(b, "request reached the strict upstream");
        assert.ok(!("prompt_cache_key" in b.body), "prompt_cache_key must NOT be stamped onto a remote destination");
        // header relay still works (workbuddy hub / sub2api read x-session-id)
        assert.equal(b.headers["x-session-id"], "dsh-nvidia-1");
    } finally {
        await h.close();
    }
});

test("#2645/#3556 regression: client-supplied prompt_cache_key is stripped on non-relay chat egress", async (t) => {
    const destIp = nonLoopbackIPv4();
    if (!destIp) { t.skip("no non-loopback IPv4 interface available in this environment"); return; }
    const h = await startHarness(undefined, { bindAddress: destIp });
    try {
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://${destIp}:${h.upstreamPort}/v1/chat/completions`;
        // plain client: the key was forwarded verbatim before this fix; now it
        // is stripped from the body while the x-session-id relay survives
        const r1 = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chatBody({ prompt_cache_key: "pck-client-remote" })) });
        assert.equal(r1.status, 200);
        await r1.text();
        const [a] = h.captured;
        assert.ok(!("prompt_cache_key" in a.body), "client prompt_cache_key must be stripped from non-relay chat egress");
        assert.equal(a.headers["x-session-id"], "pck-client-remote");
        // dsh plugin lane: "client value wins" means no STAMP — it does not mean
        // the client's key rides verbatim onto a strict remote API either
        const r2 = await fetch(base, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "dsh-sid-remote" },
            body: JSON.stringify(chatBody({ prompt_cache_key: "pck-dsh-remote" })),
        });
        assert.equal(r2.status, 200);
        await r2.text();
        const c = h.captured[1];
        assert.ok(!("prompt_cache_key" in c.body), "client prompt_cache_key on the dsh lane must also be stripped from non-relay egress");
        // the plugin conversation header outranks the body pck for identity —
        // the point here is the STRIP, not which value wins the session id
        assert.equal(c.headers["x-session-id"], "dsh-sid-remote");
    } finally {
        await h.close();
    }
});
