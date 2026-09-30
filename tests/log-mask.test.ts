import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import net from "node:net";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { closeLogger, configureLogger, log as loggerLog, setLogCapture } from "../src/logger.ts";
import { formatUpstreamError } from "../src/upstream-proxy.ts";
import {
    isMaskHostsEnabled,
    isPublicApiHost,
    maskHeaderForLog,
    maskHeadersForLog,
    maskHostForLog,
    maskHostInText,
    maskHostPortForLog,
    maskIpsInText,
    maskUrlForLog,
    maskUrlsInText,
    redactSecretsInText,
    setMaskHostsEnabled,
} from "../src/log-mask.ts";
import { assertPortDead } from "./port-race.ts";
import { rmrf } from "./tmp-rm.ts";

/** #255 Part B: logs (bili.log + launcher tmp log) must carry no sensitive
 *  info — credential header values are masked, and non-public API endpoints
 *  (private relays, self-hosted, internal domains) are replaced. Well-known
 *  public hosts (openai/anthropic/...) stay verbatim. */

test("isPublicApiHost: well-known public hosts and subdomains", () => {
    assert.ok(isPublicApiHost("api.openai.com"));
    assert.ok(isPublicApiHost("openai.com"));
    assert.ok(isPublicApiHost("chatgpt.com"));
    assert.ok(isPublicApiHost("api.anthropic.com"));
    assert.ok(isPublicApiHost("generativelanguage.googleapis.com"));
    assert.ok(isPublicApiHost("API.DEEPSEEK.COM"));
    assert.ok(!isPublicApiHost("relay.internal"));
    assert.ok(!isPublicApiHost("192.168.1.50"));
    assert.ok(!isPublicApiHost("127.0.0.1"));
    assert.ok(!isPublicApiHost("localhost"));
    assert.ok(!isPublicApiHost("evilopenai.com"), "suffix match must require the dot boundary");
    assert.ok(!isPublicApiHost("openai.com.evil.example"));
});

test("maskUrlForLog: public host kept, non-public host replaced", () => {
    assert.equal(maskUrlForLog("https://api.openai.com/v1/chat/completions"), "https://api.openai.com/v1/chat/completions");
    assert.equal(maskUrlForLog("https://api.anthropic.com/v1/messages"), "https://api.anthropic.com/v1/messages");
    assert.equal(maskUrlForLog("https://relay.internal:8443/v1/chat/completions"), "https://<private-host>:8443/v1/chat/completions");
    assert.equal(maskUrlForLog("http://192.168.1.50:11434/v1/chat/completions"), "http://<private-host>:11434/v1/chat/completions");
    assert.equal(maskUrlForLog("http://127.0.0.1:9090/v1/messages"), "http://<private-host>:9090/v1/messages");
});

test("maskUrlForLog: userinfo/query/hash always dropped (key-leak vectors)", () => {
    assert.equal(maskUrlForLog("https://user:pass@relay.internal/v1"), "https://<private-host>/v1");
    assert.equal(maskUrlForLog("https://api.openai.com/v1/chat/completions?api_key=sk-123"), "https://api.openai.com/v1/chat/completions");
    assert.equal(maskUrlForLog("https://relay.internal/v1#frag"), "https://<private-host>/v1");
    assert.equal(maskUrlForLog("not a url"), "<unparseable-url>");
});

test("maskUrlsInText: masks URLs embedded in arbitrary strings", () => {
    assert.equal(
        maskUrlsInText("/bili/http://relay.internal:8443/v1/messages"),
        "/bili/http://<private-host>:8443/v1/messages",
    );
    assert.equal(
        maskUrlsInText("forward POST → https://api.openai.com/v1/chat/completions"),
        "forward POST → https://api.openai.com/v1/chat/completions",
    );
    assert.equal(maskUrlsInText("no urls here"), "no urls here");
});

test("maskHostPortForLog: CONNECT targets", () => {
    assert.equal(maskHostPortForLog("relay.internal:8443"), "<private-host>:8443");
    assert.equal(maskHostPortForLog("api.anthropic.com:443"), "api.anthropic.com:443");
    assert.equal(maskHostPortForLog("10.0.0.5"), "<private-host>");
    assert.equal(maskHostPortForLog("[::1]:443"), "<private-host>:443");
});

