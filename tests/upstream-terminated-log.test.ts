import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { isUpstreamTerminated, describeUpstreamTerminated } from "../src/logger.ts";

const sock = Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" });

test("undici 'terminated' with a socket cause is classified and described on one line", () => {
    const err = new TypeError("terminated", { cause: sock });
    assert.equal(isUpstreamTerminated(err), true);
    assert.equal(describeUpstreamTerminated(err), "upstream closed the connection mid-response (UND_ERR_SOCKET)");
});

test("NEG: other TypeErrors, other messages and non-errors are not classified", () => {
    assert.equal(isUpstreamTerminated(new TypeError("fetch failed", { cause: sock })), false);
    assert.equal(isUpstreamTerminated(new TypeError("terminated")), false);
    assert.equal(isUpstreamTerminated(new Error("terminated", { cause: sock })), false);
    assert.equal(isUpstreamTerminated("terminated"), false);
    assert.equal(isUpstreamTerminated(undefined), false);
});

// Routing: the classification must actually reach the egress log. The body is
// served as a NON-JSON response so it flows through pipeThrough (the
// non-streaming rethrow lane) — the JSON lane (pipePluginJson) swallows a
// mid-body cut in its #411 catch and never reaches the dispatch catch. A clean
// FIN mid-body makes undici reject the body with TypeError("terminated") — the
// dispatch catch must log it on ONE line, and a non-matching transport death
// (RST -> "fetch failed") must KEEP its stack (#806 behavior preserved).

interface Captured {
    level: string;
    msg: string;
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function startProxyWith(
    upstream: http.Server,
): Promise<{ proxy: http.Server; proxyPort: number; upstreamPort: number; captured: Captured[] }> {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        // log: true — the dispatch catch logs through logMsg(), which is
        // gated on opts.log (server.ts logMsg); with log:false the line under
        // test is suppressed and the routing is unobservable.
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, proxyPort, upstreamPort, captured };
}

async function postChat(proxyPort: number, upstreamPort: number, sessionId: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-acp-session": sessionId,
        },
        body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] }),
    });
}

test("routing: a clean-FIN mid-body upstream cut logs one line without stack at the dispatch catch", async () => {
    const upstream = http.createServer((req, res) => {
        // text/plain -> the relay's non-JSON pipeThrough lane (rethrows to the
        // dispatch catch); the JSON lane swallows the cut in pipePluginJson #411.
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial plain-text body that is cut ");
        req.socket.end(); // clean FIN mid-chunked-body -> undici rejects with TypeError("terminated")
    });
    const { proxy, proxyPort, upstreamPort, captured } = await startProxyWith(upstream);
    try {
        const resp = await postChat(proxyPort, upstreamPort, "terminated-routing-1");
        await resp.text();
        const oneLine = captured.find((c) => c.level === "error" && c.msg.includes("upstream closed the connection mid-response (UND_ERR_SOCKET)"));
        assert.ok(oneLine, `expected the one-line terminated log, got: ${captured.map((c) => `${c.level}:${c.msg}`).join(" | ")}`);
        assert.ok(!oneLine.msg.includes("\n"), "the terminated error must log on ONE line, no stack frames");
        const stackErrors = captured.filter((c) => c.level === "error" && c.msg.includes("\n    at "));
        assert.equal(stackErrors.length, 0, `no error log may carry a stack for this failure: ${stackErrors.map((c) => c.msg).join(" | ")}`);
    } finally {
        setLogCapture(null);
        await close(proxy);
        await close(upstream);
    }
});

test("routing: a non-matching transport death (RST -> 'fetch failed') does not take the one-line terminated path", async () => {
    const upstream = http.createServer((req, res) => {
        // text/plain -> the same non-JSON pipeThrough lane as the FIN test above.
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial plain-text body that is cut ");
        req.socket.destroy(); // RST -> undici rejects with TypeError("fetch failed")
    });
    const { proxy, proxyPort, upstreamPort, captured } = await startProxyWith(upstream);
    try {
        const resp = await postChat(proxyPort, upstreamPort, "terminated-routing-2");
        await resp.text();
        // The RST death is classified upstream-reset (biliTransportFailure) and
        // logged on its own one line — it must NOT be misclassified as the
        // 'terminated' shape (isUpstreamTerminated is message-exact).
        const oneLine = captured.find((c) => c.msg.includes("upstream closed the connection mid-response"));
        assert.equal(oneLine, undefined, `the 'fetch failed' death must NOT take the one-line terminated path, got: ${captured.map((c) => `${c.level}:${c.msg}`).join(" | ")}`);
    } finally {
        setLogCapture(null);
        await close(proxy);
        await close(upstream);
    }
});
