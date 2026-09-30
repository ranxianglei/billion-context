import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Isolate state (prefix-affinity hydration etc.) from the real machine state.
process.env.XDG_STATE_HOME = `${import.meta.dirname ?? "."}/.pp-stamp-state-${process.pid}`;

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest, listSessions } from "../src/session.ts";

// #1279 review (#1417): the priceProfile STAMP pipeline (config →
// resolveCompress → session.metadata.cachePriceProfile, latest-wins with
// unset→clear, src/server.ts runPrepare) had zero test coverage — tests
// wrote metadata.cachePriceProfile by hand. This drives the real server: a
// request routed through a provider-level compress.priceProfile must stamp
// the session, and a later request through a lane without one must clear it.

async function anthropicUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 10 } } })}\n\n`);
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`);
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`);
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        res.end();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const port = (upstream.address() as { port: number }).port;
    return { port, close: () => new Promise<void>((r) => upstream.close(() => r())) };
}

function optsFor(upstreamPort: number, withPriceProfile: boolean): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: {
                ...(withPriceProfile ? { compress: { priceProfile: { q: 1.5 } } } : {}),
                models: { "claude-test": { context: 100_000 } },
            },
        },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
}

test("priceProfile stamp: provider-level priceProfile stamps session.metadata; a later unstamped lane clears it (#1279)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    _resetSessionsForTest();

    const upstream = await anthropicUpstream();
    const proxyWith = await startServer(optsFor(upstream.port, true));
    await once(proxyWith, "listening");
    const proxyPortWith = (proxyWith.address() as { port: number }).port;

    const post = (port: number): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstream.port}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "test", "x-acp-session": "pp-stamp-conv" },
            // max_tokens must stay above SIDE_REQUEST_MAX_TOKENS — small
            // max_tokens classifies the request as a #388 side request, which
            // skips prepare (and thus the stamp) by design.
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, messages: [{ role: "user", content: "hello" }] }),
        });

    const r1 = await post(proxyPortWith);
    assert.equal(r1.status, 200, "first request served");

    const sessions0 = listSessions();
    const stamped = sessions0.find((s) => s.metadata.cachePriceProfile !== undefined);
    assert.ok(stamped, `no session carries the priceProfile stamp (sessions: ${listSessions().map((s) => s.id).join(",")})`);
    assert.deepEqual(
        (stamped.metadata as Record<string, unknown>).cachePriceProfile,
        { q: 1.5 },
        "runPrepare stamped the effective priceProfile on the session",
    );

    // Same conversation through a lane WITHOUT priceProfile: latest-wins must
    // CLEAR the stamp (server.ts deletes on empty), not leave the stale one.
    const proxyWithout = await startServer(optsFor(upstream.port, false));
    await once(proxyWithout, "listening");
    const proxyPortWithout = (proxyWithout.address() as { port: number }).port;
    const r2 = await post(proxyPortWithout);
    assert.equal(r2.status, 200, "second request served");
    try {
    assert.equal(
        (stamped.metadata as Record<string, unknown>).cachePriceProfile,
        undefined,
        "unstamped lane clears the session priceProfile stamp",
    );

    } finally {
        await new Promise<void>((r) => proxyWith.close(() => r()));
        await new Promise<void>((r) => proxyWithout.close(() => r()));
        await upstream.close();
    }
});

test("priceProfile stamp: registry pricing is the default when no level configures one; user config wins wholesale (#1279 follow-up)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({}, {
        "somehost/claude-reg": { input: 2, output: 8, cache_read: 0.2 },
    });
    _resetPluginStateForTest();
    _resetSessionsForTest();

    const upstream = await anthropicUpstream();
    const proxy = await startServer(optsFor(upstream.port, false));
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;

    // The fake upstream is an unknown relay (127.0.0.1), so the lookup runs
    // its cross-host suffix scan and finds "somehost/claude-reg".
    const post = (model: string, sessionId: string): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstream.port}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "test", "x-acp-session": sessionId },
            body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "user", content: "hello" }] }),
        });
    try {
        const beforeA = new Set(listSessions().map((s) => s.id));
        const ra = await post("claude-reg", "pp-registry-a");
        assert.equal(ra.status, 200, "listed-model request served");
        const sa = listSessions().find((s) => !beforeA.has(s.id));
        assert.ok(sa, "session created for the listed model");
        assert.deepEqual(
            sa.metadata.cachePriceProfile,
            { w: 2, r: 0.2, q: 8 },
            "unconfigured session stamped with the registry's absolute $/Mtok profile",
        );

        const beforeB = new Set(listSessions().map((s) => s.id));
        const rb = await post("claude-noreg", "pp-registry-b");
        assert.equal(rb.status, 200, "unlisted-model request served");
        const sb = listSessions().find((s) => !beforeB.has(s.id));
        assert.ok(sb, "session created for the unlisted model");
        assert.equal(
            sb.metadata.cachePriceProfile,
            undefined,
            "unresolvable model leaves no stamp (kernel relative defaults apply downstream)",
        );

        // User config at any level wins wholesale — no field mixing with the registry row.
        // proxyCfg is closed in finally: an assertion throw mid-lane must not
        // leak the second server and hang the runner on drain.
        let proxyCfg: Awaited<ReturnType<typeof startServer>> | null = null;
        try {
            proxyCfg = await startServer(optsFor(upstream.port, true));
            await once(proxyCfg, "listening");
            const cfgPort = (proxyCfg.address() as { port: number }).port;
            const beforeC = new Set(listSessions().map((s) => s.id));
            const rc = await fetch(`http://127.0.0.1:${cfgPort}/bili/http://127.0.0.1:${upstream.port}/v1/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-api-key": "test", "x-acp-session": "pp-registry-c" },
                body: JSON.stringify({ model: "claude-reg", max_tokens: 1024, messages: [{ role: "user", content: "hello" }] }),
            });
            assert.equal(rc.status, 200, "user-config lane served");
            const sc = listSessions().find((s) => !beforeC.has(s.id));
            assert.ok(sc, "session created for the user-config lane");
            assert.deepEqual(
                sc.metadata.cachePriceProfile,
                { q: 1.5 },
                "route-level priceProfile overrides the registry listing wholesale",
            );
        } finally {
            if (proxyCfg) await new Promise<void>((r) => proxyCfg!.close(() => r()));
        }
    } finally {
        await new Promise<void>((r) => proxy.close(() => r()));
        await upstream.close();
    }
});