test("maskHeaderForLog: credential headers → length hint, host follows URL rule", () => {
    assert.equal(maskHeaderForLog("authorization", "Bearer sk-ant-abc123"), "<masked 20 chars>");
    assert.equal(maskHeaderForLog("x-api-key", "sk-123"), "<masked 6 chars>");
    assert.equal(maskHeaderForLog("cookie", "session=abc"), "<masked 11 chars>");
    assert.equal(maskHeaderForLog("set-cookie", "a=b; Path=/"), "<masked 11 chars>");
    assert.equal(maskHeaderForLog("proxy-authorization", "Basic xyz"), "<masked 9 chars>");
    assert.equal(maskHeaderForLog("host", "relay.internal"), "<private-host>");
    assert.equal(maskHeaderForLog("host", "api.anthropic.com"), "api.anthropic.com");
    assert.equal(maskHeaderForLog("content-type", "application/json"), "application/json");
    assert.equal(maskHeaderForLog("x-request-id", "abc123"), "abc123");
});

test("maskHeadersForLog: masks the whole record", () => {
    const out = maskHeadersForLog({
        authorization: "Bearer sk-secret",
        "content-type": "application/json",
        host: "relay.internal:8443",
    });
    assert.equal(out.authorization, "<masked 16 chars>");
    assert.equal(out["content-type"], "application/json");
    assert.equal(out.host, "<private-host>:8443");
});

test("maskHostInText: scrubs the tunnel target from error text, leaves other addresses", () => {
    assert.equal(
        maskHostInText("connect ECONNREFUSED 192.168.1.50:8443", "192.168.1.50"),
        "connect ECONNREFUSED <private-host>:8443",
    );
    assert.equal(
        maskHostInText("getaddrinfo ENOTFOUND relay.internal", "relay.internal"),
        "getaddrinfo ENOTFOUND <private-host>",
    );
    assert.equal(
        maskHostInText("connect ECONNREFUSED api.openai.com:443", "api.openai.com"),
        "connect ECONNREFUSED api.openai.com:443",
    );
    assert.equal(
        maskHostInText("proxy connect ECONNREFUSED 10.1.2.3:3128", "192.168.1.50"),
        "proxy connect ECONNREFUSED 10.1.2.3:3128",
    );
    assert.equal(
        maskHostInText("connect ECONNREFUSED [::1]:8443", "[::1]"),
        "connect ECONNREFUSED <private-host>:8443",
    );
    assert.equal(
        maskHostInText("connect ECONNREFUSED ::1:8443", "::1"),
        "connect ECONNREFUSED <private-host>:8443",
    );
    assert.equal(maskHostInText("no host here", "192.168.1.50"), "no host here");
    assert.equal(maskHostInText("connect ECONNREFUSED 192.168.1.50:8443", ""), "connect ECONNREFUSED 192.168.1.50:8443");
});

test("host masking default ON (#255) and setMaskHostsEnabled(false) opt-out (#897)", () => {
    assert.ok(isMaskHostsEnabled(), "host masking must be ON by default");
    assert.equal(maskHostForLog("relay.internal"), "<private-host>", "default masks non-public hosts");
    setMaskHostsEnabled(false);
    try {
        assert.equal(maskHostForLog("relay.internal"), "relay.internal");
        assert.equal(maskHostPortForLog("relay.internal:8443"), "relay.internal:8443");
        assert.equal(maskUrlForLog("https://relay.internal/v1/chat/completions"), "https://relay.internal/v1/chat/completions");
        assert.equal(maskUrlsInText("forward POST → http://192.168.1.50:11434/v1/messages"), "forward POST → http://192.168.1.50:11434/v1/messages");
        assert.equal(maskHeaderForLog("host", "relay.internal"), "relay.internal");
        assert.equal(maskHostInText("connect ECONNREFUSED 192.168.1.50:8443", "192.168.1.50"), "connect ECONNREFUSED 192.168.1.50:8443");
        // Public hosts are verbatim either way; credential masking is a separate
        // concern and stays ON while host masking is off.
        assert.equal(maskHostForLog("api.openai.com"), "api.openai.com");
        assert.equal(maskHeaderForLog("authorization", "Bearer sk-test-secret"), "<masked 21 chars>");
    } finally {
        setMaskHostsEnabled(true);
    }
    assert.equal(maskHostForLog("relay.internal"), "<private-host>", "restored to masked after opt-out test");
});

