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
import { describeUpstreamFailure, formatUpstreamError, getUpstreamConnectionStatus, _resetUpstreamProxyForTest, recordUpstreamConnection } from "../src/upstream-proxy.ts";

/** #5598 field report: a client (user stop / SDK timeout) closes the connection
 *  before any upstream byte returns — nginx records 499, and bili's relay catch
 *  classified the resulting AbortError as upstream-timeout ("check upstream
 *  health") because it never passed the clientAbort signal state into the
 *  classification. The retry ladder already classified with externalAborted,
 *  and alert/circuit never count these kinds (ALERT_KINDS whitelist); the
 *  misattribution lived in the last-connection status surface, the egress line
 *  detail, and the 502 diagnostic body. */

function abortError(): Error {
    return new DOMException("This operation was aborted", "AbortError");
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface Captured {
    level: string;
    msg: string;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000, dump?: () => string): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}${dump ? `\ncaptured so far:\n${dump()}` : ""}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

test("describeUpstreamFailure: external-abort context attributes the AbortError to the client, not the upstream (#5598)", () => {
    const withCtx = describeUpstreamFailure(abortError(), "http://upstream.example/v1/messages", undefined, undefined, true);
    assert.equal(withCtx.detail.kind, "client-abort");
    assert.match(withCtx.message, /kind=client-abort/);
    assert.doesNotMatch(withCtx.message, /check upstream health/);
    assert.match(withCtx.message, /downstream client disconnected/);

    // Negative control: without the context (internal idle-watchdog abort) the
    // legacy attribution must stay untouched.
    const withoutCtx = describeUpstreamFailure(abortError(), "http://upstream.example/v1/messages");
    assert.equal(withoutCtx.detail.kind, "upstream-timeout");
    assert.match(withoutCtx.message, /check upstream health/);
});

test("formatUpstreamError + recordUpstreamConnection: status surface says kind=client-abort after a user cancel (#5598)", () => {
    _resetUpstreamProxyForTest();
    try {
        assert.match(formatUpstreamError(abortError(), "http://upstream.example", undefined, undefined, true), /kind=client-abort/);
        recordUpstreamConnection("http://upstream.example", undefined, abortError(), undefined, true);
        const status = getUpstreamConnectionStatus();
        assert.equal(status.connected, false);
        assert.match(status.error ?? "", /kind=client-abort/);
        assert.doesNotMatch(status.error ?? "", /check upstream health/);

        // Legacy shape (no context) unchanged.
        recordUpstreamConnection("http://upstream.example", undefined, abortError());
        assert.match(getUpstreamConnectionStatus().error ?? "", /kind=upstream-timeout/);
    } finally {
        _resetUpstreamProxyForTest();
    }
});

test("client cancels mid-forward: logs and status attribute the failure to the client, no error-level upstream blame (#5598)", async () => {
    let upstreamSawRequest = false;
    const upstream = http.createServer((req, res) => {
        upstreamSawRequest = true;
        req.resume();
        // Never answer — hold the socket open until the client goes away.
        void res;
    });
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
        // #5598: log must be ON — the request pipeline routes every line through
        // logMsg(), which drops ALL levels (incl. warn) when opts.log is false,
        // before the capture hook ever sees them.
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
    const controller = new AbortController();
    try {
        const fetchPromise = fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue5598-1" },
            body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] }),
            signal: controller.signal,
        }).catch((e) => e);
        // Wait until the proxy has actually started the upstream fetch so the
        // abort lands INSIDE fetchWithTimeout, not during body reading.
        await waitFor(() => upstreamSawRequest, "upstream request to arrive");
        await new Promise((r) => setTimeout(r, 150));
        controller.abort();
        const clientErr = await fetchPromise;
        assert.ok(clientErr instanceof Error && /abort/i.test(String(clientErr)), `expected the client fetch to reject with its own abort, got: ${String(clientErr)}`);
        await waitFor(() => captured.some((c) => c.msg.includes("client aborted mid-stream")), "egress client-abort info line", 8000, () => captured.map((c) => `${c.level}: ${c.msg}`).join("\n"));

        const status = getUpstreamConnectionStatus();
        assert.equal(status.connected, false);
        assert.match(status.error ?? "", /kind=client-abort/);
        assert.doesNotMatch(status.error ?? "", /check upstream health/);
        assert.ok(captured.some((c) => c.msg.includes("client disconnected mid-stream")), "relay disconnect info line missing");
        const blaming = captured.filter((c) => c.level === "error" && c.msg.includes("kind="));
        assert.deepEqual(blaming, [], `no error-level line may blame the upstream for a client cancel: ${JSON.stringify(blaming)}`);
    } finally {
        controller.abort();
        setLogCapture(null);
        await close(proxy);
        await close(upstream);
    }
});
