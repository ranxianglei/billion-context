import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { startServer } from "../src/server.ts";
import { defaultConfig } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _resetPckProbeForTest } from "../src/pck-probe.ts";
import { pckKeyAbated, recordPckAblation } from "../src/pck-probe.ts";
import { resolveRelayAffinityPck } from "../src/session-id.ts";
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

test("#2218/#2645 unit: resolveRelayAffinityPck decision matrix (routing auto/enabled)", () => {
    _resetPckProbeForTest();
    const loop = "http://127.0.0.1:7864/v1";
    const remote = "https://relay.example.com/v1";
    // internal plugin lane + no client key + nothing learned yet → stamp,
    // EVERY destination shape (#2645: the static destination-shape gate is
    // gone — strict APIs are found out at egress by A/B instead). Under
    // #5079 stamping additionally requires routing auto/enabled — both are
    // exercised here; the disabled default lives in tests/issue5079.
    assert.equal(resolveRelayAffinityPck("x-bili-plugin-conversation", undefined, remote, remote, "auto"), "stamp");
    assert.equal(resolveRelayAffinityPck("x-bili-plugin-conversation", undefined, undefined, loop, "enabled"), "stamp");
    // A/B-ablated pair → drop (stamped keys AND client keys alike)
    recordPckAblation({ origin: "https://strict.example.com/v1", model: "nim-550b", sessionId: "s1", statusWithKey: 400, errSnippet: "bad" });
    assert.equal(resolveRelayAffinityPck("x-bili-plugin-conversation", undefined, "https://strict.example.com/v1/chat/completions", "https://strict.example.com/v1", "auto", "s1", "nim-550b"), "drop");
    assert.equal(resolveRelayAffinityPck(undefined, "client-key", "https://strict.example.com/v1/chat/completions", "https://strict.example.com/v1", "auto", undefined, "nim-550b"), "drop");
    // model-level granularity: same origin, different model → still stamp
    assert.equal(resolveRelayAffinityPck("x-bili-plugin-conversation", undefined, "https://strict.example.com/v1", "https://strict.example.com/v1", "auto", "s1", "nim-120b"), "stamp");
    // unlearned origin+model pair fails open
    assert.equal(pckKeyAbated("https://other.example.com/v1", undefined, undefined), false);
    // client's own key on a clean destination passes through verbatim
    assert.equal(resolveRelayAffinityPck("x-bili-plugin-conversation", "pck-own", loop, loop, "auto", "s1"), "keep-client");
    assert.equal(resolveRelayAffinityPck(undefined, "pck-own", remote, remote, "auto"), "keep-client");
    // non-plugin identity sources never get stamped; with no key present the
    // drop/keep distinction is an unobservable no-op on the wire (#5079
    // normalizes the absent-key case to "drop")
    assert.equal(resolveRelayAffinityPck("session-id", undefined, loop, loop, "auto"), "drop");
    assert.equal(resolveRelayAffinityPck(undefined, undefined, loop, loop, "auto"), "drop");
    // unparseable origin is never ablated (fail open)
    assert.equal(resolveRelayAffinityPck("x-bili-plugin-conversation", undefined, "not-a-url", "not-a-url", "auto"), "stamp");
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