test("formatUpstreamError: non-public url and endpoint identity masked", () => {
    const s = formatUpstreamError(new Error("connect ECONNREFUSED 192.168.1.50:8443"), "http://192.168.1.50:8443/v1/chat/completions");
    assert.ok(s.includes("url=http://<private-host>:8443/v1/chat/completions"), s);
    assert.ok(!s.includes("192.168.1.50"), s);
    const dns = formatUpstreamError(new Error("getaddrinfo ENOTFOUND relay.internal"), "https://relay.internal/v1/messages");
    assert.ok(dns.includes("ENOTFOUND <private-host>"), dns);
    assert.ok(!dns.includes("relay.internal"), dns);
});

test("formatUpstreamError: public url kept verbatim", () => {
    const s = formatUpstreamError(new Error("boom"), "https://api.openai.com/v1/chat/completions");
    assert.ok(s.includes("url=https://api.openai.com/v1/chat/completions"), s);
});

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface Captured {
    level: string;
    msg: string;
}

test("proxy debug logs: no credentials, no non-public host in ANY log line (#255)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-log-mask-"));
    const prev = {
        xdgState: process.env.XDG_STATE_HOME,
        rawDump: process.env.ACP_RAW_DUMP_DIR,
        dumpReq: process.env.ACP_DUMP_REQ,
    };
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.ACP_RAW_DUMP_DIR = path.join(tmpRoot, "raw");
    process.env.ACP_DUMP_REQ = "0";
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "session=secret-cookie-value" });
        res.end(JSON.stringify({ id: "r1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    });
    let proxy: http.Server | undefined;
    try {
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
            log: true,
            debug: true,
            passthrough: false,
            autoUpdate: false,
            mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-acp-session": "log-mask-1",
                authorization: "Bearer sk-test-secret-1234567890",
                "x-api-key": "sk-test-key-abcdefgh",
            },
            body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        const all = captured.map((c) => c.msg).join("\n");
        assert.ok(!all.includes("sk-test-secret-1234567890"), `bearer token leaked into logs:\n${all}`);
        assert.ok(!all.includes("sk-test-key-abcdefgh"), `x-api-key leaked into logs:\n${all}`);
        assert.ok(!all.includes("secret-cookie-value"), `cookie value leaked into logs:\n${all}`);
        assert.ok(!all.includes(`127.0.0.1:${upstreamPort}`), `non-public upstream origin leaked into logs:\n${all}`);

        const fwd = captured.find((c) => c.msg.startsWith("forward POST"));
        assert.ok(fwd, `forward log missing:\n${all}`);
        assert.ok(fwd.msg.includes("http://<private-host>"), fwd.msg);

        const hdr = captured.find((c) => c.msg.includes("→ upstream headers:"));
        assert.ok(hdr, `upstream headers log missing:\n${all}`);
        assert.ok(hdr.msg.includes('"authorization":"<masked'), hdr.msg);
        assert.ok(hdr.msg.includes('"x-api-key":"<masked'), hdr.msg);
        assert.ok(hdr.msg.includes('"host":"' + "<private-host>"), hdr.msg);

        const respHdr = captured.find((c) => c.msg.includes("← upstream response headers:"));
        assert.ok(respHdr, `response headers log missing:\n${all}`);
        assert.ok(respHdr.msg.includes('"set-cookie":"<masked'), respHdr.msg);
    } finally {
        setLogCapture(null);
        if (prev.xdgState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prev.xdgState;
        if (prev.rawDump === undefined) delete process.env.ACP_RAW_DUMP_DIR;
        else process.env.ACP_RAW_DUMP_DIR = prev.rawDump;
        if (prev.dumpReq === undefined) delete process.env.ACP_DUMP_REQ;
        else process.env.ACP_DUMP_REQ = prev.dumpReq;
        await close(proxy!);
        await close(upstream);
        rmrf(tmpRoot);
    }
});

test("proxy error log: connection failure to non-public upstream leaks nothing (#255)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-log-mask-err-"));
    const prev = { xdgState: process.env.XDG_STATE_HOME };
    process.env.XDG_STATE_HOME = tmpRoot;
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    let proxy: http.Server | undefined;
    try {
        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: {
                "http://127.0.0.1:59999": { models: { "gpt-test": { context: 400_000 } } },
            },
            modelContextLimit: 400_000,
            kernelConfig: defaultConfig(400_000),
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: true,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:59999/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "log-mask-err" },
            body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(resp.status, 502);
        await resp.text();
        const all = captured.map((c) => c.msg).join("\n");
        assert.ok(!all.includes("127.0.0.1:59999"), `non-public upstream origin leaked into error log:\n${all}`);
        const errLine = captured.find((c) => c.msg.includes("upstream request failed"));
        assert.ok(errLine, `error log missing:\n${all}`);
        assert.ok(errLine.msg.includes("<private-host>"), errLine.msg);
    } finally {
        setLogCapture(null);
        if (prev.xdgState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prev.xdgState;
        await close(proxy!);
        rmrf(tmpRoot);
    }
});

