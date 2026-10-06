import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";

// #2272 wiring regression. tests/codex-compact.test.ts covers the pure decision
// function; these pin the forward() WIRING on the official ChatGPT Codex path —
// the branch NO hermetic lane can reach, because every other lane resolves its
// upstream to loopback and isChatGptCodexUpstream is false there. The stubbed
// transport answers only chatgpt.com / api.openai.com URLs; the client's own
// requests to the local proxy bypass it.

const CODEX_UA = "codex_cli_rs/0.1.0 (linux x86_64)";
const CHATGPT_UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_UPSTREAM = "https://api.openai.com/v1/responses";

type UpstreamCall = { url: string; body: string };
type Harness = { post: (opts: { ua?: string; sessionId: string; url?: string }) => Promise<Response>; calls: UpstreamCall[] };

function jsonUpstream(status: number, extraHeaders: Record<string, string> = {}): Response {
    return new Response(JSON.stringify({
        id: "resp_test",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
    }), { status, headers: { "content-type": "application/json", ...extraHeaders } });
}

async function withHarness(fn: (h: Harness) => Promise<void>, upstream: (url: string, body: string) => Response = () => jsonUpstream(200)): Promise<void> {
    const previousFetch = globalThis.fetch;
    const clientFetch = previousFetch.bind(globalThis);
    const calls: UpstreamCall[] = [];
    let proxyPort = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith(`http://127.0.0.1:${proxyPort}`)) return clientFetch(input as string, init);
        if (url.includes("chatgpt.com") || url.includes("api.openai.com")) {
            const body = String(init?.body ?? "");
            calls.push({ url, body });
            return upstream(url, body);
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
        _setStoreForTest(new SessionStore({ enabled: false }));
        _resetSessionsForTest();
        setRegistryForTest({});
        const proxy = await startServer({
            port: 0,
            host: "127.0.0.1",
            upstream: CHATGPT_UPSTREAM,
            routes: {},
            modelContextLimit: 200_000,
            kernelConfig: defaultConfig(200_000),
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: false,
            debug: false,
            passthrough: false,
            passthroughSource: null,
            autoUpdate: false,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            advisoryCheck: false,
            releaseNotesCheck: false,
            compat: { roles: {} },
            streamErrorShape: "protocol",
            mitm: { enabled: false, domains: [] },
        } as ProxyOptions);
        await once(proxy, "listening");
        proxyPort = (proxy.address() as { port: number }).port;
        const h: Harness = {
            calls,
            post: ({ ua, sessionId, url = CHATGPT_UPSTREAM }) => clientFetch(`http://127.0.0.1:${proxyPort}/bili/${url}`, {
                method: "POST",
                headers: { "content-type": "application/json", ...(ua ? { "user-agent": ua } : {}) },
                body: JSON.stringify({
                    model: "gpt-5",
                    stream: false,
                    session_id: sessionId,
                    input: [{ type: "message", role: "user", content: "hello wiring test" }],
                }),
            }),
        };
        try {
            await fn(h);
        } finally {
            proxy.close();
            await once(proxy, "close");
        }
    } finally {
        globalThis.fetch = previousFetch;
    }
}

test("#2272 wiring: codex + chatgpt.com + responses + processed turn + success → client sees x-reasoning-included: 1", async () => {
    await withHarness(async (h) => {
        const r = await h.post({ ua: CODEX_UA, sessionId: "wiring-positive" });
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(r.headers.get("x-reasoning-included"), "1", "synthesized header reaches the client");
        assert.equal(h.calls.length, 1, "exactly one upstream request");
        assert.ok(h.calls[0]!.url.startsWith(CHATGPT_UPSTREAM), "upstream is the official ChatGPT endpoint");
        const sent = JSON.parse(h.calls[0]!.body) as { input: Array<{ type: string }> };
        assert.ok(sent.input.some((item) => item.type === "message"), "kernel-processed turn reached upstream");
    });
});

test("#2272 wiring: non-codex client on the same endpoint → no synthesized header", async () => {
    await withHarness(async (h) => {
        const r = await h.post({ ua: "curl/8.5.0", sessionId: "wiring-noncodex" });
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(r.headers.get("x-reasoning-included"), null, "third-party clients are untouched");
    });
});

test("#2272 wiring: codex against a third-party Responses provider → no synthesized header", async () => {
    await withHarness(async (h) => {
        const r = await h.post({ ua: CODEX_UA, sessionId: "wiring-openai", url: OPENAI_UPSTREAM });
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(r.headers.get("x-reasoning-included"), null, "only the official ChatGPT path synthesizes");
    });
});

test("#2272 wiring: upstream error → no synthesized header, status passes through", async () => {
    await withHarness(async (h) => {
        const r = await h.post({ ua: CODEX_UA, sessionId: "wiring-error" });
        assert.equal(r.status, 500);
        await r.text();
        assert.equal(r.headers.get("x-reasoning-included"), null, "failed responses never claim accounting authority");
    }, () => jsonUpstream(500));
});

test("#2272 wiring: upstream-supplied x-reasoning-included is preserved verbatim", async () => {
    await withHarness(async (h) => {
        const r = await h.post({ ua: CODEX_UA, sessionId: "wiring-preserve" });
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(r.headers.get("x-reasoning-included"), "true", "upstream value wins over synthesis");
    }, () => jsonUpstream(200, { "x-reasoning-included": "true" }));
});
