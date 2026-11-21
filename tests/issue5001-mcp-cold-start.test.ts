// #5001: the MCP shim's tools/list gave up on a cold-starting claude-lane proxy.
// The SessionStart hook spawns the proxy in a SEPARATE child; Claude Code fires
// tools/list before the port is listening, the old single-shot fetchManifest threw
// on attempt one, the shim answered -32003, and Claude Code's ~250/500/1000ms retry
// budget ran out well before the proxy finished booting (measured 2.3–3.6s) — the
// bili tools were lost for the whole process. The fix makes ensureManifest poll
// until the proxy answers, bounded so a dead proxy still errors instead of hanging.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { ensureManifest, _resetMcpManifestForTest } from "../src/mcp.ts";

const MANIFEST_BODY = {
    tools: {
        anthropic: [
            { name: "compress", description: "fold context", input_schema: { type: "object" } },
            { name: "decompress", description: "restore a block", input_schema: { type: "object" } },
        ],
    },
};

function okManifest(): Response {
    return new Response(JSON.stringify(MANIFEST_BODY), { status: 200, headers: { "content-type": "application/json" } });
}

describe("#5001: MCP shim waits for a cold-starting proxy before tools/list", () => {
    let restoreFetch: (() => void) | undefined;
    const prevPin = process.env.BILI_MCP_PROXY;

    // A fixed pin keeps resolveProxyOrigin() deterministic (short-circuits before
    // touching the instance file); the mocked fetch ignores the URL anyway.
    beforeEach(() => {
        process.env.BILI_MCP_PROXY = "http://127.0.0.1:9";
        // Tiny poll cadence keeps the recovery cases sub-millisecond; the bounded
        // case below overrides both knobs explicitly.
        _resetMcpManifestForTest({ retryIntervalMs: 5 });
    });
    afterEach(() => {
        restoreFetch?.();
        restoreFetch = undefined;
        if (prevPin === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevPin;
        _resetMcpManifestForTest();
    });

    function useMockFetch(impl: (calls: number) => Response | Promise<Response>): () => number {
        let n = 0;
        const prev = globalThis.fetch;
        globalThis.fetch = (async () => { n += 1; return impl(n); }) as typeof fetch;
        restoreFetch = () => { globalThis.fetch = prev; };
        return () => n;
    }

    it("cold start: refuses until the proxy comes up, then serves the manifest", async () => {
        // Three refused connections (a cold proxy not yet listening), then ready.
        const calls = useMockFetch((n) => (n <= 3 ? Promise.reject(new Error("fetch failed")) : okManifest()));
        await ensureManifest();
        assert.equal(calls(), 4, "three refused attempts, then the fourth succeeds");
    });

    it("warm proxy: answers on the first attempt with no extra retries", async () => {
        const calls = useMockFetch(() => okManifest());
        await ensureManifest();
        assert.equal(calls(), 1, "a ready proxy must not be re-polled");
    });

    it("non-ok status (503) is retried, not treated as final", async () => {
        const calls = useMockFetch((n) => (n < 2 ? new Response("still starting", { status: 503 }) : okManifest()));
        await ensureManifest();
        assert.equal(calls(), 2);
    });

    it("dead proxy: the wait is bounded — it rejects instead of hanging", async () => {
        _resetMcpManifestForTest({ waitMaxMs: 400, retryIntervalMs: 20 });
        const calls = useMockFetch(() => Promise.reject(new Error("fetch failed")));
        const started = Date.now();
        await assert.rejects(() => ensureManifest());
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 5000, `bounded wait must reject well under the guard, took ${elapsed}ms`);
        assert.ok(calls() >= 2, "more than one attempt proves the retry loop actually ran");
    });
});
