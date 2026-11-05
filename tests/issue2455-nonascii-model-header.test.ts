// #2455 regression: a non-ASCII (e.g. Chinese) model id must NEVER reach the
// x-bili-plugin-model HTTP header. Header values are ByteStrings — a char above
// U+00FF makes undici throw "Cannot convert argument to a ByteString..." when
// the host BUILDS the request, so the whole turn dies locally before it ever
// reaches the proxy (bili.log stays silent, usage all-zero). The guard
// (asciiHeaderValue) skips such headers; the proxy then falls back to the body
// model / registry table with no side effect (a missing header is explicitly
// trusted by pluginHeadersMatchModel).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { asciiHeaderValue } from "../src/agent/shared.ts";
import { createOpencodeV2Setup } from "../src/agent/opencode-v2.ts";

const CJK_MODEL = "浮生云算/gpt-6.1-sol"; // the exact id from #2455's repro (首字符 浮 = U+6D6E)

// Hermetic sink: answers every /__bili/ management POST ok so the plugin's
// fire-and-forget runtime-info report settles cleanly (no refused-connection).
function startSinkProxy(): Promise<{ origin: string; close: () => Promise<void> }> {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => ({
        origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
    }));
}

// Minimal opencode-v2 host seam: capture the http.request hook and expose the
// same per-request header store the real lane stamps into.
function makeFakeCtx() {
    let modelRequestCb: ((e: Record<string, unknown>) => void | Promise<void>) | undefined;
    const ctx = {
        session: {
            hook: async (name: string, cb: (e: Record<string, unknown>) => void | Promise<void>) => {
                if (name === "http.request") modelRequestCb = cb;
                else assert.fail(`unexpected hook ${name}`);
                return { dispose: () => {} };
            },
        },
        catalog: {
            model: { list: async () => ({ data: [{ providerID: "qwen", id: "m1", limit: { context: 262144 } }] }) },
        },
    };
    const fireModelRequest = async (opts: { sessionID?: unknown; baseURL?: unknown; model?: unknown }): Promise<{ headers: Record<string, string> }> => {
        const store: Record<string, string> = {};
        await modelRequestCb!({
            sessionID: opts.sessionID,
            model: opts.model,
            request: { url: opts.baseURL, headers: { set: (k: string, v: string) => { store[k] = v; } } },
        });
        return { headers: store };
    };
    return { ctx, fireModelRequest };
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
        saved.set(k, process.env[k]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        await fn();
    } finally {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test("#2455 asciiHeaderValue: printable-ASCII model ids pass through verbatim", () => {
    assert.equal(asciiHeaderValue("gpt-6.1-sol"), "gpt-6.1-sol");
    assert.equal(asciiHeaderValue("deepseek-v4.1-flash"), "deepseek-v4.1-flash");
    assert.equal(asciiHeaderValue("provider/model"), "provider/model");
    assert.equal(asciiHeaderValue("qwen3.5-33b-a"), "qwen3.5-33b-a");
});

test("#2455 asciiHeaderValue: rejects the exact Chinese repro and other unsafe shapes", () => {
    assert.equal(asciiHeaderValue(CJK_MODEL), undefined, "Chinese provider/model id must be rejected");
    assert.equal(asciiHeaderValue(""), undefined, "empty is not stampable");
    assert.equal(asciiHeaderValue("a b"), undefined, "whitespace (proxy \\S gate would reject anyway)");
    assert.equal(asciiHeaderValue("a\nb"), undefined, "control char");
    assert.equal(asciiHeaderValue("a".repeat(256)), "a".repeat(256), "256-char boundary passes");
    assert.equal(asciiHeaderValue("a".repeat(257)), undefined, "over the proxy's 256 cap");
});

test("#2455 mechanism: a stamped header map never carries a non-ASCII value into undici", () => {
    // The exact failure point from the issue's minimal repro: handing the stamped
    // map to the WHATWG Headers constructor — where undici threw on the raw CJK
    // value before the guard. Reverting any call site to a raw assignment makes
    // the production-lane test below throw here too.
    const stamp = (modelId: string | undefined): Record<string, string> => {
        const headers: Record<string, string> = {};
        if (typeof modelId === "string" && modelId.length > 0) {
            const modelHeader = asciiHeaderValue(modelId);
            if (modelHeader !== undefined) headers["x-bili-plugin-model"] = modelHeader;
        }
        return headers;
    };
    const cjk = stamp(CJK_MODEL);
    assert.equal(cjk["x-bili-plugin-model"], undefined, "CJK id must not be stamped");
    assert.equal(new Headers(cjk).get("x-bili-plugin-model"), null, "constructor must not throw on the guarded map");

    const ascii = stamp("gpt-6.1-sol");
    assert.equal(new Headers(ascii).get("x-bili-plugin-model"), "gpt-6.1-sol", "ASCII id still stamps verbatim");
});

test("#2455 opencode-v2 lane: non-ASCII model id skips the header, ASCII still stamps (real stampHeaders path)", async () => {
    const sink = await startSinkProxy();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: sink.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await createOpencodeV2Setup({})(fake.ctx as never);
            try {
                const rCjk = await fake.fireModelRequest({
                    sessionID: "ses_2455_cjk",
                    baseURL: "http://upstream.example/v1",
                    model: { providerID: "cloud", id: "浮生云算-gpt-6.1-sol" },
                });
                assert.equal(rCjk.headers["x-bili-plugin"], "opencode", "plugin marker still stamped");
                assert.equal(rCjk.headers["x-bili-plugin-conversation"], "ses_2455_cjk", "conversation id unaffected");
                assert.equal(rCjk.headers["x-bili-plugin-model"], undefined, "non-ASCII model header skipped");
                // The exact point where undici threw before #2455:
                assert.equal(new Headers(rCjk.headers).get("x-bili-plugin-model"), null, "real stamped map must not throw");

                const rAscii = await fake.fireModelRequest({
                    sessionID: "ses_2455_ascii",
                    baseURL: "http://upstream.example/v1",
                    model: { providerID: "cloud", id: "gpt-6.1-sol" },
                });
                assert.equal(rAscii.headers["x-bili-plugin-model"], "gpt-6.1-sol", "ASCII id still stamped");
                assert.equal(new Headers(rAscii.headers).get("x-bili-plugin-model"), "gpt-6.1-sol");
            } finally {
                cleanup();
            }
        });
    } finally {
        await sink.close();
    }
});