test("mitm CONNECT tunnel failure: err.message host scrubbed from log (#255)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-log-mask-mitm-"));
    const prev = { xdgState: process.env.XDG_STATE_HOME, dataHome: process.env.XDG_DATA_HOME };
    process.env.XDG_STATE_HOME = tmpRoot;
    // MITM-enabled startup calls ensureRootCA(); isolate the CA dir so parallel
    // test files can't race on the shared real-profile dir on Windows.
    process.env.XDG_DATA_HOME = path.join(tmpRoot, "data");
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    let proxy: http.Server | undefined;
    try {
        const holder = http.createServer();
        holder.listen(0, "127.0.0.1");
        await once(holder, "listening");
        const deadPort = (holder.address() as { port: number }).port;
        await close(holder);
        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: {
                "http://127.0.0.1:1": { models: { "gpt-test": { context: 400_000 } } },
            },
            modelContextLimit: 400_000,
            kernelConfig: defaultConfig(400_000),
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: true,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            mitm: { enabled: true, domains: [] },
        };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        // #1689: prove the freed port is actually dead right before the tunnel
        // attempt — a squatter would turn the expected refusal into a 200.
        await assertPortDead(deadPort);
        const sock = net.connect(proxyPort, "127.0.0.1");
        let buf = "";
        await new Promise<void>((resolve, reject) => {
            sock.on("data", (d) => { buf += d.toString(); if (buf.includes("\r\n\r\n")) resolve(); });
            sock.on("error", reject);
            sock.write(`CONNECT 127.0.0.1:${deadPort} HTTP/1.1\r\nHost: 127.0.0.1:${deadPort}\r\n\r\n`);
        });
        sock.destroy();
        assert.ok(buf.startsWith("HTTP/1.1 502"), buf);
        const all = captured.map((c) => c.msg).join("\n");
        const tunnelLine = captured.find((c) => c.msg.includes("connect failed"));
        assert.ok(tunnelLine, `tunnel failure log missing:\n${all}`);
        assert.ok(tunnelLine.msg.includes(`<private-host>:${deadPort}`), tunnelLine.msg);
        assert.ok(!all.includes(`127.0.0.1:${deadPort}`), `raw tunnel target leaked into logs via err.message:\n${all}`);
    } finally {
        setLogCapture(null);
        if (prev.xdgState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prev.xdgState;
        if (prev.dataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prev.dataHome;
        await close(proxy!);
        rmrf(tmpRoot);
    }
});

test("ws upgrade rejection: host header scrubbed from log (#255)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-log-mask-ws-"));
    const prev = { xdgState: process.env.XDG_STATE_HOME };
    process.env.XDG_STATE_HOME = tmpRoot;
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    let proxy: http.Server | undefined;
    try {
        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: {
                "http://127.0.0.1:59999": { models: { "gpt-test": { context: 400_000 } } },
            },
            modelContextLimit: 400_000,
            kernelConfig: defaultConfig(400_000),
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: true,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;

        const sock = net.connect(proxyPort, "127.0.0.1");
        sock.write(
            "GET /v1/messages HTTP/1.1\r\n" +
                "Host: relay.internal:443\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
                "Sec-WebSocket-Version: 13\r\n\r\n",
        );
        const raw = await once(sock, "data");
        const head = String(raw[0]).split("\r\n")[0];
        assert.ok(head.includes("426"), `expected 426, got: ${head}`);

        const all = captured.map((c) => c.msg).join("\n");
        assert.ok(!all.includes("relay.internal"), `ws host header leaked into log:\n${all}`);
        const wsLine = captured.find((c) => c.msg.includes("[ws] rejected"));
        assert.ok(wsLine, `ws rejection log missing:\n${all}`);
        assert.ok(wsLine.msg.includes("<private-host>"), wsLine.msg);
        sock.destroy();
    } finally {
        setLogCapture(null);
        if (prev.xdgState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prev.xdgState;
        await close(proxy!);
        rmrf(tmpRoot);
    }
});

