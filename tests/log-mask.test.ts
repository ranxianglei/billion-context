import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { formatUpstreamError } from "../src/upstream-proxy.ts";
import {
    isPublicApiHost,
    maskHeaderForLog,
    maskHeadersForLog,
    maskHostForLog,
    maskHostPortForLog,
    maskUrlForLog,
    maskUrlsInText,
} from "../src/log-mask.ts";

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
        fs.rmSync(tmpRoot, { recursive: true, force: true });
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
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});