test("redactSecretsInText: scrubs credential-shaped tokens from free-form text (#1718)", () => {
    assert.equal(
        redactSecretsInText("Authorization: Bearer sk-ant-api03-abc123xyz"),
        "Authorization: Bearer <masked 22 chars>",
    );
    assert.equal(
        redactSecretsInText("proxy auth failed: Basic dXNlcm5hbWU6cGFzc3dvcmQ="),
        "proxy auth failed: Basic <masked 24 chars>",
    );
    assert.equal(redactSecretsInText("invalid api key sk-proj-AbCdEfGhIjKlMn12"), "invalid api key <masked key>");
    assert.equal(redactSecretsInText("xai-abcdefghijklmnop rejected"), "<masked key> rejected");
    assert.equal(
        redactSecretsInText('{"error":{"message":"bad credentials","api_key":"sk-secret-value-12"}}'),
        '{"error":{"message":"bad credentials","api_key":"<masked key>"}}',
    );
    assert.equal(redactSecretsInText("GET /v1?api_key=abcd1234efgh5678"), "GET /v1?api_key=<masked 16 chars>");
    assert.equal(
        redactSecretsInText("token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N"),
        "token: <masked jwt>",
    );
    const negatives = [
        "task-abcdefghi",
        "prompt_tokens=1234 completion_tokens=5678",
        "the token was expired yesterday",
        "tokens: 1234",
        "token=abc",
        "x-request-id=req-abcdefghij",
        "",
    ];
    for (const s of negatives) assert.equal(redactSecretsInText(s), s, `must stay verbatim: ${s}`);
});

test("maskIpsInText: non-loopback IP literals scrubbed from free-form text (#1718)", () => {
    assert.equal(maskIpsInText("connect ETIMEDOUT 203.0.113.5:8443"), "connect ETIMEDOUT <private-host>:8443");
    assert.equal(maskIpsInText("upstream refused 192.168.1.50:443 after 3 retries"), "upstream refused <private-host>:443 after 3 retries");
    assert.equal(maskIpsInText("peer 2001:db8:0:0:0:0:2:1 seen"), "peer <private-host> seen");
    assert.equal(maskIpsInText("connect ECONNREFUSED [2001:db8::1]:8443"), "connect ECONNREFUSED [<private-host>]:8443");
    const negatives = [
        "local proxy http://127.0.0.1:8787 ok",
        "loopback ::1 and [::1]:8080 stay",
        "bind 0.0.0.0:8787",
        "build 10.0.19045.3209 unchanged",
        "time 12:34:56 unchanged",
        "mac aa:bb:cc:dd:ee:ff unchanged",
        "999.1.1.1 bad octet unchanged",
        "",
    ];
    for (const s of negatives) assert.equal(maskIpsInText(s), s, `must stay verbatim: ${s}`);
    setMaskHostsEnabled(false);
    try {
        assert.equal(maskIpsInText("203.0.113.5:8443"), "203.0.113.5:8443", "BILI_LOG_MASK_HOSTS=0 opt-out must keep real IPs");
    } finally {
        setMaskHostsEnabled(true);
    }
});

test("logger sink: file lines scrubbed, capture hook stays raw (#1718)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-log-sink-"));
    const file = path.join(tmpRoot, "sink.log");
    const captured: string[] = [];
    setLogCapture((_level, msg) => captured.push(msg));
    try {
        configureLogger(file);
        const secret = "sk-test-leak-1234567890";
        loggerLog("warn", `upstream 401 body: {"error":{"code":"invalid_api_key","api_key":"${secret}"}}`);
        await closeLogger();
        const onDisk = fs.readFileSync(file, "utf8");
        assert.ok(!onDisk.includes(secret), `secret leaked into log file:\n${onDisk}`);
        assert.ok(onDisk.includes("<masked"), onDisk);
        assert.ok(captured[0]?.includes(secret), "capture hook must receive the raw message (in-process seam)");
    } finally {
        configureLogger(undefined);
        setLogCapture(null);
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});
